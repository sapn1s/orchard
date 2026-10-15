#!/usr/bin/env node
/**
 * BUG-254 r9 — the two r8 breaks, closed STRUCTURALLY (independent design review: KEEP-PATCH both).
 *
 * BREAK 1 (probe gate, r4+r8): a docker GLOBAL option before the verb (`-H <other-daemon>`,
 *   `--context`, `--config`, `-l`, `-D`, and glued/`=` spellings) was never inspected by the authority:
 *   `verbIndex` skips leading globals, and every authority path (probe, lease, op) slices from `verbAt`.
 *   FIX: a single choke-point guard in authorize() — `if (verbAt(args) !== 0) refuse(...)`. No Orchard
 *   docker argv begins with a global option (every caller starts with the verb/object word), so this
 *   refuses nothing legitimate and ends the whole daemon-redirect / config-swap class in one line.
 *   This test proves the DECISION for every attack spelling and every real argv via `verbAt`
 *   classification (the end-to-end gate firing over a real session container is the docker clean-room
 *   verify's job — authorize() needs a booted authority + docker).
 *
 * BREAK 2 (reconciler restart window, r8): drive() gated ONLY the credential-stale recreate on
 *   leasesReady(); a GIT mismatch recreated during the boot window (leasesReady false) while
 *   sessionsOf()/leasesOf() were still empty — closing/recreating under an unrecovered survivor.
 *   FIX: hold EVERY recreate reason until reconcileReady()(=leasesReady). Driven against the REAL
 *   module and a SYNTHESIZED pre-fix baseline (the r9 guard hunk reverted into a temp module — an
 *   explicitly-constructed pre-fix state, never `git show`). Must-FAIL on pre-fix, PASS on real.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
}
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/* ═══════════════ BREAK 1 — probe-gate global-option class via verbAt ═══════════════ */
const { verbAt } = await import(url.pathToFileURL(path.join(ROOT, 'src/server/docker-exec.ts')).href);

// Every real probe / lease / mutation argv Orchard constructs begins with the verb or object word.
const REAL = [
  ['exec', 'claude-station-p1', 'stat', '-c', '%i %n', '/home/claude/.claude/.credentials.json'],
  ['exec', 'claude-station-p1', 'sh', '-c', 'for p do [ -w "$p" ] && printf "W %s\\n" "$p"; done; true', 'sh', '/w/.git'],
  ['exec', '--user', '1000:1000', 'claude-station-p1', 'sh', '-c', 'cat /proc/self/status'],
  ['exec', '--env', 'CLAUDE_STATION_EXEC=cs-x', 'claude-station-p1', 'node', 'x'],
  ['create', '--name', 'claude-station-p1', '--label', 'claude-station=1'],
  ['rm', 'claude-station-p1'],
  ['stop', '-t', '2', 'claude-station-p1'],
  ['volume', 'create', '--label', 'k=v', 'vol1'],
  ['container', 'rm', 'claude-station-p1'],
];
for (const argv of REAL) check(`real argv keeps verb at index 0: ${argv.slice(0, 2).join(' ')}`, verbAt(argv) === 0, verbAt(argv));

// A docker GLOBAL option before the verb — every spelling — moves the verb off index 0, so the
// authority's `verbAt(args) !== 0` guard refuses it (it would redirect the daemon/context/config).
const ATTACK = [
  ['-H', 'unix:///other.sock', 'exec', 'claude-station-p1', 'stat', '-c', '%i %n', '/x'],
  ['--host', 'tcp://evil:2375', 'exec', 'claude-station-p1', 'stat', '-c', '%i %n', '/x'],
  ['--context', 'remote', 'exec', 'claude-station-p1', 'stat', '-c', '%i %n', '/x'],
  ['-c', 'remote', 'exec', 'claude-station-p1', 'stat', '-c', '%i %n', '/x'],
  ['--config', '/tmp/evil', 'exec', 'claude-station-p1', 'stat', '-c', '%i %n', '/x'],
  ['-l', 'debug', 'exec', 'claude-station-p1', 'stat', '-c', '%i %n', '/x'],
  ['--log-level', 'debug', 'exec', 'claude-station-p1', 'stat', '-c', '%i %n', '/x'],
  ['-D', 'exec', 'claude-station-p1', 'stat', '-c', '%i %n', '/x'],               // boolean global (debug)
  ['-Hunix:///other.sock', 'exec', 'claude-station-p1', 'stat', '-c', '%i %n', '/x'], // glued value
  ['--context=remote', 'exec', 'claude-station-p1', 'stat', '-c', '%i %n', '/x'],  // = form
  ['--host=tcp://evil:2375', 'exec', 'claude-station-p1', 'stat', '-c', '%i %n', '/x'],
  ['-H', 'unix:///other.sock', 'rm', 'claude-station-p1'],                          // op mutation path too
  ['--context', 'remote', 'create', '--name', 'claude-station-p1'],                 // create path too
];
for (const argv of ATTACK) {
  const v = verbAt(argv);
  check(`global option before verb is refused (verbAt!==0): ${argv.slice(0, 2).join(' ')}`, v !== 0, `verbAt=${v}`);
}

