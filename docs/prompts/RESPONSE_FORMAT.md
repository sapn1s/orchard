# Response format — two layers (FEAT-083/084 digest, FEAT-091 prose blocks)

A convention for agents answering inside Orchard. It is a **project default**,
**per-project overridable**, and **disable-able**. The goal: a reader who skims
10% of prose can still track state at a glance, and never has to read the agent
narrating itself in order to find the thing addressed to them.

There are two layers, and they do different jobs:

| Layer | Block | Shape | Job |
| --- | --- | --- | --- |
| 1 | `orchard-digest` | JSON | a scannable state summary lifted into the UI |
| 2 | `orchard-answer` / `orchard-finding` / `orchard-outcome` / `orchard-ask` / `orchard-judgment` / `orchard-status` / `orchard-narration` | prose | every part of the reply declares WHAT IT IS |

Layer 1 is genuinely structured data and is unchanged by FEAT-091. Layer 2 is
prose-shaped, because prose is what it holds.

**Round 12 replaced layer 2's vocabulary.** It used to be two names —
`orchard-answer` (shown) and `orchard-notes` (collapsed) — which encoded
PRESENTATION, not meaning. That is the defect: a presentation-only split gives
the author a bucket to dump anything into, and it did, repeatedly, in the visible
half. The names are now SEMANTIC and presentation is derived from the category.
The two old names still parse and still render as they always did; see
**Migration** below.

