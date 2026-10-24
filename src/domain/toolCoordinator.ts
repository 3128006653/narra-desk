/**
 * 工具调用协调器（阶段三 / §5.4）。
 *
 * 解决 SillyTavern 的「单轮回复被碎片化」：工具调用在**单轮内部**完成，
 * `assistantContent` 始终是用户看到的完整回复，`toolTrace` 单独存储、不参与轮次计数。
 *
 * ---------------------------------------------------------------- 两级幂等键
 *
 *   idempotencyKey = hash(requestId, stepIndex, toolName, arguments)   一级
 *   sideEffectKey  = hash(sessionId, toolName, arguments)              二级
 *
 * 为什么两级：retry 要「复用已完成步骤」，必须命中上次日志；
 * regenerate 要「fresh 重跑、idempotent 复用」，必须让一级键不命中、
 * 再按副作用类型决定查不查二级键。一个键做不到这两件事。
 *
 * `sideEffectKey` 带 `sessionId`：跨会话同参调用不能共享结果 ——
 * 对误声明成 idempotent 的工具，那会造成跨会话污染。
 *
 * ---------------------------------------------------------------- 两条正交规则（不要写特判）
 *
 *  1. **先按 `reason` 决定 requestId**：retry 沿用原 requestId；regenerate / initial 生成新的。
 *  2. **再按 `sideEffect` 决定查不查二级键**。
 *
 * 因此 `regenerate` 下 `none` **重新执行**不是特判 —— 它的一级键天然不命中，
 * 而 `none` 本来就不查二级键，直接执行即可。代码里不应出现
 * `if (sideEffect === 'none' && reason === 'regenerate')` 这种形状。
 *
 * 分支表（3 × 2 = 6 格，全部有用例覆盖）：
 *
 *  | sideEffect  | retry（一级命中）            | regenerate（一级未命中）        |
 *  |-------------|------------------------------|---------------------------------|
 *  | none        | 跳过，复用已存结果           | 重新执行（只读结果可能依赖会话状态）|
 *  | idempotent  | 跳过，复用已存结果           | 查二级键：命中复用 / 未命中执行   |
 *  | fresh       | 跳过 + UI 提示（不能静默）   | 重新执行                        |
 */
import type { ToolSideEffect, ToolTrace } from '../schema/entities';
import { sideEffectOf, type ToolExecutor } from './toolExecutor';

/** 本次运行的来由 —— 决定 requestId 是否复用 */
export type ToolRunReason = 'initial' | 'retry' | 'regenerate';

export interface ToolStep {
  toolName: string;
  args: unknown;
}

export interface RunToolsInput {
  sessionId: string;
  /** retry 传入**原** requestId；regenerate / initial 由调用方给新的（或留空自动生成） */
  requestId?: string;
  reason: ToolRunReason;
  steps: ToolStep[];
  executor: ToolExecutor;
  /** 上一次运行的 toolTrace（用于一级键命中判断）；retry 必须传 */
  previousTraces?: ToolTrace[];
  /**
   * 本批 steps 在原序列中的起始下标（断点恢复用，默认 0）。
   *
   * ⚠️ `idempotencyKey` 含 `stepIndex`，而 `resumeFrom` 返回的 remaining 是**切片** ——
   *    若不传起始下标，剩余步骤的下标会从 0 重新计数，一级键与上次对不上，
   *    已完成步骤被误判为「未执行」而重复跑（对 fresh 工具就是重掷）。
   */
  startIndex?: number;
  newId?: (prefix: string) => string;
}

export interface RunToolsResult {
  requestId: string;
  traces: ToolTrace[];
  /** 需要告知用户的话（如「fresh 步骤已跳过」） */
  notes: string[];
  /** 本次实际新执行的工具次数 —— 用于断言「不重复执行」 */
  executed: number;
}

/** FNV-1a：确定性、无依赖。幂等键不需要抗碰撞强度，只要稳定。 */
export function hashKey(...parts: unknown[]): string {
  let h = 0x811c9dc5;
  const s = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p ?? null))).join('\u001f');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 生成 requestId：regenerate / initial 走这里 */
export function newRequestId(prefix = 'req'): string {
  const c = globalThis.crypto;
  const uuid = c && typeof c.randomUUID === 'function' ? c.randomUUID() : Math.random().toString(36).slice(2);
  return `${prefix}_${uuid}`;
}

/**
 * 决定是否复用旧 requestId（规则 1）。
 * retry 沿用 —— 一级键因此全部命中，已完成步骤天然被跳过。
 */
export function requestIdForRun(input: RunToolsInput, makeId: (p: string) => string): string {
  // retry 沿用传入的 requestId（一级键因此必然命中）；
  // regenerate / initial **一律新建** —— 即使调用方误传了旧 id 也不用它，
  // 否则一级键会命中，「fresh 重掷」退化成「复用旧值」，这是很隐蔽的错误。
  if (input.reason === 'retry' && input.requestId) return input.requestId;
  return makeId('req');
}

