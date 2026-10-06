#!/usr/bin/env node
/**
 * verify-bug-231-call-claims.mjs — BUG-231 / FEAT-164 fixing r5.
 *
 * PROPERTY: per-call claim state lives in the grant store, keyed by the call id, and a
 * call's withdrawn / lapsed state is TERMINAL for that call id. Time never turns a
 * denied call back into an undecided one: a written-out write of a withdrawn or lapsed
 * call is DENIED (never routed to the independent path), a call id is decided once
 * (reuse is denied), and only git with no live call record (Codex, a subprocess or
 * background git after the call ended) decides independently.
 *
 * The 5th break (verify run 01a10df8-9157-76b0-8c9b-bd5fb2cd70d9, probe ed70bc971ca6):
 * reapWindows dropped a WITHDRAWN window at CLAIM_MAX_MS while its call was still in
 * flight; the call's next written-out commit found no window, decided afresh, spent a
 * fresh mid-call re-grant and so denied a genuine new call.
 *
 * MUST-FAIL BASELINE (pinned bytes, never HEAD): scripts/fixtures/bug-231-r5/
 * pre-git-grant{,-store}.mjs — the tree that verifier broke (sha256 26a5fead… /
 * b67a220d…). In-process, no server, no git; the gate is an injected callback; the
 * clock is passed explicitly. Fixtures are SYNTHETIC (no real call runs past the lapse in
 * a test; the clock is injected), modelled on the verifier's own probe sequence.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'lib');
const FIX = path.join(HERE, 'fixtures', 'bug-231-r5');
const PINS = { 'pre-git-grant.mjs': '26a5fead15cd91d91c355d2b5ab940a521bad9ab5fcef3540dab6e71b28acbda',
  'pre-git-grant-store.mjs': 'b67a220d3ad016bc1a045516928c1673c813173b5f724e7f7d7bb24a0df297c8' };

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`); }
};
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
for (const [f, h] of Object.entries(PINS)) {
  const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(FIX, f))).digest('hex');
  if (got !== h) { console.log(`FAIL  pinned baseline ${f} changed (${got}) — the must-FAIL would be anchored to moving bytes`); process.exit(1); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bug231-r5-'));
let seq = 0;
async function loadVariant(tag, storeSrc, grantSrc) {
  const dir = path.join(tmp, `${tag}-${++seq}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'git-grant-store.mjs'), storeSrc);
  fs.writeFileSync(path.join(dir, 'git-grant.mjs'), grantSrc);
  fs.copyFileSync(path.join(LIB, 'git-write-policy.mjs'), path.join(dir, 'git-write-policy.mjs'));
  fs.copyFileSync(path.join(LIB, 'git-shim-secret.mjs'), path.join(dir, 'git-shim-secret.mjs'));
  const store = await import(pathToFileURL(path.join(dir, 'git-grant-store.mjs')).href);
  const grant = await import(pathToFileURL(path.join(dir, 'git-grant.mjs')).href);
  const secret = await import(pathToFileURL(path.join(dir, 'git-shim-secret.mjs')).href);
  return { tag, store, grant, secret };
}

const P = 'proj-r5';
const B = 'r5-binding-0123456789abcdef';
const MIN = 60_000;
const ok = () => ({ ok: true, detail: '' });
const FP = { head: 'h0', entries: ['README.md:aaa'] };
let tu = 0;
const T0 = 1_800_000_000_000;
const reset = (v) => { v.store._resetGitGrantsForTest(); v.grant._resetGitWriteWindowsForTest?.(); };
const hook = (v, command, { binding = B, now = T0, agentKey = 'main', toolUseId = `tu-${++tu}`, shim = true } = {}) => {
  v.grant.beginGitWriteToolCall({ binding, toolUseId, agentKey, now });
  const r = v.grant.evaluateGitWrite({ command, projectKey: P, env: {}, runLeakGate: ok, now, repoFingerprint: () => FP,
    window: { binding, toolUseId, agentKey, shimReachesCli: shim } });
  return { ...r, toolUseId };
};
const redeem = (v, argv, { binding = B, now = T0 } = {}) =>
  v.grant.redeemGitWrite({ binding, argv, projectKey: P, env: {}, runLeakGate: ok, now, repoFingerprint: () => FP });
const remaining = (v, now) => v.store.grantView(P, now)?.remainingUses ?? null;
/** Prove add/commit reach the shim for this binding, so a later hook DEFERS the spend. */
function warm(v, binding = B, now = T0) {
  v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60 * MIN, now });
  const h = hook(v, 'git add f && git commit -m w', { binding, now });
  redeem(v, ['add', 'f'], { binding, now }); redeem(v, ['commit', '-m', 'w'], { binding, now });
  v.grant.endGitWriteToolCall(binding, h.toolUseId, now);
  v.store.revokeGitWrite(P);
}

