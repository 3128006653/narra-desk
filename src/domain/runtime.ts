/**
 * 运行时组装（阶段二）：把「摘要服务 + 任务中心 + 指示器」接成可用的一条链路。
 *
 * 这里是**唯一**知道各模块如何拼装的地方；上层（UI / 下周的组装器）只调：
 *   - `scheduleSummaries(sessionId)`：为该会话的待生成窗口入队
 *   - `pump()`：空闲时驱动队列（流式期间自动暂停）
 *   - `indicator(sessionId)`：拿指示器数字
 *   - `recover(sessionId)`：启动时兜底（pending 超时 + 同区间裁剪）
 *
 * ⚠️ **职责边界（防止长成上帝对象）**：
 *   本文件**只做依赖注入与生命周期编排，不做业务逻辑**。
 *   判定标准：任何「规则/阈值/状态转换」都不应出现在这里 —— 它们属于各自 domain 模块
 *   （窗口规划与生成在 `summaryService`，退避与状态机在 `taskCenter`，
 *   覆盖与空洞计算在 `indicator` / `summary`）。
 *   若发现本文件开始出现 `if (某业务条件)`，说明有逻辑放错了位置。
 *   三个月后若它变成了第二个 `main.ts`，就是这条边界失守了。
 */
import type { NarraDB } from '../schema/db';
import type { ServiceRef } from '../schema/entities';
import { TaskCenter, enqueueSummaryWindows } from './taskCenter';
import {
  MAX_ATTEMPTS,
  fromPayload,
  planPendingWindows,
  listStubSummaries,
  pruneSummaryDuplicates,
  recoverTimedOutPending,
  runSummarizeWindow,
} from './summaryService';
import { ChatError, type ChatClient } from './modelClient';
import { computeIndicator, type IndicatorState } from './indicator';

export interface RuntimeOptions {
  client: ChatClient;
  /**
   * 取某会话的总结模型。§5.3：未设置 summarizer 时「跟随主模型」，
   * 由调用方决定跟随策略 —— 运行时不替用户做这个选择。
   */
  resolveSummarizer: (sessionId: string) => Promise<ServiceRef>;
  maxAttempts?: number;
}

export class Runtime {
  readonly center: TaskCenter;
  private readonly db: NarraDB;
  private readonly opts: RuntimeOptions;

  constructor(db: NarraDB, opts: RuntimeOptions) {
    this.db = db;
    this.opts = opts;
    this.center = new TaskCenter(
      db,
      {
        summarize: async (dbx, task) => {
          const window = fromPayload(task);
          if (!window) throw new Error('摘要任务缺少有效 payload');
          const res = await runSummarizeWindow({
            db: dbx,
            sessionId: task.sessionId,
            window,
            client: this.opts.client,
            summarizer: await this.opts.resolveSummarizer(task.sessionId),
            attempt: task.attempts ?? 0,
            // 未声明的 client 按 'model' 处理（I-16）；占位摘要器必须显式声明 stub
            source: this.opts.client.source ?? 'model',
          });
          // 生成失败要抛出，让任务中心走退避重试；
          // 摘要记录本身已落 failed（带 coversTurnIds），空洞计算仍知情。
          // 注意：runSummarizeWindow 内部抛的是 ChatError，其 retryable / retryAfterMs
          // 会在**它自己**的 catch 里被重新抛出（见 summaryService），
          // 这里只是兜底 —— 不要把它包成普通 Error，否则终态分类与 Retry-After 全丢。
          if (res.status !== 'ok') throw new ChatError(res.error ?? '摘要生成失败', true);
        },
      },
      { maxAttempts: opts.maxAttempts ?? MAX_ATTEMPTS },
    );
  }

  /** 把待生成窗口入队（幂等：已覆盖或已在队列的窗口不会重复排队） */
  async scheduleSummaries(sessionId: string): Promise<number> {
    const windows = await planPendingWindows(this.db, sessionId);
    return enqueueSummaryWindows(this.center, sessionId, windows);
  }

