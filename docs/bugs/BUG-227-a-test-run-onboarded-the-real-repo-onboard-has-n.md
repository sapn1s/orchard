```orchard-ticket
{
  "id": "BUG-227",
  "type": "bug",
  "title": "A test run onboarded the real repo; onboard has no self-target guard",
  "summary": "During a suite sweep on 2026-09-30, something ran onboard against the live checkout. It created .orchard/, repointed 5 package.json scripts, and changed the .claude/settings.json Stop hook. onboard.mjs has no guard that refuses its own source repo, and onboarding suites are not provably confined to scratch targets.",
  "impact_if_we_wait": "Any test sweep can silently repoint the gate, board scripts and the Stop hook for every session in the repo. A lane that does not notice commits a broken gate or a hook pointed at files that are not tracked.",
  "current_need": "Add a self-target refusal to onboard() and its CLI, with a must-FAIL test; confine every onboarding suite to scratch targets. The culprit suite is not yet identified (both obvious suspects are clean today).",
  "severity": "high",
  "area": "onboarding / test isolation",
  "reported": "2026-10-01",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-10",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "onboard() and its CLI refuse a target resolving to their own source repo and write nothing; a must-FAIL test proves it.",
    "Every suite that calls onboard runs only against a scratch target and asserts the target is not the repo it runs from.",
    "A full suite sweep run from the real checkout leaves package.json, .claude/settings.json and the repo root unchanged."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-225",
      "relation": "see_also"
    },
    {
      "id": "FEAT-106",
      "relation": "see_also"
    },
    {
      "id": "FEAT-038",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": "codex",
      "run_id": "01a126b6-6da7-72c3-bb00-624a85d33667",
      "verdict": "broken",
      "verdict_on": "2026-10-10",
      "recorded_at": "2026-10-10T16:52:51.009Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Scoped rev HEAD..0acddf26. TWO-BREAK->design review. B1: onboard(root,{allowSelfTarget:'false'}) writes .orchard (guard !allowSelfTarget accepts any truthy). B2(diff path): bind-mount alias CLI onboards source root. Req1 HOLDS: no .orchard consumer; scratch conventions injection OK."
    },
    {
      "provider": "openai",
      "model": "codex-default",
      "run_id": "01a126ef-323e-7f00-a244-8d8b928762bb",
      "verdict": "broken",
      "verdict_on": "2026-10-10",
      "recorded_at": "2026-10-10T18:00:24.613Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Clean-room cross-provider. FALSE-REFUSAL: 2nd identity signal refuses a DISTINCT dir whose scripts/onboard.mjs hardlinks the running file (run 9f03c0119304). Break-path != 2 priors -> TWO-BREAK STOP: route to design review. Fixer test exit1 = clean-room .claude-strip artifact."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "run_id": "b13f9208-93e6-4d5e-96b6-e3b6c5a026dd",
      "verdict": "broken",
      "verdict_on": "2026-10-10",
      "recorded_at": "2026-10-10T21:13:43.723Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r4 clean-room working-tree. OpenAI quota-out->Anthropic verifier (NOT cross-provider). NEW path->TWO-BREAK design review. Write-through-hardlink: r4 accepts a cp -al copy, onboard writes pkg.json+.claude/settings.json in-place via shared inodes, corrupting real repo (adv 83ee76ee53ae)."
    },
    {
      "provider": "anthropic",
      "model": "claude-default",
      "run_id": "fd7a7f71-765a-4008-92d9-29c067a8a631",
      "verdict": "holds",
      "verdict_on": "2026-10-10",
      "recorded_at": "2026-10-10T21:51:05.379Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Independent clean-room verify (independent-verify.mjs --working-tree, snapshot tree 786beaf7f46f); OpenAI quota out so same-provider Anthropic (decorrelation reduced). Author test 46/46 run 610d59307d6f; adversarial 65/65 run 30e5f9112b9c + 24/24 run 35a0a7ee3c10. rec cleanroom-record-MjQt5z."
    }
  ],
  "verification_class": "fix",
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

# BUG-227 — A test run onboarded the real repo; onboard has no self-target guard

## What happened

On 2026-09-30 at about 17:49, the BUG-225 round-3 lane ran an anti-regression sweep from the real checkout. The sweep was `cd <repo> && node scripts/<suite>.mjs` over about 18 suites, including verify-onboard, verify-feat-106-onboard-orchard-layout and verify-ticket-schema. The REAL repo was then found ONBOARDED:
- `.orchard/` was created in the repo root.
- Five package.json scripts were repointed at `.orchard/`: `gate`, `check:nul`, `board:check`, `board:gen` and `arch:watch`.
- The `.claude/settings.json` Stop hook was repointed at `.orchard/hooks`.

The lane repaired it by hand. Evidence: BUG-225 Activity log, the "round-3 lane — Side effect found and repaired" entry. Pre-repair copies of package.json and settings.json, and the moved `.orchard/`, are kept in `~/.local/state/claude-station/scratch/bug225-r3/` (`package.json.before-repair`, `settings.json.before-repair`, `dot-orchard-removed-from-repo/`).

## Which suite did it: not yet determined

On 2026-10-01, the BUG-225 r4 lane ran `verify-onboard.mjs` (57/0) and `verify-feat-106-onboard-orchard-layout.mjs` (52/0) inside a full scratch copy of the repo, including `.git`. Neither one onboarded the copy: no `.orchard/`, and package.json and settings.json were byte-identical before and after. Both suites target mkdtemp dirs.

The suspect is a suite or an `onboard.mjs` that concurrent FEAT-106 lanes were editing at that moment. At least 9 other suites call `onboard()` or `onboard.mjs` with a computed target: check-scope, bug-118, feat-089, feat-091 response-blocks, gatekeeper, bug-146, fleet-sync, needs-you-rail and feat-076. The feat-106 suite also writes a temporary `scripts/.feat106-prechange-<pid>.mjs` into the REAL repo, to run the pinned pre-change onboard. The cause matters less than the missing guard below.

## The design gap

`scripts/onboard.mjs` has no guard that refuses to onboard the Orchard source repo itself, its own `repoRoot`. Any caller that computes a target wrongly writes into the live checkout: an empty arg resolving to cwd, a `ROOT` or `repoRoot` mix-up, or `--dir` parsing. It repoints the gate and the Stop hook that every session in that repo runs.

## Wanted

1. `onboard()` and the CLI refuse when the resolved target is the source repo. That is: target realpath equals `repoRoot` realpath, or the target's `scripts/onboard.mjs` is this file. The refusal names the path, exits nonzero, and writes nothing. If an explicit escape hatch is genuinely needed, it must be a loud named flag.
2. Every suite that onboards runs only against a scratch target (mkdtemp, or a scratch copy) and asserts it is not the repo it runs from.
3. A must-FAIL test: onboarding the source repo's own path is refused and leaves package.json, `.claude/settings.json` and the absence of `.orchard/` byte-identical.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-01 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-10 — agent (cleanup lane: removed the self-onboarded `.orchard/` artifact)
- **Scope:** this lane remediated the landed ARTIFACT (the symptom). The onboard
  self-target guard + suite confinement + must-FAIL test (the three success_criteria)
  are NOT done and the ticket stays open for them.
- **Understood / verified the hypothesis first.** At HEAD e79aada the batch commit
  tracked a 23-file `.orchard/` in the real repo and repointed 5 package.json scripts
  (`gate`, `check:nul`, `board:check`, `board:gen`, `arch:watch`) + the `.claude/settings.json`
  Stop hook into it. FEAT-106 is explicit this is wrong: "Orchard's repo has no `.orchard/`,
  so the resolver falls through … by construction" (ticket line 164; A-assertions line 208).
  Diffed every `.orchard/` file against its canonical working-tree source: all 23 BYTE-IDENTICAL
  to `scripts/…`, `scripts/lib/…`, `scripts/hooks/…` or `public/lib/…` EXCEPT `.orchard/lib/digest.js`,
  which was the STALE side of the BUG-234 drift (canonical `public/lib/digest.js` carries the
  newer `renderAssistantTextWhole` edit). So the copies owned nothing; removal loses nothing.
  The duplication was also actively harmful: `resolveConventionsFile(<repo>)` prefers
  `.orchard/CONVENTIONS.md` when present, so launch injection was serving the STALE 633-line
  `.orchard/CONVENTIONS.md` instead of the live 675-line `docs/CONVENTIONS.md` (42 lines of
  recent conventions — FEAT-166 decide, BUG-240 confined runner, BUG-244 git-readonly — were
  silently missing from injected sessions). Hypothesis confirmed; not design.
- **Changed (all UNSTAGED, user commits):**
  - Removed the repo's own `.orchard/` (moved, reversible, to
    `~/.local/state/claude-station/scratch/bug-227-backup/orchard-dir-removed{,-live}/`). Shows
    as 23 ` D` deletions + one untracked `.orchard/check-prompt-privacy.mjs` gone.
  - `package.json`: repointed `gate`, `check:nul`, `board:check`, `board:gen`, `arch:watch`
    back to `scripts/…` (their pre-batch a977e76 values). ALSO repointed `check:prompt-privacy`
    (a concurrent lane's uncommitted new entry that pointed at `.orchard/check-prompt-privacy.mjs`)
    to `scripts/check-prompt-privacy.mjs` so it does not break on the removed path — the only
    other-lane line this lane touched; flagged for the user.
  - `.claude/settings.json` (local, git-ignored): Stop hook first command repointed from
    `.orchard/hooks/response-format-gate.mjs` to `scripts/hooks/response-format-gate.mjs` (the
    literal path there is not resolved dynamically, so it would have errored every turn once
    `.orchard/` was gone).
- **MUST-FAIL baseline (before removal):** `verify-feat-091-renderer.mjs` EXIT 1 — VERDICT FAIL
  210/1, the one red check "exactly ONE grammar module exists in the tree … (via git ls-files)"
  observed both `public/lib` and `.orchard/lib/response-blocks.js`. `verify-feat-106-board-path.mjs`
  EXIT 1 — A2/A4/A5/A6/A7 FAIL, observed `<repo>/.orchard/…`.
- **Verified (after removal, real repo unless noted; real output printed to the lane log):**
  - `npm run gate` → PASS exit 0 (leak-gate, check-nul, prompt-privacy, typecheck — tsc clean,
    so nothing imported the deleted `.orchard/`), via `scripts/gate.mjs`.
  - `node scripts/verify-feat-106-board-path.mjs` → 34/34 PASS (was 1). A4 "Orchard has NO
    `.orchard/` dir" PASS; A5 injection now resolves to `docs/CONVENTIONS.md`; A6 Stop hook
    resolves to `scripts/hooks/…`.
  - `node scripts/verify-feat-091-response-blocks.mjs` → 330/0. `verify-feat-106-onboard-orchard-layout`
    52/0, `verify-onboard` 57/0, `verify-bug-146-conventions-inject` 30/30,
    `verify-feat-106-cleanup-safety` 89/0 — onboarding to scratch targets unaffected.
  - `npm run board:check` → exit 0 (OK — no drift), via `scripts/board.mjs`.
  - `verify-feat-091-renderer.mjs` "one grammar module (git ls-files)" check: cannot go green
    IN-PLACE because the deletion is UNSTAGED (lanes cannot do git writes) and the check reads
    the git index, and its filesystem-walk fallback is polluted by untracked `scratch/` copies.
    Proven green in a clean-room mirror (full working tree minus `.git`/`scratch`/`.orchard`,
    node_modules symlinked): **VERDICT PASS — 211/0**. Index-level fact is deterministic:
    `git ls-files '*response-blocks*'` = {`.orchard/lib` (pending ` D`), `public/lib`} → one entry
    once the user commits the deletion. ACTION FOR USER: committing the deletions makes the
    in-place renderer check green too.
  - `verify-bug-118-orchard-only-stop-hook.mjs` → 110/1. The one failure (C1 "child carries parent
    PATH") is PRE-EXISTING and environmental — observed PATH is `/tmp/orchard-git-shim-…` (the
    harness git-write shim), and the identical failure reproduces on pristine `git archive HEAD`
    with `.orchard/` still present. Not caused by this change.
- **Still open (BUG-227 proper):** onboard() self-target refusal + a must-FAIL test, and
  confining every onboarding suite to scratch targets. The culprit suite that onboarded the real
  repo was never identified (per the 2026-10-01 entries). This lane did NOT add the guard.
- **Independent verify warranted?** Low-risk mechanical cleanup (byte-identical copies removed,
  script paths reverted to pre-batch values), proven by the suites above; an independent pass is
  not required for the cleanup. The guard work, when done, is the part that needs one.
- **Symptom of a deeper design flaw?** Yes — FEAT-106 assumed "Orchard's repo has no `.orchard/`
  by construction", but nothing ENFORCES it: no guard in onboard refuses the source repo, and no
  gate/board:check/CI keeps the repo's own tree free of a `.orchard/` or keeps the 20 cross-copies
  in sync (`verify-feat-091-renderer`'s git-ls-files uniqueness check is a red detector, not a
  guard). This is exactly BUG-227's own success_criteria #1 (the missing guard); it does not need
  a new ARCH ticket beyond finishing BUG-227 and FEAT-106.

### 2026-10-10 — worker (fixing r2: self-target guard + must-FAIL test + suite confinement)
- **Hypothesis confirmed (verified first):** `onboard()` had NO check comparing its
  resolved target to its own `repoRoot`, so any caller with a cwd-/empty-defaulted or
  ROOT/repoRoot-mixed target would scaffold into the live checkout. Mechanism is exactly
  as the ticket states; not a different cause.
- **Built — the structural guard (by identity via realpath, not a name denylist):**
  - `scripts/onboard.mjs` — new exported `selfTargetReason(resolved)`: non-null when the
    target realpath === this tool's `repoRoot` realpath, OR the target's
    `scripts/onboard.mjs` realpath IS this very running file. `onboard()` now throws
    BEFORE any write when it is non-null (so a refusal is byte-neutral), delimited by
    `// BUG-227-GUARD-START..END`. CLI exits 1, names the path, writes nothing. Loud
    escape hatch `--allow-self-target` / `{ allowSelfTarget:true }` for the rare override.
  - `scripts/onboard.d.mts` — typed `selfTargetReason`, `allowSelfTarget`, `migrate`.
