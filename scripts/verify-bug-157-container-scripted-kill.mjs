#!/usr/bin/env node
/**
 * BUG-157 — CONTAINER SESSIONS KILL LIVE WORK. The faithful, container-specific
 * data-loss repro the direct-survival suite cannot be: a `direct` session's broker
 * (BUG-044) holds stdin-EOF while background work is live, so closing the SERVER
 * side does not truncate the work — which is exactly why this bug is CONTAINER-
 * specific. A container session has NO broker: `close()` EOFs stdin straight into
 * `docker exec -i` and a 15s `reapExec` hard-kills the exec, so a close fired
 * mid-turn destroys the live work.
 *
 * SCENARIOS (real docker container, a scripted fake `claude` docker-cp'd over the
 * container's CLI path — real server, real AgentSession, real container exec):
 *   woken     — turn 1 dispatches a background agent and ends (socket drop DETACHES,
 *               not closes). Then, with NO user message, a task-notification-woken
 *               surfacing turn runs a live heartbeat on an EMPTY background level.
 *               FIX: busy is pinned + the container quiet-gate declines → the turn
 *               RUNS TO COMPLETION (heartbeat reaches DONE inside the container).
 *               PRE-FIX: busy=false, the fuse fires ~3s in, close() EOFs the exec,
 *               the heartbeat is TRUNCATED (no DONE) — live work destroyed.
 *   finished  — NON-VACUITY: a genuinely finished detached container session (turn
 *               done, empty level, nothing unsettled) STILL closes+reaps. Proves the
 *               quiet-gate did not disable the fuse.
 *
 * SAFETY: free port, scratch dataDir/store/cwd; a THROWAWAY container project whose
 * name is derived from a fresh random project id (never the user's real containers);
 * torn down in finally. :4317 / the real service / the user's containers untouched.
 * Requires docker.
 *
 * Usage: node scripts/verify-bug-157-container-close-live-work.mjs
 */
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b157c-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b157c-store-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b157c-work-'));
const CONTAINER_CLAUDE_BIN = '/home/claude/.local/bin/claude';
const HB = '/tmp/cs157_hb.txt';
const FLAG = '/tmp/cs157_flag';
const WORK_MS = 18_000;

let pass = 0, fail = 0; const failures = [];
const check = (name, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof obs === 'string' ? obs : JSON.stringify(obs)}`); ok ? pass++ : (fail++, failures.push(name)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const net = await import('node:net'); return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const api = async (p, method = 'GET', body) => { const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const events = (ws) => { const a = []; ws.on('message', (m) => { try { a.push(JSON.parse(String(m))); } catch {} }); return a; };
const waitEv = async (a, pred, ms = 240000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const h = a.find(pred); if (h) return h; await sleep(150); } return null; };

/* The scripted fake `claude`, run INSIDE the container. NODE is the container's
 * node path (resolved at runtime). Paths + timing are baked in per scenario. */
function fakeSource(scenario) {
  return `import * as readline from 'node:readline';
