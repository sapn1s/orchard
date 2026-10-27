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
  refreshOwnedLocks, heartbeatIntervalMs, isIndexOnlyApplyExempt, isSimpleLine,
} from './lib/file-lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

/* This suite DRIVES real git on throwaway scratch repos it creates (sections 2, 9,
 * 10, 11) — it never writes the real repo. In an agent session the FEAT-135 git-shim
 * sits first on PATH and refuses git writes, which would block the scratch `git init`.
 * Drop ONLY the shim dir so `git` resolves to the real binary; in the gate/CI (no
 * shim) this is a no-op. Scoped to this process; the parent PATH is untouched. */
if (process.env.PATH) {
  process.env.PATH = process.env.PATH.split(path.delimiter).filter((d) => !/orchard-git-shim/.test(d)).join(path.delimiter);
}
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };
const section = (s) => console.log(`\n== ${s}`);

const SCRATCH_PARENT = path.join(process.env.HOME || os.tmpdir(), 'scratch');
fs.mkdirSync(SCRATCH_PARENT, { recursive: true }); // self-sufficient: no external `mkdir $HOME/scratch` needed
const SCRATCH = fs.mkdtempSync(path.join(SCRATCH_PARENT, 'feat129-'));
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
ok(scanBashMutation('sh -c "git checkout -- src/a"').tree === true, 'sh -c wrapping a git mutator is a non-SIMPLE line → whole-tree (r9 over-refusal; was path-scoped — sh -c can hide a second mutator so it is never eligible for a narrow key)');
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

/* ──────── 10. BUG-277 — index-only `git apply --cached` exemption, as a WHOLE-STRING match
 *
 * The live jam (2026-10-25): `git apply --cached` writes ONLY the index, yet the
 * classifier put every `apply` in GIT_TREE_MUTATORS and gitMutationTarget returned
 * {tree:true} for it (no `--` pathspec) — so `evaluateFileLock`→`checkTree` refused the
 * sanctioned index-only landing whenever ANY foreign lane held ANY live lock, even
 * on an out-of-repo scratch file.
 *
 * r1 (DENYLIST over git-apply flags) and r2 (TOKEN ALLOWLIST + a GIT_* / global
 * option guard) both PARSED the command — both refuted, because the classifier cannot
 * model what the SHELL does before git runs. openai run 01a173bb… broke r1 on
 * `--cached --reject`/`--build-fake-ancestor`/`--no-cached`; anthropic run f02aa74c…
 * broke r2 on SHELL-EXPANSION forms (`$(echo --reject)`, `{--reject,p.diff}`, `$VAR`,
 * globs) and ENV set earlier on the line (`export GIT_WORK_TREE=…;`, `env GIT_DIR=…
 * git …`) — all tokenised to the exempt shape yet redirect/rewrite the real apply.
 *
 * r3 (this) STOPS parsing shell. The exemption fires ONLY when the WHOLE Bash command
 * string, trimmed, matches EXACTLY `git apply --cached <plain-path>…` — no leading `-`
 * on any token, NO shell metacharacter anywhere, no second command. Everything else
 * falls back to today's tree classification (fail-safe: the tree check denies only
 * when a lock is actually held). Over-refusal is acceptable and expected.
 *
 * Each `refused(...)` below is a must-FAIL synthesized from the r2 code: 21 of these
 * attacks classified EXEMPT under r2 (probed live, r2 vs r3). `exempt(...)` fires on
 * exactly one shape — the confirmed real landing form. */
