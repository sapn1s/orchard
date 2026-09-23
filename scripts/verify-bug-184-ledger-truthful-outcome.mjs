#!/usr/bin/env node
/**
 * verify-bug-184-ledger-truthful-outcome.mjs — BUG-184.
 *
 * THE FALSE-PROOF (WA §N): the git-write ledger recorded `gatePassed:true`
 * (rendered `gate=pass`) at DECIDE time in the host process, decoupled from whether
 * the caller then actually ran git. Over the loopback shim path the decision and
 * the execution live in two processes: the host decides ALLOW + records, then the
 * shim client may abort (the BUG-173 timeout residual) or the real-git exec may
 * fail — the host never learns. So `--status` showed `git commit gate=pass` for a
 * commit HEAD never contained: a durable audit asserting a write that was refused.
 *
 * THE FIX (ARCH-010 — the owner of a fact declares it):
 *   - The decide-time record is 'permitted' (host authorised; execution NOT yet
 *     observed), never a false 'executed'. It can never read as a landed commit.
 *   - The EXECUTOR (the FEAT-135 shim, after spawnSync) confirms the REAL git exit
 *     via /api/git-shim/confirm → confirmGitWrite: 0 → 'executed', else 'failed'.
 *   - A permit whose executor aborts / never confirms STAYS 'permitted' (honest:
 *     unknown), and a late/duplicate confirm can never overwrite a terminal record.
 *
 * Legs:
 *   [must-FAIL] the PRE-FIX modules (obtained read-only via `git show HEAD:…`):
 *     a decided-but-never-executed commit records with NO `outcome` field and
 *     renders `gate=pass` — the false-proof. The post-fix modules record
 *     'permitted' for the identical decide and only reach 'executed' on confirm.
 *   [state-machine] permitted → executed(0) / failed(nonzero); confirm is
 *     idempotent + cannot overwrite a terminal outcome; unknown id is a no-op;
 *     a gate-refused publish is 'blocked-gate', never a permit.
 *   [aborted]  a permit the executor never confirms STAYS 'permitted' — the exact
 *     ticket scenario (host decided, shim aborted, HEAD unmoved) — and can never be
 *     read as a landed commit.
 *   [e2e]  a REAL `git commit` through the installed shim against a REAL loopback
 *     host running the REAL evaluateGitWrite + confirmGitWrite over the REAL store:
 *       - a commit that LANDS → ledger 'executed', exit 0, HEAD moved.
 *       - a git that EXITS NON-ZERO → ledger 'failed', HEAD unmoved (no false pass).
 *
 * Scratch repos + host live on ephemeral ports under os.tmpdir(); the real repo is
 * never mutated. The mini-host mirrors src/server/index.ts's decide + confirm route
 * bodies (same secret gate, same evaluateGitWrite / confirmGitWrite calls).
 */
import http from 'node:http';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installGitShim } from './lib/git-shim.mjs';
import { evaluateGitWrite } from './lib/git-grant.mjs';
import {
  grantGitWrite, listGitWrites, confirmGitWrite, _resetGitGrantsForTest,
} from './lib/git-grant-store.mjs';

delete process.env.ORCHARD_ALLOW_GIT_WRITE;

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
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bug184-'));
const TEST_AUTH = 'bug184-test-shim-auth-' + Math.random().toString(16).slice(2);
const PROJECT = 'proj-A';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

/** Mirror the CLI --status render for one ledger row (scripts/git-grant.mjs). */
function renderRow(w) {
  const map = { executed: 'EXECUTED', failed: 'FAILED', permitted: 'permitted(not confirmed run)', 'blocked-gate': 'BLOCKED(gate)' };
  const outcome = !('outcome' in w) || w.outcome == null ? 'outcome=unknown(pre-BUG-184)' : `[${map[w.outcome] ?? w.outcome}]`;
  const gate = w.gatePassed === null ? 'n/a' : w.gatePassed ? 'pass' : 'FAIL';
  return `${w.offender}  ${outcome}  gate=${gate}`;
}

