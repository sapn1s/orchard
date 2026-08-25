```orchard-ticket
{
  "id": "BUG-149",
  "type": "bug",
  "title": "A message refused as live-in-another-tab is lost, silently",
  "summary": "The server refuses a send from a second tab with a clear sentence. The client logs it to the console and shows nothing. The typed text sits in state.pendingStart, which the fatal-error branch returns from without reclaiming, so it is in no store and a reload loses it.",
  "impact_if_we_wait": "The user types, is told nothing, waits for a reply that cannot come, then loses the text on reload and retypes it. It is the loss BUG-129 shipped durability to end, on a route durability never covered.",
  "current_need": "none — fixed and verified",
  "severity": "high",
  "area": "Composer message queue / error surfacing",
  "reported": "2026-08-25",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The refusal is visible in the interface — not only in the browser console",
    "The refusal explains truthfully why one tab at a time, and what the user can do here",
    "The typed text is never dropped: it lands in the same browser storage BUG-129 built, marked NOT delivered",
    "The text survives a reload, still marked unsent, and is recoverable back into the composer without retyping",
    "No other queued row is mislabelled dead by this refusal — the session is alive, not fatal"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "onEvent case error",
      "note": "the e.fatal branch returns before the BUG-029 pendingStart hand-back, so an un-acked start refused fatally leaves its text in state.pendingStart forever"
    },
    {
      "path": "src/server/index.ts",
      "symbol": "the start handler live-session guard",
      "note": "sends the refusal with fatal:true and no machine-readable code, so the client cannot tell this recoverable refusal from a dead session"
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "attach",
      "note": "the reason the restriction exists: the bridge has ONE #emit sink and attach replaces it, so a second driver silently redirects the live stream away from the first tab"
    }
  ],
  "related": [
    {
      "id": "BUG-129",
      "relation": "see_also"
    },
    {
      "id": "BUG-029",
      "relation": "see_also"
    },
    {
      "id": "BUG-013",
      "relation": "see_also"
    },
    {
      "id": "BUG-022",
      "relation": "see_also"
    },
    {
      "id": "BUG-038",
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

# BUG-149 — A message refused as live-in-another-tab is lost, silently

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-25 — agent
- **Fix and verification:** WHY the restriction exists, established before writing any copy about it: the bridge holds a SINGLE `#emit` sink and `attach()` replaces it (agent-bridge.ts). A second socket would not share the session — it would silently blind the first tab mid-turn, redirecting its reply and its still-open approval cards to a window nobody asked. Two drivers pushing prompts into one CLI stream is the BUG-022 shape on top of that. Reading is unaffected (the transcript on disk is the record), so "watch it here read-only" is literally true and the banner says it.

  THE FIX. Server: the refusal carries `code: "live-elsewhere"` (fatal stays true, so an older client is unchanged). Client: a dedicated branch ahead of the generic fatal path — like the BUG-090 needsFork branch — that (a) reclaims the un-acked text into an ordinary dock row, durable through the BUG-129 store, marked NOT delivered with the reason; (b) removes the optimistic bubble; (c) raises a banner carrying the server sentence; (d) does NOT latch sessError and does NOT failQueue, because the session is alive, not dead. Dead rows also gained a "To composer" button — before this they were a dead end (select the textarea by hand, or Discard).

  VERIFICATION: scripts/verify-bug-149-live-elsewhere.mjs — a REAL server, a REAL first tab (a socket that ran a real haiku turn and stays attached, which is exactly what the server guard tests), and a REAL browser as the second tab, driven by the real click-path (expand the project, click the session row, type, Enter). 21/21. The must-FAIL baseline is CONSTRUCTED, never HEAD: the live-elsewhere branch is mechanically disabled so the frame falls into the fatal path exactly as before, asserted to match once. Pre-fix, in the same script: no visible banner, no dock row, nothing in storage, and the reload brings back nothing.

  TWO DEFECTS THE ASSERTIONS PASSED AND A SCREENSHOT CAUGHT. (1) The banner was mounted beside the composer-replacement banners and rendered BELOW the composer, off the bottom of the viewport — present, visible, correct, unreadable. It now sits above the dock, and its position is asserted. (2) The dock announced "1 queued message · delivering…" in a tab that holds no socket and can deliver nothing. The notDriving test was `some(restored) && !live`, but nothing about being restored is what stops delivery — flushQueue own first line is `!state.live || !state.ws`. Widened to that, and moved below the drain-wait branches (those do self-retry). Both now have assertions.

  A RACE THE FIRST TWO RUNS PASSED BY LUCK: the rollback located the optimistic bubble as "the last top-level .you", which is only true while nothing else appends — and the transcript follower appends whatever the OTHER tab really writes. The third run left the refused bubble on screen still claiming delivery, and the same guess can remove the other tab first REAL message instead. startTurn now records the element it painted (state.pendingStartEl, set in the same tick as pendingStart) and the rollback removes that; the last-.you fallback is kept for the older paths. Both directions are asserted.

  ANTI-REGRESSIONS RUN: verify:bug-129 23/23, verify:queue 15/15, verify:reload-live 3/3. verify:detach is 6 pass / 1 fail ("the detached bridge closed itself at the boundary") — PRE-EXISTING, proven by running the same suite in a clean worktree at HEAD, where it fails identically.

  NOT DONE, DELIBERATELY: multi-tab sync. It is a feature and a much larger change (the single sink above is the thing that would have to go), and the user asked for the loss and the silence first.
