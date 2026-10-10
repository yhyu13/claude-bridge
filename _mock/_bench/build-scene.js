#!/usr/bin/env node
'use strict';
/**
 * build-scene.js — 造一个**有真实内容**的页面，用来看外观、量性能。
 *
 * 为什么需要它：真桥接空转时页面只有顶栏 + 一条 alert（截图确认过），
 * 看起来"挺干净"，但那不是这个产品 99% 的时间的样子。产品的主界面是
 * 密集数据面板：工具调用、路径、代码块、长回复。真内容下才会暴露
 * 排版问题和渲染热点。
 *
 * 纪律（沿用 build-bench.js / build-live.js）：
 *   - web/index.html 原文、web/style.css 原文、web/app.js 原文，
 *     一个字都不重打。
 *   - app.js 会在真实环境里发起 fetch / 起轮询，所以这里不加载它，
 *     而是把它的**原文**贴进 <script>，再在末尾注入一段 fixture 驱动器，
 *     把 wire 事件喂给真实的 handle()。渲染代码一行没改。
 *   - handle() 之后立刻断掉 connect：它只在文件末尾被调用一次。
 *
 * 事件序列取自 docs/protocol-sample.ndjson 的字段形状（translator 的输出），
 * 不是我编的形状 —— 字段名对不上会直接报 ReferenceError。
 *
 * 用法: node _mock/_bench/build-scene.js [场景名]
 *   场景: long（默认，长回复+多工具卡）/ mixed / danger
 */

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const WEB = path.join(HERE, '..', '..', 'web');

const indexHtml = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
const appJs = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');

// index.html 里的 <script src="app.js?v=19"> 换成内联的原文。
const bodyMatch = indexHtml.match(/<body>([\s\S]*?)<\/body>/);
if (!bodyMatch) throw new Error('index.html 的 <body> 结构变了');
const body = bodyMatch[1].replace(/<script src="app\.js[^"]*"><\/script>/, '');

const SCENES = {
  // 长回复 + 密集工具卡：一轮真实的分析工作长什么样
  //
  // 注意 model / backend 是**独立事件**，不是 ready 的一部分：
  // showReady() 刻意不写模型行（app.js 里有注释，理由是避免两个写入者），
  // 所以只发 ready 的话，模型名会一直是空的 —— 那不是产品的 bug，
  // 是 fixture 漏了事件。形状取自 claude-session.js 的 modelInfo()。
  long: [
    { t: 'model', model: {
      requested: 'opus', active: 'claude-opus-4-8[1M]', sessionId: 'a1b2c3',
      available: [
        { name: 'opus', label: 'opus' }, { name: 'sonnet', label: 'sonnet' },
        { name: 'fable', label: 'fable' },
      ] } },
    { t: 'backend', backend: {
      name: 'relay', label: '中转网关', host: 'gw.example.com', known: true },
      available: [{ name: 'relay', label: '中转网关', host: 'gw.example.com' }] },
    { t: 'ready', cwd: 'C:\\code\\my-project', cwdFromCli: true,
      toolCount: 24, skills: ['brainstorming', 'tdd', 'code-review'], mcpServers: ['demo'] },
    { t: 'echo', text: '帮我看看这个项目还有哪些性能问题，重点是渲染热路径', at: Date.now() - 90000 },
    { t: 'turn' },
    { t: 'thinking_text', text: '先扫一遍 web/app.js 的热路径。' },
    { t: 'thinking', tokens: 1240 },
    { t: 'tool', id: 't1', name: 'Read', input: { file_path: 'C:\\code\\my-project\\web\\app.js' }, danger: false },
    { t: 'tool_result', id: 't1', ok: true, preview: 'const els = { ... }', bytes: 45981, durationMs: 42 },
    { t: 'tool', id: 't2', name: 'Grep', input: { pattern: 'querySelectorAll', path: 'web/app.js' }, danger: false },
    { t: 'tool_result', id: 't2', ok: true, preview: 'app.js:588:  for (const c of [...els.log.querySelectorAll', bytes: 1204, durationMs: 138 },
    { t: 'tool', id: 't3', name: 'mcp__demo__knowledge_base_search_documents',
      input: { query: 'paintReply coalescing best practice' }, danger: false },
    { t: 'tool_result', id: 't3', ok: true, preview: '# Result 1\n全量重解析在 60ms 合并窗口内是可接受的。', bytes: 8213, durationMs: 2140 },
    { t: 'tool', id: 't4', name: 'Bash', input: { command: 'node _mock/_bench/build-bench.js' }, danger: false },
    { t: 'tool_result', id: 't4', ok: true, preview: 'bench.html 已生成（内联 app.js 第 122~226 行，104 行真实实现）', bytes: 184, durationMs: 312 },
    { t: 'tool_result', id: 't5', ok: false, preview: 'ENOENT: no such file or directory, open \'src/nope.js\'', bytes: 71, durationMs: 18 },
    { t: 'text', text: '我量了三个假设，**两个被自己的数据推翻了**。\n\n' },
    { t: 'text', text: '## 结论\n\n- 软阴影 `blur=14px` **5.8ms** vs 硬阴影 `blur=0` **1.9ms** —— 硬阴影快约 3 倍\n' },
    { t: 'text', text: '- `paintReply()` 50 个 chunk 总 97.8ms，单 chunk 从 2ms 到 3.2ms，接近平，**O(n²) 假设被推翻**\n' },
    { t: 'text', text: '- 长会话第 100 轮：3764 个节点，全量布局 4.8ms，当前不是瓶颈\n\n' },
    { t: 'text', text: '真正值得动的是另一处：\n\n' },
    { t: 'text', text: '```js\n// app.js:588 —— 每个 tool_result 都要全量扫一遍已渲染的工具卡\nfor (const c of [...els.log.querySelectorAll(\'.tool[data-tid]\')].reverse()) {\n  if (c.dataset.tid === id) { target = c; break; }\n}\n```\n\n' },
    { t: 'text', text: '卡片数量随会话增长，而这条是每次结果都跑一遍。\n\n' },
    { t: 'thinking_text', text: '顺手确认一下这个假设是不是真的成立，别凭感觉改。' },
    { t: 'usage', usage: { output: 1840, cacheRead: 96400 } },
    { t: 'turn_end', ok: true, cost: 0.4271, durationMs: 38410 },
  ],

  // 一轮失败：红色怎么用、有没有把根因露出来
  mixed: [
    { t: 'model', model: { requested: 'claude-opus-5-5', active: null, available: [] } },
    { t: 'backend', backend: { name: 'relay', label: '中转网关', host: 'gw.example.com', known: true }, available: [] },
    { t: 'ready', cwd: 'C:\\code\\my-project', cwdFromCli: true, model: 'claude-opus-5-5', toolCount: 24 },
    { t: 'echo', text: '把模型切到 claude-opus-5-5 试试', at: Date.now() - 20000 },
    { t: 'turn' },
    { t: 'tool', id: 'd1', name: 'Bash',
      input: { command: 'Remove-Item -Recurse -Force C:\\temp\\build' }, danger: true },
    { t: 'tool_result', id: 'd1', ok: true, preview: '已删除 1 个项目', bytes: 31, durationMs: 812 },
    { t: 'turn_end', ok: false, cost: 0, durationMs: 3400,
      result: 'API Error: 400 {"error":{"message":"model platform is not recognized"}}',
      apiError: 400 },
  ],

  // 只有一段思考、工具多、回复短 —— 最常见的一轮
  danger: [
    { t: 'model', model: { requested: 'opus', active: 'claude-opus-4-8[1M]', available: [{ name: 'opus', label: 'opus' }] } },
    { t: 'backend', backend: { name: 'relay', label: '中转网关', host: 'gw.example.com', known: true }, available: [] },
    { t: 'ready', cwd: 'C:\\code\\my-project', cwdFromCli: false, toolCount: null },
    { t: 'echo', text: '把泄露的串从历史里清掉', at: Date.now() - 5000 },
    { t: 'turn' },
    { t: 'thinking_text', text: '历史里有 relay.example.com 和 my-project 两串。' },
    { t: 'thinking_text', text: '向前修复已经完成，剩下的是要不要 force-push。' },
    { t: 'tool', id: 'x1', name: 'Bash', input: { command: 'git log -S "relay.example.com" --oneline' }, danger: false },
    { t: 'tool_result', id: 'x1', ok: true, preview: 'aa74797 docs: 前端视觉 5 个方向的 mock 与 plan', bytes: 68, durationMs: 210 },
    { t: 'tool', id: 'x2', name: 'Bash', input: { command: 'git push --force origin main' }, danger: true },
    { t: 'turn_end', ok: true, cost: 0.0912, durationMs: 14200 },
  ],
};

