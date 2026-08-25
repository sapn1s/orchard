```orchard-ticket
{
  "id": "FEAT-079",
  "type": "feature",
  "title": "Standing findings crowded the rail meant for decisions",
  "summary": "The attention rail now carries only rows that ask something of a person. Read-only findings — repeated-patching clusters and working-agreement consolidation notes — sit in a separate Observations lane, still dismissable. A cluster that carries a concrete choice is promoted back into the asks lane. The rail's status summary counts asks and observations separately.",
  "impact_if_we_wait": "Without the split, a rail of unactionable notices trains people to stop reading it, so real decisions get missed. Bounded: this is attention and display only. No ticket data, dismissal state, or board record was ever at risk.",
  "current_need": "Nothing is outstanding for the behaviour. The pre-fix case failed as designed, the split and promotion path passed on fixture boards, and standing checks stayed clean. The change still needs a local commit.",
  "severity": "medium",
  "area": "Attention rail",
  "reported": "2026-08-14",
  "reported_by": "user",
  "owner": "you",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "An open ticket needing a person lands in the asks rail",
    "A raw recurrence cluster with no choice lands in Observations, not the asks rail",
    "A consolidation notice lands in Observations, not the asks rail",
    "A recurrence finding carrying a concrete choice is promoted to the asks rail",
    "Observations render read-only with no response field",
    "The rail status summary counts asks and observations separately",
    "Dismissing an architecture finding and acknowledging a consolidation notice still work"
  ],
  "code_refs": [
    {
      "path": "src/server/board.ts",
      "symbol": null,
      "note": "finding categorization — decides ask versus observation"
    },
    {
      "path": "src/server/index.ts",
      "symbol": null,
      "note": "rail assembly around lines 808-832; folded arch-recurrence (828-832) and consolidation (817-822) findings into needsYou"
    },
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "Needs-You rail UI and the new Observations lane render"
    }
  ],
  "related": [
    {
      "id": "FEAT-056",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-047",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-067",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-018",
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
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-079-needs-you-rail-decisions-only-observations-lane.md",
    "sha256": "0b28d5a1b61726624045d6aea78c12e2cfee3a0dfb7fd706542af543eec46fa5",
    "bytes": 7618,
    "original_title": "Needs-You rail should hold decisions only; read-only recurrence/consolidation findings move to an Observations lane",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head section by section: the diluted-rail problem, all four wanted items, the promotion rule, the fixture-based proof bar and the risk bucket are present.",
    "dropped": [
      "the parenthetical source-path list in the Area line, which code_refs now carries"
    ]
  }
}
```

# FEAT-079 — Standing findings crowded the rail meant for decisions

## Diagnosis

### How read-only rows reached the asks rail

The arch-recurrence watcher (FEAT-056 §N) and the WA-consolidation findings (FEAT-047) were appended straight into the `needsYou` list — `src/server/index.ts:828-832` for arch, `:817-822` for consolidation. The code's own comment describes them as "standing attention, not asks", which is precisely the category the rail is not for: per WA §H the rail holds "the one thing they must read: decisions, blockers, questions".

A raw recurrence count carries no choice. The governing principle is that a finding earns the asks rail only when it forces something — a deeper-flaw fix with a trade-off, or "this cluster implies a design flaw; file ARCH-### or pick an option?".

## Evidence

The user saw a row reading roughly: "Architecture review: subsystem patched repeatedly — recurring patches in <subsystem>: N tickets … adjacent cluster …" on the Needs-You rail. Informative, and nothing to answer.

The fixer's own recorded runs report pass tallies of 16/16, 20/20, 23/23 and 17/17, with typecheck and the leak-gate clean, and describe a clean-room pass over the split. The suites named around this work — the UI suite, the FEAT-047 findings rail suite, the arch-watch suite, a dedicated observations-lane suite and a rail-refresh suite — are named in the ticket without an adjacent result, so which tally belongs to which suite is not recorded here.

## Implementation notes

### The four pieces

1. Read-only arch-recurrence and consolidation findings leave `needsYou` for a distinct, lower-priority Observations lane — visible, clearly not a to-do.
2. `needsYou` keeps open person-owned tickets, raised decisions, and stall cards that ask a human to look.
3. Promotion: a recurrence cluster enters the asks rail only when it carries a concrete ask, attached to the row rather than surfaced as a bare count.
4. Dismiss and acknowledge paths are preserved for Observations, and the FEAT-067 rail status summary splits its counts into asks and observations.

## Verification plan

Build a board fixture holding an open person-owned ticket, a raw recurrence cluster with no decision, and a consolidation notice. Assert the first lands in the asks rail and the other two land in Observations. The pre-fix must-FAIL is that the latter two appear in the asks rail today.

Then a recurrence finding carrying a concrete ask, asserted into the asks rail, for the promotion path. Then a rail render: Observations read-only with no response field, asks rendering normally, and the status summary counts matching the split. Anti-regressions across the existing rail and board suites, the UI suite, typecheck and the leak-gate.

## Risks

Risk bucket: UI and attention-model, low-to-moderate; self-verification was judged sufficient at filing time.

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
