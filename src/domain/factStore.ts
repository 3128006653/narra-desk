/**
 * FactView 写路径（阶段四）。
 *
 * 三条线的交汇点：**写入路径**（本文件）+ **读取路径**（`factInjection`）+ **后台重建**（阶段四末）。
 * 这里只管写入，且必须在一个事务内完成，否则不变量 #6 守不住。
 *
 * ---------------------------------------------------------------- 不变量 #6
 *
 * 同 (sessionId, scope, characterId, key) 至多一条 `injectionState=active`。
 * **不靠唯一索引**（Dexie 唯一索引全表生效，会把 inactive 行写入也拦下），
 * 靠写路径：事务内先查 active 行 → 存在则转 `inactive + superseded` → 再写新行。
 *
 * 验收语义是「**最终至多一条 active**」，不是「写入失败其一」：
 * 两条都写入成功、其中一条被降级，也是合法结果。
 *
 * ---------------------------------------------------------------- 三条容易写错的规则
 *
 *  1. **变更检测的比对基准只取 `injectionState=active` 的行**（I-22 相关）。
 *     若把 inactive 行也算进去，low 事实过期后同值复现会被抑制 → **永久静默丢失**。
 *  2. **同 key 至多保留最近 1 条 inactive 行**，更老的**物理删除**。
 *     FactView 不是审计日志，历史追溯走 Turn 的 amendment 记录。
 *  3. **`lastSeenTurn` 只在写路径刷新**（复现检测二期）。
 */
import type { FactView, RiskLevel } from '../schema/entities';
import type { NarraDB } from '../schema/db';
import { now } from '../schema/ids';
import { riskLevelOf } from './factNamespace';
import { INJECTION_LIMITS } from './factInjection';

export interface WriteFactInput {
  sessionId: string;
  scope: 'global' | 'character';
  characterId?: string;
  key: string;
  value: string | Record<string, unknown>;
  confidence: FactView['confidence'];
  origin: FactView['origin'];
  riskLevel?: RiskLevel; // 未注册 key 默认 high
  lastSeenTurn: number;
  sourceTurnIds: string[];
  sourceRevisionIds: string[];
}

