# FEAT-121 — onboarding never verifies its own `npm run` commands resolve

- **Status:** VERIFIED (fix + regression suite green; independent clean-room pass recommended — see handoff)
- **Severity:** medium
- **Area:** onboarding (scripts/onboard.mjs)
- **Reported:** 2026-09-03 by orchestrator dispatch
- **Verification-class:** fix ⟶ independent verification recommended (regression-prone: half-onboarding already shipped to a real project)

## Symptom
`scripts/onboard.mjs` writes `npm run board:check`, `npm run board:gen` and
`npm run arch:watch` into every project's `CLAUDE.md` and
`docs/bugs/README.md`, but nothing ever checked those commands resolve to a
real `package.json` script. A real project (`trading_volume`) was onboarded
with **no `package.json` at all**, so every documented board command failed
outright — a "told to X, the wired path to X is missing" trap that went
undetected until a human hit it.

## Repro
1. `node scripts/onboard.mjs <dir>` on a directory with no `package.json`
   (pre-change tree).
2. onboard writes docs referencing `npm run board:check` etc.
3. It reports `SKIPPED (no package.json …)` and exits 0.
4. In that project, `npm run board:check` → "Missing script" / npm error. The
   documented instruction is dead, and onboarding never noticed.

## Expected
Onboarding proves its own instructions work. Every `npm run <x>` it emits into
a project must resolve to a real script in that project's `package.json`, or
onboarding fails loudly and specifically (names the missing script + the file
that references it). A project with no `package.json` gets a minimal one wiring
the board scripts, so the emitted docs are true.

## Fix (2026-09-03)
Both a root-cause repair and a detector, in `scripts/onboard.mjs`:

1. **Single source of the wired scripts.** The `wanted` map inside
   `installBoardTool()` is hoisted to a module-level `WIRED_NPM_SCRIPTS`. Both
   the injector and the new checker read it — no hand-typed list to fall behind.
2. **No-`package.json` root-cause fix.** When a target has no `package.json`,
   onboard now CREATES a minimal `{name, version, private, scripts:
   WIRED_NPM_SCRIPTS}` instead of SKIPPING. Chosen over rewriting the docs to
   `node scripts/board.mjs …` because the method's whole UX is `npm run
   board:*` — one dialect everywhere beats a no-`package.json`-only second
   dialect every other doc example contradicts. Minimal, private,
   dependency-free — small and standard.
3. **Post-onboard smoke check.** `verifyEmittedNpmScripts()` parses the actual
   `npm run <x>` references out of the DOC TEMPLATES onboard injects (not a
   hand-typed list; handles the line-wrapped refs and skips placeholders like
   `npm run verify:<x>`) and asserts each resolves in the target's
   `package.json`. Runs at the END of `onboard()` (a fresh onboard that left
   dead commands now exits 1, naming each dead script + referencing file) AND
   as a standalone `node scripts/onboard.mjs <dir> --verify-only` (writes
   nothing; exit 0 all-resolve / 1 any-dead) a session can run against an
   existing project.
4. An unparseable existing `package.json` is never overwritten, but onboard
   now exits 1 (loud) rather than silently leaving dead documented commands.

**Files:** `scripts/onboard.mjs` (fix), `scripts/verify-onboard.mjs` (7 new
regression cases (h)-(k)).

**git-init recommendation (not built):** a non-git onboarded project silently
degrades the board's commit tracking and arch-watch clustering. onboard should
WARN when the target is not a git repo (and could offer `git init`), but must
not `git init` as a silent side-effect — that is the user's decision. Filed as
a recommendation here; not built in this pass (out of the contained scope).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-03 — onboard-fix worker
- **Understood:** onboarding emitted `npm run` commands into docs it wrote but
  never checked they resolve; `trading_volume` shipped with no `package.json`,
  so every documented board command was dead and undetected.
- **Changed:** `scripts/onboard.mjs` — hoisted `WIRED_NPM_SCRIPTS`; create a
  minimal `package.json` when none exists; added `extractNpmRunRefs`,
  `emittedNpmScriptRefs`, `verifyEmittedNpmScripts` (exported),
  `smokeCheckReports`; wired the smoke check into `onboard()` and a standalone
  `--verify-only` flag; `main()` exits 1 on SMOKE FAIL. `scripts/verify-onboard.mjs`
  — cases (h) no-pkg → minimal pkg created + `npm run board:check` runs,
  (i) `--verify-only` on half-onboarded → exit 1 naming dead script + file +
  writes nothing, (j) `--verify-only` on healthy → exit 0, (k) unparseable pkg
  → exit 1, never overwritten. Uncommitted (worker leaves git to the user).
- **Verified:**
  - MUST-FAIL (pre-change): reconstructed `git show HEAD:scripts/onboard.mjs`,
    ran it on a no-`package.json` scratch → no `package.json` created, docs
    reference `npm run board:check`. New `--verify-only` against that output →
    SMOKE FAIL, exit 1, naming `board:check`/`board:gen`/`arch:watch` and their
    files. Post-change onboard on the same dir → creates `package.json`, SMOKE
    PASS, exit 0.
  - Scratch A (fresh, no pkg, new code): minimal `package.json` created; `npm
    run board:check` exits 0.
  - Unparseable pkg: onboard exits 1, pkg untouched.
  - `node scripts/verify-onboard.mjs` → **51 passed, 0 failed** (was 44; +7).
  - `npm run gate` → exit 0 (checked directly, unpiped).
- **Still open / handoff:** regression-prone (half-onboarding already shipped
  to a real project) — an independent clean-room verify pass
  (`scripts/independent-verify.mjs` or a fresh-context agent) is warranted
  before this is trusted as fully closed; generation should not be its own only
  verifier. Also open: the git-init WARN recommendation above (not built).
- **Symptom of a deeper design flaw?** no — the design flaw ("onboarding never
  tests its own emitted instructions") is exactly what this ticket closes; the
  fix makes onboarding self-verifying rather than papering over a symptom.
