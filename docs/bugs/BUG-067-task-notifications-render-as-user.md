```orchard-ticket
{
  "id": "BUG-067",
  "type": "bug",
  "title": "Harness notices appeared as messages sent by the user",
  "summary": "Harness-generated transcript entries now appear as compact system notices instead of user messages. Notices can expand to show their full contents, while surrounding messages and quoted notice text retain normal user styling.",
  "impact_if_we_wait": "Without the correction, people may mistake internal notices for messages they sent. Bounded: this affects transcript attribution and display-correctness, not message contents, stored data, or background task execution.",
  "current_need": "Treat the ticket as closed: the pre-fix case failed, corrected rendering passed, standing checks stayed clean, and the client change is live after reload.",
  "severity": "medium",
  "area": "Transcript message attribution",
  "reported": "2026-08-12",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-12",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Harness task notifications render as compact expandable system notices",
    "Station briefings render as system notices rather than user messages",
    "Real user messages retain their existing rendering",
    "Quoted notification markup within user text remains a user message"
  ],
  "code_refs": [
    {
      "path": "app.js",
      "symbol": null,
      "note": "BUG-067 changed transcript classification and rendering for harness-generated user-role lines."
    }
  ],
  "related": [
    {
      "id": "BUG-081",
      "relation": "see_also"
    },
    {
      "id": "FEAT-072",
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
    "archived_path": "docs/bugs/archive/BUG-067-task-notifications-render-as-user.md",
    "sha256": "2daa0722073cf94a699e55cf39297fa92f8083e0b35d485c066dde8cff27f910",
    "bytes": 5568,
    "original_title": "harness task-notifications render as USER messages (raw XML bubble attributed to the user)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied original; the symptom, conservative detection rule, notice behavior, preserved user rendering, executed evidence, commit, and reload behavior are present.",
    "dropped": []
  }
}
```

# BUG-067 — Harness notices appeared as messages sent by the user

## Diagnosis

The harness records background-task notifications and similar briefings with the user role. The dashboard previously treated that role as sufficient proof of authorship, so raw notification markup appeared in a user bubble.

## Evidence

Before the correction was applied, the fixture proved the failure in 2 of 9 checks. Afterwards, `verify:ui` passed 7/7 and `verify:streaming-md` passed 9/9. A separate matched tally recorded 17/17. Type checking and the leak gate were clean.

## Implementation notes

Classify known harness content only when its sentinel begins at position zero. Render matching entries as compact, expandable station-style notices. Extract available task summary and status fields for the collapsed line, while leaving ordinary user messages unchanged.

## Verification plan

Use a fixture containing an ordinary user message, a task notification, a station briefing, and user text quoting task-notification markup mid-message. Confirm only the two harness entries become collapsed, expandable system notices.

## Migration and rollback

The change is client-only and becomes live when the page reloads under static serving; no deployment step is required. Commit `0eddc88` contains the correction and provides the revert boundary.

## Risks

Broad matching could misattribute genuine user text. Requiring a known sentinel at the start of the line limits that risk, though additional harness formats need explicit recognition.

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
