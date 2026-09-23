#!/usr/bin/env node
/**
 * verify-bug-173-grant-aware-shim.mjs — BUG-173.
 *
 * The FEAT-108 Bash hook is grant-AWARE (evaluateGitWrite/peekGrant), but the
 * FEAT-135 PATH shim was grant-BLIND: it read only the launch-time env hatch
 * ORCHARD_ALLOW_GIT_WRITE. A duration/once grant the user minted AFTER a session
 * launched could never reach the shim, so subprocess git writes stayed refused
 * despite a live grant (the user's exact report). The fix makes the shim consult
 * the SAME host grant authority (evaluateGitWrite) at CALL TIME over loopback
 * (/api/git-shim/decide), keyed by the project id, failing CLOSED on any read
 * failure — so there is ONE grant authority (ARCH-010) and the two layers cannot
 * disagree.
 *
 * SCOPING (BUG-173 round-3 DECISION): the grant is per-PROJECT, matching the
 * FEAT-108 hook (the pre-existing single grant authority). A different session
 * inside the SAME granted project is allowed BY DESIGN; a grant for a DIFFERENT
 * project never unblocks the call. Making the shim stricter than the hook would
 * create two authorities with different answers — exactly the ARCH-010 defect
 * this ticket removes.
 *
 * ROUND 3 — trust no longer rests on agent-writable env:
 *   - The host URL, grant key and a host-minted SECRET are BAKED INTO the shim
 *     source, not env; a forged ORCHARD_GIT_SHIM_HOST / _GRANT_KEY no longer
 *     redirects the consult, and a child-set ORCHARD_ALLOW_GIT_WRITE no longer
 *     opens writes (the installed shim ignores the child env hatch).
 *   - /api/git-shim/decide REQUIRES the secret; a caller without it is refused.
 *
 * Legs:
 *   [must-FAIL] the PRE-FIX shim (git show HEAD:…) refuses `git add` even with a
 *     live grant + reachable host — no call-time consult exists. Same scenario
 *     post-fix is honoured.
 *   [scope]  project-scoped contract: session A allowed; a DIFFERENT session in
 *     the SAME granted project allowed (by design); a DIFFERENT project refused.
 *   [e2e]  a REAL `git add` via the shim subprocess against a REAL loopback host
 *     process running the REAL evaluateGitWrite over the REAL grant store:
 *     no grant → refused; grant after launch → allowed; revoke → re-blocked;
 *     different project → refused.
 *   [bypass] a forged ORCHARD_GIT_SHIM_HOST / _GRANT_KEY in the shim subprocess
 *     env is IGNORED (baked coords win); a child-set ORCHARD_ALLOW_GIT_WRITE=1 is
 *     IGNORED (installed shim ignores the hatch) — both still refuse w/o a grant.
 *   [secret] a wrong / missing shim secret is refused by the route.
 *   [race]  a grant that expires WHILE a shim call is in flight → the host
 *     evaluates post-expiry → deny (not a stale allow).
 *   [leak-gate] the REAL scripts/leak-gate.mjs subprocess on a granted commit:
 *     clean repo → gate passes → allowed; planted-secret repo → gate fails →
 *     blocked (a grant never lifts the gate).
 *   [unit] expiry re-blocks (deterministic now); publish still gated under grant.
 *   [fail-closed] host unreachable / malformed body / missing coords / timeout
 *     all DENY.
 *
 * Scratch repos + host live on ephemeral ports under os.tmpdir(); the real repo
 * is never mutated. The mini-host mirrors the src/server/index.ts route body
 * (same field validation, same secret gate, same evaluateGitWrite call, same
 * fail-closed); that route's registry/hostPath/readBody wiring is covered by the
 * typecheck gate and the code audit (see the BUG-173 Activity log).
 */
import http from 'node:http';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  installGitShim, decideGitShim, resolveGitShim, askHostGrant,
} from './lib/git-shim.mjs';
import { evaluateGitWrite } from './lib/git-grant.mjs';
import {
  grantGitWrite, revokeGitWrite, _resetGitGrantsForTest,
} from './lib/git-grant-store.mjs';

// Block ON for this whole run — a stray ORCHARD_ALLOW_GIT_WRITE=1 would open the
// env hatch and make every leg allow locally without consulting the host.
delete process.env.ORCHARD_ALLOW_GIT_WRITE;

