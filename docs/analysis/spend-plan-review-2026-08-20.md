# Adversarial review of `spend-reduction-plan-2026-08-20.md`

**Date:** 2026-08-20 · **Lane:** spend-plan-review · **Method:** read-only. No
pipeline re-run, no sub-agent dispatched, no product code touched. Every objection
is grounded in a named document in this directory or in a measurement taken from
the repo and shown inline. Where the evidence cannot settle a question it says so.

The plan was written by the orchestrator about its own behaviour. One flaw had
already been caught by the user (the preamble's claim that writing inline was the
cheap choice). This lane's job was to find the rest before any of it is acted on.

**Verdict in one line: the diagnosis is right, the arithmetic under the headline
number is not established, three of the eight items are contradicted by the very
documents they cite, two items cannot both be executed, the success metric is
unmeasurable and rewards the wrong behaviour, and the largest measured saving in
the evidence base is absent from the plan.**

---

## What survives

Stated first, so the rest is not read as a rewrite-for-its-own-sake.

- **Reading dominates writing, and context size is the lever.** True in direction
  under every reading of the data. Even with the corrections in §1 applied, cache
  and context reads stay ~95% of tokens. The plan's central framing — judge every
  lever by what it reduces in *reads* — is correct and is the right frame.
- **The board/record system outspent the product.** $703.95 vs $201.25 is a 3.5×
  gap that no plausible correction closes; the correction is roughly uniform
  across lanes and cancels in a lane-vs-lane ratio (`COST-METHOD.md`, closing
  section). Freezing feature work there is the right call.
- **Item 2, two same-class failures → an architecture decision.** Best-evidenced
  item in the plan. Supported independently by `pipeline-cost-2026-08-20.md`
  (ARCH-004: six rounds, each fix creating the next round's defect, $97 and never
  HOLDS) and by `counterfactual` Gate 3. It removes no verification round; it
  changes what is done with a verdict. Keep it exactly as written — subject to the
  dependency in §4.
- **Item 7, context-size handoff rule rather than a turn cap.** The plan correctly
  reconciles two sources that disagreed (`pipeline-cost` change 2 recommends a
  ~40-turn cap; `counterfactual` found no evidence a cap helps) by noticing the
  cost is context growth, not turn count, and correctly refuses to commit before
  measuring. This is the plan's best piece of reasoning. Two omissions, both
  minor: `pipeline-cost` change 2 explicitly says **"Do not apply it to
  verification lanes"** (median 7 min, $4.09, and their whole value is one agent
  holding one attack in one head), and the instrument needed to measure it (G1,
  G4) does not exist and is frozen by item 1.
- **Not cutting verification.** Correctly resisted, and correctly identified as a
  refuted hypothesis rather than a live option.
- **The note on the planning board.** Honest, and right to say this file is not it.

That is roughly half the document. The rest does not hold as written.

---

## 1. The single number that decides the order is the one number `COST-METHOD.md` does not exempt

The plan opens: *"**231 tokens read for every token written**; cache and context
reads are 95.7% of all transcript tokens… Every lever below is judged on whether
it reduces what gets *read*."*

That figure comes from `pipeline-cost-2026-08-20.md`, which carries a superseded
banner. The plan's implicit defence is `COST-METHOD.md`'s closing paragraph:
*"Their relative findings … are far more robust than their absolute totals, because
a roughly uniform over-count cancels in a ratio."*

**The over-count is not uniform across token classes, and 231:1 is a token-class
ratio.** `COST-METHOD.md` §1 and §2 say so explicitly:

- §1: summing `usage` across content-block lines over-reports **cache-read** by up
  to **2.22×**.
- §2: *"Cache figures are identical across the rows; **output is not**."* The early
  rows carry a partial `output_tokens`, often a literal `1`.

