```orchard-ticket
{
  "id": "BUG-209",
  "type": "bug",
  "title": "Playwright QA specs fail to load: beforeAll called in wrong context",
  "summary": "npx playwright test scripts/qa/FEAT-042-model-chip.spec.ts (and FEAT-045, FEAT-051, BUG-026) exits 1 before running anything: 'Playwright Test did not expect test.beforeAll() to be called here' then 'No tests found'. Identical on a frozen pre-change tree copy, so it is environmental or config, not a code regression. Those provider/model UI specs currently guard nothing.",
  "impact_if_we_wait": "Every lane that names these specs as anti-regressions gets a false 'could not run'; the provider/model launch surfaces lose their browser coverage.",
  "current_need": "fix",
  "severity": "medium",
  "area": "test tooling (scripts/qa specs)",
  "reported": "2026-09-29",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-09-29",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "npm run verify:model-chip and verify:provider-launch run their tests",
    "The cause (duplicate @playwright/test, config import, or runner version) is named in the log"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
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

# BUG-209 — Playwright QA specs fail to load: beforeAll called in wrong context

## Symptom
`npx playwright test scripts/qa/FEAT-042-model-chip.spec.ts --reporter=line` (also `npm run verify:model-chip`) prints `Error: Playwright Test did not expect test.beforeAll() to be called here.` pointing at the first `test.beforeAll` in a spec, then `Error: No tests found.` and exits 1. Seen for FEAT-042, FEAT-045, FEAT-051 and BUG-026 specs on 2026-09-29.

## Repro
1. `cd ~/projects/orchard && npx playwright test scripts/qa/FEAT-042-model-chip.spec.ts --reporter=line`
2. Same command in a frozen rsync copy of the tree taken before the BUG-196 round-6 edits (`~/.local/state/claude-station/scratch/bug196-r6/tree-pre`, node_modules symlinked) gives the identical error — not caused by that change.

## Expected
The specs load and run. Playwright's own hint lists: two @playwright/test versions, beforeAll in a config-imported file, or an async describe.

## Context pack
- playwright.config.ts; package.json verify:* scripts using `playwright test`; node_modules/playwright vs @playwright/test versions.
- Logs: `~/.local/state/claude-station/scratch/bug196-r6/ar-qa-specs.log`, `ar-qa-042.log`, `pre-qa-042.log`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — BUG-196 round-6 fix lane (Opus 5.5) — filed
- **Understood:** hit while running provider/model UI specs as anti-regressions for BUG-196 round 6.
- **Verified:** identical failure on the working tree and on a frozen pre-change copy — pre-existing, not attributable to BUG-196.
- **Still open / handoff:** find which of Playwright's three listed causes applies; not investigated further (out of scope).
