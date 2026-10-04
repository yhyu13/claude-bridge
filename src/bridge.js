'use strict';
/**
 * bridge.js — HTTP + SSE front end for the persistent claude session.
 *
 * Transport choice: Server-Sent Events + POST, not WebSocket.
 *   - zero runtime dependencies (Node's http module only)
 *   - EventSource reconnects on its own, which matters a lot on a phone that
 *     drops off Wi-Fi for a few seconds
 *   - the traffic is overwhelmingly one-way (server streams, client sends short
 *     commands), so a bidirectional socket would buy nothing
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { URL } = require('url');

const { ClaudeSession } = require('./claude-session');
const { translate, translateAssistantBlocks, fromInit } = require('./translator');
const { Audit } = require('./audit');
const auth = require('./auth');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
// BRIDGE_CONFIG lets a second instance run off an alternate config — used to
// exercise the UI on loopback without disturbing the machine's real settings,
// and useful in general for "staging" a config against a live bridge.
const CONFIG_PATH = process.env.BRIDGE_CONFIG || path.join(ROOT, 'config.json');
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// config.host may be a literal address, or the sentinel "tailscale" which is resolved
// at boot. Hardcoding the 100.x address would silently break whenever the node is
// re-registered, and the failure mode (phone just can't connect) is hard to trace back.
function resolveHost(host) {
  if (host !== 'tailscale') return { host, via: null };
  const exe = [
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    '/usr/local/bin/tailscale',
    '/usr/bin/tailscale',
  ].find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!exe) throw new Error('config.host is "tailscale" but tailscale.exe was not found');
  let out;
  try {
    out = execFileSync(exe, ['ip', '-4'], { encoding: 'utf8', timeout: 5000 });
  } catch (err) {
    throw new Error(`config.host is "tailscale" but \`tailscale ip -4\` failed: ${err.message}`);
  }
  const ip = String(out).trim().split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (!ip) throw new Error('config.host is "tailscale" but tailscale reported no IPv4 address (logged out?)');
  return { host: ip, via: exe };
}

let HOST;
try {
  ({ host: HOST } = resolveHost(CONFIG.host));
} catch (err) {
  console.error(`\n  无法启动: ${err.message}\n  把 config.json 的 host 改回 "127.0.0.1" 可只用本机/USB 模式。\n`);
  process.exit(1);
}

const token = auth.loadOrCreate();
const audit = new Audit(path.join(ROOT, 'audit.ndjson'));
const session = new ClaudeSession(CONFIG);

let ready = null;         // last system/init snapshot
let totalCost = 0;
let turnCount = 0;
const clients = new Set();

// Ring buffer of recent wire messages, each carrying a monotonic `seq`.
// Polling clients resume with `?since=<seq>`, so a phone that drops off Wi-Fi
// for a few seconds catches up instead of losing the conversation.
const RING_MAX = 500;
const ring = [];
let seq = 0;

// ---------------------------------------------------------------------------
// fan-out
// ---------------------------------------------------------------------------

function broadcast(msg) {
  msg.seq = ++seq;
  ring.push(msg);
  if (ring.length > RING_MAX) ring.shift();
  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

function log(level, msg, extra) {
  audit.write('log', { level, msg, ...(extra || {}) });
  if (level === 'error' || level === 'warn') process.stderr.write(`[${level}] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// session wiring
// ---------------------------------------------------------------------------

session.on('init', (obj) => {
  ready = fromInit(obj);
  broadcast(ready);
  // The model the CLI actually booted with, plus which backend got it there.
  // These can disagree with config.json (a relay may remap the model name), and
  // when a switch breaks, "which model am I really on" is question one.
  broadcast({ t: 'backend', backend: session.backendInfo(), available: backendList() });
  // Also refresh the model view: after a --resume the CLI reports the model it
  // actually came up on, which is the answer to "what am I really paying for".
  broadcast({ t: 'model', model: session.modelInfo() });
  log('info', 'session init', {
    cwd: obj.cwd, model: obj.model, tools: (obj.tools || []).length,
    backend: session.backendInfo(),
  });
});

session.on('turn_start', (e) => {
  broadcast({ t: 'turn', index: e.index, queued: e.queued, startedAt: Date.now() });
});

session.on('thinking_tokens', (obj) => {
  broadcast(translate(obj, { turnIndex: null }));
});

session.on('text', (e) => {
  broadcast({ t: 'text', turn: e.index, text: e.text });
});

session.on('thinking', (e) => {
  if (e.text) broadcast({ t: 'thinking_text', turn: e.index, text: e.text });
});

session.on('tool_use', (e) => {
  const msgs = translateAssistantBlocks({ message: { content: [{ type: 'tool_use', ...e }] } },
    { turnIndex: e.index, patterns: CONFIG.dangerousPatterns });
  for (const m of msgs) broadcast(m);
  if (e.input && typeof e.input === 'object') {
    const json = JSON.stringify(e.input).toLowerCase();
    const hit = (CONFIG.dangerousPatterns || []).find((p) => json.includes(String(p).toLowerCase()));
    if (hit) {
      const cmd = e.input.command || JSON.stringify(e.input).slice(0, 300);
      broadcast({ t: 'alert', level: 'danger', message: `检测到危险命令模式「${hit}」`, detail: cmd });
      log('warn', 'dangerous command', { pattern: hit, command: cmd, turn: e.index });
    }
  }
});

session.on('tool_result', (e) => {
  // This event has to go through translate() with an explicit `type: 'user'`,
  // NOT through translateAssistantBlocks(). The latter only understands
  // text / thinking / tool_use, so a tool_result block fell through it and came
  // back as null — every tool call reached the phone with no output and no way
  // to know it had finished. Confirmed against the raw stream: the CLI really
  // does emit these (see _probe/raw-stream.ndjson), so the gap was purely here.
  const m = translate(
    {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: e.id,
          content: e.text,
          is_error: e.isError,
        }],
      },
    },
    { turnIndex: e.index }
  );
  if (m) broadcast(m);
});

session.on('usage', (e) => {
  // 'usage', NOT 'state'. The phone's 'state' handler is a whole-status replace: it
  // would clear the turn counter, and a live token snapshot must never do that.
  broadcast({ t: 'usage', turn: e.index, usage: e.usage });
});

session.on('turn_end', (e) => {
  turnCount++;
  // e.sessionCost is absolute for the whole process session. Overwriting (not
  // accumulating) is what keeps turn 2 from reporting turn1+turn2 as its own spend.
  // Older/edge paths may only carry a per-turn delta, so keep a fallback.
  if (typeof e.sessionCost === 'number') totalCost = e.sessionCost;
  else if (typeof e.cost === 'number') totalCost += e.cost;

  // Hard cost brake (disabled by default — see DESIGN.md §0.4/§6.4).
  // Compares the per-turn delta, not the session total.
  if (CONFIG.maxCostPerTurn != null && e.cost > CONFIG.maxCostPerTurn) {
    broadcast({ t: 'fatal', reason: 'max-cost-per-turn', cost: e.cost, limit: CONFIG.maxCostPerTurn });
    log('warn', 'max cost per turn exceeded', { cost: e.cost, limit: CONFIG.maxCostPerTurn });
    session.stop('max-cost-per-turn');
    return;
  }

  broadcast({
    t: 'turn_end',
    turn: e.index,
    ok: e.subtype === 'success' && !e.isError,
    result: e.result || '',
    // The CLI phrases rejections as "API Error: 400 model platform is not
    // recognized" — a bare boolean `ok:false` tells the phone that nothing
    // happened but not why, and the phone cannot read the CLI's stderr.
    apiError: parseApiError(e.result),
    timedOut: !!e.timedOut,
    cost: e.cost,
    sessionCost: e.sessionCost ?? null,
    numTurns: e.numTurns,
    durationMs: e.durationMs,
    denied: e.permissionDenials || [],
    aborted: !!e.aborted,
    error: e.error || null,
  });
  broadcast({ t: 'state', turnCount, totalCost, alive: session.isAlive() });
  log('info', 'turn end', { turn: e.index, cost: e.cost, aborted: !!e.aborted, error: e.error || null });
});

session.on('session_end', (e) => {
  broadcast({ t: 'session_end', code: e.code, stderr: e.stderr, turn: e.turn });
  log('warn', 'claude process exited', { code: e.code, signal: e.signal, stderr: e.stderr });
});

session.on('fatal', (e) => {
  broadcast({ t: 'fatal', reason: e.reason, detail: e.detail });
  log('error', 'session fatal', e);
});

session.on('log', (e) => log(e.level || 'info', e.msg));

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res, code, body) {
  const b = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { req.destroy(); resolve({}); }  // 1 MB cap
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

// Pull the HTTP status out of the CLI's error prose. Measured shapes:
//   "API Error: 400 model platform is not recognized"
//   "API Error: 401 {"type":"error",...}"
// Returns null when there is no recognisable code — the phone then shows the
// raw text on its own, which is still better than nothing.
function parseApiError(result) {
  const s = String(result || '');
  if (!/api error/i.test(s)) return null;
  const m = s.match(/\b([1-5]\d{2})\b/);
  return m ? Number(m[1]) : null;
}

/** Labels and hosts only. A backend's `env` overlay can carry a bearer token,
 *  so nothing else from config is allowed onto the wire. */
