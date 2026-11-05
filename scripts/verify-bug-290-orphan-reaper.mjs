/**
 * BUG-290 — scratch-server self-defence.
 *
 * Proves, against a REAL booted scratch server (not a mock):
 *   1. predicate unit cases (worldGoneReason / pidAlive)
 *   2. MUST-FAIL: with the watchdog disabled (pre-fix behaviour) the server
 *      SURVIVES its launcher's death — the orphan reproduced.
 *   3. POST-FIX: with the watchdog armed the server self-reaps ~1s after its
 *      launcher dies, and exits when its cwd+data dir are deleted.
 *   4. SIGTERM normal-case exit time (anti-regression) + a SYNTHETIC fixture
 *      proving the forced-exit backstop fires even when the drain hangs
 *      (the index.ts shutdown() ordering fix).
 *
 *   node scripts/verify-bug-290-orphan-reaper.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedServerEnv } from './lib/station-boot.mjs';
import { worldGoneReason, pidAlive, launcherGone, currentPpid, inodeOf, dirGoneOrReplaced, cwdDeleted } from '../src/server/harness-watchdog.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${obs !== undefined ? `\n        ${JSON.stringify(obs)}` : ''}`); ok ? pass++ : fail++; };

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function waitHealth(port, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* */ } await sleep(200); }
  return false;
}

/** Boot a scratch server via a SHORT-LIVED launcher subprocess so we can kill the
 *  launcher independently and observe the server (child) react. Returns the server pid. */
async function bootViaLauncher({ watchdog }) {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bug290-data-'));
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bug290-work-'));
  const port = await freePort();
  // The launcher script spawns the server as ITS child and then sleeps forever;
  // killing the launcher makes the server an orphan exactly as the incident did.
  const launcherSrc = `
    import { spawn } from 'node:child_process';
    import { isolatedServerEnv } from ${JSON.stringify(path.join(ROOT, 'scripts/lib/station-boot.mjs'))};
    const ovr = ${watchdog ? '{}' : "{ CLAUDE_STATION_TEST_HARNESS: '0' }"};
    const env = isolatedServerEnv({ PORT: ${JSON.stringify(String(port))}, HOST: '127.0.0.1',
      CLAUDE_STATION_DATA: ${JSON.stringify(DATA)}, CLAUDE_PROJECTS_DIR: ${JSON.stringify(path.join(DATA, 'projects'))}, ...ovr },
      { requireStore: true });
    const srv = spawn(process.execPath, [${JSON.stringify(ENTRY)}], { cwd: ${JSON.stringify(WORK)}, env, stdio: ['ignore','ignore','ignore'] });
    process.stdout.write('SRVPID=' + srv.pid + '\\n');
    setInterval(() => {}, 1 << 30);
  `;
  const launcherFile = path.join(DATA, 'launcher.mjs');
  fs.writeFileSync(launcherFile, launcherSrc);
  const launcher = spawn(process.execPath, ['--experimental-strip-types', launcherFile], { stdio: ['ignore', 'pipe', 'ignore'] });
  let srvPid = null;
  launcher.stdout.on('data', (d) => { const m = /SRVPID=(\d+)/.exec(String(d)); if (m) srvPid = Number(m[1]); });
  const t0 = Date.now();
  while (srvPid === null && Date.now() - t0 < 10000) await sleep(100);
  const up = await waitHealth(port);
  return { launcher, srvPid, up, DATA, WORK };
}

