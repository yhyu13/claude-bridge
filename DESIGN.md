# claude-bridge 设计文档

> 让安卓手机通过浏览器，远程驱动这台电脑上的 Claude Code CLI。
>
> 状态：**设计已定稿，待实施** ｜ 协议层已实测验证（2026-10-03）｜ 目标机器：Windows / Claude Code 2.1.288

---

## 0. 成本解剖：$1.23 花在了哪里（实测）

在写任何代码之前我跑了一次真实探针，随后把 `usage` 明细挖了出来。**结论与直觉相反，必须先说。**

| 指标 | 实测值 |
|---|---|
| 任务 | "读一个 21 字节的 txt，告诉我内容" |
| 模型 | `claude-opus-5-5`（`contextWindow` 1,000,000） |
| 内部轮数 | `num_turns: 3`（一次失败重试 + 最终回答） |
| 墙钟耗时 | `duration_ms: 20189`，首 token `ttft_ms: 10933` |
| **成本** | **`total_cost_usd: 1.2286`** |

### 0.1 token 明细

| 项 | token 数 | 占比感受 |
|---|---|---|
| `output_tokens` | **321**（其中 thinking 97） | 你真正想要的产出 |
| `input_tokens` | **6** | 基本为 0 |
| `cache_creation_input_tokens` | **239,510** | ← **钱在这** |
| `cache_read_input_tokens` | **123,138** | ← 也在這 |

**有效产出与系统开销之比 ≈ 1 : 1129。**

你付的钱**几乎全部不是"回答问题"，而是"让 Claude Code 记住自己有什么"**。它启动时要往上下文里塞：

- **87 个工具定义**（`init.tools` 实测 87 个）
- **100+ 个 skills**（`init.skills` 实测约 100 个）
- **5 个 MCP 服务器**（`init.mcp_servers`）
- 5 个 agents + 完整 agentic 系统提示

这些加起来就是那 **23.9 万 token 的缓存写入**。

### 0.2 缓存确实在正常命中——本节初版结论已被推翻

> **2026-10-03 更正**：本节初版写的是"前 4 轮每轮重写缓存、一次没命中，怀疑中转网关没实现 prompt caching，是潜在收益最大的一处优化"。**这个诊断是错的**，错在把**进程冷启动**当成了缓存故障。

两轮探针 + 8 轮真实运行的实测：

| 场景 | `cache_creation` | `cache_read` | 成本 |
|---|---|---|---|
| 进程**首轮** | 123,018 | 0 | **$0.61** |
| 之后每一轮 | 0 | ~123,000 | **$0.025** |
| 偶发失配（实测出现过 1 次） | 123,018 | 0 | $0.62 |

连续 6 轮稳定 $0.0249，**缓存每次都命中**。初版那张表之所以看起来"每轮都在重写"，是因为**进程刚起、缓存本来就是空的**，第一轮必须写满 12 万 token 才有得读。

所以：

- ❌ "网关没实现 prompt caching" → 无证据支持，现象可由冷启动完整解释
- ✅ "$1.23 里的大头是**进程首次启动的缓存写入**" → 成立，且这正是**常驻进程**这个架构决策的主要收益来源
- ⚠️ 偶尔仍会失配（探针第 2 轮就撞上一次）→ 属**偶发**，不作为优化方向；详见 §1.4④

> 教训：初版这张表是**逐内部轮**（`num_turns` 内）拆的，但没做"跨进程会话"的对照。**只看单次运行的分轮明细，会把冷启动误诊成系统性故障。**

### 0.3 成本优化的四个杠杆（按收益排序）

| 杠杆 | 做法 | 预期收益 |
|---|---|---|
| **① 修复缓存** | 确认中转是否支持 `cache_control`；对比开关前后 | **最大**，可能 5–10× |
| **② 精简上下文** | 卸载不用的 MCP server（当前装了 5 个，其中一个已经是 `failed` 状态、一个是 `pending`）、裁剪 skills | 大，线性减少那 23.9 万 |
| **③ 换模型** | 保留常驻进程，让 `cache_read` 摊薄 setup 成本 | 中 |
| ④ 减少往返 | 提示写清楚，减少失败重试 | 小（本次重试浪费了 97 output token） |

> **反直觉但重要**：因为 `output_tokens` 只有 321，**贵的是"启动开销"不是"模型档次"**。换便宜模型之所以有效，是因为它降低了那 23.9 万输入 token 的单价，而不是因为输出便宜。

### 0.4 本设计的处理方式

> **2026-10-03 决策：用户明确表示不在乎调用成本**（"我没有什么预算的考虑……我不太在乎"）。前提是**连接本身（隧道 + 桥接）不产生 Claude 调用费用**——本设计满足：Tailscale 免费档够用，桥接进程零成本，只有你主动发消息才会产生 Claude 调用。

