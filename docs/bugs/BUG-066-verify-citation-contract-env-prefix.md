```orchard-ticket
{
  "id": "BUG-066",
  "type": "bug",
  "title": "Correct verification runs were rejected as stand-ins",
  "summary": "Verification commands now compare by canonical identity, so environment prefixes no longer reject correct citations or disguise fixer reruns. The pre-fix cases failed as expected, corrected cases passed, adjacent checks stayed clean, and live closing runs exercised the original command shape.",
  "impact_if_we_wait": "Correct clean-room runs could be discarded, wasting time and blocking ticket closure. Disguised fixer reruns could also appear novel. Bounded: this affected verification-harness correctness and compute time, not product behavior, stored data, or user data.",
  "current_need": "Treat the ticket as closed: the pre-fix cases failed, corrected behavior passed, and standing checks stayed clean.",
  "severity": "medium",
  "area": "Independent verification harness",
  "reported": "2026-08-11",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-11",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Equivalent commands with explicit or implicit environment prefixes match in both directions",
    "Different programs and different assignment values remain distinct",
    "A prefixed fixer rerun cannot qualify as a novel adversarial case",
    "The original prefixed command shape completes without the false citation violation"
  ],
  "code_refs": [
    {
      "path": "scripts/lib/verdict-contract.mjs",
      "symbol": "canonCmd",
      "note": "Canonicalizes leading env tokens and sorted NAME=value assignments while preserving assignment identity."
    },
    {
      "path": "scripts/lib/verdict-contract.mjs",
      "symbol": "sameCmd",
      "note": "Applies canonical identity across all five command comparisons."
    },
    {
      "path": "scripts/verify-independent-verification.mjs",
      "symbol": null,
      "note": "Adds five BUG-066 checks covering both matching directions and forgery-hole negatives."
    }
  ],
  "related": [
    {
      "id": "FEAT-061",
      "relation": "see_also"
    },
    {
      "id": "FEAT-062",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "trivial",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": false
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-066-verify-citation-contract-env-prefix.md",
    "sha256": "e8e561a696c9eb5af87098ba352dd94e719e42375a271517042d0f4cdadd43f2",
    "bytes": 8389,
    "original_title": "independent-verify citation contract rejects the CORRECT run when the harness-supplied command carries an env-var prefix",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived original; the symptom, workaround, canonicalization, five comparison sites, must-fail evidence, negative cases, live exercise, dates, and run identifiers survive.",
    "dropped": []
  }
}
```

# BUG-066 — Correct verification runs were rejected as stand-ins

## Diagnosis

The citation contract compared raw recorded commands with the harness-supplied command. A leading assignment such as `FOO=1 node t.mjs` was recorded as `env FOO=1 node t.mjs`, causing a false rejection. The reverse spelling also let a fixer rerun appear novel.

## Evidence

The defect was reproduced first-hand on 2026-08-11. Run `a5afb7ed-b34e-456f-b94d-072789203b06` rejected the correctly executed command after the recorder added `env`. Run `5a26e968-d184-492d-b8e6-b492c13d7a59` showed the same pattern. Run `28ace6d5-6241-4591-b741-2a9a922cbb32` confirmed the exported-variable workaround removed that violation, although it remained invalid for an unrelated citation error.

On 2026-08-12, three new positive cases failed before the fix, including the false rejection and reverse-direction bypass. After canonicalization, all five added cases passed. `verify:independent-verification` passed 132/132, `verify:feat-062-loop` passed 31/31, and `verify:dispatch` passed 24/24. Type checking and the leak gate were clean. Three FEAT-062 clean-room closing runs then exercised the original prefixed command shape; none produced the environment-prefix violation, and one reached a contract-valid verdict on its merits.

## Implementation notes

Both command spellings now pass through `canonCmd()` and `sameCmd()`. Leading `env` tokens are removed, leading assignments are collected and sorted, and assignment names and values remain part of identity. All five comparison sites use the same predicate. Commands using `env` option flags such as `env -i` or `env -u X` remain unchanged conservatively.

## Verification plan

Retain the must-fail cases for supplied assignments versus recorded `env` commands and the symmetric form. Retain negatives for a different program, a different assignment value, and a prefixed fixer rerun presented as novel. Run the independent-verification, FEAT-062 loop, and dispatch suites with type checking and the leak gate.

## Migration and rollback

No data migration is involved. Reverting the canonical comparison restores raw string matching and would reopen both the false rejection and the disguised-rerun bypass.

## Risks

Over-normalization could equate genuinely different commands. Preserving assignment values and declining to reinterpret `env` options bounds that risk.
