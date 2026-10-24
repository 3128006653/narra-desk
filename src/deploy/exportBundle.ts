/**
 * 导出 / 导入（阶段五第三轮）。
 *
 * ## 为什么是扁平化结构
 *
 * 第一版就定死，不采用「嵌套实体」：
 * 1. **循环引用**：`Session` 引用 `Character`、`Turn` 引用 `Session`，嵌套会让
 *    `JSON.stringify` 直接栈溢出。扁平化后实体间**只通过 id 引用**，结构上不可能成环。
 * 2. **哈希链顺序**：清单哈希链需要确定性顺序，否则同样的数据导出两次哈希不同，
 *    「文件是否完整」的判断就失效。扁平化后每类按稳定键排序即可（见 `sortedByStableKey`）。
 *
 * ⚠️ 顺序不能假设（PITFALLS P-1）：从 IndexedDB 取出的数组顺序由主键决定，
 * 导出前必须**显式排序**，不能依赖取出顺序。
 */

export const BUNDLE_FORMAT = 'narra-desk-bundle';
/** 当前 schema 版本；导入时据此走迁移链 */
export const CURRENT_SCHEMA_VERSION = 5;

export interface Bundle<T = unknown> {
  format: typeof BUNDLE_FORMAT;
  schemaVersion: number;
  exportedAt: number;
  /** 实体表：扁平化，实体间只通过 id 引用 */
  entities: Record<string, T[]>;
  /** 清单哈希链：每项含自身哈希与上一项哈希，用于检测文件完整性 */
  manifest: ManifestEntry[];
}

export interface ManifestEntry {
  /** 稳定路径，如 `turns[12]` */
  path: string;
  selfHash: string;
  prevHash: string;
}

/** 稳定排序键：各类实体的排序依据 */
const STABLE_KEYS: Record<string, string[]> = {
  characters: ['id'],
  sessions: ['id'],
  turns: ['sessionId', 'seq'],
  turnRevisions: ['turnId', 'createdAt', 'id'],
  summaryViews: ['sessionId', 'id'],
  facts: ['sessionId', 'id'],
  tasks: ['sessionId', 'id'],
};

function stableKeyValue(rec: Record<string, unknown>, keys: string[]): string {
  // 用 \u001f 分隔（与 I-32 一致的原因：NUL 会污染文本处理，US 是安全的字段分隔符）
  return keys.map((k) => String(rec[k] ?? '')).join('');
}

