```orchard-ticket
{
  "id": "FEAT-070",
  "type": "feature",
  "title": "Sidebar buried recent work under stale projects and sessions",
  "summary": "The project list was ordered alphabetically, so the project someone worked in last could sit anywhere. Each project also showed a flat six sessions, mixing yesterday's work with sessions weeks old. Projects now lead with the most recently worked, with an alphabetical toggle, and each project shows only sessions inside a recency window.",
  "impact_if_we_wait": "People scanned past stale entries to reach current work on every visit. Bounded: this was ordering and visibility in the navigation only. No session, project or transcript data was affected, and everything older stayed reachable under the existing overflow control.",
  "current_need": "Nothing is outstanding. Both behaviours failed on the pre-fix build and passed after the change, with churn stability covered by a regression case and standing checks clean.",
  "severity": "medium",
  "area": "Session sidebar",
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
      "question": "Should projects order by recency, given the earlier decision against it?",
      "mode": "single",
      "options_keys": [
        "recency-default-with-alpha-toggle",
        "keep-alphabetical"
      ],
      "chosen": "recency-default-with-alpha-toggle",
      "chosen_on": "2026-08-13",
      "chosen_by": "user",
      "note": "An earlier note in the code rejected recency ordering over reorder churn. The user resolved it by making recency the default and adding a toggle back to alphabetical, with churn mitigated and documented."
    }
  ],
  "success_criteria": [
    "Projects render most-recently-worked first by default",
    "The sort control flips between recency and alphabetical and back",
    "A project with sessions spanning weeks shows only those inside the window",
    "At most six sessions show before the overflow control",
    "A pinned or active old session stays visible outside the window",
    "Project order stays stable during a session rather than reshuffling on activity"
  ],
  "code_refs": [
    {
      "path": "app.js",
      "symbol": "renderTree",
      "note": "project ordering and the per-project session cap"
    },
    {
      "path": "app.js",
      "symbol": null,
      "note": "line 177 carried the earlier written rationale against recency ordering"
    },
    {
      "path": "app.js",
      "symbol": null,
      "note": "lines 521 and 733 already sorted sessions by recency"
    }
  ],
  "related": [
    {
      "id": "BUG-085",
      "relation": "recurrence_of"
    },
    {
      "id": "FEAT-073",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
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
    "archived_path": "docs/bugs/archive/FEAT-070-sidebar-recency-order-and-recent-session-window.md",
    "sha256": "4e00a08282b80dbf2d1e458ac856097e1f926476f437a8b9f164c156b13f63a1",
    "bytes": 5951,
    "original_title": "sidebar: order projects by recency (with optional alpha sort) + default sessions to a recency window, not a flat 6",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Both issues, the prior-decision reconciliation and its resolution, the window-plus-cap rule, the pin exemption, and the must-FAIL-pre-fix bar are all present above.",
    "dropped": [
      "the candidate window list of 24h/3d/1 week, kept only as the chosen ~1 week default",
      "the conditional 'expose as a setting if cheap, otherwise follow-up' framing, which is summarised in implementation notes rather than raised as an open choice"
    ]
  }
}
```

# FEAT-070 — Sidebar buried recent work under stale projects and sessions

## Diagnosis

Two independent defects in the same render path. Projects were sorted by name, so activity had no effect on position. Separately, each project's visible session set was a flat cap of six with no age condition, so six entries could span two days to three weeks before the overflow control took over.

A prior decision recorded at app.js:177 had rejected recency ordering on paper, on the grounds that a handful of active projects would shuffle position as work moved between them. That rationale was read and reconciled rather than overridden: recency became the default, an alphabetical toggle was added so the churn concern is opt-out-able, and order was kept stable within a session instead of re-sorting on every activity tick.

## Evidence

The verification bar required both new behaviours to fail against the pre-fix build first, and that must-FAIL-pre-fix proof is recorded. A churn-stability regression case covers order not reshuffling mid-session. A 14/14 pass tally is recorded, and the leak gate was clean. verify:ui, verify:attention, verify:sidebar and verify:feat-070-sidebar are named in the plan as the anti-regression set; no result is recorded against those names in the ticket.

## Implementation notes

