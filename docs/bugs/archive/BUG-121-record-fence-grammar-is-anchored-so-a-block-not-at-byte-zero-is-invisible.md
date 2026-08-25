# BUG-121 — the record fence grammar is anchored and single-shot, so a block preceded by any non-whitespace text is invisible and the ticket reads as never migrated

- **Status:** OPEN
- **Severity:** medium
- **Area:** ticket record extraction (`scripts/lib/ticket-schema.mjs` `extractTicketBlock`, mirrored in `public/lib/ticket-record.js`)
- **Reported:** 2026-08-19 by the ticket-view content-loss lane (surfaced by the third independent cross-provider round on `3931eb3`; the coordinator ruled it adjacent to that lane's claim and asked for it to be filed, not fixed there)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom

`RECORD_FENCE_RE` is `/^\s*```orchard-ticket…/` — anchored at the start of the
string, with no `m` flag and no second attempt. It therefore recognises a record
block **only** when nothing but whitespace precedes it.

A file with any non-whitespace before the block — a stray line above the fence, a
merge artefact, an editor's inserted heading, a second block later in the file
being the only one — is read as having **no record at all**. It falls to the
legacy path, where the page announces "Not migrated" and draws a work-state pill
taken from the board index. Both statements are false about a file that visibly
contains a record.

This is the same misstatement class as the two already fixed on this path (a
corrupt record reported as "not migrated"; an unterminated record reported the
same way), one grammar rule further out.

## Repro

1. Take any migrated ticket file.
2. Insert a single line of text above the ```` ```orchard-ticket ```` fence.
3. Open it in the ticket view.
4. The hero shows "Not migrated" and a state pill; the human layer is absent; the
   record is rendered as an ordinary fenced code block in the body.

## Expected

A file whose first fenced block is an `orchard-ticket` block has been migrated,
wherever that block sits. The reader should be told the record was found in an
unexpected position and could not be treated as the record — not told the ticket
was never migrated, and certainly not given a state derived from somewhere else.

Whether the right answer is to accept the block, or to refuse it but SAY SO, is
the open question; only "say nothing and invent a state" is clearly wrong.

## Scope note — what is already fixed, so this ticket is not re-litigated

Fixed on `3931eb3`/this lane and NOT part of this ticket:

- an `orchard-ticket` block at byte 0 whose JSON does not parse;
- a block opened and never closed (a partial write);
- whitespace preceding the block (recognised, and excluded from the region shown).

Still open and owned here: **non-whitespace** preceding the block, and a second
block when the first is not at the top.

## Notes

Not investigated in code beyond reading the pattern. No fix attempted:
`scripts/lib/ticket-schema.mjs` is the source of truth for this grammar and is
held by another lane, and `public/lib/ticket-record.js` is required to keep its
extractor byte-identical to it — so this must be fixed in the schema module
first, then mirrored, or the mirror rule is broken.

**Proposed INDEX row** (the filing lane does not edit `INDEX.md`):

`| BUG-121 | the record fence grammar is anchored, so a block not at the top is invisible and the ticket reads as never migrated | — | open | medium |`

**Symptom of a deeper design flaw?** yes — one grammar is duplicated across a
node module and a browser module with a "keep byte-identical" comment as the only
enforcement, so a fix has to land twice and nothing fails if it lands once. Worth
an ARCH ticket if a third instance appears; BUG-120 and this ticket are the first
two.

## Activity log (APPEND-ONLY)

### 2026-08-19 — ticket-view content-loss lane

- **Understood:** the third independent round on `3931eb3` noted that
  `RECORD_FENCE_RE` is anchored with no `m` flag, so a block preceded by
  non-whitespace, or a block that is not the first thing in the file, is not
  recognised at all — and the page then reports "Not migrated" and a state pill
  from the board index. It called this the largest reachable hole adjacent to
  that lane's claim, and out of its diff.
- **Changed:** nothing. This ticket only.
- **Verified:** nothing. The mechanism is read off the pattern, not reproduced.
  The adjacent cases WERE reproduced and fixed in that lane and are listed under
  "Scope note" so they are not re-tested here.
- **Still open:** all of it. Decide accept-vs-refuse; fix in
  `scripts/lib/ticket-schema.mjs` first and mirror into
  `public/lib/ticket-record.js`, never the other way round.
- **Handoff:** next agent should decide the accept-vs-refuse question BEFORE
  touching the regex — relaxing the anchor changes what counts as a record for
  every node consumer too, not just the view, and `verify:ticket-schema` and
  `verify:migrate-tickets` both encode the current answer.
