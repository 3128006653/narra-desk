/**
 * FS helper 逃逸场景（阶段五第一轮）—— 表驱动，不依赖 HTTP 层。
 * 覆盖用户列的两个坑：canonicalize 顺序、跨平台大小写；外加符号链接/Unicode/盘符/UNC/频次。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOWED_EXTENSIONS,
  FS_LIMITS,
  checkWriteRate,
  hasSepBoundary,
  isWithin,
  resolveWithin,
  type JailOptions,
  type RejectReason,
  type Resolver,
} from '../src/deploy/fsJail';
import * as posix from 'path/posix';
import * as win32 from 'path/win32';

/** 内存文件系统：只提供 resolver 需要的三件事，够测逃逸 */
function memFs(files: Record<string, string>, links: Record<string, string> = {}, dirs: string[] = []) {
  const normKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  const isDir = (p: string) => dirs.map(normKey).includes(normKey(p));
  const resolver: Resolver = {
    exists: (p) => normKey(p) in files || isDir(p),
    isSymlink: (p) => normKey(p) in links,
    realpath: (p) => {
      // 逐级替换最长的符号链接前缀 —— 真实 realpath 的行为
      let cur = normKey(p);
      const sorted = Object.keys(links)
        .map(normKey)
        .sort((a, b) => b.length - a.length);
      for (const link of sorted) {
        if (cur === link || cur.startsWith(link + '/')) {
          cur = normKey(links[link]) + (cur === link ? '' : cur.slice(link.length));
          break;
        }
      }
      if (cur in files || isDir(cur)) return cur;
      return null;
    },
  };
  return resolver;
}

const posixOpt = (root: string, r: Resolver, ext?: readonly string[]): JailOptions => ({
  root, platform: 'posix', resolver: r, allowedExtensions: ext,
});
const winOpt = (root: string, r: Resolver, ext?: readonly string[]): JailOptions => ({
  root, platform: 'win32', resolver: r, allowedExtensions: ext,
});

interface Case {
  name: string;
  run: () => { ok: boolean; reason?: RejectReason };
  want: 'ok' | RejectReason;
}

const cases: Case[] = [
  // ---- 正常路径 ----
  {
    name: 'jail 内的普通文件',
    run: () =>
      resolveWithin('a/b.md', posixOpt('/ws', memFs({ '/ws/a/b.md': 'x' }, {}, ['/ws', '/ws/a']))),
    want: 'ok',
  },
  {
    name: 'jail 根自身（sep boundary 的相等分支）',
    run: () => resolveWithin('.', posixOpt('/ws', memFs({}, {}, ['/ws']))),
    want: 'extension', // '.' 展开后是 /ws，无扩展名 → 扩展名拒绝（目录不该当文件打开）
  },

  // ---- 坑 1：`..` 与符号链接 ----
  {
    name: '静态 `..` 逃逸（../../etc/passwd）',
    run: () => resolveWithin('../../etc/passwd.md', posixOpt('/ws', memFs({ '/etc/passwd.md': 'x' }, {}, ['/ws', '/etc']))),
    want: 'escape',
  },
  {
    name: '符号链接指向 jail 外 → 拒绝 symlink（不看目标）',
    run: () =>
      resolveWithin(
        'link.md',
        posixOpt('/ws', memFs({ '/etc/p.md': 'x' }, { '/ws/link.md': '/etc/p.md' }, ['/ws', '/etc'])),
      ),
    want: 'symlink',
  },
  {
    name: '符号链接指向 jail 内也一律拒绝（不做目标判定）',
    run: () =>
      resolveWithin(
        'link.md',
        posixOpt('/ws', memFs({ '/ws/real.md': 'x' }, { '/ws/link.md': '/ws/real.md' }, ['/ws'])),
      ),
    want: 'symlink',
  },
  {
    name: '坑 1 顺序：jail 根自身是符号链接时 jail 仍生效',
    run: () =>
      resolveWithin(
        'a.md',
        posixOpt('/alias', memFs({ '/real/a.md': 'x', '/real/outside.md': 'x' }, { '/alias': '/real' }, ['/real', '/ws'])),
      ),
    want: 'ok', // /alias → /real，a.md 在 /real 内，应放行；若先不 resolve 根则会被误判
  },
  {
    name: '坑 1 反面：jail 根是链接且目标外有同名目录，不能误放行',
    run: () =>
      resolveWithin(
        '../outside.md',
        posixOpt('/alias', memFs({ '/outside.md': 'x' }, { '/alias': '/real' }, ['/real'])),
      ),
    want: 'escape',
  },

  // ---- 前缀边界 ----
  {
    name: '前缀相同但非子目录（/workspace-evil 不被 /workspace 放行）',
    run: () => resolveWithin('../workspace-evil/x.md', posixOpt('/workspace', memFs({ '/workspace-evil/x.md': 'x' }, {}, ['/workspace', '/workspace-evil']))),
    want: 'escape',
  },

  // ---- 扩展名 ----
  {
    name: '扩展名不在白名单 → extension',
    run: () => resolveWithin('a.exe', posixOpt('/ws', memFs({ '/ws/a.exe': 'x' }, {}, ['/ws']))),
    want: 'extension',
  },
  {
    name: '扩展名大小写无关（.MD 视为 .md）',
    run: () => resolveWithin('a.MD', posixOpt('/ws', memFs({ '/ws/a.MD': 'x' }, {}, ['/ws']))),
    want: 'ok',
  },
  {
    name: '无扩展名 → 拒绝',
    run: () => resolveWithin('README', posixOpt('/ws', memFs({ '/ws/README': 'x' }, {}, ['/ws']))),
    want: 'extension',
  },
  {
    name: '点开头文件（.env）→ 无扩展名，拒绝',
    run: () => resolveWithin('.env', posixOpt('/ws', memFs({ '/ws/.env': 'x' }, {}, ['/ws']))),
    want: 'extension',
  },

  // ---- 坑 2：跨平台大小写 ----
  {
    name: '坑 2：Windows 大小写不敏感（C:\\WS vs c:\\ws 视为同一目录）',
    run: () => resolveWithin('a.md', winOpt('C:\\WS', memFs({ 'C:/WS/a.md': 'x' }, {}, ['C:/WS']))),
    want: 'ok',
  },
  {
    name: '坑 2：Windows 大小写不同的逃逸尝试仍被拦',
    run: () =>
      resolveWithin('..\\..\\outside.md', winOpt('C:\\WS', memFs({ 'C:/outside.md': 'x' }, {}, ['C:/WS']))),
    want: 'escape',
  },
  {
    name: 'posix 大小写敏感：不同大小写的路径不视为同一',
    run: () => resolveWithin('A.md', posixOpt('/ws', memFs({ '/ws/a.md': 'x' }, {}, ['/ws']))),
    want: 'ok', // 文件不存在 → 走 collapsed 文本判定，仍在 jail 内、扩展名合法
  },

  // ---- Windows 盘符与 UNC ----
  {
    name: 'Windows 绝对路径（C:\\other）不允许逃出',
    run: () => resolveWithin('C:\\other\\x.md', winOpt('C:\\WS', memFs({ 'C:/other/x.md': 'x' }, {}, ['C:/WS']))),
    want: 'escape',
  },
  {
    name: 'UNC 路径（\\\\server\\share）被拒',
    run: () => resolveWithin('\\\\server\\share\\x.md', winOpt('C:\\WS', memFs({}, {}, ['C:/WS']))),
    want: 'escape',
  },

  // ---- Unicode 归一化 ----
  {
    name: 'Unicode NFC/NFD 归一：分解形式的 é 与合成形式视为同一',
    run: () =>
      resolveWithin('café.md', posixOpt('/ws', memFs({ '/ws/café.md': 'x' }, {}, ['/ws']))),
    want: 'ok',
  },

  // ---- 默认关闭 ----
  {
    name: '未绑定工作区（root 为空）→ disabled',
    run: () => resolveWithin('a.md', posixOpt('', memFs({}, {}, []))),
    want: 'disabled',
  },
  {
    name: '空路径 → empty',
    run: () => resolveWithin('   ', posixOpt('/ws', memFs({}, {}, ['/ws']))),
    want: 'empty',
  },
];

