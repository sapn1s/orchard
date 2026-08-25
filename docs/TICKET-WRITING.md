# How to write a ticket field

The schema says *which* fields exist and how long they may be. This says **how
to write them**. A 60-word summary can be written in exactly the register that
made the old board unreadable, so the cap alone buys nothing.

Most examples below are **real**: those "bad" lines are verbatim from
`docs/bugs/*.md` and those "good" lines come from the prototype rewrites and the
migrated tickets. A few pairs are **invented** — they are about a fictional
upload path, and they are invented so that a rule cannot be taught by handing
over the answer to a ticket the rules are measured against. Rules marked
**[checked]** are enforced by `scripts/lib/ticket-writing.mjs`; rules marked
**[judgement]** cannot be mechanised and are not pretended to be.

> **Calibration status — an improvement, not a finished instrument, and the
> instrument that measured it has a known limit.** These rules were tuned against
> a decision-shaped ticket, where they take Opus 5 to the quality of a
> hand-written target in every round, on two judges that demonstrably separate
> good from bad. Against FINISHED tickets — 127 of 183 here — the same comparison
> has **no stable answer**: three judge models, given the identical pair of
> rewrites, split 1–5, 5–1 and 3–3. What survives that disagreement is
> mechanical. Against a control given no guidelines at all, tickets written to
> these rules contradicted themselves in 0 of 6 cases against the control's 5 of
> 6, and stayed inside the word caps the control exceeded by up to 36 words. So:
> trust these rules for consistency and for fitting the schema. Do not read them
> as a proof that the result reads better, because on the majority shape nothing
> here can currently show that either way.
>
> **The extended tier has a narrower warrant still, and it is a specification,
> not a calibration.** Its rules come from a four-way reading of ONE
> decision-shaped ticket — the original, a hand-written rewrite, and the
> pipeline's output before and after these guidelines landed — by a reader who
> had not been told what to look for. That is n=1 for the judgement half. What
> generalises is that each rule reproduces on the other migrated tickets and none
> of them fires on the hand-written corpus; what does not yet generalise is the
> claim that these are the *most important* four things a rewrite loses.

## The one rule the others follow from

**Two layers, two readers.** The JSON block is written for a person deciding
what to do next, who has not read the code. The Markdown body below it is
written for the agent that will do the work. Anything that needs a symbol name,
a call site, a sha or a stack trace belongs in the body. Nothing is deleted by
moving it down.

---

## `title` — what a person sees in a list of 190

- ≤ 12 words. **One clause**, sentence case, the *symptom or outcome*. **[checked]**
- No symbol, path, filename, flag, sha, SHOUTED word or `BUG-nnn` reference. **[checked]**
- No comma-plus-conjunction, no `: `, no parentheses, no quotes — each of those
  is a second sentence hiding in the title. **[checked]**
- Not a proposal: no `+`, `→`, `(not …`. **[checked, in `validateTicket`]**

> **bad** `a running session never sees an edited instruction doc, so the longest-lived session is the most stale` (17 words: mechanism, then a `so`-clause of consequence)
> **good** `Running sessions keep outdated project instructions` (6)

> **bad** `FEAT-070 regression: recent sessions bypass the ≤6 cap (full list shows), + no collapse-back after "N more"`
> **good** `Recent sessions overflow the collapsed sidebar limit`

The ticket id, the regression provenance, the second defect and the quoted UI
string all still exist — in `related`, in `recurrence_evidence`, in the body.

**The title names the outcome, never the mechanism.** This is the single rule
most often broken, because the writer has just finished reading the mechanism
and it is the most vivid thing in their head. Ask: *would this sentence mean
anything to someone who has never opened the file?* Words like "sweep",
"parent lane", "globally readable" or "paint surface" pass the identifier
check — they are ordinary English — and still fail this one, because they name
internal machinery rather than anything a person sees or wants. Name the
outcome: what went wrong for someone, or, for a piece of work whose whole point
is to prevent something, what will be true when it is done. **[judgement]**

