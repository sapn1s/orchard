# FEAT-153 — the Needs-You panel is a ticket-board grid, current session first

- **Status:** IN-PROGRESS
- **Severity:** medium
- **Area:** rail (public/app.js, public/styles.css, public/index.html)
- **Reported:** 2026-09-26 by the maintainer
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom
The right-hand "Needs you" rail listed every 👤 ticket as a long, text-heavy
column of answer cards, stacked above the read-only queued / in-flight / done
lists. The user: "current version is cluttered not visually appealing a lot."
There was no way to see, at a glance, which tickets belong to the session you are
looking at versus everything else open on the board.

## Expected
The user's ask, verbatim: "remake that needs you panel … instead prio item is
that it is expandable panel of ticket board, with quick metrics, but prio element
is current sessions tickets and their states in immediate view, scaleable … grid
fit to that panel nicely formatted, and maybe with different opacity … also
visible state of entire unresolved ticket state also of other sessions, based on
prios." Needs-you should become "far fewer in immediate view — a state/emphasis
on cards plus a count, not a long list," while keeping the ability to answer a
needs-you item.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play:
  - `public/app.js` — `renderRail()` now calls `renderBoardGrid()` +
    `renderAnswerMount()` (was `reconcileNeeds()`). New: `boardGridModel()`,
    `ticketCard()`, `gridSection()`, `renderBoardGrid()`, `renderAnswerMount()`,
    `openAnswer()`, `closeAnswer()`, `currentSessionTicketIds()`, `isAnswerable()`.
    `renderRailSummary()` chips for needs/queued/running now scroll to the grid.
    `renderRail()` no longer renders the separate `#railQueued` / `#railInflight`
    lists (redundant with the grid); `#railDone` kept (grid is unresolved-only).
  - `public/index.html` — new `#railBoardGrid` node after `#railSummary`;
    `#railNeeds` repurposed as the on-demand answer mount.
  - `public/styles.css` — `.rail-board / .bg-section / .bg-grid / .tc / .tc-*` and
    `.answer-open` under the FEAT-153 header; reuses `--st-*` tints, `.nc-kind`,
    `.nc-sevmark`.
- Session↔ticket fact (ARCH-010): NOT re-derived. Read from the declarations their
  owners already make — `state.requests[].tickets` (FEAT-126 orchard-request
  bindings, `GET /api/sessions/:id/requests`) and each live lane's Dispatch
  attribution `state.snap.running[].ticket[]`. No server change was needed.
- Related tickets: FEAT-018 (rail), FEAT-067 (summary/metrics), FEAT-126
  (requests), FEAT-139 (the earlier "immediate view" compaction), BUG-016 (live
  mirror / focus preservation), BUG-025 (bare 👤 ticket is read-only).
- Repro tests: `npm run verify:needs-you-rail`, `verify:rail-refresh`,
  and the new `node scripts/verify-feat-153-board-grid.mjs`.
- Known dependencies / blockers: the working tree carries large in-flight app.js
  changes from other work; this diff is confined to the rail panel.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-26 — worker (Opus 4.8, phase=fixing round=1 class=fix)
- **Understood:** the whole right rail is the "Needs you" panel. The clutter was
  (1) the long vertical needs-card LIST as the immediate view and (2) the stacked
  read-only lists below it, with no current-session view. The session↔ticket link
  already exists on the wire (FEAT-126 requests + running-snapshot lane
  attribution), so no server work was required — a client-only render change.
- **Changed:** `public/app.js`, `public/styles.css`, `public/index.html`
  (rail panel only). The rail now leads with the FEAT-067 metrics strip, then a
  board GRID: a "This session" section (current-session tickets, full weight,
  needs-you cards carry an amber accent ring and open the answer flow on click)
  and an "Elsewhere on the board" section (all other unresolved tickets,
  dimmed to .58 / full on hover, priority-ordered, collapsible + persisted in
  `localStorage['cs.rail.boardOthers']`). Each card: kind tag + severity mark +
  id + 2-line title + state chip (needs/prog/queued). The answer flow (`needsCard`)
  is unchanged — it mounts into `#railNeeds` one ticket at a time on click and
  clears on answer; a background poll leaves an open answer untouched (BUG-016
  focus/text preservation, now scoped to the single open card). A bare 👤 status
  ticket (no `## Question`) is not answerable and opens the read-only ticket modal
  (BUG-025). The redundant `#railQueued` / `#railInflight` lists are retired (the
  grid covers them); their metric chips scroll to the grid. New verify script
  `scripts/verify-feat-153-board-grid.mjs`.
