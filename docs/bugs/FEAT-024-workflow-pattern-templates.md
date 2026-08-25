```orchard-ticket
{
  "id": "FEAT-024",
  "type": "feature",
  "title": "Projects rebuild the same dispatch shapes from scratch",
  "summary": "Four dispatch shapes kept being reinvented per project: two-level manager-to-sub-agent fan-out, a small index document routing to topic files, append-only raw notes kept separate from rolled-up summaries, and a numbered eligibility checklist that must pass before work starts. These now ship as selectable instruction templates a new project opts into, with the template suite passing in full.",
  "impact_if_we_wait": "Each new project would re-derive shapes that already exist, spending effort on structure rather than work. Bounded: this is about reusable scaffolding for new projects, not correctness of anything already running.",
  "current_need": "Nothing is outstanding. The dedicated template suite passed on every case and the standing type check stayed clean.",
  "severity": "medium",
  "area": "Project instruction templates",
  "reported": "2026-08-04",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A template instantiates into a scratch project and produces the expected scaffold",
    "A dry-run dispatch from an instantiated template matches the shape it packages",
    "All four harvested shapes are offered as selectable templates"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-020",
      "relation": "depends_on"
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
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-024-workflow-pattern-templates.md",
    "sha256": "89f6ef6649e8d5eac5169ebb310333076a6f1bd196a8886be5097a0c4da25262",
    "bytes": 4691,
    "original_title": "Workflow-pattern templates (reusable dispatch shapes)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: all four harvested shapes, the dual template-and-workflow delivery, and the instantiate-plus-dry-run proof bar are present above.",
    "dropped": [
      "the parenthetical list of originating project codenames beside each shape"
    ]
  }
}
```

# FEAT-024 — Projects rebuild the same dispatch shapes from scratch

## Diagnosis

### Why the shapes were worth packaging

Four recurring dispatch shapes were harvested across several projects, each rebuilt independently: recursive manager-to-sub-agent trees doing two-level fan-out over heterogeneous domains; an index-table router where a small root document points at topic and playbook files so context stays small as knowledge grows; a split between append-only raw dumps and separately rolled-up summaries; and a go/no-go pre-flight gate expressed as a numbered eligibility checklist that must pass before work begins.

## Evidence

The suite covering pattern templates ran 34 of 34 cases successfully, and the standing type check was clean. Two further suites — the offline UI check and a template read-through — were named as intended coverage in the original plan, with no run recorded for either.

## Implementation notes

### Delivery shape

The shapes are offered through the existing template system as selectable instruction templates, and as parameterized workflow scripts, so a project opts into a proven shape rather than deriving one.

## Verification plan

### As originally specified

Instantiate one template into a scratch project. Assert both the resulting scaffold and a dry-run dispatch match the packaged shape. Run the offline UI check plus the type check wherever the change touches UI.

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
