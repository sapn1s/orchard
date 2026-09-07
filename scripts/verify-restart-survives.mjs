/**
 * FEAT-015 — a claude-station server restart must NOT kill in-flight driven
 * `direct` sessions (their CLI + its in-process Task sub-agents).
 *
 *   node scripts/verify-restart-survives.mjs
 *
 * This reproduces the REAL production mechanism, then proves the fix, on a
 * scratch server — it NEVER touches port 4317 or the real claude-station unit,
 * and kills only by pid / its own transient units.
 *
 * FAITHFUL REPRO. Production runs claude-station as a systemd --user service with
 * KillMode=control-group, so a restart control-group-kills the whole service
 * cgroup — CLI included. Here the scratch server is launched as its OWN transient
 * `--user` service (same KillMode=control-group), and a "restart" is
 * `systemctl --user stop <that unit>` — a real control-group kill. Verified
 * primitive: a `systemd-run --user --scope` grandchild survives such a stop while
 * a normal child dies.
 *
 * PHASE A — FAILURE CONTROL (survival OFF, CLAUDE_STATION_SURVIVE=0):
 *   the driven CLI is a plain child inside the service cgroup. Stopping the
 *   service kills it mid-turn; the in-flight work (a Bash `sleep` then a Write)
 *   never completes — its marker file never appears. This is the bug.
 *
 * PHASE B — THE FIX (survival ON, the default):
 *   the CLI is launched under a broker in its OWN systemd scope (separate cgroup)
 *   whose stdio the broker — not the server — owns. Proof points:
 *     (1) the CLI pid is NOT in the service cgroup (it escaped to a scope);
 *     (2) after the service is stopped, the broker + CLI are STILL ALIVE;
 *     (3) the in-flight turn DRAINS TO COMPLETION after the server is dead —
 *         its marker file appears on disk;
 *     (4) a freshly booted server RE-ADOPTS the surviving broker (reaps it once
 *         its turn is done), and a resume-from-disk follow-up turn works
 *         end-to-end.
 *
 * Requires `systemd-run --user` (production's mechanism). Without it the fix
 * cannot survive a control-group kill and the harness cannot run faithfully — it
 * errors rather than pretending.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const RUN_TAG = `${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-surv-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-surv-work-'));

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

/** Curated env for the transient service — everything the harness has, minus values unsafe for --setenv. */
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
function startServerService(unit, port, overrides) {
  services.add(unit);
  const args = [
    '--user', `--unit=${unit}`, '--quiet', '--collect',
    `--working-directory=${ROOT}`,
    ...setenvArgs({ PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, ...overrides }),
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

function serviceCgroupProcs(unit) {
  const r = spawnSync('systemctl', ['--user', 'show', unit, '-p', 'ControlGroup', '--value'], { encoding: 'utf8', timeout: 8000 });
  const rel = (r.stdout || '').trim();
  if (!rel) return [];
  const procsFile = path.join('/sys/fs/cgroup', rel, 'cgroup.procs');
  try {
    return fs.readFileSync(procsFile, 'utf8').split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch { return []; }
}

function commOf(pid) {
  try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return ''; }
}
function claudePidsInService(unit) {
  return serviceCgroupProcs(unit).filter((p) => commOf(p) === 'claude');
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/* -------------------------------------------------------------- host status */

function readHosts() {
  const dir = path.join(DATA, 'session-hosts');
  let names = [];
  // Status files are `<key>.json`; the broker's control input is `<key>.ctl.json` — exclude it.
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
    body: JSON.stringify({ hostPath: WORK, name: 'survive-fixture', isolation: 'direct' }),
  })).json();
  if (reg.project?.id) return reg.project.id;
  // Shared DATA across phases: the project may already exist — reuse it.
  const list = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json();
  const existing = (list.projects ?? list ?? []).find((p) => p.hostPath === WORK);
  if (existing?.id) return existing.id;
  throw new Error(`register failed: ${JSON.stringify(reg)}`);
}

/**
 * Drive a session whose turn stays in-flight for a while: a Bash `sleep` then a
 * Write of the marker, then a sentinel reply. The sleep is the in-flight work we
 * kill the server during; the post-sleep Write is the proof the turn survived.
 */
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

