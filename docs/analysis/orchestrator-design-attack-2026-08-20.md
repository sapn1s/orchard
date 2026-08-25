# Adversarial review of orchestrator designs A and B

**Date:** 2026-08-20 · **Lane:** orchestrator-design-attack · **Method:** read-only.
No sub-agent dispatched, no pipeline re-run, no prototype built, no product code
touched. Every objection below is grounded in a named document in this directory
or in a repo fact shown inline. Where the evidence cannot settle a question, it
says so.

**Verdict in one line: both designs are right about the same thing and wrong
about the same thing.** They are right that the sceptical read cannot be
relocated and must be deleted. They are wrong that what replaces it has a small
residue — the residue is *claim-set coverage*, chosen by the party with an
interest in it, and neither design's experiments can find it. Separately, A's
headline savings are computed against the wrong denominator and depend on a
mechanism A's own §9 rejects; A's enforcement has three open channels that
neither of its two layers touches; B is unbuildable and removes the user's
ability to steer. **Neither is buildable as specified. A v0 that both designs
converge on is shippable this week, and four of the fourteen experiments are
real and cheap.**

---

## What survives, stated first

So the rest is not read as a rewrite for its own sake. A design that is mostly
right needs to be known as mostly right, and both are more right than wrong.

**Both, jointly — the load-bearing insight.** The user's correction is correct
and both designs honour it rather than dodging it. A report that must be read
carefully to be believed is an unverifiable artifact; relocating the careful
reader to a cheaper model produces "a clean verdict from such a checker is an
active hazard" (WA §I). Both refuse that move explicitly. That is the single
most important thing in either document and it is not in dispute below.

**A's four measured facts, three of which hold outright.**

- **(a) The bill is `requests × context`, and both are controllable.** Survives
  intact. It is from `inline-vs-dispatch`, which is corrected-collector work
  (2,883 duplicate usage rows collapsed), and the 93.2%-context-maintenance
  figure is the most robust number in the evidence base. A is right that this is
  a context-size problem a tier swap would merely discount, and right to put it
  first.
- **(c) Dispatch is a cheap compression boundary.** Survives. $0.046 cold start,
  a 271-token fixed stub, 62M tokens in and 1,107 out, cheaper in every size
  bucket. Measured, corrected, and not contested by anything.
- **(d) Reading a report cannot verify it.** Survives. 0 of 7, and A's reading of
  it — *"proof that reading is the wrong mechanism, because a real false green is
  internally consistent and therefore invisible to every reader by
  construction"* — is the right inference, not an over-read.
- **(b) "The biggest single line item is the orchestrator talking."** Does not
  survive as stated. §1 below.

**A's §2 enforcement machinery exists.** Verified, not taken on trust:
`src/server/registry.ts:191-193` carries `permissionMode` / `allowedTools[]` /
`disallowedTools[]` per project; `~/.claude/settings.json:4` already registers a
`PreToolUse` array; `scripts/hooks/response-format-gate.mjs` is 701 lines with a
real advisory/enforce split (`mode: 'advisory'` at line 288, an enforcing closure
at 370). A's claim that an orchestrator profile is "a registry entry, not new
machinery" is true. This is A's strongest section and it is checkable.

**A's §7 ("what I would NOT change") is the best list in either document.** Every
item is tied to a refutation already on file: verification not cut (tested and
refuted), charters not shortened (3.3%, `pipeline-cost`'s own explicit
non-recommendation), the board substrate not swapped (`defect-origin` §6
intervention 7 priced it and said no), dispatch as the unit of work (the
crossover settles it), lane-tier routing by cost-of-mistake unchanged. A design
that names what it will not touch, with citations, is doing the harder half of
the job.

**A's §11 independent-verify flag is correct and should not be softened.** *"A
re-executor with a bug that always returns PASS is a false-proof machine with
board-wide reach."* That is exactly right, and it is the highest-harm class in
`counterfactual`'s scheme.

