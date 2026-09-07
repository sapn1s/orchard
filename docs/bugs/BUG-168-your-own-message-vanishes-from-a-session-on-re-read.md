# BUG-168 — your own message vanishes from a session on re-read

- **Status:** IN-PROGRESS
- **Severity:** high
- **Area:** bridge / transcript renderer (server + client)
- **Reported:** 2026-09-06 by user (via orchestrator)
- **Verification-class:** fix  ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
After a background agent finishes, the "while you were away" briefing fires and the
user types a message on the same turn. The message shows fine live — but navigate
away to another session and back, and the user's own sentence is GONE from the
transcript: only a collapsed "⚙ While you were away…" chip remains where their
message was. Reported against the real trading-volume session; the missing line was
"…what was porogress today, anything nice discovered?".

## Repro
1. In a session that has had a background agent die, type a prompt while the
   "[station] While you were away…" briefing is pending.
2. The message renders live (optimistic paint of the raw typed text).
3. Navigate to another session, then back (or reload) — the re-read path runs.
4. Wrong: the whole entry collapses into the notice chip; the user's words are
   invisible. (Ground truth: lines 853 and 867 of the real transcript
   a1a2ea7f-…-5377255f4c83.jsonl end with the user's real words, glued to the
   briefing in one role:user entry.)

## Expected
The briefing prefix collapses into the notice chip AND the user's own words render
as a normal user bubble directly below it — on every re-read, not just the live
optimistic paint. A pure briefing with no user prompt stays chip-only (no empty
bubble). Existing transcripts (written before any fix) render the user's words too.

## Cause
`AgentBridge.#withBriefing` (src/server/agent-bridge.ts) PREPENDS the briefing
(and, on the first turn, the board snapshot) to the user's typed prompt, joined
with "\n\n". The CLI writes ONE role:user JSONL entry: injected text first, human's
words last. On render, `harnessNotice` (public/app.js) matched the '[station]'
sentinel at position 0 and `renderMessages` swallowed the ENTIRE entry into a
collapsed notice chip, so the human's sentence was invisible on any re-read. The
live view only looked correct because `submit()` optimistically paints the raw
typed text; navigate away and the optimistic node is gone and only the re-read
(collapsed) remains.

## Fix (both halves — new entries AND existing transcripts)
1. Server: `#withBriefing` terminates the injected prefix with a self-delimiting
   sentinel `⟦STATION-BRIEFING-END⟧` (`BRIEFING_TERMINATOR`, exported) placed
   between the injected prefix and the user's words. Mathematical white square
   brackets U+27E6/27E7 — impossible in ordinary prose, survives JSONL round-trip.
   The first-turn board snapshot is now passed as `extraPrefix` (part of the
   peelable prefix) instead of pre-merged with the user's prompt. A board-snapshot-
   ONLY first turn (no briefing) is left byte-identical to before (it carries no
   `[station]` sentinel, so it is not this bug and was not widened).
2. Client: `harnessNotice` splits on `BRIEFING_TERMINATOR` — prefix → chip,
   remainder → the user's bubble (the FEAT-072 `queuedCaption` peel pattern).
   `renderMessages` renders the bubble only when the remainder is non-empty.
