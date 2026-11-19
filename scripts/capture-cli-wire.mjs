#!/usr/bin/env node
/**
 * FEAT-206 — RECAPTURE the real claude CLI's turn-state wire frames for a given
 * SDK-bundled CLI, in the exact fixture shapes the BUG-159 suites grade, so a
 * CLI bump is proven on ITS OWN frames and not on the previous version's.
 *
 *   node scripts/capture-cli-wire.mjs --out <dir> [--bin-root <tree>] [--only <substr>] [--jobs 4]
 *
 * Writes into <dir>:
 *   real-cli-<ver>-contract.json           (round-10 scenario set, uuid inputs, lifecycle frames)
 *   real-cli-<ver>-correlation-races.json  (round-9 race set: 2nd/3rd input written at a trigger)
 *   real-cli-<ver>-frames.json             (round-7 named sequences, stdout only)
 *   real-cli-<ver>-input-races.json        (round-8 slash / rapid / interject, inputs without uuid)
 *
 * The CLI is REAL (node_modules/@anthropic-ai/claude-agent-sdk-<plat>/claude of
 * --bin-root, default this tree), run hermetically (own HOME/CLAUDE_CONFIG_DIR,
 * fake key) against scripts/lib/fake-messages-api.mjs — only the model is
 * scripted. Flags are the ones the SDK passes for a streaming session.
 * The original 2.1.281 drivers lived in /tmp and were lost; this one is the
 * committed, re-runnable replacement. Its own fidelity is checked by running it
 * against 2.1.281 too and grading both captures with the same suites.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startFakeApi, textOf, lastUser, lastToolResult } from './lib/fake-messages-api.mjs';
import { hermeticCliEnv, bundledCli } from './lib/cli-wire-env.mjs';
import { mkdtempScratch } from './lib/scratch.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const HERE_ROOT = path.resolve(import.meta.dirname, '..');
const BIN_ROOT = path.resolve(opt('--bin-root', HERE_ROOT));
const OUT = opt('--out');
const ONLY = opt('--only', '');
const JOBS = Number(opt('--jobs', '4'));
if (!OUT) { console.error('--out <dir> is required'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const { bin, sdkVersion } = bundledCli(BIN_ROOT);
const vr = spawnSync(bin, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent' } });
const VER = (vr.stdout.match(/\d+\.\d+\.\d+/) || [])[0];
if (!VER) { console.error(`cannot execute ${bin} --version: ${vr.stderr || vr.stdout}`); process.exit(2); }
const SHA = spawnSync('sha256sum', [bin], { encoding: 'utf8' }).stdout.split(' ')[0];
console.log(`CLI under capture: ${bin}\n  --version ${VER}  sha256 ${SHA}  (sdk ${sdkVersion})`);
const SCRATCH = mkdtempScratch(`capture-cli-${VER}-`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------- scripted model */
/** apiMode → reply script. `state` is per-run (counts main-conversation requests). */
function modelFor(mode, state) {
  return async (req) => {
    const main = (req.tools ?? []).length > 0;
    if (!main) return { text: 'ok' };
    state.mainReqs = (state.mainReqs ?? 0) + 1;
    const last = lastUser(req);
    const tr = lastToolResult(req);
    const lt = textOf(last);
    const woken = /task-notification|<task_notification|background (command|task)/i.test(lt) && !tr;
    if (mode === 'auth' || (mode === 'okthenauth' && state.mainReqs > 1) || (mode === 'okthenauth-rl' && state.mainReqs > 1)) {
      return { status: 401, error: { type: 'authentication_error', message: 'OAuth token has expired' } };
    }
    if (mode === 'rate') return { status: 429, error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' }, headers: { 'x-should-retry': 'false', 'retry-after': '0' } };
    if (mode === 'midstreamerr') {
      if (!tr && !state.erred) { state.erred = true; return { tool: { name: 'Bash', input: { command: 'echo step', description: 'step' } } }; }
      if (tr && !state.erred2) { state.erred2 = true; return { status: 500, error: { type: 'api_error', message: 'Internal server error' }, headers: { 'x-should-retry': 'false' } }; }
      return { text: 'recovered answer' };
    }
    if (mode === 'midtool' || mode === 'interject') {
      if (tr) return { text: 'tool finished' };
      if (state.mainReqs === 1) return { tool: { name: 'Bash', input: { command: mode === 'interject' ? 'sleep 2; echo hi' : 'sleep 1; echo hi', description: 'wait' } } };
      return { text: 'ok' };
    }
    if (mode === 'bgbash') {
      if (tr) return { text: 'started it' };
      if (woken) return { text: 'background finished' };
      if (!state.bgStarted) { state.bgStarted = true; return { tool: { name: 'Bash', input: { command: 'sleep 3; echo bgdone', description: 'bg', run_in_background: true } } }; }
      return { text: 'ok' };
    }
    if (mode === 'slow') return { text: 'a slow streamed answer, chunk by chunk', delayMs: 2500, chunks: 6 };
    if (mode === 'ok-rl' || mode === 'okthenauth-rl') return { text: 'ok', headers: RL_HEADERS };
    return { text: `ok ${state.mainReqs}` };
  };
}
const RL_HEADERS = {
  'anthropic-ratelimit-unified-status': 'allowed_warning',
  'anthropic-ratelimit-unified-5h-status': 'allowed_warning',
  'anthropic-ratelimit-unified-5h-utilization': '0.91',
  'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
};

/* ----------------------------------------------------------- one real run */
/**
 * Spawn the real CLI, write inputs as `drive` decides, record every stdout frame
 * and every stdin line in order. `drive(ev, io)` is called on each frame.
 * Ends when the CLI has been at rest (idle / all inputs answered, no live bg) for
 * `settleMs`, or at `capMs`.
 */
async function runOne({ mode, states = true, withUuid = true, oauth = false, drive, capMs = 45000, settleMs = 1500 }) {
  const state = {};
  const api = await startFakeApi({ script: modelFor(mode, state) });
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'run-'));
  const cwd = path.join(dir, 'proj'); fs.mkdirSync(cwd);
  const env = hermeticCliEnv({ scratch: dir, apiUrl: api.url, extra: { CLAUDE_CODE_MAX_RETRIES: '1', ...(states ? { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' } : {}) } });
  // rate_limit_event frames are emitted only for subscription (OAuth) auth — a fake token, same fake API.
  if (oauth) { delete env.ANTHROPIC_API_KEY; env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-feat206-fake-token-not-real'; }
  const p = spawn(bin, ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--include-partial-messages', '--model', 'claude-opus-4-8', '--permission-mode', 'bypassPermissions'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const t0 = Date.now();
  const seq = [];
  const open = new Set();
  let bgLive = 0, lastActivity = Date.now(), idle = !states, n = 0;
  const io = {
    send(content, { uuid, dup } = {}) {
      const u = withUuid ? (uuid ?? randomUUID()) : undefined;
      const line = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' };
      if (u) line.uuid = u;
      seq.push({ at: Date.now() - t0, stdin: withUuid ? { content, uuid: u, ...(dup ? { dup: true } : {}) } : { type: 'user', message: { role: 'user', content } } });
      if (u && !dup) open.add(u);
      p.stdin.write(JSON.stringify(line) + '\n');
      lastActivity = Date.now();
      return u;
    },
    interrupt() {
      const id = `int-${++n}`;
      seq.push({ at: Date.now() - t0, stdin: { interrupt: id } });
      p.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } }) + '\n');
      lastActivity = Date.now();
    },
    later(ms, fn) { setTimeout(fn, ms); },
    state,
  };
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!l.trim()) continue;
      let f; try { f = JSON.parse(l); } catch { continue; }
      if (f.type === 'system' && f.subtype === 'init') { f = { ...f, tools: undefined, mcp_servers: undefined, slash_commands: undefined, agents: undefined, skills: undefined, plugins: undefined, cwd: '<cwd>' }; for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k]; }
      seq.push({ at: Date.now() - t0, frame: f });
      lastActivity = Date.now();
      if (f.type === 'result') for (const u of [...(f.user_message_uuids ?? []), ...(f.user_message_uuid ? [f.user_message_uuid] : [])]) open.delete(u);
      if (f.type === 'command_lifecycle' && !['queued', 'started'].includes(f.state)) open.delete(f.command_uuid);
      if (f.type === 'system' && f.subtype === 'session_state_changed') idle = f.state === 'idle';
      if (f.type === 'system' && f.subtype === 'task_started') bgLive++;
      if (f.type === 'system' && f.subtype === 'task_notification') bgLive = Math.max(0, bgLive - 1);
      if (f.type === 'result' && !states) idle = true;
      if (f.type === 'system' && f.subtype === 'status' && !states) idle = false;
      try { drive(f, io); } catch (e) { console.error('drive error', e); }
    }
  });
  let stderr = '';
  p.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((r) => p.on('exit', (code, sig) => r({ code, sig })));
  drive({ type: '__start' }, io);
  const deadline = Date.now() + capMs;
  let ex = null;
  exited.then((v) => { ex = v; });
  while (!ex && Date.now() < deadline) {
    await sleep(100);
    if (io.state.pending) continue;
    if (open.size === 0 && bgLive === 0 && idle && Date.now() - lastActivity > settleMs) break;
  }
  const capped = !ex && Date.now() >= deadline;
  p.stdin.end();
  const t = setTimeout(() => p.kill('SIGTERM'), 5000);
  await exited; clearTimeout(t);
  await api.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return { seq, capped, stderr: stderr.slice(0, 2000), apiRequests: api.requests.length };
}

