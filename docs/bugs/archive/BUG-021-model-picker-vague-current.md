# BUG-021 — /model picker shows "Whatever the project is set to" instead of the actual resolved model

- **Status:** VERIFIED
- **Severity:** med (UX clarity — you can't see what model you'll actually get)
- **Area:** model picker (composer / `/model`)
- **Reported:** 2026-08-04 by user

## Symptom
The model picker's current/selected display reads literally **"Whatever the project is
set to"** for a session inheriting the project default — a description of the *behaviour*,
not the actual model. The user can't tell which model is really in effect.

## Expected
Show the RESOLVED model. For an inheriting session, display the actual project-default
model with an "inherited" tag, e.g. **"Project default · Opus 4.8"** (or the real resolved
name) — not an opaque phrase. The "use project default" OPTION can still be labelled as
such, but the CURRENT-state readout must name the concrete model in effect.

## Fix direction
In the model picker (`public/app.js` — `resolveCurrentModelOpt` / `paintModelBtn` /
`paintModelPop` / `adoptModelList`, from this session's earlier picker work), when the
session model is unset (inherits), resolve the project default (and the global default it
in turn resolves to) and render the concrete model name + an "inherited" affordance, instead
of the placeholder string. Survey the current picker code first (Serena
`find_symbol`/`find_referencing_symbols` on those functions).

## Verification (REQUIRED, §C user-observable)
Real browser: a session with no model override shows the CONCRETE resolved model name (not
"Whatever the project is set to") with an inherited tag; setting an explicit model shows that
model; clearing it returns to the resolved-default display. verify:ui offline + typecheck
(or a Playwright spec once that harness lands).

## Context pack
- Touches: `public/app.js` (model picker). Serialize with other FE tickets (after FEAT-031).

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed from user. Placeholder copy from this session's picker work; fix = resolve + show the
  concrete model, keep an "inherited" tag.

### 2026-08-04 — fix agent (BUG-021)
**Serena:** available and used throughout (`find_symbol`, `get_symbols_overview`,
`replace_symbol_body`) — `find_symbol` on `resolveCurrentModelOpt`/`paintModelBtn`/
`paintModelPop`/`adoptModelList` gave exact bodies + line numbers in one shot without
grepping/reading the whole 5000+-line `app.js`, and `replace_symbol_body` did the two
whole-function edits (`paintModelPop`, `resolveInheritedModelLabel`) cleanly. Net win over
plain grep+Read+Edit for this file; would use it again. (Session was orphaned by a process
cycle mid-task; resumed cleanly from the tree — this entry covers the whole arc.)

**Understood:** `MODEL_OPTS`'s null row (`{v:null, n:'Project default', d:'Whatever the
project is set to'}`) had a STATIC `d` string, shown verbatim whenever that row is
"current" (no session-level model override). Traced why it can't already show a concrete
name: `effectiveModel('model')` returns `currentProject()?.settings?.model` when nothing
overrides it — and a fresh project's `settings.model` is `null` by design
(`registry.ts` `defaultSettings()`), so this is the COMMON case, not an edge case. The one
real source of truth for what a truly-unset default resolves to is the live CLI's own
report, `session-init`'s `model` field (full wire id) — which the client received but
never stored anywhere (`state.effective` was only ever built from the pre-spawn
project-settings merge, never updated post-init). That was the actual root gap, not just
a copy/wording problem.

**Changed** (`public/app.js` only, plus verify script + `package.json` + this ticket):
- `session-init` handler: folds `e.model` (the CLI's real wire id) into
  `state.effective.effective.model` and repaints the model button — closing the gap above.
- Added `resolveInheritedModelLabel()`: what "Project default" resolves to when nothing
  overrides it — project's own `settings.model` if set (existing correct path, unchanged),
  else the live wire id IF the live session's own `effective-config.overridden` doesn't
  already say `model` was itself overridden (guards against mislabeling an override's
  result as "the default"). Returns `null` (never fabricates) when truly unknown.
- `paintModelPop`: the null row's rendered `d` now uses `resolveInheritedModelLabel()`
  (falling back to a reworded, still-honest static string — "Not decided yet — resolves
  once a session runs" — only when unresolvable); adds a `.tag` "inherited" badge on that
  row when it's both current and resolved. `curModelOpt` selection: still tries a direct
  value match first (unchanged — keeps e.g. `settings.model:'opus'` lighting up the "Opus"
  row directly, no ambiguity), and only falls back to the null row when nothing matches
  AND there's no session override (previously an inherited-but-unmatched wire id lit up
  NO row at all).
- `paintModelBtn`: tooltip names the concrete model the same way, tagged
  `(project default)` when inherited.
- `MODEL_OPTS`/`adoptModelList`: reworded the static fallback `d` (see above); the OPTION
  label `'Project default'` itself is untouched per the ticket's constraint.

**Verified** (all real-browser, DOM-text assertions per §C — never internal state):
- `node scripts/verify-model-picker.mjs` (new, `npm run verify:model-picker`): 14/14 PASS
  post-fix. Re-ran against pre-fix `app.js` (git-stashed the diff) — **6/14 FAIL**, all on
  the placeholder-text and inherited-tag/concrete-name assertions, confirming the test
  actually catches the bug. Covers: fresh project with no override, no live signal → honest
  non-placeholder text, no tag; explicit override (pre-live) shows that model, no tag;
  clearing returns to the unresolved default; a live session with no override
  (`session-init` simulated via the exposed `window.__station.onEvent` hook) → CONCRETE
  resolved id + "inherited" tag in both the popover row and the button tooltip; a project
  WITH its own configured default (`settings.model:'opus'`) still lights up "Opus" directly
  (regression guard on the pre-existing correct path).
- `npm run verify:ui -- --offline`: PASS (3/3).
- `npm run typecheck`: PASS (clean, `app.js` isn't in `tsconfig.json`'s `include` so this
  only guards `src/`/`scripts/` — `node --check public/app.js` also clean).
- `npm run verify:overrides`: PASS (5/5) — anti-regression, same model-button/popover
  paths.
- `npm run verify:new-session-overrides`: PASS (5/5) — anti-regression, model override
  arm/clear across a new session.

**Open:** none for the ticket's stated scope. Note for future work: a session that has
*never run* AND has no project default (a brand-new project's very first, not-yet-started
session) still shows the honest-but-generic fallback text, not a concrete name — this is
architecturally unavoidable client-side (nothing, client or server, knows the CLI's pick
before it picks), so it was left honest rather than guessed. A further improvement could
read a project's session HISTORY (`session.models` — see `session-history.ts`'s per-session
`models: string[]`) as another resolution source for "this project has run before, just not
right now", but that data isn't currently wired into the client's session-list state and
was out of scope for this ticket's touched-files constraint.
