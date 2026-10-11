#!/usr/bin/env node
/**
 * BUG-249 — the agent git-write leak-gate scan must not FREEZE the single-process server.
 *
 *   node scripts/verify-bug-249-gate-nonblocking.mjs [--big-repo=<path>] [--slow-ms=<n>]
 *
 * Two things are proven, both against the REAL decision functions in scripts/lib/git-grant.mjs:
 *
 *  (1) RESPONSIVENESS (the headline, with its must-FAIL baseline). The gate is injected as a
 *      runner that takes real wall time. The SYNCHRONOUS composition `evaluateGitWrite` with an
 *      execFileSync runner is EXACTLY the pre-fix behaviour (the runtime used to call the sync
 *      decision + execFileSync); it FREEZES the event loop for the whole scan — this is the
 *      synthesized pre-fix must-FAIL, not anchored to any moving revision. The ASYNC composition
 *      `evaluateGitWriteAsync` with an execFile runner keeps the loop turning. We measure the
 *      largest gap between ticks of a 40ms interval while each decision runs — in-process, i.e.
 *      the very loop the server runs the gate on. With --big-repo=<path> the runner is the REAL
 *      scripts/leak-gate.mjs over that repo (a real ~4.6s scan on a 1.7G tree); without it, a
 *      controlled ~900ms slow subprocess fixture (clearly synthetic, documented).
 *
 *  (2) SEMANTICS the async gate newly exposes (the independent plan review's findings), driven by
 *      Promise barriers so the interleavings are deterministic: fail-closed on a sync throw / a
 *      rejected promise / a non-zero verdict / a missing runner (and the sync path refusing a
 *      stray promise); the once-grant RESERVE still blocks a concurrent claim before the gate; a
 *      concurrent redeem of ONE window slot yields exactly one allow; a redeem of a hook window
 *      whose gate has not finished is refused; a revoke landing mid-gate denies at the spend; and
 *      a repo fingerprint that is UNSTABLE across the scan is not cached (the shim re-gates).
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  evaluateGitWrite, evaluateGitWriteAsync, redeemGitWriteAsync, _resetGitWriteWindowsForTest,
} from './lib/git-grant.mjs';
import { grantGitWrite, revokeGitWrite, _resetGitGrantsForTest } from './lib/git-grant-store.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.resolve(import.meta.dirname, '..');
const SLOW_GATE = path.join(HERE, 'scripts', 'fixtures', 'bug-249', 'slow-gate.mjs');
const LEAK_GATE = path.join(HERE, 'scripts', 'leak-gate.mjs');
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const BIG_REPO = arg('big-repo');
const SLOW_MS = Number(arg('slow-ms') ?? '900');
const K = 'bug249-proj';

let pass = 0, fail = 0; const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('until: timed out'); await sleep(5); }
}
function reset() { _resetGitGrantsForTest(); _resetGitWriteWindowsForTest(); }

/** A gate whose two invocations (hook pre-gate, hook post-gate / redeem) block on a shared
 * barrier, so a test can hold every concurrent decision inside the gate at once. */
function barrierGate(result = { ok: true, detail: '' }) {
  let release; const gate = new Promise((r) => { release = r; });
  let entered = 0;
  return { run: async () => { entered += 1; await gate; return result; }, release: () => release(), entered: () => entered };
}

/**
 * How long (ms) a timer that should fire IMMEDIATELY is delayed while `fn` runs — i.e. how
 * long the event loop is frozen. A synchronous `fn` (execFileSync) blocks the whole turn, so
 * the 0ms timer cannot fire until it returns → the delay ≈ the scan's wall time. An async
 * `fn` (execFile) yields, so the timer fires within a few ms regardless of the scan length.
 * (A continuous interval cannot measure the synchronous case — a total freeze starves the
 * interval of the event-loop turn it needs to tick, so it records nothing.)
 */
async function loopFreeze(fn) {
  const scheduledAt = performance.now();
  let firedAt = null;
  const probe = new Promise((res) => { setTimeout(() => { firedAt = performance.now(); res(); }, 0); });
  await fn();
  await probe;
  return firedAt - scheduledAt;
}

