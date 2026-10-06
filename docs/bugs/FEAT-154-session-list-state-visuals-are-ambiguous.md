# FEAT-154 — session-list state markers are ambiguous (one moss accent for four states)

- **Status:** IN-PROGRESS
- **Severity:** medium
- **Area:** sidebar (nav session list)
- **Reported:** 2026-09-28 by user
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
User, verbatim: "remake the visuals of the session lists — currently has actual
running agents/subagents in session > mark maybe light blue; finished but not yet
read (opened) by user > another color or bold; we currently seem to have
non-filled green circle and filled green circle, and a yellow triangle, honestly
idk what each means… we need better visuals for states".

## Repro
Open the dashboard, scan the left nav session list. Multiple sessions in
different states render markers that are hard to tell apart.

## Root cause — VISUAL overload, not a wrong/missing state (hypothesis-gate result)
The dispatch hypothesis was: hollow green = idle/alive, filled green = running,
yellow triangle = waiting-on-you/warning. Verified against the code — the
hypothesis's MEANINGS are wrong, but the crucial gate ("do the signals carry
running / unread reliably?") PASSES, so this is a restyle, not a state rebuild.

The states are all reliably sourced from their owners (ARCH-010 already honoured
by FEAT-118). The defect is that the **moss `--live` accent is reused for four
distinct meanings**, separated only by fill/motion that the eye cannot resolve:

- **filled moss dot, breathing** = running, ANOTHER process writing (`.alive`)
- **hollow moss ring, breathing** = running, THIS dashboard driving (`.alive.here`)
- **hollow moss ring, still** = just finished, <8min (`.settled`)
- **filled moss dot, trailing** = unread activity (`.unread`)

So "non-filled green circle" the user sees is BOTH `.alive.here` (running-here)
AND `.settled` (finished) — two near-identical hollow moss rings. "Filled green"
is `.alive` (running-other) or the trailing unread dot. The "yellow triangle" is
`.stopped` = **died without answering** (agent-outcomes ledger), NOT waiting-on-you.

## Inventory of every per-session nav indicator today (FEAT-118)
Rendered entirely in `public/app.js` `sessionRow()` (L1789–1905); one leading-rail
lifecycle marker (mutually exclusive) + orthogonal cues.

| Indicator | class | condition | owner of the fact |
|---|---|---|---|
| running, other writer | `.alive` (filled moss, breathe) | `life==='running' && !drivenByDashboard` | liveness authority → `/api/sessions/live` (`src/server/liveness.ts`) |
| running, this dashboard | `.alive.here` (hollow moss ring, breathe) | `life==='running' && drivenByDashboard` | same |
| died w/o answering | `.stopped` (amber triangle) + row `.died` | `life==='stopped'` = `!live && endedUnanswered` | agent-outcomes ledger (`src/server/outcomes.ts`) via `/api/agent-outcomes` |
| just finished (<8min) | `.settled` (hollow moss ring, still) | `life==='finished'` = `!live && !died && recent` | client recency of `sess.lastActivityAt` |
| unread activity | `.unread` (trailing moss dot) + row `.fresh` | `fresh && life!=='running'` | client seen map `state.seen` (localStorage `cs-seen`) |
| recently visited (<2h) | row `.visited` (muted timestamp) | `recentlyVisited` | client seen map |
| pinned | `.pin-mark` (slate-blue glyph) | `api.pinnedOf` | client localStorage |
| renamed | row `.named` (slight ink lift) | `api.renamedOf` | client localStorage |
| new unsent | row `.pending` (italic) | `sess.pending` | client |
| open/active | `aria-current` | current session | client |

**Waiting-on-you is NOT surfaced on any nav row today.** Its owner is
`awaitingUserDecision()` / `state.decisionsByRequest` (BUG-166), which is scoped
to the CURRENTLY-OPEN session only. Surfacing it on OTHER rows needs a
server-owned per-session field (ARCH-010) — see the "not done" note below.

**Seen/unread is durable client-side only** (`localStorage cs-seen`); there is no
server seen field and no `markSeen` endpoint. That IS the one place seen-state is
owned, so unread is read from there (not re-derived).

## Design — adopt the app's existing ticket-status semantic palette for sessions
The app already owns a four-tint SEMANTIC status palette (`--st-prog` blue =
in-progress, `--st-needs` amber = needs-you, `--st-done`/`--live` moss = done,
`--st-high` red = high/alarm). Session lifecycle IS status, so the nav adopts the
SAME language instead of overloading one moss accent:

| State | colour | shape | motion | title | tooltip |
|---|---|---|---|---|---|
| **Waiting on you** (open row today) | amber `--st-needs` | filled dot + halo ring | gentle pulse | bold | "Waiting on your answer" |
| **Running** (session or its agents/subagents) | light blue `--sess-run` (new) | filled dot; hollow ring = this dashboard drives | gentle pulse (reduced-motion → still) | normal | "Running now — …" |
| **Error / ended w/o answering** | brick red `--st-high` | filled triangle (SHAPE) | none | normal + red timestamp | "Ended without answering — <why>" |
| **Finished, unread** | moss green `--live` | trailing filled dot | none | **bold** | "New activity since you last looked" |
| **Finished, read** (recent) | muted moss | hollow ring | none | normal | "Just finished — no turn is running" |
| **Idle / read** | — | none | none | muted | — |

Precedence (one leading marker): **waiting-on-you > running > error > finished >
idle**. Justification vs the dispatch's suggested order: running/error/finished
are already mutually exclusive at the ground-truth resolution (`sessionLifecycle`
returns running if live, else error if a death is on record, else finished) so
their relative order never actually collides; waiting-on-you is layered ABOVE that
because a paused-for-input turn can still read `live`, and the amber "you must
act" must beat the blue "it's working". Unread is orthogonal: a **bold title**
(+ trailing green dot), suppressed while running (content is arriving).

Non-colour cues (colour-blind + fast-scan safe): waiting = amber + halo + bold;
running = blue + pulse (+ ring for here); error = triangle SHAPE; unread = bold
title + trailing dot; finished-read = hollow ring; idle = nothing. Distinct
shapes, motion, and weight back every colour. Reduced-motion respected. Both
themes via existing `--st-*` dark overrides + a new `--sess-run` dark value.

### Semantic reassignment (the crux)
- **blue = active/working** (was moss). Honours the user's explicit "running →
  light blue". Collapses the two confusing greens into ONE blue family (here vs
  other becomes a subtle fill/ring weight + tooltip, not a second colour).
- **green (moss) = finished / done / new** (was overloaded with running). Now
  moss means only "complete / there's something new", matching `--st-done`.
- **red = error/died** (was amber). Frees amber and makes a lost-work death read
  as a problem, conventionally.
- **amber = waiting on you** (the most urgent), reserved per the user's model.

## Context pack
- Files/functions in play: `public/app.js` `sessionRow` (L1789), `sessionLifecycle`
  (L1669), `awaitingUserDecision` (L9071), `liveInfo` (L9617); `public/styles.css`
  session-row markers (L286–349 `.alive`, L3314–3356 lifecycle/unread), palette
  tokens (L35/52–55 + dark 93–99/119–122).
- Owners read (ARCH-010): liveness (`src/server/liveness.ts`), outcomes ledger
  (`src/server/outcomes.ts`), seen map (`localStorage cs-seen`), pending-question
  (`awaitingUserDecision`, BUG-166).
- Related: FEAT-118 (built the lifecycle model), BUG-166 (pending-question owner),
  BUG-086 (pin glyph), BUG-193 (fold — concurrent edits in app.js, do not disturb).
- Repro test: `npm run verify:feat-154` (added).

## Not done in this ticket (honest scope, ARCH-010)
Cross-row "waiting on you" (an amber marker on NON-open rows whose paused turn
awaits input) needs a **server-owned per-session pending-question field** — it
cannot be read off `decisionsByRequest`, which only knows the open session.
Fabricating it client-side would be the exact parallel-derivation ARCH-010
forbids. This ticket surfaces waiting-on-you on the OPEN row from its real owner
and RECOMMENDS the server field as a follow-up rather than faking cross-row.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-28 — fixing lane (round 1)

- **Hypothesis-gate result (verified FIRST, before styling):** the dispatch
  hypothesis was partly wrong but the gate PASSED, so no STOP. The signals DO
  carry running (liveness authority) and unread (seen map) reliably. What was
  wrong: the "yellow triangle" means **died without answering** (outcomes
  ledger), not waiting-on-you; and "hollow green" was OVERLOADED across both
  running-this-dashboard AND just-finished. The defect is purely visual: one moss
  accent reused for four states. Full inventory recorded above.

- **Understood:** FEAT-118 already resolved the five lifecycle states from their
  owners (ARCH-010-clean). Nothing about the STATE model was broken; the VISUAL
  language was. Fix = restyle into the app's existing ticket-status semantic
  palette (blue=active, moss=done/new, amber=you, red=error), one distinct
  colour+shape+weight per state, colour never the only cue, both themes, reduced
  motion respected.

- **Changed (all client-only unless noted; live :4317 needs only a page reload):**
  - `public/styles.css` — new `--sess-run` token (light `#3E8CB8` / dark
    `#7CBBE0`); RUNNING is now a light-blue dot with a gentle `sess-pulse` halo
    (reduced-motion → none); DIED triangle recoloured amber→`--st-high` (red);
    finished ring made visible (1.5px full-chroma moss) with a FILLED `.settled.new`
    = unread variant; new `.waiting` amber dot+halo + `.row.awaiting` bold;
    unread title bold; all leading markers aligned to one column; visited
    timestamp lifted .5→.62; removed the now-dead trailing `.row .unread` rule.
  - `public/app.js` — `sessionRow`: precedence waiting-on-you > running > error >
    finished > idle; unread folded into the leading-rail moss marker (filled=unread,
    hollow=read); state carried to screen readers via `aria-label` (NOT a text
    child — see feat-073 regression below); waiting-on-you read from the BUG-166
    owner `awaitingUserDecision()` on the OPEN row. Exposed `sessionRow` +
    `sessionLifecycle` on `window.__station` for the verify harness.
  - `scripts/verify-feat-154-session-state-visuals.mjs` (+`package.json`
    `verify:feat-154`) — new.

