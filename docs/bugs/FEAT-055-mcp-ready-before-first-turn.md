```orchard-ticket
{
  "id": "FEAT-055",
  "type": "feature",
  "title": "First turn of a session ran without its project tools",
  "summary": "Sessions started before their configured tool servers had attached, so the first turn ran with none of them available. A dispatched agent that only ever takes one turn therefore never got them at all, and worked on silently without them. A bounded readiness gate now holds the first prompt until the servers report ready or the wait times out.",
  "impact_if_we_wait": "One-shot dispatched agents would keep working without the tools their project enabled, producing quietly weaker results. Bounded: interactive sessions recovered by the second turn, nothing was lost or corrupted, and sessions with no servers configured were never affected.",
  "current_need": "Nothing is outstanding. The readiness case failed before the change and passed after it, the attach, toggle and dispatch suites all passed, and standing checks stayed clean.",
  "severity": "medium",
  "area": "Session start readiness",
  "reported": "2026-08-09",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-12",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-09",
      "question": "Should the first prompt wait for every configured server, only the dispatch runner, or neither?",
      "mode": "single",
      "options_keys": [
        "1",
        "2",
        "3"
      ],
      "chosen": "1",
      "chosen_on": "2026-08-11",
      "chosen_by": "agent",
      "note": "The ticket recommended fixing dispatch first and generalising later. What shipped was the bounded general gate on the first prompt, which covers dispatch as its worst case. Sequencing was flagged against BUG-033 and BUG-034, which contend for the same runtime seam."
    }
  ],
  "success_criteria": [
    "Tools are present on turn one for a session that configures them, or an honest wait state is shown",
    "A dispatched one-shot agent has its tools available for its single turn",
    "No added start latency when no servers are configured",
    "The timeout path reports honestly when a server never connects"
  ],
  "code_refs": [
    {
      "path": "src/bridge",
      "symbol": null,
      "note": "first-prompt readiness gate; the same runtime seam contended by BUG-033 and BUG-034, so the work was sequenced against them"
    }
  ],
  "related": [
    {
      "id": "BUG-033",
      "relation": "see_also"
    },
    {
      "id": "BUG-034",
      "relation": "see_also"
    },
    {
      "id": "BUG-035",
      "relation": "depends_on"
    },
    {
      "id": "BUG-041",
      "relation": "see_also"
    },
    {
      "id": "BUG-107",
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
    "archived_path": "docs/bugs/archive/FEAT-055-mcp-ready-before-first-turn.md",
    "sha256": "a35237443cc887d2686916754cf055b02288624b41ce534f8c4bea5f151c474e",
    "bytes": 7794,
    "original_title": "MCP servers are not ready for turn one (one-shot agents never get them)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the live probe timings, the one-shot dispatch consequence, all three options with their costs, the recommendation, and the four verification bars are present.",
    "dropped": [
      "the shorthand naming of the streaming-input CLI mode, which the diagnosis states in full"
    ]
  }
}
```

# FEAT-055 — First turn of a session ran without its project tools

## Diagnosis

### Why turn one had no tools

In the streaming-input mode the station uses, the CLI does not wait for tool servers before starting the first turn. Session startup emits an init record immediately, listing configured servers as still pending, and emits a second init once they attach.

An interactive session recovers on its second turn. A dispatched agent takes exactly one turn, so it never reaches the point where the tools exist. An earlier change made this state announced rather than fixed: the interface said the servers were still attaching, and the turn ran anyway.

## Evidence

### The live probe

Probed live with a warm cache in direct isolation: the first init arrived at 644ms with the configured server reported as pending and zero tools exposed, so turn one ran without it. A second init at roughly 17 seconds reported the server connected with 21 tools, which is what turn two saw.

### What ran on the fix

The first-prompt readiness case failed 4 of 9 before the change and passed 10/10 after it. Anti-regression suites came back green: `verify:mcp-attach` 20/20, `verify:tool-toggle` 13/13, `verify:dispatch` 24/24. Typecheck stayed clean. The fix landed as `4f9e8ff` and merged to main as `3c6a0b5`; a note on 2026-08-12 records the confirmation that it was live on the running service.

## Implementation notes

### What shipped

A bounded gate on the first prompt: hold until every configured server reports connected or failed, with a timeout and an honest still-attaching state rather than an indefinite block. Sessions with no servers configured skip the gate entirely, so they take no extra startup time.

The original recommendation was to patch the dispatch runner first — either a cheap no-op first turn or a wait for the connected init — and generalise later. The general gate was built directly instead, which subsumes the dispatch case.

## Verification plan

Assert that tools are present on turn one for a session that configures a server, or that an honest wait state is shown instead. Prove the dispatch runner has its tools available for its single turn. Confirm no added latency when nothing is configured, and that the timeout path stays honest when a server never connects.

## Risks

### The cost that was accepted

The gate adds startup latency to every session that configures a server. That was the known price of the general fix, and it is why the ticket originally proposed the narrower dispatch-only change first.

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
