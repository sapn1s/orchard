# FEAT-074 — adding a project opens a NEW active session and the project surfaces in the navbar (top / scroll-into-view)

- **Status:** VERIFIED — fixed 2026-08-13 (parts A+B; §C incl. must-FAIL-pre-fix proof + FEAT-073 drop regression)
- **Area:** FE add-project flow (app.js addProject → openSession/startNew + sidebar surface)
- **Reported:** 2026-08-13 by user (design decided with orchestrator: add-project → new session)

## Two parts
### A — add-project should open a NEW session (not an arbitrary detected one)
Today add-project lands on one of the project's last detected claude sessions. Per the orchestrator
recommendation the user accepted: **add-project should open a fresh NEW session** (active/current,
even before the first message — the FEAT-073 pending-new row), NOT auto-open an old detected
session. The detected sessions remain listed in the sidebar to open explicitly. (This also avoids
the BUG-087 confusion of landing in stale content.)

### B — the newly-added project must be findable in the navbar
When the project is added it currently inserts alphabetically (no "recent" activity yet), so it can
land anywhere in the list and the user has to hunt for it. Wanted: on add, the project **surfaces**
— either floated to the TOP as temporarily-most-recent (stamp a synthetic recent activity for the
just-added/just-opened project so the recency sort puts it up top), and/or **scrolled into view**
so the opened project+session is visible. The opened session is highlighted active (FEAT-073).
If the user moves away without sending, the temporary surfacing can relax (the pending session row
is removed per FEAT-073; the project keeps its natural sort position thereafter).

## Verification (§C)
Playwright/happy-dom: addProject(suggested) → a NEW session opens (not a detected old one), marked
active (must FAIL pre-fix: opens a detected session); the added project is at TOP or scrolled into
view (must FAIL pre-fix: alphabetical, off-screen); the opened session row is aria-current. Moving
away unsent removes the pending row (FEAT-073 anti-regress). Anti-regressions: verify:addproject,
verify:feat-070-sidebar, verify:bug-085-sidebar-cap, verify:feat-073*, verify:ui, typecheck,
leak-gate.

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from user report; design (add-project → new active session) agreed. Depends on FEAT-073
  (pending-new row) — dispatch AFTER FEAT-073 lands. Client-only. Same app.js lane, serialize.

### 2026-08-13 — worker (fix + §C)
- Studied `addProject` (public/app.js): after BUG-087 it reset the pane but opened a bare
  New-session `state.current` WITHOUT `state.pendingNew` (so no FEAT-073 row) and left the new
  project at its natural sort — a brand-new project has no `lastActivityAt`, so the recency sort
  (`projLess`, app.js:607) sank it to the BOTTOM and the user had to hunt for it.
- FIX (public/app.js `addProject`):
  - Part A: replaced the manual New-session setup with `startNew(p.id)` — the FEAT-073 pending-new
    path. It sets `state.pendingNew`, resets the transcript (BUG-087 hygiene retained), focuses the
    composer, and renders the pending-new row aria-current at the project top. Detected sessions stay
    listed (renderProjectGroup still lists on-disk history); none is auto-opened.
  - Part B: SURFACE the project by floating it to the front of the STABLE captured order —
    `state.projOrder = [p.id, ...state.projOrder.filter(id => id !== p.id)]` right after
    `loadProjects()` (which reset+resorted). `orderedProjects()` then renders it first; it relaxes to
    its natural sort on the next explicit resort (loadProjects / sort toggle) per the ticket — no lie
    stamped onto `lastActivityAt`. Also `scrollIntoView({block:'nearest'})` on the pending row so it
    is visible even in a long list.
- §C — scripts/verify-feat-074-add-project-surface.mjs (npm `verify:feat-074-add-project-surface`):
  REAL app.js in happy-dom vs a REAL server; drives the REAL addProject over a freshly-created temp
  dir (named `zzz-…` so a pre-fix recency/alpha sort would place it LAST, making "surfaces to the
  top" a genuine must-FAIL).
  - POST-FIX: 7/7 PASS.
  - PRE-FIX (addProject reverted to the BUG-087 baseline): the 4 must-FAIL assertions FAILED —
    `state.pendingNew` unset, no pending-new aria-current row for the added project, and the project
    did NOT float to the top (neither `orderedProjects()[0]` nor the first rendered group). The
    "opens a New session (no sessionId)" precondition and the FEAT-073 drop regression stayed green
    pre AND post.
- Anti-regressions all green: verify:addproject (7/0), verify:feat-070-sidebar (14/14),
  verify:bug-085-sidebar-cap (11/11), verify:feat-073-new-session-row (12/12),
  verify:bug-087-stale-transcript (6/6, addProject still resets the pane), verify:ui (7/0),
  typecheck (0), leak-gate (PASS).
- Status → VERIFIED. Commit: "FEAT-074: add-project opens a new active session + surfaces the project".
