# ROUTING.md — provider/model dispatch guidance (mixed Claude + GPT fleet)

> # ⚠ STALENESS BANNER — READ FIRST
> **The model names, prices and benchmarks below were researched 2026-08-05 and go stale fast.**
> If today is more than **~3 months** after that date, or ANY major model has shipped from either
> provider since, treat this entire table as **EXPIRED** — re-research before trusting a single
> routing line. Undated model folklore is banned as a routing input. (Research log, if your
> project keeps one: Orchard `docs/bugs/FEAT-043-mixed-provider-fleet.md`.)

When you have more than one provider available (e.g. a Claude *and* a GPT subscription), they are
meant to be sweated **together**, not as alternates. A Claude orchestrator's in-process subagents
can never be GPT — the mixed fleet's dispatch unit is the **orchestrated task**: route whole tasks
to the stronger/cheaper provider via a dispatch runner (below), and keep premium hours for work
whose mistakes are expensive. **With only one provider configured, ignore the cross-provider rules
entirely and route by SKILL within that provider's ladder.**

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
- **Bulk / parallel / low-stakes** → the ABUNDANT side's ladder (see budget note). *Which* provider
  is abundant is a per-operator fact, not a model property — read it from your operator-local
  capacity overlay if one is injected; absent one, use the cheapest adequate tier of whatever
  provider you have.
- **Verification / adversarial review → CROSS-PROVIDER by default (when a second provider is
  available):** have the OTHER provider's model review finished work, so correlated blind spots
  differ. With one provider, still use an independent reviewer — same provider, separate clean-room
  process.
- **`plan+review` dispatches (WA §I) are cross-provider by default** when you have two providers —
  the plan's reviewer is the OTHER provider than the implementer. `explore` may be cross-provider;
  optional.
- **BUDGET (per-operator capacity — configuration, not physics):** which provider is ABUNDANT and
  which is SCARCE depends on the operator's actual subscriptions/billing, *not* on the models. Your
  machine's real holdings are supplied by an operator-local overlay if one is injected (see the
  "Operator-local context" section, if present, and `OPERATOR.local.md.example`). Absent that
  overlay, treat **neither** side as free and route by SKILL alone. When you DO know which side is
  scarce: spend it where its DECORRELATION value is highest — plan review, adversarial review of
  finished work, a second opinion on a contested call — NOT on bulk/parallel volume, which goes to
  the abundant side. Fable 5 stays availability-fragile (50% weekly cap) — never hard-depend on it.
  When one provider's window is exhausted mid-task, degrade WITHIN the other provider's ladder —
  don't upgrade tiers.
- **Dispatching a whole task to the other provider** (if your harness provides a dispatch runner —
  Orchard's is `npm run dispatch`):
  `npm run dispatch -- --provider openai [--model <m>] [--sandbox workspace-write] "task"` —
  final result on stdout, progress on stderr, run recorded into the dispatch history. Sandbox
  defaults to read-only.
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
  cheaper than anything in the Claude ladder above Haiku). On a SUBSCRIPTION plan (vs raw API
  billing) the binding constraint is often window capacity rather than price, which can point the
  other way — see Budget-pressure rules below.
- **Speed-critical interactive** → Sol on Cerebras (up to ~750 tok/s) or Opus 5 Fast Mode
  (~150 tok/s at 2× price).

## Budget-pressure rules

> **PER-OPERATOR CAPACITY FACT — CONFIGURATION, not physics.** Which subscriptions/plans an
> operator holds — and therefore which provider is ABUNDANT and which is SCARCE — is not a property
> of the models and is not recorded in this shared doc. It belongs in an **operator-local capacity
> overlay**, injected per machine and never published (see `OPERATOR.local.md.example` for the
> shape, and the "Operator-local context" section of your system prompt if one is present). It
> changes the moment the plans change, so it is kept with the operator, not here. The skill-based
> routing above is evidence-backed and independent of this; only the *spend* guidance below depends
> on knowing which side is scarce — and absent an overlay you do not know, so route by skill and
> treat neither side as free.

- **Spend the SCARCE provider on DECORRELATION, not on volume.** Once your overlay tells you which
  side is scarce: its marginal hour is worth most where a second, differently-biased mind changes
  the outcome — reviewing a PLAN before a build (WA §I `plan+review`), adversarial review of
  finished work, and a second opinion on a contested call. Those are the scarce budget's intended
  consumers.
- **Bulk, parallel, high-fan-out and long-running grind go to the ABUNDANT side** — even when the
  scarce side's tier would be cheaper per token. Burning a scarce capacity window on volume work
  means the decorrelated review is unavailable when it actually matters.
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
