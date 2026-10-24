# 端到端验收清单（阶段五第四轮）

本文件把 `httpContract.md` 的 7 项「待验证」逐条写成**可执行步骤**：
操作 → 预期 → **失败时的判定依据**。验收时不需要再判断「怎么算通过」，照做即可。

前置：Go 壳已按 `httpContract.md` 实现，二进制已构建（`cd server && go build -o narra-desk .`），
并用 `-webroot ../dist -upstream <url>` 启动。2026-10-23 已按本清单执行，逐项实际值见文末「本轮执行记录」。

**当前状态**：Go 壳已构建并运行；**9 项已实测通过，2 项因环境缺失未测**。
未测项不是「通过」——它们的后果单列在 §F「未验证项及其影响」，验收时不要把下方清单的空框当成同义于失败。

---

## A. 配对与 cookie

### A1 `HttpOnly` 是否真的阻止 JS 读取

- [ ] 打开 `http://127.0.0.1:PORT/?token=XXXX`，确认页面加载并自动跳转去 token
- [ ] F12 → Console，执行 `document.cookie`
- [ ] **预期**：返回 `''`（空字符串）
- [ ] 失败判定：
  - 返回 `undefined` → 不是浏览器环境，检查是否在 Node 里跑
  - 返回含 `nd_session=` 等键 → **`HttpOnly` 未生效**，检查 Set-Cookie 头拼写
  - 返回空但 Network 里 Response Headers 无 `Set-Cookie` → 配对根本没成功，先查 A0

### A2 `SameSite=Strict` 在 **Safari** 的行为差异 ⚠️ 重点

- [ ] **Safari** 打开同一 URL，配对
- [ ] 刷新页面（F5）
- [ ] **预期**：仍为已配对状态，不需要重新粘贴 token
- [ ] 再开一个新标签页访问同 URL
- [ ] **预期**：同样为已配对
- [ ] 失败判定：
  - 刷新后掉回未配对 → `SameSite=Strict` 未生效或 cookie 未持久化 → **启用 Plan B1**（见下）
  - Chromium 正常、Safari 不正常 → 确认是 Safari 差异，不是实现 bug
  - 两者都不正常 → 先查 A1，`HttpOnly` 可能是连带问题

### A3 cookie 在进程退出后失效

- [ ] 配对成功 → 关闭二进制进程 → 重新双击启动 → 得到新 URL（新 token）
- [ ] 用**旧**标签页（未刷新）发起一次对话
- [ ] **预期**：请求被拒绝（未配对）
- [ ] 用新 URL 打开 → 正常配对
- [ ] 失败判定：旧标签页仍能对话 → session secret 被持久化到磁盘了，违反「进程退出即销毁」

---

## B. 静态资源与嵌入防护

### B1 `X-Frame-Options` + CSP 的实际拦截

- [ ] 在**另一个**本地端口起一个静态服务器，放一个 `evil.html`：
      `<iframe src="http://127.0.0.1:PORT" width="800" height="600"></iframe>`
- [ ] 打开 `evil.html`
- [ ] **预期**：iframe 区域空白，Console 出现 CSP / X-Frame-Options 拒绝提示
- [ ] 失败判定：
  - iframe 正常渲染 → 两个头都没生效，检查是否只加了其中一个、或被中间层剥离
  - Console 只有 X-Frame-Options 提示 → CSP 未生效（现代浏览器按 CSP 判断，XFO 会失效）

### B2 静态资源路由 ↔ 文件系统映射

- [ ] 访问 `http://127.0.0.1:PORT/`
- [ ] **预期**：返回 index.html，页面可用
- [ ] 访问 `/assets/` 下任一真实存在的 js/css
- [ ] **预期**：200 且 Content-Type 正确
- [ ] 访问 `/assets/../../etc/passwd`
- [ ] **预期**：404（不是 403 —— 403 会暴露路由存在性）
- [ ] 失败判定：返回 200 → 静态路由未做路径规范化，需按 `fsJail.ts` 的 canonicalize 前缀匹配处理

