```orchard-ticket
{
  "id": "BUG-111",
  "type": "bug",
  "title": "Tilde-fenced code blocks render as live headings and tables",
  "summary": "Two halves of the rendering pipeline disagree about where a fenced code block starts and ends. A tilde-fenced block is not recognised by the shared renderer at all, so its contents render as real headings and tables. A fence opened inside a quote or list item leaks the quote and indent markers into the code box.",
  "impact_if_we_wait": "Fenced content renders as live markup instead of code wherever tildes or nesting appear. Bounded: the content stays visible rather than being swallowed, and no stored text is altered.",
  "current_need": "Hold this until the block grammar it must match stops changing, then rewrite the shared renderer's fence handling to follow that grammar.",
  "severity": "medium",
  "area": "Markdown rendering",
  "reported": "2026-08-19",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-08-20",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A tilde-fenced block renders as a code box, not as headings or tables",
    "Backtick and tilde fences are handled by one scanner, not two branches",
    "A closer shorter than its opener does not end the block",
    "An opener indented up to three spaces still opens a fence",
    "A fence inside a quote or list item renders without the enclosing markers",
    "Every region the block grammar treats as fenced renders with the same extent"
  ],
  "code_refs": [
    {
      "path": "public/lib/dom.js",
      "symbol": "prose",
      "note": "line 315; the fence model is a split on backtick runs at line 327 and the info-string strip at line 330 — a character-run splitter, not a line scanner"
    },
    {
      "path": "public/lib/response-blocks.js",
      "symbol": null,
      "note": "the line-based, fence-character-parameterised scanner that is the source of truth; its header comment records the closer-length, info-string and 0–3-indent rules, and that a tilde run never closes a backtick fence"
    }
  ],
  "related": [
    {
      "id": "ARCH-006",
      "relation": "see_also"
    },
    {
      "id": "ARCH-008",
      "relation": "see_also"
    },
    {
      "id": "BUG-109",
      "relation": "see_also"
    },
    {
      "id": "BUG-110",
      "relation": "see_also"
    },
    {
      "id": "FEAT-091",
      "relation": "depends_on"
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
    "archived_path": "docs/bugs/archive/BUG-111-prose-fence-model-is-a-char-run-split-not-a-line-scan.md",
    "sha256": "c3ddae813b5b432eb540bec9a14423d34be04c1eb1b1bebdcd10797c585d09b0",
    "bytes": 9512,
    "original_title": "prose() models a code fence as a character-run split, not a line scan, so it disagrees with the block grammar about what a fence is",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Read against the original head; the two observed renderings, the five-rule design guidance, the divergence bound, the sequencing block and the code line references are all present above.",
    "dropped": [
      "the restatement of the design rules under a separate Expected heading, which duplicates the implementation guidance"
    ]
  }
}
```

# BUG-111 — Tilde-fenced code blocks render as live headings and tables

## Diagnosis

### Two models of one grammar

`response-blocks.js` scans fences line by line, parameterised on the fence character. It honours a closer at least as long as its opener, info strings, 0–3 spaces of indentation, and both backtick and tilde, which CommonMark treats as equal. `prose()` in `public/lib/dom.js` still models a fence as `src.split(/```/)` with an info-string strip of `chunk.replace(/^[^\n]*\n/, '')`: it splits the whole string on runs of backticks and calls every other chunk code. A character-run splitter has no notion of the line context a fence sits in, so it cannot see a tilde opener at all and cannot strip a `>` or a list indent from the region it captures.

This is the divergence class rather than the hidden-content class that produced five BROKEN verdicts on the block grammar, but it is the same parser-versus-renderer disagreement, and it is the last one that is designed in rather than accidental. `response-blocks.js` is the source of truth; the goal is one shared understanding of a fence, not a second implementation that happens to agree today.

## Evidence

### Observed in a real browser, from the BUG-110 lane

A block opened and closed with `~~~js` containing a `#` line and a `| a | b |` line renders with `preCount 0`. There is no `<pre>` at all: the `#` line becomes a real heading element and the pipe line becomes a real `<table>`, because `prose()` never recognised the tilde opener.

A backtick fence opened inside a `>` blockquote, or inside an indented list item, renders a `<pre>` whose body still carries the leading `>` characters or the indent markers of the enclosing construct.

