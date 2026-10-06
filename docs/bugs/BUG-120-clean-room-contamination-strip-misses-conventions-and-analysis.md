```orchard-ticket
{
  "id": "BUG-120",
  "type": "bug",
  "title": "Independent verifiers can read the plans they are meant to check",
  "summary": "The isolated workspace used for independent checks removes only two documentation folders. Conventions, architecture notes, in-flight analysis, the task list and handover notes all travel in. A checker meant to attack a change from outside can therefore read the plan the author worked from, and the verdict never says what it was allowed to read.",
  "impact_if_we_wait": "Independent verdicts are weaker than they appear, because a checker can grade work against the same expectations that produced it. Bounded: this is passive exposure, with no evidence that any past checker read those files or that any past verdict is wrong.",
  "current_need": "Build the inversion here: the clean room receives only what a check names as an input, and each verdict records what it was given.",
  "severity": "medium",
  "area": "Verification isolation",
  "reported": "2026-08-19",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-01",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-19",
      "question": "Should the isolation rule be inverted here, or folded into the earlier open ticket on the same boundary?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "A",
      "chosen_on": "2026-08-25",
      "chosen_by": "user, through the ARCH-010 class decision",
      "note": "ARCH-010's third success criterion settles this without a separate session: a list that names what to leave out is a reader working out what is safe from a list that cannot know. The owner of a check names its inputs instead. B would fold the work into BUG-104, which stays open on a different question, and this ticket's own note is that naming the leaked folders is what failed twice already."
    }
  ],
  "success_criteria": [
    "A document not named as an input is absent from the isolated workspace",
    "Adding a new project document requires no change to the isolation rule",
    "Each verdict records the files the workspace was given"
  ],
  "code_refs": [
    {
      "path": "scripts/independent-verify.mjs",
      "symbol": "CONTAMINATION",
      "note": "strips docs/prompts and docs/bugs only; surfaced during a cross-provider round on commit 74e03e2 and filed as BUG-120"
    }
  ],
  "related": [
    {
      "id": "BUG-104",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-121",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "BUG-104"
  ],
  "verification": [
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a0ea7a-c6d5-7fe0-bbfd-2e659cdf8bc0",
      "verdict": "broken",
      "raw_verdict": "broken",
      "verdict_on": "2026-09-29",
      "harness": "scripts/independent-verify.mjs",
      "line_sha256": "b3bac6d0fad6055a0c2752f50b53c197dfd6b942f83fe9869d9c7d26b45c2243",
      "origin": "legacy-prose-freeze"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a0ec1b-595f-7961-8944-b8e2cc5e7c28",
      "verdict": "broken",
      "raw_verdict": "broken",
      "verdict_on": "2026-09-29",
      "harness": "scripts/independent-verify.mjs",
      "line_sha256": "40ca26eddfd42ddc877a7e95d2ef2bff135421b212b23c6debb0bdd19e78c0aa",
      "origin": "legacy-prose-freeze"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a0ee84-111e-7c92-b33b-53e0c1852052",
      "verdict": "broken",
      "raw_verdict": "broken",
      "verdict_on": "2026-09-29",
      "harness": "scripts/independent-verify.mjs",
      "line_sha256": "a290f5795df31a33a9228f4462012363e08844ec9bd3eb302752ec43a4f30592",
      "origin": "legacy-prose-freeze"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a0f251-a10a-70c2-8886-93b434e87d05",
      "verdict": "broken",
      "raw_verdict": "broken",
      "verdict_on": "2026-09-30",
      "harness": "scripts/independent-verify.mjs",
      "line_sha256": "7b33ce4cb6ea938121852593ccc887cbacc7af2f62784b30dac7183effb6794b",
      "origin": "legacy-prose-freeze"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a0f70f-ac76-7ba2-8091-4be62b1ca46a",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T10:47:28.991Z",
      "author": "BUG-120/186 round-5 clean-room verify lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "5b2e5a07-929e-40b6-83b4-8fa0776b05fe",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T11:04:50.437Z",
      "author": "BUG-120/186 round-6 clean-room verify lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "same-provider (second Anthropic account; OpenAI exhausted till 2026-10-05); cross-provider re-verify due after 2026-10-05; BROKEN — submodule diff.submodule=diff leaks board/ambient prose, seed-before-audit containment breach, AGENTS.override.md ambient gap"
    },
    {
      "provider": "openai",
      "model": "codex",
      "run_id": "01a0f923-ace6-7432-a676-ab5318515fd7",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T20:27:35.192Z",
      "author": "BUG-120/186 round-7 clean-room verify lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "cross-provider openai (author anthropic); recorder .vrun/alive heartbeat writer bypasses safeWriteInRoom and follows a committed INTERNAL symlink (.vrun/alive -> ../src/code.mjs, left by auditSymlinks which only removes escaping links) to overwrite declared code; diff route held"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a0f932-dd81-7c23-8eca-f6be0fdb34c2",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T20:45:46.693Z",
      "author": "BUG-120/186 round-8 clean-room verify lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "cross-provider openai (author anthropic); combined shared file; VALID manifest-backed. BUG-186 diff route HELD (clean/smudge+autocrlf/eol under --working-tree). SCOPE-1 containment BROKEN: KEPT internal symlinks (escaping .vrun removed before reserved check; recorder/.bin symlink writes clobber)"
    }
  ],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-120-clean-room-contamination-strip-misses-conventions-and-analysis.md",
    "sha256": "80faae85c8d53a1eac6d254a615964b36bdeea6d0588daef4ea37073135d42ae",
    "bytes": 4146,
    "original_title": "the clean room strips only two doc dirs, so CONVENTIONS, TODO, HANDOVER and docs/analysis survive into every independent verification",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the five leaked paths, the deny-list-versus-allow-list argument, the input-recording requirement, the prior instance and the bound are all present.",
    "dropped": [
      "the note that the filing lane did not touch the verify script and attempted no fix",
      "the note that the ticket was not yet in the board index pending a board regeneration"
    ]
  }
}
```

# BUG-120 — Independent verifiers can read the plans they are meant to check

## Diagnosis

The clean room's `CONTAMINATION` strip is a deny-list naming `docs/prompts` and `docs/bugs`. Everything else under `docs/` and at the repo root survives, including at least `docs/CONVENTIONS.md`, `docs/ARCHITECTURE-REVIEW.md`, `docs/analysis/`, `TODO.md` and `HANDOVER.md`. These carry the project's methodology, its architectural conclusions, its in-flight plans and its handover notes — exactly the frame a clean-room verifier is supposed to work outside of.

A deny-list is wrong here by construction: it must be updated whenever the project grows a new document, and nothing fails when it is not. That is how these five entered. BUG-104 was the same defect one directory over, and it was answered by naming the two directories that had leaked rather than by inverting the rule.

Whether a deny-list guarding an isolation boundary warrants an architecture ticket of its own, or belongs inside BUG-104's scope, is for whoever picks this up.

## Evidence

Running `node scripts/independent-verify.mjs` for any ticket and inspecting the room's working tree shows `docs/CONVENTIONS.md`, `docs/ARCHITECTURE-REVIEW.md`, `docs/analysis/`, `TODO.md` and `HANDOVER.md` present. Nothing has been run to establish whether a past verifier actually read any of them; the room reports only PASS or BROKEN and never what it was allowed to read.

## Implementation notes

The strip becomes an allow-list: a file enters only because something named it as necessary input. The room should additionally record the set of files it was given, so a verdict can be read against its own inputs.

## Verification plan

Add a document under `docs/` that no input list names, run a clean-room pass, and assert it is absent from the room's tree. Assert the recorded input manifest matches the tree.

## Risks

An input list that omits a genuinely required file produces a verification failure that looks like a real defect.

## Activity log (APPEND-ONLY)

### 2026-08-19 — ticket-view content-loss lane

- **Understood:** an independent cross-provider round on `74e03e2` reported that
  the clean room's `CONTAMINATION` strip covers `docs/prompts` and `docs/bugs`
  only, so `docs/CONVENTIONS.md`, `docs/ARCHITECTURE-REVIEW.md`, `TODO.md`,
  `HANDOVER.md` and `docs/analysis/` reach every verifier. The coordinator ruled
  it out of that lane's scope and asked for it to be filed.
- **Changed:** nothing. This ticket only.
- **Verified:** nothing — not investigated in code. The finding is the verifying
  round's, reported second-hand and recorded verbatim rather than re-derived.
- **Still open:** all of it. Confirm the current strip list in
  `scripts/independent-verify.mjs`, decide allow-list vs deny-list, and decide
  whether this folds into BUG-104 or stands alone.
- **Handoff:** next agent should start by reading BUG-104 rather than this
  ticket's Expected section — that ticket already argued the boundary once, and
  the useful question is why the fix there did not generalise, not what to strip
  next.

### 2026-09-29 — plan + hypothesis verified against source (BUG-120 + BUG-186 build lane)

- **Scope:** bundled with BUG-186 (same file, `scripts/independent-verify.mjs`). One lane,
  serialized. No collision: `git diff scripts/independent-verify.mjs` is empty, the file is clean
  per the 2026-09-29 triage, and no live session holds it (checked `/api/sessions/live`).
