/**
 * Prompt 组装器的预算裁剪（§5.9）—— **纯函数，不接模型、不碰 UI**。
 *
 * 分为两层，各管各的，不互相替代：
 *   1. **条数预截断**（不变量 #7）：pin ≤5 / confirmed-auto ≤30 / proposed ≤10，
 *      由 `selectFactsForInjection()` 完成（src/domain/factInjection.ts）。
 *   2. **token 预算裁剪**：本文件的 `assembleBudget()`。
 *
 * ⚠️ 裁剪顺序**不等于**注入优先级的逆序 —— §5.9 显式规定了独立顺序：
 *   向量召回 → 低 insertion_order 的 lorebook → **FactView** → 更早摘要区间
 *   → mes_example → 核心资产（仅 description 尾段）
 *   故这里用 TRIM_SEQUENCE 显式表达，不用 tier 的降序。
 *
 * ⚠️ 陷阱：`partial` 块（mes_example、description 尾段）**不参与整块丢弃**。
 *   spec 对它们是「截断」不是「丢弃」—— 若把它们并回整块丢弃循环，
 *   预算一紧就会整块消失（人设/示例全丢），而不是缩到合适长度。
 *   此 bug 曾被 tests/assemble.test.ts 的「mes_example 支持部分截断而非整块丢弃」捕获，
 *   重构时不要把 `!b.partial` 这个过滤条件删掉。
 */
import type { InjectionSelection } from './factInjection';
import {
  estimateTokens as defaultEstimate,
  truncateTail,
  usableBudget,
} from './tokenEst';

/** §5.9 注入优先级：数字越小越先注入 */
export const Tier = {
  SystemPrompt: 1,
  CoreAsset: 2,
  Lorebook: 3,
  RecentTurns: 4,
  Summary: 5,
  Fact: 6,
  HoleFallback: 7,
  Vector: 8,
  MesExample: 9,
  UserInput: 10,
} as const;
export type TierValue = (typeof Tier)[keyof typeof Tier];

/**
 * 预算裁剪顺序（§5.9 同步路径）。
 * 注意 RecentTurns / UserInput / SystemPrompt **不在其中** —— spec 没有授权裁剪它们。
 */
export const TRIM_SEQUENCE: readonly TierValue[] = [
  Tier.Vector,
  Tier.Lorebook,
  Tier.Fact,
  Tier.Summary,
  Tier.MesExample,
  Tier.CoreAsset,
];

export interface BudgetBlock {
  id: string;
  tier: TierValue;
  /** 参与 token 估算的文本 */
  text: string;
  /**
   * false = 不可裁剪区。用于：system prompt、personality、scenario、
   * 用户输入、最近 N 轮、**pin 的事实**（pin 豁免预算裁剪）。
   */
  trimmable: boolean;
  /** 同 tier 内分组，值越小越先被裁。FactView: 0=proposed, 1=未 pin 的 confirmed/auto, 2=pin */
  trimGroup?: number;
  /** 同组内排序键，升序，值越小越先被裁 */
  trimKey?: number;
  /** true = 支持尾部部分截断（mes_example、description 尾段）；false = 整块保留或整块丢 */
  partial?: boolean;
}

export interface AssembleBudgetInput {
  blocks: BudgetBlock[];
  /** 上下文上限（token），函数内部自行扣除 10% 余量 */
  contextLimit: number;
  estimate?: (text: string) => number;
}

export interface AssembleBudgetResult {
  /** 保留的块（含被部分截断的） */
  kept: BudgetBlock[];
  /**
   * **实际注入的 FactView id**（UI 层的 disputed 入口依赖它）。
   *
   * 为什么显式列出而不是让调用方自己从 `kept` 里按 tier 过滤：
   * 那要求调用方知道「Fact 块的 id == fact id」这个隐含约定。
   * 「这条消息注入了哪些事实」是 UI 的一等需求 —— 聊天界面要能逐条标记
   * 「这条不对」（§5.7 纠错通路），没有这张清单就无从下手。
   */
  injectedFactIds: string[];
  /** 因预算被裁掉的事实 id —— 面板显示「未注入」，不静默丢失 */
  droppedFactIds: string[];
  /** 被整块丢弃的 id */
  dropped: string[];
  /** 被尾部截断的块：id + 截断后文本 */
  truncated: Array<{ id: string; text: string }>;
  usedTokens: number;
  budgetTokens: number;
  /** 已裁到不能再裁仍超预算 —— 提示用户缩减 lorebook 或开新会话，不静默牺牲人设 */
  exhausted: boolean;
  hint?: string;
}

/** 空洞回退最多注入的原始 Turn 数（§5.8） */
export const HOLE_FALLBACK_MAX_TURNS = 20;
/** 摘要注入总量占比上限（§5.11） */
export const SUMMARY_BUDGET_RATIO = 0.2;

