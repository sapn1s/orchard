# BUG-179 — the renderer's own browser suite FATALs at the finish: a pinned prior-generation parser is imported against the current dom.js

- **Status:** VERIFIED — calibration FATAL fix confirmed by independent clean-room verify (2026-09-29, run ba89cdd6). The residual whole-suite exit-1 is the 7 unrelated pre-existing legs (tracked separately, BUG-200), not this defect.
- **Severity:** medium
- **Area:** renderer / verification harness (`scripts/verify-feat-091-renderer.mjs`)
- **Reported:** 2026-09-16 by verifier (FEAT-142/143 round-2 DOM verify)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom
`node scripts/verify-feat-091-renderer.mjs` runs all of legs [A]–[R] GREEN and then dies:

```
FATAL: Error: page threw: SyntaxError: The requested module './response-blocks.js'
does not provide an export named 'fenceSegments'
    at Cdp.eval (…/scripts/verify-feat-091-renderer.mjs:137:35)
    at async main (…/scripts/verify-feat-091-renderer.mjs:1411:9)
```

Process exits **1**. So the renderer's entire real-browser suite — the ONLY thing that renders `renderAssistantText()` through a real browser DOM — reports failure on every invocation and cannot be used as a green gate. It has been non-functional (FATAL, never a clean exit) since `fenceSegments` became a cross-module import; two independent verifiers (FEAT-142 and FEAT-143 round 1) were each blocked from driving the browser by exactly this FATAL and had to fall back to the data layer.

## Repro
`node scripts/verify-feat-091-renderer.mjs` at HEAD → all named checks PASS, then the FATAL above, exit 1. Reproduced at HEAD on 2026-09-16.

## Expected
The suite either completes with a clean exit 0 (all legs including the non-vacuity calibration) or SKIPs the calibration leg gracefully — it must not FATAL the whole run on a self-inflicted module-linking error, because a suite that can never go green is not a gate anyone can trust or wire in.

## Root cause (diagnosed one level)
The non-vacuity ("this leg must FAIL on the generations it claims to catch") calibration at `scripts/verify-feat-091-renderer.mjs:~1378–1411` swaps the SERVED bytes of `public/lib/response-blocks.js` for a pinned PRIOR generation via CDP `Fetch.fulfillRequest` (shas `91b35ab` = round 9, `52807b9` = round 7), then re-imports `/lib/digest.js` fresh so the page links against the old parser.

But it pins ONLY `response-blocks.js`. The rest of the import graph stays at HEAD, and current `public/lib/dom.js:6` does `import { fenceSegments } from './response-blocks.js'` (used at `dom.js:339`). `fenceSegments` is a NEWER export (`public/lib/response-blocks.js:1926`) that did NOT exist in the round-7/round-9 generations being served. So the browser's ES-module linker rejects the graph: current `dom.js` demands an export the pinned old `response-blocks.js` does not provide → `SyntaxError: does not provide an export named 'fenceSegments'` → the harness's `cdp.eval` rethrows it as a FATAL and aborts.

In short: the pinned-generation swap assumes `response-blocks.js` can be substituted in isolation, but the current renderer's import surface has grown a symbol (`fenceSegments`) the pinned generations never exported, so linking the mixed graph is now impossible. The export IS present and correct in source and in a node import (this is NOT a build/packaging bug in the shipped renderer — the app itself is fine); the defect is purely in the calibration leg's cross-generation module mixing.

