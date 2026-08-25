# BUG-115 — a machine suspend fires the agent harness's wall-clock tool timeout on thaw, manufacturing a false verification FAIL

- **Status:** OPEN
- **Severity:** medium — not data loss and self-correcting this time, but it manufactures a false verification result (indistinguishable from a real one) and a SIGKILLed suite loop that leaks session hosts; an overnight suspend is entirely ordinary, so recurrence is likely. Capped below high because it needs an external suspend event, the agent noticed and re-ran, and the leaked-process half is already owned by high-severity BUG-114.
- **Area:** verification / agent-harness lifecycle (suspend → resume)
- **Reported:** 2026-08-19, from a read-only investigation with a grounded journal timeline
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED (a fix here is detection/attribution, not prevention — see the argument; the property to prove is that a killed-across-suspend result is distinguishable from a genuine failure)

## The argument

The machine suspended for 8h19m with agents mid-run. Two agents straddled the freeze and got **opposite outcomes, for a reason worth writing down.**

Whether in-flight work survives a suspend depends on **which clock its timeout uses**, and the two clocks in play behave oppositely across a freeze:

- **Agent A** was blocked on a LOCAL subprocess it had launched with coreutils `timeout 500`. That timer does not advance while the machine is frozen, so on thaw the command simply continued and completed. Its tool call returned 14 seconds after resume with an 8-hour gap sitting inside it, and its work committed 9 minutes later. It survived.
- **Agent B** was inside the **Claude CLI's own Bash tool timeout, which is WALL-CLOCK.** It fired on thaw: `Exit code 143 — Command timed out after 10m 0s`, SIGKILLing a verification-suite loop that had **already passed 37/37**. The wall clock counted 8 hours of frozen time as elapsed work. The result was a **false FAIL** on a suite that was actually passing, and the remainder of the loop never ran.

So the hazard is: **the tool's own timeout is the one that kills, and it is wall-clock.** A monotonic/process timer pauses with the process; a wall-clock deadline treats hours of suspended time as work and reaps a job that was doing nothing wrong.

Two consequences, both observed:

1. **A false FAIL is worse than a crash.** It looks like a real verification result. Nothing structurally distinguishes "killed by a wall-clock timeout across a suspend" from "the suite genuinely failed" — and this project has spent a great deal of effort ensuring verification results mean what they say. This time the agent happened to notice the 37/37-then-143 shape and re-ran; nothing guaranteed that.
2. **A SIGKILLed suite loop is a known producer of orphaned session hosts** — the same mechanism behind **BUG-114** (a snapshot there showed 25+ leaked scopes holding ~731 MB). This ticket does not re-file that; it records that a cross-suspend timeout kill is one more way to trip it. See BUG-114 for the host-ownership defect itself.

