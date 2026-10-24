/**
 * 统一能力探测（阶段五第三轮）。
 *
 * 覆盖两种部署模式：
 * - 正式部署 `http://127.0.0.1:<port>` —— IndexedDB / Web Locks / FSAA 全部可用
 * - file:// 演示模式 —— **完全内存态**，不承诺任何持久化能力
 *
 * ⚠️ 每个能力**单独 try-catch**，不要用一次 try 包全部。
 * file:// 下 `navigator.storage.persist`、`indexedDB`、`showDirectoryPicker`、`navigator.locks`
 * 可能**直接抛异常**（不是返回 undefined，Safari 尤其如此）。
 * 一个 try 包全部时，第一个抛异常会跳过后面所有探测 —— 探测结果会「部分缺失」，
 * 而调用方看到的是「没有报告 = 不可用」，两者混淆后极难排查。
 *
 * 另注：**不探测 `isSecureContext` 来判断 file://**。规范上 `file://` 属于
 * potentially trustworthy origin，它是 secure context；file:// 下真正崩掉的是
 * origin 语义不统一 / CORS null origin / FSAA 实现受限三条，见 §6.2。
 * 用 `isSecureContext` 判断会得出「安全所以可用」的错误结论。
 */

export type BrowserFamily = 'chromium' | 'firefox' | 'safari' | 'other';

export type DeploymentMode = 'served' | 'demo-file';

export interface CapabilityProbeEnv {
  /** 页面协议；`file:` 即演示模式 */
  protocol: string;
  /** 浏览器家族，用于呈现家族相关的持久化提示 */
  family?: BrowserFamily;
  navigatorLike?: {
    storage?: { persist?: () => Promise<boolean>; estimate?: () => Promise<{ quota?: number }> };
    locks?: unknown;
  };
  windowLike?: {
    indexedDB?: unknown;
    showDirectoryPicker?: unknown;
    showOpenFilePicker?: unknown;
  };
}

export interface Capabilities {
  mode: DeploymentMode;
  family: BrowserFamily;
  /** IndexedDB 可写（演示模式下恒 false） */
  indexedDB: boolean;
  /** `navigator.storage.persist` 是否存在 */
  persistSupported: boolean;
  /** persist() 是否已授予 */
  persistGranted: boolean;
  estimatedQuota: number | null;
  /** File System Access API 目录绑定 */
  fsAccessSupported: boolean;
  /** browser-fs-access 降级路径可用 */
  fsAccessFallback: boolean;
  /** Web Locks（单活动标签页） */
  webLocks: boolean;
  /** 家族相关的持久化说明（如 Safari 7 天驱逐），UI 直接展示 */
  persistNote: string | null;
  /** 演示模式横幅文案；非演示模式为 null */
  demoBanner: string | null;
}

const DEMO_BANNER = '演示模式：不保存数据；请使用 127.0.0.1 部署以持久化';

function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined || v === null ? fallback : v;
  } catch {
    // 抛异常与「不存在」在能力探测里是同一个结论：不可用
    return fallback;
  }
}

function detectFamily(env: CapabilityProbeEnv): BrowserFamily {
  if (env.family) return env.family;
  return safe(() => {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    if (/firefox|fxios/i.test(ua)) return 'firefox' as BrowserFamily;
    if (/safari/i.test(ua) && !/chrome|chromium|edg/i.test(ua)) return 'safari' as BrowserFamily;
    if (/chrome|chromium|edg/i.test(ua)) return 'chromium' as BrowserFamily;
    return 'other' as BrowserFamily;
  }, 'other' as BrowserFamily);
}

/**
 * 家族相关的持久化说明。
 * Safari：无交互站点 7 天后可能清理脚本可写存储，`persist()` 返回 true 也不豁免；
 * 主屏 Web App 豁免范围与版本相关且历史有反复，**不作为持久化策略依赖**。
 */
