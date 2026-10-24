/**
 * 真实 API 工具调用（阶段三末尾）。
 *
 * 与 `toolCoordinator` 的分工：那边管**幂等与断点恢复**（确定性逻辑），
 * 这边管**与 provider 的报文往返**（不确定的部分）。循环拿到 tool_calls 后
 * 交给 `runToolSequence` 执行 —— 副作用去重仍然由协调器负责。
 *
 * ---------------------------------------------------------------- 五个接入坑
 *
 * 1. **`tool_calls[].id` 必须存下来** → `ToolTrace.providerCallId`。
 *    后续每条 `role: "tool"` 消息必须带 `tool_call_id` 引用它；不存的话重放时
 *    tool 消息拼不出来，模型看到的是一串没有归属的工具结果。
 *
 * 2. **流式下 `tool_calls` 是分片的**：`delta.tool_calls` 按 `index` 分片，
 *    `arguments` 是**逐字符**拼出的字符串。必须拼完整再 `JSON.parse` ——
 *    第一个 chunk 就 parse 必然失败。且要按 `index` 分组，不是按出现顺序追加
 *    （多工具并行时 chunk 会交错）。见 `assembleStreamToolCalls`。
 *
 * 3. **`finish_reason: "tool_calls"` 是继续信号，不是结束信号**：
 *    要把 tool 消息追加回 messages 再发一轮。多轮工具调用是**循环**，不是一次。
 *
 * 4. **工具结果必须是字符串**：`role: "tool"` 的 `content` 是字符串，
 *    对象要 `JSON.stringify`。见 `stringifyToolResult`。
 *
 * 5. **`sideEffect` 声明要说真话**：`ToolExecutor.sideEffectOf` 返回三态，
 *    真实工具接入时必须保证声明与实际行为一致。`dice` 声明 `fresh`
 *    但实现里用固定种子，就是声明说谎 —— 递增计数器的 fake 挡不住这个，
 *    只有真实工具能暴露。给每个真实工具写一行「声明 vs 实际行为」注释。
 */
import { runToolSequence, type ToolStep } from './toolCoordinator';
import type { ToolExecutor } from './toolExecutor';
import type { ToolTrace } from '../schema/entities';
import type { ChatMessage, ChatRequest } from './modelClient';
import type { ServiceRef } from '../schema/entities';

/** 工具声明（发给 provider 的 schema） */
export interface ToolSpec {
  name: string;
  description?: string;
  /** JSON Schema；provider 原样透传 */
  parameters?: unknown;
}

/** provider 返回的一次工具调用请求（未执行） */
export interface ProviderToolCall {
  /** `tool_calls[].id` —— 回传时放进 `tool_call_id` */
  id: string;
  name: string;
  /** 已解析的参数对象 */
  args: unknown;
}

export interface ToolsCompletion {
  content: string;
  toolCalls: ProviderToolCall[];
  /** provider 给的结束原因；`tool_calls` 表示「还有工具要跑」 */
  finishReason?: string;
}

/** 支持工具调用的 client（httpClient 实现，fake 实现用于测试） */
export interface ToolsCapableClient {
  completeWithTools(req: ChatRequest & { tools?: ToolSpec[] }): Promise<ToolsCompletion>;
}

// ---------------------------------------------------------------- 流式分片装配

interface RawToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

/**
 * 按 `index` 分组装配流式 tool_calls（坑 2）。
 *
 * ⚠️ 两个要点：
 *   - 按 `index` 归组，不是按出现顺序追加 —— 多工具并行时 chunk 交错，
 *     顺序追加会把 A 的 arguments 接到 B 上。
 *   - `arguments` 拼完整后才 `JSON.parse`；中途 parse 必然失败（JSON 未闭合）。
 *     parse 失败时不抛错，回退成「原样字符串」，让调用方看到原始文本。
 */
export function assembleStreamToolCalls(deltas: RawToolCallDelta[]): ProviderToolCall[] {
  const groups = new Map<number, { id?: string; name?: string; argsText: string }>();
  // 保持 index 升序输出，与 provider 的顺序一致
  for (const d of deltas) {
    const g = groups.get(d.index) ?? { id: undefined, name: undefined, argsText: '' };
    if (d.id) g.id = d.id;
    if (d.name) g.name = d.name;
    if (d.arguments) g.argsText += d.arguments;
    groups.set(d.index, g);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, g]) => {
      let args: unknown = g.argsText;
      if (g.argsText) {
        try {
          args = JSON.parse(g.argsText);
        } catch {
          // 未闭合的 JSON：保留原始文本，交给调用方诊断，不静默丢
        }
      }
      return { id: g.id ?? '', name: g.name ?? '', args };
    });
}

/** 工具结果转字符串（坑 4） */
export function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return '';
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

// ---------------------------------------------------------------- 多轮循环

