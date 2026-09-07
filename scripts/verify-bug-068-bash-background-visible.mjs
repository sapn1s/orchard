#!/usr/bin/env node
/**
 * BUG-068 — BASH BACKGROUND LANES ARE VISIBLE IN THE RUNNING STRIP.
 *
 * THE DEFECT (confirmed from real incident data, 2026-08-11: 27 `local_bash`
 * outcome records, several the "the turn ended while this agent was still
 * running and the engine reported no outcome for it" shape). A `run_in_background`
 * Bash creates a `task_started` lane (`task_type:"local_bash"`, a `tool` row).
 * But the engine's `background_tasks_changed` LEVEL frame LAGS the dispatching
 * turn's `result` (BUG-043, measured ~4s). In that window the turn-end sweep
 * saw the lane `running` and NOT in `#backgroundTasks`, so it SETTLED it as a
 * fabricated `unknown` death and EVICTED its running row — while the real
 * background tree kept working invisibly (`GET /running -> running:[]`). The
 * `#bgDispatchAt` pre-signal guard protected the CLOSE decision (`workLifetime`)
 * but was never wired into the SWEEP.
 *
 * THE FIX UNDER TEST (agent-bridge.ts). The engine's `task_started` for a
 * background lane carries the SAME `tool_use_id` as the `run_in_background`
 * dispatch (probe-verified). The bridge tags such lanes `#bgBornTasks` the
 * moment the task_started arrives, and the turn-end sweep spares them exactly
 * like `#backgroundTasks` — so a background bash is never fabricated-dead in the
 * pre-level window. The tag is superseded by any level frame (REPLACE
 * semantics), and a genuinely-FOREGROUND local_bash (no run_in_background) is
 * still settled at turn end (BUG-030 preserved).
 *
 * ENGINE: a scripted fake `claude` CLI injected via CLAUDE_STATION_CLAUDE_BIN
 * (the same style of verification seam as CLAUDE_STATION_CODEX_BIN). Real
 * server, real bridge, real ClaudeRuntime + SDK — only the model process is
 * scripted, so the exact adversarial frame ordering (task_started BEFORE result,
 * level AFTER) is reproducible with no API cost and no flakiness.
 *
 * §C BAR, in order:
 *   1. PRE-LEVEL VISIBILITY  — after `result`, level still pending: the
 *      local_bash row is present in /running (FAILS pre-fix: evicted).
 *   2. NO FABRICATED DEATH   — no `unknown` local_bash record (FAILS pre-fix).
 *   3. LEVEL ARRIVES         — the row stays present and un-stalled once the
 *      authoritative level lists it.
 *   4. HONEST END            — a terminal frame removes the row from running and
 *      the ledger stays honest (a real `completed` is not a death).
 *   5. FOREGROUND CONTROL    — a local_bash with NO run_in_background is STILL
 *      settled + removed at turn end (the fix did not make bash immortal).
 *
 * SAFETY: free port, scratch dataDir + scratch store + scratch project cwd;
 * every process killed BY PID. :4317 / the real service / scopes not ours are
 * never touched.
 *
 * Usage: node scripts/verify-bug-068-bash-background-visible.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg068-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg068-work-'));
const WORK_FG = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg068-workfg-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg068-store-'));
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
 * The scripted fake `claude`. It answers every control_request with success and,
 * on the first `user` message, emits the ADVERSARIAL ordering: the tool_use,
 * then task_started (echoing the tool_use_id), then the assistant text and
 * `result` — and only LEVEL_DELAY_MS later the background_tasks_changed level.
 * It stays alive (interactive) so /running can be polled while the lane runs; a
 * flag file drives the terminal frame. SCENARIO=fg drops run_in_background so
 * the same lane is a FOREGROUND local_bash (the control).
 */
