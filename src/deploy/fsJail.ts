/**
 * FS helper 的路径 jail（阶段五第一轮）—— **纯模块，不依赖 HTTP 层**。
 *
 * 之所以抽成纯模块：逃逸场景（`..`、符号链接、大小写、Unicode、Windows 盘符/UNC）
 * 必须能表驱动测通，而起服务器测这些是灾难。套 HTTP 壳时，路由层只负责
 * 「把用户路径交给本模块，按返回的 kind 决定 404 还是 200」。
 *
 * ⚠️ 两个最容易踩的坑（见 `resolveWithin` 的实现）：
 *
 * 1. **canonicalize 的顺序**：必须先 resolve jail 根、**再** resolve 用户路径，
 *    然后用两个**真实路径**做前缀匹配。若拿未 resolve 的 jail 根去匹配，
 *    jail 根自身是符号链接时 jail 会失效。
 *
 * 2. **跨平台大小写**：Windows / macOS 默认不敏感（macOS 可配置敏感），Linux 敏感。
 *    前缀匹配前必须按平台归一化（见 `caseFoldFor`）。
 *    这不是「理论风险」——`..\..\` 在 Windows 上若未归一化就能绕过大小写不同的 jail 根。
 */
import * as posix from 'path/posix';
import * as win32 from 'path/win32';

export type Platform = 'posix' | 'win32';

export interface Resolver {
  /** 把路径变成真实路径（跟随符号链接）；不存在时返回 null */
  realpath: (p: string) => string | null;
  /** 路径是否已存在 */
  exists: (p: string) => boolean;
  /** 该路径是否是符号链接 */
  isSymlink: (p: string) => boolean;
}

export type RejectReason =
  /** 路径逃出 jail 根 */
  | 'escape'
  /** 符号链接 —— 一律拒绝，不做「链接目标是否在 jail 内」的判定 */
  | 'symlink'
  /** 扩展名不在白名单 */
  | 'extension'
  /** 根目录未配置（FS helper 默认关闭） */
  | 'disabled'
  /** 空路径 / 非法输入 */
  | 'empty';

export interface JailOk {
  ok: true;
  /** 可直接 open 的真实绝对路径 */
  realPath: string;
}
export interface JailReject {
  ok: false;
  reason: RejectReason;
}
export type JailResult = JailOk | JailReject;

/** 默认白名单：工作区只放这些（UTF-8 文本资产） */
export const DEFAULT_ALLOWED_EXTENSIONS: readonly string[] = [
  '.json',
  '.md',
  '.txt',
  '.yaml',
  '.yml',
];

export interface JailOptions {
  /** jail 根；undefined = FS helper 未启用（默认关闭） */
  root?: string;
  platform: Platform;
  resolver: Resolver;
  allowedExtensions?: readonly string[];
}

const api = (p: Platform) => (p === 'win32' ? win32 : posix);

/**
 * 大小写归一化策略。
 * Windows：一律 lower（不敏感）。macOS 归 posix，但默认不敏感 —— 见 `caseInsensitivePlatforms`。
 */
export const CASE_INSENSITIVE: readonly Platform[] = ['win32'];

function caseFoldFor(p: Platform, s: string): string {
  return CASE_INSENSITIVE.includes(p) ? s.toLowerCase() : s;
}

/** 判断是否 `child` 在 `root` 之内（含 root 自身） */
export function isWithin(root: string, child: string, platform: Platform): boolean {
  const r = caseFoldFor(platform, root.replace(/[\\/]+$/, ''));
  const c = caseFoldFor(platform, child);
  if (c === r) return true;
  const sep = platform === 'win32' ? '\\' : '/';
  return c.startsWith(r + sep);
}

/**
 * 前缀匹配要求**分隔符边界**：`/workspace-evil` 不能以 `/workspace` 为前缀通过。
 * 这是 `isWithin` 用 `r + sep` 而不是裸 `startsWith(r)` 的原因。
 */
