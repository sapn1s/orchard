# The counterfactual: what the minimum path was, ticket by ticket

Window: 2026-08-19 21:39Z → 2026-08-20 10:34Z (the ticket-view lane through the
BUG-128 commit), plus BUG-116 and BUG-110 from the preceding day.

This is the judgement half. A parallel lane owns the money; nothing here restates
its numbers. Elapsed spans below are read off commit timestamps, which are free
to count and are not a cost claim. Everything else is read out of the tickets'
own append-only logs.

Read-only analysis. No product code changed, no pipeline was re-run, no
sub-agent was dispatched.

---

## The short answer to "five hours a ticket"

It is true of two tickets in this window and false of the median. Measured from
first to last commit on each ticket's own work:

| Ticket | Rounds | First → last commit | Elapsed |
|---|---:|---|---:|
| BUG-116 (lazy browser shim) | 5 | `df13918` 13:09 → `608064f` 14:52 | 1 h 43 |
| ticket view (FEAT-087 item 4) | 4 | `198013f` 22:09 → `739275e` 00:14 | 2 h 05 |
| BUG-119 (migration evidence) | 3 | `40a8178` 23:12 → `c0e4257` 00:04 | 52 min |
| ARCH-009 (file → build) | — | `f03e937` 00:19 → `568d8da` 01:16 | 57 min |
| FEAT-094 (allow-legacy + cutover) | 1 | `0aadb80` 09:24 → `cea8315` 10:26 | 1 h 02 |
| BUG-126 (severity clamp) | 0 | filed 09:36 → fixed `c0d826c` 10:17 | 41 min |
| FEAT-093 (folded findings) | 0 | `9c03a1a` 00:02 | ~25 min |
| BUG-123 (status cell) | 0 | `efc927b` 01:32 → `27faaad` 01:39 | 7 min |
| BUG-125 (wrapped verdict) | 0 | `5a64311` 09:06 | one commit |
| BUG-127 (index escaping) | 0 | `2b8620e` 10:19 | — |
| BUG-128 (self-relation) | 0 | `f067257` 10:25 | 6 min after BUG-127 |

BUG-125, FEAT-094, the cutover, BUG-126, BUG-127 and BUG-128 — six tickets,
including a 194-file migration, two clean-room-sourced bugs each with a
40-assertion suite, and a real-browser fix — span `09:06 → 10:28`. That is 1 h 22
for six. The thirty-minute ticket is not a fantasy; this board produced several
of them today.

So the complaint is right about a subset and wrong about the median, and the
subset is identifiable **in advance**. It is the lanes where the fixer's own
suite has never once been the thing that caught the defect. FEAT-087's own log
says it in the first person:

> each one passed a large green suite (167, 184, 218, 244 checks) while carrying
> a false statement. The correct reading of that record is not "converging"; it
> is that this lane's own suite has never once been the thing that caught the
> defect.

The suite grew from 167 to 244 assertions across four rounds and its marginal
detection value was zero. Assertion count is not evidence of anything.

---

## The pattern you asked me to be sceptical about: the four ticket-view rounds

Your reading: four consecutive rounds, four real defects, every one a false
*claim* rather than a broken mechanism — evidence the regime works.

**The evidence does not support that framing, and it does not support the
cynical alternative either.** It supports a third thing: the yield decayed
monotonically, round by round, and only the last round is the one your cynical
reading describes. Here are the four, quoted.

**Round 1 → `74e03e2`. Silent data loss.**

> `readTicketRecord` stripped the fenced orchard-ticket block before falling back
> to prose, so when a migrated ticket's record would not parse the ONE text a
> reader needs in order to repair the file was the one text the page could not
> show — while the error note on that same page said the original markdown was
> shown in full.

The mechanism *was* broken. The page deleted content and said it was showing it.
Same round also: 182 of 186 tickets opening with 50 words of empty scaffolding,
and `.tv-dup-title` (`display:none`, gone from the accessibility tree too) firing
on the id prefix alone and "discarding the rest of the heading unread".