### B3 `Referrer-Policy: no-referrer`（token 不从 Referer 泄漏）

- [ ] 配对跳转后，F12 → Network，选中跳转后的主文档请求
- [ ] 查看 Request Headers 是否有 `Referer`
- [ ] **预期**：无 `Referer` 头，或不含 `token=` 片段
- [ ] 失败判定：`Referer` 含完整 token → `no-referrer` 未生效，token 会泄漏到后续任何外链请求

---

## C. 代理

### C1 Host 头校验（DNS rebinding）

- [ ] `curl -H 'Host: evil.com' http://127.0.0.1:PORT/v1/chat/completions`
- [ ] **预期**：非 2xx（4xx）
- [ ] `curl -H 'Host: localhost:PORT' ...`
- [ ] **预期**：通过 Host 校验（后续可能因未配对被拒，那是另一层）
- [ ] `curl -H 'Host: app.localhost' ...`
- [ ] **预期**：拒绝（以 localhost 结尾但不是白名单）
- [ ] 失败判定：`Host: evil.com` 返回 2xx → Host 校验缺失，DNS rebinding 可直达

### C2 真实转发 `/v1/chat/completions`

- [ ] 配置一个可用 endpoint + key
- [ ] 在 UI 发一句话
- [ ] **预期**：收到模型回复，UI 出现真实内容（不是「占位回复」）
- [ ] 故意填错 key
- [ ] **预期**：401 → 判定**不可重试**，直接 `failed`，不消耗退避配额
- [ ] 触发一次限流（或 mock 429 + `Retry-After: 30`）
- [ ] **预期**：下次重试时间 = `max(本地退避, 30s)`，不是本地阶梯
- [ ] 失败判定：429 后按本地阶梯立即重试 → `Retry-After` 未接线

### C3 路径白名单

- [ ] `curl http://127.0.0.1:PORT/v1/secret/admin`
- [ ] **预期**：拒绝
- [ ] 失败判定：转发成功 → 白名单未生效

---

## D. 演示模式（file://）

### D1 完全内存态

- [ ] 直接双击打开 dist 下的 `index.html`（file:// 协议）
- [ ] **预期**：顶部常驻横幅「演示模式：不保存数据」
- [ ] 随便操作几轮 → 关闭页面 → 重新打开
- [ ] **预期**：数据不保留
- [ ] 点导出 → 得到 JSON 文件
- [ ] **预期**：导出按钮旁有「导出仅用于迁移到正式部署」提示
- [ ] 在同一演示模式里点导入
- [ ] **预期**：**弹出阻断式确认**，文案含「只在内存」「关闭页面即丢失」
- [ ] 失败判定：不弹确认直接导入 → 用户会误以为「导出了就能恢复」

### D2 密钥不落盘

- [ ] 演示模式下填 key → 关闭 → 重开
- [ ] **预期**：key 为空，需要重新填
- [ ] 失败判定：key 仍在 → 被写进了某个持久化位置

---

## E. Plan B：Safari `SameSite=Strict` 不生效时的降级

> **现在就设计好，验收时只需要在 A/B 之间选一个，而不是现场重新设计安全模型。**
>
> **状态：待触发（设计已定，代码未实现分支）。** A2-Safari 从未测过，所以 Plan B1 也从未启用。
> 不要把它读成「已就绪的备用方案」；它是「如果 Safari 失败了，按这份设计切换」。
> 尚未验证的具体后果见 §F1。

### Plan B1（推荐）：每次请求带 Bearer token

| 项 | 内容 |
|---|---|
| 触发条件 | A2 在 Safari 上失败（刷新或新标签页后掉回未配对） |
| 切换方式 | 配置项 `pairingMode: 'cookie' \| 'bearer'`，默认 `'cookie'` |
| 存储位置 | `sessionStorage`（**不是** localStorage —— 关闭标签页即失效） |
| 传递方式 | 每次请求带 `Authorization: Bearer <token>` |
| token 生命周期 | 配对后**不销毁**，随标签页关闭失效 |
| 安全模型变化 | 从「cookie 会话」变为「每请求 token」：token 在内存与 sessionStorage 各存一份 |
| 可接受性 | XSS 风险在单人本地工具场景可接受；且 token 只对本机代理有效 |

