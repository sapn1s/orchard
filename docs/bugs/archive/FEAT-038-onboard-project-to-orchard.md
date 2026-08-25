# FEAT-038 — "Onboard this project to Orchard": one action to bring the orchestrator to any repo

- **Status:** VERIFIED/DONE — CLI core (items 1-3) BUILT + verified AND the
  one-click UI action now shipped + verified (both halves complete). Item 4 (tool
  enablement toggle) remains deliberately deferred to FEAT-025.
- **Area:** Orchard platform / cross-project adoption
- **Reported:** 2026-08-04 by user ("if I started a session in external-project-A and wanted the same orchestrator…")

## Why
The orchestrator methodology + board + rail + boot-aware + ast-grep already carry to ANY
project via station-launch + the `tickets` skill + WA-template injection — with zero new
code. But bringing it to a new repo (e.g. external-project-A) is a few MANUAL steps. This feature
makes it ONE action.

## What "onboard" does (one command / one UI action per project)
1. Scaffold the board: `docs/bugs/` (README + INDEX + TEMPLATE) via the `tickets` skill —
   opt-in, so only real repos get it.
2. Select the **Working Agreement** instruction template for that project's launched
   sessions (so every session boots as the orchestrator). For BARE-`claude` usage, drop a
   thin project `CLAUDE.md` that points at the WA.
3. Install the **board drift-guard** (`board:check`/`board:gen`) — currently
   claude-station-local (`scripts/board.mjs`); make it portable (bundle in the `tickets`
   skill or ship a shared copy) so every board has the guard.
4. Offer per-project **tool enablement** by the FEAT-025/FEAT-033 heuristic: ast-grep
   (default-on, global), Serena (auto-on for large single-LS typed repos), Playwright
   (opt-in for UI projects) — one toggle, not manual `.mcp.json` surgery.

## Sub-gaps this depends on
- FEAT-025 (per-project Serena/Playwright toggle in the UI).
- Board-tool portability (`board.mjs` → shared/skill-bundled).
- WA reach for bare-`claude` (project CLAUDE.md pointer) + FEAT-026 (core/full WA split so
  the injected surface stays lean per project).

## Verification (when built)
Onboard a scratch project → it gets docs/bugs + WA-selected sessions + board:check + the
offered tools; a launched session boots aware of its (empty) board and follows the WA. verify + typecheck.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed. Assessment: CORE is already portable (station-injection + skill + files-as-source);
  this closes the last-mile manual steps into one action. Depends on FEAT-025 + board-tool
  portability + WA-reach.

### 2026-08-04 — you (via Needs-You rail)
- **Answer:** not sure whats this jsut ack yes i see design

### 2026-08-04 — builder agent — CLI core (items 1-3) built
**Understood:** "one action" = a single idempotent script, not a UI flow (deferred
per this task's own scope — item 4's tool toggle is FEAT-025, and any UI
button is a separate pass). Read the `tickets` skill's scaffold spec
(`~/.claude/skills/tickets/SKILL.md`), this repo's own `docs/bugs/README.md`/
`TEMPLATE.md`/`INDEX.md` for the exact shape, `scripts/board.mjs` (the drift-
guard — already `--dir`-parameterized and dependency-free, so it needs no
rewriting to run in another repo), and FEAT-039's `localConventionsSection()`
(`src/server/templates.ts`) for the `docs/CONVENTIONS.md` contract it already
expects.

**Changed:**
- `scripts/onboard.mjs` (new) — `node scripts/onboard.mjs <target-dir> [--no-board] [--force-board-tool]`.
  Scaffolds `docs/bugs/{README,INDEX,TEMPLATE}.md` (item 1, skippable via
  `--no-board` for a scratch dir); drops a thin `CLAUDE.md` pointing at the
  shared WA + a `docs/CONVENTIONS.md` stub (item 2); copies `scripts/board.mjs`
  into the target project's own `scripts/` and wires `board:check`/`board:gen`
  into its `package.json` if one exists (item 3). Idempotent by construction:
  every artifact is only ever created if absent — an existing file is reported
  `exists`, never overwritten (so a hand-filled `docs/CONVENTIONS.md` or
  customized `board.mjs` survives a re-run). `--force-board-tool` is the one
  deliberate exception, to explicitly re-sync just the copied guard.
  **Design decision (documented in the file header):** copy `board.mjs`
  rather than a symlink, an absolute cross-repo path, or a published npm
  package — the copy is self-contained (still works if claude-station is
  later moved/renamed, unlike a symlink or absolute path) at the cost of the
  two copies being able to drift, which `--force-board-tool` exists to fix.
