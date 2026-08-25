```orchard-ticket
{
  "id": "BUG-042",
  "type": "bug",
  "title": "Universal rules were silently removed from shared instructions",
  "summary": "Shared instructions now retain universal rules that mention products only as examples. Illustrative markers are excluded, uncertain relocations require human review, and the live relocation loop was reverted and hardened.",
  "impact_if_we_wait": "Universal guidance could silently disappear from every future session's shared instructions. Bounded: this affects instruction correctness, not stored project data, and the misplaced rule remains recoverable through version history.",
  "current_need": "Treat the ticket as closed: the pre-fix case failed, corrected behavior passed, and standing checks stayed clean.",
  "severity": "high",
  "area": "Working Agreement consolidation",
  "reported": "2026-08-10",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-11",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-10",
      "question": "Should uncertain rule relocations apply automatically or require human review?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "B",
      "chosen_on": "2026-08-11",
      "chosen_by": "agent",
      "note": "B required human review for uncertain relocations. Illustrative markers were excluded, and the live relocation loop was reverted and hardened."
    }
  ],
  "success_criteria": [
    "A universal rule citing a product example remains in shared instructions",
    "A genuinely project-specific block is identified without moving the universal rule",
    "The separate-process rule survives consolidation verbatim",
    "Relocations require human review unless their classification is unambiguous",
    "The changelog explicitly names every relocated rule"
  ],
  "code_refs": [
    {
      "path": "docs/CONVENTIONS.md",
      "symbol": null,
      "note": "BUG-042 moved a universal rule here after treating a product example as project-specific."
    }
  ],
  "related": [
    {
      "id": "FEAT-019",
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
    "archived_path": "docs/bugs/archive/BUG-042-consolidation-relocates-universal-rules.md",
    "sha256": "dab073ba4b5c5b0f30fe4511de61cfcac2f7b2c91ae0bdef2ef6f310410f291d",
    "bytes": 8137,
    "original_title": "auto-consolidation deleted a UNIVERSAL rule from the WA because it mentioned a product name",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared line by line with the archived ticket; the symptom, scope error, chosen safeguards, rollback, proof tallies, and verification requirements remain represented.",
    "dropped": []
  }
}
```

# BUG-042 — Universal rules were silently removed from shared instructions

## Diagnosis

The relocation heuristic treated any block mentioning a project token as project-specific. It did not distinguish a universal normative rule from a concrete product example. Because relocation auto-applied, a judgment call silently removed guidance from the instructions received by every project session.

## Evidence

The real specimen, "separate process, not a subagent," was moved from the universal Working Agreement into one project's conventions after mentioning Orchard. Before the fix, the recorded tally was 37/43. After the changes, the recorded tally was 43/43. Typecheck was reported clean. `verify:wa-selfmaintain` was named, but no result was recorded for that suite.

## Implementation notes

Exclude illustrative markers when classifying rule scope. Require human review for per-block relocation unless project specificity is unambiguous. The live §K relocation loop was reverted and hardened. A protected `universal:` marker remained only a considered extension.

## Verification plan

Use a fixture containing one universal rule with a product example and one genuinely project-specific block. Confirm only the project-specific block relocates and the real specimen survives verbatim. Confirm each relocation is named in the changelog.

## Migration and rollback

The incorrect relocation was reversed by restoring the rule in product-agnostic form. Relocation changes remain recoverable through methodology repository commits, and the live relocation loop was reverted.

## Risks

A stricter classifier may leave some project-specific guidance in shared instructions. Human review adds work, but prevents uncertain scope judgments from silently weakening future sessions.

## Activity log (APPEND-ONLY)
### 2026-08-10 — orchestrator
- Filed from the FEAT-061 agent's report. Note the meta-point: the self-maintenance loop we built to
  protect the methodology is currently able to quietly degrade it — the loop needs the same "never
  auto-apply a judgment call" discipline it enforces elsewhere.

### 2026-08-11 — fix agent (CLASS: fix)
Hypothesis CONFIRMED: `wa-consolidate.mjs` classified a block as project-specific on
`PROJECT_MARKERS.test(b.text)` — a marker ANYWHERE in the block — and relocations were
auto-applied per block.

