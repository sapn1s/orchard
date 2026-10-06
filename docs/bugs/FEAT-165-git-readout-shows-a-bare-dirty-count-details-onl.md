```orchard-ticket
{
  "id": "FEAT-165",
  "type": "feature",
  "title": "Git readout shows a bare dirty count, details only in a tooltip",
  "summary": "The git readout in the session top bar shows only a number of changed files, and the line counts and file list appear only in a plain browser tooltip on hover. Users want the usual diffstat inline (green added, red removed lines, file count) and a proper styled popover listing each changed file.",
  "impact_if_we_wait": "Users cannot see the size of their uncommitted work at a glance, and the hover text is unstyled and unreadable next to the rest of the app.",
  "current_need": "Inline +added / -removed and file count on the readout; a styled hover popover with per-file status letter and +/- counts, in both themes.",
  "severity": "low",
  "area": "session top bar / git readout",
  "reported": "2026-10-05",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-10-05",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The readout shows file count, green +added and red -removed lines inline when the tree is dirty, legible in light and dark.",
    "Hovering or focusing the readout opens a styled popover in the shared popover chrome, not a native title tooltip.",
    "The popover lists each changed file with its status letter and +/- counts, and still opens the Git panel on click."
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "paintGitChip"
    },
    {
      "path": "public/styles.css"
    },
    {
      "path": "public/index.html"
    }
  ],
  "related": [
    {
      "id": "FEAT-139",
      "relation": "see_also"
    },
    {
      "id": "FEAT-161",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# FEAT-165 — Git readout shows a bare dirty count, details only in a tooltip

## Symptom

User request: the git section of the session top bar shows a bare number of changed files; the details are only in a native hover tooltip. Show a typical diffstat inline and a styled popover with a per-file list.

## Note

This reverses part of the FEAT-139 round-3 design, which deliberately moved the +/- line totals off the readout face into the tooltip. The user has now asked for them inline.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-05 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-05 — worker (fixing r1)
- **Fixing round 1:** Fixing round 1 (dispatch phase=fixing round=1 class=fix).
  - **Understood:** FEAT-139 round 3 deliberately moved the +/- line totals off the readout face into a native `title` tooltip; the user now wants the diffstat inline and a real popover. Server already sends dirty/added/removed on status and per-file added/removed/type/staged on /git/changes, so this is a client change (ARCH-010 holds: the server owns the counts, the client reads them).
  - **Changed:** face = state dot + "N files" + green "+added" + red "-removed" (tabular numerals; >=10,000 compacts to "14.1k", popover is exact; the " files" word drops under 1100px). Native title removed. New #gitPop in the shared .pop chrome (hover dwell, gap bridge, focus opens, Escape/outside closes; click still opens the Git panel): branch + upstream/ahead-behind, last commit, a diffstat summary, then each changed file with its status letter (M/A/D/R/U, tinted by kind, staged = filled tile), directory quiet + file name full ink, and its own +/- (or "binary"); capped at 200 rows + "and N more"; "Open Git panel" footer. Colours are the Git panel's own --st-done/--st-high tokens mixed toward ink.
  - **Verified:** `node scripts/verify-feat-163-165-git-bar.mjs` -> 45 passed, 0 failed. Fixtures are REAL, read-only: a moderate checkout (6 changed paths) and this Orchard checkout (368 changed paths). Checks include: face file count equals an independent porcelain count; +/- equal the server status; no native title; [light]/[dark] +added green and -removed red with contrast >= 3; popover lists every file with the correct letter and counts; file names contrast >= 4.5; busy tree: 200 rows + "and N more", list scrolls, popover in viewport, chip <= 220px; narrow window keeps numbers; pointer gap-crossing, leave-closes, keyboard focus, Escape. Visual review of the screenshots done (a too-long refusal text was clamped after review).
  - **Must-FAIL:** against a pre-change copy of the tree: "[165-moderate] section threw … Timeout" and "[165-busy] section threw … Timeout".
  - **Incident in my own first run (fixed, disclosed):** registering the two real checkouts on the scratch server through POST /api/projects ONBOARDED them (FEAT-089 default): it wrote CLAUDE.md, package.json, .claude/settings.json and .orchard/ into the moderate checkout, and .orchard/ plus a rewritten package.json scripts block into this checkout. Detected within a minute from the changed porcelain count; every created file was proven new by mtime and absence from the prior status, and removed; package.json restored byte-for-byte from my pre-edit snapshot. Both checkouts' porcelain is back to the pre-run state. The suite now registers with applyMethod:false and asserts both real checkouts' porcelain is IDENTICAL before/after (both PASS).
  - **Anti-regressions:** verify-bug-082-proc-chip 13/13; verify-feat-161 42/42 on 2 reruns (1 earlier run had 1 fail on a second-boundary countdown "2d 5h" vs "2d 4h" — timing flake in that suite, passes on the pre-change tree and on reruns); verify-gitview-async-token 18/18. NOT runnable here: scripts/verify-git.mjs (creates fixture repos, refused by the shim) — note it already expected the pre-FEAT-139-r3 face text ("main · 2 dirty") and needs updating to this face.
  - Screenshots: docs/bugs/assets/FEAT-165-{face,popover,busy-popover}-{light,dark}.png, FEAT-165-busy-narrow-light.png.
  - Changed files (unstaged; no git writes): public/app.js, public/index.html, public/styles.css, public/lib/git-view.js, public/git-view.css, scripts/lib/git-grant-store.mjs, scripts/lib/git-grant-store.d.mts, scripts/git-grant.mjs, src/server/registry.ts, src/server/index.ts, package.json (two verify script entries), new scripts/verify-feat-163-165-git-bar.mjs, new scripts/verify-feat-164-permanent-git-grant.mjs. Gate: `npm run gate` -> GATE: PASS (exit 0; leak-gate, check-nul, typecheck).
  - **Handoff:** independent visual + functional verification owed (routine UI bucket).

### 2026-10-06 — worker (verifying r1)

  - **Live smoke (read-only, Playwright headless, running service on 127.0.0.1:4317).** Git project with changes (claude-station/orchard, 441 changed): chip face shows green +96,466 / red −4,029 and the styled popover lists 200 per-file rows with green add / red del spans (addColor srgb≈0.35,0.43,0.26; delColor srgb≈0.56,0.28,0.21), branch "main · up to date", "Open Git panel". Screenshot docs/bugs/assets/SMOKE-live-git-bar-changes.png. Also captured: FEAT-164 Decide card A/B/C (SMOKE-live-feat164-decide.png). No page errors; nothing clicked that mutates; write + git-write-grant routes blocked at the browser as a safety net.
