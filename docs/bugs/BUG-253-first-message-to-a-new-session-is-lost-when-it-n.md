```orchard-ticket
{
  "id": "BUG-253",
  "type": "bug",
  "title": "First message to a new session is lost when it never starts",
  "summary": "In a private container project the user sent the first message of a new session while the container was being recreated after a base-image migration. The turn never ran, no session appeared, and the message is gone: it is not in the outbox, any transcript, or browser storage.",
  "impact_if_we_wait": "Any first message typed into a new session can vanish without a trace whenever the session fails to start: a slow or failing container, a closed tab, a server restart, or a CLI that dies before it starts. Orchard promises an unprocessed message is never lost.",
  "current_need": "Record every new session's first message durably before the start is acknowledged, settle it when the session starts, and show any message that did not start a session in the dock with Send again / Discard.",
  "severity": "high",
  "area": "server (start route, outbox)",
  "reported": "2026-10-12",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "in_progress",
  "human_action": "none",
  "updated": "2026-10-12",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A first message accepted by the start route is on disk before the start is acknowledged or anything is spawned.",
    "Admission failure, socket close, server restart or CLI death before init each leave the message in the dock with Send again and Discard.",
    "Send again starts exactly one new session with the message; a second press is refused.",
    "On the normal path the message appears exactly once in the new session's transcript and nothing is left in the dock.",
    "Must-FAIL: a synthesized pre-fix server (the durable record removed) loses the message on each failure path."
  ],
  "code_refs": [
    {
      "path": "src/server/index.ts",
      "symbol": "WS start handler",
      "note": "new-session start makes no durable write before startSession"
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "AgentSession constructor / startSessionAdmitting",
      "note": "firstPrompt only in memory; recordUserPrompt skipped for persistedTranscript engines"
    },
    {
      "path": "src/server/outbox.ts",
      "symbol": "createOutboxRow / pump",
      "note": "BUG-217 outbox keyed by sdkSessionId; covers only existing sessions"
    }
  ],
  "related": [
    {
      "id": "BUG-217",
      "relation": "see_also"
    },
    {
      "id": "FEAT-175",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "opus",
      "run_id": "268766ea-350e-4ed5-8464-d362be8e459b",
      "verdict": "broken",
      "verdict_on": "2026-10-12",
      "recorded_at": "2026-10-12T09:25:11.215Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "anthropic",
      "model": "opus",
      "run_id": "4720fd59-35ad-472d-a7db-5371487e9196",
      "verdict": "broken",
      "verdict_on": "2026-10-12",
      "recorded_at": "2026-10-12T10:01:21.451Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
    }
  ],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": true,
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

# BUG-253 — First message to a new session is lost when it never starts

## Symptom
User report, 2026-10-12: in a private container project, at 10:49 to 10:51 EEST, the user sent the first message of a new session while the container was being recreated after a base-image migration. The turn never ran and no session appeared. The message is not in the outbox, any transcript, or browser storage. A later send at 10:57 worked.

## Repro
Scratch server (isolated data dir and store, fake CLI), direct project, start a new session with a marked prompt, then make the start fail. Each of these leaves the marker nowhere in the data dir or the transcript store:
1. the CLI exits after taking the prompt, before `system:init`;
2. admission fails (the project directory is missing);
3. the server is SIGKILLed after the start is sent and before init.

## Expected
The message stays visible and recoverable: in the project's dock, marked not sent or not confirmed, with Send again and Discard. When the session does start, the message is in its transcript exactly once and nothing is left in the dock.

## Diagnosis
Read-only diagnosis lane ab8404e9fc4a74d68, confirmed by the repro above. A new session's first prompt is held only in memory (agent-bridge.ts, AgentSession constructor). For engines with their own transcript (Claude) the bridge does not record it (`recordUserPrompt` is skipped). The WS start handler makes no durable write. The BUG-217 outbox is keyed by the session's sdkSessionId and covers only sessions that already exist. When the socket closes, `releaseSocketSession` or the closedEarly path closes the session and the prompt goes with it. The client holds the text only in memory (`pendingStart`, drafts).

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play: src/server/index.ts (WS `start`, outbox wiring), src/server/agent-bridge.ts (`startSessionAdmitting`, AgentSession init and close), src/server/outbox.ts, public/app.js (dock: rebuildQueue / paintQueue / outboxAct).
- Related tickets: BUG-217 (the outbox), FEAT-175 (rebuild hold on the start path).
- Repro test: `node scripts/verify-bug-253-first-prompt-durable.mjs`.
- Known dependencies / blockers: none.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-12 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-12 — fixing lane (agent)
- **round 1 — plan, review, build, verify:** - **Understood:** Reproduced before any change on an isolated scratch server (fake CLI, direct project): a marked first message was found NOWHERE in the data dir or transcript store after (1) the CLI exits on its first user frame before `system:init`, (2) admission fails (project dir missing), (3) the server is SIGKILLed between the start and init. Root cause as diagnosed (lane ab8404e9fc4a74d68): a new session's first prompt lived only in memory until the CLI recorded it; the BUG-217 outbox covered only sessions that already had an id.
  - **Plan (one chokepoint):** every new-session start with a non-blank prompt first mints its own outbox START BOX `start.<hex>` holding one row, written `sending` and fsync'd BEFORE `startSession` (src/server/outbox.ts `mintStartRow`). A save failure refuses the start ("nothing was sent"). One helper, `runNewSessionStart` (index.ts), is used by both callers — the WS `start` and the outbox's Send again (`route:'new'`). The outcome is decided once: the session's first `system:init` → `delivered` + `startedAs` (journal then removed); a close before init (tab closed, CLI died, reap) → `uncertain`; a refusal before spawn → `failed`; may-have-spawned → `uncertain`; a restart reloads `sending` as `uncertain` (restart reason). The bridge only gets two generic callbacks (`firstPromptHooks.onInit` / `onEndBeforeInit`, agent-bridge.ts). Undelivered rows are shown in the project's new-session dock (`GET /api/outbox/starts?project=`), reusing the BUG-217 dock and its edit/discard/send routes with the row's `box` as the session; Send again re-queues ONCE (existing 409 rule) and the pump starts one new session with the raw text (no outbox header).
  - **Plan review (cross-provider attempted):** OpenAI (codex, thread 01a12f35-9d1b-7e13-97f1-2ecac231819a) ran out of quota mid-review after two findings; completed by a separate Claude Opus process via `scripts/dispatch.mjs --provider anthropic` (session a927ae47-95c3-427c-96c4-9c579ec1cc98). Fixed before/while building: F1 an older attempt's late init could settle a Send-again attempt → per-attempt token (`attempt`), a stale `started` is recorded as `alsoStartedAs`, never a state change; F2 a delivered Send-again box was never collected (GC ran while reserved) → GC after the reservation is released, and on discard/dismiss; F4 the client dock acted only on session ids → `item.box`, `refreshStarts`/`applyStartsView`, per-box damage bar; F5 `kept` is stamped by an `onEvent` wrapper on every fatal frame before the outcome (the frame precedes the rejection); F7 `recent.retried` so only a dock Send again is announced; F8 no Send now / Interrupt on a start row; F9 an "unsure" mint failure unlinks the brand-new box; F12 the row stores the raw start overrides (re-validated by the same validator on Send again); F13 a damaged start box is never collected and is listed for the project (or every project when its row is gone). Accepted as residuals: F3/F10/F11/F6 below.
  - **Changed (unstaged):** src/server/outbox.ts, src/server/agent-bridge.ts, src/server/index.ts, src/server/events.ts, public/app.js (dock + start-error branch only; not applyRoute/deep-link), public/lib/api.js, scripts/fixtures/bug-187/fake-cli.mjs (opt-in `FAKE_EXIT_BEFORE_INIT`, `FAKE_INIT_DELAY_MS`), scripts/verify-bug-253-first-prompt-durable.mjs (new), scripts/lib/bug-253-container-arms.mjs (new), package.json (`verify:bug-253`).
  - **Verified:** `node scripts/verify-bug-253-first-prompt-durable.mjs --shots /tmp/b253-shots` (sandbox env set) → 36 passed, 0 failed (826 s): U1-U4 in-process (stale attempt, first-settle-wins, reload, 409, forged create refused); N normal path (once at the CLI, once in the transcript, dock empty, box removed); A admission fail (fatal frame `kept`, dock `failed`, on disk); F Send again (200 then 409, one new session, once, raw text); G discard; V real click-path in headless brave on a busy project (two prior sessions + kept rows, one long): composer not refilled, three "Not sent" rows with Send again/Edit/Discard, Send again from the dock reaches the CLI once, Discard removes one, no overflow, no page errors; B CLI dies before init → `uncertain`; C SIGKILL at the record's crash point → `uncertain` after reboot, nothing spawned; D tab closed after ack before init (init held 6 s) → delivered once; K1 container `docker create` fails (sandbox) → `failed`; K2 slow container create + tab closed mid-admission (the incident) → delivered once, never lost. MUST-FAIL: `--against-prefix` (a synthesized pre-fix tree: the mint anchor disabled, matched exactly once; never `git show HEAD`) → exit 1: on N/A/B 7 property checks FAIL and 3 pass (the ones pre-fix also satisfies: once at the CLI, once in the transcript, the CLI took the prompt), and C 3 of 3 FAIL; the P arms confirm the marker is found nowhere on disk on the pre-fix tree for A, B, C. Screenshots (not published): /tmp/b253-shots/BUG-253-dock-{1280,520}-{light,dark}.png — reviewed: one-line causes, actions aligned, no clipping. This is SYNTHETIC test state (scratch server, fake CLI); no real instance of the incident survives to replay.
  - **Anti-regressions:** `npm run gate` → PASS (exit 0). `verify-feat-175-grant-rebuild-unit.mjs` → 48 passed, 0 failed. `verify-bug-217-queued-message-strand.mjs --only N,A,F,S,W,DN,Z,T` → 61 passed, 1 failed: `N: queued in a real tab that then CLOSED mid-turn` (the outbox waits `draining` on a survivor). It is FLAKY and NOT caused by this change: on a scratch copy of the current tree with BUG-253 disabled (mint anchor off, the client edits reversed) it failed 2 of 3 runs; with BUG-253 it failed 5 of 6. Not fixed here; worth its own ticket.
  - **Residuals (stated):** (a) a RESUME `start` (an existing session) that fails before its CLI records the prompt keeps the same in-memory window — not covered here; (b) for Codex, `system:init` precedes `turn/start`, so a refused first turn reads delivered — the words are in the session's own Orchard transcript (the recorder flushes the first prompt at init), not lost; (c) a CLI that dies after init but before writing the prompt reads delivered; (d) a pre-init CLI that neither inits nor closes leaves the row `sending` until restart; (e) a session that survives a graceful restart and inits later leaves its row `uncertain` (restart reason tells the user to check the list); (f) a stale attempt's session is recorded as `alsoStartedAs` but not shown in the dock.
  - **Regression note:** not a regression of a prior fix; BUG-217's outbox never covered sessions without an id.
  - **Still open / handoff:** independent clean-room verify (session-lifecycle / data-loss: warranted). Decision for the user: whether to extend the same record to resume starts (residual a).

### 2026-10-12 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/opus run 268766ea-350e-4ed5-8464-d362be8e459b — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-12 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/opus run 4720fd59-35ad-472d-a7db-5371487e9196 — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-12 — fixing lane (agent)
- **round 2 — two IV breaks, stopped:** - **IV round 1 — BROKEN** (anthropic/opus, run 268766ea-350e-4ed5-8464-d362be8e459b, clean-room `--working-tree`; OpenAI quota was exhausted). Path 1 (VISIBILITY): the tab closes after the ack while the CLI holds the prompt and has not reached `system:init` — `releaseSocketSession` detaches the busy session, and `startsView` hid every non-retried `sending` row, so the message was on disk but in no dock row, no `recent`, no session list, unbounded if the CLI hangs. Its own adversarial cases that HELD: a real start journal truncated at 8 offsets with and without its head, a garbled line, a 450k-char prompt, a blank prompt.
  - **Round 2 fix:** a start row is hidden only while the socket that sent it is open (`watched`, memory only); `ws.on('close')` unwatches it, so a still-`sending` first message is listed at once as "Starting a new session with it…". Also added a 3-min pre-init deadline that turned the row `uncertain` (Send anyway). New arm H reproduced path 1 first (FAIL: INVISIBLE for 25 s), then PASS.
  - **IV round 2 — BROKEN** (anthropic/opus, run 4720fd59-35ad-472d-a7db-5371487e9196). Path 2 (EXACTLY-ONCE), created by the round-2 deadline: past the deadline the dock offered Send anyway while the original CLI was still alive; one press started a second session, the original then inited, and the message reached two sessions (2 transcripts). The older session was recorded only in `alsoStartedAs`, which the dock never shows; and a row can read `failed` ("did not start") while an older attempt's session holds the message.
  - **TWO-BREAK STOP — route to independent design review.** The property broke twice via different paths (visibility of a pre-init start; double delivery from the remedy for it), and the second break was introduced by the fix for the first. Per the charter I stopped patching. The only change after the second verdict was to WITHDRAW the round-2 deadline (the code that opened path 2), restoring round 1 plus the socket-watch visibility. Nothing new was added.
  - **Current tree state:** never lost on admission failure, socket close, restart, or CLI death before init. A pre-init start whose tab closed is visible at once as `sending`, with no resend offered while its CLI lives. OPEN: a CLI that hangs before init forever leaves that row visible but not actionable until the session ends or the server restarts. Design question for review: let the user STOP the hung attempt (close its session, which settles `uncertain` with no live CLI left to double-deliver), versus a deadline that must first prove the CLI is gone. Also open: show `alsoStartedAs`; lift a `failed`/`uncertain` row to delivered when an older attempt's session inits.
  - **Verified after the withdrawal:** `node scripts/verify-bug-253-first-prompt-durable.mjs --no-container` → 36 passed, 0 failed (130 s): U, N, A, F, G, V, B, C, D, H, P. H shows the timeline `sending ×25, delivered`: visible within 3 ms, never offered for a resend. Container arms K1/K2 passed 4/4 on the round-1 code. They were NOT re-run after rounds 2 and 3 because the Docker sandbox lock was held by another lane's verify-feat-175 run. `npm run gate` → PASS (exit 0) after the withdrawal.
  - **Verdicts recorded:** BROKEN ×2 via `board-tool verified` (runs above). No HOLDS. The ticket stays IN-PROGRESS.
  - **Symptom of a deeper design flaw?** Likely yes, but not filed. "Has this message reached a session?" is decided in two places that can disagree: our record, and a live CLI that has not declared itself yet. That deserves the design review rather than a third patch.
