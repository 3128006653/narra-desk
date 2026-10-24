import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { openForTest } from '../src/schema/db';
import { appendTurn, createSession, markViewsStale } from '../src/domain/turnStore';
import type { NarraDB } from '../src/schema/db';
import type { ServiceRef } from '../src/schema/entities';
import { ChatError, fakeClient, flakyClient } from '../src/domain/modelClient';
import {
  BACKOFF_MS,
  MAX_ATTEMPTS,
  backoffDelay,
  buildSummaryMessages,
  planPendingWindows,
  runSummarizeWindow,
} from '../src/domain/summaryService';
import { Runtime } from '../src/domain/runtime';
import { computeIndicator, countSegments, formatIndicator } from '../src/domain/indicator';
import { estimateTokens } from '../src/domain/tokenEst';

const SUMMARIZER: ServiceRef = { id: 'svc-sum', model: 'sum-model' };
const MAIN: ServiceRef = { id: 'svc-main', model: 'main-model' };

let db: NarraDB;
let sessionId: string;

async function seed(n: number): Promise<void> {
  const s = await createSession(db, {
    characterId: 'c',
    title: 't',
    modelBinding: { main: MAIN, summarizer: SUMMARIZER },
    greetingAssetId: 'a',
    greetingContent: 'hi',
  });
  sessionId = s.id;
  for (let i = 0; i < n; i++) {
    await appendTurn(db, s.id, { userContent: `u${i}`, assistantContent: `a${i}` });
  }
}

beforeEach(async () => {
  db = await openForTest(`sum-${Math.random()}`);
  await seed(5);
});

describe('摘要生成：写入侧零裁剪 + 失败必须落记录', () => {
  it('成功 → status=ok，coversTurnIds 精确覆盖窗口全部 Turn', async () => {
    const windows = await planPendingWindows(db, sessionId, 5);
    expect(windows).toHaveLength(1);
    const res = await runSummarizeWindow({
      db,
      sessionId,
      window: windows[0],
      client: fakeClient(() => '摘要内容'),
      summarizer: SUMMARIZER,
    });
    expect(res.status).toBe('ok');
    const row = (await db.summaries.get(res.summaryId))!;
    expect(row.status).toBe('ok');
    expect(row.coversTurnIds).toEqual(windows[0].turnIds);
    expect(row.sourceRevisionIds.length).toBe(windows[0].turnIds.length);
  });

  it('失败 → 仍落记录且带 coversTurnIds（否则空洞计算无从知情）', async () => {
    const windows = await planPendingWindows(db, sessionId, 5);
    // I-22：失败现在**抛出** ChatError（供任务中心做终态/退避分类），
    // 但摘要记录在抛出前已落库并带 coversTurnIds —— 空洞计算仍知情。
    await expect(
      runSummarizeWindow({
        db,
        sessionId,
        window: windows[0],
        client: fakeClient(() => {
          throw new ChatError('模型炸了');
        }),
        summarizer: SUMMARIZER,
      }),
    ).rejects.toThrow('模型炸了');
    const row = (await db.summaries.toArray())[0];
    expect(row.status).toBe('failed');
    expect(row.coversTurnIds).toEqual(windows[0].turnIds); // 关键断言
    expect(row.retryCount).toBe(1);
    expect(row.lastError).toContain('模型炸了');
  });

  it('空结果视为失败，不留空 ok 摘要', async () => {
    const windows = await planPendingWindows(db, sessionId, 5);
    await expect(
      runSummarizeWindow({
        db,
        sessionId,
        window: windows[0],
        client: fakeClient(() => '   '),
        summarizer: SUMMARIZER,
      }),
    ).rejects.toThrow('摘要结果为空');
    expect((await db.summaries.toArray())[0].status).toBe('failed');
  });

  it('已被 ok 摘要完全覆盖的窗口不再重复排队（写入侧零裁剪 ≠ 重复烧 token）', async () => {
    const w1 = await planPendingWindows(db, sessionId, 5);
    expect(w1).toHaveLength(1);
    await runSummarizeWindow({
      db, sessionId, window: w1[0], client: fakeClient(() => 'ok'), summarizer: SUMMARIZER,
    });
    const w2 = await planPendingWindows(db, sessionId, 5);
    expect(w2).toHaveLength(0);
  });

  it('重试接管同一窗口记录，不产生第二条', async () => {
    const windows = await planPendingWindows(db, sessionId, 5);
    // 失败会抛出（I-22），这里只关心落库的记录 id
    await runSummarizeWindow({
      db, sessionId, window: windows[0],
      client: fakeClient(() => { throw new ChatError('x'); }), summarizer: SUMMARIZER,
    }).catch(() => undefined);
    const first = { summaryId: (await db.summaries.toArray())[0].id };
    const second = await runSummarizeWindow({
      db, sessionId, window: windows[0], client: fakeClient(() => '好了'), summarizer: SUMMARIZER,
      attempt: 1,
    });
    expect(second.summaryId).toBe(first.summaryId); // 复用同一条
    expect((await db.summaries.where('sessionId').equals(sessionId).toArray())).toHaveLength(1);
    expect((await db.summaries.get(second.summaryId))!.status).toBe('ok');
  });
});

