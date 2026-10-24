/**
 * 代理 / 配对 / Host 校验的纯逻辑（阶段五第二轮）。
 * 覆盖范围为 deploy/httpContract.md 的「已验证」栏 —— 真实 HTTP 行为不在此测。
 */
import { describe, expect, it } from 'vitest';
import {
  HOST_ALLOWLIST,
  PROXY_LIMITS,
  PROXY_PATH_ALLOWLIST,
  SECURITY_HEADERS,
  classifyRoute,
  completePairing,
  constantTimeEqual,
  createPairingState,
  extractTokenFromQuery,
  isContentTypeAllowed,
  isHostAllowed,
  isOriginAllowed,
  isPaired,
  isProxyPathAllowed,
  isWithinBodyLimit,
  parseHostHost,
  rotateToken,
  verifyToken,
  type PairingState,
} from '../src/deploy/proxyPolicy';

/**
 * 可复现的随机源：每次调用返回递增值。
 * ⚠️ 计数器必须是**模块级共享**的 —— 若每次 `cfg()` 都新建计数器，
 * token 与 secret 会撞成同一个值，那条「secret 必须 ≠ token」的用例就失去意义
 * （它本该验证的东西被测试自身的缺陷掩盖了）。
 */
let seq = 0;
const seqRandom = (len: number) => () =>
  (++seq).toString(16).padStart(len, '0').slice(0, len);
const cfg = () => ({ randomBytes: seqRandom(32) });

describe('路由判定', () => {
  const cases: Array<[string, ReturnType<typeof classifyRoute>]> = [
    ['/health', 'health'],
    ['/v1/chat/completions', 'proxy'],
    ['/v1/anything', 'proxy'],
    ['/fs/foo.md', 'fs'],
    ['/', 'static'],
    ['/assets/app.js', 'static'],
    ['/index.html', 'static'],
    ['/favicon.ico', 'static'],
    ['/font.woff2', 'static'],
    ['/random/path', 'unknown'],
  ];
  for (const [p, want] of cases) {
    it(`${p} → ${want}`, () => expect(classifyRoute(p)).toBe(want));
  }
  it('带 query 的路径仍按 pathname 判定', () => {
    expect(classifyRoute('/assets/app.js?v=2')).toBe('static');
    expect(classifyRoute('/v1/chat/completions?x=1')).toBe('proxy');
  });

  it('白名单内的 /v1/* 才转发', () => {
    for (const p of PROXY_PATH_ALLOWLIST) expect(isProxyPathAllowed(p)).toBe(true);
  });
  it('白名单外的 /v1/* 拒绝 —— 「其他路径一律拒绝」只作用于代理', () => {
    expect(isProxyPathAllowed('/v1/secret/admin')).toBe(false);
    expect(isProxyPathAllowed('/v1/')).toBe(false);
  });
  it('静态资源不受 /v1 白名单影响（否则会把自己的前端挡掉）', () => {
    expect(classifyRoute('/')).toBe('static');
    expect(isProxyPathAllowed('/')).toBe(false); // 但它不需要过代理白名单
  });
});

describe('Host 头校验（DNS rebinding 必选项）', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]']) {
    it(`裸形态 ${h} 放行`, () => expect(isHostAllowed(h)).toBe(true));
  }
  it('带端口放行（浏览器一定会带端口）', () => {
    expect(isHostAllowed('localhost:8080')).toBe(true);
    expect(isHostAllowed('127.0.0.1:5173')).toBe(true);
    expect(isHostAllowed('[::1]:8080')).toBe(true);
  });
  it('IPv6 方括号不被误切成主机名', () => {
    expect(parseHostHost('[::1]:8080')).toBe('[::1]');
    expect(parseHostHost('[::1]')).toBe('[::1]');
  });
  it('大小写与空白归一化', () => {
    expect(isHostAllowed('LOCALHOST')).toBe(true);
    expect(isHostAllowed('  Localhost:80  ')).toBe(true);
  });
  it('attacker 域名拒绝', () => {
    for (const h of ['evil.com', 'localhost.evil.com', '127.0.0.1.evil.com', 'app.localhost']) {
      expect(isHostAllowed(h)).toBe(false);
    }
  });
  it('空 / 畸形 → 拒绝', () => {
    expect(isHostAllowed('')).toBe(false);
    expect(isHostAllowed(':8080')).toBe(false);
    expect(parseHostHost('')).toBeNull();
  });
  it('白名单默认只含三个本机形态', () => {
    expect(HOST_ALLOWLIST).toEqual(['localhost', '127.0.0.1', '[::1]']);
  });
});

