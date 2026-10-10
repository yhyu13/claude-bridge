#!/usr/bin/env node
'use strict';
/**
 * shot.js — 用 CDP 精确控制 viewport 宽度截图 + 量真实布局。
 *
 * 为什么不用 `--window-size`：实测这台机器上 Edge 154 把它当**最小宽度**
 * 处理 —— 传 390 实际拿到 viewport 496，传 320 才真的给 320（而且还是
 * 因为内容把窗口撑开了，不可靠）。后果很具体：截图里"右边被裁了"，
 * 一眼看着像页面横向溢出，用 probe 量却是 0px，**两个都像是真的**。
 * 于是我差点拿一个不存在的溢出问题去做优化。
 *
 * CDP 的 Emulation.setDeviceMetricsOverride 是唯一能让 viewport 宽度
 * 等于我说的那个数字的办法，走完还能顺手把 getBoundingClientRect 的
 * 真值一起取回来。
 *
 * 用法:
 *   node _mock/_bench/shot.js <url> <out.png> [width] [height] [fullPage]
 *
 * 例子:
 *   node _mock/_bench/shot.js file:///.../scene-long.html out.png 390 844
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = path.join(__dirname, 'ep-cdp');

const url = process.argv[2];
const out = path.resolve(process.argv[3] || path.join(__dirname, 'shot.png'));
const W = Number(process.argv[4] || 390);
const H = Number(process.argv[5] || 844);
const FULL = process.argv[6] === 'full';
const PORT = 9333 + (process.pid % 200);

if (!url) {
  console.error('用法: node shot.js <url> <out.png> [width] [height] [full]');
  process.exit(2);
}

function get(urlPath) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: urlPath }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => res(b));
    }).on('error', rej);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const proc = spawn(EDGE, [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    'about:blank',
  ], { stdio: 'ignore' });

  // 等 DevTools 端口起来
  let ws = null;
  for (let i = 0; i < 60; i++) {
    try {
      const v = JSON.parse(await get('/json/version'));
      ws = v.webSocketDebuggerUrl;
      break;
    } catch { await sleep(250); }
  }
  if (!ws) { proc.kill(); console.error('DevTools 端口没起来'); process.exit(1); }

  const WebSocket = await loadWs();
  const sock = new WebSocket(ws, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((r, j) => { sock.on('open', r); sock.on('error', j); });

  let id = 0;
  const waiters = new Map();
  sock.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.id && waiters.has(m.id)) {
      const { res, rej } = waiters.get(m.id);
      waiters.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });
  const send = (method, params, sessionId) => new Promise((res, rej) => {
    const mid = ++id;
    waiters.set(mid, { res, rej });
    sock.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId }));
  });

  // 开一个新 target 并 attach
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);

  await S('Page.enable');
  await S('Runtime.enable');
  await S('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: true,
  });

  // 在任何页面脚本之前挂上错误收集。
  await S('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__benchErrors = [];
      window.addEventListener('error', (e) => {
        window.__benchErrors.push((e.message || '') + ' @ ' + (e.filename||'') + ':' + (e.lineno||0)
          + (e.error && e.error.stack ? '\\n' + String(e.error.stack).split('\\n').slice(0,3).join('\\n') : ''));
      });
      window.addEventListener('unhandledrejection', (e) => {
        window.__benchErrors.push('unhandled rejection: ' + String(e.reason && e.reason.stack || e.reason));
      });`,
  });

  await S('Page.navigate', { url });
  // 等 load + 场景脚本跑完（fixture 驱动器最长约 1.2s）
  await sleep(2600);

  // 页面脚本可能整段挂掉（bench 就是这样），先把 console 错误捞出来。
  // 「页面看起来空着」有两种：脚本没跑，或者跑挂了在 try 里。分不开的
  // 时候只能看到一片空白 —— 这正是上一轮 bench 只剩「running…」的原因。
  const errs = await S('Runtime.evaluate', {
    expression: `JSON.stringify(window.__benchErrors || [])`,
    returnByValue: true,
  });
  const benchErrors = JSON.parse(errs.result.value || '[]');
  if (benchErrors.length) {
    console.log('页面脚本报错：');
    for (const e of benchErrors.slice(0, 8)) console.log('  ' + e);
    console.log('');
  }

  // ---- 量真值 ----
  const probe = `(() => {
    const de = document.documentElement;
    const r = (s) => { const e = document.querySelector(s); if (!e) return null;
      const b = e.getBoundingClientRect();
      return { w: +b.width.toFixed(1), l: +b.left.toFixed(1), r: +b.right.toFixed(1),
               over: e.scrollWidth - e.clientWidth, txt: (e.textContent||'').slice(0,24) }; };
    const row1 = document.querySelector('#bar .row1');
    const kids = row1 ? [...row1.children].map((c) => ({
      cls: c.className || c.id, w: +c.getBoundingClientRect().width.toFixed(1),
      txt: (c.textContent||'').replace(/\\s+/g,' ').slice(0,18),
      clipped: c.scrollWidth - c.clientWidth,
    })) : [];
    const mb = document.querySelector('.modelbtn');
    const mbKids = mb ? [...mb.children].map((c) => ({
      cls: c.className, w: +c.getBoundingClientRect().width.toFixed(1),
      txt: (c.textContent||'').replace(/\\s+/g,' ').slice(0,20),
      clipped: c.scrollWidth - c.clientWidth,
    })) : [];
    return JSON.stringify({
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      docClient: de.clientWidth, docScroll: de.scrollWidth,
      pageOver: de.scrollWidth - de.clientWidth,
      title: document.title,
      nodes: document.getElementsByTagName('*').length,
      row1Kids: kids, modelbtnKids: mbKids,
      kill: r('#kill'), model: r('.model'), cwd: r('.cwd'),
      bubble: r('.msg.user .bubble'), text: r('.msg.bot .text'),
      tool: r('.tool'), desc: r('.tool .desc'), name: r('.tool .name'),
      ribt: r('.tool .rib-t'), pre: r('.msg.bot .text pre'),
      composer: r('#composer'), bar: r('#bar'),
    });
  })()`;
  const got = await S('Runtime.evaluate', { expression: probe, returnByValue: true });
  const info = JSON.parse(got.result.value);

  // --text <选择器>：把元素文本读回终端。截图只能给人看，数字要能复制，
  // 而且长文本截图会被截断 —— bench 的结论只存在于 #out 里。
  const textArg = process.argv.find((a) => a.startsWith('--text='));
  if (textArg) {
    const sel = textArg.slice('--text='.length);
    const r2 = await S('Runtime.evaluate', {
      expression: `(document.querySelector(${JSON.stringify(sel)})||{}).innerText || '(没有这个元素)'`,
      returnByValue: true,
    });
    process.stdout.write('\n' + (r2.result.value || '') + '\n');
  }

  // ---- 截图 ----
  const shotParams = { format: 'png' };
  if (FULL) {
    const m = await S('Page.getLayoutMetrics');
    const cs = m.cssContentSize || m.contentSize;
    shotParams.captureBeyondViewport = true;
    shotParams.clip = { x: 0, y: 0, width: cs.width, height: cs.height, scale: 1 };
  }
  const img = await S('Page.captureScreenshot', shotParams);
  fs.writeFileSync(out, Buffer.from(img.data, 'base64'));

  sock.close();
  proc.kill();

  // ---- 报告 ----
  const L = [];
  L.push('viewport  ' + info.innerWidth + ' x ' + info.innerHeight + '   页面横向溢出 ' + info.pageOver + 'px   DOM ' + info.nodes + ' 节点');
  L.push('');
  L.push('#bar .row1 的子项（谁在抢空间）:');
  for (const k of info.row1Kids) {
    L.push('  ' + k.cls.padEnd(12) + ' w=' + String(k.w).padStart(7) + '  裁掉=' + String(k.clipped).padStart(4) +
      'px  "' + k.txt + '"' + (k.w <= 0.5 ? '   ← 归零' : ''));
  }
  L.push('.modelbtn 的子项:');
  for (const k of info.modelbtnKids) {
    L.push('  ' + k.cls.padEnd(12) + ' w=' + String(k.w).padStart(7) + '  裁掉=' + String(k.clipped).padStart(4) +
      'px  "' + k.txt + '"' + (k.w <= 0.5 ? '   ← 归零' : ''));
  }
  L.push('');
  const order = ['kill', 'model', 'cwd', 'ribt', 'name', 'desc', 'tool', 'text', 'bubble', 'pre', 'composer', 'bar'];
  for (const k of order) {
    const v = info[k];
    if (!v) continue;
    L.push('  ' + k.padEnd(9) + ' w=' + String(v.w).padStart(7) + ' left=' + String(v.l).padStart(7) +
           ' right=' + String(v.r).padStart(7) + (v.w <= 0.5 ? '   ← 宽度 0' : '') +
           (v.r > info.innerWidth + 0.5 ? '   ← 超出右界' : ''));
  }
  console.log(L.join('\n'));
  console.log('→ ' + out + '  (' + (fs.statSync(out).size / 1024).toFixed(1) + ' KB)');
  process.exit(0);
})().catch((e) => {
  console.error('失败: ' + e.message);
  process.exit(1);
});

// 极简 WebSocket 客户端（Node 20+ 没有内置 client，避免引依赖）
async function loadWs() {
  try { return require('ws'); } catch { /* 继续 */ }
  const src = fs.readFileSync(path.join(__dirname, 'tinyws.js'), 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', src)(mod, mod.exports, require);
  return mod.exports;
}