**切换后需要重测的项**：
- A1（cookie 相关）→ **不适用**，改为断言 `Authorization` 头存在且 `document.cookie` 为空
- A2 → 改为断言「刷新后仍能请求成功」
- A3 → 改为断言「进程重启后旧 token 被拒」
- B1 / B2 / B3 / C1 / C2 / C3 → **不变**，重跑一遍

### Plan B2（不推荐，仅作备选）：绑定连接

配对后代理记录「来源 TCP 端口 + 配对时间」，后续同端口请求视为已配对。

**为什么不推荐**：浏览器是否复用连接不在我们控制范围内 ——
同一个标签页可能新建连接，不同标签页可能复用连接。行为不确定会导致
「有时配对有时不配对」，比稳定的失败更难排查。

**仅在 B1 也被证明不可行时才考虑**，且必须附带「每次请求打印来源端口」的诊断日志。

---

## 验收通过标准

- A1、A2（Chromium）、A3、B1、B2、B3、C1、C2、C3、D1、D2 **全部通过**
- A2（Safari）若失败 → 记录实际现象，启用 Plan B1，重跑标注项
- 任何一项失败都记进 ISSUES.md，附**实际值**而非「不通过」

---

# 本轮执行记录（2026-10-23）

环境：Windows · Go 1.26.4 · Chromium（浏览器代理实测）· mock upstream（Node 24）· 真实 `dist`（`vite build` 成功，245 KB）+ 验收夹具两套都跑过
前端：`vitest run` **320 passed / 0 skipped**；`tsc -b` 退出码 0；`vite build` 退出码 0（仅 `INEFFECTIVE_DYNAMIC_IMPORT` 警告，既有问题）

| 项 | 实际值 | 判定 |
|---|---|---|
| A1 `HttpOnly` | 配对并跳转后 `document.cookie` 返回 `""` | ✅ |
| A2 Chromium | 刷新后仍 `NARRA_ACCEPT`；新标签页同 URL 仍 `NARRA_ACCEPT` | ✅ |
| A2 Safari | **未测** —— 本机 Windows 无 Safari | ⏳ 待环境（Plan B1 未触发，保持 `cookie` 模式） |
| A3 进程退出 | 重启后旧 cookie 请求 `/` → **401**；新 token 配对 → **200** | ✅ |
| B1 嵌入防护 | `iframe.contentDocument = null`；控制台 `net::ERR_BLOCKED_BY_RESPONSE http://127.0.0.1:8787/`；iframe 请求状态为 blocked | ✅（CORP + XFO + CSP 三层同时生效，无法也不需要在浏览器里区分是哪一层先拦） |
| B2 静态映射 | 夹具：`/` → 200；`/assets/app.js` → 200 `application/javascript`；`/assets/../../etc/passwd` → **404**。真实 `dist`：`/`、`/assets/index-*.js`、`/assets/index-*.css` 全部 200，UI 正常渲染 | ✅ |
| B3 Referer | `document.referrer === ""`；响应含 `Referrer-Policy: no-referrer` | ✅（以 document.referrer 为准，代理未提供逐请求头检视） |
| C1 Host | curl：`Host: evil.com` → 403；`Host: app.localhost` → 403；`Host: localhost:8787` → **401**（Host 已放行，停在配对层）。⚠️ 浏览器内无法复现 —— `Host` 是 forbidden header，`fetch` 设置会被忽略（实测返回 200），必须用 curl / `--resolve` 才能构造 | ✅（服务端判定） |
| C2 真实转发 | mock upstream：请求体原样到达、响应 `pong` 回传；`429` + `Retry-After: 30` 原样透传 | ✅（转发链路与 429 语义）；⚠️ 未接真实服务商 endpoint，401→`failed` 退避语义由 `tests/httpClient.test.ts` 覆盖 |
| C3 路径白名单 | `/v1/secret/admin` → **404** | ✅ |
| D1/D2 演示模式 | **未执行** —— `dist` 已构建成功，但当前浏览器代理只能访问 `http(s)://`，无法打开 `file://`。替代证据：`vite build` 通过、`tests/demoMode.test.ts` 与 `tests/capabilities.test.ts` 覆盖「内存态 / 导入阻断确认 / key 不落盘」的纯逻辑 | ⏳ 需真实桌面浏览器双击 `dist/index.html` |

