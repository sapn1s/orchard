```orchard-ticket
{
  "id": "BUG-115",
  "type": "bug",
  "title": "An overnight machine suspend recorded a passing suite as failed",
  "summary": "A machine slept for over eight hours while verification work was running. On waking, the harness's timer treated the frozen hours as elapsed work and killed a suite that had already been passing, recording it as a failure. A second agent's own timer paused with the machine and finished normally.",
  "impact_if_we_wait": "A suite that was green can be posted as red, and a person or a gate may act on a result that never happened. Bounded: it needs an actual suspend during a run, no data is lost, and the leaked-process side already has its own ticket.",
  "current_need": "Decide whether to build the suspend-window detection that marks such a result inconclusive, or leave the pattern to be spotted by hand.",
  "severity": "high",
  "area": "Verification result trust",
  "reported": "2026-08-19",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "decide",
  "updated": "2026-08-19",
  "decision": {
    "mode": "single",
    "question": "Should a kill that brackets a machine suspend be marked inconclusive automatically, or spotted by hand?",
    "options": [
      {
        "key": "A",
        "label": "Detect the suspend window",
        "what_changes": "A result carrying the timeout-kill fingerprint whose span brackets a recorded sleep is recorded as inconclusive rather than failed.",
        "benefit": "A killed-across-sleep run stops being indistinguishable from a real failure.",
        "cost": "Needs a way to read the machine's sleep record, plus a test that simulates a sleep bracketing a killed command.",
        "why_not_obvious": "A wrong window match would relabel a genuine failure as inconclusive, which hides the exact class of result the project most wants to trust."
      },
      {
        "key": "B",
        "label": "Leave it to the reader",
        "what_changes": "Nothing is built; whoever reads the result notices the pass-count-then-kill shape as happened here.",
        "benefit": "No work, and the one observed case was caught and re-run without any tooling.",
        "cost": "It was caught by luck, and an unattended sleep can post the red result while nobody is watching.",
        "why_not_obvious": "The failure only appears when nobody is checking, so the absence of further reports is not evidence it is rare."
      }
    ],
    "recommendation": "A",
    "recommendation_reason": "It removes a false verdict from the one class of result this project most needs to trust, and it can be added without touching any product path.",
    "prerequisite": "Establish that this machine's sleep record is reliably readable after the fact. If it is not, automatic detection has nothing to match against."
  },
  "decision_history": [],
  "success_criteria": [
    "A timed-out result whose span brackets a recorded sleep is marked inconclusive, not failed",
    "A genuine suite failure is still recorded as a failure",
    "Verification loops this project owns use timers that pause with the machine",
    "No claim is made that the external harness timer can be prevented from firing"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-114",
      "relation": "see_also"
    },
    {
      "id": "FEAT-061",
      "relation": "see_also"
    },
    {
      "id": "BUG-097",
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
    "archived_path": "docs/bugs/archive/BUG-115-suspend-across-run-fires-wall-clock-tool-timeout-false-fail.md",
    "sha256": "c8e218e5e5bfc260eaeab69dd87f7ba3fb35743b4070a483e638e071483ea5cc",
    "bytes": 10079,
    "original_title": "a machine suspend fires the agent harness's wall-clock tool timeout on thaw, manufacturing a false verification FAIL",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: both clocks, the journal timeline, the false-verdict harm, the ownership boundary, the four bars a fix must clear, and the leak cross-reference are present.",
    "dropped": [
      "the arithmetic gloss on exit code 143",
      "the restatement of the severity cap, which the severity field now carries"
    ]
  }
}
```

# BUG-115 — An overnight machine suspend recorded a passing suite as failed

## Diagnosis

Whether in-flight work survives a machine suspend depends on which clock its timeout uses, and the two clocks in play behave oppositely across a freeze.

One agent was blocked on a local subprocess launched under coreutils `timeout 500` (500 minutes). That timer is process-paused: it did not advance while the machine was frozen, so on thaw the command simply continued and completed.

The other agent was inside the Claude CLI Bash tool's own timeout, which is wall-clock. It counted the frozen hours as elapsed work and fired immediately on thaw, SIGKILLing a verification-suite loop that was passing.

