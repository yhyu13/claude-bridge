'use strict';
/**
 * app.js — phone client. Talks polling (server -> client) + POST (client -> server).
 *
 * v6 changes, all driven by problems observed on the real phone:
 *  - auto-scroll no longer yanks the view to the bottom while the user is reading
 *    something older; a "jump to latest" button takes over instead.
 *  - the working indicator animates and counts real elapsed seconds. v5's static
 *    "思考中… 约 N tokens" looked frozen and told a waiting user nothing.
 *  - prompts come back from the server as `echo` events, so a page reload keeps
 *    the questions. Previously they existed only in the DOM and vanished.
 *  - connection state and environment info no longer overwrite each other.
 *  - the composer keeps a local draft and regains focus after sending.
 */

const T = new URLSearchParams(location.search).get('t') || '';
const AUTOTEST = new URLSearchParams(location.search).get('autotest');
const DRAFT_KEY = 'claude-bridge:draft';
const $ = (id) => document.getElementById(id);

const els = {
  dot: $('dot'), link: $('link'), model: $('model'), cwd: $('cwd'),
  stats: $('stats'), cost: $('cost'),
  alerts: $('alerts'), log: $('log'), jump: $('jump'),
  statusdot: $('statusdot'), statustext: $('statustext'),
  input: $('input'), send: $('send'), abort: $('abort'), kill: $('kill'),
  modelbtn: $('modelbtn'), backend: $('backend'),
  sheet: $('sheet'), backends: $('backends'), sheetclose: $('sheetclose'),
};

let busy = false;
let currentBot = null;   // the .msg.bot element currently streaming
let currentBotRaw = '';  // its Markdown source, re-rendered on a coalesced timer
let renderTimer = null;
let thinkTokens = null;  // suffixes folded into the working label by one owner
let workNote = '';
let workUsage = '';
let turnStart = 0;        // Date.now() when the active turn began
let tickTimer = null;     // interval driving the elapsed-seconds counter

// ---- scrolling -------------------------------------------------------------
//
// v5 called scrollToBottom() on every single event, so scrolling up to re-read an
// older answer was impossible: the next token yanked the view back. Only follow
// along when the user is already at the bottom; otherwise leave them alone and
// offer a jump button.

const NEAR_BOTTOM = 90;

function atBottom() {
  return els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < NEAR_BOTTOM;
}

let pendingNew = 0;

function scrollDown(force) {
  if (force) pendingNew = 0;
  els.log.scrollTop = els.log.scrollHeight;
  els.jump.hidden = true;
  pendingNew = 0;
}

/** Called after any content change: stick only if the user was already following. */
function follow() {
  if (atBottom()) {
    scrollDown();
  } else {
    pendingNew++;
    els.jump.hidden = false;
  }
}

els.log.addEventListener('scroll', () => {
  if (atBottom() && pendingNew) { pendingNew = 0; els.jump.hidden = true; }
}, { passive: true });

els.jump.addEventListener('click', () => scrollDown(true));

// ---- helpers ---------------------------------------------------------------

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function addUser(text, at) {
  const d = document.createElement('div');
  d.className = 'msg user';
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  const s = document.createElement('div');
  s.className = 'stamp';
  s.textContent = at ? new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : stamp();
  d.appendChild(b); d.appendChild(s);
  // Ordering: the bridge answers a prompt with `echo` (replay) and `turn` (work
  // started) in whatever order the round trip produces. When `turn` wins, the
  // working indicator is already the last child of the log, and a plain append
  // would strand it ABOVE this bubble -- which reads as "the previous answer is
  // still thinking", exactly the confusion the indicator was added to remove.
  // Inserting before the indicator keeps it pinned to the tail of the transcript.
  const wk = document.getElementById('wk');
  if (wk && wk.parentNode === els.log) els.log.insertBefore(d, wk);
  else els.log.appendChild(d);
  follow();
}

