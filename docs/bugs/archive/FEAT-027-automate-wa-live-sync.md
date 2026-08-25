# FEAT-027 — Automate repo→live sync of the Working Agreement template (kill manual-POST drift)

- **Status:** VERIFIED — read-through (approach a) implemented in `src/server/templates.ts`; see 2026-08-04 agent entry below.
- **Area:** templates / dev workflow
- **Reported:** 2026-08-04 (risk R3 from the FEAT-019 whole-picture pass)

## Problem
The WA lives in the repo (`docs/prompts/WORKING_AGREEMENT.v2.md`) AND as a seeded
template data copy the station injects. They're kept in sync by me POSTing the file
by hand after each edit — if I forget, the injected copy silently drifts from the
committed source. `seedTemplates()` only seeds when absent, so a repo edit does NOT
propagate automatically.

## Design (pick one)
- (a) **Read-through**: the living template resolves its body from the repo file at
  compose time when a `source:` path is set (no data copy to drift). Cleanest.
- (b) **Sync-on-change**: a small watcher / npm script / git hook re-saves the
  template from the repo file when it changes (still backs up via saveTemplate).
- (c) Minimal: a `npm run sync:agreements` the dev runs. Weakest (still manual).
Recommend (a): eliminate the second source of truth entirely for `living` docs
that declare a `source`.

## Verification
Edit the repo file → a newly-composed session reflects it with NO manual POST.
typecheck + a compose test.

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