So the numerator of 231:1 (reads) is inflated by the full block multiplicity and
the denominator (writes) is inflated barely at all. The one ratio that the
uniformity argument protects is a lane-vs-lane ratio; a read-vs-write ratio is
exactly where it fails. The true figure is somewhere between roughly **104:1 and
231:1** and nobody has computed it.

Two consequences, and only the second is serious:

1. *"Reading dominates"* survives regardless — at 104:1 the conclusion is
   unchanged. The **frame is safe.**
2. **The magnitudes that decide the plan's ordering are not.** Applying all three
   corrections shifts the cost mix substantially: cache-read's share of cost falls
   and **output's share roughly doubles** (correction 3 raises 1-hour cache writes
   from 1.25× to 2×, correction 1 cuts the read volume). "Nothing about how fast an
   agent writes code matters against that ratio" is asserted against a ratio that
   moves under correction and has not been recomputed. The plan says this in its
   own item 8 — *"Do it before quoting any dollar figure again"* — and then quotes
   percentages derived from those figures in items 6 and 9 and orders everything by
   the ratio in the header.

**And the correction is cheap and already built.** Verified in the repo:
`scripts/cost-collect.mjs` and `scripts/lib/cost-model.mjs` exist,
`package.json:210` registers `cost:collect`, `package.json:212` registers
`verify:cost-collect`. The plan itself calls it *"one command now that the
collector is fixed."* It is sequenced **fifth**.

**This is the plan's ordering defect and it is the same shape as the flaw the user
already caught: an assumption asserted rather than measured, when measuring was
one command away.** The ledger is a *dependency* of items 3, 4, 6 and 9, not a
verification step that follows them.

*What the evidence cannot settle:* whether the corrected ledger changes any
ordering decision. It might confirm everything. The objection is that the plan
does not know, and could have known for one command.

---

## 2. "The freeze is free" — three counter-examples, one of them live right now

The plan asserts the freeze *"costs nothing"* (item 1) and the sequence table
prices it at `none`. `pipeline-cost` change 3 says *"Costs in correctness: zero for
the product."* Both are wrong in ways the evidence in this directory documents.

### (a) The plan drops its source's precondition

`pipeline-cost-2026-08-20.md` change 3 does not say "freeze". It says:

> Freeze board-schema work **below severity "the board reports a false state to
> the user"**, and **finish the cutover's outstanding fallout (BUG-124's four
> pinned suites, ARCH-004's unverified round 7) before opening anything new on it.**

The plan reproduces the first clause and silently drops the second. Verified in
the repo: `docs/bugs/INDEX.md:20` still shows **ARCH-004 OPEN, awaiting a human
decision**, meaning its round-7 parser behaviour is still unverified. A freeze that
begins before the fallout is finished is not the same intervention that was
costed, and its cost is not the one that was priced.

### (b) A half-migrated change is live and unfinished, and the freeze pins it there

`board-impact-ordering-2026-08-20.md` §7 records that **the code landed before the
park instruction arrived** — commit `59a2ebd` (verified present:
`FEAT-095: order the board by what answering a ticket is worth, not by when it was
filed`; `src/server/board-rank.ts` verified present on disk). Four things are
outstanding, per that lane's own §7:

1. `rankWhy` is on the wire and **nothing renders it**. Verified: `rg rankWhy
   public/app.js` returns **no hits**. The board is reordered and silent about why
   — which that lane says *"fails constraint 1 as a user-visible property."*
2. No screenshot, no real-browser check of the ordered list.
3. **No independent clean-room pass** — and, in that lane's words, *"it moves what
   every session is told to focus on, so one is warranted before this is called
   VERIFIED."*
4. A weight change the lane itself judged wrong (§5(a)).

That third point is the load-bearing one. §1 of the same document: `summary.focus`
is *"injected into every launched session's system prompt as 'the project's focus'
(`boardStateSection`)"*. So an unverified, unrendered, half-finished ranking change
is **currently altering the system prompt of every agent this project starts**, and
under an unqualified freeze it stays that way indefinitely. "Zero cost for the
product" is not true of a change that silently steers every future lane.