The hazard is that the killing timer is the wall-clock one, and it belongs to the agent harness rather than to this repo. We cannot make it monotonic or teach it about suspend, so the achievable deliverable is detection and correct attribution, not prevention — a fix that implies otherwise is dishonest.

Nothing structurally separates "killed by a wall-clock timeout across a suspend" from "the suite genuinely failed". This time the agent happened to notice the shape and re-ran; nothing guaranteed that.

## Evidence

Grounded from the system journal on the affected machine: `PM: suspend entry` at 02:50:57, `PM: suspend exit` at 11:10:06, a frozen duration of 8h19m09s.

The surviving agent's tool call returned ~14 s after suspend exit with the whole 8h19m gap contained inside the single call, and its work committed ~9 min later. No error surfaced.

The killed agent's loop had already passed 37/37 before the freeze. On thaw the tool timeout fired at once: `Exit code 143 — Command timed out after 10m 0s`. The remaining iterations never ran, and the outcome was recorded as a failure on a suite that was passing.

This is an observation ticket. No product code changed, and there is nothing to reproduce on demand — a real suspend has to straddle a running tool call.

## Implementation notes

A SIGKILLed suite loop is a known producer of orphaned session hosts; BUG-114 owns that defect (a snapshot there showed 25+ leaked scopes holding ~731 MB). Cross-reference it, do not re-file it. This ticket's novel harm is the false verdict.

The reason a false FAIL is a first-class harm here is the wider effort to make verification results mean what they say — see the independent-verification work in FEAT-061 and the verdict contract in BUG-097.

Where this project owns the clock, verify harnesses could prefer monotonic or process-paused timing (as coreutils `timeout` did here) over any wall-clock deadline. That does not reach the harness's Bash-tool timeout, and the write-up should say so plainly.

## Verification plan

No repro test exists. A realistic one injects or simulates a suspend window bracketing a `143`-terminated command and asserts the outcome is recorded as inconclusive rather than a failure. A fix lane should add it.

The property to prove is that a killed-across-suspend result is distinguishable from a genuine failure — a fix here is detection and attribution, not prevention.

## Risks

Suspend windows are read from a local system record; if that record is missing or imprecise, the detection either misses a killed run or misattributes a real failure.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-19 — filing lane (report only; no fix attempted, no product code touched)

- **Understood:** a suspend across a running tool call has opposite outcomes depending on the timeout's clock. coreutils `timeout` (monotonic/process) pauses with the frozen process and the command completes on thaw; the Claude CLI Bash tool's wall-clock timeout fires on thaw (`Exit code 143 — Command timed out after 10m 0s`), SIGKILLing a verify loop that had passed 37/37 and recording a false FAIL. The tool's own timeout is the one that kills, and it is wall-clock.
- **Changed:** nothing but this ticket. No product code, no scripts, no other lane's files.
- **Verified:** observation only, from the system journal — `PM: suspend entry` 02:50:57, `suspend exit` 11:10:06 (8h19m09s). Agent A's tool call returned ~14 s after resume with the full gap inside it and committed ~9 min later; Agent B's loop returned `143`/"timed out" on thaw after 37/37. Read-only; nothing killed, no scope touched.
- **Still open / handoff:** everything. The next agent should start from **detection and attribution** — recognise the cross-suspend `143` fingerprint and refuse to count it as a genuine verification FAIL — not from trying to prevent the harness's wall-clock kill, which this repo does not own. For verify harnesses we DO own, prefer a monotonic/process-paused timer over a wall-clock deadline. Read BUG-114 before touching the host-leak consequence; it owns that mechanism.
- **Symptom of a deeper design flaw?** not answered — the ticket is open. The suspicion to test when closing it: whether a "verification FAIL" recorded by this system needs to carry provenance strong enough to tell "the suite failed" apart from "the process was killed by something unrelated to the code under test" (a wall-clock timeout, an OOM, a suspend) — i.e. whether a raw non-zero exit should ever be allowed to mean "verified failing" without that provenance.
