```orchard-ticket
{
  "id": "BUG-037",
  "type": "bug",
  "title": "Background work was falsely reported as dead",
  "summary": "Background work is now settled without false death records, and the related socket and restart failure was fixed through successor tickets. The liveness checks passed with type checking clean. One end-to-end anti-regression remains explicitly assigned to those successors.",
  "impact_if_we_wait": "The resolved fault could misstate whether background work survived and obscure the real restart cause. Bounded: this affected liveness reporting and in-process agents, not stored session data, and the remaining end-to-end coverage is tracked separately.",
  "current_need": "Treat this ticket as closed: the liveness behavior passed its conformance checks, and type checking stayed clean.",
  "severity": "not_recorded",
  "area": "Background agent liveness",
  "reported": "2026-08-09",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-12",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Turn completion does not create false death records for background agents",
    "Socket detach and reattach do not falsely imply that the host exited",
    "A genuinely finished host still exits without leaking",
    "The remaining end-to-end anti-regression stays assigned to successor tickets"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "ARCH-003",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-022",
      "relation": "see_also"
    },
    {
      "id": "BUG-034",
      "relation": "see_also"
    },
    {
      "id": "BUG-041",
      "relation": "see_also"
    },
    {
      "id": "BUG-043",
      "relation": "see_also"
    },
    {
      "id": "BUG-043",
      "relation": "superseded_by"
    },
    {
      "id": "BUG-044",
      "relation": "superseded_by"
    },
    {
      "id": "BUG-068",
      "relation": "see_also"
    },
    {
      "id": "BUG-096",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-105",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-113",
      "relation": "blocks"
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
    "archived_path": "docs/bugs/archive/BUG-037-host-process-exit-orphans-agents.md",
    "sha256": "5721b9417965befa82be0cb86a82ea51fabab7bc991c0714476134924957996a",
    "bytes": 24776,
    "original_title": "what ends the orchestrator's host CLI mid-flight? (agents orphaned, cause unknown)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied original; its observation, evidence limits, hypotheses, investigation plan, successor resolution, executed checks, and residual coverage all remain represented.",
    "dropped": []
  }
}
```

# BUG-037 — Background work was falsely reported as dead

## Diagnosis

The original report attributed orphaned agents to a host CLI exit. Later work established that no host CLI had exited. Turn-end settling created false death records, while a socket and restart actor caused the separate lifecycle behavior that the original framing conflated with host death.

## Evidence

At observation time, the live resumed CLI was 81 seconds old despite the longer session, and two host scopes were live. The service had not restarted, and the user journal showed no OOM kill. Harness traffic confounded the count of recently ended scopes. After the successor fixes, `verify:liveness-conformance` passed 96/96, an adjacent unnamed tally passed 3/3, and `typecheck` was clean.

## Implementation notes

The investigation considered reconnect replacement, session limits, verification traffic colliding with live sessions, and broker drain behavior. The completed successor work corrected false turn-end death records and the socket or restart actor. The remaining end-to-end anti-regression was carried explicitly in BUG-043 and BUG-044.

## Verification plan

The original plan required deterministic reproduction without concurrent harness traffic, host PID observation across detach and reattach, repeated survival checks with a dispatched subagent, and confirmation that genuinely finished hosts still exit. `verify:restart-survives`, `verify:zombie-busy`, and `verify:mcp-attach` were named, but this ticket records no results for them.

## Migration and rollback

Resolution moved to successor tickets because the original host-exit framing was incorrect. The outstanding end-to-end anti-regression remains named there rather than being silently closed here.

## Risks

Harnesses create real sessions and host scopes, so uncontrolled scope counts can falsely implicate production lifecycle behavior. Exit reasons, stderr, stop reasons, and same-session replacement timing are needed to distinguish causes.

## Activity log (APPEND-ONLY)
### 2026-08-09 — orchestrator
- Filed from the user's challenge. Evidence collected + explicitly separated into solid vs
  confounded (agent test traffic inflates scope churn). Cause NOT established; hypothesis 1
  (reconnect race defeated by zombie-busy) is the strongest lead and is coupled to BUG-033/034 —
  sequence after those land, or as part of the same liveness redesign.

