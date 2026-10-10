# AGENTS.md — 部署与维护 claude-bridge

面向**在你之前没接触过这个项目的人或 agent**。目标：在一台干净的机器上把它跑起来，并且知道每一步凭什么算成功。

文档分工（先看这张表，知道该翻哪一份）：

| 你想知道 | 去翻 |
|---|---|
| 功能规格（做什么、界面长什么样） | [`DESIGN.md`](./DESIGN.md) — **设计真相源** |
| 系统设计（怎么做的、边界、为什么这么取舍） | [`docs/SD-规格与设计.md`](./docs/SD-规格与设计.md) |
| 技术决策与待办（已经定了什么、接下来做什么） | [`docs/TD-任务与技术决策.md`](./docs/TD-任务与技术决策.md) |
| 现在到哪了 | [`docs/工作记录与待办.md`](./docs/工作记录与待办.md) |
| **不可让步的原则** | [`.specify/memory/constitution.md`](./.specify/memory/constitution.md) |
| 踩过的坑（§6，26 条） | 本文 |

**动手之前的流程工具**（两个都装了，分工不同）：

- **Spec Kit** — 管**动手之前**的规格化。`/speckit-constitution` → `/speckit-specify` →
  `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`。产物在 `.specify/`，
  skill 装在 `.minimax/skills/speckit-*`。CLI：`specify --help`（**包名是 `specify-cli`，
  PyPI 上没有叫 `spec-kit` 的包**）。
- **Superpowers** — 管**动手过程中**的纪律。`superpowers:brainstorming`（写代码前先把想法说清）、
  `superpowers:test-driven-development`（实现顺序）、`superpowers:verification-before-completion`
  （拦住"我觉得做完了"）、`superpowers:systematic-debugging`（拦住"我猜一下改改看"）。

**但真正强制的是闸，不是文档**：`.githooks/pre-commit` 会在每次提交时跑
`scan-secrets` + `verify:quick`。文档不会拦截你，闸才会——这是本项目被坑过两次之后
写进 constitution 的话。

---

## 1. 这是什么

一个 Node 进程，把电脑上**常驻的 Claude Code CLI** 包装成一个网页，让你用安卓手机的浏览器远程跟它对话。

```
手机浏览器 ──Tailscale 加密组网──▶ 桥接进程(只绑 Tailscale 网卡) ──stdio──▶ claude 常驻子进程
   (零安装)                        (Node，~600 行，零依赖)                    (真正的干活的人)
```

三条设计约束，理解它们比理解代码更重要：

1. **不装 App。** 手机只用浏览器打开网页，"添加到主屏幕"当 App 用。
2. **API key 不离开电脑。** 手机只持有一个本地随机 token，从不接触 Claude 凭据。凭据由电脑上的 CLI 自己持有。
3. **只绑 Tailscale 网卡，不绑 `0.0.0.0`。** 结果是公网能连、同一局域网反而连不上。

**零运行时依赖**，只需要 Node ≥ 20。没有 build 步骤，没有 npm install。

---

## 2. ⚠️ 先读安全模型，再决定要不要部署

这不是一个"装个玩具"的东西。部署之前必须理解你实际在开放什么：

| 事实 | 含义 |
|---|---|
| 默认 `allowedTools` 含 `Bash` | 拿到 token 的人可以在你电脑上执行任意 shell 命令 |
| `workdir` **不是沙箱** | Claude 能读写整台电脑的文件，不限于工作目录 |
| 鉴权只有一个静态 token | 无过期、无轮换、无速率限制、**无 TLS**（加密由 Tailscale 提供） |
| 绑 Tailscale = 所有同一 tailnet 的设备可达 | 家里其他设备、公司网络也在这个网里 |
| 手机端 token 在 URL 里 | 可能出现在截图、剪贴板、浏览器历史里 |

想收紧的话，按性价比排序：

1. `allowedTools` 去掉 `Bash` → 失去执行能力，但还能读写被点名的文件
2. `host` 改 `"127.0.0.1"` → 只能走 USB，不暴露到任何网络
3. 单独建一个 tailnet，别和家人/公司的设备混用

`.bridge-token` 等同于密码。**绝不能提交进 git**，`.gitignore` 已经挡了；如果泄露，删掉该文件重启桥接会重新生成。

---

## 3. 前置条件

| 依赖 | 检查命令 | 说明 |
|---|---|---|
| Node ≥ 20 | `node -v` | 唯一硬依赖 |
| Claude Code CLI | `claude --version` | 必须**已登录**，桥接继承机器上已有的凭据 |
| Tailscale | `tailscale status` | 两端登录**同一账号**，否则路由不通 |

不需要 `npm install`。

---

## 4. 部署步骤

### 4.1 拿代码并配置

```bash
git clone <repo> claude-bridge && cd claude-bridge
cp config.example.json config.json
```

改 `config.json`，**最少要改两项**：

- `workdir` → 你想让 Claude 工作的项目目录
- `claudeBin` → 你的 claude 可执行文件路径；已在 PATH 里就填 `null`