import * as ffs from 'node:fs';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const HB = ${JSON.stringify(HB)}, FLAG = ${JSON.stringify(FLAG)}, WORK_MS = ${WORK_MS};
const rl = readline.createInterface({ input: process.stdin });
// close() EOFs our stdin — exit at once so a mid-heartbeat close TRUNCATES it.
rl.on('close', () => process.exit(0));
const A = (parent, id, name, input) => say({ type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { model: 'claude-haiku-4-5', content: [ { type: 'tool_use', id, name, input: input || {} } ] } });
const TEXT = (parent, t) => say({ type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: t } ] } });
const TS = (task, tu, extra) => say({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: tu, ...extra });
const TU = (task, status) => say({ type: 'system', subtype: 'task_updated', task_id: task, patch: { status } });
const BG = (tasks) => say({ type: 'system', subtype: 'background_tasks_changed', tasks });
const INIT = () => say({ type: 'system', subtype: 'init', session_id: 'fakesdk-${scenario}', cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });
const RESULT = () => say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function heartbeat(ms) { const end = Date.now() + ms; while (Date.now() < end) { try { ffs.appendFileSync(HB, Date.now() + '\\n'); } catch {} await sleep(500); } }
async function waitFlag() { while (!ffs.existsSync(FLAG)) await sleep(150); }
let started = false;
rl.on('line', (l) => { let m; try { m = JSON.parse(l); } catch { return; } if (m.type === 'control_request') { say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; } if (m.type !== 'user' || started) return; started = true; driveOne(); });
async function driveOne() {
  INIT();
  A(null, 'tu_BG', 'Task', { subagent_type: 'worker', description: 'bg root', run_in_background: true });
  TS('bgTask', 'tu_BG', { subagent_type: 'worker', description: 'bg root' });
  BG([{ task_id: 'bgTask', task_type: 'local_agent', description: 'bg root' }]);
  TEXT(null, 'TURN ONE done');
  RESULT();
  await phaseTwo();
}
async function phaseTwo() {
  await waitFlag();
  ${scenario === 'woken' ? `
  INIT();
  TEXT(null, 'WOKEN surfacing turn');
  BG([]);
  await heartbeat(WORK_MS);
  RESULT();
  try { ffs.appendFileSync(HB, 'DONE\\n'); } catch {}
  ` : `
  TU('bgTask', 'completed');
  BG([]);
  `}
}
`;
}

const server = spawn(process.execPath, [ENTRY], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (d) => { if (process.env.VERIFY_B157C_DEBUG) process.stderr.write(`  [srv] ${d}`); });
server.stderr.on('data', (d) => { if (process.env.VERIFY_B157C_DEBUG) process.stderr.write(`  [srv!] ${d}`); });

let cname = null, pid = null;
const dexec = (args, opts = {}) => execFileSync('docker', ['exec', cname, ...args], { encoding: 'utf8', stdio: opts.stdio ?? 'pipe' });

let NODE_IN_CONTAINER = null;
async function installFake(scenario) {
  if (!NODE_IN_CONTAINER) {
    try { NODE_IN_CONTAINER = execFileSync('docker', ['exec', cname, 'node', '-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' }).trim(); }
    catch { NODE_IN_CONTAINER = '/usr/bin/node'; }
  }
  // The JS body lives at a fixed path; the CLI path becomes a tiny wrapper that
  // execs the container's node on it (no shebang/PATH fragility).
  const jsLocal = path.join(WORK, `fake-${scenario}.mjs`);
  const wrapLocal = path.join(WORK, `wrap-${scenario}`);
  fs.writeFileSync(jsLocal, fakeSource(scenario));
  fs.writeFileSync(wrapLocal, `#!/bin/sh\nexec ${NODE_IN_CONTAINER} /tmp/cs157_fake.mjs "$@"\n`);
  fs.chmodSync(wrapLocal, 0o755);
  execFileSync('docker', ['cp', jsLocal, `${cname}:/tmp/cs157_fake.mjs`], { stdio: 'pipe' });
  execFileSync('docker', ['cp', wrapLocal, `${cname}:${CONTAINER_CLAUDE_BIN}`], { stdio: 'pipe' });
  execFileSync('docker', ['exec', cname, 'chmod', '+x', CONTAINER_CLAUDE_BIN], { stdio: 'pipe' });
  try { dexec(['sh', '-c', `rm -f ${HB} ${FLAG}`]); } catch {}
}

const sessionsOpen = async () => { try { return (await api('/api/sessions')).body.sessions ?? []; } catch { return []; } };
const hbText = () => { try { return dexec(['sh', '-c', `cat ${HB} 2>/dev/null || true`]); } catch { return ''; } };