// This verifier may itself run INSIDE an Orchard agent session, whose PATH
// already has a git shim and whose env already carries shim/grant vars. BASE is a
// scrubbed env with the inherited shim dir stripped from PATH and every shim/grant
// var removed — the honest "fresh launch" a real session starts from. Scratch-repo
// setup and inspection use BASE (real git); only the shim-under-test env prepends
// our own fresh shim dir. Coords now travel BAKED IN the shim source / via opts,
// NOT via env (round 3).
const CLEAN_PATH = (process.env.PATH ?? '')
  .split(path.delimiter)
  .filter((p) => p && p !== process.env.ORCHARD_GIT_SHIM_DIR)
  .join(path.delimiter);
const BASE = { ...process.env, PATH: CLEAN_PATH };
delete BASE.ORCHARD_GIT_SHIM_DIR;
delete BASE.ORCHARD_GIT_GRANT_KEY;
delete BASE.ORCHARD_GIT_SHIM_HOST;
delete BASE.ORCHARD_ALLOW_GIT_WRITE;

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LIBDIR = path.resolve(DIR, 'lib');
const REPO_ROOT = path.resolve(DIR, '..');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bug173-'));
const TEST_AUTH = 'bug173-test-shim-auth-' + Math.random().toString(16).slice(2);
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A loopback host mirroring index.ts POST /api/git-shim/decide, INCLUDING the
 * round-3 secret gate. `delayMs` lets a leg force grant expiry while the call is
 * in flight; `mode` exercises malformed / hang fail-closed paths.
 */
function makeHost({ gateOk = true, mode = 'normal', delayMs = 0, expectAuth = TEST_AUTH } = {}) {
  const server = http.createServer((req, res) => {
    if (!(req.method === 'POST' && req.url === '/api/git-shim/decide')) { res.writeHead(404); res.end(); return; }
    if (mode === 'hang') return; // never answer — exercises the shim's timeout
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      if (mode === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('not json{{'); return; }
      const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { send({ allow: false, reason: 'git-shim decide: unreadable body — failing closed' }); return; }
      const grantKey = typeof body.grantKey === 'string' && body.grantKey ? body.grantKey : null;
      const argv = Array.isArray(body.argv) ? body.argv.filter((a) => typeof a === 'string') : null;
      const sessionLabel = typeof body.sessionLabel === 'string' ? body.sessionLabel : null;
      const auth = typeof body.shimAuth === 'string' ? body.shimAuth : null;
      if (!grantKey || !argv) { send({ allow: false, reason: 'git-shim decide: grantKey and argv[] required — failing closed' }); return; }
      if (auth !== expectAuth) { send({ allow: false, reason: 'git-shim decide: missing or invalid shim credential — failing closed' }); return; }
      if (delayMs) await sleep(delayMs); // grant may lapse before evaluateGitWrite's now
      const decision = evaluateGitWrite({ argv, projectKey: grantKey, sessionLabel, runLeakGate: () => ({ ok: gateOk, detail: 'gate stub' }) });
      send({ allow: !!decision.allow, reason: decision.reason ?? null, offender: decision.offender ?? null });
    });
  });
  return server;
}
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((r) => server.close(r));
/** Shorthand: post to the mini-host with the baked coords a real shim would send. */
const consult = (hostUrl, grantKey, argv = ['add', '-A'], shimAuth = TEST_AUTH, opts = {}) =>
  resolveGitShim(argv, BASE, { hostUrl, grantKey, shimAuth, ...opts });

/*
 * A SEPARATE host process for the real-subprocess E2E. The shim subprocess is
 * spawned SYNCHRONOUSLY (spawnSync) — which blocks this driver's event loop — so
 * an in-process host could never answer the shim's loopback fetch. This also
 * matches production (host ≠ session process). It mirrors index.ts's decide route
 * body (incl. the round-3 secret gate, EXPECTED via env) and adds /_test/* routes
 * so the driver can set live grant state per case.
 */
