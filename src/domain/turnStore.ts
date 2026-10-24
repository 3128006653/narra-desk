/**
 * TurnStore 与编辑语义（v0.6.2 / 阶段一核心（I-3 已定案））。
 *
 * 不变量落点：
 *  #1 seq 单调递增、永不复用 —— expectedSeq 乐观锁 + DB 层 &[sessionId+seq] 唯一索引
 *  #2 discard 只作用于 Turn / stale 只作用于派生物；amend 永不 discard
 *  #3 恢复仅在截断后无新写入时可用；否则废弃分支只读
 */
import type { Table, Transaction } from 'dexie';
import type { NarraDB } from '../schema/db';
import type {
  FactView,
  RevisionReason,
  RevisionStatus,
  Session,
  SessionModelBinding,
  SummaryView,
  Turn,
  TurnRevision,
  VectorIndex,
} from '../schema/entities';
import { newId, now } from '../schema/ids';
import { TurnSchema, TurnRevisionSchema } from '../schema/zod';
import {
  GreetingLockedError,
  ReadOnlyBranchError,
  TurnNotFoundError,
  WriteConflictError,
} from './errors';

/** greeting 物化为 seq 0 的 assistant Turn（单一真相源） */
export const GREETING_SEQ = 0;

export interface CreateSessionInput {
  characterId: string;
  title: string;
  modelBinding: SessionModelBinding;
  greetingAssetId: string;
  greetingContent: string;
  boundAssetIds?: string[];
  lorebookBinding?: { assetIds: string[]; overrides?: Record<string, unknown> };
}

export async function createSession(
  db: NarraDB,
  input: CreateSessionInput,
): Promise<Session> {
  return db.transaction(
    'rw',
    [db.sessions, db.turns, db.revisions],
    async () => {
      const ts = now();
      const session: Session = {
        id: newId('sess'),
        characterId: input.characterId,
        title: input.title,
        modelBinding: input.modelBinding,
        boundAssetIds: input.boundAssetIds ?? [input.greetingAssetId],
        lorebookBinding: input.lorebookBinding ?? { assetIds: [] },
        expectedSeq: GREETING_SEQ,
        createdAt: ts,
        updatedAt: ts,
      };

      const turnId = newId('turn');
      const revisionId = newId('rev');
      const turn: Turn = {
        id: turnId,
        sessionId: session.id,
        seq: GREETING_SEQ,
        activeRevisionId: revisionId,
        status: 'active',
        createdAt: ts,
      };
      const revision: TurnRevision = {
        id: revisionId,
        turnId,
        userContent: '',
        assistantContent: input.greetingContent,
        status: 'active',
        reason: 'initial',
        requestId: newId('req'),
        createdAt: ts,
      };

      TurnSchema.parse(turn);
      TurnRevisionSchema.parse(revision);

      await db.turns.add(turn);
      await db.revisions.add(revision);
      // greeting 占用 seq 0，故首个真实轮次从 1 开始
      session.expectedSeq = GREETING_SEQ + 1;
      await db.sessions.add(session);
      return session;
    },
  );
}

export interface AppendTurnInput {
  userContent: string;
  assistantContent: string;
  /** 本轮实际注入的事实 id（UI 纠错入口依赖；可选） */
  injectedFactIds?: string[];
  /** 可选：调用方持有的期望 seq；与存储侧不一致即冲突 */
  expectedSeq?: number;
  revisionStatus?: RevisionStatus;
  toolTrace?: TurnRevision['toolTrace'];
}

export interface AppendTurnResult {
  turn: Turn;
  revision: TurnRevision;
}

/**
 * 追加一轮。seq 由存储侧 expectedSeq 决定，调用方不可指定 —— 这是 #1 的根。
 */
