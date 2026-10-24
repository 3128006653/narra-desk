/**
 * 阶段一其余验收项：greeting 单一真相源、会话级模型绑定、乐观锁冲突、改写重发。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openForTest, type NarraDB } from '../src/schema/db';
import type { Session } from '../src/schema/entities';
import {
  appendTurn,
  createSession,
  currentGreeting,
  hasUserReply,
  listRecentTurns,
  listRevisions,
  listTurns,
  listTurnsPage,
  resendAfterRewrite,
  restoreToRevision,
  switchGreeting,
} from '../src/domain/turnStore';
import { GreetingLockedError, WriteConflictError } from '../src/domain/errors';
import { buildBackupBundle, checkBundle } from '../src/domain/exportJson';
import { CURRENT_VERSION } from '../src/schema/db';

const mkBinding = (model: string): Session['modelBinding'] => ({
  main: { id: 'svc', model },
});

let db: NarraDB;

beforeEach(async () => {
  db = await openForTest(`ts-${Math.random().toString(36).slice(2)}`);
});

describe('greeting：由 seq 0 的 activeRevision 派生（无 selectedGreetingId）', () => {
  it('创建会话即物化 seq 0，expectedSeq 从 1 开始', async () => {
    const s = await createSession(db, {
      characterId: 'c1',
      title: 't',
      modelBinding: mkBinding('m'),
      greetingAssetId: 'a1',
      greetingContent: '开场白 A',
    });
    expect(s.expectedSeq).toBe(1);
    expect(await currentGreeting(db, s.id)).toBe('开场白 A');
    expect(await hasUserReply(db, s.id)).toBe(false);
  });

  it('未回复阶段可就地切换，走 greeting_switch revision', async () => {
    const s = await createSession(db, {
      characterId: 'c1',
      title: 't',
      modelBinding: mkBinding('m'),
      greetingAssetId: 'a1',
      greetingContent: '开场白 A',
    });
    await switchGreeting(db, s.id, '开场白 B');
    expect(await currentGreeting(db, s.id)).toBe('开场白 B');

    const turns = await listTurns(db, s.id);
    const revs = await listRevisions(db, turns[0].id);
    expect(revs).toHaveLength(2);
    expect(revs[1].reason).toBe('greeting_switch');
    expect(revs[0].status).toBe('superseded');
  });

  it('已回复后拒绝就地切换（转「以此 greeting 新开会话」）', async () => {
    const s = await createSession(db, {
      characterId: 'c1',
      title: 't',
      modelBinding: mkBinding('m'),
      greetingAssetId: 'a1',
      greetingContent: '开场白 A',
    });
    await appendTurn(db, s.id, { userContent: '你好', assistantContent: '嗯' });
    await expect(switchGreeting(db, s.id, '开场白 B')).rejects.toBeInstanceOf(GreetingLockedError);
  });
});

describe('会话级模型绑定', () => {
  it('两个会话各自持有绑定，互不影响', async () => {
    const a = await createSession(db, {
      characterId: 'c1',
      title: 'A',
      modelBinding: mkBinding('model-a'),
      greetingAssetId: 'a1',
      greetingContent: 'g',
    });
    const b = await createSession(db, {
      characterId: 'c1',
      title: 'B',
      modelBinding: mkBinding('model-b'),
      greetingAssetId: 'a1',
      greetingContent: 'g',
    });
    expect(a.modelBinding.main.model).toBe('model-a');
    expect(b.modelBinding.main.model).toBe('model-b');
  });
});

describe('乐观锁', () => {
  it('持陈旧 expectedSeq 写入 → WriteConflictError', async () => {
    const s = await createSession(db, {
      characterId: 'c1',
      title: 't',
      modelBinding: mkBinding('m'),
      greetingAssetId: 'a1',
      greetingContent: 'g',
    });
    await appendTurn(db, s.id, { userContent: 'u1', assistantContent: 'a1' });
    // UI 仍持有创建时的 expectedSeq=1
    await expect(
      appendTurn(db, s.id, { userContent: 'u2', assistantContent: 'a2', expectedSeq: 1 }),
    ).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('不传 expectedSeq 时由存储侧分配，串行写入不冲突', async () => {
    const s = await createSession(db, {
      characterId: 'c1',
      title: 't',
      modelBinding: mkBinding('m'),
      greetingAssetId: 'a1',
      greetingContent: 'g',
    });
    const a = await appendTurn(db, s.id, { userContent: 'u1', assistantContent: 'a1' });
    const b = await appendTurn(db, s.id, { userContent: 'u2', assistantContent: 'a2' });
    expect([a.turn.seq, b.turn.seq]).toEqual([1, 2]);
    const fresh = await db.sessions.get(s.id);
    expect(fresh?.expectedSeq).toBe(3);
  });
});

describe('改写输入后重发', () => {
  it('旧 Turn discarded，新 Turn 拿新 seq 与新 requestId', async () => {
    const s = await createSession(db, {
      characterId: 'c1',
      title: 't',
      modelBinding: mkBinding('m'),
      greetingAssetId: 'a1',
      greetingContent: 'g',
    });
    const r1 = await appendTurn(db, s.id, { userContent: '原输入', assistantContent: '原回复' });
    const res = await resendAfterRewrite(db, s.id, r1.turn.id, '改写后的输入', '新回复');

    expect(res.turn.seq).toBe(2); // 不是复用 1
    expect(res.revision.requestId).not.toBe(r1.revision.requestId);
    const turns = await listTurns(db, s.id);
    expect(turns.find((t) => t.id === r1.turn.id)?.status).toBe('discarded');
  });
});

describe('分页加载（§5.11）', () => {
  it('初始加载最近 2 页 = 100 轮，按 seq 升序', async () => {
    const s = await createSession(db, {
      characterId: 'c1',
      title: 't',
      modelBinding: mkBinding('m'),
      greetingAssetId: 'a1',
      greetingContent: 'g',
    });
    for (let i = 0; i < 130; i++) {
      await appendTurn(db, s.id, { userContent: `u${i}`, assistantContent: `a${i}` });
    }
    const page = await listRecentTurns(db, s.id);
    expect(page).toHaveLength(100);
    expect(page[0].seq).toBe(31); // 131 轮中最近的 100 轮（seq 31..130）
    expect(page[page.length - 1].seq).toBe(130);
  });

  it('游标继续向前翻页，不重复不遗漏', async () => {
    const s = await createSession(db, {
      characterId: 'c1',
      title: 't',
      modelBinding: mkBinding('m'),
      greetingAssetId: 'a1',
      greetingContent: 'g',
    });
    for (let i = 0; i < 130; i++) {
      await appendTurn(db, s.id, { userContent: `u${i}`, assistantContent: `a${i}` });
    }
    const first = await listTurnsPage(db, s.id, { limit: 50 });
    expect(first.map((t) => t.seq)).toEqual([130, 129, 128].slice(0, 1).concat(
      Array.from({ length: 49 }, (_, i) => 129 - i),
    ).slice(0, 50));
    const oldest = first[first.length - 1].seq;
    const second = await listTurnsPage(db, s.id, { beforeSeq: oldest, limit: 50 });
    expect(second[0].seq).toBe(oldest - 1);
    expect(second.every((t) => t.seq < oldest)).toBe(true);
  });

  it('status 过滤：discarded 不占主时间线分页配额', async () => {
    const s = await createSession(db, {
      characterId: 'c1',
      title: 't',
      modelBinding: mkBinding('m'),
      greetingAssetId: 'a1',
      greetingContent: 'g',
    });
    for (let i = 0; i < 5; i++) {
      await appendTurn(db, s.id, { userContent: `u${i}`, assistantContent: `a${i}` });
    }
    const { truncate } = await import('../src/domain/turnStore');
    await truncate(db, s.id, 2); // 3、4、5 discarded
    const active = await listRecentTurns(db, s.id, 1, 'active');
    expect(active.map((t) => t.seq)).toEqual([0, 1, 2]);
  });
});

describe('版本历史', () => {
  it('恢复到历史版本产生新 revision，不删除当前版本', async () => {
    const s = await createSession(db, {
      characterId: 'c1',
      title: 't',
      modelBinding: mkBinding('m'),
      greetingAssetId: 'a1',
      greetingContent: 'g',
    });
    const r = await appendTurn(db, s.id, { userContent: 'u', assistantContent: 'v1' });
    const { amend } = await import('../src/domain/turnStore');
    await amend(db, s.id, r.turn.id, { assistantContent: 'v2' });

    const revs = await listRevisions(db, r.turn.id);
    expect(revs.map((x) => x.assistantContent)).toEqual(['v1', 'v2']);

    await restoreToRevision(db, s.id, revs[0].id); // 回到 v1
    const after = await listRevisions(db, r.turn.id);
    expect(after).toHaveLength(3);
    expect(after[2].assistantContent).toBe('v1'); // 新版本内容为 v1
    expect(after[0].assistantContent).toBe('v1'); // 原始版本未被删除
    expect(after[2].status).toBe('active');
  });
});

describe('导出包 schema 版本号（阶段一尾巴）', () => {
  it('导出包含 schemaVersion，等于当前版本', async () => {
    const s = await createSession(db, {
      characterId: 'c1',
      title: 't',
      modelBinding: mkBinding('m'),
      greetingAssetId: 'a1',
      greetingContent: 'g',
    });
    await appendTurn(db, s.id, { userContent: 'u', assistantContent: 'a' });
    const bundle = await buildBackupBundle(db);
    expect(bundle.schemaVersion).toBe(CURRENT_VERSION);
    const check = checkBundle(bundle);
    expect(check).toEqual({ ok: true, schemaVersion: CURRENT_VERSION, needsMigration: false });
  });

  it('无版本号的老包被拒绝，不静默猜测', () => {
    expect(checkBundle({ turns: [] })).toEqual({ ok: false, reason: 'missing-schema-version' });
    expect(checkBundle(null)).toEqual({ ok: false, reason: 'not-json-bundle' });
    expect(checkBundle({ schemaVersion: 1 })).toEqual({
      ok: true,
      schemaVersion: 1,
      needsMigration: true,
    });
  });
});
