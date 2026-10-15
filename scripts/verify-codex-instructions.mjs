#!/usr/bin/env node
/**
 * verify-codex-instructions.mjs — 2026-10-13 (defaults lane): a Codex session gets the SAME
 * injected instructions as a Claude session — the Working Agreement, the project's
 * conventions, the response format and the per-project agent git policy note. They are
 * composed ONCE by AgentSession (agent-bridge.ts: composeInstructions + the notes) and
 * handed to every runtime as `config.systemPrompt`; CodexRuntime now forwards that text as
 * app-server `developerInstructions` on thread/start, thread/resume and thread/fork.
 *
 *   node scripts/verify-codex-instructions.mjs          # unit + wire + must-FAIL + REAL codex e2e
 *   node scripts/verify-codex-instructions.mjs --no-e2e # skip the real-codex arm (no codex install)
 *
 * U  codexDeveloperInstructions: both systemPrompt shapes → the composed text; nothing → null.
 * W  the wire, through the REAL CodexRuntime class against an in-process app-server stand-in
 *    that records every request: start, resume and fork each carry developerInstructions ===
 *    the composed text; with no systemPrompt the key is ABSENT (byte-identical to before).
 * WM MUST-FAIL: the same wire checks against a CONSTRUCTED mutant of codex-runtime.ts with the
 *    forwarding removed — they must fail there (a passing mutant is itself a FAIL).
 * E  REAL artifact: an isolated scratch server drives the REAL `codex app-server` (the user's
 *    real ~/.codex config and sign-in) for a project in soft-release mode with a
 *    docs/CONVENTIONS.md canary. Codex's own rollout file is read back: its developer message
 *    must hold the WA, the conventions canary, the response-format section and the agent git
 *    policy note — the same sections agentGitPolicyNote/composeInstructions produce. A model
 *    reply is NOT required (OpenAI quota may be spent): the rollout is what the model is given.
 * EM MUST-FAIL: the same e2e on a constructed mutant tree without the forwarding — the rollout
 *    must NOT contain the canary.
 *
 * Exit 0 = all PASS, 1 = a FAIL, 2 = codex not connected (the e2e cannot be substituted).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { isolatedServerEnv, isolatedStoreEnv } from './lib/station-boot.mjs';
import { buildMutantTree } from './lib/mutant-tree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const NO_E2E = args.includes('--no-e2e');
const KEEP = args.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; let fail = 0; const failures = [];
function check(name, ok, observed) {
  const line = observed === undefined ? '' : `\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed).slice(0, 600)}`;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${line}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

/** The forwarding hunks, removed — the constructed pre-fix state (pinned by content, not by HEAD). */
const MUTANT_EDITS = [
  { file: 'src/server/runtime/codex-runtime.ts', from: "await this.#request('thread/fork', { threadId: config.resume, ...devParam })", to: "await this.#request('thread/fork', { threadId: config.resume })" },
  { file: 'src/server/runtime/codex-runtime.ts', from: "await this.#request('thread/resume', { threadId: config.resume, ...devParam })", to: "await this.#request('thread/resume', { threadId: config.resume })" },
  { file: 'src/server/runtime/codex-runtime.ts', from: '        sandbox: this.#mode!.sandbox,\n        ...devParam,\n', to: '        sandbox: this.#mode!.sandbox,\n' },
];

