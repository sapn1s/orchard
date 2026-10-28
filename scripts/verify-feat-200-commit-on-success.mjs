#!/usr/bin/env node
/**
 * FEAT-200 r5 — the REVERT/APPLY property under concurrency, after the design review (0a294aac) replaced
 * "write settings on approve, revert on refusal" with COMMIT ON SUCCESS.
 *
 *   node scripts/verify-feat-200-commit-on-success.mjs [--tree <dir>] [--runs N] [--seed S]
 *
 * The property: when approved requests cannot all be applied (docker refuses a host port a recreate adds), the
 * project's final settings equal the base settings plus EXACTLY the requests that were really applied (last-applied
 * wins on a shared key), the running container equals those settings, a user's own edit is never undone, and every
 * requester is told the truth ("access granted" only if the container has it; "could not be applied" if docker
 * refused it; "denied" on reject).
 *
 * HOW. The access layer is the REAL code of the tree under test (access-requests.ts, access-channel.ts: raise
 * parsing, decisions, the refusal handler, the level-based commit/resume checker) and the container's env/ports are
 * read from the tree's REAL `createArgs` (container-manager.ts, with the tree's own overlay hook when it has one).
 * What is simulated: the docker daemon (a host port in `squatted` refuses a create that ADDS it, one port per
 * attempt, as docker reports one bind failure) and the index.ts wiring (approve route, settings write, port-refusal
 * hook), mirrored per model:
 *   - commit-on-success tree (has ch.failRefused): approve = record only; hook = failRefused (+ retry while 'retry');
 *     commit = checkResumes' commitBase.
 *   - pre-r5 tree (has ch.revertRefused): approve = write settings; hook = revertRefused (+ retry once).
 * SYNTHETIC by necessity (a random interleaving search cannot run on a real daemon in useful time); the real-daemon
 * replay of the four breaks is the e2e suite's Y block (verify-feat-200-access-requests.mjs --only Y).
 *
 * Sections: W1-W4 the four recorded breaks (r3 shared key, r4 shared port, r4 stale provenance, r4 chained refusals);
 * W5 the general case (N concurrent requests, a random refused subset, random interleavings); W6-W11 user edits,
 * crash between the settings write and the record mark, a refused USER port, the retry bound, no loop.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const ROOT = arg('--tree') ? path.resolve(arg('--tree')) : path.resolve(HERE, '..');
const RUNS = Number(arg('--runs') ?? 400);
let SEED = Number(arg('--seed') ?? 20261027);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'feat200-cos-data-'));
process.env.CLAUDE_STATION_DATA = DATA;
/** An EMPTY project dir: createArgs inspects the project tree for binds (a busy dir such as /tmp costs seconds per call). */
const PROJ_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'feat200-cos-proj-'));

let pass = 0, fail = 0;
function check(name, ok, observed) {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
}
const imp = (rel) => import(url.pathToFileURL(path.join(ROOT, rel)).href);
const acc = await imp('src/server/access-requests.ts');
const ch = await imp('src/server/access-channel.ts');
const cm = await imp('src/server/container-manager.ts');
const regm = await imp('src/server/registry.ts');
const NEW = typeof ch.failRefused === 'function';
/** r6: edit versions stamped by the registry writer; the commit pass cancels; the overlay reads live records only. */
const R6 = typeof ch.overlayFor === 'function' && typeof acc.basisFor === 'function';
/** r7: "committed" is written INSIDE the settings write (registry `accessCommitted`); `ch.commitPlanFor` builds that write. */
const R7 = typeof ch.commitPlanFor === 'function';
/** r8: requests are bound to a project INCARNATION and classified by ONE classifier (acc.classify). */
const R8 = typeof acc.classify === 'function' && typeof regm.incarnationOf === 'function';
const removedText = (t) => /its project was removed from Orchard/.test(t ?? '') && /not in effect/.test(t ?? '');
console.log(`tree ${ROOT}: ${R6 ? 'commit-on-success + edit versions (r6)' : NEW ? 'commit-on-success (r5)' : (typeof ch.revertRefused === 'function' ? 'write-on-approve + revert (pre-r5)' : 'unknown model')}`);

function rng() { SEED = (SEED * 1103515245 + 12345) & 0x7fffffff; return SEED / 0x7fffffff; }
const pick = (a) => a[Math.floor(rng() * a.length)];

const WITHDRAWN = Symbol('withdrawn'); // r8: a nonce the mock outbox holds as discarded
const portStr = (h, c) => `127.0.0.1:${h}->${c}/tcp`;

/* ───────────────────────────── one simulated project ───────────────────────────── */
/*
 * r6: the project lives in the tree's REAL registry (scratch CLAUDE_STATION_DATA), and every settings write goes
 * through the tree's REAL `updateProject` — so the r6 edit-version stamping under test is the production code, not a
 * mirror. A fresh registry holding only this project per world.
 */
const REG_FILE = path.join(DATA, 'registry.json'); // src/lib/paths.ts registryFile() under CLAUDE_STATION_DATA
function freshRegistry(pid, initEnv, initPorts, createdAt = new Date().toISOString()) {
  const row = { id: pid, name: pid, hostPath: PROJ_DIR, isolation: 'container', settings: { model: null, effort: null, claudeAccount: null, maxBudgetUsd: null, permissionMode: 'default', allowedTools: [], disallowedTools: [], mounts: [], instructions: [], container: { gpu: 'off', env: { ...initEnv }, ports: initPorts.map((p) => ({ ...p })) } }, createdAt, updatedAt: createdAt };
  fs.writeFileSync(REG_FILE, JSON.stringify({ version: 1, projects: [row] }, null, 2));
}
function world(pid, initEnv = {}, initPorts = []) {
  freshRegistry(pid, initEnv, initPorts);
  const w = {
    pid,
    container: null, squatted: new Set(), enq: new Map(), attempts: 0, refusals: 0, logs: [],
    // r7 fault model: the outbox (nonce -> text; a changed payload under one nonce is a conflict, as in production),
    // per-id delivery counts, and the GROUND TRUTH of which requests a successful settings write committed.
    outbox: new Map(), enqCount: new Map(), nonceConflicts: 0, commitWrites: [],
  };
  w.project = () => regm.getProject(pid);
  Object.defineProperty(w, 'base', { get() { const cs = w.project().settings.container ?? {}; return { env: { ...(cs.env ?? {}) }, ports: (cs.ports ?? []).map((p) => ({ hostPort: p.hostPort, containerPort: p.containerPort })) }; } });
  /** What `docker create` would get for this project now: the tree's real createArgs (overlay included when the tree has one). */
  w.desired = () => {
    const a = cm.createArgs(w.project(), 'n', 'img', {});
    const env = {}; const ports = [];
    a.forEach((v, i) => {
      if (v === '--env') { const s = a[i + 1]; const k = s.slice(0, s.indexOf('=')); env[k] = s.slice(s.indexOf('=') + 1); }
      if (v === '-p') { const [, h, c] = a[i + 1].split(':'); ports.push({ hostPort: Number(h), containerPort: Number(c) }); }
    });
    return { env, ports };
  };
  w.container = w.desired();
  w.liveOf = () => (w.container ? { env: Object.entries(w.container.env).map(([k, v]) => `${k}=${v}`), ports: w.container.ports.map((p) => portStr(p.hostPort, p.containerPort)).sort() } : null);
  w.drift = () => {
    const d = w.desired(); const c = w.container;
    if (!c) return 'clean';
    const e1 = JSON.stringify(Object.entries(d.env).sort()); const e2 = JSON.stringify(Object.entries(c.env).sort());
    const p1 = d.ports.map((p) => portStr(p.hostPort, p.containerPort)).sort().join(','); const p2 = c.ports.map((p) => portStr(p.hostPort, p.containerPort)).sort().join(',');
    return e1 === e2 && p1 === p2 ? 'clean' : 'stale';
  };
  /** A settings write through the tree's real registry writer (opts.accessCommit: the access layer's commit). */
  w.writeBase = (env, ports, opts) => { regm.updateProject(pid, { settings: { container: { env: { ...env }, ports: ports.map((p) => ({ hostPort: p.hostPort, containerPort: p.containerPort })) } } }, opts); };
  return w;
}