- **Suite confinement:** audited all 19 suites that call onboard — every onboard target
  already resolves to a mkdtemp/scratch dir (none to cwd/ROOT/empty). The onboard() guard
  now structurally protects every CURRENT-onboard caller. The ONLY callers that bypass it
  are the two that run a PINNED PRE-FIX onboard (predating the guard): added an explicit
  "target is a scratch dir, not the repo it runs from" assertion to each —
  `verify-feat-089-method-auto.mjs` and `verify-feat-106-onboard-orchard-layout.mjs`.
- **MUST-FAIL proof (synthesized pre-fix, NOT anchored to HEAD):** new
  `scripts/verify-bug-227-self-target-refusal.mjs` builds a reflink copy of the repo source
  tree into scratch that functions as its own checkout, then runs onboard against ITSELF —
  reproducing the 2026-09-30 incident ENTIRELY in scratch, never the real repo. It
  synthesizes the pre-fix onboard by stripping the `BUG-227-GUARD-*` markers (text, not a
  git SHA). Result **16 passed, 0 failed, exit 0**:
  - (M1-M4) PRE-FIX (guard stripped) onboards its own repo: creates `.orchard/`, repoints
    the 5 package.json scripts at `.orchard/`, rewrites the `.claude/settings.json` Stop
    hook — the exact incident, proving non-vacuity.
  - (G1-G6) FIXED refuses: exit nonzero, names the path, NO `.orchard/`, package.json +
    settings.json BYTE-IDENTICAL; the imported-function path throws against the real repo
    root too (safe — throws before any write; `git status` count unchanged 140→140).
  - (U) `selfTargetReason` identifies the repo / null for a stranger. (R) real onboard
    still onboards a legitimate scratch target normally (no over-refusal). (E)
    `--allow-self-target` lets an explicit caller through.
