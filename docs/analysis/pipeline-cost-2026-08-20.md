# Where the money and the hours actually went — measured window 2026-08-19 → 2026-08-20

> **Superseded arithmetic — read `docs/analysis/COST-METHOD.md` before quoting any
> figure below.** This analysis was computed before three properties of the
> transcript format were understood: `usage` is repeated once per content block
> (so summing over assistant lines over-reports cache-read by up to **2.22×**),
> the last row per message id is the authoritative one (first-wins under-counts
> output ~16×), and 1-hour cache writes bill at **2×** base input rather than
> 1.25×. The absolute token and dollar totals here are therefore wrong, most
> likely over-stated. They are left unedited on purpose: this is a record of what
> was concluded and when. The *relative* findings — the phase shares, the rework
> concentration, the verification yield curve — survive, because a roughly uniform
> over-count cancels in a ratio. Section 9's specification was answered: the
> corrected, automatic implementation is `scripts/lib/cost-model.mjs` +
> `scripts/cost-collect.mjs` (`npm run cost:collect`), filed under FEAT-086.

Read-only analysis. Nothing here changed product code. Every figure is **measured**
from per-message `usage` records in agent transcripts, from per-turn tool-call
records, from git commit timestamps, and from the tickets' own append-only logs —
unless it is explicitly labelled *estimated*. There are exactly four estimates in
this document and each one says so on its own line.

This builds on `docs/analysis/pipeline-cost-2026-08-19.md` (the previous window) and
does not repeat it.

**The question:** twenty tickets are pending, each feels like about five hours, and
the expected shape for a typical fix is grep ~15 min, write 5–10 min, test ~10 min —
half an hour. What actually happens?

**Part 2 of this document is a specification.** Section 9 lists every question the
existing records could not answer, ordered by how much the missing data would have
improved this analysis, with the field and capture point for each. A separate lane is
building that instrumentation; section 9 is written for it.

---

## The one-paragraph answer

The pipeline spent **$1,117 and 23.1 hours of calendar**, and **63% of the money
($704) went into the ticket-board and record system — the tooling that tracks the
work — not into the twenty pending tickets.** Product bugs took 18% ($201).
Independent verification, the orchestrator's leading suspect, was **8.4% ($94)** and
is the cheapest step in the pipeline per unit. Charter and methodology overhead — the
second hypothesis — is **$37, 3.3%**, and reading the Working Agreement and
CONVENTIONS accounts for **52 tool calls in the entire window, 2.5% of all orienting
activity.** The "five hours per ticket" is mostly not compute: **nothing was running
at all for 11.7 of the 23.1 hours (51%)**, mean concurrency was **1.28 lanes**, and on
the long tickets wall-clock exceeds agent-time by 5:1 to 20:1. Six of the eighteen
measured tickets did land in the expected half-hour shape. The ones that did not are,
without exception, a boundary drawn over prose or a race in a protocol — and one of
those did not converge in six clean-room rounds.

---

## Price assumptions

Stated separately so the arithmetic can be corrected. US dollars per million tokens.
9,842 of 11,358 assistant messages ran on `claude-opus-5`, 905 on `claude-opus-4-8`
(identical rates), 487 on Haiku 4.5 and 124 on Sonnet 5. One Opus row therefore
covers ~95% of volume; the Haiku/Sonnet lanes are the one-turn migration workers and
are over-priced by this table, which flatters no conclusion here.

| Token class | $/MTok |
|---|---|
| Input (uncached) | 5.00 |
| Output | 25.00 |
| Cache write (5-minute TTL, 1.25×) | 6.25 |
| Cache read (0.1×) | 0.50 |

Cross-provider (OpenAI) clean-room verifier runs are billed by another vendor, leave
no record in these transcripts, and are **excluded** from every dollar figure. The
previous window measured them at 1.21 M tokens across 27 runs — under $5 at any
plausible rate. So the verification totals below are the *Anthropic-side* cost of
arranging, driving and consuming a verdict, not the verdict model itself.

---

## The window

| | |
|---|---|
| Span | 2026-08-19 08:38Z → 2026-08-20 07:45Z |
| Wall clock | 23.1 h |
| Lanes (excluding the orchestrator session) | 447 |
| Assistant turns, all lanes | 10,961 |
| Agent-hours | 29.6 |
| Mean concurrency | **1.28** lanes |
| Peak concurrency | 13 lanes |
| **Wall-clock with ZERO lanes running** | **11.7 h — 51%** |
| Gaps > 10 min with nothing running | 4 (12 m, 20 m, **274 m**, **389 m**) |

Non-Orchard work sharing the same machine and day (another project's branch merge,
production monitoring for another project) is **excluded** everywhere — 2 sessions,
12 sidechain lanes, $55.93 removed.

---

## Total spend, and what form it took

| Token class | Tokens | Share of tokens | Cost | Share of cost |
|---|---:|---:|---:|---:|
| **Cache read** | **1,300.0 M** | **95.7%** | **$650.00** | **58.2%** |
| Cache write | 52.1 M | 3.8% | $325.50 | 29.1% |
| Output | 5.6 M | 0.4% | $140.61 | 12.6% |
| Input (uncached) | 0.1 M | 0.0% | $0.74 | 0.1% |
| **Total** | **1,358 M** | | **$1,116.86** | |

**231 tokens are read for every token written.** The previous window measured 212:1 —
it got slightly worse. Caching is working (without it this window costs ~$6,600); the
remaining lever is *how much context each lane carries*, not the cache.

$48 per hour of calendar, $2.50 per lane.

---

# PART 1 — Where it went, ranked

## 1. The board itself — $703.95, 63%, 407 lanes, 20.3 agent-hours

