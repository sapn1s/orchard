# FEAT-135 — git writes are refused even when git is spawned from a subprocess

- **Status:** IN-PROGRESS — shim WIRED into BOTH runtimes (Claude round 2 + Codex round 3, Decision A on each) and proven ACTIVE end-to-end against a REAL codex session; the round-2 decision (b) is RESOLVED (codex path extended, not deferred). Sole remaining gate: (a) independent clean-room verify (data-loss / security class)
- **Severity:** high
- **Area:** server (runtime git-write enforcement)
- **Reported:** 2026-09-07 by dispatched lane (defect surfaced incidentally by the FEAT-134 lane)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom
The standing rule is that agents never write git — the user does all git by hand.
FEAT-108 enforces that. But the enforcement only holds for git typed as a shell
command. An agent that writes a script and runs git from inside it can commit,
reset, checkout, or push freely — the same operation that is correctly refused at
the shell. Because the tree currently holds ~8 tickets' worth of unstaged fixes,
one unauthorised `git reset --hard` / `git checkout` from a lane's script could
destroy all of it silently.

## Repro
1. FEAT-108's block is a Bash-tool PreToolUse hook that scans the command STRING
   (`scripts/lib/git-write-policy.mjs` → `decideGitWrite`).
2. At the shell, `git commit -m x` → refused (`allow:false`). Proven.
3. From a subprocess, `node -e 'require("child_process").execFileSync("git",["commit",...])'`
   → the command string is `node …`, the scan never reaches `git commit`, so the
   hook returns `allow:true`. Empirically a node subprocess moved HEAD on a
   throwaway repo. Same evasion for `python -c`, a wrapper script, any language.

## Expected
A git WRITE is refused wherever it is invoked from — shell OR subprocess — while
(a) read-only git still works, (b) the user's own terminal git is untouched, and
(c) the one sanctioned in-process consumer, FEAT-134 `snapshotWorkingTree`
(temp-index `read-tree`/`add`/`write-tree`/`commit-tree`), keeps working with the
real index and HEAD byte-unchanged.

## The fix (built): an allowlist at the git-INVOCATION layer
`scripts/lib/git-shim.mjs` installs a `git` shim earlier on PATH than the real
git. Every process that resolves `git` via PATH — bash, node, python, any
language — hits the shim first, regardless of how it was spawned. The shim
classifies the invocation with the SAME logic as the hook (`offenderForGit`, now
exported from `git-write-policy.mjs` — ONE definition, ARCH-008) and:
- ALLOWS pure-read git.
- ALLOWS the sanctioned temp-index plumbing (`read-tree`/`add`/`write-tree`/
  `commit-tree`) ONLY when `GIT_INDEX_FILE` points inside the OS temp dir — i.e.
  exactly and only what `snapshotWorkingTree` does; a real-index `git add`
  (GIT_INDEX_FILE unset) is refused.
- REFUSES everything else LOUDLY (stderr + non-zero exit), never execs real git.
  Deny-by-default: every write verb, real-index plumbing, unknown/future verbs.

`installGitShim(env)` is PURE — it returns a COPY of env with the shim dir
prepended to PATH; it does NOT mutate global/host PATH. So the shim is scoped to
the AGENT SESSION subprocess env; the Orchard host's own git and the user's login
shell are untouched (the FEAT-108 structural distinction is preserved).

### What this does NOT cover (guarantee not overstated)
- A subprocess that calls git by ABSOLUTE PATH (`/usr/bin/git commit`) bypasses
  PATH resolution and the shim (asserted in the verify suite as a known gap).
- A subprocess that scrubs its own env / strips the shim dir from PATH escapes it.
  This guards the ordinary evasion (a script that just calls `git`), not a
  determined adversary.
- Non-git destruction (`rm -rf`, direct writes into `.git/`) is out of scope.
- Runtime per-project git GRANTS (`git-grant.mjs`) are NOT consulted by the shim;
  it honours only the process-wide env hatch `ORCHARD_ALLOW_GIT_WRITE`. The grant
  path today flows through the hook (shell form), not subprocesses.

