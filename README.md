# claude-bridge

**用安卓手机的浏览器，远程驱动电脑上常驻的 Claude Code CLI。** 手机不装 App，电脑上不装插件，公网可达，API key 不出本机。

```
手机浏览器 ──Tailscale 加密组网──▶ 桥接进程(只绑 Tailscale 网卡) ──stdio──▶ claude 常驻子进程
   零安装                        Node，零依赖，零构建                       真正干活的人
```

- **手机不装任何 APK**，浏览器打开网页，"添加到主屏幕"即可
- **API key 永远不离开电脑**——手机只持有一个本地随机 token，从不接触 Claude 凭据
- **只绑 Tailscale 网卡**，所以公网能连、**同一局域网的人反而连不上**（比绑 `0.0.0.0` 安全得多）
- **零运行时依赖**，只要 Node ≥ 20。没有 build 步骤，没有 `npm install`

> 🤝 **要部署或改造这个项目**：看 [AGENTS.md](./AGENTS.md)，那是给人和 agent 的操作手册（含安全模型、验收清单、已踩过的坑）。
> 想理解设计原理和协议实测结论：看 [DESIGN.md](./DESIGN.md)。

---

## ⚠️ 部署前必读

**这等于把一台电脑的 shell 权限开给一个持有 token 的人。**

- 默认 `allowedTools` 含 `Bash` → 可执行任意命令
- `workdir` **不是沙箱** → 仍能读写整台电脑
- 鉴权只有一个静态 token，**无过期、无轮换、无速率限制、无 TLS**（加密由 Tailscale 提供）
- token 在 URL 里 → 可能出现在截图、剪贴板、浏览器历史

想收紧：去掉 `Bash` → 只绑 `127.0.0.1` 走 USB → 单独建一个 tailnet。细节见 [AGENTS.md §2](./AGENTS.md)。

---

## 快速开始

### 1. 配置

```bash
cp config.example.json config.json
```

最少改两项：`workdir`（Claude 工作的项目目录）和 `claudeBin`（`claude` 的路径，已在 PATH 里就填 `null`）。字段说明写在 `config.example.json` 的注释里。

### 2. 确认 Tailscale 通了

```bash
tailscale status     # 两端登录同一账号
tailscale ip -4      # 桥接就是用这条命令解析要绑的地址
```

没登录的话桥接会**直接报错退出**而不是静默降级——绑到一个错的地址比明确失败危险得多。

### 3. 跑测试（不花钱、不联网）

```bash
npm run verify          # 103 项，应当全绿
```

启动之后还可以跑一条**真打两轮**的端到端检查（会花钱，约 $0.02~$0.65，取决于缓存冷热）：

```bash
npm run verify:2turn
```

它存在的理由：成本累计的 bug 藏在**有状态层**，纯函数测试看不见——只有真跑第二轮才暴露。它会自动认出 `config.host` 解析出来的地址；如果你把桥接跑在别处，用 `BRIDGE_BASE=http://<ip>:<port>` 覆盖。

### 4. 启动

```bash
npm start
```

`config.json` 的 `host` 决定谁能连：

| 值 | 谁能连 | 什么时候用 |
|---|---|---|
| `"tailscale"` | 只有 Tailscale 网络内（公网可达，局域网碰不到） | **默认，推荐** |
| `"127.0.0.1"` | 只有本机 | 不想暴露到网络；手机需 `adb reverse` 走 USB |
| `"0.0.0.0"` | 所有网卡，**含局域网** | 不推荐——同网段任何人都能碰到 |

### 5. 手机连上

token 在 `.bridge-token`（首次启动自动生成），两种方式：

```bash
# 扫码：生成 pairing-qr.png，手机相机扫
python tools/make-qr.py
```

或者手输 `http://<你的tailscale-ip>:8787/?t=<token>`。

⚠️ 这个 PNG 和这条 URL 一样都是机密。`.bridge-token` 和 `pairing-qr.png` 已被 `.gitignore` 挡住。

**走 USB 线**（最快的调试方式，不需要 Tailscale，手机和电脑不必在同一网络）：