补充证据（服务端）：

- 配对响应：`303 See Other`、`Location: /`、`Set-Cookie: nd_session=...; Path=/; HttpOnly; SameSite=Strict`（无 `Secure`，符合契约已知妥协）
- 四个加固头在 `/health`、配对跳转、静态资源响应上均存在
- Go 侧 41 条 `go test` 覆盖上述判定；其中 20 条与 `fsJailVectors.json` 同名

---

# F. 未验证项及其影响

上表 9 项 ✅ 之外还有 2 项 **未测**。它们没写「通过」，也不该被读成「通过」。
本节说明为什么没测、没测的后果、以及下次拿到环境时该怎么做。

## F1 A2 Safari：`SameSite=Strict` 是否在 Safari 上生效

| 项 | 内容 |
|---|---|
| 为什么没测 | 当前机器为 Windows，无 Safari；自动化浏览器代理只有 Chromium |
| 没测的后果 | **可能是「每次刷新都要重贴 token」**。若 Safari 不发送 Strict cookie，刷新或新标签页会掉回 401，用户看到的是「not paired」文本页 |
| 影响范围 | 只影响 Safari 用户；Chromium 已实测通过，不影响主流程 |
| 现状 | **Plan B1 处于「待触发、未验证」**：设计见本文件 §E，但 `httpContract.md` 未定义 `pairingMode`，代码也没有该分支，且从未在 Safari 上跑过 |
| 下次怎么做 | 在 macOS Safari 打开同一 URL → 刷新 → 新标签页。**若失败，再启用 Plan B1 并重跑 §E 标注项**；不要提前切到 bearer 模式（会把已验证的 cookie 路径变成未验证） |

> **不要用 Playwright WebKit 近似 Safari。** Safari 的 ITP 与 cookie 分区策略叠在 WebKit 之上，
> 行为不等价。那样得到的「通过」比「未测」更危险 —— 它会污染「已验证」的语义。

## F2 D1/D2 演示模式：`file://` 下是否真的内存态

| 项 | 内容 |
|---|---|
| 为什么没测 | 自动化浏览器代理只能访问 `http(s)://`，打不开 `file://` |
| 没测的后果 | **演示模式可能完全打不开，也可能行为与文档不符**（横幅不出现、导入不弹阻断确认、key 意外留存）。这三条都只影响 `file://` 路径 |
| 已覆盖的部分 | 纯逻辑有测试：`tests/demoMode.test.ts`（横幅文案、阻断式确认、取消不导入）与 `tests/capabilities.test.ts`（抛异常与 undefined 等价、演示模式一律不可用）。`dist` 构建成功 |
| 没覆盖的部分 | 浏览器里 IndexedDB 在 `file://` 下的真实行为、`<input type=file>` 是否可用、横幅是否真的渲染 —— 这些只有真机双击才能确认 |
| 下次怎么做 | 双击 `dist/index.html`，按 §D 逐条打勾 |

---

## F3 该走哪条路：部署形态的推荐次序

| 形态 | 状态 | 建议 |
|---|---|---|
| Go 二进制 + `http://127.0.0.1:PORT` | **已验证**（A/B/C 全绿，D 除外） | **推荐**，唯一具备完整持久化与安全边界 |
| `vite dev`（localhost:5173） | 未做端到端验收（无 Go 壳，无配对） | 仅开发用 |
| `file://` 双击 `dist/index.html` | **未验证的次选路径** | 只用于「不想启动进程、看一眼效果」。完全内存态，关闭即丢 |

演示模式是**未验证的次选路径**，不是可用路径的并列选项。文档此前把它与推荐部署并列描述，容易让人先试它再困惑于数据丢失。

