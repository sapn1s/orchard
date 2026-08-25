```orchard-ticket
{
  "id": "BUG-114",
  "type": "bug",
  "title": "Verification runs leave live sessions behind with no owner",
  "summary": "Verification runs start session processes that survive the run that created them. One snapshot found 28 such processes still alive, some running for an hour past their harness, several in working directories the harness had already deleted. This also explains clean rooms that appeared to vanish mid-run.",
  "impact_if_we_wait": "Every verification run adds long-lived processes nobody owns, and one blunt cleanup command could take the user's live session with it. Bounded: the running service and stored data are unaffected today, and the leaked processes are idle load rather than corruption.",
  "current_need": "Independent clean-room pass on the new orphan-bound suite before it is trusted as the regression gate; the bound itself is proven live, twice.",
  "severity": "high",
  "area": "Session host lifecycle",
  "reported": "2026-08-19",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "No spawned session survives the process responsible for it",
    "Leaks stay at zero whether harness or session dies first, or both race",
    "A verifier's cleanup cannot reach a session it did not start",
    "No age-based or name-based background reaper is introduced",
    "A real suite run before and after shows the scope and deleted-directory counts drop to zero"
  ],
  "code_refs": [
    {
      "path": "src/server/survival.ts",
      "symbol": "startSurvivingHost",
      "note": "launches each session into its own transient user scope, which is what lets it escape the harness"
    },
    {
      "path": "src/server/survival.ts",
      "symbol": "reapHost",
      "note": null
    },
    {
      "path": "src/server/survival.ts",
      "symbol": "dropDeadSurvivorHost",
      "note": null
    },
    {
      "path": "src/server/survival.ts",
      "symbol": "scanSurvivingHosts",
      "note": null
    },
    {
      "path": "src/server/survival.ts",
      "symbol": "adoptSurvivingHosts",
      "note": "adoption is scoped by hosts-dir, so a scratch server never adopts production hosts; the shared surface is the scope namespace, not the hosts dir"
    },
    {
      "path": "session-host.mjs",
      "symbol": null,
      "note": "the broker process whose /proc/<pid>/cwd reads (deleted) after the harness cleans up"
    },
    {
      "path": "scripts/lib/scratch.mjs",
      "symbol": null,
      "note": "the scratch-root relocation work, filed from the same investigation but fixing a different problem"
    }
  ],
  "related": [
    {
      "id": "ARCH-001",
      "relation": "see_also"
    },
    {
      "id": "ARCH-003",
      "relation": "see_also"
    },
    {
      "id": "ARCH-007",
      "relation": "see_also"
    },
    {
      "id": "BUG-115",
      "relation": "see_also"
    },
    {
      "id": "BUG-116",
      "relation": "see_also"
    },
    {
      "id": "BUG-117",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-114-verifier-session-hosts-escape-their-harness-and-leak-scopes.md",
    "sha256": "bbfa4188801b64f14ecef3b8a90fbdf09cc8f8a510ad5ebd90be4c27e8725559",
    "bytes": 8612,
    "original_title": "verifier session hosts escape their harness and leak: live scopes, deleted working directories",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Read against the original head section by section: the ownership gap, the namespace problem, the 2026-08-19 counts, the four fix properties and the real-run proof bar are all present.",
    "dropped": [
      "the numbered repro steps were kept but compressed into Evidence rather than given their own slot"
    ]
  }
}
```

# BUG-114 — Verification runs leave live sessions behind with no owner

## Diagnosis

### Ownership evaporates at harness exit

Session hosts are launched into their own transient systemd user scopes so they escape the server's control group — that is the point of survival, since a `systemctl restart` must not kill a live turn. A verification harness is not a server, but it gets the same escape for free. The host outlives the harness that spawned it, the harness's `finally` block removes the scratch directory it was running in, and nobody is left who believes they own the host. Each survivor holds a CLI, a socket and a pid, and keeps running until something unrelated kills it.

This also explains a symptom that was mis-attributed. Clean rooms appeared to vanish mid-run; the system tmp sweeper and the verifier deleting other runs' rooms were both suspected and both ruled out with evidence. The real mechanism is an escaped host still running inside a directory its harness already deleted.

### One global scope namespace

