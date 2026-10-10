#!/usr/bin/env node
'use strict';
/**
 * probe-bar.js — 定位顶栏模型名归零的确切原因，并用阳性对照确认修法有效。
 *
 * 为什么要单独写：shot.js 量到「modelbtn 有 210px，model 却只有 0px」。
 * 这两件事同时成立，说明**不是空间不够**，而是某条 flex 规则让子项的
 * 基准宽算成了 0。空间够而宽度为 0，和空间不够导致截断，是两个不同的
 * 病，修法完全不同 —— 猜错就会改成「把 modelbtn 拉宽」，那正是现在
 * 已经有的 flex:1，一点用没有。
 *
 * 方法：逐条改候选属性，每改一次量一次。同一份页面、同一批元素，
 * 只有被点名的那条规则不同 —— 这就是阳性对照。
 *
 * 用法: node _mock/_bench/probe-bar.js <scene.html> [width]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = path.join(__dirname, 'ep-cdp');
const PORT = 9555 + (process.pid % 200);

const scene = path.resolve(process.argv[2] || path.join(__dirname, 'scene-long.html'));
const W = Number(process.argv[3] || 390);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VARIANTS = [
  { tag: '现状', css: '' },
  { tag: 'modelbtn 加 min-width:0', css: '.modelbtn{min-width:0}' },
  { tag: 'backend 收窄到 34%', css: '.backend{max-width:34%}' },
  { tag: 'link 限宽 40%', css: '.link{max-width:40%;overflow:hidden;text-overflow:ellipsis}' },
  // kill 从「紧急停止」四字改成符号：省下的宽度给模型名。
  // 危险动作不能因为变小就变轻 —— 红色边框和红字都保留，只是形态变紧凑。
  { tag: 'kill 改 ■ 符号', css: '.kill{width:36px;padding:3px 0;font-size:0}.kill::after{content:"\\25A0";font-size:16px;line-height:1}' },
  { tag: 'kill ■ + backend 34%', css: '.kill{width:36px;padding:3px 0;font-size:0}.kill::after{content:"\\25A0";font-size:16px;line-height:1}.backend{max-width:34%}' },
  { tag: 'kill ■ + backend 28%', css: '.kill{width:36px;padding:3px 0;font-size:0}.kill::after{content:"\\25A0";font-size:16px;line-height:1}.backend{max-width:28%}' },
  { tag: 'kill ■ + bk 28% + link 40%', css: '.kill{width:36px;padding:3px 0;font-size:0}.kill::after{content:"\\25A0";font-size:16px;line-height:1}.backend{max-width:28%}.link{max-width:40%;overflow:hidden;text-overflow:ellipsis}' },
  // 备选：模型名整体可截断但至少给一个下限宽度，避免短名被挤没
  { tag: 'model 给 min-width 40px', css: '.model{min-width:40px}' },
  { tag: '全组合', css: '.kill{width:36px;padding:3px 0;font-size:0}.kill::after{content:"\\25A0";font-size:16px;line-height:1}.backend{max-width:28%}.model{min-width:44px}.link{max-width:38%;overflow:hidden;text-overflow:ellipsis}' },
];

function get(u) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: u }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res(b));
    }).on('error', rej);
  });
}

(async () => {
  const proc = spawn(EDGE, ['--headless', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try { wsUrl = JSON.parse(await get('/json/version')).webSocketDebuggerUrl; }
    catch { await sleep(250); }
  }
  if (!wsUrl) { proc.kill(); console.error('DevTools 没起来'); process.exit(1); }

  const WS = require('./tinyws.js');
  const sock = new WS(wsUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((r, j) => { sock.on('open', r); sock.on('error', j); });

  let id = 0;
  const waiters = new Map();
  sock.on('message', (d) => {
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    if (m.id && waiters.has(m.id)) {
      const { res, rej } = waiters.get(m.id); waiters.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });
  const send = (method, params, sessionId) => new Promise((res, rej) => {
    const mid = ++id; waiters.set(mid, { res, rej });
    sock.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable'); await S('Runtime.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: W, height: 844, deviceScaleFactor: 1, mobile: true });

  const MEASURE = `(() => {
    const g = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect().width : -1; };
    const link = document.querySelector('.link'), mb = document.querySelector('.modelbtn');
    const sum = [...mb.children].reduce((a,c)=>a+c.getBoundingClientRect().width,0);
    const el = document.querySelector('.model');
    return JSON.stringify({
      link: +g('.link').toFixed(1), mb: +g('.modelbtn').toFixed(1),
      model: +g('.model').toFixed(1), backend: +g('.backend').toFixed(1),
      kill: +g('.kill').toFixed(1),
      modelScroll: el ? el.scrollWidth : -1,
      modelText: el ? el.textContent : '',
      used: +sum.toFixed(1), slack: +(g('.modelbtn') - sum).toFixed(1),
    });
  })()`;

  const url = 'file:///' + scene.replace(/\\/g, '/');
  const rows = [];
  for (const v of VARIANTS) {
    await S('Page.navigate', { url: 'about:blank' });
    await sleep(120);
    await S('Page.navigate', { url });
    await sleep(2400);
    // 清掉内联的 probe 条，别让它干扰视觉
    await S('Runtime.evaluate', { expression: `document.getElementById('probe')?.remove()` });
    if (v.css) {
      await S('Runtime.evaluate', {
        expression: `(() => { const s=document.createElement('style'); s.id='v'; s.textContent=${JSON.stringify(v.css)}; document.head.appendChild(s); })()`,
      });
      await sleep(160);
    }
    const r = await S('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
    const m = JSON.parse(r.result.value);
    await S('Runtime.evaluate', { expression: `document.getElementById('v')?.remove()` });
    rows.push({ tag: v.tag, ...m });
  }

  sock.close(); proc.kill();

  console.log('viewport ' + W + 'px  —— 顶栏模型名的宽度与可用余量\n');
  console.log('  ' + '变体'.padEnd(30) + 'link'.padStart(7) + 'modelbtn'.padStart(11) +
    'model'.padStart(8) + 'backend'.padStart(9) + 'kill'.padStart(7) + '  model 文案');
  console.log('  ' + '-'.repeat(96));
  for (const r of rows) {
    const bad = r.model <= 0.5;
    console.log('  ' + (bad ? '✗ ' : '✓ ') + r.tag.padEnd(28) +
      String(r.link).padStart(7) + String(r.mb).padStart(11) +
      String(r.model).padStart(8) + String(r.backend).padStart(9) +
      String(r.kill).padStart(7) + '  ' + (r.modelText || '(空)').slice(0, 22) +
      ' ' + (bad ? '← 归零' : ''));
  }
  const fixed = rows.filter((r) => r.model > 0.5);
  console.log('\n  modelbtn 内部余量(slack)：' + rows.map((r) => r.slack).join(' / '));
  console.log('  有效变体：' + (fixed.length ? fixed.map((r) => r.tag).join('、') : '一个都没有'));
  process.exit(0);
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });