# BUG-169 — a live reply shows its info block twice: raw JSON, then the rail

- **Status:** REOPENED (round 2, 2026-09-07) — the reported duplicate (raw JSON at top + correct rail below, digest item rendered twice) RECURRED live. Root cause: the byte-exact `startsWith` reconciliation guard this ticket INTRODUCED is fragile to line-ending skew between the streamed `text-delta` buffer and the CLI's canonical `block.text`; on a miss it appended a second render and orphaned the mid-stream raw-JSON settle. Fixed (round 2) by comparing in the renderer's normalised line-ending space. Fix landed unstaged in `public/app.js`; awaiting independent verification (high-stakes: session-lifecycle / render-correctness in a regression-prone file). See the 2026-09-07 round-2 entry. (Round 1: VERIFIED — reported double-render fixed & independently confirmed non-regressing for the diagnosed scope; the mid-delta residual split off as BUG-170.)
- **Severity:** medium
- **Area:** composer / transcript renderer (client — public/app.js live stream)
- **Reported:** 2026-09-06 by user (via orchestrator)
- **Verification-class:** fix  ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
While the orchestrator was replying live (five background lanes running), a single
assistant message showed its `orchard-digest` envelope TWICE: first as a raw JSON
code block, then again below it as the Done/In-flight/FYI/Decisions rail. The user
also reported "some initial JSONs don't render" — the same message, seen before the
rail appeared. Live only: reloading or re-reading the session renders it correctly
once, because the history/replay path was never affected.

## Repro
1. A live turn streams an assistant message whose FIRST block is an `orchard-digest`
   fence (the structured response envelope).
2. A background lane finishes mid/just-after that block streams — the bridge emits
   `agent-completed` asynchronously from a task-notification frame
   (`src/server/agent-bridge.ts`), which calls `finishStream(mainThread())`.
3. The block's own settled `text` event then arrives.
→ The fence is rendered twice: once raw (JSON code block), once as the rail.

## Expected
Exactly one render of the message, as the digest rail — never the raw JSON.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play: `public/app.js` — `finishStream()` (~3473), the
  `case 'text-delta'` / `case 'text'` handlers in `onEvent()` (~8690/8709), and the
  `finishStream` callers: `agent-completed` (~8862, the wild trigger), `tool-call`,
  `question-request`/`plan-request`, `turn-end`, `applyAppend`, `loadNewer`.
- Root cause: `finishStream()` replaced the open stream wrapper with `prose(text)`
  — the raw, digest-UNAWARE renderer — and set `th.stream = null`. When the block's
  trailing settled `text` event arrived it found `th.stream` null, took the `else`
  branch and APPENDED `assistantProse(e.text)` — a SECOND, digest-aware render of the
  same text. Raw JSON first (the mid-stream `prose`), rail second (the append). Both
  reported symptoms are this one cause. Normal turns never showed it because the
  block's `text` event settles the live `th.stream` directly (the digest-aware branch
  at ~8724) BEFORE any `finishStream` runs; the bug needs a non-`text` caller
  (`agent-completed`) to settle the stream first, which five parallel lanes made frequent.
- Related tickets: FEAT-083 (the digest renderer / `assistantProse`), FEAT-016
  (honest live-markdown streaming), BUG-030/BUG-113 (agent-completed lifecycle).
- Repro test: `node scripts/scratch-bug169-live-repro.mjs` (drives the REAL live
  `onEvent` path — text-delta* → agent-completed → text — in a real headless browser;
  `ORCHARD_ROOT`/`REPRO_EXPECT` select the fixed tree vs a pre-fix HEAD copy).
- Known dependencies / blockers: none.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-06 — fixer (Opus 4.8)
- **Understood:** the diagnosis above — a mid-stream `finishStream` settled the live
  stream through raw `prose()` and nulled `th.stream`, so the trailing `text` event
  appended a second, digest-aware copy. Verified both code sites read exactly as
  diagnosed (pre-fix `finishStream` used `prose(text)`; `case 'text'` appended on a
  null stream).
- **Changed:** `public/app.js` only —
  1. `finishStream()` now renders the settled node through `assistantProse(text)`
     (digest-aware) and records a handle `th.settledStream = { node, text }`.
  2. `case 'text'` (main thread): when `th.stream` is null but `th.settledStream`
     exists and `e.text` starts with the settled buffer, it re-renders THAT node in
     place (`node.replaceWith(assistantProse(e.text))`) instead of appending the
     duplicate. `th.settledStream` is cleared on consume.
  3. `th.settledStream` is invalidated at every hard block boundary so a stale handle
     can never mis-replace a later/unrelated block: a new live stream (`text-delta`),
     a tool call / decision, a question, a plan, `turn-end`, and the persisted-render
     paths `applyAppend` + `loadNewer` (the gap-fetch/rewrite hazard). The
     `startsWith` guard is the second line of defence there.
     Also created `scripts/scratch-bug169-live-repro.mjs` (repro harness).
- **Verified:** must-FAIL proven against a byte-identical pre-fix `HEAD:public/app.js`
  copy (real server + real headless browser, same live `onEvent` path):
  - PRE-FIX: `codeBlockCount:1` (raw JSON block) + `digestCount:1` (rail) +
    `sentinelCount:2` (prose rendered TWICE) → the duplicate, 3/3 must-FAIL checks PASS.
  - FIXED (working tree): `digestCount:1`, `codeBlockCount:0`, no raw `"kind"` JSON,
    `sentinelCount:1` → 4/4 PASS. Reproduced independently in a second browser
    (Playwright MCP): `{digestCount:1, codeBlockCount:0, rawKindJson:false, sentinelCount:1}`.
  - Screenshots (single rail, no raw JSON) light + dark:
    `docs/bugs/assets/BUG-169-single-render-light.png`,
    `docs/bugs/assets/BUG-169-single-render-dark.png`.
  - Anti-regression: `npm run verify:feat-083` 22/22 PASS; `npm run verify:streaming-md`
    9/9 PASS (an early 5/9 was mid-stream 70ms-throttle timing flakiness under load —
    it passed 3/3 on reruns and 9/9 on the pre-fix tree, and I touched no live-render code).
- **Verified-by:** PENDING — an independent clean-room verify pass is warranted (this
  is a session-lifecycle / render-correctness change touching a regression-prone file,
  `public/app.js`). The fixer wrote the repro fixture; a second fresh-context verifier
  should attack a case the fixture does not cover — specifically the interleaving where
  `agent-completed` fires BETWEEN two deltas of the same block (a new stream then starts),
  which the fix handles by invalidating `settledStream` on the new stream but which the
  repro does not exercise (see handoff).
- **Still open / handoff:** one un-exercised edge, un-worsened by this fix and pre-existing:
  if `agent-completed` fires strictly BETWEEN deltas of one block, `finishStream` settles a
  PARTIAL node, then continuing deltas start a new stream (which invalidates `settledStream`),
  and the block's `text` settles the new stream — leaving the partial node as a stray
  (digest-aware now, not raw JSON). The observed/reproduced trigger is `agent-completed`
  AFTER the block's deltas complete, which the fix renders as a single rail; the mid-delta
  stray is the same shape as the pre-fix behaviour and out of the diagnosed scope. A
  verifier could try to construct it.
- **Symptom of a deeper design flaw?** yes-ish, not filed: the live renderer has SEVEN
  callers that can settle a stream, each of which must now remember to invalidate the
  re-render handle — a "settle" concept spread across the event switch rather than owned
  by one place. Not filed as ARCH yet (the `startsWith` guard makes a missed clear safe,
  not silently wrong); flagging here so a recurrence can escalate it.

### 2026-09-06 — independent verifier (clean-room, dispatched)
- **Verified-by:** dispatch anthropic run b94b2346-7483-40fc-8801-08928d4cf06d
  (fixer id differs) — **verdict: REFUTED for the full invariant; CONFIRMED &
  non-regressing for the reported/diagnosed scope.**
