```orchard-ticket
{
  "id": "FEAT-088",
  "type": "feature",
  "title": "Ticket readability check misses repetition and ordering faults",
  "summary": "A reader stalled on a long decision ticket whose sentences all passed the readability check. The faults were structural: one fact repeated five times, the justification placed after the decision it supported. A mechanical repetition and ordering lint now ships, passing 26 of 26 checks. A model-judged review layer exists but has no agreed run cadence.",
  "impact_if_we_wait": "Decision tickets keep reaching people in a shape that is slow to read, and the judgement-level faults stay unflagged. Bounded: the mechanical lint already catches repetition and ordering, and no ticket content or existing check is affected.",
  "current_need": "Decide whether the model-judged review runs on every decision-bearing reply, only on tickets, or always but advisory without blocking.",
  "severity": "medium",
  "area": "Ticket readability checks",
  "reported": "2026-08-15",
  "reported_by": "user",
  "owner": "you",
  "work_state": "open",
  "human_action": "decide",
  "updated": "2026-08-18",
  "decision": {
    "mode": "single",
    "question": "Where should the model-judged structure review run: every decision reply, tickets only, or advisory everywhere?",
    "options": [
      {
        "key": "A",
        "label": "Run on every decision reply",
        "what_changes": "Any reply that carries a decision is reviewed for structure before it reaches the reader, and blocks on failure.",
        "benefit": "Every piece of decision content a person reads has been checked for structure.",
        "cost": "Roughly doubles the wait on exactly the turns where someone is waiting to decide.",
        "why_not_obvious": "The delay lands hardest on the moments a person is least willing to wait, so the check invites being switched off."
      },
      {
        "key": "B",
        "label": "Run on tickets only",
        "what_changes": "Only tickets presented as ready to decide are reviewed; ordinary replies are untouched.",
        "benefit": "Costs nothing on interactive turns and covers the longest documents.",
        "cost": "Decision content delivered in conversation stays entirely unchecked.",
        "why_not_obvious": "Most decisions are put to a person in a reply rather than a ticket, so the common path is the uncovered one."
      },
      {
        "key": "C",
        "label": "Advisory everywhere",
        "what_changes": "The review runs on all decision content and reports findings without blocking anything.",
        "benefit": "Shows how often the check would fire before anyone commits to enforcing it.",
        "cost": "Findings nobody must act on are routinely ignored, so bad structure still ships.",
        "why_not_obvious": "A check that never blocks produces no evidence that its findings were worth acting on."
      }
    ],
    "recommendation": "C",
    "recommendation_reason": "It gathers the firing rate needed to choose between the other two, and it can be switched to blocking later without rework.",
    "prerequisite": "Establish how often the review actually fires and how long it adds. If it is rare and fast, running it everywhere stops being expensive."
  },
  "decision_history": [],
  "success_criteria": [
    "The repetition detector reports the five and three repeated claims in the source ticket",
    "The same ticket, with repetitions removed, reports clean",
    "The model pass independently finds that four options collapse to two",
    "Sentence-level checks keep passing on both versions of the ticket",
    "Existing suites stay green and the gate exit status is checked directly"
  ],
  "code_refs": [
    {
      "path": "scripts/lib/readability.mjs",
      "symbol": null,
      "note": "measures clause density, sentence length and grade level; extended with the repetition detector"
    }
  ],
  "related": [
    {
      "id": "ARCH-003",
      "relation": "see_also"
    },
    {
      "id": "BUG-104",
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
    "archived_path": "docs/bugs/archive/FEAT-088-structural-readability-gate.md",
    "sha256": "b44a4d9e22b574196ef2e63945f53ca88e80623b50e3088ea1978c547f034399",
    "bytes": 12302,
    "original_title": "enforce STRUCTURAL readability (repetition, ordering, decision shape), not just sentence complexity",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the two layers, the checklist, the hook points, the run-cadence decision with its three options and the ~800-vs-550 measurement are present.",
    "dropped": [
      "the defect table's row-by-row layout, restated as prose in Diagnosis",
      "the rationale that human attention depletes faster than machine effort"
    ]
  }
}
```

# FEAT-088 — Ticket readability check misses repetition and ordering faults

## Diagnosis

