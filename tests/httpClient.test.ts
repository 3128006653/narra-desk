/**
 * 真实 HTTP client（阶段二末关账项）与 token 校准。
 *
 * 不依赖网络：`fetchImpl` 注入一个假的 Response，覆盖
 * 状态码分类、Retry-After、客户端超时、流式中断、按 family 校准。
 */
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
  HTTP_RETRY_POLICY,
  classifyStatus,
  httpChatClient,
  type HttpChatClientOptions,
} from '../src/domain/httpClient';
import { ChatError } from '../src/domain/modelClient';
import {
  calibrationReport,
  dumpSamples,
  loadFactors,
  modelFamily,
  recordTokenSample,
} from '../src/domain/tokenCalibration';
import { clearFactors } from '../src/domain/tokenEst';
import { estimateTokens } from '../src/domain/tokenEst';
import { stubSummarizer } from './helpers/stubSummarizer';
import type { ServiceRef } from '../src/schema/entities';

const SERVICE: ServiceRef = { id: 'svc', model: 'gpt-4o-2024-11-20' };

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

function errResponse(status: number, headers: Record<string, string> = {}, body?: unknown): Response {
  return {
    ok: false,
    status,
    headers: new Headers(headers),
    json: async () => body ?? { error: { message: `HTTP ${status}` } },
  } as unknown as Response;
}

function mk(over: Partial<HttpChatClientOptions> = {}) {
  return httpChatClient({
    baseUrl: 'http://127.0.0.1:1234',
    resolveApiKey: async () => 'sk-test',
    ...over,
  });
}

describe('HTTP 状态码 → retryable（显式表，不是区间判断）', () => {
  it('408 是 4xx 但可重试 —— 区间规则会判错', () => {
    expect(classifyStatus(408).retryable).toBe(true);
    expect(HTTP_RETRY_POLICY[408].kind).toBe('timeout');
  });

  it('409 / 422 是 4xx 且不可重试', () => {
    expect(classifyStatus(409).retryable).toBe(false);
    expect(classifyStatus(422).retryable).toBe(false);
  });

  it('429 可重试；5xx 可重试；401/403/404 不可', () => {
    expect(classifyStatus(429).retryable).toBe(true);
    expect(classifyStatus(500).retryable).toBe(true);
    expect(classifyStatus(503).retryable).toBe(true);
    expect(classifyStatus(401).retryable).toBe(false);
    expect(classifyStatus(403).retryable).toBe(false);
    expect(classifyStatus(404).retryable).toBe(false);
  });

  it('未覆盖的 5xx 兜底可重试，未覆盖的 4xx 兜底不可', () => {
    expect(classifyStatus(599).retryable).toBe(true);
    expect(classifyStatus(418).retryable).toBe(false);
  });
});

describe('429 与 Retry-After（与客户端超时是两回事）', () => {
  it('429 带 Retry-After 秒数 → 秒转毫秒', async () => {
    const c = mk({
      fetchImpl: async () => errResponse(429, { 'Retry-After': '30' }),
    });
    try {
      await c.complete({ service: SERVICE, messages: [] });
      throw new Error('应抛出');
    } catch (e) {
      expect(e).toBeInstanceOf(ChatError);
      expect((e as ChatError).retryable).toBe(true);
      expect((e as ChatError).retryAfterMs).toBe(30_000);
    }
  });

  it('429 带 HTTP 日期形式的 Retry-After', async () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const c = mk({ fetchImpl: async () => errResponse(429, { 'Retry-After': future }) });
    try {
      await c.complete({ service: SERVICE, messages: [] });
      throw new Error('应抛出');
    } catch (e) {
      const ms = (e as ChatError).retryAfterMs!;
      expect(ms).toBeGreaterThan(40_000);
      expect(ms).toBeLessThanOrEqual(45_000);
    }
  });

  it('非 429 即使带 Retry-After 也忽略该头', async () => {
    const c = mk({
      fetchImpl: async () => errResponse(503, { 'Retry-After': '30' }),
    });
    try {
      await c.complete({ service: SERVICE, messages: [] });
      throw new Error('应抛出');
    } catch (e) {
      expect((e as ChatError).retryAfterMs).toBeUndefined();
    }
  });

  it('客户端超时归「可重试 / 网络」，且不带 Retry-After', async () => {
    const c = mk({
      timeoutMs: 1,
      fetchImpl: async (_u, init) => {
        // 模拟永不返回，直到 signal abort
        await new Promise((_, rej) => {
          init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        });
        throw new Error('unreachable');
      },
    });
    try {
      await c.complete({ service: SERVICE, messages: [] });
      throw new Error('应抛出');
    } catch (e) {
      expect(e).toBeInstanceOf(ChatError);
      expect((e as ChatError).retryable).toBe(true);
      expect((e as ChatError).retryAfterMs).toBeUndefined(); // 超时 ≠ 服务端要求等待
      expect((e as Error).message).toContain('超时');
    }
  });
});

