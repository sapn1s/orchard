# ARCH-008 — the ticket record format is implemented twice, so the board tools and the ticket page already disagree about the same file

- **Status:** OPEN — NEEDS A HUMAN DECISION (4 options below). **No build starts until an option below is chosen.** Recommended: A — it is the only option that deletes the second implementation instead of keeping two in step, and it is free today because no ticket on the board uses the record format yet; B would regenerate the browser from the copy that is currently the more BROKEN of the two, C prices in a fix that must always land twice in two files held by two different people, and D is only cheap until the migration runs.
- **Severity:** medium. Nothing is wrong on the board today — the measurement below found the format in use on **0 of 193** ticket files, because the migration has not run. It is medium rather than low because the two readers already give different answers about the same bytes, with nothing reporting it, and the migration is what turns that from a latent fact into 193 files. It is not high: this is a single-user local tool, no data is destroyed, and the wrong answer is a misstatement on a page rather than a lost ticket.
- **Area:** how a ticket file is read — the board tools and the ticket page
- **Reported:** 2026-08-19, by an architecture dispatch asked to turn BUG-121's deeper-flaw note into a decision. BUG-121 pre-committed to handing the class forward ("worth an ARCH ticket if a third instance appears") and declined to file it from inside a fix lane.
- **Recurrence evidence:** BUG-121 (one defect in the shared pattern, which must therefore be repaired in two files); the partial-write disagreement measured in this ticket, which is **not** covered by any open ticket; and a third, informal opener scan added beside the pattern it was meant not to duplicate, flagged by the person who wrote it.

## What this is about, for a reader who has not opened these files

Tickets are being moved from free prose to a format where each file starts with a
fenced block holding the ticket's fields as data. Two different programs have to
read that block: the **board tools and the ticket API** (which decide whether a
ticket is open or done, and build the board index) and the **ticket page in the
browser** (which draws the ticket). They are separate programs in separate
runtimes, so each has its own copy of the rule for where the block starts and
where it ends.

Nothing keeps the two copies in agreement except a comment in one of them asking
the next person to keep them identical.

## Violated invariant

**Every reader of a ticket file must return the same answer to "does this file
carry a record block, and where does it end" — for every byte sequence, not only
for well-formed ones.**

That is testable as stated, two ways with very different strength. Behaviourally:
for any byte sequence, the board tools' extractor and the ticket page's extractor
agree on whether a record is present, on its exact contents, and on which part of
the file is prose. Structurally: exactly one implementation of that rule exists,
so the behavioural property is true by construction rather than by sampling.

Every instance below is a different way of breaking that one sentence.

## The design that produces this class

The rule for reading a ticket file is written **twice, by hand**:

- `scripts/lib/ticket-schema.mjs` is the source of truth for everything that runs
  under Node — the board generator, the board consistency check, the ticket API,
  the migration tool, the recurrence detector. That file is also **copied
  verbatim into other repositories** when they are set up with this board, which
  is why it is deliberately a single file with **no imports at all**. That
  constraint is real and load-bearing: it is what makes the file portable, and any
  option that requires it to import something is not an option.
- `public/lib/ticket-record.js` is the browser's copy. Only files under `public/`
  are served, so the Node module is not reachable from the page. Its comment says
  it duplicates "exactly one thing — the block extractor, ~10 lines" and asks that
  the pattern be kept byte-identical.

The comment is the entire enforcement. There is no test, no generator and no
build step that compares the two — searched for and confirmed absent. So the
default outcome of fixing a bug in this rule is that it lands in one file, both
files keep passing every check, and the two programs quietly start giving
different answers about the same ticket.

That is not a hypothetical. It has already happened, and the second half of the
design is why: **the two copies are held by different people at different times.**
The browser copy was hardened by the lane that owns the ticket page; the Node copy
was held by another lane and did not receive the same hardening. BUG-121 says this
explicitly — it declined to fix its own defect because the file it must be fixed in
belongs to someone else, and fixing only the reachable half would break the
identical-copies rule.

The third symptom is what a duplicated grammar does when you cannot touch the
canonical one: the browser copy now carries a **second, informal rule** for
recognising a record opener, written line-by-line beside the pattern it was
supposed not to duplicate. Its author flagged it in its own comment. One grammar
is now three.

## What has actually gone wrong — measured, not read off the code