**Honest scope.** The wall-clock timeout belongs to the **agent harness (the Claude CLI's Bash tool)**, not to this project. We cannot make that timer monotonic or teach it about suspend. So the achievable fix here is almost certainly **detection and correct attribution, not prevention**: recognise the fingerprint (a long-running command returning `143 / "Command timed out"` bracketing a system suspend window) and refuse to record it as a genuine verification FAIL — rather than pretending we can stop the kill.

**If you do nothing:** the next overnight suspend that lands on a running verify loop can post a red FAIL for a suite that was green, and leak the hosts that loop spawned. A human or a downstream gate that trusts the FAIL acts on a result that never happened.

> Everything below is the technical record and evidence — reference, not needed to understand the argument above.

## Evidence — the timeline (reuse this; do not re-derive)

Grounded from the system journal on the affected machine:

- `PM: suspend entry` — **02:50:57**
- `PM: suspend exit` — **11:10:06**
- Frozen duration: **8h19m09s**.

Agent A (survived — monotonic/process-paused clock):
- Blocked in a tool call on a subprocess launched under coreutils `timeout 500` (500 **minutes**). That timer did not advance during the freeze.
- On thaw the subprocess resumed and completed; the tool call returned **~14 s after `suspend exit`**, with the 8h19m gap contained inside the single call.
- The agent's work committed **~9 min later**. No error surfaced.

Agent B (false FAIL — wall-clock clock):
- Inside the CLI Bash tool's own timeout (wall-clock, 10m in this invocation), running a verification-suite loop.
- The suite had already passed **37/37** before the freeze.
- On thaw the tool timeout fired immediately: **`Exit code 143 — Command timed out after 10m 0s`** (143 = 128 + SIGKILL(15)... i.e. terminated by signal; the harness reports the timeout kill this way). The loop was SIGKILLed; the remaining iterations never ran.
- Recorded outcome: a FAIL on a suite that was passing.

## What a fix has to establish

- **A killed-across-suspend result is distinguishable from a genuine failure.** The minimum bar: a verification outcome carrying the `143`/"timed out" fingerprint whose wall-clock span brackets a recorded system suspend window must NOT be counted as a real FAIL — it must be flagged as "inconclusive: killed by a wall-clock timeout across a suspend" so no human and no gate mistakes it for a verification verdict. (Suspend windows are observable locally, e.g. the journal `PM: suspend entry/exit` pair used above.)
- **Long-running verification is made robust to it, where we own the clock.** Verify harnesses this project DOES control could prefer monotonic/process-paused timing (like coreutils `timeout`, which survived here) over any wall-clock deadline, so our own loops are not reaped by frozen time. This does not reach the harness's Bash-tool timeout — say so plainly.
- **No claim we can prevent the harness kill.** The Bash-tool wall-clock timeout is the agent harness's, not ours. A fix that implies we can stop it is dishonest; detection + correct attribution is the real deliverable.
- **The host-leak half is not double-counted.** The SIGKILLed-loop → orphaned-host path is BUG-114's territory; cross-reference, do not re-file. This ticket's novel harm is the false verification verdict.

## Context pack (grows — the "where to look", so no agent cold-starts)

- **Nature:** an observation/report ticket. No product code changed; nothing to repro on demand (it needs a real suspend straddling a running tool call). The evidence is the journal timeline above, captured live.
- **The two clocks:** coreutils `timeout` (monotonic/process — pauses with the frozen process, survived) vs the Claude CLI Bash tool's wall-clock timeout (counted frozen time as elapsed, fired on thaw). The kill is reported as `Exit code 143 — Command timed out after <N>`.
- **Related tickets:** BUG-114 (verifier session hosts escape their harness and leak scopes — the SIGKILLed-loop mechanism this ticket's consequence #2 feeds; do NOT duplicate it). The broader "verification results must mean what they say" effort this session (e.g. FEAT-061 independent verification, BUG-097 verdict contract) is the reason a false FAIL is a first-class harm here.
- **Ownership boundary:** the offending timeout is the agent harness's, external to this repo. Achievable here = detect + attribute, not prevent. Flagged in the header (Verification-class note) and the argument.
- **Repro test:** none exists; a realistic reproduction would inject/simulate a suspend window that brackets a `143`-terminated command and assert the outcome is recorded "inconclusive", not "FAIL". A fix lane should add one.
- **Known dependencies / blockers:** none in this repo; the prevention half is bounded by the harness, which we do not control.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-19 — filing lane (report only; no fix attempted, no product code touched)

- **Understood:** a suspend across a running tool call has opposite outcomes depending on the timeout's clock. coreutils `timeout` (monotonic/process) pauses with the frozen process and the command completes on thaw; the Claude CLI Bash tool's wall-clock timeout fires on thaw (`Exit code 143 — Command timed out after 10m 0s`), SIGKILLing a verify loop that had passed 37/37 and recording a false FAIL. The tool's own timeout is the one that kills, and it is wall-clock.
- **Changed:** nothing but this ticket. No product code, no scripts, no other lane's files.
- **Verified:** observation only, from the system journal — `PM: suspend entry` 02:50:57, `suspend exit` 11:10:06 (8h19m09s). Agent A's tool call returned ~14 s after resume with the full gap inside it and committed ~9 min later; Agent B's loop returned `143`/"timed out" on thaw after 37/37. Read-only; nothing killed, no scope touched.
- **Still open / handoff:** everything. The next agent should start from **detection and attribution** — recognise the cross-suspend `143` fingerprint and refuse to count it as a genuine verification FAIL — not from trying to prevent the harness's wall-clock kill, which this repo does not own. For verify harnesses we DO own, prefer a monotonic/process-paused timer over a wall-clock deadline. Read BUG-114 before touching the host-leak consequence; it owns that mechanism.
- **Symptom of a deeper design flaw?** not answered — the ticket is open. The suspicion to test when closing it: whether a "verification FAIL" recorded by this system needs to carry provenance strong enough to tell "the suite failed" apart from "the process was killed by something unrelated to the code under test" (a wall-clock timeout, an OOM, a suspend) — i.e. whether a raw non-zero exit should ever be allowed to mean "verified failing" without that provenance.
