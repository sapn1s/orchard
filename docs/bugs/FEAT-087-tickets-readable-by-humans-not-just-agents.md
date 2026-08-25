```orchard-ticket
{
  "id": "FEAT-087",
  "type": "feature",
  "title": "Tickets read as agent notes and people skip the headings",
  "summary": "Ticket headings carry instructions written for the author rather than questions a reader can answer, and the wording is inherited from an agent-facing document. Readers skip past them. The in-app ticket view now leads with a plain-language layer and keeps the detailed material below it. The templates, the standard charter wording and the parsers still use the old dialect.",
  "impact_if_we_wait": "New tickets keep being written in vocabulary a reader never agreed to, so the durable record stays hard to read. Bounded: this is presentation and wording, not content. Every existing ticket keeps its full detail and the board tooling keeps working.",
  "current_need": "Decide whether to rename the headings across templates and parsers now, or leave the view layer to carry readability alone.",
  "severity": "medium",
  "area": "Ticket readability",
  "reported": "2026-08-15",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "open",
  "human_action": "decide",
  "updated": "2026-08-20",
  "decision": {
    "mode": "single",
    "question": "Should the ticket headings be renamed to plain questions, or left as they are?",
    "options": [
      {
        "key": "A",
        "label": "Rename headings and migrate parsers",
        "what_changes": "Templates and charter wording use plain questions, and the tooling that reads headings is updated to match.",
        "benefit": "A reader meets ordinary language at the top of every new ticket instead of author instructions.",
        "cost": "Some headings are load-bearing for tooling, so every reader of them has to be found and moved first.",
        "why_not_obvious": "A missed heading reader fails on tickets it used to parse, and that surfaces as a blank section rather than an error."
      },
      {
        "key": "B",
        "label": "Leave templates as they are",
        "what_changes": "Nothing moves. The in-app view keeps doing the readability work on top of the existing wording.",
        "benefit": "No parser risk, and the shipped view already puts plain language first for anyone reading in the app.",
        "cost": "Anyone reading the files directly still meets the old dialect, and every new ticket adds another one.",
        "why_not_obvious": "The stored text is the durable record, so the readability problem keeps growing in the copy that outlives the app."
      }
    ],
    "recommendation": null,
    "recommendation_reason": null,
    "prerequisite": "Establish which headings the board generator, the board checker and the in-app view actually parse. If few are load-bearing, the rename stops being risky."
  },
  "decision_history": [],
  "success_criteria": [
    "A reader unfamiliar with the project states what is wrong and what happens next from the top section alone",
    "Board generation, board checking and the in-app view parse every ticket after the rename",
    "The detailed agent-facing material is still present and still findable",
    "Existing tickets are not rewritten by hand"
  ],
  "code_refs": [
    {
      "path": "docs/bugs/TEMPLATE.md",
      "symbol": null,
      "note": "author instructions rendered as reader headings"
    },
    {
      "path": "docs/bugs/TEMPLATE-ARCH.md",
      "symbol": null,
      "note": "carries the 'Violated invariant (one testable sentence)' heading"
    },
    {
      "path": "scripts/board.mjs",
      "symbol": null,
      "note": "parses some headings; must be migrated rather than broken"
    },
    {
      "path": "tickets.ts",
      "symbol": null,
      "note": "in-app ticket view; heading-sensitive rendering"
    }
  ],
  "related": [
    {
      "id": "FEAT-082",
      "relation": "see_also"
    },
    {
      "id": "FEAT-090",
      "relation": "blocks"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a01bcc-bb73-70d2-aea5-9978d08744e5",
      "verdict": "broken",
      "verdict_on": "2026-08-20",
      "harness": null
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a01bb0-4090-74a3-a680-2b9c52a3d8c1",
      "verdict": "broken",
      "verdict_on": "2026-08-20",
      "harness": null
    }
  ],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-087-tickets-readable-by-humans-not-just-agents.md",
    "sha256": "3c276a2b7a219b4a82af04d64d51a0d942882923142f7c9ef9f4bdf9ecf2d6ec",
    "bytes": 21382,
    "original_title": "tickets are written in agent dialect; make the reader-facing parts human-readable",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared clause by clause against the original head: the ARCH-003 trigger, the four wanted items, the three constraints and the three success criteria are all present.",
    "dropped": []
  }
}
```

