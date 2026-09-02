```orchard-ticket
{
  "id": "BUG-164",
  "type": "bug",
  "title": "line breaks in a typed message render as one run-on blob",
  "summary": "A user types a message with line breaks, and when it renders back in the transcript the breaks are gone and it reads as one run-on paragraph. The user's own bubble renders the text in a plain paragraph with a default that collapses newlines to spaces. The breaks are lost only at display; storage and the model input are unaffected.",
  "impact_if_we_wait": "Every multi-line message a user types is shown back flattened, so a deliberately structured note — steps, a pasted log, a snippet — is unreadable in the transcript meant to be the honest record of what they said.",
  "current_need": "A user's own message must render with the line breaks they typed — single newlines, blank-line paragraph gaps, and the leading whitespace of a pasted block — while long lines still wrap inside the bubble.",
  "severity": "medium",
  "area": "dashboard client / user bubble render",
  "reported": "2026-09-02",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-09-02",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "a user message typed with single newlines renders each line on its own line",
    "a blank-line paragraph break renders as a gap, not a collapsed space",
    "a pasted multi-line log and a fenced code block keep their line breaks and leading indentation",
    "long unbroken lines still wrap inside the bubble rather than overflowing it",
    "the stored transcript is unchanged and still holds exactly the text the user typed (the model receives what was written)",
    "assistant prose (rendered through prose()/markdown) is untouched — its single-newline-is-a-space rule still applies"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# BUG-164 — line breaks in a typed message render as one run-on blob

## Symptom

User report: "in output of my input, if in the input i add newlines, my msg still appears as a single blob".

The user types a message in the composer with line breaks. When it renders back in the transcript the line breaks are gone and it is one run-on paragraph.

## Repro

1. In the composer, type a message across several lines, e.g. three lines, then a blank line, then another paragraph.
2. Send it.
3. The `.you` bubble in the transcript shows it as one flowed paragraph — every newline collapsed to a space. Same after a reload (the stored history renders identically).

## Expected

The bubble shows the line breaks the user typed: separate lines stay separate, a blank line is a paragraph gap, a pasted block keeps its indentation. Long lines still wrap inside the bubble.

## Diagnosis

The loss is **display-only**. `youBubble()` (public/app.js ~line 3014) renders the user's message as a plain text node: `el('div', { class: 'you' }, el('p', { text }))`. It does NOT route user text through `prose()` — so this is not markdown's single-newline rule. The newline characters ARE present in the DOM text node; the browser's default `white-space: normal` on `.you p` collapses every run of whitespace (newlines included) to one space, so the text paints as a blob.

Proven against the pre-change tree with a real headless browser: the STORED transcript (fetched from the real `/api/transcript` route — what the model received) held all newlines intact (303 chars, single breaks + blank-line break + fence + list + log + trailing spaces all preserved); the rendered bubble measured 135px tall (a ~6-line blob) with `white-space: normal`. So storage and the model input were never affected — this is purely a render defect on the user's own bubble.

## Fix

One CSS rule on `.you p` (public/styles.css): `white-space: pre-wrap; overflow-wrap: anywhere;`. pre-wrap keeps the breaks and blank-line gaps exactly as typed while still wrapping long lines; overflow-wrap keeps a pasted URL/log line from bursting the bubble. Deliberate choice: composer input is not authored markdown — the user is typing, not writing a document — so preserving what they typed verbatim is correct, and it does NOT add a second whitespace rule beside the prose()/fence grammar (assistant prose is untouched and keeps its markdown single-newline rule). A user message that happens to contain a fenced code block or a list now renders those marks literally on their own lines, which is what a plain-text bubble should do.

## Context pack (grows — the "where to look", so no agent cold-starts)

- `public/app.js` `youBubble()` (~L3014) — renders the user bubble as a plain text node (not prose()).
- `public/styles.css` `.you p` (~L711) — the rule that was missing `white-space`.
- `public/lib/dom.js` `prose()` (~L316) — the markdown renderer used for ASSISTANT text; deliberately NOT changed (its `lines.join(' ')` single-newline collapse is correct for authored prose).
- Repro/verify: `a scratch harness (`verify-user-newlines.mjs`)` — real headless brave, sends a 6-case message, asserts optimistic bubble + stored transcript + reloaded bubble. FAILs pre-change (4 fails: white-space normal, blob height), PASSes after (15/15).
- Same-file caution: `public/app.js` / `public/styles.css` / `public/lib/` carry other lanes' uncommitted work (session-strip redesign). This fix touched ONLY the `.you p` block in styles.css.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-02 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-02 — fix lane (finding + fixing, round 1, class=fix)
- **Understood:** the user's own message is rendered by `youBubble()` (public/app.js ~L3014) as a plain TEXT node inside `<p>` — it does NOT go through `prose()`/markdown. So this is not markdown's single-newline-is-a-space rule; it is the browser default `white-space: normal` on `.you p` collapsing every run of newlines/spaces to one space. The newlines survive into the DOM text node; they are lost only at paint.
- **Where the newlines were lost:** display only. The STORED transcript is untouched — the model always received exactly what the user typed. Proven by fetching the real `/api/transcript` route: the persisted user message held all breaks (single newlines, blank-line paragraph break, fenced block, list, pasted log, trailing spaces) intact, 303 chars.
- **Changed:** `public/styles.css` — added `white-space: pre-wrap; overflow-wrap: anywhere;` to `.you p` (with a comment explaining it is a display rule; composer input is plain text, not authored markdown). Assistant prose (`prose()` in dom.js) deliberately UNCHANGED — its markdown single-newline rule still applies. No second whitespace rule added beside the fence grammar.
- **Verified (real headless brave, must-FAIL then PASS):** a scratch harness sends a 6-case message (single newlines, blank-line paragraph break, trailing spaces, fenced code, list, pasted multi-line log) and checks the optimistic bubble, the stored transcript, and the reloaded (stored-rendered) bubble.
  - PRE-CHANGE tree: 11 passed / **4 FAILED** — `.you p` white-space `normal`, bubble height 135px (a collapsed ~6-line blob) on both optimistic and reloaded paths. (Stored-text checks all PASSED even pre-change, confirming storage was never the problem.)
  - POST-CHANGE tree: **15/15 passed** — white-space `pre-wrap`, bubble height 540px (~23 lines), all breaks/gaps/indentation preserved on optimistic + stored + reloaded paths; stored text still byte-identical to what was typed.
  - Screenshots read by the fixer in BOTH themes (light + dark): breaks, blank-line gaps, literal code fence, list, and log all render on their own lines; long lines wrap inside the bubble; contrast unaffected.
- **Regressions:** ran the block/renderer suites (fix area has prior fence-handling history). `verify-bug-109-prose-lone-cr` 43/43, `verify-bug-127-render` 9/9, `verify-bug-067-notice-render` 17/17 all PASS. Two pre-existing failures observed in files this change did NOT touch and cannot affect (`verify-feat-091-renderer` FATAL on a `fenceSegments` import; `verify-feat-091-response-blocks` 276/277, one byte-budget check) — `response-blocks.js`/`dom.js` are clean at HEAD; a CSS rule cannot change a JS export or a byte count.
- **Gate:** `npm run gate` exits 1, but ONLY on pre-existing leaks in other lanes' untracked files (`adversarial_*.py`, `verify_brake_adv.py`, the `FEAT-114` ticket). My file `public/styles.css` is leak-clean; typecheck PASSES. Nothing of mine leaks.
- **Symptom of a deeper design flaw?** no — a single missing display rule on one bubble; the render vs. storage split is correct and this only affects paint.
- **Handoff / status:** fix is complete and self-verified in the working tree, left UNSTAGED (no git writes). Low-risk UI CSS change; independent clean-room verify not required per the standing rule, though the scratch harness is available for a second pass if desired.
