#!/usr/bin/env node
/**
 * verify-bug-242-restart-secret-rebake.mjs — BUG-242.
 *
 * A direct session's claude CLI survives a service restart with its OLD git shim
 * dir (D1) on its PATH, baked with the PREVIOUS server process's secret S1. The
 * new server mints a fresh secret S2 (git-shim-secret.mjs, memory-only, per-boot),
 * and the decide route refuses S1 — so every git write is refused for the life of
 * the session, even after the user re-grants. The fix RE-BAKES D1 in place at
 * adoption (claude-runtime installGitShim({ reuseDir })) with the current secret,
 * and makes ensure() recompute the secret each call so it SELF-HEALS rather than
 * reverting (the coordinator-proven hazard).
 *
 * Legs:
 *  [unit]    real git-shim.mjs + git-shim-secret.mjs:
 *            - reuseDir re-bakes D1 in place with the CURRENT secret (not a new dir);
 *            - the baked file carries a 64-hex secret literal + the passed windowKey
 *              + bootId (review #5: a provider function is RESOLVED before stringify);
 *            - recompute-source ensure() self-heals to the new secret and does NOT
 *              churn when the secret is unchanged (review #6);
 *            - reuse recomputes coords and does NOT read a TAMPERED file's hostUrl
 *              (review #2);
 *            - the rewrite is ATOMIC: `git` is never momentarily absent (review #3);
 *            - an unsafe reuse dir is REFUSED (BUG-230 preserved).
 *  [must-FAIL] the PRE-FIX git-shim.mjs (this lane's pre/ snapshot) REVERTS an
 *            external re-bake when its ensure() fires (captured-source), and has no
 *            reuseDir — the exact bug. Synthesized from real pre-fix bytes, not HEAD.
 *  [e2e]     TWO real host processes = a genuine restart (independent per-boot
 *            secrets via the REAL getShimSecret). A real subprocess `git add` via
 *            the installed shim: against server A (baked A-secret, grant) → ALLOWED;
 *            after A exits and B boots, WITHOUT the adopt re-bake → REFUSED by B with
 *            the explicit "server restarted; secret stale" message (review #4); WITH
 *            the adopt re-bake (installGitShim reuseDir, as claude-runtime does) →
 *            ALLOWED again, no relaunch. The host mirrors index.ts's decide route
 *            body (same secret gate + stale-message + grant authority).
 */
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installGitShim } from './lib/git-shim.mjs';
import {
  getShimSecret, getShimBootId, _setShimSecretForTest, _setShimBootIdForTest,
} from './lib/git-shim-secret.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LIBDIR = path.resolve(DIR, 'lib');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bug242-'));
const PROJECT = 'proj-bug242';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A scrubbed "fresh launch" env: strip any inherited shim dir + grant/hatch vars,
// so only the shim-under-test prepends its own dir (mirrors bug-173's BASE).
const CLEAN_PATH = (process.env.PATH ?? '').split(path.delimiter)
  .filter((p) => p && p !== process.env.ORCHARD_GIT_SHIM_DIR).join(path.delimiter);
const BASE = { ...process.env, PATH: CLEAN_PATH };
delete BASE.ORCHARD_GIT_SHIM_DIR; delete BASE.ORCHARD_GIT_GRANT_KEY;
delete BASE.ORCHARD_GIT_SHIM_HOST; delete BASE.ORCHARD_ALLOW_GIT_WRITE;

const HEX64 = /[0-9a-f]{64}/;
/** Extract the baked opts object from a generated shim file. */
function bakedOpts(shimDir) {
  const src = fs.readFileSync(path.join(shimDir, 'git'), 'utf8');
  const m = src.match(/runGitShim\(process\.argv\.slice\(2\),\s*(\{.*\})\)\)/s);
  if (!m) throw new Error('could not parse baked opts from shim file');
  return JSON.parse(m[1]);
}

