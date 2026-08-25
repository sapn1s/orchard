```orchard-ticket
{
  "id": "BUG-113",
  "type": "bug",
  "title": "Background work is reported as dead while it is still running",
  "summary": "When a turn ends with a background agent still working, the running strip shows it running while that agent's own card reads cut by shutdown. The agent is genuinely alive and keeps going. The two displays disagree about the one question the dashboard exists to answer.",
  "impact_if_we_wait": "A person sees a card marked cut and reasonably believes their agent died, so they may redo or abandon live work. Bounded: display-correctness only. The agent keeps running, nothing is cancelled, and no stored data is affected.",
  "current_need": "Teach the turn-end sweep the same live-versus-dead distinction the server already makes, then prove strip, card and ledger agree.",
  "severity": "medium",
  "area": "Running strip and agent cards",
  "reported": "2026-08-19",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-20",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "At a turn boundary with a live background agent, strip, card and ledger all read running",
    "A genuine leftover row whose host process died still settles to cut by shutdown",
    "A test reproduces the mixed running-and-cut reading before the fix and passes after"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "settleCutAgents",
      "note": "iterates every state.agents row still running at turn end and settles each via settleCut"
    },
    {
      "path": "public/app.js",
      "symbol": "settleCut",
      "note": "sets cur.agent.status='cut', flips the thread/card status, and for non-tool rows calls settleAgent() to write the settled ledger row; the card and ledger never re-open once it has run"
    },
    {
      "path": "public/app.js",
      "symbol": "scheduleCutSweep",
      "note": "the reattach half of the same invariant (1.5s post-ack snapshot sweep); shares the misclassification risk"
    },
    {
      "path": "src/agent-bridge.ts",
      "symbol": "#backgroundTasks",
      "note": "maintained from the SDK background_tasks_changed signal and consulted by case 'result' to skip background agents; the client sweep has no equivalent knowledge"
    }
  ],
  "related": [
    {
      "id": "BUG-030",
      "relation": "depends_on"
    },
    {
      "id": "BUG-037",
      "relation": "depends_on"
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
    "archived_path": "docs/bugs/archive/BUG-113-turn-end-cut-sweep-marks-live-background-agents-cut.md",
    "sha256": "27d6551e342f7166ab45eacf7fbdb7d3e8be8014fe78f2021ce605fe41f2d494",
    "bytes": 8029,
    "original_title": "the turn-end cut-sweep marks a live background agent's card \"cut\", while the strip shows it running",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "The BUG-030 and BUG-037 collision, the three disagreeing surfaces, the named functions, the anti-regression target and the missing repro test all survive above.",
    "dropped": [
      "the ticket's own note explaining why it carries no decision section, which the null decision now records"
    ]
  }
}
```

# BUG-113 — Background work is reported as dead while it is still running

## Diagnosis

### Two correct fixes whose intersection is wrong

BUG-030 established a client-side in-flight invariant: a card may show the spinner only while a live process can be behind it. Its turn-end enforcement, `settleCutAgents()` in the `turn-end` handler, settles **every** row still marked `running` to status `cut`. Its stated justification was that after a turn's `result` the bridge sweeps its own `#agents`, so anything still running on the client is a zombie of a cut host CLI. That premise was true when BUG-030 shipped.

BUG-037 then established the opposite for one class of work: background subagents outlive the dispatching turn by design, and settling them at `result` was fabricating false death records. Its fix made the bridge's `case 'result'` skip background tasks — no settle, no death record — so a live background agent is correctly still `running` after the turn and is re-announced by the server.

BUG-037 therefore deliberately falsified the premise BUG-030 relies on. At every turn boundary a live background agent is legitimately still `running` on the client, and `settleCutAgents()` — which never learned about the background-task exclusion — sees exactly that row and marks it `cut`.

The strip re-syncs from live server frames after the sweep because the agent is re-announced. The card status and the settled ledger row do not re-open once `settleCut` has run. That asymmetry is why the surfaces end up disagreeing rather than both reading `cut`.