async function preFixLeg() {
  console.log('[must-FAIL] the PRE-FIX ledger records gate=pass for a commit that never executed');
  // Pull the pre-fix modules read-only. Rewrite the grant module's store import to
  // the pre-fix store copy so the pair is self-consistent (git-write-policy.mjs is
  // unchanged → the real one resolves correctly from lib/).
  const preStore = execFileSync('git', ['show', 'HEAD:scripts/lib/git-grant-store.mjs'], { encoding: 'utf8' });
  let preGrant = execFileSync('git', ['show', 'HEAD:scripts/lib/git-grant.mjs'], { encoding: 'utf8' });
  preGrant = preGrant.replace("from './git-grant-store.mjs'", "from './.bug184-prefix-store.mjs'");
  const storePath = path.join(LIBDIR, '.bug184-prefix-store.mjs');
  const grantPath = path.join(LIBDIR, '.bug184-prefix-grant.mjs');
  fs.writeFileSync(storePath, preStore);
  fs.writeFileSync(grantPath, preGrant);
  try {
    // No cache-busting query: pg imports the store by the bare specifier
    // `./.bug184-prefix-store.mjs`, so ps MUST resolve to the SAME module instance
    // (one grant map / one ledger) — a `?v=` here would fork a second instance.
    const pg = await import('./lib/.bug184-prefix-grant.mjs');
    const ps = await import('./lib/.bug184-prefix-store.mjs');
    ps._resetGitGrantsForTest();
    ps.grantGitWrite(PROJECT, { scope: 'duration', ttlMs: 20 * 60 * 1000 });
    // DECIDE a commit with a clean gate — but NEVER execute git (aborted shim).
    const d = pg.evaluateGitWrite({ argv: ['commit', '-m', 'x'], projectKey: PROJECT, runLeakGate: () => ({ ok: true, detail: '' }) });
    const w = ps.listGitWrites(PROJECT, 5)[0];
    ok(d.allow === true, 'pre-fix: commit decided ALLOW');
    ok(!('outcome' in w), 'pre-fix: record has NO outcome field (execution state is unrepresentable)');
    ok(w.gatePassed === true && renderRow(w).includes('gate=pass'),
      'pre-fix: a NEVER-EXECUTED commit renders `gate=pass` — the false audit record (bug present)');
  } finally {
    fs.rmSync(storePath, { force: true });
    fs.rmSync(grantPath, { force: true });
  }

  console.log('\n[fixed] the post-fix ledger records the SAME decide as permitted, NOT executed');
  _resetGitGrantsForTest();
  grantGitWrite(PROJECT, { scope: 'duration', ttlMs: 20 * 60 * 1000 });
  const d = evaluateGitWrite({ argv: ['commit', '-m', 'x'], projectKey: PROJECT, runLeakGate: () => ({ ok: true, detail: '' }) });
  const w = listGitWrites(PROJECT, 5)[0];
  ok(d.allow === true, 'post-fix: commit decided ALLOW (genuine-success path unregressed)');
  ok(w.outcome === 'permitted', "post-fix: record is 'permitted' (decided, execution not yet observed)");
  ok(!renderRow(w).includes('EXECUTED'),
    'post-fix: a never-confirmed commit does NOT render as EXECUTED (no false landed-commit claim)');
}

