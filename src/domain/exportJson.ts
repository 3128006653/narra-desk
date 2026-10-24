/**
 * JSON 导出（阶段五「可回导 JSON 包」的前身）。
 *
 * 阶段一补上 **schema 版本号** —— 它是迁移的前提，必须在阶段一导出的包里就有；
 * 否则阶段五做跨设备导入时无法判断要不要跑迁移。
 * ⚠️ 阶段五需补齐：导出清单哈希链（prevHash/selfHash）、VectorIndex 可选性、Markdown 只读归档。
 */
import type { NarraDB } from '../schema/db';
import { CURRENT_VERSION } from '../schema/db';

export interface BackupBundle {
  /** Dexie schema 版本（= Zod 形状版本映射的一侧）；导入时据此决定是否迁移 */
  schemaVersion: number;
  exportedAt: number;
  // TODO(阶段五)：manifest: { entries: [{ path, selfHash, prevHash }] }
  characters: unknown[];
  assets: unknown[];
  sessions: unknown[];
  turns: unknown[];
  revisions: unknown[];
  summaries: unknown[];
  facts: unknown[];
  vectors: unknown[];
}

export async function buildBackupBundle(db: NarraDB): Promise<BackupBundle> {
  const [characters, assets, sessions, turns, revisions, summaries, facts, vectors] =
    await Promise.all([
      db.characters.toArray(),
      db.assets.toArray(),
      db.sessions.toArray(),
      db.turns.toArray(),
      db.revisions.toArray(),
      db.summaries.toArray(),
      db.facts.toArray(),
      db.vectors.toArray(),
    ]);
  return {
    schemaVersion: CURRENT_VERSION,
    exportedAt: Date.now(),
    characters,
    assets,
    sessions,
    turns,
    revisions,
    summaries,
    facts,
    vectors,
  };
}

export type BundleCheck =
  | { ok: true; schemaVersion: number; needsMigration: boolean }
  | { ok: false; reason: 'not-json-bundle' | 'missing-schema-version' };

/**
 * 导入前校验：识别版本号，判断是否需要迁移。
 * 无版本号的老包直接拒绝（无法安全判断形状），不静默猜测。
 */
export function checkBundle(raw: unknown): BundleCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not-json-bundle' };
  const v = (raw as Record<string, unknown>).schemaVersion;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    return { ok: false, reason: 'missing-schema-version' };
  }
  return { ok: true, schemaVersion: v, needsMigration: v !== CURRENT_VERSION };
}

export async function downloadBackup(db: NarraDB): Promise<void> {
  const bundle = await buildBackupBundle(db);
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `narra-desk-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
