/**
 * 能力探测（阶段五第三轮）。
 * 重点：file:// 下「抛异常」与「返回 undefined」在探测里必须等价为不可用；
 * 且每个能力单独 try-catch，一个抛异常不能跳过其余探测。
 */
import { describe, expect, it } from 'vitest';
import {
  indicatorLevel,
  indicatorText,
  probeCapabilities,
  requestPersistence,
  type CapabilityProbeEnv,
} from '../src/deploy/capabilities';

/** 抛异常的属性：模拟 file:// 下 Safari 的行为 */
function throwingEnv(): CapabilityProbeEnv {
  const boom = (): never => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return {
    protocol: 'https:',
    family: 'other',
    navigatorLike: {
      get storage() {
        return { get persist() { return boom(); }, get estimate() { return boom(); } };
      },
      get locks() {
        return boom();
      },
    },
    windowLike: {
      get indexedDB() {
        return boom();
      },
      get showDirectoryPicker() {
        return boom();
      },
      get showOpenFilePicker() {
        return boom();
      },
    },
  };
}

describe('file:// 演示模式', () => {
  const c = probeCapabilities({ protocol: 'file:', family: 'chromium' });
  it('所有持久化能力一律不可用', () => {
    expect(c.mode).toBe('demo-file');
    expect(c.indexedDB).toBe(false);
    expect(c.persistSupported).toBe(false);
    expect(c.persistGranted).toBe(false);
    expect(c.fsAccessSupported).toBe(false);
    expect(c.webLocks).toBe(false);
  });
  it('导出仍可用（导出到下载目录），但导入后只在内存', () => {
    expect(c.fsAccessFallback).toBe(true);
  });
  it('顶部横幅文案存在', () => {
    expect(c.demoBanner).toContain('演示模式');
    expect(indicatorText(c)).toContain('演示模式');
    expect(indicatorLevel(c)).toBe('warn');
  });
});

describe('每个能力单独 try-catch —— 一个抛异常不能跳过其余探测', () => {
  it('全部 getter 都抛时，每个字段仍被判定为 false（而非 undefined / 漏探）', () => {
    const c = probeCapabilities(throwingEnv());
    expect(c.indexedDB).toBe(false);
    expect(c.persistSupported).toBe(false);
    expect(c.fsAccessSupported).toBe(false);
    expect(c.webLocks).toBe(false);
    // fsAccessFallback **不是**探测项：降级路径是 <input type=file>，恒可用。
    // 若 getter 抛异常就把它变 false，等于把「探测不到 FSAA」误做成「导出按钮不可用」。
    expect(c.fsAccessFallback).toBe(true);
  });
  it('部分抛异常时，未抛的那些仍被正确探测到', () => {
    const env: CapabilityProbeEnv = {
      protocol: 'https:',
      family: 'chromium',
      navigatorLike: {
        // 只抛异常的 getter，TS 会推断为 void —— 必须显式标注返回类型才能通过类型检查
        get storage(): { persist: () => Promise<boolean>; estimate: () => Promise<{ quota: number }> } {
          throw new Error('storage boom');
        },
        locks: {}, // 正常存在
      },
      windowLike: {
        indexedDB: {}, // 正常存在
        get showDirectoryPicker() {
          throw new Error('fsaa boom');
        },
      },
    };
    const c = probeCapabilities(env);
    // 关键点：storage 抛异常不影响 indexedDB 与 locks 被探测到
    expect(c.indexedDB).toBe(true);
    expect(c.webLocks).toBe(true);
    expect(c.persistSupported).toBe(false);
    expect(c.fsAccessSupported).toBe(false);
  });
});

describe('正式部署探测', () => {
  const served: CapabilityProbeEnv = {
    protocol: 'http:',
    family: 'chromium',
    navigatorLike: {
      storage: { persist: async () => true, estimate: async () => ({ quota: 1024 ** 3 * 2 }) },
      locks: {},
    },
    windowLike: { indexedDB: {}, showDirectoryPicker: () => ({}), showOpenFilePicker: () => ({}) },
  };
  it('http 协议即 served 模式，无演示横幅', () => {
    const c = probeCapabilities(served);
    expect(c.mode).toBe('served');
    expect(c.demoBanner).toBeNull();
    expect(c.indexedDB).toBe(true);
    expect(c.fsAccessSupported).toBe(true);
    expect(c.webLocks).toBe(true);
  });
  it('未授予持久化时给出建议而非「隐私模式」标签', () => {
    const c = probeCapabilities(served);
    expect(indicatorLevel(c)).toBe('warn');
    const t = indicatorText(c);
    expect(t).not.toContain('隐私模式'); // 不贴不可靠标签
    expect(t).toContain('持久化未授予');
  });
  it('Safari 单独呈现「无法确定」，且不依赖主屏豁免', () => {
    const c = probeCapabilities({ ...served, family: 'safari' });
    expect(indicatorLevel(c)).toBe('unknown');
    const t = indicatorText(c);
    expect(t).toContain('Safari');
    expect(t).toContain('7 天'); // 7 天驱逐是 Safari 家族提示的核心内容
    expect(t).not.toContain('主屏'); // 主屏豁免不作为持久化策略
  });
  it('IndexedDB 不可用 → error 档', () => {
    const c = probeCapabilities({ ...served, windowLike: {} });
    expect(c.indexedDB).toBe(false);
    expect(indicatorLevel(c)).toBe('error');
    expect(indicatorText(c)).toContain('IndexedDB 不可用');
  });
});

describe('requestPersistence', () => {
  it('persist 抛异常 → granted false，不向外抛', async () => {
    // 抛异常的 getter：模拟 file:// 下 Safari 的 SecurityError
    const r = await requestPersistence({
      navigatorLike: {
        get storage() {
          return {
            persist: async () => {
              throw new Error('denied');
            },
            estimate: async (): Promise<{ quota: number }> => ({ quota: 100 }),
          };
        },
      },
    });
    expect(r.granted).toBe(false);
    expect(r.quota).toBe(100);
  });
  it('estimate 抛异常时 quota 为 null，但 granted 仍有效', async () => {
    const r = await requestPersistence({
      navigatorLike: {
        storage: {
          persist: async (): Promise<boolean> => true,
          estimate: async (): Promise<{ quota: number }> => {
            throw new Error('nope');
          },
        },
      },
    });
    expect(r.granted).toBe(true);
    expect(r.quota).toBeNull();
  });
  it('无 storage → 不抛，返回 false/null', async () => {
    const r = await requestPersistence({ navigatorLike: {} });
    expect(r).toEqual({ granted: false, quota: null });
  });
});