describe('退避阶梯', () => {
  it('单调上升并在末端饱和', () => {
    expect(backoffDelay(1)).toBe(BACKOFF_MS[0]);
    expect(backoffDelay(2)).toBe(BACKOFF_MS[1]);
    expect(backoffDelay(99)).toBe(BACKOFF_MS[BACKOFF_MS.length - 1]);
    for (let i = 2; i <= BACKOFF_MS.length; i++) {
      expect(backoffDelay(i)).toBeGreaterThanOrEqual(backoffDelay(i - 1));
    }
  });
});

describe('任务中心：幂等入队 / 状态机 / 流式暂停', () => {
  it('同 sessionId+type+dedupeKey 未终态时不重复排队', async () => {
    const rt = new Runtime(db, {
      client: fakeClient(() => 'x'),
      resolveSummarizer: async () => SUMMARIZER,
    });
    const n1 = await rt.scheduleSummaries(sessionId);
    const n2 = await rt.scheduleSummaries(sessionId);
    expect(n1).toBeGreaterThan(0);
    expect(n2).toBe(0); // 幂等命中
    const tasks = await db.tasks.where('sessionId').equals(sessionId).toArray();
    expect(tasks).toHaveLength(n1);
  });

  it('pump 把任务跑到 done，并产出 ok 摘要', async () => {
    const rt = new Runtime(db, {
      client: fakeClient(() => '摘要'),
      resolveSummarizer: async () => SUMMARIZER,
    });
    await rt.scheduleSummaries(sessionId);
    const processed = await rt.pump();
    expect(processed).toBeGreaterThan(0);
    const tasks = await db.tasks.where('sessionId').equals(sessionId).toArray();
    expect(tasks.every((t) => t.status === 'done')).toBe(true);
    const summaries = await db.summaries.where('sessionId').equals(sessionId).toArray();
    expect(summaries.every((s) => s.status === 'ok')).toBe(true);
  });

  it('流式期间 pump 暂停（不抢占 API 配额与主线程）', async () => {
    const client = fakeClient(() => '摘要');
    const rt = new Runtime(db, { client, resolveSummarizer: async () => SUMMARIZER });
    await rt.scheduleSummaries(sessionId);
    rt.setStreaming(true);
    expect(await rt.pump()).toBe(0);
    expect(client.calls).toHaveLength(0);
    rt.setStreaming(false);
    expect(await rt.pump()).toBeGreaterThan(0);
    expect(client.calls.length).toBeGreaterThan(0);
  });

  it('失败 → 退避回 queued，达到上限后停 failed', async () => {
    const rt = new Runtime(db, {
      client: fakeClient(() => { throw new ChatError('持续失败'); }),
      resolveSummarizer: async () => SUMMARIZER,
      maxAttempts: 2,
    });
    await rt.scheduleSummaries(sessionId);

    await rt.pump(); // 第 1 次尝试 → 失败 → 回 queued
    let tasks = await db.tasks.where('sessionId').equals(sessionId).toArray();
    expect(tasks[0].status).toBe('queued');
    expect(tasks[0].attempts).toBe(1);
    expect(tasks[0].nextRunAt).toBeGreaterThan(Date.now()); // 退避未到

    await rt.center.retryNow(tasks[0].id); // 立即重试：清退避，但保留 attempts=1
    await rt.pump(); // 第 2 次 → attempts=2 达到上限 → failed
    tasks = await db.tasks.where('sessionId').equals(sessionId).toArray();
    expect(tasks[0].status).toBe('failed');
    expect(tasks[0].attempts).toBe(2);
    expect(tasks[0].lastError).toContain('持续失败');
  });

  it('retryNow 不清零 attempts；resetTask 才让终态任务重新开始', async () => {
    const rt = new Runtime(db, {
      client: fakeClient(() => { throw new ChatError('x'); }),
      resolveSummarizer: async () => SUMMARIZER,
      maxAttempts: 1,
    });
    await rt.scheduleSummaries(sessionId);
    await rt.pump();
    const t0 = (await db.tasks.where('sessionId').equals(sessionId).toArray())[0];
    expect(t0.status).toBe('failed');
    expect(t0.attempts).toBe(1);

    // retryNow：重新排队但计数保留 → 再跑一次仍会立刻 failed（不会无限刷新配额）
    await rt.center.retryNow(t0.id);
    let cur = (await db.tasks.get(t0.id))!;
    expect(cur.status).toBe('queued');
    expect(cur.attempts).toBe(1);

    // resetTask：计数归零，给它一次完整的重试机会
    await rt.center.resetTask(t0.id);
    cur = (await db.tasks.get(t0.id))!;
    expect(cur.attempts).toBe(0);
    expect(cur.lastError).toBeUndefined();
  });

  it('摘要失败后对话不被阻塞：摘要 failed 但 Turn 完好', async () => {
    const rt = new Runtime(db, {
      client: fakeClient(() => { throw new ChatError('x'); }),
      resolveSummarizer: async () => SUMMARIZER,
      maxAttempts: 1,
    });
    await rt.scheduleSummaries(sessionId);
    await rt.pump();
    const turns = await db.turns.where('sessionId').equals(sessionId).toArray();
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every((t) => t.status === 'active')).toBe(true);
  });

  it('flaky client：重试后最终成功', async () => {
    const rt = new Runtime(db, {
      client: flakyClient(1, '终于好了'),
      resolveSummarizer: async () => SUMMARIZER,
      maxAttempts: 3,
    });
    await rt.scheduleSummaries(sessionId);
    await rt.pump(); // 失败 → queued
    const t0 = (await db.tasks.where('sessionId').equals(sessionId).toArray())[0];
    await rt.center.retryNow(t0.id);
    await rt.pump();
    const summaries = await db.summaries.where('sessionId').equals(sessionId).toArray();
    expect(summaries[0].status).toBe('ok');
    expect(summaries[0].content).toBe('终于好了');
  });

  it('未注册 handler 的任务不会卡死队列，会按失败处理', async () => {
    const rt = new Runtime(db, {
      client: fakeClient(() => 'x'),
      resolveSummarizer: async () => SUMMARIZER,
      maxAttempts: 1,
    });
    await rt.center.enqueue({ sessionId, type: 'reindex', dedupeKey: 'k' });
    await rt.pump();
    const tasks = await db.tasks.where('sessionId').equals(sessionId).toArray();
    expect(tasks[0].status).toBe('failed');
    expect(tasks[0].lastError).toContain('未注册');
  });
});