export async function appendTurn(
  db: NarraDB,
  sessionId: string,
  input: AppendTurnInput,
): Promise<AppendTurnResult> {
  return db.transaction(
    'rw',
    [db.sessions, db.turns, db.revisions],
    async () => {
      const session = await db.sessions.get(sessionId);
      if (!session) throw new Error(`Session 不存在：${sessionId}`);

      if (input.expectedSeq !== undefined && input.expectedSeq !== session.expectedSeq) {
        throw new WriteConflictError(input.expectedSeq, session.expectedSeq);
      }

      const ts = now();
      const seq = session.expectedSeq;
      const turnId = newId('turn');
      const revisionId = newId('rev');

      const turn: Turn = {
        id: turnId,
        sessionId,
        seq,
        activeRevisionId: revisionId,
        status: 'active',
        createdAt: ts,
      };
      const revision: TurnRevision = {
        id: revisionId,
        turnId,
        userContent: input.userContent,
        assistantContent: input.assistantContent,
        status: input.revisionStatus ?? 'active',
        reason: 'initial',
        requestId: newId('req'),
        toolTrace: input.toolTrace,
        injectedFactIds: input.injectedFactIds,
        createdAt: ts,
      };

      TurnSchema.parse(turn);
      TurnRevisionSchema.parse(revision);
      await db.turns.add(turn);
      await db.revisions.add(revision);
      await db.sessions.update(sessionId, { expectedSeq: seq + 1, updatedAt: ts });

      return { turn, revision };
    },
  );
}

// ------------------------------------------------------------ 派生物 stale

export interface StaleReport {
  /** 已标记为 stale 的摘要 id */
  summaries: string[];
  /** 已标记 stale=true 的 FactView id */
  facts: string[];
  /** 已标记 stale=true 的 VectorIndex id */
  vectors: string[];
}

/**
 * 编辑种类 → 各派生物的 staleReason 映射。
 * SummaryView 沿用 §4.1 自己的枚举；FactView / VectorIndex 用 I-3 新增的枚举。
 */
export type EditKind = 'amend' | 'regenerate' | 'truncate' | 'manual';

const SUMMARY_STALE_REASON: Record<EditKind, NonNullable<SummaryView['staleReason']>> = {
  amend: 'turn-edited',
  regenerate: 'turn-edited',
  truncate: 'turn-discarded',
  manual: 'manual',
};

const FACT_STALE_REASON: Record<EditKind, NonNullable<FactView['staleReason']>> = {
  amend: 'turn-amended',
  regenerate: 'turn-regenerated',
  truncate: 'turn-truncated',
  manual: 'manual',
};

const VECTOR_STALE_REASON: Record<EditKind, NonNullable<VectorIndex['staleReason']>> = {
  amend: 'revision-changed',
  regenerate: 'revision-changed',
  truncate: 'revision-changed',
  manual: 'manual',
};

/**
 * 把覆盖到指定 Turn 的派生物标记为 stale（I-3 定案：真实写入，非仅统计）。
 *
 * 只作用于派生物；对 Turn 本身没有任何影响（不变量 #2 后半）。
 * 不变式：stale === true ⟺ staleReason !== undefined
 * （布尔不是合法 IndexedDB key，索引落在 staleReason 上，故二者必须始终同步）。
 */
