# BUG-114 — verifier session hosts escape their harness and leak: live scopes, deleted working directories

- **Status:** OPEN
- **Severity:** high
- **Area:** server — survival / session-host lifecycle (`src/server/survival.ts`)
- **Reported:** 2026-08-19 by the scratch-root lane (FEAT/scratch work), from live observation
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.
  Session lifecycle and data-loss-adjacent; a self-verified suite is not the last word here.

## The argument

Session hosts are launched into their own transient systemd user scopes so they
escape the server's control group. That is the whole point of survival: a
`systemctl restart` must not kill a live turn. But a verification harness is not
a server, and it gets the same escape for free. The host outlives the harness
that spawned it, the harness's `finally` block removes the scratch directory it
was running in, and nobody is left who believes they own the host.

The result is a population of live processes with no owner and no working
directory. They are not idle. Each one holds a CLI, a socket and a pid, and each
one keeps running until something unrelated kills it.

This also explains a symptom that was mis-attributed. Clean rooms appeared to
vanish mid-run, and the first suspects were the system tmp sweeper and the
verifier deleting other runs' rooms. Both were ruled out with evidence. The
actual mechanism is this one: the escaped host is still running in a directory
its harness already deleted.

## What was observed

A single snapshot, 2026-08-19, on a machine running ordinary verification work:

- **28** live `claude-station-host-*.scope` units.
- **20+** `session-host.mjs` processes whose `/proc/<pid>/cwd` reads `(deleted)`.
- The oldest had been running **~60 minutes** past its harness.
- The deleted directories belong to at least two different suites, from two
  different lanes, e.g. `<scratch>/cs-<suite>-XXXXXX (deleted)`.

One detail matters for scoping the fix: some of the leaked directories were under
`/tmp` and some were under a persistent scratch root. **Moving scratch off `/tmp`
does not touch this bug.** The directory location is irrelevant; the ownership
gap is the defect.

## The second problem: one global namespace

Clean-room verifiers spawn hosts into the **same** systemd user scope namespace
as the production service. There is no per-run prefix and no per-run slice. A
verifier's host and the user's real session host are siblings, named alike, in
one flat list.

The suites already navigate this, carefully. They reap **only by pid**, never by
pattern, and the board's hard rules say so in as many words: never `pkill`, kill
by pid, never touch the live service. That discipline works. It is also the only
thing standing between a verification run and killing the user's live session,
and it is enforced by convention in every individual test rather than by the
mechanism. A single `systemctl --user stop 'claude-station-host-*'` typed by
anyone debugging the leak would take the user's session with it.

Name this now rather than after it happens. A fix that gives verifier-spawned
hosts a distinguishable identity would turn "everyone remembers to use pids"
into "the wrong thing is not reachable".

## Repro

1. Run any verification suite that boots a scratch server and starts a driven
   `direct` session — the suites that spawn hosts are the ones referencing
   `systemd-run` / `claude-station-host` (e.g. `verify-hosts-cleanup.mjs`,
   `verify-restart-survives.mjs`, `verify-bug-091-host-spawn.mjs`).
2. Let it finish normally, including its `finally` cleanup.
3. `systemctl --user list-units 'claude-station-host-*.scope'` — scopes remain.
4. For each `session-host.mjs` pid, `readlink /proc/<pid>/cwd` — several read
   `(deleted)`.

## Expected

When a harness exits, the hosts it started are gone. Not eventually, and not
because the next boot cleans up: by the time the process that created them
returns, they are reaped or provably reaping.

## What a fix has to establish

- **An owner that outlives nothing.** Every spawned host has exactly one process
  responsible for its death, and that responsibility does not evaporate when the
  responsible process exits. Whatever the mechanism — a scope tied to the
  harness's lifetime, a watchdog that reaps on owner-death, an explicit
  registration the harness must drain — the property to prove is that no host
  survives its owner.
- **Ordering-independence.** The harness can die first, the host can die first,
  or both can race. All three must end with nothing leaked. Prior lifecycle work
  on this board (ARCH-003) learned that lesson the expensive way: signals that
  only annihilate in one order leave permanent residue.
- **The production service is untouched.** A verifier's cleanup must be
  incapable of reaching a host it did not start, even when that cleanup is a
  blunt instrument typed by a human. Prove it against a live host the run does
  not own.
- **No new sweeper.** A background reaper that kills by age or by name is the
  failure mode in a different costume; it can kill a legitimately long-running
  turn. Ownership, not age.
- **Measured on the real thing.** The proof is a real suite run, before and
  after, counting scopes and `(deleted)` cwds — not a fixture that spawns one
  host and reaps it. The observed state has 20+ leaks across two lanes at once;
  a single-host fixture would not have shown any of it.

## Context pack (grows — the "where to look", so no agent cold-starts)

- Files/functions in play: `src/server/survival.ts` — `startSurvivingHost`
  (the `systemd-run --user --scope --collect` launch), `reapHost`,
  `dropDeadSurvivorHost`, `scanSurvivingHosts`, `adoptSurvivingHosts`. The
  broker itself is `session-host.mjs`.
- Adoption is scoped by hosts-dir, so a scratch server never adopts the
  production service's hosts. The shared surface is the systemd scope
  **namespace**, not the hosts dir. Do not confuse the two.
- Related tickets: ARCH-003 (lifecycle signals must annihilate in either order,
  and OPEN records need a reclamation path that needs no end signal — the same
  shape of problem); ARCH-001 (a broker whose CLI has exited used to sit in its
  scope forever once the scan stopped returning it).
- Related but NOT this bug: the scratch-root work that moves long-lived tooling
  scratch off `/tmp` (`scripts/lib/scratch.mjs`, `docs/CONVENTIONS.md`). It was
  filed from the same investigation and fixes a different problem. Leaked hosts
  were observed under both the old and the new locations.
- Repro test: none exists yet. The fix lane should add one; the suites listed
  under Repro are where the spawning happens.
- Known dependencies / blockers: `src/server/survival.ts` is live to other
  lanes. Serialize before dispatching.

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