To reproduce, feed `prose()` — or any surface that renders model- or file-provided markdown, including assistant messages, plan cards, guide pages and ticket bodies — a tilde-fenced block, or a backtick fence nested in a blockquote or indented list item, and compare the fenced extent against the line-based scanner over the same input.

No test covers this yet. The existing real-browser suite for BUG-109 renders the shipped `/lib/dom.js` and is the natural place to add a fence-divergence case, or a suite of this ticket's own can be added when the fix lands.

## Implementation notes

### Reuse this guidance, do not re-derive it

The finding lane wrote the design down already. Replace the splitter with a line-based scanner matching the `response-blocks.js` grammar:

- Parameterise the fence character — one scanner over backtick or tilde. A second tilde branch bolted onto the backtick path is a second model that will drift, which is this defect.
- A fence closes on a run of the same character at least as long as the opener.
- Handle info strings, with CommonMark's one asymmetry: a backtick fence's info string may not contain a backtick, a tilde fence's may contain anything.
- Handle 0–3 spaces of indentation on opener and closer; four or more columns is indented code, not a fence.
- Handle blockquote and list-item continuation, stripping the enclosing `>` or indent markers from the rendered `<pre>` body.

### Why the finding lane did not do it

Replacing the fence model does not merely add tilde support. It changes backtick edge-case behaviour too — today an inline triple-backtick run splits — so it perturbs every existing renderer suite. That makes it a core-renderer rewrite with its own regression surface, at lower severity than the content-loss charter it was found under, and the coordinator explicitly offered it as a separate ticket.

### Sequencing

Do not start while `response-blocks.js` is under active change under FEAT-091. Building the shared fence model against a moving grammar is building against a moving target.

## Verification plan

Independent verification is required before this can be called verified, because it rewrites the shared renderer's fence model.

Render, in a real browser against the shipped `/lib/dom.js`, a tilde-fenced block, a backtick fence whose closer is longer than its opener, an opener indented one to three spaces, a fence inside a blockquote, and a fence inside an indented list item. Assert a `<pre>` of the same extent the line-based scanner reports for each input, with no enclosing markers in the body. Re-run the existing renderer suites, whose backtick edge cases this change is expected to perturb, and reconcile every difference deliberately.

## Risks

The rewrite changes behaviour for inputs that work today, notably an inline triple-backtick run, so existing renderer suites will move and each movement has to be judged rather than accepted. Landing it before the block grammar settles risks matching a model that has since changed.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-19 — filed by the coordinator from the BUG-110 lane's handoff
- **Understood:** two halves of one render pipeline hold independent, drifting models of a fence — `prose()` a character-run split on backticks (`src.split(/```/)`), `response-blocks.js` a line-based, char-parameterised scanner. The BUG-110 lane gathered real-browser evidence of the consequences (tilde blocks rendering as live prose so an inner `#`/`|` becomes a real heading/table; blockquote/list-item fences leaking their `>`/indent into the `<pre>`) and deliberately did NOT fix it inside its content-loss charter, because unifying the fence model changes backtick edge-case behaviour too and perturbs every renderer suite — a core-renderer rewrite with its own regression surface at a lower severity than the content-loss bug it was found under.
- **Changed:** nothing — this is the filing entry, no product code touched.
- **Still open / handoff:** do the unification once `response-blocks.js` settles (currently changing under FEAT-091). Make `prose()` share the block grammar's fence understanding: parameterise the fence character, match closer length ≥ opener length, handle info strings, handle 0–3-space indentation, handle blockquote and list-item continuation. The block grammar is the source of truth; the goal is one shared understanding, not a second implementation that happens to agree today. This is `fix`-class and touches the shared renderer, so it needs an independent clean-room verify before VERIFIED (content-loss-adjacent, regression-prone renderer).

### 2026-08-20 — fixed by REUSING the block grammar's scan, not by writing a second one
- **Understood:** the diagnosis held on re-reading. `prose()` split on `/```/` and called every other
  chunk code, so a `~~~` block was invisible (its `#` became a real heading, its `|` row a real table)
  and a quoted or list-nested fence carried its `>` / indent into the `<pre>`.
- **Changed:** `response-blocks.js` — the grammar's owner — now RECORDS every fence extent at the one
  place its single walk already decides one (`fences[]`, pushed beside the existing `findClose`), and
  exports `fenceSegments(text)`, which turns that record into prose/code segments with container and
  opener-indent prefixes stripped. `prose()` imports it and reads that verdict. No second fence model
  was written and no ownership was restructured, so `ARCH-008` is untouched and un-pre-empted; the
  recording is purely additive, block semantics are unchanged (the fence extent is CommonMark's
  opener-to-close, deliberately NOT the `certainFoldEnd` fold shrink, which is a hiding guard rather
  than a statement about where a fence ends).
