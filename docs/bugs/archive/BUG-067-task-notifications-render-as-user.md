# BUG-067 — harness task-notifications render as USER messages (raw XML bubble attributed to the user)

- **Status:** VERIFIED 2026-08-12 — 17/17 (must-FAIL 2/9 proven); committed 0eddc88; client-only, live on page reload (static serving, no deploy)
- **Area:** UI transcript rendering (app.js) — message attribution honesty
- **Reported:** 2026-08-12 by user: a `<task-notification>…` block "appears as is and as if it
  was sent by me, not sure what it's supposed to be instead"

## What happens
When a background agent finishes, the harness injects a notification into the orchestrator's
transcript as a `role:user` line whose text is the raw block:
`[SYSTEM NOTIFICATION - NOT USER INPUT] … <task-notification><task-id>…</task-id>…`.
The dashboard renders every user-role line as a user bubble, so the user sees a wall of XML
attributed to THEMSELVES. Same class presumably applies to other harness-injected user-role
turns: `[station] While you were away …` briefings, `<system-reminder>` blocks, queued-message
`[Queued Ns ago …]` prefixes.

## Wanted
1. Detect harness-injected user-role lines by their KNOWN sentinels (exact prefixes:
   `[SYSTEM NOTIFICATION - NOT USER INPUT]`, a leading `<task-notification>`, leading
   `<system-reminder>`, `[station]` lines) — conservative matching so a real user message that
   merely QUOTES such text is never misclassified (sentinel must be at position 0 of the line).
2. Render them as a compact station-style system notice (distinct styling, not a user bubble):
   collapsed one-liner ("⚙ background agent finished — <agent name/summary>") expandable to the
   full payload; task-notification blocks get their summary/status fields parsed out for the
   one-liner when present.
3. The real user messages around them keep today's rendering exactly.

## Verification (§C)
Fixture transcript containing: a real user message, a task-notification user-line, a
[station] briefing user-line, and a user message that QUOTES "<task-notification>" mid-text →
first renders as user bubble, next two as system notices (collapsed, expandable), last stays a
user bubble (must FAIL pre-fix: all four render as user bubbles). verify:ui + verify:streaming-md
+ typecheck green.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from the user's report (they pasted the raw block back, which is itself the evidence).

### 2026-08-12 — fix (FE lane)
- **Root cause / choke point:** BOTH render paths — live-follow (`applyAppend`,
  `public/app.js:4816`) and history/reload (`renderMessages` called from `openSession`
  `:3184`/`:3308`) — converge on the ONE `renderMessages()` user branch
  (`public/app.js:2998`), which sent every `role:user` text to `youBubble`. Fixing that one
  branch covers both paths; the verify script proves it by exercising each entry point and
  asserting the split is identical.
- **Fix (`public/app.js`):**
  - `harnessNotice(text)` + `harnessOneLiner(t)` (~`:2900`): detect the four known sentinels
    (`[SYSTEM NOTIFICATION - NOT USER INPUT]`, `<task-notification>`, `<system-reminder>`,
    `[station]`) matched ONLY at position 0 of the left-trimmed text — so a real message that
    QUOTES a sentinel mid-line never matches. task-notification blocks get `<summary>`/`<status>`
    (fallback `description`/`agent-name`/`task-id`) parsed into the one-liner.
  - `noticeChip(th, notice)` (~`:2955`): a collapsed `<details class="notice">` — one-liner
    summary, disclosure holds the full payload — closing the open Claude body/stream like
    youBubble does.
  - Hooked into `renderMessages()` user branch (`:3010`): after the caption checks, a detected
    notice renders a chip instead of a bubble.
  - Exposed `renderMessages`, `mainThread`, `harnessNotice` on `window.__station` for the verify.
- **Styling (`public/styles.css` ~`:422`):** `.notice` — compact left-aligned hairline row (mono,
  `--rail` bg, `--hair-2` border), collapsed one-liner, `.notice-full` pre for the payload.
  Deliberately not a bubble and not a centred caption.
- **Verify (§C):** `scripts/verify-bug-067-notice-render.mjs` + `npm run verify:bug-067`. Real
  brave-headless + real server; renders the required fixture transcript (real msg, task-notification,
  [station] briefing, mid-text quote) through BOTH `applyAppend` and a direct `renderMessages`.
  - **Pre-fix (fix stashed): 2/9 — must-FAIL confirmed** — all four render as `.you` bubbles,
    0 notices; render order `[bubble,bubble,bubble,bubble]`.
  - **Post-fix: 17/17** — split `[bubble,notice,notice,bubble]`, quote stays a bubble,
    one-liners parse summary+status, notices are expandable `<details>` with the raw payload,
    both paths agree.
- **Anti-regressions:** `verify:ui` 7/7, `verify:streaming-md` 9/9, `typecheck` clean,
  `leak-gate` PASS (0 hits / 309 files).
- **Reach:** client-only (public/app.js + styles.css, statically served) — takes effect on the
  next page reload; no server deploy needed.

### 2026-08-12 — board hygiene: normalized to VERIFIED (board:gen → Done)
- Header keyword FIXED→VERIFIED so board:gen moves it to Done — the generator keys Done off a
  leading `VERIFIED` or a `DONE` token (`isDoneStatus` in scripts/board.mjs); "FIXED" is not
  recognized, which is why the board still showed this row as "FIXED"/Open. Evidence unchanged:
  17/17 post-fix, must-FAIL 2/9 proven, anti-regressions green, leak-gate PASS. Committed `0eddc88`.
  Client-only (static serving) so it is already live on the next page reload — no server deploy.