/* ─────────────────────────── (1) RESPONSIVENESS ─────────────────────────── */
async function responsiveness() {
  console.log(`\n===== (1) responsiveness — ${BIG_REPO ? `REAL leak-gate over ${BIG_REPO === path.basename(BIG_REPO) ? BIG_REPO : '(real repo)'}` : `synthetic ${SLOW_MS}ms gate fixture`} =====`);
  const gateArgs = BIG_REPO ? [LEAK_GATE, '--summary'] : [SLOW_GATE, '--summary'];
  const cwd = BIG_REPO ? path.resolve(BIG_REPO) : HERE;
  const env = { ...process.env, SLOW_GATE_MS: String(SLOW_MS) };
  const syncRunner = () => {
    try { execFileSync(process.execPath, gateArgs, { cwd, env, stdio: 'pipe', timeout: 30_000 }); return { ok: true, detail: '' }; }
    catch (e) { return { ok: false, detail: String((e && e.message) || e) }; }
  };
  const asyncRunner = async () => {
    try { await execFileAsync(process.execPath, gateArgs, { cwd, env, timeout: 30_000 }); return { ok: true, detail: '' }; }
    catch (e) { return { ok: false, detail: String((e && e.message) || e) }; }
  };

  // Pre-fix behaviour: synchronous decision + blocking gate. This is the must-FAIL baseline.
  reset(); grantGitWrite(K, { scope: 'duration' });
  const t0 = performance.now();
  const syncFreeze = await loopFreeze(async () => { evaluateGitWrite({ command: 'git push', projectKey: K, runLeakGate: syncRunner }); });
  const syncWall = performance.now() - t0;
  // The fix: async decision + non-blocking gate.
  reset(); grantGitWrite(K, { scope: 'duration' });
  const t1 = performance.now();
  let asyncAllow;
  const asyncFreeze = await loopFreeze(async () => { asyncAllow = (await evaluateGitWriteAsync({ command: 'git push', projectKey: K, runLeakGate: asyncRunner })).allow; });
  const asyncWall = performance.now() - t1;

  const floor = Math.max(300, syncWall * 0.6); // the freeze must be most of the scan
  check('pre-fix (sync execFileSync) FREEZES the loop for ~the whole scan [must-FAIL baseline]',
    syncFreeze >= floor, { syncFreezeMs: Math.round(syncFreeze), syncWallMs: Math.round(syncWall), floorMs: Math.round(floor) });
  check('fix (async execFile) keeps the loop responsive during the same scan',
    asyncFreeze < 250, { asyncFreezeMs: Math.round(asyncFreeze), asyncWallMs: Math.round(asyncWall) });
  // With --big-repo the real gate may legitimately find hits (allow=false) — the timing is
  // the point there; with the clean synthetic fixture the decision must be allow.
  check('fix still RAN the gate for roughly the same wall time (it did not short-circuit)',
    asyncWall >= syncWall * 0.5 && (BIG_REPO ? true : asyncAllow === true), { asyncWallMs: Math.round(asyncWall), syncWallMs: Math.round(syncWall), allow: asyncAllow });
}

/* ──────── (1b) WHOLE decide/hook path responsiveness — BUG-249 r2 (P1 re-break) ────────
 * Round 1 moved the leak-gate SCAN off-loop but left `repoContentFingerprint` synchronous —
 * and the hook/shim take it PRE- and POST-gate, so a push on a big repo still froze the loop
 * ~930ms (the independent verify's P1 break). This test drives the REAL async decision
 * compositions with a REAL (or realistic) fingerprint reader and measures the freeze over the
 * WHOLE call, for BOTH a publishing write (push → full-tree scope) and a non-publishing one
 * (commit → narrow scope), on the hook AND the redeem(/decide) path. The must-FAIL baseline is
 * the ROUND-1 STATE itself: async gate + SYNCHRONOUS fingerprint. The gate is async in BOTH
 * variants (round 1 already fixed that); ONLY the fingerprint differs, so the test isolates the
 * r2 fix. With --big-repo it injects leak-gate-host's REAL repoContentFingerprint(Async) over
 * that tree; without it, a realistic ~SLOW_MS git-subprocess cost stands in (documented synthetic). */