describe('编辑 → stale → 后台重建（§5.6 链路闭环）', () => {
  it('amend 后摘要转 stale、窗口重新入队、重建后回到 ok 且不产生第二条', async () => {
    const rt = new Runtime(db, {
      client: fakeClient(() => '第一版摘要'),
      resolveSummarizer: async () => SUMMARIZER,
    });
    await rt.scheduleSummaries(sessionId);
    await rt.pump();
    let sums = await db.summaries.where('sessionId').equals(sessionId).toArray();
    expect(sums).toHaveLength(1);
    expect(sums[0].status).toBe('ok');

    // 编辑第 1 轮 → 覆盖它的摘要转 stale（不变量 #2：stale 只作用于派生物）
    const first = (await db.turns.where('sessionId').equals(sessionId).toArray())
      .filter((t) => t.seq > 0)
      .sort((a, b) => a.seq - b.seq)[0];
    const report = await markViewsStale(db, sessionId, [first.id], 'amend');
    expect(report.summaries).toHaveLength(1);
    expect((await db.summaries.get(sums[0].id))!.status).toBe('stale');

    // stale 摘要不算「已覆盖」→ 窗口重新入队
    const added = await rt.scheduleSummaries(sessionId);
    expect(added).toBe(1);

    // 后台重建完成后，指示器回到干净状态
    await rt.pump();
    sums = await db.summaries.where('sessionId').equals(sessionId).toArray();
    expect(sums).toHaveLength(1); // 同一条记录被接管，不堆积
    expect(sums[0].status).toBe('ok');

    const ind = await rt.indicator(sessionId);
    expect(ind.pendingSummaries).toBe(0);
    expect(ind.staleSummaries).toBe(0);
    expect(ind.uncoveredTurns).toBe(0);
  });

  it('重建期间 stale 摘要不注入，其区间按空洞计入指示器', async () => {
    const windows = await planPendingWindows(db, sessionId, 5);
    const res = await runSummarizeWindow({
      db, sessionId, window: windows[0], client: fakeClient(() => 'ok'), summarizer: SUMMARIZER,
    });
    const first = (await db.turns.where('sessionId').equals(sessionId).toArray())
      .filter((t) => t.seq > 0)
      .sort((a, b) => a.seq - b.seq)[0];
    await markViewsStale(db, sessionId, [first.id], 'amend');
    void res;
    const ind = await computeIndicator(db, sessionId);
    expect(ind.staleSummaries).toBe(1);
    expect(ind.uncoveredTurns).toBeGreaterThan(0);
  });
});

