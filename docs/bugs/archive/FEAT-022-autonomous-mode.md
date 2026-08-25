# FEAT-022 — Autonomous mode: selectable never-pause loop with a stop condition

- **Status:** VERIFIED (safe subset — mode + bounded stop + attached auto-continue loop + Stop; see flagged decisions)
- **Area:** claude-station session control
- **Reported:** 2026-08-04 (WA §M; convergent across external-project-F / gpu / most research repos)

## Goal
A first-class, EXPLICITLY chosen autonomous mode: a keep-going-until-a-stop-
condition loop (research sweeps, long backlogs) distinct from the interactive
NEEDS-YOU default (WA §M). Don't force never-pause onto interactive work or
ask-every-step onto a loop.

## Design
- Per-session toggle "autonomous" with a declared stop condition (turns budget,
  token budget, "until queue empty", or explicit user-stop) and a visible running
  indicator + one-click stop.
- While autonomous: proceed without confirmation prompts, but STILL record
  decisions durably (board / a run log) so they're auditable after (WA §H/§M).
- Reuse existing budget/stop plumbing where possible (see BUG-013 budget stop).

## Verification (REQUIRED)
A session set autonomous with a small stop condition runs N steps without pausing,
stops exactly at the condition, and leaves an auditable decision log. verify:ui + typecheck.

## Context pack
- Touches: server session loop + composer UI. Coordinate with BUG-013 (budget stop).

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed per user approval; models the mode our research-loop projects rebuild ad hoc.

### 2026-08-04 — implementer (safe subset shipped + verified)
Built a first-class per-session autonomous mode: an explicitly-chosen, bounded
auto-continue loop, default OFF, with a mandatory stop condition and a prominent
Stop. Real driven-session verification passes (loop advances AND halts, halt is
asserted stable).

**What I built**
- `src/server/agent-bridge.ts` — `AgentSession` gains `autonomous` + private
  `#autoMaxTurns` / `#autoTurnsDone` / `#autoStopReason`. New methods:
  `enableAutonomous(maxTurns)` (validates an integer 1..50 — a hard ceiling so a
  fat-fingered value can't arm a near-unbounded loop), `stopAutonomous(reason)`,
  `autonomousState()`. New `AutonomousState` / `AutonomousStopReason` types +
  `AUTONOMOUS_NUDGE` constant exported from the module.
- **Auto-continue seam** — at every turn boundary (`result` in `#handle`), after
  the budget check and before the detached-close, `#maybeAutoContinue(interrupted)`
  runs: while autonomous and no stop condition is met, it increments the turn
  counter and `send()`s the continue-nudge into the SAME session (deferred a tick
  off the message-handling stack). Halts (returns to interactive) with a concrete
  recorded reason on: `turns-reached` (the declared cap), `manual`, `budget`
  (BUG-013 outranks the loop), `interrupted` (user took control), `detached`
  (no driver — hands back to close-on-detach), `closed`.
- `src/server/index.ts` — `GET /api/sessions/:id/autonomous` (cheap poll),
  `POST /api/sessions/:id/autonomous {action:'start',maxTurns} | {action:'stop'}`,
  and the mode folded into the existing `GET /api/sessions/:id` (effective-config)
  JSON. No new WS command / event type and no `events.ts` change — the client
  drives control over HTTP and re-reads the authoritative mode at each boundary.
- `public/app.js` — crown affordance next to FEAT-040's `#sessStatus`: an
  "Autonomous" toggle that opens a "Stop after N turns" form, an UNMISTAKABLE
  pulsing amber badge `AUTONOMOUS x/N` + a full-width top stripe
  (`body[data-autonomous="1"]`), and a prominent Stop. Captures the station
  session id from the `start` ack; re-reads mode after go-live and at every
  turn-end while autonomous. All injected DOM/CSS in app.js (index.html/styles.css
  out of scope). Reset per session in `openSession`.
- Verify: `scripts/qa/FEAT-022-autonomous-mode.spec.ts` (new). Real haiku session,
  `maxTurns=2` hard cap.

**Exact auto-continue mechanism**: server-side, in-process, at the turn boundary.
When a turn's `result` lands while autonomous and unmet, the bridge sends a fixed
continue-nudge into the same live session — a real new turn, recorded verbatim in
the transcript (the durable, auditable decision trail, §H/§M). Bounded by
`#autoMaxTurns`; there is no unbounded variant.

**Verification (§C, user-observable, real browser + real session)** — PASS:
- interactive by default (toggle shown, no badge, server `{autonomous:false}`);
- arming autonomous lights the badge + stripe and persists across a page reload
  of a still-live session (re-read from the server);
- LOOP ADVANCES: server auto-continues 2 turns with no human input; then HALTS at
  the cap with `stopReason:'turns-reached'`, `turnsDone:2`;
- HALT IS STABLE: after the halt, `turnsDone` does not move and `busy` stays false
  for 7s (asserted — an unbounded loop is a FAIL);
- Stop returns to interactive on demand.
- Non-vacuous: proven to FAIL before the change (station id never captured;
  `#autoBtn` absent; route 404). `typecheck` PASS, `verify:ui --offline` PASS.
- Screenshots: `docs/bugs/assets/FEAT-022-autonomous-on.png`, `FEAT-022-halted.png`.

**FLAGGED PRODUCT DECISIONS (need orchestrator/user)**
1. **"Stop when the board/backlog is empty" is NOT built — deliberately deferred.**
   Only "stop after N turns" (+ the always-present manual Stop and the natural
   stops above) is implemented. The server has no in-scope, unambiguous read of
   "the backlog is empty" (which board? what counts as empty?), and `board.ts` is
   out of scope. Default chosen: the bounded turn budget, which satisfies §M's
   "stop condition is mandatory". Decision needed: is a board-empty condition
   wanted, and what defines "empty"?
2. **The loop does NOT survive the driver going away (no true unattended run).**
   By design it stops on `detached` and hands back to the existing
   close-on-detach. So a browser reload of a *busy* autonomous session detaches →
   the loop stops at the next boundary → the session self-closes (an *idle*
   session is closed outright on socket drop, pre-existing behaviour). "Persists
   across reload" is therefore proven only for a *still-attached/reattached* live
   session, not for headless survival. Making autonomous genuinely unattended
   (survive a tab close / server restart) is the risky part and is left as a
   handoff — it needs FEAT-015-style survival + a decision on close-on-detach.
3. **The nudge prompt is a fixed constant** (re-states the §M scope contract each
   turn). Not user-customisable yet — flagged as a small future affordance.
4. **Mode is in-memory on the live `AgentSession`**, not written to the registry.
   It survives a browser reload (re-read from the live server session) but a
   server restart legitimately drops it back to interactive. Registry/validate
   were left untouched (persisting a transient run-mode across restarts is a
   separate decision).

**package.json entries to add** (I was told NOT to edit package.json):
- `"verify:feat-022": "playwright test scripts/qa/FEAT-022-autonomous-mode.spec.ts"`
  (mirrors the existing `verify:bug-025-question` entry). Add it to the
  `qa:sweep` aggregation if that lists specs explicitly.

**Handoff for next agent**: if headless/unattended autonomous is wanted, decide
the close-on-detach policy for an autonomous session (keep alive + keep looping
while detached, bounded by the turn cap) and wire FEAT-015 survival; and pick the
board-empty stop-condition semantics (#1).

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