# FEAT-087 — Tickets read as agent notes and people skip the headings

## Diagnosis

### Scaffolding leaked into the output

Opening ARCH-003, the user hit `## Violated invariant (one testable sentence)` and reported that their brain simply skips it. That heading is an instruction to the author rendered as a heading for the reader.

The vocabulary is inherited from the Working Agreement, which is written for an agent to follow. Tickets then inherit that dialect — "violated invariant", "must-FAIL proof", "anti-regress", "risk bucket", "regressed-from", `§C`, `§N` — and are read by a human who never agreed to that glossary.

Same root cause as the response-verbosity work: content written for the wrong audience and never reviewed from the reader's seat. The board is the durable record; if it is unreadable, its durability is worth much less.

## Evidence

### What ran on the shipped view half

The in-app view half shipped over five commits. Executed suites and tallies recorded on the ticket:

- `verify:ticket-view-redesign` — 244/244
- `verify:decide-readability` — 58/58
- `verify:bug-109` — 43/43
- `verify:feat-090-handoff` — 31/31
- `verify:feat-090` — 26/26
- `verify:decision-shape` — 25/25
- `verify:feat-081` — 23/23
- a 236/236 tally recorded without an adjacent suite name

Named on the ticket but with no result recorded — mentions, not runs: `verify:feat-082`, `verify:bug-101-contrast`, `verify:ui`, `verify:ticket-schema`, `verify:tickets`, `verify:arch-004-broken-state-visible`.

Four clean-room independent rounds returned BROKEN, each on a false claim in the ticket text rather than a broken mechanism. A fifth round is awaited. Harness run ids: `01a01bcc`, `01a01bb0`.

## Implementation notes

### The four wanted changes

1. **Rename reader-facing headings to plain questions**, moving author instructions into a comment or template-only hint that does not render:
   - `Violated invariant (one testable sentence)` → **What rule is being broken**
   - `Wanted` → **What should happen instead**
   - `Verification (§C)` → **How we'll know it's fixed**
   - `Risk bucket` → **How risky is this**
   - `Must-FAIL proof` → **Proof the test actually catches it**
   - `Anti-regress` → **What else we checked didn't break**
   Keep the precise terms available for agents, but not as the thing a human reads first.
2. **Lead every ticket with a plain-language summary** — two or three sentences, no jargon, answering what is wrong, who it affects, and what happens next. A reader should be able to stop there.
3. **Separate the two audiences.** Agent-facing detail — exact `file:line`, run ids, counts, contract terms — is valuable and must stay, but below the human summary rather than above it.
4. **Render the human part expanded and the agent detail collapsed by default** in the in-app ticket view. This composes with FEAT-082's proof card rather than duplicating it. This is the half that has shipped.

### Constraints

- Do not lose the precision. The forensic detail is what made the independent verifications possible; this is a presentation change, not a content cull.
- `board.mjs` and `tickets.ts` parse some headings. Check what is structurally load-bearing before renaming, and migrate the parsers rather than breaking them.
- Do not rewrite existing tickets by hand. Prefer a template change going forward plus a mechanical rename where it is safe.

## Verification plan

### The bar for the rename half

- A reader unfamiliar with the project opens a ticket and correctly states what is wrong and what happens next, from the top section alone, without needing the glossary.
- Board generation, board checking and the in-app ticket view still parse **every** ticket after the rename — assert on a full board pass, not a sample.
- The agent-facing detail is still present and still findable.

## Activity log (APPEND-ONLY)
### 2026-08-15 — orchestrator
- Filed from the user's reaction to ARCH-003's headings. Diagnosis: template scaffolding and Working-Agreement
  vocabulary rendered as reader-facing headings. Same class as the response-format work — the fix is to write
  for the reader and keep the agent detail below, not to remove it.