因此**成本刹车功能从"功能性需求"降级为"默认关闭的可选配置"**。但**成本显示保留**，因为它的作用变了：

它不再是预算工具，而是**中转网关健康度的活体指标**。

顶栏常驻显示轮次与成本，能一眼回答三个问题：

1. 这次提问落在**缓存读**（$0.02 量级）还是**缓存写**（$0.6 量级）？→ 后者说明刚重启过进程
2. 偶发的成本尖峰是不是又撞上了缓存失配？（§1.4④）
3. 进程首轮那 12 万 token 的固定开销，现在是多少？

没有这个显示，上面三件事永远是黑箱。**多写约 30 行代码，换一个能持续观测系统健康的窗口。**

保留的可选配置（默认 `null` = 不限制）：`maxCostPerTurn` / `maxCostPerDay`。

---

## 1. 已验证的事实基础

本节全部来自本机实测，不是文档推断。原始样本已冻结在 `docs/protocol-sample.ndjson`（19797 字节）。

### 1.1 环境清单（实测）

| 组件 | 实测结果 |
|---|---|
| Claude Code CLI | 实测 `2.1.288`。桥接**不要求特定版本或路径**，`config.json` 的 `claudeBin` 填 `null` 则从 PATH 解析 |
| 认证方式 | 桥接**不管理凭据**。claude 子进程继承机器上已有的登录态（订阅或 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` 均可） |
| 官方 Remote Control | **不可用于本方案**。`claude remote-control --help` 报 `Remote Control is only available with claude.ai subscriptions`——它只认 claude.ai 订阅，接不上中转网关，这就是本项目存在的原因 |
| VS Code 扩展 | 实测装了 `anthropic.claude-code` 与 `kilocode.kilo-code`，但**桥接不经过它们**（扩展沙箱隔离，驱动不了），直接驱动 CLI |
| Node / npm | 实测 `v22.16.0` / `10.9.2`，要求 `>=20` |
| Tailscale | 未安装 |
| Windows OpenSSH Server | 服务不存在 |

**为什么不用官方 Remote Control**：它强制要求 claude.ai OAuth 订阅账号，而你是中转 API key 模式。这不是工作量问题，是账号类型问题。

### 1.2 协议契约（实测 NDJSON 消息类型）

命令：`claude -p --output-format stream-json --input-format stream-json --verbose --allowedTools "Read,Grep,Glob"`

**输入**：stdin 每行一个 JSON 对象
```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
```

**输出**：stdout 每行一个 JSON 对象。实测出现的 6 类：

| # | `type` | `subtype` | 关键字段 | 桥接层用途 |
|---|---|---|---|---|
| 0 | `system` | `init` | `cwd`, `tools[]`, `mcp_servers`, `model`, `permissionMode`, `apiKeySource`, `claude_code_version`, `agents`, `skills`, `plugins`, `messaging_socket_path`, `powershell_path` | **建立连接时的一次性元数据快照**，见 §1.3 |
| 1,2 | `system` | `thinking_tokens` | `estimated_tokens`, `estimated_tokens_delta` | 渲染"思考中 + 已用 token" |
| 3,6 | `assistant` | — | `message.content[]` = `thinking` / `tool_use` / `text` | **助手输出的主通道** |
| 4,7 | `assistant` | — | 同上，`content[].type = "tool_use"`, `.name = "Read"` | 工具调用卡片 |
| 5,8 | `user` | — | `content[].type = "tool_result"`, `.tool_use_id`；顶层 `tool_use_result` | 工具结果回显 |
| 9 | `assistant` | — | `content[].type = "text"` | 最终回答正文 |
| 10 | `result` | `success` | `num_turns`, `result_index`, `total_cost_usd`(**累计**), `usage`(**每轮**), `modelUsage`(**累计**), `permission_denials`, `is_error`, `ttft_ms`, `duration_ms` | **一轮结束的信号 + 遥测**。无 `stop_reason` |

`session_id` 在全部 11 行中保持一致（`8e3fcdca-…`），可作为会话标识。

### 1.3 `system/init` 意外地解决了一个需求

你原本要求"手机上能看到 VS Code 里所有打开的扩展"。实测发现 `init` 事件自带：

- `tools[]` — 本次会话**真实生效**的工具清单（已按 `--allowedTools` 过滤）
- `mcp_servers` — 已连接的 MCP 服务器
- `agents`, `skills`, `plugins` — 已加载的 agent / 技能 / 插件
- `apiKeySource` — 认证来源（**可显示为健康状态，但绝不显示 key 本身**）

也就是说，"能力清单"不需要我猜、不需要读配置文件，**CLI 自己在启动时就会如实汇报**。这比扫描 `~/.claude/settings.json` 可靠得多，因为它反映的是**本次进程真正加载到的**，而不是磁盘上写的。

> 注意：`init.tools` 是 Claude Code 能力清单，**不等于 VS Code 扩展清单**。VS Code 扩展（`kilocode.kilo-code` 等）跑在编辑器进程里，CLI 看不到。若要列扩展，那是 v2 的独立需求（需读 `~/.vscode/extensions` 目录）。本 MVP 不做。

### 1.4 轮次与成本的真实语义（两轮探针实测，2026-10-03）

> 本节**整节重写过三次**。前两版都是错的，而且错法不同：一次把"一次性灌多行"误读成"result 是会话级"，一次把 `stop_reason` 当成轮次判据留着"待锁定"。两者都被同一次探针推翻。脚本：`_probe/twoturn.js`，样本：`_probe/twoturn.ndjson`。

**方法**：起一个常驻进程。写入第 1 行 stdin → **等 `result` 到齐** → 才写第 2 行。

| 事实 | 实测值 |
|---|---|
| `result` 事件数 | **2**（每行一次） |
| `result_index` | **0，然后 1**（递增） |
| `num_turns` | 两轮都是 **1** |
| `session_id` | 全程一致 ✅ |
| `assistant.message.stop_reason` | **恒为 `null`** |
| `total_cost_usd` | 第 1 轮 `0.0246` → 第 2 轮 `0.6398`（**累计**） |
| `modelUsage[...].costUSD` | 同上，**累计** |
| `result.usage` | **每轮**（第 2 轮 `cache_creation=123018`，不累加） |

**① `result` 是"每轮一次"，不是"进程退出一次"**

初稿探针一次性写入 2 行 stdin，只拿到 1 个 `result`，当时据此断定"`result` 是会话级汇总"。**这个结论是探针的写法造成的，不是协议造成的**：一次灌多行会被模型当成**同一轮里的连续输入**合并处理，于是自然只有一个 `result`。

改成"等上一轮 `result` 再发下一行"后，`result` 就是严格的每轮一次。桥接层的轮次队列正是基于这一条。

> 教训：**探针本身也是被测对象**。同一份脚本第一版有个 `if (results > 0) return` 的等待逻辑 bug，第二轮直接返回、不再等待，输出的"第 2 轮 0 ms"差点又被当成协议行为写进文档。判据：任何"某事件只出现一次"的结论，都必须先确认产生它的那段代码真的执行到了第二次。

**② `stop_reason` 恒为 `null`，不能用作轮次判据**

实测两条 assistant 消息的 `stop_reason` 都是 `null`。**唯一可靠的轮次结束信号就是 `result` 事件本身。**

初稿 §4 的协议表把 `turn_end` 定义成"`stop_reason=end_turn` 的 assistant 消息"，据此实现；那套判据在真实输出上一条都匹配不到。

**③ 成本：累计值 vs 每轮值，两个字段语义不同**

这是本节最重要的一条，也是本轮修掉的真实 bug：

- `result.total_cost_usd` 与 `modelUsage.costUSD` = **进程会话累计**
- `result.usage`（`cache_creation_input_tokens` 等）= **本轮**

桥接层原本写的是 `totalCost += e.cost`。第 1 轮碰巧正确（`0 += 0.0246`），第 2 轮开始变成 `0.0246 + 0.6398 = 0.6644`，比真实值 `0.6398` 多算了第一轮，轮次越多偏差越大。

**修法**：差分必须发生在**唯一持有状态的那一层**（`claude-session.js`），其余层只做搬运。

```
result.total_cost_usd(累计) ──减去上一轮的累计值──> 本轮 delta ──> wire.cost
                          └──────────────────────> wire.sessionCost / health.totalCost