// ---- markdown --------------------------------------------------------------
//
// Claude answers in Markdown. v5 pushed the whole reply through textContent, so
// on a 6.1" phone the user read raw `**bold**`, `- bullets` and ``` fences.
// This is a hand-rolled renderer rather than a library on purpose: the bridge
// ships with zero runtime dependencies, and the subset below covers what
// actually shows up in chat replies.
//
// SAFETY: reply text is not trusted input — it echoes back whatever the user
// typed, on a page whose URL carries the bridge token. Every character is
// escaped BEFORE any tag is produced, and hrefs are restricted to http(s), so
// a crafted reply cannot inject script or a `javascript:` link.

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function inlineMd(src) {
  // Code spans are lifted out before escaping so their contents stay literal and
  // a `**` inside backticks is never mistaken for bold.
  const spans = [];
  let s = src.replace(/`([^`\n]+)`/g, (_, code) => {
    spans.push(code);
    return `\u0000${spans.length - 1}\u0000`;
  });

  s = esc(s);

  // [label](url) — a non-http(s) target is left as literal text rather than
  // becoming a clickable link.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label, href) => (
    /^https?:\/\//i.test(href)
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : whole
  ));

  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${esc(spans[+n])}</code>`);
}

function mdToHtml(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const para = [];
  // Chat replies wrap lines by hand, so a soft break inside a paragraph is
  // meaningful. Blocks get margins; these keep the author's own line breaks.
  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${inlineMd(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
    para.length = 0;
  };
  const items = (re) => {
    const acc = [];
    while (i < lines.length) {
      const m = re.exec(lines[i]);
      if (!m) break;
      acc.push(m[1]);
      i++;
    }
    return acc;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;  // consume the closing fence; a still-streaming reply has none yet
      out.push(`<pre><code${lang ? ` data-lang="${esc(lang)}"` : ''}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^\s*$/.test(line)) { flushPara(); i++; continue; }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const lv = h[1].length;
      out.push(`<h${lv}>${inlineMd(h[2])}</h${lv}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); out.push('<hr>'); i++; continue; }

    if (/^\s*>/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${inlineMd(buf.join('\n')).replace(/\n/g, '<br>')}</blockquote>`);
      continue;
    }

    const liRe = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
    if (liRe.test(line)) {
      flushPara();
      const ordered = /^\s*\d/.test(line);
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items(liRe).map((t) => `<li>${inlineMd(t)}</li>`).join('')}</${tag}>`);
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return out.join('');
}

// ---- reply bubble ----------------------------------------------------------

function botMsg() {
  if (currentBot) return currentBot;
  const d = document.createElement('div');
  d.className = 'msg bot';
  const th = document.createElement('button');
  th.className = 'thinkhead';
  th.type = 'button';
  th.hidden = true;
  const k = document.createElement('div');
  k.className = 'think';
  const t = document.createElement('div');
  t.className = 'text';
  const m = document.createElement('div');
  m.className = 'meta';
  d.appendChild(th); d.appendChild(k); d.appendChild(t); d.appendChild(m);
  els.log.appendChild(d);
  currentBot = d;
  currentBotRaw = '';
  d._raw = '';   // kept on the node so a past reply stays copyable
  d._think = '';
  follow();
  return d;
}

// Claude's internal monologue used to be concatenated straight into the answer
// bubble, so the reply opened with "The user is asking me to...". It is shown
// live while the turn runs — watching it work is the point — and then folded
// away at turn_end so the actual answer is what you are left reading.
function addThinking(text) {
  const el = botMsg();
  el._think += text;
  const k = el.querySelector('.think');
  k.textContent = el._think;
  follow();
}

function foldThinking(el) {
  const k = el.querySelector('.think');
  const head = el.querySelector('.thinkhead');
  if (!el._think || !el._think.trim() || !k || !head) return;
  const label = `思考过程（${el._think.length} 字）`;
  head.textContent = label;
  head.hidden = false;
  k.classList.add('folded');
  if (!head.dataset.bound) {
    head.dataset.bound = '1';
    head.addEventListener('click', () => {
      const folded = k.classList.toggle('folded');
      head.textContent = folded ? `思考过程（${el._think.length} 字）` : '收起思考过程';
    });
  }
}

function botText(text) {
  const el = botMsg();
  currentBotRaw += text;
  el._raw = currentBotRaw;
  scheduleRender();
  follow();
}

// The bridge is served over plain http on a tailnet address, which is NOT a
// secure context — navigator.clipboard is undefined there. The execCommand
// path is the one that actually runs; the modern API is only the fast path.
async function copyText(s) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch { /* fall through to the legacy path */ }

  const ta = document.createElement('textarea');
  ta.value = s;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

// A reply arrives in dozens of small chunks. Re-parsing on every one of them
// both flickers and wastes work, so coalesce into a single paint; turn_end
// calls flushRender() to make sure the last chunk is never left unrendered.
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; paintReply(); }, 60);
}

