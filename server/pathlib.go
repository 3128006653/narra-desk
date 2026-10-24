// 路径语义的可移植实现：posix 与 win32 各自独立，不依赖宿主 GOOS。
//
// 为什么不用 `path/filepath`：契约向量同时包含 posix 与 win32 场景，
// 在 Linux 上跑 `go test` 时 filepath 会把 win32 用例判错。这里只实现
// jail 需要的三个操作（IsAbs / Join / Clean），语义与 TS 的 `path/posix`、`path/win32` 对齐。
package main

import (
	"path"
	"strings"
)

// ---------------------------------------------------------------- posix

func posixIsAbs(p string) bool { return strings.HasPrefix(p, "/") }

func posixJoin(a, b string) string { return path.Join(a, b) }

func posixClean(p string) string { return path.Clean(p) }

// ---------------------------------------------------------------- win32

func toBackslash(p string) string { return strings.ReplaceAll(p, "/", `\`) }

func winIsAbs(p string) bool {
	p = toBackslash(p)
	if strings.HasPrefix(p, `\\`) { // UNC
		return true
	}
	return len(p) >= 3 && isDriveLetter(p[0]) && p[1] == ':' && p[2] == '\\'
}

func isDriveLetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// winClean 折叠 `.` / `..`，保留盘符与 UNC 前缀。
// 超出根的 `..` 被丢弃（Windows 上 `C:\a\..\..` = `C:\`，不会跑到别的卷）。
func winClean(p string) string {
	raw := toBackslash(p)

	// UNC：\\host\share\rest
	if strings.HasPrefix(raw, `\\`) {
		body := strings.TrimPrefix(raw, `\\`)
		parts := strings.Split(body, `\`)
		prefix := `\\`
		rest := []string{}
		if len(parts) > 0 && parts[0] != "" {
			prefix += parts[0]
			if len(parts) > 1 && parts[1] != "" {
				prefix += `\` + parts[1]
				rest = parts[2:]
			} else {
				rest = parts[1:]
			}
		}
		return prefix + `\` + cleanParts(rest, true)
	}

	prefix := ""
	rest := raw
	if len(raw) >= 2 && isDriveLetter(raw[0]) && raw[1] == ':' {
		prefix = raw[:2]
		rest = raw[2:]
	}
	absolute := strings.HasPrefix(rest, `\`)
	parts := strings.Split(rest, `\`)
	joined := cleanParts(parts, absolute)
	if prefix != "" {
		return prefix + `\` + joined
	}
	if absolute {
		return `\` + joined
	}
	return joined
}

// cleanParts 折叠相对段；absolute=true 时多余的 `..` 被丢弃而不是保留。
func cleanParts(parts []string, absolute bool) string {
	out := make([]string, 0, len(parts))
	for _, s := range parts {
		switch s {
		case "", ".":
			continue
		case "..":
			if len(out) > 0 {
				out = out[:len(out)-1]
			} else if !absolute {
				out = append(out, "..")
			}
			continue
		default:
			out = append(out, s)
		}
	}
	return strings.Join(out, `\`)
}

func winJoin(a, b string) string { return winClean(a + `\` + b) }

// ---------------------------------------------------------------- 平台分派

func isAbsFor(platform, p string) bool {
	if platform == "win32" {
		return winIsAbs(p)
	}
	return posixIsAbs(p)
}

func joinFor(platform, a, b string) string {
	if platform == "win32" {
		return winJoin(a, b)
	}
	return posixJoin(a, b)
}

func cleanFor(platform, p string) string {
	if platform == "win32" {
		return winClean(p)
	}
	return posixClean(p)
}

func sepFor(platform string) string {
	if platform == "win32" {
		return `\`
	}
	return "/"
}