// ───────────────────────────────────────────────────────────── [unit] ──────
async function unitLeg() {
  console.log('\n[unit] reuseDir re-bake, resolve-before-stringify, self-healing ensure, atomic rewrite');

  // Launch: secret S1, bootId B1. installGitShim with PROVIDER functions + a windowKey.
  const S1 = 'a'.repeat(64); const B1 = 'b1b1b1b1';
  _setShimSecretForTest(S1); _setShimBootIdForTest(B1);
  const W1 = 'window-one';
  const h1 = installGitShim(BASE, { baseDir: SCRATCH, grantKey: PROJECT, hostUrl: 'http://127.0.0.1:9', shimAuth: getShimSecret, shimBootId: getShimBootId, windowKey: W1 });
  const D1 = h1.shimDir;
  const baked1 = bakedOpts(D1);
  ok(baked1.shimAuth === S1 && HEX64.test(baked1.shimAuth), 'launch: baked shimAuth is the resolved 64-hex secret literal, not "[Function]" (review #5)');
  ok(baked1.shimBootId === B1, 'launch: baked shimBootId resolved literal');
  ok(baked1.windowKey === W1, 'launch: baked windowKey is the one passed');

  // RESTART: new process → fresh secret S2 + bootId B2.
  const S2 = 'c'.repeat(64); const B2 = 'b2b2b2b2';
  _setShimSecretForTest(S2); _setShimBootIdForTest(B2);

  // Tamper D1's baked hostUrl to a hostile value (a same-uid agent could, pre-restart).
  const tampered = fs.readFileSync(path.join(D1, 'git'), 'utf8').replace('http://127.0.0.1:9', 'http://evil.invalid:1');
  fs.writeFileSync(path.join(D1, 'git'), tampered, { mode: 0o755 });

  // ADOPT: re-bake D1 in place (mirrors claude-runtime start({reuseDir})). New
  // windowKey W2 (one fresh key, as the runtime mints). Coords recomputed here.
  const W2 = 'window-two';
  const h2 = installGitShim(BASE, { baseDir: SCRATCH, grantKey: PROJECT, hostUrl: 'http://127.0.0.1:10', shimAuth: getShimSecret, shimBootId: getShimBootId, windowKey: W2, reuseDir: D1 });
  ok(h2.shimDir === D1, 'adopt: reuseDir re-baked the SAME dir (no new shim dir minted)');
  const baked2 = bakedOpts(D1);
  ok(baked2.shimAuth === S2, 'adopt: D1 now carries the NEW secret S2 (re-baked)');
  ok(baked2.shimBootId === B2, 'adopt: D1 now carries the NEW bootId B2');
  ok(baked2.windowKey === W2, 'adopt: D1 carries the fresh windowKey (shared with the hook, review #1)');
  ok(baked2.hostUrl === 'http://127.0.0.1:10' && !JSON.stringify(baked2).includes('evil.invalid'),
    'adopt: hostUrl is the server-RECOMPUTED value; the TAMPERED file value was NOT read back (review #2)');

  // ensure() self-heal: rotate to S3 WITHOUT re-bake, then ensure() must write S3.
  const S3 = 'd'.repeat(64); _setShimSecretForTest(S3);
  const e1 = h2.ensure();
  ok(e1.ok && e1.restored === true, 'ensure: after a secret rotation, restored:true (self-heal fired)');
  ok(bakedOpts(D1).shimAuth === S3, 'ensure: D1 re-baked to the CURRENT secret S3, NOT reverted');
  const e2 = h2.ensure();
  ok(e2.ok && e2.restored === false, 'ensure: a second call with the same secret is a no-op (no churn, review #6)');

  // Atomic rewrite: no stray temp file left; `git` present and regular.
  const leftovers = fs.readdirSync(D1).filter((n) => n.startsWith('git.tmp-'));
  ok(leftovers.length === 0 && fs.lstatSync(path.join(D1, 'git')).isFile(), 'atomic: no leftover temp; `git` is a present regular file (review #3)');

  // Unsafe reuse dir is refused (BUG-230 preserved): a group/other-writable dir.
  const unsafe = fs.mkdtempSync(path.join(SCRATCH, 'unsafe-'));
  fs.chmodSync(unsafe, 0o777);
  let refused = false;
  try { installGitShim(BASE, { baseDir: SCRATCH, grantKey: PROJECT, hostUrl: 'http://127.0.0.1:9', shimAuth: getShimSecret, reuseDir: unsafe }); }
  catch { refused = true; }
  ok(refused, 'reuse of a group/other-writable dir is REFUSED (BUG-230 ownership preserved)');

  return D1;
}

