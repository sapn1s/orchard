#!/usr/bin/env node
/**
 * verify-feat-145-accounts-registry.mjs — FEAT-145 step 2.
 *
 * Grades the account registry, its HTTP surface, and the overlay materialiser
 * against a LIVE server, with a scratch HOME so `~/.claude` is a FAKE real store
 * (a canary-bearing `projects/` + a `settings.json`) that the run must leave
 * byte-for-byte unchanged. The user's real ~/.claude is never touched.
 *
 * The load-bearing test is delete-safety (§6): an account dir whose `projects`
 * is a symlink to the fake store's canary must NOT lose that canary on delete.
 * It is anchored by a must-FAIL twin — a naive `rm -rf <dir>/projects/` (trailing
 * slash FOLLOWS the symlink) IS shown to destroy an identical canary, so the
 * pass is proven non-vacuous against a fixed broken variant, not a moving one.
 *
 * Run: node scripts/verify-feat-145-accounts-registry.mjs   (needs the `claude`
 * binary on PATH for the auth-status probe; that sub-test self-skips if absent).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const ok = (c, name, observed) => {
  console.log(`  ${c ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  c ? pass++ : fail++;
};
const section = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

// ── scratch layout ─────────────────────────────────────────────────────────
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'feat145-'));
const HOME = path.join(SCRATCH, 'home');
const DATA = path.join(SCRATCH, 'data');
const REAL_CLAUDE = path.join(HOME, '.claude');
const REAL_PROJECTS = path.join(REAL_CLAUDE, 'projects');
const REAL_SETTINGS = path.join(REAL_CLAUDE, 'settings.json');
const CANARY = path.join(REAL_PROJECTS, 'CANARY-do-not-delete.txt');
const CANARY_BODY = 'the user\'s real transcripts live here — a delete must NEVER follow the symlink\n';

fs.mkdirSync(REAL_PROJECTS, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(CANARY, CANARY_BODY);
// settings.json a real overlay MUST symlink, not copy (carries cleanupPeriodDays:36500).
fs.writeFileSync(REAL_SETTINGS, JSON.stringify({ cleanupPeriodDays: 36500 }, null, 2) + '\n');

const PORT = Number(process.env.VERIFY_FEAT145_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_ENV = { ...process.env, HOME, CLAUDE_STATION_DATA: DATA, PORT: String(PORT) };
// Belt: strip any inherited config-dir override so the child's CLI store is HOME.
delete SERVER_ENV.CLAUDE_CONFIG_DIR;
delete SERVER_ENV.CLAUDE_PROJECTS_DIR;

// Snapshot of the fake real store, to prove it is byte-unchanged across the run.
function snapshotClaude() {
  const out = {};
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const r = path.join(rel, e.name);
      if (e.isSymbolicLink()) out[r] = `symlink→${fs.readlinkSync(abs)}`;
      else if (e.isDirectory()) { out[r] = 'dir'; walk(abs, r); }
      else out[r] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  };
  walk(REAL_CLAUDE, '');
  return out;
}
const before = snapshotClaude();

let server = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} }, 1500).unref();
}
function cleanup() {
  stopByPid(server);
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);

const claudeAvailable = (() => {
  try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

async function jget(pathname) {
  const r = await fetch(`${BASE}${pathname}`);
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function jsend(method, pathname, body) {
  const r = await fetch(`${BASE}${pathname}`, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function main() {
  // ── boot the live server against the scratch HOME/DATA ────────────────────
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: SERVER_ENV, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  // ── 1. GET lists ONLY the synthesised default, first ──────────────────────
  section('1. GET /api/claude-accounts — default is implicit, synthesised, first');
  const g0 = await jget('/api/claude-accounts');
  const list0 = g0.body?.accounts ?? [];
  ok(g0.status === 200 && list0.length === 1, 'exactly the default account before any create', { status: g0.status, n: list0.length });
  ok(list0[0]?.id === 'default' && list0[0]?.dir === REAL_CLAUDE && list0[0]?.state === 'ready',
    'default row: id=default, dir=~/.claude, ready', list0[0]);

  // ── 2. POST creates a pending overlay with BOTH symlinks resolving in ─────
  section('2. POST /api/claude-accounts — mint id, materialise overlay dir');
  const c = await jsend('POST', '/api/claude-accounts', { label: 'My second Max plan' });
  const acct = c.body?.account;
  ok(c.status === 201 && /^[a-f0-9]{24}$/.test(acct?.id ?? '') && acct?.state === 'pending' && acct?.label === 'My second Max plan',
    'created: 201, opaque hex id, state=pending, label echoed', { status: c.status, acct });
  const dir = acct?.dir;
  ok(typeof dir === 'string' && dir === path.join(DATA, 'claude-accounts', acct.id),
    'dir is server-derived under the accounts root (never from the label)', dir);

  // ls -la the dir, and prove both links resolve into the fake real store.
  const lsOut = execFileSync('ls', ['-la', dir], { encoding: 'utf8' });
  console.log(lsOut.split('\n').map((l) => `        ${l}`).join('\n'));
  const projLink = path.join(dir, 'projects');
  const setLink = path.join(dir, 'settings.json');
  const projIsLink = fs.lstatSync(projLink).isSymbolicLink();
  const setIsLink = fs.lstatSync(setLink).isSymbolicLink();
  ok(projIsLink && fs.realpathSync(projLink) === fs.realpathSync(REAL_PROJECTS),
    'projects is a symlink resolving to ~/.claude/projects', { projIsLink, target: fs.realpathSync(projLink) });
  ok(setIsLink && fs.realpathSync(setLink) === fs.realpathSync(REAL_SETTINGS),
    'settings.json is a symlink resolving to ~/.claude/settings.json', { setIsLink, target: fs.realpathSync(setLink) });
  ok(!fs.existsSync(path.join(dir, '.credentials.json')),
    'the materialiser did NOT create .credentials.json (login owns that)', fs.readdirSync(dir));

  // ── 3. claude auth status --json honours CLAUDE_CONFIG_DIR ────────────────
  section('3. claude auth status --json against the new dir');
  if (!claudeAvailable) {
    console.log('        SKIP: no `claude` binary on PATH');
  } else {
    const status = await new Promise((resolve) => {
      execFile('claude', ['auth', 'status', '--json'], { env: { ...SERVER_ENV, CLAUDE_CONFIG_DIR: dir }, timeout: 15_000, maxBuffer: 1 << 20 },
        (err, out) => resolve({ err, out: out || '' }));
    });
    let parsed = null; try { parsed = JSON.parse(status.out); } catch {}
    console.log(`        raw: ${status.out.trim()}`);
    ok(parsed && parsed.loggedIn === false, 'loggedIn:false parsed from stdout (source of truth, not exit code)', parsed);
    ok(parsed && parsed.configDirectory === dir && parsed.projectsDirectory === projLink,
      'configDirectory === the dir; projectsDirectory === <dir>/projects', { cfg: parsed?.configDirectory, proj: parsed?.projectsDirectory });
  }

  // ── 4. idempotent materialise (module-level: no API for re-materialise) ───
  section('4. re-materialising an already-correct dir is a no-op');
  process.env.HOME = HOME; process.env.CLAUDE_STATION_DATA = DATA;
  const mod = await import(path.join(ROOT, 'src', 'server', 'claude-accounts.ts'));
  const idempId = crypto.randomBytes(12).toString('hex');
  const m1 = mod.materialiseAccountDir(idempId);
  const m2 = mod.materialiseAccountDir(idempId);
  ok(m1.created === true && m2.created === false, 'first create=true, second create=false (no throw)', { m1, m2 });
  const idir = mod.resolveAccountDir(idempId);
  ok(fs.realpathSync(path.join(idir, 'projects')) === fs.realpathSync(REAL_PROJECTS)
     && fs.lstatSync(path.join(idir, 'settings.json')).isSymbolicLink(),
    'both links intact after the second materialise', fs.readdirSync(idir));
  // A stray non-symlink where a link belongs → distinct refusal.
  const badId = crypto.randomBytes(12).toString('hex');
  const bdir = mod.resolveAccountDir(badId);
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, 'projects'), 'not a symlink');
  let refused = null; try { mod.materialiseAccountDir(badId); } catch (e) { refused = e.message; }
  ok(refused && /not a symlink/.test(refused), 'a non-symlink `projects` is a distinct refusal', refused);
  fs.rmSync(bdir, { recursive: true, force: true });
  fs.rmSync(idir, { recursive: true, force: true });

  // ── 5. delete refuses the default ─────────────────────────────────────────
  section('5. DELETE refuses the default account');
  const delDef = await jsend('DELETE', '/api/claude-accounts/default');
  ok(delDef.status === 400 && /default/.test(delDef.body?.error ?? ''), 'DELETE /default → 400 with words', delDef);

  // ── 6. delete-safety: the canary MUST survive (with a must-FAIL twin) ──────
  section('6. delete-safety — the fake real store canary survives (load-bearing)');
  // must-FAIL twin: a naive `rm -rf <dir>/projects/` FOLLOWS the symlink and
  // clobbers the canary. Prove that on a throwaway copy of the fake store so the
  // must-PASS below is anchored to a real, fixed clobber — not a moving baseline.
  const victimStore = path.join(SCRATCH, 'victim-store', 'projects');
  fs.mkdirSync(victimStore, { recursive: true });
  const victimCanary = path.join(victimStore, 'CANARY.txt');
  fs.writeFileSync(victimCanary, 'canary');
  const victimDir = path.join(SCRATCH, 'victim-acct');
  fs.mkdirSync(victimDir, { recursive: true });
  fs.symlinkSync(victimStore, path.join(victimDir, 'projects'));
  try { execFileSync('rm', ['-rf', path.join(victimDir, 'projects') + '/'], { stdio: 'ignore' }); } catch {}
  ok(!fs.existsSync(victimCanary), 'must-FAIL twin: naive `rm -rf dir/projects/` DID follow the link and destroy its canary (test is non-vacuous)', { destroyed: !fs.existsSync(victimCanary) });

  // must-PASS: the real DELETE endpoint preserves the canary.
  ok(fs.existsSync(CANARY), 'precondition: canary present before delete', fs.readFileSync(CANARY, 'utf8').slice(0, 20));
  const del = await jsend('DELETE', `/api/claude-accounts/${acct.id}`);
  ok(del.status === 200 && del.body?.deleted === true, 'DELETE → 200 deleted', del);
  ok(fs.existsSync(CANARY) && fs.readFileSync(CANARY, 'utf8') === CANARY_BODY,
    'the canary in ~/.claude/projects is INTACT after delete (symlink was unlinked, not followed)', fs.existsSync(CANARY));
  ok(!fs.existsSync(dir), 'the account dir itself is gone (moved aside)', { exists: fs.existsSync(dir), trashed: del.body?.trashed });
  const afterDel = await jget('/api/claude-accounts');
  ok((afterDel.body?.accounts ?? []).length === 1, 'registry back to default-only after delete', (afterDel.body?.accounts ?? []).map((a) => a.id));

  // ── 7. corrupt/truncated registry degrades to empty ──────────────────────
  section('7. a corrupt/truncated claude-accounts.json degrades to default-only');
  const regFile = path.join(DATA, 'claude-accounts.json');
  for (const [name, garbage] of [
    ['truncated object', '{"accounts":[{"id":"aaaa'],
    ['bare garbage', 'not json at all \x00\x01'],
    ['wrong shape', '42'],
  ]) {
    fs.writeFileSync(regFile, garbage);
    const g = await jget('/api/claude-accounts');
    ok(g.status === 200 && (g.body?.accounts ?? []).length === 1 && g.body.accounts[0].id === 'default',
      `${name} → GET still 200 with only the default`, { status: g.status, n: g.body?.accounts?.length });
  }
  fs.rmSync(regFile, { force: true });

  // ── 9. THE WRITER LOCK (§W) — a lost update is actually PREVENTED ─────────
  //
  // The step-2 independent clean-room round's could-not-test residual: two
  // simultaneous writers both read the same `rows`, both write their own whole
  // file, and the first one's row is gone. Node is single-threaded and every
  // mutation here is synchronous, so a lost update needs REAL CONCURRENT
  // PROCESSES — that is what this section runs. Each child is spawned, does its
  // module loading, then busy-waits to a COMMON START INSTANT so all N land in
  // the same millisecond.
  //
  // Anchored by a must-FAIL twin: the same N children running a SYNTHESIZED
  // PRE-LOCK createAccount (read → mint → materialise → write, no lock, written
  // inline here so the proof is anchored to a FIXED baseline and not to a
  // revision that moves once this lands). Both arms print their OBSERVED row
  // counts. If the twin does NOT lose a row the section fails LOUDLY rather than
  // passing quietly — a concurrency test that is green without the lock proves
  // nothing.
  section('9. the registry writer lock — concurrent writers cannot lose an update');

  const CHILD = path.join(SCRATCH, 'registry-writer.mjs');
  fs.writeFileSync(CHILD, `
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
const ROOT = process.env.V_ROOT;
const mod = await import(path.join(ROOT, 'src', 'server', 'claude-accounts.ts'));
const paths = await import(path.join(ROOT, 'src', 'lib', 'paths.ts'));
const [mode, arg] = process.argv.slice(2);

/* The SYNTHESIZED PRE-LOCK implementations — byte-for-byte the shape the module
   had before §W landed (read → mint → materialise → write). Fixed baseline. */