The existing module measures clause density, max and mean sentence length, and grade level, with a clean calibration gap (readable ≤0.81 clauses/sentence, hard ≥1.10). Every defect found in ARCH-003 is invisible to those metrics: a claim stated five times, another three times, both failure directions restated twice more, the thesis sentence placed after the decision it justifies, four options that collapse to two, and a second independent decision buried in a trailing aside.

Measured, the human section of ARCH-003 runs ~800 words against an irreducible floor of ~550. The ~30% slack is entirely repetition, not digression or over-explanation — the length was largely earned and the reading experience failed on repetition and ordering.

## Evidence

`verify:feat-088` reports 26/26 passing; `verify:feat-088-structure` also reports 26/26. A `verify:itself` suite is named in the design but has no recorded run.

## Implementation notes

Layer 1 is mechanical and always on: a repetition detector that finds factual claims restated across a document and reports each cluster with locations, with no model call. It must flag the five and three occurrences in ARCH-003 while leaving legitimate recurrence alone — a term of art appearing in both a summary and a detail section is fine; the same claim asserted as new information repeatedly is not. Cheap structural assertions go alongside it where sections are known, such as a recommendation's justification not appearing only after the decision.

Layer 2 is a model review pass over human-facing decision content, institutionalising the checklist that worked on ARCH-003: classify every sentence (required-to-decide / required-to-trust / orienting / redundant / dispensable); count repetitions with quotes and locations; check whether the reader meets the justification before the decision; challenge the option count; state the irreducible core as a list of facts so the floor is known independent of wording. It must be run by a model that did not write the text.

Hook points: a ticket whose status says a decision is needed must pass both layers before being presented as ready to decide, wired into the existing board gate in the style of `docs:fresh` — a blessing that goes stale when the ticket changes. For replies, the stop hook already knows whether a reply carries a decision, since the digest declares `kind: "decision"`.

## Verification plan

Run the repetition detector against ARCH-003 as committed and confirm it reports the five "three fixes failed" occurrences and the three "nothing is live" occurrences — a must-FAIL, since it currently reports nothing. Run it against the ticket with those repetitions removed and confirm clean. Give the model pass ARCH-003 without the answer and confirm it independently reproduces the finding that the options collapse to two. Confirm sentence-level checks keep passing on both versions. Confirm existing suites stay green, checking `npm run gate` exit status rather than piping it.

## Risks

A repetition detector tuned to one document may flag legitimate recurrence, which is why the tuning case distinguishes a term of art from a repeated claim. The model pass costs latency on the turns where a person is waiting.

## Activity log (APPEND-ONLY)
### 2026-08-15 — orchestrator
- Filed after an independent necessity audit of ARCH-003 showed the sentence-level gate would have passed a
  document the user could not read. The defects were repetition, ordering and decision shape — all
  document-level. User's framing recorded: human comprehension time is scarcer than model processing, so
  double machine cost to halve reading cost is a good trade.

### 2026-08-18 — worker (Layer 1 built + Layer 2 scaffolded)
Landed the mechanical repetition/ordering detector and the model-review scaffold. Risk bucket:
REGRESSION-PRONE calibration (not security/data-loss) — an independent clean-room verify pass is
warranted but not blocking; the self-authored suite is not the last word on the FP characterisation.

**New files:** `scripts/lib/structure.mjs` (pure, no I/O; re-exported from `scripts/lib/readability.mjs`),
`scripts/structure-lint.mjs` (Layer 1 CLI), `scripts/structure-review.mjs` (Layer 2 scaffold),
`scripts/verify-feat-088-structure.mjs` (`npm run verify:feat-088`, 26/26), fixtures under
`scripts/fixtures/feat-088/` (`ARCH-003-committed.md` = the original repetitive revision pinned as the
calibration target; `ARCH-003-cleaned.md` = a de-duplicated twin).

**Similarity approach and why.** Not embeddings, no network. Each document is split into CLAIM UNITS
(sentences of running prose; code blocks, tables, headings, blockquotes and test-tally/verification
boilerplate excluded — those recur by design and are not claims). A cluster is ANCHORED by a distinctive
recurring SIGNATURE and contains exactly the units carrying it: (a) a salient content PHRASE — an
idf-weighted, order-insensitive shingle whose every token is document-RARE (df ≤ 12% of units, the
scale-free gate that separates "the same claim again" from "the ticket's subject mentioned again"), or
(b) a specific COUNT (≥3, folded so "3"=="three"; measurements/ratios/line-refs masked out) restated on
≥5 lines — the ticket's own "same fact stated five times" tell, and the only thing linking reshaped
restatements that share nothing but the number ("three fixes" / "failed three times" / "three
attempts"). Anchors merge only on BOUNDED unit-set overlap (never single-unit transitive bridging — that
chained 98% of the corpus into one blob in the first cut), and every kept cluster must contain one
near-verbatim pair (so a cluster held together only by a shared 2-word topic noun is dropped). Min
cluster size = 3 distinct lines: a claim stated TWICE (summary + detail) is the legitimate recurrence
the ticket says to leave alone.

