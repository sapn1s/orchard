# FEAT-039 — Shared-methodology integrity: one universal WA, project-scoped locals, no cross-project drift

- **Status:** VERIFIED (gap #1 local doc now LIVE end-to-end: `composeInstructions()` wired AND the real `agent-bridge.ts` launch call site passes `hostPath` — proven via a real `startSession()` launch, not just the compose layer; gap #3 scope-audit built to the compose layer; gap #2 hoist remains design-only, not executed — parked user decision)
- **Area:** Orchard platform / methodology
- **Reported:** 2026-08-04 by user ("each project's agent would refine itself → out of sync?")

## The concern
As sessions in different projects (claude-station, external-project-A, external-project-G) learn +
refine rules, their methodologies could diverge.

## Assessment — mostly prevented already, three real gaps
Prevented today: there is ONE shared Working-Agreement template all projects inject
(read-through from a single file), NOT per-project copies. A UNIVERSAL refinement from any
project updates the one source → propagates everywhere. §L routes learnings by scope
(universal → shared WA; project-specific → that project's local doc). So no "copies drift".

Remaining GAPS (the real risk):
1. **Routing is discipline, not enforced** — an agent could misfile (project-specific rule
   into the shared WA = pollutes all; universal insight into a project doc = never propagates).
2. **Path-coupling** — the shared WA lives inside claude-station's repo (`docs/prompts/…`),
   fragile once renamed (FEAT-036) or moved.
3. **No scope audit** — nothing checks the shared doc stays universal + project docs stay local.

## Fix
- **Hoist the shared WA to a PROJECT-NEUTRAL Orchard location** (a shared config/data dir the
  station reads for ALL projects — claude-station becomes just another consumer, not special).
  Read-through (FEAT-027) points there.
- **Per-project local doc** convention for project-specific rules (a `docs/CONVENTIONS.md` or
  the project's CLAUDE.md), injected alongside the shared WA.
- **Enforce routing + scope**: when a rule is learned, the agent must classify universal vs
  project (§L) — and the consolidation loop (FEAT-019, question #5 "project-specific
  masquerading as universal") runs as an actual GATE, flagging misfiled rules on review.

## Verification (when built)
Edit the shared WA from a external-project-A session → claude-station's next session sees it (one
source). A project-specific rule added in external-project-A lands in external-project-A's local doc, not the
shared WA; the scope-check flags it if misfiled. verify + typecheck.

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