> **bad** `turn-end sweep fabricates a death for the child lanes of a background agent` — every noun is internal machinery.
> **good** `Background work is reported as dead while it is still running`

A title stops being about the code when you could read it aloud to a user of
the product and they would nod.

## `summary` — ≤ 60 words

- **Consequence first, mechanism second.** Sentence one says what someone
  observes; sentence two may say why. **[judgement]**
- **Say what now exists, not only what went wrong.** If the work is largely
  built, a summary that describes only the old symptom leaves the reader unable
  to tell finished work from open work — the single most common way a
  well-written rewrite becomes useless. Spend the words on both halves: what
  people hit, and what is in place now. **[judgement]**
- **A gap that was deliberately not built is part of the summary**, not a
  footnote. A reader cannot weigh a gap they cannot see, and it is the fact
  most often lost when a long ticket is cut to 60 words. **[judgement]**
- Project-general language: assume the reader knows the product, not the
  subsystem. No symbols. **[checked, no-identifier]**
- No sentence over 40 words. **[checked]** — but 40 is the point at which a
  sentence is *rejected*, not the length to aim for. **Aim at 15–20 words and
  treat 25 as the ceiling.** A 35-word sentence passes every check in this repo
  and still has to be read twice, and nothing but the writer will catch it.
  **[judgement]**

> **bad** `isAttentionSession(sess) (app.js) returns true for ANY session whose lastActivityAt is newer than 24h ago (baseline Date.now() - 24h when unseen). FEAT-070's isAlwaysVisible forces those in "without spending the cap budget" — so every session active in the last 24h bypasses the ≤6 cap.` — four symbol names before the reader learns anything is wrong.
> **good** `Projects with many sessions active in the last 24 hours showed the full list instead of at most six. Expanding through the "N more" control also left no way to collapse the list again without reloading.`

The register rules above are about *how* the sentences read. They do not
license dropping a fact a decider needs. Cutting a 200-line ticket to 60 words
means cutting the mechanism, the history and the names — never cutting what was
built, what is left, or what it costs.

Same facts, order reversed: the observation leads, the 24-hour window survives
because it is the *condition the user reproduces under*, and `isAttentionSession`
moves to `## Diagnosis` where the fixer needs it.

## Finished work: the shape most of the board is in

Most tickets here are not open questions. They are work that shipped, written up
at length, sometimes with a piece deliberately left undone. That shape has its
own failure, and it is not verbosity — it is a rewrite so even-handed that a
reader cannot tell finished work from open work. **[judgement]**

**Lead with what is in place now.** Not the symptom it replaced, and not the
leftover. A reader who gets three sentences of the old fault before learning it
was fixed has been misled about the state of the ticket for three sentences.

**Name the evidence, in the same breath as the claim.** "Verified" on its own is
the same empty sentence as "no further action is recorded" — it asserts the
conclusion and withholds what produced it. A suite that failed before the fix and
passes now, a tally, a run in a real browser: whichever it was, name it. A
decider is deciding partly about *how much to trust the done part*, and cannot do
that from an adjective.

**Give the leftover the space it deserves, and no more.** A gap that is one
paragraph of a long ticket does not become the ticket's subject just because it
is the only thing still open. Write the built work first, state the gap in a
clause, and let `current_need` carry the choice. Structuring the whole rewrite
around a small residual is the mirror image of writing "nothing is outstanding"
over it: the first hides the gap, the second hides the work.

> **bad** `A reconnecting session can be told a model that is one turn out of date. Decide whether to send the last model seen or accept the lag.` — an accurate rewrite of the one open corner of a ticket whose feature shipped and was verified; a reader cannot tell anything was built.
> **good** `The indicator now names the running model and flags a change the user did not choose, verified end to end in a browser. A session that reconnects can still show a model one turn out of date.`

