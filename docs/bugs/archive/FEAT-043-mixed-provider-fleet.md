# FEAT-043 — mixed-provider fleet: orchestrator AND dispatched agents can each be GPT or Claude, routed by strength

- **Status:** IN PROGRESS — Phase R DONE; **v1 mixed fleet BUILT + VERIFIED (2026-08-05)**: ORCHARD-level dispatch runner (`scripts/dispatch.mjs`, fixture 15/0 + LIVE incl. a real cross-provider review), canonical `ROUTING.md` (methodology repo, synced mirror) and condensed routing injection into launched sessions (18/0). `npm run dispatch` / `verify:dispatch` / `verify:routing-inject` package.json entries ARE applied (orchestrator committed them 2026-08-05). **v1-hardening DONE (2026-08-05):** the live cross-provider review's accepted anthropic-path limitations (timeout, sandbox, taxonomy) are fixed — see the dated hardening entry below; `scripts/verify-dispatch.mjs` now 24/0. **Staleness trigger DONE (2026-08-06):** `scripts/wa-consolidate.mjs` now checks canonical `ROUTING.md`'s staleness header on every pass (propose + `--apply`, incl. the boot-time pass) and standalone via `--check-routing`; see the dated entry below. Remaining (honest): per-dispatch provider picker in the Agent/Task UI (original P1) is the only phase left; anthropic dispatch remains an application-level (not OS-level) sandbox and non-streaming (single JSON result, coarser progress than the openai path) — documented boundaries, not gaps to silently paper over.
- **Area:** orchestration / FEAT-037 P3+ / methodology (routing guidance)
- **Reported:** 2026-08-05 by user ("orchestrator … can be either gpt or claude AND can dispatch
  also agents of either … with global instructions explaining when to best use each model … we can
  essentially utilize the gpt sub greatly")

## Goal
Once both providers are connected (FEAT-037 P2/P3), exploit them TOGETHER, not as alternates:
1. A session's orchestrator can run on either provider.
2. The orchestrator can dispatch each subagent on EITHER provider per task (design task → the
   provider/model strongest at design; math-heavy verification → the one strongest there), so both
   subscriptions are sweated in parallel.
3. A routing guide lives in the shared methodology (WA or a routing doc): per-capability model
   recommendations, kept CURRENT by periodic research — the folklore ("gpt bad at design, fable
   amazing; gpt latest good at maths") must be replaced by verified, dated findings, and re-checked
   each model generation (staleness is the failure mode).

## Phases
- **R (research, now):** current (2026-08) comparative strengths of the frontier Claude vs OpenAI
  models across: code architecture/design, UI/visual design taste, math/formal reasoning, long-
  context, agentic tool-use reliability, verification/adversarial review, speed/latency tiers.
  Reputable sources only (official evals, credible independent benchmarks — LMSYS/SWE-bench/AIME
  etc.), each claim dated+cited; explicitly mark what is contested/unknown. Deliverable: a dated
  routing table appended here + a draft `ROUTING.md` for the methodology repo.
- **P1 (needs FEAT-037 P3):** per-dispatch provider/model choice on the Agent/Task seam + UI.
- **P2:** routing guidance injected (WA §I extension) + periodic re-research trigger (staleness
  date on the table; consolidation loop flags an out-of-date routing table).

## Constraints
- Subagent dispatch differences per provider (Claude has Task-tool subagents; Codex capabilities
  say subagents:false) — the mixed fleet's unit is the ORCHARD-dispatched agent (our Agent tool /
  session-level), not the provider's internal subagents; design must respect that.
- Usage limits differ (Anthropic quotas vs ChatGPT rolling 5h windows) — routing should consider
  budget pressure, not just skill.

## Activity log (APPEND-ONLY)
### 2026-08-05 — orchestrator
- Filed from user idea. Research phase dispatched; build phases blocked on FEAT-037 P2c/P3
  (live Codex + provider picker). Pairs with BUG-031 (error taxonomy must be solid before a
  mixed fleet multiplies failure shapes).

### 2026-08-05 — research agent — Phase R findings (research date: 2026-08-05; web-sourced)

**Method:** WebSearch across official announcements, benchmark aggregators (llm-stats,
Artificial Analysis, morphllm, LMArena trackers) and practitioner writeups. Every claim carries a
source URL; contested or unmeasured items are marked UNKNOWN/anecdotal. Numbers below are as
reported by the cited pages on 2026-08-05 — several are aggregator-relayed, not independently
reproduced.

#### 1. The current model landscape (established first, not assumed)

**OpenAI (frontier = GPT-5.6 family, released 2026-07-09):**
- **GPT-5.6 Sol** — flagship, default model in Codex. $5/$30 per M tokens.
- **GPT-5.6 Terra** — mid "everyday workhorse". $2/$12 (cut 20% on 2026-07-30).
- **GPT-5.6 Luna** — cheap tier. $0.20/$1.20 (cut 80% on 2026-07-30).
- **GPT-5.3-Codex** (2026-02-05) still exists as OpenAI's first LTS model (12-month support;
  base model for Copilot Business/Enterprise) — but there is NO dedicated GPT-5.6-Codex; Codex
  simply runs Sol/Terra/Luna.
