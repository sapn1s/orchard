```orchard-ticket
{
  "id": "BUG-117",
  "type": "bug",
  "title": "A stray test server can shut down the live session",
  "summary": "Any process that boots the server and resolves the shared session directory will shut down every running session it finds there, with no check that it started them. Isolation depends on one environment variable whose name, if mistyped, is ignored in silence — the server starts normally and quietly uses the real directory.",
  "impact_if_we_wait": "The next test run that mistypes, drops, or inherits the wrong isolation setting ends the user's live session with no warning. Bounded: the session drains rather than being cut off, transcripts stay intact, and every checked-in test script spells the setting correctly today.",
  "current_need": "Independent clean-room pass on the ownership gate: the fix is live and covered by a checked-in suite, but a bypass was found only by tripping it against the live session, so generation must not be its own last verifier.",
  "severity": "high",
  "area": "Session survival and test isolation",
  "reported": "2026-08-19",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A run that intended isolation and failed learns it from the tool, not from an ended session",
    "A booting server cannot shut down a session host it did not create",
    "A scratch server pointed at a directory holding a foreign host leaves that host alone",
    "The planted-record probe fails against the fixed code and passed against the current code",
    "The production service still reclaims its own hosts across a restart",
    "Ownership is recorded where the host is created, not inferred from name or age"
  ],
  "code_refs": [
    {
      "path": "src/lib/paths.ts",
      "symbol": "dataDir",
      "note": "line 24 — reads one variable and falls back to the default with no warning; an unrecognised name is indistinguishable from setting nothing"
    },
    {
      "path": "src/server/survival.ts",
      "symbol": "adoptSurvivingHosts",
      "note": "line 528 — iterates the whole scan and SIGTERMs every host whose pid is alive; presence in the directory is the entitlement"
    },
    {
      "path": "src/server/survival.ts",
      "symbol": "hostsDir",
      "note": "line 162 — derived as dataDir()/session-hosts, not separately configurable"
    },
    {
      "path": "src/server/survival.ts",
      "symbol": "startSurvivingHost",
      "note": "the write site where an owner identity would have to be stamped; the identity cannot be a pid because the deployed service re-adopts across its own restart"
    },
    {
      "path": "src/server/survival.ts",
      "symbol": "HostStatus",
      "note": "line 85+ — carries hostPid, claudePid, state, sdkSessionId, resumeHint, stationSessionId and drain fields, and nothing naming the creating server"
    },
    {
      "path": "src/server/liveness.ts",
      "symbol": "fromHostStatus",
      "note": "line 212 — decides alive or dead purely from declared state and pid liveness"
    },
    {
      "path": "src/server/index.ts",
      "symbol": null,
      "note": "line 3538 — adoption runs at boot, before the server is otherwise useful"
    },
    {
      "path": "src/lib/session-history.ts",
      "symbol": "defaultRoot",
      "note": "line 241 — the separate store knob CLAUDE_PROJECTS_DIR, routinely left unset by scratch boots"
    },
    {
      "path": "docs/CONVENTIONS.md",
      "symbol": null,
      "note": "its Scratch section covers scratch directories only; the scratch-server boot pattern is written down nowhere"
    },
    {
      "path": "scripts/lib/",
      "symbol": null,
      "note": "home for a shared boot helper that refuses when the data dir resolves to the default"
    }
  ],
  "related": [
    {
      "id": "BUG-114",
      "relation": "see_also"
    },
    {
      "id": "ARCH-003",
      "relation": "see_also"
    },
    {
      "id": "BUG-044",
      "relation": "see_also"
    },
    {
      "id": "BUG-022",
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
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-117-a-misspelled-isolation-knob-fails-silently-and-adoption-has-no-owner-check.md",
    "sha256": "c289cd16167218f38eaea56b2589742ad38fe68e65c9e9595fba1b7cfe85a503",
    "bytes": 20219,
    "original_title": "a misspelled isolation knob fails silently, and survivor adoption has no owner check, so one typo lets a scratch server reap the live session",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head section by section: both faults, the three knobs, the two probes, the BUG-114 correction, the blast-radius bounds, the fix bar and the three conventions recommendations are present.",
    "dropped": [
      "the table formatting of the three environment variables, restated as prose",
      "the verbatim probe output blocks, restated as their result",
      "the ticket's own restatement that no decision is declared, which the null decision field now carries"
    ]
  }
}
```

