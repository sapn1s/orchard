# BUG-171 — a bash tool lane reads as a phantom subagent stuck waiting forever

- **Status:** IN-PROGRESS
- **Severity:** medium
- **Area:** transcript / strip (public/app.js threads)
- **Reported:** 2026-09-07 by owner (live UI)
- **Verification-class:** fix  ⟶ independent verification REQUIRED before VERIFIED

## Symptom
The owner, verbatim from the live UI, sees this row in effectively every session,
and it never resolves:

    <project> › local_bash · Idle wait for subagents — Idle — Autonomous
    local_bash · Idle wait for subagents
    waiting for this agent's first output…

(the leading token was a real private project name; redacted to <project>.)

They did not know what it was and assumed Orchard spawns some phantom subagent.

## Repro
Open any session in which the orchestrating agent makes a background/idle Bash
call (the Claude Code CLI surfaces every Bash call as its own task with
`task_type:"local_bash"`; here the caller's description is "Idle wait for
subagents"). Click that row in the running strip to open its thread. The pane
shows an agent lede (`local_bash · <description>`) and the hint
"waiting for this agent's first output…", which stays forever — a `local_bash`
task emits no "agent output" by construction, so the hint can never clear.

## Expected
The row is a TOOL lane, not a subagent. Its thread pane must not claim to be an
agent waiting for output: no "waiting for this agent's first output…" hint, no
agent lede. Show what a bash lane actually is — its task type, the
description/command the caller passed, and whether it is still running. The
strip row itself is already honest (it shows only while the server says the
lane runs); this ticket is only about the thread pane labelling it truthfully.
Not in scope: stopping the bash call — it originates outside this repo (the
orchestrator's own prompt/harness) and is legitimate.

## Root cause
The server already DECLARES the fact: `LiveAgent.kind` is `'tool'` for a
`local_bash` task (src/server/agent-bridge.ts:4166, BUG-030) and it is emitted
on the wire (`agent-started`/`-progress`/`-completed` send `{ ...a }`,
agent-bridge.ts:1981; field defined events.ts:90). The CLIENT discarded it:
`newThread()` (public/app.js:3161) hardcoded `kind:'agent'` for every non-`main`
thread, so `refreshWaiting()` (app.js:3207) showed the agent "waiting" hint and
`refreshLede()` (app.js:3189) the agent lede for a tool lane forever. ARCH-010:
the owner declares the fact; the reader must read it, not re-derive it.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play:
  - public/app.js: `newThread` (kind hardcoded), `refreshLede`/`refreshWaiting`/
    new `refreshToolLede`, `agentKind` (existing single reader of the declared
    kind, app.js:6864), `showThread`/`paintCrumbs`/`paintComposerFor`/`submit`
    (all keyed "is this the main thread" off `kind`, so tool must join agent as
    a read-only sub-thread), `agent-started`/`-progress` handlers, `viewAgent`,
    history render, `threadKindFor` (new helper).
  - src/server/events.ts:90 (`LiveAgent.kind`), src/server/agent-bridge.ts:4166
    (server declares kind), :1981 (emitted on the wire). No server change needed.
- Related tickets: BUG-030 (introduced the tool/agent split + `agentKind`).
- Repro test: scripts/verify-bug-171-tool-lane-lede.mjs (Playwright, real event path).
- Known dependencies / blockers: none. Same file as BUG-167..170 (public/app.js)
  — serialize.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-07 — worker (fixing, round 1)
- **Understood:** the server declares `kind:'tool'` and sends it; the client
  threw it away at `newThread` and rendered every non-main thread as an agent,
  so a `local_bash` lane showed the never-clearing "waiting for this agent's
  first output…" hint + agent lede. Verified the wire carries `kind`
  (events.ts:90, emitted `{ ...a }` at agent-bridge.ts:1981) before editing.
- **Changed (all unstaged; no git writes):**
  - public/app.js — `newThread` reads `meta.kind` instead of hardcoding 'agent';
    `refreshLede` routes `kind:'tool'` to a new `refreshToolLede` (task type ·
    description/command · running/idle state, and NO "waiting for first output"
    hint); `newThread`'s initial-lede guard now fires for any non-main thread; a
    new `threadKindFor` helper reads the declared kind (live agent record, else
    the running-snapshot row) for the rare `viewAgent`-creates-thread path; the
    `agent-started`/`agent-progress` handlers and the history-stack render stamp
    `agentKind(...)` onto the thread; and every `th.kind === 'agent'` /
    `th.kind !== 'agent'` site that MEANT "is this the main thread"
    (showThread dataset, paintCrumbs, paintComposerFor ×3, submit guard) was
    reclassified to `=== 'main'` / `!== 'main'` so a tool lane joins an agent
    lane as a READ-ONLY sub-thread (never a sendable composer — the exact lie
    the app avoids). No server change: the server already declares
    `LiveAgent.kind` (events.ts:90) and emits it (agent-bridge.ts:1981).
  - docs/bugs/BUG-171-*.md (this ticket); docs/bugs/assets/bug171-tool-pane-{dark,light}.png.
- **Verified:** scratch server (free port 43633, isolated CLAUDE_STATION_DATA,
  killed by pid + scratch dir removed) serving the working-tree public/;
  confirmed the served app.js contained the fix; drove the REAL client event
  path via `window.__station.onEvent(...)` (the exact socket handler) in a real
  headless Playwright browser, both themes:
  - PASS (fixed) tool lane pane: `kind:'tool'`, hasWaiting=false, lede
    "local_bash · Idle wait for subagents · running". Crumb `main › local_bash ·
    Idle wait for subagents`; composer read-only (not sendable). Both themes.
  - PASS (control) agent lane pane in the same session UNCHANGED: `kind:'agent'`,
    hasWaiting=true, "waiting for this agent's first output…", normal lede.
  - MUST-FAIL proof: drove the same real `agent-progress` handler with the lane
    in the synthesized PRE-FIX state (`kind:'agent'` on a `local_bash` — what the
    old `newThread` produced) → pane HAS "waiting for this agent's first
    output…" (hasWaiting=true). So the measurement genuinely distinguishes
    fixed from broken; it is not vacuous.
  - Screenshots: docs/bugs/assets/bug171-tool-pane-dark.png,
    docs/bugs/assets/bug171-tool-pane-light.png.
  - `npm run gate` → PASS (leak-gate + check-nul + typecheck; exit 0) after
    redacting a real private project name from the verbatim symptom above.
  - Could NOT test: a genuine engine-emitted `local_bash task_started` frame from
    a live Claude CLI (nondeterministic to synthesize) — the LiveAgent object and
    the client event path were exercised instead, which is where the defect and
    fix both live; and the strip-row → viewAgent click on a snapshot-only row
    with no prior `agent-started` (covered by the `threadKindFor` fallback but
    reached in the harness via injected events, not a real reattach race).
- **Verified-by:** PENDING — clean-room dispatch warranted: contained render
  change, but it touches thread-KIND classification that gates the composer's
  read-only/sendable branch and the submit guard, so an independent pass over the
  real event path (a case the fixer's fixture does not cover, e.g. a real
  reattach/replayAgents sequence) should confirm before VERIFIED.
- **Still open / handoff:** INDEX.md needs a BUG-171 Open row — left to the
  orchestrator (INDEX is orchestrator-owned; concurrent FEAT-129/131/132 +
  BUG-167..170 are in flight, so a fix lane must not rebuild it). `npm run
  board:check` will clear BUG-171's "MISSING FROM BOARD" once that row is added;
  the other 4 drift items are pre-existing (FEAT-129/131/132 unmappable status,
  ARCH-007 unreachable) and not from this change.
