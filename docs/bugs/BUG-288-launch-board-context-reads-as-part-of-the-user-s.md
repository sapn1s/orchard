```orchard-ticket
{
  "id": "BUG-288",
  "type": "bug",
  "title": "launch board-context reads as part of the user's first message",
  "summary": "On a session's first message, Orchard glues the live board snapshot directly above the user's typed message with only a bare `---`. The snapshot's answered-cards section tells the agent to \"start that option's scoped work\", and with no marker of where the injection ends, the agent read an answered FEAT-023 card as part of the user's request (user, 2026-10-29).",
  "impact_if_we_wait": "Every session's first turn can have its real request diluted or derailed by injected board context the user never typed; answered cards get acted on or re-answered without the user asking.",
  "current_need": "Mark the injected block as auto-injected background with a clear boundary before the user's message, and reframe the answered-cards (and any other injected) instructions so the user's typed message decides the work — answered cards are context only.",
  "severity": "high",
  "area": "server / bridge / board",
  "reported": "2026-10-29",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-29",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The composed first-turn prompt carries a clear, human-and-agent-readable boundary between the auto-injected background and the user's own message.",
    "The answered-cards instruction states it is context-only, keeps ticket ids and verbatim notes, and no longer tells the agent to start the card's work.",
    "Consumers and verify:* suites still pass, asserting the new properties (boundary present, context-only wording) not the old 'go' text."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "default",
      "run_id": "50ebcd15-7cb7-40e8-b1e7-0e5c9c7696f0",
      "verdict": "holds",
      "verdict_on": "2026-10-29",
      "recorded_at": "2026-10-29T12:55:04.012Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "6fd06ec5bdb2347fdf992b6b06f7addd0fcc248ed7c420a57b7bdfde0b2a9ab1",
      "verify_mode": "mixed-state"
    }
  ],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
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

# BUG-288 — launch board-context reads as part of the user's first message

## Symptom
On the first message of a session, Orchard prepends a board-context block to the user's typed message. The block includes a "✋ Answered — awaiting action" section whose text tells the agent "a picked option with no note is the user's go — start that option's scoped work and report it as started". The block is glued directly above the user's own question, separated only by a bare `---` rule, with no marker of where the injected context ends and the user's words begin. Result (user, 2026-10-29): the agent treated an answered FEAT-023 card as part of the user's request and answered it alongside the user's actual question.

## The user's ruling
The injected block is CONTEXT ONLY. What the user actually typed determines the work. The injection must not compete with the user's words or read as the user's words.

## Repro
Launch a session on a board that has an answered-awaiting ticket (e.g. FEAT-023, answered with a note that is itself a question). The first user turn's prompt becomes `<board snapshot, incl. the answered card + "start that option's scoped work">\n\n---\n\n<user's message>`. The agent reads the whole thing as one request.

## Expected
1. The injected part is clearly marked as auto-injected background, NOT written by the user, and there is a clear marker where the user's own message starts.
2. Answered cards (and any other injected section) are background: the agent may mention one briefly where relevant, but does not start that card's work and does not answer it as if the user had asked — unless the user's own message this turn asks for it. The facts stay (ticket ids, picks, verbatim notes).

