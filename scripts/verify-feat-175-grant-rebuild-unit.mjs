#!/usr/bin/env node
/**
 * FEAT-175 — unit proofs for the git-grant container rebuild DECISIONS (src/server/grant-rebuild.ts), against
 * fakes: no docker, no server. The end-to-end proofs are verify-feat-175-grant-rebuild.mjs.
 *
 *   node scripts/verify-feat-175-grant-rebuild-unit.mjs [--tree <dir>] [--r1]
 *
 * r2 (level-based redesign): the world holds two FACTS per project — DESIRED (the grant's mode now) and ACTUAL
 * (the mode the container was created with) — plus injectable read failures for the registry, the grant/policy
 * read and docker inspect. `--tree <dir> --r1` drives the round-1 (edge-triggered) module through an adapter
 * that maps the same world onto its API (fingerprint / guardDrift), so every r2 property can show must-FAIL
 * on round 1. Every check prints the observed value.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const argTree = process.argv.indexOf('--tree');
const ROOT = argTree > 0 ? path.resolve(process.argv[argTree + 1]) : path.resolve(HERE, '..');
const R1 = process.argv.includes('--r1');
const MOD = path.join(ROOT, 'src/server/grant-rebuild.ts');

let pass = 0, fail = 0;
function check(name, ok, observed) {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
}
if (!fs.existsSync(MOD)) { check('grant-rebuild.ts exists in the tree under test', false, MOD); console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
const { createGrantRebuild, RebuildGateError } = await import(url.pathToFileURL(MOD).href);

/* ------------------------------------------------------------------ the fake world */
function world() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat175-unit-'));
  const w = {
    tmp, t: 1_000_000,
    projects: [{ id: 'p', name: 'P', isolation: 'container' }],
    desired: { p: 'ro' },         // the grant's mode now
    actual: { p: 'ro' },          // the container's created mode ('none' = no container)
    timedLabel: { p: false },     // r1 adapter only: created under a timed grant
    failList: false, failDesired: false, failInspect: false,
    sessions: { p: [] }, leases: { p: [] },
    delivering: new Set(), reserved: [], recreates: [], settled: [], recreateImpl: null, logs: [],
    gr: null,
  };
  w.session = (pid, id, o = {}) => {
    const s = {
      id, label: `session ${id}`, sdkKey: o.sdkKey === undefined ? `sdk-${id}` : o.sdkKey, closed: false, busy: !!o.busy,
      _working: !!o.working, _lifetime: o.lifetime ?? 'no', closedWith: null,
      working() { return this._working; },
      _turn: o.turn ?? null,
      turnKey() { return this.busy || this._working ? this._turn : null; },
      async closeLifetime() { if (o.onLifetime) o.onLifetime(this); return { lifetime: this._lifetime, source: 'fake' }; },
      async close(reason, opts) { this.closed = true; this.closedWith = { reason, opts }; w.leases[pid] = w.leases[pid].filter((l) => l.sessionId !== id); },
    };
    w.sessions[pid].push(s);
    w.leases[pid].push({ id: `lease-${id}`, state: 'attached', sessionId: id, createdAt: w.t, orphan: false });
    return s;
  };
  const listProjects = () => { if (w.failList) throw new Error('registry unreadable (injected)'); return w.projects; };
  const recreate = async (p, o) => {
    w.recreates.push({ id: p.id, force: o.force, captured: o.captured, liveSessionsAtCall: (w.sessions[p.id] ?? []).filter((s) => !s.closed).map((s) => s.id) });
    if (w.recreateImpl) return w.recreateImpl(p, o);
    // a real create declares and reports the mode synchronously
    w.actual[p.id] = w.desired[p.id]; w.timedLabel[p.id] = false;
    w.gr?.recordActual?.(p.id, w.desired[p.id]);
  };
  const common = {
    listProjects,
    sessionsOf: (pid) => w.sessions[pid] ?? [],
    leasesOf: (pid) => w.leases[pid] ?? [],
    deliveryBusy: (k) => w.delivering.has(k),
    reserve: (k) => { w.reserved.push(k); w.delivering.add(k); return () => w.delivering.delete(k); },
    recreate,
    settled: (pid, keys) => w.settled.push({ pid, keys }),
    logFile: path.join(tmp, 'grant-rebuild.log.jsonl'),
    now: () => w.t, log: (s) => w.logs.push(s), leaseSettleMs: 50,
  };
  if (!R1) {
    w.deps = {
      ...common,
      desiredOf: (id) => { if (w.failDesired) throw new Error('policy unreadable (injected)'); return w.desired[id]; },
      readActual: (p) => (w.failInspect ? 'unknown' : w.actual[p.id]),
    };
  } else {
    // ROUND-1 adapter: the same world through the r1 API.
    const RO = 'gitguard: the real repo .git is writable in this container (no permanent git-write grant); read-only overlay missing: /x';
    const RW = 'gitguard: read-only .git overlay no longer wanted (git-write grant, or the repo moved): /x';
    w.deps = {
      ...common,
      stateFile: path.join(tmp, 'grant-rebuild.json'),
      fingerprint: (p) => { if (w.failDesired) throw new Error('policy unreadable (injected)'); return w.desired[p.id] === 'rw' ? 'perm' : 'none'; },
      guardDrift: (p) => {
        if (w.failInspect) return 'error';
        const a = w.actual[p.id];
        if (a === 'none') return null;
        const mism = a !== w.desired[p.id];
        return { containerId: `c-${p.id}`, running: true, reasons: mism ? [w.desired[p.id] === 'ro' ? RO : RW] : [], tightens: mism && w.desired[p.id] === 'ro', hasGitGuardLabel: true, gitWriteTimed: w.timedLabel[p.id] ? [p.id] : [] };
      },
    };
  }
  w.make = () => { w.gr = createGrantRebuild(w.deps); return w.gr; };
  return w;
}
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const holds = (gr) => !!gr.turnHoldOf('p');
async function ticks(w, n = 3) { for (let i = 0; i < n; i++) { w.gr.tick(); await flush(20); } }

