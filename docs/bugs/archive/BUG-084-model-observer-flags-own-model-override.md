# BUG-084 — model-observer flags the user's OWN /model override as a per-turn "silent switch"

- **Status:** VERIFIED 2026-08-13 — post-fix 5/5 (must-FAIL pre-fix 3/5 proven, false-positive cases 1 + 1b FAIL); client-only, live on page reload (static serving, no deploy)
- **Area:** FE model-observer (app.js) — `model-observed` per-turn compare (FEAT-042)
- **Reported:** 2026-08-13 by user:
  > the transcript keeps showing "model changed: Fable → opus-4-8" notices even though the
  > session is genuinely running on Opus 4.8 (the user's `/model claude-opus-4-8` took effect;
  > the last 15 main assistant messages are all `claude-opus-4-8`).

## Symptom
The transcript repeatedly surfaces a "model changed: Fable → opus-4-8 (per-turn report)" notice on a
session the user deliberately switched to Opus 4.8. It is a FALSE POSITIVE: opus-4-8 IS the user's
own active selection, so their own model answering is being reported as an unrequested change, on
repeat (once per session (re)attach / resume).

## Root cause (confirmed with evidence)
Two DISTINCT notice variants share the "Fable → opus-4-8" wording; only ONE is the bug.

- **Variant A — `model-observed` "per-turn report" (THE FALSE POSITIVE).** Server
  (`src/server/agent-bridge.ts:2058`) emits `model-observed` with the wire id whenever the
  main-thread assistant model changes from `#lastWireModel` (server-side dedupe — correct, NOT a
  configured-vs-live compare). The client compares it against `expectedLiveModel`
  (`public/app.js`, `model-observed` case). `expectedLiveModel` is seeded at `session-init`
  (`public/app.js:6445`) to the model the CLI reports at init — which is the CONFIGURED default
  `claude-fable-5` (the settings.json global default), NOT the user's `/model` override
  `claude-opus-4-8`. So each resume seeds baseline=Fable, then the first opus turn's
  `model-observed` computes `silent = expected(Fable) !== observed(opus)` → **flag "Fable → opus-4-8
  (per-turn report)"**. `sameModel()`'s comment says this is "the one false alarm this feature must
  never raise", but the compare was against the stale default, not the user's selection.
- **Variant B — `model-changed` "refusal fallback · cyber" (GENUINE — kept).** The session's
  Claude-store transcript jsonl has 8 real
  `system/model_refusal_fallback` frames (`originalModel=claude-fable-5`, `fallbackModel=claude-opus-4-8`,
  `apiRefusalCategory=cyber`; 3 recent: 2026-08-12T23:09, 08-13T00:08, 08-13T00:48). Each is a real
  safeguard refusal, surfaced via `model-changed` (`agent-bridge.ts:2531`) → always flagged. This is
  legitimate signal (why the answering model changed) and is PRESERVED.

Transcript ground truth: main-thread wire model transitioned Fable→opus-4-8 at 2026-08-12T08:56 and
stayed opus-4-8 through 08-13T01:03 (last 30 main messages all `claude-opus-4-8`). So the wire model
has been stable for a day — the ongoing per-turn notices are the Variant-A false positive re-seeding
on every resume, not a real switch.

## Fix
`public/app.js`, `model-observed` handler: the baseline is what the USER SELECTED, not the CLI's
init-reported default. Added `const chosen = state.overrides?.model ?? null` (the user's explicit
`/model`, set by `finishModel()` and persisted) and `matchesChoice = chosen != null &&
sameModel(chosen, e.model)`. `silent` now also requires `!matchesChoice`; when the report matches the
user's choice it quietly REALIGNS `expectedLiveModel` (no flag), so a later GENUINE deviation (live ≠
selection AND ≠ last) still surfaces. `model-changed` (Variant B) is untouched. When the user made NO
explicit `/model` choice (`chosen == null`) behaviour is identical to before — an unexplained wire
change still flags.

Layer justified: the server's per-turn emission is correct (dedup by last wire id); the wrong
baseline is purely client-side. Fixing the compare (client) is the minimal correct layer.

## Verification (§C)
`scripts/verify-bug-084-model-selection.mjs` + `npm run verify:bug-084`. Real brave-headless + real
server, drives the app's OWN dispatcher `window.__station.onEvent` and render site
(`flagModelChange` → `.model-change`); each scenario in a fresh page (module state re-boots).
- **1** live == the user's `/model` choice (Fable seeded, override=opus, observed opus) → NO notice.
- **1b** override canonical vs dated wire id (`claude-opus-4-8` vs `…-20250101`) → NO notice (sameModel containment).
- **2** genuine silent switch (chose opus, observed sonnet) → STILL flags.
- **3** real `model_refusal_fallback` (model-changed, cyber) → STILL flags.
- **4** NO explicit override, wire change off baseline → STILL flags.

Results: **post-fix 5/5**. **Must-FAIL pre-fix (fix stashed): 3/5** — cases 1 + 1b render the
false-positive "per-turn report" notice (2/3/4 unchanged), proving the reproduction.

Anti-regressions: `verify:bug-081` 14/14, `verify:model-chip` (FEAT-042) 1/1, `verify:model-switch`
(BUG-026) 1/1, `verify:ui` 7/7, `typecheck` clean, `leak-gate` PASS.

## Activity log (APPEND-ONLY)
### 2026-08-13 — investigate + fix (FE lane)
- Filed after confirming root cause from code + the live transcript jsonl (8 refusal-fallback frames;
  wire model stable opus-4-8 for a day). Root cause: `expectedLiveModel` seeded from the CLI's
  configured default (Fable) at `session-init`, not the user's `/model` override (opus) — Variant A.
- Fix in `public/app.js` `model-observed` handler (compare against the user's selection); Variant B
  (`model-changed` refusal-fallback) deliberately preserved.
- Verify `scripts/verify-bug-084-model-selection.mjs` (`npm run verify:bug-084`): post-fix 5/5,
  must-FAIL pre-fix 3/5 proven. Anti-regressions all green (see §C).
- **Reach:** client-only (`public/app.js`, statically served) — takes effect on the next page
  reload; **no server deploy needed** (the server-side `model-observed` emission was already correct).
