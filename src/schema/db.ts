/**
 * 存储层（v0.6.1 / 阶段一）。
 *
 * 两条实测结论已固化在此：
 *  1. Dexie 用 `&[a+b]` 声明**复合唯一索引**是生效的（实测抛 ConstraintError）。
 *     故不变量 #1（seq 永不复用）除了写路径乐观锁，还有 DB 层硬拦截。
 *     ⚠️ 二期引入 branchId 时必须改为 `&[sessionId+branchId+seq]`，
 *        否则同一 seq 的两个分支写入会被唯一索引拒绝 —— 已记 issue。
 *  2. FactView **不建**唯一索引（不变量 #6）：Dexie 唯一索引全表生效、无条件下推，
 *     会让 inactive 行写入直接 ConstraintError。注入态唯一性由写路径保证。
 */
import Dexie, { type Table, type Transaction } from 'dexie';
import type {
  BackgroundTask,
  CalibrationRow_v5,
  Character,
  CharacterAsset,
  FactView,
  Session,
  SummaryView,
  Turn,
  TurnRevision,
  VectorIndex,
} from './entities';

export const CURRENT_VERSION = 5;

export class NarraDB extends Dexie {
  sessions!: Table<Session, string>;
  characters!: Table<Character, string>;
  assets!: Table<CharacterAsset, string>;
  turns!: Table<Turn, string>;
  revisions!: Table<TurnRevision, string>;
  summaries!: Table<SummaryView, string>;
  facts!: Table<FactView, string>;
  vectors!: Table<VectorIndex, string>;
  tasks!: Table<BackgroundTask, string>;
  calibration!: Table<CalibrationRow_v5, string>;

  constructor(name = 'narra-desk') {
    super(name);

    this.version(1).stores({
      sessions: 'id, characterId, updatedAt',
      characters: 'id, name, updatedAt',
      assets: 'id, characterId, type, [characterId+type]',
      // & = 唯一索引；discarded Turn 仍占用 seq，故唯一性不被 discard 破坏
      // ⚠️ I-2（二期）：引入 branchId 时必须改为 &[sessionId+branchId+seq]，
      //    否则同一 seq 的两个分支写入会被此唯一索引直接拒绝。现在不动。
      turns: 'id, sessionId, &[sessionId+seq], [sessionId+status]',
      revisions: 'id, turnId, [turnId+status]',
      summaries: 'id, sessionId, [sessionId+status]',
      facts:
        'id, [sessionId+scope+characterId+key+injectionState], [sessionId+confidence], [sessionId+lastSeenTurn]',
      vectors: 'id, [sessionId+embedderServiceId]',
      tasks: 'id, sessionId, [sessionId+status]',
    });

    this.version(2)
      .stores({
        // v2 新增：inactiveReason 索引（面板按原因分组）
        facts:
          'id, [sessionId+scope+characterId+key+injectionState], [sessionId+confidence], [sessionId+lastSeenTurn], [sessionId+inactiveReason]',
        vectors: 'id, [sessionId+embedderServiceId]',
      })
      .upgrade(async (tx) => migrationV2(tx));

    this.version(3)
      .stores({
        // v3（I-3 定案）：派生层 stale 标记。
        // ⚠️ 实测：IndexedDB **不接受布尔作为 key** —— 写入不报错，
        //    但按 [sessionId+stale] 查询直接抛 DataError。
        //    故索引落在 staleReason（字符串，合法 key）上，
        //    并约定不变式：stale === true ⟺ staleReason !== undefined。
        facts:
          'id, [sessionId+scope+characterId+key+injectionState], [sessionId+confidence], [sessionId+lastSeenTurn], [sessionId+inactiveReason], [sessionId+staleReason]',
        vectors: 'id, [sessionId+embedderServiceId], [sessionId+staleReason]',
      })
      .upgrade(async (tx) => migrationV3(tx));

    // v4（I-16）：SummaryView 增加 `source`，用于标记抽取式占位摘要器的产物。
    // 索引未变，仅做字段回填。
    this.version(4)
      .stores({
        summaries: 'id, sessionId, [sessionId+status]',
      })
      .upgrade(async (tx) => migrationV4(tx));

    // v5（I-24）：新增 token 校准表（样本与系数合一）。
    // 纯新增表，无需 upgrade —— 空表即「全部走默认 1.2」，行为不变。
    this.version(5).stores({
      calibration: 'id, family',
    });
  }
}

// ------------------------------------------------------------ 迁移框架

export type Migration = (tx: Transaction) => Promise<void> | void;

/**
 * 迁移原则（§4.3）：
 *  - 只增字段不删字段
 *  - 每一步幂等（用 `if (!record.field)` 守卫），可重复执行无副作用
 *  - 迁移前由调用方执行阻断式确认 + 一次点击导出
 */
export const MIGRATIONS: Record<number, Migration> = {
  2: migrationV2,
  3: migrationV3,
  4: migrationV4,
  // 5 无 upgrade（新增表，空表即默认行为）
};

/**
 * 最新**带数据 upgrade** 的版本号。
 *
 * ⚠️ 不要写成 `MIGRATIONS[CURRENT_VERSION]`：新增一个只加表、不需要 upgrade 的
 * 版本（如 v5 的 calibration 表）时，那个键是 undefined，测试会崩。
 * 这两者不是一回事 —— CURRENT_VERSION 管存储结构，upgrade 管已有数据。
 */
export const LATEST_DATA_MIGRATION_VERSION = Math.max(...Object.keys(MIGRATIONS).map(Number));

/**
 * v4（I-16）：为 SummaryView 回填 `source`。
 *
 * ⚠️ 缺失一律回填 **`stub`**（保守方向）：旧行无从得知是谁生成的，
 *    按「机械拼凑的伪摘要」处理，宁可后续重建，也不冒险注入。
 *    真实模型生成的摘要必须显式写 `source: 'model'`。
 */