```

- 纯函数翻译层（`translator.js`）通过 `ctx.costBase` 接收基线，保持可测
- `claude-session.js` 持有 `lastCumulativeCost`，**每次 spawn 归零**（新进程 = 新会话）
- `bridge.js` 的 `totalCost` **覆盖**而非累加
- `maxCostPerTurn` 刹车比较的是本轮 delta，不是会话累计
- 回归测试：[10] 组 12 项 + `tools/verify-2turn.js` 打真实 HTTP 两轮

**④ 缓存不保证复用，同一会话内单轮成本可以差 30 倍**

第 1 轮 `cache_read = 116208`（花 `0.0246`），第 2 轮仅隔 6 秒却变成 `cache_creation = 123018`（全量重写，花 `0.615`）。

所以 §0 的"冷启动贵、热轮便宜"**不能当成稳态假设**。成本显示保留（作为网关健康度诊断），但**不要**用它推断"这次提问有多贵"。要省成本只能靠桥接层的常驻进程复用。

**①~④ 对实现的约束（当前代码均已满足）**

| 约束 | 落在哪 |
|---|---|
| 必须等上一轮 `result` 再写下一行 stdin，否则合并成一轮 | `claude-session.js` 轮次队列 |
| 轮次结束 = 收到 `result`，不用 `stop_reason` | `#dispatch` 的 `case 'result'` |
| 成本差分只做一次，且只在有状态层 | `claude-session.js` 的 `lastCumulativeCost` |
| 进程重启后累计值归零 | spawn 处显式重置 |

