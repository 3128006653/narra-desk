/**
 * 后台任务指示器（§5.5 / §5.8 / 阶段二）。
 *
 * 设计目的只有一个：**让"记忆维护"变成可见但不打扰的状态**，而不是用户任务。
 * 所有数字都是「从存储现场算出来的」，不缓存 —— 缓存会与后台任务的写入竞争，
 * 而这类数字的量级（段数、轮数）查询成本远低于正确性代价。
 *
 * 两个必须显式暴露、绝不静默的数字：
 *  - `pendingSummaries`：N 段摘要待补（failed / pending / retrying）
 *  - `uncoveredTurns`：历史空洞过大时「仍有 M 轮未覆盖」
 *    承诺是**不静默**，不是不丢失 —— 长空洞下只保证最近 K 轮被看见，其余在此暴露。
 */
import type { NarraDB } from '../schema/db';
import type { BackgroundTask, SummaryView, Turn } from '../schema/entities';
import { selectHoleFallbackTurns } from './assemble';
import { computeHoles, isInjectableSummary, isSummarizable } from './summary';

export interface IndicatorState {
  /** 后台任务：运行中 / 失败（终态，需用户介入） */
  running: number;
  failedTasks: number;
  queued: number;
  /** 待补摘要段数（pending / retrying / failed） */
  pendingSummaries: number;
  /** 待重建段数（stale：源 Turn 被编辑） */
  staleSummaries: number;
  /** 空洞区间数（按连续段计，非轮数） */
  holeSegments: number;
  /** 空洞总轮数 */
  uncoveredTurns: number;
  /** 按 K = min(20, 剩余预算) 实际能回退的轮数 */
  fallbackTurns: number;
  /** 回退后仍未覆盖的轮数 —— 指示器显示「仍有 M 轮未覆盖」 */
  stillUncovered: number;
  staleFacts: number;
  pendingFacts: number;
}

const EMPTY: IndicatorState = {
  running: 0,
  failedTasks: 0,
  queued: 0,
  pendingSummaries: 0,
  staleSummaries: 0,
  holeSegments: 0,
  uncoveredTurns: 0,
  fallbackTurns: 0,
  stillUncovered: 0,
  staleFacts: 0,
  pendingFacts: 0,
};

/** 把散乱的 seq 压成连续段数：[1,2,3, 7, 9] → 3 段 */
export function countSegments(seqs: number[]): number {
  if (seqs.length === 0) return 0;
  const sorted = [...seqs].sort((a, b) => a - b);
  let seg = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) seg += 1;
  }
  return seg;
}

export interface IndicatorInput {
  /** 剩余 token 预算；用于算 K（不传则 fallbackTurns = 0） */
  remainingTokens?: number;
  /** 单轮 token 估算函数 */
  estOfTurn?: (t: Turn) => number;
  maxFallbackTurns?: number;
}

export async function computeIndicator(
  db: NarraDB,
  sessionId: string,
  input: IndicatorInput = {},
): Promise<IndicatorState> {
  const [turns, summaries, facts, tasks] = await Promise.all([
    db.turns.where('sessionId').equals(sessionId).toArray(),
    db.summaries.where('sessionId').equals(sessionId).toArray(),
    db.facts.where('sessionId').equals(sessionId).toArray(),
    db.tasks.where('sessionId').equals(sessionId).toArray(),
  ]);

  const seqOfTurn = new Map(turns.map((t) => [t.id, t.seq]));
  // greeting 不参与摘要覆盖（I-11），必须与 planPendingWindows 保持一致，
  // 否则会永远报出「仍有 1 轮未覆盖」的幽灵空洞。
  const activeSeqs = turns
    .filter((t) => t.status === 'active' && isSummarizable(t.seq))
    .map((t) => t.seq)
    .sort((a, b) => a - b);

  // 只有「可注入」摘要算已覆盖：pending/failed/stale 转空洞（§5.8），
  // stub 占位摘要同样转空洞（I-16）—— 伪摘要比没有摘要更糟。
  const covered = new Set<number>();
  for (const s of summaries) {
    if (!isInjectableSummary(s)) continue;
    for (const id of s.coversTurnIds) {
      const seq = seqOfTurn.get(id);
      if (seq !== undefined) covered.add(seq);
    }
  }

  const holes = computeHoles(activeSeqs, covered);
  const state: IndicatorState = { ...EMPTY };

  for (const t of tasks as BackgroundTask[]) {
    if (t.status === 'running') state.running += 1;
    else if (t.status === 'queued') state.queued += 1;
    else if (t.status === 'failed') state.failedTasks += 1;
  }

  for (const s of summaries as SummaryView[]) {
    if (s.status === 'pending' || s.status === 'retrying' || s.status === 'failed') {
      state.pendingSummaries += 1;
    } else if (s.status === 'stale') {
      state.staleSummaries += 1;
    }
  }

  state.holeSegments = countSegments(holes);
  state.uncoveredTurns = holes.length;
  state.staleFacts = facts.filter((f) => f.stale === true).length;
  state.pendingFacts = facts.filter((f) => f.confidence === 'proposed').length;

  // 空洞回退预览（§5.8）：K = min(20, 剩余预算)
  if (input.remainingTokens && input.remainingTokens > 0 && input.estOfTurn) {
    const holeTurns = turns
      .filter((t) => t.status === 'active' && holes.includes(t.seq))
      .sort((a, b) => a.seq - b.seq);
    const res = selectHoleFallbackTurns(
      holeTurns,
      input.estOfTurn,
      input.remainingTokens,
      input.maxFallbackTurns ?? 20,
    );
    state.fallbackTurns = res.selected.length;
    state.stillUncovered = res.uncoveredCount;
  } else {
    state.stillUncovered = holes.length;
  }

  return state;
}

/** 指示器文案：只在有事可报时输出，避免常驻噪音 */
export function formatIndicator(s: IndicatorState): string[] {
  const out: string[] = [];
  if (s.running > 0) out.push(`后台运行中 ${s.running}`);
  if (s.pendingSummaries > 0) out.push(`N 段摘要待补：${s.pendingSummaries}`);
  if (s.staleSummaries > 0) out.push(`待重建 ${s.staleSummaries}`);
  if (s.stillUncovered > 0) out.push(`仍有 ${s.stillUncovered} 轮未覆盖`);
  if (s.failedTasks > 0) out.push(`失败任务 ${s.failedTasks}（需手动重试）`);
  if (s.staleFacts > 0) out.push(`事实待复核 ${s.staleFacts}`);
  if (s.pendingFacts > 0) out.push(`待确认事实 ${s.pendingFacts}`);
  return out;
}
