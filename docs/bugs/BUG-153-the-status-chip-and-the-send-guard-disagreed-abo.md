```orchard-ticket
{
  "id": "BUG-153",
  "type": "bug",
  "title": "the status chip and the send guard disagreed about liveness",
  "summary": "A session kept working in the background after the service restarted, but the interface stopped saying so, and Force send answered \"no live session to force-send over\" on a session it still presented as attached. A reload brought the message back as a queue row that could neither be sent nor reclaimed: delete and retype was the only way out.",
  "impact_if_we_wait": "Every restart, refused takeover and reload can leave a tab that lies about what is running and refuses the action it just invited. The user's typed message is what is at risk each time, and the lie is paid for in retyping.",
  "current_need": "The status a user reads and the guard that refuses their send must come from one predicate, and a queued message in a tab that cannot deliver it must be recoverable in one action.",
  "severity": "high",
  "area": "dashboard client / session status",
  "reported": "2026-08-25",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "in_progress",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "the status chip never claims Claude is working in a tab that holds no driving socket",
    "the chip and the send/force-send/interrupt guards are computed from the same liveness predicate, so no event order can make them disagree",
    "a session still running in the background reads as running in the background after a refused takeover, not as idle",
    "a queued message this tab cannot deliver offers one click back into the composer, dead or not",
    "the queued text survives a reload and stays recoverable without retyping"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-149",
      "relation": "see_also"
    },
    {
      "id": "BUG-129",
      "relation": "see_also"
    },
    {
      "id": "FEAT-040",
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

# BUG-153 — the status chip and the send guard disagreed about liveness

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-25 — worker
- **Understood:** Two surfaces answered the same question from different data.
  `computeSessState()` decided "Claude is working" from `state.busy` with no
  liveness test at all, and decided "running in the background" from
  `state.sessDetached` — a flag raised on ONE reopen path and cleared by ANY
  socket open, including one belonging to a different session or to a `start`
  the server went on to refuse. Every action guard (force-send, the queue
  flush, the interrupt button) asked the honest question instead: does this tab
  hold a socket. So the two could not be reconciled, and which one was right
  depended on the order events happened to arrive in.
- **What I could not attribute:** the prior lane could not date the regression
  and neither could I — the history here is one squashed commit, so `git blame`
  returns nothing. I did not need it: the fix removes the flag rather than
  correcting one of its writers, so no attribution is load-bearing. It stays
  unattributed rather than guessed.
- **The disagreement I actually reproduced**, since being precise about this
  matters more than repeating the report: I could not construct a state where
  the chip literally reads "Thinking…" while force-send refuses — every path
  that drops `live` also drops `busy`. What IS reachable, and what the harness
  demonstrates against a real server, is the same defect one label over: open a
  session another driver holds mid-turn (chip correctly: "Running in
  background — send a message to take it over"), do exactly that, and the
  server's refusal opens the socket that clears the flag. The pre-fix chip then
  reads **"Idle · Nothing is running"** while `/api/sessions/live` says that
  session is mid-turn, and every guard still refuses. Same root cause, same
  class of lie, provable rather than asserted.
- **Changed:** `public/app.js`.
  - `isDriving()` — one predicate: an open, non-relay socket this tab can send
    over. `computeSessState()`, `forceSend()`, `flushQueue()`, the dock's
    `notDriving` label and the interrupt button all read it now, so they can
    only disagree again if someone re-derives liveness somewhere else.
  - `state.sessDetached` is DELETED, all five sites. Detachment is derived:
    not driving + (busy or `followingLive`) reads as running-in-the-background,
    which is the honest state and also names the way out. `followingLive` is
    the durable half — cleared where it is genuinely resolved (the `start` ack,
    the run ending, the session boundary), not by an unrelated socket.
  - A tab that is not driving can no longer print "Claude is working" at all.
  - The interrupt button's detached refusal moved inside the `busy` branch. It
    was the first line, so a detached-but-idle run refused to SEND the message
    it was in the same breath asking for.
  - The queue row: "To composer" on EVERY row, not only dead ones (BUG-149's
    scope), and "Force send" only when it could actually run. The reported
    state produces a `restored` — alive — row whose only action refused.
- **Verified:** `npm run verify:bug-153` — **20 passed, 0 failed**, re-run against the exact committed tree (an earlier run said 21/21 before a redundant check was dropped; the count is the later, committed one). Real server,
  real `claude` sessions holding a real in-flight turn, real headless browser
  doing the clicks; the must-FAIL leg is a constructed pre-fix client (7
  substitutions, each asserting a hit count of exactly 1), never `git show
  HEAD`, so committing this cannot turn the proof into decoration.
  - FIXED: chip says "Running in background" after the refused takeover while
    the SERVER says busy; the reloaded row offers "To composer" and no
    could-only-refuse Force send; one click restores the exact text; sending it
    takes the run over and only THEN does the chip say "Thinking…".
  - PRE-FIX, same actions, same server: chip `{"state":"idle","label":"Idle",
    "title":"Nothing is running."}` while ground truth was
    `{"found":true,"busy":true}`; the row's only action answered *"no live
    session to force-send over — reattach first, then force-send again"* and
    the composer stayed empty — delete and retype, exactly as reported.
  - The agreement is checked as a PROPERTY at every observation point in both
    scenarios, not at one chosen moment: "at no point did the chip claim Claude
    is working in a tab holding no driving socket".
  - Screenshots: `~/scratch/bug153-shots/` (A-fixed-after-refused-takeover,
    B-fixed-after-reload, B-fixed-reclaimed-into-composer, B-fixed-after-takeover,
    and the pre-fix pair). Read them; the chip and dock copy were reviewed, not
    just asserted.
  - Anti-regression: `verify:queue` 15/15, `verify:bug-129` 23/23,
    `verify:bug-149` 21/21, `verify:reload-live` 3/3, `verify:bug-079` 10/10,
    `verify:ui` 7/7. `verify:feat-065` 34/35 — the one failure is S3's bounded
    approval-deny timing over a raw socket, no client code in it.
    `verify:feat-064` 16/18 — S3c asserts a drain chip wording that BUG-134
    deliberately replaced; confirmed pre-existing by grepping HEAD's app.js,
    which produces the same string this change does.
- **Verified-by:** PENDING — a clean-room pass is warranted and is NOT optional
  here: this is client session-state with a regression history (FEAT-040,
  BUG-129, BUG-149 all in the same lines), and the fixture is mine. Two cases
  it does NOT cover, as the work queue for that pass: (1) the delivery-relay
  window — `isDriving()` now excludes it, which changes what force-send does
  during a FEAT-065 injected turn; (2) `followingExternal` — a session a
  terminal is writing sets no `busy`, so it still reads Idle, which may be the
  next instance of this same lie.
- **Still open / handoff:** the row's actions live inside a collapsed
  `<details>`, so reclaiming is expand-then-click; the dock label now names the
  affordance, which is the cheap half. Whether the dock should surface it
  without disclosure is a design question, not a defect.
- **Symptom of a deeper design flaw?** Not closing this ticket, so not
  answering it as a close — but the suspicion to hand forward: this is the
  second time (BUG-149 was the first) that the interface's account of a
  session and the guard's account came apart, and both times the fix was to
  collapse two derivations into one. If a third appears, that is an ARCH.
