/**
 * 真实 API 工具调用接入（阶段三末尾）—— 五个坑逐个钉住。
 *
 * 每个坑都对应一条「运行时才会暴露」的失败：不写用例的话，
 * 它们在 fake 数据下全部表现正常，只有接真实 provider 才炸。
 */
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
  DEFAULT_MAX_ROUNDS,
  assembleStreamToolCalls,
  runToolLoop,
  stringifyToolResult,
  type ProviderToolCall,
  type ToolSpec,
  type ToolsCapableClient,
} from '../src/domain/toolLoop';
import { fakeToolExecutor } from '../src/domain/toolExecutor';
import type { ChatMessage } from '../src/domain/modelClient';
import type { ServiceRef } from '../src/schema/entities';

const SERVICE: ServiceRef = { id: 'svc', model: 'gpt-4o' };
const TOOLS: ToolSpec[] = [{ name: 'dice', description: '掷骰子', parameters: { type: 'object' } }];

/** 按脚本返回 completion 的 fake client，记录每一轮请求 */
function scriptClient(
  rounds: Array<{ content?: string; toolCalls?: Array<{ id: string; name: string; args: unknown }> }>,
) {
  const seen: ChatMessage[][] = [];
  let i = 0;
  const client: ToolsCapableClient & { seen: ChatMessage[][]; rounds: number } = {
    seen,
    rounds: 0,
    async completeWithTools(req) {
      seen.push([...req.messages]);
      client.rounds += 1;
      const r = rounds[Math.min(i, rounds.length - 1)];
      i += 1;
      return {
        content: r.content ?? '',
        toolCalls: (r.toolCalls ?? []) as ProviderToolCall[],
        finishReason: r.toolCalls?.length ? 'tool_calls' : 'stop',
      };
    },
  };
  return client;
}

// ---------------------------------------------------------------- 坑 2：流式分片

describe('坑 2：流式 tool_calls 按 index 归组，拼完整再 parse', () => {
  it('多工具 chunk 交错时不会把 A 的 arguments 接到 B 上', () => {
    const out = assembleStreamToolCalls([
      { index: 0, id: 'call_a', name: 'dice', arguments: '{"n"' },
      { index: 1, id: 'call_b', name: 'write_fact', arguments: '{"k"' },
      { index: 0, arguments: ':1}' },
      { index: 1, arguments: ':"v"}' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'call_a', name: 'dice', args: { n: 1 } });
    expect(out[1]).toMatchObject({ id: 'call_b', name: 'write_fact', args: { k: 'v' } });
  });

  it('arguments 未闭合时保留原始文本，不静默丢（JSON.parse 会抛）', () => {
    const out = assembleStreamToolCalls([{ index: 0, id: 'c1', name: 'dice', arguments: '{"n"' }]);
    expect(out[0].args).toBe('{"n"'); // 原样保留，供诊断
  });

  it('空分片不产出空调用', () => {
    expect(assembleStreamToolCalls([])).toEqual([]);
  });
});

// ---------------------------------------------------------------- 坑 4：结果字符串

describe('坑 4：工具结果必须是字符串', () => {
  it('对象被 stringify，undefined 转空串', () => {
    expect(stringifyToolResult({ a: 1 })).toBe('{"a":1}');
    expect(stringifyToolResult('x')).toBe('x');
    expect(stringifyToolResult(undefined)).toBe('');
    expect(stringifyToolResult(42)).toBe('42');
  });
});

// ---------------------------------------------------------------- 坑 1 + 3：循环

describe('坑 1：tool_call_id 必须回传，否则模型看到无归属的结果', () => {
  it('每条 tool 消息都带 tool_call_id，且指向该轮 tool_calls[].id', async () => {
    const client = scriptClient([
      { content: '我要掷骰', toolCalls: [{ id: 'call_1', name: 'dice', args: { n: 1 } }] },
      { content: '结果是 3' },
    ]);
    const r = await runToolLoop({
      client,
      executor: fakeToolExecutor({ sideEffects: { dice: 'fresh' }, results: { dice: 3 } }),
      sessionId: 's1',
      service: SERVICE,
      messages: [{ role: 'user', content: '掷个骰子' }],
      tools: TOOLS,
    });
    expect(r.toolMessages).toHaveLength(1);
    expect(r.toolMessages[0]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: '3' });
    // trace 上也要留着 provider 的 id，供重放
    expect(r.traces[0].providerCallId).toBe('call_1');
  });
});

