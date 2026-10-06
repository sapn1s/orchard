#!/usr/bin/env node
/**
 * verify-feat-164-store-authority.mjs — FEAT-164 r4 / BUG-231.
 *
 * PROPERTY: the grant store is the ONLY authority for an agent git write. Nothing
 * else (the BUG-231 per-call window, the hook, the shim, a claim object) holds an
 * allow; they hold a claim HANDLE, and every write is authorised by asking the store
 * at the moment of the write (useClaim). Revocation and expiry always win; a
 * once-grant is spent at most once; one Bash call is decided once.
 *
 * It broke three times, each time through an authorisation held outside the store:
 *   b1 — consume re-read permanent after a mid-gate revoke and spent an independent
 *        once-grant (run 01a10ba1-8393-7e23-9ba1-a14a63e1e6f9);
 *   b2 — a re-entrant decision in the gate double-spent one once-grant
 *        (run 01a10bbd-44d2-7420-8d4e-e1e73b939a22);
 *   b3 — the call window kept authorising after a revoke
 *        (run 01a10ca5-0fb3-7032-a8c0-5374865424e8).
 *
 * MUST-FAIL BASELINES (pinned bytes, never HEAD):
 *   r4pre — scripts/fixtures/feat-164-r4/pre-git-grant{,-store}.mjs (sha256 a8c96222… /
 *           4088fed3…): the tree the b3 verifier broke.
 *   r2    — scripts/fixtures/feat-164/r2-git-grant{,-store}.mjs (b2's tree); r1 is
 *           synthesized from it by restoring round 1's re-reading consume (b1).
 *   mutant — the current tree with the redeem's store question removed, so the
 *           structural 1:1 check is shown to bite.
 * In-process, no server, no git; the gate is an injected callback. The real-server
 * revoke-mid-call check is S11 in scripts/verify-bug-231-one-decision.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LIB = path.join(HERE, 'lib');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat164-r4-'));
let seq = 0;
async function loadVariant(tag, storeSrc, grantSrc) {
  const dir = path.join(tmp, `${tag}-${++seq}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'git-grant-store.mjs'), storeSrc);
  fs.writeFileSync(path.join(dir, 'git-grant.mjs'), grantSrc);
  fs.copyFileSync(path.join(LIB, 'git-write-policy.mjs'), path.join(dir, 'git-write-policy.mjs'));
  const store = await import(pathToFileURL(path.join(dir, 'git-grant-store.mjs')).href);
  const grant = await import(pathToFileURL(path.join(dir, 'git-grant.mjs')).href);
  return { tag, store, grant };
}
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
function mutate(src, from, to, label) {
  if (!src.includes(from)) throw new Error(`mutant ${label}: anchor not found — it would be vacuous`);
  return src.replace(from, to);
}

const F164 = path.join(HERE, 'fixtures', 'feat-164');
const F164R4 = path.join(HERE, 'fixtures', 'feat-164-r4');
const r2Store = read(F164, 'r2-git-grant-store.mjs'), r2Grant = read(F164, 'r2-git-grant.mjs');
const C0 = r2Store.indexOf('export function consumeGrant(');
const R2_CONSUME = r2Store.slice(C0, r2Store.indexOf('/**', C0));
const r1Store = r2Store.replace(R2_CONSUME, `export function consumeGrant(projectKey, now = Date.now()) {
  if (permanentGrantOf(projectKey)) return;
  const g = grants.get(projectKey);
  if (!g || g.scope === 'duration') return;
  g.remainingUses -= 1;
  if (g.remainingUses <= 0 || now >= g.expiresAt) grants.delete(projectKey);
}

`);
const r1Grant = r2Grant.replace('consumeGrant(grant, now);', 'consumeGrant(projectKey, now);');
if (C0 < 0 || r1Store === r2Store || r1Grant === r2Grant) { console.log('FAIL  could not synthesize r1 from the r2 fixture'); process.exit(1); }

const curStore = read(LIB, 'git-grant-store.mjs'), curGrant = read(LIB, 'git-grant.mjs');
const r1 = await loadVariant('r1', r1Store, r1Grant);
const r2 = await loadVariant('r2', r2Store, r2Grant);
const pre = await loadVariant('r4pre', read(F164R4, 'pre-git-grant-store.mjs'), read(F164R4, 'pre-git-grant.mjs'));
const cur = await loadVariant('cur', curStore, curGrant);
const noAsk = await loadVariant('mut-noask', curStore,
  mutate(curGrant, '  if (!useCallClaim(binding, call.toolUseId, clock())) {', '  if (false) {', 'noask'));

const P = 'proj-r4';
const B = 'r4-binding-0123456789abcdef';
const ok = () => ({ ok: true, detail: '' });
const FP = { head: 'h0', entries: ['README.md:aaa'] };
let tu = 0;
const reset = (v) => { v.store._resetGitGrantsForTest(); v.grant._resetGitWriteWindowsForTest?.(); };
const hook = (v, command, { gate = ok, binding = B, now, shim = true, agentKey = 'main' } = {}) => {
  const toolUseId = `tu-${++tu}`;
  v.grant.beginGitWriteToolCall?.({ binding, toolUseId, agentKey, now });
  const r = v.grant.evaluateGitWrite({ command, projectKey: P, env: {}, runLeakGate: gate, now, repoFingerprint: () => FP,
    window: { binding, toolUseId, agentKey, shimReachesCli: shim } });
  return { ...r, toolUseId };
};
const redeem = (v, argv, { gate = ok, binding = B, now, fp = () => FP } = {}) => v.grant.redeemGitWrite
  ? v.grant.redeemGitWrite({ binding, argv, projectKey: P, env: {}, runLeakGate: gate, now, repoFingerprint: fp })
  : v.grant.evaluateGitWrite({ argv, projectKey: P, env: {}, runLeakGate: gate, now });
const endCall = (v, id, binding = B) => v.grant.endGitWriteToolCall?.(binding, id);
/** Prove add/commit reach the shim for this binding (so a later hook defers the spend). */
function warm(v, binding = B) {
  v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 });
  const h = hook(v, 'git add f && git commit -m w', { binding });
  redeem(v, ['add', 'f'], { binding }); redeem(v, ['commit', '-m', 'w'], { binding });
  endCall(v, h.toolUseId, binding);
  v.store.revokeGitWrite(P);
}
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/* ── scenarios: each returns { held, detail } ─────────────────────────────────── */
const SC = {
  // b1 — permanent revoked mid-gate must not spend an independent once-grant.
  b1(v) {
    reset(v);
    let perm = true; v.store.setPermanentGrantSource(() => (perm ? { permanent: true, grantedAt: 'x' } : null));
    v.store.grantGitWrite(P, { scope: 'once' });
    v.grant.evaluateGitWrite({ command: 'git commit -m x', projectKey: P, env: {}, runLeakGate: () => { perm = false; return ok(); } });
    const next = v.grant.evaluateGitWrite({ command: 'git commit -m x', projectKey: P, env: {}, runLeakGate: ok });
    const after = v.grant.evaluateGitWrite({ command: 'git commit -m x', projectKey: P, env: {}, runLeakGate: ok });
    return { held: next.allow && !after.allow, detail: { next: next.allow, after: after.allow } };
  },
  // b2 — a nested decision inside the gate must not double-spend one once-grant.
  b2(v) {
    reset(v); v.store.grantGitWrite(P, { scope: 'once' });
    let inner = null;
    const outer = v.grant.evaluateGitWrite({ command: 'git commit -m x', projectKey: P, env: {},
      runLeakGate: () => { inner = v.grant.evaluateGitWrite({ command: 'git commit -m x', projectKey: P, env: {}, runLeakGate: ok }); return ok(); } });
    const n = [outer, inner].filter((r) => r?.allow).length;
    return { held: n <= 1, detail: { outer: outer.allow, inner: inner?.allow } };
  },
  // b3 — the verifier's route: hook decided (reach unproven → spent at the hook), first
  // commit redeemed, grant revoked, the call's NEXT commit must be refused.
  b3(v) {
    reset(v); v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 });
    const h = hook(v, 'git commit -m a; git commit -m b');
    const a = redeem(v, ['commit', '-m', 'a']);
    v.store.revokeGitWrite(P);
    const b = redeem(v, ['commit', '-m', 'b']);
    endCall(v, h.toolUseId);
    return { held: h.allow && a.allow && !b.allow, detail: { hook: h.allow, deferred: !!h.deferred, a: a.allow, b: b.allow, view: v.store.grantView(P) } };
  },
  // b3b — a DEFERRED call (reservation only) revoked before its first write.
  b3b(v) {
    reset(v); warm(v); v.store.grantGitWrite(P, { scope: 'once' });
    const h = hook(v, 'git commit -m c');
    v.store.revokeGitWrite(P);
    const c = redeem(v, ['commit', '-m', 'c']);
    endCall(v, h.toolUseId);
    return { held: h.allow && h.deferred === true && !c.allow, detail: { deferred: h.deferred, c: c.allow } };
  },
  // b3c — the hook's own decision: revoked while its leak gate runs.
  b3c(v) {
    reset(v); v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 });
    const r = v.grant.evaluateGitWrite({ command: 'git commit -m d', projectKey: P, env: {}, runLeakGate: () => { v.store.revokeGitWrite(P); return ok(); } });
    return { held: !r.allow, detail: { allow: r.allow } };
  },
  // reviewer F1 — revoke, then a FRESH once-grant mid-call: the call must stay refused
  // and must not spend the fresh grant (no second decision for one call).
  reissue(v) {
    reset(v); v.store.grantGitWrite(P, { scope: 'once' });
    const h = hook(v, 'git commit -m a; git commit -m b');
    const a = redeem(v, ['commit', '-m', 'a']);
    v.store.revokeGitWrite(P); v.store.grantGitWrite(P, { scope: 'once' });
    const b = redeem(v, ['commit', '-m', 'b']);
    endCall(v, h.toolUseId);
    const gv = v.store.grantView(P);
    return { held: h.allow && a.allow && !b.allow && gv?.remainingUses === 1, detail: { a: a.allow, b: b.allow, grant: gv && { uses: gv.remainingUses, reserved: gv.reserved } } };
  },
  // expiry mid-call — a duration grant runs out between two writes of one call.
  expiryMidCall(v) {
    reset(v); const T = Date.now();
    v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 1000, now: T });
    const h = hook(v, 'git commit -m a; git commit -m b', { now: T });
    const a = redeem(v, ['commit', '-m', 'a'], { now: T + 10 });
    const b = redeem(v, ['commit', '-m', 'b'], { now: T + 5000 });
    endCall(v, h.toolUseId);
    return { held: h.allow && a.allow && !b.allow, detail: { a: a.allow, b: b.allow } };
  },
  // reviewer F2 — expiry DURING the gate on real time: the store must be asked with the
  // post-gate clock, at the hook and at the shim.
  expiryMidGateHook(v) {
    reset(v); v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 150 });
    const r = v.grant.evaluateGitWrite({ command: 'git commit -m e', projectKey: P, env: {}, runLeakGate: () => { sleepSync(300); return ok(); } });
    return { held: !r.allow, detail: { allow: r.allow } };
  },
  expiryMidGateShim(v) {
    reset(v); v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 400 });
    const h = hook(v, 'git commit -m a; git commit -m b');
    const changed = () => ({ head: 'h1', entries: ['new:bbb'] }); // content changed → the shim re-gates
    const b = redeem(v, ['commit', '-m', 'a'], { fp: changed, gate: () => { sleepSync(600); return ok(); } });
    endCall(v, h.toolUseId);
    return { held: h.allow && !b.allow, detail: { hook: h.allow, b: b.allow } };
  },
  // reviewer F3 — permanent turned off and on again (registry writer, no revoke call)
  // between two writes of one call: a new incarnation, the old decision is gone.
  permReincarnated(v) {
    reset(v);
    let setting = { permanent: true, grantedAt: '2026-10-05T00:00:00.000Z' };
    v.store.setPermanentGrantSource(() => setting);
    const h = hook(v, 'git commit -m a; git commit -m b');
    const a = redeem(v, ['commit', '-m', 'a']);
    setting = null; setting = { permanent: true, grantedAt: '2026-10-05T00:00:09.000Z' };
    const b = redeem(v, ['commit', '-m', 'b']);
    endCall(v, h.toolUseId);
    return { held: h.allow && a.allow && !b.allow, detail: { a: a.allow, b: b.allow } };
  },
  // concurrent calls, same project — once: only one call gets the decision; duration:
  // both run, and one revoke stops BOTH open calls.
  concurrent(v) {
    reset(v); const B2 = `${B}-2`;
    v.store.grantGitWrite(P, { scope: 'once' });
    const h1 = hook(v, 'git commit -m a; git commit -m b');
    const h2 = hook(v, 'git commit -m z', { binding: B2 });
    const a1 = redeem(v, ['commit', '-m', 'a']);
    const z = redeem(v, ['commit', '-m', 'z'], { binding: B2 });
    endCall(v, h1.toolUseId); endCall(v, h2.toolUseId, B2);
    const onceOk = h1.allow && !h2.allow && a1.allow && !z.allow && v.store.grantView(P) === null;
    v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 });
    const d1 = hook(v, 'git commit -m a; git commit -m b');
    const d2 = hook(v, 'git commit -m y; git commit -m z', { binding: B2 });
    const x1 = redeem(v, ['commit', '-m', 'a']), x2 = redeem(v, ['commit', '-m', 'y'], { binding: B2 });
    v.store.revokeGitWrite(P);
    const y1 = redeem(v, ['commit', '-m', 'b']), y2 = redeem(v, ['commit', '-m', 'z'], { binding: B2 });
    endCall(v, d1.toolUseId); endCall(v, d2.toolUseId, B2);
    const durOk = d1.allow && d2.allow && x1.allow && x2.allow && !y1.allow && !y2.allow;
    return { held: onceOk && durOk, detail: { once: [h1.allow, h2.allow, a1.allow, z.allow], dur: [x1.allow, x2.allow, y1.allow, y2.allow] } };
  },
};

