```orchard-ticket
{
  "id": "ARCH-008",
  "type": "architecture",
  "title": "Ticket readers disagree about the same file",
  "summary": "The board and ticket page interpret an interrupted record differently, so they can report conflicting states for the same ticket. The record grammar exists in separate implementations, and the browser has already diverged while handling partial writes.",
  "impact_if_we_wait": "The disagreement is latent across 0 of 193 tickets today but reaches every migrated ticket after rollout. Bounded: this affects display-correctness in a single-user local tool, not ticket data, and nothing is destroyed.",
  "current_need": "Build option A in the order the migration section already sets out: move partial-write diagnosis into the portable source first, then serve the parsed record and delete the browser grammar.",
  "severity": "high",
  "area": "Ticket record reading",
  "reported": "2026-08-19",
  "reported_by": "architecture dispatch",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-19",
      "question": "How should the board and ticket page keep one interpretation of ticket records?",
      "mode": "single",
      "options_keys": [
        "A",
        "B",
        "C",
        "D"
      ],
      "chosen": "A",
      "chosen_on": "2026-08-25",
      "chosen_by": "user, through the ARCH-010 class decision",
      "note": "Settled by the class rule rather than as its own question: the owner of the record grammar writes the answer down once and every reader reads it. B keeps two deployed readers and only automates their agreement; C is a check that counts the workings-out, which the class decision rejects by name; D leaves the second place able to hold a different answer. A was already this ticket's own recommendation, so the class confirms it rather than overturning it. The prerequisite was re-checked on 2026-08-25 and holds: no surface parses a ticket file without the server today."
    }
  ],
  "success_criteria": [
    "Every reader identifies record presence, contents, boundaries, and prose identically for every ticket file.",
    "Truncated migrated tickets receive one answer and are never described as never migrated.",
    "The chosen ratchet rejects any unapproved second implementation before it lands.",
    "The board index remains byte-identical throughout the migration.",
    "The portable source remains import-free."
  ],
  "code_refs": [
    {
      "path": "scripts/lib/ticket-schema.mjs",
      "symbol": null,
      "note": "Portable Node source used by board tools, the ticket API, migration, and recurrence detection; it must remain import-free."
    },
    {
      "path": "public/lib/ticket-record.js",
      "symbol": null,
      "note": "Browser-side duplicate containing stronger partial-write handling and an additional informal opener scan."
    }
  ],
  "related": [
    {
      "id": "ARCH-004",
      "relation": "see_also"
    },
    {
      "id": "ARCH-006",
      "relation": "see_also"
    },
    {
      "id": "ARCH-009",
      "relation": "see_also"
    },
    {
      "id": "BUG-111",
      "relation": "see_also"
    },
    {
      "id": "BUG-121",
      "relation": "blocks"
    },
    {
      "id": "BUG-122",
      "relation": "see_also"
    },
    {
      "id": "BUG-123",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "BUG-121",
    "BUG-111",
    "ARCH-008"
  ],
  "verification": [],
  "verification_class": "arch",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/ARCH-008-record-grammar-is-implemented-twice-so-readers-disagree.md",
    "sha256": "2c9514b6d9b87330fce520fbca7e110902d2e81d709b0fda5f5de1e887efd0c4",
    "bytes": 26452,
    "original_title": "the ticket record format is implemented twice, so the board tools and the ticket page already disagree about the same file",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived ARCH-008 text; the measured divergence, recurrence, four options, recommendation, bounds, migration sequence, proof bar, and falsifiers remain.",
    "dropped": [
      "Proposed board index row",
      "Repeated status wording",
      "Out-of-scope table-renderer defect"
    ]
  }
}
```

# ARCH-008 — Ticket readers disagree about the same file

## Diagnosis

The ticket-record boundary grammar is handwritten in both `scripts/lib/ticket-schema.mjs` and `public/lib/ticket-record.js`. The browser copy was hardened independently and now includes another opener scan. Comments are the only synchronization mechanism, so locally correct repairs can leave the readers disagreeing.

## Evidence

