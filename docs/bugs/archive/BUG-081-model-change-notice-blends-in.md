# BUG-081 — "model changed" / refusal-fallback transcript notice blends into the conversation

- **Status:** VERIFIED 2026-08-12 — post-fix 14/14 (must-FAIL pre-fix 2/7 proven); client-only, live on page reload (static serving, no deploy)
- **Area:** FE transcript rendering (app.js/styles) — notice legibility
- **Reported:** 2026-08-12 by user:
  > "'model changed: Fable → opus-4-8 (refusal fallback · cyber)' got this in transcript, very good
  > info, but should probably be colored or distinct, currently it blends in too much"

## Symptom
The transcript renders a model-change / refusal-fallback notice (e.g. an automatic downgrade
Fable → opus-4-8 when the primary model refuses a request) as plain text that reads like ordinary
conversation flow. It is HIGH-signal (the model answering you silently changed, and why) but has
no visual distinction, so it is easy to miss.

## Wanted
1. Render the model-change/fallback notice as a distinct inline marker — a small centered/hairline
   chip or badge with a subtle accent (this class of event warrants a touch of color per the
   FEAT-066 restrained-palette philosophy: a neutral/info tint, or amber if it represents a
   fallback/degradation), clearly not a chat bubble and not body text.
2. Keep the full information: from-model → to-model, the reason (refusal-fallback · <category>).
   Consider making the reason a tooltip if the inline form is long.
3. Reconcile with BUG-067 (harness notices → system-notice chips) — if this notice already flows
   through a notice path, this is a styling/variant addition; if it's a separate render site, give
   it the same distinct treatment. Do NOT regress BUG-067's task-notification rendering.
4. Applies on live-follow AND history render (both transcript paths), like BUG-067.

## Verification (§C)
Fixture transcript containing a model-change notice + ordinary messages → the notice renders with
a distinct class/accent color (computed style differs from a normal message; must FAIL pre-fix:
same as body text) on both render paths; the from/to/reason content is present. Anti-regressions:
verify:bug-067 (notice rendering), verify:ui, verify:streaming-md, typecheck, leak-gate.

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