### 2026-08-15 — worker (lane: DECISION-NEEDED ticket readability — additive plain-language blocks)
Scoped execution of this ticket's intent against the tickets the user is actually blocked on / triaging.
Did NOT rework the template or the parsers (that is the broader FEAT-087 work) — this pass only ADDED a
`## In plain terms` block (plain summary + "Why it matters" + "What I need from you" + "If you do nothing")
immediately after the header lines of 10 tickets, preserving every existing line below unchanged.

- **Tickets given a plain-language lead block (10):** ARCH-003 (most care — four options rewritten as
  plain choices with cost/benefit + marked recommendation), FEAT-082, FEAT-084, BUG-101 (surfaces its two
  end-of-ticket design questions), FEAT-086, and the older backlog FEAT-049, FEAT-033, FEAT-023, FEAT-030,
  BUG-048 (a human triage summary each).
- **Heading renames:** exactly ONE — in ARCH-003, `## Violated invariant (one testable sentence)` →
  `## The rule being broken (one testable sentence)`. Verified safe first: `tickets.ts:566`'s
  `## (Symptom|Violated invariant)` regex runs ONLY against TEMPLATE text during new-ticket creation, never
  against existing ticket files; `board.mjs` and `tickets.ts` reading paths parse only the H1,
  `- **Status/Severity/Area:**` fields, `### YYYY-MM-DD` activity headings and `## Activity log`. All other
  section headings (Options, Wanted, Verification, Migration path, Proof bar, etc.) were LEFT intact and the
  plain block above carries their meaning, per the "rename only where nothing parses it" rule.
- **Verification:** `board:gen` produced a byte-identical INDEX.md (diff empty — no structural churn);
  `board:check` = "OK — no drift" (its 69 advisory warnings + stale-doc refs are pre-existing, unrelated);
  `readTickets` parses all 10 with zero parse errors, H1/Status/Severity/done-flag intact; the added blocks
  are standard markdown the in-app `prose()` renderer already handles. `npm run gate` checked for its exit
  status before commit.

### 2026-08-18 — editor (emerging standard, extracted from the ARCH-003 rewrites)

Two rules generalised out of ARCH-003. The transferable artefact is NOT the section list — it is an ordering
law plus a de-duplication rule. Both apply to any reader-facing ticket, not just DECISION-NEEDED ones.

**1. The ordering law.** Reader-facing sections must run in this order, because it is the order in which a
reader's questions actually arrive:

> symptom → cost → why it's hard → **recommendation** → options → warrant → appendix

- Any stage with no real content is DROPPED ENTIRELY — do not emit an empty or filler section to complete the
  set. A four-line ticket with symptom + cost is correctly ordered; a padded seven-section one is not.
- The recommendation must ALSO be surfaced in the ticket's Status field, in roughly fifteen words, on one
  line (the board regex is single-line — a wrapped continuation is silently truncated in INDEX.md). A reader
  with two minutes must get the answer in the first ten seconds, before any option prose.
- Corollary: never open a decision with the option you are telling the reader not to pick. The rejected
  baseline stays visible and stays priced — but below the live choices, and without game-theory vocabulary
  ("dominated", "Pareto", "strictly worse") at the point of highest reader friction.
- Corollary: adjudication a reader does not need in order to act belongs BELOW the recommendation, or
  compressed to a clause inside the option it distinguishes. A paragraph that asks for judgement immediately
  before a recommendation that moots that judgement is misplaced, however good the paragraph is.
- Warrant (the failure history / evidence) states its INDEPENDENCE, not just its count. "It failed three
  times" reads as self-assessment; "each rejection came from an independent check" is what makes the history
  credible. Cut repeated counts, never the independence.