/* ── scenarios: each returns { held, detail } ─────────────────────────────────── */
const SC = {
  // THE 5th BREAK, verbatim shape: revoke mid-call → withdrawn; the clock crosses
  // CLAIM_MAX_MS; a fresh once-grant is issued; the SAME call's next written-out commit
  // must stay denied and must NOT spend the re-grant; a genuine new call then gets it.
  reapBoundary(v) {
    reset(v);
    v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60 * MIN, now: T0 });
    const h = hook(v, 'git commit -m first; git commit -m denied; git commit -m stale');
    const first = redeem(v, ['commit', '-m', 'first']);
    v.store.revokeGitWrite(P);
    const denied = redeem(v, ['commit', '-m', 'denied'], { now: T0 + 1000 });
    const late = T0 + v.store.CLAIM_MAX_MS + 1000;
    v.store.grantGitWrite(P, { scope: 'once', now: late });
    const stale = redeem(v, ['commit', '-m', 'stale'], { now: late });
    const left = remaining(v, late);
    v.grant.endGitWriteToolCall(B, h.toolUseId, late);
    const fresh = hook(v, 'git commit -m genuine', { now: late + 1 });
    return { held: first.allow && !denied.allow && !stale.allow && left === 1 && fresh.allow,
      detail: { first: first.allow, denied: denied.allow, stale: stale.allow, staleRedeemed: !!stale.redeemed, left, genuine: fresh.allow } };
  },
  // Withdrawn (revoked) call still in flight, long after the revoke (and under a
  // re-incarnated permanent grant, which survives anything a timed grant would not):
  // still denied IMMEDIATELY by the revoke, independent of the lapse bound.
  withdrawnPastFiveMinPermanent(v) {
    reset(v);
    let perm = { permanent: true, grantedAt: 'p1' };
    v.store.setPermanentGrantSource(() => perm);
    const h = hook(v, 'git commit -m a; git commit -m b; git commit -m c');
    const a = redeem(v, ['commit', '-m', 'a']);
    perm = null; v.store.revokeGitWrite(P);
    const b = redeem(v, ['commit', '-m', 'b'], { now: T0 + 1000 });
    perm = { permanent: true, grantedAt: 'p2' };
    const c = redeem(v, ['commit', '-m', 'c'], { now: T0 + 9 * MIN });
    const c2 = redeem(v, ['commit', '-m', 'c'], { now: T0 + 60 * MIN });
    v.grant.endGitWriteToolCall(B, h.toolUseId, T0 + 61 * MIN);
    const next = hook(v, 'git commit -m n', { now: T0 + 61 * MIN });
    return { held: a.allow && !b.allow && !c.allow && !c2.allow && next.allow,
      detail: { a: a.allow, b: b.allow, c9min: c.allow, c60min: c2.allow, nextCall: next.allow } };
  },
  // A LIVE (never revoked) deferred once-call that runs past CLAIM_MAX_MS lapses: its
  // later written-out write is DENIED (terminal), its reservation is freed, and a new
  // call can use the once-grant while the zombie stays denied.
  lapsedLiveCallTerminal(v) {
    reset(v); warm(v);
    v.store.grantGitWrite(P, { scope: 'once', now: T0 });
    const h = hook(v, 'git add f && git commit -m x', { agentKey: 'a1' });
    const late = T0 + v.store.CLAIM_MAX_MS + 1;
    const add = redeem(v, ['add', 'f'], { now: late });
    const other = hook(v, 'git commit -m y', { agentKey: 'a2', now: late + 1 });
    const zombie = redeem(v, ['commit', '-m', 'x'], { now: late + 2 });
    return { held: h.deferred === true && !add.allow && other.allow && !zombie.allow,
      detail: { deferred: h.deferred, lateAdd: add.allow, otherCall: other.allow, zombieCommit: zombie.allow } };
  },
  // BUG-231 r6, the OTHER side of the lapse boundary: a LIVE (never revoked) deferred
  // once-call whose write arrives LONGER than r5's old 5-min bound but still within a
  // single foreground Bash call's max duration is ALLOWED and spends — the ordinary
  // `npm test && git commit` with slow (~6 min) tests, which r5 wrongly denied. 6 min is
  // FIXED (not CLAIM_MAX_MS-relative) so it is past r5's old 5-min bound and inside r6's
  // raised bound; the five-min-bound mutant below BREAKS it (not vacuous), and a future
  // bound lowered below a legitimate call length would redden this check, which is the point.
  liveLongCallWithinBound(v) {
    reset(v); warm(v);
    v.store.grantGitWrite(P, { scope: 'once', now: T0 });
    const h = hook(v, 'git add f && git commit -m x', { agentKey: 'a1' });
    const within = T0 + 6 * MIN; // longer than r5's 5 min, within a Bash call's max duration
    const add = redeem(v, ['add', 'f'], { now: within });
    const commit = redeem(v, ['commit', '-m', 'x'], { now: within + 1 });
    const spent = v.store.grantView(P, within + 1) === null;
    return { held: h.deferred === true && add.allow && commit.allow && !!commit.redeemed && spent,
      detail: { deferred: h.deferred, add: add.allow, commit: commit.allow, redeemed: !!commit.redeemed, spent } };
  },
  // Orphan cleanup frees storage but the tombstone outlives any call: denied at 23h;
  // storage gone only after CALL_TOMBSTONE_MS.
  tombstoneOutlivesCalls(v) {
    reset(v);
    if (typeof v.store.callClaimState !== 'function') return { held: false, detail: 'no store-held call state (callClaimState absent)' };
    v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 6 * 60 * MIN, now: T0 });
    const h = hook(v, 'git commit -m a; git commit -m b');
    v.store.revokeGitWrite(P);
    redeem(v, ['commit', '-m', 'a'], { now: T0 + 1 });
    v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 6 * 60 * MIN, now: T0 + 2 });
    const at23h = redeem(v, ['commit', '-m', 'b'], { now: T0 + 23 * 60 * MIN });
    const st23 = v.store.callClaimState(B, h.toolUseId, T0 + 23 * 60 * MIN);
    const stGone = v.store.callClaimState(B, h.toolUseId, T0 + v.store.CALL_TOMBSTONE_MS + 1);
    return { held: !at23h.allow && st23 === 'withdrawn' && stGone === 'unknown' && v.store.CALL_TOMBSTONE_MS >= 60 * MIN,
      detail: { at23h: at23h.allow, st23, stGone, tombMs: v.store.CALL_TOMBSTONE_MS } };
  },
  // The store answers for an unknown call id: not valid, not usable.
  unknownCallId(v) {
    reset(v);
    if (typeof v.store.callClaimState !== 'function' || typeof v.store.useCallClaim !== 'function') return { held: false, detail: 'no store-held call state' };
    v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60 * MIN, now: T0 });
    const st = v.store.callClaimState(B, 'tu-never', T0);
    const use = v.store.useCallClaim(B, 'tu-never', T0);
    return { held: st === 'unknown' && use === false, detail: { st, use } };
  },
  // A call id is decided ONCE: a second PreToolUse carrying a withdrawn id, or an
  // ended id, is denied and spends nothing.
  callIdReuse(v) {
    reset(v);
    v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60 * MIN, now: T0 });
    const h = hook(v, 'git commit -m a; git commit -m b');
    redeem(v, ['commit', '-m', 'a']);
    v.store.revokeGitWrite(P);
    redeem(v, ['commit', '-m', 'b'], { now: T0 + 1 }); // → withdrawn
    v.store.grantGitWrite(P, { scope: 'once', now: T0 + 2 });
    const again = hook(v, 'git commit -m b', { toolUseId: h.toolUseId, now: T0 + 3 });
    const afterAgain = redeem(v, ['commit', '-m', 'b'], { now: T0 + 4 });
    const left1 = remaining(v, T0 + 4);
    v.grant.endGitWriteToolCall(B, h.toolUseId, T0 + 5);
    const ended = hook(v, 'git commit -m b', { toolUseId: h.toolUseId, now: T0 + 6 });
    const left2 = remaining(v, T0 + 6);
    const fresh = hook(v, 'git commit -m z', { now: T0 + 7 });
    return { held: !again.allow && !afterAgain.allow && left1 === 1 && !ended.allow && left2 === 1 && fresh.allow,
      detail: { reuseWithdrawn: again.allow, redeemAfter: afterAgain.allow, left1, reuseEnded: ended.allow, left2, freshCall: fresh.allow } };
  },
  // Server restart (in-process model: a FRESH module instance is a fresh host). The old
  // boot had a live and a withdrawn call. The new boot knows neither call, holds no
  // timed grant, and refuses the old shim's secret at the route — so neither old call
  // can write. (The route's secret check is the real-server gate; asserted here on the
  // module the route calls.)
  restart: null,
  // ANTI-REGRESSION, property 4: one call's written-out writes run on one once-grant;
  // the next call is denied.
  property4(v) {
    reset(v); warm(v);
    v.store.grantGitWrite(P, { scope: 'once', now: T0 });
    const h = hook(v, 'git add f && git commit -m x');
    const add = redeem(v, ['add', 'f']), commit = redeem(v, ['commit', '-m', 'x']);
    v.grant.endGitWriteToolCall(B, h.toolUseId, T0 + 1);
    const next = hook(v, 'git commit -m y', { now: T0 + 2 });
    return { held: h.allow && add.allow && commit.allow && !!commit.redeemed && !next.allow,
      detail: { hook: h.allow, add: add.allow, commit: commit.allow, next: next.allow } };
  },
  // BUG-231 r7 THE BREAK (verify run 01a10e18, probe 7f57e10c4704): a call id DENIED because
  // no grant existed must leave a TERMINAL tombstone, so a once-grant issued AFTER the deny
  // cannot let the SAME id retry (hook) or be redeemed by a shim write of the same call —
  // it must reach only the agent's NEXT Bash call (a new id).
  initiallyDeniedCallIdRetry(v) {
    reset(v);
    if (typeof v.store.callClaimState !== 'function') return { held: false, detail: 'no store-held call state' };
    // No grant for the project: the call id is denied.
    const first = hook(v, 'git commit -m x', { toolUseId: 'tu-deny' });
    const stateAfterDeny = v.store.callClaimState(B, 'tu-deny', T0);
    // A fresh once-grant arrives mid-call; a shim write of the SAME call must NOT steal it…
    v.store.grantGitWrite(P, { scope: 'once', now: T0 + 1 });
    const shimRetry = redeem(v, ['commit', '-m', 'x'], { now: T0 + 1 });
    // …and a repeat PreToolUse carrying the SAME id must stay denied.
    const retry = hook(v, 'git commit -m x', { toolUseId: 'tu-deny', now: T0 + 2 });
    const leftAfterRetry = remaining(v, T0 + 2);
    // The call ends; the once-grant reaches the agent's NEXT Bash call (new id).
    v.grant.endGitWriteToolCall(B, 'tu-deny', T0 + 3);
    const genuine = hook(v, 'git commit -m z', { toolUseId: 'tu-genuine', now: T0 + 4 });
    return {
      held: !first.allow && stateAfterDeny !== 'unknown' && !shimRetry.allow && !retry.allow && leftAfterRetry === 1 && genuine.allow,
      detail: { first: first.allow, stateAfterDeny, shimRetry: shimRetry.allow, retry: retry.allow, leftAfterRetry, genuine: genuine.allow },
    };
  },
  // ANTI-REGRESSION, the carve-out: git with no live call record decides independently
  // (Codex with no binding; a background/subprocess git after its call ended).
  independentCarveOut(v) {
    reset(v);
    v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60 * MIN, now: T0 });
    const codex = v.grant.redeemGitWrite({ binding: null, argv: ['commit', '-m', 'c'], projectKey: P, env: {}, runLeakGate: ok, now: T0 });
    const h = hook(v, 'git commit -m a');
    redeem(v, ['commit', '-m', 'a']);
    v.grant.endGitWriteToolCall(B, h.toolUseId, T0 + 1);
    const bg = redeem(v, ['commit', '-m', 'bg'], { now: T0 + 2 });
    return { held: codex.allow && bg.allow && !bg.redeemed, detail: { codex: codex.allow, background: bg.allow, bgRedeemed: !!bg.redeemed } };
  },
};