```bash
adb reverse tcp:8787 tcp:8787
adb shell am start -a android.intent.action.VIEW -d "http://127.0.0.1:8787/?t=<TOKEN>"
```

这种方式要求 `host` 是 `"127.0.0.1"`。

---

## 怎么算装成功了

```bash
IP=$(tailscale ip -4)
TOKEN=$(cat .bridge-token)

# 1. 活性：不需要 token，只回 {ok, alive}，不泄露任何信息
curl -s "http://$IP:8787/api/health"
# → {"ok":true,"alive":true}

# 2. 明细：必须带 token（头名是 X-Bridge-Token，不是 Authorization）
curl -s "http://$IP:8787/api/status" -H "X-Bridge-Token: $TOKEN"
# → {"ok":true,"alive":true,"turnCount":3,"totalCost":0.51,"ready":{...}}

# 3. 不带 token 打 /api/status 必须是 401 —— 这才证明鉴权真的生效
curl -s -o /dev/null -w '%{http_code}\n' "http://$IP:8787/api/status"   # 期望 401
```

> 两个端点故意分开：`/api/health` 公开但只回答"活着吗"，`/api/status` 需要 token 才给工作目录、模型、累计花费。
> 网页首屏用 `?t=<token>` 查询参数（方便扫码配对），其他客户端请用 `X-Bridge-Token` 头。

3. 从同一 Wi-Fi 的**另一台设备**访问内网 IP:8787 —— **应该连不上**，这是有意的
4. 手机发一条会调工具的消息，确认工具卡片左边是 **✓** 而不是一直转圈，展开能看到真实 stdout

---

## vivo / 国产系统必做：后台保活

小米、OPPO、vivo、华为这类系统会后台杀 VPN。**不设置的话，锁屏几分钟后大概率连不上**——表现是"刚才还好好的怎么就断了"，不是桥接的问题。

设置 → 应用管理 → Tailscale：

| 项目 | 设置成 |
|---|---|
| 允许后台运行 / 自启动 | **开**（部分系统还有独立的「自启动管理」要单独开） |
| 省电策略 / 电池优化 | **无限制** |
| 允许后台弹出界面 | 开 |
| 最近任务里加锁 | 下拉最近任务卡片加 🔒 |

再去 设置 → 电池 → 后台高耗电，把它移出限制名单。

**唯一的真判据是熄屏实测**：静态设置查得到不代表系统不会杀它。锁屏十分钟后还能打开页面，才算真通。

---

## 换一个模型 / 换一个后端

这个桥接后面的模型**不是固定的**——它跟着你电脑上 `~/.claude/settings.json` 指向的中转走，而中转随时可能换模型、或者不认某个模型。

**在手机上直接切**：点顶部的模型/后端名字 → 选一个 → 桥接重启 claude 进程并切过去（当前对话上下文会清空）。要切的目标写在电脑的 `config.json` 里：

```json
"backends": {
  "official": { "label": "官方", "env": {} },
  "relay":    { "label": "中转", "env": { "ANTHROPIC_BASE_URL": "https://…/api" } }
},
"activeBackend": "relay"
```

`env` 里的东西通过 `--settings` 注入。**注意不是设进程环境变量**——实测 `ANTHROPIC_BASE_URL` 写在子进程环境里会被 `settings.json` 的 `env` 块覆盖，请求照样打到老的中转，看起来"切了但没切"。

### 连不上时手机会怎么显示

两种后端故障的表现完全不同，桥接分别处理：

| 情况 | 表现 |
|---|---|
| 后端不认这个模型 | 约 6 秒内返回 `API Error: 400 model platform is not recognized` → 手机显示**红色失败块**，写明"当前后端不认识这个模型"并给出下一步 |
| 后端地址不通 / token 失效 | **完全静默**，实测 60 秒以上不吐任何错误 → 由 `turnTimeoutSec`（默认 180 秒）看门狗兜底，结束这一轮并告诉你"连接后端超时" |

第一种以前会显示成 `$0.0000 · 3.4s`，看起来像一次正常又便宜的成功——现在不会了。

---

## 界面能干什么