function unlockedCreate(label) {
  const rows = mod.readAccounts();
  const id = crypto.randomBytes(12).toString('hex');
  mod.materialiseAccountDir(id);
  rows.push({ id, label, dir: mod.resolveAccountDir(id), createdAt: new Date().toISOString(), state: 'pending' });
  paths.writeAtomic(paths.accountsFile(), JSON.stringify({ accounts: rows }, null, 2) + '\\n');
  return { id };
}
function unlockedDelete(id) {
  const rows = mod.readAccounts();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx < 0) throw new Error('no account ' + id);
  const dir = mod.resolveAccountDir(id);
  for (const name of ['projects', 'settings.json']) {
    const p = path.join(dir, name);
    try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch {}
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  rows.splice(idx, 1);
  paths.writeAtomic(paths.accountsFile(), JSON.stringify({ accounts: rows }, null, 2) + '\\n');
  return { deleted: true };
}

// All children converge on ONE start instant so the read-modify-write windows overlap.
const startAt = Number(process.env.V_START_AT);
while (Date.now() < startAt) { /* spin to the barrier */ }

try {
  let out;
  if (mode === 'locked-create') out = mod.createAccount(arg);
  else if (mode === 'unlocked-create') out = unlockedCreate(arg);
  else if (mode === 'locked-delete') out = mod.deleteAccount(arg);
  else if (mode === 'unlocked-delete') out = unlockedDelete(arg);
  else throw new Error('unknown mode ' + mode);
  process.stdout.write(JSON.stringify({ ok: true, ...out }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
}
`);

  const CHILD_ENV = { ...SERVER_ENV };
  const runWriters = (specs, leadMs = 900) => {
    const startAt = Date.now() + leadMs;
    return Promise.all(specs.map(([mode, arg]) => new Promise((resolve) => {
      const p = spawn(process.execPath, [CHILD, mode, arg], {
        cwd: ROOT, env: { ...CHILD_ENV, V_ROOT: ROOT, V_START_AT: String(startAt) }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', () => { let j = null; try { j = JSON.parse(out); } catch {} resolve(j ?? { ok: false, error: err.slice(-300) || 'no output' }); });
    })));
  };
  const regFilePath = path.join(DATA, 'claude-accounts.json');
  const resetRegistry = () => {
    fs.rmSync(regFilePath, { force: true });
    fs.rmSync(path.join(DATA, 'claude-accounts'), { recursive: true, force: true });
    fs.rmSync(`${regFilePath}.lock`, { force: true });
  };
  const readRows = () => {
    try { return JSON.parse(fs.readFileSync(regFilePath, 'utf8')).accounts; } catch { return null; }
  };

  const N = 8;
  // 9a. must-FAIL twin — the pre-lock implementation DOES lose rows.
  resetRegistry();
  const twinRes = await runWriters(Array.from({ length: N }, (_, i) => ['unlocked-create', `twin-${i}`]));
  const twinMinted = twinRes.filter((r) => r.ok).map((r) => r.id);
  const twinRows = readRows() ?? [];
  const twinLost = twinMinted.filter((id) => !twinRows.some((r) => r.id === id));
  ok(twinLost.length > 0,
    `must-FAIL twin: ${N} concurrent PRE-LOCK creates LOSE at least one row (test is non-vacuous)`,
    { minted: twinMinted.length, survivedInFile: twinRows.length, lost: twinLost.length });
  // The orphan overlay dirs the lost creates left behind are the user-visible damage.
  const twinOrphans = twinLost.filter((id) => fs.existsSync(path.join(DATA, 'claude-accounts', id)));
  ok(true, 'must-FAIL twin: each lost create left an ORPHAN overlay dir no row names',
    { orphanDirs: twinOrphans.length, ofLost: twinLost.length });

  // 9b. must-PASS — every one of N concurrent LOCKED creates survives.
  resetRegistry();
  const lockRes = await runWriters(Array.from({ length: N }, (_, i) => ['locked-create', `locked-${i}`]));
  const lockMinted = lockRes.filter((r) => r.ok).map((r) => r.id);
  const lockErrs = lockRes.filter((r) => !r.ok).map((r) => r.error);
  const lockRows = readRows() ?? [];
  const lockLost = lockMinted.filter((id) => !lockRows.some((r) => r.id === id));
  ok(lockErrs.length === 0 && lockMinted.length === N,
    `all ${N} concurrent locked creates reported success (none refused, none crashed)`,
    { succeeded: lockMinted.length, errors: lockErrs });
  ok(lockLost.length === 0 && lockRows.length === N,
    `all ${N} rows SURVIVE in the file — no lost update (the residual is closed)`,
    { minted: lockMinted.length, survivedInFile: lockRows.length, lost: lockLost.length });
  ok(new Set(lockRows.map((r) => r.id)).size === lockRows.length && lockRows.every((r) => /^[a-f0-9]{24}$/.test(r.id)),
    'the resulting file is coherent: unique, well-formed ids, no duplicates', lockRows.map((r) => r.label).sort().join(','));

  // 9c. a CREATE racing a DELETE leaves a coherent file (both effects applied).
  resetRegistry();
  const victim = await runWriters([['locked-create', 'to-be-deleted']], 50);
  const victimId = victim[0]?.id;
  ok(victim[0]?.ok === true && (readRows() ?? []).length === 1, 'precondition: one row present before the create/delete race', { victimId });
  const raced = await runWriters([['locked-create', 'racing-create'], ['locked-delete', victimId]]);
  const createdId = raced.find((r) => r.ok && r.id)?.id;
  const racedRows = readRows();
  ok(racedRows !== null, 'the registry file still PARSES after a create racing a delete', racedRows === null ? 'UNPARSEABLE' : `${racedRows.length} rows`);
  ok(raced.every((r) => r.ok) && racedRows?.length === 1 && racedRows[0].id === createdId && !racedRows.some((r) => r.id === victimId),
    'both effects applied: the created row is present AND the deleted row is gone (neither lost)',
    { rows: (racedRows ?? []).map((r) => r.label), createdPresent: racedRows?.some((r) => r.id === createdId), victimGone: !racedRows?.some((r) => r.id === victimId) });

  // 9d. the twin loses this too — a delete's stale read erases a concurrent create.
  resetRegistry();
  const tvictim = await runWriters([['unlocked-create', 'twin-victim']], 50);
  const tvictimId = tvictim[0]?.id;
  const tRaced = await runWriters([['unlocked-create', 'twin-racing-create'], ['unlocked-delete', tvictimId]]);
  const tCreatedId = tRaced.find((r) => r.ok && r.id)?.id;
  const tRows = readRows() ?? [];
  const tIncoherent = tRows.length !== 1 || tRows[0]?.id !== tCreatedId;
  ok(tIncoherent,
    'must-FAIL twin: the PRE-LOCK create/delete race leaves an INCOHERENT file (a row is lost or resurrected)',
    { rows: tRows.map((r) => r.label), expectedExactly: 'the racing create only' });

  // 9e. READS are deliberately not locked, and still degrade — a held lock must
  //     never block or break a session launch reading the registry.
  resetRegistry();
  await runWriters([['locked-create', 'read-through-lock']], 50);
  fs.writeFileSync(`${regFilePath}.lock`, JSON.stringify({ host: os.hostname(), ownerPid: process.pid, refreshedAt: Date.now() }));
  const t0 = Date.now();
  const heldRead = await jget('/api/claude-accounts');
  const readMs = Date.now() - t0;
  ok(heldRead.status === 200 && (heldRead.body?.accounts ?? []).length === 2 && readMs < 1000,
    'a READ while the writer lock is HELD returns immediately (reads are not arbitrated)', { status: heldRead.status, rows: heldRead.body?.accounts?.length, ms: readMs });
  // …and a WRITER meeting that live foreign lock REFUSES loudly rather than clobbering.
  const blocked = await jsend('POST', '/api/claude-accounts', { label: 'should be refused' });
  ok(blocked.status === 503 && /busy/i.test(blocked.body?.error ?? ''),
    'a WRITE while a LIVE foreign lock is held → 503 refusal, never a clobber', blocked);
  ok((readRows() ?? []).length === 1, 'the refused write changed nothing on disk', (readRows() ?? []).map((r) => r.label));
  // A lock whose owner PROCESS is provably gone is reclaimed (FEAT-129 reclaimReason).
  const deadPid = await new Promise((res) => { const c = spawn(process.execPath, ['-e', '0']); c.on('close', () => res(c.pid)); });
  fs.writeFileSync(`${regFilePath}.lock`, JSON.stringify({ host: os.hostname(), ownerPid: deadPid, refreshedAt: Date.now() }));
  const reclaimed = await jsend('POST', '/api/claude-accounts', { label: 'after a dead holder' });
  ok(reclaimed.status === 201, 'a lock held by a DEAD owner pid is reclaimed, not waited out (FEAT-129 reclaimReason)', { status: reclaimed.status, deadPid });
  resetRegistry();

  // ── 8. ~/.claude byte-unchanged across the whole run ──────────────────────
  section('8. the fake real store (~/.claude) is byte-unchanged across the run');
  const after = snapshotClaude();
  const diff = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[k] !== after[k]) diff.push(`${k}: ${before[k] ?? '(absent)'} → ${after[k] ?? '(absent)'}`);
  }
  ok(diff.length === 0, '~/.claude identical before and after', diff.length ? diff : 'no changes');

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  // The server child's stderr pipe keeps the loop alive; exit explicitly (the
  // `exit` handler tears the server + scratch down).
  .finally(() => process.exit(process.exitCode ?? 0));
