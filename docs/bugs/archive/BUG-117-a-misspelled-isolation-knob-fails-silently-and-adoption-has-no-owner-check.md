# BUG-117 — a misspelled isolation knob fails silently, and survivor adoption has no owner check, so one typo lets a scratch server reap the live session

- **Status:** OPEN
- **Severity:** high — the immediate trigger was a typo, but the mechanism behind it is unguarded and its blast radius is the user's own live session. Two independent things had to be true for it to bite and both are true today: an unrecognised isolation variable is silently ignored (no error, no warning, the process just quietly uses the real data directory), and adoption entitles *any* process that can read the hosts directory to SIGTERM every broker in it. Capped short of "critical" because the default when the correct name IS used is safe, every checked-in suite uses the correct name, and the reap is a lifetime-aware graceful drain (BUG-044) rather than a truncating kill — the live turn ends, but it ends by draining, not by being destroyed. It did not lose work this time.
- **Area:** verification harness / survival — `src/lib/paths.ts` (`dataDir`), `src/server/survival.ts` (`hostsDir`, `scanSurvivingHosts`, `adoptSurvivingHosts`), plus the scratch-boot convention in `docs/CONVENTIONS.md`
- **Reported:** 2026-08-19, from a lane that hit it live, then established read-only with runtime probes against a scratch directory
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED. Session-lifecycle and adjacent to the one failure mode this board has already paid for twice (acting on something that looked dead); a self-verified suite is not the last word.

## The argument

A verification lane booted a scratch server on a free port, set `STATION_DATA_DIR` to a scratch directory, and believed it was isolated. It was not. **`STATION_DATA_DIR` is not a variable this project reads — it does not exist anywhere in the codebase.** The correct name is `CLAUDE_STATION_DATA`. The lane's server therefore resolved the *real* data directory, found the user's live session host there, and re-adopted it — SIGTERMing a broker (pid 623241) that belonged to the user, not to the lane.

So the immediate cause is misuse: a wrong name. **That is not the interesting half.** The interesting half is what the wrong name did, which was *nothing at all, visibly.*

**A knob that looks like it isolates and silently does not is a trap.** There is no unknown-variable check, no startup assertion, no warning. Setting `STATION_DATA_DIR` produces exactly the same observable startup as setting no variable: a server that quietly uses the real directory. The lane got no signal that its isolation had failed, and the only way it found out was by watching a live session get adopted. The name is close enough to the real one to be guessable, and the failure is close enough to success to be invisible. That combination is what makes it worth fixing even though a human typed the typo.

**The second half is worse, because it needs no typo.** Adoption is entirely unguarded. `adoptSurvivingHosts()` reads the hosts directory, and every status record it finds whose pid is alive is a broker it SIGTERMs. There is no ownership check of any kind — no server identity on the record, no port, no boot token, no "did I start this". **Presence in the directory IS the entitlement.** Any process that resolves that path — a scratch server, a stray script, a suite with a stale environment, a shell one-liner — is fully entitled to drain and reap the user's live session. The isolation knob is not a safety mechanism protecting the live session; it is the *only* thing standing between any booting server and every broker on the machine, and it fails open.

**This corrects a claim already written on this board.** BUG-114's context pack states: *"Adoption is scoped by hosts-dir, so a scratch server never adopts the production service's hosts."* The statement is true, and its premise is exactly what fails here. Hosts-dir scoping is real protection only while the hosts dir is actually scratch — and the mechanism that makes it scratch is a single environment variable with no validation. A future lane reading BUG-114 would reasonably conclude that adoption is safe by construction. It is safe by convention, one string literal deep.

**Why this matters more than one lane's typo.** Booting a scratch server is the standard pattern in this repo's test suites — several dozen scripts do it, constantly, often several at once. The property "a verification run cannot reach the user's live session" is currently upheld by every one of those scripts independently remembering to spell one variable correctly. That is the same shape of protection BUG-114 already flagged as inadequate for scope names ("enforced by convention in every individual test rather than by the mechanism"), and it is the same shape this project has twice paid for by acting on something that looked dead. The user's live session is on this machine right now.