---

## 1.5 ⚠️ 网关 macOS 路径问题：结论已被推翻

> **2026-10-03 实施阶段更正**：本节原标题是「网关侧疑似跨会话缓存污染」。实施后拿到反证，**该推断不成立**，保留记录以免下次重犯同样的误判。

### 当时的观察

模型产出的第一次工具调用入参是：

```json
{"file_path":"/home/user/project/src/hello.txt"}
```

一个 macOS 路径，一个别人的项目名。已证实本地发出的 system prompt 不含该路径，且两次独立探针产出**逐字节相同**的路径。

### 当时的推断

「中转网关的 prompt cache 存在跨会话前缀污染」。

### 为什么这个推断错了

实施后测得：

| 场景 | 首轮成本 | 说明 |
|---|---|---|
| 一次性灌 2 行 stdin | $1.2286 | 缓存**没有**正确命中 |
| 常驻进程，逐轮发送 | $1.2282 → **$0.0259** | 第二轮几乎免费，**缓存正常命中** |

**那 $1.23 的异常高成本是我自己的喂法造成的**——一次性预灌多行使 CLI 无法复用缓存前缀。改成「等上一轮 `result` 再发下一行」之后，缓存行为完全正常。

macOS 路径同样可以用这个解释：一次性灌多行时前缀结构被打乱，命中了不该命中的缓存片段。

### 保留的教训

1. **「两次逐字节复现」不是「跨用户污染」的充分证据**——我还漏掉了「我的输入方式本身破坏了缓存」这个更简单的解释。**先怀疑自己的操作，再怀疑别人。**
2. §0.2 里那张「前 4 轮缓存全部未命中」的表**是同一个原因造成的**，不是网关的锅。
3. 唯一仍然成立的措施：**顶栏常驻显示真实 `init.cwd`，工具卡片显示 `tool.input`**——不是因为网关坏了，而是因为模型偶尔会猜错路径，这个 UI 能让你一眼看见。

---

## 2. 架构

### 2.1 组件与进程模型

```
┌─ 安卓手机 ────────────┐
│ Chrome（零安装）      │
│  ├ 首次：原生相机扫 QR │
│  └ 之后：添加到主屏幕  │
└───────────┬───────────┘
            │ HTTPS over Tailscale (WireGuard 加密)
            │ WebSocket
┌───────────▼───────────────────────────────────────────┐
│ 你家电脑（Windows）                                    │
│                                                        │
│  claude-bridge（Node 22，单进程）                       │
│   ├ HTTP  : 托管手机网页（静态文件）                   │
│   ├ WS    : /ws  —— 双向消息                            │
│   ├ QR    : 启动时打印配对二维码                         │
│   ├ Auth  : token 校验 + 设备白名单                     │
│   └ Spawn : ──stdio──> claude 常驻进程                   │
│              stdin  : {"type":"user",...}  (NDJSON)     │
│              stdout : NDJSON 事件流 ──┐                  │
│  Audit ───────────────────────────────┴─> audit.ndjson  │
└────────────────────────────────────────────────────────┘
                    │
                    └─> ANTHROPIC_BASE_URL（中转网关）
                         ★ API key 只存在这台机器上
```

**关键设计决策：桥接层不是"代理"，是"翻译器"。**

Claude 的 NDJSON 协议和手机 UI 需要的东西不匹配：
- 协议事件太碎（一次回答散成 4–5 个事件）
- 没有轮次边界给 UI 用
- `content[].input`（工具入参）必须提取出来单独显示
- 成本需要累计而不是每次重置

所以桥接维护自己的消息协议（§4），把 NDJSON 翻译成 UI 语义。

### 2.2 为什么用常驻进程而不是每次 `claude -p`

| | 每次新进程 | 常驻进程 |
|---|---|---|
| 上下文 | 丢失，每轮重新读代码 | 保持 |
| 启动开销 | 每次重新加载系统提示 + 工具定义 | 一次 |
| 成本 | 每轮重复付 setup token | 只付一次 |
| 缺点 | 天然隔离 | 需要自己处理异常/僵死 |

选常驻。代价是必须处理进程僵死（§9）。

---

## 3. 目录结构

