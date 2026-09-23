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
 *   - A subprocess that invokes git by ABSOLUTE PATH or with a scrubbed env
 *     escapes PATH resolution and the shim (documented gap, unchanged).
 *
 * ── BUG-173: the shim now consults the SAME grant authority as the hook ───────
 * The shim used to honour ONLY the launch-time env hatch ORCHARD_ALLOW_GIT_WRITE,
 * so a duration/once grant the user minted AFTER a session launched was invisible
 * to it — the exact bug BUG-173. A grant lives ONLY in the host server process's
 * memory (git-grant-store.mjs); a subprocess cannot read that memory, and a file
 * or env COPY would be a SECOND place that can diverge from the authority
 * (ARCH-010) and, worse, could keep honouring a REVOKED grant (fail-open). So the
 * shim asks the host at CALL TIME over loopback (`/api/git-shim/decide`), which
 * runs the SAME `evaluateGitWrite` the hook runs (peekGrant + leak gate + single-
 * use consume). Reads never touch the network (cheap hot path); only a classified
 * WRITE consults the host, and it FAILS CLOSED on ANY failure — no grant key or
 * host URL baked, host unreachable, timeout, non-200, malformed body, or a body
 * without an explicit allow:true. Worst-case staleness is ZERO: the host computes
 * live grant state per call, so an expired/revoked grant re-blocks on the very
 * next git invocation with no relaunch. Grant scope is per-PROJECT (matching the
 * FEAT-108 hook, the pre-existing single grant authority — see the BUG-173 round-3
 * decision): a different session inside the SAME granted project is allowed by
 * design; a grant for a DIFFERENT project never unblocks this call.
 *
 * ── BUG-173 round 3: trust no longer rests on agent-writable env ──────────────
 * Round 2 read the host URL + grant key from env vars the agent can set, so an
 * agent could redirect the consult to an allow-all look-alike host it stands up
 * (self-grant, bypassing the leak gate) or open every write with a child-set
 * ORCHARD_ALLOW_GIT_WRITE. Round 3: (a) the host URL, grant key and a host-minted
 * per-process SECRET (git-shim-secret.mjs) are BAKED INTO THE GENERATED SHIM
 * SOURCE, not the env; (b) the decide route REQUIRES that secret; (c) the
 * installed shim IGNORES the child env hatch. Redirecting now requires rewriting
 * the shim file — the same determined-adversarial filesystem-tamper class as
 * prepending PATH or calling git by absolute path, already documented out of
 * scope and unclosable between two processes of the same uid.
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
export function decideGitShim(argv, env = process.env, { ignoreEnvHatch = false } = {}) {
  // BUG-173 round 3 — the INSTALLED shim passes `ignoreEnvHatch: true`. The
  // launch-time hatch ORCHARD_ALLOW_GIT_WRITE is a HOST-side control: the runtime
  // installs the shim ONLY when the host block is ON (gitWriteBlockEnabled() over
  // the HOST env), so an installed shim honouring a SUBPROCESS-set hatch would let
  // an agent `ORCHARD_ALLOW_GIT_WRITE=1 git commit` in a child open every write —
  // a trivial env bypass. The installed shim therefore ignores the child env hatch
  // and routes every classified write through the host authority. The pure local
  // classifier keeps the hatch check (default) for its unit callers.
  if (!ignoreEnvHatch && !gitWriteBlockEnabled(env)) return { allow: true, sanctioned: false };
  const offender = offenderForGit(['git', ...argv]); // reuse the ONE classifier
  if (!offender) return { allow: true, sanctioned: false };
  const sub = offender.startsWith('git ') ? offender.slice(4) : offender;
  if (SANCTIONED_PLUMBING.has(sub) && isTempIndex(env)) {
    return { allow: true, sanctioned: true };
  }
  // Deny-by-default LOCALLY. `consultHost` says a runtime grant COULD lift this —
  // the async resolver asks the host authority (BUG-173). Callers that cannot do
  // an async host call (the unit tests) still see a correct deny.
  return { allow: false, reason: offender, consultHost: true };
}

/**
 * Bounded — the shim is on the hot path of every git write; it must never hang.
 * BUT the budget must exceed the host-side work the consult TRIGGERS: for a
 * PUBLISHING subcommand (commit/push) `/api/git-shim/decide` runs the full leak
 * gate over the repo (runLeakGateForRepo), measured at ~2.5s. The original 2000ms
 * was SHORTER than that, so every granted commit/push aborted client-side and
 * fail-closed to a generic refusal while the host had already recorded it
 * "permitted/gate=pass" — commit/push could NEVER pass the shim (BUG-173 residual,
 * 2026-09-23). 15000ms leaves ample headroom over the gate; a genuinely hung host
 * still denies at the bound.
 */
export const HOST_GRANT_TIMEOUT_MS = 15000;

/**
 * Ask the HOST grant authority whether a runtime grant permits this classified
 * write, at CALL TIME. FAILS CLOSED (returns { allow:false }) on ANY failure:
 * missing grant-key / host-URL env, no fetch, unreachable host, timeout, non-200,
 * unparseable body, or a body without an explicit `allow === true`. The host runs
 * the SAME `evaluateGitWrite` the FEAT-108 hook runs, so there is ONE grant
 * authority (ARCH-010) and the two layers cannot disagree.
 */