  /** 空闲时驱动；流式期间由 TaskCenter 自行暂停 */
  pump(): Promise<number> {
    return this.center.pump();
  }

  setStreaming(v: boolean): void {
    this.center.setStreaming(v);
  }

  /**
   * 流式状态只读查询。存在理由：`setStreaming` 的复位必须能被断言 ——
   * 若异常路径漏掉 finally，后台会永久停摆且**没有任何报错**，
   * 只能靠「isStreaming 是否复位」这类可观测状态发现。
   */
  isStreaming(): boolean {
    return this.center.isStreaming;
  }

  /**
   * 启动时兜底（I-14 / I-15 / I-19）：
   *  1. 超时 pending → failed 并重新入队（否则崩溃一次就永久损失一个窗口）
   *  2. 同区间重复记录裁剪到 1 条
   *  3. **无状态检查**：存在 stub 摘要就入队重建（不依赖任何一次性标志）
   * 顺序不能反：先裁剪会把超时 pending 当成重复项删掉，反而丢了待补信息。
   *
   * ⚠️ 第 3 步为什么必须是无状态的（I-19）：
   *    `onMigrated` 置的是**内存标志**，存在崩溃窗口 ——
   *    迁移事务提交 → 置标志 → Runtime 建好之前进程崩溃 → 下次启动 Dexie 版本已是 v4，
   *    `onMigrated` 不再触发 → 标志丢失 → stub 摘要永远不被重建，
   *    而 `isInjectableSummary` 会一直排除它们、区间一直转空洞。
   *    这里每次启动都扫一遍，幂等且不依赖标志，崩溃窗口被覆盖。
   *    `onMigrated` 只作为「迁移后立即触发一次」的优化，不是唯一触发路径。
   */
  async recover(
    sessionId: string,
  ): Promise<{ requeued: number; pruned: number; stubRebuild: number; orphansRemoved: number }> {
    const windows = await recoverTimedOutPending(this.db, sessionId);
    const requeued = await enqueueSummaryWindows(this.center, sessionId, windows);
    const pruned = await pruneSummaryDuplicates(this.db, sessionId);

    // 无状态兜底：有 stub 就重建，无论本次是否发生过迁移。
    const { enqueued: stubRebuild, orphansRemoved } = await this.rebuildStubSummaries(sessionId);

    return { requeued, pruned, stubRebuild, orphansRemoved };
  }

  /**
 * 重建所有 stub 摘要。
 *
 * 恢复路径：见 RECOVERY.md 三条检查（输入字段 / 重算基准 / 标志来源）。
 * 此处对应第 3 条 —— 触发不依赖任何一次性标志，靠无状态扫描（I-19）；
 * 并对应第 1 条 —— 孤儿清理必须在入队前做，不能等任务执行时才发现会话不存在（I-20）。
 */
  async rebuildStubSummaries(
    sessionId?: string,
  ): Promise<{ enqueued: number; orphansRemoved: number }> {
    const stubs = await listStubSummaries(this.db, sessionId);

    let orphansRemoved = 0;
    const alive: typeof stubs = [];
    for (const s of stubs) {
      const session = await this.db.sessions.get(s.sessionId);
      if (!session) {
        await this.db.summaries.delete(s.id);
        orphansRemoved += 1;
        continue;
      }
      alive.push(s);
    }

    // 按各自的 sessionId 入队（不限定会话时 stub 可能跨会话），不能用 '' 兜底
    let enqueued = 0;
    for (const s of alive) {
      enqueued += await enqueueSummaryWindows(this.center, s.sessionId, [
        { turnIds: s.coversTurnIds },
      ]);
    }
    return { enqueued, orphansRemoved };
  }

  async indicator(
    sessionId: string,
    input: Parameters<typeof computeIndicator>[2] = {},
  ): Promise<IndicatorState> {
    return computeIndicator(this.db, sessionId, input);
  }
}
