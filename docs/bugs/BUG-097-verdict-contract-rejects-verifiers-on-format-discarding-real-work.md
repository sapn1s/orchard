```orchard-ticket
{
  "id": "BUG-097",
  "type": "bug",
  "title": "Verifier formatting errors discarded completed verification work",
  "summary": "Verifier answers with substantive recorded runs now survive harmless citation-format variations. Lenient parsing preserves strict requirements for fixer reruns, distinct adversarial runs, and disclosed test limits.",
  "impact_if_we_wait": "Formatting failures would keep wasting completed clean-room work and discourage use of the quality gate. Bounded: this affects verification-tool reliability and dispatch cost, not product data or runtime behavior.",
  "current_need": "Treat the change as closed: malformed citation cases passed while static-only and fixer-only answers remained rejected, and standing checks stayed clean.",
  "severity": "high",
  "area": "Independent verification tooling",
  "reported": "2026-08-14",
  "reported_by": "orchestrator",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-14",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-14",
      "question": "How should substantive verifier answers survive harmless citation-format errors?",
      "mode": "single",
      "options_keys": [
        "1",
        "2",
        "3"
      ],
      "chosen": "1",
      "chosen_on": "2026-08-14",
      "chosen_by": "agent",
      "note": "BUG-097 adopted lenient citation parsing while retaining strict evidence requirements."
    }
  ],
  "success_criteria": [
    "Previously rejected citation variations produce substantive verdicts while preserving their recorded runs",
    "Static-only answers without recorded runs remain invalid",
    "Answers citing only the fixer's test remain invalid",
    "Existing verification tooling checks and standing checks remain clean"
  ],
  "code_refs": [
    {
      "path": "scripts/lib/verdict-contract.mjs",
      "symbol": null,
      "note": "Parses citations and issues compliance re-prompts."
    },
    {
      "path": "scripts/independent-verify.mjs",
      "symbol": null,
      "note": "Runs the independent verification workflow."
    }
  ],
  "related": [
    {
      "id": "BUG-091",
      "relation": "see_also"
    },
    {
      "id": "BUG-102",
      "relation": "see_also"
    },
    {
      "id": "BUG-115",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "BUG-091"
  ],
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
    "archived_path": "docs/bugs/archive/BUG-097-verdict-contract-rejects-verifiers-on-format-discarding-real-work.md",
    "sha256": "1f75937422c21af5fcf954faa0c27bfeed6e34f4a9050ff348b26fb82cca4dbd",
    "bytes": 8781,
    "original_title": "the verdict contract rejects verifier answers on FORMAT, discarding real verification work (repeat INVALIDs)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived ticket text; the repeated failures, chosen parsing approach, strict evidence bar, executed checks, and clean-room requirement remain represented.",
    "dropped": []
  }
}
```

# BUG-097 — Verifier formatting errors discarded completed verification work

## Diagnosis

The contract treated exact citation line placement and ordering as evidence requirements. Verifiers could execute and record the required work, then lose the entire verdict because their answer used a different textual shape.

## Evidence

FEAT-076 produced repeated format-only rejections despite four recorded runs and the allowed corrective re-prompt. After the change, `verify:bug-097-lenient-parse` passed 16/16 and `verify:independent-verification` passed 138/138. Typecheck and leak-gate were also clean.

## Implementation notes

Citation run identifiers are extracted leniently from the answer and checked against the recorded manifest. The contract still requires a fixer rerun, a distinct adversarial run, and an explicit account of what could not be tested.

## Verification plan

Replay a previously rejected FEAT-076 answer and confirm the pre-fix rejection becomes a substantive verdict without changing its cited runs. Reject static-only and fixer-only answers. Run a separate clean-room pass to challenge any unintended weakening.

## Migration and rollback

No data migration is required. Revert the parser change if lenient extraction admits answers without the required recorded evidence.

## Risks

Overly permissive extraction could make static review appear independently tested. Adversarial cases must therefore exercise missing runs, fixer-only evidence, and ambiguous citations.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed after FEAT-076's clean-room verify returned INVALID twice on citation FORMAT (4 recorded runs,
  re-prompt used, still discarded). Companion to BUG-092 (openai recorder socket blocked). Together they
  mean ~half of independent-verify attempts yield no signal — a tax on the single most important quality
  gate in the workflow.

