#!/usr/bin/env node
/**
 * verify-feat-129-file-lock.mjs — FEAT-129.
 *
 * Grades the advisory file-busy lock: the REAL clobber (a concurrent lane's git
 * checkout / whole-file Write dropping another lane's uncommitted hunk) is
 * reproduced on a real scratch git repo and proven STOPPED; the stale/dead-owner
 * reaper releases without wedging; a solo lane is unaffected; two sessions on one
 * project coordinate; and the reclaim is race-safe under real concurrent processes.
 *
 * DRIVEN, NOT ASSERTED. Section 2 runs the ACTUAL clobber commands (`git checkout`)
 * against a real repo and reads bytes off disk — must-FAIL proven with the escape
 * hatch open (= pre-change behaviour), must-PASS with the lock on. Section 6 forks
 * real child processes that race the same path, the "a race is a timing not a
 * shape" bar the working agreement demands. Section 7 PINS the wiring textually to
 * claude-runtime.ts so the module cannot silently diverge from the shipped hook.
 *
 * Run: node scripts/verify-feat-129-file-lock.mjs   (free, gate-safe)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  classifyMutation, scanBashMutation, evaluateFileLock, reclaimReason,
  fileLockEnabled, lockKeyFor, FILE_LOCK_TTL_MS,
  refreshOwnedLocks, heartbeatIntervalMs,
} from './lib/file-lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };
const section = (s) => console.log(`\n== ${s}`);

const SCRATCH = fs.mkdtempSync(path.join(process.env.HOME || os.tmpdir(), 'scratch', 'feat129-'));
const cleanup = () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }
function makeRepo(name) {
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  return dir;
}
const read = (f) => fs.readFileSync(f, 'utf8');
const write = (f, c) => fs.writeFileSync(f, c);

/* ───────────────────────────────────────────────────────── 1. classifier */
section('1. mutation classifier (pure)');
ok(classifyMutation({ toolName: 'Write', toolInput: { file_path: '/r/a' } }).mutates, 'Write mutates');
ok(classifyMutation({ toolName: 'Edit', toolInput: { file_path: '/r/a' } }).mutates, 'Edit mutates');
ok(!classifyMutation({ toolName: 'Read', toolInput: { file_path: '/r/a' } }).mutates, 'Read does not mutate');
ok(scanBashMutation('git checkout -- src/a').paths?.[0] === 'src/a', 'git checkout -- path → that path');
ok(scanBashMutation('git reset --hard').tree === true, 'git reset --hard → whole tree');
ok(scanBashMutation('git stash').tree === true, 'git stash → whole tree');
ok(scanBashMutation('git checkout main').tree === true, 'git checkout <branch> → whole tree (fail-safe)');
ok(scanBashMutation('git show HEAD:src/a > src/a').paths?.includes('src/a'), 'git show > f → redirect clobber');
ok(scanBashMutation('echo x > src/a').paths?.includes('src/a'), 'echo > f → clobber');
ok(!scanBashMutation('echo x >> src/a').mutates, 'echo >> f (append) → NOT a clobber');
ok(scanBashMutation('sed -i s/a/b/ src/a').paths?.includes('src/a'), 'sed -i → clobber');
ok(scanBashMutation('cp /t/x src/a').paths?.includes('src/a'), 'cp → dest clobber');
ok(scanBashMutation('sh -c "git checkout -- src/a"').paths?.includes('src/a'), 'sh -c hides nothing');
// Round-2: the in-place editors round-1 MISSED (sed -i was covered; these were not).
ok(scanBashMutation("perl -i -pe 's/a/b/' src/a").paths?.includes('src/a'), 'perl -i → clobber (round-2 gap)');
ok(scanBashMutation("perl -i.bak -pe 's/a/b/' src/a").paths?.includes('src/a'), 'perl -i.bak → clobber');
ok(scanBashMutation("perl -pi -e 's/a/b/' src/a").paths?.includes('src/a'), 'perl -pi -e → clobber (clustered flags)');
ok(!scanBashMutation("perl -pe 's/a/b/' src/a").mutates, 'perl WITHOUT -i writes stdout → NOT a clobber');
ok(scanBashMutation('patch src/a < d.diff').paths?.includes('src/a'), 'patch FILE < diff → that file (round-2 gap)');
ok(scanBashMutation('patch -p1 < d.diff').tree === true, 'patch with no file (targets from diff) → whole tree (fail-safe)');
ok(scanBashMutation("ex -s -c 'wq' src/a").paths?.includes('src/a'), 'ex -c wq → clobber (round-2 gap)');
ok(!scanBashMutation("ex -s -c 'q' src/a").mutates, 'ex -c q (read-only) → NOT a clobber');
// Round-2: effective-cwd — `cd sub && <mutate> f` must key sub/f, not f.
ok(scanBashMutation('cd sub && sed -i s/a/b/ f').paths?.includes('sub/f'), 'cd sub && sed -i f → keys sub/f (round-2 gap #b)');
ok(scanBashMutation('cd sub && echo x > f').paths?.includes('sub/f'), 'cd sub && echo > f → keys sub/f');
// Round-2: python -c is the documented non-shell blind spot (shared with git-write block).
ok(!scanBashMutation("python3 -c \"open('f','w').write('')\"").mutates, 'python -c is NOT seen (documented residual, not a regression)');
ok(!scanBashMutation('git worktree add ../wt').mutates, 'git worktree add does not touch tracked files → not a mutation');
for (const neg of ['ls -la', 'npm test', 'git status', 'git diff HEAD', 'cat src/a', 'grep x src/a', 'git log']) {
  ok(!scanBashMutation(neg).mutates, `negative: \`${neg}\` is not a mutation (no false contention)`);
}