- **Verified — REDUCED SCOPE, stated plainly:** the round was cut by the user mid-flight ("skip
  verifications of browser or anything that is taking time and effort"), so the planned real-browser
  suite, the CommonMark differential, the fuzz corpus and the clean-room pass were all DROPPED. One
  check was kept, chosen because it is the only one standing between this and a content-loss bug: the
  segments must be a LOSSLESS LINE PARTITION of the input, graded over the REAL corpus of 411 ticket
  and prompt markdown files — every line lands in exactly one segment, and every non-blank line's text
  survives into the segment that owns it. 831 pass / 0 fail. Nine behaviour cases alongside it (tilde
  fence, longer closer, short closer that must NOT close, 3-space indent, quoted fence, list-nested
  fence, backtick inside a tilde info string, unterminated fence) pass, with the must-FAIL anchored to
  a pre-change splitter SYNTHESIZED in the harness — never to `HEAD` — which fails 7 of the 9.
  `prose()` itself was driven through a DOM shim on the two headline shapes: the tilde block yields a
  `<pre>` with no heading and no table and both sentinels intact, and the quoted fence yields a `<pre>`
  whose body is `code here` with no `>`. `npm run verify:feat-091` (the grammar owner's own suite)
  stays 277/0.
- **Still open / handoff:** independent clean-room verification is still REQUIRED before VERIFIED —
  it was cut, not satisfied. What it should attack, in priority order:
  1. **The one deliberate behaviour change nothing here graded.** `prose()` now inherits the grammar's
     HTML-block inertness: a fence inside a top-level `<div>`/`<details>` region is no longer a fence,
     so it renders as prose rather than a code box. That agrees with the reference and with the source
     of truth, and it is why success criterion 6 holds — but it is a real change to real ticket and
     transcript rendering, and no check here exercised it.
  2. **The differential that was dropped.** Grade `fenceSegments` against the pinned `commonmark`
     0.31.2 reference over the FEAT-091 fuzz corpus: the set of lines the reference puts inside a
     `code_block` must equal the set this reports, in both directions.
  3. **The real browser.** Everything here ran in node or a DOM shim. Nothing proved the shipped
     `/lib/dom.js` renders these in a real page, and `dom.js` gained its FIRST import — a browser that
     fails to fetch `/lib/response-blocks.js` breaks every surface that renders markdown.
  4. **Partial reads.** `prose()` renders a STREAMING assistant buffer, so it is fed truncated text
     continuously. Truncate a real transcript at many points and check no prefix loses a line.
  5. **The nested-region filter.** `fenceSegments` skips a recorded region that starts inside one
     already emitted (a fold-certainty re-scan artefact). Attack it with a collapsed `orchard-*` block
     whose body holds an unpaired inner fence, which is the shape that produces one.

### 2026-08-25 — worker
- **bookkeeping-sweep:** 2026-08-25 bookkeeping sweep (authorised by the user) — NOT closed, and one new fact. The fix itself is committed (a76de65): `fenceSegments` is exported from public/lib/response-blocks.js and public/lib/dom.js imports it. `npm run verify:feat-091` at HEAD is 276 passed / 1 failed, and the one failure is NOT this work — it is `the injected core stays inside its stated budget` (5245 chars against a 4000 budget), which comes from src/server/templates.ts, last touched by FEAT-098; filed separately today. What does belong to this ticket: `node scripts/verify-feat-091-renderer.mjs` now FATALs at HEAD. 162 checks pass, then the non-vacuity CALIBRATION leg substitutes a HISTORICAL public/lib/response-blocks.js into the page over CDP to prove the leg can still fail — and those old bytes have no `fenceSegments`, so dom.js new import throws `does not provide an export named fenceSegments` and the run aborts before the calibration is graded. regressed-from: BUG-111 (this ticket). It is a harness break rather than a product break, but it is the leg that proves the renderer suite is not vacuous, so the suite currently cannot complete. Next agent: give the calibration substitution a compatible `fenceSegments` (or serve the historical bytes only to the block-grammar module and not to dom.js) and then re-run; the four clean-room attacks listed in the entry above are still unspent.
