```orchard-ticket
{
  "id": "BUG-159",
  "type": "bug",
  "title": "user-typed message waits hours behind background work; session shows phantom running turn",
  "summary": "In an orchestrator with a live background lane, a TYPED user message is not delivered until the next real turn boundary — possibly hours away — and the UI shows the main thread running though no main turn is in flight. Measured: typed 14:25, delivered 180m42s later, behind machine notifications, after ~196 min dormant behind one quiet lane.",
  "impact_if_we_wait": "A person waits hours for their own input to be seen, with no way to tell why; destructive force-send is the only escape. The phantom 'main running Nmin' indicator misleads about session state on every such session.",
  "current_need": "Build the server-authoritative delivery fix (hold-not-throw; push into the runtime input queue at send time, exactly once) and make main-turn liveness honest so a stuck woken busy shielded by a lane stops reading as running.",
  "severity": "high",
  "area": "session lifecycle: send-path + liveness",
  "reported": "2026-08-27",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-27",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A message typed while a background lane is alive reaches the assistant at the next turn boundary, not after the whole chain drains.",
    "Nothing dropped: count of held user messages in equals count delivered out (exactly once), including a boundary/interject race.",
    "Ordinary delivery with nothing pending is unchanged (non-vacuity).",
    "A session idle behind a live background lane no longer reports the MAIN turn as running; the phantom 'main running' indicator reflects real main-thread state.",
    "Mid-turn/drain-wait delivery (FEAT-065/BUG-045) still works; the lifecycle regression set (BUG-157/033/034/065, verify-zombie-busy, verify-liveness-conformance) stays green.",
    "An independent clean-room pass confirms the fix."
  ],
  "code_refs": [],
  "related": [],
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

# BUG-159 — user-typed message waits hours behind background work; session shows phantom running turn

## The report

The user typed a message into a running orchestrator session; it reached the assistant **180 minutes later**, tagged as queued and predating several intervening responses. Their words: *"that means your turn was over 3h for some reason, something went wrong."* The same session showed *"main claude station development as running 17min?"* — that phantom indicator is this bug's other face.

## Measured incident (real transcript `87564f3e-…`)

- Typed **14:25:38Z**; delivered/answered **17:26:20Z** — gap **180m42s**.
- The session was **dormant ~196 min (14:07:13 → 17:23:52)**: the prior main turn ended cleanly at 14:07:13, then zero entries until an **unrelated background task re-notified "finished" at 17:23:52**, whose resulting turn's `turn-end` finally flushed the held message. Two machine notifications were processed **before** the 3-hour-old human message.
- The `[Queued 180m42s ago … predates that response]` tag is generated **client-side** by `queueItemNote` (public/app.js:8404) at flush time — proof the message sat in the dashboard's `state.queue` the whole time and was pushed to the server only at 17:26.

## The real ordering/delivery rule (not FIFO)

1. A user send while the session looks busy is **refused, never queued server-side** — `AgentSession.send()` throws at src/server/agent-bridge.ts:1367 before anything reaches the runtime `InputQueue`. The user message is never in any queue, so it cannot be reordered.
2. The client holds typed text in `state.queue` and delivers it **only** via `flushQueue()`, which runs **only on a `turn-end` event with `!state.busy`** (public/app.js:7348/8051, guard 8635).
3. Lane-completion turns are **CLI/SDK-native** self-woken turns (`agent-bridge.ts` `#markForegroundTurnLive` at 2572 sets `busy=true` on the woken `init`; `result` clears it). No Orchard re-send is involved.
4. Consequence: a queued message is delivered only in a `busy=false` window that (a) the CLI's self-woken turns race for and win, and (b) may not occur for hours when the last main turn ended and the next self-wake is a long-idle background lane away.

## Discriminator — SETTLED as SERVER-SIDE (a BUG-157 regression)

Settled with live reproductions (real haiku sessions on scratch servers):

- **Ordinary background lane does NOT strand.** At the dispatching turn's `result` the server correctly reports `busy:false, state:idle, "no turn is running"`, and a message sent during the idle-behind-a-live-lane window is delivered immediately. So the simple case is fine.
- **A background lane's completion wakes a NEW main turn** (`busy` toggles false→true via `#markForegroundTurnLive`) and in the happy path clears at that woken turn's `result`.
- **The strand requires a woken-turn `busy` that never clears.** `livenessOfBridge` (src/server/liveness.ts:559-563) returns `running:true, kind:'ok'` whenever `busy && processProbe()==='alive'` — and a live background lane keeps the broker+CLI process alive, so a stuck woken-turn `busy` is trusted as a running MAIN turn indefinitely. The frameless backstop (liveness.ts:567) is never reached because `probe.state==='alive'` short-circuits first.
- **Client `busy` has no independent source** — it mirrors the server's `e.busy` on reattach (public/app.js:7567/7576) and is cleared only by the server's `turn-end`. So both faces (queued-and-stranded delivery + phantom "main running") are downstream of the SERVER reporting the session as busy/main-running.

