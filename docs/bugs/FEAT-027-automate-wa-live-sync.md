```orchard-ticket
{
  "id": "FEAT-027",
  "type": "feature",
  "title": "Edited working agreements did not reach new sessions",
  "summary": "The working agreement existed twice: as the committed document and as a seeded copy the station handed to sessions. Only a manual re-upload kept them equal, so an edit could sit in the repository while sessions kept receiving the older wording. Living documents that name a source file are now read straight from that file at compose time.",
  "impact_if_we_wait": "Sessions could be handed guidance that no longer matched the committed text, with nothing signalling the difference. Bounded: this affected which wording sessions received, not stored data, and re-uploading the file by hand always restored agreement.",
  "current_need": "Nothing is outstanding. Composing from the source file was built and exercised end to end, with the read-through, interface and boot-aware checks all passing and standing checks clean.",
  "severity": "medium",
  "area": "Working agreement delivery",
  "reported": "2026-08-04",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-04",
      "question": "Should the living document be read from the repository file, re-saved on change, or synced by hand?",
      "mode": "single",
      "options_keys": [
        "a",
        "b",
        "c"
      ],
      "chosen": "a",
      "chosen_on": "2026-08-04",
      "chosen_by": "agent",
      "note": "Read-through was recommended in the original because it removes the second copy entirely rather than keeping two copies equal. Options b and c both retained a stored copy that could still fall behind."
    }
  ],
  "success_criteria": [
    "Editing the repository document changes what a newly composed session receives, with no manual upload",
    "A living document that declares a source path resolves its body from that file at compose time",
    "Typecheck and a compose test pass"
  ],
  "code_refs": [
    {
      "path": "src/server/templates.ts",
      "symbol": null,
      "note": "resolves a living template's body from its declared source path at compose time; previously seedTemplates() only wrote a copy when none existed, so repository edits never propagated"
    },
    {
      "path": "docs/prompts/WORKING_AGREEMENT.v2.md",
      "symbol": null,
      "note": "the committed document that the seeded copy used to drift from"
    }
  ],
  "related": [
    {
      "id": "FEAT-019",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-039",
      "relation": "blocks"
    },
    {
      "id": "FEAT-041",
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
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-027-automate-wa-live-sync.md",
    "sha256": "9010841e1e009629a68eacf673ce28407a5015fb11d3a12e061ce710ef085d25",
    "bytes": 6256,
    "original_title": "Automate repo→live sync of the Working Agreement template (kill manual-POST drift)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the two-copies diagnosis, the seed-only-when-absent mechanism, all three design options and the chosen read-through approach are present.",
    "dropped": []
  }
}
```

# FEAT-027 — Edited working agreements did not reach new sessions

## Diagnosis

### Two copies, one of them hand-maintained

The working agreement lived both in the repository at `docs/prompts/WORKING_AGREEMENT.v2.md` and as a seeded template record that the station injected into sessions. The two were reconciled only by a manual POST of the file after each edit. `seedTemplates()` seeds a template only when it is absent, so an edit to the repository file did not propagate on its own, and a forgotten POST left the injected copy silently behind the committed source.

## Evidence

This was raised as risk R3 of the FEAT-019 whole-picture pass, on 2026-08-04.

The implementation was exercised by three suites: the template read-through suite at 18/18, the interface suite at 3/3 and the boot-aware suite at 12/12. Typecheck was clean.

## Implementation notes

### The approach chosen and the two rejected

Read-through was implemented in `src/server/templates.ts`: a living template that declares a `source:` path resolves its body from that file when a session is composed, so no data copy exists to fall out of step.

The alternative of re-saving the template whenever the repository file changes — via a watcher, an npm script or a git hook — was rejected because it keeps the second copy and merely automates the reconciliation. A `sync:agreements` command the developer runs by hand was rejected as the weakest of the three, since it leaves the same forget-to-run failure that prompted the ticket.

## Verification plan

Edit the repository document, compose a new session, and confirm the new wording appears without any manual upload. Run typecheck and a compose test alongside it.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed from R3. Note: seedTemplates() source-path already exists (working-agreement
  seeds FROM docs/prompts/…) — read-through is a natural extension.

### 2026-08-04 — agent (approach (a) read-through, implemented)
**Understood:** the WA lives twice — once in `docs/prompts/WORKING_AGREEMENT*.md`,
once as a one-shot copy `seedTemplates()` writes into `<data>/templates/*.md`.
`readTemplate()` only ever returned that stored copy, so an edit to the repo
file after seeding never reached a launched session without a manual
`saveTemplate`/POST. Went with design (a) from the ticket: read-through.