export async function runToolSequence(input: RunToolsInput): Promise<RunToolsResult> {
  const makeId = input.newId ?? newRequestId;
  const requestId = requestIdForRun(input, makeId);
  const previous = input.previousTraces ?? [];

  const startIndex = input.startIndex ?? 0;
  const byLevel1 = new Map<string, ToolTrace>();
  const byLevel2 = new Map<string, ToolTrace>();
  for (const t of previous) {
    if (t.status !== 'done') continue; // 只有成功结果可复用
    if (!byLevel1.has(t.idempotencyKey)) byLevel1.set(t.idempotencyKey, t);
    if (!byLevel2.has(t.sideEffectKey)) byLevel2.set(t.sideEffectKey, t);
  }

  const traces: ToolTrace[] = [];
  const notes: string[] = [];
  let executed = 0;

  for (let i = 0; i < input.steps.length; i++) {
    const step = input.steps[i];
    const sideEffect: ToolSideEffect = sideEffectOf(input.executor, step.toolName);
    const stepIndex = startIndex + i;
    const idempotencyKey = hashKey(requestId, stepIndex, step.toolName, step.args);
    const sideEffectKey = hashKey(input.sessionId, step.toolName, step.args);

    const base = {
      id: makeId('tool'),
      stepIndex,
      toolName: step.toolName,
      arguments: step.args,
      sideEffect,
      idempotencyKey,
      sideEffectKey,
    };

    // ---- 规则 2：按 sideEffect 决定查不查二级键 ----
    let reused: ToolTrace | undefined;

    if (sideEffect !== 'none') {
      // fresh / idempotent 在 retry 下查一级键（requestId 复用 → 必然命中）
      const hit1 = byLevel1.get(idempotencyKey);
      if (hit1 && input.reason === 'retry') reused = hit1;
    } else if (input.reason === 'retry') {
      // none 无副作用，retry 下也直接复用（一级键命中即可）
      reused = byLevel1.get(idempotencyKey);
    }

    if (reused) {
      traces.push({
        ...base,
        status: 'skipped',
        result: reused.result,
        note:
          sideEffect === 'fresh'
            ? '此步骤有副作用，无法自动重试，已跳过（结果沿用上次）'
            : '复用上次执行结果',
      });
      if (sideEffect === 'fresh') {
        notes.push(`步骤 ${i + 1}（${step.toolName}）有副作用，已跳过而非重掷`);
      }
      continue;
    }

    // ---- 需要真正执行 ----
    if (sideEffect === 'idempotent') {
      // regenerate / initial：一级未命中，查二级键
      const hit2 = byLevel2.get(sideEffectKey);
      if (hit2) {
        traces.push({
          ...base,
          status: 'skipped',
          result: hit2.result,
          note: '同参数已执行过（idempotent），复用结果',
        });
        continue;
      }
    }

    try {
      const result = await input.executor.execute({
        toolName: step.toolName,
        args: step.args,
        sessionId: input.sessionId,
      });
      traces.push({ ...base, status: 'done', result });
      executed += 1;
      // 本次结果立刻可见：多步序列里后一步若同参可复用（idempotent）
      byLevel2.set(sideEffectKey, traces[traces.length - 1]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      traces.push({ ...base, status: 'failed', note: message });
      // 断点恢复：失败即停，已完成步骤留在 traces 里供下次从断点继续
      notes.push(`步骤 ${i + 1}（${step.toolName}）执行失败：${message}`);
      break;
    }
  }

  return { requestId, traces, notes, executed };
}

/**
 * 断点恢复：把上次 traces 与本次合并，从**第一个未完成步骤**继续。
 *
 * 恢复路径：见 RECOVERY.md 三条检查（输入字段 / 重算基准 / 标志来源）。
 * 此处对应第 2 条 —— remaining 是切片，下标基准必须与正常路径一致（I-27），
 * 故返回 `startIndex` 且调用方必须回传。
 *
 * 与 `runToolSequence` 配合：调用方把上次 traces 作为 `previousTraces` 传入，
 * 已完成步骤自动被跳过，不会重复副作用。
 */
export function resumeFrom(
  previous: ToolTrace[],
  steps: ToolStep[],
): { remaining: ToolStep[]; done: ToolTrace[]; startIndex: number } {
  const doneStatus = new Set<ToolTrace['status']>(['done', 'skipped']);
  const done = previous.filter((t) => doneStatus.has(t.status));
  const startIndex = done.length;
  const remaining = steps.slice(startIndex);
  // startIndex 必须回传给 runToolSequence，否则幂等键对不上（见 RunToolsInput.startIndex）
  return { remaining, done, startIndex };
}