- **Anti-regression (real output printed to lane log):** `verify-onboard` 57/0,
  `verify-feat-106-onboard-orchard-layout` 53/0 (was 52 + new confinement check),
  `verify-feat-089-method-auto` 36/0 (was 35 + confinement), `verify-feat-106-cleanup-safety`
  89/0, `verify-fleet-sync` 24/0, `verify-check-scope` 12/12, `verify-ticket-schema` 64/0,
  `verify-bug-146-conventions-inject` 30/30, `verify-feat-106-readers` 22/0,
  `verify-feat-106-board-path` 34/0. `npm run gate` exit 0, `npm run board:check` exit 0
  (no drift). CLI smoke: `node scripts/onboard.mjs .` against the real repo → exit 1,
  refusal printed, `git status` unchanged (137→137).
- **Pre-existing failures (NOT this change — confirmed identical pre-change):**
  `verify-feat-076-wiring` 28/8 (same 8 failures against the backed-up pre-change onboard —
  browser drawer unavailable in this lane + report-path format checks, unrelated to the
  guard); `verify-bug-118` C1 (parent-PATH, documented pre-existing/environmental in the
  2026-10-10 cleanup entry above); `verify-feat-106-layout-independence` crashes on a git
  write blocked by the harness git-write shim (agent session) and does not call onboard.
