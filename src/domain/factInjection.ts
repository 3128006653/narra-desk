/**
 * FactView 注入规则（不变量 #5 / #7 的落点）。
 *
 * 阶段一先把**纯函数**部分做完并测掉，阶段四只需补写路径（writeFact）与预算裁剪。
 * 这样 #5–#7 的 pending 断言在阶段四解除时，不会卡在排序/上限这类可提前验证的逻辑上。
 */
import type { FactView, RiskLevel } from '../schema/entities';

/** 有界注入上限（不变量 #7）：pin 为额外配额，总上限 45 */
export const INJECTION_LIMITS = {
  pin: 5,
  confirmedAuto: 30,
  proposed: 10,
} as const;

const RISK_WEIGHT: Record<RiskLevel, number> = { high: 3, medium: 2, low: 1 };

/**
 * 注入谓词（I-3 定案）：`injectionState === 'active' && !stale`。
 *
 * stale 是派生层重建标记，与 injectionState 正交：
 *   inactive  = 数据层生命周期结束（被覆盖/过期/归档/争议/否决）
 *   stale     = 源 Turn 被修订，重建完成后自动回到可注入
 */
export function isInjectableFact(f: FactView): boolean {
  return f.injectionState === 'active' && f.stale !== true;
}

/** 层内排序：riskLevel desc + lastSeenTurn desc */
function byRiskThenRecency(a: FactView, b: FactView): number {
  const w = RISK_WEIGHT[b.riskLevel] - RISK_WEIGHT[a.riskLevel];
  if (w !== 0) return w;
  return b.lastSeenTurn - a.lastSeenTurn;
}

/** pin 层排序：按 pin 时间升序；无 pinnedAt 时退化为 updatedAt */
function byPinOrder(a: FactView, b: FactView): number {
  return (a.pinnedAt ?? a.updatedAt) - (b.pinnedAt ?? b.updatedAt);
}

export interface InjectionSelection {
  pinned: FactView[];
  confirmedAuto: FactView[];
  proposed: FactView[];
  /** 因超限未注入的事实 id —— 面板可见，不静默丢失 */
  overflow: string[];
}

/**
 * 有界选择（不变量 #7 的预截断）。
 * 顺序：pin(≤5) → confirmed/auto(≤30) → proposed(≤10)。
 *
 * 注意：这是**条数预截断**，之后仍要进 §5.9 的统一预算裁剪；
 * 两层机制各管各的。预算裁剪序：proposed → 未 pin 的 confirmed/auto → **pin 豁免**。
 */
export function selectFactsForInjection(facts: FactView[]): InjectionSelection {
  const injectable = facts.filter(isInjectableFact);

  const pinned = injectable.filter((f) => f.pinned).sort(byPinOrder);
  const pinnedIds = new Set(pinned.map((f) => f.id));

  const confirmedAuto = injectable
    .filter((f) => !pinnedIds.has(f.id) && (f.confidence === 'confirmed' || f.confidence === 'auto'))
    .sort(byRiskThenRecency);

  const proposed = injectable
    .filter((f) => !pinnedIds.has(f.id) && f.confidence === 'proposed')
    .sort(byRiskThenRecency);

  const overflow: string[] = [];
  const take = (rows: FactView[], limit: number): FactView[] => {
    const kept = rows.slice(0, limit);
    rows.slice(limit).forEach((f) => overflow.push(f.id));
    return kept;
  };

  return {
    pinned: take(pinned, INJECTION_LIMITS.pin),
    confirmedAuto: take(confirmedAuto, INJECTION_LIMITS.confirmedAuto),
    proposed: take(proposed, INJECTION_LIMITS.proposed),
    overflow,
  };
}

/** 注入总条数（用于断言「总上限 45」） */
export function injectedCount(sel: InjectionSelection): number {
  return sel.pinned.length + sel.confirmedAuto.length + sel.proposed.length;
}

/**
 * 预算裁剪：按 §5.9 顺序丢弃 —— proposed → 未 pin 的 confirmed/auto → **pin 豁免**。
 * @returns 裁剪后仍保留的事实
 */
export function trimFactsForBudget(sel: InjectionSelection, keepCount: number): FactView[] {
  const kept = [...sel.pinned]; // pin 豁免预算裁剪，永远优先
  const rest = [...sel.confirmedAuto, ...sel.proposed];
  // 从最低优先级（proposed，数组尾部）开始丢
  const budget = Math.max(0, keepCount - kept.length);
  return [...kept, ...rest.slice(0, budget)];
}