export async function markViewsStale(
  db: NarraDB,
  sessionId: string,
  turnIds: string[],
  kind: EditKind,
): Promise<StaleReport> {
  const idSet = new Set(turnIds);

  // ---- SummaryView ----
  const summaries = await db.summaries.where('sessionId').equals(sessionId).toArray();
  const hitSummaries = summaries.filter(
    (s) => s.status !== 'superseded' && s.coversTurnIds.some((id) => idSet.has(id)),
  );
  await Promise.all(
    hitSummaries.map((s) =>
      db.summaries.update(s.id, {
        status: 'stale',
        staleReason: SUMMARY_STALE_REASON[kind],
      }),
    ),
  );

  // ---- FactView ----
  const facts = await db.facts.where('sessionId').equals(sessionId).toArray();
  const hitFacts = facts.filter((f) => f.sourceTurnIds.some((id) => idSet.has(id)));
  await Promise.all(
    hitFacts.map((f) =>
      db.facts.update(f.id, {
        stale: true,
        staleReason: FACT_STALE_REASON[kind],
      }),
    ),
  );

  // ---- VectorIndex（按 revision 定位，编辑产生新 revision 即失效）----
  const revisionIds = new Set<string>();
  for (const id of turnIds) {
    const revs = await db.revisions.where('turnId').equals(id).toArray();
    revs.forEach((r) => revisionIds.add(r.id));
  }
  const vectors = await db.vectors.where('sessionId').equals(sessionId).toArray();
  const hitVectors = vectors.filter(
    (v) => v.sourceRevisionId && revisionIds.has(v.sourceRevisionId),
  );
  await Promise.all(
    hitVectors.map((v) =>
      db.vectors.update(v.id, {
        stale: true,
        staleReason: VECTOR_STALE_REASON[kind],
      }),
    ),
  );

  return {
    summaries: hitSummaries.map((s) => s.id),
    facts: hitFacts.map((f) => f.id),
    vectors: hitVectors.map((v) => v.id),
  };
}

/**
 * 后台重建完成后清 stale。
 * 摘要走 status 回 'ok'（重建产物是新摘要），事实与向量清标记。
 */
export async function clearViewStale(
  db: NarraDB,
  input: { facts?: string[]; vectors?: string[]; summaries?: string[] },
): Promise<void> {
  await Promise.all([
    ...(input.facts ?? []).map((id) =>
      db.facts.update(id, { stale: false, staleReason: undefined }),
    ),
    ...(input.vectors ?? []).map((id) =>
      db.vectors.update(id, { stale: false, staleReason: undefined }),
    ),
    ...(input.summaries ?? []).map((id) =>
      db.summaries.update(id, { status: 'ok', staleReason: undefined }),
    ),
  ]);
}

/** 后台任务扫描入口：取某会话全部 stale 事实（staleReason 为合法 key，可索引） */
export async function listStaleFacts(db: NarraDB, sessionId: string): Promise<FactView[]> {
  const all = await db.facts.where('sessionId').equals(sessionId).toArray();
  return all.filter((f) => f.stale === true);
}

/** 后台任务扫描入口：取某会话全部 stale 向量 */
export async function listStaleVectors(db: NarraDB, sessionId: string): Promise<VectorIndex[]> {
  const all = await db.vectors.where('sessionId').equals(sessionId).toArray();
  return all.filter((v) => v.stale === true);
}

// ------------------------------------------------------------ 编辑语义

/** 默认每页 50 轮（§5.11） */
export const PAGE_SIZE = 50;
/** 初始加载最近 2 页 */
export const INITIAL_PAGES = 2;

/**
 * 取会话内全部 Turn（按 seq 升序）。
 * ⚠️ 全量扫描 —— 仅供测试与后台任务使用。**UI 渲染一律走 listTurnsPage / listRecentTurns**，
 *    否则长会话会一次性把几千轮读进内存。
 */
export async function listTurns(db: NarraDB, sessionId: string): Promise<Turn[]> {
  const rows = await db.turns.where('sessionId').equals(sessionId).toArray();
  return rows.sort((a, b) => a.seq - b.seq);
}

export interface PageOptions {
  /** 游标：取 seq < beforeSeq 的轮次；省略则从最新开始 */
  beforeSeq?: number;
  /** 每页条数，默认 PAGE_SIZE */
  limit?: number;
  /** 只取某状态的轮次；省略则不限 */
  status?: Turn['status'];
}

/**
 * 游标分页（§5.11）。返回 seq **降序**，便于「向上滚动增量加载」。
 * 由 Dexie 复合索引 [sessionId+seq]？—— 注意：turns 当前索引为
 * `id, sessionId, &[sessionId+seq], [sessionId+status]`，可按 sessionId 取回后在内存排序；
 * 阶段二长会话实测若成为瓶颈，再加 [sessionId+status+seq] 复合索引走游标下推。
 */
