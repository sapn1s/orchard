# ROUTING.md — provider/model dispatch guidance (mixed Claude + GPT fleet)

> **STALENESS:** researched 2026-08-05 (FEAT-043 Phase R; web-sourced, every claim dated+cited in
> the research log — claude-station `docs/bugs/FEAT-043-mixed-provider-fleet.md`). Re-verify after
> ANY major model release from either provider. If this table is older than **~3 months**, treat it
> as expired and re-research before trusting it. Undated model folklore is banned as a routing
> input.

Both subscriptions (Anthropic Max + ChatGPT) are meant to be sweated **together**, not as
alternates. A Claude orchestrator's in-process subagents can never be GPT — the mixed fleet's
dispatch unit is the **orchestrated task**: route whole tasks to the stronger/cheaper provider via
the dispatch runner (below), and keep premium hours for work whose mistakes are expensive.

<!-- routing-inject:start -->
## Top routing rules (condensed core — benchmark evidence for each line is in the full doc below)

- **Architecture, hard multi-file coding, novel problem shapes** → Claude Opus 5. Escalate to
  Fable 5 only for frontier-hard work.
- **Math / formal reasoning** → Fable 5 first, Opus 5 second. Do NOT route math to GPT by default
  — the folklore ("GPT good at maths") is inverted at the frontier.
- **UI / visual design direction** → Fable 5 sets the direction; GPT-5.6 Sol is a legitimate
  runner-up for implementation passes.
- **Long-context sweeps (500K–1M token reads)** → GPT-5.6 Sol.
- **Terminal-heavy repo chores** → GPT-5.6 Sol/Terra; browser/OS/multi-step agentic → Claude.
- **Bulk / parallel / low-stakes** → the ABUNDANT side's ladder (see budget note) — for this user
  that is Claude (Sonnet 5 / Haiku 4.5), not GPT.
- **Verification / adversarial review → CROSS-PROVIDER by default:** have the OTHER provider's
  model review finished work, so correlated blind spots differ.
- **`plan+review` dispatches (WA §I) are cross-provider by default** — the plan's reviewer is the
  OTHER provider than the implementer. `explore` may be cross-provider; optional.
- **BUDGET (per-user capacity fact, 2026-08-10 — configuration, not physics):** Claude capacity is
  effectively ABUNDANT here; the OpenAI side is a $20 ChatGPT Plus plan on rolling 5-hour windows
  and is the SCARCE resource. Spend GPT where its DECORRELATION value is highest — plan review,
  adversarial review of finished work, a second opinion on a contested call — NOT on bulk/parallel
  volume, which goes to the abundant Claude side. Fable 5 stays availability-fragile (50% weekly
  cap) — never hard-depend on it. When one provider's window is exhausted mid-task, degrade WITHIN
  the other provider's ladder — don't upgrade tiers.
- **Dispatching from a claude-station session:**
  `npm run dispatch -- --provider openai [--model <m>] [--sandbox workspace-write] "task"` —
  final result on stdout, progress on stderr, run recorded into Orchard history. Sandbox defaults
  to read-only.
<!-- routing-inject:end -->

## Ladder (cost-of-mistake tiers)

| Tier | Anthropic | OpenAI |
|---|---|---|
| top | Fable 5 ($10/$50; availability-fragile, 50% weekly cap) | GPT-5.6 Sol ($5/$30) |
| mid | Opus 5 ($5/$25) / Sonnet 5 | GPT-5.6 Terra ($2/$12) |
| cheap | Haiku 4.5 | GPT-5.6 Luna ($0.20/$1.20) |

## Route by task type (evidence-backed, as of 2026-08-05)

- **Architecture, hard multi-file coding, novel problem shapes** → Claude Opus 5.
  (SWE-bench Verified 97.0% vs Sol 96.2%; ARC-AGI-3 30.2% vs Sol 7.8%.) Escalate to Fable 5 only
  for frontier-hard work.
- **UI/visual design direction** → Fable 5 sets the visual direction (taste — anecdotal consensus,
  gap narrowing); GPT-5.6 Sol now ranks #1 on Design Arena Web Design and is fine for
  implementation passes. Sol's remaining weaknesses: design-instruction fidelity, clichéd layouts.