**Round 2 → `3931eb3`. Silent data loss.**

> that "verbatim" block was still being handed to `prose()`, whose fence model is
> a character-run split, so a record quoting an inline fence run truncated
> mid-value (46 lines, 30 reachable, `work_state` not among them).

Sixteen of forty-six lines unreachable, in the block captioned verbatim and
whole, including the field the reader came for. Again a broken mechanism.

**Round 3 → `5c945e3`. Mixed: one cosmetic, one wrong claim about a partially
written file.**

> the block's region began at byte 0 rather than at the opening fence (`^\s*`
> matches newlines), so whitespace before the block rode inside a `<pre>`
> captioned "verbatim and whole"; and a partially-written file — opened fence, no
> closing fence — was still being announced as "Not migrated" with a work state
> taken from the board index.

The first half is stray whitespace in a `<pre>`. The second half is real: a file
another process is mid-write is read and given a confident wrong state. That is
the truncated-read class, and it is worth a round on its own terms.

**Round 4 → `739275e`. Wording only.**

> one sentence was written over four different hazard classes and was true of one
> of them: a NUL, a zero-width space and a line separator do not reorder text …
> Also: "This ticket HAS been migrated" is not observable — the view can only see
> that a file *begins* with a record block — so it now says that instead.

No content is affected, no mechanism is wrong, and no user is misled about
anything they can act on. It is a sentence being imprecise about three of four
hazard classes in an error note.

**Verdict.** Data loss → data loss → state claim on a partial write → a sentence.
That is a decaying series, not a stationary one, and the decision you were making
each time ("the round returned a finding, so run another") is insensitive to the
decay. Round 1 and round 2 were worth several times what they cost. Round 4 was
not, and the ticket itself proves it was purchasable for nothing:

> **A fixture that bundles hazard classes into one seed lets a claim be
> accidentally true.** One seed carried a bidi override, two line separators and
> a NUL together; the sentence "these reorder what you see" was true of the bidi
> override, so the seed passed while the sentence was false of three of the four.
> A class per seed is the fix …
>
> **Asserting that a page NAMES a thing is not asserting that what it SAYS about
> it is TRUE.** The suite checked that `U+0000` appeared in the note. It did. The
> sentence beside it was wrong.

One seed per hazard class, and every claim-bearing sentence asserted in both
directions (the right wording present, the other cases' wording absent) are
fixture changes costing minutes. With them in place at the first attempt, round 4
finds nothing — and probably round 3's cosmetic half too. So round 4 was not the
regime working; it was a clean-room round paying retail for a fixture defect.

That is the honest resolution of your two readings. The loop did keep finding
things, and the things kept getting smaller, and you had no rule that noticed.

---

## The larger and more expensive pattern: rounds that rediscovered the fixer's own handoff

This is the finding I would act on first. In this corpus, **a third of the
independent rounds found only defects the fixer had already written down as open
items before commissioning the round.**

**BUG-116, round 2's handoff** (written at `4f8d488`, before the round that
produced round 3):

> an inner shim that accepts the write and then hangs forever without exiting
> (there is no timeout — deliberate …); `stdin` ending with forwarded requests
> still outstanding (`process.exit(0)` runs without draining); and stdout
> backpressure …

The round that followed found exactly two defects: `adversarial-hanging-provider`
(a provider that accepts and never answers → stdout completely empty) and
`adversarial-eof` (stdin EOF discarding an accepted request and exiting 0). Items
one and two, verbatim. A clean-room round plus a full refix lane were spent
converting the fixer's own paragraph into a bug report.

**BUG-116, round 1's handoff** named "two calls in flight at once" and "a partial
JSON line split across two stdin chunks". The next round found out-of-order
replies (six in flight returning `[2,6,4,3,5,1]`) and malformed input being
dropped. One named exactly, one adjacent.

