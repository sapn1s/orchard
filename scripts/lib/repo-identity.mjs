/**
 * FEAT-164 option A, grant binding (coordinator ruling after verify f8f4bf80) — the REPO
 * IDENTITY a git-write grant is given for.
 *
 * A grant used to attach to things an agent can change: the project id (timed grants) and
 * the row's hostPath (the standing grant's seal). Repointing the path, by an ungated PATCH,
 * a registry edit or a symlink swap, carried a live grant onto another repo. Now every grant
 * records, at grant time, the identity of the repo it was given for:
 *   { toplevel: realpath of the work-tree toplevel (or of the dir, if it is not a repo),
 *     commonDir: realpath of git's common dir (null for a non-repo dir) }
 * and the guard honours it only while the project's CURRENT path resolves to that same
 * identity. Any change, whether path, symlink target, re-init or moved .git, voids it by
 * construction. Unresolvable = null, and null never matches anything (fail closed).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseRemote } from './remote-url.mjs';

function cleanGitEnv() {
  const env = { ...process.env };
  // An EMPTY value still counts as set for git; drop every repo-redirecting variable.
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_CEILING_DIRECTORIES']) delete env[k];
  return env;
}

function revParse(dir, flag, git) {
  try {
    const r = spawnSync(git, ['-C', dir, 'rev-parse', '--path-format=absolute', flag], { encoding: 'utf8', timeout: 5000, env: cleanGitEnv() });
    const line = (r.status ?? 1) === 0 ? String(r.stdout).trim().split('\n')[0] : '';
    return line && path.isAbsolute(line) ? fs.realpathSync(line) : null;
  } catch { return null; }
}

/*
 * PERFORMANCE (FEAT-175 e2e, 2026-10-14): this is asked on hot paths (the policy reader, the container guard and
 * mount plan, every reconciler tick) for every project, and two `git rev-parse` spawns per call starved a busy
 * server's event loop (a GET took 3 s, the dashboard never loaded). So a resolved REPO identity is cached, but it
 * is RE-VALIDATED on every call without spawning: the realpath is recomputed (a symlink swap is a different key),
 * and the lstat signature (dev, inode, mtime, ctime) of every path that decides git's answer must be unchanged:
 * the dir and each dir up to the toplevel (a `.git` created inside changes its parent's mtime), `<toplevel>/.git`
 * (a gitfile rewrite or replacement) and the common dir. Any change re-runs git. Non-repo answers are not cached.
 */
const ID_CACHE_MAX = 5000;
const idCache = new Map(); // `${git}\0${real}` → { sig, id }
function statSig(p) {
  try { const s = fs.lstatSync(p); return `${s.dev}:${s.ino}:${s.mtimeMs}:${s.ctimeMs}`; } catch { return '-'; }
}
function identitySig(real, id) {
  const parts = [];
  for (let d = real; ; d = path.dirname(d)) {
    parts.push(statSig(d));
    if (d === id.toplevel || path.dirname(d) === d) break;
  }
  parts.push(statSig(path.join(id.toplevel, '.git')), statSig(id.commonDir));
  return parts.join('|');
}
/** TEST-ONLY: forget cached identities. */
export function _clearRepoIdentityCache() { idCache.clear(); }

/** The identity of the repo at `dir` NOW, or null if `dir` does not resolve (see the cache note above). */
export function repoIdentityOf(dir, { git = 'git' } = {}) {
  if (typeof dir !== 'string' || !dir) return null;
  let real;
  try { real = fs.realpathSync(dir); } catch { return null; }
  try { if (!fs.statSync(real).isDirectory()) return null; } catch { return null; }
  const key = `${git}\0${real}`;
  const hit = idCache.get(key);
  if (hit && hit.sig === identitySig(real, hit.id)) return { ...hit.id };
  const commonDir = revParse(real, '--git-common-dir', git);
  const toplevel = commonDir ? (revParse(real, '--show-toplevel', git) ?? real) : real;
  const id = { toplevel, commonDir };
  // Cache only when the signature walk from `real` reaches the toplevel (real is the toplevel or below it).
  const rel = path.relative(toplevel, real);
  if (commonDir && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..') {
    if (idCache.size >= ID_CACHE_MAX) idCache.clear();
    idCache.set(key, { sig: identitySig(real, id), id: { ...id } });
  } else idCache.delete(key);
  return id;
}

/** Do two identities name the same repo? null/malformed on either side → false. */
export function sameRepoIdentity(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (typeof a.toplevel !== 'string' || typeof b.toplevel !== 'string') return false;
  return a.toplevel === b.toplevel && (a.commonDir ?? null) === (b.commonDir ?? null);
}

/** Does a grant bound to `bound` still hold for a project whose path is `hostPath`? */
export function bindingHolds(bound, hostPath, opts) {
  return sameRepoIdentity(bound, repoIdentityOf(hostPath, opts));
}

