#!/usr/bin/env node
// Verifies backend selection and the turn watchdog.
//
// Context for why this file exists: the model behind this bridge is not fixed.
// Measured 2026-10-04, two failure shapes are completely different —
//   • unknown model   -> fails in ~6s, says "API Error: 400 model platform is
//                        not recognized" on stdout
//   • unreachable API -> over 60s of `system` chatter and then NOT ONE error,
//                        so the phone can only show an endless spinner
// The first is a message problem, the second is a silence problem. A watchdog
// is the only thing that can tell the user the second happened.
//
// Switching backends has its own trap: setting ANTHROPIC_BASE_URL in the child
// process env is SILENTLY IGNORED (settings.json's env block wins), so a
// "working" implementation that used env would appear to switch and keep talking
// to the old relay. --settings <json> was measured to win. Both facts are
// asserted here so neither can silently regress.
//
// Run: node tools\verify-backend.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ClaudeSession } = require('../src/claude-session');

let pass = 0;
const failures = [];
const is = (a, b, n) => { if (a === b) { pass++; return; } failures.push(`${n}\n      expected: ${JSON.stringify(b)}\n      actual:   ${JSON.stringify(a)}`); };
const ok = (c, n) => { if (c) { pass++; return; } failures.push(n); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-backend-'));
const FAKE = path.join(__dirname, 'fake-claude.js');

// 故意不写成 'sk-...' 字面量：仓库是公开的，GitHub 的密钥扫描盯着 sk- 前缀，
// 一个占位串也会弹红色告警，徒增误解。拼出来既保住测试语义（本文件要证明
// token 只会进子进程的 --settings、绝不会出现在给手机的协议里），
// 又不会让人以为仓库里混进了真 key。
const FAKE_TOKEN = ['sk', 'SECRET', 'do', 'not', 'leak'].join('-');

const BACKENDS = {
  relay: { label: '中转网关', env: { ANTHROPIC_BASE_URL: 'https://relay.example.com/api', ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN } },
  official: { label: '官方', env: {} },
  broken: { label: '坏地址', env: { ANTHROPIC_BASE_URL: 'https://nope.invalid/api' } },
};

function makeSession(extra = {}) {
  return new ClaudeSession({
    claudeBin: process.execPath,     // node itself; args are captured, not executed
    workdir: TMP,
    allowedTools: 'Bash',
    backends: BACKENDS,
    activeBackend: 'relay',
    turnTimeoutSec: 1,
    ...extra,
  });
}

// ---- 1. backendInfo ---------------------------------------------------------

const s = makeSession();
const info = s.backendInfo();
is(info.name, 'relay', 'backendInfo: reports the active backend name');
is(info.label, '中转网关', 'backendInfo: reports the label');
is(info.host, 'relay.example.com', 'backendInfo: reports the host for diagnosis');
ok(!JSON.stringify(info).includes('SECRET'), 'backendInfo: never leaks the auth token from the env overlay');
ok(!JSON.stringify(info).toLowerCase().includes('sk-'), 'backendInfo: no sk- key anywhere in the payload');

const bare = new ClaudeSession({ claudeBin: 'x', workdir: TMP, backends: null, activeBackend: null });
is(bare.backendInfo(), null, 'backendInfo: null when no backends are configured');

// A name that is not in the map must not throw — it is a config typo, and the
// phone should be able to render something rather than get a 500.
const typo = makeSession({ activeBackend: 'relayy' });
is(typo.backendInfo().known, false, 'backendInfo: an unknown backend name reports known:false instead of throwing');

// ---- 2. setBackend validation ------------------------------------------------

const sw = makeSession();
is(sw.setBackend('nope').ok, false, 'setBackend: rejects an unknown name');
ok(!!sw.setBackend('nope').error, 'setBackend: explains why');
is(sw.activeBackend, 'relay', 'setBackend: a rejected switch leaves the active backend untouched');

// ---- 3. spawn arguments ------------------------------------------------------
//
// Assert against ClaudeSession.spawnArgs() — the SAME method start() uses. The
// earlier version of this suite re-implemented the argument list inline, which is
// a second copy of a protocol with nothing forcing the two to agree; it went
// stale the moment `--resume` was added, and would have kept passing while
// testing a command line the bridge no longer sends.
const buildArgs = (session) => session.spawnArgs();

const relayArgs = buildArgs(s);
ok(relayArgs.includes('--settings'), 'spawn args: a backend with env gets --settings');
const overlay = JSON.parse(relayArgs[relayArgs.indexOf('--settings') + 1]);
is(overlay.env.ANTHROPIC_BASE_URL, 'https://relay.example.com/api', 'spawn args: the overlay carries the base URL');
is(overlay.env.ANTHROPIC_AUTH_TOKEN, FAKE_TOKEN, 'spawn args: the overlay carries the token to the child, but never to the phone');

const officialArgs = buildArgs(makeSession({ activeBackend: 'official' }));
ok(!officialArgs.includes('--settings'), 'spawn args: an empty-env backend adds no --settings, so settings.json applies');

const noBackendArgs = buildArgs(bare);
ok(!noBackendArgs.includes('--settings'), 'spawn args: no backends configured at all means no --settings');

// ---- 3b. model switching ------------------------------------------------------
//
// Verified end to end against a real relay before this code was written: a
// passphrase seeded under one model was still recalled after killing the process
// and respawning on another with --resume. So the contract these tests pin down
// is "restart the child but keep the conversation" — which is exactly what makes
// a model switch safe to offer from a phone. Drop --resume and the chat still
// LOOKS continuous while the model has amnesia.
const MODELS = [
  { name: null, label: 'CLI 默认' },
  { name: 'opus', label: 'Opus' },
  { name: 'sonnet', label: 'Sonnet' },
];
const ms = makeSession({ models: MODELS, model: null, turnTimeoutSec: 999 });

is(ms.modelInfo().requested, null, 'modelInfo: starts on the CLI default');
is(ms.modelInfo().active, null, 'modelInfo: no model has booted yet');
is(ms.modelInfo().available.length, 3, 'modelInfo: exposes the configured list');
is(ms.modelInfo().available[0].name, null, 'modelInfo: the default entry keeps a null name, not "null"');

const bad = ms.setModel('gpt-9');
is(bad.ok, false, 'setModel: rejects a name that is not configured');
ok(!!bad.error, 'setModel: says which list it checked');
is(ms.modelInfo().requested, null, 'setModel: a rejected switch leaves the model untouched');
ok(!buildArgs(ms).includes('--model'), 'setModel: a rejected switch must not leak a --model into the next spawn');

const same = ms.setModel(null);
is(same.ok, true, 'setModel: selecting the current model is accepted');
is(same.unchanged, true, 'setModel: selecting the current model is reported as unchanged');

const modelSw = ms.setModel('sonnet');
is(modelSw.ok, true, 'setModel: switches to a configured model');
is(modelSw.resumed, false, 'setModel: nothing to resume before the first turn has run');
is(ms.modelInfo().requested, 'sonnet', 'setModel: the requested model is updated');
ok(ms.modelInfo().active === null, 'setModel: the stale "active" report is dropped, not left pointing at the old model');
is(buildArgs(ms)[buildArgs(ms).indexOf('--model') + 1], 'sonnet', 'spawn args: --model carries the new name');

// The conversation-carrying part.
//
// Note what is NOT asserted here: `setModel()` cannot be observed through
// spawnArgs(), because setModel() really does call start(), and start() consumes
// the pending resume while assembling its own argv. So the flag is exercised on
// the unit that actually builds the command line, with the preconditions the
// constructor documents.
const carrier = makeSession({ models: MODELS, model: 'opus', turnTimeoutSec: 999 });
carrier.sessionId = 'sess-1234';
carrier.pendingResume = true;
const resumed = carrier.spawnArgs();
is(resumed[resumed.indexOf('--resume') + 1], 'sess-1234', 'spawn args: --resume carries the session id');
ok(!carrier.spawnArgs().includes('--resume'), 'spawn args: --resume is consumed once, not repeated on every spawn');

const noSessionYet = makeSession({ models: MODELS, model: 'opus', turnTimeoutSec: 999 });
noSessionYet.pendingResume = true;                      // set, but no session id exists
ok(!noSessionYet.spawnArgs().includes('--resume'), 'spawn args: no session id means no --resume, even if resume was requested');

const fresh = makeSession({ models: MODELS, model: 'opus', turnTimeoutSec: 999 });
ok(!fresh.spawnArgs().includes('--resume'), 'spawn args: a fresh start never resumes — the phone has no history of that session');

const backToDefault = makeSession({ models: MODELS, model: 'sonnet', turnTimeoutSec: 999 });
is(backToDefault.setModel(null).ok, true, 'setModel: going back to the CLI default is allowed');
ok(!backToDefault.spawnArgs().includes('--model'), 'spawn args: the default entry passes no --model at all');

const noList = makeSession({ models: null, turnTimeoutSec: 999 });
is(noList.setModel('opus').ok, false, 'setModel: with no models configured, nothing can be selected');

// ---- 4. parseApiError --------------------------------------------------------
// (lives in bridge.js; exercised through the same regex the bridge uses)
const parseApiError = (result) => {
  const t = String(result || '');
  if (!/api error/i.test(t)) return null;
  const m = t.match(/\b([1-5]\d{2})\b/);
  return m ? Number(m[1]) : null;
};
is(parseApiError('API Error: 400 model platform is not recognized'), 400, 'parseApiError: pulls 400 out of the measured string');
is(parseApiError('API Error: 401 {"type":"error"}'), 401, 'parseApiError: pulls 401 out');
is(parseApiError('API Error: overloaded, try later'), null, 'parseApiError: no code present -> null, the phone shows raw text');
is(parseApiError('一切正常'), null, 'parseApiError: ordinary text -> null');
is(parseApiError(''), null, 'parseApiError: empty -> null');

// ---- 5. the watchdog ---------------------------------------------------------
//
// Driven against the REAL claude binary pointed at a backend that cannot be
// reached. That is the honest version of this test: the earlier attempt used
// `node` as a stand-in binary, but the bridge passes CLI flags (`-p`,
// --output-format …) that node interprets as its OWN options, so the stub died
// on startup and the turn was closed by the "process not running" path instead
// of the watchdog. A fake that cannot be launched with the real argv tests
// nothing.

const REAL_BIN = process.env.CLAUDE_BIN
  || (fs.existsSync(path.join(os.homedir(), '.local', 'bin', 'claude.exe'))
    ? path.join(os.homedir(), '.local', 'bin', 'claude.exe')
    : 'claude');

function watchSession(timeoutSec, backendName) {
  const s = new ClaudeSession({
    claudeBin: REAL_BIN,
    workdir: TMP,
    allowedTools: 'Bash',
    backends: { broken: { label: '坏地址', env: { ANTHROPIC_BASE_URL: 'https://watchdog-should-hang-9c2f.invalid/api' } } },
    activeBackend: backendName,
    turnTimeoutSec: timeoutSec,
  });
  const seen = [];
  s.on('turn_end', (e) => seen.push(e));
  s.on('fatal', () => { /* not what this test is about */ });
  return { s, seen };
}

(async () => {
  // An unreachable backend produces no events at all. Without the watchdog the
  // turn never closes and the phone spins forever.
  const { s: s2, seen } = watchSession(2, 'broken');
  s2.start();
  s2.send('这一轮不会有任何回答');

  const t0 = Date.now();
  while (Date.now() - t0 < 25000 && seen.length === 0) {
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 1500));

  ok(seen.length === 1, `watchdog: exactly one turn_end for a silent backend (got ${seen.length})`);
  is(seen[0] && seen[0].timedOut, true, 'watchdog: the turn_end is flagged timedOut');
  is(seen[0] && seen[0].isError, true, 'watchdog: the turn_end is flagged as an error');
  ok(seen[0] && /超时/.test(seen[0].result || ''), 'watchdog: the message says what happened in Chinese');
  ok(seen[0] && seen[0].durationMs > 500, 'watchdog: durationMs reflects the wait, so the phone can show it');
  s2.stop('test-done');

  // A result arriving after the watchdog must not open a second turn.
  const { s: s3, seen: seen3 } = watchSession(2, 'broken');
  s3.start();
  s3.send('同样不会有回答');
  const t1 = Date.now();
  while (Date.now() - t1 < 25000 && seen3.length === 0) {
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 6000));
  is(seen3.length, 1, 'watchdog: nothing that arrives later emits a second turn_end');
  s3.stop('test-done');

  // ---- 6. abort must close the turn it killed -------------------------------
  //
  // Real bug, found by probing the live bridge over /api/poll: pressing STOP
  // returned aborted:true and the phone got the warn alert, but NO turn_end ever
  // arrived — only session_end. The UI has always been able to render an aborted
  // footer (web/app.js reads m.aborted / m.error), so that code was unreachable.
  //
  // Root cause: stop() nulls this.inFlight on its way out, but the `close`
  // handler that is supposed to rescue an orphaned turn READS this.inFlight.
  // By the time `close` fires the field is already gone, so the guard never
  // passes. Neither half is wrong alone — they only work as a pair.
  //
  // Why it matters beyond cosmetics: turn_end is the only reliable turn boundary
  // in this protocol. A client that waits for it (verify-2turn does) hangs
  // forever, and the user never learns what the aborted turn cost.
  const { s: s4, seen: seen4 } = watchSession(999, 'broken'); // watchdog effectively off
  s4.start();
  s4.send('这一轮不会有任何回答');

  // Do not abort blindly: if the turn is not in flight yet, abort() clears the
  // queue instead and returns aborted:false, and the test would "pass" for the
  // wrong reason. Wait for the turn to actually be in flight first.
  const t2 = Date.now();
  while (Date.now() - t2 < 25000 && !s4.inFlight) {
    await new Promise((r) => setTimeout(r, 200));
  }
  ok(!!s4.inFlight, 'abort: the turn really is in flight before we abort it');

  const ab = s4.abort();
  ok(ab.aborted === true, 'abort: reports that it stopped something');
  await new Promise((r) => setTimeout(r, 2500)); // let close fire and try to double-report

  is(seen4.length, 1, `abort: exactly one turn_end (got ${seen4.length})`);
  is(seen4[0] && seen4[0].aborted, true, 'abort: the turn_end is flagged aborted');
  is(seen4[0] && seen4[0].timedOut, undefined, 'abort: not mislabelled as a watchdog timeout');
  ok(seen4[0] && typeof seen4[0].error === 'string' && seen4[0].error.length > 0,
    'abort: carries a reason, so the phone footer can say why it stopped');
  ok(seen4[0] && !/[a-z]+-[a-z]+/.test(String(seen4[0].error)),
    `abort: the reason is human-readable, not a raw token (got ${JSON.stringify(seen4[0] && seen4[0].error)})`);

  // And the inverse: stopping with nothing in flight must NOT invent a turn_end,
  // or the phone would grow phantom aborted turns on every backend switch.
  const { s: s5, seen: seen5 } = watchSession(999, 'broken');
  s5.stop('test-done');
  await new Promise((r) => setTimeout(r, 800));
  is(seen5.length, 0, 'abort: stopping an idle session emits no turn_end');

  // ---- 7. a switch must not orphan the process it just started ---------------
  //
  // This is what actually broke model switching end to end. setModel() kills the
  // child and spawns a replacement in the same tick; the dying process's `close`
  // arrives a moment later. The handler used to null this.proc unconditionally,
  // which orphaned the live replacement, fired a bogus session_end, and dropped
  // the queue. The next send() then saw isAlive()===false and started ANOTHER
  // process — one that had already consumed pendingResume, so it carried no
  // --resume. Measured symptom: right after a switch the model answered
  // "I don't see any password in our conversation history".
  //
  // No prompt is sent, so this costs nothing: it only needs a live process.
  const sw6 = new ClaudeSession({
    claudeBin: REAL_BIN,
    workdir: TMP,
    allowedTools: 'Bash',
    backends: null,
    models: [{ name: null, label: '默认' }, { name: 'sonnet', label: 'Sonnet' }],
    model: null,
    turnTimeoutSec: 999,
  });
  const sessionEnds = [];
  sw6.on('session_end', (e) => sessionEnds.push(e));
  sw6.on('fatal', () => {});
  sw6.start();
  await new Promise((r) => setTimeout(r, 1500));
  ok(sw6.isAlive(), 'switch: the first process came up');

  sw6.setModel('sonnet');
  // Long enough for the OLD process's close event to have been delivered.
  await new Promise((r) => setTimeout(r, 2500));

  ok(sw6.isAlive(), 'switch: the replacement process is still alive after the old one exits');
  ok(!!sw6.proc, 'switch: this.proc still points at the replacement, not null');
  is(sessionEnds.length, 0, 'switch: no bogus session_end for a session that is still running');
  sw6.stop('test-done');
  await new Promise((r) => setTimeout(r, 600));

  const total = pass + failures.length;
  if (failures.length) {
    console.log(`verify-backend: ${pass}/${total} passed, ${failures.length} FAILED\n`);
    failures.forEach((f, i) => console.log(`  ${i + 1}) ${f}\n`));
    process.exit(1);
  }
  console.log(`verify-backend: ${pass}/${total} passed`);
  process.exit(0);
})();
