#!/usr/bin/env node
/**
 * FEAT-126 (round 2) — END-TO-END: a DECLARED request flows from a real
 * `Dispatch:` line + a real `orchard-request` block, through the REAL server
 * frame-observer, into the REAL server-owned store AND onto the REAL running
 * snapshot's lane attribution, and out through the REAL routes into the shared
 * rail-row join.
 *
 * WHAT IS REAL vs SCRIPTED. Real server (src/server/index.ts), real AgentSession
 * bridge, real ClaudeRuntime + SDK, real requests.ts store, real
 * GET /api/sessions/:id/requests and GET /api/sessions/:id/running routes, real
 * public/lib/requests-view.js join (the SAME code the rail renders). ONLY the
 * model process is scripted (a fake `claude` injected via
 * CLAUDE_STATION_CLAUDE_BIN — the standard Orchard verify harness, no API cost),
 * emitting the exact frame shapes a real orchestrator turn emits: a leading
 * `orchard-request` text block, then a `Task` tool_use whose charter carries the
 * `Dispatch:` line, then the lane's `task_started`. This is the closest faithful
 * equivalent to a real session turn short of driving a live model.
 *
 * THE CHAIN PROVEN, end to end, on one live server:
 *   Dispatch line (charter prompt)  ─┐
 *   orchard-request block (turn text)─┤→ bridge #handle('assistant')
 *      → requests.observeAssistantText → requests.json store → /requests route
 *      → Task tool_use → #dispatchDeclByToolUse → task_started stamps LiveAgent
 *      → snapshotOfSession → RunningEntry.ticket/request → /running route
 *   → requests-view.joinRequests(store rows, {board, live snap}) → the rail row,
 *     which reads `running · attributed` for THIS request and `idle` for a sibling.
 *
 * SAFETY: free port, scratch dataDir + scratch store + scratch cwd; every process
 * killed BY PID. :4317 / the real service / scopes not ours are untouched.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f126e2e-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f126e2e-store-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f126e2e-work-'));
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
 * The scripted fake `claude`. On the user's first turn it emits, in order:
 *  1. a MAIN-THREAD assistant text block that is a leading `orchard-request` fence
 *     declaring REQ-1 (title, source uuid, tickets:[FEAT-999]) — the orchestrator
 *     opening the request in its own turn, exactly as RESPONSE_FORMAT.md asks;
 *  2. a MAIN-THREAD `Task` tool_use whose `prompt` (charter) leads with the
 *     `Dispatch:` line binding the lane to FEAT-999 / REQ-1, run_in_background;
 *  3. the authoritative level listing the lane live, then its `task_started`
 *     echoing the Task tool_use_id (which is how attribution is consumed+stamped);
 *  4. a closing text + result. The lane is a BACKGROUND agent, so it is spared at
 *     the turn boundary and stays in /running for the snapshot read.
 * A charter for a SIBLING is deliberately NOT dispatched, so the sibling request
 * REQ-2 has no attributed lane and must read idle in the join.
 */
const CHARTER = [
  'Dispatch: ticket=FEAT-999 phase=fixing round=1 class=fix request=REQ-1',
  '',
  'Do the thing for REQ-1.',
].join('\n');
const REQ_BLOCK = [
  'Opening the request now.',
  '',
  '```orchard-request',
  '{ "id": "REQ-1", "title": "Persistent request-centred status view", "source": "u-src-uuid-1", "tickets": ["FEAT-999"] }',
  '```',
].join('\n');

fs.writeFileSync(FAKE, `
import * as readline from 'node:readline';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
let started = false;
rl.on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') { say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; }
  if (m.type !== 'user' || started) return;
  started = true;
  say({ type: 'system', subtype: 'init', session_id: 'fakesdk-' + process.pid, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });
  // 1. the orchestrator declares REQ-1 in its own turn text.
  say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: ${JSON.stringify(REQ_BLOCK)} } ] } });
  // 2. the Task dispatch — charter carries the Dispatch line binding the lane.
  say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [
    { type: 'tool_use', id: 'task_tu_1', name: 'Task', input: { subagent_type: 'worker', description: 'REQ-1 lane', run_in_background: true, prompt: ${JSON.stringify(CHARTER)} } },
  ] } });
  // 3. authoritative level + task_started echoing the Task tool_use_id.
  say({ type: 'system', subtype: 'background_tasks_changed', tasks: [ { task_id: 'lane1', task_type: 'local_agent', description: 'REQ-1 lane' } ] });
  say({ type: 'system', subtype: 'task_started', task_id: 'lane1', tool_use_id: 'task_tu_1', subagent_type: 'worker', description: 'REQ-1 lane' });
  // 4. close the turn; the background lane is spared and stays in /running.
  say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: 'DISPATCHED' } ] } });
  say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
});
process.stdin.resume();
`);

