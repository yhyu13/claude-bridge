#!/usr/bin/env node
'use strict';
/**
 * build-narrow.js — 在指定宽度下量真实溢出，而不是猜。
 *
 * 纪律沿用 build-bench.js：**CSS 和整个 .phone DOM 都从
 * 06-brutalist-signals.html 原文切出来**，不重打一遍。重打一遍就会测到
 * 「我以为的 CSS」，而 bug 恰恰藏在「以为」的那部分里。
 *
 * 输出：narrow-diag-<width>.html
 */

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const demoPath = path.join(HERE, '..', '06-brutalist-signals.html');
const demo = fs.readFileSync(demoPath, 'utf8');
const css = demo.match(/<style>([\s\S]*?)<\/style>/)[1];
const diagJs = fs.readFileSync(path.join(HERE, 'narrow-diag.js'), 'utf8');

/** 从 `<div class="phone">` 起，按 div 深度取到配对的闭合标签。 */
function sliceBalanced(src, openRe) {
  const start = src.search(openRe);
  if (start < 0) throw new Error('找不到 ' + openRe);
  const tagRe = /<(\/?)div\b[^>]*?(\/?)>/g;
  tagRe.lastIndex = start;
  let depth = 0, m;
  while ((m = tagRe.exec(src))) {
    if (m[2] === '/') continue;
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return src.slice(start, m.index + m[0].length);
  }
  throw new Error('没配对上');
}

const phone = sliceBalanced(demo, /<div class="phone">/);
const widths = [320, 360, 390, 412];

const made = [];
for (const W of widths) {
  const html = [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>narrow diag ' + W + '</title>',
    '<style>',
    css,
    'body{margin:0;background:#222}',
    '#diag{background:#000;color:#5fd39a;font:12px/1.55 Consolas,monospace;',
    '  padding:12px 16px;white-space:pre;overflow-x:auto}',
    '#stage{width:' + W + 'px;padding:0 8px 20px;background:#F4EFE4;overflow-x:visible}',
    '#stage .phone{height:auto;max-width:none}',
    '.bad{color:#ff6b6b}.ok{color:#5fd39a}',
    '</style></head><body>',
    '<pre id="diag">measuring…</pre>',
    '<div id="stage">', phone, '</div>',
    '<script>', diagJs, '</script>',
    '</body></html>',
  ].join('\n');
  const name = 'narrow-diag-' + W + '.html';
  fs.writeFileSync(path.join(HERE, name), html, 'utf8');
  made.push(name);
}

console.log('已生成: ' + made.join(', '));
console.log('CSS 与 .phone DOM 均取自 06-brutalist-signals.html 原文');