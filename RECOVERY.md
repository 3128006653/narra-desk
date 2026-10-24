# 恢复路径检查清单

## 为什么有这份清单

I-17 与 I-27 是**同一个 bug 的两个实例**，不是偶发：

- **I-17**：`dedupeKey` 用 seq 区间生成，但 pending 超时恢复路径只有 `coversTurnIds`、拿不到 seq 区间 → 退化成 `0-0`，多个窗口互相碰撞只入队第一个，其余静默丢失。
- **I-27**：`idempotencyKey` 含 `stepIndex`，而 `resumeFrom` 返回的是**切片** → 剩余步骤下标从 0 重算，一级键与上次对不上，已完成步骤被误判为未执行（对 `fresh` 工具就是重掷）。

共同结构：

> **恢复路径的输入形态与正常路径不同，而某个不变量（key 的构成、下标的基准、标志的来源）只在正常路径下成立。**

这是「有恢复路径的系统」的结构性风险。任何新增恢复入口都应过一遍下面三条。

## 三条检查

1. **输入字段**：恢复路径拿到的输入，是否包含正常路径才保证存在的字段？
   *（I-17：恢复路径有 `coversTurnIds` 但没有 seq 区间，key 不能依赖 seq 区间）*

2. **重算基准**：恢复路径重新计算的下标 / 键，基准是否与正常路径一致？
   *（I-27：切片的下标从 0 开始，正常路径是全局下标，必须用 `startIndex` 对齐）*

3. **标志来源**：恢复路径的状态判断，是否依赖了「只在正常流程中被设置」的标志？
   *（I-19：`onMigrated` 是内存标志，崩溃即丢；改为每次启动无状态扫描 `listStubSummaries()`）*

## 已知的恢复入口

过清单时请同时更新这里，让下一个加恢复路径的人知道要读这份文件。

| 入口 | 位置 | 已过清单 |
|---|---|---|
| pending 摘要超时恢复 | `summaryService.recoverTimedOutPending` | ✅ |
| stub 摘要扫描重建 | `runtime.rebuildStubSummaries` | ✅ |
| 工具序列断点恢复 | `toolCoordinator.resumeFrom` | ✅ |
| 启动时的 stub 无状态扫描 | `runtime.recover` | ✅（I-19） |
| 写入冲突 reconcile | `turnStore` / `webLock` | ⚠️ 待补 | 第 1 条未验证：reconcile 路径可能拿不到 `expectedSeq`，需确认它拿什么做基准 |

## 使用方式

新增恢复入口时：在文件顶部加一行

```ts
// 恢复路径：见 RECOVERY.md 三条检查（输入字段 / 重算基准 / 标志来源）
```
