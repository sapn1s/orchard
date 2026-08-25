# FEAT-024 — Workflow-pattern templates (reusable dispatch shapes)

- **Status:** VERIFIED
- **Area:** claude-station templates + Workflow
- **Reported:** 2026-08-04 (harvested from integrity / external-project-C / external-project-D / external-project-F)

## Goal
Package the recurring dispatch SHAPES so a project doesn't rebuild them:
- **Recursive manager→sub-agent trees** (integrity): 2-level fan-out over
  heterogeneous domains.
- **Index-table router** (integrity/external-project-C/external-project-D): a small root doc
  pointing to topic/playbook files, so context stays small as knowledge grows.
- **Raw + curated memory split** (external-project-F/external-project-D/gpu): append-only raw dumps +
  separately rolled-up summaries.
- **Go/no-go pre-flight gate** (integrity): a numbered eligibility checklist that
  must pass before work begins.

## Design
Offer these as selectable instruction templates (existing template system) and/or
parameterized Workflow scripts, so a new project opts into a proven shape.

## Verification (REQUIRED)
Instantiate one template into a scratch project; assert the scaffold + a dry-run
dispatch matches the shape. verify:ui offline + typecheck where UI-touching.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed. Lower urgency than FEAT-021/022; high long-term leverage for new projects.

### 2026-08-04 — builder
- Implemented as four opt-in instruction templates, mirroring the existing
  Working-Agreement read-through seed mechanism in `src/server/templates.ts`
  (`seedTemplates()` / `DEFAULT_SEED_SOURCES` / `readTemplate()` source
  resolution — no new mechanism needed).
- Added content files under `docs/prompts/patterns/`:
  - `MANAGER_SUBAGENT_TREE.md` — recursive manager→sub-agent trees (2-level
    fan-out, one manager per domain).
  - `INDEX_TABLE_ROUTER.md` — small root table pointing to topic/playbook
    files.
  - `RAW_CURATED_MEMORY_SPLIT.md` — append-only raw log + separately
    rewritten curated rollup.
  - `GO_NO_GO_PREFLIGHT.md` — numbered eligibility checklist, hard stop on
    any failing item.
  Each has "When to use" / "When NOT to use" / "How to run it" / "Failure
  modes to avoid" sections — concrete, not fluff.
- Registered all four in `seedTemplates()` (`src/server/templates.ts`) as
  `source`-backed, non-living, `defaultMode: 'append'` seeds with ids
  `pattern-manager-subagent-tree`, `pattern-index-table-router`,
  `pattern-raw-curated-memory-split`, `pattern-go-no-go-preflight`. They are
  **opt-in**: seeding only adds them to the template library (listable,
  selectable); nothing auto-references them the way a project's default WA
  refs might — a project only gets one in its system prompt if its
  `InstructionRef` list explicitly selects it. Did not touch `public/app.js`,
  `src/server/index.ts`, `src/server/agent-bridge.ts`, or
  `docs/prompts/WORKING_AGREEMENT.v2.md`, per scope.
- Added `scripts/verify-pattern-templates.mjs` (registered as
  `npm run verify:pattern-templates`), mirroring
  `scripts/verify-template-readthrough.mjs`'s throwaway-temp-data-dir
  approach (no server on :4317). Checks: (1) `seedTemplates()` seeds all four
  pattern ids alongside the two WA docs; (2) a second call is idempotent
  (all four reported `skipped`, none re-`seeded`); (3) a user hand-edit
  (`saveTemplate(..., overwrite:true, source:'')`) survives a subsequent
  `seedTemplates()` call untouched — respects the existing
  conflict/backup/skip-if-exists rule, doesn't clobber; (4) each is listable
  via `listTemplates()` with non-empty name/description and a real
  read-through body from its `docs/prompts/patterns/*.md` source; (5) each
  composes into the system prompt via `composeInstructions()` when its
  `InstructionRef` is selected, is ABSENT when not selected (proves opt-in,
  not auto-injected), and all four compose together cleanly with distinct
  sections.
- **Verified:** `npm run verify:pattern-templates` → 34/34 checks PASS.
  `npm run typecheck` → clean (no errors). No server touched; verify script
  uses its own temp `CLAUDE_STATION_DATA` dirs, cleaned up in `finally`.
- Nothing open. Workflow-script parameterization (the "and/or parameterized
  Workflow scripts" line in the Design section) was intentionally left out —
  out of the stated SCOPE (`src/server/templates.ts`, `docs/prompts/patterns/*`,
  a verify script, this ticket) and the instruction-template form already
  satisfies the goal of making these shapes selectable/reusable.

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
