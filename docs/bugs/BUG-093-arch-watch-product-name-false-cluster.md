```orchard-ticket
{
  "id": "BUG-093",
  "type": "bug",
  "title": "Product names no longer create false recurrence clusters",
  "summary": "Project names are now excluded from recurrence matching, and the existing false cluster was dismissed. The focused fixture passes without hiding coherent clusters, while standing checks remain clean.",
  "impact_if_we_wait": "False clusters would waste architecture-triage time and obscure meaningful recurrence signals. Bounded: this affects diagnostic accuracy and board display, not product behavior or user data.",
  "current_need": "Treat the ticket as closed: the product-token fixture passes, coherent clusters remain detectable, and standing checks are clean.",
  "severity": "low",
  "area": "Architecture recurrence detection",
  "reported": "2026-08-14",
  "reported_by": "bug-hunt workflow",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Product-name tokens do not form recurrence clusters across otherwise unrelated tickets",
    "Coherent clusters sharing implementation evidence remain detectable",
    "The existing false product-name finding is dismissed"
  ],
  "code_refs": [
    {
      "path": "scripts/arch-watch.mjs",
      "symbol": null,
      "note": "Tokenization now excludes project and product names from recurrence signals."
    },
    {
      "path": "scripts/arch-watch.mjs",
      "symbol": "maxDf",
      "note": "Document-frequency filtering remains part of the safeguard against lexical catch-all clusters."
    }
  ],
  "related": [],
  "recurrence_evidence": [
    "BUG-093"
  ],
  "verification": [],
  "verification_class": "arch",
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
    "archived_path": "docs/bugs/archive/BUG-093-arch-watch-product-name-false-cluster.md",
    "sha256": "5816edacafb3808cbcbe846973cbfa8c0d01f738afed8511043127c2d702df63",
    "bytes": 7610,
    "original_title": "arch-watch forms a false \"product-name\" recurrence cluster; dismiss it + stopword the product tokens",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied original; the false cluster, diagnosis, suppression, dismissal, risk, and executed checks are represented above.",
    "dropped": []
  }
}
```

# BUG-093 — Product names no longer create false recurrence clusters

## Diagnosis

The recurrence watcher harvested product-name tokens from generic Area lines and treated their frequency as subsystem evidence. Its document-frequency ceiling allowed those tokens to survive across a board of roughly 142 tickets, grouping unrelated fixes without shared files or implementation cadence.

## Evidence

The false cluster contained 12 tickets spanning a CSS change, model persistence, branding artwork, and methodology documentation. Three members were never implemented, and the grouping followed a filing burst rather than repeated repairs. `verify:arch-watch` completed 49 of 49 checks successfully; `typecheck` and `board:check` were also clean.

## Implementation notes

Seed tokenization with per-project stopwords derived from the project, product, or service name. Dismiss the existing finding through `board.dismissArchFinding`, keyed by its label and member set. Preserve frequency filtering so broadly repeated non-subsystem terms remain suppressed.

## Verification plan

Use a fixture where many Area lines contain the product name. Confirm the product-token cluster forms before the change and disappears afterward. Confirm known coherent clusters based on shared files still form, then run the architecture-watcher suite and standing checks.

## Migration and rollback

The change only adjusts diagnostic tokenization and dismisses one stored finding. Rollback can restore the prior stopword behavior, though doing so may recreate the false cluster.

## Risks

Over-broad stopwords or stricter frequency filtering could hide genuine recurrence clusters. The retained coherent-cluster fixtures constrain that risk.

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