async function wholePathResponsiveness() {
  const label = BIG_REPO ? 'REAL fingerprint + gate over the real repo' : `synthetic ${SLOW_MS}ms fingerprint + gate (no --big-repo)`;
  console.log(`\n===== (1b) WHOLE decide/hook path responsiveness — ${label} =====`);
  const cwd = BIG_REPO ? path.resolve(BIG_REPO) : HERE;
  const env = { ...process.env, SLOW_GATE_MS: String(SLOW_MS) };
  const gateArgs = BIG_REPO ? [LEAK_GATE, '--summary'] : [SLOW_GATE, '--summary'];
  // The GATE is async in BOTH variants — round 1 already made the scan async. Only the
  // FINGERPRINT differs below, so any freeze is attributable to the fingerprint alone.
  const asyncGate = async () => { try { await execFileAsync(process.execPath, gateArgs, { cwd, env, timeout: 30_000 }); return { ok: true, detail: '' }; } catch (e) { return { ok: false, detail: String((e && e.message) || e) }; } };

  let syncFp, asyncFp, fpKind;
  if (BIG_REPO) {
    const host = await import('../src/server/leak-gate-host.ts'); // Node strips the TS types
    syncFp = () => host.repoContentFingerprint(cwd);              // the round-1 (synchronous) reader
    asyncFp = () => host.repoContentFingerprintAsync(cwd);        // the r2 off-loop reader
    fpKind = 'REAL repoContentFingerprint(Async)';
  } else {
    const FP = { head: 'h', entries: ['a:1'], gateKey: 'k' };
    // Stand in for the big-tree git cost (ls-files + hash-object) as a ~SLOW_MS subprocess:
    // execFileSync blocks the loop (the round-1 fingerprint); execFile yields (the r2 fix).
    syncFp = () => { try { execFileSync(process.execPath, [SLOW_GATE, '--summary'], { cwd: HERE, env, stdio: 'pipe', timeout: 30_000 }); } catch { /* cost only */ } return FP; };
    asyncFp = async () => { try { await execFileAsync(process.execPath, [SLOW_GATE, '--summary'], { cwd: HERE, env, timeout: 30_000 }); } catch { /* cost only */ } return FP; };
    fpKind = 'synthetic git-subprocess cost';
  }
  const win = (tag) => ({ binding: `b-${tag}-${Math.random().toString(36).slice(2)}`, toolUseId: `t-${tag}-${Math.random().toString(36).slice(2)}`, agentKey: 'main', shimReachesCli: true });
  // Size-independent baseline: the SYNC fingerprint must freeze the loop both absolutely
  // (≥ MIN_FREEZE — a real, user-visible stall) AND relatively (≥ RATIO× the async path),
  // so the claim holds whether the real repo's working-tree diff is large (~hundreds of ms)
  // or small (~tens). The async path must stay RESPONSIVE (< RESPONSIVE_MS) regardless.
  const MIN_FREEZE = 40, RATIO = 5, RESPONSIVE_MS = 50;
  const froze = (sync, asyncv) => sync >= MIN_FREEZE && sync >= RATIO * Math.max(asyncv, 1);

  // ── the HOOK path (evaluateGitWriteAsync): fingerprint runs pre- AND post-gate ──
  for (const [verb, cmd, kind] of [['push', 'git push', 'publishing/full-tree'], ['commit', 'git commit -m x', 'non-publishing/narrow']]) {
    reset(); grantGitWrite(K, { scope: 'duration' });
    const r1 = await loopFreeze(async () => { await evaluateGitWriteAsync({ command: cmd, projectKey: K, runLeakGate: asyncGate, repoFingerprint: syncFp, window: win(verb) }); });
    reset(); grantGitWrite(K, { scope: 'duration' });
    const r2 = await loopFreeze(async () => { await evaluateGitWriteAsync({ command: cmd, projectKey: K, runLeakGate: asyncGate, repoFingerprint: asyncFp, window: win(verb) }); });
    check(`[hook ${verb} — ${kind}] SYNC fingerprint FREEZES the loop (round-1 state, ${fpKind}) [must-FAIL baseline]`, froze(r1, r2), { syncFreezeMs: Math.round(r1), asyncFreezeMs: Math.round(r2), ratio: +(r1 / Math.max(r2, 1)).toFixed(1) });
    check(`[hook ${verb} — ${kind}] async fingerprint keeps the loop responsive over the whole decision`, r2 < RESPONSIVE_MS, { freezeMs: Math.round(r2) });
  }

  // ── the REDEEM/decide path (redeemGitWriteAsync): the skip-check fingerprint runs once ──
  let redeemSync = 0;
  for (const [tag, fp, mustFreeze] of [['sync-round1', syncFp, true], ['async-fix', asyncFp, false]]) {
    reset(); grantGitWrite(K, { scope: 'duration' });
    const binding = `br-${tag}-${Math.random().toString(36).slice(2)}`, toolUseId = `tr-${tag}`;
    // Decide the window cheaply (trivial gate + fast async fingerprint), then measure the redeem.
    await evaluateGitWriteAsync({ command: 'git push', projectKey: K, runLeakGate: async () => ({ ok: true }), repoFingerprint: async () => ({ head: 'setup', entries: [], gateKey: 'k' }), window: { binding, toolUseId, agentKey: 'main', shimReachesCli: true } });
    const fr = await loopFreeze(async () => { await redeemGitWriteAsync({ binding, argv: ['push'], projectKey: K, runLeakGate: asyncGate, repoFingerprint: fp }); });
    if (mustFreeze) { redeemSync = fr; }
    else check(`[redeem push] SYNC fingerprint FROZE the /decide loop ${Math.round(redeemSync)}ms; the async fingerprint stays responsive`, fr < RESPONSIVE_MS && froze(redeemSync, fr), { syncFreezeMs: Math.round(redeemSync), asyncFreezeMs: Math.round(fr) });
  }
}

