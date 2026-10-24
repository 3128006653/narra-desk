/**
 * 摘要视图（§5.8 / 不变量 #4）。
 *
 * 定案：写入侧零裁剪，摘要允许重叠存储；去重只发生在**注入时**。
 * 这样 coversTurnIds 永不说谎 —— 空洞计算、stale 判定都基于真实的覆盖区间。
 *
 * ⚠️ I-5：以下两条是**两条独立规则**，实现时不要合并：
 *   (a) discarded Turn 不计入 coveredSeqs / holes —— 这是**区间计算**（本文件的 activeSet 过滤）
 *   (b) truncate 使摘要 stale、stale 摘要不注入 —— 这是**注入谓词**（isActiveSummary / stale 字段）
 *   合并写会让「被 discard 的区间」和「被修订而待重建的区间」互相掩盖。
 *
 * ⚠️ I-6：重叠段「覆盖更大」按**覆盖 Turn 数**判定，**不按 span**（maxSeq - minSeq）。
 *   连续窗口下二者等价；非连续场景（重叠存储 + 部分 discard）会分歧，以 Turn 数为准。
 *
 *   判别用例见 tests/summary.test.ts 的 `disjoint-span` 组。注意能区分两种口径的用例
 *   必须同时满足：① 两摘要**相交**（不相交则都入选，排序不影响结果）；
 *   ② Turn 数排序与 span 排序**相反**（如 A={1..5} 5Turn/span4 vs B={1,20} 2Turn/span19）。
 *   该用例经变异验证：把下面改成 span 比较后它会红，组内其他用例仍绿。
 */
import type { SummaryView } from '../schema/entities';
import { GREETING_SEQ } from './turnStore';

/** v0.6.1：active 摘要 = status === 'ok'（枚举互斥，不再写「且非 superseded」） */
export function isActiveSummary(s: SummaryView): boolean {
  return s.status === 'ok';
}

/**
 * greeting（seq 0）**不参与摘要覆盖**（I-11）。
 * 它是 `first_mes` 静态资产的物化产物，摘要它没有意义；
 * 更实际的问题是它占掉一个 seq，会让每个窗口边界整体偏移一轮。
 *
 * ⚠️ 该约定必须**两处一致**：窗口规划（`planPendingWindows`）与空洞计算（指示器）。
 *    只改一处会出现「永远有 1 轮未覆盖」的幽灵空洞。
 *
 * ⚠️ **第三处防护（通用约定）**：任何「按 seq 遍历生成窗口 / 计算覆盖」的新功能，
 *    都必须调用本函数过滤，不要自己写 `seq > 0` —— 否则 greeting 语义一变就静默错。
 *    已知调用方：窗口规划（`planPendingWindows`）、空洞计算（`indicator`）。
 *    未来的向量窗口化、导出区间统计等同理。
 */
export function isSummarizable(seq: number): boolean {
  return seq !== GREETING_SEQ;
}

/**
 * 是否**可注入** = 状态 ok **且**不是 stub 产物（I-16）。
 *
 * 与 `isActiveSummary` 的分工：
 *   `isActiveSummary`     —— 只看状态枚举（I-5(b) 的注入谓词层）
 *   `isInjectableSummary` —— 再排除抽取式占位摘要
 * 组装器与指示器一律用后者；`isActiveSummary` 只留给「是否算一条有效记录」的判断。
 *
 * stub 摘要不注入、其区间转空洞 —— 与 stale 同一处理路径，
 * 差别只是 stale 等后台重建，stub 等真实 client 接入后扫描重建。
 */
export function isInjectableSummary(s: SummaryView): boolean {
  return isActiveSummary(s) && s.source !== 'stub';
}

/** 一个摘要窗口覆盖多少轮（占位值，实现期校准） */
export const DEFAULT_SUMMARY_WINDOW = 50;

export interface DedupeResult {
  /** 本次实际注入的摘要（按 seq 升序） */
  selected: SummaryView[];
  /** 已覆盖的 seq */
  coveredSeqs: number[];
  /** 未覆盖的 seq —— 即空洞区间，由组装器回退注入原始 Turn（K = min(20, 剩余预算)） */
  holes: number[];
}

