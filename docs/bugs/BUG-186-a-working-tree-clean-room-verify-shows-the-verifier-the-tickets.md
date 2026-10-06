# BUG-186 — a working-tree clean-room verify shows the verifier the ticket's own refutations

- **Status:** OPEN
- **Severity:** high
- **Area:** verification tooling (`scripts/independent-verify.mjs`)
- **Reported:** 2026-09-24 by FEAT-152 round-4 fixing lane (from the round-3 commissioner's note)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
An independent verifier is meant to attack a change knowing only the requirement,
the change itself, the tests and how to run them. When it is run over the live
dirty tree (`--working-tree`), the change it is shown includes every uncommitted
ticket edit on the board — for the ticket under review, that is the fixer's own
reasoning and every earlier verifier's refutation. The verifier then reads the
plan and the prior attacks it is supposed to arrive at independently, so a
"clean-room" verdict is not clean, and nothing in the verdict says so.

Observed on FEAT-152 round 3 (2026-09-24): the commissioner found that a
`--working-tree` run on the live tree would have put the FEAT-152 ticket (rounds
1-2 refutations and the fixer's entries) plus eight other tickets' Activity logs
into the verifier's prompt. They worked around it by hand — a scratch repo whose
dirty tree held only the five FEAT-152 code files — and noted it in the FEAT-152
Activity log (round-3 REFUTED entry, "Commissioning note").

## Expected
The change shown to the verifier never carries board or methodology prose — the
same material the clean room already deletes from the verifier's working copy.
A verify over the live dirty tree must be as clean as one over a hand-built
scratch repo, without the commissioner having to build one.

## Repro
1. With any uncommitted edit under `docs/bugs/` (e.g. an appended Activity entry)
   plus a code change, run
   `node scripts/independent-verify.mjs --repo . --working-tree --print-prompt …`.
2. The printed prompt's diff section contains the `docs/bugs/…` hunks verbatim.

## Root cause (diagnosed from source, not fixed)
The room and the diff are built from two different lists. `buildCleanroom`
deletes the `CONTAMINATION` paths (`docs/prompts`, `docs/bugs`, …) from the
exported room, but the diff the prompt carries is
`gitOk(repo, 'diff', base, head)` (`scripts/independent-verify.mjs`, ~line 731)
with no pathspec, so it includes every path the room strip removed.
`--working-tree` (FEAT-134) makes this routine: the snapshot is the whole dirty
tree, and the board is almost always dirty. A committed range can carry the same
leak whenever a commit touches a ticket, so this is not only a `--working-tree`
defect; `--working-tree` just makes it happen every time.

## Context pack
- Files/functions in play: `scripts/independent-verify.mjs` — `CONTAMINATION`
  (~line 233), `buildCleanroom` (the strip), the `fullDiff` construction (~line
  731) and the `--working-tree` snapshot branch just above it (~line 715,
  FEAT-134).
- Related tickets: BUG-104 and BUG-120 (what the ROOM still leaks — different
  surface: those are files the verifier can read, this is the diff it is handed),
  FEAT-134 (`--working-tree`), FEAT-152 (where it was observed; round-3 entry).
  BUG-120's recorded direction applies here too: the owner of a check names its
  inputs, rather than keeping a second list of what to leave out.
- Repro test: none yet. A proof should run `--print-prompt` over a real dirty tree
  that includes a `docs/bugs` edit and assert no board/methodology path appears in
  the diff, with a must-FAIL against the current diff construction.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-24 — FEAT-152 round-4 fixing lane (filing)
- **Understood:** FEAT-152's round-3 verifier commissioner reported the leak and
  worked around it by hand. Searched the board for an existing ticket: BUG-104
  and BUG-120 cover what the clean ROOM leaks, and FEAT-134 added
  `--working-tree`; none covers the diff handed to the verifier. Filed this one.
- **Verified:** by source reading only — the room strip and the diff are built
  from different inputs, and the diff call takes no pathspec. Not executed here.
- **Changed:** filed this ticket and its INDEX row. No source touched (the
  dispatch said file, don't fix).
- **Still open / handoff:** fix so the diff excludes everything the room strips,
  derived from one declared input set rather than a second list; prove it with a
  must-FAIL `--print-prompt` run over a real dirty tree.
- **Symptom of a deeper design flaw?** (open — answered at close; candidate: the
  same BUG-120 shape — two readers each working out what is "safe" from separate
  lists.)

### 2026-09-29 — BUILT with BUG-120 (one lane, same file); NOT self-verified
- **Understood:** confirmed the root cause from source — the room strip and the
  diff were two lists. The diff was `gitOk(repo, 'diff', base, head)` with no
  pathspec, so every `docs/bugs` hunk in the range reached the verifier's prompt.
  Fixed together with BUG-120's allow-list inversion so the two share ONE source.
- **Changed (unstaged; orchestrator does git):** `scripts/independent-verify.mjs`
  — the diff is now `git diff base head -- . ':(exclude)…'` where the exclusions
  are built by `contaminationSurface(...)` from the SAME declared prose surface
  (`src/server/cleanroom-surface.mjs`, new) + universal ambient set that the room
  strips, minus the same `--allow-input` allow-list. Never a second list. Board
  and methodology paths (`docs/…`, `.claude`, `CLAUDE.md`, …) can no longer reach
  the verifier's diff. A diff that becomes empty after exclusion dies "nothing for
  the verifier to attack" rather than leaking. See BUG-120's 2026-09-29 build
  entry for the full file list and the shared-source rationale.
- **Verified (ran, exit read directly):** `node scripts/verify-bug-186-diff-strip.mjs`
  — 13/13 PASS, including the exact Repro: a must-FAIL against the pre-fix
  `git diff` (no pathspec) that DOES carry the `docs/bugs`/`docs/CONVENTIONS.md`
  hunks, and a PASS `--print-prompt` whose diff carries none — over both a fixture
  and the REAL dirty Orchard tree (`--working-tree`, board dirty right now: no
  `docs/bugs/` path in the diff). Anti-regression: `verify-independent-verification`
  152/152, `verify-bug-182-cleanroom-boot-stubs` 21/21, `npm run gate` PASS exit 0.
- **Still open / handoff:** NOT self-verified (verification-integrity tooling) —
  an independent cross-provider verify is warranted before VERIFIED. Status OPEN;
  INDEX untouched (orchestrator-owned).
- **Symptom of a deeper design flaw?** yes → it IS the BUG-120 shape (two readers
  each deriving "safe" from separate lists). Not a new ARCH ticket: BUG-120 is
  that class instance and this was fixed as one with it (ARCH-010 already governs
  the class).

### 2026-09-29 — INDEPENDENT clean-room verify (cross-provider) — VERDICT: BROKEN
- **Requirement (extracted to plain terms, not the fixer's prose):** the diff/prompt handed to the
  verifier must NEVER carry board or methodology prose, even over the live dirty tree
  (`--working-tree`) — none of `docs/bugs/`, `docs/prompts/`, `docs/CONVENTIONS.md`,
  `docs/ARCHITECTURE-REVIEW.md`, `docs/analysis/`, or the ambient-instruction surface
  (`CLAUDE.md`/`.claude`/`AGENTS.md`…); the diff exclusions must come from the SAME declared set the
  room strips; code changes still appear; a diff empty after exclusion fails loudly.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @<req> --run "node scripts/verify-bug-186-diff-strip.mjs" --test-file scripts/verify-bug-186-diff-strip.mjs --timeout-min 20`
- **Verdict: BROKEN (VALID).** The verifier re-ran the fixer's suite (11/12 PASS in the room — the
  real-tree check needs git metadata absent from the clean room, expected) and then built the case
  the fixture never exercises: a NESTED ambient-instruction file (`src/AGENTS.md`, not the root
  `AGENTS.md`) edited alongside a code change.
  - **FINDING:** with a dirty nested `src/AGENTS.md`, the room correctly STRIPS it
    (`stripped: docs/bugs, src/AGENTS.md`) but its full contents LEAK into the printed diff — the
    two are NOT built from the same effective set the ticket claims. The diff exclusions are
    root-anchored git pathspecs (`:(exclude)AGENTS.md`, `:(exclude).claude`, …) that match only the
    repo root, while the room strip finds nested ambient files recursively. So a nested `AGENTS.md`
    is the exact "carried in the diff but stripped from the room" leak this ticket exists to close.
  - **FINDING (same root cause):** with ONLY `src/AGENTS.md` + board prose changed, the run exits 0
    and prints the instruction prose instead of dying "nothing to verify after excluding the
    board/methodology surface"; restoring `src/AGENTS.md` makes the board-only control correctly
    exit 2. The empty-diff guard is defeated because the un-excluded nested-ambient hunk keeps the
    diff non-empty.
- **Verified-by:** dispatch openai run 01a0ea79-9953-7d93-84d9-2daeb1d63da2 (clean-room,
  `scripts/independent-verify.mjs`, cross-provider — author anthropic, verifier openai) —
  VERDICT: BROKEN.
- **Status:** stays OPEN. Handoff: the diff exclusion must cover nested ambient-instruction files
  (recursive, e.g. `**/AGENTS.md`), matching the room strip's recursion, so the two truly share one
  effective set. Re-verify the nested-ambient case and the empty-after-exclusion death after the fix.

### 2026-09-29 — round-2 FIX (with BUG-120); NOT self-verified
- **Understood:** the round-1 diff exclusions were ROOT-ANCHORED git pathspecs
  (`:(exclude)AGENTS.md`, `:(exclude).claude`), matching only the repo root,
  while the room strip found ambient files recursively — so a nested
  `src/AGENTS.md` leaked into the diff (and defeated the empty-after-exclusion
  guard) exactly as the openai verify (run `01a0ea79-9953-7d93-84d9-2daeb1d63da2`)
  showed.
- **Changed (`scripts/independent-verify.mjs`, unstaged):** the ambient surface
  is now matched by NAME at ANY depth in BOTH routes from one rule — the room
  strip walks the tree recursively removing `AMBIENT_FILE_NAMES`/`AMBIENT_DIR_NAMES`
  at every depth, and `contaminationSurface()` emits the recursive globs
  `:(exclude,glob,icase)**/<file>` and `:(exclude,glob)**/<dir>` + `…/**` that
  describe the SAME set for the diff. Verified the glob semantics empirically
  (top-level + `src/` + `a/b/` all excluded; dir contents excluded). The
  belt-and-braces removal was replaced by a PURE post-strip assertion that fails
  loud if ANY undeclared contamination survives at any depth (so it proves the
  strip rather than masking it). Prose per-file exclusions use `:(exclude,literal)`
  so a filename with glob metacharacters (`docs/weird[1].md`) is handled.
- **Verified (ran, exit read directly):** `node scripts/verify-bug-186-diff-strip.mjs`
  — 20/20 PASS. Includes the verifier's exact nested-`src/AGENTS.md` case + a
  depth-2 `a/b/CLAUDE.md` generalisation, a must-FAIL against the round-1
  root-anchored construction (nested ambient leaks), the empty-after-exclusion
  death (only nested ambient + board changed ⇒ exit 2; control with a real code
  change runs), and the REAL dirty `~/projects/orchard` tree (no `docs/bugs/`,
  no ambient file hunk). Anti-regression: `verify-independent-verification`
  152/152, `verify-bug-182-cleanroom-boot-stubs` 21/21, `npm run gate` PASS
  exit 0, `npm run board:check` exit 0.
- **Self-named same-class attacks run:** a symlink SIBLING under an allowed dir is
  stripped (Part A); an escaping symlink under an allowed dir is removed by
  `auditSymlinks` (existing containment tests, verify-independent §F); a
  glob-metacharacter filename is excluded literally and stripped (Part C).
  DECLINED/residual: a content-identical COPY of methodology under a
  non-prose, non-ambient name is not detected — the surface is structural
  (name + location), by design; a content-addressed scan is a different, larger
  mechanism and out of scope here.
- **Still open / handoff:** NOT self-verified — re-verify cross-provider before
  VERIFIED. Status OPEN; INDEX untouched.
- **Symptom of a deeper design flaw?** yes → the same BUG-120 shape (two readers
  deriving "safe" separately); fixed as one with BUG-120 under ARCH-010, no new
  ARCH ticket.

### 2026-09-29 — INDEPENDENT clean-room verify round 2 (cross-provider, openai) — VERDICT: BROKEN
- **Requirement (plain terms + reframed attack, not the fixer's prose):** the diff handed to the
  verifier over the live dirty tree (`--working-tree`) must NEVER carry board/methodology prose or
  the ambient surface at ANY depth (`docs/…`, `CLAUDE.md`/`AGENTS.md`/`.claude`/`.codex`/…),
  exclusions derived from the SAME declared set the room strips (never a second list); code changes
  still appear; a diff empty after exclusion FAILS LOUDLY. Reframed for the NEW design (past round
  1's single nested `src/AGENTS.md`): recursive `**/` globs at edge names (case-fold, dotfiles,
  glob-metachar, spaces); the per-file `:(exclude,literal)` list AT SCALE + the command-line-length
  limit; can the empty-after-exclusion guard be BYPASSED by an un-excluded hunk; symlinks in prose
  dirs; the declined content-identical-copy residual (note reachability, not a fail).
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-BUG-186-r2.txt --run "node scripts/verify-bug-186-diff-strip.mjs" --test-file scripts/verify-bug-186-diff-strip.mjs --test-file src/server/cleanroom-surface.mjs --timeout-min 22`
- **Verdict: BROKEN (VALID).** Re-ran the fixer's suite (18/19 in the room — check (D), the real-tree
  `--print-prompt`, cannot run in a `git archive` room with no `.git`; expected, noted UNTESTED) and
  built the cases the fixture never exercises. The DEFAULT no-allow-input path (whole-root
  `:(exclude)docs`) held — ordinary spaces, brackets, nested mixed-case ambient, dotfiles and tested
  symlinks were all excluded. Three FINDINGs broke the per-file enumeration path (the branch used
  when an `--allow-input` lives under a prose root, which switches from whole-root exclude to a
  per-file `:(exclude,literal)` list built from `git ls-tree` of the HEAD tree):
  - **FINDING:** with `--allow-input docs/input.json`, DELETING `docs/bugs/deleted.md` prints its
    removed board prose and exits 0 — the per-file enumeration lists only files present in the head
    tree, so a deleted prose file has no exclusion spec and its removal hunk leaks; this also defeats
    the empty-after-exclusion guard.
  - **FINDING:** with that allowed input, changing only `docs/café.md` prints its prose and exits 0 —
    git QUOTES non-ASCII paths in `ls-tree` output (`"docs/caf\303\251.md"`), and the enumeration
    feeds that quoted form into `:(exclude,literal)` so the exclusion never matches the real path.
  - **FINDING:** a prose filename ending in a SPACE (`docs/trailing.md `) leaks its hunk with
    `--allow-input` — same enumeration mishandling of edge filenames.
- **Note on the declined residual:** a content-identical copy of methodology under a non-prose,
  non-ambient name remained reachable, as the fixer explicitly declined (structural surface, not
  content-addressed) — recorded, not counted as a failure.
- **Verified-by:** dispatch openai run 01a0ec1e-52e9-70b3-98f8-888c19ad4096 (clean-room,
  `scripts/independent-verify.mjs`, cross-provider — author anthropic, verifier openai) —
  VERDICT: BROKEN.
- **Status:** stays OPEN. Handoff: the leaks are confined to the per-declared-input enumeration
  branch (`contaminationSurface` `listFilesUnder`); the whole-root default is clean. Fix so that
  enumeration (1) also excludes DELETED prose paths in the range, not just head-tree files;
  (2) un-quotes / `-z`-parses `git ls-tree` output so non-ASCII and trailing-space names are
  excluded literally; and ties into the same ARG_MAX/batching concern BUG-120's round-2 entry
  raised. Re-verify the deletion, quoted-filename and trailing-space cases with `--allow-input`
  after the fix. High-stakes (verification-integrity, regression-prone) — keep the cross-provider
  independent pass.

### 2026-09-29 — round-3 REDESIGN (allow-list diff; with BUG-120); NOT self-verified

- **Understood:** the round-2 diff still built EXCLUSION strings — recursive globs plus a per-file
  `:(exclude,literal)` enumeration from the HEAD tree — which git-quoted non-ASCII names, omitted
  DELETED paths, mishandled trailing-space names, and hit ARG_MAX at scale (findings 6-8 + the shared
  #5). Exclusion strings are the wrong shape.
- **Changed (`scripts/independent-verify.mjs`):** the diff is now an ALLOW-LIST driven by the SAME
  `makeIsDeclared` predicate the room strip uses (BUG-120's round-3 entry has the full design):
  `git diff --name-only -z --no-renames base head` gives the changed paths byte-exact (NUL, no
  quoting, with deletions and both rename sides), JS filters them by the predicate, and the diff is
  emitted limited to exactly the ALLOWED paths as literal pathspecs (`GIT_LITERAL_PATHSPECS`,
  batched). No exclusion strings ⇒ no quoting, deletion, space or ARG_MAX edge, and the empty-after-
  exclusion guard fires whenever no changed path is declared. Verified `git diff` rejects
  `--pathspec-from-file` (exit 129), so literal argv pathspecs are used.
- **Verified (ran, exit read directly):** `node scripts/verify-bug-186-diff-strip.mjs` — 22/22 PASS,
  incl. the exact Repro cases (deleted `docs/bugs/deleted.md`, non-ASCII `docs/café.md`,
  trailing-space `docs/trailing.md `) as must-FAIL-before / PASS-after with `--allow-input`, an
  800-file ARG_MAX case, and the REAL dirty `~/projects/orchard` tree (no `docs/bugs/`, no ambient
  hunk). Anti-regression: `verify-independent-verification` 152/152, `verify-bug-182` 21/21.
  `npm run gate` leak-gate fails only on an untracked stray from another lane
  (`scripts/_diag-b203.mjs`), not my files; `board:check` exit 0.
- **Still open / handoff:** NOT self-verified — re-verify cross-provider before VERIFIED. Structural
  residual (content copied/renamed out of the prose surface into a code path is reachable) declined
  by design; see BUG-120's round-3 entry. Status OPEN; INDEX untouched.
- **Symptom of a deeper design flaw?** yes → the class was "two decision points disagree with git on
  edges"; round 3 closes it structurally (one predicate, byte-exact), fixed as one with BUG-120 under
  ARCH-010.

### 2026-09-29 — INDEPENDENT clean-room verify round 3 (cross-provider, openai) — VERDICT: BROKEN
- **Requirement (plain terms + reframed attack for the round-3 REDESIGN, not the fixer's prose):**
  the diff handed to the verifier over the live dirty tree (`--working-tree`) carries only declared
  CODE changes and NEVER board/methodology prose or the ambient surface at any depth, from the SAME
  `makeIsDeclared` predicate the room strips; a diff empty after filtering FAILS LOUDLY. Reframed for
  the ALLOW-LIST redesign (`git diff --name-only -z --no-renames` → predicate filter → limited diff
  as LITERAL pathspecs, batched): a `--no-renames` rename moving prose OUT of a declared path or
  undeclared content INTO one; the BATCHING of literal pathspecs at scale (a boundary dropping or
  duplicating a path); and edge names (deleted/non-ASCII/trailing-space prose). Citation example
  (filled shape) provided in the requirement file.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-BUG-186-r3.txt --run "node scripts/verify-bug-186-diff-strip.mjs" --test-file scripts/verify-bug-186-diff-strip.mjs --test-file src/server/cleanroom-surface.mjs --timeout-min 22`
- **Verdict: BROKEN (VALID).** Re-ran the fixer's suite (21/22 in the room — check (F), the real-tree
  `--print-prompt`, cannot run in a `git archive` room with no `.git`; expected, noted UNTESTED) and
  built a case the fixture never exercises: a code path that was a FILE becomes a DIRECTORY holding
  an ambient file.
  - **FINDING:** with `src/widget` (a tracked file) DELETED and replaced by a directory containing
    `src/widget/AGENTS.md`, the diff emits `src/widget` as a LITERAL pathspec (the deleted, declared
    code path) — but a literal pathspec naming what is now a directory ALSO selects its descendants,
    so the stripped, undeclared `src/widget/AGENTS.md` and its instruction content LEAK into the diff
    even though the room correctly strips it. The predicate judges the emitted PATH but the pathspec
    it produces matches more than that exact path. Confirmed the room strip removes it (ambient
    survives in room: false) while the diff shows it; removing the ancestor deletion makes the same
    ambient addition correctly fail the empty-after-exclusion guard (exit 2).
- **Verified-by:** dispatch openai run 01a0ee86-7e17-7133-891a-c1c11c6da5a2 (clean-room,
  `scripts/independent-verify.mjs`, cross-provider — author anthropic, verifier openai) —
  VERDICT: BROKEN.
- **Status:** stays OPEN. Handoff: a literal pathspec is a PREFIX match in git — a declared path that
  is now (or contains) a directory selects undeclared descendants. Constrain the emitted diff to the
  exact declared paths only (e.g. pathspec-magic `:(literal,top)` is still a prefix; consider passing
  each allowed path such that descendants are not swept, or post-filter the emitted diff's file
  headers by the predicate). Re-verify the file→directory-with-ambient-descendant case and a
  file→directory-with-prose-descendant case after the fix. High-stakes (verification-integrity,
  regression-prone file) — keep the cross-provider independent pass; independent verify remains
  warranted before VERIFIED.

### 2026-09-29 — round-4 FIX (diff post-condition guarantee; with BUG-120); NOT self-verified

- **Understood (openai run `01a0ee86…`):** a code path that was a FILE and became a DIRECTORY
  (`src/widget` deleted, `src/widget/AGENTS.md` added) leaked the ambient descendant, because the
  deleted-file's literal pathspec `src/widget` prefix-matches the new directory's contents. The
  predicate judged the emitted PATH but the pathspec it produced selected more than that path.
- **Changed (`scripts/independent-verify.mjs`):** the allow-list mechanism stays (literal
  `:(literal)` pathspecs over predicate-filtered byte-exact changed paths), but pathspec semantics
  are no longer trusted as the last line. After producing the diff, the harness reads the file list
  the diff ACTUALLY contains (`git diff --name-only -z` over the same pathspecs) and ASSERTS it is a
  subset of the declared set. A stray undeclared descendant (the file→dir case) is excluded with an
  explicit `:(exclude,literal)` and the diff rebuilt ONCE (bounded — no ARG_MAX); if anything
  undeclared still remains, the run FAILS LOUDLY rather than ship it. Any future pathspec surprise is
  now a hard error, never a leak.
- **Verified (ran, exit read directly):** `node scripts/verify-bug-186-diff-strip.mjs` — 32/32 PASS,
  incl. the exact file→dir case as must-FAIL (round-3 plain pathspec leaks the descendant) /
  PASS-after (post-condition excludes it, code change + deletion still shown), and the REAL dirty
  `~/projects/orchard` tree. Anti-regression: `verify-independent-verification` 152/152,
  `verify-bug-182` 21/21. `npm run gate` PASS exit 0; `board:check` exit 1 only on FEAT-157 (another
  lane), not mine.
- **Still open / handoff:** NOT self-verified — re-verify cross-provider before VERIFIED. Structural
  residual (content copied/renamed OUT of the prose surface into a code path) declined by design; see
  BUG-120. Status OPEN; INDEX untouched.
- **Symptom of a deeper design flaw?** yes → the class was "the emitted decision (predicate) and the
  mechanism (pathspec) can disagree"; round 4 closes it with a post-condition that re-checks the
  mechanism's OUTPUT against the predicate — fixed as one with BUG-120 under ARCH-010.

### 2026-09-30 — INDEPENDENT clean-room verify round 4 (cross-provider, openai) — VERDICT: BROKEN
- **Requirement (plain terms + confirm-cases, not the fixer's prose):** the diff handed to the
  verifier is an ALLOW-LIST driven by `makeIsDeclared` over byte-exact `git diff --name-only -z
  --no-renames` paths; a SUBSET POST-CONDITION reads the file list the diff actually contains,
  excludes any stray undeclared path with `:(exclude,literal)`, rebuilds ONCE, and dies LOUDLY if
  anything undeclared still remains; empty-after-filter also dies loudly. Confirm-cases asked: the
  "exclude once and rebuild" loop cannot be driven to SHIP an undeclared file — a stray that
  reappears on rebuild, many strays (file→dir with many undeclared descendants), a rename pair
  (prose OUT of / INTO a declared path). A filled-in citation-block example was provided.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-BUG-186-r4.txt --run "node scripts/verify-bug-186-diff-strip.mjs" --test-file scripts/verify-bug-186-diff-strip.mjs --test-file src/server/cleanroom-surface.mjs --timeout-min 22`
- **Verdict: BROKEN (VALID).** Re-ran the fixer's suite (31/32 in the room — the real-tree
  `--print-prompt` check cannot run in a `git archive` room with no `.git`; expected, noted
  UNTESTED). The charter's named confirm-cases HELD: `many-strays-and-rename-pairs` (1,200 ambient
  descendants under a file→dir path + prose→ambient and code→prose renames in a dirty tree) shipped
  NO undeclared content — the subset post-condition excluded them all. One FINDING broke it via a
  route the fixture never exercises:
  - **FINDING:** `runDiff` permits a configured `diff.external` helper. The subset post-condition
    validates a SEPARATE `git diff --name-only` result (which does NOT invoke the external helper),
    but the EMITTED patch is produced by `git diff` (patch) WITH the helper — so a `diff.external`
    that re-expands a declared path (`src/widget`) ships `src/widget/AGENTS.md` and a nested
    `.CoDeX` hunk in the patch while `--name-only` still reports only the declared paths. The run
    exits 0 having emitted an undeclared ambient/prose patch. Unsetting only `diff.external` removes
    the leak. Bounded: requires a repo-configured external diff driver (`diff.external` or a
    `.gitattributes` diff driver), so real reachability depends on the repo under test carrying
    such config — but it is a real hole in "the shipped diff is always a subset of the declared
    set": the subset check must judge the PATCH's actual content, not a separately-computed name
    list that bypasses the helper.
- **Verified-by:** dispatch openai run 01a0f253-81b3-7ee1-a381-ea3712b3b393 (clean-room,
  `scripts/independent-verify.mjs`, cross-provider — author anthropic, verifier openai) —
  VERDICT: BROKEN.
- **Status:** stays OPEN. Handoff: the subset post-condition must be computed against the emitted
  patch's own file headers (or the diff must run with `diff.external`/attribute diff drivers
  neutralised, e.g. `-c diff.external= --no-ext-diff` and `-c core.attributesFile=/dev/null`), so a
  configured external diff helper cannot re-expand a declared path into undeclared descendants after
  the name-only subset check has passed. Re-verify the `diff.external` file→dir case after the fix.
  High-stakes (verification-integrity, regression-prone file) — keep the cross-provider independent
  pass before VERIFIED.

### 2026-09-30 — round-5 FIX (patch cannot diverge from the checked list); NOT self-verified

- **Understood (openai run `01a0f253…`):** the subset post-condition validated a SEPARATE
  `git diff --name-only` result (which does not invoke a diff helper), but the EMITTED patch was
  produced by `git diff` honoring a repo-configured `diff.external` / `.gitattributes` diff driver /
  textconv — so a helper could re-expand a declared path and ship undeclared ambient/prose content in
  the PATCH while `--name-only` still reported only the declared paths. GAP: the post-condition
  judged a list computed on a different footing than the patch.
- **Fix:** every diff invocation (the changed-list, the patch, and the subset name-list) now runs
  with `--no-ext-diff --no-textconv`, so the emitted patch is git's own INTERNAL diff — no external
  helper can rewrite or re-expand it — and the patch and the checked name-list are produced
  identically. The subset assertion (round-4) therefore governs the actual patch content again.
- **Verified:** `node scripts/verify-bug-186-diff-strip.mjs` — 40/40 PASS. New (H) finding C:
  must-FAIL (a configured `diff.external` injects a marker into a plain `git diff`) / PASS-after (the
  shipped diff bypasses it, shows the real change), plus the generalisation for a `.gitattributes`
  diff-driver command + textconv. The openai `many-strays-and-rename-pairs` confirm-case stays green.
  The real-tree check was tightened to judge diff HEADERS, not substrings (my own changed code
  legitimately mentions `docs/bugs/` in comments). Anti-reg: 153/153, 21/21; `npm run gate` PASS.
- **Still open / handoff:** NOT self-verified — re-verify cross-provider before VERIFIED. Status
  OPEN; INDEX untouched.
- **Symptom of a deeper design flaw?** yes → same class ("the checked artifact and the emitted
  artifact are produced differently"); closed by producing them identically. Fixed with BUG-120
  under ARCH-010.

### 2026-10-01 — round-5 INDEPENDENT verify NOT RUN (openai quota-window); re-verify next round

- **Requirement prepared (plain terms, not the fixer's prose):** every diff invocation runs with
  `--no-ext-diff --no-textconv`, so the EMITTED patch is git's own INTERNAL diff and is produced on
  the same footing as the `--name-only` list the subset post-condition validates — no other git
  mechanism may alter patch content vs the name list: a `diff.external` helper, a `.gitattributes`
  diff-driver command (incl. via a config `include`/`includeIf`), a `.gitattributes` textconv,
  `GIT_EXTERNAL_DIFF`, or clean/smudge/EOL conversion. A diff empty after filtering dies loudly. A
  filled-in citation-block example was provided in `/tmp/req-BUG-186-r5.txt`.
- **Command (tilde form), attempted:**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-BUG-186-r5.txt --run "node scripts/verify-bug-186-diff-strip.mjs" --test-file scripts/verify-bug-186-diff-strip.mjs --test-file src/server/cleanroom-surface.mjs --timeout-min 22`
- **Outcome: NOT RUN (infra, not a verdict).** The dispatch failed `[quota-window]` (provider
  openai): "You've hit your usage limit … try again at Oct 5th 2026." BUG-120's round-5 verify
  (openai run `01a0f70f-ac76-7ba2-8091-4be62b1ca46a`, this lane) consumed the OpenAI window first, so
  the BUG-186 dispatch exited before the verifier ran. No run id, no verdict — nothing verified. No
  `board-tool verified` record was written (a verdict that did not happen proves nothing).
- **Status:** stays OPEN. Handoff: BUG-120's round-5 verdict (same file) is BROKEN — a boot-stub
  resurrection hole in the ROOM surface — so this file needs another fix round regardless. Fold the
  BUG-186 `--no-ext-diff --no-textconv` re-verify (requirement above, citation example ready) into
  that next fix round's cross-provider verify once the OpenAI quota resets (or verify same-provider
  and say so). High-stakes (verification-integrity, regression-prone file) — keep the cross-provider
  independent pass before VERIFIED.

### 2026-10-01 — round-6 (pipeline restructure shared with BUG-120); diff unchanged, re-verified

- **Context:** round 5's BUG-186 diff fix (`--no-ext-diff --no-textconv` + the subset post-condition)
  was never independently verified (OpenAI quota). The round-6 refutation was BUG-120's (boot-stub
  seeding, a room-strip concern), not the diff. No diff-route change was needed this round.
- **Shared change:** `buildCleanroom` is now an explicit pipeline whose FINAL stage is the room
  assertion, after every writer (see BUG-120's 2026-10-01 entry for the full write enumeration). The
  diff route (allow-list over byte-exact `--name-only -z` paths + subset post-condition, all under
  `--no-ext-diff --no-textconv`) is unchanged and still passes.
- **Verified:** `node scripts/verify-bug-186-diff-strip.mjs` — 46/46 PASS (all BUG-186 diff cases
  from rounds 1–5 remain green: nested/deleted/non-ASCII/space, file→dir subset post-condition,
  diff.external + .gitattributes driver bypass, the real dirty tree judged on diff headers).
  `npm run gate` PASS exit 0.
- **Still open / handoff:** NOT self-verified — re-verify cross-provider before VERIFIED (and this
  round finally exercises the round-5 diff fix under an independent pass). Status OPEN; INDEX
  untouched.

### 2026-10-01 — BUG-120/186 round-6 clean-room verify lane
- **Verification recorded:** dispatch anthropic run 5b2e5a07-929e-40b6-83b4-8fa0776b05fe — VERDICT: BROKEN — same-provider (second Anthropic account; OpenAI exhausted till 2026-10-05); cross-provider re-verify due after 2026-10-05; BROKEN — submodule diff.submodule=diff leaks board/ambient prose, seed-before-audit containment breach, AGENTS.override.md ambient gap. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-01 — INDEPENDENT clean-room verify round 6 (same-provider fallback) — VERDICT: BROKEN
- **Combined verify (ONE dispatch, shared file + shared fixer test, both scopes).** SCOPE 2 here is
  the DIFF fix — the round-5 `--no-ext-diff --no-textconv` + subset post-condition that had NEVER been
  independently verified (round-5 OpenAI quota). SCOPE 1 (the room pipeline) is in BUG-120's
  2026-10-01 round-6 entry. Routed to a SECOND Anthropic account (fresh context); OpenAI exhausted
  until 2026-10-05 — same-provider fallback, decorrelation reduced; **cross-provider re-verify due
  after 2026-10-05** (noted in the typed Verified-by entry).
- **Requirement (plain terms, not the fixer's prose):** the diff handed to the verifier is an
  ALLOW-LIST driven by one `makeIsDeclared` predicate over byte-exact `git diff --name-only -z
  --no-renames` paths, with a subset post-condition on the emitted patch; EVERY diff invocation runs
  under `--no-ext-diff --no-textconv` so the emitted patch is git's own internal diff, produced on the
  SAME footing as the `--name-only` list the subset check validates. NO other git mechanism may let
  the emitted patch diverge and re-expand a declared path into undeclared descendants — probed:
  `diff.external` config, `GIT_EXTERNAL_DIFF` env, a `.gitattributes` diff driver, textconv,
  clean/smudge filters, EOL conversion. A filled-in FIXER-TEST citation example was provided in
  `/tmp/req-BUG-120-186-r6.txt`.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-BUG-120-186-r6.txt --run "node scripts/verify-bug-186-diff-strip.mjs" --test-file scripts/verify-bug-186-diff-strip.mjs --test-file src/server/cleanroom-surface.mjs --provider anthropic --timeout-min 9 --verdict-out /tmp/verdict-BUG-120-186-r6.txt`
- **Verdict: BROKEN (VALID, manifest-backed).** Re-ran the fixer's suite (45/46 in the room — the
  real-tree check (F) cannot run in a `git archive` room with no `.git`; expected, noted UNTESTED).
  The round-5 diff fix otherwise HELD: `GIT_EXTERNAL_DIFF` env was suppressed by `--no-ext-diff`;
  the `diff.external` / `.gitattributes` driver / textconv cases stay green. ONE new SCOPE-2 FINDING
  broke it via a route the fixture never exercises:
  - **FINDING (submodule diff expansion):** with repo config `diff.submodule=diff` and a DECLARED
    submodule gitlink path (`vendor/lib`) whose gitlink changed, the emitted patch contains
    `vendor/lib/AGENTS.md` and `vendor/lib/docs/bugs/BUG-9.md` content while the `--name-only` subset
    check sees only `vendor/lib`. `--no-ext-diff`/`--no-textconv` do NOT stop this (no
    `--submodule=short` / `--ignore-submodules` is forced), so the run exits 0 and ships ambient and
    board prose from inside the submodule. The subset check is defeated because submodule-content
    expansion is a patch-only effect the `--name-only` footing does not reproduce. (adv-diff run
    5df9b62cff4d; the GIT_EXTERNAL_DIFF-env half of the same run HELD.)
- **Verified-by:** dispatch anthropic run 5b2e5a07-929e-40b6-83b4-8fa0776b05fe (clean-room,
  `scripts/independent-verify.mjs`, same-provider fallback — second Anthropic account; cross-provider
  re-verify due after 2026-10-05) — VERDICT: BROKEN. (Typed proof in verification-ledger.json; this
  line is the prose echo.)
- **Status:** stays OPEN. Handoff: force `--submodule=short` (or `--ignore-submodules=all`) on every
  diff invocation, OR extend the subset post-condition to parse submodule-section headers in the
  emitted patch and reject undeclared submodule-internal content — the `--name-only` footing cannot
  see it, so the subset check must judge the patch's own submodule expansion. UNTESTED (carry
  forward): clean/smudge filters and `core.autocrlf` / `eol` attributes under `--working-tree`
  (`snapshotWorkingTree` only read, not exercised). Re-verify the `diff.submodule=diff` case after the
  fix. High-stakes (verification-integrity, regression-prone file) — keep the cross-provider
  independent pass (due after 2026-10-05) before VERIFIED.
- **Symptom of a deeper design flaw?** yes → same class (an emitted artifact that can diverge from the
  checked name-list); the submodule expansion is a new instance of it, under ARCH-010 with BUG-120.

### 2026-10-01 — round-7 FIX (submodule diff inlining); NOT self-verified

- **Understood (anthropic run `5b2e5a07…`):** repo config `diff.submodule=diff` INLINES a changed
  submodule gitlink's internal patch — the submodule's own `AGENTS.md` and `docs/bugs/BUG-9.md`
  content — into the emitted patch, while `git diff --name-only` (the subset check's footing) sees
  only the gitlink path `vendor/lib`. `--no-ext-diff`/`--no-textconv` do not stop it. Ambient and
  board prose from inside the submodule shipped, exit 0.
- **Fixes:**
    - Force the short submodule format on EVERY diff invocation: `-c diff.submodule=short
      --submodule=short` (overrides hostile repo config), so a gitlink change shows only as a
      one-line `Subproject commit X..Y` — never inlined content. `-c core.quotePath=false` keeps
      non-ASCII header paths byte-exact.
    - BACKSTOP: the subset post-condition now also parses the EMITTED patch's OWN headers
      (`diff --git` and `Submodule` lines) and asserts every path is in the declared/allowed set —
      so any format that expands content past the allow-list (an inlined sub-diff, a surprise
      section) fails CLOSED rather than shipping. The `--name-only` subset check is kept too.
- **Verified:** `node scripts/verify-bug-186-diff-strip.mjs` — 55/55 PASS. New (J4): must-FAIL
  (`diff.submodule=diff` inlines the submodule's `AGENTS.md`/board prose into a plain diff over a
  real file-protocol submodule) / PASS-after (the shipped diff forces `--submodule=short`,
  overriding the hostile config — no submodule content ships, the code change does). Anti-reg:
  153/153, 21/21; `npm run gate` PASS exit 0.
- **Still open / handoff:** NOT self-verified — cross-provider re-verify due after 2026-10-05.
  UNTESTED carry-forward noted by the verifier: clean/smudge filters and `core.autocrlf`/`eol`
  attributes under `--working-tree`. Status OPEN; INDEX untouched.

### 2026-10-01 — BUG-120/186 round-7 clean-room verify lane
- **Verification recorded:** dispatch openai/codex run 01a0f923-ace6-7432-a676-ab5318515fd7 — VERDICT: BROKEN — cross-provider openai (author anthropic); combined verify, shared file. BUG-186 diff cases all HELD (submodule --submodule=short + header backstop); BROKEN is a shared-pipeline containment defect — recorder .vrun/alive heartbeat bypasses safeWriteInRoom via a committed internal symlink. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-01 — INDEPENDENT clean-room verify round 7 (cross-provider, openai) — VERDICT: BROKEN
- **Combined verify (ONE dispatch, shared file + shared fixer test, both scopes); CROSS-PROVIDER
  restored (OpenAI back).** SCOPE 2 here is the DIFF route (BUG-186); SCOPE 1 (room pipeline /
  containment) is in BUG-120's 2026-10-01 round-7 entry. Author anthropic → verifier openai (codex).
  (A first thread `01a0f920…` was aborted by OpenAI's content filter; re-dispatched QA-framed, same
  claims — that run completed.)
- **Requirement (plain terms, QA-framed, not the fixer's prose):** the diff is an ALLOW-LIST driven by
  one `makeIsDeclared` predicate; EVERY diff invocation forces `-c diff.submodule=short
  --submodule=short` (overriding hostile `diff.submodule=diff`), `--no-ext-diff --no-textconv`,
  `-c core.quotePath=false`; the subset post-condition parses the EMITTED patch's OWN headers
  (`diff --git`, `Submodule …`) and fails CLOSED on any undeclared path. Probed: submodule inlining;
  rename/copy/binary patch headers vs the header backstop; clean/smudge + core.autocrlf/eol under
  `--working-tree`. Filled-in FIXER-TEST citation example in `/tmp/req-BUG-120-186-r7.txt`.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-BUG-120-186-r7.txt --run "node scripts/verify-bug-186-diff-strip.mjs" --test-file scripts/verify-bug-186-diff-strip.mjs --test-file src/server/cleanroom-surface.mjs --timeout-min 22 --verdict-out /tmp/verdict-BUG-120-186-r7.txt`
- **Verdict: BROKEN (VALID, manifest-backed).** Re-ran the fixer's suite (54/55 in the room — the
  real-tree check (F) cannot run in a `git archive` room with no `.git`; expected, noted UNTESTED).
  The BUG-186 DIFF route HELD entirely this pass: the round-7 submodule fix works (must-FAIL
  `diff.submodule=diff` inlines the submodule's `AGENTS.md`/board prose; PASS-after the forced
  `--submodule=short` ships only `Subproject commit X..Y`, no content), and all earlier diff cases
  (nested/deleted/non-ASCII/space, file→dir subset post-condition, diff.external/.gitattributes
  driver/textconv) stay green. The BROKEN verdict is a SCOPE-1 room-containment defect, NOT a diff
  leak — see BUG-120's round-7 entry (recorder `.vrun/alive` heartbeat writer bypasses
  `safeWriteInRoom` and follows a committed internal symlink to overwrite declared code).
- **Verified-by:** dispatch openai/codex run 01a0f923-ace6-7432-a676-ab5318515fd7 (clean-room,
  `scripts/independent-verify.mjs`, cross-provider — author anthropic, verifier openai) — VERDICT:
  BROKEN. (Typed proof in verification-ledger.json; this line is the prose echo.)
- **Status:** stays OPEN (shared file, combined BROKEN verdict). The diff route needs no further fix
  from THIS pass; it rides the next fix round's cross-provider re-verify once BUG-120's
  recorder-bypass / internal-symlink containment hole is closed. UNTESTED (carry forward): the
  patch-header backstop vs rename/copy/binary headers; clean/smudge filters + core.autocrlf/eol under
  `--working-tree` (the exported room has no `.git` worktree). High-stakes (verification-integrity,
  regression-prone file) — keep the cross-provider independent pass before VERIFIED.
- **Symptom of a deeper design flaw?** yes → same class under ARCH-010 with BUG-120 (a writer/route
  that can bypass the one declared guard); the recorder-heartbeat bypass is a new instance.

### 2026-10-01 — round-8 — diff route HELD under cross-provider verify; no change needed

- The cross-provider verify (openai/codex run `01a0f923…`) exercised BUG-186's diff route in full —
  the allow-list over byte-exact `--name-only -z` paths, the subset + emitted-patch-header
  post-conditions, `--no-ext-diff --no-textconv`, and the forced `-c diff.submodule=short
  --submodule=short` — and it HELD entirely. The round-8 refutation was BUG-120's (a recorder
  heartbeat following a committed internal `.vrun` symlink — a room-containment concern, not the
  diff). No BUG-186 code change this round; see BUG-120's 2026-10-01 round-8 entry for the shared
  pipeline hardening (every room write now `safeWriteInRoom` / `writeNoFollow` / under a fresh
  reserved `.vrun`).
- **Verified:** `node scripts/verify-bug-186-diff-strip.mjs` — 61/61 PASS (all BUG-186 diff cases
  green). `npm run gate` PASS exit 0; `board:check` OK — no drift.
- **Still open / handoff:** NOT self-verified into VERIFIED — re-verify cross-provider after the
  round-8 room fix. Status OPEN; INDEX untouched.

### 2026-10-01 — BUG-120/186 round-8 clean-room verify lane
- **Verification recorded:** dispatch openai run 01a0f932-dd81-7c23-8eca-f6be0fdb34c2 — VERDICT: BROKEN — cross-provider openai (author anthropic); combined shared file; VALID manifest-backed. BUG-186 diff route HELD (clean/smudge+autocrlf/eol under --working-tree). SCOPE-1 containment BROKEN: KEPT internal symlinks (escaping .vrun removed before reserved check; recorder/.bin symlink writes clobber). Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-01 — INDEPENDENT clean-room verify round 8 (cross-provider, openai) — DIFF ROUTE HELD (combined verdict BROKEN on SCOPE 1)

- **Combined verify (ONE dispatch, shared file + shared fixer test, both scopes); CROSS-PROVIDER.**
  SCOPE 2 here is the DIFF route (BUG-186); SCOPE 1 (room pipeline / containment) is in BUG-120's
  round-8 entry. Author anthropic → verifier openai (codex). Round-8 fix UNCOMMITTED — verified with
  `--working-tree`.
- **Requirement (plain terms, QA-framed):** the diff is an ALLOW-LIST driven by one `makeIsDeclared`
  predicate; every diff invocation forces `-c diff.submodule=short --submodule=short --no-ext-diff
  --no-textconv -c core.quotePath=false`; the emitted-patch HEADER backstop fails closed on any
  undeclared path. Confirm the CARRIED-FORWARD, previously-UNTESTED cases: a repo-configured
  clean/smudge FILTER (`.gitattributes`) and `core.autocrlf`/`eol`/`text` attributes under
  `--working-tree` cannot re-expand a declared path into UNDECLARED descendants nor make
  board/ambient prose reach the diff; an empty-after-filter diff dies loudly.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-BUG-120-186-r8.txt --run "node scripts/verify-bug-186-diff-strip.mjs" --test-file scripts/verify-bug-186-diff-strip.mjs --test-file src/server/cleanroom-surface.mjs --timeout-min 22 --verdict-out /tmp/verdict-BUG-120-186-r8.txt`
- **Verdict: BROKEN (VALID, manifest-backed) — but the BUG-186 DIFF ROUTE HELD ENTIRELY.** The
  combined BROKEN verdict is a SCOPE-1 room-containment defect (kept internal symlinks — four
  findings; see BUG-120's round-8 entry), NOT a diff leak. The carried-forward clean/smudge + EOL
  cases this ticket was waiting on were exercised and PASSED:
  - The `working-tree-filter-eol-descendants` adversarial case (run 7d7dd21ded3d, exit 0) combined
    executed clean/smudge filters AND `autocrlf`/`text`/`eol` attributes with a file→directory
    replacement holding an ambient descendant: the emitted patch shipped only the declared code
    (`src/code.mjs` change + `src/widget` deletion) — NO undeclared descendant, no board/ambient
    prose. The empty-after-filter diff was refused (exit 2, "nothing for the verifier to attack").
  - All earlier diff cases stay green in the fixer suite run (route B: deletions, non-ASCII `café.md`,
    trailing-space, 800-file ARG_MAX; the submodule `--submodule=short` override; the file→dir subset
    + emitted-patch-header post-condition). Fixer suite 60/61 (only the no-`.git`-in-room real-tree
    check (F) UNTESTED, as every prior round).
- **Verified-by:** dispatch openai run 01a0f932-dd81-7c23-8eca-f6be0fdb34c2 (clean-room,
  `scripts/independent-verify.mjs`, cross-provider — author anthropic, verifier openai) — VERDICT:
  BROKEN. (Typed proof in verification-ledger.json; this line is the prose echo.)
- **Status:** stays OPEN (shared file, combined BROKEN verdict). The DIFF route needs no further fix
  from this pass — the carried-forward clean/smudge + autocrlf/eol UNTESTED items are now confirmed
  held. It rides the next fix round's cross-provider re-verify once BUG-120's kept-internal-symlink
  containment holes (reserved-`.vrun`-before-audit, O_NOFOLLOW-leaf-only vs a symlinked `.bin` parent,
  recorder-child write path) are closed. High-stakes (verification-integrity, regression-prone file)
  — keep the cross-provider independent pass before VERIFIED.
- **Symptom of a deeper design flaw?** yes → same class under ARCH-010 with BUG-120 (a writer/route
  that can bypass the one declared containment guard); the kept-internal-symlink parent-redirect is a
  new instance, SCOPE-1 not diff.

### 2026-10-02 — BUG-186 round-8 verifying lane
- **Verification recorded:** dispatch openai/codex run 01a0f932-dd81-7c23-8eca-f6be0fdb34c2 — VERDICT: HOLDS — scope 2 (diff route) HELD; the earlier BROKEN for this run was BUG-120's room-containment scope in the shared combined dispatch, not the diff route. Typed entry in verification-ledger.json; this line is an echo, not proof.
