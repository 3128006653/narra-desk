/**
 * 阶段四第 5 步：面板与纠错的 **domain 侧**行为。
 * UI 渲染本身不在测试范围（无 DOM），测的是面板依赖的那几条规则。
 */
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { openForTest } from '../src/schema/db';
import {
  bulkConfirm,
  bulkReject,
  confirmFact,
  correctFact,
  disputeFact,
  loadFactPanel,
  pinFact,
  sweepFactLifecycle,
  unpinFact,
  writeFact,
} from '../src/domain/factStore';
import { INJECTION_LIMITS, isInjectableFact, selectFactsForInjection } from '../src/domain/factInjection';
import { assembleTurnPrompt, factBlocks } from '../src/domain/assemble';

const dbn = () => `p-${Math.random()}`;

async function seed(db: Awaited<ReturnType<typeof openForTest>>) {
  const { createSession } = await import('../src/domain/turnStore');
  return createSession(db, {
    characterId: 'c1', title: 't',
    modelBinding: { main: { id: 's', model: 'm' } },
    greetingAssetId: 'a', greetingContent: 'hi',
  });
}

const B = {
  scope: 'global' as const, value: 'v', confidence: 'proposed' as const,
  origin: 'model_proposed' as const, lastSeenTurn: 1,
  sourceTurnIds: [] as string[], sourceRevisionIds: [] as string[],
};

describe('pin：满员拒绝，不自动替换', () => {
  it(`第 ${INJECTION_LIMITS.pin + 1} 条 pin 被拒绝并给出 limit-reached`, async () => {
    const db = await openForTest(dbn());
    const s = await seed(db);
    const ids: string[] = [];
    for (let i = 0; i < INJECTION_LIMITS.pin + 1; i++) {
      const r = await writeFact(db, { ...B, sessionId: s.id, key: `k${i}`, value: `v${i}` });
      ids.push(r.fact.id);
    }
    for (let i = 0; i < INJECTION_LIMITS.pin; i++) {
      const r = await pinFact(db, ids[i]);
      expect(r.ok).toBe(true);
    }
    const over = await pinFact(db, ids[INJECTION_LIMITS.pin]);
    // 拒绝而非替换：最早的 pin 仍生效，用户不会被静默换掉
    expect(over.ok).toBe(false);
    expect(over.reason).toBe('limit-reached');
    const panel = await loadFactPanel(db, s.id);
    // 按集合比较：IndexedDB 按主键返回，不保证插入顺序
    expect(new Set(panel.pinned.map((f) => f.id))).toEqual(new Set(ids.slice(0, INJECTION_LIMITS.pin)));
  });

  it('取消一条后可以 pin 新的', async () => {
    const db = await openForTest(dbn());
    const s = await seed(db);
    const a = await writeFact(db, { ...B, sessionId: s.id, key: 'a' });
    const b = await writeFact(db, { ...B, sessionId: s.id, key: 'b' });
    await pinFact(db, a.fact.id);
    await unpinFact(db, a.fact.id);
    expect((await pinFact(db, b.fact.id)).ok).toBe(true);
  });
});

describe('批量操作：默认不选，批量后只影响选中项', () => {
  it('批量确认只改传入的 id，其余仍为 proposed', async () => {
    const db = await openForTest(dbn());
    const s = await seed(db);
    const a = await writeFact(db, { ...B, sessionId: s.id, key: 'a' });
    const b = await writeFact(db, { ...B, sessionId: s.id, key: 'b' });
    const r = await bulkConfirm(db, [a.fact.id], 5);
    expect(r).toEqual({ confirmed: 1, skipped: 0 });
    expect((await db.facts.get(a.fact.id))!.confidence).toBe('confirmed');
    expect((await db.facts.get(b.fact.id))!.confidence).toBe('proposed');
  });

  it('默认不选 = 空集：不调用批量时 nothing happens', async () => {
    const db = await openForTest(dbn());
    const s = await seed(db);
    await writeFact(db, { ...B, sessionId: s.id, key: 'a' });
    // 模拟「打开面板但未点全选」：传入空数组
    expect(await bulkConfirm(db, [], 1)).toEqual({ confirmed: 0, skipped: 0 });
    const panel = await loadFactPanel(db, s.id);
    expect(panel.pending).toHaveLength(1);
  });

  it('批量忽略 → rejected，且不注入', async () => {
    const db = await openForTest(dbn());
    const s = await seed(db);
    const a = await writeFact(db, { ...B, sessionId: s.id, key: 'a' });
    await bulkReject(db, [a.fact.id]);
    const f = (await db.facts.get(a.fact.id))!;
    expect(f.inactiveReason).toBe('rejected');
    expect(isInjectableFact(f)).toBe(false);
  });
});