export async function listTurnsPage(
  db: NarraDB,
  sessionId: string,
  opts: PageOptions = {},
): Promise<Turn[]> {
  const limit = opts.limit ?? PAGE_SIZE;
  let rows = await db.turns.where('sessionId').equals(sessionId).toArray();
  if (opts.status) rows = rows.filter((t) => t.status === opts.status);
  const before = opts.beforeSeq;
  if (before !== undefined) rows = rows.filter((t) => t.seq < before);
  rows.sort((a, b) => b.seq - a.seq);
  return rows.slice(0, limit);
}

/**
 * 取最近 N 页（UI 初始加载用）。
 * pages=2 → 最近 100 轮，按 seq **升序**返回，便于渲染。
 */
export async function listRecentTurns(
  db: NarraDB,
  sessionId: string,
  pages = INITIAL_PAGES,
  status?: Turn['status'],
): Promise<Turn[]> {
  const page = await listTurnsPage(db, sessionId, {
    limit: PAGE_SIZE * Math.max(1, pages),
    status,
  });
  return page.slice().sort((a, b) => a.seq - b.seq);
}

async function getTurnOrThrow(db: NarraDB, sessionId: string, turnId: string): Promise<Turn> {
  const turn = await db.turns.get(turnId);
  if (!turn || turn.sessionId !== sessionId) throw new TurnNotFoundError(turnId);
  return turn;
}

/** 旧 revision 落为 superseded，新 revision 成为 active */
async function supersedeAndInsert(
  db: NarraDB,
  tx: Transaction,
  turn: Turn,
  next: { userContent: string; assistantContent: string; reason: RevisionReason },
): Promise<TurnRevision> {
  const revisions = tx.table('revisions') as Table<TurnRevision, string>;
  const turns = tx.table('turns') as Table<Turn, string>;
  const ts = now();

  const oldRev = await revisions.get(turn.activeRevisionId);
  if (oldRev) {
    await revisions.update(oldRev.id, { status: 'superseded', supersededAt: ts });
  }

  const revision: TurnRevision = {
    id: newId('rev'),
    turnId: turn.id,
    userContent: next.userContent,
    assistantContent: next.assistantContent,
    status: 'active',
    reason: next.reason,
    requestId: newId('req'),
    createdAt: ts,
    // 工具轨迹随本次生成，不继承旧 revision（阶段三定 sideEffect 复用策略）
  };
  TurnRevisionSchema.parse(revision);
  await revisions.add(revision);
  await turns.update(turn.id, { activeRevisionId: revision.id });
  return revision;
}

/** 把 seq > afterSeq 的 active Turn 标为 discarded（不回收 seq） */
async function discardAfter(db: NarraDB, sessionId: string, afterSeq: number): Promise<Turn[]> {
  const all = await listTurns(db, sessionId);
  const victims = all.filter((t) => t.seq > afterSeq && t.status === 'active');
  const ts = now();
  await Promise.all(
    victims.map((t) => db.turns.update(t.id, { status: 'discarded' as const })),
  );
  void ts;
  return victims;
}

export interface EditResult {
  turn: Turn;
  revision: TurnRevision;
  discarded: string[];
  stale: StaleReport;
}

/**
 * amend：修改本轮内容。后续 Turn 原样保留（不变量 #2 后半）。
 */
export async function amend(
  db: NarraDB,
  sessionId: string,
  turnId: string,
  patch: { userContent?: string; assistantContent?: string },
): Promise<EditResult> {
  const turn = await getTurnOrThrow(db, sessionId, turnId);
  const current = await db.revisions.get(turn.activeRevisionId);
  if (!current) throw new TurnNotFoundError(turnId);

  const revision = await db.transaction(
    'rw',
    [db.turns, db.revisions, db.summaries, db.facts, db.vectors],
    async (tx) =>
      supersedeAndInsert(db, tx, turn, {
        userContent: patch.userContent ?? current.userContent,
        assistantContent: patch.assistantContent ?? current.assistantContent,
        reason: 'amend',
      }),
  );

  const stale = await markViewsStale(db, sessionId, [turnId], 'amend');
  return { turn, revision, discarded: [], stale };
}

