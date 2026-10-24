/**
 * I-14（pending 超时恢复）/ I-15（同区间裁剪）/ I-16（stub 打标）测试。
 * 三者的共同目的：接真实模型前清掉会留脏数据 / 卡死记录的口子。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { CURRENT_VERSION, LATEST_DATA_MIGRATION_VERSION, MIGRATIONS, initDatabase, openForTest } from '../src/schema/db';
import { appendTurn, createSession } from '../src/domain/turnStore';
import type { NarraDB } from '../src/schema/db';
import type { ServiceRef, SummaryView } from '../src/schema/entities';
import { ChatError, fakeClient, parseRetryAfter } from '../src/domain/modelClient';
import { stubSummarizer } from './helpers/stubSummarizer';
import {
  PENDING_TIMEOUT_MS,
  listStubSummaries,
  planPendingWindows,
  pruneSummaryDuplicates,
  recoverTimedOutPending,
  runSummarizeWindow,
} from '../src/domain/summaryService';
import { isInjectableSummary, isActiveSummary } from '../src/domain/summary';
import { computeIndicator } from '../src/domain/indicator';
import { Runtime } from '../src/domain/runtime';

const SUMMARIZER: ServiceRef = { id: 'svc-sum', model: 'sum-model' };
const MAIN: ServiceRef = { id: 'svc-main', model: 'main-model' };

let db: NarraDB;
let sessionId: string;

beforeEach(async () => {
  db = await openForTest(`hyg-${Math.random()}`);
  const s = await createSession(db, {
    characterId: 'c',
    title: 't',
    modelBinding: { main: MAIN, summarizer: SUMMARIZER },
    greetingAssetId: 'a',
    greetingContent: 'hi',
  });
  sessionId = s.id;
  for (let i = 0; i < 5; i++) {
    await appendTurn(db, s.id, { userContent: `u${i}`, assistantContent: `a${i}` });
  }
});

describe('I-16：stub 摘要打标，禁止注入', () => {
  it('stub client 产出的摘要标记为 source=stub', async () => {
    const windows = await planPendingWindows(db, sessionId, 5);
    const res = await runSummarizeWindow({
      db, sessionId, window: windows[0],
      client: stubSummarizer(), summarizer: SUMMARIZER, source: 'stub',
    });
    expect((await db.summaries.get(res.summaryId))!.source).toBe('stub');
  });

  it('未声明 source 的 client 按 model 处理（保守方向：不给 stub 待遇）', async () => {
    const windows = await planPendingWindows(db, sessionId, 5);
    const res = await runSummarizeWindow({
      db, sessionId, window: windows[0],
      client: fakeClient(() => 'ok'), summarizer: SUMMARIZER,
    });
    expect((await db.summaries.get(res.summaryId))!.source).toBe('model');
  });

  it('stub 摘要不可注入 —— 伪摘要比没有摘要更糟', () => {
    const stub = { status: 'ok', source: 'stub' } as SummaryView;
    expect(isActiveSummary(stub)).toBe(true); // 状态层仍是有效记录
    expect(isInjectableSummary(stub)).toBe(false); // 但不可注入
  });

  it('stub 摘要的区间转空洞，指示器如实暴露', async () => {
    const windows = await planPendingWindows(db, sessionId, 5);
    const res = await runSummarizeWindow({
      db, sessionId, window: windows[0],
      client: stubSummarizer(), summarizer: SUMMARIZER, source: 'stub',
    });
    expect((await db.summaries.get(res.summaryId))!.status).toBe('ok');
    const ind = await computeIndicator(db, sessionId);
    expect(ind.uncoveredTurns).toBeGreaterThan(0); // ok 但不注入 → 仍算未覆盖
  });

  it('listStubSummaries 能扫出全部 stub（真实 client 接入后据此重建）', async () => {
    const windows = await planPendingWindows(db, sessionId, 5);
    await runSummarizeWindow({
      db, sessionId, window: windows[0],
      client: stubSummarizer(), summarizer: SUMMARIZER, source: 'stub',
    });
    expect(await listStubSummaries(db, sessionId)).toHaveLength(1);
    // 重建：用真实 client 覆盖同一窗口（复用记录，不产生第二条）
    await runSummarizeWindow({
      db, sessionId, window: windows[0],
      client: fakeClient(() => '真摘要'), summarizer: SUMMARIZER, source: 'model',
      attempt: 1,
    });
    expect(await listStubSummaries(db, sessionId)).toHaveLength(0);
    expect((await db.summaries.where('sessionId').equals(sessionId).toArray())).toHaveLength(1);
  });
});

describe('I-14：pending 超时恢复', () => {
  it('超时 pending 转 failed 并返回窗口供重新入队', async () => {
    const windows = await planPendingWindows(db, sessionId, 5);
    await db.summaries.add({
      id: 'sum-stuck',
      sessionId,
      coversTurnIds: windows[0].turnIds,
      content: '',
      status: 'pending',
      retryCount: 0,
      sourceRevisionIds: [],
      createdAt: Date.now() - PENDING_TIMEOUT_MS - 1_000,
      updatedAt: Date.now() - PENDING_TIMEOUT_MS - 1_000,
      source: 'model',
    } satisfies SummaryView);

    const recovered = await recoverTimedOutPending(db, sessionId);
    expect(recovered).toHaveLength(1);
    expect((await db.summaries.get('sum-stuck'))!.status).toBe('failed');
    expect((await db.summaries.get('sum-stuck'))!.lastError).toContain('超时');
  });

  it('未超时的 pending 不动（正常进行中的生成不能被误杀）', async () => {
    await db.summaries.add({
      id: 'sum-fresh',
      sessionId,
      coversTurnIds: ['t'],
      content: '',
      status: 'pending',
      retryCount: 0,
      sourceRevisionIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: 'model',
    } satisfies SummaryView);
    expect(await recoverTimedOutPending(db, sessionId)).toHaveLength(0);
    expect((await db.summaries.get('sum-fresh'))!.status).toBe('pending');
  });

  it('Runtime.recover 把超时窗口重新入队，后续 pump 能补上', async () => {
    const windows = await planPendingWindows(db, sessionId, 5);
    await db.summaries.add({
      id: 'sum-stuck',
      sessionId,
      coversTurnIds: windows[0].turnIds,
      content: '',
      status: 'pending',
      retryCount: 0,
      sourceRevisionIds: [],
      createdAt: Date.now() - PENDING_TIMEOUT_MS - 1_000,
      updatedAt: Date.now() - PENDING_TIMEOUT_MS - 1_000,
      source: 'model',
    } satisfies SummaryView);

    const rt = new Runtime(db, {
      client: fakeClient(() => '补上了'),
      resolveSummarizer: async () => SUMMARIZER,
    });
    const r = await rt.recover(sessionId);
    expect(r.requeued).toBe(1);
    await rt.pump();
    expect((await db.summaries.get('sum-stuck'))!.status).toBe('ok');
    expect((await computeIndicator(db, sessionId)).uncoveredTurns).toBe(0);
  });
});

describe('退避计时与流式暂停的交互', () => {
  it('流式结束后积压任务按 maxPerPump 分批执行，不集中爆发', async () => {
    const rt = new Runtime(db, {
      client: fakeClient(() => 'x'),
      resolveSummarizer: async () => SUMMARIZER,
    });
    // 造 4 个不同的超时窗口（用不同 turnIds 模拟不同区间）
    for (let i = 0; i < 4; i++) {
      await db.summaries.add({
        id: `stuck-${i}`,
        sessionId,
        coversTurnIds: [`t${i}`],
        content: '',
        status: 'pending',
        retryCount: 0,
        sourceRevisionIds: [],
        createdAt: Date.now() - PENDING_TIMEOUT_MS - 1_000,
        updatedAt: Date.now() - PENDING_TIMEOUT_MS - 1_000,
        source: 'model',
      } satisfies SummaryView);
    }
    const r = await rt.recover(sessionId);
    // 关键：dedupeKey 必须按 turnIds 生成，用 seq 会退化成 0-0 导致只入队 1 个
    expect(r.requeued).toBe(4);

    rt.setStreaming(true);
    expect(await rt.pump()).toBe(0); // 流式期间不执行，但计时继续走
    rt.setStreaming(false);
    const n = await rt.pump();
    expect(n).toBeLessThanOrEqual(10); // 单轮上限，不会一次性跑完
  });
});

describe('I-19：stub 重建不依赖内存标志（崩溃窗口覆盖）', () => {
  it('recover 无状态扫描：有 stub 就入队，与是否发生过迁移无关', async () => {
    const windows = await planPendingWindows(db, sessionId, 5);
    await runSummarizeWindow({
      db, sessionId, window: windows[0],
      client: stubSummarizer(), summarizer: SUMMARIZER, source: 'stub',
    });
    const rt = new Runtime(db, {
      client: fakeClient(() => '真摘要'),
      resolveSummarizer: async () => SUMMARIZER,
    });
    // 全新 Runtime（模拟「进程崩溃后重启」，内存标志已丢）
    const r = await rt.recover(sessionId);
    expect(r.stubRebuild).toBe(1);
    await rt.pump();
    expect(await listStubSummaries(db, sessionId)).toHaveLength(0);
  });

  it('没有 stub 时 recover 返回 0（幂等，可每次启动调用）', async () => {
    const rt = new Runtime(db, { client: fakeClient(() => 'x'), resolveSummarizer: async () => SUMMARIZER });
    const r = await rt.recover(sessionId);
    expect(r.stubRebuild).toBe(0);
  });
});

describe('I-20：孤儿 stub 清理', () => {
  it('归属已删除会话的 stub 被物理删除，不入队', async () => {
    // 造一条挂在不存在会话上的 stub
    await db.summaries.add({
      id: 'orphan', sessionId: 'session-that-never-exists', coversTurnIds: ['t1'],
      content: '', status: 'ok', retryCount: 0, sourceRevisionIds: [],
      createdAt: 1, updatedAt: 1, source: 'stub',
    } satisfies SummaryView);
    const rt = new Runtime(db, { client: fakeClient(() => 'x'), resolveSummarizer: async () => SUMMARIZER });
    const r = await rt.rebuildStubSummaries();
    expect(r.orphansRemoved).toBe(1);
    expect(r.enqueued).toBe(0);
    expect(await db.summaries.get('orphan')).toBeUndefined();
    // 指示器不再被它污染
    expect(await listStubSummaries(db)).toHaveLength(0);
  });
});

describe('I-21：覆盖策略 —— stub 在成功前保持 stub', () => {
  it('重建失败时 source 仍为 stub，不会伪装成 model 被注入', async () => {
    const windows = await planPendingWindows(db, sessionId, 5);
    await runSummarizeWindow({
      db, sessionId, window: windows[0],
      client: stubSummarizer(), summarizer: SUMMARIZER, source: 'stub',
    });
    await expect(
      runSummarizeWindow({
        db, sessionId, window: windows[0],
        client: fakeClient(() => { throw new Error('模型挂了'); }),
        summarizer: SUMMARIZER, source: 'model', attempt: 1,
      }),
    ).rejects.toThrow();
    const row = (await db.summaries.get('sum-1')) ?? (await db.summaries.toArray())[0];
    expect(row.source).toBe('stub'); // 失败不改 source
    expect(row.status).toBe('failed');
    expect(isInjectableSummary(row)).toBe(false);
  });

  it('retrying 状态下 client 抛错 → 转 failed 且 source 仍为 stub（钉住单一写入点）', async () => {
    // 这条用例专门钉住 I-21 延伸的「失败伪装成成功」：
    // 若有人重构 retry 分支时又给 failed 写上 source（哪怕是 'model'），本用例会红。
    const windows = await planPendingWindows(db, sessionId, 5);
    await runSummarizeWindow({
      db, sessionId, window: windows[0],
      client: stubSummarizer(), summarizer: SUMMARIZER, source: 'stub',
    });
    const before = (await db.summaries.toArray())[0];
    expect(before.source).toBe('stub');
    expect(before.status).toBe('ok');

    // 用真实 client 语义（source: 'model'）去重试，但 client 抛错
    await expect(
      runSummarizeWindow({
        db, sessionId, window: windows[0],
        client: fakeClient(() => { throw new ChatError('真实模型超时', true); }),
        summarizer: SUMMARIZER, source: 'model', attempt: 1,
      }),
    ).rejects.toThrow();

    const after = (await db.summaries.toArray())[0];
    expect(after.status).toBe('failed');
    // 关键：失败绝不改 source。若这里变成 'model'，伪摘要就会被放行注入。
    expect(after.source).toBe('stub');
    expect(isInjectableSummary(after)).toBe(false);
  });

  it('重建成功后同一条记录转 model 且可注入（id 不变，不产生第二条）', async () => {
    const windows = await planPendingWindows(db, sessionId, 5);
    const first = await runSummarizeWindow({
      db, sessionId, window: windows[0],
      client: stubSummarizer(), summarizer: SUMMARIZER, source: 'stub',
    });
    await runSummarizeWindow({
      db, sessionId, window: windows[0],
      client: fakeClient(() => '真摘要'), summarizer: SUMMARIZER, source: 'model',
      attempt: 1,
    });
    const rows = await db.summaries.where('sessionId').equals(sessionId).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.summaryId); // 覆盖，不是新建
    expect(rows[0].source).toBe('model');
    expect(isInjectableSummary(rows[0])).toBe(true);
  });
});

describe('I-22：错误分类与 Retry-After', () => {
  it('不可重试错误直接终态，不消耗退避配额', async () => {
    const rt = new Runtime(db, {
      client: fakeClient(() => { throw new ChatError('内容过滤', false); }),
      resolveSummarizer: async () => SUMMARIZER,
    });
    await rt.scheduleSummaries(sessionId);
    await rt.pump();
    const tasks = await db.tasks.toArray();
    expect(tasks[0].status).toBe('failed');
    expect(tasks[0].attempts).toBe(1); // 只试一次，不进退避
    expect(tasks[0].nextRunAt).toBeUndefined();
  });

  it('可重试错误进退避队列，保留 nextRunAt', async () => {
    const rt = new Runtime(db, {
      client: fakeClient(() => { throw new ChatError('超时', true); }),
      resolveSummarizer: async () => SUMMARIZER,
    });
    await rt.scheduleSummaries(sessionId);
    await rt.pump();
    const tasks = await db.tasks.toArray();
    expect(tasks[0].status).toBe('queued');
    expect(tasks[0].nextRunAt).toBeGreaterThan(Date.now());
  });

  it('Retry-After 大于本地退避时被尊重（取 max）', async () => {
    const rt = new Runtime(db, {
      client: fakeClient(() => { throw new ChatError('限流', true, 60_000); }),
      resolveSummarizer: async () => SUMMARIZER,
    });
    await rt.scheduleSummaries(sessionId);
    const before = Date.now();
    await rt.pump();
    const task = (await db.tasks.toArray())[0];
    // 本地首档退避 2s，Retry-After 60s → 取 60s
    expect(task.nextRunAt!).toBeGreaterThanOrEqual(before + 60_000);
  });

  it('parseRetryAfter 支持秒数与 HTTP 日期两种形式', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    const base = Date.parse('2026-01-01T00:00:00Z');
    // HTTP 日期形式：base 之后 30 秒
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', base)).toBe(30_000);
    // 已过期的日期 → 0（不返回负数）
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:59:30 GMT', base)).toBe(0);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('garbage')).toBeUndefined();
  });
});

describe('I-15：同区间至多保留最近 1 条', () => {
  it('重复记录被裁剪，优先保留最新的 ok', async () => {
    const ids = ['x1', 'x2', 'x3'];
    await db.summaries.bulkAdd(
      ids.map((id, i) => ({
        id,
        sessionId,
        coversTurnIds: ['t1', 't2'],
        content: `c${i}`,
        status: i === 1 ? 'ok' : 'failed',
        retryCount: 0,
        sourceRevisionIds: [],
        createdAt: 100 + i,
        updatedAt: 100 + i,
        source: 'model',
      })) as SummaryView[],
    );
    const removed = await pruneSummaryDuplicates(db, sessionId);
    expect(removed).toBe(2);
    const left = await db.summaries.where('sessionId').equals(sessionId).toArray();
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe('x2'); // 唯一的 ok 被留下，尽管不是最新
  });

  it('全是失败记录时保留最新一条', async () => {
    await db.summaries.bulkAdd([
      { id: 'a', sessionId, coversTurnIds: ['t1'], content: '', status: 'failed', retryCount: 0, sourceRevisionIds: [], createdAt: 1, updatedAt: 1, source: 'model' },
      { id: 'b', sessionId, coversTurnIds: ['t1'], content: '', status: 'failed', retryCount: 0, sourceRevisionIds: [], createdAt: 2, updatedAt: 2, source: 'model' },
    ] as SummaryView[]);
    await pruneSummaryDuplicates(db, sessionId);
    const left = await db.summaries.where('sessionId').equals(sessionId).toArray();
    expect(left.map((s) => s.id)).toEqual(['b']);
  });

  it('I-18：ok 与 stale 并存时保留 stale —— ok 是基于旧输入的过时摘要', async () => {
    // 防御性分支：正常路径下 markViewsStale 会把同区间所有记录一起标 stale，
    // 不会长期并存；此用例锁住「若真并存，不能让过时内容继续被注入」。
    await db.summaries.bulkAdd([
      { id: 'ok-old', sessionId, coversTurnIds: ['t1'], content: '过时摘要', status: 'ok', retryCount: 0, sourceRevisionIds: [], createdAt: 1, updatedAt: 1, source: 'model' },
      { id: 'stale-new', sessionId, coversTurnIds: ['t1'], content: '', status: 'stale', retryCount: 0, sourceRevisionIds: [], createdAt: 2, updatedAt: 2, staleReason: 'turn-edited', source: 'model' },
    ] as SummaryView[]);
    await pruneSummaryDuplicates(db, sessionId);
    const left = await db.summaries.where('sessionId').equals(sessionId).toArray();
    expect(left.map((s) => s.id)).toEqual(['stale-new']);
    // 若反过来保留 ok，这条会失败：过时内容会被注入
    expect(isInjectableSummary(left[0])).toBe(false);
  });

  it('不同区间互不干扰', async () => {
    await db.summaries.bulkAdd([
      { id: 'a', sessionId, coversTurnIds: ['t1'], content: '', status: 'ok', retryCount: 0, sourceRevisionIds: [], createdAt: 1, updatedAt: 1, source: 'model' },
      { id: 'b', sessionId, coversTurnIds: ['t2'], content: '', status: 'ok', retryCount: 0, sourceRevisionIds: [], createdAt: 2, updatedAt: 2, source: 'model' },
    ] as SummaryView[]);
    expect(await pruneSummaryDuplicates(db, sessionId)).toBe(0);
  });
});

describe('迁移收尾：stub 摘要自动重建', () => {
  it('rebuildStubSummaries 把 stub 全部重新入队', async () => {
    const windows = await planPendingWindows(db, sessionId, 5);
    await runSummarizeWindow({
      db, sessionId, window: windows[0],
      client: stubSummarizer(), summarizer: SUMMARIZER, source: 'stub',
    });
    const rt = new Runtime(db, {
      client: fakeClient(() => '真摘要'),
      resolveSummarizer: async () => SUMMARIZER,
    });
    expect((await rt.rebuildStubSummaries(sessionId)).enqueued).toBe(1);
    await rt.pump();
    expect(await listStubSummaries(db, sessionId)).toHaveLength(0);
    expect((await computeIndicator(db, sessionId)).uncoveredTurns).toBe(0);
  });

  it('initDatabase 的 onMigrated 在升级后触发（收尾钩子接线）', async () => {
    const name = `onmig-${Math.random()}`;
    const seed = new Dexie(name);
    seed.version(1).stores({
      sessions: 'id, characterId, updatedAt',
      characters: 'id, name, updatedAt',
      assets: 'id, characterId, type, [characterId+type]',
      turns: 'id, sessionId, &[sessionId+seq], [sessionId+status]',
      revisions: 'id, turnId, [turnId+status]',
      summaries: 'id, sessionId, [sessionId+status]',
      facts: 'id, [sessionId+scope+characterId+key+injectionState]',
      vectors: 'id, [sessionId+embedderServiceId]',
      tasks: 'id, sessionId, [sessionId+status]',
    });
    await seed.open();
    await seed.close();

    let called = 0;
    await initDatabase({
      dbName: name,
      confirm: async () => true,
      exportBackup: async () => {},
      onMigrated: () => {
        called += 1;
      },
    });
    expect(called).toBe(1); // 老库升级 → 触发收尾

    // 全新库不应触发（没有迁移就没有 stub 需要重建）
    let called2 = 0;
    await initDatabase({
      dbName: `fresh-${Math.random()}`,
      confirm: async () => true,
      exportBackup: async () => {},
      onMigrated: () => {
        called2 += 1;
      },
    });
    expect(called2).toBe(0);
  });
});

describe('迁移 v4：缺 source 的旧行回填 stub（保守方向）', () => {
  it('无 source 的摘要被回填为 stub，等待重建而非冒险注入', async () => {
    const name = `mig4-${Math.random()}`;
    await db.summaries.add({
      id: 'legacy',
      sessionId,
      coversTurnIds: ['t1'],
      content: '旧数据',
      status: 'ok',
      retryCount: 0,
      sourceRevisionIds: [],
      createdAt: Date.now(),
    } as unknown as SummaryView);

    // 直接跑迁移函数（模拟老库升级路径）
    const seed = new Dexie(name);
    seed.version(1).stores({ summaries: 'id, sessionId, [sessionId+status]' });
    await seed.open();
    seed.close();

    const db2 = await openForTest(name);
    await db2.summaries.add({
      id: 'legacy2',
      sessionId: 's',
      coversTurnIds: ['t1'],
      content: '旧',
      status: 'ok',
      retryCount: 0,
      sourceRevisionIds: [],
      createdAt: Date.now(),
    } as unknown as SummaryView);
    await MIGRATIONS[LATEST_DATA_MIGRATION_VERSION]({
      storeNames: ['summaries'],
      table: (n: string) => db2.table(n),
    } as never);
    const row = await db2.summaries.get('legacy2');
    expect(row?.source).toBe('stub');
    expect(typeof row?.updatedAt).toBe('number');
  });

  it('已声明 model 的记录不被迁移改写', async () => {
    const name = `mig4b-${Math.random()}`;
    const db2 = await openForTest(name);
    await db2.summaries.add({
      id: 'm1', sessionId: 's', coversTurnIds: ['t'], content: 'c',
      status: 'ok', retryCount: 0, sourceRevisionIds: [], createdAt: 1,
      source: 'model',
    } satisfies SummaryView);
    await MIGRATIONS[LATEST_DATA_MIGRATION_VERSION]({
      storeNames: ['summaries'],
      table: (n: string) => db2.table(n),
    } as never);
    expect((await db2.summaries.get('m1'))!.source).toBe('model');
  });
});