function paintReply() {
  if (currentBot) currentBot.querySelector('.text').innerHTML = mdToHtml(currentBotRaw);
}

function flushRender() {
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
  paintReply();
}

function botMeta(html) {
  const el = botMsg();
  const m = el.querySelector('.meta');
  m.innerHTML = html;
  if (el._raw) {
    const b = document.createElement('button');
    b.className = 'copy';
    b.type = 'button';
    b.textContent = '复制';
    b.addEventListener('click', async () => {
      const okCopy = await copyText(el._raw);
      b.textContent = okCopy ? '已复制 ✓' : '复制失败';
      setTimeout(() => { b.textContent = '复制'; }, 1600);
    });
    m.appendChild(b);
  }
  // A reply that dumps a file or a long report buries everything after it on a
  // phone, so anything taller than a screenful gets a manual unfold.
  foldThinking(el);
  clampLong(el);
}

const CLAMP_PX = 420;

function clampLong(el) {
  const t = el.querySelector('.text');
  if (!t || el.querySelector('.more')) return;
  if (t.scrollHeight <= CLAMP_PX) return;
  t.classList.add('clamped');
  const b = document.createElement('button');
  b.className = 'more';
  b.type = 'button';
  b.textContent = `展开全文（${t.scrollHeight}px）`;
  b.addEventListener('click', () => {
    const on = t.classList.toggle('clamped');
    b.textContent = on ? `展开全文（${t.scrollHeight}px）` : '收起';
  });
  el.appendChild(b);
}

function clearBot() { currentBot = null; currentBotRaw = ''; }

// ---- working indicator -----------------------------------------------------

function startWorking() {
  turnStart = Date.now();
  thinkTokens = null;
  workNote = '';
  workUsage = '';
  stopWorking();
  const w = document.createElement('div');
  w.className = 'working';
  w.id = 'wk';
  w.innerHTML = '<span class="pulse"></span><span class="wtxt"></span>';
  els.log.appendChild(w);
  renderWorkingLabel();
  tickTimer = setInterval(() => {
    if (!document.getElementById('wk')) return stopWorking();
    renderWorkingLabel();
    follow();
  }, 500);
  setStatus(true, '进行中');
  follow();
}

// Single owner of the working label. Before this existed, the 500ms tick wrote
// "思考中… 13s" while the token and tool events wrote their own text into the
// same node, so the line flickered between two different messages twice a
// second on every turn.
function renderWorkingLabel() {
  const el = document.getElementById('wk');
  if (!el) return;
  const secs = Math.floor((Date.now() - turnStart) / 1000);
  const bits = [secs < 3 ? '思考中…' : `思考中… ${secs}s`];
  if (thinkTokens) bits.push(`约 ${thinkTokens} tokens`);
  if (workUsage) bits.push(workUsage);
  if (workNote) bits.push(workNote);
  el.querySelector('.wtxt').textContent = bits.join(' · ');
}

