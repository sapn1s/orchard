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

### 2026-09-23 — fix lane (re-dispatch, class=fix) — NO-OP: fix already landed, re-verified
- **Ground truth first: the fix is already in HEAD.** This re-dispatch treated
  BUG-160 as unfixed, but the round-1 fix is committed as `8016442` (verified
  `git merge-base --is-ancestor 8016442 HEAD` = in HEAD). `reattachDriving`
  (public/app.js ~11223), the `drivenByDashboard`→`void reattachDriving(sess)`
  branch (~5562), the reattach-ack boundary flush (idle `flushQueue()` ~9724 /
  busy setBusy-boundary ~9694), and the server `nothing-to-reattach` guard
  (src/server/index.ts ~4022, src/server/events.ts ~374) are all present and
  structurally intact. I made NO code changes.
- **Hypothesis check (the re-dispatch's "re-derived flag" theory): CONFIRMED as
  the original root, already addressed.** `isDriving()` required an open driving
  socket the reloaded sole tab did not hold; the landed fix declares driving by
  OWNING it (reattachDriving opens the socket + promptless start), not by
  re-deriving. Nothing to rebuild.
- **BUG-150 conflict check: NO conflict — designs are complementary.** The only
  unstaged app.js delta in this tree is BUG-150's queue-ownership rework
  (`resetTranscript()` returns the adopted outbox and re-binds `queueKey`
  synchronously via `adoptQueueRows`; `adoptQueue` has no internal callers).
  BUG-150 restores the queue *earlier and more robustly*; BUG-160's boundary
  flush still consumes `state.queue`. `flushQueue` and its triggers are intact.
  BUG-150 feeds the queue that BUG-160 delivers — they compose, they do not race.
- **Regression suites (verbatim, this tree):** `verify-bug-150-load-window-queue`
  16/0, `verify-bug-150-adversarial` 25/0, `npm run gate` PASS (exit 0,
  leak-gate + check-nul + typecheck all green).
- **BUG-160's own real-browser contract suite is NOT runnable-to-green in THIS
  sandbox — environmental, not a regression.** `verify-reload-live.mjs` returned
  1/2 twice (identical, not flaky). The seed turn genuinely started (the harness
  throws "turn never started" on `!busy||!sid` and did NOT throw — real `sid`,
  `busy===true` pre-reload), yet the haiku essay `CLOCKS-DONE` never streams via
  file-follow within 240s and the turn still "ends" (idle check passes). If a
  real model backend were producing content, `CLOCKS-DONE` would surface even on
  a FAILED reattach (as round-1's verify lane observed pre-fix: "FIRST-DONE still
  arrived via read-only file-follow"). It never does here → no sustained model
  output in this sandbox. Matches round-1's note that `verify-feat-065-delivery`
  fatally failed "seed turn never started" on both tree AND HEAD as environmental.
  The failing signal (`sid` null after reload + zero streamed content) is
  UPSTREAM of the reattach path and cannot be produced by BUG-150's queue-only
  delta, so it is not a code regression.
- **Independent clean-room verify with a REAL model backend still WARRANTED** to
  re-confirm the user-observable proof (auto-reattach drives + restored message
  delivered exactly once, never into a running turn) that round-1's verify lane
  captured 9/0 post-fix / 4/2 must-FAIL pre-fix but that this sandbox cannot
  reproduce. No code was changed this pass.

### 2026-09-29 — fix lane (round 2, class=fix) — ROOT-CAUSED + reproduced; BLOCKED-ON-FILES (no code changed)
- **Reproduced the container-default route loss at the API layer (no docker
  needed — the loss is upstream of any turn producing content).** Harness
  `/tmp/bug160-repro.mjs`: fully-isolated scratch server (free port, scratch
  `CLAUDE_STATION_DATA` + `CLAUDE_PROJECTS_DIR`), a real `POST /api/projects`
  with `isolation:container`, then I simulated exactly what the in-container CLI
  writes — a transcript under `-workspace-<id>` (cwd `/workspace/<id>`) — and
  asked `GET /api/projects/:id/sessions`. **6/6:** the session IS listed;
  project-level `encodedDir` = the HOST path (`-tmp-…`); per-session `encodedDir`
  = the CONTAINER store dir (`-workspace-<id>`); the two DIFFER; replaying
  `applyRoute`'s match (`route.dir === x.encodedDir`) with the dir the reload
  URL carries finds NOTHING → session lost, `reattachDriving` never fires. A
  CONTROL direct project shows no mismatch (project `encodedDir` == session
  `encodedDir`) — the bug is container-only. This confirms the round-1
  independent verdict (run 8a4566dd, BROKEN VALID) against my own command.
- **Root cause (two producers of one fact — the ARCH-010 violation).** The
  session's store-dir identity is produced in two path spaces:
  1. **Fresh-start client fallback** — `public/app.js:11173`
     `if (!state.current.encodedDir) state.current.encodedDir =
     state.sessions.get(projectId)?.encodedDir` copies the PROJECT-level
     `encodedDir`, which the server sets to `hist.encodeCwd(p.hostPath)` — the
     HOST path (`src/server/index.ts:1532`). `currentRoute()` (`app.js:16765`)
     then writes the URL `dir` from `state.current.encodedDir`, so a
     freshly-started session's URL carries the HOST dir.
  2. **Sessions API per-row** — each session's `encodedDir` is its REAL store dir
     (`src/server/index.ts:1549`, `s.encodedDir`), which for a container session
     is `containerStoreDirName(p)` = `-workspace-<id>` (merged in at
     `index.ts:326/332`).
  On reload `applyRoute` (`app.js:16818-16820`) matches `route.dir` (host)
  against each row's `encodedDir` (container) → no match → the session-not-found
  branch rewrites the hash to the bare project route; `openSession`'s
  `drivenByDashboard` branch never runs, so the round-1 `reattachDriving` fix is
  dead on arrival. (A session OPENED from the sidebar is unaffected: `openSession`
  sets `state.current.encodedDir = sess.encodedDir` = the container dir. Only the
  fresh-start-then-reload path — the user's constant action — is stranded.)
- **Invariant / fix shape (ARCH-010 — the owner already declares it ONCE).**
  `AgentBridge` already has the single declared source: `get storeEncodedDir()`
  (`src/server/agent-bridge.ts:625-628`) = `this.#containerStoreDir ??
  encodeCwd(this.cwd)` — the host store dir the transcript actually lands in
  (`containerStoreDirName` for container, encoded cwd for direct), with a comment
  saying "Read this; do not re-encode `cwd`." It is simply NOT sent in the
  `session-init` frame, so the client is forced to reconstruct it from the wrong
  (host-project) path space. The fix is to SEND the declared value and READ it —
  no new derivation, no second source.
- **Exact hunks (3 files, all carrying OTHER lanes' uncommitted edits → NOT
  edited by this lane):**
  - **`src/server/agent-bridge.ts`** — in the `session-init` emit (~line 4927),
    add one field: `encodedDir: this.storeEncodedDir,` (the already-declared
    owner accessor). Container store dir is set at launch (line 1463) well before
    this frame, so it is populated.
  - **`src/server/events.ts:174`** — add `encodedDir: string;` to the
    `session-init` frame union member.
  - **`public/app.js:11173`** — read the declared value first:
    `if (!state.current.encodedDir) state.current.encodedDir = e.encodedDir ??
    state.sessions.get(state.current.projectId)?.encodedDir ?? null;`
  Why it is exactly right and regression-free: for a container session
  `storeEncodedDir === containerStoreDirName(p)` === the value the sessions list
  reports per row (index.ts:326), so the URL dir now MATCHES on reload; for a
  direct session `storeEncodedDir === encodeCwd(hostPath)` === the host encoding
  === today's value, so nothing changes. `index.ts` needs NO change — the
  sessions API is already correct; the defect is purely the client's first-turn
  reconstruction.
- **Blocked-on-files:** `src/server/agent-bridge.ts`, `src/server/events.ts` and
  `public/app.js` all have concurrent uncommitted edits from other lanes
  (`git status`); this lane made NO code change per the collision rule. The three
  hunks above are disjoint from the reattach/queue code round 1 touched and from
  the store-isolation / session-reorder lanes' hunks noted in the round-1 verify
  entry.
- **regressed-from:** FEAT-131 (container became the DEFAULT isolation, exposing
  the client's host-path reconstruction that direct sessions never tripped).
- **High-stakes (session-lifecycle + contested reattach/route code): once the 3
  hunks land, an independent clean-room pass is WARRANTED** — confirm REQ1/REQ2
  under container isolation (reload restores the session and `reattachDriving`
  fires) and the still-untested REQ3 (a genuine second tab → live-elsewhere)
  under container isolation, per the round-1 verify handoff.

### 2026-09-29 — independent clean-room verify (round 1, class=verify) — VERDICT: BROKEN (VALID)
- **Requirement handed to the verifier (plain terms, no fixer prose):** after a sole tab reloads its own still-running bridge-backed session, (1) it reads as DRIVING (isDriving true, no "not driving" chip) via an automatic promptless reattach, not a passive follow; (2) a message queued before the reload is restored AND delivered exactly once at the next turn boundary, never into a running turn, never dropped; (3) a genuine second tab is still refused live-elsewhere and follows read-only; (4) a promptless reattach with no surviving bridge is refused `nothing-to-reattach`, never spawned as an empty resume turn.
- **Strategy: CARRIER-TREE.** The BUG-160 fix commit `8016442` predates `src/server/seed-sources.mjs` (added `ca672b9`), so a clean room at that revision REFUSES to boot. Used bootable `b11e71f` as `--range` head — it carries `seed-sources.mjs` and the full shipped BUG-160 code (`reattachDriving` ×4 in `public/app.js`, `nothing-to-reattach` in `index.ts`/`events.ts`, all verified present at `b11e71f`) — and told the verifier the shown diff is a boot carrier, NOT the change under test: attack `public/app.js`/`index.ts`/`events.ts` and the reload/reattach/queue behaviour directly and re-run `scripts/verify-reload-live.mjs`.
- **Command (tilde form):** `CLAUDE_CONFIG_DIR=<grey-account> node scripts/independent-verify.mjs --repo ~/projects/orchard --range b11e71f --requirement @<req> --run "node scripts/verify-reload-live.mjs" --test-file scripts/verify-reload-live.mjs --author-provider anthropic --provider anthropic --timeout-min 20 --verdict-out <verdict>`
- **Verdict: BROKEN, VALID** (`--check-only` re-confirms VALID; harness-composed, exit 1). This pass ISOLATES the real cause the two prior lanes could only call "environmental / no model output":
  - **FINDING (root cause — container-default route loss, upstream of the reattach fix):** under the now-DEFAULT container isolation, reloading a still-running session LOSES it before `reattachDriving` can fire. The URL's `dir=` carries the HOST-encoded path (`-tmp-cs-adv-proj-…`) but `/api/projects/:id/sessions` reports `encodedDir` as the CONTAINER path (`-workspace-<project>`). `applyRoute` (`public/app.js:15163-15183`) matches on `encodedDir`, finds nothing, and rewrites the hash to the bare project route; `openSession`'s `drivenByDashboard` branch (`public/app.js:5518-5562`) never runs, so `reattachDriving` never fires. Result after reload: `sid:null, driving:false, following:false`, and the still-live `detached-running` bridge is orphaned (cited runs `3200d6f4324a`, `46fe7382678d`). This is NOT a "no model output" artifact — the REQ1 route/DOM failure is independent of any turn producing content.
  - **FINDING (REQ1 unmet):** the fixer's own `verify-reload-live.mjs` (run `ce05c7add90d`, exit 1, 1/2) reproduces it directly — after reload `sid:null, busy:false, driving:false, goMode:"send"` and the running turn's answer never reached the reloaded tab.
  - **FINDING (REQ2 unmet — silent drop):** a message queued mid-turn through the real composer before reload is neither restored (queue `[]` after reload) nor delivered — no reply arrived, transcript holds zero user messages with the marker (runs `7b890189af48`, `033394dbda5c`, run twice to rule out a flake). REQ2's "NOT injected into the running turn" half PASSED (nothing was delivered at all, because the session was lost).
  - **REQ4 HOLDS:** promptless resume with no surviving bridge (absent / empty / whitespace prompt) all returned `nothing-to-reattach` with no ack, no session-init, no bridge spawned (run `eaca55d96e7a`, 3/0). That half of the fix is confirmed sound.
- **Could-not-test (verifier's list, carried forward):** REQ3 (a genuine second tab → live-elsewhere) — unreachable because the container-default URL restore fails before any reattach; REQ1/REQ2 under HOST (non-container) isolation, where `dir=` and `encodedDir` might match (the verifier did not flip project isolation); the relayed/CLI-written read-only case; the exactly-once race when the turn ends between the liveRec fetch and the reattach ack.
- **Status: STAYS OPEN.** BROKEN via a genuine clean room → not VERIFIED. Note the round-1 direct-isolation verify (9/0 post-fix) was not wrong for its runtime — the DEFAULT changed to container (FEAT-131) after it, and the reattach fix is dead-on-arrival there because the route restore fails first. Handoff for round 2: fix the URL `dir=` vs listed `encodedDir` mismatch so `applyRoute` restores a container session on reload (that is upstream of, and a precondition for, `reattachDriving`); then re-verify REQ1/REQ2 AND the still-untested REQ3 under container isolation. **regressed-from:** FEAT-131 (container became the default and broke the direct-session-assuming reload/route path). High-stakes (session-lifecycle + contested reattach/queue/route code) — round 2 again warrants an independent pass.
- **Verified-by:** dispatch anthropic run 8a4566dd-246a-4c81-bde7-f05f1a6acda9 (clean-room, `scripts/independent-verify.mjs`; grey account, SAME-provider fallback — decorrelation reduced; carrier-tree head `b11e71f`) — VERDICT: BROKEN

### 2026-09-30 — BUG-217 fix lane (cross-reference, no BUG-160 status change)
- A live strand on 2026-09-30 (session ce054915, direct isolation) read exactly like
  this ticket's symptom, but its root is distinct: the bridge had already CLOSED
  (journal 02:33:01), so there was nothing for `reattachDriving` to take over, and this
  ticket's criterion 5 (refuse a promptless resume) left that state with no owner.
  Filed and fixed as BUG-217 (client: `flushQueue` → `driveQueue` resumes the session
  with the queued row). It touches this ticket's code paths: the reattach ack still
  owns delivery at its boundary; `handleLiveElsewhere` now keeps a carried queue row
  pending instead of minting a dead copy; the dock wording changed.
- Not addressed there, and still open here: the container-default `dir=` mismatch that
  loses the session on reload (round-2 finding) — it also blocks the real-model queue
  suites (`verify-bug-129`, `verify-bug-153`, `verify-reload-live`) at the reload.
