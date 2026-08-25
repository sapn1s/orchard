# FEAT-088 — enforce STRUCTURAL readability (repetition, ordering, decision shape), not just sentence complexity

- **Status:** OPEN — Layer 1 (mechanical repetition/ordering lint) shipped, `verify:feat-088` 26/26; Layer 2 model-review scaffolded, run-cadence undecided
- **Area:** scripts/lib/readability.mjs (extend) + a new structure-review pass + hook points (stop hook, board gate)
- **Reported:** 2026-08-15 by user

## In plain terms

We built a check that measures how hard sentences are to read. It works. But it would have passed the
ticket the user actually got stuck on, because that ticket's problems were not in its sentences.

The user read ARCH-003 and ground to a halt. An independent review found why: the same fact was stated
five times, another three times, and the one sentence that justified the whole recommendation sat at the
very end — after the decision it was supposed to justify. Also, four options were offered where there
were really two.

**Why it matters:** Human reading time is the scarce resource here, not model processing. The user is
explicit: spending double the machine effort to save human comprehension time is a good trade, because
human attention depletes far faster.

**What I need from you:** Nothing yet — this is the design. Flagged decision inside: whether the
expensive review pass runs on every decision-bearing reply (slower turns, best quality) or only on
tickets (cheaper, but my chat replies stay unguarded).

**If you do nothing:** The sentence-level check keeps working and structural problems keep shipping.

## What the current check cannot see

`scripts/lib/readability.mjs` measures clause density, max/mean sentence length, and grade level. Those
caught real problems and the thresholds are well calibrated (clean gap: readable ≤0.81 clauses/sentence,
hard ≥1.10). But every ARCH-003 defect is invisible to it:

| Defect found in ARCH-003 | Detectable by sentence metrics? |
|---|---|
| "three fixes failed" stated 5 times | No |
| "nothing is live" stated 3 times | No |
| Both failure directions restated 2 extra times | No |
| The thesis sentence placed AFTER the decision it justifies | No |
| 4 options that collapse to 2 real choices | No |
| A second, independent decision buried in a trailing aside | No |

Measured: the human section runs ~800 words against an irreducible floor of ~550. The slack is ~30% and
it is entirely repetition — not digression, not over-explanation. The length was largely EARNED; the
reading experience failed on repetition and ordering.

## Design

### Layer 1 — mechanical, cheap, always on
Extend the readability module with a **repetition detector**: find factual claims restated across a
document and report each cluster with its locations. Deterministic, no model call. Tune against the real
case — it must flag "three fixes failed" (5 occurrences) and "nothing is live" (3) in ARCH-003, while not
flagging legitimate recurrence (a term of art appearing in both a summary and a detail section is fine;
the same CLAIM asserted as new information repeatedly is not).

Also add cheap structural assertions where a document has known sections: e.g. the justification for a
recommendation should not appear only AFTER the decision.

### Layer 2 — a model review pass, for human-facing decision content
Some defects need judgement and cannot be regexed: whether options collapse, whether a sentence is
required-to-decide or merely orienting, whether the ordering serves the reader. Institutionalise the
checklist that demonstrably worked on ARCH-003:
1. Classify every sentence: required-to-decide / required-to-trust / orienting / redundant / dispensable.
2. Count repetitions with quotes and locations.
3. Check ordering — does the reader meet the justification before the decision?
4. Challenge the option count — are these genuinely distinct choices, or do some collapse?
5. State the irreducible core as a list of FACTS, so the floor is known independent of wording.
Run by a model that did NOT write the text (this is the same generation-must-not-verify-itself rule that
caught three bad fixes today).

### Hook points
- **Tickets:** a ticket whose status says a decision is needed must pass both layers before it is presented
  as ready to decide. Wire into the existing gate/board check, in the style of `docs:fresh` — a blessing
  that goes stale when the ticket changes.
- **Replies:** the stop hook already knows whether a reply carries a decision (the digest declares
  `kind: "decision"`). Gate the expensive pass on that, so ordinary turns stay fast and decision-bearing
  turns get the scrutiny.

## Open decision (for the user)
Running a model review on every decision-bearing REPLY doubles latency on exactly the turns where the user
is waiting to decide. Options: (a) run it always — best quality, slowest; (b) tickets only — cheap, chat
replies unguarded; (c) run it always but ADVISORY, surfacing findings without blocking. Recommend (c)
first, measure how often it fires, then decide whether to enforce.

## How we'll know it's working
- The repetition detector, run against ARCH-003 as committed, reports the five "three fixes" occurrences
  and the three "nothing is live" occurrences (must-FAIL: it currently reports nothing).
- Run against the ticket AFTER those repetitions are removed, it reports clean.
- The model pass, given ARCH-003, independently reproduces the finding that the options collapse to two —
  without being told that answer.
- The sentence-level checks keep passing on both versions (they always did — that is the point).
- Existing suites stay green; `npm run gate` exit status checked, not piped.

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