function stopWorking() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  const w = document.getElementById('wk');
  if (w) w.remove();
}

/** Reword the working line without killing the elapsed timer (e.g. a tool started). */
function workingLabel(text) {
  workNote = text;
  renderWorkingLabel();
}

function setStatus(active, text) {
  els.statusdot.hidden = !active;
  els.statustext.textContent = text || '';
}

// ---- alerts ----------------------------------------------------------------
//
// v5 removed every alert after 12s. Looking away from the phone during an error
// meant missing it permanently. Errors now stay until dismissed; softer notices
// still auto-expire, and every one is manually closable.

function alertBox(level, message, detail, sticky) {
  const d = document.createElement('div');
  d.className = `alert ${level}`;
  const box = document.createElement('div');
  box.className = 'msg';
  const s = document.createElement('div');
  s.textContent = message;
  box.appendChild(s);
  if (detail) {
    const c = document.createElement('code');
    c.textContent = detail;
    box.appendChild(c);
  }
  const x = document.createElement('button');
  x.className = 'x';
  x.type = 'button';
  x.textContent = '×';
  x.title = '关闭';
  x.addEventListener('click', () => d.remove());
  d.appendChild(box); d.appendChild(x);
  els.alerts.appendChild(d);
  if (!sticky) setTimeout(() => d.remove(), 12000);
  return d;
}

// ---- tool cards ------------------------------------------------------------
//
// v6 titled each card with the bare tool name ("Bash") and kept both the
// arguments and the output inside the collapsed body. On a phone that meant the
// user could not tell what Claude was doing without tapping every card. The
// summary line now carries the one argument that matters, the result lands in
// the SAME card instead of a second nested one, and a spinner marks the window
// before the result arrives.

/** Collapse to one line, keeping the informative end: for paths and commands
 *  the right-hand side is what identifies them, the left is a shared prefix. */
function oneLine(s, max = 64) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return '…' + t.slice(t.length - max + 1);
}

function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return '';
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const pick = (...keys) => keys.map((k) => str(input[k])).find(Boolean);

  const direct =
    pick('command') ?? pick('file_path') ?? pick('notebook_path') ??
    pick('url') ?? pick('query') ?? pick('description') ?? pick('prompt');
  if (direct) return oneLine(direct);

  // Grep and Glob identify themselves by pattern *and* location; either alone
  // is too vague to be worth the row.
  const pattern = pick('pattern');
  if (pattern) {
    const path = pick('path', 'glob');
    return oneLine(path ? `${pattern}  @  ${path}` : pattern);
  }

  // Unknown tool: the longest string argument is nearly always the payload.
  const all = Object.values(input).map(str).filter(Boolean);
  if (all.length) return oneLine(all.sort((a, b) => b.length - a.length)[0]);
  return '';
}

function toolShell() {
  const d = document.createElement('details');
  d.className = 'tool running';
  const s = document.createElement('summary');
  s.innerHTML = '<span class="ico"></span><span class="name"></span>'
    + '<span class="desc"></span><span class="arrow">›</span>';
  const body = document.createElement('div');
  body.className = 'body';
  d.appendChild(s); d.appendChild(body);
  return d;
}

function addTool(name, input, danger) {
  const d = toolShell();
  if (danger) d.classList.add('danger');
  d.querySelector('.name').textContent = name;
  d.querySelector('.desc').textContent = toolSummary(name, input);
  const pre = document.createElement('pre');
  pre.className = 'args';
  pre.textContent = JSON.stringify(input, null, 2);
  d.querySelector('.body').appendChild(pre);
  els.log.appendChild(d);
  if (danger) d.open = true;
  follow();
  return d;
}

