/**
 * 角色卡导入（§5.2）：规范化拆解 + 自动修正，而非 prompt 字符串化。
 *
 * 三条定案：
 *  - 字段类型不符只产生 warning，永不阻断导入（Zod v4 严格，必须用双 schema）
 *  - 中文卡 match_whole_words=true 自动改 false（不是「警告后让用户改 JSON」）
 *  - 修正记录进 cardCorrections，角色工坊可见、可恢复原值
 */
import type { NarraDB } from '../schema/db';
import type {
  AssetType,
  CardCorrection,
  Character,
  CharacterAsset,
} from '../schema/entities';
import { newId, now } from '../schema/ids';
import {
  containsCJK,
  detectCardFieldIssues,
  takeBoolean,
  takeNumber,
  takeString,
  takeStringArray,
  type FieldIssue,
} from '../schema/zod';

export interface ImportResult {
  character: Character;
  assets: CharacterAsset[];
  warnings: FieldIssue[];
  corrections: CardCorrection[];
}

interface RawBook {
  entries?: Record<string, unknown>[];
  name?: unknown;
}

function detectFormat(raw: Record<string, unknown>): 'v2' | 'v3' | 'native' {
  const spec = takeString(raw.spec);
  if (spec.startsWith('chara_card_v3')) return 'v3';
  if (spec.startsWith('chara_card_v2')) return 'v2';
  // 部分卡把字段直接放在顶层，没有 spec/data 包裹
  if ('data' in raw && raw.data && typeof raw.data === 'object') return 'v3';
  if ('name' in raw || 'first_mes' in raw) return 'v2';
  return 'native';
}

function dataOf(raw: Record<string, unknown>): Record<string, unknown> {
  const d = raw.data;
  if (d && typeof d === 'object') return d as Record<string, unknown>;
  return raw;
}

function extensionsOf(node: Record<string, unknown>): Record<string, unknown> {
  const ext = node.extensions;
  if (ext && typeof ext === 'object') return ext as Record<string, unknown>;
  return {};
}

/** 收集用于 CJK 判定的文本：正文 + lorebook 关键词与内容 */
function collectCardText(data: Record<string, unknown>, book: RawBook): string {
  const parts: string[] = [];
  for (const f of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example']) {
    parts.push(takeString(data[f]));
  }
  for (const g of takeStringArray(data.alternate_greetings)) parts.push(g);
  for (const e of book.entries ?? []) {
    parts.push(takeString(e.content));
    parts.push(...takeStringArray(e.keys));
  }
  return parts.join('\n');
}

export async function importCard(db: NarraDB, raw: unknown): Promise<ImportResult> {
  if (!raw || typeof raw !== 'object') {
    throw new Error('角色卡内容不是对象');
  }
  const rawObj = raw as Record<string, unknown>;
  const format = detectFormat(rawObj);
  const data = dataOf(rawObj);
  const book = (data.character_book && typeof data.character_book === 'object'
    ? (data.character_book as RawBook)
    : {}) as RawBook;

  const warnings = detectCardFieldIssues(data);
  const corrections: CardCorrection[] = [];
  const isCJK = containsCJK(collectCardText(data, book));

  // ---- 自动修正 1：中文卡全词匹配必须关闭 ----
  // 全词匹配依赖单词边界；CJK 没有以空格分隔的词边界。
  // 这与 \W 是否匹配 CJK 是两个层面的事 —— 正确做法是关闭，而不是依赖正则字符类行为。
  const ext = extensionsOf(data);
  if (isCJK && ext.match_whole_words === true) {
    corrections.push({
      path: 'extensions.match_whole_words',
      from: true,
      to: false,
      reason: 'CJK 文本无空格分词边界，全词匹配会使关键词难以按预期命中',
    });
  }

  const ts = now();
  const characterId = newId('char');
  const assets: CharacterAsset[] = [];

  const pushAsset = (
    type: AssetType,
    content: string,
    metadata: CharacterAsset['metadata'] = {},
  ) => {
    assets.push({
      id: newId('asset'),
      characterId,
      type,
      content,
      metadata,
      createdAt: ts,
    });
  };

  const firstName = takeString(data.name) || '未命名角色';
  pushAsset('description', takeString(data.description));
  pushAsset('personality', takeString(data.personality));
  pushAsset('scenario', takeString(data.scenario));
  pushAsset('first_mes', takeString(data.first_mes));

  // alternate greetings → 每条独立 greeting 资产，保留下标
  takeStringArray(data.alternate_greetings).forEach((g, index) => {
    pushAsset('greeting', g, { index });
  });
  pushAsset('mes_example', takeString(data.mes_example));

  // ---- lorebook 拆解 ----
  (book.entries ?? []).forEach((entry, i) => {
    const entryExt = extensionsOf(entry);
    const keys = takeStringArray(entry.keys);
    const constant = takeBoolean(entry.constant, false);

    let matchWholeWords = takeBoolean(entryExt.match_whole_words, false);
    if (isCJK && entryExt.match_whole_words === true) {
      corrections.push({
        path: `character_book.entries[${i}].extensions.match_whole_words`,
        from: true,
        to: false,
        reason: 'CJK 条目关闭全词匹配',
      });
      matchWholeWords = false;
    }

    // constant 但无 keys：仍可导入，按常量语义处理，仅提示
    if (constant && keys.length === 0) {
      warnings.push({
        path: `character_book.entries[${i}]`,
        expected: 'keys',
        received: '空',
        message: '无关键词的常量条目，将按常量语义处理（始终注入）',
      });
    }

    pushAsset('lorebook_entry', takeString(entry.content), {
      keys,
      secondary_keys: takeStringArray(entry.secondary_keys),
      constant,
      // V3 用 scan_depth，V2 用 depth，二者都保留
      scan_depth: takeNumber(entry.scan_depth, takeNumber(entry.depth, 0)),
      case_sensitive: takeBoolean(entry.case_sensitive, false),
      insertion_order: takeNumber(entry.insertion_order, 0),
      position: takeString(entry.position) || 'before_char',
      enabled: takeBoolean(entry.enabled, true),
      matchWholeWords,
    });
  });

  const character: Character = {
    id: characterId,
    name: firstName,
    cardSource: { format, raw },
    cardCorrections: corrections,
    createdAt: ts,
    updatedAt: ts,
  };

  await db.transaction('rw', [db.characters, db.assets], async () => {
    await db.characters.add(character);
    await db.assets.bulkAdd(assets);
  });

  return { character, assets, warnings, corrections };
}

/** 取角色的 greeting 候选：first_mes 优先，其后为 alternate greetings */
export async function listGreetingCandidates(db: NarraDB, characterId: string) {
  const first = await db.assets.where('[characterId+type]').equals([characterId, 'first_mes']).first();
  const alternates = (await db.assets.where('[characterId+type]').equals([characterId, 'greeting']).toArray())
    .sort((a, b) => (a.metadata.index ?? 0) - (b.metadata.index ?? 0));
  return { first, alternates };
}

/** 取角色的 lorebook 资产 */
export async function listLorebookAssets(db: NarraDB, characterId: string) {
  return db.assets.where('[characterId+type]').equals([characterId, 'lorebook_entry']).toArray();
}
