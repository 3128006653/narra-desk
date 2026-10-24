/**
 * I-10 实测：listTurnsPage 在长会话下的耗时。
 *
 * ⚠️ 结论适用范围：fake-indexeddb 是**内存实现**，测的是 JS 侧开销
 * （取回全量 + 内存排序 + slice），这正是当前实现的瓶颈所在。
 * 真实 IndexedDB 还要在此基础上叠加反序列化开销 —— 所以这里的数字是**乐观下界**：
 * 若此处已 >100ms，真实环境只会更差。
 */
import 'fake-indexeddb/auto';
import { describe, it } from 'vitest';
import { openForTest } from '../src/schema/db';
import { appendTurn, createSession, listRecentTurns } from '../src/domain/turnStore';
import { dedupeSummariesForInjection } from '../src/domain/summary';
import type { SummaryView } from '../src/schema/entities';

const SIZES = [2000, 5000];

describe('I-10 性能实测', () => {
  for (const n of SIZES) {
    it(`${n} 轮会话：分页加载 + 摘要去重耗时`, async () => {
      const db = await openForTest(`perf-${n}`);
      const s = await createSession(db, {
        characterId: 'c',
        title: 'perf',
        modelBinding: { main: { id: 'svc', model: 'm' } },
        greetingAssetId: 'a',
        greetingContent: 'g',
      });

      const t0 = Date.now();
      for (let i = 0; i < n; i++) {
        await appendTurn(db, s.id, { userContent: `u${i}`.repeat(5), assistantContent: `a${i}`.repeat(20) });
      }
      const seedMs = Date.now() - t0;

      // 分页：取最近 100 轮
      const t1 = Date.now();
      for (let k = 0; k < 20; k++) await listRecentTurns(db, s.id, 2, 'active');
      const pageMs = (Date.now() - t1) / 20;

      // 摘要去重：构造 100 条摘要（n/50 窗口）
      const all = await db.turns.where('sessionId').equals(s.id).toArray();
      const seqOfTurn = new Map(all.map((t) => [t.id, t.seq]));
      const actives = all.filter((t) => t.status === 'active').map((t) => t.seq);
      const summaries: SummaryView[] = [];
      for (let i = 0; i < actives.length; i += 50) {
        summaries.push({
          id: `sv${i}`,
          sessionId: s.id,
          coversTurnIds: all.slice(i, i + 50).map((t) => t.id),
          content: 'x'.repeat(500),
          status: 'ok',
          retryCount: 0,
          sourceRevisionIds: [],
          createdAt: i,
        });
      }
      const t2 = Date.now();
      for (let k = 0; k < 20; k++)
        dedupeSummariesForInjection(summaries, actives, seqOfTurn);
      const dedupeMs = (Date.now() - t2) / 20;

      // eslint-disable-next-line no-console
      console.log(
        `[I-10] n=${n} 建库=${seedMs}ms | 分页(20次均)=${pageMs.toFixed(1)}ms | 去重(${summaries.length}条)=${dedupeMs.toFixed(1)}ms`,
      );
      db.close();
    }, 300_000);
  }
});