const which = process.argv[2] || 'long';
const events = SCENES[which];
if (!events) throw new Error('没有场景 ' + which + '，可选: ' + Object.keys(SCENES).join(', '));

// 驱动器：在 app.js 原文之后跑，把 fixture 事件灌进真实的 handle()。
// app.js 末尾会自己调一次 connect()（真 fetch），这里把它掐掉 —— 反正
// 驱动脚本是紧接着的 IIFE，connect 的 fetch 会失败进 backoff，不影响渲染。
const driver = `
(function () {
  const EVENTS = ${JSON.stringify(events, null, 2)};
  let t = 0;
  for (const m of EVENTS) {
    // 给事件排真实的时序，让 working 指示器真的转起来
    setTimeout(() => { try { handle(m); } catch (e) { console.error('handle 挂了', m.t, e); } }, t);
    t += (m.t === 'text' || m.t === 'thinking_text') ? 30 : 8;
  }
  setTimeout(() => { flushRender(); document.title = 'scene-' + ${JSON.stringify(which)}; }, t + 200);
})();
`;

const html = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>scene ' + which + '</title>',
  '<style>', css, '</style>',
  '</head>',
  '<body>', body,
  '<script>',
  '/* ===== web/app.js 原文，未做任何修改 ===== */',
  appJs,
  '/* ===== app.js 结束，下面是 fixture 驱动器 ===== */',
  driver,
  '</script>',
  '</body></html>',
].join('\n');

const probe = fs.readFileSync(path.join(HERE, 'probe.js'), 'utf8');
const withProbe = html.replace('</body>', '<script>\n' + probe + '\n</script>\n</body>');

const out = path.join(HERE, 'scene-' + which + '.html');
fs.writeFileSync(out, withProbe, 'utf8');
console.log('已生成 ' + path.basename(out) + '（' + events.length + ' 个事件，' + (html.length / 1024).toFixed(1) + ' KB）');
console.log('HTML/CSS/app.js 均取自 web/ 原文');