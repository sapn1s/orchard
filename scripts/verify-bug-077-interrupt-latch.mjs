#!/usr/bin/env node
/**
 * BUG-077 — an interrupt raised while a session is IDLE (a stray/duplicate Stop,
 * or the result-then-interrupt race where turn A hits its own `result` a beat
 * before the queued interrupt runs) must NOT latch `#interruptRequested` into
 * the NEXT turn and mislabel it.
 *
 *   node scripts/verify-bug-077-interrupt-latch.mjs
 *
 * THE FIX (agent-bridge.ts): `#interruptRequested` is cleared at turn START (the
 * send()/turn-open path), so a turn's interrupt flag reflects ONLY interrupts
 * raised DURING that turn. Pre-fix it was cleared only at `result`, and set by
 * interrupt() with no busy-guard — so an idle Stop stuck the flag `true` and the
 * next legitimate turn read it, producing three dishonest effects this suite
 * checks: (a) still-running agents settled `killed` + killed outcome records,
 * (b) a `turn-end` emitted `interrupted:true` for a turn nobody interrupted,
 * (c) autonomous mode halted with reason `interrupted`.
 *
 * SCRATCH BRIDGE, no API cost: a real server + the REAL AgentSession bridge
 * driving the schema-validated fake `codex app-server` fixture over a free
 * ephemeral port and a scratch dataDir. Never touches :4317 / systemd / any
 * process it did not spawn; kills only by the pids it started.
 *
 * PART A (interactive, the core bug): a first turn completes; a Stop is sent
 *   while IDLE; then a second turn (agents held running, then a NATURAL
 *   completion via the additive `;COMPLETE` marker) ends. Post-fix that turn
 *   ends interrupted=false, its still-running agents are recorded honestly as
 *   `unknown` (never `killed`). FAILS PRE-FIX (stale true → interrupted=true +
 *   killed records).
 * PART B (the honest case, must not break): a GENUINE mid-turn Stop of a turn
 *   with agents held running still yields turn-end interrupted=true + killed
 *   outcome records. Passes both pre- and post-fix (anti-regression).
 * PART C (autonomous): an idle Stop, then autonomous armed, then a turn — the
 *   auto-continue must fire (turnsDone advances, the halt reason is never
 *   `interrupted`). FAILS PRE-FIX (halts immediately, stopReason=interrupted).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const FAKE = path.join(ROOT, 'scripts', 'fixtures', 'codex-fake-app-server.mjs');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDirs = new Set();
function mkTmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `cs-b77-${tag}-`));
  tmpDirs.add(d);
  return d;
}
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

const servers = new Set();
function startServer(port, dataDir, env = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: dataDir, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => { if (process.env.CS_VERBOSE) process.stderr.write(`  [srv] ${d}`); });
  servers.add(child);
  return child;
}
function stopByPid(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }, 2500).unref();
}
async function waitHealth(port, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(200);
  }
  return false;
}
const getJson = async (port, p) => (await (await fetch(`http://127.0.0.1:${port}${p}`)).json());
async function registerProject(port, workDir, name, settings) {
  const reg = await (await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: workDir, name }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(reg.project.id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings }),
  });
  return reg.project.id;
}

/* --------------------------------------------------------------------- ws */

function openWs(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej);
  });
}
async function waitEv(events, pred, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.find(pred);
    if (hit) return hit;
    await sleep(120);
  }
  return null;
}
/** Wait for the NEXT turn-end appended after `fromIdx`; returns {ev, idx}. */
async function waitTurnEnd(events, fromIdx, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    for (let i = fromIdx; i < events.length; i++) if (events[i]?.t === 'turn-end') return { ev: events[i], idx: i + 1 };
    await sleep(120);
  }
  return { ev: null, idx: events.length };
}

async function startSession(port, projectId, prompt) {
  const c = await openWs(port);
  c.send({ type: 'start', projectId, overrides: { provider: 'openai', model: null, permissionMode: 'bypassPermissions' }, prompt });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start', 30000);
  if (!ack?.stationSessionId) throw new Error(`no start ack: ${JSON.stringify(ack)}`);
  return { c, stationId: ack.stationSessionId };
}

