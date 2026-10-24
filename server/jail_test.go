package main

import (
	"sort"
	"strings"
	"testing"
	"time"
)

// memResolver 与 `tests/fsJail.test.ts` 的 memFs 行为对齐：
// 键按 `/` 归一化、逐级替换最长符号链接前缀、找不到文件返回 false。
type memResolver struct {
	files map[string]bool
	links map[string]string
	dirs  map[string]bool
}

func newMemFS(files []string, links map[string]string, dirs []string) *memResolver {
	m := &memResolver{files: map[string]bool{}, links: map[string]string{}, dirs: map[string]bool{}}
	for _, f := range files {
		m.files[normKey(f)] = true
	}
	for k, v := range links {
		m.links[normKey(k)] = normKey(v)
	}
	for _, d := range dirs {
		m.dirs[normKey(d)] = true
	}
	return m
}

func normKey(p string) string {
	p = strings.ReplaceAll(p, `\`, "/")
	for strings.Contains(p, "//") {
		p = strings.ReplaceAll(p, "//", "/")
	}
	return strings.TrimSuffix(p, "/")
}

func (m *memResolver) exists(p string) bool {
	k := normKey(p)
	return m.files[k] || m.dirs[k]
}

func (m *memResolver) Exists(p string) bool { return m.exists(p) }

func (m *memResolver) IsSymlink(p string) bool {
	_, ok := m.links[normKey(p)]
	return ok
}

func (m *memResolver) RealPath(p string) (string, bool) {
	cur := normKey(p)
	keys := make([]string, 0, len(m.links))
	for k := range m.links {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return len(keys[i]) > len(keys[j]) })
	for _, link := range keys {
		if cur == link || strings.HasPrefix(cur, link+"/") {
			cur = m.links[link] + strings.TrimPrefix(cur, link)
			break
		}
	}
	if m.exists(cur) {
		return cur, true
	}
	return "", false
}

type jailCase struct {
	name string
	run  func() jailResult
	want string // "ok" 或 rejectReason
}

func posixOpt(root string, r jailResolver) jailOptions {
	return jailOptions{Root: root, Platform: "posix", Resolver: r}
}

func winOpt(root string, r jailResolver) jailOptions {
	return jailOptions{Root: root, Platform: "win32", Resolver: r}
}

func jailCases() []jailCase {
	return []jailCase{
		{
			name: "jail 内的普通文件",
			run: func() jailResult {
				return resolveWithin("a/b.md", posixOpt("/ws", newMemFS(
					[]string{"/ws/a/b.md"}, nil, []string{"/ws", "/ws/a"})))
			},
			want: "ok",
		},
		{
			name: "jail 根自身（sep boundary 的相等分支）",
			run: func() jailResult {
				return resolveWithin(".", posixOpt("/ws", newMemFS(nil, nil, []string{"/ws"})))
			},
			want: "extension",
		},
		{
			name: "静态 `..` 逃逸（../../etc/passwd）",
			run: func() jailResult {
				return resolveWithin("../../etc/passwd.md", posixOpt("/ws", newMemFS(
					[]string{"/etc/passwd.md"}, nil, []string{"/ws", "/etc"})))
			},
			want: "escape",
		},
		{
			name: "符号链接指向 jail 外 → 拒绝 symlink（不看目标）",
			run: func() jailResult {
				return resolveWithin("link.md", posixOpt("/ws", newMemFS(
					[]string{"/etc/p.md"}, map[string]string{"/ws/link.md": "/etc/p.md"}, []string{"/ws", "/etc"})))
			},
			want: "symlink",
		},
		{
			name: "符号链接指向 jail 内也一律拒绝（不做目标判定）",
			run: func() jailResult {
				return resolveWithin("link.md", posixOpt("/ws", newMemFS(
					[]string{"/ws/real.md"}, map[string]string{"/ws/link.md": "/ws/real.md"}, []string{"/ws"})))
			},
			want: "symlink",
		},
		{
			name: "坑 1 顺序：jail 根自身是符号链接时 jail 仍生效",
			run: func() jailResult {
				return resolveWithin("a.md", posixOpt("/alias", newMemFS(
					[]string{"/real/a.md", "/real/outside.md"}, map[string]string{"/alias": "/real"}, []string{"/real", "/ws"})))
			},
			want: "ok",
		},
		{
			name: "坑 1 反面：jail 根是链接且目标外有同名目录，不能误放行",
			run: func() jailResult {
				return resolveWithin("../outside.md", posixOpt("/alias", newMemFS(
					[]string{"/outside.md"}, map[string]string{"/alias": "/real"}, []string{"/real"})))
			},
			want: "escape",
		},
		{
			name: "前缀相同但非子目录（/workspace-evil 不被 /workspace 放行）",
			run: func() jailResult {
				return resolveWithin("../workspace-evil/x.md", posixOpt("/workspace", newMemFS(
					[]string{"/workspace-evil/x.md"}, nil, []string{"/workspace", "/workspace-evil"})))
			},
			want: "escape",
		},
		{
			name: "扩展名不在白名单 → extension",
			run: func() jailResult {
				return resolveWithin("a.exe", posixOpt("/ws", newMemFS([]string{"/ws/a.exe"}, nil, []string{"/ws"})))
			},
			want: "extension",
		},
		{
			name: "扩展名大小写无关（.MD 视为 .md）",
			run: func() jailResult {
				return resolveWithin("a.MD", posixOpt("/ws", newMemFS([]string{"/ws/a.MD"}, nil, []string{"/ws"})))
			},
			want: "ok",
		},
		{
			name: "无扩展名 → 拒绝",
			run: func() jailResult {
				return resolveWithin("README", posixOpt("/ws", newMemFS([]string{"/ws/README"}, nil, []string{"/ws"})))
			},
			want: "extension",
		},
		{
			name: "点开头文件（.env）→ 无扩展名，拒绝",
			run: func() jailResult {
				return resolveWithin(".env", posixOpt("/ws", newMemFS([]string{"/ws/.env"}, nil, []string{"/ws"})))
			},
			want: "extension",
		},
		{
			name: "坑 2：Windows 大小写不敏感（C:\\\\WS vs c:\\\\ws 视为同一目录）",
			run: func() jailResult {
				return resolveWithin("a.md", winOpt(`C:\WS`, newMemFS([]string{"C:/WS/a.md"}, nil, []string{"C:/WS"})))
			},
			want: "ok",
		},
		{
			name: "坑 2：Windows 大小写不同的逃逸尝试仍被拦",
			run: func() jailResult {
				return resolveWithin(`..\..\outside.md`, winOpt(`C:\WS`, newMemFS([]string{"C:/outside.md"}, nil, []string{"C:/WS"})))
			},
			want: "escape",
		},
		{
			name: "posix 大小写敏感：不同大小写的路径不视为同一",
			run: func() jailResult {
				return resolveWithin("A.md", posixOpt("/ws", newMemFS([]string{"/ws/a.md"}, nil, []string{"/ws"})))
			},
			want: "ok",
		},
		{
			name: "Windows 绝对路径（C:\\\\other）不允许逃出",
			run: func() jailResult {
				return resolveWithin(`C:\other\x.md`, winOpt(`C:\WS`, newMemFS([]string{"C:/other/x.md"}, nil, []string{"C:/WS"})))
			},
			want: "escape",
		},
		{
			name: "UNC 路径（\\\\\\\\server\\\\share）被拒",
			run: func() jailResult {
				return resolveWithin(`\\server\share\x.md`, winOpt(`C:\WS`, newMemFS(nil, nil, []string{"C:/WS"})))
			},
			want: "escape",
		},
		{
			name: "Unicode NFC/NFD 归一：分解形式的 é 与合成形式视为同一",
			run: func() jailResult {
				return resolveWithin("cafe\u0301.md", posixOpt("/ws", newMemFS([]string{"/ws/café.md"}, nil, []string{"/ws"})))
			},
			want: "ok",
		},
		{
			name: "未绑定工作区（root 为空）→ disabled",
			run: func() jailResult {
				return resolveWithin("a.md", posixOpt("", newMemFS(nil, nil, nil)))
			},
			want: "disabled",
		},
		{
			name: "空路径 → empty",
			run: func() jailResult {
				return resolveWithin("   ", posixOpt("/ws", newMemFS(nil, nil, []string{"/ws"})))
			},
			want: "empty",
		},
	}
}

func TestJailVectors(t *testing.T) {
	for _, c := range jailCases() {
		c := c
		t.Run(c.name, func(t *testing.T) {
			got := c.run()
			if c.want == "ok" {
				if !got.OK {
					t.Fatalf("want ok, got reject %q", got.Reason)
				}
				return
			}
			if got.OK {
				t.Fatalf("want reject %q, got ok (%s)", c.want, got.RealPath)
			}
			if string(got.Reason) != c.want {
				t.Fatalf("want reject %q, got %q", c.want, got.Reason)
			}
		})
	}
}

func TestSepBoundary(t *testing.T) {
	if hasSepBoundary("/workspace", "/workspace-evil", "posix") {
		t.Error("/workspace-evil must not pass /workspace")
	}
	if !hasSepBoundary("/workspace", "/workspace/a", "posix") {
		t.Error("/workspace/a should pass")
	}
	if isWithin("/workspace", "/workspace-evil", "posix") {
		t.Error("isWithin must reject sibling prefix")
	}
	if !hasSepBoundary(`C:\WS`, `C:\WS\a`, "win32") {
		t.Error("windows backslash boundary should pass")
	}
	if hasSepBoundary(`C:\WS`, `C:\WS-2`, "win32") {
		t.Error("windows C:\\WS-2 must not pass")
	}
	if !hasSepBoundary(`C:\WS`, `C:\WS/a`, "win32") {
		t.Error("windows mixed separator boundary should pass")
	}
}

func TestWriteRateLimiter(t *testing.T) {
	l := newWriteRateLimiter(fsMaxWritesPerMin)
	base := int64(1_000_000)
	now := func(off int64) time.Time { return time.UnixMilli(base + off) }

	for i := int64(0); i < int64(fsMaxWritesPerMin); i++ {
		if ok, _ := l.allow(now(i)); !ok {
			t.Fatalf("write %d should pass", i)
		}
	}
	ok, retry := l.allow(now(int64(fsMaxWritesPerMin)))
	if ok || retry <= 0 {
		t.Fatalf("over-limit should reject with retryAfter, got ok=%v retry=%v", ok, retry)
	}
	// 窗口滑出后恢复
	if ok, _ := l.allow(now(61_000)); !ok {
		t.Fatal("write should pass after window slides")
	}
}