/**
 * regenerate：从该轮重新生成。后续 Turn 标 discarded（可恢复）。
 */
export async function regenerate(
  db: NarraDB,
  sessionId: string,
  turnId: string,
  newAssistantContent: string,
  reason: 'regenerate' | 'retry' = 'regenerate',
): Promise<EditResult> {
  const turn = await getTurnOrThrow(db, sessionId, turnId);
  const current = await db.revisions.get(turn.activeRevisionId);
  if (!current) throw new TurnNotFoundError(turnId);

  const revision = await db.transaction(
    'rw',
    [db.turns, db.revisions, db.summaries, db.facts, db.vectors],
    async (tx) =>
      supersedeAndInsert(db, tx, turn, {
        userContent: current.userContent,
        assistantContent: newAssistantContent,
        reason,
      }),
  );

  // retry 走 regenerate 路径，但**不** discard 后续（中断轮本身就是当前轮）
  let discarded: string[] = [];
  const staleTurnIds = [turnId];
  if (reason === 'regenerate') {
    const victims = await discardAfter(db, sessionId, turn.seq);
    discarded = victims.map((t) => t.id);
    staleTurnIds.push(...discarded);
  }

  const stale = await markViewsStale(db, sessionId, staleTurnIds, 'regenerate');
  return { turn, revision, discarded, stale };
}

/**
 * retry：流式中断后重试。语义 = regenerate，但不 discard 后续。
 * 与「编辑重生成」共用路径，避免 discard 丢失 userContent（§5.4）。
 */
export async function retry(
  db: NarraDB,
  sessionId: string,
  turnId: string,
  newAssistantContent: string,
): Promise<EditResult> {
  return regenerate(db, sessionId, turnId, newAssistantContent, 'retry');
}

/**
 * truncate：删除某轮之后的内容。后续 Turn 标 discarded，本轮保留。
 */
export async function truncate(
  db: NarraDB,
  sessionId: string,
  turnSeq: number,
): Promise<{ discarded: string[]; stale: StaleReport }> {
  const victims = await discardAfter(db, sessionId, turnSeq);
  const stale = await markViewsStale(
    db,
    sessionId,
    victims.map((t) => t.id),
    'truncate',
  );
  return { discarded: victims.map((t) => t.id), stale };
}

/**
 * 改写输入后重新发送：旧 Turn 整体 discarded，创建新 Turn（新 seq、新 requestId）。
 * 这是唯一「discard + 新 Turn」的路径。
 */
export async function resendAfterRewrite(
  db: NarraDB,
  sessionId: string,
  turnId: string,
  newUserContent: string,
  newAssistantContent = '',
): Promise<{ oldTurn: Turn; turn: Turn; revision: TurnRevision; stale: StaleReport }> {
  const oldTurn = await getTurnOrThrow(db, sessionId, turnId);
  // 已有后续时，旧 Turn 之后的内容同样废弃（不回收 seq）
  await discardAfter(db, sessionId, oldTurn.seq);
  await db.turns.update(oldTurn.id, { status: 'discarded' });

  const appended = await appendTurn(db, sessionId, {
    userContent: newUserContent,
    assistantContent: newAssistantContent,
  });
  const stale = await markViewsStale(db, sessionId, [oldTurn.id], 'truncate');
  return { oldTurn, turn: appended.turn, revision: appended.revision, stale };
}

// ------------------------------------------------------------ 恢复语义（不变量 #3）

export type RestoreResult =
  | { ok: true; restored: number }
  | { ok: false; reason: 'branch-readonly' | 'nothing-to-restore' };

/**
 * 恢复废弃的 Turn。
 * 二分：截断后无新写入 → 批量翻回 active；已有新写入 → 废弃分支只读。
 */