async function runScenario(scenario, { holdMs }) {
  await installFake(scenario);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const ev = events(ws);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.send(JSON.stringify({ type: 'start', projectId: pid, prompt: 'go', overrides: { permissionMode: 'bypassPermissions' } }));
  const init = await waitEv(ev, (e) => e.t === 'session-init', 120000);
  if (!init) throw new Error(`${scenario}: session never initialised — ${JSON.stringify(ev.slice(-6))}`);
  const end1 = await waitEv(ev, (e) => e.t === 'turn-end', 60000);
  if (!end1) throw new Error(`${scenario}: turn one never ended`);
  await sleep(800);

  // DETACH — drop the socket. workLifetime 'yes' (bgTask on level) → detach.
  try { ws.close(); } catch {}
  await sleep(1500);
  const openAfterDetach = (await sessionsOpen()).length > 0;

  // Fire phase 2 (the woken turn / finish).
  dexec(['sh', '-c', `echo 1 > ${FLAG}`]);

  const deadline = Date.now() + holdMs;
  let openDuringWork = true, sawClosed = false;
  while (Date.now() < deadline) {
    const open = (await sessionsOpen()).length > 0;
    if (!open && !sawClosed) { sawClosed = true; openDuringWork = false; }
    if (hbText().includes('DONE')) break;
    await sleep(500);
  }
  const done = hbText().includes('DONE');
  const beats = hbText().split('\n').filter(Boolean).length;

  // Give a genuinely-finished session time to close.
  let closedEventually = (await sessionsOpen()).length === 0;
  const cd = Date.now() + 60000;
  while (!closedEventually && Date.now() < cd) { closedEventually = (await sessionsOpen()).length === 0; await sleep(1000); }

  return { scenario, openAfterDetach, openDuringWork, done, beats, closedEventually };
}

try {
  if (spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0) { console.error('FATAL: docker required'); process.exitCode = 1; }
  else {
    for (let i = 0; i < 120; i++) { try { await fetch(`${BASE}/api/health`); break; } catch { await sleep(250); } }
    fs.writeFileSync(path.join(WORK, 'README.md'), 'b157c\n');
    const created = await api('/api/projects', 'POST', { hostPath: WORK, name: 'B157C', isolation: 'container' });
    if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(created.body)}`);
    pid = created.body.project.id;
    cname = `claude-station-${pid}`;
    console.log(`project=${pid} container=${cname}`);
    // The container is created on demand — start it explicitly (image build on a
    // cold cache can take a while), then wait for it to be running.
    const cstart = await api(`/api/projects/${pid}/container/start`, 'POST');
    console.log(`container/start -> HTTP ${cstart.status} state=${cstart.body?.state ?? '?'}`);
    let running = false;
    for (let i = 0; i < 240; i++) { try { if (execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', cname], { encoding: 'utf8' }).trim() === 'true') { running = true; break; } } catch {} await sleep(500); }
    if (!running) throw new Error(`container ${cname} never reached running state`);

    console.log('\n=== SCENARIO woken: task-notification-woken turn on a detached CONTAINER session ===');
    const woken = await runScenario('woken', { holdMs: WORK_MS + 25000 });
    check('[woken] PRECONDITION: the container session DETACHED on the socket drop (bg work outlived the turn)', woken.openAfterDetach, woken);
    check('[woken] FIX A/B: the session stayed OPEN through the woken turn (busy pinned + quiet-gate declined)', woken.openDuringWork, woken);
    check('[woken] LOAD-BEARING (THE KILL): the woken turn RAN TO COMPLETION — heartbeat reached DONE inside the container, not truncated by close()', woken.done, { done: woken.done, beats: woken.beats, closedDuringWork: !woken.openDuringWork });
    check('[woken] NO LEAK: once the woken turn finished the container session closed', woken.closedEventually, woken);

    console.log('\n=== SCENARIO finished: NON-VACUITY — a genuinely finished detached container session STILL closes ===');
    const fin = await runScenario('finished', { holdMs: 75000 });
    check('[finished] PRECONDITION: the session detached on the socket drop', fin.openAfterDetach, fin);
    check('[finished] the quiet-gate did NOT disable the fuse: a finished container session (empty level, nothing unsettled) still closed', fin.closedEventually, fin);

    console.log(`\n${pass}/${pass + fail} checks passed`);
    if (fail) console.log(`failed: ${failures.join(' | ')}`);
    process.exitCode = fail ? 1 : 0;
  }
} catch (err) {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
} finally {
  try { if (pid) await api(`/api/projects/${pid}`, 'DELETE'); } catch {}
  try { if (cname) execFileSync('docker', ['rm', '-f', cname], { stdio: 'ignore' }); } catch {}
  try { process.kill(server.pid, 'SIGTERM'); } catch {}
  await sleep(1500);
  try { process.kill(server.pid, 'SIGKILL'); } catch {}
  for (const d of [DATA, STORE, WORK]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  setTimeout(() => process.exit(process.exitCode ?? 0), 1000);
}
