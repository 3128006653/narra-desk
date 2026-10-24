/**
 * ID 生成。生产环境用 crypto.randomUUID()（127.0.0.1 与 https 下可用）。
 * 测试环境注入 uuid() 以获得确定性 ID，便于断言。
 */

let uuidImpl: () => string = () => {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // 兜底：非安全上下文（不应出现在推荐部署下，仅为健壮性）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

let clockImpl: () => number = () => Date.now();

/**
 * 单调时钟：**永不返回比上一次更小的值**（相同则 +1ms）。
 *
 * 存在理由（实测偶发）：revision 按 `createdAt` 排序，而两个 revision 可能落在同一毫秒
 * （测试注入固定时钟、或生产环境快速连续写入）→ 排序结果不稳定 →
 * `listRevisions` 返回顺序在 v1/v2 之间跳变，用例随机红。
 *
 * +1ms 的代价可忽略：时间戳用于排序、退避与超时判定，不用于显示。
 * 若将来需要真实墙钟（如日志时间），另行取 `Date.now()`，不要复用 `now()`。
 *
 * ⚠️ **不要删掉 +1ms 这条分支**，它看起来多余但并非如此：
 *    测试注入固定时钟时，同一毫秒内的多次调用靠它保证排序稳定；
 *    生产环境自然时钟下该分支几乎不触发（除非同一毫秒内连续写入两次），
 *    所以「生产上没见过」不能作为删除它的理由 —— 删了会让 CI 随机红（I-23）。
 */
let lastTs = 0;

export function newId(prefix: string): string {
  return `${prefix}_${uuidImpl()}`;
}

export function now(): number {
  const t = clockImpl();
  lastTs = t > lastTs ? t : lastTs + 1;
  return lastTs;
}

/** 测试替身注入 */
export function __setTestHooks(uuid?: () => string, clock?: () => number): void {
  if (uuid) uuidImpl = uuid;
  if (clock) clockImpl = clock;
}