async function restartScenario(mk) {
  const oldBoot = await mk();
  reset(oldBoot);
  const oldBootAuth = oldBoot.secret.getShimSecret();
  oldBoot.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60 * MIN, now: T0 });
  const live = hook(oldBoot, 'git commit -m a; git commit -m b', { agentKey: 'm1' });
  const wd = hook(oldBoot, 'git push; git push', { agentKey: 'm2' });
  redeem(oldBoot, ['commit', '-m', 'a']); // live call used
  oldBoot.store.revokeGitWrite(P);
  redeem(oldBoot, ['push']); // → withdrawn (and the live one is now revoked too)
  const newBoot = await mk();
  const secretRefused = newBoot.secret.isShimSecretValid(oldBootAuth) === false;
  const noTimed = newBoot.store.grantView(P, T0 + 2) === null;
  const liveAfter = redeem(newBoot, ['commit', '-m', 'b'], { now: T0 + 2 });
  const wdAfter = redeem(newBoot, ['push'], { now: T0 + 2 });
  const st = typeof newBoot.store.callClaimState === 'function' ? newBoot.store.callClaimState(B, live.toolUseId, T0 + 2) : 'n/a';
  return { held: secretRefused && noTimed && !liveAfter.allow && !wdAfter.allow && live.allow && wd.allow,
    detail: { secretRefused, noTimed, liveAfter: liveAfter.allow, withdrawnAfter: wdAfter.allow, newBootCallState: st } };
}