- **Math / formal reasoning** → Fable 5 first (FrontierMath hardest tier 88% vs GPT-5.5's 75%),
  Opus 5 second. No published Sol-vs-Fable FrontierMath yet (UNKNOWN whether 5.6 closed the gap).
- **Long-context sweeps (500K–1M)** → GPT-5.6 Sol (MRCR v2 8-needle 91.5% @1M; Opus 5 MRCR
  unpublished = UNKNOWN).
- **Terminal-heavy agent runs / repo chores** → GPT-5.6 Sol or Terra (Terminal-Bench 2.1 leader,
  88.8%); browser/OS/multi-step agentic → Claude (Opus 5 wins OSWorld 2.0 / BrowseComp /
  AutomationBench).
- **Verification / adversarial review** → Claude (independent trackers: ~4% vs ~6% hallucination;
  Sol noted as buying accuracy "at the cost of higher hallucination"). Cross-provider review is the
  real win regardless of direction.
- **Bulk / parallel / low-stakes** → on raw API PRICE, GPT-5.6 Luna/Terra win (Luna is ~5–15×
  cheaper than anything in the Claude ladder above Haiku). On this user's SUBSCRIPTIONS the
  binding constraint is not price but window capacity, and it points the other way — see
  Budget-pressure rules below.
- **Speed-critical interactive** → Sol on Cerebras (up to ~750 tok/s) or Opus 5 Fast Mode
  (~150 tok/s at 2× price).

## Budget-pressure rules

> **PER-USER CAPACITY FACT — dated 2026-08-10, corrected from the inverse.** This section is
> CONFIGURATION, not physics: it describes which subscriptions this operator actually holds, and
> it changes the moment the plans change. Re-check it whenever a plan is upgraded/downgraded (and
> at the same cadence as the staleness re-research above). The skill-based routing above is
> evidence-backed and independent of this; only the *spend* guidance below depends on it.
>
> **Current holdings:** Anthropic capacity is effectively ABUNDANT for this operator. The OpenAI
> side is a **$20 ChatGPT Plus** plan on rolling 5-hour windows — it is the **SCARCE** resource.
> (This file previously said the opposite; that guidance was wrong for this user and any routing
> decision made under it should be re-examined.)

- **Spend GPT on DECORRELATION, not on volume.** The scarce provider's marginal hour is worth most
  where a second, differently-biased mind changes the outcome: reviewing a PLAN before a build
  (WA §I `plan+review`), adversarial review of finished work, and a second opinion on a contested
  call. Those are the GPT budget's intended consumers.
- **Bulk, parallel, high-fan-out and long-running grind go to the ABUNDANT side** — Claude
  Sonnet 5 / Haiku 4.5 — even when a GPT tier would be cheaper per token. Burning a 5-hour window
  on volume work means the decorrelated review is unavailable when it actually matters.
- Route by SKILL first (the evidence above), then break ties with this budget rule. A genuine
  skill edge (e.g. a 1M-token sweep) still justifies spending the scarce side — deliberately.
- Fable 5 remains availability-fragile (50% weekly cap, historically yanked with zero notice) —
  never hard-depend on it, regardless of budget.
- When one provider's window is exhausted mid-task, degrade WITHIN the other provider's ladder
  rather than upgrading tiers to compensate.

## Dispatch usage (claude-station's runner)

Any orchestrator session dispatches an ORCHARD-level task to the other provider via Bash
(`scripts/dispatch.mjs`; final result on stdout, progress on stderr, exit nonzero with a named
error taxonomy kind on failure, run recorded into the dashboard's Orchard history):

- **Bulk / long-context sweep** (GPT's verified edge — big reads, cheap windows):
  `npm run dispatch -- --provider openai "Read every file under docs/bugs/ and list every ticket that mentions transcripts, one line each: ID — title — status"`
- **Terminal chore** (needs writes → opt into the workspace-write sandbox):
  `npm run dispatch -- --provider openai --sandbox workspace-write "Run the linter and fix all autofixable issues under src/ui/"`
- **Cross-provider adversarial review** (the marquee use-case — read-only default is exactly
  right):
  `npm run dispatch -- --provider openai "Review src/server/templates.ts for bugs, risky edge cases and unclear contracts. Return structured findings: SEVERITY — file:line — finding — suggested fix."`
- Symmetric Claude-side dispatch (thin `claude -p` delegation):
  `npm run dispatch -- --provider anthropic --model opus "…"`

## Auto-push / auto-deploy rule (gatekeeper required)

An LLM must NOT auto-push or auto-deploy without an independent gatekeeper PASS. Before any
unattended push/deploy, run claude-station's `scripts/gatekeeper.mjs` on the outgoing commit range
(fresh context per run — never the authoring session's; mechanical leak-gate + typecheck first,
then cross-provider reviewers per rule above, defaulting to the OTHER provider than the author;
`--install-hook` wires it as a per-repo pre-push hook) and proceed only on exit 0. A PASS is
probabilistic risk REDUCTION, not a guarantee — but skipping the gate for an unattended
push/deploy is a routing violation.

## Consumers

- **claude-station** mirrors this file at `docs/prompts/ROUTING.md` (sync:
  `npm run sync:methodology`; drift check: `npm run verify:methodology-sync`) and auto-injects the
  marked condensed core above (`routing-inject` markers) into launched sessions' system prompts
  (`src/server/templates.ts#routingSection`). Keep the marked region SMALL — it competes for the
  same attention budget as the Working Agreement.
