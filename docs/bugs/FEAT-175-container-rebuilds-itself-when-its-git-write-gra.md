```orchard-ticket
{
  "id": "FEAT-175",
  "type": "feature",
  "title": "Container rebuilds itself when its git-write grant changes",
  "summary": "A container project whose git-write grant is granted, expires or is revoked has its container recreated automatically at the first moment no session has work in flight; new turns and starts are held and typed messages queue in the outbox meanwhile.",
  "impact_if_we_wait": "Timed and once git-write grants do nothing in container projects (BUG-244), and a revoke leaves the container writable until someone presses Rebuild.",
  "current_need": "Build the idle-gated grant rebuild with outbox holds and prove it on a scratch server and the sandbox daemon.",
  "severity": "high",
  "area": "container lifecycle, git grants, outbox",
  "reported": "2026-10-11",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-12",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A grant during a live turn never recreates the container until every session of the project is idle, then recreates it; must-FAIL on HEAD.",
    "Messages typed while a grant rebuild is pending or running are delivered after it, in order, none lost.",
    "A session start during a grant rebuild waits for it.",
    "A timed grant expiring with work in flight flips the container back to read-only after idle; the over-run is logged and surfaced after 10 minutes.",
    "A failed rebuild loses no queued input and is surfaced on Needs-You."
  ],
  "code_refs": [
    {
      "path": "src/server/grant-rebuild.ts"
    },
    {
      "path": "src/server/container-manager.ts"
    },
    {
      "path": "src/server/index.ts"
    }
  ],
  "related": [
    {
      "id": "BUG-244",
      "relation": "see_also"
    },
    {
      "id": "BUG-214",
      "relation": "see_also"
    },
    {
      "id": "FEAT-160",
      "relation": "see_also"
    },
    {
      "id": "BUG-217",
      "relation": "see_also"
    },
    {
      "id": "BUG-231",
      "relation": "see_also"
    },
    {
      "id": "FEAT-154",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a12c5b-75da-7232-bbd2-e09f8f2ca632",
      "verdict": "broken",
      "verdict_on": "2026-10-11",
      "recorded_at": "2026-10-11T19:07:34.577Z",
      "author": "verify lane (openai)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "(1) a docker read error on the tick that sees a grant change consumes the change: no pending, no hold, drift left; (2) drive re-reads the session list after the async lifetime checks and reaps a session added meanwhile without checking its lifetime (recreate force=false)."
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a12c66-13ee-7901-a8ec-fb3a95e065c8",
      "verdict": "broken",
      "verdict_on": "2026-10-11",
      "recorded_at": "2026-10-11T19:19:29.400Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "ff3d04bc1464fc6fa66759dc9ed2553c8d1a805ee8a86979565775e7dafc534b",
      "note": "(1) a listProjects throw in evaluate after lastFp advanced consumes a revoke: no pending/hold, drift left. (2) restart with persisted tightening pending + docker unreadable: no hold. Two-break STOP (prop 3). (3) legacy permanent rw: stale requirement, not a defect."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "1d4639a9-e6a3-4d9e-b025-9a5995dd4baa",
      "verdict": "broken",
      "verdict_on": "2026-10-11",
      "recorded_at": "2026-10-11T23:26:52.943Z",
      "author": "verify lane (anthropic; openai quota)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "VALID. P1: a refused Rebuild-now latches forceRequested (cleared only in rebuild finally); next drive force-recreates over a later live turn (cutMidTurn); a later non-force Retry doesn't clear it; refusal invisible. Fixer e2e exit 0. Group 9023f682c49c, scratch freeze."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "590cfd13-509a-49a0-968a-40f7d9a72c98",
      "verdict": "holds",
      "verdict_on": "2026-10-12",
      "recorded_at": "2026-10-12T10:19:13.690Z",
      "author": "verify lane (anthropic; openai quota)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "VALID. Fixer e2e exit 0; adversarial reconciler 35/0, P4 wiring 20/0, outbox 12/0. Group 4cfb5bbfe35e (47 files) scratch freeze. Open lead, inadmissible (harness killed): closeLifetime probed once per pass, not re-read after later awaits."
    }
  ],
  "verification_class": "plan+review",
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

# FEAT-175 — Container rebuilds itself when its git-write grant changes

## Problem

BUG-244 made a real repo's `.git` read-only inside a container unless the project holds the PERMANENT git-write grant. Mounts are fixed when a container is created, and a `gitguard:` drift is informational only (never recreates), so 30-minute and once grants stopped working in container projects, and a grant or revoke only applies at the next natural recreate or a manual Rebuild.

User expectation (verbatim): "we have the ability to add mounts to a container already; my expectation would be that it just rebuilds automatically whenever no session is in flight and doesn't allow session start in the meantime; [the user] can type but messages are not processed yet, only saved as inputs, just during the time it rebuilds; we even have forking so this should be easy."

Dispatch class: plan+review (stateful / concurrent / recreate: BUG-214 class).

## Plan (round 1)

**Invariants.**
- I1 (converge): a container project's `.git` mount follows its CURRENT effective grant (permanent OR a live timed/once grant, under BUG-244's cross-project rule). It is applied automatically at the first moment no session of that project has work in flight.
- I2 (never under live work, BUG-214): a grant-driven recreate runs only when every lease of the project is `attached` to a live session that is not busy, has `working === false` (FEAT-154/BUG-237 verdict), has `closeLifetime() === 'no'`, and has no delivery or resume in flight. Nothing is ever force-killed automatically.
- I3 (no lost input): while a grant rebuild is pending, running or failed, no new turn or new session starts on the project. Every message typed meanwhile is persisted in the existing outbox journal and delivered afterwards, in order, exactly once. A failure drops nothing.

**What exists today (surveyed).**
- A mount change only produces drift. It applies at the next admission with no lease, or on Rebuild (`doEnsure`, `rebuildContainer`). There is no scheduler and no settings or grant event.
- FEAT-160's account switch already reaps an idle session and resumes the SAME session id from its transcript: it checks `busy`, `closeLifetime`, `deliveryInFlight` and `resumeStarting`, takes a reservation token, then calls `close()`. A container store dir is bind-mounted from the host, so a plain `--resume` works on a new container and no fork is needed.
- The outbox (BUG-217) is a durable journal with `probe -> wait(hold)` and `resume` delivery. The client already queues a send that is refused with `retryable:true`.

**Design.**
1. **Effective grant into the guard.** `gitGuardOn(p)` = not (permanent OR a live timed grant). The timed half comes from an injected read-only source `setTimedGrantSource(fn)` in container-manager.ts. index.ts wires it to `grantView(id)` with scope != permanent. The git-grant store is NOT edited (another lane owns it). With no source set (harness, other processes), the answer is permanent only, so it fails closed. A container whose binds were unlocked by a timed grant gets a create-time label `claude-station.git-write-timed=1`, because timed grants die with the server process.
2. **Reconciler `src/server/grant-rebuild.ts`**, dependency-injected from index.ts:
   - **Detection.** A 2 s tick computes each project's grant fingerprint (`perm` | `timed` | `none`). The grant routes also nudge it immediately: POST/DELETE git-write-grant, and approving a request. Expiry is detected within the tick, because the store expires grants lazily.
   - **Pending.** On a fingerprint change, at boot, or from the persisted pending set, each container project with an existing container is checked for `gitguard:`/`gitguard-lapsed:` drift (`cm.statusOf`). It becomes PENDING when that drift is non-empty AND one of these holds:
     - its guard-drift signature changed since the last check;
     - its own fingerprint changed;
     - at boot, the container carries the timed label;
     - it was pending before a restart (`<data>/grant-rebuild.json`).
     A legacy container with unrelated pre-existing drift is therefore not churned by another project's grant change.
   - **Idle.** While pending, an idle check runs every 1 s (I2). The synchronous predicates are re-checked in the same tick as the reap, after the async `closeLifetime`.
   - **Rebuild.**
     1. Take `deliveryInFlight` tokens for every session of the project.
     2. `close()` each session with `resumable: true` (FEAT-160 pattern).
     3. Call `cm.recreateContainer(project, { forceOver: <captured lease ids>, current })`. This is new: `rebuildContainer` without the forced image build, i.e. `inOp('rebuild')` -> `clearForDestroy` -> `ensureInOp(forceRecreate)` -> service rejoin. `clearForDestroy` still refuses any lease that was not captured.
     4. Release the tokens, clear the state, and nudge the outbox pump. Queued rows resume their sessions in order. Waiting starts proceed.
   - **Cancel.** If the drift disappears while pending (grant flipped back, user Rebuild), the state clears.
   - **Failure.** The state becomes `failed` with the error. The holds stay. It retries with backoff (30 s, 60 s, 120 s, then every 300 s). A Needs-You card appears with "Retry now". Outbox rows are never touched.
3. **Holds (existing machinery).**
   - WS `send` to a session that is NOT busy: a retryable refusal `{of:'send', sendId, retryable:true, code:'rebuild-hold'}`. The client's existing `queueRefusedSend` puts it in the outbox. A send into a busy session (an interjection into work already in flight) passes.
   - outbox `probe`: `wait('rebuild', text, 1000)` unless the bridge is busy.
   - WS `start` with `resumeSessionId`: a retryable refusal, so the client's `queueRetryableRefusal` puts it in the outbox.
   - `startSessionAdmitting` (the chokepoint every container start passes) awaits the gate before `admitContainer` and emits status lines. In the failed state it throws a retryable error, and the client returns the text to the composer.
   - Client: during a pending start, `status` is shown instead of being swallowed. `session-closed{resumable}` re-arms `resumeOnNextSend` the same way as FEAT-160's `finishAccountSwitch`.
4. **Expiry and writes during the window (decided on evidence).**
   - **Evidence:** 3,000 sampled transcripts, 4,282 turns. Ordinary turns: p50 1.6 min, p95 26 min. Agent-using turns, measured to the last subagent line: p50 17 min, p90 101 min, p95 about 3.4 h. Waiting for idle can therefore leave the mount writable for hours.
   - **Decision:**
     - From the expiry tick, every NEW turn and start is held. Only work already in flight continues.
     - For Claude sessions, the FEAT-108 PreToolUse hook runs host-side and reads the store live, so recognised git writes are denied from the instant of expiry. Over-run exposure is limited to forms that bypass the classifier, and to Codex container sessions, which have no hook.
     - Each over-run is logged at start and at apply, with `waitedMs`, to the console and `<data>/grant-rebuild.log.jsonl`.
     - After 10 min of read-only pending, a Needs-You card says "git writes still possible in <project>: grant ended Xm ago, <session> still working". It offers "Stop that work and apply now", which force-closes those sessions and runs the same recreate.
     - It is never forced automatically: BUG-214 outranks the bound, and the user decides.
5. **UI.**
   - A line in the drawer's container block for pending, rebuilding or failed, plus who it waits on.
   - Outbox dock wording for hold kind `rebuild`.
   - Status text for a start that is waiting.
   - A Needs-You card for failed and over-run, with actions via `POST /api/projects/:id/container/grant-rebuild {force?}`.

**Failure modes considered.**
- A turn starts between the idle check and the reap: the holds refuse it, the check and the reap share one synchronous tick, and the tokens block outbox delivery.
- An admission races the rebuild: the gate holds new starts. A start already past the gate leaves a `reserved` lease, which fails the idle predicate. `clearForDestroy` refuses any uncaptured lease, which surfaces as `failed`, and the rebuild retries.
- A restart while pending: the persisted pending set and the timed label cover it.
- A restart mid-recreate: no container, so the next admission creates one with the desired binds.
- `docker create` fails: `failed` state, holds kept, card shown, retry.
- A drift that a recreate cannot clear: the signature is unchanged after a successful rebuild, so it does not re-pend (no loop).
- Grant flapping: each transition re-evaluates, the rebuild still only runs at idle, and there is no loop.

**Coordination.** `scripts/lib/git-grant-store.mjs`, `git-grant.mjs`, `git-shim.mjs` and the candidate/shadow files are untouched; this ticket only reads `grantView`. A once grant consumed by a hook claim whose in-container write then fails EROFS (rebuild still pending) is a once-semantics question for BUG-231. It is recorded there, not fixed here.

**Migration.**
- It takes effect after an Orchard restart.
- On first boot, existing containers with guard drift but no timed label and no persisted pending keep BUG-244 behaviour (baseline, no action).
- No data migration.
- Rollback: revert the files. The pending file is ignored.

**Proof bar.** Persistent suite `scripts/verify-feat-175-grant-rebuild.mjs` (number per filing): a scratch server, the sandbox Docker daemon only (`assertIsolatedDocker`), a fake CLI through `ORCHARD_TEST_CONTAINER_CLI`, and the real WS/outbox paths. Each P must FAIL on HEAD.
- **P1:** a permanent grant during a live (fake sleeping) turn. The container id is unchanged while busy and `.git` stays EROFS. After the turn ends it is recreated and `.git` is writable.
- **P2:** messages typed during pending/rebuild. Three sends (idle session plus outbox) are held. After the rebuild they are delivered in order, exactly once.
- **P3:** a fresh session start during pending/rebuild gets no lease and no session-init until the rebuild is done, then runs on the new container.
- **P4:** a timed grant makes the container rw. When it expires with a turn in flight, the over-run is logged. After idle, the container is recreated read-only.
- **P5:** a failed rebuild (the docker shim fails `create` once). The state is `failed`, the Needs-You card is present, the outbox rows are still queued, the retry succeeds, and the rows are delivered.
- Unit tests for the reconciler decisions: the idle predicate, the arming rule, and no churn of legacy drift.
- A Playwright screenshot of the drawer line, dock and card on the scratch server.
- Regression: BUG-244, BUG-214/218, the outbox suites; then `npm run gate`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-11 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-11 — fixing lane r1
- **plan review + revision:** **plan review + revision (round 1b).** OpenAI quota-window refused the review (thread 01a12b25-5041-7f10-892b-68e0ad018931, "usage limit … try again at 8:26 PM"), so it went to a separate Claude Opus process via scripts/dispatch.mjs --provider anthropic. Verdict: UNSOUND, 2 blockers, 4 majors, 3 minors. All accepted. Changes:
  - **B1 (freeze).** Holds now depend on direction.
    - Toward MORE access (grant): nothing is held while pending; holds apply only while `rebuilding`.
    - Toward LESS access (revoke or expiry): new turns and starts are held while pending.
    - Blockers are classified: turn, agent, shell, unknown, lease. A shell (dev server or poll loop), a Codex `unknown`, or a lease that is not an idle attached session (draining, orphan, reserved for more than 60 s) gets a Needs-You card IMMEDIATELY. The card names the blocker and offers "Rebuild now (stops it)".
    - A main turn or a background agent gets the card after 10 min, and only in the read-only direction.
    - Shells block the automatic rebuild. That is stricter than the FEAT-154 working fact on purpose: never kill a dev server silently.
  - **B2 (once grants).** Once grants are EXCLUDED. Only permanent and duration grants switch the mount. A once grant would be spent by the EROFS attempt and cost two recreates with no write. The grant route's response for a container project says so (`containerNote`). Host-side execution for once grants is out of scope (a mount cannot express "one write").
  - **M3 (no kills).** The automatic path never uses `forceOver`. It closes the idle sessions, waits up to 30 s for their leases to release on their own, then runs `recreateContainer` without `forceOver`. If `clearForDestroy` still refuses with `live-sessions`, it goes back to pending with the lease named on the card. `forceOver` is used only by the user's explicit "Rebuild now".
  - **M4 (structural hold).** ONE chokepoint: `AgentSession.send` and `sendGated` consult a turn-hold source (`setTurnHold`) and throw or refuse `{retryable, code:'rebuild-hold'}`. `startSessionAdmitting` is the start chokepoint. Callers adapted:
    - WS send already forwards retryable refusals to the client's queue.
    - outbox handOver maps `rebuild-hold` to hold kind `rebuild`. The outbox resume route treats `rebuild-hold` as a refusal, NOT one of the 3 strikes; this defect was found while revising.
    - The probe waits with `rebuild` so rows never burn retries.
    - The autonomous nudge reschedules instead of `stopAutonomous('error')`.
    - A decision answer is enqueued into the session's outbox instead of `delivered:false`.
    - Reattach-with-prompt returns a retryable error.
    Interjections into a busy session are held too in the read-only direction, because they would run as a new turn at the next boundary.
  - **M5 (waiting start).** A fresh start waits at the gate, re-checking every 1 s, and ABORTS before `admitContainer` if its socket closed, so nothing runs unseen. In `failed` it errors and the client returns the text to the composer.
  - **M6 (corrections).**
    - A `gitguard:` drift alone never recreates, even with no lease. The survey line was wrong.
    - `close()` gains `{resumable}` and `session-closed` carries it, and the client re-arms `resumeOnNextSend`.
    - A WS send on a bridge that was reaped by the rebuild returns a retryable `rebuild-hold`, so the client queues it into the outbox, which resumes the session.
  - **m7.** The cause is named on the card and in the log, including another project Q's grant. The timed label lists every live timed project.
  - **m8.** A refusal that leaves the container intact goes back to `pending` with the error, not `failed`. `failed` (holds kept, retry with backoff) only applies when the container is gone or half-created.
  - **m9.** The status text says the recreate also applies any pending image change.
  - **Proof bar adds:**
    - P6: a background shell gets an immediate card, not a silent freeze, and a grant holds nothing while pending.
    - P7: the chokepoint holds send, sendGated, the autonomous nudge and a decision answer after expiry.
    - P8: a once grant causes no recreate.
    - P9: a socket closing during a waiting start runs nothing.
    - P10: the automatic reap sends no TERM/KILL (`forceOver` unused).

### 2026-10-11 — worker (FEAT-164 fixing)
- **Note:** Coordination from FEAT-164 (fixing, 2026-10-11). The settings.gitWrite shape changes to { commit, push, scope, release, grantedAt, grantedVia }. The legacy { permanent:true } is still read; new saves never write `permanent`. The ONE rule is normalizeGitWrite(raw).mode from scripts/lib/agent-git-policy.mjs, one of 'none' | 'scoped' | 'release'. Only mode 'scoped' (commit granted plus a user scope note) opens the real .git for direct agent writes. Release mode (commit with no note, which includes the legacy permanent) keeps the container .git READ-ONLY, because releases are cut on the host. Two lines in YOUR files key on `.permanent === true` and will go stale: (1) container-manager.ts gitGuardOn; (2) index.ts ~4530, grant-rebuild `fingerprint` (`'perm'`). Requested: replace both with `normalizeGitWrite(settings.gitWrite).mode === 'scoped'`. I will add an exported `standingGitWriteOpen(project)` in container-manager.ts for that, next to gitGuardOn, once your file lock frees; the fingerprint should then call cm.standingGitWriteOpen(p). Also, timed grants: FEAT-164's real-repo guard lets a live timed/once grant lift direct COMMITS in release mode, which matches your timed→rw container rule. Pushes to a real remote still need scoped plus push.

### 2026-10-11 — worker (FEAT-164 fixing r2)
- **Note:** REQUEST from FEAT-164 fix round (verify adb2b039 P4, coordinator-directed): gitGuardOn in container-manager.ts still keys on settings.gitWrite.permanent === true. A SAVED scoped grant, or a saved migrated one, therefore gets a read-only .git. Your FEAT-129 lock has held the file all session; I have not forced it. Please apply this grant-model-check-only change (about 6 lines; the normalizeGitWrite import is already present): ~/.local/state/claude-station/scratch/feat164-release/gitGuardOn.patch. I already changed your grant-rebuild fingerprint at index.ts (~4678) to the same rule (normalizeGitWrite(...).mode === 'scoped' → 'perm'), so a rebuild fires when a container's .git should flip. The proof waiting on your change: scripts/verify-feat-164-release.mjs K1 (it fails now, passes once applied). Or release the lock briefly and FEAT-164 applies it.

### 2026-10-11 — fixing lane r1
- **FEAT-164 grant model applied:** Applied FEAT-164's grant-model patch at the coordinator's direction. container-manager.ts: gitGuardOn now reads the exported standingGitWriteOpen(project), which is normalizeGitWrite(settings.gitWrite).mode === 'scoped'. A live duration grant still opens it as before. index.ts: the grant-rebuild fingerprint now calls cm.standingGitWriteOpen too (one rule), replacing FEAT-164's inline copy, so a rebuild fires exactly when the container's .git answer flips. That includes a scoped policy PUT, and also a DELETE or the legacy permanent path. Release mode, including legacy {permanent:true}, keeps the container .git read-only. containerGrantNote is now decided from gitGuardOn on the re-read project, not from the scope name, so a release-mode grant is told honestly that it does not open the container. New required e2e proof (sent to the suite builder): P1s, a SCOPED grant gets rw .git after the idle rebuild, plus control P1r, a release-mode grant causes no recreate and .git stays read-only. Unit 43/0 and typecheck clean after the change.

### 2026-10-11 — fixing lane r1
- **built + proofs:** **built + proofs (fixing lane r1, resumed after the 429 stop).**
  - **Ground truth on resume.** The e2e worker was dead (no process). Its suite and screenshots were on disk, and the gitGuardOn patch was already applied. I finished the suite inline: added P3/P9, P4, P5 and P6, and fixed three fixture bugs (P4 parsed the ISO expiresAt as a number; P4 read the log before 'applied' was written; P6 raced its own blocker).
  - **Proofs.** All on the scratch server plus the sandbox daemon only.
    - Unit `scripts/verify-feat-175-grant-rebuild-unit.mjs`: 43/0.
    - E2E `scripts/verify-feat-175-grant-rebuild.mjs`, working tree: full run 36 PASS. Its 4 FAILs were all fixture bugs; after the fixes P4 4/0 and P6 2/0.
      - P1s (scoped grant during a live turn: no recreate while busy, then rw)
      - P1r (release mode: no recreate)
      - PCORE (revoke while busy: 3 WS sends refused rebuild-hold, 4 outbox rows held then delivered in order exactly once, after the new container started; over-run logged)
      - P3 (a fresh start waits, then runs on the new container)
      - P9 (an abandoned waiting start runs nothing)
      - P4 (a real duration expiry with the turn in flight: pending, then read-only after idle, overrunMs logged)
      - P5 (injected create failure: failed, Needs-You card, rows still queued, retry delivers in order)
      - P6 (loosening holds nothing)
      - P8 (once grant: containerNote, no recreate)
      - Screenshots (drawer line and Needs-You card, light and dark, /tmp/feat175-shots)
    - Must-FAIL on the HEAD 1a68e57 export (F175_REBUILD_WAIT_MS=45000): 12 passed, 25 failed. The core checks of P1s, P3, P9, P4 and P5 all FAIL.
  - **Regression.**
    - FEAT-160 46/0; FEAT-160 survivor-drain 8/8.
    - BUG-191: the first run was 37/39 (B1 adopt-window); the re-run was 39/39. Flaky; B1 passes on HEAD.
    - BUG-217: 72/2 on both the working tree and HEAD. The same N check fails on both; the other failure differs (A on the tree vs B/J on HEAD). Pre-existing, not FEAT-175.
  - **Visual review.** The drawer line reads clearly. The rail tile showed the raw id `grant-rebuild:<project>`, now labelled "Container · git grant" (app.js, same as the base notice).
  - **Gate.** `npm run gate` PASS; typecheck clean.
  - **Restart.** Needs an Orchard restart to load; not done. Never restart mid-flight.

### 2026-10-11 — verify lane (openai)
- **Verification recorded:** dispatch openai run 01a12c5b-75da-7232-bbd2-e09f8f2ca632 — VERDICT: BROKEN — (1) a docker read error on the tick that sees a grant change consumes the change: no pending, no hold, drift left; (2) drive re-reads the session list after the async lifetime checks and reaps a session added meanwhile without checking its lifetime (recreate force=false).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-11 — fixing lane r1
- **fix round 1:** Fix round after IV BROKEN (openai run 01a12c5b-75da-7232-bbd2-e09f8f2ca632). This was the one allowed round; the two findings broke different properties, so it is not a two-break. (1) A change is never consumed by a project that could not be evaluated. A per-project carry ('unevaluated') keeps the unseen grant changes and any owed boot check across docker read errors AND across a mid-rebuild skip, which is the same hole the IV missed, and it is re-evaluated every tick until read. Persisted pending entries are consumed only by the evaluation that read them. (2) drive refuses to reap any session that was not in the set whose closeLifetime was checked; such a session is asked on the next tick. Proof: unit 48/0; the mutant with both fixes disabled FAILS U14, U14b and U15 (44/4). E2E subset P1s, PCORE, P5, P6 is 24/0 on the fixed tree. Gate PASS. The fix is author-tested only: the charter allows one independent verify, so a re-verify of this fix round is owed if the orchestrator wants it. Needs an Orchard restart to load (not done).

### 2026-10-11 — dispatch openai
- **Verification recorded:** dispatch openai run 01a12c66-13ee-7901-a8ec-fb3a95e065c8 — VERDICT: BROKEN — (1) a listProjects throw in evaluate after lastFp advanced consumes a revoke: no pending/hold, drift left. (2) restart with persisted tightening pending + docker unreadable: no hold. Two-break STOP (prop 3). (3) legacy permanent rw: stale requirement, not a defect.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-11 — fixing lane r2
- **r2 redesign built:** **r2 REDESIGN built (after re-verify BROKEN, openai run 01a12c66-13ee-7901-a8ec-fb3a95e065c8, two-break on property 3; adjudicated REDESIGN).**
  - **Design.** Level-based over two declared facts.
    - DESIRED is `cm.desiredGitMode(project)`, read live. It is rw only under a scoped standing grant or a live duration grant. Any read failure gives unknown.
    - ACTUAL comes from the `claude-station.git-mode` label that every create writes; it is reported SYNCHRONOUSLY via `cm.onContainerGitMode` from createAndStart, or from swap after the rename. The cache starts unknown, and any docker or registry error resets it to unknown. Legacy containers without the label derive it from their guard drift.
    - Hold = phase in {rebuilding, failed} OR (desired != rw AND actual not in {ro, none}). It is read at `AgentSession.send/sendGated` (container projects only; a throwing source HOLDS), at `startSessionAdmitting` and at the outbox probe (fails closed when isolation is unreadable).
    - Reconcile = recreate whenever desired != actual, both known, once idle. Idle rules, reap, no-forceOver and failure backoff are unchanged.
    - Cards: failed; stray blocker; read-only over-run past 10 min; actual unknown for more than 2 min.
  - **Deleted:** fingerprints (lastFp), change sets, the unevaluated carry, drift signatures, the stateFile pending persistence, and cause inference.
  - **Also fixed:** `request()` armed force after the tick had already started a non-forced drive, so a forced drive never ran (found by unit B3).
  - **Proofs.** Scratch server plus sandbox only.
    - Unit `verify-feat-175-grant-rebuild-unit.mjs`: 43/0 on r2. With `--tree <r1 snapshot> --r1`, through an adapter mapping the same world onto the r1 API: 28/15, and every new property's core check FAILS. Covered: RF1 listProjects read failure after a revoke; RF2 policy read; RF3 inspect plus the 2-min card; RF4 post-recreate read failure; RS1 restart with a revoke pending; RS2 restart plus docker unreadable; RS3 expiry while down (held before the first read).
    - E2E `verify-feat-175-grant-rebuild.mjs`: 54/0 on r2. All earlier properties hold, plus PD1 (docker unreadable during a revoke: send held, never delivered to the rw container, card after 2 min, delivered once after the ro rebuild), PR1 (restart with a revoke pending plus docker unreadable at boot: held; the first start runs only on the ro container) and PE1 (expiry while down). Held messages are delivered in order, exactly once (PCORE, PD1, P5).
    - Must-FAIL e2e on the r1 tree: PD1 and PR1 core checks FAIL (7/6). PE1 passes on r1 too; its must-FAIL is unit RS3.
  - **Suite hardening.**
    - The shim's injected-inspect newline escape is fixed.
    - A watchdog kills the scratch server if the suite dies. The previous re-verify had leaked one, holding the sandbox lock for about 40 min; I stopped that orphan, which my own suite's data dir owned.
    - A SIGTERM/SIGINT handler now runs cleanup.
  - **Regression and gate:** FEAT-160 46/0; BUG-191 39/39. `npm run gate` PASS; typecheck clean.
  - **NEXT VERIFY needs `--max-diff-bytes 520000`** (the working-tree diff is large).
  - **Restart:** needs an Orchard restart to load (not done).

### 2026-10-11 — verify lane (anthropic; openai quota)
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 1d4639a9-e6a3-4d9e-b025-9a5995dd4baa — VERDICT: BROKEN — VALID. P1: a refused Rebuild-now latches forceRequested (cleared only in rebuild finally); next drive force-recreates over a later live turn (cutMidTurn); a later non-force Retry doesn't clear it; refusal invisible. Fixer e2e exit 0. Group 9023f682c49c, scratch freeze.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-11 — fixing lane r3
- **one-shot force:** Fix for group verify BROKEN on property 1 (run 1d4639a9-e6a3-4d9e-b025-9a5995dd4baa): a refused 'Rebuild now' stayed armed (entry.forceRequested), and a later pass force-recreated the container mid-turn; Retry did not disarm it. STRUCTURAL: forceRequested is deleted. A force is a one-shot ForcePress, an argument of exactly ONE drive pass and never stored. It carries the press time and, per live session, the turn it was running (turnKey = turnStartedAt). It is re-validated at the synchronous final check: a press is DROPPED if it is older than 30 s, a session started after the press, or a session runs a different turn than the one at the press. Every outcome of that pass decides it exactly once (refused / dropped / recreating / nothing to do) and goes back to the user: the route returns {ok, outcome}, the card says it. A press while a pass is running is refused, not queued. Retry is a separate path that cannot carry a force. Proof, unit (scripts/verify-feat-175-grant-rebuild-unit.mjs): 48/0. On the pre-fix module (/tmp snapshot) F1 (refused, then a turn starts: no recreate) and F2 (refused, then Retry: no force) FAIL; there the armed force recreated over the new turn (closed:true). F3 (idle press recreates with force=true) passes on both as the control. F4 (the turn changes between press and execution: dropped, user told) is new. E2E 54/0 (SHOTS exercises the forced press). Gate PASS. agent-bridge.ts was not edited in this round. The next verify still needs --max-diff-bytes 520000. Needs an Orchard restart (not done).

### 2026-10-12 — verify lane (anthropic; openai quota)
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 590cfd13-509a-49a0-968a-40f7d9a72c98 — VERDICT: HOLDS — VALID. Fixer e2e exit 0; adversarial reconciler 35/0, P4 wiring 20/0, outbox 12/0. Group 4cfb5bbfe35e (47 files) scratch freeze. Open lead, inadmissible (harness killed): closeLifetime probed once per pass, not re-read after later awaits.. Typed entry in the record's verification[]; this line is an echo, not proof.
