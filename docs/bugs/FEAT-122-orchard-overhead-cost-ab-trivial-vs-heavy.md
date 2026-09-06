# FEAT-122 — Measure Orchard's per-task cost overhead (A/B: bare CLI vs full Orchard), trivial vs heavy

- **Status:** OPEN — finding recorded (measurement complete; see log). No code change.
- **Severity:** low
- **Area:** analysis / cost-model (FEAT-086 family)
- **Reported:** 2026-09-04 by dispatched lane (cost experiment, round 2)
- **Verification-class:** docs-only — this ticket records a measurement. All dollar/token
  figures are from `scripts/lib/cost-model.mjs` over real transcripts (commands in the log).

## Symptom / question
What does the full Orchard instruction stack (WA v4 system prompt + board preamble + forced-dispatch
profile) actually COST per task versus a bare `claude` CLI running the same task on the same model,
and does the ratio hold when the lane does substantial work rather than a trivial one?

## What was measured
Same fixed task, same model (`claude-sonnet-5`), two environments:
- **Arm A (Orchard):** scratch project `cost-ab-orchard` with CLAUDE.md, `.claude/settings.json`
  PreToolUse hook running `orchestrator-profile.decide()` (forces dispatch, 0 inline), WA v4
  appended as system prompt (~547 lines / 38 KB), board preamble prepended to the user prompt.
- **Arm B (bare):** empty scratch dir `cost-ab-bare`, no CLAUDE.md, no hook, no system prompt —
  just the task text.

Two tasks: a **trivial** one (`slugify.js` + tests, recovered verbatim from the prior lane's
transcript so reps are comparable) and a **heavy** one (LRU cache class: eviction + TTL + peek/has/
delete/clear/size, full `node:test` suite, README).

## Result (corrected cost-model, USD, list-rate lower bound)
Trivial: **Arm A n=2** $0.3034 / $0.3079 (mean $0.306, ~0.7% spread) · **Arm B n=3** $0.1011 /
$0.2116 / $0.1869 (mean $0.166, HIGH variance). Heavy: **Arm A n=1** $0.349 · **Arm B n=1** $0.339.

- Trivial ratio A/B ≈ **1.8x** on means; ≈ **1.5x** like-for-like (both dispatching).
- Heavy ratio A/B ≈ **1.03x** — the arms tie once the lane earns its cold start.
- Bare arm B is **bimodal**: it dispatches a subagent only sometimes (task says "use subagents
  where applicable"). Orchard's profile forces dispatch every time, so Orchard is consistent
  (~$0.31) while bare swings $0.10 (inline) → $0.21 (dispatched).

## Attributed overhead (trivial, like-for-like)
Delta ≈ $0.10 on the orchestrator turn, almost all of it the **instruction stack**: Arm A's
orchestrator carries ~14k extra 1h-cache-WRITE tokens (~$0.084 at 2x base) + ~27k extra
cache-READ tokens (~$0.008) over the bare baseline — i.e. the WA v4 prompt + board + CONVENTIONS
cached once and re-read per turn. Board preamble alone is negligible (~hundreds of tokens). The
**per-lane cold start** (~$0.10/lane: ~35-50k cache-read + ~18k cache-write) is paid by BOTH arms
whenever they dispatch; it is a delta only on trivial work, where bare sometimes inlines instead.

## Context pack
- Method doc: `docs/analysis/COST-METHOD.md` (LAST-row-wins dedupe, TTL-split cache, price-by-exact-
  model+tier). Corrected model: `scripts/lib/cost-model.mjs` (`npm run verify:cost-collect`).
- The CLI's own `total_cost_usd` under-prices 1h cache writes (~0.65x of corrected), so raw CLI
  numbers (A $0.204 / B $0.069 quoted by the prior lane) understate absolute cost but preserve the
  ratio.
- Related: FEAT-086 (cost attribution view), FEAT-096 (orchestrator tool profile / forced dispatch).
- Scratch projects were deregistered and deleted after measurement (see log).

## Activity log (APPEND-ONLY)

### 2026-09-04 — cost experiment lane (round 2)
- **Understood:** prior lane completed Arm A run1 + Arm B run1 then hit a rate limit; its "run2/3"
  failures were a missing `/usr/bin/time` binary, not real runs. Recovered the exact task text,
  system prompt, board preamble and hook config from disk; both run-1 transcripts intact.
- **Measured:** re-derived run-1 costs from transcripts with the corrected model; ran Arm A trivial
  run2, Arm B trivial run2+run3, and one heavy run per arm (headless `claude -p --model sonnet
  --output-format json`, greenfield reset between reps). Figures above.
- **Verified:** corrected-model folded totals match the CLI's own `modelUsage` token aggregates
  exactly (cache-read/write/output) for run 1, confirming the transcript read is faithful; the
  dollar gap to the CLI's `total_cost_usd` is the documented 1h-cache-write mispricing.
- **Honesty:** Arm A trivial held at n=2 (variance <1%, and the 5h provider window was flagged PARK
  — spending a third A rep was not worth the quota). Heavy is n=1/arm — a single pair, directional,
  not a precise multiplier. No rep died on a rate limit.
- **Symptom of a deeper design flaw?** no — the overhead is the cost of what Orchard buys
  (traceability, forced verification independence, a durable per-lane record). The decision-relevant
  finding is that it amortises to ~nil on real work.