- **Changed (all UNSTAGED, user commits):** `scripts/onboard.mjs`, `scripts/onboard.d.mts`,
  `scripts/verify-bug-227-self-target-refusal.mjs` (new), `scripts/verify-feat-089-method-auto.mjs`,
  `scripts/verify-feat-106-onboard-orchard-layout.mjs`. Backups in
  `~/.local/state/claude-station/scratch/bug-227-r2-backup/`.
- **Independent verify warranted?** Yes — this is a regression-prone, data-loss-adjacent
  change (it exists because a sweep silently corrupted the live repo) touching onboard.mjs,
  which has a history of this class of incident. Self-verified suite is not the last word:
  an independent clean-room pass (scripts/independent-verify.mjs or a fresh-context agent)
  on the guard + must-FAIL test is warranted before this ticket is marked verified.
- **Symptom of a deeper design flaw?** The guard now ENFORCES what FEAT-106 only assumed
  ("Orchard's repo has no `.orchard/` by construction"). Remaining gap, NOT fixed here and
  not required by BUG-227's success_criteria: nothing keeps the repo's own tree free of a
  `.orchard/` on an ongoing basis (no gate/CI assertion), and the ~20 public/lib↔scripts/lib
  cross-copies can still drift (BUG-234 class). Those belong to FEAT-106's completion, not a
  new ticket.

### 2026-10-10 — dispatch openai
- **Verification recorded:** dispatch openai/codex run 01a126b6-6da7-72c3-bb00-624a85d33667 — VERDICT: BROKEN — Scoped rev HEAD..0acddf26. TWO-BREAK->design review. B1: onboard(root,{allowSelfTarget:'false'}) writes .orchard (guard !allowSelfTarget accepts any truthy). B2(diff path): bind-mount alias CLI onboards source root. Req1 HOLDS: no .orchard consumer; scratch conventions injection OK.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-10 — dispatch fixing r3 (suite-health attribution refuted)
- **Hypothesis REFUTED:** the FEAT-033 suite-health report attributed
  `verify:feat-085-independent` (41/18), `verify:feat-085-adversarial` (G5 digest-not-at-top),
  and `verify:feat-083-adversarial` (non-leading fence / content-loss-XSS) to this ticket's
  `.orchard/` cleanup (modified `scripts/hooks/response-format-gate.mjs` + deleted
  `.orchard/lib/response-blocks.js`). That attribution is WRONG. The cleanup is NOT the cause.
