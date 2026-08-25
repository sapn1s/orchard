```orchard-ticket
{
  "id": "BUG-072",
  "type": "bug",
  "title": "Active delivery sessions disappear from status views",
  "summary": "Delivery-mode sessions now remain visible while turns execute instead of appearing idle and empty. The pre-fix case failed, and the corrected behavior passed alongside existing delivery safeguards. The change still needs deployment.",
  "impact_if_we_wait": "Until deployment, active sessions can appear absent from status views while replies still arrive. Bounded: this is session visibility and display-correctness, not message delivery or data loss.",
  "current_need": "Deploy the change; the pre-fix case failed, the corrected behavior passed, and standing checks stayed clean.",
  "severity": "medium",
  "area": "Session activity visibility",
  "reported": "2026-08-12",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-12",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Successive messages deliver while the session reports as live and busy",
    "Running status includes the main turn and background work",
    "Health reports an owned bridge or an honest delivery-mode live state",
    "The activity strip renders delivery-mode sessions during active turns",
    "Existing single-writer, exactly-once, and mid-turn safeguards remain intact"
  ],
  "code_refs": [
    {
      "path": "/api/sessions/<sdkId>/running",
      "symbol": null,
      "note": "Previously returned rows:[], source:'no-session', and turn.running:false during an active turn"
    },
    {
      "path": "/api/sessions/live",
      "symbol": null,
      "note": "Previously reported the active session as busy:false"
    },
    {
      "path": "/api/health",
      "symbol": null,
      "note": "Previously reported liveBridges:0 and a surviving-unadopted session with busy:null"
    }
  ],
  "related": [
    {
      "id": "ARCH-001",
      "relation": "see_also"
    },
    {
      "id": "BUG-022",
      "relation": "see_also"
    },
    {
      "id": "BUG-044",
      "relation": "see_also"
    },
    {
      "id": "BUG-068",
      "relation": "see_also"
    },
    {
      "id": "BUG-074",
      "relation": "see_also"
    },
    {
      "id": "BUG-083",
      "relation": "see_also"
    },
    {
      "id": "FEAT-065",
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
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-072-permanent-survivor-mode-invisible.md",
    "sha256": "117852803bd5f5238b939f80ecce278944362099ca6c65c1a459fbb2dc2b4752",
    "bytes": 15548,
    "original_title": "FEAT-065 delivery permanently defers adoption: session runs invisible in \"survivor mode\" forever",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared field by field with the supplied original; the symptom, cause, required behavior, safeguards, executed evidence, and undeployed state remain present.",
    "dropped": []
  }
}
```

# BUG-072 — Active delivery sessions disappear from status views

## Diagnosis

BUG-072 arose because near-continuous background command work kept the survivor drain hold from committing. The delivery gate then matched every user send before resume-from-disk could re-adopt the session. Turns continued through the unadopted survivor, but the server owned no bridge, so running, liveness, health, and the activity strip reported nothing.

## Evidence

During a demonstrably active turn, running returned `rows:[]`, `source:'no-session'`, and `turn.running:false`; live reported `busy:false`; health reported `liveBridges:0`, `state:'surviving-unadopted'`, `adopted:false`, and `busy:null`. Replies continued normally. The pre-fix clean-room HEAD worktree failed at 22/47 and reproduced an empty browser strip. `verify:bug-072-delivery-visible` then passed 47/47, while `verify:feat-065-delivery` passed 35/35 unmodified. Typecheck and leak-gate were clean. Additional matched pass tallies were 15/15, 96/96, 18/18, 5/5, 10/10, 33/33, 7/7, and 14/14.

## Implementation notes

Delivery must not permanently displace adoption. The lifecycle must either adopt before delivery, attempt ownership after each delivered result, or bound consecutive deliveries. Every active delivery-mode session must expose a main row and background work through one consistent authority. Preserve single-writer, exactly-once, and mid-turn protections.

## Verification plan

Restart with a background-holding survivor, then send successive messages. Confirm every message delivers while running shows the main turn, health reports ownership or an honest delivery-live state, and the activity strip renders the session. `verify:resume-refusal` was named without a recorded result.

## Migration and rollback

A later deploy-restart is required before the corrected behavior becomes live. The change has not been deployed.

## Risks

Changing adoption precedence could weaken single-writer, exactly-once, or mid-turn protections. Reporting delivery-mode activity without a single authority could also create contradictory status views.

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
