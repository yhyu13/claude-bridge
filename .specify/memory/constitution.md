# claude-bridge Constitution

本文件是**项目级原则**。功能规格在 `DESIGN.md`，历史踩坑在 `AGENTS.md`，本文件管的是
"在这个仓库里做事时，什么是不可让步的"。三者冲突时，本文件的"安全"一节 > `DESIGN.md`
的功能边界 > 一切。

## Core Principles

### I. 接线必须可测（NON-NEGOTIABLE）
纯函数测试看不见接线层的错。本项目已经因为这件事丢过一次真实功能：
`translator.js` 从第一天起就正确处理了 `tool_result`，`verify-translator.js` 长期 47/47 全绿，
但 `bridge.js` 把这个事件错误地路由到 `translateAssistantBlocks()`，那个函数只认
text/thinking/tool_use，于是返回 null——手机上每个工具调用都收不到结果，转圈永不停。
**纯函数是绿的，接线是断的。**

因此：任何新增的事件路由，都必须在 `tools/verify-wiring.js` 里有一条源码级守门，
并且注释里写明这道闸**抓不到什么**（例如"抓不住 resync 调了但 Promise 不 resolve"）。
不写边界的守门会被下一个读代码的人当成万能保险。

### II. 测试必须调生产代码本身
不许把生产实现复制一份到测试里。复制品会漂移，然后在你改坏生产代码之后**照样全绿**。
现有的做法是切片原文：
`_mock/_bench/build-live.js` 直接吃 `web/style.css` 全文和 `web/app.js` 里 `toolShell()`
的 `s.innerHTML` 原文，`build-bench.js` 直接切 `web/app.js` 第 122–227 行的真实实现。
DOM 结构一变，切片会失败并要求你更新，而不是悄悄测一份旧副本。

### III. 写完闸必须做阳性对照
没验证过"撤掉修复它会红"的闸，等于没有闸。本项目因此至少翻过三次车：
pre-commit 扫描跑在 `git add` 之前（扫的是旧 index）；PIL 单行直绘静默裁字而尺寸与文件大小
都通过；`overflow:hidden` 把 226px 溢出裁掉让页面"看着正常"而路径已经消失。

**交付前必须回答：这个闸在 bug 存在时，会不会变红？** 答不上来就不要提交它。

### IV. 一个状态只能有一个写入者
定时器驱动的重复渲染里，"谁最后跑谁赢"，而且每次都朝同一个方向赢。已因此出过两个 bug：
模型行被每秒轮询的旧快照盖回；`title` 更新了而文字没更新，DOM 变成"一半对一半错"。

**零个写入者和两个写入者一样错。** 推送型状态（模型、后端、ready/cwd）必须有
"重连后重新拉"的路径，否则它会自信地一直说错话。

### V. 性能与风险靠实测，不靠推断
本项目已推翻三个自己的假设：以为 `paintReply` 是 O(n²)（实测单 chunk 从 2ms 到 3.2ms，接近平）、
以为 300 张卡片的材质是瓶颈（硬阴影 1.9ms，比软阴影还快 3 倍）、
以为 320px 会散架（实测整页横向溢出 0px，真因是工具名不截断）。

**给出"这是瓶颈/这是缺陷"之前，先量。量不出来就直说量不出来，不要编一个方向。**
同时写清盲区（桌面 `--disable-gpu` 的数字不等于真手机 GPU 的 raster）。

## 安全底线

**任何能连上这个端口的人，拥有一台 Windows 开发机的完整 shell。** 这是 `DESIGN.md` §6.1
写明的安全前提，不是可以权衡的默认值。

缓解措施（§6.2）按此优先级，**任何一条都不得为了"界面好看"而删除**：

1. token 鉴权（`?t=` 或 `X-Bridge-Token`）
2. `/api/health` 公开但**只回 `{ok, alive}`** —— cwd、model、cost 一律走带 token 的
   `/api/status`。这条是被测试钉死的，不要让它们漂回去。
3. 危险命令高亮 + 审计记录 + 提醒（**不阻断**）
4. **危险工具卡自动展开**（`web/app.js` 的 `if (danger) d.open = true;`）
   —— 这是安全可及性，不是排版偏好。折叠它等于把安全措施换成视觉一致性。

泄露防护由 `.githooks/pre-commit` 保证时机（扫 git index，且由 hook 触发而不是靠记忆），
由 `tools/scan-secrets.js` 保证内容（从 `.scrub-denylist.json` 读模式，不硬编码本机串）。
fixture 用 `mcp__demo__` 保留前缀，不要为了让闸闭嘴去改规则。

## 交付底线

- `npm run verify:quick`（translator 49 + md 33 + wiring 43 + 脱敏 + 扫描）必须绿。
- 改 `web/` 下的文件要 bump `index.html` 里的 `?v=` 缓存版本号，否则手机留着旧副本。
- 文档写"为什么"和"实测数字"，不写"已修复""已优化"这种没有证据的话。
- 用户看得懂的优先级：先说结论和证据，再说过程。

## 开发工作流

Spec Kit（`.specify/` + `.minimax/skills/speckit-*`）负责**动手之前**的规格化：
`/speckit-constitution` → `/speckit-specify` → `/speckit-plan` → `/speckit-tasks` →
`/speckit-implement`。

Superpowers（skill 驱动）负责**动手过程中**的纪律：
`superpowers:brainstorming` 在写代码前逼你把想法说清楚，
`superpowers:test-driven-development` 定实现顺序，
`superpowers:verification-before-completion` 拦住"我觉得做完了"，
`superpowers:systematic-debugging` 拦住"我猜一下改改看"。

两者不是二选一：**文档不会拦截你，闸才会。** 所以文档之外必须有机器执行的闸，
本项目的闸就是 `.githooks/pre-commit`。

## Governance

本文件优先于其他实践。修改原则需要：写明理由、更新版本号与日期、并且同步改掉依赖它的闸。
复杂度必须被论证——加一层抽象之前先问能不能用现有的。

`AGENTS.md` 是踩坑实录，与本文件同属强制内容；只写"规则"不写"为什么"的条目应就地补上
实测数字，否则下一个读的人无法判断这条规则是不是仍然成立。

**Version**: 1.0.0 | **Ratified**: 2026-10-10 | **Last Amended**: 2026-10-10
