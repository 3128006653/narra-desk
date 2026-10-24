/**
 * 代理 / 配对 / 加固头的**纯逻辑**层（阶段五第二轮）。
 *
 * ⚠️ 本模块**只做判定，不做 IO**：不解析真实 HTTP 报文、不碰 socket、不读写磁盘。
 * 目的是让安全策略能被表驱动测通（本轮 40+ 条），而真实的 HTTP 语义
 * （cookie 在浏览器里的实际行为、DNS rebinding、CSP 拦截）必须等 Go 壳 + 真实浏览器，
 * 见 `deploy/httpContract.md` 的「待验证」栏。
 *
 * 顺序约定遵循 PITFALLS P-6：不依赖先验条件的判定一律前置。
 */

// ---------------------------------------------------------------- 路由

export type RouteKind = 'proxy' | 'static' | 'fs' | 'health' | 'unknown';

/** `/v1/*` 白名单：只有这些路径被转发，其余 `/v1/*` 一律拒绝 */
export const PROXY_PATH_ALLOWLIST: readonly string[] = [
  '/v1/chat/completions',
  '/v1/embeddings',
  '/v1/models',
];

export function classifyRoute(pathname: string): RouteKind {
  const p = pathname.split('?')[0];
  if (p === '/health') return 'health';
  if (p.startsWith('/v1/')) return 'proxy';
  if (p.startsWith('/fs/')) return 'fs';
  if (p === '/' || p.startsWith('/assets/') || /\.(js|css|html|ico|png|svg|woff2?)$/.test(p)) {
    return 'static';
  }
  return 'unknown';
}

/**
 * 「其他路径一律拒绝」只作用于**代理转发**（`/v1/*`）。
 * 静态资源走独立路由 —— 否则照字面实现会把自己的前端挡掉。
 */
export function isProxyPathAllowed(pathname: string): boolean {
  const p = pathname.split('?')[0];
  return PROXY_PATH_ALLOWLIST.includes(p);
}

// ---------------------------------------------------------------- Host

/** 只接受这三种形态；**带端口是合法的**（浏览器一定会带） */
export const HOST_ALLOWLIST: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/**
 * 解析 Host 头 → 归一化主机名（去端口、小写、去 IPv6 方括号）。
 * 无法解析时返回 null（视为非法）。
 */
export function parseHostHost(hostHeader: string): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  // 去掉端口：IPv6 的 `[::1]:8080` 要先保留方括号再剥离
  const m = h.match(/^(\[[^\]]+\])(?::\d+)?$/);
  if (m) return m[1];
  const idx = h.lastIndexOf(':');
  const name = idx > 0 ? h.slice(0, idx) : h;
  return name || null;
}

/** Host 头校验 —— DNS rebinding 的**必选**缓解，不是可选加固 */
export function isHostAllowed(hostHeader: string, allow = HOST_ALLOWLIST): boolean {
  const host = parseHostHost(hostHeader);
  if (!host) return false;
  return allow.includes(host);
}

// ---------------------------------------------------------------- Origin

export interface OriginPolicy {
  /** 允许的源（含协议+主机，可带端口） */
  allowed: readonly string[];
  /** 是否显式允许 `null`（file:// 演示模式） */
  allowNull: boolean;
}

export function isOriginAllowed(origin: string | null, policy: OriginPolicy): boolean {
  if (origin === null || origin === 'null') return policy.allowNull;
  const o = origin.trim().toLowerCase().replace(/\/$/, '');
  return policy.allowed.some((a) => a.toLowerCase().replace(/\/$/, '') === o);
}

// ---------------------------------------------------------------- 配对

export interface PairingState {
  /** 启动时生成的一次性 token */
  token: string;
  /** token 是否已被使用（一次性） */
  tokenUsed: boolean;
  /** 配对成功后下发的 session secret（**不是** token 本身） */
  sessionSecret: string | null;
}

export interface PairingConfig {
  /** 随机字节生成器（注入以便测试） */
  randomBytes: (n: number) => string;
}

/**
 * token 与 session secret 必须是**两个独立随机值**。
 * 若 cookie 值就是 token，token 泄漏（Referer、日志、屏幕共享）＝ 会话劫持。
 */
export function createPairingState(cfg: PairingConfig): PairingState {
  return {
    token: cfg.randomBytes(32),
    tokenUsed: false,
    sessionSecret: null,
  };
}

/**
 * 一次性 token 校验。
 *
 * **首次成功配对前不过期** —— 这是 v0.6.1 对「5 分钟过期」的修正：
 * 用户双击二进制后去泡杯咖啡回来，token 若已废就得重启进程，与「三步启动」冲突。
 * 配对成功后 token 立即作废，过期窗口自然关闭。
 */
export function verifyToken(state: PairingState, presented: string): boolean {
  if (state.tokenUsed) return false;
  if (!presented) return false;
  return constantTimeEqual(state.token, presented);
}

/** 完成配对：token 作废 + 签发独立 secret */
export function completePairing(state: PairingState, cfg: PairingConfig): string {
  state.tokenUsed = true;
  state.sessionSecret = cfg.randomBytes(32);
  return state.sessionSecret;
}

/** 请求是否持有效配对态 */
export function isPaired(state: PairingState, cookieSecret: string | null): boolean {
  if (!state.sessionSecret || !cookieSecret) return false;
  return constantTimeEqual(state.sessionSecret, cookieSecret);
}

/** 新 token 签发 → 旧 cookie 立即失效 */
export function rotateToken(state: PairingState, cfg: PairingConfig): PairingState {
  return { token: cfg.randomBytes(32), tokenUsed: false, sessionSecret: null };
}

/** 定长比较，避免时序侧信道；长度不等直接 false */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- 体积与 Content-Type

export const PROXY_LIMITS = {
  maxRequestBodyBytes: 8 * 1024 * 1024,
  maxResponseBodyBytes: 8 * 1024 * 1024,
  /** 连接超时（ms） */
  connectTimeoutMs: 15_000,
} as const;

export function isWithinBodyLimit(
  bytes: number,
  limit: number = PROXY_LIMITS.maxRequestBodyBytes,
): boolean {
  return Number.isFinite(bytes) && bytes >= 0 && bytes <= limit;
}

/** `Content-Type` 必须是 JSON（代理只转发 JSON API）；`charset` 后缀允许 */
export function isContentTypeAllowed(header: string | null): boolean {
  if (!header) return false;
  const base = header.split(';')[0].trim().toLowerCase();
  return base === 'application/json';
}

// ---------------------------------------------------------------- 响应头

/** 静态资源加固头。X-Frame-Options 与 CSP frame-ancestors 并存不冲突 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
};

/**
 * 带 token 的 URL 在首次访问后**原地跳转去掉 token**，
 * 必须配 `Referrer-Policy: no-referrer`，否则 token 会从 Referer 头泄漏到跳转目标。
 */
export const PAIRING_URL_PATTERN = /^[?&]token=([A-Za-z0-9_-]+)(?:&|$)/;

export function extractTokenFromQuery(query: string): string | null {
  const q = query.startsWith('?') ? query.slice(1) : query;
  const m = q.match(/(?:^|&)token=([A-Za-z0-9_-]+)(?:&|$)/);
  return m ? m[1] : null;
}
