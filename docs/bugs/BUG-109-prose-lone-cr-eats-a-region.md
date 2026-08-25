```orchard-ticket
{
  "id": "BUG-109",
  "type": "bug",
  "title": "Part of a rendered message vanished with no error",
  "summary": "Rendered model and file text could silently lose a whole region: content present in the source appeared nowhere on screen, with no error and no gap. The shared markdown renderer now treats a bare carriage return as a line break, so every region renders in order. The real-browser reproduction that failed before the change passes.",
  "impact_if_we_wait": "Content disappears from view without any signal, so a reader cannot tell anything is missing. Bounded: this is display-only, the source text is untouched, and assistant transcript messages were already protected by a separate normalisation at their entry point.",
  "current_need": "Nothing is outstanding. The pre-fix case reproduced the missing region in a real browser, the corrected behaviour renders every region, and the neighbouring markdown and interface checks stayed clean.",
  "severity": "high",
  "area": "Markdown rendering",
  "reported": "2026-08-18",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-20",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Every region of the source renders in source order under LF, CRLF, lone CR and mixed line endings",
    "The first line of a fenced code block survives when a bare carriage return follows the info string",
    "Callers of the shared renderer need no normalisation of their own"
  ],
  "code_refs": [
    {
      "path": "public/lib/dom.js",
      "symbol": "prose",
      "note": "line ~306; normalise is now `String(text ?? '').replace(/\\r\\n?/g, '\\n')`, was `/\\r\\n/g` — it runs before the fence split `src.split(/```/)`, the info-string strip `chunk.replace(/^[^\\n]*\\n/, '')`, the paragraph split `/\\n{2,}/` and `b.split('\\n')`"
    },
    {
      "path": "public/lib/digest.js",
      "symbol": "renderAssistantText",
      "note": "the neighbouring lane's boundary normalise with the same `/\\r\\n?/g`; its header comment names this defect, which is why transcript messages were never exposed"
    },
    {
      "path": "public/question.js",
      "symbol": null,
      "note": "line 284, plan cards — one of the callers that reached prose() with unnormalised text"
    },
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "exposed call sites: 5570 (agent ran-out summary), 7101 (agent thread text), 2795 and 2814 (live streaming buffer and finish), 9161/9170 (guide markdown), 10165 (ticket markdown)"
    }
  ],
  "related": [
    {
      "id": "ARCH-006",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-110",
      "relation": "see_also"
    },
    {
      "id": "BUG-111",
      "relation": "see_also"
    },
    {
      "id": "BUG-124",
      "relation": "see_also"
    },
    {
      "id": "FEAT-016",
      "relation": "see_also"
    },
    {
      "id": "FEAT-081",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a016a6-a330-7e91-914d-71a46a0d3177",
      "verdict": "broken",
      "verdict_on": "2026-08-18",
      "harness": "scripts/independent-verify.mjs"
    }
  ],
  "verification_class": "fix",
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
    "archived_path": "docs/bugs/archive/BUG-109-prose-lone-cr-eats-a-region.md",
    "sha256": "519e892ec58dab1ca1e6845bbe05d40b8cf61af61fe6b000c0f303aef1b957a3",
    "bytes": 11805,
    "original_title": "a lone carriage return after a code fence silently ate a whole region of a rendered message",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Read against the original head: the carriage-return cause, the swallowed-region symptom, the in-renderer one-line fix, the exposed and non-exposed callers, and the browser repro are all present.",
    "dropped": [
      "the 'if you do nothing' line, whose content is that nothing is required of the reader",
      "the reading-order note separating the plain-terms section from the technical record"
    ]
  }
}
```

# BUG-109 — Part of a rendered message vanished with no error

## Diagnosis

`prose()` is the single renderer that turns model- and file-provided markdown into safe DOM: assistant messages, plan cards, agent and notice text, the live streaming buffer, guide pages and ticket bodies. Rendering a fenced block means stripping the block's first line — the info string — and that strip looked for a `\n`. Text arrives with Windows line endings or, less often, a bare `\r`. `prose()` collapsed `\r\n` to `\n` before looking but never handled a lone `\r`, so `chunk.replace(/^[^\n]*\n/, '')` ran past the carriage return and deleted everything up to the next real newline.

The transcript's front door already normalised `\r`, `\r\n` and `\n` on entry, so assistant messages were safe. Every other caller handed `prose()` text directly and was exposed.

The fix is one line inside `prose()`: normalise all three endings to `\n` as its very first act, before any line-shaped rule runs. Fixing it in the renderer rather than at each caller means no caller can forget and no downstream rule can be blind to a line break. It cannot corrupt a caller — to markdown all three sequences are the same line ending, and a `\r` inside a code block renders as whitespace in a browser either way.

`inlineInto()` is called by `decide.js` with unnormalised text and is not a content-loss vector: it appends every byte and never strips a first line. The recursive self-call at `dom.js:327` and every `digest.js` caller were downstream of an existing normalise.

## Evidence

The symptom surfaced in the neighbouring lane's investigation as `R2 TokNNNNz rendered nowhere at all` — a region present in the source and absent from the DOM.

Pre-fix repro: a message whose fence carries a lone CR after the info string, so the chunk reads `js\r<first code line>\nconst keep = 1;\n`. `[^\n]*` matches `js\r<first code line>` and the replace takes the whole first code line with the info string. Rendered in a real browser, pre-fix `verify:bug-109` produced `"Heading R1zq7heading` `const keep = 1;` `Section R3zq7para…"` with the `R2zq7codeline` sentinel absent.

Post-fix, in a real brave over CDP against the shipped `/lib/dom.js`: `verify:bug-109` 23/23. Neighbouring suites stayed clean — `verify:feat-081` 23/23, `verify:feat-082` 52/52, `verify:orchard-transcripts` 15/15, `verify:streaming-md` 9/9, `verify:ui` 7/7.

A clean-room round under harness run `01a016a6` re-ran the repro suite green and reported a separate defect, filed and fixed as BUG-110.

## Implementation notes

One line in `public/lib/dom.js`. The normalise widened from `/\r\n/g` to `/\r\n?/g` and stays the first statement of `prose()`.

## Verification plan

`npm run verify:bug-109` drives a real brave over CDP against the shipped `/lib/dom.js`. It asserts every region of the source renders in source order under LF, CRLF, lone-CR and mixed endings within one input, including the first line of a fenced code block.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-18 — worker (Opus 4.8)
- **Understood:** `prose()` normalised only `\r\n`, never a lone `\r`, while its line-shaped rules
  (fence split, info-string strip, paragraph split, `split('\n')`) all assume `\n`. A `\r` after a
  fence info string let the info-string strip run past it and delete the first code line — the
  "R2 rendered nowhere" content loss the neighbouring lane observed. That lane fixed its own entry
  points (digest.js boundary), leaving every other `prose()` caller exposed.
- **Changed:** `public/lib/dom.js` — `prose()` normalise `\r\n` → `\r\n?` (one line, plus a comment
  explaining why it lives inside prose()). `scripts/verify-bug-109-prose-lone-cr.mjs` (new, real
  browser). `package.json` — `verify:bug-109` script. Commit sha: <filled at commit>.
- **Verified (fixer's own run):**
  - `npm run verify:bug-109` MUST-FAIL against the reverted (`/\r\n/g`) code: **19/23, exit 1** — the
    repro's first code line vanished (`"Heading R1zq7heading const keep = 1; Section R3zq7para…"`,
    R2 sentinel absent), and the four line-ending variants produced non-identical code bodies.
  - `npm run verify:bug-109` against the fix: **23/23, exit 0.** LF/CRLF/lone-CR/mixed all render the
    identical ordered sentinel sequence and identical fenced body; the real transcript path
    (renderMessages) over a mixed-ending reply keeps every region + order; light/dark captures graded
    on their own pixels (luma 233.4 / 8.8, distinct md5). Screenshots:
    `docs/bugs/assets/BUG-109-light.png`, `docs/bugs/assets/BUG-109-dark.png`.
  - Anti-regression: `verify:feat-081` **23/23 exit 0**, `verify:feat-082` **52/52 exit 0**,
    `verify:orchard-transcripts` **15/15 exit 0**, `verify:streaming-md` **9/9 exit 0** (a real prose
    streaming caller), `verify:ui` **7/7 exit 0**. `npm run gate` **PASS exit 0** (leak-gate, check-nul,
    typecheck) — no gate leg is mine to worry about; all green on my tree.
- **Verified-by:** PENDING — clean-room dispatch required (fix touches the shared renderer / content-
  loss class). Suggested attack a fixture cannot self-confirm: truncate a REAL streamed transcript
  containing a CR-adjacent fence at successive byte offsets and render each partial through the live
  streaming path, since prose() re-renders the accumulating buffer every frame.
- **Still open / handoff:** none functional. Independent verify pass is the only gate to VERIFIED.
- **Symptom of a deeper design flaw?** Candidate-yes — this is the same "a line-shaped rule assumed
  `\n`" class recurring across sibling rules in the render module (the neighbouring lane fixed it at
  the boundary; this is the third+ instance of the class). Not filing an ARCH ticket from this fix
  lane; flagging for the orchestrator to weigh whether a single normalise-at-the-untrusted-boundary
  invariant (rather than per-renderer) warrants one.
- **Promoted:** the orchestrator filed that class as **ARCH-006** (line-ending normalisation owned per-renderer; recurrence evidence FEAT-091 + this ticket).
- **Verified-by:** dispatch openai run 01a016a6-a330-7e91-914d-71a46a0d3177 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN — adversarial `lone-cr-overwide-table-row` (run 3901fd8fa36b): a GFM table body row with MORE cells than its header drops the extra cell from reader-visible text (`| H1 | H2 |\r| --- | --- |\r| KEEP-A | KEEP-B | LOST-SENTINEL |` renders as `H1H2KEEP-AKEEP-B`). Fixer test re-run green (run d9f1db23ae9b, 23/23 exit 0). Range verified: synthetic base `0a1cc142` (parent tree with `docs/*` raised to head, so docs are excluded) .. `96e811e`. Untested: successive byte truncations through a genuine model-backed live stream (no authenticated stream in the clean room). NOTE (orchestration, not part of the verdict): the adversarial probe ran no LF control, so it does not establish the loss is line-ending-specific.

### 2026-08-20 — record-correction lane: the status word claimed verification this ticket never got
No code was touched, nothing was re-verified, and no prior entry was edited. This entry records what the ticket's own log establishes and what changed in the header.

- **What the record said.** The status word read VERIFIED while the same line's prose said an independent clean-room verify was still required. The one independent round on this ticket, openai run `01a016a6-a330-7e91-914d-71a46a0d3177`, later returned BROKEN. Nothing on this ticket records a HOLDS.
- **Which case this is.** A stale status word, not an unrecorded later HOLDS. The word was written on the fixer's own run, before the independent round existed; the round that followed did not clear it and nobody updated the header.
- **What is still true about the fix, so the correction is not read as a retraction.** The BROKEN verdict did not refute the lone-CR normalise. The same clean room re-ran the fixer's suite green (23/23, run `d9f1db23ae9b`). The defect it found — a GFM table body row losing its surplus cell — was then shown to fire identically under LF, CRLF and lone CR, so it is a table-rendering defect rather than this one, and it is filed, fixed and independently held as BUG-110 (openai run `01a016b7-064c-7931-8c10-79fee08594ba`, VERDICT: HOLDS). That verdict is on BUG-110's change; it does not transfer to this one.
- **Changed:** the status line only — VERIFIED to FIXED, with the evidence named in it.
- **Still open:** an independent clean-room round that returns HOLDS on this change. The attack this ticket already suggested — truncating a real streamed transcript with a CR-adjacent fence and rendering each prefix — remains untested against a live model stream; BUG-110's section F covers only a synthetic stand-in.