### 2026-08-10 — DATED DATA POINT (from the FEAT-057 outcome ledger)
The new outcome ledger caught a host-level event with timestamps:
- `general-purpose (Build FEAT-059 scratch project)` ended `2026-08-10T05:59:01.936Z`
- `the main turn` ended `2026-08-10T05:59:01.939Z`
**3 ms apart** — a subagent and its parent turn cannot fail independently that closely; this is the
host CLI dying and taking its in-process agents with it, i.e. exactly this ticket's phenomenon,
now with an exact timestamp to correlate against journalctl / broker status files / scope stop
records. The recorded CAUSE was wrong (see BUG-041), so the ledger tells us WHEN and WHAT, not yet
WHY — but "same-millisecond cluster ⇒ host-level" is a signal the investigation should use, and
arguably something the ledger itself should report as one event rather than N deaths.
Investigation hint: FEAT-059's agent left partial edits (paths.ts, registry.ts) and its ticket
OPEN, so the work was genuinely mid-flight — not a clean finish misreported.

### 2026-08-10 — THIRD host-death cluster (now a repeating pattern destroying real work)
`general-purpose (Build FEAT-061 independent verifier)` ended 09:18:55.870Z and `the main turn`
ended 09:18:55.871Z — **1 ms apart**. Third occurrence of the same signature (see the 05:59:01.936/
.939 pair above). Cumulative cost so far: FEAT-059's agent killed mid-work, FEAT-061's agent killed
mid-work, plus the earlier pair — each requiring a resume and losing partial context.
This is no longer an occasional annoyance; it is the most expensive open defect on the board and
should be prioritised above further feature work. The ledger now gives exact timestamps to
correlate against journalctl, broker `.err` files, scope stop records, and CLI exit codes.
Note the recorded CAUSE is again the misattributed pending-MCP notice (BUG-041) — WHEN is reliable,
WHY is not.

### 2026-08-10 — DIAGNOSED: NOTHING KILLED THE HOST. The ticket's premise is false.
**The actor is `agent-bridge.ts`'s own `case 'result'` sweep. No process died in any cluster.**

WHAT WAS RULED OUT, AND HOW (ground truth, controlled for the agent-test-traffic confound):
- **The host was ALIVE across both dated clusters.** Cluster 3 (12:18:55.870 local): host
  `h-msn0oxmh-ei8gqt` started 12:16:40.889 (journal: `Started [systemd-run] … session-host.mjs`)
  and its broker/CLI pids 3455172/3455179 were *still running* 20 min later at diagnosis time.
  Cluster 2 (08:59:01.936): host `h-msmtjm60-yph2x3` started 08:56:35 and its scope did not stop
  until 09:09:09. A host cannot be killed at a time it demonstrably survived.
- **The hypothesis under test — "a reconnect concludes no live bridge and starts a fresh
  `--resume`, ending the old CLI" — is DISPROVEN for these clusters.** It predicted a host end plus
  a new host for the same sdk id within seconds; the journal shows no host start or stop anywhere
  near either timestamp.
- **Reaper / `dropDeadSurvivorHost` false-positive: disproven, positively, not by design argument.**
  The reap and transport-death paths call `#recordSessionEnd()`, whose wording is "the session
  ended while work was in flight (…)". That string appears in ZERO of the six ledger records; all
  six carry the `case 'result'` turn-end wording. The reaper never ran.
- **systemd / OOM / SIGTERM: ruled out.** No OOM kills, no scope stop, no `SIGTERM — closing
  sessions` in the user journal at either timestamp.
- **Usage/session limit: ruled out.** The latched cause is the non-fatal pending-MCP notice
  (BUG-041), not a quota wall, and the turns ended `is_error:false`.

