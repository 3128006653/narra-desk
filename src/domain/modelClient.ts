/**
 * 模型调用抽象（阶段二）。
 *
 * 摘要服务与（阶段二末的）组装器都只依赖 `ChatClient` 接口，不依赖具体 SDK ——
 * 便于单测注入 fake，也便于「浏览器直连 / 本地代理」两种传输互换而不动上层。
 *
 * `ServiceRef` **不携带明文密钥**（§5.3）：凭证由独立密钥存储按 `service.id` 取出，
 * 传输层自己解决。本文件不接触密钥。
 */
import type { ServiceRef } from '../schema/entities';

export interface ChatMessage {
  /**
   * `'tool'` 是 OpenAI 兼容格式里**回传工具结果**的角色。
   *
   * 必须与 `tool_call_id` 成对出现 —— 工具结果不带 id 的话，模型看到的是一串
   * 没有归属的结果（阶段三坑 1）。序列化时原样透传给 provider。
   */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** ⚠️ `role: 'tool'` 时**必须是字符串**；对象要 `JSON.stringify`（坑 4） */
  content: string;
  /** 引用 `tool_calls[].id` */
  tool_call_id?: string;
  /** assistant 消息携带的工具调用请求（重放/审计用） */
  tool_calls?: Array<{ id: string; type?: string; function?: { name?: string; arguments?: string } }>;
}

export interface ChatRequest {
  service: ServiceRef;
  messages: ChatMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatClient {
  complete(req: ChatRequest): Promise<string>;
  /**
   * 产物来源标记（I-16）。缺省按 `'model'` 处理。
   *
   * 两个默认值方向相反，但都指向「让不确定性留在安全侧」：
   *   - **缺省 → `'model'`**：真实 client 是绝大多数，默认信任；
   *     若缺省给 stub，正常产物会全部被拦下不注入，静默失效更糟。
   *   - **迁移回填 → `'stub'`**（见 `migrationV4`）：旧行来历不明，宁可重建不冒险注入。
   *
   * ⚠️ **约定（唯一防线）**：任何占位器 / 测试 / mock client **必须显式声明 `source: 'stub'`**。
   *    这是防止伪摘要以 `ok` 状态永久注入的唯一机制 —— 没有编译期手段能强制它，
   *    所以写新占位器时请照抄 `stubSummarizer.ts` 的写法。
   */
  source?: 'stub' | 'model';
}

/** 可重试判定：网络/限流类错误才值得退避重试；参数错误重试无意义 */
export class ChatError extends Error {
  readonly retryable: boolean;
  /**
   * 服务端建议的等待时间（毫秒），通常来自 429 的 `Retry-After`（I-22）。
   * 任务中心取 `max(本地退避, retryAfterMs)` —— 短于服务端要求会连续撞限流，
   * 长于则无谓延迟。
   */
  readonly retryAfterMs?: number;
  constructor(message: string, retryable = true, retryAfterMs?: number) {
    super(message);
    this.name = 'ChatError';
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * 解析 `Retry-After`（I-22）：支持秒数（`"30"`）与 HTTP 日期两种形式。
 * 解析不了返回 undefined，由调用方回退到纯本地退避。
 *
 * ⚠️ **408 的 retryAfterMs 恒为 undefined，不要给它加**：
 *    408（Request Timeout）是**服务端等客户端**超时，属于服务端返回的状态码，
 *    走本地退避即可；客户端侧 abort 根本不经过 HTTP 响应，也没有 header 可读。
 *    只有 **429** 才带「服务端要求等待」的语义。
 */
export function parseRetryAfter(header?: string | null, base = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - base);
}

/** 从任意错误上读取 `retryAfterMs`（供任务中心鸭子类型读取，避免模块耦合） */
export function retryAfterMsOf(err: unknown): number | undefined {
  const v = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof v === 'number' && v > 0 ? v : undefined;
}

/**
 * 固定应答的 fake client（单测用）。
 * `impl` 抛 ChatError 即模拟失败；retryable=false 模拟「重试也没用」的终态错误。
 */
export function fakeClient(
  impl: (req: ChatRequest) => string | Promise<string>,
): ChatClient & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    calls,
    async complete(req) {
      calls.push(req);
      return impl(req);
    },
  };
}

/** 失败 N 次后成功的 fake：用于验证退避重试链路 */
export function flakyClient(
  failTimes: number,
  successText = 'ok',
  errorText = 'boom',
): ChatClient & { calls: ChatRequest[] } {
  let n = 0;
  return fakeClient(() => {
    n += 1;
    if (n <= failTimes) throw new ChatError(errorText);
    return successText;
  });
}
