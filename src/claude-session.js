'use strict';
/**
 * claude-session.js — owns the persistent `claude` child process.
 *
 * Behaviour locked in by live probing on 2026-10-03 (see DESIGN.md §1.4):
 *
 *  1. The child stays alive with stdin open, so one process = one conversation.
 *  2. Exactly ONE turn is in flight at a time. A prompt written while a turn is
 *     running is queued, not written. Piping several lines at once makes the CLI
 *     collapse them into a single turn — that is why an earlier probe showed one
 *     `result` for two input lines.
 *  3. A `result` event closes every turn. It is the ONLY reliable turn boundary:
 *     `message.stop_reason` is `null` in `--output-format stream-json` output, so
 *     it cannot be used to detect the end of a turn.
 *  4. Context survives across turns (turn 2 cost $0.025 vs turn 1 $1.23 — the
 *     prompt cache is warm once the process is long-lived).
 *  5. The process is SILENT until the first stdin line arrives: `system/init`
 *     (and with it cwd / tools / skills / mcp_servers) is emitted ~40ms after the
 *     first write, not at spawn. Do not expect a ready snapshot on connect.
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// 为什么中止一轮时是"手动收尾"而不是等 CLI 自己报 result
// -------------------------------------------------------
// 桥接把 claude 当常驻子进程，一轮从写 stdin 开始、到 CLI 回一个 result 结束。
// 但我们主动拆进程时（用户按停止、成本刹车、切后端、关机），这一轮永远等不到
// 那个 result —— 于是永远不会有 turn_end。没有 turn_end 的后果不只是页脚少一行：
//   · 手机上那一轮的卡片永远不收尾，看不到花了多少钱、也不知道是"已中止"
//   · 任何以 turn_end 作为轮次边界的客户端会一直挂着等下去
// 所以在 stop() 里显式补一个 aborted 的 turn_end。这不是可选的收尾，是协议要求。
//
// 另一个容易踩的坑：close 处理器里那段"进程死了就把在飞的那轮收掉"的逻辑，
// 对 stop() 这条路径是**无效**的 —— stop() 会先把 inFlight 置空，close 触发时
// 再读已经读不到东西了。这两处必须成对看，只改一处等于没改。

/** 中止原因会直接渲染到手机那一轮的页脚上（web/app.js 读 m.error），所以给中文。 */
const STOP_REASON_TEXT = {
  aborted: '已手动中止',
  'user-kill': '已终止会话',
  'backend-switch': '切换后端时中断',
  'max-cost-per-turn': '超出单轮成本上限',
  'idle-timeout': '空闲超时回收',
  'process-exit': 'claude 进程意外退出',
  'not-running': 'claude 未在运行',
};

function stopReasonText(reason) {
  if (STOP_REASON_TEXT[reason]) return STOP_REASON_TEXT[reason];
  return typeof reason === 'string' && reason ? reason : '已中断';
}

class ClaudeSession extends EventEmitter {
  constructor(opts) {
    super();
    this.bin = opts.claudeBin;
    this.cwd = opts.workdir;
    this.model = opts.model || null;
    this.allowedTools = opts.allowedTools || 'Read,Glob,Grep';
    this.idleTimeoutMs = (opts.idleTimeoutMin || 30) * 60 * 1000;

    // Backend switching. Measured 2026-10-04: setting ANTHROPIC_BASE_URL in the
    // child process env is SILENTLY IGNORED — ~/.claude/settings.json's `env`
    // block wins and the request goes to the configured relay anyway. Passing
    // `--settings <json>` DOES take effect. So a backend is expressed as the
    // settings overlay the CLI merges on top of the user's own config.
    this.backends = opts.backends || null;
    this.activeBackend = opts.activeBackend || null;
    // A backend that is merely unreachable produces NO events at all — measured:
    // 60s of `system` chatter and not one error. Without a watchdog the phone
    // spins forever with nothing to report. 0 disables the watchdog.
    this.turnTimeoutMs = Number(opts.turnTimeoutSec) > 0
      ? Number(opts.turnTimeoutSec) * 1000
      : 0;

    this.proc = null;
    this.queue = [];
    this.inFlight = null;
    this.turnSeq = 0;
    this.turnStart = null;
    // Last cumulative cost reported by `result`. Reset on every spawn: a new process
    // is a new session, so its total_cost_usd starts from zero again.
    this.lastCumulativeCost = 0;
    this.lastActivity = Date.now();
    this.idleTimer = null;
    this.turnTimer = null;
    this.starting = false;
    this.stderrTail = [];
  }