describe('面板分区：archived 与 expired 必须分开', () => {
  it('同一会话里两者分别归组，不混', async () => {
    const db = await openForTest(dbn());
    const s = await seed(db);
    // archived：proposed 超 100 轮未处理
    const p = await writeFact(db, { ...B, sessionId: s.id, key: 'promise.x', lastSeenTurn: 1 });
    // expired：low 事实 50 轮未复现
    const l = await writeFact(db, {
      ...B, sessionId: s.id, key: 'location.current', confidence: 'confirmed',
      origin: 'user_manual', lastSeenTurn: 1,
    });
    await sweepFactLifecycle(db, s.id, 200);
    const panel = await loadFactPanel(db, s.id);
    expect(panel.archived.map((f) => f.id)).toEqual([p.fact.id]);
    expect(panel.expired.map((f) => f.id)).toEqual([l.fact.id]);
    // 两组不相交
    expect(panel.archived.some((f) => panel.expired.includes(f))).toBe(false);
  });

  it('disputed 单独置顶（独立分组，不并入 archived/expired）', async () => {
    const db = await openForTest(dbn());
    const s = await seed(db);
    const f = await writeFact(db, { ...B, sessionId: s.id, key: 'a' });
    await disputeFact(db, f.fact.id);
    const panel = await loadFactPanel(db, s.id);
    expect(panel.disputed).toHaveLength(1);
    expect(panel.archived).toHaveLength(0);
    expect(panel.expired).toHaveLength(0);
  });
});

describe('纠错通路：disputed → 改写 → 新 confirmed 行', () => {
  it('改写后旧行记 correction，新行可注入', async () => {
    const db = await openForTest(dbn());
    const s = await seed(db);
    const f = await writeFact(db, { ...B, sessionId: s.id, key: 'a', value: '错值' });
    await confirmFact(db, f.fact.id, 3);
    const d = await disputeFact(db, f.fact.id);
    expect(isInjectableFact(d)).toBe(false);
    const fixed = await correctFact(db, f.fact.id, '对值', 4, '用户纠正');
    expect(isInjectableFact(fixed)).toBe(true);
    expect((await db.facts.get(f.fact.id))!.correction?.previousValue).toBe('错值');
  });
});

describe('assembleBudget 输出注入清单（disputed 入口的前置）', () => {
  it('injectedFactIds 是领域 id，不是块 id', async () => {
    const db = await openForTest(dbn());
    const s = await seed(db);
    const a = await writeFact(db, { ...B, sessionId: s.id, key: 'a', value: 'va' });
    const facts = await db.facts.where('sessionId').equals(s.id).toArray();
    const sel = selectFactsForInjection(facts);
    const r = assembleTurnPrompt({
      systemPrompt: 'sys', coreAssets: [], lorebook: [], recentTurns: [],
      summaries: [], facts: sel, holeFallback: [], userInput: 'u', contextLimit: 8000,
    });
    expect(r.injectedFactIds).toEqual([a.fact.id]);
    // 关键：不带 `fact:` 前缀 —— UI 拿到的是领域 id
    expect(r.injectedFactIds[0]).not.toMatch(/^fact:/);
  });

  it('预算不足时 droppedFactIds 记录被裁掉的事实（不静默丢失）', async () => {
    const db = await openForTest(dbn());
    const s = await seed(db);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await writeFact(db, {
        ...B, sessionId: s.id, key: `k${i}`,
        value: `这是一段足够长的事实内容用于把预算撑爆 ${i}`.repeat(6),
        lastSeenTurn: i,
      });
      ids.push(r.fact.id);
    }
    const facts = await db.facts.where('sessionId').equals(s.id).toArray();
    const sel = selectFactsForInjection(facts);
    const r = assembleTurnPrompt({
      systemPrompt: 'sys', coreAssets: [], lorebook: [], recentTurns: [],
      summaries: [], facts: sel, holeFallback: [], userInput: 'u', contextLimit: 120,
    });
    expect(r.droppedFactIds.length).toBeGreaterThan(0);
    const injected = new Set(r.injectedFactIds);
    expect(r.droppedFactIds.filter((id) => injected.has(id))).toEqual([]);
  });

  it('factBlocks 加前缀、finalizeResult 剥前缀，两方约定一致', async () => {
    const db = await openForTest(dbn());
    const s = await seed(db);
    const a = await writeFact(db, { ...B, sessionId: s.id, key: 'a' });
    const sel = selectFactsForInjection(await db.facts.where('sessionId').equals(s.id).toArray());
    const blocks = factBlocks(sel);
    expect(blocks.every((b) => b.id.startsWith('fact:'))).toBe(true);
    const r = assembleTurnPrompt({
      systemPrompt: '', coreAssets: [], lorebook: [], recentTurns: [],
      summaries: [], facts: sel, holeFallback: [], userInput: '', contextLimit: 8000,
    });
    expect(r.injectedFactIds).toContain(a.fact.id);
  });
});
