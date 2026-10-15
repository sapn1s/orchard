```orchard-ticket
{
  "id": "FEAT-176",
  "type": "feature",
  "title": "A finished lane’s uncommitted work can be overwritten with no copy kept",
  "summary": "Once a lane ends its file lock is gone, so a later whole-file write can erase its finished, uncommitted fix without anyone noticing. On 09-30 that lost BUG-217’s fix and an hour of verify on the wrong tree. Snapshot each lane’s files when it ends, warn at verify and commit on a mismatch, restore with one command.",
  "impact_if_we_wait": "Any later whole-file copy, restore or regenerate can again erase a finished fix after its lane ends, and the loss shows up only as a confusing red verify an hour later.",
  "current_need": "Verified on the rescoped recovery property (Opus 484eda25 HOLDS). Needs a service restart for the in-process trigger; files unstaged for the user to commit.",
  "severity": "medium",
  "area": "lane process / file safety",
  "reported": "2026-10-11",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-12",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "When a foreign write replaces an ended lane’s file, verify and commit print a loud warning naming the file, lane and ticket.",
    "One command restores the lane’s bytes exactly, and backs up what it overwrote first.",
    "Taking the snapshot never blocks or delays a lane’s stop and never changes a permission decision.",
    "Old snapshots are pruned automatically and the store size is bounded."
  ],
  "code_refs": [
    {
      "path": "scripts/lane-snapshot.mjs"
    },
    {
      "path": "scripts/lib/lane-snapshot.mjs"
    },
    {
      "path": "src/server/agent-bridge.ts"
    },
    {
      "path": "scripts/dispatch.mjs"
    },
    {
      "path": "scripts/independent-verify.mjs"
    }
  ],
  "related": [
    {
      "id": "FEAT-129",
      "relation": "see_also"
    },
    {
      "id": "FEAT-170",
      "relation": "see_also"
    },
    {
      "id": "BUG-224",
      "relation": "see_also"
    },
    {
      "id": "BUG-217",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "a2e4e700-4a53-4cc4-8029-2f49d3156be4",
      "verdict": "broken",
      "verdict_on": "2026-10-11",
      "recorded_at": "2026-10-11T23:22:53.186Z",
      "author": "verify lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Clean-room range 9234d298..cbc7f916 (scratch copy). Fixer suite 55/55 re-run. P1 two-break: (a) deletion-only and binary lane work undetectable; (b) corrupt manifest or unreadable snaps dir read as clean. P2-P4 not broken."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "4cc39a6c-c982-4dda-a523-45b4b4ed0963",
      "verdict": "broken",
      "verdict_on": "2026-10-11",
      "recorded_at": "2026-10-11T23:38:26.038Z",
      "author": "verify lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Re-verify after fix round 1 (ac05f455..c4e35fb0, scratch). Suite 77/77. P1 second two-break: capture-skipped files (over cap) read clean; a later lane's whole-file Write excuses an older lane's lost lines even from a clobbered base."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "aa3a4644-06d9-4dee-8fda-b7b7e80d74f6",
      "verdict": "broken",
      "verdict_on": "2026-10-11",
      "recorded_at": "2026-10-11T23:50:03.017Z",
      "author": "verify lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Round-2 verify (6b4d8918..8708b6c7, scratch). Suite 85/85. Both round-2 fixes held. New P1 breaks: foreign delete before the snapshot reads clean; gitignored lane files never captured. Fail-closed is enumerated, not structural."
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a12d69-ac98-76e1-9711-baead06f74d1",
      "verdict": "broken",
      "verdict_on": "2026-10-12",
      "recorded_at": "2026-10-12T00:03:43.306Z",
      "author": "verify lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "v3 redesign verify (fa9e0c5b..8f0d3380, scratch). Suite 95/95. New P1 breaks: partly clobbered lane-end copy accepted when the last Edit survives; file-recreated excused by a later Write. P4: transcript replay bypasses the 400-file cap."
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a12d74-d0c6-7fc3-8362-40efa3da5e77",
      "verdict": "broken",
      "verdict_on": "2026-10-12",
      "recorded_at": "2026-10-12T00:15:26.375Z",
      "author": "verify lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Recovery-only verify (125a6a39..ab7fb97e, scratch). Suite 55/55. Two-break on recovery: a short deletion reverted is still stored and restored; restore follows an escaping symlink ancestor when the parent is missing."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "484eda25-df95-4f5e-abcb-c36d79fa6fca",
      "verdict": "holds",
      "verdict_on": "2026-10-12",
      "recorded_at": "2026-10-12T08:38:48.399Z",
      "author": "verify lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Rescoped recovery property, range c8a446e6..ddd0f852 (scratch copy). Fixer suite 59/59 re-run; adversarial: 224-lane differential fuzz, path confinement and store integrity, untested classification shapes. Contract VALID. OpenAI quota hit mid-run (01a12f36, no verdict)."
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

# FEAT-176 — A finished lane’s uncommitted work can be overwritten with no copy kept

## Symptom
A lane finishes its fix and stops. Its uncommitted edits now have no owner: the FEAT-129 file lock is released when the lane ends. On 2026-09-30 another lane copied 22 pre-lane files over the tree 4 seconds after BUG-217's round-9 fixer finished. That removed BUG-217's wiring from src/server/index.ts. The next verify ran red on a tree that no longer held the fix, about an hour lost (BUG-224). Nothing recorded the fixer's bytes, so nothing could notice the loss or put them back.

## Evidence
- BUG-224 audit: the strip lane's `cp` at 12:40:38.689Z removed 3 BUG-217 edits from index.ts. BUG-217 r9's fixer had appended its log at 12:40:34Z.
- 30-day research (dispatch charter): that was the only real cross-session loss in 30 days; 15 other collisions were caught.
- Disk measurement (2026-10-12, scratch/lane-snap/measure.mjs over every subagent transcript of this project with mtime in the last 30 days, file sizes as of today): 868 lanes, 497 wrote at least one repo file, 1,564 file snapshots, 152 MB total with no dedup. Median lane 117 KB, p95 1.4 MB, max 2.2 MB, peak 65 writer lanes per day. Bash writes: 1,033 attributed to a path, 313 not attributable (tree-wide or unresolved target).

## Diagnosis
The FEAT-129 lock protects a file only while its owner is live. FEAT-170 candidates are opt-in and need a lane to freeze. So the common case, a lane that finished and was not yet committed, has neither. Prevention is not required; detection plus one-command recovery is enough.

## Implementation notes
Plan (2026-10-12, before build).

**1. Trigger (never in a hook).**
- In-process lanes (Agent/Task subagents, direct and container sessions): `agent-bridge.ts` calls `spawnLaneSnapshot()` where it already records a lane's terminal frame (`#recordAgentEnd`, every status, including completed), and for lanes still running when the session ends (`#recordSessionEnd`). Only `kind: 'agent'` rows. This is stream bookkeeping in the server, not an SDK hook. Nothing the CLI waits on runs it. It does not touch `claude-runtime.ts`, PreToolUse, SubagentStop, or the orchestrator profile.
- External lanes (`scripts/dispatch.mjs`, anthropic `claude -p` and OpenAI/Codex): just before `writeMeta` at exit.
- `spawnLaneSnapshot(spec)` launches `node scripts/lane-snapshot.mjs take --spec <base64 json>`, detached, stdio ignored, unref'd. There is an `error` listener, and the whole call is wrapped in try/catch. The caller does no file I/O and never awaits. Spawn cost is milliseconds. Every failure goes to `<store>/errors.log` and is otherwise ignored.

