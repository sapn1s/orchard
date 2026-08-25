```orchard-ticket
{
  "id": "FEAT-039",
  "type": "feature",
  "title": "Project rules could drift apart across separate projects",
  "summary": "Every project now reads one shared working agreement from a single file, and each project also gets its own local rules document injected alongside it. A real session launch proved the local document reaches the agent. Moving the shared document to a project-neutral home was designed but deliberately not built.",
  "impact_if_we_wait": "The shared document still lives inside one project's repository, so renaming or moving that repository breaks the shared rules for every other project. Bounded: nothing drifts today, and no project loses its own rules.",
  "current_need": "Decide whether to move the shared document to a neutral home or leave it where it is.",
  "severity": "medium",
  "area": "Shared methodology",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-04",
      "question": "Should the shared working agreement be hoisted to a project-neutral location?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "parked",
      "chosen_on": "2026-08-04",
      "chosen_by": "user",
      "note": "Left design-only and not executed; the shared document still lives inside one project's repository."
    }
  ],
  "success_criteria": [
    "Editing the shared working agreement from any project is seen by the next session in every other project",
    "A project-specific rule lands in that project's local document, not the shared one",
    "A misfiled rule is flagged by the scope check",
    "The local document reaches a real launched session, not only the composition layer"
  ],
  "code_refs": [
    {
      "path": "src/main/agent-bridge.ts",
      "symbol": "startSession",
      "note": "the real launch call site passes hostPath, so composeInstructions() receives the project's local document"
    },
    {
      "path": "docs/prompts/WORKING_AGREEMENT.v2.md",
      "symbol": null,
      "note": "the single shared template all projects read through; still path-coupled inside this repo, which is gap #2"
    },
    {
      "path": "docs/CONVENTIONS.md",
      "symbol": null,
      "note": "the per-project local rules document injected alongside the shared template"
    }
  ],
  "related": [
    {
      "id": "FEAT-027",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-041",
      "relation": "blocks"
    },
    {
      "id": "FEAT-044",
      "relation": "blocks"
    },
    {
      "id": "FEAT-092",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
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
    "archived_path": "docs/bugs/archive/FEAT-039-shared-methodology-integrity.md",
    "sha256": "17d1f33b12258d605d52733fb37a0ee2e9689d2a8186d794a07b329d36a5199c",
    "bytes": 20763,
    "original_title": "Shared-methodology integrity: one universal WA, project-scoped locals, no cross-project drift",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the concern, the already-prevented mechanism, all three gaps, the fix design, the parked hoist and the verification recipe are present.",
    "dropped": [
      "the example project names used to illustrate divergence"
    ]
  }
}
```

# FEAT-039 — Project rules could drift apart across separate projects

## Diagnosis

### The concern
As sessions in different projects learn and refine rules, their methodologies could diverge.

### Why most of that was already prevented
There is one shared Working-Agreement template that all projects inject by read-through from a single file, not per-project copies. A universal refinement made from any project updates that one source and propagates everywhere. §L routes learnings by scope: universal insights to the shared agreement, project-specific rules to that project's own document.

### The three real gaps
1. Routing is discipline, not enforcement — an agent can misfile a project-specific rule into the shared agreement, polluting every project, or file a universal insight into a project document where it never propagates.
2. Path-coupling — the shared agreement lives inside this repo under `docs/prompts/`, which is fragile once that path is renamed or moved.
3. No scope audit — nothing checks that the shared document stays universal and that project documents stay local.

Gap #1 is closed end-to-end and gap #3 is built to the composition layer. Gap #2, the hoist to a project-neutral location, remains design-only.

## Evidence

The local-document path was proven through a real `startSession()` launch rather than only at the composition layer: `composeInstructions()` is wired and the `agent-bridge.ts` call site passes `hostPath`.

Suite tallies: verify:pattern-templates 34/34, verify:local-conventions 18/18, verify:template-readthrough 18/18, verify:boot-aware 12/12, verify:check-scope 9/9, verify:overrides 5/5, verify:ui 3/3, plus a recorded 11/11. Typecheck clean. `verify:conventions-live` is named in the record with no result attached.

## Implementation notes

