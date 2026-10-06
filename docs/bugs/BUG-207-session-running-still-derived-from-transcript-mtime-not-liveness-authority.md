# BUG-207 — session "running" is still derived from transcript mtime, a second authority next to liveness.ts

- **Status:** OPEN
- **Severity:** medium
- **Area:** server / watcher / liveness
- **Reported:** 2026-09-29 by fixing lane (filed at orchestrator's request, following FEAT-154
  rounds 8–9 and the round-4 clean-room verify)
- **Verification-class:** plan+review ⟶ independent verification REQUIRED before VERIFIED

## Symptom

For an Orchard-run session (one Orchard itself drives — a bridge/CLI turn), "is it running"
is answered TWICE by two different mechanisms that can disagree: `src/server/liveness.ts`
(ARCH-001, the single declared liveness authority) and `src/server/watcher.ts`'s
`orchardLiveSessions()` / `isSessionLive`, which infers "running" from whether the session's
transcript file was written in the last 30 seconds — a raw filesystem mtime, gated only by
the round-9 `own-writes.ts` before/after ledger that tries to tell an Orchard-caused write
apart from a genuine engine append.

## Repro

See FEAT-154 Activity log, round-4 clean-room adversarial verify (dispatch
anthropic/claude-opus-5-5, run `c6633ec7-6f03-4d63-87cb-ac5a616e84b3`), confirmed against the
real `own-writes.ts` before/after + CAP logic:

