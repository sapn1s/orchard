```orchard-ticket
{
  "id": "FEAT-179",
  "type": "feature",
  "title": "Flag never-releasing projects, give Codex the same instructions, count late approvals",
  "summary": "Three approved default changes. A soft-release project whose board has no typed verdicts can never release; Orchard now raises one Needs-You card and a Settings warning offering a choice, never changing the mode itself. Codex sessions now get the same composed instructions as Claude sessions. Answers given after a lane card's 30-minute refusal are recorded and counted.",
  "impact_if_we_wait": "Release-mode projects with no typed verdicts would never release and nobody would be told. Codex lanes would keep running without the Working Agreement or the project's git policy. The 30-minute lane refusal would stay a guess.",
  "current_need": "Re-verify 4f107ae8 break (card stayed open after a typed verdict) fixed structurally. Suite 26/0, gate PASS. No standing HOLDS, so not VERIFIED (rule 5). Needs a service restart.",
  "severity": "medium",
  "area": "soft releases, Codex, lane deadline",
  "reported": "2026-10-13",
  "reported_by": "defaults lane",
  "owner": "agent",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-10-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A release-mode project with no typed verdicts gets one Needs-You card and a Settings warning with three choices; its mode never changes automatically.",
    "A Codex session's developer instructions hold the same composed text a Claude session's system prompt gets, on start, resume and fork.",
    "A late answer to a refused lane card is recorded once and counted by GET /api/lane-incidents/late-answers, never shown as a Needs-You card."
  ],
  "code_refs": [
    {
      "path": "scripts/lib/release.mjs"
    },
    {
      "path": "src/server/index.ts"
    },
    {
      "path": "public/lib/drawer.js"
    },
    {
      "path": "src/server/runtime/codex-runtime.ts"
    },
    {
      "path": "src/server/agent-bridge.ts"
    },
    {
      "path": "src/server/lane-incidents.ts"
    }
  ],
  "related": [
    {
      "id": "FEAT-164",
      "relation": "see_also"
    },
    {
      "id": "BUG-239",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "b0587b41-fecb-4706-8e79-2ae9aed890d5",
      "verdict": "broken",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T19:06:44.143Z",
      "author": "defaults lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "5a96b96722cdd5ba7ee26790531b9f0d21cb4ced52f15019bf8f43865edfdb17",
      "verify_mode": "mixed-state",
      "note": "VALID. OpenAI quota-window, so Claude Opus. 2 breaks, item 1 only: ledger entries counted without the reader; no-base-commit repo threw before the never-check. Both fixed in the one allowed round; fixed state not re-verified."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "4f107ae8-5485-4223-b8e1-75c3f8f82e9c",
      "verdict": "broken",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T19:21:13.167Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "59a1e7bf9cb12ce5796813cb6ced81a65dd782a96599c4b9a05ddcc91680edf1",
      "verify_mode": "mixed-state",
      "note": "VALID. OpenAI quota-window, so Claude Opus. 1 break, item 1: the never-releases card is never withdrawn once a typed verdict appears (warning clears, card stays). No-commit repo, no-board, non-git dir, restart dedupe, attributed ledger, codex resume/fork held."
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

# FEAT-179 — Flag never-releasing projects, give Codex the same instructions, count late approvals

## What changed

1. **Release mode with no typed verdicts.** `scripts/lib/release.mjs` `boardVerdictSource` decides whether a board can ever make a ticket eligible (no board, or no typed `verification[]`/ledger entry, means it cannot). `planRelease` reports it as `verdictSource`; `releaseAlarm` returns a `releases can never happen:` alarm first in release mode. The station's release tick (`src/server/index.ts`) raises one Needs-You card. It is not raised again while one is open, nor for 7 days after the user answers it. `ORCHARD_RELEASE_TICK_MS` shortens the tick for tests. Settings → Agent git (`public/lib/drawer.js`) shows a warning with three choices: write a scope note, turn agent commits off, or keep soft releases. The mode is never changed automatically.
2. **Codex instructions.** `codex-runtime.ts` forwards the composed `config.systemPrompt` (built once by AgentSession for every engine) as app-server `developerInstructions` on thread/start, thread/resume and thread/fork. These add to Codex's base instructions and do not replace them. Lock and permission behaviour are unchanged.
3. **Late approvals.** `agent-bridge.ts` remembers each card the BUG-239 deadline refused. A later approve, deny or answer is recorded once as a `late-answer` lane incident (`lane-incidents.ts`). The ack tells the client why (`refusedForNoAnswer`). `GET /api/lane-incidents/late-answers?days=N[&project=id]` returns the count. Late answers are data-only and never appear on the Needs-You rail.

## Proofs

- `npm run verify:release-no-verdicts`: lib checks on copies of real tickets, a scratch station, real headless Chromium, and two must-FAIL arms (a constructed pre-fix lib and a mutant station).
- `npm run verify:codex-instructions`: wire checks, a must-FAIL mutant, and an e2e through the real `codex app-server` that reads Codex's own rollout file back. A mutant e2e must-FAIL arm is included.
- `npm run verify:late-answers`: unit checks, plus a live real Claude CLI run with a short deadline and a mutant must-FAIL arm.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-13 — defaults lane
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-13 — defaults lane
- **Verification recorded:** dispatch anthropic/claude-opus-5 run b0587b41-fecb-4706-8e79-2ae9aed890d5 — VERDICT: BROKEN — mixed-state candidate 5a96b96722cd — VALID. OpenAI quota-window, so Claude Opus. 2 breaks, item 1 only: ledger entries counted without the reader; no-base-commit repo threw before the never-check. Both fixed in the one allowed round; fixed state not re-verified.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — defaults lane
- **fixing, round 1:** Verify b0587b41 (Claude Opus; the OpenAI test dispatch failed quota-window) returned BROKEN, contract VALID, with two item-1 breaks. Both are fixed: (1) boardVerdictSource no longer counts the ledger directly; an entry counts only when ticketVerifications reads it for a ticket on the board (suite A7). (2) releaseAlarm checks the verdict source before any git read, release.mjs auto exits early with the never-alarm, and a plan that cannot be built still returns verdictSource, so a repo with no base commit gets the card and the Settings warning (A8, B7). The verifier's untested edges are also closed: the card dedupe is keyed on project id plus a name-free prefix, so a rename does not re-raise it (B2), and the ack flag now requires the same card kind the record does. Suites: release-no-verdicts 24/0, codex-instructions 14/0 (real codex e2e, wire 7/0 rerun), late-answers 18/0 (live real CLI and mutant), gate PASS. Regressions: codex-runtime 54/0, feat-164-settings-ui 18/0, bug-239 fast 31/31. The fixed state is NOT independently re-verified (one round allowed). Needs a service restart to take effect (not done).

### 2026-10-13 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 4f107ae8-5485-4223-b8e1-75c3f8f82e9c — VERDICT: BROKEN — mixed-state candidate 59a1e7bf9cb1 — VALID. OpenAI quota-window, so Claude Opus. 1 break, item 1: the never-releases card is never withdrawn once a typed verdict appears (warning clears, card stays). No-commit repo, no-board, non-git dir, restart dedupe, attributed ledger, codex resume/fork held.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — defaults lane
- **fixing, after re-verify 4f107ae8:** Re-verify 4f107ae8-5485-4223-b8e1-75c3f8f82e9c (BROKEN, already recorded): after a typed verdict appeared, the Settings warning cleared but the Needs-You card stayed open. Structural fix in src/server/index.ts: reconcileNeverReleasesCard closes any open never-releases card whenever the SAME predicate the warning shows is false. That predicate is release mode AND scripts/lib/release.mjs boardVerdictSource(...).ok === false (the warning reads the same function through release.mjs plan). It runs on every release tick, for every project in any mode, and on every board read, so the card and the warning cannot disagree. An auto-cleared card does not count as a user answer, so the 7-day quiet rule does not suppress a recurrence. Added scripts/lib/release.d.mts for the server import. Proofs: verify-release-no-verdicts 26/0. In B8, a typed verdict appears and both the warning and the card clear, and the card is not re-raised. In B9 (must-FAIL, a constructed mutant without the reconcile), the warning clears but the card stays open. Gate PASS. Per the coordinator, no further independent round. Status stays in_verification: there is no standing HOLDS (board rule 5). Needs a service restart (not done).
