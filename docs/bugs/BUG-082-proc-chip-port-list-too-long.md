```orchard-ticket
{
  "id": "BUG-082",
  "type": "bug",
  "title": "Long port lists crowd out topbar controls",
  "summary": "The process chip now previews three stably ordered ports, keeps the process count, and exposes the full list in a popover. Previously, every listening port appeared inline and displaced other topbar controls.",
  "impact_if_we_wait": "Without the change, busy environments lose comfortable access to other topbar controls as the port list grows. Bounded: this affects layout and display-correctness, not process behavior or data loss.",
  "current_need": "Treat the ticket as closed: the crowded case failed before the change, corrected behavior passed, and standing checks stayed clean.",
  "severity": "medium",
  "area": "Topbar process chip",
  "reported": "2026-08-12",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-12",
      "question": "How should long port lists remain accessible without crowding the topbar?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "A",
      "chosen_on": "2026-08-13",
      "chosen_by": "agent",
      "note": "BUG-082 chose a three-port preview with overflow count and a popover containing every port; showing every port inline was superseded."
    }
  ],
  "success_criteria": [
    "The inline preview shows three ports with the primary port first",
    "An overflow indicator appears when more than three ports are listening",
    "Opening the process chip reveals every listening port",
    "The process count remains visible beside the port preview",
    "The topbar remains usable at narrow viewport widths"
  ],
  "code_refs": [
    {
      "path": "app.js",
      "symbol": "paintCrown",
      "note": "Renders the capped process-port preview and process summary."
    },
    {
      "path": "app.js",
      "symbol": "procPop",
      "note": "Popover lists every port and reuses place() and closePops()."
    },
    {
      "path": "scripts/verify-bug-082-proc-chip.mjs",
      "symbol": null,
      "note": "Exercises the capped preview, ordering, overflow indicator, full popover, and narrow layout."
    }
  ],
  "related": [
    {
      "id": "BUG-100",
      "relation": "see_also"
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
    "archived_path": "docs/bugs/archive/BUG-082-proc-chip-port-list-too-long.md",
    "sha256": "f8f668ad29c401a7250fee5ecace21df3c875be5560587a16d86ed05907a180b",
    "bytes": 4123,
    "original_title": "proc/port crown chip dumps the full port list inline, crowding out the other topbar chips",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied ticket text; the symptom, requested behavior, implemented preview, popover, ordering, deployment scope, and executed evidence are preserved.",
    "dropped": []
  }
}
```

# BUG-082 — Long port lists crowd out topbar controls

## Diagnosis

The process crown chip rendered every listening port inline. Scratch verification servers and agents could add six or more ports, allowing the chip to grow without a display cap and crowd adjacent controls.

## Evidence

The dedicated process-chip suite passed 16/16 after producing 10 failures before the change. The UI suite passed 7/7, and the process suite passed 9/9. Typecheck was clean and leak-gate passed.

## Implementation notes

The chip previews the first three ports, ordering :4317 first and the remaining ports ascending. Additional ports appear as a "+N" indicator. The process-count summary remains visible, while #procPop lists every port using the existing place() and closePops() popover behavior. The client-only change reaches users on reload without deployment.

## Verification plan

Inject more ports than the preview cap and confirm only three appear inline with an accurate overflow count. Confirm :4317 remains first, ordering is stable, the popover contains every port, and the crown row stays within a narrow viewport. The original plan named verify:proc-chip without an executed result.

## Migration and rollback

No migration or deployment is required because the change is client-only and becomes available on reload. Reverting the rendering and popover changes restores the previous inline list behavior.

## Risks

A stale or unstable port ordering could make the preview jitter between polls. Incorrect overflow arithmetic could hide how many ports remain, while popover omissions could make some listening ports inaccessible from the chip.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from user report. Client-only (app.js/styles) → reaches users on reload, no deploy.

### 2026-08-13 — worker (fresh build on current main; prior worktree attempt discarded, stale base)
- **Fix (public/app.js + public/index.html + public/styles.css):**
  - `orderedPorts()` — dedupes + numeric-sorts, pulls `:4317` (STATION_PORT) to the front, then
    ascending. STABLE across polls, so the inline preview no longer jitters.
  - `paintProcChip()` — previews only the first `PROC_PORT_CAP` (3) ports inline with a `+N`
    overflow token; keeps the `· N procs` summary; single-port / no-port cases unchanged. `#procN`
    gets `white-space: nowrap` and the width is bounded by the cap.
  - New `#procPop` popover (index.html) + `paintProcPop()` — lists EVERY port in the same
    `:4317`-first order, `:4317` tagged `station`; footer "Running here ›" opens the drawer's
    Running-here list. Reuses the FEAT-051 `.pop`/`place()`/`closePops()` chip-popover chrome; the
    chip click now toggles the popover instead of jumping straight to the drawer.
  - Sidebar chip (`procChipText`) also routed through `orderedPorts`, so it too leads with `:4317`.
- **Verify:** new `scripts/verify-bug-082-proc-chip.mjs` (`npm run verify:proc-chip`) — real app.js
  in happy-dom against a real scratch server (free port, scratch dataDir, killed by pid). Injects
  N>cap ports and drives the real `paintProcChip` / real `#procBtn` click handler.
  - Fixed: **16/16**. PRE-FIX (client changes stashed): **10 FAIL / 6 PASS** — cap, `+N`,
    `:4317`-first, ascending, width-bounded, stable-order, popover open/full-list/order/tag all
    FAIL; the anti-regression checks (summary kept, single-port inline, no-port, zero-procs)
    correctly PASS pre-fix (not the bug).
- **Anti-regression:** `verify:ui` 7/7, `verify:processes` 9/9 (crown-chip assertion green; sidebar
  now reads `:4317 +9`), `typecheck` clean, `leak-gate` PASS.