**A's §4 — the charter should not come from the orchestrator.** Well-supported.
WA §I says the framing was never an asset; the cost of moving it is bounded by
the measured fact that the lane orients anyway (26% of lane cost, $0.81 at the
median, 3.4 orchestrator tool calls). The claim that this is "approximately zero"
is where it goes wrong (§2 below), but the direction is right and the
`spend-plan-review` §3(d) carry-forward fields (previous round's finding *and its
class*, the fixer's open items) are correctly imported.

**B's attestation mechanism is the correct answer to 0-of-7, and its six
acceptance conditions are each mechanically checkable.** Binding to the exact
result revision, verifier run id ≠ producer run id, freshness, recorded actual
execution, non-vacuity against a known-bad subject, evidence-runner identity.
Each corresponds to a failure this board has recorded. B's Part 3 §1 says so and
I agree without qualification. The distinction B draws — *runner integrity*
(checkable) versus *oracle error* (irreducible) — is the most honest epistemics
in either document, and B's refusal to let an unoracled claim wear a "verified"
label (`status: untested, reason: no_mechanical_oracle, required_authority:
user_acceptance`) is a property A does not have and should acquire.

**B is more careful with numbers than A.** B's §4 cost paragraph explicitly flags
`pipeline-cost` as superseded arithmetic, keeps only the ratio (8.7% setup / 71%
attacking), and labels its own budget "a guess until the experiment below
measures it." A quotes from the same superseded document without the banner. On
epistemic hygiene about its own figures, B wins cleanly.

**B's §7 and its ten failure modes.** Keeping `scripts/dispatch.mjs` as the
provider boundary, keeping fresh-process clean rooms, keeping generation and
verification in separate processes, keeping append-only histories, keeping
cross-provider routing for high-cost-of-mistake work, and refusing to make
normative choices mechanical — all correct, all consistent with the evidence, and
the failure-mode list is more complete than A's §10. "Do not build a universal
proof system" is the right instinct even though B's own §4 violates it.

---

## 1. A's 58.6% — the number is real; the inference is not

This is the most load-bearing number in A and it needs four separate corrections.
None of them is that the figure was invented.

**The transcription is correct.** `pipeline-cost-2026-08-20.md:363` reads exactly
`| pure text — replying to the user, reading a report | 263 | 22.55 | $96.29 |
58.6% | 311k |`. A quoted its source faithfully. That much survives.

### (a) It carries a superseded banner A does not reproduce

`COST-METHOD.md` closing section: `pipeline-cost-2026-08-20.md`'s *"absolute
token and dollar figures are known to be wrong"*, and the direction *"is not
guaranteed for any individual line."* `spend-plan-review` §11 restates the
operating rule: shares and lane-vs-lane ratios usable, token-class ratios not.
58.6% is a **cost share across activity classes within one session** — and the
over-count mechanism (correction 1: `usage` repeated per content block) scales
with *content blocks per message*, which differs systematically by activity
class. A `thinking + text` turn and a `thinking + text + tool_use` turn are
over-counted by different multiples. So this share sits in the unprotected
category, and nobody has recomputed it. The direction is genuinely unknown —
crudely, correcting block multiplicity would *raise* pure text's share (fewer
blocks per message than a tool turn), while it is not knowable without running
`npm run cost:collect` over that window. **B flagged its inherited figures as
superseded; A did not.** This is the calibration shape exactly: a headline figure
quoted as fact when the correction document says something narrower.

### (b) The window is not the window A costs against

Two different accountings are spliced:

| | source | orchestrator | window total | orchestrator share |
|---|---|---:|---:|---:|
| A's §1(b), the 58.6% | `pipeline-cost` (superseded) | **$161.61 / $164.35** | $1,116.86 | **14%** |
| A's §6 savings table | `inline-vs-dispatch` (corrected) | **$1,625** | $3,890 | **42%** |

`pipeline-cost:129` shows the orchestrator at `$161.61 | 14%`; its own §357 header
shows `$164.35` for the same actor in the same document (an internal
inconsistency neither document notices). `inline-vs-dispatch` §5 shows $1,625 of
$3,890. These are different windows *and* different collectors. A takes the
internal breakdown from one and the baseline from the other and presents them as
one picture. Neither figure is wrong in its own document; the splice is.

### (c) The decisive objection: cost per turn is flat across activity classes

Divide `pipeline-cost`'s own table:

| Activity | Turns | Cost | **$/turn** |
|---|---:|---:|---:|
| pure text | 263 | $96.29 | **0.366** |
| writing a charter | 78 | $29.30 | **0.376** |
| bash | 74 | $26.42 | **0.357** |
| SendMessage | 34 | $11.17 | **0.328** |
| editing files | 7 | $0.82 | 0.117 |
| reading files | 3 | $0.34 | 0.113 |

The four large classes cost within 15% of each other per turn. (The two tiny ones
are cheap because they happened early, when context was small — which is the same
point.) **The 58.6% is turn count times context rent.** It is not evidence that
narrating is intrinsically expensive; it is evidence that *any* turn at 450k
context costs about $0.35, and there were more narration turns than anything
else. A's §1(b) is therefore not an independent second fact — it is §1(a)
restated with a class label attached, and A's framing (*"the orchestrator's
inline work was overwhelmingly reasoning and narrating in prose"*, *"it is the
orchestrator's largest cost centre"*) attributes to the activity a cost that
belongs to the context.

This matters practically: it means deleting narration saves money **only to the
extent it deletes requests**. A's design does delete those requests, so the
saving is real — but the argument for it is §1(a), not §1(b), and the size of the
saving is bounded by turn count, not by the dollar figure attached to the label.

### (d) The category is not what A calls it, and the deposit argument points elsewhere

The row is labelled *"pure text — **replying to the user, reading a report**"*.
A recasts it as narration and asserts *"the user's requested interaction shape
deletes it."* Requirement 3 deletes the *intermediate* narration. It does not
delete the completion message, the ask-user message, or the turn that ingests a
lane's report. A offers no decomposition of the 263 and has no measurement of the
split — and E2, the experiment offered for this claim, measures *rendering*, not
requests: a turn rendered away still costs $0.366 and still deposits its output.

The sub-claim about context deposit inverts too. 311k over 263 narration turns is
**1,182 tokens/turn**; 208k over 78 charter turns is **2,667 tokens/turn**. Per
turn, a charter polluted the orchestrator's context **2.3× more** than a
narration turn — consistent with A's own "median 2,371 output tokens" for the
charter turn. The context-pollution argument indicts the charter harder than the
narration. A's §4 happens to fix the charter, but not for the reason §1(b) gives.

