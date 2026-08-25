# FEAT-072 — render the queued-message metadata prefix as a distinct caption, not inline with the message body

- **Status:** VERIFIED 2026-08-13 — 20/20 (must-FAIL 7/18 proven); client-only, live on page reload (static serving, no deploy)
- **Area:** FE transcript rendering (app.js renderMessages — user message branch)
- **Reported:** 2026-08-13 by user:
  > "the '[msg 1/2 · queued 1m46s ago, composed while the previous response was still being written]'
  > part … I keep re-reading it … I can't just visually jump where it ends … since it's always the
  > same format we can give it formatting"

## Symptom
When a message is queued/batch-delivered, the harness prepends a bracketed metadata line to the
user message text, e.g.:
`[msg 1/2 · queued 1m46s ago, composed while the previous response was still being written]`
or `[Queued Ns ago, composed while the previous response was still being written — it predates…]`.
The dashboard renders the whole thing as one blob, so the boilerplate runs straight into the
user's actual words with no visual break — the user has to read the boilerplate every time to find
where their real message starts.

## Wanted
1. Detect the leading bracketed queued-metadata block on a user message (conservative: a leading
   `[…]` at position 0 matching the known shapes — `[msg N/M · queued …]`, `[Queued … ago …]`,
   `[Queued Ns ago, composed while …]`) and render it as a SMALL, DIMMED, DISTINCT caption
   (its own line / chip above the message), visually separated from the message body so the eye
   skips it. Same restraint as BUG-067's system-notice styling.
2. The user's actual message text renders below, at normal weight — clean start, no boilerplate
   bleeding in.
3. Conservative match: only strip/caption a bracket at the very start whose content matches the
   queued-metadata shape; a real user message that merely starts with "[" (e.g. a markdown link or
   code) must NOT be mis-captioned.
4. Applies on both live-follow and history render (like BUG-067). Reconcile with BUG-067's
   harnessNotice/noticeChip path — this is a per-user-message caption, a sibling treatment.

## Verification (§C)
Fixture transcript: a queued user message with the `[msg 1/2 · queued …]` prefix → the prefix
renders as a dim caption, the body below is just the user's words (must FAIL pre-fix: prefix inline
with body, same style); a `[Queued Ns ago…]` variant likewise; a real user message starting with a
non-metadata "[" stays fully in the body (no false caption). Both render paths. Anti-regressions:
verify:bug-067, verify:ui, verify:streaming-md, typecheck, leak-gate.

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