Sessions were already recency-sorted at app.js:521 and app.js:733, so the change is a window filter applied ahead of the existing six-row cap rather than a new sort. Pinned, active and attention sessions bypass the window through the existing always-visible path. The window default was chosen at roughly one week, on the reasoning that it keeps a normal working week in view; exposing it as an Appearance setting was to be done only if cheap, otherwise left as a constant with the setting noted as a follow-up.

## Verification plan

Under Playwright/happy-dom: assert projects render recency-descending by default, that the sort toggle flips to alphabetical and back, that a project with sessions spanning weeks shows only those inside the window and at most six, that older sessions fold under the overflow control, and that a pinned or active old session stays visible. Both new behaviours must fail against the pre-fix build. Anti-regressions: the UI, attention and sidebar/tree specs, typecheck, and the leak gate.

## Risks

The reorder churn named in the earlier rejected decision is the live risk: with several active projects, positions move as work shifts between them. Mitigated by holding order stable within a session and by the alphabetical toggle.

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from user report. Client-only (app.js/styles) → reaches users on reload, no deploy.
  Read app.js:177's recency-rejection rationale before implementing issue 3.

### 2026-08-13 — worker (fix + §C)
- Reconciled with app.js:177: that rationale rejected auto-EXPAND by recency (it rebuilt the
  wall-of-sessions the cap prevents) — a DIFFERENT concern from ordering, but it names the real risk
  here: reorder-churn/jitter as an active project shuffles to the top under the user. Resolution per
  the user's offer: recency is the default, an alpha toggle is one click away, and the order is
  CAPTURED stable within a session (`state.projOrder`), re-sorted only on an explicit refresh
  (loadProjects) or a sort flip — never on a plain render. So a background lastActivityAt bump does
  not reshuffle the sidebar mid-work; it re-sorts when asked.
- Issue 3 (public/app.js + index.html + styles.css): `state.projSort` ('recency'|'alpha',
  persisted to localStorage `cs.projSort`, default recency) + `resortProjects()`/`orderedProjects()`
  (a project that appeared since the last capture floats to the front by the live sort, so a new one
  is never lost at the end). `renderTree` now iterates `orderedProjects()`. A small low-chrome
  `#projSort` toggle in the sidebar head (`.sortbar`) flips recency↔alpha via `toggleProjSort` and
  names the active mode ("Recent"/"A–Z").
