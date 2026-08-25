# BUG-093 — arch-watch forms a false "product-name" recurrence cluster; dismiss it + stopword the product tokens

- **Status:** VERIFIED
- **Area:** scripts/arch-watch.mjs (tokenization / stopwords / maxDf)
- **Reported:** 2026-08-14 (found by the ARCH triage of the `claude+station` finding)

## Problem
The arch-recurrence watcher raised a `[claude+station]` cluster (12 tickets) that a grounded ARCH
triage proved is a FALSE POSITIVE — a lexical catch-all on the PRODUCT NAME (tokens `claude`+`station`
harvested from generically-worded `- **Area:**` lines), not a subsystem: no shared files, unrelated
fixes (a CSS line, the model write-path, a branding SVG, methodology docs), 3 of 12 never built, and it
fired on a filing burst not a re-patch cadence. The detector's `maxDf` (~0.25) ceiling lets the product
name survive as a pseudo-subsystem on a ~142-ticket board.

## Wanted
1. **Suppress the product-name catch-all so it never re-forms:** add a per-project STOPWORD seed
   (project/product/service name, e.g. from the registry display name / repo name) to the tokenizer,
   and/or tighten `maxDf`. A token that is the product name carries no subsystem signal.
2. **Dismiss the current false finding** (`board.dismissArchFinding`, keyed on label+member set) so it
   clears the rail now.

## Verification (§C)
- Fixture board where many tickets' Area lines contain the product name → assert NO cluster forms on
  the product tokens after the stopword fix (must-FAIL pre-fix: the `[product]` cluster forms).
- Assert genuinely coherent clusters (shared files) still form (don't over-suppress) — e.g. the
  `[restart+adopt+agent]` / `[app+sidebar+rendertree]` clusters the triage flagged as real.
- Anti-regress: existing arch-watch tests, board:check.
- Risk: detector tuning (low).

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed from the ARCH triage's recommendation (the `[claude+station]` finding was a false positive;
  root is detector tokenization not architecture). Low priority; complements FEAT-079 (which stops
  read-only findings from sitting on the Needs-You rail regardless).

### 2026-08-14 — worker (fix + verify) → VERIFIED

**Fix map**
- `scripts/arch-watch.mjs`
  - new `deriveProjectStopwords(dir, {extra, enabled})` — DERIVES the product-name seed per project
    from the repo dir basename + `package.json` `name` (scope-stripped), tokenised with the same
    rules as the corpus (split on non-alnum, len ≥ 3, both raw and stemmed forms added).
  - `tokenize(text, extraStop)` / `readTicketsForArch(dir, extraStop)` take the seed (default empty
    set → callers outside `archWatch` are unchanged).
  - `archWatch()` builds the seed, passes it to the reader, and reports it as `config.stopwords`
    (JSON + the CLI header line: `…; project stopwords: claude, orchard, station`).
  - knobs: `--stopwords=a,b` / `ARCH_STOPWORDS` (additive — a marketing alias, an org prefix) and
    `--no-project-stopwords` / `ARCH_NO_PROJECT_STOPWORDS` (turns the derivation off; used as the
    must-FAIL control).
- `scripts/verify-arch-watch.mjs` — new §1c (product-name fixture + must-FAIL control) and four new
  real-board assertions in §7; two §7 file-evidence checks made history-honest (see "Pre-existing").

**Approach rationale — stopword seed, NOT a tighter `maxDf`** (documented in the file header too)
The product name is a *constant* of the board, not a *frequent word*: it can appear in 3 Area lines or
40 and it still carries zero subsystem information, so no document-frequency band is the right
instrument. Measured here: `claude`/`station` sat at ~12/150 ≈ 8% — to catch it, `maxDf` would have to
drop to ≈0.05, which also gags genuine subsystem vocabulary that legitimately spans 10–20 tickets
(`agent`, `session`, `app`), and does nothing at all below `SMALL_BOARD`=20 where the ceiling is off by
design. The seed is exact, costs one derivation per run, and — because fleet-sync copies this script
verbatim into other repos — it is DERIVED per project, never hardcoded. `maxDf` left at 0.25.