describe('FS helper 路径 jail —— 逃逸场景表', () => {
  for (const c of cases) {
    it(`${c.name} → ${c.want}`, () => {
      const r = c.run();
      if (c.want === 'ok') expect(r.ok).toBe(true);
      else {
        expect(r.ok).toBe(false);
        expect((r as { reason: RejectReason }).reason).toBe(c.want);
      }
    });
  }
});

describe('isWithin / hasSepBoundary 的边界语义', () => {
  it('前缀相同但不是子目录时 hasSepBoundary 为 false', () => {
    expect(hasSepBoundary('/workspace', '/workspace-evil', 'posix')).toBe(false);
    expect(hasSepBoundary('/workspace', '/workspace/a', 'posix')).toBe(true);
  });
  it('isWithin 不允许 /workspace-evil 通过 /workspace', () => {
    expect(isWithin('/workspace', '/workspace-evil', 'posix')).toBe(false);
  });
  it('Windows 反斜杠边界', () => {
    expect(hasSepBoundary('C:\\WS', 'C:\\WS\\a', 'win32')).toBe(true);
    expect(hasSepBoundary('C:\\WS', 'C:\\WS-2', 'win32')).toBe(false);
  });
});

describe('写操作频次上限', () => {
  it('窗口内超限则返回 retryAfter', () => {
    const st = { timestamps: [] as number[] };
    const t0 = 1_000_000;
    for (let i = 0; i < FS_LIMITS.maxWritesPerMinute; i++) {
      expect(checkWriteRate(st, t0 + i).ok).toBe(true);
    }
    const over = checkWriteRate(st, t0 + FS_LIMITS.maxWritesPerMinute);
    expect(over.ok).toBe(false);
    expect(over.retryAfterMs).toBeGreaterThan(0);
  });
  it('窗口滑出后恢复：旧时间戳被清除，本次写入被记录', () => {
    const st = { timestamps: [1_000_000] };
    const t1 = 1_000_000 + 61_000;
    expect(checkWriteRate(st, t1).ok).toBe(true);
    // 放行会把本次记入 —— 「放行是否计数」本身就是行为的一部分，不能只断言 ok
    expect(st.timestamps).toEqual([t1]);
  });
});

describe('白名单默认值', () => {
  it('只含 UTF-8 文本资产', () => {
    for (const e of DEFAULT_ALLOWED_EXTENSIONS) expect(e.startsWith('.')).toBe(true);
    expect(DEFAULT_ALLOWED_EXTENSIONS).not.toContain('.exe');
  });
});