/* ───────────────────────────── the index.ts wiring, per model ───────────────────────────── */
function wiring(w) {
  const parseDeps = {
    validateEnv: (e) => ({ ...e }),
    validatePorts: (x) => x.map((p) => ({ hostPort: p.hostPort, containerPort: p.containerPort })),
    currentEnv: () => ({ ...w.base.env }),
    currentPorts: () => w.base.ports.map((p) => ({ ...p })),
    desired: () => w.desired(),
  };
  const api = {
    raise(sid, body) {
      let changes;
      try { changes = ch.parseChanges(w.project(), body, parseDeps); } catch (e) { return { refused: e.message }; }
      // r8: the inbox binds the request to the incarnation of the project row it was raised against.
      const inc = typeof regm.incarnationOf === 'function' ? { projectIncarnation: regm.incarnationOf(w.project()) } : {};
      return { rec: acc.raiseAccess({ projectId: w.pid, projectName: w.pid, sdkSessionId: sid, reason: 'r', changes, conflicts: [], ...inc }) };
    },
    /** The decide route's approve, minus the advisory pre-checks (the simulated squats happen after approval). */
    approve(id) {
      const rec = acc.getAccess(id);
      for (const c of rec.changes) {
        if (c.kind !== 'env') continue;
        const now = Object.prototype.hasOwnProperty.call(w.base.env, c.key) ? w.base.env[c.key] : null;
        if (now !== c.previous && now !== c.value) return { status: 409, why: `stale ${c.key}` };
      }
      if (NEW) {
        const want = w.desired();
        if (rec.changes.some((c) => c.kind === 'port' && want.ports.some((x) => x.hostPort === c.hostPort && x.containerPort !== c.containerPort))) return { status: 400, why: 'port mapped elsewhere' };
        // r6 (index.ts decide route): the basis = the current edit versions of what it names, in the same step.
        if (R6) acc.beginDecision(id, 'approved', acc.basisFor(rec.changes, regm.accessEditsOf(w.project()), w.project().createdAt));
        else acc.beginDecision(id, 'approved');
      } else {
        const env = { ...w.base.env }; const ports = w.base.ports.map((p) => ({ ...p }));
        for (const c of rec.changes) {
          if (c.kind === 'env') env[c.key] = c.value;
          else if (!ports.some((x) => x.hostPort === c.hostPort && x.containerPort === c.containerPort)) {
            if (ports.some((x) => x.hostPort === c.hostPort)) return { status: 400, why: 'port mapped elsewhere' };
            ports.push({ hostPort: c.hostPort, containerPort: c.containerPort });
          }
        }
        acc.beginDecision(id, 'approved');
        w.writeBase(env, ports);
        acc.markApplied(id);
      }
      return { status: 200 };
    },
    reject(id) { acc.beginDecision(id, 'rejected'); return { status: 200 }; },
    /** The user's drawer save of container env/ports (PATCH). r6: the route only writes (the registry stamps). */
    userSave(env, ports) {
      if (NEW && !R6) {
        const sup = ch.supersededBy(acc.listApprovedPending(w.pid), { env, ports });
        if (sup.length) acc.markNotApplied(sup, 'superseded');
      }
      w.writeBase(env, ports);
    },
    /** docker refused `refused` host ports an attempt added (the chokepoint's hook). Returns true iff a retry can help. */
    onRefused(refused, reason, snapshot) {
      if (NEW) return ch.failRefused({ projectId: w.pid, refused, reason }, w.base.ports.map((p) => p.hostPort), (s) => w.logs.push(s), w.project()) === 'retry';
      return ch.revertRefused({ projectId: w.pid, refused, attemptEnv: snapshot.env, attemptPorts: snapshot.ports, reason }, {
        getProject: () => w.project(), currentEnv: () => ({ ...w.base.env }), currentPorts: () => w.base.ports.map((p) => ({ ...p })),
        writeContainer: (_p, env, ports) => w.writeBase(env, ports), log: (s) => w.logs.push(s),
      });
    },
    /** The reconciler at an idle moment: recreate if drifted (create-before-remove: a refused attempt keeps the old container). */
    recreate() {
      if (w.drift() !== 'stale') return 'clean';
      let tries = 0;
      for (;;) {
        w.attempts++;
        const want = w.desired();
        const had = new Set((w.container?.ports ?? []).map((p) => p.hostPort));
        const bad = want.ports.find((p) => !had.has(p.hostPort) && w.squatted.has(p.hostPort));
        if (!bad) { w.container = want; return 'applied'; }
        w.refusals++;
        const reason = `Bind for 127.0.0.1:${bad.hostPort} failed: port is already allocated`;
        const again = api.onRefused([{ hostPort: bad.hostPort, containerPort: bad.containerPort }], reason, want);
        const cap = NEW ? 32 : 1;
        if (!again || tries >= cap) return 'refused';
        tries++;
        if (w.drift() !== 'stale') return 'clean-after-refusal';
      }
    },
    /** Set to make the next commit's settings write throw (r6: "approved, but could not be saved"). */
    failCommit: null,
    /**
     * r7 — a one-shot FAULT at a write point of the next commit/delivery pass:
     *   'registry-fails'             the commit's settings write fails (the data dir is read-only from before it)
     *   'crash-after-settings'       the settings write lands, then the process dies: no later write of the pass lands
     *   'store-fails-after-settings' the settings write lands, then every access-store write fails (EACCES)
     *   'enqueue-fails'              the outbox refuses the message
     *   'store-fails-after-enqueue'  the message is in the outbox, then the store cannot record "queued"
     * Read-only = chmod 555 on the scratch data dir (registry AND access store live there), restored after the pass.
     */
    fault: null,
    /** r7 — the checker module to run (a fresh import models a server RESTART: no in-memory state survives). */
    chMod: ch,
    /** r8 — is the requesting session running? (index.ts liveSessionBySdk). Default false: the DELETE route closes a project's sessions. */
    sessionLive: () => false,
    check() {
      const fault = api.fault; api.fault = null;
      const ro = () => fs.chmodSync(DATA, 0o555);
      try {
        api.chMod.checkResumes({
          getProject: () => w.project(), accessDriftOf: () => w.drift(), rebuildPhaseOf: () => null, liveAccessOf: () => w.liveOf(),
          // index.ts commitBase, mirrored: fold onto the CURRENT base; r6 passes { accessCommit } (no edit version bump);
          // r7 builds the write with ch.commitPlanFor (ops + the committed set, ONE registry write).
          commitBase: (_p, recs) => {
            if (api.failCommit) throw new Error(api.failCommit);
            if (fault === 'registry-fails') ro();
            if (R7) {
              const cs = w.project().settings.container ?? {};
              const plan = api.chMod.commitPlanFor({ env: { ...(cs.env ?? {}) }, ports: (cs.ports ?? []).map((p) => ({ ...p })) }, w.project().accessCommitted ?? [], recs);
              w.writeBase(plan.env, plan.ports, { accessCommit: true, committed: plan.committed });
            } else {
              const f = acc.foldAccess({ env: w.base.env, ports: w.base.ports }, recs); w.writeBase(f.env, f.ports, { accessCommit: true });
            }
            w.commitWrites.push(recs.map((r) => r.id)); // ground truth: this settings write LANDED with these requests
            if (fault === 'crash-after-settings') { ro(); throw new Error('CRASH: the process died after the settings write'); }
            if (fault === 'store-fails-after-settings') ro();
          },
          reapply: () => {},
          enqueue: (rec, nonce, text) => {
            if (fault === 'enqueue-fails') throw new Error('outbox unavailable');
            const had = w.outbox.get(nonce);
            if (had === WITHDRAWN) return `row-${rec.id}`; // withdrawn: the outbox returns the discarded row, nothing is sent
            if (had !== undefined && had !== text) { w.nonceConflicts++; throw new Error('the outbox refuses a changed payload under one nonce'); }
            if (had === undefined) { w.outbox.set(nonce, text); w.enqCount.set(rec.id, (w.enqCount.get(rec.id) ?? 0) + 1); }
            w.enq.set(rec.id, text);
            if (fault === 'store-fails-after-enqueue') ro();
            return `row-${rec.id}`;
          },
          sessionLive: (rec) => api.sessionLive(rec),
          // r8: the outbox's discard under the same nonce (production createOutboxRow { discard: true }). A row the mock
          // outbox holds was handed over (delivered); a missing one is reserved withdrawn — a later enqueue under it never sends.
          withdraw: (rec, nonce) => {
            if (w.outbox.has(nonce)) return { state: w.outbox.get(nonce) === WITHDRAWN ? 'discarded' : 'delivered', rowId: `row-${rec.id}` };
            w.outbox.set(nonce, WITHDRAWN); return { state: 'discarded', rowId: `row-${rec.id}` };
          },
          log: (s) => w.logs.push(s),
        });
      } catch (e) { w.logs.push(`check threw: ${e.message}`); }
      finally { fs.chmodSync(DATA, 0o755); }
    },
    settle(n = 12) { for (let i = 0; i < n; i++) { api.recreate(); api.check(); } },
  };
  if (R6) cm.setAccessOverlay((p, b) => ch.overlayFor(p, b)); // index.ts r6 wiring, verbatim
  else if (NEW) {
    cm.setAccessOverlay((p, b) => { const recs = acc.pendingOverlayFor(p.id); if (recs === null) throw new Error('unreadable'); return recs.length ? acc.foldAccess(b, recs) : b; });
  }
  return api;
}

const env = (key, value, previous = null) => ({ key, value, previous });
const resetStore = () => { try { fs.rmSync(path.join(DATA, 'access-requests.json'), { force: true }); } catch { /* */ } };
const textOf = (w, id) => w.enq.get(id) ?? acc.getAccess(id)?.resume?.text ?? null;
const granted = (t) => /access granted/.test(t ?? '');
const notApplied = (t) => /could not be applied/.test(t ?? '');

/* ================================================================ W1-W4: the four recorded breaks */
console.log('\n--- W1: r3 (openai 01a17e35) — two pending requests set the SAME key to the SAME value, different ports; A\'s port refused');
{
  resetStore();
  const w = world('w1', { K: 'old' }); const api = wiring(w);
  const A = api.raise('sess-w1-aaaa', { env: { K: 'new' }, ports: [{ hostPort: 41011, containerPort: 8080 }] }).rec;
  const B = api.raise('sess-w1-bbbb', { env: { K: 'new' }, ports: [{ hostPort: 41012, containerPort: 8081 }] }).rec;
  api.approve(A.id); api.approve(B.id);
  w.squatted.add(41011);
  api.settle();
  check('W1 final settings = base + B only (K=new kept, 41012 published, 41011 not)', w.base.env.K === 'new' && w.base.ports.some((p) => p.hostPort === 41012) && !w.base.ports.some((p) => p.hostPort === 41011), w.base);
  check('W1b the container equals the settings', w.drift() === 'clean', { container: w.container, base: w.base });
  check('W1c A told "could not be applied"; B told "access granted"', notApplied(textOf(w, A.id)) && granted(textOf(w, B.id)), { A: textOf(w, A.id)?.slice(0, 90), B: textOf(w, B.id)?.slice(0, 90) });
}

console.log('\n--- W2: r4 (2aa4e78b) — A asks 42001+42002, B independently asks 42002; docker refuses 42001');
{
  resetStore();
  const w = world('w2'); const api = wiring(w);
  const A = api.raise('sess-w2-aaaa', { ports: [{ hostPort: 42001, containerPort: 8080 }, { hostPort: 42002, containerPort: 9000 }] }).rec;
  const B = api.raise('sess-w2-bbbb', { ports: [{ hostPort: 42002, containerPort: 9000 }] }).rec;
  api.approve(A.id); api.approve(B.id);
  w.squatted.add(42001);
  api.settle();
  check('W2 final settings keep B\'s 42002 (docker never refused it) and not A\'s 42001', w.base.ports.some((p) => p.hostPort === 42002) && !w.base.ports.some((p) => p.hostPort === 42001), w.base.ports);
  check('W2b the container publishes 42002', (w.container?.ports ?? []).some((p) => p.hostPort === 42002) && w.drift() === 'clean', w.container?.ports);
  check('W2c B told "access granted" (not "settings changed since"); A told "could not be applied"', granted(textOf(w, B.id)) && notApplied(textOf(w, A.id)), { A: textOf(w, A.id)?.slice(0, 90), B: textOf(w, B.id)?.slice(0, 120) });
}

console.log('\n--- W3: r4 room 1 (C1) — stale provenance: C applied K=new, the USER deleted K, then A sets K=new with a port docker refuses');
{
  resetStore();
  const w = world('w3'); const api = wiring(w);
  const C = api.raise('sess-w3-cccc', { env: { K: 'new' } }).rec;
  api.approve(C.id); api.settle();
  const cOk = w.base.env.K === 'new' && granted(textOf(w, C.id));
  const { K: _drop, ...rest } = w.base.env;
  api.userSave(rest, w.base.ports); api.settle();
  const A = api.raise('sess-w3-aaaa', { env: { K: 'new' }, ports: [{ hostPort: 43001, containerPort: 8080 }] }).rec;
  api.approve(A.id);
  w.squatted.add(43001);
  api.settle();
  check('W3 setup: C was applied and told "granted"; the user then deleted K', cOk && !!A, { cOk, A: !!A });
  check('W3 the user\'s delete stands: K is not in the settings, nor in the container', !('K' in w.base.env) && !('K' in (w.container?.env ?? {})), { base: w.base.env, container: w.container?.env });
  check('W3b A told "could not be applied" — and that is true', notApplied(textOf(w, A.id)), textOf(w, A.id)?.slice(0, 100));
}

console.log('\n--- W4: r4 room 1 (C2) — chained same-key refusals: A sets K old→new1 + P1, B sets K →new2 + P2; docker refuses P1, then P2');
{
  resetStore();
  const w = world('w4', { K: 'old' }); const api = wiring(w);
  const A = api.raise('sess-w4-aaaa', { env: { K: 'new1' }, ports: [{ hostPort: 44001, containerPort: 8080 }] }).rec;
  api.approve(A.id);
  const B = api.raise('sess-w4-bbbb', { env: { K: 'new2' }, ports: [{ hostPort: 44002, containerPort: 8081 }] }).rec;
  const bAp = api.approve(B.id);
  w.squatted.add(44001); w.squatted.add(44002);
  api.settle();
  check('W4 setup: both raised and approved', !!A && !!B && bAp.status === 200, { bAp });
  check('W4 neither applied → K is back to exactly the base ("old"), never A\'s refused "new1"', w.base.env.K === 'old' && w.base.ports.length === 0, w.base);
  check('W4b the container equals the settings; both requesters told "could not be applied"', w.drift() === 'clean' && notApplied(textOf(w, A.id)) && notApplied(textOf(w, B.id)), { drift: w.drift(), A: textOf(w, A.id)?.slice(0, 80), B: textOf(w, B.id)?.slice(0, 80) });
}