const killedOutcomes = async (port, projectId) =>
  ((await getJson(port, `/api/agent-outcomes?projectId=${encodeURIComponent(projectId)}`)).outcomes ?? []);

/* =========================================================== PART A + C */

async function partAC(port, projectId) {
  console.log('\n===== A — an idle Stop must not mislabel the NEXT turn (interactive) =====');
  const { c, stationId } = await startSession(port, projectId, 'turn one — simple, no agents');
  const end1 = await waitTurnEnd(c.events, 0);
  check('A0 PRECONDITION: turn one completes honestly (interrupted:false)',
    !!end1.ev && end1.ev.interrupted === false, end1.ev ? { interrupted: end1.ev.interrupted } : 'no turn-end');

  // The Stop while IDLE — busy is false; the runtime interrupt is a no-op, but
  // pre-fix the bridge flag latches true and bleeds into the next turn.
  c.send({ type: 'interrupt' });
  await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'interrupt', 8000);
  await sleep(600); // let the idle interrupt settle before the next turn opens

  const before = c.events.length;
  c.send({ type: 'send', prompt: 'HOLD_AGENTS:3;COMPLETE — three workers held running, then a natural completion' });
  const end2 = await waitTurnEnd(c.events, before, 30000);
  check('A1 THE FIX (must-FAIL pre-fix): the next turn ends interrupted:false — the idle Stop did NOT latch into it',
    !!end2.ev && end2.ev.interrupted === false, end2.ev ? { interrupted: end2.ev.interrupted, subtype: end2.ev.subtype } : 'no turn-end');

  // Give the turn-end sweep's outcome writes a beat to land.
  await sleep(1200);
  // NON-VACUITY: the mislabeled turn genuinely spawned agents (the sweep path
  // was live, not an empty turn). The codex runtime settles those agents by the
  // turn's own subtype ('success' → completed), so on a NATURAL completion no
  // death is written — which is exactly the honest result: a turn nobody
  // interrupted records NO `killed` outcomes.
  const agentsSeen = c.events.filter((e, i) => i >= before && e.t === 'agent-started').length;
  check('A2 NON-VACUITY: the mislabeled turn genuinely spawned agents (the turn-end sweep path was live)',
    agentsSeen >= 3, { agentsStarted: agentsSeen });
  const outs = await killedOutcomes(port, projectId);
  const killed = outs.filter((o) => o.kind === 'killed');
  check('A2 THE FIX: no `killed` outcome records were written for the un-interrupted turn',
    killed.length === 0, killed.length ? killed.map((o) => `${o.row}:${o.agentId}`) : 'no killed records');
  try { c.send({ type: 'close' }); } catch { /* ignore */ }
  await sleep(400);
  try { c.ws.close(); } catch { /* ignore */ }

  console.log('\n===== C — autonomous continues past an idle-Stop mislabel =====');
  const { c: c3, stationId: id3 } = await startSession(port, projectId, 'auto turn one — simple');
  const e1 = await waitTurnEnd(c3.events, 0);
  check('C0 PRECONDITION: the first turn of the autonomous session completed', !!e1.ev, e1.ev ? { interrupted: e1.ev.interrupted } : 'no turn-end');

  c3.send({ type: 'interrupt' }); // idle Stop, latches pre-fix
  await waitEv(c3.events, (e) => e.t === 'ack' && e.of === 'interrupt', 8000);
  await sleep(400);

  const armed = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(id3)}/autonomous`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start', maxTurns: 3 }),
  })).json();
  check('C0 PRECONDITION: autonomous armed (maxTurns 3, interactive→autonomous)',
    armed?.ok === true && armed?.autonomous?.autonomous === true, armed?.autonomous);

  const before3 = c3.events.length;
  c3.send({ type: 'send', prompt: 'auto turn two — simple' });
  await waitTurnEnd(c3.events, before3, 30000);

  // Post-fix: interrupted=false at the boundary → #maybeAutoContinue advances a
  // turn (turnsDone >= 1). Pre-fix: interrupted=true → halts at turnsDone 0 with
  // stopReason 'interrupted'. Poll the honest state either way.
  let advanced = false, everInterruptedHalt = false, last = null;
  for (let i = 0; i < 30; i++) {
    last = await getJson(port, `/api/sessions/${encodeURIComponent(id3)}/autonomous`);
    if ((last.turnsDone ?? 0) >= 1) advanced = true;
    if (last.stopReason === 'interrupted') everInterruptedHalt = true;
    if (advanced || everInterruptedHalt) break;
    await sleep(300);
  }
  check('C1 THE FIX: the auto-continue fired at least once (turnsDone advanced past 0)', advanced, last);
  check('C1 THE FIX: autonomous was NEVER halted with reason `interrupted`', !everInterruptedHalt, { stopReason: last?.stopReason });
  try { c3.send({ type: 'close' }); } catch { /* ignore */ }
  await sleep(400);
  try { c3.ws.close(); } catch { /* ignore */ }
}

/* ================================================================= PART B */

async function partB(port, projectId) {
  console.log('\n===== B — a GENUINE mid-turn Stop still yields interrupted + killed (anti-regression) =====');
  const { c } = await startSession(port, projectId, 'HOLD_AGENTS:2 — hold two workers open (no natural completion)');
  // Wait until the two workers are genuinely in flight before the Stop.
  const running = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const snap = c.events.filter((e) => e.t === 'running').pop();
      const rows = (snap?.running ?? []).filter((r) => r.row === 'agent' || r.kind === 'agent');
      if (rows.length >= 2) return rows.length;
      // fall back to agent lifecycle events
      const started = c.events.filter((e) => e.t === 'agent-started' || e.t === 'agent-update').length;
      if (started >= 2) return started;
      await sleep(200);
    }
    return 0;
  })();
  check('B0 PRECONDITION: two workers are genuinely in flight before the Stop', running >= 2, { running });

  const before = c.events.length;
  c.send({ type: 'interrupt' }); // GENUINE mid-turn Stop — a turn IS active
  const end = await waitTurnEnd(c.events, before, 30000);
  check('B1 a genuine mid-turn Stop still ends the turn interrupted:true',
    !!end.ev && end.ev.interrupted === true, end.ev ? { interrupted: end.ev.interrupted } : 'no turn-end');

  await sleep(1200);
  const outs = await killedOutcomes(port, projectId);
  const killed = outs.filter((o) => o.kind === 'killed');
  check('B2 the interrupted agents are recorded honestly as `killed`', killed.length >= 2, outs.map((o) => `${o.row}:${o.agentId}:${o.kind}`));
  try { c.send({ type: 'close' }); } catch { /* ignore */ }
  await sleep(400);
  try { c.ws.close(); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------- main */

try {
  // A/C on their own project+dataDir; B on its own — so each part's outcome
  // ledger is read in isolation (killed-count assertions must not cross-talk).
  const portAC = await freePort();
  const DATA_AC = mkTmp('ac-data');
  const WORK_AC = mkTmp('ac-work');
  const srvAC = startServer(portAC, DATA_AC, { CLAUDE_STATION_CODEX_BIN: FAKE, CLAUDE_STATION_SURVIVE: '0', CODEX_FAKE_HOLD_MS: '500' });
  if (!(await waitHealth(portAC))) throw new Error('scratch server (A/C) never became healthy');
  const projAC = await registerProject(portAC, WORK_AC, 'b77-ac', { provider: 'openai', model: null, permissionMode: 'bypassPermissions' });
  await partAC(portAC, projAC);
  stopByPid(srvAC.pid);

  const portB = await freePort();
  const DATA_B = mkTmp('b-data');
  const WORK_B = mkTmp('b-work');
  const srvB = startServer(portB, DATA_B, { CLAUDE_STATION_CODEX_BIN: FAKE, CLAUDE_STATION_SURVIVE: '0' });
  if (!(await waitHealth(portB))) throw new Error('scratch server (B) never became healthy');
  const projB = await registerProject(portB, WORK_B, 'b77-b', { provider: 'openai', model: null, permissionMode: 'bypassPermissions' });
  await partB(portB, projB);
  stopByPid(srvB.pid);
} catch (err) {
  check('the suite ran to completion', false, String(err?.stack ?? err));
} finally {
  for (const s of servers) stopByPid(s.pid);
  await sleep(600);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) { console.log(`FAILED: ${failures.join(' | ')}`); process.exitCode = 1; }
setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
