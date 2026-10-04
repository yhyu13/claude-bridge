# AGENTS.md — 部署与维护 claude-bridge

面向**在你之前没接触过这个项目的人或 agent**。目标：在一台干净的机器上把它跑起来，并且知道每一步凭什么算成功。

设计原理、协议细节、踩坑记录见 [DESIGN.md](./DESIGN.md)。日常使用问题见 [README.md](./README.md)。

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
```

改协议时按这个顺序动：`translator.js`（纯函数）→ `bridge.js`（接线）→ `web/app.js`（渲染），每步跑 `npm run verify`。
