/**
 * 摘要生成服务（§5.8 / 阶段二）。
 *
 * 三条硬约束：
 *  1. **写入侧零裁剪**：新摘要直接写，不与已有摘要比对裁剪（不变量 #4）。
 *     去重只发生在注入时（`dedupeSummariesForInjection`）。
 *  2. **失败必须落记录**：pending / failed 摘要也要带上 `coversTurnIds`。
 *     否则空洞计算无从知道「这段有窗口但没成」，指示器也报不出「N 段摘要待补」。
 *     —— 这与「写入侧零裁剪」是同一条原则的两面：元数据永不说谎。
 *  3. **失败不进注入、不阻塞对话**：status ∈ {pending, failed, stale} 的区间转空洞，
 *     由组装器回退注入最近 K 轮原始 Turn（`selectHoleFallbackTurns`）。
 */
import type { NarraDB } from '../schema/db';
import type { BackgroundTask, ServiceRef, SummaryView, TurnRevision } from '../schema/entities';
import { newId, now } from '../schema/ids';
import type { ChatClient, ChatMessage } from './modelClient';
import { ChatError, retryAfterMsOf } from './modelClient';
import { recordTokenSample } from './tokenCalibration';
import {
  DEFAULT_SUMMARY_WINDOW,
  isSummarizable,
  planSummaryWindows,
  windowCoverage,
  type SummaryWindow,
} from './summary';

/** 重退避阶梯（ms）。超出长度即取末值 —— 不会无限加速重试 */
export const BACKOFF_MS = [2_000, 10_000, 30_000, 120_000];
/** 自动重试上限；达到后停在 failed，由用户手动触发（指示器会持续提示） */
export const MAX_ATTEMPTS = 5;

export function backoffDelay(attempt: number): number {
  const idx = Math.min(Math.max(attempt - 1, 0), BACKOFF_MS.length - 1);
  return BACKOFF_MS[idx];
}

export const SUMMARY_SYSTEM_PROMPT =
  '你是叙事摘要器。只输出对后续剧情有用的事实：地点、人物状态、承诺、未解决的冲突。' +
  '不要复述对话原文，不要评价，不要输出小节标题。保持第三人称客观陈述。';

export interface WindowTurn {
  seq: number;
  userContent: string;
  assistantContent: string;
}

/** 组装摘要请求消息；`prior` 为上一窗口摘要（滚动摘要的衔接） */
export function buildSummaryMessages(
  turns: WindowTurn[],
  prior?: string,
): ChatMessage[] {
  const body = turns
    .map((t) => `用户：${t.userContent}\n助手：${t.assistantContent}`)
    .join('\n');
  const messages: ChatMessage[] = [{ role: 'system', content: SUMMARY_SYSTEM_PROMPT }];
  if (prior) {
    messages.push({ role: 'assistant', content: `（此前已发生）${prior}` });
  }
  messages.push({ role: 'user', content: `请摘要以下对话：\n${body}` });
  return messages;
}

/**
 * 规划待生成窗口：**写入侧零裁剪**，但不必为「已被 ok 摘要完全覆盖」的窗口重复烧 token。
 * `windowCoverage === 'full'` 的窗口跳过；'partial' / 'none' 都要生成。
 *
 * ⚠️ greeting（seq 0）**不计入摘要窗口**：
 *   它是 `first_mes` 静态资产的物化产物，摘要它没有意义，
 *   且它占掉一个 seq 会让每个窗口边界整体偏移一轮（窗口大小变成 49 有效 + 1 greeting）。
 *   排除后 seq 1..N 干净对齐 —— 记为 I-11。
 */
export async function planPendingWindows(
  db: NarraDB,
  sessionId: string,
  windowSize = DEFAULT_SUMMARY_WINDOW,
): Promise<SummaryWindow[]> {
  const turns = await db.turns.where('sessionId').equals(sessionId).toArray();
  const active = turns
    .filter((t) => t.status === 'active' && isSummarizable(t.seq))
    .sort((a, b) => a.seq - b.seq);
  const okSummaries = (await db.summaries.where('sessionId').equals(sessionId).toArray()).filter(
    (s) => s.status === 'ok',
  );
  return planSummaryWindows(active.map((t) => ({ id: t.id, seq: t.seq })), windowSize).filter(
    (w) => windowCoverage(w, okSummaries) !== 'full',
  );
}