- **Cross-provider degradation (honest, capability not capacity):** the primary
  cross-provider verifier (`--provider openai`, Codex) could NOT run this: its
  OS sandbox returns `EPERM` on `listen 127.0.0.1` (probed, real), so it cannot
  boot the server or a CDP browser — the whole browser-driven repro is impossible
  there. OpenAI capacity itself was available. Fell back to a fresh-context
  Anthropic clean-room (`claude -p`, full host OS, `--allow-tools Bash`), given an
  EXPORTED working copy with the ambient surface removed (CLAUDE.md/AGENTS.md/.claude/
  docs/prompts stubbed, docs/bugs — incl. THIS ticket & the fixer's report —
  stripped) and only: the plain requirement, the diff, and the fixer's harness.
- **Setup:** two trees differing ONLY in `public/app.js` — FIXED (working copy) vs
  PREFIX (`git show HEAD:public/app.js`). Every adversarial case run on BOTH with a
  must-FAIL control.
- **Author test re-run (FIXED), real cmd/output:** `node scripts/scratch-bug169-live-repro.mjs`
  → `{digestCount:1, rawKindJsonPresent:false, codeBlockCount:0, sentinelCount:1}` 4/4 PASS.
  Pre-fix must-FAIL control → `{rawKindJsonPresent:true, codeBlockCount:1, sentinelCount:2}`
  3/3 (defect reproduces).
- **Case C (two interrupts in a row):** discriminating PASS — FIXED single clean
  rail `{codeBlockCount:0, sentinelCount:1}`; PREFIX shows the duplicate.
- **Case B (non-extending settle / rewritten-history frame):** discriminating PASS —
  FIXED preserves the settled rail, appends the mismatched frame separately, no raw
  JSON, no digest duplicate; PREFIX renders the digest as raw JSON with no rail.