async function migrationV4(tx: Transaction): Promise<void> {
  if (!tx.storeNames.includes('summaries')) return;
  const summaries = tx.table('summaries') as Table<SummaryView, string>;
  await summaries.toCollection().modify((s) => {
    if (s.source !== 'stub' && s.source !== 'model') {
      s.source = 'stub';
    }
    if (typeof s.updatedAt !== 'number') s.updatedAt = s.createdAt ?? 0;
  });
}

/**
 * v2：为 FactView 补齐 `pinned` 与 `injectionState`。
 * 幂等：只写缺失字段，已存在的行不动。
 */
async function migrationV2(tx: Transaction): Promise<void> {
  const facts = tx.table('facts') as Table<FactView, string>;
  await facts.toCollection().modify((f) => {
    if (typeof f.pinned !== 'boolean') f.pinned = false;
    if (f.injectionState !== 'active' && f.injectionState !== 'inactive') {
      f.injectionState = 'active';
    }
    if (typeof f.lastSeenTurn !== 'number') f.lastSeenTurn = 0;
  });
}

/**
 * v3（I-3）：为 FactView / VectorIndex 派生层 stale 标记补默认值。
 * 幂等：只写缺失字段；已存在的行不动。
 */
async function migrationV3(tx: Transaction): Promise<void> {
  // 缺表保护：手工构造的库（如测试种子）可能没有全部表；
  // 真实库由 NarraDB v1 一次性建齐，此分支不会命中。
  const has = (name: string) => tx.storeNames.includes(name);

  if (has('facts')) {
    const facts = tx.table('facts') as Table<FactView, string>;
    await facts.toCollection().modify((f) => {
      if (typeof f.stale !== 'boolean') {
        f.stale = false;
        f.staleReason = undefined;
      }
    });
  }

  if (has('vectors')) {
    const vectors = tx.table('vectors') as Table<VectorIndex, string>;
    await vectors.toCollection().modify((v) => {
      if (typeof v.stale !== 'boolean') {
        v.stale = false;
        v.staleReason = undefined;
      }
    });
  }
}

// ------------------------------------------------------------ 初始化（含迁移前导出）

export interface InitOptions {
  /** 阻断式确认；返回 false 则中止打开 */
  confirm: (message: string) => Promise<boolean>;
  /** 一次点击导出（必须由用户手势触发，不用静默下载） */
  exportBackup: () => Promise<void>;
  dbName?: string;
  /**
   * 迁移完成后的收尾回调（I-16 / 迁移收尾）。
   *
   * 存在理由：v4 会把缺 `source` 的旧摘要回填为 `stub` —— 它们立刻变得**不可注入**，
   * 区间全部转空洞、回退注入原始 Turn。长会话下用户会看到「升级后模型突然记得更少」。
   * 所以迁移不是写完字段就完事，**必须紧接着入队一次 stub 重建**。
   *
   * 回调在 `db.open()` 之后触发（此时表已就绪，可以安全读写），
   * 失败不阻断启动 —— 兜底失败不该挡住用户开始聊天。
   */
  onMigrated?: (db: NarraDB, fromVersion: number) => void | Promise<void>;
}

export class MigrationAbortedError extends Error {
  constructor() {
    super('用户取消了迁移');
    this.name = 'MigrationAbortedError';
  }
}

/**
 * 用原生 IDB 窥探现有版本，避免 Dexie 声明缺失导致误升级。
 *
 * ⚠️ 实测坑：Dexie 把原生 IDB 版本号写成 `verno * 10`（留位给未来的中间版本）。
 *    所以 Dexie verno=1 的库，裸 `indexedDB.open()` 读到的 db.version 是 **10**。
 *    不做换算会让迁移检测被整个绕过（静默失效，不报错）。
 */
function peekVersion(dbName: string): Promise<{ version: number; fresh: boolean }> {
  return new Promise((resolve, reject) => {
    if (typeof globalThis.indexedDB === 'undefined') {
      return resolve({ version: 0, fresh: true });
    }
    const req = globalThis.indexedDB.open(dbName);
    req.onsuccess = () => {
      const db = req.result;
      const fresh = db.objectStoreNames.length === 0;
      const dexieVerno = Math.floor(db.version / 10);
      db.close();
      resolve({ version: dexieVerno, fresh });
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * 打开数据库；需要迁移时先阻断式确认 + 导出，再执行 Dexie 升级。
 */
export async function initDatabase(opts: InitOptions): Promise<NarraDB> {
  const name = opts.dbName ?? 'narra-desk';
  const { version, fresh } = await peekVersion(name);

  if (!fresh && version > 0 && version < CURRENT_VERSION) {
    const ok = await opts.confirm(
      `数据结构需要从 v${version} 升级到 v${CURRENT_VERSION}。升级前会先导出一份 JSON 备份。`,
    );
    if (!ok) throw new MigrationAbortedError();
    await opts.exportBackup();
  }

  const db = new NarraDB(name);
  await db.open();

  // 迁移收尾（I-16）：v4 回填的 stub 摘要需要重建，否则长会话会「升级后模型记得更少」。
  if (!fresh && version > 0 && version < CURRENT_VERSION && opts.onMigrated) {
    try {
      await opts.onMigrated(db, version);
    } catch {
      /* 收尾失败不阻断启动 */
    }
  }

  return db;
}

/** 测试用：跳过确认/导出直接打开 */
export async function openForTest(dbName = 'narra-desk-test'): Promise<NarraDB> {
  const db = new NarraDB(dbName);
  await db.open();
  return db;
}
