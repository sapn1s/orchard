/**
 * git-shim.mjs — FEAT-135. Close the subprocess-evasion hole in the FEAT-108
 * git-write block.
 *
 * ── THE HOLE ─────────────────────────────────────────────────────────────────
 * FEAT-108's block is a Bash-TOOL PreToolUse hook that scans the command STRING
 * (scripts/lib/git-write-policy.mjs). It cannot see git spawned from INSIDE a
 * subprocess: `node -e '…execFileSync("git",["commit",…])…'`, `python -c …`, a
 * wrapper script — the command string is `node …`, so the scan never reaches the
 * `git commit`. Proven empirically: a node subprocess moved HEAD on a throwaway
 * repo while the same `git commit` typed at the shell is correctly refused.
 * That means a lane that writes a script can perform ANY git write the user
 * never authorised — commit, reset, checkout, push — the exact class of write
 * FEAT-108 exists to forbid.
 *
 * ── THE FIX: an ALLOWLIST at the git-INVOCATION layer ────────────────────────
 * A `git` shim placed EARLIER on PATH than the real git. Every process that
 * resolves `git` via PATH — bash, node, python, any language — hits the shim
 * first, regardless of how it was spawned. The shim classifies the invocation
 * with the SAME read/write logic as the hook (`offenderForGit`, one definition,
 * ARCH-008) and:
 *   - ALLOWS pure-read git (status/diff/log/rev-parse/…).
 *   - ALLOWS the sanctioned temp-index snapshot plumbing (FEAT-134
 *     `snapshotWorkingTree`): read-tree / add / write-tree / commit-tree, but
 *     ONLY when GIT_INDEX_FILE points into the OS temp dir — i.e. a throwaway
 *     index, never the repo's real one. This is exactly and only what
 *     snapshotWorkingTree does.
 *   - REFUSES everything else LOUDLY (stderr + non-zero exit), never execs real
 *     git. Deny-by-default: any write verb, any plumbing that could touch the
 *     REAL index/refs/worktree, any unknown/future subcommand.
 *
 * ── SCOPING: the user's terminal and the host stay untouched ─────────────────
 * The shim is installed ONLY onto the environment of an AGENT SESSION subprocess
 * (the env the runtime builds for the `claude` CLI it launches — see
 * `installGitShim`). It is NOT put on the host process's own PATH and NOT on the
 * user's login shell PATH, so the user's hand-typed git and the Orchard host's
 * own git bookkeeping are unaffected. The distinction stays structural, as
 * FEAT-108 intended.
 *
 * ── WHAT THIS DOES NOT COVER (stated so the guarantee is not overstated) ──────
 *   - A subprocess that invokes git by ABSOLUTE PATH (`/usr/bin/git commit`) or
 *     with a hard-coded real-git path bypasses PATH resolution and the shim.
 *   - A subprocess that sets its OWN PATH stripping the shim dir, or spawns with
 *     a scrubbed env, escapes it. (A determined, adversarial lane can; the guard
 *     is against the ordinary evasion — a script that just calls `git`.)
 *   - Non-git ways to destroy work (rm -rf, direct .git/ writes) are out of
 *     scope — this closes the git-write hole, not all destructive acts.
 *   - Runtime per-project git GRANTS (git-grant.mjs) are NOT consulted by the
 *     shim: it honours only the process-wide env hatch ORCHARD_ALLOW_GIT_WRITE.
 *     A granted dispatch's subprocess writes would be refused by the shim; the
 *     grant path today flows through the hook (shell form), not subprocesses.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { offenderForGit, gitWriteBlockEnabled } from './git-write-policy.mjs';

/**
 * Plumbing verbs the sanctioned temp-index snapshot uses. These are NOT in the
 * hook's read set (they can write objects and populate an index), so
 * `offenderForGit` flags them as writes. They are permitted by the shim ONLY
 * under the temp-index guard below — never against the real index.
 */
export const SANCTIONED_PLUMBING = new Set(['read-tree', 'add', 'write-tree', 'commit-tree']);

/**
 * TRUE only when GIT_INDEX_FILE is set to a path inside the OS temp directory —
 * the throwaway index snapshotWorkingTree creates. A real-index write (plain
 * `git add`) leaves GIT_INDEX_FILE unset (→ false → refused); pointing it at the
 * repo's real .git/index would not be under tmpdir (→ false → refused).
 */
function isTempIndex(env) {
  const gif = env.GIT_INDEX_FILE;
  if (!gif) return false;
  const resolved = path.resolve(gif);
  const tmp = path.resolve(os.tmpdir());
  return resolved === tmp || resolved.startsWith(tmp + path.sep);
}

/**
 * The shim's decision for one git invocation. `argv` is git's arguments (WITHOUT
 * the `git` head). Returns `{ allow, reason?, sanctioned? }`.
 *   - env hatch open  → allow (mirror FEAT-108's ORCHARD_ALLOW_GIT_WRITE).
 *   - read / read-form → allow.
 *   - sanctioned plumbing under a temp index → allow.
 *   - anything else    → DENY (deny-by-default).
 */