async function loadWindowTurns(
  db: NarraDB,
  sessionId: string,
  window: SummaryWindow,
): Promise<{ turns: WindowTurn[]; revisionIds: string[] }> {
  const ids = new Set(window.turnIds);
  const turns = (await db.turns.where('sessionId').equals(sessionId).toArray()).filter((t) =>
    ids.has(t.id),
  );
  const revisions: TurnRevision[] = [];
  for (const t of turns) {
    const rev = await db.revisions.get(t.activeRevisionId);
    if (rev) revisions.push(rev);
  }
  const ordered = turns.sort((a, b) => a.seq - b.seq);
  return {
    turns: ordered.map((t) => {
      const rev = revisions.find((r) => r.id === t.activeRevisionId);
      return {
        seq: t.seq,
        userContent: rev?.userContent ?? '',
        assistantContent: rev?.assistantContent ?? '',
      };
    }),
    revisionIds: revisions.map((r) => r.id),
  };
}

export interface RunSummarizeInput {
  db: NarraDB;
  sessionId: string;
  window: SummaryWindow;
  client: ChatClient;
  summarizer: ServiceRef;
  /** 产物来源（I-16）；缺省 'model'。占位摘要器必须传 'stub' */
  source?: 'stub' | 'model';
  /** 已尝试次数（由任务中心传入）；仅用于记录，退避由任务中心控制 */
  attempt?: number;
}

export interface RunSummarizeResult {
  summaryId: string;
  status: SummaryView['status'];
  error?: string;
}

/**
 * 生成一个窗口的摘要。
 *
 * 顺序：**先落 pending 记录**（带完整 coversTurnIds）→ 调模型 → ok / failed。
 * 中途崩溃也至少留下 pending 行，空洞计算仍知道这段待补。
 */
