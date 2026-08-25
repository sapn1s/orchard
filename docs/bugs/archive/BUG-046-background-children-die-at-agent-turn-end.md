# BUG-046 — subagents' background runs die at their turn end; monitor-waits stall silently (strip honestly empty, work secretly stopped)

- **Status:** VERIFIED (2026-08-11 — half 1 pattern adopted, half 2 stall detector built; 33/33, pre-feature FAIL 9/18 proven; awaiting deploy)
- **Area:** dispatch pattern / stall visibility (ARCH-002's class, one level down)
- **Reported:** 2026-08-11 by orchestrator, from the user's 6th "I don't see agents running" report

## What actually happened (ground truth, twice, two different agents)
Two dispatched agents (BUG-044 fixer, FEAT-061 closer) each launched their long verification run
via run_in_background Bash, ended their turn, and armed monitors to wake on completion. Ground
truth on the machine: ZERO verify/dispatch processes existed — their background children did not
survive their turn ending, and their monitors watched files that would never progress. Each agent
stalled ~1h, twice each (4 silent stalls total), until the orchestrator probed processes by hand.

## Why the user experienced this as "the strip is still broken"
It wasn't, this time: the strip showed nothing because NOTHING was running. The failure moved one
level up — the running-set is now honest, but "N lanes silently stalled waiting on dead runs" is
indistinguishable from "idle". An honest empty strip over secretly-stopped work is still a lie at
the fleet level.

## Two halves
1. **Pattern (immediate, done):** dispatched agents must run verification SYNCHRONOUSLY in
   foreground calls — never background+monitor for work their own turn end will orphan. Candidate
   WA §I capture (universal: any harness whose background children are turn-scoped).
2. **Detection (station feature):** the station knows an agent claims to be working (task row,
   ticket in-flight) — a cheap stall detector could compare "agent idle + its declared run has no
   live process/output-progress for X min" and surface a ⚠ stalled row in the strip/rail instead
   of blank. Ties into ARCH-002 (declared lifetime) and FEAT-057 (deaths ledger): a stall is a
   third outcome besides running/dead.

## Verification (for half 2 when picked up)
Scratch: agent-shaped row registered, no matching process/progress for the window → stalled row
surfaces with evidence; live run never flagged; recovery (process resumes) clears it.

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