/* ================================================================ W5: the general case */
console.log(`\n--- W5: N concurrent requests, a random refused subset, random interleavings (${RUNS} runs, seed ${SEED})`);
{
  const KEYS = ['K1', 'K2', 'K3'];
  const HOSTS = [45001, 45002, 45003, 45004, 45005, 45006];
  const cport = (h) => 8000 + (h % 100);
  let violations = 0; let firstViolation = null; let refusedRuns = 0; let applied = 0; let failedN = 0; let rejected = 0;
  for (let run = 0; run < RUNS; run++) {
    resetStore();
    const initEnv = rng() < 0.5 ? { K1: 'base1' } : {};
    const w = world(`w5-${run}`, initEnv); const api = wiring(w);
    const N = 2 + Math.floor(rng() * 5);
    const reqs = Array.from({ length: N }, (_, i) => {
      const body = {};
      if (rng() < 0.8) { body.env = {}; for (const k of KEYS) if (rng() < 0.45) body.env[k] = pick(['a', 'b', 'c']); if (!Object.keys(body.env).length) body.env[pick(KEYS)] = pick(['a', 'b']); }
      if (rng() < 0.7) { const hs = [...new Set([pick(HOSTS), ...(rng() < 0.4 ? [pick(HOSTS)] : [])])]; body.ports = hs.map((h) => ({ hostPort: h, containerPort: cport(h) })); }
      if (!body.env && !body.ports) body.env = { K2: 'z' };
      return { i, body, sid: `sess-w5-${String(i).padStart(4, '0')}`, rec: null, verdict: null };
    });
    const squat = new Set(HOSTS.filter(() => rng() < 0.35));
    // A random interleaving: every request is raised then decided; reconciler passes, checker passes and the squats
    // (ports taken after approval) are scattered between them.
    const evs = [];
    for (const r of reqs) { evs.push({ t: 'raise', r }); evs.push({ t: 'decide', r }); }
    for (let k = 0; k < N * 2; k++) evs.push({ t: pick(['recreate', 'check', 'recreate']) });
    evs.push({ t: 'squat' });
    for (let k = evs.length - 1; k > 0; k--) { const j = Math.floor(rng() * (k + 1)); [evs[k], evs[j]] = [evs[j], evs[k]]; }
    const seen = new Set();
    const ordered = [];
    const deferred = [];
    for (const e of evs) { // keep raise before decide for the same request
      if (e.t === 'decide' && !seen.has(e.r.i)) { deferred.push(e); continue; }
      ordered.push(e); if (e.t === 'raise') { seen.add(e.r.i); const d = deferred.findIndex((x) => x.r.i === e.r.i); if (d >= 0) ordered.push(...deferred.splice(d, 1)); }
    }
    ordered.push(...deferred);
    for (const e of ordered) {
      if (e.t === 'raise') e.r.rec = api.raise(e.r.sid, e.r.body).rec ?? null;
      else if (e.t === 'decide') { if (!e.r.rec) continue; if (rng() < 0.12) { api.reject(e.r.rec.id); e.r.verdict = 'rejected'; } else { const a = api.approve(e.r.rec.id); e.r.verdict = a.status === 200 ? 'approved' : null; } }
      else if (e.t === 'squat') for (const h of squat) w.squatted.add(h);
      else if (e.t === 'recreate') api.recreate();
      else api.check();
    }
    for (const h of squat) w.squatted.add(h);
    api.settle(20);
    if (w.refusals) refusedRuns++;
    // ---- the invariant ----
    const why = [];
    const approved = reqs.filter((r) => r.verdict === 'approved').map((r) => ({ r, rec: acc.getAccess(r.rec.id) }));
    const committed = approved.filter((x) => granted(textOf(w, x.rec.id)));
    const told = (x) => textOf(w, x.rec.id);
    // (1) every decided requester has exactly one message, of the right kind
    for (const r of reqs.filter((q) => q.verdict === 'rejected')) if (!/denied/.test(textOf(w, r.rec.id) ?? '')) why.push(`${r.i} rejected but told ${String(textOf(w, r.rec.id)).slice(0, 40)}`);
    for (const x of approved) { const t = told(x); if (!granted(t) && !notApplied(t)) why.push(`${x.r.i} approved but told ${String(t).slice(0, 60)}`); }
    // (2) "could not be applied" is true: the request needed a port docker refused (a port in the squat set it added)
    for (const x of approved.filter((y) => notApplied(told(y)))) if (!x.rec.changes.some((c) => c.kind === 'port' && w.squatted.has(c.hostPort))) why.push(`${x.r.i} told not applied without a refused port`);
    // (3) "granted" is true: none of its ports refused, and every change is in the container unless a LATER-approved applied request set that key
    for (const x of committed) {
      for (const c of x.rec.changes) {
        if (c.kind === 'port') { if (!(w.container?.ports ?? []).some((p) => p.hostPort === c.hostPort && p.containerPort === c.containerPort)) why.push(`${x.r.i} granted but port ${c.hostPort} not in container`); continue; }
        if (w.container?.env?.[c.key] === c.value) continue;
        const later = committed.some((y) => y !== x && (y.rec.decision?.seq ?? 0) > (x.rec.decision?.seq ?? 0) && y.rec.changes.some((d) => d.kind === 'env' && d.key === c.key));
        if (!later) why.push(`${x.r.i} granted ${c.key}=${c.value} but container has ${w.container?.env?.[c.key]}`);
      }
    }
    // (4) final settings == base folded with EXACTLY the applied requests, in approval order (last wins)
    const order = [...committed].sort((a, b) => (a.rec.decision?.seq ?? 0) - (b.rec.decision?.seq ?? 0) || a.rec.decision.at.localeCompare(b.rec.decision.at));
    const want = { env: { ...initEnv }, ports: [] };
    for (const x of order) for (const c of x.rec.changes) { if (c.kind === 'env') want.env[c.key] = c.value; else if (!want.ports.some((p) => p.hostPort === c.hostPort)) want.ports.push({ hostPort: c.hostPort, containerPort: c.containerPort }); }
    const norm = (s) => JSON.stringify({ env: Object.entries(s.env).sort(), ports: s.ports.map((p) => `${p.hostPort}:${p.containerPort}`).sort() });
    if (norm(want) !== norm(w.base)) why.push(`settings ${norm(w.base)} != base+applied ${norm(want)}`);
    // (5) the container carries the settings, and every approved request whose ports were all free was applied
    if (w.drift() !== 'clean') why.push('container != settings after settling');
    for (const x of approved) if (!x.rec.changes.some((c) => c.kind === 'port' && w.squatted.has(c.hostPort)) && !granted(told(x))) why.push(`${x.r.i} had only free ports but was not applied`);
    applied += committed.length; failedN += approved.length - committed.length; rejected += reqs.filter((q) => q.verdict === 'rejected').length;
    if (why.length) { violations++; if (!firstViolation) firstViolation = { run, N, squat: [...squat], why: why.slice(0, 4), reqs: reqs.map((r) => ({ i: r.i, body: r.body, verdict: r.verdict })) }; }
  }
  check(`W5 the invariant holds over ${RUNS} random interleavings (settings = base + exactly the applied requests, last wins; container = settings; every message true)`, violations === 0, { violations, refusedRuns, applied, notAppliedCount: failedN, rejected, firstViolation });
  check('W5b the search exercised refusals (not a vacuous pass)', refusedRuns > RUNS / 4 && failedN > 0 && applied > 0, { refusedRuns, failedN, applied });
}

/* ================================================================ W6-W11 */
console.log('\n--- W6-W11: user edits, crash windows, a refused USER port, the retry bound');
if (!NEW) {
  check('W6-W11 the tree under test has the commit-on-success model (ch.failRefused / ch.supersededBy / acc.foldAccess)', false, 'absent: pre-r5 tree');
} else {
  {
    resetStore();
    const w = world('w6', { K: 'old' }); const api = wiring(w);
    const A = api.raise('sess-w6-aaaa', { env: { K: 'new' }, ports: [{ hostPort: 46001, containerPort: 8080 }] }).rec;
    api.approve(A.id);
    const before = JSON.stringify(w.base);
    check('W6 approval writes NOTHING to the settings (approved-pending only)', JSON.stringify(w.base) === before && w.base.env.K === 'old' && acc.isApprovedPending(acc.getAccess(A.id)), { base: w.base, rec: acc.getAccess(A.id).decision });
    check('W6b …but the desired config carries it (createArgs: K=new, -p 127.0.0.1:46001:8080)', w.desired().env.K === 'new' && w.desired().ports.some((p) => p.hostPort === 46001), w.desired());
    api.userSave({ K: 'mine' }, []);
    api.settle();
    check('W6c a user edit of K while A is pending supersedes/cancels A (whole record) and is NEVER masked or overwritten', w.base.env.K === 'mine' && w.container.env.K === 'mine' && !w.base.ports.length && /superseded|cancelled/.test(textOf(w, A.id) ?? ''), { base: w.base, container: w.container, A: textOf(w, A.id)?.slice(0, 120) });
  }
  {
    resetStore();
    const w = world('w7', { K: 'old', OTHER: '1' }); const api = wiring(w);
    const A = api.raise('sess-w7-aaaa', { env: { K: 'new' } }).rec;
    api.approve(A.id);
    api.userSave({ K: 'old', OTHER: '2' }, []); // an unrelated edit (K left as the card showed)
    api.settle();
    check('W7 an UNRELATED user edit does not supersede; both land (OTHER=2 kept, K=new committed)', w.base.env.OTHER === '2' && w.base.env.K === 'new' && granted(textOf(w, A.id)), { base: w.base, A: textOf(w, A.id)?.slice(0, 80) });
  }
  {
    resetStore();
    const w = world('w8', { K: 'old' }); const api = wiring(w);
    const A = api.raise('sess-w8-aaaa', { env: { K: 'new' }, ports: [{ hostPort: 48001, containerPort: 8080 }] }).rec;
    api.approve(A.id); api.recreate();
    // crash AFTER the settings write, BEFORE the record mark: write base by hand, never call markCommitted
    const f = acc.foldAccess(w.base, acc.listApprovedPending('w8')); w.writeBase(f.env, f.ports, { accessCommit: true }); // the commit's own write
    const d1 = JSON.stringify(w.desired());
    check('W8 crash between the settings write and the record mark: desired is unchanged (no drift → no recreate)', w.drift() === 'clean' && acc.isApprovedPending(acc.getAccess(A.id)), { drift: w.drift(), desired: d1 });
    const a0 = w.attempts; api.settle();
    check('W8b the next pass commits again as a no-op (idempotent): settings unchanged, record committed + told, no recreate', JSON.stringify(w.desired()) === d1 && w.base.ports.length === 1 && granted(textOf(w, A.id)) && w.attempts === a0, { base: w.base, A: textOf(w, A.id)?.slice(0, 60), attempts: w.attempts - a0 });
  }
  {
    resetStore();
    const w = world('w9'); const api = wiring(w);
    api.userSave({}, [{ hostPort: 49001, containerPort: 3000 }]); // the USER publishes a port…
    const A = api.raise('sess-w9-aaaa', { env: { NEEDED: 'yes' } }).rec;
    api.approve(A.id);
    w.squatted.add(49001); // …that something takes before the recreate
    api.settle();
    check('W9 a refused port the USER set is left in the settings (never removed behind the user\'s back)', w.base.ports.some((p) => p.hostPort === 49001), w.base.ports);
    check('W9b the pending request is not blamed (not failed, still pending); the previous container is kept', acc.isApprovedPending(acc.getAccess(A.id)) && !acc.getAccess(A.id).notApplied && !w.container.ports.some((p) => p.hostPort === 49001), { rec: acc.getAccess(A.id).notApplied ?? 'pending', container: w.container });
    const ch1 = ch.failRefused({ projectId: 'w9', refused: [{ hostPort: 49001, containerPort: 3000 }], reason: 'r' }, [49001], () => {});
    check('W9c the hook says "stop" (a retry cannot help), so the reconciler backs off instead of looping', ch1 === 'stop', ch1);
    api.userSave({}, []); api.settle();
    check('W9d once the user removes the port, the pending request applies and is committed', granted(textOf(w, A.id)) && w.base.env.NEEDED === 'yes', { A: textOf(w, A.id)?.slice(0, 60), base: w.base });
  }
  {
    resetStore();
    const w = world('w10'); const api = wiring(w);
    const ids = [];
    for (let i = 0; i < 8; i++) { const r = api.raise(`sess-w10-${String(i).padStart(4, '0')}`, { env: { K: `v${i}` }, ports: [{ hostPort: 47000 + i, containerPort: 9000 + i }] }).rec; api.approve(r.id); ids.push(r.id); w.squatted.add(47000 + i); }
    const r1 = api.recreate();
    check('W10 eight chained refusals in ONE reconciler pass terminate (each retry fails >= 1 request); all told; settings untouched', w.refusals === 8 && ids.every((id) => notApplied(acc.getAccess(id).resume?.text)) && Object.keys(w.base.env).length === 0, { refusals: w.refusals, outcome: r1 });
    const a0 = w.attempts; for (let i = 0; i < 10; i++) api.recreate();
    check('W11 no loop: after the refusals the desired config equals the container; 10 more idle passes attempt nothing', w.drift() === 'clean' && w.attempts === a0, { drift: w.drift(), attempts: w.attempts - a0 });
  }
  {
    resetStore();
    const w = world('w12'); const api = wiring(w);
    const A = api.raise('sess-w12-aaaa', { ports: [{ hostPort: 46501, containerPort: 8080 }] }).rec;
    api.approve(A.id);
    const B = api.raise('sess-w12-bbbb', { ports: [{ hostPort: 46501, containerPort: 9999 }] });
    check('W12 a request for a host port an approved-pending request already claims (another container port) is refused at raise', !!B.refused && /approved to be published/.test(B.refused), B);
  }
}

