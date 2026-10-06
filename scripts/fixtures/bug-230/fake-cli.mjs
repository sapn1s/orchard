#!/usr/bin/env node
/**
 * BUG-230 fake `claude` CLI — just enough of the stream-json control protocol for
 * a REAL ClaudeRuntime (in-process, or inside a scratch server) to launch it.
 *
 *   - Appends one JSON line {pid, shimDir, pathHead} to $FAKE_OUT on start, so the
 *     harness knows the runtime really installed a (child) shim — non-vacuity.
 *   - Answers `initialize`, remembering the PreToolUse hook callback id.
 *   - On a user turn whose text contains `[[probe]]`, runs the fail-closed probe
 *     below (needs $FAKE_PROBE_OUT and $FAKE_REPO), then ends the turn.
 *
 * The probe drives the runtime's REAL PreToolUse hook over the control channel:
 *   p1  shim intact                       → hook verdict for Bash `git status`
 *   p2  shim dir deleted out from under us → hook verdict, then: is the shim back,
 *       and is a node-subprocess `git commit` on a throwaway repo refused?
 *   p3  shim dir path replaced by a FILE (cannot be restored) → hook verdict
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { spawnSync } from 'node:child_process';

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  process.stdout.write('9.9.9 (Claude Code)\n');
  process.exit(0);
}

const SDK_ID = `fake230-${process.pid}`;
const say = (o) => { try { process.stdout.write(`${JSON.stringify(o)}\n`); } catch { /* gone */ } };
const shimDir = process.env.ORCHARD_GIT_SHIM_DIR || null;
if (process.env.FAKE_OUT) {
  try {
    fs.appendFileSync(process.env.FAKE_OUT, `${JSON.stringify({ pid: process.pid, shimDir, pathHead: String(process.env.PATH || '').split(path.delimiter)[0] })}\n`);
  } catch { /* best effort */ }
}

let hookId = null;
let seq = 0;
const pending = new Map();
function hook(command) {
  const id = `f230-${++seq}`;
  const p = new Promise((resolve) => pending.set(id, resolve));
  say({ type: 'control_request', request_id: id, request: {
    subtype: 'hook_callback', callback_id: hookId ?? 'hook_0', tool_use_id: `tu-${id}`,
    input: { hook_event_name: 'PreToolUse', session_id: SDK_ID, transcript_path: '', cwd: process.cwd(), tool_name: 'Bash', tool_input: { command }, tool_use_id: `tu-${id}` },
  } });
  return Promise.race([p, new Promise((r) => setTimeout(() => r({ verdict: 'timeout', text: '' }), 15000))]);
}
function verdictOf(resp) {
  const r = resp?.response;
  if (resp?.subtype === 'error') return { verdict: 'error', text: String(resp.error) };
  const d = r?.hookSpecificOutput?.permissionDecision;
  return d ? { verdict: d, text: r.hookSpecificOutput.permissionDecisionReason ?? '' } : { verdict: 'allow', text: '' };
}
function whichGit() {
  const r = spawnSync('which', ['git'], { encoding: 'utf8', env: process.env });
  return (r.stdout || '').trim() || null;
}
function subprocessCommit() {
  // A node GRANDCHILD resolving `git` via PATH, exactly as a lane script would.
  const r = spawnSync(process.execPath, ['-e',
    "const{execFileSync}=require('node:child_process');try{execFileSync('git',['commit','--allow-empty','-m','evil'],{cwd:process.env.FAKE_REPO,stdio:['ignore','ignore','pipe']});process.exit(0)}catch(e){process.stderr.write(String(e.stderr||e.message));process.exit(e.status||1)}"],
  { encoding: 'utf8', env: process.env });
  return { code: r.status, stderr: String(r.stderr || '').slice(0, 300) };
}

async function probe() {
  const out = {};
  out.p1 = await hook('git status');
  fs.rmSync(shimDir, { recursive: true, force: true });
  out.p2 = { gitAfterDeleteBeforeHook: whichGit() };
  out.p2.hook = await hook('git status');
  out.p2.shimBack = fs.existsSync(path.join(shimDir, 'git'));
  out.p2.gitAfterHook = whichGit();
  out.p2.commit = subprocessCommit();
  fs.rmSync(shimDir, { recursive: true, force: true });
  fs.writeFileSync(shimDir, 'not a directory');
  out.p3 = { hook: await hook('ls') };
  out.p3.gitResolves = whichGit();
  fs.rmSync(shimDir, { force: true });
  fs.writeFileSync(process.env.FAKE_PROBE_OUT, JSON.stringify(out));
}

async function turn(text) {
  say({ type: 'system', subtype: 'init', session_id: SDK_ID, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [], mcp_servers: [] });
  if (text.includes('[[probe]]')) {
    try { await probe(); } catch (e) { try { fs.writeFileSync(process.env.FAKE_PROBE_OUT, JSON.stringify({ error: String(e && e.stack) })); } catch { /* ignore */ } }
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
      const pre = m.request?.hooks?.PreToolUse?.[0]?.hookCallbackIds?.[0];
      if (pre) hookId = pre;
      say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { commands: [], models: [], account: {}, ...(pre ? { hooks_applied: true } : {}) } } });
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
