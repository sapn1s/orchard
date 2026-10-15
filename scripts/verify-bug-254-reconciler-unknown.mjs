#!/usr/bin/env node
/**
 * BUG-254 r7 — P4: the idle reconciler (grant-rebuild.ts) must treat credential UNCERTAINTY as
 * benign WHEN GIT IS KNOWN TO MATCH — never recreate, never hold turns on an 'unknown' cred probe —
 * yet still recover (recreate when idle) once the drift is PROVEN stale.
 *
 * The r5 independent verify broke P4: a FAILED entry with git-matching + an 'unknown' cred probe
 * slid past a pending-only drive() guard and recreated (and held turns via the 'failed' phase).
 *
 * This drives the REAL module and a SYNTHESIZED pre-fix baseline, built by reverting EXACTLY the two
 * r6 fix hunks into a temp module (an explicitly-constructed pre-fix state — never `git show HEAD`,
 * which stops being pre-fix the moment the fix is committed). Every cred-uncertainty property must
 * show must-FAIL on the pre-fix module and PASS on the real one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MOD = path.join(ROOT, 'src/server/grant-rebuild.ts');
const src = fs.readFileSync(MOD, 'utf8');

/* -------- synthesize the pre-fix baseline by reverting the two r6 hunks -------- */
const HUNK_A_FIX = `      // BUG-254 r6 — PHASE-INDEPENDENT: when git is KNOWN to match (a0===d) and the credential is not
      // PROVEN stale (clean or 'unknown'), never recreate — in ANY phase. The r5 break was a FAILED entry
      // with git-matching + an 'unknown' cred probe sliding past a pending-only guard and recreating.
      // Invariant: credential UNCERTAINTY alone never recreates (nor, via the tick downgrade, holds turns)
      // WHEN GIT IS KNOWN TO MATCH. A real git mismatch (incl a0==='none') still has a0!==d and passes.
      if (a0 === d && !credStale) return;`;
const HUNK_A_PRE = `      if (e.phase === 'pending' && a0 === d && !credStale) return; // PRE-FIX: pending-only guard (r5 break)`;

const HUNK_B_FIX = `        if (d !== 'unknown' && a === d) {
          if (cred === 'clean') drop(e, 'resolved: the container now matches the grant');
          else if (cred === 'unknown') { e.phase = 'pending'; e.error = null; e.nextTryAt = 0; audit('pending', e, { from: 'failed', why: 'credential probe unknown while git matches' }); }
          // cred === 'stale': stays failed; drive() recreates on the proven drift
        }`;
const HUNK_B_PRE = `        if (d !== 'unknown' && a === d && !credActive) drop(e, 'resolved: the container now matches the grant'); // PRE-FIX: unknown keeps it failed`;

if (!src.includes(HUNK_A_FIX) || !src.includes(HUNK_B_FIX)) {
  console.log('FATAL: the fix hunks were not found verbatim — update this test to match the module.');
  process.exit(2);
}
const preSrc = src.replace(HUNK_A_FIX, HUNK_A_PRE).replace(HUNK_B_FIX, HUNK_B_PRE);
const preFile = path.join(os.tmpdir(), `grant-rebuild-prefix-${process.pid}.ts`);
fs.writeFileSync(preFile, preSrc);

const { createGrantRebuild } = await import(url.pathToFileURL(MOD).href);
const { createGrantRebuild: createPre } = await import(url.pathToFileURL(preFile).href);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
}
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/* -------- a fake world with controllable git + credential drift -------- */
function world(make) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bug254-p4-'));
  const w = {
    t: 1_000_000, desired: 'ro', actual: 'ro', cred: 'clean', leasesReady: true,
    sessions: [], recreates: 0, recreateThrows: false, logs: [],
  };
  const deps = {
    listProjects: () => [{ id: 'p', name: 'P', isolation: 'container' }],
    desiredOf: () => w.desired,
    readActual: () => w.actual,
    readCredDrift: () => w.cred,
    leasesReady: () => w.leasesReady,
    sessionsOf: () => w.sessions,
    leasesOf: () => [],
    deliveryBusy: () => false,
    reserve: () => () => {},
    recreate: async () => { w.recreates++; if (w.recreateThrows) { w.actual = 'unknown'; throw new Error('recreate failed (injected)'); } w.actual = w.desired; w.cred = 'clean'; },
    settled: () => {},
    logFile: path.join(tmp, 'gr.log.jsonl'),
    now: () => w.t, log: (s) => w.logs.push(s), leaseSettleMs: 10,
  };
  w.gr = make(deps);
  return w;
}
async function ticks(w, n = 2) { for (let i = 0; i < n; i++) { w.gr.tick(); await flush(); } }
const holds = (w) => !!w.gr.turnHoldOf('p');

