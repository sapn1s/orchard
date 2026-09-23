# BUG-178 — the queued-message chip hides a 20-minute wait behind a foreground subagent

- **Status:** OPEN — round-4 fix built (round-3 REFUTED on the level-frame race and repaired), awaiting independent verification
- **Severity:** medium
- **Area:** composer / dock (queue chip)
- **Reported:** 2026-09-09 by orchestrator (real incident)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
The user typed a message to a busy session and the dock chip said, verbatim:

> 1 queued message · Claude is working — delivers at the next pause · restored after a reload, still unsent

The session's main loop was inside a **foreground** `Agent` subagent that ran
20+ minutes. "The next pause" was 20 minutes away, and the chip gave no way to
know that. The user reasonably concluded the session was wedged.

## Repro
1. Drive a session into a long-lived foreground tool call (an `Agent` subagent
   run in the foreground; or any single tool call lasting minutes).
2. While it runs, type a message and let it queue behind the busy turn.
3. The chip reads "Claude is working — delivers at the next pause" with no hint
   that the pause is minutes away and no honest escape.

## Expected
The chip tells the truth about **why** the message is waiting and roughly **how
long** it may wait — "waiting on a 20-minute subagent" must read differently
from "waiting a couple of seconds" — and offers an honest escape whose cost is
stated at the point of action.

## Why it happens (verified mechanics — SDK 0.3.220 / CLI 2.1.263)
- A queued user message reaches the model only at the next model-invocation
  boundary, i.e. after the current in-flight `tool_result`.
- A foreground subagent is ONE tool call lasting minutes → the boundary is far.
  Measured: pushed at +25s, model first reacted at +104s, after the subagent's
  result at +100s.
- An ordinary tool chain hits a boundary every few seconds → the message lands
  promptly (pushed +16.7s, answered +32.3s, after 2 of 12 calls).
- A background subagent ends the parent turn immediately → the message lands at
  once (this is `idleBehindBackground()`, already captioned honestly).
- There is NO non-destructive way to inject into a running turn. `interrupt()`
  is the only reach-in and it ABORTS — killing the in-flight subagent's work.
  Per BUG-174 an interrupt with a pending permission card also produces a false
  "user-rejected".

## The fix (client-only — public/app.js, public/styles.css)
The chip already branches on `idleBehindBackground()` (the background strand).
The gap was the **foreground** case: a genuinely-running main turn whose
boundary is far because a non-`main` running row (a subagent or a long tool
lane) is in flight. That state is fully derivable on the client from the
server's own snapshot: `dockSnap().turn.running !== false` AND a
`snap.running` row with `row !== 'main'`, whose `startedAt` gives the honest
elapsed.

- New `foregroundWait()` reads that state and returns the oldest lane's label +
  `startedAt`.
- The busy branch of the dock chip now, when a foreground lane is in flight,
  NAMES the lane and shows its live elapsed (updated by the existing 1s strip
  ticker) instead of the bare "delivers at the next pause".
- The escape is the EXISTING `Force send` button (`forceSend()` — already
  client-side, no server change). Its cost is now stated in the chip's visible
  text ("its progress is lost") and its per-row title names the interrupted
  lane. No second interrupt path was added.

No delivery TIME is claimed — the chip names the condition that resolves the
wait (the running step finishing) and shows how long it has already run, which
is the only honest signal available.

## Context pack
- Files/functions in play: `public/app.js` — `paintQueue()` (the `why` builder
  and the `q-l` line), new `foregroundWait()` near `idleBehindBackground()`, the
  1s strip ticker (`setInterval(... , 1000)`) extended to refresh the chip's
  elapsed span, the `Force send` button title in the row `forEach`.
  `public/styles.css` — `.qbox .q-l .q-el`.
- Related tickets: BUG-159 (the strand — server-side delivery of messages held
  behind background work; this ticket is its foreground twin, display-only),
  BUG-174 (false "user-rejected" on interrupt — why interrupt is a real cost),
  FEAT-140 / ARCH-017 step 2 (group-barrier dispatch — removes the underlying
  cause by giving the orchestrator a non-foreground way to fan out N lanes; once
  that ships, foreground `Agent` fan-outs stop happening and this chip state
  becomes rare). BUG-171 (a bash tool lane can be a non-`main` running row too —
  why the copy says the neutral "step", not "subagent").
- Repro test: verified live in a real headless browser against the running
  dashboard with a synthesized foreground-subagent snapshot (see log).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-09 — fixing lane (round 1)
- **Understood:** the chip's `state.busy` branch had only two shapes —
  `idleBehindBackground()` (background strand) and the bare "Claude is working —
  delivers at the next pause". The foreground-subagent case fell into the latter
  and read identically to a two-second wait. The distinguishing state was
  already on the client in `dockSnap()`.
- **Changed:** `public/app.js` (new `foregroundWait()`; the `paintQueue()` `why`
  branch + `q-l` line now render the foreground copy with a live-updating
  `.q-el` elapsed span; the 1s strip ticker refreshes that span; the `Force
  send` title names the interrupted lane), `public/styles.css` (`.q-el`). No
  server change — the escape reuses the existing `forceSend()`. Unstaged.
