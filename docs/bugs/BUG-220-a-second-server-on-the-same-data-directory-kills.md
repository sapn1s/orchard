```orchard-ticket
{
  "id": "BUG-220",
  "type": "bug",
  "title": "A second server on the same data directory kills live work",
  "summary": "The ownership model assumes one server per data directory, but nothing enforces it. Two servers started on the same directory each see only their own sessions. One can then recreate or remove a container that is hosting the other server's live session, destroying the work running inside it.",
  "impact_if_we_wait": "This needs someone to start a second server on a data directory another server already uses, which is not the normal path. When it happens, a live session's container can be recreated underneath it and its running work lost. No stored data is affected.",
  "current_need": "Take an exclusive lock on the data directory at boot, so a second server on a directory already in use refuses to start.",
  "severity": "high",
  "area": "Server startup isolation",
  "reported": "2026-09-30",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-09-30",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "a second server started on a data directory already in use refuses to start with a non-zero exit and names the holder",
    "the first server keeps exclusive ownership; its live sessions' containers are never recreated or removed by a second boot",
    "a test starts two servers on one data directory and asserts the second refuses while the first is unaffected"
  ],
  "code_refs": [
    {
      "path": "src/server/index.ts"
    }
  ],
  "related": [
    {
      "id": "ARCH-022",
      "relation": "superseded_by"
    },
    {
      "id": "BUG-214",
      "relation": "see_also"
    },
    {
      "id": "BUG-216",
      "relation": "see_also"
    },
    {
      "id": "FEAT-158",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": true,
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

# BUG-220 — A second server on the same data directory kills live work

## Evidence
BUG-214 verifying (2026-09-30) records as a residual: "two server processes on ONE data dir each see only their own sessions (the ownership model says one server per data dir; unenforced)." BUG-218 round 4 adds a second face of the same gap: a second process on the SAME data dir may reclaim the first's in-flight staging image tag, so the first's build then fails.

## Violated invariant
The container and session ownership model is built on "one server per data dir": each server's `session-hosts/`, registry and container ownership live under its data dir, and a server only sees what is under its own. Nothing at boot enforces that uniqueness, so two servers can each believe they are the sole owner of the same world and act destructively on each other's containers.

## Fix design
At boot, take an exclusive lock on the data directory — an `flock` on a lockfile under `CLAUDE_STATION_DATA`, held for the process lifetime. A second server that cannot take the lock refuses to start with a non-zero exit and prints who holds it. This is the same shape FEAT-158 already uses for the shared docker sandbox daemon. An advisory-for-humans note is not enough: the lock must actually prevent the second boot.

## Build queue
Build queued behind FEAT-157 (same files: container-manager.ts / index.ts).

## Symptom of a deeper design flaw?
Partly — the same ownership family as the live-instance-inference ticket, but the remedy here is a concrete boot-time lock rather than a declaration. No new ARCH filed.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-30 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-30 — BUG-217 round-8 fix lane — resolved by the BUG-217 data dir lock (needs independent verify)
- **Outcome: this fix resolves BUG-220's `current_need`,** in the design this ticket's Fix design asked for. At
  boot, before any adoption, container migration or listen, the server takes an exclusive kernel flock on
  `<CLAUDE_STATION_DATA>/.orchard-server.lock` (`lanes.claimDataDir`, `src/server/index.ts`) and holds it for
  its lifetime.
  - A second server exits 78 with `REFUSING TO START`, naming the holder's pid, port and lock file, after a
    bounded wait (`CLAUDE_STATION_DATA_LOCK_WAIT_MS`, default 30 s, for restart overlaps).
  - The lock follows the directory's inode, so it holds through a symlink, a relative path, a bind mount (a
    container volume) and another network namespace. Round 7's socket lock missed the last two.
- **Against the success criteria:**
  - (1) Refuses non-zero and names the holder: proven. BUG-217 L1, M1–M5 pass, and M5 covers a SIGSTOPped holder.
  - (2) The first server keeps ownership: its liveness and single delivery are proven (L1 `aAlive`, CLI ×1).
    "Its containers are never recreated" is INFERRED, not tested with a container project. The refusal happens
    before any container code runs, and an import-time audit found only reads of the data dir before the lock.
  - (3) A test that boots two servers on one dir: `scripts/verify-bug-217-queued-message-strand.mjs` L1 and M1–M4.
- **Not covered:** two different kernels sharing the dir (NFS/SMB hosts, a VM over 9p/virtiofs). Known network
  filesystems are refused unless `CLAUDE_STATION_DATA_ALLOW_NETWORK_FS=1`. Details are in BUG-217's round-8
  entry.
- Ticket status not changed here. It needs an independent verify, ideally one that adds a container-project leg
  for criterion 2.

### 2026-09-30 — worker
- **Note:** Folded into ARCH-022 (container lifecycle has no single owner): this is the same live-container class as BUG-214's 8 clean-room breaks. Build it as a step of ARCH-022's migration path, through the single lifecycle authority, not as a standalone guard.