**Last pass: read the fields together and check they agree.** Each field is
written alone, and a set of individually true fields can still contradict each
other. A reader hits the contradiction immediately and stops trusting all of it.
The three that actually occur: **[judgement]**

- an impact that says nothing is at risk, beside a decision that is still open —
  if nothing is at risk, say what the choice is *for*, or drop the decision;
- success criteria listing things the ticket already reports as done — those are
  the evidence that closed it, and they belong in the summary as evidence, not
  in a list of what must still become true;
- a summary claiming complete coverage beside a gap named two lines later.

## `impact_if_we_wait` — ≤ 50 words

- Say the harm **and its bound**. A ticket without a bound reads as an
  emergency, and a board of emergencies has no priorities. **[judgement]**
- The bound is a clause, not a hedge: name what is *not* affected.

> **good** `This weakens confidence in independent verification. The exposure is passive, and there is no evidence that past verifiers read it or that past verdicts are invalid.`
> **good** `Bounded: this affects instruction freshness and display-correctness, not user data, and cycling the session or supplying the changed document remains a cheap workaround.`

## `current_need` — ≤ 40 words

One sentence naming the **next act**, in the imperative, addressed to whoever
must perform it. Not a status, not a re-summary of the problem. **[judgement]**

**First settle whether anything is actually left, and settle it from the
original, not from the mood of the original.** A ticket that reports a shipped
fix at length still has something outstanding if its own text names a piece
that was not built, a question nobody answered, or a choice deferred to a
person. Read the end of the original — the handoff, the still-open note, the
"what is left" line — before you write this field or choose `human_action`.
**[judgement]**

- Anything the original leaves **needed and unsettled** is outstanding.
  `human_action` is then `decide` (a person must choose) or `act` (a person must
  do a specific thing), and `current_need` names it. This settles *whether* there
  is a loose end; it does not make the loose end the ticket's subject — see
  "Finished work" above for how much of the rewrite it gets.
- **An idea the original merely offers is not a decision.** "We could also …",
  "a possible extension", "worth considering later" — these are notes. Promoting
  one into a question makes a person process work nobody asked for, and it is
  just as much a misreport of the ticket's state as writing "nothing is
  outstanding" over a real handoff. The test is not whether something is
  *unbuilt*; almost everything is. It is whether the original presents it as
  **wanted and unanswered**. If it does not, `human_action` is `none` or
  `review`, and the idea lives in one clause of the summary.
- `human_action: none` and "nothing is outstanding" are for a ticket whose own
  record leaves **nothing**: no unbuilt piece, no unanswered question, no
  pending choice. Say what closed it and name the evidence.
- Length is not the signal. A long, mostly-satisfied ticket that ends with two
  unbuilt states is a ticket with a decision in it, and writing "nothing is
  outstanding" over the top of that is the most expensive mistake available in
  this document: the decision stops being visible to anyone.
- The opposite failure is real too — do not invent a decision from a finished
  ticket in order to have one. The test is whether the original names the
  loose end, not whether one can be imagined.

> **bad** `Nothing is outstanding. The work shipped and the suite passes.` — written over an original whose last section lists two states that were deliberately not built.
> **good** `Decide whether to build the two remaining states or close the ticket as it stands.`

> **good** `Restart the service on :4317 so the verified fix becomes live.`
> **good** `Decide whether to document the existing workaround or approve a per-turn amendment channel, after confirming how resumed sessions receive instructions.`
> **bad shape** "This is blocked pending review." — names no act and no actor.

**Nothing else goes in this field.** It is the one field a reader is guaranteed
to read, and it is the field most often used as a second summary. Three shapes
are checked, and each of them is good content in the wrong place, not bad
content:

- **no pass tally.** **[checked: `N1`]** `Choose the first-stage approach;
  verify:decision-shape ran 25/25 successfully and confirmed the decision
  record's structure, not the display-state design.` — the first four words are
  the whole of what belongs here. The caveat is true, it is worth saying, and it
  already appears in `## Evidence`. Naming the proof *in words* is allowed and
  often required: `Treat the ticket as closed: the pre-fix case failed, the
  corrected behaviour passed, and standing checks stayed clean.` passes.