- **Verified:** `npm run gate` — see return. Real headless browser (Playwright)
  against http://127.0.0.1:4317 with a synthesized foreground-subagent snapshot;
  screenshots of the short-wait and long-foreground states in both themes.
- **Verified-by:** PENDING — independent clean-room verify warranted (touches a
  message-strand surface in a regression-prone file; adjacent to BUG-159/160
  lineage). Fixer's own suite is not the last word.
- **Still open / handoff:** the live long-foreground state was reproduced with a
  SYNTHESIZED snapshot injected into the client (no real 20-minute subagent was
  spun up against the user's live server, deliberately). An independent pass
  should drive a real foreground `Agent` subagent end-to-end if feasible.
- **Symptom of a deeper design flaw?** Partly — the true fix is structural
  (FEAT-140 / ARCH-017 step 2: stop dispatching fan-outs as foreground `Agent`
  calls at all). Those tickets already exist; this ticket is the honest-chip
  mitigation until they land. No new ARCH filed.

### 2026-09-09 — independent verifier (round 1) — VERDICT: REFUTED
- **(i) Fixer's check re-run:** `node scripts/scratch-bug178-verify.mjs` →
  passes (short case = plain copy; long1/long2 = named lane + live elapsed +
  Force-send copy, both themes). `node --check public/app.js` OK. So the claim
  is not already false on the fixer's own fixture.
- **(ii) Adversarial case the fixture did NOT cover — REAL live-server state,
  confirmed defect.** Both of the user's real busy sessions RIGHT NOW report
  `turn.running:true` with MULTIPLE concurrent non-`main` lanes (captured from
  `GET /api/sessions/:id/running`): e7-orchestrator = `main, agent/worker,
  agent/worker, tool/local_bash`; b8-jobintel = `main, agent/general-purpose ×3`.
  Multiple concurrent lanes + a running main turn = BACKGROUND `run_in_background`
  dispatches, not a single blocking foreground subagent. Driving those REAL
  snapshots through the REAL `paintQueue()`
  (`scripts/scratch-bug178-realstate.mjs`) renders, verbatim:
  > 1 queued message · Claude is working — “worker” has been running 3m19s, and
  > your message can’t reach it until that step finishes. Use Force send below to
  > interrupt it (its progress is lost) and deliver now.
  and identically for b8 (“general-purpose … 5m18s”). **This is FALSE:** the
  named lane is a background fan-out lane; the main turn is NOT blocked on it, so
  the queued message delivers at the main turn's own next boundary (ordinary tool
  cadence, seconds) — not when that 3–5-minute lane finishes. It also names an
  arbitrary (oldest) background lane unrelated to any real delivery boundary, and
  it steers the user to Force-send — which `forceSend()` DOES honour by
  `interrupt`-aborting, destroying minutes of background-lane work — for a message
  that needed no interrupt. This is attack-5's dangerous inverse: the scary
  far-boundary copy fires on the genuinely-short case, in the exact
  orchestrator-fan-out workload this repo is built around.
- **Root cause:** `RunningEntry` (running-set.ts) carries NO foreground/background
  flag, so the client cannot distinguish a blocking foreground subagent from
  independent background lanes. The fix's premise — "`turn.running!==false` + a
  non-`main` row ⇒ foreground/far boundary" — is false whenever the orchestrator
  keeps working after a `run_in_background` dispatch (turn stays running while
  background lanes persist). `idleBehindBackground()` only catches the subset
  where the main turn has fully ended (`turn.running===false`).
- **Non-defects checked:** label/description rendered via `createTextNode` /
  `el({text})` → HTML/`<script>` is escaped, no chip injection. The 1s refresh is
  the single pre-existing global strip ticker (not one-per-repaint); it only sets
  `.q-el.textContent`, never touches the textarea. `forceSend()` genuinely
  interrupts (copy accurate about the abort).
- **Could NOT test:** a REAL foreground `Agent` subagent end-to-end (same limit
  the fixer hit — did not spin one up against the live server), so the fix's
  render in its *intended* target state was not confirmed against real delivery
  timing — only that it misfires in a look-alike state that is actually short.
  Did not test clock-skew/negative `startedAt` or >24h elapsed against real data
  (no such live lane existed); the false-positive defect above dominates.
- **Fix nothing** (per charter). Recommend: gate `foregroundWait()` on a real
  background/foreground discriminator (needs a server-side flag on `RunningEntry`,
  or restrict to a genuinely-blocking single-lane shape), else the chip lies in
  the common fan-out state.

### 2026-09-09 — fixing lane (round 2) — closes the round-1 discriminator gap
- **Root cause accepted:** round 1 re-DERIVED foreground-ness on the client
  (`turn.running !== false` + a non-`main` row), which is false in the common
  workload — the orchestrator keeps its turn running while a `run_in_background`
  fan-out persists, so several concurrent background lanes coexist with a running
  main turn whose next boundary is seconds away. `RunningEntry` carried no
  foreground/background flag, so the client could not tell them apart.