**What is NOT wrong.** The default is safe. Every server-booting suite checked into `scripts/` uses the correct `CLAUDE_STATION_DATA`, and none is currently at risk through this path. The knob itself works correctly when spelled correctly. This ticket is about the absence of a guard, not a broken mechanism.

**If you do nothing:** the next lane that guesses the variable name, inherits a stale environment, or drops the variable in a refactor gets no error — it gets the user's live session, silently, and finds out by killing it.

> Everything below is the technical record and evidence — reference, not needed to understand the argument above.

## What the knobs actually are

Three separate directories, three separate variables, only one of which the lane was reaching for:

| What it controls | The real variable | Default | Read at |
| --- | --- | --- | --- |
| Data dir — registry, templates, **`session-hosts/`**, deleted-session backups | `CLAUDE_STATION_DATA` | `$XDG_DATA_HOME/claude-station`, else `~/.local/share/claude-station` | `src/lib/paths.ts:24` (`dataDir()`) |
| Session store — the user's real transcripts | `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | `src/lib/session-history.ts:241` (`defaultRoot()`) |
| The scratch **project's** working directory (not tooling scratch) | `CLAUDE_STATION_SCRATCH_DIR` | `dataDir()/scratch` | `src/lib/paths.ts:49` (`scratchDir()`) |

There is **no separate hosts-directory variable.** `hostsDir()` (`src/server/survival.ts:162`) is `path.join(dataDir(), 'session-hosts')` — derived, not configurable. So `CLAUDE_STATION_DATA` is the single knob that decides which population of brokers a booting server will adopt.

Adjacent names that are NOT this, and are worth knowing about because the naming space is already crowded: `CLAUDE_STATION_TMPDIR` (tooling scratch root, `scripts/lib/scratch.mjs`), `CLAUDE_STATION_SURVIVE` (survival kill-switch), `CLAUDE_STATION_TERMINAL`, `CLAUDE_STATION_HOST_ABANDON_MS`. Five `CLAUDE_STATION_*` variables, two of them about "scratch" in different senses, and the one that governs isolation is the one whose name says "data".

## Misuse or defect — the answer is both, and the split matters

**Misuse:** `STATION_DATA_DIR` does not appear in `src/`, `scripts/`, `deploy/`, or `docs/` anywhere. It is not a deprecated alias, not a removed name, not a typo in a doc the lane copied. The lane invented it. A correct name was not ignored; an incorrect name was used.

**Defect:** an unrecognised isolation variable is accepted in silence. `dataDir()` reads its one variable and, finding nothing, falls back — indistinguishably from a deliberate default boot. The server logs `[claude-station] data dir: …` at boot, which is the *only* signal, and it is one line of routine startup noise that says nothing about whether isolation was intended. The lane had every reason to believe it was isolated and no way to notice it was not until a live broker died.

**Defect, independently:** adoption has no owner check. This one needs no typo to be a hazard — it is the reason the typo was expensive rather than merely wrong.

## Evidence

Both probes were run against a **scratch** data directory on a persistent scratch root, never against the real one, and the only process signalled was a `sleep` this lane spawned itself.

**1. The wrong name resolves the real directory, silently** (`~` substituted for the home path):

```
--- A: STATION_DATA_DIR=<scratch>/data  (what the lane used) ---
  dataDir   = ~/.local/share/claude-station
  hostsDir  = ~/.local/share/claude-station/session-hosts     <-- the LIVE hosts dir
  storeRoot = ~/.claude/projects

--- B: CLAUDE_STATION_DATA=<scratch>/data  (the real name) ---
  dataDir   = <scratch>/data
  hostsDir  = <scratch>/data/session-hosts
  storeRoot = ~/.claude/projects
```