其余保持默认。完整字段说明写在 `config.example.json` 的注释里。

### 4.2 确认 Tailscale 通了（这是最容易卡住的一步）

```bash
tailscale status          # 看到自己的节点且有 IP 才算好
tailscale ip -4           # 桥接就是用这条命令解析要绑的地址
```

Tailscale 没登录时，桥接会**直接报错退出**而不是静默降级——这是刻意的：绑到一个错的地址，比明确失败危险得多。

### 4.3 跑测试（不花钱，不联网）

```bash
npm run verify:quick     # 106 项，不调模型
npm run verify           # 加上后端/看门狗那套（会真起 claude 打一次坏后端，不花钱）
```

六套，应当全绿：

| 套件 | 覆盖什么 | 花不花钱 |
|---|---|---|
| `verify-translator` | NDJSON → 前端协议的纯函数翻译 | 否 |
| `verify-md` | 前端 Markdown 渲染器，**含注入防护** | 否 |
| `verify-wiring` | 桥接的事件接线与鉴权边界 | 否 |
| `scrub-fixture --check` | **进仓库的协议样本有没有泄露本机信息** | 否 |
| `scan-secrets` | **整个待提交内容里的密钥 / 家目录 / 真实会话 id** | 否 |
| `verify-backend` | 后端选择、`--settings` 注入、**轮次看门狗**（真起 claude 打坏后端） | 否（打不通就不计费） |

`verify:2turn` 要桥接已在运行。它会自己按 `config.host` 解析地址（曾经写死 `127.0.0.1`，在默认的 `host: "tailscale"` 配置下必然 ECONNREFUSED），桥接跑在别处时用 `BRIDGE_BASE=http://<ip>:<port>` 覆盖。**这条会真调模型，约 $0.02~$0.65。**

### 4.4 启动

```bash
npm start
```

启动日志会打印：监听地址、完整 URL（含 token）、工作目录、工具数量。

**只绑 Tailscale 网卡 = 公网可达但局域网不可达，这是设计而非故障。** 用局域网 IP 访问会连不上，别去"修"它。

### 4.5 拿 token 连手机

token 在 `.bridge-token` 里。两种方式：

- **扫码**（省事）：`python tools/make-qr.py` 生成 `pairing-qr.png`，手机相机扫
- **手输 URL**：`http://<你的tailscale-ip>:8787/?t=<token>`

⚠️ 这个 PNG 和这条 URL 一样都是机密，别发朋友圈。

---

## 5. 怎么算部署成功

按顺序验，每一条都要看到**实际输出**，不要只看"没报错"：

```bash
IP=$(tailscale ip -4)
TOKEN=$(cat .bridge-token)

# 1. 活性（公开，不泄露信息）
curl -s "http://$IP:8787/api/health"
# → {"ok":true,"alive":true}

# 2. 明细（必须带 token；头名是 X-Bridge-Token，不是 Authorization）
curl -s "http://$IP:8787/api/status" -H "X-Bridge-Token: $TOKEN"

# 3. 不带 token 必须 401 —— 这才证明鉴权真的生效，而不是摆设
curl -s -o /dev/null -w '%{http_code}\n' "http://$IP:8787/api/status"   # 期望 401

# 4. 局域网必须连不上（证明攻击面确实收窄了）
#    从同一 Wi-Fi 的另一台设备访问 <内网IP>:8787 —— 期望连不上

# 5. 真发一条会调工具的消息，然后在手机上看：
#    · 工具卡片显示真实命令，且左边是 ✓ 不是一直转圈
#    · 展开卡片能看到「输出 N B」和真实 stdout
#    · 顶部「N 轮 / $金额」在跟着涨
```

**鉴权只有两种带法**：`?t=<token>` 查询参数（网页首屏扫码用）或 `X-Bridge-Token` 头（脚本用）。
**`Authorization: Bearer` 不被识别**——写脚本时用错会得到 401，而 `/api/health` 是公开的，容易误以为鉴权通过了。

第 5 条里的**工具结果**是最容易坏的一环，历史上就是在这里丢过事件（见下节）。

---

## 6. 已知的坑（别重蹈覆辙）

**这些不是假想，是这个项目真实踩过并修好的。**

1. **翻译对了，接线错了。** 翻译器从第一天就正确处理 `tool_result`，47 项单测一直全绿，但 `bridge.js` 把这个事件喂给了只认 assistant 消息的函数，结果工具输出**从来没到过手机**，卡片永远转圈。纯函数测试看不见接线错误——`verify-wiring.js` 就是为此存在的，改接线时必须跑它。

2. **`total_cost_usd` 是会话累计值，不是本轮值。** 直接累加会让第 2 轮起数字虚增。正确做法是差分：记下上一次的累计值，本次减去它。只跑一轮的测试对这个 bug 完全免疫。