Clean-room verifiers spawn hosts into the same systemd user scope namespace as the production service. There is no per-run prefix and no per-run slice, so a verifier's host and the user's real session host are siblings, named alike, in one flat list. The suites navigate this by reaping only by pid, never by pattern, and the board's hard rules say exactly that: never `pkill`, kill by pid, never touch the live service. That discipline works, and it is the only thing standing between a verification run and killing the user's live session. It is enforced by convention in every individual test rather than by the mechanism. A single `systemctl --user stop 'claude-station-host-*'` typed by anyone debugging the leak would take the user's session with it.

## Evidence

A single snapshot on 2026-08-19, on a machine running ordinary verification work:

- 28 live `claude-station-host-*.scope` units.
- 20+ `session-host.mjs` processes whose `/proc/<pid>/cwd` reads `(deleted)`.
- The oldest had been running ~60 minutes past its harness.
- The deleted directories belong to at least two suites from two different lanes, e.g. `<scratch>/cs-<suite>-XXXXXX (deleted)`.

Some leaked directories were under `/tmp` and some under a persistent scratch root, so moving scratch off `/tmp` does not touch this bug. The directory location is irrelevant; the ownership gap is the defect.

No suite has been run against this ticket. `verify-hosts-cleanup.mjs`, `verify-restart-survives.mjs` and `verify-bug-091-host-spawn.mjs` are named only as the places where host spawning happens; no repro test exists yet.

### Repro

1. Run any verification suite that boots a scratch server and starts a driven `direct` session — the ones referencing `systemd-run` / `claude-station-host`.
2. Let it finish normally, including its `finally` cleanup.
3. `systemctl --user list-units 'claude-station-host-*.scope'` — scopes remain.
4. For each `session-host.mjs` pid, `readlink /proc/<pid>/cwd` — several read `(deleted)`.

### Expected

When a harness exits, the hosts it started are gone. Not eventually, and not because the next boot cleans up: by the time the process that created them returns, they are reaped or provably reaping.

## Implementation notes

### What a fix has to establish

- **An owner that outlives nothing.** Every spawned host has exactly one process responsible for its death, and that responsibility does not evaporate when the responsible process exits. The mechanism is open — a scope tied to the harness's lifetime, a watchdog that reaps on owner-death, an explicit registration the harness must drain — but the property to prove is that no host survives its owner.
- **Ordering-independence.** The harness can die first, the host can die first, or both can race; all three must end with nothing leaked. ARCH-003 learned that lesson expensively: signals that only annihilate in one order leave permanent residue.
- **The production service is untouched.** A verifier's cleanup must be incapable of reaching a host it did not start, even when that cleanup is a blunt instrument typed by a human.
- **No new sweeper.** A background reaper that kills by age or by name is the same failure in a different costume; it can kill a legitimately long-running turn. Ownership, not age.

A fix that gives verifier-spawned hosts a distinguishable identity turns "everyone remembers to use pids" into "the wrong thing is not reachable".

### Where to look

`src/server/survival.ts` holds the spawn and reap path. Adoption is scoped by hosts-dir, so a scratch server never adopts the production service's hosts; the shared surface is the systemd scope namespace, not the hosts dir. Do not confuse the two. A broker whose CLI has exited sitting in its scope forever once the scan stopped returning it is the shape recorded in ARCH-001.

## Verification plan

Independent verification is required before this can be called verified: session lifecycle and data-loss-adjacent, so a self-verified suite is not the last word.

The proof is a real suite run, before and after, counting scopes and `(deleted)` cwds — not a fixture that spawns one host and reaps it. The observed state had 20+ leaks across two lanes at once, and a single-host fixture would not have shown any of it. Prove the production-service isolation against a live host the run does not own. A repro test does not exist yet and the fix lane should add one.

## Risks

`src/server/survival.ts` is live to other lanes. Serialize before dispatching.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-19 — scratch-root lane (filing only; no fix attempted)

- **Understood:** hosts are launched into their own transient systemd scopes by
  design, which also decouples them from a verification harness. The harness
  removes its scratch dir in `finally`; the host keeps running in the deleted
  directory. This is the real mechanism behind clean rooms that appeared to
  vanish mid-run — the tmp sweeper and cross-run deletion were both investigated
  and ruled out with evidence.
- **Changed:** nothing. This ticket only. The defect lives in
  `src/server/survival.ts`, which another lane may be touching, and it deserves
  its own dispatch.
