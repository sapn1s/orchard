# BUG-113 — the turn-end cut-sweep marks a live background agent's card "cut", while the strip shows it running

- **Status:** OPEN — pre-existing BUG-030 × BUG-037 collision (each fix right, intersection wrong); a fix must make strip, card and ledger agree at a boundary. FE (`public/app.js`) — serialize with any in-flight app.js lane.
- **Severity:** medium
- **Area:** frontend — running strip / agent cards / outcome ledger (`public/app.js`)
- **Reported:** 2026-08-19 by a session-lifecycle lane (which correctly declined to fix it — the file belonged to another lane)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## In plain terms

For any live background agent, at any turn boundary, two surfaces disagree about the same work: the running strip shows the agent **running**, and that agent's card reads **cut by shutdown**. Nothing is lost and no work is harmed — the agent really is still running, and it keeps running. But the disagreement is about *whether work is still running*, which is the one question this dashboard exists to answer, and a user who sees a card marked "cut" has every reason to believe their agent died. Two tickets were filed this week precisely because the tool misreported what was running; this is the same family.

It is **pre-existing, not a regression** from the recent session-lifecycle work. It is the intersection of two earlier fixes that were each correct on their own terms (BUG-030 and BUG-037). The session-lifecycle fix did not create it; it made it *visible*, because before that fix a re-announced background lane was not reliably kept running past the turn for the two surfaces to disagree about.

## The two fixes that collide

**BUG-030** established a client-side in-flight invariant: a card may show the in-flight spinner only while a live process can be behind it. Its turn-end enforcement (`settleCutAgents()` in the `turn-end` handler) settles **every** row still marked `running` at turn end to status `cut`. Its stated justification: *"after a turn's `result` the bridge sweeps its own `#agents`, so anything still running here is a zombie from a cut host CLI."* That premise was true when BUG-030 shipped.

**BUG-037** then established the opposite for one class of work: background subagents **outlive** the dispatching turn by design, and settling them at `result` was fabricating false death records. Its fix made the server bridge's `case 'result'` **skip** background tasks — no settle, no death record — so a live background agent is correctly still `running` after the turn, and is re-announced by the server so the strip keeps showing it.

**Where they conflict:** BUG-037 deliberately falsified the premise BUG-030 relies on. The bridge no longer sweeps background agents at `result`, so at every turn boundary a live background agent is legitimately still `running` on the client — and BUG-030's `settleCutAgents()`, which never learned about the background-task exclusion, sees exactly that row and marks it `cut`. Each fix is right; their intersection is wrong.

## What a fix must establish

The strip, the card, and the outcome ledger must **agree** about a given piece of work at a boundary, tested at the point they can disagree (a live background agent present at turn end). The invariant that must win is BUG-037's — a live, re-announced background agent is running and must not be reported dead — **without regressing** BUG-030's honest target: a genuine zombie, whose host CLI died and whose row nothing re-announces, must still settle to "cut by shutdown" rather than spin forever. In other words the client turn-end sweep must make the same distinction the server already makes (is this row a still-live background task, or a zombie of a dead CLI), instead of settling every still-`running` row. Preserve the invariant; do not pick one surface and paint the other to match it.

<!-- Not a human decision: the conflict has one defensible resolution (server liveness wins; the client sweep must stop overriding it for live background rows). A well-scoped bug, not a manufactured choice — so no Decision section. -->

## Context pack (grows — the "where to look", so no agent cold-starts)

- Files/functions in play:
  - `public/app.js` — `settleCut(cur)` (the exact function; sets `cur.agent.status='cut'`, flips the thread/card status via `state.threads`, and — for non-`tool` rows — calls `settleAgent()` which writes the settled ledger row). `settleCutAgents()` iterates every `state.agents` row still `running` and calls `settleCut`. Called from the `turn-end` handler. `scheduleCutSweep()` is the reattach half of the same invariant (the 1.5s post-ack snapshot sweep) and shares the misclassification risk.
  - Note the strip re-syncs from live server frames after the sweep (the agent is re-announced), while the card status and the settled "ran" ledger row do not re-open once `settleCut` ran — which is why the two surfaces end up disagreeing rather than both reading `cut`.
- The server-side counterpart that already draws the line: `agent-bridge.ts` `#backgroundTasks` (maintained from the SDK `background_tasks_changed` level signal), which `case 'result'` consults to skip background agents. The client sweep has no equivalent knowledge.
- Related tickets: BUG-030 (established the turn-end cut-sweep + the in-flight invariant), BUG-037 (established that background agents outlive the turn and made the server stop settling them; its 2026-08-10 fix entry already flags "a `local_bash` tool row of a live background agent is still settled by the sweep" as a known residual — this ticket is the agent-row sibling of that observation). Same misreports-what-is-running family as the two lifecycle tickets filed this week.
- Repro test: none yet — add one. Must FAIL pre-fix: drive a real session that dispatches a background agent, reach a turn boundary with that agent still running (re-announced), and assert the strip row, the card status, and the ledger row all read "running" — not a mix of running + cut. Anti-regression: a genuine cut (host CLI stopped, row not re-announced) must still settle to "cut by shutdown"; do not break BUG-030's zombie case.
- Known dependencies / blockers: `public/app.js` is a serialized frontend file — coordinate with any in-flight FE lane before editing.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-19 — filed (triage lane)
- **Understood:** The turn-end cut-sweep (`settleCut`/`settleCutAgents`, `public/app.js`) settles a live background agent's card and ledger row to `cut` at every turn boundary, while the strip re-syncs from the server and shows the same agent running. Evidence from a session-lifecycle lane: with its fix in place the strip correctly showed a re-announced background lane running after the turn, and the card for that same agent read `cut`. Pre-existing — the intersection of BUG-030 (settle every still-running row at turn end, premised on the bridge having already swept) and BUG-037 (bridge deliberately no longer sweeps background agents, so they are legitimately still running). The session-lifecycle work exposed it, did not cause it.
- **Changed:** nothing — triage only. No product code touched (file belongs to another lane).
- **Verified:** n/a (no fix). Mechanism read directly from `public/app.js` (`settleCut` at ~5500, `turn-end` handler at ~7404) and cross-read against BUG-030's and BUG-037's own fix entries.
- **Still open / handoff:** whoever takes it should teach the client turn-end sweep the same background-vs-zombie distinction the server's `#backgroundTasks` already encodes, so the strip, card, and ledger agree; keep BUG-030's genuine-zombie settle intact and prove both directions with a real background-agent session at a turn boundary. Given the file's regression history and that this sits on the session-liveness surface, an independent clean-room verify pass is warranted — self-verify is not the last word here.
