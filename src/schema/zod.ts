/**
 * Zod schema（v0.6.1）。
 *
 * 关键实测约束：Zod v4 是严格的 —— z.string().optional() 遇到 number 会直接失败。
 * 因此卡片导入采用「双 schema」：
 *   1. detect（期望类型）：逐字段 safeParse，失败只产生 warning，永不阻断导入
 *   2. take（宽松取值）：把任意类型安全归一化为 string / string[]，供拆解使用
 * 否则「V3 字段类型不符」会被误做成阻断，违反 §5.2 第 3 条。
 */
import { z } from 'zod';

// ------------------------------------------------------------ 写入路径校验

export const TurnSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  activeRevisionId: z.string().min(1),
  status: z.enum(['active', 'discarded']),
  createdAt: z.number(),
});

export const TurnRevisionSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  userContent: z.string(),
  assistantContent: z.string(),
  status: z.enum(['active', 'superseded', 'interrupted']),
  reason: z
    .enum(['initial', 'amend', 'regenerate', 'greeting_switch', 'retry'])
    .optional(),
  requestId: z.string().optional(),
  createdAt: z.number(),
});

export const SessionSchema = z.object({
  id: z.string().min(1),
  characterId: z.string().min(1),
  title: z.string(),
  expectedSeq: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// ------------------------------------------------------------ 卡片导入：detect

/** 期望类型表：命中失败 → 字段级 warning，不阻止导入 */
const CARD_EXPECTATIONS: Record<string, z.ZodTypeAny> = {
  name: z.string(),
  description: z.string(),
  personality: z.string(),
  scenario: z.string(),
  first_mes: z.string(),
  mes_example: z.string(),
  creator_notes: z.string(),
  system_prompt: z.string(),
  post_history_instructions: z.string(),
  alternate_greetings: z.array(z.string()),
  tags: z.array(z.string()),
  character_book: z.object({}).passthrough(),
  extensions: z.object({}).passthrough(),
};

const LOREBOOK_ENTRY_EXPECTATIONS: Record<string, z.ZodTypeAny> = {
  keys: z.array(z.string()),
  secondary_keys: z.array(z.string()),
  content: z.string(),
  constant: z.boolean(),
  selective: z.boolean(),
  insertion_order: z.number(),
  enabled: z.boolean(),
  position: z.string(),
  depth: z.number(),
  scan_depth: z.number(),
  case_sensitive: z.boolean(),
  extensions: z.object({}).passthrough(),
};

export interface FieldIssue {
  path: string;
  expected: string;
  received: string;
  message: string;
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * 逐字段检测，只产出 warning。
 * 未知字段不检测（V3 的 extensions 千差万别，检测它们只会制造噪音）。
 */
export function detectCardFieldIssues(data: Record<string, unknown>): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const [field, schema] of Object.entries(CARD_EXPECTATIONS)) {
    if (!(field in data)) continue;
    const r = schema.safeParse(data[field]);
    if (!r.success) {
      issues.push({
        path: field,
        expected: schema.description ?? 'declared type',
        received: typeName(data[field]),
        message: `字段类型不符，可能影响触发/渲染，已按宽松取值处理`,
      });
    }
  }
  const book = data.character_book;
  if (book && typeof book === 'object') {
    const entries = (book as Record<string, unknown>).entries;
    if (Array.isArray(entries)) {
      entries.forEach((entry, i) => {
        if (!entry || typeof entry !== 'object') return;
        for (const [field, schema] of Object.entries(LOREBOOK_ENTRY_EXPECTATIONS)) {
          if (!(field in entry)) continue;
          const r = schema.safeParse((entry as Record<string, unknown>)[field]);
          if (!r.success) {
            issues.push({
              path: `character_book.entries[${i}].${field}`,
              expected: 'declared type',
              received: typeName((entry as Record<string, unknown>)[field]),
              message: `lorebook 条目字段类型不符，已按宽松取值处理`,
            });
          }
        }
      });
    }
  }
  return issues;
}

// ------------------------------------------------------------ 卡片导入：take

/** 宽松取字符串：任意类型 → string，缺失 → '' */
export function takeString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(takeString).join('\n');
  if (v && typeof v === 'object') return JSON.stringify(v);
  return '';
}

/** 宽松取字符串数组 */
export function takeStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(takeString).filter((s) => s.length > 0);
  if (typeof v === 'string' && v.length > 0) return [v];
  return [];
}

/** 宽松取数字 */
export function takeNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
    return Number(v);
  return fallback;
}

/** 宽松取布尔 */
export function takeBoolean(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1) return true;
  if (v === 'false' || v === 0) return false;
  return fallback;
}

// ------------------------------------------------------------ CJK 判定

/**
 * CJK 统一表意文字 + 假名 + 谚文。
 * 用于判断卡片是否「中文卡」，从而决定是否修正 match_whole_words。
 */
export const CJK_PATTERN =
  /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;

export function containsCJK(text: string): boolean {
  return CJK_PATTERN.test(text);
}
