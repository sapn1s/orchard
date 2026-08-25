# Inline vs. dispatch — the measured crossover

**Question asked:** does dispatching a subagent cost more than the orchestrator
doing the same work itself? **Answer: no, and not close.** Dispatch is cheaper
than inline at *every* task size observed, with one narrow exception (a task
needing zero reads and at most two tool calls).

**But the crossover is not the finding.** The dominant cost in this window is
neither inline context nor cold start. It is that **93.2% of the orchestrator's
spend buys nothing** — it is the session re-reading and re-caching its own
context — and inline work is the only thing that grows that context.

All figures derived from the agent CLI's own transcripts under
`~/.claude/projects/`, using `scripts/lib/cost-model.mjs` via
`npm run cost:collect`. Read `COST-METHOD.md` in this directory first: the three
corrections it documents are applied here (2,883 duplicate usage rows were
collapsed on the orchestrator transcript alone — summing them would have roughly
doubled every number below). Dollar figures are API-equivalent estimates at list
rates, not money paid, and are a **lower bound** (one untranscribed title request
per session).

Scope: orchestrator session `87564f3e`, 2026-08-03 → 2026-08-20, 2,989 requests;
476 subagent lanes dispatched from it, 24,089 lane requests.

---

## 1. What an orchestrator turn costs, and how it grew

The orchestrator re-reads its entire context on **every request** — not every
user turn, every tool call. This is measured, not assumed: on 2026-08-20 the
mean `cache_read` was 415,792 tokens against a mean context of 422,592. The
context is re-read essentially in full, every time.

Cost per request on the final context segment (2026-08-19 19:40 → 2026-08-20
08:52), by twelfth of the day:

| time (UTC) | context (tok) | median $/request |
|---|---|---|
| 05:24 | 312,390 | 0.182 |
| 06:07 | 335,253 | 0.215 |
| 07:26 | 366,256 | 0.202 |
| 07:32 | 379,157 | 0.235 |
| 07:52 | 404,938 | 0.243 |
| 08:06 | 423,150 | 0.232 |
| 08:11 | 440,384 | 0.237 |
| 08:14 | 457,482 | 0.260 |
| 08:22 | 477,999 | 0.266 |
| 08:29 | 493,979 | 0.274 |
| 08:34 | 510,739 | 0.280 |
| 08:46 | 523,965 | 0.327 |

The curve is **linear in context, and context is linear in requests**: +1,531
tokens of context per request, +$0.55 per additional megatoken of context
carried. Over three and a half hours the marginal cost of one tool call rose
**80%**, from $0.18 to $0.33, purely from accumulation.

Zoomed out, this is a sawtooth, not a slope. The session has **7 context
segments** separated by compaction; each one starts around 30–75k and runs to
the ~1M wall:

| segment | requests | start ctx | end ctx | cost | window |
|---|---|---|---|---|---|
| 0 | 680 | 27,858 | 999,013 | $384.3 | 08-03 06:39 → 08-04 06:57 |
| 1 | 354 | 36,849 | 999,646 | $174.1 | 08-04 07:00 → 08-04 17:16 |
| 2 | 409 | 47,538 | 994,582 | $355.8 | 08-04 17:18 → 08-11 09:08 |
| 3 | 422 | 62,177 | 983,826 | $292.0 | 08-11 09:13 → 08-13 12:11 |
| 4 | 461 | 57,896 | 999,861 | $207.1 | 08-13 12:44 → 08-18 11:00 |
| 5 | 374 | 75,858 | 998,348 | $149.5 | 08-18 11:22 → 08-19 19:33 |
| 6 | 263 | 54,446 | 529,204 | $62.3 | 08-19 19:40 → 08-20 08:52 |

Within a segment the marginal cost of a request rises **~20×** from floor to
ceiling ($0.03 at 55k, $0.50+ at 1M). Whole-session mean: **$0.54/request**,
$1,624.64 total.

### The number that matters: the tail

A token added to orchestrator context is not paid once. It is re-read by every
subsequent request until the next compaction. Median remaining requests in the
same segment: **131** (mean 228 across all segments).

> **Adding 1M tokens to orchestrator context costs ~$65 in downstream re-reads
> alone**, before it has produced anything. On the whole-session distribution
> (which includes Fable turns at 2× the read rate) the median is $111/Mtok.

This is the term both framings in the original question omitted.

---

## 2. What a dispatched lane costs, end to end

Cold start, measured across all 476 lanes:

| | p10 | p25 | median | p75 | p90 |
|---|---|---|---|---|---|
| context on request 1 (tok) | 9,921 | 10,483 | **11,806** | 12,738 | 14,485 |
| cost of request 1 ($) | 0.032 | 0.040 | **0.046** | 0.067 | 0.077 |

