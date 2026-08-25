```orchard-ticket
{
  "id": "BUG-121",
  "type": "bug",
  "title": "Tickets with a record block below the top read as never migrated",
  "summary": "A ticket file whose record block has any text above it is read as having no record at all. The page then announces the ticket was never migrated and shows a work state taken from the board index, both false about a file that visibly contains a record. Corrupt, unterminated and whitespace-preceded blocks were already fixed separately.",
  "impact_if_we_wait": "A reader is told a migrated ticket is unmigrated and shown a state pulled from elsewhere. Bounded: this is display-correctness only. The file on disk is untouched, and the record still renders as a plain code block in the body.",
  "current_need": "Decide whether a record block below the top should be accepted or refused with a visible message saying it was found out of position.",
  "severity": "medium",
  "area": "Ticket record extraction",
  "reported": "2026-08-19",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "decide",
  "updated": "2026-08-19",
  "decision": {
    "mode": "single",
    "question": "Should a record block that is not at the top of the file be accepted, or refused out loud?",
    "options": [
      {
        "key": "A",
        "label": "Accept a block anywhere",
        "what_changes": "The reader scans the whole file and treats the first record block it finds as the record, wherever it sits.",
        "benefit": "A file with a stray line above the block renders its human layer normally.",
        "cost": "A record block quoted inside prose, as an example, would be read as the file's own record.",
        "why_not_obvious": "Widening the grammar makes a documentation example indistinguishable from a real record, and the page would show that example's state as the ticket's."
      },
      {
        "key": "B",
        "label": "Refuse out of position and say so",
        "what_changes": "The reader still requires the block at the top, but the page reports that a record was found in an unexpected position.",
        "benefit": "The false claim disappears without loosening what counts as a record.",
        "cost": "A file with one stray line above the block still shows no human layer until someone edits the file.",
        "why_not_obvious": "It leaves a real record unreadable, so a reader who cannot edit the file gets an accurate message and nothing else."
      }
    ],
    "recommendation": null,
    "recommendation_reason": null,
    "prerequisite": "Establish whether a record block is ever legitimately quoted inside a ticket's prose. If it is, accepting any block anywhere stops being safe."
  },
  "decision_history": [],
  "success_criteria": [
    "A file with one line of text above the record block does not report the ticket as unmigrated",
    "No work-state pill is drawn from the board index for a file that contains a record block",
    "The node extractor and the browser extractor agree on every input"
  ],
  "code_refs": [
    {
      "path": "scripts/lib/ticket-schema.mjs",
      "symbol": "extractTicketBlock",
      "note": "the fence pattern is start-anchored with no multiline flag and no second attempt; source of truth for this grammar, so the fix lands here first"
    },
    {
      "path": "public/lib/ticket-record.js",
      "symbol": null,
      "note": "required to stay byte-identical to the extractor above; a fix that lands only here breaks the mirror rule and nothing fails"
    }
  ],
  "related": [
    {
      "id": "ARCH-008",
      "relation": "depends_on"
    },
    {
      "id": "BUG-120",
      "relation": "see_also"
    },
    {
      "id": "BUG-122",
      "relation": "blocks"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-121-record-fence-grammar-is-anchored-so-a-block-not-at-byte-zero-is-invisible.md",
    "sha256": "aa3bc0cce00c51df143efb5c8e844540935682c2faeb31ff21fbde599d9653a1",
    "bytes": 4925,
    "original_title": "the record fence grammar is anchored and single-shot, so a block preceded by any non-whitespace text is invisible and the ticket reads as never migrated",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Read against the original head section by section; the anchored-pattern diagnosis, the repro, the already-fixed exclusions, the mirror constraint and the open accept-or-refuse question are all present.",
    "dropped": [
      "the verification-class line, which is carried as a field",
      "the reported-by attribution line, which is carried as a field"
    ]
  }
}
```

# BUG-121 — Tickets with a record block below the top read as never migrated

## Diagnosis

### The grammar

The record fence pattern is anchored to the start of the string, carries no multiline flag, and makes no second attempt. It therefore recognises a record block only when nothing but whitespace precedes it.

Any non-whitespace above the fence — a stray line, a merge artefact, an editor's inserted heading, or a second block later in the file being the only one — makes the file fall to the legacy path. There the view announces "Not migrated" and draws a work-state pill sourced from the board index. Both statements are false about a file that visibly contains a record.

### Scope

Already fixed on `3931eb3` and not part of BUG-121: a block at byte 0 whose JSON does not parse; a block opened and never closed; whitespace preceding the block, which is recognised and excluded from the region shown. Owned here: non-whitespace preceding the block, and a second block when the first is not at the top.

### The duplicated grammar

One grammar lives in both a node module and a browser module, with a "keep byte-identical" comment as the only enforcement. A fix has to land twice and nothing fails if it lands once. This ticket and BUG-120 are the first two instances; a third would justify raising an architecture ticket.

## Evidence

### Repro

1. Take any migrated ticket file.
2. Insert a single line of text above the `orchard-ticket` fence.
3. Open it in the ticket view.
4. The hero shows "Not migrated" and a state pill, the human layer is absent, and the record renders as an ordinary fenced code block in the body.

### Provenance

Surfaced by the third independent cross-provider round on `3931eb3`, from the ticket-view content-loss lane. The coordinator ruled it adjacent to that lane's claim and asked for it to be filed rather than fixed there.

Nothing was investigated in code beyond reading the pattern, and no fix was attempted.

### Same class as two already-fixed faults

A corrupt record was reported as "not migrated", and an unterminated record was reported the same way. This is that misstatement one grammar rule further out.

## Implementation notes

The schema module is the source of truth for this grammar and is held by another lane. The browser module is required to keep its extractor byte-identical to it. The fix must therefore land in the schema module first and then be mirrored, or the mirror rule is broken.

Proposed board row, since the filing lane does not edit the index:

`| BUG-121 | the record fence grammar is anchored, so a block not at the top is invisible and the ticket reads as never migrated | — | open | medium |`

## Verification plan

Independent verification is required before this can be called verified. `verify:ticket-schema` and `verify:migrate-tickets` are the suites named as the place such a case would be exercised; neither has been run against this fault. A check must cover a block preceded by non-whitespace, and a second block when the first is not at the top, and must assert that the node and browser extractors agree.

## Risks

Accepting a block anywhere in the file widens what counts as a record, and a block quoted as an example inside prose would then be read as the file's own record.

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