**Verification (§C) — `node scripts/verify-arch-watch.mjs`: 49 passed, 0 failed** (was 41 checks, +8)
- §1c fixture board (`acme-portal`: 5 VERIFIED tickets whose ONLY shared vocabulary is the product
  name across 5 unrelated areas — topbar CSS, model write path, branding SVG, methodology docs, deploy
  script — plus the genuine 3-ticket widget-cache class):
  - **MUST-FAIL control**: with `--no-project-stopwords` the `[acme+portal]` catch-all DOES form and
    flags all five decoys → the fixture is not vacuous, and this is the pre-fix behaviour.
  - with the fix: NO cluster (flagged or unflagged) carries an `acme`/`portal` token; none of the five
    decoys lands in any flagged cluster; the widget-cache class still forms intact (not over-suppressed);
    `--stopwords=widget` is additive.
- §7, the REAL 150-ticket board: no flagged cluster is labelled with a product token
  (`claude|station|orchard`); the 12-ticket false cluster is gone (FEAT-017 is now in no flagged
  cluster at all); the coherent classes still form — `[agent+live+bridge]` BUG-020/030/033/034,
  `[agent+transcript+live]` BUG-004/011/014/017, `[adopt+drain+live]` BUG-022/044/048/072,
  `[app+sidebar+rendertree]` BUG-085/FEAT-070/073/074 (5 shared files as evidence), `[restart+live]`.
  Cluster count over threshold is unchanged at 39 — the 12-ticket blob dissolved into its real parts
  (e.g. BUG-026 → `[model+switch+override]`, FEAT-024 → `[dispatch+templat+workflow]`) rather than
  vanishing from the analysis.
- Anti-regress: `verify:arch-watch` 49/49 (incl. the FEAT-047/056/079 rail, dismiss, re-raise, broken-
  detector-can't-break-boot sections); `board:check` OK — no drift; `typecheck` clean; `leak-gate`
  **PASS — 0 hits across 420 files**.

**Pre-existing failure fixed honestly (not caused by this change)**
§7's "that cluster reports its git-corroborated shared files as evidence" was ALREADY red at HEAD:
the 2026-08-13 relocation to `orchard` rebuilt the repo history, so `git log --all --grep=BUG-020`
matches 0 commits and the class's file evidence is simply unrecoverable here. Proven independent of
this fix by running the detector with `--no-project-stopwords` (byte-equivalent pre-fix behaviour):
`[agent+live+bridge] files=[]` either way. Replaced with two non-vacuous checks: (a) at least one
flagged real-board cluster DOES report shared files (currently 5 for `[app+sidebar+rendertree]`), and
(b) the agent-strip cluster reports `agent-bridge` files **or** git has no commits naming its ids at all.

**Current false finding: DISMISSED and gone**
- `board.dismissArchFinding(<repo>, 'arch-recurrence-971e1441')` called through the real exported
  code path (the same function the `POST /api/projects/:id/board/dismiss` route at index.ts:919 uses;
  no server restart, nothing on :4317 touched) → acked in `docs/bugs/.arch/acks.json`.
- `npm run arch:watch` re-persisted: `arch-recurrence-971e1441` is no longer emitted **at all** (the
  cluster no longer forms), and `archRecurrenceFindings()` returns no product-name row. The rail is
  clear of it on both counts — dismissal AND non-detection.
- Note `.arch/` is derived + self-ignored, so neither file is committed (by design).

**Not touched** (concurrent lane): `public/styles.css`, `public/lib/digest.js`. `docs/guide/` doc-freshness
is one ADVISORY stale-ref WARN on `working-agreement.md` (its arch-watch section describes the
ride-along schedule, which this change does not alter) — not blessed, deliberately.
