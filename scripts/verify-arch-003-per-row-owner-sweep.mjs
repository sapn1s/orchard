#!/usr/bin/env node
/**
 * ARCH-003 — THE TURN-END SWEEP DECIDES A DEATH PER ROW, BY OWNER, NOT BY A
 * GLOBAL "IS ANY BACKGROUND AGENT LIVE" FLAG.
 *
 * PREMISE (overturned, then confirmed on real frames). The ticket claimed a
 * background agent's foreground child bash carried NO parentage on any frame the
 * bridge sees, so the sweep could only guess. FALSE: on real CLI 2.1.220 a
 * background agent's child Bash rides an assistant frame carrying the agent's
 * `parent_tool_use_id` (non-null), emitted BEFORE the child's `task_started`
 * (which echoes the same tool_use id). Captured live for this fix. So the bridge
 * now stamps each lane's OWNER and the sweep asks, PER ROW, whether THAT owner is
 * a live background agent. This kills BOTH failure directions of the old global
 * guard at once — the two scenarios below are the must-FAIL proof of each.
 *
 * ENGINE: a scripted fake `claude` injected via CLAUDE_STATION_CLAUDE_BIN — real
 * server, real bridge, real ClaudeRuntime + SDK, only the model process scripted,
 * so the exact adversarial frame ordering (and the real parent_tool_use_id
 * linkage) is reproducible with no API cost. The frame shapes here match the raw
 * stdout captured from a real dispatch (background agent + foreground child bash).
 *
 * §C BAR — each check names the OLD-code failure it would FAIL against:
 *   OVERSUPPRESS scenario (direction 1 — the WORSE, over-suppression):
 *     a live background worker AGENT, its FOREGROUND child bash (owner = worker),
 *     AND a genuine MAIN-THREAD orphan bash (owner null), all in flight at result.
 *     (1) the main-thread orphan records its honest `unknown` death
 *         — FAILS on the old global guard: any live background agent suppressed
 *           ALL tool rows, so the orphan's real death was SILENTLY SWALLOWED.
 *     (2) the worker's child bash records NO death (spared by owner — same as old,
 *         but now BY NAME, not by a blanket rule).
 *     (3) both tool rows settle; the worker is spared.
 *   REATTACHFAB scenario (direction 2 — fabrication via the re-attach degrade):
 *     a child bash owned by an UNTRACKED background agent (its task_started was
 *     missed and no level frame is present — the resume/re-attach shape), plus a
 *     control MAIN-THREAD orphan.
 *     (4) the untracked-subagent child records NO death
 *         — FAILS on the old global guard: with no background agent visible, the
 *           child looked orphaned and the sweep FABRICATED an `unknown` death for
 *           a step that then succeeds.
 *     (5) the control main-thread orphan STILL records its honest death — proof
 *         the degrade spares by non-null owner, it does not blanket-suppress.
 *
 * SAFETY: free port, scratch dataDir + scratch store + scratch project cwd; every
 * process killed BY PID. :4317 / the real service / scopes not ours are untouched.
 *
 * Usage: node scripts/verify-arch-003-per-row-owner-sweep.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-arch003-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-arch003-store-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-arch003-work-'));
const FAKE = path.join(WORK, 'fake-claude.mjs');

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
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

/*
 * The scripted fake `claude`. Both scenarios reproduce the REAL frame ordering:
 * the owning agent's task_started (or its absence, for re-attach) THEN the child
 * bash's assistant tool_use carrying the owner's parent_tool_use_id THEN the
 * child's own local_bash task_started echoing that tool_use id.
 */