- Issue 4 (visibleSessions): the default per-project view is now a RECENCY WINDOW —
  `RECENT_WINDOW_DAYS = 7` (a documented constant; exposing it as an Appearance/sidebar setting is a
  cheap self-contained follow-up, noted here) — applied UNDER the existing ≤6 cap. A single
  recency-ordered pass keeps within-window sessions up to the cap and folds older ones under the
  existing "N more"; the first "N more" click lifts the window (`s.windowed=false`) and reveals them,
  re-armed on re-expand. Pinned sessions keep their always-on block; `isAlwaysVisible` (the open
  session + `isAttentionSession`, mirroring `unseenCount`'s 24h baseline) forces active/attention
  sessions in regardless of age, without spending the cap budget — so an old pinned/attention session
  never gets folded away.
- §C — scripts/verify-feat-070-sidebar.mjs (real app.js in happy-dom vs a real server; drives the
  real resortProjects/toggleProjSort/renderTree over controlled project + session state and asserts
  on the DOM the real tree produced):
  - PRE-FIX (renderTree reverted to raw `state.projects`; visibleSessions reverted to the flat
    slice — exports kept): 7 assertions FAILED — projects rendered in name order not recency and the
    flip-back did nothing; the attention-old session was cut by the flat 6, plain-old sessions
    cluttered the default view, and "N more" mis-counted. The invariants (alpha-order coincidence,
    labels, within-window recents, pinned-old, N-more-lift, ≤6 cap) stayed green pre AND post.
  - POST-FIX: 14/14 PASS (incl. the churn-stability regression: a background bump does not reshuffle;
    an explicit resort does).
- Anti-regressions all green: verify:ui (7/0), verify:attention (4/0), typecheck (0),
  leak-gate (PASS).
- Commit: FEAT-070: sidebar recency ordering (+alpha toggle) + recent-session window.

### 2026-10-05 — worker
- **amendment + §C:** User decision (2026-10-05): a session the USER started stays in the sidebar's recent window at least 24h, however brief. Agent-started / fold-by-default sessions keep today's behaviour.
  - Fix (public/app.js, withinRecentWindow): the brief-session window is now provenance-scaled. New USER_BRIEF_WINDOW_H=24 next to BRIEF_WINDOW_H; briefWindowH(sess) returns it when startedBy==='user' && !foldsFromList(sess), else the short BRIEF_WINDOW_H. Substantial sessions keep SUBSTANTIAL_WINDOW_H=72. Local to withinRecentWindow (its only caller is visibleSessions' pool filter) — no other seating path changed. Real failing instance 73eeab1a (user-started, foldByDefault=false, 2 msgs, ~lastActivity 10-04 18:45) now stays seated for a full day.
  - §C — scripts/verify-feat-070-user-brief-window.mjs (real app.js in happy-dom vs a real server; every row stamped SEEN so attention cannot confound; window is the only seating lever): PRE-FIX (sibling copy with the branch reverted to flat BRIEF_WINDOW_H) 2/3, the user-started 20h brief row FAILED to seat (folded). POST-FIX 3/3: user-started 20h brief SEATED; agent-started 20h brief NOT seated; user-started 30h brief NOT seated.
  - Anti-regression: verify-feat-070-sidebar 14/14, verify-bug-085-sidebar-cap 11/11, verify-bug-193-list-fold all-PASS. verify-session-provenance-fold has 2 pre-existing failures (its LIVE/OPEN-agent-never-folded assertions are superseded by BUG-193 round 5 and use agent-started rows my change does not touch) — not a regression.
  - Independent clean-room verify warranted: session-list visibility, file with BUG-085/BUG-193 history. work_state left unchanged pending that pass.

### 2026-10-05 — worker
- **fix + §C (round 2):** Round 2 — the user's recent/active sessions were STILL buried after the 24h window amendment. Cause (verified against the REAL :4317 claude-station list of 694 sessions replayed through the REAL app.js in happy-dom): NOT the window and NOT a stale cache (served app.js is cache-control:no-store and byte-identical to the on-disk current app.js). The seat RANKING in visibleSessions ranked by (brief, then attention) with NO window tier, so a stale OUT-OF-WINDOW session in the pool only via unseen attention (an old seen-stamp older than its last activity) outranked an IN-WINDOW session the user just worked in (seen => not attention). With the 4-6 seats full of stale-attention rows, the recent/active rows folded under 'N more'. Reproduced live: recent 258d7399/e7cfb700/cb808f1c HIDDEN, days-old stale rows seated.
- Fix (public/app.js, visibleSessions ranking): added a WINDOW tier leading the sort — windowRank (withinRecentWindow ? 0 : 1) first, then the existing briefRank, then attention. In-window outranks out-of-window stale-attention; stale-attention takes LEFTOVER seats only. Substance-leads and BUG-085's attention-within-cap now operate WITHIN the window tier. Open/live sessions remain independently protected via alwaysIds. Seat budget (MIN/MAX_SEATS) untouched, so BUG-085's hard <=6 cap is unchanged. Display stays recency-ordered.
- §C — scripts/verify-feat-070-seat-ranking.mjs (real app.js in happy-dom vs a real scratch server; realistic busy-day fixture: 8 days-old substantial rows attention-only via stale seen-stamps + a 20h user-brief + the active row, every row stamped attention so the window tier is the only lever). POST-FIX 5/5: active + 20h brief SEATED, stale rows take leftover seats. PRE-FIX (window tier reverted in a public/ sibling — synthesized pre-fix RANKING, not the committed tree): the 20h user-brief is BURIED behind 3 days-old rows (must-FAIL reproduced). Real-:4317 replay confirmed the same before/after (258d7399+e7cfb700 flip HIDDEN->SEATED).
- Anti-regressions all green: verify-feat-070-sidebar 14/14 (incl. old-attention-stays-seated: pool fits seats so it keeps a leftover seat), verify-feat-070-user-brief-window 3/3, verify-bug-085-sidebar-cap 11/11 (cap counts unchanged), verify-bug-193-list-fold 31/0. npm run gate PASS (leak-gate + typecheck, exit 0).
- regressed-from: FEAT-070 2026-10-05 amendment (the 24h window seated the brief into the POOL but the ranking then folded it). Independent clean-room verify warranted: session-list visibility, file with BUG-085/BUG-193 regression history. Left unstaged for user to commit.
