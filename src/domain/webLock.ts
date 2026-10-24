/**
 * 单活动标签页锁（§5.1）。
 *
 * 目的：把乐观锁冲突从「常规流程」收敛为「崩溃恢复 / 锁异常」两个罕见触发点。
 * Web Locks 优先；不支持时降级 BroadcastChannel 心跳；再不支持则退化为无锁（单标签假设）。
 */
import type { NarraDB } from '../schema/db';

export type LockMode = 'web-locks' | 'broadcast-channel' | 'none';

export interface SessionLock {
  mode: LockMode;
  release: () => void | Promise<void>;
}

export function detectLockMode(): LockMode {
  const nav = globalThis.navigator as (Navigator & { locks?: LockManager }) | undefined;
  if (nav?.locks && typeof nav.locks.request === 'function') return 'web-locks';
  if (typeof globalThis.BroadcastChannel === 'function') return 'broadcast-channel';
  return 'none';
}

/**
 * 获取会话锁。已持有者返回锁对象；未持有者应进入只读模式。
 * 回调风格：`acquireSessionLock(sessionId, () => work())` 保证锁覆盖整段工作。
 */
export async function withSessionLock<T>(
  sessionId: string,
  work: () => Promise<T>,
  onReadOnly?: () => void,
): Promise<T | null> {
  const mode = detectLockMode();

  if (mode === 'web-locks') {
    const locks = (globalThis.navigator as Navigator & { locks: LockManager }).locks;
    // ifAvailable：拿不到就只读，不排队等待（避免第二个标签页挂起）
    let acquired = false;
    const result = await locks.request(
      `narra-session-${sessionId}`,
      { ifAvailable: true },
      async () => {
        acquired = true;
        return work();
      },
    );
    if (!acquired) {
      onReadOnly?.();
      return null;
    }
    return result as T;
  }

  if (mode === 'broadcast-channel') {
    const ch = new BroadcastChannel(`narra-session-${sessionId}`);
    const token = crypto.randomUUID?.() ?? String(Math.random());
    let holderToken: string | null = null;
    ch.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as { type: string; token: string };
      if (msg?.type === 'claim') holderToken = msg.token;
    };
    ch.postMessage({ type: 'claim', token });
    await new Promise((r) => setTimeout(r, 30));
    if (holderToken !== null && holderToken !== token) {
      ch.close();
      onReadOnly?.();
      return null;
    }
    try {
      return await work();
    } finally {
      ch.close();
    }
  }

  // 无锁环境（Node 测试）：直接执行
  return work();
}

// ------------------------------------------------------------ reconcile

export interface StorageSideState {
  sessionId: string;
  expectedSeq: number;
  activeTurnCount: number;
  discardedTurnCount: number;
  maxSeq: number;
}

/**
 * 读取存储侧真实状态。乐观锁冲突时用于向用户呈现差异。
 */
export async function readStorageSideState(
  db: NarraDB,
  sessionId: string,
): Promise<StorageSideState> {
  const session = await db.sessions.get(sessionId);
  const turns = await db.turns.where('sessionId').equals(sessionId).toArray();
  return {
    sessionId,
    expectedSeq: session?.expectedSeq ?? -1,
    activeTurnCount: turns.filter((t) => t.status === 'active').length,
    discardedTurnCount: turns.filter((t) => t.status === 'discarded').length,
    maxSeq: turns.length ? Math.max(...turns.map((t) => t.seq)) : -1,
  };
}

export type ReconcileDecision = 'reload-storage' | 'abort';

/**
 * reconcile：单人单标签下直接重载存储侧；多标签由锁避免并发。
 * 这是罕见兜底路径，不是常规流程 —— 不要把它做成每轮都弹的对话框。
 */
export async function reconcile(
  db: NarraDB,
  sessionId: string,
  memorySide: { expectedSeq: number },
  decide: (diff: { memory: StorageSideState; storage: StorageSideState }) => Promise<ReconcileDecision>,
): Promise<'reloaded' | 'aborted'> {
  const storage = await readStorageSideState(db, sessionId);
  const memory: StorageSideState = { ...storage, expectedSeq: memorySide.expectedSeq };
  const decision = await decide({ memory, storage });
  return decision === 'reload-storage' ? 'reloaded' : 'aborted';
}