function trimRank(b: BudgetBlock): [number, number] {
  return [b.trimGroup ?? 0, b.trimKey ?? 0];
}

export function assembleBudget(input: AssembleBudgetInput): AssembleBudgetResult {
  const estimate = input.estimate ?? defaultEstimate;
  const budget = usableBudget(input.contextLimit);
  const blocks = input.blocks.map((b) => ({ ...b }));

  const estOf = (b: BudgetBlock) => estimate(b.text);
  const total = () => blocks.reduce((s, b) => s + estOf(b), 0);

  const dropped: string[] = [];
  let live = blocks.slice();

  if (live.reduce((s, b) => s + estOf(b), 0) <= budget) {
    return finalizeResult(live, dropped, [], total(), budget, false);
  }

  // ---- 整块丢弃：按 TRIM_SEQUENCE 逐个 tier，tier 内按 (trimGroup, trimKey) 升序 ----
  // ⚠️ partial 块（mes_example、description 尾段）不在此丢弃 —— spec 对它们是「截断」不是「丢弃」。
  for (const tier of TRIM_SEQUENCE) {
    const pool = live
      .filter((b) => b.tier === tier && b.trimmable && !b.partial)
      .sort((a, b) => {
        const [ag, ak] = trimRank(a);
        const [bg, bk] = trimRank(b);
        return ag - bg || ak - bk;
      });
    for (const victim of pool) {
      if (live.reduce((s, b) => s + estOf(b), 0) <= budget) break;
      live = live.filter((b) => b.id !== victim.id);
      dropped.push(victim.id);
    }
    if (live.reduce((s, b) => s + estOf(b), 0) <= budget) break;
  }

  // ---- 部分截断：mes_example → description 尾段 ----
  const truncated: Array<{ id: string; text: string }> = [];
  let used = live.reduce((s, b) => s + estOf(b), 0);
  if (used > budget) {
    const partialOrder = [Tier.MesExample, Tier.CoreAsset];
    for (const tier of partialOrder) {
      const pool = live
        .filter((b) => b.tier === tier && b.partial && b.trimmable)
        .sort((a, b) => (a.trimKey ?? 0) - (b.trimKey ?? 0)); // description 最后才动
      for (const b of pool) {
        used = live.reduce((s, x) => s + estOf(x), 0);
        if (used <= budget) break;
        const excess = used - budget;
        const target = Math.max(0, estOf(b) - excess);
        const cut = truncateTail(b.text, target, estimate);
        if (cut.length < b.text.length) {
          b.text = cut;
          truncated.push({ id: b.id, text: cut });
        }
      }
    }
  }

  used = live.reduce((s, b) => s + estOf(b), 0);
  const exhausted = used > budget;
  return finalizeResult(
    live,
    dropped,
    truncated,
    used,
    budget,
    exhausted,
    exhausted
      ? '当前上下文超出预算：已裁至不可裁剪区（personality/scenario/最近对话/pin 事实）。建议缩减 lorebook 或开启新会话。'
      : undefined,
  );
}

/** FactView 块 id 的前缀 —— `factBlocks()` 加，`finalizeResult()` 剥 */
export const FACT_BLOCK_PREFIX = 'fact:';

function finalizeResult(
  kept: BudgetBlock[],
  dropped: string[],
  truncated: Array<{ id: string; text: string }>,
  usedTokens: number,
  budgetTokens: number,
  exhausted: boolean,
  hint?: string,
): AssembleBudgetResult {
  // 事实块按 id 前缀识别，剥掉前缀还给 fact id —— 让 UI 拿到的是领域 id，不是块 id
  const strip = (id: string) => (id.startsWith(FACT_BLOCK_PREFIX) ? id.slice(FACT_BLOCK_PREFIX.length) : id);
  const isFact = (id: string) => id.startsWith(FACT_BLOCK_PREFIX);
  return {
    kept,
    injectedFactIds: kept.filter((b) => isFact(b.id)).map((b) => strip(b.id)),
    droppedFactIds: dropped.filter(isFact).map(strip),
    dropped,
    truncated,
    usedTokens,
    budgetTokens,
    exhausted,
    hint,
  };
}

/**
 * FactView → BudgetBlock（不变量 #7 + §5.9 第 3 步）。
 *
 * 裁剪分组：0=proposed（最先牺牲）、1=未 pin 的 confirmed/auto、2=pin。
 * **pin 的 trimmable=false —— pin 豁免预算裁剪**。
 * 理由：pin 是「用户显式标记的绝对核心」逃生门，若它也会被预算剪掉，
 * pin 机制直接失效，不变量 #7 的「不静默丢失」也守不住。
 */