No warning, no error, no difference in exit status between A and a plain default boot.

**2. Adoption reaps a process it never created.** A `sleep 600` was spawned by this lane, a status record naming that pid was planted in a **scratch** hosts dir, and `adoptSurvivingHosts()` was called with `CLAUDE_STATION_DATA` pointed at that scratch dir:

```
  scan      = [738578]
  LOG [claude-station] re-adopting surviving session host (broker pid 738578, CLI pid ?,
      state running) — draining its in-flight turn to completion; …
  adopted   = 1
RESULT: victim was SIGTERMed by a process that never created it
```

The record was a hand-written JSON file with a pid and `state: "running"`. Nothing else was needed. The adopting process had never spawned a broker, had no relationship to that pid, and was not even a server.

**3. The record carries no ownership field to check.** `HostStatus` (`src/server/survival.ts:85+`) holds `hostPid`, `claudePid`, `state`, `sdkSessionId`, `resumeHint`, `stationSessionId`, drain/background fields — and nothing identifying which server created it. `livenessOfSurvivor` → `fromHostStatus` (`src/server/liveness.ts:212`) decides alive/dead purely from the broker's declared state and pid liveness. So even a fix that wanted to check ownership has no field to check today; one has to be added at the write site.

**4. The live hosts dir is populated right now.** `~/.local/share/claude-station/session-hosts/` currently holds one live host's four files (`.json`, `.sock`, `.err`, `.ctl.json`). Read-only `ls`; nothing was adopted, scanned by a server, or signalled.

## Blast radius

- **Reach:** every broker in the resolved hosts dir, unconditionally. There is no per-session, per-project or per-server narrowing — `adoptSurvivingHosts()` iterates the whole scan.
- **Effect on a live session:** SIGTERM to the broker → the broker's `commitDrain` runs. Because of BUG-044 that drain is lifetime-aware (it holds EOF while background lanes live), so the in-flight turn drains rather than truncating. The session then ends and continues only by resume-from-disk. **Disruption and an ended CLI, not a corrupted transcript.** That distinction is the reason this is high and not critical.
- **Timing:** boot-time, `src/server/index.ts:3538`, before the server is otherwise useful. Nothing needs to be requested; merely booting is enough.
- **Currently at risk:** no checked-in suite. All server-booting scripts under `scripts/` set `CLAUDE_STATION_DATA` (`scripts/verify-bug-091-host-spawn.mjs` does not boot a server; `scripts/station-doctor.mjs` is a read-only client). The exposure is ad-hoc lane boots, not the suite.
- **Secondary, scoped observation — not this ticket's defect:** the session-store knob `CLAUDE_PROJECTS_DIR` is *routinely* unset. At least eight server-booting scripts set the data knob but not the store knob, so their scratch servers read the user's real transcripts. Boot itself only reads; the write paths into the store are explicit API actions (`session-mutations.ts` delete, `fork.ts`, `memories.ts`) that those suites do not exercise, and `verify-live.mjs` points at the real store *deliberately*. Flagged rather than filed: store isolation is also not on by default, and if a fix here establishes a single documented isolation contract it should cover this knob too.

## What a fix has to establish

- **An unrecognised isolation attempt cannot pass for isolation.** Whatever the mechanism — a startup check that rejects unknown `*STATION_DATA*` / `*_DATA_DIR` variables, an explicit `CLAUDE_STATION_ISOLATED=1` assertion that fails the boot if the data dir resolves to the default, or a boot banner that states in plain words whether isolation is in effect — the property to prove is that a lane which *intended* to isolate and failed finds out from the tool, not from a dead session.
- **Adoption is entitled, not merely located.** A booting server must be unable to reap a broker it did not create. Record an owner at the write site (`startSurvivingHost`) and check it at the read site. Ordering-independence matters here as it did in ARCH-003: the owning server dying must still leave its hosts reclaimable — the fix is "reclaim by proven inheritance", not "reap whatever is present". **Note the tension:** the production service legitimately re-adopts across its own restart, so the owner cannot be a pid; it has to be an identity the deployed service carries and a scratch boot does not.
- **Prove it against a live host the run does not own.** Same bar BUG-114 sets. A scratch server pointed at a directory containing a foreign host must leave it alone, and that must be demonstrated against a real host, not asserted.
- **Do not fix this with a sweeper or a name pattern.** Killing by name or age is the same failure in a different costume (BUG-114 states this too).
- **A must-FAIL proof exists and is cheap.** The planted-record probe above reproduces the unguarded adoption in seconds without touching anything real. Any fix must turn that probe red first.

