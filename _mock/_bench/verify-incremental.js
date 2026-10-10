#!/usr/bin/env node
'use strict';
/**
 * verify-incremental.js — 增量渲染的**正确性闸**（不是性能闸）。
 *
 * 这道闸存在的理由：增量渲染的速度数字（实测 17 倍）漂亮到不需要解释，
 * 但第一版 splitBlocks 切出 0 块 —— 等于什么都没渲染，页面会是空白的，
 * 而所有性能指标都在变好。
 *
 *   快的和对的必须分开验证。提速倍数本身也要先证明它真的在干活。
 *
 * 三组断言，任何一条不成立就不许落地：
 *   1. splitBlocks 切出的块数 > 0（它真的在干活）
 *   2. 块拼回去 === 原 HTML（没切漏、没多切）
 *   3. 增量路径产出的 DOM 与「一次性全量渲染」**逐节点同构**
 *      —— 同样的标签树、同样的文本。这是唯一能证明增量没偷懒的断言，
 *      因为前两条只验工具函数，第三条验的是真正上线的那条渲染路径。
 *
 * 第 3 条能抓到什么：一个只更新最后一块的实现，如果假设「已收尾的块不会
 * 被回头改写」在某类流上不成立（比如先写文字、下一块才出现列表标记），
 * 产出的 DOM 会和全量不同 —— 而这个差异在人眼上几乎看不出来。
 *
 * 用法: node _mock/_bench/verify-incremental.js   （退出码非 0 = 失败）
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HERE = __dirname;
const WEB = path.join(HERE, '..', '..', 'web');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = path.join(HERE, 'ep-cdp');
const PORT = 9666 + (process.pid % 200);

const lines = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8').split(/\r?\n/);

function sliceRange(fromRe, toRe, what) {
  const start = lines.findIndex((l) => fromRe.test(l));
  if (start < 0) throw new Error(what + '：起点没找到 ' + fromRe);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) if (toRe.test(lines[i])) { end = i; break; }
  if (end < 0) throw new Error(what + '：终点没找到 ' + toRe);
  return lines.slice(start, end).join('\n');
}

const mdCode = sliceRange(/^function esc\(s\)/, /^\/\/ ---- /, 'markdown 段');
if (!/function mdToHtml/.test(mdCode)) throw new Error('markdown 段里没有 mdToHtml');
// 增量那几行直接从 web/app.js 切，证明验的是上线的那份，不是复制品。
// 定位用函数签名而不是注释文本 —— 注释会被改写，签名不会。
const incCode = sliceRange(
  /^function splitBlocks\(/,
  /^function flushRender\(/,
  '增量段',
);
for (const must of ['function splitBlocks(', 'function paintReplyInto(']) {
  if (!incCode.includes(must)) throw new Error('增量段里缺 ' + must);
}

// 反引号在拼接进 HTML 时是雷：page 模板里所有 ``` 都要转义。
// 用 JSON.stringify 传字符串进页面，比在模板里手写反引号安全得多。
const CASES = [
  ['一个段落', 'hello'],
  ['三个段落', 'a\n\nb\n\nc'],
  ['标题加段落', '# T\n\nbody'],
  ['无序列表', '- a\n- b\n- c'],
  ['有序列表', '1. a\n2. b'],
  ['代码块', '```js\ncode here\n```'],
  ['引用', '> quoted'],
  ['分隔线', 'a\n\n---\n\nb'],
  ['混合', '# H\n\n- x\n- y\n\n```\ncode\n```\n\ntail'],
  ['强调与行内代码', 'a **bold** and `inline` end'],
  ['嵌套列表', '- top\n  - inner\n- top2'],
  ['未闭合代码块（流式中）', '```js\nstill going'],
];

const STREAM = [
  '先说一句。', '', '## 第一节', '', '- 列表一', '- 列表二', '',
  '```js', 'const a = 1;', '```', '', '> 引用一句', '',
  '结尾有 **粗体** 和 `inline`。',
].join('\n');

const payload = JSON.stringify({ cases: CASES, stream: STREAM });

const page = '<!doctype html><html><head><meta charset="utf-8"><title>verify-inc</title></head><body>\n'
  + '<pre id="out" style="background:#000;color:#5fd39a;font:12px/1.6 Consolas,monospace;padding:14px;white-space:pre-wrap"></pre>\n'
  + '<div id="host"></div>\n'
  + '<script>\n'
  + mdCode + '\n\n'
  + incCode + '\n\n'
  + 'const DATA = ' + payload + ';\n'
  + 'const out = document.getElementById("out"), host = document.getElementById("host");\n'
  + 'const L = []; let fails = 0;\n'
  + 'const ok = (c, m) => { if (!c) fails++; L.push((c ? "  [PASS] " : "  [FAIL] ") + m); };\n'
  + 'function shape(n){ let s=n.nodeName; for(const c of n.children) s+="["+shape(c)+"]";'
  + ' if(!n.children.length) s+="{"+n.textContent+"}"; return s; }\n'
  + '\n'
  + 'L.push("1. splitBlocks 真的在干活（块数>0，且回拼等于原 HTML）");\n'
  + 'for (const [tag, raw] of DATA.cases) {\n'
  + '  const html = mdToHtml(raw);\n'
  + '  const blocks = splitBlocks(html);\n'
  + '  ok(blocks.length > 0, tag + " 切出 " + blocks.length + " 块");\n'
  + '  ok(blocks.join("") === html, tag + " 回拼与原 HTML 一致");\n'
  + '}\n'
  + '\n'
  + 'L.push("");\n'
  + 'L.push("2. 增量路径 == 全量路径（逐节点同构）");\n'
  + 'function compare(label, fullText, chunk) {\n'
  + '  host.innerHTML = "";\n'
  + '  const full = document.createElement("div"); host.appendChild(full);\n'
  + '  full.innerHTML = mdToHtml(fullText);\n'
  + '  const fs_ = shape(full);\n'
  + '  host.innerHTML = "";\n'
  + '  const inc = document.createElement("div"); host.appendChild(inc);\n'
  + '  let acc = "";\n'
  + '  for (let i = 0; i < fullText.length; i += chunk) { acc += fullText.slice(i, i + chunk); paintReplyInto(inc, acc); }\n'
  + '  const is_ = shape(inc);\n'
  + '  ok(is_ === fs_, label);\n'
  + '  if (is_ !== fs_) { L.push("      增量: " + is_.slice(0,160)); L.push("      全量: " + fs_.slice(0,160)); }\n'
  + '}\n'
  + 'compare("流式长回复（24 字符/块）", DATA.stream, 24);\n'
  + 'compare("同一个回复（7 字符/块）", DATA.stream, 7);\n'
  + 'compare("单行短回复（3 字符/块）", "很短，没有换行。", 3);\n'
  + 'compare("单字符逐个到（最苛刻）", DATA.stream, 1);\n'
  + '\n'
  + 'out.innerHTML = L.join("\\n");\n'
  + 'document.title = fails ? ("FAIL " + fails) : "PASS";\n'
  + '<\/script>\n</body></html>';

const file = path.join(HERE, 'verify-incremental.html');
fs.writeFileSync(file, page, 'utf8');

function get(u) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: u }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res(b));
    }).on('error', rej);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const proc = spawn(EDGE, ['--headless', '--disable-gpu',
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
    source: 'window.__e=[];addEventListener("error",e=>window.__e.push(e.message+" @"+String(e.filename||"").split("/").pop()+":"+e.lineno));',
  });
  await S('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') });
  await sleep(2000);
  const txt = await S('Runtime.evaluate', {
    expression: 'JSON.stringify({out:(document.getElementById("out")||{}).innerText||"(没有 out)",title:document.title,e:window.__e})',
    returnByValue: true,
  });
  sock.close(); proc.kill();

  const d = JSON.parse(txt.result.value);
  console.log(d.out);
  const pageErrors = (d.e && d.e.length) ? d.e : [];
  if (pageErrors.length) {
    console.log('\n页面脚本报错:');
    for (const e of pageErrors) console.log('  ' + e);
  }
  const failed = /^FAIL/.test(d.title);

  // A page error must turn this gate red even if document.title still says
  // PASS. Found via positive-control probe P2: wrapping every block in a div
  // made the script throw NotFoundError, the assertions never ran, and the
  // gate still printed "[PASS]" — a red exit code that had nothing to do with
  // the thing being tested. "It exited non-zero" is not the same as "the
  // assertions caught it", so both are checked and reported separately.
  const crashed = pageErrors.length > 0;
  if (crashed) {
    console.log('\n[FAIL] 页面脚本抛异常 —— 断言没有跑完，这次红不是拦截出来的');
  }
  const verdict = failed || crashed;
  console.log('\n' + (verdict
    ? (crashed ? '[FAIL] 增量渲染闸失败（脚本崩溃）' : '[FAIL] 增量渲染闸失败') + '   title=' + d.title
    : '[PASS] 增量渲染闸通过') + '   断言失败=' + (/^FAIL/.test(d.title) ? '有' : '无') +
    '   脚本异常=' + (crashed ? '有' : '无'));
  process.exit(verdict ? 1 : 0);
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });