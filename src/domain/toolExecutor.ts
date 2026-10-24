/**
 * 工具执行接口（阶段三）。
 *
 * ⚠️ **与 `ChatClient` 是两个东西，不要合并**：
 *   - `ChatClient` 是**模型调用**（发 messages 拿 completion）—— 有 token、有流式、有限流。
 *   - `ToolExecutor` 是**工具执行**（跑一个具名函数拿结果）—— 无 token、无流式。
 *
 * 分开的收益：协调器的全部逻辑（两级幂等键、断点恢复、sideEffect 分支）
 * 可以用 fake 工具**完全测通**，不依赖任何真实 API 对 `tools` / `tool_choice` 的支持。
 * 真实 API 工具调用（把 tool schema 塞进 completion 请求）放到阶段三末尾接入，
 * **协调器逻辑先于真实工具接入**，否则会被 API 的不确定性拖住验收。
 */
import type { ToolSideEffect } from '../schema/entities';

export interface ToolCall {
  toolName: string;
  args: unknown;
  sessionId: string;
}

export interface ToolExecutor {
  /** 执行一个工具。抛错即该步骤 failed。 */
  execute(call: ToolCall): Promise<unknown>;
  /**
   * 声明副作用类型。**缺省必须按 `fresh` 处理** ——
   * 声明错成 none 会导致「该重掷的没重掷」，声明错成 fresh 只是多跑一次，
   * 保守方向是 fresh。
   */
  sideEffectOf?(toolName: string): ToolSideEffect;
}

/** 读取副作用声明，缺省 `fresh` */
export function sideEffectOf(executor: ToolExecutor, toolName: string): ToolSideEffect {
  const declared = executor.sideEffectOf?.(toolName);
  return declared === 'none' || declared === 'idempotent' || declared === 'fresh'
    ? declared
    : 'fresh';
}

// ------------------------------------------------------------ fake 实现（测试用）

export interface FakeToolOptions {
  /** toolName → 副作用声明；未声明的按 fresh */
  sideEffects?: Record<string, ToolSideEffect>;
  /** toolName → 结果（可以是函数，每次调用递增以模拟「重掷得到新值」） */
  results?: Record<string, unknown | (() => unknown)>;
  /** toolName → 抛错（模拟执行失败） */
  throws?: Record<string, string>;
}

export type FakeToolExecutor = ToolExecutor & {
  /** 每个工具的实际执行次数 —— 用于断言「不重复执行」 */
  calls: Record<string, number>;
};

/**
 * fake 工具执行器。
 *
 * 默认结果是一个**递增计数器**：`dice` 第一次返回 1、第二次返回 2 ——
 * 这样「重掷得到新结果」和「复用了旧结果」在断言上可以区分开。
 * 若两个行为都返回同一个值，测试就无法分辨，分支表实现错了也测不出来。
 */
export function fakeToolExecutor(opts: FakeToolOptions = {}): FakeToolExecutor {
  const calls: Record<string, number> = {};
  const counters: Record<string, number> = {};

  return {
    calls,
    sideEffectOf(toolName) {
      return opts.sideEffects?.[toolName] ?? 'fresh';
    },
    async execute(call) {
      calls[call.toolName] = (calls[call.toolName] ?? 0) + 1;
      const thrown = opts.throws?.[call.toolName];
      if (thrown) throw new Error(thrown);

      const declared = opts.results?.[call.toolName];
      if (typeof declared === 'function') {
        return (declared as () => unknown)();
      }
      if (declared !== undefined) return declared;

      // 默认：递增计数，让「重掷」可被观测
      counters[call.toolName] = (counters[call.toolName] ?? 0) + 1;
      return `${call.toolName}#${counters[call.toolName]}`;
    },
  };
}