This is pre-existing rather than a regression. The recent session-lifecycle work only made it visible: before that fix, a re-announced background lane was not reliably kept running past the turn for the two surfaces to disagree about.

## Evidence

Filed on 2026-08-19 by a session-lifecycle lane, which correctly declined to fix it because the file belonged to another lane. BUG-037's 2026-08-10 fix entry already flagged a related residual — a `local_bash` tool row of a live background agent is still settled by the sweep — and this ticket is the agent-row sibling of that observation. Two other tickets were filed the same week because the tool misreported what was running; this is the same family. No repro test exists yet, and no clean-room check has run.

## Implementation notes

The client turn-end sweep must make the same distinction the server already makes — is this row a still-live background task, or a zombie of a dead CLI — instead of settling every still-`running` row. BUG-037's invariant is the one that must win. Do not pick one surface and paint the other to match it; preserve the invariant.

`public/app.js` is a serialized frontend file. Coordinate with any in-flight frontend lane before editing.

## Verification plan

Add a test that must FAIL pre-fix: drive a real session that dispatches a background agent, reach a turn boundary with that agent still running and re-announced, and assert the strip row, the card status and the ledger row all read running rather than a mix of running and cut.

Anti-regression: a genuine cut — host CLI stopped, row not re-announced — must still settle to "cut by shutdown", preserving BUG-030's honest target.

This ticket's class requires an independent clean-room pass before it can be marked verified.

## Risks

Widening the sweep's exclusion too far leaves a genuine zombie row spinning forever, which is the failure BUG-030 exists to prevent. `scheduleCutSweep()` carries the same misclassification risk as the turn-end path and must be considered alongside it.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-19 — filed (triage lane)
- **Understood:** The turn-end cut-sweep (`settleCut`/`settleCutAgents`, `public/app.js`) settles a live background agent's card and ledger row to `cut` at every turn boundary, while the strip re-syncs from the server and shows the same agent running. Evidence from a session-lifecycle lane: with its fix in place the strip correctly showed a re-announced background lane running after the turn, and the card for that same agent read `cut`. Pre-existing — the intersection of BUG-030 (settle every still-running row at turn end, premised on the bridge having already swept) and BUG-037 (bridge deliberately no longer sweeps background agents, so they are legitimately still running). The session-lifecycle work exposed it, did not cause it.
- **Changed:** nothing — triage only. No product code touched (file belongs to another lane).
- **Verified:** n/a (no fix). Mechanism read directly from `public/app.js` (`settleCut` at ~5500, `turn-end` handler at ~7404) and cross-read against BUG-030's and BUG-037's own fix entries.
- **Still open / handoff:** whoever takes it should teach the client turn-end sweep the same background-vs-zombie distinction the server's `#backgroundTasks` already encodes, so the strip, card, and ledger agree; keep BUG-030's genuine-zombie settle intact and prove both directions with a real background-agent session at a turn boundary. Given the file's regression history and that this sits on the session-liveness surface, an independent clean-room verify pass is warranted — self-verify is not the last word here.

### 2026-08-20 — diagnosis confirmed live; fix BLOCKED on the `public/app.js` lane (no code written)

