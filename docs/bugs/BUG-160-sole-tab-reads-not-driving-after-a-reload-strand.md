```orchard-ticket
{
  "id": "BUG-160",
  "type": "bug",
  "title": "sole tab reads \"not driving\" after a reload, stranding its queued message",
  "summary": "After reloading the dashboard on its own still-running session, the ONLY tab reads \"not driving the session\" and a message typed before the reload sits \"restored after a reload, still unsent\" and never delivers. After a reload the tab held no driving socket (openSession only FOLLOWED its own bridge), so isDriving() was false and flushQueue never fired.",
  "impact_if_we_wait": "Every reload of a live session leaves the sole user told they are not the driver and their typed text stranded undelivered — the same harm as the multi-hour message strand, paid for in retyping, on the one action (reload) users take constantly.",
  "current_need": "A sole client must read as DRIVING its own still-running session right after a reload; a message restored from before it must reach the session at the next boundary, never into a running turn.",
  "severity": "high",
  "area": "dashboard client / reattach + queue",
  "reported": "2026-08-28",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-28",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "after a sole tab reloads its own dashboard-driven session, isDriving() is true and the chip no longer reads \"not driving\"",
    "a message queued before the reload is restored AND delivered at the next boundary, never into a running turn, never dropped",
    "a genuine second tab (bridge driven elsewhere) is refused live-elsewhere and still follows read-only — the honest \"not driving\" is preserved",
    "a relayed / externally-written (CLI) session is untouched and still follows read-only",
    "a promptless reattach whose bridge no longer survives is refused nothing-to-reattach, not spawned as an empty resume turn"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-153",
      "relation": "see_also"
    },
    {
      "id": "BUG-159",
      "relation": "see_also"
    },
    {
      "id": "BUG-129",
      "relation": "see_also"
    },
    {
      "id": "BUG-149",
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

# BUG-160 — sole tab reads "not driving" after a reload, stranding its queued message

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-28 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-28 — fix lane (round 1, class=fix)
- **Determination (two faces, one root).** The dock message the user read —
  *"this tab is not driving the session … restored after a reload, still
  unsent"* — is the queue dock's `notDriving` branch, which is simply
  `!isDriving()` (public/app.js). `isDriving()` (BUG-153) requires an OPEN,
  non-relay `state.ws`. After a reload the tab has NO such socket: `openSession`
  only PASSIVELY FOLLOWS a dashboard-driven bridge (`state.followingLive = true`,
  "send a message to take over"), and the driving socket is opened ONLY by an
  explicit send (`startTurn`/`connect`). So `isDriving()` is false until the user
  sends — the chip reads "Running in background"/"not driving" though the tab is
  the ONLY client, and `flushQueue`'s guard `!isDriving() || busy || dropped`
  (public/app.js) can never pass, so the message restored from before the reload
  (`adoptQueue`, `restored:true`) has NO automatic delivery path. Its two
  triggers (a `busy→idle` transition this tab owns; a `turn-end` for a turn it
  started) never fire in a passive follower, and `deliverQueuedBehindBackground`
  needs the busy+strand shape. Confirmed by two read-only sweeps of the client
  queue/flush paths and the server liveness/reattach path.
- **Is it a BUG-153/BUG-159 regression? Honest answer: NO, not cleanly.** The
  dispatch's hypothesis was that one of those flipped a predicate. It did not:
  `isDriving()` reports the truth — the reloaded tab genuinely holds no driving
  socket. BUG-153 SURFACED it (it worded the chip/queue from `isDriving()` and
  removed the old `sessDetached` flag that "any socket open" — including the
  passive follow socket — used to clear, which had masked the state). But the
  underlying gap — a sole client's reload never re-establishes a DRIVING socket,
  and every queue-delivery path needs one — predates both and is structural
  (the passive-follow-on-reload contract is FEAT-040 / verify-reload-live). So:
  `surfaced-by: BUG-153`, root = a missing sole-client reattach, not a regressed
  predicate. Not recorded as `regressed-from`.
- **Server ground truth (why the fix is safe).** `drivenByDashboard` =
  "this server holds an in-memory bridge for this sdkSessionId" (src/server/
  index.ts) — durable across a reload when work outlives the turn (busy, a live
  background lane, or a container), which is exactly the user's orchestrator
  case (the bridge DETACHES, not closes). The server cannot distinguish a
  sole-reloaded tab from a headless-detached one — but it does not need to: a
  bridge driven in ANOTHER tab is NOT `detached` and reattach is refused
  `live-elsewhere`; only a detached (nobody-driving) bridge attaches. So
  auto-reattach is safe by construction.
- **Fix (client + a narrow server guard):**
  - `public/app.js` — new `reattachDriving(sess)`: on `openSession` of a
    dashboard-driven bridge it opens a driving socket and sends a PROMPTLESS
    `start` (resumeSessionId, no prompt). It bails if already driving / a socket
    is up / a start is in flight, and closes the socket if the user switched
    sessions mid-connect (txScope guard).
  - `public/app.js` — `openSession` drivenByDashboard branch now fires
    `void reattachDriving(sess)` (message reworded from "send a message to take
    over" to "reattaching to drive it here").
  - `public/app.js` — the `e.reattached` ack: the busy message is now accurate
    for a promptless reattach (no phantom "your message is queued" when nothing
    is pending); the IDLE reattach branch calls `flushQueue()` — that is the
    boundary a message queued before a reload was waiting for (guarded on
    `isDriving() && !busy`, both just made true), so a busy reattach still holds
    delivery to `turn-end` (never into a running turn).
  - `public/app.js` — the error handler treats a new `nothing-to-reattach` code
    quietly (roll the socket back, clear followingLive, keep the queue for the
    "To composer" affordance) — never latch sessError or kill queued rows.
  - `src/server/index.ts` — in the `start` handler, after the reattach block, a
    PROMPTLESS resume with no surviving bridge is refused `nothing-to-reattach`
    rather than falling through to spawn an empty `claude --resume` turn. INERT
    for every existing caller (the client always sends a non-empty prompt with
    `start`; only `reattachDriving` is promptless).
  - `src/server/events.ts` — added `'nothing-to-reattach'` to the error frame's
    `code` union.
  - `scripts/verify-reload-live.mjs` — updated to the NEW contract: a reloaded
    sole tab AUTO-REATTACHES (isDriving() true, followingLive false) instead of
    passively following; the honesty property (not idle history, still busy,
    interrupt button) is unchanged.
- **Deliberate behaviour change flagged for the independent pass:** opening a
  dashboard-driven DETACHED session now takes it over (auto-reattach) instead of
  passively following. Safe (live-elsewhere protects a real second driver) and
  correct for a sole local user, but it changes the "open to watch read-only"
  UX for a dashboard-driven detached session; a reviewer may want it gated to
  reload-restore only. `followingExternal` (CLI/relayed) is untouched.
- **Verification:** real-browser must-FAIL + regression suites delegated to a
  clean-context verify lane (real haiku sessions, headless brave, scratch
  server, free port); pending — counts and screenshots to be appended.
- **Independent clean-room verify WARRANTED** (session-lifecycle + touches the
  most contested reattach/queue code + a server start-handler change): confirm
  the strand must-FAILs on clean HEAD and the auto-reattach delivers the restored
  message exactly once, not into a running turn.

### 2026-08-28 — verify lane (round 1, class=verify, real browser)
- **Verdict: fix is load-bearing and correct.** Real haiku sessions + real
  headless brave over a scratch server (free port), harness
  `~/scratch/bug160/verify-bug160.mjs`.
- **Scenario 1 — reported bug, POST-FIX: 9 passed / 0 failed.** After a sole tab
  reloads its own still-running session: `isDriving()===true`,
  `followingLive===false`, `busy===true`, `#go` in `stop` mode — the tab
  AUTO-REATTACHED and drives (chip "Responding…", not "not driving"). The message
  typed before the reload survived as `{restored:true, dead:null}`; `FIRST-DONE`
  then **`SECOND-DELIVERED` arrived** — the restored queued message was actually
  delivered at the turn boundary (the core proof). Final state idle.