/* ================================================================ W13-W21: r6 — the user's edit wins, structurally */
console.log('\n--- W13-W21: r6 — user-edit SEQUENCES (IV r5 9095680c), save-write failure at commit, Cancel, no false cancel');
const cancelled = (t) => /was cancelled:/.test(t ?? '');
{
  resetStore();
  const w = world('w13', { K: 'old' }); const api = wiring(w);
  const A = api.raise('sess-w13-aaaa', { env: { K: 'new' } }).rec;
  api.approve(A.id); api.recreate(); // the container may already carry K=new (approved-pending)
  api.userSave({ K: 'new' }, []); api.userSave({ K: 'old' }, []); // change and change back
  api.settle();
  check('W13 (r5 seq 1) K old→new→old by the user while A (old→new) is approved-pending: K stays "old" in settings AND container', w.base.env.K === 'old' && w.container?.env?.K === 'old', { base: w.base.env, container: w.container?.env });
  check('W13b A is told "cancelled: … edited env K …", never "granted"', cancelled(textOf(w, A.id)) && /env K/.test(textOf(w, A.id) ?? '') && !granted(textOf(w, A.id)), textOf(w, A.id)?.slice(0, 200));
}
{
  resetStore();
  const w = world('w14'); const api = wiring(w);
  const A = api.raise('sess-w14-aaaa', { env: { K: 'new' } }).rec;
  api.approve(A.id); api.recreate();
  api.userSave({ K: 'new' }, []); api.userSave({}, []); // add then delete
  api.settle();
  check('W14 (r5 seq 2) the user adds K=new then deletes K while A (add K=new) is approved-pending: K absent from settings AND container', !('K' in w.base.env) && !('K' in (w.container?.env ?? {})), { base: w.base.env, container: w.container?.env });
  check('W14b A is told "cancelled"', cancelled(textOf(w, A.id)), textOf(w, A.id)?.slice(0, 160));
}
{
  resetStore();
  const w = world('w15'); const api = wiring(w);
  const A = api.raise('sess-w15-aaaa', { ports: [{ hostPort: 47701, containerPort: 8080 }] }).rec;
  api.approve(A.id); api.recreate();
  api.userSave({}, [{ hostPort: 47701, containerPort: 8080 }]); api.userSave({}, []); // publish the same, then remove it
  api.settle();
  check('W15 (r5 seq 3) the user publishes 47701→8080 then removes it while A (same publish) is approved-pending: not in settings, not published', !w.base.ports.some((p) => p.hostPort === 47701) && !(w.container?.ports ?? []).some((p) => p.hostPort === 47701), { base: w.base.ports, container: w.container?.ports });
  check('W15b A is told "cancelled: … port 127.0.0.1:47701 …"', cancelled(textOf(w, A.id)) && /47701/.test(textOf(w, A.id) ?? ''), textOf(w, A.id)?.slice(0, 200));
}
{
  resetStore();
  const w = world('w16', { K: 'old' }); const api = wiring(w);
  const A = api.raise('sess-w16-aaaa', { env: { K: 'new' } }).rec;
  api.approve(A.id); api.recreate();
  api.failCommit = 'EACCES: permission denied, open registry.json.tmp';
  api.check();
  api.failCommit = null;
  const t = textOf(w, A.id);
  check('W16 the settings write fails at commit: A is told "approved, but could not be saved: <reason>", never "superseded"/"granted"', /approved, but could not be saved: .*EACCES/.test(t ?? '') && !/supersed/.test(t ?? '') && !granted(t), t?.slice(0, 200));
  api.settle();
  check('W16b nothing was saved and the container is rebuilt to the saved settings (K=old), with no loop', w.base.env.K === 'old' && w.container?.env?.K === 'old' && w.drift() === 'clean' && acc.getAccess(A.id)?.notApplied?.cause === 'save-failed', { base: w.base.env, container: w.container?.env, cause: acc.getAccess(A.id)?.notApplied?.cause });
}
{
  resetStore();
  const w = world('w17', { K: 'old' }); const api = wiring(w);
  const U = api.raise('sess-w17-uuuu', { env: { Q: '1' } }).rec;
  const A = api.raise('sess-w17-aaaa', { env: { K: 'new' }, ports: [{ hostPort: 47801, containerPort: 8080 }] }).rec;
  api.approve(A.id); api.recreate();
  const has = typeof ch.cancelByUser === 'function';
  const r1 = has ? ch.cancelByUser(A.id, 'w17') : { ok: false, error: 'no cancelByUser in this tree' };
  const r2 = has ? ch.cancelByUser(A.id, 'w17') : null;
  const r3 = has ? ch.cancelByUser(U.id, 'w17') : null;
  const r4 = has ? ch.cancelByUser(A.id, 'other-project') : null;
  check('W17 Cancel on an approved-pending card: ok, A told "cancelled", out of the desired config at once', r1.ok === true && cancelled(textOf(w, A.id)) && w.desired().env.K === 'old' && !w.desired().ports.length, { r1: r1.ok ?? r1, text: textOf(w, A.id)?.slice(0, 120), desired: w.desired() });
  check('W17b a second Cancel, a Cancel on an UNDECIDED request, and a Cancel naming another project are refused', r2?.ok === false && r2.code === 'not-pending' && r3?.ok === false && r3.code === 'not-pending' && r4?.ok === false && r4.code === 'unknown', { r2, r3, r4 });
  api.settle();
  check('W17c after settling: settings untouched (K=old), container rebuilt without it', w.base.env.K === 'old' && w.container?.env?.K === 'old' && !(w.container?.ports ?? []).length, { base: w.base, container: w.container });
  const B = api.raise('sess-w17-bbbb', { env: { Z: '1' } }).rec;
  api.approve(B.id); api.settle();
  const r5 = has ? ch.cancelByUser(B.id, 'w17') : null;
  check('W17d a COMMITTED request cannot be cancelled (nothing is re-opened)', r5?.ok === false && r5.code === 'not-pending' && granted(textOf(w, B.id)), { r5, B: textOf(w, B.id)?.slice(0, 60) });
}
{
  resetStore();
  const w = world('w18', { K: 'old', OTHER: '1' }); const api = wiring(w);
  const A = api.raise('sess-w18-aaaa', { env: { K: 'new' }, ports: [{ hostPort: 47901, containerPort: 8080 }] }).rec;
  api.approve(A.id);
  api.userSave({ K: 'old', OTHER: '1' }, []); // the drawer re-sends the whole unchanged map (e.g. a memory change)
  api.userSave({ K: 'old', OTHER: '2' }, [{ hostPort: 47902, containerPort: 9000 }]); // unrelated key + unrelated port
  api.settle();
  check('W18 no false cancel: an unchanged re-send and unrelated key/port edits leave A live; A commits; the user edits land', granted(textOf(w, A.id)) && w.base.env.K === 'new' && w.base.env.OTHER === '2' && w.base.ports.some((p) => p.hostPort === 47902) && w.base.ports.some((p) => p.hostPort === 47901), { base: w.base, A: textOf(w, A.id)?.slice(0, 80) });
}
{
  resetStore();
  const w = world('w19', { K: 'old' }); const api = wiring(w);
  const A = api.raise('sess-w19-aaaa', { env: { K: 'new' } }).rec;
  api.userSave({ K: 'x' }, []); api.userSave({ K: 'old' }, []); // edits BEFORE the approval (the card still shows old)
  const ap = api.approve(A.id); api.settle();
  check('W19 edits made BEFORE approving do not cancel it (the basis is taken at approval)', ap.status === 200 && granted(textOf(w, A.id)) && w.base.env.K === 'new', { ap, A: textOf(w, A.id)?.slice(0, 60), base: w.base.env });
}
{
  resetStore();
  const w = world('w20', { K: 'old' }); const api = wiring(w);
  const A = api.raise('sess-w20-aaaa', { env: { K: 'new' } }).rec;
  api.approve(A.id);
  // A user save whose registry write FAILS stamps nothing (the stamp is in the same atomic write).
  fs.chmodSync(DATA, 0o555);
  let threw = null;
  try { api.userSave({ K: 'mine' }, []); } catch (e) { threw = e.code ?? e.message; }
  fs.chmodSync(DATA, 0o755);
  const rec = acc.getAccess(A.id);
  check('W20 a user save whose registry write fails changes nothing: no edit stamped, A still live (not told "cancelled" for an edit that never landed)', !!threw && w.base.env.K === 'old' && acc.isApprovedPending(rec) && (!R6 || ch.liveFor(rec, w.project())), { threw, base: w.base.env, pending: acc.isApprovedPending(rec) });
  api.settle();
  check('W20b …and A then commits normally', granted(textOf(w, A.id)) && w.base.env.K === 'new', textOf(w, A.id)?.slice(0, 60));
}
{
  resetStore();
  const w = world('w21', { K: 'old' }); const api = wiring(w);
  const A = api.raise('sess-w21-aaaa', { env: { K: 'new' } }).rec;
  api.approve(A.id);
  freshRegistry('w21', { K: 'old' }, [], new Date(Date.now() + 5000).toISOString()); // removed and added again under the same id
  api.settle();
  // r8 (design review 8e184b1e): a removed + re-added project is NOT a user edit; the request is closed "removed, not in
  // effect" (r6/r7 said "cancelled: the user edited the project itself", which IV r7 turned into a false "never written").
  const t21 = textOf(w, A.id);
  check('W21 a project removed and re-added under the same id does not inherit an approval made for the old one', (R8 ? removedText(t21) && !cancelled(t21) : cancelled(t21)) && w.base.env.K === 'old', { A: t21?.slice(0, 140), base: w.base.env });
}