export interface WriteFactResult {
  fact: FactView;
  /** 同 key 同值且同 confidence → 未产生新行，只刷新了 lastSeenTurn */
  unchanged: boolean;
  /** 被本行取代的旧行 id（若有） */
  supersededId?: string;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 写入一条事实（阶段四核心）。
 *
 * 事务内顺序：
 *  1. 查同 key 的 active 行；
 *  2. 值未变且 confidence 未变 → 只刷新 `lastSeenTurn`，**不产生新行**（变更检测）；
 *  3. 否则旧 active 行转 `inactive + superseded`，写新行；
 *  4. 同 key 的 inactive 行按 `updatedAt` 保留最近 1 条，其余物理删除。
 */
export async function writeFact(db: NarraDB, input: WriteFactInput): Promise<WriteFactResult> {
  const characterId = input.scope === 'global' ? '' : (input.characterId ?? '');

  return db.transaction('rw', db.facts, async () => {
    const rows = await db.facts
      .where('[sessionId+scope+characterId+key+injectionState]')
      .equals([input.sessionId, input.scope, characterId, input.key, 'active'])
      .toArray();

    const ts = now();
    const active = rows[0];

    // ---- 变更检测（基准只取 active）----
    if (active && sameValue(active.value, input.value) && active.confidence === input.confidence) {
      await db.facts.update(active.id, {
        lastSeenTurn: input.lastSeenTurn,
        updatedAt: ts,
        stale: false,
        staleReason: undefined,
      });
      return {
        fact: (await db.facts.get(active.id))!,
        unchanged: true,
        supersededId: undefined,
      };
    }

    // ---- 旧 active 行降级 ----
    let supersededId: string | undefined;
    for (const row of rows) {
      if (row.id === active?.id) supersededId = row.id;
      await db.facts.update(row.id, {
        injectionState: 'inactive',
        inactiveReason: 'superseded',
        updatedAt: ts,
      });
    }

    // ---- 写新行 ----
    const fact: FactView = {
      id: newFactId(),
      sessionId: input.sessionId,
      scope: input.scope,
      characterId,
      key: input.key,
      value: input.value,
      confidence: input.confidence,
      injectionState: 'active',
      inactiveReason: undefined,
      origin: input.origin,
      riskLevel: input.riskLevel ?? riskLevelOf(input.key),
      pinned: false,
      lastSeenTurn: input.lastSeenTurn,
      stale: false,
      staleReason: undefined,
      sourceTurnIds: input.sourceTurnIds,
      sourceRevisionIds: input.sourceRevisionIds,
      supersedes: supersededId,
      updatedAt: ts,
    };
    await db.facts.put(fact);

    await pruneInactive(db, input.sessionId, input.scope, characterId, input.key);

    return { fact, unchanged: false, supersededId };
  });
}

/** 同 key 至多保留最近 1 条 inactive 行，更老的物理删除 */
async function pruneInactive(
  db: NarraDB,
  sessionId: string,
  scope: FactView['scope'],
  characterId: string,
  key: string,
): Promise<number> {
  const inactive = await db.facts
    .where('[sessionId+scope+characterId+key+injectionState]')
    .equals([sessionId, scope, characterId, key, 'inactive'])
    .toArray();
  if (inactive.length <= 1) return 0;
  inactive.sort((a, b) => b.updatedAt - a.updatedAt);
  const doomed = inactive.slice(1).map((r) => r.id);
  await db.facts.bulkDelete(doomed);
  return doomed.length;
}

function newFactId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `f_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * 确认一条 `proposed` 事实。
 * ⚠️ 若同 key 已有 active 的 confirmed（并发路径下可能发生），本行转 `superseded` ——
 *    注入态唯一性优先于「用户点了确认」。
 */
export async function confirmFact(db: NarraDB, factId: string, atTurn: number): Promise<FactView> {
  return db.transaction('rw', db.facts, async () => {
    const f = await db.facts.get(factId);
    if (!f) throw new Error(`事实不存在：${factId}`);
    const ts = now();
    const others = await db.facts
      .where('[sessionId+scope+characterId+key+injectionState]')
      .equals([f.sessionId, f.scope, f.characterId, f.key, 'active'])
      .toArray();
    const conflict = others.find((o) => o.id !== f.id);
    if (conflict) {
      await db.facts.update(factId, {
        injectionState: 'inactive',
        inactiveReason: 'superseded',
        updatedAt: ts,
      });
      return (await db.facts.get(factId))!;
    }
    await db.facts.update(factId, {
      confidence: 'confirmed',
      injectionState: 'active',
      inactiveReason: undefined,
      origin: 'user_confirm',
      lastSeenTurn: atTurn,
      updatedAt: ts,
    });
    return (await db.facts.get(factId))!;
  });
}

/**
 * 纠错：从聊天界面一键「这条不对」。
 * 停注入 + 面板置顶；改写走 `correctFact`。
 */
export async function disputeFact(db: NarraDB, factId: string): Promise<FactView> {
  return db.transaction('rw', db.facts, async () => {
    const f = await db.facts.get(factId);
    if (!f) throw new Error(`事实不存在：${factId}`);
    await db.facts.update(factId, {
      injectionState: 'inactive',
      inactiveReason: 'disputed',
      updatedAt: now(),
    });
    return (await db.facts.get(factId))!;
  });
}

/** 改写被纠错的事实：生成新的 confirmed 行，旧行保留 `correction` 供追溯 */
export async function correctFact(
  db: NarraDB,
  factId: string,
  newValue: string | Record<string, unknown>,
  atTurn: number,
  note?: string,
): Promise<FactView> {
  return db.transaction('rw', db.facts, async () => {
    const old = await db.facts.get(factId);
    if (!old) throw new Error(`事实不存在：${factId}`);
    const ts = now();
    await db.facts.update(factId, {
      injectionState: 'inactive',
      inactiveReason: 'superseded',
      correction: { previousValue: old.value, correctedAt: ts, note },
      updatedAt: ts,
    });
    return (
      await writeFact(db, {
        sessionId: old.sessionId,
        scope: old.scope,
        characterId: old.characterId,
        key: old.key,
        value: newValue,
        confidence: 'confirmed',
        origin: 'user_confirm',
        riskLevel: old.riskLevel,
        lastSeenTurn: atTurn,
        sourceTurnIds: old.sourceTurnIds,
        sourceRevisionIds: old.sourceRevisionIds,
      })
    ).fact;
  });
}

// ---------------------------------------------------------------- 过期与归档（阶段四第 4 步）

/** pin 上限（不变量 #7：额外配额，总上限 45） */
export const INJECTION_PIN_LIMIT = INJECTION_LIMITS.pin;

/** §5.7：proposed 超 100 轮未处理 → archived；low 的 confirmed/auto 超 50 轮 → expired */
export const PROPOSED_ARCHIVE_TURNS = 100;
export const LOW_EXPIRE_TURNS = 50;

/**
 * 过期/归档扫描。
 *
 * 两条规则都只改注入态，**不删数据**：
 *  - `archived` = 用户一直没处理（未处理 ≠ 值失效）
 *  - `expired`  = 值可能已失效（low 类，终态）
 *
 * `expired` 是终态，但**不是永久消失**：模型复现同值时走 `writeFact` 写新行 ——
 * 因为变更检测的基准只取 active，同值复现不会被抑制（I-22）。
 */
export async function sweepFactLifecycle(db: NarraDB, sessionId: string, currentTurn: number) {
  return db.transaction('rw', db.facts, async () => {
    const rows = await db.facts.where('sessionId').equals(sessionId).toArray();
    const ts = now();
    let archived = 0;
    let expired = 0;

    for (const f of rows) {
      if (f.injectionState !== 'active') continue;
      const idle = currentTurn - f.lastSeenTurn;
      if (f.confidence === 'proposed' && idle > PROPOSED_ARCHIVE_TURNS) {
        await db.facts.update(f.id, {
          injectionState: 'inactive',
          inactiveReason: 'archived',
          updatedAt: ts,
        });
        archived += 1;
      } else if (
        (f.confidence === 'confirmed' || f.confidence === 'auto') &&
        f.riskLevel === 'low' &&
        idle > LOW_EXPIRE_TURNS
      ) {
        await db.facts.update(f.id, {
          injectionState: 'inactive',
          inactiveReason: 'expired',
          updatedAt: ts,
        });
        expired += 1;
      }
    }
    return { archived, expired };
  });
}

// ---------------------------------------------------------------- pin（阶段四第 5 步）

export interface PinResult {
  ok: boolean;
  /** 失败原因：`limit-reached` = pin 已满，需用户先取消一条 */
  reason?: 'limit-reached' | 'not-found';
  fact?: FactView;
}

/**
 * pin 一条事实。
 *
 * ⚠️ **满员时拒绝并提示，不自动替换最早的 pin**。
 *    与「`retryNow` 不重置 attempts」同一原则：pin 是用户显式动作，
 *    「自动替换」会让用户以为 pin 成功了、实际生效的是另一条 —— 这是静默失效。
 */
export async function pinFact(db: NarraDB, factId: string, limit = INJECTION_PIN_LIMIT): Promise<PinResult> {
  return db.transaction('rw', db.facts, async () => {
    const f = await db.facts.get(factId);
    if (!f) return { ok: false, reason: 'not-found' };
    if (f.pinned) return { ok: true, fact: f };

    const rows = await db.facts.where('sessionId').equals(f.sessionId).toArray();
    const pinnedCount = rows.filter((r) => r.pinned && r.injectionState === 'active').length;
    if (pinnedCount >= limit) return { ok: false, reason: 'limit-reached', fact: f };

    const ts = now();
    await db.facts.update(factId, { pinned: true, pinnedAt: ts, updatedAt: ts });
    return { ok: true, fact: (await db.facts.get(factId))! };
  });
}

/** 取消 pin */
export async function unpinFact(db: NarraDB, factId: string): Promise<FactView | undefined> {
  const ts = now();
  await db.facts.update(factId, { pinned: false, pinnedAt: undefined, updatedAt: ts });
  return db.facts.get(factId);
}

// ---------------------------------------------------------------- 面板分区查询

/**
 * 面板分区（阶段四第 5 步）。
 *
 * `expired` 与 `archived` **必须分开显示**：两者都是 inactive、都不注入，但语义相反 ——
 *   - `archived` = 用户一直没处理 → 归「待处理（已归档）」
 *   - `expired`  = 值可能已失效（low，50 轮未复现）→ 归「已过期」
 * 混在一起用户分不清「这条需要我处理」还是「这条已经过时了」。
 * `disputed` 单独置顶。
 */
export interface FactPanelGroups {
  pending: FactView[]; // proposed & active —— 待确认
  disputed: FactView[]; // 用户标记「这条不对」—— 置顶
  archived: FactView[]; // 待处理（已归档）
  expired: FactView[]; // 已过期
  superseded: FactView[]; // 被新值覆盖，可追溯
  pinned: FactView[];
}

export async function loadFactPanel(db: NarraDB, sessionId: string): Promise<FactPanelGroups> {
  const rows = await db.facts.where('sessionId').equals(sessionId).toArray();
  const by = (pred: (f: FactView) => boolean) => rows.filter(pred);
  return {
    pending: by((f) => f.injectionState === 'active' && f.confidence === 'proposed'),
    disputed: by((f) => f.inactiveReason === 'disputed'),
    archived: by((f) => f.inactiveReason === 'archived'),
    expired: by((f) => f.inactiveReason === 'expired'),
    superseded: by((f) => f.inactiveReason === 'superseded'),
    pinned: by((f) => f.pinned && f.injectionState === 'active'),
  };
}

/** 批量确认（面板顶部「全选当前页」后调用 —— 默认不选中任何项） */
export async function bulkConfirm(
  db: NarraDB,
  ids: string[],
  atTurn: number,
): Promise<{ confirmed: number; skipped: number }> {
  let confirmed = 0;
  let skipped = 0;
  for (const id of ids) {
    const r = await confirmFact(db, id, atTurn);
    if (r.injectionState === 'active' && r.confidence === 'confirmed') confirmed += 1;
    else skipped += 1;
  }
  return { confirmed, skipped };
}

/** 批量忽略 */
export async function bulkReject(db: NarraDB, ids: string[]): Promise<number> {
  const ts = now();
  for (const id of ids) {
    await db.facts.update(id, {
      injectionState: 'inactive',
      inactiveReason: 'rejected',
      updatedAt: ts,
    });
  }
  return ids.length;
}

/** 列出待确认的 proposed（面板用） */
export async function listProposed(db: NarraDB, sessionId: string): Promise<FactView[]> {
  const rows = await db.facts.where('sessionId').equals(sessionId).toArray();
  return rows.filter((f) => f.confidence === 'proposed' && f.injectionState === 'active');
}
