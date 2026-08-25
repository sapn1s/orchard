```orchard-ticket
{
  "id": "BUG-045",
  "type": "bug",
  "title": "Retryable messages now queue during restart draining",
  "summary": "Messages refused while a restarted session finishes draining now remain queued and retry automatically instead of returning to the composer. Non-retryable refusals still return the text, and queued messages remain editable or cancelable.",
  "impact_if_we_wait": "Deployment delay leaves restarted sessions temporarily write-locked, forcing repeated manual submissions while draining continues. Bounded: this affects message delivery convenience, not transcript integrity or message retention, because refused text remains recoverable.",
  "current_need": "Deploy the client change; pre-fix behavior failed, corrected queue and interface behavior passed, and standing checks stayed clean.",
  "severity": "medium",
  "area": "Restart message delivery",
  "reported": "2026-08-11",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-11",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A retryable refusal queues the message instead of returning it to the composer",
    "The queued message delivers exactly once after draining finishes",
    "Non-retryable refusals still return the message with the reason",
    "Queued messages remain editable and cancelable",
    "No second command races onto a draining transcript"
  ],
  "code_refs": [
    {
      "path": "app.js",
      "symbol": null,
      "note": "BUG-045 changes the client send and refusal path"
    },
    {
      "path": "verify-resume-refusal.mjs",
      "symbol": null,
      "note": "Real-shape restart-drain scenario named for extended coverage"
    }
  ],
  "related": [
    {
      "id": "BUG-079",
      "relation": "see_also"
    },
    {
      "id": "FEAT-015",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-065",
      "relation": "blocks"
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
    "archived_path": "docs/bugs/archive/BUG-045-restart-drain-refusal-not-queued.md",
    "sha256": "4453ac7477bb1be39bf5f3124200ac4de9fcc233ef27adfc1ad4bef5adff5d82",
    "bytes": 7699,
    "original_title": "restart-drain refusal bounces the message to the composer instead of queueing + auto-retrying",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied ticket text; the symptom, safety constraint, queue behavior, retry triggers, fallback behavior, deployment need, and recorded evidence remain represented.",
    "dropped": []
  }
}
```

# BUG-045 — Retryable messages now queue during restart draining

## Diagnosis

After a restart, the liveness gate correctly refuses a second command while the previous turn is still draining. The client treated every refusal as terminal, so even `retryable:true` returned the message to the composer instead of using the existing busy-message queue.

## Evidence

The pre-fix case recorded `pre-fix FAIL`. After the client change, `verify:queue` passed 14/14 and `verify:ui` passed 7/7. Additional matched tallies were 13/13 and 19/19 without adjacent suite names. Typecheck and leak-gate were clean. No result was recorded for the named `verify:resume-refusal` or `verify:refusal-visible` suites.

## Implementation notes

Queue retryable refusals with a visible draining message. Flush them after the next session liveness or snapshot transition shows draining has settled or the bridge is re-established. Use a slow polling fallback for missed events. A later non-retryable refusal returns the text and reason to the composer. Existing queue controls preserve editing and cancellation.

## Verification plan

Exercise a restarted session with a draining survivor. Submit once, confirm the message enters the queue, complete draining, and confirm exactly one delivery. Check that non-retryable refusal returns text and that no second command starts against the draining transcript.

## Migration and rollback

The change is client-only and awaits deployment. Rollback restores manual composer retry behavior without changing the server refusal contract.

## Risks

Event and polling retries could both flush the same queued message unless delivery is deduplicated. Weak refusal classification could also retry a terminal error indefinitely or bypass the transcript liveness safeguard.

## Activity log (APPEND-ONLY)
### 2026-08-11 — orchestrator
- Filed from the user's live report immediately after the pid-3989993 deploy. The refusal fired
  exactly as designed (BUG-033 gate, drain was real — orchestrator turn was mid-flight), but the
  user experience is "the dashboard won't take my message and won't tell me when it will".

### 2026-08-11 — fix agent (VERIFIED)
- **Root cause confirmed:** purely client-side, exactly as filed. The server already tags both
  pre-ack retryable refusals `retryable:true` (`src/server/index.ts:2583` survivor-drain guard,
  `:2461` frameless drop) — but `app.js`'s `case 'error'` treated retryable identically to
  terminal: `rollBackPendingStart()` + "press Enter to try again". Nothing queued, nothing
  retried; a long drain write-locked the session. **Server untouched** (BUG-033 gate and BUG-022
  no-second-CLI invariant intact — every retry below is a full `start` the gate re-judges).