## Decision — how should the shim be ACTIVATED?
The correct wiring is to build the session subprocess env through `installGitShim`
so the shim is on the `claude` CLI's PATH. That env is assembled in
`src/server/runtime/claude-runtime.ts:578` (`env: { ...process.env, ... }`), which
is owned by a concurrent lane — this lane must not edit it. So activation is a
one-line change someone else applies:

- **A — wire at the session env (recommended).** In `claude-runtime.ts:578`, wrap
  the session env with `installGitShim(...)` (guarded by `gitWriteBlockEnabled()`).
  Scopes the shim to session subprocesses only; the host's own git and the user's
  terminal stay unshimmed. Costs one line in a concurrent lane's file; buys the
  narrowest correct blast radius.
- **B — side-effecting import that mutates the host `process.env.PATH`.** Self
  contained in the file this lane owns (no `claude-runtime.ts` edit), but it puts
  the shim on the HOST process's PATH too, so the host's own git bookkeeping and
  every node tool importing the module are also gated. Wider, spookier blast
  radius; rejected as the default for exactly that reason.

## Context pack
- Files/functions in play: `scripts/lib/git-shim.mjs` (`decideGitShim`,
  `installGitShim`, `runGitShim`, `SANCTIONED_PLUMBING`); `scripts/lib/git-write-policy.mjs`
  (`offenderForGit` now exported); `scripts/lib/tree-snapshot.mjs` (`snapshotWorkingTree`,
  read-only here); `src/server/runtime/claude-runtime.ts:578,706-742` (session env +
  the PreToolUse hook that has the hole).
- Related tickets: FEAT-108 (the command-string git-write block this extends),
  FEAT-134 (the sanctioned temp-index snapshot that must keep working), FEAT-129
  (shared-tree file lock).
- Repro / verify test: `node scripts/verify-feat-135-git-shim.mjs` (31 checks).
- Known dependencies / blockers: activation decision above; the wiring line lives
  in a concurrent lane's file.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-07 — dispatched lane (fix, round 1)
- **Understood:** FEAT-108's git-write block is a command-string scan in a Bash
  PreToolUse hook; git spawned from inside a subprocess is invisible to it, so a
  lane's script can perform any git write. One legitimate consumer
  (`snapshotWorkingTree`) already relies on the gap and must keep working.
- **Changed (unstaged):**
  - `scripts/lib/git-shim.mjs` (NEW) — the invocation-layer allowlist shim +
    `installGitShim`/`decideGitShim`/`runGitShim`.
  - `scripts/lib/git-write-policy.mjs` — exported `offenderForGit` so the shim
    reuses the ONE read/write classifier (no behaviour change to the hook).
  - `scripts/verify-feat-135-git-shim.mjs` (NEW) — the verify suite.
  - `docs/bugs/FEAT-135-*.md` (this ticket), `docs/bugs/INDEX.md` (board:gen).