export function sortedByStableKey(table: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const keys = STABLE_KEYS[table] ?? ['id'];
  return [...rows].sort((a, b) => {
    const ka = stableKeyValue(a, keys);
    const kb = stableKeyValue(b, keys);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** 轻量哈希（FNV-1a 32bit 十六进制）。用于完整性校验，不是安全机制 */
export function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface BuildBundleInput {
  entities: Record<string, Record<string, unknown>[]>;
  exportedAt?: number;
  schemaVersion?: number;
}

export function buildBundle(input: BuildBundleInput): Bundle<Record<string, unknown>> {
  const entities: Record<string, Record<string, unknown>[]> = {};
  for (const [table, rows] of Object.entries(input.entities)) {
    entities[table] = sortedByStableKey(table, rows);
  }

  const manifest: ManifestEntry[] = [];
  let prev = '0'.repeat(8);
  // 表顺序也要稳定 —— Object.entries 的顺序依赖插入顺序，显式排序
  for (const table of Object.keys(entities).sort()) {
    const rows = entities[table];
    for (let i = 0; i < rows.length; i++) {
      const path = `${table}[${i}]`;
      const selfHash = fnv1aHex(stableSerialize(rows[i]));
      manifest.push({ path, selfHash, prevHash: prev });
      prev = selfHash;
    }
  }

  return {
    format: BUNDLE_FORMAT,
    schemaVersion: input.schemaVersion ?? CURRENT_SCHEMA_VERSION,
    exportedAt: input.exportedAt ?? 0,
    entities,
    manifest,
  };
}

/**
 * 是否为 JS 的「整数索引键」（array index）。
 * 规范定义：canonical 十进制字符串，且数值 0 ≤ n < 2^32-1。
 */
function isIndexKey(k: string): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(k)) return false;
  return Number(k) < 0xffffffff - 1;
}

/**
 * 键排序，遵循 JS 属性顺序规范：整数索引键按**数值升序**在前，其余字符串键按字典序在后。
 *
 * ⚠️ 不能只做 `sort()` 字典序：`{"10":..,"2":..}` 字典序是 `"10" < "2"`，
 * 而 `JSON.stringify` 遵循规范排成 `2` 在前 —— 两者不一致时，
 * 走 `JSON.stringify` 的路径与走 `stableSerialize` 的路径会算出不同哈希，链就对不上。
 * 当前实体 id 是 uuid、字段名是字符串，不会触发；这条防的是**未来加数字键字段**。
 */
function sortKeys(keys: string[]): string[] {
  const idx = keys.filter(isIndexKey).sort((a, b) => Number(a) - Number(b));
  const str = keys.filter((k) => !isIndexKey(k)).sort();
  return [...idx, ...str];
}

/** 稳定序列化：键序确定，避免属性插入顺序影响哈希 */
export function stableSerialize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableSerialize).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${sortKeys(Object.keys(o))
    .map((k) => `${JSON.stringify(k)}:${stableSerialize(o[k])}`)
    .join(',')}}`;
}

// ------------------------------------------------------------------ 导入

export type ImportCheck =
  | { ok: true; needsMigration: boolean }
  | { ok: false; reason: ImportRejectReason; message: string };

export type ImportRejectReason =
  /** 不是本格式的包（可能是 Markdown 归档） */
  | 'not-bundle'
  /** 导出包比当前代码新 */
  | 'newer-than-app'
  /** 过旧且迁移链断裂 */
  | 'migration-broken'
  /** 清单哈希链校验失败 */
  | 'integrity';

/** 迁移链：从某版本到下一版本的转换器；缺失即链断裂 */
export type MigrationChain = Record<number, (v: unknown) => unknown>;

/** 已知的最低可迁移版本；低于它且链断裂则拒绝 */
export const MIN_MIGRATABLE_VERSION = 1;

export function checkBundle(bundle: unknown, chain: MigrationChain = {}): ImportCheck {
  if (
    !bundle ||
    typeof bundle !== 'object' ||
    (bundle as { format?: unknown }).format !== BUNDLE_FORMAT
  ) {
    return {
      ok: false,
      reason: 'not-bundle',
      message: '不是可回导的 JSON 包（Markdown 归档为只读，请用 JSON 包恢复）',
    };
  }
  const b = bundle as Bundle;
  if (typeof b.schemaVersion !== 'number') {
    return {
      ok: false,
      reason: 'not-bundle',
      message: '导出包缺少 schemaVersion，无法判断迁移路径',
    };
  }
  if (b.schemaVersion > CURRENT_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'newer-than-app',
      message: `导出包版本 v${b.schemaVersion} 高于当前应用 v${CURRENT_SCHEMA_VERSION}，请升级应用后再导入`,
    };
  }
  if (b.schemaVersion < MIN_MIGRATABLE_VERSION || !hasChain(b.schemaVersion, chain)) {
    return {
      ok: false,
      reason: 'migration-broken',
      message: `导出包版本 v${b.schemaVersion} 过旧或迁移链断裂，请用旧版本打开后重新导出`,
    };
  }
  return { ok: true, needsMigration: b.schemaVersion < CURRENT_SCHEMA_VERSION };
}

function hasChain(from: number, chain: MigrationChain): boolean {
  for (let v = from; v < CURRENT_SCHEMA_VERSION; v++) {
    if (typeof chain[v] !== 'function') return false;
  }
  return true;
}

/** 校验清单哈希链 */
export function verifyManifest(bundle: Bundle): { ok: boolean; failedAt?: string } {
  const byPath = new Map<string, unknown>();
  for (const [table, rows] of Object.entries(bundle.entities ?? {})) {
    for (let i = 0; i < rows.length; i++) byPath.set(`${table}[${i}]`, rows[i]);
  }
  let prev = '0'.repeat(8);
  for (const e of bundle.manifest ?? []) {
    const rec = byPath.get(e.path);
    if (rec === undefined) return { ok: false, failedAt: e.path };
    if (fnv1aHex(stableSerialize(rec)) !== e.selfHash) return { ok: false, failedAt: e.path };
    if (e.prevHash !== prev) return { ok: false, failedAt: e.path };
    prev = e.selfHash;
  }
  return { ok: true };
}

// ------------------------------------------------------------------ 导入侧防御

/**
 * 导入是**唯一接受外部输入的入口** —— 用户导入别人分享的包是合理场景，
 * 而别人分享的包不一定可信。单人本地工具也要防：
 * 500MB 的 JSON 或深嵌套结构会让主线程卡死，且 `JSON.parse` 本身是递归的。
 *
 * 大小上限与 FS helper 的单文件上限对齐（100MB）。
 */
export const IMPORT_LIMITS = {
  maxFileBytes: 100 * 1024 * 1024,
  maxDepth: 100,
} as const;

export type ImportGuard =
  | { ok: true }
  | { ok: false; reason: 'too-large' | 'too-deep'; message: string };

/** 大小检查（parse 之前，O(1)）。可单独调用，便于不构造大字符串就测试 */
export function guardImportSize(bytes: number): ImportGuard {
  if (bytes > IMPORT_LIMITS.maxFileBytes) {
    return {
      ok: false,
      reason: 'too-large',
      message: `导入包 ${(bytes / 1024 / 1024).toFixed(1)}MB 超过上限 ${IMPORT_LIMITS.maxFileBytes / 1024 / 1024}MB，已拒绝解析`,
    };
  }
  return { ok: true };
}

/** 深度检查（parse 之后，需遍历结构） */
export function guardImportDepth(parsed: unknown): ImportGuard {
  const depth = maxDepth(parsed);
  if (depth > IMPORT_LIMITS.maxDepth) {
    return {
      ok: false,
      reason: 'too-deep',
      message: `导入包嵌套深度 ${depth} 超过上限 ${IMPORT_LIMITS.maxDepth}，已拒绝`,
    };
  }
  return { ok: true };
}

/**
 * 先查大小再 parse，再查深度 —— 顺序不能反：
 * 大小检查是 O(1)，能在 parse 之前挡掉绝大多数恶意输入；
 * 深度检查必须等 parse 之后才做得到（要遍历结构）。
 */
export function guardImport(
  raw: string,
  parse: (t: string) => unknown,
  byteLength: (t: string) => number = (t) => new TextEncoder().encode(t).length,
): ImportGuard {
  const sizeCheck = guardImportSize(byteLength(raw));
  if (!sizeCheck.ok) return sizeCheck;
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch {
    return { ok: false, reason: 'too-deep', message: '导入包不是合法 JSON' };
  }
  return guardImportDepth(parsed);
}

/** 迭代式求深度 —— 不用递归，避免守卫自己被深结构打爆 */
export function maxDepth(v: unknown): number {
  let max = 0;
  const stack: Array<{ v: unknown; d: number }> = [{ v, d: 1 }];
  while (stack.length) {
    const { v: cur, d } = stack.pop()!;
    if (d > max) max = d;
    if (d > IMPORT_LIMITS.maxDepth) return d; // 早退：已超限无需继续
    if (cur !== null && typeof cur === 'object') {
      for (const val of Object.values(cur as Record<string, unknown>)) {
        stack.push({ v: val, d: d + 1 });
      }
    }
  }
  return max;
}

// ------------------------------------------------------------------ Markdown 归档

/**
 * Markdown 归档：**只读**，不可回导。
 *
 * ⚠️ 用户内容一律用**代码块**包裹，而不是尝试转义 Markdown 特殊字符
 * （`#`、`*`、` `、`|` 等）。代码块是 Markdown 里唯一能保证「原样显示」的结构；
 * 逐个转义必然有漏网字符，而归档的首要目标是**不丢信息**，不是好看。
 */
