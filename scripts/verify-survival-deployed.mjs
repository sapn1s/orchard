/**
 * BUG-024 — FEAT-015 survival must be effective in the REAL DEPLOYED context: a
 * claude-station server running AS a `systemctl --user` SERVICE unit (exactly
 * like deploy/claude-station.service), not as a scope spawned from an interactive
 * shell. The driven CLI's broker (session-host.mjs) must land in its OWN transient
 * systemd scope cgroup — escaping the service's KillMode=control-group kill — so a
 * `systemctl --user stop` of the service leaves the broker + CLI ALIVE and the
 * in-flight turn completing.
 *
 *   node scripts/verify-survival-deployed.mjs
 *
 * WHY THIS EXISTS (the deployed-vs-scratch gap BUG-024 chased). This harness
 * mirrors the real deploy MORE faithfully than verify-restart-survives.mjs:
 *   - the scratch server runs as a transient `systemd-run --user --service` unit
 *     with KillMode=control-group (a "restart" = `systemctl --user stop` of it);
 *   - it is given ONLY PORT/HOST/CLAUDE_STATION_DATA via --setenv, exactly like
 *     the real unit sets only PORT — everything else (XDG_RUNTIME_DIR,
 *     DBUS_SESSION_BUS_ADDRESS, PATH, HOME) comes from the per-user systemd
 *     manager, NOT from this test's interactive shell. This is the environment in
 *     which the nested `systemd-run --user --scope` must still succeed.
 *
 * THE ASSERTION BUG-024 GOT WRONG. `systemd-run --scope` EXECs the broker
 * IN-PLACE, so the broker keeps PPID = the server WHILE being relocated into a
 * fresh scope cgroup. PPID is therefore NOT the escape indicator — cgroup
 * membership is. And our scope is explicitly named `claude-station-host-<key>.scope`
 * (via `--unit=`), so it never matches the anonymous `run-*.scope` glob. This test
 * asserts the RIGHT things: the broker + CLI live in a `claude-station-host-*.scope`
 * cgroup, that pid is NOT in the service's cgroup.procs, and a stop spares them.
 *
 * This NEVER touches port 4317 or the real claude-station unit; it kills only by
 * pid / its own transient units, and cleans every unit/socket/dir it creates.
 *
 * Requires `systemd-run --user`. Without it survival is unachievable and the
 * harness errors rather than pretending.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const RUN_TAG = `${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-survd-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-survd-work-'));

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

/* --------------------------------------------------- systemd transient service */

function systemdRunAvailable() {
  try {
    const r = spawnSync('systemd-run', ['--version'], { encoding: 'utf8', timeout: 4000 });
    return r.status === 0 && !!process.env.XDG_RUNTIME_DIR;
  } catch { return false; }
}

const services = new Set();
/**
 * Start the scratch server AS a `--user` service. CRUCIAL to the deployed repro:
 * we pass ONLY PORT/HOST/CLAUDE_STATION_DATA (mirroring deploy/claude-station.service,
 * which sets only PORT). XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS / PATH / HOME are
 * NOT leaked from this shell — the systemd --user manager supplies them, exactly as
 * for the real unit. That is the environment the nested scope launch must handle.
 */
function startServerService(unit, port) {
  services.add(unit);
  const args = [
    '--user', `--unit=${unit}`, '--quiet', '--collect',
    `--working-directory=${ROOT}`,
    `--setenv=PORT=${port}`, '--setenv=HOST=127.0.0.1', `--setenv=CLAUDE_STATION_DATA=${DATA}`,
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

function unitCgroupRel(unit) {
  const r = spawnSync('systemctl', ['--user', 'show', unit, '-p', 'ControlGroup', '--value'], { encoding: 'utf8', timeout: 8000 });
  return (r.stdout || '').trim();
}
function cgroupProcs(rel) {
  if (!rel) return [];
  try {
    return fs.readFileSync(path.join('/sys/fs/cgroup', rel, 'cgroup.procs'), 'utf8')
      .split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch { return []; }
}
/** The cgroup path a live pid is in (from /proc/<pid>/cgroup, `0::<path>`). */
function pidCgroup(pid) {
  try {
    const line = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim();
    const m = line.match(/^0::(.*)$/m);
    return m ? m[1] : line;
  } catch { return ''; }
}
function hostScopeUnits() {
  const r = spawnSync('systemctl', ['--user', 'list-units', 'claude-station-host-*.scope', '--no-legend', '--plain'],
    { encoding: 'utf8', timeout: 8000 });
  return (r.stdout || '').split('\n').map((s) => s.trim().split(/\s+/)[0]).filter((s) => s && s.endsWith('.scope'));
}
function runGlobScopeUnits() {
  const r = spawnSync('systemctl', ['--user', 'list-units', 'run-*.scope', '--no-legend', '--plain'],
    { encoding: 'utf8', timeout: 8000 });
  return (r.stdout || '').split('\n').map((s) => s.trim().split(/\s+/)[0]).filter((s) => s && s.endsWith('.scope'));
}
function ppidOf(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // field 4 (after the possibly-parenthesised comm) is ppid
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(after[1]);
  } catch { return -1; }
}
function commOf(pid) { try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return ''; } }
function cliChildOf(pid) {
  const r = spawnSync('bash', ['-c', `ps --ppid ${pid} -o pid= -o comm=`], { encoding: 'utf8', timeout: 5000 });
  for (const ln of (r.stdout || '').split('\n')) {
    const [p, c] = ln.trim().split(/\s+/);
    if (c === 'claude') return Number(p);
  }
  return null;
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
async function waitHost(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const h = readHosts().find((h) => h.hostPid > 0 && h.claudePid); if (h) return h; await sleep(200); }
  return readHosts()[0] ?? null;
}

/* ------------------------------------------------------------------- ws io */

function openWs(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej);
  });
}
const waitEv = async (events, pred, ms = 60000, from = 0) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.slice(from).find(pred);
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

