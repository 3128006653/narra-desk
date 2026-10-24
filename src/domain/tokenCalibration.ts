/**
 * Token 校准（§5.9 兑现点：1.2 标注为「校准期用真实样本回归后锁定」）。
 *
 * 完整范围（I-24）：**样本持久化 + 按 model family 的系数表**。
 * 只累计样本不落库没意义 —— 下次启动又回到 1.2，校准等于没做。
 * 所以这里每个 family 存一行：最近的比率样本 + 校准出的系数。
 *
 * 消费端在 `tokenEst.ts`：`estimateTokens(text, family)` 查内存缓存，
 * 缓存由 `loadFactors(db)` 在启动时填充。缓存为空时用默认 1.2。
 *
 * ⚠️ **按 model family 分组**，不要混着看：
 *    不同 tokenizer 的 CJK/拉丁比例差异很大，混算中位数没有意义。
 *    文档里 `tiktoken-wasm` 也是按 family 覆盖的，两边口径要一致。
 */
import type { NarraDB } from '../schema/db';
import { estimateTokens, setFactor, clearFactors } from './tokenEst';

/** 单个 family 保留的样本上限（够算中位数即可，不需要无限增长） */
const MAX_SAMPLES_PER_FAMILY = 200;

export interface CalibrationRow {
  /** = family，单一真相源 */
  id: string;
  family: string;
  /** 最近的 `usage / est` 样本（滚动窗口） */
  ratios: number[];
  /** 校准后的系数；未达最低样本数时为默认 1.2 */
  factor: number;
  sampleCount: number;
  updatedAt: number;
}

/** 少于这个样本数不写回系数 —— 3 条的「中位数」没有统计意义 */
export const MIN_SAMPLES_FOR_FACTOR = 20;

export interface TokenSampleInput {
  model: string;
  family?: string;
  text: string;
  usagePromptTokens: number;
}

export interface TokenSample {
  family: string;
  est: number;
  usage: number;
  ratio: number;
  at: number;
}

/** 最近一次记录（供断言/调试；校准本身以库为准） */
const recent: TokenSample[] = [];

/**
 * 推断 model family：剥掉日期/版本后缀。
 * `gpt-4o-2024-11-20` → `gpt-4o`；`claude-3-5-sonnet-20241022` → `claude-3-5-sonnet`。
 * 显式 `parameters.family` 优先 —— 推断规则不可能覆盖所有命名，让用户可以纠正。
 */
export function modelFamily(model: string, explicit?: string): string {
  if (explicit) return explicit;
  return model
    .replace(/-\d{8}$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .trim();
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 记录一条样本并**持久化**（I-24）。
 *
 * 自动调用，不靠手动记 —— 50–100 条手动记一定会漏。
 * 达到 `MIN_SAMPLES_FOR_FACTOR` 后回写系数：
 * `factor = 当前factor × 中位数`，让中位数回落到 1.0。
 */
export async function recordTokenSample(
  db: NarraDB | undefined,
  input: TokenSampleInput,
): Promise<TokenSample | undefined> {
  const est = estimateTokens(input.text);
  if (est <= 0 || input.usagePromptTokens <= 0) return undefined;

  const family = modelFamily(input.model, input.family);
  const ratio = input.usagePromptTokens / est;
  const sample: TokenSample = { family, est, usage: input.usagePromptTokens, ratio, at: Date.now() };

  recent.push(sample);
  if (recent.length > 500) recent.shift();

  if (db) {
    const existing = await db.calibration.get(family);
    const ratios = [...(existing?.ratios ?? []), ratio].slice(-MAX_SAMPLES_PER_FAMILY);
    const m = median(ratios);
    // 校准是渐进的：以当前系数为基准再乘一次中位数偏移，而不是直接用绝对中位数
    const base = existing?.factor ?? 1.2;
    const factor =
      ratios.length >= MIN_SAMPLES_FOR_FACTOR && Number.isFinite(m)
        ? Number((base * m).toFixed(3))
        : base;

    const now = Date.now();
    const wroteFactor = factor !== base; // 只有真的调整过才更新可追溯字段
    await db.calibration.put({
      id: family,
      family,
      ratios,
      factor,
      sampleCount: ratios.length,
      updatedAt: now,
      ...(wroteFactor
        ? { calibratedAtSampleCount: ratios.length, lastCalibratedAt: now }
        : existing
          ? { calibratedAtSampleCount: existing.calibratedAtSampleCount, lastCalibratedAt: existing.lastCalibratedAt }
          : {}),
    });
    setFactor(family, factor); // 立刻生效，不用等下次启动
  }

  return sample;
}

/** 启动时把持久化的系数灌进内存缓存 */
export async function loadFactors(db: NarraDB): Promise<Record<string, number>> {
  clearFactors();
  const rows = await db.calibration.toArray();
  for (const r of rows) setFactor(r.family, r.factor);
  return Object.fromEntries(rows.map((r) => [r.family, r.factor]));
}

export interface FamilyReport {
  family: string;
  count: number;
  medianRatio: number;
  factor: number;
  /** 是否已达可写回系数的样本量 */
  calibrated: boolean;
  /** 回写系数时的样本数 / 时间（可追溯） */
  calibratedAtSampleCount?: number;
  lastCalibratedAt?: number;
}

/** 按 family 的校准报告（读库，非内存） */
export async function calibrationReport(db: NarraDB): Promise<FamilyReport[]> {
  const rows = await db.calibration.toArray();
  return rows
    .map((r) => {
      const m = median(r.ratios);
      return {
        family: r.family,
        count: r.sampleCount,
        medianRatio: m,
        factor: r.factor,
        calibrated: r.sampleCount >= MIN_SAMPLES_FOR_FACTOR,
      };
    })
    .sort((a, b) => b.count - a.count);
}

/** 导出最近样本（供人工核对） */
export function dumpSamples(): TokenSample[] {
  return [...recent];
}

/** 测试用：清空内存侧 */
export function __resetSamples(): void {
  recent.length = 0;
}