- **no suite or command name.** **[checked: `N2`]** The person reading this
  field is not the person who runs the suite. A port is different and stays:
  they will type `:4317`.
- **no status report where an act belongs.** **[checked: `N3`]** `No further
  action is currently recorded; the fix is marked verified.` names no act, no
  actor and no evidence — it states the absence of a record where a record
  exists.

## `area` — ≤ 6 words

A place a person can name (`Session sidebar`, `Session instruction freshness`),
not a path list. Paths go to `code_refs`. **[judgement]**

> **bad** `bridge (session construction + per-turn seam) / templates (instruction composition) / methodology docs`
> **good** `Session instruction freshness`

---

## Before you finish: find your longest sentence and split it

Do this last, on every human-layer field including every option field. Find the
longest sentence you wrote and count its words. **Over 25, split it or cut it —
there are no exceptions worth making.** Two 14-word sentences say the same
thing and cost the reader less than one 28-word sentence, every time.
**[judgement]**

The three shapes that produce an over-long sentence, and what to do with each:

- a subordinate clause explaining the clause before it (`…, which means …`,
  `…, so that …`) → make it its own sentence, or delete it if the reader
  already knows;
- two facts joined by an em dash or a semicolon → two sentences, or two fields;
- a qualifier defending the sentence against an objection nobody raised
  (`…, at least in the common case`, `…, though this is not the whole story`) →
  delete it.

## One field, one fact — let the schema do the work the punctuation was doing

The schema already has a field for what changes, a field for the gain, a field
for the price and a field for the catch. Prose that carries those distinctions
inline is re-implementing the schema inside a paragraph, and the reader pays
for it twice: once to parse the sentence, once to work out which part answered
which question. **[judgement]**

- Never write an inline label — `Cost:`, `Gives:`, `Gives up:`, `Risk:`,
  `Trade-off:` — inside a field. If you reach for one, the sentence after it
  belongs in another field.
- Never fuse two facts with an em dash or a semicolon to save a field. One
  sentence carries one fact.
- Each field is read on its own. Do not start a field with `It also …`, `This
  means …` or `That said …`; the reader may not have read the previous field,
  and often has not.

> **bad** (one option, one paragraph) `Have the uploader write to a staging area first and promote on success, so a half-written file is never visible to a reader; the promote step is atomic and cheap. Cost: every one of the ~30 call sites that writes directly must be moved — in the module that is already the slowest part of an import. Gives: torn reads become impossible. Risk: a caller that relied on seeing the partial file breaks silently, and that is the thing to design the rollout around.`
> **good** the same content, split: label → `Stage uploads before publishing`; what_changes → `An upload is written to a holding area and made visible only once it is complete.`; benefit → `A reader can never see a half-written file.`; cost → `About 30 places that write directly would have to be moved first.`; why_not_obvious → `A caller that depends on seeing the partial file would break with no error.`

Nothing was cut. The em dashes, the semicolons and the inline labels were doing
a job the schema does better, so they left with the load they were carrying.

## Polarity: a column of costs is only worth reading if every cell is a cost

Four options are read as a **table**, down the columns, not as four paragraphs
compared from memory. That is the entire value of splitting an argument into
`what_changes` / `benefit` / `cost` / `why_not_obvious`, and one cell of the
wrong sign destroys it: the reader who is comparing costs meets a benefit,
stops, and goes back to reading paragraphs.

- **A `cost` may not contain a reassurance.** **[checked: `C1`]**
  > **bad** `The allowlist needs maintenance and no product behavior changes initially.` — the second half is a safety property, and it is sitting in the cost column.
  > **good** `The allowlist needs maintenance, and a value can still be laundered through a local variable.`

  A *negated benefit* is not a benefit and stays: `Each round has found roughly
  three more leaks and offers no convergence signal` is a cost throughout.

