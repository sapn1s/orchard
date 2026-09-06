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

### 2026-09-05 — worker lane (fixing, round 1) — bookmark discoverability + feedback
- **User report under verification:** "bookmark feature is broken, not even sure
  its purpose but nothing happens." Charter: settle dead-vs-invisible without a
  browser (this env has NO browser / NO Playwright), then fix.
- **Verdict: the mechanism is INTACT; the failure is feedback + discoverability
  (the hypothesis held).** Re-traced the whole click path statically and by
  reproducing its logic in node. No dead link, no runtime abort, no `display:none`
  trap: `#bookmark` is built `hidden` (app.js ~11111) and un-hidden by
  `paintBookmarkBtn` on every render via `paintMarks(th)` (app.js:4865) whenever
  `th.key === 'main'`; `toggleBookmark` cycles set→jump→clear correctly from any
  state; `loadMarks`/`saveMarksSoon` round-trip the Map through `cs-bookmark`.
  When set with nothing pinned it DOES store an index, drop the moss ribbon, tint
  the button and fire a toast — so something happens, but each signal is subtle
  (3px moss bar 14px off the message's left edge; one-shot toast; faint tint) and
  the icon carries no legend, so the user reads it as "nothing / unclear purpose."
- **Genuine defect found in the feedback path (not just subtlety):** the set-
  confirmation toast said `Bookmarked — the ▸ control returns you here`, but the
  control renders a bookmark/pin GLYPH, never a ▸. The confirmation pointed the
  user at an affordance that does not visually exist — actively reinforcing
  "not sure its purpose."
- **Low-risk, non-redesign fixes (no new tokens, no new panel, no bookmarks
  list, neighbours untouched):**
  1. `paintBookmarkBtn` (app.js ~3728): each state now sets BOTH `title` and a
     new per-state `aria-label`. Unset title names the purpose AND the cycle
     ("drop a marker here you can jump back to (sets → jumps → clears)"); jump/
     clear states name the next action and how to clear.
  2. Toast (app.js ~3754): now "Bookmark set here — the filled bookmark button
     (top right) jumps you back to it" — names the real control, kills the ▸.
  3. Build-time `aria-label`/`title` seeded on the hidden button (app.js ~11111).
  4. `styles.css` ~1088: `.bkmk.set svg path { fill: currentColor; }` — the glyph
     fills SOLID moss when a bookmark exists (currentColor is `--live` via
     `.bkmk.set`, no new token). This is the persistent, at-a-glance "this session
     HAS a bookmark" indicator the ticket's success criteria and its own round-1
     "filled when set" note called for; the hollow-vs-tint distinction was too
     faint to read.
- **Proof (no browser — logic reproduction + real-source consistency).** No
  jsdom in package.json (checked; none added). `scripts/scratch-feat118-bookmark-
  logic.mjs` reproduces the EXACT `into`/`saveMarksSoon` serialization, the
  three-state cycle branch selection, and the edited label mapping, over a
  realistic 3-session store (incl. index 0 and a long session), AND asserts the
  new strings/CSS exist in the real app.js/styles.css: **20/20 PASS**. Round-trip
  preserves all sessions incl. index 0; garbage store → empty, no throw; only
  integer indices survive; full set→jump→clear→set cycle transitions correctly.
- **Must-FAIL / anti-vacuity:** `git show HEAD` confirms pre-fix state — toast
  had the phantom "▸ control" (1 hit, now 0) and zero `.bkmk.set svg path` CSS
  (0 → present). Honesty note: the scratch's whole-file `aria-label` count check
  is WEAK (HEAD already had 4 aria-label calls elsewhere, so it is not a real
  must-FAIL for the per-branch aria-labels); the load-bearing must-FAIL evidence
  is the toast rewrite and the filled-glyph CSS.
- **Regression:** `npm run gate` exit 0 — leak-gate PASS, check-nul PASS,
  typecheck PASS. The existing CDP suite `scripts/verify-feat-118-marks.mjs`
  asserts only `.set` / `.bookmarked` ribbon / `#bookmark` presence, none of
  which these text/CSS changes alter — but it is UNRUNNABLE here (no browser).
- **COULD NOT PROVE without a browser (work queue, not a disclaimer):**
  1. That `#bookmark` actually paints, is un-hidden, and is clickable in a live
     render (only traced statically + by logic). Proof: run
     `scripts/verify-feat-118-marks.mjs` under headless brave/CDP.
  2. That the filled-moss glyph is visually legible / reads as "bookmarked" in
     light AND dark, and is not too subtle at 12px. Proof: screenshot + visual
     review (the repo's brave-CDP visual gate).
  3. That the new title/aria strings actually render on hover and to a screen
     reader. Proof: CDP eval of `#bookmark.title` / `getAttribute('aria-label')`
     across the three states; an AX-tree check for the label.
  4. That the ribbon-at-top-of-view is on-screen at SET time as reasoned. Proof:
     CDP bounding-box check after a set click.
- **Scope held:** did NOT build a cross-session bookmark list or multi-bookmark
  support. **Recommendation (parked, needs visual review this env can't do):** if
  discoverability is still weak after visual review, the strongest next step is a
  small persistent affordance the round-1 design deliberately avoided — e.g. the
  `#bookmark` button carrying a tiny "1" or a one-word label when set, or the
  Resume-pill treatment extended to a "Bookmark" jump pill. That is a redesign,
  not a low-risk tweak, so it is a recommendation only.
- **Changed (UNSTAGED):** `public/app.js`, `public/styles.css`,
  `scripts/scratch-feat118-bookmark-logic.mjs` (new; scratch logic proof, safe to
  delete). No git writes performed.

### 2026-09-05 — verify lane (verifying, round 1) — REAL headless browser, first render ever seen
- **Verdict: functional cycle HOLDS; SET-state button is BROKEN / UGLY.** Drove the
  real app (Playwright headless, http://127.0.0.1:4317, session
  `a95ee697…/i=93`, 73 msgs) — the round-1 CDP suite is hard-wired to
  brave/CDP (spawns `brave`, raw WS + Fetch interception) so it was NOT run; verified
  directly instead, as the charter permitted.
- **What HOLDS (all asserted from the LIVE DOM, not source):**
  - `#bookmark` is genuinely VISIBLE (`hidden:false`, `display:flex`, un-hidden by
    paint) — the "nothing happens" report is NOT a dead/hidden control.
  - Full set→jump→clear cycle works. SET: stores index (localStorage `cs-bookmark`
    `{"…a95ee697…":93}`), drops the `.bookmarked` ribbon on msg 93, glyph fills moss
    (`svg path` fill `rgb(123,143,94)` light / `rgb(143,164,112)` dark), toast fires
    with the CORRECTED copy "Bookmark set here — the filled bookmark button (top
    right) jumps you back to it" (phantom "▸ control" is GONE — confirmed present in
    DOM). JUMP (scrolled 26k px away): scrolls msg 93 back into view (rect top→219),
    bookmark preserved. CLEAR: unfills glyph (`fill:none`), removes ribbon, empties
    store to `{}`.
  - `title`/`aria-label` correct in unset & clear states from live DOM.
  - Persists across a FULL reload (`location.reload()`): still `bkmk set`, filled,
    ribbon present, store intact.
  - Per-session isolation: opening a second session shows unset button, no ribbon,
    store unchanged — no leak.
  - Attacks survived: rapid double-click (set→clear, idempotent, no crash, no leak);
    no-message/new-session view (click is a no-op via the `topVisibleIndex` guard, no
    throw). ZERO console errors across the whole run (only a benign multi-tab
    read-only warning).
- **BROKEN / UGLY (headline, blocks close): `.set` CSS class collision.** When
  bookmarked, `paintBookmarkBtn` adds class `set` (`bkmk set`). That generic `set`
  matches an UNRELATED settings-row rule `styles.css:1480 .set { display:flex;
  width:100%; padding:9px 8px; margin:0 -8px; border-bottom:1px solid }`, which — same
  single-class specificity as `.bkmk` (styles.css:1078 `width:26px`) but LATER in
  source order — WINS. Measured computed `width:720px` on the live button. So a SET
  bookmark stops being the intended 26px round pill and becomes a FULL-WIDTH BAR
  spanning the transcript, glyph floating centered, with a border-bottom hairline —
  occluding message text and creating a 720px invisible click target (elementFromPoint
  is the button across the entire strip). In LIGHT theme it is a glaring white bar over
  the transcript (see screenshot); in DARK it blends into `--window` and reads as a
  stray divider. Either way it does NOT read as "this session is bookmarked" — it
  actively DEFEATS the round-2 goal (a legible at-a-glance filled indicator). The
  filled-moss glyph itself is fine; the button GEOMETRY in the set state is the defect.
  This is why the round-1 unset screenshot looked like a neat pill and no one caught
  it: the bug only appears in the SET state, which the browserless round-2 lane could
  not render. `regressed-from: FEAT-118 round 1` (the `.set` modifier toggle is
  round-1 code; round 2 added `.bkmk.set svg path{fill}`, i.e. a filled glyph that is
  only ever seen INSIDE the broken bar). Fix direction (low-risk CSS): rename the
  modifier (`.bkmk.marked`) or pin width with higher specificity
  (`.bkmk.set{width:26px;...}`) / scope the settings rule to `.setrow`.
- **SECONDARY (real, minor a11y): jump/clear label goes STALE on scroll.** `onScroll`
  (app.js:3536) repaints the jump pill and read-mark but NOT the bookmark button;
  `paintBookmarkBtn` only re-runs on render / visibilitychange. So after scrolling away
  from the mark, `title`/`aria-label` still say "Bookmark is here — click to clear it"
  while the button will actually JUMP (the CLICK handler recomputes `isOnScreen` at
  click time, so behaviour is correct — I confirmed the jump). A screen-reader / hover
  user is thus MISINFORMED about the next action — undercutting the round-2 a11y intent.
  Cheap fix: call `paintBookmarkBtn(th)` from `onScroll` (debounced).
- **Screenshots (repo-root, git-ignored):** `feat118-btn-unset-light.png` (correct
  26px pill), `feat118-context-light-set.png` (the white full-width bar over the
  transcript — clearest evidence), `feat118-btn-set-dark.png`,
  `feat118-context-dark.png`.
- **Handoff:** send back to fixing for the `.set` collision (and, cheaply, the stale
  label). No files changed by this lane; browser closed. High-stakes note: the CSS
  collision is a class-name-scope hazard that could recur — worth a grep for other
  `.set`/generic-modifier reuse when fixing.

### 2026-09-05 — worker lane (fixing, round 2) — `.set` collision resolved by renaming the modifier
- **Verdict: FIXED.** The set-state bookmark button is a clean 26px round pill again
  in both themes; the full-width bar is gone. Logic proof 22/22, `npm run gate` PASS
  (exit 0).
- **What the collision actually was, and which side broke.** The bookmark button
  (`.bkmk`, `width:26px`) had the modifier class `set` toggled on it when a bookmark
  existed. That bare `set` also matched the UNRELATED settings-row rule (`styles.css`
  `.set { display:flex; width:100%; padding:9px 8px; margin:0 -8px; border-bottom }`).
  Same single-class specificity, but the settings rule is LATER in source order, so it
  WON: the 26px pill was blown out to a full-width bar over the transcript. **Breakage
  ran one way only** — settings-rule → bookmark button. The reverse never happened: the
  bookmark's own rules were always `.bkmk`-scoped (`.bkmk.set`, `.bkmk.set svg path`),
  so they could never leak onto the 36 settings rows. Confirmed live: with the button
  bookmarked, the settings panel's 36 `.set` rows still render at `display:flex`,
  `padding:9px 8px`, `border-bottom:1px` — untouched.
- **Fix (no `!important`, no specificity bump).** Renamed the modifier `set` → the
  self-describing `marked`, scoped as `.bkmk.marked` / `.bkmk.marked svg path`
  (`styles.css`), and `btn.classList.toggle('marked', set)` (`app.js`
  `paintBookmarkBtn`). Grepped all of `public/` first: `marked` is used nowhere as a
  class (only in prose/comments), so this does not move the collision. A comment at
  each site names the old `.bkmk.set` and why it was abandoned, so a future editor does
  not reintroduce it.
- **Must-FAIL proof (live DOM, order-independent).** On the real app I toggled the two
  classes on the live button and measured computed width: `.set` → `width:100%`
  (the bar — reproduces the defect), `.marked` → `width:26px` (fixed). Then drove the
  REAL click-path (set via clicking the button) on a real 27-proc session: class
  becomes `bkmk marked`, `width:26px`, `padding:0`, glyph fills `--live`
  (moss `rgb(123,143,94)` light / `rgb(143,164,112)` dark), ribbon dropped, persists
  across a full `location.reload()`, clears cleanly. Round-1 behaviour intact:
  per-state title/aria-label, corrected toast, filled glyph while a bookmark exists.
- **Designer judgement.** In both light and dark the set state reads as an intentional,
  in-language filled bookmark inside the app's standard round outlined pill — it says
  "this session has a bookmark" at a glance and matches the pin's "filled when set"
  vocabulary. No longer ugly.
- **Not addressed (out of this lane's charter):** the SECONDARY stale jump/clear label
  on scroll (verify round 1) — `onScroll` still does not repaint the bookmark button;
  the CLICK behaviour is correct, only the hover/aria label lags. Left for a follow-up.
- **Files (unstaged, no git writes):** `public/app.js`, `public/styles.css`,
  `scripts/scratch-feat118-bookmark-logic.mjs` (proof updated for the rename, 22/22).
  Screenshots (repo-root, git-ignored): `feat118-r2-unset-light.png`,
  `feat118-r2-set-light.png`, `feat118-r2-context-light-set.png`,
  `feat118-r2-set-dark.png`, `feat118-r2-context-dark-set.png`. Browser closed; the
  test bookmark and dark-theme toggle were reverted, leaving the app as found.
