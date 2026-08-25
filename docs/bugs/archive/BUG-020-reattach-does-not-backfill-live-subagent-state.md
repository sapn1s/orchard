# BUG-020 — reattach after a dashboard reload never tells the client about a sub-agent that already started/finished (live "agents running" strip goes silently blank)

- **Status:** VERIFIED
- **Severity:** medium
- **Area:** server / agent-bridge / detach-reattach — live sub-agent display
- **Reported:** 2026-08-04 by a read-only diagnosis agent (dispatched to confirm/refute: does a dashboard reload KILL in-flight sub-agents, or just stop displaying them?)

## Symptom
When the dashboard is reloaded (or a session tab is switched/reopened) while a
session has an in-flight sub-agent (spawned via the `Task` tool), the
sub-agent is **NOT killed** — the turn, and the sub-agent inside it, keep
running server-side to completion, exactly like BUG-018's main-turn guarantee.
BUT the reattached client is never explicitly told what sub-agent(s) are
already running or already finished. The client's live "N agents
running"/"ran" strip (`state.agents` in `public/app.js`) is unconditionally
cleared by `resetTranscript()` on every `openSession()` and is **only ever
repopulated by live `agent-started`/`agent-progress`/`agent-completed` socket
events** — there is no reattach-time backfill from the session's own
in-memory `#agents` state. Whether the reattached client sees *anything* about
an already-running sub-agent is down to luck: if the sub-agent happens to
emit another progress/completion event AFTER the new socket attaches, that
event reaches the new socket (because it is just the ordinary live stream
continuing through the freshly-rewired `#emit`) and the strip populates late.
If the sub-agent has **already fully completed before the reload** (a fast
sub-agent, or a reload that lands late), there is no event left to emit at
all — the reattached client learns **nothing**, ever, about that sub-agent,
even though the transcript and the on-disk `subagents/agent-<id>.jsonl`
record prove it genuinely ran and finished.

