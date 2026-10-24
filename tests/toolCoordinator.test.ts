/**
 * 工具调用协调器（阶段三 / §5.4）。
 *
 * 覆盖分支表全部 6 格（3 sideEffect × 2 reason），外加两条结构约束：
 *  - regenerate / initial 生成新 requestId，retry 沿用（规则 1）
 *  - 代码里没有 `sideEffect==='none' && reason==='regenerate'` 形状的特判（规则 2）
 */
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
  hashKey,
  requestIdForRun,
  resumeFrom,
  runToolSequence,
  type ToolRunReason,
} from '../src/domain/toolCoordinator';
import { fakeToolExecutor } from '../src/domain/toolExecutor';
import type { ToolTrace } from '../src/schema/entities';

const SESSION = 's1';
const REQ = 'req_orig';

/** 造一批已完成的上次 traces（模拟上次运行成功执行过） */
function doneTraces(requestId: string, session = SESSION): ToolTrace[] {
  const mk = (
    i: number,
    toolName: string,
    args: unknown,
    sideEffect: ToolTrace['sideEffect'],
    result: unknown,
  ): ToolTrace => ({
    id: `tool_${i}`,
    stepIndex: i,
    toolName,
    arguments: args,
    sideEffect,
    idempotencyKey: hashKey(requestId, i, toolName, args),
    sideEffectKey: hashKey(session, toolName, args),
    status: 'done',
    result,
  });
  return [
    mk(0, 'read', { q: 1 }, 'none', 'read-result'),
    mk(1, 'write_fact', { k: 'v' }, 'idempotent', 'fact-result'),
    mk(2, 'dice', { n: 1 }, 'fresh', 'dice-3'),
  ];
}

const STEPS = [
  { toolName: 'read', args: { q: 1 } },
  { toolName: 'write_fact', args: { k: 'v' } },
  { toolName: 'dice', args: { n: 1 } },
];

function executor() {
  return fakeToolExecutor({
    sideEffects: { read: 'none', write_fact: 'idempotent', dice: 'fresh' },
  });
}

// ---------------------------------------------------------------- requestId 规则

describe('规则 1：requestId 按 reason 决定（retry 沿用，其余新建）', () => {
  const makeId = (p: string) => `${p}_made`;

  it('retry 沿用原 requestId → 一级键必然命中', () => {
    expect(requestIdForRun({ sessionId: SESSION, reason: 'retry', requestId: REQ, steps: STEPS, executor: executor() }, makeId)).toBe(REQ);
  });

  it('regenerate 生成新 requestId；即使调用方误传旧 id 也不用（防「重掷退化成复用」）', () => {
    const id = requestIdForRun(
      { sessionId: SESSION, reason: 'regenerate', requestId: REQ, steps: STEPS, executor: executor() },
      makeId,
    );
    expect(id).not.toBe(REQ);
    expect(id).toBe('req_made');
  });

  it('initial 未给 requestId 时新建', () => {
    expect(
      requestIdForRun({ sessionId: SESSION, reason: 'initial', steps: STEPS, executor: executor() }, makeId),
    ).toBe('req_made');
  });
});

// ---------------------------------------------------------------- retry 三格

describe('retry（一级命中）：三格全部跳过，fresh 必须带提示', () => {
  it('none → 跳过复用，不执行', async () => {
    const ex = executor();
    const r = await runToolSequence({
      sessionId: SESSION, reason: 'retry', requestId: REQ,
      steps: STEPS, executor: ex, previousTraces: doneTraces(REQ),
    });
    expect(r.traces[0].status).toBe('skipped');
    expect(r.traces[0].result).toBe('read-result');
    expect(ex.calls['read']).toBeUndefined();
    expect(r.executed).toBe(0);
  });

  it('idempotent → 跳过复用，不执行', async () => {
    const ex = executor();
    const r = await runToolSequence({
      sessionId: SESSION, reason: 'retry', requestId: REQ,
      steps: STEPS, executor: ex, previousTraces: doneTraces(REQ),
    });
    expect(r.traces[1].status).toBe('skipped');
    expect(r.traces[1].result).toBe('fact-result');
    expect(ex.calls['write_fact']).toBeUndefined();
  });

  it('fresh → 跳过 + UI 提示，绝不静默（否则用户以为骰子重掷了）', async () => {
    const ex = executor();
    const r = await runToolSequence({
      sessionId: SESSION, reason: 'retry', requestId: REQ,
      steps: STEPS, executor: ex, previousTraces: doneTraces(REQ),
    });
    expect(r.traces[2].status).toBe('skipped');
    expect(r.traces[2].result).toBe('dice-3'); // 沿用旧值，不重掷
    expect(ex.calls['dice']).toBeUndefined();
    // 关键：必须有提示
    expect(r.notes.length).toBe(1);
    expect(r.notes[0]).toContain('有副作用');
    expect(r.traces[2].note).toContain('无法自动重试');
  });
});

// ---------------------------------------------------------------- regenerate 三格