```
claude-bridge/
├─ DESIGN.md                    ← 本文件
├─ README.md                    ← 怎么跑、怎么配、怎么排障
├─ package.json                 零运行时依赖（只用 Node 内置模块；传输层是 HTTP 轮询，**没有 ws**）
├─ config.json                  非敏感配置：端口、允许工具、工作目录
├─ .bridge-token                配对 token（自动生成，**敏感**）
├─ audit.ndjson                 审计日志
├─ src/
│  ├─ bridge.js                 入口：HTTP + 静态托管 + 轮询/SSE + 鉴权 + 进程管理
│  ├─ claude-session.js         常驻进程 spawn / 轮次队列 / 成本差分（**唯一有状态的成本层**）
│  ├─ translator.js             NDJSON → 桥接协议（纯函数，47 项测试）
│  ├─ auth.js                   token 生成 / 常量时间校验
│  └─ audit.js                  追加写 audit.ndjson（失败/危险动作必须留痕）
├─ web/
│  ├─ index.html                （资源带 ?v=N，绕手机浏览器缓存）
│  ├─ app.js
│  └─ style.css
├─ docs/
│  ├─ protocol-sample.ndjson    ← 冻结的协议契约样本（实测，勿手改）
│  └─ cost-2turn.json           ← 两轮成本实测样本，成本差分测试的输入
├─ tools/
│  ├─ verify-translator.js      纯函数回归（47 项，不花钱，`npm run verify`）
│  └─ verify-2turn.js           打真实 HTTP 发两轮（10 项，约 $0.05，`npm run verify:2turn`）
└─ _probe/                      探针原始产物与脚本（含 twoturn.js，§1.4 的取证）
```

**依赖策略**：**零运行时依赖**，只用 Node 内置模块。传输层是 HTTP（`/api/poll` 轮询为主，`/api/events` SSE 备用），**没有 WebSocket**。

> 决策变更记录：初稿设计是 WebSocket + 手写二维码。实施时两处都改了——① vivo 浏览器 EventSource 能建立连接但收不到 data 帧，**轮询更皮实且断线不丢消息**（ring buffer + `since` 游标）；② 手写 QR 编码器是整个项目最易出错的部分且不阻断核心价值，**QR 延后**（当前直接开 URL）。

---

## 4. 桥接层协议（自研，与 Claude 协议解耦）

**手机 → 桥接**（HTTP POST `/api/prompt` 等，`t` 在请求体里）：

| `t` | 载荷 | 说明 |
|---|---|---|
| `prompt` | `{text}` | 发一条消息 |
| `abort` | `{}` | 中止当前轮次 |
| `kill` | `{}` | **杀掉 claude 进程**（见 §6.4） |
| `ping` | `{}` | 保活 |

鉴权：所有 `/api/*` 走 `x-bridge-token` 头（query 里的 `t=` 只用于网页首屏，**日志不记 token**）。两种带法都会被尝试——URL 里带了个过期的 `?t=` 不会否决一个正确的请求头。

`/api/health` 是唯一的公开端点，**只回 `{ok, alive}`**。工作目录、模型名、工具数、累计花费都在需要 token 的 `/api/status` 里。

> 这一条曾经写错过：代码注释声称 health「只回存活性」，实际却把 `cwd`（含 Windows 用户名）、`model`、`toolCount`、`turnCount`、`totalCost` 一起返回给了 tailnet 上任何设备。tailnet 里可能有家人的手机和公司电脑，这不是"顺手多返回几个字段"。现已拆开，`verify-wiring.js` 盯着不退回。

**传输：`/api/poll?since=<seq>` 为主**

服务端维护环形缓冲，每条消息带单调递增 `seq`。手机轮询时带上自己收到的最后一个 `seq`，断线期间的消息会被补齐。`/api/events`（SSE）保留但仅桌面端在用——vivo 浏览器实测收不到 SSE 的 data 帧。

**桥接 → 手机**：

| `t` | 载荷 | 触发时机 |
|---|---|---|
| `ready` | `{cwd, model, tools[], mcpServers, agents, skills, plugins, apiKeySource, version}` | 收到 `system/init` 后 |
| `turn` | `{index, startedAt}` | 一轮开始 |
| `thinking` | `{tokens, delta}` | `system/thinking_tokens` |
| `text` | `{delta}` | `assistant.content[].text` 增量 |
| `tool` | `{id, name, input}` | `assistant.content[].tool_use` |
| `tool_result` | `{id, ok, preview, bytes}` | `user.content[].tool_result` |
| `turn_end` | `{turn, cost, sessionCost, numTurns, durationMs, denied[], aborted}` | **`result` 事件**（见 §1.4②，不要用 `stop_reason`） |
| `usage` | `{turn, usage}` | 每条 assistant 消息自带的**本轮** token 快照 |
| `state` | `{turnCount, totalCost, alive}` | 每轮结束 / 客户端连上。**整状态覆盖，载荷里不能少字段** |
| `session_end` | `{code, stderr}` | 子进程 `close`（不是 `result`） |
| `fatal` | `{reason}` | 进程退出 / 鉴权失败 / 成本刹车 |

> ⚠️ `usage` 与 `state` 必须是两个类型。`usage` 曾借用 `t:'state'` 发过，而手机端 `state` 处理器是**整状态替换**——结果每条 assistant 消息都把轮次计数清零，活体 token 显示也从没出现过。