- **Proven three ways.** (1) Scratch copy of the current tree with `.orchard/` fully restored
  from `~/.local/state/.../bug-227-backup/orchard-dir-removed-live/` → the three suites fail
  IDENTICALLY (same test ids: 1.10, 2.1-2.12, 3.11b/c, 3.12b, 3.14; G5; B/preceded-by-prose).
  (2) Pristine `git archive HEAD` export (zero uncommitted changes) → identical failures
  (41/18, 78/1 G5, 169/1). (3) Static: the repo's own hook lives at `scripts/hooks/` and
  resolves `importFirst(['../lib/…','../../public/lib/…'])`; `scripts/lib/` has no digest.js or
  response-blocks.js, so it ALWAYS falls back to `public/lib/` — it never resolved against
  `.orchard/lib` (only the onboarded `.orchard/hooks/` copy did, which these suites don't run).
  `public/lib/response-blocks.js` is committed & unmodified; `public/lib/digest.js`'s only
  uncommitted edit is the BUG-234 r7 render-path change, not parse.
- **True cause:** these are PRE-EXISTING COMMITTED failures — at HEAD, committed suites already
  red against committed source (parseDigest/parseResponseBlocks accept a non-leading fence;
  "digest not at top" returns ALLOW where the suite wants BLOCK). No uncommitted change is
  responsible; the `.orchard/` removal and the gate's +3 `evidence:` line do not touch this path.
- **Only uncommitted-tree delta:** `verify:feat-085-independent` is 41/19 on the live repo vs
  41/18 at HEAD. The one extra failure is 4.1b, which grades a COPY of the REAL live session
  transcript under `~/.claude/projects/<encoded-repo-root>/` (352 jsonl present). It is
  absent in any scratch export (different repoRoot → dir not found → test skipped), so it is
  environmental/data-dependent, NOT caused by the cleanup or the gate/digest edits
  (HEAD+gate+digest reproduces 41/18). 4.1b grading a concurrently-written live transcript may
  be a genuine separate issue (own ticket), but it is out of BUG-227 scope and not fixed here.
- **Action:** per charter, STOP without fixing — repointed nothing, restored no duplicate, left
  the single `public/lib` copies as-is. No files changed by this lane (investigation only).
  Scratch: `bug-227-r3` (restored-.orchard), `bug-227-head` (HEAD export).
- **Independent verify?** Low-stakes (refutation, no code change). The pre-existing
  FEAT-083/085 parse failures and the 4.1b live-transcript observation each warrant their own
  investigation/ticket, independent of this cleanup.

### 2026-10-10 — dispatch fixing r3 (non-author design review + REDESIGN of the self-target guard)

- **Role:** non-author design reviewer per WA §N after the r2 guard's TWO-BREAK
  (openai run 01a126b6, VERDICT BROKEN: B1 override truthiness, B2 bind-mount alias).
  Threat model = a test/agent ACCIDENTALLY targeting the real repo via some alias, not
  an attacker.
- **DECISION: REDESIGN** `selfTargetReason`'s identity test — compare the target
  directory's inode `(st_dev, st_ino)` to `repoRoot`'s, instead of comparing realpath
  STRINGS; plus make the override a STRICT boolean (`allowSelfTarget !== true`).
  - **Why REDESIGN wins / the others lose.** Both r2 breaks are one root cause: the r2
    guard established self-identity by comparing realpath strings, and realpath does not
    collapse a bind-mount alias. **KEEP PATCHING loses** — no additional realpath/name check
    can catch a bind mount, because the alias's realpath genuinely differs from repoRoot's;
    you would chase alias forms one at a time forever. **RESCOPE loses** — B2 is an
    accidentally-reachable path (a scratch/CI setup that bind-mounts or reflinks the repo),
    squarely inside the stated threat model, so declaring it out of scope would ship a known
    hole. Inode identity collapses EVERY accidental alias form (symlink, bind mount, relative
    path, trailing slash, `.`) into ONE comparison.
  - **Empirically verified on this machine (unprivileged):** `unshare -rm` + `mount --bind
    <repo> <alias>` → `stat` dev/ino of alias and repo are IDENTICAL while realpath DIFFERS
    (`false`). So inode identity catches exactly what realpath missed. `.git`-common-dir
    comparison was CONSIDERED and REJECTED: it would over-refuse a legitimate reflink/
    separate-worktree COPY of the repo (a valid onboarding target), a false positive the
    accidental threat model would hit.
- **Built (all UNSTAGED; user commits):**
  - `scripts/onboard.mjs` — `selfTargetReason` rewritten to inode identity (delimited by
    new `// BUG-227-SELFTARGET-REASON-START..END` markers); override hardened to
    `if (allowSelfTarget !== true)`. Reason string still names the path + repoRoot and now
    the shared inode. Guard still runs BEFORE any write (refusal is byte-neutral).
  - `scripts/onboard.d.mts` — `selfTargetReason` doc updated to the inode mechanism.
  - `scripts/verify-bug-227-self-target-refusal.mjs` — added **B1** (override: string
    `'false'` BYPASSES r2, REFUSED by r3, writes nothing to the real repo) and **B2**
    (bind-mount alias ONBOARDS under r2, REFUSED by r3, no `.orchard/`), run via
    `unshare -rm`+`mount --bind` entirely in scratch. r2 state is SYNTHESIZED by text
    (new `writeR2Guard`, reverts both edits with self-checking anchors), NOT anchored to a
    SHA. B2 self-skips (loud, not a pass) if unprivileged bind mounts are unavailable.
- **MUST-FAIL proof + results (real output to lane log):**
  `node scripts/verify-bug-227-self-target-refusal.mjs` → **24 passed, 0 failed, exit 0**,
  including B1-M/B2-M reproducing BOTH openai breaks against the synthesized r2 guard and
  B1-G/B2-G proving r3 refuses them. Anti-regression: `verify-onboard` 57/0,
  `verify-feat-106-onboard-orchard-layout` 53/0, `verify-feat-089-method-auto` 36/0.
  `npm run gate` exit 0 (leak-gate/check-nul/prompt-privacy/typecheck — tsc clean, so the
  d.mts matches). `npm run board:check` exit 0 (no drift; pre-existing advisory warnings only).
  No third break appeared while testing.
- **Backups:** `~/.local/state/claude-station/scratch/bug-227-r3-backup/` (onboard.mjs,
  onboard.d.mts, verify-bug-227-self-target-refusal.mjs — pre-r3).
- **Independent verify warranted?** YES — regression-prone, data-loss-adjacent change that has
  now broken twice; an independent clean-room pass (scripts/independent-verify.mjs or a
  fresh-context agent) on the inode guard + B1/B2 must-FAIL cases is warranted before this is
  marked verified. `regressed-from: BUG-227` (r2 guard).

### 2026-10-10 — dispatch openai
- **Verification recorded:** dispatch openai/codex-default run 01a126ef-323e-7f00-a244-8d8b928762bb — VERDICT: BROKEN — Clean-room cross-provider. FALSE-REFUSAL: 2nd identity signal refuses a DISTINCT dir whose scripts/onboard.mjs hardlinks the running file (run 9f03c0119304). Break-path != 2 priors -> TWO-BREAK STOP: route to design review. Fixer test exit1 = clean-room .claude-strip artifact.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-10 — dispatch fixing r4 (independent adjudication + fix: ONE identity check)

- **Role:** independent technical adjudicator (WA §N, second two-break → adjudication,
  not automatic restart). Wrote none of this code. Reviewed all three 2026-10-10 entries
  (r2, r3 REDESIGN) and both openai verdicts.
- **DECISION: option (1) — REMOVE the file-identity signal.** The guard's property can be
  made true by ONE check: directory identity `(st_dev, st_ino)` of the resolved target vs
  `repoRoot`. Proven by enumerating every case the second (file-identity) signal catches:
  - Target IS repoRoot, or a DIRECTORY-alias of it (empty/cwd default, ROOT/repoRoot
    mix-up, relative path, `.`, trailing slash, symlink, bind mount) → the directory inode
    is identical, so **signal 1 already fires**. Signal 2 is redundant here.
  - Target is a DISTINCT directory (own root inode) whose `scripts/onboard.mjs` merely
    hardlinks the running file (`cp -al`) → signal 1 does NOT fire, signal 2 DOES. This is
    signal 2's ONLY unique effect, and it is a **FALSE refusal**: a `cp -al` copy is a
    different directory, NOT the source repo, so it is outside the contract (refuse the
    source REPO). This is exactly the openai 01a126ef break.
  So every TRUE self-target is covered by directory identity alone; signal 2 contributed
  nothing but the false refusal.
- **Why not (2) rescope / (3) something else.** Rescope evidence was gathered and supports
  removal, not a scope carve-out: NOTHING in the repo or its tooling makes hardlink copies.
  `grep` for `cp -al`/`cp --link`/`fs.linkSync` as a tree-copy mechanism finds none — every
  `link()`/`linkSync` is atomic no-clobber publishing (file-lock, shadow-vcs, move-without-
  overwrite). The onboard tooling and BOTH verify suites copy with `cp -a --reflink=auto`
  (reflink = COW, DISTINCT inodes → writes never propagate), and the r3 redesign itself
  chose inode identity precisely to NOT over-refuse a legitimate reflink/worktree copy.
  Signal 2 was also an UNSOUND guard against the only real hazard it gestures at
  (write-through a hardlinked file corrupting the real repo): it inspects `scripts/onboard.mjs`,
  a file onboard() NEVER writes — not package.json / .claude/settings.json / .orchard, the
  files it does write. So (3) "keep a corrected file check" buys nothing the directory check
  lacks. One identity check is the whole contract.
- **Built (all UNSTAGED; user commits):**
  - `scripts/onboard.mjs` — `selfTargetReason` reduced to the single directory-inode check
    (within the existing `BUG-227-SELFTARGET-REASON-START..END` markers); file-identity
    signal removed with a comment recording why. Override still strict (`allowSelfTarget
    !== true`); guard still runs BEFORE any write (refusal byte-neutral).
  - `scripts/onboard.d.mts` — doc updated to the single-check mechanism.
  - `scripts/verify-bug-227-self-target-refusal.mjs` — new **(H)** block: must-FAIL against
    a SYNTHESIZED r3 state (new `writeR3Onboard` text-re-adds signal 2; `hardlinkOnboardTo`
    builds a DISTINCT reflink-copy dir whose only shared inode is onboard.mjs). H-M proves
    r3 FALSELY refuses that distinct copy (fires on "this very running file"); H-G proves r4
    ACCEPTS and onboards it (exit 0, `.orchard/` created) while still refusing the genuine
    self-target. All scratch, never the real repo.
- **Results (real output to lane log):** `verify-bug-227-self-target-refusal` **32 passed,
  0 failed, exit 0** (was 24; +8 for H-M0..3 / H-G0..3). Anti-regression: `verify-onboard`
  57/0, `verify-feat-106-onboard-orchard-layout` 53/0, `verify-feat-089-method-auto` 36/0.
  `npm run gate` exit 0 (leak-gate/check-nul/prompt-privacy/typecheck — tsc clean, d.mts
  matches). `npm run board:check` exit 0 (no drift; 135 pre-existing advisory warnings only).
- **Previously-untested attacks, run by this lane against SCRATCH/the real repo read-only:**
  - Bind mount (`unshare -rm` + `mount --bind`): refused via directory identity (suite B2-G).
  - Override values `1`, `{}`, `'false'`, `'0'`, `[]` passed as `allowSelfTarget` against the
    REAL repo → ALL REFUSED (strict `=== true`); `.orchard/` NOT present in the real repo
    afterward. Byte-identical-on-refusal confirmed (suite G4/G5: package.json + settings.json
    unchanged after a refusal).
- **Backups:** `~/.local/state/claude-station/scratch/bug-227-r4-backup/` (onboard.mjs,
  onboard.d.mts, verify-bug-227-self-target-refusal.mjs — pre-r4).
- **Independent verify warranted?** YES — regression-prone, data-loss-adjacent change that
  has now broken twice; an independent clean-room pass (scripts/independent-verify.mjs or a
  fresh-context agent) on the single-check guard + the H must-FAIL case is warranted before
  this is marked verified. `regressed-from: BUG-227` (r3 two-signal guard).

### 2026-10-10 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-4-8 run b13f9208-93e6-4d5e-96b6-e3b6c5a026dd — VERDICT: BROKEN — r4 clean-room working-tree. OpenAI quota-out->Anthropic verifier (NOT cross-provider). NEW path->TWO-BREAK design review. Write-through-hardlink: r4 accepts a cp -al copy, onboard writes pkg.json+.claude/settings.json in-place via shared inodes, corrupting real repo (adv 83ee76ee53ae).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-11 — dispatch fixing r5 (write-confinement chokepoint; wrote none of the earlier rounds)
- **New property (NOT self-target identity):** "onboarding target T modifies nothing
  OUTSIDE T." r4's guard is correct — it ACCEPTS a distinct `cp -al` copy (different root
  inode) — but onboard then wrote package.json + .claude/settings.json IN PLACE, and those
  files hardlink the source repo, so the in-place `writeFileSync` truncated the SHARED inode
  and corrupted the source (anthropic b13f9208, adv 83ee76ee53ae).