A side-by-side diagnostic compared both readers using a complete migrated fixture and the same fixture truncated at four offsets. Both found the complete record. At every truncated offset, the Node reader treated the file as never migrated while the browser reported an opened, unclosed record. The real board contained 0 of 193 migrated tickets when measured. `verify:ticket-view-redesign` is named without an execution result.

## Implementation notes

First move the browser’s partial-write diagnosis into `scripts/lib/ticket-schema.mjs`, then repair BUG-121 there. Under A, extend the ticket endpoint before changing the page, then delete the browser extractor, pattern, and informal scan. Finish with a ratchet appropriate to the selected design.

## Verification plan

Demonstrate that the current truncated fixture fails before changes. Test many truncation offsets and require identical record contents, boundaries, prose, and errors from every remaining reader. Introduce a synthetic second reader and confirm the ratchet rejects it. Compare the board index byte-for-byte after each step.

## Migration and rollback

Land the canonical partial-write repair and BUG-121 before changing ownership of parsing. Under A, add endpoint fields while the page ignores them, then switch the page and delete its parser. Each step is independently useful. Reverting the page switch restores the old reader while leaving unused endpoint fields harmless.

## Risks

A becomes unsuitable if an offline viewer, dropped-file preview, or editor extension must parse files without the server. Sending full block text may add page weight for long activity logs, so offsets may be preferable. If partial-write handling requires imports, it conflicts with the portable source constraint.

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

### 2026-08-25 — settled by the class decision (ARCH-010 option A); no build in this lane

- **Understood:** this ticket was one of eight instances of one habit, and the user settled the
  habit on 2026-08-25 rather than settling eight tickets. Applied here, the rule leaves exactly one
  option standing. The grammar has an owner — `scripts/lib/ticket-schema.mjs`, the portable source
  every Node consumer already imports — and option A is the only one where that owner writes the
  answer down and every reader reads it. B automates agreement between two deployed readers, which
  is the same defect with a generator in front of it; C is a checker over the workings-out, which
  the class decision rejects by name; D leaves the second place able to disagree.
- **Re-measured before recording it, because this ticket is five days old.** Both grammars are
  still present and still by hand: `public/lib/ticket-record.js:46` (`RECORD_FENCE_RE`) and `:61`
  (`RECORD_OPENER_RE` plus the `openerIndex` line scan) against
  `scripts/lib/ticket-schema.mjs:1015`. The fence patterns are still byte-identical; the divergence
  is still the partial-write one this ticket measured — the browser reports `unterminated` and an
  explicit parse error, the Node source reads the same bytes as a legacy ticket. The server still
  sends raw file text (`src/server/tickets.ts:293-304`, `TicketDetail` at `:147-163`), so option A
  is still available and still unbuilt. One fact has moved since 2026-08-19 and it strengthens A:
  the duplication is now **bidirectional** — `scripts/migrate-tickets.mjs:82` and
  `scripts/verify-bug-119-verification-evidence.mjs:56` import the *browser* copy from Node.
- **The prerequisite was checked, not assumed.** "Confirm that no planned surface must parse ticket
  files without receiving the server's result": today's importers are `public/app.js:20`,
  `public/lib/decide.js:23` and the two Node scripts above. No offline viewer, dropped-file preview
  or editor extension exists or is planned on the board. The prerequisite holds.
- **Changed:** this ticket's record only — the decision moved to `decision_history` with A chosen,
  `human_action` is now `none`, and `current_need` states the build. No code, no scripts, no
  `public/`, no `src/`. `work_state` stays `open` because nothing has been built.
- **Verified:** `validateTicket` ok; `npm run board:check` exit 0 read directly. There is no
  behavioural must-fail to show because this lane changed no behaviour.
- **Still open / handoff:** all of the build. Migration step 1 is unchanged and is still the right
  first commit — move the partial-write diagnosis into `scripts/lib/ticket-schema.mjs` so the owner
  answers "is this record complete", then extend the ticket endpoint, then switch the page and
  delete `public/lib/ticket-record.js`'s grammar. `BUG-121` was blocked on this decision and is now
  unblocked. **This is a high-stakes surface** — it decides how every reader classifies a ticket,
  and four defects this week came from it — so the build wants an independent clean-room pass, and
  its first step must be proven against truncations of a REAL ticket file, not a complete fixture.
