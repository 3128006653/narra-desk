// FS helper 的路径 jail —— `src/deploy/fsJail.ts` 的 Go 移植。
//
// 两条最容易踩的坑（与 TS 版逐条对应）：
//
//  1. **canonicalize 的顺序**：先 resolve jail 根，再 resolve 用户路径，
//     然后用两个真实路径做前缀匹配。拿未 resolve 的根去匹配，根自身是符号链接时 jail 会失效。
//  2. **跨平台大小写**：Windows 不敏感，posix 敏感；前缀匹配前必须归一化。
//
// 拒绝一律由调用方转 404 —— 不回 403，403 会暴露路由存在性。
package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"golang.org/x/text/unicode/norm"
)

// defaultAllowedExtensions：工作区只放这些 UTF-8 文本资产。
var defaultAllowedExtensions = []string{".json", ".md", ".txt", ".yaml", ".yml"}

type jailReject string

const (
	rejectEscape    jailReject = "escape"
	rejectSymlink   jailReject = "symlink"
	rejectExtension jailReject = "extension"
	rejectDisabled  jailReject = "disabled"
	rejectEmpty     jailReject = "empty"
)

type jailResult struct {
	OK       bool
	Reason   jailReject
	RealPath string
	// Annotated 是折叠后的相对/绝对目标（用于测试与诊断）
	Target string
}

type jailResolver interface {
	RealPath(string) (string, bool)
	Exists(string) bool
	IsSymlink(string) bool
}

type jailOptions struct {
	// Root 为空 = FS helper 未启用（默认关闭）
	Root        string
	Platform    string
	Resolver    jailResolver
	AllowedExts []string
}

func platformForHost() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return "posix"
}

// caseInsensitivePlatforms：Windows 归一化大小写；macOS 由文件系统处理，posix 保持敏感。
var caseInsensitivePlatforms = map[string]bool{"win32": true}

func caseFoldFor(platform, s string) string {
	if caseInsensitivePlatforms[platform] {
		return strings.ToLower(s)
	}
	return s
}

func trimTrailingSeps(s string) string {
	return strings.TrimRight(s, `/\`)
}

// isWithin：child 在 root 之内（含 root 自身），要求分隔符边界。
func isWithin(root, child, platform string) bool {
	r := caseFoldFor(platform, trimTrailingSeps(root))
	c := caseFoldFor(platform, child)
	if c == r {
		return true
	}
	return strings.HasPrefix(c, r+sepFor(platform))
}

// hasSepBoundary：`/workspace-evil` 不能以 `/workspace` 为前缀通过。
func hasSepBoundary(root, child, platform string) bool {
	r := caseFoldFor(platform, trimTrailingSeps(root))
	c := caseFoldFor(platform, child)
	if !strings.HasPrefix(c, r) {
		return false
	}
	rest := c[len(r):]
	if rest == "" {
		return true
	}
	if platform == "win32" {
		return rest[0] == '\\' || rest[0] == '/'
	}
	return rest[0] == '/'
}

func extOf(p string) string {
	base := p
	if i := strings.LastIndexAny(base, `/\`); i >= 0 {
		base = base[i+1:]
	}
	i := strings.LastIndexByte(base, '.')
	if i <= 0 {
		return ""
	}
	return strings.ToLower(base[i:])
}

// resolveWithin 把用户提供的相对路径解析到 jail 内的真实路径。
func resolveWithin(userPath string, opt jailOptions) jailResult {
	if opt.Root == "" {
		return jailResult{Reason: rejectDisabled}
	}
	if strings.TrimSpace(userPath) == "" {
		return jailResult{Reason: rejectEmpty}
	}

	platform := opt.Platform
	if platform == "" {
		platform = platformForHost()
	}
	allowed := opt.AllowedExts
	if allowed == nil {
		allowed = defaultAllowedExtensions
	}

	nRoot := norm.NFC.String(opt.Root)
	nUser := norm.NFC.String(userPath)

	// 坑 1 的一半：先 resolve jail 根 —— 它本身可能是符号链接
	realRoot, ok := opt.Resolver.RealPath(nRoot)
	if !ok {
		return jailResult{Reason: rejectEscape}
	}

	// 绝对路径一律拒绝：盘符与 UNC 都不是「工作区内的相对位置」
	if isAbsFor(platform, nUser) {
		return jailResult{Reason: rejectEscape}
	}

	joined := joinFor(platform, nRoot, nUser)
	collapsed := cleanFor(platform, joined)

	// 符号链接：无论目标是否在 jail 内一律拒绝。
	// 判定必须在 exists 之前 —— 链接可能指向不存在的位置。
	if opt.Resolver.IsSymlink(collapsed) {
		return jailResult{Reason: rejectSymlink}
	}

	// 坑 1 的另一半：再 resolve 用户路径
	target := collapsed
	if real, ok := opt.Resolver.RealPath(collapsed); ok {
		target = real
	}

	if !hasSepBoundary(realRoot, target, platform) {
		return jailResult{Reason: rejectEscape}
	}

	ext := extOf(target)
	matched := false
	for _, e := range allowed {
		if strings.EqualFold(e, ext) {
			matched = true
			break
		}
	}
	if !matched {
		return jailResult{Reason: rejectExtension}
	}

	return jailResult{OK: true, RealPath: target, Target: target}
}

// ---------------------------------------------------------------- 真实文件系统 resolver

type osJailResolver struct{}

func (osJailResolver) RealPath(p string) (string, bool) {
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", false
	}
	return r, true
}

func (osJailResolver) Exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func (osJailResolver) IsSymlink(p string) bool {
	fi, err := os.Lstat(p)
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeSymlink != 0
}

// ---------------------------------------------------------------- 体积与频次

const (
	fsMaxFileBytes      = 100 * 1024 * 1024
	fsMaxWorkspaceBytes = 1024 * 1024 * 1024
	fsMaxWritesPerMin   = 120
)

// writeRateLimiter：滑动窗口。拒绝时**不记时间戳**，否则超限后窗口永远滑不出去。
type writeRateLimiter struct {
	mu         sync.Mutex
	timestamps []time.Time
	limit      int
}

func newWriteRateLimiter(limit int) *writeRateLimiter {
	return &writeRateLimiter{limit: limit}
}

func (l *writeRateLimiter) allow(now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	windowStart := now.Add(-time.Minute)
	recent := l.timestamps[:0]
	for _, t := range l.timestamps {
		if t.After(windowStart) {
			recent = append(recent, t)
		}
	}
	if len(recent) >= l.limit {
		l.timestamps = recent
		return false, recent[0].Add(time.Minute).Sub(now)
	}
	recent = append(recent, now)
	l.timestamps = recent
	return true, 0
}

// workspaceBytes 迭代求和，不跟随符号链接（深度攻击面由 fsJail 挡在入口）。
func workspaceBytes(root string) (int64, error) {
	var total int64
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // 单项不可读不阻断整体统计
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		total += info.Size()
		return nil
	})
	return total, err
}