/* ─────────────────────────── (2) SEMANTICS ─────────────────────────── */
async function failClosed() {
  console.log('\n===== (2a) fail-closed =====');
  reset(); grantGitWrite(K, { scope: 'duration' });
  const thrown = await evaluateGitWriteAsync({ command: 'git push', projectKey: K, runLeakGate: () => { throw new Error('boom'); } });
  check('async gate that THROWS synchronously → deny', thrown.allow === false && thrown.gateFailed === true, thrown.reason?.slice(0, 40));
  const rejected = await evaluateGitWriteAsync({ command: 'git push', projectKey: K, runLeakGate: async () => { throw new Error('rejected'); } });
  check('async gate that REJECTS → deny', rejected.allow === false && rejected.gateFailed === true, rejected.reason?.slice(0, 40));
  const failed = await evaluateGitWriteAsync({ command: 'git push', projectKey: K, runLeakGate: async () => ({ ok: false, detail: 'leak found' }) });
  check('async gate that returns {ok:false} → deny + record blocked-gate', failed.allow === false && failed.record?.outcome === 'blocked-gate', { outcome: failed.record?.outcome });
  const missing = await evaluateGitWriteAsync({ command: 'git push', projectKey: K, runLeakGate: null });
  check('missing runner on the async path → deny', missing.allow === false, missing.reason?.slice(0, 40));
  const stray = evaluateGitWrite({ command: 'git push', projectKey: K, runLeakGate: () => Promise.resolve({ ok: true }) });
  check('SYNC path handed a promise-returning gate → deny (never trusts the pending promise)', stray.allow === false, stray.reason?.slice(0, 40));
  // non-publishing writes still do not gate at all (scope unchanged)
  reset(); grantGitWrite(K, { scope: 'duration' });
  let ran = 0;
  const addRes = await evaluateGitWriteAsync({ command: 'git add .', projectKey: K, runLeakGate: async () => { ran += 1; return { ok: true }; } });
  check('an exempt write (git add) still never runs the gate', addRes.allow === true && ran === 0, { allow: addRes.allow, ran });
}

async function reservation() {
  console.log('\n===== (2b) the once-grant RESERVE blocks a concurrent claim before the gate =====');
  reset(); grantGitWrite(K, { scope: 'once' });
  const b = barrierGate();
  const p1 = evaluateGitWriteAsync({ command: 'git push', projectKey: K, runLeakGate: b.run });
  await until(() => b.entered() === 1);
  const r2 = await evaluateGitWriteAsync({ command: 'git push', projectKey: K, runLeakGate: b.run }); // must deny WITHOUT entering the gate
  b.release();
  const r1 = await p1;
  check('two concurrent once-grant decisions → exactly one allow; the loser never reached the gate',
    r1.allow === true && r2.allow === false && b.entered() === 1, { r1: r1.allow, r2: r2.allow, entered: b.entered() });
}

