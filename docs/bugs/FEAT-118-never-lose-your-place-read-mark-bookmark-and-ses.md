```orchard-ticket
{
  "id": "FEAT-118",
  "type": "feature",
  "title": "Never lose your place — read-mark, bookmark, and session-list state markers",
  "summary": "Two orientation gaps the user reported. The transcript autoscrolls while they are away, losing where they last read; they asked for a within-session bookmark 'like a book', citing Discord's unread line as close but imperfect. And the picker does not distinguish running, recently-finished, unread, recently-visited, or a session that died in the background without answering.",
  "impact_if_we_wait": "Stepping away from a live turn means returning to a scrolled transcript and hunting for your place. And a background session that died with work in flight stays invisible in the very list that should surface it — the silent-death class fixed repeatedly this week.",
  "current_need": "An automatic 'you left off here' line plus a manual bookmark, each with a one-action jump, surviving reload and switch; and a legible five-state picker read from ground truth, not a sixth notion of liveness.",
  "severity": "medium",
  "area": "Web UI — transcript and picker",
  "reported": "2026-09-02",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "review",
  "updated": "2026-09-02",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A 'you left off here' divider marks the read boundary, freezes while you are away, and clears only when you scroll down through it.",
    "A manual bookmark is dropped deliberately and returned to in one action, rendered distinctly from the auto read-line, and both marks persist per session.",
    "Both marks survive a reload and a switch away and back.",
    "The picker distinguishes running, recently-finished, unread, recently-visited, and died-without-answering, legible at a glance without a legend.",
    "Running is read from the liveness authority and died-without-answering from the agent-outcomes ledger; an unknown fate never renders as finished.",
    "No regression to the sidebar fold/cap, recency ordering, reorder durability, or the provenance fold."
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "note": "sessionLifecycle/endedUnanswered/recentlyVisited + sessionRow markers; read-mark and bookmark machinery; onScroll/scrollDown/visibilitychange/openSession wiring; cs-readmark/cs-bookmark"
    },
    {
      "path": "public/styles.css",
      "note": ".row .stopped/.settled/.unread + .died/.visited when-treatments; .readline; [data-i].bookmarked ribbon; .leftoff pill; .bkmk toggle"
    },
    {
      "path": "scripts/verify-feat-118-marks.mjs",
      "note": "real headless-brave CDP suite over an all-five-states fixture; must-FAIL via CDP Fetch serving HEAD app.js"
    }
  ],
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

# FEAT-118 — Never lose your place — read-mark, bookmark, and session-list state markers

See the Activity log for build and verification detail.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-02 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-02 — worker lane (finding+fixing, round 1)
- **Decided to build BOTH marks, and why.** The user literally asked for a manual
  bookmark; the *stated pain* is the autoscroll losing their place while AFK.
  Those are complementary needs, not alternatives — one is "a spot I chose", the
  other "where I stopped reading" — so both were built, each with a ONE-ACTION
  jump back. The auto read-line improves on Discord's chief flaw (clearing too
  eagerly): the boundary FREEZES while the tab is hidden or scrolled up and
  clears ONLY when the user scrolls down THROUGH it — never on mere focus or a
  session switch. Both persist per session (`cs-readmark` / `cs-bookmark`) and
  were verified to survive a reload AND a switch away and back.
- **Session-list states + the hierarchy chosen.** Five states, resolved into
  THREE salience tiers so a dense list reads as a hierarchy, not five colours:
  (1) ALARM — died-without-answering, an amber filled TRIANGLE (a distinct shape,
  not only a hue) — the one place boldness is spent, because a silently-died
  background session is what loses work; (2) ACTIVE — running (the existing moss
  breathing dot) and recently-finished (the same moss, a STILL hollow ring),
  one family split by motion; (3) QUIET — unread (a moss tick moved to the
  TRAILING edge + a title-ink lift, off the leading rail so it stops doubling up
  with the lifecycle dot) and recently-visited (a persistent muted timestamp, no
  glyph, no colour — the lowest tier the user ranked least). Only the alarm adds
  a new accent; the rest reuse the existing moss + status-tint language.
- **Ground truth, per the charter.** Running is read from the liveness authority
  (`/api/sessions/live` via `liveInfo`, the same signal the moss dot already
  used). Died-without-answering is read from the agent-outcomes ledger
  (`outcomes.ts` — the server-recorded "what died and why", surfaced client-side
  as `state.outcomes`, matched on the row's session id via the same
  `isRecentOutcome` view the death rail renders). No sixth notion of liveness was
  added. A session of genuinely unknown fate carries a death record and reads
  'stopped', so it is NEVER dressed up as a clean 'finished' (WA §C).
- **Changed:** `public/app.js` (sessionLifecycle/endedUnanswered/recentlyVisited
  + sessionRow markers; read-mark seed/advance/paint/jump + bookmark toggle/paint
  machinery; a timestamp-window suppression so a programmatic scroll's async
  scroll event cannot wipe the mark it just restored; onScroll/scrollDown/
  visibilitychange/openSession/refreshOutcomes wiring; `cs-readmark`/`cs-bookmark`
  persistence + pagehide flush; `#leftoff`/`#bookmark` built in JS to avoid the
  contended index.html); `public/styles.css` (`.row .stopped`/`.settled`/
  `.unread`, `.row.died`/`.visited` timestamp treatments; `.readline` divider;
  `[data-i].bookmarked` ribbon; `.leftoff` Resume pill; `.bkmk` toggle);
  `scripts/verify-feat-118-marks.mjs` (new).
- **Verified — REAL headless brave, all five states in one fixture + a long
  session, both themes: 17/17.** The five row signatures are mutually distinct;
  the read-line is drawn at the restored boundary, the Resume pill offers the
  one-action return, repaint-on-return does NOT clear it (the Discord fix),
  reading DOWN clears it and advances the mark, and it survives reload + switch;
  the bookmark sets/jumps/clears and survives reload. Screenshots read as a
  hierarchy in light and dark (amber alarm dominates; moss family calm; visited
  quietest). **Must-FAIL:** the same suite served the pre-feature `app.js`
  (`git show HEAD:public/app.js`) into the real browser via CDP Fetch
  interception — every marker is confirmed ABSENT there (2/2), pairing with
  present-on-working for non-vacuity. HEAD is a stable anchor because this lane
  never commits. **Regressions:** verify-bug-085-sidebar-cap 11/11,
  verify-feat-070-sidebar 14/14, verify-session-recency 11/11,
  verify-session-reorder-durable 6/6, verify-session-reorder-usermsg 6/6,
  verify-session-provenance-fold 7/7 — no regression to fold/cap/recency/reorder/
  provenance. `npm run gate`: typecheck PASS; leak-gate red ONLY on three stray
  root `.py` files (the user's, out of slice) — my files are leak-clean.
- **Known limitation (follow-up).** The died-without-answering marker reads
  `state.outcomes`, which `refreshOutcomes` scopes to the CURRENT project — so a
  death is marked when that project is selected (the common case), but not across
  other projects' collapsed groups. Noted rather than silently assumed.
- **Skeptic flag.** This touches session-lifecycle presentation and reads two
  concurrently-written stores (liveness, outcomes) — an independent clean-room
  verify pass is warranted before close.
- **Handoff:** UI-only; left UNSTAGED for the user to commit. work_state
  `in_verification`, human_action `review`.
