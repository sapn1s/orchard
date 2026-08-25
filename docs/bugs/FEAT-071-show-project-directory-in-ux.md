```orchard-ticket
{
  "id": "FEAT-071",
  "type": "feature",
  "title": "Nothing in the interface showed which directory a project used",
  "summary": "A project points at a folder on the machine, but nothing in the interface said which one, so a rename or a move left no way to confirm it. The selected project's folder now appears in the project settings drawer in shortened form, with the full path on hover, and again in a tooltip on the project crown.",
  "impact_if_we_wait": "People cannot confirm which folder a project writes to, and act on a guess after a rename. Bounded: this is missing reference information only. No file is written to the wrong place and no stored data is affected.",
  "current_need": "Nothing is outstanding. The path-display case failed before the change and passed after, and the standing type and leak checks stayed clean.",
  "severity": "medium",
  "area": "Project settings display",
  "reported": "2026-08-13",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The selected project's folder appears in the settings drawer in shortened form",
    "The full path is available on hover rather than rendered in full",
    "The displayed path matches the folder recorded for that project",
    "Any selected project shows its folder, not only the active one",
    "No absolute home-directory path is written into a committed test fixture"
  ],
  "code_refs": [
    {
      "path": "dom.js",
      "symbol": "shortPath",
      "note": "existing helper reused so the rendered path shortens the home directory"
    }
  ],
  "related": [],
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
    "archived_path": "docs/bugs/archive/FEAT-071-show-project-directory-in-ux.md",
    "sha256": "c4112f0effd14165fd04326cbaf683ea946e3161e808578c25f166f55c1742bc",
    "bytes": 3536,
    "original_title": "surface a project's associated directory somewhere in the UX",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "The symptom, the three wanted behaviours, the shortPath-plus-title display rule, the two surfaces, and the §C proof bar including its must-FAIL clause are all present above.",
    "dropped": [
      "the concrete rename example naming one project's display name, id and path, which illustrated the symptom rather than adding a requirement"
    ]
  }
}
```

# FEAT-071 — Nothing in the interface showed which directory a project used

## Diagnosis

A project maps to a host directory recorded in the registry as `hostPath`, but no view rendered it. The gap was most visible when a project had been renamed or relocated — display name, id and directory could all differ, and the interface offered no way to reconcile them.

## Evidence

With the source change stashed, the path-rendering suite recorded 5 of 6 cases passing — the missing case being the path itself, which appeared nowhere. With the change in place a 6-of-6 tally was recorded. `typecheck` and the leak gate were both reported clean; the leak gate matters here specifically because rendering a raw `/home/<user>` path into a committed fixture is the failure mode this feature could introduce.

## Implementation notes

The path is rendered through the existing `shortPath` helper in `dom.js`, so a home directory displays as `~/…`, with the full path carried in the `title` attribute for hover. Two surfaces carry it: the project settings drawer header and a tooltip on the project crown. It is reference information, so both placements are deliberately low-chrome.

## Verification plan

Under Playwright/happy-dom, assert the selected project's shortened `hostPath` appears in the settings drawer and tooltip, that the `title` attribute carries the full path, and that both match the registry `hostPath`. The suite must fail before the fix, when the path is shown nowhere. Anti-regressions named in the ticket: `verify:ui`, `typecheck`, and the leak gate.

## Risks

Rendering a real host path risks leaking an absolute home directory into a committed fixture, which is why the leak gate is part of the standing check set for this change.

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from user report. Client-only. Use shortPath for display (leak-gate hygiene).

### 2026-08-13 — worker (fix + §C)
- Surfaced the selected project's `hostPath` in two low-chrome, discoverable spots:
  1. A "Directory" line at the TOP of the Project settings drawer (public/lib/drawer.js
     `settingsView`): `shortPath(p.hostPath)` in a monospace `<code>` for display, the FULL path in
     the row's `title` attr on hover. Styled `.proj-dir` in public/styles.css (small label + mono
     value, low chrome). Works for any selected project (reads `project()` = the current project).
  2. The crown project name (public/app.js `paintCrown`, `#where`) now carries `name\nhostPath` as a
     hover `title`, so the full path is one hover away from the header too.
- shortPath (dom.js) is the ONLY thing rendered inline, so no raw `/home/<user>` ships in a fixture;
  also sanitized a pre-existing raw home path in THIS ticket (line under Symptom) to `~/…` so the
  leak-gate passes (that sanitize shipped with the BUG-085 commit that preceded this one).
- §C — scripts/verify-feat-071-project-dir.mjs (REAL app.js in happy-dom vs a REAL server; registers
  a real neighbour project, selects it, drives the REAL drawer.open('settings') + paintCrown, asserts
  on the produced DOM and matches against the registry hostPath fetched from the server):
  - the settings drawer shows a Directory line; its inline value === `shortPath(hostPath)`; the row
    title === the FULL hostPath === the registry hostPath; the label reads "Directory"; the crown
    `#where` title contains the full path.
  - POST-FIX: 6/6 PASS. PRE-FIX (source stashed): 5/6 FAIL — no `.proj-dir`, path shown nowhere.
- Anti-regressions all green: verify:ui (7/0), typecheck (0), leak-gate (PASS, 351 files).
- Commit: FEAT-071: show selected project's directory (shortPath in settings + tooltip).
