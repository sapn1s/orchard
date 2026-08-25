/**
 * BUG-022 — a resume that arrives DURING a restart survivor's drain window must
 * NOT spawn a second `claude --resume` onto the same transcript.
 *
 *   node scripts/verify-restart-reconnect-race.mjs
 *
 * This is the race the existing `verify-restart-survives.mjs` Phase B never
 * exercised: its Phase B waits for the survivor to be fully reaped BEFORE it
 * opens the second client, so the guard hole was invisible. Here we resume the
 * SAME sdkSessionId the INSTANT the freshly-booted server is healthy — while the
 * prior server's survivor broker + CLI are still alive and draining the
 * in-flight turn.
 *
 * Scratch-only, modelled on `verify-restart-survives.mjs`: own transient
 * `--user` systemd services (KillMode=control-group, matching production), a
 * "restart" is `systemctl --user stop`, and cleanup kills only by pid / its own
 * units. It NEVER touches port 4317 or the real claude-station unit.
 *
 * PRE-FIX (the bug):
 *   - the fresh server ACCEPTS the racing resume (`ack`, no `error`);
 *   - a SECOND `claude` process with `--resume=<sdkSessionId>` runs concurrently
 *     with the still-alive original survivor CLI;
 *   - the two interleave the transcript and the original turn's marker is lost.
 *
 * POST-FIX (the guard):
 *   - the fresh server REFUSES the racing resume with an honest, retryable error
 *     (its guard consults on-disk survivor state, not just the empty in-memory
 *     map);
 *   - NO second `claude --resume=<sdkSessionId>` ever coexists with the survivor;
 *   - the original in-flight turn drains to completion — its marker lands and its
 *     sentinel reply is in the transcript, which contains no spliced-in second
 *     turn.
 *
 * Requires `systemd-run --user`. Without it the fix cannot survive a
 * control-group kill and the harness cannot run faithfully — it errors rather
 * than pretending.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const RUN_TAG = `${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-race-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-race-work-'));

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

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** /proc scan: live `claude` pids whose cmdline carries `--resume=<sdkSessionId>`. */
function resumeClaudePids(sdkSessionId) {
  let names = [];
  try { names = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return []; }
  const out = [];
  for (const n of names) {
    const pid = Number(n);
    let comm = '';
    try { comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { continue; }
    if (comm !== 'claude') continue;
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { continue; }
    if (cmd.includes(`--resume=${sdkSessionId}`) || cmd.includes(`--resume ${sdkSessionId}`)) out.push(pid);
  }
  return out;
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
async function waitHostSdkId(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const h = readHosts()[0]; if (h?.sdkSessionId) return h; await sleep(200); }
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
    await sleep(120);
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
    body: JSON.stringify({ hostPath: WORK, name: 'race-fixture' }),
  })).json();
  if (reg.project?.id) return reg.project.id;
  const list = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json();
  const existing = (list.projects ?? list ?? []).find((p) => p.hostPath === WORK);
  if (existing?.id) return existing.id;
  throw new Error(`register failed: ${JSON.stringify(reg)}`);
}

/** A turn that stays in-flight long enough to keep the survivor's drain window
 * wide open: a long Bash `sleep`, then a Write of the marker, then a sentinel. */
function driveSlowTurn(conn, projectId, marker, sentinel) {
  conn.send({
    type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' },
    prompt:
      `Do exactly these steps in order and nothing else. ` +
      // python, NOT a bare `sleep 30`: some dev machines run an agent-harness
      // hook that blocks standalone sleeps ("Blocked: standalone sleep 30"),
      // making the model refuse the steps and end the turn in seconds — which
      // false-failed the "original turn COMPLETED" check (BUG-027 handoff).
      `Step 1: use the Bash tool to run the command: python3 -c 'import time; time.sleep(30)' . ` +
      `Step 2: after it finishes, use the Write tool to create the file ${marker} with its content being exactly the single word: SURVIVED . ` +
      `Step 3: then reply with exactly: ${sentinel}`,
  });
}

let server2 = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
}

const RACE_PROMPT_MARK = 'RACE-RESUME-2';
const ORIG_SENTINEL = 'RACE-DONE-1';

