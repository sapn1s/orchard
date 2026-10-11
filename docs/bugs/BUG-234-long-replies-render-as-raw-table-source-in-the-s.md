```orchard-ticket
{
  "id": "BUG-234",
  "type": "bug",
  "title": "Long replies render as raw table source in the session reading view",
  "summary": "The transcript reading view truncated every assistant text block to 4000 chars server-side. A 6535-char reply wrapped in a 4-backtick orchard-answer fence was cut mid-table, losing the closing fence; the client fell back to rendering the whole message as prose and the unterminated fence showed the raw Markdown table source as one code block instead of a table.",
  "impact_if_we_wait": "Any stored or live assistant reply longer than 4000 chars that contains a fenced table or code block renders as unreadable raw source in the reading view, and the reply is silently shortened with no visible marker.",
  "current_need": "Deliver full message text in the single-session reading view; make any remaining (explicit-excerpt) truncation fence-safe and visibly marked.",
  "severity": "high",
  "area": "server / drawer (transcript reading view)",
  "reported": "2026-10-07",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-07",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The real 6535-char message from session 1f4cad56 served through the transcript route renders a <table> and no <pre> wrapping the table source.",
    "Truncating that real message at many offsets with an explicit cap never renders the table source as a <pre>.",
    "Must-FAIL: a synthesized pre-fix state (4000-char hard slice) reproduces the <pre> / raw-source render."
  ],
  "code_refs": [
    {
      "path": "src/server/jsonl.ts",
      "symbol": "blocksOf",
      "note": "default maxTextChars was 4000; now no-cap unless a caller passes one; text goes through session-history deliverText (plain cut + truncated/fullLength, r3)"
    },
    {
      "path": "src/server/index.ts",
      "symbol": "transcript + subagent routes",
      "note": "4 reading-route call sites defaulted maxTextChars to 4000"
    },
    {
      "path": "src/server/watcher.ts",
      "symbol": "watchSession",
      "note": "live follow passed opts {} -> inherited the 4000 default"
    },
    {
      "path": "public/lib/digest.js",
      "symbol": "renderBody/renderAssistantText",
      "note": "falls back to prose(whole) on an unterminated fence; r3: renderAssistantText({truncated}) applies closeTruncatedFence + a visible note"
    },
    {
      "path": "public/lib/response-blocks.js",
      "symbol": "closeTruncatedFence",
      "note": "r3: the ONE place a truncated block is made renderable, from the parser's own fence/container verdict"
    }
  ],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a1137b-2bc6-7693-92ab-618ef043a1b5",
      "verdict": "broken",
      "verdict_on": "2026-10-06",
      "recorded_at": "2026-10-06T23:14:26.167Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "BROKEN, 2 distinct paths (two-break STOP->single-authority redesign). P1: subagent PAGE route still caps 4000 (subagents.ts:349 ?? 4000; fix only touched jsonl.ts). P2: danglingFenceCloser regex misses CRLF fences -> unterminated fence on cut. P3/P4 held. Full repro in Activity log."
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a1138e-89c6-70a2-8440-737d9f38c182",
      "verdict": "broken",
      "verdict_on": "2026-10-06",
      "recorded_at": "2026-10-06T23:36:58.599Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "BROKEN r2: NEW 3rd break (not P1 cap/P2 CRLF). Fence nested in a LIST item: danglingFenceCloser appends a col-0 closer the client container-bound rejects -> unterminated fold, table as raw prose. Two-break STOP. Reproduced (83 offsets). Contract=INVALID on citation FORMAT only; substance BROKEN."
    },
    {
      "provider": "openai",
      "model": "codex-default",
      "run_id": "01a113a8-efe2-7ae1-adcc-a04068216779",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T00:05:32.967Z",
      "author": "agent-verifying-r3",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Clean-room --working-tree, BUG-234-only copy (tree 85cc3f6820b9). Fixer 97/97 green; r1/r2 raw-pre class fixed. BROKEN on R3 (two-break STOP): empty/whitespace truncated blocks get no note (run fa705a3bc42e); truncated [station] user bubble hits harnessNotice branch. Both behind explicit cap."
    },
    {
      "provider": "anthropic",
      "model": "default",
      "run_id": "2c27e3bf-48b9-4a3d-aaf0-be922f4410df",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T00:52:20.395Z",
      "author": "agent-verifying-r4",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Clean-room working-tree, BUG-234-only copy. openai quota->anthropic. Fixer 101/101; R3+P4 held (real 6535 artifact 40/40). BROKEN R4 (1 break, live-follow applyAppend): truncated tool/thinking chip note goes in .body, so a following untruncated chip lands in a NEW .tools group. Repro 1d05c72e0134."
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a113e8-6496-7483-a923-5eac05917d71",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T01:15:23.006Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "openai",
      "model": "codex-default",
      "run_id": "01a11410-865e-70a0-a890-d993d7dbb863",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T01:58:59.567Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Clean-room r6 (independent-verify.mjs). BROKEN, 2 SUBSTANTIVE: (1) same-msg applyAppend drops appended block + loses note on later-append truncation; (2) initial render shares body across consecutive msgs, msg0 note lands after msg1. P4+R-safe HOLD. scratch/bug234r6-verdict.txt"
    },
    {
      "provider": "openai",
      "model": "codex-default",
      "run_id": "01a11567-3312-7642-9571-fd5f064c19d7",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T08:15:11.535Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Clean-room r7 (isolated copy, x-provider openai). Fixer 22/22. V1/V2/V4 HOLD; V3 normal-content DOM identical. SOLE break COSMETIC: r7 drops 'truncated' label from oversized(>16KiB) tool_use INPUT chips (confirmed vs true HEAD); no text lost. Symptom fixed. See Activity log + bug234r7-verify.log."
    },
    {
      "provider": "openai",
      "model": "codex-default",
      "run_id": "01a11573-f0d8-7613-8f2d-3aa59abbfe27",
      "verdict": "holds",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T08:26:51.915Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Clean-room r8 (independent-verify --working-tree, isolated copy, x-provider openai). Fixer 25/25 incl. new tool_use 'truncated' label T1-T3. V1/V2/V4 HOLD; V5 label IFF capped, 6 tools (33/33). Could-not-test: V3/V5 vs real HEAD blocked by empty .git (as r7); closed fixer-side. bug234r8-verify.log"
    }
  ],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": false,
    "Implementation notes": true,
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

# BUG-234 — Long replies render as raw table source in the session reading view

## Symptom

Opening a stored session in the transcript reading view, a long assistant reply (a 6535-char `orchard-answer` fold — the "All 26 sessions rechecked just now" message in session 1f4cad56-e1bf-4d26-8057-499e5268612c, near index 62) rendered as raw Markdown table SOURCE inside one giant code block (`<pre>`), instead of a formatted table. The user saw backticks and pipe characters, not a table.

## Repro

1. Open a session whose assistant text block exceeds 4000 chars and wraps a 4-backtick `orchard-answer` fence containing a Markdown table.
2. The transcript route truncates the block to 4000 chars server-side, cutting mid-table and dropping the closing ```` fence.
3. Client `parseResponseBlocks` sees an UNTERMINATED fence, `renderBody` falls back to `prose(whole)`, and the unterminated fence renders the table source as one `<pre>`.

## Expected

The single-session reading view delivers the FULL message text (no 4000-char slice), so the fence stays intact and the table renders as a `<table>`. Any truncation that still happens for an explicit excerpt caller must be fence-safe: a cut must never flip the text into a code block, and must be marked visibly.

## Diagnosis

`blocksOf` (src/server/jsonl.ts) defaulted `maxTextChars` to 4000 and sliced every text block at that cap, setting `truncated:true` but leaving the cut text raw. The reading routes (GET /api/transcript tail at index.ts ~2054 and forward at ~2100; subagent tail ~3306 and page ~3325) all passed an explicit `maxTextChars` defaulting to 4000, so the reading view always capped. The live `follow` watcher (watcher.ts, opts `{}`) inherited jsonl's 4000 default too. Previews/excerpts legitimately want a cap, but they pass it explicitly or use a separate function (templates.ts `maxChars`); they do not rely on this route's default.

## Implementation notes

Least-invasive design, two parts:

1. **Default = full fidelity.** `blocksOf` now treats an ABSENT `maxTextChars` (`== null`) as "no cap" (Infinity), not 4000. A cap applies only when a caller ASKS for one. The reading routes pass `maxTextChars` only when the client query string carries it; the live `follow` watcher (opts `{}`) now streams full text for free. This keeps the fact in one place (ARCH-010): callers that want an excerpt declare it; absence means all of it.
2. **Fence-safe truncation.** When a cap DOES apply and a block overflows, `fenceSafeTruncate` closes any dangling code fence (`danglingFenceCloser`, CommonMark rules matching the client's `isClosingFence`/`openerOf`) and appends a visible `⟨…truncated…⟩` marker. A cut can no longer leave an unterminated fence, so it can never flip table source into a `<pre>`; the client parses the closed (partial) fold and renders surviving rows as a table.

**Superseded in r3 (see Activity log, fixing r3).** Point 2 broke three times because the server was mirroring the client's grammar. The current design: the server's `deliverText` (src/lib/session-history.ts) makes only a plain cut and adds `truncated` + `fullLength` metadata. It holds no markdown rules and appends no marker. The client's `closeTruncatedFence` (public/lib/response-blocks.js) closes the fence that the cut left open, using the parser's own fence/container record and verifying the result by re-parsing. If no closer verifies, it drops the unclosable fold. `renderAssistantText({truncated, fullLength})` applies it and appends a visible `.trunc-note`. User bubbles and thinking chips show the truncation too.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-07 — agent (fixing r6) — BUILT + VERIFIED
- **regressed-from: BUG-234 r5** (r5 kept the note PER-BLOCK, hosted on each block's own rendered element. The r5 verifier, run 01a113e8, found two more holes of the same enumerated class — repro states: empty-text-sandwich (manifest e14793f53af3) and command-caption-host (manifest 21e327b48aac). Per the two-break STOP → the single-authority redesign.)
- **Root cause (the recurring class, now closed):** the truncation note had to be placed correctly in EVERY branch of the per-block renderer (`renderBlockEntry`), so each new branch shape was a fresh place to get it wrong — r3 (empty/whitespace drop, harnessNotice), r4 (tools-group split on the shared body), r5 (empty cut text rendering an empty `.prose` BETWEEN two chips → splits the one `.tools` group into two; a truncated `<command-name>` caption hosting its note on an ancestor). Enumerated property: a per-block note cannot be made correct branch-by-branch.
- **Fix (single-authority, MESSAGE-level — charter redesign):** the note is no longer a per-block concern. `public/app.js`:
  - `renderMessages` now (a) DROPS an empty/whitespace text/thinking block even when `truncated` (same as any empty block) — so a cut never renders an empty node between chips; and (b) after rendering a message's blocks, emits ONE message-level note iff ANY block of that message carried `truncated` (`const cut = blocks.filter(b => b.truncated)`), via the new `appendTruncationNote`. One emission site, keyed only on the message's flags.
  - `appendTruncationNote` places the note AFTER the message's body, never in or between blocks: for an assistant message as a sibling of `.body` appended INTO the `.claude` container (later chips/prose append into `.body`, so a footer there can never split a `.tools` group and the body DOM is identical to the flag-cleared render); for a user message right after the bubble/caption/notice-chip it rendered (`userHost.after(note)`).
  - `renderBlockEntry` no longer emits any note; it now RETURNS the primary node it created (so a user message can anchor its note). It mentions neither `truncationNote(` nor `.trunc-note` (asserted structurally, U13).
  - `digest.js` already held no note logic (kept `closeTruncatedFence` render-safety untouched, as chartered); no change needed there.
- **Hypothesis (CONFIRMED):** every entry point funnels through `renderMessages`→`renderBlockEntry` (the sole block→DOM path). Containers ARE reused across consecutive assistant messages (a tool_result user message renders nothing and does not reset `th.claudeBody`), but a footer on `.claude` after `.body` is safe because `toolsGroup()`/`claudeBody()` append into `.body`, not the container. `applyAppend` sets `th.claudeBody = null` (app.js:10627) BEFORE `renderMessages`, so it always builds a fresh container and never appends blocks into one that already has a footer — no re-anchoring needed. (NOT a STOP: shared containers are expected; the footer design holds for them.)
- **Verified (all green):**
  - `node scripts/verify-bug-234-single-authority.mjs` → **122/122** (was 115/115). New: U13 (renderBlockEntry emits no note), U14 (the one call site is in `appendTruncationNote`); R4 matrix note-oracle changed to message-level (exactly ONE note iff any block cut, not one-per-cut-block); 3 r5 shapes added to the matrix (empty-text-sandwich, whitespace-sandwich, empty-cut-then-chip) all PASS (one `.tools` group, 1 note, 0 `.body`-child notes, body outline identical to the flag-cleared render); a synthesized-r5-state must-FAIL (empty cut kept + per-block note → 2 groups); and an R5 caption probe (truncated `<command-name>` → exactly one note right after the caption, caption text unchanged).
  - **Must-FAIL on the REAL pre-fix code:** reconstructed the r5 `renderMessages`/`renderBlockEntry` verbatim into the working tree and re-ran — the 3 r5 empty-sandwich shapes FAIL (the exact group-split) and R4[two-trunc-chips]/[four-blocks] FAIL (r5 emits 2 notes where message-level emits 1), while render-safety R (LF/list-nested sweeps) and the R5 caption still PASS (in a single-message pane r5's pane-hosting coincides with after-caption, so the caption case is a correctness assertion of the new placement, not a discriminator — the empty-sandwich is the discriminating must-FAIL). Restored the fix → 122/122.
  - `node scripts/verify-bug-234-reading-view-full-text.mjs` → **40/40** (REAL 6535-char artifact; A renders a `<table>` uncapped; C4 dense 285-cut sweep shows the message-level note on every cut and 0 raw `<pre>`; C1/C2 pre-fix must-FAIL still reproduces the raw `<pre>`).
  - Anti-regression: `verify-feat-091-response-blocks` **330/330/0 skipped**; `verify-feat-081-tables-links` **23/23**.
  - `npm run gate` → **PASS (exit 0)** — leak-gate + check-nul + typecheck all green (the r4-era leak-tokens.mjs failure is NOT present in this tree).
- **Changed files:** `public/app.js` (renderMessages drops empty cut blocks + message-level note; renderBlockEntry emits no note and returns its host; new `appendTruncationNote`), `scripts/verify-bug-234-single-authority.mjs` (U13/U14, message-level note oracle, 3 r5 matrix shapes, r5-state must-FAIL, caption probe, struct-regex update).
- **Note on git:** the entire BUG-234 r1–r6 change set is UNCOMMITTED working-tree state; HEAD (e79aada) predates all of it. Left unstaged for the user (no git writes).
- **Could not test:** on-screen pixel visibility of the message-level note (off-screen verify pane is not laid out — `offsetParent`/`getClientRects` are harness artifacts); a design screenshot review of the note now sitting as a footer after the message body (vs r5's in-block placement) is warranted.
- **High-stakes:** render-regression class, 6th round — an independent clean-room verify pass (scripts/independent-verify.mjs / a fresh-context agent) is warranted before marking reachable; generation must not be its own only verifier.

### 2026-10-07 — agent (fixing r5) — BUILT + VERIFIED
- **regressed-from: BUG-234 r4** (r4 moved the note to a single chokepoint but hosted it on the shared `.body` as a sibling after the `.tools` group; the r4 verifier found the break, run 2c27e3bf, repro 1d05c72e0134).
- **Problem (property R4 — render safety R3/P4 held):** in `renderBlockEntry`, the assistant branch set `noteAnchor = body` (the shared `.claude > .body`). A truncated tool_use/thinking chip renders INTO a `.tools` group, but the chokepoint then appended its `.trunc-note` to `body` — a sibling AFTER the `.tools` group. `toolsGroup()` reuses a group only while it is `body.lastElementChild`; with the note now the last child, the NEXT untruncated chip in the same message opened a SECOND `.tools` group. So a truncation changed how an UNtruncated neighbour rendered (R4 violation). Realistic trigger: one assistant turn with a huge `Write` (server caps the serialised input at 16 KiB → `truncated:true`) followed by a `Read` in the same message.
- **Fix (hypothesis confirmed, single chokepoint kept):** the note now hosts INSIDE the element the block itself rendered, never a `.body` sibling. `public/app.js renderBlockEntry`: the assistant branch sets `noteAnchor` to the rendered node per kind — the assistant prose node (text), the `historyChip` `<details>` (thinking and tool_use) — instead of `body`. The chokepoint `if (b.truncated) noteAnchor.append(truncationNote(...))` is UNCHANGED and still the one emission site keyed only on `b.truncated`. The user branch already hosted on its bubble/notice-chip/caption, so it was left as-is. Non-truncated blocks render byte-for-byte as before; a truncated chip keeps the `.tools` group as `body.lastElementChild`, so neighbours are unaffected.
- **Visual consequence (DECISION for the orchestrator):** a chip (thinking/tool_use) note now lives inside the collapsed `<details>`, so it is visible only when the chip is expanded (UA default hides non-`<summary>` children of a closed `<details>`); prose and user-bubble notes remain always-visible. This is the literal hypothesis (note scoped to the content it describes, both revealed on expand) and is defensible, but it is a visibility change from r3/r4 for CHIPS specifically. Alternative if always-visible chip notes are wanted: host the chip note as a sibling INSIDE the `.tools` group (still non-body, still group-preserving — the structural suite passes it too). Deferred to the orchestrator; implemented the hypothesis as chartered.
- **Verified (all green):**
  - `node scripts/verify-bug-234-single-authority.mjs` → **115/115** (was 101/101). New Part R4: a structural-equivalence matrix of 10 mixed-block messages (truncated + untruncated tool/thinking/text in one message), each rendered twice through the REAL `renderMessages()` in headless brave — as-is and with every `truncated` flag cleared — asserting identical `.tools` group count, identical chip parent chains, an identical DOM outline (with `.trunc-note` nodes stripped from the truncated render), one note per truncated block, and ZERO notes as a direct `.body` child. Tool chips use Bash/Read (no Edit/Write diff element) so the only render difference is the note. Entry points driven on the real paths: live-follow `applyAppend` (armed thread state, repro → 1 group) and subagent `viewAgent` (REAL >16 KiB `Write` + `Read` fixture served through the real route → 1 group, 2 chips, 1 note, 0 body notes); resync/gap-fill covered structurally (`renderBlockEntry` is the sole block→DOM path, called once from `renderMessages`).
  - **Must-FAIL on the REAL pre-fix code** (reverted the `renderBlockEntry` edit, re-ran): the 10 R4 matrix shapes + applyAppend + viewAgent all FAIL (12 checks), while R3/P4 still PASS — proving R4 is a distinct, real break, not an oracle artifact. The in-suite synthesized r4 renderer (note on `.body`) also reproduces the 1→2 group split. Restored the fix; re-ran → 115/115.
  - `node scripts/verify-bug-234-reading-view-full-text.mjs` → **40/40** (real 6535-char artifact; P4 held).
  - Anti-regression: `verify-feat-091-response-blocks` **330/330/0 skipped**; `verify-feat-081-tables-links` **23/23**.
  - `npm run gate` → **PASS (exit 0)** — leak-gate + check-nul + typecheck all green in this tree (the other-lane leak-tokens failure noted in the dispatch is not present here; neither of my files is flagged).
- **Changed files:** `public/app.js` (renderBlockEntry assistant branch), `scripts/verify-bug-234-single-authority.mjs` (added Part R4 matrix + must-FAIL + applyAppend/viewAgent entry points + the mixed-message subagent fixture).
- **Could not test:** real on-screen pixel visibility of the note placements (the off-screen verify pane is not laid out, so `offsetParent`/`getClientRects` are harness artifacts — even the always-visible prose note reads invisible there); the collapsed-chip visibility claim rests on the UA `<details>` rendering rule, not a screenshot. A design screenshot review is warranted for the chip-note-on-expand look.
- **High-stakes:** render-regression class, 5th round — an independent clean-room verify pass (scripts/independent-verify.mjs / a fresh-context agent) is warranted before marking reachable; generation must not be its own only verifier.

### 2026-10-07 — agent (fixing r4) — BUILT + VERIFIED
- **regressed-from: BUG-234 r3** (r3 fixed render safety but left two note-emission holes in `renderMessages`, found by the r3 verifier, run 01a113a8).
- **Problem (property R3 only — render safety from r3 held):** the visible `.trunc-note` appeared iff `truncated:true` FAILED on two paths. (1) `renderMessages`'s `useful` filter dropped empty/whitespace-only text & thinking blocks, so an empty/whitespace block flagged `truncated:true` rendered nothing and showed no note. (2) a truncated user bubble whose text started with `[station] ` took the `harnessNotice` branch, which had no note append — r3 appended the note only in the plain-bubble `else`. The note was duplicated across three branches (digest.js `renderAssistantText` wrap, the plain user bubble, the thinking chip label) and absent from the rest.
- **Fix (structural, single chokepoint — not a guard per branch):**
  - `public/app.js`: `renderMessages` now (a) keeps a block when it has content OR `truncated` is set (empty/whitespace truncated blocks survive), and (b) delegates every block to a new `renderBlockEntry(th, m, b, mark)`. That function renders the content per role/type (user bubble, harness notice, command/queued caption, assistant prose, thinking chip, tool_use chip), each branch setting a `noteAnchor`; the `.trunc-note` is then emitted ONCE at the foot of the function, `if (b.truncated) noteAnchor.append(truncationNote(...))`, as a pure function of `b.truncated` and nothing else. No branch emits its own note. The thinking chip label dropped its bespoke `, truncated` suffix (the chokepoint note now carries it); the tool_use chip dropped its `res:'truncated'` text likewise. Non-truncated blocks render byte-for-byte as before.
  - `public/lib/digest.js`: `renderAssistantText` no longer appends the note or the `.msg-truncated` wrap. It keeps `closeTruncatedFence` (RENDER SAFETY, keyed on `truncated`) and returns one node on every path. `truncationNote` stays exported for the single app.js call site.
- **Verified (all green):**
  - `node scripts/verify-bug-234-single-authority.mjs` → **101/101** (was 97/97). New: U11 asserts `truncationNote(` has exactly ONE call site across all of `public/`; U12 asserts `renderAssistantText` does not append the note. New Part R3: every block kind × {empty, whitespace, `[station] …`, normal} × {truncated,false} = **32 cases**, graded through the REAL `renderMessages` in headless brave — one `.trunc-note` iff `truncated:true`, zero otherwise; all 32 correct. R3 must-FAIL: a synthesized r3 renderer (faithful to the two r3 defects) drops the note on the empty / whitespace / `[station]` truncated cases, reproducing the break under the same oracle.
  - `node scripts/verify-bug-234-reading-view-full-text.mjs` → **40/40** (real 6535-char artifact; C must-FAIL still reproduces the raw `<pre>`).
  - Anti-regression: `verify-feat-091-response-blocks` → **330/330/0 skipped**; `verify-feat-081-tables-links` → **23/23**.
  - `npm run gate`: **typecheck PASS, check-nul PASS. leak-gate FAIL, but entirely in `scripts/lib/leak-tokens.mjs`** (4 doc-comment examples, lines 391–395) — a file this change does NOT touch and the subject of open BUG-236 / FEAT-169 / ARCH-023. None of this change's files (app.js, digest.js, the verify script) are flagged.
- **Could not test:** no visual/screenshot review of the note placed as a body sibling vs. its old in-wrap position (functionally one note per truncated entry, confirmed by count). The leak-gate pre-existing failure blocks a clean `gate` exit 0 independent of this work.
- **High-stakes:** render-regression class, 4th round — an independent clean-room verify pass (scripts/independent-verify.mjs / fresh-context agent) is warranted before marking reachable.

### 2026-10-07 — agent (fixing r3) — BUILT + VERIFIED
- **regressed-from: BUG-234 r1/r2** (the server fence-closer that r1 introduced and r2 extended is the thing removed).
- **Changed:**
  - `src/lib/session-history.ts`: `deliverText` is now a plain cut. It backs off only a split surrogate pair and returns `{text, truncated, fullLength}`. DELETED `danglingFenceCloser`, `fenceSafeTruncate`, `TRUNCATION_MARKER`, `FENCE_OPEN_RES`/`FENCE_CLOSE_RES`, `fenceOpenerOf`, `isFenceCloser`. `TranscriptBlock.fullLength?` added. The header comment states that the server does not reason about markdown.
  - `src/server/jsonl.ts` and `src/server/subagents.ts`: comment and type updates only. Both still call the one `deliverText`.
  - `public/lib/response-blocks.js`: new export `closeTruncatedFence` (appended; the parser itself is unchanged). It tries two bases (the text as delivered, then the text minus its partial last line) and builds the closer from the parser's own fence stack. It verifies that the same fence closes on the appended line. Its fallback is subtractive: cut before the fence.
  - `public/lib/digest.js`: `renderAssistantText(text, {truncated, fullLength})` applies `closeTruncatedFence` and wraps the whole render (all paths, including disabled and malformed digests) with a `truncationNote`, which is exported.
  - `public/app.js`: `assistantProse` passes `b.truncated`/`b.fullLength`. A truncated user bubble gets the note. The thinking chip label reads "N of M chars, truncated".
  - `public/styles.css`: `.trunc-note`.
  - Both BUG-234 verify scripts updated.
- **Verified:**
  - `node scripts/verify-bug-234-single-authority.mjs` → **97/97**.
    - U: structural. `src/` contains no fence closer, no fence-run regex in the cap authority, and no fence helpers/marker. `deliverText` is defined once and is a plain cut with metadata (surrogate-safe).
    - S: the subagent PAGE route on a real scratch server returns the full 7806-char CRLF fold uncapped. The cap gives a plain cut plus `truncated`/`fullLength`, and that capped block renders in brave with a table, the note, and no raw `<pre>`.
    - R: the real server `deliverText` feeds the REAL `renderMessages()` in brave headless. That is **3600 cuts across 17 shapes**: LF/CRLF/lone-CR 4-backtick, `~~~~`, CRLF `~~~`, CRLF 5-backtick, list-nested (the r2 break), fence on the list-marker line, ordered-list CRLF, blockquote, double blockquote, quote in a list, nested list, list in a quote, tab-indented list, a collapsed `orchard-notes` with an inner ``` fence, and a leading digest + fold. Offsets are dense through the opener line, around line starts (cuts inside container prefixes), and strided through the body. **0 cuts render table or fold source in a `<pre>`**, every cut shows the note, and every cut holding a complete row renders a `<table>` wherever the intact text does.
    - M (must-FAIL, same harness): M1 is the raw slice with a client that ignores `truncated`: **2486 bad cuts across all 14 original shapes**. M2 is r2's server col-0 closer: **1072 bad cuts**, on the list-nested and blockquote-nested shapes (the r2 break reproduced).
    - `closeTruncatedFence` path counts over the sweep: `closed` or `none` everywhere, plus `closed-after-partial-line` on the quote shapes (12/30/31 cuts). The partial-line base is exactly what the reviewer's blocking objection #1 needed. The subtractive `cut-before-fence` fallback was NEVER reached.
  - `node scripts/verify-bug-234-reading-view-full-text.mjs` → **40/40**, using the REAL 6535-char artifact. A: the no-cap route returns all 6535 chars and renders a `<table>`. C1/C2 are must-FAIL: the 4000 raw slice without the flag reproduces the `<pre>` and no `<table>`. C3: the same bytes flagged truncated render a `<table>`, the note, and no raw `<pre>`. C4: a dense sweep of the REAL message at **285 cuts gives 0 raw `<pre>` and the note on all 285**. The grader is proven non-vacuous: the same sweep without the flag gives 280/285 raw `<pre>`.
  - Anti-regression: verify-feat-081-tables-links 23/23; verify-feat-091-response-blocks 330/330; verify-feat-091-commonmark-diff 23/23; verify-feat-083-response-digest 22/22; verify-feat-082-digest 52/52; verify-bug-109-prose-lone-cr 43/43; verify-bug-155-digest-leadin 41/41; verify-arch-011-retry-routing 26/26.
  - **Pre-existing failures, not caused by this change:**
    - verify-feat-091-renderer 210/211. Its failing check "exactly ONE grammar module (git ls-files)" trips on the tracked `.orchard/lib/response-blocks.js` dogfood copy, which is unchanged by me.
    - verify-bug-193-list-fold crashes in an app.js timer (`document` undefined). The identical crash reproduces on a `git archive HEAD` export.
    - verify-feat-083-adversarial: contract BROKEN, already noted as pre-existing in r1.
  - Gate: `npm run gate` → **PASS (exit 0)**.
- **New finding filed:** **BUG-235**. A quote-nested or tab-indented fold renders its table as one literal paragraph even INTACT, because the fold body keeps its container prefix. That is a client fold-body defect, not truncation, so it is out of scope. The sweep grades the table leg against the intact baseline for those shapes and still requires 0 raw `<pre>`.
- **Note:** `.orchard/lib/{response-blocks,digest}.js` (the dogfood vendored copy, used by the response-format hook) will pick up the new export on the next fleet-sync. The hook does not render truncated blocks.
- **Could not test:** the `cut-before-fence` fallback branch, which no shape reached. Also unknown: external HTTP consumers of `?maxTextChars=` that may have relied on the in-text marker (none exist in-repo; the contract is now `truncated` + `fullLength`). There was no visual/screenshot review of the `.trunc-note` styling, and no UI path requests a cap today.
- **High-stakes:** this is a render-regression class change and the 4th round, so an independent clean-room verify is warranted.

### 2026-10-07 — agent (fixing r3) — PLAN REVIEW (cross-provider) + revisions
- **Review:** `npm run dispatch -- --provider openai` (codex default), run/thread `01a11397-e6a2-7511-b89a-7ad6c8317fd2`, class plan+review. Verdict: **revise before building**. It kept the client-owned design over a container-aware server ("its weakness is the repair contract and verification oracle, not its location"). Objections and what I did with each:
  1. **BLOCKING, accepted:** a cut inside a container prefix (e.g. `> > ` cut to `>`, or a cut right after `\n`) ends the fence's container BEFORE EOF, so an "open-at-EOF" selector misses it, and no appended closer can cross that boundary. The reviewer reproduced this with the real parser and renderer: `rawTable=true`. **Revision:** the client tries two bases, in order: the text as delivered, then the text with its incomplete final line dropped. On each base it picks the parser's fence that is unterminated with `end === lastLine`, appends candidate closers, and verifies that the SAME fence (same `start`) is now closed on the appended line. Checking only that "some fence closed" is not enough.
  2. **BLOCKING, accepted:** "return unchanged + flag" re-renders the bug. **Revision:** the fallback is guaranteed safe because it is subtractive. If no candidate verifies, it renders only the text BEFORE the unclosable fence's opener line (that is, `lines.slice(0, f.start)`) plus the visible truncation note. The fold is omitted, and its source is never shown raw.
  3. **Medium, accepted as policy:** a collapsed fold (`orchard-notes`) cut inside an inner ``` can be closed but still flagged `ambiguous-fold`. Its content stays visible and the table still renders (reviewer tested this). The certainty guard is NOT bypassed. The sweep includes this shape and asserts on rendered content (no table or fold source in `<pre>`), not only on `unterminated`.
  4. **Medium, accepted:** removing the in-text marker must not make thinking or user truncation invisible. **Revision:** the truncation note renders for capped assistant text, user bubbles, and thinking chips (the thinking label reads "N of M chars, truncated").
  5. **Medium, accepted (claim narrowed):** the precise claim is "no discovered production caller explicitly requests a cap". The BUG-234 test scripts do request one, by design. External HTTP clients are unknown. The contract is now documented as metadata: `truncated` plus `fullLength`, and no in-text marker.
  6. **Nonblocking, accepted:** a digest cut mid-JSON stays a malformed digest, and the content is preserved, not invented. The note is attached by a wrapper around the WHOLE `renderAssistantText` result, so it also survives the `enabled:false` and malformed-digest early returns.

### 2026-10-07 — agent (fixing r3) — PLAN (pre-review)
- **Hypothesis check — CONFIRMED.** (a) No in-repo caller requests a cap AND renders the result: `public/` never sends `maxTextChars` (`public/lib/api.js` `transcript`/`subagentMessages` build no such param; rg over `public/` = 0 hits). The only in-repo cap is `transcript.ts:531` `blocksOf(e,{maxTextChars:1})`, a renderability predicate that reads `.length` and discards the text. (b) `session-history.readSession` has no live caller (`requests.ts` has its own unrelated `readSession`). (c) No non-browser consumer (scripts/, docs/, skills) passes `maxTextChars`; the only consumer of an explicit cap is a hypothetical external HTTP client of the documented `?maxTextChars=` param, which gets plain JSON and renders nothing, so it does not rely on server-side fence closing. So the server fence-closer is reachable only from an explicit-cap API call, and its only effect is to restate the client grammar in a second place (ARCH-010).
- **Invariant (one sentence):** the server decides only HOW MUCH text to deliver (a plain-string cut plus `truncated`/`fullLength`), and markdown structure (fences, containers, folds) is interpreted in exactly one place, the client parser (`public/lib/response-blocks.js`), which also decides how a truncated block renders.
- **Design.** Server: `deliverText(s, cap)` stays the single cap/length authority. It returns `{text: s.slice(0, cut), truncated: true, fullLength: s.length}`, where `cut` only backs off a split UTF-16 surrogate pair (a plain string boundary, not a markdown one). It appends no marker. DELETE `danglingFenceCloser`, `fenceSafeTruncate`, `TRUNCATION_MARKER`, `FENCE_OPEN_RES`/`FENCE_CLOSE_RES`, `fenceOpenerOf`, `isFenceCloser`. `TranscriptBlock` gains `fullLength?`. Client: a new `closeTruncatedFence(text)` export sits next to `parseResponseBlocks` in `response-blocks.js`. It parses with the real parser and takes the fence record (`fences[]`: `unterminated`, `end`, `char`, `len`, `stack`) that is still open at end-of-input. It builds the closer from that record's own container stack (bq → `> `, li → `contentIndent` spaces) and then RE-PARSES to confirm the fence is now closed. If the closer does not verify, it tries the next candidate. If nothing verifies, it returns the text unchanged and flags it. `renderAssistantText(text, {truncated, fullLength})` applies that function first and appends a visible "truncated" note node. `app.js renderMessages` passes `b.truncated`/`b.fullLength`. The user bubble is a plain `<p>` and thinking is a chip, so neither interprets markdown and neither needs changes.
- **Files:** `src/lib/session-history.ts`, `src/server/jsonl.ts` (comment only), `src/server/subagents.ts` (comment only), `public/lib/response-blocks.js` (append one export), `public/lib/digest.js`, `public/app.js` (1 call site), `scripts/verify-bug-234-single-authority.mjs` (rewrite F/U legs), `scripts/verify-bug-234-reading-view-full-text.mjs` (B leg passes `truncated`).
- **Proof bar:** sweep many cut offsets for each break case (subagent page >4000, CRLF, lone CR, tilde, 5-backtick, opener-cut, list-nested and blockquote-nested 4-backtick fold) through the server `deliverText` and then the REAL client `renderAssistantText` in a real headless browser. Assert that no cut renders table or fold source inside a `<pre>`. Structural check: no fence regex or closer exists anywhere in `src/`. Must-FAIL: the r2 state (server col-0 closer, no client balancing) on list-nested/blockquote cuts, plus the raw-slice state, reproduces the `<pre>`/raw-prose failure under the same harness. Keep the real 6535-char artifact `<table>` check. Anti-regressions: verify-feat-081-tables-links, the response-blocks/digest suites, `npm run gate`.

### 2026-10-07 — agent (fixing r2)
- **Understood:** inherited the openai BROKEN verdict (run 01a1137b, 2 paths). P1: `subagents.ts:349` kept its own `?? 4000` + raw slice (`:358`) so the subagent PAGE route still capped at 4000 and was not fence-safe. P2: `danglingFenceCloser`'s regex `/^ {0,3}(\`{3,}|~{3,})(.*)$/` failed on a trailing `\r`, so a CRLF fold was never closed. Per WA §N (enumerated property, two paths) the fix is ONE authority, not another guard.
- **Hypothesis result — REFUTED (count: 2 other copies, not 1).** rg over all of `src/` for transcript-content text truncation found THREE independent "text block → delivered text" copies: `jsonl.ts blocksOf` (the de-facto authority, already fence-safe/no-cap), `subagents.ts getSubagentMessages` (the live P1 duplicate), AND `session-history.ts readSession`→`toBlocks` (an identical fence-UNSAFE `?? 4000` copy — now dead: `readSession` has no live caller, replaced by `transcript.ts` for the main route, but it was a latent landmine). Unified ALL three.
- **Changed:**
  - `src/lib/session-history.ts` — now the SINGLE authority. New exports `deliverText(s, maxTextChars?)` (no-cap default; explicit cap → fence-safe + visible marker), `fenceSafeTruncate`, `danglingFenceCloser`. Fence detection rewritten to MIRROR the client parser exactly (`public/lib/response-blocks.js` `openerOf`/`isClosingFence`: backtick info-string may not contain a backtick; tilde may; closer must be same char and ≥ opener length; fences don't nest) and is line-ending-agnostic (`split(/\r\n|\r|\n/)` — fixes P2 CRLF + lone CR; handles 3/4/5+ backtick and `~~~`, cuts inside the opener line). `readSession`/`toBlocks` now route text/thinking/tool_result through `deliverText` and default to full fidelity.
  - `src/server/jsonl.ts` — deleted its private `danglingFenceCloser`/`fenceSafeTruncate`/`TRUNCATION_MARKER`/clip; imports `deliverText`. `blocksOf` text path is now `deliverText(s, opts.maxTextChars)`.
  - `src/server/subagents.ts` — deleted the local `?? 4000` + raw-slice clip (P1); `clip` is now `hist.deliverText(s, opts.maxTextChars)` → no-cap default, fence-safe cap.
  - `scripts/verify-bug-234-single-authority.mjs` — new sibling suite (36 checks).
- **Justified remaining truncations (NOT routed through deliverText, intentionally):** tool_use JSON input cap (`jsonl.ts` 16 KiB, `session-history.ts toBlocks`) — JSON the UI `JSON.parse`s for the chip, not markdown prose; a fence-safe cut would corrupt it. `templates.ts` `maxChars` (notification/preview excerpts), `lanes.ts:730` (lane result-file clamp), `agent-bridge.ts:5386` (agent content clamp) — preview/excerpt contexts with their own markers, not reading-view transcript content. `board.ts`/`search.ts`/`index.ts:638,1843` — list/guide slices, not text-block content.
- **Verified:**
  - `node scripts/verify-bug-234-single-authority.mjs` → **36/36**. S: subagent PAGE route through a REAL isolated scratch server (isolatedServerEnv, free port) returns the FULL 7806-char CRLF fold uncapped (S1-S4), caps fence-safely with a visible marker on explicit `maxTextChars` (S5-S7), must-FAIL twin: raw 4000 slice of the CRLF fold leaves a fence OPEN per the app parser (S8). F: `fenceSafeTruncate` swept over ~220 offsets each across LF/CRLF/lone-CR 4-backtick, LF/CRLF `~~~`, CRLF 5-backtick, CRLF 3-backtick folds — EVERY cut leaves no open fence (checked with `parseResponseBlocks().fences[].unterminated` + `malformed`), and the raw-slice twin leaves fences open on the same cuts. U: structural — `fenceSafeTruncate`/`danglingFenceCloser`/`deliverText` each defined once in `src/`; `jsonl.ts`/`subagents.ts` carry no `?? 4000` and no block-text raw slice.
  - `node scripts/verify-bug-234-reading-view-full-text.mjs` → **38/38** (real brave headless over the real 6535-char message; C must-FAIL pre-fix reproduces the `<pre>`).
  - Anti-regression: `verify-feat-081-tables-links` **23/23**; `verify-arch-011-retry-routing` **26/26** (truncated/concurrent real-store transcript reads).
  - Gate: `npm run gate` → **PASS (exit 0)** — leak-gate + check-nul + typecheck green.
- **Handoff / high-stakes:** render-regression + session-lifecycle-adjacent class; independent clean-room verify warranted (generation must not be its own only verifier). `readSession` behaviour changed (4000 default → no-cap) but it is dead for the reading view (transcript.ts owns that route); no live caller observed.

### 2026-10-07 — agent (fixing r1)
- **Understood:** diagnosis inherited from agent ab690891fb4f8a409. Confirmed the real message in session 1f4cad56 near index 62 and that the client `transcript()` never passes `maxTextChars`, so the route's 4000 default governed the reading view.
- **Changed:** src/server/jsonl.ts (default no-cap + fenceSafeTruncate/danglingFenceCloser), src/server/index.ts (4 reading-route call sites default to no-cap when the query omits maxTextChars). The live follow watcher gets full text from the jsonl default alone.
- **Verified:** `node scripts/verify-bug-234-reading-view-full-text.mjs` → 38/38. Real brave headless over a scratch server (isolatedServerEnv, free port, CLAUDE_PROJECTS_DIR at a copy of the REAL transcript). A: the no-cap route returns the WHOLE 6535-char message (not 4000), not truncated, and renderMessages produces a real `<table>` (header "Project | Session | …") with NO `<pre>` wrapping the table source. B: explicit caps swept over 11 cut offsets (2000…6535) — every truncated cut renders no `<pre>` of table source, is marked `truncated`, and shows a visible marker. C (must-FAIL): a SYNTHESIZED pre-fix state (hard 4000-char slice, no fence close, no marker) reproduces the bug — a `<pre>` wrapping the table source and NO `<table>`. The real message is discovered at runtime by content and the script fails loudly if absent (no home-path literal, so the leak gate passes). Gate: `npm run gate` → PASS (exit 0), leak-gate + typecheck green. Anti-regression: verify-feat-081-tables-links 23/23, verify-arch-011-retry-routing 26/26 (truncated/concurrent transcript reads).
- **Not a regression here:** `verify-feat-083-adversarial` reports contract BROKEN ("B/preceded-by-prose: parse-null — matched a non-leading fence"), but it exercises the CLIENT renderer (public/lib response-blocks/digest), which this fix does not touch (those files are unmodified in the tree); the failure is pre-existing on HEAD and independent of BUG-234.
- **Still open / handoff:** independent clean-room verify warranted — this is a render-regression / reading-view class change (generation must not be its own only verifier). Note `src/server/index.ts` was edited concurrently by the FEAT-169 lane; the four BUG-234 route edits landed cleanly on top of its changes.
- **Symptom of a deeper design flaw?** Borderline-yes: the 4000 default was restated at 4 call sites plus jsonl (an ARCH-010 "same fact in many places" smell). This fix collapses the reading-view default to one owner (jsonl: absent = no cap); the explicit-cap default (4000) still lives per call site, but no reader reconstructs the reading-view policy now. Not filing an ARCH ticket; noted for the recurrence detector.

### 2026-10-06 — dispatch openai
- **Verification recorded:** dispatch openai/default run 01a1137b-2bc6-7693-92ab-618ef043a1b5 — VERDICT: BROKEN — BROKEN, 2 distinct paths (two-break STOP->single-authority redesign). P1: subagent PAGE route still caps 4000 (subagents.ts:349 ?? 4000; fix only touched jsonl.ts). P2: danglingFenceCloser regex misses CRLF fences -> unterminated fence on cut. P3/P4 held. Full repro in Activity log.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-06 — dispatch openai
- **Verification recorded:** dispatch openai/default run 01a1138e-89c6-70a2-8440-737d9f38c182 — VERDICT: BROKEN — BROKEN r2: NEW 3rd break (not P1 cap/P2 CRLF). Fence nested in a LIST item: danglingFenceCloser appends a col-0 closer the client container-bound rejects -> unterminated fold, table as raw prose. Two-break STOP. Reproduced (83 offsets). Contract=INVALID on citation FORMAT only; substance BROKEN.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — agent (verifying r2)
- **Launched:** independent clean-room re-verification via `scripts/independent-verify.mjs --working-tree` over a **BUG-234-only isolated copy** (reflink copy of the repo into scratch; reverted FEAT-169 + unrelated hunks — `leak-gate.mjs`, `git-grant.*`, `claude-runtime.ts`, the `runLeakGate(scope)` hunk in `index.ts`, `INDEX.md` — to HEAD via `git show`). Snapshot tree `c534c81b`; diff allow-list = 6/6 paths (the 4 BUG-234 source files + the 2 verify scripts). Cross-provider: author anthropic → verifier **openai/codex default**, thread `01a1138e-89c6-70a2-8440-737d9f38c182`.
- **Verdict — BROKEN (new, third distinct break → two-break STOP already reached).** Both fixer scripts RE-RAN and PASSED in the clean room (incl. the real 6535-char transcript browser render). The verifier then broke a property the fixer's sweep never covered.
  - **The break (Q2 "unclosed fence nested in a list" + Q3 client/server mismatch):** a 4-backtick `orchard-answer` fold **nested inside a Markdown list item** renders correctly intact, but once an explicit cap makes `deliverText` → `fenceSafeTruncate` → `danglingFenceCloser` fire, the closer it appends is **column-0 (unindented)**. The client parser's round-9 **container bound** (`public/lib/response-blocks.js`) does NOT accept a column-0 closer for a fence opened inside a list item (a col-0 line ends the list container; the fence "finds no close inside the item, degrades to `unterminated:` fallback"). Result: the GFM table renders as **raw source prose** — the exact BUG-234 symptom — on the fence-safe path itself.
  - **Root cause:** `danglingFenceCloser` in `src/lib/session-history.ts` is a **flat `{0,3}`-absolute** fence scanner; it does not model the list/blockquote **container indentation** the client parser enforces. So "mirror the client's openerOf/isClosingFence" is necessary but NOT sufficient — the client also tracks container context the server copy omits.
  - Verifier adversarial run `c5a85d15524c` (fence-boundary-sweep): **16 offsets failed**. Distinct from r1 P1 (duplicate subagent cap) and P2 (CRLF regex) → verifier invoked the **two-break STOP: "enumerated property, route to single-authority redesign."**
- **Independently reproduced against the REAL code** (`/tmp/repro_listfence.mjs`, imports the real `deliverText` + client `parseResponseBlocks`): intact list-nested fold parses as one `orchard-answer` block (blockChars 4244, counts.orchard-answer=1); after `deliverText` with an explicit cap, **83 cut offsets fall back** (blockChars 0, fallbackRuns tags `code-fence`+`table`). Confirms the clean-room finding is genuine, not a verifier artifact.
- **Contract caveat (important):** the machine verdict-contract flagged the raw reply **INVALID**, but **solely on citation FORMAT** — two `FIXER-TEST:` lines (one per fixer script passed; the contract allows exactly one), and openai/codex cannot be re-prompted to reformat (resume is anthropic-only). It was NOT a static/no-evidence INVALID: 19 runs recorded, both fixer tests re-run, adversarial break with a recorded run. Substance is a confirmed **BROKEN**. (Launch lesson: pass a single canonical fixer-test, or an anthropic verifier that can be re-prompted, when a ticket has >1 fixer script.)
- **Could-not-test (verifier's own list, carried forward):** exhaustive delivery-site enumeration, digest-route execution, independent live-follow testing, and a dedicated Q3 mismatch experiment were cut short by the two-break STOP.
- **Recommendation to orchestrator:** fix is **refuted**. Route to the single-authority redesign the two-break STOP calls for — specifically, `danglingFenceCloser` must become container-aware (track list/blockquote indentation like the client) OR the cap must refuse to cut inside a container-nested fence. High-stakes (render-regression, 3rd failed round); the next fix warrants another clean-room pass.

### 2026-10-07 — agent-verifying-r3
- **Verification recorded:** dispatch openai/codex-default run 01a113a8-efe2-7ae1-adcc-a04068216779 — VERDICT: BROKEN — Clean-room --working-tree, BUG-234-only copy (tree 85cc3f6820b9). Fixer 97/97 green; r1/r2 raw-pre class fixed. BROKEN on R3 (two-break STOP): empty/whitespace truncated blocks get no note (run fa705a3bc42e); truncated [station] user bubble hits harnessNotice branch. Both behind explicit cap.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — agent-verifying-r4
- **Verification recorded:** dispatch anthropic/default run 2c27e3bf-48b9-4a3d-aaf0-be922f4410df — VERDICT: BROKEN — Clean-room working-tree, BUG-234-only copy. openai quota->anthropic. Fixer 101/101; R3+P4 held (real 6535 artifact 40/40). BROKEN R4 (1 break, live-follow applyAppend): truncated tool/thinking chip note goes in .body, so a following untruncated chip lands in a NEW .tools group. Repro 1d05c72e0134.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — dispatch openai
- **Verification recorded:** dispatch openai/default run 01a113e8-6496-7483-a923-5eac05917d71 — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — dispatch openai
- **Verification recorded:** dispatch openai/codex-default run 01a11410-865e-70a0-a890-d993d7dbb863 — VERDICT: BROKEN — Clean-room r6 (independent-verify.mjs). BROKEN, 2 SUBSTANTIVE: (1) same-msg applyAppend drops appended block + loses note on later-append truncation; (2) initial render shares body across consecutive msgs, msg0 note lands after msg1. P4+R-safe HOLD. scratch/bug234r6-verdict.txt. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — agent-fixing-r7
- **r7 redesign: reading routes drop the cap; client note machinery deleted:** r7 (fixing, class=fix) — REDESIGN per orchestrator decision: remove the explicit-cap path from the reading view by construction, so a truncated text block can never reach the browser; delete the client truncation-note/fence-closing machinery that every r3→r6 break lived in.

  WHAT CHANGED (files, all unstaged — user does git):
  - src/server/index.ts — the 4 reading routes no longer read maxTextChars from the request: main tail, forward/follow, subagent tail, subagent page. They call tailMessages/readForward/getSubagentMessages with NO cap (undefined = full fidelity). Route doc updated. `searchParams.get('maxTextChars')` count in index.ts is now 0 (U9).
  - src/lib/session-history.ts — doc only: deliverText stays the single cap authority; records that reading routes pass no cap and the only remaining capped caller is non-reading.
  - public/app.js — deleted appendTruncationNote; removed the message-level note call + `cut` computation + lastUserHost from renderMessages (now `if (!useful.length) continue;`); assistantProse drops the `trunc` param; removed truncationNote import.
  - public/lib/digest.js — renderAssistantText no longer has a `truncated` branch (always renders whole); deleted truncationNote; dropped closeTruncatedFence import.
  - public/lib/response-blocks.js — deleted closeTruncatedFence (only digest.js reached it; parser fence-tracking left intact).
  - public/styles.css — removed `.trunc-note` rule.

  REMAINING CAPPED deliverText CALLERS (all NON-reading, enumerated):
  - src/server/transcript.ts:531 — emptiness check, `maxTextChars: 1`, used only for `.length > 0`.
  - src/server/jsonl.ts:90 — tool_use JSON input 16 KiB chip cap (`Math.max(opts.maxTextChars ?? 0, 16384)`), independent of the reading cap; a >16 KiB Write input can still mark a tool_use `truncated`, and renderBlockEntry still hides its unparseable tail (`b.truncated ? null : input`). This is render-safety, not a text cap, and places no note.
  No `public/` caller sends maxTextChars on a reading route (confirmed by rg).

  PRE-EXISTING CHECK (decision point 3) — break #1 (same-msg applyAppend drops the appended block, Bash then Read): REPRODUCES on pristine HEAD with UNTRUNCATED blocks. Exported `git archive HEAD` to scratch/bug234r7-headcheck-yXdS, added an `untrunc` probe mode (both blocks untruncated), ran against HEAD's own app.js: `node scripts/independent-run.mjs untrunc` -> readRendered:false, actual.order=[Bash], baseline=[Bash,Read], pass:false. applyAppend is byte-identical HEAD vs working tree. So it is NOT BUG-234. FILED as BUG-238 (left unfixed here); real-transport reachability is UNCONFIRMED (probe re-appends same index+uuid synthetically; watcher assigns a fresh index per line). Break #2 (consecutive-message note misplacement) is eliminated by construction — no note exists to misplace.

  TESTS (all green):
  - node scripts/verify-bug-234-single-authority.mjs -> 22/22 (U structural incl. U9 no reading-route cap + U10-14 no client note machinery; P all 4 reading routes return FULL text under ?maxTextChars=10; M must-FAIL: deliverText(fold,4000) rendered by the r7 client shows raw table <pre> and no <table>).
  - node scripts/verify-bug-234-reading-view-full-text.mjs -> 17/17 against the REAL 6535-char session 1f4cad56 (A full table render = P4; B route ignores ?maxTextChars even =10, full+table; C must-FAIL original 4000-slice -> raw <pre>, no table).
  - node scripts/verify-feat-091-response-blocks.mjs -> 330/330. node scripts/verify-feat-081-tables-links.mjs -> 23/23.
  - npm run gate -> PASS (leak-gate + check-nul + typecheck, exit 0).

  HIGH-STAKES NOTE: regression-prone area (reading-view render path, 6 prior rounds). Self-verified suites are not the last word — an independent clean-room HOLDS verify pass is warranted before VERIFIED.

### 2026-10-07 — dispatch openai
- **Verification recorded:** dispatch openai/codex-default run 01a11567-3312-7642-9571-fd5f064c19d7 — VERDICT: BROKEN — Clean-room r7 (isolated copy, x-provider openai). Fixer 22/22. V1/V2/V4 HOLD; V3 normal-content DOM identical. SOLE break COSMETIC: r7 drops 'truncated' label from oversized(>16KiB) tool_use INPUT chips (confirmed vs true HEAD); no text lost. Symptom fixed. See Activity log + bug234r7-verify.log.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — agent-verifying-r7 — CLEAN-ROOM INDEPENDENT VERIFY
- **Harness:** scripts/independent-verify.mjs, cross-provider openai/codex-default (author anthropic), run `01a11567-3312-7642-9571-fd5f064c19d7`. Isolated BUG-234-only copy `scratch/bug234r7-copy` (byte-exact to the real r7 working-tree change — the unrelated leak-gate/git-grant/agent-bridge edits in the live tree were excluded), snapshotted `--working-tree` (HEAD e79aada → tree ad09075c1242). Real-session fixture `verify-fixtures/claude-projects/b234-proj/1f4cad56…jsonl` + TEMPLATE allow-input, reused from r6. Log `scratch/bug234r7-verify.log`, verdict `scratch/bug234r7-verdict.txt`, clean room kept at `scratch/cleanroom-verify-1xCLZO`.
- **Verdict: BROKEN mechanically on ONE adversarial fail whose SOLE finding is COSMETIC.** The substantive BUG-234 symptom is fully fixed.
  - **FIXER-TEST** `scripts/verify-bug-234-single-authority.mjs` re-run (manifest 3fadf01a8a16) → 22/22.
  - **V1 HOLDS** (run 798b65fc2ddf, 23/23): verifier enumerated EVERY reading route — HTTP transcript forward/tail/before-index/beforeBytes, HTTP subagent page/tail/before-index, AND the real WebSocket `/ws` follow (NOT SSE). Every route returns FULL assistant/user/thinking text and IGNORES `?maxTextChars=10`, including one-message forward/backward pagination and byte-cursor paths, and the live WS follow with an injected cap.
  - **V2 HOLDS** (run c8c04b1d8e1e, 2/2): the genuine 6535-char reply in session 1f4cad56 renders a real `<table>` (header Project|Session|Last activity (UTC)|What's pending), 0 `<pre>`, no raw table source — through both the tail and forward routes in a headless browser.
  - **V4 HOLDS** (run 9f8f253a3b36, 2/2): neither remaining cap (transcript.ts emptiness `maxTextChars:1`; jsonl.ts 16 KiB tool_use JSON chip cap) can leak into displayed assistant/user/thinking text; long neighbouring text keeps its ending sentinel.
  - **V3 normal content HOLDS** (run 998d1a451640): real normal messages DOM IDENTICAL to the base renderer (6 msgs, main + subagent); whole-sequence grouping/digest/folds/thinking/tools equal. The ONE failing assertion is `onlyRemovedLabel:true`.
- **SOLE BREAK — classified COSMETIC (confirmed against TRUE HEAD, resolving the verifier's reconstructed-base limitation):** r7 `renderBlockEntry` changed `historyChip(…, b.truncated ? 'truncated' : '', …)` → `historyChip(…, '', …)`, so an oversized (>16 KiB JSON input) tool_use INPUT chip no longer shows a `truncated` status label in its summary. The hidden-tail behaviour (`b.truncated ? null : input`) is UNCHANGED, so no tool input or message text is lost that HEAD showed — only the status word on the rare oversized-input chip disappears. Not lost content, not raw source, not a broken render → cosmetic. (The verifier reconstructed the base client because the clean-room `.git` is empty; I confirmed the hunk against real HEAD here, so this is a true r7 delta, not a reconstruction artefact.)
- **UNTESTED (verifier's honest list):** (1) full base-revision client comparison unavailable in the clean room (`.git` empty) — V3 used a reconstructed old renderer; resolved for the sole finding against real HEAD here. (2) Provider-driven LIVE bridge render not exercised; live coverage was file-follow delivery only.
- **Out of scope / HOLDS elsewhere:** BUG-238 (pre-existing same-index cumulative applyAppend DROP) reproduces on pristine HEAD with untruncated blocks — not caused by r7, filed separately, not attributed here. Break #2 from r6 (consecutive-message note misplacement) is eliminated by construction (no note exists to misplace).
- **Decision for orchestrator:** every SUBSTANTIVE requirement holds; the lone deviation is a cosmetic `truncated` label removed from oversized tool_use input chips. Either (a) accept and mark BUG-234 VERIFIED/done with the cosmetic label as a trivial follow-up, or (b) have the fixer restore the one-line label before closing. No further clean-room round is warranted for the substance.

### 2026-10-07 — dispatch openai
- **Verification recorded:** dispatch openai/codex-default run 01a11573-f0d8-7613-8f2d-3aa59abbfe27 — VERDICT: HOLDS — Clean-room r8 (independent-verify --working-tree, isolated copy, x-provider openai). Fixer 25/25 incl. new tool_use 'truncated' label T1-T3. V1/V2/V4 HOLD; V5 label IFF capped, 6 tools (33/33). Could-not-test: V3/V5 vs real HEAD blocked by empty .git (as r7); closed fixer-side. bug234r8-verify.log. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — agent-fixing-r8
- **r8 fix (one line) — restores the r7-cosmetic-break label:** in `public/app.js` `renderBlockEntry`, the tool_use chip call was restored from `historyChip(…, '', …)` (r7) to HEAD's `historyChip(…, b.truncated ? 'truncated' : '', …)`, so an oversized (>16 KiB JSON input, `jsonl.ts:90` cap) tool_use INPUT chip again shows its `truncated` status label. `regressed-from: r7` (the lost label the r7 clean-room flagged COSMETIC). `historyChip` itself is byte-identical to HEAD; nothing else changed.
- **Demonstrated:** added checks T1–T3 to `scripts/verify-bug-234-single-authority.mjs` — through the REAL renderer in headless brave, a `truncated:true` tool_use chip shows the `truncated` label and a non-truncated one shows none. Must-FAIL proof: reverting to the r7 `''` state fails T2 (24/25); with the fix 25/25. Anti-regression suites all green: `verify-feat-091-response-blocks` 330/0, `verify-feat-081-tables-links` 23/23, `npm run gate` PASS (leak-gate + typecheck, exit 0).
- **Independent clean-room verify (r8):** `scripts/independent-verify.mjs --working-tree` over BUG-234-only isolated copy `scratch/bug234r8-copy` (r7 copy + the one-line fix + the updated single-authority test; app.js diff byte-identical to the live change), cross-provider openai/codex-default, author anthropic, run `01a11573-f0d8-7613-8f2d-3aa59abbfe27`. Requirement = full r7 V1–V4 PLUS V5 (tool_use label IFF capped, exactly as HEAD). **VERDICT: HOLDS** (VALID, manifest-backed). Fixer 25/25; V1 full text on every reading route incl. live WS follow (90k appended); V2 genuine 6535-char reply renders `<table>` no `<pre>`; V4 caps don't leak; V5 label IFF capped across 6 tool types through the real renderer (33/33). Log `scratch/bug234r8-verify.log`, verdict `scratch/bug234r8-verdict.txt`, clean room `scratch/cleanroom-verify-P6OfvL`.
- **Could-not-test (verifier's honest list) + fixer-side resolution:** the clean room's `.git` is empty, so the verifier could not run the V3/V5 differential against *real* HEAD (same structural limit as r7). Closed fixer-side in the live repo (which has HEAD): the restored `historyChip` call and `historyChip` itself are **byte-identical to `git show HEAD:public/app.js`** (only the r7 `return` prefix differs, which does not affect rendering). Since r8's sole delta over r7 is this label arg (which evaluates to `''` — r7's exact value — for non-truncated content), and r7's V3 already matched HEAD for normal content, V3/V5 hold against HEAD.

### 2026-10-11 — landed in batch commit (orchestrator triage)
- Work landed in the 2026-10-11 whole-tree batch commit. Verified state unchanged; this entry records only the git landing. Full batch manifest is in the commit message.