const isDelta = (f) => f.type === 'stream_event' && f.event?.type === 'content_block_delta';
const isIdleF = (f) => f.type === 'system' && f.subtype === 'session_state_changed' && f.state === 'idle';
/** Fire `fn` once, on the first frame matching `pred` (after `after` such frames). */
function once(pred, fn) { let done = false; return (f, io) => { if (!done && pred(f)) { done = true; fn(f, io); } }; }
function chain(...ds) { return (f, io) => { for (const d of ds) d(f, io); }; }
const start = (fn) => (f, io) => { if (f.type === '__start') fn(io); };
/** nth occurrence of pred. */
function nth(n, pred, fn) { let k = 0; return (f, io) => { if (pred(f) && ++k === n) fn(f, io); }; }
const restAt = (states) => (states ? isIdleF : (f) => f.type === 'result');

/* ----------------------------------------------------------- scenario sets */
function contractScenarios() {
  const S = [];
  const add = (scenario, mode, mk, { nostates = false, reps = 3 } = {}) => {
    for (let r = 0; r < reps; r++) S.push({ key: `${scenario}-${r}`, scenario, mode, states: true, drive: () => mk(true) });
    if (nostates) S.push({ key: `${scenario}-0-nostates`, scenario, mode, states: false, drive: () => mk(false) });
  };
  const msg1 = start((io) => io.send('msg 1'));
  add('auth', 'auth', (st) => chain(msg1, nth(1, restAt(st), (f, io) => io.send('msg 2'))), { nostates: true });
  add('auth-queued', 'auth', () => chain(start((io) => { io.send('msg 1'); io.send('msg 2'); })), { nostates: true });
  add('bg-woken', 'bgbash', (st) => chain(msg1, nth(1, restAt(st), (f, io) => io.send('msg 2'))), { nostates: true });
  add('compact-slash', 'ok', (st) => chain(msg1, nth(1, restAt(st), (f, io) => io.send('/compact'))));
  add('context-slash', 'ok', (st) => chain(msg1, nth(1, restAt(st), (f, io) => io.send('/context'))));
  add('cost-after-turn', 'ok', (st) => chain(msg1, nth(1, restAt(st), (f, io) => io.send('/cost'))), { nostates: true });
  add('cost-at-result', 'ok', () => chain(msg1, once((f) => f.type === 'result', (f, io) => io.send('/cost'))), { nostates: true });
  add('cost-idle', 'ok', (st) => chain(msg1, nth(1, restAt(st), (f, io) => io.later(500, () => io.send('/cost')))));
  add('cost-midturn', 'slow', () => chain(msg1, once(isDelta, (f, io) => io.send('/cost'))), { nostates: true });
  add('cost-twice-mid', 'slow', () => chain(msg1, once(isDelta, (f, io) => { io.send('/cost'); io.send('/cost'); })));
  add('dup-idle', 'ok', (st) => chain(start((io) => { io.state.u1 = io.send('msg 1'); }), nth(1, restAt(st), (f, io) => io.send('msg 1', { uuid: io.state.u1, dup: true })), nth(2, restAt(st), (f, io) => io.send('msg 3'))), { reps: 2 });
  add('dup-mid', 'slow', (st) => chain(start((io) => { io.state.u1 = io.send('msg 1'); }), once(isDelta, (f, io) => io.send('msg 1', { uuid: io.state.u1, dup: true })), nth(1, restAt(st), (f, io) => io.send('msg 3'))), { reps: 2 });
  add('interject-tool', 'interject', () => chain(msg1, once((f) => f.type === 'assistant' && (f.message?.content ?? []).some((c) => c.type === 'tool_use'), (f, io) => io.send('msg 2')), once((f) => f.type === 'result', (f, io) => io.send('/cost'))), { nostates: true });
  add('interrupt-before-read', 'slow', () => start((io) => { io.send('msg 1'); io.interrupt(); }));
  add('interrupt-idle', 'ok', (st) => chain(msg1, nth(1, restAt(st), (f, io) => { io.interrupt(); io.later(300, () => io.send('msg 2')); })));
  add('interrupt-late', 'ok', (st) => chain(msg1, once((f) => f.type === 'result', (f, io) => io.interrupt()), nth(1, restAt(st), (f, io) => io.later(300, () => io.send('msg 2')))));
  add('interrupt-mid', 'slow', (st) => chain(msg1, once(isDelta, (f, io) => io.interrupt()), nth(1, restAt(st), (f, io) => io.later(200, () => io.send('msg 2')))), { nostates: true });
  add('interrupt-queued', 'slow', (st) => chain(msg1, once(isDelta, (f, io) => { io.send('msg 2'); io.later(100, () => io.interrupt()); })), { nostates: true });
  add('midtool', 'midstreamerr', () => msg1);
  add('okthenauth', 'okthenauth', (st) => chain(msg1, nth(1, restAt(st), (f, io) => io.send('msg 2'))));
  add('rate', 'rate', (st) => chain(msg1, nth(1, restAt(st), (f, io) => io.send('msg 2'))));
  add('unknown-slash', 'ok', () => start((io) => io.send('/nosuchcommand-feat206')), { nostates: true });
  return S;
}
function raceScenarios() {
  const S = [];
  const trig = {
    result: (f) => f.type === 'result',
    message_stop: (f) => f.type === 'stream_event' && f.event?.type === 'message_stop',
    assistant: (f) => f.type === 'assistant',
    content_block_delta: isDelta,
    idle: isIdleF,
  };
  const combos = [
    ['assistant', 0, ['ok', 'slow']], ['content_block_delta', 0, ['ok', 'slow']], ['idle', 0, ['bgbash', 'ok', 'slow']],
    ['message_stop', 0, ['bgbash', 'ok', 'slow']], ['message_stop', 3, ['ok', 'slow']], ['result', 0, ['bgbash', 'ok', 'slow']],
    ['result', 10, ['ok', 'slow']], ['result', 2, ['ok', 'slow']],
  ];
  for (const [t, delay, modes] of combos) for (const m of modes) for (let r = 0; r < 3; r++) {
    S.push({ key: `${t}-${delay}-${m}-${r}`, mode: m, states: true, drive: () => chain(
      start((io) => io.send('msg 1')),
      nth(1, trig[t], (f, io) => io.later(delay, () => io.send('msg 2'))),
      nth(2, trig[t], (f, io) => io.later(delay, () => io.send('msg 3'))),
    ) });
  }
  return S;
}
function framesScenarios() {
  const rest = isIdleF;
  return [
    { key: 'midResponseToolError', mode: 'midstreamerr', drive: () => start((io) => io.send('go')) },
    { key: 'expiredOauthAuthError', mode: 'auth', oauth: true, drive: () => start((io) => io.send('go')) },
    { key: 'rateLimit429', mode: 'rate', drive: () => start((io) => io.send('go')) },
    { key: 'okTurnWithRateLimitEvent', mode: 'okthenauth-rl', oauth: true, drive: () => chain(start((io) => io.send('go')), nth(1, rest, (f, io) => io.send('again'))) },
    { key: 'backgroundBashThenWokenTurn', mode: 'bgbash', drive: () => start((io) => io.send('go')) },
  ].map((s) => ({ ...s, states: true, withUuid: false }));
}
function inputRaceScenarios() {
  return [
    { key: 'slash', mode: 'ok', drive: () => start((io) => io.send('/cost')) },
    { key: 'rapid', mode: 'ok', drive: () => chain(start((io) => io.send('first')), once((f) => f.type === 'result', (f, io) => io.send('second'))) },
    { key: 'interject', mode: 'slow', drive: () => chain(start((io) => io.send('first')), once(isDelta, (f, io) => io.send('second'))) },
  ].map((s) => ({ ...s, states: true, withUuid: false }));
}