// Prove the guard is actually wired into the single authority choke point (not just in authorizeProbe).
const lifeSrc = fs.readFileSync(path.join(ROOT, 'src/server/lifecycle.ts'), 'utf8');
const guardWired = /function authorize\(args: readonly string\[\]\): MutationGrant \{[\s\S]*?if \(verbAt\(args\) !== 0\) refuse\('global-option'/.test(lifeSrc);
check('verbAt!==0 guard is wired at the authorize() choke point (covers probe+lease+op)', guardWired, guardWired);

/* ═══════════════ BREAK 2 — reconciler restart window ═══════════════ */
const MOD = path.join(ROOT, 'src/server/grant-rebuild.ts');
const src = fs.readFileSync(MOD, 'utf8');

// Revert EXACTLY the r9 guard hunk to synthesize the pre-fix baseline (git reason un-gated in the window).
const HUNK_FIX = `      if (!reconcileReady()) {
        if (press) press.decide('refused: Orchard is still recovering surviving sessions after a restart — press again in a moment');
        return;
      }
      e.desired = d;`;
const HUNK_PRE = `      e.desired = d; // PRE-FIX r9: no readiness gate — git mismatch recreates during the boot window`;
// Also revert the credStale decoupling so the pre-fix module matches r8 exactly (cred gated, git not).
const CRED_FIX = `      const credStale = e.cred === 'stale';`;
const CRED_PRE = `      const credStale = e.cred === 'stale' && reconcileReady();`;
if (!src.includes(HUNK_FIX) || !src.includes(CRED_FIX)) {
  console.log('FATAL: the r9 fix hunks were not found verbatim — update this test to match the module.');
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(2);
}
const preSrc = src.replace(HUNK_FIX, HUNK_PRE).replace(CRED_FIX, CRED_PRE);
const preFile = path.join(os.tmpdir(), `grant-rebuild-r9-prefix-${process.pid}.ts`);
fs.writeFileSync(preFile, preSrc);

const { createGrantRebuild } = await import(url.pathToFileURL(MOD).href);
const { createGrantRebuild: createPre } = await import(url.pathToFileURL(preFile).href);

/**
 * World: a RESTART boot window. leasesReady() starts false (recovery running). The container was
 * created rw; the timed grant is dead so desired='ro' → a GIT mismatch. A survivor is mid-turn in the
 * container but NOT yet re-adopted and its lease NOT yet recovered → sessionsOf=[] and leasesOf=[].
 */
function world() {
  const w = {
    recreated: 0, closed: [], leasesReadyVal: false,
    cred: 'clean', actual: 'rw', desired: 'ro',
    sessions: [], leases: [],
  };
  w.deps = {
    listProjects: () => [{ id: 'p1', name: 'proj1', isolation: 'container' }],
    desiredOf: () => w.desired,
    readActual: () => w.actual,
    readCredDrift: () => w.cred,
    leasesReady: () => w.leasesReadyVal,
    sessionsOf: () => w.sessions.filter((s) => !s.closed),
    leasesOf: () => w.leases,
    deliveryBusy: () => false,
    reserve: () => () => {},
    recreate: async () => { w.recreated++; },
    settled: () => {},
    now: () => Date.now(),
    log: () => {},
  };
  return w;
}

async function run(make, w) {
  const gr = make(w.deps);
  gr.tick();
  await flush(30);
  return gr;
}

// B1 — REAL module: during the window (leasesReady false), a git mismatch must NOT recreate.
{
  const w = world();
  await run(createGrantRebuild, w);
  check('REAL: git mismatch does NOT recreate during the leasesReady=false window', w.recreated === 0, `recreated=${w.recreated}`);
}
// B1 pre-fix baseline MUST recreate (the r8 break) — proves the test is anchored.
{
  const w = world();
  await run(createPre, w);
  check('PRE-FIX: git mismatch DID recreate during the window (must-FAIL anchor)', w.recreated === 1, `recreated=${w.recreated}`);
}
// B2 — once recovery flips ready, the REAL module recreates (the gate releases, not blocks forever).
{
  const w = world();
  const gr = await run(createGrantRebuild, w);
  check('REAL: held, not acted, while recovering', w.recreated === 0, `recreated=${w.recreated}`);
  w.leasesReadyVal = true;
  gr.tick();
  await flush(30);
  check('REAL: recreates the moment leasesReady flips true (released, not stranded)', w.recreated === 1, `recreated=${w.recreated}`);
}
// B3 — the credential reason is gated by the SAME guard (git clean, cred stale, window) → held, then acts.
{
  const w = world();
  w.actual = 'ro'; w.desired = 'ro'; w.cred = 'stale'; // git matches, only the credential is stale
  const gr = await run(createGrantRebuild, w);
  check('REAL: stale-cred recreate held during the window', w.recreated === 0, `recreated=${w.recreated}`);
  w.leasesReadyVal = true;
  gr.tick();
  await flush(30);
  check('REAL: stale-cred recreate fires once ready', w.recreated === 1, `recreated=${w.recreated}`);
}
// B4 — a user FORCE during the window does NOT bypass the gate; it is told explicitly.
{
  const w = world();
  const gr = await run(createGrantRebuild, w);
  const r = await gr.request('p1', { force: true });
  check('REAL: force during the window is refused (does not bypass the readiness gate)', w.recreated === 0 && /still recovering/.test(r.outcome), `recreated=${w.recreated} outcome=${r.outcome}`);
}
// B5 — no false hold: outside the window a git mismatch with idle sessions recreates normally.
{
  const w = world();
  w.leasesReadyVal = true;
  await run(createGrantRebuild, w);
  check('REAL: git mismatch recreates normally when ready + idle (no false hold)', w.recreated === 1, `recreated=${w.recreated}`);
}

try { fs.unlinkSync(preFile); } catch { /* best effort */ }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(`FAILURES: ${failures.join(', ')}`); process.exit(1); }