- `scripts/verify-onboard.mjs` (new) — spawns two throwaway temp project dirs
  (one with a `package.json`, one without) and asserts: fresh scaffold
  produces all 6 artifacts with the right content; the *copied* `board:check`
  actually passes on the fresh ticket-less board (not just that the file
  exists); re-running is a true no-op (hand-edited `CLAUDE.md` untouched, no
  duplicate `board:check`/`board:gen` npm-script keys, `package.json` stays
  valid); `--no-board` skips the board scaffold but still drops `CLAUDE.md`;
  `--force-board-tool` re-syncs a diverged copy while a plain re-run leaves a
  diverged copy alone.
- `package.json` — added `onboard` (→ `node scripts/onboard.mjs`) and
  `verify:onboard` npm scripts.
- This ticket — status + this entry.

**Found + fixed while building:** `scripts/board.mjs`'s `readIndex()` hard-
requires a `## Shipped` section (throws otherwise) that neither the `tickets`
skill's `SKILL.md` scaffold spec nor a bare reading of `TEMPLATE.md`/`README.md`
mentions — only visible by reading `board.mjs` itself. My scaffolded
`INDEX.md` includes a minimal placeholder `## Shipped earlier (pre-tracker)`
section so a freshly onboarded board's `board:check` passes out of the box
instead of crashing on ticket #0. **Handoff:** the `tickets` skill's
`SKILL.md` INDEX.md example (the one under "Scaffold") is missing this
section too — worth a follow-up patch to that skill file so a human
hand-scaffolding a board doesn't hit the same crash `onboard.mjs` now avoids.

**Verified:**
- `node scripts/verify-onboard.mjs` → **26/26 PASS** (see script header for
  the (a)-(f) breakdown: creation, correct content, working copied guard,
  idempotent re-run incl. no-clobber of local edits, no npm-script
  duplication, `--no-board` opt-out, `--force-board-tool` re-sync vs. plain
  re-run leaving a divergence alone).
- Manual smoke test: `node scripts/onboard.mjs <fresh /tmp dir>` (no
  `package.json` present) → correctly creates the 6 file artifacts and
  reports `package.json scripts SKIPPED (no package.json...)` instead of
  erroring; re-run reports all 6 as `exists`. Temp dir removed after.
- `npm run typecheck` → clean, no errors.
- Did NOT run `verify:ui` (explicitly out of scope — this is the non-UI CLI
  core). Did not touch `:4317`; all test dirs were `mktemp`-created under
  `/tmp` and removed by pid-scoped cleanup, no `pkill`. No git commit made.

**Still open / handoff:**
- **Item 4 (tool enablement toggle: ast-grep/Serena/Playwright)** — explicitly
  deferred to FEAT-025/FEAT-033 per this task's scope; `onboard.mjs` does not
  touch `.mcp.json` or any tool-tier config.
- **Any UI action** ("onboard this project" button in the app) — deferred;
  this ticket's CLI core is what a future UI affordance would shell out to
  (`node scripts/onboard.mjs <projectDir>`), but no `app.js`/`index.ts`/
  `agent-bridge.ts` wiring was added (explicitly out of scope for this pass).
- **WA path coupling** — the `CLAUDE.md` this drops points at an *absolute
  path into claude-station's own checkout*
  (`docs/prompts/WORKING_AGREEMENT.v2.md`), because FEAT-039 gap #2 (hoisting
  the shared WA to a project-neutral location) is still design-only. Once
  that hoist lands, `onboard.mjs`'s `claudeMd()` template needs its pointer
  path updated to match — flagged in the generated `CLAUDE.md` itself so a
  human reading it isn't surprised by the coupling.
- Consider wiring `onboard` into the actual station UI's add-project flow as
  an optional step, once FEAT-025's toggle exists to onboard item 4 alongside
  items 1-3 in one pass.

### 2026-08-05 — builder agent — UI action (last remaining piece)
**Understood:** the CLI half (items 1-3, `scripts/onboard.mjs`) was DONE + verified;
the only thing left was a one-click, in-dashboard "Onboard this project to Orchard"
that runs the SAME core the CLI does (reuse, not reimplement) with clear
success/error feedback and idempotency. Scope was `public/app.js`, `src/server/index.ts`,
`scripts/onboard.mjs` (only to expose a callable core), verify + package.json + this
ticket. Did NOT touch other server modules, `templates.ts`, `drawer.js`, or `api.js`.