3. ~~**不要传 `--model`。显式指定模型会让某些中转网关挂死。**~~ **这条已经作废，实测推翻。** 保留 `null` 当默认值仍然是好主意（中转换模型名时它照样能跑），但理由和当初记的不一样：传错模型名会在 **4~10 秒内明确报** `400 model platform is not recognized`，**不会静默挂死**。

   当年那个"挂死"的观感，其实和"后端不可达"的症状一模一样（60 秒完全静默）。现在有了轮次看门狗，两种情况都会在超时后给出明确提示，所以"传 `--model` 会挂"这个担心不成立了。手机上的模型切换就是靠推翻这条才做出来的。

   顺带一个坑：**模型名是会悄悄失效的。** 本机 `~/.claude/settings.json` 里配的 `claude-opus-5-5` 和 `minimax-m3` 在中转上早已被拒，而 `model: null` 一切正常——所以"配了模型名"和"那个模型名还能用"是两件事。`config.json` 的 `models` 列表要按中转实际认的名字填。

4. **`stop_reason` 在 stream-json 里恒为 `null`**，不能拿来判断一轮是否结束。唯一可靠的边界是 `result` 事件。

5. **一次性往 stdin 灌多行会被合并成一轮。** 桥接是「发一行 → 等一个 result → 再发下一行」的队列模型。

6. **配置里不要写死 IP。** 用哨兵值 `"host": "tailscale"` 让它启动时动态解析。写死的 IP 会在节点重建后静默失效——服务绑在一个不存在的地址上，不报错，只是谁都连不上。

7. **静默降级比报错危险。** 任何 `catch` / `?? 默认值` 都要问一句：如果这个默认值是错的，用户会看到什么？答案是"一个能跑但行为不对的东西"，就该改成显式失败。

8. **注释和文档会撒谎，要拿运行结果对账。** 本项目被自己的注释骗过两次：
   - `// health (no token: only ever reports liveness)` —— 实际把 `cwd`（含 Windows 用户名）、`model`、`totalCost` 发给了 tailnet 上任何设备
   - 验收命令写 `Authorization: Bearer`，但 `checkToken` 只认 `X-Bridge-Token`；而 `/api/health` 是公开的，**用错头去打它照样返回 200**，让人误以为鉴权通过了

   改任何一处安全相关的东西，验收命令必须**亲手跑一遍并看到期望的状态码**，不能因为"文档这么写"就认为它成立。

9. **别让测试/脚本写死与默认配置矛盾的地址。** `verify:2turn.js` 曾写死 `127.0.0.1`，而 `config.host` 默认是 `tailscale`、桥接**故意不绑回环**——新部署者照文档跑验收命令，第一条就是 ECONNREFUSED。验收脚本必须按 `config.host` 解析，否则它测的不是"部署是否正确"，而是"我机器上碰巧的设置"。

10. **切后端不能靠进程环境变量。** 实测：把 `ANTHROPIC_BASE_URL` 塞进子进程的 env，**会被 `~/.claude/settings.json` 的 `env` 块覆盖**，请求照旧打到原来的中转——一个"看起来切了其实没切"的 bug，比直接报错难查一百倍。有效机制是 `--settings <json>`，它压得过 settings.json。后端切换必须走这条路。

11. **"没有消息"和"有消息"是两种故障，别混为一谈。** 后端不认模型 → 6 秒内 `API Error: 400 …`，有信息；后端地址不通 → **60 秒一个字都不吐**。只有第一种能被错误提示救回来，第二种必须靠超时看门狗。设计任何"远端调用失败"的提示时，先问一句：**最坏情况下我到底能收到什么？** 如果答案是"什么都没有"，那必须有兜底机制，不能指望提示文案。

12. **测试替身必须能被真实 argv 启动。** `verify-backend.js` 一度用 `node` 当 claude 的替身，结果桥接传的 `-p`、`--output-format` 被 node 当成**自己的**参数解释，进程秒退，测的是"进程没起来"而不是"看门狗"。改用真二进制 + 真坏后端之后，测的才是真东西。

13. **抓下来的协议样本不能直接提交。** `claude --output-format stream-json` 的 `init` 事件是一整套本机指纹：Windows/macOS 用户名、工程路径、**MCP 服务器清单及每个 server 展开的几十个工具名**（实测抓到一个 5 server / 60 工具的现场，其中含工作单位内部平台）、**完整个人 skill 库和 slash 命令表**（实测 129 / 163 条）、真实 `session_id`、模型名、命名管道路径。原样提交等于告诉所有人这个人用什么模型、装了哪些集成、在哪个公司做什么项目。

    样本是测试数据不能删（translator 的行为完全依赖事件顺序、`tool_use` id 配对和成本数字），所以只能洗：

    ```bash
    node tools\scrub-fixture.js --in-place docs\protocol-sample.ndjson
    npm run verify:scrub        # 只体检不改；已挂进 verify:quick
    ```

    工具自带的通用规则只认「任何机器都成立」的形态（家目录、Desktop、UUID、`tool_use` id、目录 slug）。**你自己机器特有的项目名、用户名、内部集成名，通用规则认不出来**，要填进 `.scrub-denylist.json`（复制 `.scrub-denylist.example.json`）。这个文件是 gitignore 的——理由见第 14 条。

    已经提交进仓库的样本是洗过的，所以刚 clone 下来直接 `npm run verify:quick` 是绿的；只有抓自己的新样本时才需要填 denylist。

    洗的时候**保留**事件顺序、事件类型、`tool_use` id 的对应关系、成本与 token 数字（`verify-translator.js` 的累计/差分断言就钉在这些数上），只替换身份信息和路径。抓新样本后忘了洗，`npm run verify:quick` 会在提交前挡住。

