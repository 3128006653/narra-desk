# Narra Desk

## 当前状态（2026-10-23）

| 层 | 状态 | 位置 |
|---|---|---|
| 领域 / 存储 / UI 纯逻辑 | **完成**，320 条 vitest 全绿（`tsc` + `vite build` 通过） | `src/`、`tests/` |
| HTTP 安全策略 | **完成**，TS 纯逻辑 39 条 + Go 同名实现 | `src/deploy/proxyPolicy.ts`、`server/policy.go` |
| FS helper 路径 jail | **完成**，20 条契约向量在 TS 与 Go 两侧同名通过 | `src/deploy/fsJail.ts`、`server/jail.go` |
| Go 单文件二进制 | **完成**，41 条 `go test` 通过，三平台交叉编译验证 | `server/` |
| 端到端验收 | **9/11 项实测通过**（A1/A2-Chromium/A3/B1/B2/B3/C1/C2/C3）；**2 项未测**（A2-Safari、D1/D2 演示模式），原因与后果见 `ACCEPTANCE.md` §F | `deploy/ACCEPTANCE.md` |

四份可交付文档：

- `deploy/httpContract.md` —— HTTP 层契约（路由 / 顺序 / 配对 / 上限 / 加固头）
- `deploy/ACCEPTANCE.md` —— 端到端验收：操作 → 预期 → 失败判定；附 Plan B1 与「未验证项及其影响」
- `deploy/DECISION.md` —— 单文件二进制选型（Go）与依赖边界
- `RECOVERY.md` —— 恢复路径检查清单（新增恢复入口时必过）

> 本文件下半部分是阶段一/二的实现记录，保留作为历史；以本节状态与
> `deploy/ACCEPTANCE.md` 的执行记录为准。

## 许可证

MIT，见 [LICENSE](LICENSE)。

## 运行

### 正式部署（Go 单文件二进制）

```bash
cd server
go build -trimpath -ldflags "-s -w" -o narra-desk .   # Windows 产物为 narra-desk.exe
./narra-desk -webroot ../dist -upstream https://api.openai.com
```

- 启动会打印一次性配对 URL（`http://127.0.0.1:8787/?token=...`），打开即完成配对并跳转去掉 token
- 凭证放环境变量 `NARRA_API_KEY`；也可用 `NARRA_UPSTREAM` 替代 `-upstream`
- `-addr` 默认 `127.0.0.1:8787`（只绑回环）；`-fsroot` 留空即关闭 FS helper
- `/health` 可用于进程守护，但**同样要求配对**（契约 §2 的配对门没有例外路由）
- `/v1/*` 只转发 `chat/completions`、`embeddings`、`models`

### 前端开发

```bash
npm install          # 依赖已在 package.json 声明，锁定版本见 package-lock.json
npm run test         # 320 passed / 0 skipped
npm run build        # tsc -b && vite build → dist/
npm run perf         # I-10 性能探针（长会话分页实测，不进常规测试）
npm run dev          # vite dev，访问 http://localhost:5173
```

⚠️ **`file://` 双击 `dist/index.html` 是未验证的次选路径**，不是与推荐部署并列的选项：
完全内存态、关闭页面即丢，且浏览器行为从未实测（D1/D2）。日常请用上面的二进制 + `127.0.0.1`。

