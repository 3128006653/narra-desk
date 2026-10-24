import { describe, expect, it } from 'vitest';
import {
  HOLE_FALLBACK_MAX_TURNS,
  Tier,
  assembleBudget,
  factBlocks,
  selectHoleFallbackTurns,
  type BudgetBlock,
} from '../src/domain/assemble';
import {
  injectedCount,
  selectFactsForInjection,
  trimFactsForBudget,
} from '../src/domain/factInjection';
import type { FactView } from '../src/schema/entities';
import { estimateTokens, usableBudget } from '../src/domain/tokenEst';

function block(over: Partial<BudgetBlock> & { id: string; text: string }): BudgetBlock {
  return { tier: Tier.SystemPrompt, trimmable: false, ...over };
}

/** 生成恰好 n token 的纯拉丁文本（1 token = 4 字符 × 1.2 → 3.34 字符/token） */
function latinText(tokens: number): string {
  return 'a'.repeat(Math.ceil((tokens / 1.2) * 4));
}

describe('token 估算（§5.9 显式公式）', () => {
  it('纯英文不被 CJK 系数高估', () => {
    // latinText(1000) ≈ 3334 个 ASCII 字符 → 基线 833.5 → ×1.2 ≈ 1000
    expect(estimateTokens(latinText(1000))).toBeCloseTo(1000, -1);
    // 关键回归：若实现成「字符数 × 1.2」，这里会是约 4000
    expect(estimateTokens(latinText(1000))).toBeLessThan(1100);
    const naive = latinText(1000).length * 1.2;
    expect(naive).toBeGreaterThan(3900); // 这就是被排除掉的错误实现
  });

  it('中文按每字约 1.2 token 计', () => {
    const est = estimateTokens('你'.repeat(1000));
    expect(est).toBe(1200);
  });

  it('emoji 按 0.25 基线计，不因 surrogate 翻倍', () => {
    // 😀 是 1 个码点（2 个 UTF-16 单元）；若按 length 迭代会计 2
    expect(estimateTokens('😀')).toBe(Math.ceil(0.25 * 1.2));
  });

  it('预算扣 10% 余量', () => {
    expect(usableBudget(1000)).toBe(900);
  });
});

describe('assembleBudget：裁剪顺序（§5.9）', () => {
  const base = [
    block({ id: 'sys', tier: Tier.SystemPrompt, text: latinText(50), trimmable: false }),
    block({ id: 'personality', tier: Tier.CoreAsset, text: latinText(50), trimmable: false }),
    block({ id: 'desc', tier: Tier.CoreAsset, text: latinText(50), trimmable: true, partial: true, trimKey: 99 }),
    block({ id: 'lore-lo', tier: Tier.Lorebook, text: latinText(50), trimmable: true, trimKey: 1 }),
    block({ id: 'lore-hi', tier: Tier.Lorebook, text: latinText(50), trimmable: true, trimKey: 9 }),
    block({ id: 'sum', tier: Tier.Summary, text: latinText(50), trimmable: true, trimKey: 1 }),
    block({ id: 'mese', tier: Tier.MesExample, text: latinText(50), trimmable: true, partial: true }),
    block({ id: 'vec', tier: Tier.Vector, text: latinText(50), trimmable: true }),
    block({ id: 'user', tier: Tier.UserInput, text: latinText(50), trimmable: false }),
  ];

  it('预算充足时全保留', () => {
    const r = assembleBudget({ blocks: base, contextLimit: 2000 });
    expect(r.dropped).toEqual([]);
    expect(r.exhausted).toBe(false);
  });

  it('先裁向量召回，再裁低 insertion_order 的 lorebook', () => {
    // 9 块 × 50 token = 450；contextLimit 400 → 预算 360 → 需裁掉 2 块
    const r = assembleBudget({ blocks: base, contextLimit: 400 });
    expect(r.dropped).toContain('vec');
    expect(r.dropped).toContain('lore-lo');
    expect(r.dropped).not.toContain('lore-hi'); // 高 insertion_order 后掉
  });

  it('FactView 裁剪步落在 lorebook 之后、摘要之前', () => {
    const blocks = [
      block({ id: 'sys', tier: Tier.SystemPrompt, text: latinText(50), trimmable: false }),
      block({ id: 'lore', tier: Tier.Lorebook, text: latinText(100), trimmable: true, trimKey: 1 }),
      block({ id: 'fact', tier: Tier.Fact, text: latinText(100), trimmable: true, trimGroup: 0 }),
      block({ id: 'sum', tier: Tier.Summary, text: latinText(100), trimmable: true, trimKey: 1 }),
    ];
    // 总 350；contextLimit 200 → 预算 180 → 裁 lore(100) 后剩 250 仍超，再裁 fact(100) → 150 ✓
    const r = assembleBudget({ blocks, contextLimit: 200 });
    expect(r.dropped).toEqual(['lore', 'fact']);
    expect(r.dropped).not.toContain('sum'); // 摘要比事实更晚被裁
  });

  it('mes_example 支持部分截断而非整块丢弃', () => {
    const blocks = [
      block({ id: 'sys', tier: Tier.SystemPrompt, text: latinText(50), trimmable: false }),
      block({ id: 'mese', tier: Tier.MesExample, text: latinText(300), trimmable: true, partial: true }),
    ];
    const r = assembleBudget({ blocks, contextLimit: 300 });
    expect(r.dropped).toEqual([]);
    expect(r.truncated.map((t) => t.id)).toEqual(['mese']);
    expect(r.usedTokens).toBeLessThanOrEqual(r.budgetTokens);
  });

  it('personality / scenario 不可裁剪；裁到头给出提示而非静默牺牲人设', () => {
    const blocks = [
      block({ id: 'personality', tier: Tier.CoreAsset, text: latinText(500), trimmable: false }),
      block({ id: 'scenario', tier: Tier.CoreAsset, text: latinText(500), trimmable: false }),
    ];
    const r = assembleBudget({ blocks, contextLimit: 100 });
    expect(r.dropped).toEqual([]);
    expect(r.exhausted).toBe(true);
    expect(r.hint).toContain('建议缩减 lorebook 或开启新会话');
  });

  it('最近 N 轮与用户输入不在裁剪序列内', () => {
    const blocks = [
      block({ id: 'recent', tier: Tier.RecentTurns, text: latinText(500), trimmable: false }),
      block({ id: 'user', tier: Tier.UserInput, text: latinText(500), trimmable: false }),
    ];
    const r = assembleBudget({ blocks, contextLimit: 100 });
    expect(r.dropped).toEqual([]);
    expect(r.exhausted).toBe(true);
  });
});