async function phaseA() {
  console.log('\n================ PHASE A — FAILURE CONTROL (survival OFF) ================');
  const unit = `cs-surv-a-${RUN_TAG}.service`;
  const port = await freePort();
  startServerService(unit, port, { CLAUDE_STATION_SURVIVE: '0' });
  if (!(await waitHealth(port))) throw new Error('[A] scratch service never became healthy');
  const projectId = await registerProject(port);
  const marker = path.join(WORK, 'survived-A.txt');
  try { fs.rmSync(marker, { force: true }); } catch { /* ignore */ }

  const c = await openWs(port);
  driveSlowTurn(c, projectId, marker, 'TURN-DONE-A');
  const init = await waitEv(c.events, (e) => e.t === 'session-init', 90000);
  if (!init) throw new Error('[A] session never initialised');
  const bash = await waitEv(c.events, (e) => e.t === 'tool-call' && e.name === 'Bash', 45000);
  check('[A] PRECONDITION: the turn is genuinely in-flight (Bash sleep tool-call seen)', !!bash,
    bash ? { name: bash.name } : 'no Bash tool-call — model did not follow the steps');

  // With survival OFF the CLI is a plain child in the service cgroup.
  const inCgroup = claudePidsInService(unit);
  check('[A] the driven CLI is INSIDE the service cgroup (no survival)', inCgroup.length >= 1,
    { claudePidsInServiceCgroup: inCgroup, hosts: readHosts().length });
  const hosts = readHosts();
  check('[A] no survival broker was created (survival disabled)', hosts.length === 0, { hosts: hosts.length });

  try { c.ws.close(); } catch { /* ignore */ }
  // "Restart": control-group kill of the whole service.
  stopService(unit);
  check('[A] the scratch server is down after the control-group stop', await healthGone(port), `port ${port}`);

  // The CLI died with the cgroup.
  await sleep(1500);
  const stillAlive = inCgroup.filter(pidAlive);
  check('[A] BUG REPRODUCED: the driven CLI was KILLED by the restart (cgroup reap)', stillAlive.length === 0,
    { wasAlive: inCgroup, stillAlive });

  // The in-flight turn never completed — its marker never lands.
  let appeared = false;
  for (let i = 0; i < 40 && !appeared; i++) { appeared = fs.existsSync(marker); if (!appeared) await sleep(1000); }
  check('[A] BUG REPRODUCED: the in-flight turn did NOT complete after the restart (marker absent)', !appeared,
    { markerExists: appeared });
}