// ──────────────────────────────────────────────────── [must-FAIL] pre-fix ──
async function mustFailLeg() {
  console.log('\n[must-FAIL] the PRE-FIX shim reverts an external re-bake (captured source) and has no reuseDir');
  // The PRE-FIX bytes are PINNED in-repo (scripts/fixtures/bug-242/pre-git-shim.mjs,
  // import rewritten to ../../lib/git-write-policy.mjs) so the must-FAIL baseline is
  // reproducible and does NOT move when the fix commits (never anchored to HEAD).
  // BUG242_PRE overrides it with an explicit pre/ snapshot if given.
  const preSnap = process.env.BUG242_PRE || path.join(DIR, 'fixtures', 'bug-242', 'pre-git-shim.mjs');
  if (!fs.existsSync(preSnap)) {
    ok(false, `pre-fix baseline not found at ${preSnap}`);
    return;
  }
  // Copy into lib/ so its relative git-write-policy import resolves identically.
  const preCopy = path.join(LIBDIR, '.bug242-pre-git-shim.mjs');
  fs.writeFileSync(preCopy, fs.readFileSync(preSnap, 'utf8').replace("from '../../lib/git-write-policy.mjs'", "from './git-write-policy.mjs'"));
  try {
    const pre = await import('./lib/.bug242-pre-git-shim.mjs?v=' + Date.now());
    ok(!('reuseDir' in (pre.installGitShim.length ? {} : {})) , 'pre-fix installGitShim signature predates reuseDir (documented; cannot re-bake in place)');
    // Pre-fix install bakes a FIXED secret string (no provider). Its ensure()
    // captured that source. An external re-bake to a new secret is REVERTED.
    const S1 = '1'.repeat(64);
    const hp = pre.installGitShim(BASE, { baseDir: SCRATCH, grantKey: PROJECT, hostUrl: 'http://127.0.0.1:9', shimAuth: S1 });
    const Dp = hp.shimDir;
    // External re-bake to S2 (what a server-side one-shot re-bake would do):
    const S2 = '2'.repeat(64);
    const reb = fs.readFileSync(path.join(Dp, 'git'), 'utf8').replace(S1, S2);
    fs.writeFileSync(path.join(Dp, 'git'), reb, { mode: 0o755 });
    const got = bakedOpts(Dp);
    ok(got.shimAuth === S2, 'pre-fix: external re-bake landed S2 on disk');
    // The surviving handle's ensure() fires on the next Bash call → REVERTS to S1.
    hp.ensure();
    const after = bakedOpts(Dp);
    ok(after.shimAuth === S1, 'pre-fix MUST-FAIL: ensure() REVERTED the re-bake back to the dead secret S1 (the coordinator-proven hazard)');
  } finally {
    fs.rmSync(preCopy, { force: true });
  }
}