/* ─────────────────────── 1b. path-key: symlink + cd resolve to ONE key (round-2 gaps) */
section('1b. path-key normalisation (symlink + cd) — round-2');
{
  const repo = makeRepo('repo-key');
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  write(path.join(repo, 'real.ts'), 'x');
  try { fs.symlinkSync(path.join(repo, 'real.ts'), path.join(repo, 'ln.ts')); } catch {}
  ok(lockKeyFor(path.join(repo, 'real.ts'), repo) === lockKeyFor(path.join(repo, 'ln.ts'), repo),
    'a symlink and its target resolve to the SAME key (gap #a — both cannot own it separately)');
  // The cd-resolved bash path and a direct write to sub/f must key identically.
  const viaCd = scanBashMutation('cd sub && sed -i s/a/b/ f').paths[0];
  ok(lockKeyFor(viaCd, repo) === lockKeyFor(path.join(repo, 'sub', 'f'), repo),
    'cd sub && sed f keys the same as a Write to sub/f (gap #b)');
}

/* ─────────────────────────── 2. THE REAL CLOBBER, must-FAIL → must-PASS */
section('2. real clobber on a scratch git repo — must-FAIL (hatch) then must-PASS (lock)');
{
  const repo = makeRepo('repo-clobber');
  const file = path.join(repo, 'shared.ts');
  write(file, 'committed\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');

  const lockDir = path.join(SCRATCH, 'locks-clobber');
  const A = 'session-A', B = 'session-B';

  // Lane A makes an UNCOMMITTED edit and (as its Edit/Write would) claims the lock.
  write(file, 'A-uncommitted-work\n');
  const claimA = evaluateFileLock({ toolName: 'Write', toolInput: { file_path: file }, lockDir, repoRoot: repo, owner: A });
  ok(claimA.allow, 'lane A claims shared.ts (its own write is allowed)');

  // --- must-FAIL: hatch open = pre-change behaviour. B's checkout is allowed → run it → A's work is lost.
  const claimB_hatch = evaluateFileLock({
    toolName: 'Bash', toolInput: { command: 'git checkout -- shared.ts' },
    lockDir, repoRoot: repo, owner: B, env: { ORCHARD_ALLOW_FILE_CLOBBER: '1' },
  });
  ok(claimB_hatch.allow, 'PRE (hatch open): B\'s git checkout is ALLOWED (no protection)');
  git(repo, 'checkout', '--', 'shared.ts'); // the actual clobbering command
  ok(read(file) === 'committed\n', 'PRE: A\'s uncommitted work was CLOBBERED (bug reproduced)');

  // Restore A's work + re-claim (fresh state for the post test).
  write(file, 'A-uncommitted-work\n');
  evaluateFileLock({ toolName: 'Write', toolInput: { file_path: file }, lockDir, repoRoot: repo, owner: A });

  // --- must-PASS: lock ON. B's checkout is DENIED as busy; a good-citizen B does not run it; A survives.
  const claimB = evaluateFileLock({
    toolName: 'Bash', toolInput: { command: 'git checkout -- shared.ts' },
    lockDir, repoRoot: repo, owner: B,
  });
  ok(!claimB.allow && claimB.busy, 'POST: B\'s git checkout is DENIED (busy)');
  ok(claimB.holder?.owner === A, 'POST: the busy signal names the holder (lane A) — "file locked by lane X"');
  ok(/locked by/i.test(claimB.reason || ''), 'POST: refusal text is the fail-loud file-busy message');
  // B respects the deny (does NOT run checkout). A's work stands.
  ok(read(file) === 'A-uncommitted-work\n', 'POST: A\'s uncommitted work SURVIVES');

  // Whole-file Write by B is denied the same way.
  const writeB = evaluateFileLock({ toolName: 'Write', toolInput: { file_path: file }, lockDir, repoRoot: repo, owner: B });
  ok(!writeB.allow && writeB.busy && writeB.holder?.owner === A, 'POST: B\'s whole-file Write also denied (busy, names A)');

  // A whole-TREE op (git reset --hard) by B is denied because A holds a file in the tree.
  const treeB = evaluateFileLock({ toolName: 'Bash', toolInput: { command: 'git reset --hard' }, lockDir, repoRoot: repo, owner: B });
  ok(!treeB.allow && treeB.tree && treeB.holder?.owner === A, 'POST: B\'s `git reset --hard` denied (would wipe A\'s locked file)');
}

