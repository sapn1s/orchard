# BUG-179 — the renderer's own browser suite FATALs at the finish: a pinned prior-generation parser is imported against the current dom.js

- **Status:** OPEN
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
