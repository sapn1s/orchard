```orchard-ticket
{
  "id": "BUG-021",
  "type": "bug",
  "title": "Inherited sessions hid the model they would use",
  "summary": "The model picker now names the concrete model resolved from project and global defaults, with inherited state distinguished from an explicit selection. The pre-fix case failed, corrected default and override behavior passed, and type checking stayed clean.",
  "impact_if_we_wait": "Users cannot see which model an inherited session will use, weakening confidence before sending work. Bounded: this is display-correctness and UX clarity, not model-selection corruption or data loss.",
  "current_need": "Treat the ticket as closed: the pre-fix case failed, corrected inheritance and override behavior passed, and type checking stayed clean.",
  "severity": "medium",
  "area": "Model picker",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "An inherited session displays the concrete resolved model with an inherited tag",
    "An explicit model selection displays that model",
    "Clearing an explicit selection restores the resolved inherited display"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "resolveCurrentModelOpt",
      "note": "Resolves the current model option for inherited and explicit selections"
    },
    {
      "path": "public/app.js",
      "symbol": "paintModelBtn",
      "note": "Renders the current model on the picker button"
    },
    {
      "path": "public/app.js",
      "symbol": "paintModelPop",
      "note": "Renders the model picker popover"
    },
    {
      "path": "public/app.js",
      "symbol": "adoptModelList",
      "note": "Adopts model-list data used to resolve the displayed selection"
    }
  ],
  "related": [
    {
      "id": "BUG-026",
      "relation": "see_also"
    },
    {
      "id": "FEAT-031",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-042",
      "relation": "blocks"
    },
    {
      "id": "FEAT-045",
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
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-021-model-picker-vague-current.md",
    "sha256": "d4075f8caf280a122b99cf39458c56fcf8d04e5bb7f9359c516dbe322a9e5f4f",
    "bytes": 7415,
    "original_title": "/model picker shows \"Whatever the project is set to\" instead of the actual resolved model",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared field by field against the archived ticket; the symptom, resolved-model behavior, inherited affordance, picker symbols, sequencing dependency, and executed failure-then-pass evidence are present.",
    "dropped": []
  }
}
```

# BUG-021 — Inherited sessions hid the model they would use

## Diagnosis

When a session had no explicit model override, the picker described the inheritance behavior instead of resolving and displaying the project default. That project default could itself require resolution through the global default.

## Evidence

Before the fix, `app.js` was tested with the change stashed and `verify:model-picker` passed only 6/14 cases. After the fix, `verify:ui` passed 3/3, `verify:model-picker` passed 14/14, `verify:overrides` passed 5/5, and `verify:new-session-overrides` passed 5/5. Type checking also completed cleanly.

## Implementation notes

For an unset session model, resolve the project default and any global default beneath it. Render the concrete model name with an inherited affordance. Keep the option for selecting project-default behavior distinct from the current-state readout.

## Verification plan

Exercise an inherited session, an explicit model selection, and clearing that selection. Confirm the inherited states show the concrete resolved name and inherited tag, while the explicit state shows its selected model.

## Risks

Default resolution must remain consistent between the picker button and popover. A mismatch could show different current models across the two views without changing the session's actual model.

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
