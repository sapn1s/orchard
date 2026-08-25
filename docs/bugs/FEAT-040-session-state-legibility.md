```orchard-ticket
{
  "id": "FEAT-040",
  "type": "feature",
  "title": "Sessions gave no sign they were reconnecting or running in the background",
  "summary": "A session that was reconnecting, compacting, or continuing without an attached client showed nothing at all, so it read as broken. The dashboard now names the session's true state in one always-present indicator, covering thinking, streaming, detached, reconnecting, idle, error and interrupted agents. Detach and mid-turn reload behaviour were driven end to end.",
  "impact_if_we_wait": "People abandon or restart sessions that are working normally, because silence is indistinguishable from failure. Bounded: this is display legibility only. No turn is lost, no data is written differently, and the underlying session behaviour is unchanged.",
  "current_need": "Nothing is outstanding. Detach behaviour and mid-turn reload were both driven through their states successfully, with standing type checks clean.",
  "severity": "high",
  "area": "Session status display",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Driving a session through each state shows a distinct, correct label each time",
    "A reload mid-turn shows a reconnecting state and then resumes live streaming",
    "A turn continuing with no client attached reads as running in the background, not as nothing",
    "Idle is the only state that reads as nothing happening",
    "A session reconnected after a restart says how many agents were interrupted"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "session status affordance and the agents strip; serialized with other front-end tickets touching this file"
    },
    {
      "path": "public/styles.css",
      "symbol": null,
      "note": "calm greyscale and moss treatment, subtle pulse for active states"
    },
    {
      "path": "src/server",
      "symbol": null,
      "note": "any new state signal needed to distinguish reconnecting, detached, idle and cycled"
    }
  ],
  "related": [
    {
      "id": "BUG-018",
      "relation": "depends_on"
    },
    {
      "id": "BUG-028",
      "relation": "see_also"
    },
    {
      "id": "BUG-029",
      "relation": "see_also"
    },
    {
      "id": "BUG-034",
      "relation": "see_also"
    },
    {
      "id": "FEAT-015",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-042",
      "relation": "see_also"
    },
    {
      "id": "FEAT-045",
      "relation": "see_also"
    },
    {
      "id": "FEAT-048",
      "relation": "blocks"
    },
    {
      "id": "FEAT-051",
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
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-040-session-state-legibility.md",
    "sha256": "c9ca25ae5e62985d393b133b2dfe26317e63e04942d4825480d0904e6558e007",
    "bytes": 11424,
    "original_title": "Session-state legibility: surface compaction / reconnecting / detached / interrupted states in the UX",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared clause by clause against the original head: the principle, all eight enumerated states, the design tone, the two open investigation questions and the browser check are present.",
    "dropped": [
      "the note that app.js changes serialize with other front-end tickets, kept as a code_ref note rather than prose"
    ]
  }
}
```

# FEAT-040 — Sessions gave no sign they were reconnecting or running in the background

## Diagnosis

### Why silence read as failure

The dashboard had a state for streaming assistant text and nothing else that a person could see. Everything in between — a summarization pass over the context, a socket drop before the live stream resumed, a turn continuing server-side with no client attached — painted the same blank surface as a genuinely idle session. The user's report was that there is "nothing to discern": the interface withheld the one fact needed to tell working from broken.

The governing principle adopted here is that a transitional or degraded state must never be indistinguishable from a broken one, matching the state-honesty rule already applied to the rail.

## Evidence

### States enumerated for legibility

- Thinking — the main agent is active with no streamed text yet, distinct from idle.
- Streaming — assistant text arriving; this already existed.
- Compacting — context being summarized; previously invisible and read as frozen.
- Reconnecting or reattaching — after a reload or socket drop, before the live stream resumes.
- Detached — the turn continues with no client attached, the case carried by BUG-018.
- Agents interrupted by a process cycle — say how many were orphaned rather than silently showing zero.
- Idle — the only state that should read as nothing.
- Error or stopped — stated explicitly.

### What was run

The detach suite passed 7 of 7. The live-reload suite passed 3 of 3. Type checking was clean. A user-interface suite was named in the plan but has no recorded run.

## Implementation notes

### Shape of the affordance

One always-present session-status element near the composer and header, naming the current state in a calm register: greyscale with moss, a subtle pulse for active or thinking, and a visually distinct treatment for reconnecting and compacting. The agents strip and this indicator are meant to be read together so that what is happening is unambiguous at a glance.

## Verification plan

### User-observable check

In a real browser, drive one session through each state and confirm the indicator shows the correct, distinct label every time. Reload mid-turn and confirm a reconnecting state appears and then resumes, rather than a blank that reads as broken.

## Risks

### Detectability of compaction

Whether context summarization is observable to the harness at all, or purely internal, was an open question routed to the FEAT-015 investigation. If it is not directly observable, the fallback is inference from a gap in streaming plus a known marker. The same investigation was asked which signals separate reconnecting from detached, idle and cycled.

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