- **Scenario 1 — PRE-FIX must-FAIL (HEAD versions of the three fix files):
  4 passed / 2 failed, and the 2 failures ARE the load-bearing properties.**
  After reload `driving:false` (stayed passively following; never took the
  driving socket) and **`SECOND-DELIVERED` never arrived within 240s** — the
  strand reproduced exactly. (`FIRST-DONE` still arrived via read-only
  file-follow; the queue restored but never flushed.) So the fix is not
  decoration.
- **Scenario 2 — honest second tab, POST-FIX: PASS.** Tab A drives a busy turn;
  a second page opened to the same session URL comes back `isDriving()===false`,
  `followingLive===true` (read-only) while tab A still drives — the honest
  "Running in background" state is preserved (the server refuses the second
  tab's promptless reattach `live-elsewhere`).
- **Regression suites (verbatim):** `verify:reload-live` 3/0 (new contract),
  `verify:queue` 15/0, `verify:bug-129` 23/0, `verify:bug-149` 21/0,
  `verify:liveness-conformance` 96/96.
- **`verify:bug-153` 16/4 on the working tree, 20/0 on HEAD — BENIGN,
  test-maintenance, NOT a user regression.** All 4 failures are in bug-153's
  "PRE-FIX (each hunk mechanically reverted)" must-FAIL leg; the FIXED (real
  working-tree) leg is fully green (incl. "the reclaimed message is sent and
  takes the run over"). Cause: bug-153's prefix leg reverts only ITS OWN hunks,
  but BUG-160's `reattachDriving` lives outside them and independently fixes the
  behaviour that leg tries to demonstrate as broken (open/reload of a detached
  running session now auto-reattaches instead of "Force-send-only that refuses").
  **Follow-up owed:** update `verify-bug-153.mjs`'s prefix leg to also revert
  `reattachDriving` (as `verify-reload-live.mjs`'s contract was updated). Left
  for the independent pass rather than editing another ticket's asset here.
- **`verify:detach` 6/1 then 7/0 on retry — FLAKY, not a regression.** The
  failing check is a timing-sensitive 30s poll of a 3s self-close grace; BUG-160's
  server hunk (the promptless guard) is never exercised by that scenario (a raw
  ws that detaches with no reattach and no promptless start).
- **`verify-feat-065-delivery.mjs` FATAL "seed turn never started" on BOTH the
  working tree AND HEAD — pre-existing / environmental, not BUG-160.**
- **Screenshots (read by the fix lane, both themes):** `~/scratch/bug160/shots/`
  — `s1-postreload-driving-{light,dark}-post.png` (chip "Responding…", interrupt
  button, dock "Claude is working — delivers at the next pause · restored after a
  reload, still unsent"), `s1-second-delivered-post.png` (the delivered turn
  running), `s2-tabB-not-driving-post.png` ("Running in background", read-only),
  and the pre-fix counterparts.
- **Concurrency (reported, not mine):** `public/app.js` also carries the
  session-list-reorder lane's hunks (`userSubmitAt`/`recencyKey`/
  `stampUserSubmit`/`loadSessions` retire); `src/server/index.ts` also carries the
  store-isolation lane's hunks (`markSanctionedRealStoreWriter` + several API-route
  hunks). BUG-160's own hunks are disjoint from both. The gate's typecheck fails
  ONLY on the store-isolation lane's `scripts/verify-ui.ts → ./lib/station-boot.mjs`
  implicit-any (that lane added a `.mjs` import with no `.d.mts`); not a BUG-160
  file. My files (app.js, index.ts, events.ts) typecheck clean.