/**
 * Are two identities the same REPOSITORY? Repos compare by git common dir only (a linked
 * worktree IS its main repo's repository); a non-repo dir compares by its realpath. Never
 * by path prefix: a repo nested inside another (a submodule, a vendored checkout, a repo in
 * a subfolder) has its own common dir and is a different repository.
 */
export function sameRepository(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ac = a.commonDir ?? null, bc = b.commonDir ?? null;
  if (ac !== null || bc !== null) return typeof ac === 'string' && ac === bc;
  return typeof a.toplevel === 'string' && a.toplevel === b.toplevel;
}

/**
 * THE GRANT DECISION (FEAT-164 single authority, coordinator ruling after verify 1659cb7f):
 * does a grant bound to `bound` (the identity recorded when the user granted) cover
 * `target`? `target` is a directory (resolved to its repo identity HERE, now) or an
 * already-resolved identity ({ commonDir } from the shim's git, or { toplevel, commonDir }).
 * Every caller that lets a git write through under a grant asks this: the shim-decide
 * guard, the release CLI, the container mount plan. null/unresolvable = false.
 */
export function grantCoversTarget(bound, target, opts) {
  const t = typeof target === 'string' ? repoIdentityOf(target, opts) : target;
  return sameRepository(bound, t);
}

/* ───────────── FEAT-164 push binding (adjudicated after verify 95027178) ───────────── */

/** The repository identities of a repo's LOCAL-path remotes (url / pushurl), read NOW. */
/**
 * A repo's remotes AS GIT RESOLVES THEM, then parsed (FEAT-164 ruling after verify 45e78a71: git resolves
 * first, then parseRemote; never compare unexpanded config strings). For every configured remote name,
 * `git remote get-url --all` (url.<base>.insteadOf applied) AND `git remote get-url --push --all`
 * (pushInsteadOf / pushurl applied), the same resolution git-target.mjs uses for the destination of a push.
 *   { network: [parseRemote keys], local: [{ path (realpath), toplevel, commonDir }] }
 * Unparseable entries are dropped (they can match nothing). Never throws.
 */
export function resolvedRemotesOf(dir, { git = 'git' } = {}) {
  const out = { network: [], local: [] };
  let real; try { real = fs.realpathSync(dir); } catch { return out; }
  const run = (args) => {
    try {
      const r = spawnSync(git, ['-C', real, ...args], { encoding: 'utf8', timeout: 5000, env: cleanGitEnv() });
      return (r.status ?? 1) === 0 ? String(r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean) : [];
    } catch { return []; }
  };
  for (const name of run(['remote'])) {
    for (const u of [...run(['remote', 'get-url', '--all', name]), ...run(['remote', 'get-url', '--push', '--all', name])]) {
      const rr = parseRemote(u, { base: real });                      // THE remote parser, after git's resolution
      if (!rr) continue;
      if (rr.kind === 'network') { if (!out.network.includes(rr.key)) out.network.push(rr.key); continue; }
      let lp; try { lp = fs.realpathSync(rr.path); } catch { continue; }
      const id = repoIdentityOf(lp, { git });
      if (id?.commonDir && !out.local.some((o) => sameRepository(o, id))) out.local.push({ path: lp, toplevel: id.toplevel, commonDir: id.commonDir });
    }
  }
  return out;
}

/**
 * The binding a grant records WHEN THE USER GRANTS: the repo's identity plus its allowed push
 * destinations at that moment, resolved by git then parsed: `remotes` (local repository identities)
 * and `networkKeys` (parseRemote keys). Destinations are read once, here, never again at decision
 * time: live git config is agent-editable, so a remote added or repointed after the grant is not
 * covered until the user re-grants. null when `dir` does not resolve.
 */
export function grantBindingOf(dir, opts) {
  const id = repoIdentityOf(dir, opts);
  if (!id) return null;
  const rr = id.commonDir ? resolvedRemotesOf(dir, opts) : { network: [], local: [] };
  return { toplevel: id.toplevel, commonDir: id.commonDir, remotes: rr.local.map((l) => ({ toplevel: l.toplevel, commonDir: l.commonDir })), networkKeys: rr.network };
}

/**
 * THE PUSH DECISION (single authority): may a grant bound to `bound` push INTO `target` (a
 * destination dir or a resolved identity)? Only into the granted repository itself or into a
 * local remote recorded at grant time. Never by path prefix, never by live config.
 */
/** May a grant bound to `bound` push to the NETWORK destination with this parseRemote key? Only a key recorded at grant time. */
export function grantCoversNetworkPush(bound, key) {
  return typeof key === 'string' && !!key && Array.isArray(bound?.networkKeys) && bound.networkKeys.includes(key);
}

export function grantCoversPush(bound, target, opts) {
  const t = typeof target === 'string' ? repoIdentityOf(target, opts) : target;
  if (!t || !t.commonDir) return false;
  if (sameRepository(bound, t)) return true;
  return Array.isArray(bound?.remotes) && bound.remotes.some((r) => sameRepository(r, t));
}