Both faces = one server-side root: a self-woken `busy` (introduced by BUG-157's `#markForegroundTurnLive`) that a live background lane shields from the only backstop that would clear it, because `livenessOfBridge` cannot distinguish "the CLI process is alive" from "the MAIN thread is mid-turn." **Record on BUG-157 as a regression.**

## Accepted fix design

**Part A — delivery (server-authoritative).** `AgentSession.send()` while busy: do NOT throw. Hold the text and push it into the runtime `InputQueue` **at send time** (mid-turn interject), exactly once — the CLI's own input queue holds it and runs it at the next boundary, ahead of any later self-woken notification turn; a dormant session (idle behind a quiet lane) delivers it immediately, and the resulting real `result` also clears the stuck `busy`. Ack honestly as `{delivered:true, queued:true}`. Prove exactly-once by counting in vs out. Do not disturb the fresh-turn accounting for a genuinely-idle send (nothing-pending path unchanged). Preserve the existing mid-turn/drain-wait delivery (survivor-delivery.ts, BUG-045/FEAT-065).

**Part B — honest main-turn liveness (the phantom).** `livenessOfBridge` must not report a MAIN turn as running when the main thread is idle behind a background lane. Distinguish main-thread work from background-lane work (the bridge already knows both: `#openToolCalls`/`#agents` vs `#backgroundTasks`), analogous to the container quiet gate, so a `busy` with no live main-thread work and no recent main-thread frame past the frameless window reads as not-a-running-main-turn — WITHOUT reaping the session or its lanes, and WITHOUT false-positiving a genuinely long silent main-thread tool call (the BUG-033 guard). Touches the ARCH-001 authority (liveness.ts) and its conformance guard (scripts/verify-liveness-conformance.mjs) — high-stakes.

**Client.** Route a typed message to the server promptly (server holds+pushes) rather than holding it in `state.queue` until a `turn-end` that may never come; keep the queue's edit/batch UX (FEAT-031/BUG-129). Caption: say **"queued behind background work"**, not a bare queued marker. public/app.js carries 3 other tickets' uncommitted hunks — keep to own hunks.

**Do NOT bound the notification chain** — the session was dormant behind one quiet lane, not spinning. A silent-lane watchdog is a separate ticket if it earns its place.

## Verification bar

- Must-FAIL reproducing the strand before the fix (scripted fake-CLI seam CLAUDE_STATION_CLAUDE_BIN: a woken `init` with a live lane and no `result`, then a user send is refused/stranded; label synthetic).
- Non-vacuity: ordinary delivery with nothing pending unchanged; nothing dropped (in==out).
- Full lifecycle regression set (BUG-157/BUG-033/BUG-034/FEAT-065; verify-zombie-busy.mjs, verify-liveness-conformance.mjs).
- Independent clean-room pass afterwards (scripts/independent-verify.mjs / fresh-context agent) — high-stakes, regression-prone.

## Determination status

Discriminator settled (server-side, BUG-157 regression) with live reproductions. Fix NOT yet built — filed for the build with the design above so a rushed, unverifiable multi-surface edit to the most contested lifecycle code was not started under insufficient budget. Repro scripts: ~/scratch/repro-strand.mjs, ~/scratch/repro-woken.mjs.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-27 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-28 — build lane (round 1, class=fix)
- **Built all three parts (server files left UNSTAGED for the user to commit):**
  - **A — hold-not-throw (`src/server/agent-bridge.ts` `send()`, `src/server/index.ts` send ack).** A busy `send()` no longer throws; it prepends the briefing, pushes the text into the runtime `InputQueue` at send time (the CLI's own multi-turn channel), records it, and returns `{delivered:true, queued:true}`. The idle CLI runs it at the next boundary — for the stuck-woken-busy strand that is immediately, and the real `result` also clears the stuck `busy`. `index.ts` acks `{delivered, queued}` honestly. The nothing-pending fresh-turn path is byte-identical (`queued:false`).
  - **B — honest main-turn liveness (`src/server/liveness.ts`, `src/server/agent-bridge.ts`).** In `livenessOfBridge`'s `probe==='alive'` branch, a new gate (`mainTurnIdleBehindLane`) reports `running:false, live:true` when a live background lane is shielding the process AND the main thread has no work in flight AND has been main-frame-silent past the frameless window. Facts come from three OPTIONAL `BridgeLike` members (`hasLiveBackgroundLane()`, `hasMainThreadWork()`, `lastMainFrameAt`) — absent ⇒ historical "alive ⇒ running" (BUG-033 guard intact). The DECISION stays in `liveness.ts` (ARCH-001). The bridge tracks a separate `lastMainFrameAt` (main-thread frames only, NOT background-lane chatter) and `#openMainToolCalls` (main-thread tool calls, excluding `run_in_background` dispatches). `live:true` ⇒ the reaper never drops it; the running-snapshot `main` row disappears so the "main running Nmin" phantom clears via the client's poll.
  - **C — client routing + honesty (`public/app.js`).** New `idleBehindBackground()` reads the server's authoritative snapshot (`turn.running:false` + a background row). `submit()` routes a typed message straight to the server (which holds+pushes it — A) instead of stranding it in `state.queue`; `applySnapshot` flushes any pre-queued items during a strand (`deliverQueuedBehindBackground`); the queue caption reads **"queued behind background work"** rather than "Claude is working". Batch/edit UX for a genuinely-running turn is unchanged.
- **Verification (scratch scripts under `~/scratch/verify-bug159-*.mjs`):** Part A real server + fake CLI **7/7** (hold-not-throw, exactly-once in==out=3, idle unchanged); Part B must-FAIL via git-HEAD dual-import **12/12** (strand reads running pre-fix, not-running post-fix; BUG-033 silent-tool-call guard preserved; provably INERT for probe=`unknown`); Part B end-to-end real server + survival **7/7** (phantom gone, not reaped, lane row persists); Part C real headless-brave review **3/3** both themes (no phantom main row; honest caption; screenshots read).
- **Regression set:** `verify-liveness-conformance` **96/96** (incl. L4 regrowth guard), `verify-bug-157-woken-turn-and-revival` **12/12**, `verify-detach` **7/7**, `verify-queue` **15/15**, `verify-feat-065-delivery` load-bearing exactly-once (engine-log + on-disk store) PASS.
- **Pre-existing / not-mine (flagged for the independent pass):** `verify-zombie-busy` **35/39** — the 4 failures are Section E (Codex approval-blocked, probe `unknown`, reaped by the FRAMELESS backstop) which is provably outside this diff (the gate lives only in the `alive` branch; dual-import shows IDENTICAL pre/post verdicts for probe `unknown`; `lastFrameAt` bump + reap path untouched). `src/server/codex-native.ts` is dirty from the concurrent reorder lane. **regressed-from:** BUG-157 round 1 (containers got a ground-truth probe in round 4, direct sessions did not).
- **Independent clean-room verify pass WARRANTED** (session-lifecycle + regression-prone, contested code): confirm the strand must-FAIL on a clean HEAD, and confirm zombie-busy Section E reproduces without this diff.

### 2026-08-27 — independent verify lane
- **round 2, class=verify (adversarial):** **Verdict per part: A CONFIRMED · B BROKEN · C BROKEN (inherits B) · the two dismissals CONFIRMED.**

  **(i) Must-FAIL re-run, once** — `node ~/scratch/verify-bug159-liveness.mjs` → **12/12**, pre-fix `running:true` / post-fix `running:false` on the strand fixture. The claim is not already false. Everything below is new work.

  **Attack 1 — the two dismissed suites, MEASURED at clean HEAD (not argued).** A clean HEAD tree was materialised read-only (`git ls-tree`+`git show` per file, no git writes, node_modules symlinked) and both suites run there:
  - `verify-zombie-busy` at HEAD: **35/39**, failing set IDENTICAL to the current tree's — the 4 Section-E approval-blocked checks (`reaping zombie session … (frameless): no output … the SDK owns this child and exposes no pid`).
  - `verify-feat-065-delivery`: **32/35 at HEAD and 32/35 on the current tree, byte-identical failing names** (S3 bounded deny; S5 renders live; S5 exactly-once in the client DOM).
  **Both dismissals CONFIRMED — pre-existing, not caused by this diff.** These two runs used NO uncommitted work at all, so the concurrent lane's dirty `session-history.ts` / `codex-native.ts` cannot be confounding them.

  **(ii) Attack 2 — the gate's FALSE-NEGATIVE direction. BROKEN, two reproductions.** New harness `~/scratch/bug159v/attack-liveness.mjs` (real server, free port, scripted fake CLI via `CLAUDE_STATION_CLAUDE_BIN` — SYNTHETIC frames, survival armed so probe='alive', `FRAMELESS_MS=4000`). 10/10 of my checks fired, i.e. every predicted defect reproduced:

  - **S2 — the stale main clock beats the fresh turn.** `mainTurnIdleBehindLane` reads `session.lastMainFrameAt ?? session.turnStartedAt` — the stamp from the PREVIOUS turn's `result` wins over `turnStartedAt`, which `send()` has just set to now. Sequence: turn 1 ends behind a live lane → dormant past the window → **the user sends** (`ack {delivered:true, queued:false}`, `busy:true`, a real fresh turn). 2.6 s later the authority reports `running:false, kind:'idle'`, no `main` row, reason *"no main-thread frame for 9s"* — 9 s measured from the previous turn. The same turn reads `running:true` the moment the CLI's first frame lands, so this is a transient lie, not a design stance. Real shape: dormancy > `FRAMELESS_MS` behind a lane is the ticket's own scenario; the window is however long the CLI takes to first frame (hook, MCP init, backoff), which Orchard does not bound. Suggested repair: `Math.max(lastMainFrameAt ?? 0, turnStartedAt ?? 0)`.
  - **S3 — a genuinely running main turn declared idle.** Same run: the turn speaks, then goes frame-silent past the window with NO open main-thread tool call (`hasMainThreadWork()` false — the BUG-033 guard only covers an OPEN `tool_use`). Observed `busy:true, running:false, main row gone`, reason *"no main-thread frame for 7s"* — and then **the turn completed normally**, proving it was running throughout. A main turn can be frame-silent with no open tool call (API 429/529 backoff, long non-streamed generation, a slow prompt hook); the sibling-ticket datum that a live 7-minute call yields two frames then silence is the same failure family. The gate does not reap (`live:true` held), so this is an honesty defect, not data loss — but it is the phantom inverted, and success criterion 4 ("the indicator reflects real main-thread state") is not met in this direction.

  **(ii) Attack 5 — the client acts on B's error. BROKEN by inheritance.** The SHIPPED `idleBehindBackground()` was extracted from `public/app.js` and evaluated against the snapshot my S3 run actually observed (`{turn:{running:false}, running:[{row:'agent'}]}`) → **true** (`~/scratch/bug159v/attack-client.mjs`). So while a real turn runs the tab captions *"queued behind background work — the idle session delivers it at the next pause"*, and `deliverQueuedBehindBackground()` (guard `state.busy && idleBehindBackground()`, both true) ships the user's staged batch mid-turn and empties `state.queue`, taking the edit/discard affordance with it. Not destructive to delivery (see below), but it is the batch-at-the-next-pause contract broken without the user's say-so.

  **(ii) Attack 3 — exactly-once under a race. Part A CONFIRMED.** From inside S3's mis-declared-idle window: two sends in flight while the CLI was genuinely mid-turn, plus one fired to race the turn boundary, on top of the earlier fresh-turn send. Counted on the fake CLI's own stdin log: `{S2:1, A:1, B:1, C:1}` — **in==out==4, no duplicate, no drop**; the busy sends acked `{delivered:true, queued:true}`, the idle one `{queued:false}` (nothing-pending path unchanged). A boundary and a send-time push racing did not double-deliver.

  **Attack 4 — optional-member fallback.** The "has the clock but it is stale" hazard is real and is exactly S2. `#bgBornTasks` (the other half of the shield) was code-read: it is cleared per task id on any terminal frame (`task_updated` terminal / `task_notification`) and wholesale on any level frame, so the shield does not stick on after a lane finishes — blast radius stays "sessions with a genuinely live lane".

  **(iii) Could not test.** (a) A REAL claude CLI — every frame above is synthetic through the fake-CLI seam, so how often a real main turn is frame-silent past 600 s with no open tool call is unmeasured; S3's realism rests on the mechanism, not on a measured real turn. (b) Container sessions (different probe path) — direct/systemd-survival only. (c) The browser-side flush race (`deliverQueuedBehindBackground` vs `flushQueue` on `turn-end`) was code-read, not run in a browser: the flush removes items from `state.queue` synchronously before the ws send, so a duplicate needs a reentrant path I did not find — but that is a reading, not a measurement. (d) A third-party `BridgeLike` with only 2 of the 3 optional members. (e) Attribution note: the attack harness ran on the full dirty tree; the defect is emitted by this diff's own reason string from `liveness.ts`, and the two regression suites were run at clean HEAD, so the concurrent lane's dirty files are excluded as a cause of anything reported here.

  **Bar for a round 3:** S2 needs the max() of the two clocks (and arguably a rule that a turn opened by an explicit `send()` is never downgraded before its first frame); S3 needs a positive signal that the main thread is NOT working rather than the absence of one. Part A and the regression dismissals need no further work.
