```orchard-ticket
{
  "id": "BUG-133",
  "type": "bug",
  "title": "Promoting a few tickets erases the archive record of the rest",
  "summary": "The archive keeps each rewritten ticket's original wording and an index proving by checksum that the copy is untouched. That index is rebuilt from scratch on every promotion, from only the tickets moved in that run. Promoting two onto a board of two hundred archived rewrites it to two entries and reports success.",
  "impact_if_we_wait": "The next promotion of a small batch destroys the provenance record for every ticket archived before it, silently. Bounded: the archived originals themselves are untouched and the index is recoverable from version control, but only if someone reads the change before committing it.",
  "current_need": "Keep the entries already in the archive index and merge the new ones in, rather than rewriting the file from the current run alone.",
  "severity": "medium",
  "area": "Ticket archive",
  "reported": "2026-08-20",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-20",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Promoting a small batch leaves every entry already in the archive index in place",
    "The entries added by a run appear alongside the existing ones, in a stable order",
    "Every entry still names its ticket, its size and its checksum",
    "A promotion that would drop an existing entry fails instead of writing the file"
  ],
  "code_refs": [
    {
      "path": "scripts/migrate-tickets.mjs",
      "symbol": "promote",
      "note": "builds the index rows from the current run's moves only, then writes the file unconditionally; with nothing merged in, a two-ticket run replaces two hundred rows with two"
    }
  ],
  "related": [
    {
      "id": "FEAT-094",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format from a finding made while preparing an incremental promotion. There is no legacy original.",
    "dropped": []
  }
}
```

# BUG-133 — Promoting a few tickets erases the archive record of the rest

## Diagnosis

When a ticket is rewritten into the record format, its original wording is moved
into the archive untouched, and an index file lists what was archived: the ticket,
its size, and a checksum that proves the copy matches what the rewritten record
claims it was made from. That index is the only place the proof lives.

The promotion step builds that file from the tickets it moved in that run and then
writes it out, replacing whatever was there. On the first run this was right — the
run moved everything. On any later run it is wrong, and wrong in proportion to how
well the work has gone: the more tickets already archived, the more proof a small
promotion destroys.

The tickets themselves are not touched. Only the record of them is.

## Evidence

Found while preparing to promote two tickets onto a board where 194 were already
archived. The index holds 194 entries; the run would have moved 2; the file is
written unconditionally from the run's own list. The result is a 2-entry index and
no proof for the other 194, with the promotion reporting success.

Not triggered — the promotion was parked before it ran, so the archive is intact.

## Risks

Recoverable from version control, which is what keeps this out of the high band.
The hazard is that it is silent: nothing fails, nothing warns, and the loss is
visible only to someone who reads the change before committing it. A person
promoting a couple of tickets has no reason to expect the archive index in the
diff at all.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — found while parking the conversion work

- **Found:** preparing an incremental promotion of two tickets; read `promote()`
  before running it.
- **Changed:** nothing. Logged and parked under the standing direction that only
  defects blocking real use are fixed now.
- **Still open:** the fix is scoped — keep the existing index's rows, merge the
  run's rows in, sort by filename — and deliberately not written.