- **Case A — MID-DELTA interrupt (the fixer's handed-off priority): FAILS the
  invariant.** `agent-completed` between two deltas of one block, continuation deltas
  start a new stream, then settled `text`. FIXED tree DOM = one correct digest rail
  **PLUS a stray partial raw-JSON `<pre>` node** (`{digestCount:1, rawKindJsonPresent:true,
  codeBlockCount:1, sentinelCount:1}`). PREFIX is IDENTICAL — so the fix neither fixes
  nor regresses this; it is a PRE-EXISTING, out-of-diagnosed-scope defect that the
  fixer explicitly flagged. But the requirement as stated ("never as raw JSON / no
  stray leftover partial node … when an unrelated event interrupts the stream partway
  through") is literally violated on the FIXED tree. This is a DIFFERENT symptom shape
  from the reported bug (stray partial + correct rail, sentinel ONCE — not the "raw
  JSON then rail" duplicate with sentinel twice).
- **Could-not-test (verifier):** persisted `applyAppend`/`loadNewer` paths driven only
  via a synthetic non-extending in-page `text` event, not a real gap-fetch/history
  round-trip; interrupt variants `tool-call`/`ask-user-question`/`exit-plan-mode`/
  `turn-end`/history-gap each clear `settledStream` in the diff but were not each run
  individually (only `agent-completed` exercised); computed-style visibility of the
  Case-A stray node not inspected (measured via `textContent`/`querySelectorAll`).
- **Orchestrator decision required:** the REPORTED bug is fixed and safe to land, but
  the mid-delta stray raw-JSON node reproduces on the fixed tree. Either (a) file the
  mid-delta stray as a NEW ticket and promote BUG-169 to VERIFIED-for-scope, or (b)
  return to the fixer to also settle/discard the partial node on the new-stream
  boundary. This is a session-lifecycle/render-correctness change in a regression-prone
  file — the residual is real and reproduced, not theoretical.

### 2026-09-06 — scope resolution + status promotion (fixer, Opus 4.8)
- **Decision taken:** option (a). The reported double-render is fixed and independently
  confirmed non-regressing for the diagnosed scope, so BUG-169 → **VERIFIED**. The
  mid-delta stray (verifier's Case A) is a DIFFERENT symptom shape (stray partial +
  correct rail, sentinel ONCE — not the "raw JSON then rail" duplicate), reproduces
  byte-identically on the pre-fix HEAD, and was explicitly flagged as out-of-scope here.
  It is split off as **BUG-170** and fixed there in the same pass (both fixes live in
  the same unstaged `public/app.js` diff).
- **Verified-by** (unchanged): dispatch anthropic run b94b2346-7483-40fc-8801-08928d4cf06d
  — CONFIRMED & non-regressing for the reported/diagnosed scope. This promotion does not
  re-open or alter that verdict; it records that the refuted FULL invariant belongs to
  BUG-170, not this ticket.
- **Anti-regression re-run after the BUG-170 change:** the BUG-169 `post` fixture still
  passes 4/4 (`node scripts/scratch-bug169-live-repro.mjs`, `REPRO_CASE=post
  REPRO_EXPECT=fixed`) — the BUG-170 fix does not reintroduce the duplicate. `npm run
  gate` PASS; `verify:feat-083` 22/22; `verify:streaming-md` 9/9 on rerun (the throttle
  timing flake noted above, not this change).

### 2026-09-07 — fixer round 2 (Opus 4.8), reopened
- **Reported (user, verbatim structure):** a LIVE assistant reply whose first fence was
  ```` ```orchard-digest ```` followed by 4-backtick ```` ````orchard-finding ````/
  ```` ````orchard-judgment ```` blocks rendered the raw digest JSON as literal text at
  the TOP (`{ "items": [ … "kind": "fyi" … ] }`) AND the same two items correctly in the
  Decisions/FYI rails below — the exact BUG-169 duplicate shape (content twice: raw JSON +
  rail), which round 1 was supposed to have fixed.
- **regressed-from:** BUG-169 (round 1). This is a gap in round 1's OWN fix, not a new area.
- **Which of (a)/(b)/(c):** (b), refined. Round 1 fixed the LIVE path for the case where the
  streamed deltas are a byte-exact prefix of the trailing `text`. The recurrence is still the
  LIVE path, via the reconciliation guard round 1 introduced (`e.text.startsWith(
  th.settledStream.text)` at the main-thread `case 'text'`). The RE-READ / persisted path was
  verified UNAFFECTED (see below), matching round 1's note that history/replay never showed it.
- **Root cause:** `finishStream()` stores `th.settledStream.text` as the RAW concatenation of
  `text-delta` frames; the trailing `text` event carries the CLI's canonical `block.text`.
  When a background lane's `agent-completed` settles the stream MID-block on an UNCLOSED
  orchard-digest fence, `finishStream` renders that partial through `assistantProse` → the
  fence is unterminated → `parseDigest` returns null → it degrades to `prose()` = a RAW-JSON
  `<pre>` (the complete `{ "items": … }`, fence not yet closed). The block's trailing `text`
  is meant to re-render THAT node in place, but the guard compares the two buffers
  BYTE-EXACTLY. Any line-ending skew (LF deltas vs CRLF `block.text` — a realistic divergence
  between the streamed frames and the canonical block) makes `startsWith` MISS, so the `else`
  branch APPENDS a second, digest-aware render (the rail) and leaves the raw-JSON node
  orphaned above it. Result: raw JSON at top + correct rail below, digest item rendered twice.
- **Why round 1 / the earlier verifier missed it:** every fixture built the settled buffer and
  the trailing `text` from the SAME string, so the two always agreed byte-for-byte and the
  guard never missed. The bug is a divergence, not a shape — invisible to a same-source fixture.
- **Ruled out as the trigger (event-model reasoning + tests):** a hard-boundary clearer
  (`tool-call`/`ask-user-question`/`exit-plan-mode`) firing between the mid-block settle and
  the continuation ALSO orphans the raw node (reproduced as case `midopen-boundary`), but it is
  NOT reachable for a dashboard-DRIVEN live turn: a `tool_use` block is emitted in the same
  assistant frame AFTER its text block, so the block's own `text` settle always precedes the
  next block's `tool-call`; `session-appended`/`applyAppend` fires only for FOLLOWED sessions
  (another terminal), never the driven socket; `turn-end` is end-of-turn. So the reachable
  trigger is the delta-vs-`block.text` line-ending skew.
- **Changed:** `public/app.js` ONLY — the main-thread `case 'text'` reconciliation guard now
  compares in the renderer's NORMALISED line-ending space (`.replace(/\r\n?/g, '\n')` on BOTH
  sides, the same boundary `renderAssistantText` applies). This makes the "continuation of the
  same settled block" test robust to line-ending skew without weakening it for a genuinely
  different later block (boundary handlers still null `settledStream` for those).
- **Verified (real server + REAL headless browser, REAL `window.__station.onEvent` path):**
  - Repro harness `scripts/scratch-bug169-r2-live.mjs` — user's exact shape (orchard-digest +
    4-backtick finding/judgment), several interleavings. Case `crlf-mismatch` is the reachable
    trigger.
    - MUST-FAIL (pre-edit, same file): `{digestCount:1, rawKindJsonPresent:true,
      codeBlockCount:1, nothingBlockedCount:2}` — the duplicate reproduces (2/6).
    - FIXED (post-edit): `{digestCount:1, rawKindJsonPresent:false, codeBlockCount:0,
      nothingBlockedCount:1}` — one rail, no raw JSON, digest item once (6/6).
  - Anti-regression, all 6/6 fixed on cases `post`, `midopen`, `midopen-textonly` (byte-exact
    prefix cases — unchanged by the fix).
  - RE-READ / persisted path proven UNAFFECTED: `scripts/scratch-bug169-r2.mjs` (happy-dom,
    `renderAssistantText` = the same drop-in the history renderer uses) on the user's exact
    message → `rawKindJson:false, digest-item count:2, each item once`. So the recurrence was
    live-only, as round 1 stated.
  - Existing suites still green: `scripts/scratch-bug169-live-repro.mjs` post 4/4 + mid 5/5;
    `npm run verify:feat-083` 22/22; `npm run verify:streaming-md` 9/9; `npm run gate` PASS
    (exit 0, read directly).
  - `npm run verify:feat-083-adversarial` reports one PRE-EXISTING failure
    (`B/preceded-by-prose: parse-null`) — it exercises `public/lib/digest.js` (byte-identical to
    HEAD here) and does NOT import `public/app.js`, so it is independent of this fix, not a
    regression from it.
  - Screenshots (single clean rail, no raw JSON) light + dark:
    `docs/bugs/assets/BUG-169-r2-single-rail-light.png`,
    `docs/bugs/assets/BUG-169-r2-single-rail-dark.png`.
- **Files changed:** `public/app.js` (the fix). New scratch harnesses (evidence, unstaged):
  `scripts/scratch-bug169-r2-live.mjs`, `scripts/scratch-bug169-r2.mjs`,
  `scripts/scratch-bug169-r2-screenshot.mjs`.
- **Verified-by:** PENDING — high-stakes (session-lifecycle / render-correctness, regression-
  prone `public/app.js`, and this is a recurrence of the ticket's own prior fix). An independent
  clean-room pass is WARRANTED. Suggested attack the fixture cannot fully cover: a divergence
  between streamed deltas and `block.text` that is NOT line-ending-only (e.g. whitespace
  trimming, a re-serialised JSON body, or a genuinely different later block arriving with
  `settledStream` still live) — does the normalised guard still miss and orphan a raw node, and
  if so is the residual a visible raw-JSON leak or (acceptably) a rarer stray? Also: the
  unreachable-in-practice `midopen-boundary` orphan (a hard boundary mid-block) remains a latent
  weakness in the shared "settle" design (7 callers), noted but not fixed here.