- **Hypothesis confirmed (verified FIRST by enumeration):** every onboard write that modifies
  an EXISTING target file was a raw in-place `fs.writeFileSync`/`appendFileSync`. Enumerated
  ALL write/copy/append/mkdir/chmod in onboard.mjs + helpers. In-place modify sites (shared-
  inode hazard): `appendWaPointer` (CLAUDE.md append), `copyOrchardFile` (resync/force-board-
  tool rewrite ×3), `installClaudeHook` (re-point/merge rewrite ×2 — the settings.json break),
  `wireNpmScripts` (re-point rewrite — the package.json break). No `copyFileSync`/`fs.cp`/
  `chmod`; `linkSync`/`renameSync` only in the `--migrate` cleanup (already rename/link-based,
  inode-conserving by its own invariant). The one remaining raw `writeFileSync` (cleanup
  `tmpStub`) writes into a fresh per-run `mkdtemp` backup dir, never a shared inode.
- **Built — ONE write chokepoint (structural, by construction):** new `atomicWriteFileSync`
  (delimited `// BUG-227-ATOMIC-WRITE-START..END`) writes to a temp file in the SAME directory
  then `rename`s it over the target. `rename(2)` replaces the directory ENTRY: it never opens
  the inode at the path and does not follow a symlink AT the path. ALL SEVEN target-write sites
  now route through it (`ensureFile`, `appendWaPointer` [read+concat+atomic, not append],
  `scaffoldRoot` CONVENTIONS, `copyOrchardFile` ×3, `installClaudeHook` ×3, `wireNpmScripts`
  ×2, `scaffoldDeployContext`). Temp+target share a dir → same-fs rename (atomic, never EXDEV).
  No new export; `onboard.d.mts` unchanged (the helper is internal). `scripts/onboard.mjs` only.
