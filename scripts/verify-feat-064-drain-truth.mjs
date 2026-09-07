/**
 * FEAT-064 — post-restart drain truth surface + the commitDrain midTurn gate.
 *
 *   node scripts/verify-feat-064-drain-truth.mjs
 *
 * Two halves (BUG-048's explore, "first dispatchable increment"):
 *
 * 1. TRUTH SURFACE. The broker's decline/status heartbeats must carry WHAT is
 *    holding the drain — `backgroundLive` (count), the sniffed background task
 *    ids, and `drainHeldSince` — and that truth must flow through:
 *      - the broker's own status-file heartbeats (SECTION 1),
 *      - the index.ts resume-refusal payload (`drain: {...}`) and /api/health's
 *        survivor broker rows (SECTION 3),
 *      - the BUG-045 drain-wait chip: "waiting on drain — held Ns by N
 *        background agent(s) — retries itself" (SECTION 3, real app.js).
 *    PRE-FIX: every one of those FAILS — today's status file, refusal payload
 *    and chip carry none of it (the chip says only "waiting for the previous
 *    turn to finish draining").
 *
 * 2. THE LATENT BUG (BUG-022 §3 class). `commitDrain()` re-checks ONLY
 *    background lifetime — if a turn is in flight when the background level
 *    empties (e.g. a turn injected during the BUG-044 hold), the EOF lands
 *    MID-TURN and truncates it. SECTION 2 plants exactly that sequence with a
 *    fake CLI: PRE-FIX the fake CLI records stdin-EOF arriving mid-turn
 *    (FAIL); post-fix the commit declines until the turn's `result` lands,
 *    and a bounded window (CLAUDE_STATION_HOST_DRAIN_MIDTURN_MS) keeps a
 *    result-less turn from wedging the drain forever.
 *
 * SAFETY: free ports, scratch dataDirs, everything killed BY PID; :4317 / the
 * real service / other scopes are never touched.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Window } from 'happy-dom';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const HOST_SCRIPT = path.join(ROOT, 'src', 'server', 'session-host.mjs');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f64-work-'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f64-data-'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/* -------------------------------------------------------------- fake CLI ---
 * Speaks just enough stream-json for the broker's sniffer. Flag files drive
 * the mid-turn sequence; an events log records when stdin-EOF arrived and
 * whether the injected turn's `result` had landed by then (the truncation
 * detector for section 2).
 * -------------------------------------------------------------------------- */
const FAKE_CLI = path.join(WORK, 'fake-cli.mjs');
fs.writeFileSync(FAKE_CLI, `
import * as fs from 'node:fs';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const log = (o) => { if (process.env.FAKE_EVENTS) fs.appendFileSync(process.env.FAKE_EVENTS, JSON.stringify(o) + '\\n'); };
say({ type: 'system', subtype: 'init', session_id: process.env.FAKE_SDK_ID || ('fake-sdk-' + process.pid) });
say({ type: 'result', subtype: 'success' });
let midTurnOpen = false;
if (process.env.FAKE_EMIT_BG === '1') {
  say({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: process.env.FAKE_TASK_ID || 'bg-task-1', task_type: 'local_agent' },
  ] });
  say({ type: 'result', subtype: 'success' }); // the level frame must not leave midTurn=true
}
const midFlag = process.env.FAKE_MID_FLAG;
const resultFlag = process.env.FAKE_RESULT_FLAG;
let midFired = false, resultFired = false;
const iv = setInterval(() => {
  if (midFlag && !midFired && fs.existsSync(midFlag)) {
    midFired = true;
    // The hazard sequence: a turn goes in flight, THEN the background level
    // empties — pre-fix the broker's recheck EOFs mid-turn right here.
    say({ type: 'assistant', message: { content: [{ type: 'text', text: 'injected turn in flight' }] } });
    say({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    midTurnOpen = true;
    log({ ev: 'mid-turn-open', at: Date.now() });
  }
  if (resultFlag && !resultFired && fs.existsSync(resultFlag)) {
    resultFired = true;
    say({ type: 'result', subtype: 'success' });
    midTurnOpen = false;
    log({ ev: 'result-landed', at: Date.now() });
  }
}, 150);
iv.unref?.();
process.stdin.on('end', () => {
  log({ ev: 'stdin-eof', at: Date.now(), midTurnOpen });
  if (process.env.FAKE_IGNORE_EOF === '1') { setInterval(() => {}, 1000); }
  else process.exit(0);
});
process.stdin.resume();
setInterval(() => {}, 1000); // stay alive while flags are pending
`);