/* ───────────────────────────── an in-process app-server stand-in that records requests */
function fakeAppServer(seen) {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  const ee = new EventEmitter();
  let buf = '';
  const reply = (id, result) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  stdin.on('data', (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.method) seen.push({ method: msg.method, params: msg.params });
      if (msg.id === undefined) continue;
      if (msg.method === 'initialize') reply(msg.id, { userAgent: 'fake' });
      else if (msg.method === 'thread/start' || msg.method === 'thread/resume' || msg.method === 'thread/fork') reply(msg.id, { thread: { id: `thr_${msg.method.split('/')[1]}` }, model: 'gpt-fake' });
      else if (msg.method === 'turn/start') reply(msg.id, { turn: { id: 'turn_1', status: 'inProgress', items: [] } });
      else reply(msg.id, {});
    }
  });
  return { stdin, stdout, stderr, kill: () => { ee.emit('exit', 0, null); return true; }, once: (ev, fn) => ee.once(ev, fn) };
}
async function wireRun(CodexRuntime, extra) {
  const seen = [];
  const rt = new CodexRuntime();
  rt.start({ cwd: '/tmp/wire', firstPrompt: 'hi', permissionMode: 'default', onApproval: async () => ({ behavior: 'deny', message: 'x' }), spawnProcess: () => fakeAppServer(seen), ...extra });
  const until = Date.now() + 5000;
  while (Date.now() < until && !seen.some((s) => s.method === 'turn/start')) await sleep(20);
  try { rt.close(); } catch { /* */ }
  return seen.find((s) => /^thread\/(start|resume|fork)$/.test(s.method)) ?? null;
}
async function wireChecks(CodexRuntime, tag) {
  const text = '## WA\nCANARY-WIRE-4417\n\n## Git policy for this project (set by the user — FEAT-164)\nsoft releases';
  const start = await wireRun(CodexRuntime, { systemPrompt: { type: 'preset', preset: 'claude_code', append: text } });
  const startStr = await wireRun(CodexRuntime, { systemPrompt: text });
  const resume = await wireRun(CodexRuntime, { systemPrompt: { type: 'preset', preset: 'claude_code', append: text }, resume: 'thr_old' });
  const fork = await wireRun(CodexRuntime, { systemPrompt: { type: 'preset', preset: 'claude_code', append: text }, resume: 'thr_old', forkSession: true });
  const none = await wireRun(CodexRuntime, {});
  return [
    [`${tag}1 thread/start carries developerInstructions === the composed text (preset-append shape)`, start?.method === 'thread/start' && start.params.developerInstructions === text, start],
    [`${tag}2 …and for the bare-string (replace-mode) shape`, startStr?.params?.developerInstructions === text, startStr?.params],
    [`${tag}3 thread/resume carries it too (a resumed session keeps its instructions)`, resume?.method === 'thread/resume' && resume.params.developerInstructions === text, resume],
    [`${tag}4 thread/fork carries it too`, fork?.method === 'thread/fork' && fork.params.developerInstructions === text, fork],
    [`${tag}5 no systemPrompt → no developerInstructions key at all (byte-identical wire to before)`, none?.method === 'thread/start' && !('developerInstructions' in none.params) && !('baseInstructions' in none.params), none?.params],
  ];
}

/* ───────────────────────────── U + W + WM */
{
  console.log('U  codexDeveloperInstructions');
  const CR = await import(pathToFileURL(path.join(ROOT, 'src/server/runtime/codex-runtime.ts')).href);
  const f = CR.codexDeveloperInstructions;
  check('U1 preset-append → the append text; string → itself; undefined / blank → null',
    f({ type: 'preset', preset: 'claude_code', append: 'A' }) === 'A' && f('S') === 'S' && f(undefined) === null && f('  ') === null && f({ type: 'preset', preset: 'claude_code', append: '' }) === null);

  console.log('W  the wire, through the REAL CodexRuntime class');
  for (const c of await wireChecks(CR.CodexRuntime, 'W')) check(...c);

  console.log('WM MUST-FAIL: the same wire checks on a constructed mutant without the forwarding');
  const mroot = buildMutantTree({ prefix: 'codex-instr-mutant-', copy: ['src'], edits: MUTANT_EDITS });
  try {
    const M = await import(pathToFileURL(path.join(mroot, 'src/server/runtime/codex-runtime.ts')).href);
    const res = await wireChecks(M.CodexRuntime, 'WM');
    const forwarded = res.slice(0, 4).filter((r) => r[1]).length;
    check('WM1 on the mutant, start/resume/fork all LACK the instructions (0 of 4 forwarding checks hold) — the wire proof is not vacuous', forwarded === 0, res.slice(0, 4).map((r) => [r[0].slice(0, 30), r[1]]));
  } finally { if (!KEEP) fs.rmSync(mroot, { recursive: true, force: true }); }
}

