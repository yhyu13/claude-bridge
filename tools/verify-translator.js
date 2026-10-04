'use strict';
/**
 * verify-translator.js — regression test for the pure translation layer.
 *
 * Feeds the frozen protocol sample (docs/protocol-sample.ndjson) through the
 * translator and asserts the wire messages line up. No network, no model, no
 * $1.23 per run — this is the cheap test that should run on every change.
 */

const fs = require('fs');
const path = require('path');
const { translate, fromInit, findDanger } = require('../src/translator');

const SAMPLE = path.join(__dirname, '..', 'docs', 'protocol-sample.ndjson');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' -> ' + JSON.stringify(extra) : ''}`); }
}

const lines = fs.readFileSync(SAMPLE, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
console.log(`\nsample: ${lines.length} events\n`);

console.log('[1] every event translates without throwing');
let translated = [];
let threw = null;
try {
  for (const obj of lines) {
    const m = translate(obj, { turnIndex: 7, patterns: ['rm -rf'] });
    if (m) translated.push(m);
  }
} catch (e) { threw = e; }
check('no exception', !threw, threw && threw.message);
check('produced wire messages', translated.length > 0);

console.log('\n[2] system/init -> ready');
const init = lines.find((o) => o.type === 'system' && o.subtype === 'init');
const r = fromInit(init);
check('t === ready', r.t === 'ready');
check('has cwd', typeof r.cwd === 'string' && r.cwd.length > 0, r.cwd);
check('toolCount is a number', typeof r.toolCount === 'number' && r.toolCount > 0, r.toolCount);
check('tools is an array', Array.isArray(r.tools));
check('mcpServers mapped', Array.isArray(r.mcpServers) && r.mcpServers.every((m) => 'name' in m && 'status' in m));
check('skills is an array', Array.isArray(r.skills));
// Match secret *shapes*, not substrings: a bare /sk-/i also matches "skills".
check('apiKeySource is a source label, not a key', typeof r.apiKeySource !== 'string' || r.apiKeySource.length < 32, r.apiKeySource);
check('no sk- prefixed key anywhere', !/"sk-[A-Za-z0-9_-]{8,}/.test(JSON.stringify(r)));
check('no Bearer token anywhere', !/Bearer\s+[A-Za-z0-9._-]{8,}/.test(JSON.stringify(r)));
check('no ANTHROPIC_AUTH value anywhere', !/ANTHROPIC_AUTH[^,}]{0,10}[=:][^,}]{8,}/.test(JSON.stringify(r)));

console.log('\n[3] assistant tool_use -> tool (with input preserved)');
const tu = lines.find((o) => o.type === 'assistant' && o.message.content.some((c) => c.type === 'tool_use'));
const tm = translate(tu, { turnIndex: 1, patterns: ['rm -rf'] });
check('t === tool', tm && tm.t === 'tool');
check('name preserved', tm && tm.name === 'Read', tm && tm.name);
check('id preserved', !!(tm && tm.id));
check('input is an object', !!(tm && typeof tm.input === 'object'));

console.log('\n[4] assistant text -> text');
const at = lines.find((o) => o.type === 'assistant' && o.message.content.some((c) => c.type === 'text'));
const am = translate(at, { turnIndex: 1 });
check('t === text', am && am.t === 'text');
check('text non-empty', !!(am && am.text && am.text.length > 0));

console.log('\n[5] user tool_result -> tool_result');
const tr = lines.find((o) => o.type === 'user' && o.message.content.some((c) => c.type === 'tool_result'));
const rm = translate(tr, { turnIndex: 1 });
check('t === tool_result', rm && rm.t === 'tool_result');
check('has tool_use id', !!(rm && rm.id));
check('preview is a string', !!(rm && typeof rm.preview === 'string'));
check('bytes is a number', !!(rm && typeof rm.bytes === 'number'));

console.log('\n[6] result -> turn_end');
const res = lines.find((o) => o.type === 'result');
const em = translate(res, {});
check('t === turn_end', em && em.t === 'turn_end');
check('ok flag true for success', em && em.ok === true);
check('cost is a number', !!(em && typeof em.cost === 'number'), em && em.cost);
check('denials is an array', !!(em && Array.isArray(em.denied)));

console.log('\n[7] danger detection');
check('catches rm -rf', !!findDanger({ command: 'rm -rf /' }, ['rm -rf']));
check('catches nested', !!findDanger({ args: { x: 'git push --force origin main' } }, ['git push --force']));
check('ignores clean command', !findDanger({ command: 'ls -la' }, ['rm -rf', 'del /f']));
check('extracts command text', findDanger({ command: 'rm -rf /tmp' }, ['rm -rf']).command === 'rm -rf /tmp');

console.log('\n[8] usage snapshot survives on assistant messages');
const withUsage = lines.find((o) => o.type === 'assistant' && o.message.usage);
const um = translate(withUsage, { turnIndex: 1 });
check('usage present on wire msg', !!(um && um.usage), um && Object.keys(um.usage || {}));
check('cacheCreate is a number', !!(um && um.usage && typeof um.usage.cacheCreate === 'number'));

// Regression: a usage-only message once reused t:'state', which made the phone UI
// reset the turn counter to 0 on every assistant message.
const usageOnly = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }], usage: { output_tokens: 5, cache_creation_input_tokens: 7, cache_read_input_tokens: 0 } } };
const uo = translate({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }], usage: { output_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } } }, {});
check('usage-carrying msg is NOT t:state', uo.t !== 'state', uo.t);
check('aggregate counter keys absent on usage msgs', !('turnCount' in uo) && !('totalCost' in uo));
check('tool msg still carries usage', !!(translate(usageOnly, {}).usage));

console.log('\n[9] session shape');
check('no wire msg leaks an api key', !translated.some((m) => JSON.stringify(m).match(/"sk-[A-Za-z0-9_-]{8,}/)));

// Regression: bridge.js used to do `totalCost += e.cost` while `total_cost_usd` is
// CUMULATIVE for the process session. Turn 2 then reported turn1+turn2 as its own
// spend, and the number grew quadratically after that. The diff has to happen in
// the stateful layer, so the pure translator exposes it via ctx.costBase.
console.log('\n[10] cost is cumulative per session, not per turn');
const cost2 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'cost-2turn.json'), 'utf8')).results;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const t1 = translate(cost2[0], { costBase: 0 });
check('turn 1 cost === its cumulative', near(t1.cost, 0.0246096), t1.cost);
check('turn 1 sessionCost is absolute', near(t1.sessionCost, 0.0246096), t1.sessionCost);

const t2 = translate(cost2[1], { costBase: cost2[0].total_cost_usd });
check('turn 2 cost is a DELTA not the running total', near(t2.cost, 0.615198), t2.cost);
check('turn 2 cost < its sessionCost', t2.cost < t2.sessionCost, { cost: t2.cost, sessionCost: t2.sessionCost });
check('turn 2 sessionCost is absolute', near(t2.sessionCost, 0.6398076), t2.sessionCost);

check('deltas sum back to the session total', near(t1.cost + t2.cost, cost2[1].total_cost_usd),
  { sum: t1.cost + t2.cost, expected: cost2[1].total_cost_usd });
check('naive accumulation would over-report', cost2[0].total_cost_usd + cost2[1].total_cost_usd > cost2[1].total_cost_usd + 1e-6);
check('no costBase degrades to cumulative, never negative', translate(cost2[1], {}).cost >= 0);
check('out-of-order base cannot produce a negative cost', translate(cost2[0], { costBase: 99 }).cost === 0);
check('result_index advances across turns', cost2[1].result_index === 1, cost2[1].result_index);
check('per-turn usage is NOT cumulative', near(cost2[1].usage.cache_creation_input_tokens, 123018) && near(cost2[0].usage.cache_creation_input_tokens, 0));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