## Conventions — what should change so a lane cannot make this mistake

Recorded here as a recommendation for whoever picks this up; **no decision is declared** and this ticket is not blocked on one.

1. **`docs/CONVENTIONS.md` has no scratch-*server* section at all.** Its "Scratch" section is about scratch *directories* (`/tmp` policy, `scripts/lib/scratch.mjs`). The scratch-boot pattern — free port, scratch data dir, kill by pid — lives only in `docs/bugs/README.md`'s hard rules and in tribal repetition across dozens of scripts. It should be written down once, naming `CLAUDE_STATION_DATA` explicitly as the isolation knob and `CLAUDE_PROJECTS_DIR` as the store knob, with the warning that neither is validated.
2. **A shared scratch-boot helper that fails loudly.** There is a `boot()` function copy-pasted across roughly forty verify scripts; none of them asserts isolation. One helper in `scripts/lib/` that boots a server, and *refuses* if `dataDir()` resolves to the default or if the resolved hosts dir is non-empty with hosts it did not create, would make the mistake unreachable rather than merely documented. This is the fix with the best cost/benefit and it does not require touching `src/server/`.
3. **The naming space deserves a pass.** Five `CLAUDE_STATION_*` variables, two about "scratch" in different senses, and the isolation knob named after "data". `docs/CONVENTIONS.md` already carries a parenthetical disambiguating `CLAUDE_STATION_TMPDIR` from `CLAUDE_STATION_SCRATCH_DIR` — a sign the space is already confusing enough to need a footnote.

## Context pack (grows — the "where to look", so no agent cold-starts)

- Files/functions in play: `src/lib/paths.ts` — `dataDir()` (the one knob, no validation); `src/server/survival.ts` — `hostsDir()`, `scanSurvivingHosts()`, `adoptSurvivingHosts()` (:528, unguarded), `reapHost()`, `startSurvivingHost()` (the write site where an owner would be stamped); `src/server/liveness.ts:212` `fromHostStatus` (the verdict, pid-only); `src/server/index.ts:3538` (the boot call site); `src/lib/session-history.ts:241` `defaultRoot()` (the store knob).
- Related tickets: **BUG-114** (high, OPEN) — hosts escaping their harness, shared systemd scope namespace. Same family, different half: BUG-114 is "the harness loses its hosts", this is "a server adopts hosts that were never its own". **Its context pack's claim that hosts-dir scoping makes cross-adoption impossible needs the qualification above.** ARCH-003 (lifecycle signals must annihilate in either order; an owner-death reclamation path with no end signal is exactly the shape an ownership fix runs into). BUG-044 (the lifetime-aware drain — the reason a mistaken adoption drains rather than truncates). BUG-022 (why a second driver on one transcript is unacceptable, i.e. why adoption cannot simply be disabled).
- Repro test: none exists. The planted-record probe in Evidence §2 is the seed — it needs no server, no systemd scope and no real data dir. A fix lane should turn it into `scripts/verify-adoption-ownership.mjs`.
- Known dependencies / blockers: `src/server/survival.ts` is live to other lanes (BUG-114 says the same) — **serialize before dispatching.** The conventions/helper half (recommendation 1 and 2) touches only `docs/` and `scripts/lib/` and can be done independently and first.

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