**FEAT-094's still-open list** named "a reason containing a `|`, a newline, or
markdown that could break the index table". The clean-room round found exactly
that, and it became BUG-127. The ticket's own note reads *"it was right to leave
it open."* I disagree: it was right to *name* it and wrong to ship without
running it. The round's second finding, BUG-128 (a ticket related to itself, and
a repair pass that would manufacture a second one from `A --blocks--> A`), was
genuinely unforeseen — the ticket says so: *"This is the one thing the back-edge
audit above did not ask."* That one is what a round is for.

Tally over the ~15 rounds I classified: three findings pre-named verbatim, two
adjacent to a named item, ten genuine. The pre-named third is pure recoverable
waste, and it is the same "documented limitation" anti-pattern the 08-19 cost
analysis already identified and wrote down. It recurred today, after being
written down, which tells you a prose rule did not fix it.

---

## Ticket by ticket: actual path, minimum path, what each round bought

Judged with hindsight but without assuming knowledge nobody had at the time. I
say explicitly where hindsight is doing the work.

### BUG-116 — 5 rounds, 5 commits. Minimum: 3.

Actual: build (`df13918`) → relay rewrite (`4f8d488`) → FIFO removed
(`703a436`) → one ledger (`4954b65`) → derived signal set (`608064f`), then
HOLDS.

Every one of the five defects is the same user harm: a request accepted and never
answered, i.e. a session that hangs forever with no error. Not one was cosmetic.
Class: silent loss, every time.

- Round A bought: malformed input logged and dropped, and replies released out of
  order. **Loss class.** One item pre-named.
- Round B bought: a hanging provider silencing stdout entirely, and EOF
  discarding an accepted request while exiting 0. **Loss class. Both pre-named.**
- Round C bought: `tools/list` + immediate EOF → "exited 0 having written **zero
  bytes** — not an answer, not an error, nothing", because `dispatch()` built a
  local slot without putting it on `outstanding`. **Loss class, genuine.** Round
  3's own EOF tests only ever ended input with *forwarded* work in flight, which
  is why 40 checks passed over it.
- Round D bought: SIGQUIT taking its default action and killing the process with
  the ledger unsettled — the shim registered three signals by hand. **Loss class,
  genuine.**
- Round E bought closure (HOLDS) — and recorded honestly that it was
  same-provider after four failed cross-provider handshakes, so decorrelation was
  reduced.

**Minimum path.** Round B was avoidable at the time, twice over: its two defects
were written down before it ran, and the constraint that created one of them was
invented by the dispatch. The ticket says so plainly:

> The dispatch that produced `4f8d488` told the verifier that replies must be
> released in the order the requests arrived. **That was invented.** It is not in
> this protocol …

Reading JSON-RPC §6 and the MCP base protocol — which round C then did, and which
took one lane a few paragraphs — would have prevented the FIFO, its liveness
defect and the round that removed it. Rounds C and D are the same class as round
D's own fix, *derive the set, do not list it*; applied to both dimensions at once
they collapse into one round. **Minimum: build → one relay round → one
enumeration round → HOLDS.** Three rounds, not five. The two saved rounds are
attributable to two concrete process faults, not to bad luck: a charter that
asserted a requirement the spec does not contain, and a handoff list treated as a
disclosure rather than as work.

### The ticket view (FEAT-087 item 4) — 4 rounds. Minimum: 2.

Covered above. Rounds 1–2 bought silent content loss and were worth it. Rounds
3–4 bought a partial-write state claim and a wrong sentence; with one-class-per-
seed fixtures and two-directional claim assertions in place from the start —
both of which the lane itself derived, at round 4's expense — the minimum is two
rounds. Note the lane also caught, on its own, that "a green assertion and a
wrong screenshot disagreed on three separate occasions in this lane and the
screenshot was right every time". That is a cheaper mechanism than a round and it
was already available.