async function redeemSlotRace() {
  console.log('\n===== (2c) a concurrent redeem of ONE window slot → exactly one allow =====');
  reset(); grantGitWrite(K, { scope: 'duration' });
  const binding = 'bind-slot', toolUseId = 't-slot';
  // The hook decides the Bash call (one `git push` → one slot). Sync setup with a trivial gate.
  evaluateGitWrite({ command: 'git push', projectKey: K, runLeakGate: () => ({ ok: true }), window: { binding, toolUseId, agentKey: 'main', shimReachesCli: true } });
  const b = barrierGate();
  const pr1 = redeemGitWriteAsync({ binding, argv: ['push'], projectKey: K, runLeakGate: b.run });
  await until(() => b.entered() === 1);
  const pr2 = redeemGitWriteAsync({ binding, argv: ['push'], projectKey: K, runLeakGate: b.run });
  await until(() => b.entered() === 2); // BOTH matched the single slot → the race window is real
  b.release();
  const [a1, a2] = await Promise.all([pr1, pr2]);
  const allows = [a1.allow, a2.allow].filter(Boolean).length;
  check('both redeems entered the gate, but exactly ONE is allowed (slot consumed atomically at the spend)',
    allows === 1 && b.entered() === 2, { a1: a1.allow, a2: a2.allow, entered: b.entered() });
}

async function pendingHook() {
  console.log('\n===== (2d) a hook window whose gate has NOT finished is not redeemable =====');
  reset(); grantGitWrite(K, { scope: 'duration' });
  const binding = 'bind-pending', toolUseId = 't-pending';
  const b = barrierGate();
  const pHook = evaluateGitWriteAsync({ command: 'git push', projectKey: K, runLeakGate: b.run, window: { binding, toolUseId, agentKey: 'main', shimReachesCli: true } });
  await until(() => b.entered() === 1); // the hook is inside its gate; the call is open, mode 'pending'
  const rRedeem = await redeemGitWriteAsync({ binding, argv: ['push'], projectKey: K, runLeakGate: async () => ({ ok: true }) });
  check('a concurrent redeem while the hook gate is in flight → deny (pending guard)', rRedeem.allow === false, rRedeem.reason?.slice(0, 40));
  b.release();
  const rHook = await pHook;
  check('the hook itself still allows once its gate completes', rHook.allow === true, { allow: rHook.allow });
}

async function revokeMidGate() {
  console.log('\n===== (2e) a revoke landing mid-gate denies at the spend =====');
  reset(); grantGitWrite(K, { scope: 'duration' });
  const b = barrierGate();
  const p = evaluateGitWriteAsync({ command: 'git push', projectKey: K, runLeakGate: b.run });
  await until(() => b.entered() === 1);
  revokeGitWrite(K); // bumps the revocation generation while the gate is suspended
  b.release();
  const r = await p;
  check('a write whose grant was revoked during its gate is denied (FEAT-164 r4, mid-gate)', r.allow === false, r.reason?.slice(0, 40));
}