/** Round-10 reduction (as the 2.1.281 contract fixture): only the fields the turn tracker and graders read. */
const KEEP = ['type', 'subtype', 'state', 'status', 'command_uuid', 'user_message_uuid', 'user_message_uuids', 'parent_tool_use_id', 'error', 'is_error', 'terminal_reason', 'task_id', 'tasks', 'response'];
function reduceFrame(f) {
  const o = {};
  for (const k of KEEP) if (f[k] !== undefined) o[k] = f[k];
  if (f.type === 'system' && f.subtype !== 'status' && f.subtype !== 'task_notification') delete o.status;
  if (f.message) o.message = { content: Array.isArray(f.message.content) ? f.message.content.map((c) => ({ type: c?.type })) : [] };
  if (f.event) o.event = { type: f.event.type };
  return o;
}
/** No machine paths in a committed fixture. */
const ENC_HOME = os.homedir().replace(/[^A-Za-z0-9]/g, '-');   // how the CLI encodes a path into a dir name
const scrub = (txt) => txt.split(os.homedir()).join('~').split(ENC_HOME).join('-HOME').replace(/\/tmp\/claude-\d+/g, '/tmp/claude-<uid>');

async function pool(items, jobs, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: jobs }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

const SOURCE = (round, extra) => `REAL stdout of claude CLI ${VER} (${path.relative(BIN_ROOT, bin)}, sha256 ${SHA}, SDK ${sdkVersion}), --output-format stream-json --input-format stream-json --verbose --include-partial-messages, hermetic HOME/CLAUDE_CONFIG_DIR, against the local fake Messages API (scripts/lib/fake-messages-api.mjs), interleaved with the stdin lines written. ${extra} Re-captured for FEAT-206 by scripts/capture-cli-wire.mjs (${new Date().toISOString().slice(0, 10)}), mirroring the BUG-159 ${round} scenario set. init frame lists trimmed, cwd replaced.`;