  /** Public description of the backend in force, for the status/ready payload. */
  backendInfo() {
    if (!this.backends || !this.activeBackend) return null;
    const b = this.backends[this.activeBackend];
    if (!b) return { name: this.activeBackend, label: this.activeBackend, known: false };
    // The base URL is shown because "which backend am I even on" is the first
    // question when a switch breaks things. Only the host, never the token.
    let host = null;
    const url = b.env && (b.env.ANTHROPIC_BASE_URL || b.env.ANTHROPIC_API_URL);
    if (url) { try { host = new URL(url).host; } catch { host = '(无法解析的 URL)'; } }
    return {
      name: this.activeBackend,
      label: b.label || this.activeBackend,
      host,
      known: true,
    };
  }

  /** Swap the active backend. The process must restart: the overlay is a spawn
   *  argument, and a live process keeps the credentials it booted with. */
  setBackend(name) {
    if (!this.backends) return { ok: false, error: '没有配置 backends' };
    if (!Object.prototype.hasOwnProperty.call(this.backends, name)) {
      return { ok: false, error: `没有名为 "${name}" 的后端` };
    }
    this.activeBackend = name;
    this.stop('backend-switch');
    this.start();
    return { ok: true, backend: this.backendInfo() };
  }

  // ---- lifecycle -----------------------------------------------------------

  isAlive() {
    return !!this.proc && this.proc.exitCode === null;
  }

  start() {
    if (this.isAlive() || this.starting) return;
    if (!fs.existsSync(this.cwd)) {
      this.emit('fatal', { reason: 'workdir-missing', detail: this.cwd });
      return;
    }
    if (!fs.existsSync(this.bin)) {
      this.emit('fatal', { reason: 'claude-binary-missing', detail: this.bin });
      return;
    }

    this.starting = true;
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--allowedTools', this.allowedTools,
    ];
    if (this.model) args.push('--model', this.model);

    // Backend overlay. Verified to outrank ~/.claude/settings.json, which the
    // process env does not — see the constructor note.
    const backend = this.backends && this.backends[this.activeBackend];
    if (backend && backend.env && Object.keys(backend.env).length) {
      args.push('--settings', JSON.stringify({ env: backend.env }));
    }

