```orchard-ticket
{
  "id": "BUG-086",
  "type": "bug",
  "title": "Pinned sessions look like the open session",
  "summary": "Pinned sessions now use a quieter marker instead of the active highlight. The open session remains visually dominant when it is also pinned. The pre-fix case failed, a 12/12 pass tally was recorded, and standing checks stayed clean.",
  "impact_if_we_wait": "People may momentarily mistake a pinned session for the open session. Bounded: this affects sidebar display-correctness, not session state, stored data, or which session is actually open.",
  "current_need": "Treat the ticket as closed: the pre-fix case failed, the corrected styling passed, and standing checks stayed clean.",
  "severity": "not_recorded",
  "area": "Session sidebar",
  "reported": "2026-08-13",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A pinned unopened session lacks the active highlight and retains a quieter pin marker",
    "The open session keeps the active highlight",
    "A session that is both pinned and open shows the active state and pin marker",
    "An unpinned unopened session remains plain",
    "The distinction stays within the existing greyscale palette"
  ],
  "code_refs": [
    {
      "path": "styles.css",
      "symbol": ".row.pinned",
      "note": "Provides the quieter pinned-session treatment"
    },
    {
      "path": "styles.css",
      "symbol": ".row[aria-current]",
      "note": "Provides the visually dominant open-session state"
    }
  ],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
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
    "archived_path": "docs/bugs/archive/BUG-086-pinned-sessions-look-active-not-pinned.md",
    "sha256": "0f4c8833f98a177785de417326a33ab38f01460d741acada9940e0f93369e760",
    "bytes": 4038,
    "original_title": "pinned sessions render like the ACTIVE/open session (highlighted), making it unclear which one is actually open",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied original; the symptom, visual precedence, greyscale constraint, evidence, and requested row-state coverage are preserved.",
    "dropped": []
  }
}
```

# BUG-086 — Pinned sessions look like the open session

## Diagnosis

Pinned rows used emphasis resembling the active highlight associated with `aria-current="true"`. The visual overlap made a saved location look like the session currently open.

## Evidence

BUG-086 records `pre-fix (3 must-FAIL` as the failure proof and a later 12/12 pass tally without an adjacent suite name. `typecheck` and `leak-gate` were reported clean. `verify:ui`, `verify:attention`, and `verify:bug-086-pin-style` were named, but no results were recorded for those suite names.

## Implementation notes

Keep the active highlight for the open session. Render pinned state with a quieter pin marker. When both states apply, retain the active treatment and show the pin as a secondary marker. Reuse the existing greyscale tokens.

## Verification plan

Compare computed styling for pinned unopened, open, pinned-and-open, and plain rows. Confirm only the open states receive the active highlight and pinned states retain the pin marker.

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from user report. Client-only (styles.css + maybe app.js class/marker). The pin should be
  a marker, not an active-style highlight; only aria-current=true is the "open" highlight.

### 2026-08-13 — worker (fix)
- Root cause: the pin indicator was a hairline `::before` bar down the row's LEADING edge
  (`.row.pinned::before`, `background: var(--ink-3)`). A leading-edge bar reads as a
  selection/active affordance, so a merely-pinned row looked like the open one.
- Fix (greyscale, reuses tokens):
  - `public/app.js` `sessionRow()` — pinned rows now append an explicit pin GLYPH element
    `<span class="pin-mark">` (the existing `MENU_ICON.pin` path via `svg()`), so the mark reads as
    "pinned" rather than "selected". Marker appears ONLY on pinned rows.
  - `public/styles.css` — removed `.row.pinned::before` (and its hover/current variants); added
    `.row .pin-mark` (trailing edge, `--ink-4`, quiet), `.row[aria-current="true"] .pin-mark`
    (`--ink-2`, secondary on the open row), `.row.pinned:hover .pin-mark` (`--ink-3`). The active
    highlight (`background: var(--hair); color: var(--ink)`) stays bound to `aria-current="true"`
    alone — the sole "you are here" state. The `.row.pin-last` group divider is unchanged.
- Behaviour: OPEN row keeps the active highlight; pinned-not-open reads exactly as un-selected as a
  plain row (same background + ink) plus a quiet pin glyph; pinned-AND-open shows the active
  highlight AND the pin glyph (active wins). Plain/open-unpinned rows carry no glyph.
- Verify (§C): new `scripts/verify-bug-086-pin-style.mjs` (npm `verify:bug-086-pin-style`) — boots
  the REAL app.js in happy-dom against a REAL server with the REAL styles.css injected, two render
  scenarios (open-unpinned; open-and-pinned). **12/12 PASS post-fix; 9/12 pre-fix (3 must-FAIL: the
  pin-marker reads — no marker element existed pre-fix).**
- Anti-regressions: `verify:ui` 7/0, `verify:attention` 4/0, `typecheck` clean, leak-gate PASS.
- Status → RESOLVED (verified).