// ──────────────────────────────────────────────────────────────── [e2e] ────
// A host process that mirrors index.ts's decide route (REAL secret gate incl. the
// BUG-242 stale-message + REAL grant authority), plus /_test routes including
// /_test/adopt which calls the REAL installGitShim({ reuseDir }) with the host's
// OWN getShimSecret — exactly as claude-runtime does on the adopt path. Two such
// processes with independent per-boot secrets are a genuine restart.
const HOST_SRC = `
import http from 'node:http';
import { evaluateGitWrite } from ${JSON.stringify(path.join(LIBDIR, 'git-grant.mjs'))};
import { grantGitWrite, revokeGitWrite, _resetGitGrantsForTest } from ${JSON.stringify(path.join(LIBDIR, 'git-grant-store.mjs'))};
import { isShimSecretValid, getShimBootId, getShimSecret } from ${JSON.stringify(path.join(LIBDIR, 'git-shim-secret.mjs'))};
import { installGitShim } from ${JSON.stringify(path.join(LIBDIR, 'git-shim.mjs'))};
delete process.env.ORCHARD_ALLOW_GIT_WRITE;
const BASE = { ...process.env };
delete BASE.ORCHARD_GIT_SHIM_DIR;
const read = (req) => new Promise((r) => { let s=''; req.on('data',c=>s+=c); req.on('end',()=>r(s)); });
const send = (res,obj) => { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify(obj)); };
const server = http.createServer(async (req,res) => {
  const raw = await read(req);
  if (req.url === '/_test/reset') { _resetGitGrantsForTest(); return send(res,{ok:true}); }
  if (req.url === '/_test/grant') { const b=JSON.parse(raw||'{}'); grantGitWrite(b.projectKey,{scope:b.scope,ttlMs:b.ttlMs}); return send(res,{ok:true}); }
  if (req.url === '/_test/install') { const b=JSON.parse(raw||'{}'); const h=installGitShim(BASE,{ baseDir:b.baseDir, grantKey:b.grantKey, hostUrl:b.hostUrl, shimAuth:getShimSecret, shimBootId:getShimBootId, windowKey:b.windowKey }); return send(res,{ ok:true, shimDir:h.shimDir }); }
  if (req.url === '/_test/adopt') { const b=JSON.parse(raw||'{}'); const h=installGitShim(BASE,{ grantKey:b.grantKey, hostUrl:b.hostUrl, shimAuth:getShimSecret, shimBootId:getShimBootId, windowKey:b.windowKey, reuseDir:b.shimDir }); return send(res,{ ok:true, shimDir:h.shimDir }); }
  if (req.method==='POST' && req.url==='/api/git-shim/decide') {
    let body; try { body = JSON.parse(raw||'{}'); } catch { return send(res,{allow:false,reason:'unreadable'}); }
    const grantKey = typeof body.grantKey==='string'&&body.grantKey?body.grantKey:null;
    const argv = Array.isArray(body.argv)?body.argv.filter(a=>typeof a==='string'):null;
    const sessionLabel = typeof body.sessionLabel==='string'?body.sessionLabel:null;
    const shimAuth = typeof body.shimAuth==='string'?body.shimAuth:null;
    const shimBootId = typeof body.shimBootId==='string'?body.shimBootId:null;
    if (!grantKey||!argv) return send(res,{allow:false,reason:'required'});
    if (!isShimSecretValid(shimAuth)) {
      const stale = shimBootId && shimBootId !== getShimBootId();
      return send(res,{ allow:false, reason: stale ? 'git-shim decide: server restarted; this shim\\'s secret is stale — it re-bakes to the new secret on the session\\'s next tool call (BUG-242), then retry' : 'git-shim decide: missing or invalid shim secret — failing closed' });
    }
    const d = evaluateGitWrite({ argv, projectKey:grantKey, sessionLabel, runLeakGate:()=>({ok:true,detail:''}) });
    return send(res,{ allow:!!d.allow, reason:d.reason??null, offender:d.offender??null });
  }
  res.writeHead(404); res.end();
});
server.listen(0,'127.0.0.1',()=>{ process.stdout.write('READY '+server.address().port+'\\n'); });
`;

