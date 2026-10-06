#!/usr/bin/env node
/**
 * verify-feat-164-single-authority.mjs — FEAT-164 round 3.
 *
 * PROPERTY: a git-write grant decision is taken exactly once, and a once-grant is
 * spent exactly once. It broke twice through the decide/spend split
 * (peekGrant … leak gate … consumeGrant):
 *   r1 — consumeGrant re-read the permanent setting after a mid-gate revoke and
 *        spent an independent once-grant (verify run 01a10ba1-8393-7e23-9ba1-a14a63e1e6f9);
 *   r2 — a re-entrant evaluateGitWrite inside the outer gate callback peeked the
 *        same un-reserved once-grant: one once-grant, two permitted writes
 *        (verify run 01a10bbd-44d2-7420-8d4e-e1e73b939a22).
 * Round 3 replaces the split with one authority (claimGrant → settleClaim).
 *
 * MUST-FAIL BASELINES (fixed, never HEAD — CONVENTIONS "moving baseline"):
 *   r2 — scripts/fixtures/feat-164/r2-git-grant{,-store}.mjs: the REAL pre-round-3
 *        bytes, pinned (nothing was committed, so there is no revision to name).
 *   r1 — SYNTHESIZED from the r2 fixture by restoring round 1's consume (re-read
 *        permanent, spend the project's once-grant by key). Labelled synthetic.
 * Every scenario runs on every variant in its own module instance. The suite
 * passes only if r1 and r2 exhibit their breaks AND the current tree holds.
 *
 * In-process, no server, no git, no real repo; the gate is an injected callback.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'lib');
const FIX = path.join(HERE, 'fixtures', 'feat-164');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`); }
};

/* ── variants, each loaded as an isolated module instance ─────────────────── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat164-r3-'));
let seq = 0;
async function loadVariant(storeSrc, grantSrc) {
  const dir = path.join(tmp, `v${++seq}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'git-grant-store.mjs'), storeSrc);
  fs.writeFileSync(path.join(dir, 'git-grant.mjs'), grantSrc);
  fs.copyFileSync(path.join(LIB, 'git-write-policy.mjs'), path.join(dir, 'git-write-policy.mjs'));
  const store = await import(pathToFileURL(path.join(dir, 'git-grant-store.mjs')).href);
  const grant = await import(pathToFileURL(path.join(dir, 'git-grant.mjs')).href);
  return { store, evaluateGitWrite: grant.evaluateGitWrite };
}

const r2Store = fs.readFileSync(path.join(FIX, 'r2-git-grant-store.mjs'), 'utf8');
const r2Grant = fs.readFileSync(path.join(FIX, 'r2-git-grant.mjs'), 'utf8');

// r1, synthesized: round 1's consume took the project KEY and re-read permanent.
const R2_CONSUME = r2Store.slice(r2Store.indexOf('export function consumeGrant('), r2Store.indexOf('/**', r2Store.indexOf('export function consumeGrant(')));
const R1_CONSUME = `export function consumeGrant(projectKey, now = Date.now()) {
  if (permanentGrantOf(projectKey)) return; // round 1: re-read permanent at consume time
  const g = grants.get(projectKey);
  if (!g || g.scope === 'duration') return;
  g.remainingUses -= 1;
  if (g.remainingUses <= 0 || now >= g.expiresAt) grants.delete(projectKey);
}

`;
const r1Store = r2Store.replace(R2_CONSUME, R1_CONSUME);
const r1Grant = r2Grant.replace('consumeGrant(grant, now);', 'consumeGrant(projectKey, now);');
if (!R2_CONSUME || r1Store === r2Store || r1Grant === r2Grant) {
  console.log('FAIL  could not synthesize the r1 baseline from the r2 fixture (fixture moved?)');
  process.exit(1);
}

const curStore = fs.readFileSync(path.join(LIB, 'git-grant-store.mjs'), 'utf8');
const curGrant = fs.readFileSync(path.join(LIB, 'git-grant.mjs'), 'utf8');

const COMMIT = 'git commit -m x';
const gateOK = () => ({ ok: true, detail: '' });
const KEY = 'proj-a';

/* ── scenarios: each returns { held: boolean, detail } ─────────────────────── */

// S1 — the r1 break: permanent + independent once-grant; permanent revoked during
// the gate. The once-grant must survive, so exactly one more write is allowed.
async function S1(v) {
  const { store, evaluateGitWrite } = v;
  store._resetGitGrantsForTest();
  let perm = true;
  store.setPermanentGrantSource(() => (perm ? { permanent: true } : null));
  store.grantGitWrite(KEY, { scope: 'once' });
  const outer = evaluateGitWrite({ command: COMMIT, projectKey: KEY, env: {}, runLeakGate: () => { perm = false; return gateOK(); } });
  const next = evaluateGitWrite({ command: COMMIT, projectKey: KEY, env: {}, runLeakGate: gateOK });
  const after = evaluateGitWrite({ command: COMMIT, projectKey: KEY, env: {}, runLeakGate: gateOK });
  // held = the r1 property (the independent once-grant is not collateral-spent);
  // revokeWins = the r4 property (the write decided before the revoke is denied).
  return { held: next.allow === true && after.allow === false, revokeWins: outer.allow === false, detail: { outer: outer.allow, next: next.allow, after: after.allow } };
}