# BUG-117 — A stray test server can shut down the live session

## Diagnosis

### Two independent faults

A verification lane booted a scratch server on a free port and set `STATION_DATA_DIR` to a scratch directory. That variable does not exist anywhere in this codebase — not in `src/`, `scripts/`, `deploy/` or `docs/`, and not as a deprecated alias. The correct name is `CLAUDE_STATION_DATA`. `dataDir()` therefore fell back to the real data directory, the server found the user's live session host there, and re-adopted it, SIGTERMing a broker (pid 623241) that belonged to the user.

The misuse is the wrong name. The defect is what the wrong name did, which was nothing visible. There is no unknown-variable check, no startup assertion, no warning. Setting an unrecognised name produces exactly the same startup as setting nothing. The only signal is one line of routine boot noise naming the data dir, which says nothing about whether isolation was intended.

The second fault needs no typo. `adoptSurvivingHosts()` reads the hosts directory and SIGTERMs every status record whose pid is alive. There is no ownership check of any kind — no server identity on the record, no port, no boot token. Presence in the directory is the entitlement. Any process that resolves that path is fully entitled to drain and reap every broker on the machine.

### The knobs

Three directories, three variables. `CLAUDE_STATION_DATA` governs the data dir (registry, templates, `session-hosts/`, deleted-session backups), defaulting to `$XDG_DATA_HOME/claude-station` or `~/.local/share/claude-station`. `CLAUDE_PROJECTS_DIR` governs the session store, defaulting to `~/.claude/projects`. `CLAUDE_STATION_SCRATCH_DIR` governs the scratch project's working directory. There is no separate hosts-directory variable — the hosts dir is derived from the data dir — so one string literal decides which population of brokers a booting server will adopt.

The naming space is crowded: `CLAUDE_STATION_TMPDIR`, `CLAUDE_STATION_SURVIVE`, `CLAUDE_STATION_TERMINAL` and `CLAUDE_STATION_HOST_ABANDON_MS` sit alongside it. Two of the five are about "scratch" in different senses, and the one that governs isolation is named after "data".

### A claim on the board that needs qualifying

BUG-114's context pack states that adoption is scoped by hosts-dir, so a scratch server never adopts the production service's hosts. The statement is true and its premise is exactly what fails here. Hosts-dir scoping is real protection only while the hosts dir is actually scratch, and the mechanism that makes it scratch is one unvalidated environment variable. Adoption is safe by convention, not by construction.

### Blast radius

Reach is every broker in the resolved hosts dir, unconditionally — no per-session, per-project or per-server narrowing. On a live session, SIGTERM triggers the broker's `commitDrain`, which is lifetime-aware, so the in-flight turn drains rather than truncating; the session ends and continues only by resume from disk. Disruption and an ended CLI, not a corrupted transcript. Timing is boot-time, before the server is otherwise useful — merely booting is enough.

No checked-in suite is currently at risk: all server-booting scripts under `scripts/` set the data knob correctly. The exposure is ad-hoc lane boots. Separately and not this ticket's defect, at least eight of those scripts set the data knob but not the store knob, so their scratch servers read the user's real transcripts; boot itself only reads, the write paths are explicit API actions those suites do not exercise, and one live-check script points at the real store deliberately. Flagged because a single documented isolation contract should cover that knob too.

## Evidence

### Both probes ran against a scratch data directory

Neither touched the real one, and the only process signalled was a `sleep` the lane spawned itself.

