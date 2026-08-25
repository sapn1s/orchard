# BUG-043 — closing/switching a session kills its live background agents 150s later

- **Status:** VERIFIED 2026-08-11 — arm C 27/27 (N=3; agents run to completion after socket close), both extra fuses guarded + tested, review findings 1-5 addressed; committed 26014ba. Restart-path successor: BUG-044.
- **Area:** session close/detach decision (server) — concrete instance of ARCH-002
- **Reported:** 2026-08-10, found by BUG-037's controlled experiment

## Proven behaviour (N=3 per arm, real CLI + real background subagents, heartbeat FILE as ground truth)
| arm | condition | beats/120 | outcome |
|---|---|---|---|
| A | turn ends immediately after dispatch, tab open | 120,120,120 | full run (~240s past turn end) |
| B | parent keeps working ~25s, tab open | 120,120,120 | full run |
| C | as A, but TAB CLOSED 10s after turn end | 80,80,80 | **killed at 150.1 / 149.2 / 150.0s** |
Corroboration per trial: broker status flipped to `draining` at the tab-close millisecond; the
systemd scope ended ~151s later; every `.err` file EMPTY — matching the real incidents' silence.

## Root cause (named, with lines)
- `src/server/index.ts:2791-2792` (ws close) and `:2770-2771` (the client's explicit `{type:'close'}`
  sent by `closeSocket()` in `public/app.js:4643` on EVERY session switch / New / navigation /
  reopen) decide `busy ? detach() : close('socket closed')`.
- **`busy` is the only signal, and background agents are invisible to it**: at `result` the bridge
  sets `busy=false` and settles running agent rows (`agent-bridge.ts:1871-1907`). A session with live
  background work therefore reads as IDLE, so a socket drop CLOSES it.
- `close()` → `survivalHandle.reap()` → broker `gracefulReap()` (`session-host.mjs:267-284`):
  status→draining, immediate stdin EOF, then UNCONDITIONAL `SIGTERM` at 150_000ms / SIGKILL at
  160_000. The CLI does not exit on EOF while a background agent works — hence exactly ~150s more
  heartbeat, then death.

## Why it is ARCH-002's instance
The close decision needs to know whether any work OUTLIVES the turn. Nothing declares that, so it
substituted `busy` — a turn-scoped signal — for a work-lifetime question.

