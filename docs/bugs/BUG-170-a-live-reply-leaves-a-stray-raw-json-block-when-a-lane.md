# BUG-170 — a live reply leaves a stray raw-JSON block when a lane finishes mid-stream

- **Status:** VERIFIED  (independent clean-room pass CONFIRMED the fix; all four named attack families held, incl. the highest-priority silent-loss attack — no streamed text lost)
- **Verified-by:** anthropic clean-room dispatch (run af0a69931483a1beb, Opus 4.8) — CONFIRMED. Cross-provider degraded: `--provider openai` (Codex) cannot bind 127.0.0.1 in its sandbox so it cannot drive a browser (established a prior round); fresh-context Anthropic clean room used instead. Verifier id (af0a69931483a1beb) differs from the fixer.
- **Severity:** medium
- **Area:** composer / transcript renderer (client — public/app.js live stream)
- **Reported:** 2026-09-06 by independent verifier (split off BUG-169, Case A)
- **Verification-class:** fix  ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
While the orchestrator is replying live, a single assistant message shows its
correct `orchard-digest` rail BUT with a stray, orphaned raw-JSON `<pre>` block
sitting above/beside it — a leftover partial of the same block. Different from
BUG-169: there the SAME text rendered twice (raw JSON, then rail, sentinel twice);
here the message renders correctly ONCE as the rail, plus a stray PARTIAL fence
(sentinel once). Live only — a reload/re-read renders it correctly.

## Repro
1. A live turn streams an assistant message whose first block is an `orchard-digest`
   fence.
2. A background lane finishes **between two deltas of that block** — the bridge
   emits `agent-completed` asynchronously (`src/server/agent-bridge.ts`), which
   calls `finishStream(mainThread())` while only the FIRST half of the fence has
   streamed. `finishStream` settles that partial buffer into a node (a raw-JSON
   `<pre>`, because the fence's JSON is still unclosed).
3. The REMAINING deltas arrive → `case 'text-delta'` finds `th.stream` null, starts
   a FRESH stream (a new block), and — per BUG-169's guard — nulls `th.settledStream`,
   leaving the partial node ORPHANED in the DOM.
4. The block's own settled `text` event renders the full block as the rail (correct).
→ Result: one correct rail PLUS the stray partial raw-JSON `<pre>`.

## Expected
Exactly one render of the message as the digest rail — no stray leftover partial
node. No streamed text is lost.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play: `public/app.js` — `case 'text-delta'` (~8703, the
  new-stream boundary), `finishStream()` (~3473, sets `th.settledStream`), `case 'text'`
  (~8726). Root cause: the new-stream boundary treated a MID-BLOCK settle as a
  committed prior block and discarded the re-render handle, orphaning the partial node.
- Root cause detail: `th.settledStream` is set ONLY by `finishStream`, and every REAL
  block boundary (the block's own `text`, tool-call, question, plan, turn-end, gap-fetch)
  CLEARS it. So if it is still live when a fresh `text-delta` arrives, `finishStream`
  fired mid-block and this delta CONTINUES the same block — it is not a new block.
- Fix: at the `text-delta` new-stream boundary, when `th.settledStream` is still live,
  RESUME the interrupted block in place — reuse the settled node as the new stream wrap
  and seed the buffer with the already-settled text — instead of starting a fresh block.
  This preserves streamed text (nothing discarded) and removes the orphan; the block's
  trailing `text` then settles the resumed stream to the single rail.
- Predates BUG-169: the verifier ran Case A on both the BUG-169-fixed tree and a
  byte-identical pre-fix `HEAD:public/app.js` — IDENTICAL stray on both, so BUG-169
  neither caused nor worsened it.
- Related tickets: BUG-169 (the reported double-render; this is its out-of-scope
  residual), FEAT-083 (digest renderer / `assistantProse`), FEAT-016 (honest streaming).
- Repro test: `REPRO_CASE=mid node scripts/scratch-bug169-live-repro.mjs` drives the
  real live onEvent path (partial deltas → agent-completed → remaining deltas → text).
  `REPRO_EXPECT=mid-stray` is the must-FAIL baseline; `REPRO_EXPECT=fixed` the pass bar.
- Known dependencies / blockers: none.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-06 — fixer (Opus 4.8)
- **Understood:** the verifier's Case A (see BUG-169 verifier entry). Verified by
  reading `case 'text-delta'` that the pre-fix path nulled `th.settledStream` and
  started a fresh stream on the continuation delta, orphaning the mid-block partial node
  that `finishStream` had settled. Confirmed `th.settledStream` can only survive to a new
  `text-delta` via a mid-block `finishStream` (agent-completed), because every other
  settle path clears it — so a continuation delta is unambiguous and the resume is safe.
- **Changed:** `public/app.js` only — `case 'text-delta'`, the `!th.stream` branch: when
  `th.settledStream` is live, resume that block in place (reuse the settled node as the
  new wrap, seed `th.stream.text` with the settled text) rather than starting a fresh
  block. Nothing is discarded, so the "silently dropping content is worse" hazard does
  not apply. Extended `scripts/scratch-bug169-live-repro.mjs` with `REPRO_CASE=mid`
  (Case A interleaving) + a `mid-stray` must-FAIL expectation; added
  `scripts/scratch-bug170-screenshot.mjs` (headless Playwright/Brave screenshotter).
- **Verified:** must-FAIL proven TEMPORALLY on the working tree (same file, before vs
  after the edit — the real live onEvent path, real server + real headless browser):
  - BEFORE the fix (BUG-169-fixed but Case-A-unfixed): `REPRO_CASE=mid
    REPRO_EXPECT=mid-stray` → `{digestCount:1, rawKindJsonPresent:true, codeBlockCount:1,
    sentinelCount:1}` — the stray partial `<pre>` reproduces, 4/4 must-FAIL checks PASS.
  - AFTER the fix: `REPRO_CASE=mid REPRO_EXPECT=fixed` →
    `{digestCount:1, rawFencePresent:false, rawKindJsonPresent:false, codeBlockCount:0,
    sentinelCount:1}` — one clean rail, no stray, prose once → 5/5 PASS.
  - Anti-regression: BUG-169 `post` fixture still 4/4 (`REPRO_CASE=post
    REPRO_EXPECT=fixed`); `npm run gate` PASS; `verify:feat-083` 22/22;
    `verify:streaming-md` 9/9 on rerun (the pre-existing mid-stream 70ms-throttle timing
    flake, not this change — I touch no throttle/renderStreamNow code).
  - Screenshots (single rail, no raw JSON) light + dark:
    `docs/bugs/assets/BUG-170-mid-delta-single-rail-light.png`,
    `docs/bugs/assets/BUG-170-mid-delta-single-rail-dark.png`.
- **Verified-by:** PENDING — an independent clean-room verify pass is warranted (a
  session-lifecycle / render-correctness change in the regression-prone `public/app.js`).
  The fixer wrote the fixture; a second fresh-context verifier should attack cases the
  fixture does not cover — e.g. a mid-block interrupt where the trailing `text` NEVER
  arrives (does the resumed stream still show the full text?), and interleavings where a
  mid-block settle is followed by a genuinely-different next block (must the resume ever
  merge two unrelated blocks?).
- **Symptom of a deeper design flaw?** yes-ish, same as BUG-169's note — "settle" is
  spread across seven onEvent callers and the re-render handle must be threaded through
  each. Not filed as ARCH yet; this fix narrows the handle's semantics (a live handle now
  means "mid-block, resume") rather than widening the sprawl. Flagged so a recurrence can
  escalate it.

### 2026-09-06 — independent verifier (Opus 4.8, clean-room dispatch af0a69931483a1beb)
- **Verdict: CONFIRMED.** Ran in a fresh-context clean room: an exported working copy at
  /tmp/b170-verify carrying the unstaged fix, with the ambient instruction surface removed
  (CLAUDE.md / AGENTS.md / .claude / docs/prompts stubbed / docs/bugs). The verifier got only
  the requirement in plain terms + the diff hunks + how-to-run + the fixer's test code — NOT
  this ticket or the fixer's report. Provider degradation noted in Verified-by (Codex can't
  bind 127.0.0.1 → Anthropic clean room). Real server + real headless Brave + real
  window.__station.onEvent path throughout.