1. **HIGH — a coincident engine write is masked.** The engine appends to the same transcript
   while `asOrchardWrite`/`asOrchardWriteAsync` is open (e.g. a rename/pin fires during that
   session's live CLI turn). `after()` stamps the combined (mtime, size) with the OLD engine
   time, so the next poll reads a genuinely running session as NOT live for up to the ~30s
   window.
2. **MEDIUM — an async Orchard-only write reads as running mid-flight.**
   `asOrchardWriteAsync` records its ledger entry only in `finally`, after the `await`. A
   liveness poll that lands during the SDK write sees the fresh mtime with no ledger stamp
   yet, so `lastEngineWriteMs` falls back to the raw mtime and reports live=true for a pure
   rename/pin, not a turn.
3. **MEDIUM — a write <30s before a server restart reads as running after it.** The ledger is
   in-memory only. A restart drops it, so an Orchard write made just before the restart has
   no stamp afterward and its raw (recent) mtime is read as evidence of a live turn.
4. **LOW — CAP (20,000-entry) eviction re-exposes an evicted file.** After a file's ledger
   stamp is evicted, a second Orchard write to it within 30s of the first is treated as an
   engine write (because there is no stamp to say otherwise) and the session reads live.

## Expected

**The violated invariant, as one testable sentence:** *A session reads `running` only when
its owner — the bridge/engine authority in `src/server/liveness.ts` for every session Orchard
itself runs — declares work in flight; transcript-file mtime is never evidence of "running"
for an Orchard-run session.*

## Why this is a design flaw, not four independent bugs

`watcher.ts` was built to infer liveness for sessions with NO Orchard-owned process to ask —
originally external/foreign transcripts appearing on disk. That inference (mtime-based) was
then applied uniformly, including to sessions Orchard itself drives, where
`src/server/liveness.ts` already has ground truth (`state`/`running`/`live`, ARCH-001) and
exists specifically so nothing re-derives that answer locally. `own-writes.ts`'s header
already names this precisely: *"if the engine appends to the SAME file between Orchard's
write and the stat that follows it... that one append is attributed to Orchard"* — an
admitted, load-bearing gap, not an oversight. Two authorities computing overlapping answers
from different evidence is the ARCH-001 class this module was written to end; watcher.ts's
mtime path for Orchard-run sessions is the one place it survived rounds 3–9 by moving, not
closing.

## Why the round-8 and round-9 local patches don't hold

- **Round 8** (`engineWrittenRoots()` excluding the `anthropic` mirror by provider name) was a
  per-directory exclusion list. It broke the moment a different Orchard writer (native-Codex
  import) landed in an ENGINE-named root instead of the mirror's own root — proven by round-3
  clean-room verify (run `f195fc23…`), HIGH, un-fixed for one engine.
- **Round 9** (`own-writes.ts`, a before/after (mtime, size) ledger, per-write) generalized the
  exclusion from "per directory" to "per write", closing the round-8 gap — but it still answers
  the question by comparing filesystem stats around an Orchard write, not by asking the
  liveness authority. That is why round-4 verify found four more ways for stat-comparison to
  diverge from truth: coincidence (write during a write), async ordering (stamp recorded after
  the await, not before), process lifetime (in-memory ledger, gone on restart), and capacity
  (bounded map, eviction reintroduces the very gap the ledger exists to close). Each is a
  different failure mode of the SAME root cause: deriving "running" from mtime arithmetic
  instead of from the one place that already knows.

## Options (trade-offs)

- **(a) Keep patching the ledger.** Price: pre-write stamping (record the engine mtime BEFORE
  the write, not after) closes the HIGH coincident case and probably the MEDIUM async case;
  persisting the ledger (or widening the restart grace window) addresses the restart case;
  removing or raising the CAP addresses eviction. This is 3 more targeted patches to the same
  file, on top of 2 already spent (rounds 8, 9) — and it does not remove the second-authority
  class itself; a 5th edge is not ruled out, only the 4 named ones.
- **(b) Orchard-run sessions take `running` only from the bridge/liveness authority; mtime is
  used only for sessions Orchard does not run (foreign/external transcripts with no bridge to
  ask).** This retires `own-writes.ts` for every session that has a bridge record, collapsing
  the two-authority read into the ARCH-001 shape the rest of the server already follows.
  Requires: `watcher.ts` to look up whether a session is Orchard-driven (provenance /
  `source:'agent-bridge'` or equivalent) before falling back to mtime; and an audit of which
  session shapes currently rely on the mtime path with NO bridge (may be narrower than it
  looks — most listed sessions likely have a provenance record). Risk: a session that should
  be bridge-tracked but has a missing/stale provenance record silently falls back to (correct,
  simpler) mtime, which needs to be a deliberate, tested fallback rather than an accident.
- **(c) other** — e.g. key liveness off the ENGINE's own store/recorder identity rather than a
  mtime the Orchard write also moves (round-4 verifier's suggestion): the wrapper records the
  pre-write engine mtime AND re-checks the exact byte range it itself wrote, so an interleaved
  engine append is never attributed to Orchard even if it lands inside the wrapper's window.
  This is a stronger version of (a) that specifically closes the HIGH case; still a
  stat-comparison design, so it inherits (a)'s risk profile, just with fewer open edges.

No option is recommended here; this is filed as plan+review for that choice.

## Migration path

1. Land the option's design behind the existing `verify:feat-154-open` / round-9 suite as a
   regression floor (24/24 must stay green).
2. Add the 4 round-4 findings as new adversarial cases to that suite (see Acceptance below) as
   MUST-FAIL-before / PASS-after, the same must-fail-proof shape rounds 3, 8 and 9 already used.
3. If (b): identify every session-listing code path that currently reads `orchardLiveSessions()`
   / `isSessionLive` and route Orchard-driven sessions through `liveness.ts` first, falling back
   to the mtime path only when no bridge/provenance record exists for that session id. Keep
   `own-writes.ts` (or retire it) only for the fallback path.
4. Re-run `verify-liveness-conformance` (the ARCH-001 mechanical guard) — a fix that makes
   watcher.ts call into `liveness.ts` should IMPROVE that suite's coverage, not merely stay
   at the pre-existing 86/88.
5. Independent clean-room adversarial verify, since this is the same session-lifecycle /
   liveness class that rounds 3 and 4 already broke twice.

## Proof bar

- A must-fail-before-fix run reproducing each of the 4 findings against the CURRENT
  `own-writes.ts`/`watcher.ts` (they already are must-fail per round-4's dispatch run
  `c6633ec7-6f03-4d63-87cb-ac5a616e84b3` — cite it, don't re-derive from scratch).
- All 4 becoming PASS after the fix, on the REAL transcript/session shapes used in rounds 8–9
  (6927511d Claude session, a real native-Codex rollout), not only a synthetic fixture.
- Full anti-regression: `verify:feat-154` 40/40, `-await` 5/5, `-working` 9/9, `-bg-shells`
  19/19, `-open` 24/24 (or its successor count), `verify-bug-193-list-fold` 31/31,
  `verify-bug-085-sidebar-cap` 11/11, `verify-feat-144-claude-mirror` 22/22,
  `verify-feat-078-native-codex` 36/36, `verify-liveness-conformance` (86/88 floor, improve if
  option (b) chosen).
- `npm run gate` exit 0.
- Independent clean-room adversarial verify: VERDICT HOLDS, with the verifier explicitly
  re-attacking these 4 cases plus the "5th check" round-4 flagged as possibly-fixture-timing
  (engine write immediately preceding the Orchard write inside the wrapper).

## Acceptance cases (the 4 round-4 findings)

- [ ] **HIGH** — engine write coincident with an open `asOrchardWrite`/`asOrchardWriteAsync`
  (rename/pin during a live CLI turn) still reads `running` on the next poll — not masked for
  up to 30s.
- [ ] **MEDIUM** — during an in-flight `asOrchardWriteAsync` (before its `finally` records),
  a liveness poll does NOT read the session as running from that write alone.
- [ ] **MEDIUM** — an Orchard write made <30s before a server restart does not read as
  `running` after the restart.
- [ ] **LOW** — a ledger entry evicted under CAP (20,000 entries) does not cause a second
  Orchard write to the same file, within 30s of the first, to read as an engine write.

## Context pack

- Files/functions in play: `src/server/own-writes.ts` (`asOrchardWrite`,
  `asOrchardWriteAsync`, `lastEngineWriteMs`, the CAP eviction), `src/server/watcher.ts`
  (`orchardLiveSessions`, `isSessionLive`, `liveSessions`, `sessionFileFacts`),
  `src/server/liveness.ts` (ARCH-001 authority — `state`/`running`/`live`),
  `scripts/verify-liveness-conformance.mjs` (the mechanical ARCH-001 guard),
  `scripts/verify-feat-154-open-not-running.mjs` (round 8–9's suite, 24/24).
- Related tickets: FEAT-154 (session-list state visuals; rounds 3, 5, 6, 8, 9 built and
  patched this path), ARCH-001-single-liveness-authority.md (the authority this class
  violates), BUG-193 (list fold, anti-regression suite touched by the same files).
- Repro test: none yet for these 4 findings specifically — add to
  `scripts/verify-feat-154-open-not-running.mjs` or a new
  `verify-bug-207-*.mjs` per the migration path above.
- Known dependencies / blockers: option choice (a/b/c) is a design fork, not a bugfix — hence
  plan+review, not fix.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — filing lane

- **Understood:** FEAT-154 rounds 8 and 9 each patched `watcher.ts`'s inference of "running"
  from transcript mtime — first with a per-directory exclusion (round 8, broken by round-3
  verify for native Codex), then with a per-write before/after ledger (round 9,
  `own-writes.ts`). The round-4 clean-room adversarial verify (dispatch
  anthropic/claude-opus-5-5, run `c6633ec7-6f03-4d63-87cb-ac5a616e84b3`) found the ledger
  itself has 4 more edges (HIGH/MEDIUM/MEDIUM/LOW) where mtime-plus-ledger diverges from
  truth. Filed as a standalone design-class ticket per the orchestrator's request, rather than
  round 10 on FEAT-154, because the FEAT-154 Activity log already names the fix as `NOT
  applied — verify lane` and recommends going back to design (keying off the engine's own
  store/recorder), which is a plan+review question, not another same-shaped patch.
- **Changed:** this ticket only; no code changed.
- **Verified:** n/a (filing only). The 4 acceptance cases cite the round-4 verify's own
  evidence (adversarial run `605e88e9b788`, exit 1, 5 broken) rather than re-deriving it.
- **Still open / handoff:** needs a design decision among (a)/(b)/(c) above before a fixing
  lane starts; then must-fail-before-fix proof, the fix, and an independent clean-room verify
  (session-lifecycle class, regression-prone file per FEAT-154 rounds 3 and 4).
- **Symptom of a deeper design flaw?** yes — this ticket IS that ARCH-level suspicion, filed
  because ARCH-001 (`src/server/liveness.ts`) already states the rule this class violates; no
  further ARCH ticket needed on top of this one.