**Detector rebuild (`classifyBlock`)** — a block is project-specific only if a
NON-ILLUSTRATIVE marker (not inside parentheses, not after e.g./for example/for
instance/such as/as in/like/say in the same sentence) appears in the block's FIRST
sentence (the normative clause — WA house style leads with the bold imperative), or if
≥2 distinct non-illustrative markers appear anywhere. One non-illustrative marker only in
a later sentence ⇒ 'ambiguous'. Chosen over the ticket's single-criterion options because
it encodes "the rule is ABOUT the project" directly and the illustrative-context exclusion
targets the exact incident class. A block tagged `universal:` is never classified at all.

**Demotion** — per-block relocation is GONE. Needs-human `relocation-candidate` for any
partial/ambiguous case. The only auto-applied class is the unambiguous whole section:
≥2 blocks, EVERY block 'specific' with ≥2 distinct markers each, none frozen by a
contradiction. The whole body moves; a pointer stub keeps the §letter resolvable.

**Visibility** — CHANGELOG names every moved rule (first line, quoted); an applied
relocation also lands on the rail as a `relocation-applied` finding (persisted to
.station/needs-human.json alongside the true needs-human items; only in --apply runs —
a propose run claiming "applied" would be a lie).

**LIVE INCIDENT during the fix (the loop bit back, twice):** while the detector was
half-built, the running station's post-capture passes executed the edited script against
the REAL methodology repo at 11:02 and relocated the REAL §K ("Durable, opt-in board")
three times in 23s: (1) §K's single paragraph carried `docs/bugs` + `INDEX.md` in its
normative clause — but those are the universal board convention's own VOCABULARY, exactly
the old empty-section guard's concern; (2) the pointer stub itself said "claude-station",
so every subsequent pass re-relocated its own stub (self-sustaining loop), and twin stubs
are near-identical so they auto-MERGED. All three commits reverted (methodology
9512c13..), CONVENTIONS.md appends discarded, mirror re-synced. Hardened in response:
`INDEX.md`/`docs/bugs` removed from PROJECT_MARKERS (universal vocabulary, not project
tokens); stubs are project-token-free; stub bodies are excluded from both classification
and merge similarity; whole-section bar raised to the ≥2-blocks/≥2-markers form above.

**Verification** (`verify-wa-selfmaintain.mjs`, T7 rebuilt to the new contract):
- PRE-FIX (committed script restored temporarily): 37/43 — 6 FAILs, including T7d (the
  e.g.-"Orchard" universal bullet WAS relocated) and T7f (partial block WAS auto-moved).
- POST-FIX: **43/43 PASS** (was 39 checks; now 43). Fixture proves: whole-section §W
  relocated; e.g.-example bullet survives verbatim; the REAL "separate agent PROCESS,
  never one of your own subagents" specimen (extracted from the WA itself) survives
  VERBATIM; partial btrfs block stays + surfaces as relocation-candidate; CHANGELOG names
  each moved rule; rail carries relocation-applied + relocation-candidate; contradiction
  untouched; second pass honest no-op; real repo untouched (T6).
- `npm run typecheck` clean. Final read-only propose pass on the REAL WA: 0 relocations,
  0 candidates, specimen present, invariant OK (22706 == 22706 bytes), methodology
  porcelain clean.
- Canonical WA §L now documents the demotion + `universal:` tag (methodology commit
  5817934, mirror synced, `sync-methodology --check` OK).

## Closing assessment
CLOSED — fixed and verified. The detector now distinguishes "about the project" from
"cites the project"; relocation is needs-human except the raised-bar whole-section class;
applied relocations are named in CHANGELOG and surfaced on the rail; `universal:` is a
protected tag documented in §L. The mid-fix live incident is the strongest evidence the
demotion was the right call: even the "unambiguous" class misfired on real content until
the bar included multi-block + multi-marker corroboration and stub immunity. Residual
risk: PROJECT_MARKERS is still a hand-kept list — a future marker that is really shared
vocabulary would recreate the §K shape; the needs-human demotion means the blast radius
of that mistake is now a rail finding, not a silent edit.