export async function restoreDiscarded(db: NarraDB, sessionId: string): Promise<RestoreResult> {
  const all = await listTurns(db, sessionId);
  const discarded = all.filter((t) => t.status === 'discarded');
  if (discarded.length === 0) return { ok: false, reason: 'nothing-to-restore' };

  const minDiscardedSeq = Math.min(...discarded.map((t) => t.seq));
  const hasNewerActive = all.some((t) => t.status === 'active' && t.seq > minDiscardedSeq);
  if (hasNewerActive) return { ok: false, reason: 'branch-readonly' };

  await Promise.all(
    discarded.map((t) => db.turns.update(t.id, { status: 'active' as const })),
  );
  return { ok: true, restored: discarded.length };
}

/** 丢弃分支只读查看（不参与主时间线与「最近 N 轮」注入） */
export async function listDiscardedBranch(db: NarraDB, sessionId: string): Promise<Turn[]> {
  const all = await listTurns(db, sessionId);
  return all.filter((t) => t.status === 'discarded');
}

// ------------------------------------------------------------ greetings

/**
 * 当前 greeting 派生自 seq 0 的 activeRevision —— 无 selectedGreetingId 字段。
 */
export async function currentGreeting(db: NarraDB, sessionId: string): Promise<string> {
  const all = await listTurns(db, sessionId);
  const greetingTurn = all.find((t) => t.seq === GREETING_SEQ);
  if (!greetingTurn) return '';
  const rev = await db.revisions.get(greetingTurn.activeRevisionId);
  return rev?.assistantContent ?? '';
}

/** 是否仍处于「用户未回复」阶段（除 greeting 外没有 active 轮次） */
export async function hasUserReply(db: NarraDB, sessionId: string): Promise<boolean> {
  const all = await listTurns(db, sessionId);
  return all.some((t) => t.seq > GREETING_SEQ && t.status === 'active');
}

/**
 * 切换 greeting。仅「用户未回复」阶段允许就地替换（走 revision）。
 * 已回复 → 抛 GreetingLockedError，UI 转为「以此 greeting 新开会话」。
 */
export async function switchGreeting(
  db: NarraDB,
  sessionId: string,
  greetingContent: string,
): Promise<TurnRevision> {
  if (await hasUserReply(db, sessionId)) throw new GreetingLockedError();
  const all = await listTurns(db, sessionId);
  const greetingTurn = all.find((t) => t.seq === GREETING_SEQ);
  if (!greetingTurn) throw new TurnNotFoundError('greeting');
  const current = await db.revisions.get(greetingTurn.activeRevisionId);
  if (!current) throw new TurnNotFoundError('greeting');

  return db.transaction('rw', [db.turns, db.revisions], async (tx) =>
    supersedeAndInsert(db, tx, greetingTurn, {
      userContent: '',
      assistantContent: greetingContent,
      reason: 'greeting_switch',
    }),
  );
}

// ------------------------------------------------------------ 版本历史

export async function listRevisions(db: NarraDB, turnId: string): Promise<TurnRevision[]> {
  const rows = await db.revisions.where('turnId').equals(turnId).toArray();
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 恢复到某个历史版本：产生**新** revision，不删除当前版本（事实不可变）。
 */
export async function restoreToRevision(
  db: NarraDB,
  sessionId: string,
  revisionId: string,
): Promise<EditResult> {
  const target = await db.revisions.get(revisionId);
  if (!target) throw new TurnNotFoundError(revisionId);
  const turn = await getTurnOrThrow(db, sessionId, target.turnId);

  const revision = await db.transaction(
    'rw',
    [db.turns, db.revisions, db.summaries, db.facts, db.vectors],
    async (tx) =>
      supersedeAndInsert(db, tx, turn, {
        userContent: target.userContent,
        assistantContent: target.assistantContent,
        reason: 'amend',
      }),
  );
  const stale = await markViewsStale(db, sessionId, [turn.id], 'amend');
  return { turn, revision, discarded: [], stale };
}

export { ReadOnlyBranchError };