/* ───────────────────────────── E + EM: the real codex app-server */
async function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function rolloutsSince(t0) {
  const base = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const out = [];
  const walk = (d) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) { try { if (fs.statSync(p).mtimeMs >= t0 - 1000) out.push(p); } catch { /* */ } } } };
  walk(base);
  return out;
}
/** The developer-message texts of the rollout whose session_meta.cwd is `cwd`, or null. */
function developerTextFor(cwd, t0) {
  for (const f of rolloutsSince(t0)) {
    let lines; try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { continue; }
    let meta = null; const dev = [];
    for (const l of lines) {
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.type === 'session_meta') meta = j.payload;
      const p = j.payload || {};
      if (j.type === 'response_item' && p.type === 'message' && p.role === 'developer') for (const c of p.content || []) if (typeof c.text === 'string') dev.push(c.text);
    }
    if (meta && (meta.cwd === cwd || fs.realpathSync(meta.cwd) === fs.realpathSync(cwd))) return { file: f, text: dev.join('\n\n'), meta };
  }
  return null;
}
async function e2eArm(root, label) {
  const PORT = await freePort();
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), `codex-instr-${label}-data-`));
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), `codex-instr-${label}-work-`));
  const CFG = fs.mkdtempSync(path.join(os.tmpdir(), `codex-instr-${label}-cfg-`));
  const CANARY = `CONVENTIONS-CANARY-${label.toUpperCase()}-${process.pid}`;
  fs.mkdirSync(path.join(WORK, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(WORK, 'docs', 'CONVENTIONS.md'), `# Project conventions — e2e fixture\n\n<!-- conventions-inject:start -->\n\n## Canary\n\n${CANARY}: every reply is checked for this line.\n`);
  const env = isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA, ORCHARD_RELEASE_TICK: '0', ...isolatedStoreEnv(CFG, { alsoReader: true }) }, { requireStore: true });
  const log = [];
  const child = spawn(process.execPath, [path.join(root, 'src', 'server', 'index.ts')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  const BASE = `http://127.0.0.1:${PORT}`;
  const j = async (m, u, body) => { const r = await fetch(BASE + u, { method: m, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }); let d; try { d = await r.json(); } catch { d = null; } return { status: r.status, d }; };
  try {
    let up = false;
    for (let k = 0; k < 160 && !up; k++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
    if (!up) throw new Error(`server never became healthy:\n${log.join('').slice(-1500)}`);
    const reg = await j('POST', '/api/projects', { hostPath: WORK, name: `codex-instr-${label}`, isolation: 'direct' });
    const pid = reg.d?.project?.id;
    if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);
    await j('PATCH', `/api/projects/${pid}`, { provider: 'openai', permissionMode: 'default', responseDigest: { enabled: true } });
    const pol = await j('PUT', `/api/projects/${pid}/git-write-policy`, { commit: true, push: false, scope: null });
    const proj = (await j('GET', `/api/projects/${pid}`)).d;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* */ } });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const t0 = Date.now();
    // A fresh server gates new host sessions until its bundled-runtime check completes:
    // re-send the start while it says so (bounded), never treat that refusal as a result.
    for (let k = 0; k < 40; k++) {
      const from = events.length;
      ws.send(JSON.stringify({ type: 'start', projectId: pid, overrides: { provider: 'openai' }, prompt: `Reply with only the token that starts with CONVENTIONS-CANARY in your instructions.` }));
      let gated = false;
      for (let w = 0; w < 20; w++) {
        await sleep(250);
        if (events.slice(from).some((e) => e.t === 'error' && /runtime check pending/.test(String(e.message)))) { gated = true; break; }
        if (events.slice(from).some((e) => e.t === 'session' || e.t === 'init' || (e.t === 'status' && !/starting/.test(String(e.status))))) break;
      }
      if (!gated) break;
      await sleep(2000);
    }
    let dev = null;
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      dev = developerTextFor(WORK, t0);
      if (dev?.text) break;
      await sleep(1000);
    }
    await sleep(1500);
    dev = developerTextFor(WORK, t0) ?? dev;
    try { ws.send(JSON.stringify({ type: 'close' })); } catch { /* */ }
    await sleep(800); ws.close();
    return { dev, CANARY, pol, proj, events, WORK, pid };
  } finally {
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* */ }
    await sleep(2500);
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* */ }
    if (KEEP) { fs.writeFileSync(path.join(DATA, 'server.log'), log.join('')); console.log(`        kept: ${DATA} ${WORK} ${CFG}`); }
    else for (const d of [DATA, WORK, CFG]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

if (!NO_E2E) {
  const { detectCodex } = await import(pathToFileURL(path.join(ROOT, 'src/server/runtime/codex-runtime.ts')).href);
  const det = detectCodex();
  if (det.status !== 'connected') {
    console.log(`\nCOULD NOT RUN the real-codex arm: codex is ${det.status}. It will not be substituted by a mock. ${det.hint || ''}`);
    console.log(`\nTOTAL: ${pass} passed, ${fail} failed (e2e NOT run)`);
    process.exit(fail ? 1 : 2);
  }
  console.log(`E  REAL codex app-server (${det.binaryPath}) through an isolated scratch server`);
  const E = await e2eArm(ROOT, 'e');
  const P = await import(pathToFileURL(path.join(ROOT, 'scripts/lib/agent-git-policy.mjs')).href);
  const expectedNote = P.agentGitPolicyNote(P.normalizeGitWrite({ commit: true, push: false, scope: null }), { orchardDir: ROOT, projectId: E.pid });
  const t = E.dev?.text ?? '';
  check('E0 PRECONDITION: the project is in soft-release mode (the policy PUT took) and Codex wrote a rollout for this cwd',
    E.pol.status === 200 && E.pol.d?.policy?.mode === 'release' && !!E.dev, { put: E.pol.status, mode: E.pol.d?.policy?.mode, err: E.pol.d?.error, rollout: E.dev?.file ?? null, events: E.dev ? undefined : E.events.slice(0, 12).map((e) => `${e.t}:${e.message ?? e.status ?? e.of ?? ''}`) });
  check('E1 Codex\'s developer message holds the Working Agreement', /Working Agreement v4/.test(t), t.slice(0, 200));
  check('E2 …the project\'s docs/CONVENTIONS.md (its canary line)', t.includes(E.CANARY), { canary: E.CANARY });
  check('E3 …the response-format section (digest on)', /response format|Response format|RESPONSE_FORMAT|digest/i.test(t) && /<!--|##/.test(t), (t.match(/.{0,60}(?:[Rr]esponse format).{0,60}/) || [''])[0]);
  check('E4 …and the per-project agent git policy note, byte-for-byte what agentGitPolicyNote produces', !!expectedNote && t.includes(expectedNote), { expectedHead: expectedNote?.split('\n')[0] });

  console.log('EM MUST-FAIL: the same e2e on a constructed mutant tree without the forwarding');
  const mroot = buildMutantTree({ prefix: 'codex-instr-e2e-mutant-', copy: ['src'], edits: MUTANT_EDITS });
  try {
    const M = await e2eArm(mroot, 'em');
    const mt = M.dev?.text ?? '';
    check('EM0 PRECONDITION: the mutant run also produced a rollout for its cwd', !!M.dev, M.dev?.file ?? M.events.slice(0, 12).map((e) => `${e.t}:${e.message ?? e.status ?? e.of ?? ''}`));
    check('EM1 on the mutant the rollout LACKS the conventions canary and the git policy note — the e2e proof is not vacuous', !!M.dev && !mt.includes(M.CANARY) && !/Git policy for this project/.test(mt), { hasCanary: mt.includes(M.CANARY), hasNote: /Git policy for this project/.test(mt) });
  } finally { if (!KEEP) fs.rmSync(mroot, { recursive: true, force: true }); }
}

console.log(`\nTOTAL: ${pass} passed, ${fail} failed${failures.length ? `\nFAILED:\n  - ${failures.join('\n  - ')}` : ''}`);
process.exit(fail ? 1 : 0);
