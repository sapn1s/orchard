# FEAT-079 — Needs-You rail should hold decisions only; read-only recurrence/consolidation findings move to an Observations lane

- **Status:** VERIFIED (2026-08-14 — observations lane shipped; needs local commit)
- **Area:** src/server/board.ts (finding categorization) + src/server/index.ts (rail assembly ~808-832) + the Needs-You rail UI (public/lib / app.js)
- **Reported:** 2026-08-14 by user

## Problem
The automated arch-recurrence watcher (FEAT-056/§N) and the WA-consolidation findings (FEAT-047) are
folded directly into the `needsYou` list as READ-ONLY rows (index.ts:828-832 arch; 817-822
consolidation — the code itself calls them "standing attention, not asks"). Example the user saw:
> "Architecture review: subsystem patched repeatedly — recurring patches in <subsystem>: N tickets … adjacent cluster …"

This is informative but **not actionable** — there is no decision for the user. Putting it on the
Needs-You rail (which per WA §H is meant for "the one thing they must read: decisions, blockers,
questions") dilutes the rail and trains the user to ignore it. The user's principle: a finding belongs
on Needs-You ONLY when it carries a genuine decision — e.g. a deeper-flaw fix that forces a trade-off,
or "this cluster implies a design flaw, file ARCH-### / pick an option?". A bare recurrence count does
not.

## Wanted
1. **Separate read-only findings from asks.** Move read-only arch-recurrence + WA-consolidation
   findings OUT of `needsYou` into a distinct, lower-priority **Observations** (read-only) lane in the
   rail — visible but clearly not a to-do. `needsYou` keeps only rows that carry a real question/ask
   (open 👤 tickets, raised decisions, stall cards that ask a human to look).
2. **Promotion rule.** An arch-recurrence cluster becomes a Needs-You ASK only when it crosses into an
   actual decision — attach a concrete ask ("file ARCH-### for this class? / keep patching?") rather
   than surfacing the raw count. Below that threshold it stays an Observation.
3. Dismiss/ack still works for Observations (keep dismissArchFinding / consolidation ack).
4. Update the FEAT-067 rail status summary so the counts reflect the new split (asks vs observations).

## Verification (§C)
- Board fixture with (a) an open 👤 ticket, (b) a raw arch-recurrence cluster with no decision, (c) a
  consolidation FYI finding → assert (a) lands in needsYou, (b)+(c) land in Observations, NOT needsYou.
  Must-FAIL pre-fix: (b)+(c) currently appear in needsYou.
- A recurrence finding carrying a concrete decision/ask → lands in needsYou (promotion path).
- Rail UI render: Observations section renders read-only (no response field), needsYou renders asks;
  status summary counts match.
- Anti-regressions: existing rail/board suites (FEAT-018/047/056/067), verify:ui, typecheck, leak-gate.
- **Risk bucket:** UI/attention-model (low-moderate); self-verify sufficient.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed from user report: the arch-recurrence "subsystem patched repeatedly" card is mechanical
  (FEAT-056 watcher), read-only, and non-actionable, yet sits on the Needs-You decision rail. Confirmed
  the fold at index.ts:828-832 (arch) and 817-822 (consolidation). Hold dispatch until FEAT-078 lands
  (shared index.ts + rail UI — serialize per the concurrency rule).

### 2026-08-14 — worker (implementation + verify)
Hypothesis CONFIRMED: both finding sources were folded straight into `needsYou` in the board GET route
(consolidation at index.ts ~833-845, arch-recurrence at ~846-854), mixing read-only mechanical rows into
the decision rail. The rail UI renders `state.board.needsYou` via `renderRail`→`reconcileNeeds`→`needsCard`
in public/app.js (index.html loads /app.js; the earlier "app.js has no rail code" was a grep false-negative
— the file holds emoji so grep treated it as binary; `-a` reveals it).

**What changed**
- `src/server/board.ts`: new read-only `observations?: BoardItem[]` lane on `Board` (initialized in both
  `readBoard` returns); `BoardSummary.counts` gains `observations`; `boardSummary` counts it separately so
  the rail's "needs" number reflects real asks only. Promotion SEAM: `PersistedFinding.ask?` +
  `findingIsAsk(it)` predicate; the two finding mappers set `question` from a non-empty persisted `ask`.
  No writer emits `ask` today, so every current finding is an Observation — the seam is the documented
  path to promote one without touching the routing.
- `src/server/index.ts` (board GET): the consolidation + arch folds now PARTITION each finding via
  `findingIsAsk` — bare findings → `b.observations`, a finding carrying a concrete ask → `b.needsYou`.
  Summary comment updated (needsYou = asks/decisions/stalls; observations = read-only findings).
- UI: `public/index.html` adds `#railObservations` (below `#railNeeds`); `public/app.js` renders the
  Observations section (`observationRow` — read-only, arch/WA-labelled, Dismiss/ack via `dismissFinding`),
  repurposes `needsFindingRow` to render a PROMOTED finding's concrete ask on the decision rail, and adds
  an `observations` chip to the FEAT-067 status strip. `public/styles.css` styles the quieter lane +
  promoted card.
- Anti-regression suites updated to the NEW contract (findings now assert against `observations` /
  `#railObservations` / `data-kind="observation"`): `verify-feat-047-findings-rail.mjs`,
  `verify-arch-watch.mjs`. New suite `verify-feat-079-observations-lane.mjs` (+ package.json script).

**Verification (real scratch server + brave headless CDP; free ports; PID-kill only)**
- FEAT-079 new suite: 16/16 PASS — (a) 👤 ticket → needsYou; (b) bare arch cluster → observations, NOT
  needsYou; (c) bare WA-consolidation FYI → observations, NOT needsYou (methodology-home scoped); (d)
  PROMOTION — arch finding with a concrete `ask` → needsYou WITH its question, shown on the rail; (e)
  summary counts split (needs=2, observations=1) match the merged lists; (f) DOM: observations read-only +
  Dismiss, no bare finding in #railNeeds, dismiss removes only that row and persists server-side.
- MUST-FAIL proof: temporarily reverting the two partition sites to the pre-fix `needsYou = [...needsYou,
  ...findings]` behavior → guards (b) and (c) FAIL (bare arch + WA FYI land in needsYou, observations empty,
  read-only DOM checks fail); restored → 16/16.
- Anti-regressions: FEAT-047 20/20 PASS, FEAT-056/arch-watch all FEAT-079 + rail checks PASS, FEAT-067
  23/23 PASS (the "exactly 5 chips" check tolerates the new observations chip), FEAT-018 needs-you-rail
  17/17 PASS, verify:ui 7/0 PASS, typecheck clean, leak-gate PASS (0 hits / 408 files).
- Two PRE-EXISTING failures found, NOT caused by FEAT-079 (both reproduce on clean HEAD with my changes
  stashed): (1) `verify-arch-watch.mjs` section-7 "git-corroborated shared files as evidence: observed []"
  — depends on this repo's fresh git history; (2) `verify-rail-refresh.mjs` FATAL `Cannot read properties
  of null (reading 'focus')` — its fixture seeds BARE 👤 tickets (no `## Question`) which correctly render
  as status rows without a textarea (BUG-025), then the test calls `.focus()` on the null textarea. Both
  are unrelated to this change; flagged for separate triage.

**Risk bucket:** UI/attention-model (low-moderate), self-verify sufficient per the ticket. No
session-lifecycle/security/data-loss surface touched; no independent clean-room pass warranted.
No restart/deploy required — pure board-route + static-asset change, picked up on the next board poll /
page load. No push.