function stateMachineLeg() {
  console.log('\n[state-machine] permitted → executed / failed; confirm needs the capability + is single-use');
  _resetGitGrantsForTest();
  grantGitWrite(PROJECT, { scope: 'duration', ttlMs: 20 * 60 * 1000 });
  const a = evaluateGitWrite({ argv: ['commit', '-m', 'ok'], projectKey: PROJECT, runLeakGate: () => ({ ok: true, detail: '' }) });
  ok(typeof a.record.confirmToken === 'string' && a.record.confirmToken.length >= 32, 'decide returns an unguessable confirm token');
  ok(!('confirmToken' in listGitWrites(PROJECT, 5)[0]), 'the stored ledger row does NOT carry the token (never leaks via --status)');
  ok(confirmGitWrite(a.record.id, { token: a.record.confirmToken, projectKey: PROJECT, exitStatus: 0 }).record.outcome === 'executed',
    'confirm(valid token+owner, status=0) → executed');
  ok(listGitWrites(PROJECT, 5)[0].exitStatus === 0, 'executed record carries exitStatus 0');

  grantGitWrite(PROJECT, { scope: 'duration', ttlMs: 20 * 60 * 1000 });
  const b = evaluateGitWrite({ argv: ['commit', '-m', 'boom'], projectKey: PROJECT, runLeakGate: () => ({ ok: true, detail: '' }) });
  ok(confirmGitWrite(b.record.id, { token: b.record.confirmToken, projectKey: PROJECT, exitStatus: 1 }).record.outcome === 'failed',
    'confirm(valid token+owner, status=1) → failed');

  // Single-use: a replay even WITH the real token is rejected + recorded as anomaly.
  const replay = confirmGitWrite(a.record.id, { token: a.record.confirmToken, projectKey: PROJECT, exitStatus: 1 });
  ok(replay.ok === false && listGitWrites(PROJECT, 5).find((w) => w.id === a.record.id).outcome === 'executed',
    'a REPLAY with the real token is rejected — outcome stays executed (single-use, cannot flip)');
  ok(listGitWrites(PROJECT, 5).find((w) => w.id === a.record.id).confirmAnomalies >= 1,
    'the rejected replay is RECORDED as an anomaly, never silently ignored');

  const unknown = confirmGitWrite('no-such-id-xyz', { token: 'x', projectKey: PROJECT, exitStatus: 0 });
  ok(unknown.ok === false && unknown.record === null, 'confirm on an unknown id → rejected (no-op)');

  // A gate-refused publish is blocked, never a permit; a confirm cannot revive it.
  grantGitWrite(PROJECT, { scope: 'duration', ttlMs: 20 * 60 * 1000 });
  const g = evaluateGitWrite({ argv: ['commit', '-m', 'leak'], projectKey: PROJECT, runLeakGate: () => ({ ok: false, detail: 'leak found' }) });
  ok(g.allow === false && g.record.outcome === 'blocked-gate', "gate-refused publish → 'blocked-gate' (never a permit)");
  ok(confirmGitWrite(g.record.id, { token: g.record.confirmToken, projectKey: PROJECT, exitStatus: 0 }).record.outcome === 'blocked-gate',
    'confirm on a blocked-gate record is rejected — stays blocked (cannot become executed)');
}

/** BUG-184 round 3 — the same-uid forgery attacks the coordinator flagged (A1/A2/A3). */
function attackLeg() {
  console.log('\n[attack A1] a peer with a GUESSED id + wrong/no token cannot forge executed');
  _resetGitGrantsForTest();
  grantGitWrite(PROJECT, { scope: 'duration', ttlMs: 20 * 60 * 1000 });
  const d = evaluateGitWrite({ argv: ['commit', '-m', 'will-fail'], projectKey: PROJECT, runLeakGate: () => ({ ok: true, detail: '' }) });
  // Attacker guesses the OLD sequential id 'w1' and a wrong token → rejected.
  ok(confirmGitWrite('w1', { token: 'guess', projectKey: PROJECT, exitStatus: 0 }).ok === false, 'guessed sequential id "w1" no longer resolves (boot-nonce id)');
  // Even guessing the REAL id, a wrong token is rejected + recorded as an anomaly.
  const forged = confirmGitWrite(d.record.id, { token: 'wrong-token', projectKey: PROJECT, exitStatus: 0 });
  ok(forged.ok === false && forged.reason === 'unauthorized-confirm', 'real id + WRONG token → unauthorized (no forge)');
  // The true executor then reports the REAL failure — and it wins.
  const real = confirmGitWrite(d.record.id, { token: d.record.confirmToken, projectKey: PROJECT, exitStatus: 1 });
  const row = listGitWrites(PROJECT, 5)[0];
  ok(real.ok === true && row.outcome === 'failed' && row.exitStatus === 1,
    'the real executor records the TRUE failure — no false executed/exit0 (A1 closed)');
  ok(row.confirmAnomalies >= 1, 'the forged attempt is visible as an anomaly on the row');

  console.log('\n[attack A2] a foreign project cannot confirm another project\'s record');
  _resetGitGrantsForTest();
  grantGitWrite('A', { scope: 'duration', ttlMs: 20 * 60 * 1000 });
  grantGitWrite('B', { scope: 'duration', ttlMs: 20 * 60 * 1000 });
  const da = evaluateGitWrite({ argv: ['commit', '-m', 'a'], projectKey: 'A', runLeakGate: () => ({ ok: true, detail: '' }) });
  // B presents A's token but declares projectKey 'B' → owner binding rejects it.
  const cross = confirmGitWrite(da.record.id, { token: da.record.confirmToken, projectKey: 'B', exitStatus: 0 });
  ok(cross.ok === false && listGitWrites('A', 5)[0].outcome === 'permitted',
    "foreign owner (project B) confirming A's record → rejected; A stays permitted (A2 closed)");

  console.log('\n[attack A3] a stale pre-restart confirm cannot land on a reused id');
  _resetGitGrantsForTest(); // simulate restart: ledgerSeq back to 0
  grantGitWrite('C', { scope: 'duration', ttlMs: 20 * 60 * 1000 });
  const dc = evaluateGitWrite({ argv: ['commit', '-m', 'new'], projectKey: 'C', runLeakGate: () => ({ ok: true, detail: '' }) });
  ok(!/^w1$/.test(dc.record.id), 'new record id is NOT bare "w1" (boot-nonce woven in)');
  const stale = confirmGitWrite('w1', { token: 'old-token', projectKey: 'C', exitStatus: 0 });
  ok(stale.ok === false && listGitWrites('C', 5)[0].outcome === 'permitted',
    'a stale "w1" confirm from before the restart → rejected; the new write stays permitted (A3 closed)');
}

