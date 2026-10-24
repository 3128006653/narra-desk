/**
 * 角色卡导入测试（§5.2）。
 * 重点验证三条定案：自动修正（非警告）、宽松取值不阻断、lorebook 语义字段保留。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openForTest, type NarraDB } from '../src/schema/db';
import { importCard, listGreetingCandidates, listLorebookAssets } from '../src/domain/cardImport';
import { newId } from '../src/schema/ids';

let db: NarraDB;

beforeEach(async () => {
  db = await openForTest(`card-${Math.random().toString(36).slice(2)}`);
});

const V3_CJK_CARD = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: '沈青梧',
    description: '旧城区钟楼的守钟人，说话慢，用词考究。',
    personality: '沉静、克制、不善表达',
    scenario: '雨夜，钟楼顶层。',
    first_mes: '（她抬眼看向门口）你来得比预期晚。',
    mes_example: '{{user}}: 你是谁？\n{{char}}: 守钟的人。',
    alternate_greetings: ['（背对着门）把门关上。', '（擦拭齿轮）别踩到机油。'],
    extensions: {
      match_whole_words: true, // ← 中文卡上的错误配置，必须被自动修正
      talkativeness: 0.5,
    },
    character_book: {
      name: '钟楼设定',
      entries: [
        {
          keys: ['钟楼', '齿轮'],
          content: '钟楼建于 1902 年，机械结构由黄铜与铸铁构成。',
          constant: false,
          insertion_order: 10,
          scan_depth: 3,
          case_sensitive: false,
          extensions: { match_whole_words: true }, // ← 条目级同样要修正
        },
        {
          keys: [],
          content: '雨从未停过。',
          constant: true, // ← 常量但无 keys，应提示而非阻断
          insertion_order: 100,
        },
      ],
    },
  },
};

describe('V3 中文卡：自动修正而非仅警告', () => {
  it('extensions.match_whole_words 被自动改为 false 并记录', async () => {
    const res = await importCard(db, V3_CJK_CARD);
    expect(res.corrections).toHaveLength(2); // 卡片级 + 条目级
    expect(res.corrections[0]).toMatchObject({
      path: 'extensions.match_whole_words',
      from: true,
      to: false,
    });
    expect(res.character.cardSource.format).toBe('v3');
    expect(res.character.cardCorrections).toHaveLength(2);
  });

  it('lorebook 资产的 matchWholeWords 落为 false', async () => {
    const res = await importCard(db, V3_CJK_CARD);
    const books = res.assets.filter((a) => a.type === 'lorebook_entry');
    expect(books[0].metadata.matchWholeWords).toBe(false);
    // 原卡未被就地改写（raw 保留原值，修正只记录在 cardCorrections）
    const rawExt = (V3_CJK_CARD.data.extensions as Record<string, unknown>);
    expect(rawExt.match_whole_words).toBe(true);
  });

  it('constant 但无 keys 的条目：可导入 + 提示，不阻断', async () => {
    const res = await importCard(db, V3_CJK_CARD);
    const warn = res.warnings.find((w) => w.path === 'character_book.entries[1]');
    expect(warn?.message).toContain('常量语义');
    expect(res.assets.filter((a) => a.type === 'lorebook_entry')).toHaveLength(2);
  });
});

describe('英文卡不被误修正', () => {
  it('match_whole_words 保持 true（英文有真实单词边界）', async () => {
    const res = await importCard(db, {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'Elena',
        description: 'A clockkeeper in the old district.',
        first_mes: 'You are later than expected.',
        extensions: { match_whole_words: true },
        character_book: {
          entries: [{ keys: ['belfry'], content: 'Built in 1902.', extensions: { match_whole_words: true } }],
        },
      },
    });
    expect(res.corrections).toHaveLength(0);
    const books = await listLorebookAssets(db, res.character.id);
    expect(books[0].metadata.matchWholeWords).toBe(true);
  });
});

describe('宽松取值：类型不符只 warning，不阻断导入', () => {
  it('description 为数字时仍能导入，并产生字段级 warning', async () => {
    const res = await importCard(db, {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '坏卡',
        description: 12345, // 类型不符
        personality: ['数组', '也', '能', '取'],
        first_mes: '你好',
      },
    });
    expect(res.character.id).toBeTruthy();
    const issue = res.warnings.find((w) => w.path === 'description');
    expect(issue?.received).toBe('number');
    // 宽松取值把数组拼成字符串，不丢内容
    expect(res.assets.find((a) => a.type === 'personality')?.content).toBe('数组\n也\n能\n取');
  });

  it('V2 顶层字段（无 data 包裹）也能解析', async () => {
    const res = await importCard(db, {
      name: '顶层卡',
      first_mes: '直接放在顶层',
      description: '没有 data 包裹',
    });
    expect(res.character.cardSource.format).toBe('v2');
    expect(res.assets.find((a) => a.type === 'first_mes')?.content).toBe('直接放在顶层');
  });
});

describe('拆解完整性', () => {
  it('alternate greetings 拆为独立 greeting 资产并保留下标', async () => {
    const res = await importCard(db, V3_CJK_CARD);
    const { first, alternates } = await listGreetingCandidates(db, res.character.id);
    expect(first?.content).toBe('（她抬眼看向门口）你来得比预期晚。');
    expect(alternates.map((a) => a.metadata.index)).toEqual([0, 1]);
    expect(alternates).toHaveLength(2);
  });

  it('V2 的 depth 字段映射到 scan_depth', async () => {
    const res = await importCard(db, {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'V2 卡',
        first_mes: 'x',
        character_book: {
          entries: [{ keys: ['a'], content: 'c', depth: 4, insertion_order: 7 }],
        },
      },
    });
    const books = await listLorebookAssets(db, res.character.id);
    expect(books[0].metadata.scan_depth).toBe(4);
    expect(books[0].metadata.insertion_order).toBe(7);
  });
});

void newId;