**Changed** (`src/server/templates.ts` only, + this ticket, + verify script,
+ `package.json`):
- `Template` gains `source?: string` (path, relative to `projectRoot()` unless
  it resolves absolute — either is accepted, both go through the same guard)
  and `sourceMissing?: boolean` (true when `source` is set but unreadable/
  escapes projectRoot()).
- `serialize()` writes an optional `source: …` frontmatter line;
  `parseFrontmatter()` already picked up arbitrary `key: value` lines, so no
  change needed there.
- `readTemplate()`: when `source` is present, resolves it via
  `path.resolve(projectRoot(), source)` guarded by `isInside(projectRoot(), …)`
  (reused from `src/lib/paths.ts` — refuses to read outside the repo, so a
  hand-edited `source: ../../../etc/passwd` degrades instead of leaking).
  On success, `body`/`bytes`/`updatedAt` come from the SOURCE file (read live,
  every call — no caching). On failure (missing file, or path escape), falls
  back to the stored copy already in the `.md` file and never throws;
  `sourceMissing` is set so a caller can surface staleness.
- **Migration for already-seeded installs** (chosen: non-destructive,
  read-time-only — no forced re-seed): a `DEFAULT_SEED_SOURCES` map keyed by
  the two known seed ids (`working-agreement`, `working-agreement-v2`) is
  consulted in `readTemplate()` ONLY when the stored file has no `source:`
  line. The stored `.md` file itself is never rewritten by this fallback —
  it's a pure read-time default, so a pre-FEAT-027 install starts getting
  read-through with zero action needed.
- `seedTemplates()` now passes `source: path.relative(projectRoot(), …)` for
  both WA seeds when it actually seeds them (skips are unaffected, per the
  migration above).
- `saveTemplate()` / `SaveTemplateInput` gained an optional `source` field.
  Left **unset** on a save, it now defaults to the EXISTING template's
  `source` (not undefined) — an unaware UI-edit POST that doesn't send
  `source` must not silently detach a living doc from its repo file. Pass
  `source: ''` to deliberately clear it. A template that never had a `source`
  behaves byte-for-byte as before (confirmed by verify).
- `composeInstructions()` untouched — it already calls `readTemplate()` per
  ref, so it gets the fresh body automatically.

**Verified:**
- `node scripts/verify-template-readthrough.mjs` (new, `npm run
  verify:template-readthrough`) — 18/18 PASS. Proved non-vacuous: stashed
  `src/server/templates.ts` back to pre-change, reran the same script against
  the ORIGINAL code → 8/18 (10 FAIL, exit 1), confirming the checks actually
  exercise the new behavior and don't pass vacuously. Restored the change
  (`git stash pop`) and reran → 18/18 PASS. Covers: source resolves + reports
  on `Template`; body/compose reflect a LIVE on-disk edit to the source file
  with NO save/POST call in between (the crux check); a deleted source
  degrades to the stored copy without throwing (`sourceMissing: true`); a
  non-source template is byte-identical to pre-FEAT-027 behavior; an
  overwrite-save that omits `source` does not detach an existing one;
  `seedTemplates()` records `source` on both real WA seeds and the seeded
  `working-agreement-v2` body matches the REAL repo file's current content.
  (Test note: the guard correctly refuses a `source` outside `projectRoot()`,
  so the script's throwaway "repo file" lives under a `.cs-tmplrt-src-*`
  dotdir INSIDE the repo root, not `/tmp` — removed in the script's `finally`.)
- `npm run typecheck` — PASS, no errors.
- `npm run verify:ui -- --offline` — PASS (3/3, live turn skipped as
  instructed).
- `npm run verify:boot-aware` — PASS (12/12), anti-regression: this ticket's
  FEAT-021 board-injection folding also runs through `composeInstructions()`/
  `appendToSystemPrompt()` in `templates.ts`, unaffected by the read-through
  change.

**Status → VERIFIED.** Not committed (per hard rules — left in the working
tree). Only `src/server/templates.ts`, `scripts/verify-template-readthrough.mjs`,
`package.json` (new npm script), and this ticket were touched — `index.ts`,
`board.ts`, `agent-bridge.ts`, `app.js` untouched, INDEX.md untouched.
