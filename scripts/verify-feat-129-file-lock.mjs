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
}

/* ───────────────────────────────────────── 8. hatch */
section('8. escape hatch');
ok(fileLockEnabled({}) === true, 'lock ON by default');
ok(fileLockEnabled({ ORCHARD_ALLOW_FILE_CLOBBER: '1' }) === false, 'hatch disables the lock');
ok(evaluateFileLock({ toolName: 'Write', toolInput: { file_path: '/x' }, lockDir: '/tmp/nope', owner: 'a', env: { ORCHARD_ALLOW_FILE_CLOBBER: '1' } }).allow, 'hatch open → every mutation allowed');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