const pre = await loadVariant('pre', read(FIX, 'pre-git-grant-store.mjs'), read(FIX, 'pre-git-grant.mjs'));
const cur = await loadVariant('cur', read(LIB, 'git-grant-store.mjs'), read(LIB, 'git-grant.mjs'));

// BUG-231 r7 — the no-tombstone-on-deny break lives in the POST-r6 code, so its must-FAIL
// baseline is a separate pin (scripts/fixtures/bug-231-r7: the clean-room bytes verify run
// 01a10e18 broke, sha256 0bb2dc53… / a299998c…).
const FIX7 = path.join(HERE, 'fixtures', 'bug-231-r7');
const PINS7 = { 'pre-git-grant.mjs': '0bb2dc53ec4ff80af852095bb7100b50da01872fff5b994b9eb84b13d41a68f0',
  'pre-git-grant-store.mjs': 'a299998c24fecb19ce2bc56199e3e77608c196f678d7f58885ad7001037f4dde' };
for (const [f, h] of Object.entries(PINS7)) {
  const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(FIX7, f))).digest('hex');
  if (got !== h) { console.log(`FAIL  pinned r7 baseline ${f} changed (${got})`); process.exit(1); }
}
const preR7 = await loadVariant('pre-r7', read(FIX7, 'pre-git-grant-store.mjs'), read(FIX7, 'pre-git-grant.mjs'));
{
  const r = SC.initiallyDeniedCallIdRetry(preR7);
  check('pre-r7: initiallyDeniedCallIdRetry BREAKS (no tombstone on a no-grant deny)', !r.held, r.detail);
  if (!r.held) console.log(`        (pre-r7 detail: ${JSON.stringify(r.detail)})`);
}