**The wrong name resolves the real directory, silently.** With `STATION_DATA_DIR` pointed at a scratch path, `dataDir` resolved to `~/.local/share/claude-station` and the hosts dir to the live `session-hosts` underneath it. With `CLAUDE_STATION_DATA` pointed at the same path, both resolved into the scratch tree. The store root was the user's real projects directory in both cases. No warning, no error, and no difference in exit status between the wrong name and a plain default boot.

**Adoption reaps a process it never created.** A `sleep 600` was spawned, a hand-written status record naming that pid with `state: "running"` was planted in a scratch hosts dir, and `adoptSurvivingHosts()` was called against that dir. The scan returned the planted pid, the log announced re-adoption and a drain, and the victim was SIGTERMed by a process that had never spawned a broker, had no relationship to that pid, and was not even a server.

**The record carries no ownership field to check.** `HostStatus` holds pids, state, session ids, resume hint and drain fields, and nothing identifying which server created it. The liveness verdict is derived purely from declared state and pid liveness. A fix that wanted to check ownership has no field to read today; one must be added at the write site.

**The live hosts directory is populated right now.** It holds one live host's four files, observed by a read-only listing. Nothing was adopted, scanned by a server, or signalled.

## Implementation notes

### What a fix has to establish

An unrecognised isolation attempt must not pass for isolation. The mechanism is open — a startup check that rejects unknown data-dir-shaped variables, an explicit isolation assertion that fails the boot when the data dir resolves to the default, or a boot banner stating in plain words whether isolation is in effect. The property to prove is that a run which intended to isolate and failed finds out from the tool rather than from a dead session.

Adoption must be entitled, not merely located. Record an owner where the host is created and check it where hosts are adopted. Ordering-independence matters here in the same way ARCH-003 describes: the owning server dying must still leave its hosts reclaimable, so the fix is reclaim-by-proven-inheritance, not reap-whatever-is-present. The tension to design around is that the production service legitimately re-adopts across its own restart, so the owner cannot be a pid — it has to be an identity the deployed service carries and a scratch boot does not.

Do not fix this with a sweeper or a name pattern. Killing by name or age is the same failure in a different costume, as BUG-114 also states. Adoption cannot simply be disabled either, for the reason BUG-022 records: a second driver on one transcript is unacceptable.

### Conventions, recorded as a recommendation

The conventions document has no scratch-server section at all — its Scratch section is about scratch directories. The scratch-boot pattern of free port, scratch data dir, kill by pid lives only in the board's hard rules and in repetition across dozens of scripts. It should be written down once, naming the isolation knob and the store knob explicitly, with the warning that neither is validated.

A shared boot helper is the better half of the work. A `boot()` function is copy-pasted across roughly forty verify scripts and none asserts isolation. One helper that boots a server and refuses when the data dir resolves to the default, or when the resolved hosts dir holds hosts it did not create, makes the mistake unreachable rather than merely documented. It has the best cost-benefit here and touches nothing under the server source.

The naming space also deserves a pass; the conventions doc already carries a parenthetical disambiguating two of the five variables, which is a sign it needs one.

## Verification plan

Independent verification is required before this can be called done. It is session-lifecycle work and adjacent to the failure mode this board has already paid for twice — acting on something that looked dead — so a self-verified suite is not the last word.

No repro test exists yet. The planted-record probe under Evidence is the seed and needs no server, no systemd scope and no real data dir; it should become `scripts/verify-adoption-ownership.mjs`. Any fix must turn that probe red first.

The proof bar is the one BUG-114 sets: a scratch server pointed at a directory containing a foreign host must leave it alone, demonstrated against a real host rather than asserted. The isolation half needs a companion check that a boot with a misspelled or absent isolation variable fails or announces itself. Two suites named in passing as the surrounding context — verify:bug-091-host-spawn, which does not boot a server, and verify:live, which points at the real store deliberately — bound what the existing scripts already cover; neither has been run for this ticket.

## Migration and rollback