THE ACTUAL MECHANISM (`src/server/agent-bridge.ts`, `case 'result'`):
the sweep asserted *"Any agent still marked running at turn end has ended one way or another."*
That is **false for background subagents**, which outlive the dispatching turn by design. On every
`result` the sweep settled them `completed` and wrote a DEATH record for each. The main row is
written 1 ms later by the adjacent `if (this.lastProviderError && !interrupted)` branch — so the
"main turn + subagent 1-3 ms apart" signature is **one synchronous `for` loop in one process**, not
two events and not a process dying. It also explains BUG-041's shape: the latched non-fatal MCP
notice is what makes the `main` row appear at all, which is why only the fresh-host clusters have
the pair (both fired ~2.3 min into the first turn on a just-started host, while serena was booting).

PROOF THE RECORDS ARE FALSE POSITIVES — all four "dead" agents kept working:
| agent | recorded dead | last transcript append | delta |
|---|---|---|---|
| FEAT-059 (`ade5f84c…`) | 08:59:01 | 09:08:36 | **+575 s** |
| FEAT-060 (`a3477ee8…`) | 09:04:13 | 09:08:02 | **+229 s** |
| FEAT-061 (`a9a574d3…`) | 12:18:55 | 12:29:25 | **+629 s**, still running at diagnosis |
| BUG-037 (`a8d3e168…`) | 12:23:36 | 12:29:37 | **+361 s**, *this investigation, alive while "dead"* |
Each also landed its commit AFTER its recorded death (d8cb6a7 09:08:53, e4ee859 09:08:24,
dc3f84c 12:20:12). Cost accounting reverses: the three agents were never killed — the FALSE record
reached the orchestrator through `takeBriefing()` as "N agents ended without completing", and it
abandoned and re-dispatched live work on the strength of it. The defect's cost was the *report*.

FIX (contained, fail-safe) — `src/server/agent-bridge.ts`:
- `#backgroundTasks: Set<string>`, maintained from the SDK's `background_tasks_changed` LEVEL
  signal (REPLACE semantics), cleared on `init` (the level is per-CLI-process).
- `case 'result'` skips agents in that set: no settle, no outcome record. They settle on their own
  terminal frame via the existing evidence-based `task_updated` / `task_notification` handlers.
- Foreground agents and `#recordSessionEnd()` (real reap/transport death) are untouched, so a
  genuine death is still recorded. An engine that never emits the signal leaves the set empty and
  gets byte-identical pre-fix behaviour.

VERIFY:
- `npm run typecheck` — **PASS**.
- `npm run verify:liveness-conformance` — **96/96 PASS**, including the L4 regrowth guard (the fix
  adds no new liveness rung).
- Evidence source proven live, scratch CLI capture in `/tmp/bug037-repro/out.jsonl` (own cwd, own
  process, never touched :4317): `background_tasks_changed {tasks:[{task_id:"add5df527ee0aea88",
  task_type:"local_agent"}]}` is emitted *before* `task_started`, and emptied (`tasks: []`) when
  the work ends — so the set is populated exactly when a `result` would otherwise fabricate the
  death, and cannot suppress a later real one. **PASS.**
- **NOT verified end-to-end:** "a `result` with a live background agent writes no record" needs a
  stream-input driven scratch session; the `-p` print-mode repro holds the turn open until
  background work settles, so it cannot produce that turn boundary. Left as the anti-regression to
  build next.
- Residual, known and deliberate: a `local_bash` ('tool') row belonging to a live background agent
  is not in `background_tasks_changed` and is still settled by the sweep. None of the six real
  records were tool rows; fixing it means parenting tool rows to their agent, which is not
  contained here.

FOR THE LEDGER ITSELF: the same-millisecond cluster should be reported as ONE event, and the
briefing should not be able to tell an orchestrator that a running agent is dead — that is what
turned a bookkeeping bug into three abandoned dispatches.