### BUG-119 — 3 rounds, then an ARCH ticket. Minimum: 3. Nothing to cut.

This is the best-value sequence in the corpus and I would not shorten it.

- Round 1 bought: `not_recorded` still written over 24 finished tickets whose
  evidence the pipeline had already extracted and was holding.
- Round 2 bought a stop-everything defect that was **live on the board**: BUG-109,
  "whose status line reads 'VERIFIED (fixer's own run) — independent clean-room
  verify still required', whose single independent verdict is BROKEN — derived
  `holds`". Plus a quoted verdict promoting itself to a real one "under a comment
  claiming otherwise".
- Round 3 bought two more live mis-derivations at the reviewed revision
  (`FEAT-061` and `FEAT-062` both carrying an outstanding `broken` and both
  deriving `holds`) — upgrading the verdict's own "one log line away" to "already
  live" by measuring in a clean worktree — **and a defect in the fixer's own
  suite**: sections §10c/§10d, the very sections claiming to prove round 2's
  stop-everything defects, were anchored to another lane's uncommitted line and
  "proved nothing at the reviewed revision and would have reddened on a revert".

Every round found a false claim of proof about real work, live on the real board.
That is the highest-harm class this project has. And round 4 is the round I most
want copied: it declined to write a fourth guard and converted the spend into a
decision.

> **§N answered, in one line: the design is wrong, not the fixes.** … So **no
> fourth guard was written.**

That is the correct terminus of an escalating series, and the ticket view did not
reach it.

### FEAT-094 + the cutover — 1 round. Minimum: 1. Correctly scoped.

The round cleared what only a round can clear at this scale: 194 archived
originals byte-identical against the git blobs *and* in a clean room, every index
row pinning the real sha and byte count, every live record's `source.sha256`
matching, near-miss allow-list ids (lowercase, zero-padded, comma-only) none
acting as a wildcard, 768 relation edges audited. It found two defects. This is
the model for the irreversible class: the round attacked byte identity and
refusal, not reasoning.

The half-applied-promotion hazard you cited as a save was **not** bought by the
round. It was bought by the builder testing the charter's hypothesis before
building:

> the move list had to be filtered to staged files (the old code would have
> archived an unstaged original and then failed to find a replacement)

That is the cheapest catch in the window and it cost nothing. (A *different*
half-apply hazard — a `git mv` failing partway through the 194 — is pre-existing
and still open on both FEAT-094 and BUG-127.)

### BUG-125 — 0 rounds, one commit. Minimum: exactly what happened.

A `Verified-by:` line that wraps was read one physical line at a time, so three
`VERDICT: BROKEN` records on FEAT-061 were transcribed as `invalid` and "nothing
anywhere said so". Six records across three tickets changed verdict. The lane
tested the hypothesis against all 70 real records before building, measured that
an unbounded paragraph join would absorb 5–18 lines of prose on four records, and
bounded the join at the first verdict token. Independent verification is
outstanding and warranted (it is the extraction ARCH-009's option C leaves
standing). No waste anywhere in this ticket.

### BUG-126 — 0 rounds, 41 minutes. Minimum: exactly what happened, and it is over-classified now.

One grid cell missing the clamp its four siblings carry. Found by *looking at the
running product*, in a case where "Every DOM assertion in the same pass was green
— 197 rows, 197 unique ids, no empty titles … Nothing mechanical noticed, because
nothing mechanical was looking at row height." The fix ships with the right
property (`no row exceeds 2.5x the median row height`, measured `median=26px,
tallest 26px (1.00x) over 198 rows`) and a must-FAIL anchored to a synthesized
pre-change stylesheet injected over CDP. Its `work_state` is `in_verification`
and its `current_need` asks for an outside re-check. **That round should not be
run.** There is nothing a clean room can add to a measured pixel property over
the real 198-row board in both themes.