describe('Origin 校验', () => {
  const policy = { allowed: ['http://127.0.0.1:8080', 'http://localhost:8080'], allowNull: false };
  it('白名单内放行', () => {
    expect(isOriginAllowed('http://127.0.0.1:8080', policy)).toBe(true);
  });
  it('跨站 Origin 拒绝', () => {
    expect(isOriginAllowed('https://evil.com', policy)).toBe(false);
  });
  it('null Origin 默认拒绝（演示模式才显式允许）', () => {
    expect(isOriginAllowed('null', { ...policy, allowNull: false })).toBe(false);
    expect(isOriginAllowed(null, { ...policy, allowNull: false })).toBe(false);
    expect(isOriginAllowed('null', { ...policy, allowNull: true })).toBe(true);
  });
  it('尾部斜杠归一化', () => {
    expect(isOriginAllowed('http://localhost:8080/', policy)).toBe(true);
  });
});

describe('配对：token 与 session secret 必须独立', () => {
  it('cookie secret 不等于 token —— 否则 token 泄漏即会话劫持', () => {
    const st = createPairingState(cfg());
    const secret = completePairing(st, cfg());
    expect(secret).not.toBe(st.token);
    expect(st.sessionSecret).toBe(secret);
  });
  it('token 一次性：用完即废', () => {
    const st = createPairingState(cfg());
    expect(verifyToken(st, st.token)).toBe(true);
    completePairing(st, cfg());
    expect(verifyToken(st, st.token)).toBe(false);
  });
  it('错误 token 拒绝', () => {
    const st = createPairingState(cfg());
    expect(verifyToken(st, 'wrong')).toBe(false);
    expect(verifyToken(st, '')).toBe(false);
  });
  it('首次成功配对前不过期（v0.6.1 对 5 分钟过期的修正）', () => {
    const st = createPairingState(cfg());
    // 本模块不实现墙钟过期 —— 不存在「超时失效」路径，即等价于不过期
    expect(verifyToken(st, st.token)).toBe(true);
    expect(verifyToken(st, st.token)).toBe(true);
  });
  it('未配对请求拒绝，配对后放行', () => {
    const st = createPairingState(cfg());
    expect(isPaired(st, null)).toBe(false);
    const secret = completePairing(st, cfg());
    expect(isPaired(st, secret)).toBe(true);
    expect(isPaired(st, 'forged')).toBe(false);
  });
  it('新 token 签发 → 旧 cookie 立即失效', () => {
    const st = createPairingState(cfg());
    const old = completePairing(st, cfg());
    const next: PairingState = rotateToken(st, cfg());
    expect(isPaired(next, old)).toBe(false);
    expect(next.sessionSecret).toBeNull();
    expect(next.tokenUsed).toBe(false);
  });
  it('定长比较：长度不等直接 false，不抛异常', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('体积与 Content-Type', () => {
  it('上限内放行、超限拒绝', () => {
    expect(isWithinBodyLimit(PROXY_LIMITS.maxRequestBodyBytes)).toBe(true);
    expect(isWithinBodyLimit(PROXY_LIMITS.maxRequestBodyBytes + 1)).toBe(false);
  });
  it('负数 / NaN 拒绝（防御畸形 Content-Length）', () => {
    expect(isWithinBodyLimit(-1)).toBe(false);
    expect(isWithinBodyLimit(Number.NaN)).toBe(false);
  });
  it('只接受 JSON', () => {
    expect(isContentTypeAllowed('application/json')).toBe(true);
    expect(isContentTypeAllowed('application/json; charset=utf-8')).toBe(true);
    expect(isContentTypeAllowed('text/plain')).toBe(false);
    expect(isContentTypeAllowed(null)).toBe(false);
  });
});

describe('加固头与 token 提取', () => {
  it('四个头齐全', () => {
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    expect(SECURITY_HEADERS['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(SECURITY_HEADERS['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer'); // 防 token 从 Referer 泄漏
  });
  it('从 query 提取 token（含非首位参数）', () => {
    expect(extractTokenFromQuery('?token=ABC123')).toBe('ABC123');
    expect(extractTokenFromQuery('token=ABC123')).toBe('ABC123');
    expect(extractTokenFromQuery('?a=1&token=abc&b=2')).toBe('abc');
    expect(extractTokenFromQuery('?a=1')).toBeNull();
  });
});
