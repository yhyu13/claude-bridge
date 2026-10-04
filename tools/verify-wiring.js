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

// ---- report ----------------------------------------------------------------
const total = pass + failures.length;
if (failures.length) {
  console.log(`verify-wiring: ${pass}/${total} passed, ${failures.length} FAILED\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}) ${f}\n`));
  process.exit(1);
}
console.log(`verify-wiring: ${pass}/${total} passed`);
