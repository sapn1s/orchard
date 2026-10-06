#!/usr/bin/env node
/**
 * BUG-187 — a scripted stream-json `claude` for the responderless-CLI verifier.
 *
 * It speaks the parts of the CLI control protocol the bug lives in, modelled on
 * what the round-2 probe and arm A17 measured on the real CLI 2.1.281:
 *   - `initialize` (first AND repeated). A repeated initialize first emits
 *     `control_cancel_request` for every pending hook callback (the real CLI
 *     resolves those itself — "the SDK host reconnected"), then answers with
 *     `hooks_applied` and `pending_permission_requests` (the SAME request ids,
 *     redelivered), then a `background_tasks_changed` snapshot.
 *   - background lanes via `task_started` / `background_tasks_changed` /
 *     `task_notification`, including a REVIVAL (a fresh `task_started` for an
 *     id that already finished).
 *   - `hook_callback` and `can_use_tool` requests attributed to a lane
 *     (`input.agent_id` / top-level `agent_id`), sequential per lane like the
 *     real CLI: the next request only after the previous one was answered.
 *   - `control_cancel_request`, `stop_task`.
 *
 * Driven by the harness through a command directory (FAKE_CMD_DIR): each
 * `<n>-*.json` file is one command, executed once in name order. Everything
 * the fake reads on stdin is appended to FAKE_TAP (the "stdin tap"), and every
 * request/answer pair to FAKE_LOG with its latency.
 *
 * Env knobs: FAKE_OMIT_HOOKS_APPLIED=1 (an "old CLI" that answers a repeated
 * initialize without the field), FAKE_IGNORE_EOF=1 (stay alive after stdin EOF
 * while any lane lives — the real CLI's posture), FAKE_SDK_ID.
 * FAKE_TRANSCRIPT_DIR (BUG-217 round 5, opt-in): append each user message and
 * the turn's reply to `<dir>/<FAKE_SDK_ID>.jsonl`, as the real CLI records what
 * it took — the receiver's own record the outbox confirms a delivery from.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

// Per-process: several fakes may share one harness dir (one per session), so
// every path is suffixed with this process's pid, which the harness reads from
// the broker's status record (`claudePid`).
const CMD_DIR = process.env.FAKE_CMD_DIR ? path.join(process.env.FAKE_CMD_DIR, String(process.pid)) : null;
const TAP = process.env.FAKE_TAP ? `${process.env.FAKE_TAP}.${process.pid}` : null;
const LOG = process.env.FAKE_LOG ? `${process.env.FAKE_LOG}.${process.pid}` : null;
if (CMD_DIR) { try { fs.mkdirSync(CMD_DIR, { recursive: true }); } catch { /* ignore */ } }
const SDK_ID = process.env.FAKE_SDK_ID || `fake187-${process.pid}`;
const OMIT_HOOKS_APPLIED = process.env.FAKE_OMIT_HOOKS_APPLIED === '1';
if (process.env.FAKE_IGNORE_TERM === '1') process.on('SIGTERM', () => { /* a CLI that ignores TERM: only KILL ends it */ });
let omitRedeliver = 0; // how many of the oldest pending permission ids the next initialize answer omits
// BUG-191: hold the answer to a REPEATED initialize this long (ms; <0 = never) —
// an adoption that stays `pending` for a controlled window. Set by the
// `reinit_delay` op (or FAKE_REINIT_DELAY_MS) before the server restart.
let reinitDelayMs = Number(process.env.FAKE_REINIT_DELAY_MS ?? 0) || 0;