    let proc;
    try {
      proc = spawn(this.bin, args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this.starting = false;
      this.emit('fatal', { reason: 'spawn-failed', detail: err.message });
      return;
    }
    this.proc = proc;
    // New process => new session => cost accumulation starts over.
    this.lastCumulativeCost = 0;

    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          this.emit('log', { level: 'warn', msg: 'unparseable NDJSON line', line: line.slice(0, 200) });
          continue;
        }
        this.lastActivity = Date.now();
        this.#dispatch(obj);
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      const s = chunk.trim();
      if (!s) return;
      this.stderrTail.push(s);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
      this.emit('log', { level: 'error', msg: s.slice(0, 400) });
    });

    proc.on('error', (err) => {
      this.starting = false;
      this.emit('fatal', { reason: 'process-error', detail: err.message });
    });

    proc.on('close', (code, signal) => {
      this.starting = false;
      const wasInFlight = this.inFlight;
      this.proc = null;
      this.inFlight = null;
      this._clearIdle();
      // A turn that was running when the process died never produced a `result`.
      // Close it explicitly so the UI cannot hang waiting for one.
      if (wasInFlight) {
        this.emit('turn_end', { index: wasInFlight.index, aborted: true, error: stopReasonText('process-exit') });
      }
      this.emit('session_end', {
        code,
        signal,
        stderr: this.stderrTail.slice(-5),
        turn: this.turnSeq,
      });
      // Drain anything that was queued but never started.
      this.queue = [];
    });

    this.starting = false;
    this._armIdle();
  }

  _armIdle() {
    this._clearIdle();
    this.idleTimer = setTimeout(() => {
      this.emit('log', { level: 'warn', msg: `idle ${this.idleTimeoutMs / 60000}min — stopping claude` });
      this.stop('idle-timeout');
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  _clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * Watchdog for a turn that never comes back.
   *
   * Measured 2026-10-04 against an unreachable base URL: the CLI emitted `system`
   * events for over a minute and then NOTHING — no result, no stderr, no exit.
   * The phone's only signal is the absence of events, which renders as an
   * indefinite spinner. A bad model name fails fast and loudly, so silence is
   * specifically the "cannot reach the backend" signature.
   */
  _armTurnTimeout(index) {
    this._clearTurnTimeout();
    if (!this.turnTimeoutMs) return;
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      if (!this.inFlight || this.inFlight.index !== index) return;
      const waited = Math.round((Date.now() - this.turnStart) / 1000);
      this.emit('log', {
        level: 'warn',
        msg: `turn ${index}: no result after ${waited}s — treating as unreachable backend`,
      });
      this.inFlight = null;
      this.emit('turn_end', {
        index,
        subtype: 'error_timeout',
        isError: true,
        timedOut: true,
        result: `连接后端超时：${waited} 秒内没有收到任何结果。`
          + '后端地址可能不可达、token 失效，或模型名不被该后端支持。',
        cost: 0,
        sessionCost: this.lastCumulativeCost,
        durationMs: Date.now() - this.turnStart,
        permissionDenials: [],
      });
      this.#pump();
    }, this.turnTimeoutMs);
    this.turnTimer.unref?.();
  }

  _clearTurnTimeout() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
  }

  stop(reason = 'requested') {
    const wasInFlight = this.inFlight;
    if (this.proc) {
      try { this.proc.kill(); } catch { /* already gone */ }
    }
    this.proc = null;
    this.inFlight = null;
    this.queue = [];
    this._clearTurnTimeout();
    this._clearIdle();
    // 我们把进程拆了，这一轮就永远等不到 CLI 侧的 `result`，也就永远不会有
    // turn_end。close 处理器补不上这个洞——它读的是 this.inFlight，而我们上面
    // 已经置空了。不在这里收尾的话，手机上那一轮的页脚永远不出现（用户只看到
    // 提示说停了，却看不到"已中止"和花了多少钱），而按 turn_end 判轮次边界的
    // 客户端（比如 verify-2turn）会一直等下去。
    if (wasInFlight) {
      this.emit('turn_end', { index: wasInFlight.index, aborted: true, error: stopReasonText(reason) });
    }
    this.emit('log', { level: 'info', msg: `session stopped: ${reason}` });
  }

  /**
   * There is no documented way to interrupt a single `-p` turn, so aborting means
   * killing the process — which costs the conversation history. The UI must say so.
   */
  abort() {
    if (!this.inFlight) {
      this.queue = [];
      this.emit('log', { level: 'info', msg: 'abort: nothing in flight, queue cleared' });
      return { aborted: false };
    }
    const index = this.inFlight.index;
    this.stop('aborted');
    return { aborted: true, turn: index, contextLost: true };
  }

  // ---- turn queue ----------------------------------------------------------

  /**
   * @returns {{queued:boolean, index:number|null, position:number}} accepted into
   *          the queue; the caller must not assume the turn has started.
   */
  send(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return { queued: false, index: null, position: -1, error: 'empty' };

    if (!this.isAlive()) this.start();

    const item = { text: trimmed, index: ++this.turnSeq };
    this.queue.push(item);

    if (this.inFlight) {
      return { queued: true, index: item.index, position: this.queue.length };
    }
    this.#pump();
    return { queued: true, index: item.index, position: this.queue.length };
  }

  #pump() {
    if (this.inFlight || this.queue.length === 0) return;
    if (!this.isAlive()) {
      // The process died before we got here; the turn is lost, do not silently stall.
      const lost = this.queue.shift();
      this.emit('turn_end', { index: lost.index, aborted: true, error: stopReasonText('not-running') });
      return;
    }

    const item = this.queue.shift();
    this.inFlight = item;
    this.turnStart = Date.now();
    this._armIdle();
    this._armTurnTimeout(item.index);

    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: item.text }] },
    });

    this.emit('turn_start', { index: item.index, queued: this.queue.length });
    try {
      this.proc.stdin.write(line + '\n');
    } catch (err) {
      this.inFlight = null;
      this.emit('turn_end', { index: item.index, aborted: true, error: err.message });
    }
  }

  // ---- NDJSON dispatch -----------------------------------------------------

  #dispatch(obj) {
    this.emit('raw', obj);

    switch (obj.type) {
      case 'system':
        if (obj.subtype === 'init') {
          this.emit('init', obj);
        } else if (obj.subtype === 'thinking_tokens') {
          this.emit('thinking_tokens', obj);
        }
        break;

      case 'assistant':
        for (const block of obj.message?.content || []) {
          if (block.type === 'text') {
            this.emit('text', { index: this.inFlight?.index ?? null, text: block.text });
          } else if (block.type === 'thinking') {
            this.emit('thinking', { index: this.inFlight?.index ?? null, text: block.thinking || '' });
          } else if (block.type === 'tool_use') {
            this.emit('tool_use', {
              index: this.inFlight?.index ?? null,
              id: block.id,
              name: block.name,
              input: block.input || {},
            });
          }
        }
        // Every assistant message carries a cumulative usage snapshot — this is
        // the only live cost signal available before the turn closes.
        if (obj.message?.usage) {
          this.emit('usage', {
            index: this.inFlight?.index ?? null,
            usage: obj.message.usage,
          });
        }
        break;

      case 'user':
        for (const block of obj.message?.content || []) {
          if (block.type === 'tool_result') {
            const c = block.content;
            const text = typeof c === 'string' ? c : JSON.stringify(c);
            this.emit('tool_result', {
              index: this.inFlight?.index ?? null,
              id: block.tool_use_id,
              isError: !!block.is_error,
              text: text || '',
              bytes: Buffer.byteLength(text || '', 'utf8'),
            });
          }
        }
        break;

      case 'result': {
        // A `result` with nothing in flight is a duplicate or an arrival after
        // the watchdog already closed the turn. Counting it again would inflate
        // turnCount and emit a second footer for a turn the user already saw.
        if (!this.inFlight) {
          this.emit('log', { level: 'warn', msg: 'ignoring stray result (no turn in flight)' });
          break;
        }
        const idx = this.inFlight.index;
        this.inFlight = null;
        this._clearTurnTimeout();

        // total_cost_usd is cumulative across the process session (measured 2026-10-03:
        // turn 1 -> 0.0246, turn 2 -> 0.6398 in the same process). This layer owns the
        // state needed to split it, so the cost delta is computed HERE and nowhere
        // else. Everything downstream (wire `cost`, the per-turn brake, the phone's
        // running total) wants the per-turn number.
        const cumulative = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null;
        const turnCost = cumulative == null ? null : Math.max(0, cumulative - this.lastCumulativeCost);
        if (cumulative != null) this.lastCumulativeCost = cumulative;

        this.emit('turn_end', {
          index: idx,
          subtype: obj.subtype,
          isError: !!obj.is_error,
          numTurns: obj.num_turns,
          resultIndex: obj.result_index,
          result: obj.result || '',
          cost: turnCost,
          sessionCost: cumulative,
          durationMs: obj.duration_ms ?? null,
          usage: obj.usage || null,
          modelUsage: obj.modelUsage || null,
          permissionDenials: obj.permission_denials || [],
        });
        this.#pump();
        break;
      }

      default:
        break;
    }
  }
}

module.exports = { ClaudeSession };