## Fix (candidate — not yet implemented; for the fixer)
Options, roughly in order of preference:
- Pin the WHOLE parser-touching import surface together (serve the pinned generation's `dom.js` too, or the closure the swapped module is linked against), so the graph is internally consistent; or
- Detect the export mismatch and SKIP the affected calibration sha with a recorded reason (the harness already has a SKIP path for "history unavailable in a clean-room export with no .git" at `:1391` — extend that to "pinned generation predates a required export"); or
- Shim the missing export when serving an old generation (append a stub `export function fenceSegments…` to the served bytes) so linking succeeds and the OLD scanner behaviour is still what's under test for the classification it calibrates.
Whichever is chosen, the leg must still genuinely FIRE (its non-vacuity purpose) on the generations it can load, and the run must exit 0.

## Context pack
- Files in play: `scripts/verify-feat-091-renderer.mjs` (calibration leg ~1360–1411; `Cdp.eval` rethrow at `:137`; SKIP precedent at `:1391`), `public/lib/dom.js:6,:339` (the `fenceSegments` import/use), `public/lib/response-blocks.js:1926` (the export), `public/lib/digest.js` (the imported entry the page loads).
- Related tickets: FEAT-091 (the suite this belongs to), FEAT-142 / FEAT-143 (both round-1 independent verifiers blocked by this FATAL; both round-2 DOM verifies had to route around it with a static-server harness), BUG-111 (fence handling), ARCH-006 (mixed line endings — same renderer).
- Repro test: `node scripts/verify-feat-091-renderer.mjs` (not in package.json `scripts`; run by path). No standalone repro script exists — the FATAL itself is the repro.
- Known dependencies: the pinned shas must remain reachable in `.git`; a clean-room export with no history already SKIPs (`:1391`).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-16 — verifier (Opus 4.8), FEAT-142/143 verifying round 2
- **Understood:** the charter flagged `verify:feat-091-renderer` FATALing on a served-module export (`fenceSegments`) as a pre-existing orphan defect blocking DOM-level verification, and asked me to confirm it reproduces at HEAD, diagnose one level, and file it.
- **Reproduced at HEAD:** ran `node scripts/verify-feat-091-renderer.mjs` — legs [A]–[R] all PASS (e.g. 28628 generated cases rendered without throwing; 20000 stratified sampled documents rendered; AX legs green), then FATAL on the `fenceSegments` export mismatch, **exit 1**. Full log `/tmp/rvr.log`.
- **Diagnosed:** the FATAL is in the non-vacuity calibration leg (`:~1378–1411`) which serves a PINNED PRIOR generation of `response-blocks.js` (shas `91b35ab`, `52807b9`) via CDP `Fetch.fulfillRequest` but leaves `dom.js` at HEAD; current `dom.js:6` imports `fenceSegments` (`response-blocks.js:1926`), a symbol those old generations never exported, so the ES-module linker rejects the mixed graph. Confirmed `fenceSegments` IS exported in source and importable in node → the shipped renderer is fine; the defect is the calibration leg mixing generations across an import boundary. (This matches both FEAT-142 and FEAT-143 round-1 verifiers' independent read that it is pre-existing and byte-identical to HEAD.)
- **Changed:** nothing in product code — filed this ticket only. (No fix attempted; owner to pick from the candidates above.)
- **Verified:** the FATAL is deterministic (reproduced; exit 1); it is NOT introduced by FEAT-142/143 (those touch `docs/prompts/RESPONSE_FORMAT.md`, the Stop-hook, and FEAT-085 suites — none of `dom.js` / `response-blocks.js` / the renderer harness).
- **Still open / handoff:** un-owned. Fixer: pick a fix option, make the calibration leg load a consistent graph (or SKIP with a reason), and require exit 0. Because this suite is the only real-browser render of `renderAssistantText()`, restoring it to green also restores the renderer's regression gate.
- **Symptom of a deeper design flaw?** Possibly — a harness that pins one module of a growing import graph will re-break every time the renderer adds a cross-module export, so the "swap one generation's bytes" technique is structurally fragile. Not filing an ARCH now (first recorded instance); flag for the fixer to reconsider if a second import-surface growth re-breaks it.

### 2026-09-29 — fixing lane (Opus 4.8), round 1 — calibration FATAL fixed by pinning the whole closure; residual exit 1 is unrelated pre-existing legs
- **Chose fix option 1 (preferred):** pin the WHOLE parser-touching import closure of the pinned
  generation, not `response-blocks.js` alone. Verified the closure is exactly
  {`digest.js`,`dom.js`,`route.js`,`response-blocks.js`}: `digest.js` imports `el`/`prose` from
  `dom.js`, `formatTicketsHash` from `route.js`, `parseResponseBlocks` from `response-blocks.js`; and
  `dom.js:6` imports `fenceSegments` from `response-blocks.js` (the only importer of that symbol,
  `rg fenceSegments public/` → `dom.js` only). Confirmed all four files exist at BOTH pinned shas and
  are self-consistent there: at `91b35ab` and `52807b9` the old `dom.js` and `route.js` have NO
  imports and old `digest.js` imports only `parseResponseBlocks` (no `COLLAPSED_BLOCKS`), so serving
  the four together is a real historical renderer — internally consistent by construction, and the
  OLD parser behaviour is still what the leg calibrates. `renderAssistantText` is exported at
  `digest.js:311` in both generations (matches the harness call).
- **Changed (test-only):** `scripts/verify-feat-091-renderer.mjs` calibration leg (~:1365–1440):
  build a per-generation `git show <sha>:public/lib/<f>` map for the four closure files; broaden the
  `Fetch.enable` patterns from `*/lib/response-blocks.js` to all four; the `Fetch.requestPaused`
  handler fulfils each request with that generation's bytes (falls back to `Fetch.continueRequest`
  for anything outside the map). If ANY closure file is unreachable (clean-room export with no
  `.git`), the whole generation SKIPs with a reason naming the missing file (the pre-existing SKIP
  path, generalised). No product code touched.
- **Before (must-FAIL, isolated with tiny sample knobs `FEAT091_RENDER_POOL=3000 SAMPLE=400
  CAL=200`, HEAD copy of the script):** `FATAL: Error: page threw: SyntaxError: The requested module
  './response-blocks.js' does not provide an export named 'fenceSegments'`, exit 1 — the exact
  reported FATAL, reached fast.
- **After (full run, default 8000 CAL):** NO FATAL. Both calibration legs FIRE and PASS —
  `NON-VACUOUS vs round 9 (91b35ab) … >=5 F3` PASS and `NON-VACUOUS vs round 7 (52807b9) … >=20 F1`
  PASS — and `the LIVE parser bytes are restored after the calibration` PASS. (At the tiny CAL=200
  the round-9 floor of 5 is not reached — F3≈0.6%→~1.2 expected — that is sample size, not the
  linking bug; it PASSES at the real 8000 CAL.) The calibration leg previously could never execute
  because the FATAL aborted the run before it; its PASS is itself proof the mixed-graph link now
  succeeds.
- **Residual exit 1 — a SEPARATE finding, NOT BUG-179 and NOT caused by this change:** the suite
  still exits 1 because of **7 other failing legs** that run BEFORE the calibration leg and are
  untouched by this fix: `the Stop hook imports the grammar by the shared path` (:109) and the
  reader-addressed digest legs (:273–299: five-block visibility, supporting-record fold, nothing
  reader-addressed folded, per-category captions, single finding preview, AX ask+caption). Proven
  pre-existing: they appear IDENTICALLY (same 7, same line numbers) in the before-fix HEAD run and
  the after-fix run, and they execute before line ~1378. The renderer product (`response-blocks.js`,
  `dom.js`, `digest.js`) is CLEAN in this tree, so these track drift elsewhere (RESPONSE_FORMAT.md /
  the Stop hook / digest fold behaviour) from other in-flight lanes. I did NOT touch them or product
  code to force green — that would be papering over. **Handoff:** BUG-179's own defect is fixed;
  these 7 legs need their own triage/ticket (likely a FEAT-142/143-era RESPONSE_FORMAT / Stop-hook
  drift or a real digest regression). Full logs: `/tmp/bug179-run.log` (full), `/tmp/bug179-before.log`,
  `/tmp/bug179-after-tiny.log`.
- **Sweep (test-suite-only, per charter):** hunted other calibration legs that swap ONE module.
  Every other `Fetch.fulfillRequest` swap in `scripts/` either serves the WHOLE `app.js` entry
  (root of the graph, no leaf mismatch: `verify-bug-129/149/150/153/166`, `verify-feat-118`) or
  swaps a MUTATED copy of the CURRENT `drawer.js`/`styles.css` — same generation, so no cross-gen
  export mismatch (`verify-feat-146-{shell,rows,content,polish}`). None pin an OLD generation of a
  single module against a HEAD import graph. So `verify-feat-091-renderer.mjs` was the only instance;
  nothing else to fix.
- **Verified:** before/after as above. Not marking VERIFIED — this is a fix, independent
  verification still owed. Because the residual 7-leg exit-1 means the suite is still not a green
  gate end-to-end, an independent verifier should confirm (a) the calibration linking fix in
  isolation and (b) attribute the 7 unrelated legs.
- **Symptom of a deeper design flaw?** The 2026-09-16 note stands: pinning against a growing import
  graph is structurally fragile. This fix pins the whole closure, which is robust to symbol growth
  WITHIN the closure, but a NEW cross-module edge out of the closure would need the closure list
  updated. Still one recorded instance of the fragility; no ARCH yet.

### 2026-09-29 — clean-room verify lane, round 1 (driver): HOLDS (VALID)
- **Verified-by:** dispatch anthropic run ba89cdd6-7b2a-4dd1-aca0-cf50f3903475 (clean-room,
  `scripts/independent-verify.mjs --working-tree`, grey account — same-provider fallback, openai
  exhausted; VERIFY.md #5) — VERDICT: HOLDS, verdict-contract VALID.
- **What was verified — the calibration leg's linking behaviour (the sole property in scope):** the
  independent verifier re-ran the fixer test (`node scripts/verify-feat-091-renderer.mjs`) and built
  adversarial cases the fixture does not cover. (a) A fire-path case serving a *synthetic*
  consistent 4-file closure: the calibration leg LINKS and grades WITHOUT the `fenceSegments`
  SyntaxError FATAL and without aborting the run; the live parser bytes are restored afterward. (b)
  A partial-closure case where `response-blocks.js` resolves but `dom.js` does not: both generations
  SKIP gracefully with a reason NAMING `dom.js`, the leg does not fire on an inconsistent graph, and
  there is no FATAL. Both adversarial runs exited 0. This confirms the closure-pinning fix removes
  the fenceSegments FATAL and that unreachable-closure-file now takes the graceful-SKIP path — the
  exact requirement.
- **Honest limitation (verifier's own "could not test", NOT a defect):** the clean room is a `git
  archive` export with NO `.git`, so the REAL pinned shas `91b35ab`/`52807b9` could not be read.
  The real historical 4-file closure's FIRE-and-PASS at the F3>=5 / F1>=20 non-vacuity floors was
  therefore NOT re-exercised here (the fixer verified that in the real repo, with .git). What the
  clean room proves is the linking/SKIP behaviour that WAS the reported FATAL; the git-present
  floor check is the fixer's own prior evidence, unchanged.
- **Scope confirmed:** the verifier judged ONLY the calibration leg. In the clean room the fixer
  suite actually exited 0 (the 7 "pre-existing failing legs" cited in the fix note depend on
  drift in the stripped `docs/prompts`/Stop-hook surface, which the clean room replaces with inert
  stubs, so they did not fire) — so the exit-code did not confound this verdict. The whole-suite
  green-gate concern (residual exit-1 in the live tree from those 7 legs) is a SEPARATE finding
  tracked at BUG-200, not part of BUG-179's defect. INDEX untouched (orchestrator-owned).