**Closing assessment.** Symptom of a deeper design flaw? **Yes, and it is the same class ARCH-001
was built to end, one level up.** ARCH-001 made every *process* liveness answer come from one
authority and forbade re-deriving it locally — and the regrowth guard (L4) passes on this code,
because `case 'result'` never asked about a process. It asserted from a *lifetime model*: "the turn
contains its agents". That model is a rung of ground truth nobody named, so nobody enforced it, and
the one place holding it was allowed to be wrong in private — exactly the shape (a surface deciding
"is X still running" from a partial signal it computed next to itself) that eight tickets already
paid for. The authority answers "is this process alive"; nothing answers "does this work outlive
the turn that started it", so the sweep guessed, and `outcomes.ts`'s §C honesty rules could not
help — they police *fabricating a cause*, while this fabricated the *event*, and every honesty
check downstream faithfully reported a death that never happened.

Two lessons worth more than the fix. First, the ledger fed its own false report back to the
orchestrator through `takeBriefing()`, which then destroyed real work — a read-only observability
feature became load-bearing without ever being treated as such; anything injected into a turn is
control flow, not telemetry, and needs the evidence standard of a refusal. Second, this ticket
spent two days investigating process death because the *first* observation named a mechanism
("host process exit orphans agents") instead of a phenomenon ("agents reported dead"), and every
subsequent round inherited the frame — including the hypothesis this round was handed. The
falsifying evidence was always one command away (`ls` the agents' own transcripts), and the
decisive control turned out to be the investigating agent itself, recorded dead while running.

### 2026-08-10 — ORCHESTRATOR CORRECTION: these were NOT host deaths (evidence overturns the framing)
Inline read-only forensics (the dispatched investigator kept dying, so the orchestrator ran it):
- `journalctl --user` today shows exactly THREE `Started [systemd-run] … session-host.mjs` events
  for the real dataDir; the current host started **12:16:40 local (09:16:40 UTC)** and has NOT
  restarted since.
- The two reported "deaths" at **09:18:55Z** and **09:23:36Z** fall INSIDE that host's continuous
  life. A host that never restarted cannot have died.
- No systemd scope stop at either timestamp, no `oom-kill`/`killed process` anywhere today, and
  every broker `.err` file is EMPTY (the CLI said nothing on the way out).
So the earlier "3rd/4th host-death cluster" entries in this ticket are WRONG — they were the
outcome ledger's false positives (BUG-041) repeated by the orchestrator without checking. Recorded
here rather than deleted, because the mistake is the lesson: the ledger was trusted as evidence.

### CORRECTED HYPOTHESIS (much more actionable): agents dispatched at the END of a turn die
| agent | dispatched | outcome |
|---|---|---|
| FEAT-060 | mid-turn | completed fully |
| FEAT-059 | mid-turn | ran, did real work, resumed after interruption |
| FEAT-061 | LAST action of the turn | dead ~2 min later |
| BUG-037 | LAST action of the turn | dead almost immediately (output file 137 bytes, never grew) |
Background subagents are supposed to OUTLIVE the parent turn — that is the async model. The
correlation says something tears down agents that have not yet established themselves when the turn
ends.
Next steps (cheap, ordered):
1. Test the correlation deliberately: dispatch an agent as the last action of a turn vs mid-turn
   (with follow-up work after), N=3 each, and compare survival. If it holds, the cause is in the
   turn-end teardown path, not in survival/liveness at all.
2. Inspect what runs at turn end that could reach in-process agents (bridge teardown, close-on-
   detach, the reaper's turn-boundary sweep from BUG-030/033, any interrupt on `result`).
3. Countermeasure available IMMEDIATELY regardless of cause: the orchestrator should not end a turn
   straight after dispatching — do follow-up work (or a short wait) so the agent establishes itself.

### 2026-08-12 — board hygiene: RESOLVED via successors (was still "OPEN" on the board)
- The investigation goal was met and shipped. BUG-037's own turn-end sweep fix (`#backgroundTasks`
  skip: no settle/no death record for background rows) committed `c80b152`. The misattributed CAUSE
  became BUG-041, fixed & committed `db7a790`. The design class was raised as ARCH-002 (DECIDED,
  option 1 — declared lifetime at dispatch). The actual kill actor this ticket named (socket close /
  restart drain substituting the turn-scoped `busy` for a work-lifetime question) was fixed &
  committed as BUG-043 (`26014ba`, socket close) and BUG-044 (`ee79e5b`, restart shutdown+boot).
- HONEST RESIDUAL, not closed, tracked elsewhere: "a `result` with a live background agent writes NO
  record" — the end-to-end anti-regression this ticket explicitly left open (see the 2026-08-10 fix
  entry, "NOT verified end-to-end") — remains a named residual in BUG-043 (residual b) and BUG-044
  (residual b). Recorded here so moving this to Done does not bury it.