function persistNoteFor(family: BrowserFamily, persistGranted: boolean): string | null {
  if (family === 'safari') {
    return persistGranted
      ? 'Safari：存储不保证持久，persist() 返回 true 也不豁免 7 天驱逐；导出是唯一可靠兜底'
      : 'Safari：存储不保证持久，无交互站点约 7 天后可能被清理；导出是唯一可靠兜底';
  }
  if (!persistGranted) return '持久化未授予，数据可能被浏览器清理；建议绑定工作区文件夹';
  return null;
}

/**
 * 同步探测。**异步的 `persist()` / `estimate()` 不在此调用** ——
 * 它们需要用户手势与异步等待，交给 `requestPersistence()` 单独处理，
 * 避免探测函数因 await 失败而整体不可用。
 */
export function probeCapabilities(env: CapabilityProbeEnv): Capabilities {
  const mode: DeploymentMode = env.protocol === 'file:' ? 'demo-file' : 'served';
  const family = detectFamily(env);

  // 演示模式：一律不可用，但仍逐个走 safe() —— 保持「探测过」与「未探测」可区分
  if (mode === 'demo-file') {
    return {
      mode,
      family,
      indexedDB: false,
      persistSupported: false,
      persistGranted: false,
      estimatedQuota: null,
      fsAccessSupported: false,
      fsAccessFallback: true, // 导出按钮可用（导出到下载目录）
      webLocks: false,
      persistNote: null,
      demoBanner: DEMO_BANNER,
    };
  }

  const nav = env.navigatorLike ?? {};
  const win = env.windowLike ?? {};

  const indexedDB = safe(() => !!win.indexedDB, false);
  const persistSupported = safe(() => typeof nav.storage?.persist === 'function', false);
  const fsAccessSupported = safe(() => typeof win.showDirectoryPicker === 'function', false);
  // ⚠️ fsAccessFallback 不是能力探测项：browser-fs-access 的降级路径是
  // `<input type="file">` / `<a download>`，任何浏览器都有。所以它**恒为 true**，
  // 不随 getter 抛异常变化 —— 抛异常只说明「无法探测 FSAA」，不代表降级路径消失。
  // 若把它做成探测项，getter 抛异常会让它变 false，导出按钮就被误关掉了。
  const fsAccessFallback = true;
  const webLocks = safe(() => !!nav.locks, false);

  return {
    mode,
    family,
    indexedDB,
    persistSupported,
    persistGranted: false,
    estimatedQuota: null,
    fsAccessSupported,
    fsAccessFallback,
    webLocks,
    persistNote: persistNoteFor(family, false),
    demoBanner: null,
  };
}

/** 请求持久化存储；失败或被拒都返回 false，不抛异常 */
export async function requestPersistence(
  env: Pick<CapabilityProbeEnv, 'navigatorLike'>,
): Promise<{ granted: boolean; quota: number | null }> {
  const storage = env.navigatorLike?.storage;
  if (!storage) return { granted: false, quota: null };
  let granted = false;
  try {
    if (typeof storage.persist === 'function') granted = await storage.persist();
  } catch {
    granted = false;
  }
  let quota: number | null = null;
  try {
    if (typeof storage.estimate === 'function') {
      const est = await storage.estimate();
      quota = typeof est?.quota === 'number' ? est.quota : null;
    }
  } catch {
    quota = null;
  }
  return { granted, quota };
}

/** UI 状态指示器的四档 */
export type IndicatorLevel = 'ok' | 'warn' | 'error' | 'unknown';

export function indicatorLevel(c: Capabilities): IndicatorLevel {
  if (c.mode === 'demo-file') return 'warn';
  if (!c.indexedDB) return 'error';
  if (c.family === 'safari') return 'unknown';
  return c.persistGranted ? 'ok' : 'warn';
}

export function indicatorText(c: Capabilities): string {
  if (c.demoBanner) return c.demoBanner;
  if (!c.indexedDB) return 'IndexedDB 不可用，当前浏览器不支持本工具';
  if (c.family === 'safari') return c.persistNote ?? '无法确定持久化状态（Safari），建议定期导出';
  if (c.persistGranted && c.estimatedQuota) {
    return `持久化已授予，配额约 ${(c.estimatedQuota / 1024 ** 3).toFixed(1)} GB`;
  }
  return c.persistNote ?? '持久化未授予；建议绑定工作区文件夹';
}
