import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUMMARY_WINDOW,
  computeHoles,
  dedupeSummariesForInjection,
  isActiveSummary,
  planSummaryWindows,
  windowCoverage,
} from '../src/domain/summary';
import type { SummaryView } from '../src/schema/entities';

function sv(over: Partial<SummaryView> & { id: string; coversTurnIds: string[] }): SummaryView {
  return {
    sessionId: 's1',
    content: '摘要',
    status: 'ok',
    retryCount: 0,
    sourceRevisionIds: [],
    createdAt: 0,
    source: 'model',
    ...over,
  };
}

describe('I-5：两条独立规则，不合并', () => {
  const seqOfTurn = new Map([['t1', 1], ['t2', 2], ['t3', 3], ['t4', 4]]);

  it('(a) discarded Turn 不计入 coveredSeqs / holes（区间计算）', () => {
    const s = sv({ id: 's1', coversTurnIds: ['t1', 't2', 't3', 't4'] });
    // t3、t4 被 discard → activeSeqs 只剩 1、2
    const r = dedupeSummariesForInjection([s], [1, 2], seqOfTurn);
    expect(r.coveredSeqs).toEqual([1, 2]);
    expect(r.holes).toEqual([]); // 被 discard 的区间不是空洞，不需要回退
  });

  it('(b) stale 摘要不注入、其区间转为空洞（注入谓词）', () => {
    const ok = sv({ id: 'ok', coversTurnIds: ['t1', 't2'] });
    const stale = sv({ id: 'stale', coversTurnIds: ['t3', 't4'], status: 'stale', staleReason: 'turn-edited' });
    expect(isActiveSummary(ok)).toBe(true);
    expect(isActiveSummary(stale)).toBe(false);

    const r = dedupeSummariesForInjection([ok, stale], [1, 2, 3, 4], seqOfTurn);
    expect(r.selected.map((s) => s.id)).toEqual(['ok']);
    expect(r.holes).toEqual([3, 4]); // stale 的区间按空洞处理
  });

  it('(b) 续：failed / pending 摘要同样转空洞', () => {
    const failed = sv({ id: 'f', coversTurnIds: ['t1', 't2'], status: 'failed' });
    const r = dedupeSummariesForInjection([failed], [1, 2], seqOfTurn);
    expect(r.selected).toEqual([]);
    expect(r.holes).toEqual([1, 2]);
  });

  it('superseded 摘要不参与注入（枚举互斥）', () => {
    expect(isActiveSummary(sv({ id: 'x', coversTurnIds: ['t1'], status: 'superseded' }))).toBe(false);
  });
});

