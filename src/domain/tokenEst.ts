/**
 * Token 估算（§5.9 显式公式）。
 *
 *   est = (cjkChars × 1.0 + latinChars / 4) × 1.2
 *
 * 分桶：
 *   cjkChars   CJK 统一表意文字 + 假名 + 谚文          每字 1.0
 *   latinChars 拉丁字母、数字、其他可打印 ASCII         每 4 字符 1（0.25/字符）
 *   other      emoji、符号、非 CJK 非拉丁字母          0.25/字符（与 latin 同桶）
 *
 * 两点刻意的设计约束：
 *  1. **1.2 是唯一的校准旋钮**。CJK 与拉丁的 4 倍结构性差异进公式、不进系数 ——
 *     若实现成「字符数 × 1.2」，纯英文会被高估约 4.8 倍，反而提前触发裁剪，
 *     而裁剪会丢弃摘要、回退注入原始 Turn，token 花得更多。
 *  2. CJK 标点（。、「」等）按 spec 字面归入 other（0.25/字符）。这是已知的
 *     偏保守点：中文文本里标点约占 5–8%，低估量落在 1.2 安全边际内。
 *     **校准期候选**：若实测偏差超边际，改这里而非动 1.2。
 */

/**
 * 安全边际系数（未校准 family 的默认值）。
 *
 * 校准结论写在这里（**不要改代码来调系数**）：样本够多后按 model family 存一张
 * 系数表，`estimateTokens(text, family)` 自动查表，见 `tokenCalibration.ts`。
 */
export const TOKEN_SAFETY_FACTOR = 1.2;
/** 预算留出的余量比例 */
export const BUDGET_RESERVE_RATIO = 0.1;

export interface CharBuckets {
  cjk: number;
  latin: number;
  other: number;
}

function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 主区
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意文字
    (cp >= 0x3040 && cp <= 0x309f) || // 平假名
    (cp >= 0x30a0 && cp <= 0x30ff) || // 片假名
    (cp >= 0xac00 && cp <= 0xd7af) || // 谚文音节
    (cp >= 0x1100 && cp <= 0x11ff) || // 谚文字母
    (cp >= 0x20000 && cp <= 0x2a6df) || // CJK Ext B
    (cp >= 0x2a700 && cp <= 0x2ebef) || // CJK Ext C–F
    (cp >= 0x2f800 && cp <= 0x2fa1f) // CJK 兼容补充
  );
}

/** 按码点分桶（for...of 迭代的是码点，emoji 不会被拆成两个 surrogate） */
export function classifyChars(text: string): CharBuckets {
  const out: CharBuckets = { cjk: 0, latin: 0, other: 0 };
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isCjkCodePoint(cp)) out.cjk += 1;
    else if (cp <= 0x7f) out.latin += 1;
    else out.other += 1;
  }
  return out;
}

/** 未乘安全系数的基线值，便于校准期对比真实 tokenizer */
export function baseTokenCount(text: string): number {
  const b = classifyChars(text);
  return b.cjk * 1.0 + (b.latin + b.other) / 4;
}

export function estimateTokens(text: string, family?: string): number {
  return Math.ceil(baseTokenCount(text) * factorFor(family));
}

// ------------------------------------------------------------ 按 family 的校准系数（I-24）

/**
 * 校准后的系数表：**内存缓存**，由 `tokenCalibration.loadFactors(db)` 在启动时填充。
 *
 * 为什么是缓存而不是每次查库：`estimateTokens` 在组装热路径上被调用几百次，
 * 必须是同步的。持久化仍然做（见 `tokenCalibration.ts`），只是读走缓存。
 */
const factorCache = new Map<string, number>();

/** 未校准 family 的默认系数 */
export const DEFAULT_FACTOR = TOKEN_SAFETY_FACTOR;

export function factorFor(family?: string): number {
  if (!family) return TOKEN_SAFETY_FACTOR;
  return factorCache.get(family) ?? TOKEN_SAFETY_FACTOR;
}

/** 写入缓存（由校准模块调用；测试也可直接注入） */
export function setFactor(family: string, factor: number): void {
  factorCache.set(family, factor);
}

export function clearFactors(): void {
  factorCache.clear();
}

export function allFactors(): Record<string, number> {
  return Object.fromEntries(factorCache);
}

/** 可用预算 = 上下文上限扣除余量 */
export function usableBudget(contextLimitTokens: number): number {
  return Math.floor(contextLimitTokens * (1 - BUDGET_RESERVE_RATIO));
}

/**
 * 从尾部截断到目标 token 数（mes_example / description 尾段用）。
 * est 对长度单调，故可二分。
 */
export function truncateTail(
  text: string,
  targetTokens: number,
  estimate: (s: string) => number = estimateTokens,
): string {
  if (estimate(text) <= targetTokens) return text;
  if (targetTokens <= 0) return '';
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimate(chars.slice(0, mid).join('')) <= targetTokens) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('');
}