- **A `why_not_obvious` may not argue for the option.** **[checked: `C2`, `C3`]**
  > **bad** `This strongest guarantee carries the largest regression surface and slows near-term work.` — the superlative is the case *for* option 2, and `benefit` is where it was already made.
  > **bad** `It guards the class outside the language rather than eliminating it, but also supplies evidence needed to choose the structural design.` — everything after `but also` is a second field.
  > **good** `Misclassifying a lifecycle reader as display-only could silently change real session behaviour.`

- **A precondition field must state a precondition.** **[checked: `U1`]** For a
  staged decision, `unlocked_by` names *the thing that does not exist yet* and
  whose arrival is what makes the next stage answerable.
  > **bad** `The current evidence and known direct-read count.` — this means "nothing blocks this", phrased as if it were a blocker.
  > **good** `Option 3 classification counts for display, non-display, and unclear readers.`

- **A confirmation must say what was checked, not that everything is fine.**
  **[checked: `S1`]** `source.confirmation` is a claim about the document, made
  by the document, and `"dropped": []` beside it cannot be falsified from
  inside. Either name the comparison — what it was compared against, and how —
  or drop the field and let `source.sha256` and `source.bytes` carry the
  provenance, which they already do and which *is* falsifiable.
  > **bad** `The diagnosis, recurrence, four live options, recommendation, migration sequence, proof bar, bounds, falsifiers, and named leaking surfaces all survive in the fixed fields.`
  > **good** `Compared line by line against the archived original; the four options, the recommendation and the bounds are present.`

## What a decision loses first, and what none of these checks can see

These four are **[judgement]**. They are the things a rewrite drops while every
individual field still reads well, and three of them cannot be checked at all,
because no rule can see a fact that is not there. Worked example 3 carries all
four; read it as the demonstration.

1. **Standing damage is not the same as risk.** If something is wrong *right
   now*, deliberately, until this is decided, `impact_if_we_wait` says so. An
   impact written entirely in the conditional — "can misreport", "could show" —
   makes waiting read as free, and waiting is the option a reader takes by
   doing nothing.
   > **bad** `The dashboard can misreport what is running.`
   > **good** `Two scheduled imports are serving partial files today, left that way on purpose until this is decided.`

2. **Price the weak option; do not merely call it weak.** A rate the ticket
   measured is the difference between an option a reader dismisses and one they
   argue with. "Have not stopped new ones appearing" is an impression; "every
   review round so far has found one more" is a price. This is the one case
   where a number that is *not* needed to reproduce the bug still belongs in
   the human layer — see the numbers rule above, and its boundary below.

3. **A weak option is often conditionally right, and the condition has exactly
   one home.** `prerequisite` is that home. Softening the condition into a hedge
   inside `why_not_obvious` loses it twice over: the reader cannot see what
   would settle it, and the field that states the catch now states an argument.
   `prerequisite: null` is a claim — *no fact has to be established first* — and
   it is wrong far more often than it is written.
   > **bad** `It may be defensible under an imminent replacement plan; otherwise repeated verification makes it the costliest path.` (in `why_not_obvious`)
   > **good** `Establish whether the scheduler is being replaced anyway. If it is, leaving it alone stops being a shortcut and becomes correct.` (in `prerequisite`)

   Half of this is checked: a conditional phrase (`only if`, `unless`,
   `defensible`, `depends on whether`) sitting in an option field while
   `prerequisite` is `null` means the condition is homeless. **[checked: `P1`]**
   The other half — a condition that was simply deleted — is invisible to every
   check here, and it is the commoner failure of the two. It is why the
   worked example carries a non-null `prerequisite`: three examples that all
   said `null` taught that `null` was the default.

4. **Reversibility is an argument, and it is usually left in the body.** If the
   recommended path lands in independently revertible steps and the alternatives
   do not, that is frequently the strongest thing that can be said for it, and
   `recommendation_reason` is where a decider will look for it. `Migration and
   rollback` is where it usually ends up instead, which is a section the decider
   does not read.