## Context pack
- Files/functions in play: `src/server/board.ts` — `ANSWERED_GO_RULE` (the "start the work" text), `boardStateSnapshot` (launch snapshot, answered section), `answerBriefingFor` (live `[station]` briefing). `src/server/agent-bridge.ts` — `#composeBriefing` (the bare `---` join of snapshot + user prompt; the `BRIEFING_TERMINATOR` boundary for `[station]` turns).
- Consumers / tests: `scripts/verify-feat-090-answered-lane.mjs`, `scripts/verify-feat-090-answer-handoff.mjs`, `scripts/verify-bug-257-answer-note-travels.mjs` (pin the old "go"/"report it as started" wording). `public/app.js` `harnessNotice`/`legacyBriefingSplit` read the injection boundary.
- Related tickets: BUG-257, FEAT-090 (established the "pick is the go / start the work" framing this ticket overturns to context-only), BUG-168 (the `[station]` boundary terminator).
- Known dependencies: live server must be restarted to pick up the change (do NOT restart it here).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-29 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-29 — worker (BUG-288 fixing r1)
- **Understood / confirmed hypothesis:** The injection is built in `src/server/board.ts` (not templates.ts) and concatenated into the FIRST USER TURN (not the system prompt) by `AgentSession.#composeBriefing` in `src/server/agent-bridge.ts`. On the common first-launch case (answered tickets ≤ snapshot cap, no deaths) `briefings` is empty, so the board snapshot rode the user's prompt joined by a bare `\n\n---\n\n` with NO marker of where injected context ended — exactly the reported conflation. The "start that option's scoped work / is the user's go" imperative lived in `ANSWERED_GO_RULE` (board.ts), reused by both the launch snapshot and the live `[station]` answer briefing. Focus/Needs-you/In-flight sections are descriptive labels with no "start the work" framing; `takeBriefing` (outcomes.ts) already says "a server-recorded fact, not a request — ADVISORY". So the answered-cards rule was the sole offender.
- **regressed-from:** BUG-257 / FEAT-090 — those established the "a picked option is the user's go — start that option's scoped work" framing. The user's 2026-10-29 ruling overturns it: the injection is CONTEXT ONLY; the user's typed message decides the work. The verbatim-note *facts* BUG-257 added are kept.
- **Changed:**
  - `src/server/board.ts` — renamed `ANSWERED_GO_RULE` → `ANSWERED_CONTEXT_RULE` and rewrote it: it now opens "this is BACKGROUND CONTEXT, not a request … what the user types … decides what you work on", says "Do NOT start a card's work, and do NOT answer it as if the user had just asked, unless the user's own message this turn tells you to", keeps "a note governs the pick" and "notes quoted verbatim". Updated both call sites (launch snapshot line + live `[station]` briefing line) and the "Answered — awaiting action" header to read "— background context, not a request".
  - `src/server/agent-bridge.ts` — added exported `USER_MESSAGE_BOUNDARY` and used it in `#composeBriefing`: the snapshot-only first turn now joins snapshot + boundary + user message (not a bare `---`); the `[station]` path places the boundary just before `BRIEFING_TERMINATOR` so the client still peels it into the notice chip while the agent reading the raw prompt sees it. Empty-prompt turns carry no boundary.
  - Tests (assert new PROPERTIES, not pinned text): `scripts/verify-feat-090-answered-lane.mjs` (context-only framing + absence of old "go"/"scoped work"; placement check given a larger cap so both sections are present), `scripts/verify-feat-090-answer-handoff.mjs` (briefing framing), `scripts/verify-bug-257-answer-note-travels.mjs` ([3] control + docstring).
