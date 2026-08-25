```orchard-ticket
{
  "id": "BUG-046",
  "type": "bug",
  "title": "Stalled background work now surfaces visibly",
  "summary": "Agents now run turn-scoped checks in the foreground, preventing their work from disappearing when a turn ends. A stall detector also distinguishes secretly stopped work from an idle system. The pre-fix case failed, and the corrected behavior passed across stall, liveness, outcome, snapshot, and interface checks.",
  "impact_if_we_wait": "Deployment delay leaves stalled agents looking idle and can postpone completed work without warning. Bounded: this affects workflow visibility and completion time, not user data or the accuracy of genuinely running work.",
  "current_need": "Treat the work as closed: the pre-fix case failed, corrected behavior passed across all targeted checks, and type checking stayed clean.",
  "severity": "medium",
  "area": "Agent stall visibility",
  "reported": "2026-08-11",
  "reported_by": "orchestrator",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-11",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Turn-scoped verification runs synchronously and survives until completion",
    "An agent without a live process or output progress appears stalled",
    "A live run is never marked stalled",
    "Resumed process activity clears the stalled indication"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "ARCH-002",
      "relation": "see_also"
    },
    {
      "id": "BUG-044",
      "relation": "see_also"
    },
    {
      "id": "BUG-096",
      "relation": "see_also"
    },
    {
      "id": "BUG-105",
      "relation": "see_also"
    },
    {
      "id": "FEAT-057",
      "relation": "see_also"
    },
    {
      "id": "FEAT-061",
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
    "archived_path": "docs/bugs/archive/BUG-046-background-children-die-at-agent-turn-end.md",
    "sha256": "7ef879773d0ddef00aeecb117362d2e73af66c216eff69e5b97d12c9f3cac18b",
    "bytes": 8294,
    "original_title": "subagents' background runs die at their turn end; monitor-waits stall silently (strip honestly empty, work secretly stopped)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived ticket text; the orphaned runs, four stalls, foreground pattern, detector behavior, evidence, deployment state, and linked work are preserved.",
    "dropped": []
  }
}
```

# BUG-046 — Stalled background work now surfaces visibly

## Diagnosis

Two dispatched agents launched long checks as background children, ended their turns, and waited for completion files. The children died with their turns, leaving no live process and no progressing output. Monitors then waited indefinitely while the running display honestly appeared empty.

## Evidence

BUG-046 records four silent stalls across the BUG-044 fixer and FEAT-061 closer, each requiring manual process inspection. Before the feature, the targeted scenario produced pre-feature FAIL. Afterward, `verify:stall-detector` passed 33/33, `verify:running-snapshot` passed 47/47, `verify:liveness-conformance` passed 96/96, `verify:agent-outcomes` passed 45/45, and `verify:ui` passed 7/7. Type checking was clean.

## Implementation notes

Dispatched agents must run verification synchronously in foreground calls when their background children are scoped to the current turn. The detector compares declared agent work with process liveness and output progress, then surfaces a stalled row instead of leaving the display blank. A stall complements the running and dead outcomes associated with FEAT-057.

## Verification plan

Register an agent-shaped row without a matching process or output progress and confirm that a stalled row appears after the configured window. Confirm that a live run is not flagged and that resumed process activity clears the warning.

## Migration and rollback

The foreground verification pattern and stall detector are complete but await deployment. Roll back the detector display separately if it produces false warnings; retain synchronous foreground verification because it prevents turn-scoped child loss.

## Risks

An overly short inactivity window could label slow but healthy work as stalled. Process presence alone can also conceal a hung run, so output progress must remain part of the evidence.

## Activity log (APPEND-ONLY)
### 2026-08-11 — orchestrator
- Filed after redirecting both stalled agents to foreground execution. The user's report was
  correct in effect (work invisible AND not happening) even though the strip itself was honest.

### 2026-08-11 — fix agent (in-place, main) — HALF 2 BUILT & VERIFIED: the stall detector

**What was built.** A work row whose evidence stops progressing — no frames about it AND no live
process signal vouching for it — for a configurable window (default 5min,
`CLAUDE_STATION_STALL_WINDOW_MS`) becomes state **`stalled`**: a ⚠ row in the strip, IN PLACE.
Never removed (nothing proved it ended), never recorded as a death (BUG-041's invariants:
completions are never deaths, a stall is not an outcome at all — `stalls.ts` and `running-set.ts`
cannot even reach the outcomes ledger, proven by source-conformance check A9c). Recovery is
residue-free **by construction**: the judgment is a pure recomputation over current evidence on
every snapshot read, so the moment progress resumes the same inputs stop saying stalled — nothing
latched, nothing to clear, nothing to dismiss.