/* ============================================================ r2 properties (the adjudicated ones) */

/* RF1 — a registry (listProjects) read failure right after a revoke never loses the revoke. */
{
  const w = world(); w.desired.p = 'rw'; w.actual.p = 'rw';
  const gr = w.make(); w.session('p', 'a', { busy: true });
  await ticks(w, 1);
  w.desired.p = 'ro'; w.failList = true;           // revoke, and the registry list fails on that tick
  await ticks(w, 2);
  check('RF1 registry unreadable right after a revoke: new turns are HELD (fail closed)', holds(gr), gr.turnHoldOf('p'));
  w.failList = false; await ticks(w, 2);
  check('RF1 …and once readable the revoke is pending (not lost)', gr._phaseOf('p') === 'pending' && holds(gr), { phase: gr._phaseOf('p') });
  w.sessions.p[0].busy = false; await ticks(w, 3);
  check('RF1 …and applied at idle: recreated read-only', w.recreates.length === 1 && w.actual.p === 'ro' && !holds(gr), { recreates: w.recreates.length, actual: w.actual.p });
}

/* RF2 — the grant/policy read fails: unknown desired fails closed on a writable container; no rebuild on it. */
{
  const w = world(); w.desired.p = 'rw'; w.actual.p = 'rw';
  const gr = w.make(); await ticks(w, 1);
  check('RF2 precondition: a granted, writable container is not held', !holds(gr), gr.turnHoldOf('p'));
  w.failDesired = true; await ticks(w, 2);
  check('RF2 policy read fails: turns HELD (cannot confirm read-only)', holds(gr), gr.turnHoldOf('p'));
  check('RF2 …and nothing is rebuilt on an unknown desire', w.recreates.length === 0, w.recreates.length);
  w.failDesired = false; await ticks(w, 1);
  check('RF2 readable again (still granted): hold released', !holds(gr), gr.turnHoldOf('p'));
}