**A lane's entire cold start — system prompt, CLAUDE.md, the Working Agreement,
the charter — costs $0.046. One orchestrator tool call on 2026-08-20 cost
$0.25.** The cold start everyone worries about is one fifth of a single
orchestrator tool call.

Whole lanes:

| | p10 | p25 | median | p75 | p90 | mean |
|---|---|---|---|---|---|---|
| lane total ($) | 0.55 | 1.15 | **2.45** | 5.88 | 11.94 | 4.76 |
| lane requests | 11 | 21 | **38** | 72 | 100 | 51 |
| unique files Read | 1 | 2 | **5** | 8 | 11 | 5.6 |

A lane's own per-request cost stays flat and cheap for a long time, because its
context starts near zero:

| request index | 1 | 5 | 12 | 20 | 30 | 50 | 80 | 120 |
|---|---|---|---|---|---|---|---|---|
| median $/request | 0.046 | 0.047 | 0.051 | 0.055 | 0.065 | 0.076 | 0.100 | 0.127 |
| median context | 11.8k | 36k | 54k | 69k | 88k | 116k | 153k | 207k |

A lane does not reach the orchestrator's *starting* per-request cost until its
**120th request**. The median lane makes 38.

### The orchestrator-side price of dispatching

This is the honest cost of dispatch that a lane's own transcript does not show.
Measured from the orchestrator's tool payloads:

| component | median tokens |
|---|---|
| charter (Agent tool input) | 966 |
| Agent tool result (async launch stub) | 271 |
| completion notification carrying the report | 1,107 |
| **total added to orchestrator context** | **2,344** |

At the 131-request tail that is $0.154, plus the two orchestrator requests spent
writing the charter and reading the report ($0.45 at 450k context):

> **Fixed cost of one dispatch, charged to the orchestrator: $0.60.**

Note the asymmetry that makes this work: a lane can burn 62M tokens internally
and return **1,107 tokens** to the orchestrator. The Agent tool result is a fixed
271-token stub regardless of lane size. Dispatch is a **compression boundary**.

---

## 3. The crossover

Compare each of the 476 real lanes against a modelled inline equivalent: the
same number of tool calls made by the orchestrator at 450k context ($0.225/req,
measured $0.25), plus the tail cost of the context the lane actually pulled in.

| lane size (requests) | n | files read | dispatch $ (incl. $0.60 overhead) | inline $ | ratio |
|---|---|---|---|---|---|
| 1–4 | 12 | 3 | 0.87 | 1.42 | **0.61×** |
| 5–9 | 25 | 2 | 1.00 | 3.35 | **0.30×** |
| 10–19 | 64 | 2 | 1.53 | 6.21 | **0.25×** |
| 20–39 | 141 | 4 | 2.33 | 10.94 | **0.21×** |
| 40–79 | 138 | 6 | 5.14 | 20.12 | **0.26×** |
| 80–159 | 85 | 9 | 9.66 | 32.30 | **0.30×** |
| 160+ | 11 | 12 | 27.47 | 61.70 | **0.45×** |

Dispatch is cheaper in every bucket. It is most efficient at 20–39 requests —
**4.8× cheaper** — which is exactly the median lane.

Solving analytically for the break-even number of tool calls `R*`, using
lane-side $0.06/request and the $0.60 fixed overhead:

| orchestrator context | $/orch request | R* — no reading | R* — one file read per call |
|---|---|---|---|
| 25k | 0.012 | never | 27.9 |
| 50k | 0.025 | never | 10.8 |
| 100k | 0.050 | never | 5.8 |
| 200k | 0.100 | 8.8 | 3.8 |
| 300k | 0.150 | 5.0 | 3.2 |
| **450k** | **0.225** | **3.7** | **2.8** |
| 600k | 0.300 | 3.1 | 2.6 |
| 800k | 0.400 | 2.8 | 2.4 |
| 1M | 0.500 | 2.6 | 2.3 |

Even granting inline a **2× efficiency credit** (assume the orchestrator, having
project context already, needs half the tool calls a fresh lane does), at 450k
context R* is still only **7.6** lane-equivalent tool calls.

### Does exploration change the answer? Yes — it decides it.

- **A task needing no reading at all** (one-line edit in a file already in
  context, ≤2 tool calls): inline ≈ $0.48, dispatch ≈ $0.75. **Inline wins.**
  This is real, not hypothetical — lane "BUG-103 NUL byte fix and guard" ran 2
  requests, read 0 files, cost $0.037; with overhead $0.64 against ~$0.53
  inline. It should have been done inline.
- **A task needing to read even one file**: R* falls to ~2.8, and any read-then-
  edit task is already ≥3 calls. **Dispatch wins immediately.** Lane
  "Breadth-sweep remaining CLAUDE.mds" read 8 files in 2 requests for $0.133
  ($0.74 with overhead); inline that is ≥$2.00.

