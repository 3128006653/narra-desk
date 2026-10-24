/**
 * FactView 写路径（阶段四第 1/4 步）。
 *
 * 重点不是「能写进去」，而是那三条**容易写错**的规则：
 *  - 变更检测基准只取 active（否则 expired 同值复现被抑制 → 永久静默丢失）
 *  - 同 key 至多保留最近 1 条 inactive
 *  - 注入态唯一性「最终至多一条」，不要求写入失败
 */
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { openForTest } from '../src/schema/db';
import {
  LOW_EXPIRE_TURNS,
  PROPOSED_ARCHIVE_TURNS,
  confirmFact,
  correctFact,
  disputeFact,
  listProposed,
  sweepFactLifecycle,
  writeFact,
} from '../src/domain/factStore';
import { injectedCount, isInjectableFact, selectFactsForInjection } from '../src/domain/factInjection';
import { riskLevelOf } from '../src/domain/factNamespace';
import type { FactView } from '../src/schema/entities';

async function mkSession(db: Awaited<ReturnType<typeof openForTest>>) {
  const { createSession } = await import('../src/domain/turnStore');
  return createSession(db, {
    characterId: 'c1',
    title: 't',
    modelBinding: { main: { id: 's', model: 'm' } },
    greetingAssetId: 'a',
    greetingContent: 'hi',
  });
}

const BASE = {
  scope: 'global' as const,
  key: 'location.current',
  value: '钟楼',
  confidence: 'confirmed' as const,
  origin: 'user_manual' as const,
  lastSeenTurn: 1,
  sourceTurnIds: [],
  sourceRevisionIds: [],
};

describe('写路径事务：注入态唯一性（不变量 #6）', () => {
  it('连续两次写入同 key → 至多一条 active，旧行 inactive + superseded', async () => {
    const db = await openForTest(`f-${Math.random()}`);
    const s = await mkSession(db);
    const a = await writeFact(db, { ...BASE, sessionId: s.id });
    const b = await writeFact(db, { ...BASE, sessionId: s.id, value: '码头', lastSeenTurn: 2 });

    const actives = await db.facts
      .where('[sessionId+scope+characterId+key+injectionState]')
      .equals([s.id, 'global', '', 'location.current', 'active'])
      .toArray();
    expect(actives).toHaveLength(1);
    expect(actives[0].value).toBe('码头'); // 新值胜出
    const loser = (await db.facts.get(a.fact.id))!;
    expect(loser.injectionState).toBe('inactive');
    expect(loser.inactiveReason).toBe('superseded');
    expect(b.supersededId).toBe(a.fact.id);
  });

  it('验收语义是「最终至多一条 active」，不要求写入失败 —— 两次都成功', async () => {
    const db = await openForTest(`f-${Math.random()}`);
    const s = await mkSession(db);
    const a = await writeFact(db, { ...BASE, sessionId: s.id });
    const b = await writeFact(db, { ...BASE, sessionId: s.id, value: '码头' });
    // 两条都写入成功（没有抛错），靠降级保证唯一性
    expect(a.fact.id).not.toBe(b.fact.id);
    expect((await db.facts.toArray()).filter((f) => f.injectionState === 'active')).toHaveLength(1);
  });
});

