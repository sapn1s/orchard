#!/usr/bin/env node
/**
 * BUG-231 fake `claude` CLI — enough of the stream-json control protocol for a REAL
 * ClaudeRuntime (inside a scratch server) to launch it, and to behave like the real
 * CLI's Bash tool around the runtime's hooks:
 *
 *   PreToolUse hook → (deny: stop) → run the command with `bash -c` in $FAKE_REPO,
 *   with THIS process's env (so the session's git shim is first on PATH, exactly as
 *   the real CLI's Bash tool) → PostToolUse (exit 0) or PostToolUseFailure (non-zero)
 *   if the runtime registered those hooks.
 *
 * A user turn whose text is `[[bash]]{json}` runs one Bash "tool call". json:
 *   { tag, command, skipPost?: bool, permissionDeny?: bool, background?: bool }
 *   skipPost       — never send the Post hook (a killed tool call: an ORPHAN)
 *   permissionDeny — after a PreToolUse allow, the permission layer denies: the
 *                    command never runs; a PermissionDenied hook is sent if registered
 * One JSON line per call is appended to $FAKE_RESULTS:
 *   { tag, toolUseId, pre:{verdict,text}, ran, exit, stderr, post }
 * Appends {pid, shimDir} to $FAKE_OUT on start (non-vacuity: a shim was installed).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { spawnSync } from 'node:child_process';

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  process.stdout.write('9.9.9 (Claude Code)\n');
  process.exit(0);
}

const SDK_ID = `fake231-${process.pid}`;
const say = (o) => { try { process.stdout.write(`${JSON.stringify(o)}\n`); } catch { /* gone */ } };
const shimDir = process.env.ORCHARD_GIT_SHIM_DIR || null;
if (process.env.FAKE_OUT) {
  try { fs.appendFileSync(process.env.FAKE_OUT, `${JSON.stringify({ pid: process.pid, shimDir, pathHead: String(process.env.PATH || '').split(path.delimiter)[0] })}\n`); } catch { /* best effort */ }
}

/** event name → callback id the runtime registered at initialize. */
const hookIds = {};
let seq = 0;
const pending = new Map();
function callHook(event, extra) {
  const cb = hookIds[event];
  if (!cb) return Promise.resolve({ verdict: 'unregistered', text: '' });
  const id = `f231-${++seq}`;
  const p = new Promise((resolve) => pending.set(id, resolve));
  say({ type: 'control_request', request_id: id, request: {
    subtype: 'hook_callback', callback_id: cb, tool_use_id: extra.tool_use_id,
    input: { hook_event_name: event, session_id: SDK_ID, transcript_path: '', cwd: process.cwd(), tool_name: 'Bash', ...extra },
  } });
  return Promise.race([p, new Promise((r) => setTimeout(() => r({ verdict: 'timeout', text: '' }), 60000))]);
}
function verdictOf(resp) {
  const r = resp?.response;
  if (resp?.subtype === 'error') return { verdict: 'error', text: String(resp.error) };
  const d = r?.hookSpecificOutput?.permissionDecision;
  return d ? { verdict: d, text: r.hookSpecificOutput.permissionDecisionReason ?? '' } : { verdict: 'allow', text: '' };
}

let calls = 0;
async function bashCall(spec) {
  const toolUseId = `toolu_231_${process.pid}_${++calls}`;
  const tool_input = { command: spec.command };
  const out = { tag: spec.tag ?? null, toolUseId, pre: null, ran: false, exit: null, stderr: '', post: null };
  out.pre = await callHook('PreToolUse', { tool_input, tool_use_id: toolUseId });
  if (out.pre.verdict === 'deny' || out.pre.verdict === 'error' || out.pre.verdict === 'timeout') return out;
  if (spec.permissionDeny) {
    out.post = await callHook('PermissionDenied', { tool_input, tool_use_id: toolUseId, reason: 'denied by the permission layer (fake)' });
    return out;
  }
  const r = spawnSync('bash', ['-c', spec.command], { cwd: process.env.FAKE_REPO, encoding: 'utf8', env: process.env, timeout: 120000 });
  out.ran = true;
  out.exit = r.status;
  out.stderr = String(r.stderr || '').slice(0, 1500);
  if (spec.skipPost) return out;
  out.post = r.status === 0
    ? await callHook('PostToolUse', { tool_input, tool_use_id: toolUseId, tool_response: { stdout: r.stdout, stderr: r.stderr, interrupted: false } })
    : await callHook('PostToolUseFailure', { tool_input, tool_use_id: toolUseId, error: `Exit code ${r.status}` });
  return out;
}

async function turn(text) {
  say({ type: 'system', subtype: 'init', session_id: SDK_ID, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [], mcp_servers: [] });
  const m = /\[\[bash\]\](.*)$/s.exec(text);
  if (m) {
    let res;
    try { res = await bashCall(JSON.parse(m[1])); } catch (e) { res = { error: String(e && e.stack) }; }
    try { fs.appendFileSync(process.env.FAKE_RESULTS, `${JSON.stringify(res)}\n`); } catch { /* ignore */ }
  }
  say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'ok' }] }, session_id: SDK_ID });
  say({ type: 'result', subtype: 'success', total_cost_usd: 0, session_id: SDK_ID });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m?.type === 'control_request') {
    if (m.request?.subtype === 'initialize') {
      for (const [event, matchers] of Object.entries(m.request?.hooks ?? {})) {
        const cb = matchers?.[0]?.hookCallbackIds?.[0];
        if (cb) hookIds[event] = cb;
      }
      say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { commands: [], models: [], account: {}, hooks_applied: true } } });
      if (process.env.FAKE_HOOKS_OUT) { try { fs.writeFileSync(process.env.FAKE_HOOKS_OUT, JSON.stringify(hookIds)); } catch { /* ignore */ } }
      return;
    }
    say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    return;
  }
  if (m?.type === 'control_response') {
    const id = m.response?.request_id;
    const res = pending.get(id);
    if (res) { pending.delete(id); res(verdictOf(m.response)); }
    return;
  }
  if (m?.type === 'user') {
    const c = m.message?.content;
    const text = Array.isArray(c) ? c.map((b) => b?.text ?? '').join('') : String(c ?? '');
    void turn(text);
  }
});
rl.on('close', () => process.exit(0));
process.stdin.resume();
