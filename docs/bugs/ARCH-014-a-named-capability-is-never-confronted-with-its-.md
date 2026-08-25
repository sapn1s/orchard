```orchard-ticket
{
  "id": "ARCH-014",
  "type": "architecture",
  "title": "a named capability is never confronted with its runtime",
  "summary": "Designs and policies here name tools, fields and command heads as though naming them settles what they do, and nothing checks a name against the harness that must provide it. Three times a named capability has not been the capability: a tool that does not exist, a field that cannot enforce, an allowed command head that is a shell.",
  "impact_if_we_wait": "Each instance shipped something that looked like a capability and was not, and each was caught by accident rather than by a check. The pipeline that let them through is unchanged, so a fourth is no less likely — and may not be caught before someone relies on it.",
  "current_need": "A decision on which of the four options to take, or to accept D deliberately. Nothing is broken right now; this exists so the fourth instance is recognised as a recurrence instead of a novelty.",
  "severity": "medium",
  "area": "design → runtime contract",
  "reported": "2026-08-25",
  "reported_by": "orchestrator-profile-fleet lane (FEAT-096 phase 3)",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A name this harness has never emitted cannot pass review as an allowed or denied tool.",
    "A field claimed to restrict a capability has a probe proving it does, run against the real SDK.",
    "An allowed command head carries an explicit statement of what it can be talked into doing, with a probe per claim.",
    "A fourth instance, if it happens, is caught by a check rather than by luck."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [
    "FEAT-096",
    "BUG-118",
    "ARCH-008"
  ],
  "verification": [],
  "verification_class": "arch",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# ARCH-014 — a named capability is never confronted with its runtime

## The invariant that keeps being violated

**A named capability is never confronted with the runtime that must provide it.** Designs, tickets
and policies in this repo name tools, fields and commands as though naming them settles what they
do. Nothing in the pipeline checks the name against the harness — not review, not typecheck, not
any verifier — so the gap is always found by running the thing, usually much later, usually by
luck.

## The three instances

1. **A tool that does not exist.** Two orchestrator redesigns specified the surface as
   `Dispatch`, `SendMessage`, `TaskStop`. There is no tool called `Dispatch`; the harness emits
   `Agent`. A profile built from the document would have allowed a name nothing ever calls and
   denied the one that matters — and would have scored 100% blocked, with no bug to point at.
   (FEAT-096, 2026-08-20 entry.)
2. **A field that cannot enforce.** FEAT-096's own context pack named `registry.ts`
   `allowedTools[]` as the enforcement path. The SDK is explicit that it is an AUTO-APPROVE list —
   under `bypassPermissions`, which is what lanes run under, it is a total no-op. Writing the
   profile there would have shipped something that looked enforced and was not. Its sibling
   `disallowedTools` turned out worse than useless: it leaks onto subagents, stripping a dispatched
   lane of the tool it was dispatched to use. (FEAT-096, 2026-08-25 entry.)
3. **A name admitted to a surface without asking what the name can DO.** The enforcement allow
   list was derived honestly from measured behaviour — `node`, `npm`, `npx`, `docker`, `systemctl`,
   `curl` are what the orchestrator really runs. But the derivation stopped at the head. `node -e`
   is `cat`; `npx` is a shell; `docker run` is a shell; `systemctl cat` prints a file;
   `curl file://` is a read. A real session, told nothing about evading anything, was refused `ls`
   and read the tree with `node -e` on its next turn. (FEAT-096, 2026-08-25 phase-3 entry.)

The shape is identical each time: **the design layer traffics in names, the runtime traffics in
behaviour, and no one makes them meet.** Instance 3 is the most instructive, because the list was
built from real measured data and was still wrong — measuring WHAT IS CALLED does not tell you
WHAT IT CAN DO.

## Why this is architectural rather than three mistakes

Each instance was caught by a different accident: instance 1 by capturing a live payload while
building, instance 2 by running a probe on a hunch, instance 3 by a model routing around a
restriction in a verification run nobody expected to fail. None was caught by a check. A fourth
instance is therefore not less likely than the first three — the pipeline that let them through is
unchanged.

## Options (not decided here)

- **A — a name-to-runtime assertion, per surface.** Any list of tool names in this repo is asserted
  against what the harness has actually emitted (the transcript store and the FEAT-096 recorder log
  both already carry that ground truth). A name nobody has ever seen the runtime emit is a FAIL,
  not a passing test. Cheap; catches instance 1; catches nothing else.
- **B — capability probes for enforcement fields.** A field claimed to restrict something must have
  a test that proves it restricts it, run against the real SDK. Catches instance 2. Costs a real
  session per field.
- **C — for anything allowed by NAME, enumerate what the name grants.** The rule that would have
  caught instance 3: an allowed command head must be accompanied by an explicit statement of what
  it can be talked into doing, and a probe for each. Most expensive, and the only one that
  generalises.
- **D — accept it and keep catching them late.** Defensible if the cost stays what it has been:
  three incidents, all caught before a user was harmed. It is recorded here so the fourth is not
  discovered as a novelty.

## Context pack
- Files in play: `scripts/lib/orchestrator-profile.mjs` (`ENFORCE_ALLOWED_TOOLS`,
  `ENFORCE_ALLOWED_BASH`, `ENFORCE_HEAD_ARG_RULES`), `src/server/registry.ts`,
  `src/server/runtime/claude-runtime.ts`
- Evidence: FEAT-096 activity log — 2026-08-20, 2026-08-25, and 2026-08-25 phase-3 entries
- Probes that exist today: `npm run verify:feat-096-read-escapes` (instance 3),
  `npm run verify:orchestrator-enforcement` (the measured corpus)
- Related: FEAT-096 · BUG-118 · ARCH-008 (one grammar, implemented twice)

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — orchestrator-profile-fleet lane (FEAT-096 phase 3)
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-25 — orchestrator-profile-fleet lane (FEAT-096 phase 3)
- **Record correction:** Correcting my own record field before anyone inherits it: `recurrence_evidence` takes ticket ids, and I listed FEAT-096, BUG-118 and ARCH-008. Only FEAT-096 is evidence of THIS pattern — all three instances are recorded in its activity log (2026-08-20, 2026-08-25, and the 2026-08-25 phase-3 entry). BUG-118 and ARCH-008 are neighbouring context, not recurrences of a named capability failing to meet its runtime. The tool does not expose that field for update, so the correction lives here rather than in a silent edit.