function abortedLeg() {
  console.log('\n[aborted] a permit the executor never confirms STAYS permitted (the ticket scenario)');
  _resetGitGrantsForTest();
  grantGitWrite(PROJECT, { scope: 'duration', ttlMs: 20 * 60 * 1000 });
  // Host decides ALLOW + records; the shim aborts before confirming (BUG-173
  // timeout residual) → no confirm ever arrives.
  evaluateGitWrite({ argv: ['commit', '-m', 'aborted'], projectKey: PROJECT, runLeakGate: () => ({ ok: true, detail: '' }) });
  const w = listGitWrites(PROJECT, 5)[0];
  ok(w.outcome === 'permitted' && w.exitStatus === null,
    "never-confirmed permit stays 'permitted' — the audit does not claim a commit HEAD lacks");
}

// ── E2E: a real shim subprocess + a real host process (decide + confirm) ────────
const HOST_SRC = `
import http from 'node:http';
import { evaluateGitWrite } from ${JSON.stringify(path.join(LIBDIR, 'git-grant.mjs'))};
import { grantGitWrite, listGitWrites, confirmGitWrite, _resetGitGrantsForTest } from ${JSON.stringify(path.join(LIBDIR, 'git-grant-store.mjs'))};
delete process.env.ORCHARD_ALLOW_GIT_WRITE;
const EXPECTED = process.env.EXPECTED_AUTH || '';
const read = (req) => new Promise((r) => { let s=''; req.on('data',c=>s+=c); req.on('end',()=>r(s)); });
const send = (res,obj) => { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify(obj)); };
const server = http.createServer(async (req,res) => {
  const raw = await read(req);
  if (req.url === '/_test/reset') { _resetGitGrantsForTest(); return send(res,{ok:true}); }
  if (req.url === '/_test/grant') { const b=JSON.parse(raw||'{}'); grantGitWrite(b.projectKey,{scope:b.scope,ttlMs:b.ttlMs}); return send(res,{ok:true}); }
  if (req.url === '/_test/writes') { const b=JSON.parse(raw||'{}'); return send(res,{writes:listGitWrites(b.projectKey,20)}); }
  if (req.method==='POST' && req.url==='/api/git-shim/decide') {
    let body; try { body = JSON.parse(raw||'{}'); } catch { return send(res,{allow:false,reason:'unreadable'}); }
    const grantKey = typeof body.grantKey==='string'&&body.grantKey?body.grantKey:null;
    const argv = Array.isArray(body.argv)?body.argv.filter(a=>typeof a==='string'):null;
    const auth = typeof body.shimAuth==='string'?body.shimAuth:null;
    if (!grantKey||!argv) return send(res,{allow:false,reason:'required'});
    if (auth !== EXPECTED) return send(res,{allow:false,reason:'invalid shim credential'});
    const d = evaluateGitWrite({ argv, projectKey:grantKey, sessionLabel:null, runLeakGate:()=>({ok:true,detail:''}) });
    return send(res,{ allow:!!d.allow, reason:d.reason??null, offender:d.offender??null, recordId:d.record?.id??null, confirmToken: d.allow&&d.granted ? (d.record?.confirmToken??null) : null });
  }
  if (req.method==='POST' && req.url==='/api/git-shim/confirm') {
    let body; try { body = JSON.parse(raw||'{}'); } catch { return send(res,{ok:false}); }
    const auth = typeof body.shimAuth==='string'?body.shimAuth:null;
    if (auth !== EXPECTED) return send(res,{ok:false,reason:'invalid'});
    const recordId = typeof body.recordId==='string'&&body.recordId?body.recordId:null;
    const status = typeof body.status==='number'?body.status:Number.NaN;
    const token = typeof body.token==='string'?body.token:null;
    const projectKey = typeof body.projectKey==='string'?body.projectKey:null;
    if (!recordId || Number.isNaN(status)) return send(res,{ok:false});
    const r = confirmGitWrite(recordId,{token,projectKey,exitStatus:status});
    return send(res,{ ok:r.ok, outcome:r.record?.outcome??null, reason:r.reason });
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
    child.stdout.on('data', (c) => { buf += c; const mm = buf.match(/READY (\d+)/); if (mm) { clearTimeout(to); resolve(Number(mm[1])); } });
    child.on('exit', () => { clearTimeout(to); reject(new Error('host process exited early')); });
  });
  return { child, url: `http://127.0.0.1:${port}` };
}
const ctl = (url, p, body) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());

