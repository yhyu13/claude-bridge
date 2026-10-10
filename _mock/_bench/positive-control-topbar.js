#!/usr/bin/env node
'use strict';
/**
 * positive-control-topbar.js — 给 verify-topbar.js 做阳性对照。
 *
 * 和 positive-control.js 同一条纪律，但目标是 CSS：上一次模型名被挤到
 * 74px 时，页面横向溢出是 0、截图看起来正常、verify:quick 全绿。
 * 这道闸如果抓不住那个状态，它保护的就不是我想保护的东西。
 *
 * 两个探针：
 *   T1 把 kill 改回四个汉字（64px）  → 模型名应掉回 ~74px，闸转红
 *   T2 把 backend 改回 42%            → 模型名应缩水，闸转红
 *
 * 期望：两个探针都让闸**靠断言**转红，且还原后恢复绿。
 *
 * 用法: node _mock/_bench/positive-control-topbar.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const CSS = path.join(HERE, '..', '..', 'web', 'style.css');
const HTML = path.join(HERE, '..', '..', 'web', 'index.html');
const css0 = fs.readFileSync(CSS, 'utf8');
const html0 = fs.readFileSync(HTML, 'utf8');

const PROBES = [
  {
    tag: 'T1 kill 改回四个汉字',
    why: '这是出问题时的真实状态：kill 64px 挤掉模型名，页面溢出仍是 0',
    file: CSS,
    // 锚点用单行、不含换行：web/ 下是 CRLF，跨行锚点在 Windows 上
    // 永远不匹配 —— 第一版探针就是这么静默跳过的（提示「[跳过]」），
    // 而跳过被算成「通过」，两个探针于是都显示「没拦住」。
    // 一条没跑的探针比一条失败的探针更危险：它假装自己验证过了。
    from: /width: 36px; padding: 4px 0;/,
    to: 'width: auto; padding: 3px 8px;',
    alsoCss2: [/font-size: 16px; line-height: 1; cursor: pointer;/, 'font-size: 11px; cursor: pointer;'],
    alsoCss3: [/display: flex; align-items: center; justify-content: center;/, 'display: inline-block;'],
    alsoHtml: { from: '>■</button>', to: '>紧急停止</button>' },
  },
  {
    tag: 'T2 backend 改回 42%',
    why: '后端标签吃掉的宽度正是模型名的宽度',
    file: CSS,
    from: /text-overflow: ellipsis; max-width: 28%;/,
    to: 'text-overflow: ellipsis; max-width: 42%;',
  },
];

function rebuildScene() {
  execFileSync(process.execPath, [path.join(HERE, 'build-scene.js'), 'long'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function runGate() {
  try {
    rebuildScene();
    const out = execFileSync(process.execPath, [path.join(HERE, 'verify-topbar.js')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    const asserts = (out.match(/\[FAIL\]/g) || []).length;
    const crashed = /ReferenceError|TypeError|SyntaxError/.test(out);
    return { ok: false, out, asserts, crashed };
  }
}

function restore() {
  fs.writeFileSync(CSS, css0, 'utf8');
  fs.writeFileSync(HTML, html0, 'utf8');
  rebuildScene();
}

const results = [];
try {
  const base = runGate();
  console.log('基线（当前代码）: ' + (base.ok ? '[PASS] 闸是绿的 ✓' : '[FAIL] 闸本来就是红的 ✗'));
  results.push({ tag: '基线', ok: base.ok });
  if (!base.ok) {
    console.log(base.out.split('\n').slice(-15).join('\n'));
    console.log('\n闸在干净代码上就不通过，先修闸。');
    process.exit(1);
  }

  for (const p of PROBES) {
    if (!p.from.test(css0)) {
      // 锚点找不到必须算失败，不能算跳过。第一版把它算成跳过，
      // 跳过的探针又不进失败列表，于是「两个探针都没拦住」被报成
      // 「闸不灵」—— 真正的错误其实在探针自己身上。
      console.log('\n[探针失效] ' + p.tag + ' —— 锚点找不到（CSS 已改），必须更新探针');
      results.push({ tag: p.tag, ok: false, skipped: true });
      continue;
    }
    let broken = css0.replace(p.from, p.to);
    if (p.alsoCss2) broken = broken.replace(p.alsoCss2[0], p.alsoCss2[1]);
    if (p.alsoCss3) broken = broken.replace(p.alsoCss3[0], p.alsoCss3[1]);
    fs.writeFileSync(p.file, broken, 'utf8');
    if (p.alsoHtml) {
      fs.writeFileSync(HTML, html0.replace(p.alsoHtml.from, p.alsoHtml.to), 'utf8');
    }
    const r = runGate();
    restore();
    const byAssert = !r.ok && r.asserts > 0 && !r.crashed;
    results.push({ tag: p.tag, ok: byAssert });
    console.log('\n' + p.tag);
    console.log('  目的：' + p.why);
    console.log('  转红靠断言：' + (r.asserts ? r.asserts + ' 条 [FAIL]' : '无') +
      '   被测脚本异常：' + (r.crashed ? '有' : '无'));
    console.log('  判定：' + (byAssert ? '[真对照 ✓] 闸确实在保护这条'
      : !r.ok ? '[假对照 ✗] 红是崩溃，不是断言' : '[没拦住 ✗] 闸仍然绿'));
    const head = r.out.split('\n').filter((x) => x.trim() && !x.includes('[FAIL]')).slice(0, 3);
    for (const l of r.out.split('\n').filter((x) => x.includes('[FAIL]')).slice(0, 2)) {
      console.log('    ' + l.trim());
    }
    if (!byAssert && r.ok) for (const l of head) console.log('    ' + l.trim());
  }
} finally {
  restore();
}

const after = runGate();
console.log('\n收尾（已还原）: ' + (after.ok ? '[PASS] 恢复绿色 ✓' : '[FAIL] 还原失败 ✗'));
results.push({ tag: '收尾', ok: after.ok });

const real = results.filter((r) => !r.skipped || r.ok === false);
const bad = real.filter((r) => !r.ok);
console.log('\n' + (bad.length
  ? '[FAIL] 不符合预期：' + bad.map((r) => r.tag).join('、')
  : '[PASS] 全部 ' + real.length + ' 项符合预期'));
process.exit(bad.length ? 1 : 0);