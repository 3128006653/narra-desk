/**
 * FactView 命名空间注册表（§11.1 草案）。
 *
 * 作用：决定每个 key 的 `riskLevel`，进而决定
 *  - 模型提案进 `proposed` 还是自动 `auto`（low 才自动确认）
 *  - `confirmed`/`auto` 会不会过期（只有 low 按 `lastSeenTurn` 过期）
 *  - 面板里的排序与置顶
 *
 * ⚠️ **未注册的 key 默认 `high`**（保守方向）。
 *    代价是模型自造的 namespace 会变成一批永久置顶项 —— 所以 §5.7 要求
 *    面板支持「按命名空间批量降级」，那是这个默认值的必要出口。
 */
import type { RiskLevel } from '../schema/entities';

/** 最长前缀匹配：先试完整 key，再逐级去掉最后一段 */
const TABLE: Array<{ prefix: string; level: RiskLevel }> = [
  // high
  { prefix: 'user.identity', level: 'high' },
  { prefix: 'user.boundary', level: 'high' },
  { prefix: 'relationship', level: 'high' },
  { prefix: 'promise', level: 'high' },
  { prefix: 'character.death', level: 'high' },
  { prefix: 'event.permanent', level: 'high' },
  // medium
  { prefix: 'goal.longterm', level: 'medium' },
  { prefix: 'plot.major', level: 'medium' },
  { prefix: 'state.persistent', level: 'medium' },
  // low
  { prefix: 'location.current', level: 'low' },
  { prefix: 'appearance', level: 'low' },
  { prefix: 'emotion.temporary', level: 'low' },
  { prefix: 'inventory.held', level: 'low' },
  { prefix: 'time.of_day', level: 'low' },
  { prefix: 'scene.weather', level: 'low' },
];

/** 最长前缀匹配取 riskLevel；未命中返回 `high` */
export function riskLevelOf(key: string): RiskLevel {
  let best: { prefix: string; level: RiskLevel } | undefined;
  for (const row of TABLE) {
    if (key === row.prefix || key.startsWith(`${row.prefix}.`)) {
      // 前缀越长越具体
      if (!best || row.prefix.length > best.prefix.length) best = row;
    }
  }
  return best?.level ?? 'high';
}
