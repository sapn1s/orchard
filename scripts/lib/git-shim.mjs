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
 * runs the SAME decision layer the hook runs (git-grant.mjs: claimGrant/settleClaim +
 * leak gate; BUG-231: a write inside a hook-decided Bash call REDEEMS that decision). Reads never touch the network (cheap hot path); only a classified
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
import { resolveWriteTarget } from './git-target.mjs';

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
  // BUG-240 — the old test was a prefix check on path.resolve(), which (a) accepted a
  // temp-dir SYMLINK to a real repo's index (git's lockfile writes THROUGH it), (b)
  // accepted a repo living under tmp with its own index, and (c) resolved a RELATIVE
  // value against the shim's cwd while git resolves it after `-C`. Now: absolute only;
  // the parent dir realpath'd inside realpath(tmpdir); the leaf absent or a regular
  // file (never a symlink); and no directory between tmp and the leaf that is a git
  // dir. Any error → false (refused), so the snapshot plumbing fails closed.
  if (!gif || !path.isAbsolute(gif)) return false;
  let tmp, dir;
  try {
    tmp = fs.realpathSync(os.tmpdir());
    dir = fs.realpathSync(path.dirname(gif));
  } catch { return false; }
  if (dir !== tmp && !dir.startsWith(tmp + path.sep)) return false;
  try {
    if (!fs.lstatSync(path.join(dir, path.basename(gif))).isFile()) return false;
  } catch (e) {
    if (!e || e.code !== 'ENOENT') return false;
  }
  for (let d = dir; d !== tmp && d.startsWith(tmp + path.sep); d = path.dirname(d)) {
    if (path.basename(d) === '.git') return false;
    const has = (n) => fs.existsSync(path.join(d, n));
    if (has('HEAD') && (has('objects') || has('commondir') || has('gitdir'))) return false;
  }
  return true;
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
export async function askHostGrant(argv, env = process.env, { fetchImpl = globalThis.fetch, timeoutMs = HOST_GRANT_TIMEOUT_MS, hostUrl, grantKey, shimAuth, windowKey, shimBootId, target = null } = {}) {
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
      // BUG-231 — `windowKey` (baked, per session) lets the host redeem the decision the
      // PreToolUse hook already took for this Bash call instead of deciding again.
      // BUG-242 — `shimBootId` lets the decide route tell a STALE secret (a shim
      // baked by a previous server boot, before this session's adoption re-bake
      // fired) from a genuinely foreign caller, and name the cause. It is NOT part
      // of the auth decision (the secret is), only of the refusal message.
      // FEAT-164 — `target`: what this write is aimed at, resolved by the REAL git with the
      // invocation's own globals/env (git-target resolveWriteTarget), for the host's
      // real-repo guard (release mode; push judged by destination).
      body: JSON.stringify({ grantKey, argv, sessionLabel: env.ORCHARD_SESSION ?? null, shimAuth, ...(windowKey ? { windowKey } : {}), ...(shimBootId ? { shimBootId } : {}), ...(target ? { target } : {}) }),
      signal: controller.signal,
    });
    if (!res || res.status !== 200) return { allow: false };
    const body = await res.json();
    // BUG-184 — carry the ledger record id AND its single-use capability token back
    // so the shim can CONFIRM the real git exit after it execs. The token is minted
    // per-record by the host and returned ONLY here, to this executor: it is the
    // unforgeable proof a same-uid peer cannot fabricate (round 3, attack A1). The
    // host recorded 'permitted' at decide; only this executor observes the real run.
    if (body && body.allow === true) {
      return {
        allow: true, granted: true,
        recordId: typeof body.recordId === 'string' ? body.recordId : null,
        confirmToken: typeof body.confirmToken === 'string' ? body.confirmToken : null,
        // FEAT-164 r2 — the record's project (the write's TARGET), for the confirm binding.
        projectKey: typeof body.projectKey === 'string' ? body.projectKey : null,
      };
    }
    // BUG-261 — the host classifies the refusal with a TYPED `refusalKind`
    // ('gate-failed' | 'ungranted' | 'policy' | 'error'). The shim renders by that
    // type instead of sniffing the reason's prefix, so a granted-but-gate-failed
    // refusal is no longer mistaken for an ungranted one and swallowed by the
    // generic `gitShimRefusal`. Absent (an old host, or a fail-closed deny with no
    // body) → null, and the shim falls back to the generic refusal.
    return {
      allow: false,
      reason: typeof body?.reason === 'string' ? body.reason : undefined,
      refusalKind: typeof body?.refusalKind === 'string' ? body.refusalKind : null,
    };
  } catch {
    return { allow: false }; // fail closed on abort/network/parse
  } finally {
    clearTimeout(timer);
  }
}

