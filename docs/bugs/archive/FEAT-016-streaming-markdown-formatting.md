# FEAT-016 — Format markdown live while streaming (not a raw blob until the end)

- **Status:** VERIFIED
- **Severity:** medium
- **Area:** transcript rendering / streaming
- **Reported:** 2026-08-03 by user (discussed earlier; never implemented)

## Symptom
While a turn streams, assistant text renders as RAW markdown — `**bold**`,
`##` headings, list markers, ``` fences all show as literal syntax — and only
snaps to formatted prose when the final message arrives. It should format as it
streams, like the CLI / claude.ai.

## Design (agreed earlier — the HONEST variant, matching this app's ethos)
Two known approaches:
- **Optimistic** (what openai/claude web do): an unclosed `**` is treated as
  "bold to the cursor" so syntax hides immediately; occasionally briefly wrong,
  self-corrects. Downside: it ASSERTS a close that hasn't happened — against
  this app's "never assert a state you haven't reached" rule.
- **Honest** (preferred here): re-parse the ACCUMULATED stream buffer through
  the existing `prose()` each frame (debounced), so completed markdown (earlier
  bold, headings, lists, closed code fences) formats live, while in-progress
  syntax stays literal until its token closes. No guessing; matches the ethos.

Implement the HONEST variant. It is a one-line switch to optimistic later if the
user prefers the smoother feel.

## Context pack
- Files: `public/app.js` — the `text-delta` handler (builds `th.stream =
  { wrap, p, text, caret }` and does `th.stream.p.textContent = th.stream.text`),
  and the final `text` handler (`th.stream.wrap.replaceWith(prose(e.text))`).
  `public/lib/dom.js` `prose()` is the tolerant parser to reuse.
- Now relevant because the freshly-restarted server token-streams
  dashboard-driven sessions (DEPLOY-003 cleared).
- Approach: on each delta (debounced ~60–100ms, or every few tokens), rebuild
  the streaming node from `prose(th.stream.text)` instead of setting textContent;
  keep the caret; preserve scroll-stick. Guard cost: messages are small, prose()
  is sub-ms, but don't reparse on EVERY token synchronously — debounce.
- Watch: code fences mid-stream (unclosed ```), the caret position, not
  double-rendering when the final `text` arrives, subagent-thread streams too.

## Verification (REQUIRED)
A real browser test (new `verify:streaming-md.mjs` or extend an existing live
one): run a real cheap turn whose reply contains markdown (ask haiku to reply
with a bolded word + a list + a short code block and a sentinel), and assert
that BEFORE turn-end the streaming node contains FORMATTED nodes (`<strong>`,
`<ul>`/`<li>`, `<pre>`), not literal `**`/`- `/```` ```` — i.e. it formats mid-
stream, and the final render matches. Run verify:ui offline + typecheck.

## Activity log (APPEND-ONLY)
### 2026-08-03 — orchestrator
- Filed. Discussed with the user earlier; only offered, never implemented — this
  captures it properly. Frontend (app.js) — serialize with other FE tickets.

### 2026-08-04 — implementer (HONEST variant)
**Understood.** The `text-delta` handler dumped the raw accumulated buffer as
`th.stream.p.textContent`, so markdown showed as literal syntax until the final
`text` event replaced the node with `prose(...)`. Fix: reparse the accumulated
buffer through the existing tolerant `prose()` each frame, THROTTLED, so
completed markdown formats live while in-progress syntax stays literal until its
token closes — no asserted-early state. Subagent-thread text arrives whole via
the `text` event (deltas are always main-thread; `parent_tool_use_id` is null),
and that path already renders through `prose()`, so no change was needed there.

**Changed** (working tree, uncommitted):
- `public/app.js`:
  - New `STREAM_RENDER_MS = 70`, `renderStreamNow(th)`, `scheduleStreamRender(th)`.
    `renderStreamNow` rebuilds the node from `prose(th.stream.text)`, moves the
    caret to the end of the last rendered block, `replaceWith`s the old wrap and
    updates `th.stream.wrap`; it `scrollDown()`s (stick-aware) only when viewing
    main.
  - `text-delta` handler: stream node is now a bare `.prose` wrap (dropped the
    single `<p>` + `textContent` write). Leading-edge throttle — render the first
    token immediately (caret shows at once), coalesce bursts, always flush the
    tail via `scheduleStreamRender`. Kept the per-delta stick-aware `scrollDown`.
  - `finishStream` and the final `text` handler now `clearTimeout` any pending
    stream timer before the one final `prose()` replace, so no double-render and
    no late reparse after `th.stream` is nulled (the scheduled closure also
    guards `th.stream === s`). The final-render path is otherwise unchanged.
- `scripts/verify-streaming-md.mjs` + `package.json` `verify:streaming-md`: real
  brave headless over raw CDP, real haiku turn, OS-assigned free port, kill by
  pid, sweeps the CLI's stray real-store transcript dir.

**Verified** (all PASS):
- `npm run verify:streaming-md` — 9/9 passed. Load-bearing: MID-STREAM
  (`th.stream` live, i.e. before turn-end) the streaming node contained
  `<strong>` + `<ul>/<li>` + `<pre>` (formatted live, not literal
  `**`/`- `/```` ``` ````); final render has the sentinel exactly once, no
  duplicated leftover, fully formatted, no literal `**`/```` ``` ```` remaining.
- `npm run verify:ui -- --offline` — 3 passed, 0 failed.
- `npm run typecheck` — clean.
- Screenshot: `docs/bugs/assets/FEAT-016-after.png` — bold "beacon", bullet
  list, `print(42)` code block + caret, captured while status = "Running".

**Open:** none. Not committed (leaving in working tree per the rules).