export async function askHostGrant(argv, env = process.env, { fetchImpl = globalThis.fetch, timeoutMs = HOST_GRANT_TIMEOUT_MS, hostUrl, grantKey, shimAuth } = {}) {
  // BUG-173 round 3 — the host coordinates come from the shim's BAKED source
  // (passed in via opts), NOT from agent-writable env vars. An agent can no longer
  // redirect the shim to a look-alike host by exporting ORCHARD_GIT_SHIM_HOST. The
  // `shimAuth` credential authenticates this caller to the decide route
  // (git-shim-secret.mjs). Missing any of the three → fail closed, no network call.
  if (!hostUrl || !grantKey || !shimAuth || typeof fetchImpl !== 'function') return { allow: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${hostUrl.replace(/\/+$/, '')}/api/git-shim/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grantKey, argv, sessionLabel: env.ORCHARD_SESSION ?? null, shimAuth }),
      signal: controller.signal,
    });
    if (!res || res.status !== 200) return { allow: false };
    const body = await res.json();
    if (body && body.allow === true) return { allow: true, granted: true };
    return { allow: false, reason: typeof body?.reason === 'string' ? body.reason : undefined };
  } catch {
    return { allow: false }; // fail closed on abort/network/parse
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The shim's full CALL-TIME decision: the local classification, then — only for a
 * classified write — the host grant consult. This is what the shim executable
 * awaits. Kept separate from `decideGitShim` so the pure local classifier stays
 * synchronously testable.
 */
export async function resolveGitShim(argv, env = process.env, opts = {}) {
  // The installed shim ignores the child-forgeable env hatch (BUG-173 round 3);
  // callers may override with ignoreEnvHatch:false to test the pure classifier.
  const local = decideGitShim(argv, env, { ignoreEnvHatch: opts.ignoreEnvHatch !== false });
  if (local.allow || !local.consultHost) return local;
  const host = await askHostGrant(argv, env, opts);
  if (host.allow) return { allow: true, granted: true };
  return { allow: false, reason: host.reason ?? local.reason };
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

function shimSource(realGit, { hostUrl, grantKey, shimAuth } = {}) {
  // A tiny node executable named `git`. It defers all logic to runGitShim so the
  // decision stays in ONE place (this module). realGit is an ABSOLUTE path, so
  // the allowed path execs the true binary and never re-enters the shim.
  // An extensionless node script is parsed as CommonJS, so use dynamic import()
  // (valid in both CJS and ESM) to reach this ESM module.
  //
  // BUG-173 round 3 — the host coordinates (URL, project grant key, host secret)
  // are BAKED HERE, not read from env, so an agent cannot redirect the call-time
  // grant consult to a look-alike host by exporting an env var.
  return [
    '#!/usr/bin/env node',
    `import(${JSON.stringify(SELF)})`,
    `  .then((m) => m.runGitShim(process.argv.slice(2), ${JSON.stringify({ realGit, hostUrl, grantKey, shimAuth })}))`,
    "  .catch((e) => { process.stderr.write('orchard git-shim: ' + (e && e.message) + '\\n'); process.exit(1); });",
    '',
  ].join('\n');
}

/**
 * Called BY the generated shim executable. Decides; on allow, execs the real git
 * inheriting stdio and exits with its status; on deny, prints the refusal and
 * exits non-zero WITHOUT touching git.
 */
export async function runGitShim(argv, { realGit, hostUrl, grantKey, shimAuth } = {}) {
  const d = await resolveGitShim(argv, process.env, { hostUrl, grantKey, shimAuth, ignoreEnvHatch: true });
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
 * @param {{ baseDir?: string, grantKey?: string, hostUrl?: string, sessionLabel?: string, shimAuth?: string }} [opts]
 *   baseDir for the shim dir (default os.tmpdir()); grantKey + hostUrl + shimAuth
 *   let the shim consult the host grant authority at call time (BUG-173). They are
 *   BAKED INTO THE GENERATED SHIM SOURCE, not put on the session env, so an agent
 *   cannot redirect the consult by exporting an env var (round 3). WITHOUT them a
 *   classified write fails closed with no network call.
 * @returns {{ env: Record<string,string>, shimDir: string, realGit: string }}
 */
export function installGitShim(env = process.env, { baseDir, grantKey, hostUrl, sessionLabel, shimAuth } = {}) {
  const realGit = resolveRealGit(env);
  const prior = env.ORCHARD_GIT_SHIM_DIR;
  if (prior) { try { fs.rmSync(prior, { recursive: true, force: true }); } catch { /* ignore */ } }
  const dir = fs.mkdtempSync(path.join(baseDir ?? os.tmpdir(), 'orchard-git-shim-'));
  const shimPath = path.join(dir, 'git');
  // BUG-173 round 3 — bake the grant authority coordinates INTO the shim source,
  // NOT onto the session env. The agent controls its own env trivially (a forged
  // ORCHARD_GIT_SHIM_HOST would redirect the consult to an allow-all look-alike
  // host); the baked source removes that env trust. Overriding the baked coords
  // now requires rewriting the shim file itself — the same determined-adversarial
  // filesystem-tamper class as prepending PATH, already documented out of scope.
  fs.writeFileSync(shimPath, shimSource(realGit, { hostUrl, grantKey, shimAuth }), { mode: 0o755 });
  const existing = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((p) => p && p !== prior);
  const newEnv = { ...env, PATH: [dir, ...existing].join(path.delimiter), ORCHARD_GIT_SHIM_DIR: dir };
  if (sessionLabel && !newEnv.ORCHARD_SESSION) newEnv.ORCHARD_SESSION = sessionLabel;
  return { env: newEnv, shimDir: dir, realGit };
}