describe('变更检测：基准只取 active（否则 expired 永久无法复活）', () => {
  it('同值同 confidence 不产生新行，只刷新 lastSeenTurn', async () => {
    const db = await openForTest(`f-${Math.random()}`);
    const s = await mkSession(db);
    const a = await writeFact(db, { ...BASE, sessionId: s.id });
    const b = await writeFact(db, { ...BASE, sessionId: s.id, lastSeenTurn: 9 });

    expect(b.unchanged).toBe(true);
    expect(b.fact.id).toBe(a.fact.id);
    expect((await db.facts.toArray())).toHaveLength(1);
    expect((await db.facts.get(a.fact.id))!.lastSeenTurn).toBe(9);
  });

  it('low 事实过期后同值复现：能重新写入 active 行（I-22 的核心回归）', async () => {
    const db = await openForTest(`f-${Math.random()}`);
    const s = await mkSession(db);
    // 关键：location.current 是 low
    expect(riskLevelOf('location.current')).toBe('low');

    const first = await writeFact(db, { ...BASE, sessionId: s.id, lastSeenTurn: 1 });
    // 推到过期
    await sweepFactLifecycle(db, s.id, 1 + LOW_EXPIRE_TURNS + 1);
    const expired = (await db.facts.get(first.fact.id))!;
    expect(expired.injectionState).toBe('inactive');
    expect(expired.inactiveReason).toBe('expired');
    expect(isInjectableFact(expired)).toBe(false);

    // 剧情回到钟楼：同值复现必须能写回 active —— 若变更检测把 inactive 算进基准，
    // 这里会被抑制，事实永久消失（本用例就是钉住这条）
    const again = await writeFact(db, { ...BASE, sessionId: s.id, lastSeenTurn: 60 });
    expect(again.unchanged).toBe(false); // 没有 active 行可比对 → 必须新建
    expect(again.fact.injectionState).toBe('active');
    expect(isInjectableFact(again.fact)).toBe(true);
  });

  it('confidence 升级（proposed → confirmed）即使值相同也产生新行', async () => {
    const db = await openForTest(`f-${Math.random()}`);
    const s = await mkSession(db);
    const p = await writeFact(db, { ...BASE, sessionId: s.id, confidence: 'proposed', origin: 'model_proposed' });
    const c = await writeFact(db, { ...BASE, sessionId: s.id, lastSeenTurn: 2 });
    expect(c.unchanged).toBe(false);
    expect(c.supersededId).toBe(p.fact.id);
  });
});

describe('同 key 至多保留最近 1 条 inactive（FactView 不是审计日志）', () => {
  it('连续改写 4 次后，inactive 行只剩最近 1 条', async () => {
    const db = await openForTest(`f-${Math.random()}`);
    const s = await mkSession(db);
    for (let i = 0; i < 5; i++) {
      await writeFact(db, { ...BASE, sessionId: s.id, value: `v${i}`, lastSeenTurn: i });
    }
    const rows = await db.facts.toArray();
    const inactive = rows.filter((r) => r.injectionState === 'inactive');
    expect(inactive).toHaveLength(1);
    expect(inactive[0].value).toBe('v3'); // 倒数第二次的值，最近被取代的那条
    expect(rows.filter((r) => r.injectionState === 'active')).toHaveLength(1);
  });
});

describe('riskLevel 命名空间', () => {
  it('未注册 key 默认 high（保守方向）', () => {
    expect(riskLevelOf('totally.unknown.namespace')).toBe('high');
  });
  it('最长前缀匹配：location.current.extra 仍归 low', () => {
    expect(riskLevelOf('location.current.extra')).toBe('low');
    expect(riskLevelOf('relationship.x')).toBe('high');
    expect(riskLevelOf('goal.longterm.x')).toBe('medium');
  });
});

describe('确认 / 纠错 / 改写', () => {
  it('确认 proposed → confirmed，且注入态保持 active', async () => {
    const db = await openForTest(`f-${Math.random()}`);
    const s = await mkSession(db);
    const p = await writeFact(db, {
      ...BASE, sessionId: s.id, confidence: 'proposed', origin: 'model_proposed',
      key: 'promise.keep', // high
    });
    expect(p.fact.riskLevel).toBe('high');
    const c = await confirmFact(db, p.fact.id, 5);
    expect(c.confidence).toBe('confirmed');
    expect(c.injectionState).toBe('active');
    expect(c.origin).toBe('user_confirm');
    expect(isInjectableFact(c)).toBe(true);
  });

  it('纠错：disputed 立即停注入', async () => {
    const db = await openForTest(`f-${Math.random()}`);
    const s = await mkSession(db);
    const f = await writeFact(db, { ...BASE, sessionId: s.id });
    const d = await disputeFact(db, f.fact.id);
    expect(d.injectionState).toBe('inactive');
    expect(d.inactiveReason).toBe('disputed');
    expect(isInjectableFact(d)).toBe(false);
  });

  it('改写：新行 confirmed，旧行记 correction', async () => {
    const db = await openForTest(`f-${Math.random()}`);
    const s = await mkSession(db);
    const f = await writeFact(db, { ...BASE, sessionId: s.id });
    const fixed = await correctFact(db, f.fact.id, '旧城区', 7, '用户纠正');
    expect(fixed.value).toBe('旧城区');
    const old = (await db.facts.get(f.fact.id))!;
    expect(old.injectionState).toBe('inactive');
    expect(old.correction?.previousValue).toBe('钟楼');
  });
});

