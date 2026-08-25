# BUG-012 — search/locate returns 500 instead of 400 for a non-numeric ?line

- **Status:** VERIFIED
- **Severity:** medium
- **Area:** server-api / search route
- **Reported:** 2026-08-03 by bug-hunt workflow

## Symptom
A search deep-link with a malformed line param yields an opaque 500 'expected an integer' instead of a 400 client error, unlike the transcript route which returns 400 for the same input.

## Repro
GET /api/search/locate?dir=X&sessionId=Y&line=abc. The route (index.ts:503-521) calls intParam(get('line'),0,1,MAX) at :506 OUTSIDE any try/catch. intParam throws 'expected an integer, got "abc"' (validate.ts:263), propagating to the top-level handler (index.ts:1577-1580) which returns 500 (not an HttpError). The transcript route deliberately catches the same error and maps it to 400 (index.ts:630-632); locate does not.

## Expected
Honest, correct behavior — see fix direction.

## Context pack
- Suspect file(s): src/server/index.ts:506 (intParam call outside try/catch)
- Fix direction: Wrap the locate param parsing in the same try/catch the transcript route uses (or validate + return 400) so a bad line yields a client error, not 500.
- Touches: SERVER — check file overlap before parallel dispatch
- Related: none
- Repro test: none yet — the fixing agent MUST add a verify script that FAILS on current code and passes after.

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
