/**
 * Schema 迁移框架（§4.3）与能力探测（§5.1）测试。
 */
import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import {
  CURRENT_VERSION,
  LATEST_DATA_MIGRATION_VERSION,
  MIGRATIONS,
  initDatabase,
  openForTest,
} from '../src/schema/db';
import {
  browserFamilyOf,
  capabilityLevel,
  capabilityMessage,
  detectStorageCapability,
} from '../src/domain/storageCapability';

/** 造一个真实的 v1 库：所有表齐全，facts 缺 pinned/injectionState/stale */
async function seedV1(name: string) {
  const seed = new Dexie(name);
  seed.version(1).stores({
    sessions: 'id, characterId, updatedAt',
    characters: 'id, name, updatedAt',
    assets: 'id, characterId, type, [characterId+type]',
    turns: 'id, sessionId, &[sessionId+seq], [sessionId+status]',
    revisions: 'id, turnId, [turnId+status]',
    summaries: 'id, sessionId, [sessionId+status]',
    facts: 'id, [sessionId+scope+characterId+key+injectionState]',
    vectors: 'id, [sessionId+embedderServiceId]',
    tasks: 'id, sessionId, [sessionId+status]',
  });
  await seed.open();
  await seed.table('facts').add({ id: 'f1', sessionId: 's1', key: 'k' });
  await seed.table('vectors').add({ id: 'v1', sessionId: 's1' });
  seed.close();
}

describe('迁移框架', () => {
  it('关闭的 confirm 会中止打开，不执行迁移', async () => {
    const name = `mig-abort-${Math.random().toString(36).slice(2)}`;
    await seedV1(name);

    let exported = false;
    await expect(
      initDatabase({
        dbName: name,
        confirm: async () => false,
        exportBackup: async () => {
          exported = true;
        },
      }),
    ).rejects.toThrow('用户取消了迁移');
    expect(exported).toBe(false);
  });

  it('升级前先导出，再执行迁移，且迁移幂等', async () => {
    const name = `mig-ok-${Math.random().toString(36).slice(2)}`;
    await seedV1(name);

    let exported = false;
    let asked = '';
    const db = await initDatabase({
      dbName: name,
      confirm: async (msg) => {
        asked = msg;
        return true;
      },
      exportBackup: async () => {
        exported = true;
      },
    });

    expect(exported).toBe(true);
    expect(asked).toContain('升级');
    expect(db.verno).toBe(CURRENT_VERSION);

    const f = await db.facts.get('f1');
    expect(f?.pinned).toBe(false);
    expect(f?.injectionState).toBe('active');
    // I-3 / v3：派生层 stale 默认值
    expect(f?.stale).toBe(false);
    expect(f?.staleReason).toBeUndefined();
    const v = await db.vectors.get('v1');
    expect(v?.stale).toBe(false);

    // 幂等：重复执行同一迁移步骤不产生副作用
    await db.transaction('rw', db.facts, async (tx) => {
      await MIGRATIONS[LATEST_DATA_MIGRATION_VERSION](tx);
    });
    const again = await db.facts.get('f1');
    expect(again?.pinned).toBe(false);
    expect(again?.injectionState).toBe('active');
    expect(again?.stale).toBe(false);
    db.close();
  });

  it('全新库直接到达 CURRENT_VERSION（不触发导出）', async () => {
    const name = `mig-fresh-${Math.random().toString(36).slice(2)}`;
    let exported = false;
    const db = await initDatabase({
      dbName: name,
      confirm: async () => true,
      exportBackup: async () => {
        exported = true;
      },
    });
    expect(db.verno).toBe(CURRENT_VERSION);
    expect(exported).toBe(false);
    db.close();
  });
});

describe('存储能力探测', () => {
  it('Safari：persist 返回 true 也不声称持久化可靠', async () => {
    const cap = await detectStorageCapability({
      indexedDBPresent: true,
      hasPersist: true,
      persist: async () => true,
      persistGranted: async () => true,
      estimate: async () => ({ quota: 1_000_000_000 }),
      hasShowDirectoryPicker: false,
      userAgent: 'Mozilla/5.0 (Macintosh) Version/17.0 Safari/605.1.15',
    });
    expect(cap.browserFamily).toBe('safari');
    expect(cap.persistNote).toContain('7 天驱逐');
    expect(cap.fsAccessFallback).toBe(true);
  });

  it('Chromium 未授予持久化：给出绑定工作区的建议', async () => {
    const cap = await detectStorageCapability({
      indexedDBPresent: true,
      hasPersist: true,
      persistGranted: async () => false,
      estimate: async () => ({ quota: null }),
      hasShowDirectoryPicker: true,
      userAgent: 'Mozilla/5.0 Chrome/130.0.0.0',
    });
    expect(capabilityLevel(cap)).toBe('not-granted');
    expect(capabilityMessage(cap)).toContain('绑定工作区');
  });

  it('IndexedDB 不可用：unavailable', async () => {
    const cap = await detectStorageCapability({
      indexedDBPresent: false,
      hasPersist: false,
      persistGranted: async () => false,
      estimate: async () => null,
      hasShowDirectoryPicker: false,
      userAgent: '',
    });
    expect(capabilityLevel(cap)).toBe('unavailable');
    expect(capabilityMessage(cap)).toContain('不支持');
  });

  it('浏览器家族判定', () => {
    expect(browserFamilyOf('Mozilla/5.0 Firefox/131.0')).toBe('firefox');
    expect(browserFamilyOf('Mozilla/5.0 Chrome/130 Safari/537')).toBe('chromium');
    expect(browserFamilyOf('Mozilla/5.0 (iPhone) Version/17.0 Safari/605')).toBe('safari');
  });
});

void openForTest;
