# Pipeline cost and throughput — measured window 2026-08-18 → 2026-08-19

> **Superseded arithmetic — read `docs/analysis/COST-METHOD.md` before quoting any
> figure below.** This analysis was computed before three properties of the
> transcript format were understood: `usage` is repeated once per content block
> (so summing over assistant lines over-reports cache-read by up to **2.22×**),
> the last row per message id is the authoritative one (first-wins under-counts
> output ~16×), and 1-hour cache writes bill at **2×** base input rather than
> 1.25×. The absolute token and dollar totals here are therefore wrong, most
> likely over-stated. They are left unedited on purpose: this is a record of what
> was concluded and when. The *relative* findings — which phase dominates, where
> rework concentrates — survive, because a roughly uniform over-count cancels in a
> ratio. The corrected implementation is `scripts/lib/cost-model.mjs`
> (`npm run cost:collect`).

Read-only analysis. Nothing in this document changed product code. All figures are
**measured** from transcript token-usage records unless a row says *estimated*.

---

## Part 1 — State of play

### Landed and independently verified (clean-room HOLDS)

| Ticket | What | Caveat |
|---|---|---|
| ARCH-003 | turn-end guesses whether a background job died, and the guess kept being wrong | verified on the 11th pass — **not deployed**, see below |
| FEAT-091 | split a reply into what is addressed to you vs. narration | 11th pass HOLDS; board still says "verify required" — board is stale by one round |
| BUG-112 | a clean room's dependency symlink was a write path into the live tree | |
| BUG-110 | over-wide table row silently dropped its surplus cell | verdict line not yet committed |

### Landed but NOT independently verified — the real backlog

BUG-103 (self-verified only, and it touches the most regression-prone file in the
tree), BUG-106, BUG-107 (an uncommitted independent verdict says BROKEN),
BUG-108, BUG-109 (BROKEN, and the finding became BUG-110), FEAT-090 (last two
verdicts BROKEN, no re-verify since). **BUG-105 is mid-flight**: six rounds, six
BROKEN verdicts, seventh fix uncommitted in the working tree.

### Waiting on you

Twelve items. The ones that block other work: **ARCH-005** (end the
cross-project leak class by construction, guard it, or keep paying per surface —
three named surfaces stay broken until you pick), **ARCH-006** (normalise line
endings at the boundary or keep patching), **FEAT-082** (approve the board
digest design), **BUG-104**, **FEAT-092**. **ARCH-004 you already answered** —
the answer is recorded but no lane was ever dispatched against it.

### Filed, not started

BUG-111, BUG-113, BUG-114, BUG-115, FEAT-087, FEAT-088 (layer 2).

### Committed but not live

The bridge is in-process, so **ARCH-003 and BUG-105 are not running anywhere**
until the service restarts. ARCH-003's own status line says so: verified, in
tree, not live. That restart is the only thing between "verified" and "done" for
the single most expensive ticket in this window. BUG-106 and BUG-113 are
front-end and need only a cache-bust, not a restart.

---

## Part 2 — Where the time and money went

### Price assumptions (stated separately so the arithmetic can be corrected)

Opus-tier rates, US dollars per million tokens. Every lane in this window ran on
an Opus-tier model, so one price row covers everything.

| Token class | $/MTok |
|---|---|
| Input (uncached) | 5.00 |
| Output | 25.00 |
| Cache write (5-minute TTL) | 6.25 |
| Cache read | 0.50 |

Cross-provider verifier runs are billed by a different vendor and are **not**
included in the dollar totals; they are quantified separately below and are
immaterial.

### The window

| | |
|---|---|
| Span | 2026-08-18 04:34Z → 2026-08-19 08:38Z |
| Wall clock | 28.1 h |
| **Machine suspend (excluded)** | **8.4 h** (2026-08-18 23:45Z → 2026-08-19 08:12Z) |
| Real elapsed | 19.7 h |
| Subagent lanes dispatched | 142 |
| Active agent-hours | 36.3 |
| Mean concurrency | 1.84 lanes |

The suspend is not an estimate. Two lanes appear to have run 8.7 h and 9.0 h;
inside each, a single gap of 8.34 h and 8.48 h separates consecutive events, and
each did ~22 minutes of actual work either side of it. Left uncorrected, those
two lanes alone would have accounted for a third of all reported agent time.
(This is the same suspend that BUG-115 was filed about — on thaw it fired a
wall-clock tool timeout and manufactured a false verification FAIL.)