3. Backward compatibility: `legacyBriefingSplit` recovers the user's words from
   pre-terminator entries by the KNOWN briefing tail ("[station] This is a
   server-recorded fact"), and for first-turn entries by the board snapshot's
   `\n\n---\n\n` rule. If the boundary is not confidently found, it collapses the
   whole entry (today's behaviour) rather than guessing — briefing text is never
   rendered as if the user typed it.

## Context pack
- Files/functions in play:
  - `src/server/agent-bridge.ts` — `BRIEFING_TERMINATOR` (new export), `#withBriefing`
    (extraPrefix + terminator), first-turn call site (board snapshot as extraPrefix).
  - `public/app.js` — `BRIEFING_TERMINATOR`, `legacyBriefingSplit` (new),
    `harnessNotice` (peel), the user-role render site (emit body bubble), `window.__station` exports.
  - `src/server/outcomes.ts` `takeBriefing`, `src/server/board.ts` `boardAnswerBriefing`
    / `boardStateSection` — the briefing/board text whose tails the legacy heuristic keys on.
- Related tickets: BUG-067 (harness-injected lines are not the user's words — this is
  its blind spot: a notice that PREFIXES a real message), FEAT-072 (the peel pattern
  reused), FEAT-057/FEAT-090/FEAT-113 (the briefing + board-snapshot injection this splits).
- Repro test: `node scripts/verify-bug-168-briefing-user-words.mjs`
- Known dependencies / blockers: none.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-06 — fixing lane (agent, Opus 4.8), round 1
- **Understood:** confirmed the finding lane's cause against ground truth — the real
  transcript's lines 853 (first-turn+board) and 867 (follow-up) both end with the
  user's real words glued to the briefing in one role:user entry. The client
  collapsed the whole entry on re-read; the live view survived only by optimistic paint.
- **Changed (unstaged, worker never commits):**
  - `src/server/agent-bridge.ts` — added exported `BRIEFING_TERMINATOR`; `#withBriefing`
    now takes an `extraPrefix`, joins [answer, brief, board-snapshot] as the injected
    prefix and terminates it with the sentinel before the user's prompt (board-only-no-
    briefing path preserved exactly); first-turn call site passes the board snapshot as
    `extraPrefix` instead of pre-merging it.
  - `public/app.js` — added `BRIEFING_TERMINATOR`, `legacyBriefingSplit`; `harnessNotice`
    peels the prefix (new sentinel, else legacy heuristic, else collapse-whole) and
    returns `body`; render site emits the user bubble for a non-empty body; exported the
    two new symbols on `window.__station`.
  - `scripts/verify-bug-168-briefing-user-words.mjs` — new verify (real browser + real
    server + real transcript).
  - Screenshots: `docs/bugs/assets/BUG-168-real-session-light.png`,
    `docs/bugs/assets/BUG-168-real-session-dark.png` (gitignored per BUG-080; not published).
- **Verified (fixer's own run — necessary, not sufficient):**
  - `node scripts/verify-bug-168-briefing-user-words.mjs` → **13/13 checks passed**. Covers
    the four required cases through the app's OWN renderer (both history `renderMessages`
    and live `applyAppend` paths): new-format entry (chip + bubble, mid-prose "[station]"
    preserved in the body), the two REAL legacy entries off the user's transcript (first-
    turn+board and follow-up, exact real words recovered, board snapshot NOT leaked into
    the bubble), briefing-only entry (chip, NO empty bubble), a mid-prose "[station]"
    message (stays a bubble). Plus a drift guard: server↔client terminator literal identical.
  - MUST-FAIL proof (same script, fix toggled OFF by reverting `harnessNotice` to its
    pre-fix 2-line body): **6/13**, with the exact symptom failures — "NEW-format user
    words render as a bubble", "LEGACY first-turn(+board) user words recovered", "LEGACY
    follow-up user words recovered", and "[live] user words survive". Restored → 13/13.
  - Anti-regression: `verify-bug-067-notice-render.mjs` **17/17** (sibling notice-render),
    `verify-feat-072-queued-caption.mjs` **20/20** (the peel pattern reused).
  - `npm run gate` → **PASS (exit 0)** — leak-gate + check-nul + typecheck all green.
  - LIVE UI on the REAL session (scratch server on a free ephemeral port, isolated
    `CLAUDE_STATION_DATA`, `CLAUDE_PROJECTS_DIR` = real store read-only; 4317 untouched):
    opened trading-volume/a1a2ea7f-…, navigated AWAY to the session list and BACK, then
    screenshotted. The DOM shows the user's message "so its been another day, what was
    porogress today, anything nice discovered?" as a `.you` bubble sitting directly below
    the collapsed "⚙ While you were away: 17 agent/turns…" chip, with the assistant reply
    "Nothing was discovered today…" following. No notice `.notice-full` contains the user's
    words. Both LIGHT (`docs/bugs/assets/BUG-168-real-session-light.png`) and DARK
    (`docs/bugs/assets/BUG-168-real-session-dark.png`) themes.
