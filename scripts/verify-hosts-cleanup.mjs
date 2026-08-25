/**
 * BUG-023 — a genuinely-closed survivable session must not leak its broker's
 * status/err/ctl files in hostsDir() forever.
 *
 *   node scripts/verify-hosts-cleanup.mjs
 *
 * Repro (was the bug): `scanSurvivingHosts()` (the only cleanup path before the
 * fix) is invoked from exactly two call sites — boot-time `adoptSurvivingHosts()`
 * and the WS resume guard's `survivingHostForSdkSession()` (only on an explicit
 * `resumeSessionId`). A workflow that always starts fresh sessions and always
 * closes outright (never resumes-by-id, never restarts) never calls it, so every
 * open/close cycle's `<key>.json`/`.err`/`.ctl.json` triple piled up in
 * hostsDir() without bound.
 *
 * This harness, on a scratch server (own data dir, own free port, plain child
 * process — never touches :4317 or the real service):
 *   1. Opens a SURVIVOR session and leaves its turn genuinely in-flight (a long
 *      Bash sleep) — never closed, never resumed — so its broker stays ALIVE
 *      throughout the run.
 *   2. Runs N genuine open -> start -> wait turn-end -> explicit {type:'close'}
 *      cycles (no resumeSessionId, no restart) against fresh sessions.
 *   3. Asserts every closed cycle's own 3 files are gone from hostsDir() once its
 *      broker pid has actually exited — a normal open/close cycle must leave
 *      nothing behind.
 *   4. Asserts the SURVIVOR's 3 files are still present and untouched throughout
 *      (a still-alive host must never be swept just because sibling sessions
 *      closed) — then closes it for real at the end and asserts it cleans up too.
 *
 * Must FAIL on the pre-fix code (files accumulate for the N closed cycles).
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hostclean-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hostclean-work-'));
const N = Number(process.env.VERIFY_HOSTS_CLEANUP_N ?? 4);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function systemdRunAvailable() {
  try {
    const r = spawnSync('systemd-run', ['--version'], { encoding: 'utf8', timeout: 4000 });
    return r.status === 0 && !!process.env.XDG_RUNTIME_DIR;
  } catch { return false; }
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function hostsDirPath() { return path.join(DATA, 'session-hosts'); }
function listHostFiles() {
  try { return fs.readdirSync(hostsDirPath()); } catch { return []; }
}
/** Read every `<key>.json` status file present right now, keyed by hostKey. */
function readHostStatuses() {
  const out = new Map();
  for (const n of listHostFiles()) {
    if (!n.endsWith('.json') || n.endsWith('.ctl.json')) continue;
    const key = n.slice(0, -'.json'.length);
    try { out.set(key, JSON.parse(fs.readFileSync(path.join(hostsDirPath(), n), 'utf8'))); } catch { /* mid-write */ }
  }
  return out;
}
function filesForKey(key) {
  return [`${key}.json`, `${key}.err`, `${key}.ctl.json`].filter((f) => fs.existsSync(path.join(hostsDirPath(), f)));
}

let server = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
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

async function registerProject(port) {
  const reg = await (await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'hostclean-fixture' }),
  })).json();
  if (reg.project?.id) return reg.project.id;
  const list = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json();
  const existing = (list.projects ?? list ?? []).find((p) => p.hostPath === WORK);
  if (existing?.id) return existing.id;
  throw new Error(`register failed: ${JSON.stringify(reg)}`);
}

/** New host key(s) that appeared since `before` (a Set of prior keys). */
async function waitNewHostKey(before, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const now = readHostStatuses();
    for (const k of now.keys()) if (!before.has(k)) return k;
    await sleep(150);
  }
  return null;
}

async function runClosedCycle(port, projectId, i) {
  const before = new Set(readHostStatuses().keys());
  const c = await openWs(port);
  c.send({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt: `Reply with exactly: OK-${i}` });
  const key = await waitNewHostKey(before);
  if (!key) throw new Error(`[cycle ${i}] no new survival host key appeared`);
  const end = await waitEv(c.events, (e) => e.t === 'turn-end', 60000);
  if (!end) throw new Error(`[cycle ${i}] turn never ended`);
  const st = readHostStatuses().get(key);
  const hostPid = st?.hostPid;
  // Genuine close — the exact path AgentSession.close() -> SurvivalHandle.reap() takes.
  c.send({ type: 'close' });
  await sleep(300);
  try { c.ws.close(); } catch { /* ignore */ }
  // Wait for the broker to actually exit (graceful reap: stdin-EOF -> CLI exit -> host exit).
  let exited = false;
  for (let n = 0; n < 100 && !exited; n++) { exited = !pidAlive(hostPid); if (!exited) await sleep(200); }
  return { key, hostPid, exitedInTime: exited };
}