**Changed:**
- `scripts/onboard.mjs` — NO code change needed: it already `export`s a callable
  `onboard(targetDir, opts)` core and only runs `main()` when invoked directly, so
  the CLI (`node scripts/onboard.mjs <dir>`) is byte-for-byte unchanged and still
  works. Added `scripts/onboard.d.mts` (new) — a 3-symbol type surface so the TS
  server route can `import { onboard } from '../../scripts/onboard.mjs'` and still
  typecheck (tsconfig `include` is `scripts/**/*.ts`, which matches `.d.mts`).
- `src/server/index.ts` — new route `POST /api/projects/:id/onboard` (~line 297,
  inside the projects block; import at the top). Looks up the project, runs the
  SAME `onboard(p.hostPath)` core, and returns `{ok, alreadyOnboarded, createdCount,
  reports}`. A missing/gone target dir (or any I/O failure) is caught and returned
  as a clean **400** with the core's own message — never a 500 stack leak. 404 for
  an unknown project id.
- `public/app.js` — right-click a project header → a small `.pop.rowmenu` overflow
  (built in JS, reusing the shared menu chrome; ~line 5456) with one item, "Onboard
  to Orchard". `onboardProject(p)` POSTs to the new route and reports honestly via
  the status line: first run → "onboarded … · N artifacts created"; a re-run →
  "already onboarded … — nothing to do"; a bad target → error-styled "could not
  onboard …". Chose an overflow (not a third always-on header icon) to keep the row
  uncluttered. Wired the menu into `closePops` + the document click/contextmenu
  dismiss handlers.
- `package.json` — added `verify:onboard-ui` (→ `playwright test
  scripts/qa/FEAT-038-onboard-ui.spec.ts`).
- `scripts/qa/FEAT-038-onboard-ui.spec.ts` (new) — real-browser §C journey.

**Verified (§C, user-observable, real browser + real on-disk artifacts):**
- `npm run verify:onboard-ui` → **1 passed**. Proves, on a scratch project: (1)
  NON-VACUOUS — none of the 6 artifacts exist and the overflow is not on screen
  before the click; (2) ONE CLICK ONBOARDS — right-click → "Onboard to Orchard"
  scaffolds all 6 on-disk artifacts (`docs/bugs/{README,INDEX,TEMPLATE}.md`,
  `CLAUDE.md`, `docs/CONVENTIONS.md`, `scripts/board.mjs`), the UI reports success
  with a real created-count, AND the copied `board:check` actually PASSES on the
  fresh board; (3) IDEMPOTENT — a second click does not crash or double-scaffold,
  the UI says "already onboarded", and a hand-edit to `CLAUDE.md` survives
  byte-for-byte; (4) INVALID TARGET — a project whose dir was removed returns a
  clean 400 (asserted status === 400, not 500) and surfaces an error-styled line
  in the UI. Screenshots: `docs/bugs/assets/FEAT-038-onboarded.png`,
  `FEAT-038-idempotent.png`, `FEAT-038-invalid.png`.
- **FAIL-before proven:** `git stash push public/app.js src/server/index.ts` (revert
  just the two source edits, keep the spec) → the spec FAILS ("Onboard to Orchard"
  menu item never appears, route 404s) → `git stash pop` restored. Non-vacuous.
- `npm run typecheck` → clean. `node scripts/verify-ui.ts --offline` → 3 passed, 0
  failed (no UI regression). `npm run verify:onboard` (the CLI core) → 26 passed, 0
  failed (CLI half still intact). `node scripts/onboard.mjs <tmp>` smoke → still
  scaffolds correctly (CLI entry unchanged).
- Did NOT touch `:4317`; the spec spawns its own server on an OS-assigned free port,
  kills by PID (never pkill); all dirs are mktemp'd scratch, removed in afterAll. No
  git commit.

**Still open / handoff:** none for this ticket's two halves. Item 4 (per-project
ast-grep/Serena/Playwright tool toggle) stays with FEAT-025. The WA-path coupling in
the generated `CLAUDE.md` (absolute path into claude-station's checkout) is unchanged
and still tracked to FEAT-039 gap #2 — when that hoist lands, `onboard.mjs`'s
`claudeMd()` pointer needs the one-line path update, and the UI action inherits it for
free since it reuses the same core.

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
