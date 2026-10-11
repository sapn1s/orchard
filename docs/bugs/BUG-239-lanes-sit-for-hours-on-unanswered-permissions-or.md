```orchard-ticket
{
  "id": "BUG-239",
  "type": "bug",
  "title": "Lanes sit for hours on unanswered permissions or lose their background runs",
  "summary": "A lane asking permission waited up to 21 hours, because nothing ends or escalates an unanswered card. A lane that ends its turn while its own background run is still going loses that run: the tool kills it. Today an OpenAI review was lost that way and had to be re-run.",
  "impact_if_we_wait": "Lanes keep stalling for hours on cards nobody sees, and finished background reviews and test runs keep vanishing and being paid for twice. Bounded: no data loss and no unwanted approvals; the cost is wall-clock time and repeated runs.",
  "current_need": "Ship the permission deadline and the end-of-turn guard, prove each fails before and passes after, and get an independent cross-provider verification.",
  "severity": "high",
  "area": "Lane permissions and turn end",
  "reported": "2026-10-07",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-07",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "An unanswered permission card from a lane is escalated to the Needs-You rail after a few minutes",
    "An unanswered lane card is refused, never approved, after its deadline, and the refusal is visible on the rail",
    "A lane cannot end its turn while a background run it started is still going, unless it stops it or ignores the guard repeatedly",
    "Every Orchard project gets both with no per-project setup",
    "Each guarantee has a recorded test that fails on the old code and passes on the new"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-187",
      "relation": "see_also"
    },
    {
      "id": "BUG-046",
      "relation": "see_also"
    },
    {
      "id": "FEAT-111",
      "relation": "see_also"
    },
    {
      "id": "BUG-140",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "d8d016bd-8e6b-4103-b0ef-9cf49ef80add",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T11:29:50.877Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "fad7e757739ca1971e3070b8a24fd05363281768d2156b04ebd57e57fff6ecdf"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "65bea06e-043c-44de-b7e4-dc822194f897",
      "verdict": "holds",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T12:44:06.212Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "8d6863e11f87208e9fc13c0ec13f42af5c90aca0c0df1028291c8985e118fb18"
    }
  ],
  "verification_class": "plan+review",
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

# BUG-239 — Lanes sit for hours on unanswered permissions or lose their background runs

## Diagnosis

Two separate root causes, both confirmed from transcripts and the bundled CLI (2.1.281, SDK 0.3.281).

**(A) A permission card has no deadline.** Five of the eight longest lane hangs on record were a subagent lane's permission card that nobody answered (an Edit waited 1,271 min; a Bash 969 min, then died on a restart). The request settled only on an answer, an abort or a session close. The BUG-187 request floor deliberately never refuses a card an attached client owns. Nothing escalated: the only signal was an amber dot. The other three long hangs were the "PreToolUse hook did not respond" message. Those already had a deadline (the CLI's 600 s, which stops counting while the machine sleeps), and their real cause was BUG-187's no-responder loop, fixed on 2026-09-24. There have been none since.

**(B) A lane that ends its turn loses the background run it started.** When a foreground (synchronous) lane hands back, the CLI kills that lane's running background shells and Monitors. Background lanes are parked rather than killed, and a nested background agent's result goes to the orchestrator instead of the lane. The CLI's own text steers lanes into the trap. It says a background command "is terminated when you give your final response", and it rejects `sleep` with "use Monitor", which is killed the same way. BUG-046 had answered this with charter wording only.

## Evidence

- Hang census (read-only lane, scratch `hang-trace-2026-10-07/`): 14 tool calls over 15 min. Of the top 8 (5,834 wall-min), 5 were unanswered permission cards (at least ~2,378 awake min) and 3 were 600 s hook timeouts stretched by suspend. There were 131 hook-timeout results, each about 600 s, and none after 2026-09-24. The study's "machine down" interval for 09-15 to 09-21 was a journal gap, not real downtime.
- Parking census (scratch `park-trace-2026-10-07/`): 1,485 lane transcripts. 157 ended with an unharvested child; 39 of those said they would wait. In the last 7 days: 22 and 7. Today: 6 and 3. All 13 surviving output files of foreground lanes end in `[killed]`. Today's lost OpenAI review stopped writing within 1 ms of its lane's hand-back.
- The CLI kill: `killShellTasksForAgent` and the `nonShellMonitors` cleanup step in the bundled binary. They run after the `SubagentStop` hook, so blocking that hook prevents the kill.

## Implementation notes

Both fixes live in the server, so every project Orchard runs gets them with no per-project setup. A freshly registered project gets them on its first session.

- **Permission deadline** (`src/server/approval-deadline.ts`, `agent-bridge.ts` permission callback): every card escalates after 5 min (`CLAUDE_STATION_APPROVAL_ESCALATE_MS`). It then shows on the Needs-You rail with the time it will be refused. A card raised by a subagent lane is refused after 30 min (`CLAUDE_STATION_APPROVAL_DEADLINE_MS`; 0 turns this off). The refusal always denies; it never approves and never invents an answer. The lane is told this was a timeout and told to report BLOCKED-ON-PERMISSION. If it asks again for exactly the same thing, it is refused at once, with no second card. The session's own main-thread cards are escalated but never refused. Timers count awake time.
- **No-parking guard** (`src/server/park-guard.ts`, registered in `claude-runtime.ts` for every session): at a subagent's turn end, it reads the lane's own transcript. It collects the children the lane launched (a CLI launch line, from the matching tool) and checks which ones the CLI still reports as running. It also catches a nested agent whose result the lane never saw. If any are found, the stop is blocked, and the reason says how to wait in the foreground or how to stop the child. Bounds:
  - after 3 attempts with no successful tool call in between, the stop goes through and is reported as parked;
  - 4 h of awake time is a ceiling on repeated vetoes (not a watchdog);
  - each judgement has a 5 s budget and a 64 MB transcript cap;
  - a lane that already had a permission refused is released at once.

  Any failure allows the stop and is reported. The git decision window now ends only when the stop is really allowed.
- **Never silent** (`src/server/lane-incidents.ts`, `index.ts`): refusals and parked lanes are appended to `<data>/lane-incidents.jsonl`, which survives restarts. The Needs-You rail shows the last 24 h, plus any overdue card still waiting. A lane with an expired permission is held once until its final report names it.

## Verification plan

`npm run verify:bug-239-bound-hangs` runs the real-CLI arms against isolated scratch servers booted through `station-boot.mjs`; `npm run verify:bug-239-bound-hangs:fast` runs the pure arms only. Real transcripts are discovered at runtime, and a missing one fails loudly. There are mutation arms for an emptied parser, the deadline switched off and the guard switched off. `--root <tree>` runs the real-CLI arms against a pinned pre-fix tree, where they must fail.

## Migration and rollback

Server code only. It takes effect for sessions started or resumed after the user next restarts the service; lanes never restart it. A surviving CLI that is re-adopted gets the new hooks through the re-initialize. Hooks were already sent for virtually every session, because the git block is on by default, so adoption checks do not change. That path is not exercised by the suite. Rollback: set `CLAUDE_STATION_APPROVAL_DEADLINE_MS=0` and/or `CLAUDE_STATION_PARK_GUARD=0`, or revert the hunks. The ledger is append-only and harmless to keep.

## Risks

- A slow human loses a lane card after 30 min. It is visible on the rail and the lane reports it, but the work is re-run. Track this through attempted late answers.
- The guard depends on CLI wording for launch lines. The suite asserts them against real transcripts and fails when none match.
- Container sessions: the server may not be able to read the in-container transcript path. The guard then allows the stop and records "could not check".
- Codex-runtime sessions are not covered.
- The rail reuses the advisory "stalled work" card; a dedicated label needs `public/app.js`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-07 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-07 — agent (plan+review lane, round 1) — BUILT; both guarantees proven fail-before / pass-after

**What I understood (hypothesis check, done first).**
- **(A)** was only **partly right**. The hook relay is already bounded: the CLI waits 600 s, and BUG-187's floor has handled a missing responder since 09-24, with 0 hook timeouts after that date. The unbounded wait was the **human permission card**: 5 of the 8 longest hangs, about 2,378 awake min, all from subagent lanes. The time study's 09-15 to 09-21 "machine down" interval was a journal gap, not real downtime.
- **(B)** was **right for foreground lanes**. CLI 2.1.281 `killShellTasksForAgent` and `nonShellMonitors` kill them at hand-back; 13/13 surviving output files end `[killed]`. Background lanes are parked (BUG-140), not killed, and a nested agent's result is delivered to the orchestrator.
- Counts: 157 of 1,485 lanes ended with an unharvested child; 22 in the last 7 days; 6 today. Evidence scripts are in the scratch dirs `hang-trace-2026-10-07/` and `park-trace-2026-10-07/`.
- The Orchard server never kills these children itself.

**Plan review (cross-provider): OpenAI, dispatch thread 01a1158c-4d01-7ab3-83a0-969baa2fbe0c, SOUND-WITH-CHANGES, 17 findings.** The plan and the review are kept in the lane scratch `bound-hangs-2026-10-07/` (`PLAN.md`, `openai-plan-review.out`).

Adopted:
- (1) Block on a finished child whose result was never read. **Narrowed to nested agents**: in real transcripts a finished shell's output is still on disk, and one lane left 45 throwaway background sleep loops that would have been false holds.
- (3)+(4) Only a *successful* tool result counts as progress. A lane whose permission expired is let go at once, so the guard cannot cycle against the deadline.
- (5) The wait recipe does not assume a pid (the summaries carry none). The lane makes repeated foreground blocking calls, because notices arrive between tool calls.
- (6) The transcript read is async, capped at 64 MB, with a 5 s budget. A failure or timeout allows the stop and records it.
- (7) Provenance: a launch must be the leading text of a result from the matching tool.
- (8) One combined `SubagentStop` callback. The BUG-231 per-agent end runs only when the stop is really allowed.
- (9) Incidents are persisted in a ledger, and a lane with an expired permission is held once until it names it as BLOCKED-ON-PERMISSION.
- (10) An identical re-request is refused at once.
- (12) `once()` reports whether it won, the side effects are gated on that, the abort listener is removed, and an already-aborted signal is handled.
- (13) Config is validated (escalate < deadline, clamped).
- (15) Handshakes, mutation arms and retry-not-grade were added to the tests.

Rejected or narrowed:
- (2) The 4 h ceiling is described as "limits repeated vetoes", not a watchdog.
- (3) Counting "child progress" was rejected: the CLI exposes no progress signal.
- (11) Exempting main-thread cards from expiry: the reviewer agreed. A null agent id fails safe to today's behaviour.
- (14) An extend-deadline button is UI scope (`public/app.js` has other lanes in it).
- (16) The metric section below reports measured counts only, plus a projection labelled as one.
- (17) Re-adoption of surviving CLIs is untested here; noted under Migration.

**What I changed** (all unstaged):
- new `src/server/park-guard.ts`, `src/server/approval-deadline.ts`, `src/server/lane-incidents.ts`
- edited `src/server/agent-bridge.ts` (permission callback deadline, accessors, parked records), `src/server/runtime/claude-runtime.ts` (`SubagentStop` guard), `src/server/runtime/runtime.ts` (`laneBounds`), `src/server/index.ts` (Needs-You cards)
- new suite `scripts/verify-bug-239-bound-hangs-no-park.mjs`, with npm scripts `verify:bug-239-bound-hangs` and `verify:bug-239-bound-hangs:fast` in `package.json`
- `scripts/verify-bug-187-responderless-cli.mjs` A9b: its "no hooks" env now also sets `CLAUDE_STATION_PARK_GUARD=0`, because the guard is a hook too.

**What I verified.** The real-CLI arms run against isolated scratch servers booted through `station-boot.mjs`, with a real haiku session and the project pinned to `direct`.
- **Fixed tree: 41/41** in the final full run. All A1, A2 and B1 checks pass, and so do the mutation arms: A-MUT (deadline off) left the card pending, and B-MUT (guard off) lost the child.
  - A1: the refusal came 39.8 s after the card, against a 40 s deadline. The file was never written, and a late ALLOW was refused (`matched:false`).
  - B1: the real lane transcript records `Stop hook feedback: Orchard: you cannot end your turn yet…` and a `hook_blocking_error` from `SubagentStop:Callback`. The lane then waited in the foreground, received the child's notice and read its token. So an in-process SDK callback block **is** honoured by CLI 2.1.281.
- **Pinned pre-fix tree** (my pre-edit snapshots, sha `e86998976429` for the bridge): **4/14**. A: no refusal, no ledger record, and the late "allow" was accepted and *ran the Write*. B: the child started and was killed, and the lane was never held.
- **Pure arms: 23/23.** They cover real transcripts from several projects (shell, monitor and agent launches found at runtime), six truncation points, provenance forgeries, bounds, a FIFO read that never returns (allowed in 401 ms against a 400 ms budget), the expiry nudge, config validation, and a registration check.
- **Regressions:** BUG-187 104/104 after the A9b env fix (103/104 before it). BUG-231 21/21. The stall detector is 21/33, **identical on the pre-fix tree**, so that failure predates this change.
- `npm run gate`: typecheck PASS, check-nul PASS, **leak-gate FAIL on 14 files that are all other lanes'** (the BUG-236/FEAT-130 leak-token work in progress). My 9 files scanned on their own: 0 hits.

**Still open.**
- One B1 attempt in four (run 4) showed the lane's last record 40 s before its child finished, yet the child was not killed. I could not explain it from the evidence, which had been deleted. The suite now keeps scratch evidence automatically on any failing real-CLI attempt; three later B1 runs were clean.
- Independent clean-room verification is owed (`plan+review`).
- A dedicated Needs-You card label needs `public/app.js`.
- Codex-runtime sessions are not covered.
- Container sessions: the guard records "could not check" when the in-container transcript path is not readable from the host. This was not exercised.

**Metric (pilot).** Projection, not measurement: on the 5 historical card hangs, lane cards would have waited at most 30 awake min each, against ≥2,378 awake min total. Measured going forward: the counts of `permission-expired`, `lane-parked` and `park-guard-error` records in `<data>/lane-incidents.jsonl`, and attempted late answers (each one is a false expiry).

**DRAFT ONLY — wording for the user to approve (not applied).**

1. The Working Agreement's canonical source is `~/projects/methodology/WORKING_AGREEMENT.v4.md`, §I "Interleave long verification…". Mirror it to v2 via `sync:methodology`. Replace the **WRONG** bullet with:

   > - **WRONG — end the turn and wait on a monitor/notification.** In a foreground (synchronous) lane the CLI KILLS your background shells and Monitors the instant you hand back (CLI 2.1.281; every surviving output file of such a lane ends `[killed]`, BUG-239), so the result is lost, not merely unharvested. In a background lane the child survives but its notice may never reach you, and a nested background agent's result goes to the orchestrator instead. Orchard refuses a lane's turn end while its own background work is live — do not lean on that: it lets you go after three attempts without a successful tool call and reports you to the user as parked work.

   And replace "When you have nothing to overlap, run the step SYNCHRONOUSLY in foreground calls (split into sequential calls if one exceeds the timeout) — simplest and safe." with:

   > When you have nothing to overlap, WAIT IN THE FOREGROUND: a Bash call with timeout 600000 that blocks — `timeout 580 tail --pid=<PID> -f /dev/null` when you know the pid, else repeated `timeout 300 tail -f /dev/null` until the child's completion notice arrives (plain `sleep` is rejected; a Monitor does not keep you alive). Then read the result.

2. `.claude/agents/worker.md`: replace the first standing-rule bullet ("Foreground Bash only — …") with:

   > - Never end your turn while a background child you started (run_in_background Bash, Monitor, background Agent) is still running or unread: in a foreground lane the CLI kills it at hand-back (BUG-239). Wait in the foreground (Bash timeout 600000: `timeout 580 tail --pid=<PID> -f /dev/null`, or repeated `timeout 300 tail -f /dev/null` until its notice arrives) or stop it and say so.

   The structural guard does not depend on either edit.

**Symptom of a deeper design flaw?** Yes, in part. Turn-scoped child lifetime is a CLI property that Orchard can only veto at the stop, not change. Not filed as an ARCH ticket, because the veto plus the ledger covers the observed cost. Revisit if `lane-parked` records accumulate.

### 2026-10-07 — agent (same lane) — addendum, then CHECKPOINTED for a service restart

**Corrections after the entry above (all verified).**
- **Guard registration is now conditional.** BUG-187's A9b ("a session with no hooks adopts normally") went red, 103/104, because every session now carried a `SubagentStop` hook. The guard is now registered only when it is on, or when BUG-231 needs its per-agent end, which is the pre-change behaviour. A9b's hookless env sets `CLAUDE_STATION_PARK_GUARD=0`. Result: BUG-187 **104/104**.
- **Completion notices arrive as attachments.** On CLI 2.1.281 a lane's completion notice arrives as an `attachment` record of type `queued_command`, not a user message. The scan reads it, and a new pure arm (P4c) covers it.
- **B1's flakiness was the test prompt, not the product.** The Agent tool defaults to background on this CLI, so "do NOT set run_in_background" produced background lanes. Those are parked rather than killed, and the guard still held them and they harvested their child. The prompt now says `run_in_background` false. Each B attempt must show `requestShape: foreground` in the lane's `.meta.json` and is measured only after its transcript stops growing. Attempts that do not exercise the case are retried rather than graded, and the suite keeps their scratch evidence. The run-4 "lane ended 40 s before its child" timing is explained: that lane was a background lane, measured before it finished.
- **Final results on the final code:** B arms **32/32**, first attempt each (B1 held, child finished, lane outlived it; B-MUT foreground lane lost its child). Full run **41/41** (A1/A2/A-MUT unchanged since). Pure arms **23/23**. Gate: typecheck PASS, check-nul PASS, leak-gate FAIL only on other lanes' 14 files; mine scan 0 hits.

**Checkpoint (coordinator: "CHECKPOINT NOW", restart imminent).**
- **Where I am:** the build is complete and verified. Nothing is in flight: no suite run, no scratch server and no OpenAI dispatch is alive (checked by pid and data dir), and nothing needs re-sending. The OpenAI plan review finished earlier (thread 01a1158c-4d01-7ab3-83a0-969baa2fbe0c).
- **Edits left on disk, as the coordinator instructed** (a deliberate exception to the restore step). WIP copy: lane scratch `bound-hangs-2026-10-07/wip-20261007T133334/` (`tracked.diff` plus full copies). Note: this restart deploys them. They are complete and typecheck clean.
- **Files changed:**
  - new: `src/server/park-guard.ts`, `src/server/approval-deadline.ts`, `src/server/lane-incidents.ts`, `scripts/verify-bug-239-bound-hangs-no-park.mjs`
  - edited: `src/server/agent-bridge.ts`, `src/server/runtime/claude-runtime.ts`, `src/server/runtime/runtime.ts`, `src/server/index.ts`, `scripts/verify-bug-187-responderless-cli.mjs` (A9b env only), `package.json` (two npm scripts), this ticket.
- **Exact next step:** after the restart, re-run `npm run verify:bug-239-bound-hangs:fast` (expect 23/23). Then dispatch the owed clean-room independent verification (`node scripts/independent-verify.mjs`). Attack ideas for the verifier:
  - a lane card answered in the same tick as the deadline;
  - a container session's unreadable transcript path;
  - an adopted surviving CLI after a restart;
  - a lane that waits with a Monitor after being held.

  The WA and `worker.md` wording drafted in the entry above awaits the user's approval.

### 2026-10-07 — agent (same lane) — resumed after the 13:45:15 service restart

- **Ground truth:** all 10 changed files are byte-identical to the checkpoint WIP copy. No child of this lane was alive across the restart, and nothing needed re-sending: the OpenAI plan review had finished, and no OpenAI work is owed by this lane.
- **Re-verified after the restart** (pre-restart results do not count): typecheck clean; pure arms **23/23**; full real-CLI suite **43/43** (A1, A2, A-MUT, B1 and B-MUT, each with its preconditions).
  - One B1 attempt was retried rather than graded. The scratch server's "runtime check pending" refused that session's start; the next attempt exercised the case.
  - The must-FAIL evidence is the in-suite mutation arms: with the deadline off, the card was still pending; with the guard off, the foreground lane lost its child. The pinned pre-fix tree run before the restart gave 4/14.
- **The restart deployed this change** (it was in the working tree). From now on, live lane cards refuse after 30 min, and lanes are held at turn end while their own background work is live.
- **Open:** a clean-room independent verification, and the user's approval of the drafted WA and `worker.md` wording.

### 2026-10-07 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run d8d016bd-8e6b-4103-b0ef-9cf49ef80add — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — agent (fixing, round 2) — REDESIGN after independent verify BROKEN (run d8d016bd, candidate fad7e757739c)

**Verdict received.** Properties 1–3 HOLD. Property 4 ("incidents survive restart, shown once") is BROKEN by two mechanisms:
- the window read used only the ledger's last 512 KB;
- the stop-verdict race did not settle once, so it could double-record, or record a false "could not check" while discarding the real live-child verdict.

**Live impact (said first):** not worse than before BUG-239. Pre-change there was no record and no guard at all. Break 2 only fires when a judgement takes over 5 s, and the lane then ends exactly as it did before, with a misleading card. The live ledger was still empty. No revert. The npm scripts were in the working tree (`package.json`); the verifier's frozen candidate lacked them.

**Design review (WA §N, two breaks).**
- **Chosen: REDESIGN.** Both breaks are one missing structure: no single settle point, and a window bounded by bytes instead of time.
- **Rescope loses:** dropping persistence or the time budget brings back the silent loss this ticket exists to close.
- **Patching loses:** two independent mechanisms in one property is the §N signal that the structure is wrong; a third patch would chase the next race.

**What changed.**
- `src/server/park-guard.ts`: the judgement is pure, with two settle-once points.
  - The verdict comes from whichever finishes first, the judgement or the budget.
  - At most one record per stop, plus the lane state. They are written only where the verdict settled.
  - When the budget wins, the stop is allowed at once, and the single record waits for the late judgement (cap `CLAUDE_STATION_PARK_GUARD_LATE_CAP_MS`, default 60 s). It then says what was really found, for example "late check found bRace01 still running, likely lost".
- `src/server/lane-incidents.ts`: the ledger is rotated by UTC day, `<data>/lane-incidents/<YYYY-MM-DD>.jsonl`.
  - A window read opens only the day files the window touches and reads each in full.
  - A file over its 32 MB cap yields a visible "NOT shown" notice naming the file.
  - The round-1 single file is still read, so nothing recorded earlier vanishes.
- Suite: new arms R1/R2. The pinned round-1 modules are in `scripts/fixtures/bug-239/round1/` as the fixed must-FAIL baseline. P6a now expects its one record at the late cap.

**Proofs (observed).**
- **R1 must-FAIL**, on round 1: the 2-hour-old refusal was NOT shown (990 of 1,601 in-window records returned).
- **R1**, current: shown, 1,601 of 1,601. R1b, the over-cap notice: PASS. R1c, the legacy file still read: PASS.
- **R2 must-FAIL**, on round 1: the only record was "budget ran out" (the live child was never named), the ignored stop recorded **2** times, and a stale guard state was left.
- **R2**, current: one record naming the child as likely lost, no stale state, and the ignored stop recorded **once**.
- **Suites:** fast 31/31 via `npm run verify:bug-239-bound-hangs:fast`; full real-CLI run **51/51** via the same file (A1/A2/A-MUT/B1/B-MUT).
- **Gate:** `npm run gate` **PASS (exit 0)**; my 14 files leak-scan 0 hits.
- `agent-bridge.ts` and `claude-runtime.ts` are unchanged in this round.

**Still not tested** (the verifier's could-not-test list): re-adoption of a surviving CLI after a restart, end to end, and a container session whose transcript the host cannot read. Re-verify is owed on the round-2 candidate.

### 2026-10-07 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 65bea06e-043c-44de-b7e4-dc822194f897 — VERDICT: HOLDS. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — agent (fixing, round 3) — LANDED the drafted WA + worker.md wording (with `; true` amendment)

Applied the round-1 draft (above) as approved, with the orchestrator's amendment: every foreground-wait command ends in `; true` so the normal `timeout` exit (124) is not reported on the user's rail as a failed agent (22 false "failed" events today).
- **Canonical WA** `~/projects/methodology/WORKING_AGREEMENT.v4.md` §I: replaced the WRONG bullet (foreground kill / background notice gap / nested-result-to-orchestrator / don't-lean-on-the-veto) and the "nothing to overlap" sentence (WAIT IN THE FOREGROUND, `timeout … tail … ; true`). Added a CHANGELOG entry. `npm run sync:methodology` propagated to the mirror `docs/prompts/WORKING_AGREEMENT.v4.md`.
- **worker.md** (`.claude/agents/worker.md`, first standing rule) edited. **Orchard does NOT ship agent definitions to other projects** — `onboard.mjs` only installs a Stop hook into the target's `.claude/settings.json`; neither it nor `fleet-sync.mjs` copies `.claude/agents/`. So this edit is local to this repo; other projects have no worker.md to update.
- **Also updated the live source of the bare pattern:** `src/server/park-guard.ts`'s turn-end hook message told held lanes to run `timeout … tail` with no `; true` — the exact false-failure the amendment prevents. Added `; true` (string literal only; the bug-239 suite does not assert this text; typecheck clean). This is verified session-lifecycle code touched with a message-only change — an independent re-verify is low-value here but noted.
- rg of `.orchard/`, `scripts/`, `src/server/templates.ts`, agent defs found no other agent-facing instruction teaching the old pattern (the only other hit, `scripts/fixtures/bug-239/round1/park-guard.ts`, is the pinned must-FAIL baseline — left untouched).
- Verified: `verify:wa-injected` 10/10, `check:scope` clean for touched files (2 pre-existing CONVENTIONS.md candidates unrelated), `npm run gate` PASS (exit 0). No git writes.

### 2026-10-11 — landed in batch commit (orchestrator triage)
- Work landed in the 2026-10-11 whole-tree batch commit. Verified state unchanged; this entry records only the git landing. Full batch manifest is in the commit message.