- **Hypothesis (the orchestrator's, verified FIRST against the code before building):** one declared
  input set can drive BOTH the room strip and the diff pathspec; no per-check schema is needed.
  **Verdict: HOLDS.** Why it holds and does not hit the "two cannot share one source" trap the
  charter warned about:
    - The room MUST contain the whole non-prose tree to run the tests (src/, scripts/, public/,
      node_modules) — so a literal "only declared files" allow-list over ALL files is impossible.
      The contamination the deny-list ever named was only ever PROSE: ambient-instruction files
      (`CLAUDE.md`, `.claude`, …) + the project's methodology/board (`docs/…`). Code is the subject,
      never contamination. So the inversion is over the PROSE surface: strip ALL of it, allow-list
      back only what a check names.
    - A prose path is either contaminating (methodology/board — must never reach the verifier, in
      the room OR the diff) or a legitimate declared input (the verifier MAY see it — fine in BOTH
      room and diff). The charter's feared case — "a check needs a prose input in the room that the
      diff must still hide" — would require needing `docs/bugs` (say) present-but-hidden, which
      directly contradicts BUG-120 (methodology must not be in the room at all). It does not arise.
      So the allowed set = "what the verifier may see" drives room-keep AND diff-include from ONE
      source; the complement (strip surface) drives room-strip AND diff-exclude from that same
      source. Confirmed no current caller passes any prose input (`rg` over the callers): the
      shipping path is allowed-set = ∅, room strips all prose, diff excludes all prose.
- **Design (ARCH-010: fact owned once, read by both readers):**
    1. New sibling declaration `src/server/cleanroom-surface.mjs` (+ `.d.mts`), beside
       `seed-sources.mjs`, owns the project's PROSE ROOTS — `['docs']`. A root, not a per-file list,
       so any doc added under `docs/` is covered forever with no edit here (success criterion #2).
       Read out of the ROOM's own copy (revision under test), exactly like `declaredBootDocs`.
    2. The universal ambient-instruction surface (`CLAUDE.md`, `AGENTS.md`, `.claude`, `.codex`,
       `.cursorrules`, `.github/copilot-instructions.md`) stays a tool-side constant
       (`AMBIENT_INSTRUCTION_PATHS`) — it is a property of the agent CLIs, not of any project, and
       must apply even to a foreign repo with no declaration. A repo lacking the module falls back
       to `DEFAULT_PROSE_ROOTS = ['docs']` (the conventional prose home) so foreign repos stay safe.
    3. `stripCleanroom(dir, { proseRoots, allowed })` (exported) strips ambient + the direct children
       of each prose root, minus `allowed`; reports the leaf paths it removed (keeps the honest
       stderr line and the two existing suites' assertions green — e.g. `docs/prompts` still named).
    4. `--allow-input <repo-rel-path>` (repeatable, default none): a path a check declares it needs.
       NOT stripped from the room, NOT excluded from the diff, RECORDED. Missing declared input →
       `die()` (harness error, exit 2), never a product FAIL (charter requirement).
    5. BUG-186: `fullDiff` becomes `git diff base head -- . ':(exclude)<root/ambient>' …` built from
       the SAME (surface, allowed) the room used — never a second list. A now-empty diff (a
       docs-only change) dies "nothing to verify after excluding board/methodology" rather than
       leaking it.
    6. Success criterion #3: write `room-manifest.json` (base/head, stripped surface, allowed inputs,
       diff-exclude pathspecs) into the record dir the verdict already cites, and print a
       "clean-room inputs" line on `--print-prompt` and normal runs.
- **Proofs (must-FAIL anchored to a synthesized pre-fix construction, not HEAD):**
    - `scripts/verify-bug-186-diff-strip.mjs` — a fixture with a `docs/bugs` edit + a code edit:
      the UN-excluded `git diff` (the old construction) carries the `docs/bugs` hunk (must-FAIL
      proof it has something to leak); `--print-prompt` carries none of it (PASS-after); and the
      real dirty Orchard tree via `--working-tree --print-prompt` shows no `docs/bugs/` path in the
      diff and a `room-manifest.json` listing the inputs.
    - Anti-regression: `verify-independent-verification.mjs` (section C), `verify-bug-182-cleanroom-
      boot-stubs.mjs` (imports the strip surface — updated to the new API, behaviour identical),
      `npm run board:check`.
- **Risk / independent verify:** this is verification-integrity tooling — I do NOT verify it myself.
  A cross-provider independent verify pass is warranted (session-lifecycle-adjacent, regression-prone
  file). Flagged for the orchestrator.

### 2026-08-25 — settled by the class decision (ARCH-010 option A); no build in this lane

- **Understood:** this ticket's open question — invert the rule here, or fold it into BUG-104 — is
  answered by the class decision the user took on 2026-08-25, whose third success criterion is that
  exclusion lists naming what to leave out are replaced by lists naming what to let in. Folding it
  into BUG-104 was the alternative, and BUG-104 stays open on a genuinely different question (what
  to do about real methodology and ticket text quoted inside verify scripts), so folding would park
  this behind a decision that does not contain it.
- **Re-measured before recording it.** `scripts/independent-verify.mjs:218-222` still holds a
  `CONTAMINATION` array naming eleven paths to delete, applied by an `fs.rmSync` loop at `:352-355`.
  `HANDOVER.md`, `docs/CONVENTIONS.md` and `docs/analysis/` still travel into the room — the exact
  complaint above, unchanged since 2026-08-19. Of the three sites the class decision names, one is
  already inverted (`scripts/leak-gate.mjs:73`, `IMG_ALLOW`, which is what an inverted rule looks
  like here) and the third, `scripts/wa-consolidate.mjs:279` (`PROJECT_MARKERS`), is still a
  hand-written marker list and belongs to BUG-042 rather than to this ticket.
- **Changed:** this ticket's record only — decision moved to `decision_history` with A chosen,
  `human_action` → `none`, `current_need` states the build. No code, no scripts. `work_state` stays
  `open` because nothing has been built.
- **Verified:** `validateTicket` ok; `npm run board:check` exit 0, read directly.
- **Still open / handoff:** all of the build, and it is the one piece of this class that touches
  verification integrity — a room starved of a file it genuinely needed reports a false failure
  that looks exactly like a real one, so the named-inputs list has to be derived from what each
  check actually reads, and the verdict must record what it was given. Nothing here changes the
  archived corpus or any past verdict.

### 2026-09-29 — BUILT (allow-list inversion + BUG-186 diff filter); NOT self-verified

(Follows the plan entry dated 2026-09-29 above. Bundled with BUG-186 — same file, one lane.)

- **Changed (all unstaged; the orchestrator does git):**
    - NEW `src/server/cleanroom-surface.mjs` (+ `.d.mts`) — the project's ONE declaration of its
      prose roots (`['docs']`), sibling to `seed-sources.mjs`, read out of the room's own copy.
    - `scripts/independent-verify.mjs` — `CONTAMINATION` deny-list replaced by
      `AMBIENT_INSTRUCTION_PATHS` (universal, tool-owned) + `declaredProseRoots()` (project-owned,
      read from the room) + `contaminationSurface()` + `stripCleanroom()` (exported). Room strips
      the whole prose surface minus the allow-list; boot stubs re-seed inert as before. New
      `--allow-input <path>` (default none). The verifier's diff is now
      `git diff base head -- . ':(exclude)…'` built from the SAME surface (BUG-186); a now-empty
      diff dies "nothing to verify after excluding the board/methodology surface". A
      `room-manifest.json` (prose roots, allow-list, stripped leaves, diff excludes) is written to
      the record dir and echoed on stderr (criterion 3).
    - `scripts/verify-bug-182-cleanroom-boot-stubs.mjs` — its `makeRoom` now calls the shipped
      `stripCleanroom` instead of iterating the removed `CONTAMINATION` const. Behaviour identical.
    - NEW `scripts/verify-bug-186-diff-strip.mjs` — the must-FAIL/PASS-after proof.
- **Verified (ran, exit read directly):**
    - `node scripts/verify-bug-186-diff-strip.mjs` — **13/13 PASS**. §1 MUST-FAIL: the pre-fix
      construction (`git diff base head`, no pathspec, run by hand — anchored to a synthesized
      construction, not HEAD) carries the `docs/bugs`, `docs/CONVENTIONS.md` and "PRIOR VERIFIER
      REFUTED" hunks. §2 the shipped `--print-prompt` diff carries none of them, keeps the code.
      §3 `room-manifest.json` records proseRoots/allow-list/excludes. §4 `--allow-input` re-includes
      a declared doc in both room and diff while the board stays out; a missing input exits 2
      (harness error). §5 `--working-tree` over a dirty board is clean. §6 the REAL dirty Orchard
      tree: no `docs/bugs/` path in the verifier's diff.
    - `node scripts/verify-independent-verification.mjs` — **152/152 PASS** (1 pre-existing SKIP,
      restricted-sandbox capability; unrelated). Section C (clean-room positive assertion) green.
    - `node scripts/verify-bug-182-cleanroom-boot-stubs.mjs` — **21/21 PASS**. Section (2) boots a
      real server healthy in a room with ALL docs stripped (not just the old three), proving the
      broader strip does not break boot; the graceful docs readers (board/guide/CONVENTIONS) are
      request/launch-time, never boot-time.
    - `npm run board:check` — OK, no drift. `npm run gate` — **PASS, exit 0** (leak-gate, check-nul,
      typecheck).
- **Success criteria (BUG-120):** (1) a doc not named as input is absent from the room — YES
  (whole prose surface stripped by default). (2) adding a new doc needs no isolation-rule change —
  YES (a root, not a per-file list; new docs under `docs/` auto-covered, proven by BUG-182 §3's
  class assertion still passing). (3) each verdict records what it was given — YES
  (`room-manifest.json` + stderr).
- **Still open / handoff:** NOT self-verified — this is verification-integrity tooling, so an
  INDEPENDENT cross-provider verify is warranted before VERIFIED (I wrote the fixtures; they test
  what I already thought of). Suggested attack surface: the `--allow-input` under-a-root git
  pathspec expansion (`contaminationSurface` + `git ls-tree`), and a repo whose prose lives outside
  `docs/` (falls back to `DEFAULT_PROSE_ROOTS`). Status left OPEN; INDEX untouched (orchestrator-owned).

### 2026-09-29 — INDEPENDENT clean-room verify (cross-provider) — VERDICT: BROKEN

- **Requirement (extracted to plain terms, not the fixer's prose):** the clean room must be an
  ALLOW-LIST over project prose — nothing under the declared prose roots (`docs/`, plus the
  universal ambient surface `CLAUDE.md`/`.claude`/`AGENTS.md`…) may reach the verifier's workspace
  unless a check explicitly names it as an allowed input; `docs/CONVENTIONS.md`,
  `docs/ARCHITECTURE-REVIEW.md`, `docs/analysis/` (the deny-list misses) absent by default; adding a
  new doc needs no isolation-rule change; each run RECORDS the inputs it was given.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @<req> --run "node scripts/verify-bug-182-cleanroom-boot-stubs.mjs" --test-file scripts/verify-bug-182-cleanroom-boot-stubs.mjs --test-file src/server/cleanroom-surface.mjs --timeout-min 20`
- **Verdict: BROKEN (VALID).** The verifier re-ran the fixer's suite (21/21 PASS) and then built an
  adversarial case the fixture never exercises: a non-empty allow-list naming ONE nested file under
  a prose subtree, alongside an undeclared sibling.
  - **FINDING:** `stripCleanroom` preserves the ENTIRE `docs/analysis` subtree when only
    `docs/analysis/required.json` is allow-listed, so the undeclared sibling `docs/analysis/private.md`
    reaches the verifier. The empty-allow-list control (the only case the fixer's suite covers)
    correctly removes it — which is why the fixer's 21/21 never caught it. The allow-list granularity
    is per-prose-root-child, not per-file: allowing any path under a direct child of a prose root
    spares that whole child directory, defeating success criterion #1 ("a document not named as an
    input is absent") whenever `--allow-input` names a file inside a subdir.
- **Verified-by:** dispatch openai run 01a0ea7a-c6d5-7fe0-bbfd-2e659cdf8bc0 (clean-room,
  `scripts/independent-verify.mjs`, cross-provider — author anthropic, verifier openai) —
  VERDICT: BROKEN.
- **Status:** stays OPEN. Handoff: the strip must remove undeclared siblings even when a sibling
  under the same prose-root child is allow-listed — allow-listing must be per-declared-path, not
  "keep the whole child dir that contains an allowed path". Re-verify with a non-empty `--allow-input`
  case after the fix.

### 2026-09-29 — round-2 FIX (with BUG-186); NOT self-verified
- **Understood:** round-1's `stripCleanroom` allow-list was per-DIRECT-CHILD of a prose root — it
  spared the whole `docs/analysis` subtree when only `docs/analysis/required.json` was allow-listed,
  leaking the undeclared sibling `docs/analysis/private.md` (openai run
  `01a0ea7a-c6d5-7fe0-bbfd-2e659cdf8bc0`).
- **Changed (`scripts/independent-verify.mjs`, unstaged):** `stripCleanroom` now prunes a prose
  subtree EXACTLY per declared path — a recursive `pruneProse` keeps a declared input and only the
  ancestor dirs needed to hold it, and removes every undeclared sibling at any depth. The diff side
  (`contaminationSurface`) mirrors it: when an input lives under a root it excludes every tracked
  file under that root except the declared one, LITERALLY (recursive `git ls-tree -r`). Same source
  both routes.
- **Verified (ran, exit read directly):** `node scripts/verify-bug-186-diff-strip.mjs` — 20/20
  PASS. Part A drives the verifier's exact case + the generalisation (an allowed nested file with
  ≥2 undeclared siblings AND a nested undeclared subdir): all undeclared siblings gone, the declared
  input kept, in the ROOM; Part C proves the same on the DIFF and that the empty-allow control still
  strips everything. Must-FAIL synthesises the round-1 per-child rule inline and shows it would
  spare `docs/analysis`. Anti-regression: `verify-bug-182-cleanroom-boot-stubs` 21/21,
  `verify-independent-verification` 152/152, `npm run gate` PASS exit 0, `board:check` exit 0.
- **Success criteria re-checked:** (1) a doc not named as input is absent — YES, now at ANY depth
  even under an allow-listed subtree; (2) adding a doc needs no rule change — YES; (3) each verdict
  records what it was given — YES (`room-manifest.json`, now with recursive diff-exclude globs).
- **Self-named attacks / residual:** see BUG-186's 2026-09-29 round-2 entry (symlink sibling,
  escaping symlink via `auditSymlinks`, glob-metacharacter filename — all closed; a content-
  identical copy under a non-prose name is a structural-surface limitation, declined by design).
- **Still open / handoff:** NOT self-verified — re-verify cross-provider before VERIFIED. Status
  OPEN; INDEX untouched (orchestrator-owned).

### 2026-09-29 — INDEPENDENT clean-room verify round 2 (cross-provider, openai) — VERDICT: BROKEN
- **Requirement (plain terms + reframed attack, not the fixer's prose):** the room is an ALLOW-LIST
  over project prose — the whole declared prose surface (`docs/` roots + universal ambient
  `CLAUDE.md`/`AGENTS.md`/`.claude`/`.codex`/… ) is removed and only an `--allow-input` path is
  re-included; a doc not named as input is absent at ANY depth; a genuinely declared input STILL
  reaches the room; a missing declared input is a harness error, not a product FAIL; the run RECORDS
  what it was given. Reframed for the NEW design (past round 1's per-child case): recursive `**/`
  matching at edge names (case-fold, dotfiles, glob-metachar, spaces); the per-file
  `:(exclude,literal)` list AT SCALE + the command-line-length limit; can the NEW post-strip
  assertion be BYPASSED and does a declared input still reach the room; symlinks inside prose dirs;
  the declined content-identical-copy-under-a-non-prose-name residual (note reachability, not a fail).
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-BUG-120-r2.txt --run "node scripts/verify-bug-186-diff-strip.mjs" --test-file scripts/verify-bug-186-diff-strip.mjs --test-file src/server/cleanroom-surface.mjs --timeout-min 22`
- **Verdict: BROKEN (VALID).** Re-ran the fixer's suite (18/19 in the room — check (D), the real-tree
  `--print-prompt`, cannot run because a `git archive`-exported room has no `.git`; expected, noted
  UNTESTED) and built adversarial cases the fixture never exercises (mixed-case/dotfile/space/
  glob-metachar edge names, ambient dir SYMLINK, node_modules ambient, ambient-named `--allow-input`,
  fault-injected prose symlink leftover, 800-file scale). Edge names, escaping symlinks and the
  ARG-scale short-path case all held; five FINDINGs broke it:
  - **FINDING:** an internal `.claude` DIRECTORY SYMLINK survives both the strip and the post-strip
    assertion (its prose stays readable) — the strip's ambient walk and the assertion only test
    `isAmbientFile` on a symlink node, never `isAmbientDir`, so a symlink named `.claude` is neither
    removed nor flagged.
  - **FINDING:** `node_modules/pkg/AGENTS.md` survives — the strip walk skips `node_modules`, so an
    ambient-named file inside a dependency is neither stripped nor flagged (bounded: agent CLIs do
    not discover instruction files inside `node_modules`, so real reachability is low — but it is a
    hole in the stated "universal ambient surface removed at any depth" invariant).
  - **FINDING:** `--allow-input <ambient-named file>` (e.g. `docs/AGENTS.md`) is accepted, then
    removed by the unconditional ambient strip, and the CLI exits 0 with the declared input ABSENT
    from the room — violating "a declared input still reaches the room" / "a missing input is a loud
    harness error". If an ambient name is deliberately non-allow-listable (as the code comment says),
    the run must die naming it, not silently drop it.
  - **FINDING:** with removal fault-injected, the post-strip assertion correctly rejects a regular
    prose leftover but ACCEPTS a readable undeclared prose SYMLINK — the assertion's symlink branch
    only checks `isAmbientFile`, not prose location, so a symlink under a prose root is not flagged.
  - **FINDING (diff route, shared with BUG-186):** 800 long prose siblings under a root with one
    allow-listed input produce ~2.34 MB of `:(exclude,literal)` pathspec bytes and `git diff` fails
    to spawn with E2BIG (ARG_MAX 2,097,152). The per-file enumeration has no batching/`--pathspec-
    from-file` fallback, so a large prose tree with a declared input breaks the diff.
- **Verified-by:** dispatch openai run 01a0ec1b-595f-7961-8944-b8e2cc5e7c28 (clean-room,
  `scripts/independent-verify.mjs`, cross-provider — author anthropic, verifier openai) —
  VERDICT: BROKEN.
- **Status:** stays OPEN. Handoff: (1) treat an ambient-named node as ambient regardless of type —
  strip AND flag an ambient-named symlink/dir at any depth; (2) either allow-list an ambient input
  explicitly or die naming it, never silently drop it; (3) extend the post-strip assertion to flag
  undeclared prose symlinks (location, not just ambient-file name); (4) decide node_modules ambient
  scope; (5) batch/`--pathspec-from-file` the per-file exclusions so a large declared-input prose
  tree does not hit ARG_MAX. Re-verify these cases after the fix. High-stakes (verification-integrity
  tooling, regression-prone file) — keep the cross-provider independent pass.

### 2026-09-29 — round-3 REDESIGN (one predicate; with BUG-186); NOT self-verified

- **Understood:** three rounds of one class — a string-built pathspec and a hand walk each had
  their OWN model of the tree that disagreed with git's on edge cases (`.claude` symlink,
  node_modules ambient, ambient `--allow-input`, prose symlink, 800-file ARG_MAX, plus BUG-186's
  deleted/quoted/space names). Patching cases loses. The redesign removes the SECOND decision point.
- **The redesign (in `scripts/independent-verify.mjs`):** ONE predicate `makeIsDeclared(path)` (+
  `isAmbientPath`) is the sole decision for EVERY route, over byte-exact paths.
    - Room strip: an `fs.readdirSync(withFileTypes)` (lstat) walk of the WHOLE tree — node_modules
      included (provisioned BEFORE the strip so the walk covers it) — that judges each entry by the
      predicate on its own path and NEVER follows a symlink. A `.claude` symlink/dir/file is ambient
      by name regardless of type (fixes findings 1, 2, 4-room).
    - Post-strip assertion: the SAME lstat walk + SAME predicate (so a surviving prose symlink or
      nested ambient is flagged, finding 4).
    - `--allow-input` that names an ambient path is now a HARD ERROR naming it, never a silent drop
      (finding 3). An ambient path can never be declared, even if allow-listed.
    - Diff route: `git diff --name-only -z --no-renames base head` (NUL, byte-exact, no quoting,
      deletions + both rename sides) → filter in JS by the predicate → emit the diff limited to the
      ALLOWED paths as LITERAL pathspecs (`GIT_LITERAL_PATHSPECS`), batched under ARG_MAX. An
      allow-list, so no exclusion strings, no ARG_MAX (finding 5), no quoting/deleted/space edge
      (BUG-186 findings 6-8). (`git diff` does NOT accept `--pathspec-from-file`, exit 129 — verified;
      literal command-line pathspecs via argv are byte-exact and used instead.)
- **Verified (ran, exit read directly):** `node scripts/verify-bug-186-diff-strip.mjs` — 22/22 PASS.
  Includes an exhaustive predicate unit-test over edge names (café/space/newline/brackets/nested
  ambient/node_modules), all 8 findings as must-FAIL-before/PASS-after (round-2 constructions
  synthesised inline), and self-named attacks (rename across the prose boundary — code→prose ADD
  excluded, prose→code ADD is the declared structural residual; case-only rename; newline filename;
  800-file ARG_MAX). Anti-regression: `verify-independent-verification` 152/152,
  `verify-bug-182-cleanroom-boot-stubs` 21/21 (boots a server with the whole docs root stripped).
- **`npm run gate`:** leak-gate FAILS only on `scripts/_diag-b203.mjs` — an untracked stray from
  ANOTHER lane carrying a home path, not mine; my changed files are leak-clean (scanned). `check-nul`
  and `typecheck` PASS. `npm run board:check` exit 0.
- **Declined residuals (named for the skeptic):** (a) content-identical methodology COPIED or RENAMED
  under a non-prose, non-ambient path is reachable — the surface is structural (name + location) by
  design, not content-addressed; (b) node_modules is now walked, adding cost (~one extra full walk)
  and the theoretical risk of removing a dependency's own ambient-named file — accepted as the
  coordinator directed ("walk everything"), reachability of a CLI reading node_modules instructions
  is nil; (c) submodules: a gitlink path is judged by the predicate like any path; a submodule's
  internal files are not in the parent diff, so not specially handled.
- **Still open / handoff:** NOT self-verified — re-verify cross-provider before VERIFIED. Status
  OPEN; INDEX untouched (orchestrator-owned).

### 2026-09-29 — INDEPENDENT clean-room verify round 3 (cross-provider, openai) — VERDICT: BROKEN
- **Requirement (plain terms + reframed attack for the round-3 REDESIGN, not the fixer's prose):**
  the room is an ALLOW-LIST over the declared prose surface driven by ONE predicate
  `makeIsDeclared` — a doc not named as `--allow-input` is absent at any depth; a genuinely declared
  input STILL reaches the room; an `--allow-input` naming an ambient path is a HARD ERROR naming it,
  never a silent drop; the run records what it was given. Reframed for the redesign: can any route
  bypass `makeIsDeclared`; the lstat walk over node_modules (perf + a symlink LOOP; it must not
  follow symlinks); allow-list granularity (undeclared siblings gone at any depth); and the ambient
  `--allow-input` hard error against a CASE-VARIANT / `./`-prefixed / trailing-slash / `..`-segment
  name. Citation example (filled shape) provided in the requirement file.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-BUG-120-r3.txt --run "node scripts/verify-bug-186-diff-strip.mjs" --test-file scripts/verify-bug-186-diff-strip.mjs --test-file src/server/cleanroom-surface.mjs --timeout-min 22`
- **Verdict: BROKEN (VALID).** Re-ran the fixer's suite (21/22 in the room — check (F), the real-tree
  `--print-prompt`, cannot run in a `git archive` room with no `.git`; expected, noted UNTESTED) and
  built the ambient case-variant / `..`-segment cases the fixture never exercises. The `./`-prefixed,
  trailing-slash and lowercase-exact ambient inputs all correctly died (exit 2, naming the path);
  two FINDINGs broke it:
  - **FINDING:** `--allow-input .CLAUDE` (uppercase) exits 0 and RETAINS `.CLAUDE/settings.json` —
    the ambient match is CASE-SENSITIVE, so a case-variant ambient name slips past BOTH the
    `--allow-input` hard-error guard AND the strip, and the undeclared ambient dir survives into the
    room. (The lowercase `.claude` and mixed-case `docs/Claude.md` were correctly refused, exposing
    the inconsistency: ambient FILE names are matched case-insensitively but ambient DIR names are
    not.)
  - **FINDING:** `--allow-input docs/a/../keep.json` passes existence validation (the fs stat
    resolves the `..`), exits 0, but the predicate compares the un-normalised literal path, so it
    strips the real `docs/keep.json` — silently LOSING the declared input (the canonical
    `docs/keep.json` control survives, proving the loss is the `..` path handling).
- **Verified-by:** dispatch openai run 01a0ee84-111e-7c92-b33b-53e0c1852052 (clean-room,
  `scripts/independent-verify.mjs`, cross-provider — author anthropic, verifier openai) —
  VERDICT: BROKEN.
- **Status:** stays OPEN. Handoff: (1) match ambient DIR names case-insensitively (and consistently
  with the file-name match) so a case-variant ambient path is both refused as an input and stripped;
  (2) NORMALISE the `--allow-input` path (resolve `..`/`.`) before the predicate compares it, so a
  legitimately declared input carrying a `..` segment is not silently stripped. Re-verify the
  case-variant ambient and `..`-segment allow-input cases after the fix. High-stakes
  (verification-integrity tooling, regression-prone file) — keep the cross-provider independent pass;
  an independent clean-room verify remains warranted before VERIFIED.

### 2026-09-29 — round-4 FIX (canonicalise + case-insensitive ambient; with BUG-186); NOT self-verified

- **Understood (openai run `01a0ee84…`, 2 findings):** (1) `--allow-input .CLAUDE` (uppercase)
  bypassed both the ambient hard error and the strip because ambient DIR matching was
  case-sensitive while FILE matching was insensitive; (2) `--allow-input docs/a/../keep.json` passed
  the fs existence check (which resolves `..`) but the predicate compared the raw literal, so the
  real `docs/keep.json` was stripped — a SILENT loss of a declared input.
- **Changed (`scripts/independent-verify.mjs`):**
    - `isAmbientDir` is now case-INSENSITIVE (matching `isAmbientFile`), so `.CLAUDE`/`.Codex` are
      ambient at any case — the hard error and the strip both catch them (finding 1).
    - New `canonicalizeDeclared()` resolves every `--allow-input` ONCE at intake to a repo-relative
      POSIX path (`.`/`..`/`//`/trailing-slash collapsed) and REFUSES an absolute or repo-escaping
      path; every later comparison (ambient check, predicate, strip, diff) sees that one canonical
      string (finding 2).
    - New mirror post-condition: after the strip, every declared input MUST still exist in the room,
      else die — so a symlinked-parent declared path (the room does not follow symlinks) or any
      residual loss is a LOUD harness error, never a silent one.
- **Verified (ran, exit read directly):** `node scripts/verify-bug-186-diff-strip.mjs` — **32/32
  PASS**. New (G): finding 1 (uppercase `.CLAUDE` hard error + case-sensitive must-FAIL synth),
  finding 2 (`..` canonicalises, real file shown + must-FAIL synth of the un-normalised compare),
  generalisations (`./` prefix, trailing slash accepted; an escaping path refused), and a
  symlinked-parent declared path → loud "lost a declared input" (never silent). Anti-regression:
  `verify-independent-verification` 152/152, `verify-bug-182-cleanroom-boot-stubs` 21/21.
- **`npm run gate`:** PASS exit 0 (leak-gate + check-nul + typecheck). `npm run board:check` exit 1
  — the ONLY failure is `FEAT-157`'s unparseable decision (another lane's ticket), NOT my tickets or
  a drift I introduced.
- **Still open / handoff:** NOT self-verified — re-verify cross-provider before VERIFIED. Status
  OPEN; INDEX untouched (orchestrator-owned).

### 2026-09-30 — INDEPENDENT clean-room verify round 4 (cross-provider, openai) — VERDICT: BROKEN

- **Requirement (plain terms + confirm-cases, not the fixer's prose):** the clean room is an
  ALLOW-LIST over the declared prose surface; `canonicalizeDeclared()` reduces every `--allow-input`
  once at intake and refuses an absolute or repo-escaping path; ambient DIR names match
  case-insensitively (`.CLAUDE`/`.Codex` refused as inputs AND stripped); a missing-declared-input
  post-condition dies LOUDLY when a declared input is not present after the strip. Confirm-cases
  asked: canonicalizeDeclared cannot be bypassed by symlinks / unicode lookalikes / NFC-NFD forms /
  `..`-`.`-`//`-trailing-slash variants; the missing-input post-condition FIRES for a declared
  DIRECTORY that is emptied. A filled-in citation-block example was provided in the requirement file.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-BUG-120-r4.txt --run "node scripts/verify-bug-186-diff-strip.mjs" --test-file scripts/verify-bug-186-diff-strip.mjs --test-file src/server/cleanroom-surface.mjs --timeout-min 22`
- **Verdict: BROKEN (VALID).** Re-ran the fixer's suite (31/32 in the room — the real-tree
  `--print-prompt` check cannot run in a `git archive` room with no `.git`; expected, noted
  UNTESTED). The unicode/case/normalisation confirm-case HELD (NFC/NFD/Cyrillic-homoglyph siblings
  kept byte-exact without leaking a sibling; absolute/`..`-escaping/ambient case-variant inputs all
  correctly refused; mixed-case ambient dirs stripped). Two FINDINGs broke it:
  - **FINDING:** declaring a DIRECTORY whose only contents are ambient (`--allow-input docs/empty`
    with `docs/empty/AGENTS.md` inside) exits 0 after the ambient file is stripped, leaving the
    declared directory EMPTY — the missing-declared-input post-condition does NOT fire for an
    emptied declared directory (it checks path existence, and the now-empty dir still exists), so
    the charter's confirm-case is REFUTED: an emptied declared directory does not die loudly.
  - **FINDING:** `--allow-input docs/self.md` where `docs/self.md` is a symlink to an existing
    OFF-TREE file exits 0 even though `auditSymlinks` (escaping-symlink cleanup) removes that
    declared input — the final room lacks it, a SILENT loss the post-condition should have caught.
    (Its sibling control `docs/parent/secret.md` under a symlinked parent DID correctly die,
    confirming the gap is specifically the declared-file-is-itself-an-escaping-symlink path.)
- **Verified-by:** dispatch openai run 01a0f251-a10a-70c2-8886-93b434e87d05 (clean-room,
  `scripts/independent-verify.mjs`, cross-provider — author anthropic, verifier openai) —
  VERDICT: BROKEN.
- **Status:** stays OPEN. Handoff: (1) the missing-declared-input post-condition must also fire when
  a declared DIRECTORY is emptied by the strip (assert the declared path still holds content /
  survives as a non-empty declared input, not merely that the path exists); (2) a declared input
  that is itself an escaping symlink must be a LOUD error, not silently removed by `auditSymlinks`
  and left absent. Re-verify the emptied-declared-directory and escaping-symlink-declared-input
  cases after the fix. High-stakes (verification-integrity tooling, regression-prone file) — keep
  the cross-provider independent pass before VERIFIED.

### 2026-09-30 — round-5 FIX (post-condition on the FINAL room; with BUG-186); NOT self-verified

- **Understood (openai run `01a0f251…`, 2 findings — both GAPS IN THE POST-CONDITION, not intake
  special cases):**
    - **A — emptied declared directory.** `--allow-input docs/empty` whose only content is ambient
      (`docs/empty/AGENTS.md`) exited 0: the ambient strip emptied it, and the missing-input
      post-condition checked PATH EXISTENCE (`existsSync(docs/empty)` — the empty dir still exists),
      so it missed the loss.
    - **B — declared file is itself an escaping symlink.** `--allow-input docs/self.md` (a symlink
      to an off-tree file) exited 0 because the post-condition ran BEFORE `auditSymlinks`, which then
      removed the escaping declared symlink — a silent loss.
- **Fix — STRENGTHEN the post-condition (not an intake special case):**
    - Capture each declared input's real LEAF set (an lstat walk, files+symlinks, never followed) at
      intake, before the strip.
    - Move the declared-input check to run on the FINAL room (AFTER `auditSymlinks`) and assert every
      captured leaf still exists (by lstat). A declared directory emptied by the strip, or a declared
      escaping symlink the audit removed, now dies LOUDLY naming what was lost.
- **Verified:** `node scripts/verify-bug-186-diff-strip.mjs` — **40/40 PASS**. New (H): finding A
  (unit must-FAIL: round-4 `existsSync` passes for an emptied dir; CLI dies), finding B (unit
  must-FAIL: strip KEEPS the declared escaping symlink so the pre-audit check would pass; CLI dies
  after the audit), and the round-4 symlinked-parent case still dies. The openai confirm-cases that
  HELD (NFC/NFD/homoglyph byte-exact, absolute/escaping/ambient-case refused) stay green. Anti-reg:
  `verify-independent-verification` 153/153, `verify-bug-182` 21/21. `npm run gate` PASS exit 0.
- **`npm run board:check`:** DRIFT 3 — all OTHER lanes' tickets (BUG-201, FEAT-091, FEAT-126 prose
  verified-by records); my tickets are not among them.
- **Still open / handoff:** NOT self-verified — re-verify cross-provider before VERIFIED. Status
  OPEN; INDEX untouched.

### 2026-10-01 — INDEPENDENT clean-room verify round 5 (cross-provider, openai) — VERDICT: BROKEN

- **Requirement (plain terms + confirm-cases, not the fixer's prose):** every `--allow-input`
  path's real leaf set is captured at intake (lstat, files+symlinks, never followed) and re-checked
  on the FINAL room AFTER `auditSymlinks`; a declared input whose leaves change between intake and
  the final check (an emptied declared dir; a declared escaping symlink the audit removes) must die
  LOUDLY; a very large declared leaf set is handled; a declared input can NEVER be silently denied
  (present-and-intact, or a loud death — no exit-0-and-absent path); an ambient-named / absolute /
  repo-escaping `--allow-input` is refused at intake. A filled-in citation-block example was
  provided in `/tmp/req-BUG-120-r5.txt`.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-BUG-120-r5.txt --run "node scripts/verify-bug-186-diff-strip.mjs" --test-file scripts/verify-bug-186-diff-strip.mjs --test-file src/server/cleanroom-surface.mjs --timeout-min 22`
- **Verdict: BROKEN (VALID).** Re-ran the fixer's suite (39/40 in the room — the real-tree
  `--print-prompt` check cannot run in a `git archive` room with no `.git`; expected, correctly noted
  UNTESTED) and built an adversarial case the fixture never exercises: a declared input whose leaf
  path collides with a BOOT-STUB seed path, where boot-stub seeding runs AFTER the strip and the
  per-leaf survival check.
  - **FINDING:** `--allow-input docs/input` where `docs/input/AGENTS.md` is the directory's only
    content AND is a boot-stub seed path exits 0: the strip destroys the real file as contamination,
    boot-stub seeding RE-CREATES `docs/input/AGENTS.md` as an inert placeholder, and the final
    per-leaf check sees the leaf present (the placeholder) and accepts it — the declared input's real
    content is silently LOST while the run reports success. The per-leaf survival check tests leaf
    PRESENCE, not that the leaf is the captured original, so a boot-stub placeholder satisfies it.
  - **FINDING (worse, no allow-input):** with the same boot-stub arrangement and NO `--allow-input`,
    boot-stub seeding RESURRECTS the undeclared ambient file `docs/input/AGENTS.md` into the FINAL
    room after the contamination strip, and the run exits 0 — undeclared ambient prose survives into
    the verifier's room, defeating success criterion #1 ("a document not named as an input is absent
    from the room"). Boot-stub seeding is a second writer into the room that runs after the strip and
    re-introduces an ambient-named path the strip had removed.
- **Verified-by:** dispatch openai run 01a0f70f-ac76-7ba2-8091-4be62b1ca46a (clean-room,
  `scripts/independent-verify.mjs`, cross-provider — author anthropic, verifier openai) —
  VERDICT: BROKEN. (Typed proof recorded via `board-tool verified`; this line is the prose echo.)
- **Status:** stays OPEN. Handoff: boot-stub seeding runs AFTER the strip and the per-leaf survival
  check, so it can (1) satisfy the per-leaf check with a PLACEHOLDER that is not the captured
  original (the declared leaf's content is lost but present), and (2) re-introduce an ambient-named
  file the strip removed. Fix direction: run the per-leaf survival check AFTER boot-stub seeding and
  assert the leaf is the captured original (not a seeded placeholder), and/or re-strip ambient paths
  that boot-stub seeding creates, and/or forbid a boot-stub seed path from colliding with a declared
  prose/ambient leaf. Re-verify the boot-stub-leaf-collision and ambient-resurrection cases after the
  fix. The very-large-leaf-set and concurrent-mutation confirm-cases were NOT exercised (noted
  UNTESTED). High-stakes (verification-integrity tooling, regression-prone file) — keep the
  cross-provider independent pass before VERIFIED.

### 2026-10-01 — round-5 BUG-186 independent verify NOT RUN (openai quota-window)

- **Context:** BUG-120 and BUG-186 were to be verified sequentially in this lane (same uncommitted
  file). BUG-120's round-5 verify (run `01a0f70f…`) consumed the OpenAI window; the BUG-186 round-5
  dispatch then `dispatch failed [quota-window]` ("usage limit", retry 2026-10-05). So BUG-186's
  round-5 independent verify did not run and has no verdict — recorded as not-run in BUG-186's own
  log. Independent of that: BUG-120's round-5 verdict above is BROKEN, so this file needs another
  fix round regardless; a BUG-186 re-verify should ride the next fix round once the quota resets.

### 2026-10-01 — BUG-120/186 round-5 clean-room verify lane
- **Verification recorded:** dispatch openai run 01a0f70f-ac76-7ba2-8091-4be62b1ca46a — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — round-6 FIX (assertion is the final pipeline stage; content-hash; seeding guards); NOT self-verified

- **Understood (openai run `01a0f70f…`, BUG-120 REFUTED — a real structural gap):** boot-stub
  seeding is a SECOND writer into the room that ran AFTER the strip AND after the per-leaf survival
  check. So (a) a placeholder stub re-created at a declared input's leaf path satisfied the
  existence-only per-leaf check while the real content was lost, and (b) with no `--allow-input`,
  seeding RESURRECTED an undeclared ambient `docs/input/AGENTS.md` (declared as a boot-seed in the
  repo's seed-sources) into the final room — exit 0.
- **Every write to the room, in code order (enumerated per the charter) — now one pipeline, assertion LAST:**
  1. `git archive | tar -x` (export the reviewed tree)
  2. `provisionModules` (copy `node_modules` in)
  3. `stripCleanroom` (remove everything undeclared, at any depth)
  4. `seedBootStubs` (write inert boot placeholders)
  5. `auditSymlinks` (remove escaping symlinks)
  6. recorder: create `.vrun/` spool + write `vrun.mjs` (harness I/O — `isDeclared`-safe)
  7. **FINAL ASSERTION** — leftovers + per-leaf content, evaluated on the room EXACTLY as handed to
     the verifier. Nothing may mutate the room after this; the ongoing `.vrun` spool is harness I/O.
- **Fixes:**
    - The post-conditions moved OUT of the mid-pipeline and into a single final stage AFTER every
      writer, so a later writer can no longer pass a check and then re-introduce contamination.
    - Per-leaf check now compares CONTENT: a sha256 (or symlink target) captured at intake vs the
      final bytes — a stub standing in for a declared input with different bytes is caught.
    - `seedBootStubs` now REFUSES (hard error) to write an ambient-named boot doc (rule b) or one
      that collides with a declared `--allow-input` (rule a); and the final leftovers check accepts
      an undeclared file ONLY if it is a seeded stub that is provably INERT (bytes == BOOT_STUB_BODY)
      and not ambient.
- **Verified:** `node scripts/verify-bug-186-diff-strip.mjs` — **46/46 PASS**. New (I): unit
  must-FAIL (a round-5-style unguarded seeder resurrects the ambient file), finding B (ambient
  boot-seed refused, exit 2), a nested-ambient generalisation, finding A (non-ambient boot-seed
  colliding with `--allow-input` refused), and a POSITIVE (a normal inert stub still seeds and the
  final assertion accepts it). Anti-reg: `verify-independent-verification` 153/153,
  `verify-bug-182-cleanroom-boot-stubs` 21/21 (normal Orchard boot stubs unaffected). `npm run gate`
  PASS exit 0.
- **`npm run board:check`:** fails only on FEAT-151 (another lane's advisory), not my tickets.
- **Still open / handoff:** NOT self-verified — re-verify cross-provider before VERIFIED. Status
  OPEN; INDEX untouched.

### 2026-10-01 — BUG-120/186 round-6 clean-room verify lane
- **Verification recorded:** dispatch anthropic run 5b2e5a07-929e-40b6-83b4-8fa0776b05fe — VERDICT: BROKEN — same-provider (second Anthropic account; OpenAI exhausted till 2026-10-05); cross-provider re-verify due after 2026-10-05; BROKEN — submodule diff.submodule=diff leaks board/ambient prose, seed-before-audit containment breach, AGENTS.override.md ambient gap. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — INDEPENDENT clean-room verify round 6 (same-provider fallback) — VERDICT: BROKEN
- **Combined verify (ONE dispatch, shared file + shared fixer test, both scopes).** SCOPE 1 here is
  the ROOM PIPELINE (BUG-120); SCOPE 2 is the diff fix (BUG-186's 2026-10-01 entry carries the diff
  finding). Routed to a SECOND Anthropic account (fresh context) because the OpenAI window is
  exhausted until 2026-10-05 — same-provider fallback, decorrelation reduced; a **cross-provider
  re-verify is due after 2026-10-05** and is noted in the typed Verified-by entry.
- **Requirement (plain terms, not the fixer's prose):** `buildCleanroom` is an ordered pipeline whose
  FINAL stage is the room assertion, after every writer (archive, provisionModules, stripCleanroom,
  seedBootStubs, auditSymlinks, recorder); NO writer may re-introduce undeclared prose/ambient
  content into the room after that stage; a boot stub may survive only if provably INERT and
  non-ambient; `seedBootStubs` HARD-ERRORS on an ambient-named or declared-input-colliding boot doc;
  the per-leaf check compares CONTENT (sha256 / symlink target), not mere existence; a declared input
  emptied or removed by the audit dies loudly; an ambient/absolute/escaping `--allow-input` is refused
  at intake. A filled-in FIXER-TEST citation example was provided in `/tmp/req-BUG-120-186-r6.txt`.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-BUG-120-186-r6.txt --run "node scripts/verify-bug-186-diff-strip.mjs" --test-file scripts/verify-bug-186-diff-strip.mjs --test-file src/server/cleanroom-surface.mjs --provider anthropic --timeout-min 9 --verdict-out /tmp/verdict-BUG-120-186-r6.txt`
- **Verdict: BROKEN (VALID, manifest-backed).** Re-ran the fixer's suite (45/46 in the room — the
  real-tree `--print-prompt` check (F) cannot run in a `git archive` room with no `.git`; expected,
  noted UNTESTED) and built adversarial cases the fixture never exercises. Two SCOPE-1 (room) FINDINGs
  broke it (the submodule-diff FINDING is SCOPE-2, see BUG-186):
  - **FINDING (buildCleanroom stage order):** `seedBootStubs` runs BEFORE `auditSymlinks`, so a boot
    seed path (`src/out/boot.md`) under a committed symlink `src/out` that points OUTSIDE the room
    writes the stub file into the host directory OUTSIDE the room — a containment breach — before the
    audit then removes the escaping link. The declared boot stub is then ABSENT from the final room,
    and the final assertion never re-checks seeded stubs, so the run exits 0 (both a write-outside-the-
    room breach and a silently missing boot doc). (adv-room run 672fa6a066b4.)
  - **FINDING (isAmbientPath / AMBIENT_FILE_NAMES):** Codex's auto-discovered `AGENTS.override.md`
    (root and `src/`) is NOT in `AMBIENT_FILE_NAMES`, so it is treated as declared code — it survives
    the strip AND the final assertion in the room and SHIPS in the diff. Undeclared ambient-instruction
    prose reaches the verifier, defeating success criterion #1. (adv-room run 672fa6a066b4.)
  - The round-5 refutation's own cases HELD: boot-stub seeding no longer resurrects an ambient file at
    a declared leaf path (ambient boot-seed refused, the inert placeholder is accepted, the content-
    hash per-leaf check is in place). `GIT_EXTERNAL_DIFF` env was suppressed by `--no-ext-diff` (held).
- **Verified-by:** dispatch anthropic run 5b2e5a07-929e-40b6-83b4-8fa0776b05fe (clean-room,
  `scripts/independent-verify.mjs`, same-provider fallback — second Anthropic account; cross-provider
  re-verify due after 2026-10-05) — VERDICT: BROKEN. (Typed proof in the record's verification[]; this
  line is the prose echo.)
- **Status:** stays OPEN. Handoff: (1) seed boot stubs AFTER `auditSymlinks` (or refuse a seed path
  that resolves through an escaping symlink / outside the room), and have the FINAL assertion re-check
  that every declared boot stub is present and inert in the final room; (2) add `AGENTS.override.md`
  (and audit Codex/other CLI override spellings) to `AMBIENT_FILE_NAMES` so the override form is
  stripped and non-allow-listable at any depth. UNTESTED by this pass (carry forward): the identical-
  bytes stand-in edge for a declared input (the collision guard dies first, so the only byte-identical
  case is a declared input whose bytes equal BOOT_STUB_BODY — not a leak); clean/smudge + autocrlf/eol
  under `--working-tree`; whether the live CLI versions actually load `AGENTS.override.md`. Re-verify
  the seed-escaping-symlink and `AGENTS.override.md` cases after the fix. High-stakes (verification-
  integrity tooling, regression-prone file) — keep the cross-provider independent pass (due after
  2026-10-05) before VERIFIED.

### 2026-10-01 — round-7 FIX (containment: audit-before-write + safe writer; ambient PATTERNS); NOT self-verified

- **Understood (anthropic run `5b2e5a07…`, same-provider fallback — cross-provider re-verify due after 2026-10-05):**
    - **(finding 2, most serious — containment breach)** `seedBootStubs` ran BEFORE `auditSymlinks`,
      so a boot-seed path (`src/out/boot.md`) under a committed symlink `src/out` that points OUTSIDE
      the room wrote the stub into the HOST directory outside the room; the audit then removed the
      link, leaving the boot doc missing, and nothing re-checked it — exit 0.
    - **(finding 3)** Codex's `AGENTS.override.md` was not in the fixed `AMBIENT_FILE_NAMES`, so it
      was treated as declared code — survived the strip and shipped in the diff.
- **Fixes (post-condition / structural, per the root rule "assert the room exactly as handed over"):**
    - **Pipeline reorder:** `auditSymlinks` now runs BEFORE any writer (strip → **audit** → seed →
      recorder → FINAL assertion), so no writer can follow an escaping symlink out of the room.
    - **One safe writer:** every room write (`seedBootStubs`, the `vrun.mjs` recorder file) goes
      through `safeWriteInRoom`, which refuses to follow a symlink at ANY path component or leaf and
      refuses a destination whose realpath is outside the room.
    - **Final assertion re-checks boot stubs:** every seeded stub must be PRESENT and INERT
      (`== BOOT_STUB_BODY`) in the final room, so a dropped/overwritten boot doc is loud.
    - **Ambient is now a case-insensitive PATTERN per family** (`AGENTS*.md`, `CLAUDE*.md`,
      `GEMINI*.md`, `copilot-instructions.md`, `.cursorrules`; dirs `.claude`/`.codex`/`.cursor`/
      `.gemini`), so `AGENTS.override.md` and the other variants are covered by construction — while
      `AGENTSFOO.md` is NOT (the dot-segment is required).
- **Verified:** `node scripts/verify-bug-186-diff-strip.mjs` — **55/55 PASS**. New (J): finding 3
  pattern unit (families + over-match negatives + must-FAIL of the fixed list) and CLI (override
  stripped + diff-excluded); finding 2 unit must-FAIL (a round-6-order write lands OUTSIDE the room)
  + PASS (`safeWriteInRoom` refuses the symlinked component, exit 2, nothing outside). Anti-reg:
  `verify-independent-verification` 153/153, `verify-bug-182-cleanroom-boot-stubs` 21/21 (normal
  boot stubs unaffected). `npm run gate` PASS exit 0; `npm run board:check` OK — no drift.
- **Still open / handoff:** NOT self-verified — CROSS-PROVIDER re-verify due after 2026-10-05 (round
  6 was same-provider fallback). Status OPEN; INDEX untouched.

### 2026-10-01 — BUG-120/186 round-7 clean-room verify lane
- **Verification recorded:** dispatch openai/codex run 01a0f923-ace6-7432-a676-ab5318515fd7 — VERDICT: BROKEN — cross-provider openai (author anthropic); recorder .vrun/alive heartbeat writer bypasses safeWriteInRoom and follows a committed INTERNAL symlink (.vrun/alive -> ../src/code.mjs, left by auditSymlinks which only removes escaping links) to overwrite declared code; diff route held. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — INDEPENDENT clean-room verify round 7 (cross-provider, openai) — VERDICT: BROKEN

- **Combined verify (ONE dispatch, shared file + shared fixer test, both scopes); CROSS-PROVIDER
  restored** — OpenAI is back. SCOPE 1 here is the ROOM PIPELINE / containment (BUG-120); SCOPE 2 is
  the diff (BUG-186's 2026-10-01 round-7 entry). Author anthropic → verifier openai (codex). First
  attempt (thread `01a0f920…`) was aborted by OpenAI's content filter mid-run ("flagged for possible
  cybersecurity risk"); re-dispatched with QA-framed (non-adversarial) requirement wording, same
  technical claims and probe list — that run completed.
- **Requirement (plain terms, QA-framed, not the fixer's prose):** room containment — is there ANY
  write path to the room NOT through `safeWriteInRoom`; `auditSymlinks` runs BEFORE any writer; the
  final assertion is the last stage after every writer and re-checks seeded stubs + declared-input
  content; ambient matched by CASE-INSENSITIVE FAMILY patterns (over/under-match); diff forces
  `-c diff.submodule=short --submodule=short` + `--no-ext-diff --no-textconv`; the emitted-patch
  HEADER backstop vs rename/copy/binary headers; carried-forward clean/smudge + eol under
  `--working-tree`. A filled-in FIXER-TEST citation example was provided in `/tmp/req-BUG-120-186-r7.txt`.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-BUG-120-186-r7.txt --run "node scripts/verify-bug-186-diff-strip.mjs" --test-file scripts/verify-bug-186-diff-strip.mjs --test-file src/server/cleanroom-surface.mjs --timeout-min 22 --verdict-out /tmp/verdict-BUG-120-186-r7.txt`
- **Verdict: BROKEN (VALID, manifest-backed).** Re-ran the fixer's suite (54/55 in the room — the
  real-tree `--print-prompt` check (F) cannot run in a `git archive` room with no `.git`; expected,
  noted UNTESTED). The round-6 fixes HELD: `AGENTS.override.md` family pattern strips + excludes;
  `diff.submodule=diff` inlining is overridden by the forced `--submodule=short`; boot-stub seeding
  no longer resurrects ambient prose. ONE new SCOPE-1 (containment) FINDING broke it via a route the
  fixture never exercises:
  - **FINDING (safeWriteInRoom BYPASS — a second writer into the room):** the recorder's `.vrun/alive`
    HEARTBEAT writer uses a direct `fs.writeFileSync`, NOT `safeWriteInRoom`. A committed INTERNAL
    symlink `.vrun/alive -> ../src/code.mjs` survives `auditSymlinks` (which removes only symlinks
    ESCAPING the room; an internal link pointing at another in-room file is left), so the heartbeat
    write FOLLOWS the link and OVERWRITES the declared code file `src/code.mjs` with a heartbeat
    timestamp — the verifier runs clobbered code, and `--print-prompt` still exits 0. So the charter's
    core question ("is there ANY write path to the room NOT through safeWriteInRoom?") is answered YES:
    the recorder heartbeat is one, and an internal (non-escaping) symlink is a class `auditSymlinks`
    does not cover. (adversarial `recorder-heartbeat-symlink` run ce8a905ed7ce; FIXER-TEST run
    66c10642cb72.)
- **Verified-by:** dispatch openai/codex run 01a0f923-ace6-7432-a676-ab5318515fd7 (clean-room,
  `scripts/independent-verify.mjs`, cross-provider — author anthropic, verifier openai) — VERDICT:
  BROKEN. (Typed proof in the record's verification[]; this line is the prose echo.)
- **Status:** stays OPEN. Handoff: (1) route the recorder's `.vrun/alive` heartbeat (and any other
  direct `fs.writeFileSync` into the room) through `safeWriteInRoom` so no writer can follow a symlink;
  (2) `auditSymlinks` (or `safeWriteInRoom`) must also refuse an INTERNAL symlink whose target is a
  declared/code path — a non-escaping link that redirects a room write onto in-room code is a
  containment hole the current escaping-only audit misses. Re-verify the internal-symlink +
  recorder-heartbeat case after the fix. UNTESTED this pass (carry forward): the patch-header backstop
  vs rename/copy/binary headers; clean/smudge + core.autocrlf/eol under `--working-tree` (the exported
  room has no `.git` worktree to install a filter into). High-stakes (verification-integrity tooling,
  regression-prone file) — keep the cross-provider independent pass before VERIFIED.

### 2026-10-01 — round-8 FIX (recorder heartbeat bypass; .vrun reserved; every room write guarded); NOT self-verified

- **Understood (openai/codex run `01a0f923…`, cross-provider; BUG-186 diff route HELD entirely):** the
  recorder's `.vrun/alive` heartbeat used a direct `fs.writeFileSync`, bypassing `safeWriteInRoom`. A
  committed INTERNAL symlink `.vrun/alive -> ../src/code.mjs` survives `auditSymlinks` (which removes
  only ESCAPING links), so the heartbeat FOLLOWED it and overwrote declared code — exit 0.
- **Every fs WRITE into the room audited (the charter's ask) — each converted or justified:**
  | write | path | status |
  |---|---|---|
  | `safeWriteInRoom` (seed stubs, vrun.mjs) | in-room | GUARDED (refuses symlink component/leaf, out-of-room realpath) |
  | recorder spool `mkdirSync(.vrun, req, res)` | in-room | `.vrun` now REFUSED if present in export, then created FRESH after audit |
  | heartbeat `beat()` → `.vrun/alive` | in-room | CONVERTED to `writeNoFollow` (O_NOFOLLOW) |
  | `respond()` tmp write + rename → `.vrun/res/*` | in-room | CONVERTED to `writeNoFollow`; rename REPLACES a symlink, never follows |
  | `provisionModules` `cp`/`cpSync` → `node_modules` | in-room | guarded: a symlink dest is removed first; `node_modules` is gitignored (not in the archive) |
  | `stripCleanroom` / `auditSymlinks` / cleanup `rmSync` | in-room | REMOVALS only — never write THROUGH a link |
  | `record()` manifest + `<id>.out`, `room-manifest.json` | OUT of room (recordDir, fresh mkdtemp) | justified: harness-owned scratch the verifier cannot reach |
  | `--verdict-out` | user-chosen path | justified: the harness's output, the user's path |
  | vrun.mjs client writes `.vrun/req/*` | in-room, runs AS the verifier | the verifier's own writes under a harness-created fresh dir — not a harness write |
- **Fixes:** `.vrun` is a RESERVED path — refused (hard error) if the exported tree contains it (lstat,
  so a committed file/dir/symlink all count) and created FRESH after export+audit; the heartbeat and
  response writers use `writeNoFollow` (O_NOFOLLOW ⇒ never follow a symlink leaf); `provisionModules`
  removes a symlink dest before copying. Internal symlinks are KEPT (node_modules/.bin needs them),
  and the proof is now: NO harness write can follow one — every room write is `safeWriteInRoom`,
  `writeNoFollow`, a removal, or under the harness-made fresh `.vrun`.
- **Verified:** `node scripts/verify-bug-186-diff-strip.mjs` — **61/61 PASS**. New (K): unit must-FAIL
  (a plain-writeFileSync heartbeat through an internal `.vrun/alive` symlink overwrites declared code)
  + PASS (`writeNoFollow` refuses the symlink leaf, code intact, writes a normal path fine); CLI
  finding (committed `.vrun/alive` symlink → reserved path refused, exit 2); generalisations (a
  committed `.vrun/` dir refused; a committed `vrun.mjs` symlink refused by `safeWriteInRoom`).
  Anti-reg: `verify-independent-verification` 153/153 (its live shim exercises the recorder/spool with
  `writeNoFollow`), `verify-bug-182-cleanroom-boot-stubs` 21/21. `npm run gate` PASS exit 0;
  `npm run board:check` OK — no drift.
- **Still open / handoff:** NOT self-verified — re-verify cross-provider before VERIFIED. Carry-forward
  UNTESTED (noted by round-7 verifier, still): clean/smudge filters and `core.autocrlf`/`eol`
  attributes under `--working-tree`. Status OPEN; INDEX untouched.

### 2026-10-01 — BUG-120/186 round-8 clean-room verify lane
- **Verification recorded:** dispatch openai run 01a0f932-dd81-7c23-8eca-f6be0fdb34c2 — VERDICT: BROKEN — cross-provider openai (author anthropic); combined shared file; VALID manifest-backed. BUG-186 diff route HELD (clean/smudge+autocrlf/eol under --working-tree). SCOPE-1 containment BROKEN: KEPT internal symlinks (escaping .vrun removed before reserved check; recorder/.bin symlink writes clobber). Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — INDEPENDENT clean-room verify round 8 (cross-provider, openai) — VERDICT: BROKEN

- **Combined verify (ONE dispatch, shared file + shared fixer test, both scopes); CROSS-PROVIDER.**
  SCOPE 1 here is the ROOM PIPELINE / containment (BUG-120); SCOPE 2 is the diff (BUG-186's
  round-8 entry). Author anthropic → verifier openai (codex). The round-8 fix is UNCOMMITTED —
  verified with `--working-tree`.
- **Requirement (plain terms, QA-framed, not the fixer's prose):** confirm NO harness write into
  the room can FOLLOW a KEPT internal symlink — probing `provisionModules` copies, `node_modules/.bin`
  targets, and vrun's own child processes writing into the room — and that `.vrun` is a reserved path
  refused if present; confirm the carried-forward clean/smudge filters and `core.autocrlf`/`eol`
  attributes under `--working-tree` cannot re-expand a declared path into undeclared descendants in
  the emitted patch, and an empty-after-filter diff dies loudly. A filled-in FIXER-TEST citation
  example was provided in `/tmp/req-BUG-120-186-r8.txt`.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-BUG-120-186-r8.txt --run "node scripts/verify-bug-186-diff-strip.mjs" --test-file scripts/verify-bug-186-diff-strip.mjs --test-file src/server/cleanroom-surface.mjs --timeout-min 22 --verdict-out /tmp/verdict-BUG-120-186-r8.txt`
- **Verdict: BROKEN (VALID, manifest-backed).** Re-ran the fixer's suite (60/61 in the room — the
  real-tree check (F) cannot run in a `git archive` room with no `.git`; expected, noted UNTESTED).
  The round-8 fixes HELD in part: a committed `.vrun` file/dir/internal-symlink is refused as a
  reserved path (exit 2); a committed `vrun.mjs` symlink is refused by `safeWriteInRoom`. FOUR new
  SCOPE-1 (containment) FINDINGs broke it via routes the fixture never exercises — all turning on the
  KEPT internal symlinks the round-8 design deliberately leaves in place:
  - **FINDING (reserved-path ordering):** an exported ESCAPING `.vrun` SYMLINK is accepted with
    exit 0 — `auditSymlinks` removes the escaping link BEFORE the reserved-`.vrun` check runs, so the
    reserved-path refusal never fires for the symlink form. (adv `reserved-path-types` run 9de8965284ca.)
  - **FINDING (recorder child via kept `.bin` symlink):** a recorder CHILD overwrites the declared
    `src/code.mjs` by writing THROUGH a kept `node_modules/.bin/source` symlink — the verifier then
    runs clobbered code. (adv `live-recorder-symlink-containment` run 35e3aa125ffd.)
  - **FINDING (heartbeat via kept `.bin` symlink):** replacing the fresh `.vrun` with a symlink
    pointing through the kept `.bin` link redirects the heartbeat write onto the declared `src/alive`
    — `writeNoFollow`'s O_NOFOLLOW protects only the LEAF, not a redirected parent directory.
  - **FINDING (response via kept `.bin` symlink):** replacing `.vrun/res` with a symlink through the
    kept `.bin` link redirects response publication onto the declared `src/code.json` — same
    parent-dir-redirect gap.
- **SCOPE 2 (BUG-186 diff) HELD** — see BUG-186's round-8 entry: the `working-tree-filter-eol-descendants`
  adversarial case (clean/smudge filters + autocrlf/text/eol attributes combined with file→dir
  replacement and ambient descendants) shipped NO undeclared path (exit 0), and the empty-after-filter
  diff was refused (exit 2).
- **Verified-by:** dispatch openai run 01a0f932-dd81-7c23-8eca-f6be0fdb34c2 (clean-room,
  `scripts/independent-verify.mjs`, cross-provider — author anthropic, verifier openai) — VERDICT:
  BROKEN. (Typed proof in the record's verification[]; this line is the prose echo.)
- **Status:** stays OPEN. Handoff: (1) run the reserved-`.vrun` check BEFORE `auditSymlinks` (or make
  the audit refuse rather than silently remove an escaping `.vrun`), so the symlink form is refused
  loudly like the file/dir forms; (2) the O_NOFOLLOW leaf guard is insufficient — a kept internal
  symlink at a PARENT component (`node_modules/.bin/*`) still redirects heartbeat/response/child
  writes onto declared code, so every room write must resolve its FULL path containment (realpath
  inside the room, no symlinked component) or the kept-`.bin`-symlink class must be narrowed so it
  cannot be a write target; (3) a recorder child process is a write path not covered by
  `safeWriteInRoom` — constrain what children may write, or sandbox their cwd. Re-verify all four
  cases after the fix. High-stakes (verification-integrity tooling, regression-prone file) — keep the
  cross-provider independent pass before VERIFIED.

### 2026-10-02 — round-9 FIX (harness state OUT of the room; ZERO symlinks); core unit-verified, INTEGRATION BLOCKED by env

- **Understood (openai run `01a0f932…`; BUG-186 diff route HELD again incl clean/smudge + eol):** 4
  containment bypasses, all via KEPT internal symlinks or a symlinked PARENT the round-8 in-room
  spool + leaf-only `O_NOFOLLOW` could not stop — an escaping `.vrun` link removed by audit BEFORE
  the reserved check; a recorder child writing through `node_modules/.bin`; and the heartbeat/response
  redirected by swapping `.vrun`/`.vrun/res` for a symlink.
- **Fix — remove the class (per the charter's invariant):**
  1. **ALL harness run-state lives OUTSIDE the room.** The spool (request channel + heartbeat +
     responses) is now a fresh `mkdtemp` under the SYSTEM TEMP dir (`os.tmpdir()`), not `dir/.vrun`.
     `vrun.mjs` carries the absolute spool paths baked in; the room holds NO harness-write target, so
     a verifier symlink anywhere in the room — committed or planted mid-run — cannot redirect a
     harness write. The system temp dir is the root codex workspace-write permits read+write (the
     same `$TMPDIR` the sanctioned GIT_INDEX_FILE-in-tmpdir writes use). Recorder output
     (manifest/`<id>.out`) stays in `recordDir` (scratch, harness-only).
  2. **The room contains ZERO symlinks.** New `materializeSymlinks` (after `auditSymlinks`) converts
     each `node_modules/.bin/*` symlink into a tiny `exec` shim script (tools still run) and removes
     every other internal symlink; a symlink under a declared `--allow-input` is kept. The FINAL
     assertion now also asserts NO symlink exists in the room outside a declared input.
  3. **Reserved `.vrun` check:** removed as moot — the spool is no longer in the room, so there is no
     reserved in-room path to collide (closes the round-8 ordering finding by construction).
- **The invariant now holds by construction:** the harness never writes inside the room during the
  run (every write Orchard makes is to the external spool or `recordDir`), the room has zero symlinks,
  and a verifier symlink in the room cannot redirect a harness write.
- **Verified (what RAN):** `node scripts/verify-bug-186-diff-strip.mjs` — **12/12 PASS, 1 SKIP**
  (the git-fixture sections). The round-9 CORE is unit-proven without git: (A3) `materializeSymlinks`
  leaves zero symlinks — `.bin`→exec shim, internal link removed, declared-input link kept; plus the
  predicate (P) and `stripCleanroom` (A) suites. `npm run gate` PASS exit 0 (typecheck + leak +
  check-nul); `npm run board:check` OK — no drift; `verify-bug-182-cleanroom-boot-stubs` 21/21.
- **BLOCKED (what could NOT run) — environment, not this change:** mid-round, this environment's
  git-write backstop (FEAT-135) began REFUSING subprocess `git init` even in scratch fixture repos
  (and `ORCHARD_ALLOW_GIT_WRITE=1` no longer lifts it from a lane — "the grant comes from the user
  only"). That aborts every fixture-building section of the proof AND the existing suites'
  git-fixture legs: `verify-bug-186-diff-strip` (B)/(C)/(E)/(G)/(H)/(J)/(L)/(F), and
  `verify-independent-verification` section C (which passed 153/153 EARLIER THIS SAME ROUND, before
  the policy tightened). So the CLI/integration re-verification of round-9 (spool-external end-to-end,
  the 4 findings' CLI repros, zero-symlink room over a real export) is NOT run here.
- **Still open / handoff (NEEDS-YOU):**
  1. The git-write backstop must permit subprocess `git init` in scratch/throwaway fixture repos (the
     sanctioned exception, synthetic `t@t` identity) — via `node scripts/git-grant.mjs <project>
     --once` for the verify run, or a FEAT-135 carve-out for non-repo scratch paths. Without it, NO
     fixture-based verification on this board can run.
  2. Cross-provider independent verify of round-9 (not self-verified; and this round depends on a
     codex-sandbox assumption I could not exercise here: that the verifier can read+write the spool
     under `$TMPDIR`). If that assumption is wrong the dispatch fails LOUDLY (verifier can't reach the
     spool), not silently.
  Status OPEN; INDEX untouched (orchestrator-owned).