/* ================================================================ W22: W5 with random USER SAVES mixed in */
console.log(`\n--- W22: random interleavings WITH random user saves (env set/change/delete/restore, port add/remove) (${RUNS} runs)`);
{
  const KEYS = ['K1', 'K2', 'K3'];
  const HOSTS = [45101, 45102, 45103, 45104, 45105, 45106];
  const cport = (h) => 8000 + (h % 100);
  let violations = 0; let firstViolation = null; let userSaves = 0; let cancels = 0; let applied = 0; let undoneWould = 0;
  for (let run = 0; run < RUNS; run++) {
    resetStore();
    const initEnv = rng() < 0.5 ? { K1: 'base1' } : {};
    const w = world(`w22-${run}`, initEnv); const api = wiring(w);
    const N = 2 + Math.floor(rng() * 4);
    const reqs = Array.from({ length: N }, (_, i) => {
      const body = {};
      if (rng() < 0.8) { body.env = {}; for (const k of KEYS) if (rng() < 0.45) body.env[k] = pick(['a', 'b', 'c']); if (!Object.keys(body.env).length) body.env[pick(KEYS)] = pick(['a', 'b']); }
      if (rng() < 0.6) { const hs = [...new Set([pick(HOSTS), ...(rng() < 0.4 ? [pick(HOSTS)] : [])])]; body.ports = hs.map((h) => ({ hostPort: h, containerPort: cport(h) })); }
      if (!body.env && !body.ports) body.env = { K2: 'z' };
      return { i, body, sid: `sess-w22-${String(i).padStart(4, '0')}`, rec: null, verdict: null };
    });
    const squat = new Set(HOSTS.filter(() => rng() < 0.3));
    const evs = [];
    for (const r of reqs) { evs.push({ t: 'raise', r }); evs.push({ t: 'decide', r }); }
    for (let k = 0; k < N * 2; k++) evs.push({ t: pick(['recreate', 'check', 'recreate']) });
    const nUser = 1 + Math.floor(rng() * 5);
    for (let k = 0; k < nUser; k++) evs.push({ t: 'user' });
    evs.push({ t: 'squat' });
    for (let k = evs.length - 1; k > 0; k--) { const j = Math.floor(rng() * (k + 1)); [evs[k], evs[j]] = [evs[j], evs[k]]; }
    const seen = new Set(); const ordered = []; const deferred = [];
    for (const e of evs) {
      if (e.t === 'decide' && !seen.has(e.r.i)) { deferred.push(e); continue; }
      ordered.push(e); if (e.t === 'raise') { seen.add(e.r.i); const d = deferred.findIndex((x) => x.r.i === e.r.i); if (d >= 0) ordered.push(...deferred.splice(d, 1)); }
    }
    ordered.push(...deferred);
    // The oracle's log: user saves (what they touched, the exact state written), approvals, commits (batches).
    const log = [];
    const committedIds = () => new Set(acc.listAccessForProject(w.pid).filter((r) => r.decision?.verdict === 'approved' && r.decision.applied === true && !r.notApplied).map((r) => r.id));
    let before = committedIds();
    const noteCommits = () => { const now = committedIds(); const fresh = [...now].filter((id) => !before.has(id)); if (fresh.length) log.push({ t: 'commit', ids: fresh }); before = now; };
    function doSave(b, env, ports) {
      const touched = new Set();
      for (const k of new Set([...Object.keys(b.env), ...Object.keys(env)])) if (b.env[k] !== env[k]) touched.add(`env ${k}`);
      const m = (l) => new Map(l.map((p) => [p.hostPort, p.containerPort]));
      const bm = m(b.ports); const am = m(ports);
      for (const h of new Set([...bm.keys(), ...am.keys()])) if (bm.get(h) !== am.get(h)) touched.add(`port ${h}`);
      api.userSave(env, ports); userSaves++;
      log.push({ t: 'user', touched, after: { env: { ...env }, ports: ports.map((p) => ({ ...p })) } });
    }
    const userSave = () => {
      const b = w.base; const env = { ...b.env }; let ports = b.ports.map((p) => ({ ...p }));
      if (rng() < 0.6) {
        const k = pick(KEYS); const op = rng();
        if (op < 0.3) delete env[k]; else env[k] = pick(['a', 'b', 'c', 'u', b.env[k] ?? 'u']);
        if (rng() < 0.3) { // change-and-change-back in two saves
          doSave(b, { ...env, [k]: 'tmp' }, ports); doSave(w.base, b.env, ports); return;
        }
      } else {
        const free = HOSTS.filter((h) => !squat.has(h));
        if (!free.length) return;
        const h = pick(free);
        if (ports.some((p) => p.hostPort === h)) ports = ports.filter((p) => p.hostPort !== h); else ports.push({ hostPort: h, containerPort: cport(h) });
      }
      doSave(b, env, ports);
    };
    const origCheck = api.check; api.check = () => { origCheck(); noteCommits(); };
    for (const e of ordered) {
      if (e.t === 'raise') e.r.rec = api.raise(e.r.sid, e.r.body).rec ?? null;
      else if (e.t === 'decide') { if (!e.r.rec) continue; if (rng() < 0.12) { api.reject(e.r.rec.id); e.r.verdict = 'rejected'; } else { const a = api.approve(e.r.rec.id); e.r.verdict = a.status === 200 ? 'approved' : null; if (e.r.verdict) log.push({ t: 'approve', id: e.r.rec.id }); } }
      else if (e.t === 'squat') for (const h of squat) w.squatted.add(h);
      else if (e.t === 'recreate') api.recreate();
      else if (e.t === 'user') userSave();
      else api.check();
    }
    for (const h of squat) w.squatted.add(h);
    api.settle(20);
    // ---- the oracle ----
    const why = [];
    const recOf = (id) => acc.getAccess(id);
    const names = (rec) => rec.changes.map((c) => (c.kind === 'env' ? `env ${c.key}` : `port ${c.hostPort}`));
    // (U1) a user edit is NEVER undone: no committed request names something a user save touched between its approval and its commit.
    // (U2) "cancelled" is true: such a save exists for every request told "cancelled".
    const idxOf = (pred) => log.findIndex(pred);
    for (const r of reqs.filter((q) => q.verdict === 'approved')) {
      const rec = recOf(r.rec.id); const t = textOf(w, rec.id);
      const ai = idxOf((e) => e.t === 'approve' && e.id === rec.id);
      const ci = idxOf((e) => e.t === 'commit' && e.ids.includes(rec.id));
      const end = ci >= 0 ? ci : log.length;
      const touchedBetween = log.slice(ai + 1, end).some((e) => e.t === 'user' && names(rec).some((n) => e.touched.has(n)));
      if (ci >= 0 && touchedBetween) { why.push(`${r.i} committed over a user edit of ${names(rec).join(',')}`); undoneWould++; }
      if (cancelled(t) && !touchedBetween) why.push(`${r.i} told cancelled but no user edit touched it`);
      if (!cancelled(t) && !granted(t) && !notApplied(t)) why.push(`${r.i} approved but told ${String(t).slice(0, 60)}`);
      if (cancelled(t)) cancels++;
      if (granted(t)) applied++;
      // (U3) an approved request that was neither refused nor touched by the user is applied
      if (!touchedBetween && !rec.changes.some((c) => c.kind === 'port' && w.squatted.has(c.hostPort)) && !granted(t)) why.push(`${r.i} untouched, free ports, but not applied: ${String(t).slice(0, 60)}`);
    }
    for (const r of reqs.filter((q) => q.verdict === 'rejected')) if (!/denied/.test(textOf(w, r.rec.id) ?? '')) why.push(`${r.i} rejected but told ${String(textOf(w, r.rec.id)).slice(0, 40)}`);
    // (U4) final settings = replay of the log: user saves write exactly what they wrote; commits fold their batch in approval order.
    const st = { env: { ...initEnv }, ports: [] };
    for (const e of log) {
      if (e.t === 'user') { st.env = { ...e.after.env }; st.ports = e.after.ports.map((p) => ({ ...p })); }
      else if (e.t === 'commit') {
        const recs = e.ids.map(recOf).sort((a, b) => (a.decision?.seq ?? 0) - (b.decision?.seq ?? 0));
        for (const rec of recs) for (const c of rec.changes) { if (c.kind === 'env') st.env[c.key] = c.value; else { const i = st.ports.findIndex((p) => p.hostPort === c.hostPort); if (i >= 0) st.ports[i] = { hostPort: c.hostPort, containerPort: c.containerPort }; else st.ports.push({ hostPort: c.hostPort, containerPort: c.containerPort }); } }
      }
    }
    const norm = (x) => JSON.stringify({ env: Object.entries(x.env).sort(), ports: x.ports.map((p) => `${p.hostPort}:${p.containerPort}`).sort() });
    if (norm(st) !== norm(w.base)) why.push(`settings ${norm(w.base)} != replay ${norm(st)}`);
    // (U5) the container equals the settings once settled
    if (w.drift() !== 'clean') why.push('container != settings after settling');
    if (why.length) { violations++; if (!firstViolation) firstViolation = { run, why: why.slice(0, 4), log: log.map((e) => (e.t === 'user' ? `user ${[...e.touched].join(',')}` : e.t === 'commit' ? `commit ${e.ids.join(',')}` : `approve ${e.id}`)) }; }
  }
  check(`W22 with user saves mixed in, over ${RUNS} random interleavings: a user edit is never undone, "cancelled" is always true, settings = replay, container = settings`, violations === 0, { violations, userSaves, cancels, applied, undoneWould, firstViolation });
  check('W22b the search exercised user saves that hit pending requests (not a vacuous pass)', userSaves > RUNS && (cancels > 0 || undoneWould > 0) && applied > 0, { userSaves, cancels, undoneWould, applied });
}