- **Verified (fixer's own run):**
  - `node scripts/verify-feat-090-answered-lane.mjs` → **26/26 PASS** (scratch fixtures; robust to board drift).
  - `node scripts/verify-feat-090-answer-handoff.mjs --no-ui` → PART A **18/18 PASS** incl. the rewritten context-only briefing assertion (own-seeded board). One PART B check fails — `PRECONDITION: a live session … first turn completed` — the fake-codex turn never completes; this exercises the session lifecycle (`agent-bridge`/`runtime`/`outbox`) that the in-flight BUG-278 lane is actively editing in this shared tree, and is independent of BUG-288 (pure prompt-string composition). PART A fully covers the briefing content.
  - must-FAIL proof (synthesized OLD builder, not HEAD; `scratch/bug288-demo.mjs`): the NEW assertions (`snapshotIsContextOnly`, `composedHasBoundary`) return **false** against the old `ANSWERED_GO_RULE` text and the old `\n\n---\n\n` join — PROOF HOLDS.
  - real-board render (scratch COPY of real `docs/bugs`, FEAT-023 answered with a question-note — the reported scenario): `boardStateSnapshot` + the `#composeBriefing` snapshot-only path produce, verbatim:
    - `✋ **Answered — awaiting action (1) — background context, not a request:**` followed by `How to read these: this is BACKGROUND CONTEXT, not a request. …`, then `- FEAT-023 — … (answered 2026-10-29)` / `picked: A — Keep it parked`.
    - `--- END OF AUTO-INJECTED BACKGROUND CONTEXT (everything above this line was added by the server, not written by the user) ---` / `The user's own message for this turn follows below. …` / (blank) / `how do I change the polling interval?`
  - `npm run gate` → **PASS (exit 0)** — leak-gate + typecheck clean.
- **Still open / not verified by me:**
  - `verify-bug-257-answer-note-travels.mjs` is PRE-EXISTING red (FATAL at fixture setup): it pins real ticket ids (ARCH-013/019/021/023, BUG-048/115/236, FEAT-049) that have lost their decision blocks, and [7] needs FEAT-023 answered-awaiting (it is now in needsYou). Only 5 live decisions exist (3 non-reserved) vs the 8 it needs. This is the docs/CONVENTIONS.md anti-pattern and is unrelated to BUG-288; it needs its own re-fixture (seed synthetic 👤 decision carriers). My text-property assertion updates to it are forward-looking (correct once it is re-fixtured).
  - Client chat RENDERING of the snapshot-only first turn is unchanged by design (no `[station]` sentinel, so it renders raw). The fix is on the prompt the agent reads; the boundary line is human-readable too. Collapsing it into a notice chip would touch `public/app.js` (heavily locked by other lanes) and is BUG-168-class risk — left out of scope.
  - The LIVE server must be restarted to pick up this change. Per charter: NOT restarted here.
- **Handoff:** independent clean-room verify warranted (session-lifecycle-adjacent, regression-prone file with history): `node scripts/independent-verify.mjs --ticket BUG-288 --run "node scripts/verify-feat-090-answered-lane.mjs"`.
- **Symptom of a deeper design flaw?** no — a framing/boundary fix; the "injection is context, not a request" rule is now stated once at its owner (`ANSWERED_CONTEXT_RULE` + `USER_MESSAGE_BOUNDARY`).

### 2026-10-29 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/default run 50ebcd15-7cb7-40e8-b1e7-0e5c9c7696f0 — VERDICT: HOLDS — mixed-state candidate 6fd06ec5bdb2. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-29 — verify lane (BUG-288 clean-room r1)
- **Ran:** `node scripts/independent-verify.mjs --ticket BUG-288 --files src/server/board.ts,src/server/agent-bridge.ts,scripts/verify-feat-090-answered-lane.mjs,scripts/verify-feat-090-answer-handoff.mjs,scripts/verify-bug-257-answer-note-travels.mjs --requirement @… --run "node scripts/verify-feat-090-answered-lane.mjs"`. BUG-288 had no frozen candidate, so the tool took a MIXED-STATE freeze of the 5 named files (candidate 6fd06ec5bdb2, range 5b714188387d..fc3fb1b824da); 5 other-ticket hunks (BUG-278 in agent-bridge.ts) disclosed to the verifier.
- **Verdict:** HOLDS — VERDICT-CONTRACT VALID, manifest-backed. All three success criteria confirmed against the real method source: USER_MESSAGE_BOUNDARY present between snapshot and typed prompt (no bare `---`), absent on empty/whitespace prompts, peeled into the client notice chip on `[station]` turns; ANSWERED_CONTEXT_RULE is context-only (no "go"/"scoped work"/"report it as started") and keeps ticket ids, picks, verbatim notes, note-governs rule. Fixer suite 26/26 PASS; verifier's own adversarial compose+client-peel 18/18 PASS.
- **Provider caveat:** OpenAI dispatch aborted mid-run [quota-window]; the tool fell back to Anthropic in the same clean room, recorder and prompt (cause-2 fallback). Author provider is also Anthropic, so cross-provider decorrelation was reduced this round — flagged for the orchestrator.
- **Verifier UNTESTED (not breaks):** the `--run` command ENOENTs in the bare clean room (reads the real docs/bugs, absent there) — its real-board parser leg covered only the synthetic ARCH-900 fixture; `verify-bug-257-answer-note-travels.mjs` not executed (pre-existing stale-fixture FATAL per the fixer log) so requirement-3's consumer-assert leg is unrun there; no live AgentSession.start/send, so the FEAT-191 branch-flow hunks in start() were not exercised; no real model run to confirm a model treats the boundary as the injection end. Pre-existing (not this change): on a default-cap snapshot with answered cards, the cap raises only enough for the answered section, dropping the Needs-you list and ellipsizing the last note — the lane test's maxChars 5000 hides this.