fs.writeFileSync(FAKE, `
import * as readline from 'node:readline';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const SCENARIO = process.env.SCENARIO || 'oversuppress';
const rl = readline.createInterface({ input: process.stdin });
let started = false;
rl.on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') { say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; }
  if (m.type !== 'user' || started) return;
  started = true;
  say({ type: 'system', subtype: 'init', session_id: 'fakesdk-' + process.pid, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });

  if (SCENARIO === 'oversuppress') {
    // Main thread dispatches a BACKGROUND worker agent.
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [
      { type: 'tool_use', id: 'task_tu_W', name: 'Task', input: { subagent_type: 'worker', description: 'bg worker W', run_in_background: true } },
    ] } });
    // The authoritative level lists the worker live (local_agent), then its task_started.
    say({ type: 'system', subtype: 'background_tasks_changed', tasks: [ { task_id: 'workerW', task_type: 'local_agent', description: 'bg worker W' } ] });
    say({ type: 'system', subtype: 'task_started', task_id: 'workerW', tool_use_id: 'task_tu_W', subagent_type: 'worker', description: 'bg worker W' });
    // The worker spawns a FOREGROUND child bash — REAL parentage: an assistant
    // frame with the worker's parent_tool_use_id, THEN the child's local_bash row.
    say({ type: 'assistant', parent_tool_use_id: 'task_tu_W', message: { model: 'claude-haiku-4-5', content: [ { type: 'tool_use', id: 'bash_tu_C', name: 'Bash', input: { command: 'npm run verify:ui' } } ] } });
    say({ type: 'system', subtype: 'task_started', task_id: 'childbashC', tool_use_id: 'bash_tu_C', task_type: 'local_bash', description: 'npm run verify:ui' });
    // A GENUINE MAIN-THREAD orphan bash — main thread issued it (parent_tool_use_id null).
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'tool_use', id: 'fg_tu', name: 'Bash', input: { command: 'sleep 300' } } ] } });
    say({ type: 'system', subtype: 'task_started', task_id: 'orphanbash', tool_use_id: 'fg_tu', task_type: 'local_bash', description: 'sleep 300' });
    // Main turn ends with the worker, its child, and the orphan all in flight.
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: 'DISPATCHED' } ] } });
    say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
    return;
  }

  if (SCENARIO === 'reattachfab') {
    // RE-ATTACH: a background agent's child bash whose assistant frame carries a
    // parent_tool_use_id we NEVER mapped (the agent's task_started was missed and
    // no level frame is present) — the honest degrade case.
    say({ type: 'assistant', parent_tool_use_id: 'ghost_agent_tu', message: { model: 'claude-haiku-4-5', content: [ { type: 'tool_use', id: 'bash_tu_G', name: 'Bash', input: { command: 'npm run typecheck' } } ] } });
    say({ type: 'system', subtype: 'task_started', task_id: 'childbashG', tool_use_id: 'bash_tu_G', task_type: 'local_bash', description: 'npm run typecheck' });
    // A control MAIN-THREAD orphan bash in the same turn.
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'tool_use', id: 'fg_tu2', name: 'Bash', input: { command: 'sleep 300' } } ] } });
    say({ type: 'system', subtype: 'task_started', task_id: 'orphanbash2', tool_use_id: 'fg_tu2', task_type: 'local_bash', description: 'sleep 300' });
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: 'RAN' } ] } });
    say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
    return;
  }
});
process.stdin.resume();
`);

