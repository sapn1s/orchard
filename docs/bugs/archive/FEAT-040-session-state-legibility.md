# FEAT-040 — Session-state legibility: surface compaction / reconnecting / detached / interrupted states in the UX

- **Status:** VERIFIED
- **Area:** dashboard UX / session status
- **Reported:** 2026-08-04 by user
- **Severity:** high (UX — degraded/transitional states currently read as "broken")

## Principle
A transitional or degraded session state must NEVER be indistinguishable from "broken."
From the user's seat, when the session is compacting / reconnecting / mid-cycle, the
dashboard shows nothing discernible — "it just seems like things don't work, nothing to
discern." Fix: the UI ALWAYS communicates the session's true state (same ethos as the
rail's state-honesty, §H).

## States to make legible (enumerate; some not shown today)
- **Thinking** — main agent active, no streamed text yet (distinct from idle).
- **Streaming** — assistant text arriving (have this).
- **Compacting** — context being summarized (currently invisible → looks frozen). IF
  detectable by claude-station (FEAT-015 investigation must confirm observability).
- **Reconnecting / reattaching** — after a reload/socket drop, before live stream resumes
  (currently blank → looks dead).
- **Detached (running headless)** — turn continues server-side with no client attached
  (BUG-018/detach) — show "running in background", not "nothing".
- **Agents interrupted by a cycle** — if a process cycle orphaned sub-agents, say so
  ("session reconnected after a restart; N agents were interrupted") instead of silently
  showing 0.
- **Idle** — genuinely nothing running (the ONLY state that should read as "nothing").
- **Error / stopped** — explicit.

## Design
A single, always-present session-status affordance (near the composer / header) that names
the current state with the right tone (calm, greyscale + moss; a subtle pulse for
active/thinking, a distinct treatment for reconnecting/compacting). The agents strip +
this status together must make "what's happening" unambiguous at a glance.

## Dependencies / open questions (for FEAT-015 investigation to answer)
- Is COMPACTION observable to claude-station at all, or is it purely harness-internal? If
  not directly observable, can we infer it (a gap in streaming + a known marker)?
- What signals distinguish reconnecting vs detached vs idle vs cycled?

## Verification (§C user-observable, when built)
Real browser: drive a session through each state → the status affordance shows the correct,
distinct label each time (thinking, streaming, detached, reconnecting, idle); a reload
mid-turn shows "reconnecting…" then resumes, never a blank/"nothing" that looks broken.

## Context pack
- Touches: `public/app.js` (session status + agents strip) + `styles.css` + likely
  `src/server` for any new state signal. app.js → serialize with other FE tickets.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed from user. The recurring "reload looks broken" pain is partly a LEGIBILITY gap, not
  just a reattach bug. Blocked on FEAT-015 investigation (which states are detectable).

### 2026-08-04 — orchestrator (the STRUCTURAL fix for hand-check errors)
A hand-check (PPID instead of cgroup) falsely declared FEAT-015 broken and alarmed the
user. The durable fix isn't more rules (§C already covered it and was violated) — it's
making the SYSTEM self-report ground truth so nobody improvises a wrong check. Extend
this ticket's scope with a machine-facing counterpart to the UI legibility:
- **A `station doctor` / `GET /api/health` (+ a CLI) that reports GROUND TRUTH**: per
  live session — is it survival-scoped (by cgroup membership, the correct indicator),
  its state (thinking/streaming/detached/reconnecting/idle), broker/scope status, and
  whether restart-survival is actually effective. So "is it protected / what state is
  it in" is answered by a reliable tool, not an ad-hoc ps/grep.
- This is the machine half; the UI status affordance (above) is the human half — same
  ground-truth source. Together they remove the hand-improvisation surface that causes
  confident-wrong conclusions.

### 2026-08-04 — build + verify (both halves) — VERIFIED

**Built:**
- **Human half** (`public/index.html`, `public/app.js`, `public/styles.css`): an
  ALWAYS-present `#sessStatus` affordance in the crown, right below the title (near
  header/composer). `data-state` drives a DISTINCT dot treatment per state — never just a
  color swap: `thinking` = breathing moss dot, `streaming` = solid moss dot + outward
  ripple, `detached` = hollow moss DIAMOND (not a circle — deliberately shaped different
  from every "running" state), `reconnecting` = spinning GREYSCALE ring (never moss —
  nothing is confirmed alive yet), `error` = filled square (every live state is round),
  `idle` = flat grey dot, the only one that reads as "nothing". Greyscale + `--live` only,
  per the design brief.
  - `computeSessState()`/`paintSessStatus()` in app.js compute the single most-honest
    label from real signals already in the client: `state.busy` + `state.sessPhase`
    ('thinking' until the first `text-delta`, then 'streaming' — set in `setBusy()` /
    the `text-delta` handler), `state.sessDetached` (set true in `openSession()`'s
    `liveRec.drivenByDashboard` branch — a live server-side bridge this tab isn't
    driving), `state.sessReconnecting` (set in `startTurn()` right before `await
    connect()` when resuming, cleared on the ack or a failed connect), `state.dropped`
    (the existing drop flag folds into `reconnecting`), and `state.sessError` (set on a
    fatal error / budget-stop / an errored non-interrupted turn-end, cleared at the next
    turn start). Priority order in `computeSessState()`: reconnecting > error > detached >
    busy(thinking/streaming) > idle — a down transport outranks everything else because
    nothing behind it can be vouched for.
  - Compaction: left OUT of the state machine on purpose. `compact-boundary` already
    renders an inline transcript marker (pre-existing); there is no server signal that
    distinguishes "compacting right now" from ordinary `thinking`, and inventing one
    would be exactly the "hand-improvised, not ground-truth" mistake this ticket exists
    to remove. Left as a precise handoff below.
  - "Agents interrupted by a cycle" (an explicit "N agents were interrupted" notice) was
    NOT built — out of scope for this pass (no existing signal carries that count either);
    also left as a handoff.