### 2026-08-10 — CONTROLLED EXPERIMENT: end-of-turn hypothesis REFUTED; the real killer NAMED
Class: explore. Everything below is measured on a SCRATCH server (ephemeral port, scratch dataDir,
survival ON as in production), real `claude` CLI, real background Task subagents. :4317 untouched.

**Design.** A session is driven through the real dashboard (Playwright + Brave). Its one instruction:
dispatch ONE background subagent (`run_in_background: true`) whose entire task is
`for i in $(seq 1 120); do date +%s.%N >> <hb>; sleep 2; done` — a 240-second, 2-second heartbeat
file. Ground truth is the FILE, not the ledger. Three arms, N=3 each, all three arms run
concurrently per round so they share load and account:
- **A** — the Agent call is the LAST action; the turn ends immediately after it. Tab stays open.
- **B** — after dispatching, the parent keeps working in the same turn (two `sleep 30` Bash calls),
  then ends. Tab stays open.
- **C** — identical to A, but 10s after the turn ends the TAB IS CLOSED (socket drops while the
  session is idle and the background agent is still running).
Measured: beats completed, and how long the heartbeat continued past turn end / past tab close.
Harness: `/tmp/bug037/exp.mjs` (scratch, deliberately not added to the repo or package.json).

**Raw numbers.**
| arm | turn ended at | beats /120 | heartbeat past turn end | heartbeat past tab close | full run? |
|---|---|---|---|---|---|
| A1 | +7.3s | 120 | 239.0s | — | yes |
| A2 | +9.3s | 120 | 239.7s | — | yes |
| A3 | +6.7s | 120 | 240.5s | — | yes |
| B1 | +24.2s | 120 | 222.1s | — | yes |
| B2 | +27.8s | 120 | 222.0s | — | yes |
| B3 | +23.8s | 120 | 223.3s | — | yes |
| C1 | +7.8s | **80** | 160.1s | **150.1s** | NO — cut |
| C2 | +6.9s | **80** | 159.2s | **149.2s** | NO — cut |
| C3 | +6.2s | **80** | 160.0s | **150.0s** | NO — cut |

