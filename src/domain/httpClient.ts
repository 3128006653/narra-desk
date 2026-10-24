/**
 * 真实模型调用客户端（阶段二末关账项）。
 *
 * 与 `modelClient.ts` 的关系：那边是**接口 + 测试替身**，这边是**生产实现**。
 * 上层（摘要服务 / 组装器）只依赖接口，换传输不动逻辑。
 *
 * 三条刻意分开的概念（不要混）：
 *  1. **客户端侧超时** —— 我们自己设的 60s。归「可重试 / 网络」，走本地退避阶梯。
 *  2. **服务端 `Retry-After`** —— 429 带回的要求等待时间。归「服务端要求等待」，
 *     走 `max(本地退避, Retry-After)`。
 *  3. **终态错误** —— 4xx 参数/鉴权/内容过滤。重试也不会成功，直接 failed。
 *
 * ⚠️ `source` 固定为 `'model'`：这是真实 client，产物可被注入。
 *    （占位器必须显式声明 `'stub'`，见 `modelClient.ts` 的约定。）
 */
import type { ServiceRef } from '../schema/entities';
import { ChatError, parseRetryAfter, type ChatClient, type ChatRequest } from './modelClient';
import { assembleStreamToolCalls, type ProviderToolCall, type ToolSpec, type ToolsCompletion } from './toolLoop';

// ------------------------------------------------------------ HTTP 状态码 → 是否重试

/**
 * 显式状态码表，**不是** if-else 区间判断。
 *
 * 为什么用表：加新状态码时一眼看出归哪边；更重要的是区间判断会判错 ——
 * `408 Request Timeout` 是 4xx 但**可重试**，`409/422` 是 4xx 但**不可重试**。
 * 「4xx 一律不重试」这种范围规则在这两个码上都是错的。
 */
export const HTTP_RETRY_POLICY: Record<number, { retryable: boolean; kind: string }> = {
  // —— 可重试 ——
  408: { retryable: true, kind: 'timeout' },
  425: { retryable: true, kind: 'too_early' },
  429: { retryable: true, kind: 'rate_limit' },
  500: { retryable: true, kind: 'server' },
  502: { retryable: true, kind: 'server' },
  503: { retryable: true, kind: 'server' },
  504: { retryable: true, kind: 'server' },
  // —— 不可重试（重试也不会成功，只会消耗退避配额）——
  400: { retryable: false, kind: 'invalid_request' },
  401: { retryable: false, kind: 'auth' },
  403: { retryable: false, kind: 'auth' },
  404: { retryable: false, kind: 'not_found' },
  409: { retryable: false, kind: 'conflict' },
  413: { retryable: false, kind: 'too_large' },
  422: { retryable: false, kind: 'invalid_request' },
};

/** 兜底分类：表未覆盖时按类别推断（5xx 可重试，其余不可） */
export function classifyStatus(status: number): { retryable: boolean; kind: string } {
  const hit = HTTP_RETRY_POLICY[status];
  if (hit) return hit;
  if (status >= 500) return { retryable: true, kind: 'server' };
  return { retryable: false, kind: 'http_error' };
}

// ------------------------------------------------------------ 传输层

export interface HttpChatClientOptions {
  /**
   * 基础 URL。**来源取决于部署模式，不要硬编码成 `location.origin`**：
   *   - **推荐部署（单文件二进制）**：`location.origin` —— 二进制同时托管前端与代理，
   *     前端与 `/v1/*` 同源，天然无 CORS 问题。
   *   - **纯前端直连**：用户自填的服务商 endpoint。此时**CORS 与 endpoint 可达性由用户负责**，
   *     直连失败应提示「推荐改用本地二进制部署」，而不是当成 bug。
   */
  baseUrl: string;
  /** 注入 fetch（测试用；生产用全局 fetch） */
  fetchImpl?: typeof fetch;
  /** 客户端侧超时（毫秒），默认 60s。与 Retry-After 无关，见文件头第 1 条 */
  timeoutMs?: number;
  /** 取凭证 —— 由调用方注入，本文件不接触密钥（§5.3） */
  resolveApiKey?: (service: ServiceRef) => Promise<string> | string;
}