describe('过期与归档（confidence 与 riskLevel 解耦）', () => {
  it('proposed 超 100 轮 → archived；不是 expired（未处理 ≠ 值失效）', async () => {
    const db = await openForTest(`f-${Math.random()}`);
    const s = await mkSession(db);
    const p = await writeFact(db, {
      ...BASE, sessionId: s.id, confidence: 'proposed', origin: 'model_proposed',
      key: 'promise.x', lastSeenTurn: 1,
    });
    const r = await sweepFactLifecycle(db, s.id, 1 + PROPOSED_ARCHIVE_TURNS + 1);
    expect(r.archived).toBe(1);
    expect(r.expired).toBe(0);
    expect((await db.facts.get(p.fact.id))!.inactiveReason).toBe('archived');
  });

  it('medium/high 的 confirmed 永不过期', async () => {
    const db = await openForTest(`f-${Math.random()}`);
    const s = await mkSession(db);
    const f = await writeFact(db, { ...BASE, sessionId: s.id, key: 'relationship.state', lastSeenTurn: 1 });
    const r = await sweepFactLifecycle(db, s.id, 10000);
    expect(r.expired).toBe(0);
    expect((await db.facts.get(f.fact.id))!.injectionState).toBe('active');
  });

  it('proposed 面板列表只看 active 的 proposed', async () => {
    const db = await openForTest(`f-${Math.random()}`);
    const s = await mkSession(db);
    await writeFact(db, { ...BASE, sessionId: s.id, confidence: 'proposed', origin: 'model_proposed' });
    expect(await listProposed(db, s.id)).toHaveLength(1);
    await sweepFactLifecycle(db, s.id, 500);
    expect(await listProposed(db, s.id)).toHaveLength(0);
  });
});

describe('有界注入（不变量 #7，与阶段二 assembleBudget 的交集）', () => {
  it('5 + 30 + 10 预截断：pin 额外配额，总上限 45', async () => {
    const db = await openForTest(`f-${Math.random()}`);
    const s = await mkSession(db);
    const facts: FactView[] = [];
    for (let i = 0; i < 40; i++) {
      const r = await writeFact(db, {
        ...BASE, sessionId: s.id, key: `confirmed.k${i}`, value: `v${i}`, lastSeenTurn: i,
      });
      facts.push(r.fact);
    }
    for (let i = 0; i < 15; i++) {
      const r = await writeFact(db, {
        ...BASE, sessionId: s.id, key: `proposed.k${i}`, confidence: 'proposed',
        origin: 'model_proposed', lastSeenTurn: i,
      });
      facts.push(r.fact);
    }
    for (let i = 0; i < 8; i++) {
      const r = await writeFact(db, {
        ...BASE, sessionId: s.id, key: `pin.k${i}`, lastSeenTurn: 100 + i,
      });
      await db.facts.update(r.fact.id, { pinned: true, pinnedAt: 1000 + i });
      facts.push((await db.facts.get(r.fact.id))!);
    }

    const sel = selectFactsForInjection(await db.facts.toArray());
    expect(sel.confirmedAuto.length).toBeLessThanOrEqual(30);
    expect(sel.proposed.length).toBeLessThanOrEqual(10);
    expect(sel.pinned.length).toBeLessThanOrEqual(5);
    expect(injectedCount(sel)).toBeLessThanOrEqual(45);
    // 超出部分必须可见（不静默丢失）
    expect(sel.overflow.length).toBeGreaterThan(0);
    // pin 是额外配额：8 条 pin 上限 5，且 pin 不占 confirmedAuto 的 30
    expect(sel.pinned).toHaveLength(5);
    expect(sel.confirmedAuto).toHaveLength(30);
  });
});
