# BUG-109 — a lone carriage return after a code fence silently ate a whole region of a rendered message

- **Status:** FIXED — prose() now normalises lone CR as well as CRLF, and the fixer's real-browser suite passes 23/23. The one independent clean-room round (openai run `01a016a6`) re-ran that suite green but returned BROKEN on a separate defect, since filed and fixed as BUG-110. No independent round has returned HOLDS on this change, so this is not VERIFIED. (Status word corrected 2026-08-20; it read VERIFIED and predated that round.)
- **Severity:** high — silent content loss in rendered model/file text, on every prose() surface except the transcript
- **Area:** frontend — the shared markdown renderer `prose()` in `public/lib/dom.js`
- **Reported:** 2026-08-18, from a neighbouring lane (FEAT-091 fold work) that hit and fixed the same class at its own entry points but could not reach this one
- **Verification-class:** fix ⟶ independent verification REQUIRED before this moves past VERIFIED

## In plain terms

`prose()` is the one renderer the whole app uses to turn model- and file-provided markdown into
safe DOM: assistant messages, plan cards, agent/notice text, the live streaming buffer, guide pages,
ticket bodies. When it renders a fenced code block it strips the block's first line (the ```` ```js ````
info string). To find where that first line ends it looked for a `\n`.

Text does not always break lines with `\n`. Model output, transcripts and files routinely arrive with
Windows line endings (`\r\n`) or, less often, a bare `\r`. `prose()` collapsed `\r\n` to `\n` before
it looked — but it never handled a **lone `\r`**. So when a lone carriage return sat right after a
fence's info string, the "strip the first line" step could not see it as a line break, ran straight
past it, and deleted everything up to the next real `\n`. In a real render that swallowed **an entire
following region** — content that was in the message simply rendered nowhere at all, with no error and
no gap to hint at what was lost.

The neighbouring lane had already closed this at the transcript's front door (it normalises `\r`, `\r\n`
and `\n` the moment a message enters), so assistant messages were safe. But every **other** caller of
`prose()` hands it text directly with no such normalisation, and each was still exposed.

**What changed.** One line. `prose()` now normalises all three line endings — `\r\n`, a lone `\r`, and
`\n` — to `\n` as its very first act, before any line-shaped rule runs. Fixing it *inside* `prose()`
rather than at each caller means no caller can forget it and no downstream rule can be blind to a line
break. It cannot corrupt any caller: to markdown, all three sequences are the same line ending, and a
`\r` inside a code block renders as whitespace in a browser regardless.

**If you do nothing:** nothing you have to do. Rendered messages that previously dropped a line now keep it.

> Everything below is the technical record — reference, not needed to understand the change above.

## Symptom

Observed in the neighbouring lane's investigation as `R2 TokNNNNz rendered nowhere at all`: a region of
a rendered assistant/plan message was present in the source text but absent from the DOM — no error, no
placeholder. It reproduces whenever a lone `\r` immediately follows a code fence's info string.

## Repro (pre-fix)

Feed `prose()` a message whose fence carries a lone CR after the info string, e.g.:

```
# Heading R1
```js\r<first code line>\nconst keep = 1;\n```

## Section R3
```

`prose()` does `src.split(/```/)`, then for the code chunk runs `chunk.replace(/^[^\n]*\n/, '')` to drop
the info string. With the lone `\r` unnormalised the chunk is `js\r<first code line>\nconst keep = 1;\n`,
so `[^\n]*` matches `js\r<first code line>` and the replace deletes the whole first code line along with
the info string. Rendered text: `Heading R1` `const keep = 1;` `Section R3` — the first code line is gone.

Verified in a real browser: pre-fix `verify:bug-109` renders
`"Heading R1zq7heading` `const keep = 1;` `Section R3zq7para…"` — the `R2zq7codeline` sentinel absent.

## Expected

Every region of the source renders, in source order, under any of LF / CRLF / lone-CR / mixed line
endings within one input, including the first line of a fenced code block.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play: `public/lib/dom.js` — `prose()` line ~306; the fix is the normalise at the
  top (`String(text ?? '').replace(/\r\n?/g, '\n')`, was `/\r\n/g`). The blind rules it protects:
  the fence split `src.split(/```/)`, the info-string strip `chunk.replace(/^[^\n]*\n/, '')`, the
  paragraph split `/\n{2,}/`, and `b.split('\n')`.
- Exposed callers (all reach `prose()` with no upstream normalise, so all were exposed and all are
  fixed by the one change): `question.js:284` (plan cards), `app.js:5570` (agent "ran-out" summary),
  `app.js:7101` (agent thread text), `app.js:2795` + `app.js:2814` (live streaming buffer + finish),
  `app.js:9161`/`9170` (guide markdown), `app.js:10165` (ticket markdown).
- NOT exposed: `dom.js:327` (recursive self-call — text already normalised); every `digest.js` caller
  (all downstream of `renderAssistantText`/`renderBody`/`parseDigest`, which the neighbouring lane
  normalised with the same `/\r\n?/g`). `inlineInto()` is called directly by `decide.js` with un-
  normalised text, but it is NOT a content-loss vector: it appends every byte and never strips a
  "first line", so a lone `\r` there renders as whitespace, not a deletion.
- Related tickets: the neighbouring lane's boundary fix lives in `digest.js` `renderAssistantText`
  (`/\r\n?/g` normalise, header comment names this exact defect); FEAT-081 (prose tables/links);
  FEAT-016 (streaming markdown, a prose caller).
- Repro test: `npm run verify:bug-109` (real brave over CDP; renders the shipped `/lib/dom.js`).
- Known dependencies / blockers: none.

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
