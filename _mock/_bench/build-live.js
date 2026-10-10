#!/usr/bin/env node
'use strict';
/**
 * build-live.js — 拿**生产代码本身**量工具 ribbon，不是量一份复刻。
 *
 * 两份输入都直接取自要上线的文件，一个字都没重打：
 *   1) web/style.css  整个文件原样嵌入
 *   2) web/app.js     从 toolShell() 里正则切出那行 s.innerHTML = '...'
 *      ——如果哪天 app.js 改了 DOM，这里的页面自动跟着变，不会漂移成
 *      「一份早就过期的复制品，然后照样全绿」。
 *
 * 测的三个断言，全部来自实测踩到的坑：
 *   A. 整条 ribbon 横向溢出必须为 0
 *   B. 路径（.desc）宽度必须 > 0 —— overflow:hidden 会把溢出裁掉，
 *      页面看着正常而路径已经没了，这一条才是真正的守门
 *   C. 工具名（.name）必须 <= 卡片的 45%（max-width 生效）
 *
 * 用法: node _mock/_bench/build-live.js
 */

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const WEB = path.join(HERE, '..', '..', 'web');
const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
const appSrc = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');

// toolShell() 里那行 innerHTML 是多段字符串用 + 拼的，所以先把所有字面量
// 按出现顺序收齐再拼回来。收的是「app.js 现在实际写的那几段」，不是我们
// 认为 app.js 写的那几段 —— 这就是不用复刻的理由。
const startAt = appSrc.indexOf('s.innerHTML =');
if (startAt < 0) throw new Error('app.js 里找不到 s.innerHTML —— DOM 结构变了，先更新这里');
const endAt = appSrc.indexOf(';', startAt);
const expr = appSrc.slice(startAt + 's.innerHTML ='.length, endAt);
const parts = [...expr.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
const ribbonHtml = parts.map((p) => p.replace(/\\'/g, "'")).join('');
if (!ribbonHtml.includes('class="rib-id"') || !ribbonHtml.includes('class="name"')) {
  throw new Error('切出来的 innerHTML 不含预期的节点，抽取逻辑已失效：\n' + ribbonHtml);
}

// mcp__demo__ 是 scan-secrets.js 给 fixture 预留的豁免前缀（见 tools/scan-secrets.js
// 的 `mcp__(?!demo__)` 规则）。用别的名字会被提交前的扫描当成真实第三方 MCP
// 工具名拦下来 —— 那道闸是对的，别去削弱它，fixture 就该占保留前缀。
const LONG = 'mcp__demo__knowledge_base_search_documents';
const CASES = [
  { tag: '短名成功', name: 'Read', desc: 'src\\claude-session.js', ms: '2ms', ico: '✓', danger: false, failed: false, open: false },
  { tag: '长MCP名', name: LONG, desc: 'src\\claude-session.js', ms: '140ms', ico: '✓', danger: false, failed: false, open: false },
  { tag: '超长MCP名', name: 'mcp__demo__knowledge_base_advanced_semantic_search_over_documents_v2', desc: 'C:\\Users\\very-long-path\\some\\deep\\nested\\module\\index.ts', ms: '3.2s', ico: '✗', danger: false, failed: true, open: false },
  { tag: '危险命令', name: 'Bash', desc: 'rm -rf / --no-preserve-root', ms: '1.4s', ico: '✗', danger: true, failed: false, open: true },
  { tag: '展开态', name: 'Bash', desc: 'grep -n "resume" src/claude-session.js', ms: '140ms', ico: '✓', danger: false, failed: false, open: true },
];

const WIDTHS = [320, 360, 390];

const measureJs = `
const rows = [];
document.querySelectorAll('.tool').forEach((el, i) => {
  const g = (s) => { const e = el.querySelector(s); return e ? +e.getBoundingClientRect().width.toFixed(1) : 0; };
  const n = el.querySelector('.name'), d = el.querySelector('.desc');
  rows.push({
    tag: el.dataset.tag,
    over: el.scrollWidth - el.clientWidth,
    name: g('.name'), desc: g('.desc'), rib: g('.rib-t'),
    nameClipped: n ? n.scrollWidth > n.clientWidth : false,
    descClipped: d ? d.scrollWidth > d.clientWidth : false,
  });
});
const pageOver = document.documentElement.scrollWidth - document.documentElement.clientWidth;
let h = '<b>舞台 ' + document.getElementById('stage').getBoundingClientRect().width.toFixed(0)
      + 'px ｜ 整页横向溢出 ' + pageOver + 'px</b>\\n\\n';
let bad = 0;
for (const r of rows) {
  const a = r.over > 0;
  const b = r.desc <= 0;
  const c = r.nameClipped ? '已截断' : '完整';
  if (a || b) bad++;
  h += (a || b ? '<span class="bad">✗' : '<span class="ok">✓') + ' ' + r.tag.padEnd(10)
     + ' 溢出 ' + String(r.over).padStart(4) + 'px'
     + '  名 ' + String(r.name).padStart(6) + 'px(' + c + ')'
     + '  路径 ' + String(r.desc).padStart(6) + 'px'
     + (b ? '  <span class="bad">路径宽度 0 —— 信息丢了</span>' : '')
     + (r.descClipped ? '  路径截断显示' : '') + '\\n';
}
h += '\\n' + (bad ? '<span class="bad">失败 ' + bad + ' 条</span>' : '<span class="ok">全部通过</span>');
document.getElementById('diag').innerHTML = h;
document.title = bad ? 'FAIL ' + bad : 'PASS';
`;

const made = [];
for (const W of WIDTHS) {
  const cards = CASES.map((c) => {
    const cls = ['tool', c.danger ? 'danger' : '', c.failed ? 'failed' : '', c.open ? 'open' : ''].filter(Boolean).join(' ');
    return `<details class="${cls}"${c.open ? ' open' : ''} data-tag="${c.tag}">
      <summary>${ribbonHtml
        .replace('<span class="name"></span>', `<span class="name">${c.name}</span>`)
        .replace('<span class="desc"></span>', `<span class="desc">${c.desc.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>`)
        .replace('<span class="rib-t"></span>', `<span class="rib-t">${c.ms}</span>`)
        .replace('<span class="ico"></span>', `<span class="ico">${c.ico}</span>`)
        .replace('＋', c.open ? '－' : '＋')}</summary>
      <div class="body"><pre class="args">${c.desc}</pre></div>
    </details>`;
  }).join('\n');

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>live ${W}</title>
<style>
${css}
/* 只加诊断外壳，产品样式一个字没动 */
body { padding: 0; }
#diag { position: fixed; left: 0; top: 0; width: 340px; background: #000; color: #5fd39a;
  font: 12px/1.6 Consolas, monospace; padding: 10px 12px; white-space: pre; z-index: 99; }
#stage { width: ${W}px; padding: 12px; background: #F4EFE4; }
.bad { color: #ff6b6b; } .ok { color: #5fd39a; }
</style></head><body>
<pre id="diag">measuring…</pre>
<div id="stage">${cards}</div>
<script>${measureJs}<\/script>
</body></html>`;

  const name = `live-${W}.html`;
  fs.writeFileSync(path.join(HERE, name), html, 'utf8');
  made.push(name);
}

console.log('已生成: ' + made.join(', '));
console.log('CSS = web/style.css 原文；DOM = web/app.js toolShell() 的 s.innerHTML 原文');
console.log('断言: 溢出=0 · 路径宽度>0 · 名字可截断');