- **Verified (fixer's own run):**
  - `npm run verify:feat-154` — **19/19**. Real Chromium/CDP against a real
    scratch server drives the REAL `sessionRow`: state→indicator mapping, the
    precedence (waiting out-ranks running; running suppresses unread), rendered
    markers bind to their intended tokens, the four state colours are MUTUALLY
    DISTINCT in BOTH light and dark (must-FAIL sentinel: the pre-fix values
    running=`--live`, died=`--st-needs` WOULD collide — the distinctness check
    reddens on them), and reduced-motion removes the pulse. Inputs synthetic by
    necessity (a session can't be all states at once); every deciding artifact
    real (function, state maps, CSS, browser).
  - `npm run gate` — **exit 0** (leak-gate + check-nul + typecheck).
  - Anti-regression: `verify:feat-118-ui` 15/15, `verify-bug-193-list-fold` 31/31,
    `verify-feat-073-new-session-row` 12/12.
  - **Regression I introduced and fixed same-round:** first cut appended a
    `.sr-only` text child for the state, which polluted the row's `textContent`
    and broke feat-073's `$`-anchored title matching (9/12). Moved the state to
    `aria-label` (the correct pattern — no textContent pollution) → 12/12. Added a
    feat-073-class anti-regression assertion to verify:feat-154.
  - Real-page screenshots (live :4317 after reload, both themes, all 8 states via
    fixture through the real `sessionRow`):
    `docs/bugs/assets/FEAT-154-states-light.png`,
    `docs/bugs/assets/FEAT-154-states-dark.png`.
  - **Independent visual design review** (fresh subagent, given ONLY the
    screenshots + legend): flagged do-not-ship — faint moss ring, finished-unread
    vs finished-read distinguished only by a weak timestamp, muted timestamps too
    low-contrast, a two-dot vocabulary (leading vs trailing), an over-cued error
    row, and title-less fixture rows. All addressed: ring made visible; unread
    moved to the leading rail as a FILLED moss dot (filled=unread / hollow=read,
    the same grammar as running); timestamp contrast lifted; trailing unread dot
    removed; error row de-cluttered to one triangle + red timestamp; fixture given
    real titles (rowTitle reads `displayTitle`, not `title`). Re-screenshotted.

- **Note on the running build:** app.js is served statically; confirmed the live
  :4317 serves the new bytes (`settled new` present, old `.unread` append gone).
  A stale headless tab briefly rendered the OLD sessionRow — caught it, hard
  reloaded, re-verified the DOM (one marker per row, no stray dots) before the
  final screenshots. app.js carried large PRE-EXISTING uncommitted BUG-193 edits
  (~1270 insertions) that this lane layered on top of and did not disturb.

- **Still open / handoff:**
  - Cross-row "waiting on you" (amber on NON-open rows) needs a **server-owned
    per-session pending-question field** — `decisionsByRequest` only knows the
    open session, and faking it client-side is the parallel derivation ARCH-010
    forbids. This lane surfaces it on the OPEN row from the real owner and leaves
    the cross-row version as a recommended follow-up (worth its own FEAT).
  - INDEX.md row + `board:gen` are orchestrator-owned — please add the FEAT-154
    Open row and regenerate.
  - `Verified-by:` still required before VERIFIED (class=fix): an independent
    clean-room pass is warranted — this touches `sessionRow`, a
    regression-prone file (BUG-193/BUG-085/FEAT-118 history); a fresh verifier
    should attack the precedence + the aria-label/textContent boundary against a
    tree that isolates the BUG-193 edits.


### 2026-09-28 — fixing lane (round 2): cross-row waiting-on-you (server-owned)

- **Understood:** round 1 surfaced waiting-on-you on the OPEN row only, from the
  client store — so the new amber legend was not true for other rows. Round 2
  makes it true everywhere by having the OWNER publish the fact (ARCH-010).

- **Changed:**
  - `src/server/index.ts` — `GET /api/sessions` now publishes `awaitingUser` per
    session, read straight from the bridge's own `approvalsSnapshot()` (the
    `#approvals` store — BUG-166's server side): true while a `can_use_tool` /
    AskUserQuestion / ExitPlanMode request is outstanding. **Server change → :4317
    must be restarted for it to take effect.**
  - `public/app.js` — `state.awaitingIds` (Set of sdkSessionIds), rebuilt every
    live poll in `refreshLive` from the published `awaitingUser` on the bridge
    list (durable while the bridge lives, unlike the mtime `/api/sessions/live`
    which drops a >30s-silent paused session). `sessionRow` now reads
    `state.awaitingIds.has(sess.sessionId)` for EVERY row (dropped the round-1
    open-row-only `awaitingUserDecision()` path); the client never re-derives it.
  - `scripts/verify-feat-154-awaiting-field.mjs` (+`verify:feat-154-await`) — new
    server end-to-end test.

- **Verified:**
  - `npm run verify:feat-154-await` — **5/5** on an isolated second instance (free
    port, fake CLI): the row carries `awaitingUser` (must-FAIL pre-round-2:
    undefined); false at baseline; a REAL `can_use_tool` flips it TRUE; answering
    it clears it to FALSE. Instance stopped by pid + `cleanupWorld` afterwards;
    :4317 untouched.
  - `npm run verify:feat-154` — **21/21** (added the two cross-row cases: a
    NON-OPEN session with a pending question renders amber + running suppressed;
    the amber clears once the id leaves the published set → falls back to running).
  - `npm run gate` — **exit 0**. Anti-regression: feat-118-ui 15/15,
    bug-193-list-fold 31/31, feat-073-new-session-row 12/12.
  - Re-screenshotted both themes (waiting now shown on a NON-open row):
    `docs/bugs/assets/FEAT-154-states-{light,dark}.png`.

- **Restart:** the client change is already served on :4317 (reload); the SERVER
  field needs a :4317 restart to go live — not done by this lane (would kill the
  orchestrator). Until then the amber marker stays inert on :4317 (the client
  reads a field the running server does not yet emit).

- **Symptom of a deeper design flaw?** no — this is the ARCH-010 pattern applied
  correctly (owner publishes, list reads).


### 2026-09-28 — fixing lane (round 3): two WRONG states on live :4317 (bugs A + B)

The user reported two markers that were simply false on live :4317. Both were
STATE-correctness defects (not visual), both an ARCH-010 read violation, and they
INTERACT (fixing A alone would have turned session A's false-blue into a
false-red). Verified each hypothesis independently against the real running store.

- **Bug A — an idle-but-alive session reads "running" (light blue).**
  `7f7e39a1` (and `4846de18`) sit in `/api/sessions/live` with the liveness
  authority's own verdict `liveness.running:false, kind:'idle'` (broker+CLI alive,
  no turn in flight) — yet rendered light-blue "running". Cause: `sessionLifecycle`
  used `hasLiveWork(sess)` = mere PRESENCE in the live list, ignoring the owner's
  `running`. The owner (src/server/liveness.ts) already declares `running`; the
  client re-derived it from presence — the exact ARCH-010 defect. A second, hidden
  half: `api.liveSessions()` mapped each entry through a field whitelist that
  DROPPED `liveness` entirely, so the verdict never reached the client at all.

- **Bug B — a live session reads "ended without answering" (red triangle).**
  `b4f45fc0` (the orchestrator's own live session) carried only `row:'tool'`
  outcomes (killed/failed `local_bash` lanes) — individual bash commands the engine
  reported failed mid-turn, NOT the session dying. `endedUnanswered` matched ANY
  recent undismissed outcome for the id regardless of `row`, so whenever the session
  was momentarily not-running (between turns / just after the restart) it rendered
  the red "ended without answering" triangle. The marker is a SESSION fact; the
  owner (outcomes.ts) already distinguishes `row: 'main' | 'agent' | 'tool'`.

- **Fixes (client-only; no server change; :4317 needs only a RELOAD, no restart):**
  - `public/lib/api.js` `liveSessions()` — carry the authority's `running` verdict
    through the whitelist (`running: typeof x.liveness.running==='boolean' ? … :
    null`; null = mtime-only entry = actively writing). This was the load-bearing
    miss — without it the app.js fix silently fell back to "present ⇒ running".
  - `public/app.js` — new `isSessionRunning(sess)` reads `liveInfo(sess).running`
    (the owner's verdict), replacing `hasLiveWork` in `sessionLifecycle`'s running
    branch; `hasLiveWork` is left untouched for its VISIBILITY role. `endedUnanswered`
    now requires `o.row === 'main'` (a session death), so tool/agent LANE deaths no
    longer mark the session stopped. Genuine `row:'main'` deaths still mark stopped.
  - `scripts/verify-feat-154-session-state-visuals.mjs` — harness now stamps the
    real wire shapes (`running` on live entries; `row:'main'` for a session death;
    tool+agent lane deaths for the bug-B fixture) and 4 new checks + 2 controls.

- **Verified:**
  - `npm run verify:feat-154` — **28/28** (was 21/21). New: bug-A idle-alive is not
    running + its must-FAIL sentinel; bug-A control (running:true still running);
    bug-B lane-deaths not stopped + its must-FAIL sentinel; bug-B live-with-lane-
    deaths stays running; bug-B control (row:'main' still stopped).
  - **Must-FAIL proof (anchored to the pre-fix signals, not a moving baseline):**
    reverting the two logic lines → the 4 new checks FAIL (24/28), the 3 controls
    stay green. Re-applied and re-ran → 28/28.
  - `npm run gate` — **exit 0** (leak-gate + check-nul + typecheck).
  - Anti-regression: `verify-bug-193-list-fold` 31/31, `verify-feat-073-new-session-
    row` 12/12, `verify-feat-118-ui` 15/15. `verify-liveness-conformance` 86/88 —
    the 2 fails (`L4` ad-hoc check in `lanes.ts`/`runtime/claude-runtime.ts`; `L2b`
    needs a real runtime) name server files this lane did NOT touch (client-only
    change), i.e. pre-existing WIP, not this fix.
  - **Against the USER'S real live :4317 data** (not a fixture): computed old-vs-new
    marker for every session in the real live list + outcomes ledger, then drove the
    REAL `sessionLifecycle`/`sessionRow` in headless Chromium against live :4317.
    7f7e39a1 → `life:null` (no blue dot; the fresh browser profile with no seen-map
    shows an unread moss dot, not running); 4846de18 → same; b4f45fc0 → correctly
    `running` (it is live), never the triangle. **State changes across projects in
    that snapshot: 2 sessions stop falsely showing "running" (7f7e39a1, 4846de18);
    2 sessions stop falsely showing "ended without answering" (e74d3def, c8d394b5 —
    both lane-only deaths); a genuine `row:'main'` provider-error death (019ff078)
    is correctly still stopped.** Count is point-in-time (fluctuates as sessions
    come/go).

- **Restart needed?** No. Both files are served statically; a fresh headless tab
  already fetched the new bytes from :4317 and rendered correctly. A user reload
  suffices.

- **Untested / handoff:** an independent clean-room verify pass is warranted
  (class=fix touching `sessionRow`/lifecycle, a regression-prone file — BUG-193/
  FEAT-118 history, and this is a lifecycle-correctness change): attack the
  running/stopped precedence and the `row` filter against a tree isolating the
  BUG-193 edits. The two liveness-conformance fails (`L4`/`L2b`) predate this lane
  and belong to separate WIP — worth confirming they are green on a clean HEAD.


### 2026-09-28 — verifying lane (round 1): cross-provider clean-room — VERDICT BROKEN

- **Verified-by:** dispatch anthropic/claude-opus-5-5 run
  `bfaa5172-3bbe-4851-a83f-3fa88611e491` (clean-room, `scripts/independent-verify.mjs`)
  — VERDICT: **BROKEN**. SAME-PROVIDER (Claude verifying Claude, decorrelation
  reduced) because OpenAI was rate-limited at run time; an OpenAI/Codex cross-
  provider pass is still warranted once quota returns.

- **How run (mechanism, ARCH-010 clean room):** the four FEAT-154 files carry
  heavy unrelated WIP (BUG-193/FEAT-151), so the FEAT-154 hunks were isolated into
  a git RANGE `base..head` (base_tree `fa2735ce` = full working tree with only the
  14 FEAT-154 hunks reverted; head_tree `05413962` = full runnable working tree).
  The verifier saw ONLY the requirement + that 22KB FEAT-154-only diff + the two
  author test scripts + run commands — no ticket prose, no fixer reports (docs/bugs
  + docs/prompts stripped from the room). It re-ran both author suites once
  (`verify:feat-154` 28/28, `verify:feat-154-await` passed) then attacked.

- **REAL DEFECT (high — a core requirement is inert in the real app):**
  `public/lib/api.js` `liveBridges()` maps each bridge to only
  `{sdkSessionId, stationSessionId, busy, turnStartedAt}` and **drops the server-
  published `awaitingUser` field**. `refreshLive` (app.js ~L9680) builds
  `state.awaitingIds` from `api.liveBridges()` filtered on `b.awaitingUser === true`
  — so the filter is never true, `state.awaitingIds` is permanently empty, and
  `sessionRow` (app.js L1848) `state.awaitingIds.has(...)` is always false.
  **In the real app NO row (open or not) ever shows waiting-on-you, and a running
  session with a pending question shows running** — requirement scenarios 5 and 6
  fail. Both author suites pass only because they BYPASS this pipeline: the browser
  test writes `state.awaitingIds` directly and the server test reads `/api/sessions`
  directly; neither drives `liveBridges()`→`refreshLive`. The round-2 fix updated
  `liveSessions()` to carry `running` but never updated `liveBridges()` to carry
  `awaitingUser`. Confirmed independently against the real working-tree code
  (orchestrator re-grep), not just the clean-room run. NOT fixed by this lane.

- **What the verifier could NOT test (coverage gaps, honest):** scenario 8
  (finished-unread surviving a page reload — `state.seen` persistence not
  exercised); scenario 7 (stale liveness record after a killed process — whether
  the server ages it out / keeps `running:true`; also the client treats
  `running:null` = mtime-only as running, untested); scenario 4 only via the
  author's synthetic `row:'main'` fixture, not a real killed CLI; and no perceptual
  / colour-blind human check (computed-style token distinctness only).


### 2026-09-28 — fixing lane (round 4): waiting-on-you was inert — liveBridges() dropped awaitingUser

- **Confirmed the verifier's finding (run bfaa5172, verdict BROKEN).** Same defect
  CLASS as round 3's `running` drop: `public/lib/api.js` `liveBridges()` mapped each
  bridge to `{sdkSessionId, stationSessionId, busy, turnStartedAt}` and **dropped the
  server-published `awaitingUser`**. `refreshLive` builds `state.awaitingIds` from
  `b.awaitingUser === true`, so the set was permanently empty and NO row (open or
  not) ever showed the amber "waiting on you" marker in the real app. The author
  suites passed only by BYPASSING this pipeline (browser test wrote `awaitingIds`
  directly; server test read `/api/sessions` directly).

- **Sibling-field audit (as asked):** `running` verdict — already carried through by
  `liveSessions()` (round 3). `outcomes` — `agentOutcomes()` returns `r.outcomes`
  UNMAPPED, so `row`/`kind`/`dismissedAt` survive and round 3's `row==='main'` fix is
  NOT inert (re-confirmed live). **`awaitingUser` was the only remaining dropped
  field.**

- **Fix (client-only; :4317 already emits the field server-side, so a RELOAD suffices
  — no restart):**
  - `public/lib/api.js` `liveBridges()` — carry `awaitingUser: x?.awaitingUser === true`
    through the mapping.
  - `scripts/verify-feat-154-session-state-visuals.mjs` — new `__f154.pipeline()` +
    3 checks that drive the REAL pipeline (fetch shimmed for the two list routes only;
    real `api.liveSessions`+`api.liveBridges` → real `refreshLive` builds
    `state.awaitingIds` → real `sessionRow`): the amber lights on a pending question,
    running is suppressed, and no-question shows running. This closes the
    bypass the verifier flagged.

- **Verified:**
  - `npm run verify:feat-154` — **31/31** (was 28). Must-FAIL proof: reverting the
    `awaitingUser` line → the 3 round-4 checks FAIL (28/31); re-applied → 31/31.
  - `npm run verify:feat-154-await` — **5/5** (server end-to-end, real can_use_tool:
    flips true, clears on answer; isolated instance, stopped by pid).
  - `npm run verify:bug-193-list-fold` — **31/31**.
  - `npm run gate` — **exit 0** (leak-gate + check-nul + typecheck), once an ORPHANED
    untracked scratch dir `.tmp-feat154-verify/` (left by the verifying lane, run
    bfaa5172 — its `build-base.mjs`/`build-patch.mjs` carry a hardcoded absolute
    home path, the leak shape the gate rejects) is set aside; my four files are
    leak-clean. That scratch is not this lane's and
    was restored untouched — it needs removing by cleanup-owner or it will keep
    failing the public-repo gate.
  - **Live :4317 end-to-end (real data, real pipeline):** `/api/sessions` emits
    `awaitingUser` and one real session (on an unrelated private project) has a REAL
    outstanding permission right now. A fresh headless tab against :4317:
    `state.awaitingIds` =
    `["746278f6…"]` (was permanently empty pre-fix) and that NON-OPEN row renders
    `.waiting` amber, `.alive` suppressed, aria "… — waiting on you". Clears proven by
    the await-field suite (answering → awaitingUser false) + the round-4 control.

- **Restart needed?** No — client-only; :4317's server already publishes the field.


### 2026-09-29 — fixing lane (round 5): a session running only SUBAGENTS read as finished

- **Case identified (verified FIRST against live :4317): case (b).** Session
  `4ea3d0d2` had `busy:false, liveness.running:false, kind:'idle'` (main turn
  ENDED) but its running snapshot showed a LIVE background subagent
  (`row:'agent', label:'worker', state:'running', background:true`, 19 tool uses,
  last frame ~40s ago). The user's original definition — "actual running
  agents/subagents → light blue" — makes this session RUNNING. Round 3 had made
  the list read only the per-bridge `running` verdict, which reflects the MAIN
  turn only, so a turn that ended while its subagents keep working showed green
  (finished). Not case (a): the verdict was correct that no MAIN turn was in
  flight; the list was reading the wrong fact.

- **Fix (owner-declared single fact, ARCH-010; no second client derivation):**
  - `src/server/liveness.ts` — new `working` field on the `Liveness` verdict:
    `working = running || (live && hasLiveBackgroundLane())`. Stamped in a thin
    `livenessOfBridge` wrapper around the existing branch logic (renamed
    `livenessOfBridgeCore`), so every branch gets it once. `live` gates it, so a
    dead/closed/frameless bridge with a leftover lane record is never resurrected.
    `livenessWire` now publishes `working`, so every route that already uses the
    wire helper carries it with no route change.
  - `public/lib/api.js` `liveSessions()` — carry `working` through the mapping.
  - `public/app.js` `isSessionRunning()` — read `working` (fall back to `running`
    on an older server that omits it; null/absent keeps the mtime-only / degraded
    "present ⇒ running" fallback). The round-3 guarantee holds: an idle-alive
    bridge with NO live lane has `working:false` ⇒ not running.
  - `scripts/verify-feat-154-working-fact.mjs` (+`verify:feat-154-working`) — new
    OWNER-LEVEL test of the real `livenessOfBridge`/`livenessWire` with the real
    4ea3d0d2 shape; `scripts/verify-feat-154-session-state-visuals.mjs` — 3 new
    browser cases driving the real `sessionRow` for the subagent-running state.

- **Verified:**
  - `npm run verify:feat-154-working` — **5/5** (real authority: 4ea3d0d2 shape ⇒
    working=true; idle-alive no-lane ⇒ false; running main ⇒ true; dead+lane ⇒
    false; wire publishes working). Must-FAIL: strip the stamp ⇒ 0/5.
  - `npm run verify:feat-154` — **34/34** (was 31; +3 round-5). Must-FAIL: revert
    `isSessionRunning` to read `running` ⇒ the 2 round-5 subagent checks FAIL
    (32/34), control green.
  - `npm run verify:feat-154-await` 5/5; `verify:bug-193-list-fold` 31/31;
    `verify-liveness-conformance` 86/88 (the 2 fails — `L4` in
    `lanes.ts`/`runtime/claude-runtime.ts`, `L2b` needs a real runtime — are
    identical to prior rounds and name files this lane did not touch; my change is
    inside the exempt authority).
  - `npm run gate` — **exit 0** (typecheck clean with the new server field), once
    the orphaned untracked `.tmp-feat154-verify/` scratch (verifying-lane, run
    bfaa5172; carries a hardcoded absolute home path — the leak shape the gate
    rejects) is set aside. My files are leak-clean; that scratch is not this
    lane's and was restored untouched — cleanup-owner should remove it.
  - Second instance: the visuals suite spawns its own server on a free port
    running the new `liveness.ts` and boots healthy (34/34); it is stopped by pid
    afterwards. :4317 was NOT restarted.

- **Restart needed? YES (server-side).** Unlike rounds 3–4, `working` is a NEW
  field the server must emit; :4317 does not publish it until restarted, so until
  then the client falls back to `running` and 4ea3d0d2 still shows finished. The
  client half is served statically (reload); the fix only takes effect on :4317
  after a server restart (not done by this lane — would kill the orchestrator).


### 2026-09-29 — fixing lane (round 6): "7f7e39a1 is running all the time" — hypothesis REFUTED, STOPPED at a design fork

- **Build check:** `:4317` started 2026-09-29 00:58:33 and does emit `working` (the
  round-5 build). So this is not deploy lag.

- **Raw API liveness for 7f7e39a1** (`/api/sessions/live`, 13:40 local): `live:true,
  running:false, working:true, kind:'idle'`, `busy:false`, `detached:true`. Transcript
  last written 2026-09-27 22:22Z, about 36h earlier. `lastFrameAt` is the adoption instant
  (server boot), with no frame since. `/api/sessions/7f7e39a1…/running` shows
  **`running: []`**, meaning no row at all.

- **Where `working:true` comes from:** `hasLiveBackgroundLane()` is true because
  `#levelRaw` was seeded on adoption (BUG-187 B1) from the broker's declared
  `backgroundTasks`. That is 5 `local_bash` lanes (`b5tblidkz`, `bdyk8xzib`,
  `b0s9i9e1l`, `b0tfqhu9g`, `bipc0pi2p`, started 27 Sep 21:06Z to 22:07Z). None has
  a terminal frame.

- **Ground truth (host scope cgroup `claude-station-host-h-muk9tlqt-*.scope`
  `cgroup.procs`, not PPID guessing):** all 5 lanes are **live processes**, children
  of the session's CLI, with elapsed times from 1d12h to 1d13h. Each one is an
  `until grep -q 'adversarial:.*passed' "$F"; do sleep 3|5; done` **poll loop**
  whose target file is finished and will never match. The targets are the 24-byte
  `b77fwbj9l.output` (the failed outcome that lane recorded), `b25ztvzg5.output`,
  and two `/tmp/adv-*.txt` files. Their own `.output` files are **0 bytes and have
  not grown since 28 Sep 00:04 to 01:01 local**. A `sleep` child is re-spawned
  every few seconds.
  → **Verdict: not a stale record.** The engine's level is accurate and the owner
  declares a fact that is true: live background processes exist. They are **hung
  waiters that can never finish**. They are leaked `run_in_background` shells from an
  earlier lane, not agents, and the user's belief that there are "no subagents" is correct.
  **Hypothesis ("record says running, process dead") refuted.** I made no fix, as the charter requires.

- **Every session that currently reads `working:true` (5), checked against ground truth:**
  | session | why working | ground truth | UI |
  |---|---|---|---|
  | b4f45fc0 | main turn running | live turn (the orchestrator) | running, correct |
  | 4ea3d0d2 | bg agent `adaae79e…` | subagent transcript written 8 min ago; it waits on a live `dispatch.mjs` pid | running, correct |
  | f80d955f | bg agent `aaf130a6…` | subagent blocked on a **pending permission** since 28 Sep 22:57Z (broker `pendingRequests:1`, `awaitingUser:true`) | amber "waiting on you" wins precedence, correct |
  | 7f7e39a1 | 5 `local_bash` lanes | 5 live **hung poll loops** (above) | blue, and the user thinks it wrong |
  | 4846de18 | 1 `local_bash` lane | a live **dev server** (`npm run dev`, 1d23h) on another, private project | blue, same class |
  **False by process ground truth: 0/5.** False by the user's meaning ("an
  agent/subagent is actually working"): **2/5** (7f7e39a1 and 4846de18). Both are only
  `local_bash` lanes: a dev server and 5 never-ending pollers.

- **A second, concrete inconsistency found (a real defect, whichever option wins):** for an ADOPTED
  bridge, lanes seeded from the broker's level have **no running row**. The
  snapshot shows `running: []` while the list says `working`. So the user sees blue
  and has nothing to open, inspect or stop. For round 5's 4ea3d0d2 the rows existed
  because the lanes were born after adoption. The two surfaces read different facts
  (the `#agents` rows and the level), which is the ARCH-010 shape.

- **Why I stopped instead of building (a design fork, needs a project-direction call):**
  the charter's root fix, "the lane's alive fact must expire when the lane
  ends or its process is gone", is **already true** here. The lanes have not ended and
  their processes exist. What is open is *what "running" means in the list*:
  - **A: light-blue counts only AGENT lanes (`local_agent`/subagents), not
    `local_bash`.** This is the user's own words from round 1 ("actual running agents/subagents").
    The owner already classifies kind in `#levelRaw` (`'agent'|'tool'`), so `working`
    becomes `running || (live && hasLiveBackgroundAgent())`. Declared by the owner,
    with no heuristic. Cost: a legitimately running background test, with the main turn
    ended, reads green until it finishes. It could carry a secondary, non-blue cue such as
    "N background shells", which is optional.
  - **B: keep counting shells but require PROGRESS** (output growing). Rejected. It is
    a staleness heuristic, which the charter forbids, and a quiet legitimate job (a
    long build, a dev server) is indistinguishable from a hung poller by timing.
  - **C: keep `working` as is (it is truthful) and fix the visibility gap**:
    render adopted level-only lanes as rows in the running strip, so the user
    can see and stop the 5 pollers. The blue stays until someone kills them.
  - **Recommended: A + C together.** A makes blue mean what the user asked for. C removes the
    list/strip disagreement for every lane kind (it is a real defect under every option)
    and gives the user a way to stop leaked shells.

- **Things the user can do now (not done by this lane; they are not my processes):** the 5 pollers
  in 7f7e39a1's scope can be killed by pid with no loss, because their targets finished 36h ago.
  Once the engine emits the terminal frames the level drops them and `working` goes false,
  which is also a live test of the "settles when the lane ends" path.

- **Nothing changed in code.** I ran no suites, because there is no diff to test. `:4317` was untouched and I
  started no second instance.

### 2026-09-29 — explore lane (round 7): who started the 5 waiters in 7f7e39a1, and why they never die
- **Captured first, from /proc, before the concurrent kill lane acted:** pids 1980755, 2000303,
  2004663, 2016792 and 2071344. Each is a direct child of CLI 1928355, which runs under session-host
  1928342 in scope `claude-station-host-h-muk9tlqt-lpo80k.scope`. Each has stdout on
  `tasks/{b5tblidkz,bdyk8xzib,b0s9i9e1l,b0tfqhu9g,bipc0pi2p}.output`, and all five output files are
  0 bytes. The watched targets are `tasks/b25ztvzg5.output`, `tasks/b77fwbj9l.output` (two waiters),
  `/tmp/adv-confirm.txt` and `/tmp/adv-r3.txt`. Every one polls for `adversarial:.*passed`.
- **Who:** subagent `a852391c416202db5` ("Fix reply-length gate resends", worker, BUG-192), not
  the main session. Its transcript is `subagents/agent-a852391c416202db5.jsonl`. The waiters were
  started at 21:04:27, 21:17:39, 21:21:27, 21:31:07 and 22:01:56Z on 2026-09-27, during BUG-192
  rounds 2 and 3.
  **None was a `run_in_background` call.** Each was a *foreground* Bash call with a timeout of
  120 to 400s. The CLI moved each one to the background when its timeout expired ("Command did not
  complete within its Ns timeout and was moved to the background"). So WA §I "foreground Bash
  only" was followed, and the leak happened anyway: in this CLI a Bash timeout no longer ends
  a command.
- **Why the awaited text never appeared (2 causes):**
  1. The watched suite cannot finish. At 21:02:13Z the lane itself edited
     `verify-feat-085-adversarial.mjs` `payload()` so that it synchronously reads the transcript in the
     harness. The suite's own FIFO probe (J1) now blocks the harness forever before the summary line.
     This still reproduces at HEAD: exit 124 after 150s, main thread in `anon_pipe_read`.
     **Filed as BUG-204** (regressed-from BUG-192).
  2. The lane then killed the stuck suites itself with `pgrep -f verify-feat-085-adversarial | kill`
     at 21:12, 21:16, 22:08 and 22:19Z. That made each waiter's condition permanently
     unsatisfiable (`b77fwbj9l` → `[exited with code 144]`). The pattern did not match its own
     waiters, whose command line holds only the output path. It still reported "All processes cleaned
     up" (22:20Z notification), which was **false**.
  The waiters' patterns were correct for the suite's real summary line. What was missing was
  any liveness or deadline escape, which is BUG-140 cause 1 exactly.
- **Why they outlived the subagent (CLI behaviour, read from the bundled CLI 0.3.281 binary):**
  the CLI *does* have a per-agent shell reaper. In `runAgent` cleanup the stage
  `shellTasks` → `killShellTasksForAgent` kills the agent's running shell tasks. It is marked
  `keepaliveGated` and is **skipped when `isAsync && completed && !aborted && (the agent has a running
  backgrounded local_bash || keepalive reasons)`**. Rounds 2 and 3 ran as `SendMessage` resumes,
  which are async, so the skip applied. The CLI said so in the 22:20Z and 22:22Z notifications:
  *"This agent stopped with background work of its own still running. It may resume on its own when
  that work completes."* The design is deliberate: the agent is kept resumable so that a finished
  shell can wake it. **Nothing bounds that keepalive**, so a shell that never finishes is kept for the
  life of the CLI. At 22:22Z the one waiter that did end (`b54nkb3kc`) woke the agent for a
  one-line turn; the other 5 never will.
- **Why Orchard keeps the CLI alive:** Orchard has no reap path for engine background shells, and
  nothing in `src/server` issues `stop_task` for them. The BUG-043 detached-close fuse
  (`agent-bridge.ts #armDetachedClose`) holds a detached session open *indefinitely* while its
  lifetime is `yes` and the process is live. That is correct by its own charter, but here it forms a
  loop: the shells hold the host open, and the host is the only thing that would end the shells. If
  the session closed, the CLI and host scope would exit. **I did not test** whether the CLI kills its
  shells on exit or whether they die only with the scope.
- **How common, right now (host view; all 5 CLIs, including containers, are visible from the host
  pid namespace):** 6 background shells are older than 1h. 5 are these hung waiters, 37h old with
  0-byte outputs. The 6th is 4846de18's `npm run dev`, 47h old, 0-byte task output (it logs to its
  own file), and legitimately long-lived. Using "no output growth" as the orphan test would flag
  that dev server as well, which confirms round 6's rejection of option B. No other pattern exists:
  the one current dispatch-lane waiter (4ea3d0d2) is bounded (`timeout 585 … while kill -0`). Recurrence
  history: BUG-140 recorded the same shape across 10 days.
- **Verdict:** this is not expected in the sense the user means. It is a composite of known
  causes. It is **not an Orchard reaping bug**: Orchard is truthful, and "working" reflects live
  processes. Three causes combine: (1) an **agent-craft defect** (an unbounded file-poll with no
  liveness escape) that WA §I already forbids and BUG-140 already tracks as an open decision;
  (2) a **CLI behaviour** that turns the Bash timeout into a background task and deliberately skips
  reaping for an async agent that owns one, with no bound; (3) a **real suite hang** (BUG-204)
  that made the wait unsatisfiable. Direct fix: BUG-204. The class fix belongs to BUG-140. The
  new fact for it is that the tool `timeout` is not a bound, so option C ("bound every wait")
  must be written *inside the command* (`timeout N …` or a `kill -0 <pid>` escape), not left
  to the tool parameter.
- **Where "lifetime ended" should be declared (ARCH-002/ARCH-010):** the owner is the agent that
  started the shell. A lane's charter (at dispatch) already declares it turn-scoped. The smallest
  owner-declared fix: when the engine reports that a subagent *completed* (the task-notification
  `completed`) and a `local_bash` task with that agent's id is still running, Orchard issues
  `stop_task` for it. The plumbing already exists (`session-host.mjs` stop_task, `events.ts`
  round-6 stop path). This must apply only to lanes whose dispatch declared them turn-scoped;
  that is the ARCH-002 declaration. **Genuine design fork, needs the user:** stopping an ended lane's
  shells kills a *deliberately* long-lived one too, such as a dev server a lane started for the user.
  The fork is whether dispatch-declared lanes may own work-scoped shells at all. The alternative,
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in lane env (a timeout then kills the command instead of
  backgrounding it), also disables `run_in_background`/Monitor for that lane. That is a blunter
  version of the same fork.
- **Nothing changed in code.** Artifacts: BUG-204 (new), this entry, and a pointer entry on BUG-140.
  Probe files: `/tmp/feat154-*`. I killed no process of anyone else's. My suite probes ran under
  `timeout` and I confirmed they were gone.


### 2026-09-29 — fixing lane (round 6, build): background shells stop colouring the list; the strip lists them and can stop them (options A + C)

- **Decision (coordinator, from the user's round-1 definition "actual running
  agents/subagents → light blue"):** build A + C, then kill the 5 stuck pollers.
  regressed-from: FEAT-154 round 5 (its `working` counted every background lane, shells included).

- **A — `working` counts agents only (declared by the owner, no heuristic):**
  - `src/server/agent-bridge.ts` gets a new `hasLiveBackgroundAgent()`. It reads the same two
    owner sets as `hasLiveBackgroundLane()` (the engine's level plus the pre-level
    born tags), restricted by the kind the owner already records per lane
    (`'agent' | 'tool'`). `hasLiveBackgroundLane()` is unchanged, so the BUG-159
    shield behaves exactly as before.
  - `src/server/liveness.ts` now computes `working = running || (live && hasLiveBackgroundAgent())`.
    `BridgeLike` gains the optional method, and a source without it gets `working:false`
    rather than a fallback to the lane fact.
- **C — shells are visible and stoppable in the running strip:**
  - `agent-bridge.ts` keeps `#levelMeta`: the engine's `description` for each lane,
    the broker's declared `since` on adoption, or the time the lane was first seen.
    `levelOnlyLanes()` returns the lanes the level lists that have no running
    `#agents` row. That is the adopted-bridge shape which left 7f7e39a1's strip empty.
  - `src/server/running-set.ts` publishes those lanes as `running` rows
    (`row:'tool'`, `label:'background command'`, `background:true`, `startedAt`). The level
    vouches for them, so they are never stall-judged.
  - Stop goes through the existing engine path. The ws command `stop-task` (`events.ts`,
    `index.ts`) calls `AgentSession.stopTask()`, then `runtime.stopTask()`, then the SDK's
    `Query.stopTask`, which sends the engine's `stop_task`. The ids are refused unless the
    session currently lists them. A new optional `stopTask?` was added to `runtime.ts` and
    implemented in `claude-runtime.ts`.
  - `public/app.js` changes `stripModel`/`renderStrip`. A `row:'tool'` with `background:true`
    reads **"background command"** (also for a row-backed `local_bash`) and gets a small
    **stop** button with a confirm. The button sits beside the row button inside one wrapper,
    so the strip keeps one child per row (the 1s tick indexes by child). There is also an ack handler.
    `public/styles.css` adds `.lag-wrap.stoppable` and `.lag-stop`.

- **Tests (must-FAIL cases first, anchored to a synthesized pre-fix, not HEAD):**
  - **NEW `verify:feat-154-bg-shells`: 15/15.** A real server on an **isolated second
    instance** (free port, scratch data dir and store, the BUG-187 fake CLI) crosses a
    **real server restart**, so the adopted-bridge shape is real, not stubbed. It uses the
    **real 7f7e39a1 lane ids**:
    - 5 local_bash with no agent gives `working:false`, before and after adoption;
    - the 4846de18 shape (1 dev server) gives `working:false`;
    - control: a live background subagent gives `working:true`, before and after adoption;
    - control: idle-alive with no lanes gives `working:false`;
    - the adopted strip lists all 5 as "background command" with an age;
    - `stop-task` reaches the engine as `stop_task` for exactly that id, and the row leaves while 4 stay;
    - a bogus id is refused and not forwarded;
    - stopping all 5 leaves an empty strip and `working` still not true.

    Every broker, CLI and server is killed by pid; the cleanup line reports 6 pids reaped and 0 left.
    **Must-FAIL:** with the round-5 formula and no level-only rows it scores **8/15**, and
    the 7 round-6 checks go red while the controls stay green.
  - `verify:feat-154-working`: **9/9** (was 5). This adds the real 7f7e39a1 and 4846de18 stubs,
    a synthesized round-5 formula sentinel, and a "method absent means not working" case.
    **Must-FAIL:** 6/9 on the round-5 formula.
  - `verify:feat-154`: **38/38** (was 34). This adds the real strip, driven through real
    `onEvent` → `applySnapshot` → `renderStrip`: 5 rows labelled "background command",
    each with an age and a stop control; stop sends `stop-task b5tblidkz`; a local_bash row
    reads "background command"; control: a subagent row keeps its label and has no stop.
    **Must-FAIL:** 35/38 with the strip change reverted.
  - Anti-regression: `verify:feat-154-await` 5/5; `verify-bug-193-list-fold` 31/31;
    `verify-feat-118-ui` 15/15; `verify-feat-073-new-session-row` 12/12;
    `verify-bug-083-project-switch-state` 10/10.
  - `verify-liveness-conformance` is 86/88. It fails the same `L4` (lanes.ts pidAlive,
    claude-runtime `isOwnerLive`) and `L2b` as rounds 3 to 5. Neither is new code.
  - **Pre-existing reds, proven against a baseline** (a scratch copy with the round-6
    formula, level-only rows and strip change neutralised, since removed):
    - `verify-stall-detector` gives 22/33 on both trees;
    - `verify-bug-106-crossproject-strip` gives 32/33 on both (the permission-seal chip);
    - `verify-running-snapshot` gives 23/45 here (killed by my 400s timeout) and 25/47 on the baseline, both failing the same way:
      the precondition "server snapshot has main + 3 agents" fails, and the fake session never starts;
    - `verify-stale-agent-cards` hits FATAL "session never initialised".

    These older fake-CLI suites do not get a session started on this tree. That is not caused by round 6.
  - `npm run gate`: **exit 0**.
  - Real-page screenshots of the strip in both themes: `docs/bugs/assets/FEAT-154-r6-strip-{light,dark}.png`.
    In the shot the first row's stop is greyed because the test had just clicked it.

- **The 5 pollers on 7f7e39a1 were killed (with the user's authorisation via the coordinator).** Before killing,
  I re-confirmed each PID in the host scope `claude-station-host-h-muk9tlqt-*` (PPID
  = the session's CLI). Each cmdline is the `until grep …; do sleep` loop, and each
  stdout is that lane's own `.output` file, **0 bytes**:
  | PID | lane |
  |---|---|
  | 1980755 | b5tblidkz |
  | 2000303 | bdyk8xzib |
  | 2004663 | b0s9i9e1l |
  | 2016792 | b0tfqhu9g |
  | 2071344 | bipc0pi2p |

  I sent SIGTERM to each PID individually, not to a group or by name, and all 5 were gone within 3s. The
  4846de18 dev server was left alone. **Live result on :4317:** the engine emitted the
  terminal frames, the broker's `backgroundTasks` went `[]` with `backgroundLifetime:"no"`,
  and **7f7e39a1 now reads `working:false`**. That is the settle-on-end path, proven on the real session.

- **Restart needed? YES, for the server half.** A (agents-only `working`) and C (level-only rows
  plus `stop-task`) are server code. Until :4317 restarts:
  - 4846de18 still reads blue, because its dev server is a shell;
  - the strip does not list adopted shells;
  - the stop button, which is client-only and live on reload, can only target row-backed lanes and gets a refusal from an old server,
    which ignores the unknown `stop-task` command.

  I did not restart :4317.

- **Untested / limits:**
  - `stop-task` against the REAL CLI (the fake speaks `stop_task`, and the SDK
    `Query.stopTask` is the documented control) is untested;
  - no human visual review beyond my own screenshot check;
  - the strip clock prints long ages as `2291:24` (minutes:seconds, the existing formatter);
  - the collapsed summary still says "N agents running" for shells.
  - Worth an independent verify: this touches the liveness authority and a new
    control path (session-lifecycle class).


### 2026-09-29 — verifying lane (round 2): clean-room adversarial (rounds 5–6) — VERDICT BROKEN

- **Verified-by:** dispatch anthropic/claude-opus-5-5 run
  `234fa2ac-582f-469c-b795-25213d933f21` (clean-room, `scripts/independent-verify.mjs`)
  — VERDICT: **BROKEN**. SAME-PROVIDER (Claude verifying Claude; decorrelation
  reduced) because OpenAI was rate-limited at run time; an OpenAI/Codex
  cross-provider pass is still warranted once quota returns.

- **How run (ARCH-010 clean room, hunk-isolated):** the 10 round-5/6 files carry
  heavy unrelated WIP (BUG-196, FEAT-155, FEAT-156, BUG-194/195). The round-5/6
  hunks were isolated into a git RANGE `base..head` built as dangling commits (no
  ref, no working-tree write, no git-index touch): `head_tree`
  `258faa0a` = the full runnable working tree; `base_tree` `68f3561a` = the same
  tree with ONLY the FEAT-154 r5/r6 hunks reverse-applied. `git diff base..head`
  = exactly **234 insertions / 7 deletions** across the 10 files, with ZERO
  BUG-196/FEAT-155/FEAT-156/BUG-194/BUG-195 tokens (verified). The verifier saw
  only the requirement + that diff + the 4 author test scripts + run commands —
  no ticket prose, no fixer reports (docs stripped from the room).

- **The `working` fact (rounds 5/6 core) HOLDS — strongly.** Re-ran the author
  suites and two fresh adversarial suites over a REAL isolated server across a
  REAL restart:
  - `verify:feat-154-working` **9/9** (real 4ea3d0d2 / 7f7e39a1 / 4846de18 shapes:
    subagent-running ⇒ working; shell-only + dev-server-only ⇒ NOT working; dead
    process + leftover lane ⇒ NOT working; round-3 idle-bridge ⇒ NOT working;
    wire publishes `working`).
  - independent `adv-f154.mjs` **9/9** across adoption/restart: monitor-lane-only
    and started-but-unlisted-bash-lane ⇒ not working; two subagents + shell ⇒
    working; one of two subagents ends ⇒ still working; **last subagent ends while
    shell lives ⇒ working CLEARS** — all identical pre- and post-restart.

- **REAL DEFECTS (round-6 STOP control, option C — the "stop really stops it +
  strip updates" requirement is inert in the case round 6 was built for):**
  - **[high] Stop is a no-op for a shell in a session the tab does not DRIVE** —
    e.g. an adopted bridge after a restart (7f7e39a1's leaked pollers) whose strip
    is filled by the 4s `/api/sessions/:id/running` HTTP poll, not a ws session.
    The strip renders the stop control, but `stop-task` hits
    `src/server/index.ts` `case 'stop-task'` → `if (!session) … 'no session on
    this socket'`; the engine never gets `stop_task` and the shells stay in the
    strip. (run `ea26ca3cfeed`, checks 7a + strip-drop.) This is exactly the
    adopted-bridge shape option C targets.
  - **[medium] `stop-task` carries no session id** — routed only to the socket's
    attached session, so a stop aimed at another session's shell is refused with
    "that task is not running in this session" (`AgentSession.stopTask`). (run
    `ea26ca3cfeed`, check 7b.)

- **Could NOT test (honest gaps, handoff):** scenario 10 (real Claude CLI
  `stop_task` — only the fake CLI answered; SDK `Query.stopTask` confirmed
  declared in sdk.d.ts); whether the real CLI re-emits `background_tasks_changed`
  on a repeated initialize (if NOT, the adoption seed at agent-bridge.ts:1637/1643
  defaults non-`local_bash` + every `startedTasks` id to 'agent' ⇒ `working:true`
  until a level frame arrives — the fake always re-emits the level, masking it);
  scenarios 1 & 3 (SIGKILL of a CLI with a live lane; resumed/async revived
  subagent) end-to-end — only the stubbed dead-probe unit case covers them; the
  Chromium/CDP `verify:feat-154` browser suite was not run in the room (whether
  the rendered stop button gets stuck disabled after the non-ack error reply is
  inferred from app.js, not seen in a browser).

- **Recommendation:** BROKEN stands on the stop path; the `working`
  reclassification (the round-5/6 headline) is verified sound. Fix the two stop
  findings (route stop-task by session id / allow stopping a viewed-not-driven
  adopted bridge, and update the strip on success) before VERIFIED. Independent
  re-verify (ideally OpenAI cross-provider) warranted after the fix — this is a
  session-lifecycle + new-control-path class change.


### 2026-09-29 — fixing lane (round 7): stop is addressed by (session, task) and routed to the owning bridge

- **Fixes the verifying lane round 2 findings (run 234fa2ac):**
  - [high] stop did nothing for a shell in a session the tab does not drive (an adopted bridge);
  - [medium] `stop-task` carried no session id.

  regressed-from: FEAT-154 round 6. The ws-only stop could reach only the socket's own attached session.
- **Root fix:**
  - The ws command `stop-task` is **removed** from both `src/server/index.ts` and `events.ts`, so
    there is one stop path, not two.
  - New route `POST /api/sessions/:sessionId/running/:taskId/stop` (`src/server/index.ts`).
    It resolves the OWNING bridge with the same dual lookup (station or SDK id) as the
    running-set GET, whether or not any socket is attached. It then calls the round-6
    `AgentSession.stopTask`, which sends `Query.stopTask` and so the engine's `stop_task`.
  - Answers are explicit:
    | status | body | meaning |
    |---|---|---|
    | 200 | `ok:true` | the engine accepted the stop |
    | 404 | `reason:'no-bridge'` + a plain sentence | the bridge is gone |
    | 409 | `reason:'not-running'` | the task is not running in that session, including a cross-session aim |
    | 501 / 502 | — | the engine cannot stop the task, or errored |
  - The route has an Origin + JSON content-type guard, because it is destructive (403 / 415).
  - `public/lib/api.js` gets `stopTask(sessionId, taskId)`, which never throws and returns `{ok, reason, error}`.
  - `public/app.js`: the strip's stop addresses the session the **strip's snapshot** is about
    (`state.snap.stationSessionId || sdkSessionId`), never the socket. On success it polls the snapshot again.
    On failure it re-enables the button and says so plainly on the error line. For `no-bridge` the message is
    "this server is no longer driving that session (it may already have ended) — reload to refresh".
    I removed the ws ack handler.

- **Tests (must-FAIL cases first):**
  - `verify:feat-154-bg-shells`: **19/19** on an isolated second instance across a real restart, with no socket
    attached to anything. The new checks:
    - an adopted bridge, stopped by station id, reaches the engine's `stop_task`, and the row leaves;
    - a non-open session, stopped by SDK id, reaches THAT engine, and its strip empties;
    - a wrong-session aim gets 409 and is forwarded to no engine;
    - an unknown id gets 409;
    - a gone bridge (S4 ended at the restart) gets 404 `no-bridge` with a plain sentence;
    - a foreign Origin gets 403 and text/plain gets 415, and neither reaches the engine.

    **Must-FAIL:** with the route disabled it scores **11/19**. The 8 stop checks go red and the `working` and strip checks stay green.
  - `verify:feat-154`: **40/40**, driving the real strip with the socket NULL (a viewing tab). The new checks:
    - stop POSTs JSON to `/api/sessions/<the strip's session>/running/<task>/stop`;
    - with a socket attached to a DIFFERENT session, the stop still names the strip's session;
    - a 404 `no-bridge` reply puts a plain error on the error line and the button is usable again.

    **Must-FAIL:** with the round-6 ws send restored it scores **37/40**, and the 3 round-7 checks go red.
  - **REAL CLI, `verify:feat-154-real-stop` (NEW): 8/8.** It uses the real `claude` binary, model haiku,
    on an isolated second instance with its own config dir.
    - The model launched `sleep 900; echo <marker>` with `run_in_background`.
    - I restarted the server, and the session was **adopted** with no socket attached.
    - The strip listed it as `background command`, with `working:false`. This also shows that the real CLI re-declares its level on the repeated initialize, and classifies the shell as a shell.
    - Stop through the real HTTP API returned 200.
    - **By PID ground truth**, both the bash wrapper and its `sleep 900` child were gone. They were found by
      /proc cmdline marker plus ancestry under the session's CLI pid. The row left the strip.
    - The session CLI itself stayed alive.
    - I ran it twice, 8/8 both times. There were no orphaned `sleep 900`, and cleanup found 0 pids left alive.
  - `verify:feat-154-working` 9/9; `verify:feat-154-await` 5/5; `verify-bug-193-list-fold` 31/31.
  - `verify-liveness-conformance` is 86/88, with the same pre-existing `L4` and `L2b` as rounds 3 to 6.
  - `npm run gate`: exit 0.
- **Restart needed? YES.** The new route is server code. Until :4317 restarts, a stop from the
  reloaded client gets 404 from the old server, and the UI shows the "no longer driving that session"
  message, which is misleading only on an old server.
- **Untested:**
  - stopping a background AGENT through this path (the control is only rendered for shells);
  - a survivor the server has NOT adopted (it answers 404 `no-bridge`, and the broker's own
    `stopLane` is not exposed to the server);
  - no human visual review.
- An independent re-verify is warranted, because this is a session-lifecycle control path.


### 2026-09-29 — fixing lane (round 8): opening a finished session turned it blue for 30s (the FEAT-144 mirror counted as a writer)

- **User report** (session `6927511d`, the user's own dashboard orchestrator session): (1) after the
  restart it was missing from the nav list and was found only through search; (2) after opening it,
  it showed blue "running" although it had "already finished".
- **Build check:** `:4317` started 16:16:41 local. `/api/sessions/live` emits `working`, and the
  running snapshot lists level/agent rows. It is the round 5–7 + BUG-193 build.
- **Raw fields for 6927511d (16:42 local):** `busy:true`, `liveness {live:true, running:true,
  working:true, kind:'ok'}`, `awaitingUser:false`. The list row has `foldByDefault:false`,
  `startedBy:'user'`. The provenance record is `{startedBy:'user', source:'agent-bridge'}` and has
  not changed since 2026-09-28. Process: broker 2437220 and CLI 2437230 both started at **16:30:31**.
  The running snapshot shows `main` running plus the foreground worker `ac05fe74…` ("OpenAI
  clean-room verify FEAT-156"), which had 66 tool uses and was still writing at 16:46.
- **Symptom 2, hypothesis check:**
  - **"Opening spawned a bridge": REFUTED.** The bridge was spawned by the user's own message. The
    journal shows the SDK spawn at 16:30:31, and the transcript enqueues "openai is avaialble go
    ahead" at 16:30:33.9. Opening is read-only: no ws attach and no process. The second-instance
    probe confirms this (0 bridges, 0 child processes after a deep-link open).
  - **"In-flight flag never cleared" / "replayed tail" / "subagent with no end event": REFUTED.** The
    blue at report time is **true**. A real turn is in flight: the Agent tool_use `toolu_01QhDr…`
    has no tool_result, and its subagent is live.
  - **REAL DEFECT FOUND (the blue on open):** `GET /api/transcript` calls FEAT-144
    `mirrorClaudeStore` on every read. The mirror lives under `dataDir/transcripts/anthropic/`, and
    `watcher.orchardLiveSessions()` scanned **every** provider root, the Claude mirror included. So
    any open that copied bytes gave the mirror a fresh mtime. The session then appeared in
    `/api/sessions/live` as an mtime-only row (`liveness:null`), and `isSessionRunning` reads that as
    running. The result is blue for the whole 30s window.
  - Every finished session triggers this. After a turn-end mirror, the CLI appends trailing lines,
    so the mirror lags: 6927511d's real mirror is 492878 bytes against a 524911-byte source, and
    `5d64cec5`, `1667b746` and `fe692214` lag too. Sessions that have no mirror yet (most of the
    307 in this dir) get one created on first open.
  - **Reproduced live on :4317** without a browser. `GET /api/transcript/…/5d64cec5…?limit=1` on a
    session finished on 2026-09-23 immediately gave `/api/sessions/live` a row
    `{provider:'anthropic', drivenByDashboard:false, liveness:null, ageMs:22}`. The row was gone 35s
    later.
  - For 6927511d: when the user opened it before sending, its lagging mirror was appended, so it went
    blue. Two seconds after the send it was genuinely running. That is why the user saw "blue since
    opening".
  - regressed-from: FEAT-144 (mirror-on-read, `index.ts` transcript route) combined with FEAT-037
    P2b (`orchardLiveSessions` scanning all provider roots).
- **Fix (ARCH-010, at the owner of the store layout):**
  - `src/server/orchard-transcripts.ts`: new `engineWrittenRoots()`, which is `providerRoots()`
    minus `CLAUDE_MIRROR_PROVIDER`. These are the roots a running ENGINE appends to (the FEAT-037
    recorder).
  - `src/server/watcher.ts`: `orchardLiveSessions()` now reads `engineWrittenRoots()`. The mirror
    stays listable and readable through `providerRoots()`. A Claude session's live writer, the CLI
    store, is still scanned directly.
- **Tests:**
  - **NEW `verify:feat-154-open`** (`scripts/verify-feat-154-open-not-running.mjs`): **14/14**. It
    uses the REAL 6927511d transcript and an isolated second instance (own
    `CLAUDE_STATION_DATA` + `CLAUDE_PROJECTS_DIR`, free port, process group killed, "stopped"
    confirmed). The real app.js is booted in happy-dom on the user's exact deep-link shape (`&i=31`).
    Checks:
    - A: the open DID write the mirror (non-vacuity), yet there is no live entry, the list row
      is not live, the client resolves `finished` rather than running, and the row has no `.alive`;
    - B: a lagging mirror is appended by a read (285634→524911 bytes) and the session is still not live;
    - C: control, an append to the Claude store file IS live and the client reads it as running;
    - D: control, a fresh `openai` engine-written transcript is still live;
    - E: sentinel, the synthesized pre-fix scan (all roots) lists the opened session as live.
    - **Must-FAIL:** reverting `engineWrittenRoots` to `providerRoots()` scores **8/14**. The 6
      fails include client `life=running` and the live entry. Restored afterwards: 14/14.
  - Anti-regression, all exit 0: `verify:feat-154` 40/40 (round 3's idle bridge is not blue; a
    live subagent is blue); `verify:feat-154-await` 5/5; `verify:feat-154-working` 9/9;
    `verify:feat-154-bg-shells` 19/19; `verify-bug-193-list-fold` 31/31 (the folds hold);
    `verify-bug-085-sidebar-cap` 11/11; `verify-feat-144-claude-mirror` 22/22 (the mirror still lists
    and reads pruned sessions).
  - `verify-liveness-conformance` 86/88, with the same pre-existing `L2b` + `L4` fails
    (`lanes.ts`, `runtime/claude-runtime.ts`), and neither file was touched.
  - `npm run gate`: exit 0.
  - `verify:feat-154-real-stop` was NOT run: it spends real-CLI turns, and this round did not touch
    its path.
- **Symptom 1, list visibility:** **NOT the BUG-193 fold.** The row has `foldByDefault:false` and
  the user-started provenance, so a fold would have been WRONG, because this is the user's own
  session. It is not paginated either: the API returned all 656 rows.
  - I ran the REAL `visibleSessions` (happy-dom) over the real list, with each recent transcript cut
    at 13:17Z, 13:25Z and 13:30Z through the real `readSessionMeta`, plus the user's real
    `cs-seen` map read from the browser profile. In every variant 6927511d is **shown**, at seat
    5–6 of the 6-seat BUG-085 budget. That is the bottom of the default list: it is visible, but one
    more competing row would fold it under "N more". Its recency key was the injected "[station]
    While you were away" message at 09:29:54Z.
  - **I could not reproduce it hidden.** The seen map before T is unknowable, because the stored map
    holds only current values. No defect is claimed and no fix was made for symptom 1. The
    likeliest reading is that it sat last in the cap window.
- **Restart needed: YES** (server code). Until then, opening a finished session still flashes blue
  for about 30s.
- **Untested:** a human-eye check of the user's own tab. The multi-tab case is covered only by the
  server fix, which applies to every tab.
- **Independent verify warranted:** session-lifecycle / liveness class.

### 2026-09-29 — verifying lane (round 3, clean-room adversarial): round-8 fix is BROKEN for native Codex

- **Verified-by:** dispatch anthropic/claude-opus-5-5 run `f195fc23-0a08-4f41-aa5b-2b0e76327f05`
  (clean-room, `scripts/independent-verify.mjs`) — **VERDICT: BROKEN**. Same-provider verify
  (author-provider anthropic): OpenAI was rate-limited, so cross-provider decorrelation was reduced —
  noted per WA. Isolated diff handed to the verifier was the round-8 hunk ONLY (2 files,
  `src/server/orchard-transcripts.ts` +26, `src/server/watcher.ts` +5/-2), split off the dirty tree
  via two dangling trees (real index untouched) so the room still boots the full server.
- **Requirement checked:** opening/viewing a finished session (which copies the transcript into
  Orchard's own store) must never make it read running; a genuine new turn must still read running
  promptly.
- **DEFECT (severity: high — the ticket's own bug, un-fixed for one engine):** opening a finished
  NATIVE Codex session reads as running for the ~30s window. The transcript route imports a native
  Codex rollout via `cn.importNativeCodexSession` (index.ts:1899-1902) into
  `orchardTranscriptFile('openai', …)` (codex-native.ts:480) with a FRESH mtime, and
  `engineWrittenRoots()` excludes only `CLAUDE_MIRROR_PROVIDER` (`anthropic`) — so the `openai` root
  is still scanned by `orchardLiveSessions()`. The round-8 fix excludes the mirror by PROVIDER NAME,
  but an Orchard-written copy-on-open also lands in an ENGINE root. Confirmed against real code (not
  just the verifier's fixture). Adversarial run `52e9c6c64633` exit=1: `FAIL open: … LISTED AS LIVE
  after merely opening it`, `FAIL open: list row not live — live=true` (3 passed, 2 failed).
- **What HELD:** the Claude-mirror path passed every required attack — adversarial run
  `d7858018f080` **11/11**: 5 finished sessions opened at once (one ~18 MB), open during a real
  turn (the real turn stayed live — not masked), source growing under concurrent mirroring, open
  from search, and server restart right after open. So the round-8 change is correct for its target
  (`anthropic` mirror); it is simply incomplete.
- **Fixer test re-run:** `verify-feat-154-open-not-running.mjs` (run `606d2f3a0be6`, run
  `26bc83c28eb2`) exits 1 "real artifact missing" IN THE CLEAN ROOM — the suite keys the real
  6927511d transcript off the cwd-derived store path, which does not exist in the room. This is a
  sandbox limitation, not a defect and not a failed break attempt.
- **Could not test:** open with a LIVE background subagent (would need to guess the CLI subagent
  on-disk layout; the diff does not touch subagent liveness); the Codex break was proven server-side
  only (`/api/sessions/live` + list row), not through the happy-dom client running marker; the search
  case hit `/api/search` before a normal read rather than following a search deep link through the
  client; the author's happy-dom client assertions could not be re-run (real transcript absent).
- **Suggested remedy (NOT applied — verify lane):** the live scan must exclude any root Orchard
  itself writes on open, not just the anthropic mirror — e.g. treat the import-on-open copy the same
  way as the mirror, or key liveness off the ENGINE's own store rather than Orchard's copy.


### 2026-09-29 — fixing lane (round 9): every Orchard-side transcript write is declared in one place; the live scan reads that

- **Fixes the verifying lane round 3 finding (run f195fc23, HIGH).** Opening a finished NATIVE Codex
  session read as running for about 30s. The transcript route's `importNativeCodexSession` wrote the
  rollout into the `openai` root with a fresh mtime, and round 8's `engineWrittenRoots()` excluded
  only `anthropic`.
  - regressed-from: FEAT-154 round 8. Excluding one directory by provider name was the per-engine
    list shape, and the import landed in an engine directory.
- **Root fix (ARCH-010):** new `src/server/own-writes.ts`, the ONE declaration of transcript writes
  Orchard makes itself.
  - Every Orchard-side write runs inside `asOrchardWrite` / `asOrchardWriteAsync`. The wrapper
    records the file's resulting (mtime, size) plus the last ENGINE write time the file had before.
  - The live scan reads `lastEngineWriteMs(file, stat)`, never the raw mtime. Three call sites in
    `src/server/watcher.ts` use it: `liveSessions`, `sessionFileFacts` and `isSessionLive`.
  - While the file stands exactly as Orchard left it, the answer is the engine's last write, or null
    if Orchard created the file. The first append by anything else makes the raw mtime the answer
    again, so a genuine turn reads as running on its first write.
  - The engine path (`TranscriptRecorder`) deliberately does NOT use the wrapper, so a new engine
    counts as live by default. There is no per-engine or per-directory list.
  - Round 8's `engineWrittenRoots()` is **removed**. `orchardLiveSessions` scans every provider
    root again.
- **Every Orchard-side transcript writer found, all now wrapped:**
  - the FEAT-144 Claude mirror, on open/view AND at turn end (`orchard-transcripts.ts`
    `mirrorClaudeStore`);
  - the FEAT-078 native-Codex import, on open AND on resume (`codex-native.ts`
    `importNativeCodexSession`);
  - rename and pin, which are SDK appends to the Claude store (`session-mutations.ts` `rename` /
    `setPinned`);
  - the fork's cross-dir staged copy (`fork.ts`).
  - Checked and NOT transcript writers:
    - provenance (`dataDir/session-provenance`), snapshots/backups, outcomes, audit logs, tickets and
      the ARCH-003 residency log: none are in a scanned store;
    - delete: it removes the file.
  - Side effect fixed by the same change: a rename followed by a pin within 30s is no longer refused
    as "session is live". That 409 read the raw mtime through `isSessionLive`.
- **Tests:** `verify:feat-154-open` (`scripts/verify-feat-154-open-not-running.mjs`) now has
  **24/24** checks, on an isolated second instance (own DATA, projects store and `CODEX_HOME`; process
  group killed; confirmed stopped). Real artifacts: the 6927511d transcript, plus a REAL native Codex
  rollout discovered at runtime; the only rewrite is `session_meta.cwd`, pointed at the scratch
  project. Either one missing makes the suite fail loudly.
  - A/B (Claude): first open and lagging mirror. Both wrote the mirror (non-vacuity), both show no
    live entry, and the real client reports not running.
  - F (Codex open): the import happened (non-vacuity), there is no live entry, the list row is not
    live, and the client resolves `life=null`.
  - G (genuine Codex turn): an engine append is live on the very next poll, and the client reads it
    as running.
  - H (in-process, real wrapper + real scan): declared rename and pin appends are not live, the next
    engine append is, and an Orchard write never hides a recent engine write.
  - C (control): a CLI append to the Claude store is live and running.
  - E (sentinels): the synthesized pre-round-8 formula lists both opened sessions as live, and the
    round-8 formula still lists the Codex one.
  - **Must-FAIL:**
    - On the round-8 code the suite scored **19/24**: F×3 failed with `life=running`. (The two H fails
      in that run were a server-level rename that the SDK store-address check refused. That check was
      replaced by the in-process H.)
    - With `lastEngineWriteMs` reverted to the raw mtime it scores **15/24**: A×4, F×3, B and H fail.
      Restored afterwards: 24/24.
  - The SDK rename/pin was not driven end-to-end. It addresses the store by cwd, which would reach
    outside the scratch store. The wrapper contract is covered by H instead.
- **Anti-regression (all exit 0):**
  - FEAT-154 suites: `verify:feat-154` 40/40, `-await` 5/5, `-working` 9/9, `-bg-shells` 19/19;
  - list and sidebar: `verify-bug-193-list-fold` 31/31, `verify-bug-085-sidebar-cap` 11/11;
  - writers now wrapped: `verify-feat-144-claude-mirror` 22/22, `verify-feat-078-native-codex`
    36/36, `verify-feat-155-workspace-root` 80/80;
  - `verify-codex-runtime` 54/54.
  - `verify-liveness-conformance` is 86/88, with the same pre-existing `L2b` and `L4` fails
    (`lanes.ts`, `runtime/claude-runtime.ts`). `own-writes.ts` trips no guard pattern.
- **`npm run gate`: exit 1. The typecheck and check-nul pass; the leak-gate fails on 1 hit in a file
  that is not this lane's.** The hit is in the untracked `scripts/verify-feat-156-leak-gate-own-project.mjs`:336
  (`[secret assignment]`), under a `leak-tokens.mjs` that changed during this run (token-list sha
  27d7d7d4 → e0271e2a). This is concurrent FEAT-156 work. The files from rounds 8 and 9 have 0 hits.
- **Restart needed: YES** (server code). An independent re-verify is warranted, because this touches
  the liveness input.

### 2026-09-29 — verifying lane (round 4, clean-room adversarial): round-9 own-writes ledger is BROKEN at the edges the suite never models

- **Verified-by:** dispatch anthropic/claude-opus-5-5 run `c6633ec7-6f03-4d63-87cb-ac5a616e84b3`
  (clean-room, `scripts/independent-verify.mjs`) — **VERDICT: BROKEN** (VALID, manifest-backed).
  Same-provider verify (author-provider anthropic): OpenAI was rate-limited, so cross-provider
  decorrelation was reduced — noted per WA.
- **Isolated diff handed to the verifier:** the round-9 hunk ONLY — 6 files, `own-writes.ts` (+115,
  new), `watcher.ts`, `orchard-transcripts.ts`, `codex-native.ts`, `session-mutations.ts`,
  `fork.ts` (13,542 bytes total) — split off the dirty tree via two dangling trees
  (`fb5e6927..d012e863`, real index untouched, node-spawned git per tree-snapshot.mjs), so the room
  still boots the full server. No ticket prose given; the requirement + the minimum attack list only.
- **Requirement checked:** no Orchard-side transcript write (mirror on open/turn-end, native-Codex
  import, rename/pin, fork copy, or any other) may make a session read as running; a genuine engine
  write must still read running promptly, INCLUDING when it coincides with an Orchard write to the
  same file.
- **DEFECTS (adversarial run `605e88e9b788` exit 1, 5 broken; each confirmed against the real
  `own-writes.ts` before/after + CAP logic, not only the verifier's fixture):**
  - **HIGH — a coincident engine write is masked (the requirement's explicit "coincides with"
    case).** If the engine appends to the same transcript while `asOrchardWrite`/`asOrchardWriteAsync`
    is open (a rename/pin during that session's live CLI turn), `after()` stamps the combined
    (mtime,size) with the OLD engine time, so the next poll reads the running session as NOT live for
    up to the ~30s window. This is the "Honest limit" the `own-writes.ts` header itself admits — but
    the requirement demanded that case, and for a NON-driven session (its only liveness signal is the
    transcript scan) nothing clears it until the next engine append.
  - **MEDIUM — an Orchard-only async write reads as RUNNING mid-flight.** `asOrchardWriteAsync`
    records only in `finally`, after the `await`. A liveness poll during the SDK write sees the fresh
    mtime with no ledger stamp yet, so `lastEngineWriteMs` falls back to the raw mtime → live=true.
    A pure rename/pin then reads running for the duration of the SDK write.
  - **MEDIUM — an Orchard write within ~30s before a server restart reads as RUNNING after it.** The
    ledger is in-memory only; after restart there is no stamp, so the raw (recent) mtime is used. The
    header's claim that "every file Orchard wrote before it is older than the window anyway" is false
    for a write made just before the restart.
  - **LOW — CAP (20,000) eviction re-exposes an evicted file.** After a file's stamp is evicted,
    a second Orchard write to it within 30s of the first treats the earlier Orchard mtime as an
    engine write → live. The header's "a stale stamp only ever falls back to the raw mtime" is
    exactly the path that shows the session running. Needs heavy file churn; real but narrow.
  - (A 5th check, "engine write immediately preceding the Orchard write inside the wrapper", also
    reported live=false; it is the same class as the HIGH finding and may be partly fixture timing.)
- **What HELD:** the fixer's own suite re-run in the REAL repo (this lane, not the clean room) is
  **24/24, 0 failed**, server process-group stopped — so round 9 is correct for every case the suite
  models (Claude open A/B, Codex open F, genuine Codex turn G, the in-process own-writes contract H,
  control C, and the E sentinels). The defects above are ADDITIVE edge cases the suite never
  exercises, not a regression of the shipped behaviour.
- **Fixer test re-run (in the clean room):** `verify-feat-154-open-not-running.mjs` (run
  `c922b5408b26`) exits 1 "real artifact missing" — the suite keys the real 6927511d transcript off
  the cwd-derived store path, absent in the room. Same sandbox limitation as round 3; not a defect
  and not a failed break attempt. The baseline was instead confirmed by re-running it in the real
  repo (24/24, above).
- **Could not test (verifier's UNTESTED list):** the real happy-dom client / HTTP routes / a real
  Codex rollout (cases A–G) — the real transcript is absent from the room; the real SDK
  `renameSession`/`tagSession` internals (the async race was modelled with `fs.promises.appendFile`
  + `setImmediate`, not the SDK's real event-loop timing); fork continuation and native-Codex import
  end-to-end (only the shared own-writes mechanism they route through was attacked); writers that go
  through the SDK or a separate process (Claude CLI, `session-host.mjs`) were grep-checked, not
  traced at runtime into scanned roots.
- **Recommendation (NOT applied — verify lane):** back to fixing. The before/after (mtime,size)
  ledger cannot satisfy "a coincident engine write still reads running" — the coincident case and the
  in-flight/restart cases all come from stamping AFTER the write and trusting an in-memory record.
  Consider keying liveness off the ENGINE's own store/recorder rather than a mtime the Orchard write
  also moves, or having the wrapper record the pre-write engine mtime AND re-check the byte range it
  itself wrote (so an interleaved engine append is not attributed to Orchard).

### 2026-09-29 — filing lane: round-4's 4 findings filed as a standalone design-class ticket

- Filed **BUG-207** (`docs/bugs/BUG-207-session-running-still-derived-from-transcript-mtime-not-liveness-authority.md`,
  plan+review) for the recurring class behind rounds 8–9: `watcher.ts` infers `running` from
  transcript mtime, a second authority beside `src/server/liveness.ts` (ARCH-001), instead of
  asking it. Carries the round-4 HIGH/MEDIUM/MEDIUM/LOW findings as acceptance cases and a
  design fork (keep patching the ledger vs. route Orchard-run sessions through the liveness
  authority vs. other). No code changed here; this round stays open pending that ticket's
  design decision and fix.
