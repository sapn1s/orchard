```orchard-ticket
{
  "id": "BUG-012",
  "type": "bug",
  "title": "Malformed search links returned an internal server error",
  "summary": "Malformed line values in search links now produce a client error instead of an internal server error. The pre-fix reproduction failed as expected, corrected checks passed eleven of eleven, and type checking remained clean.",
  "impact_if_we_wait": "Without the correction, malformed search links appear as server failures and obscure the input problem. Bounded: this affects error classification and display-correctness, not stored data or valid searches.",
  "current_need": "Treat the ticket as closed: the pre-fix case failed, corrected checks passed eleven of eleven, and type checking stayed clean.",
  "severity": "medium",
  "area": "Search links",
  "reported": "2026-08-03",
  "reported_by": "bug-hunt workflow",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Malformed line values return a client error",
    "Valid search location requests continue to work",
    "Type checking remains clean"
  ],
  "code_refs": [
    {
      "path": "src/server/index.ts",
      "symbol": "intParam",
      "note": "The search location route parsed the line value outside local error handling."
    },
    {
      "path": "src/server/index.ts",
      "symbol": null,
      "note": "The transcript route demonstrated mapping the same parsing error to a client response."
    },
    {
      "path": "src/server/validate.ts",
      "symbol": "intParam",
      "note": "Throws when the supplied line value is not an integer."
    }
  ],
  "related": [],
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
    "archived_path": "docs/bugs/archive/BUG-012-search-locate-returns-500-instead-of-400-for.md",
    "sha256": "d2099f91c95da4d5dc1fa3c279d154a1f15a4ff2a380f7761f919da67ae68c5f",
    "bytes": 4194,
    "original_title": "search/locate returns 500 instead of 400 for a non-numeric ?line",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied ticket text; the symptom, reproduction path, contrasting transcript behavior, correction direction, proof, and bounds are preserved.",
    "dropped": []
  }
}
```

# BUG-012 — Malformed search links returned an internal server error

## Diagnosis

The search location route called `intParam` for the `line` query parameter outside a local `try/catch`. A non-numeric value therefore reached the top-level handler as a plain error and became a 500 response. The transcript route already caught the same parsing error and returned 400.

## Evidence

Before the fix, `git stash push -- src/server/index.ts && npm run verify:search` produced `FAIL` for the malformed-line case. After correction, a matching 11/11 pass tally was recorded, although no adjacent suite name was attached to that tally. `verify:search` was named elsewhere without a recorded result. Type checking was reported clean.

## Implementation notes

Handle search location parameter parsing like the transcript route: catch the integer-validation error locally and return a 400 client response rather than allowing the top-level handler to produce 500.

## Verification plan

Request `/api/search/locate` with valid location inputs and `line=abc`; expect 400 rather than 500. Retain coverage for valid numeric line values and run type checking.

## Risks

Overbroad error handling could convert unrelated server faults into client errors. Keep the mapping limited to request-parameter validation.

## Activity log (APPEND-ONLY)

### 2026-08-03 — bug-hunt (read-only hunter)
- **Understood:** A search deep-link with a malformed line param yields an opaque 500 'expected an integer' instead of a 400 client error, unlike the transcript route which returns 400 for the same input.
- **Verified:** diagnosis traced against source (see Repro); NOT yet reproduced with a running test.
- **Handoff:** Wrap the locate param parsing in the same try/catch the transcript route uses (or validate + return 400) so a bad line yields a client error, not 500.

### 2026-08-04 — fix agent
- **Understood:** confirmed via source read — `intParam(url.searchParams.get('line'), 0, 1, Number.MAX_SAFE_INTEGER)` at index.ts:506 sat outside any try/catch in the `search/locate` route, so a non-numeric `?line` (e.g. `abc`) threw `expected an integer, got "abc"` and fell through to the top-level 500 handler at index.ts:1577-1580 — same failure mode the transcript route (index.ts:628-634) explicitly guards against by catching `expected an integer` and mapping it to a 400.
- **Changed:** `src/server/index.ts` — the `search/locate` route (~line 503) now parses `line` inside a `try { ... } catch (err) { sendJson(res, 400, { error: (err as Error).message }); return true; }` block, mirroring the transcript route's pattern, before the existing `!dir || !sessionId || !line` presence check and the existing 404 (`resolveSessionFile` miss) / 410 (`locate` miss — line beyond EOF) semantics, both left untouched.
  `scripts/verify-search.mjs` — added a `=== search: locate param validation (BUG-012) ===` block asserting: (1) `?line=abc` → 400 not 500, (2) missing `?line` → 400, (3) a valid `?line=1` still → 200.
- **Verified:**
  - Confirmed the new test FAILS on pre-fix code: `git stash push -- src/server/index.ts && npm run verify:search` → `FAIL  non-numeric ?line answers 400, not 500 — observed: HTTP 500: {"error":"expected an integer, got \"abc\""}` (10 passed, 1 failed), then `git stash pop` to restore the fix.
  - Post-fix full suite: `npm run verify:search` → **PASS** `non-numeric ?line answers 400, not 500` (HTTP 400), **PASS** `missing ?line answers 400` (HTTP 400), **PASS** `a valid ?line still works (no regression)` (HTTP 200). All 11/11 checks passed (0 failed), including the pre-existing classification, locate canonical-index, 410-on-EOF, and UI click-through checks — no regression.
  - `npm run typecheck` → clean, no errors.
  - Scratch server ran on an OS-assigned free port via the script's own `freePort()` helper (never touched 4317); browser/server subprocesses stopped by PID (`stopByPid`), never `pkill`.
- **Still open:** nothing — the 500→400 defect is fixed and covered by a regression test that fails on the old code and passes on the new. Not committed per instructions.
