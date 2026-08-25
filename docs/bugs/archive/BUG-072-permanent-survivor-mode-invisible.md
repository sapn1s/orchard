# BUG-072 — FEAT-065 delivery permanently defers adoption: session runs invisible in "survivor mode" forever

- **Status:** VERIFIED 2026-08-12 — verify:bug-072-delivery-visible 47/47 (pre-fix FAIL proven in a clean-room HEAD worktree: 22/47, incl. the captured `rows:[] / source:'no-session' / busy:false / busy:null` and an EMPTY strip in a real browser); all anti-regressions green (feat-065-delivery 35/35 unmodified). Hypothesis CONFIRMED. **Needs a later DEPLOY — not deployed.**
- **Area:** index resume/adopt path vs survivor-delivery precedence; liveness/running for delivery-mode sessions
- **Reported:** 2026-08-12 by user ("ui neither does display when main agent — you — is doing work…
  there is never a list of agents, yet your responses come through")

## Evidence (live, captured while a turn was demonstrably executing)
- `/api/sessions/<sdkId>/running` → `turn.running:false, source:'no-session', rows:[]`
- `/api/sessions/live` → the session `busy:false`
- `/api/health` → `liveBridges:0`; the session row: `state:'surviving-unadopted', adopted:false, busy:null`
- One broker set in session-hosts/ (h-msp3yc1n-*), alive since the pid-438714 deploy (~24h)
- Yet every user message during that day produced a normal turn with normal replies.

## Root cause (hypothesis fitting all evidence — investigator must confirm)
Since the 438714 deploy the orchestrator session has had near-continuous background bash lanes
(dispatch CLI children), so the survivor's drain hold (BUG-044) never commits. The FEAT-065
delivery gate (state draining + midTurn false + backgroundLifetime yes) therefore matches on
EVERY user send, and delivery fires BEFORE the resume-from-disk path that would have re-adopted
the session. Result: a stable, self-sustaining "permanent survivor mode" — turns run via stdin
injection into the unadopted survivor; the server owns no bridge; liveness/running/health/strip
all truthfully report "nothing", which reads to the user as the old visibility bug. BUG-068's
observed rows:[] for bash lanes is (at least partly) this same state: no bridge ⇒ no snapshot
source at all, for ANY row type including main.

## Wanted (direction — investigator refines)
1. Delivery must not permanently displace adoption. Either adopt-then-deliver (the delivered
   turn runs under an owned bridge), or after each delivered turn's result, attempt adoption of
   the still-held survivor (the input half of full re-adopt (a) already exists — this is the
   ownership half), or at minimum bound consecutive deliveries before forcing adoption.
2. Whatever the lifecycle outcome: a delivery-mode session MUST report as live/busy with a main
   row (and its background lanes) in liveness/running/health — ARCH-001: one authority, no
   surface may say "nothing running" while a turn executes.
3. Keep FEAT-065's proven safety invariants (single writer, exactly-once, midTurn gate) — the
   fix must not regress verify:feat-065-delivery 35/35 or the BUG-022/044 suites.

## Verification (§C)
Real-shape: deploy-restart with a background-holding survivor → user sends N successive messages
→ each delivers AND the session becomes (or reports as) owned/live: running shows the main turn
during each delivered turn (must FAIL at HEAD: rows:[] as captured above), health shows a bridge
or an honest delivery-mode-live state, strip renders it. Suites: feat-065-delivery 35/35,
bug-044-restart-background 15/15, restart-survives, liveness-conformance 96/96, running-snapshot,
stall-detector, ui, typecheck.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from the user's report + the captured live state. Sequencing: dispatch AFTER BUG-068's
  in-flight agent commits (same files); BUG-068's "bash lanes invisible" evidence is likely this
  bug wearing a smaller mask — the two tickets should be reconciled by whichever agent lands
  second.

### 2026-08-12 — FIX + verification (fix agent, in-place on main)

**1. HYPOTHESIS CONFIRMED — on the live service, read-only, before touching anything.**
`/api/health` on :4317 at investigation time: session `87564f3e-…` `state:'surviving-unadopted',
adopted:false, busy:null`, `liveBridges:0`, broker `h-msp3yc1n-*` (hostPid 428604 / cliPid 428611)
`state:'draining', backgroundLive:1, backgroundLifetime:'yes', drainHeldSince 2026-08-11T20:28`
(≈10h) and **`midTurn:true` — a turn in flight right then** — while
`/api/sessions/<sdk>/running` answered `turn.running:false, running:[], source:'no-session'`,
`/api/sessions/live` `sessions:[]` and `/api/sessions` `[]`. Exactly the filed evidence.

THE CODE PATH, named:
- `src/server/index.ts:2688-2713` — the FEAT-065 deliver-or-refuse site. `deliverable` matches on
  `state==='draining' && midTurn===false && backgroundLifetime==='yes'` and then **`return`s at
  :2712**, i.e. BEFORE the resume-from-disk `startSession(…)` call at :2727 that is the only path
  which would ever create a bridge for this session.
- Adoption can therefore only happen when the survivor is GONE: `adoptSurvivingHosts`
  (`survival.ts:495`) SIGTERMs the broker at boot, but `commitDrain()`
  (`session-host.mjs`, BUG-044) declines the EOF for as long as `backgroundOutlivesTurn() !== 'no'`.
  With near-continuous background lanes the hold never commits, the broker never exits, the
  survivor never drops out of `survivingHostForSdkSession`, and every send re-enters the delivery
  branch. Self-sustaining permanent survivor mode — precisely as filed.
- The visibility consequence was structural, not a bug in any surface: `/running` fell through to
  `emptySnapshot` ("this server is not driving a live session for that id"), `/api/sessions/live`
  had no bridge to ask, `/api/health`'s survivor row hard-coded `busy: null`. Each answer was true
  about the SERVER's ownership and false about the world — the ARCH-001 violation.
- BUG-068 reconciliation: BUG-068's sweep fix is real and orthogonal (it governs lanes on a LIVE
  bridge). The `rows:[]` the user saw on the dispatch pipeline was this ticket's state — no bridge,
  so no snapshot source for ANY row type. Both were needed; neither subsumes the other.

