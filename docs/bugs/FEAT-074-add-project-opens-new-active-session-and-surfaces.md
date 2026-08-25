```orchard-ticket
{
  "id": "FEAT-074",
  "type": "feature",
  "title": "Adding a project landed on an old session and hid it",
  "summary": "Adding a project used to open one of its previously detected sessions, dropping the user into stale content. The project itself was inserted alphabetically and could land off-screen. Adding a project now opens a fresh active session and brings the project into view. The pre-fix cases failed and the corrected behaviour passed.",
  "impact_if_we_wait": "People started work in old content and had to hunt the list for the project they had just added. Bounded: this was navigation and starting position only, with no session content lost and no other project affected.",
  "current_need": "Nothing is outstanding. The four pre-fix cases failed before the change and passed after it, alongside clean standing checks.",
  "severity": "medium",
  "area": "Add-project flow",
  "reported": "2026-08-13",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-13",
      "question": "Should adding a project open a new session, or one of its detected sessions?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "A",
      "chosen_on": "2026-08-13",
      "chosen_by": "user",
      "note": "Open a fresh new session; detected sessions stay listed and can be opened explicitly."
    }
  ],
  "success_criteria": [
    "Adding a project opens a new session rather than a previously detected one",
    "The newly opened session is marked active before any message is sent",
    "The added project is at the top of the list or scrolled into view",
    "The opened session row is marked as the current item",
    "Leaving without sending removes the pending session row"
  ],
  "code_refs": [
    {
      "path": "app.js",
      "symbol": "addProject",
      "note": "opened a detected session instead of starting a new one"
    },
    {
      "path": "app.js",
      "symbol": "openSession/startNew",
      "note": "path the add-project flow now routes through"
    }
  ],
  "related": [
    {
      "id": "FEAT-073",
      "relation": "depends_on"
    },
    {
      "id": "BUG-087",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": false,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-074-add-project-opens-new-active-session-and-surfaces.md",
    "sha256": "77dd7106c88a24a0124583b35e6f6b34598bc3b26ad22c3ba71b2e89931bc967",
    "bytes": 5015,
    "original_title": "adding a project opens a NEW active session and the project surfaces in the navbar (top / scroll-into-view)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared clause by clause against the original head: both parts, the accepted design choice, the surfacing-relaxes behaviour, the §C proof bar and the anti-regression list are present.",
    "dropped": [
      "the parenthetical restating that detected sessions were 'arbitrary', already carried by the diagnosis"
    ]
  }
}
```

# FEAT-074 — Adding a project landed on an old session and hid it

## Diagnosis

### Part A — the opened session
`addProject` in `app.js` landed on one of the project's last detected claude sessions. Per the accepted design it now opens a fresh NEW session, active/current even before the first message (the FEAT-073 pending-new row). Detected sessions remain listed in the sidebar to open explicitly, which also avoids the BUG-087 confusion of landing in stale content.

### Part B — finding the project
A just-added project has no recent activity, so it inserted alphabetically and could land anywhere in the list. The project now surfaces on add: a synthetic recent-activity stamp floats it to the top under the recency sort, and/or the opened project and session are scrolled into view. The opened session is highlighted active per FEAT-073. If the user moves away without sending, the temporary surfacing relaxes — the pending session row is removed per FEAT-073 and the project keeps its natural sort position thereafter.

## Evidence

A must-FAIL-pre-fix proof was recorded: with `addProject` reverted to the BUG-087 baseline, the 4 must-FAIL cases failed as intended. After the fix, `verify:feat-070-sidebar` passed 14/14, `verify:bug-085-sidebar-cap` 11/11, `verify:feat-073-new-session-row` 12/12 and `verify:bug-087-stale-transcript` 6/6, with a further 7/7 tally recorded without an adjacent suite name. Typecheck and leak-gate were clean.

## Verification plan

Playwright/happy-dom: `addProject(suggested)` → a NEW session opens (not a detected old one), marked active (must FAIL pre-fix: opens a detected session); the added project is at TOP or scrolled into view (must FAIL pre-fix: alphabetical, off-screen); the opened session row is `aria-current`. Moving away unsent removes the pending row (FEAT-073 anti-regress). Anti-regressions named for the suite: `verify:addproject`, `verify:feat-070-sidebar`, `verify:bug-085-sidebar-cap`, `verify:feat-073*`, `verify:ui`, typecheck, leak-gate.

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