14. **脱敏工具自己也会泄密。** 第一版的 `scrub-fixture.js` 把本机的用户名、项目名、目录前缀硬编码成 `DENY_STRINGS` 和替换规则——它确实能洗干净样本，但**它自己就是泄露源**：公开仓库里搜一下那个用户名，直接命中源码。`scan-secrets.js` 第一版也是同样的毛病，它把自己 `DENY_STRINGS` 里的中文占位词扫了出来；甚至本文档在补写这一条时，也顺手把真用户名写了进去，被 `npm run verify:quick` 当场拦下——这恰恰说明这道闸有用。

    正确做法：工具里只留**任何机器都成立**的通用规则（家目录、Desktop、UUID、`tool_use` id、目录 slug、`sk-` 形态），本机特有的串一律从 gitignore 的 `.scrub-denylist.json` 读，两个工具共用。写这类工具时反问一句：**这个文件提交上去之后，别人能从中读出这台机器的什么？**

15. **提交前的密钥扫描要扫 git index，不是工作目录。** 工作目录里躺着一堆该忽略的运行时产物（日志、token 文件、二维码），扫它们只会天天误报。`git ls-files` 拿到的才是真正会进仓库的东西。同理，误报要加进白名单，**不要删规则**——规则被删掉的那天，真泄露也跟着一起过了。

16. **切换模型 = 杀进程重开，但对话可以不丢。** `--model` 是启动参数，活着的进程改不了，所以切换必然要重启。救回对话的是 `--resume <session-id>`：新进程把同一个 CLI 会话接回来。实测（真中转）——`opus` 种下暗号 7429，杀进程，`sonnet --resume` 重开后准确答出 7429。

    换后端**没有**这个待遇：那是换谁在计费，不该把对话带过去。所以面板把两者分开，并各自说清后果。

17. **`--resume` 之后 `total_cost_usd` 从 0 重数。** 实测：切换前进程累计到 `$0.4619`，`--resume` 换模型后的第一轮报 `$0.1066`。**它数的是当前进程，不是整段对话。**

    这条决定了 `start()` 里 `lastCumulativeCost = 0` 必须保留。如果"好心"改成跨重启保留基线，切换后第一轮会算出 `0.1066 - 0.4619` → clamp 成 0 → 手机显示 **「$0.0000」**——这个项目已经为"假成功数字"修过两次，别再犯第三���。**改这段之前先读这条。**

18. **复制一份协议不叫测试。** `verify-backend.js` 一度在测试里重新实现了一遍 `start()` 的参数拼装。结果 `--resume` 加进真代码那天，测试那份副本静默过时——**它测的是桥接早就不再发送的命令行，而且照样全绿。** 现在测试直接调 `spawnArgs()`，和 `start()` 用的是同一个方法。

19. **杀进程 + 重开进程有个回调竞态，切换功能整个翻车就翻在这里。** `setModel()`/`setBackend()` 都是 `stop()` 紧接 `start()`。`stop()` 里 `proc.kill()` 只是**发信号**，旧进程的 `close` 事件要晚一拍才到，而这期间新进程已经起好、`this.proc` 已经指向它了。

    `close` 处理器原来无条件写 `this.proc = null`，于是它姗姗来迟地执行时：**把活着的替换进程孤立掉了**、发出一条假的 `session_end`、还清空了队列。接着 `send()` 发现 `isAlive()` 为 false，**又起了第三个进程**——而 `pendingResume` 早被上一个进程消费掉了，这个新进程没有 `--resume`，对对话一无所知。

    实测症状极具迷惑性：切换后模型回答「I don't see any password in our conversation history」，而 CLI 层单独测 `--resume` 是完全正常的。**所以"底层能工作"不能证明"组装起来能工作"——中间那层有个回调顺序问题。**

    修法：`close` 里先判断 `if (this.proc && this.proc !== proc) return;`。回归测试刻意**不发任何消息**（所以不花钱），只验切换后 `isAlive()` 仍为 true、`this.proc` 非空、没多出 `session_end`。写完还把修复撤掉跑了一遍，确认测试真的会红——**抓不到 bug 的测试等于没写。**

