# Issue 清单

v0.6.1 停评审后开工，按「记 issue + 进处置表」处理，不开整轮评审。

## 一、I-3 定案（v0.6.2 落位）✅ 清零

**问题**：§5.6 要求「stale FactView 暂不注入」，但 FactView 只有 `injectionState`/`inactiveReason`，
VectorIndex 无任何状态字段 —— 规则悬空。

**定案**：`stale` 是**独立于 `injectionState` 的正交字段**，不复用 `inactiveReason`。

理由来自不变量 #2（discard 只作用于 Turn，stale 只作用于派生物）：
`injectionState=inactive` 是数据层生命周期（superseded/expired/archived/disputed/rejected），
`stale` 是派生层重建标记（源 Turn 被修订）。混一会把「被新值覆盖」和「源轮次改了待重建」
变成同一件事，直接违反已锁定不变量。

**落位**：

| 位置 | 变更 |
|---|---|
| `FactView` | 新增 `stale: boolean`、`staleReason?: 'turn-amended'\|'turn-regenerated'\|'turn-truncated'\|'manual'` |
| `VectorIndex` | 新增 `stale: boolean`、`staleReason?: 'revision-changed'\|'embedder-changed'\|'quantization-changed'\|'manual'` |
| 注入谓词 | `isInjectableFact(f) = f.injectionState === 'active' && f.stale !== true` |
| `markViewsStale()` | 从「只统计数量」改为**真实写入** `stale=true` + `staleReason`，返回被标记的 id |
| `clearViewStale()` | 新增，后台重建完成后清标记 |
| `listStaleFacts/Vector()` | 新增，后台任务扫描入口 |
| Dexie | 升 v3，迁移幂等补 `stale=false` |
| `EditKind` | `amend\|regenerate\|truncate\|manual` → 各派生物 staleReason 映射表 |

**状态**：已定案 · v0.6.2 落位 · 有测试覆盖（amend/truncate 的 staleReason 区分、stale 不改 injectionState）。

## 二、本轮编码期新发现