fs.writeFileSync(FAKE, `
import * as readline from 'node:readline';
import * as fs from 'node:fs';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const SCENARIO = process.env.SCENARIO || 'bg';
const LEVEL_DELAY_MS = Number(process.env.LEVEL_DELAY_MS || 4000);
const TERMINAL_FLAG = process.env.TERMINAL_FLAG || '';
const bg = SCENARIO === 'bg';
const rl = readline.createInterface({ input: process.stdin });
let started = false;
rl.on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') { say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; }
  if (m.type === 'user' && !started) {
    started = true;
    say({ type: 'system', subtype: 'init', session_id: 'fakesdk-' + process.pid, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'sleep 300', ...(bg ? { run_in_background: true } : {}) } },
    ] } });
    say({ type: 'system', subtype: 'task_started', task_id: 'bfake1', tool_use_id: 'tu1', task_type: 'local_bash', description: 'sleep 300' });
    // FOREGROUND settles its tool_result before the turn ends (normal). The
    // BACKGROUND ack LAGS past \`result\` in the incident — so the sweep sees the
    // lane with NO delivered result: pre-fix it fabricates an \`unknown\` death.
    if (!bg) say({ type: 'user', message: { content: [ { type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: 'done' } ] } });
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: 'STARTED' } ] } });
    say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
    if (bg) setTimeout(() => { say({ type: 'user', message: { content: [ { type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: 'started in background' } ] } }); }, 600);
    // The LAGGING authoritative level — only for the background scenario.
    if (bg) setTimeout(() => { say({ type: 'system', subtype: 'background_tasks_changed', tasks: [ { task_id: 'bfake1', task_type: 'local_bash', description: 'sleep 300' } ] }); }, LEVEL_DELAY_MS);
    // The terminal frame, driven by a flag file (bg only — fg is settled by the sweep).
    if (bg && TERMINAL_FLAG) {
      const iv = setInterval(() => { if (fs.existsSync(TERMINAL_FLAG)) { clearInterval(iv);
        say({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
        say({ type: 'system', subtype: 'task_notification', task_id: 'bfake1', status: 'completed', message: 'background task finished' });
      } }, 200); iv.unref?.();
    }
  }
});
process.stdin.resume();
`);