### BUG-127 / BUG-128 — 0 rounds each, 6 minutes apart. Minimum: exactly what happened.

Both arrived as clean-room findings, both were reproduced against the real corpus
before anything changed, both shipped with a must-FAIL against a *synthesized*
pre-fix generator gated on a CONTROL that must pass first. BUG-127 also split its
own finding honestly — the newline hazard drops a row in this project's renderer,
the `<!--` hazard does not — rather than smoothing it over. Both now ask for an
independent round. For BUG-128 (a validator every record read goes through, one
live instance, 768 edges swept) that is defensible. For BUG-127 (a generator
whose one real output is proven to regenerate byte-identical) it buys very
little.

### BUG-124 — 0 rounds, and it is the ticket that most needed a sweep instead.

The first pass fixed the two red suites in front of it and closed. The cutover it
was explicitly written to protect against then reddened four more — 180 failures,
none a product defect. Its own reopen entry names the fault: `regressed-from:
BUG-124 — its own fix … It did not go looking for the same fault in the suites
that were still green.` The dangerous one is the third save you cited:

> `verify:ticket-writing`'s must-FAIL corpus was addressed as `docs/bugs` … it
> did not merely go red, it silently RE-AIMED the negative corpus at the
> contract's own output, so the check kept running while measuring the opposite
> of what it meant. It failed only because separation collapsed to 138/198 — had
> the rules been a little more permissive it would have gone green having
> inverted itself.

No independent round caught that. A class sweep did — the thing the first pass
skipped. The minimum path here is one lane, doing the sweep the first time.

---

## Where the regime genuinely saved us — and by which mechanism

You named four saves. Three of them were **not** bought by an independent round,
which is the most useful thing in this document.

| The save | Mechanism that actually caught it | Would a lighter process have shipped it? |
|---|---|---|
| A false "verified" on a ticket carrying an unresolved BROKEN (BUG-107, plus three more in `3288342`) | A record-correction lane reading each status line against the ticket's own verdict list — now a property, `outstandingBroken()` | **It did ship.** It sat on the board for two days and the board displayed it. |
| A fix passing 167 assertions while deleting the content it claimed to show | A cross-provider clean-room round. **Only the round could have caught this.** | Yes, certainly. 167 green assertions and the lane's own screenshot review both passed it. |
| A negative corpus that silently became its own output | A class sweep during BUG-124's reopen | Yes — and it nearly survived *that*, saved only by the rules being strict enough to redden. |
| A promotion that would have half-applied across 194 files | The builder testing the charter's hypothesis before writing code | Yes, and it would have been unrecoverable-ish at 194 files. |

Two further saves worth adding, both from rounds:

- BUG-107's round found that `verify-tool-toggle` assertion (5) had been
  **loosened** — from requiring the exact `uvx` command to accepting any absolute
  path ending in `/serena`, e.g. `/tmp/attacker/serena`. A self-review will never
  find its own weakened assertion.
- BUG-119's round 3 found the fixer's own must-FAIL sections standing on another
  lane's uncommitted line.

So the plain answer you asked for: **yes, the expensive part is earning its keep,
but on a narrower class than it is currently applied to.** What it uniquely buys
is (a) lost-message and hidden-content defects where the failure produces no
error, (b) a verifier's own suite being vacuous or loosened, and (c) claims of
proof about work that was never proven. What it does *not* uniquely buy — and
what three of your four cited saves actually came from — is available far cheaper:
test the hypothesis before building, assert a property over the real corpus, and
sweep the class instead of the instance.

---

## The decision rule

Apply before dispatching. It replaces "which dispatch class is this?" with "what
does a defect here cost the user, and can only a round find it?".

### Gate 0 — before any dispatch (free, and it outperformed rounds today)

1. **Name the artifact the work will be graded against, and make it the real
   one.** Every high-value catch in this window came from a real ticket, the real
   194-file corpus, the real 198-row board, or a real `/proc` count. Every miss
   came from a constructed seed. If the plan grades against a fixture the lane
   will build, that is a stop, not a detail.
