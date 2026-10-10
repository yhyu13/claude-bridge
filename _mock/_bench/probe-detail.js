#!/usr/bin/env node
'use strict';
/**
 * probe-detail.js — 只跑一个探针，并把闸的全部输出打出来。
 * 用来查「转红是靠断言还是靠页面崩」——
 * P2 报了转红却没打印任何 [FAIL] 行，怀疑它是脚本异常退出，
 * 也就是「闸崩了」而不是「闸拦住了」。这两种红完全不是一回事。
 *
 * 用法: node _mock/_bench/probe-detail.js P2
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const APP = path.join(HERE, '..', '..', 'web', 'app.js');
const original = fs.readFileSync(APP, 'utf8');

const ALL = {
  P1: {
    tag: 'splitBlocks 恒返回空',
    from: /function splitBlocks\(html\) \{[\s\S]*?\n\}/,
    to: `function splitBlocks(html) {
  void html;
  return [];
}`,
  },
  P2: {
    tag: '每个块套一层 div',
    from: /host\.replaceChild\(holder\.firstChild, cur\);/,
    to: `host.replaceChild(holder.firstChild, cur);
  { // PROBE
      for (const c of [...host.children]) {
        const w = document.createElement('div');
        w.appendChild(c);
        host.replaceChild(w, c);
      }
    }`,
  },
  P3: {
    tag: '只写最后一块',
    from: /if \(prev && prev\[i\] === blocks\[i\]\) continue;/,
    to: `if (prev && prev[i] === blocks[i]) continue;
    if (i < blocks.length - 1) continue;`,
  },
  P4: {
    tag: '回拼时丢一块',
    from: /return \[\.\.\.box\.children\]\.map\(\(c\) => c\.outerHTML\);/,
    to: `const cs = [...box.children].map((c) => c.outerHTML);
  return cs.length > 1 ? cs.slice(1) : cs;`,
  },
};

const key = (process.argv[2] || 'P1').toUpperCase();
const p = ALL[key];
if (!p) { console.error('没有探针 ' + key + '，可选: ' + Object.keys(ALL).join(', ')); process.exit(2); }

if (!p.from.test(original)) { console.error('锚点找不到，代码已变'); process.exit(2); }
fs.writeFileSync(APP, original.replace(p.from, p.to), 'utf8');

let out = '', code = 0;
try {
  out = execFileSync(process.execPath, [path.join(HERE, 'verify-incremental.js')],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  code = e.status === undefined ? -1 : e.status;
  out = String(e.stdout || '') + '\n[stderr]\n' + String(e.stderr || '');
} finally {
  fs.writeFileSync(APP, original, 'utf8');
}

console.log('探针 ' + key + '（' + p.tag + '）退出码 ' + code);
console.log('---- 闸的完整输出 ----');
console.log(out);
const nFail = (out.match(/\[FAIL\]/g) || []).length;
const crashed = /Invalid or unexpected token|ReferenceError|TypeError|SyntaxError/.test(out);
console.log('\n判定：');
console.log('  断言失败行数 ' + nFail + (nFail ? '  → 靠断言转红（真对照）' : '  → 没有断言失败'));
console.log('  ' + (crashed ? '出现脚本异常  → 同时有页面崩溃，红色可能来自崩而不是拦截'
  : '无脚本异常      → 红色只来自断言'));
fs.writeFileSync(APP, original, 'utf8');