const t0 = Date.now();
const say = (o) => { try { process.stdout.write(`${JSON.stringify(o)}\n`); } catch { /* gone */ } };
const log = (o) => { if (LOG) { try { fs.appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), ...o })}\n`); } catch { /* ignore */ } } };
const tap = (line) => { if (TAP) { try { fs.appendFileSync(TAP, `${JSON.stringify({ at: Date.now(), line })}\n`); } catch { /* ignore */ } } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let initCount = 0;
let hookCallbackId = null; // from the latest initialize that carried hooks
let stdinEnded = false;
/** laneId → { type, started, ended } */
const lanes = new Map();
const finished = new Set();
/** request_id → { kind, lane, at, resolve } */
const pending = new Map();
let reqSeq = 0;

function level() {
  const tasks = [...lanes].filter(([, l]) => !l.ended).map(([id, l]) => ({ task_id: id, task_type: l.type, description: `lane ${id}` }));
  say({ type: 'system', subtype: 'background_tasks_changed', tasks, session_id: SDK_ID });
}
function laneStart(id, type = 'local_agent', { noLevel = false } = {}) {
  lanes.set(id, { type, started: Date.now(), ended: false });
  if (!noLevel) level();
  say({ type: 'system', subtype: 'task_started', task_id: id, description: `lane ${id}`, task_type: type, is_backgrounded: true, session_id: SDK_ID });
}
function laneEnd(id, status = 'completed', { noLevel = false } = {}) {
  const l = lanes.get(id);
  if (!l || l.ended) return;
  l.ended = true;
  finished.add(id);
  if (!noLevel) level();
  say({ type: 'system', subtype: 'task_notification', task_id: id, status, output_file: '', summary: status, session_id: SDK_ID });
  maybeExitAfterEof();
}
function laneAlive(id) { const l = lanes.get(id); return !!l && !l.ended; }

/** Emit one control request and resolve with the answer (or the cancel). */
function request(kind, lane, extra = {}) {
  const id = `fake-req-${++reqSeq}`;
  let request;
  if (kind === 'hook') {
    request = {
      subtype: 'hook_callback',
      callback_id: hookCallbackId ?? 'hook_0',
      tool_use_id: `tu-${id}`,
      input: {
        hook_event_name: 'PreToolUse', session_id: SDK_ID, transcript_path: '', cwd: process.cwd(),
        tool_name: extra.tool ?? 'Bash', tool_input: extra.toolInput ?? { command: 'echo fake' }, tool_use_id: `tu-${id}`,
        ...(lane ? { agent_id: lane, agent_type: 'general-purpose' } : {}),
      },
    };
  } else {
    request = {
      subtype: 'can_use_tool', tool_name: extra.tool ?? 'Write', input: extra.toolInput ?? { file_path: '/tmp/x', content: 'x' },
      tool_use_id: `tu-${id}`, ...(lane ? { agent_id: lane } : {}),
    };
  }
  const frame = { type: 'control_request', request_id: id, request };
  const p = new Promise((resolve) => pending.set(id, { kind, lane, at: Date.now(), frame, resolve }));
  log({ ev: 'request', id, kind, lane });
  say(frame);
  return { id, p };
}

function answerOf(resp) {
  const r = resp?.response;
  if (resp?.subtype === 'error') return { verdict: 'error', text: resp.error };
  if (r?.hookSpecificOutput?.permissionDecision) return { verdict: r.hookSpecificOutput.permissionDecision, text: r.hookSpecificOutput.permissionDecisionReason ?? '' };
  if (r?.behavior) return { verdict: r.behavior, text: r.message ?? '' };
  return { verdict: 'allow', text: '' };
}

/** A lane that keeps calling tools: each call waits for its answer, then pauses. */
async function loopLane(lane, { everyMs = 1000, count = 1e9, kind = 'hook', endAfter = null } = {}) {
  let n = 0;
  const until = endAfter ? Date.now() + endAfter : Infinity;
  while (laneAlive(lane) && n < count && Date.now() < until) {
    const { p } = request(kind, lane);
    const res = await p;
    n++;
    if (!laneAlive(lane)) break;
    say({ type: 'assistant', parent_tool_use_id: `tu-parent-${lane}`, message: { content: [{ type: 'text', text: `lane ${lane} call ${n}: ${res.verdict}` }] }, session_id: SDK_ID });
    await sleep(everyMs);
  }
  if (laneAlive(lane) && (n >= count || Date.now() >= until)) laneEnd(lane);
}

function maybeExitAfterEof() {
  if (!stdinEnded) return;
  if (process.env.FAKE_EOF_MODE === 'ignore') return; // a CLI wedged after EOF (the escalation must bound it)
  const live = [...lanes.values()].some((l) => !l.ended);
  if (!live || process.env.FAKE_IGNORE_EOF !== '1') {
    log({ ev: 'exit', reason: 'stdin-eof' });
    setTimeout(() => process.exit(0), 50);
  }
}

function onInitialize(m) {
  if (initCount >= 1 && reinitDelayMs !== 0) {
    const d = reinitDelayMs;
    log({ ev: 'reinit-held', ms: d });
    if (d < 0) { initCount++; return; } // never answered: the adoption times out
    setTimeout(() => onInitializeNow(m), d);
    return;
  }
  return onInitializeNow(m);
}
function onInitializeNow(m) {
  initCount++;
  const hooks = m.request?.hooks;
  const carried = !!hooks && typeof hooks === 'object' && Object.keys(hooks).length > 0;
  if (carried) {
    const pre = hooks.PreToolUse?.[0]?.hookCallbackIds?.[0];
    if (pre) hookCallbackId = pre;
  }
  if (initCount > 1) {
    // The real CLI resolves its pending hook callbacks itself on a repeated
    // initialize: cancel at this host, deny with a retry notice (probe).
    for (const [id, p] of [...pending]) {
      if (p.kind !== 'hook') continue;
      say({ type: 'control_cancel_request', request_id: id });
      pending.delete(id);
      log({ ev: 'cancelled', id, lane: p.lane, byReinit: true });
      p.resolve({ verdict: 'cancelled', text: 'The SDK host reconnected before its PreToolUse hook answered' });
    }
  }
  const pendingPerms = [...pending.values()].filter((p) => p.kind === 'perm').map((p) => p.frame).slice(omitRedeliver);
  omitRedeliver = 0;
  const response = { commands: [], models: [], account: {}, pending_permission_requests: pendingPerms, pending_user_dialog_requests: [] };
  if (carried && !(OMIT_HOOKS_APPLIED && initCount > 1)) response.hooks_applied = true;
  say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response, pending_permission_requests: pendingPerms, pending_user_dialog_requests: [] } });
  log({ ev: 'initialize', n: initCount, carriedHooks: carried, redelivered: pendingPerms.map((f) => f.request_id) });
  if (initCount > 1) level();
}

let turn = 0;
function record(role, text) {
  const dir = process.env.FAKE_TRANSCRIPT_DIR;
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    const row = role === 'user'
      ? { type: 'user', uuid: `u-fake-${process.pid}-${turn}`, sessionId: SDK_ID, cwd: process.cwd(), timestamp: at, message: { role: 'user', content: text } }
      : { type: 'assistant', uuid: `a-fake-${process.pid}-${turn}`, sessionId: SDK_ID, cwd: process.cwd(), timestamp: at, message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text }] } };
    // FEAT-168 r6 (opt-in): the fields CLI >= 2.1.197 writes on a prompt that came
    // in through stdin (`promptSource:"sdk"`, `promptId`, `version`), so a suite can
    // grade a reader against the modern record shape. Off by default: other suites
    // keep the exact rows they were written against.
    if (process.env.FAKE_TRANSCRIPT_SHAPE === 'modern') {
      row.version = '2.1.286';
      if (role === 'user') { row.promptSource = 'sdk'; row.promptId = `p-fake-${process.pid}-${turn}`; row.isSidechain = false; row.userType = 'external'; }
    }
    fs.appendFileSync(path.join(dir, `${SDK_ID}.jsonl`), `${JSON.stringify(row)}\n`);
  } catch { /* the transcript is best-effort in a fake */ }
}
async function runTurn(text) {
  turn++;
  record('user', String(text));
  say({ type: 'system', subtype: 'init', session_id: SDK_ID, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [], mcp_servers: [] });
  say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [{ type: 'text', text: `turn ${turn}: ${String(text).slice(0, 60)}` }] }, session_id: SDK_ID });
  // A directive in the prompt lets a harness shape the first turn without a command file.
  const dm = /\[\[fake:(.*?)\]\]/.exec(String(text));
  if (dm) {
    try {
      const d = JSON.parse(dm[1]);
      for (const c of Array.isArray(d) ? d : [d]) await runCommand(c);
    } catch (e) { log({ ev: 'bad-directive', e: String(e) }); }
  }
  record('assistant', `turn ${turn}: ${String(text).slice(0, 60)}`);
  say({ type: 'result', subtype: 'success', total_cost_usd: 0, session_id: SDK_ID });
}

async function runCommand(c) {
  log({ ev: 'cmd', op: c.op, c });
  switch (c.op) {
    case 'lane_start': laneStart(c.id, c.type, { noLevel: !!c.noLevel }); break;
    case 'lane_end': laneEnd(c.id, c.status ?? 'completed', { noLevel: !!c.noLevel }); break;
    case 'revive': {
      // A SendMessage revival: a fresh task_started for an id that already
      // finished. `withLevel` also re-lists it in the level (what the real CLI
      // did in the incident); without it the level stays as it was.
      const l = lanes.get(c.id);
      lanes.set(c.id, { type: l?.type ?? 'local_agent', started: Date.now(), ended: false });
      if (c.withLevel) level();
      say({ type: 'system', subtype: 'task_started', task_id: c.id, description: `revived ${c.id}`, task_type: 'local_agent', is_backgrounded: true, session_id: SDK_ID });
      break;
    }
    case 'level': say({ type: 'system', subtype: 'background_tasks_changed', tasks: (c.ids ?? []).map((id) => ({ task_id: id, task_type: 'local_agent', description: id })), session_id: SDK_ID }); break;
    case 'hook': { const { p } = request('hook', c.lane ?? null, c); if (c.await) await p; break; }
    case 'perm': { const { p } = request('perm', c.lane ?? null, c); if (c.await) await p; break; }
    case 'loop': void loopLane(c.lane, c); break;
    case 'emit': for (const f of (Array.isArray(c.frames) ? c.frames : [c.frame])) say(f); break;
    case 'emit_raw': process.stdout.write(c.text); break;
    case 'sleep': await sleep(c.ms ?? 1000); break;
    case 'turn': await runTurn(c.text ?? 'scripted turn'); break;
    case 'mid_turn_open': say({ type: 'system', subtype: 'init', session_id: SDK_ID, cwd: process.cwd(), model: 'haiku', tools: [] }); say({ type: 'assistant', message: { content: [{ type: 'text', text: 'working…' }] }, session_id: SDK_ID }); break;
    case 'result': say({ type: 'result', subtype: 'success', total_cost_usd: 0, session_id: SDK_ID }); break;
    case 'exit': process.exit(c.code ?? 0); break;
    case 'cancel': {
      // The CLI withdraws a pending request (e.g. the turn was interrupted).
      const ids = c.id ? [c.id] : [...pending.keys()].slice(-1);
      for (const id of ids) {
        const p = pending.get(id);
        if (!p) continue;
        pending.delete(id);
        say({ type: 'control_cancel_request', request_id: id });
        log({ ev: 'cancelled', id, lane: p.lane, byReinit: false });
        p.resolve({ verdict: 'cancelled', text: '' });
      }
      break;
    }
    case 'omit_redeliver': omitRedeliver = c.n ?? 1; break;
    case 'reinit_delay': reinitDelayMs = Number(c.ms ?? 0) || 0; break;
    case 'burst': {
      // N request/cancel pairs in quick succession: ledger traffic that settles
      // every id at once (BUG-187 round 2: crossing the old 4000-entry cap).
      const n = c.n ?? 4500;
      let out = '';
      for (let i = 0; i < n; i++) {
        const id = `burst-${i}`;
        out += `${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'hook_callback', callback_id: hookCallbackId ?? 'hook_0', input: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' } } } })}\n`;
        out += `${JSON.stringify({ type: 'control_cancel_request', request_id: id })}\n`;
        if (out.length > 1_000_000) { process.stdout.write(out); out = ''; await sleep(5); }
      }
      if (out) process.stdout.write(out);
      log({ ev: 'burst-done', n });
      break;
    }
    case 'emit_split': {
      // One JSON line written in pieces with pauses — a partial read for the broker.
      const text = `${JSON.stringify(c.frame)}\n`;
      const cuts = [...(c.at ?? [5])].sort((a, b) => a - b).filter((x) => x > 0 && x < text.length);
      let prev = 0;
      for (const cut of [...cuts, text.length]) { process.stdout.write(text.slice(prev, cut)); prev = cut; await sleep(c.gapMs ?? 150); }
      if (c.frame?.type === 'control_request') {
        const id = c.frame.request_id;
        pending.set(id, { kind: c.frame.request.subtype === 'can_use_tool' ? 'perm' : 'hook', lane: null, at: Date.now(), frame: c.frame, resolve: () => {} });
        log({ ev: 'request', id, kind: 'split', lane: null });
      }
      break;
    }
    default: log({ ev: 'unknown-op', op: c.op });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  tap(line);
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (!m || typeof m !== 'object') return;
  if (m.type === 'control_request') {
    const sub = m.request?.subtype;
    if (sub === 'initialize') return onInitialize(m);
    if (sub === 'stop_task') {
      say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
      log({ ev: 'stop_task', lane: m.request.task_id });
      if (process.env.FAKE_IGNORE_STOP === '1') return; // an engine slow to honour a stop: the lane stays listed
      // Stopping a lane ends it: its pending requests are withdrawn.
      for (const [id, p] of [...pending]) if (p.lane === m.request.task_id) { pending.delete(id); p.resolve({ verdict: 'stopped', text: '' }); }
      setTimeout(() => laneEnd(m.request.task_id, 'stopped'), 200);
      return;
    }
    // Anything else (mcp status, set_model, …): acknowledge.
    say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    return;
  }
  if (m.type === 'control_response') {
    const id = m.response?.request_id;
    const p = pending.get(id);
    const a = answerOf(m.response);
    if (!p) { log({ ev: 'answer-unmatched', id, ...a }); return; }
    pending.delete(id);
    log({ ev: 'answer', id, lane: p.lane, kind: p.kind, latencyMs: Date.now() - p.at, ...a });
    p.resolve(a);
    return;
  }
  if (m.type === 'user') {
    log({ ev: 'user-frame', text: JSON.stringify(m.message).slice(0, 200) });
    const text = Array.isArray(m.message?.content) ? m.message.content.map((b) => b?.text ?? '').join('') : String(m.message?.content ?? '');
    void runTurn(text);
  }
});
rl.on('close', () => { stdinEnded = true; log({ ev: 'stdin-eof' }); maybeExitAfterEof(); });

if (CMD_DIR) {
  const done = new Set();
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const names = fs.readdirSync(CMD_DIR).filter((n) => n.endsWith('.json') && !done.has(n)).sort();
      for (const n of names) {
        done.add(n);
        let c;
        try { c = JSON.parse(fs.readFileSync(path.join(CMD_DIR, n), 'utf8')); } catch { continue; }
        await runCommand(c);
      }
    } catch { /* dir gone */ }
    busy = false;
  }, 100);
}
log({ ev: 'start', pid: process.pid, t0 });