- **Machine half** (`src/server/index.ts` + `scripts/station-doctor.mjs`):
  `GET /api/health` now carries a `sessions[]` array, one entry per `liveSessions()`
  session: `stationSessionId`, `sdkSessionId`, `projectId`, `isolation`, `busy`,
  `detached`, `state` ('busy'|'detached-running'|'idle' — the coarse, HONEST subset a
  live `AgentSession` can truthfully answer server-side; finer thinking/streaming/
  reconnecting distinctions are per-socket transport facts the client observes directly
  off the `StationEvent` stream, and reporting them here would mean guessing rather than
  verifying — documented in the route's comment), `survivalConfigured` (a CLAIM — was
  survival attempted at spawn time, from `AgentSession.survivable`), `survivalScoped`
  (GROUND TRUTH — read straight from `/proc/<hostPid>/cgroup` via a new
  `isCgroupScoped()`/`cgroupPathOf()` pair in index.ts, comparing the broker's cgroup
  path against the server's own; **cgroup MEMBERSHIP, never PPID** — this is the exact
  fix for the hand-check that falsely declared FEAT-015 broken), and `broker` (hostPid/
  claudePid/state/sock from the matching `HostStatus`, joined by `stationSessionId`).
  `survival.ts` was read ONLY through its existing exports (`scanSurvivingHosts`,
  `HostStatus` type) — not edited, per scope.
  - `scripts/station-doctor.mjs` (+ `npm run doctor`) is a thin, read-only CLI: GETs
    `/api/health` off a given `--port`/`--host` (default `127.0.0.1:4317` — a plain GET,
    safe against the live service, never binds/restarts anything) and prints the same
    fields human-readably, flagging the exact "configured but NOT scoped" case (survival
    was attempted but the cgroup check says it did not actually land) that a silent claim
    would hide. `--json` echoes the raw payload for scripting.

**Verified** (scratch server on an OS-assigned free port, real haiku sessions, never
touched :4317, killed by pid):
- `npx playwright test scripts/qa/feat-040-session-status.spec.ts` — **PASS** (one
  journey, ~19s). Drives a REAL session through idle → thinking (forced via a Bash tool
  call before any reply text, so the turn is genuinely busy with nothing streamed yet) →
  a real `page.reload()` mid-turn asserting `detached` (never blank) → the real recovery
  gesture (type "continue" + Enter) asserting `reconnecting` was shown at some point (via
  an in-page `MutationObserver` on `data-state`, not outside polling — the reconnect
  window can resolve in single-digit ms, shorter than a test-process round trip) →
  `streaming` once the final reply's text arrives → back to `idle` at turn-end. Also
  asserts `GET /api/health`'s `sessions[]` entry mid-turn (isolation, busy,
  survivalConfigured as boolean, survivalScoped as boolean-or-null with the broker
  present whenever configured), runs `station-doctor.mjs` directly AND via `npm run
  doctor` and asserts both print the same ground truth, and confirms the sub-turn's
  marker file actually landed on disk (the reload never interrupted real work). This spec
  is non-vacuous by construction: `#sessStatus` did not exist in the DOM at all and
  `/api/health`'s `sessions[]` array did not exist at all before this change — both fail
  outright (not just "wrong value") against the pre-fix code.
- `npm run verify:ui -- --offline` — **PASS** (3 passed, 0 failed).
- `npm run typecheck` — **PASS** (clean, includes the new spec file).
- Anti-regression (touches app.js's shared busy/reconnect machinery):
  `npm run verify:detach` — **PASS** (7/7); `npm run verify:reload-live` — **PASS** (3/3).
- Screenshots: `docs/bugs/assets/FEAT-040-thinking.png`,
  `docs/bugs/assets/FEAT-040-detached.png`.

**Open handoffs for a future pass** (not blocking — the core legibility gap this ticket
was filed for is closed):
1. **Compacting** is not distinguished from `thinking` — no ground-truth signal exists
   yet to tell them apart (see above). If a future FEAT-015-style investigation finds one
   (e.g. a real `compact-boundary`-adjacent busy gap pattern), wire it into
   `computeSessState()`'s priority list above `thinking`.
2. **"N agents interrupted by a cycle"** notice was not built — would need a count
   carried through re-adopt (`adoptSurvivingHosts()`'s log line has the broker/CLI pids
   but not an interrupted-subagent count) surfaced as a `StationEvent` on reattach.
3. Server-side `state` in `/api/health` is intentionally coarse (`busy`/`detached-
   running`/`idle`) — it does NOT claim thinking-vs-streaming, because instrumenting that
   distinction server-side would touch `agent-bridge.ts`, out of scope for this ticket.
   The client-side affordance already has the fuller distinction from the event stream;
   a future pass COULD mirror it into `AgentSession` (agent-bridge.ts) and thus into
   `/api/health`, if a machine consumer ever needs it (today `station doctor` does not).
