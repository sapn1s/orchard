```orchard-ticket
{
  "id": "BUG-167",
  "type": "bug",
  "title": "A bulleted list after a lead-in line renders as one paragraph",
  "summary": "prose() treats a block as a list only when its first line is a bullet. When the model writes a lead-in line then bullets on the very next line with no blank line, the block falls through to the paragraph fallback, which joins every line with one space — the list renders as one run-on paragraph.",
  "impact_if_we_wait": "Every markdown surface routes through prose() — assistant prose, digest and answer bodies, plan cards, decide and question panels. What the model intends as a list reads as a wall of text; numbered lists after a lead-in break the same way. It looks fine to the author and recurs silently.",
  "current_need": "Ship the one-line interrupt in prose() and confirm it does not disturb the sibling shapes it shares a code path with.",
  "severity": "medium",
  "area": "Transcript renderer / markdown (public/lib/dom.js prose())",
  "reported": "2026-09-06",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-09-06",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A lead-in line immediately followed by bullets renders as a <p> plus a <ul> with one <li> per item, not one run-on <p>",
    "The same holds for a numbered lead-in list: a <p> plus an <ol> with one <li> per item",
    "Sibling shapes are unregressed: a blank-line-separated list, a plain wrapped paragraph, a heading then a list, and a wrapped-bullet continuation",
    "Verified against the real reported input through the real served prose() in headless brave, with a must-FAIL baseline pinned to a pre-fix revision"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-109",
      "relation": "see_also"
    },
    {
      "id": "BUG-110",
      "relation": "see_also"
    }
  ],
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

# BUG-167 — A bulleted list after a lead-in line renders as one paragraph

## Diagnosis

`prose()` in `public/lib/dom.js` splits a fence segment into blocks on blank lines only (`seg.text.split(/\n{2,}/)`), then treats a block as a list only when its FIRST line matches `BULLET` (`/^\s*([-*+]|\d+\.)\s+/`). A block whose first line is ordinary prose but whose later lines are `- ` items never enters the list branch, so it reaches the fallback `wrap.append(inlineInto(el('p'), lines.join(' ')))`, which joins every line with a single space — the whole list collapses into one paragraph. CommonMark starts a list at the bullet; this renderer did not.

Real reported input, rendered as a single `<p>` pre-fix:

```
**Skills (3)** — the areas this session is scoped to:
- Web Development…
- Web App Architecture…
- API Integration…
```

## Fix

Inserted an interrupt branch immediately before the paragraph fallback: find the first line matching `BULLET`; if `at > 0`, emit `lines.slice(0, at)` as a `<p>` and re-run `prose(lines.slice(at).join('\n'), cls)`, whose remainder now starts at a marker so the existing block-start path builds the `ul`/`ol`. `BULLET` matches both `-*+` and `\d+.`, so ordered lists are covered and the recursion's `/^\s*\d/` test picks `ol` vs `ul`. `at > 0` only, so an `at === 0` block — already claimed by the bullet branch above — is untouched, and the wrapped-continuation fold there stays reachable.

One fix covers every markdown surface: assistant prose (`app.js` → `digest.js renderAssistantText`), digest/answer/notes bodies, plan cards, decide/question panels. User bubbles and notice bodies use pre-wrap plain text and are unaffected.

## Verification

`npm run verify:bug-167` (`scripts/verify-bug-167-prose-list-after-para.mjs`): drives the REAL served `public/lib/dom.js` prose() in headless brave over raw CDP. The must-FAIL baseline is the pre-fix prose() loaded from a pinned revision (`f42537f`), copied beside the live module so its `./response-blocks.js` import resolves — a fixed baseline, not HEAD, so it stays the pre-fix state after the fix commits.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-06 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-06 — worker
- **Dispatch:** ticket=BUG-167 phase=fixing round=1 class=fix.
- **Understood:** a bulleted (or numbered) list written directly after a lead-in line, with no blank line, rendered as one run-on paragraph because `prose()` only starts a list when a block's FIRST line is a bullet.
- **Changed:** `public/lib/dom.js` (interrupt branch before the paragraph fallback in `prose()`); `package.json` (added `verify:bug-167`); `scripts/verify-bug-167-prose-list-after-para.mjs` (new); `docs/bugs/assets/BUG-167-{light,dark}.png` (graded captures). Left unstaged for the orchestrator.
- **Verified:** `npm run verify:bug-167` — 12/12. MUST-FAIL against pinned `f42537f`: bulleted input → one `<p>`, zero `<ul>`, bullets inline (the pre-fix failure); numbered → one `<p>`, zero `<ol>`. FIXED: bulleted → `<ul>` + 3 `<li>` + lead-in as its own `<p>`; numbered → `<ol>` + 3 `<li>`. Anti-regression siblings all PASS: blank-line-separated list, plain wrapped paragraph, heading-then-list, wrapped-bullet continuation. `npm run gate` — PASS (exit 0). Same-renderer suites: `verify:bug-109` 43/43, `verify:streaming-md` 9/9, `verify:feat-091` 277/0.
- **Verified-by:** pending — independent clean-room dispatch required before VERIFIED (`fix` class).
- **Still open / handoff:** independent verification only.
- **Symptom of a deeper design flaw?** no — a single missing CommonMark rule (paragraph-interrupting list) in a hand-rolled renderer; the interrupt is the standard treatment and BULLET already models both list forms.