The two halves are separable and the safe one comes first. The conventions and helper work touches only documentation and the shared script library and can land independently. The ownership work touches `src/server/survival.ts`, which is live to other lanes — BUG-114 says the same — so it must be serialized before dispatching.

## Risks

An ownership check that keys on the wrong identity breaks legitimate re-adoption across a production restart, which is a worse outcome than the fault it prevents. A boot-time refusal that is too eager blocks the several dozen scripts that boot scratch servers constantly, sometimes several at once.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-19 — investigation lane (filing only; no fix attempted, product code untouched)

- **Understood:** a lane reported `STATION_DATA_DIR` "not honoured" after its scratch server adopted the user's live host (broker pid 623241). Established that the variable does not exist in this codebase — so the report is misuse in its immediate cause — and that the far more important finding is what the misuse revealed: an unrecognised isolation variable produces no signal whatsoever, and adoption performs no ownership check at all, so any process resolving the hosts dir may reap every broker in it. Also found that BUG-114's context pack asserts cross-adoption is impossible because adoption is hosts-dir scoped; true, but its premise is precisely the unvalidated knob.
- **Changed:** nothing but this ticket and its INDEX row. The defect lives in `src/server/survival.ts`, which another lane may be touching, and it deserves its own serialized dispatch.
- **Verified** (read-only on product code; no server was booted against the real data dir; nothing on :4317 or the systemd service was touched; the only signal sent went to a `sleep` this lane spawned):
  - `PASS` — `STATION_DATA_DIR` appears nowhere in `src/`, `scripts/`, `deploy/`, `docs/`; the report used a name that does not exist.
  - `PASS` — runtime probe: with `STATION_DATA_DIR` set to a scratch path, `dataDir()`/`hostsDir()` resolve to the **real** directories, with no warning and no non-zero status. With `CLAUDE_STATION_DATA` set to the same path, both resolve to scratch. Output quoted in Evidence §1.
  - `PASS` (must-FAIL seed) — planted a status record naming a `sleep 600` this lane owned into a **scratch** hosts dir; `adoptSurvivingHosts()` scanned it, logged a re-adopt, and SIGTERMed it. A process that never created the broker reaped it. Output quoted in Evidence §2.
  - `PASS` — no checked-in suite is currently at risk through this path: every server-booting script under `scripts/` sets `CLAUDE_STATION_DATA`.
  - `OBSERVED, not proven safe` — at least eight server-booting scripts leave `CLAUDE_PROJECTS_DIR` unset and so read the user's real transcript store. Boot is read-only; the store's write paths are explicit API actions those suites do not exercise. Flagged in Blast radius, deliberately not filed as its own ticket.
  - `npm run gate` — exit 0.
- **Still open:** everything. No fix attempted.
- **Handoff:** take the conventions/helper half first (`docs/CONVENTIONS.md` + a shared asserting `boot()` in `scripts/lib/`) — it removes the trap without touching contested code. The ownership half needs `src/server/survival.ts` serialized against BUG-114, and its hard part is stated above: the owner identity cannot be a pid, because the production service must still re-adopt its own hosts across a restart while a scratch boot must not. Start from the planted-record probe; it is a complete must-FAIL in about ten lines and needs no systemd scope.

### 2026-08-20 — fix lane (both faults closed; verification deliberately lean, by user instruction)

