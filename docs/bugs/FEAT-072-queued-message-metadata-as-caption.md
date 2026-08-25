```orchard-ticket
{
  "id": "FEAT-072",
  "type": "feature",
  "title": "Queued message boilerplate ran straight into the user's words",
  "summary": "When a message was queued and delivered in a batch, the dashboard showed the bracketed queue note and the person's actual text as one undifferentiated block, so the reader had to re-read the boilerplate each time to find where the real message began. The note now renders as a small dimmed caption above the message body.",
  "impact_if_we_wait": "Reading a queued message costs extra effort every time. Bounded: this is transcript presentation only, no message text is altered or lost, and every other message renders as before.",
  "current_need": "Nothing is outstanding. The captioned rendering failed before the change and passed after it, the surrounding transcript behaviour stayed green, and it is live on a page reload.",
  "severity": "low",
  "area": "Transcript rendering",
  "reported": "2026-08-13",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A queued message shows its bracketed note as a dim caption above the body",
    "The message body renders at normal weight with no boilerplate in it",
    "Both known queue-note shapes are captioned",
    "A genuine message that merely opens with a bracket stays entirely in the body",
    "Captioning applies on both live-follow and history render"
  ],
  "code_refs": [
    {
      "path": "app.js",
      "symbol": "renderMessages",
      "note": "user message branch; FEAT-072 adds a sibling caption treatment alongside the existing harness-notice chip path"
    }
  ],
  "related": [
    {
      "id": "BUG-067",
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
    "archived_path": "docs/bugs/archive/FEAT-072-queued-message-metadata-as-caption.md",
    "sha256": "ee7ebf2fbd1ab3c7c43a8c05278fa0e4f59b6a3d63da4cb09fbd2b4e2062e7ea",
    "bytes": 6063,
    "original_title": "render the queued-message metadata prefix as a distinct caption, not inline with the message body",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Checked against the original head: the reported symptom, both prefix shapes, the conservative-match requirement, the two render paths, the sibling relationship to the notice styling, and the anti-regression set are all present.",
    "dropped": [
      "the verbatim quotation of the user's report, whose content is carried by the summary",
      "the two named-but-unrun suite labels"
    ]
  }
}
```

# FEAT-072 — Queued message boilerplate ran straight into the user's words

## Diagnosis

The harness prepends a bracketed metadata line to a queued user message, in shapes such as a message counter with a queue age, or a queue age with a note that the message predates the reply. The transcript renderer treated that prefix as ordinary message text, so it was painted at the same weight and on the same line as the user's words.

## Evidence

With the change stashed, 7 of 18 fixture cases failed: the prefix rendered inline with the body in the same style. With the change applied the run was 20/20. The surrounding transcript suites stayed green — the system-notice suite at 17/17, the interface suite at 7/7 and the streaming-markdown suite at 9/9 — and typecheck and the leak gate reported clean.

## Implementation notes

The match is deliberately conservative: only a bracket at position 0 whose contents match the known queue-note shapes is lifted out. The caption borrows the restraint of the existing system-notice styling rather than introducing a new visual idiom, and sits as a sibling of that path rather than being folded into it. The change is client-side, so it takes effect on a page reload with no deploy step.

## Verification plan

Render a fixture transcript containing a counter-and-queue-age prefix and, separately, a bare queue-age prefix; assert each appears as a dim caption with only the user's words below. Render a real message that opens with a bracket and assert nothing is captioned. Repeat on both the live-follow and history paths, then run the system-notice, interface and streaming-markdown suites with typecheck and the leak gate.

## Risks

A future queue-note shape that the pattern does not recognise falls back to rendering inline, which is the old behaviour rather than a new fault.

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from user report. Client-only (app.js/styles) → reaches users on reload, no deploy.

### 2026-08-13 — fix (public/app.js + public/styles.css lane)
- **Root cause / choke point:** same single site BUG-067 uses — `renderMessages()`'s
  `role:user` branch (`public/app.js:3341`), reached by BOTH the live-follow path
  (`applyAppend` `:5420`) and the history/reload path. A queued/batch-delivered user
  message arrives with a fixed bracketed metadata prefix at position 0, but unlike a
  BUG-067 harness sentinel (which replaces the whole bubble) it is a REAL user message
  wearing a metadata hat — so the prefix must be peeled off, not the message dropped.
- **Fix (`public/app.js`):**
  - `queuedCaption(text)` (~`:3243`): a position-0 `\[[^\]]{1,400}\]` (leading whitespace
    tolerated) whose INNER content matches `QUEUED_META_RX` — the always-present
    "composed while the previous response" phrase, or a "queued … ago" pair. Returns
    `{ caption, body }` (body = the text after the bracket, left-trimmed) or null. A real
    message that merely opens with "[" (markdown link, code, "[queued for review]") never
    matches — none carry that phrasing.
  - `queuedCap(th, capText)` (~`:3268`): a dim, right-aligned mono line appended above the
    bubble; like youBubble it closes any open Claude body/stream (user-side turn boundary).
  - Hooked into the user branch (`:3353`): after the harnessNotice check returns null, a
    detected queued prefix renders `queuedCap` + a `youBubble` for the body (caption-only if
    the body is empty); non-matching text keeps its plain bubble. Both marked with the
    message index so scroll<->index mapping is unchanged. Sibling of BUG-067, no regress —
    BUG-067's sentinels are checked first and never overlap the queued shapes.
  - Exposed `queuedCaption` on `window.__station` for the verify.
- **Styling (`public/styles.css` ~`:517`):** `.qmeta` / `.qmeta-txt` — right-aligned (sits
  with the user's bubble, they share a message index), dimmed mono 10.5px (`--ink-4`), tight
  5px bottom margin so it groups with the bubble it captions. Deliberately not a bubble and
  not BUG-067's left-aligned notice chip.
- **Verify (§C):** `scripts/verify-feat-072-queued-caption.mjs` + `npm run verify:feat-072`.
  Real brave-headless + real server; a fixture transcript (markdown-link message, a
  `[msg 1/2 · queued …]` line, a `[Queued Ns ago …]` variant, a plain message) rendered
  through BOTH `applyAppend` and a direct `renderMessages`, plus a unit check of the detector.
  - **Pre-fix (fix stashed): 7/18 — must-FAIL confirmed** — both queued lines render as
    `.you` bubbles with the metadata inline; 0 `.qmeta`; order `[bubble,bubble,bubble,bubble]`.
  - **Post-fix: 20/20** — order `[bubble,qmeta,bubble,qmeta,bubble,bubble]`, each body is just
    the user's words (no "[msg"/"[Queued" in the bubble), captions carry the metadata, the
    markdown-link + plain messages stay whole bubbles, both paths agree, detector rejects the
    markdown-link and code-literal shapes.
- **Anti-regressions:** `verify:bug-067` 17/17, `verify:ui` 7/7, `verify:streaming-md` 9/9,
  `typecheck` clean, `leak-gate` PASS (0 hits).
- **Reach:** client-only (public/app.js + styles.css, statically served) — live on the next
  page reload; no server deploy.