export function hasSepBoundary(root: string, child: string, platform: Platform): boolean {
  const r = caseFoldFor(platform, root.replace(/[\\/]+$/, ''));
  const c = caseFoldFor(platform, child);
  if (!c.startsWith(r)) return false;
  const rest = c.slice(r.length);
  // Windows 上两种分隔符都可能出现（用户手输 `/`、Node join 出 `\`），都要算边界
  return rest === '' || (platform === 'win32' ? rest.startsWith('\\') || rest.startsWith('/') : rest.startsWith('/'));
}

function extOf(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

/** Unicode 归一化 —— NFC。`é` 的分解形式与合成形式必须视为同一路径 */
function norm(s: string): string {
  return s.normalize('NFC');
}

/**
 * 把用户提供的相对路径解析到 jail 内的真实路径。
 *
 * 拒绝一律返回 `ok:false`，**由调用方统一转 404**（不回 403 —— 403 会暴露路由存在性）。
 */
export function resolveWithin(userPath: string, opt: JailOptions): JailResult {
  if (!opt.root) return { ok: false, reason: 'disabled' };
  if (!userPath || !userPath.trim()) return { ok: false, reason: 'empty' };

  const path = api(opt.platform);
  const nRoot = norm(opt.root);
  const nUser = norm(userPath);

  // 坑 1 的一半：**先** resolve jail 根 —— 它本身可能是符号链接
  const realRoot = opt.resolver.realpath(nRoot);
  if (!realRoot) return { ok: false, reason: 'escape' };

  // 绝对路径一律拒绝：用户只能给**相对**路径。
  // 这同时覆盖 Windows 盘符（C:\other）与 UNC（\\server\share）——
  // 它们不是「工作区内的相对位置」，join 之后看似落在 jail 内，实际指向另一棵树。
  if (path.isAbsolute(nUser)) return { ok: false, reason: 'escape' };

  const joined = path.join(nRoot, nUser);

  // 纯字符串层面的 `..` 折叠：canonicalize 之前先做一次，避免依赖 resolver
  const collapsed = path.normalize(joined);

  // 符号链接：无论目标是否在 jail 内，**一律拒绝**，不做「目标是否在 jail 内」的判定。
  // ⚠️ 判定必须在 exists 之前 —— 链接可能指向不存在的位置，先查 exists 会漏判。
  if (opt.resolver.isSymlink(collapsed)) return { ok: false, reason: 'symlink' };

  // 坑 1 的另一半：**再** resolve 用户路径
  const real = opt.resolver.realpath(collapsed);

  const target = real ?? collapsed;
  if (!hasSepBoundary(realRoot, target, opt.platform)) return { ok: false, reason: 'escape' };

  const allowed = opt.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS;
  if (!allowed.includes(extOf(target))) return { ok: false, reason: 'extension' };

  return { ok: true, realPath: target };
}

/**
 * 体积与频次上限（§6.3）—— 防失控循环写满磁盘。
 * 占位值，实现期校准。
 */
export const FS_LIMITS = {
  /** 单文件上限 */
  maxFileBytes: 100 * 1024 * 1024,
  /** 单工作区总上限 */
  maxWorkspaceBytes: 1024 * 1024 * 1024,
  /** 每分钟写操作上限 */
  maxWritesPerMinute: 120,
} as const;

export interface RateState {
  timestamps: number[];
}

/** 写操作频次检查（滑动窗口） */
export function checkWriteRate(
  state: RateState,
  now: number,
  limit = FS_LIMITS.maxWritesPerMinute,
): { ok: boolean; retryAfterMs?: number } {
  const windowStart = now - 60_000;
  const recent = state.timestamps.filter((t) => t > windowStart);
  if (recent.length >= limit) {
    state.timestamps = recent;
    return { ok: false, retryAfterMs: recent[0] + 60_000 - now };
  }
  // 放行 = 记一次写；拒绝时不记，否则超限后时间戳一直涨，窗口永远滑不出去
  recent.push(now);
  state.timestamps = recent;
  return { ok: true };
}