/* RF3 — docker inspect fails: actual unknown fails closed when the grant wants read-only; not when it wants rw. */
{
  const w = world(); w.desired.p = 'ro'; w.actual.p = 'ro';
  const gr = w.make(); await ticks(w, 1);
  check('RF3 precondition: read-only container, ungranted: not held', !holds(gr), gr.turnHoldOf('p'));
  w.failInspect = true; await ticks(w, 1);
  check('RF3 docker unreadable (desired ro): HELD', holds(gr), gr.turnHoldOf('p'));
  w.desired.p = 'rw'; await ticks(w, 1);
  check('RF3 docker unreadable but the grant says rw: not held', !holds(gr), gr.turnHoldOf('p'));
  w.desired.p = 'ro'; w.t += 2 * 60_000 + 1000; await ticks(w, 1);
  const card = gr.railItems().find((x) => /cannot read/.test(x.title));
  check('RF3 unknown for > 2 min raises a Needs-You card', !!card, gr.railItems().map((x) => x.title));
  w.failInspect = false; await ticks(w, 1);
  check('RF3 docker back: hold and card clear', !holds(gr) && !gr.railItems().length, { hold: holds(gr), cards: gr.railItems().length });
}

/* RF4 — the post-recreate state is the synchronously REPORTED mode; a read failure afterwards fails closed, never open, and causes no second rebuild. */
{
  const w = world(); w.desired.p = 'ro'; w.actual.p = 'rw';
  const gr = w.make();
  check('RF4 precondition: writable container, grant gone → held before the rebuild', holds(gr), gr.turnHoldOf('p'));
  w.recreateImpl = async (p) => { w.recreates.length; w.actual.p = 'ro'; gr.recordActual?.('p', 'ro'); w.failInspect = true; }; // docker dies right after the create
  await ticks(w, 1);
  check('RF4 recreated once; the reported mode is ro (no read needed)', w.recreates.length === 1 && gr._actualOf?.('p') === 'ro', { recreates: w.recreates.length, actual: gr._actualOf?.('p') });
  await ticks(w, 3);
  check('RF4 docker unreadable after the recreate: held (fail closed), no second rebuild', holds(gr) && w.recreates.length === 1, { hold: holds(gr), recreates: w.recreates.length });
  w.failInspect = false; await ticks(w, 1);
  check('RF4 readable: not held', !holds(gr), gr.turnHoldOf('p'));
}

/* RS1 — a restart with a revoke pending: the new process holds and rebuilds from the two facts alone. */
{
  const w = world(); w.desired.p = 'rw'; w.actual.p = 'rw';
  let gr = w.make(); w.session('p', 'a', { busy: true }); await ticks(w, 1);
  w.desired.p = 'ro'; await ticks(w, 1);                      // revoke pending under a busy turn
  // RESTART: a fresh module; sessions are gone, the container (rw label) is still there.
  w.sessions.p = []; w.leases.p = [];
  gr = w.make();
  check('RS1 restart, before the first tick: turns are HELD (actual unknown, desired ro)', holds(gr), gr.turnHoldOf('p'));
  await ticks(w, 2);
  check('RS1 after boot: rebuilt read-only (nothing idle-blocks it), hold released', w.recreates.length === 1 && w.actual.p === 'ro' && !holds(gr), { recreates: w.recreates.length, actual: w.actual.p });
}

/* RS2 — a restart with a revoke pending AND docker unreadable: held until docker answers, then rebuilt. */
{
  const w = world(); w.desired.p = 'ro'; w.actual.p = 'rw'; w.failInspect = true;
  const gr = w.make(); await ticks(w, 3);
  check('RS2 restart + docker unreadable: HELD, nothing rebuilt blind', holds(gr) && w.recreates.length === 0, { hold: holds(gr), recreates: w.recreates.length });
  let gateErr = 'waiting'; const gate = gr.admissionGate('p', () => {}, () => false).then(() => { gateErr = 'passed'; }, (e) => { gateErr = e.code; });
  await flush();
  check('RS2 a new session start waits at the gate', gateErr === 'waiting', gateErr);
  w.failInspect = false; await ticks(w, 3);
  await Promise.race([gate, new Promise((r) => setTimeout(r, 1500))]);
  check('RS2 docker back: rebuilt read-only and the waiting start proceeds', w.recreates.length === 1 && gateErr === 'passed', { recreates: w.recreates.length, gate: gateErr });
}

