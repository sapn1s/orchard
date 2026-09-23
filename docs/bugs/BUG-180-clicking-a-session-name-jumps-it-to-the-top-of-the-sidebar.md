# BUG-180 — clicking a session name jumps it to the top of the sidebar, moving the rows you were aiming at

- **Status:** IN-PROGRESS
- **Severity:** medium
- **Area:** sidebar (session list ordering)
- **Reported:** 2026-09-18 by user
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.
- **regressed-from:** BUG-160

## Symptom
User, verbatim: "orchard project nav bar bug or miss feature: when i click on session
name, it gets auto to top as if active, but that fucks up navigation, instead the
activity depends per last msg or whatever makes sense ux".

Merely selecting a session (a plain click to look at it) promotes that row to the top
of its project's session list. The row jumps out from under the cursor and every
neighbour shifts down, so the next click lands on the wrong session. Ordering tracks
SELECTION, when the user wants it to track ACTIVITY.

## Repro
1. Open the dashboard, expand a project with several sessions.
2. Note the order of the non-pinned rows.
3. Click a session that is NOT already at the top of the group.
4. Wrong: the clicked session immediately moves to the top of the non-pinned block
   (just under the pinned block) and the other rows slide down.

## Expected
Selection changes the HIGHLIGHT only (`aria-current` on the row), never a row's
POSITION. Order is: pinned block first, then everything else by recency — the last
time the user actually submitted a message (`recencyKey`/`lastUserMessageAt`), which
is the "order by last message" the user asked for. An actual human submit re-sorts;
plain selection and agent frames leave the order untouched. The list is stable under
navigation.

## Root cause
`orderedSessions(s)` in `public/app.js` gave the currently-open session its own
ordering tier. The rank function was:

    const isOpen = (x) => state.current.sessionId != null
      && x?.sessionId === state.current.sessionId
      && x?.encodedDir === state.current.encodedDir;
    const rank = (x) => (api.pinnedOf(x) ? 0 : (isOpen(x) ? 1 : 2));

So `pinned → 0`, `open → 1`, `everything else → 2`. Selecting a session sets
`state.current`, which lifts it to rank 1 = top of the non-pinned block.

This tier was added by BUG-160 (commit 8016442) to solve a "keep refinding when
switching until i page reload" complaint. The initial public release (609db5e) had
`rank = (x) => (api.pinnedOf(x) ? 0 : 1)` — no selection tier — which is exactly the
stable behaviour the user now wants. The BUG-160 tier is the regression.

## Fix (design choice recorded)
Remove the `isOpen` tier. `rank = (x) => (api.pinnedOf(x) ? 0 : 1)`; the recency
secondary sort (`recencyKey` desc) is unchanged. Selection highlight is already
carried independently by `aria-current` (sessionRow, app.js), so nothing about the
highlight regresses. An open-but-aged-out session stays VISIBLE via `isAlwaysVisible`
in `visibleSessions` — it keeps its recency slot instead of being teleported to the
top. This is strictly better than both prior states: no jump-under-cursor AND a stable
list means the "refinding" complaint BUG-160 targeted also goes away (nothing moves,
so there is nothing to re-find). Chosen ordering = pinned, then recency (last user
message) desc. This is the sensible UX; not asking the user to pick.

## Context pack
- Files/functions in play: `public/app.js` — `orderedSessions()` (~line 1391);
  `recencyKey()`, `stampUserSubmit()` (the real-activity re-sort, kept as-is),
  `sessionRow()` `aria-current` highlight, `visibleSessions()`/`isAlwaysVisible`.
- Related tickets: BUG-160 (introduced the tier), BUG-085 (seat cap), FEAT-070
  (recency ordering).
- Repro: live Playwright DOM-order check against the running server (below).
- Known blockers: `public/app.js` was under a live FEAT-129 write-lock held by a
  concurrent multi-file lane (`cs-mu611xy2-j`) when this ticket was filed — see log.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-18 — worker (fixing, round 1)
- **Understood:** Hypothesis (selection promotes to top) CONFIRMED against real code
  and the live app. Cause is the `isOpen` rank tier in `orderedSessions`, a BUG-160
  regression off the initial-release behaviour.
- **Must-FAIL proof (executed, live server :4317, pre-change code):** expanded a
  project with 8 rows (1 pinned + 7 non-pinned). Clicked the row at index 3
  ("Review project board and conversation…"). Observed order:
  - before: [pinned, "Fix navigation…", "Review orchestrator…", "Review project
    board and conversation…"(idx3), "Add second Claude…", "Review output…",
    "Review project board and select…", "Review handoff…"]
  - after:  ["Review project board and conversation…" now at idx1], the rows it was
    between pushed down. `aria-current` moved to idx1. clicked went idx3 → idx1.
  This is the reorder-under-cursor the user reported.
- **Changed:** (pending — app.js locked at time of writing) `public/app.js`
  `orderedSessions` rank → `pinned ? 0 : 1`, dropping the `isOpen` tier and its
  comment block. Exact replacement text is in this ticket's Fix section.
- **Post-fix verification:** to run once the lock frees — reload the live app, repeat
  the click-order measurement, assert the non-empty list order is UNCHANGED across the
  click and that `aria-current` still follows the click; screenshot the sidebar.
- **Still open / handoff:** apply the one-line edit + run post-fix live check + `npm
  run gate`. If this lane cannot acquire the lock, the exact edit above is ready for
  whichever lane holds app.js to apply.