async function registerProject(port) {
  const reg = await (await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // FEAT-131: direct-isolation survival suite — pin isolation so the
    // container-default for new projects cannot move the session off-host.
    body: JSON.stringify({ hostPath: WORK, name: 'survive-deployed-fixture', isolation: 'direct' }),
  })).json();
  if (reg.project?.id) return reg.project.id;
  const list = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json();
  const existing = (list.projects ?? list ?? []).find((p) => p.hostPath === WORK);
  if (existing?.id) return existing.id;
  throw new Error(`register failed: ${JSON.stringify(reg)}`);
}

function driveSlowTurn(conn, projectId, marker, sentinel) {
  conn.send({
    type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' },
    prompt:
      `Do exactly these steps in order and nothing else. ` +
      `Step 1: use the Bash tool to run the command: sleep 14 . ` +
      `Step 2: after it finishes, use the Write tool to create the file ${marker} with its content being exactly the single word: SURVIVED . ` +
      `Step 3: then reply with exactly: ${sentinel}`,
  });
}

let server2 = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
}

async function main() {
  if (!systemdRunAvailable()) {
    console.error('FATAL: this harness requires `systemd-run --user` (production\'s restart-survival mechanism). Not available here.');
    process.exitCode = 1;
    return;
  }

  console.log('\n=========== DEPLOYED CONTEXT — server AS a systemctl --user service (survival ON) ===========');
  const unit = `cs-survd-${RUN_TAG}.service`;
  const port = await freePort();
  startServerService(unit, port);
  if (!(await waitHealth(port))) throw new Error('scratch --user service never became healthy');
  const projectId = await registerProject(port);
  const marker = path.join(WORK, 'survived-deployed.txt');
  try { fs.rmSync(marker, { force: true }); } catch { /* ignore */ }

  const c = await openWs(port);
  driveSlowTurn(c, projectId, marker, 'TURN-DONE-DEPLOYED');
  const init = await waitEv(c.events, (e) => e.t === 'session-init', 90000);
  if (!init) throw new Error('session never initialised');
  const sdkSessionId = init.sessionId;
  const bash = await waitEv(c.events, (e) => e.t === 'tool-call' && e.name === 'Bash', 45000);
  check('PRECONDITION: the turn is genuinely in-flight (Bash sleep tool-call seen)', !!bash,
    bash ? { name: bash.name } : 'no Bash tool-call — model did not follow the steps');

  const host = await waitHost();
  check('a survival broker was created for the driven session', !!host?.hostPid && host.hostPid > 0 && !!host?.claudePid,
    host ? { hostPid: host.hostPid, claudePid: host.claudePid, state: host.state, scopeLaunchFailed: host.scopeLaunchFailed } : 'no broker status file');
  check('the scope launch did NOT fail (no scopeLaunchFailed flag) — survival is active, not a silent fallback',
    !host?.scopeLaunchFailed, { scopeLaunchFailed: host?.scopeLaunchFailed ?? false });

  // THE CORE ASSERTION: the broker (and its CLI) live in their OWN scope cgroup,
  // NOT in the service's control group. (Assert cgroup, NOT ppid — systemd-run
  // --scope execs in-place so ppid legitimately stays = the server.)
  const serviceRel = unitCgroupRel(unit);
  const serviceProcs = cgroupProcs(serviceRel);
  const brokerCg = pidCgroup(host.claudePid ? host.hostPid : host.hostPid);
  const brokerBase = path.basename(brokerCg);
  const inService = serviceProcs.includes(host.hostPid);
  const inOwnScope = brokerBase.startsWith('claude-station-host-') && brokerBase.endsWith('.scope') && brokerCg !== serviceRel;
  check('CGROUP ESCAPE: the broker is in its OWN claude-station-host-*.scope cgroup, NOT the service cgroup',
    inOwnScope && !inService,
    { brokerCgroup: brokerCg, serviceCgroup: serviceRel, brokerInServiceProcs: inService });

  const cliPid = host.claudePid ?? cliChildOf(host.hostPid);
  const cliCg = cliPid ? pidCgroup(cliPid) : '';
  check('CGROUP ESCAPE: the driven CLI shares the broker scope cgroup, NOT the service cgroup',
    !!cliPid && cliCg === brokerCg && !serviceProcs.includes(cliPid),
    { cliPid, cliCgroup: cliCg, inServiceProcs: cliPid ? serviceProcs.includes(cliPid) : null });

  // Document the exact BUG-024 misdiagnosis, as assertions.
  const hostScopes = hostScopeUnits();
  check('a claude-station-host-*.scope unit exists (the unit BUG-024 missed by globbing run-*.scope)',
    hostScopes.some((u) => u.startsWith('claude-station-host-')),
    { hostScopeUnits: hostScopes });
  const brokerPpid = ppidOf(host.hostPid);
  check("EXPECTED (not a bug): the broker's PPID legitimately = the server (systemd-run --scope execs in-place) — cgroup, not PPID, is the escape proof",
    brokerPpid > 0, { brokerPpid, note: 'ppid==server is normal; cgroup above proves the escape' });
  const runGlob = runGlobScopeUnits();
  console.log(`        [info] 'run-*.scope' glob (what BUG-024 checked) currently lists: ${JSON.stringify(runGlob)} — our scope is named claude-station-host-*, so it never matched.`);

  try { c.ws.close(); } catch { /* ignore */ }

  // "Restart" = control-group kill of the whole service.
  stopService(unit);
  check('the scratch server is down after the control-group stop', await healthGone(port), `port ${port}`);
  await sleep(1500);

  const hostAlive = pidAlive(host.hostPid);
  const cliAlive = cliPid ? pidAlive(cliPid) : false;
  check('SURVIVAL: the broker SURVIVED the control-group stop (still alive)', hostAlive, { hostPid: host.hostPid, alive: hostAlive });
  check('SURVIVAL: the driven CLI SURVIVED the control-group stop (still alive)', cliAlive, { cliPid, alive: cliAlive });

  let appeared = false;
  for (let i = 0; i < 60 && !appeared; i++) { appeared = fs.existsSync(marker); if (!appeared) await sleep(1000); }
  const content = appeared ? fs.readFileSync(marker, 'utf8').trim() : '';
  check('NO LOST WORK: the in-flight turn COMPLETED after the server died (marker written by the surviving CLI)',
    appeared && content.includes('SURVIVED'), { markerExists: appeared, content });

  // Fresh server re-adopts + reaps the survivor (no orphan).
  const port2 = await freePort();
  server2 = spawn(process.execPath, [ENTRY], {
    cwd: ROOT, env: { ...process.env, PORT: String(port2), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server2.stderr?.on('data', (d) => process.stderr.write(`  [server2!] ${d}`));
  if (!(await waitHealth(port2))) throw new Error('restarted server never became healthy');
  let reaped = false;
  for (let i = 0; i < 120 && !reaped; i++) { reaped = !pidAlive(host.hostPid); if (!reaped) await sleep(1000); }
  check('RE-ADOPT: the restarted server drained + reaped the surviving broker (no orphan)', reaped,
    { hostPid: host.hostPid, stillAlive: pidAlive(host.hostPid) });

  void sdkSessionId;
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
  // Reap ONLY brokers recorded in OUR scratch DATA dir — by pid. NEVER touch
  // claude-station-host-*.scope units globally (that would stop the REAL live
  // orchestrator's broker). Each broker's scope has `--collect`, so it
  // auto-removes from systemd the moment the broker pid dies.
  for (const h of readHosts()) { if (h?.hostPid > 0 && pidAlive(h.hostPid)) { try { process.kill(h.hostPid, 'SIGKILL'); } catch { /* gone */ } } }
  const store = path.join(os.homedir(), '.claude', 'projects', WORK.replace(/[^a-zA-Z0-9]/g, '-'));
  await sleep(500);
  for (const d of [DATA, WORK, store]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
});