### Built
- Per-project local rules document (`docs/CONVENTIONS.md` or the project's `CLAUDE.md`), injected alongside the shared agreement.
- Scope-audit enforcement, built to the composition layer.

### Designed, not executed
- Hoisting the shared agreement to a project-neutral Orchard location — a shared config or data directory the station reads for all projects, making this repo just another consumer rather than a special case. The read-through introduced by FEAT-027 would then point there.
- The consolidation loop's scope question (FEAT-019 question #5, "project-specific masquerading as universal") running as an actual gate that flags misfiled rules on review.

## Verification plan

Edit the shared agreement from one project's session and confirm another project's next session sees the change from the one source. Add a project-specific rule in one project and confirm it lands in that project's local document rather than the shared agreement, with the scope check flagging it if misfiled. Run the verify suites and typecheck.

## Risks

The shared agreement's location remains coupled to this repo's layout, so a rename or relocation of that path breaks read-through for every consuming project.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed. Key insight: drift is largely prevented by the shared-template design; the gaps are
  enforcement + de-coupling, not "copies diverging". Pairs with FEAT-019 (scope gate),
  FEAT-036 (rename → hoist opportunity), FEAT-038 (onboarding wires the per-project local doc).

### 2026-08-04 — builder agent — gaps #1 and #3 built at the compose layer; #2 (hoist) designed only
Scope for this pass: `src/server/templates.ts`, two new scripts, `package.json`, this ticket.
Deliberately did NOT touch `index.ts`, `app.js`, `agent-bridge.ts`, or
`docs/prompts/WORKING_AGREEMENT.v2.md` (routing, not rewriting).

**Gap #1 — per-project local-conventions doc (BUILT, compose-layer only):**
- `localConventionsSection(hostPath, opts?)` in `src/server/templates.ts` reads
  `<project>/docs/CONVENTIONS.md` (path exported as `LOCAL_CONVENTIONS_RELPATH`) and formats it
  as an injectable section — `null` when absent (opt-in, like `boardStateSection()` in
  `board.ts`), hard length cap (default 4000 chars) since it competes for the same attention
  budget as the WA and the live board snapshot.
- Mirrors the FEAT-021 board-fold pattern exactly: the intended assembly at launch is
  `appendToSystemPrompt(appendToSystemPrompt(composeInstructions(refs).systemPrompt,
  boardStateSection(hostPath)), localConventionsSection(hostPath))` — shared WA first, board
  state second, project-local conventions last, so local rules read as an addendum to the
  universal ones, never a replacement.
- **NOT wired into the live session-launch call site** — that one-line addition belongs in
  `agent-bridge.ts`, which is out of scope for this pass per the task's explicit file list.
  Handoff for whoever does that: add the `appendToSystemPrompt(sp, localConventionsSection(hostPath))`
  fold right after the existing board fold in `agent-bridge.ts`, then re-run
  `verify-boot-aware.mjs` + the new `verify-local-conventions.mjs` to confirm nothing clobbers.
- Verified at the compose layer (same rigor as `verify-boot-aware.mjs` /
  `verify-template-readthrough.mjs`, no mocks, no `:4317`):
  `node scripts/verify-local-conventions.mjs` → **11/11 PASS**, including: section present +
  correct content when `docs/CONVENTIONS.md` exists; WA content NOT clobbered; local section
  lands strictly after the WA in the composed text; absent doc → `null` (byte-identical to the
  WA-only base, no vacuous injection); whitespace-only doc also treated as absent.

**Gap #3 — scope check (BUILT, standalone heuristic script):**
- `scripts/check-scope.mjs` — heuristic scan, makes consolidation-checklist Q5 real. Flags two
  directions: a project-specific-sounding line in the shared WA (named project, named
  stack/tool, hardcoded port, hardcoded repo-relative path), or a universal-sounding line in a
  project-local doc ("every project/session", "all projects", generic git hygiene with no
  project anchor, "any codebase/repo/project"). Exported functions (`checkScope`, `scanSharedWA`,
  `scanLocalDoc`, `discoverLocalDocs`) + a CLI (exit 0 clean / 1 candidates found).
  **Deliberately heuristic and honest**: it reports candidates for a human to triage, it never
  edits or moves text — a false positive costs a skim, a false "auto-fixed" would cost trust in
  the whole board.
- `npm run check:scope` wired in `package.json`. Ran against the real repo right now: **clean**
  (`docs/prompts/WORKING_AGREEMENT.v2.md` has zero flagged lines) — a good sign the WA has
  stayed universal so far, and confirms the heuristic isn't noisy on the doc it's meant to
  protect.
- Verified via `scripts/verify-check-scope.mjs`: plants a project-specific line
  (`external-project-A`, a hardcoded `:8912`) into a scratch WA and a universal-sounding line
  ("Every project must...") into a scratch local doc, asserts both are flagged (and the CLI
  exits 1); re-runs against a clean pair and asserts zero findings + CLI exit 0; also asserts
  the REAL repo WA produces zero findings (anti-noise regression). **9/9 PASS**.
- Local-doc discovery for the no-args CLI form scans `~/projects/*/docs/CONVENTIONS.md` and
  `~/random_projects/*/docs/CONVENTIONS.md` (same roots as `registry.ts`'s `scanForProjects()`)
  — deliberately independent of `registry.ts`/the data dir, so this script has no dependency on
  a running station.

**Gap #2 — hoist the shared WA to a project-neutral location (DESIGN ONLY — not executed):**
Today `docs/prompts/WORKING_AGREEMENT.v2.md` lives inside claude-station's own repo, and the
template's `source:` frontmatter (`templates.ts` `DEFAULT_SEED_SOURCES`, read-through resolved
via `resolveSourcePath()` which refuses to escape `projectRoot()`) is what makes claude-station
"special" — every other project is a *consumer* of a file that happens to live in one
particular project's tree. That's a coincidence of history (this station's docs seeded the
WA), not a design property, and FEAT-036 (a claude-station rename) or ever moving/renaming this
repo would break the coupling silently.

Two candidate project-neutral locations, and the trade-off that makes this a user decision
rather than something to just execute:

1. **A subdirectory of the station's data dir** (`$CLAUDE_STATION_DATA/shared/` — sibling to
   `templates/`, `registry.json`). Pro: already exists, already backed up/migrated by whatever
   the user does for their data dir, `resolveSourcePath()`'s "must stay inside projectRoot()"
   guard would need to become "inside dataDir() OR projectRoot()" (small, well-contained change).
   Con — **the big one**: the data dir is explicitly NOT git-versioned today (it's runtime
   state: registry.json, session logs, template copies). Moving the WA there converts a
   version-controlled, diffable, revertable file into an unversioned one — losing "git blame
   shows exactly which session added which rule and why" is a real regression for a *living*
   doc that's edited constantly by design.