/* ================================================================ W23-W29: r7 — "committed" is atomic with the settings write */
console.log('\n--- W23-W29: r7 — the commit two-write window (IV r6 91a246ca): crash / store failure between the settings write and the record mark');
/** "None of it was applied" / "never written" / "could not be applied|saved" / "superseded": a claim that the request is NOT in the settings. */
const claimsNotWritten = (t) => /None of it was applied|never written to the project settings|could not be applied|could not be saved|superseded/.test(t ?? '');
const inSettings = (w, rec) => rec.changes.some((c) => (c.kind === 'env' ? w.base.env[c.key] === c.value : w.base.ports.some((p) => p.hostPort === c.hostPort && p.containerPort === c.containerPort)));
for (const [tag, fault] of [['W23', 'crash-after-settings'], ['W24', 'store-fails-after-settings']]) {
  resetStore();
  const pid = tag.toLowerCase();
  const w = world(pid, { K: 'old' }); const api = wiring(w);
  const A = api.raise(`sess-${pid}-aaaa`, { env: { K: 'new' }, ports: [{ hostPort: 48101, containerPort: 8080 }] }).rec;
  api.approve(A.id); api.recreate();
  api.fault = fault; api.check(); // the commit: settings written, then the record mark is lost
  const wrote = w.commitWrites.some((ids) => ids.includes(A.id));
  api.userSave({ K: 'mine' }, w.base.ports); // the user then edits ONE named key (the port stays as the commit wrote it)
  api.settle();
  const t = textOf(w, A.id);
  check(`${tag} (${fault}) then a user edit of K: the settings write landed (precondition) and the port is in settings AND container`, wrote && w.base.ports.some((p) => p.hostPort === 48101) && (w.container?.ports ?? []).some((p) => p.hostPort === 48101) && w.base.env.K === 'mine', { wrote, base: w.base, container: w.container });
  check(`${tag}b the requester is told the TRUTH: approved and in the settings (never "cancelled" / "None of it was applied" / "never written")`, !!t && !cancelled(t) && !claimsNotWritten(t) && /approved|access granted/.test(t), t?.slice(0, 260));
  check(`${tag}c its message says the port is in place and env K=new is not (the user's K=mine stands)`, /48101/.test(t ?? '') && /K=new/.test(t ?? '') && /not in the container now/.test(t ?? '') && w.container?.env?.K === 'mine', t?.slice(0, 260));
  check(`${tag}d told exactly once (one outbox row, no changed payload under its nonce)`, (w.enqCount.get(A.id) ?? 0) === 1 && w.nonceConflicts === 0, { enq: w.enqCount.get(A.id), conflicts: w.nonceConflicts });
}
{
  resetStore();
  const w = world('w25', { K: 'old' }); const api = wiring(w);
  const A = api.raise('sess-w25-aaaa', { env: { K: 'new' }, ports: [{ hostPort: 48201, containerPort: 8080 }] }).rec;
  api.approve(A.id); api.recreate();
  api.fault = 'crash-after-settings'; api.check();
  // RESTART: a fresh access-channel module (no in-memory state survives); the files are what they are.
  api.chMod = await import(`${url.pathToFileURL(path.join(ROOT, 'src/server/access-channel.ts')).href}?restart=${Date.now()}`);
  const a0 = w.attempts;
  api.settle();
  const t = textOf(w, A.id);
  check('W25 crash after the settings write, before any message; on restart the requester gets "access granted" EXACTLY ONCE', granted(t) && (w.enqCount.get(A.id) ?? 0) === 1 && w.nonceConflicts === 0, { t: t?.slice(0, 120), enq: w.enqCount.get(A.id) });
  check('W25b no recreate and no second settings change on restart (the commit is not re-applied over anything)', w.attempts === a0 && w.base.env.K === 'new' && w.base.ports.length === 1 && w.drift() === 'clean', { attempts: w.attempts - a0, base: w.base });
}
if (R7) {
  resetStore();
  const w = world('w26', { K: 'old' }); const api = wiring(w);
  const A = api.raise('sess-w26-aaaa', { env: { K: 'new' }, ports: [{ hostPort: 48301, containerPort: 8080 }] }).rec;
  api.approve(A.id); api.recreate();
  api.fault = 'store-fails-after-settings'; api.check();
  const rec = acc.getAccess(A.id);
  const setHas = (w.project().accessCommitted ?? []).includes(A.id);
  // Every OTHER door that could reclassify it, tried while the store still says approved-pending:
  const c1 = ch.cancelByUser(A.id, 'w26');
  const f1 = ch.failRefused({ projectId: 'w26', refused: [{ hostPort: 48301, containerPort: 8080 }], reason: 'Bind for 127.0.0.1:48301 failed: port is already allocated' }, [], () => {}, w.project());
  const n1 = acc.markNotApplied([{ id: A.id, reason: 'x', text: 'None of it was applied' }], 'cancelled');
  const ov = ch.overlayFor(w.project(), { env: {}, ports: [] });
  check('W26 the committed set rides in the settings write: A is in it while the store mark was lost', setHas && rec.decision?.applied === false, { setHas, applied: rec.decision?.applied });
  check('W26b no door reclassifies a request in the committed set: Cancel refused, docker-refusal handler and markNotApplied skip it, the overlay drops it', c1.ok === false && c1.code === 'not-pending' && n1.length === 0 && !acc.getAccess(A.id).notApplied && !Object.keys(ov.env).length && !ov.ports.length, { c1, f1, n1, ov });
  api.userSave({ K: 'mine', EXTRA: '1' }, w.base.ports); // a user write
  check('W26c a user save keeps the committed set (only the commit writes it; a patch cannot set it)', (w.project().accessCommitted ?? []).includes(A.id), w.project().accessCommitted);
  regm.updateProject('w26', { accessCommitted: ['forged-id'], settings: { container: { env: { K: 'mine', EXTRA: '2' } } } });
  check('W26d a patch carrying accessCommitted is ignored', !(w.project().accessCommitted ?? []).includes('forged-id') && (w.project().accessCommitted ?? []).includes(A.id), w.project().accessCommitted);
  api.settle();
  check('W26e the next pass reconciles the store FROM the settings record: marked committed and told the truth', acc.getAccess(A.id).decision?.applied === true && !claimsNotWritten(textOf(w, A.id)) && (w.enqCount.get(A.id) ?? 0) === 1, { applied: acc.getAccess(A.id).decision?.applied, set: w.project().accessCommitted, t: textOf(w, A.id)?.slice(0, 120) });
  const ids = [];
  for (let i = 0; i < 6; i++) { const r = api.raise(`sess-w26-${String(i).padStart(4, '0')}`, { env: { [`Z${i}`]: '1' } }).rec; api.approve(r.id); api.settle(); ids.push(r.id); }
  // An id leaves on the NEXT commit after its store mark lands, so the set holds at most the latest commit's ids.
  const setNow = w.project().accessCommitted ?? [];
  check('W26f the committed set stays bounded: after 6 more commits it holds only the latest commit\'s id (A and the earlier ones pruned)', setNow.length === 1 && setNow[0] === ids[5] && ids.every((id) => granted(textOf(w, id))), setNow);
} else {
  check('W26 the tree under test writes "committed" inside the settings write (ch.commitPlanFor + registry accessCommitted)', false, 'absent');
}
{
  resetStore();
  const w = world('w27', { K: 'old' }); const api = wiring(w);
  const A = api.raise('sess-w27-aaaa', { env: { K: 'new' } }).rec;
  api.approve(A.id); api.recreate();
  api.fault = 'registry-fails'; api.check();
  const t1 = textOf(w, A.id);
  check('W27 the settings write itself fails: nothing written, A never told "granted" (no false claim either way)', w.base.env.K === 'old' && !granted(t1) && !w.commitWrites.some((ids) => ids.includes(A.id)), { base: w.base.env, t: t1?.slice(0, 120) });
  api.settle();
  const t2 = textOf(w, A.id);
  const truthful = (granted(t2) && w.base.env.K === 'new') || (/could not be saved/.test(t2 ?? '') && w.base.env.K === 'old');
  check('W27b …and whatever it is finally told matches the settings (granted with K=new saved, or "could not be saved" with K=old)', truthful && w.drift() === 'clean', { t: t2?.slice(0, 120), base: w.base.env });
}
{
  resetStore();
  const w = world('w28', { K: 'old' }); const api = wiring(w);
  const A = api.raise('sess-w28-aaaa', { env: { K: 'new' } }).rec;
  api.approve(A.id); api.recreate();
  api.fault = 'store-fails-after-enqueue'; api.check(); // in the outbox, "queued" never recorded
  api.settle();
  check('W28 the message reached the outbox but "queued" was lost: re-delivery reuses the SAME text (one row, no payload conflict)', granted(textOf(w, A.id)) && (w.enqCount.get(A.id) ?? 0) === 1 && w.nonceConflicts === 0, { enq: w.enqCount.get(A.id), conflicts: w.nonceConflicts });
}

if (R7) {
  // W30 — the registry is the owner of "committed": a TRUNCATED/unreadable registry read must never let a caller claim
  // "not applied" (committedInSettings → null → markNotApplied skips). Real registry bytes, cut at several points.
  resetStore();
  const w = world('w30', { K: 'old' }); const api = wiring(w);
  const A = api.raise('sess-w30-aaaa', { env: { K: 'new' } }).rec;
  api.approve(A.id); api.recreate();
  api.fault = 'store-fails-after-settings'; api.check();
  const full = fs.readFileSync(REG_FILE, 'utf8');
  const cuts = [1, Math.floor(full.length / 4), Math.floor(full.length / 2), full.length - 2];
  const outs = cuts.map((n) => { fs.writeFileSync(REG_FILE, full.slice(0, n)); const r = acc.markNotApplied([{ id: A.id, reason: 'x', text: 'None of it was applied' }], 'cancelled'); return { n, marked: r.length, committed: acc.committedInSettings(acc.getAccess(A.id)) }; });
  fs.writeFileSync(REG_FILE, full);
  check('W30 a truncated registry (cut at 4 points) reads as "committed unknown" and no "not applied" mark is written', outs.every((o) => o.marked === 0 && o.committed === null) && !acc.getAccess(A.id).notApplied, outs);
  api.settle();
  check('W30b with the registry whole again, the record is reconciled as committed and told once', acc.getAccess(A.id).decision?.applied === true && granted(textOf(w, A.id)) && (w.enqCount.get(A.id) ?? 0) === 1, textOf(w, A.id)?.slice(0, 80));
}

{
  // W31 — the crash window, then the PROJECT is removed: its settings record (and committed set) are gone, so whether a
  // commit landed is unknowable; the requester must not be told "None of it was applied / never written".
  resetStore();
  const w = world('w31', { K: 'old' }); const api = wiring(w);
  const A = api.raise('sess-w31-aaaa', { env: { K: 'new' }, ports: [{ hostPort: 48401, containerPort: 8080 }] }).rec;
  api.approve(A.id); api.recreate();
  api.fault = 'crash-after-settings'; api.check();
  regm.deleteProject('w31');
  api.check();
  const t = textOf(w, A.id);
  check('W31 crash window then the project is removed: told it is not in effect, never "None of it was applied" / "never written"', !!t && !claimsNotWritten(t.replace(/superseded/g, '')) && !/None of it was applied|never written/.test(t) && !granted(t), t?.slice(0, 200));
}