**What the number actually supports:** cut turns and cut context. That is §1(a),
and it stands.

---

## 2. Cost, recomputed from the corrected collector

A's §6 asserts *"Structure buys ~10×. The tier buys a further ~5×."* The
arithmetic inside the table is internally correct; the framing is not.

**The rate table checks out, with one live error.** Verified against current
pricing rather than recalled: Opus 5 $5/$25 per MTok, Haiku 4.5 $1/$5 (200K
ceiling), cache read 0.1×, cache write 1.25× at 5-minute TTL and 2× at 1-hour —
all as A states. **Sonnet 5 is on introductory pricing of $2/$10 through
2026-08-31**, not the $3/$15 A quotes. A wrote "Rates, checked not recalled";
this one was recalled. It makes A's Sonnet row *conservative* (~$68, not ~$100),
which sharpens rather than weakens A's tier recommendation — but the discipline
A claimed was not applied.

**The denominator is wrong.** A's table header says "est. window cost" and
compares $1,625 → ~$170. But the window is $3,890 (`inline-vs-dispatch` §5:
orchestrator $1,625 + 476 lanes $2,266). The orchestrator is 41.8% of it. So:

| | orchestrator | + lanes (unchanged) | window | vs $3,890 |
|---|---:|---:|---:|---:|
| measured | $1,625 | $2,266 | $3,890 | 1.00× |
| A's design, Opus | ~$170 | $2,266 | $2,436 | **1.60×** |
| A's design, Sonnet 5 (intro) | ~$68 | $2,266 | $2,334 | **1.67×** |
| A's design, Haiku | ~$34 | $2,266 | $2,300 | **1.69×** |
| orchestrator at **$0** (the limit) | $0 | $2,266 | $2,266 | **1.72×** |

**1.72× is the ceiling on the whole exercise**, reachable only by deleting the
orchestrator entirely. "~10×" is a 10× on 42% of the bill. And the tier
question — the thing the brief asked about — moves the window by **$136, or
3.5%**. Thirty added lanes at the measured mean ($4.76 + $0.60 dispatch overhead
= $5.36) costs $161 and erases the entire Opus→Haiku saving. **The tier decision
is inside the noise of the lane-count decision, and neither design prices the
lane count it adds.**

**The 120k mean context requires a mechanism A's §9 rejects.** A derives its 0.105
ratio from `~1,100 requests × ~120k mean context`. Take A's own accretion figure:
~1.5k per dispatch. The measured window ran 476 dispatches → ~714k of accretion.
Starting near 30k and growing linearly, the *mean* is ~390k, not 120k — unless
something truncates it. The only thing that truncates it is compaction, at
roughly 200k. But A's §9 rejects *"Compact the orchestrator harder"* as *"treats
the symptom… the sawtooth is the shape of the problem, not the fix."* **A's
headline ratio depends on the sawtooth A's own alternatives table disowns.** This
is the inverted-dependency shape from the calibration note: the item that
delivers the number is the item the document says no to. Without a stated
compaction policy the honest ratio is nearer 3× on the orchestrator line and
~1.35× on the window.