This is a pure display/reattach gap, not data loss and not a kill: the
transcript is intact and the disk-backed subagent record exists. But the
live UI's "agents running" surface can silently go blank/incomplete on every
reload while a sub-agent is (or was) in flight, and there is no fallback: for
a LIVE session, the code that renders the *historical* "N agents ran"
summary is deliberately skipped (see `public/app.js` ~2846, the comment "The
live strip already surfaces current agents, so fetch the list for `agent=`
validation but render NO tail summary" — BUG-004/BUG-017 lineage), on the
assumption that the live strip is a complete substitute. It is not, across a
reload.

## Repro (real server, scratch port, real haiku session, real Task-tool sub-agent)
Ran three times against a real scratch server (not a fixture/mock), driving
the EXACT client sequence `public/app.js`'s `closeSocket()` sends
(`ws.send({type:'close'})` then `ws.close()`), then reconnecting a brand-new
socket with `resumeSessionId` — exactly what a browser reload does.

**Case A — reload while the sub-agent is still running (2 clean runs):**
1. Real session, prompted to launch a `Task`-tool sub-agent that sleeps in
   steps and then writes a marker file.
2. `agent-started` observed on socket A (`agentType: general-purpose`,
   `status: running`).
3. Sent the exact client close sequence while the marker file was still
   absent (sub-agent genuinely mid-flight).
4. Reconnected socket B with `resumeSessionId` → `ack.reattached === true`,
   `ack.busy === true`.
5. **No event arrives within 350ms of the handshake** (checked directly) —
   no immediate snapshot/backfill of the already-running agent.
6. An `agent-progress` (or nothing, in one run) eventually arrived only
   because the sub-agent produced another natural progress tick ~1.2-1.5s
   later — this is the ordinary live stream reaching the newly-attached
   `#emit`, not a deliberate replay (contrast with `replayPending()`, BUG-008,
   which *does* deliberately re-emit still-open approval cards on attach —
   sub-agent state gets no equivalent treatment).
7. The sub-agent later completed for real: `agent-completed` arrived on
   socket B, the marker file landed on disk with the expected content, and
   `turn-end` arrived with `interrupted: false` — confirms **NOT KILLED**.

**Case B — reload AFTER the sub-agent already fully finished (decisive, 1 run):**
1. A second real session: sub-agent instructed to write a marker file and
   finish immediately; main turn kept going afterward (three `sleep 3`
   Bash calls) so the reload happens while the OVERALL turn is still busy
   but the sub-agent itself is already fully done.
2. Observed `agent-completed` for the sub-agent BEFORE closing the socket
   (`status: completed`).
3. Sent the exact client close sequence, reconnected a fresh socket with
   `resumeSessionId` → `ack.reattached === true`.
4. Waited for `turn-end` on the new socket (`interrupted: false` — the whole
   turn, sub-agent included, was never killed).
5. **Asserted the reattached socket never once saw `agent-started` /
   `agent-progress` / `agent-completed` for that sub-agent's `agentId`,
   from the moment it attached to turn-end. Result: never.** A fresh
   reattaching client (a real dashboard reload landing slightly late) has
   **zero** knowledge this sub-agent ever ran — its live "agents" UI would
   render nothing for it, forever, even though it completed successfully and
   is provably on disk.

## Verdict
**NOT KILLED.** Both cases confirm the turn (and any sub-agent inside it)
keeps running and completing server-side exactly as BUG-018 established for
the main turn — this is a **display/reattach gap**, not a kill. The specific,
reproducible gap: the server has the answer ready
(`AgentSession.liveAgents()`, `src/server/agent-bridge.ts` ~797, backed by
the `#agents` map that survives `detach()`/`attach()` untouched) but the
reattach handshake (`src/server/index.ts` ~1783-1811, the same site BUG-008
fixed for `#approvals` via `replayPending()`) never calls it — it only sends
`ack` + `session-init` + `replayPending()` (approvals only). Nothing analogous
exists for sub-agent state.

## Expected
On reattach (`src/server/index.ts`, the `running.attach(send)` branch
~1783), after the ack/session-init handshake, backfill the client with every
currently-known sub-agent from `running.liveAgents()` — e.g. emit a synthetic
`agent-started`/`agent-progress` (or a new dedicated snapshot event) for every
entry, `running`, `completed`, or otherwise, so a reattaching client's live
strip is seeded with the true current state instead of starting empty and
depending on luck. This is the same shape of fix BUG-008 already applied for
`#approvals` — `replayPending()` is the natural home, or a sibling method
(e.g. `replayAgents()`) called alongside it.

## Context pack
- Server: `src/server/agent-bridge.ts` — `#agents` map (~line 315, `Map<string,
  LiveAgent>`), populated at `agent-started`/`agent-progress`/`agent-completed`
  emission sites (~1182, ~1199, ~1204-1213). `detach()` (~712) and `attach()`
  (~718) only rewire `#emit`; neither touches `#agents`. `liveAgents()` getter
  (~797) already exists and returns `[...this.#agents.values()]` but its only
  callers are `src/server/index.ts` ~1028 (the disk-backed `GET
  /api/sessions/:id/subagents` route, to merge live status into historical
  records) and ~1880 (`targetAgentId` lookup for routing a message to a
  specific agent thread) — **never** the reattach handshake.
- Server: `src/server/index.ts` ~1777-1819 — the `cmd.resumeSessionId` /
  `running.attach(send)` reattach branch. Sends `ack` (~1785), `session-init`
  (~1797), then `running.replayPending()` (~1811, approvals only). No call to
  `running.liveAgents()` here.
- Client: `public/app.js` — `state.agents` is a `Map` cleared unconditionally
  by `resetTranscript()` (~1843, called at the top of every `openSession()`,
  ~2797) and repopulated ONLY by the socket event handlers `agent-started`
  (~4276), `agent-progress` (~4288), `agent-completed` (~4297) — i.e. only by
  what the server chooses to emit after attach. The live-session branch of
  `openSession()` (~2857-2871) fetches the disk-merged subagents list (via
  `api.sessionSubagents`, which DOES already show live status thanks to the
  `liveAgents()` merge at `index.ts` ~1028) but explicitly does **not** use it
  to seed `state.agents` or render anything — the comment at ~2846 states the
  live strip is assumed to be the complete substitute for a live session,
  which this ticket shows is false across a reload.
- Siblings: BUG-008 (the exact reattach-backfill pattern already built and
  proven for `#approvals`/`replayPending()` — the fix direction here is to
  extend that same idea to `#agents`); BUG-018 (established the underlying
  detach-not-close guarantee this ticket depends on and reuses verbatim);
  BUG-004/BUG-017 (the reason the historical "N agents ran" summary is
  deliberately suppressed for live sessions — that suppression is correct on
  its own terms, but it is what makes this gap user-visible with no
  fallback).
- Repro test: none committed (per this ticket's read-only diagnosis mandate —
  do not modify source/commit). A throwaway script driving real ws + a real
  Task-tool sub-agent against a scratch server (modeled on
  `scripts/verify-close-busy-detach.mjs`) was used to produce the Repro above
  and then deleted; the fixing agent should commit a permanent version (e.g.
  `scripts/verify-reattach-agents.mjs`) asserting: (1) an in-flight sub-agent
  is immediately (not eventually) visible to a freshly reattached socket, and
  (2) a sub-agent that fully completed BEFORE the reload is still visible
  (not silently dropped) — case B above is the load-bearing negative check,
  since case A can pass "by luck" on unfixed code if a progress tick happens
  to land after attach.
- Fix direction (NOT implemented here — read-only diagnosis per dispatch):
  extend `replayPending()` (or add a sibling call right next to it, both in
  `agent-bridge.ts` and invoked from the same `index.ts` reattach site) to
  emit one event per `this.#agents.values()` entry, so a reattaching client's
  `state.agents` is seeded with ground truth instead of relying on incidental
  future events.

## Activity log (APPEND-ONLY)

### 2026-08-04 — agent (read-only diagnosis)
- **Understood:** dispatched to confirm/refute whether a dashboard reload
  during an in-flight sub-agent kills it (A) or just stops displaying it (B),
  building on BUG-018 (main-turn detach-not-close) and BUG-008
  (approval-replay-on-reattach precedent).
- **Verified:** traced `AgentSession.#agents` / `liveAgents()` / `detach()` /
  `attach()` / `replayPending()` in `agent-bridge.ts`, the reattach handshake
  in `index.ts` (~1777-1819), and the client's `state.agents` /
  `resetTranscript()` / `agent-started` handlers in `app.js`. Confirmed by
  static reading that `liveAgents()` exists and survives detach/attach
  untouched, but is never consulted by the reattach handshake — only
  `replayPending()` (approvals) runs there.
- **Confirmed live** with a real scratch server (three runs, real haiku
  sessions, real `Task`-tool sub-agents, the EXACT client
  `{type:'close'}`+`ws.close()` sequence): sub-agents are NEVER killed by a
  reload (turn always finishes, `interrupted:false`, marker files land on
  disk) — verdict is **(B), not (A)**. But: no immediate backfill on
  reattach in any run; a sub-agent that already fully completed before the
  reload is **never** mentioned to the reattached socket (case B, the
  decisive negative check) — a genuine, reproducible display/reattach gap,
  filed as this ticket.
- **Handoff:** fix direction above (extend `replayPending()`/sibling method
  to cover `#agents`, called from the same `index.ts` reattach site as
  BUG-008's fix). Did not touch `src/server/index.ts` (another agent was
  editing it per this ticket's constraints) or any other source; no commit
  made. Scratch verify script used to produce the Repro was deleted, not
  committed — the fixing agent should add a permanent one per the Repro
  test note above.

### 2026-08-04 — fix + verification (subagent)
- **Understood:** confirmed the diagnosis's own read: `AgentSession.#agents`
  (`src/server/agent-bridge.ts:315`) is populated at `task_started`/
  `task_progress`/`task_updated` (~1168-1216) and NEVER cleared for the life
  of the session (entries persist with their final `status` even after
  completion — this is also what already powers the disk-merged
  `liveAgents()` used by `/api/sessions/:id/subagents`). `detach()`/`attach()`
  (~712/718) only rewire `#emit`, so `#agents` survives a reload untouched.
  The reattach handshake (`src/server/index.ts` ~1777-1819) called only
  `running.replayPending()` (BUG-008, approvals) — nothing replayed agent
  state, exactly as diagnosed. Also learned mid-fix (not previously
  documented): the Task tool in this SDK/environment is ASYNCHRONOUS (tool
  result is "Async agent launched successfully") — the orchestrator's own
  turn does not block on a sub-agent finishing, so a session can go idle
  (`busy:false`) almost immediately after launching sub-agents that are
  still running in the background; only a session that is still genuinely
  `busy` detaches (rather than closes outright) on socket loss, so a valid
  repro needs the ORCHESTRATOR itself busy (e.g. its own Bash sleep) across
  the reload window, not just a busy-looking sub-agent.
- **Changed:**
  - `src/server/agent-bridge.ts` — added `replayAgents()` (sibling to
    `replayPending()`, same file, right after it): re-emits one event per
    `#agents` entry — `agent-started` for one still `running`,
    `agent-completed` for one already `completed`/`failed`/`killed`. Reuses
    the existing `LiveAgent` shape verbatim (`{ ...a }`), so it needs no new
    event type and the client's existing `agent-started`/`agent-completed`
    handlers (`public/app.js` ~4276-4309) apply unmodified — client-side
    required ZERO changes, since `state.agents`/`renderStrip()` were already
    correct consumers of these events, just never fed them on reattach.
  - `src/server/index.ts` — reattach branch (`cmd.resumeSessionId` /
    `running.attach(send)`, ~1777) calls `running.replayAgents()` right after
    `running.replayPending()`, same site BUG-008 already uses.
  - `scripts/verify-reattach-agent-backfill.mjs` + `package.json` script
    `verify:reattach-agent-backfill`.
- **Verified (§C rule — real browser, real DOM, real user path):**
  - `npm run verify:reattach-agent-backfill` → **PASS 15/15**, twice
    consecutively for stability. Real scratch server + real brave headless
    (CDP) + a real haiku session that launches two real Task-tool sub-agents
    (QUICK ~1s, SLOW ~10s) while the orchestrator itself sleeps ~25s to stay
    genuinely busy. Captures the exact split (QUICK settled, SLOW still
    running) atomically from `window.__station.state.agents`, confirms the
    strip shows it pre-reload (baseline sanity), then does a REAL
    `Page.reload()` (the literal action named in this bug), confirms
    `applyRoute` lands back on the same session and the client HONESTLY
    knows nothing yet (`state.agents` empty — the exact display gap), then
    drives the real recovery path a returning user takes: types a message
    and presses Enter (not `#go`.click() — while `state.busy` is true from
    the honest `liveRec`, `#go` is repainted as an INTERRUPT button per
    `node.go.dataset.mode`, so only Enter reliably submits, matching real
    keyboard use) — `submit()`'s existing resumeSessionId auto-supply drives
    the exact server reattach handshake this ticket fixes. Then asserts,
    from DOM queries against `#stripRows`, that: (Case A) the still-running
    sub-agent's row shows with the `.run` class IMMEDIATELY off the reattach
    ack (polled via raw CDP `Network.webSocketFrameReceived` frames, not a
    coarse sleep-then-check, to catch the true instant and rule out
    "eventually, by luck"); (Case B) the sub-agent that finished BEFORE the
    reload is also known to the client (`state.agents.has(doneId)`, not
    dropped); then that it genuinely finishes for real afterward and the
    strip DOM updates accordingly, and that BOTH real marker files the
    sub-agents wrote land on disk (proving neither was interrupted/killed by
    the reload/reattach).
  - **Regression checks (same-file tickets):**
    `npm run verify:reattach-approval` (BUG-008) → **PASS 11/11**.
    `npm run verify:reload-live-summary` (BUG-017) → **PASS 10/10**.
    `npm run verify:ui -- --offline` → **PASS 3/3**.
    `npm run typecheck` → **PASS** (tsc --noEmit clean).
  - Screenshot: `docs/bugs/assets/BUG-020-after.png` (captured mid-test, the
    reattached client's strip showing the still-running sub-agent).
- **Notes for reviewer:** the verify script's SLOW/QUICK sleep durations
  (10s/1s) and the orchestrator's own ~25s keep-busy sleep were tuned
  empirically against this environment's real LLM/tool latency — earlier
  attempts with a longer SLOW sleep (40s) intermittently raced against an
  apparent async-agent completion signal that can arrive before its
  underlying Bash call is provably done (marker file still absent), which is
  an existing SDK/harness quirk unrelated to this fix, not a regression
  introduced by it. If this test becomes flaky over time, widen the marker
  grace-poll (currently 50×200ms) or shorten SLOW further before suspecting
  the fix itself — the DOM assertions (Case A/B) are the load-bearing checks
  and were stable across every run once the reattach path was actually
  exercised (real Enter-key submit, not a busy-mode `#go` click).
- **Handoff:** none — fixed and verified. Orchestrator to review the diff
  (`src/server/agent-bridge.ts`, `src/server/index.ts`,
  `scripts/verify-reattach-agent-backfill.mjs`, `package.json`) and commit.
  Shares `src/server/agent-bridge.ts` and `src/server/index.ts` with BUG-008
  — serialize commits with any other in-flight ticket touching those files.
