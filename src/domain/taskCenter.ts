/**
 * 后台任务中心（§5.5 / 阶段二）。
 *
 * 统一状态机：`queued → running → done | failed`。
 * 失败按退避阶梯回到 `queued`（`nextRunAt` 未到不取），达到 `maxAttempts` 后停在 `failed`，
 * 由指示器持续提示、用户可手动触发 —— **失败变成后台状态，而不是用户任务**（§1.2 的核心承诺）。
 *
 * 两条调度约束：
 *  1. **入队幂等**：同 `sessionId + type + dedupeKey` 存在未终态任务时不重复排队。
 *     否则每轮对话都可能为同一窗口堆一堆任务。
 *  2. **空闲执行 / 流式暂停**（§5.11）：`setStreaming(true)` 期间 `pump()` 不取任务，
 *     避免抢占 API 配额与主线程。spec 允许「暂停或降速」，此处选**暂停**——可测且更保守。
 */
import type { NarraDB } from '../schema/db';
import type { BackgroundTask } from '../schema/entities';
import { newId, now } from '../schema/ids';

export type TaskType = BackgroundTask['type'];
export type TaskHandler = (db: NarraDB, task: BackgroundTask) => Promise<void>;

export interface EnqueueInput {
  sessionId: string;
  type: TaskType;
  dedupeKey?: string;
  payload?: unknown;
  /** 延迟到该时刻才可执行（退避用） */
  nextRunAt?: number;
}

export interface TaskCenterOptions {
  /** 自动重试上限，默认 5 */
  maxAttempts?: number;
  /** 单轮 pump 最多执行多少任务，防止长队列占满一轮事件循环 */
  maxPerPump?: number;
}

const TERMINAL: BackgroundTask['status'][] = ['done', 'failed'];

/**
 * 是否「重试也没用」的终态错误（I-22 错误分类）。
 *
 * 鸭子类型读取 `retryable === false`，不 import `modelClient` —— 任务中心是通用调度器，
 * 不该知道具体 client 实现；任何携带 `retryable: false` 的错误都按终态处理。
 */
function isTerminalError(err: unknown): boolean {
  return (err as { retryable?: unknown } | null)?.retryable === false;
}

/** 读取服务端建议的等待时间（429 `Retry-After`），鸭子类型同上 */
function retryAfterMsOf(err: unknown): number | undefined {
  const v = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof v === 'number' && v > 0 ? v : undefined;
}

export class TaskCenter {
  private readonly db: NarraDB;
  private readonly handlers: Partial<Record<TaskType, TaskHandler>>;
  private readonly maxAttempts: number;
  private readonly maxPerPump: number;
  private streaming = false;

  constructor(db: NarraDB, handlers: Partial<Record<TaskType, TaskHandler>>, opts: TaskCenterOptions = {}) {
    this.db = db;
    this.handlers = handlers;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.maxPerPump = opts.maxPerPump ?? 10;
  }