**Calibration against ARCH-003 (the pinned committed/repetitive revision).** MUST-FAIL, both directions,
asserted on returned clusters not printed text:
- "three fixes / three rejections" → ONE cluster of 8 occurrences that INCLUDES all five enumerated:
  L4 (header "Raised from … three independent checks rejected three different fixes"), L16 (situation),
  L36 (option A cost "failed three times"), L59 ("Three fixes, three rejections"), L72 (closing "six …
  three attempts"). Themed `num:3 + fix/attempt`.
- "nothing is live / not deployed until a restart" → ONE distinct cluster of exactly the three
  enumerated: L54, L151, L164. Themed `live/nothing`.
- The two are DISTINCT clusters, not merged. On the de-duplicated twin, BOTH are gone (reports 0
  clusters). The FEAT-085 sentence-level gate returns the SAME verdict on both (no violations either
  way) — proving it could never have told them apart, which is the whole reason this layer exists.

**False-positive rate on other real tickets.** 68/166 tickets (41.0%) carry ≥1 cluster. Characterised
honestly: ~51 of those are PHRASE-only near-verbatim repeats that are GENUINE (e.g. BUG-007 restates "a
no-op restore destroys the backup it pointed at" verbatim ×3; BUG-023 "three files per session" ×5;
BUG-048 "the two-writers hazard, stated precisely" ×3) — the tool working, not false. The real residual
FP is the count-anchor over-reaching on a doc that reuses ONE number for unrelated measures (BUG-101, a
409-unit WCAG ticket full of "3:1" ratios); this is the inherent ceiling of ALSO satisfying the
requirement that L36/L72 (which share ONLY the number with the core) join the ARCH-003 cluster — no
mechanical rule can include those and exclude BUG-101's noise, which is exactly the semantic call Layer 2
exists for. Named clean controls stay dark (BUG-032, BUG-025, BUG-030 → 0 clusters). The verify script
bounds the corpus rate <60% to catch a chaining regression.

**Real-world confirmation.** A separate placement pass rewrote and committed the live ARCH-003
(4f0c80a) while this was built. Running the detector on that INDEPENDENT human/agent rewrite: both
calibrated clusters are gone — the detector and the human editor agree exactly on which two claims
mattered. The 3 residual clusters there are the technical appendix the editor deliberately preserved
verbatim (cross-section term recurrence), again illustrating the Layer-1 limit Layer 2 resolves.

**Ordering check.** Conservative: fires only when there is exactly one "Recommendation" line, no
justifying sentence at/before it, and one after. Fires on 9/167 tickets; silent on ambiguous shapes.
Null on both ARCH-003 revisions (their recommendations are inline-justified).

**Layer 2 — the model review pass (SCAFFOLD, manual-only, gates nothing).**
`node scripts/structure-review.mjs <file.md> [--author-provider anthropic|openai] [--provider …]
[--model …] [--no-layer1] [--print-prompt]`. Composes the five-step checklist (sentence necessity
classification / repetition count with quotes / ordering / option-collapse challenge / irreducible-core
-as-facts), folds in the Layer-1 findings as a starting point, and dispatches read-only via
`scripts/dispatch.mjs` to a reviewer that is the CROSS provider to the author by default (a self-review
shares the author's blind spot; same-provider emits a warning). `--print-prompt` composes without
dispatching (the seam the verify script drives — no network). NOT wired to run automatically anywhere:
FEAT-088 records an OPEN user decision about where/whether it runs per decision-bearing reply, so nothing
is gated on it (§ Open decision, options a/b/c — recommend (c) advisory-first).

**Left for the user's open decision:** whether Layer 2 runs always / tickets-only / advisory, and
whether Layer 1 becomes a `docs:fresh`-style board blessing on decision-bearing tickets. No hook wiring
done. An independent clean-room verify of the FP characterisation is recommended before any enforcement.
