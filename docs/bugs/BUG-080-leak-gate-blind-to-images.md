```orchard-ticket
{
  "id": "BUG-080",
  "type": "bug",
  "title": "Public mirror exposed private screenshot data",
  "summary": "The public mirror now excludes images unless explicitly allowed, and its privacy gate scans the built output for private images. Previously, tracked screenshots containing project names, home paths, usernames, and email addresses could pass through unchanged.",
  "impact_if_we_wait": "Without the fix, publishing could disclose private interface details through screenshots. Bounded: this affects public-mirror privacy, not source data integrity or runtime product behavior.",
  "current_need": "Treat the ticket as closed: the pre-fix case failed, corrected image handling passed, and standing checks stayed clean.",
  "severity": "high",
  "area": "Public mirror privacy",
  "reported": "2026-08-12",
  "reported_by": "area-review workflow",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-12",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-12",
      "question": "How should private images be prevented from entering the public mirror?",
      "mode": "multi",
      "options_keys": [
        "A",
        "B",
        "C"
      ],
      "chosen": [
        "A",
        "B"
      ],
      "chosen_on": "2026-08-12",
      "chosen_by": "agent",
      "note": "The mirror excludes non-allowlisted images, while the gate scans the built tree and rejects private images. OCR was not selected."
    }
  ],
  "success_criteria": [
    "Private images are excluded from public mirror output unless explicitly allowlisted",
    "The privacy gate scans the supplied built tree rather than the source repository",
    "Private images found in the built tree cause the gate to fail",
    "Existing text leak detection remains unchanged"
  ],
  "code_refs": [
    {
      "path": "scripts/leak-gate.mjs",
      "symbol": "SKIP_RE",
      "note": "Previously skipped images by extension and files containing NUL bytes; now checks the supplied built tree for private images."
    },
    {
      "path": "scripts/publish-public-mirror.sh",
      "symbol": null,
      "note": "Previously copied every tracked file; now excludes images unless they appear on the public allowlist."
    },
    {
      "path": "docs/bugs/assets",
      "symbol": null,
      "note": "Contained dashboard screenshots associated with BUG-038 that exposed project names, session titles, home paths, usernames, and email addresses."
    }
  ],
  "related": [
    {
      "id": "BUG-038",
      "relation": "see_also"
    },
    {
      "id": "FEAT-075",
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
    "archived_path": "docs/bugs/archive/BUG-080-leak-gate-blind-to-images.md",
    "sha256": "00a1d38a57a4b2dc216ee4b1249d78961b429486afa0d8ec00fe409e0c02fb26",
    "bytes": 6086,
    "original_title": "leak-gate is blind to image assets shipped by the public mirror: screenshots leak private data past the \"final gate\"",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived ticket; the image leak, path-handling defect, selected safeguards, alternatives, bounds, and executed evidence are preserved.",
    "dropped": []
  }
}
```

# BUG-080 — Public mirror exposed private screenshot data

## Diagnosis

The privacy gate skipped images by extension and ignored files containing NUL bytes, so it inspected no pixels. The publishing script copied every tracked file into the public tree, including dashboard screenshots with private interface details. Its path handling could also scan the repository instead of the supplied built tree.

## Evidence

The pre-fix scratch case was recorded as "PRE-FIX must-FAIL" because a private-looking PNG was shipped. After the change, `verify:bug-080-mirror-images` passed 17/17 cases. The standing typecheck and leak-gate checks were reported clean. `verify:gatekeeper` was named, but no result was recorded.

## Implementation notes

Exclude non-allowlisted images while constructing the public mirror. Run the gate against that built tree in TREE mode, and fail when private images enter it. OCR was considered heavier than necessary.

## Verification plan

Build a scratch mirror containing a private-looking PNG under `docs/bugs/assets` and confirm that it is excluded or rejected. Confirm the supplied scratch tree is scanned instead of the repository, then exercise unchanged Markdown and code leak detection.

## Migration and rollback