function backendList() {
  const all = CONFIG.backends || {};
  return Object.entries(all).map(([name, b]) => {
    let host = null;
    const u = b.env && (b.env.ANTHROPIC_BASE_URL || b.env.ANTHROPIC_API_URL);
    if (u) { try { host = new URL(u).host; } catch { host = '(无法解析)'; } }
    return { name, label: b.label || name, host };
  });
}

function checkToken(req, url) {
  const q = url.searchParams.get('t') || '';
  const h = req.headers['x-bridge-token'] || '';
  // Both sources are tried. The previous `verify(q || h, token)` short-circuited:
  // a stale `?t=` in the URL rejected the request even when X-Bridge-Token
  // carried the right one, which reads as a broken token rather than a stale link.
  if (auth.verify(q, token) || auth.verify(h, token)) return true;
  log('warn', 'auth rejected', { path: url.pathname, remote: req.socket.remoteAddress });
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ---- static ----
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    if (!checkToken(req, url)) return json(res, 401, { error: 'bad token' });
    const html = fs.readFileSync(path.join(WEB, 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  if (req.method === 'GET' && /^\/(app\.js|style\.css)$/.test(url.pathname)) {
    const f = path.join(WEB, url.pathname.slice(1));
    if (fs.existsSync(f)) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(f));
    }
  }

  // ---- health (no token: liveness only) ----
  // The comment above used to claim this "only ever reports liveness" while the
  // body returned cwd, model, toolCount, turnCount and totalCost. A tailnet can
  // include family and work devices, so an unauthenticated endpoint that leaks
  // `C:\Users\<name>\...` and cumulative spend is a real disclosure, not a
  // cosmetic one. Liveness stays public; everything else moved behind the token
  // as /api/status. The client never used this endpoint for the detail — it
  // renders from the authed `ready` event — so nothing on the phone changed.
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, alive: session.isAlive() });
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    if (!checkToken(req, url)) return json(res, 401, { error: 'bad token' });
    return json(res, 200, {
      ok: true,
      alive: session.isAlive(),
      turnCount,
      totalCost: Number(totalCost.toFixed(4)),
      ready: ready ? { cwd: ready.cwd, model: ready.model, toolCount: ready.toolCount } : null,
      backend: session.backendInfo(),
      model: session.modelInfo(),
    });
  }

  // ---- backend selection ---------------------------------------------------
  // A switch restarts the claude child: the overlay is a spawn argument, and a
  // live process keeps whatever credentials it booted with. The conversation is
  // lost, so the phone says so before calling this.
  if (req.method === 'GET' && url.pathname === '/api/backend') {
    if (!checkToken(req, url)) return json(res, 401, { error: 'bad token' });
    const all = CONFIG.backends || {};
    return json(res, 200, {
      active: session.backendInfo(),
      available: backendList(),
      turnTimeoutSec: CONFIG.turnTimeoutSec ?? 0,
    });
  }

  // Model switcher. Unlike a backend switch this one RESUMES the conversation:
  // --resume <session-id> carries the CLI session onto the new model, verified
  // end to end (a passphrase seeded under `opus` was recalled after switching to
  // `sonnet`). The backend switch above does not, because it changes who bills.
  if (req.method === 'GET' && url.pathname === '/api/model') {
    if (!checkToken(req, url)) return json(res, 401, { error: 'bad token' });
    return json(res, 200, session.modelInfo());
  }

  // ---- poll stream (primary transport) ----
  if (req.method === 'GET' && url.pathname === '/api/poll') {
    if (!checkToken(req, url)) return json(res, 401, { error: 'bad token' });
    const since = Number(url.searchParams.get('since') || 0) || 0;
    const events = ring.filter((e) => e.seq > since);
    return json(res, 200, {
      events,
      seq,
      status: {
        turnCount,
        totalCost: Number(totalCost.toFixed(4)),
        alive: session.isAlive(),
        ready,
      },
    });
  }

  // ---- SSE stream (kept for desktop / low-latency clients) ----
  if (req.method === 'GET' && url.pathname === '/api/events') {
    if (!checkToken(req, url)) return json(res, 401, { error: 'bad token' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    clients.add(res);
    log('info', 'client connected', { total: clients.size });

    if (ready) res.write(`data: ${JSON.stringify(ready)}\n\n`);
    res.write(`data: ${JSON.stringify({ t: 'state', turnCount, totalCost, alive: session.isAlive() })}\n\n`);

    const hb = setInterval(() => {
      try { res.write(': hb\n\n'); } catch { /* closed */ }
    }, 15000);

    req.on('close', () => {
      clearInterval(hb);
      clients.delete(res);
      log('info', 'client disconnected', { total: clients.size });
    });
    return undefined;
  }

  // ---- commands ----
  if (req.method === 'POST') {
    if (!checkToken(req, url)) return json(res, 401, { error: 'bad token' });
    const body = await readBody(req);

    if (url.pathname === '/api/prompt') {
      const text = String(body.text || '').trim();
      if (!text) return json(res, 400, { error: 'empty prompt' });
      const r = session.send(text);
      audit.write('prompt', { text: text.slice(0, 4000), ...r });
      // Echo the prompt into the ring buffer. Without this the phone shows the
      // answers but loses every question it asked as soon as the page reloads —
      // the only record lived in the browser's DOM. A refresh mid-conversation is
      // common enough that this is worth a round trip to the server.
      broadcast({ t: 'echo', text, turn: r.index, at: Date.now() });
      return json(res, 200, r);
    }
    if (url.pathname === '/api/abort') {
      const r = session.abort();
      audit.write('abort', r);
      broadcast({ t: 'alert', level: 'warn', message: r.aborted ? '已中止当前轮次（上下文已丢失）' : '没有进行中的轮次' });
      return json(res, 200, r);
    }
    if (url.pathname === '/api/kill') {
      session.stop('user-kill');
      audit.write('kill', { by: 'user' });
      broadcast({ t: 'session_end', code: null, killed: true });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/backend') {
      const name = String(body.name || '').trim();
      const r = session.setBackend(name);
      audit.write('backend-switch', { name, ok: r.ok, error: r.error || null });
      if (!r.ok) return json(res, 400, r);
      log('info', 'backend switched', { backend: name, host: r.backend && r.backend.host });
      // Tell every connected phone immediately rather than making them wait for
      // the next poll to notice the model line changed.
      broadcast({ t: 'backend', backend: r.backend, available: backendList() });
      return json(res, 200, r);
    }
    if (url.pathname === '/api/model') {
      // An empty / null / "null" name means "go back to the CLI default", which
      // is a real option and often the safest one: a relay can stop serving the
      // name you hard-coded, and the default keeps working.
      const raw = body.name === undefined ? '' : String(body.name).trim();
      const name = (raw === '' || raw === 'null') ? null : raw;
      const r = session.setModel(name);
      audit.write('model-switch', { name, ok: r.ok, resumed: !!r.resumed, error: r.error || null });
      if (!r.ok) return json(res, 400, r);
      log('info', 'model switched', {
        requested: r.model && r.model.requested,
        active: r.model && r.model.active,
        resumed: !!r.resumed,
      });
      // The phone's model chip and its picker both read this, and a switch is
      // not something a client should have to poll to notice.
      broadcast({ t: 'model', model: r.model });
      return json(res, 200, r);
    }
  }

  json(res, 404, { error: 'not found' });
  return undefined;
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.listen(CONFIG.port, HOST, () => {
  const isTailscale = /^100\./.test(HOST) || /^fd7a:/.test(HOST);
  console.log('');
  console.log('  claude-bridge is up');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  监听地址:  ${HOST}:${CONFIG.port}`);
  if (isTailscale) {
    console.log(`  公网:      http://${HOST}:${CONFIG.port}/?t=${token}`);
    console.log('             (手机需装 Tailscale 并登录同一账号)');
  }
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.log('  ⚠️ 绑定了所有网卡 —— 同局域网任何人都能连到本服务');
    for (const a of lanAddresses()) {
      console.log(`  局域网:    http://${a}:${CONFIG.port}/?t=${token}`);
    }
  } else if (HOST === '127.0.0.1' || HOST === 'localhost') {
    console.log('             (仅本机；手机需先跑 adb reverse tcp:8787 tcp:8787)');
  } else {
    console.log('             (只在这个地址上可达；其他网卡/局域网不可达)');
  }
  console.log('');
  console.log(`  工作目录:  ${CONFIG.workdir}`);
  console.log(`  工具权限:  ${CONFIG.allowedTools}`);
  console.log(`  审计日志:  ${path.join(ROOT, 'audit.ndjson')}`);
  console.log('  ─────────────────────────────────────────────');
  console.log('');
  audit.write('boot', { host: HOST, port: CONFIG.port, pid: process.pid });
  session.start();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    audit.write('shutdown', { sig });
    session.stop(sig);
    audit.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

process.on('uncaughtException', (err) => {
  log('error', 'uncaughtException', { message: err.message, stack: err.stack });
  broadcast({ t: 'fatal', reason: 'bridge-crash', detail: err.message });
});