export function decideGitShim(argv, env = process.env) {
  if (!gitWriteBlockEnabled(env)) return { allow: true, sanctioned: false };
  const offender = offenderForGit(['git', ...argv]); // reuse the ONE classifier
  if (!offender) return { allow: true, sanctioned: false };
  const sub = offender.startsWith('git ') ? offender.slice(4) : offender;
  if (SANCTIONED_PLUMBING.has(sub) && isTempIndex(env)) {
    return { allow: true, sanctioned: true };
  }
  return { allow: false, reason: offender };
}

/** The loud refusal a shimmed subprocess prints before exiting non-zero. */
export function gitShimRefusal(offender) {
  return [
    `orchard: git write refused at the invocation layer: \`${offender}\`.`,
    '',
    'A subprocess (node/python/script) tried to run a git WRITE. Agent sessions do',
    'NOT write git — no commit, add, reset, checkout, stash, push, branch/tag edits.',
    'The user does ALL git by hand; an agent commit that leaked a private path has',
    'cost a full rewrite of main more than once. This backstop (FEAT-135) catches',
    'writes the Bash-command hook (FEAT-108) cannot see because they are spawned',
    'from inside a subprocess.',
    '',
    'Leave your changes UNSTAGED in the working tree and report the file list in your',
    'final message for the user to commit. Read-only git still works.',
  ].join('\n');
}

/**
 * Resolve the REAL git absolute path, excluding any shim dir. Runs at install
 * time (before the shim is on PATH) so `which git` returns the true binary; also
 * strips a previously-installed shim dir from PATH so re-install never resolves
 * the shim as "real git" (which would recurse forever).
 */
function resolveRealGit(env) {
  const priorShim = env.ORCHARD_GIT_SHIM_DIR;
  const cleanPath = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((p) => p && p !== priorShim)
    .join(path.delimiter);
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, ['git'], { encoding: 'utf8', env: { ...env, PATH: cleanPath } });
  const line = (r.stdout ?? '').split('\n').map((s) => s.trim()).find(Boolean);
  if (!line) throw new Error('git-shim: cannot resolve the real git binary on PATH');
  return line;
}

/** Absolute path to THIS module, baked into the generated shim's import. */
const SELF = fileURLToPath(import.meta.url);

function shimSource(realGit) {
  // A tiny node executable named `git`. It defers all logic to runGitShim so the
  // decision stays in ONE place (this module). realGit is an ABSOLUTE path, so
  // the allowed path execs the true binary and never re-enters the shim.
  // An extensionless node script is parsed as CommonJS, so use dynamic import()
  // (valid in both CJS and ESM) to reach this ESM module.
  return [
    '#!/usr/bin/env node',
    `import(${JSON.stringify(SELF)})`,
    `  .then((m) => m.runGitShim(process.argv.slice(2), ${JSON.stringify({ realGit })}))`,
    "  .catch((e) => { process.stderr.write('orchard git-shim: ' + (e && e.message) + '\\n'); process.exit(1); });",
    '',
  ].join('\n');
}

/**
 * Called BY the generated shim executable. Decides; on allow, execs the real git
 * inheriting stdio and exits with its status; on deny, prints the refusal and
 * exits non-zero WITHOUT touching git.
 */
export function runGitShim(argv, { realGit } = {}) {
  const d = decideGitShim(argv, process.env);
  if (!d.allow) {
    process.stderr.write(gitShimRefusal(d.reason) + '\n');
    process.exit(1);
  }
  const bin = realGit || 'git';
  const r = spawnSync(bin, argv, { stdio: 'inherit', env: process.env });
  if (r.error) { process.stderr.write(`orchard git-shim: exec failed: ${r.error.message}\n`); process.exit(127); }
  process.exit(r.status == null ? 1 : r.status);
}

/**
 * Install the shim onto a COPY of `env` and return the new env. Pure: it does
 * not mutate process.env or global PATH — the caller (the session runtime) uses
 * the returned env for the subprocess it launches, so the shim is scoped to that
 * agent session and nothing else.
 *
 * Idempotent: a prior shim dir is stripped from PATH before the new one is
 * prepended (and cleaned up), so repeated installs never stack shims.
 *
 * @param {Record<string,string|undefined>} env base environment (e.g. process.env).
 * @param {{ baseDir?: string }} [opts] baseDir for the shim dir (default os.tmpdir()).
 * @returns {{ env: Record<string,string>, shimDir: string, realGit: string }}
 */
export function installGitShim(env = process.env, { baseDir } = {}) {
  const realGit = resolveRealGit(env);
  const prior = env.ORCHARD_GIT_SHIM_DIR;
  if (prior) { try { fs.rmSync(prior, { recursive: true, force: true }); } catch { /* ignore */ } }
  const dir = fs.mkdtempSync(path.join(baseDir ?? os.tmpdir(), 'orchard-git-shim-'));
  const shimPath = path.join(dir, 'git');
  fs.writeFileSync(shimPath, shimSource(realGit), { mode: 0o755 });
  const existing = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((p) => p && p !== prior);
  const newEnv = { ...env, PATH: [dir, ...existing].join(path.delimiter), ORCHARD_GIT_SHIM_DIR: dir };
  return { env: newEnv, shimDir: dir, realGit };
}