**VERDICT ON THE HYPOTHESIS: REFUTED.** "Agents dispatched as the last action of a turn are torn
down when the turn ends" is false. In arm A the turn ended 6–9s after dispatch with ZERO beats
written — the agent had not "established itself" by any definition — and every one of the three ran
the full 240s to completion. Arms A and B are indistinguishable (both 3/3 complete; the ~17s
difference in "past turn end" is just B's longer turn eating into the same 240s). The earlier
correlation (FEAT-060/059 mid-turn survived, FEAT-061/BUG-037 end-of-turn died) is confounded: what
actually differed was not WHERE in the turn the dispatch happened but WHAT HAPPENED TO THE SOCKET
afterwards.

**THE ACTOR, named with evidence.** Arm C kills the agent every time, at 150s ± 1s after the tab
closes — which is not a coincidence, it is a timer, and it is quotable:
1. `src/server/index.ts:2791-2792` (`ws.on('close')`) and `:2770-2771` (the client's explicit
   `{type:'close'}`, which `closeSocket()` in `public/app.js:4643` sends on EVERY session switch,
   "New session", route navigation and reopen): `if (session && session.busy && !session.closed)
   session.detach(); else void session?.close('socket closed')`. **`busy` is the ONLY signal.** A
   background subagent is invisible to it: at `result` the bridge sets `busy = false` and settles
   every still-running agent row (agent-bridge.ts:1871-1907). So a session with live background
   agents is, to the server, IDLE — and an idle session whose socket drops is CLOSED.
2. `close()` → `this.#survivalHandle.reap()` (agent-bridge.ts:1470-1472) → the broker's
   `gracefulReap()` (`src/server/session-host.mjs:267-284`): status → `draining`, stdin EOF
   immediately (the broker's `midTurn` is false — the `result` already landed), and then the
   escalation `setTimeout(() => child.kill('SIGTERM'), 150_000)` / `SIGKILL` at 160_000.
3. The CLI does NOT exit on that stdin EOF while a background agent is working — that is why the
   heartbeat keeps ticking for exactly 150s — and then the unconditional SIGTERM lands and takes
   the agent with it.
Corroborated per trial: the broker status file flipped to `state:"draining"` at the tab-close
millisecond (09:33:43.095Z for C1), and the scope died at 12:36:13 local = 151s later
(`claude-station-host-h-msn1agv8-8uxf2r.scope: Consumed …` in the user journal). **The `.err` file
was EMPTY** in every C trial — matching the real incident exactly: the CLI says nothing on the way
out, because nobody wrote anything, because it was SIGTERMed by its own broker.

**Second, independent finding — the ledger lies about background agents.** In arms A and B the
outcome ledger recorded, at turn end, `agent: … the turn ended while this agent was still running`
for an agent that then ran another 220-240s and finished normally. That is the SAME false-positive
signature as the 3ms/1ms "clusters" earlier in this ticket: they are not deaths, they are
`agent-bridge.ts:1878-1907` settling every still-running row at `result` because the model has no
concept of an agent outliving its turn. Any future investigation that treats a ledger entry as
evidence of a death will chase ghosts again (see also BUG-041 for the misattributed CAUSE — the
`main:provider-error … tooling-unavailable (MCP)` line appears in all nine trials here too).

**Verdict on the orchestrator's countermeasure ("don't end a turn right after dispatching"): NOT
SUPPORTED by this data, and it is the wrong lever.** Arm A survives perfectly with an open socket;
arm C dies with a closed one however long the parent worked first. The rule that IS supported:
*while background agents are in flight, do not let the driving socket close* — do not switch
sessions, hit New, navigate away, or close/reload the dashboard tab on that session (the client
sends an explicit `close` on all of those). Staying busy helps only incidentally, because a socket
drop on a BUSY session merely detaches.

**Caveats (untested here, code-evident, cheap follow-ups).** (a) The detach path has the same shape
with a shorter fuse: a socket that drops while BUSY detaches, and then `agent-bridge.ts:1965-1966`
closes the session 3s after the turn's `result` — same reap, same 150s SIGTERM. (b)
`CLAUDE_STATION_HOST_ABANDON_MS` (default 120_000, session-host.mjs:201) self-reaps a broker with
no connected client — a second, independent 2-minute path to the same kill, and a candidate for
FEAT-061's "dead ~2 min later". (c) I did not reproduce the "137 bytes, never grew" near-instant
death; the 150s fuse explains a ~2min death well, an instant one needs the CLI to exit on the stdin
EOF itself (it will, the moment the background agent is between tool calls).

**Fix shape (for whoever sequences this):** `busy` must stop being the liveness signal for
"may I close this session". The bridge already tracks `#agents`; the close/detach decision should
consult "is any agent still running" — and, because the bridge settles those rows at `result`, that
tracking has to survive the turn boundary for background agents. Anti-regressions must include: an
idle session with NO background agents still closes promptly on socket drop (no CLI leak), and
BUG-018's detach semantics are unchanged.

**Closing assessment.** Hypothesis tested and refuted with N=3 per arm and zero variance; the real
teardown actor is named at file:line with a quantitative prediction (150s) confirmed to ~1s across
three independent trials; a second defect (the ledger's turn-end false deaths) is proven with the
same runs. Not fixed — this entry is investigation only, no source changed, nothing committed.
Confidence: HIGH for arm C's mechanism (deterministic, timer-exact, corroborated by broker status +
journal + empty `.err`), MEDIUM for it being the cause of every historical incident in this ticket
(the near-instant BUG-037 case is consistent with the same close path but was not reproduced).