// MUST-FAIL on the pinned pre-change bytes: the break and the terminal-state properties.
const MUST_FAIL = ['reapBoundary', 'withdrawnPastFiveMinPermanent', 'lapsedLiveCallTerminal', 'tombstoneOutlivesCalls', 'unknownCallId', 'callIdReuse'];
console.log('MUST-FAIL on pinned pre-change bytes (scripts/fixtures/bug-231-r5):');
for (const k of MUST_FAIL) {
  const r = SC[k](pre);
  check(`pre: ${k} BREAKS`, !r.held, r.detail);
  if (!r.held) console.log(`        (pre detail: ${JSON.stringify(r.detail)})`);
}
console.log('Current tree:');
for (const [k, fn] of Object.entries(SC)) {
  if (!fn) continue;
  const r = fn(cur);
  check(`cur: ${k} holds`, r.held, r.detail);
}
// MUTANTS of the current tree, so the checks bite the r5 mechanism itself (not only r4 bytes):
//  - a withdrawn call no longer matches its write (i.e. "decide by the record's existence");
//  - the time sweep deletes not-ended records at CLAIM_MAX_MS (the 5th break, re-made in the store).
const curStoreSrc = read(LIB, 'git-grant-store.mjs');
function mutate(src, from, to, label) { if (!src.includes(from)) throw new Error(`mutant ${label}: anchor not found — vacuous`); return src.replace(from, to); }
const mutSkip = await loadVariant('mut-skipwithdrawn', mutate(curStoreSrc, "if (r.status !== 'ended' && r.projectKey === projectKey", "if (r.status === 'open' && r.projectKey === projectKey", 'skip'), read(LIB, 'git-grant.mjs'));
const mutReap = await loadVariant('mut-timereap', mutate(curStoreSrc, '    if (now - r.at >= CALL_TOMBSTONE_MS) {', '    if (now - r.at >= CLAIM_MAX_MS) {', 'reap'), read(LIB, 'git-grant.mjs'));
for (const [tag, v] of [['withdrawn-skipped', mutSkip], ['time-reap at CLAIM_MAX_MS', mutReap]]) {
  const r = SC.reapBoundary(v);
  check(`mutant (${tag}): reapBoundary BREAKS — the check is not vacuous`, !r.held, r.detail);
}
// r6 bound mutant: put the lapse back to r5's 5 min. A legitimate ~6-min call is then
// denied (the regression r6 fixes), so liveLongCallWithinBound BREAKS — the within-bound
// allow is not vacuous and is genuinely owned by the raised bound.
const mutFiveMin = await loadVariant('mut-fivemin',
  mutate(curStoreSrc, 'export const CLAIM_MAX_MS = BASH_MAX_TIMEOUT_MS + 5 * 60 * 1000; // 15 min',
    'export const CLAIM_MAX_MS = 5 * 60 * 1000; // r5 bound, for the must-FAIL', 'fivemin'),
  read(LIB, 'git-grant.mjs'));
{
  const r = SC.liveLongCallWithinBound(mutFiveMin);
  check('mutant (5-min bound): liveLongCallWithinBound BREAKS — a legitimate ~6-min call is denied', !r.held, r.detail);
}
const rs = await restartScenario(() => loadVariant('restart', read(LIB, 'git-grant-store.mjs'), read(LIB, 'git-grant.mjs')));
check('cur: restart (live + withdrawn calls) holds', rs.held, rs.detail);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