<!--
FEAT-084/091 — the region between the `response-format-inject` markers below is
the CONDENSED, agent-facing core. Only that region is injected into a session's
system prompt (templates.ts#responseFormatSection), gated on the project's
`responseDigest.enabled` flag — the same flag the transcript renderer reads, so
the two sides can never disagree. Everything OUTSIDE the markers is human
documentation and is never injected.

SIZE BUDGET, measured: the core is ~4.6 KB (3.0 KB through round 13; round 14
added the in-block prose shape and its worked example). It competes for the same attention
budget as the Working Agreement and the live board, and it is paid on every
single turn, so it is kept to a definition and a rule per name — the reasoning
lives below the end marker, where it costs nothing. Round 12 tripled the
vocabulary (2 names -> 6 + a fallback) for +18% of core bytes, because the six
are one line each and the pairs are what make them memorable. That ratio is the
test to re-apply before adding a seventh: if a name needs a paragraph to
distinguish, its boundary is wrong, and a wrong boundary is what costs tokens.

Round 14's +1.5 KB is the one place that ratio was knowingly not met, and the
justification is recorded under "Inside a block" below: the addition is a WORKED
EXAMPLE, and an example is the part that cannot be moved below the end marker —
the agent writing the reply never reads this file, only the core.

ARCH-016 added the lane-final-message contract (a definition + one rule, +~440
bytes, core section observed 5687), and the budget assertion in verify:feat-084
was raised 5500 -> 5900 with the reasoning recorded at the check. It meets the
ratio (one rule, ~six lines) and it is the enforcement surface for the ticket's
primary lever: the money is the parent REPLAYING lane-result prose every turn,
not this one-time per-session core, so paying ~440 bytes here to make every lane's
FINAL message compact at the source is the trade the ticket decided from data.

FEAT-125 added the "How much to write" length budget (a word ceiling + the
deletion test + a do-not-cut list, ~775 bytes) IN PLACE OF round 14's worked
narrative/shaped EXAMPLE, which it removed from the core (net section 5687 ->
5880, cap unchanged at 5900). This deliberately reverses round 14's "the example
cannot leave the core" call, and here is why the trade is right: the user's live,
repeated complaint is total VOLUME ("they all talk too much"), which two prior
"be concise" rules failed to move; the in-block SHAPE rules the example
illustrated survive in full above, and the fuller worked examples still live
below this marker for humans. A quantity budget the agent must obey outranks a
second in-core illustration of a rule already stated. Enforcement is still docs
only (advice); a mechanical length gate is filed as the follow-up.
-->


<!-- response-format-inject:start -->
## Response format (agent core)

Two layers: layer 1 a scannable JSON summary, layer 2 declaring what each passage
IS. Presentation follows from the category — never choose it.

**Layer 1 — `orchard-digest`.** When a reply is **substantive** (it decides
something, finishes something, or carries state the reader must track), lead the
message with one fenced block, info-string `orchard-digest`, holding JSON:

    ```orchard-digest
    { "items": [
      { "text": "One-sentence item.", "kind": "done", "importance": "high", "ref": "FEAT-091" }
    ] }
    ```

- At most once, at the very top; only whitespace may precede it.
- **OMIT it** for a short reply, or one whose body is a single artifact — it is a
  scan surface, not a preamble.
- Items are NEWS, one sentence each; an item that paraphrases prose below is not
  news — cut it.
- `kind`: `decision` | `done` | `in-flight` | `fyi` (aliases map in; unknown→fyi).
- `importance`: `high` | `med` | `low` (default `med`). **No emojis, ever.**
- `ref` (optional): a ticket id → a deep link; any other string is an inert label.
- Ephemeral: THIS turn's state only. Do not accumulate or duplicate the board.

**Opening a request.** When the user asks for something NEW, lead with an
`orchard-request` fence — `{ "id":"REQ-N", "title":"…", "source":"<short quote>", "tickets":["FEAT-1"] }` — for the "Your requests" rail. Latest-wins per id.

**Layer 2 — every part of the reply carries a category.** Each is a fenced
block; **open with 4 backticks** so ordinary ```code``` fences inside survive:

    ````orchard-finding
    What is TRUE: learned, diagnosed, measured, corrected, explained.
    ````

**The thing you asked FOR is `orchard-answer`.** When you requested an artifact (a
draft, command, number, recommendation), that deliverable is an `orchard-answer`
block: always shown, never folded. NOT `orchard-outcome` — producing text for you
is not a change to the world.

Everything else is six names in three pairs:

Open: digest, `answer`, `ask`, `status`. The rest FOLD, each showing its first
sentence — lead with the line they decide on.

- **the world** — `orchard-finding` what is TRUE · `orchard-outcome` what I
  CHANGED in the world: shipped/committed/filed/deployed (never text I wrote you).
- **a decision** — `orchard-ask` it is YOURS: a choice, question, approval or an
  action only you can take; lead with my recommendation, then `confidence:`
  high/med/low and `decider:` (taste/priority/spend/risk/direction) · `orchard-judgment` it
  was MINE: the call and why, including where I got it wrong.
- **the work** — `orchard-status` where it stands as this turn ENDS (running,
  next, blocked, or nothing needs you) · `orchard-narration` what I am doing
  INSIDE this turn.

- A passage that is two of these is two passages: split it.
- **Nothing fits** → ` ````orchard-uncategorized <short label> `. It renders
  normally; the label names the category we lack. For genuine incapability, not
  to avoid a choice.
- **Leave nothing loose.** Prose outside every block still renders, but it is
  uncategorised without saying so. A one-line reply is one block.
- A fence closes only on a run of the same character (`` ` `` or `~`) at least as
  long as its opener.
- **Repeat freely, in any order** (digest excepted: once, first).
  Blocks never nest. `orchard-*` is a reserved namespace — do not invent names.
  An `orchard-*` fence inside a COLLAPSED block ends the fold — never, as an example.

**Comparisons go in a table.** Anything sharing attributes — candidate lists, cost
breakdowns, before/after, per-option trade-offs — is a GFM pipe table (`| a | b |`,
then `|---|---|`); the renderer draws it. Never a comma-run.

**Inside a block: lines, not paragraphs.** A reader takes one fact without reading
a sentence to its end.

- **One line, one job** — claim, evidence, consequence on separate lines, each a
  complete claim; the lead line is the claim, no wind-up.
- **Cut flow-only connectives** ("which is why", "the honest part is"): a reason
  earns its own lead line; a smoother is deleted.
- **Parallel things, parallel slots**, same order, cost in the same position.
- `ask`/`judgment` keep the whole argument — an option without its price is not a
  decision.

**How much to write — length is a budget, not a target.** Default **≤120 words of
prose**; **≤250** only for a final handoff or pending decision. Wrappers (digest,
fences) don't count.

- Keep a sentence only if it adds new evidence, a changed outcome, a material
  limitation, or a requested decision. Else delete it.
- Report an unchanged lane or blocker ONCE. One sentence of pre-result diagnosis;
  no hypothesis narration unless it changes an action.
- **Never cut**: an unverified admission; before/after counts and real evidence;
  anything affecting how a commit is reviewed or staged; a retraction.

**Your FINAL message to your orchestrator is a compact handoff, not a report —
and it must be your LAST message.** State the verdict (done / refuted / needs-you
+ which decision), the decisions to take, and a durable pointer: ticket id +
Activity-log entry, report id + timestamp. Detail goes to the log; use
`orchard-outcome` / `orchard-finding`, never paste the report body. If a cleanup pass
(redaction, `board:gen`, gate re-run) runs after the work, re-state it last —
the orchestrator can't `Read` your scratch, so "Redacted line 4…" is no handoff.
<!-- response-format-inject:end -->

## Why named fenced blocks, and not one JSON object

The whole-response-as-JSON shape was proposed and **rejected**, for reasons worth
recording so it is not re-proposed:

- **Escaping.** A reply routinely contains markdown and code, including
  backticks, newlines and quotes. Putting all of it inside JSON string values
  means escaping it, and the agent doing that by hand at generation time is a
  reliable source of corruption.
- **Blast radius.** One bad quote destroys the *whole message*. With fences, a
  broken fence damages one block and the rest of the message still renders.
- **Streaming.** JSON cannot render until it is complete, so the reply stops
  appearing progressively. Fenced prose streams exactly as it does today.
- **Graceful degradation is a property we already have.** Today a malformed
  envelope degrades to readable prose. Whole-response JSON removes that: a parse
  failure has nothing to fall back to except showing the raw JSON.

Fences keep every one of those properties, and cost one line each.

## The block vocabulary — derived from measurement, not from taste

**The rule that produced the first vocabulary was wrong, and it is worth saying
why before the new one.** It was: too many categories and they get misused, too
few and everything lands in the fallback — and since the fallback is measured,
starting too small is the recoverable mistake. That reasoning holds only for the
SIZE of a set whose members mean something. It said nothing about the axis, and
the axis was the defect: `answer` and `notes` are display states. "Is this for
the reader?" is a question about rendering, and every passage can be argued into
the yes half, so the visible block became a dump. The evidence arrived as the
user watching several turns of narration land in it.

### What the replies actually contain

The set below is **not designed; it is measured.** Method: 1,558 orchestrator
assistant messages from this project's own main-thread transcript
(the session's own CLI transcript under `<claude-projects>/<project>/<session>.jsonl`), segmented into
3,844 top-level passages (blank-line separated, fenced code kept whole), of which
a seeded random sample of **155 passages / 49,990 chars** was read and hand-
labelled. Fine-grained codes first, merged afterwards only where the evidence was
thin or the boundary was fuzzy:

| code | passages | % | chars | % of chars | became |
| --- | ---: | ---: | ---: | ---: | --- |
| finding (incl. correction, explanation) | 42 | 27.1% | 17,339 | 34.7% | `orchard-finding` |
| status | 30 | 19.4% | 6,266 | 12.5% | `orchard-status` |
| rationale / self-critique | 25 | 16.1% | 7,828 | 15.7% | `orchard-judgment` |
| outcome | 21 | 13.5% | 7,124 | 14.3% | `orchard-outcome` |
| ask (incl. recommendation) | 14 | 9.0% | 6,133 | 12.3% | `orchard-ask` |
| narration | 13 | 8.4% | 1,772 | 3.5% | `orchard-narration` |
| digest | 5 | 3.2% | 3,101 | 6.2% | layer 1, unchanged |
| **none of the above** | **5** | **3.2%** | **427** | **0.9%** | `orchard-uncategorized` |

Merges the measurement forced, rather than the design preferring:

- **correction folded into `finding`** (5 passages, 4.0% of chars). "I was wrong,
  and here is what is actually true" passes exactly the finding test — my
  knowledge changed, the system did not — and it needs the same presentation. A
  separate name would have been a second word for one idea.
- **explanation folded into `finding`** (3 passages, 2.0%). Too thin to name, and
  its boundary with finding was the fuzziest in the whole sample. So `finding` is
  "what is true", not "what this turn discovered".
- **"an answer to a question they asked" was DISCARDED as a category**, though it
  was one of the hypotheses. It is not a kind of content — it is *provenance*, and
  it is orthogonal: an answer to a question is a finding, an outcome, or an ask,
  depending on what it says. That is precisely the mistake the old vocabulary
  made, and adding it back would put a second axis into the set. (It is also why
  the legacy name `orchard-answer` is retired rather than redefined.)
- **`status` was kept, though the digest also carries `in-flight`.** It is 19% of
  passages, the single most repeated shape after findings, and the digest is one
  sentence per item — the prose that says which four lanes are running and what
  is gating them does not fit there. The two do not drift because the digest is a
  scan surface and this is its expansion.

### The set, and why each boundary is decidable

Three pairs on three axes. A passage's category is one question, then one word:

| axis | | |
| --- | --- | --- |
| the world | `finding` — what is TRUE | `outcome` — what I CHANGED |
| a decision | `ask` — it is YOURS | `judgment` — it was MINE |
| the work | `status` — where it stands as the turn ENDS | `narration` — what I did INSIDE the turn |

Each boundary is a fact about the passage, not a matter of degree:

- **finding vs outcome** — did this work *cause* the state, or merely *reveal*
  it? "The route is `PATCH /api/projects/:id`" is a finding; "the server now
  remembers the last list any session reported" is an outcome.
- **ask vs judgment** — whose call is it? Both are decisions; they differ only in
  who takes it, and the author always knows which. This pair also absorbs the
  recommendation the Working Agreement demands: a recommendation exists to serve a
  decision, so it lives with the decision it serves.
- **status vs narration** — is it still true after the turn ends? "Two lanes are
  running; I will report when they land" survives the turn. "Let me check whether
  it is re-adopt lag before filing" does not.
- **finding vs judgment** — is the subject the WORK (dispatch, verification
  strategy, my own error) or the SUBJECT MATTER (the code, the data, the world)?
  The git-index race I caused is a judgment; the git index itself is a finding.

**A passage that satisfies two definitions is two passages, and that is not a
boundary problem.** The boundary test applies to a single indivisible statement.
"I am running one final adversarial pass — that is the disciplined call here, not
endless cycling" is a status clause and a judgment clause, and splitting it is a
cheap, mechanical edit. There is deliberately **no tiebreak rule**: the previous
vocabulary had one ("if it is both, it is `answer`"), and a tiebreak is what a
soft boundary feels like from the inside.

### Presentation follows from the category

Four categories fold, and the rule that picks them is a property of the category
rather than a judgement about the passage:

> **A category is collapsed if the reader does not have to read it to know where
> they stand.**

`digest`, `ask` and `status` are the news addressed TO the reader — the headline
of the turn, what needs you, where it stands. `finding`, `outcome`, `judgment` and
`narration` are the supporting record behind those: what is true about the subject
matter, the full retrospective of what I changed, the reasoning behind a call I
made, and the play-by-play of establishing it. The digest already carries the
headline of what changed, so the long prose of `outcome` and `judgment` is detail
to open on demand. The fallback is visible because hiding the thing we could not
classify is the worst possible direction.

**The rule used to be "a category is collapsed if its value expires when the turn
ends", and it picked exactly `narration`.** That is a description of a set of one,
not a rule, and it did not survive contact with the reader — the user, unprompted:
*"let's make Finding collapsed by default, it's not really useful for me to read
unless I want to."* The measurement had in fact predicted this: `finding` is the
largest category in the sample at **34.7% of characters**, so it is where the
reading load actually is. What the old rule got right is that a fold must be a
property of the category; what it got wrong is which property.

Two honest notes on this:

- **Folding narration was a small volume win, folding findings is the real one**:
  narration is 8.4% of passages but only **3.5% of characters**; findings are
  **34.7%**. That difference is also why the two fold DIFFERENTLY — a folded
  finding shows its own first sentence on the summary line, a folded narration
  shows a bare label. Behind a caption that says only "Finding", a third of every
  reply would have to be opened one block at a time to find out whether it
  mattered, which is more work than reading it was. Narration is small enough, and
  expires soon enough, that a label is the whole story.
  Consequence for whoever writes one: **the first sentence of a finding is now the
  only part most readers will see.** Lead with what is true, not with a wind-up.
- **`judgment` is visible even though it is "internal reasoning"**, which was a
  hypothesis for collapsing. The transcript is the counter-evidence: this is the
  content the reader engages with most — the admitted orchestration error, the
  "six verdicts came back BROKEN and all six were right", the decision not to
  spend a cross-provider budget. Hiding it would hide the honesty the loop runs
  on. Narration is the play-by-play; judgment is the reasoning. Only the first is
  noise.

### Inside a block: the shape of the prose (round 14, FEAT-098)

Round 12 measured what replies *contain* and named six categories. It said
nothing about the shape of the prose **inside** a block, and that turned out to
be where the reading cost lives. The user, unprompted:

> "the problem with responses is that they are full paragraphs, im pretty sure
> that is what's taking cognitive effort, the output should really be some kind
> of structured text, idk what is it trained on, seems almost like online news
> articles making a story"

The diagnosis is exact, and it is a *granularity* defect, not a compliance one.
Structure existed between blocks and stopped at the fence. Inside, every block
came out as a news paragraph: a bolded lede, then supporting sentences welded
together with connectives whose only job is flow. To extract one fact the reader
had to parse a story. Measured on this project's own transcript, the mean
`orchard-finding` was **1,217 characters** and the mean `orchard-judgment`
**1,170** — one to three paragraphs each, every turn.

**The design is not "be concise".** That rule has failed here more than once, and
it fails for a structural reason: it asks for less of the same shape. The fix
gives a shape.

**The load-bearing idea came from the evidence, not from taste.** The one
document a reader in this project ever preferred outright was the ARCH-005
prototype, and the finding that recorded why says exactly what did it:

> Every option ends with a `Not obviously best because…` clause, in the same
> position each time. That single repeated slot is what turns it from an argument
> into a decision document — the reader scans the four catches vertically and
> compares them without re-reading.

That is the whole rule generalised: **a repeated slot in a fixed position is
scannable; the same content welded into a sentence is not.** Hence the five
lines in the core — one line one job, complete claims, no flow-only connectives,
parallel slots, and the explicit carve-out that `ask`/`judgment` keep their
argument.

#### Checked against real blocks, not invented ones

Three real blocks from this project's main-thread transcript, rewritten in the
proposed shape. The test applied to each: **does the rewrite lose anything?**

**1. `orchard-finding` — a self-correction about cost.** As written:

    **Correcting myself first.** I told you the verification loop was the cost.
    It isn't. Measured: 8.4% of spend, $4.09 per round, median 7 minutes, and
    per-turn segmentation says 71% of that is actually attacking, 8.7% is the
    clean-room setup I've been complaining about all day — 36 cents a round. My
    "each round is a full agent starting cold" story was wrong.

Shaped:

    **I was wrong: the verification loop is not the cost.**
    - 8.4% of spend. $4.09 a round, median 7 minutes.
    - Of that: 71% attacking, 8.7% clean-room setup — 36 cents a round.
    - "Each round is a full agent starting cold" — false.

Nothing lost, and the lead line is now the finding's collapsed preview, which is
the sentence a reader decides on.

**2. `orchard-ask` — the constraint case, where reasoning must survive.** The
original prices its alternatives in one semicolon chain: *"regenerating the
browser copy from the server's would overwrite the working partial-write fix
with the more broken version; keeping both in sync with a test means every
future fix lands twice, in two files two different lanes hold, and the test goes
red the instant the first half lands; and doing nothing is cheap only until
migration day."* Every alternative is priced — and the prices are unreadable,
because they are three subordinate clauses of one sentence. Shaped:

    **Recommendation: A — the server parses the record, delete the browser copy.**

    Why:
    - The two implementations have already drifted; the lane reproduced it.
      Truncated migrated file: server says "never migrated", browser says "found, broken".
    - The browser got today's partial-write fix; the server module did not.
    - Zero of 193 ticket files use the record format. Deleting a grammar costs
      nothing today and 193 files later.

    Alternatives, each with its price:
    - Regenerate the browser copy from the server's -> overwrites the working
      partial-write fix with the more broken version.
    - Keep both in sync with a test -> every future fix lands twice, in two files
      two lanes hold; the test goes red when the first half lands.
    - Do nothing -> cheap until migration day.

    **Nothing is being built on this until you pick.**

Same argument, same alternatives, same prices. This is the case the shape had to
survive, and it is the case it helps most: four options with the cost in the same
slot is the ARCH-005 prototype's own structure.

**3. `orchard-judgment` — where the reasoning IS the content.** The original
argues that a cheap model would have relayed four bad reports as successes, in a
paragraph. Shaped, the four become four lines under one lead — and the lead
carries the claim the paragraph took three sentences to reach:

    **What a router-only model would have lost today** — four incoming reports it
    would have relayed to you as successes:
    - a verifier's number wrong, caught before it became a fact
    - a false VERIFIED, live two days, refused
    - two lanes deadlocked on each other
    - a plan contradicting its own central claim

#### Where the shape would be wrong, stated before someone finds it

- **It must not become fragment soup.** "Board drift, 11 rows" is a label, not a
  claim. Hence *every line is a complete claim* — the shape moves the connective
  tissue out, not the verb.
- **It must not shorten a decision.** An `ask` whose alternatives lose their
  prices is worse than the paragraph it replaced: it reads as scannable and is
  no longer decidable. `ask` and `judgment` get *more* lines, not fewer words.
- **A one-claim block stays one sentence.** Scaffolding a short `status` into a
  lead line and one bullet is noise. The shape applies when there is more than
  one fact in the block.
- **A connective that carries a reason is content.** "worth knowing because I
  gave it a wider story than the evidence supports" is not flow — it says why
  the correction is being told. It becomes its own lead line rather than being
  deleted. Only the joins that carry nothing go.

#### The cost, stated

+1,529 bytes of injected core (3,024 -> 4,553), the largest single addition since
round 12, paid on every turn of every project. It buys a demonstrated shape
rather than an asserted one, against a defect that costs the reader on 100% of
substantive replies and that two prior "be concise" style rules failed to move.
The budget assertion in `verify:feat-084` was raised from 4,000 to 5,500 with the
reasoning recorded at the check, so the next increase is a decision rather than
a drift.

### The fallback is part of the design, not a leak

`orchard-uncategorized` is **first-class**: it renders expanded, it is counted,
and it **carries a required free-text label** — the info string is `name label`,
where the name is the first token and the rest is the author's own words for what
the content was. That label is the entire learning loop. Counting "3% landed in
the fallback" cannot name a missing category; counting "eleven of them were called
*a copy-paste prompt for you to run*" can.

The measurement already demonstrates the loop. Of the five uncategorised passages
in the sample:

- four were **document furniture** — a `---` rule, two section headings, one
  connective sentence ("Two things worth your attention"). These do not want a
  category; they belong to the block they introduce, which is why the rule is
  "leave nothing loose" rather than "wrap every line".
- one was a genuine artifact: **a copy-paste migration prompt written for the
  user to run elsewhere**. It is not a finding, an outcome, an ask, a judgment, a
  status or narration — it is a thing produced *for* the reader to use. If that
  label recurs, `orchard-artifact` is the seventh name, and it will have been
  named by the data rather than by a designer.

The two fallbacks are **never added together** (`scripts/lib/format-metrics.mjs`):

| | what it means | what to do |
| --- | --- | --- |
| declared `orchard-uncategorized` | the author reached for the vocabulary and nothing fit | a VOCABULARY gap — read the labels, add the name |
| loose prose outside every block | the author did not categorise at all | a COMPLIANCE gap — a new name will not help |

An `orchard-uncategorized` with **no label** is the one shape here that is a real
defect, and the Stop hook raises an advisory for it: the block is legitimate, but
without the words the signal it exists to produce is destroyed.

## Migration — the two old names keep working, forever

Stored transcripts are full of `orchard-answer` and `orchard-notes`. Rule 3 of
the extension contract ("names are frozen once shipped") forbids **repurposing**
either — redefining a shipped name to mean something else. Both stay in
`KNOWN_BLOCKS`, mapped to the presentation they shipped with:

- `orchard-answer` → visible prose, **undecorated, with no category caption**. An
  archived message renders byte-for-byte as it did before round 12; captioning it
  now would label old content with a category its author never chose.
- `orchard-notes` → the same collapsed fold as `orchard-narration`, with its
  original "Notes / internal narration" summary. It stays in `COLLAPSED_BLOCKS`,
  so the certainty guard covers it exactly as before.

**Round 15 (FEAT-142) reinstates `orchard-answer` in the injected core** — for
*the artifact the user asked for* (a draft, a command, a number, a recommendation
text): always shown, never folded. This is NOT a repurpose and so is inside rule
3: round 12's own note (below) records that `orchard-answer` already meant
"responds to what you asked", which is exactly this use. Its rendering is
unchanged (undecorated, always open), so every archived `answer` block keeps both
its pixels AND its meaning; the reinstatement is a documentation change plus a
tightened `orchard-outcome` (which had been absorbing this case — a requested
draft was landing under "what I CHANGED" and folding, showing the user a preview
line instead of the answer). `orchard-notes` remains legacy-only: it is **removed
from the injected core**, so no new turn produces one, and the metrics count it
under its own name — a legacy count that only ever falls. Nothing about the parse,
the fold guard, or the corpus changes, which is why the prior rounds of
verification carry over intact instead of being re-litigated.

## Rules in detail

### A message with no blocks
Still **renders identically** — the safety contract does not depend on
compliance, and it never will. But round 12 changed what it MEANS: under the old
vocabulary a bare reply was "legal and expected", which is the same escape hatch
in a different place. Every part of a reply now carries a category, so a one-line
reply is one block, and a message with none is recorded as `unstructured` and
read as a compliance gap. It remains the denominator that makes the two fallback
rates meaningful, and it is never a hard violation.

### Repetition and ordering
Every layer-2 name may repeat any number of times, in any order, because a real
turn is naturally finding → narration → outcome → ask, and forcing one block of
each would make the author reorder the narrative or dump everything at the end.
This is also what makes "split a compound passage" a cheap instruction rather
than a restructuring: the two halves just become two adjacent blocks. The renderer keeps document order. `orchard-digest` is the one
exception: at most once, and it must lead.

**The renderer is lenient about "must lead", so a lead-in never costs the rail
(BUG-155).** Authors should still put the digest first — that is the injected
rule. But 3.2% of real digests shipped one short sentence below the top ("Found
it.", "Clear recommendation: …") and were dropped, their raw JSON dumped as a
wall of prose. The renderer now:

- **Lifts a well-formed fence behind a SHORT lead-in** — at most 3 non-blank
  lines and 200 characters, with no code fence before it — and renders the
  lead-in as prose *above* the rail. The bound is deliberate: a digest deep in a
  message, or after a code block, is body content, not the message's summary, so
  it is not lifted here.
- **Never renders a digest's raw JSON as prose, at any position (the floor).** A
  digest that beat the lead-in bound, or a genuine second digest in the body, is
  painted as a real rail in document order if its JSON is valid; a malformed one
  degrades to a *contained code block*, exactly the fallback a malformed leading
  digest already gets. The worse-than-nothing JSON wall is structurally gone.

### What makes a region inert

Four rounds of this grammar shipped the same defect in different clothes: each
time, a construct an author used to make a region **inert** (literal text, not live
markup) was not modelled, so an example was parsed as a real block — and when that
block was `orchard-notes`, its content rendered inside a **closed** fold. Round 4
was a notes example quoted inside a `~~~markdown` fence. Round 5 was a notes
example inside a top-level HTML block:

    <div>
    ````orchard-notes
    MUST-BE-READER-VISIBLE-HTML
    ````
    </div>

Each time: present in the DOM, absent from the rendered text and from the
accessibility tree, with an empty malformed list.

**The standing rule this lane now works under**, because rounds 4 and 5 both
*documented the hole they were about to be broken by*: a construct that can make a
region literal is a **hiding vector until a test says otherwise**. It is modelled,
or a committed test proves a notes fence inside it cannot become a real fold. A
prose argument that "the residual is bounded" is not a shipping argument — it is
the prompt to write the test. Round 4's bound was even *true*: an `orchard-answer`
inside a fold always ends the fold. It was tight in the direction that does not
hide and open in the direction that does.

So the constructs are enumerated, not discovered one per round:

1. **Fenced code — both fence characters, ` ``` ` and `~~~`.** Modelled
   symmetrically: one character-parameterised fence primitive, so the opener
   length, closer length, info-string and 0-3-indent rules cannot be right for one
   character and forgotten for the other, which is precisely what happened. A fence
   pairs only with its **own** character, at any length: eight tildes do not close
   a backtick fence. The one asymmetry is CommonMark's — a backtick fence's info
   string may not contain a backtick, a tilde fence's may contain anything.
2. **Indented code — 4+ columns.** Covered structurally rather than by a rule: an
   opener is only recognised at 0-3 columns, and an indented code block by
   definition contains no line at 0-3 columns. This is also the documented escape
   hatch for an example inside notes, so "it falls out" is asserted, not assumed.
3. **HTML blocks — CommonMark's seven start conditions, as of round 6.** Round 5
   modelled them *sufficiently* rather than faithfully, on the argument that a
   cheaper rule satisfying the invariant beats a faithful one. Round 6 withdrew
   that argument: the cheap rule satisfied the *hiding* invariant and broke two
   others. The list is bounded and specified, so it is implemented.
   - **Start** is the seven conditions, one entry each in `HTML_STARTS`:
     (1) `<script` / `<pre` / `<style` / `<textarea` then whitespace, `>` or EOL;
     (2) `<!--`; (3) `<?`; (4) `<!` + a letter; (5) `<![CDATA[`; (6) `<` or `</`
     + a listed block tag name then whitespace, EOL, `>` or `/>`; (7) a **complete**
     open or closing tag alone on the line, which alone **may not interrupt a
     paragraph**. The tag list for (6) is the union of CommonMark 0.30 and 0.31.2.
   - **Why the loose predicate was withdrawn.** Round 5 used one predicate — 0-3
     indent, `<`, then `!`, `?`, `/` or a letter — because all seven conditions
     begin that way, so none could be forgotten, and treated the over-recognition
     as free. It is not free. A bare `<b` on its own line is *prose*: no complete
     tag, no condition satisfied. The loose rule inerted it and swallowed the
     `orchard-notes` block written under it — well-formed input got a false
     `inert-html:` flag, `blocks` came back **empty**, and the block's content was
     counted as uncategorised prose. That fires on text people write constantly
     (`<b`, `Array<string>`, `a <b`), it teaches readers to ignore the flag, and it
     corrupts the metrics. Measured on the shared corpus, round 5 hid nothing
     (I1 = 0, its argument was true) and lost **146** genuine blocks out of the
     parse while flagging 146 legal inputs.
   - **Extent** is the kind's own end: a terminator for types 1-5 (`</script>`-ish,
     `-->`, `?>`, `>`, `]]>`), checked from the start line so a one-line
     `<!-- x -->` or `<!DOCTYPE html>` is one line; otherwise the first **blank
     line**. One addition makes it safe: **the region never ends while a fence
     opened inside it is still open**, or an inert region could hand a dangling
     fence back to the top level and *create* the fold it was meant to prevent.
   - **Paragraph state, as of round 7.** Condition 7 is the only start condition
     that may not interrupt a paragraph, so whether a complete tag alone on a line
     is literal depends on what is *above* it. Round 6 honoured the clause with a
     boolean set by any non-blank line and documented the resulting
     under-recognition as the safe side. It is not. An **ATX heading** above a
     complete custom tag left the flag set, the region was not treated as literal,
     and the `orchard-notes` *example* inside it became a real **closed fold** —
     absent from the rendered text and from the accessibility tree, with an empty
     `malformed` list. The same hole existed for thematic breaks, setext headings,
     indented code, an empty list item and an empty block quote: **ten shapes**.
     So the constructs are enumerated. A paragraph is **closed** by a blank line,
     an ATX heading, a thematic break, a setext underline, a fenced-code opener
     (either character), an HTML-block start, and an empty container marker; it is
     left **open** by ordinary text, and by indented code only when one was already
     open, since indented code cannot interrupt a paragraph. Container markers are
     stripped and the remainder classified, so **lazy continuation** works: `>
     text` followed by `<my-widget>` at column 0 is paragraph continuation text to
     CommonMark, not an HTML block.
   - **Containers are a stack, as of round 8.** Round 7 did the stripping with a
     regex, one level deep, and wrote that limitation down. It was the next
     verdict: `-` followed by **five** spaces is a list item whose content is
     *indented code*, not a paragraph (CommonMark 5.2 — with 5+ spaces after the
     marker the content column is marker+1 and the rest is code), the greedy strip
     saw the paragraph `code`, and the `<my-widget>` under it looked like lazy
     continuation. Condition 7 was suppressed, the region was not literal, and the
     authored example became a real **closed fold** with an empty `malformed`
     list. So a line's meaning is now derived from the container **stack** it sits
     in: quote and list markers at any depth, the real content-indent rule,
     continuation by indentation, lazy continuation, indented code measured from
     the container's content column, the paragraph-interrupt rules (a list item
     may not interrupt a paragraph unless it has content and, if ordered, starts
     at 1) and tabs as 4-column stops. What is deliberately *not* modelled — list
     tightness, two-blank-lines-closes-a-list, list-type changes — is pinned by a
     test proving it cannot hide. (Link reference definitions were on that list
     until round 10 removed them; see below.)
   - **The tag grammar is transcribed, not paraphrased (round 8).** Condition 7
     rejected the four type-1 tag names in *either* form. The conditions are tried
     in order, so `<pre>` is already condition 1 and never reaches 7; what the
     reject actually removed were complete **closing** tags — `</pre>`,
     `</script>`, `</style>`, `</textarea>` — and `<pre/>`, all of which the
     reference makes condition-7 HTML blocks. A message opening with a lone
     `</pre>` therefore had a literal region this parser called live. Condition
     6's tag list is likewise **one pinned revision** (0.31.2) rather than a
     0.30 union: the union made `<source>` inert where the reference keeps it
     live. Both were found by the differential, not by a reader.
   - **Direction of error — there is no safe side, and that is the point.** Round 5
     called it *monotone inertness*; round 6 restated it as "err toward *not*
     inert, because a missed inert region is bounded". Round 7's defect **was** a
     missed inert region, and it hid authored content. Both directions cost: a
     false inert region corrupts the parse and flags legal prose (round 5: 146
     false flags, 0 hidden), a missed one folds authored text away (round 6: 150
     hidden tokens, 0 false flags). "The residual errs the safe way" is therefore
     not available as a shipping argument here — where the spec is decidable,
     decide it, and check the decision against the reference implementation. The
     grammar is differential-tested against CommonMark 0.31.2 over 107 preceding
     contexts x 31 tag lines, both directions, at **0 disagreements** (`npm run
     verify:feat-091-commonmark-diff`), plus a container-space differential of
     2,736 more documents in the main suite; round 7 scores 460 on the 3,317 and
     round 6 scores 772. When a region *is* inert and
     swallows a reserved opener it is still reported as `inert-html:`, never
     silent; one blank line before the block restores it.
   - **What a randomised differential found that a matrix could not (round 9).**
     Everything above was checked by an *enumerated* differential: 107 contexts x
     31 tag lines, a matrix of shapes someone thought to write down. Round 9's
     verdict came instead from generating **random** container-and-tag
     combinations against the reference — and the round-8 lane had run exactly
     such a fuzz, 30,000 documents, in scratch, and not committed it. That gap is
     the round. The fuzz is now a standing check that generates **fresh**
     documents on every run with a printed seed for replay (`npm run
     verify:feat-091-commonmark-diff`, leg [3]); at 500,000 documents it reports
     0 hiding, 0 over-recognition and 0 lost tokens, where the round-8 generation
     reports 7,441 disagreements on the same documents.
     It found **five** causes, not one shape, each a rule written in terms of a
     fixed width or a raw column instead of the line's real container context:
     (1) a **setext underline is lazy continuation text** — "a setext heading
     underline cannot be a lazy continuation line" means the line cannot become a
     *heading*, not that it starts some other block, and reading it the other way
     closed a paragraph the reference keeps open, which is the reported defect;
     (2) the classifier carried **no leaf state across lines**, so the body of a
     fence or an HTML block *inside a container* was re-classified as prose;
     (3) a blank line matched an **empty list item** forever, where CommonMark
     closes it ("at most one blank line"); (4) the top-level scan and the
     classifier were **two detections that could disagree** — see below; (5) a
     fence could take its **close**, and an HTML region its end, from outside the
     container it was opened in.
     Two earlier rules were **retired as false inertness**, with the reference as
     the arbiter: an HTML region *does* end at its blank line even with a ``` run
     inside it (round 5's extension), and link reference definitions are *not*
     safely "just paragraph text" — a setext underline over a definition-only
     paragraph underlines nothing, so the paragraph stays open.
   - **A construct's extent can span lines, and a line classifier cannot see that
     (round 10).** Round 9 recognised a link reference definition with a one-line
     regex and wrote down that the multi-line form "cannot hide". True, and
     irrelevant: it **loses a block** instead, which the standing rule covers
     equally. A definition's label, destination and title may each sit on their
     own line, so

         [ref]:
         /url
         ===
         <my-widget>
         ````orchard-notes

     is, to the reference, one definition resolved out of the paragraph, nothing
     left to underline, no heading, the paragraph still **open**, condition 7
     suppressed and the fence **live**. Round 9 saw no definition, made `===` a
     setext heading, closed the paragraph, and the authored fold **disappeared**:
     its narration rendered as open prose (`exposedInFullAXTree: true` in a real
     accessibility-tree read) and `inert-html:orchard-notes` was reported as
     uncertainty on *valid* input. A wider regex cannot fix this — whether line
     *N* is inside a definition depends on lines 1..*N*-1 — so the paragraph now
     carries its accumulated content, exactly the reference's `_string_content`,
     and definitions are resolved off the front of it by a port of the
     reference's own `parseReference`, at the one place the reference runs it: the
     setext block start. Content is accumulated from the **raw** line, because the
     reference's whitespace rule does not admit a tab, and expanding one would
     *invent* a definition — the hiding direction. Lazy continuation lines are
     accumulated too: `> [ref]:` / `/url` / `> ===` is one definition.
     Every *other* construct whose extent spans lines was enumerated at the same
     time and each is accounted for: fenced code blocks and HTML blocks (carried
     as open leaf state since round 9, bounded by their container), setext
     headings (the paragraph above them), paragraphs and their lazy continuation,
     indented code across a blank line (line-by-line classification cannot differ
     — every line is closed to the classifier either way, and a fence at 4+
     columns is not an opener), list tightness (grouping only), and inline
     constructs (settled after block structure, so they cannot literalise).
   - This is **top-level only**. The fold guard stays construct-blind: C1 must keep
     firing on a reserved opener inside a fold in *any* wrapper, so teaching it
     about HTML could only weaken it.
4. **Container contexts — blockquotes and list items.** Carried as "not attempted"
   for three rounds, pinned as `bq`/`list` in round 5, and *still* the source of
   round 8's verdict — because those strata pinned quote depths and indents around
   a **fence** and never the container **stack** a paragraph lives in. Naming a
   dimension is not varying it. The stack is now modelled (see the paragraph-state
   note above) and differential-tested against the reference over a generated
   container space. Round 8 then wrote down what remained as **under**-recognition
   — "a `>`-prefixed fence is not an opener here at all, and neither is a fence at
   4+ columns inside a list item; neither can hide anything, because no fence
   recognised means no fold created" — and **that claim was false**, which is
   round 9's most important correction. The top-level scan looked for constructs
   at 0-3 **raw** columns while the line classifier looked at the line with its
   **container prefix** consumed, so inside an item whose content column is 2 the
   scan missed the HTML block at 4 raw columns and still saw the fence at 2:
   under-recognising the *literaliser* while recognising the *fence* folds
   authored content away. There is now exactly **one detection**, in container
   context. A `>`-prefixed fence and a fence at an item's content column are
   openers — which is what the reference says they are — and they fold with the
   authored quote marker or indent intact; a construct at 4+ columns *of its own
   container's content indent* is indented code to both sides and is still not an
   opener. A construct's extent is bounded by its container, so nothing takes its
   close from outside the container it was opened in.
5. **Inline constructs are not literalisers — and that is a proof, not an
   omission.** CommonMark settles block structure *before* any inline parsing, so a
   code span, a raw inline tag or a link-reference-definition title cannot contain
   a fenced code block: the fence wins, in every conforming renderer. A multi-line
   `` `` `` span "around" a notes fence therefore yields a real fold, correctly.
   The corpus `inline` stratum asserts the fence is **live**, so a future
   over-correction toward inertness fails there. A backslash-escaped run
   (`` \```orchard-notes ``) is not a fence to either side, and is pinned too.

### Nesting
Blocks do not nest. A fence inside an already-open fence is literal content — so
a documented example of ` ```orchard-answer ` inside a code block is inert and is
never parsed as a real block, under either fence character and in either order.

