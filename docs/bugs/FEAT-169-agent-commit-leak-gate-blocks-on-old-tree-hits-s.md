```orchard-ticket
{
  "id": "FEAT-169",
  "type": "feature",
  "title": "Agent-commit leak gate blocks on old tree hits; scan only outgoing content",
  "summary": "When a granted agent commits in a project repo, the leak gate scans every tracked file in the repo. Pre-existing hits already in the tree (168 in one repo, 59 in another; mostly false positives — Vault-path names, secret-shaped fixtures, placeholders, the username token in settings) block every agent commit even when the commit itself is clean.",
  "impact_if_we_wait": "Granted agents cannot commit anything in a repo with any pre-existing hit, so the whole git-grant path is effectively dead for real projects — the user hits a refusal on a clean change and has to do all commits by hand, defeating the grant feature.",
  "current_need": "The agent commit/push gate must scan only OUTGOING content: for a commit, the changed working-tree files vs HEAD plus untracked and the staged index; for a push, commits not already on any remote. Old unchanged content must stop blocking.",
  "severity": "high",
  "area": "leak-gate / git-grant / claude-runtime",
  "reported": "2026-10-06",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-10-11",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Agent commit in a repo with pre-existing tree hits on UNCHANGED files, committing a clean change, is ALLOWED (the old hits no longer block).",
    "A new secret added by the commit (working-tree or staged) is still BLOCKED.",
    "A false positive on CHANGED content can be waived by a .leakgate-allow entry with a reason; a reasonless entry is rejected (FEAT-156 — confirm).",
    "Deleting a line/file that contained a leak is never blocked (deletions carry no outgoing content).",
    "Push with no upstream / first push scans all commits not on any remote (conservative); amend/rebase, renames, binary files and empty diff handled explicitly.",
    "npm run gate for THIS public repo keeps its current full-tree strength (unchanged); the full-repo scan remains available as an explicit manual audit command."
  ],
  "code_refs": [
    {
      "path": "scripts/leak-gate.mjs",
      "note": "REPO mode scans git ls-files -co (whole tree); --staged scans the staged index diff. Needs a new changed/push-range scope."
    },
    {
      "path": "src/server/runtime/claude-runtime.ts",
      "note": "runLeakGateForRepo runs run(['--summary']) = full working-tree scan + run(['--summary','--staged']); the full working-tree scan is the culprit."
    },
    {
      "path": "scripts/lib/leak-tokens.mjs",
      "note": "parseAllowlist/.leakgate-allow already implements a per-repo allowlist with a mandatory reason, fail-closed (FEAT-156) — requirement 2 is already met; 'can't waive' was a misreport."
    },
    {
      "path": "src/server/git.ts",
      "note": "runCommitLeakGate (dashboard commit) already scans --staged only (outgoing) — the model to follow."
    }
  ],
  "related": [
    {
      "id": "FEAT-156",
      "relation": "see_also"
    },
    {
      "id": "FEAT-130",
      "relation": "see_also"
    },
    {
      "id": "FEAT-108",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": "codex-default",
      "run_id": "01a1137f-1257-76b3-b091-9041aa52ace9",
      "verdict": "broken",
      "verdict_on": "2026-10-06",
      "recorded_at": "2026-10-06T23:17:45.725Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Clean-room --working-tree openai/codex. 3 breaks ALL pre-existing, not --changed regressions: new-filename secret unscanned; .png bytes skipped by binary matcher (both repro full-tree); PUSH scans tree not history. FEAT-169 change held; suite 20/20. Two-break STOP->single-authority redesign."
    }
  ],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# FEAT-169 — Agent-commit leak gate blocks on old tree hits; scan only outgoing content

## Problem

The agent git-write guard `runLeakGateForRepo` (claude-runtime.ts) runs the leak gate TWICE over a granted commit/push: `run(['--summary'])` (REPO mode = `git ls-files -co` = every tracked + untracked-not-ignored file) AND `run(['--summary','--staged'])` (the staged index diff). The first, full-tree, scan is what trips on hits already living in the tree, so a clean commit is refused for content it does not touch. The dashboard commit path (git.ts `runCommitLeakGate`) already scans `--staged` only, so it does not have this problem; only the agent pre-exec guard adds the full-tree working-tree scan.

Why the full-tree scan was there: the pre-exec guard runs BEFORE git builds the index, so for `git add secret && git commit` nothing is staged yet and `--staged` would see an empty index — the working-tree scan catches the about-to-be-added secret. But it over-reaches: it scans EVERY tracked file, not just the files the commit would add.

## Plan (to be reviewed cross-provider before building)

1. **New `--changed` scope in leak-gate.mjs** (REPO changed mode). Enumerate only OUTGOING working-tree content: tracked files that differ from HEAD (`git diff --name-only --diff-filter=ACMRT -z HEAD`) UNION untracked-not-ignored (`git ls-files -o --exclude-standard -z`), reading content from the working tree. Deletions (D) excluded. When HEAD is unborn (first commit), fall back to the full `ls-files -co` set — on a first commit the whole tree IS outgoing, so that is correct and not a regression.
2. **New `--push-range` scope in leak-gate.mjs.** For a push, outgoing content = objects not already on any remote. Use `git rev-list --objects <local-tips> --not --remotes` to get the outgoing blobs (path + sha), scan each blob's bytes; scan each outgoing commit message (`git rev-list HEAD --not --remotes` → `git show -s --format=%B`) and the committer identity. No remote ref / first push → `--not --remotes` yields everything not on any remote (conservative, requirement 5). Renames surface the new blob; deletions carry no blob; binary scanned via scanBinary; empty range → PASS.
3. **Make `runLeakGateForRepo` offender-aware.** Thread the publishing subcommand(s) from git-grant.mjs into the gate thunk so a commit runs `--changed` + `--staged`, and a push runs `--push-range` (+ `--staged`/`--changed` for any uncommitted content a `commit && push` chain would also publish — decide with reviewer). Keep fail-closed on any scan that cannot run.
4. **Allowlist (requirement 2) already exists** — `.leakgate-allow` via FEAT-156 parseAllowlist: per-repo file read from the git index, mandatory `because:` reason (≥10 chars), fail-closed on a malformed/reasonless entry, credentials/identity never waivable. Confirm it applies on the `--changed`/`--push-range` paths; do not rebuild. The 'can't waive' lane report is refuted. (Identity tokens like the username are deliberately non-waivable; requirement 1 fixes those cases by not scanning unchanged old files at all.)
5. **Full-tree scan stays** as `npm run gate` (this repo, `--summary` no `--staged`) and as an explicit manual audit command for a target repo; TREE mode (publish mirror) untouched. No weakening of Orchard's own pre-publish gate.

## Edge cases to handle

- no upstream / first push of a new branch → scan all commits not reachable from any remote ref;
- amend/rebase rewriting history → push-range via `--not --remotes` covers rewritten commits not yet on the remote;
- renames → new path/blob scanned, old path is a deletion (skipped);
- binary files → scanBinary (KEY/PEM/assignment shapes), as today;
- deletions → never block (no outgoing blob / excluded by diff-filter);
- empty diff / empty push range → PASS.

## Decision: added-lines vs whole-changed-file

Scan WHOLE CHANGED FILES (not just added lines). Rationale: a secret split across an unchanged context line and an added line would be missed by an added-lines diff; whole-changed-file closes that. The old-hit re-block risk that whole-file normally carries does NOT apply here because we only ever scan files the commit actually CHANGES — an unchanged old-hit file is never in the set. To be confirmed with the reviewer.

## Restart question

Determine whether `runLeakGateForRepo` / the gate is exec'd fresh per commit (subprocess of scripts/leak-gate.mjs) or loaded into the live server — report whether a change takes effect without a service restart.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-06 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-07 — plan+review+build (lane)

**Hypothesis confirmed.** The agent git-write guard `runLeakGateForRepo` (claude-runtime.ts) ran the FULL working-tree REPO scan `run(['--summary'])` (= `git ls-files -z -co` = every tracked + untracked-not-ignored file) in addition to `run(['--summary','--staged'])`. The full working-tree scan is what tripped on hits already living in the tree. The dashboard commit path (git.ts `runCommitLeakGate`) already scanned `--staged` only, so it never had the bug — only the agent pre-exec guard added the full working-tree scan.

**Requirement 2 (allowlist) was already met — lane "can't waive" report REFUTED.** `.leakgate-allow` (FEAT-156, scripts/lib/leak-tokens.mjs `parseAllowlist`) is a per-repo file read from the git index, each entry requiring `because:` (≥10 chars), fail-closed on a malformed/reasonless entry (exit 2), credentials/identity never waivable. It already applies in every REPO mode. Rebuilt nothing; added tests (C1-C3) proving it works on the new `--changed` scope. (Identity tokens like the username are deliberately non-waivable; requirement 1 fixes those cases by not scanning unchanged old files at all.)

**Cross-provider plan review — OpenAI (dispatch-client, run 01a11363-80f9-7ee3-9b75-b0744e9af708).** It attacked the PUSH-RANGE half of the plan hard and changed the design:
- Findings 1-3 (all rated critical): precise push-range via `git rev-list --not --remotes` is DESTINATION-BLIND. Pushing to a different remote (`git push public private/main:main`), stale/repointed remote-tracking refs, and non-HEAD refspecs (`git push origin release:main`) each produce a FALSE-EMPTY range → the push publishes a secret while the gate returns a clean PASS. A half-correct `--push-range` would REGRESS push safety vs today's (over-scanning) behaviour.
- Finding 4/5: a pre-exec scan cannot see a commit that does not exist yet (`commit && push`), and a clean commit gate no longer proves the pending history clean.
- Findings 6-10 (identity author field, annotated-tag messages, ref/filenames, symlink/gitlink blobs, and "fail-closed must cover semantic omissions not just process errors") — recorded as residuals/robustness requirements.

**Design decision taken in response (diverges from the ticket's push line, justified):** COMMIT narrows to the outgoing delta; PUSH keeps the conservative FULL-TREE scan. A push publishes the whole history/tree, so scanning all of it is the only destination-independent safe choice; false positives are waived per-repo via `.leakgate-allow`. We did NOT build the user-approved `--not --remotes` push-range, because the review showed it is unsafe. **This is the one decision the orchestrator/user may want to revisit** (the ticket approved a precise push-range; we substituted conservative-full for safety). Finding 10 drove the fail-closed `--changed` enumeration: an unborn HEAD is distinguished from a rev-parse ERROR by checking stderr (a real error aborts with exit 2 rather than silently narrowing to the whole tree).

**Changed files (unstaged):**
- `scripts/leak-gate.mjs` — new `--changed` scope (REPO changed-vs-HEAD: `git diff --name-only --diff-filter=ACMRT -z HEAD` ∪ `git ls-files -o --exclude-standard -z`, read from the working tree; deletions excluded; unborn HEAD → full `ls-files -co`; fail-closed on git error). Mode banner + FAIL-footer hint updated.
- `src/server/runtime/claude-runtime.ts` — `runLeakGateForRepo(repoPath, scope)`: `scope.narrow` → working-tree pass is `--summary --changed`; else `--summary` (full). `--staged` pass unchanged in both.
- `scripts/lib/git-grant.mjs` — computes `gateScope = { narrow: needsGate && every gating sub === 'commit' }` (commit→narrow, push/unknown/alias→full) in `evaluateGitWrite` and `redeemGitWrite`; `safeGate(run, scope)` forwards it.
- `scripts/lib/git-grant.d.mts` — `runLeakGate` type now `(scope?) => …`.
- `src/server/index.ts` — git-shim decide thunk forwards `scope`.
- `scripts/verify-feat-169-outgoing-scope.mjs` — new (synthetic, said so).

**Verification.** `node scripts/verify-feat-169-outgoing-scope.mjs` → 20/20 (A0 must-FAIL: full-tree FAILS on old hits + clean change; A1 same; A2 `--changed` PASSES clean change; A3/A4 new secret in new/modified file FAILS; A5 deletion PASSES; A6 stage-then-clean bypass still FAILS via `--staged`; A7 empty diff PASSES; A8a/b rename; B1/B2 unborn HEAD; C1-C3 allowlist+reasonless-reject; D1-D4 scope decision commit→narrow / push→full). `--real` → 24/24 incl. E1-E3 on a READ-ONLY clone of the real project repo: full-tree FAILS (reproduces the reported block), `--changed`+`--staged` PASS a clean change, `--changed` FAILS when the change adds a secret. The real repo was NEVER written (git clone reads the source).
Anti-regression (all PASS): FEAT-108 git-grant 64, BUG-231 one-decision 50, BUG-173 28, BUG-184 28, FEAT-164 single-authority 31, FEAT-156 73, FEAT-130 171, gatekeeper 31. (The leak-gate suites need the real `git` on PATH — the session's FEAT-135 git-write shim blocks scratch-repo `git init`; re-run with the shim dir stripped from PATH. Not a regression.)
Leak gate (`node .orchard/leak-gate.mjs --summary`, unpiped): PASS, 0 hits. **`npm run gate` currently FAILS typecheck on ONE unrelated error — `src/server/jsonl.ts(116,66)` — which is a CONCURRENT lane's in-progress edit (`BUG-???` placeholder, held under a FEAT-129 file lock by another session), NOT this change. All files this change touches typecheck clean.**

**Restart question (answered).** The leak-gate SCRIPT is re-exec'd fresh per commit (`execFileSync(process.execPath, [scripts/leak-gate.mjs, …])`), so the `--changed` mode is live on disk immediately. But the HOST wiring that SELECTS the scope — `git-grant.mjs` (`gateScope`), `runLeakGateForRepo`, and the index.ts/claude-runtime.ts thunks — is loaded into the live server process at boot and is NOT re-read per request. **A server restart is required for the narrow scope to engage for running sessions.** Did NOT restart (charter).

**Residuals / for the independent verifier (this is a security + regression-prone change — a clean-room verify pass is warranted, `scripts/independent-verify.mjs`):**
- PUSH still over-blocks on old hits (full-tree) by design; remedy is `.leakgate-allow`. The precise push-range the ticket approved is deliberately NOT built (review findings 1-3). Orchestrator decision.
- Whole-changed-file scanning (review finding 8): editing a file that ALREADY contains a token elsewhere re-blocks on that token even if the edit is clean; `.leakgate-allow` is the remedy, except for non-waivable identity tokens. Accepted trade (chosen over added-lines, which misses split secrets).
- The agent pre-exec guard does not scan the commit MESSAGE or committer/author identity (it cannot know the message pre-exec); the dashboard commit path does via `--identity`/`--commit-msg`. Author-field scanning (finding 6) is a pre-existing gap, not widened here.
- Symlink (mode 120000) blob targets are not content-scanned in `--changed` (working-tree lstat skips non-regular files) — same as `--staged`. Edge residual.

### 2026-10-07 — round 2, plan+review (lane): destination-aware PUSH scan — HYPOTHESIS REFUTED, STOPPED, did NOT build

**Verdict: refuted. No code written.** The round-2 charter hypothesis was that push scope can be made destination-aware (not full-tree) without parsing the shell command line, using git's own pre-push contract (pre-push hook stdin `<local ref> <local sha> <remote ref> <remote sha>`, or `git push --dry-run --porcelain` + live `git ls-remote`), falling back to full-tree when ambiguous. The charter's explicit stop condition — "If the hypothesis is wrong (git can't supply a trustworthy destination state), STOP and report rather than building" — is met.

**Empirical "verify FIRST" (local bare repos, real git 2.55, `/tmp/f169*.sh`).** The cooperative-case mechanics all WORK: `--dry-run --porcelain` reports `old..new` for fast-forwards and `[new branch]`/`[new tag]`/`[deleted]` otherwise; live `ls-remote` ignores stale tracking refs; `rev-list --objects <tips> --not <ls-remote shas>` surfaces a NON-TIP secret commit, blob+path, and the annotated-tag object; force/--all/--mirror/URL/insteadOf all enumerate; unreachable remote → exit 128 (fail closed). The pre-push hook delivers exact full shas and is destination-aware by construction. So the primitive exists FOR A COOPERATIVE AGENT. It is not trustworthy against the agent that controls its own process, which is the gate's threat surface (per FEAT-135/BUG-173 the shim hardens against a determined agent, documenting only PATH/`git()`-function/absolute-path tamper as out of scope).

**Cross-provider adversarial review — OpenAI (dispatch-client, provider openai, run 01a11377-fee6-7a82-9ebc-4d6c3267b37a, git 2.55.0). It REJECTED the design** charged to find a leak reaching the remote unscanned, and found paths that are NOT the accepted residual — "the paths above mostly let the shim run and obtain the wrong PASS." Four were then reproduced here against real git (`/tmp/f169verify-review.sh`), all CONFIRMED:

- **#3 CRITICAL — the planning step itself leaks (decisive).** `git push --dry-run` EXECUTES the repo's pre-push hook (reproduced: the hook ran under `--dry-run --porcelain`). A Git-LFS (or any) pre-push hook uploads payloads to the remote during that run, while an object scan sees only LFS POINTER blobs. So a host-side planning dry-run would CAUSE an upload the current full-tree scan never risks — a regression that turns the gate into a leak vector on an ordinary LFS repo.
- **#2 CRITICAL — the host cannot know the real destination (decisive).** `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*` env (also `GIT_DIR`, the agent's cwd, writable config) silently changes where/what `git push` resolves. Reproduced with IDENTICAL argv: host (no env) resolves origin→private (`[up to date]`, empty outgoing → PASS) while the agent (env set) resolves origin→public (`[new branch]`, secret leaks). The exact argv the shim forwards does not convey the agent's resolution context, so any host-side recomputation is destination-blind in a new way and returns a wrong PASS.
- **#1 CRITICAL — multiple `remote.<r>.pushurl` = multiple destinations.** Reproduced: `--porcelain` emits one `To <url>` section per destination. Taking the first under-scans the rest (secret already on the private dest → excluded → empty scan → PASS; real push also publishes to the empty public dest).
- **#4 HIGH — `git replace` makes scanned bytes ≠ transmitted bytes.** Reproduced: `cat-file blob B` returns the benign replacement while `--no-replace-objects cat-file blob B` returns the secret; the pack transfer sends the original. An object scan without `--no-replace-objects` is blind.
- **#5 HIGH — local-ref TOCTOU.** A concurrent `update-ref refs/heads/main S A` between the host's scan of A and the shim's real push publishes the unscanned descendant S. Immune only inside the actual push (a pre-push hook), not in any host-side plan-then-push.
- Also: #6 `--quiet` suppresses porcelain update records (false-empty parser attack); #7 a file NAMED with a token has an empty blob — the token lives only in the TREE entry/filename, never seen by a content-only blob scan (reproduced); annotated-tag `tag <name>` header and custom commit headers likewise; #8 a secret-NAMED destination ref (`push HEAD:refs/tags/<token>`) or a `-o <token>` push option leaks with ZERO outgoing objects.
- **False-BLOCK regressions:** `ls-remote` advertising an unrelated remote tip absent locally makes `rev-list --not <unknown-sha>` fatal → fail closed → a correct push wrongly blocked; host vs agent credential/SSH/context divergence; the 15s shim decision budget + extra network latency of dry-run+ls-remote.

**Why the in-process pre-push hook (Option A) does NOT rescue it either.** It is destination-aware and TOCTOU-free (git hands it the real resolved refs), but the agent — which controls its own argv and env — bypasses it with `--no-verify` (reproduced earlier: the hook is SKIPPED) or by redirecting `core.hooksPath`/`GIT_CONFIG_*`; and it still shares the #1 (multi-pushurl), #4 (replace), #7 (tree/header/refname) and LFS-payload misses. Forcing the hook (shim denylisting `--no-verify`, `-c core.hooksPath`, env) is exactly the "text parser over shell/argv" anti-pattern ARCH-021 warns against, now at the argv/env layer.

**Decision needed from the user/orchestrator (this is why the lane stopped, not a build).** The conservative FULL-TREE push scan that round 1 kept is strictly SAFER than any destination-aware narrowing against #1/#2/#3/#4: it scans the whole worktree regardless of destination, reads real LFS payloads (not pointers), is immune to `replace`, and runs no dry-run/hook. The narrowing would REGRESS push safety. The autonomy goal (agents pushing without 168/59 benign old hits blocking) is better met WITHOUT narrowing the scan — by `.leakgate-allow` curating the benign old hits (already the FEAT-156 remedy; identity tokens stay non-waivable), optionally with a helper that emits a reviewable draft allowlist from a repo's current hits for the user to approve. That keeps the destination-independent full-tree gate AND unblocks pushes, opening none of the 8 paths. RECOMMENDATION: do not build the destination-aware push scan; pursue allowlist-curation tooling as a separate, scoped ticket if the user wants it.

**ARCH-021 touch:** none — no code changed; no widening of the git-write argv/shell parser. (Noted here that forcing a pre-push hook WOULD have required widening it, which is a reason not to.)

**No restart needed (nothing changed). No git writes. Files: none modified; throwaway experiments under /tmp/f169*.sh (synthetic, local bare repos, identity t@t) are not part of the repo.** This is a security / data-loss-adjacent decision reached by generation+cross-provider review; an independent clean-room pass is NOT warranted because nothing was built — but the four confirmed reproductions above are the evidence of record.

### 2026-10-06 — dispatch openai
- **Verification recorded:** dispatch openai/codex-default run 01a1137f-1257-76b3-b091-9041aa52ace9 — VERDICT: BROKEN — Clean-room --working-tree openai/codex. 3 breaks ALL pre-existing, not --changed regressions: new-filename secret unscanned; .png bytes skipped by binary matcher (both repro full-tree); PUSH scans tree not history. FEAT-169 change held; suite 20/20. Two-break STOP->single-authority redesign.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-06 — FEAT-169 verifying lane
- **Accepted on own scope; three breaks handed to ARCH-023:** User decision 2026-10-07: FEAT-169 is ACCEPTED on its own scope. The clean-room verifier confirmed the --changed commit scope picks the correct outgoing file set and falls back to a full scan on every command it cannot classify; the fixer's suite passed 20/20. The BROKEN verdict (run 01a1137f-1257-76b3-b091-9041aa52ace9) comes from three gate blind spots that PRE-DATE FEAT-169 and each reproduces the same way under a full-tree scan: (a) a secret in a file name or path is never scanned; (b) secret bytes in .png/binary blobs are skipped; (c) the push scan covers the tree and index but not the objects a push transmits, so a secret committed then removed still publishes. These are NOT regressions of the --changed scope. They move to the new ARCH-023 (push gate scans the working tree, not the objects a push transmits), which carries the violated invariant, the verifier's two-break STOP, options with trade-offs, a migration path and a proof bar per WA section N, plus the round-2 destination-set constraint (run 01a11377-fee6-7a82-9ebc-4d6c3267b37a: the host cannot trust its own computation of what the destination already has). No new verification verdict is recorded here and no HOLDS is written: no verifier run produced one.

### 2026-10-11 — board closeout (WA §J audit)
- **Note:** 2026-10-11 closed under the WA §J change (Done no longer waits on commit); evidence: explicit user acceptance 2026-10-07 on own scope (log entry '2026-10-06 — FEAT-169 verifying lane'; 3 out-of-scope breaks moved to ARCH-023). Needs service restart to be live.