/* ─────────────────────────────────────── 3. stale/dead-owner reaper — no wedge */
section('3. stale-lock reaper (dead owner + TTL) — releases, never wedges');
{
  const lockDir = path.join(SCRATCH, 'locks-reap');
  const repo = makeRepo('repo-reap');
  const file = path.join(repo, 'x.ts');

  // (a) dead owner: forge a lock owned by a provably-dead pid on THIS host.
  fs.mkdirSync(lockDir, { recursive: true });
  const key = lockKeyFor(file, repo);
  const { createHash } = await import('node:crypto');
  const lf = path.join(lockDir, createHash('sha1').update(key).digest('hex') + '.lock');
  const deadPid = 2 ** 22; // almost-certainly-not-a-live-pid
  write(lf, JSON.stringify({ owner: 'dead-lane', ownerPid: deadPid, host: os.hostname(), key, acquiredAt: Date.now(), refreshedAt: Date.now() }));
  ok(reclaimReason({ owner: 'dead-lane', ownerPid: deadPid, host: os.hostname(), refreshedAt: Date.now() }, Date.now()) !== null, 'dead-owner lock is reclaimable immediately (ground truth first)');
  const afterDead = evaluateFileLock({ toolName: 'Write', toolInput: { file_path: file }, lockDir, repoRoot: repo, owner: 'live-lane' });
  ok(afterDead.allow, 'a later writer RECLAIMS a dead lane\'s lock and succeeds (no wedge)');

  // (b) TTL backstop: a live-pid owner but a stale timestamp → reclaimable by TTL.
  write(lf, JSON.stringify({ owner: 'stuck-lane', ownerPid: process.pid, host: os.hostname(), key, acquiredAt: Date.now() - FILE_LOCK_TTL_MS * 3, refreshedAt: Date.now() - FILE_LOCK_TTL_MS * 3 }));
  ok(reclaimReason({ owner: 'stuck-lane', ownerPid: process.pid, host: os.hostname(), refreshedAt: Date.now() - FILE_LOCK_TTL_MS * 3 }, Date.now()) !== null, 'a stale-past-TTL lock is reclaimable even with a live pid (TTL backstop, no wedge)');
  const afterStale = evaluateFileLock({ toolName: 'Write', toolInput: { file_path: file }, lockDir, repoRoot: repo, owner: 'new-lane' });
  ok(afterStale.allow, 'a later writer reclaims a stale lock and succeeds');

  // (c) a FRESH live-owner lock is NOT reclaimable (the thing that must hold).
  ok(reclaimReason({ owner: 'busy', ownerPid: process.pid, host: os.hostname(), refreshedAt: Date.now() }, Date.now()) === null, 'a fresh, live-owner lock STANDS (not falsely reaped)');
}