/**
 * BUG-184 — report the OBSERVED git exit status back to the host so the ledger
 * records what HAPPENED, not just what was decided (ARCH-010: the shim owns the
 * fact "did the write run"). Best-effort and non-blocking to the git result: a
 * failed/timed-out confirmation simply leaves the record 'permitted' (honest:
 * unknown), it never changes the exit status the user sees. Fails silently on any
 * error — a broken audit callback must never break the git call itself.
 */
export async function confirmHostExec(recordId, status, { fetchImpl = globalThis.fetch, timeoutMs = 5000, hostUrl, shimAuth, confirmToken, projectKey } = {}) {
  // The single-use capability token is REQUIRED — without it the host rejects the
  // confirm (round 3). `projectKey` binds the confirm to the record's owner.
  if (!recordId || !hostUrl || !shimAuth || !confirmToken || typeof fetchImpl !== 'function') return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(`${hostUrl.replace(/\/+$/, '')}/api/git-shim/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recordId, status: status == null ? null : Number(status), shimAuth, token: confirmToken, projectKey: projectKey ?? null }),
      signal: controller.signal,
    });
  } catch {
    /* best-effort — never break the git call over a failed confirmation */
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
  // FEAT-164 — resolve what the write is aimed at (real binary, invocation's own globals/env)
  // so the host can apply the real-repo guard. Best-effort: a failure sends a null target,
  // which the host treats by its own fail-closed rule.
  let target = null;
  if (opts.realGit) { try { target = resolveWriteTarget(argv, env, { realGit: opts.realGit }); } catch { target = null; } }
  const host = await askHostGrant(argv, env, { ...opts, target });
  if (host.allow) return { allow: true, granted: true, recordId: host.recordId ?? null, confirmToken: host.confirmToken ?? null, projectKey: host.projectKey ?? null };
  // BUG-261 — carry the host's TYPED refusalKind and the classified OFFENDER (local.reason
  // is the short `git <sub>` token, not a message) so runGitShim can render the right text
  // and pass the real offender — not the whole reason — to the generic fallback.
  return { allow: false, reason: host.reason ?? local.reason, refusalKind: host.refusalKind ?? null, offender: local.reason };
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

function shimSource(realGit, { hostUrl, grantKey, shimAuth, windowKey, shimBootId } = {}) {
  // A tiny node executable named `git`. It defers all logic to runGitShim so the
  // decision stays in ONE place (this module). realGit is an ABSOLUTE path, so
  // the allowed path execs the true binary and never re-enters the shim.
  // An extensionless node script is parsed as CommonJS, so use dynamic import()
  // (valid in both CJS and ESM) to reach this ESM module.
  //
  // BUG-173 round 3 — the host coordinates (URL, project grant key, host secret)
  // are BAKED HERE, not read from env, so an agent cannot redirect the call-time
  // grant consult to a look-alike host by exporting an env var.
  //
  // BUG-242 — `shimAuth`/`shimBootId` may be a PROVIDER FUNCTION (getShimSecret /
  // getShimBootId) so the caller re-reads the CURRENT value at the moment the file
  // is written (the secret is re-minted every server boot and a surviving session's
  // shim is re-baked at adoption). RESOLVE the literal here, BEFORE JSON.stringify:
  // a function left unresolved is silently dropped by JSON.stringify, which would
  // bake an ABSENT secret and fail every write closed with no diagnosis (review #5).
  const auth = typeof shimAuth === 'function' ? shimAuth() : shimAuth;
  const bootId = typeof shimBootId === 'function' ? shimBootId() : shimBootId;
  return [
    '#!/usr/bin/env node',
    `import(${JSON.stringify(SELF)})`,
    `  .then((m) => m.runGitShim(process.argv.slice(2), ${JSON.stringify({ realGit, hostUrl, grantKey, shimAuth: auth, ...(windowKey ? { windowKey } : {}), ...(bootId ? { shimBootId: bootId } : {}) })}))`,
    "  .catch((e) => { process.stderr.write('orchard git-shim: ' + (e && e.message) + '\\n'); process.exit(1); });",
    '',
  ].join('\n');
}

/**
 * BUG-242 review #3 — write the shim file ATOMICALLY: a temp file in the SAME dir,
 * then rename() over `git`. rename is atomic on one filesystem, so the `git` path
 * is NEVER momentarily absent. The old ensure() did rmSync(git) then writeFileSync,
 * leaving a window in which a concurrent lane's `git` resolved PAST the empty shim
 * dir to the REAL ungated binary — a window the re-bake-on-adopt path would hit on
 * the FIRST post-restart ensure() of a live multi-lane CLI (the file always differs
 * then, so it always rewrites). The temp carries 0o755 so it is executable the
 * instant it is renamed into place.
 */
function writeShimFileAtomic(shimPath, source) {
  const tmp = `${shimPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.writeFileSync(tmp, source, { mode: 0o755 });
    fs.chmodSync(tmp, 0o755); // writeFileSync mode is subject to umask; force it
    fs.renameSync(tmp, shimPath);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

/**
 * BUG-230 — is the dir something this uid did not make safely? A `git` placed in a
 * dir another uid (or group/other) can write would otherwise be first on PATH.
 * Shared by ensureGitShim and installGitShim's reuse-dir path (BUG-242) so the one
 * check gates both. Returns a reason string (unsafe) or null (safe). Throws only if
 * the dir cannot be lstat'd, which the callers handle.
 */
function unsafeShimDir(dir) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) return 'the shim path is not a directory';
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return 'the shim dir is owned by another user';
  if (process.platform !== 'win32' && (st.mode & 0o022)) return 'the shim dir is group/other-writable';
  return null;
}

/**
 * Called BY the generated shim executable. Decides; on allow, execs the real git
 * inheriting stdio and exits with its status; on deny, prints the refusal and
 * exits non-zero WITHOUT touching git.
 */
export async function runGitShim(argv, { realGit, hostUrl, grantKey, shimAuth, windowKey, shimBootId } = {}) {
  const d = await resolveGitShim(argv, process.env, { hostUrl, grantKey, shimAuth, windowKey, shimBootId, realGit, ignoreEnvHatch: true });
  if (!d.allow) {
    // BUG-261 — render by the host's TYPED refusalKind, not by sniffing the reason's
    // prefix. Only the AGENT-FACING refusals ('gate-failed' / 'ungranted' / 'policy')
    // carry a full `reason` whose decisive line leads AND ends — print those VERBATIM.
    // Every OTHER deny — the host's own fail-closed 'error' (bad/stale secret, unreadable
    // body, missing grantKey), an unknown kind, or an unclassified deny (host unreachable
    // / timeout / malformed body → no refusalKind) — renders the generic FEAT-135 refusal
    // naming the real offender, so it never silently loses the "this is a git write / leave
    // it unstaged" guidance and always names `git <sub>`. The host's specific 'error'
    // reason (e.g. the BUG-242 stale-secret retry hint) is appended as context so the
    // diagnosis is not lost.
    const AGENT_FACING = new Set(['gate-failed', 'ungranted', 'policy']);
    let msg;
    if (AGENT_FACING.has(d.refusalKind) && typeof d.reason === 'string' && d.reason) {
      msg = d.reason;
    } else {
      msg = gitShimRefusal(d.offender ?? d.reason);
      if (d.refusalKind === 'error' && typeof d.reason === 'string' && d.reason) msg += `\n\nHost said: ${d.reason}`;
    }
    process.stderr.write(msg + '\n');
    process.exit(1);
  }
  const bin = realGit || 'git';
  const r = spawnSync(bin, argv, { stdio: 'inherit', env: process.env });
  // BUG-184 — report the REAL git outcome back to the host ledger. `d.recordId` is
  // present only when the host recorded a decide-time permit (a granted write); a
  // read / sanctioned-plumbing allow has none, so no confirmation is sent. An exec
  // failure is a non-success outcome too (status 127). Best-effort: the git exit
  // status the user sees is unchanged regardless of whether the confirm lands.
  const exit = r.error ? 127 : (r.status == null ? 1 : r.status);
  if (d.recordId && d.confirmToken) await confirmHostExec(d.recordId, exit, { hostUrl, shimAuth, confirmToken: d.confirmToken, projectKey: d.projectKey ?? grantKey });
  if (r.error) { process.stderr.write(`orchard git-shim: exec failed: ${r.error.message}\n`); process.exit(127); }
  process.exit(exit);
}

/**
 * Install the shim onto a COPY of `env` and return the new env. Pure: it does
 * not mutate process.env or global PATH — the caller (the session runtime) uses
 * the returned env for the subprocess it launches, so the shim is scoped to that
 * agent session and nothing else.
 *
 * Never stacks shims: a prior shim dir named by env.ORCHARD_GIT_SHIM_DIR is
 * stripped from the RETURNED env's PATH before the new one is prepended.
 *
 * BUG-230 — OWNERSHIP. The install NEVER deletes the prior dir. A prior dir in the
 * base env is, in every real caller, a PARENT session's live shim (a scratch
 * server or an in-process `dispatch.mjs --provider openai` started from inside an
 * agent session inherits it); deleting it silently ungated the parent's
 * subprocess git for the rest of its life. Ownership is declared once, here, at
 * creation: the dir this call makes is owned by the returned handle and only that
 * handle's `ensure()` may (re)write it. Nothing in this module removes a shim dir.
 *
 * FAIL CLOSED: `ensure()` lets the owning runtime check its shim before work runs
 * (claude-runtime: every Bash tool call; codex-runtime: every turn). A missing or
 * altered shim is rewritten in place; if that is impossible or unsafe, ensure()
 * returns { ok:false } and the caller REFUSES rather than let `git` fall through
 * PATH to the real binary.
 *
 * @param {Record<string,string|undefined>} env base environment (e.g. process.env).
 * @param {{ baseDir?: string, grantKey?: string, hostUrl?: string, sessionLabel?: string, shimAuth?: string|(()=>string), windowKey?: string, shimBootId?: string|(()=>string), reuseDir?: string }} [opts]
 *   baseDir for the shim dir (default os.tmpdir()); grantKey + hostUrl + shimAuth
 *   let the shim consult the host grant authority at call time (BUG-173). They are
 *   BAKED INTO THE GENERATED SHIM SOURCE, not put on the session env, so an agent
 *   cannot redirect the consult by exporting an env var (round 3). WITHOUT them a
 *   classified write fails closed with no network call. `windowKey` (BUG-231) is the
 *   session's random binding to the hook's per-tool-call decisions, baked the same way;
 *   without it every write is decided independently (Codex).
 *
 *   BUG-242: `shimAuth`/`shimBootId` may be a PROVIDER FUNCTION (getShimSecret /
 *   getShimBootId); the file is (re)written with whatever they return AT WRITE TIME,
 *   so `ensure()` always bakes the CURRENT per-boot secret and never reverts to a
 *   stale one. `reuseDir` RE-BAKES an EXISTING shim dir in place (same dir on the
 *   surviving CLI's PATH) instead of minting a new one — used on the restart-adopt
 *   path so a session that outlived a restart gets the new secret into the dir its
 *   CLI actually resolves `git` from. All coords are recomputed by the caller and
 *   baked fresh; NOTHING is read back out of the reused file (a same-uid-writable
 *   file is not trusted as an input — review #2).
 * @returns {{ env: Record<string,string>, shimDir: string, realGit: string, ensure: () => GitShimEnsure }}
 */
export function installGitShim(env = process.env, { baseDir, grantKey, hostUrl, sessionLabel, shimAuth, windowKey, shimBootId, reuseDir } = {}) {
  const realGit = resolveRealGit(env);
  // BUG-230 — the prior dir is NOT ours: it is only dropped from this env's PATH
  // below, never deleted (see the ownership note above).
  const prior = env.ORCHARD_GIT_SHIM_DIR;
  let dir;
  if (reuseDir) {
    // BUG-242 — RE-BAKE a surviving session's existing shim dir. Validate it with
    // the same ownership check ensure() uses; recreate it if a tmp cleaner removed
    // it (closing the BUG-230 fall-through-to-real-git hole for survivors too),
    // and REFUSE an unsafe dir rather than write a `git` another uid could precede.
    dir = reuseDir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      const unsafe = unsafeShimDir(dir);
      if (unsafe) throw new Error(`git-shim: refusing to reuse an unsafe shim dir: ${unsafe} (${dir})`);
    }
  } else {
    dir = fs.mkdtempSync(path.join(baseDir ?? os.tmpdir(), 'orchard-git-shim-'));
  }
  const shimPath = path.join(dir, 'git');
  // BUG-173 round 3 — bake the grant authority coordinates INTO the shim source,
  // NOT onto the session env. The agent controls its own env trivially (a forged
  // ORCHARD_GIT_SHIM_HOST would redirect the consult to an allow-all look-alike
  // host); the baked source removes that env trust. Overriding the baked coords
  // now requires rewriting the shim file itself — the same determined-adversarial
  // filesystem-tamper class as prepending PATH, already documented out of scope.
  //
  // BUG-242 — a thunk so ensure() recomputes the source (= re-reads the current
  // secret/bootId) every call; the baked file always carries this process's live
  // secret. All coords are recomputed here, never read from a reused file.
  const bakeSource = () => shimSource(realGit, { hostUrl, grantKey, shimAuth, windowKey, shimBootId });
  writeShimFileAtomic(shimPath, bakeSource());
  const existing = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((p) => p && p !== prior && p !== dir);
  const newEnv = { ...env, PATH: [dir, ...existing].join(path.delimiter), ORCHARD_GIT_SHIM_DIR: dir };
  if (sessionLabel && !newEnv.ORCHARD_SESSION) newEnv.ORCHARD_SESSION = sessionLabel;
  return { env: newEnv, shimDir: dir, realGit, ensure: () => ensureGitShim(dir, bakeSource) };
}