const brokerDirs = [];
function mkBroker(name, env, { dir = null, key = 'host' } = {}) {
  const d = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `cs-f64-broker-${name}-`));
  if (!dir) brokerDirs.push(d);
  fs.mkdirSync(d, { recursive: true });
  const ctl = path.join(d, `${key}.ctl.json`);
  const statusPath = path.join(d, `${key}.json`);
  fs.writeFileSync(ctl, JSON.stringify({
    sock: path.join(d, `${key}.sock`), status: statusPath, errlog: path.join(d, `${key}.err`),
    command: process.execPath, args: [FAKE_CLI], meta: { stationSessionId: `fake-${name}` },
  }));
  const broker = spawn(process.execPath, [HOST_SCRIPT, ctl], {
    cwd: d,
    env: {
      ...process.env,
      CLAUDE_STATION_HOST_ABANDON_MS: '300000',
      CLAUDE_STATION_HOST_DRAIN_TERM_MS: '2000',
      CLAUDE_STATION_HOST_DRAIN_KILL_LAG_MS: '1000',
      CLAUDE_STATION_HOST_DRAIN_RECHECK_MS: '400',
      ...env,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return { dir: d, statusPath, broker };
}
function stopBrokerFamily(x) {
  const st = readJson(x.statusPath);
  for (const p of [st?.claudePid, st?.hostPid, x.broker?.pid]) {
    if (p && pidAlive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  }
}

/* -------------------------------------------------------------------------- *
 * SECTION 1 — the broker's decline heartbeats carry the truth (FAILS pre-fix)
 * -------------------------------------------------------------------------- */
async function sectionBrokerTruth() {
  console.log('\n=== SECTION 1: broker decline heartbeats carry backgroundLive/taskIds/drainHeldSince ===');
  const events = path.join(WORK, 's1-events.log');
  const a = mkBroker('truth', {
    FAKE_EMIT_BG: '1', FAKE_TASK_ID: 'bg-feat064-probe', FAKE_IGNORE_EOF: '1', FAKE_EVENTS: events,
  });
  await sleep(1200);
  try { process.kill(a.broker.pid, 'SIGTERM'); } catch { /* gone */ } // = boot re-adopt's reapHost
  await sleep(2500); // several 400ms rechecks: the drain is HELD and heartbeating
  const st1 = readJson(a.statusPath);
  check('S1: while the drain is HELD, the status heartbeat carries backgroundLive as a COUNT (1)',
    st1?.state === 'draining' && st1?.backgroundLive === 1,
    { state: st1?.state, backgroundLive: st1?.backgroundLive ?? '(absent)' });
  check('S1: the heartbeat names the sniffed background task id',
    Array.isArray(st1?.backgroundTaskIds) && st1.backgroundTaskIds.includes('bg-feat064-probe'),
    { backgroundTaskIds: st1?.backgroundTaskIds ?? '(absent)' });
  const heldMs = st1?.drainHeldSince ? Date.parse(st1.drainHeldSince) : NaN;
  check('S1: the heartbeat carries a parseable drainHeldSince stamp from the first decline',
    Number.isFinite(heldMs) && Date.now() - heldMs < 60_000 && Date.now() - heldMs >= 0,
    { drainHeldSince: st1?.drainHeldSince ?? '(absent)' });
  await sleep(1200);
  const st2 = readJson(a.statusPath);
  check('S1: drainHeldSince is STABLE across heartbeats while updatedAt advances (an epoch, not a ticker)',
    !!st2 && st2.drainHeldSince === st1?.drainHeldSince && st2.updatedAt !== st1?.updatedAt,
    { first: st1?.drainHeldSince, later: st2?.drainHeldSince, updatedAtAdvanced: st2?.updatedAt !== st1?.updatedAt });
  stopBrokerFamily(a);
}

/* -------------------------------------------------------------------------- *
 * SECTION 2 — commitDrain must not EOF mid-turn (the FAIL-pre-fix half), and
 * the midTurn hold must stay BOUNDED (anti-regression half).
 * -------------------------------------------------------------------------- */
async function sectionMidTurnGate() {
  console.log('\n=== SECTION 2: commitDrain midTurn gate (BUG-022 §3 truncation class) ===');
  const events = path.join(WORK, 's2-events.log');
  const midFlag = path.join(WORK, 's2-mid.flag');
  const resultFlag = path.join(WORK, 's2-result.flag');
  const b = mkBroker('midturn', {
    FAKE_EMIT_BG: '1', FAKE_EVENTS: events, FAKE_MID_FLAG: midFlag, FAKE_RESULT_FLAG: resultFlag,
  });
  await sleep(1200);
  try { process.kill(b.broker.pid, 'SIGTERM'); } catch { /* gone */ }
  await sleep(1500); // drain is held on the live background level
  // THE HAZARD: a turn goes in flight, THEN the level empties.
  fs.writeFileSync(midFlag, '1');
  await sleep(4000); // >> recheck(400ms): pre-fix the commit EOFs right here, mid-turn
  const evts = () => (fs.existsSync(events) ? fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const midEof = evts().find((e) => e.ev === 'stdin-eof');
  const stHeld = readJson(b.statusPath);
  check('S2 (LOAD-BEARING, fails pre-fix): with a turn IN FLIGHT and the background level empty, the drain commit DECLINES — no stdin-EOF lands mid-turn',
    !midEof && stHeld?.state === 'draining',
    { eofEvent: midEof ?? null, brokerState: stHeld?.state ?? 'status-file-gone' });
  // The turn completes: the very next recheck may commit — EOF must land AFTER the result.
  fs.writeFileSync(resultFlag, '1');
  let commit = null;
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    commit = evts().find((e) => e.ev === 'stdin-eof');
    if (commit) break;
    await sleep(250);
  }
  check('S2: once the turn\'s result lands, the commit proceeds — stdin-EOF arrives with the turn CLOSED (no truncation)',
    !!commit && commit.midTurnOpen === false, { eofEvent: commit ?? '(never landed)' });
  let reaped = false;
  const rDeadline = Date.now() + 10_000;
  while (Date.now() < rDeadline) {
    if (!fs.existsSync(b.statusPath)) { reaped = true; break; }
    await sleep(250);
  }
  check('S2: the broker then reaps cleanly (status file gone — the gate added no leak)',
    reaped, { statusFileGone: !fs.existsSync(b.statusPath) });
  stopBrokerFamily(b);

  // BOUNDED: a result-less turn must not wedge the drain forever — the midTurn
  // hold has its own window (knob'd tiny here), after which the EOF + the
  // existing escalation bound the CLI exactly like the 90s reap backstop does.
  const events2 = path.join(WORK, 's2b-events.log');
  const midFlag2 = path.join(WORK, 's2b-mid.flag');
  const c = mkBroker('midturn-bound', {
    FAKE_EMIT_BG: '1', FAKE_EVENTS: events2, FAKE_MID_FLAG: midFlag2,
    CLAUDE_STATION_HOST_DRAIN_MIDTURN_MS: '3000',
  });
  await sleep(1200);
  try { process.kill(c.broker.pid, 'SIGTERM'); } catch { /* gone */ }
  await sleep(1200);
  fs.writeFileSync(midFlag2, '1'); // turn opens, level empties, result NEVER lands
  let boundedEof = false;
  const bDeadline = Date.now() + 15_000; // window(3s) + rechecks + margin
  while (Date.now() < bDeadline) {
    if (fs.existsSync(events2) && fs.readFileSync(events2, 'utf8').includes('stdin-eof')) { boundedEof = true; break; }
    await sleep(300);
  }
  check('S2 (bounded): a turn that never lands its result cannot wedge the drain — the midTurn window expires and the commit proceeds',
    boundedEof, { eofLanded: boundedEof });
  stopBrokerFamily(c);
}

/* -------------------------------------------------------------------------- *
 * SECTION 3 — refusal payload, /api/health and the BUG-045 chip carry the
 * truth, with a REAL session-host broker holding the drain (FAILS pre-fix).
 * -------------------------------------------------------------------------- */
let server1 = null, server2 = null;
let s3broker = null;
function spawnServer(port) {
  const s = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA,
      CLAUDE_STATION_SURVIVE: '0', // the ONLY broker in hostsDir must be ours
      // FEAT-065: with stdin delivery enabled, this suite's held survivor (bg
      // live, foreground idle) would be DELIVERED INTO instead of refused —
      // but THIS suite verifies the refusal truth surface, which still fronts
      // every non-deliverable hold. The operator kill-switch pins that path.
      CLAUDE_STATION_SURVIVOR_DELIVERY: '0',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  s.stderr?.on('data', () => { /* quiet */ });
  return s;
}
async function waitHealth(port, ms = 40_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(250);
  }
  return false;
}
function openWs(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej);
  });
}
const waitEv = async (events, pred, ms = 120_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.find(pred);
    if (hit) return hit;
    await sleep(200);
  }
  return null;
};