设计要点：
- **轮次结束 = 收到 `result`**。`result` 每轮一次（前提：等上一轮 `result` 到齐再写下一行 stdin，否则多行会被合并成一轮，见 §1.4①）。**`stop_reason` 在 stream-json 里恒为 `null`，不可用作判据**（§1.4②）。
- **成本有两个数，含义不同**：`cost` = 本轮增量，`sessionCost` / `state.totalCost` = 会话累计。差分只在 `claude-session.js` 做一次（§1.4③）。`result.usage` 才是每轮的 token 快照，可用于轮内实时估算。
- **`tool.input` 必须透传**。实测中模型第一次 Read 打的是 `/home/user/project/src/hello.txt` 这个根本不存在的路径（§1.5）；把入参显示出来，这类污染一眼可见
- **`fatal` 与 `turn_end` 分离**。"这一轮结束了"和"整个连接死了"在 UI 上是完全不同的两件事，混在一起会出现"看起来还在转圈"的假象

---

## 5. 前端（手机网页）

单页，无框架，原生 JS。目标：手指能用。

- **顶栏**：工作目录（真实 `init.cwd`）· 模型 · **今日累计成本** · 连接状态点
- **消息流**：用户气泡右对齐；助手文本左对齐流式渲染
- **工具卡片**：可折叠，显示 `工具名 + 入参摘要 + 结果前 N 字符 + 耗时`
- **成本条**：每轮结束飘出一条 `+¥x.xx`，今日累计常驻
- **底部**：多行输入框 + 发送 / 中止 / 紧急停止
- **预算条**：接近上限时变红并禁用发送

不做：Markdown 渲染引擎（先按纯文本 + 简单换行处理，v2 再上 marked）、代码高亮、文件树。

---

## 6. 安全模型

### 6.1 前提

你选了**全开权限（含 Bash）**。这等价于：**任何能连上这个 WebSocket 的人，都拥有你开发机的完整 shell**。

我不打算说服你改回去（配置就是一个 `--allowedTools` 参数，随时可改）。但我要把这个选择的**后果和缓解措施**写进设计里，因为这些措施在代码量上几乎不占成本：

### 6.2 缓解措施（全部在 MVP 内实现）

| # | 措施 | 实现成本 |
|---|---|---|
| 1 | **默认只绑 Tailscale 地址**。`--host` 不设成 `0.0.0.0` 时不启动 | 3 行 |
| 2 | **Token 必填 + 设备白名单**。首次配对生成，之后 `config.json` 里可吊销 | 中 |
| 3 | **强制 git 隔离**：启动前检查 cwd 是否在 git 仓库内；不在则警告；每次 `turn_end` 打印 `git status --short` 摘要 | 小 |
| 4 | **危险命令审计**：桥接拦截 `message.content[].input.command`，命中危险模式（`rm -rf`、`del /f`、磁盘格式化、force push）时**高亮 + 记审计 + 推送一条独立提醒**（不阻断，但让你立刻看见） | 中 |
| 5 | **审计日志无条件写**：`audit.ndjson` 追加，记录每轮 prompt、工具名、成本、退出原因。**任何"失败时会做特殊动作"的路径都必须留痕** | 小 |
| 6 | **紧急停止按钮**：`kill` 帧 → 杀掉 claude 进程。手机上唯一能立刻止血的操作 | 小 |
| 7 | **会话空闲自杀**：无输入 N 分钟自动退出并清理（默认 30，可配） | 小 |
| 8 | **首次运行强制确认**：桥接第一次启动时在终端要求手动确认一次全开权限，写进 `config.json` | 小 |

### 6.3 明确不做的

- 不做远程桌面/VNC（那是完全不同的威胁模型，等于把整块屏幕和键盘交出去）
- 不做批量"全部批准"
- 不做多设备同时在线（v1 单设备）

### 6.4 成本刹车（默认关闭）

因用户明确表示不在乎调用成本（见 §0.4），本节**默认不启用**。

配置项保留但默认为 `null`（不限）：

```json
{ "maxCostPerTurn": null, "maxCostPerDay": null }
```

- 填数字即启用，超限行为见 §9
- `maxCostPerDay` 启用时需 `--reset-budget` 显式恢复，防止误触后自动续跑

`total_cost_usd` / `cache_creation` / `cache_read` 的**显示不受此设置影响，始终开启**。

---

## 7. 配对与网络

### 7.1 QR 内容

```
http://<tailscale-ip>:8787/?t=<token>
```

启动时在终端打印。手机**原生相机**即可扫（不需要网页 API，也不需要装 App）。

> **实施状态：QR 延后**（§11）。手写 QR 编码器是整个项目最易出错的部分，且不阻断核心价值。当前直接把 URL 给用户。

### 7.2 网络绑定

`config.json` 的 `host` 决定谁能连。**实施时加了一个初稿没有的语义**：哨兵值 `"tailscale"`。