2. **A separate, dedicated git repo** (e.g. `~/projects/orchard-methodology/` or similar),
   cloned once, read-through-sourced from there instead of `projectRoot()`. Pro: keeps full git
   history/diffability/revertability — the property gap #2 should NOT sacrifice. Con: a second
   repo to init/clone/keep in sync is real operational overhead for a single-user tool; the
   read-through path-escape guard would need a second allowed root (`ORCHARD_METHODOLOGY_DIR`
   env var or similar) instead of just `projectRoot()`; and every fresh machine setup now needs
   two repos cloned instead of one, which is exactly the kind of extra step a first-run/onboarding
   flow (FEAT-038) has to account for.

Recommendation if/when this is picked up: **option 2** (separate git repo) is the only one that
doesn't trade away git history for a doc that is explicitly meant to keep evolving — but this is
a genuine user call (extra repo/clone-step overhead vs. today's "it happens to live in
claude-station" coupling, which is a real but *survivable* rough edge as long as gap #1 and
gap #3 keep the content itself correctly routed). **Not executed** — no file was moved, WA
content and location are untouched, per the task's explicit scope.

**Verification run this pass:** `node scripts/verify-local-conventions.mjs` 11/11 PASS ·
`node scripts/verify-check-scope.mjs` 9/9 PASS · `npm run typecheck` clean ·
`npm run verify:ui -- --offline` 3/3 PASS (own scratch port, `:4317` untouched). No commit made
(per board rules); changes left in the working tree.

**Open / handoff:**
- Wire the `localConventionsSection()` fold into `agent-bridge.ts`'s real launch assembly (one
  line, see above) — out of scope for this pass, needed before gap #1 is actually *live* rather
  than just available at the compose layer.
- Consider wiring `check:scope` into the consolidation loop (FEAT-019) as an actual gate rather
  than a standalone `npm run` a human has to remember to invoke.
- Gap #2 (hoist) needs a user decision between the two options above before any execution.

