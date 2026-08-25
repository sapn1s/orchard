```orchard-ticket
{
  "id": "BUG-085",
  "type": "bug",
  "title": "Recent sessions overflow the collapsed sidebar limit",
  "summary": "Collapsed project lists now show at most six sessions, while keeping the open session and explicit pins visible. Expanded lists can now collapse again without reloading. The recorded pre-fix case failed, corrected cases produced pass tallies, and standing checks stayed clean.",
  "impact_if_we_wait": "The sidebar becomes crowded and expanded lists require a reload to collapse. Bounded: this affects navigation and display-correctness, not session data, and reloading restores the collapsed view.",
  "current_need": "Treat the ticket as closed: the pre-fix case failed, corrected cases produced pass tallies, and standing checks stayed clean.",
  "severity": "medium",
  "area": "Session sidebar",
  "reported": "2026-08-13",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The collapsed project view shows at most six sessions ordered by recency",
    "Recent activity alone does not let sessions bypass the limit",
    "The open session remains visible",
    "Explicitly pinned old sessions remain visible",
    "Expanding reveals remaining sessions",
    "A collapse control restores the capped view without reloading"
  ],
  "code_refs": [
    {
      "path": "app.js",
      "symbol": "visibleSessions",
      "note": "Builds the session list shown in the sidebar"
    },
    {
      "path": "app.js",
      "symbol": "isAttentionSession",
      "note": "Treated every session active within 24 hours as exempt from the cap"
    },
    {
      "path": "app.js",
      "symbol": "renderTree",
      "note": "Renders expanded and collapsed project session lists"
    }
  ],
  "related": [
    {
      "id": "FEAT-070",
      "relation": "recurrence_of"
    },
    {
      "id": "FEAT-073",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "FEAT-070"
  ],
  "verification": [],
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
    "archived_path": "docs/bugs/archive/BUG-085-sidebar-attention-bypasses-6-cap-no-collapse.md",
    "sha256": "15a570d71824f77eda77fd578a03c463a76d7d0a134db30128e065b6c72974ca",
    "bytes": 5725,
    "original_title": "FEAT-070 regression: recent sessions bypass the ≤6 cap (full list shows), + no collapse-back after \"N more\"",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied original; the symptom, 24-hour cause, hard cap, pin exceptions, collapse behavior, evidence, and regression provenance remain represented.",
    "dropped": []
  }
}
```

# BUG-085 — Recent sessions overflow the collapsed sidebar limit

## Diagnosis

`isAttentionSession(sess)` returned true for every session active within 24 hours. FEAT-070 then treated those sessions as always visible without consuming the six-session budget. This allowed a busy project's entire recent list through. Expansion was also one-way until page reload.

## Evidence

The recorded pre-fix case with 12 recent sessions produced `PRE-FIX FAIL`. Corrected-case evidence includes unmatched pass tallies of 14/14 and 11/11. `typecheck` and `leak-gate` were reported clean. `verify:feat-070-sidebar`, `verify:ui`, `verify:attention`, and `verify:bug-085-sidebar-cap` were named without adjacent results, so they are suite mentions rather than recorded runs.

## Implementation notes

Apply a hard six-session limit to the collapsed, recency-ordered view. Only the open session and explicit user pins may remain visible beyond that limit. Recent activity can influence ranking within the limit but cannot bypass it. Replace one-way expansion with an in-place collapse affordance.

## Verification plan

Use a project containing 12 sessions active within 24 hours. Confirm the collapsed view shows at most six, includes the open session, preserves an old explicit pin, expands to show the remainder, and collapses in place. Retain the seven-day eligibility window while enforcing the hard collapsed limit.

## Risks

Exempting attention-marked sessions again would silently restore the overflow. Applying the cap without preserving the open session or explicit pins would hide sessions the user expects to remain visible.

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from user report + confirmed root cause (isAttentionSession 24h-baseline bypasses the cap).
  Regression of FEAT-070; client-only, reaches users on reload.

### 2026-08-13 — worker (fix + §C)
- Root cause exactly as filed: `visibleSessions` (app.js) pushed every `isAlwaysVisible` session
  (open OR `isAttentionSession`) in "without spending the cap budget", and `isAttentionSession`
  is true for anything active within 24h — so a busy day made the whole list bypass the ≤6 cap.
- Fix 1 — HARD ≤6 cap (public/app.js `visibleSessions` + `isAlwaysVisible`/`isAttentionSession`
  comments): `isAlwaysVisible` is now the OPEN session ONLY (the one on-screen bypass). Attention no
  longer buys a seat past the cap — it competes in a `pool` that is capped to `s.shown` (default
  PAGE=6), and only RANKS first WITHIN that pool (a stable sort by `isAttentionSession`, recency
  preserved among equals). Attention stays exempt from the 7-day WINDOW (an old-but-active session
  still competes for a seat rather than being folded outright), but it must earn a capped seat like
  everything else. Pins keep their own always-on block (an explicit user act may exceed the cap).
  Display order stays recency (attention priority only decides WHICH make the cut).
- Fix 2 — collapse-back (public/app.js renderProjectGroup + styles.css `.tree .more.less`): once the
  window is lifted or the reveal has grown past PAGE, a "▴ Show less" control renders under "N more"
  and resets `s.windowed=true; s.shown=PAGE` in place via renderTree — no page reload (expansion was
  one-way until refresh before).
- §C — scripts/verify-bug-085-sidebar-cap.mjs (REAL app.js in happy-dom vs a REAL server, drives the
  REAL renderTree/visibleSessions over controlled state, asserts on the produced DOM):
  - A: 12 sessions ALL active within 24h → default shows EXACTLY 6 rows + "6 more" (PRE-FIX FAIL:
    rows=12, no "more" — the exact case FEAT-070's suite missed).
  - B: with a pinned OLD + the OPEN old session added, both show past the cap and EXACTLY 6 recents
    make the cut (attention bought no extra seat).
  - C: "N more" reveals all; a "▴ Show less" control appears (PRE-FIX FAIL: no collapse control) and
    returns to the capped 6 IN-PLACE (no reload); the control then disappears.
  - POST-FIX: 11/11 PASS. PRE-FIX (app.js/styles stashed): the A/collapse cases FAIL as designed.
- Updated verify:feat-070-sidebar's cap case that wrongly passed: it dodged the bug by marking its 8
  sessions seen/non-attention; it now uses 8 recent+UNSEEN (all attention) sessions, so it genuinely
  proves the HARD ≤6 cap (rows=6 + "2 more"). PRE-FIX that case FAILs (rows=8, no "more"); the rest
  of the suite is unchanged. POST-FIX: 14/14 PASS.
- Anti-regressions all green: verify:feat-070-sidebar (14/0), verify:attention (4/0), verify:ui
  (7/0), typecheck (0), leak-gate (PASS — also sanitized a pre-existing raw home path in the
  FEAT-071 ticket to `~/…` so the gate passes).
- Commit: BUG-085: hard ≤6 session cap (attention ranks within, not beyond) + collapse-back toggle.