/**
 * @typedef {{ ok: true, restored: boolean } | { ok: false, reason: string }} GitShimEnsure
 */

/**
 * BUG-230 — the owner's fail-closed check. Untouched when the shim file is
 * present, executable and byte-identical to what install wrote; otherwise it is
 * rewritten in place (`restored: true`). Refuses (`ok: false`) when it cannot
 * restore, or when the dir path now holds something this uid did not make safely
 * (a non-directory, a symlink, another uid's dir, a group/other-writable dir) —
 * a `git` placed there by someone else would otherwise be first on PATH.
 * Only reachable through the handle installGitShim returns (ownership).
 */
function ensureGitShim(dir, bakeSource) {
  const shimPath = path.join(dir, 'git');
  // BUG-242 — recompute the expected source EACH call so it carries this process's
  // CURRENT secret (re-minted every boot). A surviving session re-adopted after a
  // restart therefore self-heals to the new secret on the next tool call instead of
  // being reverted to the dead one. The secret is immutable within a process, so a
  // settled session recomputes the identical string and `intact()` stays true (no
  // churn-rewrite — review #6).
  const source = bakeSource();
  const intact = () => {
    try {
      // BUG-230 r2 — lstat BEFORE any read. Opening a FIFO/socket O_RDONLY blocks
      // until a writer appears, so `readFileSync` on a non-regular `git` would hang
      // ensure() forever (an openai clean-room FIFO case). Anything that is not a
      // plain regular file (FIFO, socket, device, directory, symlink) is treated as
      // NOT intact and is never read; it falls to the rewrite/refuse path below, the
      // same fail-closed outcome as every other unsafe shim-path shape.
      if (!fs.lstatSync(shimPath).isFile()) return false;
      fs.accessSync(shimPath, fs.constants.X_OK);
      return fs.readFileSync(shimPath, 'utf8') === source;
    } catch { return false; }
  };
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const unsafe = unsafeShimDir(dir);
    if (unsafe) return { ok: false, reason: `${unsafe} (${dir})` };
    if (intact()) return { ok: true, restored: false };
    // BUG-242 review #3 — ATOMIC rewrite (temp + rename), never rmSync-then-write:
    // the `git` path is never momentarily absent, so a concurrent lane's git in the
    // SAME live CLI can never resolve past an empty dir to the real binary.
    writeShimFileAtomic(shimPath, source);
    if (!intact()) return { ok: false, reason: `the shim could not be rewritten (${shimPath})` };
    return { ok: true, restored: true };
  } catch (e) {
    return { ok: false, reason: `the shim could not be checked or restored (${shimPath}): ${e && e.message}` };
  }
}

/** The refusal a runtime gives when its own shim is gone and cannot be restored. */
export function gitShimMissingRefusal(reason) {
  return [
    `orchard: this session's git shim is missing and could not be restored: ${reason}.`,
    'Refusing rather than letting `git` resolve to the real, ungated binary (BUG-230).',
    'Relaunch the session to get a fresh shim.',
  ].join('\n');
}