- **Verified (fixer's own run):** `node scripts/verify-feat-135-git-shim.mjs` →
  `31 passed, 0 failed`.
  - must-FAIL: with NO shim, a node subprocess moved HEAD on a throwaway repo
    (evasion confirmed); the hook allows the `node -e` form while refusing the
    shell form.
  - after: with the shim on PATH, a node-subprocess `git commit` AND
    `git reset --hard` are REFUSED (non-zero exit, HEAD unchanged, loud refusal on
    stderr); `git status`/`git log` still work through the shim.
  - sanctioned: `snapshotWorkingTree` run WITH the shim on PATH against the REAL
    repo SUCCEEDS and returns a tree sha; the real `.git/index` is byte-identical
    (sha256) and HEAD unchanged before/after.
  - documented gap asserted: an absolute-path git call bypasses the shim.
  - `npm run gate` → EXIT 0.
- **Verified-by:** PENDING — independent clean-room verify warranted (this is a
  security / data-loss-class enforcement change). A verifier should attack:
  temp-index guard edge cases (GIT_INDEX_FILE pointing at the real index, or at a
  tmpdir-prefixed path that is actually the repo), shim recursion (real git
  resolved to the shim), and evasions the suite does not model.
- **Still open / handoff:** activation (Decision A) is a one-line wiring in
  `claude-runtime.ts:578` that this lane is scoped OUT of editing — the runtime
  lane / user must apply it, after which the hole is closed for session
  subprocesses. Until then the mechanism is verified but INACTIVE in live sessions.
- **Symptom of a deeper design flaw?** (answered at close) — candidate: enforcing
  a cross-cutting policy at the tool-string layer when the real boundary is the
  process/PATH layer. Note for the closer to consider an ARCH ticket if a third
  enforcement-layer mismatch appears.

### 2026-09-07 — dispatched lane (fix, round 2 — ACTIVATION)
- **Understood:** round 1 built + self-verified the shim but left it INACTIVE —
  the one-line wiring lived in a concurrent lane's file (`claude-runtime.ts`).
  That lane has landed; the file is now this lane's to wire (Decision A).
- **Hypothesis check (asked first, per charter):** "Is activation a genuine
  one-line env wrap at `claude-runtime.ts:578`, or is there a SECOND path that
  builds a session env?" Result: there are THREE session-env construction sites.
  - `ClaudeRuntime.start()` `options.env` (was line 578, now 611 after the wiring
    comment): the SDK forwards this verbatim as the child env — verified by
    reading the SDK: `spawnLocalProcess`/`spawnClaudeCodeProcess` both spawn with
    `W.env = c` where `c = options.env` (sdk.mjs). So this ONE site covers the
    DIRECT-spawn, SURVIVAL-broker (o.env → survival.ts runEnv), and RESUME paths
    (resume flows through the same `start()`), and the CONTAINER `spawnProcess`
    override (`execInContainer(..., env: o.env)`). ← COVERED by this wiring.
  - CONTAINER caveat (documented, NOT a regression): inside a container the shim
    dir is a host tmp path absent from the container FS, so the leading PATH entry
    no-ops and container-internal git resolves to the container's real git —
    NOT shimmed. Pre-existing structural boundary (the container tree is separate);
    the host-side hole this ticket names is closed.
  - `CodexRuntime.start()` builds its OWN env (`const env = { ...process.env }`,
    codex-runtime.ts:380) and carries NO FEAT-108 PreToolUse hook at all — so an
    openai/codex session is UNGUARDED for git writes at BOTH the shell and the
    subprocess layer. This is OUT of this lane's scope (owns claude-runtime.ts +
    git-shim.mjs only) and is a broader gap than FEAT-135. ← NOT covered; flagged
    for a decision (extend the block to CodexRuntime, or a separate ticket).
- **Changed (unstaged):**
  - `src/server/runtime/claude-runtime.ts` — added `import { installGitShim }`;
    build the session env via `installGitShim` guarded by `gitWriteBlockEnabled()`
    (`baseSessionEnv` → `sessionEnv`), and `env: sessionEnv` on the SDK options.
    The wiring is documented inline (scope, covered paths, container/codex caveats).
  - `scripts/lib/git-shim.d.mts` (NEW) — sidecar types for git-shim.mjs so
    `src/server/**` imports the module (not a re-decl); required for `typecheck`.
  - `scripts/verify-feat-135-active-e2e.mjs` (NEW) — the ACTIVE end-to-end proof.
