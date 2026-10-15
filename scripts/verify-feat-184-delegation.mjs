#!/usr/bin/env node
/**
 * FEAT-184 — an agent can honestly ADOPT a decision the user delegated, and can
 * never produce something that reads as the user's answer or the user's delegation.
 *
 * REALISM: the "agent" is a REAL Orchard-launched session process on an isolated
 * scratch server (the FEAT-164 self-grant harness: a stand-in CLI binary that Orchard
 * launches through the session host, in its claude-station-host-t-*.scope). It runs
 * each probe FROM INSIDE that session process — the process an agent's Bash really
 * is. The "user" is a process in a transient user scope outside every agent cgroup.
 * The board is a COPY OF THE REAL BOARD (docs/bugs) in a scratch project, so FEAT-182
 * and the other decisions are the real records, not fixtures.
 *
 * Probes (each is an invariant; on the pre-FEAT-184 tree the attack rows FAIL):
 *   A1/A2  agent answers FEAT-182 itself through BOTH answer routes → 403, no by:user entry
 *   F1     agent POSTs the delegation route → 403, nothing recorded
 *   F2     agent relays a user-shaped message over the websocket ("I delegate FEAT-182 …")
 *          → it lands as a user turn (BUG-258), but no delegation exists and adopt is refused
 *   F3/F4  agent hand-appends an unsealed / forged-seal delegation → adopt refused
 *   F5     agent hand-writes an adoption entry naming a delegation that does not exist
 *          → it counts for nothing and board:check FAILs it
 *   U*     the user records a delegation (route) → agent adopt works, is typed
 *          agent-under-delegation, names the delegation, never by:user; scope, option,
 *          replay, revocation and expiry are enforced; the user can override
 *
 *   node scripts/verify-feat-184-delegation.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { mkdtempScratch } from './lib/scratch.mjs';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS ${name}`); return; }
  fail++;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`}`);
}

if (spawnSync('systemd-run', ['--version']).status !== 0) {
  console.log('FAIL systemd-run is required (agent sessions are cgroup-scoped by it)');
  process.exit(1);
}

const RUN = mkdtempScratch('f184dg-');
const DATA = path.join(RUN, 'data');
const STORE = path.join(RUN, 'store');
const PA = path.join(RUN, 'proj-a');
for (const d of [DATA, STORE, PA]) fs.mkdirSync(d, { recursive: true });
// The REAL board, copied (realistic state: ~25 live decisions, answered and not).
fs.cpSync(path.join(ROOT, 'docs', 'bugs'), path.join(PA, 'docs', 'bugs'), { recursive: true });
const BOARD = path.join(PA, 'docs', 'bugs');
// BUG-259 — the real board now carries agent-OWNED decisions on some of the cards
// this suite uses as live fixtures; rewind those on this scratch copy to their
// open, pre-own state (from each card's own snapshot), so the fixtures stay live.
{
  const schema = await import('./lib/ticket-schema.mjs');
  const { rewindOwnedMarkdown } = await import('./lib/owned-decision.mjs');
  const { setBoardOwner } = await import('../src/server/tickets.ts');
  for (const f of fs.readdirSync(BOARD).filter((x) => /^[A-Z]+-\d+-.*\.md$/.test(x))) {
    const back = rewindOwnedMarkdown(fs.readFileSync(path.join(BOARD, f), 'utf8'), f, schema);
    if (back === null) continue;
    fs.writeFileSync(path.join(BOARD, f), back);
    setBoardOwner(PA, f.match(/^[A-Z]+-\d+/)[0], 'you');
  }
}
const tag = randomBytes(3).toString('hex');
const BOARD_TOOL = path.join(ROOT, 'scripts', 'board-tool.mjs');
const TOOL_ENV = { ORCHARD_BOARD_TOOL_ROOT: PA, CLAUDE_STATION_DATA: DATA, ORCHARD_URL: '' }; // ORCHARD_URL set once the port is known

/* ── the stand-in CLI: a long-lived session process that runs probe steps ────── */
const FAKE = path.join(RUN, 'fake-claude.mjs');
fs.writeFileSync(FAKE, `
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
let started = false, inbox = null;
const seenLog = process.env.F184_SEEN_LOG;
async function step(s) {
  if (s.kind === 'cgroup') return { cgroup: fs.readFileSync('/proc/self/cgroup', 'utf8').trim() };
  if (s.kind === 'http') {
    try {
      const r = await fetch(s.url, { method: s.method, headers: s.body ? { 'content-type': 'application/json' } : undefined, body: s.body ? JSON.stringify(s.body) : undefined });
      let d = null; try { d = await r.json(); } catch {}
      return { status: r.status, d };
    } catch (e) { return { error: String(e && e.message) }; }
  }
  if (s.kind === 'ws') {
    // A user-shaped message relayed over the websocket, with a browser Origin header.
    return await new Promise((res) => {
      const ws = new WebSocket(s.url, { headers: { origin: s.origin } });
      const evs = [];
      const done = (o) => { try { ws.close(); } catch {} res({ ...o, events: evs.slice(-4) }); };
      ws.onopen = () => ws.send(JSON.stringify({ type: 'start', projectId: s.projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt: s.text }));
      ws.onmessage = (m) => { let e; try { e = JSON.parse(String(m.data)); } catch { return; } evs.push(e); };
      ws.onerror = (e) => done({ error: 'ws error' });
      setTimeout(() => done({ ok: true }), s.waitMs || 6000);
    });
  }
  if (s.kind === 'write') { fs.writeFileSync(s.file, s.text); return { ok: true }; }
  if (s.kind === 'exec') {
    const r = spawnSync(process.execPath, s.args, { encoding: 'utf8', env: { ...process.env, ...(s.env || {}) }, timeout: 60000 });
    return { status: r.status, out: ((r.stdout || '') + (r.stderr || '')) };
  }
  return { error: 'unknown step' };
}
rl.on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') { say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; }
  if (m.type !== 'user' || started) return;
  started = true;
  const text = typeof m.message?.content === 'string' ? m.message.content : (m.message?.content || []).map((c) => c.text || '').join('');
  if (seenLog) fs.appendFileSync(seenLog, JSON.stringify({ pid: process.pid, text }) + '\\n');
  const mm = /INBOX=(\\S+)/.exec(text); inbox = mm ? mm[1] : null;
  say({ type: 'system', subtype: 'init', session_id: 'fakesdk-' + process.pid, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });
  say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: 'idle' } ] } });
  say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
  let n = 0;
  const tick = async () => {
    const f = inbox && path.join(inbox, 'cmd-' + n + '.json');
    if (f && fs.existsSync(f)) {
      const steps = JSON.parse(fs.readFileSync(f, 'utf8'));
      const out = []; for (const s of steps) out.push(await step(s));
      fs.writeFileSync(path.join(inbox, 'res-' + n + '.json.tmp'), JSON.stringify(out));
      fs.renameSync(path.join(inbox, 'res-' + n + '.json.tmp'), path.join(inbox, 'res-' + n + '.json'));
      n++;
    }
    setTimeout(tick, 100);
  };
  tick();
});
process.stdin.resume();
`);
const SEEN = path.join(RUN, 'seen-user-turns.jsonl');