describe('坑 3：finish_reason=tool_calls 是继续信号，不是结束信号', () => {
  it('工具结果被追加回 messages 再发一轮（多轮是循环）', async () => {
    const client = scriptClient([
      { content: '先掷一次', toolCalls: [{ id: 'c1', name: 'dice', args: {} }] },
      { content: '再掷一次', toolCalls: [{ id: 'c2', name: 'dice', args: {} }] },
      { content: '结束' },
    ]);
    const r = await runToolLoop({
      client,
      executor: fakeToolExecutor({ sideEffects: { dice: 'fresh' } }),
      sessionId: 's1',
      service: SERVICE,
      messages: [{ role: 'user', content: '开始' }],
      tools: TOOLS,
    });
    expect(r.rounds).toBe(3);
    expect(r.content).toBe('结束');
    // 第二轮请求里必须能看到第一轮的 tool 结果
    expect(client.seen[1].some((m) => m.role === 'tool')).toBe(true);
    expect(r.abortedByLimit).toBe(false);
  });

  it('provider 一直要工具时，轮数上限兜底（防跑飞）', async () => {
    const client = scriptClient([
      { content: '', toolCalls: [{ id: 'c', name: 'dice', args: {} }] },
    ]);
    const r = await runToolLoop({
      client,
      executor: fakeToolExecutor({ sideEffects: { dice: 'fresh' } }),
      sessionId: 's1',
      service: SERVICE,
      messages: [{ role: 'user', content: '开始' }],
      tools: TOOLS,
      maxRounds: 3,
    });
    expect(r.rounds).toBe(3);
    expect(r.abortedByLimit).toBe(true);
    expect(r.notes.some((n) => n.includes('轮数达到上限'))).toBe(true);
  });

  it('默认上限存在且是有限值', () => {
    expect(DEFAULT_MAX_ROUNDS).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_MAX_ROUNDS)).toBe(true);
  });
});

// ---------------------------------------------------------------- 与协调器对接

describe('循环与协调器对接：retry 不重复已完成步骤', () => {
  it('同一 requestId 重跑时 fresh 工具被跳过而非重掷', async () => {
    const exec = fakeToolExecutor({ sideEffects: { dice: 'fresh' } });
    const client = scriptClient([
      { content: '掷', toolCalls: [{ id: 'c1', name: 'dice', args: {} }] },
      { content: '好了' },
    ]);
    const first = await runToolLoop({
      client,
      executor: exec,
      sessionId: 's1',
      service: SERVICE,
      messages: [{ role: 'user', content: '掷' }],
      tools: TOOLS,
    });
    expect(exec.calls['dice']).toBe(1);
    expect(first.requestId).toBeTruthy(); // 循环必须回传 requestId 供写入 revision

    // 用同一批 traces 再跑一次（retry 语义，沿用同一 requestId）
    const client2 = scriptClient([
      { content: '掷', toolCalls: [{ id: 'c1', name: 'dice', args: {} }] },
      { content: '好了' },
    ]);
    const second = await runToolLoop({
      client: client2,
      executor: exec,
      sessionId: 's1',
      service: SERVICE,
      messages: [{ role: 'user', content: '掷' }],
      tools: TOOLS,
      requestId: first.requestId,
      reason: 'retry',
      previousTraces: first.traces,
    });
    // 关键：执行次数没有增加 —— 一级键命中，跳过
    expect(exec.calls['dice']).toBe(1);
    expect(second.traces[0].status).toBe('skipped');
    expect(second.notes.some((n) => n.includes('有副作用'))).toBe(true);
  });
});
