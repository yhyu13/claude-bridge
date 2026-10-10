# SD — claude-bridge 规格与设计文档

| | |
|---|---|
| 文档 | SD（Specification & Design） |
| 版本 | 1.0.0 |
| 日期 | 2026-10-10 |
| 状态 | 生效中（与 `DESIGN.md` 配套） |
| 读者 | 改这个仓库的任何人 / 任何 agent |

> **三份文档各管一段，不要互相替代：**
> - `DESIGN.md` — 产品功能规格（做什么、界面长什么样）。**它是设计真相源。**
> - `docs/SD-*.md`（本文） — 系统设计（怎么做的、边界在哪、为什么这么取舍）。
> - `docs/TD-*.md` — 任务与技术决策（接下来做什么、哪些决策已经定了、改了要付什么代价）。
> - `AGENTS.md` — 踩坑实录（踩过什么、怎么抓的、怎么防复发）。
> - `.specify/memory/constitution.md` — 项目原则（不可让步的东西）。

---

## 1. 这是什么

一个跑在 Windows 开发机上的 HTTP 桥接进程，把电脑上正在跑的 Claude Code CLI 变成一个
**手机浏览器能连上并操控**的界面。手机连上去以后可以：发消息、看流式回复、看工具调用
（含入参与输出）、看每一轮花了多少钱、中止当前轮次、紧急杀掉电脑上的 claude 进程、
切换模型、切换后端。

一句话：**远程控制你自己那台机器上的 Claude Code，而不用坐在电脑前。**

## 2. 为什么不是别的做法

| 备选 | 为什么否掉 |
|---|---|
| SSH / 终端 App | 手机上用终端要处理软键盘、方向键、复制粘贴，Claude 的 TUI 又依赖真终端尺寸。体验是"能跑"而不是"能用"。 |
| 自建 agent 服务端 | 那就不是"操控 Claude Code CLI"了，是重写一个产品。用户已经有 Claude 订阅和 CLI。 |
| WebSocket 直连 CLI | Claude CLI 的 stream-json 是 stdin/stdout 的长驻子进程协议，要双向就得常驻管理进程——这正是 `claude-session.js` 在做的事，换传输层不省事。 |
| 公网暴露 | **否掉。** 只绑 Tailscale 网卡，见 §5。 |

## 3. 系统构成

```
手机浏览器
   │  HTTP  轮询（?t=<token>）  ← 主传输：vivo 浏览器 EventSource 收不到数据帧，实测
   │         SSE  /api/events   ← 备用，桌面用
   ▼
┌──────────────────────────────────────────────┐
│ src/bridge.js                                 │
│   HTTP + 轮询/SSE + token 鉴权 + 事件接线     │
│   主机解析（backend overlay）                  │
├──────────────────────────────────────────────┤
│ src/translator.js    NDJSON → 前端协议（纯函数）│
│ src/claude-session.js 常驻子进程 + 单轮队列     │
│                     + 成本差分 + 空闲回收       │
│ src/auth.js          token 生成与比对          │
│ src/audit.js         审计日志（不含连接来源）    │
├──────────────────────────────────────────────┤
│ web/  零构建，原生 JS（app.js / style.css）    │
└──────────────────────────────────────────────┘
   │  spawn + stdin/stdout（NDJSON stream-json）
   ▼
claude CLI（2.1.288）
   │  HTTPS
   ▼
中转网关 / 官方 API
```

### 3.1 分层职责与不变式

| 层 | 职责 | 不变式 |
|---|---|---|
| `translator.js` | NDJSON → wire 消息 | **纯函数、无状态**。所有分支可单测，不需要起进程。 |
| `bridge.js` | HTTP、鉴权、事件路由、广播 | 事件路由必须调对函数（见 constitution 原则 I） |
| `claude-session.js` | 子进程生命周期、队列、成本 | `start()` 里 `lastCumulativeCost = 0` 必须保留；`pendingResume` 只消费一次 |
| `web/app.js` | 渲染与交互 | 一个 DOM 状态一个写入者；推送型状态要有重连重拉 |

## 4. 协议

### 4.1 wire 协议（server → phone）

`ready | turn | thinking | text | tool | tool_result | turn_end | state | model | backend | usage | alert | echo | fatal`

| 消息 | 关键字段 | 说明 |
|---|---|---|
| `ready` | `cwd, model, toolCount, tools, skills, mcpServers` | **每个 claude 进程只在 spawn 时发一次** |
| `tool` | `id, name, input, danger` | `danger` 由 translator 的危险命令匹配得出 |
| `tool_result` | `id, ok, preview, bytes, durationMs` | `preview` 是输出前 2000 字符；`durationMs` 由 session 端跨 `tool_use`→`tool_result` 量出 |
| `turn_end` | `ok, cost, sessionCost, durationMs, aborted, error` | `cost` 是**本轮增量**，`sessionCost` 是进程累计 |

