/**
 * tree-snapshot.mjs — snapshot the CURRENT working tree into a dangling commit
 * WITHOUT touching the real repo state (FEAT-134). Single definition (ARCH-008):
 * both `verify-fix-loop.mjs` and `independent-verify.mjs` use this one helper.
 *
 * The mechanism, specified exactly (originally FEAT-062 review finding #6): a
 * temporary `GIT_INDEX_FILE` + `read-tree HEAD` + `add -A` + `write-tree` +
 * `commit-tree -p HEAD`. Consequences that are load-bearing:
 *
 *   - Untracked-but-not-ignored files are INCLUDED (`git add -A` policy). This is
 *     why `git stash create` is NOT used — it DROPS untracked files
 *     (docs/bugs/FEAT-062-verify-fix-loop-roles.md:236).
 *   - `.gitignore`d files are EXCLUDED (again `git add -A` policy).
 *   - The REAL index is never touched (a throwaway index file), no branch moves,
 *     and the commit stays unreferenced (dangling / advisory bookkeeping).
 *   - The TREE sha is the id a caller uses to diff/compare — but it is advisory
 *     WITHIN THE RUN, not a durable cross-gc identity. A dangling tree is just as
 *     garbage-collectable as a dangling commit: `git gc --prune=now` prunes BOTH,
 *     after which a persisted tree sha fails `git cat-file` (exit 128). The claim
 *     this comment once made — that the tree "does not rot" — was false. What is
 *     actually safe is the usage: both consumers (verify-fix-loop.mjs and
 *     independent-verify.mjs) use the returned tree IMMEDIATELY, in the same run,
 *     while the objects are still freshly reachable from this process; default gc
 *     keeps unreachable objects ~2 weeks, so only an explicit `--prune=now` racing
 *     the run could bite. Do NOT persist the tree sha past the run and expect it
 *     to resolve later.
 *
 * NOTE on the FEAT-108 git-write block: that block is a Bash-TOOL PreToolUse hook
 * that scans a shell command string; it cannot see git spawned by a node
 * subprocess (scripts/lib/git-write-policy.mjs:233). This helper spawns git
 * directly from node, so the snapshot runs under agent sessions while a raw
 * `git write-tree` typed at a shell is (correctly) refused.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * @param {string} repo absolute path to the repo (worktree root or any path inside it).
 * @returns {{ head: string, tree: string, commit: string }} HEAD commit, the
 *   snapshot TREE sha (the durable id), and the dangling snapshot commit sha.
 * @throws {Error} if any git step fails (the caller decides how to surface it).
 */
export function snapshotWorkingTree(repo) {
  const idx = path.join(
    os.tmpdir(),
    `orchard-snapshot-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const env = {
    ...process.env,
    GIT_INDEX_FILE: idx,
    // commit-tree requires an identity; the commit is dangling bookkeeping, so we
    // supply a fixed one rather than depend on the user's git config being set.
    GIT_AUTHOR_NAME: 'orchard-snapshot', GIT_AUTHOR_EMAIL: 'snapshot@localhost',
    GIT_COMMITTER_NAME: 'orchard-snapshot', GIT_COMMITTER_EMAIL: 'snapshot@localhost',
  };
  const run = (...args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    if ((r.status ?? 1) !== 0) {
      try { fs.rmSync(idx, { force: true }); } catch { /* ignore */ }
      throw new Error(`snapshot: git ${args[0]} failed: ${(r.stderr || '').trim()}`);
    }
    return (r.stdout ?? '').trim();
  };
  const head = run('rev-parse', 'HEAD');
  run('read-tree', head);
  run('add', '-A');
  const tree = run('write-tree');
  const commit = run('commit-tree', tree, '-p', head, '-m', 'orchard working-tree snapshot (dangling, advisory)');
  try { fs.rmSync(idx, { force: true }); } catch { /* ignore */ }
  return { head, tree, commit };
}