## The reader has not read the board, and will not go and read it

A ticket is read by someone who arrived at it cold. Anything that only makes
sense to a person who remembers the previous rounds is invisible to them.
**[judgement]**

- Describe a thing by **what it does**, not by what it is called and not by
  where it came from. An escape hatch is "an explicitly named way to reach the
  raw value", not `rawLiveUnscoped()`.
- Cut history-as-shorthand: "the refactor the last fix declined", "the
  remediation's own author", "the same conflation that produced the first
  bug". These carry a fact only to someone who was there. If the fact matters
  to the decision, state the fact; if it does not, it belongs in the body.
- Cut in-house vocabulary that reads as jargon to anyone else — "greppable",
  "the serialized single-file bottleneck", "surface", "lane". Say what they
  mean in ordinary words, or drop them.

**Two things this rule is not, both of which have been done to real tickets in
its name.** They are the difference between a rewrite a reader trusts and one
that is merely smooth. **[judgement]**

- **Generalise a NAME, never an INSTANCE.** Replacing what a function is called
  with what it does is the rule working. Replacing the actual case that trips
  the fault with the category it belongs to is the rule being misapplied, and it
  removes the one detail that let the reader picture the problem. "A safeguard
  refusal answered by a different model" becomes "a provider-side switch", and
  the reader no longer knows what event this is about. Keep the instance. It is
  usually the most concrete thing in the field and it is almost never the thing
  that should go.
- **Product words are not jargon.** If the user meets a word in the product —
  in a menu, a status line, a message, a document they were handed — it is the
  reader's own vocabulary and it stays, spelled the way the product spells it.
  Renaming a thing to something more everyday makes the ticket unsearchable and
  makes a reader who knows the product doubt the two are the same thing. Only
  words that live in the code get translated.

**Concision is not compression.** Dropping the fact that makes an option
expensive is not brevity, it is losing the argument. Drop everything that is
*not* that fact, and keep the fact — see the numbers rule below.

## Identifiers: when a symbol earns the human layer

A symbol belongs in the human layer only when **the reader must type it, click
it, or recognise it in their own environment**. `:4317` in a `current_need` that
says "restart the service" earns its place — the person will type it. A function
name never does: it identifies the defect to a fixer, and the fixer reads the
body.

The check therefore flags *code* identifiers (backticks, paths, file
extensions, `camelCase`, `snake_case`, `--flags`, `call()`, shas, SHOUTING,
`BUG-nnn`) and deliberately does not flag ports, versions or plain numbers.

## Numbers: load-bearing or decoration

Keep a number in the human layer only if **changing it would change the
decision or the reproduction**. Everything else is evidence and belongs in
`## Evidence`. **[judgement]**

Real case — BUG-085's original body carries `≤6`, `24h`, `12-recent→6` and
`14/14 passed while missing this`. The rewrite kept two: **six** (the limit that
was violated) and **24 hours** (the condition you reproduce under). `14/14` is a
true and interesting number about the previous test suite, and it changes
nothing a reader of the board decides, so it stayed in the body.

**Where evidence lives, stated once so two contracts stop colliding.** A number
that **prices an option or names the condition you reproduce under** is
decision material and belongs in the human layer — in `cost`,
`why_not_obvious`, or the summary. A number that **scores a run** — a pass
tally, a suite name, a check count — is evidence, and belongs in `## Evidence`,
`## Verification plan` or the activity log. The two are not ranked; they are
different readers.

This matters because the migration is separately, and correctly, required to
*say what ran* rather than deny that anything did: a ticket whose own log
records executed suites must not migrate to "no further action is recorded".
That requirement and this one only conflict if the tally is read as the only way
to say it. It is not. **Name the proof in words in the human layer and put the
tally in the body**: `the pre-fix case failed and the corrected behaviour
passed, with standing checks clean` carries the same claim, survives the
identifier rule, and leaves the numbers one section away for anyone who wants
them. The human layer says *what was proved*; the body says *what was run*.

