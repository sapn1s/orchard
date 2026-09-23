```orchard-ticket
{
  "id": "BUG-150",
  "type": "bug",
  "title": "Messages queued before a session's transcript loads are not stored",
  "summary": "openSession sets state.current, then awaits the transcript fetch, and only calls adoptQueue afterwards. Until that call, queueKey is null and persistQueue writes nothing. Anything queued in that window lives only in the tab's heap — the exact condition BUG-129 exists to end.",
  "impact_if_we_wait": "A message typed in the moment right after opening a session is silently non-durable. It looks queued and is not stored, so a reload or a tab close destroys it with no signal, which is the failure class the board treats as the worst this product has.",
  "current_need": "confirm the window is reachable by a person (not only by a script), then close it",
  "severity": "medium",
  "area": "Composer message queue",
  "reported": "2026-08-25",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A message queued at any point after a session is on screen is written to storage",
    "Adoption of the stored rows never duplicates a row already in state.queue",
    "The BUG-129 suite still passes unchanged"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "openSession",
      "note": "adoptQueue() is called after the awaited transcript fetch; queueKey stays null until then"
    },
    {
      "path": "public/app.js",
      "symbol": "queueTargetKey",
      "note": "returns null while queueKey is null, so persistQueue is a no-op for rows queued in that window"
    }
  ],
  "related": [
    {
      "id": "BUG-129",
      "relation": "see_also"
    },
    {
      "id": "BUG-149",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
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

# BUG-150 — Messages queued before a session's transcript loads are not stored

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-25 — agent
- **Evidence — how this was noticed:** Found while verifying BUG-149, not by looking for it. The BUG-149 suite queues a message immediately after the session row is clicked (as soon as state.current.sessionId settles) and then reads localStorage. In the PRE-FIX leg the store was empty — "(nothing stored)" — even though the dock showed the row on screen. In the FIXED leg the same row WAS stored, because the refusal handler paints the dock again a second or two later, by which time adoptQueue has run and queueKey is set. So the write is not reliable; it is rescued by whatever happens to repaint after the fetch returns. The ordering in openSession is the cause: state.current is set, the transcript fetch is awaited, and adoptQueue() (which assigns queueKey) runs only after it. NOT PROVEN against a human typing speed — a person may never be fast enough to land in the window. That is exactly what current_need asks for before anything is changed.

### 2026-09-23 — agent (fixing, round 1)
- **Hypothesis CONFIRMED against the real code.** `public/app.js` `openSession`: `state.current` is set (was ~5326), then `resetTranscript()` nulls `queueKey`, then `await api.transcriptTail(...)`, and `adoptQueue()` — which assigns `queueKey` — ran only AFTER that await (was line ~5438 in the try, ~5558 in the catch). Throughout the load window `queueTargetKey()` returns null, so `persistQueue()` (the whole write path, reached via `paintQueue()` on every queue mutation) writes nothing. A message queued in that window lived only in `state.queue` (the tab heap); a reload/close destroyed it with no signal.
- **Fix — makes the loss impossible by construction (ARCH-010).** The fact "which session owns `state.queue`" is `queueKey`, and it is now DECLARED by its owner synchronously at the session boundary, before any await, so no reader can hit the window. Split the old `adoptQueue()` into two: `adoptQueueRows()` (SYNCHRONOUS — assigns `queueKey = draftKey(state.current)` and restores this session's stored rows) and `judgeAdoptedOutbox()` (ASYNC — judges the handed-off outbox against the painted transcript, unchanged timing, still after the pane is on screen). `openSession` now calls `adoptQueueRows()` immediately after `restoreDraft`, BEFORE the transcript fetch, and `judgeAdoptedOutbox(adoptedOutbox)` after (both try and catch). `adoptQueue()` remains as a thin `judgeAdoptedOutbox(adoptQueueRows())` wrapper for the callers with no await after `resetTranscript` (`startNew`, the fresh-start re-take path) — unchanged for them.
- **Files changed:** `public/app.js` (openSession ordering + adoptQueue split); new test `scripts/verify-bug-150-load-window-queue.mjs`.
- **DEMONSTRATION (real browser + real server, real `openSession`/`adoptQueueRows`/`persistQueue`):** `node scripts/verify-bug-150-load-window-queue.mjs` → **10 passed, 0 failed.** Decisive check (success criterion #1): a message queued DURING the load window (openSession left pending on its transcript fetch) is in durable storage the instant it is accepted, keyed to this session, and still stored after the open resolves. MUST-FAIL is a genuine, non-vacuous proof against a SYNTHESIZED pre-fix client (the two openSession edits mechanically reverted, hit-count asserted per site — a constructed variant, never HEAD): it reports `queueOwnerKey === null` during the window and `(nothing stored)`, i.e. the live loss. SYNTHETIC-SESSION note (per CONVENTIONS): the session row is fabricated and the transcript endpoint stubbed/delayed to hold the window open — faithful because the load window (`resetTranscript` → `adoptQueueRows` → the awaited fetch) runs identically whether or not the session file exists; the file only affects transcript CONTENT, which arrives after the window closes.
- **Gate:** `npm run gate` → PASS (leak-gate, check-nul, typecheck), exit 0.
- **Success criterion #3 (BUG-129 suite unchanged) — analyzed + baselined, NOT green in this environment for reasons unrelated to this change.** `node scripts/verify-bug-129-queue-durability.mjs` (drives REAL model turns) failed here; I ran the UNMODIFIED HEAD `public/app.js` through the same suite and it failed IDENTICALLY (same "rows restored" timeout after a mid-turn reload, same terminal `TypeError … reading 'encodedDir'`, same failing legs), which proves the failures are pre-existing/environmental (bypassPermissions account, `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`, mid-turn live-reload race) and NOT a regression from this fix. Compatibility reasoning: the row-restore moved EARLIER (before the transcript paint) but the outbox delivery-judgment still runs after the paint (unchanged timing), and BUG-129's must-FAIL leg 6 is dominated by its neutered `persistQueue` (nothing written → nothing to restore), so the `function adoptQueue()` neuter still matches exactly once and the proof still holds.
- **High-stakes flag:** SILENT-DATA-LOSS + session-lifecycle class, and BUG-129 could not be executed clean here — an independent clean-room verify pass (a fresh-context agent re-running `scripts/verify-bug-150-load-window-queue.mjs`, and ideally BUG-129 in an environment with a normal-permission model) is warranted before this is called settled.

### 2026-09-23 — agent (verifying, round 2) — VERDICT: FAIL (regression on the transcript-fetch-FAILURE path)
- **Independent verifier (did not read the fixer's rationale before attacking).** The fixer's own suite is honest and reproduces: re-ran `scripts/verify-bug-150-load-window-queue.mjs` ONCE → **10 passed, 0 failed** (real brave + real server; happy-path window close + synthesized pre-fix must-FAIL both hold). Cross-provider clean-room adversarial pass via `npm run dispatch --provider openai` (read only the diff + the fixer's test, no `docs/`) independently flagged the same failure-path loss.
- **BREAK FOUND — a message typed AFTER a failed transcript fetch is silently non-durable, and the window-typed row VANISHES from the dock.** `openSession`'s **catch** block (`public/app.js` ~5567) runs `resetTranscript()` — which nulls `queueKey` AND empties `state.queue` — and then calls only `judgeAdoptedOutbox(adoptedOutbox)`, which NEVER re-takes ownership. So after any transcript-fetch rejection: `queueOwnerKey()===null`, the message the user queued during the load window is wiped from `state.queue` (gone from the dock; it survives in storage only because the null key blocks the overwrite), and the session is left owning nothing. Any message typed next lands under a null key → `queueTargetKey()` null → `persistQueue()` writes nothing → a reload/close destroys it with no signal. This is the exact BUG-150 failure class, relocated to the fetch-failure path.
- **regressed-from: BUG-150 (this same fix).** PRE-FIX the catch called `adoptQueue()` (= `adoptQueueRows()` + judge), which RE-SET `queueKey` and restored the rows after `resetTranscript`. The fix replaced that with `judgeAdoptedOutbox(adoptedOutbox)` (rows-half dropped), on the mistaken premise stated in the diff comment ("the rows were already adopted before the fetch") — but `resetTranscript()` INSIDE the catch had already undone that synchronous adoption. The try-path is fine (no `resetTranscript` after the await); only the catch regressed.
- **DEMONSTRATION (real brave + real server, real `openSession`/`adoptQueueRows`/`persistQueue`; verifier-authored, NOT the fixer's fixture):** `scripts/verify-bug-150-adversarial.mjs` → **12 passed, 3 FAILED.** The 12 passes cover cases the fixer's fixture skips and all hold: FULL reload round-trip (type in window → real `Page.reload` → reopen → msg restored exactly once), rapid A→B session-switch mid-load (both msgs stored under their own key, neither leaks nor duplicates on reopen), whitespace-only row (nothing persisted). The 3 FAILS are scenario E (transcript endpoint stubbed to HTTP 500): `observed {"ownerKey":null,"draftKey":"s\0…\0sess-E","queueLen":0}` after the catch, and storage holding only the pre-failure row `FAIL-ECHO-DURING` — the post-failure `FAIL-ECHO-AFTER` was accepted into the dock yet written NOWHERE. SYNTHETIC-SESSION note (per CONVENTIONS): session fabricated + transcript endpoint stubbed/delayed, faithful for the same reason the fixer's note gives (the load/catch window runs identically regardless of the on-disk session file).
- **Could NOT test:** BUG-129 suite unchanged (success criterion #3) — same environmental block the fixer hit (drives real model turns; bypassPermissions account); did not re-attempt. The GPT pass additionally raised two OUTBOX-durability concerns (unconfirmed `state.outbox` erased-before-judgment; double-judge duplication on A→B→A) — I judged these PRE-EXISTING (the outbox null-then-judge shape is unchanged in substance, only split across two fns) and OUT OF SCOPE for BUG-150's typed-row requirement, so did not gate on them; they may still merit a separate BUG-129/FEAT-031 look.
- **Fix direction (for the fixer, not prescriptive):** the catch must re-establish ownership after its `resetTranscript()` — e.g. call `adoptQueue()` there (as pre-fix), or re-run `adoptQueueRows()` and thread its descriptor into `judgeAdoptedOutbox`, so `queueKey` is non-null and the restored rows are back on the dock before the "could not read this session" hint.
- **Verified-by:** `node scripts/verify-bug-150-adversarial.mjs` (12 pass / 3 FAIL, scenario E decisive) + one clean re-run of `scripts/verify-bug-150-load-window-queue.mjs` (10/0) + cross-provider `npm run dispatch --provider openai` adversarial read (transcript `openai/…/01a0ce82-37a9-7b61-a745-b228a81898d8.jsonl`). Verifier fixture: `scripts/verify-bug-150-adversarial.mjs` (untracked, unstaged).

### 2026-09-23 — agent (fixing, round 3) — REFUTATION REPRODUCED, then fixed by construction
- **Reproduced the round-2 break first.** Ran the verifier's untracked fixture unmodified: `node scripts/verify-bug-150-adversarial.mjs` → **12 passed, 3 FAILED**, scenario E decisive. Observed exactly as reported: after the transcript endpoint 500s and `openSession`'s catch runs, `queueOwnerKey() === null`, the window-typed row is gone from the dock (`queueLen 0`), and a message typed AFTER the failed fetch is accepted into the dock yet written NOWHERE. The round-1 catch (`resetTranscript(); judgeAdoptedOutbox(adoptedOutbox)`) dropped the rows-half of adoption on the failure path — the same silent-loss class, relocated.
- **Root cause (design, not site).** `resetTranscript()` is the ONE function every session boundary and every in-place transcript reset passes through, and the only place `queueKey` is dropped to null. Round 1 made adoption a SEPARATE synchronous call in the happy path only, so any other exit that re-ran `resetTranscript` (the catch) was left un-adopted, and any reader had to *remember* to re-adopt — precisely the ARCH-010 failure the coordinator named.
- **Fix — ownership re-binding now lives INSIDE `resetTranscript` (ARCH-010: declared once by its owner).** `resetTranscript()` ends with `return adoptQueueRows()` — it re-takes ownership of `state.current`'s stored rows and returns the handed-off outbox descriptor. So EVERY exit path (openSession success + catch, `startNew`, the fresh-start re-take, a route that resolves to no session) leaves `queueKey === draftKey(state.current)` by construction; no call site can forget. Callers no longer adopt separately — they consume the returned descriptor: `openSession` captures it before the await and judges it after the paint (`judgeAdoptedOutbox(adoptedOutbox)`); the catch judges `resetTranscript()`'s fresh return; `startNew`/fresh-start judge it immediately. `adoptQueue()` (= `judgeAdoptedOutbox(adoptQueueRows())`) is retained for the export/BUG-129 suite but no longer called from app.js.
- **Files changed:** `public/app.js` (resetTranscript owns re-binding; openSession success+catch, startNew, fresh-start re-take updated to consume its return; `resetTranscript` exposed on `window.__station`); `scripts/verify-bug-150-load-window-queue.mjs` (added scenario-E legs 1b + 2b; must-FAIL now neuters the single re-bind point `return adoptQueueRows()`, which reproduces BOTH the window loss and the catch-path loss).
- **DEMONSTRATION (both suites, real brave + real server):**
  - `node scripts/verify-bug-150-load-window-queue.mjs` → **16 passed, 0 failed** (adds scenario E: ownership held after a failed fetch, window row still on the dock, a message typed after is durable; plus must-FAIL 2b proving the neutered client loses it).
  - `node scripts/verify-bug-150-adversarial.mjs` (verifier's fixture, UNMODIFIED) → **15 passed, 0 failed** (was 12/3; scenario E now green).
- **Gate:** `npm run gate` → PASS (leak-gate, check-nul, typecheck), exit 0.
- **regressed-from: BUG-150 round 1 (this fix's own prior round).** Named per WA regression-honesty.
- **Not re-run:** BUG-129 suite (success criterion #3) — same environmental block as rounds 1–2 (drives real model turns; bypassPermissions account). Compatibility preserved: `startNew`/fresh-start still adopt rows + judge the outbox (now via `resetTranscript`'s return), timing of the outbox judgment unchanged.
- **High-stakes flag STANDS:** silent-data-loss + session-lifecycle, and this fix already regressed once. An independent clean-room re-verify (fresh-context agent re-running BOTH suites, ideally BUG-129 on a normal-permission model) is warranted before this is called settled.

### 2026-09-23 — agent (verifying, round 4) — VERDICT: PASS · STOP (round yielded only a benign characterization)
- **Independent verifier, attacked the NEW design (re-bind moved INTO `resetTranscript`, which now ends `return adoptQueueRows()`; every caller consumes it, none re-adopt). Read the diff, not the fixer's rationale.**
- **Round-1 regression is genuinely closed by CONSTRUCTION, not special-cased.** Re-ran the fixer's suite ONCE → **16 passed / 0 failed**; re-ran my round-2 adversarial fixture ONCE → scenario E now **PASSES** (`observed queueOwnerKey === draftKey` after the forced HTTP-500 transcript fetch, window row still on the dock, and a message typed AFTER the failure is durably stored — the exact bytes the regression dropped). The catch path can no longer leave `queueKey` null because the sole place it is dropped is also the sole place it is re-bound. Confirmed `adoptQueue()` now has NO internal callers — the only live ownership path is `resetTranscript() → adoptQueueRows()`, a single owner (ARCH-010 satisfied structurally).
- **Attacks NAMED then RUN against the new shape (all in `scripts/verify-bug-150-adversarial.mjs`, real brave + real server; 25 passed / 0 failed total):** (F) double `resetTranscript()` → exactly one row, no duplication (reset empties the queue before re-adopting, so it is idempotent); (G) cross-key strictness → with two stored sessions, reset restores ONLY `draftKey(state.current)`'s rows, binds ownership to that key, and leaves the OTHER session's stored rows intact (no delete, no migrate, no contamination); (H) route-to-no-session (`state.current = {projectId, sessionId:null}`, the `applyRoute` site ~line 15174) → binds to `p\0<proj>` and NEVER pulls a foreign project's rows onto the dock (no cross-project contamination); (I) reset with no ownable current (`projectId:null`) → no throw, ownership null, an unrelated stored session untouched.
- **Only finding is a benign CHARACTERIZATION, not a defect (WA stopping rule → STOP).** Case H re-shows the project's OWN pending-new rows under its OWN `p\0<proj>` key after a dead-link navigation, where the pre-round-3 code showed an empty dock. That is truthful (identical to what `startNew` already does with the same key) and is NOT a discarded-queue resurrection nor cross-contamination. One adjacent NIT (do not spend a round on it): the `applyRoute` no-session site at ~15174 calls `resetTranscript()` and IGNORES its return, so a `p\0<proj>` OUTBOX (if any) is not judged there until the next open — narrow, not data-loss (rows persist), and strictly better than the pre-round-3 no-adopt behavior. Converted the remaining concern into STANDING property assertions (F/G/H/I) in the adversarial suite rather than opening another round.
- **Could NOT test:** (1) BUG-129 real-model-turn suite — same environmental block as rounds 1–3 (bypassPermissions account); not re-attempted. (2) The `applyRoute` route-to-no-session path was exercised by setting `state.current` + calling the exposed `resetTranscript` directly (reset semantics are identical) rather than driving a real dead-link navigation end-to-end, so `applyRoute`'s surrounding side-effects (renderTree/selectProject) were not driven.
- **Verified-by:** `node scripts/verify-bug-150-adversarial.mjs` (25 pass / 0 fail; F/G/H/I are the round-4 standing assertions) + one clean re-run of `scripts/verify-bug-150-load-window-queue.mjs` (16 pass / 0 fail, scenario E green). Verifier fixture: `scripts/verify-bug-150-adversarial.mjs` (untracked, unstaged; not the fixer's).