The freeze's real options are: revert `59a2ebd` (that lane says it is a clean
`git revert`, touching no other lane's files), or exempt the four finishing items.
The plan considers neither because it treats the freeze as costless.

### (c) The deferred-defect rate is quantified, and the plan does not carry it

The plan's own evidence prices waiting. `docs/bugs/INDEX.md:44`, ARCH-010's row:

> **If we wait: A new instance appears in a new subsystem roughly every three
> days, and each one arrives as its own architecture ticket needing its own
> decision.**

That is the freeze's cost, in the currency of the plan (`defect-origin` §5: class
1a+1b is 49% of all defects). A freeze of a week is priced at ~2 new architecture
tickets, each with its own decision and its own lane. It may still be worth
paying. It is not zero, and the plan should carry the number.

### (d) The exemption is drawn too narrowly to catch the highest-harm class

The freeze exempts *"defects that produce false state or data loss."* The
`counterfactual` names a third class it ranks **highest priority in the whole
scheme**: *false proof* — *"anything that can make the record claim work was
verified when it was not."* Two live instances sit outside the plain reading of
the exemption:

- BUG-124's re-aimed negative corpus: *"it did not merely go red, it silently
  RE-AIMED the negative corpus at the contract's own output, so the check kept
  running while measuring the opposite of what it meant… had the rules been a
  little more permissive it would have gone green having inverted itself."* A
  suite that passes while measuring the wrong thing produces no false *state* and
  loses no *data*.
- `verification-ergonomics` §3: `opts.runs` is passed to the contract as
  `knownRuns`, so **a verifier can satisfy "re-run the fixer's own test" by citing
  `mkdir -p docs/prompts/patterns`**. That is a live soundness hole in the evidence
  contract, in frozen machinery.

**Correction:** the exemption should read *"false state, data loss, or false
proof."* One word, and it is the difference between the freeze being safe and the
freeze protecting the mechanism that lets a bad fix be recorded as verified.

---

## 3. "Stop reading whole ticket histories" — right target, wrong instrument, and it disables item 2

Item 4 is called *"the direct attack on the 231:1 ratio."* Four problems.

### (a) It is not what the measurement says is being read

`pipeline-cost-2026-08-20.md`, "Orientation, decomposed", over 2,048 pre-first-edit
tool calls:

| target | calls | share |
|---|---:|---:|
| Bash (of which 53.9% is `rg`/`sed -n`/`find` over the codebase) | 1,590 | 77.6% |
| Source code (Read tool) | 209 | 10.2% |
| **Ticket / board files** | **77** | **3.8%** |
| Methodology docs | 52 | 2.5% |

Its own conclusion: *"Orientation is 64% reading the codebase and 2.5% reading the
methodology."* Ticket and board reads are **3.8% of orienting calls**. The read
volume is source code, not ticket history. The plan attacks the 3.8%.

### (b) The corpus figure is right; the per-lane figure is what matters and is small at the median

Verified in the repo: `docs/bugs/` is **542 files, 133,585 lines** — the plan's
"~134k lines across 542 files" is accurate. But no lane reads the corpus; a lane
reads *one ticket*. Measured over the 211 live ticket files: **median 183 lines**,
90th percentile 358 lines. Order-of-magnitude arithmetic (mine, not measured):
~183 lines ≈ ~2.5k tokens; re-read as cache across a 300-turn lane ≈ 0.75M
cache-read tokens ≈ **$0.38** at the analysis's own $0.50/MTok. Across 78 charters
that is **~$30 — the same order as the charter cost the evidence explicitly
refused to act on** (§5 below).

### (c) The saving is concentrated exactly where the history is load-bearing