/* ─── 3b. THE ROUND-1 CLOBBER: a live lane in ONE long tool call — must-FAIL → PASS */
section('3b. live-lane-in-a-long-call — the heartbeat keeps a live lock off the TTL (round-2 core)');
{
  const lockDir = path.join(SCRATCH, 'locks-heartbeat');
  const repo = makeRepo('repo-heartbeat');
  const file = path.join(repo, 'x.ts');
  write(file, 'A-uncommitted-work\n');
  const HB = heartbeatIntervalMs();
  const T0 = 1_000_000;
  const laterB = T0 + FILE_LOCK_TTL_MS + 1; // past the old TTL, mid one long tool call

  // A claims x.ts, then runs ONE >TTL tool call and makes NO further mutating calls.
  evaluateFileLock({ toolName: 'Write', toolInput: { file_path: file }, lockDir, repoRoot: repo, owner: 'sessX:laneA', now: T0 });

  // --- must-FAIL (round-1 shape): WITHOUT a heartbeat, B's write after the TTL is ALLOWED = clobber.
  {
    const lockDirNoHB = path.join(SCRATCH, 'locks-noheartbeat');
    evaluateFileLock({ toolName: 'Write', toolInput: { file_path: file }, lockDir: lockDirNoHB, repoRoot: repo, owner: 'sessX:laneA', now: T0 });
    const bNoHB = evaluateFileLock({ toolName: 'Write', toolInput: { file_path: file }, lockDir: lockDirNoHB, repoRoot: repo, owner: 'sessY:laneB', now: laterB });
    ok(bNoHB.allow, 'CONTROL (no heartbeat): B\'s write after the TTL is ALLOWED — the round-1 clobber, reproduced');
  }

  // --- must-PASS: the heartbeat fires across the long call (laneA still in the running-set).
  let last = T0;
  for (let t = T0 + HB; t <= laterB + HB; t += HB) {
    refreshOwnedLocks({ lockDir, isOwnerLive: (o) => o === 'sessX:laneA', now: t }); // ground truth: laneA is live
    last = t;
  }
  const bWithHB = evaluateFileLock({ toolName: 'Write', toolInput: { file_path: file }, lockDir, repoRoot: repo, owner: 'sessY:laneB', now: laterB });
  ok(!bWithHB.allow && bWithHB.busy && bWithHB.holder?.owner === 'sessX:laneA',
    'POST: B\'s write is DENIED (busy, names laneA) — a live lane in a long call is NOT clobbered');
  ok(read(file) === 'A-uncommitted-work\n', 'POST: A\'s uncommitted work SURVIVES on disk');
  const held = JSON.parse(read(fs.readdirSync(lockDir).map((f) => path.join(lockDir, f)).find((f) => f.endsWith('.lock'))));
  ok(held.refreshedAt >= last && held.refreshedAt > T0,
    'liveness came from the heartbeat (refreshedAt advanced well past the claim time), NOT the clock');

  // Dead/finished owner: laneA leaves the running-set → the heartbeat RELEASES its lock now.
  const res = refreshOwnedLocks({ lockDir, isOwnerLive: () => false, now: last + HB });
  ok(res.released === 1, 'when the lane leaves the running-set the heartbeat RELEASES its lock (ground truth, not TTL)');
  const laneNew = evaluateFileLock({ toolName: 'Write', toolInput: { file_path: file }, lockDir, repoRoot: repo, owner: 'sessZ:laneNew', now: last + HB + 1 });
  ok(laneNew.allow, 'a later lane on the SAME file succeeds after the finished lane released (no wedge)');

  // The heartbeat only touches THIS process's locks — a foreign session's is left to its own heartbeat.
  const foreignLockDir = path.join(SCRATCH, 'locks-foreign');
  fs.mkdirSync(foreignLockDir, { recursive: true });
  const { createHash: ch } = await import('node:crypto');
  const fk = lockKeyFor(path.join(repo, 'z.ts'), repo);
  const flf = path.join(foreignLockDir, ch('sha1').update(fk).digest('hex') + '.lock');
  write(flf, JSON.stringify({ owner: 'sessOther:laneF', ownerPid: 999999, host: 'some-other-host', key: fk, acquiredAt: T0, refreshedAt: T0 }));
  const r2 = refreshOwnedLocks({ lockDir: foreignLockDir, isOwnerLive: () => false, now: T0 + HB });
  ok(r2.released === 0 && r2.refreshed === 0 && fs.existsSync(flf),
    'a FOREIGN session\'s lock (different pid/host) is left untouched by our heartbeat');

  /*
   * 3b. THE SHARED-PID DEFECT (filed on FEAT-129, fixed 2026-09-10).
   * Every session on this host runs inside ONE Orchard server process, so
   * `ownerPid` is byte-identical on every lock and the pid filter above does
   * NOT exclude a foreign session. The old `isOwnerLive` answered `true` on its
   * "not ours to judge" branch, so a live session re-stamped a DEAD session's
   * lock forever: `refreshedAt` never aged and the TTL backstop never fired.
   *
   * The must-FAIL baseline is SYNTHESIZED (old closure semantics = `true` for a
   * foreign owner), never read from HEAD — so it stays a real proof after this
   * fix is committed.
   */
  const sharedPid = process.pid, thisHost = os.hostname();
  const deadOwnerLock = (dir, name) => {
    fs.mkdirSync(dir, { recursive: true });
    const k = lockKeyFor(path.join(repo, name), repo);
    const p = path.join(dir, ch('sha1').update(k).digest('hex') + '.lock');
    // A DEAD foreign session's lock, already older than the TTL, same pid+host.
    write(p, JSON.stringify({ owner: 'sessDEAD:laneGone', ownerPid: sharedPid, host: thisHost, kind: 'edit', key: k, acquiredAt: T0, refreshedAt: T0 }));
    return p;
  };
  const farFuture = T0 + FILE_LOCK_TTL_MS * 4;

  // --- must-FAIL (pre-fix shape): "not ours to judge" answered `true`.
  {
    const dir = path.join(SCRATCH, 'locks-sharedpid-prefix');
    const lf = deadOwnerLock(dir, 'imm-old.ts');
    const preFixIsOwnerLive = (owner) => (owner.startsWith('sessLIVE:') ? true : true); // the old branch: foreign → true
    const r = refreshOwnedLocks({ lockDir: dir, isOwnerLive: preFixIsOwnerLive, now: farFuture });
    const after = JSON.parse(read(lf));
    ok(r.refreshed === 1 && after.refreshedAt === farFuture,
      'CONTROL (pre-fix): a live session\'s heartbeat re-stamps a DEAD session\'s lock — refreshedAt is manufactured');
    ok(reclaimReason(after, farFuture + 1) === null,
      'CONTROL (pre-fix): the freshly-stamped dead lock is NOT reclaimable — immortal, the measured jam');
  }

  // --- must-PASS: `null` ("not ours to judge") is neither live nor dead.
  {
    const dir = path.join(SCRATCH, 'locks-sharedpid-fixed');
    const lf = deadOwnerLock(dir, 'imm-new.ts');
    const fixedIsOwnerLive = (owner) => (owner.startsWith('sessLIVE:') ? true : null); // the shipped branch: foreign → null
    const r = refreshOwnedLocks({ lockDir: dir, isOwnerLive: fixedIsOwnerLive, now: farFuture });
    const after = JSON.parse(read(lf));
    ok(r.refreshed === 0 && r.unjudged === 1, 'POST: a foreign session\'s lock is counted unjudged, never refreshed');
    ok(after.refreshedAt === T0, 'POST: refreshedAt is NOT manufactured — the lock ages honestly');
    ok(r.released === 0 && fs.existsSync(lf), 'POST: it is also NOT released — we never clobber a lock we cannot prove dead');
    ok(/stale/.test(reclaimReason(after, farFuture) ?? ''), 'POST: the TTL backstop can now free it — dead sessions\' locks are mortal again');
  }

  // A live foreign session is unharmed: its OWN heartbeat matches its own prefix.
  {
    const dir = path.join(SCRATCH, 'locks-sharedpid-liveforeign');
    const lf = deadOwnerLock(dir, 'imm-live.ts');
    const asItsOwnSession = (owner) => (owner.startsWith('sessDEAD:') ? true : null); // that session judging ITSELF
    const r = refreshOwnedLocks({ lockDir: dir, isOwnerLive: asItsOwnSession, now: farFuture });
    ok(r.refreshed === 1 && JSON.parse(read(lf)).refreshedAt === farFuture,
      'a LIVE session still refreshes its own locks under the shared pid (the fix costs nothing to live lanes)');
  }
}