- **Fix map (public/app.js, client-only):**
  - `:6068-6072` — the `error` branch splits on `e.retryable`: retryable → `queueRetryableRefusal()`;
    non-retryable → `failDrainWaitAttempt()` + `rollBackPendingStart()` (BUG-029 composer-return kept).
  - `:5009-5046 queueRetryableRefusal()` — BUG-029's rollback minus the composer hand-back; the text
    becomes a row in the EXISTING busy-path queue, flagged `drainWait` (+ its resume id/project);
    first refusal creates the row, a re-refused self-retry keeps the same row (no duplicates). Marks
    the closing socket dead synchronously (`state.ws=null/live=false`) so the `setBusy(false)` flush
    microtask cannot push the row into the dying socket (double-delivery window found during
    verification, closed here).
  - `:5053-5088 armDrainWaitRetry/attemptDrainRetry` — slow-poll fallback every 7s (spec: 5-10s),
    4.5s min-gap, ghost-attempt release at 15s; retry = full `startTurn` over the SAME resume,
    composer draft preserved around it.
  - `:4832-4835` (in `refreshLive`) — the liveness-transition trigger: the moment the draining
    session leaves the live set, retry immediately (the transition IS "drain settled").
  - `:5091-5101 settleDrainWaitDelivery()` — exactly-once retirement: the row leaves the queue ONLY
    on the retry's `start` ack (fresh ack `:5664`, idle reattach `:5653`); busy reattach `:5640-5648`
    converts the row to a normal queue item instead of `queueMessage`-doubling it.
  - `:6220-6222` (flushQueue) — an in-flight retry's row is excluded from the boundary flush
    (the other half of exactly-once).
  - `:5108-5117 failDrainWaitAttempt()` — non-retryable re-refusal falls back to composer-return
    when the composer is free, else the row stays marked dead (text never lost, never in two
    live places).
  - `:6158-6165, :6180-6186` (paintQueue) — the visible chip: "waiting for the previous turn to
    finish draining — retries itself; edit or discard below", per-row "waiting on drain" +
    `.drain-wait` class. Rows keep ALL existing queue affordances (edit textarea, Discard).
  - `:113-117` — three new state fields (`drainWaitTimer/Attempt/LastTry`).
- **Verification (§C, real-shape):**
  - `scripts/verify-resume-refusal.mjs` (extended, happy-dom + real server + planted alive
    survivor): **PRE-FIX 5/13 (8 FAIL** — no queue row, no chip, composer bounce, retry never
    armed/fires, row not editable — with #fine literally showing the reported "kept in the
    composer — press Enter" line**); POST-FIX 13/13**, incl. self-retry round-trip against the
    still-draining survivor with exactly ONE row kept, edit-reaches-delivery, Discard cancels,
    and the BUG-029 anti-regression (non-retryable → composer, queues nothing).
  - `scripts/verify-refusal-visible.mjs` (extended, real brave + real haiku turns): **PRE-FIX
    (ALIVE scenario) 2/7 (5 FAIL** — no chip/queue, and after the drain cleared the message
    NEVER delivered: 0 transcript turns, 0 on-disk user messages**); POST-FIX 19/19** — ALIVE:
    drain clears → queued message delivers ITSELF (no Enter) as exactly ONE turn (DOM count 1,
    on-disk store 1 user message); STALE anti-regression intact; FRAMELESS: auto-retry resumes
    and the ENGINE received exactly ONE turn carrying the message (fixture input log,
    `CODEX_FAKE_INPUT_LOG` + `CODEX_FAKE_EXPECT_RESUME` so the fixture accepts the resume).
  - `verify:queue` **14/14** · `verify:ui` **7/7** · `typecheck` clean · `leak-gate` PASS.
  - Note: `verify:queue`'s per-item-note regex was anchored at `^user:[msg 1/…` and flaked when a
    FEAT-057 "[station] While you were away…" outcomes briefing (server-side, `outcomes.ts`,
    untouched) was prepended — the assertion now tolerates that optional block; the per-item
    notes are still matched exactly.
- **Deploy:** NOT deployed — client-only change in `public/app.js`; lands on :4317 with the next
  deploy + a page reload. Do not restart the service for this ticket alone.