/* ================================================================ W32-W35: r8 — project INCARNATION (IV r7 7b08ede8: delete + re-add under the same id) */
console.log('\n--- W32-W35: r8 — a project removed and RE-ADDED under the same id (real registry deleteProject + createProject) inside the lost-mark window');
/** The DELETE route + POST /api/projects with the same name, through the tree's REAL registry functions (same id: slugify(name)). */
function readd(pid, initEnv = { K: 'old' }) {
  regm.deleteProject(pid);
  const p = regm.createProject({ name: pid, hostPath: PROJ_DIR, isolation: 'container', settings: { tools: { playwright: false, serena: false, openaiDispatch: false }, laneDocker: 'sandbox', container: { gpu: 'off', env: { ...initEnv }, ports: [] } } });
  if (p.id !== pid) throw new Error(`re-add produced id ${p.id}, not ${pid}`);
  return p;
}
for (const [tag, fault] of [['W32', 'store-fails-after-settings'], ['W32x', 'crash-after-settings']]) {
  // W32 — IV r7's exact shape (run b1ee192603dc): the commit's settings write lands (R in the committed set), the store
  // mark is lost, the project is removed and re-added under the same id before the next pass.
  resetStore();
  const pid = tag.toLowerCase();
  const w = world(pid, { K: 'old' }); const api = wiring(w);
  const A = api.raise(`sess-${pid}-aaaa`, { env: { K: 'new' }, ports: [{ hostPort: 48777, containerPort: 8080 }] }).rec;
  api.approve(A.id); api.recreate();
  api.fault = fault; api.check();
  const wrote = w.commitWrites.some((ids) => ids.includes(A.id));
  readd(pid);
  api.settle();
  const t = textOf(w, A.id);
  check(`${tag} (${fault}) precondition: the commit's settings write landed, then the project was re-added under the same id`, wrote && w.project()?.id === pid, { wrote });
  check(`${tag}b the requester is never told "cancelled" / "None of it was applied" / "never written" (its ops WERE written, to the removed project)`, !!t && !cancelled(t) && !claimsNotWritten(t), t?.slice(0, 240));
  check(`${tag}c it is told the project was removed and the change is not in effect (true of both the removed and the re-added project)`, removedText(t) && !granted(t), t?.slice(0, 240));
  check(`${tag}d the re-added project inherits nothing: K=old, no port, container = its settings`, w.base.env.K === 'old' && !w.base.ports.length && w.drift() === 'clean', { base: w.base });
  // The DELETE route closed the old project's sessions, so nothing is RUNNING to tell: the message is not queued (the
  // outbox would resume the removed project's session inside the re-added one); it is recorded as not sent.
  check(`${tag}e session not running: not queued (never resumed into the re-added project), recorded "undeliverable" with the removed text`, (w.enqCount.get(A.id) ?? 0) === 0 && acc.getAccess(A.id)?.resume?.state === 'undeliverable' && removedText(acc.getAccess(A.id)?.resume?.text), { enq: w.enqCount.get(A.id), resume: acc.getAccess(A.id)?.resume });
}
{
  // W32f — the same, but the requesting session is still running: told exactly once, with the removed text.
  resetStore();
  const w = world('w32f', { K: 'old' }); const api = wiring(w); api.sessionLive = () => true;
  const A = api.raise('sess-w32f-aaaa', { env: { K: 'new' }, ports: [{ hostPort: 48779, containerPort: 8080 }] }).rec;
  api.approve(A.id); api.recreate();
  api.fault = 'store-fails-after-settings'; api.check();
  readd('w32f');
  api.settle();
  const t = w.enq.get(A.id);
  check('W32f session running: told EXACTLY once, "removed / not in effect", never "cancelled" / "never written"', (w.enqCount.get(A.id) ?? 0) === 1 && removedText(t) && !claimsNotWritten(t) && !cancelled(t), { enq: w.enqCount.get(A.id), t: t?.slice(0, 160) });
}
{
  // W33 — the same window, but the USER presses Cancel on the card of the re-added project (openai's r7 probe door, cancelByUser).
  resetStore();
  const w = world('w33', { K: 'old' }); const api = wiring(w); api.sessionLive = () => true;
  const A = api.raise('sess-w33-aaaa', { env: { K: 'new' }, ports: [{ hostPort: 48778, containerPort: 8080 }] }).rec;
  api.approve(A.id); api.recreate();
  api.fault = 'store-fails-after-settings'; api.check();
  readd('w33');
  const c = ch.cancelByUser(A.id, 'w33');
  api.settle();
  const t = textOf(w, A.id);
  check('W33 Cancel on a request of the REMOVED incarnation is refused and never writes "cancelled … never written"', c.ok === false && !!t && !cancelled(t) && !claimsNotWritten(t) && removedText(t), { c, t: t?.slice(0, 200) });
}
{
  // W34 — an UNDECIDED request raised against the old incarnation is never approved onto the re-added project.
  resetStore();
  const w = world('w34', { K: 'old' }); const api = wiring(w); api.sessionLive = () => true;
  const A = api.raise('sess-w34-aaaa', { env: { K: 'new' } }).rec;
  readd('w34');
  let threw = null; try { api.approve(A.id); } catch (e) { threw = e; }
  api.settle();
  const t = textOf(w, A.id);
  check('W34 approving a request raised for the removed incarnation is refused; the re-added project gets nothing; the requester is told it was removed', !!threw && w.base.env.K === 'old' && w.drift() === 'clean' && removedText(t) && (w.enqCount.get(A.id) ?? 0) === 1, { threw: threw?.message?.slice(0, 120), base: w.base.env, t: t?.slice(0, 160) });
}
{
  // W35 — plain approved-pending (no fault) then delete + re-add: "removed, not in effect", never "cancelled".
  resetStore();
  const w = world('w35', { K: 'old' }); const api = wiring(w); api.sessionLive = () => true;
  const A = api.raise('sess-w35-aaaa', { env: { K: 'new' } }).rec;
  api.approve(A.id);
  readd('w35');
  api.settle();
  const t = textOf(w, A.id);
  check('W35 approved-pending then delete + re-add: told removed / not in effect; the new project gets nothing', removedText(t) && !cancelled(t) && w.base.env.K === 'old' && w.drift() === 'clean', { t: t?.slice(0, 160), base: w.base.env });
}

if (R8) {
  // W36 — the scratch door: scratch deleted and re-ensured (id 'scratch'), switched to container by the user.
  resetStore();
  const prevScratch = process.env.CLAUDE_STATION_SCRATCH_DIR;
  process.env.CLAUDE_STATION_SCRATCH_DIR = PROJ_DIR;
  const w = world('scratch', { K: 'old' }); const api = wiring(w); api.sessionLive = () => true;
  const A = api.raise('sess-w36-aaaa', { env: { K: 'new' } }).rec;
  api.approve(A.id); api.recreate();
  api.fault = 'store-fails-after-settings'; api.check();
  regm.deleteProject('scratch');
  regm.ensureScratchProject();
  regm.updateProject('scratch', { isolation: 'container', settings: { container: { gpu: 'off', env: { K: 'old' }, ports: [] } } });
  api.settle();
  const t = w.enq.get(A.id);
  check('W36 scratch deleted + re-ensured (+ switched to container) in the lost-mark window: "removed / not in effect", once; the new scratch inherits nothing', removedText(t) && !claimsNotWritten(t) && (w.enqCount.get(A.id) ?? 0) === 1 && w.base.env.K === 'old' && w.drift() === 'clean', { t: t?.slice(0, 140), base: w.base.env });
  if (prevScratch === undefined) delete process.env.CLAUDE_STATION_SCRATCH_DIR; else process.env.CLAUDE_STATION_SCRATCH_DIR = prevScratch;
}
if (R8) {
  // W37 — legacy records (no incarnation token; one also with no r6 basis), both directions of the fallback.
  const strip = (id, noBasis) => { const f = path.join(DATA, 'access-requests.json'); const all = JSON.parse(fs.readFileSync(f, 'utf8')); const r = all.find((x) => x.id === id); delete r.projectIncarnation; if (noBasis && r.decision) delete r.decision.basis; fs.writeFileSync(f, JSON.stringify(all, null, 2)); };
  resetStore();
  const w = world('w37', { K: 'old' }); const api = wiring(w); api.sessionLive = () => true;
  const A = api.raise('sess-w37-aaaa', { env: { K: 'new' } }).rec; api.approve(A.id); strip(A.id, true);
  const B = api.raise('sess-w37-bbbb', { env: { L: 'new' } }).rec; api.approve(B.id); strip(B.id, false);
  readd('w37');
  const ov = ch.overlayFor(w.project(), { env: {}, ports: [] });
  api.settle();
  check('W37 legacy no-token records (one with no basis) of a removed project: never in the re-added overlay, never committed there, told "removed"', !Object.keys(ov.env).length && !('K' in w.base.env && w.base.env.K === 'new') && !('L' in w.base.env) && removedText(w.enq.get(A.id)) && removedText(w.enq.get(B.id)) && !w.commitWrites.some((ids) => ids.includes(A.id) || ids.includes(B.id)), { ov, base: w.base.env, A: w.enq.get(A.id)?.slice(0, 80), B: w.enq.get(B.id)?.slice(0, 80) });
  resetStore();
  const w2 = world('w37b', { K: 'old' }); const api2 = wiring(w2);
  const C = api2.raise('sess-w37-cccc', { env: { K: 'new' } }).rec; api2.approve(C.id); strip(C.id, true);
  api2.settle();
  check('W37b a legacy no-token, no-basis record of the CURRENT project (raised after it was created) still applies normally', granted(textOf(w2, C.id)) && w2.base.env.K === 'new', { t: textOf(w2, C.id)?.slice(0, 80), base: w2.base.env });
}
if (R8) {
  // W38 — the incarnation is set once and never changes: rename, repoint, any settings write, the access commit, and a
  // patch carrying a forged token all keep it, so none of them turns a request into "removed".
  resetStore();
  const w = world('w38', { K: 'old' }); const api = wiring(w);
  const p0 = readd('w38');
  const inc0 = regm.incarnationOf(p0);
  const A = api.raise('sess-w38-aaaa', { env: { K: 'new' } }).rec; api.approve(A.id);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'feat200-cos-proj2-'));
  regm.updateProject('w38', { name: 'renamed w38' });
  regm.updateProject('w38', { incarnation: 'forged', settings: { container: { env: { K: 'old', OTHER: '1' } } } });
  regm.updateProject('w38', { hostPath: other });
  regm.updateProject('w38', { hostPath: PROJ_DIR });
  const kinds = acc.classOf(acc.getAccess(A.id)).kind;
  api.settle();
  check('W38 rename, repoint (and back), a settings write and a patch carrying a forged token keep the incarnation; the request stays live and commits', regm.incarnationOf(w.project()) === inc0 && w.project().incarnation === inc0 && kinds === 'live' && granted(textOf(w, A.id)) && regm.incarnationOf(w.project()) === inc0, { inc0, now: w.project().incarnation, kinds, t: textOf(w, A.id)?.slice(0, 60) });
  fs.rmSync(other, { recursive: true, force: true });
  const p1 = readd('w38');
  check('W38b a re-add under the same id is a NEW incarnation (random token, not derived from the id or the time)', regm.incarnationOf(p1) !== inc0 && /^inc-/.test(p1.incarnation ?? ''), { inc0, inc1: p1.incarnation });
}
if (R8) {
  // W39 — registry unreadable (truncated real bytes) while a removed incarnation's request is open: no mark, no message.
  resetStore();
  const w = world('w39', { K: 'old' }); const api = wiring(w); api.sessionLive = () => true;
  const A = api.raise('sess-w39-aaaa', { env: { K: 'new' } }).rec;
  api.approve(A.id); api.recreate();
  api.fault = 'store-fails-after-settings'; api.check();
  readd('w39');
  const full = fs.readFileSync(REG_FILE, 'utf8');
  const outs = [1, Math.floor(full.length / 3), full.length - 2].map((n) => { fs.writeFileSync(REG_FILE, full.slice(0, n)); api.check(); const r = acc.getAccess(A.id); return { n, notApplied: !!r.notApplied, enq: w.enqCount.get(A.id) ?? 0, cls: acc.classOf(r).kind }; });
  fs.writeFileSync(REG_FILE, full);
  check('W39 a truncated registry (3 cuts) with a removed incarnation\'s request open: classified unknown, no mark written, nothing sent', outs.every((o) => !o.notApplied && o.enq === 0 && o.cls === 'unknown'), outs);
  api.settle();
  check('W39b with the registry whole again: closed "removed", told once', removedText(w.enq.get(A.id)) && (w.enqCount.get(A.id) ?? 0) === 1, w.enq.get(A.id)?.slice(0, 80));
}

