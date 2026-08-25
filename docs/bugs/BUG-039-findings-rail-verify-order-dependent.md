```orchard-ticket
{
  "id": "BUG-039",
  "type": "bug",
  "title": "Findings checks no longer depend on run order",
  "summary": "The findings check now isolates its state and matches only the findings under test. Repeated checks covered repositories with and without existing architecture findings, while deliberate behavior breakage still caused failure.",
  "impact_if_we_wait": "The former behavior made test results depend on run order and legitimate system growth. Bounded: this affected verification reliability, not production behavior or user data.",
  "current_need": "Treat the ticket as closed: repeated checks covered both repository states, deliberate breakage still failed, and standing checks stayed clean.",
  "severity": "medium",
  "area": "Verification integrity",
  "reported": "2026-08-09",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-10",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Repeated checks produce complete results with and without existing architecture findings",
    "Assertions identify the findings under test instead of requiring global counts",
    "Deliberately breaking the targeted behavior causes the check to fail"
  ],
  "code_refs": [
    {
      "path": "docs/bugs/.arch/findings.json",
      "symbol": null,
      "note": "Real architecture findings state is snapshotted and restored around the check."
    }
  ],
  "related": [
    {
      "id": "BUG-040",
      "relation": "see_also"
    },
    {
      "id": "BUG-036",
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
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-039-findings-rail-verify-order-dependent.md",
    "sha256": "adce873057be69d96d655c4162f179aa51cf11f5a7b05a9a7b107e767114995c",
    "bytes": 8734,
    "original_title": "verify:feat-047-findings-rail is order-dependent (12/18 at HEAD; passes only on a virgin tree)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived ticket; its order dependence, exact-count cause, isolation fix, non-vacuous evidence, bounds, and systemic follow-up are preserved.",
    "dropped": []
  }
}
```

# BUG-039 — Findings checks no longer depend on run order

## Diagnosis

The check read the real architecture findings file and asserted exact global counts. Once another feature added legitimate findings, expected counts changed. Artifacts also survived between runs, making later results depend on earlier execution.

## Evidence

BUG-039 initially produced changing tallies on a pristine worktree. The completed record contains two consecutive 18/18 tallies with and without architecture findings present, although the extracted evidence does not attach those tallies to a named suite. Deliberately breaking the targeted behavior caused failure, and typecheck was reported clean.

## Implementation notes

Assertions now select findings by identifier instead of comparing global totals. The real architecture findings file is snapshotted and restored so existing repository state survives unchanged. The broader audit of sibling checks was separated into BUG-040.

## Verification plan

Run the targeted findings check twice with no architecture findings, then twice with findings already present. Confirm complete tallies in both conditions. Break the targeted behavior deliberately and confirm failure. Run typecheck.

## Migration and rollback

The change affects only test isolation and assertions. Reverting restores exact-count checks and dependence on the repository findings file.

## Risks

Identifier-scoped assertions could become vacuous if fixtures stop creating the intended findings. The deliberate-breakage check guards against that failure.

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