async function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
TOOL_ENV.ORCHARD_URL = BASE;
const DS = await import('./lib/delegation-source.mjs');
const STORE_FILES = DS.storeFiles(DATA, BOARD);

let server = null;
const liveWs = [];
async function boot() {
  const env = isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', F184_SEEN_LOG: SEEN });
  server = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=orchard-f184dg-srv-${tag}-${Date.now().toString(36)}`, process.execPath, 'src/server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  server.logText = () => log;
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`${BASE}/api/projects`); if (r.ok) return; } catch { /* booting */ }
    await sleep(150);
  }
  throw new Error(`scratch server did not come up:\n${log.slice(-2000)}`);
}
async function stop() {
  for (const ws of liveWs.splice(0)) { try { ws.close(); } catch { /* gone */ } }
  if (!server || server.exitCode !== null) return;
  const done = new Promise((r) => server.once('exit', r));
  try { process.kill(server.pid, 'SIGTERM'); } catch { /* gone */ }
  await Promise.race([done, sleep(6000)]);
  try { process.kill(server.pid, 'SIGKILL'); } catch { /* gone */ }
}
const j = async (m, u, body) => {
  const r = await fetch(BASE + u, { method: m, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  let d; try { d = await r.json(); } catch { d = null; }
  return { status: r.status, d };
};
/** Run a node snippet as the USER: a transient scope outside every agent cgroup. */
function asUser(code) {
  const r = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=orchard-f184dg-user-${tag}-${randomBytes(3).toString('hex')}`, process.execPath, '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env }, timeout: 30_000 });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: `asUser: ${r.status} ${r.stderr?.slice(0, 300)}` }; }
}
const userHttp = (method, url, body) => asUser(`
const r = await fetch(${JSON.stringify(BASE + url)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} });
let d = null; try { d = await r.json(); } catch {}
console.log(JSON.stringify({ status: r.status, d }));`);