### 2026-08-04 — builder agent — WIRING half of gap #1: `localConventionsSection()` now called by `composeInstructions()`
Scope for this pass, as directed: `src/server/templates.ts` (+ its verify + `package.json` +
this ticket) only. Did not touch `app.js`, `board.ts`, `survival.ts`, `index.ts`, or
`agent-bridge.ts` — those are other agents'/tickets' territory or explicitly out of scope
(WA-hoist / gap #2 remains a parked user decision, untouched, see previous entry).

**What changed:** `composeInstructions(refs: InstructionRef[])` in `src/server/templates.ts`
gained an optional second parameter: `composeInstructions(refs, { hostPath?: string })`.
When `hostPath` is supplied and that project has a non-empty `docs/CONVENTIONS.md`,
`composeInstructions()` now internally calls `localConventionsSection(hostPath)` and folds it
onto the refs-derived system prompt via the existing `appendToSystemPrompt()` (same fold
primitive FEAT-021 uses for the board section), appending `'local-conventions'` to
`appliedIds` so the fold is visible/auditable in the `ComposedPrompt` result (and via the
`GET /api/projects/:id/compose` preview route in `index.ts`, unmodified, which already returns
`appliedIds`). No `hostPath` (or a project with no `docs/CONVENTIONS.md`) → byte-identical
output to before this change (verified explicitly, see below) — fully backward compatible, so
the one existing call site (`index.ts:1048`, `tpl.composeInstructions(p.settings.instructions)`,
no second arg) is untouched and unaffected.

Placement: local conventions land directly after the refs-derived stack (the shared WA) inside
`composeInstructions()` itself — the live board snapshot (`boardStateSection()`) is layered by
whatever external call site does that (currently nowhere real yet, per the still-open
`agent-bridge.ts` handoff below) since it needs a live board read, not a static file, so it's
outside what `composeInstructions()` can fold on its own. Updated the doc comments on both
`localConventionsSection()` and `composeInstructions()` to describe this actual shape instead of
the previous "manual double-fold at the call site" sketch.

**Verify:** extended `scripts/verify-local-conventions.mjs` (already wired as
`npm run verify:local-conventions`) with 7 new "WIRED" assertions that call
`composeInstructions(refs, { hostPath })` directly — the previous 11 checks only proved
`localConventionsSection()` + `appendToSystemPrompt()` work in isolation via a manual fold done
*by the test*, not that `composeInstructions()` itself does it. Confirmed non-vacuous: stashed
just `src/server/templates.ts` and re-ran — **3 of the 7 new WIRED checks FAIL pre-wiring**
(`composeInstructions()` took the hostPath arg but silently ignored it, so no local content, no
ordering, no `appliedIds` entry), the other 4 pre-existing/no-op-path checks still passed as
expected. Restored the change (`git stash pop`) and re-ran clean.

Full pass, wiring in place:
- `node scripts/verify-local-conventions.mjs` → **18/18 PASS** (11 original + 7 new WIRED).
  Observed injected snippet (project WITH `docs/CONVENTIONS.md`, via the wired call):
  ```
  # Project Conventions (local)

  _Auto-injected at launch from docs/CONVENTIONS.md (read-only). Project-specific rules
  only — anything universal belongs in the shared Working Agreement instead (see WA §L /
  `scripts/check-scope.mjs`).

  # Local rules

  - This project deploys via `deploy.sh`, never manually.
  - Staging DB lives at db.internal:5432.
  ```
  and `appliedIds: ["working-agreement-v2","local-conventions"]`. Project WITHOUT the doc:
  `composeInstructions(refs, { hostPath: WITHOUT }).systemPrompt` byte-identical to
  `composeInstructions(refs)` (no opts) — no error, no empty header, no stray `appliedIds` entry.
- `npm run typecheck` → clean.
- Anti-regression, same-file verify suites re-run: `verify:boot-aware` 12/12 PASS ·
  `verify:template-readthrough` 18/18 PASS · `verify:pattern-templates` 34/34 PASS — all
  templates.ts-touching suites green, no clobber from the signature change.
- No commit made (per board rules); changes left in the working tree
  (`src/server/templates.ts`, `scripts/verify-local-conventions.mjs`, this ticket).

**Still open / unchanged by this pass:**
- The real launch call site (`agent-bridge.ts`) still doesn't pass `hostPath` into
  `composeInstructions()` — gap #1 is now wired at the compose layer but not yet *live* in an
  actual session launch. Next agent: add `{ hostPath }` to whatever `composeInstructions(...)`
  call `agent-bridge.ts` makes (or add one if it currently calls the templates layer some other
  way) — that's the one remaining line per the original handoff, and this pass makes it correct
  by construction (no manual fold needed at the call site anymore, just pass the option).
- Gap #2 (hoist the shared WA to a project-neutral location) remains a **parked user decision**
  between the two options already written up above — not touched, not executed, no file moved.

### 2026-08-04 — builder agent — gap #1 made LIVE: `agent-bridge.ts` now passes `hostPath`, proven at the real launch site
Scope for this pass, as directed: `src/server/agent-bridge.ts` only for the code fix (+ this
ticket, `package.json`, and a new verify script). Did not touch `templates.ts` (previous pass's
compose-layer wiring left exactly as-is), `app.js`, `board.ts`, or `survival.ts`.

**The gap, precisely:** the real launch call site is NOT `index.ts:1048` — that route is
`GET /api/projects/:id/compose`, an audit/preview endpoint the UI uses to show what a template
stack WOULD produce, and it is correctly untouched (confirmed unmodified). The actual launch path
is `src/server/agent-bridge.ts`'s `AgentSession` constructor, reached from every real session
start via the exported `startSession()` → `new AgentSession(id, opts)`. That constructor is where
`this.composed = composeInstructions(refs)` was called with no second argument — so a launched
session never got `hostPath`, and `localConventionsSection()` never fired, regardless of how
correct the compose layer itself was.

**What changed (`src/server/agent-bridge.ts`, in the `AgentSession` constructor, was
`this.composed = composeInstructions(refs);`):**
```
this.composed = composeInstructions(refs, { hostPath: opts.project.hostPath });
```
`opts.project.hostPath` is the exact same value the constructor uses two lines above for
`this.cwd` — no new plumbing needed, the project's checkout path was already in scope at this
call site. One line changed (plus a comment explaining why).

**Verify — new script, launch-path (not compose-layer) rigor:**
`scripts/verify-conventions-live.mjs` (wired as `npm run verify:conventions-live`) calls the REAL
`startSession()` export from `agent-bridge.ts` (no mocks, no stubbed `ClaudeRuntime`) for two real
registry projects created via `registry.createProject()` in scratch dirs — one with
`docs/CONVENTIONS.md`, one without — and reads the real `AgentSession.composed` field the
constructor produced (the exact value `#run()` later folds the live board section onto and hands
to the CLI as `systemPrompt`). Sessions are closed immediately after that field is read.
- **5/5 PASS** post-fix. Observed injected snippet from the REAL launch (`session.composed`,
  project WITH `docs/CONVENTIONS.md`):
  ```
  # Project Conventions (local)

  _Auto-injected at launch from docs/CONVENTIONS.md (read-only). Project-specific rules only —
  anything universal belongs in the shared Working Agreement instead (see WA §L /
  `scripts/check-scope.mjs`).

  # Local rules

  - This project deploys via `deploy.sh`, never manually.
  - Staging DB lives at db.internal:5432.
  ```
  with `composed.appliedIds: ["working-agreement-v2","local-conventions"]`. Project WITHOUT the
  doc: `composed.appliedIds: ["working-agreement-v2"]`, no "Project Conventions (local)" section,
  zero error events (no vacuous-pass risk from a silently-swallowed exception).
- **Non-vacuous, proven by pre-change failure**: `git stash push -- src/server/agent-bridge.ts`
  (reverting only the fix), re-ran the SAME script → **2 of 5 checks FAIL** as expected
  (`composed.appliedIds` came back `["working-agreement-v2"]` with no `local-conventions`, and
  the injected text had no `deploy.sh`/`db.internal:5432`) — proving the checks actually exercise
  the wiring and aren't trivially green. `git stash pop` restored the fix; re-ran clean, 5/5.
- No stray `claude` child processes or listening ports left behind after either run (`ps aux` /
  `ss -ltnp` checked); own scratch `CLAUDE_STATION_DATA` and project dirs, `:4317` untouched.
- `npm run typecheck` → clean.
- Anti-regression: `npm run verify:local-conventions` → 18/18 PASS (compose-layer suite from the
  prior pass unaffected) · `npm run verify:boot-aware` → 12/12 PASS (board-fold, same file,
  unaffected) · `npm run verify:overrides` → 5/5 PASS (a full real session-start/reload/override
  cycle through `agent-bridge.ts` via the actual WS+browser UI path — the constructor edit does
  not break ordinary session launch).
- No commit made (per board rules); changes left in the working tree
  (`src/server/agent-bridge.ts`, `scripts/verify-conventions-live.mjs`, `package.json`, this
  ticket).

**Gap #1 is now fully live**, compose layer through real launch, both proven non-vacuously.

**Still open:**
- Gap #2 (hoist the shared WA to a project-neutral location) remains a **parked user decision**
  between the two options written up in the earlier entry above (data-dir subfolder vs. a
  separate git repo) — not touched, not executed, no file moved. Needs the user to pick before
  any agent should act on it.
- Gap #3 (`check:scope`) is unaffected by this pass; still a standalone `npm run` a human must
  remember to invoke, not wired into a gate (see earlier entry's handoff).

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