const sets = [
  ['contract', contractScenarios()],
  ['correlation-races', raceScenarios()],
  ['frames', framesScenarios()],
  ['input-races', inputRaceScenarios()],
];
const report = { ver: VER, bin, sha256: SHA, sdkVersion, runs: 0, capped: [] };
for (const [name, scen] of sets) {
  const pick = scen.filter((s) => !ONLY || s.key.includes(ONLY) || name.includes(ONLY));
  if (!pick.length) continue;
  console.log(`\n== ${name}: ${pick.length} runs`);
  const res = await pool(pick, JOBS, async (s) => {
    const r = await runOne({ mode: s.mode, states: s.states, withUuid: s.withUuid !== false, oauth: !!s.oauth, drive: s.drive() });
    report.runs++;
    if (r.capped) report.capped.push(`${name}/${s.key}`);
    console.log(`  ${s.key}: ${r.seq.length} events${r.capped ? ' CAPPED' : ''} api=${r.apiRequests}`);
    return [s, r];
  });
  let doc;
  if (name === 'contract') doc = { source: SOURCE('round-10', 'Frames REDUCED to tracker-relevant fields (as the 2.1.281 contract); order and timing (at, ms) are as captured. Every stdin user line carries a top-level uuid; {stdin:{interrupt}} is a control_request interrupt; {stdin:{dup:true}} re-sends an earlier uuid.'), captured: new Date().toISOString().slice(0, 10), runs: Object.fromEntries(res.map(([s, r]) => [s.key, { scenario: s.scenario, mode: s.mode, ...(s.states ? {} : { nostates: true }), seq: r.seq.map((e) => (e.frame ? { at: e.at, frame: reduceFrame(e.frame) } : e)) }])) };
  else if (name === 'correlation-races') doc = { _source: SOURCE('round-9', 'key = <trigger>-<delayMs>-<apiMode>-<run>.'), runs: Object.fromEntries(res.map(([s, r]) => [s.key, r.seq])) };
  else if (name === 'frames') doc = { _source: SOURCE('round-7', 'Frames only (stdout), inputs without uuid.'), ...Object.fromEntries(res.map(([s, r]) => [s.key, r.seq.filter((e) => e.frame).map((e) => e.frame)])) };
  else doc = { _source: SOURCE('round-8', 'Inputs without uuid, as {stdin:<line>}.'), ...Object.fromEntries(res.map(([s, r]) => [s.key, r.seq.map((e) => (e.stdin ? { stdin: e.stdin } : { frame: e.frame }))])) };
  const file = path.join(OUT, `real-cli-${VER}-${name}.json`);
  fs.writeFileSync(file, scrub(JSON.stringify(doc, null, 0)) + '\n');
  console.log(`  wrote ${file}`);
}
fs.writeFileSync(path.join(OUT, `capture-${VER}-report.json`), JSON.stringify(report, null, 2));
console.log(`\nDONE ${report.runs} runs, capped: ${report.capped.length ? report.capped.join(', ') : 'none'}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