/* ───────────────────────────────────────── 4. single-lane unaffected */
section('4. single-lane common case — no false busy');
{
  const lockDir = path.join(SCRATCH, 'locks-solo');
  const repo = makeRepo('repo-solo');
  const A = 'solo';
  const f1 = path.join(repo, 'a.ts'), f2 = path.join(repo, 'b.ts');
  ok(evaluateFileLock({ toolName: 'Write', toolInput: { file_path: f1 }, lockDir, repoRoot: repo, owner: A }).allow, 'solo lane writes a.ts');
  ok(evaluateFileLock({ toolName: 'Write', toolInput: { file_path: f2 }, lockDir, repoRoot: repo, owner: A }).allow, 'solo lane writes b.ts');
  ok(evaluateFileLock({ toolName: 'Edit', toolInput: { file_path: f1 }, lockDir, repoRoot: repo, owner: A }).allow, 'solo lane re-edits a.ts (own lock refreshes, never busy)');
  ok(evaluateFileLock({ toolName: 'Bash', toolInput: { command: 'npm test' }, lockDir, repoRoot: repo, owner: A }).allow, 'solo lane runs `npm test` (not a mutation)');
  ok(evaluateFileLock({ toolName: 'Bash', toolInput: { command: 'git reset --hard' }, lockDir, repoRoot: repo, owner: A }).allow, 'solo lane\'s own `git reset --hard` is allowed (only its own locks in the tree)');
}

/* ───────────────────────────────────────── 5. cross-session coordination */
section('5. two sessions on one project');
{
  const lockDir = path.join(SCRATCH, 'locks-xsession');
  const repo = makeRepo('repo-xsession');
  const S1 = 'session-1', S2 = 'session-2';
  const same = path.join(repo, 'contended.ts');
  const other = path.join(repo, 'independent.ts');
  ok(evaluateFileLock({ toolName: 'Write', toolInput: { file_path: same }, lockDir, repoRoot: repo, owner: S1 }).allow, 'session-1 claims contended.ts');
  const s2busy = evaluateFileLock({ toolName: 'Write', toolInput: { file_path: same }, lockDir, repoRoot: repo, owner: S2 });
  ok(!s2busy.allow && s2busy.holder?.owner === S1, 'session-2\'s write to the SAME file is coordinated (busy, names session-1)');
  ok(evaluateFileLock({ toolName: 'Write', toolInput: { file_path: other }, lockDir, repoRoot: repo, owner: S2 }).allow, 'session-2 writing a DIFFERENT file is unaffected (no false contention)');
  // lane-within-session identity: session-1 lane vs session-1 main are distinct owners too.
  const laneOwner = `${S1}:agent-xyz`;
  const laneBusy = evaluateFileLock({ toolName: 'Write', toolInput: { file_path: same }, lockDir, repoRoot: repo, owner: laneOwner });
  ok(!laneBusy.allow, 'a different lane of session-1 also gets busy on the held file (per-lane owner)');
}

/* ───────────────────────────────────────── 6. reclaim race — real concurrent processes */
section('6. race safety — N concurrent processes on one path (a race is a timing)');
{
  const lockDir = path.join(SCRATCH, 'locks-race');
  const repo = makeRepo('repo-race');
  const file = path.join(repo, 'hot.ts');
  const worker = path.join(SCRATCH, 'race-worker.mjs');
  write(worker, `
import { evaluateFileLock } from ${JSON.stringify(path.join(REPO_ROOT, 'scripts/lib/file-lock.mjs'))};
const [lockDir, repo, file, owner] = process.argv.slice(2);
const r = evaluateFileLock({ toolName: 'Write', toolInput: { file_path: file }, lockDir, repoRoot: repo, owner });
process.send({ owner, allow: !!r.allow, holder: r.holder?.owner ?? null });
// STAY ALIVE past the whole contention window, like a real lane holding its lock:
// if a claimer exited immediately its dead pid would (correctly) be reclaimable,
// which is a liveness property, not the exclusion property under test here.
setTimeout(() => process.exit(0), 1500);
`);
  const N = 12;
  const results = await Promise.all(Array.from({ length: N }, (_, k) => new Promise((res) => {
    const child = fork(worker, [lockDir, repo, file, `racer-${k}`], { stdio: 'ignore' });
    let msg = null;
    child.on('message', (m) => { msg = m; });
    child.on('exit', () => res(msg ?? { owner: `racer-${k}`, allow: false, crashed: true }));
  })));
  const winners = results.filter((r) => r.allow);
  ok(winners.length === 1, `exactly ONE of ${N} concurrent processes wins the free path (got ${winners.length})`);
  // every loser must be busy naming the SAME single winner (no split-brain ownership).
  const losers = results.filter((r) => !r.allow);
  const holders = new Set(losers.map((r) => r.holder).filter(Boolean));
  ok(losers.every((r) => r.holder === winners[0]?.owner) && holders.size <= 1,
    'every loser is busy against the ONE winner (no two processes both believe they own it)');
}