- Sources: https://openai.com/index/gpt-5-6/ ; https://www.aipricing.guru/openai-pricing/ ;
  https://en.wikipedia.org/wiki/GPT-5.3-Codex ; https://github.blog/changelog/2026-05-17-gpt-5-3-codex-is-now-the-base-model-for-copilot-business-and-enterprise/ ;
  https://kie.ai/blog/codex-chatgpt-work-gpt-5-6-analysis

**Anthropic (Claude 5 family):**
- **Fable 5** (2026-06-09) — public Mythos-class flagship. $10/$50, 1M ctx, 128K out, always-on
  adaptive thinking. NOTE availability risk: suspended 2026-06-12→07-01 by a US export-control
  directive (lifted 06-30); redeployed capped at 50% of weekly sub limits. Routing must not
  hard-depend on Fable. (https://www.anthropic.com/news/claude-fable-5-mythos-5 ;
  https://explainx.ai/blog/is-fable-5-back-2026 ; https://www.cnbc.com/2026/06/09/anthropic-mythos-claude-fable-5.html)
- **Mythos 5** — same underlying model, restricted access (Project Glasswing: cybersecurity/
  biosciences partners only). Not routable for us; ignore. (https://www.anthropic.com/claude/mythos)
- **Opus 5** (2026-07-24) — $5/$25, 1M ctx, 128K out, knowledge cutoff May 2026. Anthropic's
  "use every day" model; tops Fable 5 on most benchmarks at half the price. Fast Mode: ~2.5×
  speed at 2× price. (https://techcrunch.com/2026/07/24/anthropic-launches-opus-5/ ;
  https://www.explainx.ai/blog/claude-opus-5-launch-july-2026)
- **Sonnet 5** (2026-06-30) — near-Opus-4.8 performance at Sonnet pricing; strong agentic
  multi-step. SWE-bench Verified 72.7%, Terminal-bench 76.1%.
  (https://www.datacamp.com/blog/claude-sonnet-5)
- **Haiku 4.5** — cheap tier; no Haiku 5 surfaced in any 2026 source checked → current cheap
  tier confirmed as 4.5 by omission only (UNKNOWN whether a refresh is imminent).

#### 2. Routing table (dimension → provider+model, confidence, citations)

| Dimension | Pick | Runner-up | Confidence | Evidence |
|---|---|---|---|---|
| Code architecture / hard coding | **Claude Opus 5** | Fable 5; GPT-5.6 Sol | **solid** | SWE-bench Verified 97.0% vs Sol 96.2% vs Fable 95.0% (llm-stats, 2026-08-03: https://llm-stats.com/benchmarks/swe-bench-verified); Opus 5 wins 6 of 8 head-to-head benches vs Sol incl. Frontier-Bench agentic coding 43.3% vs 34.4% (https://llm-stats.com/models/compare/claude-opus-5-vs-gpt-5.6-sol) |
| Terminal-driven coding agents | **GPT-5.6 Sol** | Claude Sonnet 5 | **mixed** | Sol leads Terminal-Bench 2.1 at 88.8% (89.5% xhigh) and AA Coding Agent Index 80 (https://www.morphllm.com/best-ai-coding-agents-2026 ; https://artificialanalysis.ai/articles/gpt-5-6-has-landed); but Opus 5 wins the broader agentic set (below) |
| UI / visual design taste | **Fable 5** | GPT-5.6 Sol | **mixed→anecdotal** | Practitioner consensus: Fable has the aesthetic range/atmosphere, "final boss of AI for UI" (https://www.banani.co/blog/fable-5-ui-and-frontend-design); BUT Sol now ranks #1 on Design Arena Web Design, +18 places over GPT-5.5 (https://notes.designarena.ai/how-openais-sols-finally-learned-design-taste/); Sol criticized for design-fidelity instruction-following and repetitive card-stuffed layouts (https://www.banani.co/blog/gpt-5.6-ui-design-review) |
| Math / formal reasoning | **Fable 5** | Claude Opus 5 | **mixed** | Fable 5: 88% on FrontierMath hardest tier vs GPT-5.5's 75% (https://the-decoder.com/claude-fable-5-outpaces-gpt-5-5-by-13-points-on-frontiermaths-toughest-problems/); GPT-5.5 AIME 2025 95.2% (saturated bench); no published Sol-vs-Fable FrontierMath yet → UNKNOWN whether 5.6 closed the gap |
| Novel/unfamiliar reasoning | **Claude Opus 5** | — | **solid** | ARC-AGI-3: Opus 5 30.2% vs Sol 7.8% (~3× next best) (https://llm-stats.com/models/compare/claude-opus-5-vs-gpt-5.6-sol ; https://techcrunch.com/2026/07/24/anthropic-launches-opus-5/) — a genuine standout skew |
| Long-context recall (1M) | **GPT-5.6 Sol** | Claude Opus 5 | **mixed** | Sol: MRCR v2 8-needle 91.5% at 1M (https://llm-stats.com/models/compare/claude-opus-5-vs-gpt-5.6-sol); Opus 5 MRCR score not published → UNKNOWN (prior-gen Opus 4.6 got 76%); both accept ~1M input |
| Agentic tool use (browser/OS/multi-step) | **Claude Opus 5** | GPT-5.6 Sol | **solid** | Opus 5 wins OSWorld 2.0, BrowseComp, AutomationBench, GDPval-AA Elo 1861 vs 1736 (https://llm-stats.com/models/compare/claude-opus-5-vs-gpt-5.6-sol); Sonnet 5 explicitly positioned for agentic multi-step (https://www.datacamp.com/blog/claude-sonnet-5) |
| Adversarial verification / review, low hallucination | **Claude (Opus 5)** | GPT-5.6 Terra | **mixed→anecdotal** | Anthropic: Opus 5 "most aligned, lowest rates of deceptive behavior" (vendor claim: https://techcrunch.com/2026/07/24/anthropic-launches-opus-5/); independent trackers put Claude ~4% vs GPT ~6% hallucination (prior-gen models: https://modelslab.com/blog/llm/llm-hallucination-rates-2026); Sol noted as buying accuracy "at the cost of higher hallucination" (https://codingfleet.com/blog/ai-model-hallucination-rates-2026/). No dedicated adversarial-review benchmark found → partly UNKNOWN |
| Speed / latency | **GPT-5.6 Sol (Cerebras)** ; cheap-fast: Luna | Opus 5 Fast Mode | **solid** | Sol on Cerebras up to 750 tok/s (~12.5× Opus 5 standard); Sol standard 66.7 tok/s vs Opus 4.8 57.8; Opus 5 Fast Mode ~150 tok/s at 2× price (https://artificialanalysis.ai/models/comparisons/gpt-5-6-sol-high-vs-claude-opus-4-8 ; https://codingfleet.com/blog/claude-opus-5-vs-gpt-5-6-sol/) |
| Human-preference overall (Arena) | **Claude Opus-line** | Gemini (out of scope) | mixed | Opus 4.8 tops LMArena text Elo >1510, ahead of GPT-5.5 Pro (July 2026: https://www.toolcenter.ai/en/llm-leaderboard); Opus 5/Fable 5 arena placement not yet stable → partial UNKNOWN |

**Cost ladders (cost-of-mistake routing, WA §I/§N):**
- Anthropic: Fable 5 $10/$50 → Opus 5 $5/$25 → Sonnet 5 (Sonnet pricing; exact 2026 number not
  confirmed in sources checked → UNKNOWN, historically ~$3/$15) → Haiku 4.5 (cheap).
- OpenAI: Sol $5/$30 → Terra $2/$12 → Luna $0.20/$1.20. Luna is ~5–15× cheaper than anything
  in the Claude ladder above Haiku — the standout cheap tier across both providers.

**Subscription/limit realities (routing factor, not skill):**
- Anthropic Max: 5-hour caps doubled 2026-05-06; weekly limits +50% "through Aug 19, 2026"
  (i.e., may revert mid-August); Fable 5 capped at 50% of weekly usage; Opus-hours are the
  scarce resource (order-of-magnitude fewer than Sonnet-hours on the same plan).
  (https://www.morphllm.com/claude-code-usage-limits ; https://explainx.ai/blog/claude-usage-limits-2026-timeline-explained)
- ChatGPT: rolling 5h windows per model tier (Plus: Sol ~15–90 msgs/5h, Terra ~20–110, Luna
  ~50–280 — estimates, opaque); Pro restructured 2026-04-09 into $100 (5× Plus) and $200
  (20× Plus), same models. Codex on Plus = "a few focused coding sessions per week".
  (https://simplemetrics.xyz/chatgpt-codex-limits-2026/ ; https://tokenkarma.app/blog/openai-rate-limits-july-2026/)
- Implication: the GPT sub's Terra/Luna capacity is the bulk-work reservoir; Claude Opus/Fable
  hours are the scarce premium resource to be spent only where the cost of a mistake is high.

#### 3. Folklore verdict

The folklore is **half right and half backwards, and all of it was undated**. "Fable amazing at
design" — still holds, but as practitioner consensus (anecdotal), not benchmark fact, and the gap
has narrowed sharply. "GPT bad at design" — **outdated**: GPT-5.6 Sol now ranks #1 on Design
Arena's web-design leaderboard; its remaining weaknesses are design-instruction fidelity and
clichéd layouts, not raw aesthetics. "GPT latest good at maths" — **wrong way round at the
frontier**: Fable 5 beats GPT-5.5 by ~13 points on FrontierMath's hardest tier, and Opus 5 beats
Sol on nearly every published reasoning benchmark (ARC-AGI-3 by ~4×). GPT's *actual* verified
edges are different from the folklore: long-context needle recall, Terminal-Bench-style coding
agents, raw speed (Cerebras), and an unmatched cheap tier (Luna). The general pattern as of
2026-08: Claude leads quality/reasoning/agentic reliability; OpenAI leads speed/price/long-context
recall — route accordingly.

#### 4. Draft ROUTING.md (for methodology repo — content only, file NOT created here)

```markdown
# ROUTING.md — provider/model dispatch guidance (mixed Claude + GPT fleet)

> **STALENESS:** researched 2026-08-05. Re-verify after ANY major model release from either
> provider. If this table is older than ~3 months, treat it as expired and re-research before
> trusting it. Undated model folklore is banned as a routing input.

## Ladder (cost-of-mistake tiers)
| Tier | Anthropic | OpenAI |
|---|---|---|
| top | Fable 5 ($10/$50; availability-fragile, 50% weekly cap) | GPT-5.6 Sol ($5/$30) |
| mid | Opus 5 ($5/$25) / Sonnet 5 | GPT-5.6 Terra ($2/$12) |
| cheap | Haiku 4.5 | GPT-5.6 Luna ($0.20/$1.20) |

## Route by task type
- **Architecture, hard multi-file coding, novel problem shapes** → Claude Opus 5.
  (SWE-V 97%, ARC-AGI-3 ~4× Sol.) Escalate to Fable 5 only for frontier-hard work.
- **UI/visual design direction** → Fable 5 sets the visual direction (taste, anecdotal
  consensus); GPT-5.6 Sol is a legitimate runner-up and fine for implementation passes —
  "GPT can't design" is outdated.
- **Math / formal reasoning** → Fable 5 first, Opus 5 second. Do NOT route math to GPT by
  default (folklore inversion).
- **Long-context sweeps (500K–1M token reads)** → GPT-5.6 Sol (MRCR 91.5% @1M; Claude
  unpublished = UNKNOWN).
- **Terminal-heavy agent runs / repo chores** → GPT-5.6 Sol or Terra (Terminal-Bench leader);
  browser/OS/multi-step agentic → Claude (Opus 5 / Sonnet 5).
- **Verification / adversarial review** → Claude (lower measured hallucination; Opus 5 lowest
  deception per vendor). Cross-provider review is the real win: have the OTHER provider's model
  review work, so correlated blind spots differ.
- **Bulk / parallel / low-stakes** → GPT-5.6 Luna or Terra first (cheapest capacity, generous
  windows), Haiku 4.5 as Claude-side fallback.
- **Speed-critical interactive** → Sol (Cerebras) or Opus 5 Fast Mode.

## Budget-pressure rules
- Claude Opus/Fable hours are the scarce resource (weekly caps; Fable capped at 50% and
  historically yanked with zero notice) — never burn them on work a mid/cheap tier can do.
- The ChatGPT sub's Terra/Luna capacity is the bulk reservoir; drain it before touching
  premium Claude hours for parallelizable work.
- When one provider's window is exhausted mid-task, degrade WITHIN the other provider's
  ladder rather than upgrading tiers to compensate.
```

#### 5. Blocked on FEAT-037 P2c (no live Codex yet)

Every GPT-side recommendation is currently theoretical: long-context sweeps on Sol, bulk work on
Terra/Luna, terminal-agent routing to Sol, and cross-provider adversarial review all require the
live Codex connection (FEAT-037 P2c) and the per-dispatch provider picker (P3). Until then the
only actionable outputs are the Claude-internal ladder rules (Opus 5 vs Sonnet 5 vs Haiku 4.5,
Fable escalation policy) and the staleness discipline itself.

**Caveats:** several figures are aggregator-relayed (morphllm, llm-stats, codingfleet) rather than
read off official model cards; OpenAI stopped reporting SWE-bench Verified in early 2026, so
cross-vendor SWE-V comparisons are directional; Plus-tier message-window numbers are community
estimates (OpenAI keeps them opaque). Treat any single number as ±noise; the *ordering* claims
above are what multiple sources agree on.

### 2026-08-05 — builder — v1 mixed-provider fleet (dispatch runner + ROUTING.md + injection) — VERIFIED fixture + LIVE

**Design constraint honoured:** a Claude orchestrator's Task-tool subagents are in-process
Claude and can never be GPT — so v1's dispatch unit is ORCHARD-level: any orchestrator
session shells out to the provider-routed task runner and consumes its stdout.

**Built:**
- `scripts/dispatch.mjs` (NEW, ~220 lines) — `node scripts/dispatch.mjs --provider
  openai|anthropic [--model m] [--cwd dir] [--sandbox read-only|workspace-write]
  [--timeout-min n] [--] "task"`. openai path drives the REAL CodexRuntime (binary via
  detection / CLAUDE_STATION_CODEX_BIN — the same fixture seam as verify-codex-runtime);
  stdout = FINAL result text only (machine-consumable), stderr = progress (thread id,
  streamed deltas, tool activity, tokens, transcript path); exit nonzero names the BUG-031
  taxonomy kind (`dispatch failed [quota-window|auth-expired|…]`) via
  `classifyProviderError`. Every openai run is recorded into the Orchard transcript store
  (`TranscriptRecorder`, provider 'openai') so dispatches are auditable in the dashboard's
  history exactly like P2b sessions. anthropic path is deliberately THIN: `claude -p`
  delegation (its own store persists the transcript), exit code mirrored.
- **Safe defaults (documented):** headless ⇒ approvals can never be answered, so
  `src/server/runtime/codex-runtime.ts#modeToCodex` gained two ADDITIVE dispatch-only
  modes (~line 211): `dispatch:read-only` = approvalPolicy 'never' + sandbox 'read-only'
  (the default — review/sweep tasks cannot write; a write attempt fails in the sandbox
  instead of hanging on a prompt) and `dispatch:workspace-write` (opt-in via --sandbox,
  writes confined to cwd). Not exposed in the UI mode picker.
- `~/projects/methodology/ROUTING.md` (NEW, canonical; commit e0f9919 there) — from the
  Phase R draft: STALENESS header (researched 2026-08-05; re-verify after any major
  release / >3 months; undated folklore banned), top routing rules incl. CROSS-PROVIDER
  adversarial review as the default verification move, Fable-availability risk +
  subscription-window pressure as explicit routing factors, and concrete `npm run
  dispatch` examples (bulk/long-context sweep, terminal chore, cross-provider review).
  Mirrored to `docs/prompts/ROUTING.md` via `scripts/sync-methodology.mjs` (FILES list
  extended; `verify:methodology-sync` in-sync 3/3).
- **Injection (small by design):** `src/server/templates.ts#routingSection` (~line 350)
  reads the MIRROR and injects ONLY the `<!-- routing-inject:start/end -->` marked core.
  SIZE DECISION: the full doc is a ~7KB research dump that competes with the WA + board
  snapshot for attention; the marked condensed core (top rules + budget/availability
  factors + the one-line dispatch command) renders as a **2,343-byte** section under a
  header carrying the staleness date + pointer to the full doc; cap 4000 chars.
  `composeInstructions(refs, { routing: true|<path> })` folds it LAST (WA → local
  conventions → routing); absent mirror ⇒ byte-identical output (localConventionsSection
  pattern). Launch path wired: `agent-bridge.ts:~423` passes `routing: true`.
- **Dashboard visibility:** no gaps found — dispatch runs land in the same Orchard store
  P2b render is built on (`listOrchardSessions`/transcript routes, provider-tagged);
  verified at the store level in the new suite (fixture) and the live runs wrote real
  files under `~/.local/share/claude-station/transcripts/openai/…`.

**Verification (§C, non-vacuous):**
- PRE-CHANGE FAIL captured: `node scripts/dispatch.mjs …` and `node
  scripts/verify-dispatch.mjs` both exited 1 (MODULE_NOT_FOUND — scripts absent).
- `scripts/verify-dispatch.mjs` (NEW) — **15/0** against the fake app-server through the
  spawn seam: exact-stdout success, progress-on-stderr, default read-only announced +
  enum validated by the fake, transcript file + provider-tagged entries +
  `listOrchardSessions` listing, induced FAIL_QUOTA turn → exit 1 + `dispatch failed
  [quota-window] (provider openai): You've hit your usage limit…`, workspace-write
  accepted, anthropic thin path via a `claude` shim (`-p` + task + --model seen), usage
  errors loud.
- `scripts/verify-routing-inject.mjs` (NEW) — **18/0**: marked-core extraction (research
  dump EXCLUDED), staleness date + dispatch pointer in the header, absent/empty → null,
  no-marker degrade, maxChars cap, wiring (section after WA, appliedIds
  'provider-routing', missing file byte-identical, no-opt byte-identical), real mirror
  small (2343B) + `routing: true` launch spelling.
- LIVE (real ChatGPT subscription, modest): (1) `--provider openai "What is 17 * 23?"` →
  stdout `391`, 5 output tokens, transcript recorded
  (`transcripts/openai/-home-<user>-projects-claude-station/019fd1f4-ab40-….jsonl`).
  (2) **Cross-provider review smoke (the marquee use-case):** dispatched Codex read-only
  to review `scripts/dispatch.mjs` itself; it returned 6 structured findings, verbatim
  sample below.
- Anti-regression: verify:codex-runtime **39/0** · verify:orchard-transcripts **15/0** ·
  template-readthrough **18/18** · local-conventions **18/18** · conventions-live **5/5**
  · typecheck clean · verify:ui --offline **3/0** · methodology-sync in-sync 3/3.
  Constraints held: :4317 untouched, no installs, kills by pid, scratch temp dirs only,
  no claude-station commits (methodology repo committed, as expected).

**LIVE cross-provider review output (verbatim, first 3 of 6 findings):**
```
SEVERITY(high) — scripts/dispatch.mjs:95 — Anthropic dispatch has no timeout or termination logic, so `--timeout-min` is silently ineffective and a hung `claude -p` can run indefinitely — apply the timeout to both providers…
SEVERITY(high) — scripts/dispatch.mjs:91 — `--sandbox` is ignored for Anthropic, so a nominally read-only dispatch may execute with Claude's configured tool permissions and modify files — reject `--sandbox` for Anthropic or translate it…
SEVERITY(med) — scripts/dispatch.mjs:99 — Anthropic failures merely mirror the CLI exit code and do not emit the promised `dispatch failed [<kind>]` taxonomy — capture/classify stderr and emit a normalized failure line…
```
(plus: blanket `[transport]` label for pre-result stream errors, SIGINT kill-guard race,
`--` end-of-options missing). The `--` finding was FIXED on the spot (dispatch.mjs arg
loop; re-verified 15/0 + a literal `-- "--starts with dashes…"` run). The anthropic-path
findings are ACCEPTED v1 limitations of the deliberately-thin `claude -p` delegation
(documented here, not silently ignored); the transport-label + SIGINT items are low-risk
polish — all four are follow-up candidates, none blocks v1.

**package.json entries — APPLIED (2026-08-05, orchestrator):**
```
"dispatch":              "node scripts/dispatch.mjs",
"verify:dispatch":       "node scripts/verify-dispatch.mjs",
"verify:routing-inject": "node scripts/verify-routing-inject.mjs"
```
`npm run dispatch --` is now the working spelling (matches ROUTING.md's examples);
`node scripts/dispatch.mjs …` still works identically.

**Handoff:** original P1 (per-dispatch provider/model choice on the Agent/Task seam + UI)
and P2 (staleness re-research trigger wired into the consolidation loop) remain; plus the
four accepted review findings above.

### 2026-08-06 — hardening agent — v1 anthropic-path hardening (scripts-only lane; VERIFIED)

Closes the three anthropic-path findings from the 2026-08-05 live cross-provider review
(`--timeout-min` silently ineffective; `--sandbox` ignored; failures not classified into the
BUG-031 taxonomy). All fixes are in `scripts/dispatch.mjs`; no other files touched, no
package.json edit (entries already applied, see corrected status line above).

**Fixed (`scripts/dispatch.mjs`):**
- **Timeout parity** (`dispatchAnthropic()`, ~line 130): `claude` is now spawned `detached:
  true`; on `--timeout-min` expiry the whole process GROUP is killed (`process.kill(-pid,
  'SIGTERM')`, SIGKILL grace after 3s), exit is nonzero, and
  `dispatch failed [timeout]: no completion within N min — killing process group` is named
  on stderr — same contract shape as the openai path.
- **Sandbox translation** (~line 175): `--sandbox` is now honored, not ignored. read-only
  (default) → `--permission-mode plan --disallowedTools Edit,Write,NotebookEdit` (plan mode
  never executes writes headless since nothing can approve exiting it; the disallow-list is
  a hard backstop). workspace-write → `--permission-mode acceptEdits`. **Honest boundary
  (not faked):** this is an APPLICATION-LEVEL gate inside the `claude` process, not an
  OS-level filesystem jail like the openai path's Codex `sandbox_mode` — documented in the
  script's header comment, in `--help`, and here. A true FS jail for the anthropic path
  would need an external wrapper (bwrap/firejail/container); left as a documented,
  architectural follow-up, not silently claimed.
- **BUG-031 taxonomy on anthropic failures** (`classifyAnthropicError()`, ~line 100): the
  path now runs `claude -p --output-format json` (structured `{is_error,
  api_error_status, result}`) instead of inheriting raw text; a new pure classifier maps
  HTTP status (529→overloaded, 429→rate-limited, 401/403→auth-expired, 404→model-unavailable,
  5xx→internal) AND text patterns (usage-limit/quota/billing→quota-window as a fallback when
  no status code is present, since the CLI's JSON blob has no discriminant `error:` string
  like the SDK stream carries) to the same `ProviderErrorKind` vocabulary as
  `claude-runtime.ts`'s `ASSISTANT_ERROR_MAP`. Unparseable output is honestly reported as
  `[transport]` rather than assumed successful.

**Documented, not fixed (architectural — out of scope for a scripts-only lane):**
- No OS-level FS sandbox for the anthropic path (see above) — would need an external
  sandboxing wrapper around the `claude` binary.
- Anthropic dispatch is non-streaming: `--output-format json` gives one result blob per
  turn, so progress is coarser than the openai path's rich stderr deltas/tool-activity
  stream. Switching to `--output-format stream-json` would close this gap but is a bigger
  parsing change; left for a follow-up.
- The other 2026-08-05 review findings (blanket `[transport]` label for pre-result stream
  errors on the openai path, SIGINT kill-guard race) are unrelated to the anthropic-path
  ask and remain open, unchanged.

**Verification (§C, non-vacuous), `scripts/verify-dispatch.mjs` (24/0, was 15/0):**
- PRE-CHANGE FAIL captured: `git stash push -- scripts/dispatch.mjs` (keeping the new/edited
  verify checks), ran `node scripts/verify-dispatch.mjs` against the OLD dispatch.mjs — the
  updated check [5] (anthropic now expects JSON output) and all of new checks [7] (timeout
  kill), [8] (sandbox translation), [9] (taxonomy) FAILED as expected (14 passed, 10 failed);
  `git stash pop` restored the fix, full suite went 24/0.
- **[7] timeout actually kills the process**, not just abandons it: a fake slow `claude`
  shim on PATH sleeps 5s then touches a marker file; with `--timeout-min 0.02` (1.2s) the
  dispatch exits nonzero in ~1.2s naming `[timeout]`, and — waited out past the shim's full
  5s sleep — the marker file NEVER appears, proving a real kill of the process (group), not
  an orphaned survivor that the runner merely stopped waiting on.
- **[8] sandbox flag behavior asserted on the wire**: default (read-only) run shows
  `--permission-mode plan --disallowedTools Edit,Write,NotebookEdit` in the shim's captured
  args; `--sandbox workspace-write` shows `--permission-mode acceptEdits` with no
  disallow-list.
- **[9] taxonomy line on induced anthropic failure**, both paths: a shim returning
  `{is_error:true, api_error_status:429, result:"You have hit the rate limit…"}` → exit
  nonzero + `dispatch failed [rate-limited] (provider anthropic, retryable): You have hit
  the rate limit…`; a shim returning `is_error:true` with no status code but
  "usage limit reached" text → `dispatch failed [quota-window] (provider anthropic): usage
  limit reached…` (text-pattern fallback path, no status code available).
- Existing checks [1]-[4],[6] (openai fixture path, transcript recording, dashboard
  listing, quota-window induced failure, workspace-write, usage errors) stayed green
  unchanged.
- `npm run typecheck` clean for this change (pre-existing unrelated errors only, in
  untracked scratch files `scripts/qa/_bug032_repro.spec.ts` / `_wheel_sanity.spec.ts` —
  not touched by this work, not part of the FEAT-043 dispatch surface).
- LIVE happy-path sanity (real Claude subscription, modest):
  `node scripts/dispatch.mjs --provider anthropic --model haiku "What is 12 + 30? Answer
  with just the number."` → stdout exactly `42`, exit 0, stderr shows the sandbox note
  ("sandbox read-only [application-level gate, not an OS jail]") and token usage — the
  read-only default still lets a pure-reasoning task complete normally (plan mode restricts
  writes, not reads/reasoning).
- Constraints held: :4317 untouched throughout, kills by pid/process-group only, no
  installs, no package.json edit, no git commit (this entry only appends to the ticket).

### 2026-08-06 — scripts agent — Phase R/P2 staleness re-research trigger (scripts-only lane; VERIFIED)

Closes the remaining Phase-R-adjacent piece: an automatic staleness trigger for
`ROUTING.md`, wired into the consolidation loop that already runs post-capture and at
server boot (`scripts/wa-consolidate.mjs`, invoked from `src/server/index.ts` boot code
with `--apply`) — the natural host per the ticket's own framing. No auto-editing of
`ROUTING.md` and no automatic re-research: this is a detector that surfaces a
NEEDS-HUMAN item, same as every other consolidation finding.

**Built (`scripts/wa-consolidate.mjs` only):**
- `checkRoutingStaleness()` — reads `$METHODOLOGY_DIR/ROUTING.md`, regex-parses the
  `**STALENESS:** researched YYYY-MM-DD` header, computes age in days against a
  `ROUTING_STALE_DAYS = 90` bar (matches the ticket's "~3 months" language). Never
  throws: missing/unreadable file → `status: 'missing'`; header present but no
  parseable date → `status: 'unparseable'`; both are honest warnings
  (`console.warn`), never a crash — same boot-tolerance contract as FEAT-019's
  consolidation pass and `sync-methodology.mjs`'s absent-repo no-op.
- Wired as detector #5 (after the existing relocate/merge/contradiction/rule-without-why
  detectors, before the APPLY/propose dispatch): a stale result pushes one
  `needsHuman` entry (`type: 'routing-stale'`, evidence = the age + bar, why = the
  FEAT-043 Phase R discipline sentence, pointer to re-run Phase R research by hand).
  Because it lands in the shared `needsHuman` array, it automatically flows through
  every existing surface that array already feeds: the propose-mode
  `CONSOLIDATION-PROPOSAL.md` report (as tension type `routing-stale`, its own
  proposal text pointing at re-researching + `npm run sync:methodology`, not the WA),
  the `--apply` console `NEEDS HUMAN` block, and `CHANGELOG.md`'s "Needs human"
  section on any pass that also has a mechanical relocation/merge to commit. A
  routing-only stale finding with nothing else mechanical to apply still surfaces on
  the console (honest no-op path) even though no commit/changelog write happens —
  consistent with how every other needs-human-only pass already behaves.
- `--check-routing` standalone flag: self-contained, checked before the WA file (or
  even `METHODOLOGY_DIR` itself) is required to exist — prints one line, exit 0 for
  fresh/missing/unparseable, exit 1 for stale (mirrors `sync-methodology.mjs --check`'s
  drift-exit-code shape).

**Verification (§C, non-vacuous, scratch `METHODOLOGY_DIR` only — real repo never
mutated):**
- Fresh date (real `ROUTING.md`, researched 2026-08-05, today 2026-08-06):
  `--check-routing` → `ROUTING.md fresh (researched 2026-08-05, 1d old, ≤ 90d)`, exit 0.
- Scratch copy backdated to `researched 2026-01-01` (217d): `--check-routing` →
  `routing table stale — re-run FEAT-043 Phase R research (…217d ago, > 90d staleness
  bar)`, exit 1. Same scratch run through full `--apply --no-sync`: needs-human block
  shows `[routing-stale]` alongside the pre-existing `[project-specific-section]`
  finding, honest no-op (0 relocations/merges, no commit) — proving the trigger fires
  standalone AND inside the real consolidation pass. Same scratch through propose mode
  (`--out` to scratch): `CONSOLIDATION-PROPOSAL.md` lists `## 2. [MED] routing-stale`
  with evidence/why/proposal text.
- Fresh-date scratch through `--apply --no-sync`: grep for "routing" in the output
  finds nothing — proves the check is non-vacuous (a disabled/no-op check would also
  report nothing on the backdated case; the backdated run above shows it firing).
- Absent `ROUTING.md` (empty scratch dir): `ROUTING.md not found (or unreadable) …
  (ENOENT)`, exit 0, no crash.
- Garbled header (`ROUTING.md` present, no STALENESS line): `staleness header missing
  or unparseable … cannot verify freshness`, exit 0, no crash.
- `METHODOLOGY_DIR` itself entirely absent + `--check-routing`: still exits 0 with the
  missing-file message — `--check-routing` never hits the earlier
  `die("canonical methodology repo not found…")` guard that other modes hit, by design
  (checked before that guard).
- `node scripts/verify-wa-selfmaintain.mjs` — **39/39**, unchanged (T10 boot-seam
  still proves a broken methodology dir never affects server startup; real canonical
  repo byte-identical + git-clean before/after per T6).
- `npm run typecheck` — clean.
- Constraints held: `:4317` untouched, no processes spawned/killed by this change
  (pure parse+compare, no long-running seam), only scratch `/tmp` dirs written, real
  methodology repo and real mirror never touched by manual testing (verified via
  `git -C ~/projects/methodology status --porcelain` before/after), no `package.json`
  edit, no git commit (this entry only appends to the ticket).

**Handoff:** only the per-dispatch provider/model picker in the Agent/Task UI (original
P1) remains open on this ticket.

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
