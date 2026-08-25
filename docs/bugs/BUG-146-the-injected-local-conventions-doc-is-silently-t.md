```orchard-ticket
{
  "id": "BUG-146",
  "type": "bug",
  "title": "the injected local-conventions doc is silently truncated to a fifth",
  "summary": "localConventionsSection() hard-caps docs/CONVENTIONS.md at 4,000 chars. This repo's file is 18,277 — so ~79% of it never reaches a session, and the cut lands mid-row inside the FEAT-100 charter-grammar table. Nothing warns; the doc looks injected and is mostly not. Any rule written past line ~66 is a no-op on live sessions.",
  "impact_if_we_wait": "Project rules are written, committed, believed to be in force, and never delivered. The testing conventions, the rg-not-grep rule and the separate-process verification rule are all past the cut today, and an author has no way to notice.",
  "current_need": "Decide whether the cap rises, whether the doc gets an inject-marked region like ROUTING.md and RESPONSE_FORMAT.md, or whether truncation becomes loud.",
  "severity": "medium",
  "area": "instruction injection",
  "reported": "2026-08-25",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A rule written into docs/CONVENTIONS.md either reaches a launched session or its omission is reported somewhere the author sees it.",
    "No injected section ends mid-word or mid-table-row.",
    "The chosen mechanism is consistent with the marked-region pattern ROUTING.md and RESPONSE_FORMAT.md already use.",
    "The composed prompt's total size is stated before and after, since the WA already takes 67% of it."
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

# BUG-146 — the injected local-conventions doc is silently truncated to a fifth

## Measured, on this repo, today

| section | source size | injected | delivered |
|---|---|---|---|
| Working Agreement v2 | 24,598 B | 24,403 | whole — no cap on this path |
| Project Conventions (local) | 18,277 chars | **4,000** | **~3,767 after the 233-char header ≈ 66 of 309 lines** |
| Provider Routing (marked region) | 2,469 | 2,469 | whole (cap 4,000) |
| Response Format (marked region) | 5,245 | 5,245 | whole (cap 6,000) |
| Project state (board snapshot) | — | **1,200** | at the cap, ends mid-word |

Composed append total ≈ 36,138 chars ≈ 9,035 tokens, of which the WA is 67%.

The cut inside CONVENTIONS.md lands mid-table-row in the FEAT-100 `Dispatch:` grammar table, with the last delivered fragment ending `…which attempt this is`. Everything from ~line 67 on is absent from every session, including:

- the whole Testing section (test against the real artifact; test invariant properties; must-FAIL not anchored to a moving baseline; partial and truncated reads)
- the `rg`-not-the-Bash-`grep`-shim rule (BUG-103)
- the scratch-server isolation knob (BUG-117)
- "Separate process, not a subagent" — the verification rule at `:306-309`

## Why this is not merely a number to raise

The cap exists for a real reason (`templates.ts:301-305`): this competes for the same attention budget as the WA and the board snapshot. Raising it to fit 18k would push the composed append past 50k. The marked-region pattern the two neighbouring sections already use is the shape that solves it — the author declares which part is agent-facing — but that puts the choice on the author, so truncation of what is left must still be visible rather than silent.

Note the asymmetry worth a sentence in whatever fixes this: the shared WA is injected whole and uncapped at 24k, while a project's own conventions are cut to 4k. That ordering may be backwards.

## Context pack (grows — the "where to look", so no agent cold-starts)
- `src/server/templates.ts:301-325` (`localConventionsSection`, the 4,000 default), `:349-376` (`routingSection`, marked region), `:419-468` (`responseFormatSection`, marked region), `:501-620` (fold order)
- `src/server/board.ts:756-830` (`boardStateSection`, the 1,200 cap, also biting)
- `src/server/agent-bridge.ts:751-760`, `:1064-1066` (the launch-time folds)
- Related: FEAT-039 (why local conventions exist), FEAT-043, FEAT-084, BUG-145 (a rule's home must actually be injected)

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-25 — orchestrator
- **second half of the same defect: the empty stub is not free:** **Found while verifying what a REAL newly-onboarded project receives** (fresh dir, `node scripts/onboard.mjs <dir>`, then `localConventionsSection()` against it):

  The `CONVENTIONS_STUB` that `scripts/onboard.mjs:313-328` writes into every onboarded project contains **no rules at all** — it is a paragraph explaining what the file is for, plus an HTML comment saying "Add this project local rules below". `localConventionsSection()` treats it as present and injects **977 chars (~244 tokens) into every turn of every session in that project**, forever, to say nothing.

  So the cap defect has two halves and they point opposite ways:
  - A project that has WRITTEN conventions gets ~79% of them silently dropped (the original finding).
  - A project that has written NONE pays ~244 tokens per turn to be told the file exists.

  The emptiness test is already there and already correct in shape — `templates.ts:309-310` returns null on a blank body — it just cannot see that a stub is semantically empty. Whatever fixes the cap should also make "the stub, unmodified" inject nothing: comparing against the known stub text, or requiring content outside the scaffolded comment, are both cheap. That keeps the FEAT-039 opt-in contract honest: a project with nothing to say should cost nothing.

  **Not fixed here** — recorded so the fixer sizes the change once. Verified only that the stub injects (977 chars) and that a genuinely blank file injects nothing.