async function phaseB() {
  console.log('\n================ PHASE B — THE FIX (survival ON, default) ================');
  const unit = `cs-surv-b-${RUN_TAG}.service`;
  const port = await freePort();
  startServerService(unit, port, {}); // survival on by default
  if (!(await waitHealth(port))) throw new Error('[B] scratch service never became healthy');
  const projectId = await registerProject(port);
  const marker = path.join(WORK, 'survived-B.txt');
  try { fs.rmSync(marker, { force: true }); } catch { /* ignore */ }

  const c = await openWs(port);
  driveSlowTurn(c, projectId, marker, 'TURN-DONE-B');
  const init = await waitEv(c.events, (e) => e.t === 'session-init', 90000);
  if (!init) throw new Error('[B] session never initialised');
  const sdkSessionId = init.sessionId;
  const bash = await waitEv(c.events, (e) => e.t === 'tool-call' && e.name === 'Bash', 45000);
  check('[B] PRECONDITION: the turn is genuinely in-flight (Bash sleep tool-call seen)', !!bash,
    bash ? { name: bash.name } : 'no Bash tool-call — model did not follow the steps');

  // The survival broker exists and the CLI escaped the service cgroup.
  const host = await waitHost();
  check('[B] a survival broker was created for the driven session', !!host?.hostPid && !!host?.claudePid,
    host ? { hostPid: host.hostPid, claudePid: host.claudePid, state: host.state } : 'no broker status file found');

  const cgroupProcs = serviceCgroupProcs(unit);
  const claudeInService = claudePidsInService(unit);
  const escaped = host && !cgroupProcs.includes(host.claudePid) && claudeInService.length === 0;
  check('[B] THE FIX (cgroup escape): the CLI pid is NOT in the service cgroup — it is in its own scope', !!escaped,
    { claudePid: host?.claudePid, claudePidsInServiceCgroup: claudeInService });

  try { c.ws.close(); } catch { /* ignore */ }
  // "Restart": control-group kill of the whole service.
  stopService(unit);
  check('[B] the scratch server is down after the control-group stop', await healthGone(port), `port ${port}`);
  await sleep(1500);

  // THE FIX (survival): broker + CLI still alive after the server's cgroup was reaped.
  const hostAlive = pidAlive(host.hostPid);
  const cliAlive = pidAlive(host.claudePid);
  check('[B] THE FIX (survival): the broker SURVIVED the restart (still alive)', hostAlive, { hostPid: host.hostPid, alive: hostAlive });
  check('[B] THE FIX (survival): the driven CLI SURVIVED the restart (still alive)', cliAlive, { claudePid: host.claudePid, alive: cliAlive });

  // THE FIX (no lost work): the in-flight turn drains to completion after the
  // server is dead — the marker appears on disk, written by the surviving CLI.
  let appeared = false;
  for (let i = 0; i < 60 && !appeared; i++) { appeared = fs.existsSync(marker); if (!appeared) await sleep(1000); }
  const content = appeared ? fs.readFileSync(marker, 'utf8').trim() : '';
  check('[B] THE FIX (no lost work): the in-flight turn COMPLETED after the restart (marker written by the surviving CLI)',
    appeared && content.includes('SURVIVED'), { markerExists: appeared, content });

  // Fresh server re-adopts the surviving broker (drains + reaps it).
  const port2 = await freePort();
  server2 = spawn(process.execPath, [ENTRY], {
    cwd: ROOT, env: { ...process.env, PORT: String(port2), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server2.stderr?.on('data', (d) => process.stderr.write(`  [server2!] ${d}`));
  if (!(await waitHealth(port2))) throw new Error('[B] restarted server never became healthy');

  let reaped = false;
  for (let i = 0; i < 120 && !reaped; i++) { reaped = !pidAlive(host.hostPid); if (!reaped) await sleep(1000); }
  check('[B] RE-ADOPT: the restarted server drained + reaped the surviving broker (no orphan left)', reaped,
    { hostPid: host.hostPid, stillAlive: pidAlive(host.hostPid) });

  // Follow-up: resume the thread from disk on the restarted server and run a new
  // turn end-to-end (proves continuity — no work lost, thread continues).
  const c2 = await openWs(port2);
  c2.send({ type: 'start', projectId, resumeSessionId: sdkSessionId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' },
    prompt: 'Reply with exactly: RESUME-OK' });
  const ack = await waitEv(c2.events, (e) => e.t === 'ack' && e.of === 'start', 60000);
  const end = await waitEv(c2.events, (e) => e.t === 'turn-end', 180000);
  const gotText = c2.events.some((e) => e.t === 'text' && String(e.text ?? '').includes('RESUME-OK'));
  check('[B] CONTINUITY: a resume-from-disk follow-up turn works end-to-end on the restarted server',
    !!ack && !!end && end.interrupted === false && gotText,
    { ack: !!ack, end: end && { subtype: end.subtype, interrupted: end.interrupted }, gotText });
  try { c2.send({ type: 'close' }); } catch { /* ignore */ }
  await sleep(800);
  try { c2.ws.close(); } catch { /* ignore */ }
}

async function main() {
  if (!systemdRunAvailable()) {
    console.error('FATAL: this harness requires `systemd-run --user` (production\'s restart-survival mechanism). Not available here.');
    process.exitCode = 1;
    return;
  }
  await phaseA();
  await phaseB();
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
  // Reap any broker still alive, by pid, so nothing leaks past the run.
  for (const h of readHosts()) { if (h?.hostPid && pidAlive(h.hostPid)) { try { process.kill(h.hostPid, 'SIGKILL'); } catch { /* gone */ } } }
  // Clean the CLI's on-disk transcripts for this scratch project from the real store.
  const store = path.join(os.homedir(), '.claude', 'projects', WORK.replace(/[^a-zA-Z0-9]/g, '-'));
  await sleep(500);
  for (const d of [DATA, WORK, store]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
});
