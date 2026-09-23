# BUG-181 — the image-staleness suite fails on its own incomplete copy of the tree

- **Status:** OPEN
- **Severity:** medium (no product defect; the suite is a permanently red gate that
  will be read as a product regression by every lane that runs it)
- **Area:** verification harness (`scripts/verify-bug-107-image-staleness.mjs`)
- **Reported:** 2026-09-18 by the FEAT-145 step-6 lane (container account binding), found in passing
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom

`node scripts/verify-bug-107-image-staleness.mjs` scores **5/18**. The failures
present as `container-manager` being unable to load at all, which reads exactly like a
container regression — and container-manager is a file several live lanes are editing,
so the next person to run this suite will start diagnosing product code that is fine.

## Repro

`node scripts/verify-bug-107-image-staleness.mjs` at HEAD → 5 passed / 13 failed.
Observed 2026-09-18 during the FEAT-145 step-6 sibling sweep, alongside
`verify-container.mjs` (PASS), `verify-feat-102-static` (10/10),
`verify-feat-102-dispatch-broker` (25/25) and `verify-bug-152-browser-degrades` (25/25)
— i.e. every other container-adjacent suite was green in the same run.

## Root cause

The harness builds a throwaway tree and copies **only `src/`** into it. But
`src/server/container-manager.ts` imports `registry.ts`, `registry.ts` imports
`wiring.ts`, and `wiring.ts` imports `scripts/lib/board-path.mjs`. That module is
outside `src/`, so it is absent from the copy and the import chain dies before any
assertion in the suite gets to run.

## Why this is a false red, not a product defect

The missing module is a property of the COPY, not of the repo. The import chain
predates every change now in flight — container-manager has always imported registry —
and the same code passes under every suite that runs against the real tree. Nothing
here is evidence about the shipped product, which is precisely what makes it
expensive: a permanently-red suite in the container family trains lanes either to
ignore it or to go hunting in correct code. It is **not** caused by FEAT-145 and was
already failing before that work started.

## Fix direction (for the fixer)

Copy `scripts/lib/` into the throwaway tree alongside `src/`, then re-run and confirm
the suite reaches 18/18 rather than merely getting past the import. Prefer deriving
what to copy from the actual import closure over adding one more hardcoded directory —
the next cross-boundary import will otherwise reproduce this exactly. Whichever is
chosen, the suite must FAIL LOUDLY and distinguishably when a module is missing from
its own copy, instead of reporting that as a subject-under-test failure: a harness that
cannot tell "I did not copy it" from "it is broken" is the whole defect here.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play: `scripts/verify-bug-107-image-staleness.mjs` (the tree copy),
  `src/server/container-manager.ts`, `src/server/registry.ts`, `src/server/wiring.ts`
  (the import of `scripts/lib/board-path.mjs`), `scripts/lib/board-path.mjs`.
- Related tickets: BUG-107 (the defect this suite exists to guard), FEAT-145 step 6
  (where the red was observed; unrelated by cause).
- Repro test: the suite itself is the repro — `node scripts/verify-bug-107-image-staleness.mjs`.
- Known dependencies / blockers: none. Independent of the FEAT-145 lanes; can be fixed
  at any time.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-18 — filed from the FEAT-145 step-6 sibling sweep
- **Understood:** the step-6 container lane ran the container-adjacent suites as
  anti-regression, found this one at 5/18 while all its siblings were green, and traced
  the failure to the harness's own incomplete tree copy rather than to any product code.
- **Changed:** filed this ticket only. No code written — the finding lane owned
  `container-manager.ts`, not this harness.
- **Verified:** the diagnosis is the observing lane's, recorded verbatim on FEAT-145:
  the copy takes only `src/`, and `registry.ts → wiring.ts` reaches
  `scripts/lib/board-path.mjs` outside it. Not independently re-run for this filing.
- **Still open / handoff:** un-owned. Fixer: make the copy carry the import closure (or
  at minimum `scripts/lib/`), get the suite to a genuine 18/18, and make a
  missing-from-copy module report as a harness error rather than a subject failure.
- **Symptom of a deeper design flaw?** not closing this ticket, so not answered yet —
  but note the shape is the same one BUG-179 records for the renderer suite: a harness
  that reconstructs a partial tree re-breaks every time the code under test grows an
  import across the boundary it chose. Worth an ARCH if a third instance appears.