const servers = new Set();
function spawnServer(port, env) {
  const s = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE,
      CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.add(s);
  return s;
}
async function waitHealth(port) { for (let i = 0; i < 160; i++) { try { await fetch(`http://127.0.0.1:${port}/api/health`); return true; } catch { await sleep(250); } } return false; }
function openWs(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch {} });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej); ws.on('error', () => {});
  });
}
const waitEv = async (events, pred, ms = 60_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const h = events.find(pred); if (h) return h; await sleep(120); } return null; };
const getRunning = async (port, id) => (await (await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/running`)).json()).snapshot;
const rowsByLabel = (snap, label) => (snap?.running ?? []).filter((r) => r.label === label);
const rowsById = (snap, id) => (snap?.running ?? []).filter((r) => r.id === id);
const deathsForId = (snap, id) => (snap?.ended ?? []).filter((o) => o.agentId === id && o.kind === 'unknown');

async function startSession(port, projectId, prompt) {
  const c = await openWs(port);
  c.send({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start');
  if (!ack) throw new Error('no start ack');
  return { c, stationId: ack.stationSessionId };
}
async function register(port, cwd, name) {
  const r = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: cwd, name, isolation: 'direct' }) })).json(); // FEAT-131: pin direct (container-default off)
  if (!r.project?.id) throw new Error(`register(${name}) failed ` + JSON.stringify(r));
  return r.project.id;
}

async function main() {
  // ---- OVERSUPPRESS (direction 1). ----
  const portOs = await freePort();
  const WORK_OS = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-arch003-os-'));
  spawnServer(portOs, { SCENARIO: 'oversuppress' });
  if (!(await waitHealth(portOs))) throw new Error('oversuppress server never healthy');
  const pidOs = await register(portOs, WORK_OS, 'arch003-oversuppress');
  const os1 = await startSession(portOs, pidOs, 'dispatch a background worker with a child bash, plus a main-thread orphan bash');
  await waitEv(os1.c.events, (e) => e.t === 'agent-started', 30_000);
  if (!(await waitEv(os1.c.events, (e) => e.t === 'turn-end', 30_000))) throw new Error('oversuppress turn never ended');
  await sleep(700);
  const osSnap = await getRunning(portOs, os1.stationId);
  check('(1) OVER-SUPPRESSION FIXED: a genuine MAIN-THREAD orphan bash records its honest `unknown` death even though a background worker is live (FAILS on the old global guard — any live background agent swallowed the orphan\'s real death)',
    deathsForId(osSnap, 'orphanbash').length === 1,
    { orphanDeaths: deathsForId(osSnap, 'orphanbash').map((o) => `${o.agentId}:${o.detail?.slice(0, 40)}`), allEnded: (osSnap?.ended ?? []).map((o) => `${o.agentId}:${o.kind}`) });
  check('(2) SPARED BY NAME: the live background worker\'s FOREGROUND child bash records NO death (owner = the live worker, not a main-thread orphan)',
    deathsForId(osSnap, 'childbashC').length === 0,
    { childDeaths: deathsForId(osSnap, 'childbashC').map((o) => o.agentId) });
  check('(3) SETTLED + WORKER SPARED: both local_bash rows are removed from /running (BUG-030) and the worker agent is still spared',
    rowsById(osSnap, 'orphanbash').length === 0 && rowsById(osSnap, 'childbashC').length === 0 && rowsByLabel(osSnap, 'worker').length === 1,
    { orphanRunning: rowsById(osSnap, 'orphanbash').length, childRunning: rowsById(osSnap, 'childbashC').length, workerRows: rowsByLabel(osSnap, 'worker').length });
  try { os1.c.ws.close(); } catch {}
  fs.rmSync(WORK_OS, { recursive: true, force: true });

  // ---- REATTACHFAB (direction 2). ----
  const portRf = await freePort();
  const WORK_RF = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-arch003-rf-'));
  spawnServer(portRf, { SCENARIO: 'reattachfab' });
  if (!(await waitHealth(portRf))) throw new Error('reattachfab server never healthy');
  const pidRf = await register(portRf, WORK_RF, 'arch003-reattachfab');
  const rf = await startSession(portRf, pidRf, 're-attach: a child bash of an untracked background agent, plus a control main-thread orphan');
  await waitEv(rf.c.events, (e) => e.t === 'agent-started', 30_000);
  if (!(await waitEv(rf.c.events, (e) => e.t === 'turn-end', 30_000))) throw new Error('reattachfab turn never ended');
  await sleep(700);
  const rfSnap = await getRunning(portRf, rf.stationId);
  check('(4) FABRICATION FIXED (re-attach degrade): a child bash owned by an UNTRACKED background agent (missed task_started, no level frame) records NO death — the non-null owner proves it is a subagent\'s child (FAILS on the old global guard: with no background agent visible it FABRICATED an `unknown` death)',
    deathsForId(rfSnap, 'childbashG').length === 0,
    { childDeaths: deathsForId(rfSnap, 'childbashG').map((o) => `${o.agentId}:${o.detail?.slice(0, 40)}`), allEnded: (rfSnap?.ended ?? []).map((o) => `${o.agentId}:${o.kind}`) });
  check('(5) DEGRADE IS NOT A BLANKET: the control MAIN-THREAD orphan (owner null) STILL records its honest `unknown` death in the same sweep — the degrade spares by non-null owner, it does not suppress everything',
    deathsForId(rfSnap, 'orphanbash2').length === 1,
    { orphanDeaths: deathsForId(rfSnap, 'orphanbash2').map((o) => `${o.agentId}:${o.detail?.slice(0, 40)}`) });
  try { rf.c.ws.close(); } catch {}
  fs.rmSync(WORK_RF, { recursive: true, force: true });
}

let fatal = false;
main().catch((e) => { console.error('FATAL', e.stack ?? e.message); fatal = true; process.exitCode = 1; }).finally(async () => {
  await sleep(400);
  try { for (const f of fs.readdirSync(path.join(DATA, 'session-hosts'))) { try { const h = JSON.parse(fs.readFileSync(path.join(DATA, 'session-hosts', f), 'utf8')); for (const p of [h.claudePid, h.hostPid]) if (p && pidAlive(p)) try { process.kill(p, 'SIGKILL'); } catch {} } catch {} } } catch {}
  for (const s of servers) { if (s?.pid) { try { process.kill(s.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(s.pid, 'SIGKILL'); } catch {} }, 2000).unref(); } }
  setTimeout(() => {
    console.log(`\n${pass}/${pass + fail} checks passed${fatal ? ' (FATAL — the run aborted before completing)' : ''}`);
    if (fail) console.log(`failed: ${failures.join(' | ')}`);
    for (const d of [DATA, WORK, STORE]) fs.rmSync(d, { recursive: true, force: true });
    process.exit((fail || fatal || pass + fail === 0) ? 1 : 0);
  }, 1500);
});