describe('成功路径与 source', () => {
  it('真实 client 声明 source: model，并记录 usage', async () => {
    const c = mk({
      fetchImpl: async () =>
        okJson({ choices: [{ message: { content: '摘要文本' } }], usage: { prompt_tokens: 123 } }),
    });
    expect(c.source).toBe('model'); // 真实 client 必须显式声明
    const text = await c.complete({ service: SERVICE, messages: [] });
    expect(text).toBe('摘要文本');
    expect(c.lastPromptTokens).toBe(123);
  });
});

describe('流式中断：异常路径也要把 partial 交回调用方', () => {
  it('中断时 error.partial 带上已收到的内容（供写 interrupted revision）', async () => {
    const encoder = new TextEncoder();
    let sent = 0;
    const c = mk({
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          body: {
            getReader: () => ({
              read: async () => {
                if (sent === 0) {
                  sent = 1;
                  return { done: false, value: encoder.encode('data: {"choices":[{"delta":{"content":"前半"}}]}\n\n') };
                }
                throw new Error('连接中断');
              },
            }),
          },
        } as unknown as Response),
    });
    const streamable = c as unknown as {
      completeStream(req: { service: ServiceRef; messages: [] }, onDelta: (t: string) => void): Promise<string>;
    };
    const deltas: string[] = [];
    try {
      await streamable.completeStream({ service: SERVICE, messages: [] }, (t) => deltas.push(t));
      throw new Error('应抛出');
    } catch (e) {
      expect(deltas).toEqual(['前半']);
      // 关键：partial 不能丢 —— 上游据此写 interrupted revision，用户输入才不会消失
      expect((e as Error & { partial?: string }).partial).toBe('前半');
    }
  });
});

