```orchard-ticket
{
  "id": "FEAT-170",
  "type": "feature",
  "title": "Verify a frozen copy of each ticket and commit exactly that",
  "summary": "Lanes share one uncommitted tree, so a verifier sees every ticket's edits and a later lane can revert a finished fix before it is verified. Freeze each ticket's files into a hashed candidate, verify it, bind the verdict to the hash, and commit exactly the frozen bytes; any later change invalidates the verdict.",
  "impact_if_we_wait": "Verifiers keep hand-building isolated copies (86 of 211 verify lanes in 30 days), a whole-file restore can again turn a finished fix into a false BROKEN (BUG-224 cost about an hour), and commits keep mixing verified and broken tickets because nobody can split a shared file.",
  "current_need": "FIXED, not VERIFIED: the shadow-repo pilot (final verify faa119a9 BROKEN, two-break adjudicated, mode fix made). No more verify rounds; next check is the pilot's own metrics (shadow.mjs metrics) after 4 weeks or 10 landings, once a service restart activates it.",
  "severity": "high",
  "area": "lane process and commit workflow",
  "reported": "2026-10-07",
  "reported_by": "agent",
  "owner": "you",
  "work_state": "in_verification",
  "human_action": "decide",
  "updated": "2026-10-08",
  "decision": {
    "id": "102eac2d-bfd1-4624-9fff-df3e4329d40c",
    "mode": "single",
    "question": "Must a frozen candidate guarantee it holds ONLY its own ticket lines, or only that the exact frozen, verified bytes are what gets committed?",
    "options": [
      {
        "key": "A",
        "label": "Rescope to frozen-byte integrity",
        "what_changes": "Keep round 2 and promise only \"commit exactly the verified frozen bytes\"; a later unclaimed edit is a named residual; publish only via the project commit authority (FEAT-164)",
        "benefit": "Small build, no new surface; matches the verify-and-commit need",
        "cost": "A foreign line can ride into a commit when a lane skips claim (normal concurrent timeline)",
        "why_not_obvious": "The original ask was per-ticket commits, which assumes attribution"
      },
      {
        "key": "B",
        "label": "Bounded mutation ledger",
        "what_changes": "Hooks serialize edits to claimed files, journal before/after bytes, refuse ambiguous intervals; needs the hook lane code",
        "benefit": "Attribution on the normal timeline without per-ticket copies",
        "cost": "Holds only over mediated writers; refusal/wait rate unmeasured; whole Bash calls count as windows",
        "why_not_obvious": "The cheapest real attribution, but its throughput price is unknown"
      },
      {
        "key": "C",
        "label": "Seal each lane in its own copy",
        "what_changes": "Per-ticket copy behind a mount namespace; station merges back; the repo history directory is read-only to lanes",
        "benefit": "Attribution and commit refusal by the kernel, for every project",
        "cost": "14 boundary surfaces still unspecified (broker, localhost API, sockets, fds, containers), two merge stages, changes every session and docker use",
        "why_not_obvious": "The only by-construction path, and the largest new surface"
      }
    ],
    "recommendation": "A",
    "recommendation_reason": "Rescope meets the stated need (verify and commit the exact frozen bytes) with no new surface. Measure how often a foreign line actually reaches a candidate before buying B or C; the OpenAI review says redesign is not yet earned.",
    "prerequisite": null
  },
  "decision_history": [
    {
      "id": "5764a060-b74a-48e7-a160-2f7a27b9ea18",
      "asked_on": "2026-10-07",
      "question": "How should frozen candidates reach projects other than Orchard (decide together with ARCH-013)?",
      "mode": "single",
      "options_keys": [
        "A",
        "B",
        "C"
      ],
      "chosen": null,
      "chosen_on": null,
      "chosen_by": null,
      "note": "Superseded unanswered on 2026-10-07 with board-tool decide --replace."
    },
    {
      "id": "3b9a6d53-e3dd-4118-b648-3e5832777821",
      "asked_on": "2026-10-07",
      "question": "x?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": null,
      "chosen_on": null,
      "chosen_by": null,
      "note": "Superseded unanswered on 2026-10-07 with board-tool decide --replace."
    }
  ],
  "success_criteria": [
    "independent-verify --candidate shows the verifier the frozen bytes on the freeze-time HEAD, even after a BUG-224-style whole-file restore of the live file.",
    "Any later change to a candidate's files, live or at HEAD, blocks its commit until re-frozen and re-verified; an older hash's HOLDS never counts.",
    "A second ticket freezing a file an open ticket owns is refused unless it declares the dependency.",
    "One user command commits a ticket's frozen bytes; the published tree is the verified tree, and other tickets' edits elsewhere stay uncommitted.",
    "foreign-report counts harm a month: committed foreign lines their owner later broke or changed. At 1 or more, ownership redesign reopens.",
    "No agent session publishes a commit: the project's git-write authority (FEAT-135) is the only check, and candidate commit has none of its own."
  ],
  "code_refs": [
    {
      "path": "scripts/independent-verify.mjs"
    },
    {
      "path": "scripts/lib/tree-snapshot.mjs"
    },
    {
      "path": "scripts/lib/file-lock.mjs"
    },
    {
      "path": "scripts/board-tool.mjs"
    }
  ],
  "related": [
    {
      "id": "BUG-224",
      "relation": "see_also"
    },
    {
      "id": "ARCH-013",
      "relation": "see_also"
    },
    {
      "id": "BUG-186",
      "relation": "see_also"
    },
    {
      "id": "FEAT-134",
      "relation": "see_also"
    },
    {
      "id": "FEAT-129",
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
      "run_id": "64ff5cb8-755b-4950-9dc6-f4f7e1c6763a",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T09:30:57.370Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "3f50654c-e45d-4331-9b23-9ae5a0494f1b",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T09:56:56.879Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "bcdc775c9b2b3e5058862b0a9dedc3cd6e524894d8d60a83cc2c92a34365d7ea"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "248ad5f9-f954-4e09-94a3-e99de3fa2d58",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T15:53:37.518Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "50f877ea7ad6766c32f54a664192041d3c71f9a1d3e7ade7eaee409f2be39ad8"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a11776-8fa1-72f2-b41a-2f05ddfa5c6d",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T17:46:57.688Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "5bc4ffad84a68bd0e4b85d72a7e919cc49768ca8dfe8a5b8806b18e757a0b8a1"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "run_id": "0b8d47da-7961-42a6-bcbe-3f39b556642c",
      "verdict": "invalid",
      "verdict_on": "2026-10-08",
      "recorded_at": "2026-10-08T08:30:17.542Z",
      "author": "worker (fixing, shadow pilot)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "x"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "6f369176-8425-4fd6-b63b-53a8d43b435a",
      "verdict": "broken",
      "verdict_on": "2026-10-08",
      "recorded_at": "2026-10-08T10:02:24.135Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "4c4bd7f629d2795d0a384731ed93bad7aabe07e0c90a8a3748eb92898f8f9f38"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "faa119a9-6fdc-441b-98c4-b0c0f0c5b9ff",
      "verdict": "broken",
      "verdict_on": "2026-10-08",
      "recorded_at": "2026-10-08T10:17:56.341Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "891bc0b2c9a78b321f0bcaa77b3f4640a07989c7bb1b2957f849b351e3ff6f8c"
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

# FEAT-170 — Verify a frozen copy of each ticket and commit exactly that

## Symptom
Many lanes edit one shared uncommitted tree. Verifiers hand-assemble their ticket's diff (86 of 211 verify lanes), a strip lane reverted BUG-217's finished wiring and produced a false BROKEN (BUG-224), a per-ticket commit failed on interleaved hunks (FEAT-169 with BUG-234), and the 10-06 batch commit put known-broken code on main.

## Evidence
Research: `~/.local/state/claude-station/scratch/process-research-2026-10-07/shared-tree.md` (sections 1-6) and `openai-review.md` (proposal 2 critique and proposal 3, immutable verify candidates plus integration ownership). The plan and its cross-provider review are in `~/.local/state/claude-station/scratch/candidates-2026-10-07/`.

## Verification plan
Each guarantee gets a must-FAIL-before / pass-after proof in a persistent suite, plus one run on a reflink copy of the real repo that replays the BUG-224 revert on `src/server/index.ts`.

## Diagnosis
The tooling that existed did not isolate a ticket at any step.
- `independent-verify --working-tree` (FEAT-134) snapshots the whole dirty tree, so every in-flight ticket's code is in the room and in the diff. BUG-186 strips only the board and methodology prose.
- The FEAT-129 lock belongs to a lane and is released when the lane ends. In BUG-224, BUG-217's lock was gone 4 seconds before the strip.
- A typed verdict names no candidate, so a HOLDS survives any later edit.
- BUG-224's strip helper was never built.

The fix is a frozen identity (a candidate), verification of exactly that identity, a verdict bound to it, refusal when ownership is ambiguous, and a commit published from the frozen bytes.

## Implementation notes
- **Candidate** (`scripts/lib/candidate-store.mjs`). At handoff a ticket's files are frozen:
  - bytes and mode for each file, content-addressed;
  - `base` = HEAD at freeze time;
  - dependencies pinned by candidate hash;
  - the recorded `--check` commands;
  - `tree` = base plus only these files. This is the source tree a commit onto `base` produces.

  The `hash` is sha256 of that identity. The store is `<git-common-dir>/orchard-candidates/`, never committed. It is write-once (0444) and re-hashed on every read.
- **Git use by lanes:** only what FEAT-135's shim allows lanes: read-only git plus `read-tree`, `add` and `write-tree` on a temp index. The frozen bytes are laid out in a private temp work tree and staged from there.
- **Verify** (`independent-verify --candidate <ID|hash>`). The candidate tree is re-built from the store and must equal the recorded tree. The room is that tree and the diff is `base..tree`, so live-tree edits made after the freeze cannot reach either. Verification refuses when the live lockfile differs from the candidate's, because the room copies the live `node_modules`. The record command it prints carries `--candidate`.
- **Verdict binding.** `board-tool verified --candidate <hash>` stores the hash on the typed entry, and only a hash the store can reproduce is accepted. A member is satisfied only by a HOLDS bound to that exact hash with no later BROKEN. A verdict on one hash never counts for another.
- **Ownership.**
  - `claim` at lane start records each file's pre-lane bytes; an overlap with another ticket exits 3.
  - `freeze` refuses a file that another open ticket owns, unless that ticket is a declared dependency (`--depends-on`, which makes a group).
  - `freeze` also refuses a file that already held others' uncommitted lines at claim time, unless `--accept-foreign` is given; that downgrade is recorded on the candidate.
  - The whole read-check-write runs under one store lock, and capture is double-read until stable.
- **Status (round 3: byte equality).** Each file is CURRENT (live bytes and mode equal the frozen ones), REVERTED (back to HEAD-at-freeze, or gone), CHANGED (any other difference), and/or STALE-BASE. Only CURRENT keeps a verdict valid. The round-1/2 textual classes (DRIFTED, OVERLAPPED) are gone: DRIFTED kept a file nobody re-verified counted as verified.
- **Base moved.** A commit is ready only when its tree was checked: either HEAD is still `base` (the verified tree), or `integrate` ran the recorded checks on the exact tree the commit makes. Integration records are keyed on that tree minus the board directory, which is prose the room never sees. `integrate --all` checks a chain, so the user can commit several tickets in order with no agent in between. A HEAD that changed one of the candidate's own files is STALE-BASE: re-freeze.
- **Commit** (`candidate commit <ID>`, the user's command). It has no agent check of its own; the project's git-write authority refuses its publishing calls in an agent session (round 3, below).
  1. It refuses if you have staged changes on the files it would write.
  2. It builds a temp index of HEAD plus the frozen blobs, and nothing else; its tree must equal the checked tree. Round 4 deleted `--with-ticket-file`: it staged the board file's live bytes after the tree check (verify 248ad5f9 #1). The board is committed separately with `board-tool commit`.
  3. It runs the repo's pre-commit hook (the leak gate over the staged bytes) and the commit-msg hook. It refuses if a hook changed what is staged.
  4. It creates the commit, then moves HEAD with an expected-old-value check, so nothing is published if HEAD moved meanwhile.
  5. It syncs the real index for those paths only.
  6. The `Orchard-Candidate: <hash>` trailer lets `ready` reconcile a crash that happens after the commit is published.
- **Edit-time guard: deleted in round 3.** `candidateWriteGuard` was never wired, and it parsed Bash text, which misses 6 of 9 everyday write paths (measured). Under the rescoped property a later write does not need preventing: it changes the live bytes, so the verdict stops counting and `ready` blocks.
- **Harm metric** (`candidate foreign-report [--days 30]`, `candidate foreign-found --id T --file f --owner U --line "<text>"…`). See round 3, below.

## Migration and rollback
The change is additive: new `scripts/candidate.mjs` and `scripts/lib/candidate-store.mjs`, `independent-verify --candidate`, and `board-tool verified --candidate`. `--working-tree` still works and now prints a note pointing at `--candidate`. Tickets already in flight keep today's flow until their next handoff. Rollback is to delete the two new files and revert the three small edits. The store directory in `.git/` can simply be deleted.

## Risks
- **Accepted residual: foreign lines.** A candidate is a *declared* bundle. If a lane that never claimed a file edits it between another ticket's claim and freeze, its lines ride into that candidate (round-2 verify 3f50654c #1). Claims narrow this (a file dirty at claim time, or never claimed, is refused unless accepted), and `foreign-report` counts the harm it does: a committed foreign line whose owner later breaks or changes it. At 1 or more a month, reopen the ownership redesign.
- **The integration check is mechanical.** It reruns the recorded checks on the exact tree after HEAD moves; it is not a new adversarial round.
- **Throughput.**
  - Every commit moves HEAD, so a second ticket needs an integration check (`integrate --all` pre-computes the chain).
  - Any later edit to a frozen file, including a disjoint hunk from another lane, now blocks that candidate until it is re-frozen and re-verified. Hot files feel this most; the way around it is to claim (exit 3 says who owns the file) and serialize or group.
- **Commit authority residuals** are FEAT-135's own: git by absolute path, or a scrubbed PATH. They belong to FEAT-164 / ARCH-021, not here.

## Draft for user approval — workflow and Working Agreement text (NOT applied)
Proposed CONVENTIONS.md section, "Freeze at handoff; verify and commit the candidate (FEAT-170)". Updated in round 3 to the rescoped property:

> **What it promises:** the commit for a ticket is exactly the frozen bytes that were verified, and any later change to those files invalidates the verdict. It does not promise that every line in a candidate is the ticket's own.
> **Fixer, at lane start:** `node scripts/candidate.mjs claim --id <ID> --files <files you will touch>`. If it exits 3, another open ticket owns a file. Coordinate with that ticket (group or serialize); never edit through it.
> **Fixer, at handoff:** `node scripts/candidate.mjs freeze --id <ID> --files … --check "<your fixer test command>"`. Cite the printed hash in the Activity log. A file that was dirty at claim, or never claimed, is refused; `--accept-foreign <file>` takes it in. That is shown as an informational count and does not trip the trigger.
> **Every lane:** do not touch another ticket's frozen file. Any change to it, even a disjoint hunk, blocks that ticket's commit until it is re-frozen and re-verified (`status` shows CHANGED or REVERTED).
> **Verifier:** `node scripts/independent-verify.mjs --candidate <ID> …`, never `--working-tree`. Record the verdict with the `--candidate=<hash>` the harness prints. If the candidate's diff holds lines that belong to another ticket, say so in the verdict.
> **Orchestrator:** when a verifier reports foreign lines, record them with their owner: `node scripts/candidate.mjs foreign-found --id <ID> --file <f> --owner <their ticket> --line "<exact line>" --note "<run id>"`. Without a known owner a shipped line can never count as harm. Before asking the user to commit, run `node scripts/candidate.mjs ready`; if HEAD moved, run `node scripts/candidate.mjs integrate --all`. Monthly, run `node scripts/candidate.mjs foreign-report`. If it says REVISIT TRIGGER REACHED, reopen FEAT-170's ownership redesign (ledger or sealed copy).
> **User:** `node scripts/candidate.mjs ready`, then for each READY line, in order: `node scripts/candidate.mjs commit <ID>`. Agents cannot publish this commit; the FEAT-135 git-write shim refuses it.

This would replace the restart-checkpoint protocol's hand-made `pre/` snapshots for unfrozen work: `claim` records the pre-lane bytes. Stripping a *frozen* file invalidates that ticket's verdict, so a strip leaves frozen files alone.

There is no hook wiring to draft any more: round 3 deleted `candidateWriteGuard`.

## Redesign (round 3) — one authority: the lane's mount namespace

The two-break rule fired, so this replaces the round-1/2 mechanism. Evidence is in
`~/.local/state/claude-station/scratch/f170r3/`. Runnable: `namespace-proof.sh` (log
`namespace-proof.log`), `chokepoint.sh`, `textgate.mjs`.

### Invariants
- **(2)** A candidate contains exactly the bytes its own lane wrote, and nothing else.
- **(3)** No process an agent starts can write git state of a real repo. That holds whatever its env, its PATH or the git binary it calls.

The test for both: a property holds only if no write path exists, not if every write path we know of is checked.

### Why rounds 1–2 could not hold
- **(2)** Ownership was inferred after the fact, from the bytes in a tree every lane can write. Each break was a timeline the inference did not model:
  - round 1: freeze without claim;
  - round 2: a second ticket edits after a clean claim.

  The edit-time guard the hypothesis proposed does not change this. It parses Bash text, so it is the same enumeration. Measured: FEAT-129's `classifyMutation`, which the guard uses, misses 6 of 9 everyday write paths (`>>`, `node -e`, `python3 -c`, eval `$f`, `npm run …`, a node codemod file). See `textgate.mjs`.
- **(3)** No signal inside the agent's own uid is unforgeable. Measured in an agent session:
  - The agent is uid 1000, the user's own uid, in groups `docker` and `wheel`.
  - Its systemd scope sits under a user-owned `app.slice` (`cgroup.procs` is owned by the session user), so it can move itself out.
  - `systemd-run --user` and Hyprland IPC (`hyprctl dispatch exec`) start processes outside its ancestry.
  - The FEAT-135 shim is a PATH prefix, and its own header documents the absolute-path bypass.

  So an env check, ancestry, cgroup, and the shim are all forgeable.

### Options priced
**A. One owner per file in the shared tree, gated at edit time.**
- Text gating misses 6 of 9 paths. Gating it in the kernel instead (a per-file read-write bind in a read-only tree) blocks all foreign writes (7/7). But it also breaks 2 of 7 legitimate writes to the lane's own file: `sed -i`, and any write that renames a temp file into place, need a writable directory (measured, `chokepoint.sh`).
- The ownership set changes mid-lane, so every Bash call needs a new sandbox.
- Throughput: ownership lasts until commit. With today's cadence (4 commits in 30 days, HEAD 5–15 days behind), every same-file pair in a window serializes: 358 pairs a month, versus 31 concurrent. `public/app.js` had 13 tickets in one window and `index.ts` 27, so each hot file runs one ticket at a time, gated on the user committing it.
- Option D's lane-scoped estimate was already 15–30 h of delay a month; ticket-scoped is a multiple of that.
- Declared groups avoid the wait, but they turn hot files back into batch blobs.

**B. A private copy per ticket, behind a kernel seal (chosen).**
- Each ticket gets a reflink copy of the shared tree. Measured: tree 225 ms plus `node_modules` 1.0 s, with ~0 disk on btrfs. That is about 7 lane-min a month at 361 lanes.
- The lane's session runs in a mount namespace (bwrap): `/` read-only, only its ticket copy and scratch read-write, `/run` and `/tmp` private, `--disable-userns`.
- What changed is `copy − base`, exactly, because nothing else can write the copy. No claim and no attribution are needed.
- The commit tree is `diff3(HEAD, base, final)`. It is HEAD plus only the lane's own changes. A hunk that overlaps foreign work conflicts and is refused.
- Merge-back into the shared tree (for the live service and later lanes) is `diff3` run by one writer, the station, at handoff. An overlap is refused with the shared tree untouched, and the lane re-bases inside its own copy.
- Price:
  - About 31 concurrent same-file pairs a month. About 8 likely conflicts at roughly 10–15 agent-min each, so 1.3–2 h a month. This is the research's lower-bound proxy, not a measurement.
  - In-progress edits are visible to the live service only from handoff on.
  - **No user git work is added.** The user still runs `candidate ready` and `candidate commit <ID>`.

**Neither option holds by edit-time inference.** B holds by construction for file writes, and the same seal gives (3): the real repo's `.git` is read-only inside the namespace.

### Proofs already run (`namespace-proof.log`: 15 pass, 1 fail, plus 1 open residual)
- **R1** A pre-existing foreign line is absent from A's diff and from A's commit tree.
- **R2** B's later line is absent from A's diff. All 6 of B's write paths onto A's copy are refused, and all 6 onto the shared tree.
- **Merge-back** Disjoint A and B both survive. An overlapping D is refused with rc=1.
- **(3)** Each of these writes into `.git` is refused with EROFS:
  - `touch HEAD.lock` (`env -i`);
  - `node` writing `index.lock` with the session vars unset;
  - `python` making `refs/heads/x.lock`;
  - `cp` onto `ORIG_HEAD`.

  Read-only `git log` still works. Every git ref and index write needs a `*.lock` created in `.git`, so EROFS there refuses all of them. The BEFORE case is reproduced: an env-unset agent passes today's `agentSession()`.
- **Controls** The same writes succeed outside the namespace (on scratch copies). Remount read-write, and a nested user namespace with a rebind or remount, are both refused because the mounts are locked.
- **Escape doors** The user bus, `/run/docker.sock`, Hyprland IPC and `systemd-run --user` are unreachable inside.
  - **FAIL:** `DOCKER_HOST` (the FEAT-158 sandbox daemon) is still reachable. That daemon is a privileged dind with host `/tmp` and scratch mounted read-write, which makes it a host-root door.
  - **OPEN (residual R-net):** localhost TCP, including Orchard on :3210.

### Design
1. **Ticket copy** (`scripts/lib/ticket-copy.mjs`, host side). The copy lives at `<state>/ticket-copies/<project-key>/<TICKET>/`, taken from the shared tree at the first lane. Its base is recorded by the station as a git tree on the host; the station is not an agent. Later rounds reuse the copy. Starting a new round runs a `diff3` refresh from the shared tree inside the copy.
2. **Seal** (`scripts/lib/lane-seal.mjs`). This builds the bwrap argv:
   - `--ro-bind / /`, `--bind <copy>`, `--bind <session scratch>`, plus the CLI's own state directories;
   - `--tmpfs /run --tmpfs /tmp`, `--disable-userns`, `--die-with-parent`;
   - no `DOCKER_HOST`, and only the dispatch socket re-bound.

   It is wired as `spawnClaudeCodeProcess` (the seam containers already use) and as the codex child spawn. In containers it becomes a mount flag instead: repo and `.git` read-only, the copy read-write.
3. **Candidate = copy.** `freeze` records `(base tree, copy tree)` and the commit tree `diff3(HEAD, base, final)`. These are deleted: `claim`, `--accept-foreign`, foreign-at-claim, DRIFTED/OVERLAPPED attribution, `candidateWriteGuard`, and `agentSession()`.
   - Verify, the hash-bound verdict and the exact-tree integration rule stay as built.
   - `commit` runs only outside a seal. Inside one it fails with EROFS without any check of its own, so there is no second, weaker check.
4. **Single writer of the shared tree:** station merge-back at handoff. It also replaces the FEAT-129 lock and BUG-224's strip protocol. Nothing else writes the shared tree once phase 2 lands.
5. **Reach (ARCH-013).** Every session in every project is spawned by the station, so the seal is a launcher capability with nothing copied into project trees. This settles this ticket's pending A/B/C delivery decision as A, and makes it necessary: a guard copied into a project tree is writable by the agent it guards. ARCH-013's option C composes, since dispatch can refuse a verify round with no candidate. Projects without git still get isolation; commit does not apply there.

### Migration
- **Phase 0** (no restart): build the library and the suite. Nothing is wired, and today's flow is unchanged.
- **Phase 1:** a flag makes `ticket=` lanes sealed. This needs the hook/runtime lane (`claude-runtime.ts` is theirs) and a user restart.
- **Phase 2:** all agent sessions are sealed, with orchestrators getting the shared tree read-only.
- **Phase 3:** delete the superseded guards, per the deletion test.

Rollback is to turn the flag off.

Until phase 2, property (2) holds only between sealed lanes, because an unsealed session can still write a ticket copy.

### Proof bar
- R1, R2 and both round-2 verifier repros must FAIL on the round-2 code and pass on B.
- The 6-path write matrix from a sealed lane: foreign 0/6, own 6/6.
- `(3)` refuses an env-unset, absolute-path or node-spawned git write and allows read-only git.
- Every escape door is refused, including `DOCKER_HOST` and localhost TCP once R-net is closed.
- Merge-back refuses an overlap and leaves the shared tree byte-identical.
- A real lane round-trip through the actual `spawnClaudeCodeProcess` seam (phase 1).

### Design review: rescope, keep patching, or redesign (the coordinator's charter, chosen on evidence)
Reachability was measured over 1,871 orchard transcripts (`scratch/f170r3/reach.py`), excluding this lane's own probes.

**Property (3): rescope. It is not FEAT-170's to solve.**
- Deliberate circumvention is 0 cases. The only absolute-path git write is a test string in the policy suite.
- Accidental env scrubbing is real: 2 lanes spawned `env -i` children for unrelated reasons, which blinds any env check.
- An unforgeable "is an agent" signal for the same uid is exactly FEAT-164's open user decision (A: OS check plus seal, evadable; B: human credential; C: separate user or container). ARCH-021 is the same question for git-write enforcement.
- So FEAT-170 drops its own agent detection. `agentSession()` is deleted. `commit` creates its commit object before running any hook, so the project's one git-write authority (FEAT-135 today, whatever FEAT-164 decides tomorrow) refuses an agent before any side effect. This holds under every FEAT-164 outcome.

**Property (2): of the three outcomes, only a redesign holds on the reachable timeline.**
- **Rescope loses.** Round 2's path is the normal concurrent timeline (31 concurrent same-file pairs a month, a lower bound), not a synthetic one. "Exactly its ticket's bytes" is the ticket's whole purpose.
- **Keep patching loses.** The best bounded patch is a hash ledger at tool-call boundaries: every session's Pre/PostToolUse hook hashes claimed files, and a change outside the owner's windows taints the file. Bash writes stay visible as changes, but attribution is ambiguous whenever another lane's tool call overlaps the owner's. Long test runs make that the common case, so the patch either floods false refusals or accepts a residual on the most frequent timeline. It also needs the same hook wiring in the other lane's file.
- **Redesign (the seal) holds by construction for file writes**, measured above. It adds real surface, and history says redesigns break again (9 of 10, per `redesign-history.md`). Predicted seams:
  - the CLI's writable state directories;
  - the dispatch broker running work outside the seal;
  - localhost APIs (R-net);
  - a planted hook or script that later runs as the user;
  - `diff3` semantics (renames, binary, deletes);
  - stale copies.

  It removes more than it adds only counted across tickets. It replaces `claim`/`--accept-foreign`/attribution, `candidateWriteGuard`, the FEAT-129 lock, BUG-224's strip protocol, and the text-parser enforcement ARCH-021 calls fail-open. It also is FEAT-164's option C.

**Therefore this is the user's decision, not a lane's.** Sealing changes how every session in every project runs (N1, N2) and overlaps FEAT-164's pending choice. The alternative is honest: keep round 2's detection and state residual R2 (a hunk edit by an unclaimed lane after a clean claim is swallowed) as a known limit. Then FEAT-170 promises "verify and commit exactly the frozen bytes", not "the frozen bytes are only this ticket's".

### Needs user
- **N1:** in-progress lane edits reach the live tree only at handoff.
- **N2:** sealed lanes lose host docker (the `docker` group is root-equivalent). The FEAT-158 daemon is a privileged dind with host `/tmp` read-write, so it must go rootless or not be reachable from sealed lanes.
- **N3 (R-net):** localhost services (Orchard :3210, mongo, redis) stay reachable. The choice is between `--unshare-net` with pasta, and the station authenticating sealed callers.
- **N4:** with `.git` read-only, git in scratch fixtures is safe. Should the shim/hook stop refusing it? That would retire most FEAT-158 use.
- **N5:** a restart for phase 1.

### Plan review (OpenAI, codex transcript `01a11661-95af-7412-a946-7cf008929872`): REJECT, and the outcome
The review is saved at `scratch/f170r3/review-1-openai-REJECT.txt`. Adopted, with no rejections:
1. **The seal does not hold by construction as planned.**
   - The launcher in the plan omits protections that the proof used (PID/proc isolation, `--dev`); `--disable-userns` needs `--unshare-user`.
   - Unspecified surfaces: the CLI's writable state, the host dispatch broker (`dispatch-broker.ts:580`), localhost API grant routes, abstract or other unix sockets, inherited fds, `/proc/<pid>/root` and ptrace, docker, container mounts, and executable content that later runs as the user.
   - Refreshing a copy imports bytes the lane did not write, so the base needs immutable generations.
   - A writable copy is not a frozen candidate.
2. **`diff3` is a text rule, not attribution.** It conflicts on adjacent edits and merges a semantic dependency cleanly but broken. It has no model for deletes, renames, modes or binaries, and merge-back needs a whole-tree transaction.
3. **A is not proven dominated.** B's second merge, onto HEAD, was never priced. A bounded ledger, which serializes admitted mutation windows, journals before/after bytes and refuses ambiguous intervals, is a cheaper option whose refusal rate is unmeasured.
4. **The ARCH-013 composition was asserted, not designed.**
5. **Phase 1 can only be a non-enforcing pilot.**
6. **The (3) patch fails its own contract**, so it is NOT applied; it stays in `scratch/f170r3/patched/`.
   - `reconcileCommitted`/`buildTree` mutate the store and object database first, and `git add` runs filters, all before `commit-tree`.
   - An inherited `GIT_INDEX_FILE` makes the real shim sanction `commit-tree` (`decideGitShim`), so hooks would still run.
   - A draft commit object would exist before the leak gate.
   - The fixture authority modelled the wrong policy.

   A correct (3) rescope is a *publication* contract: nothing is published except through the project's configured git-write authority, with FEAT-164's residuals. It is not "refuses agents".

**Outcome: nothing built.** The review's own answer to 7(c) is that this is a genuine user decision once the options are stated correctly: is exclusive attribution required, or only exact frozen-byte integrity? It is now this ticket's decision card. The delivery question (A/B/C below in history) depends on it and is asked afterwards.

## Round 3 outcome — rescoped to frozen-byte integrity (decision A, built)
The orchestrator chose option A on the card above. The seal design (B in the redesign section) and the ledger were not built.

**The property, one sentence:** what gets committed for a ticket is exactly the frozen bytes that were verified, and any later change to those files invalidates the verdict.

**Accepted residual:** foreign lines can ride along in a candidate when the other lane never claimed the file (round-2 verify 3f50654c #1). The suite states this as a check (S1), so it is not hidden.

**Revisit trigger: harm, not presence** (changed at the coordinator's request before verification). A foreign line riding along is exactly the residual the rescope accepts, so its presence does not count. `node scripts/candidate.mjs foreign-report [--days 30] [--json]` counts a **committed** foreign line only when its owning ticket, after that commit:
- gets a BROKEN verdict bound to a candidate whose change touches that line; or
- changes or removes that line in a candidate it freezes.

Only the owner's own recorded events count, never live-file state. Round 3 also counted a line vanishing from the live tree, but that could be a third lane's edit and raised a false trigger against an innocent ticket (verify 248ad5f9 #2); round 4 removed it.

That is unverified or half-done work that actually shipped under the wrong ticket. At harm of 1 or more in the window (by when the harm became visible), it prints `REVISIT TRIGGER REACHED`: reopen the ownership redesign (B ledger, C sealed copy).

- **Whose line it is.** Either the orchestrator records it, with the owner and the exact text, using `foreign-found --owner <ticket> --line "<text>"`, usually from a verifier's report. Or it is inferred: another ticket's candidate, frozen before the commit, added that exact line in that file.
- **No known owner.** The report counts such a line as `unowned`, but it cannot count as harm. Recording the owner is what makes it countable. This is the honest limit of the metric: an unclaimed lane's line has no mechanical owner.
- **Matching** is by exact line text. Lines shorter than 6 characters, or punctuation-only, are ignored as too common to attribute.
- **Informational, never the trigger:** lines taken in with `--accept-foreign`. *Accepted* counts lines that already differed from HEAD at claim time; *unattributed* counts a never-claimed file's whole change, latest freeze per ticket. *Reported* counts the `foreign-found` lines.

**Property (3), agent sessions, rescoped the same way.** The FEAT-135 git-write shim is the single authority that stops agent commits.
- `agentSession()` and the env check at the top of `commitCandidate` are deleted. So is the suite's `ORCHARD_CANDIDATE_TEST_COMMIT` seam, which existed only to get past that check.
- The check was a second, weaker authority: an env-scrubbed child passed it (round-2 verify 3f50654c #2), and the shim was what actually stopped the commit.
- The contract is publication, not "refuses agents" (OpenAI review point 6). In an agent session the shim refuses `commit-tree` outside a temp index, plus `update-ref` and `reset`, so nothing is published. Steps that run before that write only what agents may write anyway (the store, temp-index objects), plus whatever the repo's own pre-commit and commit-msg hooks do.
- With an inherited temp `GIT_INDEX_FILE`, `commit-tree` is sanctioned and leaves an unreachable commit object. `update-ref` is still refused. Proved in S3.
- Small fix found while proving it: a refused `update-ref` used to be reported as "HEAD moved". It is now `publish-refused`, with the authority's message.
- Residuals are the shim's own: absolute-path git and a scrubbed PATH (FEAT-164 / ARCH-021). The ticket rewrites earlier in this body (the redesign's "commit runs only outside a seal" and "delete agentSession()") are superseded by this paragraph.

**Dropped (no longer needed for the property):**
- the textual DRIFTED/OVERLAPPED classifier (`overlapReport`); status is now byte equality;
- `candidateWriteGuard` and the `candidate guard` verb;
- `agentSession()`;
- claim-time bytes as a revert reference. A restore to claim-time bytes is now simply CHANGED.

**Kept (protects the property or feeds the metric):**
- the content-addressed write-once store, re-hashed on every read;
- `--candidate` verify and the verdict bound to the hash;
- the exact-tree integration rule;
- STALE-BASE;
- atomic `update-ref`, staged-path refusal and the trailer reconcile;
- `claim`, ownership refusal (exit 3, `owned`) and the foreign-at-claim and unclaimed-dirty refusals with `--accept-foreign`. These are what make foreign lines *found* and counted. Without them the metric would read 0 for everything.

**Proofs** (persistent suite `scripts/verify-feat-170-candidates.mjs`, run in the FEAT-158 Docker sandbox on scratch copies; logs in `~/.local/state/claude-station/scratch/f170r3/rescope/`, runner `run.sh`):
- Rescoped code (round 4): **93 passed, 0 failed** (`after.log`). Both round-4 checks tagged `[must-FAIL on round 3]` failed on the round-3 code (`r3-before.log`: 90 passed, 3 failed, the third a cascade).
- Round-2 code with the same suite: **68 passed, 25 failed** (`before.log`).
  - All 10 checks tagged `[must-FAIL on round 2]` fail there and none pass. Among them, round 2 committed FEAT-169 from its frozen bytes while the live file held a later foreign hunk.
  - The other failures are cascades: P5 steps after that wrong commit, the P10 state renames, the harm-metric checks for a verb round 2 lacks, and the S3 `head-moved` mislabel.
- Harm trigger (S1). Both harm kinds count, with an explicit owner (changed) and with an inferred one (BROKEN). The negative controls stay at 0: a third lane deleting a shipped line from the live file, hot-file `--accept-foreign` (informational 2 + 1), a recorded line not yet committed, a shipped line its owner left alone, and an owner's BROKEN that does not touch the line.
- Round-1 stale PASS (64ff5cb8 #1: a board-only HEAD move reusing an integration PASS): R1 passes. Round-1 revert (64ff5cb8 #3: an accepted-foreign file restored to HEAD read DRIFTED and READY): R3 passes. The same round's Part A control, a disjoint later edit that read DRIFTED and READY, is now CHANGED and blocks (S2, P3).
- `npm run gate`: PASS (leak gate, check-nul, typecheck).
- Not re-run: the round-1 real-artifact replay (`real-artifact.mjs`). It drives the deleted guard and DRIFTED, so it would need rewriting first.

## Delivery to other projects — plan only (decided: host broker, the earlier card's option A; NOT built)
1. **One copy, host side.** The candidate verbs run from the Orchard checkout's `scripts/candidate.mjs` and `scripts/lib/candidate-store.mjs`. Nothing is copied into project trees, because a copy in a project tree is writable by the agent it is meant to constrain.
2. **Route.** The station's dispatch broker gains `candidate <verb>` for the agent-runnable verbs: claim, freeze, status, ready, integrate, show, foreign-report and foreign-found. It runs the library against the project's registered repo path, which comes from host config, not from the caller.
3. **Identity.** The broker takes project and ticket from the session's dispatch identity (its `ticket=` label). It refuses a claim or freeze for any other ticket and maps container paths to host paths with the existing mount table, refusing any path that escapes the repo.
4. **Never `commit`.** The broker runs on the host, outside the shim. Brokering `commit` would let an agent's request publish through a process no git-write authority sees, which would be a new authority. Commit stays the user's terminal command: `node <orchard>/scripts/candidate.mjs commit <ID> --repo <project>`.
5. **Verify.** `independent-verify --candidate` already runs host side. ARCH-013 option C composes with this: dispatch can refuse a verify round that names no candidate.
6. **Open items to settle when building:**
   - Verdict source for projects without an Orchard board. `ticketSatisfied` reports "no verdict source" and `ready` blocks. Use the host-side ledger, or the project's board if it has one.
   - `integrate` checks for container projects need the project's toolchain, so they run in the project's image with the exported tree mounted.
   - Non-git projects get no candidates (a base needs git).
7. **Proof bar:**
   - a container project's freeze → verify → user commit round-trip;
   - a broker request for another ticket is refused;
   - a path escape is refused;
   - an agent cannot reach `commit` through the broker;
   - the store lives in that project's `.git`.

## Shadow-repo pilot — agents get git, the real repo stays the user's (plan, 2026-10-08)
Source: `scratch/process-research-2026-10-07/agent-vcs.md` §11 and its OpenAI refutation (9 findings, all binding). This section is the plan; the build log is in the Activity log.

### Invariant
1. **No agent git write changes the real repo.** Refs, index, config, hooks, reflogs, objects and the working tree are never changed through git by an agent. The only way into real history is the user's `candidate commit`, run by the user or under their per-project grant. Push stays the user's.
   - Unchanged, existing exception: FEAT-170 `claim`/`freeze` write the candidate store and unreachable objects into the real `.git`. They never write a ref.
2. **A landing never silently loses a live edit.** Landing a ticket into the shared tree writes only that ticket's own diff. A file that someone else changed in an overlapping place is refused loudly, and nothing is written.
3. **Promotion commits exactly the landed bytes.**

### Design (plain git, no new VCS)
- **Shadow root:** `~/.local/state/claude-station/shadow/` (`$XDG_STATE_HOME` honoured on the host only).
  - One directory per project: `<slug>/`, where slug = basename + 12 hex of sha256(realpath of the top).
  - Each pilot ticket gets its **own independent git repo** at `<slug>/lanes/<TICKET>/`, with its own work tree, objects and refs.
  - Lanes are not worktrees of a shared hub. Refs are not shared, so one lane cannot delete another lane's history, and there are no alternates, so the real repo's gc can never corrupt a lane. Research finding 8 allows either engine; this is the smaller failure domain.
- **Byte exactness:** the lane config sets `core.autocrlf=false`, plus `.git/info/attributes` = `* -text -filter -ident`. Blobs are the raw bytes, so a landing round-trips them exactly (CRLF, exec bit, symlinks).
- **Records** (all under the root, so agent-writable, same uid):
  - `lanes/<T>.json`: the lane's meta (seed, base, pending base, landings).
  - `landings/<T>.jsonl`: per-path pre-land and landed sha256, kept in `objects/` so a land can be undone.
  - `metrics.jsonl`.

### How a lane gets a shadow copy (fresh base)
- The orchestrator runs `node <orchard>/scripts/shadow.mjs lane-new <T> --repo <project> [--deps node_modules]`.
- The seed is the shared tree **now**: every non-ignored file from `ls-files --cached --others --exclude-standard` (a read on the real repo).
  - Those files are hashed into the lane repo (`hash-object -w --no-filters --stdin-paths`), and a tree is built on a temp index under the root.
  - The result is committed as `seed`, and the lane work tree is checked out from it.
  - Other lanes' uncommitted edits are in the base, so it is not a stale HEAD.
- `--deps` copies the named ignored dirs with `cp -a --reflink=auto`. It never symlinks (BUG-112).
- The lane works with ordinary git. The text hook refuses a typed `git commit`, so a Claude lane runs `node <orchard>/scripts/shadow.mjs run <T> -- <git args>`.
  - `run` execs `git` via PATH (the shim) with cwd = the lane.
  - The command text has no `git <verb>` for the hook to misread. Codex lanes can type `git` directly in the lane dir.
- `sync <T>` snapshots the current shared tree as a commit whose parent is the lane's base, and merges it into the lane. Conflicts appear as normal git conflicts in the lane, and the agent resolves and commits them. This is how a refused landing gets fixed.

### The landing step (explicit; no automatic merge into the live tree)
`shadow land <T>`:
- **Refusals:**
  - a dirty lane work tree;
  - a base (last landed tip, or the synced snapshot) that is not an ancestor of the tip.
- **Per changed path P (base → tip):**
  - base bytes `b`, lane bytes `t`, live bytes `l`;
  - `l == b` → write `t`, or delete;
  - `l == t` → no-op;
  - otherwise a 3-way `git merge-file -p` (base `b`, ours `l`, theirs `t`) on temp files under the root:
    - clean → write the merge (no loss on either side);
    - any conflict, a binary file, add/add or modify/delete → **OVERLAP**.
- **Atomic:**
  - Everything is computed first under a per-project land lock.
  - Any OVERLAP → exit 3, nothing written, and the overlapping files and line ranges listed.
  - Otherwise each live file is re-read and compared (CAS), then written by temp + rename with its mode preserved. A failed write rolls back from the stored pre-land bytes.
  - The landing record (pre and post sha256 per path) is written before the files and marked done after.
- **Ownership:** `land` claims the landed paths through `candidate claim` at the pre-land bytes, so FEAT-170's foreign-line accounting stays true.
- **After a landing,** base = the landed tip. A later `land` lands only the new commits.
- `unland <T>` (the user's or orchestrator's undo) restores the pre-land bytes of the last landing. It is all-or-nothing, and it refuses any path changed since that landing.

### Interplay with the shim — decided from the resolved repo, never from text
- **Where:** in `git-shim.mjs`, after the existing read and temp-index allows, before the host consult. The resolver is new: `scripts/lib/shadow-guard.mjs`.
- **Baked root:** `installGitShim` bakes `shadowRoot` into the generated shim, like `hostUrl`. It is the realpath, computed host-side, so no runtime file changes; no env value is trusted. At decide time, realpath(root) must still equal the baked value. Otherwise every shadow allow is off.
- **Allowed only when all of these hold:**
  1. Platform is not win32.
  2. Global options are parsed strictly (`-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--bare`, `--no-pager`, `-P`, `--no-optional-locks`, `--literal-pathspecs`, …). An unknown global option → not shadow.
  3. Resolution is done by the **real git**, with the invocation's own global options and env: `rev-parse --path-format=absolute --git-dir --git-common-dir --git-path index --git-path objects --is-bare-repository`, then `--show-toplevel` for a non-bare repo.
     - realpath of each must be inside the root: git dir, common dir, index file's parent, objects dir and work tree.
     - So `GIT_DIR`, `--git-dir`, `.git` gitfiles, `commondir` files, `core.worktree`, `GIT_INDEX_FILE` and `GIT_OBJECT_DIRECTORY` all redirect *into* this check.
  4. **No symlink anywhere** under the git dir and common dir (objects included), and no hard-linked file outside `objects/`. git's lockfile writes through a symlinked `config`/`packed-refs`/`refs`, and gc through a symlinked `objects`.
  5. **Verb allowlist** (deny-by-default). Never allowed: `push`, `send-pack`, `clone`, `submodule`, `worktree`, `maintenance`, `credential*`, aliases and any unknown verb.
     - `config` is local only: no `--global`/`--system`/`--file`/`-f`, and `GIT_CONFIG` unset.
     - `merge-file` only with `-p`; `apply`/`am` never with `--unsafe-paths`.
     - `GIT_SHALLOW_FILE` set → refused.
  6. `init` (the repo does not exist yet) only for a fresh target: the realpath of its nearest existing ancestor is inside the root; no `.git` already exists there; no `--separate-git-dir`; no `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR`.
- **Pinned exec:** the shim execs the real git with `GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_OBJECT_DIRECTORY` set to the resolved realpaths, and `--git-dir`/`--work-tree`/`--bare` stripped from argv. A gitfile or `commondir` swapped after the check cannot redirect the write.
- **Outside the root,** everything is exactly as today (temp-index plumbing, then host grant, then deny). Resolution failure → treated as a real repo → today's path. Fails closed.
- **No leak gate on shadow writes:** nothing there is published. The gate stays on the real-repo path and at `candidate commit` (the repo's hooks).

### Grants and candidates (promotion)
- **Agent-runnable:** `shadow freeze <T> [--check "<cmd>"] [--accept-foreign <f>…]`.
  - Files = the union of the ticket's landed paths. It **refuses** if any live file differs from its last landed bytes ("changed since landing").
  - Otherwise it calls FEAT-170 `freezeCandidate`, so the candidate's frozen bytes are the landed bytes.
- Then the usual path: `independent-verify --candidate <T>`, then `board-tool verified --candidate <hash>`.
- **The user's one command:** `node ~/projects/orchard/scripts/candidate.mjs commit <T> --repo <project>`. The FEAT-170 property (commit = frozen bytes) carries "commit = landed bytes".
- Under a FEAT-164 permanent grant, the same command may run unattended; that is the user's existing decision on FEAT-164. Nothing here adds a commit authority.

### Failure modes and where it degrades (each fails closed)
| Where | What happens |
|---|---|
| Container projects | The shadow root is not mounted and container git is unshimmed. `shadow.mjs` refuses inside a container (`/.dockerenv`, `/run/.containerenv`). **No protection claimed for containers.** The pilot excludes container projects. The real `.git` RW mount is the other lane's work. |
| Native Windows | Orchard requires WSL2. `shadow.mjs` exits 2 on win32, and the shim's shadow allow is off on win32. |
| WSL2, project on `/mnt/c` | Works (the root is on the Linux FS). The mode is kept from the live file unless the lane changed it; bytes are exact. |
| Non-git project, or no HEAD | `lane-new` refuses on a non-git project. With no HEAD, `lane-new` and `land` refuse too (verify 0b8d47da): without a base commit, REVERTS-FOREIGN has no line provenance, and promotion needs a base. |
| Absolute-path git, scrubbed PATH, same-uid file tamper (rm, rewriting `.git`, moving a real repo into the root) | Existing shim residuals, unchanged. Stated, not closed. |
| Symlink planted inside a lane `.git` between the walk and exec | Residual race; needs a concurrent adversarial process. Gitdir redirects are closed by pinning. |
| Typed `git commit` in a lane (Claude) | The text hook refuses it (a false refusal, safe). Use `shadow.mjs run`. A `-m` message containing "git <word>" may false-trigger (BUG-232); use `-F`. |
| A non-pilot lane whole-file-Writes a file during a landing | CAS catches a write before the rename. A stale whole-file Write after it is today's exposure, unchanged. |

### Pilot scope and metrics
- **Scope:** a ticket enters the pilot only when, at dispatch, another in-flight lane is editing one of its expected files (a FEAT-129 lock, a candidate claim, or the orchestrator's charter). Everything else keeps today's flow. Container projects are excluded.
- **Collection:** `shadow.mjs` appends an event to `<slug>/metrics.jsonl` on every lane-new, sync, land, unland and freeze. `node scripts/shadow.mjs metrics [--days 28] [--json]` aggregates them, and the orchestrator pastes it into this ticket weekly.

| Metric | Definition |
|---|---|
| **Conflict rate** | OVERLAP-refused lands ÷ land attempts; also, sync merges that conflicted ÷ syncs |
| **Setup cost per lane** | lane-new wall ms (median, p90), files, bytes, deps-copy ms |
| **Foreign-edit incidents** | lands where at least one path had been changed in the shared tree since the lane's base by someone else. Split into merged-clean and refused; plus silent-loss incidents (target 0) |

- **Decision rule:** measured over 4 weeks or 10 lands, whichever is later. Default-on only if:
  - 0 silent-loss incidents;
  - setup p90 < 60 s on Orchard;
  - a refused land is resolved with one sync.
- Otherwise it stays opt-in.

### Migration
- Additive. There are new files plus one guarded hook in `git-shim.mjs`. Without a lane under the root, the shim decides exactly as before.
- Rollback: delete the shadow branch of `decideGitShim` and the root dir. No ticket, ref or real repo state depends on it.
- The CONVENTIONS/charter text for pilot lanes (below) is applied only after the verify.

### Proof bar (persistent suite `scripts/verify-feat-170-shadow.mjs`; runs in `scripts/confined-run.mjs`; each must FAIL before / pass after)
1. **Concurrent same-file:**
   - Before (shared tree, whole-file writes): one lane's edit is silently lost.
   - After: two lanes in one file land with both edits present; an overlapping edit is refused with exit 3 and the shared tree is byte-identical; sync, resolve and land then succeed.
2. **Real repo untouched:**
   - Before (the rejected design: allow when the cwd or text path is under the root): the redirect attacks change the real `.git` or work tree. The attacks are a gitfile, `GIT_DIR`, `--git-dir`, `core.worktree`, a `commondir` file, an objects/refs symlink, `GIT_INDEX_FILE`, `worktree add`, and `config --global`.
   - Also before: today's shim refuses a lane commit (no git space).
   - After: lane commit, reset --hard, branch -D, rebase and gc pass, every attack is refused, and the sha256 of every file in the real `.git` and work tree is unchanged.
3. **BUG-224:**
   - Before (shared tree): a lane `cp`s its pre-fix copy over a file and reverts another lane's landed fix.
   - After: the same `cp` inside the lane lands nothing for that file, and an older-copy revert overlapping the fix is refused. The fix survives every successful land.
4. **Promotion = landed bytes:**
   - Before: `git add <f> && git commit` after a post-land foreign edit commits bytes other than the landed ones.
   - After: `shadow freeze` refuses on that edit. On the clean path, `candidate commit` publishes blobs whose sha256 equals the landing record's for every path, and no other path.
- Regressions: the existing shim suites (FEAT-135, BUG-230, BUG-240, BUG-242) and `verify-feat-170-candidates`, then `npm run gate`.

### Pilot lane charter text (to apply after verify)
> You are in the shadow-repo pilot. Work only in `<laneDir>`. Commit freely: `node <orchard>/scripts/shadow.mjs run <T> -- commit -am "…"` (any local git verb works the same way; push/worktree/clone are refused). Never edit the shared tree for this ticket. When done, report your tip commit; the orchestrator runs `shadow.mjs land <T>`. If land reports OVERLAP, run `shadow.mjs sync <T>`, resolve the conflicts in the lane, commit, and ask for land again.

### Plan review 1 — OpenAI codex `01a11a83-56e7-7ab0-937c-68f54669838a`: REJECT (15 findings); disposition (this supersedes the plan text above where they differ)
| # | Finding | Disposition |
|---|---|---|
| 1 | Read-classified `diff --output` / `archive --output` and the temp-index allow run before any resolution | **Boundary stated, not built.** The invariant covers git *repository mutations*. A `--output=<path>` write is a plain file write, the same class as `cp`, which agents already have; the temp-index plumbing is the BUG-240 sanctioned exception, unchanged. Both are listed as residuals. |
| 2 | Hooks, filters and helpers; `apply --build-fake-ancestor`; fetch/pull | **Accepted, revised.** Every out-of-repo output option is refused in a lane: `--output*`, `--index-output`, `--build-fake-ancestor`, `--filter-to`, `--output-directory`, `--unsafe-paths`, `--separate-git-dir`. `format-patch`, `fetch`, `pull` and `remote` are removed from the verb list. Hooks, filters and editors run code with the agent's own privileges, which it already has, so they add no capability; this is stated. |
| 3 | `init` boundary | **Accepted.** `init` refuses `GIT_OBJECT_DIRECTORY` and `GIT_TEMPLATE_DIR`, runs with every other `GIT_*` stripped and `--template=` forced, and the next invocation re-validates the new repo. |
| 4 | Path-string pinning does not stop directory replacement | **Accepted as a residual.** The "absolute / fail-closed" wording is withdrawn for adversarial same-uid concurrent processes (lane dir or ancestor swapped between check and exec). It holds against an ordinary, careless invocation. |
| 5 | The root-wide allow lets lane A run `git -C <laneB>` | **Accepted, claim narrowed.** Lanes are separate repos, so a lane's git in its own cwd cannot touch another lane; deliberately targeting another lane path is allowed (same-uid, like `rm`). Binding to the dispatched lane needs runtime identity (the other lane's file), so it is a follow-up. Alternates (file or `GIT_ALTERNATE_OBJECT_DIRECTORIES`) are now refused. |
| 6 | The landing CAS is check-then-overwrite | **Accepted, revised.** Per path:<br>1. rename live → aside;<br>2. compare the aside with the planned pre-image (kind, mode, bytes);<br>3. install by `link()` (create-if-absent, so a file created at the path meanwhile is detected, never overwritten).<br>Any mismatch restores the aside and aborts. Rollback uses the same protocol. A pending journal blocks later lands, and `shadow recover` undoes a crashed landing. **Residual:** a writer holding the file open across the swap. |
| 7 | An older-copy revert after the seed already has the fix | **Accepted, revised.** **REVERTS-FOREIGN:** `land` refuses when the lane's change removes lines that were uncommitted in its base (present in the base, absent at real HEAD), unless `--allow-revert <path>` is given. That covers a pre-fix copy, `git show HEAD:f > f` and a stale `cp`. A fix already committed to HEAD is protected by history. |
| 8 | Typed entries, ancestors, NUL-safe snapshot | **Accepted.**<br>- Entries are `(exists, kind, mode, bytes)` everywhere.<br>- Every write path's existing ancestors must be real directories (no symlink); refused otherwise.<br>- Snapshot uses NUL-safe listing, skips deleted tracked files, and repeats until two passes give the same tree.<br>- Names with a newline are skipped and reported. |
| 9 | Check-to-capture gap in `shadow freeze` | **Accepted.** `freezeCandidate` takes `expect` (path → sha256/mode/deleted) and refuses before publishing if the captured bytes differ. |
| 10 | Filters at promotion | **Accepted, property restated.** Promotion commits the landed bytes *as git stores them*: committed blob = `hash-object --path=<p>` of the landed bytes with the real repo's filters, exactly what a hand commit stores. In a repo without filters that is the raw bytes. Raw-byte promotion would bypass the repo's own normalisation and is not wanted. The proof checks both. |
| 11 | Same-file tickets deadlock on ownership | **Accepted, workflow fixed.**<br>- `land` claims only paths no other ticket owns.<br>- `shadow freeze` checks live bytes against the latest landing of each path *by any ticket*.<br>- It auto-accepts paths that another ticket's standing landing touched (provenance recorded).<br>- It names the order: the owner freezes first, the other then runs `--depends-on <owner>`, giving one FEAT-170 group commit.<br>The proof covers the two-ticket, same-file promotion. |
| 12 | Fail-closed and eligibility claims | **Accepted.**<br>- Eligibility is host-side: `lane-new` refuses a project whose registry entry has `isolation: container` (container markers are a second check).<br>- `/mnt/c` (9p/drvfs) is detected: exec-bit changes are not landed, and case-colliding paths are refused.<br>- "Pilot refused" is worded apart from "repo protected".<br>- Projects with no Orchard board have no verdict source, so `candidate commit` refuses there (stated). |
| 13 | The metrics cannot show zero loss | **Accepted.**<br>- Events carry ids. A refused land links to the next successful land of the same ticket (syncs used, ms to resolve).<br>- Failures, races and crashes are counted.<br>- Before writing, `land` mechanically checks that both sides' added lines survive a merge; a violation is refused and counted.<br>- `shadow incident` records a reported loss.<br>- The report says that absence of reports is not proof of zero loss. |
| 14 | Strawman baselines | **Accepted.**<br>- P2's actual baseline is today's shim refusing a lane commit (capability missing). The attacks are acceptance tests, and the naive cwd-keyed allow is a labelled negative control proving each attack is real.<br>- P4's actual baseline is today's candidate freeze from live after a post-land edit.<br>- Also added: interrupted land, then recover; and full inventories (type, mode, link target, sha256). |
| 15 | Rollback deletes the undo history | **Accepted.** `shadow retire` refuses while any landing is unpromoted (it lists the `unland` commands). Otherwise it archives the project's records, never deletes them. |

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-07 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-07 — board tool
- **fixing lane round 1 — built and proved:** **Lane:** fixing, round 1, class plan+review. The user approved the build: "immutable verify candidates and hot-file ownership".

  - **Hypothesis check (done first): it holds, with three refinements.**
    1. The candidate is HEAD plus only the ticket's files, so the verified tree is the tree a commit produces.
    2. Ownership is per file, and a shared file becomes an explicit group. Attributing individual hunks is not feasible.
    3. The commit is built from the frozen bytes through a temporary index.

    What already existed:
    - `--working-tree` gives the verifier every in-flight ticket's code.
    - BUG-186 strips only the prose.
    - BUG-224's strip helper was never built.
    - The FEAT-129 lock is held per lane and was released 4 s before the BUG-224 clobber.
    - Typed verdicts carried no candidate.
  - **Plan review, cross-provider.** OpenAI codex thread `01a11585-5281-7860-87b9-afba8bb09231` asked for changes. The review is saved at `scratch/candidates-2026-10-07/review-1-openai-01a11585.txt`.
    - Adopted:
      1. A moved base no longer counts as safe just because the candidate's own files are untouched. The commit needs an integration check on the exact tree.
      2. Verdicts are no longer reused across hashes.
      4. Dependencies are pinned by hash and contribute their frozen bytes. Cycles are refused.
      5. The commit is published atomically against the HEAD it read (update-ref with the expected old value). Hooks run before publishing, staged changes on the same paths are refused, and a trailer lets a crash be reconciled.
      6. Targets the shell only knows at run time fail closed.
      7. Deletion anchors are tracked; binary, mode and symlink changes are treated conservatively.
      9. A lockfile that differs from the candidate's is refused.
      10. One store lock covers every check, a lock is broken only when its holder is dead, and the capture is read until two passes agree.
    - Accepted as documented limits: 3 (a candidate is a declared bundle) and 8 (ARCH-013 delivery stays with the user).
  - **Scope correction from the user (all projects).** The core is plain Node plus git plumbing and works on any git repo. The ARCH-013 composition and the delivery-vehicle decision are below.
  - **Built:**
    - New: `scripts/lib/candidate-store.mjs`, `scripts/candidate.mjs` and `scripts/verify-feat-170-candidates.mjs`.
    - Edited: `scripts/independent-verify.mjs` (`--candidate`), `scripts/board-tool.mjs` (`verified --candidate`), and `package.json` (`verify:feat-170`, `candidate`).
  - **Real finding during the build: the git shim.** FEAT-135's shim refuses `hash-object` and `update-index` in agent sessions. Every verb a lane uses now relies only on the sanctioned `read-tree`/`add`/`write-tree` on a temp index. This was proved in this agent session on the repo copy, below.
  - **Verified: suite.** `node scripts/verify-feat-170-candidates.mjs` gives **PASS: 76 passed, 0 failed**. Every guarantee has a BEFORE check that must fail on the old mechanism and an AFTER check on the candidate. The log is `scratch/candidates-2026-10-07/sandbox-run/run3.log`.
    - **Disclosure:** the suite's fixtures need `git init`/`commit` in throwaway repos, which the agent git-write block refuses. I therefore ran the suite inside the standing Docker sandbox (FEAT-158) on scratch fixtures, with the repo mounted read-only.
    - When I then tried to run the commit on the real-repo copy the same way, the Bash hook stopped it, and I did not route around it. That proof is left to you as one command (below).
    - In an agent session the suite now exits 2 with "COULD NOT RUN", never a PASS.
  - **Verified: real artifact.** `scratch/candidates-2026-10-07/real-artifact.mjs` ran in this agent session on a reflink copy of this repo, including other lanes' dirty `src/server/index.ts`. Result: **15/15 PASS** (log `real-artifact.log`).
    - Freezing `index.ts` was REFUSED because the file already held other lanes' uncommitted lines when BUG-217 claimed it. `--accept-foreign` froze it.
    - After a `cp` of the pre-lane copy over the file:
      - `--working-tree`: the room and the diff LACK BUG-217's wiring (exit 0; the diff spans 16 files). This is the 09-30 false BROKEN, reproduced.
      - `--candidate BUG-217`: the room and the diff CONTAIN it, and the diff is exactly that one file.
    - `status` shows REVERTED (exit 1).
    - The guard denies both BUG-224's literal loop and an explicit `cp`, and allows Edit.
    - The real `board-tool verified` refuses an unknown hash and records a bound HOLDS. `ready` is NOT ready while the file is reverted, and READY once the frozen bytes are restored.
  - **Regressions, with the files I touched in place:**

    | Suite | Result |
    |---|---|
    | verify-bug-225 | 95/95 |
    | verify-bug-186 | 12/12 |
    | verify-bug-182 | 21/21 |
    | verify-independent-verification | 103 PASS, 0 FAIL, then stopped at `git init` (agent git-write block) |
    | verify-feat-097 | stopped at `git init` (same block) |
    | verify-board-tool | 33/1. The same FAIL ("(c) restored row's title is DERIVED…", INDEX gen) also occurs with HEAD's `board-tool.mjs`, so it pre-dates this change. |

  - **Gate.** `npm run gate` exits 1 on the leak gate: 502 hits in 13 tracked files, none of them mine (mermaid.min.js, `leak-tokens.mjs`, which is dirty in the other lane, FEAT-130/BUG-236 tickets, …). check-nul and typecheck PASS. The leak gate run on copies of my 7 files gives PASS, 0 hits.
  - **Not done / handoff:**
    1. **Hook wiring** of `candidateWriteGuard` into the PreToolUse callback in `claude-runtime.ts`. The snippet is in "Draft for user approval"; that file belongs to the other lane today. Until it is wired, edit-time refusal is a tested library and nothing more.
    2. **The workflow/CONVENTIONS text** is drafted above, not applied, and waits on your approval.
    3. **Clean-room verify of FEAT-170 itself.** It needs a verifier sandbox that allows git in throwaway repos. Freeze its files first (`candidate freeze --id FEAT-170 --files <the 6 files> --check "node scripts/verify-feat-170-candidates.mjs"`), then run `independent-verify --candidate FEAT-170`.
    4. **The real-copy commit proof, for you to run in your terminal:**
       `node ~/.local/state/claude-station/scratch/candidates-2026-10-07/realcopy/scripts/candidate.mjs commit BUG-217 --repo ~/.local/state/claude-station/scratch/candidates-2026-10-07/realcopy`
       This touches only the scratch copy.
    5. **Delivery to other projects:** see the decision.
  - **Symptom of a deeper design flaw?** Yes. Verification state and commit state had no shared identity. ARCH-009 and ARCH-010 cover the record side; this ticket builds the identity, and ARCH-013 covers reach.

### 2026-10-07 — agent
- **Decision declared:** How should frozen candidates reach projects other than Orchard (decide together with ARCH-013)? Options: A — Host broker serves it; B — Copy into every project; C — Orchard only for now. Recommended: A — A is the only option that reaches container projects without copies. It also fits ARCH-013's recommended option C: dispatch can refuse a verify round that names no frozen candidate. Written to the record with board-tool decide; the Decide card reads the record, not this line.

### 2026-10-07 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 64ff5cb8-755b-4950-9dc6-f4f7e1c6763a — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — board tool
- **fixing lane round 2 — verify 64ff5cb8 breaks:** **Lane:** fixing round 2, after BROKEN verify run `64ff5cb8-755b-4950-9dc6-f4f7e1c6763a` (anthropic/claude-opus-5). I reproduced each claim before fixing. Every new case FAILED before the fix (`sandbox-run/r2-before.log`: 80 pass, 7 fail).

  - **#1 Board-only HEAD move reused a stale integration PASS.** Reproduced: READY, although re-integrating the exact new tree FAILS.
    - This is the **second break of one property**: "the tree a commit publishes is a tree that was checked". The first was plan-review point 1 (a moved base counted as safe when the candidate's own files were untouched). Both breaks came from avoiding a re-check after HEAD moves.
    - I did not add a mechanism. I removed my board-dir exemption: integration records are now keyed on the EXACT resulting tree. That fails closed.
    - I also dropped the ticket-file ride-along. Commits are code only, so a pre-checked `integrate --all` chain still matches. The ticket file is opt-in with `--with-ticket-file`; the board is committed afterwards with `board-tool commit`.
    - **ROUTED TO REDESIGN:** the cost of re-checking after every HEAD move, board-only moves included. Nothing more is patched there.
  - **#2 Freeze without claim skipped the foreign-lines check.** Reproduced: exit 0, with another lane's line baked in. Fixed structurally:
    - An own file that differs from HEAD and was never claimed is refused, whether or not the lane ran `claim`. Brand-new unclaimed files are refused too.
    - Only `--accept-foreign` or a declared dependency lets it through, and the downgrade is recorded.
  - **#3 Restoring an accepted-foreign file to its original bytes read DRIFTED and READY.** Reproduced. This is the first break of revert detection; my round-1 change measured the change from claim-time bytes and so left accepted lines unprotected.
    - Fixed: detection now protects everything the commit publishes (HEAD at freeze → frozen). A live file equal to HEAD's bytes, or to non-trivial claim-time bytes, is REVERTED.
  - **Truncation.** `independent-verify --candidate` now REFUSES when the diff exceeds `--max-diff-bytes`, and names the size it needs. FEAT-170's code diff is about 130 KB, so **round-2 verify should use `--max-diff-bytes 200000`**.
  - **Verified:**
    - Suite **87/87 PASS** in the Docker sandbox (`sandbox-run/r2-after.log`). This includes R1–R4, each must-FAIL before the fix.
    - Real-artifact replay **15/15** in this agent session.
    - `npm run gate` exits 1 on the leak gate only: 502 hits in other lanes' files, none of mine; my 7 files scan 0 hits. check-nul and typecheck PASS.
  - **Files changed this round:** `scripts/lib/candidate-store.mjs`, `scripts/candidate.mjs`, `scripts/independent-verify.mjs`, `scripts/verify-feat-170-candidates.mjs`.

### 2026-10-07 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 3f50654c-e45d-4331-9b23-9ae5a0494f1b — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — board tool
- **fixing lane round 3 — redesign plan (two-break STOP):** Two-break STOP on properties (2) "a candidate holds exactly its ticket bytes" and (3) "commit refuses agent sessions". Hypothesis tested: an edit-time gate that parses Bash text misses 6 of 9 write paths (textgate.mjs); per-file kernel ownership blocks all foreign writes but breaks sed -i and temp-file-plus-rename writes on the lane own file and serializes hot files until commit. Chosen: a per-ticket reflink copy behind a bwrap mount namespace, with the real .git read-only, as one authority for both properties. Proofs: scratch/f170r3/namespace-proof.log, 15 pass, 1 fail (DOCKER_HOST privileged dind reachable), localhost TCP open (residual R-net). Plan in "Redesign (round 3)"; OpenAI plan review queued for the quota reset (~15:40).

### 2026-10-07 — board tool
- **fixing lane round 3 — CHECKPOINTED for a service restart:** Where: plan written ("Redesign (round 3)" plus "Design review: rescope, keep patching, or redesign" in this body). Proofs ran: scratch/f170r3/namespace-proof.log (15 pass, 1 fail DOCKER_HOST, localhost TCP open); chokepoint.sh; textgate.mjs (6 of 9 Bash write paths missed); reach.py (1,871 transcripts: 0 deliberate circumventions, 2 lanes used env -i). Tentative outcome: rescope (3) (delete agentSession(); create the commit object before hooks so the git-write authority refuses first; composes with the FEAT-164 decision), and (2) becomes a user decision (seal vs. accepted residual R2). In flight: none; the OpenAI plan review never dispatched (quota EXHAUSTED until about 15:40; the waiter was stopped by process group). Next step: after 15:40, re-send scratch/f170r3/review-prompt.txt with `node src/server/dispatch-client.mjs --provider openai "$(cat …/review-prompt.txt)"`, revise per the review, then build only the (3) rescope if the review approves it, and return a decision card for (2). Files changed: docs/bugs/FEAT-170-verify-a-frozen-copy-of-each-ticket-and-commit-e.md only (prose; no code touched; full copy at scratch/f170r3/wip-20261007T134200/). Gate: exit 1 on the leak gate only (pre-existing hits, none in this ticket); check-nul and typecheck PASS.

### 2026-10-07 — worker (fixing r3)
- **Decision declared:** x? Options: A — a; B — a. Recommended: A — w Supersedes the earlier unanswered decision (kept in decision_history). Written to the record with board-tool decide; the Decide card reads the record, not this line.

### 2026-10-07 — worker (fixing r3)
- **Decision declared:** Must a frozen candidate guarantee it holds ONLY its own ticket lines, or only that the exact frozen, verified bytes are what gets committed? Options: A — Rescope to frozen-byte integrity; B — Bounded mutation ledger; C — Seal each lane in its own copy. Recommended: A — Rescope meets the stated need (verify and commit the exact frozen bytes) with no new surface. Measure how often a foreign line actually reaches a candidate before buying B or C; the OpenAI review says redesign is not yet earned. Supersedes the earlier unanswered decision (kept in decision_history). Written to the record with board-tool decide; the Decide card reads the record, not this line.

### 2026-10-07 — board tool
- **fixing lane round 3 — plan review REJECT; decision card (correction included):** Correction: the "x?" decision above was a malformed probe this lane wrote by mistake while debugging a validation refusal. It is void; the real card replaced it (both are in decision_history). Outcome: the OpenAI plan review (codex 01a11661-95af-7412-a946-7cf008929872, saved at scratch/f170r3/review-1-openai-REJECT.txt) returned REJECT. Every finding was adopted (see "Plan review … REJECT, and the outcome" in this body). Nothing was built. The prepared (3) patch (scratch/f170r3/patched/) fails its own authority-first contract, so it is not applied. Its proofs were BEFORE A1 must-FAIL (the hook ran for an env-unset agent) and AFTER 5/5 (authority-before-after.log), with round-2 suite 86/86 on the patched copy; these are recorded as evidence, not approval. The decision is now: frozen-byte integrity (A, recommended) vs bounded mutation ledger (B) vs per-lane seal (C). The earlier delivery question returns after it. Proof sources were moved out of /tmp into scratch/f170r3/. Files changed in the repo: this ticket only.

### 2026-10-07 — worker (fixing r3)
- **fixing lane round 3 — rescope A built:** Built the orchestrator decision A (frozen-byte integrity). Property: what gets committed is exactly the frozen bytes that were verified, and any later change to those files invalidates the verdict. Status is now byte equality (CURRENT/CHANGED/REVERTED, plus STALE-BASE); the DRIFTED/OVERLAPPED classifier, candidateWriteGuard, the guard verb and agentSession() are deleted. Property (3): the FEAT-135 shim is the single commit authority; the env check and the suite test seam are gone; a refused update-ref now reports publish-refused instead of head-moved. New revisit-trigger metric: candidate foreign-report (accepted, unattributed, reported lines per 30 days; trigger at 1 or more) and candidate foreign-found. Proofs in the Docker sandbox: rescoped suite 86/86 (scratch/f170r3/rescope/after.log); the same suite on round-2 code 68 pass / 18 fail, with all 10 [must-FAIL on round 2] checks failing (before.log). Round-1 stale-PASS (R1) and revert (R3) cases pass. npm run gate PASS. Delivery plan (host broker, not built) written in the body. Files changed: scripts/lib/candidate-store.mjs, scripts/candidate.mjs, scripts/verify-feat-170-candidates.mjs, this ticket. Symptom of a deeper design flaw? Yes, already filed: the ownership question stays open behind the metric, and agent detection is FEAT-164 / ARCH-021.

### 2026-10-07 — worker (fixing r3)
- **fixing lane round 3 — trigger made harm-based:** Coordinator change before verification: the revisit trigger counts harm, not presence. foreign-report now counts a committed foreign line only when its owning ticket later gets a BROKEN bound to a candidate touching that line, changes or removes it in a later candidate, or has it gone from the live file while still uncommitted. Owner comes from foreign-found --owner U --line "<text>" (replaces --lines n) or is inferred from an earlier candidate that added the line; with no owner a line is counted as unowned and never as harm. The accept-foreign, unattributed and reported counts are informational only. Suite 91/91 in the Docker sandbox; on round-2 code 68 pass / 23 fail, all 11 must-FAIL checks failing. Body sections Round 3 outcome, Risks, workflow draft and success criteria updated. Files: scripts/lib/candidate-store.mjs, scripts/candidate.mjs, scripts/verify-feat-170-candidates.mjs, this ticket.

### 2026-10-07 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 248ad5f9-f954-4e09-94a3-e99de3fa2d58 — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — worker (fixing r4)
- **fixing lane round 4 — verify 248ad5f9 BROKEN ×2 fixed:** Round-3 verify 248ad5f9 (candidate 50f877ea7ad6) BROKEN, two findings, both reproduced first in the Docker sandbox (scratch/f170r3/rescope/r3-before.log, 90 pass / 3 fail). #1 commit --with-ticket-file staged the board file live post-freeze bytes after the tree check, so the published tree (b7aa141315bc) was not the verified one (21ed30c55788). Fixed by deleting the option (nothing else used it; the board is committed separately), and commit now asserts the staged tree equals the checked tree. #2 foreignReport counted reverted-live harm when a third lane removed a shipped line from the live file. Fixed by deleting that harm source: only the owner BROKEN verdicts and its own freezes count. Proofs: R5 and the S1 third-lane check, both tagged [must-FAIL on round 3], fail on round-3 code and pass now. Suite 93/93 (after.log); round-2 code 68 pass / 25 fail with all 10 round-2 must-FAIL checks failing. No verify run by this lane (cross-provider round follows). Files: scripts/lib/candidate-store.mjs, scripts/candidate.mjs, scripts/verify-feat-170-candidates.mjs, this ticket.

### 2026-10-07 — dispatch openai
- **Verification recorded:** dispatch openai run 01a11776-8fa1-72f2-b41a-2f05ddfa5c6d — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — worker (fixing r4)
- **round-4 verify adjudicated — FIXED, not VERIFIED:** OpenAI round-4 verify 01a11776-8fa1-72f2-b41a-2f05ddfa5c6d returned BROKEN: restoring a candidate file to its exact FROZEN bytes after an intervening change revives the earlier HOLDS without a re-freeze. Orchestrator adjudication (non-author): a charter mis-oracle, not a defect. The rescoped property is that what is committed is exactly the frozen, verified bytes; a content-addressed revival commits exactly those bytes, so the property holds. The charter attack "any change, including a restore, blocks until re-freeze" over-specified it. The harmful restore, restore-to-HEAD (the BUG-224 shape that loses the fix), is still blocked as REVERTED. Clarified property: a verdict counts only while every candidate file live-equals its frozen bytes and mode; any difference blocks the commit; returning to the exact frozen bytes makes the same verified bytes committable again. Fact checked in code by this lane: readiness() keeps no history and recomputes the base rule on every call. STALE-BASE blocks; when HEAD differs from base it requires an integration record keyed on the exact resulting tree; commitCandidate refuses unless the staged tree equals that checked tree. So a revived HOLDS cannot publish verified bytes onto a base they were never checked against. Proven in the sandbox suite by P6 and R1 (93/93). No fix needed. Limit: the clean room still could not test the end-to-end freeze/commit path (the git-write block refused git init), so the commit path is proven only by this lane Docker-sandbox suite. Status: FIXED, not VERIFIED. No HOLDS verdict exists and none is fabricated.

### 2026-10-08 — worker (fixing, shadow pilot)
- **shadow-repo pilot — plan reviewed, built, proved:** Plan written in 'Shadow-repo pilot'. OpenAI plan review 01a11a83 REJECT (15 findings), every one dispositioned in 'Plan review 1' (12 revised, 3 stated as residuals: read-command --output, directory-swap race, cross-lane -C). Built: scripts/lib/shadow-guard.mjs (resolved-repo decision + pinned exec), a guarded hook in scripts/lib/git-shim.mjs (+ .d.mts), scripts/lib/shadow-vcs.mjs + scripts/shadow.mjs (lane-new/run/sync/land/unland/freeze/recover/metrics/retire), freezeCandidate expect in scripts/lib/candidate-store.mjs, suite scripts/verify-feat-170-shadow.mjs. Proofs (confined-run): 47 passed, 0 failed (scratch/feat170-shadow/run3.log); P1-P4 each BEFORE on the actual baseline fails, AFTER holds; 20 redirect attacks refused, real repo byte-identical; negative control shows 6/6 attacks alter a repo under a naive cwd allow. Regressions (confined): FEAT-135 31/31, BUG-173 28/28, BUG-184 28/28, BUG-231 calls 21/21, BUG-240 8/8, BUG-242 21/21, FEAT-108 241/241 + 66/66, FEAT-164 31/31, FEAT-170 candidates 93/93; BUG-230 nested 22/1 and BUG-231 one-decision 26/1 fail only their E2E session launch (no Docker sandbox inside the container). Gate: leak PASS, check-nul PASS, typecheck FAIL only in another lane's scripts/fixtures/bug-244/. Candidate 42a4595a04c4 frozen for verify.

### 2026-10-08 — worker (fixing, shadow pilot)
- **Verification recorded:** dispatch anthropic/claude-opus-4-8 run 0b8d47da-7961-42a6-bcbe-3f39b556642c — VERDICT: INVALID — x. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — worker (fixing, shadow pilot)
- **shadow pilot — verify and the one fix round:** Verify: OpenAI attempt refused by the provider (cybersecurity flag), no verdict. Claude Opus clean-room run 0b8d47da-7961-42a6-bcbe-3f39b556642c on candidate 42a4595a04c4: harness verdict INVALID (FIXER-TEST citation form), recorded typed; the note 'x' on that entry is my probe-call slip (the full note was refused on length). The verifier's reply was BROKEN: in a repo with no HEAD, land skipped REVERTS-FOREIGN and a later lane silently removed another lane's landed line. Fix round (the only one): lane-new and land refuse a project with no base commit. New suite check fails on the pre-fix shadow-vcs.mjs (scratch/feat170-shadow/r1-before.log) and passes now; suite 48/48 (run4.log). npm run gate PASS. Fix not re-verified. Files: scripts/lib/shadow-guard.mjs, scripts/lib/shadow-vcs.mjs, scripts/shadow.mjs, scripts/verify-feat-170-shadow.mjs, scripts/lib/git-shim.mjs, scripts/lib/git-shim.d.mts, scripts/lib/candidate-store.mjs, this ticket. Symptom of a deeper design flaw? Yes, already filed: same-uid agents are only policed (ARCH-021); lane binding needs the runtime's dispatch identity.

### 2026-10-08 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 6f369176-8425-4fd6-b63b-53a8d43b435a — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — worker (fixing, shadow pilot)
- **shadow pilot — fix round for verify 6f369176:** Coordinator: verify 6f369176 (candidate 4c4bd7f629d2) BROKEN, VALID: the line-heuristic REVERTS-FOREIGN missed punctuation-only lines, files with a NUL byte, and resurrected deletions. Replaced, not patched: land now replays every other un-committed ticket's recorded landing (pre of its first landing to post of its latest) against the exact bytes it would write. It refuses if any line that ticket inserted is changed or deleted, or if a line it deleted is re-inserted at its hunk; checks are typed (file deleted/added, symlink, mode), the diff is byte-exact (git diff --no-index --text -U0, no filters, NUL included), and a diff error refuses. The meaningful() filter, isBinary early exit and HEAD-based heuristic are deleted from the check; the merge-preservation check lost its filter too. Proofs: V1 punctuation-only, V2 NUL file, V3 stale restore of a landed deletion, each FAIL on the pre-fix code (scratch/feat170-shadow/r2-before.log, 50/4) and PASS now; plus a no-false-refusal check for adjacent edits. Suite 54/54 confined (r2-after.log). Gate below. File: scripts/lib/shadow-vcs.mjs, scripts/verify-feat-170-shadow.mjs.

### 2026-10-08 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run faa119a9-6fdc-441b-98c4-b0c0f0c5b9ff — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — worker (fixing, shadow pilot)
- **shadow pilot — FIXED, not VERIFIED: two-break adjudicated (verify faa119a9):** Final verify faa119a9-6fdc-441b-98c4-b0c0f0c5b9ff BROKEN with two findings: (1) an exec-bit strip on a file another ticket created; (2) far resurrection, a line another ticket deleted re-inserted at a different offset. Two-break, adjudicated by the orchestrator as non-author reviewer. RESCOPED PROPERTY: a landing never changes another in-flight ticket's landed hunk in place — its bytes, its deletions at their own position, and the file mode it set. Why: re-inserting the same text elsewhere in a file is indistinguishable from a legitimate new edit (braces, imports, repeated lines), so refusing it would cause false refusals, and under the careless-agent threat model it is not a revert. ACCEPTED RESIDUAL: far resurrection (a deleted line re-added away from its original hunk) is not refused. The pilot's foreign-edit-incident metric (shadow.mjs metrics; plus shadow.mjs incident --kind silent-loss/foreign-edit when a verifier or the user finds one) is what would reveal it causing real harm; at 1 or more reported harm the check is reopened. FIX (inside the property): the mode the other ticket set is part of the exact comparison, including for a file it created (shadow-vcs.mjs violatesLanded). Proof: V4 (exec bit stripped from another ticket's created, landed file) FAILS on the pre-fix code (scratch/feat170-shadow/r3-before.log, 54/1) and PASSES now; suite 55/55 confined (r3-after.log); npm run gate PASS. Status: FIXED, not VERIFIED. No further verify rounds; the pilot's metrics are the next check. Files: scripts/lib/shadow-vcs.mjs, scripts/verify-feat-170-shadow.mjs.