## Fix shape
The close/detach decision must consult "is any agent still running", using tracking that survives
the turn boundary (BUG-037's `#backgroundTasks` is exactly that signal). A session with live
background work must DETACH, never close, on socket drop. Keep the reap fuse for genuinely finished
sessions.

## Untested but code-evident follow-ups (from the same investigation)
- The detach path has the same fuse: close-on-detach 3s after `result` (`agent-bridge.ts:1965-1966`).
- `CLAUDE_STATION_HOST_ABANDON_MS` (default 120s) is a SECOND independent 2-minute killer — a strong
  candidate for FEAT-061's agent "dying ~2 min later".
Both must be audited against the same "does live background work exist?" question.

## Verification (must FAIL pre-fix)
Reproduce arm C: background agent + close the tab → with the fix the agent runs to completion and
the session detaches instead of closing; a session with NO live agents still closes and reaps as
before (no leak); the detach-fuse and ABANDON_MS paths tested for the same defect. Anti-regressions:
verify:detach, verify:close-busy-detach, verify:restart-survives, verify:zombie-busy,
verify:liveness-conformance, verify:running-snapshot, typecheck.

## Activity log (APPEND-ONLY)
### 2026-08-10 — orchestrator
- Filed from BUG-037's experiment. NOTE for the fixer: BUG-037 refuted TWO orchestrator hypotheses
  before this was found (host deaths; end-of-turn dispatch). Trust the experiment table above, not
  the earlier narrative in BUG-037.

### 2026-08-10 — CROSS-PROVIDER REVIEW of the partial fix (openai/codex, dispatch run 019fefc7-7813-7350-bca9-72bd0eb44760)
Context: the fix agent was cut by the Anthropic weekly limit mid-work; the uncommitted diff was
reviewed adversarially by the OTHER provider (fresh context, read-only). VERDICT: PROBLEMS.
Findings VERBATIM (relay to the fixer untouched — no paraphrase):

1. Race: a socket can close before `background_tasks_changed` is processed. For a reported runtime,
   an empty set is immediately treated as authoritative "no background work" (agent-bridge.ts:1541),
   so index.ts:2358 can close and reap before a later non-empty signal reaches agent-bridge.ts:2105.
   No "signal observed/initialized" state or grace period distinguishing "empty level reported" from
   "no level received yet."
2. The 120-second broker-abandon fuse remains UNGUARDED. session-host.mjs has no background-work
   state; loss of its server connection unconditionally arms the timer (session-host.mjs:203) →
   gracefulReap() (:205); with the foreground turn ended that immediately EOFs stdin (:272) then
   unconditional SIGTERM/SIGKILL (:281). The new verification does NOT exercise this: ordinary ws
   detachment leaves the server-to-broker connection open, so the abandon timer never arms in test.
3. The 3s close-on-detach fuse is guarded but can LEAK indefinitely: declines to close on yes/unknown
   (agent-bridge.ts:1577), re-armed only by an observed EMPTY background level (:2109). A missed
   terminal signal / stuck task id / SDK failure keeps the session+CLI registered forever — no
   bounded stale-state recovery or liveness-based cleanup.
4. `unknown → detach` is work-safe but knowingly leak-prone, and the claim that no shipped runtime
   reaches it is INCORRECT: codex declares the signal absent (codex-runtime.ts:307); any
   task_started permanently sets #everStartedWork (agent-bridge.ts:2177); thereafter workLifetime()
   returns unknown (:1555) and neither socket release nor the detach fuse ever reaps automatically.
5. Stale-state clear on init (agent-bridge.ts:2118) is directionally correct but resolves neither
   the pre-signal race (1) nor stale-positive leakage after a missing empty update.
6. CONFIRMED GOOD: both socket-close paths consult the shared lifetime decision (index.ts:2813
   explicit close; :2834 raw ws close) — correctly centralized.

### 2026-08-11 — FIX + verification (subagent; span includes a weekly-limit cut and resume)
- **Confirmed lines before editing:** exactly as filed — `src/server/index.ts` ws-close and explicit
  `{type:'close'}` both decided `busy ? detach() : close(...)` (the BUG-018-commented handler and
  `ws.on('close')`); `busy` cleared at `result` (agent-bridge.ts `case 'result'`); `close()` →
  `#survivalHandle.reap()` → broker `gracefulReap()` with the unconditional 150s SIGTERM
  (session-host.mjs). Code had not moved.
- **THE FIX (ARCH-002 option 1, at the runtime seam):**
  - `runtime.ts`: `RuntimeCapabilities.backgroundLifetime: 'reported' | 'absent'` — each engine
    DECLARES whether it names work that outlives a turn — and a `WorkLifetime` answer type whose
    `outlivesTurn` is three-valued (`yes|no|unknown`, `unknown` never coerced). Claude: `'reported'`
    (`background_tasks_changed` level). Codex: `'absent'`.
  - `agent-bridge.ts` `workLifetime()`: `yes` when the level names ids; for a reported engine `no`
    only when the empty level is authoritative; for an absent engine `unknown` while an agent row is
    still running, `no` once all rows settled.
  - `index.ts` `releaseSocketSession()` — ONE decision for both socket paths (review finding 6
    confirms the centralization): busy ⇒ detach (BUG-018 unchanged); else lifetime `yes|unknown` ⇒
    DETACH with a logged, quotable reason; only `no` ⇒ close. Idle sessions close+reap as before.
- **THE `unknown` TRADE-OFF (decided, not silent): `unknown` biases DETACH.** A wrong close destroys
  in-flight work silently and unrecoverably (this ticket's whole cost); a wrong detach leaves one
  visible, hand-closable CLI, and is now BOUNDED (below). Asymmetric costs ⇒ the tie keeps the work.
  `unknown` is transient by construction: (1) reported engine inside the pre-signal window —
  resolved by the level frame or a 120s expiry; (2) absent engine (codex) with a running agent row —
  resolved when the row settles; every row settles at `result` on such an engine, so idle codex
  sessions answer `no` and close exactly as before (this replaced the `#everStartedWork` latch the
  cross-provider review's finding 4 correctly called a forever-leak).
- **Cross-provider review findings, all five addressed:**
  1. *Pre-signal race* — measured live (SDK probe): the level frame LAGS the dispatching turn's
     `result` by ~4s. Guard: the bridge records any assistant `tool_use` with
     `run_in_background:true` (`#bgDispatchAt`); until a level frame arrives (which clears it) or
     120s expires, an empty level answers `unknown`, not `no`.
  2. *120s broker-abandon fuse* — guarded IN THE BROKER: session-host.mjs now sniffs
     `background_tasks_changed` off the stdout it already parses (`state.backgroundLive`); the
     abandon expiry DECLINES and re-arms while background work is declared live, reaps normally the
     moment the level empties (bounded), and a CLI that never emits the signal keeps byte-identical
     pre-fix behaviour. Tested directly (fake CLI, ABANDON_MS=2000, no client): guarded/bounded/
     control all green — the reviewer was right that a ws-drop test can never arm this fuse.
  3. *Unbounded yes/unknown leak* — the close-on-detach fuse is now a re-checking LOOP (3s then
     30s): closes on `no`, closes when the process probe (liveness authority's rung — no new check)
     says the CLI is dead whatever the lifetime claims, re-arms otherwise. A LIVE process with live
     work stays open indefinitely on purpose.
  4. *codex reaches unknown permanently* — true of the draft; fixed by replacing `#everStartedWork`
     with row-based evidence (see the trade-off above).
  5. *init-clear insufficiency* — stronger than the reviewer knew: the clear was actively WRONG.
     Live probe showed the CLI emits a FRESH `init` when a task notification wakes it —
     `background_tasks_changed [live work]` immediately followed by `init`, wiping the level the
     engine had just asserted (this, not the race, is why the first post-fix arm C run still
     failed). Removed: one AgentSession drives one CLI process; the level's REPLACE semantics are
     the staleness correction, a resume constructs a fresh session.
- **Verification (`scripts/verify-close-background-detach.mjs`, new; scratch ports/dataDirs, kill by
  pid, :4317 untouched). Pre-fix at pristine HEAD (worktree): FAILED exactly as predicted — 2/2
  trials closed the session, broker `draining` at the close millisecond, heartbeat CUT (14-15/240
  beats), no DONE; and a 3-trial run on the draft fix failed identically, which is what exposed
  finding-5's init-clear. Post-fix: **27/27, arm C N=3** — per trial: work outlives turn (measured),
  session DETACHES (registry + logged reason), broker never `draining` across the whole 240s
  (covers the close-on-detach fuse), agent runs to completion (241/240 beats + DONE), then NO LEAK
  (session closes, broker+CLI pids die). Both decision sites covered (explicit `{type:'close'}` ×2,
  raw `ws.close()` ×1). Controls: idle session closes+reaps; broker abandon net guarded/bounded/
  control green.
- **Anti-regressions:** detach 7/7; close-busy-detach 13/13; restart-survives 15/15;
  liveness-conformance **96/96** incl. L4 regrowth guard (re-run after all edits: clean);
  running-snapshot 47/47; health-survivor 14/14; codex-runtime 54/54 (expectation updated for the
  new capability field); typecheck clean. **zombie-busy 35/39: PRE-EXISTING** — the same four
  D-scenario checks fail identically at pristine HEAD in a clean worktree (FEAT-061 already
  recorded a clean-room suite failure); not caused by and not maskable by this change.
- **For the orchestrator (package.json not edited per charter):** add
  `"verify:close-background-detach": "node scripts/verify-close-background-detach.mjs"`.
- **Residuals, named:** (a) boot-time re-adopt (`adoptSurvivingHosts`) SIGTERMs a surviving broker
  whose `gracefulReap` escalation is still unconditional at 150s — a server RESTART during live
  background work remains a killer on that path (restart territory, out of this charter; the abandon
  net no longer is). (b) The `result` sweep can still settle a background row born inside the
  pre-signal window on a later turn's boundary — BUG-037's open end-to-end item, unchanged here.
- **Closing assessment.** Symptom of the deeper flaw ARCH-002 names, and this fix is its option 1
  made real at the seam: lifetime is now DECLARED (capability + level + observed dispatch), never
  inferred, and both fuses + the close decision consume the same single answer (`workLifetime()`),
  so the guess cannot regrow per-call-site the way liveness checks did before ARCH-001. What this
  round adds to the record: the engine's own signals violate the assumptions comments encode
  (`init` is NOT once-per-process; the level LAGS the result) — both were found only by probing the
  live SDK, and the first draft of this very fix shipped both bugs. The cross-provider review earned
  its cost: finding 2's "your verification never arms the fuse it claims to cover" was a §C-grade
  catch. Confidence: HIGH for the mechanism (deterministic, N=3, both paths, controls non-vacuous);
  MEDIUM that no third killer path exists (the re-adopt residual is documented, not tested).

### 2026-08-12 — board hygiene: closed to Done (verified + committed)
- Status normalized FIXED→VERIFIED (the board row said "queued", stale). The 2026-08-11 fix entry
  is the evidence: arm C 27/27 (N=3), both socket-close decision sites covered, both fuses
  guarded/bounded, all five cross-provider findings addressed. Committed `26014ba` ("BUG-043:
  socket close no longer kills live background agents").
- Deploy: the restart-path half is BUG-044 (VERIFIED, committed `ee79e5b`), whose header still
  records "requires a later DEPLOY — not deployed"; this socket-close fix ships on that same service
  restart. Board Done = verified+committed (deploy is tracked in-ticket, cf. BUG-045 in Done), so
  → Done.