(The 420k "mean context" is itself a single day's mean — `inline-vs-dispatch` §1
states it for 2026-08-20 — used as the whole-session mean, while the same
document's segment table shows six of seven segments running to the 1M wall. That
error is in A's favour and I note it only for completeness.)

**A's own experiment budget is off by an order of magnitude.** *"Total cost of
all six: well under one ticket's median lane spend."* The median lane is $2.45
(A's own citation). E6 alone is "six tickets, two arms" — at minimum six lanes,
$14.70 at the median and $28.56 at the mean, before any rework rounds. E5
requires reconstructing seven historical base trees and building a re-executor.
The stated budget cannot be right by any reading.

**B's cost claim is safer but its structure argues against it, and B's Part 3
#4 is correct.** I can put a number on it. B routes most requests through a
framing lane before the work lane. If half of 476 dispatches gain one, that is
238 × ($3.87 investigate/design mean + $0.60) ≈ **$1,064** — which alone exceeds
A's entire projected orchestrator spend by 6×, and is 46% of the total saving
available from deleting the orchestrator outright. The crossover measurement
supports *dispatch beating inline*; it says nothing about *three dispatches
beating one*. To B's credit, Experiment 8's kill condition ("total corrected cost
rises by more than 20%") is set where that would fire, and it is the **only cost
falsifier in either document**.

---

## 3. A's enforcement does not hold

The brief asks whether the role can still do work through a channel neither layer
denies. It can, three ways, and one of them is a one-hop escape from the
defence-in-depth argument A makes explicitly.

**Both layers deny by tool name; neither constrains argument content.**
`disallowedTools` is a name list. A `PreToolUse` hook fires on a call and can
inspect arguments, but A specifies it only as *"a second hook that denies the
list above"* — a name-based deny plus a log. Nothing in either layer bounds what
the model writes *into* an allowed tool.

**Channel 1 — `Dispatch.brief`.** A's own table describes the tool as taking
`class`, `agentType`, `model`, `paths[]`, and **`brief` (see §2.2)**. *There is
no §2.2 in the document.* §2 has "Allowed", "Denied", "Why `Records` is not a
slippery slope", and "What visibly breaks". The single unbounded free-text field
the orchestrator controls is the one whose specification is a dangling reference.
An orchestrator that writes its full diagnosis into `brief` passes both
enforcement layers and has changed nothing except the file it writes into — which
is precisely the failure A names in §9 ("a restriction that moves the work into
the charter"). §4 says the envelope carries "the user's own words verbatim", but
that is an instruction about content, and A's own opening sentence is *"Nothing in
this design is an instruction."*

**Channel 2 — `SendMessage`.** Explicitly preserved, explicitly unbounded, and
explicitly valued ("34 turns / $11.17 — small and load-bearing"). Free text to a
live lane is a full reasoning channel. It is also the *right* thing to keep (§5
below) — but it is a hole in the enforcement claim, unacknowledged.

**Channel 3 — `Publish` prose.** Capped at "one or two sentences" as a stated
property. The mechanism named (a `Stop` hook) is scoped to prose *outside*
`Publish`. The cap inside `Publish` has no enforcement described.

**The one-hop escape defeats A's own defence-in-depth example.** A writes:
*"an agent that can edit `settings.json` can re-grant itself tools. It cannot,
because `Write` is denied and `Bash` is denied."* The orchestrator retains
`Dispatch`, and `Dispatch` has no constraint on the tool surface of the lane it
launches. A dispatch whose brief says "edit `~/.claude/settings.json`" runs a
lane that has `Write` and `Bash`. `paths[]` is a *declared write claim used for
concurrency locking*, not a sandbox — A says so. So the exact scenario A raises to
justify two layers is reachable in one call through the layer that is supposed to
survive. **B closes this correctly and deliberately** — separate binary, separate
service identity, "the orchestrator credential cannot be upgraded into either",
"reject arbitrary dispatch prompts at the workflow API", "no arbitrary prompt
construction". On enforcement, B is right and A is not.

**And A's one novel tool is unbuilt.** `Records` — "validated JSON, capped at 2k
tokens, never file bytes, never source" — carries the whole load of A's answer to
"what is the status of X?", which A calls the obvious attack and rates as its
highest residual risk after E1. Nothing in `disallowedTools` or a `PreToolUse`
hook can cap a tool *result*; that requires writing the tool. So A's tool surface
is not the config change A's §3.4 framing ("mostly subtraction") implies: two of
five tools (`Records`, `Publish`) do not exist, and the `paths[]` overlap lock is
new scheduler behaviour.

---

## 4. Is the residue small? No — and it is the same defect one level up

Both designs admit a residue and both characterise it as narrow. A: *"a suite
that is genuinely green and tests the wrong thing."* B: *"specification
incompleteness and oracle error."* Both are describing the *oracle* problem. Both
omit the larger one.

**The lane selects its own exam.** Under A, `checks[]` is authored by the lane.
Re-execution proves the checks the lane chose to be graded on and nothing else. A
lane that knows its fix is fragile at boundary X and declares no check for X
produces a record that re-executes green at head, red at base, and derives
`status: done` — mechanically, with no model in the loop and nothing to read
sceptically. **That is strictly worse than today**, because today the same
omission produces a prose report that a human sometimes doubts, whereas under A
it produces a machine-derived verdict wearing the authority of execution. This is
`counterfactual`'s highest-priority class — *false proof: anything that can make
the record claim work was verified when it was not* — created by the mechanism
built to close it.

The same hole runs through A's other lane-declared fields:

- `openItems[]` is "REQUIRED and non-nullable — 'none' must be said explicitly".
  Requiring the word "none" is a syntax check on an unmeasurable assertion. A
  hangs the largest claimed saving on it (`counterfactual`'s Gate 1, "largest
  single saving with no quality cost") — that saving is real, but it comes from
  the *discipline*, and the record makes the omission syntactically detectable,
  not semantically checkable.
- `defectClass` is lane-declared and drives A's best-evidenced item ("two
  same-class verdicts → an `arch` dispatch"). A lane that would rather not trigger
  an architecture escalation declares a different class. A presents this as making
  the rule mechanical; it makes it *automated*, over a field with an interest
  attached.
- `hypothesis.outcome` likewise.

**B's Part 3 objection #3 states this precisely and I endorse it without
reservation.** *"The attestation makes claim status unforgeable while leaving
claim coverage forgeable… the completeness of the claim set is a fact declared by
the party with an interest in it."* It is the sharpest paragraph in either
document, it applies equally to A, and neither design's experiments can find it —
B says so of its own Experiment 3; A's E5 pre-registers the same blindness.

**How large is this residue, empirically?** `defect-origin` §5 lets us bound it
by class. Of 119 defects: class 5 presentation (12, 10%) is *"found overwhelmingly
by the user or by an unbiased visual reviewer, essentially never by a functional
test"* — re-execution catches ≈0. Class 2 client/session re-scoping (18, 15%) is
browser-state, largely user-found. Class 1a liveness (35, 29%) is timing and
process-lifetime — a race is a timing, not a shape, and a complete fixture cannot
prove it. Class 3 environment drift (12, 10%) is partly what clean rooms are for
and partly not. **Roughly half this board's actual defect stream is in classes a
lane-authored `checks[]` re-run twice does not reach.** Both designs assert the
residue is small; the board's own classification suggests it is not; neither
measures it. The honest position is that the residue is unknown and probably
large, and that is a finding, not a quibble.

**Additional, and specific to A: the grader A proposes to flip fail-closed has a
recorded defect whose enforce-mode failure is blocking correct work.** A calls
this *"the single cheapest structural change on the table."*
`scripts/hooks/response-format-gate.mjs` is the file, and `BUG-118` is on the
board: *"A hand-started session in an unrelated project was told its reply broke
this project's reply-format rules."* It fired on sessions the launcher never
started — in **advisory** mode, where the cost was noise. Fail-closed, the same
provenance defect blocks. This is a turn-end hook grading a reply, and this repo
has already produced the general case: a turn-end hook that graded a
still-being-written transcript and blocked correct replies, having survived 32
builder tests, 63 adversarial tests and an independent 52/52 pass, every one of
them built from the final state. "Cheapest" is true of the diff and not of the
risk.

---

## 5. B forbids free text — trace what that costs

B's Part 3 §5 says the gateway is "the best mechanism in the document and is
priced at zero." Correct, and understated: the cost is not only unstated, it is a
capability regression.

**B's tool surface has no course-correct channel.** Seven RPCs:
`submit_request`, `wait_terminal`, `relay_result`, `relay_decision_request`,
`submit_decision`, `cancel_workflow`, `get_public_status`. There is **no
`SendMessage` equivalent** — no way to steer a running lane. The only mid-flight
control is `cancel_workflow`, which is all-or-nothing and available *"only after
an explicit user cancellation request."* Today a mid-flight correction costs one
message (34 turns, $11.17, which A calls load-bearing and keeps). Under B it
costs cancel → re-submit → re-frame → re-dispatch: a full workflow restart, three
dispatch overheads, and the loss of everything the lane had established.

**The user asked for silence from the assistant, not silence from themselves.**
Requirement 3 is *"the next message I see is when the work is COMPLETED."* B
converts that into *"the conversational gateway accepts only"* four message
classes during an active workflow. Trace the two cases the brief names:

- *User asks something mid-flight* ("why is this taking so long", "did you
  consider X"). Best case: a schema-derived status line — `state`, `started_at`,
  `last_heartbeat_at`. The "did you consider X" is unanswerable and, worse,
  *unroutable*: it is not a status query, not a decision response, and not a new
  request. B's failure mode 10 defers the boundary to *"a narrow class the gateway
  must define mechanically"* and never defines it. The undefined class is where
  most real conversation lives.
- *A lane needs a decision.* This one B handles well — `relay_decision_request`
  with mutually exclusive options, consequences, and the exact reason automation
  cannot choose, and the orchestrator may relay but not invent an option. That is
  better than today. But it only fires when the *lane* recognises the need. There
  is no path for the *user* to inject a constraint the lane did not ask about.

**Is the interaction shape one a person would accept?** For a workflow that goes
right, yes — and it is what was asked for. For a workflow going wrong, no: the
cheapest intervention in the current system (one sentence to a live lane, which
this repo's own measurements show is used 34 times in a window) becomes
unavailable, and the user watches a `running` status for minutes with no
affordance except cancel. **This is a failure mode B creates that we do not
currently have.** The fix is small and B does not include it: allow one typed
`steer(workflow_id, user_text)` that passes the user's words through verbatim to
the live lane — pass-through, not model-authored, so it does not reopen the
inline-reasoning channel the gateway exists to close.

---

## 6. B's four objections, judged

**#2 — no v0, and the project cannot afford a v1. FATAL, and correct.** B
specifies a workflow service, a capability gateway, a separate orchestrator
binary with its own credential and OS sandbox, signed/MAC'd attestations with
environment fingerprints, a schema-validating ingester with automatic protocol
repair, and INDEX as an event projection. `defect-origin` §1 measures the
landing zone: 97,952 lines of `scripts/` against 54,421 of product, 183 verify
scripts, 90 named after one ticket, 202 npm scripts. `defect-origin` §6
intervention 6 — *a new checker* — is the one intervention it **explicitly does
not recommend**, on the grounds that it is *"intervention #1 paid for in the
currency of problem #2."* **Both designs' central mechanism is that intervention.**
A does not notice at all; B notices in Part 3 and its own §7 says "do not build a
universal proof system" two sections after specifying a signing trusted execution
service. The tension is real and unresolved. The proposed v0 (one tool, the
dispatch RPC, enforceable today) is the right answer and §8 below builds on it.

One correction *to* the objection: it under-credits how much of B's §3 is already
shipped. `scripts/board.mjs gen` already regenerates `docs/bugs/INDEX.md` from
the ticket files, and `board:check` already fails on drift (`package.json:176-177`).
B's *"`INDEX.md` should become a generated projection… must no longer be manually
owned by an LLM orchestrator"* is ~80% built; what remains hand-owned is the
narrative Open-row prose and preserved columns. B, having never seen this
project, proposes existing machinery as new work, and Part 3 does not catch it.

**#3 — the false-green moves into an enum. HOLDS, and is the strongest objection
in either document.** §4 above. It is fatal to the "residue is small" claim in
*both* designs, not just B's, and both designs' experiments are explicitly
blind to it.

**#4 — three dispatches where there was one. HOLDS, with a number.** §2 above:
~$1,064 for framing lanes on half the window's dispatches, against a maximum
total saving of $1,624. The objection is right that the entire bet rests on the
persistent context disappearing. It is right that the crossover does not support
it. And it is right to credit Experiment 8 for being able to come out against the
design — which is more than any of A's six can do on cost.

**#5 — the gateway priced at zero. HOLDS, and is understated.** §5 above: it is
not just an unpriced affordance, it is the removal of the mid-flight steering
channel, with no replacement in the tool surface.

**#6 — nobody answers "have we tried this before". HOLDS, and is badly
understated. This is the most valuable thing either design deletes.** The
objection frames it as orchestrator memory. It is more than that: it is the
recurrence detector. `defect-origin` §3 measures 34 of 119 defects (29%) carrying
an explicit recurrence link, names six recurrence chains, and concludes *"the
recurrence rate is high because the detector is on."* `ARCH-009` exists *"because
a fix lane refused to write a fourth guard."* Eight of the nine ARCH tickets are
instances of one sentence, and that observation is what produced **ARCH-010** —
which `board-impact-ordering` §4 ranks first on the board by a factor of two.

Some of that detection lives in the lanes and survives. The cross-ticket, cross-week
half — "this is the same shape as BUG-104, which was the same shape as
BUG-120" — lives in the long orchestrator context and in reading the board, and
both designs delete both. **A's `Records` does not cover it**: a 2k-token
schema-bounded structured query cannot perform prose-similarity recognition over
199 tickets, and A never says where recurrence detection goes. Neither design
mentions the class at all. Any v0 must keep a path to it — the cheapest being a
periodic recurrence-sweep lane that reads the board and files ARCH tickets,
which is a lane, not a controller capability.

**#1 — the endorsement.** Mostly right, with one overreach: *"the tier answer
follows from the tool surface rather than being asserted, which is why it
convinces."* True as logic — and the tool surface it follows from does not exist
and is not buildable this quarter. A conclusion validly derived from an
unbuildable premise is not yet a finding about what to do.

---

## 7. The fourteen experiments: which would actually falsify

Graded on three questions. Does it produce a number? Is the ground truth
independent of the thing being tested? Can the pre-registered failure actually
fire?

### Real, gradeable, and cheap — four of fourteen

- **A-E1, the blindfold log.** Best experiment in either document. One
  `settings.json` entry in log-only mode; the `PreToolUse` array already exists.
  The log *is* the finding, it enumerates the capability surface empirically
  rather than by imagination, and the falsifier (a fourth bucket, or >20% genuine
  source investigation) is stated. Two caveats worth stating: the bucket
  classification is a judgement made by an interested party, so it should be
  labelled by someone who did not write the design; and it records what the
  orchestrator *did* under today's incentives, not what it would need under the
  new ones.
- **A-E4, record fillability.** Hand-fill the record for ten closed tickets from
  existing reports and count unfillable fields. One read-only lane, real number,
  cheap. **But its kill condition is set where it cannot fire.** A predicts
  `expectAtBase` and `base` fill from ≤4 of 10, and declares the experiment
  falsified only *"if `checks` cannot be reconstructed at all."* A's §10 says the
  opposite — *"if E4 shows lanes cannot fill `checks[]` with an executable base,
  §3's mechanical verdict is fiction."* §8 and §10 disagree about what E4's
  failure means, and §8's version pre-declares the bad outcome as a pass. Fix:
  adopt §10's bar — <7 of 10 with an executable, non-`HEAD` base kills §3.
- **B-1, blind-router replay.** Strictly better than A's E3 (see below): 100
  messages instead of 20, ground truth is *human-labelled conservative route*
  rather than what the old system did, and the metrics are safety-asymmetric
  (unsafe under-route separated from unnecessary exploration, with a 2% kill).
  This is how the tier question should be tested.
- **B-8, cost replay.** The **only** experiment in fourteen that measures cost,
  and it uses `scripts/lib/cost-model.mjs`, which exists and is proved by
  `npm run verify:cost-collect`. Specific kill condition. **Note that none of
  A's six measure A's own headline saving.** E1 counts blocked calls, E2 counts
  rendered turns, E3 routing accuracy, E4 field fillability, E5 detection yield,
  E6 rounds-to-HOLDS. The 10× and the 5× are asserted and never put at risk.

### Real, but the artifact must exist first

- **B-4, stale-subject injection** (30 synthetic envelopes, "rejects 30 of 30,
  any false acceptance kills"). Genuinely well-specified and the right test of an
  ingester — once an ingester exists.
- **B-5, malformed-lane recovery.** Same shape; needs the schema and the repair
  path.
- **B-3, historical false-green challenge** and **A-E5**, its twin. Both need the
  attestation/re-executor prototype and the reconstruction of seven historical
  revisions. Both honestly pre-register that they cannot catch the wrong-target
  class. A's E5 has the weaker kill: *"falsified if the re-executor also scores
  near zero"* — a bar so low that a re-executor catching 1 of 7 passes.
- **B-7, interaction-shape audit.** Needs the gateway.
- **B-2, no-free-text relay.** Well-specified kill conditions, but requires 50
  replays plus blinded human evaluation, and the document never says who the
  evaluators are. In a single-user project the only available evaluator is the
  user, who is not blind to the design.
- **B-6, framing-contamination replay.** Real design, and its fallback if killed
  (split observation collection from hypothesis formation into two machine
  stages) is a genuine alternative. Expensive: 30 historical tasks, blind
  scoring, and one arm that cannot be re-run.

### Broken oracle — two

- **A-E3, tier replay.** *"Grade against what happened."* The ground truth is the
  Opus orchestrator's own choices — which this design argues were systematically
  wrong (it dispatched inline work, it wrote contaminating charters, it is the
  actor being replaced). A cheap model that disagrees with a defective baseline
  scores as an error. The experiment measures agreement-with-the-thing-we-are-
  replacing. Replace it with B-1.
- **A-E5**, as above: one arm re-measures a known result (the reader will score
  0/7 again — that is not new information), and the other arm's kill condition
  cannot fire.

### Theatre — two

- **A-E2, the mute test.** Measures rendering, not requests, so it cannot speak
  to the cost claim it is attached to; the level-1 change A calls "free" is free
  in both senses — it costs nothing to build and saves nothing. Its outcome
  measure is *"count how many times the user had to intervene because something
  was hidden"* with n=1, no threshold, and an unblinded subject. Its failure mode
  is "the user reports losing track" → "we conclude it needs a passive progress
  surface", which is the exact shape the brief warns about.
- **A-E6, charter provenance A/B.** Six tickets, two arms, three per arm, on
  rounds-to-HOLDS — a metric whose measured distribution is *"the median ticket
  is one-and-done"* (108 of 199 are fix+verify). Both arms will almost certainly
  read 1. It cannot distinguish anything, and the arms cannot be run on the same
  ticket, so it is not even a paired design.

**Tally: 4 real and cheap, 6 real but blocked on a build, 2 with broken oracles,
2 theatre.**

---

## 8. What each design creates that we do not currently have

The brief asks for this specifically. Summarised, with the ones already argued
above cross-referenced.

**A creates:**

1. **A machine-blessed false green.** §4. A lane-selected `checks[]` that
   re-executes correctly produces a derived verdict with the authority of
   execution and no reader in the loop. Today the same omission produces prose
   someone might doubt.
2. **A fail-closed turn-end grader with a recorded provenance defect.** §4,
   BUG-118. Enforce-mode failure blocks correct work.
3. **A lane-fleet serialisation lock, priced at zero.** `Dispatch` requires
   declared `paths[]` and *"the harness refuses an overlapping concurrent
   dispatch."* On a repo whose hottest file is `public/app.js` (28 defects) and
   where the board files are touched by nearly every lane, this is a global lock
   on the busiest paths. `inline-vs-dispatch`'s caveats note that 476 lanes ran
   *"with heavy concurrency"* and that the benefit is *additional* to the cost
   findings. A converts a judgement into a lock and charges nothing for the queue.

**B creates:**

4. **Loss of mid-flight steering.** §5. No `SendMessage` equivalent; cancel is
   the only control.
5. **A user who cannot ask a question.** §5. The gateway mutes the conversation,
   not just the narration, and the exempt class is never defined.
6. **A new blocking-wait primitive in the highest-defect class this board has.**
   `wait_terminal` is *"a blocking/event-driven wait owned by a service that
   outlives the model turn"* — which is to say, a fresh implementation of "is this
   thing still alive and who owns it". That is class 1a: 35 defects, 29%, the
   seven-ticket chain BUG-037 → BUG-041 → BUG-068 → BUG-096 → ARCH-003 → BUG-105
   → BUG-113, and `ARCH-001`'s own sentence. `verification-ergonomics` §2 measures
   the current state: *"75 of 75 lanes polled for a log; 47 detached with
   `nohup`/`setsid`… the harness offers no supported way to run a thing that takes
   twenty minutes."* B builds the missing primitive in the subsystem where this
   project's defects concentrate. **A is materially better here** — its §5 note on
   WA §I / BUG-046 correctly uses background subagents that outlive the turn and
   wake by notification, which is the mechanism that already works.
7. **A hard availability dependency with no fallback**, asserted as a virtue
   ("visible unavailability is safer than quietly violating the architecture").
   For a single-user local tool, workflow-service down = no work possible.

**Both create:**

8. **Deletion of the cross-ticket recurrence detector.** §6, objection #6. The
   thing that produced 8 of 9 ARCH tickets, ARCH-010, and the board's current
   #1 item. Unpriced and unmentioned in A; noticed but under-weighted in B.
9. **Net new harness mass** in a project where harness defects are 55% of the
   current defect stream and where `defect-origin` §6 ranked and rejected exactly
   this intervention.

---

## 9. Can either be tested cheaply this week without building a new system?

**Straight answer: neither design can be *built* this week. Both can be
*partially tested*, and the useful subset is small, specific, and shippable.**

**Not buildable:**

- **B, in full: no.** Separate binary, service identity, OS sandbox, capability
  token, workflow engine, signing attestation runner, ingester with protocol
  repair. This is a subsystem, not a week. B's Part 3 §2 says so and is right.
- **A, in full: no, and less "mostly subtraction" than it claims.** Two of five
  tools do not exist (`Records`, `Publish`), the `paths[]` overlap lock is new
  scheduler behaviour, the §3 record grader is a rewrite of the 701-line
  response-format-gate into a fail-closed executor, and the re-executor needs the
  independent clean-room pass A itself flags.

**Buildable and testable this week — the v0 both designs converge on:**

1. **An orchestrator session profile with a reduced tool surface.** `Dispatch`,
   `SendMessage`, `TaskStop`, nothing else; `Read`/`Write`/`Edit`/`Glob`/`Grep`/
   `Bash`/`WebFetch`/`WebSearch`/`Skill`/MCP denied. This is a `registry.ts`
   entry — `permissionMode` / `allowedTools[]` / `disallowedTools[]` already exist
   at lines 191-193. It is B's Part 3 §2 recommendation and A's §2 minus the two
   unbuilt tools. **It tests the whole hypothesis, and it is an afternoon.**
2. **A-E1 first, in log-only mode, before the deny.** One `PreToolUse` entry
   alongside the existing one. Run one working session. Read the log. This tells
   you what step 1 will break *before* it breaks it, and it is the highest
   information-per-dollar item in either document. Have someone other than the
   design's author bucket the calls.
3. **A-E4, with §10's kill bar, not §8's.** One read-only lane over ten closed
   tickets. If fewer than seven can produce an executable non-`HEAD` base, A's §3
   is fiction and both designs' verdict mechanism has no foundation — which is
   worth knowing before anything else is written.
4. **B-8, the cost replay.** `scripts/lib/cost-model.mjs` exists and is proved by
   62 assertions. This is the only way anyone learns whether the savings are
   1.6×, 3×, or negative. Given §2 above, run it before either design's cost
   claim is repeated.

**Explicitly not this week:** A's §3 record contract, A's re-executor, `Records`,
the `paths[]` lock, B's anything.

**One thing that should be tested and neither design proposes:** how many user
messages are conversational versus work requests. A names it as its highest
residual risk after E1 and has not measured it; it is countable from the
transcript in an hour, and it decides whether a no-read orchestrator is usable
at all.

**And one item that should be unbundled from both:** `verification-ergonomics`
Option B — split `--setup` from `--fixer-test`, make the clean room a clone
rather than a stripped tarball. A's §3.2 table claims four of its seven
mechanical wins (the trailing `#`, setup-smuggled-as-evidence, hand-rolled
synthetic base, room-is-not-a-repo) as consequences of its record. Those wins
belong to the harness change, are net-subtractive, close a **live** false-proof
hole, and are available **without either design**. Attributing them to the
orchestrator redesign inflates its value; landing them independently is the
cheapest real safety improvement on the table.

---

## 10. What this review could not settle

- **Whether the corrected collector changes the 58.6%, and in which direction.**
  §1(a) argues it sits outside `COST-METHOD`'s uniformity exemption; it does not
  compute the corrected value. `npm run cost:collect` over that window would.
- **The true whole-session mean context**, and therefore the exact structural
  saving. §2's 1.60–1.72× window bound is robust (it holds even at orchestrator
  cost zero); the "10× vs 3×" question on the orchestrator line depends on a
  compaction policy A does not state.
- **The size of the coverage residue.** §4 bounds it by defect class and argues
  it is large. Nobody has re-graded the corpus against a hypothetical `checks[]`.
- **Whether `Records` can carry the conversational load.** Unmeasured by A,
  unmeasured here, and the mix is countable.
- **Whether the recurrence detector's cross-ticket half is truly orchestrator-
  resident** or mostly lane-resident and therefore survives. §6 argues it is
  partly each; the split is not measured.
- **Every figure inherited from `pipeline-cost-2026-08-19.md` and
  `pipeline-cost-2026-08-20.md`** carries their superseded status. Lane-vs-lane
  ratios treated as usable; activity-class cost shares are not (§1(a)).

---

## 11. Cost of this analysis

One agent, one context. **No sub-agents dispatched, no lanes launched, no
pipelines re-run, no suites executed, no prototypes built, no product code
touched.** Nineteen tool calls: eight document reads (both designs, `COST-METHOD`,
`inline-vs-dispatch`, `defect-origin`, `verification-ergonomics`,
`spend-plan-review`, and two slices of `pipeline-cost`), eight shell invocations
(the orchestrator turn table, the window totals, the orientation decomposition,
`registry.ts`'s permission fields, `response-format-gate.mjs`'s line count and
advisory path, the `PreToolUse` entry, `board.mjs`'s INDEX generation, the npm
script registry), one ticket read (`BUG-118`), one skill invocation for current
model pricing rather than quoting it from memory, and this write. This document
is the only repository change.