2. **The charter states its hypothesis and states nothing the spec does not.** The
   BUG-116 FIFO cost two rounds because the dispatch asserted an ordering
   requirement JSON-RPC does not contain. A charter requirement that is not
   quoted from a spec, a ticket, or the user is a guess and must be labelled one.
3. **Truncate the real artifact if another process writes it.** The ticket view's
   round-3 finding (a partially written file confidently announced) was this
   class; BUG-119's own suite already does it (BUG-098 cut at 11 points).

### Gate 1 — the handoff list is a work queue, not a disclosure

**No round is commissioned while the fixer can name an untested attack.** If the
lane's "still open / handoff" names three attacks, the lane runs them before
returning. The round exists to find the fourth. This single rule removes about a
third of the rounds in this corpus, including two full refix lanes on BUG-116 and
one whole clean-room pass on FEAT-094.

Corollary, from the 08-19 analysis and re-earned today: *a general case a lane
declines to close becomes a filed ticket in the same turn, never a paragraph in
an activity log.*

### Gate 2 — how many rounds, by harm class

| Class | Examples in this window | Rounds |
|---|---|---|
| **Silent loss** — a relay, parser, migration or renderer where the failure produces NO error and the user sees a hang or missing content | BUG-116, ticket view rounds 1–2, BUG-110 | Rounds until one returns only wording or cosmetics. Then stop. |
| **False proof** — anything that can make the record claim work was verified when it was not | BUG-119, ARCH-009, BUG-125 | At least one, cross-provider. Highest priority in the whole scheme. |
| **Irreversible / board-wide** — a cutover, promotion, or schema migration touching every file | FEAT-094 | Exactly one, scoped to byte identity, refusal, and recovery. Not to reasoning. |
| **Claim class** — text asserting something about content it displays correctly | ticket view rounds 3–4, BUG-127 | One, and only after one-seed-per-class fixtures and two-directional claim assertions exist. Otherwise you are buying a fixture defect at clean-room prices. |
| **Contained render / one-cell / CSS** | BUG-126 | Zero. A pixel property over the real board in both themes, with a synthesized pre-change must-FAIL, is the whole proof. |
| **Test-suite-only changes** | BUG-124 | Zero rounds; one class sweep across sibling suites is mandatory instead. |

### Gate 3 — the stopping rule (this is the part you were missing)

Before commissioning round N+1, classify round N's finding by harm class, not by
existence:

- Round N found **silent loss or false proof** → round N+1 is automatic.
- Round N found a **wrong claim a reader could act on** → one more round, and only
  after the fixture defect that let it through is fixed.
- **Two consecutive rounds returning wording-or-cosmetics-only → STOP.** Convert
  the remaining budget into a standing property assertion, or into an ARCH
  question if the findings share an invariant.
- Round N's finding was already on round N−1's handoff list → the round bought
  nothing; the fault is Gate 1, and the count of rounds so far is not evidence of
  a hard problem.

"The round returned a finding" is not a reason to run another. A review loop
given a target will always return something; the question is whether what it
returned is in a class that would have hurt somebody.

---

## Where this contradicts the Working Agreement

Naming sections, as asked, rather than telling you to follow them harder.

**§I, the verification threshold, is the main disagreement.** It reads:

> **Threshold, stated so it is not eroded by exception:** required for `fix`,
> `plan+review` and `arch`. NOT required for `trivial` or docs-only work … That
> line is the whole policy; "just this once" for a `fix` is how it dies.