- **Fix (ARCH-010 — declared by the owner, read once):** the foreground/
  background fact is now DECLARED on each lane's `RunningEntry.background` by the
  bridge that owns it. New `AgentSession.isBackgroundLane(agentId)`
  (`src/server/agent-bridge.ts`) answers from the SAME authority
  `hasMainThreadWork()` uses to exclude background lanes — the engine's
  background level `#backgroundTasks` ∪ the pre-level born tags `#bgBornTasks`
  (a `run_in_background` dispatch known background by construction, BUG-068).
  `snapshotOfSession` (`src/server/running-set.ts`) stamps
  `background: source.isBackgroundLane(id)` per lane; `SnapshotSource` gains the
  optional method and `RunningEntry` the optional `background` field. Absent only
  when a source cannot own it (survivor lane, older server) → the client treats
  absence as "not known to be foreground" and shows the honest short-wait copy.
- **Client (`public/app.js`):** `foregroundWait()` no longer derives — it filters
  to lanes with `background === false`. No lane declared foreground ⇒ null ⇒ the
  plain "delivers at the next pause". Nothing else changed; the round-1 render
  path (named lane, live `.q-el` elapsed via the single 1s ticker, Force-send
  copy) is reused verbatim for the genuinely-foreground case.
- **Regression fixed:** `regressed-from: BUG-178 (round 1)` — round 1 shipped the
  client derivation that misfired.
- **Verified — the false positive is gone against REAL live-server state:**
  re-ran the verifier's own `scripts/scratch-bug178-realstate.mjs` against the
  live server (which now serves the edited `public/app.js` from disk, no restart
  — `serveStatic` is `no-store`). Both real busy sessions now render:
  `1 queued message · Claude is working — delivers at the next pause` — the
  scary "worker has been running 3m19s … Force send" copy no longer appears.
- **Verified — server declares the fact:** a unit against the REAL builder
  `snapshotOfSession` (source stub with `isBackgroundLane`) → the background lane
  gets `background:true`, the foreground lane `background:false`, `main` none.
- **Verified — the genuinely-foreground copy still fires:** drove the real e7
  snapshot with the oldest lane forced `background:false` (SYNTHETIC — no real
  foreground `Agent` subagent was spun up, same limit round 1 and the verifier
  hit) through the real `paintQueue()`: renders the named-lane + live-elapsed +
  Force-send copy. Screenshots both themes × 1400/760: foreground = scary copy
  wraps cleanly; enriched-background / real-as-is / short = plain copy, no named
  lane. Enriched-background (all lanes `background:true`) also renders plain,
  confirming the field is read, not just its absence.
- **Could NOT observe:** a real end-to-end foreground `Agent` subagent (unchanged
  from round 1); the foreground render is proven only against a synthesized
  `background:false` snapshot.
- **Gate:** FAIL, but NOT from this change — all 8 typecheck errors are the
  pre-existing `src/server/dispatch-broker.ts` WIP (`refusal`,
  `SettleInput.delivered`); the 10 leak-gate hits are the pre-existing round-1/
  verifier scratch files (`scratch-bug178-{expand,realstate,verify}.mjs`, home
  paths). None of the three changed files appears in either list.
- **Verified-by:** PENDING — independent clean-room verify still warranted
  (session-lifecycle / message-strand surface, regression-prone lineage). The
  new attack surface for a skeptic: does `isBackgroundLane` ever answer `false`
  for a lane that is actually background (a fan-out lane whose `task_started`
  outran the `run_in_background` tool_use tag AND the level frame)? If so the
  chip would misfire again — the born-tag window (BUG-068) is the place to probe.
</content>
</invoke>

### 2026-09-09 — independent verifier (round 2) — VERDICT: REFUTED (narrower residual of the same class)
- **(i) Fixer's check re-run:** `node scripts/scratch-bug178-realstate.mjs` →
  both live busy sessions render `1 queued message · Claude is working —
  delivers at the next pause`. So the steady-state false-positive the round-1
  verifier caught IS gone; the claim is not already false on the fixer's fixture.
- **Live-server caveat (attack 4, REAL data):** `GET
  /api/sessions/cs-mtu5ebfe-7/running` returns `background: undefined`
  (`typeof undefined`) on every real `agent` lane — the server was NOT restarted,
  so the SERVER half of the fix (`isBackgroundLane`/`snapshotOfSession`) is NOT
  running against reality; the live "friendly copy" is produced ONLY by the
  client's `background === false` strictness treating `undefined` as
  not-foreground. The declared-fact path has never executed against a live lane.
  (Client handles `undefined` safely — this is the safe direction, not a defect.)
