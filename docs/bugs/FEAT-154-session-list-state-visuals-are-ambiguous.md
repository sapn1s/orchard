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