function addToolResult(id, ok, preview, bytes) {
  // The result used to be a SECOND card nested under the call card, so every
  // tool call cost two rows and the "↩ 1234B" label said nothing. Fold the
  // output into the call card and report the outcome in the same row.
  let target = null;
  for (const c of [...els.log.querySelectorAll('.tool[data-tid]')].reverse()) {
    if (c.dataset.tid === id) { target = c; break; }
  }
  if (!target) {
    target = toolShell();
    target.querySelector('.name').textContent = '工具';
    els.log.appendChild(target);
  }

  target.classList.remove('running');
  target.classList.toggle('failed', !ok);
  target.querySelector('.ico').textContent = ok ? '✓' : '✗';

  const out = document.createElement('div');
  out.className = 'out';
  const size = document.createElement('span');
  size.className = 'outsize';
  size.textContent = ok ? `输出 ${bytes}B` : '失败';
  const pre = document.createElement('pre');
  pre.textContent = preview;
  out.appendChild(size); out.appendChild(pre);
  target.querySelector('.body').appendChild(out);

  follow();
}

async function post(path, body) {
  const r = await fetch(path + (T ? `?t=${encodeURIComponent(T)}` : ''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': T },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

// ---- polling transport -----------------------------------------------------
//
// EventSource opened fine but never delivered data frames in the vivo browser,
// so the primary transport is polling. 800ms is imperceptible for chat, and the
// `since` cursor means a dropped Wi-Fi connection resumes instead of losing the
// conversation. SSE is still served at /api/events for desktop use.

let lastSeq = 0;
let polling = false;
let backoff = 800;

function setLink(cls, text) {
  els.dot.className = 'dot ' + cls;
  els.link.className = 'link' + (cls === 'err' ? ' err' : '');
  els.link.textContent = text;
}

function showReady(m) {
  els.cwd.textContent = m.cwd || '(未知目录)';
  els.cwd.title = m.cwd || '';
  els.model.textContent = m.model || '';
  if (!busy) setStatus(false, `${m.toolCount} 个工具 · ${(m.skills || []).length} 技能 · ${(m.mcpServers || []).length} MCP`);
}

function pumpOnce() {
  return fetch(`/api/poll?t=${encodeURIComponent(T)}&since=${lastSeq}`, { cache: 'no-store' })
    .then((r) => {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    })
    .then((d) => {
      setLink('on', '已连接');
      backoff = 800;

      if (d.status && d.status.ready) showReady(d.status.ready);
      if (d.status) {
        els.stats.textContent = `${d.status.turnCount} 轮`;
        els.cost.textContent = `$${(d.status.totalCost || 0).toFixed(4)}`;
      }

      for (const m of d.events) {
        lastSeq = Math.max(lastSeq, m.seq || 0);
        handle(m);
      }
      runAutotest();
    })
    .catch(() => {
      setLink('err', '连接不上');
      els.dot.className = 'dot wait';
      setStatus(false, '检查电脑端桥接是否在运行');
      backoff = Math.min(backoff * 1.6, 8000);
    });
}

function runAutotest() {
  if (!AUTOTEST || window.__autoTested) return;
  window.__autoTested = true;
  setTimeout(() => {
    els.input.value = AUTOTEST === '1' ? 'reply with exactly: BRIDGE OK' : AUTOTEST;
    send();
  }, 200);
}

function connect() {
  if (polling) return;
  polling = true;
  // Ask who we are talking to straight away. The `backend` event only fires on
  // system/init, which does not happen until the first prompt of a session — so a
  // freshly opened page would otherwise show no backend at all.
  fetch(`/api/backend?t=${encodeURIComponent(T)}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    // The GET endpoint answers with `active`; the pushed event uses `backend`.
    // Normalise here rather than making showBackend guess which shape it got.
    .then((d) => { if (d) showBackend({ backend: d.active, available: d.available }); })
    .catch(() => { /* offline; the poll loop will retry */ });
  const loop = () => {
    pumpOnce().finally(() => setTimeout(loop, backoff));
  };
  loop();
}

function handle(m) {
  switch (m.t) {
    case 'ready':
      showReady(m);
      break;

    // Replay of a prompt this bridge already accepted. Lets a refreshed page show
    // the questions, not just the answers.
    case 'echo':
      addUser(m.text, m.at);
      break;

    case 'turn':
      busy = true;
      turnStart = Date.now();
      els.send.disabled = true;
      els.abort.disabled = false;
      clearBot();
      startWorking();
      break;

    case 'text':
      botText(m.text);
      break;

    case 'thinking_text':
      if (m.text) addThinking(m.text);
      break;

    // The elapsed-seconds counter and this token count used to write to the same
    // node from two places, so the label flickered between "思考中… 13s" and
    // "思考中… 约 2400 tokens" twice a second. The timer owns the label; this
    // only supplies a suffix it re-renders.
    case 'thinking':
      thinkTokens = m.tokens ?? null;
      renderWorkingLabel();
      break;

    case 'usage':
      // Live per-message token snapshot. Deliberately does NOT touch the turn
      // counter or the cost total — those come from 'state' only.
      if (m.usage && !currentBot) {
        const u = m.usage;
        workUsage = `out ${u.output ?? 0} · 缓存读 ${u.cacheRead ?? 0}`;
        renderWorkingLabel();
      }
      break;

    case 'tool': {
      const card = addTool(m.name, m.input, m.danger);
      card.dataset.tid = m.id;
      workingLabel('调用工具…');
      break;
    }

    case 'tool_result':
      addToolResult(m.id, m.ok, m.preview, m.bytes);
      break;

    case 'alert':
      alertBox(m.level, m.message, m.detail, m.level === 'danger');
      break;

    case 'backend':
      showBackend(m);
      break;

    case 'turn_end': {
      stopWorking();
      flushRender();
      busy = false;
      els.send.disabled = false;
      els.abort.disabled = true;
      // botMsg() first: a turn that failed before any text still needs a bubble
      // to hang the error off, otherwise the failure has nowhere to render.
      const el = botMsg();
      const bits = [];
      if (m.aborted) bits.push('<span style="color:var(--danger)">已中止</span>');
      else if (m.cost != null) bits.push(`<span class="costline">$${m.cost.toFixed(4)}</span>`);
      if (m.durationMs) bits.push(`${(m.durationMs / 1000).toFixed(1)}s`);
      if (m.denied && m.denied.length) bits.push(`<span style="color:var(--warn)">${m.denied.length} 项被拒</span>`);
      if (m.error) bits.push(`<span style="color:var(--danger)">${m.error}</span>`);

      // A backend rejection is a FAILED turn, not a cheap successful one. Without
      // this the footer read "$0.0000 · 3.4s" and the user had no way to tell.
      if (m.ok === false && !m.aborted) {
        el.classList.add('failed');
        bits.push('<span class="failflag">失败</span>');
        showTurnError(el, explainError(m.result, m.apiError));
      }

      botMeta(bits.join(' · '));
      foldThinking(el);
      clampLong(el);
      setStatus(false, m.ok === false && !m.aborted ? '后端出错' : '就绪');
      break;
    }

    case 'state':
      if (m.turnCount != null) els.stats.textContent = `${m.turnCount} 轮`;
      if (m.totalCost != null) els.cost.textContent = `$${m.totalCost.toFixed(4)}`;
      break;

    case 'session_end':
      stopWorking();
      flushRender();
      busy = false;
      els.send.disabled = false;
      alertBox('warn', m.killed ? 'claude 进程已被手动停止' : `claude 进程退出（code ${m.code}）`,
        (m.stderr || []).join('\n'), true);
      break;

    case 'fatal':
      stopWorking();
      alertBox('danger', `错误：${m.reason}`, m.detail, true);
      break;
  }
}

// ---- turn failures ---------------------------------------------------------
//
// Measured: when the backend rejects the request, the CLI emits an assistant
// text block containing "API Error: 400 model platform is not recognized" and
// then a `result` with subtype "success" but is_error true. The PROCESS STAYS
// ALIVE, so no session_end fires and nothing else reaches the phone.
//
// v10 rendered that turn's footer from cost and duration alone, producing
// "$0.0000 · 3.4s" — indistinguishable from a normal, cheap, successful turn.
// That is why "连不上模型" looked like the app had silently done nothing. A
// failed turn has to announce itself, and the raw text has to stay visible so
// the cause is diagnosable from the phone.

const ERROR_HINTS = [
  [/model platform is not recognized|unrecognized_model|model[_ ]not[_ ]found/i,
    '当前后端不认识这个模型',
    '这个后端不提供该模型。换 config.json 的 activeBackend，或把 model 设成 null 交给 CLI 默认'],
  [/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|fetch failed|network error|socket hang up/i,
    '连不上后端',
    '检查 ANTHROPIC_BASE_URL 拼写、网络可达性，以及 Tailscale 是否还连着'],
  [/\b401\b|unauthorized|authentication_error|invalid[_ ]api[_ ]key/i,
    '凭据无效或已过期',
    '检查 ANTHROPIC_AUTH_TOKEN 是不是被轮换掉了'],
  [/\b403\b|forbidden|permission_error/i,
    '这个 token 没权限用这个模型',
    '换后端，或换一个带该模型权限的 token'],
  [/\b429\b|rate[_ ]limit|too many requests/i,
    '被后端限流了',
    '等一会儿再发。桥接一次只跑一轮，不存在自己重试放大的问题'],
  [/\b529\b|overloaded|capacity[_ ]exceeded/i,
    '后端过载',
    '稍后重发。可以用 --fallback-model 配一个备用模型自动兜底'],
  [/context (length )?exceeded|too many tokens|prompt is too long/i,
    '上下文超长了',
    '用顶部的「紧急停止」重开一轮，context 就清空了'],
];

function explainError(raw, code) {
  const text = String(raw || '').trim();
  for (const [re, title, hint] of ERROR_HINTS) {
    if (re.test(text)) return { title, hint, raw: text };
  }
  return {
    title: code ? `后端返回 ${code}` : '这一轮失败了',
    hint: '下面是后端的原话',
    raw: text,
  };
}

/** Render the failure inside the reply, above the text the CLI did manage. */
function showTurnError(el, e) {
  if (!e.raw && !e.title) return;
  const box = document.createElement('div');
  box.className = 'failbox';

  const h = document.createElement('div');
  h.className = 'failtitle';
  h.textContent = e.title;
  box.appendChild(h);

  if (e.hint) {
    const s = document.createElement('div');
    s.className = 'failhint';
    s.textContent = e.hint;
    box.appendChild(s);
  }
  if (e.raw) {
    const c = document.createElement('code');
    c.textContent = e.raw;
    box.appendChild(c);
  }
  const t = el.querySelector('.text');
  el.insertBefore(box, t);
}



// ---- backend switcher ------------------------------------------------------
//
// The model behind this bridge is not fixed: the CLI talks to whatever relay
// ~/.claude/settings.json points at, and that relay can start serving a
// different model — or stop serving the configured one entirely. Measured 2026-10-04,
// a rejected model fails in ~6s with "API Error: 400 model platform is not
// recognized", so the fix has to be reachable from the phone, not from a text
// editor on the other end of the wire.

let backends = [];

function showBackend(m) {
  const b = m.backend;
  const name = b ? (b.label || b.name) : '默认配置';
  const host = b && b.host ? ` · ${b.host}` : '';
  els.backend.textContent = name + host;
  els.backend.dataset.name = b ? b.name : '';
  els.backend.title = b && b.known
    ? `后端 ${b.name}（${host.replace(' · ', '') || '用本机 settings.json'}）`
    : '未配置 backends，用 ~/.claude/settings.json 的默认配置';
  if (m.available) backends = m.available;
  if (!els.sheet.hidden) renderBackends();
}

function renderBackends() {
  els.backends.textContent = '';
  if (!backends.length) {
    const p = document.createElement('div');
    p.className = 'backendempty';
    p.textContent = 'config.json 里没有配置 backends。在电脑上加上 backends 和 activeBackend 就能在这里切换。';
    els.backends.appendChild(p);
    return;
  }
  for (const b of backends) {
    const active = els.backend.dataset.name === b.name;
    const row = document.createElement('button');
    row.className = 'backendrow' + (active ? ' on' : '');
    row.type = 'button';
    row.disabled = active;

    const n = document.createElement('span');
    n.className = 'bn';
    n.textContent = b.label || b.name;
    row.appendChild(n);
    if (b.host) {
      const h = document.createElement('span');
      h.className = 'bh';
      h.textContent = b.host;
      row.appendChild(h);
    }
    if (active) {
      const c = document.createElement('span');
      c.className = 'bcur';
      c.textContent = '当前';
      row.appendChild(c);
    }
    row.addEventListener('click', async () => {
      row.disabled = true;
      row.textContent = '切换中…';
      const r = await post('/api/backend', { name: b.name });
      closeSheet();
      if (r && r.error) {
        alertBox('danger', `切换后端失败：${r.error}`, null, true);
        renderBackends();
        return;
      }
      alertBox('warn', `已切到「${b.label || b.name}」`, 'claude 进程已重启，上下文清空。发下一条消息即可。');
    });
    els.backends.appendChild(row);
  }
}

function openSheet() {
  renderBackends();
  els.sheet.hidden = false;
}
function closeSheet() { els.sheet.hidden = true; }

els.modelbtn.addEventListener('click', openSheet);
els.sheetclose.addEventListener('click', closeSheet);
els.sheet.addEventListener('click', (e) => { if (e.target === els.sheet) closeSheet(); });

// ---- composer --------------------------------------------------------------

function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, els.input.value); } catch { /* private mode */ }
}

function loadDraft() {
  try {
    const v = localStorage.getItem(DRAFT_KEY);
    if (v) { els.input.value = v; autosize(); }
  } catch { /* ignore */ }
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 140) + 'px';
}

async function send() {
  const text = els.input.value.trim();
  if (!text) return;
  // The server echoes the prompt back through the ring buffer, so adding it here
  // too would render every question twice.
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  els.input.value = '';
  autosize();
  const r = await post('/api/prompt', { text });
  if (r && r.error) {
    addUser(text);
    alertBox('danger', '发送失败', r.error, true);
  }
  // Keep focus so follow-up questions do not need a second tap.
  els.input.focus();
}

els.send.addEventListener('click', send);
els.input.addEventListener('input', () => { autosize(); saveDraft(); });
els.input.addEventListener('keydown', (e) => {
  // Desktop: Enter sends. Mobile: Enter must insert a newline, so Ctrl/Cmd+Enter
  // is the send gesture there instead.
  if (e.key === 'Enter' && !e.shiftKey && (e.ctrlKey || e.metaKey || window.innerWidth > 700)) {
    e.preventDefault();
    send();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && busy) els.abort.click();
});

els.abort.addEventListener('click', async () => {
  const r = await post('/api/abort');
  if (r.aborted) alertBox('warn', '已中止', '这一轮的上下文已丢失，下次发消息会重新开始。');
  stopWorking();
  busy = false; els.send.disabled = false; els.abort.disabled = true;
  setStatus(false, '就绪');
});

els.kill.addEventListener('click', async () => {
  if (confirm('确定要杀掉电脑上的 claude 进程吗？\n\n会丢失当前对话上下文，电脑上的文件不受影响。')) {
    await post('/api/kill');
    alertBox('warn', '已发送紧急停止', '上下文已清空，发下一条消息会自动重启进程。');
  }
});

els.abort.disabled = true;
loadDraft();
connect();