section('10. BUG-277 r3–r9 — index-only apply exemption + wrapper-hole/compound-line whole-tree net (SIMPLE-line rule)');
{
  const APPLY = 'git' + ' apply'; // keep the literal out of any command-scanner's eye; this is a classifier arg, never run
  // exempt = the lock never fires (mutates:false), via the REAL entry classifyMutation.
  const cls = (c) => classifyMutation({ toolName: 'Bash', toolInput: { command: c } });
  const exempt = (c) => cls(c).mutates === false;
  const refused = (c) => cls(c).mutates === true; // not exempt → subject to the lock (tree or path)

  // EXEMPT — exactly the confirmed real landing form: `git apply --cached <plain path>…`.
  ok(exempt(`${APPLY} --cached scripts/git-write-policy.mjs.patch`), 'the live landing shape `apply --cached <repo-rel path>` → EXEMPT (the live jam, now allowed)');
  ok(exempt(`${APPLY} --cached a.patch b.patch c.patch`), '`apply --cached` with several plain patch paths → EXEMPT');
  ok(exempt(`${APPLY} --cached /var/lib/station/scratch/landing/r1/bug240.patch`), 'the exact ABSOLUTE-path landing form (tilde already expanded) → EXEMPT');
  // Predicate directly: trim strips a trailing newline; an EMBEDDED newline does not match.
  ok(isIndexOnlyApplyExempt(`${APPLY} --cached a.patch\n`), 'predicate: a trailing newline is trimmed → still EXEMPT');
  ok(!isIndexOnlyApplyExempt(`${APPLY} --cached a.patch\nrm x`), 'predicate: an embedded newline (2nd command) → NOT exempt');
  ok(!isIndexOnlyApplyExempt(`${APPLY} --cached`), 'predicate: `apply --cached` with NO path → not the exempt shape');

  // REFUSED — every r1/r2 flag break (an extra option beside --cached that writes the tree).
  ok(refused(`${APPLY} --cached --reject p.diff`), 'r1-break: `--cached --reject` writes .rej → REFUSED');
  ok(refused(`${APPLY} --cached --build-fake-ancestor=f p.diff`), 'r1-break: `--cached --build-fake-ancestor=<f>` writes <f> → REFUSED');
  ok(refused(`${APPLY} --cached --no-cached p.diff`), 'r1-break: `--cached --no-cached` cancels --cached → REFUSED');
  ok(refused(`${APPLY} --cached --index p.diff`), '`--cached --index` writes the tree → REFUSED');
  ok(refused(`${APPLY} --cached --3way p.diff`), '`--cached --3way` carries an extra option → REFUSED');
  ok(refused(`${APPLY} --cache p.diff`), '`--cache` abbreviation is NOT literal `--cached` → REFUSED');
  ok(refused(`${APPLY} --cached=1 p.diff`), '`--cached=1` is not the bare flag → REFUSED');
  ok(refused(`${APPLY} -Rp1 --cached p.diff`), 'a combined short-flag cluster beside --cached → REFUSED');

  // REFUSED — r2 breaks: git GLOBAL options & GIT_*/env prefixes (r2 tokenised these to exempt).
  ok(refused(`git -c foo=bar apply --cached p.diff`), 'r2-break: a `-c` git global option → REFUSED');
  ok(refused(`git -C /x apply --cached p.diff`), 'r2-break: a `-C <dir>` git global option → REFUSED');
  ok(refused(`git --git-dir=/x/.git apply --cached p.diff`), 'r2-break: `--git-dir` git global option → REFUSED');
  ok(refused(`git --work-tree=/x apply --cached p.diff`), 'r2-break: `--work-tree` git global option → REFUSED');
  ok(refused(`GIT_WORK_TREE=/x ${APPLY} --cached p.diff`), 'r2-break: a `GIT_WORK_TREE=` env prefix → REFUSED');
  ok(refused(`GIT_DIR=/x/.git ${APPLY} --cached p.diff`), 'r3-break: a `GIT_DIR=` env prefix → REFUSED');
  ok(refused(`export GIT_WORK_TREE=/x; ${APPLY} --cached p.diff`), 'r3-break: `export GIT_WORK_TREE=…;` set earlier on the line → REFUSED (r2 EXEMPTED this)');
  ok(refused(`env GIT_DIR=/x/.git ${APPLY} --cached p.diff`), 'r3-break: `env GIT_DIR=… git apply --cached` → REFUSED (r2 EXEMPTED this)');
  ok(refused(`env X=y ${APPLY} --cached p.diff`), 'r3-break: any `env X=… git …` prefix → REFUSED');

  // REFUSED — r3 SHELL-EXPANSION attacks (what git RECEIVES differs from the literal text).
  ok(refused(`${APPLY} --cached $(echo --reject) p.diff`), 'r3-break: `$(…)` command substitution → REFUSED (r2 EXEMPTED this)');
  ok(refused(`${APPLY} --cached \`echo --reject\` p.diff`), 'r3-break: backtick substitution → REFUSED');
  ok(refused(`${APPLY} --cached \${OPT} p.diff`), 'r3-break: `${…}` parameter expansion → REFUSED');
  ok(refused(`${APPLY} --cached {--reject,p.diff}`), 'r3-break: brace list `{--reject,p.diff}` → REFUSED (r2 EXEMPTED this)');
  ok(refused(`${APPLY} --cached $OPT p.diff`), 'r3-break: a `$VAR` reference → REFUSED');
  ok(refused(`${APPLY} --cached *.patch`), 'r3-break: a `*` glob → REFUSED');
  ok(refused(`${APPLY} --cached p?.patch`), 'r3-break: a `?` glob → REFUSED');
  ok(refused(`${APPLY} --cached [ab].patch`), 'r3-break: a `[…]` glob → REFUSED');
  ok(refused(`${APPLY} --cached ~/p.patch`), 'r3-break: a `~` (tilde) path → REFUSED (lander must use an absolute literal path)');

  // REFUSED — quoting / escaping (r2 EXEMPTED these; over-refusal is fine).
  ok(refused(`${APPLY} --cached 'p.patch'`), "r3: single-quoted path → REFUSED");
  ok(refused(`${APPLY} --cached "p.patch"`), 'r3: double-quoted path → REFUSED');
  ok(refused(`${APPLY} --cached p\\ q.patch`), 'r3: a `\\` escape → REFUSED');

  // REFUSED — a second command on the line, whatever the separator.
  ok(refused(`${APPLY} --cached p.diff\nrm -rf x`), 'r3: a newline-separated second command → REFUSED');
  ok(refused(`${APPLY} --cached p.diff; rm -rf x`), 'r3: `; rm -rf x` second command → REFUSED');
  ok(refused(`export X=1; ${APPLY} --cached p`), 'r3: `export X=1;` before the git → REFUSED');

  // REFUSED — whitespace: a doubled space or a tab is not the single-space shape.
  ok(refused(`${APPLY}  --cached p.diff`), 'r3: a DOUBLE space (`git  apply`) → REFUSED (r2 EXEMPTED this)');
  ok(refused(`${APPLY}\t--cached p.diff`), 'r3: a TAB between tokens → REFUSED');
  ok(refused(`${APPLY} --cached\tp.diff`), 'r3: a TAB before the path → REFUSED');

  // REFUSED — a unicode lookalike dash (U+2011) is not ASCII `--cached`.
  ok(refused(`${APPLY} ‑‑cached p.diff`), 'r3: a unicode lookalike dash in `‑‑cached` → REFUSED');

  // Plain / working-tree apply forms stay tree-classified, as before.
  ok(scanBashMutation(`${APPLY} --reject p.diff`).tree === true, '`apply --reject` without --cached → writes .rej → TREE');
  ok(scanBashMutation(`${APPLY} p.diff`).tree === true, 'plain `apply` (no --cached) → writes the tree → TREE');
  ok(scanBashMutation('git am < p.mbox').tree === true, '`git am` has no --cached and commits → stays TREE');

  // r4: `echo`/`grep` of the literal `git <mutator>` text is now caught by the
  // whole-string wrapper-hole net and REFUSED. This is deliberate over-refusal (the
  // net cannot distinguish quoted data from a real wrapped invocation without
  // tokenizing, which r1/r2/r3 proved unsound); the tree check still only denies
  // when a lock is actually held, so a read command refused here is benign.
  ok(refused(`echo "${APPLY} --cached foo"`), 'r4: echo of the literal `git apply` text → REFUSED (deliberate over-refusal, net cannot tell data from code)');
  ok(refused(`grep -n "${APPLY} --cached" file.txt`), 'r4: grep for the literal `git apply` text → REFUSED (deliberate over-refusal)');

  /* ──────── r4 — the WRAPPER HOLE (anthropic run 7fe2cf90…) ────────────────────
   * r3 recognised the index-only form by a whole-string regex, but the UPSTREAM
   * classifier still (a) read git-apply's post-`--` tokens as WRITTEN pathspecs —
   * they are patch files to READ — so `git apply -- p` / `--cached -- p` keyed the
   * lock to the patch file and slipped every foreign lock; and (b) never reached
   * git at all when git was wrapped (`exec`/`xargs`/`timeout`/…), so a tree-wiping
   * mutator slipped silently. The r4 probe showed 12/13 of these SLIP on the r3
   * code (nohup alone was already a NOOP-head). Each `refused(...)` below is a
   * must-FAIL synthesized from that r3 baseline; `.tree === true` pins whole-tree. */
  // apply's post-`--` tokens are patch files to READ, never written pathspecs → whole tree.
  ok(scanBashMutation(`${APPLY} -- p.patch`).tree === true, 'r4: `apply -- p` (no --cached) → patch file is READ, writes the tree → TREE (r3 keyed it to `p`)');
  ok(scanBashMutation(`${APPLY} --cached -- p.patch`).tree === true, 'r4: `apply --cached -- p` → `--` token is the patch FILE, not a pathspec → TREE (r3 keyed it to `p`, slipping locks)');
  ok(refused(`${APPLY} --cached -- p.patch`), 'r4: `apply --cached -- p` is a mutation (TREE), not index-exempt');
  // The `--` patch-file hole also slips behind a `-C` global option.
  ok(scanBashMutation(`git -C . apply --cached -- p.patch`).tree === true, 'r4: `git -C . apply --cached -- p` → TREE (r3 keyed it to `p`)');
  // Wrapper forms: git never reaches the tokenizer's git branch → whole-string net catches it.
  ok(scanBashMutation(`exec ${APPLY} p.patch`).tree === true, 'r4 wrapper: `exec git apply p` → TREE (r3: not-a-mutation)');
  ok(scanBashMutation(`xargs ${APPLY} < list`).tree === true, 'r4 wrapper: `xargs git apply < list` → TREE (r3: not-a-mutation)');
  ok(scanBashMutation(`timeout 5 ${APPLY} p.patch`).tree === true, 'r4 wrapper: `timeout 5 git apply p` → TREE (r3: not-a-mutation)');
  // The wrapper hole is PER-WRAPPER, not per-verb: every GIT_TREE_MUTATOR slips the same way.
  ok(scanBashMutation(`exec git checkout -- f`).tree === true, 'r4 wrapper: `exec git checkout -- f` → TREE (r3: not-a-mutation)');
  ok(scanBashMutation(`xargs git checkout`).tree === true, 'r4 wrapper: `xargs git checkout` → TREE (r3: not-a-mutation)');
  ok(scanBashMutation(`timeout 5 git reset --hard`).tree === true, 'r4 wrapper: `timeout 5 git reset --hard` → TREE (r3: not-a-mutation)');
  ok(scanBashMutation(`exec git restore f`).tree === true, 'r4 wrapper: `exec git restore f` → TREE (r3: not-a-mutation)');
  ok(scanBashMutation(`timeout 5 git stash`).tree === true, 'r4 wrapper: `timeout 5 git stash` → TREE (r3: not-a-mutation)');
  ok(scanBashMutation(`exec git clean -fd`).tree === true, 'r4 wrapper: `exec git clean -fd` → TREE (r3: not-a-mutation)');
  // Already-caught wrapper forms (NOOP-head / sh -c / env) stay TREE — unchanged.
  ok(scanBashMutation(`command ${APPLY} p.patch`).tree === true, 'r4: `command git apply p` → TREE (NOOP-head, already caught)');
  ok(scanBashMutation(`nohup git reset --hard`).tree === true, 'r4: `nohup git reset --hard` → TREE (NOOP-head, already caught)');
  ok(scanBashMutation(`/usr/bin/git apply p.patch`).tree === true, 'r4: a path-qualified `/usr/bin/git apply` → TREE');

  // REGRESSION GUARDS: the net must NOT widen any of these.
  ok(scanBashMutation(`git checkout -- src/a`).paths?.[0] === 'src/a' && !scanBashMutation(`git checkout -- src/a`).tree, 'r4 guard: a CLEAN `git checkout -- f` keeps its narrow per-file key (count 1 = head 1, net does not widen)');
  ok(scanBashMutation(`git restore src/b`).paths?.[0] === 'src/b', 'r4 guard: `git restore f` stays path-scoped');
  ok(scanBashMutation(`git commit -m "apply the reset fix"`).tree === true, 'r6 over-refusal (was r4 guard): a mutator WORD after `git` (here inside a commit message) NOW trips the net → TREE; r5 needed literal `git <mutator>` adjacency, r6 does not (accepted broadening, fails safe under a foreign lock)');
  ok(!scanBashMutation(`git status`).mutates, 'r4 guard: `git status` is not a mutation');
  ok(!scanBashMutation(`git log --oneline`).mutates, 'r4 guard: `git log` is not a mutation');
  ok(!scanBashMutation(`git diff HEAD`).mutates, 'r4 guard: `git diff` is not a mutation');
  ok(!scanBashMutation(`git add -A`).mutates, 'r4 guard: `git add` is not a mutation');
  ok(!scanBashMutation(`digit apply p`).mutates, 'r4 guard: `digit apply` (git is a substring) does NOT match the net');

  // END-TO-END (the user's reality): a foreign live lane holds a lock on an OUT-OF-REPO scratch
  // file (the FEAT-191 IV repro); the index-only landing must be ALLOWED, a WT-writing apply REFUSED.
  const repo = makeRepo('repo-bug277'); fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  const lockDir = path.join(SCRATCH, 'locks-bug277');
  const A = 'feat191-iv-lane', LANDER = 'bug240-lander';
  const scratchFile = path.join(SCRATCH, 'feat191-iv-r8', 'files.csv'); // out of the repo tree entirely
  fs.mkdirSync(path.dirname(scratchFile), { recursive: true });
  ok(evaluateFileLock({ toolName: 'Write', toolInput: { file_path: scratchFile }, lockDir, repoRoot: repo, owner: A }).allow, 'foreign IV lane holds a lock on an out-of-repo scratch file');
  const landed = evaluateFileLock({ toolName: 'Bash', toolInput: { command: `${APPLY} --cached scripts/git-write-policy.mjs.patch` }, lockDir, repoRoot: repo, owner: LANDER });
  ok(landed.allow, 'POST: the sanctioned `apply --cached` landing is ALLOWED while the foreign lane holds its scratch lock (was REFUSED pre-fix — the live jam)');
  const wt = evaluateFileLock({ toolName: 'Bash', toolInput: { command: `${APPLY} scripts/git-write-policy.mjs.patch` }, lockDir, repoRoot: repo, owner: LANDER });
  ok(!wt.allow && wt.busy && wt.holder?.owner === A, 'POST: a working-tree-writing `apply` (no --cached) is still REFUSED under the foreign lock (names the holder)');
  // And an EXPANSION-form apply is NOT exempted: it too is refused under the foreign lock.
  const expo = evaluateFileLock({ toolName: 'Bash', toolInput: { command: `${APPLY} --cached $(echo scripts/x) p.diff` }, lockDir, repoRoot: repo, owner: LANDER });
  ok(!expo.allow && expo.busy, 'POST: an expansion-form `apply --cached $(…)` is REFUSED under the foreign lock (not index-exempted)');

  // r4 END-TO-END: the two forms the newest verdict (7fe2cf90…) proved slipped the
  // lock. Each must now be REFUSED under the SAME foreign scratch lock. The holder
  // is the out-of-repo IV lane, so this is the user's real landing reality.
  const ddApply = evaluateFileLock({ toolName: 'Bash', toolInput: { command: `${APPLY} --cached -- scripts/git-write-policy.mjs.patch` }, lockDir, repoRoot: repo, owner: LANDER });
  ok(!ddApply.allow && ddApply.busy, 'r4 POST: `git apply --cached -- p` (patch file after `--`) is REFUSED under the foreign lock (r3 keyed it to `p` and ALLOWED it — the verdict)');
  const wrapped = evaluateFileLock({ toolName: 'Bash', toolInput: { command: `exec ${APPLY} scripts/git-write-policy.mjs.patch` }, lockDir, repoRoot: repo, owner: LANDER });
  ok(!wrapped.allow && wrapped.busy, 'r4 POST: a WRAPPED `exec git apply p` is REFUSED under the foreign lock (r3: slipped as not-a-mutation)');
  const wrappedCo = evaluateFileLock({ toolName: 'Bash', toolInput: { command: `timeout 5 git checkout -- scripts/other.txt` }, lockDir, repoRoot: repo, owner: LANDER });
  ok(!wrappedCo.allow && wrappedCo.busy, 'r4 POST: a WRAPPED `timeout 5 git checkout` is REFUSED under the foreign lock (per-wrapper hole, any mutator)');
  // And the sanctioned bare index-only landing is STILL allowed (the whole point).
  const stillAllowed = evaluateFileLock({ toolName: 'Bash', toolInput: { command: `${APPLY} --cached scripts/git-write-policy.mjs.patch` }, lockDir, repoRoot: repo, owner: LANDER });
  ok(stillAllowed.allow, 'r4 POST: the bare `git apply --cached <path>` landing is STILL ALLOWED under the foreign lock (the exemption survives)');

  /* ──────── r5 — the COMBINED LINE (anthropic run 648f8f34…) ───────────────────
   * r4 gated the wrapper-hole net on `mutates:false`, so a line carrying BOTH a
   * path-scoped mutation AND a wrapped whole-tree mutator keyed the lock to the
   * scoped file only and the wrapped mutator slipped. r5 runs the net on EVERY
   * top-level command by COUNTING git tree-mutator occurrences vs those seen as a
   * head `git`; a surplus → whole-tree (the union, strongest wins). Each case was a
   * must-FAIL on the r4 code (verified: it returned `paths:["f"]`, keying `f` only). */
  ok(scanBashMutation(`git checkout -- f; xargs git reset --hard`).tree === true, 'r5: `git checkout -- f; xargs git reset --hard` → TREE (r4 keyed it to `f`, slipping the wrapped reset)');
  ok(scanBashMutation(`git checkout -- f && exec git reset --hard`).tree === true, 'r5: scoped `&&` wrapped → TREE');
  ok(scanBashMutation(`git checkout -- f || exec git reset --hard`).tree === true, 'r5: scoped `||` wrapped → TREE');
  ok(scanBashMutation(`git checkout -- f\nexec git reset --hard`).tree === true, 'r5: scoped + newline + wrapped → TREE');
  ok(scanBashMutation(`git checkout -- f | xargs git reset --hard`).tree === true, 'r5: scoped `|` wrapped → TREE');
  ok(scanBashMutation(`xargs git reset --hard; git checkout -- f`).tree === true, 'r5: wrapped-FIRST then scoped → TREE (order-independent)');
  ok(scanBashMutation(`sed -i s/a/b/ f; exec git reset --hard`).tree === true, 'r5: a non-git scoped mutation (`sed -i`) beside a wrapped git mutator → TREE (closes the r4-noted residual)');
  ok(scanBashMutation(`git checkout -- f; exec git clean -fd`).tree === true, 'r5: scoped checkout + wrapped `git clean` → TREE (any mutator verb)');
  // r9 REVISION of the r5 guards: a COMPOUND line (has `&&`) is NON-SIMPLE, so a git
  // mutator on it is NEVER path-scoped — it widens to whole-tree. This is the accepted
  // r9 over-refusal that replaces the deflatable count comparison. (Under r5 these two
  // stayed path-scoped via count==head; r9 drops counting, so they are whole-tree.)
  ok(scanBashMutation(`git checkout -- f && git checkout -- g`).tree === true, 'r9 over-refusal (was r5 guard): two CLEAN scoped checkouts on a `&&` line → whole-tree (compound line is non-simple; no narrow key)');
  ok(scanBashMutation(`git status && git checkout -- f`).tree === true, 'r9 over-refusal (was r5 guard): `git status && git checkout -- f` → whole-tree (the `&&` makes it non-simple; the net matches `git … checkout`)');
  // But a SIMPLE clean scoped mutator is still path-scoped (the common case, unchanged).
  ok(scanBashMutation(`git checkout -- f`).paths?.[0] === 'f' && !scanBashMutation(`git checkout -- f`).tree, 'r9: a SIMPLE clean `git checkout -- f` still keeps its narrow per-file key (single command, no separator/quote/wrapper)');
  // r5 END-TO-END: the combined line is REFUSED under the foreign out-of-repo lock.
  const combined = evaluateFileLock({ toolName: 'Bash', toolInput: { command: `git checkout -- scripts/other.txt; xargs git reset --hard` }, lockDir, repoRoot: repo, owner: LANDER });
  ok(!combined.allow && combined.busy, 'r5 POST: the combined `checkout -- f; xargs git reset --hard` is REFUSED under the foreign lock (r4 ALLOWED it — keyed to `other.txt` only)');

  /* ──────── r6 — SPACED GLOBAL-OPTION VALUE: the r5 false-ALLOW, now CLOSED ─────
   * r5 skipped git's global options token by token (`(?:-C|-c|…)[ \t]+\S+`), so a
   * global-option VALUE with a SPACE broke the `\S+` match and the WRAPPED tree-wipe
   * classified NON-mutating — a false ALLOW from natural non-obfuscated shell (openai
   * run 01a17e2b…, BROKEN). Each case below was a MEASURED must-FAIL on the r5 code:
   * `scanBashMutation(...)` returned `{mutates:false}` (confirmed live pre-fix, count
   * 0 vs head 0). r6's lazy `\bgit\b[\s\S]*?\b(verb)\b` net spans the spaced value and
   * classifies them whole-tree. These are the user's reality: a lane that wraps git
   * through xargs/exec/timeout with a configured identity/config value that has a
   * space must NOT slip a foreign lock. */
  ok(scanBashMutation(`xargs git -c 'core.x=a b' reset --hard`).tree === true, 'r6: `xargs git -c \'a b\' reset` (SPACED single-quoted -c value, wrapped) → TREE (r5 ALLOWED it — the openai 01a17e2b break)');
  ok(scanBashMutation(`exec git -c "user.name=A B" reset --hard`).tree === true, 'r6: `exec git -c "A B" reset` (SPACED double-quoted -c value, wrapped) → TREE (r5 ALLOWED)');
  ok(scanBashMutation(`exec git -c core.x=a\\ b reset --hard`).tree === true, 'r6: `exec git -c core.x=a\\ b reset` (ESCAPED-space -c value, wrapped) → TREE (r5 ALLOWED)');
  ok(scanBashMutation(`timeout 5 git -C 'a b' checkout -- f`).tree === true, 'r6: `timeout 5 git -C \'a b\' checkout -- f` (SPACED -C dir value, wrapped) → TREE (r5 ALLOWED)');
  ok(scanBashMutation(`exec git -C 'a b' reset --hard`).tree === true, 'r6: `exec git -C \'a b\' reset` — the r5-PINNED residual, now CLOSED (was accepted out-of-contract, now caught)');

  /* ──────── r6 — OBFUSCATION forms r5 could not catch, now CLOSED (welcome tightening)
   * r6's wider net (`git` as a word + any mutator word after it) catches forms r5's
   * option-skipping regex missed, because the LITERAL words `git`/`reset` are present
   * in the text even when quoted. These moved from "accepted out-of-contract" (r5) to
   * CLOSED. If a future change stops catching one WITHOUT reopening a wrapper hole, the
   * pin must be updated deliberately. */
  ok(scanBashMutation(`exec 'git' reset --hard`).tree === true, 'r6 CLOSED (was r5 out-of-contract): a QUOTED command word `exec \'git\' reset` → TREE (the word `git` is still in the text)');
  ok(scanBashMutation(`exec git $'reset' --hard`).tree === true, 'r6 CLOSED (was r5 out-of-contract): an ANSI-C quoted verb `exec git $\'reset\'` → TREE (the word `reset` is still in the text)');

  /* ──────── r6 — OUT-OF-CONTRACT that REMAINS (pinned, documented residual) ─────
   * What r6 still cannot catch is only a form that breaks the LETTERS of `git` or the
   * verb itself, so the word is NEVER present in the text — a backslash INSIDE the
   * word. No agent writes these by accident (the user's intent: stop mistakes by
   * NON-malicious agents, not malicious ones), and a text classifier cannot close
   * shell obfuscation (r1/r2/r3 proved parsing the shell unsound). Each classifies
   * NOT-whole-tree (it would slip a lock); pinned so a SILENT change is noticed. */
  ok(scanBashMutation(`exec g\\it reset --hard`).tree === true, 'r9 CLOSED (was r6 out-of-contract): a backslash INSIDE the `git` word `exec g\\it reset` — the dequoted-copy net removes `\\` → `git` reassembled → TREE');
  ok(!scanBashMutation(`exec git re\\\nset --hard`).tree, 'r9 OUT-OF-CONTRACT (pinned, residual): a backslash-NEWLINE inside the verb `re\\<nl>set` — removing `\\` leaves the newline, so `reset` is still not a contiguous word → not caught (documented residual)');

  /* ──────── r7 — INDIRECTION: the documented limit (pinned, orchestrator option C) ─
   * A shell-TEXT scan sees only a verb LITERALLY present in the command text. A verb
   * produced by the shell at RUN time — a variable, stdin into a verb-reading wrapper,
   * a loop var — is unknowable to any text classifier and out of contract (the user's
   * intent: stop MISTAKES by non-malicious agents; these forms do not arise by accident,
   * and the structural protection for real concurrent work is lane snapshots/worktrees,
   * not this heuristic). r1/r2/r3 proved PARSING the shell to recover them is unsound.
   * Refuted live: openai/anthropic run 317f770a — these 3 cases are the ones it found.
   * Each classifies NOT-whole-tree today; PINNED so a SILENT change is noticed. If a
   * future change DOES catch one without reopening a wrapper hole, update this pin. */
  ok(!scanBashMutation(`echo reset --hard | xargs git`).tree, 'r7 INDIRECTION (pinned, out-of-contract): verb via STDIN `echo reset --hard | xargs git` — the verb sits BEFORE `git`, fed by xargs; no `git <verb>` in the text → not caught (documented residual, run 317f770a)');
  ok(!scanBashMutation(`OP=reset; git $OP --hard`).tree, 'r7 INDIRECTION (pinned, out-of-contract): verb via a shell VARIABLE `OP=reset; git $OP --hard` (even UNWRAPPED — the head-git branch does not expand vars) → not caught (documented residual, run 317f770a)');
  ok(scanBashMutation(`git checkout -- held2.txt; echo reset --hard | xargs git`).tree === true, 'r9 (was r7 residual): a COMBINED line carrying a LITERAL `git checkout` beside a stdin-fed wrapped reset → whole-tree (the `;` makes it non-simple and the net matches the literal `git … checkout`; the indirection-borne wipe is still not individually detected, but the line as a whole is now caught — a strict improvement, run 317f770a)');

  /* ──────── r6 — ACCEPTED OVER-REFUSAL (pinned, now BROADER than r5) ────────────
   * The net is a TEXT scan with no subcommand-position parse (r1/r2/r3 proved parsing
   * the raw string unsound — it is what let wrappers through). So ANY command whose
   * text has the word `git` followed later by a tree-mutator word classifies whole-tree.
   * r5 needed a literal `git <mutator>` adjacency; r6 needs only a mutator WORD anywhere
   * after `git` — so a commit MESSAGE with ordinary prose containing `apply`/`merge`/…
   * now over-refuses. The ONLY consequence is a refusal while a FOREIGN lock is held; it
   * fails safe and costs a reworded message or a retry. The orchestrator ACCEPTS this
   * broadening (over-refusal is a documented residual; a false ALLOW is the real break).
   * If a future change narrows it WITHOUT reopening a wrapper hole, update this pin. */
  ok(scanBashMutation(`git commit -m "Document git reset usage"`).tree === true, 'r6 OVER-REFUSAL (pinned, accepted): `git commit -m "...git reset..."` → whole-tree (r5 also caught this; fails safe)');
  ok(scanBashMutation(`git log --grep "git reset"`).tree === true, 'r6 OVER-REFUSAL (pinned, accepted): `git log --grep "git reset"` → whole-tree (fails safe)');
  ok(scanBashMutation(`git commit -m "fix the apply bug"`).tree === true, 'r6 OVER-REFUSAL (pinned, NEW in r6): a commit message with a lone mutator word (`apply`) and NO `git <mutator>` adjacency NOW → whole-tree (r5 left this a non-mutation; accepted broadening)');
  // The over-refusal still does NOT fire without a mutator WORD after `git`: an
  // ordinary message with no tree-mutator word is NOT a mutation.
  ok(!scanBashMutation(`git commit -m "normal message"`).mutates, 'r6 guard: an ordinary commit message (no tree-mutator word after `git`) is NOT a mutation');
  ok(!scanBashMutation(`git commit -m "update the docs and tests"`).mutates, 'r6 guard: a benign message with no mutator word stays a non-mutation (over-refusal needs a mutator word to fire)');

  /* ──────── r8 — SUBSTITUTION DEFLATES THE COUNT (anthropic run d3bcfc7e…) ───────
   * r6's surplus-count net could be DEFLATED: a command substitution in a git
   * GLOBAL-OPTION VALUE carries a path-scoped git mutator INSIDE the substitution.
   * Its recursive scan raised the head-`git` count to EQUAL the raw-string count, so
   * `count > head` was false and the LITERAL outer tree-wipe (`reset --hard`, `clean
   * -fdx`) was dropped → ALLOWED under a foreign lock. Both the git word AND the
   * mutator verb are literally on the line, so this is an IN-CONTRACT false ALLOW.
   * The orchestrator's rule (a): a line carrying ANY substitution (`$(`, a backtick,
   * `<(`, `>(`) AND ANY git-tree-mutator match → WHOLE-TREE, uncounted. Each of the 3
   * cited forms (+ backtick and process-substitution variants) was a must-FAIL on the
   * r6/r7 code (verified: returned `paths:[…]`, keying the scoped decoy only). */
  ok(scanBashMutation(`timeout 60 git -C "$(git restore scripts/other.txt; pwd)" reset --hard`).tree === true, 'r8 cited#1: a `$(…)` in a `-C` VALUE holding a scoped `git restore`, beside a literal `reset --hard` → TREE (r7 keyed it to other.txt and ALLOWED the reset)');
  ok(scanBashMutation(`xargs git -c user.name="$(git checkout -- scripts/other.txt; echo bot)" reset --hard`).tree === true, 'r8 cited#2: a `$(…)` in a `-c` config VALUE holding a scoped `git checkout`, beside a literal `reset --hard` → TREE (r7 keyed it to other.txt and ALLOWED the reset)');
  ok(scanBashMutation(`exec git -C \`git rm --cached scripts/other.txt; pwd\` clean -fdx`).tree === true, 'r8 cited#3: a BACKTICK substitution in a `-C` value holding a scoped `git rm`, beside a literal `clean -fdx` → TREE (r7 keyed it to other.txt and ALLOWED the clean)');
  ok(scanBashMutation(`git checkout -- scripts/other.txt < <(git reset --hard)`).tree === true, 'r8 `<(` process-substitution variant: a scoped checkout with a tree-wipe in a `<(…)` → TREE');
  ok(scanBashMutation(`git checkout -- scripts/other.txt > >(git reset --hard)`).tree === true, 'r8 `>(` process-substitution variant → TREE');
  // Over-refusals ADDED by rule (a): a CLEAN scoped git mutator whose argument comes
  // from a substitution, and a substitution BODY that is itself a scoped mutator, now
  // classify whole-tree. Accepted direction (refused only while a foreign lock is held).
  ok(scanBashMutation(`git checkout -- "$(cat paths.txt)"`).tree === true, 'r8 OVER-REFUSAL (accepted, NEW): a clean scoped `git checkout -- "$(cat paths.txt)"` now → whole-tree (was path-scoped; fails safe under a lock)');
  ok(scanBashMutation(`git restore "$(echo src/a.ts)"`).tree === true, 'r8 OVER-REFUSAL (accepted, NEW): a clean scoped `git restore "$(…)"` now → whole-tree');
  ok(scanBashMutation(`echo "$(git checkout -- f)"`).tree === true, 'r8 OVER-REFUSAL (accepted, NEW): a benign `echo "$(git checkout -- f)"` wrapping a scoped mutator now → whole-tree');
  // Guards: rule (a) needs BOTH a substitution AND a git+mutator word. Neither alone trips it.
  ok(!scanBashMutation(`S=$(mktemp -d); echo x > $S/out.txt`).mutates, 'r8 guard: a substitution with NO git+mutator word (`$(mktemp -d)`) is unaffected (stays a non-mutation)');
  ok(!scanBashMutation(`git commit -m "$(cat msg.txt)"`).mutates, 'r8 guard: a `$(…)` in a commit message with NO tree-mutator word stays a non-mutation (needs a mutator word to trip)');
  ok(scanBashMutation(`git checkout -- src/a`).paths?.[0] === 'src/a' && !scanBashMutation(`git checkout -- src/a`).tree, 'r8 guard: a git+mutator with NO substitution stays path-scoped (rule (a) needs a substitution token)');
  // r8 indirection pins UNCHANGED: a verb produced ONLY by a variable/STDIN, with no
  // literal git+verb AND no substitution token on the line, still is NOT caught.
  ok(!scanBashMutation(`OP=reset; git $OP --hard`).tree, 'r8 guard: the r7 `$OP` variable pin is NOT a substitution (`$O`≠`$(`) and stays out-of-contract (not tree)');
  ok(!scanBashMutation(`echo reset --hard | xargs git`).tree, 'r8 guard: the r7 STDIN indirection pin (no substitution token) stays out-of-contract (not tree)');
  // r8 END-TO-END (the user's reality): the 3 cited forms are REFUSED under the SAME
  // foreign out-of-repo scratch lock that the live jam involved.
  const subC = evaluateFileLock({ toolName: 'Bash', toolInput: { command: `timeout 60 git -C "$(git restore scripts/other.txt; pwd)" reset --hard` }, lockDir, repoRoot: repo, owner: LANDER });
  ok(!subC.allow && subC.busy && subC.holder?.owner === A, 'r8 POST: the `-C "$(…)"` deflation form is REFUSED under the foreign lock (r7 ALLOWED it — keyed to other.txt)');
  const subc = evaluateFileLock({ toolName: 'Bash', toolInput: { command: `xargs git -c user.name="$(git checkout -- scripts/other.txt; echo bot)" reset --hard` }, lockDir, repoRoot: repo, owner: LANDER });
  ok(!subc.allow && subc.busy, 'r8 POST: the `-c "$(…)"` deflation form is REFUSED under the foreign lock (r7 ALLOWED it)');
  const btick = evaluateFileLock({ toolName: 'Bash', toolInput: { command: `exec git -C \`git rm --cached scripts/other.txt; pwd\` clean -fdx` }, lockDir, repoRoot: repo, owner: LANDER });
  ok(!btick.allow && btick.busy, 'r8 POST: the backtick deflation form is REFUSED under the foreign lock (r7 ALLOWED it)');
  // And the sanctioned bare index-only landing (no substitution) is STILL allowed.
  const stillLanded = evaluateFileLock({ toolName: 'Bash', toolInput: { command: `${APPLY} --cached scripts/git-write-policy.mjs.patch` }, lockDir, repoRoot: repo, owner: LANDER });
  ok(stillLanded.allow, 'r8 POST: the bare `git apply --cached <path>` landing (no substitution) is STILL ALLOWED under the foreign lock (the exemption survives r8)');

  /* ──────── r9 — DECOY-SPLIT deflates the count; the count is REMOVED (run 4791d92b…)
   * r5–r8 compared a raw-string mutator COUNT with the tokenizer's head-`git` count. The
   * raw count ran the verb regex on STILL-QUOTED text while the head count was taken on the
   * UNQUOTED word, so a quote/escape-SPLIT decoy verb (`git "che"ckout -- f`) UNDER-COUNTED
   * the raw side, equalised the counts, and a LITERAL wrapped tree-wipe beside it slipped a
   * foreign lock (the un-split control WAS refused). r9 removes counting entirely: a git
   * mutator is path-scoped ONLY on a SIMPLE line (isSimpleLine); every OTHER net match —
   * tested on the RAW text AND a quote/escape-stripped copy — is whole-tree. Each decoy case
   * below was a MEASURED must-FAIL on the r8 code (probed live: returned `paths:["f"]`). */
  ok(scanBashMutation(`git "che"ckout -- f; xargs git reset --hard`).tree === true, 'r9 cited: a QUOTE-SPLIT decoy verb `git "che"ckout` beside a wrapped `reset --hard` → TREE (r8 keyed it to `f`; the dequoted-copy net reassembles `checkout` and the `;` makes the line non-simple)');
  ok(scanBashMutation(`git ""checkout -- f; xargs git reset --hard`).tree === true, 'r9: an EMPTY-QUOTE split `git ""checkout` beside a wrapped reset → TREE');
  ok(scanBashMutation(`git che\\ckout -- f; xargs git reset --hard`).tree === true, 'r9 cited: a BACKSLASH-split verb `git che\\ckout` beside a wrapped reset → TREE (the dequoted copy removes `\\`)');
  ok(scanBashMutation(`git "che"ckout -- f; xargs git stash`).tree === true, 'r9 cited: the same decoy split beside a wrapped `stash` → TREE (any mutator verb)');
  ok(scanBashMutation(`git checkout -- f; xargs git reset --hard`).tree === true, 'r9: the un-split control (combined wrapped reset) stays TREE');

  // r9 SIMPLE-line predicate + the forms that keep a narrow path-scoped key.
  ok(isSimpleLine(`git checkout -- src/a`) === true, 'r9 predicate: a bare single git command, no separator/quote/substitution/wrapper → SIMPLE');
  ok(isSimpleLine(`git -C a -C b restore x`) === true, 'r9 predicate: git global options do NOT make a line non-simple → SIMPLE');
  ok(isSimpleLine(`git checkout -- f && git checkout -- g`) === false, 'r9 predicate: a `&&` separator → NOT simple');
  ok(isSimpleLine(`git checkout -- f | xargs git reset`) === false, 'r9 predicate: a `|` pipe → NOT simple');
  ok(isSimpleLine(`sh -c "git checkout -- f"`) === false, 'r9 predicate: a wrapper head (sh -c) → NOT simple');
  ok(isSimpleLine(`exec git checkout -- f`) === false, 'r9 predicate: a wrapper head (exec) → NOT simple');
  ok(isSimpleLine(`git checkout -- "a b.txt"`) === false, 'r9 predicate: a quote (even only in a path) → NOT simple (conservative; accepted over-refusal)');
  ok(isSimpleLine(`git checkout -- "$(cat p)"`) === false, 'r9 predicate: a command substitution → NOT simple');
  ok(scanBashMutation(`git checkout -- src/a`).paths?.[0] === 'src/a' && !scanBashMutation(`git checkout -- src/a`).tree, 'r9 guard: a SIMPLE `git checkout -- f` is path-scoped');
  ok(scanBashMutation(`git restore src/b`).paths?.[0] === 'src/b', 'r9 guard: a SIMPLE `git restore f` is path-scoped');
  ok(scanBashMutation(`git -C a -C b restore x`).paths?.[0] === 'a/b/x', 'r9 guard: a SIMPLE `git -C a -C b restore x` is path-scoped (global options composed)');

  // r9 END-TO-END: the decoy-split is REFUSED under the SAME foreign out-of-repo scratch lock.
  const decoy = evaluateFileLock({ toolName: 'Bash', toolInput: { command: `git "che"ckout -- scripts/other.txt; xargs git reset --hard` }, lockDir, repoRoot: repo, owner: LANDER });
  ok(!decoy.allow && decoy.busy && decoy.holder?.owner === A, 'r9 POST: the decoy-split `git "che"ckout … ; xargs git reset --hard` is REFUSED under the foreign lock (r8 keyed it to other.txt and ALLOWED the reset)');
  const r9Landed = evaluateFileLock({ toolName: 'Bash', toolInput: { command: `${APPLY} --cached scripts/git-write-policy.mjs.patch` }, lockDir, repoRoot: repo, owner: LANDER });
  ok(r9Landed.allow, 'r9 POST: the bare `git apply --cached <path>` landing (a SIMPLE line) is STILL ALLOWED under the foreign lock (the exemption survives r9)');
}

