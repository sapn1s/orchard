# FEAT-123 — Where the tokens actually go: lane-count vs context-replay (ranked levers)

- **Status:** OPEN — finding recorded (measurement complete; see log). No code change.
- **Severity:** low
- **Area:** analysis / cost-model (FEAT-086 family)
- **Reported:** 2026-09-04 by dispatched lane (spend-diagnosis, round 1)
- **Verification-class:** docs-only — records a measurement. All figures from
  `scripts/cost-collect.mjs` / `scripts/lib/cost-model.mjs` over real transcripts
  (Aug 6 – Sep 4, this project's transcript dir under `~/.claude/projects/`). Every dollar figure is a
  LOWER BOUND (list rate; per-session title-call floor, see COST-METHOD.md).

## Question
The outside analysis blames **amplification** (one broad request → hundreds of
lanes, each carrying context, replaying into a long-lived parent). Verify against
Orchard's real transcripts: is the bill lane-count or context-replay, is the
93.2%-orchestrator figure still true after today's landed work, and what is the
single highest-leverage reducible cause?

## Method
`node scripts/cost-collect.mjs --json` over the full 32-day transcript window (938
lanes, 463 MB). Dollars re-priced per token class from `cost-model.mjs` rates
(Opus 5/25, Fable 10/50, Sonnet 3/15; cache write5m 1.25x, write1h 2x, read 0.1x).

## Headline: the spend is ONE session
Total window: **938 lanes, ~$5,259, 5.29B tokens.** But **97.8% ($5,142)** is a
**single resumed orchestrator session** (`87564f3e…`) that ran **782 hours (32
days), 3,521 turns, and spawned 684 subagent lanes.** Every other session in the
window is a $3–11 one-off. So "one broad autonomous continuation" is not one
example among many — it is essentially the entire bill.

### Inside that session ($5,142)
- **Long-lived orchestrator: $2,001 (39%)** — 1 session, 3,521 turns.
- **Fan-out of 684 lanes: $3,171 (61%)** — avg $4.64/lane, median 37 turns, max 330.

So **amplification (lane count) is the larger half (61%)**, the long parent the
smaller (39%). Both are real; neither is negligible.

### Token class → DOLLARS (not tokens)
Tokens are **95.98% cache-read** (confirms the 95.49% Aug figure — stable
structural property, both sides). But priced:
- **cache-READ $2,834 (54%)** ← context replay, the single biggest line
- cache-WRITE 1h $953 (18%) + 5m $683 (13%) = **writes $1,636 (31%)**
- output $819 (15%); raw input ~$0

Cache-read is cheap per token (0.1x) but 96% of a huge number still tops the bill.
It is context re-read: the orchestrator replaying ~450k tokens **every one of
3,521 turns**, and each lane re-reading its own context across its ~37 turns.
Orchestrator cache-read $985 + write $896; subagent cache-read $1,819.

### Is 93.2%-orchestrator still true? No.
Over actual spend, the orchestrator is **39%** of the mega-session, subagent
fan-out **61%**. The 93.2% was a per-pipeline framing; against the real bill the
majority is the lanes, not the parent. (This window is mostly *pre*-BUG-165, so
today's system-prompt-churn fix is not yet reflected — see below.)

### Does the parent grow unboundedly? No — compaction already bounds it.
Orchestrator cache-read/turn by decile: 277k → 660k → … → 424k. It hovers
~400–540k/turn across all 3,521 turns; it does **not** run away. FEAT-113's
built-in compaction is holding. So **"reset the session at a threshold" buys
little** — a fresh session re-pays cold cache-writes, and the steady state is
already bounded. The cost is turns × a large-but-bounded context, not unbounded
growth.

### The tiny-lane consolidation lever is a mirage.
74 lanes ran ≤10 turns and cost **$32 total** ($0.43 each). Batching "many tiny
dispatches into one" saves almost nothing — the tiny lanes are already free. The
684 lanes averaged 37 turns of real multi-turn work; the money is in substantive
lanes, not frivolous fan-out. Consolidating only helps where the merged work is
genuinely one context, which these mostly are not.

### Model tier
Opus-tier **$3,936 (75%)** (Opus-5 $2,263 + Opus-4-8 $1,673); **Fable-5 $1,245
(24%)** at 2x Opus rate; Sonnet-5 only $104 (2%); Haiku ~$0. In the mega-session,
**49 lanes ran Fable = $584**, several on routine build/UI work (BUG-030 stale
cards $71, "UI batch" $31, FEAT-037 provider picker $27) where the standing
model-tier rule says Opus is the default and Fable is for truly-complex only.

### Verification multiplier
134 verify-ish lanes = **$433 (8.4%** of sub spend) — matches the prior 8.4%
figure. Real work (caught 3 broken fixes today); small share; low priority to cut.

## Ranked levers (measured basis · saving · effort · quality risk)
1. **Bound autonomous fan-out per request.** The bill is one 32-day "keep going"
   session emitting 684 lanes. There is no cheap consolidation of the lanes
   (they do real work); the lever is a budget/round cap on how much one broad
   request may fan out before checking back. Saving: scales with whatever
   fraction of the 684 lanes was not worth spawning — the largest reducible pool
   ($3,171), but only partly reducible. Effort: policy + a counter. Risk: caps
   can starve genuinely-needed work — must be a check-in, not a hard kill.
2. **Honest tier routing (mechanical → Sonnet; Fable only truly-complex).**
   $3,936 on Opus, $1,245 on Fable, $104 on Sonnet. Moving the ~49 non-complex
   Fable lanes to Opus ≈ **-$290 (est)**; shifting mechanical Opus work (board
   regen, docs, CSS, schema) to Sonnet (-40%) is worth low-hundreds more. Effort:
   habit + routing already exists but was not followed. Risk: LOW if routing is
   honest; the memory rule already governs this.
3. **Trim steady-state / cold-start context (NOT the delegate rules).**
   cache-read is 54% of $. The orchestrator replays ~450k/turn × 3,521 turns; each
   lane re-reads WA v4 (~8.5k) + charter + context across 37 turns. Any token
   removed from steady-state context is multiplied by turn count. Saving: a 10%
   context trim ≈ 10% of the $2,834 read line ≈ **-$280 (est)**. Effort: audit
   what fills the 450k. Risk: HIGH if it re-guts WA v4 — the user rejected the
   thin WA today. Flag as a quality/token trade; trim redundancy, not rules.
4. **Session handoff on context-size — DEMOTE.** Compaction already bounds the
   parent (decile data). A threshold reset saves little and re-pays cold writes.
   Keep the WA's fresh-session advice for *hygiene*, but it is not a $ lever here.
5. **Over-verification — DEFER.** $433 / 8.4%, caught real defects. Follow the
   harm-class rounds table; do not cut low-harm verification wholesale.

## What today already addressed (do NOT re-credit)
- **BUG-165** (board snapshot out of system prompt) targets exactly the
  orchestrator 1h-cache-WRITE churn ($896 in this session) — but this window is
  almost entirely *before* it landed, so its saving is **not yet visible** here
  and must be measured on post-fix transcripts, not claimed from this data.
- **FEAT-119** on-demand usage; **FEAT-113** compaction (visibly working — the
  bounded decile curve is its footprint); **FEAT-107** diff instrument; **WA v4**
  (~8.5k/session, an accepted cost, relevant to lever 3's cold-start floor).

## Single highest-leverage recommendation
**Bound how far one autonomous "keep going" request is allowed to fan out before
it checks back in (lever 1), paired with honest tier routing (lever 2).** The bill
is not death-by-a-thousand-tiny-lanes and not an unbounded parent — it is one
month-long autonomous session emitting 684 substantive Opus/Fable lanes. The only
change that touches the dominant pool ($3,171 of fan-out) without trading away the
quality the user paid for is capping/checkpointing the fan-out itself; tier
routing is the low-risk companion that trims the same pool from the other side.

## Symptom of a deeper design flaw?
yes (candidate) → the amplifier is the *autonomous-continuation* pattern: a single
broad grant compounding into a month of unbudgeted fan-out with no check-in gate.
Worth an ARCH question if the user wants the pattern itself governed rather than
each lever tuned. Not filed here — decision is the user's.

## Activity log (append-only)
### 2026-09-04 — spend-diagnosis lane (round 1, finding only)
Understood: reproduce the outside "amplification" claim against real transcripts.
Ran `node scripts/cost-collect.mjs --json` over the full window; re-priced per
token class from `cost-model.mjs`. Found the entire bill is one 32-day resumed
session (97.8%): 39% long parent / 61% 684-lane fan-out; 54% of $ is cache-read
(context replay); compaction already bounds the parent; tiny-lane consolidation
saves $32; Opus 75% + Fable 24% of tier spend. No code changed, read-only.
Handoff: after BUG-165 has a few days of post-fix transcripts, re-run the
collector and diff the orchestrator 1h-write line to measure its actual saving;
and instrument per-request "was this lane worth spawning" if lever 1 is pursued.

### 2026-09-06 — trading-volume monitor-loop + tier measurement (round 1, finding only)
Read-only measurement of the USER'S OWN `trading-volume` project (measured, not
touched), answering two decision questions. Source: `node scripts/cost-collect.mjs
--project ~/…/trading-volume --json` over its transcript dir
(~238 MB, 624 lanes, project total **$2,620**, window Aug 28 – Sep 6, 8 active
days). Scratch ledger (`CLAUDE_STATION_DATA=/tmp/...`), station ledger untouched.
All $ are list-rate LOWER BOUNDS (COST-METHOD.md).

**Q1 — monitor-tick economics.** A "tick" = a lane whose own role is to execute
the FEAT-002 monitor firing ("31-min timer, FRESH context, 15-min budget"),
identified by role-charter signature + `Overnight/… monitor tick N` descriptions;
162 ticks isolated (49 subagent form via `loop`, 110 headless-process form, 3
orchestrator). Cadence: median 31 min. Total **$368.28**, median **$1.99**/tick,
mean $2.27. **Tier: all on Fable-5 (91 ticks, $231, PREMIUM = 2× Opus) or
Opus-4-8 ($138); none on Sonnet.** On days the loop ran, **~$46/day** (Fable +
Opus-4-8). No-op fraction: **31% of ticks (50, $76) changed no live state and
dispatched nothing — pure observe-and-log.** Reading conclusions, the MAJORITY of
even the "actionable" ticks resolve to "no halt / no trial / HARD LIMITS
untouched / tick-JSON appended, recommendation awaiting user"; the actions they do
take are overwhelmingly invocations of PRE-EXISTING scripts the charter already
names (scheduler.py --plan/--apply, slots_sync.py, killswitch.py, engine
watchdog), i.e. mechanical checks a cron script already performs — genuine
LLM-judgment escalations (dispatched a fix subagent) numbered **3**. Cheaper-form
estimates (labelled ESTIMATE): current ~$46/day → **repricing the same tokens at
Sonnet-5 = $152 total, ~$19/day (0.41×)** → **script-that-escalates ≈ single
digits/day**: the mechanical checks already exist as scripts (~$0), an agent fires
only on a tripped threshold; even at a generous 30–50% escalation rate that is
~$6–23/day. NOT a recommendation to kill the loop — it exercises real live-money
judgment on some ticks; the tell is only that the observe-and-hold majority does
not need a premium-tier LLM. Sonnet is the low-risk keep-the-loop option; the
Fable tier on ticks is the least defensible part (2× cost, no Sonnet ever tried).

**Q2 — tier routing, recoverable $.** 83%-Opus is REAL but mostly correctly
routed: the top non-tick Opus-5 lanes are hard live-money engineering ("Fix
loss_window ratchet gap" $130, safety-persistence/reaper/engine-down fixes,
strategy builds) — leave them. Two honest levers: (a) **de-premium Fable→Opus** —
208 dispatched Fable lanes carry $599 of Fable-priced tokens; Fable is exactly 2×
Opus, so moving off premium **recovers $300** ($115 of it monitor-ticks, $184
non-tick) at LOW quality risk (Opus is the standing default; Fable is "truly
complex only") — but several non-tick Fable lanes are deliberate live-money
criticality, so the user must confirm none needed Fable. (b) **provably-mechanical
→ Sonnet**: dashboard/docs/board/UI lanes total ~$71, mostly on Opus; routing
them to Sonnet recovers ~$30–45. Biggest named mechanical offenders on heavy
tiers: "Redesign dashboard React+SSE" $18.15 (Opus-4-8), the dashboard
rebuild/retire/reachable/polish/v2/tile cluster ~$20+ (Fable+Opus), KuCoin
STP/rate-limit docs research ~$3.4 (Opus-5), FAC ticket-namespace/reachability +
INDEX bookkeeping ~$8 (Opus). Net provably-recoverable without touching hard work:
**~$30–45 to Sonnet, plus up to ~$300 if Fable was never truly-justified.**

Caveats / could-not-determine: window is ~9 days on disk, not a full history (CLI
prunes ~30 d) — the "66% of the week" framing is a cross-project denominator I did
not measure; my denominator is this project's transcripts alone. No-op fraction is
heuristic (regex over tool calls + final text); 31% is the strict floor, the
"needed genuine LLM judgment" fraction is lower but I did not read all 162 fully.
Fable-justified-vs-mechanical on live-money lanes is a user judgment, not mine.
script+escalate saving is an ESTIMATE (no script built; assumes the named scripts
run agent-free). No code, no git writes, trading-volume untouched.