/* ───────────────────────────────────────── 7. wiring pin */
section('7. shipped wiring — the runtime hook calls the same module');
{
  const src = read(path.join(REPO_ROOT, 'src/server/runtime/claude-runtime.ts'));
  ok(/from '\.\.\/\.\.\/\.\.\/scripts\/lib\/file-lock\.mjs'/.test(src), 'claude-runtime imports the real file-lock.mjs (no re-implementation)');
  ok(/evaluateFileLock\(\{/.test(src), 'the PreToolUse hook calls evaluateFileLock');
  ok(/permissionDecision: 'deny' as const/.test(src) && /lock\.reason/.test(src), 'a busy result denies the tool call with the busy reason');
  ok(/fileLockEnabled\(\)/.test(src), 'the launch-time hatch is consulted');
  ok(/i\.agent_id \? `\$\{fileLockSessionOwner\}:\$\{i\.agent_id\}`/.test(src), 'owner folds the per-lane agent_id onto the session id');
  ok(/file-locks/.test(src), 'the lock dir lives under the data dir (not the git tree)');
  // The shared-pid fix is only real if the SHIPPED closure returns the third rung.
  ok(/isOwnerLive = \(owner: string\): boolean \| null =>/.test(src),
    'the shipped isOwnerLive declares the three-way verdict (boolean | null)');
  ok(/if \(!owner\.startsWith\(ownerPrefix\)\) return null;/.test(src),
    'the shipped isOwnerLive returns NULL for a foreign session — not `true` (the shared-pid defect)');
}

/* ───────────────────────────────────────── 8. hatch */
section('8. escape hatch');
ok(fileLockEnabled({}) === true, 'lock ON by default');
ok(fileLockEnabled({ ORCHARD_ALLOW_FILE_CLOBBER: '1' }) === false, 'hatch disables the lock');
ok(evaluateFileLock({ toolName: 'Write', toolInput: { file_path: '/x' }, lockDir: '/tmp/nope', owner: 'a', env: { ORCHARD_ALLOW_FILE_CLOBBER: '1' } }).allow, 'hatch open → every mutation allowed');

/* ─────────── 9. ROUND 4 — the 10-11 independent verify's five clobbers (run 34d17925) */
section('9. round 4 — heredoc / sed --in-place= / subshell / git -C: must-FAIL (synthesized pre-fix key) → PASS');
{
  /*
   * Each case: lane A holds an uncommitted edit on the target. The PRE-FIX
   * classification is SYNTHESIZED as a fixed literal (CONVENTIONS: never anchor a
   * must-FAIL to HEAD) — exactly what the round-3 scanner produced, read off the
   * verify's findings: no mutation at all, or a key that is not the real file.
   * CONTROL: claiming under that pre-fix shape does NOT protect A, and running
   * the REAL command in a real shell clobbers A's bytes on disk. POST: the
   * shipped decision DENIES it (busy, names A), the command is not run, A survives.
   */
  const repo = makeRepo('repo-r4');
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  const lockDir = path.join(SCRATCH, 'locks-r4');
  const A = 'session-A', B = 'session-B';
  const cases = [
    { name: "heredoc then redirect: cat <<'EOF' > f", file: 'f.txt', cmd: "cat <<'EOF' > f.txt\nB-OVERWRITE\nEOF", pre: null },
    { name: 'heredoc piped to tee: cat <<EOF | tee f', file: 'g.txt', cmd: 'cat <<EOF | tee g.txt >/dev/null\nB-OVERWRITE\nEOF', pre: null },
    { name: 'sed --in-place=.bak (long form with suffix)', file: 'h.txt', cmd: 'sed --in-place=.bak s/A-work/B-OVERWRITE/ h.txt', pre: null },
    { name: 'subshell (cd sub && sed -i …)', file: 'sub/s.txt', cmd: '(cd sub && sed -i s/A-work/B-OVERWRITE/ s.txt)', pre: 's.txt)' },
    { name: 'git -C sub checkout -- f', file: 'sub/c.txt', cmd: 'git -C sub checkout -- c.txt', pre: 'c.txt', committed: true },
  ];
  for (const c of cases) {
    const abs = path.join(repo, c.file);
    write(abs, c.committed ? 'committed\n' : 'A-work\n');
    if (c.committed) { git(repo, 'add', '.'); git(repo, 'commit', '-qm', `base ${c.file}`); }
    const arm = () => { write(abs, 'A-work\n'); return evaluateFileLock({ toolName: 'Write', toolInput: { file_path: abs }, lockDir, repoRoot: repo, owner: A }); };
    ok(arm().allow, `[${c.name}] lane A claims ${c.file}`);
    // CONTROL (synthesized pre-fix): no mutation → nothing claimed; else the wrong literal key is claimed.
    const preAllow = c.pre == null ? true
      : evaluateFileLock({ toolName: 'Write', toolInput: { file_path: c.pre }, lockDir, repoRoot: repo, owner: B }).allow;
    ok(preAllow, `[${c.name}] CONTROL: the pre-fix classification (${c.pre == null ? 'no mutation' : `key \`${c.pre}\``}) does NOT protect A`);
    execFileSync('bash', ['-c', c.cmd], { cwd: repo });
    ok(!read(abs).includes('A-work'), `[${c.name}] CONTROL: the real command CLOBBERS A's uncommitted bytes (bug reproduced on disk)`);
    try { fs.rmSync(`${abs}.bak`, { force: true }); } catch {}
    // POST: the shipped decision.
    arm();
    const post = evaluateFileLock({ toolName: 'Bash', toolInput: { command: c.cmd }, lockDir, repoRoot: repo, owner: B });
    ok(!post.allow && post.busy && post.holder?.owner === A, `[${c.name}] POST: DENIED, busy, names lane A`);
    if (post.allow) execFileSync('bash', ['-c', c.cmd], { cwd: repo });
    ok(read(abs) === 'A-work\n', `[${c.name}] POST: A's uncommitted work SURVIVES`);
  }
  // Non-regression: the shapes the fixes touch must not invent mutations.
  ok(!scanBashMutation("git commit -m \"$(cat <<'EOF'\nfix: it's done > not-a-file\nEOF\n)\"").mutates,
    'heredoc body is still DATA: the commit-message idiom (body contains `>`) is not a mutation');
  ok(!scanBashMutation('cat <<EOF\nhello > x\nEOF').mutates, 'a heredoc with no redirect on its opening line is not a mutation');
  ok(scanBashMutation('bash <<EOF\nsed -i s/a/b/ sub/z\nEOF').paths?.includes('sub/z'), 'a heredoc FED TO A SHELL is code: its sed -i is seen');
  ok(JSON.stringify(scanBashMutation('(cd sub; echo > a) > b').paths) === JSON.stringify(['sub/a', 'b']),
    'subshell cwd is scoped: `cd` inside ( ) does not leak past `)`');
  ok(!scanBashMutation('sed -n s/a/b/p f').mutates && !scanBashMutation('sed s/a/b/ f > /dev/null').mutates, 'sed without in-place is still not a mutation');
  ok(JSON.stringify(scanBashMutation('sed -i -e s/a/b/ -e s/c/d/ f').paths) === JSON.stringify(['f']), 'sed -e scripts are not mistaken for files');
  ok(scanBashMutation('git -C a -C b restore x').paths?.[0] === 'a/b/x', 'successive git -C dirs compose (a/b/x)');
}

/* ──────── 9b. ROUND 4 — paths built from shell variables: resolve, else a conservative scope */
section('9b. round 4 — variable-path targets: never a literal key, never a silent skip');
{
  const repo = makeRepo('repo-r4-var');
  fs.mkdirSync(path.join(repo, 'src/seed/content/en'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src/other'), { recursive: true });
  const lockDir = path.join(SCRATCH, 'locks-r4-var');
  const A = 'session-A', B = 'session-B';
  const held = path.join(repo, 'src/seed/content/en/home.ts');
  write(held, 'A-work\n');
  ok(evaluateFileLock({ toolName: 'Write', toolInput: { file_path: held }, lockDir, repoRoot: repo, owner: A }).allow, 'lane A holds src/seed/content/en/home.ts');

  const loop = 'for f in home about; do echo B > src/seed/content/en/$f.ts; done';
  // CONTROL (synthesized pre-fix): the target was locked under its LITERAL text.
  ok(evaluateFileLock({ toolName: 'Write', toolInput: { file_path: path.join(repo, 'src/seed/content/en/$f.ts') }, lockDir, repoRoot: repo, owner: 'pre-fix-literal' }).allow,
    'CONTROL: the pre-fix literal key `src/seed/content/en/$f.ts` collides with nothing (the illusion of protection)');
  // Drop the control's literal-key lock so it cannot leak into the POST checks below.
  for (const lf of fs.readdirSync(lockDir)) { try { if (JSON.parse(read(path.join(lockDir, lf))).owner === 'pre-fix-literal') fs.unlinkSync(path.join(lockDir, lf)); } catch {} }
  execFileSync('bash', ['-c', loop], { cwd: repo });
  ok(read(held) === 'B\n', 'CONTROL: the real loop CLOBBERS A\'s file on disk');
  write(held, 'A-work\n');
  // POST 1 — resolvable: the for-list pins $f, so the EXACT files are claimed.
  ok(JSON.stringify(scanBashMutation(loop).paths) === JSON.stringify(['src/seed/content/en/home.ts', 'src/seed/content/en/about.ts']),
    'a `for f in …` list resolves $f → the exact target paths');
  const pLoop = evaluateFileLock({ toolName: 'Bash', toolInput: { command: loop }, lockDir, repoRoot: repo, owner: B });
  ok(!pLoop.allow && pLoop.holder?.owner === A, 'POST: the resolved loop is DENIED on the real key (names A)');
  ok(read(held) === 'A-work\n', 'POST: A\'s work survives');
  ok(evaluateFileLock({ toolName: 'Bash', toolInput: { command: 'D=src/seed/content/en; echo B > $D/home.ts' }, lockDir, repoRoot: repo, owner: B }).allow === false,
    'an in-command assignment (D=…; > $D/home.ts) resolves to the real key → DENIED');
  ok(evaluateFileLock({ toolName: 'Bash', toolInput: { command: 'echo B > src/seed/content/en/{home,x}.ts' }, lockDir, repoRoot: repo, owner: B }).allow === false,
    'a brace list resolves to the real key → DENIED');

  // POST 2 — unresolvable: a conservative check on the static directory prefix.
  const unres = 'echo B > src/seed/content/en/$NAME.ts';
  const cls = scanBashMutation(unres);
  ok(cls.mutates && !cls.paths.length && cls.scopes?.[0]?.dir === 'src/seed/content/en', 'an unassigned $NAME is NOT given a literal key: it becomes a scope on its static dir');
  const pScope = evaluateFileLock({ toolName: 'Bash', toolInput: { command: unres }, lockDir, repoRoot: repo, owner: B });
  ok(!pScope.allow && pScope.holder?.owner === A && pScope.scope === 'src/seed/content/en', 'POST: unresolvable target with a foreign lock in its dir → DENIED (scope named)');
  ok(/cannot be resolved/.test(pScope.reason || '') && /Spell the target/.test(pScope.reason || ''), 'the refusal says why and how to unblock (spell the path out)');
  ok(evaluateFileLock({ toolName: 'Bash', toolInput: { command: 'echo B > src/other/$NAME.ts' }, lockDir, repoRoot: repo, owner: B }).allow,
    'no false busy: an unresolvable target in a DIFFERENT dir (no foreign lock there) is allowed');
  const lead = evaluateFileLock({ toolName: 'Bash', toolInput: { command: 'echo B > "$1"' }, lockDir, repoRoot: repo, owner: B });
  ok(!lead.allow && lead.scope === '', 'a LEADING unresolved var could point anywhere → checked against the whole tree → DENIED while A holds a file');
  // Temp targets are outside the project: no lock, no false busy.
  ok(!scanBashMutation('S=$(mktemp -d); echo x > $S/out.txt').mutates, '$(mktemp -d) targets are outside the project → not a project mutation');
  ok(!scanBashMutation('echo x > "$TMPDIR/x"').mutates, '$TMPDIR targets are outside the project');
  ok(scanBashMutation('T=$(mktemp -p src/seed); echo x > $T').scopes?.[0]?.dir === 'src/seed', 'mktemp -p DIR lands under DIR → scoped there, not treated as outside');
  // Globs resolve against the disk.
  const gl = evaluateFileLock({ toolName: 'Bash', toolInput: { command: 'sed -i s/A/B/ src/seed/content/en/*.ts' }, lockDir, repoRoot: repo, owner: B });
  ok(!gl.allow && gl.holder?.owner === A, 'a glob target expands against the disk → the held match DENIES');
  // A solo lane is unaffected by its own scope.
  ok(evaluateFileLock({ toolName: 'Bash', toolInput: { command: unres }, lockDir, repoRoot: repo, owner: A }).allow, 'the holder itself is never blocked by its own lock in the scope');
}

/* ──────── 9c. ROUND 4 — container and host sessions of one project share one key namespace */
section('9c. round 4 — container (/workspace/<id>) vs host session on the same project');
{
  const repo = makeRepo('repo-r4-mode');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const lockDir = path.join(SCRATCH, 'locks-r4-mode'); // ONE dir per project id — same for both modes
  const WS = '/workspace/proj-123';
  const HOST = 'host-session', CTR = 'container-session';
  const f = path.join(repo, 'src/a.ts');
  write(f, 'host-work\n');
  ok(evaluateFileLock({ toolName: 'Write', toolInput: { file_path: f }, lockDir, repoRoot: repo, owner: HOST }).allow, 'host session holds src/a.ts');
  // CONTROL (synthesized pre-fix wiring: no alias) — the container path keys absolute, collides with nothing.
  ok(lockKeyFor(`${WS}/src/a.ts`, repo) !== lockKeyFor(f, repo), 'CONTROL: without the alias, /workspace/<id>/src/a.ts and the host path are TWO keys');
  ok(evaluateFileLock({ toolName: 'Write', toolInput: { file_path: `${WS}/src/a.ts` }, lockDir, repoRoot: repo, owner: CTR }).allow,
    'CONTROL: so the container session\'s Write is ALLOWED over the host session\'s held file (the cross-mode gap)');
  // POST — the shipped wiring declares the CLI-side repo path as an alias.
  ok(lockKeyFor(`${WS}/src/a.ts`, repo, [WS]) === 'src/a.ts', 'POST: with the alias the container path keys `src/a.ts`, the host key');
  const w = evaluateFileLock({ toolName: 'Write', toolInput: { file_path: `${WS}/src/a.ts` }, lockDir, repoRoot: repo, pathAliases: [WS], owner: CTR + '2' });
  ok(!w.allow && w.holder?.owner === HOST, 'POST: container Write to the host-held file is DENIED (names the host session)');
  const b = evaluateFileLock({ toolName: 'Bash', toolInput: { command: `cd ${WS} && sed -i s/a/b/ src/a.ts` }, lockDir, repoRoot: repo, pathAliases: [WS], owner: CTR + '3' });
  ok(!b.allow && b.holder?.owner === HOST, 'POST: container Bash `cd /workspace/<id> && sed -i` is DENIED too');
  // Reverse direction: container claims, host is refused.
  const g = path.join(repo, 'src/b.ts');
  ok(evaluateFileLock({ toolName: 'Write', toolInput: { file_path: `${WS}/src/b.ts` }, lockDir, repoRoot: repo, pathAliases: [WS], owner: CTR }).allow, 'container session holds src/b.ts (via /workspace path)');
  const h = evaluateFileLock({ toolName: 'Write', toolInput: { file_path: g }, lockDir, repoRoot: repo, owner: HOST });
  ok(!h.allow && h.holder?.owner === CTR, 'POST: host Write to the container-held file is DENIED (names the container session)');
  // Wiring pins: the bridge declares the alias and the runtime passes it.
  const rt = read(path.join(REPO_ROOT, 'src/server/runtime/claude-runtime.ts'));
  const br = read(path.join(REPO_ROOT, 'src/server/agent-bridge.ts'));
  ok(/pathAliases: config\.fileLockPathAliases \?\? \[\]/.test(rt), 'the shipped hook passes config.fileLockPathAliases to evaluateFileLock');
  ok(/fileLockPathAliases: this\.cwd && this\.cwd !== opts\.project\.hostPath \? \[this\.cwd\] : undefined/.test(br), 'the bridge declares the container cwd as the alias');
  ok(/path\.join\(dataDir\(\), 'file-locks', fileLockProjectKey/.test(rt) && /gitGrantKey: opts\.project\.id/.test(br), 'the lock DIR is keyed by project id for both modes (one namespace)');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