20. **一块 UI 状态只能有一个写入者。** 加模型切换时，`showModel()` 开始写 `#model`；而 `showReady()` 早就在写它，而且 `pumpOnce()` **每次轮询都调 `showReady(d.status.ready)`**。于是每秒一次：服务端 `ready` 快照里的旧模型名（`claude-opus-5-5` → `claude-sonnet-5[1M]`）把刚更新的值盖回去。

    表现是：切换接口返回成功、提示条也说切成功了、连 `title` 属性都更新成了新值——**只有文字停在旧的**。因为 `showModel` 先设 title 再设 text，而 `showReady` 只设 text，不碰 title。于是 DOM 变成 `title="opus"` 配旧文字，这种"一半对一半错"的状态比全错更难查。

    判据：**给某个 DOM 节点或某个 state 变量加第二个写入点之前，先确认第一个不会继续跑。** 定时器驱动的重复渲染（轮询、定时刷新、动画帧）里，"谁最后跑谁赢"，而且每次都朝同一个方向赢。修法是删掉旧写入者，让职责归一。

    抓它的过程也说明了为什么**要看实际 DOM 属性而不只是文本**：`title` 是新值、文字是旧值，这两个来自不同写入者，矛盾本身就是定位线索。

21. **推送型状态要有一条「重连后重新拉」的路径，否则它会一直说错话。** 上面第 20 条是两个写入者互相覆盖；这条是**零个写入者**——芯片卡在一个自信的错误答案上，而且永远不会自己变好。

    模型和后端是靠事件推给手机的，但事件**只在切换时推**。桥接一重启，手机上已经开着的页面收不到任何替代事件，轮询恢复了、状态却永远冻结在重连前那一版。更阴的是 `connect()` 开头那句 `if (polling) return;`——它让"首次连接拉一次 `/api/model`"这件事只发生一次，之后再也不会发生，读起来却像"每次连接都会拉"。

    实测抓到的现场：桥接早已切到 fable，页面顶栏还稳稳地写着 `claude-opus-4-8[1M]` / 「请求 opus」。

    修法是把那次一次性拉取抽成 `resync()`，在三个时机调：首次连接、**某次轮询失败之后的第一次成功**（轮询重新变绿是我们唯一能收到的"世界变了"信号）、以及每次 `ready` 事件（一个新 claude 进程刚起来，它可能是用另一个模型起的——用户在桌面 CLI 里切换，根本不会有事件推过来）。

    验证方式是**不开页面**：页面停在 fable 上，杀桥接、把启动模型改成 opus、再起桥接，芯片自己变成了 `opus`。**页面没刷新**——这是关键，改了不刷新就能变，才说明是重连路径在干活，不是刷新顺手把 bug 带走了。

    `tools/verify-wiring.js` 第 6 组为此加了 7 条源码级守门。它们只能抓住"有人把 resync 删了"，抓不住"resync 调了但 Promise 永远不 resolve"——所以注释里写明了这个闸的边界，行为靠上面那次实测兜底。

22. **页面级溢出检查抓不到内容丢失，得逐条量。** 320px 上 `document.documentElement.scrollWidth - clientWidth` 稳定等于 **0px**，而同一页里工具 ribbon 的路径列宽度是 **0px**——传了哪个文件你根本看不见。抓它的不是溢出，是 `.tool { overflow: hidden }`：溢出被裁掉了，页面看着一切正常。

    所以窄屏断言必须落在**内容宽度**上，不是落在**容器溢出**上。`_mock/_bench/build-live.js` 吃的是 `web/style.css` 原文和 `web/app.js` 里 `toolShell()` 的 `s.innerHTML` 原文（不是复刻——复刻会漂移，然后照样全绿），断言两条：整条 ribbon 横向溢出为 0、`.desc` 宽度 > 0。

23. **`flex-shrink` 会饿死小项，`max-width` 才是正确的闸——但两个都不够。** 工具名要截断，两版都试过：

    | 写法 | 短名 `Bash` | 长 MCP 名 | 路径列 |
    |---|---|---|---|
    | `flex:0 0 auto` 不截断 | 正常 | 402px | **0px（没了）** |
    | `flex:0 1 auto` + 省略号 | **15px（被饿死）** | 正常 | 正常 |
    | `flex:0 0 auto` + `max-width:38%` | 正常 | 100.8px | 54.5px ✓ |

    第二版坏在：溢出时收缩按「收缩权重 × 基准宽」分摊，`.desc` 的基准宽是整条路径（几百 px），`.name` 只有几个字母，于是**短名先被压没**。第三版让 `.desc` 成为唯一可收缩项、`.name` 只受 `max-width` 硬闸管。

    顺带砍掉的：折叠行原来还想显示输出字节数，实测 ` · 12.4KB` 要多占 38px，而这 38px 正是长工具名时路径归零的原因。§5 要求的是耗时，字节数是我加的，所以字节数让位，留在展开后的 body 里。

    写完必须做阳性对照：把 `max-width` 撤掉重跑，闸立刻转红（291.2px / 491.7px、路径 0px、溢出 127px / 312px）。**没验过这一下的闸等于没有闸。**

24. **零个写入者和两个写入者一样错。** 第 21 条修完模型和后端，cwd 还冻在 `—`：`ready` 事件**每个 claude 进程只在启动时发一次**，所以在进程起来之后才打开的页面永远收不到它。`resync()` 现在也拉 `/api/status` 并交给原有的 `showReady()`，字段边界写在注释里。

    这次顺手踩到它的反面：**把一个"字段不存在"当成"字段是 0"报出去了**。`/api/status` 的 ready 快照只带 `{cwd, model, toolCount}`，而 `showReady` 原来无条件写 `${(m.skills||[]).length} 技能`，于是每次 resync 都把正确的数字覆盖成 `104 个工具 · 0 技能 · 0 MCP`。**缺席和零是两件事。**