async function fingerprintStability() {
  console.log('\n===== (2f) a repo fingerprint UNSTABLE across the scan is not cached (shim re-gates) =====');
  // STABLE: pre == post → gatedFp cached → the redeem SKIPS its re-gate.
  reset(); grantGitWrite(K, { scope: 'duration' });
  let runs = 0; const g = async () => { runs += 1; return { ok: true }; };
  const FP = { head: 'h1', entries: ['a:1'], gateKey: 'k1' };
  const b1 = { binding: 'fp-stable', toolUseId: 't1' };
  await evaluateGitWriteAsync({ command: 'git push', projectKey: K, runLeakGate: g, repoFingerprint: () => FP, window: { ...b1, agentKey: 'main', shimReachesCli: true } });
  const rs = await redeemGitWriteAsync({ binding: b1.binding, argv: ['push'], projectKey: K, runLeakGate: g, repoFingerprint: () => FP });
  check('stable fingerprint: hook gated once, the redeem SKIPS the gate', runs === 1 && rs.allow === true, { gateRuns: runs });

  // UNSTABLE: the fingerprint read pre-gate differs from post-gate (content changed during the
  // async scan) → gatedFp is NOT cached → the redeem must re-gate.
  reset(); grantGitWrite(K, { scope: 'duration' });
  runs = 0;
  const seq = [{ head: 'h1', entries: ['a:1'], gateKey: 'k1' }, { head: 'h2', entries: ['a:1'], gateKey: 'k1' }];
  let i = 0; const unstable = () => seq[Math.min(i++, seq.length - 1)];
  const b2 = { binding: 'fp-unstable', toolUseId: 't2' };
  await evaluateGitWriteAsync({ command: 'git push', projectKey: K, runLeakGate: g, repoFingerprint: unstable, window: { ...b2, agentKey: 'main', shimReachesCli: true } });
  const ru = await redeemGitWriteAsync({ binding: b2.binding, argv: ['push'], projectKey: K, runLeakGate: g, repoFingerprint: () => ({ head: 'h2', entries: ['a:1'], gateKey: 'k1' }) });
  check('unstable fingerprint: hook gated once, the redeem RE-GATES (no false skip)', runs === 2 && ru.allow === true, { gateRuns: runs });

  // BUG-249 r2 — the fingerprint reader the RUNTIME injects is now ASYNC (returns a promise).
  // The decision must AWAIT it and USE the resolved value, else gatedFp is dropped and every
  // redeem re-gates. On the round-1 code (safeFingerprint, no await) an async reader resolves
  // to null → no skip → this FAILS; the r2 safeFingerprintAsync makes it hold.
  reset(); grantGitWrite(K, { scope: 'duration' });
  runs = 0;
  const FPA = { head: 'ha', entries: ['a:1'], gateKey: 'ka' };
  const asyncReader = async () => { await sleep(1); return FPA; };
  const b3 = { binding: 'fp-async', toolUseId: 't3' };
  await evaluateGitWriteAsync({ command: 'git push', projectKey: K, runLeakGate: g, repoFingerprint: asyncReader, window: { ...b3, agentKey: 'main', shimReachesCli: true } });
  const ra = await redeemGitWriteAsync({ binding: b3.binding, argv: ['push'], projectKey: K, runLeakGate: g, repoFingerprint: asyncReader });
  check('ASYNC fingerprint reader is awaited + its result cached: stable → the redeem SKIPS the gate', runs === 1 && ra.allow === true, { gateRuns: runs });
}

/* ──────── (3) WIRING PINS — the runtime/route inject the ASYNC fingerprint reader ──────── */
async function wiringPins() {
  console.log('\n===== (3) wiring PINs — runtime + /decide inject the async, off-loop fingerprint =====');
  const rt = fs.readFileSync(path.join(HERE, 'src/server/runtime/claude-runtime.ts'), 'utf8');
  const idx = fs.readFileSync(path.join(HERE, 'src/server/index.ts'), 'utf8');
  // Anti-tamper: require repoContentFingerprintAsync as the injected reader AND forbid the
  // synchronous repoContentFingerprint( call site — reverting either door reopens the P1 freeze.
  check('PIN: the hook injects repoContentFingerprintAsync (not the sync reader)',
    /repoFingerprint:\s*\(\)\s*=>\s*repoContentFingerprintAsync\(/.test(rt) && !/repoFingerprint:\s*\(\)\s*=>\s*repoContentFingerprint\(/.test(rt), { ok: true });
  check('PIN: /api/git-shim/decide injects repoContentFingerprintAsync (not the sync reader)',
    /repoFingerprint:\s*\(\)\s*=>\s*repoContentFingerprintAsync\(/.test(idx) && !/repoFingerprint:\s*\(\)\s*=>\s*repoContentFingerprint\(/.test(idx), { ok: true });
  // The async gate also resolves own-project off-loop (the last sync git child on the path).
  check('PIN: the async gate resolves own-project off-loop (ownProjectArgsAsync)',
    /await\s+ownProjectArgsAsync\(/.test(rt), { ok: true });
}

async function main() {
  await responsiveness();
  await wholePathResponsiveness();
  await failClosed();
  await reservation();
  await redeemSlotRace();
  await pendingHook();
  await revokeMidGate();
  await fingerprintStability();
  await wiringPins();
  console.log(`\nBUG-249: ${pass} passed, ${fail} failed${fail ? ` — ${failures.join('; ')}` : ''}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