This change is confined to publishing scripts and requires no deployment. Rollback can restore the prior scripts, but doing so would reopen the screenshot disclosure path.

## Risks

An incomplete image allowlist can omit intended public assets. Incorrect path handling can scan the wrong tree and recreate the original privacy gap.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from the area-review workflow. NOT urgent (only fires on a user-run publish, which hasn't
  happened) but it is a real privacy hole in the release path FEAT-049 built — must land before any
  public mirror push. Scripts lane, no deploy.

### 2026-08-12 — scripts lane (BUG-080 fix)
**Chosen shape (defense in depth — both belts the ticket recommended):**
1. `publish-public-mirror.sh` now FILTERS the tarball: images whose path is not under a curated
   public allowlist (`public/`, `docs/assets/` — the README's hand-picked screenshots) are DROPPED
   before copy. The 104 `docs/bugs/assets/*.png` raw dashboard captures never enter the tree. The
   copy line prints the excluded-image count.
2. `leak-gate.mjs` gains TWO modes. REPO mode (no arg, cwd=repo — how the FEAT-050 gatekeeper calls
   it) is unchanged: git ls-files text scan, images SKIPPED (the private working repo legitimately
   holds those pngs; gating them would block every commit). TREE mode (a directory arg — the built
   mirror) walks the filesystem and HARD-FAILS on any image not on the allowlist, so a mistake in
   the shell filter is caught, not shipped. Allowlist is env-overridable (`LEAK_GATE_IMG_ALLOW`),
   kept in sync with the shell regex.
   *Why not "gate fails on tracked images under docs/bugs/assets in the source repo":* that would
   make the gatekeeper's leak-gate step fail on every private-repo commit (100+ tracked pngs).
   Tree-mode-only image gating avoids that entirely while still guaranteeing the mirror is clean.

**Folded-in path-arg findings (repaired):** pre-fix the gate ignored `process.argv[2]` — it always
ran `git rev-parse --show-toplevel` from cwd, so `node leak-gate.mjs <tree>` scanned the SOURCE
repo, never the tree it was handed. Now a path arg selects TREE mode and scans exactly that dir.

**Verification (§C, scratch/dry only, no network, no --push):**
- PRE-FIX must-FAIL (captured before edits): scratch tree = README.md + a fake private PNG under
  docs/bugs/assets. `node leak-gate.mjs <tree>` → `PASS — 0 hits across 329 tracked text files`,
  exit 0. Two failures in one line: 329 = the SOURCE repo count (arg ignored, wrong tree scanned)
  AND the private PNG shipped unflagged.
- POST-FIX same tree: `FAIL — 1 hit (incl. 1 non-allowlisted image) ... across 2 files [TREE ...]`,
  exit 1 — correct tree, image caught.
- `scripts/verify-bug-080-mirror-images.mjs` (+ `npm run verify:bug-080-mirror-images`): 17/17.
  [A] tree-mode image gate (private fails, allowlisted pass); [B] path-arg scans the handed tree
  not the repo (file counts prove it); [C] REPO mode unchanged — text token caught with the same
  `file:line [class]` format, repo image skipped; [D] end-to-end `publish-public-mirror.sh --out
  <scratch>` (no push): exit 0, zero images under docs/bugs/assets, excluded-count reported,
  allowlisted docs/assets + public/favicon.svg KEPT, `leak gate: PASS`, zero stray images anywhere.
- Anti-regressions: `verify:gatekeeper` 31/0 (leak-gate repo-mode + file:line format intact);
  `typecheck` clean; real-repo `node scripts/leak-gate.mjs` (repo mode) still PASS (0 hits, 438
  files). `bash -n publish-public-mirror.sh` clean.
- Lane honored: only `scripts/leak-gate.mjs`, `scripts/publish-public-mirror.sh`,
  `scripts/verify-bug-080-mirror-images.mjs`, `package.json` touched. No server/app/deploy. Never
  ran `--push`; no network; no gh calls.
