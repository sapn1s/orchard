```orchard-ticket
{
  "id": "BUG-143",
  "type": "bug",
  "title": "Injected block-format instructions are 31 percent over their budget",
  "summary": "Every session launch injects a section teaching the response block format. That section has a stated size budget, checked by its own suite, and it is now 5245 characters against a 4000 budget. The check has been red since the section was extended, so every session pays the overrun on every launch.",
  "impact_if_we_wait": "Each session carries about 1,200 characters of extra instruction it was not budgeted, paid on every launch, and a red check in the grammar suite that everyone learns to read past.",
  "current_need": "Either bring the section back inside 4000 characters or restate the budget with the reason it moved — and say which, on the ticket that changed it.",
  "severity": "low",
  "area": "session instructions",
  "reported": "2026-08-25",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The injected section is inside whatever budget the suite states",
    "npm run verify:feat-091 is green, or its one failure is a different one",
    "Whichever way it is settled, the number is justified in writing rather than raised silently"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": true,
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

# BUG-143 — Injected block-format instructions are 31 percent over their budget

## Diagnosis

`verify-feat-091-response-blocks.mjs` asserts `the injected core stays inside its stated budget` — the injected section under 4000 characters. Measured today at b6c0151: 5245 characters. The budget was set by FEAT-091 round 12, when the vocabulary tripled and the point of the check was that cost discipline is the thing that has to hold. `src/server/templates.ts` was last changed by FEAT-098 (9799b9a), which gave the inside of a response block a shape — that is the change the overrun follows.

This is NOT BUG-111. BUG-111 touched `public/lib/response-blocks.js` and `public/lib/dom.js` and cannot move a prompt section composed in `templates.ts`.

## Evidence

`npm run verify:feat-091` at b6c0151: `TOTAL: 276 passed, 1 failed`, the single failure being

```
FAIL  the injected core stays inside its stated budget
        observed: {"sectionChars":5245}
```

## Risks

Cutting the section risks dropping a rule that a session needs; raising the budget risks the budget meaning nothing. Whichever is chosen, the check should end up green so the next real regression in that suite is visible.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — agent
- **Filed:** through the board tool; the record was validated before it was written.
