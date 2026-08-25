```orchard-ticket
{
  "id": "BUG-073",
  "type": "bug",
  "title": "Conflict markers survived ticket board regeneration",
  "summary": "Ticket board regeneration now removes Git conflict markers with warnings, while checks reject them with line numbers. Legitimate legend text and curated status blurbs remain preserved. The standing board check ran clean.",
  "impact_if_we_wait": "Conflict markers could remain visible across repeated board regeneration while checks missed them. Bounded: this affected board display-correctness and repository hygiene, not ticket data or application behavior.",
  "current_need": "Keep the ticket closed: the standing board check ran clean, and the shipped safeguard rejects or removes conflict markers while preserving legitimate text.",
  "severity": "low",
  "area": "Ticket board tooling",
  "reported": "2026-08-12",
  "reported_by": "board-hygiene pass",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-12",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Board checks reject Git conflict markers and identify their line numbers",
    "Board generation removes conflict markers and warns for every removed line",
    "Board generation preserves the legitimate legend line",
    "Curated status blurbs remain unchanged"
  ],
  "code_refs": [
    {
      "path": "scripts/board.mjs",
      "symbol": "CONFLICT_MARKER_RE",
      "note": "Recognizes standard and diff3 Git conflict markers."
    },
    {
      "path": "scripts/board.mjs",
      "symbol": "checkBoard",
      "note": "Scans raw board lines and fails when a conflict marker is present."
    },
    {
      "path": "scripts/board.mjs",
      "symbol": "genBoard",
      "note": "Removes conflict markers from verbatim regions and emits warnings."
    },
    {
      "path": "scripts/board.mjs",
      "symbol": "dropConflictMarkers",
      "note": "Filters conflict markers while retaining legitimate non-table text."
    },
    {
      "path": "scripts/verify-board-tool.mjs",
      "symbol": "runBoard",
      "note": "Uses spawnSync so generated warnings can be captured."
    }
  ],
  "related": [
    {
      "id": "FEAT-068",
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
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-073-board-gen-launders-conflict-markers.md",
    "sha256": "547535bb8676beb7130ce696665fb6db70ef74b4c15142476659a787cbda9d11",
    "bytes": 4496,
    "original_title": "board:gen silently launders git conflict markers (Open-table trailer preserves arbitrary non-table junk)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied ticket; the laundering mechanism, shipped checks and stripping behavior, preserved legend, status-blurb boundary, evidence, and risks remain represented.",
    "dropped": []
  }
}
```

# BUG-073 — Conflict markers survived ticket board regeneration

## Diagnosis

`parseTable` treated every non-empty, non-table line after the Open-table separator as trailer content. Generation then emitted that trailer verbatim, while checking ignored it. Git conflict markers were therefore preserved silently across regenerations. Curated status blurbs are intentionally preserved and are a separate process concern.

## Evidence

The real board had carried empty `<<<<<<< HEAD`, `=======`, and `>>>>>>> worktree-agent-ab2a298b96a740b22` markers across repeated regenerations. Before the fix, checking exited successfully and generation retained injected markers. The standing `board:check` was reported clean.

## Implementation notes

`CONFLICT_MARKER_RE` recognizes standard opening, separator, closing, and diff3 base markers. `checkBoard` scans raw lines and reports the offending line. `genBoard` applies `dropConflictMarkers` to the preamble, Open-table trailer, and shipped content, warning for each removal. The legitimate legend and curated status blurbs remain untouched.

## Verification plan

The added regression section seeds a temporary board and injects markers before `## Done`. It requires checking to fail with a conflict-marker message, generation to warn and remove every marker, the legend to survive, and the subsequent check to be clean. Existing sections remain unchanged.

## Migration and rollback

The change requires no data migration. Rollback can revert the marker detection and filtering changes, but would restore silent preservation of conflict markers.

## Risks

Marker matching could remove a line intentionally beginning with seven repeated conflict characters. The scope is limited to board content emitted verbatim, and each removal produces a warning.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-12 — board-hygiene pass (filed + fixed)
- **Root-cause verdict (the half asked of this pass):** `gen`'s Open-row Status text comes from the
  CURRENT INDEX.md (`statusMap`, preserved by id) and NOT from the ticket header — that column is
  curated by design, so the stale statuses (ARCH-002, BUG-043, FEAT-055, FEAT-058, BUG-067) were a
  process gap (blurb never updated; done-tickets never normalized to a `VERIFIED`/`DONE` keyword so
  `gen` kept them in Open). Title/severity/section ARE re-derived from the header each regen. The
  ONE silent tool bug is the trailer: conflict markers (and any non-legend junk) preserved verbatim,
  invisible to `check`. Fixed here.
- **Verified:** `npm run verify:board-tool` green including the new must-FAIL section (e); pre-fix
  the injected markers passed `check` clean and survived `gen` (the defect this ticket names).
- Filed as BUG-073 because BUG-071 (verify-exemption keys on stale activity date) and BUG-072
  (permanent survivor mode) were already allocated by a concurrent agent while this pass ran.