The tail is where the tokens are: `FEAT-091` 2,250 lines, `ARCH-003` 2,143,
`FEAT-062` 1,125, `BUG-105` 1,112. Those are ~28k tokens each and genuinely
material on a long lane. **They are also the multi-round tickets** — `FEAT-091`
carries twelve BROKEN verdicts across twelve rounds (`board-impact-ordering`
§5(b)); `ARCH-003` and `BUG-105` are two links in the seven-ticket liveness
recurrence chain (`defect-origin` §3). Item 4's saving is real only on the tickets
where dropping the history costs the most.

### (d) It removes the input item 2 requires — and item 1 blocks the substitute

This is the plan's hard internal contradiction.

- **Item 2** requires knowing the **class of the previous round's defect**: *"Two
  same-class verification failures → an architecture decision."* `counterfactual`
  Gate 3 is explicit — *"Before commissioning round N+1, classify round N's finding
  by harm class"* — as is the fourth Gate 3 clause, *"Round N's finding was already
  on round N−1's handoff list."*
- **Item 4** removes prior rounds from the charter.
- The only other source of a round's class is the structured verdict record —
  `pipeline-cost` **G2**, which does not exist: *"one turn in the entire window
  wrote a verdict to a ticket."* G2 is emitted by `independent-verify.mjs`, i.e.
  **verification-harness machinery, frozen by item 1.**

So item 2 needs either injected history (removed by item 4) or a verdict record
(blocked by item 1). As sequenced, the plan disables its own best-evidenced item.

Also: *"prior rounds available on request rather than injected"* is a behavioural
prediction contradicted by the measured behaviour of these lanes.
`verification-ergonomics` §2: **67 of 81 lanes (83%) hand-rolled the synthetic
base** rather than reuse a construction, and **29.2% of the verification
pre-phase is `git log/show/diff/rev-parse` — working out what the change was.**
These lanes do not ask; they re-derive from git, which is the measurably expensive
path. Withheld context predictably becomes re-derived context, at a markup.

**Corrected form of item 4:** not "stop injecting history". Inject *less and
better* — the current requirement, the invariant, the diff, the command, **plus
the previous round's finding and its class, plus the fixer's own open-items
list**. Full history on request. That preserves items 2 and 3 of the
`counterfactual`'s gates and captures most of the token saving, because the tail
tickets are long in *rounds*, not in what one round needs.

---

## 4. The biggest measured saving in the evidence base is missing from the plan

`counterfactual-2026-08-20-minimum-path.md`, "What I would do differently
tomorrow", item 1:

> **Gate 1.** Make the handoff list a precondition on the lane, not a note for the
> next one. **Largest single saving, no quality cost.**

And §"The larger and more expensive pattern":

> **a third of the independent rounds found only defects the fixer had already
> written down as open items before commissioning the round.** … This single rule
> removes about a third of the rounds in this corpus, including **two full refix
> lanes on BUG-116 and one whole clean-room pass on FEAT-094.**

The prize: rework is **$184.50, 16.6% of the window, 15 lanes, mean $12.30** —
*"the answer costs three times the question"* ($184.50 rework vs $94.13 of
verdicts). A third of the rounds removed takes rework and verification with it.

**Gate 1 appears nowhere in the plan.** It costs nothing, it needs no machinery, it
has no dependency on any other item, it is contradicted by nothing, and it is the
one intervention its own evidence lane calls the largest with no quality cost.
Meanwhile the plan spends item 6 on charters, measured at 3.3% and explicitly
refused by the cost analysis.

Two smaller omissions from the same source, both cheap and both supported:

- **Batch orchestrator bookkeeping.** `counterfactual` §"Where this contradicts
  the WA": six commits in the window were single-line bookkeeping, *"each … a
  dispatch that re-reads the agreement, the conventions doc and a ticket to change
  one line… Batch them into one hygiene lane per session."*
- **The orchestrator's own line item is untouched by the entire plan.** $161.61,
  **14% of the window, one session, producing no code**, 58.6% of it "pure text".
  It is the third-largest bucket and the plan contains no item that reduces it.
  This is the same blind spot as the preamble flaw the user caught: the plan
  scrutinises every actor's cost except the one writing it.