25. **本机 Edge 无头在 Edge 154 上不可靠，别把验收押在它身上。** `--headless=new` 被静默吞掉（改 `--headless` 才认），`file://` 和 `http://127.0.0.1` 都可能整轮不出图/不出 dom，且只要用户自己开着 Edge，单实例转发就会把所有请求交给那个真实窗口。内置浏览器对桥接的真实 tailnet 地址会返回**逐字节相同的缓存快照**——换 URL 重新导航后 DOM 仍然一模一样，据此判断"页面没更新"是错的。

    可用的做法：`_mock/_bench/serve.js` 静态托管 `web/` 并把 `/api/*` 反代到真桥接，页面挂在 `http://127.0.0.1:<port>/` 上跑——同一份 `app.js`、同一个真后端，只换了个源。

    反代自己踩的坑：页面不带 token 时会发 `?t=&since=0`，如果按"有 `t=` 就不补"来拼，目标变成 `?t=&since=0&t=真值`，服务端读到**第一个**空值直接 401，页面一片空白，看起来像渲染坏了。**先把请求里已有的 `t=` 删掉再补。**

26. **PowerShell 5.1 发中文请求体会变成 `?`。** `Invoke-RestMethod -Body (@{text='中文'} | ConvertTo-Json)` 会按系统代码页编码，中文全丢（Claude 那边收到的就是 `? Read ??? web/style.css`）。**这不是产品 bug**，手机端发同样的内容显示正常。测试要用 UTF-8：把 JSON 以无 BOM UTF-8 写进文件，再用 `[System.IO.File]::ReadAllBytes()` 当 body 发，并带 `charset=utf-8`。

27. **`git commit --amend` 改的是 HEAD，不是新建提交。** 手滑一次就把上一个提交覆盖掉了，`git log` 里那条记录整个消失，远端还指着旧的——本地"干净"、远端"分叉"，两个都是绿的。

    修法：被覆盖的提交还在对象库里，`git reset --soft <那个哈希>` 就回去了；再用
    `git diff-tree --no-commit-id --name-only -r <hash>` 列出它改过的文件，
    `git checkout <hash> -- <那些文件>` 把内容原样还原，然后**新建**提交。
    还原完比树：`git rev-parse "<hash>^{tree}"` 两边应该相等。

    注意 `git commit -C <hash>` 会重新生成 committer date，**哈希一定对不上**，
    所以要用 `reset` 直接把 HEAD 指回去，而不是复刻提交。

28. **给一个装工具的脚本起名之前，先看它会不会被自己的规则拦下来。** 这轮装 Spec Kit
    时两次撞上 `scan-secrets`：一次是我把真实 tailnet IP 写成了脚本默认值（**拦得对**，
    IP 属于本机身份信息，改成命令行参数传），一次是 fixture 里用了不像假名的第三方
    MCP 工具名。

    `scan-secrets.js` 的规则是 `/mcp__(?!demo__)/`——**`demo` 是它给 fixture 预留的豁免槽**。
    误报的正确处理是改 fixture 占那个槽，而不是给规则加白名单。规则是在 `aa74797`
    那次泄露里真抓到过东西的，削弱它等于拆掉唯一一道防线。

    这条规则的讽刺之处：**我写这条说明文字的时候也被它拦了两次**——第一次是脚本里的真 IP，
    第二次是这条说明里举的反例本身。写文档和写代码受同一道闸管，没有例外。

    同一族：`AGENTS.md` 里写文档时贴了真实的路径/IP/IPv4，同样会被 pre-commit 拦下。
    **文档也是仓库的一部分，脱敏不只针对代码。**

29. **一次失败不是诊断，复现才是。** 我把「CLI 默认模型 `claude-opus-5-5` 中转网关不认」当成
    已确认的缺陷写进了文档，还标成 🔴 阻塞级。受控复跑之后它站不住：

    | 场景 | 进程命令行 | CLI 上报的模型 | 结果 |
    |---|---|---|---|
    | 配置 `model=null`，发第一句 | 无 `--model` | `claude-opus-5-5` | **180 秒超时失败** |
    | 运行时 `POST /api/model opus` | 有 `--model opus` | `claude-opus-5-5` | **61 秒成功** |
    | 配置 `model=null`，**冷启动复跑** | 无 `--model` | `claude-opus-5-5` | **15 秒成功** |

    前两行**报告的是同一个模型名**——同一个名字一次挂一次通，失败原因就不可能是它。
    第三行是干净环境的直接复现，成功。**超时只出现过一次。**

    为什么会写成诊断：失败那次的日志里写着「模型名不被该后端支持」，那句话本身就在
    `explainError()` 的文案里——**我是把一句面向用户的解释当成了根因**，而它的
    真实身份只是"我不知道，所以列了几种可能"。

    规则：**写进文档的结论必须能被人拿着去复现。** 复现不了就写"未复现、无法归因"，
    并且**不为它改代码**——为一个复现不了的症状写的"修复"，是在修一个不存在的问题，
    同时把真正的病因留在原地。

    要查这种偶发失败，正确做法是把超时调小（如 30 秒）然后**重复跑很多次**记录成败比例，
    拿到复现率才谈得上归因。第三方服务（这里是中转网关）的一次性故障，和"某个确定条件
    触发的 bug"，处理方式完全不同。

