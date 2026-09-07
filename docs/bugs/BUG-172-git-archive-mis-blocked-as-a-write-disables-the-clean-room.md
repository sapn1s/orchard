# BUG-172 — the git-write backstop mis-classifies `git archive` as a write, silently disabling the entire clean-room verifier

- **Status:** IN-PROGRESS
- **Severity:** high
- **Area:** server (git-write policy) / verification tooling
- **Reported:** 2026-09-07 by orchestrator (found while verifying FEAT-139)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.
  This is a SAFETY backstop and the harm class is **false proof** (WA §N): the
  tool the repo trusts to answer "was this verified?" could not run at all, so
  it warrants the highest care. Fixer ≠ verifier: an independent clean-room pass
  is warranted (deny-by-default git classification is exactly the kind of thing
  that must not be verified by the hand that changed it).

## Symptom
Every independent verification in the repo was dead. Running the sanctioned
clean-room verifier failed before it verified anything:

    independent-verify: could not export <tree> into a clean room:
    orchard: git write refused at the invocation layer: `git archive`.
    ... (FEAT-135 backstop refusal) ...
    tar: This does not look like a tar archive

`scripts/independent-verify.mjs` exports the tree under test with
`git archive <rev> | tar -x`. The FEAT-135 git-invocation shim (and the sibling
FEAT-108 Bash-command hook, which share one classifier) refused `git archive` as
a git WRITE, so the export produced no tarball, `tar` got an empty stream, and
NO dispatch could verify itself. WA §I ("generation must not verify itself")
could not be honoured at all — a false-proof failure: the record would say a
verification was attempted when the verifier physically cannot run.

## Repro
    node scripts/independent-verify.mjs --requirement @<req> --working-tree \
      --provider openai --author-provider anthropic --timeout-min 30
Pre-fix classifier proof (no scratch server needed):

    offenderForGit(['git','archive','HEAD'])            === 'git archive'  (should be null)
    decideGitShim(['archive','HEAD'], {}).allow          === false          (should be true)

## Expected
`git archive` is a pure READ in every form — it reads a tree and emits a tarball
to stdout (or, with `--output`, to a filesystem path). It mutates no ref, object,
index, working tree, config or history, so the backstop must allow it while
still refusing real writes (add/commit/stash/checkout/reset/push/…).

## Root cause
Deny-by-default. `scripts/lib/git-write-policy.mjs` classifies as a WRITE
everything not on the closed `GIT_READONLY` allowlist. `archive` was simply
**absent** from that list — not on any deliberate denylist — so deny-by-default
caught it as a false positive. The design (closed read-set, everything else
denied) is correct and intentional (FEAT-108); the defect is one missing read
verb, and there was no test asserting that the git reads the repo's OWN tooling
depends on are actually allowed.

## Fix (unstaged)
- `scripts/lib/git-write-policy.mjs` — added `'archive'` to `GIT_READONLY`, with
  a comment recording the deliberate scope decision:
  - **All forms of `git archive` are allowed, including `git archive --output=<path>`.**
    `--output` writes a tarball to a FILESYSTEM path — an ordinary file write the
    agent already has through every other channel — not a repo mutation, and it
    cannot carry anything into git history, which is the only leak vector this
    backstop guards. A stdout-only predicate would add a special-case dual-read
    for zero safety gain, so `archive` is an unconditional read.
- One edit fixes BOTH layers: the FEAT-108 Bash-command hook (`decideGitWrite` /
  `scanForGitWrite`) and the FEAT-135 invocation shim (`decideGitShim`) share the
  one `offenderForGit` classifier (ARCH-008 / ARCH-010: the fact is declared once
  by its owner). No second edit was needed or made.

## Context pack
- Files/functions: `scripts/lib/git-write-policy.mjs` (`GIT_READONLY`,
  `offenderForGit`), `scripts/lib/git-shim.mjs` (`decideGitShim`),
  `scripts/independent-verify.mjs` (`git archive | tar` export ~line 361).
- Related tickets: FEAT-108 (Bash-command git-write hook), FEAT-135 (subprocess
  invocation shim), FEAT-139 (the ticket whose verification this unblocked).
- Repro test: the classifier proof below (`verify:git-write-block` covers the
  write-refusal anti-regression, 162/162 pass post-fix).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-07 — fix lane (round 1, class=fix)