- **Symlinked target FILES — DECISION: REPLACE the link (justified).** Chosen over refuse
  because the same rename that fixes the hardlink case neutralises the symlink escape for free,
  leaves the target fully onboarded, and never clobbers user data: an EXISTING file onboard
  would MODIFY is read through `readTargetFile`, which already lstat-REFUSES a symlink (so the
  modify path skips a symlinked package.json/settings.json/CLAUDE.md entirely — proven S-G3/4);
  only a never-user-data path (a fresh create following a DANGLING output symlink) is replaced,
  and rename replaces the link in place rather than following it outside T (S-G1/2).
- **MUST-FAIL proof (synthesized PRE-r5 state by TEXT, not a SHA; all in scratch, `cp -al` of a
  SCRATCH copy, never the real repo):** `verify-bug-227-self-target-refusal.mjs` → **46 passed,
  0 failed, exit 0** (was 32; +14). New `writePrefixAtomicWrite` reverts the chokepoint body to
  a naive in-place `writeFileSync`; new `hardlinkTreeCopy` = `cp -al`.
  - (C-M0..3) PRE-r5: a distinct `cp -al` copy whose package.json+settings.json hardlink the
    (scratch) source — onboard accepts it (exit 0) and the in-place write CORRUPTS the source's
    package.json AND .claude/settings.json (write-through). Reproduces b13f9208 exactly.
  - (C-G1..4) FIXED: still accepts the distinct copy (exit 0 — a real copy is a legit target),
    source package.json + settings.json BYTE-IDENTICAL, target onboarded and its package.json
    got a NEW inode via rename (direct mechanism proof).
  - (S-M1/2) PRE-r5: a create follows a DANGLING output symlink and writes OUTSIDE T (escape).
    (S-G1/2) FIXED: nothing written outside T; the link is replaced in place by a regular file.
    (S-G3/4) FIXED: a symlinked EXISTING package.json → outside is never written through.