const HOST_SRC = `
import http from 'node:http';
import { evaluateGitWrite } from ${JSON.stringify(path.join(LIBDIR, 'git-grant.mjs'))};
import { grantGitWrite, revokeGitWrite, _resetGitGrantsForTest } from ${JSON.stringify(path.join(LIBDIR, 'git-grant-store.mjs'))};
delete process.env.ORCHARD_ALLOW_GIT_WRITE;
const EXPECTED = process.env.EXPECTED_AUTH || '';
const read = (req) => new Promise((r) => { let s=''; req.on('data',c=>s+=c); req.on('end',()=>r(s)); });
const send = (res,obj) => { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify(obj)); };
const server = http.createServer(async (req,res) => {
  const raw = await read(req);
  if (req.url === '/_test/reset') { _resetGitGrantsForTest(); return send(res,{ok:true}); }
  if (req.url === '/_test/grant') { const b=JSON.parse(raw||'{}'); grantGitWrite(b.projectKey,{scope:b.scope,ttlMs:b.ttlMs}); return send(res,{ok:true}); }
  if (req.url === '/_test/revoke') { const b=JSON.parse(raw||'{}'); revokeGitWrite(b.projectKey); return send(res,{ok:true}); }
  if (req.method==='POST' && req.url==='/api/git-shim/decide') {
    let body; try { body = JSON.parse(raw||'{}'); } catch { return send(res,{allow:false,reason:'unreadable'}); }
    const grantKey = typeof body.grantKey==='string'&&body.grantKey?body.grantKey:null;
    const argv = Array.isArray(body.argv)?body.argv.filter(a=>typeof a==='string'):null;
    const sessionLabel = typeof body.sessionLabel==='string'?body.sessionLabel:null;
    const auth = typeof body.shimAuth==='string'?body.shimAuth:null;
    if (!grantKey||!argv) return send(res,{allow:false,reason:'required'});
    if (auth !== EXPECTED) return send(res,{allow:false,reason:'invalid shim credential'});
    const d = evaluateGitWrite({ argv, projectKey:grantKey, sessionLabel, runLeakGate:()=>({ok:true,detail:''}) });
    return send(res,{ allow:!!d.allow, reason:d.reason??null, offender:d.offender??null });
  }
  res.writeHead(404); res.end();
});
server.listen(0,'127.0.0.1',()=>{ process.stdout.write('READY '+server.address().port+'\\n'); });
`;
async function startHostProcess() {
  const file = path.join(SCRATCH, 'host.mjs');
  fs.writeFileSync(file, HOST_SRC);
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...BASE, EXPECTED_AUTH: TEST_AUTH } });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => reject(new Error('host process did not become READY')), 5000);
    child.stdout.on('data', (c) => { buf += c; const m = buf.match(/READY (\d+)/); if (m) { clearTimeout(to); resolve(Number(m[1])); } });
    child.on('exit', () => { clearTimeout(to); reject(new Error('host process exited early')); });
  });
  return { child, url: `http://127.0.0.1:${port}` };
}
const ctl = (url, p, body) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());

/** A throwaway git repo; returns a helper that runs REAL git in it. */
function scratchRepo(name) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, name + '-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: BASE });
  g('init', '-q'); g('config', 'user.email', 'x@x'); g('config', 'user.name', 'x');
  fs.writeFileSync(path.join(dir, 'a'), '1'); g('add', 'a'); g('commit', '-q', '-m', 'seed');
  return { dir, g };
}
/** Is path `p` currently staged in the repo's real index? */
const isStaged = (g, p) => g('diff', '--cached', '--name-only').split('\n').includes(p);

/** Run `git add b` through the shim (real subprocess) with the given env. */
function shimAdd(dir, shimEnv) {
  fs.writeFileSync(path.join(dir, 'b'), 'x');
  const r = spawnSync('git', ['-C', dir, 'add', 'b'], { encoding: 'utf8', env: shimEnv });
  return r.status;
}

/** The REAL leak gate the live route injects (mirrors runLeakGateForRepo). */
function realLeakGate(repoDir) {
  const gate = path.join(REPO_ROOT, 'scripts', 'leak-gate.mjs');
  const run = (args) => {
    try { execFileSync(process.execPath, [gate, ...args], { cwd: repoDir, stdio: 'pipe', timeout: 30_000 }); return { ok: true, detail: '' }; }
    catch (e) { return { ok: false, detail: `${e.stdout ?? ''}${e.stderr ?? ''}`.toString().slice(0, 400) }; }
  };
  const tree = run(['--summary']);
  if (!tree.ok) return tree;
  return run(['--summary', '--staged']);
}

const PROJECT = 'proj-A';
const OTHER = 'proj-B';