- **Verified (fixer's own runs):**
  - `node scripts/verify-feat-135-git-shim.mjs` → **31 passed, 0 failed** (unit +
    decision logic + sanctioned snapshot on the REAL repo, index byte-identical).
  - `node scripts/verify-feat-135-active-e2e.mjs` → **8 passed, 0 failed**. Drives
    a REAL `ClaudeRuntime.start()` host spawn with a fake `claude` bin
    (CLAUDE_STATION_CLAUDE_BIN); the fake runs a NODE-SUBPROCESS `git commit`
    against a THROWAWAY /tmp repo under the runtime-built env. Block ON (default):
    the runtime installed the shim (ORCHARD_GIT_SHIM_DIR set, PATH head = shim
    dir), the commit was REFUSED (exit 1, loud FEAT-135 refusal on stderr),
    throwaway HEAD unchanged. must-FAIL control — hatch OPEN
    (ORCHARD_ALLOW_GIT_WRITE=1): NO shim installed, the SAME commit SUCCEEDED and
    the throwaway HEAD MOVED — proving the refusal is the shim's doing and the
    hatch still works. NO Orchard service restart was needed (fresh in-process
    runtime + fake bin).
  - `npm run gate` → **EXIT 0** (leak-gate + check-nul + typecheck).
  - `node scripts/verify-liveness-conformance.mjs` → **86/88**; the two failures
    (L2b codex-fixture precondition; L4 `isOwnerLive` regrowth-guard flag) are
    PRE-EXISTING and unrelated: baselined by temporarily reverting `env: sessionEnv`
    → `env: baseSessionEnv` and re-running → IDENTICAL 86/88 with the same two
    failures. L4's `isOwnerLive` is the sibling lane's landed FEAT-129 heartbeat
    predicate (not added here); L2b exercises `CodexRuntime`, which this change
    does not touch. (So the note in the charter — "L4 should now pass once the
    isOwnerLive work lands" — does NOT hold: L4 still flags isOwnerLive as an
    ad-hoc liveness predicate outside the authority; that is a FEAT-129 / liveness
    concern, not FEAT-135's.)
- **Verified-by:** PENDING — independent clean-room verify still warranted
  (security / data-loss class). Attack surface for the verifier: the SDK-forwards-
  options.env assumption (re-derive it, don't trust this log); the container/codex
  UNCOVERED paths above; shim-dir accumulation (each session start mkdtemps a new
  shim dir under tmpdir and does not remove it on session end — a minor resource
  leak, not a correctness bug); temp-index guard edge cases from round 1.
- **Decision for the user (why this stays 👤 / IN-PROGRESS):** the host-side hole
  is CLOSED and proven active, but the openai/codex runtime path is still fully
  unguarded and is out of this lane's file scope. Decide: (A) extend the git-write
  block + shim to `CodexRuntime` (new lane), or (B) file a follow-up ticket and
  accept the codex gap for now. Independent verification should also sign off
  before this moves to VERIFIED.

### 2026-09-07 — dispatched lane (fix, round 3 — CODEX ACTIVATION)
- **Understood:** round 2 closed the host-side hole on `ClaudeRuntime` but left
  `CodexRuntime` (openai/codex) FULLY unguarded — it builds its own session env
  (`const env = { ...process.env }`, codex-runtime.ts) and carries NO FEAT-108
  PreToolUse hook (that hook is a Claude-SDK seam), so a codex lane could commit/
  reset/checkout/push at both the shell AND subprocess layer. This round extends
  the same shim to codex.
- **Hypothesis PROVEN FIRST (not assumed), per charter:** does the REAL codex
  app-server forward its env down to the exec/shell subprocess that runs git, or
  does a restricted `shell_environment_policy` / sandbox scrub PATH (in which case
  a silently-non-installing shim is WORSE than none)? A throwaway probe put a
  marker `git` on PATH and drove a REAL codex session to run `git probe-marker`
  in BOTH `bypassPermissions` (danger-full-access) and `default` (workspace-write
  sandbox) modes. In BOTH, the marker fired — codex runs `bash -lc 'git …'` and
  the front-of-PATH shim dir SURVIVES even the login-shell PATH rebuild. Env IS
  forwarded → the shim reaches the child. (No codex hook mechanism exists to
  mirror FEAT-108's command-string hook; the PATH shim is the single enforcement
  layer for codex, and it covers both the shell and subprocess forms at once.)
- **Empirical finding (codex-specific, now asserted precisely):** codex PREPENDS
  its OWN sandbox helper dir (`…/codex-path`) to the child PATH, so the shim dir
  is NOT `PATH[0]`. It does not matter: that dir contains no `git`, so resolution
  falls through to the shim dir — the FIRST PATH entry with a `git` executable IS
  the shim dir. The e2e asserts THAT property, not `PATH[0]`.
- **Changed (unstaged):**
  - `src/server/runtime/codex-runtime.ts` — added `import { installGitShim }` +
    `import { gitWriteBlockEnabled }`; the spawned app-server env is now
    `gitWriteBlockEnabled() ? installGitShim({ ...process.env }).env : { ...process.env }`
    (mirrors claude-runtime's options.env wrap), documented inline with the proven
    forwarding + the codex/container caveats.
  - `scripts/verify-feat-135-codex-active-e2e.mjs` (NEW) — the ACTIVE proof
    against a REAL codex session (NOT a fake bin — the whole risk is real codex
    env forwarding).
- **Verified (fixer's own runs):**
  - `node scripts/verify-feat-135-codex-active-e2e.mjs` → **8 passed, 0 failed**
    against a REAL connected codex (0.153.2). Block ON: CodexRuntime installed the
    shim, it reached the exec child and WON git resolution, a NODE-SUBPROCESS
    `git commit` was REFUSED (exit 1, loud FEAT-135 refusal), throwaway HEAD
    unchanged. must-FAIL control (ORCHARD_ALLOW_GIT_WRITE=1): NO shim, the SAME
    commit SUCCEEDED and the throwaway HEAD MOVED.
  - `node scripts/verify-feat-135-git-shim.mjs` → **31 passed, 0 failed**
    (sanctioned snapshot on the REAL repo; `.git/index` byte-identical, HEAD
    unchanged — the FEAT-134 path still works).
  - `node scripts/verify-feat-135-active-e2e.mjs` (Claude) → **8 passed, 0 failed**
    (no regression to the round-2 wiring).
  - `npm run gate` → **EXIT 0** (leak-gate + check-nul + typecheck).
  - `node scripts/verify-liveness-conformance.mjs` → **86/88** — IDENTICAL to the
    round-2 baseline, same two pre-existing failures (L2b codex-fixture
    precondition; L4 `isOwnerLive` in claude-runtime.ts, a FEAT-129 concern). Both
    findings sit outside this diff (L4 is in claude-runtime.ts; L2b was already
    failing at baseline); my change touches neither.
- **What remains UNCOVERED after this round (guarantee not overstated):**
  - Container-internal git in a codex container session: the shim dir is a HOST
    tmp path absent from the container FS, so container-internal git resolves to
    the container's real git — the same pre-existing structural boundary already
    documented for the Claude runtime (the container tree is separate).
  - A subprocess that calls git by ABSOLUTE PATH (`/usr/bin/git commit`) or that
    scrubs the shim dir out of its own PATH — the same two gaps listed for the
    Claude side; this guards the ordinary evasion, not a determined adversary.
  - `config.env` is still NOT merged into the codex session env (pre-existing —
    codex ignored `config.env` before this change too); out of FEAT-135 scope,
    NOT introduced here. The shim wrap does not depend on it.
  - Shim-dir accumulation: each session start mkdtemps a shim dir under tmpdir and
    does not remove it on session end — a minor resource leak, not a correctness
    bug (unchanged from round 2, now also on the codex path).
- **Verified-by:** PENDING — independent clean-room verify still warranted
  (security / data-loss class). Attack surface for the verifier: re-derive the
  codex env-forwarding claim against a real session (don't trust this log); the
  container/absolute-path/env-scrub UNCOVERED paths above; temp-index guard edge
  cases from round 1.
- **Decision for the user:** the codex gap flagged in the round-2 decision is now
  CLOSED and proven active (Decision A applied to codex too). This lane leaves
  only the independent-verify gate before VERIFIED.