- **Understood:** `git archive` was refused as a write, killing the clean-room
  export and thereby ALL independent verification repo-wide. Confirmed the
  hypothesis by reproducing the exact failure and by direct classifier probes
  BEFORE changing anything (must-FAIL proof anchored to the pre-fix classifier,
  not a moving baseline): `offenderForGit(['git','archive','HEAD'])` returned
  `'git archive'` and `decideGitShim(['archive','HEAD'],{}).allow` was `false` in
  all four forms (bare, `--format=tar`, `--output=/tmp/x.tar`, bare-tree arg).
- **Changed (unstaged):** `scripts/lib/git-write-policy.mjs` — one entry
  (`'archive'`) added to `GIT_READONLY` + a scope-decision comment.
- **Verified (fixer run — necessary, not sufficient):**
  - Post-fix classifier: all four `archive` forms → `offender=null`,
    `shim.allow=true`. PASS.
  - Anti-regression, real writes STILL refused through the SAME path (both
    `offenderForGit` and `decideGitShim`): add, commit, stash, `stash push`,
    checkout, `reset --hard`, push, `branch foo`, `tag -a`, rm, mv, `clean -fd`,
    restore, and an unknown `archive-foo` verb — 14/14 still `allow=false`. PASS.
  - FEAT-108 Bash-hook (`decideGitWrite`) on real shell strings:
    `git archive HEAD | tar …`, `git -C <repo> archive <tree> | tar …`,
    `git archive --output=… HEAD`, `sh -c 'git archive HEAD'` all ALLOWED;
    `git commit`, `git add .`, `sh -c 'git commit …'`, `node -e … && git push`,
    `git stash` all REFUSED. 9/9 PASS.
  - `node scripts/verify-feat-108-git-write-block.mjs` → PASS, 162 passed / 0
    failed / 1 skipped (git inventory: 124 writes deny, 45 reads allow, 11
    dual-mode); 5/5 documented evasion gaps still open, as intended.
  - END-TO-END through the LIVE ambient shim on this agent's PATH (the real
    failure path): a node subprocess calling `git archive HEAD` returned
    24,125,440 bytes (works); the same subprocess calling `git stash` was refused
    with the shim message. This is the user's reality — the clean-room export runs
    `git archive` from a node subprocess, which the Bash hook cannot see and the
    PATH shim decides; the shim spawns a fresh node that re-imports the policy, so
    it reflects the fix live even though the running harness's cached FEAT-108
    hook does not (that layer only governs git typed into an agent's Bash-tool
    string and updates on the next harness start — deliberately not restarted).
  - `scripts/independent-verify.mjs --working-tree` now gets PAST the export:
    tree exported, node_modules reflink-copied (567 ms), dispatch STARTED — the
    step that was previously impossible. (The dispatch then hit the OpenAI usage
    limit; that is FEAT-139's verification story, not this fix's — see below.)
  - `verify-feat-135-git-shim.mjs` could NOT be run in this environment: its
    fixture setup runs a real `git init`, which this agent session's ambient
    FEAT-135 shim correctly refuses, so the suite aborts at setup before reaching
    any assertion. This is an environmental limitation of running that suite
    inside an already-shimmed agent session, NOT a regression from this change
    (the change touches only the read-set; `git init` classification is
    unchanged). Flagged for the independent verifier to run in a clean env.
- **Verified-by:** PENDING — independent clean-room verify warranted (safety
  backstop, deny-by-default classification, false-proof harm class; fixer ≠
  verifier). Attack to run: assert the policy allows every git READ verb the
  repo's own scripts actually invoke, and that the full deny set (write verbs +
  unknown/future subcommands) is unchanged.
- **Still open / handoff:** none blocking Task 1. The independent verifier should
  run `verify-feat-135-git-shim.mjs` in a shim-free environment (it cannot run
  inside a dispatched agent session).
- **Symptom of a deeper design flaw?** Partial-yes, not filing an ARCH. The
  deny-by-default read-allowlist is the correct, deliberate design (FEAT-108) —
  the flaw is not architectural. The real gap is that the allowlist was never
  cross-checked against the git READS the repo's OWN tooling depends on, so a
  single missing verb silently disabled a critical tool with a false-proof
  failure mode (the tool that reports "verified" could not run). The durable
  guard is a coverage test enumerating every git subcommand invoked by
  `scripts/**` and asserting each is allowed by the policy — a check, not a
  re-architecture, so it belongs on this class of ticket rather than an ARCH.