**Where the pieces live.**
- `src/server/stalls.ts` (new) — the pure judgment (`judgeStall`) + the two windows. NOT a
  liveness rung (ARCH-001): it never claims a process is alive or dead; it answers the orthogonal
  question "is the evidence progressing". The regrowth guard stays clean (96/96).
- `src/server/events.ts` — `LiveAgent.lastProgressAt?`: the SERVER clock of the last frame the
  engine emitted ABOUT the row. Stamped in `agent-bridge.ts` at `task_started` / `task_progress` /
  `task_updated` — the clock moves on frames, never on guesses.
- `src/server/agent-bridge.ts` — `stallSignalFor(id)`: the engine's `background_tasks_changed`
  level listing the id is a live signal (REPLACE semantics — a dead task is removed by the next
  level frame), and a row it vouches for is NEVER flagged, however silent. Rows it does not list
  have no per-row process signal; the honest answer is null and the judgment rests on frame
  progress alone — which is exactly the incident's shape (children run inside a subagent's own
  harness are invisible to this session's engine, silent → ⚠). A running↔stalled flip counts as a
  snapshot-signature change so pushes fire; the client's 4s poll is the backstop (the route
  recomputes on read, so a stall surfaces with zero new server timers).
- `src/server/running-set.ts` — `RunningEntry.state: 'running'|'stalled'` + `stall` evidence
  ({lastProgressAt, stalledForMs, windowMs, checked}) computed per entry in `snapshotOfSession`.
  `main` is deliberately out of scope: the authority's frameless backstop owns the main turn's
  silence.
- Escalation (ARCH-002: advisory, evidence-carrying, never auto-kill): a stall older than
  `CLAUDE_STATION_STALL_ESCALATE_MS` (default 2×window) surfaces as a `kind:'stall'` Needs-You
  card, computed fresh from live sessions' snapshots on every board read (`index.ts`), persisted
  nowhere. The card is actionless and says so: "the station never kills work on this evidence;
  check the process yourself before acting."
- `public/app.js` + `styles.css` — STRIP AREA ONLY: stalled rows render ⚠ (no spin/sweep — those
  mean "alive", the exact claim nothing can back) with the full evidence on the tooltip; the
  summary counts stalled lanes out loud (`0 agents running · ⚠ 2 stalled · 0:07`) instead of
  counting them as running; `needsStallRow` renders the advisory card read-only. Tickets tab and
  queue/refusal code untouched.
- `scripts/fixtures/codex-fake-app-server.mjs` — test tooling only: `HOLD_AGENTS` gains
  `;TICK:<ms>[:<afterMs>]` progress heartbeats, which is how the suite drives chatty work and
  genuine stall→recovery end to end.

**Verification — `verify:stall-detector` (new, package.json entry): 33/33.**
Part A: the real judgment + real snapshot builder (stalled kept in set with quotable evidence;
chatty never flagged; live signal outranks silence; recovery residue-free; no clock → no stall,
§C; window≤0 disables, proven in a subprocess against the real module) + source-conformance (the
live call sites actually consult all of it). Part B, real server + fixture engine + real browser:
the injected stall (2 held rows go silent) surfaces ⚠ within the window with evidence, rows still
present, main untouched, outcomes ledger byte-identical before/after; the DOM shows ⚠ + tooltip +
honest summary; past the second window the advisory rail card appears and renders read-only;
chatty rows sampled across 2.5 windows are never flagged; a row that stalls and then resumes
recovers to ◐ with no residue, no surviving rail card, and nothing written to outcomes.

**PRE-FEATURE (same script + fixture, clean e836220 worktree): 9/18 — every core check FAILS,**
observing the reported gap verbatim: `stalls.ts` does not exist, the silent rows stay
`2 agents running · 0:34` forever, no ⚠ anywhere, no rail card. The 9 passes are structurally
vacuous (preconditions, plus never-flagged/no-death checks that hold when nothing is ever flagged).

**Anti-regressions:** verify:running-snapshot 47/47, verify:liveness-conformance 96/96 (L4
regrowth guard clean — the detector added no ad-hoc liveness check), verify:agent-outcomes 45/45,
verify:ui 7/7 (full), typecheck PASS.

**Named, not implied:** (1) The live-signal rung is only exercisable on engines with a background
level (Claude); on the codex fixture path every row judges on frame progress alone — the
level-vouched suppression is proven at the unit level (A3/A8b) plus source conformance, not by a
live Claude engine. (2) The strip's ⚠ appears via the 4s snapshot poll; a tab that is hidden
(poll paused) learns on its next visible poll — same staleness class the poll already has for
every other state. (3) Needs a deploy; the running service predates this commit.