Reading is the pivot because a file read costs the orchestrator twice — once at
$0.25 for the request, and again as a permanent context liability at $65/Mtok.
The median orchestrator `Read` result was 823 tokens; the **mean was 9,619**.
One badly-chosen inline `Read` of a large file costs ~$0.63 in tail alone,
forever, and the orchestrator cannot put it back.

---

## 4. The counter-hypothesis, tested and rejected

The claim to beat: *73% of a verification lane's pre-work was orientation, and
465 dispatches exist — so cold start dominates.*

Measured across the 402 lanes that actually mutated a file, cost incurred before
the first `Edit`/`Write`:

| | p25 | median | p75 | mean |
|---|---|---|---|---|
| share of lane cost | 16% | **26%** | 38% | 29% |
| dollars | $0.42 | **$0.81** | $1.40 | $1.15 |
| requests | — | **12** | — | — |

The 73% figure was one lane, not the population; the median is **26%**. And in
absolute terms the median lane's entire orientation costs **$0.81 — 3.4
orchestrator tool calls.**

Summed over all 476 dispatches, orientation cost **$463**, against $3,890 for
the orchestrator and its lanes combined: **11.9%**. Real, worth trimming, not
dominant — and not remotely enough to reverse a 4.8× ratio.

Percent-of-lane is the wrong denominator. A lane that is 90% orientation and
costs $0.30 is cheap. Always price orientation in orchestrator tool calls.

---

## 5. What actually dominates — the finding neither framing proposed

Decomposing the orchestrator's $1,625 by line item:

| line item | cost | share |
|---|---|---|
| cache **read** (re-reading its own context) | $848.0 | 52.2% |
| cache **write**, 1-hour TTL at 2× (re-caching it) | $665.9 | 41.0% |
| output (the only line that produces anything) | $111.1 | 6.8% |
| fresh input | ~$0.0 | 0.0% |

> **93.2% of the orchestrator's spend is context maintenance.** $1,514 of $3,890
> — **39% of the entire window** — went to carrying context forward, not to
> doing work.

The per-unit-of-work comparison:

| | tokens of output produced | cost | $ per Mtok of output |
|---|---|---|---|
| orchestrator | 3.7M | $1,625 | **$444** |
| 476 dispatched lanes | 17.3M | $2,266 | **$131** |

**The orchestrator pays 3.4× more per token of work it produces**, and produced
4.7× less of it. That ratio is the whole argument, and it has nothing to do with
cold start — cold start is $463 of a $3,890 bill, while orchestrator context
maintenance is $1,514 of it, **3.3× larger**.

The mechanism is compounding, and it is why intuition gets this backwards:
inline work feels free because its cost is not charged at the moment it is done.
A 10k-token file read inline costs $0.25 now and **$0.65 spread across the next
131 requests**. The bill arrives later, attributed to unrelated turns. A
dispatch charges $0.60 up front, visibly, and then stops — the lane's 2.7M
tokens are discarded at exit and never re-read. The intuition that dispatch is
expensive is an artifact of *when* each cost is visible, not of how large it is.

Corollary worth stating plainly: **the orchestrator's context is a liability,
not an asset.** Its only defensible contents are things that must persist across
dispatches — decisions, the plan, what each lane was told. File contents,
search output, and test logs are the opposite: read once, re-read 131 times,
useful once.

---

## 6. The rule

> **Before dispatching, ask one question: does this task need to read anything I
> do not already have in context?**
>
> - **Yes → dispatch. Always, at any size.** Break-even is under 3 tool calls;
>   read-then-edit is already 3.
> - **No, and it is ≤2 tool calls → do it inline.** That is the entire exception.
>
> Under ~100k of orchestrator context the exception widens to ~6 tool calls. Over
> ~300k it is closed: dispatch essentially everything.

Session `87564f3e` reached 450k context by mid-morning on 2026-08-20 and hit the
1M compaction wall in six of its seven segments. **The exception was almost never
live.** The instinct to work inline was, in this window, wrong nearly every time
it fired.

---

## Caveats

- Inline costs are **modelled**, not observed — the counterfactual was not run.
  The model uses measured orchestrator per-request cost ($0.25 median, validated
  against the 450k×$0.55/Mtok fit) and the measured tail (131 requests). It
  assumes the orchestrator would need the same number of tool calls as the lane;
  the 2× efficiency-credit row bounds that assumption, and dispatch still wins.
- The tail term counts re-reads only. Cache **re-writes** add roughly $12.6/Mtok
  on top, so $65/Mtok is a floor. Correcting it moves the crossover further
  toward dispatch.
- Wall-clock and parallelism are excluded entirely. 476 lanes ran with heavy
  concurrency; that benefit is additional to everything above.
- Cost is not quality. This measures tokens, not whether dispatched work was as
  good. `defect-origin-2026-08-20.md` in this directory covers that axis.
- Character-to-token conversion for tool payloads is a 4:1 approximation; usage
  figures elsewhere are exact per `COST-METHOD.md`.