- **Verified:** (fixer's own runs; real brave headless over a real server)
  - `node scripts/verify-feat-153-board-grid.mjs` → 15/15 PASS. Board is REAL on
    disk (a realistic busy day: 4 needs incl. a bare status, 3 in-flight, 8 queued,
    2 done); the session↔ticket inputs (requests + snap) are INJECTED and stated as
    synthetic in the script header, because minting real request records needs a
    live orchestrator turn this headless harness has no session to produce.
    Must-FAIL proof: running the OLD `verify-needs-you-rail` against the new code
    reddened `(a)` with `{count:0}` (needs cards no longer in `#railNeeds`),
    confirming the contract genuinely changed.
  - `npm run verify:needs-you-rail` → 19/19 PASS (rewritten to the grid contract:
    click card → answer flow → append-only disk write + prior-log survival; bare
    status → modal; empty board; narrow-viewport badge collapse).
  - `npm run verify:rail-refresh` → 10/10 PASS (BUG-016 live mirror on the grid +
    focus/text preservation of the open answer mount across a background poll).
  - `npm run verify:feat-067` → 23/23, `verify:arch-017` → 32/0,
    `verify:bug-070` → 22/22 (anti-regression on the kept rail sections; feat-067's
    reachability map updated for the retargeted chips).
  - No horizontal overflow at the real rail width; screenshots (light+dark ×
    expanded+collapsed) at `/tmp/feat-needs-panel/grid-{light,dark}-{expanded,collapsed}.png`.
  - `npm run gate` → PASS (exit 0): leak-gate + check-nul + typecheck.
- **Could not run in this lane:** `verify:feat-047` (findings rail) — its
  `seedMethodology` does `git init`, which the agent-session Bash guard refuses;
  this is an environment limit, not a code effect (my change leaves
  `#railObservations` untouched and `#railNeeds` empty, so its "no finding in
  `#railNeeds`" assertion still holds). `verify:bug-090-needs-fork` shows 6 red in
  its container-FORK "B" section (`#forkBtn` / `pendingFork`) — a feature this diff
  never touches; the failures are from other in-flight app.js work already in the
  dirty tree (577 insertions predate this lane). An independent verifier should
  confirm both on the pre-FEAT-153 tree.
- **Verified-by:** PENDING — regression-prone (touches app.js/styles.css with a
  history of rail tests) → an independent clean-room verify pass is warranted:
  drive the grid over a realistic busy board, and confirm feat-047/bug-090 are red
  independent of this change.
- **Still open / handoff:** independent verification (above). Optional follow-up:
  the FEAT-067 metrics strip is chip-heavy; a future pass could fold it into the
  grid header. No functionality removed.

### 2026-09-26 — independent design-critical verify (round 1) — VERDICT: FAIL (design/interaction; functional core sound)
- **Verified-by:** independent reviewer lane (NOT the fixer). Judged from the running
  UI + the diff only; did not read prior Activity entries or the fixer's rationale.
- **Method:** re-ran `node scripts/verify-feat-153-board-grid.mjs` → 15/15 PASS.
  Then a fresh seeded instance on an ephemeral port (own dataDir/store), driven in
  a real headless Chromium at 1440 / 1024 / 390 in light+dark over four boards:
  the busy board, a 32-ticket board, a long/unbroken-title board, and an empty
  board. Screenshots in /tmp/feat-153-review/.
- **What holds up (independently reconfirmed):** unresolved-only grid; needs ring +
  answerable routing; bare-status → ticket modal; append-only answer write; empty
  "board is clear"; no horizontal overflow even with a 90-char unbroken token
  (word-break holds); collapse persists across re-render. Accessibility is a
  strength — cards are real buttons with per-card titles, `aria-label` on the kind
  tag ("FEAT — feature") and severity mark ("severity med"), toggle has
  `aria-expanded`; focus-visible ring present; dark-theme muted (.58) cards remain
  legible.
- **FAIL — the explicit requirement "scaleable … infinite grid fit to that panel
  nicely" is not met, and poll behaviour degrades the "immediate view":**
  1. (HIGH) Grid does not fill the panel. `#rail` is 860px tall but `#railPanel`
     stops at ~528px; the grid is capped at 32vh/36vh with an INNER scrollbar. On
     the 32-ticket board only ~6 cards show inside a 288px scroll box while ~332px
     (~39%) of the rail sits empty below (measured). This reintroduces the exact
     nested-scroll-in-a-taller-panel trap the code's own FEAT-139 r4 comment says
     it removed for `.needs`.
  2. (HIGH) Scroll position resets on every poll. Set the others-grid scrollTop to
     600; the ~3s poll re-render put it back to 0. On a long board the user is
     yanked to the top every few seconds and cannot read past the first rows.
  3. (MED) Full-grid flicker. Each poll does clear()+rebuild, so every card
     replays the `rise` fade-from-opacity-0 entrance animation (observed nodes
     replaced + opacity→0 every ~3s). The "calm immediate view" flashes
     periodically; the needs-card reconciliation that avoids this was not applied
     to the grid.
  4. (MED) Text clutter the user explicitly flagged persists: each card shows a
     kind TAG ("BUG") AND the id ("BUG-201") — the tag duplicates the id prefix.
  5. (LOW) Panel header still reads "Needs you" though the panel is now a full
     board grid; it duplicates the NEEDS metric chip + count badge + section
     labels. The FOCUS line repeats the first grid card (BUG-201). Needs cards in
     "This session" carry both an amber ring AND a "NEEDS YOU" chip.
- **Could not test:** real orchard-request session bindings (synthesised via
  window.__station like the verify harness — a background poll overwrites injected
  requests after a few seconds, so live "This session" partition rests on the
  verify script's immediate-assert check c, not my delayed screenshots); 1024 and
  390 widths collapse/hide the whole rail behind a floating badge (pre-existing
  responsive behaviour, not this ticket); truncated/partial board reads.
- **Incident (self-reported):** my first launcher inherited PORT=4317 from the env
  and registered 4 test projects into the pre-existing server on 4317 before I
  caught it; I deleted all four via DELETE /api/projects (no live sessions or
  containers affected — closedSessions empty, containers missing) and relaunched
  on an explicit ephemeral port. 4317 left as found.

### 2026-09-26 — worker (Opus 4.8, phase=fixing round=2 class=fix)
- **Hypothesis confirmed:** defects 1–3 all stemmed from the render path — a
  `clear()`+rebuild of the grid on every ~3s poll INSIDE a fixed-height
  (`max-height:32/36vh` + `overflow-y:auto`) inner scroller. Removing the inner
  scroll (one surface = `#railPanel`) and switching to a keyed, in-place update
  fixed all three at once.
- **Changed (rail panel only; working tree left unstaged):**
  - `public/styles.css` — `.bg-grid` lost `max-height`/`overflow-y`/`scrollbar-width`
    and the `.bg-section.others .bg-grid { max-height: 32vh }` rule; the grid now
    flows inline and the rail column is the ONE scroll surface (the FEAT-139 r4
    intent, now honoured in the comment). (HIGH #1)
  - `public/app.js` — `renderBoardGrid` is now a KEYED, in-place reconcile
    (`cardSig` + `reconcileGridCards` + `ensureSection`), never `clear()`+rebuild:
    card nodes are reused so the `rise` entrance only plays for genuinely new cards
    (MED #3) and the panel's scroll position survives a poll (HIGH #2). `ticketCard`
    dropped the redundant kind tag (the id already shows "BUG-201") (MED #4) and,
    for needs-you cards, dropped the "NEEDS YOU" chip so the amber RING is the sole
    emphasis (ring, not ring+chip — LOW #5); the accessible name still says "needs
    you". `renderRail` no longer populates the header count badge (dedup vs the
    FEAT-067 needs chip + grid — LOW #5).
  - `public/index.html` — rail header + `aria-label` "Needs you" → "Board" (LOW #5).
- **Scope decision (LOW #5, FOCUS line):** NOT changed. The FOCUS row lives in the
  FEAT-067 summary card and `verify:feat-067-rail-summary` asserts its presence +
  click-to-open (23/23). Suppressing it when it equals the first grid card would
  regress that feature for every board (focus is by construction the top-priority
  needs item = the first grid card). Its dedup belongs to a FEAT-067 change, not
  here; flagged for the maintainer.
- **Verified (fixer's own runs; real brave headless over a real seeded server on
  an ephemeral port — PORT never inherited as 4317):**
  - `node scripts/verify-feat-153-board-grid.mjs` → 21/21 PASS. Six new/changed
    defect assertions (h no-inner-scroll+fills-panel, i scroll-survives-poll on the
    panel surface, j keyed-reuse-no-rebuild, k no kind tag, l header="Board", m
    ring-not-chip). MUST-FAIL proof: reconstructed the round-1 three files and ran
    the SAME new script against them → 15/21, with exactly h,i,j,k,l,m RED; restored
    the fix (md5 verified identical) → 21/21. Board REAL on disk (busy day: 4 needs
    incl. a bare status, 3 inflight, 8 queued, 2 done); session↔ticket inputs
    (requests + snap) INJECTED and stated synthetic in the script header (minting
    real request records needs a live orchestrator turn this harness has none of).
  - Anti-regression (real results): `verify-needs-you-rail` 19/19,
    `verify-rail-refresh` 10/10, `verify-feat-067-rail-summary` 23/23 (FOCUS +
    live-count honesty intact), `verify-bug-070-outcomes-rail` 22/22,
    `verify-arch-017-rail` 32/0.
  - `npm run gate` → PASS (exit 0): leak-gate + check-nul + typecheck.
  - Screenshots (light+dark × 1440 and 1024, plus expanded/collapsed) →
    `/tmp/feat-153-r2/`. Visual review confirmed: header "Board", no kind tags,
    needs cards ring-only, grid fills the full rail as one panel-level scroll (all
    11 "Elsewhere" cards flow inline, no inner scrollbar).
- **Verified-by:** PENDING — regression-prone (app.js/styles.css rail render, a
  file family with prior rail regressions). An independent clean-room verify pass
  is warranted: drive the fixed grid over a realistic busy board, confirm scroll
  survives a real ~3s poll (not just a synchronous `renderRail()`), and re-confirm
  the round-1 must-FAIL on a clean checkout.
- **Still open / handoff:** independent verification (above); the FEAT-067 FOCUS
  dedup deferred to that ticket (scope decision above).

### 2026-09-26 — independent design-critical verify (round 2) — VERDICT: FAIL (a mid-view ticket state change CRASHES the grid render and kills the rail poll loop)
- **Verified-by:** independent reviewer lane (NOT the fixer). Judged from the
  requirement + the panel diff + the running UI only; did not read the round-2
  worker Activity rationale or any fixer report (read the round-1 review entry to
  know which defects were reported). Own server on an EPHEMERAL OS-assigned port
  (never 4317), own dataDir/store, real brave `--headless=new` over raw CDP,
  driven with REAL 5s rail polls (never a synchronous `renderRail()`). Torn down
  by PID.
- **Re-ran the fixer's script:** `node scripts/verify-feat-153-board-grid.mjs` →
  21/21 PASS (real output captured). But that suite never mutates the board after
  first paint, so its keyed-reuse checks (j) re-render the SAME board and (c) only
  moves cards between sections — neither changes a card's SIGNATURE, so the
  removal-of-a-card path is never exercised. That is the gap below.
- **FAIL — HIGH (data-loss / liveness): a mid-view ticket state change throws in
  `reconcileGridCards` and the whole rail poll loop dies.** REPRODUCED live (real
  poll, not synthetic): seed a busy board, let the grid paint, then change ONE
  ticket's state on disk (`BUG-205` building→queued) and wait for the real 5s poll.
  Result: `NotFoundError: Failed to execute 'insertBefore' on 'Node': The node
  before which the new node is to be inserted is not a child of this node.` at
  `public/app.js:6923` (`reconcileGridCards`) ← `renderBoardGrid` (6978) ←
  `renderRail` (6695) ← `refreshRail` (5731) ← `pollRail` (7830).
  - Root cause: in `reconcileGridCards`, when a card's `data-sig` changed the code
    does `card.remove(); card = null` (6919). If the walk had already advanced the
    `cursor` onto that same node (the common case — items are iterated in DOM
    order), the removed node IS `cursor`; the following `grid.insertBefore(newCard,
    cursor)` (6923) then references a node that is no longer a child → throws.
  - Effect #1 (the changed card VANISHES): the loop aborts before re-inserting the
    rebuilt card, so `BUG-205` disappears from the grid entirely (observed count
    7→6). This is the exact opposite of the requirement's "a ticket changing state
    → only that card updates, no flicker".
  - Effect #2 (the rail FREEZES): the throw propagates out of `renderRail` →
    `refreshRail` → `pollRail`, and `pollRail` (7828–7842) has no try/finally, so
    `scheduleRailPoll()` is never reached — the 5s poll loop stops permanently
    (until a `focus`/`visibilitychange` re-arms it, which then crashes again on the
    next state change). Confirmed NON-self-healing: after 2+ poll cycles (13s) the
    board stayed frozen at 6 cards with the poll dead. On a live busy board where
    tickets change state constantly this fires routinely.
  - Fix direction (reviewer does not touch product code): advance `cursor` off a
    node before removing it (e.g. `if (card === cursor) cursor = cursor.nextSibling;`
    before `card.remove()`), and/or guard `insertBefore` against a detached ref; and
    wrap `pollRail` so a render throw cannot kill the poll loop (defense in depth).
    Add a verify assertion that MUTATES the board (state change + add + remove) and
    drives a real poll — the current suite cannot catch this class.
- **What HELD UP (independently reconfirmed over real polls):** scroll position
  survives 2 real 5s polls with card nodes reused (A2); collapse of the others
  section PERSISTS across a full page reload, not just a re-render (A5); empty
  current-session degrades cleanly to a single "Open tickets" section, no "This
  session" (A1); clicking a needs-you card opens the answer flow (textarea mounts
  in `#railNeeds`) (A4); muted "others" cards render at opacity .58 and stay
  legible in both themes (light title #1b1f1d on white, dark #e6e9e5 on #131513)
  (A6); no horizontal document overflow at 390px (A7).
- **Visual critique (screenshots /tmp/feat-153-r2-review/ — board-{1440,1024,390}-{light,dark}.png):**
  the grid ITSELF is clean and appealing — dense 2-col auto-fill cards, amber
  needs rings, a quiet slate left-bar + IN PROGRESS chip for in-flight, QUEUED
  chips, severity bars. A demanding designer would still flag (all LOW, none
  blocking): the FEAT-067 metrics strip above the grid remains chip-heavy and
  shows FOUR zero-value chips (0 DONE · 0 OBSERVATIONS · 0 DEPLOY · 0 STOPPED) —
  the "cluttered" header the user complained about is only half-addressed; and the
  FOCUS line still duplicates the first needs card (deferred to FEAT-067). At
  ≤1024px the ENTIRE board collapses behind a floating badge (pre-existing rail
  responsive behaviour) so the "immediate view" grid is unreachable until tapped —
  not this ticket's regression, but worth a maintainer note given the requirement's
  emphasis on immediacy.
- **Could not test:** real orchard-request session bindings (no live orchestrator
  turn in a headless harness — a real poll clears any injected `state.requests`, so
  the "This session" partition still rests on the verify script's synchronous
  assert c, unverified over live polls); truncated/partial board reads.
- **Independent skeptic recommendation:** this is a regression-prone data-loss/
  liveness class — after the fix, a SECOND fresh-context verify pass over a
  mutating board (state change + add + remove across several real polls) is
  warranted, since the generation suite demonstrably could not catch it.
- **Verified-by:** independent reviewer lane (round 2) — VERDICT FAIL. Ticket
  stays IN-PROGRESS; back to fixing.

### 2026-09-26 — worker (Opus 4.8, phase=fixing round=3 class=fix)
- **Hypothesis CONFIRMED (defect 1):** the round-2 `NotFoundError` was exactly as
  the reviewer diagnosed. In `reconcileGridCards` a sig-changed card did
  `card.remove(); card = null`, but the walk's `cursor` still pointed at that
  now-detached node; the next `grid.insertBefore(newCard, cursor)` referenced a
  non-child → throw. Reproduced live over a REAL 5s timer poll (BUG-205
  building→queued): rejection with that literal message, BUG-205 vanished (15→14),
  and — because `pollRail` had no try/finally — the throw propagated out and
  `scheduleRailPoll` was never reached, so the loop died permanently.
- **Changed (rail panel only; working tree left UNSTAGED — large unrelated
  in-flight changes present, edited surgically):**
  - `public/app.js` — `reconcileGridCards` rewritten as a POSITION-INDEXED keyed
    reconcile: for each desired item i it ensures the right node sits at
    `grid.children[i]`, reusing a node (from either section — `existing` is shared,
    so a card migrates without destruction), rebuilding a sig-changed one in place
    via `replaceWith`, or minting a new one. No cursor node is tracked that could
    be detached, so a sig-change / removal on the node the walk stands on can never
    orphan the insert reference. Handles all mutation classes: state change, order
    change, appear, disappear, cross-section move.
  - `public/app.js` — `pollRail` wrapped in try / catch(log) / finally: the finally
    ALWAYS calls `scheduleRailPoll()`, so any render throw degrades to a logged
    blip, never a frozen rail (defense in depth beyond the reconcile fix).
  - `public/styles.css` — defect 2: `.rail-summary .rs-chip.zero { display:none }`
    so zero-value metric chips (0 DONE · 0 OBSERVATIONS · 0 DEPLOY · 0 STOPPED)
    collapse out of the header (the node stays in the DOM, `.zero`+disabled, so the
    counts contract and feat-067's assertions are unchanged). FOCUS line untouched
    (FEAT-067's).
- **Verified (fixer's own runs; real brave --headless=new over a real seeded server
  on an EPHEMERAL port — PORT unset, never 4317):**
  - `node scripts/verify-feat-153-board-grid.mjs` → 28/28 PASS. Added 7 MUTATION
    checks (n–t) that change / add / remove / reorder a ticket ON DISK and let the
    REAL self-scheduled 5s timer poll pick it up (never a manual pollRail, which the
    boot timer would mask): (n) no throw/rejection on a mid-view state change,
    (o) changed card present with new state + count intact, (p) stable sibling node
    reused (not re-animated), (q) a ticket added AFTER the crash appears on a later
    poll = the loop stayed ALIVE, (r) removal applied on a later poll, (s) a genuine
    priority reorder (last low-sev → high jumps ahead), (t) cross-section migration
    moves the same node, no throw. MUST-FAIL proof: reverted BOTH functions to the
    round-2 form and re-ran → n,o,q,r RED (n: the exact insertBefore rejection; o:
    BUG-205 vanished count 14; q,r: loop dead, later disk changes never picked up);
    restored the fix (md5 == the fixed backup) → 28/28. Board REAL on disk;
    session↔ticket inputs (requests + snap) INJECTED and stated synthetic in the
    script header (a real binding needs a live orchestrator turn this harness has
    none of).
  - Anti-regression (real results): `verify:needs-you-rail` 19/19,
    `verify:rail-refresh` 10/10, `verify:feat-067-rail-summary` 23/23 (zero-chip
    hide did NOT regress the counts/FOCUS assertions), `verify:bug-070` 22/22,
    `verify-arch-017-rail` 32/0.
  - `npm run gate` → PASS (exit 0): leak-gate + check-nul + typecheck.
  - Screenshots (light+dark × 1440 and 1024, expanded/collapsed) → `/tmp/feat-153-r3/`.
    Header now reads "4 NEEDS · 8 QUEUED · 3 RUNNING" only (zero chips gone), FOCUS
    line preserved; grid unchanged and clean.
- **Verified-by:** PENDING — data-loss / liveness class, regression-prone
  (app.js rail render with prior rail regressions). Per the reviewer's standing
  recommendation, a SECOND fresh-context clean-room verify pass over a MUTATING
  board (state change + add + remove + reorder + cross-section move across several
  REAL timer polls) is warranted, plus a re-confirm of the round-2 must-FAIL on a
  clean checkout.
- **Still open / handoff:** independent verification (above). Unchanged from prior
  rounds: the FEAT-067 FOCUS-vs-first-card dedup remains deferred to FEAT-067
  (scope). At ≤1024px the whole rail is behind the responsive reopen badge
  (pre-existing behaviour, not this ticket).

### 2026-09-26 — independent adversarial verify (round 3) — VERDICT: PASS (reconcile is correct and self-healing under fuzz)
- **Verified-by:** independent reviewer lane (round 3, NOT the fixer). Judged from
  the requirement + the panel code + the running UI only; did not read the round-3
  worker rationale or any fixer report (read prior REVIEW entries to know the
  reported defects — the round-2 insertBefore crash + poll-loop death). Own server
  on an EPHEMERAL OS-assigned port (never 4317), own dataDir/store, real brave
  `--headless=new` over raw CDP, driven with the REAL `pollRail`. Torn down by PID;
  no product code touched; no git writes.
- **Re-ran the fixer's suite:** `node scripts/verify-feat-153-board-grid.mjs` →
  28/28 PASS (real output captured).
- **Adversarial attacks NOT in that suite (all PASS):** a randomized mutation FUZZ
  over REAL polls — 36 cycles/seed × 4 seeds = 144 cycles — each cycle applying
  1–5 simultaneous random ops (add / remove / state change / sev change / mine-set
  rebind = section move + prio reorder), plus scheduled cycles that EMPTY a whole
  section (queued, then needs) and refill it next cycle. After every cycle the DOM
  card set / flat order / per-card state / opacity (mine=1, others<1) was recomputed
  from the data (a JS mirror of `boardGridModel`) and asserted to match EXACTLY;
  every cycle matched, zero page errors/rejections across all 144. Also: duplicate
  ids on disk + the same id appearing in two lanes (needs & queued) → ONE card each,
  highest-attention state wins (needs>prog), no dup nodes, no throw. Injected render
  exception (poisoned `state.board.needsYou=42` → `boardGridModel` throws in
  `renderRail`): the grid was NOT corrupted and the NEXT real poll fully recovered
  the 14-card board; a poisoned `state.requests=42` during a real poll did not kill
  the loop and a later poll rendered the full board (pollRail try/finally holds).
  Rapid expand/collapse hammer (12 toggles interleaved with un-awaited polls): no
  throw, collapsed flag stayed consistent with persisted localStorage, no card loss.
  Fuzz harness kept at `/tmp/feat-153-r3-review/fuzz.mjs` (deterministic PRNG,
  FUZZ_SEED reproduces); it imports `ws` so it must run from inside the repo tree.
- **Session partition note (synthetic, stated per WA):** the "This session" binding
  is injected (`state.requests`) with `state.caps.requests=false` so the real
  `refreshRequests` degrades early and does not wipe the injection across polls (a
  genuine "older server" code path). A real orchard-request binding still needs a
  live orchestrator turn no headless harness has.
- **Visual (1440 light+dark, /tmp/feat-153-r3-review/fuzz-1440-{light,dark}.png):**
  grid is clean and appealing in both themes — 2-col cards, "This session" full
  opacity, "Elsewhere on the board" dimmed, IN PROGRESS / QUEUED chips, amber needs
  ring, severity bars; legible in dark. No blocking design defect. Only nits are the
  pre-existing LOWs prior rounds already deferred to FEAT-067 (the metrics chip strip
  + the FOCUS line duplicating the first needs card).
- **Could not test:** truncated/partial reads of INDEX.md while the writer is
  mid-write (144 write→poll cycles used atomic `writeFileSync` and never produced a
  parse error, but a deliberately torn read was not forced — that is the server-side
  board reader, not the FEAT-153 grid code); real orchard-request bindings over live
  polls (synthetic, above); ≤1024px the rail is behind the responsive reopen badge
  (pre-existing).
- **Verified-by:** independent adversarial reviewer lane (round 3) — VERDICT PASS.
  The round-2 data-loss/liveness regression is fixed and self-healing; ready to mark
  VERIFIED at the orchestrator's discretion.

### 2026-09-27 — worker (Opus 4.8, phase=fixing round=4 class=fix)
- **User report after r3 passed review:** "it keeps flickering every few seconds,
  ig it has polling or something." So the r3 "no flicker" proof was incomplete.
- **Diagnosed on the LIVE 4317 app (read-only Playwright + a whole-#railPanel
  MutationObserver + an `animationstart` trap over ~6 poll cycles):** the served
  app.js WAS the r3 code (reconcileGridCards + pollRail try/finally present — not a
  cache issue). Before-fix churn: **456 DOM mutations + 774 `rise` animationstart
  events** in the panel. TWO distinct root causes, neither the grid-card reconcile
  (which r3 fixed correctly):
  1. **(the visible flash)** `renderBoardGrid` ended with an UNCONDITIONAL
     `host.appendChild(mineSec/othersSec)` every poll. `appendChild` of an
     already-connected node is a MOVE = remove + re-insert, and re-inserting a
     connected subtree RESTARTS every descendant's CSS animation — so all ~40 `.tc`
     cards replayed their `rise` entrance each poll (122 rise / 3 polls measured on
     the target `.tc` in `.bg-grid`).
  2. **(panel-wide churn)** r3 keyed only the grid CARDS. The rest of the panel
     still `clear()`+rebuilt on EVERY poll regardless of change: `renderRailSummary`
     (78 childList/window — FEAT-067 strip), `renderRailRequests`→`renderRequestsInto`
     (FEAT-126), the observations block, `renderOutcomes` (railStopped), `renderPending`
     (railPending), plus unconditional `hidden`/`href`/textContent writes in
     `renderRail`/`paintBoardEntry`/`ensureSection`.
- **Changed (rail panel only; working tree left UNSTAGED — large unrelated in-flight
  changes present, edited surgically):**
  - `public/lib/dom.js` — new idempotent writers `setText`/`setHidden`/`setAttr`
    that touch the node ONLY when the value actually moved (an unchanged write still
    fires a MutationObserver record).
  - `public/app.js` — new `railUnchanged(host, sig)` anti-flicker gate: each heavy
    renderer computes a signature of the exact inputs it reads and early-returns when
    it matches the last paint, so an unchanged poll does no clear()+rebuild. Applied
    to `renderRailSummary`, `renderRailRequests`, the observations + done blocks,
    `renderOutcomes`, `renderPending`. `renderBoardGrid`'s section reorder is now
    position-guarded (`insertBefore` only when out of place — never a blind
    re-append), so no card re-animates on an unchanged poll and only genuinely-moved
    sections move on a real change. `ensureSection`, the `renderRail` header block
    and `paintBoardEntry` switched to the idempotent writers. Genuine data changes
    still rebuild exactly as before (the grid's keyed reconcile + all r1–r3 behaviour
    unchanged).
- **Verified (fixer's own runs; real brave --headless=new over a real seeded server
  on an EPHEMERAL port — PORT never 4317; AND read-only observation of the live 4317):**
  - `node scripts/verify-feat-153-board-grid.mjs` → **31/31 PASS**. Added checks (u)
    "4 REAL polls over unchanged data → ZERO panel DOM mutations" and (v) "… → ZERO
    entrance animations", driven by `window.__station.pollRail()` (the exact 5s-timer
    fn; refreshRail(true) → full board refetch) with the board unchanged on disk, over
    a whole-#railPanel MutationObserver + animationstart trap. MUST-FAIL proof:
    reverted the section-reorder guard + the summary/observations/outcomes/pending
    gates (md5-restored after) → (u) and (v) RED, all others green (29/31). All r1–r3
    checks still pass (grid contract, mutation/liveness n–t, answer flow, empty board).
  - **Live 4317 before → after** (read-only, real busy board): 456 mutations + 774
    `rise` → **0 mutations + 0 animationstart** over ~6 poll cycles (final run on a
    123-card real board — far busier than the 15-card fixture).
  - Anti-regression (real results): `verify:needs-you-rail` 19/19, `verify:rail-refresh`
    10/10, `verify:feat-067-rail-summary` 23/23, `verify:bug-070` 22/22,
    `verify-arch-017-rail` 32/0.
  - `npm run gate` → PASS (exit 0): leak-gate + check-nul + typecheck.
- **Verified-by:** PENDING — regression-prone (app.js/dom.js rail render + a shared
  dom.js helper touched by many surfaces). An independent clean-room verify pass is
  warranted: drive the panel over REAL 5s timer polls on a busy board and confirm
  (a) zero panel mutations/animations on unchanged data AND (b) a genuine change to
  ANY gated section (an observation added, an outcome recorded, a pending result
  arriving, a request binding changing, the summary counts moving) still repaints —
  i.e. no sig-gate is over-tight and hiding a real update.
- **Still open / handoff:** independent verification (above). Unchanged from prior
  rounds: FEAT-067 FOCUS-vs-first-card dedup deferred to FEAT-067; at ≤1024px the
  whole rail is behind the responsive reopen badge (pre-existing).

### 2026-09-27 — independent adversarial verify (r4)

- **Verdict: PASS WITH ONE DEFECT.** The change does what it claims — 0 panel
  mutations / 0 entrance animations over 4 real polls on unchanged data — but the
  `renderOutcomes` gate is over-tight and silently drops a real update. This is
  exactly the "no sig-gate is over-tight" risk the fixer flagged as still-open.
- **Re-ran `node scripts/verify-feat-153-board-grid.mjs` → 31/31 PASS** (real brave
  --headless=new, ephemeral port, unpiped exit 0). Confirmed independently.
- **DEFECT (medium) — `renderOutcomes` osig omits a time-derived input →
  stale death labels (`public/app.js:6575`).** `osig = JSON.stringify([state.outcomes,
  showAll])` but the rendered rows read `Date.now()` twice, neither in the sig:
  (1) `datedTime()`→`dayLabel()` (app.js:5836/5824) renders calendar-relative
  "today/yesterday/Sep 27", and (2) `isRecentOutcome()` (app.js:5812) filters the
  default view to a rolling 48h window. On a byte-stable death set the ~5s
  `refreshOutcomes` poll (called every rail poll, app.js:7914) now early-returns, so
  a "today 23:50" death keeps reading "today" after midnight and an aged-out death
  never leaves the recent view — a REGRESSION of BUG-070's own guarantee ("an old
  entry must never read as today's"), which pre-FEAT-153 self-corrected because every
  poll rebuilt. `renderRailSummary` is NOT affected: its `stopped` count is derived
  live and IS in its sig, so it self-heals.
  - **Proven live** (own CDP harness, ephemeral port, temp script removed): the SAME
    record renders `worker-x · tooling-unavailable · today 23:50` through the gated
    path after advancing the clock +26h with identical data, while a control render
    that changes the array (forcing a rebuild) at the same clock shows the correct
    `worker-x · tooling-unavailable · Sep 27 23:50`. Gate held the stale label.
  - **Fix direction** (for the fixer, not applied here): fold a day/48h-bucket token
    into osig, e.g. add `dayLabel(Date.now())` or `Math.floor(Date.now()/3.6e6)` and
    the recent-filtered count, so a boundary crossing invalidates the sig.
- **Low / theoretical (not worth a fix alone, noted for completeness):**
  - `renderRailRequests` rqSig (app.js:7256) captures `snap.running` as
    `[owner, ticket, state]` but `executionOf`→`attributedLanes` also reads
    `lane.request`; `owner` is captured yet unused. A miss needs an in-place mutation
    of an existing lane's `.request` with no length/ticket/state change — a new lane
    changes the array length and IS caught. Not observed reachable.
  - `renderRailSummary` sig (app.js:7130) captures `inflight` as `[id, title]` but the
    FOCUS row reads an inflight focus item's `kind` for click-affordance; a same-id
    same-title kind flip on the focus item would leave the link stale. Vanishingly rare.
- **Checked and CLEAN:** dom.js `setText`/`setHidden`/`setAttr` all compare against the
  LIVE DOM (not a cached value); 0/boolean/null handled sanely. `renderBoardGrid` is
  ungated (keyed reconcile) so no time/theme/collapse input is hidden by a sig; card
  content is id/title/sev/state only (no time). Project switch repaints: `summary` sig
  carries `pid`, and the other gated sections' data arrays differ per project (globally
  unique ids) so no cross-project leakage. renderPending/observations/done sigs capture
  full content.
- **Verified-by:** independent adversarial verify lane (FEAT-153 r4), fresh context,
  did not read fixer report/Activity build entries.

### 2026-09-27 — worker (Opus 4.8, phase=fixing round=5 class=fix)
- **Fixed all three r4 sig-gap defects (rail panel only; `public/app.js`,
  working tree left UNSTAGED — large unrelated in-flight changes present, edited
  surgically):**
  1. **MED — `renderOutcomes` osig** (now ~app.js:6585). Was
     `[state.outcomes, showAll]`; the rows read `Date.now()` twice (`datedTime`→
     `dayLabel` calendar-relative label; `isRecentOutcome` 48h filter) so a
     byte-stable death set still changes on screen at a day boundary / 48h ageout.
     Folded in a token that changes exactly when a rendered output would:
     `new Date().toDateString()` (local calendar day → every day-label transition)
     and the id set passing the 48h filter (recent-view membership + the "show all
     (+N)" count). An unchanged poll still costs 0 mutations. Restores BUG-070's
     "an old entry must never read as today's".
  2. **LOW — `renderRailRequests` rqSig** (~app.js:7281). Added `l.request` to the
     running-lane tuple: `attributedLanes()` matches a lane to a request by
     `lane.request === requestId`, so an in-place `.request` change (no
     length/ticket/state change) is a real join change the old tuple missed.
  3. **LOW — `renderRailSummary` sig** (~app.js:7147). Added `kind` to the inflight
     tuple (`[x.id, x.kind, x.title]`): the FOCUS row reads the focus item's kind to
     decide the click-to-open affordance (`isTicket`), so a same-id/same-title kind
     flip on an in-flight focus item left the link stale.
- **Swept every other railUnchanged/sig site** for the same class (an input the
  render reads that the sig omits, esp. Date.now()-relative text): `renderPending`
  psig, observations sig, done sig, and `renderRailSummary`'s other fields — all
  clean. `renderPending`/`renderLastDrain` render NO time-relative text (checked
  every `datedTime`/`dayLabel`/`Date.now()` render site; only renderOutcomes among
  gated renderers dates rows). `renderBoardGrid` is ungated (keyed reconcile) so no
  input is hidden by a sig. No other over-tight gate found.
- **Verified (fixer's own runs; real brave --headless=new over a real seeded server
  on an EPHEMERAL port — PORT never 4317):**
  - `node scripts/verify-feat-153-board-grid.mjs` → **34/34 PASS**. Added checks
    (w) outcomes poll across a faked +49h/day boundary re-labels the death (no
    stale "today") on a byte-stable array; (x) an in-place `lane.request`
    re-attribution moves the running badge RQA→RQB; (y) a kind flip on the in-flight
    FOCUS item turns the static focus text into a clickable open-link — same
    id/title. MUST-FAIL proof: reverted the three sigs to the r4 form and re-ran →
    exactly w,x,y RED (31/34), all others green; restored the fix (md5
    2dfe8d6e51eacd10f55327502d14c50a verified identical) → 34/34. The r4 zero-churn
    checks (u,v) stay green (the sigs still early-return on genuinely unchanged data).
  - Anti-regression (real results): `verify:needs-you-rail` 19/19,
    `verify:rail-refresh` 10/10, `verify:feat-067-rail-summary` 23/23,
    `verify:bug-070` 22/22.
  - `npm run gate` → PASS (exit 0): leak-gate + check-nul + typecheck.
- **Verified-by:** PENDING — regression-prone (app.js rail render). An independent
  clean-room verify pass is warranted per the standing recommendation: confirm the
  three gates still early-return on truly-unchanged polls (no over-loosening) and
  re-confirm the r5 must-FAIL on a clean checkout. The (w) day-boundary check uses a
  faked clock; (x)/(y) use synthetic injected requests/board (a real orchard-request
  binding needs a live orchestrator turn no headless harness has) — stated per WA.
- **Still open / handoff:** independent verification (above). Unchanged from prior
  rounds: FEAT-067 FOCUS-vs-first-card dedup deferred to FEAT-067; at ≤1024px the
  whole rail is behind the responsive reopen badge (pre-existing).

### 2026-09-27 — independent adversarial verify (r5) — VERDICT: FAIL (one LOW silent-loss defect: rqSig collapses snap=null and snap.running=[])
- **Verified-by:** independent adversarial reviewer lane (FEAT-153 r5, fresh context, NOT the fixer). Own server on an ephemeral OS-assigned port (never 4317), real brave `--headless=new` over CDP, real `public/app.js`; killed by PID, no pkill; scratch harness (a copy of `scripts/verify-feat-153-board-grid.mjs`) removed after the run.
- **Suite re-run:** `node scripts/verify-feat-153-board-grid.mjs` → **34/34 PASS** (unchanged from the fixer's run).
- **Independent enumeration of every railUnchanged/sig site vs what its render reads:**
  - `renderPending` psig (~6011) — reads only `state.pending`/`pendingProblem`/`pendingActionProblem`/`lastDrain`/`showAllPending`; `recoveryHint` is pure; no time-relative render. **Complete.**
  - `renderOutcomes` osig (~6587) — `dayToken` (local `toDateString`) + `recentIds` (48h set) cover every `datedTime`/`dayLabel`/`isRecentOutcome` Date.now() read. **Complete.**
  - observations obsSig / done doneSig — full JSON of the arrays; rows render no time. **Complete.**
  - `renderRailSummary` sig (~7142) — captures `pid,hasBoard,sum,needs[id,kind,title,sev],inflight[id,kind,title],stopped,live`; note `live` is `null` for snap=null and `0` for empty — so the summary DISTINGUISHES the two (no gap here). **Complete.**
  - `renderBoardGrid` — ungated (keyed `cardSig` reconcile, model recomputed every poll) so no sig can hide an input. **Complete.**
  - **`renderRailRequests` rqSig (~7272) — GAP.** The sig encodes the snapshot as `(state.snap?.running ?? []).map(...)`, which maps BOTH `snap=null` (liveness UNKNOWN) and `snap.running=[]` (liveness KNOWN-idle) to the same `'[]'`. But the join distinguishes them: `sessionLiveness` returns `known:false` for null vs `known:true,live:0` for `[]`, and `executionOf`'s coarse fallback returns `running` (count>0, unconfirmed) for null but `idle` for the confirmed-empty case. `dockIsForeign()` (also in the sig) is snap-independent, so it does not save the gate.
- **Live proof of the real gap (change the input over real renders → DOM stays stale):** a request bound to a `prog`/inflight ticket (BUG-205), `s.snap=null` → `renderRail()` paints exec badge **"1 running"**; then `s.snap={running:[]}` (empty snapshot confirms nothing runs) → GATED `renderRail()` leaves the badge at **"1 running"** (WRONG); forcing the gate open (mutate a captured input) repaints the correct **"idle"**. This is the "0 running must never read as running/done" observability-lie class FEAT-126 exists to prevent. Reachable in normal use: `state.snap` starts null and is reset to null on every session switch (BUG-034, app.js:3510), so switching to a view whose running poll returns an empty snapshot leaves a stale "N running" until some OTHER captured input changes (self-healing but not immediate). Severity **LOW** (narrow precondition, transient). Suggested fix: add a null/known discriminator to rqSig (e.g. `Array.isArray(state.snap?.running)`), mirroring how `renderRailSummary` already encodes `live` as `null|count`.
- **Reverse check (over-tight / volatile sig):** raw MutationObserver on `#railPanel` over **3 settled unchanged real `pollRail()` polls → 0 mutations** (zero-churn holds). Faked local-midnight crossing (frozen clock 23:59→00:00): two same-day renders → **0 mutations**; crossing midnight re-labels the death **"today 23:50" → "yesterday 23:50"** (correct repaint, not stale). No sig carries per-poll-volatile data.
- **Could not test:** a fully organic `snap=null→empty` transition mid-navigation (drove it via direct state injection over the real render path — the transition itself is real app state, only the request binding + board are synthetic, as in the suite). An independent clean-room pass on the eventual fix is still warranted (session-lifecycle-adjacent, regression-prone rail render).

### 2026-09-27 — worker (Opus 4.8, phase=fixing round=6 class=fix)
- **Fix (the r5 LOW gap):** `renderRailRequests` rqSig (public/app.js ~7272) now
  appends `Array.isArray(state.snap?.running)` as a discriminator, mirroring how
  `renderRailSummary`'s `live` already encodes `null|count`. This distinguishes
  `snap=null` (liveness UNKNOWN → `false`) from `snap.running=[]` (liveness
  KNOWN-idle → `true`), so an empty snapshot that confirms the lane went idle now
  opens the gate and repaints the exec badge off "N running". Fixes the
  observability-lie the r5 verify reproduced live.
- **Must-FAIL proof:** added check `(z)` to `scripts/verify-feat-153-board-grid.mjs`
  — a request bound to a `prog`/inflight ticket (no attributed lane), driven over
  the REAL render path `snap=null → renderRail()` (badge "1 running") then
  `snap.running=[] → renderRail()` (GATED), asserting the badge clears to "idle".
  With the discriminator line reverted: **34/35, (z) RED** (badge stuck at
  "1 running"), every other check green. With the fix: **35/35 PASS**.
- **Anti-regression (rail suites re-run):** `verify:rail-refresh` 10/10,
  `verify:needs-you-rail` 19/19, `verify:feat-067-rail-summary` 23/23 — all green.
- `npm run gate` → **PASS (exit 0)** (leak-gate + check-nul + typecheck).
- **Method honesty:** own server on an OS-assigned ephemeral port (freePort, never
  4317), real brave `--headless=new` over CDP, real `public/app.js`. The request
  binding + board are synthesised (a real binding needs a live orchestrator turn no
  headless harness has); the `snap=null→empty` transition is real app state driven
  over the real render/gate path, as in check (x). Stated per WA.
- **Independent verify warranted:** YES — session-lifecycle-adjacent, regression-prone
  rail render (r5 flagged this class). A clean-room pass over the eventual fix is
  still recommended, excluding this ticket from the diff.
- **Files:** `public/app.js` (rqSig discriminator + comment),
  `scripts/verify-feat-153-board-grid.mjs` (check (z)), this ticket, `INDEX.md` (board:gen).

### 2026-09-27 — independent adversarial verify (round 6) — PASS
- **Verified-by:** verify lane (independent adversarial reviewer; did not read
  worker/fixer entries; own OS-assigned ephemeral port, never 4317; no product edits).
- **Suite re-run:** `VERIFY_GRID_PORT=<free> VERIFY_GRID_BROWSER=brave node
  scripts/verify-feat-153-board-grid.mjs` → **35/35 PASS**, incl. `(z)`
  snap=null "▶1 running" vs snap.running=[] "idle" discriminated in rqSig.
- **Attack (real join + faithful rqSig replica):** replayed the full snapshot
  sequence `null → [x] → [] → null → [x,y] → [y] → []` plus a session switch
  (snap→null + new requests). Badge matched the data at EVERY step via the real
  `joinRequests`/`executionLabel`; rqSig moved on every transition; the r6 pair
  `rqSig(null) !== rqSig([])` holds with badges `1 running` vs `idle`. Churn:
  3 identical polls in the null state AND 3 in the [] state each yield a constant
  sig (→ 0 gated mutations) — no churn introduced. **12/12 PASS.**
- **rqSig completeness:** `joinRequests` reads only bindings, board
  (needsYou/queued/inflight/doneToday — list-membership + id/status), and snap
  (running tuple [owner,ticket,state,request] + `Array.isArray(running)` known-flag).
  All captured; board `item` is not rendered; `dockIsForeign()` is over-captured
  (harmless, safe direction — extra repaint never a missed one). No omitted input.
- **Verdict:** claim CONFIRMED. No defects.