async function main() {
  if (!systemdRunAvailable()) {
    console.error('FATAL: this harness requires `systemd-run --user` (survival\'s launch mechanism). Not available here.');
    process.exitCode = 1;
    return;
  }
  const port = await freePort();
  server = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(port);

  console.log('\n================ SURVIVOR — a still-alive host must never be swept ================');
  const beforeSurvivor = new Set(readHostStatuses().keys());
  const survivor = await openWs(port);
  survivor.send({
    type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' },
    prompt: 'Use the Bash tool to run: sleep 45 . Then reply with exactly: SURVIVOR-DONE',
  });
  const survivorKey = await waitNewHostKey(beforeSurvivor);
  check('[survivor] a broker was created and left genuinely in-flight', !!survivorKey, { survivorKey });
  const survivorSt = survivorKey ? readHostStatuses().get(survivorKey) : null;
  check('[survivor] broker pid is alive', !!survivorSt && pidAlive(survivorSt.hostPid), survivorSt);

  console.log(`\n================ ${N} GENUINE OPEN/CLOSE CYCLES (no resume, no restart) ================`);
  const results = [];
  for (let i = 0; i < N; i++) {
    const r = await runClosedCycle(port, projectId, i);
    check(`[cycle ${i}] broker exited within timeout after explicit close`, r.exitedInTime, r);
    results.push(r);
    // The survivor's files must remain untouched by every intervening cycle.
    const survivorFilesNow = survivorKey ? filesForKey(survivorKey) : [];
    check(`[cycle ${i}] SURVIVOR's files still present (not swept by a sibling close)`, survivorFilesNow.length === 3,
      { survivorKey, survivorFilesNow });
  }

  console.log('\n================ VERIFY: closed cycles left NOTHING behind ================');
  for (const r of results) {
    const remaining = filesForKey(r.key);
    check(`[${r.key}] BUG-023 FIX: no leftover status/err/ctl files after a genuine close`, remaining.length === 0,
      { hostPid: r.hostPid, remaining, allHostsDirFiles: listHostFiles() });
  }

  console.log('\n================ CLOSE THE SURVIVOR TOO — it must clean up on its own real close ================');
  /*
   * BUG-047 — close the survivor at an IDLE boundary, deterministically.
   * An explicit `{type:'close'}` on a BUSY session is a DETACH by design
   * (BUG-018; unified for both close paths in BUG-043's releaseSocketSession):
   * the broker rightly stays alive until the turn ends and the boundary fuse
   * closes the session. This suite's assertions are about a GENUINE close
   * sweeping the host files — so wait for the survivor's turn-end first,
   * instead of racing the close against `sleep 45` + model thinking +
   * provider retries (the race is exactly what flipped runs between 17/17 and
   * 14/17). The still-alive-host-never-swept checks above are unaffected: the
   * broker stays up while the session is open whether the turn is in flight
   * or not.
   */
  const survivorEnd = await waitEv(survivor.events, (e) => e.t === 'turn-end', 180000);
  if (!survivorEnd) {
    throw new Error(`survivor turn never ended within 180s — cannot test a genuine close (a busy close is a detach by design); last events: ${survivor.events.map((e) => e.t).slice(-6).join(',')}`);
  }
  console.log('  [precondition] survivor turn-end observed — the close below lands at a turn boundary (any backgrounded sleep makes it a BOUNDED hold, see below)');
  const survivorStBefore = survivorKey ? readHostStatuses().get(survivorKey) : null;
  survivor.send({ type: 'close' });
  await sleep(300);
  try { survivor.ws.close(); } catch { /* ignore */ }
  /*
   * BUG-047 — the engine BACKGROUNDS the long `sleep` (its level frame reports
   * a live background task), so this close is — by BUG-043's design — a detach
   * that HOLDS until the level empties, then the fuse closes for real. The
   * bound is: sleep remainder (≤45s) + fuse recheck cadence (≤30s) + graceful
   * reap; 120s covers it with margin. This does NOT weaken the assertions —
   * a broken sweep leaves the files forever (planted-break proven), and a
   * wedged broker never exits at all.
   */
  let survivorExited = false;
  for (let n = 0; n < 600 && !survivorExited; n++) {
    survivorExited = !survivorStBefore || !pidAlive(survivorStBefore.hostPid);
    if (!survivorExited) await sleep(200);
  }
  check('[survivor] broker exited after its own genuine close', survivorExited, survivorStBefore);
  const survivorRemaining = survivorKey ? filesForKey(survivorKey) : [];
  check('[survivor] BUG-023 FIX: no leftover files after the survivor itself is genuinely closed', survivorRemaining.length === 0,
    { survivorKey, survivorRemaining, allHostsDirFiles: listHostFiles() });

  const finalFiles = listHostFiles();
  check('[final] hostsDir() is completely empty — 0 stale files after all cycles', finalFiles.length === 0, { finalFiles });

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  stopByPid(server);
  await sleep(300);
  // Reap any broker still alive, by pid, so nothing leaks past the run.
  for (const [, st] of readHostStatuses()) { if (st?.hostPid && pidAlive(st.hostPid)) { try { process.kill(st.hostPid, 'SIGKILL'); } catch { /* gone */ } } }
  const store = path.join(os.homedir(), '.claude', 'projects', WORK.replace(/[^a-zA-Z0-9]/g, '-'));
  await sleep(500);
  for (const d of [DATA, WORK, store]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
});
