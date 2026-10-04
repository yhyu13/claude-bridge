'use strict';
/**
 * translator.js — Claude NDJSON -> bridge wire protocol.
 *
 * Deliberately pure: no I/O, no state that outlives a call. That is what makes it
 * testable against docs/protocol-sample.ndjson instead of against a live model.
 *
 * Wire protocol (server -> phone), per DESIGN.md §4:
 *   ready | turn | thinking | text | tool | tool_result | turn_end | state | fatal
 * Wire protocol (phone -> server), handled in bridge.js:
 *   prompt | abort | kill | ping
 */

const DANGEROUS_DEFAULT = [
  'rm -rf', 'rm -fr', 'Remove-Item -Recurse -Force', 'del /f',
  'format ', 'diskpart', 'git push --force', 'git push -f', 'git reset --hard',
];

/** Build the client-ready snapshot from a `system/init` event. */
function fromInit(obj) {
  const o = obj || {};
  return {
    t: 'ready',
    sessionId: o.session_id || null,
    cwd: o.cwd || null,
    model: o.model || null,
    version: o.claude_code_version || null,
    permissionMode: o.permissionMode || null,
    // Never leak credentials: only the *source* is reported, never the key.
    apiKeySource: o.apiKeySource ?? null,
    tools: Array.isArray(o.tools) ? o.tools : [],
    toolCount: Array.isArray(o.tools) ? o.tools.length : 0,
    mcpServers: (o.mcp_servers || []).map((m) => ({
      name: m.name, status: m.status, source: m.source,
    })),
    agents: Array.isArray(o.agents) ? o.agents : [],
    skills: Array.isArray(o.skills) ? o.skills : [],
    plugins: Array.isArray(o.plugins) ? o.plugins : [],
  };
}

function fromThinkingTokens(obj) {
  return {
    t: 'thinking',
    tokens: obj.estimated_tokens ?? 0,
    delta: obj.estimated_tokens_delta ?? 0,
  };
}

/**
 * @param {object} obj   a parsed NDJSON object
 * @param {object} ctx   { turnIndex, patterns, onDanger }
 * @returns {object|null} one wire message, or null if the event carries nothing
 *                        the UI needs.
 */
function translate(obj, ctx = {}) {
  if (!obj || typeof obj !== 'object') return null;
  const patterns = ctx.patterns && ctx.patterns.length ? ctx.patterns : DANGEROUS_DEFAULT;

  switch (obj.type) {
    case 'system':
      if (obj.subtype === 'init') return fromInit(obj);
      if (obj.subtype === 'thinking_tokens') return fromThinkingTokens(obj);
      return null;

    case 'assistant': {
      const usage = obj.message?.usage;
      const usagePatch = usage
        ? {
            output: usage.output_tokens ?? 0,
            thinking: usage.output_tokens_details?.thinking_tokens ?? 0,
            cacheCreate: usage.cache_creation_input_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
          }
        : null;

      // One assistant message can carry several blocks; emit the first meaningful
      // one here and let the caller drain the rest via translateAssistantBlocks().
      const blocks = obj.message?.content || [];
      for (const b of blocks) {
        if (b.type === 'tool_use') {
          const danger = findDanger(b.input || {}, patterns);
          return {
            t: 'tool',
            turn: ctx.turnIndex ?? null,
            id: b.id,
            name: b.name,
            input: b.input || {},
            danger: danger || null,
            usage: usagePatch,
          };
        }
        if (b.type === 'text' && b.text) {
          return { t: 'text', turn: ctx.turnIndex ?? null, text: b.text, usage: usagePatch };
        }
        if (b.type === 'thinking') {
          // usagePatch must ride along here too: Claude Code emits an
          // assistant[thinking] message at the start of nearly every turn, so
          // dropping it would blind live cost tracking for most turns.
          return { t: 'thinking_text', turn: ctx.turnIndex ?? null, text: b.thinking || '', usage: usagePatch };
        }
      }
      return usagePatch ? { t: 'usage', usage: usagePatch, turn: ctx.turnIndex ?? null } : null;
    }

    case 'user': {
      for (const b of obj.message?.content || []) {
        if (b.type !== 'tool_result') continue;
        const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
        return {
          t: 'tool_result',
          turn: ctx.turnIndex ?? null,
          id: b.tool_use_id,
          ok: !b.is_error,
          preview: (text || '').slice(0, 2000),
          bytes: Buffer.byteLength(text || '', 'utf8'),
        };
      }
      return null;
    }

    case 'result': {
      // `total_cost_usd` is CUMULATIVE for the whole process session, not for this
      // turn (measured: turn 1 -> 0.0246, turn 2 -> 0.6398, same process).
      // `result.usage` IS per-turn. Callers that keep state pass the previous
      // cumulative value as ctx.costBase and get a per-turn delta; without a base
      // this degrades to "cumulative so far", which is all a pure function can know.
      const cumulative = obj.total_cost_usd ?? null;
      const base = typeof ctx.costBase === 'number' ? ctx.costBase : 0;
      return {
        t: 'turn_end',
        turn: obj.result_index ?? null,
        subtype: obj.subtype,
        ok: obj.subtype === 'success' && !obj.is_error,
        result: obj.result || '',
        cost: cumulative == null ? null : Math.max(0, cumulative - base),
        sessionCost: cumulative,
        numTurns: obj.num_turns ?? null,
        durationMs: obj.duration_ms ?? null,
        usage: obj.usage || null,
        denied: obj.permission_denials || [],
        apiError: obj.api_error_status ?? null,
      };
    }

    default:
      return null;
  }
}

/** Drain every block of one assistant message (translator returns only the first). */
function translateAssistantBlocks(obj, ctx = {}) {
  const out = [];
  const usage = obj.message?.usage;
  const usagePatch = usage
    ? {
        output: usage.output_tokens ?? 0,
        thinking: usage.output_tokens_details?.thinking_tokens ?? 0,
        cacheCreate: usage.cache_creation_input_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
      }
    : null;
  for (const b of obj.message?.content || []) {
    if (b.type === 'text' && b.text) {
      out.push({ t: 'text', turn: ctx.turnIndex ?? null, text: b.text });
    } else if (b.type === 'thinking') {
      out.push({ t: 'thinking_text', turn: ctx.turnIndex ?? null, text: b.thinking || '' });
    } else if (b.type === 'tool_use') {
      const danger = findDanger(b.input || {}, ctx.patterns);
      out.push({
        t: 'tool',
        turn: ctx.turnIndex ?? null,
        id: b.id,
        name: b.name,
        input: b.input || {},
        danger: danger || null,
      });
    }
  }
  if (usagePatch) out.push({ t: 'usage', turn: ctx.turnIndex ?? null, usage: usagePatch });
  return out;
}

/** Recursively look for a dangerous shell command anywhere in a tool's input. */
function findDanger(input, patterns) {
  const needle = JSON.stringify(input);
  const hay = String(needle).toLowerCase();
  for (const p of patterns) {
    if (hay.includes(String(p).toLowerCase())) {
      return { pattern: p, command: extractCommand(input) };
    }
  }
  return null;
}

function extractCommand(input) {
  if (!input || typeof input !== 'object') return String(input);
  for (const k of ['command', 'cmd', 'script', 'args']) {
    if (input[k]) return String(input[k]);
  }
  return JSON.stringify(input).slice(0, 300);
}

module.exports = {
  translate,
  translateAssistantBlocks,
  fromInit,
  findDanger,
  DANGEROUS_DEFAULT,
};
