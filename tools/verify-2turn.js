'use strict';
/**
 * verify-2turn.js — end-to-end multi-turn check against a RUNNING bridge.
 *
 * Why this exists separately from verify-translator.js: the cost bug this file guards
 * against lived in the stateful layer (claude-session.js / bridge.js), not in the pure
 * translator. A unit test on a pure function cannot see it — the accumulation only
 * shows up on the second turn of a real process. So this drives the real HTTP API and
 * asserts the numbers the phone actually renders.
 *
 * Requires: bridge already running on config.port, claude process able to answer.
 * Costs real money (two turns, ~$0.02-$0.65 depending on cache state).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const TOKEN = fs.readFileSync(path.join(ROOT, '.bridge-token'), 'utf8').trim();

/** Resolve the address the bridge is actually listening on.
 *
 *  This used to hardcode 127.0.0.1, which fails on the DEFAULT config
 *  (host: "tailscale") because the bridge deliberately does not bind loopback —
 *  a fresh deployer following the README hit ECONNREFUSED on the very command
 *  documented as the acceptance check. Mirrors bridge.js resolveHost().
 */
function resolveBase() {
  if (process.env.BRIDGE_BASE) return process.env.BRIDGE_BASE.replace(/\/+$/, '');
  let host = cfg.host;
  if (host === 'tailscale') {
    const exe = [
      'C:\\Program Files\\Tailscale\\tailscale.exe',
      '/usr/local/bin/tailscale',
      '/usr/bin/tailscale',
    ].find((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (!exe) {
      throw new Error('config.host 是 "tailscale" 但找不到 tailscale 可执行文件；'
        + '可以设 BRIDGE_BASE=http://<ip>:<port> 绕过');
    }
    const out = execFileSync(exe, ['ip', '-4'], { encoding: 'utf8', timeout: 5000 });
    host = String(out).trim().split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (!host) throw new Error('tailscale 没有报告 IPv4 地址（未登录？）');
  }
  return `http://${host}:${cfg.port}`;
}

let BASE;
try {
  BASE = resolveBase();
} catch (err) {
  console.error(`无法确定桥接地址: ${err.message}`);
  process.exit(1);
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}
const near = (a, b, eps = 1e-6) => typeof a === 'number' && Math.abs(a - b) < eps;
// /api/status rounds totalCost to 4 decimals, so comparisons against it need a
// tolerance looser than 1e-6. Without this the test fails on a correct bridge.
const nearHealth = (a, b) => near(a, b, 1e-4);
const money = (n) => (typeof n === 'number' ? '$' + n.toFixed(4) : String(n));

async function api(pathname, init = {}) {
  const res = await fetch(BASE + pathname, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* keep raw */ }
  return { status: res.status, body, raw: text };
}

/** Poll the ring buffer until `pred` accepts an event, or time out. */
async function waitFor(pred, timeoutMs = 180000) {
  let since = 0;
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  while (Date.now() < deadline) {
    const r = await api(`/api/poll?since=${since}`);
    if (r.status !== 200) { await sleep(800); continue; }
    for (const ev of r.body.events) {
      since = Math.max(since, ev.seq || 0);
      seen.push(ev);
      if (pred(ev)) return { ev, seen };
    }
    await sleep(700);
  }
  return { ev: null, seen };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const h0 = (await api('/api/status')).body;
  console.log(`\nbridge: turnCount=${h0.turnCount} totalCost=${money(h0.totalCost)} alive=${h0.alive}\n`);
  const baseTurns = h0.turnCount || 0;
  const baseCost = h0.totalCost || 0;

  const turns = [];
  for (let i = 1; i <= 2; i++) {
    console.log(`--- turn ${i} ---`);
    const t0 = Date.now();
    await api('/api/prompt', { method: 'POST', body: JSON.stringify({ text: `只回复两个字：第${i === 1 ? '一' : '二'}轮` }) });
    const { ev } = await waitFor((e) => e.t === 'turn_end' && e.turn === baseTurns + i, 180000);
    if (!ev) { check(`turn ${i} produced a turn_end`, false, 'timed out'); break; }

    const state = (await api('/api/status')).body;
    console.log(`   per-turn ${money(ev.cost)}  session ${money(ev.sessionCost)}  health ${money(state.totalCost)}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    turns.push({ ev, state });
  }

  console.log('');
  if (turns.length < 2) { check('got two turns', false); return; }

  const [a, b] = turns;
  check('turn 1 turn_end carries a numeric per-turn cost', typeof a.ev.cost === 'number', a.ev.cost);
  check('turn 1 sessionCost present', typeof a.ev.sessionCost === 'number', a.ev.sessionCost);
  check('turn 2 turn_end carries a numeric per-turn cost', typeof b.ev.cost === 'number', b.ev.cost);

  // The actual regression: sessionCost is absolute, and health totalCost must equal
  // it — not the sum of the absolute values.
  check('health totalCost === latest sessionCost (NOT accumulated)',
    nearHealth(b.state.totalCost, b.ev.sessionCost),
    { health: b.state.totalCost, sessionCost: b.ev.sessionCost, naiveSum: a.ev.sessionCost + b.ev.sessionCost });
  check('accumulating would have over-reported',
    a.ev.sessionCost + b.ev.sessionCost > b.ev.sessionCost + 1e-6,
    { naiveSum: a.ev.sessionCost + b.ev.sessionCost, correct: b.ev.sessionCost });
  check('turn 2 per-turn cost is smaller than session total',
    b.ev.cost <= b.ev.sessionCost + 1e-9,
    { turn: b.ev.cost, session: b.ev.sessionCost });
  // Deltas only sum to the session total relative to where the session already was.
  // This script does NOT restart the claude process, so on a second run the two
  // turns are turns 3-4 of a session that already spent something. Comparing the raw
  // deltas against sessionCost would fail on a perfectly correct bridge.
  check('per-turn deltas + prior spend == session total',
    nearHealth(baseCost + a.ev.cost + b.ev.cost, b.ev.sessionCost),
    { baseCost, delta1: a.ev.cost, delta2: b.ev.cost, session: b.ev.sessionCost });
  check('turn counter advanced by exactly 2',
    b.state.turnCount - baseTurns === 2,
    { from: baseTurns, to: b.state.turnCount });
  check('session survived turn 1 (same process)', b.state.alive === true, b.state.alive);
  check('turn_end ok flag true', b.ev.ok === true, b.ev);

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`session cost is cumulative: turn1 ${money(a.ev.sessionCost)} -> turn2 ${money(b.ev.sessionCost)}`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