**2. CHOSEN SHAPE: (a) — delivery-mode sessions REPORT as live/busy/owned-enough; lifecycle
unchanged. Why not (b), stated as a cost, not a preference.**
The task's (b) ("genuine adoption of the still-held survivor via the broker socket") is BUG-048
direction **(a) full re-adopt** in full: the SDK's `query()` always spawns
(`survival.ts:24-34`), so owning the survivor means a server-side stream-json driver — input
frames, event parsing, the whole control protocol (approvals, interrupts, model switches) and a
synthetic `AgentSession` rebinding busy/liveness/approvals/queue. BUG-048's explore priced that as
weeks-class with the largest blast radius in the restart lineage, and FEAT-065 deliberately shipped
only its input half. Wanted 2 does not require ownership — it requires that no surface lie. The
ticket's third option (bound consecutive deliveries, then FORCE adoption) is worse than either:
with a permanently-held drain the only ways to force it are EOF-ing a CLI whose background lanes
are live (re-introducing BUG-044's killer) or spawning `claude --resume` beside a living writer
(BUG-022, re-measured as still corrupting at CLI 2.1.227 in BUG-048 probe 2). **Nothing here can
ever spawn a second CLI**: the fix adds no process, no signal and no lifecycle branch — it is
read-only reporting plus one already-existing socket's evidence.

**THE FIX (server-side only; `public/app.js` NOT touched — the client already polls
`/api/sessions/:id/running` every 4s with `state.stationSessionId || sdkSessionId ||
current.sessionId`, so correcting the server's answer was sufficient to make the strip render):**
- `src/server/liveness.ts` — `survivorWork(status, deliveryEvidence?)` (+ `SurvivorLane`,
  `SurvivorWork`, `DeliveryEvidence`). ARCH-001: the interpretation lives IN the authority, so no
  fifth site answers "is a turn in flight" locally; it adds NO rung (process liveness is still
  `livenessOfSurvivor`) and reads only DECLARED evidence — the broker's `midTurn`/`midTurnSince`
  and its sniffed background level. `turnRunning` is three-valued: an older broker that never
  published boundaries yields **`null` = unknown, never coerced to idle** (ARCH-002).
- `src/server/session-host.mjs` — the broker now also publishes `midTurnSince` (stamped at the
  boundary that OPENS a turn, cleared at its `result`) and `backgroundTasks:[{id,type,since}]`
  (the engine's own `task_type` + each lane's first-seen stamp, carried across level frames so a
  lane's clock is its own age). One extra `writeStatus` on a level-set CHANGE only — level frames
  are rare boundaries, never per-frame. `backgroundTaskIds`/`backgroundLive` are unchanged for
  every existing reader.
- `src/server/survival.ts` — the two optional `HostStatus` fields, plus `survivingHostForSession`
  (matches sdk id, resumeHint OR station id) because a tab that lived through the restart polls
  with its stale STATION id. The send guard keeps using `survivingHostForSdkSession` — unchanged.
- `src/server/running-set.ts` — `snapshotOfSurvivor()`: the same `RunningSnapshot` structure,
  `source:'survivor'`, main row iff `turnRunning===true` (honest `startedAt`, `null` renders "—"),
  one row per declared lane labelled by its `task_type`. Lanes are never judged `stalled` — that is
  a bridge-side frame-progress verdict this server cannot observe for a survivor, and fabricating
  it would be BUG-041's class.
- `src/server/survivor-delivery.ts` — `deliveryEvidenceFor(sdkId)` + `startedAt`: this server's
  FIRST-HAND evidence (it wrote the frame; the relay has not seen that turn's `result`), which is
  what makes the strip right in the same tick as the ack rather than one boundary later.
- `src/server/index.ts` — four surfaces, all reading the one authority: `/api/sessions/:id/running`
  falls back to `snapshotOfSurvivor` instead of `emptySnapshot`; `/api/sessions/live` reports a
  survivor row as `busy` (+ `survivingUnadopted`, `drivenByDashboard:false` — honest: alive and
  running, no bridge) and unions in survivors the mtime scan missed; `/api/health`'s
  surviving-unadopted row carries `busy` (three-valued), `turnStartedAt`, `deliveryActive` and a
  `work:{turnRunning,turnSince,reason,lanes}` block while KEEPING `state:'surviving-unadopted'` and
  `adopted:false` (no fake ownership; health-survivor/conformance labels unchanged); and the
  delivery ack is immediately followed by a pushed `running-snapshot`.
- `scripts/verify-bug-072-delivery-visible.mjs` (new) + `verify:bug-072-delivery-visible`.

**3. VERIFICATION (§C — scratch ports/dataDirs, real seed haiku session + a REAL session-host
broker whose fake stream-json CLI appends to the REAL transcript, kill by pid, :4317 untouched).**
- **PRE-FIX, clean-room `git worktree` at HEAD (aabf45e), the new suite copied in: 22/47** — the
  ticket's captured state reproduced verbatim: `/running` → `{turn:{running:false},rows:[],
  source:'no-session'}` while the delivered turn was demonstrably executing; `/api/sessions/live`
  row `busy:false`; `/api/health` `busy:null, deliveryActive:null, work:(absent)`; broker
  heartbeat `backgroundTasks:(absent)`; and in a REAL browser the strip rendered **no main row**
  (S5 FAIL) — the user's exact report. Every delivery check PASSED at HEAD, confirming the bug is
  visibility, not delivery.
- **POST-FIX: 47/47.** S1 the drain is held for a declared lane, foreground idle, heartbeat carries
  the lane facts. S2 **three successive sends: each acked `deliveredVia:'survivor'` (150ms) AND,
  while that turn was open, `/running` showed `turn.running:true` with the `main` row (honest
  `startedAt`) + the `local_bash` lane row, `source:'survivor'`; `/api/sessions/live` `busy:true`;
  `/api/health` `busy:true, deliveryActive:true, work.lanes:1` while still `surviving-unadopted /
  adopted:false`; and the ws received a pushed `running-snapshot` in the same tick as the ack.**
  S3 the invariants: **no `claude --resume` for this session ever existed (/proc scan)**, the
  engine received exactly 3 user frames (the survivor's own stdin — single writer), the store holds
  exactly 3 user messages (exactly-once intact). S4 **no false positives**: between turns the main
  row is GONE and health says `busy:false` — the lane row stays (it is genuinely running). S5 REAL
  BROWSER (brave/CDP, deep-link open): the strip renders `main ◐` + the lane while the delivered
  turn runs, and the main row LEAVES when it ends. S6 an older broker's status file (no boundary
  field) yields no fabricated row and reports **unknown, never "idle"** (`busy:null`). S7 the
  background settles → the drain commits → the broker reaps → the snapshot goes honestly empty
  (`source:'no-session'`) — no phantom row outlives the survivor.
- **Anti-regressions: ALL GREEN.** verify:feat-065-delivery **35/35 (script UNMODIFIED — no test
  was changed anywhere in this ticket)**; feat-064-drain-truth 18/18; bug-044-restart-background
  15/15; bug-068-bash-background 5/5; restart-survives 15/15; restart-reconnect-race 10/10 (the
  no-second-CLI invariant); liveness-conformance **96/96 incl. the R-D regrowth guard clean** (the
  new answer lives inside the authority, so no ad-hoc check appeared); running-snapshot 47/47;
  stall-detector 33/33; ui 7/7; health-survivor 14/14; resume-refusal 13/13; refusal-visible 19/19
  (one earlier run 18/19 on the known auto-retry timing flake, clean on rerun); queue 14/14;
  typecheck clean; leak-gate PASS.
- **One real defect the anti-regressions caught and I fixed, recorded because it nearly shipped:**
  the first cut of the `/api/sessions/live` union searched every project dir for each survivor's
  transcript facts. With verify:resume-refusal's 37 planted survivors that pushed the refusal past
  its 3s window (**9/13**, while HEAD was 13/13 — my regression, not a pre-existing one). The
  union now emits `dir:''`/`ageMs:0` for rows the mtime scan did not find (honest "not knowable
  from here"; those facts would be stale by definition) and the suite is 13/13 again.

**Operational note: needs a later DEPLOY (service restart) to reach the running service — NOT
deployed here.** Until deployed the live session keeps reporting nothing while it works. Note the
two halves deploy differently: the SERVER half (all four surfaces) takes effect on restart even for
a survivor from an older broker — it then reports `unknown` rather than idle for the turn, but the
LANES and the delivery-relay evidence still render; the `midTurnSince`/`backgroundTasks` richness
arrives only with brokers started after the deploy.

**Residuals, named:** (a) lifecycle is unchanged — the session stays `surviving-unadopted` for as
long as background lanes hold the drain; full ownership remains BUG-048 direction (a), and this
work makes its absence visible instead of silent. (b) Lane rows carry no description (the level
frame gives type + id only) and never render a stall verdict — both are the honest limits of
broker-sniffed evidence. (c) The pushed snapshot at ack covers the strip until the client's next
4s poll; a turn that ENDS between polls clears within one poll (proven in S5). (d)
`/api/sessions/live` now calls `scanSurvivingHosts()` per poll (status reads + pid checks, 0-2
records in practice) — cheap, and it is the same scan `/api/health` already did.