- 工具卡片**直接显示真实命令**，左边 ✓/✗ 标成败，运行中转圈，展开看参数和真实 stdout
- Markdown 正常渲染（标题、列表、代码块、行内代码）
- 模型的**思考过程**独立成块，跑的时候实时显示，干完自动折叠
- 「思考中 N 秒 · 约 N tokens · 调用工具…」实时秒表
- **后端/模型可见可切**，失败轮次显式报错并附上后端原话
- 每条回复可复制，长回复自动折叠
- 中止按钮随时能打断当前这轮，紧急停止能杀掉电脑上的进程

---

## 目录

| 路径 | 内容 |
|---|---|
| `AGENTS.md` | **部署与维护手册**（安全模型、验收清单、已踩的坑） |
| `DESIGN.md` | 完整设计文档。§1.4 是轮次与成本语义的实测结论，**被修正过三次**，别凭记忆改 |
| `config.example.json` | 配置模板，复制成 `config.json` 后改 |
| `src/bridge.js` | HTTP、鉴权、事件接线、主机解析 |
| `src/claude-session.js` | 常驻进程 + 轮次队列 + 成本差分 |
| `src/translator.js` | 纯函数翻译层（NDJSON → 桥接协议） |
| `web/` | 手机网页，零构建原生 JS |
| `tools/verify-*.js` | 三套测试，共 92 项 |
| `tools/fixtures/` | 真实抓下来的协议样本，接线测试的基准 |
| `docs/` | 冻结的协议样本与成本实测数据 |

---

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| 启动报 `config.host is tailscale...` | Tailscale 没登录。`tailscale up`，或把 `host` 改回 `"127.0.0.1"` |
| **输入框亮了但键盘不弹** | 输入法进程卡死。强杀恢复：`adb shell am force-stop <输入法包名>`，系统会降级到备用输入法 |
| 手机打不开页面 | ① 手机 Tailscale 没登录同一账号；② 桥接没起；③ 用了 `adb reverse` 但 `host` 不是 `127.0.0.1` |
| 同一个 Wi-Fi 反而连不上 | **这是对的**，有意设计。桥接只绑 Tailscale 网卡 |
| 401 | URL 里的 `t=` token 不对，或 `.bridge-token` 换过 |
| 工具卡片一直转圈不出结果 | 查 `bridge-*.err.log`。这曾经是个真 bug（接线喂错了函数），现在有 `verify-wiring.js` 盯着 |
| 消息发出去没反应 | 一次只能有一轮在飞。等上一轮结束再发——这是协议要求，不是 bug |
| 成本数字比预想高 | 缓存不保证复用，实测同一会话内单轮可从 $0.02 跳到 $0.62。见 [DESIGN.md §1.4](./DESIGN.md) |
| 工具没权限 | `config.json` 的 `allowedTools` |

### 两个测 Tailscale 的陷阱

- ❌ **别用 `adb shell ping` 测**——shell 用户在 VPN 路由的排除名单里，它会绕过隧道，测出来的失败是假的。手机上浏览器能打开才算数
- ⚠️ **Android 上 Tailscale 的网卡叫 `tun1`，不叫 `tailscale0`**——找错名字会误判成"没连上"：

```bash
adb shell ip addr show | grep tun1
```

---

## 已知边界

诚实地说清楚这个项目**不是**什么：

- **一次一轮**。协议要求等上一轮 `result` 到齐再发下一行，桥接用队列保证。不丢消息，但**不能并发提问**
- **只连这台机器的这个工作目录**。不是通用 Claude 客户端
- **无 TLS、无 token 轮换、无速率限制、无多用户**。安全模型就是"一个静态 token + Tailscale 的加密"，别在不受信任的 tailnet 上跑
- **主测环境是 Windows + 安卓**。代码本身跨平台（纯 Node），但没在 macOS / Linux 上验证过
- **成本刹车默认关闭**（`maxCostPerTurn: null`）。要开就填数字，单位是美元/轮
- **工具权限默认全开含 Bash**。有危险命令高亮、审计日志、紧急停止、空闲自杀兜底，但仍是全开
