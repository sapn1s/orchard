# BUG-085 — FEAT-070 regression: recent sessions bypass the ≤6 cap (full list shows), + no collapse-back after "N more"

- **Status:** VERIFIED — fixed 2026-08-13 (hard ≤6 cap + collapse-back; §C incl. must-FAIL pre-fix 12-recent→6)
- **Area:** FE sidebar tree (app.js visibleSessions / isAttentionSession / renderTree)
- **Reported:** 2026-08-13 by user:
  > "it now shows full list of recent sessions, even tho i asked to keep only top last 6 max by
  > default when not expanded, plus no option to collapse back after expanding? only if reloading page?"

## Root cause (confirmed)
`isAttentionSession(sess)` (app.js) returns true for ANY session whose `lastActivityAt` is newer
than 24h ago (baseline `Date.now() - 24h` when unseen). FEAT-070's `isAlwaysVisible` forces those
in **"without spending the cap budget"** — so every session active in the last 24h bypasses the ≤6
cap. A user working across many sessions in a day gets the full list, defeating the "≤6 default"
the ticket asked for. FEAT-070's suite tested "a pinned OLD session stays visible" but never
"many RECENT sessions still cap at 6", so 14/14 passed while missing this.

## Wanted
1. **Hard ≤6 default.** The default (collapsed) per-project view shows at most 6 sessions,
   recency-ordered — regardless of how many are "recent"/active. Recent activity must NOT explode
   the list. The currently-open session always shows; genuinely user-PINNED sessions may show
   beyond the cap (that's an explicit user act), but "active in 24h" must not. Re-scope
   isAttentionSession / isAlwaysVisible so only true pins + the open session bypass, or fold
   attention into ranking WITHIN the cap rather than beyond it. (Keep the 7-day window too, but the
   cap is the hard limit the user cares about.)
2. **Collapse-back affordance.** After "N more" expands a project, provide a way to collapse it
   back to the capped view WITHOUT reloading the page (e.g. the "N more" becomes a "show less" /
   collapse toggle, or a caret). Today expand is one-way until reload.

## Verification (§C)
Playwright/happy-dom: a project with, say, 12 sessions ALL active within 24h → default view shows
exactly ≤6 (must FAIL pre-fix: shows all 12); the open session always present; a user-pinned old
session still shows; "N more"/expand reveals the rest; a collapse control returns to ≤6 in-place
(no reload) (must FAIL pre-fix: no collapse control). Anti-regressions: verify:feat-070-sidebar
(update the case that wrongly passed), verify:ui, verify:attention, typecheck, leak-gate.

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