/* RS3 — a duration grant that expired while the server was down: desired ro (grant gone), container labelled rw. */
{
  const w = world(); w.desired.p = 'ro'; w.actual.p = 'rw'; w.timedLabel.p = true;
  const gr = w.make();
  check('RS3 boot after an expiry-while-down: HELD before anything is read', holds(gr), gr.turnHoldOf('p'));
  await ticks(w, 2);
  check('RS3 rebuilt read-only at boot, hold released', w.recreates.length === 1 && w.actual.p === 'ro' && !holds(gr), { recreates: w.recreates.length });
}

/* ============================================================ carried-over behaviour */

/* B1 — a grant during a live turn: pending, no hold (loosening), no recreate until idle. */
{
  const w = world();
  const gr = w.make(); const s = w.session('p', 'a', { busy: true }); await ticks(w, 1);
  w.desired.p = 'rw'; await ticks(w, 3);
  check('B1 grant while busy: pending, not held, not recreated', gr._phaseOf('p') === 'pending' && !holds(gr) && w.recreates.length === 0, { phase: gr._phaseOf('p'), recreates: w.recreates.length });
  s.busy = false; await ticks(w, 3);
  check('B1 idle → recreated rw once; session closed resumably; no force', w.recreates.length === 1 && w.recreates[0].force === false && s.closedWith?.opts?.resumable === true && w.actual.p === 'rw', { recreates: w.recreates, closed: s.closedWith });
}

/* B2 — a tightening with an agent working: held; over-run card after 10 min; logged. */
{
  const w = world(); w.desired.p = 'rw'; w.actual.p = 'rw';
  const gr = w.make(); const s = w.session('p', 'a', { working: true }); await ticks(w, 1);
  w.desired.p = 'ro'; await ticks(w, 1);
  let thrown = null; try { gr.assertTurnAllowed('p'); } catch (e) { thrown = { code: e.code, retryable: e.retryable }; }
  check('B2 revoke with an agent working: held with a retryable rebuild-hold', thrown?.code === 'rebuild-hold' && thrown.retryable === true, thrown);
  w.t += 11 * 60_000;
  check('B2 over-run card after 10 min offers to stop the work', gr.railItems().some((x) => /grant ended/.test(x.title) && x.actions[0].id === 'force'), gr.railItems().map((x) => x.title));
  s._working = false; await ticks(w, 3);
  const applied = fs.readFileSync(w.deps.logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.event === 'applied');
  check('B2 applied after idle with overrunMs logged', w.actual.p === 'ro' && applied?.overrunMs >= 11 * 60_000, applied);
}

/* B3 — a background shell blocks (immediate card); the user's force recreates with force=true. */
{
  const w = world();
  const gr = w.make(); w.session('p', 'a', { lifetime: 'yes' }); await ticks(w, 1);
  w.desired.p = 'rw'; await ticks(w, 3);
  check('B3 background shell blocks the automatic rebuild, card at once', w.recreates.length === 0 && gr.railItems().length === 1, gr.railItems().map((x) => x.title));
  gr.request('p', { force: true }); await flush(40);
  check('B3 user force recreates (force=true)', w.recreates.length === 1 && w.recreates[0].force === true, w.recreates);
}

