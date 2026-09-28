/**
 * BUG-187 Step 9 — materialise a COMPLETE source tree pinned at a NAMED commit,
 * for a must-FAIL proof that cannot drift (CONVENTIONS: "a must-FAIL proof must
 * not be anchored to a moving baseline" — `HEAD` becomes the fixed state the
 * moment the fix is committed; a named commit never does).
 *
 *   const tree = materialisePinnedTree('541dd73');   // → { dir, rev, cleanup() }
 *
 * `git archive <rev> | tar -x` into a `scripts/lib/scratch.mjs` directory (it
 * is expensive — keep it off the boot-wiped /tmp), then `node_modules` is
 * reflink-copied from this checkout (same filesystem; see scratch.mjs). Read-only
 * on the repository: `git archive` writes nothing to it. The tree is a whole
 * pinned tree, never "two files swapped into a dirty tree" (review round 1,
 * point 9).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdtempScratch } from './scratch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

export function materialisePinnedTree(rev = '541dd73', { prefix = `pinned-${rev}-` } = {}) {
  /*
   * A clean room is an EXPORT, not a git checkout, so `git archive` cannot run
   * there. `BUG187_PINNED_TREE` names an already-materialised tree at this rev
   * (e.g. made once from a real checkout) — it is used as-is and never deleted.
   */
  if (process.env.BUG187_PINNED_TREE) {
    const dir = path.resolve(process.env.BUG187_PINNED_TREE);
    if (!fs.existsSync(path.join(dir, 'src', 'server', 'session-host.mjs'))) throw new Error(`pinned-tree: BUG187_PINNED_TREE=${dir} holds no src/server/session-host.mjs`);
    return { dir, rev: `${rev} (given)`, cleanup() {} };
  }
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    throw new Error(`pinned-tree: ENVIRONMENT — ${ROOT} is not a git checkout (a clean-room export?), so ${rev} cannot be archived. Set BUG187_PINNED_TREE to a tree materialised at ${rev}.`);
  }
  const full = spawnSync('git', ['-C', ROOT, 'rev-parse', '--verify', `${rev}^{commit}`], { encoding: 'utf8' });
  if (full.status !== 0) throw new Error(`pinned-tree: ${rev} is not a commit in ${ROOT}: ${full.stderr.trim()}`);
  const dir = mkdtempScratch(prefix);
  const archive = spawnSync('bash', ['-c', `git -C ${JSON.stringify(ROOT)} archive ${full.stdout.trim()} | tar -x -C ${JSON.stringify(dir)}`], { encoding: 'utf8' });
  if (archive.status !== 0) throw new Error(`pinned-tree: git archive failed: ${archive.stderr}`);
  const cp = spawnSync('cp', ['-a', '--reflink=auto', path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules')], { encoding: 'utf8' });
  if (cp.status !== 0) throw new Error(`pinned-tree: node_modules copy failed: ${cp.stderr}`);
  return {
    dir,
    rev: full.stdout.trim(),
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}
