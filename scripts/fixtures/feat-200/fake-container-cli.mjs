#!/usr/bin/env node
/**
 * FEAT-200 — a scripted stream-json `claude` that runs INSIDE a container, for the container-access
 * end-to-end verifier (scripts/verify-feat-200-access-requests.mjs). Derived from the FEAT-175 fake
 * (scripts/fixtures/feat-175/fake-container-cli.mjs): same `--version`, handshake and control protocol.
 *
 * Added for FEAT-200:
 *   - every received prompt is logged (with the container's own MONGODB_URI value, the process env this
 *     CLI was exec'd with) to <cwd>/.feat200-received.jsonl, which the HOST reads through the project bind;
 *   - the SDK's `initialize` request and this process's argv are saved to <cwd>/.feat200-launch.jsonl, so
 *     the host can check which instructions the session was launched with;
 *   - prompt directive [[access:<json>]] raises a container access request EXACTLY as the injected
 *     instructions tell a real agent to: write "$ORCHARD_ACCESS_DIR/.orchard-access.$ORCHARD_SESSION.<n>.json"
 *     as <name>.tmp, mv it into place, wait for the .reply, and put the reply in the assistant text.
 *
 * Other directives: [[sleep:N]] keeps the turn busy N ms.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const VERSION = process.env.FEAT175_CLI_VERSION || '9.9.200-feat200';

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

const RECV = path.join(process.cwd(), '.feat200-received.jsonl');
const LAUNCH = path.join(process.cwd(), '.feat200-launch.jsonl');
const say = (o) => { try { process.stdout.write(`${JSON.stringify(o)}\n`); } catch { /* reader gone */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function recordReceived(text) {
  try { fs.appendFileSync(RECV, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, sdk: SDK_ID, text: String(text), mongodbUri: process.env.MONGODB_URI ?? null, accessDir: process.env.ORCHARD_ACCESS_DIR ?? null })}\n`); } catch { /* best-effort */ }
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
  try { fs.appendFileSync(LAUNCH, `${JSON.stringify({ at: new Date().toISOString(), sdk: SDK_ID, argv: process.argv.slice(2), initialize: m.request ?? null })}\n`); } catch { /* best-effort */ }
  // The SDK's handshake: answer success. No hooks/permissions are exercised by this suite.
  const response = { commands: [], models: [], account: {}, pending_permission_requests: [], pending_user_dialog_requests: [] };
  if (m.request?.hooks && typeof m.request.hooks === 'object' && Object.keys(m.request.hooks).length) response.hooks_applied = true;
  say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response, pending_permission_requests: [], pending_user_dialog_requests: [] } });
}

/** Raise a container access request the way the injected instructions say (tmp + mv, then read the reply). */
async function raiseAccess(json) {
  const dir = process.env.ORCHARD_ACCESS_DIR;
  const sid = process.env.ORCHARD_SESSION;
  if (!dir || !sid) return `NO CHANNEL (ORCHARD_ACCESS_DIR=${dir ?? ''} ORCHARD_SESSION=${sid ?? ''})`;
  const f = path.join(dir, `.orchard-access.${sid}.${Date.now()}${Math.floor(Math.random() * 1000)}.json`);
  fs.writeFileSync(`${f}.tmp`, json);
  fs.renameSync(`${f}.tmp`, f);
  const r = f.replace(/\.json$/, '.reply');
  for (let i = 0; i < 30; i++) {
    try { return fs.readFileSync(r, 'utf8').replace(/\s+/g, ' ').trim(); } catch { await sleep(500); }
  }
  return 'NO REPLY';
}

let turn = 0;
async function runTurn(text) {
  turn++;
  recordReceived(text);
  recordTranscript('user', text);
  if (!initEmitted) emitSystemInit();
  else say({ type: 'system', subtype: 'init', session_id: SDK_ID, claude_code_version: VERSION, cwd: process.cwd(), model: 'feat175-model', tools: [] });
  let reply = `turn ${turn}: ${String(text).slice(0, 80)}`;
  const acc = /\[\[access:(\{[\s\S]*?\})\]\]/.exec(String(text));
  if (acc) reply = `access request: ${await raiseAccess(acc[1])}`;
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