/* B4 — failed with the container gone: failed, held, card, gate refuses; backoff retry succeeds. */
{
  const w = world(); w.desired.p = 'ro'; w.actual.p = 'rw';
  const gr = w.make();
  let fails = 1;
  w.recreateImpl = async () => { if (fails-- > 0) { w.actual.p = 'none'; throw new Error('docker create failed (injected)'); } w.actual.p = 'ro'; gr.recordActual('p', 'ro'); };
  await ticks(w, 1);
  check('B4 failure with the container gone → failed + held + card', gr._phaseOf('p') === 'failed' && holds(gr) && gr.railItems().some((x) => /failed/.test(x.title)), { phase: gr._phaseOf('p') });
  let gateErr = null; try { await gr.admissionGate('p', () => {}, () => false); } catch (e) { gateErr = e.code; }
  check('B4 a new start is refused (text goes back), not left waiting', gateErr === 'rebuild-failed', gateErr);
  w.t += 31_000; await ticks(w, 2);
  check('B4 backoff retry succeeds and clears', gr._phaseOf('p') === null && !holds(gr) && w.recreates.length === 2, { phase: gr._phaseOf('p'), recreates: w.recreates.length });
}

/* B5 — refused with the container intact → pending (a loosening holds nothing). */
{
  const w = world();
  const gr = w.make(); await ticks(w, 1);
  w.desired.p = 'rw';
  w.recreateImpl = async () => { const e = new Error('refusing to recreate: 1 session(s) hold it'); e.code = 'live-sessions'; throw e; };
  await ticks(w, 1);
  check('B5 refused with the container intact → pending, not held', gr._phaseOf('p') === 'pending' && !holds(gr), gr._phaseOf('p'));
}

/* B6 — a stray (draining) lease, a starting session, a delivery in flight each block. */
{
  const w = world();
  const gr = w.make(); w.leases.p.push({ id: 'orphan-1', state: 'draining', sessionId: null, createdAt: 0, orphan: true });
  await ticks(w, 1); w.desired.p = 'rw'; await ticks(w, 2);
  check('B6 a draining lease blocks', w.recreates.length === 0, gr.viewOf('p')?.waitingOn);
  w.leases.p = []; w.session('p', 'a', { sdkKey: null }); await ticks(w, 2);
  check('B6 a starting session blocks', w.recreates.length === 0, gr.viewOf('p')?.waitingOn);
  w.sessions.p[0].sdkKey = 'sdk-a'; w.delivering.add('sdk-a'); await ticks(w, 2);
  check('B6 a delivery in flight blocks', w.recreates.length === 0, gr.viewOf('p')?.waitingOn);
  w.delivering.delete('sdk-a'); await ticks(w, 2);
  check('B6 …then it proceeds', w.recreates.length === 1, w.recreates.length);
}

/* B7 — a turn begun during the async lifetime query, or a session added then, is never reaped. */
{
  const w = world();
  const gr = w.make(); const s = w.session('p', 'a', { onLifetime: (me) => { me.busy = true; } });
  await ticks(w, 1); w.desired.p = 'rw'; await ticks(w, 1);
  check('B7 a turn that began during the lifetime query is not reaped', !s.closed && w.recreates.length === 0, { closed: s.closed });
  const w2 = world(); const gr2 = w2.make(); let late = null;
  w2.session('p', 'a', { onLifetime: () => { if (!late) late = w2.session('p', 'b', { lifetime: 'yes' }); } });
  await ticks(w2, 1); w2.desired.p = 'rw'; await ticks(w2, 2);
  check('B7 a session added during the lifetime query is never reaped unasked', !!late && !late.closed && w2.recreates.length === 0, { lateClosed: late?.closed, recreates: w2.recreates.length });
  void gr; void gr2;
}

/* B8 — admission gate: waits through a tightening, an abandoned start runs nothing, proceeds after. */
{
  const w = world(); w.desired.p = 'rw'; w.actual.p = 'rw';
  const gr = w.make(); const s = w.session('p', 'a', { busy: true }); await ticks(w, 1);
  w.desired.p = 'ro'; await ticks(w, 1);
  let state = 'waiting'; const g1 = gr.admissionGate('p', () => {}, () => false).then(() => { state = 'passed'; });
  let ab = null; let gone = false; const g2 = gr.admissionGate('p', () => {}, () => gone).catch((e) => { ab = e.code; });
  gone = true; await new Promise((r) => setTimeout(r, 1100)); await g2;
  check('B8 a start waits while held; an abandoned one is dropped before admission', state === 'waiting' && ab === 'abandoned', { state, ab });
  s.busy = false; await ticks(w, 3); await Promise.race([g1, new Promise((r) => setTimeout(r, 1500))]);
  check('B8 the waiting start proceeds once rebuilt', state === 'passed', state);
}