**Except inside a COLLAPSED block (`orchard-narration`, and its legacy alias
`orchard-notes`), where nesting is not tolerated at all.** See "The fold is the
only gate" below: a folded body containing a reserved opener at *any* depth, or an
unpaired inner fence, ends the fold at that line. The escape hatch for a
documented example inside it is a 4-space indent, which is not a fence opener in
CommonMark and therefore needs no nesting analysis to stay inert.

### Malformed input

Four guarantees, in this order. They are the contract; the behaviours below are
consequences of them.

1. **No content is ever lost or hidden**, under any input. Every byte of the
   message reaches the reader.
2. **Document order is preserved.** Degradation never reorders a message.
3. **A malformed region degrades to prose. Well-formed blocks before or after it
   keep their rendering.** Degradation is *local*.
4. Only a message that **cannot be parsed at all** renders wholly as prose.

Rule 3 replaces an earlier, wrong wording of this contract ("malformed input
degrades to plain prose — the whole message must remain readable"), which was
read — correctly, as written — to mean that one bad fence should demote the
*whole* message. It should not: discarding a valid block because something
*later* in the message is malformed loses structure and protects nothing, since
the content was never at risk. Blast-radius containment is the reason fences were
chosen over whole-response JSON in the first place; whole-message demotion would
throw that away.

Consequences:

- Unterminated `orchard-*` fence → the opener line and everything after it is
  fallback prose, flagged `unterminated`. **Blocks that closed correctly BEFORE
  it keep their rendering**, and blocks after a *repaired* region keep theirs.
- Unknown `orchard-*` name → its content is rendered as fallback prose and the
  name is recorded, so a name in use ahead of its spec is visible.
- An `orchard-*` fence inside an inert **HTML block** → the whole region is prose
  (that is what "inert" means) and the swallowed opener is flagged `inert-html`.
  This is the reported half of "uncertainty resolves visible **and** reported":
  the reader loses nothing, and the author is told their block did not take.
- Malformed `orchard-digest` JSON → unchanged FEAT-083 behaviour: the digest is
  dropped and the whole message renders as ordinary prose, its fence shown as an
  ordinary code block. (This is rule 4, not an exception to rule 3: the digest is
  *structured data*, and a message whose lead envelope will not parse has no
  reliable structure to trust.)
- Body-position `orchard-digest` (behind a lead-in past the tolerance bound, or a
  second digest) → **never raw JSON prose (BUG-155)**. Valid JSON paints a real
  rail in document order; malformed JSON degrades to a contained code block, the
  same fallback as a malformed leading digest. This is the *floor*: no code path
  renders a digest's JSON body as prose, for any fence position.
- A message with no blocks, or one whose only fence is unterminated, is rule 4:
  one prose render, byte-for-byte as before the feature existed.

**Degradation always moves content toward VISIBLE.** An unterminated `orchard-notes`
renders its narration expanded instead of collapsed — noise, not loss, and the
safer direction (guessing visible costs a scroll; guessing collapsed costs a
decision).

### The fold is the only gate

That rule was, twice, a property of particular parser branches rather than of the
parse, and both times it failed the same way: an authored `orchard-answer` ended
up inside a **closed** fold — missing from the rendered text and from the
accessibility tree — while the parser reported an empty malformed list and an
empty fallback list, so both consumers agreed and both were wrong. The first
variant was an unclosed `notes` swallowing a following `answer`. The second was
the same thing with one more layer of nesting. Fixing the demonstrated shape is
how you get a third variant.

The rule is now structural. A COLLAPSED block is the **only** construct in this
grammar that can make content invisible — every other outcome renders expanded —
so there is exactly one gate, and it carries a **certainty guard**. Round 12
tripled the vocabulary without widening that gate, and round 13 widened it by
exactly one name on purpose: `COLLAPSED_BLOCKS` holds `orchard-finding` and
`orchard-narration` plus the frozen legacy alias of the latter, and both the guard
and the renderer's single hiding branch read that one list. Adding `finding` to
that list is what put findings under the guard — a finding containing a reserved
opener or an unpaired inner fence now ends its fold at that line and reports
`ambiguous-fold`, exactly as narration always has. Nothing addressed to the reader
is on the list, and `verify:feat-091-response-blocks` asserts that as a property
rather than pinning today's members.

> A collapsed block's body is folded only if it is CERTAIN.
> **C1** — no line in the body is a reserved (`orchard-*`) opening fence.
> **C2** — every inner fence in the body PAIRS, so the body's fence structure is
> closed and no inner fence is left dangling where this fold's close should be.
> Otherwise the fold ends at the offending line, everything from there is
> re-parsed at top level (landing visible, or as its own block), and the turn is
> flagged **`ambiguous-fold`**. The retained part is re-checked until certain.

Neither condition tracks depth, and neither knows which fence character it is
looking at — there is one fence primitive, so the guard cannot be right for
backticks and wrong for tildes. C1 is a per-line predicate over every body line,
inside inner fences or not. C2 is CommonMark's own pairing rule — a fence closes
on a run of the **same character, at least as long** as its opener — and since
fences do not nest, checking it needs one slot, not a stack. The parser computes
no nesting depth inside a fold at all, which is what makes the class closed rather
than the case fixed. Shapes this makes *unrepresentable*, not merely handled:
any `orchard-*` opener, at any depth, in any order, at any fence length, ending up
inside a fold; and any fold whose own close is in doubt.

C2 **was** a parity tally ("every run length occurs an even number of times"), and
that heuristic was wrong on legal input: a closing fence may be *longer* than its
opener, so ` ```js … ```` ` is one properly paired code block, but the tally saw a
3-run and a 4-run and called both unpaired. Well-formed input got flagged and the
fold was cut early. A false `ambiguous-fold` is not "the safe direction" in any
useful sense — it teaches the reader that the flag is noise, which is how the real
one gets ignored. **Well-formed input reports nothing** is now an invariant of the
suite, asserted over the whole well-formed subset of the generated corpus.

### Line endings

Every rule here is a per-**line** rule, so what counts as a line is settled once,
at the boundary, before any of them run: `\r\n` and lone `\r` are normalised to
`\n` by both halves — the parser (`parseResponseBlocks`) and the render entry
(`renderAssistantText`). Those are CommonMark's three line endings; nothing else
is one to either half, so U+2028/U+2029 and form feed are ordinary characters and
cannot carry a fence past a predicate.

This is not hygiene, it is the same hidden-content class: while lines were split
on `\n` alone, a reserved opener separated by a **lone CR** sat mid-"line", C1 was
structurally blind to it, and an authored `orchard-answer` was folded away with an
empty malformed list. The render half had its own instance — `prose()` strips a
code chunk's first line as its info string, so a lone CR just after a fence run
silently ate the next region. Normalising once, where the text enters, is what
stops each downstream rule from having to remember.

Indentation follows CommonMark too: a fence may be indented 0-3 spaces; a **tab**
is a 4-column stop, so a tab-indented run is not a fence at all — to the parser or
to the renderer.

The cost, stated plainly: a documented `orchard-*` fence written **inside** notes
is promoted to visible and flagged rather than staying folded. That is the correct
direction, and the escape hatch is a 4-space indent (or putting the example in
`orchard-answer`).

The **irreducible ambiguity**, named: a bare ` ``` ` run inside a 4-backtick fold
is, character for character, both the recommended code-fence usage and a mistyped
close. Nothing in the text separates them, and any rule that tried would be depth
reasoning again. C2 resolves it the only safe way — a run that pairs (with a close
of the same width **or wider**) is content, so the recommended pattern keeps
working; a run that never pairs ends the fold, visibly and reported.

The mirror case is different and is deliberately left alone: a **visible** block
swallowing a collapsed opener keeps its content visible and in order, so it is
only *reported* — flagged `nested-opener` — never restructured, because
restructuring it is the only thing that could hide it.

### The info string carries a name and an optional label

Round 12 added one grammar rule, and it is deliberately uniform: the block **name
is the first token** of the info string, and anything after it is free text that
only the metrics read. `orchard-uncategorized` requires one; on any other name it
is legal and inert. Two consequences worth stating, because both touch the
hidden-content class:

- The namespace predicate is **unchanged**. `name` is a prefix of `info`, so
  `info.startsWith('orchard-')` and `name.startsWith('orchard-')` are the same
  test — C1 cannot be weakened by a label, and a labelled reserved opener inside a
  fold still ends it.
- A labelled collapsed opener now **folds** where it used to degrade to visible
  prose (it was an unknown name before). That is inside the invariant, not a
  breach of it: the author wrote a fold, so the content was authored as hidden.
  Flags are worded with the NAME, never the label, so a label can never change
  what a flag means.

## Extension: adding a block later without breaking anything

The vocabulary is intentionally small, so the extension path is load-bearing and
is specified rather than assumed. Three rules make it safe:

1. **Unknown `orchard-*` blocks render their content as prose.** Every renderer
   and every parser must treat a name it does not know as fallback — visible, not
   hidden, not an error. This is what lets a NEW block name ship before every
   reader has been updated: an old renderer shows the content as prose, a new one
   collapses or styles it. Nothing is ever lost in the gap.
2. **Old messages keep working.** A new name only adds a case; it never changes
   how an existing name parses. A transcript written last month renders
   identically under a renderer that knows a new block.
3. **Names are frozen once shipped.** Never repurpose `orchard-notes` to mean
   something else — add a new name instead. Renaming would silently reinterpret
   every archived message, which is the one thing rules 1 and 2 cannot absorb.
   Round 12 obeyed this at some cost: `orchard-answer` was the natural word for
   "responds to what you asked", and it was NOT reused for a DIFFERENT meaning,
   because every archived `answer` block would then have silently acquired a
   meaning its author never chose. Round 15 (FEAT-142) reinstates `orchard-answer`
   in the injected core with its ORIGINAL meaning — the artifact the user asked
   for — which is not a repurpose: archived blocks keep both their rendering and
   their meaning (see Migration). `orchard-notes` remains a frozen legacy alias.

**Adding the SEVENTH category is a decision the metrics make, not a designer.**
The trigger is in the report: one label, or one obvious family of labels, on a
third or more of the declared `orchard-uncategorized` blocks over >= 50 graded
turns. The label the authors wrote is the proposed name. Before adding it, check
the two things that make a name safe: it answers a question none of the three
existing pairs answers, and its definition fits on one line (a name that needs a
paragraph has a soft boundary, and a soft boundary is how the first vocabulary
failed).

Mechanically, adding a block is: add the name to `KNOWN_BLOCKS` in
`public/lib/response-blocks.js` — the ONE grammar module, imported by the browser
renderer (`public/lib/digest.js`) and by the Stop hook
(`scripts/hooks/response-format-gate.mjs`) alike, so display and metrics can never
tell different stories — add a row to `BLOCK_PRESENTATION` in `digest.js` (which
is the only place a display decision is made), and add a line to the injected core
above. If the new name is collapsed by default, add it to `COLLAPSED_BLOCKS` too,
which is what puts it under the certainty guard AND the renderer's single hiding
branch at once. No migration, no version negotiation. (`orchard-finding` was moved
from visible to collapsed in round 13 by exactly those two edits plus one
presentation flag — `preview: true` — which is the check that the extension point
is real rather than documented.)

## What is measured, and how to read it

The Stop hook (`scripts/hooks/response-format-gate.mjs`) is **advisory** — it
reports, it does not block. On every graded turn it appends one line to
`<dataDir>/logs/response-format-metrics.jsonl` (outside the repo) recording
per-category block usage, every declared `orchard-uncategorized` block **with its
author-written label**, and — separately — the size, position, shape tags and a
capped excerpt of each run of loose prose.

    node scripts/lib/format-metrics.mjs report

The report answers two different questions with two different numbers, and its
printed decision rule says which is which: a dominant LABEL means the vocabulary
is missing a name, while loose prose with almost no declared blocks means the
convention is not being followed and a new name would not help. Neither is a hard
violation. The two advisories layer 2 can raise are a structurally broken
`orchard-*` fence (content collapsed or expanded against the author's intent) and
an `orchard-uncategorized` block with no label (which destroys the only signal
that block exists to produce).

## Per-project override / disable

The digest is a client-side render feature. The only project setting is an
opt-OUT flag, default **enabled**, and it gates BOTH layers (injection and
rendering) so the two sides can never disagree:

```json
// project settings (via PATCH /api/projects/:id, or the registry entry)
{ "settings": { "responseDigest": { "enabled": false } } }
```

- `enabled: false` → nothing is injected, the renderer stops parsing, plain prose.
- Unset or `true` → on (the default).
- Read **per render**, so flipping it takes effect on the next transcript render —
  a **client reload** is enough; no server/service restart.

A project can also override the *convention itself* by adding project-local
guidance in its own CLAUDE.md / instructions, or via `responseDigest.guidance`
(a short nudge appended under `## Project override` in the injected section; it
can steer tone and when to emit, but cannot change the fence names or schema).
