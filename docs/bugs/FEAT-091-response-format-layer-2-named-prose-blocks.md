# FEAT-091 — split a reply into what is addressed to you and what is me narrating

- **Status:** OPEN — spec + enforcement half BUILT (`0354e5b`); renderer half BUILT (`8ab4cb9`). TENTH clean-room verdict was BROKEN, in the WRONGLY-LITERAL direction: a LINK REFERENCE DEFINITION can span LINES (label, destination and title may each sit on their own), so `[ref]:` / `/url` / `===` resolves out of the paragraph to the reference, leaves it OPEN, and keeps the fence LIVE — while a one-line notion of a definition made `===` a setext heading, closed the paragraph, let condition 7 fire, and LOST a well-formed `orchard-notes` fold: `blocks: []`, its narration exposed in the real accessibility tree, and `inert-html:orchard-notes` reported as uncertainty on VALID input. Fixed as the CLASS: the paragraph now carries its accumulated content and definitions are resolved off it by a PORT of the reference's own `parseReference`, at the one place the reference runs it. Every other multi-line construct enumerated and accounted for; no new documented limitation. The randomised differential now generates multi-line constructs (0 hiding / 0 over-recognition / 0 lost at 1,000,000 documents, where round-9 scores 8,930) and its non-vacuity calibration is a TABLE over every prior generation. See the 2026-08-19 TENTH-verdict entry at the foot of this ticket. ELEVENTH clean-room verdict was **HOLDS** with one residual — the randomised fuzz corpus was graded in node only, never rendered, and the theme dimension was unprobed. That residual is now CLOSED and STANDING: the fuzz generator moved into the shared corpus module (proven byte-identical, 80,000 documents), leg **[R]** renders a 20,000-document stratified sample of it per run (measured 0.13 ms/document) graded against the CommonMark reference in BOTH directions and against a real accessibility tree, non-vacuity proven by serving `91b35ab` and `52807b9` parser bytes over CDP interception (F3=53 and F1=1,758 where current scores 0), and leg **[T]** proves a closed fold is closed in PIXELS in both themes. Truncated/partial messages probed for the first time: 169,828 prefixes, 0 violations. Independent clean-room verify still REQUIRED before VERIFIED — this round's leg was written and graded green by the same author, and that is the only thing still blocking it. **ROUND 12 (2026-08-19): the VOCABULARY was replaced.** The two presentation-era names encoded where a passage appears, not what it is, which is why narration kept landing in the visible block. Layer 2 is now six SEMANTIC categories derived from a labelled random sample of 155 real passages — `orchard-finding` / `orchard-outcome` / `orchard-ask` / `orchard-judgment` / `orchard-status` / `orchard-narration` — plus a first-class `orchard-uncategorized <label>` whose label the metrics cluster so the fallback firing NAMES the missing category. Presentation derives from the category (exactly one folds, so the hiding surface did not widen); `orchard-answer`/`orchard-notes` are frozen legacy names and archived transcripts render unchanged. Suites EXTENDED not replaced: the enumerated corpus is graded twice, under both name families (42,564 cases), renderer 201/0 in a real browser, differential 23/0. See the ROUND 12 entry at the foot.
- **Severity:** medium
- **Area:** docs/prompts/RESPONSE_FORMAT.md (the spec), scripts/hooks/response-format-gate.mjs (Stop hook), scripts/lib/response-blocks.mjs + scripts/lib/format-metrics.mjs, src/server/templates.ts (injection), scripts/onboard.mjs (delivery). **Renderer (public/*) is a separate lane — the contract it must build to is below.**
- **Reported:** 2026-08-18 by user
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## In plain terms

Your words: replies "mix things addressed to [you] with running commentary on [my] own process." You want
to glance at a reply and see state, plus anything that needs you. The narration should still exist — it is
how you audit the work — but it should be collapsed, not deleted.

**Why it matters:** the decision is the part only you can act on, and right now it is buried in the middle
of me explaining what I did. Finding it costs you a full read of something that was never for you.

**What this is not:** a whole-response JSON object. You proposed that and hedged, correctly. It was
rejected, and the reasons are written into the spec so nobody re-proposes it: escaping code and markdown
inside JSON strings is brittle, one bad quote destroys the entire message instead of one field, JSON cannot
render until it is complete so the reply stops streaming, and it throws away the property we have today
where a malformed envelope still degrades into readable prose.

**What I need from you:** nothing to unblock the renderer lane. One thing worth knowing: the vocabulary is
deliberately two names, per your "minimal first, expand when we actually hit something that fits nowhere."
Anything that fits neither still renders normally and gets counted, so a missing category shows up as
evidence rather than as lost content.

**If you do nothing:** the spec is already injected into every session and the hook is already recording,
so the metrics start accumulating either way. The visible payoff — narration actually collapsing — needs
the renderer lane.

## The design

Two layers, doing different jobs. Layer 1 is unchanged.

| Layer | Block | Shape | Job |
| --- | --- | --- | --- |
| 1 | `orchard-digest` | JSON | the scannable state summary (FEAT-083/084) |
| 2 | `orchard-answer` / `orchard-notes` | prose | separate what is for the reader from the narration |

Layer 1 stays JSON because it is genuinely structured data and it already works. Layer 2 is prose-shaped
because it holds prose.

### Why exactly two blocks, and what was cut

- **`orchard-answer`** — addressed to the reader: decisions, questions, findings to act on. Justified
  directly by the complaint.
- **`orchard-notes`** — the agent narrating itself. Justified by the same complaint from the other side:
  keep it, collapse it.

**Cut: `orchard-evidence`** (verbatim test/command output). It was designed and dropped. The case for it is
plausible — bulky, occasionally important, currently pasted inline — but plausible is not observed. It
lands in the fallback today, where it is counted and tagged `command-output` / `code-fence` /
`numbers-heavy`. If it really is produced in volume, it becomes a dominant tag signature and gets named
from evidence. **Also cut:** `plan` / `status` / `question` blocks (each is a kind of answer, and splitting
them asks for a judgement call mid-sentence for no reader benefit), and per-block importance (layer 1
already carries it; two mechanisms for one idea drift apart).

Starting too small is recoverable *because the fallback is measured*. Starting too large is not.

### The rules that were ambiguous and are now pinned

- **No blocks at all is legal** and is the expected case for a short reply. No ceremony.
- **But once a message has any block, the reader-facing prose must be wrapped too** — otherwise the
  important part is the only thing left loose.
- **Tiebreak for a passage that is half decision, half narration:** split it. If it genuinely cannot be
  split, it is `orchard-answer`. The asymmetry is deliberate — guessing visible costs a scroll, guessing
  collapsed costs a decision.
- **Repeats and order:** `orchard-answer` / `orchard-notes` may repeat any number of times in any order,
  because a real turn is naturally answer → notes → answer. `orchard-digest` is the exception: once, first.
- **Fences:** open with **4 backticks**, because these blocks routinely contain ```` ```code``` ````. A
  fence closes only on a backtick run at least as long as the opener. Blocks never nest.

---

# Technical detail

## THE RENDERER CONTRACT — build to this, do not reinvent it

The renderer lane must implement exactly the following. The grammar is already implemented, tested, and
written import-free/browser-compatible in `scripts/lib/response-blocks.mjs` specifically so it can be
**moved to `public/lib/response-blocks.js` and imported by the Stop hook from there** — the arrangement
`public/lib/digest.js` already has. Do that rather than writing a second parser: two implementations of a
grammar is how the hook and the UI end up disagreeing about what a message contains.

### Block names and render behaviour

| Info string | Render |
| --- | --- |
| `orchard-digest` | unchanged from FEAT-083. Lifted to the top as the digest summary. |
| `orchard-answer` | **expanded, always.** Rendered as normal markdown prose, visually primary. Never collapsed, never truncated, no "show more". |
| `orchard-notes` | **collapsed by default**, as a one-line affordance the reader can expand in place. Rendered as normal markdown when expanded. Collapse state is per-block. |
| anything else | see fallback, below. |

Parsing rules the renderer must match (all covered by `verify:feat-091`):

- Info string match is **case-insensitive and trimmed**. A trailing `\r` must be stripped before matching —
  a CRLF transcript otherwise yields `orchard-digest\r` and silently misclassifies a compliant reply. This
  bug was live in the first implementation and was caught by the FEAT-085 CRLF adversarial cases.
- Opening fence: 0–3 space indent, ≥3 backticks. Closing fence: ≥ the opener's length, nothing else on the
  line. **A fence inside an already-open fence is literal content** — so a documented ` ```orchard-answer `
  example inside a code block must stay inert. This requires a linear scanner, not a regex sweep.
- Blocks do not nest.

### Fallback rendering — the part that must not be got wrong

**Anything outside a known block is FALLBACK and must render as ordinary prose, exactly as the transcript
renders prose today.** In document order, in place. Not hidden, not collapsed, not styled as an error, not
moved. Content is never lost — that is the property that makes a minimal vocabulary safe.

Specifically:

- **Message with no blocks at all** → renders byte-for-byte as it does today. This must be the visibly
  zero-cost path.
- **Unterminated `orchard-*` fence** → the opener line and everything after it is fallback prose. Not an
  error state, not a dropped message.
- **Unknown `orchard-*` name** → render its **content** as fallback prose. This is the forward-compatibility
  mechanism (below), so it is load-bearing, not an edge case.
- **Malformed `orchard-digest` JSON** → unchanged FEAT-083 behaviour: drop the digest, render the whole
  message as ordinary prose.

### Gating

Both layers ride the **same** `responseDigest.enabled` project flag that the digest renderer already reads,
and the same injected region. `enabled: false` → nothing injected, nothing parsed, plain prose. The single
flag is deliberate: two independent switches would let a project be instructed in one layer and rendered in
the other.

## Extension: adding a third block later

Deliberately starting small makes this path load-bearing, so it is specified rather than assumed:

1. **Every parser and renderer must treat an unknown `orchard-*` name as fallback — visible prose, not
   hidden, not an error.** This is what lets a new block name ship before every reader knows it: an old
   renderer shows the content as prose, a new one styles it. Nothing is lost in the gap.
2. **Old messages keep working.** A new name only adds a case; it never changes how an existing name parses.
3. **Names are frozen once shipped.** Never repurpose `orchard-notes` — add a new name. Renaming silently
   reinterprets every archived message, the one thing rules 1 and 2 cannot absorb.

Adding a block is therefore: add the name to `KNOWN_BLOCKS`, give it a render behaviour, add a line to the
injected core. No migration, no version negotiation.

## The metrics — how to decide a new block is warranted

The Stop hook appends one line per graded turn to `<dataDir>/logs/response-format-metrics.jsonl` (outside
the repo, next to the existing advisory log). **Every** graded turn, not just violating ones — without the
compliant turns there is no denominator and "fallback is rising" is unanswerable.

Each line carries: block counts, total/block/fallback character counts, malformed flags, unknown block
names, and per uncategorized run its **size, position** (`before-blocks` / `between-blocks` /
`after-blocks` / `whole-message`), **shape tags**, and a **capped excerpt**.

Capture policy: a **structured** message (has blocks) keeps the full excerpt — that is the signal, the
author reached for the format and still had something that did not fit. An **unstructured** message keeps
characterisation plus a 240-char snippet, because those are expected and must not fill the disk. Lines are
capped at 24 KB, the file rotates one generation at 8 MB, and every write failure is swallowed.

Read it with:

```
node scripts/lib/format-metrics.mjs report [--file PATH] [--json]
```

**Decision rule (printed by the report itself):** add a block when, over **≥ 50 graded turns**, the fallback
share of characters in **structured** messages stays **above 15%** AND **one tag signature accounts for ≥ a
third** of those runs. Read the largest sampled runs before naming it — the name should come from what the
content actually is, not from the tag.

Two failure modes the rule is shaped against: a high fallback share with *scattered* signatures means the
authors are not using the format, not that a block is missing; a dominant signature at a *low* share means
the shape is real but rare, and a block for it would be ceremony.

Uncategorized prose is **measured, not policed** — it never produces an advisory. The only advisory layer 2
can raise is a structurally broken `orchard-*` fence, because that means content collapsed or expanded
against the author's intent.

## Delivery to every project

`composeInstructions(refs, { responseFormat })` folds the marked region of `docs/prompts/RESPONSE_FORMAT.md`
in last. `RESPONSE_FORMAT.md` is **project-owned, not a methodology mirror** (`scripts/sync-methodology.mjs`
FILES carries only WORKING_AGREEMENT + ROUTING), so it is edited here directly — checked before editing.
`scripts/onboard.mjs` METHOD_FILES now carries `scripts/lib/response-blocks.mjs` and
`scripts/lib/format-metrics.mjs` alongside the hook, so a newly added project gets this with no manual
setup. Verified end to end against a real onboarded scratch project, not by inspecting the copy list.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-18 — worker (spec + enforcement lane)

- **Understood:** replies mix reader-facing content with self-narration; narration should collapse, not
  vanish. Design was pre-decided (named fenced blocks, not whole-response JSON; digest unchanged; fallback
  renders and is counted). Mid-task the user narrowed it further: minimal vocabulary first, expand only on
  observed evidence, which cut the third block and promoted the fallback counter to the load-bearing piece.
- **Changed** (commit `0354e5b`):
  - `docs/prompts/RESPONSE_FORMAT.md` — rewritten as a two-layer spec. Injected core kept to ~2 KB
    (it is paid every turn); the JSON rejection rationale, the cut-blocks justification and the extension
    contract are in the human-only region and are never injected.
  - `scripts/lib/response-blocks.mjs` — NEW. Pure, import-free, browser-compatible linear-scanner grammar.
  - `scripts/lib/format-metrics.mjs` — NEW. Durable JSONL sink + aggregator + `report` CLI.
  - `scripts/hooks/response-format-gate.mjs` — parses layer 2 and records metrics on every graded turn.
    **Still advisory.** New `blockReasons` category so a fence problem is not worded as a digest failure.
  - `src/server/templates.ts` — heading extended, `maxChars` 4000 → 6000 so the larger core is delivered
    whole (a truncated "close the fence" rule would teach the exact failure it warns about). The literal
    `Response Format (orchard-digest)` was preserved inside the heading because the FEAT-084 suite asserts
    on it.
  - `scripts/onboard.mjs` — the two new libs travel with the hook.
- **Verified:**
  - `node scripts/verify-feat-091-response-blocks.mjs` → **TOTAL: 97 passed, 0 failed, exit 0.** Covers the
    grammar (well-formed, 4-backtick block containing ```` ``` ```` code, a fence inside a code block staying
    inert, unterminated fence, unknown name, no blocks at all, repeats, ordering, indented fences, 5
    degenerate inputs), characterisation tags, metrics round-trip, hook end-to-end over real JSONL
    transcripts, injection through the REAL committed doc, and a REAL onboarded scratch project.
  - **Must-FAIL proven twice.** Hook wiring stripped → 11 failures, exit 1. Onboard copy list stripped → 4
    failures, exit 1 (`onboarded project has scripts/lib/response-blocks.mjs`, `…format-metrics.mjs`,
    `the copied grammar is byte-identical`, `the COPIED hook records metrics with zero manual setup`).
  - **Realism, per WA:** the hook is graded over a busy realistic reply (digest + two answer blocks + notes
    + inner code fence + a loose run of verification output), not a minimal fixture. Because the hook reads
    a transcript another process is writing, the real transcript was **truncated at 24 points** (all exit 0,
    zero blocks) and the metrics JSONL at **all 821 byte offsets** (all parse, no throw).
  - **A real bug was caught by the existing suites, not by mine:** CRLF transcripts left `\r` on the info
    string, so `orchard-digest\r` was classified as an unknown reserved name and raised a spurious advisory
    — and would have BLOCKED under `ORCHARD_STOP_HOOK_ENFORCE`. Fixed by stripping the CR before matching;
    `feat-085-adversarial` and `feat-085-independent` returned to green.
  - **Anti-regression:** feat-082 52/0 · feat-083 pass · feat-083-adversarial pass · feat-084 33+/0 ·
    feat-085 pass · feat-085-adversarial 79/0 · feat-085-independent 60/0 · feat-085-readability 32/0 ·
    feat-088 26/0 · onboard 36/0. `npm run typecheck` exit 0. `npm run gate` → **GATE: PASS (exit 0)**,
    read directly, never piped.
  - **feat-089 fails 3 checks — PRE-EXISTING, not caused by this change.** Proven by stashing every file
    this lane touched and re-running: identical `32 passed, 3 failed`. Its `[0] MUST-FAIL` section extracts
    `git show HEAD:scripts/onboard.mjs` and asserts that onboard installs no hook — which stopped being
    true the moment FEAT-089 itself was committed. It is a self-invalidating test, not a regression.
    Handoff below.
- **Verified-by:** _pending._ **An independent clean-room verify pass is warranted** and this ticket should
  not go VERIFIED without one. Bucket: regression-prone. Reasons — (a) the Stop hook has a live history of
  false blocks that cost the user turns (FEAT-085), and this adds a new code path to it; (b) `templates.ts`
  `composeInstructions` builds **every** session's system prompt, so a perturbation there touches every
  session; (c) the CRLF bug shows my own fixture encoded my assumptions and only someone else's attack
  surfaced it. Suggested attack angles my fixture does not cover: tab-indented and Unicode-whitespace
  fences, `~~~` fences, an info string with trailing attributes (```` ```orchard-answer {.foo} ````), a
  block opened with 5+ backticks closed by 4, an `orchard-` prefixed name that is a prefix of a known one
  (`orchard-answers`), a 10 MB reply, and a message where the digest is NOT first.
- **Still open / handoff:**
  1. **Renderer lane** (`public/*`) — build to "THE RENDERER CONTRACT" above. Preferred first move: move
     `scripts/lib/response-blocks.mjs` to `public/lib/response-blocks.js` and repoint the hook's import at
     it, mirroring `public/lib/digest.js`, so there is exactly one grammar.
  2. **feat-089's stale must-FAIL** needs its own fix — it should pin the pre-fix onboard to a specific sha
     (or a committed fixture) instead of `HEAD`, which now contains the very change it asserts is absent.
     Not touched here: different lane, and it is not a regression from this work.
  3. **Nothing consumes the metrics yet.** After ~50 graded turns, run
     `node scripts/lib/format-metrics.mjs report` and apply the decision rule above before anyone proposes
     a third block.
- **Symptom of a deeper design flaw?** Not closing yet, so not final. Provisional: no — but worth a note
  that this is the third feature (FEAT-083, FEAT-084, FEAT-091) layering onto one response-format
  convention with the render half and the enforcement half in separate files that must agree. The single
  shared grammar module and the single `responseDigest.enabled` flag are the mitigations; if a fourth layer
  arrives and they drift, that is an ARCH ticket.

### 2026-08-18 — worker (renderer lane)

- **Built THE RENDERER CONTRACT** (this commit) rather than reinventing it. The move the contract endorsed
  is done: `scripts/lib/response-blocks.mjs` → **`public/lib/response-blocks.js`** (git-tracked rename,
  history preserved), and the Stop hook now imports it from `../../public/lib/response-blocks.js`, mirroring
  `public/lib/digest.js`. There is now exactly ONE grammar the hook and the browser share.
- **Renderer** lives in `public/lib/digest.js` — `renderAssistantText` extended, the transcript's existing
  entry point (`assistantProse` in `public/app.js`), so no call-site change:
  - `orchard-answer` → expanded prose, visually primary (undecorated: it IS the primary content, and the
    glance works because notes recedes, not because answer shouts).
  - `orchard-notes` → a native `<details>` **collapsed by default, per-block state** (the contract pins
    per-block; a native `<details>` gives independent per-instance open state, keyboard + SR support, and
    no global-preference plumbing — expanding one turn's notes never expands another's, and an
    already-open block stays open as new messages arrive because each is its own DOM node). A **notes-only**
    turn renders its labelled fold, so a pure-narration turn collapses to a visible "a turn happened" line
    rather than vanishing.
  - Fallback / unknown-block content → ordinary prose, **in document order** (blocks + fallback runs merged
    by source line), in place, never hidden, never dropped.
  - **No blocks at all → byte-for-byte the old `prose(text)`** (guarded on `!blocks && !unknownBlocks`), so a
    plain short reply gains zero ceremony. Same guard covers unterminated fence, fence-inside-code, and
    lone-unterminated-`orchard-*` — all degrade to whole-message prose.
  - **Malformed leading digest JSON → whole message as prose** (unchanged FEAT-083), detected by
    `leadingDigestBlock()` after `parseDigest()` returns null, before any layer-2 rendering.
  - Gating rides the same `responseDigest.enabled` flag: disabled → `prose(text)`, no parse.
- **Styles** (`public/styles.css`): `.orchard-answer` (rhythm only) + `.orchard-notes` fold (hairline,
  quiet, quieter narration ink), themed purely through existing tokens so light/dark need no per-block
  override.
- **Verified — real brave headless over CDP** (`scripts/verify-feat-091-renderer.mjs`, NEW). Imports the
  app's OWN `renderAssistantText` and asserts on produced DOM, then captures the visual gate. **51 passed,
  0 failed, exit 0.** Functional: FULL busy reply (digest+answer+notes-with-inner-```code```+answer+loose
  fallback) → correct doc order digest→answer→notes→answer→fallback, notes collapsed-by-default and
  expandable, inner code survives 4-backtick block, fallback never dropped; notes-only shows the fold;
  unterminated fence → prose with the buried ask intact; fence-in-code stays inert; CRLF classifies (no
  `\r` misclass); malformed digest → whole message prose. **Visual gate:** collapsed/expanded/free/
  notes-only/malformed × {wide 900, narrow 420} × {light, dark} = 20 shots, each graded by
  `scripts/lib/shot-luma.mjs` (light >150 / dark <90, no byte-identical twins) AND **looked at** — theme via
  CDP `prefers-color-scheme` emulation with `data-theme` cleared, never localStorage.
- **Anti-regression** (all exit 0): feat-091 97/0, feat-082 52/0, feat-083 22/22, feat-083-adversarial HOLDS,
  feat-084 37/0, feat-085 58/58, feat-085-adversarial HOLDS, feat-085-independent 60/0, feat-085-readability
  32/0, feat-088 26/0, feat-089 **35/0** (fixed, below), orchard-transcripts 15/0, bug-067 17/17,
  streaming-md 9/9, onboard 36/0. `npm run typecheck` exit 0. `npm run gate` → **GATE: PASS (exit 0)**, read
  directly, never piped.
- **feat-089's stale must-FAIL (handoff item 2) — FIXED.** Confirmed the 3 failures were exactly the `[0]`
  MUST-FAIL asserts (`git show HEAD:scripts/onboard.mjs` install-nothing), stashed nothing else. Re-anchored
  to a **pinned pre-fix sha `df2362a`** ("Orchard initial public release", the commit before FEAT-089 landed
  `359b7af`) — a fixed baseline, per `docs/CONVENTIONS.md` "A must-FAIL proof must not be anchored to a
  moving baseline". Added a loud guard: the extracted source is asserted to carry no hook/gate install (a
  future rebase moving the sha onto a post-fix commit fails LOUDLY, not vacuously), and an unavailable
  baseline now records a failure instead of silently skipping. `regressed-from: FEAT-089` (its own must-FAIL
  self-invalidated when it was committed).
- **Cross-lane edits the sanctioned move NECESSITATED (flagged honestly).** The move breaks two references
  outside the named renderer lane; leaving them broken would regress delivery AND redden a required
  anti-regression, so both were updated minimally and are called out here:
  - `scripts/onboard.mjs` METHOD_FILES: `scripts/lib/response-blocks.mjs` → `public/lib/response-blocks.js`
    (else a newly-onboarded project's hook can't find its grammar; the import is swallowed and metrics are
    silently lost — the exact failure the ticket warns against). Verified by `verify:onboard` + `feat-089`.
  - `scripts/verify-feat-091-response-blocks.mjs`: three path references (direct import + the byte-identical
    onboarded-copy check) repointed to `public/lib/response-blocks.js` (else the 97-check suite goes red on
    the move alone). Now 97/0.
  Neither file was modified by another live lane at the time. No `src/server/*`, no `RESPONSE_FORMAT.md`, no
  `format-metrics.mjs` touched.
- **Verified-by:** dispatch openai run 01a0165f-d558-7a32-8c4b-46ddab42d27f (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN
  (range `6e210eb`..`ac8d033` — synthetic base = tree of `ac8d033^` with `ac8d033`'s `docs/` grafted on, so
  the diff is exactly the 7 non-docs files, 42728 bytes, untruncated. Adversarial case
  `valid-block-then-unterminated-fence`, run `fa7cc55ed549`, real brave/CDP against the app's own
  `renderAssistantText`.)
- **Verified-by (prior note):** _pending._ Independent clean-room verify still warranted (bucket: regression-prone — the
  Stop-hook path has a live history of false blocks, and the transcript renderer is what every project runs).
  Attack angles the self-suite does not cover: a real archived transcript replayed through the renderer at
  several TRUNCATION points (the renderer reads model text another process streams — grade partial reads);
  an `orchard-notes` block whose content is itself a malformed table / a lone 4-backtick run; a 10 MB reply;
  answer/notes interleaved 6+ times; RTL / Unicode-whitespace inside a fold summary.

## 2026-08-18 — the BROKEN verdict resolved: the REQUIREMENT was wrong, and a real hiding bug found next to it

**Verdict on the clean-room BROKEN: upheld as a correct reading, rejected as a defect.** The failing case was
`valid-block-then-unterminated-fence` — a well-formed `orchard-answer` (VISIBLE-FIRST) followed by an
unterminated `orchard-notes` (VISIBLE-SECOND). Both strings rendered, both readable; the complaint was that
the *preceding valid block* kept its block rendering instead of the whole message collapsing to prose. The
verifier applied the contract as written and was right to. **The wording was the defect.** "Malformed input
degrades to plain prose — the whole message must remain readable" was meant as *never lose content, never
mislead*; discarding a good block because something LATER is malformed serves neither goal — it loses
structure while the content was never at risk, and it throws away the blast-radius containment that is the
stated reason fences were chosen over whole-response JSON.

**Spec amended** (`docs/prompts/RESPONSE_FORMAT.md`, `### Malformed input` rewritten as four numbered
guarantees): (1) no content ever lost or hidden, (2) document order preserved, (3) a malformed region
degrades to prose while well-formed blocks before or after it KEEP their rendering — degradation is LOCAL,
(4) only a message that cannot be parsed at all renders wholly as prose. The rendering was NOT changed to
satisfy the old wording. The stale `scripts/lib/response-blocks.mjs` pointer in the extension section was
also corrected to `public/lib/response-blocks.js` and now states the one-module rule explicitly.

**Does partial degradation MISLEAD? Answered honestly, and it did — one input, now fixed.**
- The expected direction is safe: an unterminated `orchard-notes` renders its narration *expanded* instead of
  collapsed. Confirmed on the real renderer. That is noise, not loss, and it is the safer error (guessing
  visible costs a scroll; guessing collapsed costs a decision).
- **But there WAS an input where content landed in the wrong block, hidden.** Pre-fix,
  ` ````orchard-notes ` (unclosed) followed by a well-formed ` ````orchard-answer ` parsed as ONE notes block:
  the answer's own trailing fence closed the *notes*, so the reader's decision rendered **inside the collapsed
  fold** — invisible without a click — and `malformed` was **empty**, so the Stop hook reported nothing. That
  is data-hiding plus a silent metric. Real-browser must-FAIL captured before the fix: `DECISION-TWO is
  VISIBLE without expanding anything` FAIL, `the decision is NOT inside the notes fold` FAIL, 5 failures total.
- **Fixed in the shared grammar** (`public/lib/response-blocks.js`): a COLLAPSED block whose body contains a
  top-level `orchard-*` opener for a non-collapsed name is treated as **missing its close** — it ends there,
  the inner block parses normally, and the turn is flagged `missing-close:<name>@lineN`. The scan is
  nesting-aware, so an opener inside an ordinary ```code``` fence in the notes body stays inert and a
  documented example is not split. The MIRROR case (a visible block swallowing a `notes` opener) keeps its
  content visible and in order, so restructuring it is the only thing that could hide it: it is *reported*
  (`nested-opener:<name>@lineN`) and deliberately left alone. Rule: **degradation may only ever move content
  toward visible.**

**The attack nobody had run: renderer ⇄ Stop-hook divergence.** New section `[P]` in
`scripts/verify-feat-091-renderer.mjs`, a 13-message adversarial corpus with per-region `TKnn` tokens so
*content attribution* is asserted, not just counts. Corpus covers everything the verifier listed as untested:
notes containing a malformed table, fence markers inside a block's own content, unknown + empty block names,
ordering of uncategorized prose (before/between/after), six interleaved blocks, very large content (~100 KB),
Unicode whitespace in a block name (NBSP / figure space / ZWSP), CRLF, plus the three corrected-contract
cases and the malformed-leading-digest rule-4 case. Three assertions per message:
- **parse parity** — the module imported by the HOOK'S OWN specifier (`../../public/lib/response-blocks.js`,
  resolved from `scripts/hooks/`) vs the module the BROWSER imports from `/lib/response-blocks.js`: normalised
  parses must be identical (one normaliser source, evaluated on both sides, so the comparison cannot drift).
- **hook PROCESS record == browser parse** — the REAL Stop hook run as a child over a real transcript per
  message; its metrics JSONL record (shape/counts/malformed/unknown/chars/run positions+tags) must equal what
  the browser parsed. Display and metrics literally cannot tell different stories.
- **DOM attribution** — every token appears exactly once, in document order, in the region the parser says it
  is in, and *nothing is folded away except content the author put in `orchard-notes`*.
**Module identity proven at RUNTIME**, not assumed: the hook's import specifier is read from its source, its
resolved realpath is asserted equal to the file the server serves, the sha256 of the bytes the browser
`fetch`es equals the sha256 on disk, and `git ls-files` is asserted to track exactly ONE grammar module. A
copy that drifts would fail all four.

**Fold accessibility proven, not inferred** (section `[K]`, the "affordance that could never fire" lesson):
real CDP key events — Tab traversal from `document.body` lands on the summary after 21 tabs, ENTER opens it,
the body then has real client rects, SPACE closes it; and a real accessibility-tree read (not markup):
role `DisclosureTriangle`, non-ignored, accessible name "NOTES internal narration", `expanded=false` announced
when closed and `true` when open, and the narration is ABSENT from the non-ignored AX tree while folded and
PRESENT once open.

**Numbers, as printed.**
- `node scripts/verify-feat-091-renderer.mjs` → **VERDICT: PASS — 148 passed, 0 failed, exit 0** (adds the
  `localdegrade` visual scene; 24 luma-graded shots across wide/narrow × light/dark, images reviewed).
- `npm run verify:feat-091` → **TOTAL: 110 passed, 0 failed, exit 0** (was 97; +13 in new section `[1b]`).
- MUST-FAIL, grammar reverted to `HEAD`: node suite **104 passed, 6 failed, exit 1**; renderer suite
  **139 passed, 5 failed, exit 1**. Honest limitation: the parity/attribution checks did NOT go red pre-fix —
  both consumers share one module, so they agreed *while both were wrong*. Parity catches drift; only the
  contract tests in `[I]`/`[1b]` catch a shared-grammar bug. Both kinds are needed.
- Anti-regressions, all exit 0: `feat-082` 52/0, `feat-083` 22/22, `feat-083-adversarial` contract HOLDS,
  `feat-084` 37/0, `feat-085` 58/58, `feat-085-adversarial` contract HOLDS, `feat-085-independent` 60/0,
  `feat-085-readability` 32/0, `orchard-transcripts` 15/0. `npm run gate` → **GATE: PASS (exit 0)**, read
  unpiped.
- `regressed-from: FEAT-091` (the original renderer/grammar commit `ac8d033` shipped the notes-swallow bug).
- **Bucket: regression-prone + data-hiding.** An independent clean-room verify pass is still warranted on THIS
  change — generation must not be its own only verifier, and the last verdict on this ticket was BROKEN.
  Untested by me: a real archived transcript replayed at TRUNCATION points through the renderer (the
  streaming/partial-read angle from the prior note is still open), and RTL text inside a fold summary.

- **Verified-by:** dispatch openai run 01a01671-5827-7eb1-9727-00eb555562be (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

---

## 2026-08-18 — the SECOND hidden-content defect, and closing the class instead of the case

`regressed-from: FEAT-091` (this ticket's own prior fix, commit `8ab4cb9`, handled the demonstrated shape
only). Independent clean-room pass returned **BROKEN** with this input:

    `````orchard-notes
    OUTER-NOTES
    ````orchard-notes
    INNER-NOTES
    ````orchard-answer
    SECRET-ANSWER
    ````
    `````

**must-FAIL, reproduced against the real tree before touching anything** (the clean room's own
`scratch-adversarial.mjs`, real server + real brave over CDP, exit 1):

    parserBlocks: [["orchard-notes","OUTER-NOTES\n````orchard-notes\nINNER-NOTES\n````orchard-answer\nSECRET-ANSWER\n````"]]
    malformed: []   fallback: []
    browserDOM: {details:true, open:false, answerCount:0, secretInClosedNotes:true}
    closedAccessibilityTreeHasSecret: false

Same failure as the first defect with one more layer of nesting: a same-type nested `orchard-notes` opener
made the previous fix's nesting scan treat the remainder as opaque, so an authored `orchard-answer` rendered
as no answer at all — inside the CLOSED fold, absent from the accessibility tree — and both consumers agreed
because both read one grammar that reported nothing malformed and nothing uncategorised.

### The rule is now structural, not a branch

Prior fixes made "degradation may only move content toward visible" a property of particular branches. It is
now an invariant of the parse. The observation that makes it cheap: **`orchard-notes` is the only construct in
this grammar that can make content invisible** — every other outcome (block, fallback run, unknown name,
unterminated fence, plain code fence) renders expanded, and on the renderer side `renderNotes()` is reached
from exactly one branch. So there is ONE gate, and it now carries a certainty guard:

- **C1** — no line in a fold body is a reserved (`orchard-*`) opening fence.
- **C2** — for every backtick-run length, the count of fence lines of that exact length in the body is EVEN
  (every inner fence visibly pairs off, so no inner fence could have been meant as this fold's close).
- Otherwise the fold ends at the offending line, everything from there is re-parsed at top level, and the turn
  is flagged **`ambiguous-fold:<name>@lineN(<reason>@lineM)`**. The retained prefix is re-checked to a fixed
  point, so a cut that merely moves the ambiguity earlier is rejected.

Both are **depth-free** — C1 is a per-line predicate, C2 is a tally. The module no longer contains a
"skip to the close of the inner fence" scan anywhere: the class of defect was a depth-tracking mistake, and
there is now no depth tracking to get wrong.

**Unrepresentable** (not merely handled): any `orchard-*` opener, at any nesting depth, in any order, at any
fence length, ending up inside a collapsed fold; and any fold whose own close is in doubt because an inner
fence is unpaired. **Cost, stated plainly:** a documented `orchard-*` fence written *inside* notes is now
promoted to visible and flagged rather than staying folded — the correct direction, with a depth-free escape
hatch (indent 4+ spaces, which is not a CommonMark fence opener at all, or use `orchard-answer`).
**Irreducible ambiguity, named:** a bare ` ``` ` run inside a 4-backtick fold is character-for-character both
the recommended code-fence usage and a mistyped close; nothing in the text separates them and any rule that
tried would be depth reasoning again. C2 fails it toward visible-and-reported only when it is *unpaired*, so
the recommended pattern keeps working.

Two hand-written contract tests were REVERSED, because each encoded the assumption that produced this bug:
"a documented example inside a code fence in notes does NOT split the fold" and "a notes opener inside notes
is inert". Both now assert promotion-to-visible plus a report, and a new test pins the 4-space escape hatch.
`missing-close:` is renamed `ambiguous-fold:` (one reason code, since placement is now uniform).

### The generated property suite — the deliverable that ends the class

`scripts/lib/feat-091-fold-corpus.mjs` enumerates the space rather than sampling it: every block name
(collapsed / visible / digest / unknown-reserved / plain-with-info / bare) × fence length 3-5 ×
opened/closed × nesting depth 1-3 × ordering, each region a unique token, with the oracle taken from the
authored TREE (a token's innermost reserved ancestor decides whether it may be folded — so an
`orchard-answer` authored *inside* notes must still be visible, which is exactly the defect). Both verifiers
drive the SAME cases, so a property holding in node and failing in the browser cannot hide.
**7166 cases** — `{depth1:36, depth2:1296, depth3:5832, reported:2}`, 57 well-formed, 1649 producing a fold —
plus both REAL reported inputs verbatim. Invariants: I1 nothing authored outside notes is ever folded;
I2 every region appears exactly once in authored order; I3 every deviation is reported as malformed or
uncategorised AND a well-formed input is flagged nothing (anti-vacuity — a parser that flagged everything
would fail, not pass).

**Calibration (the suite is not vacuous):** run against the PREVIOUS parser the same corpus fails
**333 cases on I1** — 333 distinct hidden-content shapes, of which exactly one had ever been reported — and
the renderer leg goes red with **49 must-be-visible regions missing from the real accessibility tree**.
Full must-FAIL with the grammar reverted to `HEAD`: node suite **111 passed, 13 failed, exit 1**; renderer
suite **VERDICT: FAIL — 152 passed, 2 failed, exit 1** (both failures in the new `[Q]` leg). Against the
fixed parser: 0 and 0.

### Numbers, as printed

- `npm run verify:feat-091` → **TOTAL: 124 passed, 0 failed, 0 skipped, exit 0** (was 110). New `[1c]`:
  `corpus: 7166 cases {"depth1":36,"depth2":1296,"depth3":5832,"reported":2}; 57 well-formed; 1649 render a fold`.
- `node scripts/verify-feat-091-renderer.mjs` → **VERDICT: PASS — 154 passed, 0 failed, exit 0** (was 148).
  New `[Q]`: `rendered 4538 generated cases (of 7166 enumerated); 1649 produced a closed fold`, graded on
  rendered TEXT and a real `Accessibility.getFullAXTree` over 184 fold-bearing cases — never on DOM structure,
  because content inside a closed fold is present in the markup and absent to the reader, which is how both
  defects passed their suites.
- The clean room's own `scratch-adversarial.mjs`, unchanged, now exits **0**:
  `answerCount:1, secretInClosedNotes:false, closedAccessibilityTreeHasSecret:true`.
- Anti-regressions, all exit 0: `feat-082` 52/0, `feat-083` 22/22, `feat-083-adversarial` contract HOLDS,
  `feat-084` 37/0, `feat-085` 58/58, `feat-085-adversarial` contract HOLDS, `feat-085-independent` 60/0,
  `feat-085-readability` 32/0, `orchard-transcripts` 15/0. `npm run gate` → **GATE: PASS (exit 0)**, read
  unpiped (leak-gate PASS, check-nul PASS, typecheck PASS — no other lane's legs were failing at this run).

### Two clean-room environment artifacts fixed (they made the last pass noisier than it needed to be)

- `verify-feat-091-renderer.mjs` proved "exactly ONE grammar module" via `git ls-files`, which fails in a
  git-less export. It now prefers git and falls back to a filesystem walk, stating which it used.
- `verify-feat-091-response-blocks.mjs` crashed at `[5]` because a clean room strips
  `docs/prompts/RESPONSE_FORMAT.md` as contamination. It now SKIPs with the reason stated, and skips are
  counted in the TOTAL so they cannot quietly hollow out the suite.
- Both proven in a real git-less / doc-less hardlink copy of the tree: renderer **154 passed, 0 failed,
  exit 0** with `via filesystem walk — no usable git in this tree`; parser suite **111 passed, 0 failed,
  1 skipped, exit 0**.

### Bucket and honest limits

**Regression-prone + data-hiding — an independent clean-room verify pass is warranted**, and this is the
second BROKEN verdict on this ticket, so generation must emphatically not be its own only verifier. Suggested
attack for that pass: the enumeration stops at depth 3 and at fence lengths 3-5, and it does not vary indent
(0-3 spaces) or CRLF *inside* generated cases — those are covered only by the hand-written cases. Also
untested by me, still: a real archived transcript replayed at TRUNCATION points through the renderer, and RTL
text inside a fold summary.

- **Verified-by:** dispatch openai run 01a0168c-8f17-78a3-a991-2012c3ccea35 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN
  (range `0e105dd`..`31acb24` — synthetic base = tree of `31acb24^` with `31acb24`'s `docs/` grafted on, so
  the diff is exactly the 5 non-docs files, 48535 bytes, untruncated. Fixer test `node
  scripts/verify-feat-091-renderer.mjs` re-run, exit 0, run `f373ae164f00`. Adversarial case
  `longer-commonmark-inner-closer`, run `a73909a81ec2`, exit 1: a 3-backtick code fence closed by 4 backticks
  inside a 6-backtick `orchard-notes` fence — well-formed CommonMark — is FALSELY reported
  `ambiguous-fold:orchard-notes@line1(unpaired-fence-in-fold@line3)` by C2's even-count-per-exact-length
  tally, and the fold is truncated so authored notes content is ejected into visible fallback. Nothing hidden,
  nothing lost, order preserved; the breaches are guarantee (3) false-positive on well-formed input and a
  wrong fold extent.)

---

## 2026-08-18 — third clean-room verdict: BROKEN. Both defects were the same root: rules that did not match how the input is structured

`regressed-from: FEAT-091` (this ticket's own round-2 fix, commit `31acb24` — its certainty guard was correct
about nesting and wrong about lines and about fence pairing).

The independent pass found two defects, and they are not two bugs. Both are the parser reasoning about
"lines" and "fences" with rules that do not match how the input is actually structured, so both were fixed
as a class rather than patched:

**DEFECT 1 (severe — content genuinely hidden).** `lone-cr-reserved-opener`: inside a 4-backtick
`orchard-notes` body, a nested `orchard-answer` opener separated by a **lone CR** rather than LF. C1 was a
per-LF-line predicate, so the whole reserved opener sat mid-"line" and was structurally invisible to it; both
certainty predicates passed; `MUST-SEE-DECISION` rendered **inside the closed fold, absent from innerText and
from the real accessibility tree**, with an empty malformed list. Same hiding class as rounds 1 and 2,
reached through line-splitting instead of nesting depth.

**DEFECT 2 (false flag + wrong fold extent, on legal input).** A 6-backtick notes fence containing a
3-backtick ` ```js ` fence closed by **4** backticks — legal CommonMark, a closing fence may be longer than
its opener. The C2 parity tally counted a 3-run and a 4-run as two unpaired lengths, so well-formed input was
flagged `ambiguous-fold` and the fold was cut early, ejecting authored notes content into the visible region.
Nothing lost, order held — but a false positive on legal input trains the reader to ignore the flag, which
destroys the flag's value.

### The fix, as a class

- **Line endings are normalised ONCE, at the boundary.** `parseResponseBlocks` replaces `\r\n` and lone `\r`
  with `\n` before any rule runs, so no predicate below can be blind to a break; the per-line trailing-`\r`
  strip it replaces is gone. Those three are CommonMark's line endings and nothing else is one, so
  U+2028/U+2029 and form feed cannot carry a fence past a predicate (tested, `sep/*` cases).
- **C2 is now CommonMark's real pairing rule, not a heuristic:** a fence closes on a run of the same
  character, **at least as long** as its opener. Because fences do not nest, checking it is a two-state
  automaton (outside / inside-exactly-one-fence), not a depth counter — **no depth scanning was
  reintroduced**, and C1 remains a strict per-line predicate over every body line at any depth. The
  visible-bias invariant and "a fold can never hide content the author did not put there" are unchanged.
- **A THIRD instance of the same root, found by the new corpus and fixed in the render half.** With the
  parser fixed, 2 renderer checks still failed: `prose()` (public/lib/dom.js) splits on backtick runs and
  strips a code chunk's first line as its info string, so a lone CR just after a fence run silently ATE the
  next region — `R2 TokNNNNz rendered nowhere at all`. Fixed at the same kind of boundary:
  `renderAssistantText` / `renderBody` / `parseDigest` normalise line endings on entry. The residual
  lone-CR weakness in `prose()` itself affects other callers (plan cards, notices) and is **out of this
  lane** — worth its own ticket.

### The corpus, which is the deliverable that stops the next round

The generated suite was good and missed both defects because it did not vary the dimensions they live in:
every case was LF-separated, unindented, closed by a run of exactly the opener's width, at most 3 deep, at
most 5 backticks wide. It now varies all of them.

**7,166 cases → 10,715 cases**
`{depth1:36, depth2:1296, depth3:5832, eol:2385, indent:144, closelen:124, depth4:729, depth5:108,
longrun:54, separator:3, reported:4}`; line endings `{lf:8329, crlf:795, cr:796, mixed:795}`; **209
well-formed**; 2,875 produce a real fold.

- **line endings** LF / CRLF / lone CR / **mixed within one message** — the same document under all four, so
  tokens, well-formedness and expected blocks are identical, which is exactly the assertion.
- **indentation** of openers AND closers, independently: 0-3 spaces (a fence) and tab / space+tab (**not** a
  fence — a tab is a 4-column stop, so the oracle marks those nodes inert, and parser and renderer must agree).
- **closing fences longer than their openers** (+0/+1/+2), sweeping both the legal side and the side where
  the inner close would also close the fold; plus closes SHORTER than their opener.
- **depth 4 and depth 5**; **fence runs of 6-8 backticks** (and a 9-backtick fold).
- **non-line-ending separators** U+2028 / U+2029 / form feed.
- both round-3 defect inputs verbatim in `reportedDefectCases()`, and every reported input is now forced
  into the browser's accessibility-tree read rather than left to a stride sample.
- **new invariant I4 — well-formed input must report NOTHING**, asserted across the whole 209-case
  well-formed subset (this is the invariant defect 2 violated).

**Anti-vacuity calibration, re-stated against the extended corpus:**

| parser | failing cases | I1 (hidden content) | I2 | I3 | well-formed cases falsely flagged |
|---|---|---|---|---|---|
| `31acb24^` (pre-FEAT-091) | 610 | 650 | 54 | 16 | 1 |
| `31acb24` (round-2 fix, the parser attacked) | 134 | 61 | 54 | 63 | **28** |
| current | **0** | **0** | **0** | **0** | **0** |

Every one of round-2's 61 remaining I1 hidden-content violations is reached through line endings — the
dimension the old corpus did not vary.

### Verification (numbers as printed)

- **must-FAIL, defect 1, in a REAL browser with a real accessibility-tree read.** Worktree at `31acb24` with
  only the new corpus + renderer verifier copied in: `node scripts/verify-feat-091-renderer.mjs` →
  **VERDICT: FAIL — 150 passed, 4 failed**, exit 1. `R1 Tok141z rendered inside a CLOSED fold`,
  `R1 Tok141z missing from the visible render`, `R2 Tok112z rendered nowhere at all`,
  `AX axMissing:5 — Tok211z not in AX tree`, `AX axLeaked:1`.
- **must-FAIL, defect 2, at parser level.** The verifier's own preserved script
  (`/tmp/cleanroom-verify-PKuY7Q/scratch-adversarial.mjs`) against `31acb24`: **exit 1**, with
  `malformed:["ambiguous-fold:orchard-notes@line1(unpaired-fence-in-fold@line3)"]` and the notes body cut to
  `AUTHORED-NOTES-BEFORE`. Against the fixed parser: **exit 0**, `malformed: []`, one `orchard-notes` block
  holding the whole authored body, `VISIBLE-TAIL` still in fallback.
- **must-FAIL, defect 1, at parser level** (`31acb24`): `malformed: []`,
  `DECISION_inside_closed_fold: true`, `DECISION_visible: false`. Fixed: the answer is promoted to a visible
  `orchard-answer` and the turn is flagged `ambiguous-fold:orchard-notes@line1(reserved-opener-in-fold@line3)`.
- **intermediate must-FAIL for the render-half instance:** parser fixed, `digest.js` not yet — renderer
  **152 passed, 2 failed** (R1/R2), which is what exposed `prose()`.
- **after both fixes:** `verify:feat-091` **TOTAL: 140 passed, 0 failed, 0 skipped** (exit 0);
  `verify-feat-091-renderer.mjs` **VERDICT: PASS — 154 passed, 0 failed** (exit 0), 7,404 corpus cases
  rendered in the real browser, 2,875 producing closed folds, AX read over **210** risky cases (all 4
  reported inputs forced in), `axMissing: 0`, `axLeaked: 0`.
- **anti-regressions, all exit 0:** `feat-082` 52/0 · `feat-083` 22/22 · `feat-083-adversarial` contract
  HOLDS · `feat-084` 37/0 · `feat-085` 58/58 · `feat-085-adversarial` contract HOLDS ·
  `feat-085-independent` 60/0 · `feat-085-readability` 32/0 · `orchard-transcripts` 15/0 ·
  `bug-087-stale-transcript` 6/6.

### Bucket and honest limits

**Data-hiding + regression-prone (three BROKEN verdicts in a row on this grammar) — an independent
clean-room verify pass is REQUIRED, not optional.** Suggested attack for that pass, i.e. what I did NOT
test: `prose()`'s own lone-CR info-string strip for its OTHER callers (out of lane here, and it ate content
in a real render); tilde (`~~~`) fences, which CommonMark supports and this grammar ignores entirely; a real
archived transcript replayed at TRUNCATION points through the renderer; RTL text and combining marks inside a
fold summary; and the interaction of the fold guard with a genuinely enormous message (the corpus cases are
small).

- **Verified-by:** dispatch openai run 01a0169e-4e37-7872-8204-144fd1d5f499 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN
  (range `3f9566ba`..`3851f04` — synthetic base = tree of `3851f04^` with `3851f04`'s `docs/` grafted on, so
  the diff is exactly the 5 non-docs files, 43434 bytes, untruncated. Fixer test `node
  scripts/verify-feat-091-response-blocks.mjs` re-run, exit 0, 127 passed / 0 failed / 1 skipped, run
  `5956815d6336`. Adversarial case `tilde-fenced-literal-notes-example`, run `a779f21d76aa`, exit 1:
  a literal 4-backtick `orchard-notes` example placed inside a CommonMark **tilde** (`~~~markdown`) code
  fence — a fence syntax this grammar does not model at all — is parsed as a REAL notes block. In a real
  Brave render the token `MUST-BE-READER-VISIBLE` is in the DOM but inside a `<details>` with `open === false`,
  absent from the visible text and absent from the real CDP full accessibility tree (`axHasToken: false`);
  the shared counter reports `blocks: ['orchard-notes']`, `malformed: []`, `fallbackChars: 14`. So: content the
  author did NOT put in a notes block is **HIDDEN** (guarantee 1), and the counter **MIS-REPORTS** it as
  categorised notes with no uncertainty flag (guarantee 4). Nothing lost or misordered; no false flag.
  Could not test, stated by the verifier: the RESPONSE_FORMAT injection path (clean room strips `docs/`, so
  the fixer test's own `[5] injection` case degrades to a stated skip — expected environment behaviour) and an
  archived-transcript truncation replay (no real transcript available in the clean room). Also still untested
  this round: RTL/combining marks in a fold summary, and a very large message.)


---

## 2026-08-19 — ROUND 4: the inert-region class, enumerated instead of discovered

**regressed-from:** `3851f04` (round 3) — and the round-3 entry above NAMED this exact gap in its own
honest-limits list ("tilde (`~~~`) fences, which CommonMark supports and this grammar ignores entirely").
It was written down as untested and then shipped untested. That is the thing to change, not just the regex.

### The defect, and why it is the same one four times

The clean-room input, character for character:

    ~~~markdown
    ````orchard-notes
    MUST-BE-READER-VISIBLE
    ````
    ~~~

A notes example quoted inside a CommonMark **tilde** code fence. The grammar's fence regexes said backtick,
so the outer fence did not exist to it, and the inner one became a genuine `orchard-notes` block. In a real
Brave render: `details: true, open: false`, the token present in `textContent` but absent from the visible
text and absent from the real CDP accessibility tree (`axHasToken: false`), while the shared counter
reported `blocks: ['orchard-notes'], malformed: [], fallbackChars: 14`. Hidden content **and** silently
mis-counted — both consumers agreed and both were wrong, which is the signature of every round of this bug.

Rounds 1-4 are one class stated four ways: **a construct the author used to make a region INERT was not
modelled, so an inert region was treated as live markup.** Round 1/2 was nesting depth, round 3 was line
splitting and fence pairing, round 4 is the second fence character. Fixing the demonstrated construct is how
you get the next one.

### The fix: enumerate the inert constructs, decide each one out loud

CommonMark has exactly three ways to make a region literal. All three are now settled, in the parser header
and in the spec's new "What makes a region inert" section:

1. **Fenced code, BOTH characters.** There is now ONE character-parameterised fence primitive
   (`openerOf` / `isClosingFence` in `public/lib/response-blocks.js`); every rule in the module — the
   top-level scan, C1, C2, the digest lift in `public/lib/digest.js` — goes through it. That is the actual
   repair: not "add tildes", but make it impossible to fix a fence rule for one character and forget the
   other, which is what happened to opener length, closer length, info strings and indentation. A fence
   pairs only with its own character at any length (eight tildes do not close a backtick fence, and vice
   versa). The one asymmetry is CommonMark's: a backtick fence's info string may not contain a backtick, a
   tilde fence's may contain anything. `parseDigest` was a separate backtick-only regex — layer 1 and layer 2
   literally disagreed about what a digest fence is — and is now the same line-scan pairing rule.
2. **Indented code (4+ columns).** Already covered, and covered *structurally* rather than by luck: an
   opener is only recognised at 0-3 columns and an indented code block contains no line at 0-3 columns. It
   is also the escape hatch the spec offers authors, so it now carries the STRONG assertion (exact parse AND
   silence) in an `icode` corpus stratum for both characters, instead of being assumed.
3. **HTML blocks — deliberately NOT modelled**, with the reasoning recorded so round 5 does not re-derive
   it. (a) Nothing in this stack treats HTML as live markup — `prose()` builds DOM from text nodes and never
   interprets a tag, so `<div>` renders as the characters `<div>`. There is no "wrap it in HTML to make it
   inert" affordance to honour, and inventing one would make the parser call a region literal that the
   renderer does not: a NEW divergence, in the direction that loses a real block. (b) Every HTML-block start
   condition but types 1-5 ends at a **blank line**, so inertness would become paragraph state — exactly the
   multi-line stateful reasoning the fold guard was rewritten to eliminate, in the one module where state
   mistakes have caused three defects. (c) The residual is bounded by C1 and is NOT this class: a reserved
   opener inside a fold always ends the fold, so an HTML-wrapped example can never hide an authored
   `orchard-answer`. At worst, text typed between `orchard-notes` fences folds — where it was typed. An
   `html` corpus stratum asserts that bound directly rather than leaving it as an argument.

Everything the previous rounds established is preserved: visible bias, depth-free C1/C2, line-ending
normalisation at the boundary, CommonMark's real fence-pairing rule, and "well-formed input reports nothing".

### The corpus: the FENCE CHARACTER is now a dimension

10,715 → **20,160 cases**. The character crosses depth 1 and depth 2 in full (all four containment orders),
plus a `mix3` stratum running all eight character patterns at depth 3, plus the character on the indent,
closer-length, long-run and separator strata including CROSS-character pairs where the inner fence cannot
close the outer one however long it is, plus `icode`, `html`, and `tsyn` (the info-string asymmetry). Four
reported round-4 inputs are graded verbatim, three of them as WELL-FORMED — the strongest grading available,
asserting an exact parse AND total silence on the actual reported bug.

The character dimension immediately found a bug in the **oracle** too: the well-formedness predicate compared
an inner fence's width against its immediate parent only. Fences do not nest, so a tilde fence written inside
a backtick one is literal content and does NOT shield a wide backtick run from closing the backtick fence two
levels up. The predicate now compares against every same-character ancestor.

`shape` counts: depth1 72 · depth2 5,184 · depth3 5,832 · mix3 432 · eol 6,507 · indent 576 · closelen 544 ·
depth4 729 · depth5 108 · longrun 144 · separator 6 · icode 14 · html 2 · tsyn 2 · reported 8.
Line endings: lf 13,652 · crlf 2,169 · cr 2,170 · mixed 2,169. 1,082 well-formed; 4,982 render a fold.

### Anti-vacuity calibration (the same 20,160 cases, every parser generation)

| parser | failing cases | I1 (hidden) | I2 (lost/reordered) | I3 (unreported) | well-formed falsely flagged |
|---|---|---|---|---|---|
| `31acb24^` (pre-FEAT-091) | 1,279 | 861 | 50 | 478 | 2 |
| `31acb24` (round-2 fix) | 807 | 287 | 50 | 525 | **29** |
| `3851f04` (round-3 fix, the parser attacked) | 723 | 312 | 0 | 417 | 0 |
| current | **0** | **0** | **0** | **0** | **0** |

**All 723 of round-3's failures are tilde-bearing cases and ZERO are backtick-only** — the extension is
exactly the new dimension and nothing else, so the calibration measures the round-4 gap rather than noise.

### Verification (numbers as printed)

- **must-FAIL first, in a REAL browser with a real accessibility-tree read.** The clean room's own preserved
  script (`/tmp/cleanroom-verify-1h2pqs/adversarial-tilde-ax.mjs`, run against this repo): **exit 1**,
  `probe.details true / open false`, `visible` missing the token, `axHasToken: false`,
  `parser.blocks ['orchard-notes'], malformed []`.
- **after the fix, same script, unchanged:** **exit 0** — `details: false`, the token in the visible text AND
  `axHasToken: true`, `blocks: []`, `malformed: []` (legal CommonMark reports nothing).
- `node scripts/verify-feat-091-response-blocks.mjs` → **TOTAL: 157 passed, 0 failed, 0 skipped**, exit 0.
  20,160 generated inputs, I1/I2/I3 all 0, I4 zero flags across the 1,082-case well-formed subset.
- `node scripts/verify-feat-091-renderer.mjs` → **VERDICT: PASS — 154 passed, 0 failed**, exit 0.
  **13,236** corpus cases rendered in the real browser (of 20,160 enumerated), **4,982** producing closed
  folds, AX read over **220** fold-bearing risky cases with all **6** reported inputs forced in,
  `axMissing: 0`, `axLeaked: 0`.
- **anti-regressions, all exit 0:** `feat-081` 23/23 · `feat-082` 52/0 · `feat-083` 22/22 ·
  `feat-083-adversarial` contract HOLDS · `feat-084` 37/0 · `feat-085` 58/58 · `feat-085-adversarial`
  contract HOLDS · `feat-085-independent` 60/0 · `feat-085-readability` 32/0 · `feat-089` 35/0 ·
  `orchard-transcripts` 15/0 · `bug-087-stale-transcript` 6/6.
- `npm run gate` → **GATE: PASS** (leak-gate, check-nul, typecheck), exit 0, read directly, never piped.
- The injected core stayed inside its budget: the fence rule was made character-generic and four bullets
  condensed to pay for it — **2,973 chars**, under the 3,000 the suite enforces. The new prose lives in the
  human-only half of the document.

### Bucket and honest limits

**Data-hiding + regression-prone (four BROKEN verdicts in a row on this grammar) — an independent clean-room
verify pass is REQUIRED, not optional.** What I did NOT test, stated so the next pass can start here rather
than rediscover it:

- **HTML blocks as an inert construct.** Argued out of scope above and bounded by a corpus stratum, but the
  argument, not the code, is what would be wrong if it is wrong. Attack it by finding an HTML shape whose
  authored intent is inert and whose folding a reader would call hiding.
- **`prose()`'s own tilde blindness** (`public/lib/dom.js`, out of lane — a lane is live there). It splits on
  ``` only, so a tilde-fenced region renders as paragraphs rather than a code block. Content is visible, so
  it is not this class, but the parser and the renderer disagree about what a tilde fence *looks* like.
- A real archived transcript replayed at TRUNCATION points through the renderer (still untested, third round
  running).
- RTL text and combining marks inside a fold summary; a genuinely enormous message (corpus cases are small).
- CommonMark constructs that are not inert but do change what a "line" is to a fence: blockquote (`>`) and
  list-item continuation. Both currently make the parser UNDER-recognise fences (content stays visible), so
  they are in the safe direction, but neither is enumerated.

- **Verified-by:** dispatch openai run 01a016b1-a697-7f32-81d6-a932cc21487d (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN
  (range `ba335b90`..`326439c` — synthetic base = tree of `326439c^` with `326439c`'s `docs/` grafted on, so
  the diff is exactly the 4 non-docs files, 55397 bytes, untruncated. Fixer test `node
  scripts/verify-feat-091-response-blocks.mjs` re-run, exit 0, 144 passed / 0 failed / 1 skipped (the `[5]
  injection` case degrades to a stated skip because the clean room strips `docs/`), run `4ac79c2eea99`.
  Adversarial case `top-level-html-block-containing-notes-ex`, run `b4fc000291db`, exit 1: a 4-backtick
  `orchard-notes` example enclosed in a top-level CommonMark HTML block —
  `<div>` / ` ```` orchard-notes` / `MUST-BE-READER-VISIBLE-HTML` / ` ```` ` / `</div>` — is parsed as a REAL
  notes block. Real Brave render through the app's own `renderAssistantText`: one `details.orchard-notes`
  with `open: false`, the token absent from `innerText` and absent from the real CDP full accessibility tree
  (`tokenInAx: false`); the shared parser reports `blocks: ['orchard-notes']`, `malformed: []`,
  `fallbackChars: 11`, and a SEPARATE Stop-hook process records the same, so the counter mis-reports what a
  reader sees. So: content the author did NOT put in a notes block is **HIDDEN** (guarantee 1) and
  **MIS-REPORTED** (guarantee 4). Nothing lost or misordered; no false flag on valid input. This is exactly
  the residual the round-4 honest-limits list named — the HTML-block bound argument is what was wrong, not
  the fence code. Could not test, stated by the verifier: the `RESPONSE_FORMAT.md` injection path (clean room
  strips `docs/` — expected environment behaviour, not a defect). Still untested this round: archived-
  transcript truncation replay, RTL/combining marks in a fold summary, a very large message, and the
  blockquote/list-item container contexts.)

---

## 2026-08-19 — FIFTH verdict fix: HTML blocks are inert, and "the residual is bounded" is not a shipping argument

`regressed-from: FEAT-091 round-4 fix (326439c)` — the defect is not in that commit's fence code, which was
correct. It is in that commit's *documented decision* to leave HTML blocks unmodelled, and in the argument
that carried it. Round 3 named tilde fences as a known gap and shipped; that gap was round 4. Round 4 named
HTML blocks as a known gap and shipped; that gap is round 5. **Two rounds in a row documented the hole they
were about to be broken by**, so the decision procedure was the defect, not the code.

### The defect, and why the previous round's bound missed it

The clean room's input, character for character:

    <div>
    ````orchard-notes
    MUST-BE-READER-VISIBLE-HTML
    ````
    </div>

A top-level CommonMark HTML block makes its contents **literal**, so that fence is an *example*. Unmodelled,
it became a real fold: the token was in the DOM, absent from `innerText`, absent from the real CDP
accessibility tree, and the shared counter reported one clean `orchard-notes`, `fallbackChars: 11` and an
**empty** `malformed` list. The Stop hook, a separate process, recorded the same. Hidden **and**
mis-reported.

Round 4's suite asserted, in its own words, that *"HTML is not inert here, and the bound holds: a wrapped
answer is NOT folded."* Measured against the corpus, that bound was **true** — and true in the direction
that does not matter. Of the 59 cases the round-4 parser now fails, the **20 that actually hid content are
all `orchard-notes` variants**; every `orchard-answer` variant fails on structure only, visibly. C1 bounds
what can hide inside a fold that *already exists*; the defect was a wrapper **creating** a fold.

**Standing rule adopted for this lane, and written into the module header and the spec:** a construct that
can make a region literal is a **hiding vector until a test says otherwise**. Model it, or commit a test
proving a notes fence inside it cannot become a real fold. Catching yourself writing "the residual is
bounded" is the signal to write the test instead.

### The fix — sufficient, not faithful

Not a CommonMark HTML-block parser. A rule that is *sufficient* for the invariant, which is what the
invariant asks for (`public/lib/response-blocks.js`, construct 3):

- **START** — one per-line predicate: 0-3 indent, `<`, then `!`, `?`, `/` or a letter. All seven CommonMark
  start conditions begin that way, so none can be forgotten. It also matches lines CommonMark would not
  (`<foo>bar`, an autolink line); prose shapes `<= 5` / `<- x` / `<3` are excluded by the character class.
- **EXTENT** — the kind's own terminator for types 1-5 (checked from the start line, so `<!-- x -->` and
  `<!DOCTYPE html>` are one line and do **not** sterilise what follows), otherwise the first **blank line**.
  Round 4 refused this as "paragraph state"; it is one boolean, not a depth — the same two-state shape the
  fence pairing already is.
- **THE ADDITION THAT MAKES IT SAFE** — the region never ends while a fence opened inside it is still open.
  Without it an inert region could end *earlier* than the old fence-only scan and hand a dangling fence back
  to the top level, where it becomes a fold: **adding inertness could itself create hiding.** Pinned by
  `html5/dangle` and a standalone check.
- **MONOTONE INERTNESS** is why over-recognition is free, and it is the property that makes this provably
  non-hiding: the inert set only **grew**, an inert line renders as visible prose, so more inertness can only
  move content toward visible. The entire cost of a false positive is that a block written directly under it
  renders as prose — visible, in order, and reported as `inert-html:`. One blank line restores it.
- **Top-level only.** The fold guard stays construct-blind: C1 must keep firing on a reserved opener inside a
  fold in *any* wrapper, so teaching it about HTML could only weaken it. Unchanged.
- `public/lib/digest.js` needs **no** change and was not touched: its digest fence is only recognised at the
  top of a message with nothing but blank lines before it, so no HTML block can be open at that line.

### The inventory, completed — and the three-round carry-over closed

- 1 fenced code (both characters) · 2 indented code — already modelled, unchanged.
- 3 **HTML blocks** — this round.
- 4 **Container contexts** (blockquote, list items) — carried as "not attempted" for three rounds, now
  enumerated (`bq`, `list`): quote depths 1/2/tight, markers `- * + 1. 10)`, content indents 0-3 and 4+, a
  quoted inert wrapper, a fence on the marker line, and the two directions that keep it honest (a quote does
  not sterilise a following top-level fence; a 0-3 indent fence after a marker really does fold, with the
  authored indent intact). Both under-recognitions cannot hide anything — no fence recognised means no fold
  created — and the renderer shares the verdict because it uses this parser, not a second one.
- 5 **Inline constructs are not literalisers**, and that is a *proof*: CommonMark settles block structure
  before inline parsing, so a code span, a raw inline tag or a link-ref-definition title cannot contain a
  fence. Per the standing rule the proof ships as tests (`inline`), asserting the fence is **live** — so a
  future over-correction toward inertness fails there. Backslash-escaped runs pinned too.

### Verification — numbers as printed

- **must-FAIL first, in a REAL browser with a real accessibility-tree read.** The clean room's own preserved
  script (`/tmp/cleanroom-verify-di7tuj/scratch-html-literal-browser.mjs`), run unchanged against this repo:
  **exit 1** — `folds: 1, open: false`, `innerText` "<div>\n\n▸\nNOTES\ninternal narration\n\n</div>" with the
  token absent, `tokenInAx: false`, `axNames: []`, parser `blocks: [["orchard-notes","MUST-BE-READER-VISIBLE-HTML"]]`,
  `malformed: []`, `fallbackChars: 11`, and the separate Stop-hook process recording `{orchard-notes: 1}`.
- **after the fix, same script, unchanged:** **exit 0** — `folds: 0`, `foldRect: null`, the token in
  `innerText` **and** `tokenInAx: true` (twice in `axNames`), `blocks: []`, `fallbackChars: 63`,
  `malformed: ["inert-html:orchard-notes@line2"]`, and the Stop hook records the same: visible **and**
  reported.
- `node scripts/verify-feat-091-response-blocks.mjs` → **TOTAL: 163 passed, 0 failed, 0 skipped**, exit 0.
  **20,273** generated inputs (`html5` 63, `bq` 13, `list` 32, `inline` 3, `reported` 10 added), I1/I2/I3 all
  0, I4 zero flags across the **1,136**-case well-formed subset. A new `expectedFlags` grading asserts the
  EXACT report, not just "something was flagged" — "visible and reported" is two claims.
- `node scripts/verify-feat-091-renderer.mjs` → **VERDICT: PASS — 154 passed, 0 failed**, exit 0. **13,313**
  corpus cases rendered in the real browser, **5,011** producing closed folds, AX read over 220 fold-bearing
  risky cases with the reported inputs forced in.
- **CALIBRATION against every parser generation, same 20,273 cases** (failing cases; per-invariant = cases
  with ≥1 violation):

  | parser generation | failing | I1 | I2 | I3 | well-formed falsely flagged |
  |---|---|---|---|---|---|
  | `31acb24^` pre-FEAT-091 | 1,338 | 786 | 50 | 535 | 2 |
  | `31acb24` round-2 fix | 866 | 293 | 50 | 555 | 29 |
  | `3851f04` round-3 fix | 782 | 318 | 0 | 476 | 0 |
  | `326439c` round-4 fix (attacked) | **59** | **20** | 0 | 59 | 0 |
  | current | **0** | 0 | 0 | 0 | 0 |

  All 59 round-4 failures are in the new dimension (57 `html5` + the 2 verbatim round-5 inputs) and **zero**
  are outside it, so the extension is exactly the new construct and nothing else.
- **HONEST, and stated rather than buried: the `bq` / `list` / `inline` strata fail ZERO cases on every
  generation above.** They found nothing. They convert three rounds of "not attempted" into pinned
  behaviour so a future extent change fails there instead of shipping.
- **anti-regressions, all exit 0:** `feat-082` 52/0 · `feat-083` 22/22 · `feat-083-adversarial` contract
  HOLDS · `feat-084` 37/0 · `feat-085` 58/58 · `feat-085-adversarial` contract HOLDS · `feat-085-independent`
  60/0 · `feat-085-readability` 32/0 · `orchard-transcripts` 15/0.
- `npm run gate` → **GATE: PASS** (leak-gate, check-nul, typecheck), exit 0, read directly, never piped.
- The injected core was **not touched**: it stays at 2,973 chars against the 3,000 the suite enforces. All
  new prose is in the human-only half of `RESPONSE_FORMAT.md`.

### Bucket and honest limits

**Data-hiding + regression-prone (FIVE BROKEN verdicts in a row on this grammar) — an independent clean-room
verify pass is REQUIRED, not optional.** Not tested this round, listed so the next pass starts here:

- **`prose()`'s tilde blindness** (`public/lib/dom.js`, out of lane — a live lane there). It splits on ```
  only. Content stays visible, so not this class, but the two halves disagree about what a tilde fence
  *looks* like. Note the post-fix render of the reported input shows this: the trailing fence run renders as
  a stray ``` ` ``` before `</div>`. Ugly, not hiding.
- A real archived transcript replayed at TRUNCATION points through the renderer (untested, fourth round
  running).
- RTL text and combining marks in a fold summary; a genuinely enormous message.
- The over-recognition trade itself: an autolink line directly above a notes block now inerts it (pinned as
  `html5/overreach/*`). Visible and reported, and one blank line restores it — but if agents write that
  shape often, the flag rate is the thing to watch, not a defect to fix blind.
- GFM tables and front matter are not CommonMark and are not modelled; neither can shield a fence at block
  level, but neither is enumerated.

- **Verified-by:** dispatch openai run 01a016c4-642a-7ae3-8949-589461cfb0c5 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

## 2026-08-19 — SIXTH clean-room verdict: over-recognition is not free (commit `a2edb76`)

**regressed-from: the round-5 fix (`a2edb76`), this ticket.** Round 5 modelled HTML blocks with one
deliberately loose start predicate — `/^ {0,3}<[!?\/A-Za-z]/` — on the reasoning that all seven of
CommonMark's start conditions begin that way, so none could be forgotten, and that the resulting
over-recognition was *free* because an inert line still renders visible. The clean room found what it
costs. Input:

    <b
    ````orchard-notes
    AUTHORED-NOTES
    ````
    VISIBLE-TAIL

`<b` alone on a line is **not** a CommonMark HTML block start — no complete tag, no listed tag name, no
condition satisfied. It is ordinary paragraph prose. The loose predicate inerted it and swallowed the
block: `blocks: []`, `malformed: ["inert-html:orchard-notes@line2"]`. Two guarantees breached — well-formed
input must report nothing, and a genuine block must be recognised. Nothing was *hidden* (the content leaked
out visible, the safe direction, and round 5's monotone-inertness argument was true), but a false flag on
everyday prose is exactly what trains a reader to ignore the flag, and losing a real block corrupts the
metrics the design depends on.

Round 5's own honest-limits list named this trade as "the thing to watch, not a defect to fix blind", and
asserted the false flag in the corpus as EXPECTED behaviour (`html5/overreach/autolink-no-blank`). **A suite
that encodes the trade a fix made cannot audit that trade** — that is the round's transferable lesson.

**A caveat on the evidence, checked rather than assumed.** The clean-room script crashed during cleanup
(`ENOTEMPTY` removing the Brave profile) *after* printing its evidence, so its recorded exit code came from
the crash, not its assertion. Reproduced here with the cleanup fixed: the assertion itself fails, exit 1,
against the repo module at `a2edb76`. The finding stands on its own.

### The fix — the seven start conditions, implemented rather than approximated

`HTML_START_RE` is replaced by `HTML_STARTS`, one entry per CommonMark condition, each with its own end:

| # | start | end |
|---|---|---|
| 1 | `<script` / `<pre` / `<style` / `<textarea` + whitespace, `>` or EOL | `</script>`-ish |
| 2 | `<!--` | `-->` |
| 3 | `<?` | `?>` |
| 4 | `<!` + ASCII letter | `>` |
| 5 | `<![CDATA[` | `]]>` |
| 6 | `<` or `</` + a listed block tag + whitespace, EOL, `>` or `/>` | blank line |
| 7 | a **complete** open/closing tag alone on the line, **not interrupting a paragraph** | blank line |

Condition 6's tag list is the union of CommonMark 0.30 and 0.31.2 (they differ only in `source`/`search`).
Condition 7's paragraph clause is honoured via one boolean, `paragraphOpen`; lines that are really some
other leaf block count as paragraph, which under-recognises condition 7 — the safe side.

**Direction of error, restated.** Round 5's "monotone inertness — the inert set only grows" is withdrawn as
the governing property; this round deliberately SHRANK it. The property that survives is: where a
line-at-a-time scanner cannot settle the spec, err toward **not** inert. A missed inert region is bounded
(at worst an authored example becomes a real fold, and C1/C2 already bound what a fold may contain); a false
inert region corrupts the parse, which nothing downstream bounds.

### Verification

- **must-FAIL first:** the clean-room adversarial (cleanup fixed) against the repo module at `a2edb76` —
  `blocks: []`, false `inert-html` flag, **exit 1**. After the fix, same script, same real Brave + full CDP
  accessibility tree: `blocks: ["orchard-notes"]`, `malformed: []`, **exit 0**.
- **Differential test against the CommonMark 0.31.2 REFERENCE implementation** (the spec editor's own), 63
  candidate lines x 2 paragraph contexts = **126 comparisons: 126 agree, 0 disagree, 0 over-recognised**.
  The same oracle scores round 5 at **30/126 disagreements, every one over-recognising** — so the oracle is
  not vacuous. It is not wired into the suite (it needs a dependency this repo does not carry); the lines it
  validated are carried as corpus strata instead.
- **corpus 20,353 cases** (was 20,273), `html5` stratum 63 → 143. New: `html5/prose/*` — ordinary prose that
  merely resembles HTML (incomplete tags, `Array<string>`, `x < y`, `<= 5`, `<- x`, autolinks, inline tags
  with trailing text), each at message start AND under paragraph text; `html5/para7/*` — condition 7's
  paragraph clause in both directions; `html5/end/*` — every condition's terminator asserted separately, so
  a terminator that never fires cannot silently swallow the rest of a message. `html5/overreach/autolink-*`
  is **inverted** from asserting the false flag to forbidding it.
- **CALIBRATION against every parser generation, same 20,353 cases** (failing cases; "falsely flagged" =
  well-formed cases reporting anything but the legitimate `unknown-block:`):

  | generation | failing | I1 | I2 | I3 | falsely flagged |
  |---|---|---|---|---|---|
  | `31acb24^` pre-FEAT-091 | 1,356 | 794 | 50 | 553 | 2 |
  | `31acb24` round 2 | 884 | 301 | 50 | 573 | 29 |
  | `3851f04` round 3 | 800 | 326 | 0 | 494 | 0 |
  | `326439c` round 4 | 77 | 30 | 0 | 77 | 0 |
  | `a2edb76` round 5 | 26 | **0** | 0 | 26 | **26** |
  | round 6 (this fix) | **0** | 0 | 0 | 0 | **0** |

  Round 5's row is the shape of over-recognition exactly: it hid nothing, and it lost 26 genuine blocks out
  of the parse while flagging 26 legal inputs. All 26 are `html5`; 24 are the new `prose`/`para7` strata.
- **A harness defect found and pinned.** Two `html5/para7` cases slugged their id from the tag line, so
  `<my-widget>` and `</my-widget>` collided. The parse leg graded both fine; the RENDER leg joins by id, so
  the collision made four tokens look like they "rendered nowhere at all". A duplicate id is a silently
  mis-graded case. The suite now asserts id uniqueness.
- **suites:** `verify-feat-091-response-blocks` **0 failed, exit 0** (20,353 cases; I1/I2/I3/I4 all clean,
  1,198 well-formed cases silent) · `verify-feat-091-renderer` **154 passed, 0 failed, exit 0**.
- **anti-regressions, all exit 0:** `feat-082` · `feat-083` · `feat-083-adversarial` · `feat-084` (37/0,
  injected core still **exactly 2,973** chars) · `feat-085-readability` · `feat-085-stop-hook` ·
  `feat-085-adversarial` · `feat-085-independent` · `orchard-transcripts` · `bug-087-stale-transcript`.
- `npm run gate` → **GATE: PASS** (leak-gate, check-nul, typecheck), **exit 0**, read directly, never piped.
- All new prose is in the **human-only** half of `RESPONSE_FORMAT.md`; the injected core is untouched.

### BUG-111 confirmed, not fixed (out of lane)

The reported output also showed the tail as `` ` VISIBLE-TAIL`` — a stray backtick. Confirmed as
**BUG-111** (`prose()` models a fence as `src.split(/```/)`, a character-run splitter, not a line scan) and
deliberately left alone. Proof it is not the start predicate: with `<div` — which genuinely **is** a
condition-6 HTML block, and the reference implementation agrees — the region is correctly inert, correctly
reported, content correctly visible, and the tail **still** renders `` ` VISIBLE-TAIL``. The fix only
removed the symptom from the `<b` case because `<b` no longer inerts, so the fence never reaches `prose()`.

### Bucket and honest limits

**Data-hiding + regression-prone (SIX BROKEN verdicts in a row on this grammar) — an independent clean-room
verify pass is REQUIRED, not optional.** Not tested this round, listed so the next pass starts here:

- **The reference oracle is not in the suite.** 126/126 today is a point-in-time result from a scratch
  install, not a standing gate. If `commonmark` is ever made a devDependency, wire it in — it is by far the
  strongest check this grammar has had.
- **Condition 7's paragraph rule uses a simplified `paragraphOpen`**: any non-blank top-level fallback line
  sets it, including lines that are really headings, thematic breaks or list markers. That
  under-recognises condition 7 (the safe side) but it is an approximation, and it is the one place this
  round did not implement the spec exactly.
- **`prose()`'s divergent fence model** (BUG-111) remains, and now matters slightly more: fewer regions are
  inert, so fewer fences reach `prose()` — but the ones that do still render wrong.
- A real archived transcript replayed at TRUNCATION points through the renderer (untested, fifth round
  running).
- RTL text and combining marks in a fold summary; a genuinely enormous message.
- GFM tables and front matter are not CommonMark and are not modelled; neither can shield a fence at block
  level, but neither is enumerated.

- **Verified-by:** dispatch openai run 01a016d5-89bf-7161-ae59-febc1429d1f0 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

---

## 2026-08-19 — round 7: `paragraphOpen` means what CommonMark means (7th BROKEN verdict, fixed)

**regressed-from:** this ticket, round 6 (`5565736`). Round 6 introduced the simplified `paragraphOpen` and
listed it in its OWN honest-limits section as "the one place this round did not implement the spec exactly",
calling the resulting under-recognition of condition 7 *the safe side*. The next clean-room pass walked
straight through it. **That is three consecutive rounds where a lane documented a limitation and the very
next verifier used it.** The standing rule for this lane is restated and is now enforced by the fix, not by
a promise: an identified gap in the hiding direction may not ship as a documented limitation.

### The defect

```
# Completed heading
<my-widget>
````orchard-notes
MUST-STAY-VISIBLE
````
</my-widget>
```

An ATX heading immediately above a complete custom tag left `paragraphOpen` set, so condition 7 was
suppressed, the region was **not** treated as literal, and the `orchard-notes` **example** inside it became
a real **closed fold**. CommonMark 0.31.2 reference AST: `["document","heading","text","html_block"]`. This
parser: `blocks:["orchard-notes"], malformed:[]`. Real Brave `innerText` showed only the tag lines and a
collapsed `▸Notes`; `details.open=false`; token absent from the **accessibility tree**. Empty `malformed`
and empty fallback, so both consumers agreed and both were wrong — the same hiding class as rounds 1-6,
reached through paragraph state.

**It was never only headings.** The must-FAIL run over the paragraph-context family: **10 of 17 cases
FAIL, exit 1** — every ATX level, all three thematic-break characters, setext headings, indented code, an
empty list item and an empty block quote all hid content. Fixing the demonstrated shape would have shipped
nine more.

### The fix — enumerate, do not approximate

`paragraphOpen` is replaced by `paragraphStateAfter(line, prev)` returning `{ open, chain }`. A paragraph is
**closed** by a blank line, an ATX heading, a thematic break, a setext underline, a fenced-code opener
(either character), an HTML-block start (types 1-6 always, 7 only when no paragraph is open), and an empty
container marker (`-`, `1.`, `>`); it is left **open** by ordinary text, and by indented code **only when one
was already open**, because indented code cannot interrupt a paragraph. Container markers are stripped and
the remainder classified by the same rule, so the rule is written once, not once per nesting; `chain` travels
with the flag so `> a` / `> b` continues one paragraph while `> a` / `b` is **lazy continuation** — which is
why the fix does not over-correct: `> quoted text` above `<my-widget>` is paragraph continuation text to
CommonMark, not an HTML block, and the notes block below it is still a genuine fold.

### Verification — the reference implementation as the oracle, both directions

- **must-FAIL first, in a real browser.** 17 paragraph contexts x (CommonMark 0.31.2 AST · real
  `parseResponseBlocks` · real Brave `innerText` · real Brave **accessibility tree**): **10 FAIL / 7 ok,
  exit 1** before the fix, **0 FAIL / 17 ok, exit 0** after. Scratch harness under `/tmp`, never in the repo.
- **Differential test against CommonMark 0.31.2, widened.** Round 6's oracle run varied 63 candidate lines
  x **2** paragraph contexts and scored 126/126 — because the two contexts it varied were the two the
  grammar got right. Round 7 varies **73 contexts x 22 tag lines = 1,606 documents**, comparing in BOTH
  directions whether the reference puts an `html_block` over the fence line and whether the parser treats
  the region as literal:

  | parser | hiding disagreements | over-recognition | total |
  | --- | --- | --- | --- |
  | `5565736` round 6 | **240** | 0 | 240 |
  | round 7 (this fix) | **0** | **0** | **0** |

- **New corpus stratum `para` — 511 cases**, every kind of block above a condition-7 tag: 73 contexts x 7
  tag lines (5 condition-7 shapes, one condition-6 control that *may* interrupt a paragraph, one
  not-HTML-at-all control). Each context's expected verdict is **transcribed from the reference AST**, not
  from the grammar's opinion of itself. The suite asserts both verdicts are populated, so a parser that
  always inerted — or never did — fails rather than passes.
- **Calibration, all seven generations, on the same 20,864 cases** (failing cases; per-invariant counts are
  cases with >=1 violation; "falsely flagged" counts WELL-FORMED cases reporting anything but the legitimate
  `unknown-block:` advisory):

  | parser | failing | I1 hidden | I2 | I3 | falsely flagged |
  | --- | --- | --- | --- | --- | --- |
  | pre-FEAT-091 | 1674 | 1112 | 50 | 871 | 2 |
  | `31acb24` round 2 | 1202 | 619 | 50 | 891 | 29 |
  | `3851f04` round 3 | 1118 | 644 | 0 | 812 | 0 |
  | `326439c` round 4 | 395 | 348 | 0 | 395 | 0 |
  | `a2edb76` round 5 | 146 | **0** | 0 | 146 | **146** |
  | `5565736` round 6 | 150 | **150** | 0 | 150 | **0** |
  | round 7 (this fix) | **0** | 0 | 0 | 0 | **0** |

  Rounds 5 and 6 are exact mirrors, and together they retire the argument this lane kept reaching for:
  round 5 over-recognised, hid nothing and corrupted 146 legal parses; round 6 under-recognised, flagged
  nothing falsely and **hid 150 tokens**. All 150 of round 6's failures are in the new `para` stratum and
  **zero** are anywhere else. Neither direction of error is bounded in any useful sense, so neither may be
  approximated — where the spec is decidable, decide it and check against the reference.
- **suites:** `verify-feat-091-response-blocks` **186 passed, 0 failed, exit 0** (20,864 cases; I1/I2/I3/I4
  all clean, 1,391 well-formed cases silent) · `verify-feat-091-renderer` **154 passed, 0 failed, exit 0**
  (another lane's file — run, not modified; it rendered 13,896 of the 20,864 cases in a real browser with an
  AX read over 220 fold-bearing ones).
- **anti-regressions, all exit 0:** `feat-082` (52/0) · `feat-083` (22/22) · `feat-083-adversarial` ·
  `feat-084` (37/0, injected core budget still asserted) · `feat-085-readability` (32/0) ·
  `feat-085-stop-hook` (58/58) · `feat-085-adversarial` · `feat-085-independent` (60/0) ·
  `orchard-transcripts` (15/0) · `bug-087-stale-transcript` (6/6).
- `npm run gate` → **GATE: PASS** (leak-gate, check-nul, typecheck), **exit 0**, read directly, never piped.
- All new prose is in the **human-only** half of `RESPONSE_FORMAT.md`; the injected core is untouched.
- **Hazard avoided, deliberately.** A previous clean-room verifier ran `npm install` through a `node_modules`
  symlink and wrote into the live `package.json`/`package-lock.json`. Every scratch install and scratch file
  this round lives under `/tmp/feat091-r7`; `package.json` and `package-lock.json` are byte-identical to
  their state at the start of this lane (checked by hash before and after) and are **not** staged here.

### Bucket and honest limits

**Data-hiding + regression-prone (SEVEN BROKEN verdicts in a row on this grammar) — an independent
clean-room verify pass is REQUIRED, not optional.** Not tested this round, listed so the next pass starts
here:

- **The reference oracle is still not a standing gate.** 1,606/1,606 is a point-in-time result from a
  scratch install under `/tmp`. A separate lane is wiring `commonmark` in as a standing check and owns
  `package.json`; when it lands, this differential belongs in the suite. Until then the oracle's verdicts
  survive only as the `para` stratum's transcribed expectations.
- **Paragraph state is top-level and one-deep in the container dimension.** `chain` distinguishes same
  container / lazy continuation / new container, but it does not model a paragraph open inside a container
  *while* an unprefixed construct closes only the outer one. Every such shape reachable from the 73 contexts
  agrees with the reference; deeper container nesting (3+) crossed with setext underlines is not enumerated.
- **`prose()`'s divergent fence model** (BUG-111) remains, unchanged and out of lane.
- A real archived transcript replayed at TRUNCATION points through the renderer (untested, sixth round
  running).
- RTL text and combining marks in a fold summary; a genuinely enormous message.
- GFM tables and front matter are not CommonMark and are not modelled. The reference oracle does not model
  them either, so the `table-row` context is graded as the paragraph it is to CommonMark; if the renderer's
  markdown library ever enables GFM tables, that context's verdict is unverified.

- **Verified-by:** dispatch openai run 01a016e8-b5d4-7ff1-8bc3-8c14e3374927 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN
  (range `88e77ca7`..`52807b9d` — synthetic base = tree of `52807b9^` with `52807b9`'s `docs/` grafted on, so
  the diff is exactly the 3 non-docs files, 48477 bytes, untruncated. Fixer test re-run `7ead54410a80`
  (172 passed / 0 failed / 2 environment skips, exit 0). Adversarial case
  `list-item-indented-code-before-type7-htm`, run `573f42e9eae7`, exit 1: after a list item whose content is
  indented code (`-␠␠␠␠␠code`), CommonMark parses `<my-widget>`…`</my-widget>` as a type-7 HTML block, so the
  ````orchard-notes` example inside it is LITERAL — the parser instead creates a real `orchard-notes` block and
  hides `ADVERSARIAL-MUST-BE-VISIBLE` behind the closed fold, silently. Classification: content HIDDEN,
  guarantee (1). Provenance: CommonMark reference AST + parser called directly. Could not test: real-browser
  rendered text / accessibility tree for that exact input (renderer verifier died with "Promise was
  collected"); docs- and git-dependent checks skipped because the clean room strips `docs/` and has no usable
  history. `package.json`/`package-lock.json` byte-identical before and after this dispatch.)

## 2026-08-19 — the CommonMark reference differential is now a STANDING check (`commonmark` pinned as a devDependency)

Six rounds asked for it and the round-7 lane's own honest-limits list made the request explicit: *"The
reference oracle is still not a standing gate. 1,606/1,606 is a point-in-time result from a scratch install
under /tmp. A separate lane is wiring `commonmark` in as a standing check and owns `package.json`; when it
lands, this differential belongs in the suite."* This is that wiring.

**The dependency — pinned exactly, identity verified, integrity locked, devDependency only** (the standing
supply-chain rule, BUG-107/BUG-108 pattern):

- `commonmark@0.31.2`, **exact** version, never a range and never `latest`.
- **Identity checked before pinning, not assumed:** npm `commonmark` — `author "John MacFarlane"` (the
  CommonMark spec editor), `repository git+https://github.com/commonmark/commonmark.js.git` (the reference
  implementation, the CommonMark org's own repo), `homepage https://commonmark.org`, BSD-2-Clause. It is the
  reference JS port, not a lookalike (`markdown-it`, `commonmark-java`, etc. are different projects). Version
  0.31.2 matches the spec revision every prior round differential-tested against.
- **Integrity hash pinned in the lockfile:** `sha512-2fRLTyb9r/2835k5cwcAwOj0DEc44FARnMp5veGsJ+mEAZdi52sNopLu07ZyElQUz058H43whzlERDIaaSw4rg==`,
  cross-checked three ways: it equals what `npm view commonmark@0.31.2 dist.integrity` serves, `npm ls
  commonmark` reports a consistent single-version tree, and a **fresh isolated install** in a throwaway dir
  produced the byte-identical integrity — so the lockfile entry is genuinely installable from the registry,
  not a stray on-disk copy. (The stray copy warning is real: an accident earlier today `npm install`ed it via
  a clean room whose `node_modules` symlinks into this repo; BUG-112 fixes that isolation hole.)
- **devDependency only.** It is under `devDependencies`, not `dependencies`, and is imported by nothing in
  `src/` or `public/` — only by the verify script below, and only inside a guarded `try`. A runtime session
  never touches it.

**The check — the round-7 lane's harness adopted verbatim, not a third one written.**
`scripts/verify-feat-091-commonmark-diff.mjs` (new) + `npm run verify:feat-091-commonmark-diff`. It compares
the parser's notion of a literal region against the CommonMark 0.31.2 reference AST over **73 contexts × 22
tag lines = 1,606 documents**, in BOTH directions: a reference-literal region the parser folds is a HIDING
disagreement (round 5/round 7's shape); a reference-live fence the parser calls literal is an
OVER-RECOGNITION disagreement (round 6's shape). The oracle asks whether an `html_block` node in the
reference AST covers the fence line; the parser's verdict is whether it folded the token into an
`orchard-notes` block.

- **Current parser (round-7, `52807b9`): 1,606 documents, 0 HIDING + 0 OVER-RECOGNITION.** 630 agree LIVE,
  976 agree LITERAL, so both directions are genuinely exercised.
- **Non-vacuity, committed and self-defending:** the SAME space against the round-6 generation (`5565736`,
  loaded from git history — guarded, SKIPs in a git-less clone) reports **240 disagreements, all 240 HIDING** —
  the exact class round 7 fixed. The check demonstrably catches the direction that hides content.
- **Runtime measured: 94 ms wall** for the whole script (node start + `commonmark` load + the differential
  run twice, current and calibration). That is trivially fast enough for `npm run gate`. **Decision:** it is a
  named on-demand script rather than a gate leg *only because `scripts/gate.mjs` is outside this lane's file
  list* — the fast-and-always argument is otherwise decisive (this grammar's entire failure history is a
  disagreement this check catches). **Recommended follow-up (one line, in-lane for a gate change):** add
  `verify:feat-091-commonmark-diff` to `scripts/gate.mjs`, or fold this section into `verify:feat-091` once
  the round-7/round-8 suite edits settle.
- **Skip path, clean and visible:** if `commonmark` is absent (a clean-room export strips `node_modules` and
  has no network) the whole suite SKIPs with the reason stated and is counted in the TOTAL
  (`0 passed, 0 failed, 1 skipped`, exit 0) — verified by running the script from a directory where the bare
  specifier does not resolve. The reason string warns a verifier NOT to `npm install` to un-skip, because that
  writes into the live tree.

**Also done, per charter (id-uniqueness in the suite I was pointed at):** confirmed
`scripts/verify-feat-091-response-blocks.mjs` still carries the id-uniqueness assertion (`every corpus case
has a UNIQUE id`) and confirmed it is **non-vacuous** — injecting one duplicate id makes the exact expression
report the collision and the assertion fail. No edit needed.

**Bookkeeping honesty (a cross-lane commit contamination, named):** a draft of this differential was written
inline as an `[1d]` section of `scripts/verify-feat-091-response-blocks.mjs` and, while uncommitted, was swept
into commit **`52807b9`** by the round-7 lane's non-pathspec `git add` of that file (the same class as
BUG-108's `3cedfb9` note). That draft used a self-written generator with a known-divergence allowlist rather
than the round-7 lane's stronger harness. This commit **removes** that accidental `[1d]` block from the suite
(197 lines, deletion-only — every other round-7 suite change preserved) and replaces it with the sibling
script above, so there is exactly ONE reference differential and it is the validated one.

**A residual the wider draft surfaced, recorded for the parser lane (not fixed — `public/lib` is out of lane
and under a fixed-commit verification):** a candidate space broader than the 1,606 harness finds two genuine
divergences from *pure* 0.31.2 — (1) `<source>`/`</source>` (the parser's condition-6 tag list is the
documented UNION of 0.30+0.31.2; 0.31.2 dropped `source` — intentional, not a bug), and (2) a lone `</pre>` /
`<pre/>` / `</script>` / `<script/>` etc. at message start, which the reference treats as an HTML block but
the parser folds (its condition-7 `reject` excludes *all* forms of the four type-1 names, where CommonMark
excludes only the OPEN tag — the parser errs toward not-inert, its documented accepted direction). Both are
obscure; (2) is hiding-direction and arguably a round-5-class residual worth the parser lane's eye. Separately,
the SEVENTH clean-room verdict already found a round-8 shape (`list-item-indented-code-before-type7`) outside
the 1,606 space; adding that context to the differential's `CONTEXTS` is the natural next strengthening once
the parser fix lands (adding it now would redden the check against the current parser).

**Verification (numbers as printed, exit codes read directly):**
- `verify:feat-091-commonmark-diff` → **8 passed, 0 failed, 0 skipped, exit 0** (1,606 docs, 0/0
  disagreements; calibration 240 HIDING vs `5565736`).
- skip path (module absent) → **0 passed, 0 failed, 1 skipped, exit 0**.
- **Anti-regressions, all exit 0:** `verify:feat-091` (parser suite, minus the accidental `[1d]`) **178
  passed, 0 failed**; `verify-feat-091-renderer` **VERDICT: PASS — 154 passed, 0 failed** (real Brave/CDP);
  `tsc --noEmit` exit 0.
- `npm run gate` → **GATE: PASS** (leak-gate, check-nul, typecheck), **exit 0**, read directly, never piped.

**Bucket:** low-risk additive tooling (a new devDependency + a new verify script + removal of an accidental
duplicate). No `src/server/*`, no `public/lib/*`, no `docs/prompts/*` touched. An independent clean-room pass
is not required for this change itself; the parser residuals noted above belong to the ongoing parser lane,
whose own clean-room cadence continues.

---

## 2026-08-19 — EIGHTH clean-room verdict: BROKEN. Containers are a STACK, not a prefix (fix)

**regressed-from: the round-7 fix (`52807b9`), which closed the paragraph rule for top-level contexts and
wrote down that its container handling was "one level deep" and approximate.** Fourth consecutive round in
which a documented limitation was the next verdict. The standing rule stands restated: a gap in the hiding
direction is closed or pinned with a test, never shipped as a documented limit.

**THE DEFECT (clean-room input, character for character):**

```
-     code
<my-widget>
````orchard-notes
ADVERSARIAL-MUST-BE-VISIBLE
````
</my-widget>
```

CommonMark 0.31.2 reference AST: `list > item > code_block("code")`, then ONE `html_block` spanning lines
2-6. A list marker followed by **five** spaces sets the item's content column to marker+1, so the content is
**indented code**, not a paragraph — nothing is open when `<my-widget>` arrives, condition 7 applies, and the
whole region is LITERAL. Round 7's container model stripped markers with a greedy regex (`^ {0,3}(?:[-*+]|
\d{1,9}[.)])(?:[ \t]+|$)`), ate all five spaces, saw the paragraph `code`, called the tag lazy continuation,
suppressed condition 7 — and the authored example became a real CLOSED fold with an **empty** `malformed`
list. Same hiding class as rounds 1-7, reached through container geometry.

**MUST-FAIL PROOF, both layers.** At the parser/AST layer: the round-7 parser folds the token, `malformed`
empty, while the reference puts an `html_block` over the fence line. At the BROWSER layer — which the
clean-room pass could NOT confirm (its renderer run died with "Promise was collected") — the round-8 input
was rendered in real headless Brave over CDP, with the parser module swapped by request interception so the
same page ran both generations:

| | in DOM | in rendered text | in the REAL accessibility tree | folds |
|---|---|---|---|---|
| round-7 parser | yes | **NO** | **NO** | 1, closed |
| round-8 parser (fix) | yes | yes | yes | 0 |

5/5 browser checks, exit 0. The hiding claim is confirmed at the layer the reader actually uses.

**THE FIX — the class, not the case.** `advanceLineState` replaces the prefix regex with CommonMark's own
three-phase line algorithm over a real container **stack**: match the open containers, open whatever new ones
the line starts, classify what is left. Implemented: block quotes at any depth; list items at any depth with
the real content-indent rule (1-4 spaces sets the column, 5+ means marker+1 and the rest is indented code, a
bare marker is an empty item); continuation by indentation; lazy continuation; indented code measured from
the container's content column; the paragraph-interrupt rules (a list item may not interrupt a paragraph
unless it has content and, if ordered, starts at 1 — a quote may); tabs expanded to 4-column stops once per
line so every rule is written in columns. Every line now advances the state, including the opener of a
construct the scan consumes whole, so the container stack survives a fence or an HTML region instead of being
reset to empty.

**DELIBERATE OMISSIONS, each with a test that it cannot hide** (`container/omission/*`): list tightness /
two-blank-lines-closes-a-list / list-type changes (grouping only, never literalness); link reference
definitions ending a paragraph (treated as paragraph text — the not-inert direction); and the residual
under-recognition where a fence sits behind a `>` marker or at 4+ raw columns, where no fence is recognised at
all, no fold can be created, and the differential asserts per document that the token stays VISIBLE.

**SECOND DEFECT, found by the reference differential rather than by a clean room** (reported by the lane that
wired `commonmark` in, and fixed here rather than recorded as a limitation because it is the hiding
direction): condition 7 carried a `reject` for the four type-1 tag names in EITHER form. The conditions are
tried in order, so `<pre>` is condition 1 and never reaches 7; what the reject actually removed were complete
CLOSING tags — `</pre>`, `</script>`, `</style>`, `</textarea>` — and `<pre/>`, every one of which the
reference makes a condition-7 HTML block. **A message opening with a lone `</pre>` had a literal region this
parser called live, and an example under it was folded away.** Also fixed: condition 6's tag list is now the
ONE pinned revision (0.31.2) instead of the 0.30 union — the union's justification named "whichever revision
the renderer's markdown library tracks", and there is no such library (the renderer is this repo's own
minimal markdown in `public/lib/dom.js`, which has no HTML blocks at all), while the union made `<source>`
inert under a paragraph where the reference keeps it live (round 6's over-recognition class). The tag/attribute
regexes are now transcribed from the reference's own source (`\s`, not `[ \t]`) rather than paraphrased.

**THE ORACLE, used in both directions and widened, per the coordinator's instruction to reuse the pinned
harness rather than build a third one:**
- `npm run verify:feat-091-commonmark-diff` extended from 73x22=1,606 to **107 contexts x 31 tag lines =
  3,317 documents** — 34 container contexts (markers at depth 1-3, every content indentation across the
  4-column threshold, continuation, lazy continuation, blank lines in containers, mixed containers, each leaf
  kind inside one) and 9 tag rows for the closing-tag / condition-6-list fixes. **0 HIDING, 0
  OVER-RECOGNITION**, 1,257 agree LIVE / 2,060 agree LITERAL. Calibration sha moved to the immediately-prior
  generation: round-7 (`52807b9`) scores **460 disagreements (378 hiding, 82 over-recognition)**; round-6
  (`5565736`) scores 772. **10 passed, 0 failed, 0 skipped, exit 0.**
- A SECOND live differential as leg `[1d]` of `verify:feat-091` — the container space crossed with an
  indent/marker PREFIX on the tag and fence lines: **2,736 documents**, 580 agree LIVE / 1,773 agree LITERAL,
  **0 hiding**, every remaining under-recognition inside the documented set AND token-visible, **0 content
  lost**. Non-vacuous: round-7 scores **36 hiding** on the same space. SKIPs (counted) when the devDependency
  is absent, as in a clean-room export.
- Plus a **30,000-document randomised container fuzz** against the reference in scratch (not committed):
  **0 hiding, 0 content lost**; round-7 scores 12 hiding, round-6 152.

**CALIBRATION TABLE, restated against every prior generation** — the corpus is now **21,183 cases**
(`container` 282, `tagcond` 34 added; `reported` 13 including the round-8 input and its two controls). Numbers
are FAILING CASES; per-invariant counts are cases with ≥1 violation; "falsely flagged" counts WELL-FORMED
cases reporting something other than the legitimate `unknown-block:` advisory:

| generation | failing | I1 (hidden) | I2 | I3 | falsely flagged |
|---|---|---|---|---|---|
| `31acb24^` pre-FEAT-091 | 1,805 | 1,242 | 50 | 1,002 | 2 |
| `31acb24` round-2 | 1,333 | 749 | 50 | 1,022 | 29 |
| `3851f04` round-3 | 1,249 | 774 | 0 | 943 | 0 |
| `326439c` round-4 | 526 | 478 | 0 | 526 | 0 |
| `a2edb76` round-5 | 254 | **0** | 0 | 254 | **254** |
| `5565736` round-6 | 245 | 241 | 0 | 245 | 3 |
| `52807b9` round-7 (attacked) | **45** | **41** | 0 | 45 | 3 |
| **current (round-8)** | **0** | **0** | **0** | **0** | **0** |

Round-7's 45 are 30 `container`, 13 `tagcond`, 2 `reported` — and **zero in every stratum that existed before
this round**, which is exactly the shape of a fix that closes its demonstrated dimension and leaves the one it
wrote down as approximate. 1,558 well-formed cases silent on the current parser.

**HONEST NOTE, carried forward:** the `bq` / `list` / `inline` strata fail zero cases on *every* generation,
including round-7, which this round proved broken in container contexts. They pinned the wrong axis — quote
depths and indents around a FENCE, never the container stack a paragraph lives in. Naming a dimension is not
varying it.

**Verification (numbers as printed, exit codes read directly, never piped):**
- `npm run verify:feat-091` → **249 passed, 0 failed, 0 skipped, exit 0** (21,183-case corpus; new `[1d]`
  container differential; 41 named round-8 checks + 14 round-8b tag-condition checks).
- `npm run verify:feat-091-commonmark-diff` → **10 passed, 0 failed, 0 skipped, exit 0** (3,317 docs).
- `node scripts/verify-feat-091-renderer.mjs` (UNMODIFIED) → **VERDICT: PASS — 154 passed, 0 failed**, exit 0.
- Browser/AX confirmation of the reported input, both generations → **5 passed, 0 failed**, exit 0.
- Anti-regressions, all **exit 0**: `verify:feat-082`, `verify:feat-083`, `verify:feat-083-adversarial`
  (contract HOLDS), `verify:feat-084` (37 passed, 0 failed), `verify:feat-085`, `verify:feat-085-adversarial`
  (contract HOLDS), `verify:feat-085-independent`, `verify:feat-085-readability`, `verify:orchard-transcripts`,
  `verify:bug-087-stale-transcript`.
- `npm run gate` → **GATE: PASS** (leak-gate, check-nul, typecheck), **exit 0**, read directly.

**Spec:** the changes are all in the HUMAN-ONLY half of `docs/prompts/RESPONSE_FORMAT.md` (below the
`response-format-inject:end` marker), so the injected section's size budget is untouched.

**Bucket: regression-prone, high-stakes.** Eighth consecutive BROKEN verdict on this grammar, third in a row
in the paragraph/container dimension, in a file with a history of one-round-per-fix regressions. **An
independent clean-room verify pass is REQUIRED before VERIFIED** — generation must not be its own only
verifier, and the two most productive attack surfaces this round were (a) container geometry the previous
round called approximate and (b) the tag grammar, which a differential found and no reader did.

- **Verified-by:** dispatch openai run 01a01701-b0cc-7523-8a3a-aad2052c12fc (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN


## 2026-08-19 — NINTH clean-room verdict was BROKEN: a randomised differential found what a matrix could not

**The verdict, character for character.** `node ./adversarial-random-diff.mjs` → exit 1:

```
{"kind":"HIDING","n":6088,
 "ctx":["2.     code","# heading","999999999. item","===","2.     code"],
 "tag":"<x data-a:b_c.d-e=1>", "malformed":[],
 "input":"2.     code\n# heading\n999999999. item\n===\n2.     code\n<x data-a:b_c.d-e=1>\n````orchard-notes\nRANDOM-MUST-BE-VISIBLE\n````\nTAIL"}
```

**The finding method is the headline.** Every previous round was found by an *enumerated* differential — a
matrix of contexts someone thought to write down. This one was found by generating **random**
container-and-tag combinations against the reference. The round-8 lane RAN exactly such a fuzz — 30,000
documents, in scratch — and did not commit it, and wrote that down in this ticket. **That gap is this
round.** The randomised differential is now committed as leg `[3]` of `verify:feat-091-commonmark-diff`.

**The root cause was NOT the marker width or the tag grammar.** Both were red herrings, and checking them
was the first thing done: `LIST_MARKER_RE` already derives the content column from the marker's real width
(`sp + markerWidth + spAfter`, with the 5-spaces-means-indented-code branch), and `HTML_TAG_NAME` /
`HTML_ATTR_NAME` / `HTML_ATTR_VALUE` are already the reference's `common.js` classes character for
character. Substituting `<my-widget>` for the exotic tag and `1.` for the nine-digit marker reproduces the
defect unchanged. The cause is `===`:

> "A setext heading underline cannot be a lazy continuation line" (CommonMark 4.3) says the line cannot
> become a **heading**. It does *not* say the line starts some other block. The reference makes this
> explicit — its setext start requires the deepest **matched** container to be the paragraph
> (`container.type === "paragraph"`, blocks.js:603) — so on a lazy line the setext start never fires and
> the line falls through to ordinary paragraph continuation **text**.

Read the other way, `===` closed the list item's paragraph; `2.     code` then restarted one (its own
paragraph-interrupt rule also does not apply, because the deepest matched container is the document, not a
paragraph); the tag line looked like it was interrupting a paragraph, condition 7 was suppressed, the region
was not literal, and the authored example became a real **CLOSED fold** — in the DOM, absent from the
rendered text and from the real accessibility tree, `malformed` **EMPTY**.

**FIXED AS THE CLASS, and the class turned out to be five causes, not one shape.** Committing a randomised
differential first, then fixing what it reported until it was silent, is what surfaced the other four —
none of which the 3,317-document enumerated matrix contains:

| # | cause | what it is |
|---|---|---|
| 1 | **lazy continuation vs the setext clause** | the reported defect (`isParagraphContinuationText`) |
| 2 | **no leaf state across lines** | the body of a fence or HTML block *inside a container* (`>\`\`\``, `> <div>`) was re-classified line-by-line as prose, leaving a phantom paragraph open (`classifyLeaf` + phase 0 of `advanceLineState`) |
| 3 | **"at most one blank line" for an empty list item** | a blank matched an empty item forever, so a tag after it landed *inside* the item and a fence at column 0 became a fold (`matchContainers`) |
| 4 | **two detections that could disagree** | the top-level scan asked `openerOf`/`htmlStartOf` of the **raw** line (0-3 raw columns); the classifier asked the same of the line with its **container prefix** consumed (`restOfLine`, `para.opener`) |
| 5 | **unbounded extents** | a fence could take its **close**, and an HTML region its end, from outside the container it was opened in (`containerBoundOf`) |

**Cause 4 retires a documented limitation that was FALSE, and this is the round's most important
correction.** Round 8 wrote: *"a `>`-prefixed fence is not an opener to this module at all, and neither is a
fence at 4+ columns inside a list item. Neither can hide anything — no fence recognised means no fold
created."* The second sentence is wrong. Under-recognising the **literaliser** while still recognising the
**fence** hides content:

```
*     item
    <li a='1'/>
  ````orchard-notes
  R9-ITEM-COLUMN-VISIBLE
  ````
```

The item's content column is 2, so the tag is an HTML block **inside** the item and the fence under it is an
EXAMPLE — which is what the reference says (`html_block [[2,3],[5,6]]`). The tag sits at 4 **raw** columns so
the raw-line test missed it; the fence at 2 raw columns was recognised; the authored content became a real
closed fold. Fourth round running that a documented limitation was the next verdict — and this round it was
two of them at once (see also the two retirements below). **There are no documented limitations left in the
hiding direction: every one is now closed, or pinned by a test proving it cannot hide.**

**TWO PRIOR RULES RETIRED AS FALSE INERTNESS**, each with the reference as arbiter and both differentials as
proof, both of which the fuzz reported as over-recognition on legal input:
- **Round 5's** "an inert region never ends while a fence opened inside it is still open". The reference ends
  a type-6/7 HTML block at the **first blank line**, unconditionally — a ` ``` ` inside it is literal text,
  not an open fence. Verified on the exact corpus input: `html_block [[2,1],[3,7]]`, then a real
  `code_block` with info `orchard-notes`. The corpus case and the named check now assert the reference's
  verdict; the `round-5:` check is renamed `round-9:` so the reversal is visible in the diff.
- **Round 8's** "link reference definitions are treated as paragraph text, i.e. a paragraph stays OPEN — the
  not-inert direction — and pinned". The direction is not stable: a setext underline over a
  definition-only paragraph resolves the definitions out, underlines nothing, and becomes the paragraph
  itself — so the paragraph really does stay open, but the old code made it a **heading**, which closes it.
  `LINK_REF_DEF_RE` now tracks it. The multi-line definition form is still not recognised, and that
  residual is pinned: not recognising one leaves `onlyRefs` false, which CLOSES the paragraph, which is the
  direction that keeps a region literal and VISIBLE.

**THE DELIVERABLE THAT ENDS THE CYCLE — a committed randomised differential**
(`verify:feat-091-commonmark-diff`, leg `[3]`). It generates **fresh** documents on every run: 0-4 context
lines, each 0-4 columns of indent then 0-2 nested container markers (quotes, and list markers with a random
**1-10 digit** count, either delimiter, and 0-7 following spaces or a tab — both sides of the nine-digit
limit and both sides of the 5-space threshold) then a random leaf; a random tag line (names inside and
outside the condition-1/6 lists, 0-2 attributes over the spec's character classes, quoted / single-quoted /
unquoted values, whitespace runs including **tab and form feed**, optional self-closing slash and trailing
text); and a fence of either character, 3-5 long, behind a random shared indent or container prefix.
The seed is random per run and **printed**; `FEAT091_FUZZ_SEED=<n>` replays a failure exactly and
`FEAT091_FUZZ_N=<n>` widens it. Three assertions per run: 0 HIDING, 0 OVER-RECOGNITION, and — stated over
the reader rather than the parse tree — **0 LOST**: every unfolded token must be VISIBLE in the parse.

- **Cost and non-vacuity, as printed:** 20,000 documents in **~260-300 ms** (the whole script is ~4 s
  including the enumerated legs). Per run: **0 / 0 / 0**, with ~2,800 agree-LIVE and ~17,100 agree-LITERAL.
  The round-8 generation (`10db355`) scored on the SAME documents: **309 disagreements (12 hiding, 297
  over-recognition)**. Twenty consecutive fresh-seed runs: **17 passed, 0 failed, every run**. One widened
  run, `FEAT091_FUZZ_SEED=20260819 FEAT091_FUZZ_N=500000`: **500,000 documents in 5,802 ms, 0 / 0 / 0**,
  where round-8 scores **7,441 disagreements (346 hiding, 7,095 over-recognition)**.
- Compare the enumerated corpus on the same generation: round-8 fails **25 of 21,191** cases with only **4**
  hiding — and all 4 are the round-9 inputs added by this lane. The matrix barely contains the class; the
  random space contains it 346 times per 500k. That is the argument for committing the fuzz, in numbers.

**BROWSER + ACCESSIBILITY-TREE CONFIRMATION, which the clean-room verifier explicitly could not do**
("no existing browser fixture accepts arbitrary input"). Both generations, same input, real
`brave --headless=new` over CDP, real `Accessibility.getFullAXTree`:

| | pre-fix (`28bc233`) | fixed |
|---|---|---|
| parser | 1 `orchard-notes` block, `malformed: []` | 0 blocks, `malformed: ["inert-html:orchard-notes@line7"]` |
| render | 1 fold, **closed**, token inside it | 0 folds |
| token in the DOM | yes | yes |
| token in the **accessibility tree** | **NO** | **YES** |

→ **4 must-FAIL assertions PASS on the old parser, 3 PASS on the new. 0 failed, exit 0.**

**The fixture gap is closed structurally, without touching the renderer script.** `reportedDefectCases()` in
`scripts/lib/feat-091-fold-corpus.mjs` IS the arbitrary-input door: leg `[Q]` of the renderer suite renders
every case through the real browser and grades R1/R2 on **rendered text**, and forces every `reported` input
into the accessibility-tree read. Eight round-9 cases were added there — the defect input, its
`orchard-answer` mirror, the setext control in **both** directions, and one case per remaining cause — so
arbitrary input is now checkable in the browser by adding a case, not by editing the fixture.

**CALIBRATION TABLE, restated against every prior generation** — the corpus is now **21,191 cases**
(`reported` 21, +8 round-9 inputs), 1,556 well-formed. Numbers are FAILING CASES; per-invariant counts are
cases with ≥1 violation; "falsely flagged" counts WELL-FORMED cases reporting something other than the
legitimate `unknown-block:` advisory:

| generation | failing | I1 (hidden) | I2 | I3 | falsely flagged |
|---|---|---|---|---|---|
| `31acb24^` pre-FEAT-091 | 1,851 | 1,269 | 50 | 1,048 | 2 |
| `31acb24` round-2 | 1,379 | 776 | 50 | 1,068 | 29 |
| `3851f04` round-3 | 1,295 | 801 | 0 | 989 | 0 |
| `326439c` round-4 | 572 | 505 | 0 | 572 | 0 |
| `a2edb76` round-5 | 289 | 2 | 0 | 289 | 269 |
| `5565736` round-6 | 271 | 246 | 0 | 271 | 5 |
| `52807b9` round-7 | 70 | 45 | 0 | 70 | 5 |
| `10db355` round-8 (attacked) | **25** | **4** | 0 | 25 | 2 |
| **current (round-9)** | **0** | **0** | **0** | **0** | **0** |

Round-8's 25 are 10 `list`, 6 `bq`, 5 `reported`, 2 `container`, 2 `html5` — the 5 `reported` are this
round's inputs, and the other 20 are the corpus expectations this round REVERSED (a quoted fence and a fence
at an item's content column are now openers, per the reference; `list/*/ind4/under-recognised` is renamed
`list/*/ind4/live-in-item` so the reversal is visible in the diff rather than silent).

**HONEST NOTE, and it is a different one this round.** The previous entry's honest note was that the
`bq`/`list`/`inline` strata failed zero cases on every generation — they pinned the wrong axis. That is
still true, and worse than stated: those strata pinned the *documented limitation* rather than the
reference's verdict, so they actively certified the under-recognition that cause 4 turned into hiding. A
stratum that asserts a documented limitation is not a test of the invariant; it is a test of the
documentation. Where a construct's verdict is decidable by the reference, the corpus now records the
**reference's** verdict.

**regressed-from:** `10db355` (round-8) for causes 4 and 5 and the linkref retirement; `a2edb76` (round-5)
for the retired inert-extension rule. Causes 1-3 predate both.

**Verification (numbers as printed, exit status read directly, never piped):**
- `npm run verify:feat-091` → **249 passed, 0 failed, 0 skipped, exit 0** (21,191-case corpus).
- `npm run verify:feat-091-commonmark-diff` → **17 passed, 0 failed, 0 skipped, exit 0** (3,317 enumerated +
  2,736 container + 20,000 randomised documents; both calibrations non-vacuous).
- `node scripts/verify-feat-091-renderer.mjs` (**UNMODIFIED** — verified by `git diff --name-only`) →
  **VERDICT: PASS — 154 passed, 0 failed**, exit 0; 14,223 cases rendered, 5,445 folds, AX read over 220.
- Browser/AX must-FAIL + fixed proof, both generations → **7 passed, 0 failed**, exit 0.
- Anti-regressions, all **exit 0**: `verify:feat-082`, `verify:feat-083`, `verify:feat-083-adversarial`
  (contract HOLDS), `verify:feat-084` (37 passed, 0 failed), `verify:feat-085`,
  `verify:feat-085-adversarial` (contract HOLDS), `verify:feat-085-independent`,
  `verify:feat-085-readability`, `verify:orchard-transcripts`, `verify:bug-087-stale-transcript`.
- `npm run gate` → exit status read directly, never piped.

**FLAKE OBSERVED, not caused by this change, for the renderer lane.**
`scripts/verify-feat-091-renderer.mjs` failed twice with `FATAL: Error: Promise was collected` in leg `[Q]`
and then passed 4/4 on the identical tree; the HEAD tree also passes. Reproduced in a scratch harness: the
page-side loop **completes** (all 120 cases pushed, 26 ms) and the CDP `Runtime.evaluate` promise is
collected anyway — a V8/CDP GC race in `Cdp.eval`, not a parser or renderer defect. Worth a retry or a
retained reference in that file, which this lane did not touch.

**Spec:** all changes are in the HUMAN-ONLY half of `docs/prompts/RESPONSE_FORMAT.md` (below the
`response-format-inject:end` marker); the injected section is byte-unchanged and its size budget untouched.

**Bucket: regression-prone, high-stakes.** NINTH consecutive BROKEN verdict on this grammar, fourth in a row
in the paragraph/container dimension, and this round REVERSED two rules earlier rounds shipped as safety
measures. **An independent clean-room verify pass is REQUIRED before VERIFIED.** The two retirements and
cause 4 are the places to attack: each makes the parser fold *more* than the previous generation did, which
is the hiding direction, and each is justified only by agreement with the reference implementation.

- **Verified-by:** dispatch openai run 01a01734-3ca0-7743-9ec2-080eac4c506c (clean-room, `scripts/independent-verify.mjs`) — VERDICT: HOLDS
- **Verified-by:** dispatch openai run 01a01738-f736-7b83-b614-f4dd839d7b3c (clean-room, `scripts/independent-verify.mjs`, SECOND pass — browser + accessibility-tree scoped) — VERDICT: BROKEN


## 2026-08-19 — TENTH clean-room verdict was BROKEN: a link reference definition SPANS LINES (fix)

**Second independent clean-room pass on `91b35ab`.** The reported input, character for character:

```
[ref]:
/url
===
<my-widget>
````orchard-notes
NARRATION
````
```

Live tree: `blocks: []`, `malformed: ["inert-html:orchard-notes@line5"]`. Renderer AX read: *"a real notes
body after a multiline link definition is absent while closed"* — `exposedInFullAXTree: true`.

### The defect, and which direction it is

A well-formed `orchard-notes` block was **LOST**: the fold disappeared, its narration was exposed as open
prose, and uncertainty was reported on **valid** input. The renderer and the counter agreed on the wrong
classification — the both-wrong-together shape.

Round 9 recognised a link reference definition with a **one-line** regex, `[label]: dest "title"` all on one
line, and wrote the multi-line form down as a documented limitation: *"not recognised, and cannot hide"*.
That was true about hiding and irrelevant. CommonMark 4.7 lets the label, destination and title **each sit
on its own line**, so to the reference the two lines above are one definition; at `===` it resolves the
definition off the front of the paragraph, finds nothing left to underline, makes **no heading**, and the
paragraph stays **OPEN** — which suppresses condition 7 on `<my-widget>` and leaves the fence **LIVE**.
Round 9 saw no definition, made `===` a setext heading, closed the paragraph, let condition 7 fire, and
turned the authored fold into literal prose. **The standing rule binds in both directions: a gap that loses
a block is as unshippable as one that hides content.**

**A wider regex cannot fix this**, which is why the fix is structural: whether line *N* is inside a
definition depends on lines 1..*N*-1. `[a]: /u` + `"t"` is ONE definition; `[a]: /u` + `"t"` + `more` is a
definition plus the paragraph `more`, because a title that does not end its line is discarded.

### The fix — the reference's own parser, not a patch for the two-line case

- The paragraph now carries its **accumulated content** — exactly the reference's `_string_content` — as
  `refContent` in the line state, replacing round 9's `onlyRefs` boolean.
- `linkReferenceDefinitionLength` / `refDestinationEnd` are a direct port of cmark-js's `parseReference`
  and `parseLinkDestination`: the `\[...\]` label with its 1000-char / dotAll rules, `spnl` (whitespace
  with **at most one** line ending), the `<...>` and balanced-paren destination forms, the three title
  delimiters, the discard-the-title-and-retry rule, and the non-blank-label check.
- They run at exactly the one place the reference runs them: the **setext block start**. Anything left
  after resolution becomes a heading and closes the paragraph; nothing left means no heading at all and the
  underline becomes the paragraph's new content, still open.
- Content is accumulated from the **RAW** line, not the tab-expanded one. `spnl` is `/^ *(?:\n *)?/` and
  does **not** match a tab, so `[a]:<TAB>/url` is not a definition; expanding the tab first would INVENT
  one, and inventing a definition is the hiding direction. `tabSourceMap` recovers the raw text after the
  container prefix has been consumed in columns.
- **Lazy continuation lines are accumulated too.** Round 9's lazy branch asserted "a lazy line is ordinary
  text by definition" and zeroed the flag; `> [ref]:` / `/url` / `> ===` is one definition, and zeroing it
  there loses the block in a quote.
- Accumulation stops as soon as the content cannot start a definition, which bounds the state.

### Every other construct whose extent can span lines, enumerated

Asked for as a class, so all of them, with where each is accounted for: **fenced code blocks** and **HTML
blocks 1-5/6-7** (open leaf state since round 9, bounded by their container); **setext headings** (the
paragraph above them — this round); **paragraphs and lazy continuation** (this round); **indented code
across a blank line** (line-by-line classification cannot differ: every line is CLOSED to the classifier
either way and a fence at 4+ columns is not an opener — now generated by the fuzz and at zero
disagreements); **list tightness / two-blank-lines** (grouping only, never literalness); **inline
constructs** (settled after block structure, so they cannot literalise; `inline` stratum). No new
documented limitation is created by this round.

### The differential was EXTENDED, and the calibration re-stated

The committed fuzz generated only single-line leaves, so no multi-line construct could ever appear — that
is the gap the defect came through. It now emits whole multi-line constructs: definitions split over up to
three lines with `\n`- and TAB-bearing separators and titles that may or may not end their line, multi-line
HTML blocks of conditions 2-5, an unterminated fence, and indented code broken by a blank; continuation
lines carry the container prefix, a blanked-out prefix, or nothing (so lazy continuation of a half-finished
construct is generated). One document in four ends its context with a definition block plus a setext
underline **immediately above the tag line**, because that adjacency is what decides condition 7 and
leaving it to chance made this a needle. The enumerated matrix gained 21 multi-line `linkref` contexts
(107 -> 128 contexts, 3,317 -> 3,968 documents), and the corpus gained 12 `para` pins, 3 container pins and
4 `reported` cases.

The randomised calibration is now a **TABLE over every prior generation**, not just the last one, each row
with the direction its own defect lived in. On 1,000,000 fresh documents, same seed:

| generation | disagreements | hiding | over-recognition | lost |
|---|---|---|---|---|
| `5565736` round-6 | 212,719 | 188,630 | 24,089 | 0 |
| `52807b9` round-7 | 144,686 | 108,592 | 36,094 | 0 |
| `10db355` round-8 | 21,645 | 1,518 | 20,127 | 0 |
| `91b35ab` round-9 | 8,930 | 5,310 | 3,620 | 0 |
| **current (round-10)** | **0** | **0** | **0** | **0** |

### Corpus calibration, re-run against the round-10 corpus (21,282 cases, 1,609 well-formed)

A calibration quoted from an older corpus is not a calibration of the corpus that ships, so the whole table
was re-computed:

| generation | failing | I1 (hidden) | I2 | I3 | falsely flagged |
|---|---|---|---|---|---|
| `31acb24^` pre-FEAT-091 | 1,889 | 1,307 | 50 | 1,086 | 2 |
| `31acb24` round-2 | 1,417 | 814 | 50 | 1,106 | 29 |
| `3851f04` round-3 | 1,333 | 839 | 0 | 1,027 | 0 |
| `326439c` round-4 | 610 | 543 | 0 | 610 | 0 |
| `a2edb76` round-5 | 330 | 2 | 0 | 330 | 310 |
| `5565736` round-6 | 297 | 272 | 0 | 297 | 5 |
| `52807b9` round-7 | 105 | 45 | 0 | 105 | 40 |
| `10db355` round-8 | 61 | 4 | 0 | 61 | 38 |
| `91b35ab` round-9 | **41** | 5 | 0 | 41 | **36** |
| **current (round-10)** | **0** | **0** | **0** | **0** | **0** |

Round 9's 41 are the multi-line definition cases: 36 are well-formed input falsely flagged with its
authored fold lost, and 5 additionally hide content inside a container.

### MUST-FAIL proofs, before the fix

- **Parser layer:** the 98 round-10 cases graded against `91b35ab` -> **41 violating**, including
  `reported/round10-multiline-linkref-loses-a-notes-fold: I3 flags differ / want [] / got
  [inert-html:orchard-notes@line5]` — the verifier's exact observation. Against the current parser:
  **0 violating**.
- **Real browser + real accessibility tree**, driving `public/lib/digest.js` in headless brave over
  `reportedDefectCases()` (the door the verifier used), with `91b35ab` installed as the parser:
  `LOST FOLD reported/round10-multiline-linkref-loses-a-notes-fold: R10-NARRATION
  exposedInFullAXTree=true (folds=0 closed=0)` and the same for the multi-line-title case —
  **2 violations, exit 1**. With the fix: **0 violations, exit 0**, narration folded and absent from the
  AX tree, tail present.

### A render invariant the suite did not have: R3

`gradeRender` had R1 (nothing escapes into a closed fold) and R2 (nothing vanishes). Neither can see a fold
being **LOST** — nothing was hidden and nothing had vanished, so the render leg was silent on this defect
while the browser showed it. **R3** is added: a token a WELL-FORMED case authors inside `orchard-notes`,
and the grammar confirms as a block, must actually be inside a **closed fold** in the real render. It is
scoped to well-formed cases with an explicit `expected` fold, because degrading narration to visible prose
is correct for malformed input.
**Handoff, not a claim:** `scripts/verify-feat-091-renderer.mjs` is another lane and was not touched, so it
still filters violations for `R1`/`R2` only — R3 is computed but not yet asserted there. One added
`check(...)` line in that file makes it standing; until then the browser proof above and the parser-layer
I3 pin are what hold the invariant.

**regressed-from:** `91b35ab` (round-9) — its own note that the multi-line link-reference form "cannot
hide" was the documented limitation this verdict came through, the fourth documented limitation in a row to
turn out to be a defect.

### Verification (numbers as printed, exit status read directly, never piped)

- `npm run verify:feat-091` -> **249 passed, 0 failed, 0 skipped, exit 0** (21,282-case corpus, 1,609
  well-formed).
- `npm run verify:feat-091-commonmark-diff` -> **23 passed, 0 failed, 0 skipped, exit 0** (3,968 enumerated
  + 2,736 container + 20,000 randomised documents; all four calibration rows non-vacuous).
- Widened randomised leg: `FEAT091_FUZZ_N=1000000` -> **1,000,000 documents in 17,630 ms; 149,176 agree
  LIVE, 850,824 agree LITERAL; 0 hiding / 0 over-recognition / 0 lost**, exit 0. Also clean at 400,000.
- `node scripts/verify-feat-091-renderer.mjs` (**UNMODIFIED**) -> **VERDICT: PASS — 154 passed, 0 failed**,
  exit 0, first run, no GC race.
- Browser/AX must-FAIL + fixed proof, both generations -> **2 violations exit 1** on `91b35ab`,
  **0 violations exit 0** on the fix.
- Anti-regressions, all **exit 0**: `verify:feat-082` (52 passed), `verify:feat-083` (22/22),
  `verify:feat-083-adversarial` (contract HOLDS), `verify:feat-084` (37 passed),
  `verify:feat-085` (58/58), `verify:feat-085-adversarial` (contract HOLDS),
  `verify:feat-085-independent` (60 passed), `verify:feat-085-readability` (32 passed),
  `verify:orchard-transcripts` (15 passed), `verify:bug-087-stale-transcript` (6/6).
- `npm run gate` -> **GATE: PASS — safe to commit. (exit 0)**, unpiped, status read directly.

**Spec:** all changes are in the HUMAN-ONLY half of `docs/prompts/RESPONSE_FORMAT.md` (below
`response-format-inject:end`); the injected section is byte-unchanged and its size budget untouched.

**Bucket: regression-prone, high-stakes.** TENTH consecutive BROKEN verdict on this grammar and the fourth
running in the paragraph dimension. **An independent clean-room verify pass is REQUIRED before VERIFIED.**
Where to attack: the ported `parseReference` is transcribed from cmark-js 0.31.2 and any transcription slip
is a silent divergence; the RAW-vs-expanded content path through `tabSourceMap` and `restOff` is new and is
the place a container-relative offset can be off by one; and R3 is not yet asserted by the renderer suite.

### 2026-08-19 — R3 is now STANDING in the renderer suite (handoff closed)

The round-10 handoff above ("one added `check(...)` line makes it standing") is done.
`scripts/verify-feat-091-renderer.mjs` no longer filters violations to `R1`/`R2` only: leg **[Q]** now
also asserts `R3 — no authored orchard-notes fold was LOST`. This closes the exact blind spot that let the
tenth defect pass the render leg silently — R1/R2 can only see content ESCAPING a fold; neither can see a
fold being LOST.

**Non-vacuity proven, both generations (same corpus, only `public/lib/response-blocks.js` swapped):**
- On the fix (current) -> `node scripts/verify-feat-091-renderer.mjs` **VERDICT: PASS — 155 passed, 0
  failed, exit 0** (14,314 generated cases rendered, 5,497 closed folds; R1/R2/R3 all green), first run,
  no GC race.
- On `91b35ab` (round-9 parser) -> **VERDICT: FAIL — 152 passed, 3 failed, exit 1**, with **R3** firing on
  the round-10 defect shape itself (`para/linkref-multiline-dest-setext/*`: "was authored inside
  orchard-notes but is NOT in a closed fold (the fold was lost)"), alongside R1. So the check genuinely
  catches the defect it was added for, rather than being decoration.

Also corrected two stale header comments in `public/lib/response-blocks.js` (comment text only; parser
logic byte-unchanged, verified by `cmp`): the round-8 bullet claiming the main scan recognises fences/HTML
"at 0-3 columns of RAW indent only … that is UNDER-recognition [which] cannot hide anything", and the
matching round-4 item-4 claim that "a `>`-prefixed line is not an opener to this module at all". Both were
explicitly retired by round 9 (note 4 / the `advanceLineState` scan comment): recognition is in CONTAINER
CONTEXT, so a `>`-prefixed or list-nested `orchard-notes` fence really folds — verified live
(`> ````orchard-notes` -> `shape: structured, blocks: [orchard-notes]`).

Anti-regressions, all **exit 0**: `verify:feat-091` (249/0), `verify:feat-091-commonmark-diff` (23/0),
`typecheck` clean, `npm run gate` -> **GATE: PASS (exit 0)**, status read directly, unpiped.

- **Verified-by:** dispatch anthropic run 9ee724de-f3b0-46a6-b9bb-38a5cb8aa5b8 (clean-room, `scripts/independent-verify.mjs`, ELEVENTH pass on `1290caf`, `docs/*` excluded via a synthetic base; cross-provider openai was attempted first and died on a provider content flag, so decorrelation was reduced) — VERDICT: HOLDS

## 2026-08-19 — ELEVENTH verdict's residual closed: the randomised corpus is now RENDERED, and the theme dimension is probed

The eleventh independent pass returned **HOLDS** and named exactly one residual:

> the browser leg covered only 3 fixed shapes; the 60,000-document fuzz corpus was graded in node only,
> never rendered. The theme dimension went unprobed.

That is not an incidental gap. It is the shape of the **tenth** defect one level up: round 10 passed every
parser-level check it had and was caught only when a verifier rendered the input in a real browser and read
the accessibility tree. A randomised space explored only where the reader is *not* is that same blind spot
with a much bigger number attached to it. Both halves are now standing parts of the suite, not a one-off
script.

### The generator moved, so there is only ONE fuzz space

`rngFrom` / `fuzzDoc` / `FUZZ_TOKEN` moved out of `scripts/verify-feat-091-commonmark-diff.mjs` into
`scripts/lib/feat-091-fold-corpus.mjs`, beside the enumerated corpus, for the reason the enumerated corpus
already lives there: the parser leg and the render leg must not each invent their own inputs, or a property
that holds in node and fails in the browser is invisible by construction. The differential imports it from
there now. **The move was proven behaviour-preserving rather than asserted:** 20,000 documents x 4 seeds
(80,000 documents), byte-identical before and after, fence and close line numbers included.

### [R] — a stratified sample of the randomised space, rendered for real

New leg in `scripts/verify-feat-091-renderer.mjs`. Documents come from `fuzzDoc`; the **CommonMark
reference** is the oracle, in both directions, and grading is on rendered TEXT plus the real accessibility
tree — never on DOM structure, because content inside a closed fold is present in the markup and absent to
the reader, which is exactly how the last two defects passed their suites.

| invariant | statement | the direction it covers |
|---|---|---|
| F1 | reference says LITERAL -> the token is not inside a closed fold, and is visible | hiding (rounds 5-8) |
| F2 | the token is rendered somewhere | loss |
| F3 | reference says LIVE -> the token **is** inside a closed fold | fold-lost (round 9/10) |
| F4 | the trailing `TAIL` line is visible with no interaction | a fold that swallows the rest of the message |

### The sampling judgement, and the measurement it was made from

Rendering hundreds of thousands of documents in a browser is not viable; rendering three is what left this
gap. So the per-document cost was **measured in this rig before the size was chosen**, and it is
re-measured and printed on every run so the choice cannot go stale:

| sample | browser wall | per document |
|---|---|---|
| 100 | 15 ms | 0.15 ms |
| 1,000 | 140 ms | 0.14 ms |
| 5,000 | 628 ms | 0.13 ms |
| 20,000 | 2,539 ms | **0.13 ms** |

Flat to 20,000 — it is that cheap because grading needs the DOM and the fold state, not a paint. The
expensive things (layout, the accessibility tree, pixels) are the ones that stay capped.

Given that, **the size is pinned to a property rather than to a round number: the browser renders as many
documents per run as the node differential grades per run** (`FUZZ_N` default 20,000). The render leg is no
longer a rounding error beside the node leg — every run, the two cover comparable ground, which is the
residual answered on the differential's own terms. The pool is **120,000** (6x the sample) so the strata
have something to select from rather than taking everything they can find.

**The sample is stratified toward where this grammar has actually broken**, not toward where it might
(`FUZZ_STRATA` / `pickFuzzSample` in the corpus module). Quotas are shares, filled in order, deduplicated,
with any shortfall spilling into `random`, and the realised counts are printed every run because a stratum
that quietly contributed nothing is a sample that is not what it says it is:

| stratum | share | why it is there | realised |
|---|---|---|---|
| `uncertain` | 22% | the parser reported something in `malformed` — every clean-room verdict so far has lived where the parser was unsure | 4,400 |
| `linkref` | 16% | link reference definition / setext underline adjacency — rounds 9 and 10 | 3,200 |
| `htmlblock` | 12% | an HTML start condition above the fence — rounds 5, 6, 7 | 2,400 |
| `container` | 10% | stacked quote/list markers — round 8 | 2,000 |
| `tilde` | 8% | a `~~~` fence — round 4 | 1,600 |
| `live` | 12% | the reference says the fence really folds. Held as its own stratum because **F3 can only be observed on a document that is supposed to fold**, and live documents are ~15% of the space, so an unstratified sample under-weights exactly the direction round 9 broke | 2,400 |
| `random` | 20% | unstratified, so the six strata above — a list of what we already know — cannot themselves become the blind spot | 4,000 |

### Non-vacuity: the leg FAILS on the generations it claims to catch

A browser leg that cannot demonstrate it would have caught the defects we already know about is
decoration. So the **served parser bytes are swapped for a pinned prior generation** via CDP request
interception (`Fetch.enable` + `fulfillRequest`, then a fresh navigation, because a module map is
per-Document) and this leg's own grader is required to fire **in that generation's own defect direction**,
above a floor — not merely `> 0`, because a calibration that passes on a single hit is one unlucky shuffle
from a green run that proved nothing. Same code path, same grader, same documents; only `response-blocks.js`
differs. Fixed shas, never a moving baseline.

| generation | direction required | floor | observed on 8,000 rendered documents |
|---|---|---|---|
| `91b35ab` round 9 (fold-lost) | F3 | 5 | **F3 = 53**, F1 = 100 |
| `52807b9` round 7 (hiding) | F1 | 20 | **F1 = 1,758**, F3 = 456 |
| **current** | — | — | **F1/F2/F3/F4 = 0 over 20,000** |

Measured rates over 20,000 rendered documents: round 9's own direction ~0.6%, round 7's ~21%. And the live
parser bytes are re-verified by sha256 after the calibration, so a substituted module cannot leak into the
rest of the run.

### [T] — the theme dimension, asked in PIXELS

No pass has touched this, and it is a genuine hole in *every* check we have: they all read structure or the
accessibility tree, and **a CSS regression that reveals a folded body in one palette is invisible to all of
them.** The fold would still be `open=false`, still announce `expanded=false`, still be absent from the AX
tree, and the reader would still be looking at the narration.

So it is asked in pixels, with no reference image and no human eye: render the **same** notes fold twice,
closed, with two bodies that share not one glyph. If the fold really hides its body the two captures are
**byte-identical**; if any of it is painted they differ. Theme is set via CDP `prefers-color-scheme`
emulation with `data-theme` cleared — never localStorage. Per theme:

- closed-A vs closed-B **byte-identical** (light `d0570d9f`, dark `d64e768c`) — nothing of the body reached
  the screen;
- **and the same height** (120 px both), because a body painted in the background colour would pass the
  pixel comparison and still push the layout;
- the **open** capture differs and is 857 px — the anti-vacuity control, without which the comparison
  proves nothing;
- the capture is graded on its own decoded pixels (`shot-luma`): light luma 250.9, dark 21.8;
- `TAIL-AFTER-THE-FOLD` on screen below the closed fold in both.

### What is now covered, and what is NOT

Covered: 20,000 randomised documents rendered through the app's own renderer per run, graded against the
reference in both directions; ~150 of them read out of a real accessibility tree; a closed fold proven
closed in pixels in both themes; and the whole leg demonstrated to fail on two prior generations.

Not covered, stated because a sample that hides its own bound is worse than no sample:

1. **It is a sample.** 20,000 of 120,000 generated, out of an unbounded space. It filters defect CLASSES
   dense enough to appear at roughly a 1-in-20,000 rate in the stratified sample; a rarer class can still
   pass a green run. (Both calibrated directions are far above that floor — 0.6% and 21% — which is why
   the floors are meaningful rather than decorative.)
2. **Only ~150 sampled documents get an AX read, and only two hand-built folds get a pixel read.** A defect
   invisible in rendered text *and* rare would need both widened.
3. **The oracle is cmark-js.** Anywhere the reference itself diverges from the spec is invisible to this
   leg in exactly the way it is invisible to the node differential.
4. **The theme leg tests two themes and one fold shape.** It answers "is a closed fold closed in this
   palette", not "is every construct legible in every palette" — that remains the human visual review.

### The truncation dimension, probed and closed with evidence (not previously stated either way)

The standing rule is that a file another process writes must be tested PARTIAL, and a streamed assistant
message is exactly that. The concrete worry: a partially-received message whose `orchard-notes` fence has
arrived but whose `orchard-answer` has not could fold the reader's decision away mid-stream.

- **Code fact:** streaming renders through `prose()`, not `assistantProse()` — `public/app.js`
  `renderStreamNow` / `scheduleStreamRender`. The block grammar runs **only on the settled turn-end
  message** (`case 'text'`) and on `finishStream`'s interrupted path, which also uses `prose()`. So a
  mid-flight message never produces a fold at all.
- **Measured anyway,** because the turn-end path falls back to the accumulated (possibly truncated) stream
  text via `e.text || th.stream.text`: every line-boundary prefix of the whole enumerated corpus plus 4,000
  fuzz documents was parsed and graded on the property that matters — *no text folded in a prefix that is
  not folded in the complete message*. **169,828 prefixes, 0 violations.** Truncation only ever moves
  content toward visible here, which is the safe direction and matches the unterminated-fence contract [I]
  already pins.

### Verification (numbers as printed, exit status read directly, never piped)

- `node scripts/verify-feat-091-renderer.mjs` -> **VERDICT: PASS — 178 passed, 0 failed**, exit 0 (was
  155). Run **5 times**, 5/5 green, 21-24 s wall each; **no "Promise was collected" GC race in any run.**
  Honest note: this leg adds ~250 additional awaited page evaluations per run (the batch loop), so exposure
  to that race is in principle *higher* per run, not lower — 5/5 is the evidence, not a proof.
- `npm run verify:feat-091` -> **249 passed, 0 failed, 0 skipped**, exit 0.
- `npm run verify:feat-091-commonmark-diff` -> **23 passed, 0 failed, 0 skipped**, exit 0, unchanged after
  the generator move (all four calibration rows still non-vacuous).
- Generator-move equivalence: 20,000 documents x seeds 1/42/999/123456 -> **0 differences**.
- Truncation probe: **169,828 prefixes, 0 violations**.
- Anti-regressions, all exit 0: `verify:feat-082` (52 passed), `verify:feat-083`, `verify:streaming-md`,
  `verify:bug-067`. `verify:browser` fails 1/24 on `CONTROL: plain curl is BLOCKED on the target site` —
  an external-network control in the stealth-browser lane, unrelated to and untouched by this change (no
  file it loads was modified).
- `npm run typecheck` -> exit 0. `npm run gate` -> **GATE: PASS — safe to commit. (exit 0)**, unpiped,
  status read directly.

### Judgement: can FEAT-091's grammar work be called VERIFIED?

**Not yet — but the remaining residuals are, for the first time in this ticket, acceptable rather than
defects wearing labels.** Applying the history rather than the current list at face value:

Eleven rounds, **four of which were a documented limitation becoming the next verdict** (rounds 7, 8, 9, 10
each came through a place a previous round had written down as "cannot hide"). The test that history
demands is not "is the list short" but "does any item on the list assert that something *cannot* go wrong."

- Residual 1 (it is a sample) is a **bound on confidence**, not a claim of safety. It says "a class rarer
  than 1-in-20,000 could survive", which is the opposite of the failure mode above.
- Residual 3 (cmark-js is the oracle) is the same shape: it names a dependency, not an exemption.
- Residual 2 (AX and pixel reads are capped) is the closest thing to a limitation-that-could-bite, and it
  is the one to widen next — but both caps sit behind a cheap wider check (rendered text over 20,000, which
  is green) rather than behind nothing.
- The **class of claim that killed rounds 7-10 — "construct X cannot hide anything" — no longer appears
  anywhere in this ticket or in `public/lib/response-blocks.js`.** Round 10 removed the last one and
  introduced none; this round adds none. That is the first round of the eleven where that is true.

What still blocks VERIFIED is procedural and it is the right block: **generation must not be its own only
verifier.** This round wrote the leg that grades itself green and wrote its own non-vacuity calibration.
The calibration is strong evidence (it fails on two real prior generations, in each one's own direction,
far above its floor) but it was chosen by the same author as the leg. **Bucket: regression-prone,
high-stakes — an independent clean-room verify pass is REQUIRED before VERIFIED**, and this would be the
twelfth. Where to attack it: (a) the strata are a list of past defects, so ask what shape the `random` 20%
is systematically unlikely to produce; (b) `pickFuzzSample`'s spill-into-`random` on a short stratum could
silently convert a targeted sample into a plain one — check the printed counts, not the code; (c) the [T]
pixel identity test compares two bodies that differ in glyphs but not in LINE COUNT, so a regression that
reveals only the fold's *height* in one theme is caught by the height assertion and not by the md5 — verify
that assertion is really independent; (d) the calibration navigates the page mid-suite, so confirm nothing
after [R] is silently reading a stale global.

**regressed-from:** none — this closes a named residual rather than a defect.

## 2026-08-19 — ROUND 12: the vocabulary was PRESENTATION, and that is why it leaked. Semantic categories, derived from measurement

**The user's correction, and it is right.** The intent from the beginning was that *every part of a
reply is categorised*. What shipped was two names — `orchard-answer` (shown) and `orchard-notes`
(collapsed) — which encode **where a passage appears**, not **what it is**. The orchestrator lane asked
for a minimal vocabulary and said the fallback would produce the evidence to grow it. The evidence
arrived, from the reader rather than the metrics: several turns of narration landed in the *visible*
block, because "is this for the reader?" is a question about rendering and every passage can be argued
into the yes half. A presentation-only split gives the author a bucket to dump anything into.

The rule that produced the first set was not wrong about SIZE. It was silent about the AXIS, and the
axis was the defect.

### The set is measured, not designed

1,558 orchestrator assistant messages from this project's own main-thread CLI transcript, segmented
into 3,844 top-level passages; a seeded random sample of **155 passages / 49,990 chars** read and
hand-labelled with fine-grained codes, merged afterwards only where the evidence was thin or a
boundary was fuzzy.

| code | passages | % | chars | % chars | became |
| --- | ---: | ---: | ---: | ---: | --- |
| finding (incl. correction, explanation) | 42 | 27.1% | 17,339 | 34.7% | `orchard-finding` |
| status | 30 | 19.4% | 6,266 | 12.5% | `orchard-status` |
| rationale / self-critique | 25 | 16.1% | 7,828 | 15.7% | `orchard-judgment` |
| outcome | 21 | 13.5% | 7,124 | 14.3% | `orchard-outcome` |
| ask (incl. recommendation) | 14 | 9.0% | 6,133 | 12.3% | `orchard-ask` |
| narration | 13 | 8.4% | 1,772 | 3.5% | `orchard-narration` |
| digest | 5 | 3.2% | 3,101 | 6.2% | layer 1, unchanged |
| **none of the above** | **5** | **3.2%** | **427** | **0.9%** | `orchard-uncategorized` |

Six names cover **96.8% of passages / 92.9% of prose characters**. What the measurement forced, against
the hypotheses it was given:

- **correction and explanation are not categories** — both merged into `finding` (4.0% and 2.0% of
  chars). A correction passes the finding test exactly: my knowledge changed, the system did not.
- **"an answer to a question they asked" was DISCARDED**, though it was a hypothesis. It is not a kind
  of content, it is *provenance*, and it is orthogonal — an answer to a question is a finding, an
  outcome or an ask depending on what it says. Adding it would have put a second axis back into the
  set, which is the mistake being fixed.
- **`status` was kept** despite the digest carrying `in-flight`: 19% of passages, and the digest is one
  sentence per item, so the prose naming four lanes and what gates them has nowhere else to go.

### Three pairs, and each boundary is a fact rather than a matter of degree

| axis | | |
| --- | --- | --- |
| the world | `finding` — what is TRUE | `outcome` — what I CHANGED |
| a decision | `ask` — it is YOURS | `judgment` — it was MINE |
| the work | `status` — where it stands as the turn ENDS | `narration` — what I did INSIDE the turn |

There is deliberately **no tiebreak rule**. The old vocabulary had one ("if it is both, it is
`answer`"), and a tiebreak is what a soft boundary feels like from the inside. A passage that satisfies
two definitions is two passages; splitting is a mechanical edit, and blocks may repeat in any order.

### Presentation follows from the category

> A category is collapsed if its value EXPIRES when the turn ends.

Only `narration` does, so `COLLAPSED_BLOCKS` still holds exactly one category (plus the legacy alias
that means the same thing) — **the hiding surface did not widen while the vocabulary tripled**, which
is the only reason eleven rounds of hiding-class verification carry over instead of being re-litigated.
Two honest notes: the fold is worth only **3.5% of characters**, so folding narration is not what fixes
"I cannot find the thing addressed to me" — the other 96% being *captioned* is. And `judgment` is
VISIBLE despite being "internal reasoning", because the transcript shows it is the content the reader
engages with most (the admitted orchestration error, the refused verification budget); narration is the
play-by-play, judgment is the reasoning, and only the first is noise.

### The fallback is first-class, and it now says WHAT it is

`orchard-uncategorized` renders expanded, is counted, and carries a **free-text label**: the info string
is `name label`, where the name is the first token and the rest is the author's own words. That label is
the entire learning loop — "3% landed in the fallback" can never name a category; "eleven of them were
called *a copy-paste prompt for you to run*" can. The metrics keep two fallbacks **apart**: a declared
`orchard-uncategorized` block is a VOCABULARY gap (read the labels, add the name); loose prose outside
every block is a COMPLIANCE gap (a new name will not help). An unlabelled declared block is the one real
defect here, and the Stop hook raises an advisory for it.

The sample already demonstrates the loop: four of the five uncategorised passages were document
furniture (a `---`, two headings, one connective sentence) and one was a genuine artifact — a
copy-paste migration prompt written for the user to run elsewhere. If that label recurs,
`orchard-artifact` is the seventh name, and it will have been named by the data.

### Migration — nothing archived changes

`orchard-answer` and `orchard-notes` are kept as **frozen legacy names** in `KNOWN_BLOCKS`, mapped to
the presentation they shipped with: answer → visible and UNDECORATED (no caption is retro-fitted to old
content), notes → the same fold with its original summary. Both are removed from the injected core, so
no new turn produces one, and the metrics count them under their own names. `orchard-answer` was *not*
reused for the narrower "responds to what you asked" meaning even though it was the natural word —
rule 3 of the extension contract, obeyed at a cost.

### Verification — extended, not replaced

- `verify:feat-091` — **276 passed, 0 failed (exit 0)**. The enumerated corpus is now generated
  **twice**: as authored (legacy names — which *is* the migration case) and REMAPPED onto the semantic
  names with identical expectations, **42,564 cases** (was 21,282), 3,218 well-formed, 10,994 folding.
  I1/I2/I3/I4 all zero across both. New: the vocabulary tables pinned exactly; the label grammar (name
  is the first token, case preserved, flags worded with the NAME never the label); C1 still fires on a
  LABELLED reserved opener inside a fold; the declared-fallback metrics end to end.
- `verify:feat-091-commonmark-diff` — **23 passed, 0 failed (exit 0)**; fresh 20,000-document random
  differential, 0 hiding / 0 over-recognition / 0 lost, non-vacuity calibration against rounds 6-9 intact.
- `verify-feat-091-renderer.mjs` (real browser) — **201 passed, 0 failed**. 28,628 generated cases
  rendered (both name families), 10,994 closed folds, AX read over 220. New legs **[S]** (all six
  categories captioned, exactly one fold, the declared fallback visible with its label, the ask and its
  caption reachable in the accessibility tree while the narration is not) and **[S2]** (an archived
  legacy message renders exactly as it did), plus semantic + legacy shots at both widths and themes.
- `npm run gate` — **leak-gate PASS, typecheck PASS**; the aggregate is RED on `check-nul`, in
  `scripts/verify-bug-118-orchard-only-stop-hook.mjs`, which is another lane's in-flight file, not mine.
- Unrelated suites re-run green: feat-082-digest 52/52, feat-083 22/22 + adversarial 170/0,
  feat-084 37/37, feat-085 stop-hook 58/58 / readability 32/32 / adversarial HOLDS / independent 60/60.

**Two harness-integrity defects were found and fixed while extending the suites**, both of the same
family the round-6 duplicate-id note describes — a check that grades the wrong thing and passes:

1. The render leg reads ONE accessibility tree over MANY cases, so duplicated tokens across the
   authored and remapped families made "hidden here, visible there" look like a leak. Remapped tokens
   are now re-minted fixed-width and terminated, which is substring-free in both directions (a prefix
   scheme is not: `MUST-BE-VISIBLE` sits inside `R12-MUST-BE-VISIBLE`).
2. Token matching in that read was `includes`, and the corpus's own names NEST — `NARRATION` is a
   prefix of `NARRATION-R3`, `TILDE-NARRATION`. It is delimited now. And the fold's own summary label
   is the word "Narration", which Chrome computes into the disclosure control's accessible name: the
   control's subtree is excluded from the content read, with a check asserting the exclusion removes
   CHROME ONLY so it cannot become a hiding place.

**Injected-core cost:** 2,448 → 2,888 bytes (+18%) for 2 names → 6 + a fallback. The ratio is the test
to re-apply before a seventh name: a name that needs a paragraph to distinguish has a soft boundary,
and a soft boundary is how the first vocabulary failed.

**Out-of-lane edit, flagged:** `src/server/templates.ts`'s injected preamble named the retired blocks in
prose. Left alone it would inject a contradiction on every turn, so its blurb (no logic) now names the
categories.

**Bucket: regression-prone / high-stakes** — this touches the grammar that has produced eleven BROKEN
verdicts, and the suites were extended and graded green by the same author who wrote them. An
independent clean-room verify pass is WARRANTED. Where to attack it: (a) the remap proves the grammar is
table-driven, but every remapped case is a *mechanical* rename — ask what the semantic names make
possible that `orchard-notes` did not, and generate THAT; (b) the label grammar changed what an info
string means, so a labelled COLLAPSED opener now folds where it used to degrade to visible prose —
hunt for an input where that direction hides something the author did not author as hidden; (c) the AX
summary exclusion is new and it removes nodes from a hiding check — try to smuggle content into a
summary; (d) the presentation table in `digest.js` is the only display decision, so check that an
unknown or legacy name cannot reach the fold branch through it.

**regressed-from:** none — this replaces a vocabulary the orchestrator lane specified, and says so.

## 2026-08-20 — record-correction lane: which verification records this ticket ASSERTS, said by a human

No code was touched, nothing was re-verified, and no prior entry was edited. A board-wide check
refuses to transcribe this ticket's verdicts unattended, because two readings of the file disagree
about how many there are: reading it line by line finds twelve, and reading it as CommonMark finds
four. It asked a human which lines the ticket asserts. This entry is that answer, from reading the
ticket.

**All twelve are asserted. None is quoted, illustrative or an example.** Each sits at the foot of the
activity entry that answers it, in this ticket's own voice, naming a distinct dispatch run:

| # | line | dispatch | run id | verdict | recorded at the foot of |
|---|---|---|---|---|---|
| 1 | 320 | openai | 01a0165f-d558-7a32-8c4b-46ddab42d27f | BROKEN | 2026-08-18 worker (renderer lane) |
| 2 | 415 | openai | 01a01671-5827-7eb1-9727-00eb555562be | BROKEN | 2026-08-18 the BROKEN verdict resolved |
| 3 | 537 | openai | 01a0168c-8f17-78a3-a991-2012c3ccea35 | BROKEN | 2026-08-18 the SECOND hidden-content defect |
| 4 | 663 | openai | 01a0169e-4e37-7872-8204-144fd1d5f499 | BROKEN | 2026-08-18 third clean-room verdict |
| 5 | 816 | openai | 01a016b1-a697-7f32-81d6-a932cc21487d | BROKEN | 2026-08-19 ROUND 4, the inert-region class |
| 6 | 972 | openai | 01a016c4-642a-7ae3-8949-589461cfb0c5 | BROKEN | 2026-08-19 FIFTH verdict fix |
| 7 | 1100 | openai | 01a016d5-89bf-7161-ae59-febc1429d1f0 | BROKEN | 2026-08-19 SIXTH clean-room verdict |
| 8 | 1226 | openai | 01a016e8-b5d4-7ff1-8bc3-8c14e3374927 | BROKEN | 2026-08-19 round 7, paragraphOpen |
| 9 | 1465 | openai | 01a01701-b0cc-7523-8a3a-aad2052c12fc | BROKEN | 2026-08-19 EIGHTH clean-room verdict |
| 10 | 1656 | openai | 01a01734-3ca0-7743-9ec2-080eac4c506c | HOLDS | 2026-08-19 NINTH clean-room verdict |
| 11 | 1657 | openai | 01a01738-f736-7b83-b614-f4dd839d7b3c | BROKEN | 2026-08-19 NINTH, SECOND pass (browser + accessibility tree) |
| 12 | 1859 | anthropic | 9ee724de-f3b0-46a6-b9bb-38a5cb8aa5b8 | HOLDS | 2026-08-19 R3 standing in the renderer suite (eleventh pass) |

Line numbers are as of this entry and will move; the run ids will not.

**Why the two readings disagree, so nobody re-derives it.** Line 807 ends a bullet mid-sentence and
line 808 begins with three backticks in ordinary prose — the sentence "It splits on ``` only, so a
tilde-fenced region renders as paragraphs rather than a code block", wrapped so that the backticks
land at the start of a line. To CommonMark that opens a fenced block, and from there every real
verdict fence in the rest of the file flips the reader's idea of what is inside a fence and what is
outside. Records 5 through 12 fall inside a region a fence-aware reader believes is code. They are
not. The desync is one wrapped prose line, and it is in a prior log entry, so it stays.

**What is NOT asserted, and is deliberately absent from the table:** the two `_pending._` notes
(lines 234 and 325). They name no run and are not verification records.

**Status is unchanged and remains OPEN.** Record 12 is a HOLDS on the eleventh pass, and the ROUND 12
vocabulary replacement that followed it has had no independent pass at all — the ticket says so, and
that is the honest state.
