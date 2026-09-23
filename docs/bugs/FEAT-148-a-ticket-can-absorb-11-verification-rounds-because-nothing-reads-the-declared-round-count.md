# FEAT-148 — A ticket can absorb 11 verification rounds because nothing reads the declared round count

- **Status:** IN-PROGRESS — reader built and self-verified (14/14); independent clean-room pass warranted (read-only reporting tool, low/medium risk) before VERIFIED.
- **Severity:** medium (no product defect; a governance gap that let one ticket consume 11 rounds of effort with nothing escalating)
- **Area:** process instrumentation (`scripts/round-ceiling.mjs`, beside `arch-watch.mjs` / `cost-collect.mjs`)
- **Reported:** 2026-09-23 by the orchestrator
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom

ARCH-017 absorbed **11 verification rounds**, most returning DO-NOT-LAND, without
anything escalating. Working Agreement §N already states the stopping rule — two
consecutive rounds returning only wording/cosmetics means STOP, and a recurring
class of failure means the DESIGN is wrong, not the reviewer. The rule never
fired, because **nothing reads the round count.**

## Root cause

The round count is a DECLARED fact that no reader consumes — the exact ARCH-010
defect. FEAT-100 already requires every charter to declare
`Dispatch: … round=N …`, and `cost-collect.mjs` already parses that line into
`lane.declared.round` via the one canonical grammar
(`parseDispatchDeclaration`). The fact is written down by its owner (the
dispatcher, at dispatch) and then read by no one for the purpose of noticing a
runaway ticket. Measured on the real board, the max DECLARED round for ARCH-017
is **11**; the next-highest tickets are 5 (BUG-173, FEAT-139).

## Fix

A new reader, `scripts/round-ceiling.mjs` (`npm run arch:rounds`), in the shape
of `arch-watch.mjs`: it re-derives mechanically every pass, RAISES a §N-shaped
question, and never files, mutates, or blocks anything.

- Reads the DECLARED `round=` and `ticket=` fields ONLY, through the canonical
  grammar (via `cost-collect`'s read-only `collect()` / `readLedger()`), never a
  fresh regex and never by counting transcripts, files, or log entries. A
  ticket's round count is the MAX round any lane DECLARED for it.
- Raises at round **≥ 3** by default, escalating severity: 3-4 elevated, 5-7
  high, 8+ critical. Configurable via `--min-round=N` / `ROUND_CEILING_MIN_ROUND`
  — the same knob shape `arch-watch` uses (a `DEFAULTS` object + a flag + an env
  var), not a new settings system.
- Output names the ticket, the observed round count, and the §N question ("is
  this a design fault rather than a reviewer fault — should it become an ARCH
  decision?"). Exit 0/1/2 mirror `arch-watch`.

**Decisions taken (charter left them to the builder):**
- Its own script + npm entry (`arch:rounds`), NOT an extension of `arch:watch`.
  `arch-watch` is pure computation over ticket FILES; the round count lives in
  transcripts / the cost ledger, a different data source with a different owner.
  Folding transcript reading into `arch-watch` would couple two unrelated
  readers. A standalone reader that reuses `cost-collect`'s exports is the
  smaller, more conventional option.
- No dashboard surfacing. `arch-watch` persists to `.arch/findings.json` for the
  Needs-You rail; a second writer to that one file would clobber it. Rail
  integration would need a separate findings source + server read + ack dedup —
  deliberately out of scope to keep this small (CONVENTIONS: this project already
  has more checking machinery than product). CLI + `--json` is the whole surface.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play: `scripts/round-ceiling.mjs` (`roundCeiling`,
  `severityFor`), `scripts/lib/cost-model.mjs` (`parseDispatchDeclaration` — the
  one grammar), `scripts/cost-collect.mjs` (`collect`, `readLedger`),
  `scripts/arch-watch.mjs` (the shape this mirrors).
- Related tickets: FEAT-100 (the declared `Dispatch:` line), ARCH-010 (declared
  once, read everywhere — the principle), FEAT-056 (arch-watch, the shape),
  FEAT-086 (cost-collect), ARCH-017 (the ticket that motivated this, at round 11).
- Repro test: `npm run verify:round-ceiling` (14/14).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-23 — worker (Opus 4.8), dispatched FEAT-148 fixing round 1
- **Understood:** the round count is declared at dispatch (FEAT-100) and parsed
  by `cost-collect` but consumed by no reader; ARCH-017 reached a declared max of
  11 with nothing escalating (WA §N never fired). Confirmed the declared round is
  the right signal: `cost-collect --ticket=ARCH-017` shows per-lane
  `round=` declarations, and the max across ARCH-017's lanes is 11 (fixing phase).
- **Changed:** added `scripts/round-ceiling.mjs` (the reader),
  `scripts/verify-round-ceiling.mjs` (its suite), and `package.json` entries
  `arch:rounds` + `verify:round-ceiling`. No commit yet (git left to the user).
- **Verified (fixer's own — necessary, not sufficient):**
  - (i) REAL board: `node scripts/round-ceiling.mjs --json` raises **ARCH-017 at
    max declared round 11, severity critical, exit 1** (`raised[ARCH-017]
    = {maxRound:11, severity:"critical"}`).
  - (ii) Control: **BUG-163** (max declared round 1) is NOT in the raised set;
    invariant asserted that no raised ticket is below the ceiling.
  - (iii) Non-vacuity, declared-value-driven (through the REAL `collect()` +
    canonical grammar over a scratch transcript): the SAME charter raises at
    `round=5` and goes silent when the only edit is `round=1`; a charter with no
    `round=` and a `ticket=none round=9` charter both stay silent (success branch
    cannot fire on empty/missing input). Threshold non-vacuity: observed round 11
    raises at `--min-round=11` and is silent at `--min-round=12`.
  - `npm run verify:round-ceiling` → **14 passed, 0 failed**.
  - `npm run gate` → PASS (exit 0, read unpiped).
- **Could not test:** the durable-ledger path (`--ledger`) beyond it loading —
  the live transcripts still hold ARCH-017's rounds (≈15 days old, under the
  30-day prune), so the pruned-store fallback was exercised only by the loud-skip
  branch, not a real pruned store. The reader depends on `cost-collect` freshness
  when run with `--ledger`; the default live-transcript path is self-sufficient.
- **Still open / handoff:** independent clean-room verify pass (read-only tool,
  low/medium risk — flag raised per WA). Next: an orchestrator decision on whether
  `arch:rounds` should also join `arch:watch` in a scheduled/consolidation pass so
  it runs without someone remembering to (the CLI-only surface is the same
  "nobody runs it" risk this ticket describes, one level up).
- **Symptom of a deeper design flaw?** not closing yet. The class is ARCH-010
  itself (a declared fact read by no one); this is a targeted reader, not a new
  structural pattern, so no ARCH filed.