export function factBlocks(sel: InjectionSelection): BudgetBlock[] {
  const toBlock = (f: { id: string; key: string; value: unknown; lastSeenTurn: number }, group: number, trimmable: boolean): BudgetBlock => ({
    id: `fact:${f.id}`,
    tier: Tier.Fact,
    text: `${f.key}: ${typeof f.value === 'string' ? f.value : JSON.stringify(f.value)}`,
    trimmable,
    trimGroup: group,
    trimKey: f.lastSeenTurn, // 最远（最小）的先掉
  });
  return [
    ...sel.proposed.map((f) => toBlock(f, 0, true)),
    ...sel.confirmedAuto.map((f) => toBlock(f, 1, true)),
    ...sel.pinned.map((f) => toBlock(f, 2, false)),
  ];
}

export interface HoleFallbackResult<T> {
  /** 实际注入的原始 Turn（按传入顺序，即 seq 升序） */
  selected: T[];
  /** 未能覆盖、只在指示器里显式暴露的轮数 */
  uncoveredCount: number;
}

/**
 * 空洞回退（§5.8）：取空洞区间内**最近** K 轮原始 Turn，K = min(20, 剩余预算)。
 *
 * 承诺是「**不静默**」，不是「不丢失」：长空洞下只保证最近 K 轮被看见，
 * 其余轮次通过 `uncoveredCount` 暴露到后台指示器（「仍有 M 轮未覆盖」）。
 */
export function selectHoleFallbackTurns<T>(
  turnsInHole: T[], // 必须按 seq 升序
  estOf: (t: T) => number,
  remainingTokens: number,
  maxTurns = HOLE_FALLBACK_MAX_TURNS,
): HoleFallbackResult<T> {
  const picked: T[] = [];
  let spent = 0;
  for (let i = turnsInHole.length - 1; i >= 0 && picked.length < maxTurns; i--) {
    const t = turnsInHole[i];
    const cost = estOf(t);
    if (spent + cost > remainingTokens) break;
    spent += cost;
    picked.push(t);
  }
  picked.reverse(); // 恢复 seq 升序
  return { selected: picked, uncoveredCount: turnsInHole.length - picked.length };
}


/**
 * 组装一整轮 prompt（供 UI / runtime 调用）。
 *
 * 只做「把各类候选变成块 → 交给 assembleBudget」，**不含业务逻辑**
 * —— 业务规则（哪些事实可注入、上限、排序）在 `factInjection` 里。
 */
export interface SimpleAssembleInput {
  systemPrompt: string;
  coreAssets: Array<{ id: string; text: string }>;
  lorebook: Array<{ id: string; text: string; insertionOrder: number }>;
  recentTurns: Array<{ id: string; text: string }>;
  summaries: Array<{ id: string; text: string }>;
  facts: InjectionSelection;
  holeFallback: Array<{ id: string; text: string }>;
  mesExample?: string;
  userInput: string;
  contextLimit: number;
}

export function assembleTurnPrompt(input: SimpleAssembleInput): AssembleBudgetResult {
  const blocks: BudgetBlock[] = [
    { id: 'system', tier: Tier.SystemPrompt, text: input.systemPrompt, trimmable: false },
    ...input.coreAssets.map((a) => ({
      id: a.id, tier: Tier.CoreAsset, text: a.text, trimmable: false,
    })),
    ...input.lorebook.map((l) => ({
      id: l.id, tier: Tier.Lorebook, text: l.text,
      trimmable: true, trimGroup: 0, trimKey: l.insertionOrder,
    })),
    ...input.recentTurns.map((t) => ({
      id: t.id, tier: Tier.RecentTurns, text: t.text, trimmable: false,
    })),
    ...input.summaries.map((s) => ({
      id: s.id, tier: Tier.Summary, text: s.text, trimmable: true, trimGroup: 0, trimKey: 0,
    })),
    ...factBlocks(input.facts),
    ...input.holeFallback.map((h) => ({
      id: h.id, tier: Tier.HoleFallback, text: h.text, trimmable: true, trimGroup: 0, trimKey: 0,
    })),
  ];
  if (input.mesExample) {
    blocks.push({
      id: 'mes_example', tier: Tier.MesExample, text: input.mesExample,
      trimmable: true, trimGroup: 0, trimKey: 0, partial: true,
    });
  }
  blocks.push({ id: 'user_input', tier: Tier.UserInput, text: input.userInput, trimmable: false });

  return assembleBudget({ blocks, contextLimit: input.contextLimit });
}

/** 把保留的块按 tier 顺序拼成最终 prompt 文本 */
export function renderPrompt(kept: BudgetBlock[]): string {
  return kept
    .slice()
    .sort((a, b) => a.tier - b.tier)
    .map((b) => b.text)
    .join('\n\n');
}