**2. Which files (reliable source = the lane's own transcript).**
- Claude lanes: `<projects root>/<storeEncodedDir>/<sdkSessionId>/subagents/agent-<taskId>.jsonl`. External claude lanes: `<sid>.jsonl` plus its `subagents/*.jsonl`. Codex lanes: the Orchard transcript (`fileChange` items). Its path is added to the dispatch meta.
- Written = a successful (no `is_error` result) Write / Edit / MultiEdit / NotebookEdit / fileChange path. A Bash path counts when FEAT-129's `classifyMutation` resolves it, imported read-only; file-lock.mjs is not edited. Paths resolve against the entry's `cwd`. Container paths map from the container workdir to the project's host path. Only regular files inside the project root are kept.
- **Known limit:** a Bash write the classifier cannot resolve (tree-wide git op, unresolved target, a script that writes). Measured at 313 of 1,346 Bash writes. It is recorded in the manifest as `unattributed` (tool + command head) so `check` can say the lane did more than was snapshotted.

**3. Store (a lighter snapshot-only mode, not the FEAT-170 candidate store).** `dataDir()/lane-snapshots/<basename>-<sha256(realpath top)[0:12]>/`
- `objects/<sha256>`: write-once 0444, temp file then rename, re-hashed on every read. Same scheme as the candidate store.
- `snaps/<endedAt>-<laneId>.json`: write-once manifest with `{v, laneId, source, stationSession, ticket[], status, endedAt, takenAt, top, transcript, files:[{path, state: present|absent|skipped, sha256, size, mode, lastOp, lastOpAt, atSnapshot: matches|suspect|unknown}], unattributed[]}`.
- `atSnapshot` checks the live file against the lane's own last op. For Write: same bytes. For Edit/MultiEdit: its new_string is present. When the check fails the file is `suspect`: a foreign write may already have landed before the snapshot, and `check` says so.
- **Why not the candidate store:** it lives in `.git/` (non-git projects get nothing), its blob writer is private, its ids must be ticket ids, and pruning there could delete a candidate's objects. A separate root makes pruning unable to touch FEAT-170 data. Snapshots are not claims: no ownership, no refusal, no exit-3.
- Limits per lane: files over 8 MB are `skipped` (env `ORCHARD_LANE_SNAPSHOT_MAX_FILE`), at most 400 files.

**4. Detection (loud, never blocking).** `lane-snapshot.mjs check --repo P [--json] [--paths f…]`
- For each path, take the latest manifest that holds it. It is a finding when the live bytes differ from the snapshot, unless (a) HEAD holds the snapshot bytes (the work is safe in git), or (b) a commit touching the path is newer than the lane's end (the user committed a decision since).
- The report names the file, lane, ticket, end time, live vs snapshot size, suspect flags, and the exact restore command.
- Wired as a warning block (stderr, never changes an exit code) into:
  - `independent-verify.mjs` (every mode, before the room is built);
  - `board-tool commit` (before git commit);
  - `candidate.mjs freeze` and `commit`;
  - this repo's `.githooks/pre-commit` (staged paths, `|| true`).
- The check is bounded: a 10 s budget, and on error a one-line `lane-snapshot check unavailable: …`, never a false "clean".

**5. Restore (the user's one command).** `node <orchard>/scripts/lane-snapshot.mjs restore <laneId-prefix|TICKET> --repo P [--file f…] [--dry-run]`
- For a ticket, use the latest manifest per file among that ticket's lanes.
- Before overwriting, the live bytes are backed up as a `restore-backup` manifest, so a restore is itself undoable (`restore <backup id>`).
- Each write goes to a temp file in the same dir, then rename, then the mode is set, then a re-read must hash to the snapshot.
- It refuses a path that escapes the project root or is a symlink. It never deletes: a lane-deleted file (`absent`) is reported, not removed.
- Also `list [--repo P] [--ticket T]` and `show <id>`.

**6. Retention (bounded, measured).** After each `take` (in the child) and via `prune`:
- drop manifests older than 14 days (`ORCHARD_LANE_SNAPSHOT_DAYS`) or beyond the newest 1,000 per project;
- then garbage-collect objects that no manifest references and that are older than a 1 h grace;
- all under a store lock (O_EXCL file, stale after 120 s). A writer re-touches a reused object's mtime before writing its manifest, so grace protects an object a concurrent `take` is about to reference;
- deletes only regular files inside the store root (path containment asserted).
- At the measured rate, 14 days ≈ 71 MB per this project before dedup. `stats` prints the real footprint.

**7. Coverage by project kind.**
- Host projects: full.
- Container projects: the bridge and the snapshot child run on the host. Transcripts are in the host store `-workspace-<id>`. `/workspace/<id>/…` paths map to the host path. `check`/`restore` run on the host. Inside a container the store is not visible, so the check prints unavailable.
- Codex: dispatched OpenAI lanes are covered through their transcript at exit (`fileChange` paths). Interactive Codex sessions are not lanes and are not covered. Codex still has no lock; this is detection only.
- Non-git projects: snapshot and restore work; the HEAD/commit rules simply do not apply.

### Plan review 1 (separate Claude Opus process, dispatch anthropic session e700f1f0-f677-4fba-adcf-e74f4aac50b6): APPROVE-WITH-CHANGES, 12 findings; revised design (supersedes the plan above where they differ)
OpenAI was tried first; its test dispatch failed with a quota-window error (thread 01a12d13-cbcc-7cf2-a8a5-ed98fd88a333).
- **F1 (blocker) — accepted.** `#recordAgentEnd` returns early on `completed`. The trigger is a separate `#laneEnded(taskId, status)`, called at every terminal-frame site before `#recordAgentEnd`, including a terminal frame for a task with no row here (an adopted session after a restart). It is deduped by task id.
- **F2 (blocker) — accepted. Detection is by the lane's own lines, not by bytes or commits.** At take time the manifest records `added`: hashes of the non-trivial lines in the lane's final bytes that are not in HEAD's version of the file (all lines when there is no git/HEAD). A finding is any added line now absent from the live file. The "newer commit" suppression is deleted: committing a clobbered tree no longer silences the warning. One suppression remains: the snapshot's exact blob exists in the repo's object database (`cat-file --batch-check`), meaning the lane's bytes were committed or staged at some point and are recoverable from git. A byte difference alone is informational. A later writer that keeps the lane's lines stays quiet without a commit.
- **F3 — accepted.** dispatch.mjs takes the snapshot from `process.on('exit')`, so every exit path is covered (die, SIGINT handlers, a missing `--meta-out`). An exit killed by a signal without a handler (SIGKILL) is the stated limit.
- **F4 — accepted.** Session end snapshots every running lane before the record guards (suppressed or adopted states), in ONE child process.
- **F5 — accepted.** Per-lane byte budget of 64 MB, per-project store ceiling of 2 GiB enforced by prune (oldest manifests first). Paths under `.git/` and `node_modules/` and gitignored paths are skipped.
- **F6 — accepted (restore stays one command).** A `suspect` entry is a finding in its own right, and `restore` refuses it without `--force`. Restore acts by default; I declined the reviewer's dry-run-by-default because every restore backs up what it overwrites, so one command plus an undo meets the goal. `--dry-run` exists.
- **F7 — accepted.** The store lock is held across a take's object writes and manifest publish, refreshed per file. Prune takes the same lock. `check` reports a missing object loudly and never as clean.
- **F8 — accepted, with attribution.** Every manifest in the window is checked, not just the latest. An older lane's missing line is excused only when a LATER lane's own recorded edits removed it: the line's hash is in that lane's `removed` set (lines in its Edit/MultiEdit old_strings that are not in its new_strings), or that lane whole-file Wrote the file. A later lane that merely edited on top of an already-clobbered base excuses nothing.
- **F9 — accepted.** A missing `agent-<taskId>.jsonl` is recorded as `transcript-not-found` and reported by `check`; no heuristic fallback (it could attribute the wrong lane).
- **F10 — accepted.** The child reads file bytes for the paths found at t0, re-parses the transcript after 1.5 s, and reads any newly found paths then.
- **F11 — accepted.** The bridge passes its actual container cwd (`/workspace` or `/workspace/<id>`) and the host path as the alias pair.
- **F12 — accepted.** R2 is split: (a) the spawn itself fails (bad executable) and the stop is untouched; (b) the child throws with a writable store, and errors.log holds it. The spawn is deferred with `setImmediate`.
- **Simpler alternative (a side bare repository as the snapshot backend) — rejected.** dispatch.mjs runs inside a lane, where the FEAT-135 shim refuses `commit-tree`/`update-ref`; reaching the binary by absolute path is exactly the evasion that authority exists to stop. A whole-tree snapshot would also store other lanes' in-flight bytes under this lane's name. The custom store performs no repository writes; the repository is only read (`cat-file --batch-check`, `check-ignore`, `show HEAD:path`).

## Verification plan
Persistent suite `scripts/verify-feat-176-lane-snapshot.mjs`. Each case is must-FAIL before / pass after:
- **R1, the 09-30 replay, scratch server:** real server, real bridge, fake CLI (`CLAUDE_STATION_CLAUDE_BIN`) that emits a lane which Edits src/server/index.ts in a scratch git repo and ends. Then a foreign `cp` of the pre-lane copy over it. `check` names the file, lane and ticket; `restore` brings back byte-identical content (sha256). Before: no snapshot exists, so `check` finds nothing.
- **R2, stop not delayed/blocked when the snapshot fails:** the store root is unwritable and the snapshot script is forced to throw. The lane's terminal frame is processed, the agent-completed event arrives within the same window as the control, the session's next turn runs, and errors.log holds the failure.
- **R3, permission decisions untouched:** an orchestrator-profile session's `Task` and `Agent` calls are still DENIED with the snapshot feature on, and a lane's Write is allowed as before. Also a source pin: `claude-runtime.ts` has no lane-snapshot reference.
- **R4, retention prunes:** aged manifests are dropped, unreferenced objects collected, referenced and in-grace objects kept, nothing outside the store touched.
- Plus unit cases: Bash attribution and unattributed recording, container path mapping, symlink/escape refusal, a restore backup that undoes a restore, and the HEAD and newer-commit suppressions.
- Then `npm run gate`.

## Migration and rollback
Additive: new `scripts/lane-snapshot.mjs` and `scripts/lib/lane-snapshot.mjs`, a few lines in agent-bridge.ts, dispatch.mjs, independent-verify.mjs, board-tool.mjs, candidate.mjs and .githooks/pre-commit. `ORCHARD_LANE_SNAPSHOT=0` disables taking snapshots. Rollback is deleting the two files and the call sites; the store dir can be removed by hand. The in-process trigger needs a service restart to load.

## Risks
- A legitimate later writer that is not a lane (the user, a top-level session) shows up as a finding until committed. That is accepted: loud is the goal, and a commit settles it.
- There is a window between a lane's last write and the snapshot (normally under a second after the terminal frame). The `suspect` flag narrows it but does not close it.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-11 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-11 — worker (fixing r1)
- **Note:** Plan review by a separate Claude Opus process (dispatch anthropic session e700f1f0-f677-4fba-adcf-e74f4aac50b6; OpenAI quota-window, thread 01a12d13): APPROVE-WITH-CHANGES, 2 blockers + 10. Revised design recorded in the body under Plan review 1. Building.

### 2026-10-11 — worker (fixing r1)
- **Note:** BUILT + PROVED. Files (unstaged): NEW scripts/lane-snapshot.mjs, scripts/lib/lane-snapshot.mjs (+ .d.mts), scripts/verify-feat-176-lane-snapshot.mjs; EDITED src/server/agent-bridge.ts (#laneEnded at both terminal-frame sites and session end; spawn deferred, detached, never awaited), scripts/dispatch.mjs (process.on exit snapshot, lazy import), scripts/independent-verify.mjs (warning before the room; clean-room dispatch runs with ORCHARD_LANE_SNAPSHOT=0), scripts/candidate.mjs (freeze/commit warning), scripts/board-tool.mjs (commit warning), .githooks/pre-commit (whole-tree warn, timeout 15, || true), package.json + scripts/test-manifest.json (verify:feat-176; regen also picked up another lane's verify:feat-175), docs/CONVENTIONS.md (restore command). claude-runtime.ts untouched. Change vs plan found while proving: the pre-commit warning checks the WHOLE tree, not staged paths, because a lane file reverted to HEAD is never staged (run2 showed the staged-only form silent). Suspect is now evaluated before the live==snapshot and blob-in-git shortcuts (run2: a clobber that landed before the snapshot read clean). PROOFS: scripts/verify-feat-176-lane-snapshot.mjs 55/55 in the confined runner (scratch/lane-snap/run4.log). R1 09-30 replay on a scratch server: check exit 1 naming src/server/index.ts, the lane and BUG-217; independent-verify, the pre-commit warning and candidate freeze print it; restore sha256-equal; the synthesized pre-change bridge (3 trigger lines stripped) stays silent (must-FAIL). R2: SubagentStop 1-2 ms and terminal frame to agent-completed 0-1 ms in control, on, spawn-fail, throwing child and 20 s hanging child; next turns ran; errors.log holds the thrown fault. R3: Task stays DENY; Agent and a lane Write decide identically with snapshots on/off; source pin on claude-runtime.ts. R4/U7: age, count and byte ceilings prune; old unreferenced objects collected, referenced and in-grace kept; nothing outside the store touched; empty store dirs removed by the root prune. U3 must-FAIL: the deleted plan-1 newer-commit rule would read the committed clobber as clean. Robustness: take over all 868 real 30-day transcripts of this project into a scratch store, 0 errors, avg 158 ms, max 816 ms. npm run gate PASS. Regressions: dispatch 24/0, feat-100 31/0, feat-141 43/0, bug-182 21/21, bug-239 fast PASS, feat-170 candidates 93/0, feat-170-optin 6/0, feat-130 171/0, bug-146 30/30; board-tool 33/1, bug-105 (no start ack), independent-verification 1 fail, bug-250 2 fail, feat-097 4 fail are pre-existing: identical on a baseline with this change reverted. Restart needed for the in-process trigger (agent-bridge.ts); dispatch.mjs and the CLI tools take effect without one.

### 2026-10-11 — verify lane
- **Verification recorded:** dispatch anthropic/claude-opus-5 run a2e4e700-4a53-4cc4-8029-2f49d3156be4 — VERDICT: BROKEN — Clean-room range 9234d298..cbc7f916 (scratch copy). Fixer suite 55/55 re-run. P1 two-break: (a) deletion-only and binary lane work undetectable; (b) corrupt manifest or unreadable snaps dir read as clean. P2-P4 not broken.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-11 — verify lane
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 4cc39a6c-c982-4dda-a523-45b4b4ed0963 — VERDICT: BROKEN — Re-verify after fix round 1 (ac05f455..c4e35fb0, scratch). Suite 77/77. P1 second two-break: capture-skipped files (over cap) read clean; a later lane's whole-file Write excuses an older lane's lost lines even from a clobbered base.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-11 — worker (fixing r1)
- **Note:** FIX ROUND 1 (after verify a2e4e700 BROKEN, two-break on P1; adjudicator 001142ed-e05a-451a-b61a-0174f2597378 ruled REDESIGN): built the line-multiset contribution (adds and removals by count, distinctive removals only, byte fallback for binary/format changes written by direct tools, Bash-only files a notice), transcript provenance kept separate (editRemoved/editAdded), v2 manifests with the v1 rule kept, fail-closed store reading (damaged manifest = finding, unreadable snaps/objects/store = unavailable exit 3 printed by every caller), prune skips object GC while a damaged manifest is inside retention, and an ack verb that mutes per exact live bytes. Suite 77/77 confined (scratch/lane-snap/run6.log); the same suite on the round-0 library fails 16 checks incl. both verifier breaks (r1-before.log). npm run gate PASS. RE-VERIFY anthropic/claude-opus-5 run 4cc39a6c-c982-4dda-a523-45b4b4ed0963 (range ac05f455..c4e35fb0, scratch copy): BROKEN, second two-break on P1: (1) capture-skipped files (over the 8 MiB cap, lane budget or file cap) read clean; (2) a later lane's whole-file Write unconditionally excuses an older lane's lost lines, even from a clobbered base. SECOND ADJUDICATION (independent, dispatch anthropic session a655c4f3-67ee-4e3f-83ae-e9abb2cd3be3): both FIX-REQUIRED. Route 1: in checkRepo count non-present entries as uncompared with a notice naming path/lane/ticket/reason, and never print clean while uncompared > 0 (exit stays 0 for uncompared-only). Route 2: delete the laterWhole zeroing; a whole-file Write excuses only lines present in content the lane observed before writing and absent from what it wrote; with no observed pre-write content it excuses nothing. DISPOSITION: blocked from verified until an authorized round 3 lands both; the code may stay in the tree and ship as detection-only (additive, never deletes, never blocks). Accepted residuals: shell-only writes not byte-compared; contribTruncated; v1 binary notices; suspect needs --force. The fix-round budget for this dispatch is spent, so no further round was started. Service restart needed for the in-process trigger (agent-bridge.ts); not restarted.

### 2026-10-11 — verify lane
- **Verification recorded:** dispatch anthropic/claude-opus-5 run aa3a4644-06d9-4dee-8fda-b7b7e80d74f6 — VERDICT: BROKEN — Round-2 verify (6b4d8918..8708b6c7, scratch). Suite 85/85. Both round-2 fixes held. New P1 breaks: foreign delete before the snapshot reads clean; gitignored lane files never captured. Fail-closed is enumerated, not structural.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-11 — worker (fixing r2)
- **Note:** FIX ROUND 2 (coordinator-authorized, adjudicator a655c4f3's two fixes): (1) over-cap files are fingerprinted (sha256, no bytes); unchanged = notice and never printed clean; changed or unhashable = not-snapshotted finding (exit 1, UNKNOWN), loud in every warning path, restore honest. (2) the later-whole-file-Write excuse is deleted and Write/Codex-add content no longer counts as an intentional re-add; only a later lane's recorded Edits excuse. Proofs: U19 (5 checks) + U20 (3); suite 85/85 confined (scratch/lane-snap/run7.log); 6 new checks FAIL on the round-1 library (r2-before.log). npm run gate PASS. OpenAI test dispatch failed again, so the verify used Opus. VERIFY anthropic/claude-opus-5 run aa3a4644-06d9-4dee-8fda-b7b7e80d74f6: BROKEN through NEW mechanisms (both round-2 fixes held): (a) a foreign delete in the window before the snapshot leaves state absent / atSnapshot unknown, which check skips: clean, and restore says the lane deleted it; (b) a lane's work in a gitignored file is filtered before capture, so there is no manifest and check reads clean. The verifier's diagnosis: fail-closed is enforced per enumerated branch, not structurally. Per charter: STOPPED, no further round. Next step needs an independent design review (e.g. every transcript-attributed path yields a compared-or-reported entry by construction). Restart still needed for the in-process trigger; not restarted.

### 2026-10-12 — verify lane
- **Verification recorded:** dispatch openai run 01a12d69-ac98-76e1-9711-baead06f74d1 — VERDICT: BROKEN — v3 redesign verify (fa9e0c5b..8f0d3380, scratch). Suite 95/95. New P1 breaks: partly clobbered lane-end copy accepted when the last Edit survives; file-recreated excused by a later Write. P4: transcript replay bypasses the 400-file cap.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-12 — worker (fixing r3, v3 redesign)
- **Note:** V3 REDESIGN (coordinator-relayed adjudicator ruling): detection rests on the transcript's write-time record. extractWrites replays Write plus later Edits into exact bytes; take() makes every in-project transcript-written file one entry (present with transcript or copy basis / deleted / unbased with transcript expectations and HEAD counts); deleted the gitignored filter, the absent-unknown branch and check's non-present skip; checkRepo gives every entry exactly one outcome (accounting); restore uses transcript bytes, and an untrustworthy lane-end copy only with --force; prune keeps copySha objects. ACCEPTED RESIDUALS (coordinator): shell-only writes (fingerprint only); duplicate-line precision when judging from the transcript; restoring an Edit-only file needs --force. PROOFS: suite 95/95 confined (scratch/lane-snap/run8.log), incl. R1-R4 on a scratch server, U21 (delete before snapshot, Edit and Write variants) and U22 (gitignored .env), which FAIL with 13 other checks on the round-2 library (r3-before.log, 80/15). NEW scripts/verify-feat-176-accounting.mjs on 870 REAL transcripts: 1861 independently parsed written files, 1861 manifest entries, 1861 outcomes (1260 compared, 362 findings, 239 notices), 0 missing, 0 duplicated, 0 take errors (acc.log); the manifest generator tiers it pure, but it needs the host transcript store (exits 2 COULD NOT RUN without it). npm run gate PASS. VERIFY openai run 01a12d69-ac98-76e1-9711-baead06f74d1 (OpenAI test dispatch worked): BROKEN through NEW mechanisms. (1) A lane-end copy that keeps the lane's LAST Edit but lost an EARLIER recorded edit is accepted as the copy basis (evidence checks only the last op's needles): the earlier contribution vanishes with no finding. (2) The deleted-file branch excuses file-recreated when a later lane recorded any write, including a whole-file Write. (3) P4: transcript replay bypasses the 400-file cap. Per charter: STOPPED, no further round. Likely structural fix for whoever owns the next decision: use the lane-end copy only when it contains every recorded edit's new_string (not only the last), apply the no-Write-excuse rule to the deleted branch, and count transcript bases against maxFiles. Restart still needed for the in-process trigger; not restarted.

### 2026-10-12 — verify lane
- **Verification recorded:** dispatch openai run 01a12d74-d0c6-7fc3-8362-40efa3da5e77 — VERDICT: BROKEN — Recovery-only verify (125a6a39..ab7fb97e, scratch). Suite 55/55. Two-break on recovery: a short deletion reverted is still stored and restored; restore follows an escaping symlink ancestor when the parent is missing.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-12 — worker (fixing r4, rescope)
- **Note:** RESCOPE (adjudicator, second two-break): recovery is the guarantee. Property, verbatim: Every file a lane wrote in the project with Write, Edit, MultiEdit, NotebookEdit or fileChange is either stored exactly, rebuilt by replaying its recorded edits, or named as unrecoverable with a reason. lane-snapshot restore <lane|ticket> writes the bytes back after backing up the live file. Taking a snapshot never delays a stop or changes a permission. BUILT: scripts/lib/lane-snapshot.mjs rewritten (manifest v4, recovery classes rebuilt/stored/deleted/unrecoverable, plus best-effort shell-copy/shell-gone/shell-skipped); copy-trust rule: every recorded edit's new text present (text the lane later rewrote excepted) and no text a deletion-edit (10+ chars) removed; caps (file, lane bytes, 400 files incl. replays) name a file unrecoverable; check only warns when live bytes differ from the latest snapshot or a deleted file is back; line counting, excuse rules and ack deleted; CLI ack and --force removed; triggers, store, restore, prune unchanged. Subagent transcripts carry no toolUseResult/originalFile (checked), so Edit-only files have no exact replay base. PROOFS: suite 55/55 confined (scratch/lane-snap/run9.log): 09-30 copy overwritten after (stored, exact restore) and before the snapshot (Write lane rebuilt, exact; Edit-only lane named unrecoverable, nothing written); part-overwritten copy refused naming edit 1 of 2; delete then recreate rebuilt; gitignored .env rebuilt and restored; over-cap file and over-cap replay unrecoverable, file-count cap counts replays; undo of a restore exact; R1-R4 (R2 SubagentStop 1-3 ms, terminal frame to agent-completed 0-1 ms; R3 Task stays DENY). The v3 library fails 16 of these (r4-before.log). Real-transcript accounting (verify-feat-176-accounting.mjs, 871 transcripts): 1861 files, 1379 via recoverable tools, all stored/rebuilt/deleted/unrecoverable-with-reason, 482 shell-only, 0 missing, 0 duplicated, 0 take errors (acc2.log; 437 unrecoverable because the snapshot is taken today, long after those lanes ended). npm run gate PASS. RESIDUALS (coordinator): shell writes (313 of 1,346 not attributable); files over 8 MB; a SIGKILLed dispatch; interactive Codex; warnings over-report. VERIFY openai run 01a12d74-d0c6-7fc3-8362-40efa3da5e77: BROKEN, two-break on recovery: (1) copyRejectReason ignores deletions shorter than 10 chars, so a foreign revert of a deleted short line (unsafe();) is classified stored and restore resurrects it; (2) restore checks only the immediate parent's realpath: with a missing parent under a symlinked ancestor it mkdirs and writes outside the project. STOPPED per charter, no further round. Restart still needed for the in-process trigger; not restarted.

### 2026-10-12 — verify lane
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 484eda25-df95-4f5e-abcb-c36d79fa6fca — VERDICT: HOLDS — Rescoped recovery property, range c8a446e6..ddd0f852 (scratch copy). Fixer suite 59/59 re-run; adversarial: 224-lane differential fuzz, path confinement and store integrity, untested classification shapes. Contract VALID. OpenAI quota hit mid-run (01a12f36, no verdict).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-12 — worker (fixing r5, recovery rescope 2)
- **Note:** RESCOPE 2 (independent adjudicator, verbatim property): Every Write/Edit/MultiEdit/NotebookEdit/fileChange file a lane wrote is either restorable byte-exact from its own transcript, or named unrecoverable with a reason. Restore writes only real paths inside the project, with no symlinked component, after backing up the live file. BUILT: the lane-end copy check (copyRejectReason) deleted; files without a Write base keep their lane-end copy as UNVERIFIED (restore only with --force, labelled UNVERIFIED; exact files labelled exact); restore backups are an exact class so undo needs no flag; confinedTarget() walks every path component with lstat, refusing any symlinked component (outside or inside the project), a non-directory parent, a missing parent under a symlinked ancestor, or a symlinked project root, and re-checks immediately before each write while creating missing parents one real directory at a time. PROOFS: suite 59/59 confined (scratch/lane-snap/run11.log). The v4 library FAILS 11, incl. break (a) a reverted short deletion classed stored and restored without a flag, break (b) a missing parent under a symlinked ancestor written outside, and a symlinked component pointing inside the project (r5-before.log). Real-transcript accounting (verify-feat-176-accounting.mjs, 878 transcripts): 1863 files, 0 missing, 0 duplicated, 0 take errors (acc4.log; one transient miss in acc3 was a transcript still being written by a live lane). MEASURED COVERAGE of 1,379 Write/Edit/MultiEdit/NotebookEdit/fileChange files: 318 exact (23%), 1054 unverified (76%), 7 unrecoverable (1%) when measured today; the adjudicator's 23% exact / 45% unverified / 32% unrecoverable split is from the v4 copy-check run (acc2.log) and differs because v5 keeps every usable copy as unverified. npm run gate PASS. Verify: OpenAI run 01a12f36-4ec0-7923-93f7-b9a893301f02 hit the quota mid-run (no verdict, fail-closed); then anthropic/claude-opus-5 run 484eda25-df95-4f5e-abcb-c36d79fa6fca: HOLDS, contract VALID (fixer suite re-run; 224-lane differential fuzz; path confinement and store integrity; classification shapes). RESIDUALS: shell writes (313 of 1,346 not attributable; shell-only files kept best-effort, --force); files over 8 MB (unrecoverable with that reason); a SIGKILLed dispatch takes no snapshot; interactive Codex sessions are not lanes; warnings over-report. Verifier's untested list: host accounting, real Codex add records, store concurrency incl. a file appearing between restore's plan and its rename (no backup of it), real triggers, real-size caps. Symptom of a deeper design flaw? no; detection was rescoped twice by independent adjudication. Restart needed for the agent-bridge trigger; not restarted. Files (unstaged): scripts/lib/lane-snapshot.mjs, scripts/lib/lane-snapshot.d.mts, scripts/lane-snapshot.mjs, scripts/verify-feat-176-lane-snapshot.mjs, scripts/verify-feat-176-accounting.mjs, src/server/agent-bridge.ts, scripts/dispatch.mjs, scripts/independent-verify.mjs, scripts/board-tool.mjs, scripts/candidate.mjs, .githooks/pre-commit, package.json, scripts/test-manifest.json, docs/CONVENTIONS.md, this ticket.