describe('regenerate（一级未命中）', () => {
  it('none → 重新执行（只读结果可能依赖会话状态，复用旧值反而错）', async () => {
    const ex = executor();
    const r = await runToolSequence({
      sessionId: SESSION, reason: 'regenerate', requestId: 'req_new',
      steps: STEPS, executor: ex, previousTraces: doneTraces(REQ),
    });
    expect(r.traces[0].status).toBe('done');
    expect(r.traces[0].result).toBe('read#1');
    expect(ex.calls['read']).toBe(1);
  });

  it('idempotent → 查二级键命中则复用，不重复执行', async () => {
    const ex = executor();
    const r = await runToolSequence({
      sessionId: SESSION, reason: 'regenerate', requestId: 'req_new',
      steps: STEPS, executor: ex, previousTraces: doneTraces(REQ),
    });
    expect(r.traces[1].status).toBe('skipped');
    expect(r.traces[1].result).toBe('fact-result');
    expect(ex.calls['write_fact']).toBeUndefined(); // 不重复副作用
  });

  it('fresh → 重新执行，得到新结果（骰子真的重掷了）', async () => {
    const ex = executor();
    const r = await runToolSequence({
      sessionId: SESSION, reason: 'regenerate', requestId: 'req_new',
      steps: STEPS, executor: ex, previousTraces: doneTraces(REQ),
    });
    expect(r.traces[2].status).toBe('done');
    expect(r.traces[2].result).toBe('dice#1'); // ≠ 上次的 'dice-3'
    expect(ex.calls['dice']).toBe(1);
    expect(r.notes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- 结构约束

describe('规则 2：两层正交，没有 none×regenerate 特判', () => {
  it('源码里不存在 sideEffect==="none" 与 reason==="regenerate" 的合取判断', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/domain/toolCoordinator.ts', import.meta.url), 'utf8'),
    );
    // 允许注释里出现这两个词，但不允许出现在同一行代码判断里
    const codeLines = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'));
    const bad = codeLines.filter((l) => l.includes("'none'") && l.includes("'regenerate'"));
    expect(bad).toEqual([]);
  });

  it('idempotent 的二级键带 sessionId —— 跨会话不共享结果', () => {
    const a = hashKey('s1', 'write_fact', { k: 'v' });
    const b = hashKey('s2', 'write_fact', { k: 'v' });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------- 断点恢复

describe('断点恢复：失败即停，已完成步骤不重跑', () => {
  it('第 2 步失败 → traces 保留第 1 步结果，remaining 从第 2 步开始', async () => {
    const ex = fakeToolExecutor({
      sideEffects: { read: 'none', dice: 'fresh' },
      throws: { dice: '工具炸了' },
    });
    const r = await runToolSequence({
      sessionId: SESSION, reason: 'initial', requestId: 'req_a',
      steps: [STEPS[0], STEPS[2]], executor: ex,
    });
    expect(r.traces).toHaveLength(2);
    expect(r.traces[0].status).toBe('done');
    expect(r.traces[1].status).toBe('failed');
    expect(r.executed).toBe(1);

    const { remaining, done, startIndex } = resumeFrom(r.traces, [STEPS[0], STEPS[2]]);
    expect(done).toHaveLength(1);
    expect(remaining).toEqual([STEPS[2]]); // 从断点继续，不是从头
    expect(startIndex).toBe(1); // 必须回传，否则幂等键对不上
  });

  it('resumeFrom 后重试：已完成步骤被跳过，不重复副作用', async () => {
    const ex = fakeToolExecutor({
      sideEffects: { read: 'none', dice: 'fresh' },
      throws: { dice: '工具炸了' },
    });
    const first = await runToolSequence({
      sessionId: SESSION, reason: 'initial', requestId: 'req_a',
      steps: [STEPS[0], STEPS[2]], executor: ex,
    });
    const { remaining, startIndex } = resumeFrom(first.traces, [STEPS[0], STEPS[2]]);

    // 换成能成功的执行器，沿用同一 requestId（retry 语义）
    const ex2 = fakeToolExecutor({ sideEffects: { read: 'none', dice: 'fresh' } });
    const second = await runToolSequence({
      sessionId: SESSION, reason: 'retry', requestId: first.requestId,
      steps: remaining.length ? remaining : [STEPS[0], STEPS[2]],
      executor: ex2, previousTraces: first.traces,
      startIndex, // ← 关键：不传的话 dice 的键会从 0 重算，与上次对不上
      newId: (p) => `${p}_x`,
    });
    // read 已在第一轮执行过 → 本轮跳过
    expect(ex2.calls['read']).toBeUndefined();
    expect(second.executed).toBe(1);
  });
});

describe('默认 sideEffect 为 fresh（保守方向）', () => {
  it('未声明的工具按 fresh 处理：regenerate 会重跑', async () => {
    const ex = executor(); // 不声明 unknown_tool
    const r = await runToolSequence({
      sessionId: SESSION, reason: 'regenerate', requestId: 'req_n',
      steps: [{ toolName: 'unknown_tool', args: {} }], executor: ex,
    });
    expect(r.traces[0].sideEffect).toBe('fresh');
    expect(r.executed).toBe(1);
  });
});