- **(ii) Adversarial case the fixture does NOT cover — CONFIRMED via REAL builder
  + REAL client.** The SDK default is BACKGROUND (`sdk-tools.d.ts:504`: "Agents
  run in the background by default … Set to false to run synchronously"), so a
  default-dispatched Agent OMITS `run_in_background` from its tool_use input.
  `#bgBornTasks` is populated at exactly ONE site (agent-bridge.ts:4256), gated by
  `#bgDispatchToolUseIds` which is gated by `run_in_background === true`
  (3679/3684). Therefore a default-background lane is NEVER born-tagged and is
  background only once the engine's `background_tasks_changed` LEVEL frame lands
  in `#backgroundTasks` — leaving an unguarded BIRTH WINDOW (task_started →
  first level frame) where the lane is in NEITHER set. Drove the REAL
  `snapshotOfSession` with a source in that exact state (LiveAgent running, both
  sets empty): it stamps `background: false`. Fed that real-builder snapshot
  through the REAL `paintQueue()` in a headless browser →
  > 1 queued message · Claude is working — "worker" has been running 24s, and
  > your message can't reach it until that step finishes. Use Force send below to
  > interrupt it (its progress is lost) and deliver now.
  i.e. round-1's exact scary/destructive copy on a BACKGROUND fan-out lane.
- **Root cause (design):** `isBackgroundLane(): boolean` cannot express "not yet
  known"; `entryFor` (running-set.ts:214) unconditionally stamps a concrete
  boolean for any bridge source (the only source with real lanes), so the
  module's own promised safe degrade — `background` ABSENT ⇒ undefined ⇒ honest
  short-wait copy — is UNREACHABLE for a live lane. Every not-yet-classified lane
  collapses to `false` = foreground = scary copy. The fixer reused
  `hasMainThreadWork()`'s authority (agent-bridge.ts:2585), where unknown⇒
  foreground is the SAFE direction (keep the turn alive); for the chip, unknown⇒
  foreground is the DANGEROUS direction. Same predicate, opposite safe default.
- **Scope / honesty:** the reported incident (a fan-out lane misfiring for its
  whole 3–5-min lifetime) IS fixed — once the level frame lands the lane reads
  `background:true` and the chip degrades to friendly copy. The residual is the
  birth window (seconds per lane, but on the COMMON default path, recurring every
  fan-out). Severity lower than round 1; same defect CLASS, not fully closed.
- **Non-regressions (attack 5) — hold:** label/description via
  `createTextNode`/`el({text})` (escaped, no chip injection); the 1s ticker is the
  single global strip interval touching only `.q-el.textContent` (no textarea
  clobber); `forceSend()` unchanged (genuinely interrupts). ARCH-010 (attack 6):
  the fact is read once client-side (`r.background === false`), not re-derived —
  the flaw is the tri-state erasure at the source, not a second reader.
- **Could NOT test:** a real end-to-end foreground `Agent` subagent, and a real
  live default-background lane IN its birth window — the live server serves stale
  server code (`background:undefined`) and cannot be restarted (user's live
  work), so the birth-window stamping was proven only against the REAL builder
  driven by a REALISTIC-STATE synthetic source (stated synthetic), plus the REAL
  client render. Could not confirm whether Orchard's own worker lanes carry
  explicit `run_in_background:true` (0 `Task` tool_use in the live main
  transcript — they spawn via another path), so the window's live frequency for
  THIS repo's fan-outs is unquantified; the tool schema instructs the model to
  omit the flag (default background), which makes the window reachable in general.
- **Recommend:** make `isBackgroundLane` tri-state (return `undefined`/omit when
  the engine has not yet classified the lane) OR guard `entryFor` to stamp
  `background` only when the source can affirmatively answer, so a not-yet-known
  lane degrades to the honest short-wait copy instead of the destructive one.
  Independent clean-room re-verify warranted (session-lifecycle surface).

### 2026-09-09 — fixing lane (round 3) — closes the birth window at the source + tri-states the fact
- **Root cause accepted (round-2 verifier, CONFIRMED):** `isBackgroundLane()`
  could only return a concrete `boolean`, so a not-yet-classified lane collapsed
  to `false` = foreground = the scary Force-send copy. The birth window (a
  default-background `Agent` omits `run_in_background`, is never pre-level
  born-tagged, and is background only once the level frame lands) stamped
  `background:false` on a plain fan-out lane. Same predicate as
  `hasMainThreadWork()`, but for the chip unknown⇒foreground is the DANGEROUS
  direction, not the safe one.
- **Fix — BOTH halves the verifier recommended, and they reinforce:**
  1. TRI-STATE the fact. `AgentSession.isBackgroundLane()` now returns
     `boolean | undefined` (`src/server/agent-bridge.ts`): `true` (in
     `#backgroundTasks` ∪ `#bgBornTasks`), `false` (positively foreground, see
     below), else `undefined`. `SnapshotSource.isBackgroundLane?` widened to
     `boolean | undefined`; `entryFor` (`src/server/running-set.ts`) now stamps
     `background` ONLY when the answer is a `boolean` and OMITS it on `undefined`.
     So the birth window carries no assertion and the chip degrades to the honest
     short-wait copy.
  2. POSITIVE-FOREGROUND signal at the source (ARCH-010: declared by the owner,
     not re-derived). An `Agent`/`Task` dispatched `run_in_background:false`
     (foreground is always EXPLICIT — the SDK default is background,
     sdk-tools.d.ts:502; `isolation:"remote"` excluded, always background) is
     recorded in a new `#fgDispatchToolUseIds` at the tool-call frame and
     promoted to `#fgBornTasks` (the lane's agent id) at its `task_started` —
     the exact two-step the background born-tag uses. These feed ONLY
     `isBackgroundLane()`; the liveness gate and turn-end sweep never read them,
     so BUG-068/096/105 cannot regress. Retired per-task at the terminal frame;
     the dispatch set is bounded by any level frame (`#fgBornTasks` is NOT
     cleared there — a live foreground lane is never in the background level).
  This is why the genuine feature survives: a real `run_in_background:false`
  subagent still reads `background:false` and still earns the honest copy —
  round-2's naive "never return false" would have killed the whole point.
- **Client (`public/app.js`):** UNCHANGED. `foregroundWait()` already filters to
  `r.background === false`, which treats absent/`undefined` as not-foreground —
  the verifier confirmed this is the safe direction. The entire defect was
  server-side; no client edit was needed.
- **Regression fixed:** `regressed-from: BUG-178 (round 2)` — round 2's boolean
  `isBackgroundLane` erased the unknown state at the source.
- **Verified — END-TO-END against a REAL server + REAL bridge + REAL builder +
  REAL client** (`scripts/scratch-bug178-birthwindow.mjs`, a scratch server on a
  free port with a scripted fake `claude` via `CLAUDE_STATION_CLAUDE_BIN` — the
  verify-bug-068 seam; the user's :4317 was never touched or restarted). This
  CLOSES the "could not drive a live lane" gap both prior rounds hit. 7/7:
  (1) DEFAULT `Agent` (omits `run_in_background`) in its birth window →
  `GET /running` lane has NO `background` field (`hasField:false`), turn.running
  true; (2) fed through the REAL `paintQueue()` → `delivers at the next pause`,
  no Force send; (3) after the level frame → `background:true`; (4) FOREGROUND
  `Agent` (`run_in_background:false`) → `background:false`; (5) chip → the honest
  `"worker" has been running Ns … that step finishes … Use Force send` copy;
  (6) EXPLICIT-BACKGROUND (`run_in_background:true`) → `background:true`
  immediately; (7) chip → friendly.
- **Must-FAIL proof:** with `isBackgroundLane`'s final `return undefined`
  temporarily reverted to `return false` (the old collapse), the SAME harness
  fails (1) and (2): birth-window lane stamps `background:false` and the chip
  renders verbatim `"worker" has been running 0s … Use Force send below to
  interrupt it (its progress is lost)` — round-1/2's exact destructive copy on a
  background lane. Reverted to `undefined` after capturing.
- **Verified — no false positive against REAL live-server state:** re-ran the
  verifier's `scripts/scratch-bug178-realstate.mjs` against the live :4317. Both
  real busy sessions still render `1 queued message · Claude is working —
  delivers at the next pause`. (Live lanes report `background` ABSENT — the stale
  server predates these changes — and the unchanged client treats absence as
  friendly, so the live surface is unaffected either way.)
- **Anti-regression (born-tag / liveness machinery I edited adjacent to):**
  `verify-bug-068-bash-background-visible.mjs` 5/5, `verify-bug-096-bg-child-lane-
  no-fabricated-death.mjs` 17/17. The background born-tag window and the sweep
  are unchanged.
- **Screenshots:** `docs/bugs/assets/BUG-178-r3-{friendly,scary}-{light,dark}-{1400,760}.png`
  (rendered by the real client over the real e7 snapshot; the scary state names
  a real ~18-min lane). Scary copy wraps cleanly at 760px; friendly is the plain
  short-wait line. Both themes.
- **Could NOT observe (stated, not hidden):** the live :4317 server serves the
  OLD server code and was NOT restarted (user's live work), so on the live
  process real lanes still report `background: undefined` and the NEW server half
  (`#fgBornTasks`, the tri-state `isBackgroundLane`) has never executed IN that
  process. Everything above proving the server half is against a SCRATCH server
  running the new code — faithful (real bridge, real frames) but a separate
  process. The fake-`claude` frame ordering is realistic but synthetic; a real
  model-driven foreground `Agent` end-to-end was still not spun up.
- **Files changed (unstaged):** `src/server/agent-bridge.ts` (tri-state
  `isBackgroundLane`; `#fgDispatchToolUseIds`/`#fgBornTasks` + their tool-call,
  task_started, terminal, and level-frame sites), `src/server/running-set.ts`
  (`SnapshotSource.isBackgroundLane?` widened; `entryFor` omits on `undefined`;
  doc). New scratch: `scripts/scratch-bug178-birthwindow.mjs`,
  `scripts/scratch-bug178-shots.mjs`. `public/app.js` NOT touched this round.
- **Gate:** FAIL, but NOT from this change — the 8 typecheck errors are all the
  pre-existing `src/server/dispatch-broker.ts` WIP (`refusal`,
  `SettleInput.delivered`); the leak-gate hits are all scratch-`*.mjs` / `_scratch-*`
  home-path files (the ticket's named exemption). Confirmed unpiped: neither
  `agent-bridge.ts` nor `running-set.ts` appears in either failure list.
- **Verified-by:** PENDING — independent clean-room re-verify WARRANTED
  (session-lifecycle + message-strand surface, regression-prone lineage; this is
  a high-stakes bucket — generation must not be its own only verifier). New
  attack surface for a skeptic: (a) does `#fgBornTasks` ever tag a lane that is
  actually background (an ordering where a `run_in_background:false` id is reused
  by a later background dispatch)? (b) can a lane sit `undefined` forever if its
  `task_started` precedes both the tool-call frame AND all level frames — is the
  friendly copy then permanent for a genuinely-foreground lane? (safe direction,
  but worth confirming it is only a display gap).

### 2026-09-09 — independent verifier (round 3) — VERDICT: REFUTED (the DANGEROUS inverse, via a level-frame race)
- **(i) Fixer's checks re-run (real cmd + output):** `node
  scripts/scratch-bug178-birthwindow.mjs` → 7/7 PASS (birth window omits
  `background`, chip friendly; foreground `background:false`, chip scary+Force
  send; explicit-bg `background:true`, friendly). `node
  scripts/scratch-bug178-realstate.mjs` → both live busy sessions render `…
  delivers at the next pause`. So the claim is NOT already false on the fixer's
  fixture — the isolated cases work.
- **(ii) NEW adversarial case beyond the fixture — CONFIRMED defect, real
  server + real bridge + real builder + real client** (`node
  scripts/scratch-bug178-race.mjs`, scratch server on a free port, fake `claude`
  via the verify-bug-068 seam; :4317 untouched). ONE assistant message
  dispatches TWO Agents — `run_in_background:true` (id `tub`) AND a genuinely
  BLOCKING `run_in_background:false` (id `tuf`). Frame order: bg `task_started`,
  then bg `background_tasks_changed`, then fg `task_started`. Observed
  `GET /running`: `[{main},{abg,background:true},{afg,hasField:false}]`,
  `turn.running:true`. The foreground lane `afg` carries NO `background` field.
  Real `paintQueue()` → verbatim:
  > 1 queued message · Claude is working — delivers at the next pause
  i.e. the FRIENDLY copy on a lane that actually blocks the main turn — **the
  ORIGINAL BUG-178 returning silently** (skeptic surface #2, the dangerous
  inverse the charter named).
- **Root cause:** the level frame handler does `#fgDispatchToolUseIds.clear()`
  (agent-bridge.ts ~L4174) on ANY `background_tasks_changed`. When a *concurrent*
  background lane's level frame lands in the window between a foreground Agent's
  tool-call frame (where `tuf` is recorded) and that foreground lane's own
  `task_started` (where `tuf` would be promoted to `#fgBornTasks`), the dispatch
  id is erased first, so `task_started`'s `#fgDispatchToolUseIds.delete(tuf)`
  returns false and the lane is NEVER positively classified. `isBackgroundLane`
  then returns `undefined` → `entryFor` omits `background` → chip degrades to the
  friendly copy for a genuinely-foreground blocking lane. The fixer's own
  skeptic note (b) guessed "task_started precedes the tool-call frame"; the
  actually-reachable trigger is different — a *sibling* background lane's level
  frame clearing the set mid-birth. Reachable routinely in THIS repo's
  constant-background-lane fan-out workload (a level frame fires whenever any
  background task set changes). Frame ordering in the harness is synthetic but
  the SDK does not order an independent lane's level-change against another
  lane's `task_started`, so the window is real; its live frequency is
  unquantified (same live-lane limit prior rounds hit).
- **Non-regressions checked — HOLD:** `isBackgroundLane` is read ONLY by
  `entryFor` (running-set.ts:229) — grep confirms no liveness/`hasMainThreadWork`
  caller — so the tri-state `undefined` cannot regress BUG-159 phantom-busy
  (hasMainThreadWork reads `#backgroundTasks`/`#bgBornTasks` directly). Isolated
  birth-window, pure-foreground, and explicit-background cases all pass (above).
  createTextNode/1s-ticker/forceSend/ARCH-010 unchanged this round (client
  untouched) — accept prior rounds' clearance.
- **Could NOT test:** a real model-driven foreground `Agent` end-to-end (the fake
  `claude` frame ordering is synthetic, self-labelled); the live :4317 server
  (predates the server half — real lanes report `background:undefined` — and must
  not be restarted); the exact live frequency of the adverse level/task_started
  interleave for real Orchard fan-outs (no real foreground `Agent` in the live
  transcripts to sample); skeptic surface #1 (tool_use id reuse) — dispatch ids
  are unique and consumed on first match, judged not exploitable by inspection,
  not driven. Pixel screenshots skipped — the defect is textual and conclusive
  from the real client's rendered `.q-l` text.
- **Recommend (fix nothing per charter):** do NOT clear `#fgDispatchToolUseIds`
  wholesale on every level frame — a foreground dispatch id must survive until
  its own `task_started` or a terminal/turn-end, independent of sibling
  background lanes' level churn. Independent clean-room re-verify still warranted
  (high-stakes session-lifecycle surface).

### 2026-09-09 — fixing lane (round 4) — scopes the foreground dispatch set to the id's own lifetime (ROOT, not a fourth guard)
- **Root cause accepted (round-3 verifier, CONFIRMED and reproduced):** the level
  frame handler did `this.#fgDispatchToolUseIds.clear()` on EVERY
  `background_tasks_changed`. A level frame is the authority for the BACKGROUND
  sets (REPLACE semantics — `#backgroundTasks` carries every live background lane,
  so the pre-level born hints are redundant), but it is NOT any authority over
  FOREGROUND lanes: a live foreground lane never appears in the background level.
  Clearing the fg dispatch set on a sibling's level frame erased a still-pending
  `run_in_background:false` dispatch in the window between its tool-call frame and
  its own `task_started`, so `task_started` found nothing to promote,
  `isBackgroundLane` returned `undefined`, `entryFor` omitted `background`, and
  the chip showed the friendly "delivers at the next pause" for a lane that
  BLOCKS the main turn — the original BUG-178 incident returning silently.
- **Fix (§N — root design, not another local patch; ARCH-010 respected — the fact
  is still declared once by its owner and read once by the chip; NO second reader
  added):** the pending-foreground-dispatch set's LIFETIME is now scoped to the
  dispatch id's OWN events, exactly like `#dispatchDeclByToolUse` (FEAT-126) —
  consumed by its matching `task_started` (promoted to `#fgBornTasks`), and swept
  once at the turn-end `result` if the id never became a lane. The wholesale
  `clear()` was REMOVED from the `background_tasks_changed` handler; a single
  unconditional clear now lives at the `result` sweep beside FEAT-126's. A
  sibling background lane's level churn no longer touches a pending foreground
  dispatch. This is a change of MODEL (per-id lifetime), not a guard bolted onto
  the old event-keyed clear — the shape of the bug (lifetime keyed on an
  unrelated event) is gone. `#fgBornTasks` retirement (terminal frame) unchanged.
- **Only production edit:** `src/server/agent-bridge.ts` — level-frame handler
  (removed the fg clear + rewrote the comment), `result` sweep (added the fg
  clear beside `#dispatchDeclByToolUse.clear()`), and the field doc for
  `#fgDispatchToolUseIds`. No client change (`public/app.js` untouched — the
  entire defect was the server erasing the fact). `src/server/running-set.ts`
  untouched this round.
- **Regression fixed:** `regressed-from: BUG-178 (round 3)` — round 3 introduced
  the level-frame `#fgDispatchToolUseIds.clear()` that this race exploited.
- **Verified — the verifier's OWN repro now passes (unmodified):** `node
  scripts/scratch-bug178-race.mjs` → 3/3 PASS. Real output: `rows:
  [{main},{abg,bg:true,has:true},{afg,bg:false,has:true}]`, `turn.running:true`;
  chip = `... "worker" has been running 1s ... that step finishes. Use Force send
  below to interrupt it ...`. Pre-fix (round-3 code) it was `afg hasField:false`
  and the friendly copy.
- **Must-FAIL proof:** re-inserting `this.#fgDispatchToolUseIds.clear()` into the
  level-frame handler (the round-3 code) and re-running the SAME repro →
  1 passed, 2 FAILED: `afg` reads `hasField:false` and the chip renders
  `1 queued message · Claude is working — delivers at the next pause` on the
  blocking lane — the exact defect. Reverted the probe after capturing.
- **Reverse race added (new script, verifier's repro left untouched):** `node
  scripts/scratch-bug178-reverse-race.mjs` → 3/3 PASS. A BACKGROUND lane born
  amid FOREGROUND dispatch churn (fg `task_started` consumes its id first, then a
  level frame, then the bg lane's `task_started`) reads `background:true`, is
  NEVER mis-stamped foreground; the fg lane stays `background:false`. Confirms the
  fg consume touches only its own id.
- **Anti-regressions — HOLD:** `scripts/scratch-bug178-birthwindow.mjs` 7/7 (birth
  window still omits `background`→friendly; foreground still `false`→honest copy;
  explicit-bg `true`→friendly). `scripts/scratch-bug178-realstate.mjs` → both real
  live busy sessions still `... delivers at the next pause` (live :4317 predates
  the server half — real lanes report `background` absent — so the live surface is
  unaffected either way). `verify-bug-068` 5/5, `verify-bug-096` 17/17 (the born-
  tag/liveness/sweep machinery I edit adjacent to is unchanged). `isBackgroundLane`
  still feeds ONLY `entryFor`, never `hasMainThreadWork`/liveness (BUG-159 safe).
- **Screenshots:** `docs/bugs/assets/BUG-178-r4-{friendly,scary}-{light,dark}-{1400,760}.png`
  (real client over the real e7 snapshot). Scary copy names the lane + live
  elapsed + Force-send cost and wraps cleanly at 760 and 1400 in both themes;
  friendly is the plain short-wait line. Render path identical to r3 (client
  unchanged); regenerated to confirm.
- **Could NOT observe (stated, not hidden):** the live :4317 server serves the OLD
  server code and was NOT restarted (user's live work), so the NEW server half has
  never executed IN that process; everything proving the server half is a SCRATCH
  server on a free port running the new code (real bridge/frames, separate
  process). The fake-`claude` frame ordering is realistic but synthetic; a real
  model-driven foreground `Agent` end-to-end against a live restart is still
  unproven. The live frequency of the adverse level/`task_started` interleave for
  real Orchard fan-outs is unquantified.
- **Gate:** FAIL, but NOT from this change. Typecheck: all 8 errors are the
  pre-existing `src/server/dispatch-broker.ts` WIP (`refusal`,
  `SettleInput.delivered`) — `agent-bridge.ts` is in neither list (my only edit
  typechecks clean whole-project). Leak-gate: 10 hits in 3 PRIOR-round scratch
  files (`scratch-bug178-{expand,realstate,verify}.mjs`, home paths — the ticket's
  named exemption); my new scratch (`scratch-bug178-reverse-race.mjs`,
  `scratch-bug178-shots-r4.mjs`) uses `os.homedir()`/`BRAVE_BIN` and does NOT
  appear.
- **Verified-by:** PENDING — independent clean-room re-verify WARRANTED (high-
  stakes session-lifecycle surface, regression-prone lineage; generation must not
  be its own only verifier). New attack surface for a skeptic: (a) can a
  foreground dispatch id now survive PAST the turn that declared it if its
  `task_started` never arrives and no `result` fires (a wedged turn)? — argued
  bounded by the `result` sweep, but a genuinely wedged turn never reaches
  `result`; confirm this is only a display gap, not unbounded growth. (b) drive a
  REAL model foreground `Agent` end-to-end against a restarted scratch server to
  close the synthetic-frame-ordering gap all four rounds share.

### 2026-09-10 — R4 independent verify (live server, post-restart): CONFIRMED

Independent skeptic, fresh context. Objective was to BREAK the r4 claim on the
one ground all three prior rounds lacked: a LIVE server that actually holds the
new code.

- **Resident-code check (ground truth):** :4317 owner pid 1384306 started
  2026-09-10 07:31:33, AFTER `agent-bridge.ts` (09-09 18:40) and
  `running-set.ts` (09-09 17:21) mtimes. The new server half IS executing in
  the live process. Live claims are valid this round.
- **(i) re-run, real output:** `scratch-bug178-race.mjs` 3/3,
  `-reverse-race.mjs` 3/3, `-birthwindow.mjs` 7/7, `-realstate.mjs` shows the
  FRIENDLY copy for both busy fan-out sessions. Reproduced.
- **(ii) LIVE server half — PROVEN.** `GET /api/sessions/<id>/running` on all
  three live sessions: every real `run_in_background:true` fan-out lane
  (14 general-purpose + 2 local_bash in ba5ab6ef; 6 in 9694cae1) carries a
  correctly-typed `background:true`. This is the field three verifiers could
  never see (it was `undefined` on the old process). One idle-session tool lane
  read `(ABSENT)` — a background bash in its pre-level birth window (harmless;
  turn.running:false so the chip is unaffected; resolves to `true` at its level
  frame).
- **REAL model-driven foreground Agent, end-to-end — OBSERVED LIVE.** Session
  eaddd8dc, turn.running:TRUE, two real `agent/worker` lanes stamped
  `background:false` — genuine `run_in_background:false` dispatches blocking the
  orchestrator's turn. First time a real foreground Agent has been seen carrying
  the positive-foreground stamp against a live server. `background:false` is
  UNFORGEABLE for a background lane: the only entry to `#fgBornTasks` is a
  `task_started` echoing an id added at agent-bridge.ts:3751, gated to
  `run_in_background===false && isolation!=='remote' && name∈{Agent,Task}`.
- **Inverse (attack 4) — not reachable.** A foreground main-thread Bash is the
  `main` row, not a separate tool lane (separate tool lanes are background
  bashes), and the fg tag is gated to Agent/Task, so no genuinely-blocking lane
  is stamped background/absent. The 20-min incident class (foreground Agent) is
  covered. No live counter-example found.
- **New sweep point (attack 5) — sound.** `#fgDispatchToolUseIds` cleared only
  at turn-end `result` (3875); consumed by its own `task_started` (4357) keyed
  on the globally-UNIQUE `toolUseId`. A wedged/interrupted turn with no `result`
  leaks a pending id, but a stale id can ONLY ever promote its own uniquely-id'd
  lane — it can never mis-stamp a different turn-N+1 lane (ids are never reused).
  So the r4 model's natural failure is a bounded display-only residue, not a
  mis-classification. The round-3 level-frame `clear()` is structurally gone
  (only clear site is the result sweep).
- **Non-regressions:** `isBackgroundLane`/`#fgBornTasks` feed ONLY `entryFor`
  (running-set.ts:229); `hasMainThreadWork` reads `#backgroundTasks`/`#bgBornTasks`
  only (BUG-159 phantom-busy safe). Chip render path unchanged; `foregroundWait()`
  filters strictly `background === false` (absent ⇒ friendly copy).
- **Could NOT test / limits:** did not combine the two halves into ONE artifact
  (live-classifies-false + browser-renders-scary) — driving a headless browser
  at the live eaddd8dc chip would require queuing a message into the USER's live
  session (forbidden) and the cross-provider broker is wedged (another lane), so
  a from-scratch real-Agent+real-browser single run was not attempted. The
  browser chip render given `false` is proven by the real-browser scratch scripts;
  the live server stamping `false` on real foreground lanes is proven separately.
  Did not exercise a truly-wedged (no-`result`) turn live to watch the id residue.

**Verdict: CONFIRMED.** The live server half is proven and a real model-driven
foreground Agent was finally observed end-to-end stamped `background:false`. No
surviving defect. — independent verifier