const servers = new Set();
function spawnServer(port, env, onLog) {
  const s = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE,
      CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stdout?.on('data', (d) => onLog?.(String(d))); s.stderr?.on('data', (d) => onLog?.(String(d)));
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
const lbRows = (snap) => (snap?.running ?? []).filter((r) => r.label === 'local_bash');
const unknownLbDeaths = (snap) => (snap?.ended ?? []).filter((o) => o.label === 'local_bash' && o.kind === 'unknown');

async function startSession(port, scenario, env = {}) {
  const c = await openWs(port);
  // Per-session engine env travels through the server process env, so set it on
  // the server; here we only vary the prompt. The scenario is chosen by the
  // server's SCENARIO env (set per server spawn).
  c.send({ type: 'start', projectId: env.projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' },
    prompt: `run a ${scenario} bash task` });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start');
  if (!ack) throw new Error('no start ack');
  return { c, stationId: ack.stationSessionId };
}

async function main() {
  // ---- Server A: the BACKGROUND scenario (adversarial: level lags result). ----
  const portBg = await freePort();
  const flag = path.join(WORK, 'terminal.flag');
  const srvBg = spawnServer(portBg, { SCENARIO: 'bg', LEVEL_DELAY_MS: '4000', TERMINAL_FLAG: flag });
  if (!(await waitHealth(portBg))) throw new Error('bg server never healthy');
  const regBg = await (await fetch(`http://127.0.0.1:${portBg}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: WORK, name: 'bg068-bg', isolation: 'direct' }) })).json(); // FEAT-131: pin direct (container-default off)
  const pidBg = regBg.project?.id; if (!pidBg) throw new Error('register(bg) failed ' + JSON.stringify(regBg));

  const { c, stationId } = await startSession(portBg, 'background', { projectId: pidBg });
  await waitEv(c.events, (e) => e.t === 'agent-started', 30_000);
  const end = await waitEv(c.events, (e) => e.t === 'turn-end', 30_000);
  if (!end) throw new Error('bg turn never ended');

  // (1)+(2): the pre-level window — result has fired, the level has NOT. This is
  // exactly the incident window. Poll quickly, before LEVEL_DELAY_MS elapses.
  let preSnap = await getRunning(portBg, stationId);
  const preRows = lbRows(preSnap);
  check('(1) PRE-LEVEL VISIBILITY: after `result`, with the background_tasks_changed level STILL PENDING, the local_bash row is present in /running (FAILS pre-fix: evicted by the sweep)',
    preRows.length === 1 && preSnap.turn.running === false,
    { turnRunning: preSnap?.turn?.running, localBashRows: preRows.map((r) => `${r.row}:${r.id}:${r.label}:${r.state}`), allRows: preSnap?.running?.map((r) => `${r.row}:${r.id}`) });
  check('(2) NO FABRICATED DEATH: no `unknown` local_bash outcome was recorded for the still-running lane (FAILS pre-fix: the sweep writes one)',
    unknownLbDeaths(preSnap).length === 0,
    { unknownLocalBashDeaths: unknownLbDeaths(preSnap).map((o) => `${o.id}:${o.detail?.slice(0, 40)}`) });

  // (3): the authoritative level arrives — the row stays, now vouched (un-stalled).
  await sleep(5000);
  const lvlSnap = await getRunning(portBg, stationId);
  const lvlRows = lbRows(lvlSnap);
  check('(3) LEVEL ARRIVES: the row is still present and NOT stalled once the engine level lists the lane',
    lvlRows.length === 1 && lvlRows[0].state !== 'stalled',
    { localBashRows: lvlRows.map((r) => `${r.id}:${r.state}`) });

  // (4): a terminal frame ends it — the row leaves running, the ledger is honest.
  fs.writeFileSync(flag, '1');
  let endSnap = null; const t0 = Date.now();
  while (Date.now() - t0 < 15_000) { endSnap = await getRunning(portBg, stationId); if (lbRows(endSnap).length === 0) break; await sleep(300); }
  check('(4) HONEST END: the terminal frame removes the lane from /running, and no fabricated `unknown` death was ever recorded (a real completion is not a death)',
    lbRows(endSnap).length === 0 && unknownLbDeaths(endSnap).length === 0,
    { localBashRows: lbRows(endSnap).map((r) => r.id), unknownDeaths: unknownLbDeaths(endSnap).length });

  try { c.ws.close(); } catch {}

  // ---- Server B: the FOREGROUND control (no run_in_background). ----
  const portFg = await freePort();
  const srvFg = spawnServer(portFg, { SCENARIO: 'fg' });
  if (!(await waitHealth(portFg))) throw new Error('fg server never healthy');
  const regFg = await (await fetch(`http://127.0.0.1:${portFg}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: WORK_FG, name: 'bg068-fg', isolation: 'direct' }) })).json(); // FEAT-131: pin direct (container-default off)
  const pidFg = regFg.project?.id; if (!pidFg) throw new Error('register(fg) failed ' + JSON.stringify(regFg));

  const fg = await startSession(portFg, 'foreground', { projectId: pidFg });
  await waitEv(fg.c.events, (e) => e.t === 'agent-started', 30_000);
  const fgEnd = await waitEv(fg.c.events, (e) => e.t === 'turn-end', 30_000);
  if (!fgEnd) throw new Error('fg turn never ended');
  await sleep(500);
  const fgSnap = await getRunning(portFg, fg.stationId);
  check('(5) FOREGROUND CONTROL: a local_bash with NO run_in_background is STILL settled + removed at turn end (BUG-030 preserved — the fix did not make bash immortal)',
    lbRows(fgSnap).length === 0,
    { localBashRows: lbRows(fgSnap).map((r) => `${r.id}:${r.state}`) });
  try { fg.c.ws.close(); } catch {}
}

main().catch((e) => { console.error('FATAL', e.stack ?? e.message); process.exitCode = 1; }).finally(async () => {
  await sleep(400);
  try { for (const f of fs.readdirSync(path.join(DATA, 'session-hosts'))) { try { const h = JSON.parse(fs.readFileSync(path.join(DATA, 'session-hosts', f), 'utf8')); for (const p of [h.claudePid, h.hostPid]) if (p && pidAlive(p)) try { process.kill(p, 'SIGKILL'); } catch {} } catch {} } } catch {}
  for (const s of servers) { if (s?.pid) { try { process.kill(s.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(s.pid, 'SIGKILL'); } catch {} }, 2000).unref(); } }
  setTimeout(() => {
    console.log(`\n${pass}/${pass + fail} checks passed`);
    if (fail) console.log(`failed: ${failures.join(' | ')}`);
    for (const d of [DATA, WORK, WORK_FG, STORE]) fs.rmSync(d, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
  }, 1500);
});
