#!/usr/bin/env node
'use strict';
/**
 * bench-live.js — 量**生产代码本身**的渲染热点，不是量一份复刻。
 *
 * 沿用 build-bench.js 的纪律：从 web/app.js 按行切出原文嵌进页面。
 * 这里切三段：addTool / addToolResult / botMsg / toolShell。
 *
 * 三个假设，逐个量，不预设结论：
 *   A. addToolResult 用 querySelectorAll 全量扫工具卡找 tid
 *      —— O(卡片数)，会话越长越慢。量：卡片数 × 结果数的真实耗时。
 *   B. follow() 每个 chunk 都读 scrollHeight 强制同步布局
 *      —— 量：跟不跟随两种情况下的每 chunk 成本差。
 *   C. paintReply 每 60ms 全量重解析整段回复
 *      —— 上轮量过说不是瓶颈，这里换更长文本复验，别信上一轮的结论。
 *
 * 用法: node _mock/_bench/bench-live.js
 */

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const WEB = path.join(HERE, '..', '..', 'web');
const appSrc = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const lines = appSrc.split(/\r?\n/);

/**
 * 按**源文件里的连续区间**切片，而不是逐个函数名切。
 *
 * 为什么：逐个名字切时，sliceFn 从目标函数一路吃到「下一个顶层
 * function / 注释块」。而 oneLine 紧挨着 TOOL_HUE + toolStripe，
 * 于是那一刀把它们顺带切了进来 —— 和单独切的那份重复声明，
 * SyntaxError 整页脚本全挂，只留下一个空的「running…」。
 *
 * 教训同 build-bench.js：工装切片出问题时，先怀疑切片边界，
 * 不要怀疑被测代码。
 */
function sliceRange(fromRe, toRe) {
  const start = lines.findIndex((l) => fromRe.test(l));
  if (start < 0) throw new Error('没找到起点 ' + fromRe);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (toRe.test(lines[i])) { end = i; break; }
  }
  if (end < 0) throw new Error('没找到终点 ' + toRe + '（' + fromRe + ' 之后）—— 源文件结构变了');
  return lines.slice(start, end).join('\n');
}

// oneLine → addToolResult 结束的连续区间，正好一次含齐：
// oneLine / toolSummary / TOOL_HUE / toolStripe / toolShell / addTool
// / fmtMs / addToolResult。
// 终点选 addToolResult 的收尾（下一个顶层 async function post），
// 因为 fmtMs 夹在两者中间，切早了就丢掉 addToolResult 本体。
const toolCode = sliceRange(
  /^function oneLine\(/,
  /^async function post\(/,
);

for (const must of ['function oneLine(', 'function toolSummary(', 'const TOOL_HUE',
  'function toolStripe(', 'function toolShell(', 'function addTool(', 'function addToolResult(']) {
  if (!toolCode.includes(must)) {
    throw new Error('切片里缺 ' + must + ' —— 区间边界变了，先修工装，别改被测代码');
  }
}

if (/document\.getElementById\(/.test(toolCode)) {
  throw new Error('切片混进了别的 DOM 操作，会污染测量');
}

// mdToHtml / inlineMd / esc：bench C 要量 paintReply 的全量重解析，
// 必须用生产的那份，不能拿一份简化实现代替（那量的是别的东西）。
const escStart = lines.findIndex((l) => /^function esc\(s\)/.test(l));
let mdEnd = -1;
for (let i = escStart + 1; i < lines.length; i++) {
  if (/^\/\/ ---- /.test(lines[i]) && i > escStart + 5) { mdEnd = i; break; }
}
if (escStart < 0 || mdEnd < 0) throw new Error('markdown 段的边界变了');
const mdCode = lines.slice(escStart, mdEnd).join('\n');
if (!/function mdToHtml/.test(mdCode)) throw new Error('切片里没有 mdToHtml');

// bench E 要对比「全量」与「增量」，两条路径必须是同一份 mdToHtml、
// 同一份 splitBlocks。增量那份直接从 app.js 切上线原文 ——
// bench 里另写一份的做法已经吃过一次亏（正则版切出 0 块，报了 17 倍假提速）。
const incCode = sliceRange(/^function splitBlocks\(/, /^function flushRender\(/);
for (const must of ['function splitBlocks(', 'function paintReplyInto(']) {
  if (!incCode.includes(must)) throw new Error('增量段里缺 ' + must + ' —— 先修工装');
}

const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
const benchJs = fs.readFileSync(path.join(HERE, 'bench-live.js'), 'utf8');

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>bench-live</title>
<style>${css}
body{padding:0}
#stage{width:390px;padding:10px;background:#F4EFE4;margin:0 auto}
#stage .tool{margin:4px 0}
#out{background:#000;color:#5fd39a;font:12px/1.6 Consolas,monospace;padding:14px;white-space:pre;overflow-x:auto}
.h{color:#fff;font-weight:700}.bad{color:#ff6b6b}.ok{color:#5fd39a}.warn{color:#ffd166}
</style></head><body>
<pre id="out">running…</pre>
<div id="stage"></div>
<div id="sink" style="width:390px;padding:10px"></div>
<script>
'use strict';
const els = { log: document.getElementById('stage') };

// 被测代码（addTool / addToolResult）会调 follow()，那是 app.js 里另一个
// 段的函数，和本次测量无关。这里给一个最小替身：真实实现读 scrollHeight
// 判断是否贴底再写 scrollTop，会把「查找 tid」的耗时混进来，还会因为
// stage 没有滚动条而让读操作退化。替身只计数，不碰布局 —— 被量的东西
// 必须是查找本身，不是「查找 + 滚动」。
let followCalls = 0;
function follow() { followCalls++; }

${mdCode}

${toolCode}

${incCode}
<\/script>
<script>${benchJs}<\/script>
</body></html>`;

fs.writeFileSync(path.join(HERE, 'bench-live.html'), html, 'utf8');
const n = toolCode.split('\n').length;
console.log('bench-live.html 已生成（内联 app.js 工具段 ' + n + ' 行原文 + TOOL_HUE）');