// S2 — the r2 break: one once-grant; a nested decision inside the outer gate.
// Exactly one of the two writes may be permitted, and the grant ends spent.
async function S2(v) {
  const { store, evaluateGitWrite } = v;
  store._resetGitGrantsForTest();
  store.grantGitWrite(KEY, { scope: 'once' });
  let inner = null;
  const outer = evaluateGitWrite({
    command: COMMIT, projectKey: KEY, env: {},
    runLeakGate: () => { inner = evaluateGitWrite({ command: COMMIT, projectKey: KEY, env: {}, runLeakGate: gateOK }); return gateOK(); },
  });
  const allowed = [outer, inner].filter((r) => r?.allow).length;
  const later = evaluateGitWrite({ command: COMMIT, projectKey: KEY, env: {}, runLeakGate: gateOK });
  return { held: allowed === 1 && later.allow === false, detail: { outer: outer.allow, inner: inner?.allow, later: later.allow } };
}

// S2b — deeper re-entry: three nested levels, each a fresh write. Still one permit.
async function S2b(v) {
  const { store, evaluateGitWrite } = v;
  store._resetGitGrantsForTest();
  store.grantGitWrite(KEY, { scope: 'once' });
  const results = [];
  const nest = (depth) => () => { if (depth > 0) results.push(evaluateGitWrite({ command: COMMIT, projectKey: KEY, env: {}, runLeakGate: nest(depth - 1) })); return gateOK(); };
  results.push(evaluateGitWrite({ command: COMMIT, projectKey: KEY, env: {}, runLeakGate: nest(3) }));
  const allowed = results.filter((r) => r.allow).length;
  return { held: allowed === 1, detail: { allowed, of: results.length } };
}

// S3 — concurrency (an async gate, as a future async runner would be): N writers
// each decide, await their gate, then finish. Modelled with each variant's own
// store primitives in the order its evaluateGitWrite uses them.
async function S3(v, n = 8) {
  const { store } = v;
  store._resetGitGrantsForTest();
  store.grantGitWrite(KEY, { scope: 'once' });
  const gate = () => new Promise((r) => setTimeout(() => r(true), Math.random() * 10));
  const one = async () => {
    if (store.claimGrant) {
      const c = store.claimGrant(KEY);
      if (!c) return false;
      await gate();
      return store.settleClaim(c, 'commit');
    }
    const d = store.peekGrant(KEY);
    if (!d) return false;
    await gate();
    store.consumeGrant(d);
    return true;
  };
  const outs = await Promise.all(Array.from({ length: n }, one));
  const allowed = outs.filter(Boolean).length;
  return { held: allowed === 1, detail: { allowed, of: n } };
}

/* ── run: baselines must exhibit the breaks; the current tree must hold ─────── */
const r1 = await loadVariant(r1Store, r1Grant);
const r2 = await loadVariant(r2Store, r2Grant);
const cur = await loadVariant(curStore, curGrant);

console.log('\n[must-FAIL] baselines reproduce the prior breaks');
const b1 = await S1(r1); check('MUST-FAIL r1 (synthesized): permanent revoked mid-gate spends the independent once-grant', !b1.held, b1.detail);
const b2 = await S2(r2); check('MUST-FAIL r2 (pinned real bytes): nested decision in the gate double-spends one once-grant', !b2.held, b2.detail);
const b2b = await S2b(r2); check('MUST-FAIL r2: three-deep re-entry permits more than one write', !b2b.held, b2b.detail);
const b3 = await S3(r2); check('MUST-FAIL r2: 8 concurrent decisions over an async gate all permit on one once-grant', !b3.held, b3.detail);
const b1on2 = await S1(r2); check('control: r2 had fixed the r1 path (so the two breaks are distinct paths)', b1on2.held, b1on2.detail);

console.log('\n[holds] the current tree (claimGrant → settleClaim)');
{ const r = await S1(cur); check('S1r4 permanent revoked mid-gate DENIES the write decided under it (r4: revocation wins)', r.revokeWins, r.detail); }
for (const [name, fn] of [['S1 r1 path: permanent revoke mid-gate leaves the once-grant for exactly one more write', S1],
  ['S2 r2 path: a nested decision in the gate cannot claim the reserved use (1 of 2 permitted)', S2],
  ['S2b three-deep re-entry: exactly one permit', S2b],
  ['S3 8 concurrent claims over an async gate: exactly one commits', S3]]) {
  const r = await fn(cur); check(name, r.held, r.detail);
}
// Repeat the concurrency race to shake timing.
let allOne = true; for (let i = 0; i < 25; i++) allOne = allOne && (await S3(cur, 5)).held;
check('S3x 25 more concurrent races (5 writers each): exactly one each time', allOne);

const { store, evaluateGitWrite } = cur;
const ev = (gate = gateOK, now) => evaluateGitWrite({ command: COMMIT, projectKey: KEY, env: {}, runLeakGate: gate, ...(now === undefined ? {} : { now }) });