console.log('\n[must-FAIL] pinned baselines reproduce each break');
for (const [name, v, sc] of [['b1 on r1 (synthesized from pinned r2)', r1, 'b1'], ['b2 on r2 (pinned)', r2, 'b2'],
  ['b3 on r4pre (pinned)', pre, 'b3'], ['b3b reserved call revoked, on r4pre', pre, 'b3b'], ['b3c revoke mid-gate at the hook, on r4pre', pre, 'b3c'],
  ['revoke + re-grant mid-call, on r4pre', pre, 'reissue'], ['expiry mid-call, on r4pre', pre, 'expiryMidCall'],
  ['expiry mid-gate (hook, real clock), on r4pre', pre, 'expiryMidGateHook'], ['expiry mid-gate (shim, real clock), on r4pre', pre, 'expiryMidGateShim'],
  ['permanent re-incarnated mid-call, on r4pre', pre, 'permReincarnated'], ['concurrent calls + revoke, on r4pre', pre, 'concurrent']]) {
  const r = SC[sc](v); check(`MUST-FAIL ${name}`, !r.held, r.detail);
}
console.log('\n[holds] the current tree');
for (const sc of Object.keys(SC)) { const r = SC[sc](cur); check(`${sc}`, r.held, r.detail); }

/* ── structural (runtime): every granted write ↔ one store authorisation ──────── */
// Drive a grid through the two entry points; every non-deferred {allow, granted} must
// be matched by exactly one store useClaim()==true during that same call.
function grid(v) {
  const mism = [];
  let granted = 0;
  const watch = (label, fn) => {
    const n0 = v.store._authorisationCount();
    const r = fn();
    const d = v.store._authorisationCount() - n0;
    const g = r && r.allow && r.granted && !r.deferred ? 1 : 0;
    granted += g;
    if (d !== g) mism.push({ label, granted: g, storeYes: d });
    return r;
  };
  for (const scope of ['once', 'duration', 'permanent']) {
    reset(v); warm(v);
    if (scope === 'permanent') v.store.setPermanentGrantSource(() => ({ permanent: true, grantedAt: 'p' }));
    else v.store.grantGitWrite(P, { scope, ttlMs: 60_000 });
    for (const reach of [true, false]) {
      const h = watch(`${scope} hook reach=${reach}`, () => hook(v, 'git add f && git commit -m a; git commit -m b', { shim: reach }));
      watch(`${scope} add`, () => redeem(v, ['add', 'f']));
      watch(`${scope} commit a`, () => redeem(v, ['commit', '-m', 'a']));
      if (scope !== 'permanent') v.store.revokeGitWrite(P); else v.store.setPermanentGrantSource(null);
      watch(`${scope} commit b after revoke`, () => redeem(v, ['commit', '-m', 'b']));
      watch(`${scope} independent`, () => redeem(v, ['commit', '-m', 'i'], { binding: 'none' }));
      endCall(v, h.toolUseId);
      if (scope === 'permanent') v.store.setPermanentGrantSource(() => ({ permanent: true, grantedAt: 'p' }));
      else v.store.grantGitWrite(P, { scope, ttlMs: 60_000 });
    }
  }
  return { mism, granted };
}
console.log('\n[structural] every granted write is one store authorisation at that write');
const gc = grid(cur);
check('S-run current: granted writes ↔ store useClaim()==true, 1:1, over the scenario grid', gc.granted > 0 && gc.mism.length === 0, gc);
const gm = grid(noAsk);
check('S-run MUST-FAIL mutant (redeem no longer asks the store): the 1:1 check catches it', gm.mism.length > 0, { mismatches: gm.mism.length });

