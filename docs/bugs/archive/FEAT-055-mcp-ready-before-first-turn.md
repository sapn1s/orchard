# FEAT-055 — MCP servers are not ready for turn one (one-shot agents never get them)

- **Status:** VERIFIED 2026-08-11 — bounded first-prompt MCP-readiness gate; 10/10 (pre-fix 4/9), anti-regressions green; fix 4f9e8ff, merged to main 3c6a0b5. (Live-service deploy confirmation: see 2026-08-12 note.)
- **Area:** session start / runtime — MCP readiness
- **Reported:** 2026-08-09 (found by BUG-035's investigation)

## Finding (probed, live)
In the streaming-input mode the station uses, the CLI does NOT wait for MCP servers before the
first turn. Live probe, warm cache, direct isolation: `system:init` at 644ms with
`mcp_servers:[{serena, status:"pending"}]` and ZERO mcp tools → turn 1 runs WITHOUT Serena; a
second `system:init` at ~17s reports `connected` with 21 tools → turn 2 has them.

Consequence: every session's first turn silently lacks its MCP tools, and a **one-shot dispatched
agent (which only ever takes one turn) NEVER gets them at all** — it just quietly works without
the tools the project enabled. BUG-035 made this *announced* (an honest ticker line), not *closed*.

## Options (decide with cost in mind)
1. Hold the first prompt until an init reports every configured server `connected` (or failed) —
   correct but adds latency to every session start and needs a timeout + honest "still attaching"
   state. Touches the bridge/runtime (contended by BUG-033/034 — sequence accordingly).
2. For the dispatch runner specifically (one-shot, the worst case): drive a cheap no-op first turn
   or wait for the connected init before sending the real task.
3. Leave as-is and rely on BUG-035's announcement (status quo) — acceptable only for interactive
   sessions, NOT for dispatch.
Recommendation: (2) for dispatch now (small, contained), (1) later as the general fix.

## Verification
Assert tools present on turn ONE for a session that configures Serena (or an honest wait state);
dispatch runner proven to have MCP tools available for its single turn; no added latency when no
MCP servers are configured; timeout path honest when a server never connects.

## Activity log (APPEND-ONLY)
### 2026-08-09 — orchestrator
- Filed from BUG-035's bonus finding (its own handoff note). Real user impact: dispatched
  reviewers/workers silently run tool-less.

### 2026-08-11 — orchestrator (evidence, MAIN session this time)
- After the pid-3989993 deploy, the MAIN orchestrator session's first post-restart wake was
  recorded in the deaths ledger as: "the main turn — tooling-unavailable (anthropic): MCP tool
  server still starting: serena — mcp__serena__* is NOT available for this turn (they attach for
  the next one)." So this is not only a one-shot-dispatch problem: every restart costs the main
  session its serena tools for a turn. Same class; raise priority accordingly. (Also BUG-041
  adjacent: the turn did continue — "ended without completing" is an over-strong description.)

### 2026-08-11 — fix agent (worktree)
**Design landed: bounded first-prompt readiness gate INSIDE ClaudeRuntime (option 1, generalised), plus
a pinned contract that the one-shot dispatch path never had the bug at all.**

- **Probed ground truth that picked the design** (scripts/verify-mcp-ready.mjs encodes it):
  - In streaming-input mode the CLI answers the `mcpServerStatus()` CONTROL REQUEST from ~0.6s —
    before any turn — and transitions pending→connected on its own (probed with a scratch stdio MCP
    server that sleeps 6s in `initialize`).
  - `system:init` is emitted at first-TURN start, not CLI boot. So holding the first prompt until no
    server is `pending` makes the init frame itself report `connected` with the tools listed — and
    the honest-timeout case falls out for free: a released-on-timeout turn's init shows `pending`,
    which fires the existing BUG-035 notice.
  - **`claude -p` (the dispatch one-shot path) ALREADY WAITS for MCP servers** before its single
    turn: with the 6s-slow server, wall time 12.4s and the turn used the tool. The filed claim that
    one-shots "NEVER get them" was an over-extrapolation from streaming mode — corrected here, and
    pinned as a contract test so a CLI regression would be caught.
- **The fix** (src/server/runtime/claude-runtime.ts only; bridge untouched):
  - `start()`: when `mcpServers` is non-empty, hold the first prompt and poll `mcpServerStatus()`
    every 300ms until no server is `pending` (connected/failed/needs-auth/disabled are all terminal —
    a failed server releases immediately and keeps its BUG-035 failure report), or until the budget
    runs out. Budget: `CLAUDE_STATION_MCP_READY_TIMEOUT_MS`, default 20s, clamped to 60s, 0 disables
    (pre-fix behaviour). No MCP configured → synchronous push, zero added latency (asserted).
  - `send()` during the hold buffers and flushes AFTER the first prompt (defense-in-depth only — the
    bridge's busy-guard makes the window production-unreachable; asserted as a code contract, not
    driven end-to-end, because a mid-turn stdin user message is a path the CLI itself handles badly).
  - `close()` during the hold cancels the release (never pushes into an ended queue).
  - The BUG-035 pending notice is augmented on the timeout path: "The turn was held Ns for MCP
    readiness before starting anyway (budget CLAUDE_STATION_MCP_READY_TIMEOUT_MS)."
- **Contract update in scripts/verify-mcp-attach.mjs (C3)**: the old "turn-one gap is said out loud"
  assertion described pre-FEAT-055 behaviour; now turn one must EITHER really have Serena (gate) OR
  say the gap out loud (bounded wait exceeded). Re-run: 20/20 including the new C3 — through a real
  scratch station, turn ONE had Serena.
- **Verification** (scripts/verify-mcp-ready.mjs, `npm run verify:mcp-ready`, scratch dirs, real CLI):
  - **Pre-fix FAIL proof** (runtime change stashed): **4/9** — A1 init `pending` + no tools, A2 turn
    one could not call the tool, A3 false "still starting" notice fired, plus ordering; B2 honesty
    absent.
  - **Post-fix: 10/10** — A1 first init `connected` + tools listed; A2 turn one CALLED the slow
    server's tool; A3 no false notice; B1 budget 3s vs 15s server → turn started (bounded); B2 honest
    held-Ns notice; B3 init really `pending`; C1 no-MCP session with a huge (45s) armed budget →
    first init in <1s (zero added latency); D1 dispatch.mjs one-shot used the MCP tool end-to-end;
    E1/E2 ordering contracts.
  - **Anti-regressions**: verify:mcp-attach 20/20, verify:tool-toggle 13/13, verify:dispatch 24/24,
    typecheck clean.
- **Status: FIXED in this worktree — NEEDS DEPLOY.** The live station on :4317 still runs the old
  code; until the next deploy/restart its sessions keep losing turn one to pending MCP servers (the
  2026-08-11 main-session evidence above stays reproducible there). Do not close before a deploy
  confirms turn-one tools on the real service.

### 2026-08-12 — board hygiene: closed to Done (verified + merged)
- Status FIXED(worktree)→VERIFIED (the board row said "fixed in worktree — needs deploy", stale).
  The 2026-08-11 fix entry is the evidence: 10/10 post-fix (pre-fix 4/9), turn-one Serena present
  end-to-end, dispatch one-shot used the tool, zero added latency when no MCP configured;
  anti-regressions green. Fix `4f9e8ff`, merged to main via `3c6a0b5`.
- Deploy: this ticket asked not to close before a LIVE-service deploy confirms turn-one tools. The
  merge is an ancestor of the day's later commit `275407e` that the orchestrator cites as the
  2026-08-11 deploy; I did NOT independently probe the :4317 service (out of this charter), so live
  confirmation is asserted by the orchestrator, not verified here. Board Done = verified+committed,
  so → Done with that caveat recorded rather than buried.