async function run() {
  console.log('\n========== BUG-022 — resume racing a restart survivor\'s drain window ==========');
  const unit = `cs-race-${RUN_TAG}.service`;
  const port = await freePort();
  startServerService(unit, port, {}); // survival on by default
  if (!(await waitHealth(port))) throw new Error('scratch service never became healthy');
  const projectId = await registerProject(port);
  const marker = path.join(WORK, 'raced-marker.txt');
  try { fs.rmSync(marker, { force: true }); } catch { /* ignore */ }

  // Drive the slow, in-flight turn on the FIRST server.
  const c = await openWs(port);
  driveSlowTurn(c, projectId, marker, ORIG_SENTINEL);
  const init = await waitEv(c.events, (e) => e.t === 'session-init', 90000);
  if (!init) throw new Error('session never initialised');
  const sdkSessionId = init.sessionId;
  const bash = await waitEv(c.events, (e) => e.t === 'tool-call' && e.name === 'Bash', 45000);
  check('PRECONDITION: the turn is genuinely in-flight (Bash sleep tool-call seen)', !!bash,
    bash ? { name: bash.name } : 'no Bash tool-call — model did not follow the steps');

  const host = await waitHost();
  check('a survival broker exists for the driven session', !!host?.hostPid && !!host?.claudePid,
    host ? { hostPid: host.hostPid, claudePid: host.claudePid, state: host.state } : 'no broker status file');

  // The broker must persist the CLI's ACTUAL sdkSessionId — the field the fixed
  // cross-process guard matches on (resumeHint is null for a fresh session).
  const hostId = await waitHostSdkId();
  check('the broker recorded the CLI\'s sdkSessionId in its status file (cross-process guard data)',
    hostId?.sdkSessionId === sdkSessionId, { recorded: hostId?.sdkSessionId, expected: sdkSessionId });

  try { c.ws.close(); } catch { /* ignore */ }
  if (process.env.RACE_DEBUG) console.log(`DEBUG t=${new Date().toISOString()} stopping server1`);
  // "Restart": control-group kill of the whole first server.
  stopService(unit);
  check('the first server is down after the control-group stop', await healthGone(port), `port ${port}`);
  await sleep(1200);

  // The survivor broker + CLI are still alive (FEAT-015 cgroup escape) — the
  // drain window is open. This is the window the racing resume must not exploit.
  check('the survivor broker + CLI are still alive after the restart (drain window open)',
    pidAlive(host.hostPid) && pidAlive(host.claudePid),
    { hostPid: host.hostPid, hostAlive: pidAlive(host.hostPid), claudePid: host.claudePid, claudeAlive: pidAlive(host.claudePid) });

  // Boot a fresh server pointed at the SAME data dir — its listen() fires the
  // fire-and-forget re-adopt (SIGTERM the broker to start the drain).
  const port2 = await freePort();
  server2 = spawn(process.execPath, [ENTRY], {
    cwd: ROOT, env: { ...process.env, PORT: String(port2), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server2.stderr?.on('data', (d) => process.stderr.write(`  [server2!] ${d}`));
  if (process.env.RACE_DEBUG) console.log(`DEBUG t=${new Date().toISOString()} server2 spawned; claudeAlive=${pidAlive(host.claudePid)}`);
  if (!(await waitHealth(port2))) throw new Error('restarted server never became healthy');
  if (process.env.RACE_DEBUG) console.log(`DEBUG t=${new Date().toISOString()} server2 healthy; claudeAlive=${pidAlive(host.claudePid)}`);

  // THE RACE: resume the SAME sdkSessionId the instant the fresh server is
  // healthy — while the survivor is still draining. A second CLI must never
  // coexist. Poll /proc across the whole window and keep the worst case.
  const preSurvivorAlive = pidAlive(host.hostPid) && pidAlive(host.claudePid);
  check('RACE PRECONDITION: survivor still alive when the fresh server starts accepting connections', preSurvivorAlive,
    { hostAlive: pidAlive(host.hostPid), claudeAlive: pidAlive(host.claudePid) });

  const c2 = await openWs(port2);
  c2.send({
    type: 'start', projectId, resumeSessionId: sdkSessionId,
    overrides: { model: 'haiku', permissionMode: 'bypassPermissions' },
    prompt: `Reply with exactly: ${RACE_PROMPT_MARK}`,
  });

  // Watch the outcome AND scan for a second concurrent CLI for a few seconds.
  let maxSecondCli = 0;
  let sawWhileSurvivorAlive = 0;
  const raceT0 = Date.now();
  while (Date.now() - raceT0 < 8000) {
    const pids = resumeClaudePids(sdkSessionId);
    if (pids.length > maxSecondCli) maxSecondCli = pids.length;
    if (pids.length > 0 && pidAlive(host.claudePid)) sawWhileSurvivorAlive = Math.max(sawWhileSurvivorAlive, pids.length);
    await sleep(200);
  }
  const ack = await waitEv(c2.events, (e) => e.t === 'ack' && e.of === 'start', 500);
  const err = await waitEv(c2.events, (e) => e.t === 'error', 500);

  // POST-FIX assertions (each FAILS pre-fix):
  check('the racing resume is REFUSED (honest error, no ack) — the guard fired',
    !ack && !!err, { ack: ack ? { reattached: ack.reattached } : null, error: err ? err.message : null });
  check('NO second `claude --resume=<sdkSessionId>` ever coexisted with the survivor',
    maxSecondCli === 0, { maxSecondResumeClaudePidsSeen: maxSecondCli, whileSurvivorAlive: sawWhileSurvivorAlive });

  try { c2.send({ type: 'close' }); } catch { /* ignore */ }
  try { c2.ws.close(); } catch { /* ignore */ }

  // The original in-flight turn must still drain to completion: its marker lands.
  let appeared = false;
  let lastHostStatus = null;
  for (let i = 0; i < 90 && !appeared; i++) {
    appeared = fs.existsSync(marker);
    const h = readHosts()[0]; if (h) lastHostStatus = h;
    if (!appeared) await sleep(1000);
  }
  if (process.env.RACE_DEBUG) console.log('DEBUG lastHostStatus:', JSON.stringify(lastHostStatus));
  const content = appeared ? fs.readFileSync(marker, 'utf8').trim() : '';
  check('the original in-flight turn COMPLETED (its marker landed) — no work lost',
    appeared && content.includes('SURVIVED'), { markerExists: appeared, content });

  // Give the broker a moment to finish + be reaped, then inspect the transcript.
  for (let i = 0; i < 30 && pidAlive(host.hostPid); i++) await sleep(1000);
  const store = path.join(os.homedir(), '.claude', 'projects', WORK.replace(/[^a-zA-Z0-9]/g, '-'));
  const transcript = path.join(store, `${sdkSessionId}.jsonl`);
  let lines = [];
  try { lines = fs.readFileSync(transcript, 'utf8').split('\n').filter((l) => l.trim()); } catch { /* absent */ }
  const raw = lines.join('\n');
  if (process.env.RACE_DEBUG) {
    try { console.log('DEBUG WORK dir:', fs.readdirSync(WORK)); } catch { /* gone */ }
    console.log('DEBUG transcript lines:', lines.length,
      'hasBash:', raw.includes('"name":"Bash"'), 'hasWrite:', raw.includes('"name":"Write"'),
      'hasResult:', raw.includes('"type":"result"'));
  }
  const hasOrigSentinel = raw.includes(ORIG_SENTINEL);
  const hasRacedTurn = raw.includes(RACE_PROMPT_MARK);
  check('the transcript is UNCORRUPTED: it holds the original turn and NO spliced-in racing turn',
    hasOrigSentinel && !hasRacedTurn,
    { lines: lines.length, hasOriginalSentinel: hasOrigSentinel, hasRacingSecondTurn: hasRacedTurn });
}

async function main() {
  if (!systemdRunAvailable()) {
    console.error('FATAL: this harness requires `systemd-run --user` (production\'s restart-survival mechanism). Not available here.');
    process.exitCode = 1;
    return;
  }
  await run();
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