- **Verified:** observation only, on the live machine, read-only. 28 live
  `claude-station-host-*.scope` units; 20+ `session-host.mjs` pids with a
  `(deleted)` cwd; oldest ~60 minutes past its harness; leaked directories from
  two different suites in two different lanes, under both `/tmp` and a
  persistent scratch root. No process was killed and no scope was touched.
- **Still open / handoff:** everything. The next agent should start from "what
  owns this host, and what happens to that ownership when the owner exits",
  not from "how do we clean up afterwards" — a sweeper is the wrong answer and
  is called out above. Read ARCH-003's log first: the ordering lesson there
  applies directly.
- **Symptom of a deeper design flaw?** not answered — the ticket is open. The
  suspicion to test when closing it: whether "escape the parent's control group"
  and "be owned by the thing that started you" are separable at all, or whether
  survival's escape hatch needs an explicit ownership channel to travel with it.

### 2026-08-20 — fix lane (mechanism found in the REAL leaked records; verification deliberately lean, by user instruction)

- **Understood — the ticket's diagnosis was half right.** Escape into a transient
  scope is what decouples a host from its harness, but the abandon net
  (`session-host.mjs`, 120 s with no client) was *supposed* to bound that and did
  not. The 25 brokers still alive on this machine from the previous day's
  cleanroom runs say why, in their own status files: `state:"draining"`,
  `backgroundLive:1`, `backgroundLifetime:"unknown"`, `drainHeldSince` ~34 hours
  earlier. The BUG-043/BUG-044 lifetime hold — correct, and load-bearing for the
  user's real background agents — is UNBOUNDED, so one fake or stuck background
  lane holds a broker forever after its owner is gone. The leak is not "no one
  cleans up afterwards"; it is "the hold has no owner to hold for".
- **Changed:** `src/server/survival.ts` — the creating server's `HostOwner`
  (mode, dataDir, port, pid + kernel start-ticks so a reused pid cannot
  impersonate it) now travels in the control file with every host, and an
  isolated server's hosts are keyed `t-…`, i.e. `claude-station-host-t-*.scope`
  — a glob a verifier can aim at its own leftovers that provably cannot match a
  production host. `src/server/session-host.mjs` — the lifetime hold is now
  bounded by OWNERSHIP, not age or name: a host owned by an **isolated**
  (verification) server whose owner process is provably gone, with no client and
  none arriving within a grace, drains itself exactly as a boot-time re-adopt
  would have drained it. A host owned by the shared/production server is
  untouched — there an absent owner means "the service is restarting" and a
  successor re-adopts, so the user's real background work keeps every protection
  it has. Ordering-independent: the check is owner liveness at fire time, so
  harness-first, host-first and a race all end the same way.
- **Verified** (lean, by instruction): `scripts/verify-hosts-cleanup.mjs` 17/17
  against a real `claude` CLI (owner stamped in the real record, `t-` keys, zero
  leftover files), `scripts/verify-bug-091-host-spawn.mjs` 8/8, and the BUG-117
  checks 7/7. `npm run gate` exit 0. Nothing on :4317, the systemd service or any
  `claude-station-host-*` scope was touched; the pre-existing 25 leaked brokers
  were READ and left running.
- **Still open:** the pre-existing leaked brokers predate the fix and have no
  owner recorded, so nothing will bound them — they are the user's to remove
  (`claude-station-host-*` from the two cleanroom runs; **note** that
  `claude-station-host-h-msy5vbhk-a30kct.scope` currently contains the LIVE
  server process, so no glob-stop is safe). No before/after leak count across a
  full suite run was measured, and no independent pass was run.