describe('I-6：重叠段「覆盖更大」按覆盖 Turn 数，不按 span', () => {
  it('连续窗口下二者等价 —— 保留覆盖更多者', () => {
    const seqOfTurn = new Map([['t1', 1], ['t2', 2], ['t3', 3]]);
    const small = sv({ id: 'small', coversTurnIds: ['t1'], createdAt: 100 });
    const big = sv({ id: 'big', coversTurnIds: ['t1', 't2', 't3'], createdAt: 0 });
    const r = dedupeSummariesForInjection([small, big], [1, 2, 3], seqOfTurn);
    expect(r.selected.map((s) => s.id)).toEqual(['big']);
  });

  it('非连续场景：Turn 数相同则取生成时间新者', () => {
    const seqOfTurn = new Map([['t1', 1], ['t2', 2], ['t3', 3]]);
    const older = sv({ id: 'older', coversTurnIds: ['t1', 't2'], createdAt: 10 });
    const newer = sv({ id: 'newer', coversTurnIds: ['t1', 't2'], createdAt: 20 });
    const r = dedupeSummariesForInjection([older, newer], [1, 2, 3], seqOfTurn);
    expect(r.selected.map((s) => s.id)).toEqual(['newer']);
  });

  it('disjoint-span：Turn 多但 span 小 vs Turn 少但 span 大 —— 两种口径产出不同结果', () => {
    // 判别用例的两个必要条件：
    //   ① 两者必须**相交**，否则都入选、排序先后不影响结果
    //   ② Turn 数排序与 span 排序必须**相反**
    // A = {1,2,3,4,5}：5 Turn，span 4      ← Turn 数赢
    // B = {1,20}    ：2 Turn，span 19，与 A 在 seq 1 相交  ← span 赢
    const seqOfTurn = new Map([
      ['t1', 1], ['t2', 2], ['t3', 3], ['t4', 4], ['t5', 5], ['t20', 20],
    ]);
    const manyTurns = sv({ id: 'many', coversTurnIds: ['t1', 't2', 't3', 't4', 't5'], createdAt: 0 });
    const wideSpan = sv({ id: 'wide', coversTurnIds: ['t1', 't20'], createdAt: 0 });

    const r = dedupeSummariesForInjection([manyTurns, wideSpan], [1, 2, 3, 4, 5, 20], seqOfTurn);

    // 按覆盖 Turn 数（定案）：many 先占位 1–5，wide 与之相交于 1 → 整体让位
    expect(r.selected.map((s) => s.id)).toEqual(['many']);
    expect(r.coveredSeqs).toEqual([1, 2, 3, 4, 5]);
    expect(r.holes).toEqual([20]);

    // 反证：若按 span 判定，会选出 wide、覆盖 {1,20}、空洞 [2,3,4,5]。
    // 上面三行任一被改成那样都会失败 —— 这正是该用例的价值所在。
    expect(r.holes).not.toEqual([2, 3, 4, 5]);
  });

  it('非连续但不相交：两者都入选，排序先后不影响结果', () => {
    // 记录一个反直觉点：不相交时「覆盖更大」的比较**不起作用**。
    const seqOfTurn = new Map([['t1', 1], ['t2', 2], ['t3', 3], ['t5', 5], ['t9', 9]]);
    const sparse = sv({ id: 'sparse', coversTurnIds: ['t1', 't5', 't9'], createdAt: 0 });
    const dense = sv({ id: 'dense', coversTurnIds: ['t2', 't3'], createdAt: 0 });
    const r = dedupeSummariesForInjection([sparse, dense], [1, 2, 3, 5, 9], seqOfTurn);
    expect(r.selected.map((s) => s.id).sort()).toEqual(['dense', 'sparse']);
    expect(r.coveredSeqs).toEqual([1, 2, 3, 5, 9]);
  });

  it('有交集的让位：小摘要整体让给大摘要，不被部分保留', () => {
    const seqOfTurn = new Map([['t1', 1], ['t2', 2], ['t3', 3]]);
    const a = sv({ id: 'a', coversTurnIds: ['t1', 't2'], createdAt: 0 });
    const b = sv({ id: 'b', coversTurnIds: ['t2', 't3'], createdAt: 10 });
    const r = dedupeSummariesForInjection([a, b], [1, 2, 3], seqOfTurn);
    // a 先（生成时间新且数量相同 → b 先），选 b，a 与 b 有交集 t2 → 整体让位
    expect(r.selected.map((s) => s.id)).toEqual(['b']);
    expect(r.holes).toEqual([1]);
  });
});

describe('空洞计算', () => {
  it('computeHoles 只认 active 且未被覆盖的 seq', () => {
    expect(computeHoles([1, 2, 3, 4, 5], [2, 4])).toEqual([1, 3, 5]);
  });
});

describe('窗口规划（写入侧零裁剪）', () => {
  const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, seq: i + 1 }));

  it('按 windowSize 切连续窗口', () => {
    const w = planSummaryWindows(turns(120), DEFAULT_SUMMARY_WINDOW);
    expect(w).toHaveLength(3); // 50 + 50 + 20
    expect(w[0]).toEqual({ fromSeq: 1, toSeq: 50, turnIds: expect.any(Array) });
    expect(w[2].fromSeq).toBe(101);
  });

  it('不做任何重叠比对 —— 重叠允许存在，去重只在注入时', () => {
    const w1 = planSummaryWindows(turns(60), 50);
    const w2 = planSummaryWindows(turns(60), 30);
    expect(w1[0].turnIds.length).toBe(50);
    expect(w2).toHaveLength(2);
    // w1[0] 与 w2[0]/w2[1] 完全重叠，但规划阶段不裁 —— 这正是「写入侧零裁剪」
    expect(w1[0].turnIds.slice(0, 30)).toEqual(w2[0].turnIds);
  });

  it('windowCoverage 用于后台决定是否值得重新生成', () => {
    const win = { fromSeq: 1, toSeq: 2, turnIds: ['t1', 't2'] };
    expect(windowCoverage(win, [])).toBe('none');
    expect(windowCoverage(win, [sv({ id: 'a', coversTurnIds: ['t1'] })])).toBe('partial');
    expect(windowCoverage(win, [sv({ id: 'a', coversTurnIds: ['t1', 't2'] })])).toBe('full');
  });
});
