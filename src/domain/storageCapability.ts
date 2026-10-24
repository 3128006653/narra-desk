/**
 * 存储能力探测（§5.1）。
 *
 * 原则：不向用户贴「你在隐私模式」的标签 —— estimate() 是弱信号、各家行为不一致。
 * 只呈现事实与建议：granted / not-granted / unknown(Safari) / unavailable。
 */
import type { BrowserFamily, CapabilityLevel, StorageCapability } from '../schema/entities';

export interface DetectEnv {
  indexedDBPresent: boolean;
  hasPersist: boolean;
  persist: () => Promise<boolean>;
  persistGranted: () => Promise<boolean>;
  estimate: () => Promise<{ quota?: number | null } | null>;
  hasShowDirectoryPicker: boolean;
  userAgent: string;
}

function defaultEnv(): DetectEnv {
  const nav = globalThis.navigator as
    | (Navigator & { storage?: StorageManager; userAgent?: string })
    | undefined;
  const storage = nav?.storage as (StorageManager & { persisted?: () => Promise<boolean> }) | undefined;
  const win = globalThis as unknown as Record<string, unknown>;
  return {
    indexedDBPresent: typeof globalThis.indexedDB !== 'undefined',
    hasPersist: !!storage && typeof storage.persist === 'function',
    persist: async () => (storage ? storage.persist() : false),
    persistGranted: async () =>
      storage && typeof storage.persisted === 'function' ? storage.persisted() : false,
    estimate: async () => (storage && storage.estimate ? storage.estimate() : null),
    hasShowDirectoryPicker: typeof win.showDirectoryPicker === 'function',
    userAgent: nav?.userAgent ?? '',
  };
}

export function browserFamilyOf(ua: string): BrowserFamily {
  if (/Firefox|FxiOS/i.test(ua)) return 'firefox';
  if (/Safari/i.test(ua) && !/Chrome|Chromium|Edg/i.test(ua)) return 'safari';
  if (/Chrome|Chromium|Edg/i.test(ua)) return 'chromium';
  return 'other';
}

export async function detectStorageCapability(
  env: Partial<DetectEnv> = {},
): Promise<StorageCapability> {
  const e: DetectEnv = { ...defaultEnv(), ...env };
  const family = browserFamilyOf(e.userAgent);

  let persistGranted = false;
  let estimatedQuota: number | null = null;

  if (e.indexedDBPresent) {
    try {
      persistGranted = await e.persistGranted();
    } catch {
      persistGranted = false;
    }
    try {
      const est = await e.estimate();
      estimatedQuota = typeof est?.quota === 'number' ? est.quota : null;
    } catch {
      estimatedQuota = null;
    }
  }

  const cap: StorageCapability = {
    indexedDB: e.indexedDBPresent,
    persistSupported: e.hasPersist,
    persistGranted,
    estimatedQuota,
    fsAccessSupported: e.hasShowDirectoryPicker,
    fsAccessFallback: !e.hasShowDirectoryPicker,
    browserFamily: family,
  };

  if (family === 'safari') {
    cap.persistNote =
      'Safari 对存储持久化的支持版本相关，以运行时探测为准；persist() 返回 true 也不豁免 7 天驱逐。';
  }
  return cap;
}

/**
 * 请求持久化。必须在用户手势后调用（浏览器要求）。
 * Safari 不支持时返回 false，不抛错。
 */
export async function requestPersistence(env: Partial<DetectEnv> = {}): Promise<boolean> {
  const e: DetectEnv = { ...defaultEnv(), ...env };
  if (!e.hasPersist) return false;
  try {
    return await e.persist();
  } catch {
    return false;
  }
}

export function capabilityLevel(cap: StorageCapability): CapabilityLevel {
  if (!cap.indexedDB) return 'unavailable';
  if (!cap.persistSupported) return 'unknown';
  return cap.persistGranted ? 'granted' : 'not-granted';
}

export function capabilityMessage(cap: StorageCapability): string {
  switch (capabilityLevel(cap)) {
    case 'unavailable':
      return 'IndexedDB 不可用，当前浏览器不支持本工具';
    case 'granted':
      return `持久化已授予${cap.estimatedQuota ? `，配额约 ${(cap.estimatedQuota / 1e9).toFixed(1)} GB` : ''}`;
    case 'not-granted':
      return '持久化未授予，数据可能被浏览器清理；建议绑定工作区文件夹';
    case 'unknown':
    default:
      return '无法确定持久化状态；建议定期导出 JSON 备份';
  }
}
