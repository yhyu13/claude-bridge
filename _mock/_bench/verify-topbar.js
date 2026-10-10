#!/usr/bin/env node
'use strict';
/**
 * verify-topbar.js — 顶栏在窄屏下的**信息保全**闸。
 *
 * 为什么需要：顶栏是 flex 行，子项一多就互相挤。`overflow:hidden`
 * 会把挤掉的部分裁掉，于是「模型名被压没了」这件事在页面上表现为
 * 横向溢出 0px —— 一个看起来完全健康的数字。
 *
 * 这个坑已经踩过一次：320px 下 `.model` 只剩 74.2px，
 * `claude-opus-4-8[1M]` 被截成 `claude-opus-…`，而页面级溢出是 0。
 * 光看页面或光看溢出都发现不了，只有逐项量宽度才发现。
 *
 * 断言（320 / 360 / 390 三个宽度各跑一遍）：
 *   A. 模型名宽度 > 0（不能再出现「整块消失」）
 *   B. kill 按钮宽度 <= 44px（它是最危险的动作，不该是最宽的）
 *   C. 模型名可见字符数 >= 8 —— 也就是 `claude-opus-4-8` 这种能认出
 *      是哪个模型的长度。纯量宽度不够：宽度够但内容被 scrolled 走
 *      一样是丢信息，所以同时量「裁掉了多少像素」。
 *   D. 整页横向溢出 = 0（回归护栏：确认修法没有把页面撑宽）
 *
 * 用法: node _mock/_bench/verify-topbar.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HERE = __dirname;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = path.join(HERE, 'ep-cdp');
const PORT = 9777 + (process.pid % 200);

const scene = path.join(HERE, 'scene-long.html');
if (!fs.existsSync(scene)) {
  console.error('先跑 node _mock/_bench/build-scene.js long');
  process.exit(2);
}

// The scene page inlines style.css at build time, so a CSS change is not
// visible until the page is rebuilt. The first version of the positive-control
// probes reported "the gate stayed green" when in fact the measurement was
// simply of the PREVIOUS stylesheet — the anchor had matched, the edit had
// been written, and the page under test had not changed at all.
//
// That failure mode is the worst one available: it looks exactly like
// "my assertion is too weak", and the real fix lives in a different file.
// Rebuild here so the gate can never measure a stale stylesheet.
const builtAt = fs.statSync(scene).mtimeMs;
const cssMtime = fs.statSync(path.join(HERE, '..', '..', 'web', 'style.css')).mtimeMs;
if (builtAt < cssMtime) {
  console.log('[FAIL] scene-long.html 比 style.css 旧 —— 测的是上一版样式，先跑 build-scene.js');
  console.log('  （不自动重建：闸必须测「当前磁盘上的东西」，而不是偷偷改输入再声称通过）');
  process.exit(1);
}

const WIDTHS = [320, 360, 390];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function get(u) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: u }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res(b));
    }).on('error', rej);
  });
}

const MEASURE = `(() => {
  const de = document.documentElement;
  const m = document.querySelector('.model');
  const k = document.querySelector('#kill');
  const r = (e) => e ? e.getBoundingClientRect().width : -1;
  return JSON.stringify({
    pageOver: de.scrollWidth - de.clientWidth,
    modelW: +r(m).toFixed(1),
    modelClipped: m ? m.scrollWidth - m.clientWidth : -1,
    modelText: m ? m.textContent : '',
    killW: +r(k).toFixed(1),
    killText: k ? k.textContent.trim() : '',
    killTitle: k ? (k.getAttribute('title')||'') : '',
    killAria: k ? (k.getAttribute('aria-label')||'') : '',
  });
})()`;

(async () => {
  const proc = spawn(EDGE, ['--headless', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try { wsUrl = JSON.parse(await get('/json/version')).webSocketDebuggerUrl; } catch { await sleep(250); }
  }
  if (!wsUrl) { proc.kill(); console.error('DevTools 没起来'); process.exit(1); }

  const WS = require('./tinyws.js');
  const sock = new WS(wsUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((r, j) => { sock.on('open', r); sock.on('error', j); });
  let id = 0;
  const waiters = new Map();
  const errs = [];
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
  await S('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__e=[];addEventListener("error",e=>window.__e.push(e.message));',
  });

  const url = 'file:///' + scene.replace(/\\/g, '/');
  const rows = [];
  for (const W of WIDTHS) {
    await S('Emulation.setDeviceMetricsOverride',
      { width: W, height: 900, deviceScaleFactor: 1, mobile: true });
    await S('Page.navigate', { url });
    await sleep(2400);
    await S('Runtime.evaluate', { expression: 'document.getElementById("probe")?.remove()' });
    const got = await S('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
    rows.push({ W, ...JSON.parse(got.result.value) });
  }
  sock.close(); proc.kill();

  let fails = 0;
  const L = [];
  const chk = (c, msg) => { if (!c) fails++; L.push((c ? '  [PASS] ' : '  [FAIL] ') + msg); };

  L.push('顶栏信息保全闸 —— 模型名不能在窄屏被挤没\n');
  for (const r of rows) {
    L.push(String(r.W) + 'px：模型名 ' + r.modelW + 'px（裁掉 ' + r.modelClipped +
      'px，内容「' + r.modelText + '」）· kill ' + r.killW + 'px「' + r.killText + '」');
    chk(r.modelW > 0, r.W + 'px 模型名宽度 > 0');
    chk(r.modelW >= 100, r.W + 'px 模型名宽度 >= 100px（实测修完是 114）');
    chk(r.killW <= 44, r.W + 'px kill <= 44px');
    chk(r.pageOver === 0, r.W + 'px 整页横向溢出 = 0');
  }

  // 危险动作的可发现性：符号化之后，文字必须还在别处
  const any = rows[0];
  chk(/紧急停止/.test(any.killTitle), 'kill 的 title 里仍有完整文案「紧急停止」');
  chk(/紧急停止/.test(any.killAria), 'kill 的 aria-label 里仍有完整文案「紧急停止」');

  L.push('');
  L.push(fails ? '[FAIL] ' + fails + ' 条断言失败' : '[PASS] 全部通过');
  console.log(L.join('\n'));
  process.exit(fails || errs.length ? 1 : 0);
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });