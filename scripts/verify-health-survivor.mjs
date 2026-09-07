/**
 * BUG-027 — after a server restart, /api/health (and doctor) must SURFACE a
 * survived-but-unattached FEAT-015 session, never report `sessions: []` while
 * a scoped survivor (broker + CLI) is alive on disk.
 *
 *   node scripts/verify-health-survivor.mjs
 *
 * Deploy-shaped, non-vacuous repro on a SCRATCH server — never touches :4317
 * or the real claude-station unit; kills only by pid / its own transient unit.
 *
 * Mechanism (same faithful shape as verify-restart-survives.mjs):
 *  1. A scratch server runs as its own transient `--user` service
 *     (KillMode=control-group). A real driven haiku session starts a slow turn
 *     (Bash sleep, then a marker Write) with survival ON — the CLI lands under
 *     a broker in its own scope.
 *  2. "Restart": `systemctl --user stop <unit>` (a genuine control-group kill)
 *     then a FRESH server process on a new free port with the same dataDir.
 *     Boot re-adopt SIGTERMs the broker, but the in-flight turn keeps draining
 *     for many seconds — the exact window observed live in BUG-027, where the
 *     old /api/health said `sessions: []` and doctor said "No live sessions"
 *     while broker + CLI were provably alive.
 *  3. THE CHECKS (fail on pre-fix code): while the broker is still alive,
 *     the fresh server's /api/health must list the survivor — an entry with
 *     `adopted: false`, `state: 'surviving-unadopted'`, honest broker pids and
 *     `survivalScoped: true` — and `station-doctor.mjs` must NAME it instead
 *     of printing "No live sessions".
 *  4. HONESty the other way: once the survivor fully drains + is reaped, it
 *     must DISAPPEAR from /api/health (no ghost entries).
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DOCTOR = path.join(ROOT, 'scripts', 'station-doctor.mjs');
const RUN_TAG = `${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hsurv-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hsurv-work-'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/* ---------------------------------------------- transient service (server 1) */

function systemdRunAvailable() {
  try {
    const r = spawnSync('systemd-run', ['--version'], { encoding: 'utf8', timeout: 4000 });
    return r.status === 0 && !!process.env.XDG_RUNTIME_DIR;
  } catch { return false; }
}

function setenvArgs(overrides) {
  const merged = { ...process.env, ...overrides };
  const args = [];
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null) continue;
    const s = String(v);
    if (s.includes('\n') || s.includes('\0')) continue;
    args.push(`--setenv=${k}=${s}`);
  }
  return args;
}

const services = new Set();
function startServerService(unit, port) {
  services.add(unit);
  const args = [
    '--user', `--unit=${unit}`, '--quiet', '--collect',
    `--working-directory=${ROOT}`,
    ...setenvArgs({ PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA }),
    process.execPath, ENTRY,
  ];
  const r = spawnSync('systemd-run', args, { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) throw new Error(`systemd-run for ${unit} failed: ${r.stderr || r.stdout}`);
}
function stopService(unit) {
  spawnSync('systemctl', ['--user', 'stop', unit], { encoding: 'utf8', timeout: 20000 });
  spawnSync('systemctl', ['--user', 'reset-failed', unit], { encoding: 'utf8', timeout: 8000 });
  services.delete(unit);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/* -------------------------------------------------------------- host status */

function readHosts() {
  const dir = path.join(DATA, 'session-hosts');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.endsWith('.ctl.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { const o = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); if (o && Number.isInteger(o.hostPid)) out.push(o); } catch { /* mid-write */ }
  }
  return out;
}
async function waitHost(ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const h = readHosts()[0]; if (h?.claudePid) return h; await sleep(200); }
  return readHosts()[0] ?? null;
}

/* ------------------------------------------------------------------- ws/api */

function openWs(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej);
  });
}
const waitEv = async (events, pred, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.find(pred);
    if (hit) return hit;
    await sleep(150);
  }
  return null;
};

async function waitHealth(port, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(250);
  }
  return false;
}
async function healthGone(port, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await fetch(`http://127.0.0.1:${port}/api/health`); } catch { return true; }
    await sleep(200);
  }
  return false;
}
async function getHealth(port) {
  const r = await fetch(`http://127.0.0.1:${port}/api/health`);
  if (!r.ok) throw new Error(`health HTTP ${r.status}`);
  return r.json();
}

async function registerProject(port) {
  const reg = await (await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // FEAT-131: direct-isolation survival suite — pin isolation so the
    // container-default for new projects cannot move the session off-host.
    body: JSON.stringify({ hostPath: WORK, name: 'health-survivor-fixture', isolation: 'direct' }),
  })).json();
  if (reg.project?.id) return reg.project.id;
  throw new Error(`register failed: ${JSON.stringify(reg)}`);
}

let server2 = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
}