console.log('\n[authority] shape and lifecycle');
check('A1 no peekGrant / consumeGrant export remains', !('peekGrant' in store) && !('consumeGrant' in store));
store._resetGitGrantsForTest(); store.grantGitWrite(KEY, { scope: 'once' });
const c1 = store.claimGrant(KEY);
check('A2 a claim is frozen and carries a plain view', Object.isFrozen(c1) && Object.isFrozen(c1.view) && c1.scope === 'once');
check('A3 while reserved, a second claim on the once-grant is refused', store.claimGrant(KEY) === null);
const gvRes = store.grantView(KEY);
check('A4 grantView during the reservation still shows the grant (0 claimable, 1 reserved)', gvRes?.scope === 'once' && gvRes.remainingUses === 0 && gvRes.reserved === 1, gvRes);
check('A5 release returns the use (false = no permit)', store.settleClaim(c1, 'release') === false && store.grantView(KEY)?.remainingUses === 1);
let t = false; try { store.settleClaim(c1, 'commit'); } catch { t = true; }
check('A6 a second settle throws (a decision ends once)', t);
t = false; try { store.settleClaim({ scope: 'once', view: {} }, 'commit'); } catch { t = true; }
check('A7 a forged claim object throws', t);
t = false; try { store.settleClaim(store.claimGrant(KEY), 'maybe'); } catch { t = true; }
check('A8 an unknown outcome throws', t);

console.log('\n[gate] failure, exception, revoke, replace, expiry');
store._resetGitGrantsForTest(); store.grantGitWrite(KEY, { scope: 'once' });
check('G1 a failed gate spends nothing', ev(() => ({ ok: false, detail: 'leak' })).allow === false && store.grantView(KEY)?.remainingUses === 1);
check('G2 a throwing gate fails closed and spends nothing', ev(() => { throw new Error('boom'); }).allow === false && store.grantView(KEY)?.remainingUses === 1 && store.grantView(KEY)?.reserved === 0);
check('G3 then the once-grant permits exactly one write', ev().allow === true && ev().allow === false);
store.grantGitWrite(KEY, { scope: 'once' });
const rv = ev(() => { store.revokeGitWrite(KEY); return gateOK(); });
check('G4 revoke mid-gate: the write claimed before it is DENIED (r4); the next is denied', rv.allow === false && ev().allow === false);
store.grantGitWrite(KEY, { scope: 'once' });
const rp = ev(() => { store.revokeGitWrite(KEY); store.grantGitWrite(KEY, { scope: 'once' }); return gateOK(); });
check('G5 replace mid-gate: the write is denied (r4); the replacement once-grant is untouched (1 use, 0 reserved)', rp.allow === false && store.grantView(KEY)?.remainingUses === 1 && store.grantView(KEY)?.reserved === 0, store.grantView(KEY));
store._resetGitGrantsForTest();
const T = Date.now();
store.grantGitWrite(KEY, { scope: 'once', ttlMs: 1000, now: T });
const ex = ev(() => { store.grantView(KEY, T + 5000); return gateOK(); }, T + 500); // TTL lapses mid-gate; a display read purges it
check('G6 TTL lapsing mid-gate: the write is DENIED (r4: the store is asked after the gate); the grant is gone after', ex.allow === false && store.grantView(KEY, T + 5000) === null);
store._resetGitGrantsForTest();
store.grantGitWrite(KEY, { scope: 'duration', ttlMs: 60_000 });
let nestedDur = null;
const od = ev(() => { nestedDur = ev(); return gateOK(); });
check('G7 duration grant: nested writes both allowed (not use-bounded) and the grant survives', od.allow && nestedDur?.allow && store.grantView(KEY)?.scope === 'duration');
store._resetGitGrantsForTest();
let perm = true; store.setPermanentGrantSource(() => (perm ? { permanent: true } : null));
let nestedPerm = null;
const op = ev(() => { perm = false; nestedPerm = ev(); return gateOK(); });
check('G8 permanent revoked mid-gate: the outer (claimed under permanent) is DENIED (r4), and so is the nested decision after the revoke', op.allow === false && nestedPerm?.allow === false);

console.log('\n[lapse] a lost claim cannot pin a once-grant');
store._resetGitGrantsForTest();
const T2 = Date.now();
store.grantGitWrite(KEY, { scope: 'once', now: T2 });
const lost = store.claimGrant(KEY, T2);
check('L0 before lapse, the use is reserved', store.claimGrant(KEY, T2 + 1000) === null);
const later = store.claimGrant(KEY, T2 + store.CLAIM_MAX_MS);
check('L1 after CLAIM_MAX_MS the reservation is freed and a new claim succeeds', !!later);
check('L2 the lapsed claim cannot commit (no double spend)', store.settleClaim(lost, 'commit', T2 + store.CLAIM_MAX_MS + 1) === false);
check('L3 the live claim commits exactly once and the grant is spent', store.settleClaim(later, 'commit', T2 + store.CLAIM_MAX_MS + 2) === true && store.grantView(KEY, T2 + store.CLAIM_MAX_MS + 3) === null);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nFEAT-164 r3 single authority: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
