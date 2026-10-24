# HTTP 层契约（阶段五第二轮）

**本文件是契约，不是实现说明。** `src/deploy/proxyPolicy.ts` 是契约的**一个**实现（TypeScript，
用于让判定逻辑可测）；Go 壳按同一契约接，语义以本文件为准。

⚠️ 上一轮的 `deploy/fsJailVectors.json` **只覆盖 FS helper，不覆盖 HTTP 层**。本文件补上。

---

## 1. 路由表（四段）

| 路由 | 作用 | 判定 | 白名单 |
|---|---|---|---|
| `/health` | 健康检查 | 精确匹配 | 只读，无副作用；**仍需配对**（配对门没有例外路由，否则「哪些路径未配对可访问」本身可探测） |
| `/`、`/assets/*`、`*.{js,css,html,ico,png,svg,woff,woff2}` | 静态资源 | 见 `classifyRoute` | 独立路由，**不受 `/v1/*` 白名单影响** |
| `/v1/*` | 模型 API 代理转发 | 前缀 | `PROXY_PATH_ALLOWLIST`，其余 `/v1/*` 拒绝 |
| `/fs/*` | FS helper（**默认关闭**） | 前缀 | 根目录 jail，见 `fsJail.ts` |
| 其他 | — | — | 拒绝 |

> 「其他路径一律拒绝」只作用于**代理转发**。静态资源若也套这条，会把自己的前端挡掉。

## 2. 请求校验顺序（遵循 PITFALLS P-6：不依赖先验条件的判定前置）

```
1. Host 头        → 不合法直接拒绝（DNS rebinding 必选项，不是可选加固）
2. Origin 头      → 不合法拒绝
3. 路由判定       → unknown 拒绝
4. 配对态         → 未配对且非配对端点 → 拒绝
5. Content-Type   → 非 application/json 拒绝（仅代理路由）
6. Content-Length → 超限拒绝
```

**顺序理由**：Host/Origin 不依赖任何请求体解析，必须最先做；配对与 Content-Type 都在其后。
若把配对放最前，未配对时攻击者能通过响应差异探测路由存在性。

**配对门没有例外路由**：不因某条路由「只读」「无副作用」而放行。`/health` 也要求配对。
理由同上——一旦存在例外，「哪些路径未配对可访问」本身就是可探测的路由信息；
而探活需求由启动打印的 URL 满足，不需要一条可裸访问的端点。

## 3. 配对

| 项 | 语义 |
|---|---|
| token 生成 | 32 字节随机，启动时一次 |
| token 传递 | 启动打印完整 URL `http://127.0.0.1:PORT/?token=XXXX` |
| 首次访问 | 提交 token → 配对 → **原地跳转去掉 token** |
| token 生命周期 | **一次性**；**首次成功配对前不过期**（v0.6.1 对 5 分钟过期的修正） |
| cookie | `HttpOnly; SameSite=Strict`；值为**独立 32 字节 session secret，不是 token 本身** |
| `Secure` | **不设**（localhost 非 https）。已知妥协，由 Host 校验 + 进程短生命周期覆盖 |
| 轮换 | 新 token 签发 → 旧 cookie 立即失效；进程退出即销毁 |

> cookie 值若等于 token，则 token 泄漏（Referer / 日志 / 屏幕共享）＝ 会话劫持。**必须独立。**

## 4. 响应头

| 头 | 值 | 目的 |
|---|---|---|
| `X-Frame-Options` | `DENY` | 旧浏览器回退 |
| `Content-Security-Policy` | `frame-ancestors 'none'` | 现代浏览器按 CSP 忽略 XFO，两者并存不冲突 |
| `Cross-Origin-Resource-Policy` | `same-origin` | 防跨源资源探测 |
| `Referrer-Policy` | `no-referrer` | 防带 token 的 URL 从 Referer 泄漏 |

## 5. 上限

| 项 | 值 |
|---|---|
| 请求体 | 8 MB |
| 响应体 | 8 MB |
| 连接超时 | 15 s |
| （FS）单文件 / 单工作区 / 写频次 | 100 MB / 1 GB / 120 次每分钟 |

