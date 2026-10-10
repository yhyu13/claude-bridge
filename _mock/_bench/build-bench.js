#!/usr/bin/env node
'use strict';
/**
 * build-bench.js — 生成性能基准页，把 **app.js 里的真实实现**原样嵌进去。
 *
 * 为什么必须嵌真实实现、而不是抄一份：
 * 这个项目吃过一次「测试复制了一份生产代码」的亏（spawnArgs 那次）——复制品
 * 和真实现一漂移，测试照样全绿。这里的函数是从 web/app.js 按行切出来的原文，
 * 所以量到的就是线上那个 mdToHtml。
 *
 * 为什么脚本拆成两个文件：
 * bench 页要同时包含 markdown 源码和一段带反引号的测试代码，用单个模板字符串
 * 拼会被反引号提前闭合。拆开后各自都没有转义问题。
 *
 * 用法：node build-bench.js
 */

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const app = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
const lines = app.split(/\r?\n/);

const start = lines.findIndex((l) => /^function esc\(s\)/.test(l));
if (start < 0) throw new Error('没找到 esc()，markdown 段的位置变了');

let end = -1;
for (let i = start + 1; i < lines.length; i++) {
  if (/^\/\/ ---- /.test(lines[i]) && i > start + 5) { end = i; break; }
}
if (end < 0) throw new Error('没找到 markdown 段的结束位置');

const mdSrc = lines.slice(start, end).join('\n');
if (!/function mdToHtml/.test(mdSrc)) throw new Error('切片里没有 mdToHtml，边界变了');
if (/els\.|document\.getElementById/.test(mdSrc)) {
  throw new Error('切片里混进了 DOM 操作，会污染测量');
}

const benchJs = fs.readFileSync(path.join(HERE, 'bench-script.js'), 'utf8');

const CSS = [
  'body{margin:0;background:#F4EFE4;font:14px/1.5 "Helvetica Neue",Arial,"Microsoft YaHei",sans-serif}',
  '.wrap{display:flex;flex-wrap:wrap}',
  '.col{width:400px}',
  '.hard{border:3px solid #111;box-shadow:4px 4px 0 #111;border-radius:0;background:#FFFDF8;padding:9px 12px;margin:8px;font-weight:600}',
  '.soft{border:3px solid #111;box-shadow:4px 4px 14px rgba(0,0,0,.55);border-radius:0;background:#FFFDF8;padding:9px 12px;margin:8px;font-weight:600}',
  '.glass{border:1px solid rgba(255,255,255,.16);border-radius:16px;background:rgba(255,255,255,.08);backdrop-filter:blur(20px) saturate(180%);padding:9px 12px;margin:8px;font-weight:600}',
  '.bg{background:radial-gradient(120% 80% at 12% 0%,#5b2bd6,transparent 58%),radial-gradient(100% 70% at 88% 14%,#d1348f,transparent 55%),#14102a}',
  '#sink .text{font-size:14px;line-height:1.6}',
  '#out{background:#000;color:#5fd39a;font:15px/1.8 Consolas,monospace;padding:18px 22px;white-space:pre}',
  '.h{color:#fff;font-weight:700}.bad{color:#ff6b6b}.warn{color:#ffd166}',
].join('\n');

const pieces = [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8"><title>bench</title>',
  '<style>', CSS, '</style></head><body>',
  '<pre id="out">running…</pre>',
  '<div class="wrap" id="host"></div>',
  '<div id="sink" style="padding:20px;max-width:760px"></div>',
  '<script>',
  '/* ===== 以下是 web/app.js 第 ' + (start + 1) + '~' + end + ' 行的原文，未做任何修改 ===== */',
  mdSrc,
  '/* ===== 切片结束 ===== */',
  '</script>',
  '<script>',
  benchJs,
  '</script></body></html>',
];

fs.writeFileSync(path.join(HERE, 'bench.html'), pieces.join('\n'), 'utf8');
console.log('bench.html 已生成（内联 app.js 第 ' + (start + 1) + '~' + end + ' 行，' + (end - start) + ' 行真实实现）');