/* ================================================================ W29: random interleavings + user saves + a FAULT at every write point */
console.log(`\n--- W29: random interleavings, user saves AND injected faults at every write point (${RUNS} runs)`);
{
  const KEYS = ['K1', 'K2', 'K3'];
  const HOSTS = [45201, 45202, 45203, 45204, 45205, 45206];
  const FAULTS = ['registry-fails', 'crash-after-settings', 'store-fails-after-settings', 'enqueue-fails', 'store-fails-after-enqueue', 'user-save-fails'];
  const cport = (h) => 8000 + (h % 100);
  let violations = 0; let firstViolation = null; const faultHits = Object.fromEntries(FAULTS.map((f) => [f, 0])); let windowEdits = 0; let applied = 0; let cancels = 0;
  // r8: delete + re-add under the same id (real registry functions) as random events, also inside lost-mark windows.
  let readds = 0; let windowReadds = 0; let removedTold = 0; let undeliverable = 0; let refusedRemoved = 0; let restarts = 0;
  for (let run = 0; run < RUNS; run++) {
    resetStore();
    const w = world(`w29-${run}`, rng() < 0.5 ? { K1: 'base1' } : {}); const api = wiring(w);
    const liveSessions = rng() < 0.3; api.sessionLive = () => liveSessions;
    const incNow = () => (R8 ? regm.incarnationOf(w.project()) : w.project()?.createdAt);
    const N = 2 + Math.floor(rng() * 3);
    const reqs = Array.from({ length: N }, (_, i) => {
      const body = { env: {} };
      for (const k of KEYS) if (rng() < 0.45) body.env[k] = pick(['a', 'b', 'c']);
      if (!Object.keys(body.env).length) body.env[pick(KEYS)] = pick(['a', 'b']);
      if (rng() < 0.6) body.ports = [{ hostPort: pick(HOSTS), containerPort: 0 }].map((p) => ({ hostPort: p.hostPort, containerPort: cport(p.hostPort) }));
      return { i, body, sid: `sess-w29-${String(i).padStart(4, '0')}`, rec: null, verdict: null };
    });
    const evs = [];
    for (const r of reqs) { evs.push({ t: 'raise', r }); evs.push({ t: 'decide', r }); }
    for (let k = 0; k < N * 3; k++) evs.push({ t: pick(['recreate', 'check', 'check']) });
    for (let k = 0; k < 1 + Math.floor(rng() * 4); k++) evs.push({ t: 'user' });
    if (rng() < 0.35) evs.push({ t: 'readd' });
    for (let k = evs.length - 1; k > 0; k--) { const j = Math.floor(rng() * (k + 1)); [evs[k], evs[j]] = [evs[j], evs[k]]; }
    const seen = new Set(); const ordered = []; const deferred = [];
    for (const e of evs) {
      if (e.t === 'decide' && !seen.has(e.r.i)) { deferred.push(e); continue; }
      ordered.push(e); if (e.t === 'raise') { seen.add(e.r.i); const d = deferred.findIndex((x) => x.r.i === e.r.i); if (d >= 0) ordered.push(...deferred.splice(d, 1)); }
    }
    ordered.push(...deferred);
    let inWindow = false; // a commit's settings write landed but its record mark may be lost
    const userSave = () => {
      const b = w.base; const env = { ...b.env }; let ports = b.ports.map((p) => ({ ...p }));
      if (rng() < 0.7) { const k = pick(KEYS); if (rng() < 0.3) delete env[k]; else env[k] = pick(['a', 'u', 'v']); }
      else { const h = pick(HOSTS); if (ports.some((p) => p.hostPort === h)) ports = ports.filter((p) => p.hostPort !== h); else ports.push({ hostPort: h, containerPort: cport(h) }); }
      if (rng() < 0.12) { faultHits['user-save-fails']++; fs.chmodSync(DATA, 0o555); try { api.userSave(env, ports); } catch { /* the save failed: nothing stamped */ } finally { fs.chmodSync(DATA, 0o755); } return; }
      if (inWindow) windowEdits++;
      api.userSave(env, ports);
    };
    for (const e of ordered) {
      if (e.t === 'raise') { e.r.rec = api.raise(e.r.sid, e.r.body).rec ?? null; e.r.inc = incNow(); }
      else if (e.t === 'decide') {
        if (!e.r.rec) continue;
        try {
          if (rng() < 0.1) { api.reject(e.r.rec.id); e.r.verdict = 'rejected'; } else { const a = api.approve(e.r.rec.id); e.r.verdict = a.status === 200 ? 'approved' : null; }
        } catch (err) { if (err?.code === 'project-removed') { e.r.verdict = 'refused-removed'; refusedRemoved++; } else throw err; }
      }
      else if (e.t === 'readd') { readds++; if (inWindow) windowReadds++; readd(w.pid, rng() < 0.5 ? { K1: 'base1' } : {}); }
      else if (e.t === 'recreate') api.recreate();
      else if (e.t === 'user') userSave();
      else {
        if (rng() < 0.5) { const f = pick(FAULTS.filter((x) => x !== 'user-save-fails')); api.fault = f; faultHits[f]++; if (f === 'crash-after-settings' || f === 'store-fails-after-settings') inWindow = true; }
        if (rng() < 0.15) { restarts++; api.chMod = await import(`${url.pathToFileURL(path.join(ROOT, 'src/server/access-channel.ts')).href}?restart=${run}-${Math.random()}`); }
        api.check();
      }
    }
    api.settle(20);
    // ---- the oracle (tree-independent: ground truth = which requests a LANDED settings write committed) ----
    const why = [];
    const wroteIds = new Set(w.commitWrites.flat());
    const goneOf = (r) => r.inc !== incNow(); // its incarnation was removed (the id may now name a re-added project)
    /** r8: delivered once — or, ONLY for a removed incarnation with no running session, recorded "undeliverable" and sent nowhere. */
    const told = (r, rec) => {
      if (rec.resume?.state === 'undeliverable') {
        undeliverable++;
        if (!goneOf(r)) why.push(`${r.i} marked undeliverable but its project incarnation is current`);
        if ((w.enqCount.get(rec.id) ?? 0) !== 0) why.push(`${r.i} undeliverable but was sent`);
        if (liveSessions) why.push(`${r.i} undeliverable although its session was running`);
        return false;
      }
      if ((w.enqCount.get(rec.id) ?? 0) !== 1) why.push(`${r.i} delivered ${w.enqCount.get(rec.id) ?? 0} times`);
      return true;
    };
    for (const r of reqs.filter((q) => q.verdict === 'refused-removed')) {
      const rec = acc.getAccess(r.rec.id);
      if (!removedText(rec?.resume?.text)) why.push(`${r.i} approval refused (project removed) but closed with: ${String(rec?.resume?.text).slice(0, 80)}`);
      if (rec && told(r, rec)) removedTold++;
    }
    for (const r of reqs.filter((q) => q.verdict === 'approved')) {
      const rec = acc.getAccess(r.rec.id);
      if (!told(r, rec)) continue;
      const t = w.enq.get(rec.id) ?? null;
      if (!t) { why.push(`${r.i} approved but never told anything after settling`); continue; }
      // (T0, r8) the removed text only when its incarnation is really gone; never a "never written" claim instead.
      if (removedText(t)) { removedTold++; if (!goneOf(r)) why.push(`${r.i} told "project removed" but its project incarnation is current`); }
      // (T1) the requester's message matches the settings truth.
      if (wroteIds.has(rec.id) && claimsNotWritten(t)) why.push(`${r.i} its ops were written to the settings but it was told: ${t.slice(0, 110)}`);
      if (!wroteIds.has(rec.id) && (granted(t) || /approved, but .* not in the container now/.test(t))) why.push(`${r.i} told applied but no settings write ever carried it: ${t.slice(0, 90)}`);
      if (granted(t)) applied++;
      if (cancelled(t)) cancels++;
      // (T2) told exactly once.
    }
    for (const r of reqs.filter((q) => q.verdict === 'rejected')) {
      const rec = acc.getAccess(r.rec.id);
      if (!/denied/.test(rec?.resume?.text ?? '')) why.push(`${r.i} rejected but closed with ${String(rec?.resume?.text).slice(0, 40)}`);
      if (rec) told(r, rec);
    }
    if (w.nonceConflicts) why.push(`${w.nonceConflicts} changed payload(s) under one nonce`);
    // (T3) the container equals the settings once settled; nothing is left approved-pending.
    if (w.drift() !== 'clean') why.push('container != settings after settling');
    const stuck = acc.listAccessForProject(w.pid).filter((x) => x.decision?.verdict === 'approved' && x.decision.applied === false && !x.notApplied);
    if (stuck.length) why.push(`${stuck.length} record(s) still approved-pending after settling`);
    if (why.length) { violations++; if (!firstViolation) firstViolation = { run, why: why.slice(0, 3) }; }
  }
  check(`W29 over ${RUNS} random interleavings with user saves and a fault injected at every write point: every message matches the settings, each told once, container = settings`, violations === 0, { violations, firstViolation });
  check('W29b not vacuous: every fault point was hit, user edits landed inside a lost-mark window, requests were applied and cancelled', FAULTS.every((f) => faultHits[f] > 0) && windowEdits > 0 && applied > 0 && cancels > 0, { faultHits, windowEdits, applied, cancels });
  check('W29c not vacuous (r8): delete + re-add happened, also inside lost-mark windows; removed requests were told, recorded undeliverable, and refused at approval; restarts happened', !R8 || (readds > RUNS / 5 && windowReadds > 0 && removedTold > 0 && undeliverable > 0 && refusedRemoved > 0 && restarts > 0), { readds, windowReadds, removedTold, undeliverable, refusedRemoved, restarts });
}

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(PROJ_DIR, { recursive: true, force: true }); } catch { /* */ }
process.exit(fail ? 1 : 0);