## 6. 设计声明

**用户配置的 endpoint 即被信任，代理不校验目标主机。** 路径白名单管的是 API 路径，目标域名由用户负责。

---

# 已验证 / 待验证

## ✅ 已验证（TypeScript 纯逻辑，39 条用例）

| 项 | 覆盖 |
|---|---|
| 路由判定 | 四段路由 + 带 query 的路径 + 白名单内外 `/v1/*` |
| Host 白名单 | 三种形态、带端口、IPv6 方括号、大小写归一化、attacker 域名、空/畸形 |
| Origin 校验 | 白名单、跨站、`null` Origin 默认拒绝、尾部斜杠 |
| 配对 | secret ≠ token、一次性、错误 token、配对前后、轮换失效、定长比较 |
| 体积 / Content-Type | 上限边界、负数 NaN、JSON 与 charset |
| 加固头取值 | 四个头齐全 |
| token 提取 | query 首位与非首位 |

## ⏳ 待验证（**必须等 Go 壳 + 真实浏览器**，TS 测不了）

> **验收清单已写好**：每项「操作 → 预期 → 失败判定」见 `deploy/ACCEPTANCE.md`，
> Safari 降级方案（Plan B1）同文件 §E。验收时照做即可，不需要现场判断通过标准。

> **2026-10-23 更新**：Go 壳已落地于 `server/`（41 条 `go test`，三平台交叉编译）。
> 下列 7 项中，`HttpOnly`、XFO/CSP、静态映射、进程退出失效、代理转发、Host 校验已实测通过；
> **Safari 实测**与**真实服务商 endpoint** 仍待环境，逐项实际值见 `ACCEPTANCE.md` 执行记录。

| 项 | 为什么测不了 | 验收方式 |
|---|---|---|
| `HttpOnly` 是否真的阻止 JS 读取 | 浏览器行为 | DevTools 里 `document.cookie` 应为空 |
| `SameSite=Strict` 在 **Safari** 的行为差异 | Safari 与 Chromium 处理不同 | **单独一次 Safari 实测**；若不生效需降级方案（每次带 token 或绑定连接），这会改变安全模型，要早发现 |
| `X-Frame-Options` + CSP 的实际拦截 | 浏览器行为 | 任意网页 `<iframe src="http://127.0.0.1:PORT">` 应被拒绝 |
| DNS rebinding 下的 Host 头行为 | 需要真实 DNS + 浏览器 | 无法在此环境构造；Host 校验已按规范实现，仍需真实场景复核 |
| 静态资源路由 ↔ 真实文件系统映射 | 需要真实目录 | Go 壳接入后手动访问一次 |
| cookie 在进程退出后是否真的失效 | 需要真实进程 | 重启二进制，旧 cookie 应无效 |
| 代理转发真实 `/v1/chat/completions` | 需要真实 endpoint | 配一个可用 endpoint 跑一次 |

---

# 未做（诚实标注）

上一轮此处的结论是「Go 壳一行未写，提交未编译验证的 Go 代码比不提交更糟」。**本轮已消除**：

- `server/` —— 路由、Host/Origin 校验、配对 token + cookie、加固头、静态托管、`/v1/*` 代理、FS helper 接线全部落地
- `server/*_test.go` —— 41 条，含 `fsJailVectors.json` 20 条同名场景与 `httptest` 集成
- 产物：`server/narra-desk.exe`（Windows，6.9 MB）；darwin / linux 交叉编译验证通过

仍未做的只剩**环境依赖项**：

- Safari `SameSite=Strict` 实测（当前机器为 Windows，无 Safari）
- 真实服务商 endpoint 的 401 / 429 语义实测（已用 mock upstream 验证转发链路与 `Retry-After` 透传）
- 演示模式的浏览器实测（`dist` 已能构建，但 `file://` 需要真实桌面浏览器双击打开，自动化浏览器代理只能访问 `http(s)://`）

> 这三项都是「未测」，不是「通过」。逐项后果见 `ACCEPTANCE.md` §F「未验证项及其影响」。