/* B9 — a once-style grant that never changes desired causes nothing; a matching container is never rebuilt. */
{
  const w = world();
  const gr = w.make(); for (let i = 0; i < 5; i++) { w.t += 15_000; await ticks(w, 1); }
  check('B9 desired == actual: never pending, never rebuilt, never held', w.recreates.length === 0 && gr._phaseOf('p') === null && !holds(gr), { recreates: w.recreates.length });
}

/* ============================================================ IV 1d4639a9: "Rebuild now" is a one-shot press */

/* F1 — a refused press, then a turn starts: nothing recreates the container under that turn. */
{
  const w = world();
  const gr = w.make(); const s = w.session("p", "a", { sdkKey: null }); await ticks(w, 1);
  w.desired.p = "rw"; await ticks(w, 1);
  const r = await gr.request("p", { force: true });
  check("F1 a press while a session is starting is refused, and the user is told", /^refused/.test(r?.outcome ?? "") && w.recreates.length === 0, r?.outcome ?? null);
  s.sdkKey = "sdk-a"; s.busy = true; s._turn = 101;   // a turn starts after the refusal
  for (let i = 0; i < 4; i++) { w.t += 31_000; await ticks(w, 1); }
  check("F1 …then no pass recreates the container under the new turn", w.recreates.length === 0 && !s.closed, { recreates: w.recreates, closed: s.closed });
}

/* F2 — a refused press, then an ordinary Retry: the Retry carries no force. */
{
  const w = world();
  const gr = w.make(); const s = w.session("p", "a", { sdkKey: null }); await ticks(w, 1);
  w.desired.p = "rw"; await ticks(w, 1);
  const r = await gr.request("p", { force: true });
  s.sdkKey = "sdk-a"; s.busy = true; s._turn = 202;
  const r2 = await gr.request("p", { force: false });
  for (let i = 0; i < 4; i++) { w.t += 31_000; await ticks(w, 1); }
  check("F2 refused, then Retry: no forced recreate, the running turn is untouched", /^refused/.test(r?.outcome ?? "") && w.recreates.every((x) => x.force !== true) && w.recreates.length === 0 && !s.closed, { first: r?.outcome ?? null, retry: r2?.outcome ?? null, recreates: w.recreates });
}

/* F3 — a press with the project idle recreates at once (force=true), and says so. */
{
  const w = world();
  const gr = w.make(); w.session("p", "a", { lifetime: "yes" }); await ticks(w, 1);
  w.desired.p = "rw"; await ticks(w, 2);
  const r = await gr.request("p", { force: true }); await flush(40);
  check("F3 an idle-but-blocked (background shell) project: the press recreates with force=true", w.recreates.length === 1 && w.recreates[0].force === true && /^recreating/.test(r?.outcome ?? ""), { outcome: r?.outcome ?? null, recreates: w.recreates });
}

/* F4 — a press that saw turn T1 is dropped when a DIFFERENT turn is running by the time it executes. */
{
  const w = world();
  const gr = w.make(); const s = w.session("p", "a", { busy: true, turn: 1 }); await ticks(w, 1);
  w.desired.p = "rw"; await ticks(w, 1);
  const real = w.deps.sessionsOf; let calls = 0;
  w.deps.sessionsOf = (pid) => { calls++; if (calls === 2) { s._turn = 2; } return real(pid); }; // the turn changes between the press snapshot and execution
  const r = await gr.request("p", { force: true });
  w.deps.sessionsOf = real;
  check("F4 the press is dropped (a different turn is now live), nothing recreated, the user told", /^dropped/.test(r?.outcome ?? "") && w.recreates.length === 0 && !s.closed, r?.outcome ?? null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