- **(i) Fixer fixture re-run once:** `REPRO_CASE=mid REPRO_EXPECT=fixed node
  scripts/scratch-bug169-live-repro.mjs` → 5/5
  (`digestCount:1, rawFencePresent:false, rawKindJsonPresent:false, codeBlockCount:0,
  sentinelCount:1`). The `mid-stray` must-FAIL baseline on the fixed tree correctly FAILS its
  stray-lingers assertions (`codeBlockCount:0`) → passes are non-vacuous.
- **(ii) Adversarial attacks** (distinct script
  `/tmp/b170-verify/scripts/scratch-bug170-attack.mjs`, `ATTACK=<case>`, each with a must-FAIL
  control; the harness waits out the 70ms stream throttle before reading the DOM):
  - **Attack 1 — silent loss (highest priority): NO text lost.** `loss1` (interrupt mid-block,
    remaining deltas incl. an end-of-stream sentinel, trailing `text` NEVER sent) → end sentinel
    present exactly once (`sentTail:1`); `loss2` (only first half streams, then interrupt, then
    nothing) → head text retained (`sentHead:1`), tail genuinely 0 because never sent. Must-FAIL
    control: a never-streamed bogus sentinel + the pre-flush tail both report 0, so the detector
    demonstrably catches a missing sentinel.
  - **Attack 2 — wrong merge: HOLDS.** `merge-boundary` (hard tool-call boundary between interrupt
    and a new block) and `merge-nonprefix` (unrelated settle that does not startWith the settled
    buffer) both yield SEPARATE DOM nodes (`anyChildHasBoth:false`), neither block's text lost.
    Must-FAIL control `merge-control` (a real continuation via deltas) merges into one node
    (`anyChildHasBoth:true`) → the separateness metric distinguishes merge from non-merge.
  - **Attack 3 — two interrupts in one block:** one clean rail, `preCount:0`, sentinel once, no
    leak, no lost text.
  - **Attack 4 — interrupt on/before the first delta:** both variants one clean rail, `preCount:0`,
    no stray, no lost text.
- **(iii) Could-not-test:** (a) a turn that NEVER settles at all (no trailing `text` AND no
  subsequent finishStream/turn-end) leaves the digest as RAW JSON in a `<pre>` — pre-existing
  live `renderStreamNow` behavior (uses non-digest prose() until a settle), NOT the BUG-170
  stray-node defect, and loses NO text; no realistic path to a completed-but-unsettled turn was
  constructible, judged benign. (b) gap-fetch (loadNewer) / applyAppend as the interrupting
  boundary were not driven from the live UI (need real history-fetch plumbing); they null
  th.settledStream on the same code path as the tool-call/turn-end boundaries that WERE exercised.
- **Assessment:** regression-prone streaming/render-lifecycle change; this independent pass
  corroborates the fixer's self-verification rather than relying on it.