- **Understood:** the filed diagnosis holds, and it is NOT already fixed by ARCH-003 or BUG-105 — both of
  those are server-side (`src/server/agent-bridge.ts`), and ARCH-003 is what makes this reachable rather
  than what fixes it. The chain, read end to end in the current tree:
  1. `agent-bridge.ts:3025` — the `result` sweep `continue`s on any row in `#backgroundTasks` /
     `#bgBornTasks`, and `:3070` on any `kind:'agent'` row whose owner chain holds a live background agent.
     Those rows stay `status:'running'` in `#agents`, and NO `agent-completed` is emitted for them.
  2. `agent-bridge.ts:3171` emits `turn-end`, then `:3188` force-pushes the running snapshot — which still
     lists those rows (`running-set.ts:206`: every `liveAgents()` row with `status:'running'`).
  3. `public/app.js:7451` — the client's `turn-end` handler calls `settleCutAgents()`, which at `:5552`
     settles EVERY unsettled row with `status === 'running'`, with no background knowledge and without
     consulting the server's answer. `settleCut` (`:5535`) flips the thread to `cut` and, for non-tool
     rows, calls `settleAgent()`, writing the durable "Cut by shutdown" ledger row.
  4. The snapshot from step 2 lands one frame later and repaints the strip from `state.snap`; the card,
     the thread status and the ledger row never re-open. Hence the three-way disagreement as filed.
  The `kind:'tool'` rows need no exception: the server settles them at `result` (BUG-030's carve-out), so
  they are absent from the fresh snapshot and the client settling them agrees with the server.
- **Changed:** nothing. The fix belongs in `public/app.js`, which is locked to an emergency lane (users
  currently cannot type into the app); this lane was instructed not to touch that file.
- **The fix, ready to land in one function** (`settleCutAgents`, `public/app.js:5549`): stop asserting
  death from the absence of a terminal frame; settle only rows the server's own post-`result` running set
  does not vouch for. Concretely — capture the candidate ids at `turn-end`, wait for the next
  `running-snapshot` whose `turn.running === false` (positive evidence it was computed at or after the
  `result`; it is force-pushed on the same socket one frame behind `turn-end`, with the 4s `pollRunning`
  as backstop), then settle exactly those candidates absent from its `running[]`. `snap.running[].id` is
  the `agentId`, so the join is direct. BUG-030's honest target survives: a zombie of a cut host CLI is
  absent from the fresh snapshot (`running-set.ts` empties `running` whenever the liveness authority does
  not vouch for the session) and still settles to "cut by shutdown". If no qualifying snapshot arrives at
  all, settle NOTHING — an unreachable server is already reported by `markSnapshotStale()`, and inventing
  a death there is the exact harm this ticket exists to stop. `scheduleCutSweep()` (`:5568`) needs no
  change: it already settles only rows the reattach replay did not refresh (`seenAt`), which is evidence.
- **Rejected, so nobody re-proposes it:** a server-only workaround — re-announcing each spared background
  agent with `agent-started` after `turn-end`, which does reset `settled:false` on the client — repairs
  the strip but leaves the already-written "Cut by shutdown" hairline card in the transcript: a second lie
  laid over the first. There is no server-only fix, because the client sweep settles unconditionally.
- **Verified:** nothing to verify — no code changed. The above is a read of the current tree, not a run.
- **Still open / handoff:** dispatch to the `public/app.js` owner the moment that lane clears. The change
  is roughly six lines inside one function and touches nothing else in the file.

### 2026-08-20 — landed exactly as specified above (`public/app.js` lane)

- **Changed:** `public/app.js`, commit `1c2eb52`. `settleCutAgents()` is gone, replaced by two functions
  either side of the evidence: `nominateCutAgents()` (called from the `turn-end` handler — it records the
  ids of every unsettled `running` row and settles NOTHING) and `settleCutAgentsAgainst(snap)` (called
  from `applySnapshot`, the single writer of `state.snap`, before its `renderStrip()` so the strip paints
  once from the reconciled state). The judgement runs only on a snapshot with `turn.running === false`,
  and settles only nominated ids absent from its `running[]`; ids the snapshot vouches for are released
  unjudged, since their own completion frames will settle them.
- **The clause that is the fix:** there is no path that settles a row without a qualifying snapshot in
  hand. If none ever arrives, the nominations simply stand and the rows keep spinning — which is what
  `markSnapshotStale()` already reports honestly. Death can no longer be asserted from absence.
- **Unchanged, deliberately:** `scheduleCutSweep()` (the reattach half — already evidence-based), and
  BUG-030's honest case, which still settles to "cut by shutdown" because a zombie of a cut host CLI is
  absent from the fresh snapshot.
- **Verified:** `node --check` and `npm run gate` (PASS, exit 0, unpiped). No behavioural test — the user
  has verification switched off while they are blocked. The single property worth a later check is the
  one named above: that no path settles a row without a qualifying snapshot.
- **Still open / handoff:** none for this ticket. An independent pass is warranted before closing, since
  this is regression-prone display-of-liveness code (`regressed-from: BUG-030`).