export interface RunToolLoopInput {
  client: ToolsCapableClient;
  /** 要调用的模型服务（ChatRequest 必填） */
  service: ServiceRef;
  executor: ToolExecutor;
  sessionId: string;
  requestId?: string;
  reason?: 'initial' | 'retry' | 'regenerate';
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** 防跑飞：provider 若一直返回 tool_calls，循环必须有上限 */
  maxRounds?: number;
  /** 上一次的 traces（retry 断点恢复用） */
  previousTraces?: ToolTrace[];
  newId?: (prefix: string) => string;
}

export interface RunToolLoopResult {
  /** 最终给用户的完整回复（单轮原子） */
  content: string;
  /**
   * 本轮使用的 requestId（首轮确定后沿用）。
   * ⚠️ 必须回传并写入 `TurnRevision.requestId` —— 否则下次 retry 时
   *    一级幂等键无从派生，「不重复副作用」直接失效。
   */
  requestId: string;
  /** 累积的 tool 消息（按顺序），用于写入 TurnRevision 或重放 */
  toolMessages: ChatMessage[];
  traces: ToolTrace[];
  notes: string[];
  rounds: number;
  /** 是否因达到 maxRounds 而中止（真发生了说明 provider 或工具声明有问题） */
  abortedByLimit: boolean;
}

export const DEFAULT_MAX_ROUNDS = 8;

/**
 * 跑完整个「模型请求工具 → 执行 → 回传结果 → 再请求」循环（坑 3）。
 *
 * 每一轮的 `role: "tool"` 消息都带 `tool_call_id`，指向该轮 `tool_calls[].id`。
 * 工具执行走 `runToolSequence`，因此 retry 时已完成步骤会被跳过、不重复副作用。
 */
export async function runToolLoop(input: RunToolLoopInput): Promise<RunToolLoopResult> {
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const messages: ChatMessage[] = [...input.messages];
  const toolMessages: ChatMessage[] = [];
  const allTraces: ToolTrace[] = [];
  const notes: string[] = [];
  let requestId = input.requestId;
  let rounds = 0;
  let abortedByLimit = false;
  let content = '';

  for (;;) {
    if (rounds >= maxRounds) {
      abortedByLimit = true;
      notes.push(`工具调用轮数达到上限（${maxRounds}），已中止循环`);
      break;
    }
    rounds += 1;

    const completion = await input.client.completeWithTools({
      service: input.service,
      messages,
      tools: input.tools,
    });

    content = completion.content || content;

    if (completion.toolCalls.length === 0) break; // 没有更多工具 → 结束

    const steps: ToolStep[] = completion.toolCalls.map((c) => ({
      toolName: c.name,
      args: c.args,
    }));

    const run = await runToolSequence({
      sessionId: input.sessionId,
      requestId,
      reason: input.reason ?? 'initial',
      steps,
      executor: input.executor,
      previousTraces: [...allTraces, ...(input.previousTraces ?? [])],
      startIndex: allTraces.length,
      newId: input.newId,
    });
    // requestId 首轮确定后沿用（同一轮序列内幂等键才对得上）
    requestId = run.requestId;
    notes.push(...run.notes);

    // 把 provider 的 call id 贴回 traces（坑 1）。
    // run.traces 与 completion.toolCalls **同序**（runToolSequence 按 steps 顺序产出），
    // 故直接按下标对应；不要用 stepIndex 去算，那是全局下标。
    run.traces.forEach((t, i) => {
      const call = completion.toolCalls[i];
      if (call?.id) t.providerCallId = call.id;
    });
    allTraces.push(...run.traces);

    // 拼 tool 消息：每条带 tool_call_id（坑 1）+ 字符串结果（坑 4）
    completion.toolCalls.forEach((call, i) => {
      const trace = run.traces[i];
      if (!trace) return;
      const msg: ChatMessage = {
        role: 'tool',
        content: stringifyToolResult(trace.result),
        tool_call_id: call.id,
      };
      toolMessages.push(msg);
      messages.push(msg);
    });

    // 把本轮的 assistant「我要调用这些工具」也放回上下文，否则下一轮不知道
    // 这些 tool 消息对应哪次请求
    messages.push({
      role: 'assistant',
      content: completion.content || '',
    });
  }

  return { content, requestId: requestId ?? '', toolMessages, traces: allTraces, notes, rounds, abortedByLimit };
}


/**
 * 达到工具调用上限时的**用户可见提示**。
 *
 * 与阶段一的 `interrupted` 属于同一类信息：**用户需要知道回复是否完整**。
 * 不加这条的话，被截断的回复看起来和正常结束的一模一样，
 * 用户会以为模型说完了 —— 这是静默降级。
 */
export function replySuffix(r: RunToolLoopResult): string {
  if (!r.abortedByLimit) return '';
  return `\n\n（工具调用达到上限 ${r.rounds} 轮，回复可能不完整）`;
}