**2. The lift-and-delete rule (a template rule this document's own subject violated).** When content is
lifted out of the appendix into a reader-facing block, its copy in the appendix MUST be deleted or explicitly
demoted to a pointer. Two specific smells, both found in ARCH-003 after its first restructure:

- A section titled with an open question ("Interim state — needs a call") sitting inside a block labelled
  "skip unless you are fixing this", after that call was promoted to a reader-facing decision. Near-verbatim
  duplication down to the recommendation wording.
- A stale cross-reference ("same four as above") describing a shape the reader-facing section no longer has.
  A skimmer who dips into the appendix must not come away with a different mental model of the choice than
  the one they were just handed. Re-word cross-references whenever the thing they point at is re-shaped.

Rule of thumb: after a restructure, grep the appendix for every heading and cross-reference phrase and ask
"does this still describe what is above it, and is it still the only copy?" Anything answering no is an
artefact of the rewrite, not content.

### 2026-08-18 — worker (apply the ordering law to the pending-decision tickets)

Applied the ordering law + lift-and-delete rule (above) to the tickets awaiting the user. For each: surfaced
the recommendation into the `- **Status:**` line on ONE line in ~15 words (verified single-line, no wrap — the
board regex truncates a wrapped continuation), reworked the pre-law reader-facing block into
symptom → cost → recommendation → options → do-nothing (dropping empty stages, no jargon above the technical
detail), and inserted a `> reference` marker demarcating the technical body. Checked each ticket's REAL status
first (FEAT-084 and FEAT-089 are BUILT — their leads were rewritten to past-tense "shipped + proof", not left
reading as pending).

**Reworked (9):** FEAT-082 (OPEN — recommend facets + proof card, no Kanban; proof-capture the one open Q),
FEAT-084 (VERIFIED/built — lead corrected from pending to shipped+verified), FEAT-086 (OPEN — recommend
read-only build, estimate-labelling the condition), BUG-101 (VERIFIED — status "unbiased review pending" was
STALE per its own fix4 log which records the reviewer signed off the rendered card; corrected; two design Qs
genuinely have no recommendation, said so rather than fabricating one), FEAT-049 (OPEN — cleanup complete,
scripts tested, keep open until publish), FEAT-033 (OPEN — top-3 evaluated, close-or-park), FEAT-023 (OPEN —
stays parked behind FEAT-021/022), FEAT-030 (OPEN — file-handoff shape, parked), BUG-048 (OPEN — staged fix,
honest-status first step; status "explore first" was stale, explore is finished).

**Board-placement gotcha found + handled:** `board.mjs isDoneStatus` matches the bare word `DONE` ANYWHERE in
the status line (`/\bDONE\b/`). A recommendation phrased "cleanup **done**" (FEAT-049) or "explore **done**"
(BUG-048) silently moved those OPEN tickets into the Done-committed table (and dropped FEAT-049's curated `👤`
owner). Reworded to "complete"/"finished". Conversely FEAT-082's OLD status "proposal **done**" had wrongly
placed it in Done all along; the reworked status (no "done") correctly relocates it to Open — the one
intentional cross-table move. Net INDEX churn after a clean single `board:gen`: status cells only, plus that
FEAT-082 correction. `board:check` → "OK — no drift".

**Repetition detector (`scripts/structure-lint.mjs`) over each reworked ticket — reported honestly:**
- FEAT-082: no clusters. FEAT-030: no clusters.
- FEAT-084, FEAT-086, FEAT-049, FEAT-033, FEAT-023: one 3-occurrence cluster each — all in the technical /
  Rejected / Activity sections (e.g. FEAT-086's "API-equivalent estimate, not spend" across Why + Constraints +
  Activity — a load-bearing warning; FEAT-023's feature description across the lead + `## Goal` + Design, a
  mild pre-existing overlap between the plain lead and the technical Goal). NONE were introduced by the reworked
  reader-facing lead; each is domain repetition in the demoted reference body.
- BUG-101 (10 clusters, 409 units) and BUG-048 (5 clusters, 169 units): the large tallies are entirely inside
  the append-only worker/probe logs — four fix rounds of contrast tuning (BUG-101), five explore/probe entries
  (BUG-048). These are append-only reference detail that legitimately repeats technical terms across rounds and
  are NOT rewritable; the reader-facing leads are clean. This is the detector working as intended: it flags the
  dense technical bodies, which are now clearly demarcated as skip-unless-building reference.

### 2026-08-20 — ticket-view lane (item 4: how the in-app ticket view presents sections)

**Scope.** This lane executed item 4 of *Wanted* — how the in-app view presents a
ticket — and nothing else: `TEMPLATE.md`, `TEMPLATE-ARCH.md`, the charter language
and the board parsers are untouched, so items 1–3 remain entirely open. What it
ran into, and spent four of its five commits on, was not layout: it was that the
view's own sentences were not true. That is the same root cause this ticket
already names — content written for the wrong audience and never reviewed from the
reader's seat — one layer down, in the fallback text nobody reads until the day
they need it.

**What shipped (five commits).**

- `198013f` — the three-band view: a human layer, the decision, then the
  archaeology. The band order is this ticket's item 3 ("agent-facing detail below
  the human summary, not above it") made structural.
- `74e03e2` — the reader-facing rules. An empty band is not drawn at all: 182 of
  the 186 real tickets used to open with "What's happening / Not recorded / What
  this ticket needs / Not recorded", an empty impact card and a paragraph
  apologising for all three — 50 words of scaffolding above the ticket's own first
  sentence, now 0. "Not recorded" survives only in the dense facts grid, where a
  label and an empty value share one line. A deep slot whose only content is its
  own absence is one flat row, not an expander that opens onto a second copy of
  the absence. Also: a malformed record block was being DELETED before rendering
  while the error note said the original was shown in full.
- `3931eb3` — that "verbatim" block was still being handed to `prose()`, whose
  fence model is a character-run split, so a record quoting an inline fence run
  truncated mid-value (46 lines, 30 reachable, `work_state` not among them). The
  block is now printed into a `<pre>` as a text node, never parsed.
- `5c945e3` — the block's region began at byte 0 rather than at the opening fence
  (`^\s*` matches newlines), so whitespace before the block rode inside a `<pre>`
  captioned "verbatim and whole"; and a partially-written file — opened fence, no
  closing fence — was still being announced as "Not migrated" with a work state
  taken from the board index.
- `739275e` — one sentence was written over four different hazard classes and was
  true of one of them: a NUL, a zero-width space and a line separator do not
  reorder text, and the reader of a NUL-bearing record was pointed at display
  order and away from the byte they could not see. Also: "This ticket HAS been
  migrated" is not observable — the view can only see that a file *begins* with a
  record block — so it now says that instead.

**Four independent clean-room rounds, four real defects, and the pattern in them.**
Every one was a FALSE CLAIM, not a broken mechanism. In each case the code did
what it was written to do; the sentence next to it on the page said something
untrue about what that was. Three of the four were found on the class of text a
reader only meets on their worst day — an error fallback — which is exactly where
nobody reviews.

Two verdict lines, verbatim. (The run ids for the first two rounds were not passed
to this lane; these are rounds 3 and 4.)

- **Verified-by:** dispatch openai run 01a01bcc-bb73-70d2-aea5-9978d08744e5 (clean-room, scripts/independent-verify.mjs) — VERDICT: BROKEN
- **Verified-by:** dispatch openai run 01a01bb0-4090-74a3-a680-2b9c52a3d8c1 (clean-room, scripts/independent-verify.mjs) — VERDICT: BROKEN

**The state now, stated plainly: this is not finished.** Four rounds, four
defects, and the current commit (`739275e`) has not been through any independent
round — a fifth is being arranged. Every previous commit in this list also looked
finished to the lane that wrote it, and each one passed a large green suite
(167, 184, 218, 244 checks) while carrying a false statement. The correct reading
of that record is not "converging"; it is that this lane's own suite has never
once been the thing that caught the defect.

**The transferable lesson, in general form — this is the part worth copying.**
Four rounds missed the fourth defect because of two habits, and both are general:

1. **A fixture that bundles hazard classes into one seed lets a claim be
   accidentally true.** One seed carried a bidi override, two line separators and
   a NUL together; the sentence "these reorder what you see" was true of the bidi
   override, so the seed passed while the sentence was false of three of the four.
   A class per seed is the fix, and it generalises to any claim quantified over a
   set: if the fixture bundles the set, a claim true of one member passes.
2. **Asserting that a page NAMES a thing is not asserting that what it SAYS about
   it is TRUE.** The suite checked that `U+0000` appeared in the note. It did. The
   sentence beside it was wrong. Every claim-bearing sentence the view now emits
   is asserted in BOTH directions — that the wording true of this case is present,
   AND that the wording belonging to the other cases is absent. That second half
   is the one that was missing everywhere, and it is what turns a test of presence
   into a test of truth.

A third, smaller one, earned three times: a green assertion and a wrong screenshot
disagreed on three separate occasions in this lane and the screenshot was right
every time. Twice the assertion was checking a mechanism (a computed style, a
class name) while the reader saw something else.

**A standing limitation, not a TODO — nothing will change it.** The suite's RED
leg (8 checks: the pre-change rendered comparison and the before/after
words-before-the-decision counts) needs a `git worktree` of a pinned pre-change
commit. A clean room is not a git repo, so no independent round can ever run
those 8. They are skipped with a notice naming exactly what did not run, and the
pre-change numbers therefore rest on this lane's own runs alone. That is legibly
unverified, which is the best available state, not a gap to be closed.

**Cross-lane collision, recorded.** `5c945e3` carried ~45 lines of another lane's
`.orchard-notes` fold CSS in `public/styles.css` under a commit message about
fence regions. Nothing was lost and the other lane's work is intact, but the
history attributes it wrongly. `git commit --only -- <paths>` scopes to FILES, not
to hunks within a file; on a known shared file (`public/styles.css` is one) the
diff for that path has to be read before committing, not assumed.

**Verification.** `verify:ticket-view-redesign` 244/244, exit 0 (236/236 under
`--no-red`). Anti-regression, all exit 0: `verify:decide-readability` 58/58,
`verify:feat-082` 52/0, `verify:feat-090` 26/26, `verify:feat-090-handoff` 31/31,
`verify:bug-101-contrast`, `verify:ui` 7/0, `verify:decision-shape` 25/25,
`verify:bug-109` 43/43, `verify:feat-081` 23/23, `verify:ticket-schema`.
`verify:tickets` 29/30 and `verify-arch-004-broken-state-visible` 99/3 match the
baselines measured on a worktree of the parent commit — both pre-existing, neither
touched by this lane. Corpus sweep: all 186 real tickets rendered on both trees,
28,434 content lines, 23 unreachable on 8 tickets — every one BUG-111's fence-run
defect in `public/lib/dom.js`, identical set on both trees. `npm run gate` exit 0,
read directly, before each commit.

**Filed from this lane, not fixed in it:** BUG-120 (the clean room's contamination
strip is a deny-list), BUG-121 (the record fence grammar is anchored, so a block
not at the top is invisible). Grammar-disagreement evidence was handed to ARCH-008
as an activity entry.

**Still open on THIS ticket:** items 1, 2 and 3 in full — the heading renames, the
plain-language lead in the template, and the two-audience separation in
`TEMPLATE.md`/`TEMPLATE-ARCH.md` and the charter language. This lane changed how
the view PRESENTS sections and what it CLAIMS; it did not change how tickets are
written.

**Handoff:** whoever takes items 1–3 should read the two lessons above before the
section list. The renames are the easy half; the hard half is that this ticket is
about text being true for its reader, and the four rounds above are four
demonstrations that "the code is right" and "the sentence is true" are separate
properties that need separate tests.

**Proposed INDEX row** (this lane does not edit `INDEX.md`):

`| FEAT-087 | tickets are written in agent dialect; make the reader-facing parts human-readable | — | OPEN — the in-app view half (item 4) has shipped over five commits and is awaiting a fifth independent round; four clean-room rounds have returned BROKEN, each on a false CLAIM rather than a broken mechanism; the template/charter/parser half is untouched. | med |`