async function sectionRefusalSurface() {
  console.log('\n=== SECTION 3: refusal payload + /api/health + BUG-045 chip carry the held-drain truth ===');
  const port1 = await freePort();
  server1 = spawnServer(port1);
  if (!(await waitHealth(port1))) throw new Error('server 1 never became healthy');
  const reg = await (await fetch(`http://127.0.0.1:${port1}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // FEAT-131: direct-isolation lifecycle suite — pin isolation so the
    // container-default for new projects cannot move the session off-host.
    body: JSON.stringify({ hostPath: WORK, name: 'feat064-drain-truth', isolation: 'direct' }),
  })).json();
  const projectId = reg.project?.id;
  if (!projectId) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  await fetch(`http://127.0.0.1:${port1}/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { permissionMode: 'bypassPermissions', model: 'haiku' } }),
  });

  // One REAL seed turn so an on-disk session exists for the resume+UI to target.
  const c0 = await openWs(port1);
  c0.send({ type: 'start', projectId, prompt: 'Reply with exactly: SEED-OK' });
  const init = await waitEv(c0.events, (e) => e.t === 'session-init', 90_000);
  if (!init?.sessionId) throw new Error('seed turn never started');
  const sdkSessionId = init.sessionId;
  await waitEv(c0.events, (e) => e.t === 'turn-end', 90_000);
  c0.send({ type: 'close' });
  try { c0.ws.close(); } catch { /* ignore */ }
  await sleep(500);
  try { process.kill(server1.pid, 'SIGKILL'); } catch { /* ignore */ }
  await sleep(500);

  // A REAL session-host broker in the server's hostsDir, its fake CLI declaring
  // this exact sdkSessionId + one live background task — the true post-restart
  // background-holding-survivor shape.
  const hostsDir = path.join(DATA, 'session-hosts');
  s3broker = mkBroker('survivor', {
    FAKE_SDK_ID: sdkSessionId, FAKE_EMIT_BG: '1', FAKE_TASK_ID: 'bg-feat064-live',
    FAKE_IGNORE_EOF: '1',
  }, { dir: hostsDir, key: `h-f64-${sdkSessionId.slice(0, 8)}` });
  // The broker learns the sdk id from the init frame — wait for it to land.
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    const st = readJson(s3broker.statusPath);
    if (st?.sdkSessionId === sdkSessionId) ready = true; else await sleep(200);
  }
  if (!ready) throw new Error('planted broker never recorded the sdk session id');

  // Boot server 2 on the same dataDir: adoptSurvivingHosts SIGTERMs the broker,
  // whose drain then HOLDS on the live background level — the real drain window.
  const port2 = await freePort();
  server2 = spawnServer(port2);
  if (!(await waitHealth(port2))) throw new Error('server 2 never became healthy');
  // Wait until the broker is actually holding (draining + heartbeating).
  let holding = false;
  for (let i = 0; i < 50 && !holding; i++) {
    const st = readJson(s3broker.statusPath);
    if (st?.state === 'draining') holding = true; else await sleep(300);
  }
  check('S3 PRECONDITION: the re-adopted broker is HOLDING its drain (state draining, CLI alive)',
    holding, { state: readJson(s3broker.statusPath)?.state ?? 'status-file-gone' });

  // ---- 3a: the resume-refusal WS payload names what holds the drain (FAILS pre-fix)
  const c1 = await openWs(port2);
  c1.send({ type: 'start', projectId, prompt: 'FEAT-064 probe message', resumeSessionId: sdkSessionId });
  const err = await waitEv(c1.events, (e) => e.t === 'error', 20_000);
  check('S3a: the refusal is the retryable survivor-drain guard', !!err && err.retryable === true && err.fatal === false,
    { retryable: err?.retryable, message: (err?.message ?? '').slice(0, 120) });
  const d = err?.drain;
  check('S3a (fails pre-fix): the refusal payload carries drain.backgroundLive as a count (1)',
    d?.backgroundLive === 1, { drain: d ?? '(absent)' });
  check('S3a (fails pre-fix): the refusal payload names the background task id',
    Array.isArray(d?.backgroundTaskIds) && d.backgroundTaskIds.includes('bg-feat064-live'),
    { backgroundTaskIds: d?.backgroundTaskIds ?? '(absent)' });
  check('S3a (fails pre-fix): the refusal payload carries drainHeldSince + a numeric heldForMs',
    typeof d?.drainHeldSince === 'string' && Number.isFinite(d?.heldForMs) && d.heldForMs >= 0,
    { drainHeldSince: d?.drainHeldSince ?? '(absent)', heldForMs: d?.heldForMs ?? '(absent)' });
  check('S3a (fails pre-fix): the refusal MESSAGE says the drain is held by background work',
    /held .*by 1 background agent/.test(err?.message ?? ''), { message: err?.message ?? '(none)' });
  try { c1.ws.close(); } catch { /* ignore */ }

  // ---- 3b: /api/health survivor row carries the same fields (FAILS pre-fix)
  const h = await (await fetch(`http://127.0.0.1:${port2}/api/health`)).json();
  const row = (h.sessions ?? []).find((s) => s.sdkSessionId === sdkSessionId && s.adopted === false);
  check('S3b PRECONDITION: /api/health reports the surviving-unadopted broker', !!row, { state: row?.state });
  check('S3b (fails pre-fix): the health broker row carries backgroundLive/backgroundTaskIds/drainHeldSince',
    row?.broker?.backgroundLive === 1
      && Array.isArray(row?.broker?.backgroundTaskIds) && row.broker.backgroundTaskIds.includes('bg-feat064-live')
      && typeof row?.broker?.drainHeldSince === 'string',
    { broker: row?.broker ?? '(absent)' });

  // ---- 3c: the BUG-045 chip renders the truth, via the REAL app.js (FAILS pre-fix)
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const BASE = `http://127.0.0.1:${port2}`;
  const win = new Window({ url: `${BASE}/` });
  const doc = win.document;
  doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
  doc.close();
  const realFetch = globalThis.fetch;
  win.fetch = (input, init2) => realFetch(String(input).startsWith('http') ? input : BASE + input, init2);
  const openSockets = [];
  class TrackedWebSocket extends WebSocket { constructor(...args) { super(...args); openSockets.push(this); } }
  win.WebSocket = TrackedWebSocket;
  win.location.host = `127.0.0.1:${port2}`;
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.WebSocket = win.WebSocket;
  globalThis.location = win.location;
  globalThis.fetch = win.fetch;
  try {
    await import(`${path.join(ROOT, 'public', 'app.js')}?ui=${Date.now()}`);
    const q = (s) => doc.querySelector(s);
    const qa = (s) => [...doc.querySelectorAll(s)];
    const booted = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 20_000) { if (qa('#tree button.proj').length > 0) return true; await sleep(150); }
      return false;
    })();
    if (!booted) throw new Error('app.js never rendered the project tree');
    const rows = () => qa('#tree button.row');
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000 && rows().length === 0) await sleep(150);
    if (!rows().length) throw new Error('no session rows rendered');
    rows()[0].click();
    // Wait for the seed transcript to render (the resume context must be bound
    // before the send, or the click starts a FRESH session instead of a resume).
    const t0b = Date.now();
    while (Date.now() - t0b < 30_000 && qa('#panes .pane .you, #panes .pane .claude').length === 0) await sleep(200);
    await sleep(1200);
    const prompt = q('#prompt');
    prompt.value = 'FEAT-064 chip probe';
    q('#go').click();
    let chip = '';
    const t1 = Date.now();
    let matched = false;
    while (Date.now() - t1 < 15_000) {
      chip = q('#queueBox .q-l')?.textContent ?? '';
      if (/waiting on drain — held \S+ by 1 background agent/.test(chip)) { matched = true; break; }
      await sleep(400);
    }
    check('S3c (fails pre-fix): the BUG-045 chip says WHAT holds the drain — "waiting on drain — held Ns by N background agent(s)"',
      matched, { chip: chip || '(no chip rendered)' });
    check('S3c: the chip still says the retry is automatic ("retries itself")',
      /retries itself/.test(chip), { chip: chip || '(no chip rendered)' });
    try {
      const st2 = win.__station?.state;
      if (st2?.drainWaitTimer) { clearInterval(st2.drainWaitTimer); st2.drainWaitTimer = null; }
      if (st2?.liveTimer) { clearInterval(st2.liveTimer); st2.liveTimer = null; }
    } catch { /* app never got that far */ }
  } finally {
    for (const s of openSockets) { try { s.removeAllListeners?.(); s.close(); } catch { /* closed */ } }
    await sleep(300);
    // Deliberately do NOT restore document/window (module-level timers in
    // app.js dereference them — same posture as verify-resume-refusal.mjs).
    globalThis.fetch = realFetch;
  }
}

async function main() {
  await sectionBrokerTruth();
  await sectionMidTurnGate();
  await sectionRefusalSurface();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  if (s3broker) stopBrokerFamily(s3broker);
  // Kill anything our scratch hostsDir spawned, by pid.
  const hostsDir = path.join(DATA, 'session-hosts');
  try {
    for (const f of fs.readdirSync(hostsDir).filter((n) => n.endsWith('.json') && !n.endsWith('.ctl.json'))) {
      const st = readJson(path.join(hostsDir, f));
      for (const p of [st?.claudePid, st?.hostPid]) if (p && pidAlive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    }
  } catch { /* no hosts dir */ }
  for (const s of [server1, server2]) { if (s?.pid) { try { process.kill(s.pid, 'SIGKILL'); } catch { /* gone */ } } }
  await sleep(500);
  for (const d of [WORK, DATA, ...brokerDirs]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  setTimeout(() => process.exit(process.exitCode ?? 0), 400).unref();
});