function scratchRepo(name) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, name + '-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: BASE });
  g('init', '-q'); g('config', 'user.email', 'x@x'); g('config', 'user.name', 'x');
  fs.writeFileSync(path.join(dir, 'a'), '1'); g('add', 'a'); g('commit', '-q', '-m', 'seed');
  return { dir, g };
}
const head = (g) => g('rev-parse', 'HEAD').trim();

async function e2eLeg() {
  console.log('\n[e2e] real `git commit` through the installed shim + a real host (decide + confirm)');
  const { child, url: hostUrl } = await startHostProcess();
  try {
    const { dir, g } = scratchRepo('e2e');
    const { env: shimEnv } = installGitShim(BASE, { baseDir: SCRATCH, grantKey: PROJECT, hostUrl, shimAuth: TEST_AUTH });
    await ctl(hostUrl, '/_test/reset');

    // (1) a commit that LANDS.
    await ctl(hostUrl, '/_test/grant', { projectKey: PROJECT, scope: 'duration', ttlMs: 20 * 60 * 1000 });
    fs.writeFileSync(path.join(dir, 'a'), 'changed'); // modify the TRACKED file so -am has something to commit
    const beforeOk = head(g);
    const r1 = spawnSync('git', ['-C', dir, 'commit', '-am', 'land it'], { encoding: 'utf8', env: shimEnv });
    const moved = head(g) !== beforeOk;
    const rows1 = (await ctl(hostUrl, '/_test/writes', { projectKey: PROJECT })).writes;
    const commitRow1 = rows1.find((w) => w.offender && w.offender.includes('commit'));
    ok(r1.status === 0 && moved, 'real granted commit → git exit 0 and HEAD moved');
    ok(commitRow1 && commitRow1.outcome === 'executed' && commitRow1.exitStatus === 0,
      "ledger records the LANDED commit as 'executed' (exit 0) — genuine-success unregressed");

    // (2) a granted git write whose exec EXITS NON-ZERO (nothing to commit).
    await ctl(hostUrl, '/_test/reset');
    await ctl(hostUrl, '/_test/grant', { projectKey: PROJECT, scope: 'duration', ttlMs: 20 * 60 * 1000 });
    const beforeFail = head(g);
    const r2 = spawnSync('git', ['-C', dir, 'commit', '-am', 'nothing staged'], { encoding: 'utf8', env: shimEnv });
    const unmoved = head(g) === beforeFail;
    const rows2 = (await ctl(hostUrl, '/_test/writes', { projectKey: PROJECT })).writes;
    const commitRow2 = rows2.find((w) => w.offender && w.offender.includes('commit'));
    ok(r2.status !== 0 && unmoved, 'granted commit with nothing to commit → git exits non-zero, HEAD unmoved');
    ok(commitRow2 && commitRow2.outcome === 'failed' && commitRow2.exitStatus !== 0,
      "ledger records the NON-ZERO git as 'failed', NOT gate=pass — HEAD contradiction impossible");
  } finally {
    child.kill();
  }
}

async function main() {
  await preFixLeg();
  stateMachineLeg();
  attackLeg();
  abortedLeg();
  await e2eLeg();
  _resetGitGrantsForTest();
  console.log(`\nBUG-184: ${pass} passed, ${fail} failed`);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('verify threw:', e); try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} process.exit(1); });
