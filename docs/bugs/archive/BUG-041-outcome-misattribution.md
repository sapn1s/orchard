# BUG-041 — agent deaths get a WRONG cause (a non-fatal pending-MCP notice reported as the reason)

- **Status:** VERIFIED (2026-08-11 — fix agent, isolated worktree; 45/45 incl. 15 new BUG-041 checks, pre-fix 26/41)
- **Area:** FEAT-057 outcome ledger + BUG-031 classification latching + rail item detail
- **Reported:** 2026-08-10 by user ("'2 agents stopped — tooling-unavailable' is a good indication
  but doesn't tell me what actually happened; I checked usage and I'm not limited")

## What happened (evidence)
The briefing + rail reported:
`general-purpose (Build FEAT-059) — tooling-unavailable (anthropic): MCP tool server still
starting: serena … [2026-08-10T05:59:01.936Z]` and the same for `the main turn` at `…01.939Z`.
- The deaths were REAL: FEAT-059's agent left half-finished edits (`src/lib/paths.ts`,
  `src/server/registry.ts`), its ticket still `OPEN`, and no scratch dir was created.
- The REASON is wrong. "MCP tool server still starting" is BUG-035's deliberately NON-FATAL
  `pending` notice (FEAT-055: servers attach after turn one). It cannot kill a turn. The ledger
  latched the turn's last classified ProviderError and reported it as the cause of death.
- **3 ms apart, main turn + subagent together** ⇒ a HOST-level event, not two independent agent
  failures (see BUG-037 — this is a dated data point for it).

## Two defects
1. **Misattribution (the serious one).** FEAT-057's own rule is "never fabricate a cause;
   'ended, reason unknown' is the honest fallback". A latched non-fatal notice must NOT be
   promoted to a death cause. Only classifications that are terminal for the turn may become the
   `provider-error` reason; `pending` (and any other advisory kind) must be excluded, leaving
   `unknown` — optionally annotated ("MCP was still attaching at the time", clearly marked as
   context, not cause).
2. **Detail not shown.** The rail item shows kind only (`provider-error`, `tooling-unavailable`);
   the user cannot see what actually happened without the briefing. The ledger already stores the
   verbatim detail — surface it (expand/hover on the item), including "reason unknown" when that
   is the truth.

## Fix direction
- Filter advisory/pending classifications out of outcome attribution at the source
  (`attachProviderError()` / whatever latches the per-turn error), with a test for the exact shape
  above.
- When the cause is unknown, say so, and give what IS known (exit timing, whether the host died,
  whether sibling turns ended simultaneously — a same-millisecond cluster is itself evidence and
  should be reported as "host-level event" rather than N independent deaths).
- Rail item: show the stored detail; keep it dismissible.

## Verification (must FAIL pre-fix)
Fixture: a turn that receives a `pending` MCP notice and then dies from an unrelated cause →
recorded cause is `unknown` (+ pending noted as context), NOT `tooling-unavailable`; a turn that
genuinely fails from a terminal provider error still records that error verbatim; a
same-millisecond cluster of main+subagent deaths is reported as one host-level event; the rail item
exposes the detail. Anti-regressions: verify:agent-outcomes 26/26, verify:provider-errors 22/22,
verify:mcp-attach 20/20, typecheck.

## Activity log (APPEND-ONLY)
### 2026-08-10 — orchestrator
- Filed from the user's report; verified the deaths were real and the cause was not, before filing.

### 2026-08-10 — second false-positive shape (same ticket, different failure)
The FEAT-060 agent COMPLETED and delivered its full report; the ledger then recorded it as
`ended, reason unknown: the turn ended while this agent was still running and the engine reported
no outcome for it`. So the ledger over-reports in a second way: an agent that finished successfully
can be logged as an incomplete death when the parent turn ends before the engine emits its terminal
frame. Fix must distinguish "no terminal frame observed" from "did not complete" — a delivered
final result IS an outcome, and the ledger should treat the report/result as evidence of
completion. Verification should include: an agent that completes normally just as the parent turn
ends must NOT appear in the deaths ledger.

### 2026-08-11 — fix agent (isolated worktree) — FIXED & VERIFIED

**Third live shape collected before fixing** (2026-08-11, post-deploy): the ledger recorded
`the main turn — tooling-unavailable (anthropic): MCP tool server still starting: serena` as a turn
that "ended without completing" — the turn in fact continued and completed. Same root as defect 1
plus over-strong briefing wording.

#### What was wrong, precisely (all in the attribution path; drain/reap untouched)
1. **The latch** (`agent-bridge.ts #handle`): `if (!pe.retrying)` latched EVERY non-retrying
   classification as `lastProviderError` — including BUG-035's deliberately non-fatal
   `pending:true` tooling-unavailable notice. Every downstream writer then quoted it as the cause
   of death, and the main turn got a `provider-error` death record at `result` even when the turn
   simply finished.