### 2026-08-14 — worker (parse leniently, judge strictly)
**Root cause CONFIRMED verbatim.** Recovered the two real FEAT-076 anthropic
clean-room answers (`~/.claude/projects/-tmp-cleanroom-verify-{lFIBfH,6zrLKK}`,
2026-08-14) and replayed them through the committed contract. Both produce EXACTLY
the ticket's two violations. The cause: the adversarial case tag
`provider-routing-layer-is-hardcoded-not-derived` (47 chars) overran
`CITE_ADV_RE`'s 40-char slug cap, so the whole `ADVERSARIAL:` line failed to
parse and its `WHY-UNCOVERED:` orphaned — discarding a verdict backed by a real
fixer re-run + two DISTINCT adversarial runs + a concrete UNTESTED. Pure syntax.

**Fix (option 1+2+3 combined — syntax lowered, substance untouched):**
`scripts/lib/verdict-contract.mjs::parseCitationReply` —
- run ids are pulled from ANYWHERE on a `FIXER-TEST:`/`ADVERSARIAL:` line
  (`CITE_ID_ANYWHERE_RE`), not by exact line shape;
- an off-shape case tag is NORMALISED to a valid short slug (`slugifyCaseTag`)
  instead of rejecting the line — the slug is a label, the cited run id is the
  evidence;
- stray/free prose is IGNORED (it can never become evidence — the harness
  composes the verdict from its own records and never echoes the reply), not
  fatal;
- every cosmetic fix-up is recorded in a new `normalized[]` return field,
  surfaced by the harness as `format-normalized`, never as a violation.
`scripts/independent-verify.mjs` — prints the `format-normalized` notes; the
compliance re-prompt now PRE-FILLS the run ids the harness already recorded so
compliance is copy-paste, and states the slug shape explicitly.

**The substance bar did NOT move.** A verdict is still INVALID unless it cites a
real recorded fixer-test run + ≥1 DISTINCT recorded adversarial run + a concrete
UNTESTED — all enforced downstream against the harness manifest
(`composeVerdict`/`validateVerdict`), which this change does not touch.

**Verification (must-FAIL both directions) — `scripts/verify-bug-097-lenient-parse.mjs`, 16/16:**
- REPLAY of the two REAL specimens (committed verbatim under
  `scripts/fixtures/bug-097/`): PRE-FIX the strict rule rejects the real
  `ADVERSARIAL` line (historical INVALID reproduced); POST-FIX the SAME text
  parses with zero violations, records a `case tag normalised` note, and composes
  a VALID BROKEN verdict citing the SAME run ids.
- Substance STILL bites: (a) static-only review (no runs) → INVALID; a
  well-shaped reply against an empty manifest composes nothing. (b) an
  "adversarial" that re-runs the fixer's own command → INVALID (blind-spot rule);
  no adversarial line at all → INVALID at parse. (c) a citation of a run id the
  harness never recorded → INVALID ("never recorded"). (d) an absurdly long slug
  normalises to a valid banner label that passes the composed verdict's own
  self-check (no INVALID-composition leak).
- END-TO-END (anthropic shim, in `verify-independent-verification.mjs`, 138/138):
  a reply that smuggles output-shaped lines between the labels is NO LONGER
  discarded — it composes a VALID BROKEN verdict with `format-normalized (1)`,
  and the smuggled narrative appears NOWHERE in the harness output (evidence wall
  intact). Existing suite updated for the intended behavior; the forge ratchet
  still rules INVALID.
- `npm run typecheck` exit 0; leak-gate PASS.

**Could NOT test:** did not run a fresh live FEAT-076 clean-room verify end-to-end
(would burn a dispatch and FEAT-076 is already resolved); the replay of the exact
prior-INVALID answers + the anthropic shim end-to-end cover the path. Independent
clean-room verify warranted (HIGH-STAKES: a wrong loosening lets unverified work
look verified — the tests above exist to prove it does not).
