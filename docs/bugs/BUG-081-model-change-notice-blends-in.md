```orchard-ticket
{
  "id": "BUG-081",
  "type": "bug",
  "title": "Model-change notices blended into ordinary conversation",
  "summary": "Model-change and refusal-fallback notices now appear as distinct inline markers on live and historical transcripts. They retain the original model, replacement model, and reason while remaining visually separate from messages.",
  "impact_if_we_wait": "People could miss that another model answered and why. Bounded: this affected transcript display-correctness, not conversation data, model selection, or message delivery.",
  "current_need": "Treat BUG-081 as closed: the pre-fix display case failed, the corrected rendering passed, and standing checks stayed clean.",
  "severity": "not_recorded",
  "area": "Transcript notice legibility",
  "reported": "2026-08-12",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-12",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Model-change notices are visually distinct from ordinary messages",
    "Live-follow and history rendering apply the same distinct treatment",
    "The original model, replacement model, and fallback reason remain available",
    "Task-notification notices retain their existing rendering"
  ],
  "code_refs": [
    {
      "path": "app.js",
      "symbol": null,
      "note": "Client transcript rendering for live-follow and history paths"
    },
    {
      "path": "styles",
      "symbol": null,
      "note": "Distinct notice class and accent styling"
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
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-081-model-change-notice-blends-in.md",
    "sha256": "c05743d589d00a44118701326bfdcbbc39c847822809bfa6aafb8bb82f5678ee",
    "bytes": 6207,
    "original_title": "\"model changed\" / refusal-fallback transcript notice blends into the conversation",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied original; the symptom, desired presentation, preserved content, dual render paths, regression constraint, executed evidence, and client-only rollout are represented.",
    "dropped": []
  }
}
```

# BUG-081 — Model-change notices blended into ordinary conversation

## Diagnosis

Model-change and refusal-fallback events were rendered like ordinary transcript text. Their high-value context therefore blended into the conversation instead of reading as a system notice.

## Evidence

The pre-fix comparison failed 2/7 because the notice matched body text. After the client fix, the recorded tally was 14/14. `verify:bug-067` passed 17/17, `verify:ui` passed 7/7, and `verify:streaming-md` passed 9/9. Typecheck and leak-gate were clean. `verify:bug-081-model-notice` and `verify:bug-081` were named without recorded results.

## Implementation notes

Render the event as a compact inline notice with a restrained accent, separate from chat bubbles and body text. Preserve the source model, replacement model, refusal-fallback reason, and category across live-follow and history rendering. The change is client-only and becomes live after a page reload through static serving.

## Verification plan

Use a fixture containing ordinary messages and a model-change notice. Compare computed styles and require the notice to differ from body text on both transcript paths. Confirm all source, destination, reason, and category text remains present. Recheck task-notification, interface, and streaming Markdown behavior.

## Migration and rollback

No deployment or data migration is required. Static client serving makes the change available on page reload. Rollback is limited to reverting the client rendering and styling change.

## Risks

Overstating the accent could make the notice resemble an error or chat bubble. Shared notice styling could also regress task notifications if the model-change variant is not kept distinct.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from user report. Client-only (app.js/styles) → reaches users on reload, no deploy.
  Note the meta-context: this very notice fired because Fable declined a cyber-category request and
  fell back to Opus 4.8 — the surface working; the ask is only to make it legible.

### 2026-08-12 — fix (FE lane)
- **Where it renders:** ONE site — `flagModelChange()` (`public/app.js` ~`:7406`), a DOM append
  into `claudeBody(mainThread())`. It was a plain `el('div', {class:'ran-lbl model-change', text})`
  coloured `--ink` (verified: computed `rgb(230,233,229)` on dark, IDENTICAL to `.prose` body text)
  with a subtle `◇` prefix — hence "blends in". Reached from two live SSE events, both of which call
  `flagModelChange`: `model-changed` (the SDK's dedicated `model_refusal_fallback` push, `:6297`) and
  `model-observed` (per-turn wire-id report, `:6279`).
- **BUG-067 reconciliation:** BUG-067's harness notices flow through `renderMessages()` and are
  therefore replayed on BOTH the live (`applyAppend`) AND history/reload paths — a persisted
  transcript block. This notice is DIFFERENT and is NOT a regression of that path: the model-change
  marker is **LIVE-ONLY**. It is not a persisted message block (`renderMessages` never emits one;
  server-side it is only the ephemeral `model-changed`/`model-observed` SSE event, `src/server/events.ts:287`),
  so there is no history/reload replay to restyle — a single render site covers every path that
  reaches it. It is a SEPARATE render from `noticeChip`, so per the ticket it got the same distinct
  treatment rather than a `noticeChip` variant. BUG-067's `noticeChip`/`harnessNotice` path is left
  untouched (verify:bug-067 still 17/17).
- **Fix (`public/app.js`):** new `modelChangeMark(from, to, why)` builds a distinct pill:
  `<div class="ran-lbl model-change"><span class="mc-chip" title="<full line>"> ◇ · from→to · reason</span></div>`.
  `from → to` inline; the reason inline when ≤34 chars else collapsed to `fallback`, with the FULL
  `model changed: X → Y (reason)` line ALWAYS on the chip `title` (tooltip) so nothing is lost.
  `flagModelChange` now appends `modelChangeMark(...)`. Exposed `flagModelChange`/`modelChangeMark`
  on `window.__station` for the verify.
- **Styling (`public/styles.css` ~`:439`):** `.ran-lbl.model-change` recoloured to `--st-needs`
  (FEAT-066 amber — a refusal-fallback is a degradation, reads as "needs-you") and centred; `.mc-chip`
  is a hairline `999px` pill (`--st-needs` border/9%-tint bg, mono), `.mc-why` a dimmer amber suffix.
  Reuses the existing FEAT-066 `--st-needs` token in every theme block — no new colours invented.
  Removed the old `::before "◇"`/`--ink` rule; the diamond now lives inside the chip.
- **Verify (§C):** `scripts/verify-bug-081-model-notice.mjs` + `npm run verify:bug-081`. Real
  brave-headless + real server. Drives the AUTHENTIC live dispatch (PATH A: `onEvent({t:'model-changed'})`)
  and the render primitive (PATH B: `flagModelChange`), plus a long-reason tooltip case; compares the
  chip's computed colour against a real `.prose` baseline in the same pane.
  - **Pre-fix (fix stashed): 2/7 — must-FAIL confirmed** — model-change colour `rgb(230,233,229)`
    EQUALS body text, `.mc-chip` absent, `text-align:start`, no tooltip. (Only class + content present.)
  - **Post-fix: 14/14** — colour `rgb(203,160,92)` (--st-needs) DIFFERS from body, rendered as a
    rounded `.mc-chip` pill, centred, from→to→reason present, full line in the tooltip, both entry
    points agree, long reason collapses to `fallback` with the full text in `title`.
- **Anti-regressions:** `verify:bug-067` 17/17, `verify:ui` 7/7, `verify:streaming-md` 9/9,
  `typecheck` clean, `leak-gate` PASS (0 hits / 439 files, REPO mode).
- **Reach:** client-only (public/app.js + styles.css, statically served) — takes effect on the next
  page reload; no server deploy needed.