---

## 5. Item 6 (shrink charters) resurrects a hypothesis its own evidence refuted

`pipeline-cost-2026-08-20.md`, "What I am explicitly not recommending":

> **Not "shorten charters."** Measured at $37, 3.3%. Methodology re-reading is 52
> tool calls in the entire window. **The hypothesis was offered for testing and
> failed it.**

The plan re-adopts it at position 6 with a new justification: *"they also set how
much a lane reads before it starts — the 73% of pre-work that is orientation."*

That justification is a misattribution. The 73% figure is from
`verification-ergonomics` §2, it counts **tool calls in 59 verification-only
lanes**, and that document assigns the cause elsewhere in its own §5:

> the per-ticket content is real, but it is **known to the fixer and not
> recorded**, so the verifier re-derives it from the diff at ~73% of the
> pre-phase. **That is the orientation cost, and it is a handoff defect.**

Its remedy is a `proof` block in the ticket (Option A) or the contract split
(Option B). Shorter charters do not touch it. That document also flags its own
limit: *"My ~73% figure counts tool calls, not model tokens."*

**Item 6 should be dropped or replaced.** The replacement its evidence supports is
the `proof` block — the fixer records the suite, its inputs and what to exclude
from the diff, all of which it already knows at fix time. `verification-ergonomics`
§7 even names the cheap test before building it: *"fill the `proof` block by hand
for three recent tickets and time it."*

---

## 6. "Route mechanical work downward" — the category as drawn contains the window's most dangerous work

The claim (item 5): *"Mechanical migration, board regeneration, documentation, CSS,
schema edits and bookkeeping do not need it."* Two of those six are wrong.

**"Mechanical migration."** The window's largest migration is FEAT-094, 194 tickets
promoted. `counterfactual`: the cheapest and highest-value catch in the entire
window was **not** bought by a round —

> the move list had to be filtered to staged files (the old code would have
> archived an unstaged original and then failed to find a replacement)
>
> That is the cheapest catch in the window and it cost nothing.

— and its harm class is *"unrecoverable-ish at 194 files."* It came from **the
builder testing the charter's hypothesis before building**, i.e. from a model
doubting its instructions on a job labelled mechanical. `counterfactual` §Gate 2
puts this class — *"irreversible / board-wide"* — at exactly one round, *"scoped to
byte identity, refusal, and recovery"*. A category whose defining property is
irreversibility is the worst candidate for a downgrade justified by the work
"looking mechanical".

**"Schema edits."** `defect-origin` §5 class 1b — meaning derived from prose or an
ad-hoc format — is **23 defects, 19%, and the fastest-growing class: 16 of the 23
filed in the last three days**, with 4 of 9 ARCH tickets in it. Almost every recent
schema/record edit is in that class. BUG-125 is the model: it *looks* like a
one-line fix to a wrapped `Verified-by:` line, and the value came from judgement —

> The lane tested the hypothesis against all 70 real records before building,
> measured that an unbounded paragraph join would absorb 5–18 lines of prose on
> four records, and bounded the join at the first verdict token.

— on a defect that had silently mis-transcribed **six verdict records across three
tickets**, i.e. false-proof class.

**Also: the saving is smaller than the plan implies, because much of it is already
taken.** `pipeline-cost` price assumptions: *"the Haiku/Sonnet lanes are the
one-turn migration workers."* The genuinely mechanical bulk work — 195 ARCH-005
tuning sessions ($46.52) and 153 one-turn migration workers ($34.86) — **already
ran on cheap tiers**. The money is in the top 20 lanes (**57% of the bill**), which
are long build and rework lanes on prose boundaries and protocol races. The
sequence table's claim of *"tier cost on ~half the lanes"* conflates a **message
count** (95% Opus-tier) with a **cost share**, and the lanes it would move are
largely already moved. `pipeline-cost` G11 states the honest position: *"I cannot
tell you how many lanes ran on a tier above what their dispatch class warranted."*