### 2026-08-25 — agent
- **regression suite lane (real servers, real CLI; restart-window finding):** - **Where it actually stood.** The fix (`cac7831`) is an ancestor of HEAD and is LIVE, not merely committed: the user's current session host carries the post-fix `owner` stamp whose pid is the running service's MainPID. Orphan census taken read-only: ONE `claude-station-host-*` scope (the live session's), one `session-host.mjs` process (the live one), zero `(deleted)` cwds. Wednesday's 15 orphaned scopes are gone and no three-day-old orphans remain, so the question "would the new bound reap them" is moot on this machine — and the honest answer for the record is NO, it would not: they were pre-fix records with no owner stamped, and `orphaned()` returns false when no owner is recorded. Nothing bounds a pre-fix orphan; the bound only protects hosts created after the fix. That is closed by time, not by code, and every host created since IS stamped.
  - **What was genuinely unfinished:** no checked-in regression suite. The prior lane's verification was out-of-tree and lean by instruction, and this ticket's own log admits no before/after leak count was ever measured and that the `t-` scope rename could not be verified live. The board's proof bar here is explicitly a REAL run, not a fixture that spawns one host and reaps it.
  - **Changed:** `scripts/verify-bug-114-orphan-bound.mjs` + `npm run verify:bug-114-orphan-bound`. No product code changed for this ticket. It drives REAL scratch servers and REAL `claude` CLI hosts through the whole lifecycle, on free ephemeral ports with `CLAUDE_STATION_DATA` and `CLAUDE_PROJECTS_DIR` in scratch, built via `isolatedServerEnv()` which refuses to construct an unisolated env.
  - **Verified 17/17, run twice (once by the builder, once independently re-run start to finish), exit 0 both times:**
    - **The `t-` rename, verified LIVE** — the thing the previous log said it could not do. An isolated server's host key starts `t-` and its ACTUAL unit `claude-station-host-t-<...>.scope` was confirmed via `systemctl --user list-units` filtered to that exact unit, never a glob. The orphan-grace knob was also confirmed present in the broker's real `/proc/<pid>/environ`, so the suite's speed rests on a proven env path rather than an assumption.
    - **The bound FIRES, and is a bound rather than a crash.** A real session reached `backgroundLifetime:"yes"` — the exact held-drain state that leaked 25 brokers for 34 hours. After killing the scratch server, the host was asserted STILL ALIVE before the grace elapsed, then self-drained: broker pid exited, its scope disappeared, and its status/err/ctl/sock files were gone.
    - **The production protection is intact, as a real-process test.** Two brokers spawned directly against hand-written control files in scratch, byte-identical but for `owner.mode`, both held by live background work: the isolated one drained; the SHARED-owned one with the same dead owner pid held past the grace and was never force-drained.
    - **Must-FAIL demonstrated, not asserted.** A scratch COPY of `session-host.mjs` with `orphaned()` neutered to `return false` (the real product file untouched) did NOT drain the isolated orphan — so the suite genuinely catches the pre-fix regression.
    - **Leak count, before and after:** host scopes 1 -> 1, `(deleted)` cwds 0 -> 0, and the check that matters most, the user's pre-existing live `h-` host present in BOTH snapshots and untouched. Every broker, scope and server the run started was reaped by recorded pid/key and the reap was verified.
  - **FINDING, measured and not hidden — the in-suite restart window.** Rebooting a new isolated server on the SAME scratch data dir 257 ms after killing the old one, well inside a 15 s grace, did NOT save a background-holding host: it was force-drained at ~18.0 s (≈ `ABANDON_MS` + `ORPHAN_GRACE_MS`). Mechanism: `adoptSurvivingHosts()` re-adopts via `reapHost()`, which is SIGTERM only and attaches no client; the broker's recorded owner is the dead OLD server's pid, and `orphaned()` keys off (dead recorded owner) + (no client), neither of which a new server booting on the same data dir changes. So the re-adopting server's IDENTITY is not enough — only a real client re-attaching within the grace saves such a host, and re-adoption never attaches one. This cannot bite production, where a shared-owned host returns `orphaned()===false` unconditionally; it is specific to isolated verification servers, whose hosts are test hosts by construction. Recorded as a documented residual of the shipped design.
  - **Could not test:** a live client re-attach to a still-draining survivor, because the design has no such path — the `survivingHostForSdkSession` resume guard deliberately refuses a second resume onto a draining transcript. That arm is proven by the negative measurement plus code reading, not by a positive live attach.
  - **Still open — NOT closing this.** No independent clean-room pass has been run. Per the standing high-stakes rule this is session-lifecycle and data-loss adjacent, and the suite's author is also its only verifier, so it should not be relied on as the regression gate until a fresh-context pass has attacked it. What that pass should probe: whether case 3's "measured and reported" check can ever fail (it passes on either branch by construction, which is defensible for a measurement but must not be mistaken for a guard); whether the `backgroundLifetime` precondition can silently degrade into a vacuous pass if the CLI stops registering background work; and the leak-count assertion's relaxation from exact equality to "count did not increase".