### 4.2 wire 协议（phone → server）

`prompt | abort | kill | ping`

### 4.3 鉴权

只用两种：`?t=<token>` 或 `X-Bridge-Token: <token>`。token 存 `.bridge-token`
（gitignored），首次运行由 `auth.js` 生成。

`/api/health` **故意不带 token 就能访问**，因为"桥接活着吗"应该能被 tailnet 上任何东西回答；
但它**只回 `{ok, alive}`**。cwd / model / cost 一律在带 token 的 `/api/status`。
`verify-wiring.js` 第 5 组钉死了这条边界，防止它们漂回去。

## 5. 安全模型

**§5.1 前提：任何能连上这个端口的人，拥有一台 Windows 开发机的完整 shell。**
`allowedTools` 含 `Bash`，工具权限是全开的。这不是可以权衡的默认值。

**§5.2 缓解措施**（按优先级，任何一条都不得为了界面好看而删）：

1. 只绑 Tailscale 网卡（`100.x.x.x`），不绑 `0.0.0.0`，不做端口转发
2. token 鉴权
3. `/api/health` 只回 liveness
4. 危险命令高亮 + 审计 + 提醒（**不阻断**）
5. **危险工具卡自动展开**——安全可及性，不是排版

**§5.3 已知未缓解**：token 泄露即等于 shell 泄露。没有做到 per-request 授权、没有
速率限制、没有把工具白名单收窄。

## 6. 前端

### 6.1 功能规格
见 `DESIGN.md` §5，一条都不能丢。实现层面：

| DESIGN.md 要求 | 实现 |
|---|---|
| 顶栏（cwd / 模型 / 成本 / 连接点） | `#bar` 两行；第一行状态+模型+紧急停止，第二行 cwd+轮数+成本 |
| 消息流（用户右 / 助手左 / 流式） | `mdToHtml` + 60ms 合并渲染 |
| 工具卡可折叠 | `<details>`，默认折叠成一行 ribbon |
| 工具名 + 入参 + 结果前 N 字符 + 耗时 | ribbon 上：`name / desc / rib-t(耗时) / ico(✓✗)`；展开后：完整入参 JSON + 输出前 2000 字符 |
| 每轮成本飘条 | `turn_end` → `.meta` 里的 `costline` |
| 底部多行输入 + 发送 / 中止 / 紧急停止 | `#composer` |
| 危险命令高亮 | `.tool.danger` W3 红底 + 自动展开 |

### 6.2 视觉方向（B+ 野兽派信号层）

规则只有一句：**越危险 / 越少见的帧，越重；越密的字，越轻。**

| 档 | 规格 | 用在哪 |
|---|---|---|
| W1 轻 | 2px 边 · 无阴影 · 行高 1.72 | 助手正文（全屏最密的字）、cwd 条 |
| W2 中 | 3px 边 · 4px 硬阴影 | 工具 ribbon、按钮、用户气泡 |
| W3 重 | 3px 边 · 6px 硬阴影 + 高饱和 | **只有**顶栏、危险命令、整轮失败 |

一个视觉簇只允许一处 W3。对比度：`#111 on #F4EFE4` = 15.8:1，`#111 on #FFDE43` = 12.4:1，全项 WCAG AAA。

**为什么不全屏都用重边框**：这个产品的主界面就是密集数据面板，v1 的教训是每张卡都
3px 黑边 + 5px 硬阴影，黑边和阴影会累加，认知负荷会累加。重量本身是信息量。

### 6.3 传输选择

轮询（800ms）而不是 SSE，因为 **vivo 浏览器 EventSource 连上了但不投递数据帧**。
`?since=` 游标让断网重连能续上而不是丢对话。SSE 仍在 `/api/events` 提供给桌面。

## 7. 非目标（明确不做）

- 不做多用户 / 权限分级（单人自用工具）
- 不做云端中转或账号体系
- 不做 Markdown 之外的富文本（代码高亮、文件树是明确划出的 MVP 边界之外）
- 不做移动端原生 App
- 不为了"支持更多模型"硬编码模型全名——中转会改名，用别名

## 8. 验证方式

| 层 | 命令 | 覆盖 |
|---|---|---|
| 纯函数 | `npm run verify:quick` | translator 49 · md 33 · wiring 43 · 脱敏 · 扫描 |
| 真实模型 | `npm run verify:backend` | 60 项，真起 claude |
| 接线 | `tools/verify-wiring.js` | 源码级守门，含安全边界 |
| 窄屏 | `_mock/_bench/build-live.js` | 吃生产 CSS + 生产 DOM 原文，断言 ribbon 溢出为 0 且 `.desc` 宽度 > 0 |

**每道闸写完必须做阳性对照**：撤掉修复重跑，确认它会红。