30. **服务端不发 `Cache-Control: no-store`，客户端写 `cache:'no-store'` 就不算数。**
    本项目所有 JSON 响应曾经都没有任何缓存指令。一个没有新鲜度信息的 200，浏览器有权
    启发式缓存它；`/api/poll` 尤其危险，因为被缓存的不只是画面——旧响应会把 `lastSeq`
    倒回去，于是**被跳过的事件永远不会再来**。

    为什么不把安全放在客户端：主力设备是定制 ROM 的安卓浏览器，`fetch` 的
    `cache:'no-store'` 是否被老实实现不受我们控制。**能表达"这个不能缓存"的地方在服务端。**

    **但要诚实说清这件事的证据强度**：观察到"服务端 turnCount=0、事件缓冲为空，而页面
    仍渲染旧对话"的那个环境，事后证明是内置浏览器返回的缓存快照（第 25 条），**症状没能在
    真机上复现**。修复的依据是 HTTP 语义本身（200 缺新鲜度信息 → 允许缓存），**不是
    "我看到它发生了"**。这两种证据强度不同，别混着写。

31. **别拿测试工装的缺陷当产品的缺陷，也别反过来。** 这轮反代 `serve.js` 只透传
    `content-type`、丢掉 `Cache-Control`，我差点把这个记成产品的 bug。修工装是为了能验证，
    不是为了让结论好看——**改工装的动机必须和结论分开写**。

32. **启动横幅会把 token 打进 stdout，所以任何重定向到文件的启动都会留下凭据。**
    横幅里那行 `公网: http://<tailnet 地址>:8787/?t=<token>` 是**故意**的——用户要复制这个
    URL 到手机上，没有它就没法用。问题在下游：`npm start > log.txt`、CI 抓输出、
    顺手把启动日志贴进 issue，都会把 token 带走，而 token 等于一台开发机的完整 shell。

    这次是 `scan-secrets` 在 pre-commit 拦下了 `_mock/_bench/b4.out` 才发现的——那道闸又一次
    干了实事。**它拦的是产物，不是代码**：只要有人把 stdout 重定向到版本库内的路径就会中招。

    修法是给 `_mock/_bench/` 的 `.gitignore` 加 `*.out` / `*.err`，不是去掉横幅。
    去掉横幅解决不了下游，只是让用户 inconvenient。要真正减少暴露面，应该让横幅只打
    一次、且支持 `--quiet`，那是另一件事，记在 T-10。

33. **提速的数字也可能是假的：要先证明它真的在干活。**
    增量渲染（`paintReplyInto`）第一版用正则数标签深度来切块，对**所有**输入都返回 0 块。
    于是"增量"等于什么都不渲染，而它报出来的提速是 17 倍 —— 比全量的 10.20ms/次还好看。
    成本拆分同时显示解析只占 8%、写 DOM 占 92%，看起来"方向完全正确"。

    如果只看性能数字，会直接把一个空白页面上线，而且**每个指标都在变好**。

    修法是让浏览器自己解析（离屏容器 + `box.children`），真实数字掉到 4.3 倍
    （10.20ms → 2.36ms，60ms 节奏下帧预算 17% → 4%）。仍然值得做，但那才是能兑现的数字。

    **闸要验的不只是"输出等于期望"，还要验"输出非空且结构正确"**：
    `verify-incremental.js` 同时断言块数 > 0、回拼等于原 HTML、以及增量与全量**逐节点同构**。
    第三条抓到过一个真 bug：增量版给每块套了一层 `<div>`，多出 1000 个 DOM 节点，
    还让 `.text > :first-child` 那条 CSS 规则失效 —— 人眼看完全正常。

34. **红色不等于拦截：闸转红可能是因为被测代码崩了。**
    阳性对照探针 P2（"给每块套一层 div"）报了转红，但 `[FAIL]` 一条都没有——
    完整输出里是 `Uncaught NotFoundError: Failed to execute 'replaceChild'`，
    而闸自己还打印 `[PASS]`。也就是说：脚本在中途抛异常，断言根本没跑完，
    退出码非 0 却和"闸拦住了"毫无关系。**把闸整个删掉，它照样会红。**

    现在 `verify-incremental.js` 把"断言失败"和"脚本异常"分开报告，
    `positive-control.js` 也只认"靠断言转红"，崩了不算数。