| # | Issue | 阶段 | 优先级 | 状态 |
|---|---|---|---|---|
| I-7 | **IndexedDB 不接受布尔作为 key**：`[sessionId+stale]` 写入不报错，但按 `['s1', true]` 查询直接抛 `DataError` | 一 | P1 | **已定案** — 索引改落 `staleReason`（字符串，合法 key）；不变式 `stale === true ⟺ staleReason !== undefined`，已写进代码注释 |
| I-8 | **pin 排序需要稳定顺序**：§5.7 要求按「用户 pin 顺序」排序，但 `updatedAt` 会被后续编辑改写 | 四 | P2 | **已落位** — 新增 `pinnedAt?: number` |
| I-9 | **迁移缺表保护**：手工构造的库（如测试种子）可能没有全部表，v3 迁移会 `NotFoundError` | 一 | P2 | **已处理** — `migrationV3` 用 `tx.storeNames.includes()` 守卫；测试种子同步改为真实 v1 全表结构 |
| I-10 | **分页是内存排序，非索引下推**：`listTurnsPage` 取回全量再 slice，复杂度 O(总轮数) 而非 O(页大小) | 二 | P2 | **已实测** — 见下节。结论：暂不加索引，定下触发阈值 |
| I-11 | **greeting（seq 0）是否进摘要窗口**：它占一个 seq，会让每个窗口边界整体偏移一轮；且摘要 `first_mes` 无意义 | 二 | P2 | **已定案** — 排除。抽出 `isSummarizable(seq)` 供窗口规划与空洞计算**两处共用**；只改一处会出现「永远有 1 轮未覆盖」的幽灵空洞 |
| I-12 | **`tasks` 表没有 `status` 单列索引**：`where('status').equals()` 直接抛 `SchemaError`（不是返回空） | 二 | P2 | **已处理** — `TaskCenter.next()` 改全量取再过滤。任务表是「数十条」量级，为它加 Dexie 版本不划算；若真需要索引则加 `status` 并升 v4 |
| I-13 | **`retryNow` 是否重置 attempts**：重置会让「达上限停 failed」被手动点击绕过 | 二 | P2 | **已定案** — `retryNow` 只清退避期、保留计数；新增 `resetTask`（终态复活）才清零。语义差异写进注释 |
| I-14 | **「先落 pending 再调模型」会留卡死记录**：进程崩溃时记录永久停在 `pending`，无人接管 | 二 | **P1** | **已落位** — `recoverTimedOutPending()`（阈值 5 分钟）转 failed 并重新入队；`Runtime.recover()` 在启动时调一次。保留 failed 而非删除，留下「这段尝试过且没成」的事实 |
| I-15 | **摘要表缺 inactive 裁剪规则**：v0.6.1 只规定了 FactView 的裁剪，摘要没有 | 二 | P2 | **已落位** — `pruneSummaryDuplicates()`：同 `coversTurnIds` 至多 1 条，**优先保留最新的 ok**（不是简单按时间砍，否则失败重试会丢掉已有覆盖）。与 FactView 规则对齐 |
| I-16 | **stub 摘要不打标会以 ok 状态永久注入**：伪摘要比没有摘要更糟 | 二 | **P0** | **已落位** — `SummaryView.source: 'stub'\|'model'`；`isInjectableSummary()` 排除 stub，区间转空洞；迁移 v4 对缺字段旧行**回填 `stub`**（保守方向）；`listStubSummaries()` 供真实 client 接入后扫描重建 |
| I-40 | 导入包缺大小与深度上限（唯一接受外部输入的入口） | 五-4 | P1 | **已落位** — `guardImport` / `guardImportSize` / `guardImportDepth`，上限 100MB / 深度 100（与 FS helper 单文件上限对齐）。`maxDepth` 为**迭代实现**（守卫自身不能被深结构打爆）；大小检查在 parse **之前**（O(1)），`byteLength` 可注入以便不构造大字符串测试 |
| I-41 | 反引号替换成单引号会丢失信息 | 五-4 | P2 | **已修正** — 改为**加长围栏**（max backtick run + 1，最少 3），CommonMark 规范机制。首尾为反引号时两侧补空格，避免与分隔符连成长串。原实现用 `'` 替换 `` ` ``，导致「原文含反引号」与「原文含单引号」不可区分 |
| I-42 | `stableSerialize` 数字键排序与 `JSON.stringify` 不一致 | 五-4 | P3 | **已修正** — 键序遵循 JS 规范：整数索引键按**数值升序**在前，字符串键字典序在后。原实现纯字典序会让 `{"10":..,"2":..}` 排反。当前实体 id 是 uuid 不触发，防的是未来加数字键字段 |
| I-43 | **Go 侧 NFC 归一化需要 `golang.org/x/text`**，与「零第三方依赖」的选型声明冲突 | 五-5 | P2 | **已定案** — Go 标准库无 Unicode 归一化；而契约向量要求「NFD 的 é 与 NFC 的 é 视为同一路径」。不归一化不产生逃逸，但 `fsJailVectors.json` 同名场景会红。采用 `golang.org/x/text/unicode/norm`（Go 团队维护、版本钉死 v0.16.0），仅此一处使用；`go test` 跑通后无运行时下载。**这是 DECISION.md「零第三方」的唯一例外，理由写在 DECISION.md** |
| I-44 | 本机全局 `.npmrc` 设 `script-shell=/bin/bash`，Windows 上 `npm run *` 直接 `spawn /bin/bash ENOENT` | 五-5 | P3 | **环境问题，不改仓库** — `bash.exe` 只在 WSL 里是 `/bin/bash`，npm 拿不到。绕过：`npm run test --script-shell=cmd.exe`（已写进 README）。**不在仓库加 `.npmrc` 覆盖**：写死 `cmd.exe` 会让 macOS/Linux 上的 `npm run` 一起坏掉，用环境修环境 |
| I-45 | 浏览器无法验证 Host 头校验（`Host` 是 forbidden header） | 五-5 | P3 | **已记录** — `fetch('/health',{headers:{Host:'app.localhost'}})` 被浏览器忽略，实测返回 200 而非 403，**看着像校验失效，其实请求根本没带该头**。C1 只能用 curl / `--resolve` 构造；判定依据已写入 `ACCEPTANCE.md` C1 行 |
| I-38 | 导出/导入的六个坑（循环引用、哈希链顺序、Markdown 转义、版本兼容两边界、file:// 探测 try-catch、演示模式导出告知） | 五-3 | P1 | **已落位** — `src/deploy/exportBundle.ts`（扁平化结构，第一版定死，同时解决循环引用与哈希链顺序）、`src/deploy/capabilities.ts`（每项单独 try-catch）、`src/ui/demoMode.ts`（导入前阻断式确认）。**单向断言先于往返断言**（23 条） |
| I-39 | `fsAccessFallback` 不是能力探测项 | 五-3 | P3 | **已修正** — 降级路径是 `<input type=file>`，恒可用。若做成探测项，getter 抛异常会让它变 false → 导出按钮被误关 |
| I-36 | HTTP 层安全策略（路由/Host/Origin/配对/上限/加固头） | 五-2 | P0 | **Go 壳已实现并实测** — TS 侧 `src/deploy/proxyPolicy.ts` 39 条；Go 侧 `server/policy.go` + `server/server.go` + `httptest` 集成。**9/11 项通过**（A1/A2-Chromium/A3/B1/B2/B3/C1/C2/C3）；剩余 A2-Safari、D1/D2 因环境缺失未测，影响见 `ACCEPTANCE.md` §F |
| I-37 | Go 壳未编写（上一轮环境无 Go/Rust/CI） | 五-3 | P1 | **已完成** — 本轮环境有 `go 1.26.4`。`server/` 落地：静态托管、`/v1/*` 代理（含 SSE 直通与 `Retry-After` 透传）、配对 token + HttpOnly cookie、四个加固头、Host/Origin 校验、FS helper 接线。`go test` 41 条通过（含 20 条 `fsJailVectors.json` 同名场景）；darwin/linux/windows 交叉编译通过，Windows 产物 6.9 MB |
| I-34 | FS helper 是阶段五唯一「新增能力突破原有安全边界」的模块 | 五-1 | **P0** | **已落位** — `src/deploy/fsJail.ts` 纯模块 + 26 条逃逸场景表驱动测试通过。安全逻辑**先作为纯模块测通再套 HTTP 壳**，不被 HTTP 层拖住验收 |
| I-35 | 沙箱无 Go/Rust 工具链，选型已定（Go）但二进制代码未编写 | 五-1 | P1 | **已关闭** — 见 I-37。`deploy/fsJailVectors.json` 的 20 条场景在 `server/jail_test.go` 同名实现并通过；另有 `TestEveryDeclaredVectorHasGoCase` 防止「JSON 加了向量、Go 忘补用例」 |
| I-32 | **NUL→US 分隔符变更**（`toolCoordinator` 哈希拼接曾写进裸 `\x00`）影响已生成的 `idempotencyKey` 兼容性 | 三 | P3 | **已记录** — 改分隔符后同一输入的 hash 会变，旧日志里的 key 对不上、retry 会误判「未执行」。**当前无持久化生产数据，风险为零**；若将来有持久化 toolTrace，需一次性 key 重算或加版本标记 |
| I-33 | `assembleBudget` 不返回「本轮注入了哪些 fact id」→ UI 的 disputed 入口无从下手 | 四-5 | P1 | **已修** — 结果增加 `injectedFactIds` / `droppedFactIds`；块 id 前缀 `fact:` 由 `finalizeResult` 剥掉，**UI 拿到的是领域 id 而非块 id**；`TurnRevision.injectedFactIds`（可选，不触发迁移）记录本轮注入，供聊天界面纠错入口使用 |
| I-29 | **I-17 与 I-27 是同一类 bug**，共同结构：「恢复路径的输入形态与正常路径不同，而某个不变量只在正常路径下成立」 | 三 | P2 | **已落位** — 抽出 `RECOVERY.md` 三条检查（输入字段 / 重算基准 / 标志来源），三个恢复入口顶部各指向它；清单里列出已知入口，新增恢复路径时同步更新 |
| I-30 | **`runToolLoop` 未回传 requestId** → 下次 retry 时一级幂等键无从派生，「不重复副作用」失效 | 三末 | P1 | **已修** — 结果增加 `requestId`，注释写明必须写入 `TurnRevision.requestId` |
| I-31 | **`ChatMessage.role` 不含 `'tool'`** → 工具结果无法回传 provider | 三末 | P1 | **已修** — 角色扩展为 4 值，新增可选 `tool_call_id` / `tool_calls`；序列化原样透传 |
| I-27 | **断点恢复的 stepIndex 未对齐**：`resumeFrom` 返回的是切片，而 `idempotencyKey` 含 stepIndex → 剩余步骤下标从 0 重算，一级键对不上，已完成步骤会被误判为未执行（对 fresh 工具就是重掷） | 三 | **P1** | **已修** — `resumeFrom` 返回 `startIndex`，`runToolSequence` 接受 `startIndex` 并用 `startIndex + i` 生成键；用例断言 startIndex === 1 并回传 |
| I-26 | **`requestIdForRun` 在 regenerate 下会复用调用方误传的旧 id** → 一级键命中 → 「fresh 重掷」退化成「复用旧值」 | 三 | P1 | **已修** — 只有 retry 才用传入 id；regenerate/initial **一律新建**，即使调用方误传也不用（防止很隐蔽的重掷退化） |
| I-24 | **持久化加密凭证存储未做**：浏览器直连模式下密钥目前只存内存 | 二末 | P2 | **已知缺口，推迟** — 推荐部署（单文件二进制）由代理侧持有密钥，浏览器不接触；直连模式在运行期注入内存，不落主库、不进导出包。Web Crypto + 独立库方案需要用户口令，无口令即等同混淆，故不假装做了加密 |
| I-24 | **token 校准未闭环**：只累计样本不落库，下次启动回到 1.2，校准等于没做 | 二末 | P1 | **已落位** — v5 新增 `calibration` 表（**样本与系数合一**：样本只是算中位数的原料，单独建表没有消费端）；达 20 条样本后回写 `factor = 当前 × 中位数`；`estimateTokens(text, family)` 查内存缓存，缓存由 `loadFactors(db)` 启动时灌入；缓存空则用默认 1.2。校准是渐进的，不再需要改代码 |
| I-28 | **`MIGRATIONS[CURRENT_VERSION]` 在有「只加表」的版本上会 undefined** | 二末 | P2 | **已修** — v5 只加表、无 upgrade，导致该键 undefined、测试崩。导出 `LATEST_DATA_MIGRATION_VERSION` 区分「存储结构版本」与「数据 upgrade 版本」，测试改用它 |
| I-22 | **错误分类未落地 + 429 不尊重 `Retry-After`**：不可重试错误照常消耗退避配额，会让可恢复窗口提前撞 `MAX_ATTEMPTS`；本地退避短于服务端要求会连续撞限流 | 二 | P1 | **已落位** — `ChatError.retryable` 原样抛出；任务中心 `retryable===false` 直接终态（attempts=1，不进退避）；`nextRunAt = max(本地退避, retryAfterMs)`；`parseRetryAfter` 支持秒数与 HTTP 日期 |
| I-21 | **重建写入策略未定**：覆盖 vs 新建 | 二 | P1 | **定案：覆盖** — `findWindowRecord` 复用同 id/coversTurnIds；**失败前保持 `source: 'stub'`**，成功后才改 `model`。否则一次带着 model client 的失败重试会把伪摘要伪装成真摘要放行注入 |
| I-20 | **孤儿 stub**：挂在已删除会话上的 stub 会被入队成必然失败的任务 | 二 | P2 | **已落位** — `rebuildStubSummaries` 入队前按 sessionId 过滤，会话不存在则物理删除（无归属，重建无意义） |
| I-19 | **`onMigrated` 只置内存标志，崩溃窗口内标志丢失** → stub 永不重建 | 二 | **P0** | **已落位** — `Runtime.recover()` 加**无状态** stub 非空检查，每次启动扫描、幂等、不依赖标志；`onMigrated` 降级为「迁移后立即触发一次」的优化 |
| I-23 | **`listRevisions` 排序不稳定**：两个 revision 落在同一毫秒 → 顺序在 v1/v2 间跳变，用例随机红 | 一 | P2 | **已修** — `now()` 改为**单调时钟**（相同则 +1ms）。这是潜伏偶发，与本次改动无关，但会导致 CI 随机失败 |
| I-18 | **`pruneSummaryDuplicates` 在 `ok` + `stale` 并存时的优先级**：若保留 `ok`，过时摘要会继续被注入 | 二 | P3 | **已落位（防御性）** — 保留优先级 `stale > ok > pending/retrying > failed`，**`stale` 优先于 `ok`**（`ok` 是基于旧输入的过时内容）。前提：`markViewsStale` 目前把同区间所有记录一起标 `stale`，正常路径不并存；若将来放宽标记范围，此处优先级即为必需。已用变异验证（把 `stale` 降到 `ok` 之下 → 该用例变红） |
| I-17 | **`enqueueSummaryWindows` 的 dedupeKey 用 `fromSeq-toSeq` 会碰撞**：恢复的窗口拿不到 seq 区间 → 退化成 `0-0`，多个超时窗口只入队第一个 | 二 | P1 | **已修** — 改用 `windowDedupeKey(turnIds)`。此 bug 由「4 个超时窗口应全部重新入队」这条测试捕获 |

### I-10 实测数据（`npm run perf`）

探针在 `scripts/perf-i10.ts`，不进常规测试（建库耗时数秒）。

| 会话规模 | 分页加载（20 次均值） | 摘要去重（101 条） |
|---|---|---|
| 2000 轮 | 21.5 ms | 3.4 ms |
| 5000 轮 | 59.5 ms | 8.3 ms |

**读数说明**：fake-indexeddb 是内存实现，测的是 JS 侧开销（取回全量 + 排序 + slice），
真实 IndexedDB 还要叠加反序列化 —— 所以这是**乐观下界**。

**结论**：

- 5000 轮下 59.5ms，**未过 100ms 阈值** → 按「先实测，不预先优化」，暂不加索引。
- 但耗时随总轮数**近似线性**（2000→5000 是 2.5×规模、2.8×耗时），因为它取的是全量。
  真实 IDB 大约 2× 开销 → **约 1 万轮时越过 100ms**。
- **触发条件已量化**：主条件是**真实环境下单次组装 > 100ms**（实测阈值）。
  辅助提示「会话规模 > 8000 轮」为**估算值**，不是硬门槛 —— fake-indexeddb 测的是 JS 侧
  开销，真实 IDB 的反序列化成本取决于对象复杂度与批量读取策略，未必线性外推。
  两者冲突时**以 100ms 实测为准**。届时加 `[sessionId+status+seq]` 复合索引走游标下推
  （`listTurnsPage` 已留 TODO 注释）。
- 摘要去重 8.3ms 不是瓶颈，n<100 的 O(n) 区间合并验证成立。

## 三、此前已处理

| # | Issue | 阶段 | 状态 |
|---|---|---|---|
| I-1 | Dexie 把原生 IDB 版本号写成 `verno * 10`，迁移检测被静默绕过 | 一 | **已修** — `peekVersion()` 做 `Math.floor(version / 10)` |
| I-2 | `&[sessionId+seq]` 唯一索引与二期 `branchId` 冲突 | 二期 | **已记** — 注释已在 Turn 索引处就位：引入 branchId 时必须改为 `&[sessionId+branchId+seq]` |
| I-4 | Zod v4 严格性：类型不符会被误做成阻断导入 | 一 | **已处理** — detect（只出 warning）+ take（宽松取值）双 schema |
| I-5 | 「discard 不计入已覆盖」与「truncate 使摘要 stale」是两条独立规则 | 二 | **已拆断言** — 阶段二写合并函数时别合并 |
| I-6 | `coversTurnIds` 非连续时「覆盖更大」按 Turn 数还是 span | 二 | 当前按 Turn 数；连续窗口下等价，阶段二写合并函数时顺手定死并写进注释 |

## 四、v0.6.1 承接清单（设计已落位，实现待对应阶段）

| # | Issue | 阶段 |
|---|---|---|
| 1 | FS helper 安全约束（默认关闭 / 根目录 jail / canonicalize 前缀匹配 / 逃逸 404 / 白名单扩展名 / 体积频次上限） | 五 |
| 2 | 两级 `idempotencyKey`（一级含 requestId；二级含 sessionId） | 三 |
| 3 | FactView 预算裁剪序（`proposed` → 未 pin 的 `confirmed/auto` → pin 豁免） | 二/四 |
| 4 | 配对态持久化（独立 32 字节 session secret cookie） | 五 |
| 5 | expired 复活（变更检测比对基准只取 `injectionState=active`） | 四 |

## 四之二、阶段二进展（本周）

| 交付 | 文件 | 状态 |
|---|---|---|
| `assembleBudget()` 纯函数 + §5.9 裁剪序 | `src/domain/assemble.ts` | ✅ 16 测 |
| token 估算 `est = (cjk×1.0 + latin/4) × 1.2` | `src/domain/tokenEst.ts` | ✅ |
| 空洞回退 `selectHoleFallbackTurns`（K = min(20, 剩余预算)） | `src/domain/assemble.ts` | ✅ |
| SummaryView 去重 / 空洞 / 窗口规划 | `src/domain/summary.ts` | ✅ 12 测 |
| I-5 / I-6 定死 | 注释 + 单测 | ✅ |

**编码期修掉的真 bug**：`partial` 块（mes_example / description 尾段）原本被**整块丢弃**，
而 §5.9 对它们是「截断」不是「丢弃」。整块丢弃循环已排除 `partial`，改走截断分支。

**I-6 定死口径**：重叠段「覆盖更大」按**覆盖 Turn 数**，不按 span。

- ⚠️ **首版用例无效，已复核替换**。原用例 `{1,5,9}`(3Turn/span8) vs `{2,3}`(2Turn/span1)
  两种口径都选前者，且两者**不相交**（不相交则都入选，排序不影响结果）—— 双重无效。
- 现用 `disjoint-span` 组：`A={1..5}`(5Turn/span4) vs `B={1,20}`(2Turn/span19)，
  两者在 seq 1 相交、且两种口径排序相反 → 产出不同 `holes`（Turn 数 → `[20]`；span → `[2,3,4,5]`）。
- **已做变异验证**：把实现改成 span 比较后，仅该用例变红、其余 12 条仍绿 → 用例确有牙齿。
  （同时反证：改名保留的「非连续但不相交」用例在 span 口径下仍 ✓，即原用例确实无效。）

## 四之三、阶段二第二/三步进展

| 交付 | 文件 | 状态 |
|---|---|---|
| 模型调用抽象（ServiceRef 不带密钥，便于 fake 与传输互换） | `src/domain/modelClient.ts` | ✅ |
| 摘要生成服务：pending 先落记录 → 调模型 → ok/failed；退避阶梯 | `src/domain/summaryService.ts` | ✅ |
| 后台任务中心：幂等入队、状态机、流式暂停、retryNow/resetTask | `src/domain/taskCenter.ts` | ✅ |
| 指示器：待补段数 / 未覆盖轮数 / 回退预览 K | `src/domain/indicator.ts` | ✅ |
| 运行时组装（唯一知道各模块怎么拼的地方） | `src/domain/runtime.ts` | ✅ |
| 抽取式占位摘要器（阶段二末替换真实 client） | `src/domain/stubSummarizer.ts` | ✅ 临时 |
| UI：指示器 + 立即生成 + 驱动队列 + 空闲轮询 | `src/ui/main.ts` | ✅ |

**三条实测/判断**：

1. **失败也必须落 `coversTurnIds`** —— 否则空洞计算不知道「这段有窗口但没成」，
   指示器也报不出「N 段摘要待补」。与「写入侧零裁剪」是同一原则的两面：元数据永不说谎。
2. **I-11 的两处一致性**：窗口规划排除 greeting 后，空洞计算若不同步排除，
   会永远报「仍有 1 轮未覆盖」。已抽成 `isSummarizable()` 强制共用。
3. **I-13 的语义选择**：手动重试表达「现在就再试一次」，不是「从头再来」。
   计数不重置才能让 `maxAttempts` 生效；真要重来走 `resetTask`。

**待阶段二末**：真实 ChatClient 接入后删掉 `stubSummarizer.ts`；
流式开始/结束处包住 `setStreaming(true/false)`（UI 已留 TODO 注释）。

### 接真实模型前的三处补全（本轮）

| 项 | 处置 |
|---|---|
| P0 stub 打标（I-16） | `SummaryView.source` + `isInjectableSummary` + 迁移 v4 回填 stub + `listStubSummaries` |
| P1 pending 超时恢复（I-14） | `recoverTimedOutPending`（5 分钟阈值）+ `Runtime.recover`（启动时一次） |
| P2 摘要裁剪对齐 FactView（I-15） | `pruneSummaryDuplicates`（同区间至多 1 条；**`stale > ok > pending > failed**，是对原建议「只留最新」的实质修正 —— 只留最新会在最新一条是失败重试时丢掉已有的有效覆盖） |
| 迁移收尾（本轮新增） | `InitOptions.onMigrated` + `Runtime.rebuildStubSummaries()`：v4 回填的 stub 立刻不可注入，迁移后**自动入队重建**，不让用户先经历一轮「升级后模型记得更少」。全新库不触发 |

**两条边界已写进注释**：

1. `isSummarizable` 加了**第三处防护** —— 任何按 seq 遍历生成窗口/计算覆盖的新功能
   （未来的向量窗口化、导出区间统计）都必须调用它，不许自己写 `seq > 0`。
2. `runtime.ts` 职责边界：只做依赖注入与生命周期编排，**不做业务逻辑**。
   判定标准是「本文件不应出现 `if (某业务条件)`」；规则/阈值/状态转换留在各自 domain 模块。

**四条约定已写进注释**（防后续重构失守）：

1. `ChatClient.source`：任何占位/测试 client **必须显式声明 `source: 'stub'`** —— 这是防止
   伪摘要以 `ok` 状态永久注入的唯一机制，没有编译期手段能强制，只能靠约定。
2. `windowDedupeKey`：输入是 `turnIds` **不是** seq 区间，因为恢复路径不保证有 seq（I-17）。
   明确写「不要为了更快改回 seq 版本」。本质是**输入契约要覆盖所有调用方**。
3. `pruneSummaryDuplicates`：保留优先级与 `markViewsStale` 标记范围的前提关系（I-18）。
4. 错误分类表（真实 client 接入时落地）：可重试 = 超时/限流/5xx/网络；
   不可重试 = 内容过滤/参数错误/401/403/404/400 —— 后者重试只会消耗退避配额，
   让真正可恢复的窗口提前撞上 `MAX_ATTEMPTS`。

**真实 API 工具调用接入（阶段三第 5 项，本轮完成）**：

五个坑逐个钉住，每个都有对应用例（它们在 fake 数据下全部表现正常，只有接真实 provider 才炸）：

| 坑 | 落点 |
|---|---|
| 1. `tool_calls[].id` 必须存 | `ToolTrace.providerCallId`（可选字段，不触发迁移）；每条 `role:'tool'` 消息带 `tool_call_id`；`ChatMessage.role` 扩展 `'tool'`（I-31） |
| 2. 流式 tool_calls 分片 | `assembleStreamToolCalls` 按 **index** 归组（chunk 交错时不会把 A 的 arguments 接到 B 上），拼完整再 `JSON.parse`；未闭合则保留原始文本不静默丢 |
| 3. `finish_reason:'tool_calls'` 是继续信号 | `runToolLoop` 多轮循环，tool 消息追加回 messages 再发一轮；`DEFAULT_MAX_ROUNDS=8` 防跑飞，超限记 `abortedByLimit` |
| 4. 工具结果必须字符串 | `stringifyToolResult`；对象 stringify、undefined 转空串 |
| 5. `sideEffect` 声明说真话 | `factNamespace` 之外的约定写进 `toolLoop` 文件头；真实工具接入时需逐工具写「声明 vs 实际行为」注释 |

**阶段四第 1–4 步（本轮完成）**：

| 步 | 落点 |
|---|---|
| 1 写路径事务（#6） | `factStore.writeFact` 事务内先查 active → 降级 → 写新行；**#6 已解除 skip，182 passed / 0 skipped** |
| 2 注入谓词 + 排序 | 阶段一已落 `isInjectableFact` / `selectFactsForInjection`（`active && !stale`；pin → confirmedAuto → proposed，层内 riskLevel desc + lastSeenTurn desc） |
| 3 有界注入（#7） | 与阶段二 `assembleBudget` 的 FactView 裁剪步对接；用例断言 5+30+10、总上限 45、pin 额外配额、overflow 可见 |
| 4 过期/归档/复活 | `sweepFactLifecycle`：proposed 100 轮 archived、low 50 轮 expired、medium/high 永不过期；**expired 复活有专项用例**（变更检测基准只取 active） |
| — 字段核对 | 八个字段全在：`confidence` / `injectionState` / `inactiveReason` / `origin` / `pinned` / `pinnedAt` / `stale` / `staleReason`，**无需迁移** |

**两个前置确认（本轮已完成）**：

| 确认项 | 结论 |
|---|---|
| `ChatMessage` 是否落库？老数据 schema 是否兼容 `role: 'tool'`？ | **不落库** —— `TurnRevision` 存的是 `userContent` / `assistantContent` / `toolTrace`，没有 `ChatMessage[]`；Zod schema 里也没有 `role` 枚举。**I-31 零迁移风险** |
| `assembleBudget` 返回值是否含注入清单？ | 原先**不含** → 已补 `injectedFactIds` / `droppedFactIds`（I-33）。这是接 UI 前唯一可能卡住的地方 |

**阶段四第 5 步（UI 层，本轮完成）**：

| 设计点 | 落点 |
|---|---|
| 1 批量操作默认不选 | 面板复选框**默认 false**，「全选当前页」是用户主动动作；空集时批量按钮 disabled。无脑全选会变成第二种确认疲劳 |
| 2 disputed 入口在聊天界面 | `disputedEntry()` 挂在每条消息的头部，依赖 `TurnRevision.injectedFactIds`；不在侧栏 |
| 3 pin 满员拒绝 | `pinFact` 返回 `{ ok:false, reason:'limit-reached' }`，**不自动替换最早 pin** —— 与 `retryNow` 不重置 attempts 同原则：显式动作要有明确成败反馈 |
| 4 expired / archived 分区 | `loadFactPanel` 分成 `archived`（待处理·已归档）/ `expired`（已过期）/ `disputed`（置顶）/ `superseded`，两两不相交有用例 |
| — abortedByLimit UX | `replySuffix()` 追加「（工具调用达到上限 N 轮，回复可能不完整）」——被截断的回复不能看起来和正常结束一样 |

**里程碑**：v0.6.8 起**七条不变量首次全部 passing**（#6 解除 skip）。

**阶段三开工前的三个边界（上一轮定死）**：

| 边界 | 定案 |
|---|---|
| regenerate 的 requestId | **一律新建**，`none` **不特判**。两层正交：规则 1 按 reason 决定 requestId，规则 2 按 sideEffect 决定查不查二级键。另有源码级用例断言「代码里不存在 `none` × `regenerate` 的合取判断」 |
| `ToolExecutor` vs `ChatClient` | **分开**。协调器依赖 `ToolExecutor`（`execute` + `sideEffectOf`），fake 实现先于真实工具 —— 协调器逻辑用 fake 工具全部测通，不被真实 API 的 `tools` / `tool_choice` 支持度拖住验收 |
| `ToolTrace` 字段 | 已齐全（`idempotencyKey` / `sideEffectKey` / `sideEffect` / `status` / `result`），**无需迁移**。新增可选 `note`（fresh 在 retry 下被跳过时的提示）—— 可选字段不触发迁移 |

**阶段二关账（上一轮）**：

| 项 | 结论 |
|---|---|
| 真实 ChatClient | 新增 `src/domain/httpClient.ts`：`source: 'model'`；**HTTP 状态码 → retryable 用显式表**（408 可重试、409/422 不可 —— 区间规则会判错）；客户端超时 ≠ Retry-After；流式中断把 partial 挂在 error 上供写 `interrupted` |
| UI 接线 | 推荐部署下 `baseUrl = location.origin`（前端与代理同源，无 CORS）；`resolveApiKey` 注入，内存持有 |
| `source` 单一写入点 | 约定写进 `SummaryView.source` **字段注释**；失败/重试/stale 分支一律不动 source。用例已变异验证（改回写 source → 2 条用例变红） |
| token 校准 | 按 **model family** 分组自动记录（`usage/est` 中位数 → 建议系数）；摘要成功路径自动埋点 |
| stub 摘要器 | 从 `src/domain/` **移到 `tests/helpers/`**（它是造伪摘要的唯一手段，测试需要它；留在 src 会让人误以为是可选生产路径）。UI 已切换真实 client |
| 完整链路 | 新增端到端用例：stub 造伪 → 编辑 stale → 真实 client 重建 → source 转 model → 放行 → 指示器归零 |

**接真实模型前的边界确认（上一轮）**：

| 项 | 结论 |
|---|---|
| `onMigrated` 内存标志（I-19） | 崩溃窗口存在 → 改为 `Runtime.recover()` **无状态扫描**，每次启动查 `listStubSummaries()` 非空即入队。标志降级为优化 |
| 孤儿 stub（I-20） | 入队前过滤已删除会话，物理删除无归属记录 |
| 重建写入策略（I-21） | **覆盖**：复用同 id；失败前保持 `source: 'stub'`，成功后转 `model` |
| 429 `Retry-After`（I-22） | `max(本地退避, Retry-After)`；不可重试错误直接终态不消耗配额 |
| `setStreaming` 异常路径 | `Runtime.isStreaming()` 暴露只读状态，测试断言「异常后必须复位」 |
| 时钟（I-23） | `now()` 单调化，消除同毫秒排序不稳定导致的随机红 |

**退避计时与流式暂停的交互**：`nextRunAt` 是绝对时刻、流式期间照常推进。
若暂停计时器，流式一结束会集中爆发；现在是「计时继续走 + 执行前查 streaming + `maxPerPump` 上限」，
爆发被压成每轮最多 10 个。有测试覆盖。

## 五、阶段一关账状态

- ✅ 存储层、模型绑定、编辑语义、角色卡导入、能力探测、单活动标签页锁
- ✅ 七条不变量：#1–#5、#7 全部 pass；**#6 唯一 pending**（依赖阶段四写路径，断言已能编译/能跑/能红）
- ✅ 分页加载（`listRecentTurns` / `listTurnsPage`，UI 已接「加载更早」）
- ✅ 导出包含 `schemaVersion` + `checkBundle` 校验
- ⏳ 阶段二起：Prompt 组装器、SummaryView 生成、空洞回退、后台任务中心