- **Changed:** `src/lib/paths.ts` (`dataDirMode`, `misspelledDataDirVars`, `assertDataDirIntent`) — a server now REFUSES to start (exit 78) when a data-dir-shaped variable is set while `CLAUDE_STATION_DATA` is not; `src/server/survival.ts` — a `HostOwner` (mode, dataDir, port, pid + kernel start-ticks) is stamped at the spawn site into the control + status record, and `adoptSurvivingHosts` now reaps only what `ownerEntitlesAdoption` allows: an isolated server owns its own hosts dir, a shared-dir server may reap only records whose owner declares the same port, and an owner-less (pre-fix) record — which is what the user's live host is right now — is adopted only by a shared server on the default port 4317, so the deployed service still re-adopts across its restart while a stray boot on an ephemeral port cannot; `src/server/index.ts` (refusal + an isolation-naming boot banner); `scripts/lib/station-boot.mjs` (`isolatedServerEnv`/`assertIsolatedEnv`, refuses rather than warns); `docs/CONVENTIONS.md` (the scratch-server section the ticket asked for). The owner cannot be a pid, exactly as the ticket required — it is (data dir, port).
- **Verified** (7/7, an out-of-tree scratch check; fake `XDG_DATA_HOME`, free ports, the only signalled processes were `sleep`s this lane spawned; nothing on :4317, the service or any `claude-station-host-*` scope was touched): misspelled knob → exit 78 naming both variables; a stray shared-dir server left BOTH a planted owner-less (live-session-shaped) host and a production-port-owned host alive and logged `NOT adopting`; non-vacuity — an isolated server still adopts a host in its own hosts dir. Plus `scripts/verify-hosts-cleanup.mjs` 17/17 against a real `claude` CLI (owner stamped in the real record, no leftovers). `npm run gate` exit 0.
- **Still open:** an independent clean-room pass was NOT run (user instruction to cut verification overhead). What it should attack is listed in the handoff of the return message.