- **Verified-by:** PENDING — this is a `fix` touching session/transcript rendering with a
  backward-compat heuristic (regression-prone). Needs an independent clean-room dispatch
  (`scripts/independent-verify.mjs`) exercising a case the fixture does not: e.g. a legacy
  first-turn entry whose USER words legitimately contain a "\n\n---\n\n" markdown rule (does
  the heuristic still cut at the board boundary?), and a legacy entry whose briefing tail
  wording differs slightly (does it collapse-whole rather than mis-split?).
- **Still open / handoff:** INDEX.md left to the orchestrator (board README: workers do not
  edit INDEX). Orchestrator: add the BUG-168 Open row + run `board:gen`, then dispatch the
  independent verify before flipping to VERIFIED.
- **Symptom of a deeper design flaw?** (answer on close) — candidate yes: injected context
  and the user's words share one role:user JSONL entry with no structural boundary, so every
  reader (renderer, and any future transcript consumer) must re-derive where the injection
  ends. This fix adds an explicit terminator (owner-declared boundary) for briefings, but the
  board-snapshot-only and other injection paths still glue text without one. Flagging for the
  orchestrator to decide whether an ARCH ticket is warranted rather than filing one from a fix lane.

### 2026-09-06 — independent-verify lane (agent, Opus 4.8), round 1 — BLOCKED (could not run harness)
- **Verdict:** BLOCKED — the mandated cross-provider clean-room harness could NOT be run. This is
  NOT a PASS, FAIL, or INVALID; the fix is neither verified nor refuted. Ticket stays IN-PROGRESS.
- **Why:** `scripts/independent-verify.mjs` builds its clean room via `git archive <rev>` and derives
  the diff via `git diff <base> <head>` — it structurally requires a COMMITTED revision containing the
  fix (no working-tree / diff-file input mode exists in its arg parser). The BUG-168 change is
  entirely uncommitted working-tree state: confirmed absent from all refs
  (`git log --all -S BRIEFING_TERMINATOR -- src/server/agent-bridge.ts public/app.js` → empty; not in
  HEAD). Git writes are globally disabled for this agent session (the git-write hook blocks
  `git hash-object`, `git init`, `git add`, `git commit` everywhere — even a throwaway `/tmp` repo —
  and my dispatch charter independently forbids any git write), so I cannot synthesize the range, and
  the fixer (also an agent) left the work unstaged. Net: no revision exists to feed the harness, and I
  cannot create one.
- **What I did NOT do (deliberately, per charter):** did not fabricate a verdict, did not verify the
  claim inline in this context (that would share the fixer's blind spot — the whole point of the
  clean-room harness), did not attempt any repair, did not touch the concurrent FEAT-129 lane's lock.
- **Decision needed from the user/orchestrator (pick one), then re-dispatch verify:**
  1. USER commits the ISOLATED BUG-168 diff — `src/server/agent-bridge.ts`, `public/app.js` (and
     ideally `scripts/verify-bug-168-briefing-user-words.mjs` so the clean room can run the fixer
     test) — as its own commit, so verify can run `--range <that-commit>` with a clean 2-file diff; OR
  2. USER grants git writes for this project (`node scripts/git-grant.mjs orchard --once` / dashboard
     "Allow git writes") so a verify lane may synthesize an isolated base/head range itself.
  Option 1 is cleanest (the working tree currently mixes ~8 unrelated tickets' changes, so an
  all-working-tree commit would contaminate the verified diff).
- **When runnable, the intended invocation (cross-provider, author=Claude):**
  `node scripts/independent-verify.mjs --requirement @<req> --range <base>..<head>
   --run 'node scripts/verify-bug-168-briefing-user-words.mjs'
   --test-file scripts/verify-bug-168-briefing-user-words.mjs
   --author-provider anthropic --provider openai --keep-cleanroom`
  Adversarial cases still owed by the verifier (fixer fixture does NOT cover): legacy first-turn whose
  user words legitimately contain the board `\n\n---\n\n` rule; legacy entry with slightly different
  briefing tail wording (collapse-whole vs mis-split); a user message containing the literal `⟦ ⟧`
  sentinel chars; a briefing whose tail is truncated by transcript rotation.
- **Verified-by:** NOT ADDED — harness did not run; no dispatch run id exists to cite.