describe('指示器：待补段数 / 未覆盖轮数', () => {
  it('无摘要时全部轮次计入未覆盖', async () => {
    const s = await computeIndicator(db, sessionId);
    expect(s.uncoveredTurns).toBeGreaterThan(0);
    expect(s.pendingSummaries).toBe(0);
  });

  it('failed 摘要计入「N 段摘要待补」，其区间转空洞', async () => {
    const windows = await planPendingWindows(db, sessionId, 5);
    await runSummarizeWindow({
      db, sessionId, window: windows[0],
      client: fakeClient(() => { throw new ChatError('x'); }), summarizer: SUMMARIZER,
    }).catch(() => undefined); // 失败抛出是 I-22 的新语义
    const s = await computeIndicator(db, sessionId);
    expect(s.pendingSummaries).toBe(1);
    expect(s.uncoveredTurns).toBeGreaterThan(0); // failed 区间不算已覆盖
  });

  it('ok 摘要覆盖后未覆盖轮数归零', async () => {
    const windows = await planPendingWindows(db, sessionId, 5);
    await runSummarizeWindow({
      db, sessionId, window: windows[0], client: fakeClient(() => 'ok'), summarizer: SUMMARIZER,
    });
    const s = await computeIndicator(db, sessionId);
    expect(s.uncoveredTurns).toBe(0);
    expect(s.pendingSummaries).toBe(0);
  });

  it('stale 摘要计入待重建，区间转空洞', async () => {
    const windows = await planPendingWindows(db, sessionId, 5);
    const res = await runSummarizeWindow({
      db, sessionId, window: windows[0], client: fakeClient(() => 'ok'), summarizer: SUMMARIZER,
    });
    await db.summaries.update(res.summaryId, { status: 'stale', staleReason: 'turn-edited' });
    const s = await computeIndicator(db, sessionId);
    expect(s.staleSummaries).toBe(1);
    expect(s.uncoveredTurns).toBeGreaterThan(0);
  });

  it('空洞回退预览：K = min(20, 剩余预算)，如实上报仍未覆盖', async () => {
    // 造 60 轮会话（含 greeting = 61 个 Turn，全部无摘要 → 全空洞）
    db = await openForTest(`hole-${Math.random()}`);
    await seed(60);
    const s = await computeIndicator(db, sessionId, {
      remainingTokens: 50,
      estOfTurn: (t) => estimateTokens(`u${t.seq} a${t.seq}`),
    });
    expect(s.fallbackTurns).toBeGreaterThan(0);
    expect(s.fallbackTurns).toBeLessThanOrEqual(20);
    expect(s.stillUncovered).toBe(s.uncoveredTurns - s.fallbackTurns);
    expect(s.stillUncovered).toBeGreaterThan(0); // 长空洞下不谎报「全覆盖」
  });

  it('段数统计：连续压成一段', () => {
    expect(countSegments([1, 2, 3])).toBe(1);
    expect(countSegments([1, 2, 7, 8, 12])).toBe(3);
    expect(countSegments([])).toBe(0);
  });

  it('文案只在有事可报时输出', () => {
    expect(formatIndicator({
      running: 0, failedTasks: 0, queued: 0, pendingSummaries: 0, staleSummaries: 0,
      holeSegments: 0, uncoveredTurns: 0, fallbackTurns: 0, stillUncovered: 0,
      staleFacts: 0, pendingFacts: 0,
    })).toEqual([]);
    const lines = formatIndicator({
      running: 1, failedTasks: 0, queued: 0, pendingSummaries: 2, staleSummaries: 0,
      holeSegments: 1, uncoveredTurns: 30, fallbackTurns: 10, stillUncovered: 20,
      staleFacts: 0, pendingFacts: 0,
    });
    expect(lines.join('|')).toContain('后台运行中 1');
    expect(lines.join('|')).toContain('N 段摘要待补：2');
    expect(lines.join('|')).toContain('仍有 20 轮未覆盖');
  });
});