---

## The decision fields — what a person actually acts on

- `question`: one sentence, ends in `?`, ≤ 25 words, answerable **without
  opening the body**. Prefer "How should X …?" or "Should we A, or B?" over
  "What do we do about X?". **[checked: `?`, cap, no identifier]**
- `options[].label`: ≤ 8 words is the limit; **2–4 words is the target**, and a
  label at the limit is usually an argument that has leaked. A verb phrase is
  the default shape (`Encapsulate the live fields`, `Move snapshots out of the
  export`); a noun phrase is fine when there is no verb (`Per-turn amendment
  channel`). No parenthetical gloss: a label that needs `(encapsulation)` after
  it has not named the option yet. Short does not mean bare: `agents` and
  `compaction` are topics, not options, and a reader has to go into the body to
  find out what either one would do. Two or three words that contain a verb beat
  one word that contains none. No sentence punctuation — a comma or a
  `because` means the argument leaked in. Four labels are meant to be read in
  one glance and told apart. **[checked]**
- `options[].why_not_obvious`: the field that makes options comparable. **One
  sentence: the risk, and what it costs you.** Then stop. Do not add what the
  risk means for the plan, how it should be handled, or how the reader ought to
  feel about it — "this is the failure mode to design the migration around"
  adds no fact, and the sentence was finished before it. Never "n/a" — an
  option with no downside is not an option, it is the answer.
  **[checked in `validateTicket`: cap, placeholder words]**
- `recommendation_reason`: say *why this one beats the others*, not what it is.
  Restating the label is the failure. `null` is honest when a prerequisite is
  unproven — FEAT-092 records `null` because resume behaviour is inferred rather
  than proven, and that is the correct record. **[checked: not a restatement of
  the label; ≥ 8 words]**

> **bad label** (verbatim, one bullet, ~60 words) `**1 — move the calibration snapshots out of the exported tree.** The feat-088 fixtures are real tickets only because that is convenient; the readability gate could read them from a location not included in git archive … Cheapest, closes leak #2 cleanly, leaves leak #1.`
> **good label** `1 — Move ticket snapshots out of the export.` — with the cost,
> benefit and why-not-obvious in their own fields, so four options can be read
> side by side instead of four paragraphs being compared from memory.

> **good reason** `C, because it gives new tickets reliable fields without abandoning useful evidence in old tickets.` — a comparison, not a restatement.

---

## What is checked, and what is not

`node scripts/verify-ticket-writing-contract.mjs` runs the checkable rules over
the prototype rewrites, the migrated tickets and every ticket in `docs/bugs/`.

There are **two tiers**, and the difference is what they ask.

- **Core** (`T1`–`T3`, `H1`, `H2`, `D1`–`D3`) asks whether a field is *well
  written*. Measured 2026-08-20: **0/4 prototype fail, 0/4 migrated fail,
  191/191 originals fail.**
- **Extended** (`N1`–`N3`, `C1`–`C3`, `U1`, `P1`, `S1`) asks whether what is in
  a field *belongs there*. It was written after four versions of one ticket were
  compared side by side, and it exists because **the migrated corpus passes
  every core rule while carrying seven field-purpose defects**: a pass tally and
  a suite name in the field that must name the next act, a benefit in a cost
  column, an argument-for inside a `why_not_obvious`, a status report where an
  act belongs, and a self-certifying `confirmation` on every single ticket.

The gate is therefore asymmetric, deliberately. The **hand-written** corpus must
be clean on *both* tiers — a rule that fires on the quality bar is a stylistic
tax and is deleted, not retuned. The **migrated** corpus is gated on core only,
and its extended findings are printed as a count, because it is the material
under test rather than a standard. The must-FAIL side is a corpus of the real
defective field values, each quoted with the file it came from, each paired with
the correctly-written field that says nearly the same thing and must stay
silent.