| `host` | 谁能连 | 实测结果 |
|---|---|---|
| `"tailscale"` | **仅 Tailscale 网卡** | ✅ **当前配置**。公网可达，局域网连不上 |
| `"127.0.0.1"` | 仅本机 | 手机需 `adb reverse tcp:8787 tcp:8787` |
| `"0.0.0.0"` | 所有网卡 | ⚠️ 同局域网任何人都能碰到本服务，**不推荐** |
| 公网直暴露 | 禁止 | 需要 HTTPS 反代 + 独立鉴权，v2 再议 |

**为什么不写死 IP**：初稿让用户手填 `tailscale ip -4` 的结果。但节点重新注册后 100.x 地址会变，写死的值会**静默失效**——表现只是"手机突然连不上"，极难回溯到配置。所以改成启动时执行 `tailscale ip -4` 动态解析；解析失败就**直接退出并打印怎么改回 `127.0.0.1`**，绝不静默降级到别的地址。

**为什么绑 Tailscale 网卡而不是 `0.0.0.0`**：需求是"公网可达"，而绑 `0.0.0.0` 会顺带把服务暴露给同一个咖啡厅 Wi-Fi 里的所有人。绑 Tailscale 接口则是**公网能连、局域网碰不到**，正好满足需求且攻击面最小。

实测三项验证（2026-10-03）：

| 验证 | 结果 |
|---|---|
| `http://<tailscale-ip>:8787/api/health` | HTTP 200，body 只有 `{"ok":true,"alive":true}` ✅ |
| `http://<tailscale-ip>:8787/api/status` 无 token | HTTP 401 ✅ |
| `http://<内网IP>:8787/api/health`（同局域网） | **连不上** ✅ 符合预期 |

> 注意别用 `Authorization: Bearer`——桥接只认 `?t=` 和 `X-Bridge-Token`。而 `/api/health` 是公开的，用错头又去打它，会得到 200，误以为鉴权通过了。

### 7.3 Tailscale 接入清单（一次性）

1. 电脑装 Tailscale 并登录 → `tailscale ip -4` 应能打出 `100.x` 地址
2. 手机装 Tailscale，**同一账号**登录
3. 手机打开 `http://<电脑的tailscale-ip>:8787/?t=<token>`
4. 国产系统（小米/OPPO/vivo/华为）额外做后台保活，否则锁屏几分钟就断

> 登录页**没有独立的 Sign up 按钮**：点 Google / Microsoft / GitHub / Apple 任一按钮，若无账号会**自动注册**。登录成功后浏览器会跳到 `tailscale://` 协议页而显示"无法访问此页面"——**这是正常的，认证已成功**，以 `tailscale status` 为准。

---

## 8. 配置

`config.json`（含本机绝对路径，**已 gitignore**；模板见 [`config.example.json`](./config.example.json)）：
```json
{
  "port": 8787,
  "host": "tailscale",
  "workdir": "C:\\path\\to\\your\\project",
  "claudeBin": null,
  "model": null,
  "allowedTools": "Read,Edit,Write,Glob,Grep,Bash",
  "maxCostPerTurn": null,
  "maxCostPerDay": null,
  "idleTimeoutMin": 30,
  "dangerousPatterns": ["rm -rf", "del /f", "format ", "git push --force"]
}
```

> `model` **必须是 `null`**。初稿写死 `"claude-opus-5-5"`，但显式传 `--model` 会让中转网关挂死（进程存活、stderr 为空、永不返回任何事件）；去掉后同一条请求 9.4 秒完成。代码里永不传 `--model`。
>
> `host` 的取值语义见 §7.2。

敏感项（token）单独放 `.bridge-token`，**已在 `.gitignore`**。API key 桥接进程**从不读取、不缓存、不转发**——它由 `claude` 子进程自己从 `~/.claude/settings.json` 加载。

---

## 9. 失败模式与处理

| 现象 | 检测 | 行为 |
|---|---|---|
| claude 进程静默退出 | `close` 事件，`code !== 0` | 推 `fatal`，UI 显示 stderr 摘要，**保留已渲染内容** |
| 卡死无输出 | 90s 无任何事件 | 推提示，可 `kill` 后自动重启（保留 sessionId 不可行则明确告知会话丢失） |
| 中转 401/429 | `result.is_error` / `api_error_status` | 原样展示，**不自动重试**（重试会重复烧钱） |
| 上下文超限 | `context_management` 字段 | 提示"建议执行 /clear"，MVP 不自动处理 |
| 端口占用 | `EADDRINUSE` | 明确报出端口和 PID，不静默换端口 |
| 手机断网 | WS `close` | UI 标记离线，**不丢历史**（重连后用 `lastIndex` 补发） |
| 预算超限 | 累计成本比较 | 杀进程 + `fatal` + 需显式恢复 |

**一条硬规则**（从 TTSReader 项目踩过的坑继承）：**任何"失败时会做特殊动作"的路径（重试、超时、降级、终止）都必须写审计日志。**排障时你只会先看日志，代码是最后才读的。