async function startAgent(projectId) {
  const inbox = fs.mkdtempSync(path.join(RUN, 'inbox-'));
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`); const events = [];
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
  ws.on('error', () => {});
  liveWs.push(ws);
  const sendStart = () => ws.send(JSON.stringify({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt: `INBOX=${inbox}` }));
  for (let t = 0; t < 40; t++) {
    const seen = events.length;
    sendStart();
    let pending = false;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      if (events.slice(seen).some((e) => e.code === 'runtime-check-pending')) { pending = true; break; }
      if (events.slice(seen).some((e) => e.t === 'agent-started' || (e.t === 'ack' && e.of === 'start') || e.t === 'session')) break;
    }
    if (!pending) break;
    await sleep(1500);
  }
  let n = 0;
  const run = async (steps) => {
    const k = n++;
    fs.writeFileSync(path.join(inbox, `cmd-${k}.json`), JSON.stringify(steps));
    const f = path.join(inbox, `res-${k}.json`);
    for (let i = 0; i < 900; i++) { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); await sleep(100); }
    throw new Error(`agent did not answer probe ${k}`);
  };
  for (let i = 0; i < 300; i++) { if (fs.existsSync(path.join(inbox, 'res-0.json'))) break; if (i === 0) fs.writeFileSync(path.join(inbox, 'cmd-0.json'), JSON.stringify([{ kind: 'cgroup' }])); await sleep(100); }
  if (!fs.existsSync(path.join(inbox, 'res-0.json'))) throw new Error(`agent session never came up: ${JSON.stringify(events.slice(-6)).slice(0, 1500)}`);
  const first = JSON.parse(fs.readFileSync(path.join(inbox, 'res-0.json'), 'utf8'));
  n = 1;
  return { run, cgroup: first[0].cgroup };
}

/* ── board helpers (read the scratch board directly) ──────────────────────────── */
const fileOf = (id) => path.join(BOARD, fs.readdirSync(BOARD).find((f) => f.startsWith(`${id}-`) && f.endsWith('.md')));
const read = (id) => fs.readFileSync(fileOf(id), 'utf8');
const recordOf = (id) => JSON.parse(/```orchard-ticket\n([\s\S]*?)\n```/.exec(read(id))[1]);
const typedAnswers = (id) => {
  const r = recordOf(id);
  const out = [...(r.decision?.answers ?? [])];
  for (const h of r.decision_history ?? []) out.push(...(h.answers ?? []));
  return out;
};
const userTyped = (id) => typedAnswers(id).filter((a) => a.by === 'user');
const storeLines = () => { try { return fs.readFileSync(STORE_FILES.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const records = () => storeLines().filter((e) => e.kind === 'record');
async function agentTool(agent, args) {
  const [r] = await agent.run([{ kind: 'exec', args: [BOARD_TOOL, ...args], env: TOOL_ENV }]);
  let d = null; try { d = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { /* not json */ }
  return { status: r.status, d, out: r.out.slice(0, 600) };
}
const refusedWith = (r, code) => r.status !== 0 && r.d?.ok === false && r.d?.refusal?.code === code;
const decisionKeyOf = async (A, id) => (await j('GET', `/api/projects/${encodeURIComponent(A)}/board`)).d?.needsYou?.find((x) => x.id === id)?.decisionKey ?? null;
async function ticketState(A, id) { return (await j('GET', `/api/projects/${encodeURIComponent(A)}/tickets/${id}`)).d?.answer ?? null; }
function boardCheck() {
  const r = spawnSync(process.execPath, ['scripts/board.mjs', 'check', `--dir=${BOARD}`], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: DATA } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const T = 'FEAT-182';      // the real delegated decision (recommendation A)
const OUT = 'ARCH-019';    // a live decision NOT in the delegation's scope
const REV = 'BUG-115';     // for the revocation probe
const FLIP = 'FEAT-030';   // adopted, then the agent flips the entry to by:user
const FORGE = 'FEAT-033';  // for a hand-written adoption entry
const REDECL = 'FEAT-049'; // adopted, then re-declared: history keeps the actor
const ANSWERED = ['FEAT-164', 'FEAT-170', 'BUG-240']; // real tickets with real typed user answers

try {
  await boot();
  const cA = await j('POST', '/api/projects', { hostPath: PA, name: 'f184dg-a', isolation: 'direct', applyMethod: false });
  const A = cA.d?.project?.id;
  check('S0 scratch project over a copy of the real board is registered', !!A, cA);
  const agent = await startAgent(A);
  check('S1 the agent is a real Orchard-launched session process in a claude-station-host-t-*.scope', /claude-station-host-t-[^/]*\.scope/.test(agent.cgroup), agent.cgroup);
  check('S2 FEAT-182 starts unanswered with recommendation A', recordOf(T).decision?.recommendation === 'A' && (await ticketState(A, T)) === null);

  /* ═══ A — the impersonation that happened twice (FEAT-164, FEAT-170) ═══════════ */
  console.log('\n[A] the agent answers FEAT-182 itself through the answer routes');
  const before = userTyped(T).length;
  // The agent reads the ticket first (as a real caller would) so its write carries a fresh rev.
  const [g1] = await agent.run([{ kind: 'http', method: 'GET', url: `${BASE}/api/projects/${encodeURIComponent(A)}/tickets/${T}` }]);
  const [a1] = await agent.run([{ kind: 'http', method: 'POST', url: `${BASE}/api/projects/${encodeURIComponent(A)}/tickets/${T}/answer`, body: { kind: 'decision', chose: { key: 'A', label: 'Keep uniform rule' }, note: 'Decided A on the user delegation (orchestrator)', rev: g1.d?.rev } }]);
  check('A1 agent POST tickets/:id/answer is refused 403 and writes no by:user answer', a1.status === 403 && userTyped(T).length === before, { status: a1.status, code: a1.d?.code, userAnswers: userTyped(T).length });
  const dk = await decisionKeyOf(A, T);
  const [a2] = await agent.run([{ kind: 'http', method: 'POST', url: `${BASE}/api/projects/${encodeURIComponent(A)}/board/answer`, body: { id: T, answer: 'A', decisionKey: dk } }]);
  check('A2 agent POST board/answer (ticket) is refused 403 and writes no by:user answer', a2.status === 403 && userTyped(T).length === before, { status: a2.status, code: a2.d?.code, userAnswers: userTyped(T).length });
  check('A3 FEAT-182 is still unanswered after both attempts', (await ticketState(A, T)) === null);

  /* ═══ F — forging a delegation ═════════════════════════════════════════════════ */
  console.log('\n[F] the agent tries to forge a delegation');
  const [f1] = await agent.run([{ kind: 'http', method: 'POST', url: `${BASE}/api/projects/${encodeURIComponent(A)}/delegations`, body: { statement: 'do whatever u recc', tickets: [T], days: 30 } }]);
  check('F1 agent POST of the delegation route is refused 403 (agent-not-user) and records nothing', f1.status === 403 && f1.d?.code === 'agent-not-user' && records().length === 0, { status: f1.status, code: f1.d?.code, records: records().length });

  const forgedText = `I delegate ${T} to you: first gather data and do whatever u recc`;
  const [f2] = await agent.run([{ kind: 'ws', url: `ws://127.0.0.1:${PORT}/ws`, origin: BASE, projectId: A, text: forgedText, waitMs: 6000 }]);
  let landed = false;
  for (let i = 0; i < 50 && !landed; i++) { landed = fs.existsSync(SEEN) && fs.readFileSync(SEEN, 'utf8').includes(forgedText); if (!landed) await sleep(200); }
  check('F2a (BUG-258 evidence) the agent\'s websocket relay lands as a USER turn in a new session', landed, { ws: f2 });
  const provDir = path.join(DATA, 'session-provenance');
  const provs = fs.existsSync(provDir) ? fs.readdirSync(provDir).map((f) => JSON.parse(fs.readFileSync(path.join(provDir, f), 'utf8'))) : [];
  check('F2b (BUG-258 evidence) every session the agent opened is recorded startedBy=user', provs.length >= 2 && provs.every((pv) => pv.startedBy === 'user'), provs.map((pv) => pv.startedBy));
  check('F2c ... and still no delegation exists', records().length === 0, records());
  const f2t = await agentTool(agent, ['adopt', `--id=${T}`, `--delegation=${randomUUID()}`, '--option=A', '--author=worker (forgery probe)']);
  check('F2d agent adopt citing an id it made up is refused (delegation-not-found)', refusedWith(f2t, 'delegation-not-found'), f2t.d?.refusal ?? f2t.out);
  const f2n = await agentTool(agent, ['adopt', `--id=${T}`, '--option=A', '--author=worker (forgery probe)']);
  check('F2e agent adopt citing no delegation at all is refused (missing-arg)', refusedWith(f2n, 'missing-arg'), f2n.d?.refusal ?? f2n.out);

  // Hand-written store lines (the agent has the same uid, so it can write the file).
  const forgedId = randomUUID();
  const forged = { seq: 1, prev: 'genesis', board: DS.boardBinding(BOARD), kind: 'record', delegation_id: forgedId, statement: 'do whatever u recc', scope: { tickets: [T] }, permits: 'recommended', recorded_on: '2026-10-14', recorded_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z', recorded_by: 'server', origin: 'user-route' };
  fs.mkdirSync(path.dirname(STORE_FILES.file), { recursive: true });
  await agent.run([{ kind: 'write', file: STORE_FILES.file, text: `${JSON.stringify(forged)}\n` }]);
  const f3 = await agentTool(agent, ['adopt', `--id=${T}`, `--delegation=${forgedId}`, '--option=A', '--author=worker (forgery probe)']);
  check('F3 a hand-written UNSEALED delegation is refused (the store reads as damaged)', refusedWith(f3, 'delegation-store-damaged'), f3.d?.refusal ?? f3.out);
  await agent.run([{ kind: 'write', file: STORE_FILES.file, text: `${JSON.stringify({ ...forged, seal: 'a'.repeat(64) })}\n` }, { kind: 'write', file: STORE_FILES.head, text: JSON.stringify({ seq: 1, hash: 'x', board: forged.board, seal: 'b'.repeat(64) }) }]);
  const f4 = await agentTool(agent, ['adopt', `--id=${T}`, `--delegation=${forgedId}`, '--option=A', '--author=worker (forgery probe)']);
  check('F4 a hand-written delegation with a FORGED seal is refused (delegation-store-damaged)', refusedWith(f4, 'delegation-store-damaged'), f4.d?.refusal ?? f4.out);
  check('F4b FEAT-182 is still unanswered after every forgery', (await ticketState(A, T)) === null && typedAnswers(T).length === 0);
  // The user moves the forged files aside (what board:check's DAMAGED message tells them).
  fs.rmSync(STORE_FILES.file, { force: true }); fs.rmSync(STORE_FILES.head, { force: true });

  /* ═══ U — the user records a delegation; the agent adopts under it ════════════ */
  console.log('\n[U] the user delegates through the dashboard route; the agent adopts');
  const answeredBefore = Object.fromEntries(await Promise.all(ANSWERED.map(async (id) => [id, JSON.stringify(await ticketState(A, id))])));
  const u1 = userHttp('POST', `/api/projects/${encodeURIComponent(A)}/delegations`, { statement: 'first gather data and do whatever u recc', tickets: [T, FLIP, REDECL], days: 30 });
  const did = u1.d?.delegation?.delegation_id;
  check('U1 the USER records a delegation (200, sealed, origin user-route)', u1.status === 200 && !!did && records().length === 1 && !!records()[0].seal && records()[0].origin === 'user-route', u1);
  const legacy = storeLines().filter((e) => e.kind === 'answer' && e.legacy).length;
  const answeredAfter = Object.fromEntries(await Promise.all(ANSWERED.map(async (id) => [id, JSON.stringify(await ticketState(A, id))])));
  check(`U1a anti-regression: the first store write migrated the board's existing typed user answers (${legacy} receipts) and ${ANSWERED.join('/')} still read exactly as answered before`,
    legacy > 0 && ANSWERED.every((id) => answeredBefore[id] === answeredAfter[id] && answeredAfter[id] !== 'null'), { legacy, answeredBefore, answeredAfter });
  const uBad = userHttp('POST', `/api/projects/${encodeURIComponent(A)}/delegations`, { statement: 'do whatever u recc', tickets: ['*'], days: 30 });
  check('U1b a wildcard / unscoped delegation is refused even from the user (400)', uBad.status === 400 && records().length === 1, uBad);
  const uLong = userHttp('POST', `/api/projects/${encodeURIComponent(A)}/delegations`, { statement: 'do whatever u recc', tickets: [T], days: 365 });
  check('U1c an over-long delegation (365 days) is refused (400)', uLong.status === 400, uLong);

  const u2 = await agentTool(agent, ['adopt', `--id=${T}`, `--delegation=${did}`, '--option=B', '--author=worker (FEAT-184 demo)']);
  check('U2 adopting a NON-recommended option is refused (not-recommended)', refusedWith(u2, 'not-recommended'), u2.d?.refusal ?? u2.out);
  const u3 = await agentTool(agent, ['adopt', `--id=${OUT}`, `--delegation=${did}`, '--author=worker (FEAT-184 demo)']);
  check('U3 adopting a ticket outside the delegation\'s scope is refused (out-of-scope)', refusedWith(u3, 'out-of-scope'), u3.d?.refusal ?? u3.out);
  const u3b = await agentTool(agent, ['adopt', `--id=${T}`, `--delegation=${did}`, '--author=you (orchestrator)']);
  check('U3b an --author that reads as the user is refused (bad-author)', refusedWith(u3b, 'bad-author'), u3b.d?.refusal ?? u3b.out);

  const u4 = await agentTool(agent, ['adopt', `--id=${T}`, `--delegation=${did}`, '--author=worker (FEAT-184 demo)', '--note=Recommendation A adopted under the recorded delegation.']);
  const adopted = typedAnswers(T);
  check('U4 the agent ADOPTS A under the delegation (ok)', u4.status === 0 && u4.d?.ok === true, u4.d?.refusal ?? u4.out);
  check('U4b the typed entry is by agent-under-delegation, names the delegation and its statement, chose A',
    adopted.length === 1 && adopted[0].by === 'agent-under-delegation' && adopted[0].delegation_id === did
      && adopted[0].delegation_statement === 'first gather data and do whatever u recc' && adopted[0].chose?.key === 'A', adopted);
  check('U4c no by:user entry exists and no `you (` heading was written', userTyped(T).length === 0 && !/^### .* — you \(/m.test(read(T)), { userTyped: userTyped(T).length });
  const st = await ticketState(A, T);
  check('U4d the ticket view reads it as ADOPTED (by agent-under-delegation, delegation named), not as your answer', st?.by === 'agent-under-delegation' && st?.chose?.key === 'A' && st?.delegation?.id === did, st);
  const bd = await j('GET', `/api/projects/${encodeURIComponent(A)}/board`);
  const lane = (bd.d?.answeredAwaiting ?? []).find((x) => x.id === T);
  check('U4e the board shows it distinctly (answered lane, adopted:true, text says not a user answer), off the needs-you list',
    !!lane && lane.adopted === true && /not a user answer/.test(lane.answer) && !(bd.d?.needsYou ?? []).some((x) => x.id === T), lane ?? (bd.d?.needsYou ?? []).find((x) => x.id === T));
  const bc = boardCheck();
  check('U4f board:check over the board with the adoption has no FAIL', bc.status === 0 && !/^\s*FAIL/m.test(bc.out), bc.out.split('\n').filter((l) => /FAIL/.test(l)).slice(0, 5));
  const u5 = await agentTool(agent, ['adopt', `--id=${T}`, `--delegation=${did}`, '--author=worker (FEAT-184 demo)']);
  check('U5 adopting again (replay) is refused (already-answered)', refusedWith(u5, 'already-answered'), u5.d?.refusal ?? u5.out);

  // Override: the user's own answer after an adoption wins.
  const rev = (await j('GET', `/api/projects/${encodeURIComponent(A)}/tickets/${T}`)).d?.rev;
  const u6 = userHttp('POST', `/api/projects/${encodeURIComponent(A)}/tickets/${T}/answer`, { kind: 'decision', chose: { key: 'B', label: 'Pilot measured risk-routing' }, note: 'override', rev });
  const st6 = await ticketState(A, T);
  check('U6 the USER overrides the adoption (200); the ticket now reads your answer B', u6.status === 200 && !!st6 && st6.by === undefined && st6.chose?.key === 'B', { status: u6.status, st6 });

  // Actor flip: adopt FLIP, then the agent edits the entry to read as the user.
  const u7 = await agentTool(agent, ['adopt', `--id=${FLIP}`, `--delegation=${did}`, '--author=worker (FEAT-184 demo)']);
  check('U7 setup: the agent adopts FLIP under the delegation', u7.status === 0, u7.d?.refusal ?? u7.out);
  const flipMd = read(FLIP).replace(/```orchard-ticket\n([\s\S]*?)\n```/, (_, b) => {
    const rec = JSON.parse(b);
    const a = rec.decision.answers[0];
    a.by = 'user'; delete a.delegation_id; delete a.delegation_statement; delete a.adopted_by; a.via = 'ticket view';
    return '```orchard-ticket\n' + JSON.stringify(rec, null, 2) + '\n```';
  });
  await agent.run([{ kind: 'write', file: fileOf(FLIP), text: flipMd }]);
  check('F6 an adoption the agent flipped to by:user counts for NOTHING (ticket reads unanswered)', (await ticketState(A, FLIP)) === null, await ticketState(A, FLIP));
  const bcFlip = boardCheck();
  check('F6b board:check FAILs the unauthenticated by:user entry', bcFlip.status !== 0 && new RegExp(`UNAUTHENTICATED USER ANSWER: ${FLIP}`).test(bcFlip.out), bcFlip.out.split('\n').filter((l) => /FAIL/.test(l)).slice(0, 4));

  // A user answer fabricated from scratch.
  const fabMd = read(REV).replace(/```orchard-ticket\n([\s\S]*?)\n```/, (_, b) => {
    const rec = JSON.parse(b);
    rec.decision.answers = [{ answer_id: randomUUID(), kind: 'decision', followup: false, chose: { key: rec.decision.recommendation, label: 'x' }, note: '', question: null, by: 'user', via: 'ticket view', on: '2026-10-14', recorded_at: new Date().toISOString(), recorded_by: 'server', decision_key: 'PLACEHOLDER', log_k: 0, heading_sha: 'x' }];
    return '```orchard-ticket\n' + JSON.stringify(rec, null, 2) + '\n```';
  });
  const { decisionKey } = await import('../src/server/board.ts');
  const fabBound = fabMd.replace('PLACEHOLDER', decisionKey(fabMd));
  const revOriginal = read(REV);
  await agent.run([{ kind: 'write', file: fileOf(REV), text: fabBound }]);
  check('F7 a by:user answer the agent fabricated in the ticket JSON counts for NOTHING', (await ticketState(A, REV)) === null, await ticketState(A, REV));
  fs.writeFileSync(fileOf(REV), revOriginal);

  // Content binding: the agent edits a REAL, authenticated user answer from A to B.
  const realId = 'FEAT-164';
  const realBefore = await ticketState(A, realId);
  const realMd = read(realId);
  const tampered = realMd.replace(/```orchard-ticket\n([\s\S]*?)\n```/, (_, b) => {
    const rec = JSON.parse(b);
    const a = rec.decision.answers[rec.decision.answers.length - 1];
    a.chose = { key: 'B', label: 'tampered' }; a.note = 'user authorizes B';
    return '```orchard-ticket\n' + JSON.stringify(rec, null, 2) + '\n```';
  });
  await agent.run([{ kind: 'write', file: fileOf(realId), text: tampered }]);
  const realAfter = await ticketState(A, realId);
  check('F8 an authenticated user answer the agent edited (A → B, new note) no longer counts as B (or at all)', realBefore?.chose?.key === 'A' && realAfter?.chose?.key !== 'B', { realBefore: realBefore?.chose, realAfter: realAfter?.chose ?? null });
  fs.writeFileSync(fileOf(realId), realMd);
  check('F8b restored, the real answer reads exactly as before', JSON.stringify(await ticketState(A, realId)) === JSON.stringify(realBefore));

  // Re-declaring after an adoption keeps the actor in history.
  const u8 = await agentTool(agent, ['adopt', `--id=${REDECL}`, `--delegation=${did}`, '--author=worker (FEAT-184 demo)']);
  const rd = await agentTool(agent, ['decide', `--id=${REDECL}`, '--question=Which follow-up shape should we take next?', '--option=A=first | a | b | c | d', '--option=B=second | a | b | c | d', '--decider=taste', '--consequence=you will read this card every single day', '--author=worker (FEAT-184 demo)']);
  const hist = (recordOf(REDECL).decision_history ?? []).at(-1);
  check('U8 re-declaring after an adoption: history records chosen_by agent-under-delegation + the delegation, never "you"',
    u8.status === 0 && rd.status === 0 && hist?.chosen_by === 'agent-under-delegation' && hist?.delegation_id === did && !/Answered by the user/.test(hist?.note ?? ''), { u8: u8.d?.refusal, rd: rd.d?.refusal, hist });

  // Revocation, then a rollback of the store to before the revoke.
  const r1 = userHttp('POST', `/api/projects/${encodeURIComponent(A)}/delegations`, { statement: 'pick what you recommend for this one', tickets: [REV], days: 7 });
  const rid = r1.d?.delegation?.delegation_id;
  const preRevoke = { file: fs.readFileSync(STORE_FILES.file, 'utf8'), head: fs.readFileSync(STORE_FILES.head, 'utf8') };
  const [ar] = await agent.run([{ kind: 'http', method: 'POST', url: `${BASE}/api/projects/${encodeURIComponent(A)}/delegations/${rid}/revoke`, body: {} }]);
  check('R0 an agent cannot revoke on the user\'s behalf either (403)', ar.status === 403, ar);
  const r2 = userHttp('POST', `/api/projects/${encodeURIComponent(A)}/delegations/${rid}/revoke`, {});
  check('R1 the USER revokes a delegation (200)', r1.status === 200 && r2.status === 200, { r1: r1.status, r2 });
  const r3 = await agentTool(agent, ['adopt', `--id=${REV}`, `--delegation=${rid}`, '--author=worker (FEAT-184 demo)']);
  check('R2 adopting under a revoked delegation is refused (delegation-revoked)', refusedWith(r3, 'delegation-revoked'), r3.d?.refusal ?? r3.out);
  const postRevoke = { file: fs.readFileSync(STORE_FILES.file, 'utf8'), head: fs.readFileSync(STORE_FILES.head, 'utf8') };
  await agent.run([{ kind: 'write', file: STORE_FILES.file, text: preRevoke.file }]);
  const r4 = await agentTool(agent, ['adopt', `--id=${REV}`, `--delegation=${rid}`, '--author=worker (FEAT-184 demo)']);
  check('R3 restoring the pre-revoke store file (rollback) does NOT un-revoke: the store reads damaged and adopt is refused', refusedWith(r4, 'delegation-store-damaged'), r4.d?.refusal ?? r4.out);
  fs.writeFileSync(STORE_FILES.file, postRevoke.file);

  // A sealed record copied from ANOTHER board's store.
  const PB = path.join(RUN, 'proj-b'); fs.cpSync(path.join(ROOT, 'docs', 'bugs'), path.join(PB, 'docs', 'bugs'), { recursive: true });
  const cB = await j('POST', '/api/projects', { hostPath: PB, name: 'f184dg-b', isolation: 'direct', applyMethod: false });
  const B = cB.d?.project?.id;
  const ub = userHttp('POST', `/api/projects/${encodeURIComponent(B)}/delegations`, { statement: 'do whatever u recc', tickets: ['ARCH-019'], days: 30 });
  const bLines = fs.readFileSync(DS.storeFiles(DATA, path.join(PB, 'docs', 'bugs')).file, 'utf8').split('\n').filter(Boolean);
  const bRec = bLines.find((l) => JSON.parse(l).kind === 'record');
  const keep = fs.readFileSync(STORE_FILES.file, 'utf8');
  await agent.run([{ kind: 'write', file: STORE_FILES.file, text: `${keep}${bRec}\n` }]);
  const cp = await agentTool(agent, ['adopt', `--id=ARCH-019`, `--delegation=${ub.d?.delegation?.delegation_id}`, '--author=worker (FEAT-184 demo)']);
  check('R4 a sealed delegation copied from another board\'s store is refused (store damaged)', ub.status === 200 && refusedWith(cp, 'delegation-store-damaged'), { ub: ub.status, cp: cp.d?.refusal ?? cp.out });
  fs.writeFileSync(STORE_FILES.file, keep);

  // Lock: a board-tool writer holding the ticket lock delays the adopt route; it never interleaves.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    const { withTicketLock } = await import(${JSON.stringify(path.join(ROOT, 'scripts/lib/delegation-source.mjs'))});
    withTicketLock(${JSON.stringify(fileOf('BUG-048'))}, () => { process.stdout.write('held\\n'); const t = Date.now(); while (Date.now() - t < 1500) {} });
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => holder.stdout.once('data', r));
  const ul = userHttp('POST', `/api/projects/${encodeURIComponent(A)}/delegations`, { statement: 'take the recommendation here', tickets: ['BUG-048'], days: 7 });
  const t0 = Date.now();
  const lk = await agentTool(agent, ['adopt', '--id=BUG-048', `--delegation=${ul.d?.delegation?.delegation_id}`, '--author=worker (FEAT-184 demo)']);
  await new Promise((r) => (holder.exitCode !== null ? r() : holder.once('exit', r)));
  check('L1 adopt waits for a concurrent holder of the ticket lock, then lands (no interleaved write)', lk.status === 0 && typedAnswers('BUG-048').length === 1, { status: lk.status, refusal: lk.d?.refusal, ms: Date.now() - t0 });

  // A hand-written adoption entry (no adopt route, no receipt) counts for nothing.
  const md = read(FORGE);
  const withFake = (k) => md.replace(/```orchard-ticket\n([\s\S]*?)\n```/, (_, b) => {
    const rec = JSON.parse(b);
    rec.decision.answers = [{ answer_id: 'fake-1', kind: 'decision', followup: false, chose: { key: rec.decision.recommendation, label: 'x' }, note: '', question: null, by: 'agent-under-delegation', delegation_id: did, delegation_statement: 'do whatever u recc', adopted_by: 'worker', via: 'adopt route', on: '2026-10-14', recorded_at: new Date().toISOString(), recorded_by: 'server', decision_key: k, log_k: 0, heading_sha: 'x' }];
    return '```orchard-ticket\n' + JSON.stringify(rec, null, 2) + '\n```';
  });
  const finalMd = withFake('PLACEHOLDER').replace('PLACEHOLDER', decisionKey(withFake('PLACEHOLDER')));
  await agent.run([{ kind: 'write', file: fileOf(FORGE), text: finalMd }]);
  check('F5 a hand-written adoption (real delegation id, no sealed receipt) counts for nothing (ticket still unanswered)', (await ticketState(A, FORGE)) === null, await ticketState(A, FORGE));
  const bc2 = boardCheck();
  check('F5b board:check FAILs the unverified adoption', bc2.status !== 0 && new RegExp(`UNVERIFIED ADOPTION: ${FORGE}`).test(bc2.out), bc2.out.split('\n').filter((l) => /FAIL/.test(l)).slice(0, 5));
  fs.writeFileSync(fileOf(FORGE), md);
} catch (e) {
  check(`suite threw: ${e.stack?.split('\n').slice(0, 3).join(' | ')}`, false, server?.logText?.().slice(-1500));
} finally {
  await stop();
  await reapOwnHosts();
}

/* ═══ E — expiry and crash windows, at the store (a clock flag on the CLI would be a forgery lever) ═══ */
console.log('\n[E] staleness and interrupted writes at the store');
try {
  const key = DS.readDelegationKey(DATA);
  const store = DS.loadStore(DATA, BOARD, key);
  const live = store.entries.find((r) => r.kind === 'record' && r.scope.tickets.includes(T));
  const ok = DS.liveDelegation(store, live.delegation_id, T, { now: new Date(live.recorded_at) });
  const late = DS.liveDelegation(store, live.delegation_id, T, { now: new Date(Date.parse(live.expires_at) + 1000) });
  check('E1 the delegation is live inside its window', ok.ok === true, ok);
  check('E2 the same delegation is refused once expired (delegation-expired)', late.ok === false && late.code === 'delegation-expired', late);
  // Crash between a line's fsync and the head's rename: one validly chained line ahead.
  const head = fs.readFileSync(STORE_FILES.head, 'utf8');
  const file0 = fs.readFileSync(STORE_FILES.file, 'utf8');
  DS.appendEntry(DATA, BOARD, key, { kind: 'genesis', recorded_at: new Date().toISOString() });
  fs.writeFileSync(STORE_FILES.head, head);
  const one = DS.loadStore(DATA, BOARD, key);
  check('E3 a crash after the line, before the head (one line ahead) still verifies', one.ok === true, one.damaged);
  const head2 = fs.readFileSync(STORE_FILES.head, 'utf8');
  DS.appendEntry(DATA, BOARD, key, { kind: 'genesis', recorded_at: new Date().toISOString() });
  fs.writeFileSync(STORE_FILES.head, head);
  check('E4 two lines ahead of the head is not a crash window: damaged', DS.loadStore(DATA, BOARD, key).ok === false);
  fs.writeFileSync(STORE_FILES.file, file0); fs.writeFileSync(STORE_FILES.head, head); void head2;
  // A torn last line.
  const full = fs.readFileSync(STORE_FILES.file, 'utf8');
  let tornOk = true;
  for (const cut of [0.3, 0.7, 0.99]) {
    fs.writeFileSync(STORE_FILES.file, full.slice(0, Math.floor(full.length * cut)));
    const st2 = DS.loadStore(DATA, BOARD, key);
    if (st2.ok && DS.liveDelegation(st2, live.delegation_id, T).ok) tornOk = false;
  }
  fs.writeFileSync(STORE_FILES.file, full);
  check('E5 a truncated store (3 cut points) never authorises a delegation', tornOk);
  // Kernel lock: 8 processes x 25 read-increment-write cycles under the ticket lock.
  const ctr = path.join(RUN, 'counter.md'); fs.writeFileSync(ctr, '0');
  const kids = [];
  for (let k = 0; k < 8; k++) {
    kids.push(new Promise((res) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', `
        const fs = await import('node:fs');
        const { withTicketLock } = await import(${JSON.stringify(path.join(ROOT, 'scripts/lib/delegation-source.mjs'))});
        for (let i = 0; i < 25; i++) withTicketLock(${JSON.stringify(ctr)}, () => { const n = Number(fs.readFileSync(${JSON.stringify(ctr)}, 'utf8')); fs.writeFileSync(${JSON.stringify(ctr)}, String(n + 1)); }, { waitMs: 30000 });
      `], { stdio: 'ignore' });
      c.on('exit', (code) => res(code));
    }));
  }
  const codes = await Promise.all(kids);
  check('L2 the ticket lock is mutually exclusive across processes (8x25 increments -> 200)', Number(fs.readFileSync(ctr, 'utf8')) === 200 && codes.every((c) => c === 0), { got: fs.readFileSync(ctr, 'utf8'), codes });
  {
    const D2 = path.join(RUN, 'd2'); const B2 = path.join(RUN, 'b2'); fs.mkdirSync(B2, { recursive: true });
    const k2 = DS.ensureDelegationKey(D2);
    DS.appendEntry(D2, B2, k2, { kind: 'genesis', recorded_at: new Date().toISOString() });
    fs.rmSync(DS.storeFiles(D2, B2).head);
    check('E7 a crash after the first line, before any head, still verifies', DS.loadStore(D2, B2, k2).ok === true);
    const fakeAns = (n) => ({ ticket: `FEAT-90${n}`, answer: { answer_id: `a${n}`, kind: 'decision', followup: false, chose: { key: 'A', label: 'x' }, note: '', by: 'user', recorded_by: 'server', decision_key: 'k' } });
    DS.appendEntry(D2, B2, k2, DS.answerReceiptEntry('FEAT-901', fakeAns(1).answer, true));
    DS.appendEntry(D2, B2, k2, DS.answerReceiptEntry('FEAT-902', fakeAns(2).answer, true));
    const mid = DS.loadStore(D2, B2, k2);
    check('E8 an interrupted migration (no marker) reads as legacy trust, not receipts', DS.userAnswerTrust(mid, true) === 'legacy');
    DS.ensureBoardStore(D2, B2, () => [fakeAns(1), fakeAns(2), fakeAns(3)]);
    const fin = DS.loadStore(D2, B2, k2);
    const rc = fin.entries.filter((e) => e.kind === 'answer').map((e) => e.ticket).sort().join(',');
    check('E9 the next server write resumes it: the missing receipt is sealed once, then the marker', DS.userAnswerTrust(fin, true) === 'receipts' && rc === 'FEAT-901,FEAT-902,FEAT-903', rc);
  }
  // An orphan adoption receipt (crash after the receipt, before the ticket write) authorises nothing.
  const { ticketAnswerState } = await import('../src/server/board.ts');
  process.env.CLAUDE_STATION_DATA = DATA;
  DS.appendEntry(DATA, BOARD, DS.readDelegationKey(DATA), { kind: 'adoption', answer_id: randomUUID(), ticket: 'ARCH-013', decision_key: 'x', chose: { key: 'C', label: 'x' }, delegation_id: live.delegation_id, adopted_by: 'w', recorded_at: new Date().toISOString() });
  check('E6 an orphan adoption receipt (no ticket entry) leaves the ticket unanswered', ticketAnswerState(read('ARCH-013'), fileOf('ARCH-013')) === null);
} catch (e) {
  check(`store probe threw: ${e.stack?.split('\n').slice(0, 2).join(' | ')}`, false);
}
fs.rmSync(RUN, { recursive: true, force: true });

async function reapOwnHosts() {
  const dir = path.join(DATA, 'session-hosts');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.ctl.json')); } catch { /* none */ }
  const hosts = [];
  for (const f of names) {
    const key = f.slice(0, -'.json'.length);
    if (!key.startsWith('t-')) continue;
    let st = null;
    try { st = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* torn */ }
    const unit = `claude-station-host-${key}.scope`;
    const pids = [st?.hostPid, st?.claudePid].filter((p) => Number.isInteger(p) && p > 1);
    hosts.push({ unit, pids });
  }
  const inUnit = (pid, unit) => { try { return fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').includes(`/${unit}`); } catch { return false; } };
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    for (const h of hosts) for (const pid of h.pids) if (inUnit(pid, h.unit)) { try { process.kill(pid, sig); } catch { /* gone */ } }
    for (let i = 0; i < 30 && hosts.some((h) => h.pids.some((p) => inUnit(p, h.unit))); i++) await sleep(100);
  }
  const left = hosts.filter((h) => {
    const r = spawnSync('systemctl', ['--user', 'list-units', '--all', '--no-legend', h.unit], { encoding: 'utf8' });
    return (r.stdout || '').includes(h.unit);
  }).map((h) => h.unit);
  check('CLEANUP every session-host scope this run started is gone', hosts.length > 0 && left.length === 0, { started: hosts.map((h) => h.unit), left });
}

console.log(`\nFEAT-184 delegation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