**Corrected item 5:** keep the rule; cut *mechanical migration* and *schema edits*
from the cheap list; keep board regeneration, documentation, CSS, bookkeeping; and
add the `counterfactual`'s test — route by **cost of a mistake**, and anything
irreversible or in class 1b stays on the top tier regardless of how mechanical the
edit looks.

---

## 7. Item 3 ("user-reported outranks agent-noticed") deprioritises the class the evidence ranks highest

`defect-origin` §1, discovery split of 119 defects: user **43%**, `bug-hunt` 20%,
dispatched agent 24%, orchestrator 4%, `area-review` 4%, other 5% — **57% caught
before the user saw them**, and the document calls the falling user-found share
(48% → 31% across periods) *"the process getting better, not worse."* Item 3
deprioritises the 57% and points directly at the trend the same document
celebrates.

Worse, the rule is **blind by construction to the highest-harm class**. A user
cannot report a false VERIFIED. `counterfactual` on BUG-119 round 2 — a defect
that was **live on the board**:

> BUG-109, "whose status line reads 'VERIFIED (fixer's own run) — independent
> clean-room verify still required', whose single independent verdict is BROKEN —
> derived `holds`"

and on the first of the four cited saves: *"**It did ship.** It sat on the board
for two days and the board displayed it."* Nobody reported it, because the board
looked correct. A priority rule keyed on who noticed cannot see this class at all.

**Corrected item 3:** priority is by **harm class first, reporter second** — false
proof and silent loss outrank everything regardless of who noticed; user-reported
outranks agent-noticed *within* a class. That preserves the intent (an agent's
passing observation should not open a lane) without inverting the priority of the
one class the evidence calls highest.

---

## 8. "Tokens per closed ticket" is unmeasurable today and rewards avoiding the work that matters

Four independent failures. Any one of them is disqualifying.

**(a) The numerator does not exist.** `pipeline-cost` **G4**: *"Tokens and cost are
attributed to a session, never to a ticket."* Attribution runs charter prose →
ticket id; **multi-ticket lanes are attributed wholly to the first ticket named**;
six tickets in the window appear as *(batched)* with no figure at all, and
FEAT-094 and ARCH-005 are *"correspondingly over-counted."* The per-ticket table is
called *"the shakiest"* deliverable in the document.

**(b) The denominator is derived from prose.** "Closed" is board state, which is
ARCH-004's entire open class — *"Open tickets silently disappear from the board"*,
still OPEN at `INDEX.md:20`.

**(c) Both fixes are frozen.** G2 and G4 are board and verification-harness
instrumentation — item 1's freeze. The plan proposes a metric whose two inputs it
simultaneously forbids building.

**(d) The incentive is backwards, and this board has already refused it once.**
`defect-origin` §2: the median ticket is one-and-done (108 of 199 are fix+verify);
*"The pain is a tail of eight"* — `FEAT-061`, `ARCH-003`, `FEAT-091`, `BUG-105`,
`ARCH-004`, `FEAT-062`, `BUG-116`, `BUG-118` — which are the liveness, prose-boundary
and harness classes, i.e. ARCH-010's class. Tokens-per-closed-ticket is minimised
by working the 25 one-entry tickets and never touching those eight — including
ARCH-010, which `board-impact-ordering` §4 ranks **first by a factor of two**
([55] against [30]). It is also trivially gamed by ticket granularity, which the
measured agents themselves set: BUG-127 and BUG-128 were filed 6 minutes apart from
one round. And it has **no quality term at all** — skipping verification improves it
maximally, which contradicts the plan's own stated goal (*"without losing the
quality of the work"*).

`board-impact-ordering` §5(b) already reasoned this through and declined to build
it:

> a cost term would need to *lower* a ticket's rank and I did not want to build
> something that hides hard work.

The metric does exactly what that lane refused to do, one level up.

**Replacement:** keep **read:write ratio** (a mechanism metric, unGameable by
ticket choice, once §1's correction is applied) and pair it with a quality term
the evidence already tracks — **user-found share of defects** (`defect-origin` §1,
currently 31%). If tokens fall and user-found share rises, the saving was
extraction, not efficiency. Tokens per closed ticket should not be adopted in any
form.

---

## 9. The deferrals — one is defensible for the wrong reason, one contains something that should not be deferred

**The 186 verification files (item 9).** The plan's justification — *"Verification
measured at 8.4% of spend, so this is a large job against a small share"* — is a
category error. The 8.4% is the cost of **verification lanes**; the 183 files are a
**corpus** whose read cost is paid by everyone who searches `scripts/`. The
evidence points the other way:

- `defect-origin` §1: *"`verify-*` alone is 72,306 lines across 183 files — larger
  than the entire product. 90 of those 183 are named after a single ticket."* 202
  npm scripts, 179 of them `verify:*`.
- `verification-ergonomics` §2: **47.7% of the verification pre-execution phase is
  "reading / inspecting repo files (which suite? what does it need?)"** — literally
  hunting for the right suite among 183.
- `pipeline-cost`: orientation is *64% reading the codebase*, and its
  representative orienting call is `sed -n '320,413p' scripts/dispatch.mjs`.

So the deferral may still be **right on cost-to-change** — it is a large job, and
`defect-origin` §6 intervention 6 warns explicitly against *"intervention #1 paid
for in the currency of problem #2"*. But **the stated justification is invalid**,
and a plan whose thesis is "reading is the cost" should not price a read-volume
problem against a lane-class spend share.

**What must not be deferred inside it.** `verification-ergonomics` §6 Option B —
split `--setup` from `--fixer-test`, make the room a clone instead of a stripped
tarball — is described as *"Cheapest, and a strict subset of A — so it is the right
first landing step, not a rival"*, and the whole proposal is *"net code effect:
subtraction."* It closes a **live false-proof hole** (§2(d) above: a verifier can
cite `mkdir -p …` as the fixer's own test) and restores the RED half of
non-vacuity to the 29 of 180 suites that shell out to git and currently cannot run
their must-FAIL leg in the room at all. Under a freeze exemption corrected to
include false proof, Option B is exempt. It is a different thing from consolidating
186 files and should be unbundled from it.

**ARCH-010 (item 10).** The deferral of the implementation is sound. But the plan
does not notice that **the freeze makes ARCH-010's remedy undeliverable**:
`defect-origin` §6 intervention 1 says the two migrations that implement it are
*"already mostly built"* — the `orchard-ticket` record block and the ARCH-001
liveness authority — and those are exactly board-schema and harness work. As
written, the plan invites a decision that cannot then be executed. Either the
freeze carves out ARCH-010's implementation or the plan should say plainly that
the decision is being taken now and executed after the freeze lifts.

---

## 10. The corrected sequence

Ordered by dependency and risk, then by value — which is the ordering principle the
plan says it uses (*"tokens saved per token spent"*) but does not apply, because
value cannot be ordered against an unverified number.

| # | Step | Cost | Why here |
|---|---|---|---|
| **0** | **`npm run cost:collect`** — recompute the window under `COST-METHOD.md` | one command, already built | Everything below is ordered by numbers this produces. 231:1 is the one ratio the "ratios survive" exemption does not cover (§1) |
| **1** | **Gate 1: no round is commissioned while the fixer can name an untested attack** | none, no machinery | Largest measured saving with no quality cost; a third of rounds; absent from the plan (§4) |
| **2** | **Freeze — with the source's precondition restored and the exemption widened to "false state, data loss, **or false proof**"** | not zero — finish BUG-124's suites, ARCH-004 round 7, and decide `59a2ebd` (revert or finish `rankWhy`) | The freeze as written pins a live half-migration into every session's system prompt (§2) |
| **3** | **Two same-class failures → an architecture decision** | none | Best-evidenced item; unchanged. Depends on step 4 supplying the prior class |
| **4** | **Charters carry requirement + invariant + diff + command + *the previous round's finding and class* + *the fixer's open-items list*.** Full history on request | one habit change | The plan's "no history" form disables step 3 and step 1 (§3) |
| **5** | **Route by cost-of-mistake — minus "mechanical migration" and "schema edits"** | one habit change | Those two categories are the irreversible and 1b classes (§6) |
| **6** | **Priority by harm class first, reporter second** | none | "User-reported outranks" is blind to false proof (§7) |
| **7** | **Answer ARCH-010, and carve its two mostly-built migrations out of the freeze** | a decision | Board's own #1 by 2×; deferring the decision costs ~1 new ARCH ticket per 3 days (§2c, §9) |
| **8** | **`verification-ergonomics` Option B only** — split `--setup`/`--fixer-test`, room as a clone | small, net-subtractive | Closes a live false-proof hole; unbundle from the 186-file job (§9) |
| **9** | **Handoff rule on context size — measured, and not applied to verification lanes** | one lane | Instrument (G1/G4) does not exist; say so rather than pretending the measurement is available |
| — | **Re-run the ledger.** Metric: **read:write ratio + user-found defect share.** Not tokens per closed ticket | one command | §8 |
| — | *Dropped:* shrink charters | — | Explicitly refuted at 3.3%; replace with the `proof` block if anything (§5) |
| — | *Deferred, justification corrected:* consolidate the 186 verify files | large | Right call, wrong reason — it is a read-volume problem, not an 8.4% problem (§9) |

The single most consequential change is moving the ledger from position 5 to
position 0, because it is the plan's own remedy for the plan's own defect, and it
costs one command.

---

## 11. What this review could not settle

Stated so it is not read as more certain than it is.

- **Whether the corrected ledger changes any ordering.** It might confirm the plan
  entirely. The objection in §1 is about the plan asserting rather than measuring,
  not about the answer being known to be different.
- **Whether inline planning was actually cheaper than a lane.** A parallel lane
  owns this. What I can add from the record: the orchestrator's context is the
  largest and longest-lived in the system (23.1 h, 460 turns, $161.61), and
  `pipeline-cost` §2 identifies the expensive shape as *"one agent holding one very
  large context for one to two hours, re-reading it every turn."* Writing this plan
  inline required reading five analysis documents (~110 KB) into that context,
  where they persist and are re-read on every subsequent turn for the rest of the
  session, whereas a lane's context dies with the lane. That is a mechanism the
  preamble does not consider, but I did not measure it.
- **The per-lane token cost of ticket-history injection.** §3(b) is my arithmetic
  from line counts, not a measurement. `pipeline-cost` G4/G5 explain why the real
  figure is not currently derivable.
- **Whether the harness should exist at this size at all.**
  `verification-ergonomics` §7 puts this question to a human and I agree it cannot
  be settled from the record.
- **Every figure quoted from `pipeline-cost-2026-08-19.md` and
  `pipeline-cost-2026-08-20.md`** inherits their superseded status. Shares and
  lane-vs-lane ratios are treated as usable per `COST-METHOD.md`; token-class
  ratios are not (§1).

---

## 12. Cost of this review

One agent, one context. **No sub-agents dispatched, no pipelines re-run, no suites
executed, no product code touched.** Ten tool calls: six document reads (the plan
and five analysis documents, all in full), four shell invocations (corpus line
counts, cost-collector presence, `59a2ebd` and `board-rank.ts` presence, `rankWhy`
grep, INDEX rows, one Working Agreement excerpt). One scratch file under the
scratch root. This document is the only repository change.