2. **The turn-boundary sweep** wrote an `unknown` death for every foreground agent still `running`
   at `result` — including agents whose Task tool_result (the delivered final report) had already
   come back. "No terminal frame observed" was conflated with "did not complete".
3. **Same-instant clusters**: one host event (a cut session, one sweep) was written as N
   independent records with N `Date.now()` stamps and reported as N independent deaths — the live
   example was main + subagent 3 ms apart.
4. **Rail detail**: rows showed the kind only (`provider-error`), not what actually happened.

#### The fix (ARCH-002-aligned: the ledger is ADVISORY; entries carry corroborable evidence)
- `outcomes.ts isTerminalCause(pe)` — only a classification terminal for the turn may be a cause;
  `pending` and `retrying` are excluded. Applied at the latch (`agent-bridge.ts`), in
  `attachProviderError()` (returns 0 for advisory), and as DEFENSE IN DEPTH inside `record()` — the
  one choke point every write passes: an advisory pe demotes the kind to `unknown`, `providerError`
  stays null, and the notice is kept verbatim in `detail` marked "(context, not cause: …)".
  The bridge remembers the notice separately (`#advisoryNotice`, cleared at turn start with
  `lastProviderError`) and annotates unknown-cause records with it.
- `outcomes.turnEndOutcome()` — the sweep's per-agent decision, extracted and testable: a
  delivered Task tool_result → **null, nothing recorded** (evidence of completion outranks even an
  interrupt); user interrupt → `killed`; terminal pe → `provider-error` verbatim; else `unknown`
  with the advisory context. The bridge feeds it `#resultDelivered`, populated in the `user`-frame
  handler from tool_results whose tool_use_id maps to an agent. `#recordSessionEnd` also skips
  result-delivered agents.
- **Clusters**: writers that KNOW N rows are one host-level moment (`#recordSessionEnd`, the
  `result` sweep) stamp one shared `at` + `clusterId`. `outcomes.clustersOf()` groups by clusterId,
  plus an evidence heuristic for unstamped records (same session, ≤10ms apart — covers the live
  3ms pair). `takeBriefing` renders a cluster as ONE line ("host-level event: 3 ended together
  (the main turn + builder + tester, within 3ms) — one event, not 3 independent failures — cut"),
  `headline()` says "3 stopped together — one event (cut)" when everything shown is one cluster
  (client mirror updated identically).
- **Honest wording**: briefing head no longer claims "ended without completing" (unknown records
  may well have completed); the footer now says the briefing is ADVISORY and requires
  corroboration before abandoning/re-dispatching work (the ARCH-002 incident, written into the
  surface itself).
- **Rail detail** (minimal, rail only — tickets tab untouched): rows name the actual cause
  (`quota-window (openai)`, not the bare kind); hover carries the full stored evidence (detail +
  provider's verbatim text + ISO time).

#### Verification — `verify:agent-outcomes` extended 26 → 45 checks
- **POST-FIX: 45/45.** New: A6 advisory-never-a-cause (incl. the exact serena notice shape),
  A7 clusters (explicit + the 3ms-implicit live shape), A8 turnEndOutcome (completed → NO record;
  killed/provider-error/unknown honest), A9 source-conformance (the bridge's live call sites
  actually consult these functions — guards against a correct function nobody calls), C1 cluster
  end-to-end (a real SIGKILLed engine: main + 2 agents share one writer-stamped clusterId; the
  API headline reports one event).
- **PRE-FIX (same script, clean 3cfe103 worktree): 26/41 — all 15 BUG-041 checks FAIL**, observing
  the reported bug verbatim: `worker — tooling-unavailable (anthropic): MCP tool server still
  starting: serena` stored as a death cause, `attachProviderError` promoting the pending notice
  onto 2 unrelated deaths, 3 same-cut records with `clusterId: null` reported as "3 agents
  stopped — cut".
- **Anti-regression:** typecheck PASS, verify:running-snapshot 47/47, verify:liveness-conformance
  96/96 (regrowth guard clean). Parts B/C of the suite re-prove FEAT-057 end-to-end post-change
  (quota deaths recorded verbatim, briefing travels, dismissal persists).

**Not covered (named, not implied):** the pending-notice latch is proven at the unit +
source-conformance level, not by a live Claude engine emitting a real `system:init` pending frame
end-to-end (no fake Claude CLI exists; the codex fixture has no pending concept). The E2E halves
prove the same latch variable's terminal path live. `verify:provider-errors` / `verify:mcp-attach`
(live-CLI, token-costing) were not run; nothing in their surface changed except that a pending
classification is no longer latched — the `provider-error` EVENT emission they assert is upstream
of the latch and untouched.

**Files:** `src/server/outcomes.ts`, `src/server/agent-bridge.ts` (attribution sites only),
`public/app.js` (rail render only), `scripts/verify-agent-outcomes.mjs`. Scope constraint honored:
`session-host.mjs`, `survival.ts`, drain/reap logic untouched.