---

## 10. 实施步骤与验收

每步都有**可执行的验收标准**，不达标不进入下一步。

| 步骤 | 内容 | 验收 |
|---|---|---|
| **0** | 连发两轮探针，冻结协议契约；确认 `result_index` 是否递增 | 抓到 2 个 `result`，行为已记录进 `docs/protocol.md` |
| **1** | `claude-session.js`：spawn + stdin 写入 + NDJSON 逐行解析 | 命令行跑，能把两轮事件实时打印出来 |
| **2** | `translator.js`：NDJSON → 桥接协议（**纯函数**） | 用 `docs/protocol-sample.ndjson` 做输入，输出符合 §4 表格 |
| **3** | HTTP + WS + 配对 + QR | 浏览器打开，能连上并收到 `ready` |
| **4** | 手机网页 | 桌面浏览器模拟手机视口，**完整走通：连接 → 发消息 → 看流式 → 看工具卡片 → 看成本 → 中止** |
| **5** | 安全措施（§6.2 全部 8 条） | 逐条勾验；危险命令审计能实际触发一次 |
| **6** | Tailscale 接入 | 你在手机上扫一次码，真实跑通一轮 |

**第 4 步完成时先交给你试**，不等 Tailscale。此时你可以在家同一个 Wi-Fi 下用手机扫码验证交互；Tailscale 只解决"在外面也能连"。

---

## 11. 明确不做（MVP 边界）

- 文件树浏览 / 在线编辑文件
- Diff 审阅界面（全开权限下，diff 在电脑上用 `git diff` 看更靠谱）
- 多设备同时在线
- 原生 APK（用 Chrome"添加到主屏幕"）
- Kilo Code / Copilot 适配（架构上留了 adapter 接口，但 v1 不实现）
- VS Code 扩展列表（`init` 拿不到，见 §1.3）
- 离线队列 / 后台推送

---

## 12. 决策记录

### 已确认（2026-10-03）

| # | 决策 | 内容 |
|---|---|---|
| 1 | **调用成本** | **不在乎**。成本刹车降级为默认关闭的可选配置；成本显示保留为网关健康度诊断（§0.4） |
| 2 | **默认工作目录** | 由部署者指定（`config.json` 的 `workdir`） |
| 3 | **模型** | 不指定（`model: null`），交给 CLI 默认 |
| 4 | **工具权限** | **全开**（含 `Bash`）—— 接受 §6.2 的 8 条缓解措施 |

### 仍待确认（不阻塞开工）

| # | 问题 | 影响 |
|---|---|---|
| A | 是否授权调整 MCP / skills 配置以做缓存对照实验（§0.3 杠杆①②） | 只影响性能优化优先级，**不影响 MVP 功能** |
| B | 那个 `failed` 的 MCP server 为何失败 | 若曾尝试过同类方案，其失败原因可能直接可用 |
| C | `audit.ndjson` 保留多久 | 默认永久写盘，不自动清理 |

> 前提确认：本设计的**连接层不产生 Claude 调用费用**（Tailscale 免费档 + 本地桥接）。只有你主动发消息才会有调用产生。

---

## 13. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 手机丢失 = 开发机失守 | **高** | §6.2 全部措施；Tailscale 可随时断网；token 可远程吊销 |
| 调用费用 | 低 | 用户明确表示不在乎（§0.4）。可选刹车默认关闭；成本显示保留为网关健康度诊断 |
| 全开 Bash 误删文件 | **高** | 强制 git 隔离（§6.2-3）+ 危险命令高亮 |
| CLI 版本升级导致协议字段变化 | 中 | 步骤 0 冻结样本；`tools/probe.js` 可随时重抓对比 |
| 中转网关不稳定 / 限流 | 中 | 原样透传错误，不自动重试（避免重复烧钱） |
| 安卓后台杀进程 | 低 | Webview 内运行 Chrome 通常保活；息屏长时间场景 v2 再处理 |

---

## 附：证据与复现

```powershell
# 抓一份原始 NDJSON，绕开桥接直接看 CLI 到底发什么
# （这正是定位 tool_result 丢失时用的方法：先证明上游有、下游没有）
cd claude-bridge
node _probe\raw-user-event.js      # 输出落在 _probe\raw-stream.ndjson

# 三套回归测试（不花钱、不联网）
npm run verify

# 真打两轮，验证成本差分（有状态层的问题只有真跑才暴露）
node tools\verify-2turn.js
```

> `_probe/` 是排障产物，已 gitignore，里面的脚本不保证长期可用。
> 需要长期保留的协议样本已经固化到 `tools/fixtures/tool-call.ndjson`，接线测试以它为基准。

> PowerShell 不支持 `<` 重定向，必须走 `cmd /c`。这是实施时容易踩的第一个坑。