/** 空洞计算：active 且未被任何注入摘要覆盖的 seq */
export function computeHoles(activeSeqs: number[], covered: Iterable<number>): number[] {
  const coveredSet = new Set(covered);
  return activeSeqs.filter((s) => !coveredSet.has(s)).sort((a, b) => a - b);
}

function seqsOf(
  s: SummaryView,
  seqOfTurn: Map<string, number>,
  activeSet: Set<number>,
): number[] {
  const out = s.coversTurnIds
    .map((id) => seqOfTurn.get(id))
    .filter((v): v is number => v !== undefined && activeSet.has(v));
  return out.length ? out : [Infinity];
}

/**
 * 注入时去重。
 * @param activeSeqs 当前会话内 active（非 discarded）Turn 的 seq 集合
 * @param seqOfTurn  turnId → seq
 */
export function dedupeSummariesForInjection(
  summaries: SummaryView[],
  activeSeqs: number[],
  seqOfTurn: Map<string, number>,
): DedupeResult {
  const activeSet = new Set(activeSeqs);

  // (a) I-5：discarded Turn 在此被过滤掉，不计入任何覆盖/空洞计算
  const candidates = summaries
    .filter(isActiveSummary)
    .map((summary) => ({
      summary,
      seqs: Array.from(
        new Set(
          summary.coversTurnIds
            .map((id) => seqOfTurn.get(id))
            .filter((s): s is number => s !== undefined && activeSet.has(s)),
        ),
      ).sort((a, b) => a - b),
    }))
    .filter((c) => c.seqs.length > 0);

  // I-6：先比覆盖 Turn 数（不是 span），同数取生成时间新者
  candidates.sort((a, b) => {
    if (b.seqs.length !== a.seqs.length) return b.seqs.length - a.seqs.length;
    return b.summary.createdAt - a.summary.createdAt;
  });

  const selected: SummaryView[] = [];
  const covered = new Set<number>();
  for (const c of candidates) {
    if (c.seqs.some((s) => covered.has(s))) continue; // 让位给覆盖更大者
    selected.push(c.summary);
    c.seqs.forEach((s) => covered.add(s));
  }

  selected.sort((a, b) => {
    const aMin = Math.min(...seqsOf(a, seqOfTurn, activeSet));
    const bMin = Math.min(...seqsOf(b, seqOfTurn, activeSet));
    return aMin - bMin;
  });

  return {
    selected,
    coveredSeqs: Array.from(covered).sort((a, b) => a - b),
    holes: computeHoles(activeSeqs, covered),
  };
}

export interface SummaryWindow {
  fromSeq: number;
  toSeq: number;
  turnIds: string[];
}

/**
 * 窗口规划：**写入侧零裁剪**，因此这里只按 seq 切连续窗口，
 * 不做任何与已有摘要的重叠比对 —— 重叠允许存在，去重交给注入时。
 *
 * 已覆盖的区间由调用方自行跳过（生成前查 status==='ok' 的 coversTurnIds）。
 */
export function planSummaryWindows(
  activeTurns: Array<{ id: string; seq: number }>, // 按 seq 升序
  windowSize = DEFAULT_SUMMARY_WINDOW,
): SummaryWindow[] {
  const sorted = activeTurns.slice().sort((a, b) => a.seq - b.seq);
  const windows: SummaryWindow[] = [];
  for (let i = 0; i < sorted.length; i += windowSize) {
    const chunk = sorted.slice(i, i + windowSize);
    windows.push({
      fromSeq: chunk[0].seq,
      toSeq: chunk[chunk.length - 1].seq,
      turnIds: chunk.map((t) => t.id),
    });
  }
  return windows;
}

/**
 * 判断某窗口是否「已被 ok 摘要覆盖」——用于后台任务决定是否值得重新生成。
 * 完全覆盖 → 跳过；部分/未覆盖 → 生成（写入侧仍零裁剪）。
 */
export function windowCoverage(
  window: SummaryWindow,
  okSummaries: SummaryView[],
): 'full' | 'partial' | 'none' {
  const wanted = new Set(window.turnIds);
  let hit = 0;
  for (const s of okSummaries) {
    for (const id of s.coversTurnIds) if (wanted.has(id)) hit += 1;
  }
  if (hit === 0) return 'none';
  return hit >= wanted.size ? 'full' : 'partial';
}