35. **锚点跨行在 Windows 上永远不匹配，而"跳过"被算成了"通过"。**
    顶栏闸的阳性对照里，探针的正则带 `\n`，而 `web/` 下是 CRLF，
    于是锚点不匹配 → 走"跳过"分支 → 跳过的探针不进失败列表 → 汇总打印
    「闸不灵」。真正的错误在探针自己身上，但报出来的是"保护逻辑有问题"。

    探针锚点现在只跨单行；而且**锚点找不到必须算失败，不能算跳过** ——
    一条没跑的探针比一条失败的探针更危险，它假装自己验证过了。

36. **构建产物会把"被测代码"冻结成旧版本，而且看不出来。**
    `scene-long.html` 在构建时内联 `style.css`。改完 CSS 不重建，闸测的还是上一版样式——
    测量值一个字节都没变，看起来像"我的断言太松"。
    `verify-topbar.js` 现在先比对 mtime：scene 比 CSS 旧就直接失败，并且**不自动重建**
    （闸必须测"当前磁盘上的东西"，而不是偷偷改输入再声称通过）。
    阳性对照脚本自己负责每次重建。

37. **`git checkout HEAD -- <file>` 会把本轮刚做的改动一起还原掉。**
    这次用它清理一个被 PowerShell 改坏的 CSS，结果把同一轮写好的三处改动（kill 按钮、
    backend 宽度、jump 按钮）全部退回 HEAD，git status 只显示"这个文件没改"。
    从索引还原（`git checkout -- <file>`）和从 HEAD 还原是两回事，我这次又踩了后者。

    正确做法：改坏文件之前先确认它没有未提交的有意改动；
    要还原就 `git stash` 存档再还原，确认无误再 `git stash pop`。
    或者干脆像本轮工装那样，把改动写进脚本并留 `original` 变量，用脚本自己还原。

38. **`--window-size` 在 Edge 154 无头下不是最小宽度控制，是被忽略。**
    传 `--window-size=390` 实际拿到 viewport **496**，截图却按 390 宽输出，
    于是页面右边一截根本没被拍进来 —— 看着像横向溢出，用探针量却是 0px。
    两个现象都"像真的"，差点拿一个不存在的溢出问题去做优化。

    `_mock/_bench/shot.js` 走 CDP 的 `Emulation.setDeviceMetricsOverride`，
    viewport 宽度才真的等于我说的那个数字，并且能顺手把 `getBoundingClientRect`
    的真值读回来。顺带一个坑：`--screenshot` 的输出路径**必须给绝对路径**，
    相对路径会报"系统找不到指定的路径"然后静默不出图 —— 那不是 headless 被吞了。

39. **注释里写 `*/` 会提前闭合块注释，连踩三次。**
    给 bench 写说明时写了 `p/h*/pre`，块注释在那里就结束了，后面的正文被当成代码解析，
    报 `Invalid or unexpected token`。改掉那一处之后，我在新写的注释里**引用了这个记号本身**，
    于是又踩了两次。最后一次是靠 `_mock/_bench/find-bad.js`（语法检查 + 打印出错行上下文）
    才定位到。写注释时只写中文名，不写任何会闭合注释的符号。

40. **工装切片要按源文件的连续区间切，不要逐个函数名切。**
    `sliceFn('oneLine')` 从 oneLine 一直吃到"下一个顶层 function"，
    中间的 `TOOL_HUE` + `toolStripe` 被顺带切了进来，和单独切的那份重复声明，
    整页脚本 SyntaxError，只留下一个空的"running…"。

    现在 bench 按**连续区间**切（`oneLine` → `async function post`），一次含齐所有依赖，
    并且切完断言 7 个必需的符号都在。边界变了会在构建时炸，而不是在页面上留一片空白。
    **工装切片出问题时先怀疑切片边界，不要怀疑被测代码。**

---

## 7. 代码地图

```
src/bridge.js          HTTP + 轮询/SSE + token 鉴权 + 事件接线 + 主机解析
src/claude-session.js  常驻子进程 + 单轮队列 + 成本差分 + 空闲回收
src/translator.js      NDJSON → 前端协议。纯函数，无状态，可测
src/auth.js            token 生成与比对
src/audit.js           审计日志（对话轮次与花费，不含连接来源）
web/                   前端。零构建，原生 JS
tools/verify-*.js      四套功能测试
tools/scrub-fixture.js 协议样本脱敏器。抓新样本必用
tools/scan-secrets.js  提交前扫密钥与本机身份
tools/fixtures/        脱敏后的真实协议样本，接线测试的基准
docs/SD-*.md           系统设计
docs/TD-*.md           技术决策（ADR）与待办
docs/工作记录与待办.md   进度总表
_mock/_bench/          实测工装。build-live.js 是窄屏闸，其余是构建脚本
.specify/              Spec Kit：constitution、模板、PowerShell 脚本、workflow
.minimax/skills/       Spec Kit 装到本项目的 10 个 speckit-* skill
.githooks/pre-commit   真正的强制点：scan-secrets + verify:quick
```

改协议时按这个顺序动：`translator.js`（纯函数）→ `bridge.js`（接线）→ `web/app.js`（渲染），每步跑 `npm run verify`。

改 `web/` 里的任何文件都要 bump `index.html` 的 `?v=`，否则手机上留着旧副本。
