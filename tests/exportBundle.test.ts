/**
 * 导出 / 导入（阶段五第三轮）。
 *
 * ⚠️ **单向断言先于往返断言**（按建议）：往返测试（导出→导入→相等）会掩盖
 * 「导出丢字段、导入又补回来」的互相抵消。这里先分别断言导出侧与导入侧，
 * 最后才补一条往返。
 */
import { describe, expect, it } from 'vitest';
import {
  BUNDLE_FORMAT,
  CURRENT_SCHEMA_VERSION,
  IMPORT_LIMITS,
  buildBundle,
  buildMarkdownArchive,
  checkBundle,
  fnv1aHex,
  guardImport,
  guardImportSize,
  looksLikeMarkdownArchive,
  maxDepth,
  sortedByStableKey,
  stableSerialize,
  verifyManifest,
  type Bundle,
} from '../src/deploy/exportBundle';

// ------------------------------------------------------------ 导出侧单向断言

describe('导出：扁平化结构（同时解决循环引用与哈希链顺序）', () => {
  const entities = {
    characters: [{ id: 'c1', name: 'A', sessions: ['s1'] }],
    sessions: [{ id: 's1', characterId: 'c1', seq: 0 }],
    turns: [
      { id: 't2', sessionId: 's1', seq: 2 },
      { id: 't1', sessionId: 's1', seq: 1 },
    ],
  };
  it('实体间只通过 id 引用 —— 结构上不可能成环，JSON.stringify 不栈溢出', () => {
    const b = buildBundle({ entities, exportedAt: 1000 });
    expect(() => JSON.stringify(b)).not.toThrow();
    expect(b.format).toBe(BUNDLE_FORMAT);
    expect(Object.keys(b.entities).sort()).toEqual(['characters', 'sessions', 'turns']);
  });
  it('turns 按 (sessionId, seq) 显式排序，不依赖取出顺序（P-1）', () => {
    const b = buildBundle({ entities, exportedAt: 1000 });
    expect(b.entities.turns.map((t) => (t as { seq: number }).seq)).toEqual([1, 2]);
  });
  it('带 schemaVersion —— 导入时据此走迁移链', () => {
    const b = buildBundle({ entities, exportedAt: 1000 });
    expect(b.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
  it('排序是稳定的：已排序输入再导一次顺序不变', () => {
    const once = buildBundle({ entities, exportedAt: 1000 });
    const twice = buildBundle({ entities: once.entities as never, exportedAt: 1000 });
    expect(JSON.stringify(twice.entities)).toBe(JSON.stringify(once.entities));
  });
});

describe('导出：哈希链确定性', () => {
  const rows = [{ id: 'b' }, { id: 'a' }];
  it('同样的数据导出两次，自哈希与链哈希完全一致', () => {
    const b1 = buildBundle({ entities: { characters: rows }, exportedAt: 1 });
    const b2 = buildBundle({ entities: { characters: rows }, exportedAt: 1 });
    expect(b1.manifest).toEqual(b2.manifest);
    expect(fnv1aHex('x')).toBe(fnv1aHex('x'));
  });
  it('输入顺序不同但内容相同时，哈希链仍一致（排序生效）', () => {
    const b1 = buildBundle({ entities: { characters: [{ id: 'a' }, { id: 'b' }] }, exportedAt: 1 });
    const b2 = buildBundle({ entities: { characters: [{ id: 'b' }, { id: 'a' }] }, exportedAt: 1 });
    expect(b1.manifest).toEqual(b2.manifest);
  });
  it('prevHash 正确串联（首项为 0 填充）', () => {
    const b = buildBundle({ entities: { characters: [{ id: 'a' }, { id: 'b' }] }, exportedAt: 1 });
    expect(b.manifest[0].prevHash).toBe('00000000');
    expect(b.manifest[1].prevHash).toBe(b.manifest[0].selfHash);
  });
  it('属性插入顺序不影响哈希（stableSerialize 按键排序）', () => {
    expect(fnv1aHex(JSON.stringify({ a: 1, b: 2 }))).not.toBe(
      fnv1aHex(JSON.stringify({ b: 2, a: 1 })),
    ); // 裸 stringify 依赖顺序 → 必须走 stableSerialize
    const b1 = buildBundle({ entities: { c: [{ a: 1, b: 2 }] }, exportedAt: 1 });
    const b2 = buildBundle({ entities: { c: [{ b: 2, a: 1 }] }, exportedAt: 1 });
    expect(b1.manifest[0].selfHash).toBe(b2.manifest[0].selfHash);
  });
});

describe('导出：完整性校验能发现篡改', () => {
  it('原始包通过', () => {
    const b = buildBundle({ entities: { characters: [{ id: 'a' }] }, exportedAt: 1 });
    expect(verifyManifest(b).ok).toBe(true);
  });
  it('修改任一实体 → 校验失败并指出位置', () => {
    const b = buildBundle({ entities: { characters: [{ id: 'a' }, { id: 'b' }] }, exportedAt: 1 });
    (b.entities.characters[1] as { id: string }).id = 'tampered';
    const r = verifyManifest(b);
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe('characters[1]');
  });
  it('删除一条 → 清单与实体不匹配', () => {
    const b = buildBundle({ entities: { characters: [{ id: 'a' }, { id: 'b' }] }, exportedAt: 1 });
    b.entities.characters.pop();
    expect(verifyManifest(b).ok).toBe(false);
  });
});

// ------------------------------------------------------------ 导入侧单向断言

describe('导入：版本兼容的两个边界', () => {
  it('包版本比应用新 → 拒绝并提示升级', () => {
    const r = checkBundle({ format: BUNDLE_FORMAT, schemaVersion: CURRENT_SCHEMA_VERSION + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('newer-than-app');
      expect(r.message).toContain('升级应用');
    }
  });
  it('包版本过旧且迁移链断裂 → 拒绝并提示用旧版本打开', () => {
    const r = checkBundle({ format: BUNDLE_FORMAT, schemaVersion: 1 }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('migration-broken');
      expect(r.message).toContain('旧版本');
    }
  });
  it('迁移链完整 → 通过并标记需要迁移', () => {
    const chain = { 1: (v: unknown) => v, 2: (v: unknown) => v, 3: (v: unknown) => v, 4: (v: unknown) => v };
    const r = checkBundle({ format: BUNDLE_FORMAT, schemaVersion: 1 }, chain);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.needsMigration).toBe(true);
  });
  it('同版本 → 通过且不需要迁移', () => {
    const r = checkBundle({ format: BUNDLE_FORMAT, schemaVersion: CURRENT_SCHEMA_VERSION });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.needsMigration).toBe(false);
  });
  it('缺少 schemaVersion → 拒绝（无法判断迁移路径）', () => {
    const r = checkBundle({ format: BUNDLE_FORMAT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-bundle');
  });
  it('Markdown 归档 → not-bundle，提示用 JSON 恢复', () => {
    const r = checkBundle({ format: 'markdown' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('not-bundle');
      expect(r.message).toContain('Markdown');
    }
  });
});

// ------------------------------------------------------------ Markdown 归档

describe('Markdown 归档：用户内容用代码块包裹（不尝试转义）', () => {
  const input = {
    characterName: 'A',
    sessionTitle: 'T',
    turns: [
      {
        seq: 1,
        userContent: '# 标题\n* 列表\n| a | b |\n`代码`',
        assistantContent: '普通',
      },
    ],
    facts: [{ key: 'location.current', value: '钟楼 | 旧城区' }],
  };
  it('用户内容整体进 ```text 栅栏 —— 原样保留，不破坏外层格式', () => {
    const md = buildMarkdownArchive(input);
    expect(md).toContain('```text\n# 标题\n* 列表\n| a | b |\n`代码`\n```');
  });
  it('归档头声明只读', () => {
    const md = buildMarkdownArchive(input);
    expect(md).toContain('只读归档');
    expect(md).toContain('不可用于恢复数据');
  });
  it('含反引号的值：加长围栏，不替换字符（避免信息损失）', () => {
    const md = buildMarkdownArchive({
      ...input,
      facts: [{ key: 'k', value: 'a `b` c' }],
    });
    // 最长连续反引号 1 → 围栏 3；原文逐字保留，不出现单引号替换
    expect(md).toContain('```a `b` c```');
    expect(md).toContain('a `b` c');
    expect(md).not.toContain("a 'b' c"); // 替换成单引号会丢失「原文是反引号」这一信息
  });
  it('含连续反引号时围栏更长（max run + 1）', () => {
    const md = buildMarkdownArchive({
      ...input,
      facts: [{ key: 'k', value: 'x ``` y' }],
    });
    expect(md).toContain('````x ``` y````');
  });
  it('首尾为反引号时补空格，避免与分隔符连成更长串', () => {
    const md = buildMarkdownArchive({
      ...input,
      facts: [{ key: 'k', value: '`a`' }],
    });
    expect(md).toContain('``` `a` ```');
    expect(md).not.toContain('````a````'); // 未补空格时首尾会连成 4 连反引号
  });
  it('用户正文含三连反引号不提前闭合代码块', () => {
    const md = buildMarkdownArchive({
      ...input,
      turns: [{ seq: 1, userContent: '```\ncode\n```', assistantContent: 'a' }],
    });
    // 正文里有 3 连 → 围栏升到 4
    expect(md).toContain('````text\n```\ncode\n```\n````');
  });
  it('版本标记只在非 0 版时显示', () => {
    const md = buildMarkdownArchive({
      ...input,
      turns: [
        { seq: 1, userContent: 'u', assistantContent: 'a', version: 0 },
        { seq: 2, userContent: 'u', assistantContent: 'a', version: 1 },
      ],
    });
    expect(md).toContain('## 第 1 轮\n');
    expect(md).toContain('## 第 2 轮（v2）');
  });
  it('识别 Markdown（用于导入时拒绝）', () => {
    const md = buildMarkdownArchive(input);
    expect(looksLikeMarkdownArchive(md)).toBe(true);
    expect(looksLikeMarkdownArchive('{"a":1}')).toBe(false);
  });
});

// ------------------------------------------------------------ 往返（最后）

describe('往返：单向断言通过后才看这条', () => {
  it('导出 → 校验 → 导入检查 全链路一致', () => {
    const entities = {
      characters: [{ id: 'c1', name: 'A' }],
      turns: [
        { id: 't2', sessionId: 's1', seq: 2 },
        { id: 't1', sessionId: 's1', seq: 1 },
      ],
    };
    const b: Bundle<Record<string, unknown>> = buildBundle({ entities, exportedAt: 5 });
    expect(verifyManifest(b).ok).toBe(true);
    const parsed = JSON.parse(JSON.stringify(b));
    expect(checkBundle(parsed).ok).toBe(true);
    expect(sortedByStableKey('turns', parsed.entities.turns).map((t) => (t as { seq: number }).seq)).toEqual([1, 2]);
  });
});


// ------------------------------------------------------------ stableSerialize 键序

describe('stableSerialize：键序必须与 JSON.stringify 规范一致', () => {
  it('整数索引键按数值升序在前，不是字典序（防未来加数字键字段）', () => {
    // 字典序会排成 "10" < "2"；规范是 2 在前
    expect(stableSerialize({ '2': 1, '10': 2 })).toBe(stableSerialize({ '10': 2, '2': 1 }));
    expect(stableSerialize({ '10': 2, '2': 1 })).toBe('{"2":1,"10":2}');
  });
  it('与 JSON.stringify 在同一对象上结果一致', () => {
    const o = { '10': 2, '2': 1 };
    expect(stableSerialize(o)).toBe(JSON.stringify(o));
  });
  it('字符串键走字典序，且排在所有索引键之后', () => {
    expect(stableSerialize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableSerialize({ b: 1, '1': 9, a: 2 })).toBe('{"1":9,"a":2,"b":1}');
  });
  it('非 canonical 数字串（如 "01"）不算索引键', () => {
    expect(stableSerialize({ '01': 1, '2': 2 })).toBe('{"2":2,"01":1}');
  });
  it('数组保持元素顺序（不参与键排序）', () => {
    expect(stableSerialize({ a: [3, 1] })).toBe('{"a":[3,1]}');
  });
});

// ------------------------------------------------------------ 导入侧防御

describe('导入守卫：大小与深度上限（唯一接受外部输入的入口）', () => {
  it('体积超限 → 拒绝且**不解析**（O(1) 挡在 parse 之前）', () => {
    let parsed = 0;
    // byteLength 注入，避免真的构造 100MB 字符串
    const r = guardImport(
      '{}',
      () => {
        parsed++;
        return {};
      },
      () => IMPORT_LIMITS.maxFileBytes + 1,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too-large');
    expect(parsed).toBe(0); // 关键：parse 根本没被调用
  });
  it('体积恰在上限 → 放行（边界）', () => {
    expect(guardImportSize(IMPORT_LIMITS.maxFileBytes).ok).toBe(true);
    expect(guardImportSize(IMPORT_LIMITS.maxFileBytes + 1).ok).toBe(false);
  });
  it('体积在上限内 → 放行', () => {
    const r = guardImport('{"a":1}', (t) => JSON.parse(t));
    expect(r.ok).toBe(true);
  });
  it('深度超限 → 拒绝', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 150; i++) deep = { a: deep };
    const r = guardImport(JSON.stringify(deep), (t) => JSON.parse(t));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too-deep');
  });
  it('深度在上限内 → 放行', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 50; i++) deep = { a: deep };
    expect(guardImport(JSON.stringify(deep), (t) => JSON.parse(t)).ok).toBe(true);
  });
  it('非法 JSON → 拒绝且给出明确原因', () => {
    const r = guardImport('{not json', (t) => JSON.parse(t));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('too-deep');
      expect(r.message).toContain('不是合法 JSON');
    }
  });
  it('maxDepth 早退：超限即返回，不遍历完整结构', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 5000; i++) deep = { a: deep };
    expect(maxDepth(deep)).toBeGreaterThan(IMPORT_LIMITS.maxDepth);
  });
  it('maxDepth 是迭代实现 —— 不会被深结构打爆栈', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 20000; i++) deep = { a: deep };
    expect(() => maxDepth(deep)).not.toThrow();
  });
});