// Static: discover EVERY `granted: true` site in the grant layer and the server, and
// require each to be either guarded by a store useClaim in the same function, a
// deferral (authorises no write), or a pure relay of the host's answer in the shim.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.(mjs|ts)$/.test(e.name) && !/\.d\.m?ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = [...fs.readdirSync(LIB).filter((n) => /^git-.*\.mjs$/.test(n)).map((n) => path.join(LIB, n)), ...walk(path.join(ROOT, 'src', 'server'))];
const sites = [];
const bad = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (!/\bgranted:\s*true\b/.test(l) || /^\s*(\/\/|\*)/.test(l)) return;
    const rel = path.relative(ROOT, f);
    sites.push(`${rel}:${i + 1}`);
    // enclosing top-level function: scan back to the nearest `function` declaration at column 0
    let s = i; while (s > 0 && !/^(export )?(async )?function /.test(lines[s])) s--;
    const body = lines.slice(s, i + 1).join('\n');
    const guarded = /\buse(Call)?Claim\(/.test(body); // BUG-231 r5: useCallClaim is the store's call-keyed useClaim
    const deferral = /deferred:\s*true/.test(l);
    const relay = rel.endsWith('git-shim.mjs') && /host\.allow|body\.allow === true/.test(lines.slice(Math.max(0, i - 3), i + 1).join('\n'));
    if (!(guarded || deferral || relay)) bad.push(`${rel}:${i + 1}`);
  });
}
console.log(`        (info) discovered ${sites.length} granted-allow sites across ${files.length} files`);
if (sites.length === 0) { check('S-static: discovered at least one granted-allow site (the scan is not vacuous)', false); }
else check('S-static: every granted-allow site is store-guarded, a deferral, or a relay of the host answer', bad.length === 0, { bad, sites });
const spenders = files.filter((f) => !f.endsWith('git-grant-store.mjs') && /remainingUses\s*-=|\bgrants\.(set|delete)\(/.test(fs.readFileSync(f, 'utf8')));
check('S-static: no module but the store spends or mutates a grant', spenders.length === 0, spenders.map((f) => path.relative(ROOT, f)));
const useDefs = files.filter((f) => /export function useClaim\(/.test(fs.readFileSync(f, 'utf8')));
check('S-static: useClaim (the one allow) is defined only in the store', useDefs.length === 1 && useDefs[0].endsWith('git-grant-store.mjs'), useDefs.map((f) => path.relative(ROOT, f)));
const callDefs = files.filter((f) => /export function useCallClaim\(/.test(fs.readFileSync(f, 'utf8')));
const callBody = callDefs.length === 1 ? fs.readFileSync(callDefs[0], 'utf8').split('export function useCallClaim(')[1].split('\n}\n')[0] : '';
check('S-static: useCallClaim is defined only in the store and answers through useClaim (BUG-231 r5)', callDefs.length === 1 && callDefs[0].endsWith('git-grant-store.mjs') && /\buseClaim\(r\.claim/.test(callBody), callDefs.map((f) => path.relative(ROOT, f)));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nFEAT-164 r4 store authority: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
