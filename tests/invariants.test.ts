/**
 * 七条不变量测试骨架（v0.6.1 / 阶段一随第一周提交）。
 *
 * #1–#4：阶段一可测，已实现真断言。
 * #5–#7：阶段四解除 skip —— 断言先写，可测性风险在骨架阶段暴露。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openForTest, type NarraDB } from '../src/schema/db';
import type { FactView, Session, SummaryView, VectorIndex } from '../src/schema/entities';
import { newId } from '../src/schema/ids';
import {
  injectedCount,
  isInjectableFact,
  selectFactsForInjection,
  trimFactsForBudget,
} from '../src/domain/factInjection';
import { writeFact } from '../src/domain/factStore';
import {
  amend,
  appendTurn,
  createSession,
  listTurns,
  regenerate,
  restoreDiscarded,
  retry,
  truncate,
} from '../src/domain/turnStore';
import { dedupeSummariesForInjection } from '../src/domain/summary';

let db: NarraDB;
let session: Session;

const BINDING = {
  main: { id: 'svc-1', model: 'gpt-x' },
} as Session['modelBinding'];

async function newSession(title = '测试会话') {
  return createSession(db, {
    characterId: 'char-1',
    title,
    modelBinding: BINDING,
    greetingAssetId: 'asset-greeting',
    greetingContent: '（开场白）',
  });
}

beforeEach(async () => {
  const name = `db-${newId('t').slice(0, 8)}-${Math.random().toString(36).slice(2)}`;
  db = await openForTest(name);
  session = await newSession();
});

// ------------------------------------------------------------------ #1

describe('不变量 #1：seq 单调递增、永不复用', () => {
  it('truncate 后继续写入，新 Turn 拿到新 seq，不复用被废弃的 seq', async () => {
    for (let i = 1; i <= 5; i++) {
      await appendTurn(db, session.id, { userContent: `u${i}`, assistantContent: `a${i}` });
    }
    // 截断到 3（4、5 变 discarded，但保留 seq）
    await truncate(db, session.id, 3);

    const after = await appendTurn(db, session.id, { userContent: 'u6', assistantContent: 'a6' });
    expect(after.turn.seq).toBe(6); // 不是 4

    const all = await listTurns(db, session.id);
    const seqs = all.map((t) => t.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // 无重复
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('DB 层 &[sessionId+seq] 唯一索引硬拦重复 seq', async () => {
    await appendTurn(db, session.id, { userContent: 'u1', assistantContent: 'a1' });
    const turns = await listTurns(db, session.id);
    const first = turns.find((t) => t.seq === 1)!;

    // 绕过领域层直接写库，验证唯一索引确实生效
    await expect(
      db.turns.add({
        id: 'turn-duplicate',
        sessionId: session.id,
        seq: 1,
        activeRevisionId: first.activeRevisionId,
        status: 'active',
        createdAt: Date.now(),
      }),
    ).rejects.toThrow();
  });

  it('不同会话可以使用相同 seq（唯一索引限定在 sessionId 内）', async () => {
    const other = await newSession('另一个会话');
    const a = await appendTurn(db, session.id, { userContent: 'u', assistantContent: 'a' });
    const b = await appendTurn(db, other.id, { userContent: 'u', assistantContent: 'a' });
    expect(a.turn.seq).toBe(b.turn.seq);
  });
});

// ------------------------------------------------------------------ #2

describe('不变量 #2：discard 只作用于 Turn，stale 只作用于派生物；amend 不产生 discard', () => {
  it('amend 后后续 Turn 原样保留，不 discard', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const r = await appendTurn(db, session.id, { userContent: `u${i}`, assistantContent: `a${i}` });
      ids.push(r.turn.id);
    }
    const before = await listTurns(db, session.id);

    const res = await amend(db, session.id, ids[1], { userContent: 'u2-改' });
    expect(res.discarded).toEqual([]);

    const after = await listTurns(db, session.id);
    expect(after.filter((t) => t.status === 'active').length).toBe(
      before.filter((t) => t.status === 'active').length,
    );
    expect(after.every((t) => t.status === 'active')).toBe(true);
  });

  it('amend 让覆盖该 Turn 的摘要变 stale，且摘要本身不被删除', async () => {
    const r2 = await appendTurn(db, session.id, { userContent: 'u2', assistantContent: 'a2' });
    const summaryId = newId('sum');
    await db.summaries.add({
      id: summaryId,
      sessionId: session.id,
      coversTurnIds: [r2.turn.id],
      content: '摘要内容',
      status: 'ok',
      retryCount: 0,
      sourceRevisionIds: [r2.revision.id],
      createdAt: Date.now(),
      source: 'model',
    } satisfies SummaryView);

    const res = await amend(db, session.id, r2.turn.id, { userContent: 'u2-改' });
    expect(res.stale.summaries).toContain(summaryId);

    const s = await db.summaries.get(summaryId);
    expect(s?.status).toBe('stale');
    expect(s?.staleReason).toBe('turn-edited');
  });

  it('amend 让源 Turn 的 FactView / VectorIndex 打上 stale，且不改 injectionState', async () => {
    const r2 = await appendTurn(db, session.id, { userContent: 'u2', assistantContent: 'a2' });
    await db.facts.add({
      id: 'fact-1',
      sessionId: session.id,
      scope: 'global',
      characterId: '', // 哨兵空串
      key: 'location.current',
      value: '钟楼',
      confidence: 'confirmed',
      injectionState: 'active',
      origin: 'user_manual',
      riskLevel: 'low',
      pinned: false,
      lastSeenTurn: r2.turn.seq,
      stale: false,
      sourceTurnIds: [r2.turn.id],
      sourceRevisionIds: [r2.revision.id],
      updatedAt: Date.now(),
    } satisfies FactView);
    await db.vectors.add({
      id: 'vec-1',
      sessionId: session.id,
      embedderServiceId: 'emb-1',
      sourceType: 'turn',
      sourceId: r2.turn.id,
      sourceRevisionId: r2.revision.id,
      vector: new Int8Array([1, 2, 3]),
      quantization: { scheme: 'int8', scale: 1 },
      stale: false,
      createdAt: Date.now(),
    } satisfies VectorIndex);

    const res = await amend(db, session.id, r2.turn.id, { userContent: 'u2-改' });
    expect(res.stale.facts).toContain('fact-1');
    expect(res.stale.vectors).toContain('vec-1');

    const f = await db.facts.get('fact-1');
    // I-3 核心：stale 是独立于 injectionState 的正交字段
    expect(f?.stale).toBe(true);
    expect(f?.staleReason).toBe('turn-amended');
    expect(f?.injectionState).toBe('active'); // 未被改成 inactive
    expect(isInjectableFact(f!)).toBe(false); // 但暂不注入

    const v = await db.vectors.get('vec-1');
    expect(v?.stale).toBe(true);
    expect(v?.staleReason).toBe('revision-changed');
  });

  it('truncate 的 staleReason 为 turn-truncated，与 amend 区分', async () => {
    const r1 = await appendTurn(db, session.id, { userContent: 'u1', assistantContent: 'a1' });
    const r2 = await appendTurn(db, session.id, { userContent: 'u2', assistantContent: 'a2' });
    await db.facts.add({
      id: 'fact-t',
      sessionId: session.id,
      scope: 'global',
      characterId: '',
      key: 'scene.weather',
      value: '雨',
      confidence: 'auto',
      injectionState: 'active',
      origin: 'auto_extracted',
      riskLevel: 'low',
      pinned: false,
      lastSeenTurn: r2.turn.seq,
      stale: false,
      sourceTurnIds: [r2.turn.id],
      sourceRevisionIds: [r2.revision.id],
      updatedAt: Date.now(),
    } satisfies FactView);

    await truncate(db, session.id, 1); // r2 discarded
    const f = await db.facts.get('fact-t');
    expect(f?.staleReason).toBe('turn-truncated');
    void r1;
  });

  it('regenerate 才 discard 后续 Turn', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const r = await appendTurn(db, session.id, { userContent: `u${i}`, assistantContent: `a${i}` });
      ids.push(r.turn.id);
    }
    const res = await regenerate(db, session.id, ids[1], 'a2-重新生成');
    expect(res.discarded).toHaveLength(2); // seq 3、4

    const after = await listTurns(db, session.id);
    expect(after.filter((t) => t.status === 'discarded').map((t) => t.seq)).toEqual([3, 4]);
  });
});

// ------------------------------------------------------------------ #3

describe('不变量 #3：恢复仅在截断后无新写入时可用', () => {
  it('无新写入时可整体恢复，时间线连续', async () => {
    for (let i = 1; i <= 4; i++) {
      await appendTurn(db, session.id, { userContent: `u${i}`, assistantContent: `a${i}` });
    }
    await truncate(db, session.id, 2);

    const res = await restoreDiscarded(db, session.id);
    expect(res).toEqual({ ok: true, restored: 2 });

    const after = await listTurns(db, session.id);
    expect(after.every((t) => t.status === 'active')).toBe(true);
    expect(after.map((t) => t.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it('已有新写入时废弃分支只读，恢复失败', async () => {
    for (let i = 1; i <= 4; i++) {
      await appendTurn(db, session.id, { userContent: `u${i}`, assistantContent: `a${i}` });
    }
    await truncate(db, session.id, 2);
    await appendTurn(db, session.id, { userContent: '新分支', assistantContent: '新回复' });

    const res = await restoreDiscarded(db, session.id);
    expect(res).toEqual({ ok: false, reason: 'branch-readonly' });

    const branch = await listTurns(db, session.id);
    expect(branch.filter((t) => t.status === 'discarded').map((t) => t.seq)).toEqual([3, 4]);
  });
});

// ------------------------------------------------------------------ #4

describe('不变量 #4：摘要允许重叠存储，去重只发生在注入时', () => {
  it('重叠摘要在注入时只取其一，不重复发送同一段剧情', async () => {
    const t1 = await appendTurn(db, session.id, { userContent: 'u1', assistantContent: 'a1' });
    const t2 = await appendTurn(db, session.id, { userContent: 'u2', assistantContent: 'a2' });
    const t3 = await appendTurn(db, session.id, { userContent: 'u3', assistantContent: 'a3' });

    const base = Date.now();
    await db.summaries.bulkAdd([
      {
        id: 'sum-wide',
        sessionId: session.id,
        coversTurnIds: [t1.turn.id, t2.turn.id, t3.turn.id], // 覆盖 3 轮
        content: '宽摘要',
        status: 'ok',
        retryCount: 0,
        sourceRevisionIds: [],
        createdAt: base,
        source: 'model',
      },
      {
        id: 'sum-narrow',
        sessionId: session.id,
        coversTurnIds: [t2.turn.id], // 与宽摘要重叠
        content: '窄摘要',
        status: 'ok',
        retryCount: 0,
        sourceRevisionIds: [],
        createdAt: base + 1,
        source: 'model',
      },
    ] satisfies SummaryView[]);

    const seqOfTurn = new Map(
      [t1, t2, t3].map((r) => [r.turn.id, r.turn.seq] as [string, number]),
    );
    const res = dedupeSummariesForInjection(
      await db.summaries.where('sessionId').equals(session.id).toArray(),
      [0, t1.turn.seq, t2.turn.seq, t3.turn.seq],
      seqOfTurn,
    );

    expect(res.selected.map((s) => s.id)).toEqual(['sum-wide']);
    expect(res.selected).toHaveLength(1);
    expect(res.holes).toContain(0); // greeting 未被覆盖 → 空洞
  });

  it('被 discard 的 Turn 不计入已覆盖区间，也不算空洞', async () => {
    const t1 = await appendTurn(db, session.id, { userContent: 'u1', assistantContent: 'a1' });
    const t2 = await appendTurn(db, session.id, { userContent: 'u2', assistantContent: 'a2' });
    const t3 = await appendTurn(db, session.id, { userContent: 'u3', assistantContent: 'a3' });
    await db.summaries.add({
      id: 'sum-1',
      sessionId: session.id,
      coversTurnIds: [t1.turn.id, t2.turn.id, t3.turn.id],
      content: '摘要',
      status: 'ok',
      retryCount: 0,
      sourceRevisionIds: [],
      createdAt: Date.now(),
      source: 'model',
    } satisfies SummaryView);

    // 直接把 t2 置为 discarded（模拟更早的截断，且摘要此后已重建为 ok）
    await db.turns.update(t2.turn.id, { status: 'discarded' });

    const seqOfTurn = new Map(
      [t1, t2, t3].map((r) => [r.turn.id, r.turn.seq] as [string, number]),
    );
    const active = (await listTurns(db, session.id))
      .filter((t) => t.status === 'active')
      .map((t) => t.seq);
    const res = dedupeSummariesForInjection(
      await db.summaries.where('sessionId').equals(session.id).toArray(),
      active,
      seqOfTurn,
    );

    // discarded 的 seq 2 既不算已覆盖，也不应被报成空洞
    expect(res.coveredSeqs).toEqual([1, 3]);
    expect(res.holes).toEqual([0]);
    expect(res.coveredSeqs).not.toContain(2);
    expect(res.holes).not.toContain(2);
  });

  it('truncate 使覆盖被废弃 Turn 的摘要变 stale，stale 摘要不注入', async () => {
    const t1 = await appendTurn(db, session.id, { userContent: 'u1', assistantContent: 'a1' });
    const t2 = await appendTurn(db, session.id, { userContent: 'u2', assistantContent: 'a2' });
    await db.summaries.add({
      id: 'sum-1',
      sessionId: session.id,
      coversTurnIds: [t1.turn.id, t2.turn.id],
      content: '摘要',
      status: 'ok',
      retryCount: 0,
      sourceRevisionIds: [],
      createdAt: Date.now(),
      source: 'model',
    } satisfies SummaryView);

    await truncate(db, session.id, 1); // t2 discarded → 摘要 stale

    const s = await db.summaries.get('sum-1');
    expect(s?.status).toBe('stale');
    expect(s?.staleReason).toBe('turn-discarded');

    const seqOfTurn = new Map(
      [t1, t2].map((r) => [r.turn.id, r.turn.seq] as [string, number]),
    );
    const active = (await listTurns(db, session.id))
      .filter((t) => t.status === 'active')
      .map((t) => t.seq);
    const res = dedupeSummariesForInjection(
      await db.summaries.where('sessionId').equals(session.id).toArray(),
      active,
      seqOfTurn,
    );
    expect(res.selected).toHaveLength(0); // stale 不注入，其区间按空洞处理
    expect(res.holes).toEqual([0, 1]);
  });
});

// ------------------------------------------------------------------ #5

function mkFact(over: Partial<FactView> & { id: string; sessionId: string }): FactView {
  return {
    scope: 'global',
    characterId: '',
    key: 'test.key',
    value: 'v',
    confidence: 'proposed',
    injectionState: 'active',
    origin: 'model_proposed',
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

describe('不变量 #5：proposed 恒注入（注入层已可测，prompt 层待阶段二）', () => {
  it('用户从不打开确认面板时，proposed 仍进入注入集合，基线贡献 > 0', async () => {
    const facts = Array.from({ length: 15 }, (_, i) =>
      mkFact({ id: `p${i}`, sessionId: session.id, key: `k${i}`, confidence: 'proposed' }),
    );
    const sel = selectFactsForInjection(facts);
    expect(sel.proposed).toHaveLength(10); // 上限
    expect(sel.overflow).toHaveLength(5); // 其余面板可见，不静默丢失
    expect(injectedCount(sel)).toBeGreaterThan(0);
  });

  it('stale 的 proposed 不注入（I-3）', async () => {
    const facts = [
      mkFact({ id: 'p0', sessionId: session.id, confidence: 'proposed', stale: true }),
      mkFact({ id: 'p1', sessionId: session.id, confidence: 'proposed' }),
    ];
    const sel = selectFactsForInjection(facts);
    expect(sel.proposed.map((f) => f.id)).toEqual(['p1']);
  });
});

// ------------------------------------------------------------------ #6

describe('不变量 #6：FactView 注入态唯一性由写路径保证', () => {
  // 不是模拟并发：单人单标签页有 Web Locks，真正的并发不存在。
  // 测的是「两次连续写入都走了写路径事务」后，最终至多一条 active。
  it('sequential-writes-leave-one-active：连续两次写入后 active 行数 == 1', async () => {
    const input = {
      sessionId: session.id,
      scope: 'global' as const,
      characterId: '',
      key: 'location.current',
      value: '钟楼',
      confidence: 'confirmed' as const,
      origin: 'user_manual' as const,
      lastSeenTurn: 1,
      sourceTurnIds: [],
      sourceRevisionIds: [],
    };
    const a = await writeFact(db, input);
    const b = await writeFact(db, { ...input, value: '码头' });
    expect(a.unchanged).toBe(false);
    expect(b.unchanged).toBe(false);
    expect(b.supersededId).toBe(a.fact.id);

    const actives = await db.facts
      .where('[sessionId+scope+characterId+key+injectionState]')
      .equals([session.id, 'global', '', 'location.current', 'active'])
      .toArray();
    // 验收「最终至多一条 active」，**不要求写入失败**
    expect(actives).toHaveLength(1);
    const all = await db.facts.toArray();
    const loser = all.find((f) => f.id !== actives[0].id);
    expect(loser?.injectionState).toBe('inactive');
    expect(loser?.inactiveReason).toBe('superseded');
  });
});

// ------------------------------------------------------------------ #7

describe('不变量 #7：FactView 注入有界', () => {
  it('pin ≤5 / confirmed-auto ≤30 / proposed ≤10，总上限 45', () => {
    const facts: FactView[] = [];
    for (let i = 0; i < 40; i++) {
      facts.push(
        mkFact({ id: `c${i}`, sessionId: session.id, key: `ck${i}`, confidence: 'confirmed' }),
      );
    }
    for (let i = 0; i < 8; i++) {
      facts.push(
        mkFact({
          id: `pin${i}`,
          sessionId: session.id,
          key: `pk${i}`,
          confidence: 'confirmed',
          pinned: true,
          pinnedAt: i,
        }),
      );
    }
    for (let i = 0; i < 12; i++) {
      facts.push(mkFact({ id: `pp${i}`, sessionId: session.id, key: `ppk${i}` }));
    }
    const sel = selectFactsForInjection(facts);
    expect(sel.pinned).toHaveLength(5);
    expect(sel.confirmedAuto).toHaveLength(30);
    expect(sel.proposed).toHaveLength(10);
    expect(injectedCount(sel)).toBe(45); // 5 + 30 + 10
  });

  it('pin 豁免预算裁剪', () => {
    const facts = Array.from({ length: 10 }, (_, i) =>
      mkFact({
        id: `x${i}`,
        sessionId: session.id,
        key: `xk${i}`,
        confidence: 'confirmed',
        pinned: i < 5,
        pinnedAt: i,
      }),
    );
    const sel = selectFactsForInjection(facts);
    // 极端窄预算：只留 2 条
    const kept = trimFactsForBudget(sel, 2);
    expect(kept).toHaveLength(5); // pin 5 条全在，不参与裁剪
    expect(kept.every((f) => f.pinned)).toBe(true);
  });
});

// ------------------------------------------------------------------ retry 语义

describe('retry 与 rewrite-and-resend 的边界', () => {
  it('retry 不丢失用户输入、不重复，且不 discard 后续', async () => {
    const r1 = await appendTurn(db, session.id, { userContent: '我的输入', assistantContent: '' });
    await db.revisions.update(r1.revision.id, { status: 'interrupted' });
    const r2 = await appendTurn(db, session.id, { userContent: 'u2', assistantContent: 'a2' });

    const res = await retry(db, session.id, r1.turn.id, '完整回复');
    expect(res.revision.userContent).toBe('我的输入'); // 输入未丢
    expect(res.revision.reason).toBe('retry');

    const revs = await db.revisions.where('turnId').equals(r1.turn.id).toArray();
    expect(revs).toHaveLength(2); // interrupted + active，非两条相同输入
    expect(revs.filter((r) => r.status === 'superseded')).toHaveLength(1);

    const turns = await listTurns(db, session.id);
    expect(turns.find((t) => t.id === r2.turn.id)?.status).toBe('active'); // 后续未 discard
  });
});
