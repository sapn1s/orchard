```orchard-ticket
{
  "id": "BUG-235",
  "type": "bug",
  "title": "Quote-nested or tab-indented orchard fold renders its table as one paragraph",
  "summary": "A fold nested in a block quote or tab-indented list item renders its table as one literal paragraph, even intact.",
  "impact_if_we_wait": "Any reply that quotes a fold containing a table shows unreadable pipe source in the reading view.",
  "current_need": "Strip the fold's container prefix from its body content before rendering, then verify the table renders.",
  "severity": "low",
  "area": "client renderer (response-blocks.js block content)",
  "reported": "2026-10-06",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-06",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A quote-nested orchard-answer fold with a GFM table renders a <table> in the real browser renderer."
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

# BUG-235 — Quote-nested or tab-indented orchard fold renders its table as one paragraph

## Symptom

Found by the BUG-234 r3 render sweep (scripts/verify-bug-234-single-authority.mjs, intact baseline legs). It reproduces on intact text, so it is not a truncation effect.

## Repro

The following renders as `<div class="orchard-blk orchard-answer"><div class="prose"><p>&gt; Here is it: &gt; &gt; | A | B | ...</p>`, and no `<table>` is produced:

    renderAssistantText('> ````orchard-answer\n> Here is it:\n>\n> | A | B |\n> | --- | --- |\n> | x | y |\n> ````')

The same happens for `- item` followed by a quoted fold, for a list inside a quote, and for a tab-indented list item fold. The fold body handed to prose() keeps each line's container prefix.

## Expected

The fold body renders as if it were top-level content, which means a real `<table>`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-07 — agent (BUG-234 fixing r3)
- Filed from the BUG-234 r3 sweep baseline. Not fixed there, because it is out of scope: a fold-body content defect in the client grammar module, not truncation.