The threshold keys on *dispatch class*, which is about how well the cause is
understood, and has no term for *what a defect costs*. BUG-126 — a missing
`overflow:hidden` on one grid cell — is a `fix`, so §I requires a round on it;
that round can add nothing to a measured pixel property over the real board.
Meanwhile the same threshold gave BUG-116 (five lost-reply defects) and BUG-126
(one CSS line) the identical obligation. The erosion worry behind that sentence is
legitimate, so the fix is not "use judgement" — it is to **replace the exception
with the named class table in Gate 2**, so the exemption is a list anyone can
audit rather than a plea anyone can make.

**§N is right in prose and has no stopping rule.** It says escalate by
cost-of-mistake and "run an adversarial refute-verify pass", unbounded. It is
what correctly produced BUG-119's five-round escalation and ARCH-009; it is also
what let the ticket view run to round 4 with a decaying yield. Gate 3 is the
missing half of §N.

**§C says generation must not verify itself; nothing says the fixer must run its
own named attacks.** That gap is the pre-named-defect waste — the largest single
recoverable cost I measured. Gate 1 belongs in §C, next to "non-vacuity is
necessary and NOT sufficient", because it is the same argument: a fixer who can
name the gap has no excuse for handing it to a $-per-round process.

**§I, "the orchestrator does not implement", is defensible but is not free.** Six
of this window's commits are single-line bookkeeping (`da26215`, `8215dc1`,
`a09670b`, `d1cacb9`, `8a25435`, `9d06907` — recording a sha, adding an INDEX
row). Each is a dispatch that re-reads the agreement, the conventions doc and a
ticket to change one line. The traceability argument holds; the per-item dispatch
does not. Batch them into one hygiene lane per session.

**One thing the WA gets exactly right and should be promoted, not softened.** The
falsifiable-hypothesis block (§I) is the cheapest defect detector in this window
by a wide margin: it caught the 194-file half-apply on FEAT-094, corrected the
"presentation-layer only" premise on FEAT-093, and confirmed-with-a-correction the
consumer count on ARCH-009. It currently reads as ceremony in the charter
template. It is the highest-yield line in the document.

---

## What I would do differently tomorrow, in order

1. **Gate 1.** Make the handoff list a precondition on the lane, not a note for
   the next one. Largest single saving, no quality cost.
2. **Gate 3.** Classify each round's finding before commissioning the next.
   Would have stopped the ticket view at round 2 or 3.
3. **Promote three cheap mechanisms to standing checks**, because each already
   out-earned a round today: the hypothesis test before building; a property
   asserted over the real corpus (`outstandingBroken()` is the model — it made
   the false-VERIFIED class structurally unrepresentable); and a class sweep
   whenever a fix closes the second instance of anything.
4. **Stop running rounds on the contained-render and suite-only classes.**
   BUG-126 and BUG-127 are both sitting in `in_verification` asking for one.
5. **Fix the fixture habits the ticket view paid to learn** — one seed per hazard
   class, and every claim-bearing sentence asserted in both directions — before
   the next claim-class lane, not after it.

---

## Cost of this analysis

Fourteen tool calls in one session: eleven reads (twelve tickets, the Working
Agreement, the 08-19 cost analysis) and three `git`/`grep` calls. No sub-agents
dispatched, no pipelines re-run, no suites executed, no model calls spent on
anything a `git log` could count. Roughly 6,000 lines of ticket and doc text read;
one file written.

## Method and limits

- Every quotation is from the named ticket's own append-only log or from a commit
  message, both of which are the lanes' self-reports. Where a lane's self-report
  is the only evidence, that is a limit: a lane that misdescribed its own round
  would carry that error into this analysis.
- Harm-class assignment (silent loss / false proof / wrong claim / cosmetic) is my
  judgement from the quoted defect, not a measured category.
- Elapsed spans are first-to-last commit on a ticket's own work and exclude the
  investigation before the first commit, so they **understate** the deep lanes and
  are not a cost figure. The parallel measurement lane owns cost.
- "Pre-named" means the defect a round found appears in the preceding round's
  written handoff. I scored two BUG-116 items as "adjacent" rather than exact and
  counted them separately.
