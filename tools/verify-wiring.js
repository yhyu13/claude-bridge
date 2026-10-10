#!/usr/bin/env node
// Verifies the bridge's EVENT WIRING, not the translator.
//
// Why this file exists: the translator handled tool_result correctly from day
// one, and verify-translator.js has always passed 47/47 covering it. The bug was
// one layer up — bridge.js routed the `tool_result` event through
// translateAssistantBlocks(), which only understands text/thinking/tool_use, so
// it returned null and every tool call reached the phone with no output and a
// spinner that never stopped. A pure-function test cannot see that, so this one
// exercises the actual routing decision against a real captured protocol stream.
//
// Run: node tools\verify-wiring.js

const fs = require('fs');
const path = require('path');
const { translate, translateAssistantBlocks } = require('../src/translator');

let pass = 0;
const failures = [];
const is = (actual, expected, name) => {
  if (actual === expected) { pass++; return; }
  failures.push(`${name}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
};
const ok = (cond, name) => { if (cond) { pass++; return; } failures.push(name); };

const fixture = path.join(__dirname, 'fixtures', 'tool-call.ndjson');
const raw = fs.readFileSync(fixture, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

// ---- 1. the real CLI stream does contain the event -------------------------
//
// If a future CLI version stops emitting these, the fixture stops matching and
// this fails loudly instead of the phone silently losing all tool output again.
const userLine = raw.find((o) => o.type === 'user'
  && (o.message?.content || []).some((b) => b.type === 'tool_result'));
ok(!!userLine, 'fixture: real stream contains a user/tool_result event');

const toolUseLine = raw.find((o) => o.type === 'assistant'
  && (o.message?.content || []).some((b) => b.type === 'tool_use'));
const expectedId = toolUseLine.message.content.find((b) => b.type === 'tool_use').id;

// ---- 2. translate() is the route that works ---------------------------------
const viaTranslate = translate(userLine, { turnIndex: 0 });
is(viaTranslate?.t, 'tool_result', 'translate(): a user/tool_result event becomes a tool_result wire message');
is(viaTranslate?.id, expectedId, 'translate(): the id matches the tool_use it answers');
ok(typeof viaTranslate?.preview === 'string' && viaTranslate.preview.length > 0,
  'translate(): preview is a non-empty string');
ok(typeof viaTranslate?.bytes === 'number' && viaTranslate.bytes > 0,
  'translate(): bytes is a positive number');
is(viaTranslate?.ok, true, 'translate(): ok is true for a clean result');

// ---- 3. the wrong route is provably wrong ----------------------------------
//
// This is the exact mistake bridge.js used to make. Asserting it stays true
// keeps the two functions from looking interchangeable to a future reader.
const viaWrong = translateAssistantBlocks(userLine, { turnIndex: 0 });
ok(!Array.isArray(viaWrong) || !viaWrong.some((m) => m && m.t === 'tool_result'),
  'translateAssistantBlocks(): does NOT produce tool_result (this is why bridge must not use it)');

// ---- 4. the wiring itself ---------------------------------------------------
//
// bridge.js cannot be required without starting a server, so the handler is
// checked at the source level. A one-line tripwire for a bug that already
// shipped once is worth the small fragility.
const bridgeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'bridge.js'), 'utf8');
const handler = bridgeSrc.match(/session\.on\('tool_result'[\s\S]*?\n\}\);/);
ok(!!handler, 'wiring: bridge.js has a session.on(\'tool_result\') handler');
if (handler) {
  // Strip line comments first: the handler explains in prose WHY it must not
  // use translateAssistantBlocks(), and a naive substring test would trip over
  // its own documentation.
  const code = handler[0]
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
  ok(/\btranslate\(/.test(code), "wiring: handler calls translate()");
  ok(!/translateAssistantBlocks\s*\(/.test(code), "wiring: handler does NOT call translateAssistantBlocks()");
  ok(/tool_use_id/.test(code), 'wiring: handler maps the session id onto tool_use_id');
  ok(/is_error/.test(code), 'wiring: handler maps isError onto is_error');
}

// ---- 5. the auth surface of the two status endpoints -----------------------
//
// /api/health is deliberately reachable without a token so "is the bridge up"
// can be answered by anything on the tailnet. Its own comment said it "only
// ever reports liveness" while the body returned cwd, model, toolCount,
// turnCount and totalCost — a full Windows path with the username, plus
// cumulative spend, to any device on the network. The detail moved to
// /api/status behind the token. These assertions keep the two from drifting
// back together.
const stripComments = (src) => src.split(/\r?\n/)
  .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

const healthBlock = bridgeSrc.match(/url\.pathname === '\/api\/health'[\s\S]*?\n {2}\}/);
ok(!!healthBlock, 'auth: /api/health route exists');
if (healthBlock) {
  const h = stripComments(healthBlock[0]);
  ok(!/checkToken/.test(h), 'auth: /api/health stays reachable without a token');
  for (const leak of ['ready', 'cwd', 'model', 'toolCount', 'totalCost', 'turnCount']) {
    ok(!new RegExp(`\\b${leak}\\b`).test(h), `auth: /api/health does not leak "${leak}"`);
  }
}

const statusBlock = bridgeSrc.match(/url\.pathname === '\/api\/status'[\s\S]*?\n {2}\}/);
ok(!!statusBlock, 'auth: /api/status route exists');
if (statusBlock) {
  const s = stripComments(statusBlock[0]);
  ok(/checkToken/.test(s), 'auth: /api/status requires the token');
  ok(/totalCost/.test(s), 'auth: /api/status carries the cost detail that health dropped');
}

// One layer over again: the CLI does not emit system/init on spawn — under
// --input-format stream-json the first one arrives with the FIRST PROMPT. Measured
// on a cold start: process up, stderr clean, event stream empty for 30s+, and
// /api/status reported ready:null, so the phone showed 「未知目录」 until the user
// typed something. The workdir is in config.json and the session has had it since
// construction, so it gets reported — flagged as configured, not confirmed.
//
// The flag is the whole point. A planned cwd displayed identically to an observed
// one is a confident answer the UI cannot back up, which is the same failure as
// the frozen chip in item 21, wearing a different hat.
const statusReady = statusBlock && statusBlock[0].match(/ready:\s*\{[\s\S]*?\n {6}\}/);
ok(!!statusReady, 'status: /api/status describes ready as an object (never a bare null)');
if (statusReady) {
  const rs = stripComments(statusReady[0]);
  ok(/session\.cwd/.test(rs), 'status: ready.cwd falls back to the configured workdir before the CLI reports');
  ok(/cwdFromCli/.test(rs), 'status: ready says whether cwd came from the CLI or from config');
  ok(/reported/.test(rs), 'status: ready carries a reported flag so the client can tell "not yet" from "zero"');
  // The dangerous shape is `ready ? ready.toolCount : 0` — a number nobody has,
  // printed as if it were a measurement.
  ok(!/toolCount:\s*[^,\n]*\|\|\s*0/.test(rs) && !/toolCount:\s*0\b/.test(rs),
    'status: ready.toolCount is never defaulted to 0 before the CLI reports');
}

// ---- 6. the phone re-reads model/backend instead of trusting pushed events ---
//
// A bridge restart drops every event an already-open page had not polled for
// yet, and nothing pushes a replacement: model and backend are only broadcast on
// a SWITCH. The chip then froze on whatever it knew at connect time and kept
// displaying it — a confident, wrong answer, indefinitely, because `polling`
// stays true so connect()'s one-shot fetch never runs again.
//
// These are structural tripwires, not a behavioural test. They fail if the
// re-sync is deleted; they stay green if it is called in a way that never
// resolves. The behaviour was verified live instead — restart the bridge under
// an open page and watch the chip change with no reload — and is not re-proven
// here. stripComments matters: these patterns must not be satisfiable by the
// prose of this very comment.
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const appCode = stripComments(appSrc);

ok(/function resync\s*\(/.test(appCode), 'client: resync() exists');
ok(/\/api\/model\?t=/.test(appCode) && /showModel\(d\)/.test(appCode),
  'client: resync() re-reads the model list and hands it to showModel');
ok(/\/api\/backend\?t=/.test(appCode) && /showBackend\(\{ backend: d\.active/.test(appCode),
  'client: resync() re-reads the backend and hands it to showBackend');
ok(/if \(sawOffline\) \{ sawOffline = false; resync\(\); \}/.test(appCode),
  'client: the first poll that recovers after a failure triggers resync()');
ok(/^\s*sawOffline = true;/m.test(appCode),
  'client: a failed poll is what marks the page offline in the first place');

// The same family, opposite failure: two writers for one value, both on a timer.
// The model line belongs to showModel alone.
const showReadyFn2 = appSrc.match(/function showReady\([\s\S]*?\n\}/);
ok(!!showReadyFn2, 'client: showReady() exists');
if (showReadyFn2) {
  const sr = stripComments(showReadyFn2[0]);
  // The client half of the cold-start fix: /api/status now always describes
  // `ready`, but toolCount is null until the CLI speaks. Writing that as 0 was
  // the exact bug already fixed once in this function's own history — an absent
  // field reported as a measured zero — so it is pinned here rather than trusted.
  ok(/toolCount\s*!=\s*null/.test(sr),
    'client: showReady() distinguishes a null toolCount from a real one');
  ok(/cwdFromCli/.test(sr),
    'client: showReady() labels a configured-only cwd instead of passing it off as confirmed');
  ok(!/els\.model\./.test(sr),
    'client: showReady() does not write the model line (showModel is its only writer)');
}

// One layer over the same bug: `ready` fires once per claude PROCESS, at spawn,
// so a page opened after the spawn never gets it and the top bar keeps its "—"
// placeholder. Zero writers is as wrong as two writers.
ok(/\/api\/status\?t=/.test(appCode) && /showReady\(d\.ready\)/.test(appCode),
  'client: resync() re-reads the last ready snapshot so a late-opened page still learns the cwd');

// ---- 7. the docs quote test counts, and those go stale -------------------
//
// `npm run verify:quick`（translator 49 + md 33 + wiring NN + 脱敏 + 扫描）必须绿。
// 把它写进文档是有用的——但它是一个**快照**，任何一次加断言都会让它变成谎话，而
// 没有人会去数。这条闸让谎话在提交时就红。
//
// 两处细节是踩出来的：
//   1) 匹配的是「wiring 后面紧跟的数字」，不是文中任意位置 —— 否则
//      `verify-wiring.js` 里的 "wiring" 会被当成引用，配上邻近的数字报出一个
//      根本不存在的引用（本项目实测过：SD 里被读成「wiring 5」）。
//   2) 断言总数在跑到这里时还没算完 —— 这几条自己就是断言，会把总数往上推。
//      所以先收集、最后统一结算，而不是当场 is()。
//
// 只钉 wiring 那一项，因为本文件知道自己的总数；translator/md 的数量在别的文件里，
// 真要钉就得让三个 verifier 互相 import，那是另一种设计。
// The wire must not be cacheable. Every JSON answer is live state, and a cached
// /api/poll is not just a stale picture: it rewinds `lastSeq`, so every event
// between the cached seq and the real one is skipped forever. Measured 2026-10-10
// after a restart — the server reported turnCount 0 and an empty buffer while the
// phone still rendered the previous process's conversation, turn count and cost.
const jsonFn = bridgeSrc.match(/function json\(res, code, body\) \{[\s\S]*?\n\}/);
ok(!!jsonFn, 'cache: bridge.js has one json() writer');
if (jsonFn) {
  const j = stripComments(jsonFn[0]);
  ok(/Cache-Control/.test(j) && /no-store/.test(j),
    'cache: every JSON response is sent with Cache-Control: no-store');
}

const docsWithCounts = ['docs/SD-规格与设计.md', 'docs/工作记录与待办.md', '.specify/memory/constitution.md'];
const docChecks = [];
for (const rel of docsWithCounts) {
  const abs = path.join(__dirname, '..', rel);
  if (!fs.existsSync(abs)) { ok(false, `docs: ${rel} exists (counts gate reads it)`); continue; }
  const txt = fs.readFileSync(abs, 'utf8');
  // "wiring 31" / "wiring 31 +" —— 数字紧跟在 wiring 后面，允许中间有几个连接词。
  const m = txt.match(/wiring[ \t]*\+?[ \t]*(\d+)/);
  if (!m) { ok(true, `docs: ${rel} quotes no wiring count (nothing there to go stale)`); continue; }
  docChecks.push({ rel, quoted: Number(m[1]) });
}

// ---- report ----------------------------------------------------------------
const total = pass + failures.length + docChecks.length;
for (const d of docChecks) {
  is(d.quoted, total, `docs: ${d.rel} quotes wiring ${d.quoted} but this file currently asserts ${total}`);
}
if (failures.length) {
  console.log(`verify-wiring: ${pass}/${total} passed, ${failures.length} FAILED\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}) ${f}\n`));
  process.exit(1);
}
console.log(`verify-wiring: ${pass}/${total} passed`);
