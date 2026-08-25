/**
 * BUG-117 — a booting server may only reap session hosts it can prove are its own.
 *
 *   node scripts/verify-adoption-ownership.mjs
 *
 * THE INCIDENT. A verification lane set `STATION_DATA_DIR` (a name that exists
 * nowhere in this codebase) instead of `CLAUDE_STATION_DATA`, so `dataDir()`
 * fell back to the REAL data dir in total silence. The scratch server booted,
 * found the user's live session host, and SIGTERMed its broker (pid 623241).
 * Two independent faults: an unrecognised isolation attempt was
 * indistinguishable from setting nothing, and `adoptSurvivingHosts()` reaped
 * every record whose pid was alive — presence in the directory WAS the
 * entitlement.
 *
 * WHAT MUST HOLD NOW:
 *   - a boot that MEANT to isolate and missed refuses to start (exit 78);
 *   - adoption is ENTITLED, not merely located: a server may reap only records
 *     whose owner it can prove is itself;
 *   - and it is not vacuous — a server still adopts what it genuinely owns,
 *     because BUG-022 says a live turn must be drained, not abandoned.
 *
 * MUST-FAIL ON PRE-FIX CODE. Before 7d2c367 there was no `owner` field, no
 * `ownerEntitlesAdoption`, and no `assertDataDirIntent`: check 1 would boot
 * normally instead of exiting 78, and checks 3-5 would each reap the planted
 * broker (that is precisely the probe recorded in BUG-117's Evidence §2).
 *
 * SAFETY. Nothing here touches :4317, the `claude-station` service, or any
 * scope. The "shared/production" cases are exercised by pointing XDG_DATA_HOME
 * at a scratch tree, so `dataDirMode()` genuinely returns 'shared' while the
 * directory it resolves is our own — and that is ASSERTED before any server is
 * spawned (`assertSharedDirIsScratch`), because a bug in this harness is the
 * exact bug it is testing for. Every victim process is a `sleep` this script
 * spawned and kills by pid.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scratchRoot } from './lib/scratch.mjs';
import { assertIsolatedEnv, sharedDataDir } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Everything this run spawned, so `finally` can kill exactly its own. */
const spawned = [];
function spawnVictim() {
  const c = spawn('sleep', ['600'], { stdio: 'ignore', detached: false });
  spawned.push(c);
  return c;
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function pidStartToken(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch { return null; }
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/**
 * The harness's own safety interlock. A "shared mode" case here means
 * CLAUDE_STATION_DATA is deliberately UNSET — exactly the condition that made
 * the original incident possible — so before spawning any such server we prove
 * the directory it will actually resolve is inside our scratch root and is NOT
 * the user's. If this ever throws, the harness is the bug.
 */
function assertSharedDirIsScratch(env, scratch) {
  const resolved = sharedDataDir(env);
  const real = sharedDataDir({});
  if (path.resolve(resolved) === path.resolve(real)) {
    throw new Error(`HARNESS SAFETY STOP: a shared-mode case would resolve the REAL data dir (${real}).`);
  }
  if (!path.resolve(resolved).startsWith(path.resolve(scratch) + path.sep)) {
    throw new Error(`HARNESS SAFETY STOP: shared dir ${resolved} is not inside the scratch root ${scratch}.`);
  }
  return resolved;
}

/**
 * A planted status+ctl record shaped like the USER'S REAL live host record
 * (field for field, from an actual `session-hosts/<key>.json`), pointed at a
 * `sleep` this script owns. `owner: null` reproduces a pre-BUG-117 record.
 */
function plantHost(hostsDir, key, { ownerPort, ownerMode = 'shared', ownerDataDir, ownerPid }) {
  fs.mkdirSync(hostsDir, { recursive: true });
  const victim = spawnVictim();
  const owner = ownerPort == null ? null : {
    mode: ownerMode,
    dataDir: ownerDataDir ?? path.dirname(hostsDir),
    port: ownerPort,
    pid: ownerPid ?? process.pid,
    pidStart: pidStartToken(ownerPid ?? process.pid),
    startedAt: new Date().toISOString(),
  };
  const base = path.join(hostsDir, key);
  const status = {
    hostPid: victim.pid,
    claudePid: victim.pid,
    sock: `${base}.sock`,
    status: `${base}.json`,
    command: '/nonexistent/claude',
    args: ['--output-format', 'stream-json'],
    stationSessionId: `cs-${key}`,
    resumeHint: '00000000-0000-4000-8000-000000000000',
    owner,
    startedAt: new Date().toISOString(),
    state: 'running',
    exitCode: null,
    signal: null,
    backgroundLive: 0,
    backgroundTaskIds: [],
    backgroundLifetime: 'no',
    drainHeldSince: null,
    midTurn: false,
    midTurnSince: null,
    backgroundTasks: [],
    updatedAt: new Date().toISOString(),
    sdkSessionId: '00000000-0000-4000-8000-000000000000',
  };
  fs.writeFileSync(`${base}.json`, JSON.stringify(status));
  fs.writeFileSync(`${base}.ctl.json`, JSON.stringify({
    sock: `${base}.sock`, status: `${base}.json`, errlog: `${base}.err`,
    command: status.command, args: status.args, owner,
    meta: { stationSessionId: status.stationSessionId, resumeHint: status.resumeHint, owner },
  }));
  fs.writeFileSync(`${base}.err`, '');
  return { key, pid: victim.pid };
}

/** Boot a server, wait for health (or exit), collect its log, then stop it by pid. */
async function bootServer(env, port, { expectExit = false, settleMs = 4000 } = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT, env: { ...env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', (d) => { log += String(d); });
  child.stderr?.on('data', (d) => { log += String(d); });
  const exited = new Promise((res) => child.once('exit', (code) => res(code)));
  if (expectExit) {
    const code = await Promise.race([exited, sleep(15000).then(() => 'timeout')]);
    return { child, log, exitCode: code };
  }
  const t0 = Date.now();
  let healthy = false;
  while (Date.now() - t0 < 30000 && child.exitCode === null && !healthy) {
    try { healthy = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { /* not up */ }
    if (!healthy) await sleep(200);
  }
  // Adoption runs inside the listen callback; give it room to log its verdict.
  await sleep(settleMs);
  return { child, get log() { return log; }, healthy, exitCode: child.exitCode };
}
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(scratchRoot(), 'cs-adopt-own-'));
  const servers = [];
  try {
    // ---------------------------------------------------------------- 1
    console.log('\n================ 1. A boot that MEANT to isolate and MISSED must refuse ================');
    {
      const port = await freePort();
      const fakeHome = path.join(scratch, 'xdg-refuse');
      const env = { ...process.env, XDG_DATA_HOME: fakeHome, STATION_DATA_DIR: path.join(scratch, 'intended') };
      delete env.CLAUDE_STATION_DATA;
      assertSharedDirIsScratch(env, scratch);
      const r = await bootServer(env, port, { expectExit: true });
      servers.push(r.child);
      check('a server started with the MISSPELLED knob exits 78 (EX_CONFIG)', r.exitCode === 78, { exitCode: r.exitCode });
      check('its refusal names the variable that was wrong', /STATION_DATA_DIR/.test(r.log), r.log.split('\n').find((l) => /REFUSING/.test(l)) ?? '(no REFUSING line)');
      check('its refusal names the variable that is right', /CLAUDE_STATION_DATA/.test(r.log), /CLAUDE_STATION_DATA/.test(r.log));
    }

    // ---------------------------------------------------------------- 2
    console.log('\n================ 2. The boot banner says out loud which mode it is in ================');
    {
      const port = await freePort();
      const data = path.join(scratch, 'banner-data');
      const env = assertIsolatedEnv({ ...process.env, CLAUDE_STATION_DATA: data });
      const r = await bootServer(env, port, { settleMs: 1500 });
      servers.push(r.child);
      check('an isolated boot announces ISOLATED and the dir it resolved', /ISOLATED/.test(r.log) && r.log.includes(data), r.log.split('\n').find((l) => /data dir:/.test(l)) ?? '(no data dir line)');
      stopByPid(r.child);
    }

    // ---------------------------------------------------------------- 3
    console.log('\n================ 3. A STRAY shared server must not reap the live session ================');
    console.log('   (a record copied field-for-field from the user\'s REAL live host: owner mode "shared", port 4317)');
    {
      const port = await freePort();                       // an ephemeral port: a stray boot, not the service
      const fakeHome = path.join(scratch, 'xdg-stray');
      const env = { ...process.env, XDG_DATA_HOME: fakeHome };
      delete env.CLAUDE_STATION_DATA;                      // shared mode, on purpose — the incident's condition
      const resolvedData = assertSharedDirIsScratch(env, scratch);
      const hostsDir = path.join(resolvedData, 'session-hosts');
      const live = plantHost(hostsDir, 'h-liveshaped-1', { ownerPort: 4317, ownerMode: 'shared', ownerPid: 1 });
      const legacy = plantHost(hostsDir, 'h-legacy-1', { ownerPort: null });
      const r = await bootServer(env, port);
      servers.push(r.child);
      check('the stray shared server booted (it did not need to be blocked to be safe)', r.healthy === true, { healthy: r.healthy, exitCode: r.exitCode });
      await sleep(1500);
      check('the LIVE-SESSION-shaped host (owner port 4317) was left running', pidAlive(live.pid), { pid: live.pid, alive: pidAlive(live.pid) });
      check('it logged that it was NOT adopting that host', /NOT adopting/i.test(r.log), r.log.split('\n').filter((l) => /adopt/i.test(l)).join(' | ') || '(no adoption line)');
      check('a pre-BUG-117 owner-less record was ALSO left running by a stray port', pidAlive(legacy.pid), { pid: legacy.pid, alive: pidAlive(legacy.pid) });
      stopByPid(r.child);
    }

    // ---------------------------------------------------------------- 4
    console.log('\n================ 4. NON-VACUITY — a server still adopts what it genuinely owns ================');
    console.log('   (BUG-022: a live turn must be DRAINED, not abandoned — "never adopt" would be the wrong fix)');
    {
      const port = await freePort();
      const data = path.join(scratch, 'own-data');
      const hostsDir = path.join(data, 'session-hosts');
      const mine = plantHost(hostsDir, 't-mine-1', { ownerPort: port, ownerMode: 'isolated', ownerDataDir: data, ownerPid: 1 });
      const env = assertIsolatedEnv({ ...process.env, CLAUDE_STATION_DATA: data });
      const r = await bootServer(env, port);
      servers.push(r.child);
      let reaped = false;
      for (let i = 0; i < 40 && !reaped; i++) { reaped = !pidAlive(mine.pid); if (!reaped) await sleep(250); }
      check('an ISOLATED server DOES adopt a host in its own hosts dir', reaped, { pid: mine.pid, stillAlive: pidAlive(mine.pid), adoptLines: r.log.split('\n').filter((l) => /adopt/i.test(l)).join(' | ') });
      stopByPid(r.child);
    }

    // ---------------------------------------------------------------- 5
    console.log('\n================ 5. NON-VACUITY — a SHARED server adopts a record that names ITS port ================');
    console.log('   (this is the production service reclaiming its own hosts across a restart)');
    {
      const port = await freePort();
      const fakeHome = path.join(scratch, 'xdg-restart');
      const env = { ...process.env, XDG_DATA_HOME: fakeHome };
      delete env.CLAUDE_STATION_DATA;
      const resolvedData = assertSharedDirIsScratch(env, scratch);
      const hostsDir = path.join(resolvedData, 'session-hosts');
      const mine = plantHost(hostsDir, 'h-samePort-1', { ownerPort: port, ownerMode: 'shared', ownerPid: 1 });
      const foreign = plantHost(hostsDir, 'h-otherPort-1', { ownerPort: 4317, ownerMode: 'shared', ownerPid: 1 });
      const r = await bootServer(env, port);
      servers.push(r.child);
      let reaped = false;
      for (let i = 0; i < 40 && !reaped; i++) { reaped = !pidAlive(mine.pid); if (!reaped) await sleep(250); }
      check('a shared server re-adopts the host whose owner names its OWN port', reaped, { pid: mine.pid, stillAlive: pidAlive(mine.pid) });
      check('and in the SAME scan leaves the one naming a different port alone', pidAlive(foreign.pid), { pid: foreign.pid, alive: pidAlive(foreign.pid) });
      // The port-change residual: that stranded host is shared-owned, so BUG-114's
      // orphan bound deliberately exempts it and nothing else bounds it either.
      // Silent would make it a permanent invisible leak; it must be announced.
      check(
        'a host stranded by a PORT CHANGE (same data dir, shared owner, other port) is announced, not silently dropped',
        /WARNING: that host was created by a SHARED server in THIS data dir/.test(r.log),
        r.log.split('\n').find((l) => /WARNING: that host/.test(l)) ?? '(no warning line)',
      );
      stopByPid(r.child);
    }

    // ---------------------------------------------------------------- 6
    console.log('\n================ 6. The CORPSE SWEEP is entitled too, and cannot delete outside its own dir ================');
    console.log('   (this fired for real on 2026-08-25: a scratch probe deleted the LIVE host\'s .json/.sock/.err/.ctl.json)');
    {
      const { scanSurvivingHosts } = await import(`${path.join(ROOT, 'src', 'server', 'survival.ts')}`);
      // A "foreign hosts dir" standing in for the user's real one. Nothing here
      // touches the real dir; the point is that a record must not be able to
      // name a directory it was not found in and have it deleted.
      const foreignDir = path.join(scratch, 'foreign-hosts');
      fs.mkdirSync(foreignDir, { recursive: true });
      const foreignBase = path.join(foreignDir, 'h-victim-1');
      for (const ext of ['.json', '.sock', '.err', '.ctl.json']) fs.writeFileSync(`${foreignBase}${ext}`, 'live-host-file');

      // The scan runs against OUR hosts dir; the planted record points its
      // `status` at the foreign dir, exactly as the incident's record did.
      const data = path.join(scratch, 'sweep-data');
      const hostsDir = path.join(data, 'session-hosts');
      fs.mkdirSync(hostsDir, { recursive: true });
      const corpse = {
        hostPid: 999999999, claudePid: 999999999,   // a pid that cannot be alive
        status: `${foreignBase}.json`,               // <-- the escape: a path from data
        sock: `${foreignBase}.sock`, command: '/nonexistent/claude', args: [],
        stationSessionId: 'cs-corpse', resumeHint: null, owner: null,
        startedAt: new Date().toISOString(), state: 'exited', exitCode: 0, signal: null,
        backgroundLive: 0, backgroundTaskIds: [], backgroundLifetime: 'no',
        drainHeldSince: null, midTurn: false, midTurnSince: null, backgroundTasks: [],
        updatedAt: new Date().toISOString(), sdkSessionId: null,
      };
      fs.writeFileSync(path.join(hostsDir, 'h-corpse-1.json'), JSON.stringify(corpse));

      // A well-formed corpse of OUR OWN, entirely inside the scanned dir. The
      // confinement must not cost us ordinary tidying (ARCH-001's sweep) — a
      // check that only proves "deletes nothing" would pass on a no-op.
      const ownBase = path.join(hostsDir, 'h-corpse-2');
      const ownCorpse = {
        ...corpse, status: `${ownBase}.json`, sock: `${ownBase}.sock`,
        stationSessionId: 'cs-corpse-own',
        owner: { mode: 'isolated', dataDir: data, port: 1, pid: 1, pidStart: null, startedAt: new Date().toISOString() },
      };
      for (const ext of ['.sock', '.err', '.ctl.json']) fs.writeFileSync(`${ownBase}${ext}`, 'x');
      fs.writeFileSync(`${ownBase}.json`, JSON.stringify(ownCorpse));

      const prevData = process.env.CLAUDE_STATION_DATA;
      process.env.CLAUDE_STATION_DATA = data;
      try { scanSurvivingHosts(); } finally {
        if (prevData === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prevData;
      }
      const stillThere = ['.json', '.sock', '.err', '.ctl.json'].filter((e) => fs.existsSync(`${foreignBase}${e}`));
      check(
        'a record naming a path OUTSIDE the scanned hosts dir cannot delete those files',
        stillThere.length === 4,
        { survived: stillThere, deleted: ['.json', '.sock', '.err', '.ctl.json'].filter((e) => !stillThere.includes(e)) },
      );
      const ownLeft = ['.json', '.sock', '.err', '.ctl.json'].filter((e) => fs.existsSync(`${ownBase}${e}`));
      check(
        'NON-VACUITY: an owned corpse INSIDE the scanned dir is still swept (confinement is not a no-op)',
        ownLeft.length === 0,
        { leftBehind: ownLeft },
      );
    }

    // ---------------------------------------------------------------- 7
    console.log('\n================ 7. The boot helper refuses an unisolated env before anything spawns ================');
    {
      const tryEnv = (e) => { try { assertIsolatedEnv(e); return null; } catch (err) { return err.message; } };
      const unset = tryEnv({ ...process.env, CLAUDE_STATION_DATA: '' });
      check('assertIsolatedEnv refuses when CLAUDE_STATION_DATA is unset', typeof unset === 'string', unset?.slice(0, 110));
      const alias = tryEnv({ ...process.env, CLAUDE_STATION_DATA: '', STATION_DATA_DIR: '/x' });
      check('and names the look-alike the caller probably meant', typeof alias === 'string' && /STATION_DATA_DIR/.test(alias), alias?.slice(0, 160));
      const atShared = tryEnv({ ...process.env, XDG_DATA_HOME: path.join(scratch, 'x'), CLAUDE_STATION_DATA: path.join(scratch, 'x', 'claude-station') });
      check('and refuses a knob pointed AT the shared dir', typeof atShared === 'string', atShared?.slice(0, 110));
    }

    console.log(`\n================ ${pass} passed, ${fail} failed ================`);
    if (fail) { console.log('FAILURES:'); for (const f of failures) console.log(`  - ${f}`); }
    process.exitCode = fail ? 1 : 0;
  } finally {
    for (const s of servers) stopByPid(s);
    for (const c of spawned) { try { if (c.exitCode === null) process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(300);
    const survivors = spawned.filter((c) => pidAlive(c.pid));
    if (survivors.length) console.error(`  WARNING: ${survivors.length} victim process(es) outlived this run: ${survivors.map((c) => c.pid).join(', ')}`);
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* leave it */ }
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