`S1` currently fires on **every migrated ticket**, which makes it a statement
about the pipeline rather than about any ticket: the confirmation field is
self-certifying by construction. That is fixed where it is generated, not by
writing.

One core rule was **wrong** and is fixed: the file-path shape matched a pass
tally, so `25/25` was reported as "a file path". It failed two of four migrated
tickets for a defect they did not have, while the defect they did have went
unnamed — and it accounted for 29 of the reported identifier hits on the board.
A path shape now requires a letter.

Two metrics from `scripts/lib/readability.mjs` are **reported but not gated**,
because they were calibrated on multi-paragraph replies and do not separate on
30–60-word ticket fields:

- *clause density* fires on well-written fields whose commas are a **list** or a
  bound, not nested clauses — `Bounded: outcome-ledger correctness and
  orchestration decisions are affected, not completed job data; the verified fix
  remains inactive until restart` measures 1.50 against a 1.0 limit. Medians:
  0.80 prototype / 1.00 migrated / 1.67 originals — the good sets straddle the
  threshold, so it cannot gate;
- *Flesch–Kincaid grade* has no gap at all, and points the wrong way: median 8.7
  prototype, 14.2 migrated, 10.6 originals.

Only `maxSentenceLength > 40` transfers from that module, and it is used. The
thresholds were not adjusted to make the sets separate.

Every checked rule also earns its place, so none is dead weight. Of 191
originals: T1 (title length) fires on 108, T2 (title identifier) 127, T3 (title
clause) 316, H1 (human-layer identifier) 883, H2 (long sentence) 82. Every
extended rule fires on real migration output or on a case derived from it, and
none fires on the hand-written corpus. `P1` is the honest exception: it fires on
no real ticket today, because the shape it detects — a condition loose in an
option field with `prerequisite: null` — is what the two *observed* failures
turn into when combined, and each real file showed only one half. Its case is
built from real text and labelled as derived in the suite.

The writing checks live in `scripts/lib/ticket-writing.mjs`, **not** in
`scripts/lib/ticket-schema.mjs`, for two reasons: that file carries a
portability contract requiring it to be import-free, and these checks import
`readability.mjs`; and `validateTicket` is what the migration accepts or
quarantines on, so turning a style rule into a hard rejection there would
quarantine tickets for register rather than for correctness.

## Where this reaches its two audiences

- **The migration.** `scripts/migrate-tickets.mjs` should inline this document
  verbatim and import `renderWorkedExamples()` from
  `scripts/lib/ticket-writing.mjs` in place of its own hand-written example. A
  model takes register from a demonstration far more reliably than from a
  description of one, so the example is load-bearing — but two independently
  maintained demonstrations drift invisibly, because both keep validating. One
  owner, here. `schemaContract()` should then reduce to mechanical facts only
  (names, enums, caps, conditional-mode rules), still generated from
  `ticket-schema.mjs` so it cannot drift from the validator; the five voice rules
  it currently hand-writes are absorbed above. The checkable rules should also
  run post-generation as an advisory alongside `validateTicket`, feeding the same
  corrective re-prompt — advisory because a register violation is not a
  correctness violation and must not quarantine a factually correct ticket.

  **Owed, not done.** `migrate-tickets.mjs` was held by another lane when the
  extended rules landed, so three wirings are written here and not yet made:
  the advisory should report the extended tier alongside the core one and feed
  the same corrective re-prompt; the prompt should stop teaching
  `prerequisite: null` as a default now that the worked example carries a real
  one; and `source.confirmation` should either be dropped in favour of the
  provenance already in `source.sha256` / `source.bytes`, or be generated as a
  statement of what was compared. Until then `S1` fires on 100% of output and
  no ticket author can act on it.
- **Future authors,** who are mostly agents. `docs/bugs/README.md` links here
  from its ticket-shape section; `docs/bugs/TEMPLATE.md` should carry the same
  one-line pointer next to each capped field.
