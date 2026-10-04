// A stand-in for the `claude` CLI, used by verify-backend.js.
//
// The real binary cannot be made to fail on demand, and the two behaviours this
// test needs are exactly the ones that only appear when something is WRONG:
//   mode=silent  — reads the prompt and never answers (what an unreachable
//                  backend looks like on the wire: 60s+ of system chatter and
//                  then nothing at all)
//   mode=late    — answers, but only after `lateMs`, to prove a result arriving
//                  after the watchdog closed the turn is not counted twice
const fs = require('fs');
const path = require('path');

const mode = process.env.FAKE_MODE || 'silent';
const lateMs = Number(process.env.FAKE_LATE_MS || 8000);
const BIN = process.env.FAKE_BIN || path.join(__dirname, 'fake-claude.js');

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// The real CLI is silent until the first stdin line, then emits system/init.
process.stdin.on('data', (chunk) => {
  const lines = String(chunk).split('\n').filter(Boolean);
  for (const l of lines) {
    let msg;
    try { msg = JSON.parse(l); } catch { continue; }
    if (msg.type !== 'user') continue;

    out({ type: 'system', subtype: 'init', cwd: process.cwd(), model: 'fake-model-1',
          tools: ['Bash'], skills: [], mcp_servers: [] });

    if (mode === 'late') {
      setTimeout(() => {
        out({ type: 'assistant', message: { content: [{ type: 'text', text: '迟到的回答' }] } });
        out({ type: 'result', subtype: 'success', is_error: false, result: '迟到的回答',
              result_index: 0, num_turns: 1, duration_ms: lateMs, total_cost_usd: 0.5 });
      }, lateMs);
    }
    // mode === 'silent' -> deliberately no result, ever.
  }
});

process.stdin.resume();

// Record the argv we were launched with so the test can assert on it.
try { fs.writeFileSync(process.env.FAKE_ARGV_OUT || (BIN + '.argv'), process.argv.slice(2).join('\n')); } catch { /* best effort */ }