export async function runSummarizeWindow(
  input: RunSummarizeInput,
): Promise<RunSummarizeResult> {
  const { db, sessionId, window, client, summarizer } = input;
  const ts = now();

  const existing = await findWindowRecord(db, sessionId, window);
  const summaryId = existing?.id ?? newId('sum');
  const source = input.source ?? 'model';

  if (!existing) {
    const pending: SummaryView = {
      id: summaryId,
      sessionId,
      coversTurnIds: window.turnIds,
      content: '',
      status: 'pending',
      retryCount: 0,
      sourceRevisionIds: [],
      createdAt: ts,
      updatedAt: ts,
      // 新建时按调用方声明写入；stub 记录新建即为 `stub`，
      // 只有成功分支才把它改成 `model`（见 SummaryView.source 的单一写入点约定）
      source,
    };
    await db.summaries.add(pending);
  } else {
    await db.summaries.update(summaryId, {
      status: 'retrying',
      retryCount: (existing.retryCount ?? 0) + (input.attempt && input.attempt > 0 ? 1 : 0),
      lastError: undefined,
      updatedAt: now(),
      // ⚠️ 不动 source（I-21 覆盖策略）：stub 记录在**成功前**保持 `stub`，
      //    成功后才改 `model`。否则一次失败的重试会把伪摘要伪装成真摘要放行注入。
    });
  }

  try {
    const { turns, revisionIds } = await loadWindowTurns(db, sessionId, window);
    if (turns.length === 0) {
      await db.summaries.update(summaryId, {
        status: 'failed',
        lastError: '窗口内没有可摘要的轮次',
      });
      return { summaryId, status: 'failed', error: '窗口内没有可摘要的轮次' };
    }

    const prior = await previousOkSummary(db, sessionId, window);
    const messages = buildSummaryMessages(turns, prior);
    const content = await client.complete({ service: summarizer, messages });

    // token 校准：自动记录，不靠手动记（手动记 50–100 条一定会漏）。
    // 按 model family 分组统计，见 tokenCalibration.ts。
    const usage = (client as { lastPromptTokens?: number }).lastPromptTokens;
    if (usage !== undefined) {
      recordTokenSample(db, {
        model: summarizer.model,
        family: (summarizer.parameters as { family?: string } | undefined)?.family,
        text: messages.map((m) => m.content).join('\n'),
        usagePromptTokens: usage,
      });
    }

    if (!content || !content.trim()) {
      throw new ChatError('摘要结果为空', true);
    }

    await db.summaries.update(summaryId, {
      status: 'ok',
      content: content.trim(),
      sourceRevisionIds: revisionIds,
      retryCount: 0,
      lastError: undefined,
      createdAt: now(),
      updatedAt: now(),
      // ✅ **唯一允许的 `source` 写入点**：只有模型真正返回成功才改成 'model'。
      //    其他任何分支都不许写 source（见 SummaryView.source 字段注释）。
      source,
    });
    return { summaryId, status: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const record = (await db.summaries.get(summaryId))!;
    await db.summaries.update(summaryId, {
      status: 'failed',
      retryCount: record.retryCount + 1,
      lastError: message,
      updatedAt: now(),
      // I-21：失败保持原 source。stub 记录失败后仍是 stub，
      // 不会因一次带着 model client 的失败尝试而变成「看起来可信」的 model 摘要。
      source: record.source ?? source,
    });
    // 抛出以驱动任务中心的退避/终态判定。**保留 ChatError 的可重试语义** ——
    // 不可重试错误（内容过滤/4xx）不应消耗退避配额（见上方错误分类表）。
    if (err instanceof ChatError) throw err;
    throw new ChatError(message, true, retryAfterMsOf(err));
  }
}

/** 同窗口已有记录则复用其 id（pending/failed/stale 均可被后续尝试接管） */
async function findWindowRecord(
  db: NarraDB,
  sessionId: string,
  window: SummaryWindow,
): Promise<SummaryView | undefined> {
  const wanted = new Set(window.turnIds);
  const all = await db.summaries.where('sessionId').equals(sessionId).toArray();
  return all.find((s) => {
    if (s.status === 'superseded') return false;
    if (s.coversTurnIds.length !== wanted.size) return false;
    return s.coversTurnIds.every((id) => wanted.has(id));
  });
}

/**
 * 滚动摘要的衔接：取一条**与当前窗口无交集**的最近 ok 摘要作为「此前已发生」。
 * 无交集即代表它覆盖的是别的窗口；取 createdAt 最大者即「最近的上一段」。
 */
async function previousOkSummary(
  db: NarraDB,
  sessionId: string,
  window: SummaryWindow,
): Promise<string | undefined> {
  const wanted = new Set(window.turnIds);
  const others = (await db.summaries.where('sessionId').equals(sessionId).toArray())
    .filter((s) => s.status === 'ok' && s.content)
    .filter((s) => !s.coversTurnIds.some((id) => wanted.has(id)))
    .sort((a, b) => a.createdAt - b.createdAt);
  return others.length > 0 ? others[others.length - 1].content : undefined;
}

/**
 * 错误分类（**真实 client 接入时按此表实现**，阶段二末落地）：
 *
 * | 类别 | 例子 | 是否重试 |
 * |---|---|---|
 * | 可重试 | 超时、限流（429）、5xx、`ECONNRESET` | **是** —— 走退避阶梯 |
 * | 不重试 | 内容过滤、参数错误、401/403、404、400 | **否** —— 直接 `failed` |
 *
 * 区分的收益不只是省 token：不可重试错误若照常消耗退避配额，
 * 会让真正可恢复的窗口提前撞上 `MAX_ATTEMPTS` 而永久停在 `failed`。
 * 「重试也不会成功」的错误重试 4 次，等于白扔 4 次配额。
 *
 * 实现位置：`ChatError` 携带 `retryable` 标志（见 `modelClient`）；
 * `runSummarizeWindow` 失败时**原样抛出 ChatError**，任务中心据此决定
 * 「进入退避队列」还是「立即终态 failed」。
 *
 * **429 的特殊处理（I-22）**：`Retry-After` 存在时用 `max(本地退避, Retry-After)`。
 *   本地指数退避（2s/10s/30s/120s）可能与服务端要求冲突：
 *   短于 `Retry-After` 会连续撞限流、浪费配额；长于则无谓延迟。
 *   由 `ChatError.retryAfterMs` 携带，任务中心取 max。
 */
export const RETRYABLE_HINT = {
  retryable: ['timeout', 'rate_limit', '5xx', 'network'],
  terminal: ['content_filter', 'invalid_request', '401', '403', '404', '400'],
} as const;

/**
 * I-14：pending 超时恢复。
 *
 * 恢复路径：见 RECOVERY.md 三条检查（输入字段 / 重算基准 / 标志来源）。
 * 此处对应第 1 条 —— 恢复路径只有 `coversTurnIds`，没有 seq 区间（I-17）。
 *
 * 「先落 pending 再调模型」让崩溃后有迹可循，代价是**进程崩溃时记录会永久停在 pending** ——
 * 没有调用方会再来接管它，指示器也只会一直显示「N 段摘要待补」却永远不补。
 * 这是崩溃恢复路径的必经环节，启动时扫一次即可。
 *
 * 判定：`status ∈ {pending, retrying}` 且 `updatedAt` 早于阈值 → 转 `failed` 并回传窗口，
 * 由调用方重新入队。转 failed 而非直接删除，保留「这段曾经尝试过且没成」的事实。
 */
export const PENDING_TIMEOUT_MS = 5 * 60_000;

export async function recoverTimedOutPending(
  db: NarraDB,
  sessionId?: string,
  timeoutMs = PENDING_TIMEOUT_MS,
): Promise<SummaryWindow[]> {
  const deadline = now() - timeoutMs;
  const all = sessionId
    ? await db.summaries.where('sessionId').equals(sessionId).toArray()
    : await db.summaries.toArray();

  const timedOut = all.filter(
    (s) => (s.status === 'pending' || s.status === 'retrying') && (s.updatedAt ?? s.createdAt) < deadline,
  );

  await Promise.all(
    timedOut.map((s) =>
      db.summaries.update(s.id, {
        status: 'failed',
        lastError: '生成超时（疑似进程中断），已重新排队',
        updatedAt: now(),
      }),
    ),
  );

  return timedOut.map((s) => ({
    turnIds: s.coversTurnIds,
    fromSeq: 0,
    toSeq: 0,
  }));
}

/**
 * I-15：同一 `coversTurnIds` 区间至多保留最近 1 条 —— 与 FactView 的裁剪规则对齐。
 *
 * 保留优先级（**不是简单按时间砍**）：
 *   `stale` > `ok` > `pending`/`retrying` > `failed`/`superseded`，同级取最新。
 *
 * 为什么 `ok` 优先于 `failed`：窗口的最新记录可能是某次失败重试，
 * 直接按 createdAt 砍会丢掉已有的有效覆盖（对原建议的实质修正，见 ISSUES.md I-15）。
 *
 * 为什么 `stale` 优先于 `ok`（I-18）：`stale` 意味着源 Turn 已被修订，
 * 同组的 `ok` 内容是**基于旧输入生成的过时摘要**；保留它会让过时内容继续被注入，
 * 比保留 `stale`（同样不注入、区间转空洞、等后台重建）更糟。
 *
 * ⚠️ 前提：`markViewsStale` 目前把同区间**所有**摘要（含 `ok`）一起标 `stale`
 *    （见 `turnStore.markViewsStale`：按 `coversTurnIds` 取交集，不过滤 status），
 *    所以正常路径下不会出现 `ok` 与 `stale` 长期并存，上面这条是**防御性**分支。
 *    若将来放宽 `markViewsStale` 的标记范围（例如只标最新一条），
 *    此处的优先级顺序就是必需的，不是可选的 —— 改动前先看这条注释。
 *
 * 历史追溯走 Turn amendment 记录，摘要表不是审计日志（同 FactView）。
 */
export async function pruneSummaryDuplicates(db: NarraDB, sessionId: string): Promise<number> {
  const all = await db.summaries.where('sessionId').equals(sessionId).toArray();
  const groups = new Map<string, SummaryView[]>();
  for (const s of all) {
    const key = [...s.coversTurnIds].sort().join('|');
    const bucket = groups.get(key);
    if (bucket) bucket.push(s);
    else groups.set(key, [s]);
  }

  let removed = 0;
  for (const bucket of groups.values()) {
    if (bucket.length <= 1) continue;
    const byNewest = [...bucket].sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
    const ranked = [...byNewest].sort((a, b) => KEEP_RANK[b.status] - KEEP_RANK[a.status]);
    const keep = ranked[0];
    for (const s of byNewest) {
      if (s.id === keep.id) continue;
      await db.summaries.delete(s.id);
      removed += 1;
    }
  }
  return removed;
}

/** 保留优先级：数值越大越值得留（I-18） */
const KEEP_RANK: Record<string, number> = {
  stale: 4,       // 已知需重建，且不注入过时内容
  ok: 3,          // 可注入
  retrying: 2,
  pending: 2,     // 会被后续生成接手
  failed: 1,
  superseded: 0,
};

/**
 * I-16：扫出全部 stub 摘要，交调用方用真实 client 重建。
 * 返回窗口列表；重建期间它们因 `isInjectableSummary` 为 false 而不注入、区间转空洞。
 */
export async function listStubSummaries(db: NarraDB, sessionId?: string): Promise<SummaryView[]> {
  const all = sessionId
    ? await db.summaries.where('sessionId').equals(sessionId).toArray()
    : await db.summaries.toArray();
  return all.filter((s) => s.source === 'stub');
}

/** 任务负载序列化 */
export interface SummarizePayload {
  turnIds: string[];
  fromSeq: number;
  toSeq: number;
}

export function toPayload(window: SummaryWindow): SummarizePayload {
  return { turnIds: window.turnIds, fromSeq: window.fromSeq, toSeq: window.toSeq };
}

export function fromPayload(task: BackgroundTask): SummaryWindow | null {
  const p = task.payload as SummarizePayload | undefined;
  if (!p || !Array.isArray(p.turnIds)) return null;
  return { turnIds: p.turnIds, fromSeq: p.fromSeq ?? 0, toSeq: p.toSeq ?? 0 };
}