- **Anti-regression (real output to lane log):** `verify-onboard` 57/0,
  `verify-feat-106-onboard-orchard-layout` 53/0, `verify-feat-089-method-auto` 36/0.
  `npm run gate` exit 0 (leak-gate/check-nul/prompt-privacy/typecheck — tsc clean, so the d.mts
  still matches). `npm run board:check` exit 0 (no drift; 135 pre-existing advisory warnings).
- **HARD-STOP residual — REPORTED, NOT patched (per charter):** a symlinked ANCESTOR DIRECTORY
  of a write path whose destination exists (e.g. `T/.claude` → a dir inside the repo) still
  escapes: `rename` is confined to `file`'s PARENT, which the symlinked ancestor resolves
  outside T. Verified reproducing (and it is PRE-EXISTING — pre-r5 escapes it too, more easily).
  This is squarely the cleanup section's already-documented ADVERSARIAL threat boundary; a
  benign `cp -al`/reflink copy NEVER produces a symlinked `.claude`/`.orchard` pointing into the
  repo. Per the charter HARD STOP ("if the confinement property breaks a second way during your
  attacks, don't patch it — report it") I stopped here. Closing it needs openat/O_NOFOLLOW
  dir-handle walking (the cleanup section's `safeRemovable`-class machinery) Node does not
  expose cheaply; a decision on whether to build it for the write path is for the orchestrator.
- **Changed (all UNSTAGED, user commits):** `scripts/onboard.mjs`,
  `scripts/verify-bug-227-self-target-refusal.mjs`. Backups in
  `~/.local/state/claude-station/scratch/bug-227-r5-backup/`.
- **Independent verify warranted?** YES — data-loss-adjacent, regression-prone (now broken 4×
  in onboard.mjs). An independent clean-room pass on the chokepoint + the C/S must-FAIL cases
  (and an attack on the reported symlinked-ancestor-dir residual to confirm its scope) is
  warranted before this is marked verified. `regressed-from: BUG-227` (r4 single-check guard —
  it closed the false-refusal but left the in-place write-through open).
- **Symptom of a deeper design flaw?** The r2→r5 sequence (realpath→inode→single-check→write-
  confinement) is one design question — "what does it mean to write safely into a target that
  may alias the source?" — discovered one facet per round. The chokepoint answers the write
  half structurally; the identity guard answers the target half. No new ARCH ticket beyond
  finishing BUG-227 + the orchestrator's call on the adversarial symlinked-ancestor residual.

### 2026-10-10 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-default run fd7a7f71-765a-4008-92d9-29c067a8a631 — VERDICT: HOLDS — Independent clean-room verify (independent-verify.mjs --working-tree, snapshot tree 786beaf7f46f); OpenAI quota out so same-provider Anthropic (decorrelation reduced). Author test 46/46 run 610d59307d6f; adversarial 65/65 run 30e5f9112b9c + 24/24 run 35a0a7ee3c10. rec cleanroom-record-MjQt5z.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-11 — landed in batch commit (orchestrator triage)
- Work landed in the 2026-10-11 whole-tree batch commit. Verified state unchanged; this entry records only the git landing. Full batch manifest is in the commit message.

### 2026-10-11 — agent
- **committed + follow-up:** The r2->r5 guard/chokepoint work and the HOLDS verify were committed in ed92aff. Follow-up: the standing HOLDS verdict (fd7a7f71) was a same-provider Anthropic clean-room run because OpenAI quota was out — re-verify cross-provider (OpenAI) after the Oct 14 quota reset to restore decorrelation.