describe('token 校准：按 model family 分组并持久化（I-24）', () => {
  it('modelFamily 剥掉日期后缀；显式 family 优先', () => {
    expect(modelFamily('gpt-4o-2024-11-20')).toBe('gpt-4o');
    expect(modelFamily('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet');
    expect(modelFamily('gpt-4o-2024-11-20', 'my-family')).toBe('my-family');
  });

  it('样本落库，达到阈值后回写系数并被 estimateTokens 采用', async () => {
    const { openForTest } = await import('../src/schema/db');
    const db = await openForTest(`calib-${Math.random()}`);
    const text = '这是一段用于校准的中文文本';

    // 未校准 → 默认 1.2
    expect(estimateTokens(text, 'gpt-4o')).toBe(estimateTokens(text));

    // 造 25 条比率 1.5 的样本（usage = est × 1.5）
    for (let i = 0; i < 25; i++) {
      await recordTokenSample(db, {
        model: 'gpt-4o-2024-11-20',
        text,
        usagePromptTokens: Math.round(estimateTokens(text) * 1.5),
      });
    }
    const report = await calibrationReport(db);
    expect(report).toHaveLength(1);
    expect(report[0].family).toBe('gpt-4o');
    expect(report[0].count).toBe(25);
    expect(report[0].calibrated).toBe(true); // 已达阈值
    expect(report[0].medianRatio).toBeCloseTo(1.5, 1);

    // 系数已灌入内存缓存 → 估算立刻变大
    await loadFactors(db);
    expect(estimateTokens(text, 'gpt-4o')).toBeGreaterThan(estimateTokens(text));

    // 持久化：新进程从库里读回，不再退回 1.2
    clearFactors();
    expect(estimateTokens(text, 'gpt-4o')).toBe(estimateTokens(text)); // 缓存空 → 默认
    const loaded = await loadFactors(db);
    expect(loaded['gpt-4o']).toBeGreaterThan(1.2);
    expect(estimateTokens(text, 'gpt-4o')).toBeGreaterThan(estimateTokens(text));
  });

  it('样本不足阈值时不动系数（3 条的中位数没有统计意义）', async () => {
    const { openForTest } = await import('../src/schema/db');
    const db = await openForTest(`calib2-${Math.random()}`);
    const text = '短文本';
    for (let i = 0; i < 3; i++) {
      await recordTokenSample(db, { model: 'm', text, usagePromptTokens: estimateTokens(text) * 2 });
    }
    const report = await calibrationReport(db);
    expect(report[0].calibrated).toBe(false);
    expect(report[0].factor).toBe(1.2);
  });

  it('无效样本不记录', async () => {
    const { openForTest } = await import('../src/schema/db');
    const db = await openForTest(`calib3-${Math.random()}`);
    expect(await recordTokenSample(db, { model: 'm', text: '', usagePromptTokens: 10 })).toBeUndefined();
    expect(await recordTokenSample(db, { model: 'm', text: 'x', usagePromptTokens: 0 })).toBeUndefined();
    expect(await calibrationReport(db)).toHaveLength(0);
  });
});

/**
 * 完整链路（接真实 client 后必须先跑这一条再删 stub）：
 * 编辑 → stale → 重建 → ok，确认 source 转 model、isInjectableSummary 放行、指示器归零。
 */
describe('真实 client 完整链路：编辑 → stale → 重建 → 放行', () => {
  it('stub 摘要经真实 client 重建后转 model 且指示器归零', async () => {
    const { openForTest } = await import('../src/schema/db');
    const { createSession, appendTurn, markViewsStale } = await import('../src/domain/turnStore');
    const { planPendingWindows } = await import('../src/domain/summaryService');
    const { Runtime } = await import('../src/domain/runtime');
    const { computeIndicator } = await import('../src/domain/indicator');
    const { listStubSummaries } = await import('../src/domain/summaryService');
    const { isInjectableSummary } = await import('../src/domain/summary');

    const db = await openForTest(`e2e-${Math.random()}`);
    const SUM: ServiceRef = { id: 'svc', model: 'gpt-4o' };
    const s = await createSession(db, {
      characterId: 'c', title: 't',
      modelBinding: { main: SUM, summarizer: SUM },
      greetingAssetId: 'a', greetingContent: 'hi',
    });
    for (let i = 0; i < 5; i++) {
      await appendTurn(db, s.id, { userContent: `u${i}`, assistantContent: `a${i}` });
    }

    // 1) 先用 stub 造出伪摘要
    const rtStub = new Runtime(db, {
      client: stubSummarizer(),
      resolveSummarizer: async () => SUM,
    });
    await rtStub.scheduleSummaries(s.id);
    await rtStub.pump();
    expect(await listStubSummaries(db, s.id)).toHaveLength(1);
    expect((await computeIndicator(db, s.id)).uncoveredTurns).toBeGreaterThan(0); // stub 不注入 → 空洞

    // 2) 编辑 → stale
    const rows = await db.summaries.where('sessionId').equals(s.id).toArray();
    const turns = (await db.turns.where('sessionId').equals(s.id).toArray())
      .filter((t) => t.seq > 0);
    await markViewsStale(db, s.id, [turns[0].id], 'amend');
    const staleRow = (await db.summaries.get(rows[0].id))!;
    expect(staleRow.status).toBe('stale');
    expect(staleRow.source).toBe('stub'); // stale 不改 source

    // 3) 接真实 client → recover 无状态扫描 → 重建
    const rt = new Runtime(db, {
      client: mk({
        fetchImpl: async () =>
          okJson({ choices: [{ message: { content: '地点：钟楼' } }], usage: { prompt_tokens: 88 } }),
      }),
      resolveSummarizer: async () => SUM,
    });
    await rt.recover(s.id);
    await rt.pump();

    // 4) 验收
    const after = await db.summaries.where('sessionId').equals(s.id).toArray();
    expect(after).toHaveLength(1); // 覆盖，不产生第二条
    expect(after[0].source).toBe('model');
    expect(after[0].status).toBe('ok');
    expect(isInjectableSummary(after[0])).toBe(true);
    expect(await listStubSummaries(db, s.id)).toHaveLength(0);
    expect((await computeIndicator(db, s.id)).uncoveredTurns).toBe(0);
    expect((await computeIndicator(db, s.id)).pendingSummaries).toBe(0);
  });
});
