#!/usr/bin/env node
/**
 * FEAT-175 — a scripted stream-json `claude` that runs INSIDE a container (base image: node v20 + git),
 * for the end-to-end grant-rebuild verifier (scripts/verify-feat-175-grant-rebuild.mjs). It is given to the
 * scratch server through ORCHARD_TEST_CONTAINER_CLI; the server bakes its BYTES into the runtime layer at
 * CONTAINER_CLAUDE_BIN, so this very file is the CLI the container runs.
 *
 * It must:
 *   - answer `--version` with ORCHARD_TEST_CONTAINER_CLI_VERSION (the image's CLI check, and the runtime
 *     handshake version equality: container-manager.ts validateRuntimeImage).
 *   - pass the stream-json handshake: emit {type:'system',subtype:'init',claude_code_version:<v>} as soon as
 *     it sees the first `user` line (validateRuntimeImage sends ONE user frame with `-p` and waits for init).
 *   - speak enough of the SDK control protocol for a REAL session: answer the `initialize` control_request,
 *     then per `user` frame emit system/init + assistant + result (modelled on scripts/fixtures/bug-187/
 *     fake-cli.mjs, which drives real broker sessions end-to-end).
 *
 * Prompt directives (in the user text):
 *   [[sleep:N]]  — keep the turn BUSY for N ms before `result` (so the host sees `busy` while a grant change
 *                  is pending; the reconciler must wait for idle).
 *
 * Every received user prompt is appended (one JSON line, with a host-readable ISO timestamp) to
 * <cwd>/.feat175-received.jsonl — the cwd is the project dir, bind-mounted rw, so the HOST reads delivery
 * order and exactly-once at <hostPath>/.feat175-received.jsonl. The session id is taken from `--resume`/
 * `--session-id` when the SDK passes one (so a resumed session keeps its id), else a stable per-process id.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const VERSION = process.env.FEAT175_CLI_VERSION || '9.9.175-feat175';

// `--version` (image CLI check): print and exit before touching stdin.
if (process.argv.slice(2).some((a) => a === '--version' || a === '-v')) {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
  process.exit(0);
}

/** The session id the SDK fixed for us, if any (keeps a resumed session's id stable). */
function argId() {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const m = /^--(resume|session-id|fork-session)(?:=(.*))?$/.exec(a[i]);
    if (m) {
      const v = m[2] !== undefined ? m[2] : a[i + 1];
      if (v && !v.startsWith('-')) return v;
    }
  }
  return null;
}
const SDK_ID = argId() || process.env.FEAT175_SDK_ID || `feat175-${process.pid}-${Date.now().toString(36)}`;

const RECV = path.join(process.cwd(), '.feat175-received.jsonl');
const say = (o) => { try { process.stdout.write(`${JSON.stringify(o)}\n`); } catch { /* reader gone */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function recordReceived(text) {
  try { fs.appendFileSync(RECV, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, sdk: SDK_ID, text: String(text) })}\n`); } catch { /* best-effort */ }
}

// The session transcript the real CLI writes, so Orchard can RESUME this session (and the outbox deliver to
// it) after the container is recreated. Path mirrors container-manager.ts encodeCwdForStore(cwd); the dir is
// bind-mounted to the host's session-history store the server reads.
const STORE_DIR = path.join(process.env.HOME || '/home/claude', '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
const TRANSCRIPT = path.join(STORE_DIR, `${SDK_ID}.jsonl`);
let uuidSeq = 0;
function recordTranscript(role, text) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const row = role === 'user'
      ? { type: 'user', uuid: `u-${SDK_ID}-${uuidSeq}`, sessionId: SDK_ID, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: 'user', content: String(text) } }
      : { type: 'assistant', uuid: `a-${SDK_ID}-${uuidSeq++}`, sessionId: SDK_ID, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'feat175-model', content: [{ type: 'text', text: String(text) }] } };
    fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(row)}\n`);
  } catch { /* best-effort */ }
}

let initEmitted = false;
function emitSystemInit() {
  say({ type: 'system', subtype: 'init', session_id: SDK_ID, claude_code_version: VERSION, cwd: process.cwd(), model: 'feat175-model', tools: [], slash_commands: [], mcp_servers: [] });
  initEmitted = true;
}

function onInitialize(m) {
  // The SDK's handshake: answer success. No hooks/permissions are exercised by this suite.
  const response = { commands: [], models: [], account: {}, pending_permission_requests: [], pending_user_dialog_requests: [] };
  if (m.request?.hooks && typeof m.request.hooks === 'object' && Object.keys(m.request.hooks).length) response.hooks_applied = true;
  say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response, pending_permission_requests: [], pending_user_dialog_requests: [] } });
}

let turn = 0;
async function runTurn(text) {
  turn++;
  recordReceived(text);
  recordTranscript('user', text);
  if (!initEmitted) emitSystemInit();
  else say({ type: 'system', subtype: 'init', session_id: SDK_ID, claude_code_version: VERSION, cwd: process.cwd(), model: 'feat175-model', tools: [] });
  const reply = `turn ${turn}: ${String(text).slice(0, 80)}`;
  say({ type: 'assistant', message: { model: 'feat175-model', content: [{ type: 'text', text: reply }] }, session_id: SDK_ID });
  const m = /\[\[sleep:(\d+)\]\]/.exec(String(text));
  if (m) await sleep(Number(m[1]));
  recordTranscript('assistant', reply);
  say({ type: 'result', subtype: 'success', total_cost_usd: 0, is_error: false, session_id: SDK_ID });
}

const queue = [];
let running = false;
async function pump() {
  if (running) return;
  running = true;
  while (queue.length) { const t = queue.shift(); await runTurn(t); }
  running = false;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (!m || typeof m !== 'object') return;
  if (m.type === 'control_request') {
    const sub = m.request?.subtype;
    if (sub === 'initialize') return onInitialize(m);
    // Anything else (interrupt, set_model, mcp status, …): acknowledge.
    say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    return;
  }
  if (m.type === 'user') {
    const text = Array.isArray(m.message?.content)
      ? m.message.content.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('')
      : String(m.message?.content ?? '');
    queue.push(text);
    void pump();
  }
});
rl.on('close', () => { setTimeout(() => process.exit(0), 50); });