### 2026-08-25 — agent
- **fix + regression suite lane (bypass found; live-session incident recorded):** - **Established where it stood first.** Both fix commits (`7d2c367`, `cac7831`) are ancestors of HEAD, and the fix is provably LIVE, not merely committed: the user's current session-host control file carries the post-fix `owner` stamp `{mode:"shared", dataDir:"&lt;the default data dir&gt;", port:4317, pid:435148, pidStart:"5560655"}`, and that pid is the running service's MainPID. The legacy owner-less path the prior lane wrote about has therefore already expired on this machine — the live host is owner-stamped, exactly as "that path disappears after one restart" predicted. Orphan census: ONE `claude-station-host-*` scope (the live session's), one `session-host.mjs` process (the live one), zero `(deleted)` cwds. Wednesday's 15 orphans are gone; nothing remains for the new bound to reap.
  - **Found the ticket genuinely unfinished in two ways.** (1) No regression suite was ever checked in — the prior lane's 7/7 was out-of-tree, so the fix was unprotected and the ticket's own verification plan (`scripts/verify-adoption-ownership.mjs`) was unmet. (2) The ownership gate had a live BYPASS, found the hard way (see the incident below).
  - **The bypass — the destructive path the first fix did not gate.** `adoptSurvivingHosts` was gated, but adoption is not the only destructive path. `scanSurvivingHosts()` destroys any record it judges dead *on the way past*, before the entitlement filter is ever applied, and it runs on every `/api/health` poll rather than only at boot. Two escapes followed: `cleanupHostFiles` derived its delete targets from `st.status` — an absolute path read out of the record's own JSON — so a record in a scratch hosts dir could name the REAL one and delete the live host's four files; and `dropDeadSurvivorHost` SIGTERMed and deleted with no ownership check at all while re-checking pid liveness itself, so a record declaring `state:'exited'` with a still-running pid (the ARCH-001 shape) was killed by any server that could see it. The hosts-dir scoping BUG-114's context pack calls the isolation boundary was defeated by a path travelling in the data.
  - **INCIDENT, on the live session, during this ticket's own verification.** A sub-agent copied the user's REAL host record into a scratch dir, scrubbed the pids but left the record's embedded `status` path pointing at the real file. The scan judged it dead-by-pid and `rmSync`'d the LIVE host's `.json`, `.sock`, `.err` and `.ctl.json`. The broker (438528) and CLI (438536) were never signalled — the scrubbed pid was dead, so `pidAlive` was false — and both are still running with their background work intact. `.json`/`.ctl.json`/`.err` were restored and the broker has since rewritten status itself. The `.sock` inode is NOT recoverable without restarting the user's broker, which was not done. Impact assessed as nil: the socket is dialled only at spawn (`survival.ts` line 431), the server's connection to the broker is still ESTABLISHED, and restart re-adoption drains by SIGTERM on `hostPid`, never by socket. It clears when the session ends. This is the ticket's own failure mode recurring inside the work on the ticket, which is why it is recorded in full rather than summarised.
  - **Changed:** `src/server/survival.ts` — `cleanupHostFiles` now confines every deletion to `hostsDir()` (`isInside`), so a record may only cause deletions in the directory it was found in; `dropDeadSurvivorHost` now takes the same `ownerEntitlesAdoption` entitlement as adoption, at the single choke point every caller passes through, with `scanSurvivingHosts` computing the owner once and passing it in. Also made the port-change residual LOUD: the entitlement key is (data dir, port) and must stay so — dropping port reopens the original hole — but that strands hosts stamped with an old port, unadoptable AND `shared`-owned so BUG-114's orphan bound deliberately exempts them, i.e. a permanent invisible leak; a shared server that declines a record from its own data dir on a different port now says so and names the safe remedy. `docs/CONVENTIONS.md` — the fixture rule the incident earned: copying a real host record means rewriting every path inside it, because the escape travels in the data even when the isolation knob is right. `scripts/verify-adoption-ownership.mjs` + `npm run verify:adoption-ownership` — the suite this ticket asked for.
  - **Verified (17/17, `npm run verify:adoption-ownership`)**, on scratch servers with fake `XDG_DATA_HOME` so the shared/production path is exercised without ever resolving the real dir — the harness asserts that itself before spawning (`assertSharedDirIsScratch`), since a bug in the harness is the bug under test. Misspelled knob → exit 78 naming both variables. A stray SHARED server on an ephemeral port left alive BOTH a record copied field-for-field from the user's real live host (owner port 4317) and a pre-fix owner-less one, logging `NOT adopting` for each — the prior lane could not run this against a real owner stamp because none existed yet. Non-vacuity in both directions: an isolated server still adopts its own hosts dir, and a shared server re-adopts the record naming its own port while leaving a different-port sibling alone in the SAME scan. Port-change strand is announced. A record naming a path outside the scanned dir cannot delete those files, while an owned corpse inside it is still swept.
  - **Must-FAIL proven against real pre-fix servers, not asserted.** At `7d2c367^`: the misspelled knob produced no refusal (server booted normally), and a stray server on an ephemeral port REAPED a planted host owned by port 4317 — BUG-117's Evidence §2 reproduced. At HEAD (`b6c0151`, i.e. with the first fix but without today's): the confinement check deleted all four foreign-dir files. Both go green on the fix.
  - **Anti-regressions:** `npm run verify:hosts-cleanup` 17/17 against a real `claude` CLI — normal open/close cycles still tidy up and `hostsDir()` ends completely empty, so the confinement is not a no-op; it also shows `t-` host keys live. `npm run gate` exit 0 (read directly, unpiped) before each commit.
  - **Still open — NOT closing this.** An independent clean-room pass has still not been run, and today strengthened rather than weakened the case for one: the class of defect fixed here (a destructive path that bypassed the gate) was found only because a sub-agent tripped it against the live session, not because the suite looked for it. What it should attack: other callers that pass attacker/accident-controlled paths from record bodies into destructive calls; whether `ownerEntitlesAdoption`'s owner-less→production-port rule is right for a shared-dir boot that is not the service; and the honesty of the new suite's non-vacuity checks.
  - **Process error to declare:** commit `afdbc6d` staged all of `docs/CONVENTIONS.md` and so swept in a concurrent ARCH-010 lane's uncommitted section under a BUG-117 message. Content is correct and appears exactly once; only the attribution is wrong. Not rewritten, because rewriting shared history while other lanes hold uncommitted work is the larger risk.