async function main() {
  // ── [must-FAIL] the PRE-FIX shim, obtained read-only via git show ───────────
  console.log('[must-FAIL] pre-fix shim refuses `git add` even with a live grant + reachable host');
  const preSrc = execFileSync('git', ['show', 'HEAD:scripts/lib/git-shim.mjs'], { encoding: 'utf8' });
  const prePath = path.join(LIBDIR, '.bug173-prefix-shim.mjs'); // in lib/ so its `./git-write-policy.mjs` import resolves
  fs.writeFileSync(prePath, preSrc);
  try {
    const pre = await import('./lib/.bug173-prefix-shim.mjs?v=' + Date.now());
    const host = makeHost();
    const hostUrl = await listen(host);
    _resetGitGrantsForTest();
    grantGitWrite(PROJECT, { scope: 'duration', ttlMs: 20 * 60 * 1000 }); // live, 20 min left — the user's case
    const preDecision = pre.decideGitShim(['add', '-A'], { ...BASE });
    ok(preDecision.allow === false, 'pre-fix decideGitShim(add) === refused despite live grant');
    ok(typeof pre.resolveGitShim !== 'function' && typeof pre.askHostGrant !== 'function',
      'pre-fix module has NO call-time host consult (no resolveGitShim/askHostGrant)');
    // Post-fix, the identical scenario is honoured (coords via baked-source/opts):
    const postDecision = await consult(hostUrl, PROJECT);
    ok(postDecision.allow === true, 'post-fix resolveGitShim(add) === ALLOWED (grant honoured) — the bug is fixed');
    await close(host);
  } finally {
    fs.rmSync(prePath, { force: true });
  }

  // ── [scope] project-scoped contract (BUG-173 round-3 DECISION) ──────────────
  console.log('\n[scope] the grant is per-PROJECT (matches the FEAT-108 hook), NOT per-session');
  {
    _resetGitGrantsForTest();
    grantGitWrite(PROJECT, { scope: 'duration', ttlMs: 20 * 60 * 1000 });
    ok(evaluateGitWrite({ argv: ['add', '-A'], projectKey: PROJECT, sessionLabel: 'session-one' }).allow === true,
      'granted project, session A → allowed');
    ok(evaluateGitWrite({ argv: ['add', '-A'], projectKey: PROJECT, sessionLabel: 'a-totally-different-session-xyz' }).allow === true,
      'DIFFERENT session, SAME granted project → allowed (project-scoped BY DESIGN — the grant UI is a project control)');
    ok(evaluateGitWrite({ argv: ['add', '-A'], projectKey: OTHER, sessionLabel: 'session-one' }).allow === false,
      'grant for a DIFFERENT project → refused');
  }

  // ── [e2e] real `git add` via the shim subprocess against a real host ────────
  console.log('\n[e2e] real subprocess `git add` through the installed shim (separate host process)');
  {
    const { child, url: hostUrl } = await startHostProcess();
    try {
      const { dir, g } = scratchRepo('e2e');
      // LAUNCH: install the shim with the project key + secret BAKED; NO grant yet.
      const { env: shimEnv } = installGitShim(BASE, { baseDir: SCRATCH, grantKey: PROJECT, hostUrl, shimAuth: TEST_AUTH });

      await ctl(hostUrl, '/_test/reset');
      ok(shimAdd(dir, shimEnv) !== 0 && !isStaged(g, 'b'), 'no grant → subprocess add refused (nonzero, unstaged)');

      // Grant minted AFTER launch — the user's exact scenario.
      await ctl(hostUrl, '/_test/grant', { projectKey: PROJECT, scope: 'duration', ttlMs: 20 * 60 * 1000 });
      ok(shimAdd(dir, shimEnv) === 0 && isStaged(g, 'b'), 'grant minted AFTER launch → subprocess add SUCCEEDS (index moved)');

      // ── [bypass] forged env is IGNORED; baked coords + hatch-ignore win ──────
      // A forged ORCHARD_GIT_SHIM_HOST (dead) + ORCHARD_GIT_GRANT_KEY (bogus) in
      // the child env: if the shim trusted env it would hit the dead host / wrong
      // project and DENY. It ALLOWS → it used the BAKED coords, not env.
      g('reset', '-q');
      const forgedEnv = { ...shimEnv, ORCHARD_GIT_SHIM_HOST: 'http://127.0.0.1:1', ORCHARD_GIT_GRANT_KEY: 'bogus-project' };
      ok(shimAdd(dir, forgedEnv) === 0 && isStaged(g, 'b'),
        'forged ORCHARD_GIT_SHIM_HOST/_GRANT_KEY in child env IGNORED (baked coords win) → still allowed under the real grant');

      // Revocation re-blocks on the very next invocation, same live session.
      g('reset', '-q');
      await ctl(hostUrl, '/_test/revoke', { projectKey: PROJECT });
      ok(shimAdd(dir, shimEnv) !== 0 && !isStaged(g, 'b'), 'revoked grant → next invocation re-blocked');

      // Env hatch bypass: a child-set ORCHARD_ALLOW_GIT_WRITE=1 must NOT open the
      // installed shim (no grant present).
      const hatchEnv = { ...shimEnv, ORCHARD_ALLOW_GIT_WRITE: '1' };
      ok(shimAdd(dir, hatchEnv) !== 0 && !isStaged(g, 'b'),
        'child-set ORCHARD_ALLOW_GIT_WRITE=1 IGNORED by the installed shim → still refused (no grant)');

      // Scoping: a grant for a DIFFERENT project must not unblock this session.
      await ctl(hostUrl, '/_test/grant', { projectKey: OTHER, scope: 'duration', ttlMs: 20 * 60 * 1000 });
      ok(shimAdd(dir, shimEnv) !== 0 && !isStaged(g, 'b'), 'grant for a different project → refused (scoped)');
    } finally {
      child.kill();
    }
  }

  // ── [secret] the route requires the host-minted shim secret ─────────────────
  console.log('\n[secret] a wrong / missing shim secret is refused by the route');
  {
    _resetGitGrantsForTest();
    grantGitWrite(PROJECT, { scope: 'duration', ttlMs: 20 * 60 * 1000 }); // LIVE grant — only the secret should gate it
    const host = makeHost();
    const hostUrl = await listen(host);
    ok((await resolveGitShim(['add', '-A'], BASE, { hostUrl, grantKey: PROJECT, shimAuth: TEST_AUTH })).allow === true,
      'correct secret + live grant → allowed (control)');
    ok((await resolveGitShim(['add', '-A'], BASE, { hostUrl, grantKey: PROJECT, shimAuth: 'wrong-auth' })).allow === false,
      'WRONG shim secret → route denies');
    ok((await resolveGitShim(['add', '-A'], BASE, { hostUrl, grantKey: PROJECT })).allow === false,
      'MISSING shim secret → no host call, deny (fail closed)');
    await close(host);
  }

  // ── [race] grant expires WHILE the call is in flight → deny ─────────────────
  console.log('\n[race] a grant that lapses mid-call is evaluated post-expiry → deny (not a stale allow)');
  {
    _resetGitGrantsForTest();
    grantGitWrite(PROJECT, { scope: 'duration', ttlMs: 120 }); // ~120ms of life
    const slow = makeHost({ delayMs: 350 }); // host waits past expiry before evaluateGitWrite's Date.now
    const slowUrl = await listen(slow);
    const res = await resolveGitShim(['add', '-A'], BASE, { hostUrl: slowUrl, grantKey: PROJECT, shimAuth: TEST_AUTH, timeoutMs: 5000 });
    ok(res.allow === false && typeof res.reason === 'string' && res.reason.length > 0,
      'grant live at send, expired at host eval → deny with a refusal reason (expiry, not timeout)');
    await close(slow);
  }

  // ── [leak-gate] REAL scripts/leak-gate.mjs subprocess on a granted commit ───
  console.log('\n[leak-gate] the REAL leak-gate subprocess gates a granted publish');
  {
    // A private-path token, built by concatenation so THIS file never carries the
    // literal (npm run gate scans it). Mirrors leak-tokens.mjs "home path".
    const HOME_TOKEN = '/home/' + 'sa' + 'p';
    _resetGitGrantsForTest();
    grantGitWrite(PROJECT, { scope: 'duration', ttlMs: 20 * 60 * 1000 });

    const clean = scratchRepo('lg-clean');
    fs.writeFileSync(path.join(clean.dir, 'note.txt'), 'nothing private here\n');
    clean.g('add', 'note.txt');
    const cleanDecision = evaluateGitWrite({ argv: ['commit', '-m', 'x'], projectKey: PROJECT, runLeakGate: () => realLeakGate(clean.dir) });
    ok(cleanDecision.allow === true && cleanDecision.granted === true,
      'granted commit + clean repo → REAL leak gate passes → allowed');

    _resetGitGrantsForTest();
    grantGitWrite(PROJECT, { scope: 'duration', ttlMs: 20 * 60 * 1000 });
    const leaky = scratchRepo('lg-leak');
    fs.writeFileSync(path.join(leaky.dir, 'oops.txt'), `path is ${HOME_TOKEN} here\n`);
    leaky.g('add', 'oops.txt');
    const leakDecision = evaluateGitWrite({ argv: ['commit', '-m', 'x'], projectKey: PROJECT, runLeakGate: () => realLeakGate(leaky.dir) });
    ok(leakDecision.allow === false && leakDecision.gateFailed === true,
      'granted commit + planted-secret repo → REAL leak gate fails → blocked (grant never lifts the gate)');
  }

  // ── [unit] expiry + publish-gate under grant ────────────────────────────────
  console.log('\n[unit] expiry re-blocks; publish still gated under a grant');
  {
    _resetGitGrantsForTest();
    const T = 1_000_000;
    grantGitWrite(PROJECT, { scope: 'duration', ttlMs: 1000, now: T });
    ok(evaluateGitWrite({ argv: ['add', '-A'], projectKey: PROJECT, now: T + 500 }).allow === true,
      'within window → allowed');
    ok(evaluateGitWrite({ argv: ['add', '-A'], projectKey: PROJECT, now: T + 2000 }).allow === false,
      'after expiry → re-blocked (grant purged on read)');

    _resetGitGrantsForTest();
    grantGitWrite(PROJECT, { scope: 'duration', ttlMs: 20 * 60 * 1000 });
    const failGate = evaluateGitWrite({ argv: ['commit', '-m', 'x'], projectKey: PROJECT, runLeakGate: () => ({ ok: false, detail: 'leak found' }) });
    ok(failGate.allow === false && failGate.gateFailed === true, 'granted commit + FAILING leak gate → blocked (grant never lifts the gate)');
    const passGate = evaluateGitWrite({ argv: ['commit', '-m', 'x'], projectKey: PROJECT, runLeakGate: () => ({ ok: true, detail: '' }) });
    ok(passGate.allow === true && passGate.granted === true, 'granted commit + PASSING leak gate → allowed');
    ok(evaluateGitWrite({ argv: ['commit', '-m', 'x'], projectKey: PROJECT }).allow === false,
      'granted commit with NO gate runner → fails closed');
  }

  // ── [fail-closed] every host-read failure DENIES ────────────────────────────
  console.log('\n[fail-closed] unreachable / malformed / missing coords / timeout all deny');
  {
    _resetGitGrantsForTest();
    grantGitWrite(PROJECT, { scope: 'duration', ttlMs: 20 * 60 * 1000 }); // a LIVE grant — only the read path should be able to honour it

    // Missing coords → no network call, deny.
    ok((await resolveGitShim(['add', '-A'], { ...BASE })).allow === false, 'no grantKey/hostUrl/secret → deny');

    // Unreachable host (closed port).
    ok((await consult('http://127.0.0.1:1', PROJECT)).allow === false, 'unreachable host → deny (fail closed)');

    // Malformed 200 body.
    const bad = makeHost({ mode: 'malformed' });
    const badUrl = await listen(bad);
    ok((await consult(badUrl, PROJECT)).allow === false, 'malformed body → deny (fail closed)');
    await close(bad);

    // Host that never answers → the bounded timeout fires and denies.
    const hang = makeHost({ mode: 'hang' });
    const hangUrl = await listen(hang);
    const t0 = Date.now();
    const hangRes = await askHostGrant(['add', '-A'], BASE, { hostUrl: hangUrl, grantKey: PROJECT, shimAuth: TEST_AUTH, timeoutMs: 200 });
    ok(hangRes.allow === false && Date.now() - t0 < 2000, 'unresponsive host → timeout denies within the bound');
    await close(hang);

    // Reads never consult the host at all (cheap hot path) and are allowed even
    // with the block on: decideGitShim allows without a consultHost flag.
    ok(decideGitShim(['status']).allow === true && !decideGitShim(['status']).consultHost, 'read stays local + allowed (no host call)');
  }

  _resetGitGrantsForTest();
  console.log(`\nBUG-173: ${pass} passed, ${fail} failed`);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('verify threw:', e); try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} process.exit(1); });
