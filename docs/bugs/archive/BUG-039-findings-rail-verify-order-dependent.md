# BUG-039 — verify:feat-047-findings-rail is order-dependent (12/18 at HEAD; passes only on a virgin tree)

- **Status:** VERIFIED — suite made hermetic (2026-08-09): id-scoped assertions replace exact counts + snapshot/restore of the real arch-findings file; 18/18 twice in a row with and without arch findings present; non-vacuous. Systemic half filed as BUG-040.
- **Area:** verification integrity (same family as BUG-036 — a harness that can mislead)
- **Reported:** 2026-08-09 (found by FEAT-058's agent, proven at HEAD in a pristine worktree)

## Symptom (proven, not suspected)
`verify:feat-047-findings-rail` scores 12/18 — and ALSO 12/18 at HEAD with none of FEAT-058's
files present. Run twice in a pristine HEAD worktree it gave 15/18 then 12/18: the result depends
on prior runs, i.e. on leftover state.

## Cause (stated by the finder; confirm before fixing)
Once `docs/bugs/.arch/findings.json` exists (created by FEAT-056's arch-recurrence pass), the
methodology-home rail carries BOTH the WA-consolidation findings AND the new arch findings.
FEAT-047's assertions were written before FEAT-056 existed and count an exact number of findings
(expect 2, now see 7). So a legitimate new feature silently turned a green suite red — and the
suite's own state leaks between runs.

## Why it matters (§C)
Two failure modes at once: (a) a suite whose result depends on run order can't be trusted either
way; (b) an exact-count assertion breaks whenever the system legitimately grows — it tests the
world, not the behaviour. Combined with BUG-036 (verify:ui crashing at HEAD), the verification
layer itself needs attention: green must mean green.

## Fix direction
- Make the suite hermetic: its own scratch METHODOLOGY_DIR / findings path, cleaned before and
  after; no dependence on repo state or on a previous run's artifacts.
- Replace exact-count assertions with assertions about the SPECIFIC findings under test (by id or
  type), so unrelated finding sources can coexist.
- While there: audit sibling suites for the same two smells (state leakage, exact counts).

## Verification
The suite passes twice in a row on a pristine tree AND on a tree that already has arch findings;
deliberately breaking the FEAT-047 behaviour still fails it (non-vacuous). typecheck.

## Activity log (APPEND-ONLY)
### 2026-08-09 — orchestrator
- Filed from FEAT-058's report; the finder proved it at HEAD in a clean worktree before blaming
  its own work — exactly the right instinct, recorded here so the next agent doesn't re-derive it.

### 2026-08-10 — agent (fix)
**Confirmed the stated cause exactly, plus a second, related leak the ticket didn't name:**

1. FEAT-047's WA-consolidation findings surface ONLY on the methodology-home project, which
   `src/server/index.ts` hardcodes as `path.resolve(p.hostPath) === projectRoot()` — literally
   THIS checkout, not configurable via `METHODOLOGY_DIR` — so the suite must register `ROOT` as
   that project. Separately, FEAT-056's `board.archRecurrenceFindings(hostPath)` reads
   `docs/bugs/.arch/findings.json` PER-PROJECT, keyed by `hostPath`. Since `ROOT` is both, the
   suite's board queries return WA findings (its own 2 planted) UNIONED with whatever real
   arch-recurrence findings already exist for this repo (5, at HEAD, from FEAT-056/ARCH-001 work)
   — reproduced exactly: 12/18 with the file present, matching the ticket's own numbers.
2. NOT PREVIOUSLY NAMED: every SERVER BOOT (`src/server/index.ts`, ~line 2755, spawns
   `wa-consolidate.mjs --apply` with no `--board-dir`/`--no-arch`) runs the arch-watch pass
   against `REPO_ROOT = path.resolve(HERE, '..')` inside `wa-consolidate.mjs` — the SCRIPT's own
   on-disk location, not `cwd` and not any env var. So simply booting the server (which this
   suite's item 1 requires, to prove the boot pass persists findings) mutates the REAL repo's
   `docs/bugs/.arch/findings.json` as a side effect, every run, regardless of `METHODOLOGY_DIR`.

**Fix, `scripts/verify-feat-047-findings-rail.mjs` only:**
- Every assertion that counted ALL `kind:'finding'` rows now scopes to the two ids THIS suite
  planted (`routingId`/`contraId`) instead — 6 call sites: the board-scoping check, the rail
  render wait + row checks, the post-dismiss/reload wait, the "survives the re-run" check, and
  the clean-pass board + rail checks. Unrelated finding sources (0 or 5 or however many
  arch-recurrence findings exist) can now freely coexist without flipping any of them.
- Snapshotted `docs/bugs/.arch/findings.json` + `acks.json` before the server ever boots;
  restored byte-for-byte in the teardown. The suite still can't PREVENT the mid-run mutation
  (that requires a server-side change — see below, out of this ticket's file scope), but it now
  leaves the repo's own derived state exactly as it found it, every time.

**Verification:**
- 18/18, twice in a row, on a tree WITH the real 5 arch-recurrence findings present
  (`docs/bugs/.arch/findings.json` md5 identical before and after both runs).
- 18/18 on a pristine tree with that file entirely ABSENT (temporarily moved it aside) — restored
  correctly to non-existence afterward (not to an empty file).
- Non-vacuous: temporarily made `board.consolidationFindings()` (`src/server/board.ts`) always
  return `[]` → suite failed loudly (multiple FAILs, then a FATAL on a null selector); reverted
  (`git diff src/server/board.ts` empty after).
- `npm run typecheck` clean.

**Sibling-suite audit (all ~84 `scripts/verify-*.{mjs,ts}`), state leakage + exact-count smells:**
- FEAT-047's suite was the ONLY one whose assertions were actually vulnerable: it's the only
  suite that both registers `ROOT` as a project AND reads `needsYou`/`board` from it. Other
  suites registering `ROOT` (`verify-processes.mjs`, `verify-template-readthrough.mjs`,
  `verify-routing.mjs`, `verify-ui.ts`) never touch `needsYou`/board — unaffected. Suites with
  exact-count `needsYou` assertions (`verify-needs-you-rail.mjs`, `verify-rail-refresh.mjs`)
  register only fully-scratch project directories, so no arch-findings file exists for them
  either way — safe as written.
- FOUND, NOT FIXED (reporting per the ticket's ask — deferred, not cheap enough for this pass):
  `scripts/verify-arch-watch.mjs` section 5 ("REAL server: the finding surfaces…") boots
  `src/server/index.ts` the same way this suite does, and via the identical boot-time
  `wa-consolidate.mjs --apply` path, ALSO mutates this repo's real
  `docs/bugs/.arch/findings.json`. Its own assertions happen to be scoped to scratch project dirs
  (`PROJ`/`OTHER` under a tmpdir) so this doesn't break ITS results — but it silently perturbs
  real repo state on every run. The same snapshot/restore pattern applies; deferred because
  wiring it into that file's several existing exit paths (normal completion, the `main().catch`,
  and the SIGINT/SIGTERM handlers, none of which currently share a single teardown funnel) is a
  more involved change than the two files in this ticket's scope, and I did not want to touch a
  script outside SCOPE without giving it the same testing rigor as the two in-scope fixes got.
- ROOT CAUSE, broader, NOT FIXED (clearly out of SCOPE — `src/server/index.ts` and
  `scripts/wa-consolidate.mjs` are not listed files): ANY verify suite that boots a real
  `src/server/index.ts` without `CLAUDE_STATION_NO_WA_CONSOLIDATE=1` triggers this same mutation,
  because of the `REPO_ROOT`-not-cwd resolution described above. `wa-consolidate.mjs` already has
  the exact escape hatches needed (`--no-arch`, `--board-dir`) — the boot-time spawn just never
  passes them and has no env-var equivalent to opt in per-process. Worth its own cheap ticket:
  give the boot spawn (or `wa-consolidate.mjs` itself) an env-gated `--board-dir`/`--no-arch`, so
  any verify suite that sets `METHODOLOGY_DIR` to scratch can also redirect/skip the arch pass
  without a CLI flag it has no way to inject into a spawn it doesn't control.

**Closing assessment:** Both required halves are done — the suite is now hermetic (own-scoped
findings-file snapshot/restore) and non-vacuous exact-count assertions were replaced with
id-scoped ones per the ticket's fix direction. Verified green twice in a row on both a pristine
tree and one with real arch findings present, non-vacuous in both the FEAT-047-behavior-break and
zero-findings directions, and leaves the repo's own derived state untouched. The sibling audit is
complete; one adjacent leak (verify-arch-watch.mjs) and one systemic root cause (server boot
always touches the real repo's arch findings) are named and left for a follow-up ticket, both
explicitly out of this ticket's file scope. Ready to close.