Two readers, one file, run side by side over the real board and over a
realistic-state fixture (declared synthetic: **no ticket on this board is in the
record format yet**, so the fixture is a real ticket's prose carried through the
migration tool's own writer):

| the file | the board tools say | the ticket page says |
|---|---|---|
| a complete record | record found | record found |
| the same file **cut off part-way through the record** | no record — treats it as a ticket that was never migrated, and reads its state from the prose | record found, opened and never closed — reports the file as half-written |
| a stray line above the block | never migrated (BUG-121) | never migrated (BUG-121) |

The middle row is the live disagreement, and the cut-off file is the realistic
case, not an exotic one: the migration tool writes these files, so a file caught
mid-write, or interrupted, has exactly that shape. Truncating the fixture at four
different offsets produced the disagreement at every one of them.

The consequence in the reader's terms: after the migration runs, a half-written
ticket would be listed on the board with a state taken from its old prose, while
the ticket page for the same file says the record is broken. Neither surface is
wrong on its own terms, nothing flags the difference, and the two answers are
reached from the same bytes.

## Why the local patches did not hold

Each was correct. None of them could stop the next.

- **The ticket page's partial-write fix** taught the browser to recognise a block
  that is opened and never closed, so a half-written file stops claiming it was
  never migrated. Correct, verified in a real browser, and the reason the two
  copies now disagree — the identical fix in the Node module was out of that
  lane's reach.
- **The informal opener scan** was the only way to make that fix without editing
  the shared pattern. It works. It also created the third implementation of "what
  a record opener looks like", inside the file whose whole justification is that
  it duplicates as little as possible.
- **The anchored-pattern defect (BUG-121)** found a defect in the pattern itself (a block preceded by any
  ordinary text is invisible, so a migrated ticket reads as never migrated). It
  correctly did not fix it: the repair has to land in the Node module first and
  then be mirrored, and its handoff says so. It is open, and it is one defect that
  will cost two commits in two files owned by two lanes, kept in agreement by
  someone remembering.

The pattern is the argument: a fix inside one copy cannot make the other copy
right, because the duplication is the default and every fix has to opt out of it
by hand.

## What this ticket does NOT claim

The dispatch that raised this listed a longer set of defects. Two of them do not
belong to this class, and saying so is part of making this decidable:

- **The lone carriage return that ate a region** is a different class with its own
  filed decision — line-ending normalisation owned per-renderer, ARCH-006.
- **The over-wide table row that dropped a cell** is a plain defect in one table
  renderer. Its own ticket establishes it is independent of the line-ending class,
  and it is not a duplication defect at all.
- **The seven rounds on the status-line grammar** (ARCH-004's work) are a single
  implementation being hardened round after round, not two copies drifting. Same
  file, different failure mode.
- **The fence model in the shared markdown renderer** disagreeing with the block
  grammar (BUG-111) is genuinely the same *shape* — one grammar, two hand-written
  implementations, kept in agreement by nobody — but it is a different pair of
  files, it already has a ticket, and it is sequenced behind other work. It is
  cited here as evidence that this shape recurs in this codebase, not claimed as
  scope.

Scope of this ticket is exactly the ticket record format and its readers.

## Decision — should the browser stop reading ticket files, or should the two copies be kept in step mechanically?

- **A — Parse on the server, ship the result.** The server already opens the
  ticket file and already sends its entire text to the page; it would also send
  the parsed record, the block exactly as it appears in the file, and any parse
  error. The browser then holds no rule for reading a ticket file at all — the
  copy and the informal opener scan are deleted, not synchronised. *Cost:* one
  change to what the ticket endpoint returns and one to what the page reads;
  the block's text is sent alongside the file text it is already sending, so a
  very long ticket is carried twice unless offsets are sent instead. *Why it is
  not obviously right:* it assumes no surface will ever need to read a ticket
  file the server has not seen — an offline view, a drag-in-a-file preview, an
  editor extension — and if one appears, the second implementation comes back.
- **B — Generate the browser's copy from the source of truth.** Keep two files,
  but produce the browser one mechanically from `scripts/lib/ticket-schema.mjs`,
  and fail the commit gate when it is stale. *Cost:* a small generator and a gate
  check; no runtime behaviour moves. *Why it is not obviously right:* the two
  copies are not equal today and the **canonical one is the more broken of the
  two** — regenerating right now would overwrite the browser's partial-write fix
  and restore the "never migrated" misstatement on half-written files. It also
  still ships a grammar to the browser, so the next fix that cannot reach the
  canonical file gets written beside it, which is precisely how the third
  implementation arrived.
- **C — Keep both copies, add a check that they must agree.** Leave the code as
  it is and add a test that runs both extractors over the same corpus — real
  ticket files, a migrated file truncated at many offsets, adversarial byte
  sequences — and fails on any disagreement. *Cost:* a day; nothing moves; it
  would have caught today's divergence, which is its honest strength. *Why it is
  not obviously right:* it makes permanent duplication official — every future
  fix must land twice, in two files that different people hold, and the check goes
  red the moment the first half lands, blocking the second lane until it does —
  and a corpus can only sample the byte sequences a file can take.
- **D — Change nothing and keep patching.** *Price, stated rather than defaulted
  into:* today it is genuinely zero, because 0 of 193 tickets use the format.
  After the migration it is 193 files on which the board and the ticket page can
  answer differently with nothing reporting it, plus one already-open defect that
  costs two coordinated commits, plus the standing cost that every hardening round
  on this rule — there have been three — protects one reader and leaves the other
  exposed. Defensible only if the migration is being abandoned; otherwise this is
  the most expensive option, and it is the only one whose price goes **up** the
  longer it is deferred.

## Migration path

Each step lands and is verifiable alone, and each is useful even if the next never
lands. Steps 1 and 2 are worth doing under **any** option, including D.

1. **Move the partial-write diagnosis into the source of truth.** Teach
   `scripts/lib/ticket-schema.mjs` the case the browser already knows: a block
   opened and never closed is a half-written record, not a ticket that was never
   migrated. This is pure string work, so the no-imports portability rule is
   untouched. This alone closes the disagreement measured above, and it is the one
   step every option needs.
2. **Fix BUG-121 in that same file** — a record block is recognised, or refused
   with a stated reason, wherever it sits — and mirror it, once, under whatever
   rule step 3 or 4 establishes. Doing it after step 1 means one file changes, not
   two on different days.
3. **If A: the server sends the parsed record.** Add the record, the block's exact
   text (or its offsets) and any parse error to what the ticket endpoint returns.
   The page ignores them; nothing changes on screen. Verifiable on its own by
   comparing the endpoint's answer to the board tools' answer over every ticket.
4. **If A: the page reads them, and its copy is deleted.** Remove the browser's
   extractor, its pattern and its informal opener scan. The page's job shrinks to
   drawing what it is handed. Rollback is one revert; step 3's fields stay harmless
   if unused.
5. **Add the ratchet.** A check that the browser code contains no implementation of
   the record fence rule (under A), or that the generated copy is current (under
   B), or that the two agree over the corpus (under C). Whichever option wins, the
   property stops depending on a comment.

Throughout: the board keeps generating, `board:check` keeps passing, and the
migration tool is untouched. Steps 3–5 are the only ones that need the two lanes
that hold these files to be free at the same time.

## Proof bar — what would have to be true to call the new design right

- **The disagreement is unrepresentable, not merely absent.** Under A, the browser
  contains no rule for finding a record block — checkable by searching the served
  files for the fence marker in executable code and finding none. This is the
  property no test over a corpus can give, because a corpus only samples inputs.
- **A half-written file gets exactly one answer.** Take a real migrated ticket, cut
  it at many offsets, and confirm the board tools and the ticket page report the
  same thing at every one — and that it is never "this ticket was never migrated".
  This test must FAIL against today's code; it does, and the failing output is
  recorded in this ticket's evidence table, so it is not a check that could only
  pass.
- **A synthetic new reader is caught.** Add a second place that tries to recognise
  a record block; the ratchet must fail before it can land. A check that can only
  fail on the two files we already know about proves nothing.
- **No ticket moves.** The board index is byte-identical before and after every
  step, over all 193 real files.

**What would falsify this:** if a surface appears that must read a ticket file the
server has not parsed — an offline viewer, a file dropped into the page, an editor
preview — then A is the wrong call and B is the honest answer, because the browser
genuinely needs the grammar and the only question left is how the copy is
maintained. Equally falsifying: if sending the block's text with the file text
turns out to cost real page weight on the longest tickets (some carry very long
activity logs), then A needs offsets rather than a copy — that is a variant of A,
not a refutation. And if step 1 shows the partial-write case cannot be expressed
without an import, the portability rule and A are in conflict and the decision must
be reopened; the measurement says it can, since the browser does it in pure string
operations today.

## Decision record (filled in once an option above is chosen)

- **Chosen option:** — (pending; human decision required)
- **Explicitly rejected:** — (record here with the reason, so the next round inherits the judgement)

## Proposed INDEX row (the filing lane does not edit `INDEX.md`)

`| ARCH-008 | the ticket record format is implemented twice, so the board tools and the ticket page already disagree about the same file | 👤 | OPEN — NEEDS A HUMAN DECISION (4 options below). **No build starts until an option below is chosen.** Recommended: A — it is the only option that deletes the second implementation instead of keeping two in step, and it is free today because no ticket on the board uses the record format yet; B would regenerate the browser from the copy that is currently the more BROKEN of the two, C prices in a fix that must always land twice in two files held by two different people, and D is only cheap until the migration runs. | med |`

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-19 — architecture dispatch (no build)

- **Understood:** asked to test, before writing, whether a list of recent parser
  defects is one class produced by one design. It is not, as listed. Confirmed as a
  class: the ticket record format is implemented twice by hand (Node module,
  browser module) with a comment as the only enforcement, and a third informal
  opener scan has been added beside it. Excluded from the class, with reasons in
  the ticket: the lone-carriage-return defect (owned by ARCH-006), the over-wide
  table row (an independent renderer defect), and the status-line grammar rounds
  (one implementation being hardened, not two drifting). The markdown renderer's
  fence model versus the block grammar is the same shape in a different pair of
  files and is cited as corroboration only — it has its own ticket.
- **Checked for an existing mechanism before proposing one**, per the rule about
  surveying what exists: there is no generator, no shared module and no test
  comparing the two copies. The Node side genuinely has ONE parser — the board
  generator, the board check, the ticket API, the migration tool and the
  provenance check all import it, so this is specifically a Node-versus-browser
  split, not a general sprawl. The server currently parses ticket files in
  legacy-only mode and sends the raw file text, which is why the browser parses at
  all; that is what makes option A available.
- **Verified (measurement, not reading):** ran both extractors side by side.
  Over the real board, 193 ticket files, **0** carry a record block and the two
  agree on all 193 — the format is not in use yet, which is the single most
  important fact for pricing every option. Over a realistic-state fixture
  (declared synthetic, since no real migrated ticket exists: a real ticket's prose
  written out by the migration tool's own writer) the two **disagree on every
  truncation tested** — four offsets, all four disagreeing: the board tools report
  no record and fall back to prose, the ticket page reports a record opened and
  never closed. BUG-121's own case (a stray line above the block) reproduced as
  described, both readers saying "never migrated". The two probes were written to
  a scratch directory (`arch-fence/probe.mjs`, `arch-fence/probe2.mjs`) and are
  not committed; each is ~30 lines that imports both extractors and prints their
  answers side by side, and either is faster to rewrite than to find.
- **Changed:** this ticket only. No code, no scripts, no `public/`, no `src/`. Did
  not run `board:gen` (the board index is orchestrator-owned) and did not touch
  ARCH-005.
- **Still open / handoff:** a human picks A, B, C or D. Two things are worth
  knowing before that choice and neither is expensive: the partial-write
  disagreement measured above **has no ticket of its own** and is fixed by
  migration step 1 under every option, including "do nothing"; and BUG-121 should
  not be worked until this is decided, because relaxing that pattern changes what
  counts as a record for every reader, not only the page. Owner flip to 👤 on the
  board index is needed for the decision card to render, and that file is the
  orchestrator's.

### 2026-08-20 — ticket-view lane (evidence only; no code, no recommendation change)

Handed over at the coordinator's request: the grammar-disagreement measurement this
ticket's decision lacked. **Nothing in the body above was edited — not the
recommendation, not the options, not the evidence table.** Nothing was built. This
entry adds measurement and says what it does and does not change.

**What was measured.** Ten byte sequences that vary the SHAPE of the fence, each
asked of all three readers named in this ticket: `scripts/lib/ticket-schema.mjs`'s
extractor (Node), `public/lib/ticket-record.js`'s mirrored pattern (browser), and
the informal `openerIndex` line scan this lane added beside it. Run through the
real server and a real browser as part of `verify:ticket-view-redesign`, so the
page's answer is the rendered answer, not a module return.

| the file | Node pattern | browser pattern | opener scan | the page says |
|---|---|---|---|---|
| opener indented with spaces | record | record | opener | broken record |
| opener indented with a tab | record | record | opener | broken record |
| info string with trailing spaces | record | record | opener | broken record |
| opener inside a blockquote | none | none | none | never migrated |
| opener inside a list item | none | none | none | never migrated |
| four-backtick fence | none | none | none | never migrated |
| tilde fence | none | none | none | never migrated |
| info string in unusual casing (`Orchard-Ticket`) | none | none | none | never migrated |
| opener nested inside another fence | none | none | none | never migrated |
| opener inside an earlier code block | none | none | none | never migrated |

- **The two hand-written copies of the pattern agree on 10 of 10.** The
  byte-identical mirror is intact today for fence-shape variation.
- **The pattern and the informal opener scan disagree on 0 of 10.** The third
  implementation does not accept anything the pattern refuses, nor refuse anything
  it accepts, across every fence shape tested.

**What this does NOT weaken, stated first so the table is not read as more than it
is.** It does not touch the truncation disagreement in the body's evidence table.
That disagreement is real, present, and is the direct consequence of this lane's
partial-write fix landing in the browser and not in the Node module — Node reads a
half-written file as never migrated and falls back to prose, the page reads it as a
record opened and never closed. Re-measured here at 9 truncation offsets inside the
record, all 9 behaving as the body describes. Nothing below reduces that.

**What it does change, and it is narrowing rather than reassuring.** The body
describes the third implementation as "one grammar is now three", with the
implication that it is a third independent source of divergence. Measured, it is
not: its behaviour differs from the pattern's in exactly ONE respect — recognising
a block that is opened and never closed — and agrees everywhere else tested. Its
blast radius is one behaviour, and it is precisely the behaviour **migration step 1
already proposes to move into the source of truth**, under every option including
D. That is evidence FOR step 1 being the right first move and for it being
sufficient to close the measured divergence, not evidence for or against any of A,
B, C or D.

The honest consequence for urgency is narrow and applies to one clause: the risk
carried by the two mirrored copies is **drift** (nothing enforces the comment), not
present divergence (they agree on every shape tested). The risk carried by the
third implementation is one named behaviour, fixable in one file. The body's
severity argument — that the migration turns a latent fact into 193 files, and that
the price of D is the only one that rises — is unaffected by this measurement, and
this entry does not propose changing it.

**A second finding, cited as evidence for BUG-121, not fixed.** On the six files no
reader recognises, the page renders the block as an ordinary fenced code block, and
`prose()` strips a fenced block's info string. So `orchard-ticket` — the only text
on the page saying the file was ever migrated — never reaches the reader. An
unrecognised record is therefore not merely refused; it is refused *silently*, with
the one clue removed. That is BUG-111's info-string strip in `public/lib/dom.js`,
a different pair of files, and it is cited here exactly as this ticket cites
BUG-111 elsewhere: corroboration, not scope. It strengthens BUG-121's case that a
refusal must be **stated** rather than implied.

**What is asserted in the suite from now on**, chosen because it holds whichever
option a human picks and therefore cannot bias the decision: across all ten
grammar cases, no file loses content (39 lines, 0 unreachable in the rendered DOM),
no file makes the page claim a work state it cannot read, and the info string is
only ever lost on a file no reader recognised — never on one the page reads as a
record, where it sits in a `<pre>` text node and cannot be stripped. `openerIndex`
is now exported so both grammars can be asked the same question directly; that is
test surface for this ticket's option C, and it is equally deletable under A.

**Changed:** this ticket only, this entry only. No code, no `scripts/`, no
`public/`. Did not run `board:gen`, did not edit `INDEX.md`, did not touch
ARCH-005, and did not alter the Decision, the Migration path or the Proof bar.

**Handoff unchanged:** a human still picks A, B, C or D. If it helps sequencing:
migration step 1 is now measured to be the whole of the currently-observable
divergence, so it can be taken immediately and alone without pre-empting the
decision.