/** OpenAI 兼容的 `/v1/chat/completions` 响应体（只取用到的字段） */
interface CompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    delta?: {
      content?: string;
      tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number };
  error?: { message?: string; code?: string };
}

/** 取结束原因：`tool_calls` 是**继续**信号，不是结束信号（坑 3） */
export function finishReasonOf(body: CompletionResponse): string | undefined {
  return body.choices?.[0]?.finish_reason;
}

export interface HttpClientExtras {
  /** 真实 usage（token 校准用，见 `tokenCalibration.ts`） */
  lastPromptTokens?: number;
}

export type HttpChatClient = ChatClient & HttpClientExtras;

/**
 * 构造真实 client（非流式 / 流式同一实现，流式多传一个 onDelta）。
 *
 * 流式中断与阶段一对齐（§4.2）：`completeStream` 在异常路径也会 return 已收到的
 * partial，**由调用方写入 `interrupted` revision**。不能只处理正常完成 ——
 * 否则网络中断时用户输入会丢。
 */
export function httpChatClient(opts: HttpChatClientOptions): HttpChatClient {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  const client: HttpChatClient = {
    source: 'model',

    async complete(req: ChatRequest): Promise<string> {
      const body = await callJson(req);
      if (body.usage?.prompt_tokens !== undefined) {
        client.lastPromptTokens = body.usage.prompt_tokens;
      }
      return body.choices?.[0]?.message?.content ?? '';
    },

    async completeStream(req: ChatRequest, onDelta: (chunk: string) => void): Promise<string> {
      return stream(req, onDelta);
    },

    async completeWithTools(req: ChatRequest & { tools?: ToolSpec[] }): Promise<ToolsCompletion> {
      const body = await callJson(req, req.tools);
      if (body.usage?.prompt_tokens !== undefined) {
        client.lastPromptTokens = body.usage.prompt_tokens;
      }
      const choice = body.choices?.[0];
      const toolCalls: ProviderToolCall[] = (choice?.message?.tool_calls ?? []).map((c) => {
        let args: unknown = c.function?.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            /* 保持原始字符串，交给调用方诊断 */
          }
        }
        return { id: c.id ?? '', name: c.function?.name ?? '', args };
      });
      return {
        content: choice?.message?.content ?? '',
        toolCalls,
        finishReason: finishReasonOf(body),
      };
    },
  } as HttpChatClient & StreamingCapable & ToolsCapable;

  // ---------------------------------------------------------- 内部实现

  async function callJson(req: ChatRequest, tools?: ToolSpec[]): Promise<CompletionResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // 客户端侧 abort 与调用方 signal 都要生效
    req.signal?.addEventListener('abort', () => ctrl.abort());

    try {
      const res = await doFetch(joinUrl(opts.baseUrl, '/v1/chat/completions'), {
        method: 'POST',
        headers: await buildHeaders(req),
        body: JSON.stringify({
          model: req.service.model,
          messages: req.messages,
          max_tokens: req.maxTokens,
          stream: false,
          // tools 原样透传（JSON Schema 由调用方提供）
          ...(tools && tools.length
            ? { tools: tools.map((t) => ({ type: 'function', function: t })) }
            : {}),
        }),
        signal: ctrl.signal,
      });
      return await handleResponse(res);
    } catch (err) {
      throw normalizeTransportError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  async function stream(req: ChatRequest, onDelta: (chunk: string) => void): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    req.signal?.addEventListener('abort', () => ctrl.abort());

    let acc = '';
    const toolDeltas: Array<{ index: number; id?: string; name?: string; arguments?: string }> = [];
    try {
      const res = await doFetch(joinUrl(opts.baseUrl, '/v1/chat/completions'), {
        method: 'POST',
        headers: await buildHeaders(req),
        body: JSON.stringify({
          model: req.service.model,
          messages: req.messages,
          max_tokens: req.maxTokens,
          stream: true,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        await handleResponse(res);
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const parsed = parseSseLine(line);
          if (parsed === undefined) continue;
          acc += parsed.text;
          if (parsed.text) onDelta(parsed.text);
          // 流式 tool_calls 分片：按 index 归组，攒到结束再一次性装配（坑 2）
          if (parsed.toolCalls) toolDeltas.push(...parsed.toolCalls);
        }
      }
      // 流式下 tool_calls 必须**拼完整再 parse**：中途 parse 必然失败（JSON 未闭合）
      const toolCalls = toolDeltas.length ? assembleStreamToolCalls(toolDeltas) : undefined;
      if (toolCalls?.length) {
        (client as HttpChatClient & { lastStreamToolCalls?: ProviderToolCall[] }).lastStreamToolCalls =
          toolCalls;
      }
      return acc;
    } catch (err) {
      // ⚠️ 中断时**不吞掉**已收到的 partial：调用方据此写 `interrupted` revision。
      //    这里把 partial 挂在 error 上，由上游决定写入。
      const e = normalizeTransportError(err);
      (e as Error & { partial?: string }).partial = acc;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function buildHeaders(req: ChatRequest): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.resolveApiKey) {
      const key = await opts.resolveApiKey(req.service);
      if (key) headers.Authorization = `Bearer ${key}`;
    }
    return headers;
  }

  async function handleResponse(res: Response): Promise<CompletionResponse> {
    if (res.ok) return (await res.json()) as CompletionResponse;

    let body: CompletionResponse | undefined;
    try {
      body = (await res.json()) as CompletionResponse;
    } catch {
      /* 非 JSON 错误体，按状态码分类即可 */
    }
    const { retryable, kind } = classifyStatus(res.status);
    // 只有 429 才带 Retry-After 语义；其他状态码忽略该头
    const retryAfterMs =
      res.status === 429 ? parseRetryAfter(res.headers.get('Retry-After')) : undefined;

    const message =
      body?.error?.message ?? `${kind}: HTTP ${res.status}`;
    throw new ChatError(message, retryable, retryAfterMs);
  }

  return client;
}

/** 传输层异常归一化：AbortError → 可重试的 timeout，其余按网络错误处理 */
function normalizeTransportError(err: unknown): Error {
  if (err instanceof ChatError) return err;
  const name = (err as { name?: string } | null)?.name;
  if (name === 'AbortError') {
    return new ChatError('请求超时（客户端侧）', true);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ChatError(`网络错误：${message}`, true);
}

/**
 * SSE：`data: {...}` / `data: [DONE]`。
 * 同时返回 tool_calls 分片（坑 2）—— 它们不进正文，单独攒。
 */
function parseSseLine(
  line: string,
): { text?: string; toolCalls?: Array<{ index: number; id?: string; name?: string; arguments?: string }> } | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return undefined;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return undefined;
  try {
    const json = JSON.parse(payload) as CompletionResponse;
    const delta = json.choices?.[0]?.delta;
    const toolCalls = delta?.tool_calls?.map((c) => ({
      index: c.index ?? 0,
      id: c.id,
      name: c.function?.name,
      arguments: c.function?.arguments,
    }));
    const text = delta?.content ?? '';
    if (!text && !toolCalls?.length) return undefined;
    return { text: text || undefined, toolCalls };
  } catch {
    return undefined;
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** 允许流式调用的可选接口（只有需要流式的调用方才用） */
export interface StreamingCapable {
  completeStream(req: ChatRequest, onDelta: (chunk: string) => void): Promise<string>;
}

/** 支持工具调用的可选接口 —— 由 `toolLoop.ToolsCapableClient` 消费 */
export interface ToolsCapable {
  completeWithTools(
    req: ChatRequest & { tools?: ToolSpec[] },
  ): Promise<ToolsCompletion>;
}