### Total spend

| | Tokens | Cost |
|---|---:|---:|
| 142 subagent lanes | 1,176 M | **$980.91** |
| Orchestrator session | 333 M | **$253.94** |
| **Total** | **1,509 M** | **$1,234.85** |

That is roughly **$63 per real elapsed hour**, or **$8.70 per dispatched lane**.

---

## The finding that matters most: you are paying to re-read, not to think

| Token class | Tokens | Cost | Share of cost |
|---|---:|---:|---:|
| Cache read | 1,125 M | $562.48 | **57%** |
| Cache write | 46 M | $285.32 | 29% |
| Output | 5.3 M | $132.36 | 13% |
| Input (uncached) | 0.15 M | $0.76 | <1% |

**95.7% of all tokens are cache reads.** The pipeline generated 5.3 million
output tokens — the actual thinking and writing — and read 1.125 *billion*
tokens of context to produce them. That is a 212:1 read-to-write ratio.

This reframes the whole question. The cost is not in reasoning, and it is not in
any one step type being slow. It is that every one of 142 lanes re-establishes a
large context from scratch — the working agreement, the conventions doc, the
ticket in full, the prior verdicts — and then re-reads that context on every one
of its turns. Caching is already working (reads are 10× cheaper than fresh
input; without it this window would have cost roughly $5,900). The lever left is
**how much context each lane carries**, not how many lanes there are.

---

## Was it the verifier? No — and this is worth being precise about

The hypothesis in the brief was that a verifier might be eating most of the time
and money through inefficiency. It is not.

| | Value |
|---|---|
| Independent clean-room verification lanes | 45 |
| Median duration | **7 minutes** |
| Mean cost per round | **$4.13** |
| Total, all 45 rounds | **$185.85 (19% of subagent spend)** |
| Cross-provider verifier tokens (27 recovered runs) | 1.21 M — under $5 at any plausible rate |

Independent verification is the **cheapest step type per unit in the pipeline**
and the cross-provider half of it is nearly free, because the verifier runs on a
different vendor at low token volume. A verification round costs about what
ninety seconds of a fix lane costs.

What is expensive is **the fix lane each BROKEN verdict triggers** — $217 across
18 lanes, at $12–15 each, three to four times the cost of the verdict that found
the defect. The rounds are cheap; the consequences of what they find are not.
That is the correct shape for a verifier to have.

---

## Cost by step type

Suspend-corrected. Classification is by the opening imperative of each dispatch
prompt; expect roughly ±5% leakage between adjacent categories (one $28 fix lane
is visibly misfiled under verification).

| Step type | Lanes | Active h | Tokens | Cost | Share |
|---|---:|---:|---:|---:|---:|
| Implementation (first pass) | 29 | 10.03 | 423 M | $323.04 | 32.9% |
| Fix-after-verdict | 18 | 9.40 | 276 M | $217.09 | 22.1% |
| Independent verification | 45 | 8.56 | 197 M | $185.85 | 18.9% |
| Mixed / multi-task lanes | 20 | 5.49 | 169 M | $144.66 | 14.7% |
| Exploration & design | 15 | 1.71 | 67 M | $68.48 | 7.0% |
| Board & ticket hygiene | 11 | 0.52 | 18 M | $21.32 | 2.2% |
| Visual review | 4 | 0.54 | 26 M | $20.48 | 2.1% |

**Verify-and-refix cycles: 63 lanes, 18.0 h, $402.94 — 41% of spend.**
**First-pass work (implement + explore): 44 lanes, 11.7 h, $391.51 — 40%.**

The pipeline spends slightly more on correcting work than on doing it the first
time. Whether that is bad depends entirely on what the rounds found — see below.

Orchestration overhead is the one number not in that table: **$253.94, 21% of
the total**, spent by the single session that wrote 142 dispatch prompts and read
142 reports. It is the second-largest line item after first-pass implementation,
and it buys no code.

---

## Cost by ticket — this is a few pathological items, not uniform slowness