describe('摘要请求消息', () => {
  it('滚动摘要带上「此前已发生」', () => {
    const msgs = buildSummaryMessages(
      [{ seq: 1, userContent: 'u', assistantContent: 'a' }],
      '之前的剧情',
    );
    expect(msgs[0].role).toBe('system');
    expect(msgs.some((m) => m.content.includes('之前的剧情'))).toBe(true);
    expect(msgs[msgs.length - 1].role).toBe('user');
  });

  it('MAX_ATTEMPTS 与任务中心默认一致', () => {
    expect(MAX_ATTEMPTS).toBe(5);
  });
});



/**
 * 流式暂停的异常路径（真实 client 接入的前置保障）：
 * client 抛错时必须仍能恢复后台调度 —— 对应 UI 里 `try/finally` 的要求。
 */
describe('流式暂停与异常恢复', () => {
  it('client 抛错后 finally 复位 isStreaming，下一轮 pump 仍能推进', async () => {
    const db = await openForTest(`stream-${Math.random()}`);
    const s = await createSession(db, {
      characterId: 'c', title: 't',
      modelBinding: { main: MAIN, summarizer: SUMMARIZER },
      greetingAssetId: 'a', greetingContent: 'hi',
    });
    for (let i = 0; i < 5; i++) {
      await appendTurn(db, s.id, { userContent: `u${i}`, assistantContent: `a${i}` });
    }

    const rt = new Runtime(db, {
      client: fakeClient(() => { throw new ChatError('流式中断', true); }),
      resolveSummarizer: async () => SUMMARIZER,
    });
    await rt.scheduleSummaries(s.id);

    rt.setStreaming(true);
    expect(rt.isStreaming()).toBe(true);
    expect(await rt.pump()).toBe(0); // 流式期间不执行

    // 模拟 UI：流式开始 → try{ …client 抛错… } finally { setStreaming(false) }
    try {
      rt.setStreaming(false); // 进入执行
      await rt.pump();
    } finally {
      rt.setStreaming(false); // 异常路径也必须复位
    }

    expect(rt.isStreaming()).toBe(false); // 复位可断言
    const tasks = await db.tasks.toArray();
    expect(tasks.every((t) => t.status !== 'running')).toBe(true); // 没卡在 running
  });
});
