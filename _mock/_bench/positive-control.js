#!/usr/bin/env node
'use strict';
/**
 * positive-control.js — 给 verify-incremental.js 做阳性对照。
 *
 * 为什么必须做：闸没验过就等于没写。这里的做法是**临时改坏生产代码、
 * 跑闸、看它是否转红、再改回来**，全部自动，每次几秒。
 *
 * 三个探针，覆盖三种「闸看起来绿但其实没在保护」的情形：
 *   P1 splitBlocks 恒返回空数组  → 第一版真实犯的错：报 17 倍提速，
 *                                  页面却是空白
 *   P2 每个块套一层 div        → 多出的 DOM 节点，且破坏 :first-child 规则
 *   P3 增量只写最后一块，其余不动 → 「已收尾的块不会被改写」被违反时的错误
 *
 * 每个探针的期望都是「闸转红」。如果某个探针之后闸还是绿的，
 * 说明那条断言是空的，必须补断言而不是改探针。
 *
 * 用法: node _mock/_bench/positive-control.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const APP = path.join(HERE, '..', '..', 'web', 'app.js');
const original = fs.readFileSync(APP, 'utf8');

const PROBES = [
  {
    tag: 'P1 splitBlocks 恒返回空',
    why: '第一版真实犯的错：提速数字漂亮，页面空白',
    from: /function splitBlocks\(html\) \{[\s\S]*?\n\}/,
    to: `function splitBlocks(html) {
  void html;
  return [];
}`,
  },
  {
    tag: 'P2 每个块套一层 div',
    why: '多出的 DOM 节点，且 .text > :first-child 规则失效',
    from: /const holder = document\.createElement\('div'\);\n    holder\.innerHTML = blocks\[i\];\n    host\.replaceChild\(holder\.firstChild, cur\);/,
    // 正确写法：先用宿主容器暂存，再替换。不能一边遍历一边改，
    // 那样 replaceChild 会因为节点已不是子节点而抛 NotFoundError ——
    // 闸会红，但红的原因是脚本崩了，不是断言拦住的。那种红不算对照。
    to: `const holder = document.createElement('div');
    holder.innerHTML = blocks[i];
    host.replaceChild(holder.firstChild, cur);
  { // PROBE: 给每块套一层 div
      const kids = [...host.children];
      for (const c of kids) {
        const w = document.createElement('div');
        host.replaceChild(w, c);
        w.appendChild(c);
      }
    }`,
  },
  {
    tag: 'P3 只写最后一块',
    why: '违反「已收尾的块不会被改写」时的错误路径',
    from: /if \(prev && prev\[i\] === blocks\[i\]\) continue;/,
    to: `if (prev && prev[i] === blocks[i]) continue;
    if (i < blocks.length - 1) continue;   // PROBE: 跳过除最后一块外的更新`,
  },
  {
    tag: 'P4 回拼时丢一个块',
    why: 'splitBlocks 少切一块，工具函数层就不自洽',
    from: /return \[\.\.\.box\.children\]\.map\(\(c\) => c\.outerHTML\);/,
    to: `const cs = [...box.children].map((c) => c.outerHTML);
  return cs.length > 1 ? cs.slice(1) : cs;   // PROBE: 吞掉第一块`,
  },
];

function runGate() {
  try {
    const out = execFileSync(process.execPath, [path.join(HERE, 'verify-incremental.js')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out, crashed: false, asserts: (out.match(/\[FAIL\]/g) || []).length };
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    const asserts = (out.match(/\[FAIL\]/g) || []).length;
    const crashed = /Invalid or unexpected token|ReferenceError|TypeError|SyntaxError|NotFoundError/.test(out);
    return { ok: false, out, crashed, asserts };
  }
}

function restore() { fs.writeFileSync(APP, original, 'utf8'); }

const results = [];
try {
  // 基线：未改坏时闸必须是绿的，否则后面全无意义
  const base = runGate();
  console.log('基线（未改坏）: ' + (base.ok ? '[PASS] 闸是绿的 ✓' : '[FAIL] 闸本来就是红的 ✗'));
  // 基线的期望是「绿」，探针的期望是「红」—— 两者判定相反。
  // 之前把探针的「转红」也按「期望绿」判，于是四个都正确转红却被报成失败。
  results.push({ kind: 'baseline', expectGreen: true, ok: base.ok, tag: '基线' });
  if (!base.ok) {
    console.log(base.out.split('\n').slice(-12).join('\n'));
    console.log('\n闸在干净代码上就不通过，先修闸，别做对照。');
    process.exit(1);
  }

  for (const p of PROBES) {
    if (!p.from.test(original)) {
      console.log('\n[跳过] ' + p.tag + ' —— 探针锚点在 app.js 里找不到（代码已变），先更新探针');
      results.push({ kind: 'probe', skipped: true, tag: p.tag });
      continue;
    }
    const broken = original.replace(p.from, p.to);
    fs.writeFileSync(APP, broken, 'utf8');
    const r = runGate();
    restore();
    // 探针的期望是「转红」，也就是 !ok —— 而且必须靠**断言**转红。
    //
    // 这里多了一道区分：P2 一开始报了转红，其实是被测脚本自己抛了
    // NotFoundError，断言根本没跑。那种红和拦截无关：把闸整个删掉，
    // 它照样会红。所以「红了」不等于「闸在保护」。
    const turnedRed = !r.ok;
    const byAssert = turnedRed && r.asserts > 0 && !r.crashed;
    results.push({ kind: 'probe', expectGreen: false, ok: byAssert, tag: p.tag });
    console.log('\n' + p.tag);
    console.log('  目的：' + p.why);
    console.log('  闸退出码：' + (turnedRed ? '非 0（红）' : '0（绿）'));
    console.log('  转红靠断言：' + (r.asserts ? r.asserts + ' 条 [FAIL]' : '无'));
    console.log('  被测脚本异常：' + (r.crashed ? '有（这种红不算拦截）' : '无'));
    console.log('  判定：' + (byAssert ? '[真对照 ✓] 闸确实在保护这条'
      : turnedRed ? '[假对照 ✗] 红是脚本崩溃，不是断言拦住的'
        : '[没拦住 ✗] 闸仍然绿，这条断言是空的'));
    if (byAssert) {
      for (const l of r.out.split('\n').filter((x) => x.includes('[FAIL]')).slice(0, 3)) {
        console.log('    ' + l.trim());
      }
    }
  }
} finally {
  restore();
}

// 收尾必须再验一次：整个过程结束时代码要回到原样且闸要绿
const after = runGate();
console.log('\n收尾（已还原）: ' + (after.ok ? '[PASS] 闸恢复绿色 ✓' : '[FAIL] 还原失败 ✗'));
results.push({ kind: 'baseline', expectGreen: true, ok: after.ok, tag: '收尾' });

const real = results.filter((r) => !r.skipped);
const bad = real.filter((r) => !r.ok);
console.log('\n' + (bad.length
  ? '[FAIL] ' + bad.length + ' 项不符合预期：' + bad.map((r) => r.tag).join('、')
  : '[PASS] 全部 ' + real.length + ' 项符合预期 —— 基线绿 / 收尾绿 / ' +
    results.filter((r) => r.kind === 'probe' && !r.skipped).length + ' 个探针全部让闸转红'));
process.exit(bad.length ? 1 : 0);