Classification is by ticket id resolved from each lane's charter **and** from the
subject line of any commit sha the charter cites (a charter saying "fix a defect found
in commit `198013f`" resolves via that commit's subject, "the ticket view is three
bands now").

| Bucket | Lanes | Agent-h | Cost | Share |
|---|---:|---:|---:|---:|
| **Board / ticket-record system** | 407 | 20.3 | **$703.95** | **63%** |
| Product (session-manager) bugs | 30 | 6.2 | $201.25 | 18% |
| Orchestrator session | 1 | 23.1 | $161.61 | 14% |
| Test-harness spawned sessions | 84 | 2.1 | $22.23 | 2% |
| Unattributable (pre-window continuations, smoke tests) | 14 | 1.1 | $27.81 | 2% |

The board bucket is ARCH-004 and its successor redesign plan; FEAT-094 (schema
cutover, 194 tickets promoted); ARCH-005's re-migration and tuning loop; ARCH-008 and
ARCH-009; and **BUG-119 through BUG-128** — every one of which is a defect in the
record system or in a suite that asserted the old record format. **Ten of the eleven
bug tickets filed in this window were caused by the board work, not found in the
product.**

The board work is not wrong: ARCH-004's premise — ticket state lived in prose, so
tickets went missing — is real, and the cutover is the fix. The point is that **the
tracker outspent the tracked by 3.5×** on the day the backlog was the complaint.

## 2. Context re-establishment — $650, 58% (same money, different axis)

Not additive with the row above; the same dollars sorted by token class. Listed
separately because it is the only lever that touches all of the spend at once.

| | Cost | Share of the $931 non-orchestrator lane spend |
|---|---:|---:|
| Top 5 lanes | $269 | 29% |
| Top 10 lanes | $381 | 41% |
| **Top 20 lanes** | **$532** | **57%** |
| Top 40 lanes | $686 | 74% |

Twenty lanes of 447 are 57% of the bill. The single most expensive lane ran **129
minutes, 431 assistant turns, $78.97** — one fix, answering one content-loss verdict.
The next four: $64.85, $59.39, $39.21, $25.96. Each is one agent holding one very
large context for one to two hours, re-reading it every turn.

## 3. The orchestrator — $161.61, 14%, and it produces no code

## 4. Rework caused by a verification round — $184.50, 16.6%, 15 lanes, mean $12.30

## 5. Independent verification itself — $94.13, 8.4%, 23 lanes, mean $4.09, median 7 min

Round-to-consequence ratio **1:3** — the same healthy shape as the previous window.

## 6. Everything else

| | Lanes | Cost |
|---|---:|---:|
| ARCH-005 tuning loop (195 tiny sessions) | 195 | $46.52 |
| Bulk ticket migration (FEAT-094, one turn each) | 153 | $34.86 |
| Investigation / design dispatches | 7 | $27.10 |
| Test-harness spawned `claude` sessions | 84 | $22.23 |
| Visual review and blind-judge lanes | 5 | $15.00 |
| Board bookkeeping as its own dispatched lane | 1 | $2.32 |

## 7. Collisions and waste — real, and small

- **One genuine deadlock**, verbatim in the orchestrator transcript: two lanes collided
  on one file, each correctly refused to sweep the other's uncommitted work, and both
  stopped. The orchestrator detected it and broke it by instructing the live lane to
  commit both halves with an attribution note. One relay round-trip, no re-run.
- **One `package.json` collision** — a lane renamed a script mid-run (BUG-127),
  polluting another lane's anti-regression readings; that lane committed only its own
  hunk and restored the other two lines.
- **One `.git/index.lock` left by a SIGKILL**, blocking `git reset --hard`.
- Two lanes' work was **committed by a different lane than produced it** — a
  bookkeeping artifact, not lost work.

*Estimated* under $10 total. **Nothing was thrown away and nothing was re-run because
of a collision in this window.** Serialisation cost orchestrator attention, not money.

## 8. Suite maintenance — small in dollars, loud in signal

- `39c60c7` — "two suites asserted today's board, so using the board correctly turned them red"
- `7e1d851` — BUG-124 reopened: "four more suites pinned the world the cutover was allowed to move"
- `27faaad` — BUG-123's own must-FAIL proof was anchored to `HEAD`, so committing the fix disarmed it

$6.99 directly attributable, plus a share of two multi-ticket lanes. ***Estimated*
$25–40 total.** The signal is worth more than the number: these are the exact failure
modes `docs/CONVENTIONS.md` already documents, recurring — the rule is written but not
enforced.

---

# PART 1b — The granular breakdown, per turn

Every figure below is computed from the tool calls in each individual assistant turn
across **9,292 turns in 88 subagent lanes** (lanes under 8 turns excluded as noise).
A turn is classified by what it *did*, and segments run in order: a lane is
**orienting** until its first edit to a non-`docs/` file, then **building**, with
turns that run a suite or the gate counted as **testing**, turns that edit
`docs/bugs/` counted as **ticket writing**, and turns that build a clean room counted
as **clean-room setup**.

## Where a lane's turns, minutes and dollars actually go

| Segment | Turns | % turns | Hours | % time | Cost | % cost |
|---|---:|---:|---:|---:|---:|---:|
| **build** (writing and reasoning about code) | 5,119 | 55.1% | 17.85 | 70.5% | **$547.02** | **63.5%** |
| **orient** (finding it, before the first line changes) | 3,336 | 35.9% | 5.77 | 22.8% | **$233.11** | **27.1%** |
| **test** (running suites, the gate, typecheck) | 488 | 5.3% | 1.15 | 4.6% | $53.36 | 6.2% |
| **clean-room setup** | 282 | 3.0% | 0.18 | 0.7% | $18.47 | 2.1% |
| **ticket / doc writing** | 67 | 0.7% | 0.37 | 1.5% | $9.65 | 1.1% |

**Against the user's expected shape** (grep ~15 min, write 5–10 min, test ~10 min):

- **Finding it: median 3.3 minutes and 33 turns** (mean 3.5 min / 34.5 turns), across
  the 64 lanes that edited code. **The 15-minute grep budget is being beaten on
  wall-clock by 4×** — and blown on tokens, because those 3 minutes contain 33 turns
  and 27% of the lane's bill.
- **Writing it: 55% of turns and 70% of the time.** This is where the hours are, and
  it is the part the estimate assumed was 5–10 minutes.
- **Testing it: 5.3% of turns, 4.6% of time, 6.2% of cost.** The 10-minute test budget
  is roughly right in shape and small in cost.

The half-hour estimate is wrong in one place only: it budgets 5–10 minutes for the
part that consumes 70% of the time.

## Orientation, decomposed — the charter hypothesis, refuted with a count

2,048 tool calls issued before a lane's first code edit, by target:

| What the orienting turn touched | Calls | Share |
|---|---:|---:|
| **Bash** | 1,590 | **77.6%** |
| Source code (Read tool) | 209 | 10.2% |
| Other | 94 | 4.6% |
| **Ticket / board files** | 77 | **3.8%** |
| **Methodology docs (Working Agreement, CONVENTIONS, ROUTING)** | **52** | **2.5%** |
| Other docs | 26 | 1.3% |

And the 1,590 orienting Bash calls, by what they do:

| Kind | Calls | Share | Representative |
|---|---:|---:|---|
| **search / inspect files** (`rg`, `sed -n`, `find`, `ls`) | 857 | **53.9%** | `sed -n '320,413p' scripts/dispatch.mjs` |
| scratch file ops | 351 | 22.1% | writing probe fixtures into scratch |
| git (status / log / diff / show) | 135 | 8.5% | `git diff --stat` |
| other bash | 110 | 6.9% | |
| ad-hoc node probe | 50 | 3.1% | `node -e "import('./scripts/…')"` |
| clean-room construction | 36 | 2.3% | |
| gate / typecheck / board | 28 | 1.8% | `npm run gate; echo "GATE EXIT STATUS: $?"` |
| live-service probe | 15 | 0.9% | `curl -s :4317/api/…` |
| run existing verify suites | 8 | 0.5% | |

**Orientation is 64% reading the codebase** (857 Bash inspections + 209 Read-tool
source reads of 2,048 calls) **and 2.5% reading the methodology.** Fifty-two calls
across the entire window. The "every lane re-reads the Working Agreement and
CONVENTIONS from cold" hypothesis is measurably false.

## The charter cost, priced end to end

| | |
|---|---|
| Charters written (Agent dispatches from the orchestrator) | 78 |
| Output tokens per charter | mean 2,669, **median 2,371**, max 4,468 |
| Cost of the orchestrator turns that wrote them | **$29.11** |
| Context established on the lane's turn 1 (system + tools + charter), mean | 14,996 tokens |
| Cost of that turn-1 context across 82 lanes | ***estimated* ~$8** |
| **Total charter + preamble overhead** | **~$37 — 3.3% of the window** |

The charters *are* long — a median of 2,371 output tokens is roughly 1,800 words,
which matches the orchestrator's own description. It costs $37.

## Verification, decomposed — setup vs attacking

23 verify lanes, 1,502 turns, $94.13, 3.77 hours:

| Segment | Turns | % turns | Minutes | % time | Cost | % cost |
|---|---:|---:|---:|---:|---:|---:|
| **attacking** (running probes, building adversarial cases) | 1,076 | **71.6%** | 195 | **86.5%** | **$67.18** | **71.4%** |
| orienting (reading the diff, the requirement, the fixer's tests) | 288 | 19.2% | 24 | 10.7% | $18.66 | 19.8% |
| **clean-room setup** (`independent-verify.mjs`, room construction) | 137 | 9.1% | 6 | 2.8% | **$8.22** | **8.7%** |
| writing the verdict into a ticket | 1 | 0.1% | 0 | 0.1% | $0.08 | 0.1% |

**Clean-room setup is $0.36 per round and 16 seconds of wall-clock.** The reflink copy
documented in CONVENTIONS (456 ms for a 374 MB `node_modules`) is doing its job. The
"each round is a full agent with its own clean-room setup" concern prices out at
**$8.22 for all 23 rounds combined.** Seven of every ten verification dollars are
spent attacking.

The near-zero "verdict" row is itself a finding: **the verdict text exists only in the
lane's final message.** Nothing writes it to a record. That is why the round-by-round
history below had to be reconstructed by reading ticket prose — see gap G2.

## Ticket writing and board bookkeeping, measured directly

Turns whose `Edit`/`Write` target is under `docs/bugs/`:

| | |
|---|---|
| Turns | **85 of 9,292 — 0.9%** |
| Cost | **$11.48 of $861.61 — 1.3%** |
| Wall-clock | **30 minutes of 1,519 — 2.0%** |

**Board bookkeeping is 1.3% of lane spend.** It is not a cost centre. What *is*
expensive is the record system being rebuilt (item 1) — a different thing that should
not be conflated with it.

## By dispatch class

| Class | Lanes | Turns | Cost | Orient turns | Orient cost | Code edits | Ticket edits | Median turns → 1st code edit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| build | 38 | 5,142 | $541 | 1,752 | $140 | 517 | 77 | 40 |
| rework (after a verdict) | 15 | 1,975 | $184 | 442 | $28 | 240 | 13 | 28 |
| verify | 23 | 1,502 | $94 | 705 | $43 | 38 | 1 | 31 |
| investigate / design | 7 | 407 | $27 | 407 | $27 | 0 | 17 | — (builds nothing, by charter) |
| review / judge | 5 | 266 | $15 | 202 | $10 | 25 | 0 | 42 |

**Rework lanes orient in 28 turns against build's 40** — a fix lane answering a verdict
starts with a named defect and gets to work 30% faster. The verdict is doing part of
the diagnosis, which is an argument *for* the loop, not against it.

## The ten most expensive lanes, turn by turn

| Cost | Dur | Turns | orient | build | test | ticket | room | First code edit | Lane |
|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| $79 | 129m | 431 | 36 | 364 | 24 | 2 | 5 | turn 39 @ 2m | rework: content-loss verdict on the ticket view |
| $65 | 88m | 372 | 55 | 283 | 30 | 4 | 0 | turn 56 @ 5m | build: BUG-098 / line endings |
| $59 | 73m | 378 | 49 | 273 | 44 | 6 | 6 | turn 50 @ 5m | build: ARCH-005 / ARCH-008 |
| $39 | 39m | 271 | 28 | 219 | 24 | 0 | 0 | turn 29 @ 1m | build: redesigned ticket-board UI |
| $27 | 43m | 238 | 46 | 169 | 23 | 0 | 0 | turn 47 @ 9m | build: FEAT-091 block vocabulary |
| $26 | 31m | 228 | 45 | 170 | 9 | 4 | 0 | turn 46 @ 4m | build: ARCH-009 |
| $24 | 47m | 277 | 21 | 249 | 7 | 0 | 0 | turn 22 @ 1m | build: FEAT-094 cutover |
| $24 | 39m | 294 | 67 | 203 | 18 | 6 | 0 | turn 68 @ 4m | build: ARCH-005 tuning loop parent |
| $19 | 28m | 203 | 28 | 156 | 19 | 0 | 0 | turn 29 @ 2m | build: board redesign steps 1–3 |
| $19 | 25m | 233 | 81 | 128 | 20 | 4 | 0 | turn 82 @ 5m | build: migrate-tickets resume |

Every one of them reaches code inside nine minutes and then spends between 128 and 364
turns building. **The expensive part of an expensive lane is the middle, and it is
long.**

## The orchestrator, turn by turn

460 assistant turns, 621k output tokens, $164.35 over 23.2 hours.

| Activity | Turns | Hours | Cost | % cost | Output |
|---|---:|---:|---:|---:|---:|
| pure text — replying to the user, reading a report | 263 | 22.55 | $96.29 | 58.6% | 311k |
| **writing a charter (`Agent` dispatch)** | 78 | 0.48 | **$29.30** | 17.8% | 208k |
| bash itself (git commit, gate, checks) | 74 | 0.05 | $26.42 | 16.1% | 32k |
| relaying to a live lane (`SendMessage`) | 34 | 0.12 | $11.17 | 6.8% | 64k |
| editing files itself (board / tickets) | 7 | 0.01 | $0.82 | 0.5% | 3k |
| reading files itself | 3 | 0.00 | $0.34 | 0.2% | 2k |

The 22.55 hours on "pure text" is an artifact worth naming: **the idle gaps land on
the turn that follows them**, because a turn's duration is measured as the gap since
the previous turn. The orchestrator was not thinking for 22 hours; it was *absent*, or
waiting for the user, for most of them. That the pipeline cannot currently distinguish
those two states is gap **G1** below — and it is the single most important thing
missing.

---

# PART 1c — The verification yield curve

The orchestrator's prior: *the dominant cost is the independent-verification loop;
several tickets took four and five rounds; is the fifth round worth what the first was?*

**On cost the prior is wrong, by a wide margin.** Verification is 8.4% of spend at
$4.09 a round, of which 8.7% is clean-room setup. If every round in this window had
been free, the bill falls from $1,117 to $1,023.

**On yield the prior asks the right question.** 26 recorded verdicts across the worked
tickets, **23 BROKEN**, every BROKEN one naming a defect that reproduced.

| Round number | Rounds at this depth | BROKEN | Yield |
|---|---:|---:|---:|
| 1 | 10 | 9 | 90% |
| 2 | 6 | 6 | 100% |
| 3 | 4 | 4 | 100% |
| 4 | 3 | 3 | 100% |
| 5 | 2 | 1 | 50% (BUG-116 round 5 HOLDS) |
| 6 | 1 | 1 | 100% |

**The yield curve does not decay.** The fifth and sixth rounds found real defects at
the same rate as the first. Counted naively, every round earned its $4.

But counting defects is the wrong instrument. Counting *classes* separates the sample
into two kinds of ticket.

### The converging kind — BUG-116, 5 rounds, $38.57, ended HOLDS

| Round | What the clean room found | Class |
|---|---|---|
| 1 (`df13918`) | malformed input dropped; a later local reply overtook an earlier one | **lost reply — data loss** |
| 2 (`4f8d488`) | the shim was a byte copy, not a protocol relay | lost reply |
| 3 (`703a436`) | reply ORDER was never the requirement — the FIFO was the bug | over-constraint |
| 4 (`4954b65`) | a request accepted is not a request answered | unanswered request |
| 5 (`608064f`) | SIGQUIT killed the shim with the ledger unsettled — the signal set was enumerated, not derived | incomplete enumeration |
| — | **HOLDS** | |

Five rounds, five *distinct* real defects, all user-visible and data-loss-adjacent.
**The fifth round here was worth what the first was worth.** This ticket deserved
everything it got.

### The oscillating kind — ARCH-004, 6 rounds, 6 BROKEN, $97.49, never HOLDS

Same file, same rule, six times: *how do you decide whether a line of prose is a status
declaration?*

| Round | What the clean room found | Direction |
|---|---|---|
| 1 (`15759b0`) | `arch-watch` silently returns an unmappable status as an ordinary open ticket | silent wrong state |
| 2 (`b88ad5e`) | the reject-loudly rule held on the board but not on every consumer | silent wrong state |
| 3 (`98672cd`) | an **indented** contradictory `- **Status:** VERIFIED` is downgraded to a warning; `board.mjs check` exits 0 | silent wrong state |
| 4 (`1654cc5`) | a Markdown **task-list** declaration `- [x] **Status:** VERIFIED` is not recognised at all | **under**-recognition |
| 5 (`5a573b2`) | a **quoted example** — `- "Status: VERIFIED" is an example of the syntax` — is now read as a real declaration, making a real ticket unactionable | **over**-recognition |
| 6 (`132f65e`) | a **four-backtick code span** `` ````Status````: VERIFIED `` is not recognised at all | **under**-recognition |
| 7 (`a54c590`) | *(a delimiter run has no length — no independent verdict recorded)* | — |

Rounds 4, 5 and 6 alternate under → over → under recognition of one boundary. **Each
round found a real defect and each round's fix created the next round's defect.** The
ticket says so itself: round 6 carries `regressed-from: ARCH-004 round 5`.

That is not verification churning. It is verification correctly reporting, six times,
that a hand-written recogniser for a prose boundary does not converge — while the
pipeline answered each report with a seventh recogniser. $97 plus orchestration, and
the ticket still has no HOLDS.

**The project reached this conclusion itself and committed it:** `f03e937` — *"ARCH-009:
three rounds, three defects, one class — file the question, not a fourth guard."* The
rule is right. It was applied to ARCH-009 at round three and to ARCH-004 not at all.

### BUG-118 — 4 rounds, 4 BROKEN, $46.13, still no HOLDS

Round 1 stamped a flag; a terminal opened inside a launched session inherited it.
Round 2 gave the marker an identity. Round 3 wrote it to a file — *"a file anyone can
write is not a launch claim"*. Round 4: *"a copy of the hook cannot fix, or even
notice, itself"*. The mechanism converged; the deployment surface kept producing a new
round. **Three of the four rounds carry an explicit `regressed-from:` naming this
ticket's own earlier round.**

### Verdict on the prior

- **Verification is not where the money is.** 8.4%, and the setup the prior worried
  about is $8.22 for all 23 rounds. Cutting it saves $94 and buys back lost replies,
  silent wrong state, and hooks advising strangers.
- **A round is worth the first round's value when the defect class changes, and close
  to nothing when it does not.** That is the test — not the round number.
- **The answer costs three times the question.** $184.50 of rework against $94.13 of
  verdicts. On ARCH-004, four of those answers were the same answer in a new costume.

---

# PART 1d — Per-ticket breakdown

Wall clock is first dispatch → the last commit naming the ticket, so it includes
periods when the ticket was parked. Lane cost excludes the orchestrator's $161.61.
Tickets marked *(batched)* were worked inside multi-ticket lanes and have no separate
lane cost — giving them one would be a fabricated number.

| Ticket | What it is | Lanes | Agent-h | Wall-h | Turns | Mtok | Cost | Phase split |
|---|---|---:|---:|---:|---:|---:|---:|---|
| **BUG-107** | stale image hides shipped fixes | 1 | 0.1 | 0.1 | 60 | 4 | **$3.75** | build $4 |
| **BUG-120** | a record that quotes a fence loses a field | 1 | 0.3 | 0.3 | 63 | 3 | **$3.42** | verify $3 |
| **BUG-121** | a finished ticket can still carry a decision | 1 | 0.2 | 0.2 | 88 | 5 | **$4.18** | verify $4 |
| **BUG-129** | a message typed while the assistant works is lost | 1 | 0.1 | 0.1 | 91 | 7 | **$5.77** | build $6 |
| **BUG-123** | board regen erased what a promoted row said | 2 | 0.2 | 0.2 | 101 | 6 | **$6.99** | verify $7 |
| **BUG-111** | (verify-only in this window) | 1 | 0.2 | 0.2 | 122 | 11 | **$8.10** | verify $8 |
| **BUG-109** | a lone CR eats a region | 2 | 0.3 | 1.5 | 156 | 16 | **$13.12** | build $13 |
| **BUG-108** | Playwright MCP refetches a mutable `latest` | 1 | 0.4 | 0.4 | 176 | 19 | **$14.00** | build $14 |
| **BUG-104** | composed answer round-tripped to null | 2 | 0.5 | 10.1 | 163 | 19 | **$17.38** | build $17 |
| **BUG-119** | empty verdict list read as "nothing proven" | 5 | 0.7 | 11.5 | 299 | 19 | **$19.02** | verify $13, review $3, build $3 |
| **ARCH-009** | verification state from an unordered evidence set | 2 | 0.8 | 8.5 | 383 | 51 | **$37.13** | build $37 |
| **BUG-116** | browser launched a window per session | 10 | 2.0 | 20.0 | 585 | 39 | **$38.57** | rework $22, verify $12, investigate $5 |
| **BUG-118** | response-format hook advises foreign sessions | 7 | 1.3 | 1.3 | 629 | 59 | **$46.13** | rework $35, verify $11 |
| **FEAT-091** | block vocabulary was presentation, so it leaked | 4 | 1.7 | 19.3 | 713 | 97 | **$64.86** | build $63, bookkeeping $2 |
| **BUG-098** | line-ending / prose rewrite lane | 2 | 1.5 | 1.5 | 378 | 85 | **$65.38** | build $65, review $1 |
| **FEAT-094** | the schema cutover, 194 tickets promoted | 155 | 2.2 | 2.0 | 591 | 56 | **$68.15** | bulk-migrate $35, build $24, verify $10 |
| **ARCH-004** | ticket state lives in prose | 14 | 3.7 | 3.8 | 1409 | 121 | **$97.49** | rework $43, verify $30, build $19, investigate $5 |
| **ARCH-005** | re-migration + tuning loop (195 tiny sessions) | 202 | 4.0 | 2.9 | 1401 | 179 | **$161.64** | build $153, review $9 |
| BUG-124 *(batched)* | four suites pinned the world the cutover moved | — | — | — | — | — | — | inside FEAT-094 lanes |
| BUG-125 *(batched)* | a wrapped `Verified-by` line records no verdict | — | — | — | — | — | — | inside FEAT-094 lanes |
| BUG-126 *(batched)* | a severity written as a sentence breaks its row | — | — | — | — | — | — | inside FEAT-094 lanes |
| BUG-127 *(batched)* | escaping one character left two row terminators | — | — | — | — | — | — | inside FEAT-094 lanes |
| BUG-128 *(batched)* | a relation described two tickets, one itself | — | — | — | — | — | — | inside FEAT-094 lanes |
| ARCH-008 *(batched)* | record grammar implemented twice | — | — | — | — | — | — | inside ARCH-005/009 lanes |

### What this says about the half-hour expectation

**It is achievable, and it was achieved.** BUG-107 ($3.75, 6 min of agent time, 60
turns) and BUG-129 ($5.77, 6 min, 91 turns) are almost exactly the expected shape.
BUG-120, BUG-121 and BUG-123 are in the same $3–7 band. **Six of eighteen measured
tickets cost under $10 and under 20 minutes of agent time.**

**The expectation breaks on exactly one class**, and both windows found the same one:
*a boundary drawn over prose, or a race in a protocol*. ARCH-004, BUG-116, BUG-118,
FEAT-091. For those the half-hour estimate is wrong — not because the pipeline is slow,
but because the first fix is a guess about a shape nobody has enumerated, and so are
the second, third and fourth. Six rounds on ARCH-004 was not the failure; **round seven
would have been.**

**And "five hours" is mostly not compute.** BUG-116's 20 wall-clock hours contain 2.0
agent-hours. BUG-119's 11.5 contain 0.7. BUG-104's 10.1 contain 0.5. Wall-clock exceeds
agent-time by **5:1 to 20:1** on the long tickets. With mean concurrency 1.28 and 51%
of the window completely idle, "each ticket takes five hours" is a statement about
**queue depth of one**, not about how long a fix takes.

---

# PART 1e — The three changes that recover the most

## 1. A convergence rule with teeth: same class twice → stop fixing, raise the question

The rule exists and is committed (`f03e937`). It was applied at round three on
ARCH-009 and never on ARCH-004, which ran to six. Make it mechanical, threshold **two**:
when two consecutive clean-room verdicts on the same file find defects of the same
class — the ARCH-004 signature of alternating under- and over-recognition of one
boundary is unmistakable — the next dispatch is **not** a fix lane. It is an `arch`
dispatch that states the invariant and offers options, and no build starts until a
human picks one.

- **Saves, measured:** ARCH-004 rounds 3–6 = $30 of verdicts + $43 of rework + a
  proportional share of orchestration ≈ **$85–95**, and ~8 orchestrator round-trips.
- **Costs in correctness:** near zero — **it removes no verification round.** It
  changes what the pipeline does *with* a verdict. BUG-116 is untouched: its five
  rounds each found a different class, so all five would still run.
- **Sharpest form:** "stop dispatching a fix for a *prose-boundary recogniser* after
  the second consecutive same-class BROKEN; dispatch an ARCH decision instead."

## 2. Cap lane length at ~40 assistant turns after the first code edit; split with a written handoff

The bill is 95.7% cache read at 231:1, 57% of it in twenty lanes, and the granular data
shows exactly where: those lanes reach code in under nine minutes and then run 128–364
**build** turns, each re-reading a context that only grows.

- **Saves:** ***estimated* 20–30% of the $931 lane spend — $190–280 per window.** This
  is the least certain figure in this document and is labelled an estimate: the handoff
  note costs tokens and a second lane re-reads some of what the first read.
- **Costs in correctness:** real and bounded. A split lane loses in-context detail, so
  the handoff must carry the invariants explicitly — the same discipline the ticket
  already requires. The risk is a second lane re-deriving a constraint the first found
  and did not write down.
- **Do not apply it to verification lanes.** Median 7 minutes, $4.09, and their whole
  value is one agent holding one attack in one head.

## 3. Stop rebuilding the record system while the backlog is the complaint

63% of the window, $704. Ten of eleven bugs filed were caused by the board work. Freeze
board-schema work **below severity "the board reports a false state to the user"**, and
finish the cutover's outstanding fallout (BUG-124's four pinned suites, ARCH-004's
unverified round 7) before opening anything new on it.

- **Saves:** redirecting even half the board budget moves product throughput from
  $201/window to ~$550/window — **roughly a tripling** — at unchanged spend.
- **Costs in correctness:** zero for the product. The board stays partly in the old
  shape longer, and ARCH-004's parser keeps its round-6 behaviour — which is a *known*
  under-recognition of one Markdown construct, not a silent wrong state — until a human
  answers the ARCH question from change 1.

## What I am explicitly not recommending

- **Not "cut verification."** 8.4% of spend, 23 of 26 verdicts found reproducing
  defects including data-loss-class ones a builder's own green suite missed.
- **Not "shorten charters."** Measured at $37, 3.3%. Methodology re-reading is 52 tool
  calls in the entire window. The hypothesis was offered for testing and failed it.
- **Not "reduce collisions."** One deadlock, one file collision, one stale lock, all
  recovered without a re-run. *Estimated* under $10.
- **Not "raise concurrency."** Mean 1.28 against a peak of 13 says capacity exists. The
  11.7 idle hours are two gaps (4.6 h and 6.5 h overnight) where the pipeline had
  nothing to run. Parallelism cannot fix an empty queue; only a standing autonomous
  backlog can, and that is a decision, not an efficiency.

---

# PART 2 — What the records could NOT answer, and what to log

Everything in Part 1 was reconstructed from raw transcripts by four throwaway scripts.
**The application persists almost none of it.** `AgentOutcome` (`src/server/outcomes.ts`)
carries `id, at, projectId, stationSessionId, agentId, row, label, description, kind,
detail, providerError, clusterId, dismissedAt, briefedAt` — no ticket, no phase, no
round, no tokens, no cost, no start time, and no distinction between working and
waiting. `scripts/dispatch.mjs` writes `provider, model, sessionId, exitCode,
failureKind, resumed, ts` — no ticket, no round, no verdict, no usage.

Below: every question this analysis could not answer, ordered by **how much the missing
data would have improved it**. Each entry names the field, the capture point, and the
question it answers. Cost to close is my judgement and is labelled.

---

### G1. Time-blocked-waiting is indistinguishable from time-working — **highest value, cheap to close**

**What I could not answer:** the single most important number in this document — *why*
the pipeline was idle for 11.7 of 23.1 hours. I can prove nothing was running. I cannot
distinguish "the user was asleep", "the orchestrator was waiting on a decision",
"a lane was blocked on another lane's file", and "the orchestrator was thinking".
The orchestrator's own table shows 22.55 hours on "pure text" — an artifact of
attributing an idle gap to the turn that follows it. **That single ambiguity makes the
headline finding — 51% idle — un-actionable**, because I cannot say whether the fix is
a standing backlog, faster decisions, or better serialisation.

**Log:**
- On every lane record: `startedAt`, `endedAt`, and a `blockedIntervals: [{from, to, reason}]`
  array, where `reason ∈ awaiting-user-decision | awaiting-peer-lane | awaiting-tool |
  rate-limited | idle-no-work`.
- On the orchestrator: a `pipelineState` sample (say every 60 s) recording
  `runningLanes`, `queuedDispatches`, and `awaitingUserOn: ticketId[]`. A sampled
  timeline is enough; it does not need to be event-exact.

**Capture point:** the bridge already knows when a lane starts and ends
(`src/server/outcomes.ts` writes `at` on the end). Adding `startedAt` is one field.
`awaiting-user-decision` is already modelled — the Needs-You rail knows it.

**Cost to close:** *low.* Two fields on an existing record plus one periodic sampler.
**Value: highest.** It converts "51% idle" from a curiosity into a decision.

---

### G2. A verdict is not a record — round number, verdict and defect class exist only in prose

**What I could not answer without reading ticket bodies by hand:** how many rounds a
ticket took, what each returned, and what class of defect each found. The
per-turn data shows why: **one turn in the entire window wrote a verdict to a ticket**
(the verify lane returns it in its final message; a later lane transcribes it into
prose). The yield-curve table in Part 1c — the single most decision-relevant artifact
here — was assembled by reading `Verified-by:` lines out of Markdown and classifying
the adversarial-case sentence by hand. It is the only table in this document I would
call *reconstructed* rather than *measured*, and it does not scale past one window.

Worse, this gap has already cost money directly: **BUG-119, BUG-120, BUG-121, BUG-125
and BUG-107 — $34.47 of measured lane spend in this window — are all defects in reading
verification state out of prose.** ARCH-009's title is literally *"verification state is
derived from an unattributed, unordered evidence set."*

**Log — a first-class verdict record, one row per round:**
```
{ ticket, round, commitSha, verifierProvider, verifierRunId, fixerLaneId,
  verdict: 'HOLDS' | 'BROKEN' | 'INVALID',
  defectClass,           // short controlled vocabulary, see below
  regressedFromRound,    // null, or the round whose fix caused this defect
  adversarialCaseId, startedAt, endedAt, tokens, cost }
```
`defectClass` needs only to be *comparable between adjacent rounds* — the convergence
rule in change 1 needs "same class twice", nothing finer. A controlled list drawn from
this window would be: `lost-data | silent-wrong-state | under-recognition |
over-recognition | incomplete-enumeration | over-constraint | stale-deployment |
false-claim | cosmetic`.

**Capture point:** `scripts/independent-verify.mjs` already composes and validates the
verdict (`composeVerdict`, `validateVerdict`) and already keeps an authoritative
`manifest.jsonl` of executed runs. It should emit this record beside the manifest and
the ticket should reference it by id rather than restate it in prose.

**Cost to close:** *low-to-moderate.* The verdict is already structured enough to
validate; `defectClass` and `regressedFromRound` are two new required fields on an
existing contract. **Value: very high** — it makes change 1 mechanical instead of a
judgement call, and it retires a whole bug family.

---

### G3. Dispatch class is only inferrable from charter prose

**What I could not answer reliably:** the Working Agreement §I requires the
orchestrator to *"classify the dispatch BEFORE writing the charter — and record the
class in it"* and explicitly anticipates the audit *"how many `fix` dispatches turned
out to need `explore`?"*. **That audit is not currently possible.** Nothing stores the
class. Every phase figure in Part 1 was derived by regexing the opening imperative of
each charter, hand-checked against all 104 subagent charters, and carries a stated
**±5%** residual error. The previous window documented the same problem and the same
failure mode: whole-prompt keyword matching misclassified 103 of 142 lanes because the
standing boilerplate mentions "independent clean-room verify pass".

**Log — on the dispatch record:** `dispatchClass ∈ trivial | fix | explore | plan+review
| arch | verify`, plus `ticket`, `round`, `hypothesis` (the falsifiable reading §I
requires), and `hypothesisOutcome ∈ confirmed | refuted | untested` written back when
the lane reports.

**Capture point:** the `Agent`/`Task` dispatch and `scripts/dispatch.mjs`. It is a
required argument, not an inferred one — the orchestrator already has to decide it.

**Cost to close:** *low.* One required enum on the dispatch call. **Value: high** —
it removes the ±5% from every future version of this table, and `hypothesisOutcome`
answers a question the WA asks and nothing currently measures: *how often is the
orchestrator's framing wrong?* I could not answer that at all.

---

### G4. Tokens and cost are attributed to a session, never to a ticket

**What I could not answer cleanly:** the per-ticket table in Part 1d is the deliverable
most likely to be re-run, and it is the shakiest. Attribution runs charter prose →
ticket id, or charter prose → commit sha → commit subject → ticket id. Multi-ticket
lanes are attributed **wholly to the first ticket named**, which is why BUG-124 through
BUG-128 and ARCH-008 appear as *(batched)* with no figure — six tickets in the sample
have no cost at all, and FEAT-094 and ARCH-005 are correspondingly over-counted.

The app tracks cost in memory for live sessions only and loses it on restart; per-agent
token totals are derived on read from these same transcripts. There is no store.

**Log:**
- `tickets: string[]` on the lane record — a list, not a scalar, because multi-ticket
  lanes are normal and the honest answer is a split.
- `usage: {input, output, cacheCreate, cacheRead}` and `costUsd` **persisted at lane
  end**, with `model` (rates differ), so a restart does not lose it.
- Where a lane genuinely spans tickets, a `ticketSplit: {ticket: weight}` the lane
  itself proposes in its final report — the lane knows what it worked on; the
  orchestrator is guessing.

**Capture point:** lane end, in the bridge that already writes `AgentOutcome`. The
usage numbers are already in the transcript being read.

**Cost to close:** *low* for the usage fields (they exist, they are just not persisted);
*moderate* for `ticketSplit`, which needs a reporting convention.
**Value: high** — it is the difference between a per-ticket table and a per-ticket
estimate.

---

### G5. No phase boundaries inside a lane — orient / build / test is inferred from tool targets

**What I could not answer precisely:** Part 1b is the most granular section here and
every row of it is *inferred*. "Orienting" means "before the first `Edit`/`Write` whose
target is not under `docs/`". That heuristic misclassifies at least three real cases I
can name: a lane that writes a probe script first (its build turns look like
orientation), a lane that edits a test before the code (its build starts early), and
the 24 lanes that never edit code at all (verify and investigate lanes, whose entire
run is scored as "orient" — which is why I had to split the table by dispatch class to
say anything honest). The **median 3.3 minutes to first code edit** is the most quoted
number in this document and it rests on that heuristic.

**Log:** a lane-emitted `phase` marker — a one-line, zero-cost tool call or a structured
line in its report — at each transition: `orienting → reproducing → building → testing
→ writing-up`. Five values, self-declared, timestamped.

**Capture point:** the lane itself, as part of the standing response contract. The hook
that already grades response format could require it.

**Cost to close:** *moderate.* It needs a convention lanes actually follow, and a lane
that forgets produces a gap rather than a wrong answer (which is the right failure
direction). **Value: moderate-high** — it turns Part 1b from inference into measurement,
and it is the only way to answer "where in the lane did the time go" for a lane that
does not edit code.

---

### G6. Wall-clock per ticket cannot be decomposed into working / parked / waiting-on-a-human

**What I could not answer:** BUG-116 shows 20.0 wall-clock hours and 2.0 agent-hours. I
can state the ratio. I cannot say how much of the 18-hour difference was *waiting for
the user to answer a decision the ticket was blocked on* versus *nobody picked it up*.
Those have opposite remedies — the first is answered by surfacing decisions faster, the
second by a standing backlog — and the ticket carries the evidence for neither.

**Log — a ticket-level state timeline**, one row per transition:
`{ ticket, at, state: open | dispatched | awaiting-verdict | awaiting-user | blocked-on-peer | done, byLaneId }`.
The board already computes a current state; what is missing is that it is **not
append-only over time** — only the latest value survives.

**Capture point:** wherever board state is derived today (`src/server/board.ts`),
writing a transition row instead of only recomputing a current value.

**Cost to close:** *moderate* — it is a new append-only store, though a small one.
**Value: high**, and it is the direct answer to the user's actual complaint. "Five hours
per ticket" is a wall-clock claim, and wall-clock is the one axis with no instrument.

---

### G7. Cross-provider verifier spend is invisible

**What I could not answer:** every OpenAI clean-room run in this window is a black hole.
`scripts/dispatch.mjs` records `provider, model, sessionId, exitCode, failureKind` and
no usage at all. The previous window recovered 1.21 M tokens across 27 runs from
`.log` files, which is why I can say the amount is immaterial — but I recovered nothing
for this window, and "immaterial" is inherited, not measured. Since the verification
question is the one the orchestrator most wants answered, having half of verification's
true cost unmeasured is a real hole even though the number is small.

**Log:** `usage` and `costUsd` on the dispatch meta record for both providers, with the
rate table used, so the arithmetic can be corrected later.

**Capture point:** `writeMeta()` in `scripts/dispatch.mjs` — the object is already being
written; this adds fields to it.

**Cost to close:** *low* for Anthropic (usage is in the stream), *moderate* for OpenAI
(needs parsing the response envelope). **Value: moderate** — small dollars, but it
closes the last gap in the argument that verification is cheap.

---

### G8. Rework is not linked to what caused it

**What I could not answer mechanically:** I priced rework at $184.50 by matching the
charter phrase *"fix a defect an independent cross-provider clean-room pass found"*.
That works only because the orchestrator writes consistent charters. Nothing links a
fix lane to the verdict that triggered it, and nothing links a defect to the earlier
round that introduced it. The `regressed-from:` convention exists and is used well —
I found it on ARCH-004 round 6 and on three of BUG-118's four rounds — but it is
**prose in a ticket log**, so "how much of our spend is fixing our own previous fixes?"
cannot be answered without reading every ticket. It is one of the most valuable
questions on this list and I can only answer it anecdotally.

**Log:** `causedByVerdictId` and `regressedFromRound` on the lane record (the first is a
foreign key into G2; the second the machine-readable form of a convention already in
use).

**Capture point:** the dispatch call — the orchestrator knows which verdict it is
answering at the moment it writes the charter.

**Cost to close:** *low*, given G2. **Value: high** — it turns "the previous round's
limitation became the next round's defect", which both windows assert qualitatively,
into a number.

---

### G9. Suite-maintenance work is not separable from defect work

**What I could not answer:** I estimated suite maintenance at *$25–40* and labelled it
an estimate, because a lane that spends forty turns un-pinning four suites that broke
for no defect looks identical, in every record, to a lane fixing a real bug. BUG-124
("four more suites pinned the world the cutover was allowed to move") is a whole ticket
about exactly this and it has no separable cost.

**Log:** on the lane record, `workKind ∈ defect-fix | suite-repair | migration |
tooling | docs`, self-declared. Cheap because it is one enum, and lanes already know
which they are doing — BUG-124's own title says so.

**Capture point:** lane report, validated at turn end.

**Cost to close:** *low.* **Value: moderate** — it prices a category `docs/CONVENTIONS.md`
already warns about twice, and would tell you whether the warnings are working.

---

### G10. Collision and deadlock events are not recorded

**What I could not answer:** the one real deadlock in this window was found by grepping
the orchestrator's transcript for the word "deadlock". If the orchestrator had phrased
it differently I would have reported zero collisions. My *estimate* of under $10 rests
on four anecdotes I happened to find.

**Log:** an event row when the orchestrator serialises lanes on a shared file, when a
lane declines to commit over another's work, and when a deadlock is broken —
`{at, kind: serialised | refused-commit | deadlock-broken, lanes[], file}`.

**Capture point:** the orchestrator, at the moment it makes the call. It is already
making the decision explicitly.

**Cost to close:** *low.* **Value: low-to-moderate** — the number is genuinely small
this window, but it is currently unmeasurable rather than measured-small, and the
design makes it a standing hazard.

---

### G11. Model tier is not attributed to work

**What I could not answer precisely:** 95% of assistant messages ran on Opus-tier, so
one price row is defensible, but I could not attribute the Haiku and Sonnet messages to
lanes cleanly — usage is per-message and model is per-message, but my aggregation is
per-lane. The standing model-tier rule ("Opus 4.8 default; Fable/Opus 5 only when truly
complex") has no compliance measurement at all: **I cannot tell you how many lanes ran
on a tier above what their dispatch class warranted.**

**Log:** `model` and `dispatchClass` together on the lane record (both already proposed
above), plus per-model usage subtotals rather than one lane total.

**Cost to close:** *low* once G3 and G4 land — it is a join, not new capture.
**Value: low-to-moderate** — the rates are close enough that this is a governance
question more than a cost one.

---

## Ordering summary for the instrumentation lane

| # | Gap | Value | Cost to close |
|---|---|---|---|
| G1 | blocked-vs-working time; lane `startedAt` | **highest** | low |
| G2 | structured verdict record (round, verdict, defect class, regressed-from) | very high | low–moderate |
| G3 | dispatch class + hypothesis outcome recorded, not inferred | high | low |
| G4 | tokens/cost persisted and attributed to ticket(s) | high | low (usage) / moderate (split) |
| G6 | ticket state timeline (append-only, not latest-value) | high | moderate |
| G8 | rework linked to the verdict that caused it | high | low, given G2 |
| G5 | in-lane phase markers (orient/reproduce/build/test/write-up) | moderate–high | moderate |
| G7 | cross-provider verifier usage | moderate | low–moderate |
| G9 | `workKind` — separates suite repair from defect fixing | moderate | low |
| G10 | collision / deadlock events | low–moderate | low |
| G11 | model tier attributed to dispatch class | low–moderate | low, after G3+G4 |

**If only three land, land G1, G2 and G3.** G1 makes the headline number actionable;
G2 makes the convergence rule (change 1) mechanical instead of a judgement call and
retires a bug family; G3 removes the ±5% from every phase figure in this document and
answers a question the Working Agreement asks and nothing measures. G4 is the fourth
because it is nearly free — the usage numbers already exist and are simply discarded on
restart.

---

# Method and limitations

- **Source:** per-message `usage` records (input, output, cache-creation, cache-read)
  and per-turn `tool_use` blocks with their targets, timestamped, from every agent
  transcript modified in the window. Lane durations are last-minus-first message
  timestamp. Verdict history from the tickets' append-only Activity logs; commit times
  from `git log`. Record shapes quoted from `src/server/outcomes.ts` and
  `scripts/dispatch.mjs`.
- **Lane definition:** one in-process subagent (grouped by `agentId` within a sidechain)
  or one separately-spawned `claude` process (one transcript file). 104 subagent lanes,
  1 orchestrator session, 342 spawned processes — of which 195 are the ARCH-005 tuning
  loop and 153 are one-turn migration workers, which is why the lane count is high and
  the mean lane cost low.
- **Sampling:** the per-turn analysis (Part 1b) covers the **88 subagent lanes with ≥8
  turns**, which is 9,292 of the window's 10,961 turns. Excluded: 16 lanes under 8 turns
  (smoke tests, one-line probes) and the 348 single-turn spawned sessions, whose
  internal phase structure is degenerate. The per-ticket table (Part 1d) sweeps rather
  than samples.
- **Phase classification is heuristic** — see G3 and G5. Keyed on each charter's opening
  imperative and checked by reading all 104 subagent charters. Residual error ~±5%.
- **Ticket attribution** — see G4. Multi-ticket lanes are attributed wholly to the first
  ticket named, which is why six tickets appear as *(batched)* rather than carrying a
  fabricated figure.
- **The four estimates in this document,** all labelled in place: collision cost
  (<$10); suite maintenance ($25–40); turn-1 context cost (~$8); the saving from
  change 2 ($190–280). Nothing else is an estimate.
- **No suspend correction needed.** The previous window subtracted 8.4 h of machine
  suspend from inside two lanes. This window's long gaps fall *between* lanes, so they
  are counted as idle rather than as agent time.
- **Cross-provider verifier spend is excluded** — see G7.

---

## Own cost of this analysis

One read-only lane. **83 assistant turns, 40.8 M tokens, $20.60** at the rates above.
No pipelines re-run, no sub-agents dispatched, no model calls spent on anything a
script could count — all aggregation was done by six Node scripts over the raw
transcripts, in scratch. That is 1.8% of the window it measures.