export interface ArchiveInput {
  characterName: string;
  sessionTitle: string;
  turns: Array<{ seq: number; userContent: string; assistantContent: string; version?: number }>;
  facts: Array<{ key: string; value: string }>;
}

/**
 * 计算所需围栏长度：取内容中**最长连续反引号** n，用 n+1 个反引号（最少 3）。
 * 这是 CommonMark 定义的机制 —— 长围栏可以包含更短的反引号串，且不提前闭合。
 *
 * ⚠️ 不要用「把反引号替换成单引号」的做法：替换后「原文含反引号」与
 * 「原文含单引号」长得一样，是**用信息损失换格式安全**。
 * 而 Markdown 归档的首要目标是**不丢信息**（见 §5.10），两者冲突时必须选不丢信息。
 */
function fenceFor(s: string): string {
  let max = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch === '`') {
      cur++;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }
  return '`'.repeat(Math.max(3, max + 1));
}

export function buildMarkdownArchive(input: ArchiveInput): string {
  const fenced = (s: string) => {
    const f = fenceFor(s ?? '');
    return `${f}text\n${s ?? ''}\n${f}`;
  };
  const lines: string[] = [];
  lines.push(`# ${input.sessionTitle}`);
  lines.push('');
  lines.push(`> 角色：${input.characterName}`);
  lines.push('> **本文件为只读归档，不可用于恢复数据。请使用 JSON 包恢复。**');
  lines.push('');

  for (const t of input.turns) {
    const v = t.version && t.version > 0 ? `（v${t.version + 1}）` : '';
    lines.push(`## 第 ${t.seq} 轮${v}`);
    lines.push('');
    lines.push('### 用户');
    lines.push(fenced(t.userContent));
    lines.push('');
    lines.push('### 助手');
    lines.push(fenced(t.assistantContent));
    lines.push('');
  }

  if (input.facts.length) {
    lines.push('## 事实清单');
    lines.push('');
    for (const f of input.facts) {
      // 表格里管道符必须转义 —— 这是代码块之外唯一需要处理的场景
      lines.push(`- \`${f.key.replace(/\|/g, '\\|')}\` = ${fencedInline(f.value)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 行内代码包裹：同样用「加长围栏」而非替换字符。
 * 额外处理：内容以反引号开头或结尾时，两侧各补一个空格 —— 否则内容首尾的反引号
 * 会与分隔符连成更长的反引号串，导致 code span 无法正确闭合。
 * （CommonMark 规定：两侧都有单个空格时会各剥离一个，故补空格不损失信息。）
 */
function fencedInline(s: string): string {
  const str = String(s ?? '');
  const f = fenceFor(str);
  const needsPad = str.startsWith('`') || str.endsWith('`');
  return needsPad ? `${f} ${str} ${f}` : `${f}${str}${f}`;
}

/** 导入时识别只读归档（避免用户拿 .md 当恢复包） */
export function looksLikeMarkdownArchive(text: string): boolean {
  return /^#\s/m.test(text) && !text.trimStart().startsWith('{');
}