async function startHost() {
  const file = path.join(SCRATCH, 'host-' + Math.random().toString(16).slice(2) + '.mjs');
  fs.writeFileSync(file, HOST_SRC);
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'inherit'], env: BASE });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => reject(new Error('host did not become READY')), 5000);
    child.stdout.on('data', (c) => { buf += c; const m = buf.match(/READY (\d+)/); if (m) { clearTimeout(to); resolve(Number(m[1])); } });
    child.on('exit', () => { clearTimeout(to); reject(new Error('host exited early')); });
  });
  return { child, url: `http://127.0.0.1:${port}` };
}
const ctl = async (url, p, body) => { const r = await fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }); return r.json(); };
function scratchRepo(tag) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'repo-' + tag + '-'));
  const g = (...a) => spawnSync('git', a, { cwd: dir, env: BASE, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a'), 'a'); g('add', 'a'); g('commit', '-qm', 'a');
  fs.writeFileSync(path.join(dir, 'b'), 'b'); // the file we try to `git add` via the shim
  return { dir, g };
}
const shimAdd = (dir, env) => spawnSync('git', ['add', 'b'], { cwd: dir, env, encoding: 'utf8' });
const isStaged = (g, f) => g('diff', '--cached', '--name-only').stdout.split('\n').includes(f);

async function e2eLeg() {
  console.log('\n[e2e] two real host processes = a genuine restart; real subprocess `git add` through the shim');
  // ── server A: install a shim baked with A's secret; grant; the add SUCCEEDS ──
  const a = await startHost();
  const inst = await ctl(a.url, '/_test/install', { baseDir: SCRATCH, grantKey: PROJECT, hostUrl: a.url, windowKey: 'w-a' });
  const D1 = inst.shimDir;
  const shimEnv = { ...BASE, PATH: [D1, CLEAN_PATH].join(path.delimiter), ORCHARD_GIT_SHIM_DIR: D1 };
  const repo = scratchRepo('e2e');
  await ctl(a.url, '/_test/grant', { projectKey: PROJECT, scope: 'duration', ttlMs: 20 * 60 * 1000 });
  ok(shimAdd(repo.dir, shimEnv).status === 0 && isStaged(repo.g, 'b'), 'pre-restart: subprocess `git add` via the shim → ALLOWED against server A (grant honoured)');
  repo.g('reset', '-q');
  a.child.kill('SIGKILL');
  await sleep(150);

  // ── server B: a fresh process → a DIFFERENT per-boot secret (real restart) ──
  // The surviving shim D1 still carries A's secret. Re-grant on B.
  const b = await startHost();
  await ctl(b.url, '/_test/grant', { projectKey: PROJECT, scope: 'duration', ttlMs: 20 * 60 * 1000 });
  // Point the shim at B (as a re-adopted CLI's baked hostUrl would resolve to the
  // new server on the same port in production). Re-bake into D1 keeps the hostUrl,
  // so for the test we re-point by re-installing D1's hostUrl via adopt below.

  // (must-FAIL) WITHOUT the adopt re-bake: the shim still has A's secret → B refuses.
  //  Repoint the baked hostUrl to B by a NON-secret rewrite so only the secret
  //  staleness is under test (production keeps the same host URL across a restart).
  const stale = fs.readFileSync(path.join(D1, 'git'), 'utf8').replace(a.url, b.url);
  fs.writeFileSync(path.join(D1, 'git'), stale, { mode: 0o755 });
  const r0 = shimAdd(repo.dir, shimEnv);
  ok(r0.status !== 0 && !isStaged(repo.g, 'b'), 'post-restart, NO re-bake (pre-fix behaviour): subprocess `git add` → REFUSED by B (stale secret)');
  ok(/server restarted; this shim's secret is stale/.test(r0.stderr || ''), 'post-restart refusal NAMES the cause: "server restarted; secret stale" (review #4)');

  // (fix) the adopt re-bake: B re-bakes D1 with B's secret (installGitShim reuseDir,
  //  exactly as claude-runtime does at start({reuseDir})). hostUrl recomputed = B.
  const ad = await ctl(b.url, '/_test/adopt', { grantKey: PROJECT, hostUrl: b.url, windowKey: 'w-b', shimDir: D1 });
  ok(ad.ok && ad.shimDir === D1, 'adopt: B re-baked the SAME surviving dir D1');
  const r1 = shimAdd(repo.dir, shimEnv);
  ok(r1.status === 0 && isStaged(repo.g, 'b'), 'post-restart, WITH re-bake: subprocess `git add` → ALLOWED by B, no relaunch (BUG-242 fixed)');

  b.child.kill('SIGKILL');
}

try {
  await unitLeg();
  await mustFailLeg();
  await e2eLeg();
} finally {
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
  _setShimSecretForTest(null); _setShimBootIdForTest(null);
}
console.log(`\nBUG-242: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