async function main() {
  // 1. predicate unit cases
  const myPpid = currentPpid();
  check('currentPpid() reads a real ppid from /proc', Number.isInteger(myPpid) && myPpid > 0, { ppid: myPpid });
  check('worldGone: intact world (launcherPid = real ppid) → null', worldGoneReason({ launcherPid: myPpid, cwd: ROOT, dataDir: ROOT }) === null);
  check('worldGone: dead launcher → reason', /orphaned/.test(worldGoneReason({ launcherPid: 999999999, cwd: ROOT, dataDir: ROOT }) ?? ''));
  // Round-2 (verifier's zombie finding): a pid that is ALIVE but is NOT our parent
  // (a reparented-away launcher — a zombie reads exactly like this) must be "gone".
  check('launcherGone: live pid that is not our parent → true (zombie-class)', launcherGone(process.pid) === true, { probe: process.pid, ppid: myPpid });
  check('launcherGone: our actual parent → false', launcherGone(myPpid) === false);
  const goneDir = path.join(os.tmpdir(), 'bug290-nope-' + Date.now());
  check('worldGone: deleted cwd → reason', /working directory/.test(worldGoneReason({ launcherPid: null, cwd: goneDir, dataDir: ROOT }) ?? ''));
  check('worldGone: deleted data dir → reason', /data dir/.test(worldGoneReason({ launcherPid: null, cwd: ROOT, dataDir: goneDir }) ?? ''));
  // Round-3 (verifier's replaced-directories finding): inode identity, not path existence.
  check('inodeOf(real dir) → number', typeof inodeOf(ROOT) === 'number');
  check('inodeOf(missing) → null', inodeOf(goneDir) === null);
  check('dirGoneOrReplaced(missing, null) → true', dirGoneOrReplaced(goneDir, null) === true);
  check('dirGoneOrReplaced(real, its boot inode) → false', dirGoneOrReplaced(ROOT, inodeOf(ROOT)) === false);
  check('dirGoneOrReplaced(real, WRONG inode = replaced) → true', dirGoneOrReplaced(ROOT, 123456789) === true);
  check('cwdDeleted() false in a live cwd', cwdDeleted() === false);
  check('worldGone: data dir REPLACED (same path, new inode) → reason', /data dir/.test(worldGoneReason({ launcherPid: null, cwd: ROOT, dataDir: ROOT, dataDirBootIno: 123456789 }) ?? ''));
  check('pidAlive(self) true', pidAlive(process.pid) === true);
  check('pidAlive(1) false (never a launcher)', pidAlive(1) === false);
  check('pidAlive(dead) false', pidAlive(999999999) === false);

  // 2. MUST-FAIL — watchdog DISABLED: orphan survives launcher death.
  {
    const b = await bootViaLauncher({ watchdog: false });
    check('[pre-fix] server healthy', b.up && b.srvPid, { pid: b.srvPid });
    process.kill(b.launcher.pid, 'SIGKILL'); // launcher dies abnormally
    await sleep(3000);
    const survived = b.srvPid && alive(b.srvPid);
    check('[pre-fix/MUST-FAIL] orphan SURVIVES launcher death (watchdog off)', survived === true, { pid: b.srvPid, alive: !!survived });
    if (b.srvPid && alive(b.srvPid)) { try { process.kill(b.srvPid, 'SIGKILL'); } catch { /* */ } }
    for (const d of [b.DATA, b.WORK]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }

  // 3. POST-FIX — watchdog ARMED: orphan self-reaps after launcher death.
  {
    const b = await bootViaLauncher({ watchdog: true });
    check('[post-fix] server healthy', b.up && b.srvPid, { pid: b.srvPid });
    process.kill(b.launcher.pid, 'SIGKILL');
    const t0 = Date.now();
    while (b.srvPid && alive(b.srvPid) && Date.now() - t0 < 6000) await sleep(100);
    const reaped = !(b.srvPid && alive(b.srvPid));
    check('[post-fix] orphan SELF-REAPS after launcher death', reaped, { ms: Date.now() - t0 });
    if (b.srvPid && alive(b.srvPid)) { try { process.kill(b.srvPid, 'SIGKILL'); } catch { /* */ } }
    for (const d of [b.DATA, b.WORK]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }

  // 4a. POST-FIX — server exits when its cwd+data dir are deleted (busy-loop cure).
  {
    const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bug290-dd-data-'));
    const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bug290-dd-work-'));
    const port = await freePort();
    const env = isolatedServerEnv({ PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: path.join(DATA, 'projects') }, { requireStore: true });
    const srv = spawn(process.execPath, [ENTRY], { cwd: WORK, env, stdio: ['ignore', 'ignore', 'ignore'] });
    const up = await waitHealth(port);
    check('[post-fix] dir-delete: server healthy', up, { pid: srv.pid });
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.rmSync(DATA, { recursive: true, force: true });
    const t0 = Date.now();
    while (alive(srv.pid) && Date.now() - t0 < 4000) await sleep(100);
    check('[post-fix] server EXITS after cwd+data dir deleted', !alive(srv.pid), { ms: Date.now() - t0 });
    if (alive(srv.pid)) { try { process.kill(srv.pid, 'SIGKILL'); } catch { /* */ } }
  }

  // 4a-bis. POST-FIX (verifier round-2) — delete cwd+data dir then RECREATE empty
  // dirs at the SAME paths; the server must still exit (real cwd inode is gone).
  {
    const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bug290-rep-data-'));
    const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bug290-rep-work-'));
    const port = await freePort();
    const env = isolatedServerEnv({ PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: path.join(DATA, 'projects') }, { requireStore: true });
    const srv = spawn(process.execPath, [ENTRY], { cwd: WORK, env, stdio: ['ignore', 'ignore', 'ignore'] });
    const up = await waitHealth(port);
    check('[post-fix] replace: server healthy', up, { pid: srv.pid });
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });   // reoccupy the same paths with NEW inodes
    fs.mkdirSync(path.join(DATA, 'projects'), { recursive: true });
    const t0 = Date.now();
    while (alive(srv.pid) && Date.now() - t0 < 4000) await sleep(100);
    check('[post-fix] server EXITS when deleted dirs are REPLACED at same path', !alive(srv.pid), { ms: Date.now() - t0 });
    if (alive(srv.pid)) { try { process.kill(srv.pid, 'SIGKILL'); } catch { /* */ } }
    for (const d of [DATA, WORK]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }

  // 4b. SIGTERM normal-case exit time (anti-regression).
  {
    const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bug290-st-data-'));
    const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bug290-st-work-'));
    const port = await freePort();
    const env = isolatedServerEnv({ PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: path.join(DATA, 'projects') }, { requireStore: true });
    const srv = spawn(process.execPath, [ENTRY], { cwd: WORK, env, stdio: ['ignore', 'ignore', 'ignore'] });
    const up = await waitHealth(port);
    check('[sigterm] server healthy', up, { pid: srv.pid });
    const t0 = Date.now();
    process.kill(srv.pid, 'SIGTERM');
    while (alive(srv.pid) && Date.now() - t0 < 8000) await sleep(25);
    const dt = Date.now() - t0;
    check('[sigterm] exits within 2.5s of SIGTERM', !alive(srv.pid) && dt < 2500, { ms: dt });
    if (alive(srv.pid)) { try { process.kill(srv.pid, 'SIGKILL'); } catch { /* */ } }
    for (const d of [DATA, WORK]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }

  // 4c. SYNTHETIC (clearly labeled): the shutdown() ordering fix — a forced-exit
  // timer armed BEFORE a hanging drain still exits; armed AFTER it never does.
  {
    const synth = (orderFirst) => `
      let fired = false;
      const realExit = () => { fired = true; process.stdout.write('EXITED\\n'); };
      async function shutdownFixed() { const t = setTimeout(realExit, 100); t.unref?.(); await new Promise(() => {}); }   // armed first
      async function shutdownBuggy() { await new Promise(() => {}); const t = setTimeout(realExit, 100); t.unref?.(); }  // armed after hang
      void (${orderFirst ? 'shutdownFixed' : 'shutdownBuggy'})();
      setTimeout(() => { if (!fired) process.stdout.write('HUNG\\n'); process.exit(0); }, 400);
    `;
    const runSynth = (orderFirst) => new Promise((res) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', synth(orderFirst)], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = ''; p.stdout.on('data', (d) => (out += String(d)));
      p.on('close', () => res(/EXITED/.test(out) ? 'EXITED' : 'HUNG'));
    });
    const buggy = await runSynth(false);
    const fixed = await runSynth(true);
    check('[synthetic] backstop armed AFTER hang → HUNG (the bug)', buggy === 'HUNG', { buggy });
    check('[synthetic] backstop armed FIRST → EXITED (the fix)', fixed === 'EXITED', { fixed });
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
}

await main();
process.exit(fail ? 1 : 0);
