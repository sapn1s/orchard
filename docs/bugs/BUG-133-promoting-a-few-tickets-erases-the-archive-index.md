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
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-09-05",
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

### 2026-09-05 — fixed: the archive index is now cumulative, and a would-drop refuses

- **Hypothesis confirmed (not assumed).** The diagnosis holds exactly: `promote()`
  built `indexRows` from `moves` (the current run's tickets) and wrote
  `fs.writeFileSync(archive/INDEX.md, index)` UNCONDITIONALLY, with no read of the
  existing index and no merge. Nothing filters and no checksum step is involved —
  the loss is a pure overwrite. `scripts/migrate-tickets.mjs`, `promote()`.

- **Must-FAIL reproduced FIRST, on the real artifact.** Seeded a fixture archive
  index from the REAL `docs/bugs/archive/INDEX.md` (194 rows) minus the 6 rows for
  the tickets promoted = **188 pre-existing rows**, then ran the PRE-FIX `promote()`
  (a `git show HEAD:` copy) applying a 6-ticket batch:
  `node ~/scratch/bug133-repro.mjs <old-module> OLD` →
  `PRIOR archive index: 188 rows` … `AFTER: 6 rows` … `PRIOR ROWS SURVIVED: 0/188
  LOST: 188` … `>>> DATA LOSS: promotion reported success (rc=0) yet erased 188
  prior archive rows <<<`. The wipe is real and silent (rc=0).

- **Same test after the fix:** `AFTER: 194 rows` … `PRIOR ROWS SURVIVED: 188/188
  LOST: 0` … `NEW ROWS PRESENT: 6/6` … `>>> CORRECT: 188 + 6 = 194 <<<`. A separate
  line-by-line check confirmed **188/188 prior data lines byte-identical** in the
  merged index (titles, sha256s and original archived dates untouched, not
  re-escaped, not re-dated to today).

- **Changed (one file, `scripts/migrate-tickets.mjs`):**
  - Added `export function parseArchiveIndex(text)` — reads the originals table
    back into `{id,file,title,bytes,sha256,archived}` rows, keeping titles exactly
    as written (already table-escaped) so re-emitting cannot double-escape, and
    splitting on UNescaped pipes only. A row it cannot read back sets `parseError`
    — a REFUSE signal, never a silent "0 rows".
  - `promote()` now reads the existing index, MERGES the run's rows into it keyed
    by filename (set-not-append, so a duplicate neither double-inserts nor silently
    replaces), sorts by filename, and renders prior rows verbatim with their
    original archived date.
  - **Would-drop guard:** if the existing index has a `parseError`, or a promoted
    file is already indexed under a DIFFERENT sha256 (conflict), or any prior row
    is absent from the merge, the promotion prints `PROMOTION REFUSED … (BUG-133)`
    and returns 1 **before any write or any `git mv`** — the on-disk index is left
    byte-identical. Fails loudly instead of writing a truncated record.

- **Verified — `scripts/verify-migrate-tickets.mjs`, extended (not a new harness):
  68/68 PASS** (was 53; +15 for BUG-133). New cases, each on a fixture derived from
  the REAL index or a realistic seed: parseArchiveIndex reads the real 194-row
  index with no error; a 6-onto-188 promotion yields 194 not 6; every prior row
  survives byte-identical; stable filename order; empty/absent index populates;
  duplicate same-sha does not double-insert; **checksum conflict refuses (exit 1)
  and leaves the index byte-identical and moves no original**; **unparseable index
  refuses (exit 1), byte-identical**. Anti-regression: the full pre-existing suite
  (sections 1–7, 8) still 53/53, so extraction, the acceptance gate, quarantine,
  provenance and the existing promotion rehearsal are unaffected.

- **Gate:** `npm run gate` → PASS (leak-gate, check-nul, typecheck), exit 0.
  `npm run board:check` → 1 pre-existing DRIFT (ARCH-007 rail reachability),
  UNRELATED to this change; no INDEX.md edited.

- **Scope note (stated, not hidden):** only the ORIGINALS table is merged. The
  "Deliberately NOT migrated" legacy section is regenerated each run from
  `--allow-legacy`; a promotion that would drop a still-legacy ticket without
  naming it already REFUSES upstream (`unnamedLegacy`), so that section has no
  silent-loss path of its own. Not addressed here by design.

- **Still open / handoff:** this is a DATA-LOSS + regression-prone fix, so per the
  standing rule it warrants an INDEPENDENT clean-room verify pass
  (`scripts/independent-verify.mjs`, not a Task subagent) before `verified`. A
  case the fixer's own fixture does not cover: promote onto an index whose LAST
  promotion itself left it in the newly-merged (multi-date) shape — i.e. two
  successive incremental promotions — to confirm the merge is stable across
  generations, not just once. Left at `in_verification`.
