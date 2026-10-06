# BUG-228 — the git-write guard refuses `-c diff.submodule=short`, blocking all clean-room verify

- **Status:** IN-PROGRESS — fix built + self-verified; independent verification warranted (low-risk, see Activity log).
- **Severity:** medium (it blocks EVERY clean-room independent verification from any guarded agent session — the verification the Working Agreement requires before a ticket is VERIFIED)
- **Area:** agent git-write enforcement (scripts/lib/git-write-policy.mjs)
- **Reported:** 2026-10-01 by the verify lane (FEAT-160 / BUG-226 both blocked on it)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED. It edits the git-write classifier's config-key allowlist, which gates the mandatory leak gate; not docs-only.

## Symptom

`scripts/independent-verify.mjs` cannot run under the agent git-write guard. Its
round-7 hardened diff path runs `git -c core.quotePath=false -c diff.submodule=short diff …`
(GIT_CFG, ~line 1098). The guard classifies `diff.submodule` as a WRITE and refuses it at
the invocation layer ("`git -c diff.submodule` was blocked"), so no guarded agent session
could run a clean-room verification at all — it blocked FEAT-160's and BUG-226's verify
legs (see their Activity logs, 2026-10-01 BLOCKED entries).

## Repro

1. From a guarded agent session, run any clean-room verify: `node scripts/independent-verify.mjs …`.
2. Its diff invocation `git -c diff.submodule=short diff …` hits the shim / Bash hook.
3. `offendingConfigKey`/`CONFIG_KEY_ALLOWED` (git-write-policy.mjs) allowlist only
   `core.quotepath`, `color.*`, `advice.*`, so `diff.submodule` falls to deny-by-default.
   The whole verification aborts.

## Expected

`git -c diff.submodule=short diff` is allowed; command-executing keys (`core.pager`,
`diff.external`, `core.sshCommand`, `alias.*`, …) still deny.

## Root cause

An allowlist gap, not a deliberate exclusion. `diff.submodule` only selects HOW a
submodule's changes are DISPLAYED (`short | log | diff`, per git-config(1)); it executes
nothing and writes nothing — the same inert-display class as the already-allowed
`core.quotepath`. The guard's `CONFIG_KEY_ALLOWED` is a tiny fail-closed allowlist of inert
display settings, and `diff.submodule` was simply never added. Confirmed no deliberate
reason: `git log -S diff.submodule` on scripts/lib/git-write-policy.mjs is empty; the key is
referenced nowhere in the policy's history; git-config(1) documents it as display-only.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play: `scripts/lib/git-write-policy.mjs` (`CONFIG_KEY_ALLOWED` ~line
  186, `offendingConfigKey`); reused by the FEAT-135 git shim (`scripts/lib/git-shim.mjs`,
  `offenderForGit`) and the FEAT-108 Bash hook — one classifier, ARCH-010.
- Consumer that needs it: `scripts/independent-verify.mjs` GIT_CFG (~line 1098); the force
  of `diff.submodule=short` is itself BUG-186's fix (stops repo config `diff.submodule=diff`
  inlining a submodule's internal patch into the diff the verifier is shown).
- Repro test: `npm run verify:git-write-block` (section extended; synthesized must-FAIL).
- Related tickets: FEAT-108 (the git-write block), BUG-165 (`git archive` — the same
  shape: an inert read refused by omission, breaking clean-room export), BUG-186 (why the
  verifier forces `diff.submodule=short`), ARCH-021 (git-write enforcement is a shell-text
  parser — the structural root).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-01 — git-write-guard diff.submodule lane (fixing round 1)

- **Understood:** the guard refused `-c diff.submodule=short` because the key was never on
  `CONFIG_KEY_ALLOWED`; deny-by-default did the rest. Verified the exclusion is accidental,
  not deliberate (empty `git log -S diff.submodule` on the policy; git-config(1) documents
  `diff.submodule` as display-only: short/log/diff). It is the same inert-display class as
  `core.quotepath`, which is already allowed. This is the exact analogue of BUG-165 (`git
  archive` refused by omission, which broke the clean-room export).
- **Changed:** `scripts/lib/git-write-policy.mjs` — `CONFIG_KEY_ALLOWED` now allows
  `diff.submodule` RESTRICTED to its three documented inert values (`short`/`log`/`diff`);
  any other value still denies (fail-closed). Parses the `key=value` on the first `=` so the
  value can be checked. No other key widened. `scripts/verify-feat-108-git-write-block.mjs`
  — added assertions: the verifier's real diff head (`-c core.quotePath=false -c
  diff.submodule=short diff --no-ext-diff --no-textconv --name-only …`) is allowed; all
  three values allowed; an unknown value and a value-less key deny; and `core.pager`,
  `diff.external`, `core.sshCommand`, `alias.*` STILL deny. Left UNSTAGED per project rules.
- **Verified:** `npm run verify:git-write-block` → **239 passed, 0 failed, 1 skipped**
  (git inventory: 124 writes all deny, 44 reads, 12 dual-mode; 5/5 known evasion gaps still
  open). Must-FAIL proven by synthesizing the PRE-FIX allowlist (core.quotepath/color.*/
  advice.* only) and confirming all four new-allow cases were BLOCKED under it while the
  dangerous keys stayed denied — not anchored to HEAD. `npm run gate` → exit 0 (read
  directly, unpiped).
- **Takes effect when:** the Bash hook picks up the source on the service's next restart;
  the FEAT-135 git shim imports `offenderForGit` fresh per git invocation, so it applies the
  moment the file is saved (verified live: the verifier's exact diff head now classifies as a
  read, `core.pager` still as a write).
- **Still open / handoff:** independent clean-room verify warranted — this edits the
  git-write classifier that gates the leak gate (regression-prone lineage, ARCH-021). It is
  LOW-RISK: the change strictly NARROWS (adds one inert display key restricted to three
  values; deny-by-default and every command-executing key are untouched and re-asserted in
  the suite). A verifier should confirm: the three values allow and any other value / a
  value-less key deny; the command-executing keys still deny; the `--config-env` twin of
  `diff.submodule` (value is an env-var name, not short/log/diff) still denies.
- **Symptom of a deeper design flaw?** Noted for whoever closes it: this is another
  instance of the shape ARCH-021 already tracks (git-write enforcement is an open-ended
  text classifier; an inert key refused by omission is the benign twin of a dangerous key
  allowed by omission). Same class as BUG-165. No new ARCH ticket warranted.