`npm run` 依赖 shell：若本机 `.npmrc` 设了 `script-shell=/bin/bash`（WSL 路径），Windows 上会
`spawn /bin/bash ENOENT`。临时绕过：`npm run test --script-shell=cmd.exe`。
 
 ## 已完成
 
 | 模块 | 文件 |
 |---|---|
 | Dexie 存储 + 复合唯一索引 + 迁移框架（含迁移前阻断式确认 + 导出） | `src/schema/db.ts` |
 | 实体类型（`injectionState` 已改名，与 Turn.status 区分） | `src/schema/entities.ts` |
 | Zod：写入路径校验 + 卡片导入双 schema（detect 出 warning / take 宽松取值） | `src/schema/zod.ts` |
 | TurnStore：seq 分配、amend / regenerate / truncate / retry / 改写重发、恢复二分、greeting 派生、版本历史 | `src/domain/turnStore.ts` |
 | 角色卡 V2/V3 规范化拆解 + CJK `match_whole_words` 自动修正 | `src/domain/cardImport.ts` |
 | 存储能力探测（不贴「隐私模式」标签）+ 单活动标签页锁 + reconcile | `src/domain/storageCapability.ts` `src/domain/webLock.ts` |
 | 摘要注入去重（不变量 #4 的纯函数） | `src/domain/summary.ts` |
 | FactView 注入谓词与有界选择（不变量 #5/#7 纯函数，阶段四只需补写路径） | `src/domain/factInjection.ts` |
 | FactView 写路径骨架（抛 `NotImplementedError`，让 #6 断言解除即红） | `src/domain/factStore.ts` |
 | 分页加载（§5.11：每页 50、初始 2 页、游标翻页） | `src/domain/turnStore.ts` |
 | JSON 导出含 `schemaVersion` + `checkBundle` 导入校验 | `src/domain/exportJson.ts` |
 | 最小 UI：会话视图 / 编辑菜单 / 版本历史 / 能力指示器 / 废弃分支恢复 / 加载更早 | `src/ui/main.ts` |

### 阶段二（纯函数层，本周）

| 模块 | 文件 |
|---|---|
| `assembleBudget()`：§5.9 裁剪序（向量→lorebook→**FactView**→摘要→mes_example→核心资产） | `src/domain/assemble.ts` |
| 空洞回退 `selectHoleFallbackTurns`（K = min(20, 剩余预算)）+ FactView → BudgetBlock（pin 豁免） | `src/domain/assemble.ts` |
| token 估算 `est = (cjk×1.0 + latin/4) × 1.2`；1.2 为唯一旋钮 | `src/domain/tokenEst.ts` |
| 摘要去重（I-6 按 Turn 数）/ 空洞计算（I-5）/ 窗口规划 / windowCoverage | `src/domain/summary.ts` |
| I-10 性能探针（长会话分页实测） | `scripts/perf-i10.ts` |

### 阶段二第二/三步（本周）

| 模块 | 文件 |
|---|---|
| 模型调用抽象（`ServiceRef` 不带密钥） | `src/domain/modelClient.ts` |
| 摘要生成服务：pending 先落记录 → ok/failed；退避阶梯 | `src/domain/summaryService.ts` |
| 后台任务中心：幂等入队 / 状态机 / 流式暂停 / retryNow·resetTask | `src/domain/taskCenter.ts` |
| 指示器：N 段摘要待补 / 仍有 M 轮未覆盖 / 回退预览 K | `src/domain/indicator.ts` |
| 运行时组装（唯一知道模块怎么拼的地方） | `src/domain/runtime.ts` |
| 抽取式占位摘要器（阶段二末替换） | `src/domain/stubSummarizer.ts` |
| 卫生维护：pending 超时恢复 / 同区间裁剪 / stub 扫描 | `src/domain/summaryService.ts` |
 
 ## 测试与不变量
 
 - `tests/invariants.test.ts` —— 七条不变量，**全部 pass，无 skip**（#6 依赖的写路径已在阶段四落地）。
 - `tests/turnStore.test.ts` —— greeting 单一真相源、会话级绑定、乐观锁冲突、改写重发、版本历史、分页、导出版本号。
 - `tests/cardImport.test.ts` —— CJK 自动修正、宽松取值不阻断、lorebook 语义字段保留。
 - `tests/migration.test.ts` —— 迁移前导出、幂等迁移（含 v3 stale 默认值）、能力探测分级。
 
 ## 编码期发现的问题
 
 见 `ISSUES.md`。三条值得注意：
 
 1. Dexie 原生 IDB 版本号 = `verno * 10`，不做换算会让迁移检测**静默失效**（I-1，已修）。
 2. **IndexedDB 不接受布尔作为 key** —— `[sessionId+stale]` 写入不报错，但查询直接抛
    `DataError`；索引改落 `staleReason`（I-7，已定案）。
 3. `&[sessionId+seq]` 唯一索引在二期引入 `branchId` 后会拒绝分叉写入（I-2，已记，注释就位）。