  /** 流式回复进行中 → 暂停后台（§5.11） */
  setStreaming(v: boolean): void {
    this.streaming = v;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  /**
   * 入队。命中未终态的同键任务时返回 null（幂等，不重复排队）。
   */
  async enqueue(input: EnqueueInput): Promise<BackgroundTask | null> {
    const existing = await this.db.tasks
      .where('sessionId')
      .equals(input.sessionId)
      .toArray();
    const clash = existing.find(
      (t) =>
        t.type === input.type &&
        t.dedupeKey === input.dedupeKey &&
        !TERMINAL.includes(t.status),
    );
    if (clash) return null;

    const ts = now();
    const task: BackgroundTask = {
      id: newId('task'),
      sessionId: input.sessionId,
      type: input.type,
      status: 'queued',
      dedupeKey: input.dedupeKey,
      payload: input.payload,
      attempts: 0,
      nextRunAt: input.nextRunAt ?? ts,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.db.tasks.add(task);
    return task;
  }

  /**
   * 取下一个可执行任务（queued 且已过退避期），按 createdAt 升序。
   *
   * ⚠️ 实测坑：`tasks` 表只声明了 `[sessionId+status]` 复合索引，**没有** `status` 单列索引，
   *    所以 `where('status').equals()` 会直接抛 SchemaError（不是返回空）。
   *    这里全量取再过滤 —— 任务表规模是「数十条」量级，为它加一个 Dexie 版本不划算。
   *    若将来任务量真的涨到需要索引，加 `status` 索引并升 v4（走 §4.3 迁移框架）。
   */
  private async next(): Promise<BackgroundTask | null> {
    const ts = now();
    const queued = (await this.db.tasks.toArray())
      .filter((t) => t.status === 'queued' && (t.nextRunAt ?? 0) <= ts)
      .sort((a, b) => a.createdAt - b.createdAt);
    return queued[0] ?? null;
  }

  /**
   * 执行队列。**流式期间返回 0（暂停）**，不取任务。
   * @returns 本轮实际处理的任务数
   *
   * ⚠️ 退避计时与流式暂停的交互（刻意设计）：
   *    `nextRunAt` 是**绝对时刻**，流式期间照常推进 —— 若暂停计时器，
   *    流式一结束所有退避中的任务会同时到期并集中爆发。
   *    现在的行为是「计时继续走，执行前看 streaming，是就推迟到下次空闲轮询」，
   *    再叠加 `maxPerPump` 上限，爆发被压成每轮最多 N 个。
   */
  async pump(): Promise<number> {
    if (this.streaming) return 0;

    let processed = 0;
    while (processed < this.maxPerPump) {
      const task = await this.next();
      if (!task) break;

      await this.db.tasks.update(task.id, { status: 'running', updatedAt: now() });
      const handler = this.handlers[task.type];

      try {
        if (!handler) throw new Error(`未注册的任务处理器：${task.type}`);
        await handler(this.db, task);
        await this.db.tasks.update(task.id, {
          status: 'done',
          progress: 1,
          updatedAt: now(),
        });
      } catch (err) {
        const attempts = (task.attempts ?? 0) + 1;
        // 不可重试错误直接终态 —— 不消耗退避配额（I-22 错误分类）。
        // 让「重试也不会成功」的错误重试 N 次，等于白扔 N 次配额，
        // 还会让真正可恢复的窗口提前撞上 maxAttempts 而永久停在 failed。
        const terminal = isTerminalError(err);
        const dead = terminal || attempts >= this.maxAttempts;
        const local = this.backoff(attempts);
        const retryAfter = retryAfterMsOf(err); // 429 的 Retry-After
        await this.db.tasks.update(task.id, {
          status: dead ? 'failed' : 'queued',
          attempts,
          progress: 0,
          lastError: err instanceof Error ? err.message : String(err),
          nextRunAt: dead ? undefined : now() + (retryAfter ? Math.max(local, retryAfter) : local),
          updatedAt: now(),
        });
      }
      processed += 1;
    }
    return processed;
  }

  /** 退避阶梯（与摘要服务共用同一组常量语义） */
  private backoff(attempt: number): number {
    const steps = [2_000, 10_000, 30_000, 120_000];
    return steps[Math.min(Math.max(attempt - 1, 0), steps.length - 1)];
  }

  /**
   * 立即重试：清除退避期，但**保留 attempts**。
   *
   * 刻意不重置计数 —— 否则「达到 maxAttempts 停 failed」的语义会被手动点击绕过，
   * 失败任务可以无限刷新配额。手动重试表达的是「现在就再试一次」，不是「从头再来」。
   * 真正要重新开始（已 failed 的终态任务）请用 `resetTask`。
   */
  async retryNow(taskId: string): Promise<boolean> {
    const task = await this.db.tasks.get(taskId);
    if (!task) return false;
    await this.db.tasks.update(taskId, {
      status: 'queued',
      nextRunAt: now(),
      updatedAt: now(),
    });
    return true;
  }

  /**
   * 终态（failed）任务重新开始：重置 attempts 与退避期。
   * 与 retryNow 的区别就在于「是否清零计数」—— 这是用户显式「再给一次机会」的入口。
   */
  async resetTask(taskId: string): Promise<boolean> {
    const task = await this.db.tasks.get(taskId);
    if (!task) return false;
    await this.db.tasks.update(taskId, {
      status: 'queued',
      attempts: 0,
      nextRunAt: now(),
      lastError: undefined,
      updatedAt: now(),
    });
    return true;
  }

  /** 供指示器统计 */
  async counts(sessionId?: string): Promise<Record<BackgroundTask['status'], number>> {
    const all = sessionId
      ? await this.db.tasks.where('sessionId').equals(sessionId).toArray()
      : await this.db.tasks.toArray();
    const out: Record<BackgroundTask['status'], number> = {
      queued: 0,
      running: 0,
      done: 0,
      failed: 0,
    };
    for (const t of all) out[t.status] += 1;
    return out;
  }
}

/**
 * 为一个会话把待生成窗口全部入队。返回真正新入队的数量（幂等命中的不计）。
 *
 * ⚠️ dedupeKey **必须用 turnIds**，不能用 `fromSeq-toSeq`（I-17）：
 *    `recoverTimedOutPending` 恢复的窗口拿不到原始 seq 区间（只有 coversTurnIds），
 *    若用 seq 会退化成 `0-0`，多个不同的超时窗口互相碰撞，只入队第一个、其余静默丢失。
 *
 *    本质是**输入契约问题，不是 key 写错**：正常路径与恢复路径的输入形态不同
 *    （前者有 seq 区间，后者只有 turnIds），而 key 生成依赖了只有正常路径才有的字段。
 *    任何新增的入队入口，都要先问「这个调用方拿不拿得到 seq 区间」。
 *
 *    ⚠️ 不要为了「更快 / 更短」把它改回 seq 版本 —— 那会重新打开 I-17。
 */
export function windowDedupeKey(turnIds: string[]): string {
  return [...turnIds].sort().join('|');
}

export async function enqueueSummaryWindows(
  center: TaskCenter,
  sessionId: string,
  windows: Array<{ turnIds: string[]; fromSeq?: number; toSeq?: number }>,
): Promise<number> {
  let added = 0;
  for (const w of windows) {
    const t = await center.enqueue({
      sessionId,
      type: 'summarize',
      dedupeKey: windowDedupeKey(w.turnIds),
      payload: w,
    });
    // 幂等命中返回 null；若该窗口此前失败过（终态 failed），enqueue 会重新排队 —— 这是期望行为
    if (t) added += 1;
  }
  return added;
}