describe('FactView → BudgetBlock：pin 豁免预算裁剪', () => {
  function mk(over: Partial<FactView> & { id: string }): FactView {
    return {
      sessionId: 's1',
      scope: 'global',
      characterId: '',
      key: 'k',
      value: 'v',
      confidence: 'confirmed',
      injectionState: 'active',
      origin: 'user_manual',
      riskLevel: 'low',
      pinned: false,
      lastSeenTurn: 0,
      stale: false,
      sourceTurnIds: [],
      sourceRevisionIds: [],
      updatedAt: 0,
      ...over,
    } as FactView;
  }

  it('proposed 最先被裁（trimGroup 0），未 pin 的 confirmed/auto 次之，pin 不参与', () => {
    const sel = selectFactsForInjection([
      mk({ id: 'p0', confidence: 'proposed' }),
      mk({ id: 'c0', confidence: 'confirmed' }),
      mk({ id: 'pin0', confidence: 'confirmed', pinned: true }),
    ]);
    const blocks = factBlocks(sel);
    expect(blocks.find((b) => b.id === 'fact:p0')?.trimGroup).toBe(0);
    expect(blocks.find((b) => b.id === 'fact:c0')?.trimGroup).toBe(1);
    expect(blocks.find((b) => b.id === 'fact:pin0')?.trimmable).toBe(false);
  });

  it('极端窄预算下 pin 仍在注入列表内', () => {
    const facts = Array.from({ length: 10 }, (_, i) =>
      mk({ id: `x${i}`, key: `k${i}`, pinned: i < 3, pinnedAt: i, lastSeenTurn: i }),
    );
    const sel = selectFactsForInjection(facts);
    const kept = trimFactsForBudget(sel, 1);
    expect(kept.every((f) => f.pinned)).toBe(true);
    expect(kept).toHaveLength(3);
  });

  it('条数预截断与预算裁剪是两层：预截断先到 45 上限', () => {
    const facts: FactView[] = [];
    for (let i = 0; i < 40; i++) facts.push(mk({ id: `c${i}`, key: `ck${i}`, confidence: 'confirmed' }));
    for (let i = 0; i < 8; i++)
      facts.push(mk({ id: `pin${i}`, key: `pk${i}`, pinned: true, pinnedAt: i }));
    for (let i = 0; i < 12; i++) facts.push(mk({ id: `pp${i}`, key: `ppk${i}`, confidence: 'proposed' }));
    const sel = selectFactsForInjection(facts);
    expect(injectedCount(sel)).toBe(45);

    // 再进预算裁剪：只留 35 块的预算 → 掉 10 块，且必须全是 proposed
    const blocks = factBlocks(sel);
    const total = blocks.reduce((s, b) => s + estimateTokens(b.text), 0);
    const keepTarget = total * (35 / 45);
    const r = assembleBudget({ blocks, contextLimit: Math.ceil(keepTarget / 0.9) });
    expect(r.dropped.length).toBeGreaterThan(0);
    expect(r.dropped.length).toBeLessThanOrEqual(10); // 不会动到 confirmed/auto
    expect(r.dropped.every((d) => sel.proposed.some((f) => `fact:${f.id}` === d))).toBe(true);
    // pin 一块都没掉
    expect(r.dropped.some((d) => sel.pinned.some((f) => `fact:${f.id}` === d))).toBe(false);
  });
});

describe('空洞回退（§5.8）：K = min(20, 剩余预算)', () => {
  const turns = Array.from({ length: 50 }, (_, i) => ({ seq: i + 1, tokens: 10 }));

  it('最多取 20 轮，且取最近（seq 最大）的', () => {
    const r = selectHoleFallbackTurns(turns, (t) => t.tokens, 10_000);
    expect(r.selected).toHaveLength(HOLE_FALLBACK_MAX_TURNS);
    expect(r.selected[0].seq).toBe(31); // 最近的 20 轮 = 31..50
    expect(r.selected[r.selected.length - 1].seq).toBe(50);
    expect(r.uncoveredCount).toBe(30); // 指示器「仍有 30 轮未覆盖」
  });

  it('预算不足时按预算截断，并如实上报未覆盖轮数', () => {
    const r = selectHoleFallbackTurns(turns, (t) => t.tokens, 50);
    expect(r.selected).toHaveLength(5);
    expect(r.uncoveredCount).toBe(45);
  });

  it('空洞比上限小时全取，uncovered = 0', () => {
    const small = turns.slice(0, 8);
    const r = selectHoleFallbackTurns(small, (t) => t.tokens, 10_000);
    expect(r.selected).toHaveLength(8);
    expect(r.uncoveredCount).toBe(0);
  });
});