/* ───────────────────────── 11. BUG-281 — whole-repo pathspecs on a SIMPLE line ──
 * The IV (anthropic run 2c55fd7b, BUG-277 r9) found gitMutationTarget keyed
 * WHOLE-REPO pathspecs as narrow per-file keys on a SIMPLE line — git magic (`:/`,
 * `:(top)`, `:(glob)`, `:!`), paths normalising to the repo root or above (`./`,
 * `src/..`, `$PWD`, `../x`, the absolute repo root), globs (`*`, `?`, `[`), a
 * trailing-slash directory, and `--pathspec-from-file`. A real-git wipe passed a
 * foreign lock. Each case is a MEASURED must-FAIL on the PRE-fix code (captured on
 * HEAD before the fix: every one returned `{paths:[<literal>]}`, NOT tree — e.g.
 * `git checkout -- :/` → `paths:[":/"]`, `git checkout -- $PWD` → `paths:["."]`,
 * `git checkout -- *` → `paths:["*"]`; only `.` and `--pathspec-from-file` were
 * already tree). Post-fix they classify whole-tree. */
section('11. BUG-281 — whole-repo pathspecs on a SIMPLE line → whole-tree (anthropic run 2c55fd7b)');
{
  // Every one of these was NARROW (false-ALLOW shape) on the pre-fix code.
  const treeAttacks = [
    ['git checkout -- :/', 'magic :/ — whole repo from root (pre: paths:[":/"])'],
    ['git checkout -- :(top)f', 'magic :(top) (pre: paths:[":"])'],
    ['git checkout -- :(glob)*.js', 'magic :(glob) (pre: paths:[":"])'],
    ['git checkout -- :!f', 'magic :! exclude (pre: paths:[":!f"])'],
    ['git checkout -- ./', 'trailing-slash repo root (pre: paths:["./"])'],
    ['git checkout -- src/..', 'normalises to repo root (pre: paths:["."])'],
    ['git checkout -- $PWD', '$PWD → repo root (pre: paths:["."])'],
    ['git checkout -- ../x', 'escapes above the root (pre: paths:["../x"])'],
    ['git checkout -- *', 'shell glob * (pre: paths:["*"])'],
    ['git checkout -- *.js', 'shell glob *.js (pre: paths:["*.js"])'],
    ['git checkout -- src/?', 'glob ? (pre: paths:["src/?"])'],
    ['git checkout -- [ab]', 'glob [..] (pre: paths:["[ab]"])'],
    ['git restore :/', 'restore magic :/ (pre: paths:[":/"])'],
    ['git rm *', 'rm glob (pre: paths:["*"])'],
    ['git restore src/', 'restore trailing-slash dir (pre: paths:["src/"])'],
    ['git checkout-index :/', 'checkout-index magic (pre: paths:[":/"])'],
    ['git checkout --pathspec-from-file=list', 'pathspec list from a file we cannot see'],
    ['git restore --pathspec-from-file=-', 'pathspec list from stdin'],
    [`git checkout -- ${REPO_ROOT}`, 'the absolute repo root (pre: paths:[<abs>])'],
    ['git checkout -- ~/f', 'tilde (home) expansion (pre: paths:["~/f"])'],
    ['git checkout -- src/.', 'dot-suffixed DIRECTORY ref — normalises to `src` (pre: paths:["src"]; IV-found)'],
    ['git checkout -- src/./', 'dot-slash directory ref'],
    ['git checkout -- foo/..', 'parent ref normalises to root'],
    ['git read-tree -- HEAD', 'read-tree takes a tree-ish, never a pathspec (pre: paths:["HEAD"]; IV-found)'],
    ['git read-tree -m -u HEAD', 'read-tree -m -u rewrites the whole working tree'],
  ];
  for (const [cmd, why] of treeAttacks) ok(scanBashMutation(cmd).tree === true, `BUG-281: \`${cmd}\` → whole-tree (${why})`);
  // A `.`/`..` segment MID-path is just noise and must NOT widen a real file.
  ok(scanBashMutation('git checkout -- src/./a.js').paths?.[0] === 'src/a.js' && !scanBashMutation('git checkout -- src/./a.js').tree, 'BUG-281 guard: a mid-path `.` segment normalises away; the literal file stays scoped');
  ok(scanBashMutation('git checkout -- .').tree === true, 'BUG-281 guard: `git checkout -- .` stays whole-tree (was already caught)');

  // REGRESSION GUARDS — a genuine narrow literal path must stay path-scoped.
  ok(scanBashMutation('git checkout -- src/a.js').paths?.[0] === 'src/a.js' && !scanBashMutation('git checkout -- src/a.js').tree, 'BUG-281 guard: a plain relative file stays path-scoped');
  ok(scanBashMutation('git restore src/b.ts').paths?.[0] === 'src/b.ts', 'BUG-281 guard: `git restore <plain file>` stays scoped');
  ok(scanBashMutation('git -C sub checkout -- c.txt').paths?.[0] === 'sub/c.txt', 'BUG-281 guard: `-C sub` + plain file keeps its narrow key');
  ok(scanBashMutation('git checkout -- src/sub/../a.js').paths?.[0] === 'src/a.js', 'BUG-281 guard: an internal `..` that stays inside normalises and stays scoped');
  ok(scanBashMutation('git -C a -C b restore x').paths?.[0] === 'a/b/x', 'BUG-281 guard: composed `-C` dirs + plain file still path-scoped');
  // The exempt landing form is unaffected (returns before the classifier).
  ok(classifyMutation({ toolName: 'Bash', toolInput: { command: 'git apply --cached scripts/x.patch' } }).mutates === false, 'BUG-281 guard: the `git apply --cached <path>` landing is still EXEMPT');

  // END-TO-END on a REAL scratch repo (the user's reality): lane A holds an
  // uncommitted hunk; lane B runs a whole-repo pathspec. must-FAIL (hatch open =
  // pre-fix behaviour) DRIVES the real git wipe; must-PASS (lock on) DENIES it.
  // Specs git expands ITSELF (no shell needed through execFileSync): `:/`, the
  // absolute repo root, `src/..`, `./` — all verified to wipe real uncommitted work.
  const repo = makeRepo('repo-bug281');
  const file = path.join(repo, 'shared.ts');
  write(file, 'committed\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const lockDir = path.join(SCRATCH, 'locks-bug281');
  const A = 'session-A-281', B = 'session-B-281';
  const realWipeSpecs = [':/', repo, 'src/..', './'];
  for (const spec of realWipeSpecs) {
    const cmd = `git checkout -- ${spec}`;
    // must-FAIL: hatch open → B allowed → run the REAL checkout → A's work is lost.
    write(file, 'A-uncommitted-work\n');
    evaluateFileLock({ toolName: 'Write', toolInput: { file_path: file }, lockDir, repoRoot: repo, owner: A });
    const hatch = evaluateFileLock({ toolName: 'Bash', toolInput: { command: cmd }, lockDir, repoRoot: repo, owner: B, env: { ORCHARD_ALLOW_FILE_CLOBBER: '1' } });
    ok(hatch.allow, `BUG-281 PRE (hatch open): B's \`${cmd}\` is ALLOWED (pre-fix narrow key → no protection)`);
    git(repo, 'checkout', '--', spec); // the actual clobbering command, run by real git
    ok(read(file) === 'committed\n', `BUG-281 PRE: A's uncommitted work was CLOBBERED by \`${cmd}\` (real wipe reproduced)`);
    // must-PASS: lock on → B denied as busy (whole-tree) → good-citizen B does not run it → A survives.
    write(file, 'A-uncommitted-work\n');
    evaluateFileLock({ toolName: 'Write', toolInput: { file_path: file }, lockDir, repoRoot: repo, owner: A });
    const locked = evaluateFileLock({ toolName: 'Bash', toolInput: { command: cmd }, lockDir, repoRoot: repo, owner: B });
    ok(!locked.allow && locked.busy && locked.tree === true && locked.holder?.owner === A, `BUG-281 POST: B's \`${cmd}\` is DENIED whole-tree, names holder A`);
    ok(read(file) === 'A-uncommitted-work\n', `BUG-281 POST: A's uncommitted work SURVIVES \`${cmd}\``);
  }
  // A genuine NARROW checkout of a DIFFERENT file is still allowed under A's lock —
  // the fix does not over-refuse an unrelated literal path.
  const other = path.join(repo, 'other.ts');
  write(other, 'x\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'two');
  write(file, 'A-uncommitted-work\n');
  evaluateFileLock({ toolName: 'Write', toolInput: { file_path: file }, lockDir, repoRoot: repo, owner: A });
  const narrowOk = evaluateFileLock({ toolName: 'Bash', toolInput: { command: 'git checkout -- other.ts' }, lockDir, repoRoot: repo, owner: B });
  ok(narrowOk.allow, 'BUG-281 POST: a NARROW `git checkout -- other.ts` (A holds shared.ts) is still ALLOWED — no over-refusal of an unrelated literal path');

  /* ── IV findings (anthropic run 389a503c, r1 BROKEN) — driven on REAL git ──────
   * (1) `--icase-pathspecs` matches case-INSENSITIVELY, so the literal key
   *     `src/SHARED.TS` aliases a lock on `src/shared.ts` and real git wiped it;
   *     gitSubcommand silently skipped the option (pre-fix narrow:["src/SHARED.TS"]).
   * (2) `git checkout -- src` (bare DIRECTORY, no trailing slash) is keyed narrow
   *     `src` but real git restores every file UNDER it, wiping a lock on
   *     `src/shared.ts` (pre-fix narrow:["src"], ALLOWED). */
  // Classifier: global pathspec-mode options widen matching → whole-tree.
  ok(scanBashMutation('git --icase-pathspecs checkout -- src/SHARED.TS').tree === true, 'BUG-281 IV#1: `git --icase-pathspecs checkout -- src/SHARED.TS` → whole-tree (case-insensitive aliasing; pre: narrow)');
  ok(scanBashMutation('git --glob-pathspecs checkout -- src/a').tree === true, 'BUG-281 IV#1: `--glob-pathspecs` (wildcard matching on) → whole-tree');
  ok(scanBashMutation('git --literal-pathspecs restore x').tree === true, 'BUG-281 IV#1: `--literal-pathspecs` (semantics altered) → whole-tree (conservative)');
  ok(scanBashMutation('git --noglob-pathspecs rm x').tree === true, 'BUG-281 IV#1: `--noglob-pathspecs` → whole-tree (conservative)');
  // REAL-git end-to-end for BOTH findings on a repo with a nested src/ dir.
  const ivRepo = makeRepo('repo-bug281-iv');
  fs.mkdirSync(path.join(ivRepo, 'src'), { recursive: true });
  const nested = path.join(ivRepo, 'src', 'shared.ts');
  write(nested, 'committed\n'); git(ivRepo, 'add', '.'); git(ivRepo, 'commit', '-qm', 'base');
  const ivLock = path.join(SCRATCH, 'locks-bug281-iv');
  const ivDrives = [
    ['git --icase-pathspecs checkout -- src/SHARED.TS', ['--icase-pathspecs', 'checkout', '--', 'src/SHARED.TS'], 'IV#1 icase-alias'],
    ['git checkout -- src', ['checkout', '--', 'src'], 'IV#2 bare-directory'],
  ];
  for (const [cmd, realArgs, label] of ivDrives) {
    // must-FAIL (hatch open): B allowed → real git wipes A's nested work.
    write(nested, 'A-uncommitted-work\n');
    evaluateFileLock({ toolName: 'Write', toolInput: { file_path: nested }, lockDir: ivLock, repoRoot: ivRepo, owner: A });
    const hatch = evaluateFileLock({ toolName: 'Bash', toolInput: { command: cmd }, lockDir: ivLock, repoRoot: ivRepo, owner: B, env: { ORCHARD_ALLOW_FILE_CLOBBER: '1' } });
    ok(hatch.allow, `BUG-281 ${label} PRE (hatch open): B's \`${cmd}\` ALLOWED`);
    git(ivRepo, ...realArgs);
    ok(read(nested) === 'committed\n', `BUG-281 ${label} PRE: real git WIPED A's nested src/shared.ts (false-ALLOW reproduced)`);
    // must-PASS (lock on): denied, names A, A survives.
    write(nested, 'A-uncommitted-work\n');
    evaluateFileLock({ toolName: 'Write', toolInput: { file_path: nested }, lockDir: ivLock, repoRoot: ivRepo, owner: A });
    const locked = evaluateFileLock({ toolName: 'Bash', toolInput: { command: cmd }, lockDir: ivLock, repoRoot: ivRepo, owner: B });
    ok(!locked.allow && locked.busy && locked.holder?.owner === A, `BUG-281 ${label} POST: B's \`${cmd}\` DENIED, names holder A`);
    ok(read(nested) === 'A-uncommitted-work\n', `BUG-281 ${label} POST: A's nested work SURVIVES`);
  }
  // Guard: a bare-directory checkout of an UNLOCKED sibling dir is still allowed.
  fs.mkdirSync(path.join(ivRepo, 'docs'), { recursive: true });
  // stage ONLY docs/ — a `git add .` here would capture the modified src/shared.ts into
  // HEAD and break the later real-wipe baseline (it must stay `committed\n`).
  write(path.join(ivRepo, 'docs', 'r.md'), 'x\n'); git(ivRepo, 'add', 'docs'); git(ivRepo, 'commit', '-qm', 'docs');
  write(nested, 'A-uncommitted-work\n');
  evaluateFileLock({ toolName: 'Write', toolInput: { file_path: nested }, lockDir: ivLock, repoRoot: ivRepo, owner: A });
  const sibling = evaluateFileLock({ toolName: 'Bash', toolInput: { command: 'git checkout -- docs' }, lockDir: ivLock, repoRoot: ivRepo, owner: B });
  ok(sibling.allow, 'BUG-281 IV guard: a bare-dir `git checkout -- docs` (A holds src/shared.ts, nothing under docs/) is still ALLOWED — prefix check does not over-refuse an unrelated dir');

  /* ── IV r1 finding (anthropic run 79ff4718, BROKEN) — git long-option ABBREVIATIONS
   * defeat exact-name matching. git accepts any unambiguous prefix, so
   * `git restore --pathspec-from list` ≡ `--pathspec-from-file` and read the list file
   * (keyed narrow:["list"], ALLOWED, real git wiped). The robust fix is deny-by-default
   * on options: a path-scope survives only with a known-safe option set (BUG-277 lesson:
   * precise git-option parsing is unsound). Other wideners: `--prefix`, `-a`/`--all`,
   * `--source`/`-s <tree>`, and global pathspec-mode options + their abbreviations. */
  const optAttacks = [
    ['git restore --pathspec-from list', '--pathspec-from (abbrev of --pathspec-from-file; pre: narrow:["list"])'],
    ['git restore --pathspec-from-fi list', 'a shorter abbrev of --pathspec-from-file'],
    ['git restore --pathspec-fr list', 'the minimal unambiguous abbrev'],
    ['git rm --pathspec-from-file list', '--pathspec-from-file on rm'],
    ['git checkout-index --prefix=out/ src/a.js', '--prefix writes to a DIFFERENT path'],
    ['git checkout-index -a src/a.js', '-a/--all checks out EVERY file'],
    ['git checkout-index --all', '--all with no pathspec'],
    ['git restore -s HEAD src/a.js', '-s <tree> source; HEAD is a tree-ish not a pathspec'],
    ['git restore --source=HEAD src/a.js', '--source=<tree>'],
    ['git --icase checkout -- src/A.TS', 'global --icase (abbrev of --icase-pathspecs)'],
    ['git -c core.ignorecase=true checkout -- src/A.TS', 'a -c config override — unsafe global'],
    ['git --work-tree=/x checkout -- a', '--work-tree relocates the tree'],
  ];
  for (const [cmd, why] of optAttacks) ok(scanBashMutation(cmd).tree === true, `BUG-281 IV#3: \`${cmd}\` → whole-tree (${why})`);
  // REGRESSION GUARDS — the safe-flag allowlist keeps the common narrow forms scoped.
  ok(scanBashMutation('git checkout -f -- src/a.js').paths?.[0] === 'src/a.js', 'BUG-281 IV#3 guard: `-f`/`--force` is safe → `git checkout -f -- src/a.js` stays scoped');
  ok(scanBashMutation('git restore -q src/b.ts').paths?.[0] === 'src/b.ts', 'BUG-281 IV#3 guard: `-q`/`--quiet` is safe → stays scoped');
  ok(scanBashMutation('git rm -f src/b.ts').paths?.[0] === 'src/b.ts', 'BUG-281 IV#3 guard: `git rm -f <file>` stays scoped');
  // REAL-git end-to-end: the abbreviated pathspec-from-file wipe is DENIED under A's lock.
  write(nested, 'A-uncommitted-work\n');
  fs.writeFileSync(path.join(ivRepo, 'plist'), 'src/shared.ts\n');
  evaluateFileLock({ toolName: 'Write', toolInput: { file_path: nested }, lockDir: ivLock, repoRoot: ivRepo, owner: A });
  const abbrev = evaluateFileLock({ toolName: 'Bash', toolInput: { command: 'git restore --pathspec-from plist' }, lockDir: ivLock, repoRoot: ivRepo, owner: B });
  ok(!abbrev.allow && abbrev.busy && abbrev.holder?.owner === A, 'BUG-281 IV#3 POST: `git restore --pathspec-from <list>` (abbrev) is DENIED whole-tree under A\'s lock, names A');

  /* ── IV r2 finding (anthropic run 13eb5ef4, BROKEN) — post-`--` is a PATHSPEC only for
   * pathspec verbs. `git switch -f -- other` means switch to BRANCH `other` (discards the
   * working tree), yet the old `--` branch keyed it narrow `["other"]` and ALLOWED it
   * under a foreign lock (real git threw A's work away). Only checkout/restore/rm/
   * checkout-index/reset take working-tree pathspecs after `--`; every other verb → tree. */
  const refVerbAttacks = [
    ['git switch -f -- other', 'switch -f -- BRANCH discards the worktree (pre: narrow:["other"])'],
    ['git switch -- other', 'switch -- BRANCH (`--` disambiguates a branch name)'],
    ['git switch other', 'bare switch to a branch'],
    ['git merge -- topic', 'merge ref after `--`'],
    ['git rebase -- upstream', 'rebase ref after `--`'],
    ['git cherry-pick -- abc123', 'cherry-pick ref after `--`'],
    ['git revert -- abc123', 'revert ref after `--`'],
    ['git pull -- origin main', 'pull refspec after `--`'],
    ['git stash push -- file', 'stash is not a narrow pathspec verb here (over-refusal)'],
    ['git clean -- dir', 'clean after `--`'],
    ['git mv -- a b', 'mv after `--`'],
    ['git reset --hard', 'reset --hard (no `--`) → whole tree'],
    ['git reset HEAD~1', 'reset to a commit-ish (no `--`) → whole tree'],
  ];
  for (const [cmd, why] of refVerbAttacks) ok(scanBashMutation(cmd).tree === true, `BUG-281 IV#4: \`${cmd}\` → whole-tree (${why})`);
  // Guards: reset of explicit index paths stays narrow; checkout <branch> is tree (pinned by section 1).
  ok(scanBashMutation('git reset -- src/a.js').paths?.[0] === 'src/a.js', 'BUG-281 IV#4 guard: `git reset -- <file>` (index unstage) stays path-scoped');
  // REAL-git end-to-end: a branch-switching clobber is DENIED under A's nested lock.
  git(ivRepo, 'branch', 'feature');
  write(nested, 'A-uncommitted-work\n');
  evaluateFileLock({ toolName: 'Write', toolInput: { file_path: nested }, lockDir: ivLock, repoRoot: ivRepo, owner: A });
  const sw = evaluateFileLock({ toolName: 'Bash', toolInput: { command: 'git switch -f -- feature' }, lockDir: ivLock, repoRoot: ivRepo, owner: B });
  ok(!sw.allow && sw.busy && sw.holder?.owner === A, 'BUG-281 IV#4 POST: `git switch -f -- feature` is DENIED whole-tree under A\'s lock (pre-fix keyed narrow:["feature"] and wiped), names A');

  /* ── IV r3 findings (anthropic run 227692c8, BROKEN) ──────────────────────────
   * (A) BRACE expansion: `{.,.}` / `{:/,.}` passed isNarrowPathspec (no brace check)
   *     but bash expands it to `.`/`:/` and real git wiped (run bcfd0d07).
   * (B) `-C ..` chain back to the repo root: `git -C .. checkout -- repo` composes
   *     `../repo` (the whole repo) but was keyed narrow — isNarrowPathspec judged only
   *     the bare pathspec, not the `-C`-composed effective path (run 47655bb7). */
  const r3Attacks = [
    ['git checkout -- {.,.}', 'brace expands to `.` `.` → repo root'],
    ['git checkout -- {:/,.}', 'brace expands to `:/` (magic) and `.`'],
    ['git restore {.,.}', 'brace on restore'],
    ['git checkout -- {a,b}', 'any brace list is unresolved-wide → tree (over-refusal)'],
    ['git -C .. checkout -- repo', '-C .. composes `../repo` = the whole repo'],
    ['git -C .. restore r1/src', '-C .. composes `../r1/src` (escapes this repo)'],
    ['git -C x/.. -C .. checkout -- repo', 'composed `-C` chain climbs to the parent'],
  ];
  for (const [cmd, why] of r3Attacks) ok(scanBashMutation(cmd).tree === true, `BUG-281 IV#5: \`${cmd}\` → whole-tree (${why})`);
  // Guards: a `-C` chain that stays INSIDE the repo keeps its narrow key.
  ok(scanBashMutation('git -C x/.. checkout -- shared.ts').paths?.[0] === 'shared.ts', 'BUG-281 IV#5 guard: `-C x/..` (net cwd = repo root) + a plain file stays path-scoped');
  ok(scanBashMutation('git -C a -C b restore x').paths?.[0] === 'a/b/x', 'BUG-281 IV#5 guard: an in-repo `-C` chain still composes a narrow key');
  // The shell expands `{.,.}` to `. .` BEFORE git runs; real git then wipes the whole
  // tree (the `.`/`:/`/`src/..` forms are already driven on real git in realWipeSpecs
  // above). Here we DRIVE the expanded form on real git to pin the wipe, then confirm
  // the classifier refuses the braced form under a foreign lock.
  write(nested, 'A-uncommitted-work\n');
  git(ivRepo, 'checkout', '--', '.', '.'); // the shell-expansion of `{.,.}`, run by real git
  ok(read(nested) === 'committed\n', 'BUG-281 IV#5: the brace-expansion of `{.,.}` → `git checkout -- . .` real-git WIPES A\'s work (why `{.,.}` must be whole-tree)');
  write(nested, 'A-uncommitted-work\n');
  evaluateFileLock({ toolName: 'Write', toolInput: { file_path: nested }, lockDir: ivLock, repoRoot: ivRepo, owner: A });
  const braceLocked = evaluateFileLock({ toolName: 'Bash', toolInput: { command: 'git checkout -- {.,.}' }, lockDir: ivLock, repoRoot: ivRepo, owner: B });
  ok(!braceLocked.allow && braceLocked.busy && braceLocked.tree === true && braceLocked.holder?.owner === A, 'BUG-281 IV#5 POST: `git checkout -- {.,.}` DENIED whole-tree under A\'s lock, names A');

  /* ── IV r4 finding (anthropic run e44274b0, BROKEN) — EXTGLOB patterns. The
   * tokenizer splits on `(`/`)`, so `git checkout -- !(x)` / `+(s)rc` kept only the
   * leading `!`/`+` as a narrow key while bash (extglob on) expands the pattern
   * tree-wide and real git wiped. isSimpleLine now rejects `(`/`)`, so the line is
   * non-simple and the whole-tree net classifies it. */
  const extglobAttacks = [
    ['git checkout -- !(x)', 'negated extglob (everything but x) — pre: narrow:["!"]'],
    ['git restore !(keep)', 'negated extglob on restore'],
    ['git checkout -- +(s)rc', 'one-or-more extglob — pre: narrow:["+"]'],
    ['git checkout -- @(src)', 'exactly-one extglob'],
    ['git checkout -- *(src)', 'zero-or-more extglob'],
    ['git checkout -- ?(src)', 'zero-or-one extglob'],
  ];
  for (const [cmd, why] of extglobAttacks) ok(scanBashMutation(cmd).tree === true, `BUG-281 IV#6: \`${cmd}\` → whole-tree (${why})`);
  ok(isSimpleLine('git checkout -- !(x)') === false, 'BUG-281 IV#6 predicate: a `(`/`)` (subshell/extglob) makes the line NON-simple');
  ok(isSimpleLine('git checkout -- src/a.js') === true, 'BUG-281 IV#6 guard: a plain line with no parens stays simple');
  // REAL-git end-to-end: the extglob wipe is DENIED under A's lock.
  write(nested, 'A-uncommitted-work\n');
  evaluateFileLock({ toolName: 'Write', toolInput: { file_path: nested }, lockDir: ivLock, repoRoot: ivRepo, owner: A });
  const extg = evaluateFileLock({ toolName: 'Bash', toolInput: { command: 'git checkout -- !(nothere)' }, lockDir: ivLock, repoRoot: ivRepo, owner: B });
  ok(!extg.allow && extg.busy && extg.tree === true && extg.holder?.owner === A, 'BUG-281 IV#6 POST: `git checkout -- !(nothere)` DENIED whole-tree under A\'s lock, names A');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