const servers = new Set();
function spawnServer(port) {
  const s = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE,
      CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0' },
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
const getJson = async (url) => (await fetch(url)).json();

async function register(port, cwd, name) {
  const r = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: cwd, name, isolation: 'direct' }) })).json(); // FEAT-131: pin direct (container-default off)
  if (!r.project?.id) throw new Error(`register failed ` + JSON.stringify(r));
  return r.project.id;
}
async function startSession(port, projectId, prompt) {
  const c = await openWs(port);
  c.send({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start');
  if (!ack) throw new Error('no start ack');
  return { c, stationId: ack.stationSessionId };
}

async function main() {
  const view = await import(path.join(ROOT, 'public', 'lib', 'requests-view.js'));
  const port = await freePort();
  spawnServer(port);
  if (!(await waitHealth(port))) throw new Error('server never healthy');
  const pid = await register(port, WORK, 'feat126-e2e');
  const s = await startSession(port, pid, 'open REQ-1 and dispatch its lane');
  await waitEv(s.c.events, (e) => e.t === 'agent-started', 30_000);
  if (!(await waitEv(s.c.events, (e) => e.t === 'turn-end', 30_000))) throw new Error('turn never ended');
  await sleep(700);
  const id = s.stationId;

  // ── the store, via the REAL route ──
  const reqRes = await getJson(`http://127.0.0.1:${port}/api/sessions/${id}/requests`);
  const stored = reqRes.requests ?? [];
  const rec = stored.find((r) => r.id === 'REQ-1');
  check('the orchard-request block reached the server-owned store via the real observer + route',
    !!rec && rec.title === 'Persistent request-centred status view' && rec.source === 'u-src-uuid-1'
      && Array.isArray(rec.tickets) && rec.tickets.includes('FEAT-999'),
    rec ? { id: rec.id, title: rec.title, source: rec.source, tickets: rec.tickets } : { stored });
  check('the store record holds NO cached status (the anti-staleness keystone survives the real path)',
    !!rec && ['status', 'exec', 'completion', 'running', 'done', 'state'].every((k) => !(k in rec)),
    rec ? Object.keys(rec) : 'no record');

  // ── the running snapshot's lane attribution, via the REAL route ──
  const runRes = await getJson(`http://127.0.0.1:${port}/api/sessions/${id}/running`);
  const snap = runRes.snapshot;
  const lane = (snap?.running ?? []).find((r) => r.id === 'lane1');
  check('the live lane carries its DECLARED attribution from the charter Dispatch line (request + ticket stamped onto RunningEntry)',
    !!lane && lane.request === 'REQ-1' && Array.isArray(lane.ticket) && lane.ticket.includes('FEAT-999'),
    lane ? { id: lane.id, request: lane.request, ticket: lane.ticket } : { running: (snap?.running ?? []).map((r) => r.id) });

  // ── the rail row: the SHARED join fed the REAL store rows + REAL snapshot ──
  // A synthetic board (the join reads a board object; the board endpoint is a
  // separate concern) with FEAT-999 in-flight and a sibling REQ-2/BUG-777 queued.
  const board = {
    hasBoard: true,
    inflight: [{ id: 'FEAT-999', title: 'FEAT-999', owner: '🤖', status: 'IN-PROGRESS' }],
    queued: [{ id: 'BUG-777', title: 'BUG-777', owner: '—', status: 'OPEN' }],
    doneToday: [], needsYou: [],
  };
  const bindings = [...stored, { id: 'REQ-2', title: 'Sibling', source: null, tickets: ['BUG-777'] }];
  const rows = view.joinRequests(bindings, { board, snap });
  const row1 = rows.find((r) => r.id === 'REQ-1');
  const row2 = rows.find((r) => r.id === 'REQ-2');
  check('the rail row for REQ-1 reads RUNNING via true per-lane attribution (not a session-wide guess)',
    !!row1 && row1.exec.state === 'running' && row1.exec.attributed === true && row1.exec.count === 1,
    row1 ? row1.exec : 'no row');
  check('the SIBLING REQ-2 (no attributed lane, its ticket not owned/live) reads IDLE though the session is live',
    !!row2 && row2.exec.state === 'idle',
    row2 ? row2.exec : 'no row');
  check('EXECUTION ≠ COMPLETION on the real row: REQ-1 is running AND still not done (open ticket)',
    !!row1 && row1.exec.state === 'running' && row1.completion.kind !== 'done',
    row1 ? { exec: row1.exec.state, completion: row1.completion.kind } : 'no row');
  check('the row carries the source deep-link anchor the orchestrator declared',
    !!row1 && row1.source === 'u-src-uuid-1', row1?.source);

  try { s.c.ws.close(); } catch {}
}

let fatal = false;
main().catch((e) => { console.error('FATAL', e.stack ?? e.message); fatal = true; process.exitCode = 1; }).finally(async () => {
  await sleep(400);
  try { for (const f of fs.readdirSync(path.join(DATA, 'session-hosts'))) { try { const h = JSON.parse(fs.readFileSync(path.join(DATA, 'session-hosts', f), 'utf8')); for (const p of [h.claudePid, h.hostPid]) if (p && pidAlive(p)) try { process.kill(p, 'SIGKILL'); } catch {} } catch {} } } catch {}
  for (const sv of servers) { if (sv?.pid) { try { process.kill(sv.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(sv.pid, 'SIGKILL'); } catch {} }, 2000).unref(); } }
  setTimeout(() => {
    console.log(`\n${pass}/${pass + fail} checks passed${fatal ? ' (FATAL — the run aborted before completing)' : ''}`);
    if (fail) console.log(`failed: ${failures.join(' | ')}`);
    for (const d of [DATA, WORK, STORE]) fs.rmSync(d, { recursive: true, force: true });
    process.exit((fail || fatal || pass + fail === 0) ? 1 : 0);
  }, 1500);
});