/* ============ drive a world into a FAILED cred-recreate, then flip cred to 'unknown' ============ */
async function toFailedThenUnknown(make) {
  const w = world(make);
  // A git-driven rebuild that FAILS with the container unreadable afterwards -> phase 'failed'.
  w.desired = 'ro'; w.actual = 'rw'; w.cred = 'clean'; w.recreateThrows = true;
  await ticks(w, 2);                               // add pending (git) -> drive -> recreate throws, actual->unknown -> failed
  const failedPhase = w.gr._phaseOf('p');
  // The container returns MATCHING git (a0===d) but the credential probe is now UNREADABLE.
  w.actual = 'ro'; w.cred = 'unknown'; w.recreateThrows = false;
  await ticks(w, 1);                               // the failed-branch of tick() decides what to do with 'unknown'
  return { w, failedPhase };
}

/* ---- BREAK 1: does a FAILED entry with git-matching + unknown cred HOLD turns? ---- */
{
  const real = await toFailedThenUnknown(createGrantRebuild);
  const pre = await toFailedThenUnknown(createPre);
  check('precondition: both modules reached a FAILED cred-recreate', real.failedPhase === 'failed' && pre.failedPhase === 'failed', { real: real.failedPhase, pre: pre.failedPhase });
  check('FIX: unknown cred + git matching does NOT hold turns', !holds(real.w), real.w.gr.turnHoldOf('p'));
  check('MUST-FAIL BASELINE: the pre-fix module DOES hold turns on unknown (the r5 defect)', holds(pre.w), pre.w.gr.turnHoldOf('p'));
}

/* ---- BREAK 2: does a FAILED entry with git-matching + unknown cred RECREATE? ---- */
{
  const real = await toFailedThenUnknown(createGrantRebuild);
  const pre = await toFailedThenUnknown(createPre);
  // advance past any backoff and tick a few times; neither git nor cred asks for a recreate here
  real.w.t += 60_000; pre.w.t += 60_000;
  await ticks(real.w, 3); await ticks(pre.w, 3);
  check('FIX: unknown cred + git matching never recreates', real.w.recreates === 1, { recreates: real.w.recreates });
  check('MUST-FAIL BASELINE: the pre-fix module RECREATES on unknown (the r5 defect)', pre.w.recreates >= 2, { recreates: pre.w.recreates });
}

/* ---- RECOVERY (reviewer-required unknown->stale): once the drift is PROVEN stale, it still heals ---- */
{
  const { w } = await toFailedThenUnknown(createGrantRebuild);
  check('after downgrade: the entry is pending (reprobing), not failed', w.gr._phaseOf('p') === 'pending', w.gr._phaseOf('p'));
  const before = w.recreates;
  w.cred = 'stale';                                 // the probe now PROVES the bind is stale
  w.sessions = [];                                  // idle
  await ticks(w, 3);
  check('RECOVERY: a PROVEN stale bind still recreates when idle (unknown->stale heals)', w.recreates === before + 1 && w.actual === 'ro' && w.cred === 'clean', { recreates: w.recreates, cred: w.cred });
  check('…and after the heal nothing is held', !holds(w), w.gr.turnHoldOf('p'));
}

/* ---- NARROWED INVARIANT: unknown cred must NOT suppress a real GIT mismatch recreate ---- */
{
  const w = world(createGrantRebuild);
  w.desired = 'ro'; w.actual = 'rw'; w.cred = 'unknown'; w.sessions = []; // git mismatch + unreadable cred
  await ticks(w, 3);
  check('git mismatch + unknown cred: still recreates (the fix never strands a git retry)', w.recreates === 1 && w.actual === 'ro', { recreates: w.recreates, actual: w.actual });
}

try { fs.rmSync(preFile, { force: true }); } catch { /* best effort */ }
console.log(`\nRESULT ${pass} PASS / ${fail} FAIL${failures.length ? `\n  failed: ${failures.join(' | ')}` : ''}`);
process.exit(fail ? 1 : 0);