| Ticket | Lanes | Active h | Cost | Share |
|---|---:|---:|---:|---:|
| ARCH-003 | 45 | 13.55 | $354.34 | 36.1% |
| FEAT-091 | 26 | 5.00 | $166.42 | 17.0% |
| BUG-105 | 15 | 5.57 | $89.13 | 9.1% |
| *(cross-cutting / no ticket)* | 12 | 1.97 | $71.31 | 7.3% |
| BUG-106 | 6 | 1.32 | $50.62 | 5.2% |
| BUG-107 | 3 | 1.16 | $49.67 | 5.1% |
| FEAT-089 | 2 | 0.60 | $32.58 | 3.3% |
| FEAT-082 | 2 | 0.58 | $30.96 | 3.2% |
| BUG-035 | 4 | 0.73 | $18.38 | 1.9% |
| BUG-104 | 3 | 0.59 | $15.98 | 1.6% |
| ARCH-004 | 2 | 0.41 | $15.80 | 1.6% |
| *18 further tickets* | 28 | 3.4 | $85.72 | 8.7% |

**Three tickets are 62% of the spend and 60% of the lanes.** The remaining
twenty-odd tickets averaged $4–15 each and closed without drama. The distribution
is not "everything is slow" — it is a long flat tail plus three deep holes.

All three deep holes share one property: they are **concurrency and parsing
correctness bugs where the failure is a timing or a shape the first fix did not
model**. ARCH-003 is "did this background job die"; BUG-105 is the same question
from the other side; FEAT-091 is a CommonMark-adjacent parser where every fix
exposed the next construct it did not handle.

### The three deep lanes, decomposed

| | Rounds | Verify cost | Refix lanes | Refix cost | Total |
|---|---:|---:|---:|---:|---:|
| ARCH-003 | 11 (10 BROKEN → HOLDS) | $60.78 (avg $4.05 / 11 min) | 4 | $61.35 (avg $15.34) | $354.34 |
| FEAT-091 | 11 (10 BROKEN → HOLDS) | $33.31 (avg $2.78 / 6 min) | 8 | $93.06 (avg $11.63) | $166.42 |
| BUG-105 | 6 (all BROKEN) | $21.55 (avg $2.69 / 12 min) | 5 | $56.79 (avg $11.36) | $89.13 |

### Did the rounds earn their cost? Mostly yes — with one clear exception

Going round by round through what each verdict actually found:

- **ARCH-003**: every round through the tenth found a real defect. Round 9 found
  chain corruption through a window a previous lane had explicitly dismissed as
  "just an ambiguity" — the fourth time that exact pattern recurred. Round 10
  found that a settled record was still mutable. Round 11 held, backed by a
  20k-seed fuzz proven fail-sensitive against the pre-fix module.
- **FEAT-091**: round 8 found containers are a stack rather than a stripped
  prefix; round 9's randomised differential found five causes a hand-built matrix
  could not; round 10 found a multi-line link reference definition losing a
  well-formed fold. Round 9 also fixed a genuine blind spot — the suite could not
  see a fold being *lost*.
- **BUG-105**: all six verdicts real. **Two of the six were regressions
  introduced by the immediately preceding round's own fix.**

So: 27 verification rounds across the three lanes, of which 24 returned BROKEN,
and essentially all 24 named a real defect. At $2.69–$4.05 a round, that is the
cheapest defect detection in the pipeline by a wide margin. **The verification is
not the problem.**

The exception is the recurring failure mode underneath it. In both ARCH-003 and
FEAT-091, the dominant pattern is that **the previous round's "documented
limitation" or "guarded but not eliminated ambiguity" became the next round's
defect.** That is not verification churning — it is fix lanes closing the
specific case they were shown and writing the general case down as a known
limitation instead of fixing it. Each time that happened it cost a full verify
round ($3–4) plus a full refix lane ($12–15) plus orchestration to discover what
was already written in the ticket.

---

## Time lost to things that were not the work

Measured, and smaller than expected:

| Source | Measured | Cost impact |
|---|---|---|
| Machine suspend | 8.4 h wall | Zero dollars; 8.4 h of calendar |
| Idle gaps between lanes (4 gaps >15 min) | 2.75 h | Zero dollars; waiting on orchestration or you |
| API errors surfaced to agents | 7 occurrences | Negligible |
| Failed tool calls | 138 of 6,457 (2.1%) | Negligible |
| Concurrency conflicts (index locks, port collisions) | 4 occurrences total | Negligible |