async function main() {
  if (!systemdRunAvailable()) {
    console.error('FATAL: this harness requires `systemd-run --user` (production\'s survival mechanism). Not available here.');
    process.exitCode = 1;
    return;
  }

  console.log('\n===== BUG-027 — post-restart /api/health must surface the un-adopted survivor =====');
  const unit = `cs-hsurv-${RUN_TAG}.service`;
  const port = await freePort();
  startServerService(unit, port);
  if (!(await waitHealth(port))) throw new Error('scratch service never became healthy');
  const projectId = await registerProject(port);
  const marker = path.join(WORK, 'survived.txt');

  // A slow real turn: the long sleep is the drain window we inspect health in.
  const c = await openWs(port);
  c.send({
    type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' },
    prompt:
      `Do exactly these steps in order and nothing else. ` +
      // NOT a bare `sleep 30`: on some dev machines an agent-harness hook blocks
      // standalone long sleeps ("Blocked: standalone sleep 30"), which makes the
      // model refuse the steps and ends the turn in seconds — vacuously closing
      // the drain window this test needs open. A python sleep is equivalent and
      // not intercepted.
      `Step 1: use the Bash tool to run the command: python3 -c 'import time; time.sleep(30)' . ` +
      `Step 2: after it finishes, use the Write tool to create the file ${marker} with its content being exactly the single word: SURVIVED . ` +
      `Step 3: then reply with exactly: TURN-DONE`,
  });
  const init = await waitEv(c.events, (e) => e.t === 'session-init', 90000);
  if (!init) throw new Error('session never initialised');
  const sdkSessionId = init.sessionId;
  const bash = await waitEv(c.events, (e) => e.t === 'tool-call' && e.name === 'Bash', 45000);
  check('PRECONDITION: the turn is genuinely in-flight (Bash sleep tool-call seen)', !!bash,
    bash ? { name: bash.name } : 'no Bash tool-call');
  const host = await waitHost();
  check('PRECONDITION: a survival broker exists for the driven session', !!host?.hostPid && !!host?.claudePid,
    host ? { hostPid: host.hostPid, claudePid: host.claudePid, state: host.state } : 'no broker status file');
  try { c.ws.close(); } catch { /* ignore */ }

  // THE RESTART: control-group kill of the service, then a fresh server on a
  // new free port over the same dataDir (what systemctl restart does, spread
  // into its two halves so each is assertable).
  stopService(unit);
  check('the old server is down after the control-group stop', await healthGone(port), `port ${port}`);
  await sleep(1000);
  check('PRECONDITION (the BUG-027 scene): broker + CLI are STILL ALIVE after the restart',
    pidAlive(host.hostPid) && pidAlive(host.claudePid),
    { hostPid: host.hostPid, hostAlive: pidAlive(host.hostPid), claudePid: host.claudePid, claudeAlive: pidAlive(host.claudePid) });

  const port2 = await freePort();
  server2 = spawn(process.execPath, [ENTRY], {
    cwd: ROOT, env: { ...process.env, PORT: String(port2), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server2.stderr?.on('data', (d) => process.stderr.write(`  [server2!] ${d}`));
  if (!(await waitHealth(port2))) throw new Error('restarted server never became healthy');

  // THE FIX (fails pre-fix with sessions:[]): while the survivor is alive,
  // health must list it with honest adopted/broker fields.
  let snapshot = null;
  let sawAliveWindow = false;
  for (let i = 0; i < 100; i++) {
    if (!pidAlive(host.hostPid)) break;
    sawAliveWindow = true;
    const h = await getHealth(port2);
    snapshot = h;
    const entry = (h.sessions ?? []).find((s) => s.broker && s.broker.hostPid === host.hostPid);
    if (entry) break;
    await sleep(300);
  }
  // Optional debug capture (HSURV_DEBUG=1): snapshot the broker's status file +
  // stderr log across the drain so a truncated-drain can be diagnosed after the
  // broker deletes its own files on exit.
  let debugStop = null;
  if (process.env.HSURV_DEBUG) {
    const dir = path.join(DATA, 'session-hosts');
    const dump = `/tmp/hsurv-debug-${RUN_TAG}`;
    fs.mkdirSync(dump, { recursive: true });
    const t = setInterval(() => {
      try {
        for (const n of fs.readdirSync(dir)) {
          fs.copyFileSync(path.join(dir, n), path.join(dump, n));
        }
      } catch { /* dir may be empty/gone */ }
    }, 500);
    debugStop = () => { clearInterval(t); console.log(`  [debug] broker files snapshotted to ${dump}`); };
  }
  if (!sawAliveWindow) throw new Error('drain window closed before health could be inspected — lengthen the sleep');
  const sessions = snapshot?.sessions ?? [];
  const survivor = sessions.find((s) => s.broker && s.broker.hostPid === host.hostPid) ?? null;
  check('THE FIX: post-restart /api/health is NOT `sessions: []` while the survivor is alive', sessions.length > 0,
    { sessions: sessions.length });
  check('THE FIX: the survivor is listed with an explicit adopted:false + surviving state', !!survivor && survivor.adopted === false && survivor.state === 'surviving-unadopted',
    survivor ? { adopted: survivor.adopted, state: survivor.state } : 'no entry matching the broker pid');
  check('THE FIX: the survivor entry carries honest broker pids + state', !!survivor?.broker
    && survivor.broker.hostPid === host.hostPid && survivor.broker.claudePid === host.claudePid && !!survivor.broker.state,
    survivor?.broker ?? 'no broker field');
  check('THE FIX: survivalScoped is GROUND-TRUTH true (broker verified outside the server cgroup)', survivor?.survivalScoped === true,
    { survivalScoped: survivor?.survivalScoped });
  check('THE FIX: the survivor names its sdk session (so a user can connect it to their thread)',
    !!survivor && (survivor.sdkSessionId === sdkSessionId || survivor.sdkSessionId === host.sdkSessionId),
    { got: survivor?.sdkSessionId, expected: sdkSessionId });

  // Doctor must NAME the survivor, not say "No live sessions".
  const doc = spawnSync(process.execPath, [DOCTOR, '--port', String(port2)], { encoding: 'utf8', timeout: 20000 });
  const out = `${doc.stdout}\n${doc.stderr}`;
  const brokerStillAlive = pidAlive(host.hostPid);
  if (brokerStillAlive) {
    check('THE FIX: doctor does NOT print "No live sessions" while the survivor is alive', !/No live sessions/.test(out),
      out.split('\n').slice(0, 4).join(' | '));
    check('THE FIX: doctor NAMES the survivor (broker pid + survived label)',
      out.includes(String(host.hostPid)) && /SURVIVED a restart/.test(out) && /adopted\s+no/.test(out),
      out.split('\n').filter((l) => /survivor|SURVIVED|hostPid|adopted/.test(l)).join(' | ') || out.slice(0, 300));
  } else {
    check('THE FIX: doctor ran within the drain window', false, 'broker drained before doctor could run — lengthen the sleep');
  }

  // The other honesty direction: once drained + reaped, the survivor must
  // DISAPPEAR (no ghost entries), and its turn must have completed (marker).
  let reaped = false;
  for (let i = 0; i < 120 && !reaped; i++) { reaped = !pidAlive(host.hostPid); if (!reaped) await sleep(1000); }
  if (debugStop) debugStop();
  if (process.env.HSURV_DEBUG) {
    console.log(`  [debug] broker death observed at ${new Date().toISOString()} (reaped=${reaped})`);
    try {
      const store = path.join(os.homedir(), '.claude', 'projects', WORK.replace(/[^a-zA-Z0-9]/g, '-'));
      const tf = path.join(store, `${sdkSessionId}.jsonl`);
      const lines = fs.readFileSync(tf, 'utf8').split('\n').filter((l) => l.trim());
      console.log(`  [debug] transcript ${tf}: ${lines.length} lines`);
      for (const l of lines.slice(-4)) {
        const m = JSON.parse(l);
        console.log(`  [debug]   type=${m.type} ts=${m.timestamp ?? '-'} ${JSON.stringify(l).slice(0, 220)}`);
      }
      fs.copyFileSync(tf, `/tmp/hsurv-debug-${RUN_TAG}-transcript.jsonl`);
      console.log(`  [debug] transcript copied to /tmp/hsurv-debug-${RUN_TAG}-transcript.jsonl`);
    } catch (e) { console.log(`  [debug] transcript read failed: ${e.message}`); }
  }
  check('re-adopt still works: the restarted server drained + reaped the surviving broker', reaped,
    { hostPid: host.hostPid, stillAlive: pidAlive(host.hostPid) });
  const markerOk = fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').includes('SURVIVED');
  check('no lost work: the in-flight turn completed across the restart (marker written)', markerOk, { markerOk });
  await sleep(1000);
  const after = await getHealth(port2);
  const ghost = (after.sessions ?? []).find((s) => s.broker && s.broker.hostPid === host.hostPid);
  check('no ghosts: the reaped survivor is GONE from /api/health', !ghost, { sessions: (after.sessions ?? []).length });

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  stopByPid(server2);
  for (const unit of [...services]) stopService(unit);
  for (const h of readHosts()) { if (h?.hostPid && pidAlive(h.hostPid)) { try { process.kill(h.hostPid, 'SIGKILL'); } catch { /* gone */ } } }
  const store = path.join(os.homedir(), '.claude', 'projects', WORK.replace(/[^a-zA-Z0-9]/g, '-'));
  await sleep(500);
  for (const d of [DATA, WORK, store]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
});
