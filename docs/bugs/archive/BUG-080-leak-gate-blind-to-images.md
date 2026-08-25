# BUG-080 — leak-gate is blind to image assets shipped by the public mirror: screenshots leak private data past the "final gate"

- **Status:** DONE 2026-08-12 (fix + §C self-verified, awaiting independent verification) — mirror excludes non-allowlisted images + gate scans the built tree in TREE mode & hard-fails on private images (17/17 §C, verify:gatekeeper 31/0, typecheck clean). Scripts lane, no deploy.
- **Area:** scripts/leak-gate.mjs + scripts/publish-public-mirror.sh — release privacy
- **Reported:** 2026-08-12 by the area-review workflow (harness/security reviewer + skeptic verify)

## Finding (code-confirmed)
`leak-gate.mjs` skips every image by extension (SKIP_RE :36 matches png/jpg/…) and skips any file
with a NUL byte (:53) — it scans zero pixels. But `publish-public-mirror.sh:61` copies EVERY
git-tracked file into the public tree (`git ls-files | tar …`), which INCLUDES
`docs/bugs/assets/*.png` — genuine dashboard captures (e.g. BUG-038-*.png) showing the sidebar
project list, session titles with the home path, and username/email in the UI chrome. The gate the
mirror relies on as its "final privacy gate" passes them verbatim, so `publish-public-mirror.sh
--push` would publicly disclose that private data.

Adjacent (same file, low, fold in): the gate's path argument is partly ignored — it should gate
the BUILT TREE the publish script hands it, not the source repo (two low findings from the review;
verify the tree actually passed to the gate is the one scanned).

## Wanted
1. The publish pipeline must not ship private images. Options (pick, justify): the gate FAILS on
   tracked images under a configurable path (docs/bugs/assets) unless explicitly allowlisted; OR
   the mirror script EXCLUDES docs/bugs/assets (and any image not on a public allowlist) from the
   tarball; OR an OCR/text-in-image check (heavier — probably overkill). Recommended: mirror
   excludes docs/bugs/assets by default + the gate warns loudly on any image entering the public
   tree. Whatever ships, `publish-public-mirror.sh --push` must not leak the current PNGs.
2. Confirm/repair the gate's path-arg handling so it scans the tree it's given.

## Verification (§C)
Scratch: build a mirror tree containing a private-looking PNG under docs/bugs/assets → the
pipeline REFUSES or excludes it (must FAIL pre-fix: it ships). Text leak-gate behavior on .md/code
unchanged (0 regressions). Path-arg: gate run against a scratch tree scans THAT tree, not the repo.
Anti-regressions: existing leak-gate self-test if any, verify:gatekeeper (uses leak-gate), typecheck.

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