**Infrastructure friction is not where the money went.** A 2.1% tool-error rate
is healthy. There is no retry storm, no rate-limit thrash, no lane-kill-and-resume
cycle of any size in this window.

The real calendar loss is different and does not appear as an error: of 19.7 real
elapsed hours, only 36.3 agent-hours of work happened at a mean concurrency of
**1.84**. The pipeline runs mostly two-wide. The 2.75 h of dead gaps are periods
where nothing at all was running.

---

## Verdict: is this pipeline worth its cost?

**On quality: yes, and the evidence is unambiguous.** 24 of 27 verification
rounds on the deep lanes found real defects, at $2.69–$4.05 per round. Two of
them caught regressions that a previous fix had just introduced. Several caught
hidden-content and false-death defects that no self-verification had found —
including cases where a builder's own suite reported green. Independent
verification is 19% of spend and is carrying the correctness of the whole thing.

**On efficiency: no, and three specific things are wasting roughly a third of it.**

1. **Context re-establishment is 57% of the bill.** Every lane pays to re-read
   the working agreement, conventions, the full ticket and its accumulated
   verdict history. On ARCH-003 the ticket had grown through eleven rounds of
   appended verdicts, and all 45 of its lanes re-read all of it. The measured
   ratio is 212 tokens read per token written. *Concrete fix:* give long-running
   tickets a compacted head — current status, open defects, the invariants — and
   put the round-by-round history behind a link that only the verifier reads. On
   ARCH-003 alone this plausibly saves 30–40% of $354.

2. **Orchestration is 21% of spend and produces no code.** One session wrote 142
   prompts and read 142 reports, at $253.94. That is more than every fix-after-verdict
   lane combined. It is intrinsic to a fan-out design, but it scales with
   the number of round-trips, which brings us to the third item.

3. **The "documented limitation" anti-pattern cost the most recoverable money.**
   Repeatedly, a fix lane closed the demonstrated case and recorded the general
   case as a known limitation; the next verification round then found exactly
   that limitation as a defect. Each occurrence costs a verify round plus a
   $12–15 refix lane plus orchestration. *Concrete fix:* make "documented
   limitation" an invalid lane outcome — if a fix lane identifies a general case
   it is not closing, that becomes a filed ticket and an explicit verifier input
   in the same turn, not a paragraph in an activity log. On ARCH-003 and FEAT-091
   this pattern accounts for something like four of the eleven rounds each.

**Two cheap things that would have saved real money in this specific window:**

- **ARCH-004 was answered and never dispatched.** The decision is sitting in the
  ticket. Zero-cost to act on; currently pure latency.
- **The service was never restarted.** ARCH-003 cost $354 and eleven verification
  rounds, is verified, and is not running. Its entire value is gated behind one
  restart. BUG-105 — six rounds, $89 — is in the same state. **Over a third of
  this window's spend is currently sitting in the tree, not in the product.**

The honest summary: the work was genuinely hard, the verification earned its
keep, and the concurrency-and-parser bugs deserved the rounds they got. But
roughly a third of the bill went to re-reading context and to re-discovering
limitations the pipeline had already written down — and the single most expensive
deliverable is not deployed.

---

## Method and limitations

- **Source:** per-message `usage` records in agent transcripts (input, output,
  cache-creation, cache-read), timestamped per message. Durations are last minus
  first timestamp per lane.
- **The app records none of this durably.** It tracks cost in memory for live
  sessions only (lost on restart) and derives per-agent token totals on read from
  the same transcripts. The outcomes rail persists an end timestamp and a status
  but no cost, tokens, or duration. Everything above was computed from raw
  transcripts; there was no existing store to read.
- **Step classification is heuristic**, keyed on each dispatch prompt's opening
  imperative. Whole-prompt keyword matching was tried first and failed badly —
  the standing dispatch boilerplate mentions "independent clean-room verify pass",
  which misclassified 103 of 142 lanes as verification. Residual error ~±5%.
- **Cross-provider verifier spend is excluded** from dollar totals (different
  vendor, different rates). Recovered usage across 27 runs is 1.21 M tokens
  total; at any plausible rate this is under $5 and does not change any
  conclusion.
- **Suspend correction** is applied per-lane, from measured intra-lane gaps, not
  by dropping the affected lanes.
