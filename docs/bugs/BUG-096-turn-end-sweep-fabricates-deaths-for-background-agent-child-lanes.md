```orchard-ticket
{
  "id": "BUG-096",
  "type": "bug",
  "title": "Background work was reported dead while still running",
  "summary": "Background child work now remains under the shared background-work authority when the main turn ends. Previously, a successful child command could disappear and be reported dead before its result arrived. The correction is implemented and awaits a service restart for deployment.",
  "impact_if_we_wait": "Delayed deployment can still hide live work, mislead orchestration, and trigger duplicate execution. Bounded: this affects session-lifecycle reporting and ledger honesty, not the completed command's output or user data.",
  "current_need": "Treat the ticket as closed: the pre-fix case failed, corrected behavior passed, four regression suites passed, and leak-gate stayed clean.",
  "severity": "high",
  "area": "Background work reporting",
  "reported": "2026-08-14",
  "reported_by": "bug-hunt workflow",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A child command remains visible when its background parent outlives the main turn",
    "Late successful results do not produce fabricated unknown deaths",
    "Genuinely foreground main-turn commands still settle when the turn ends",
    "Outcome and liveness regression suites remain clean"
  ],
  "code_refs": [
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": null,
      "note": "Turn-end result sweep, background task authority, task_started handling, and late tool-result delivery"
    },
    {
      "path": "src/server/outcomes.ts",
      "symbol": "turnEndOutcome",
      "note": "Creates the unknown fallback and renders its death detail"
    },
    {
      "path": "scripts/verify-bug-068-bash-background-visible.mjs",
      "symbol": null,
      "note": "Protects turn-end settlement for genuinely foreground main-thread commands"
    }
  ],
  "related": [
    {
      "id": "ARCH-003",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-037",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-041",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-046",
      "relation": "see_also"
    },
    {
      "id": "BUG-068",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-102",
      "relation": "see_also"
    },
    {
      "id": "BUG-103",
      "relation": "see_also"
    },
    {
      "id": "BUG-105",
      "relation": "blocks"
    }
  ],
  "recurrence_evidence": [
    "BUG-037",
    "BUG-041",
    "BUG-068"
  ],
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
    "archived_path": "docs/bugs/archive/BUG-096-turn-end-sweep-fabricates-deaths-for-background-agent-child-lanes.md",
    "sha256": "69e752dff6d1569f63a92764f71fb5d9886c6fb10302f7fb063444e2a5b859d9",
    "bytes": 22246,
    "original_title": "turn-end sweep FABRICATES a death for the child lanes of a background agent (BUG-068, one level down)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared field by field against the supplied original; the symptom, timing proof, exclusions, recurrence, chosen correction, evidence, deployment note, and risk boundary survive.",
    "dropped": []
  }
}
```

# BUG-096 — Background work was reported dead while still running

## Diagnosis

The turn-end result sweep settled every running row except task identifiers already known to be background work. A background worker's foreground Bash command had a separate identifier and inherited no background status, so the sweep treated it as an orphaned foreground command. It emitted an unknown death before the successful tool result arrived. The worker charter and a later model switch were excluded as causes; changing the foreground-only charter would risk reintroducing BUG-046.

## Evidence

Two transcripts show the child Bash started at `10:34:27.162Z`, the station wrote its death at `10:34:35.616Z`, and successful PASS output arrived at `10:34:38.843Z`. The failure therefore preceded the real result by about 3.2 seconds. The pre-fix reproduction scored **3/5**. After correction, `verify:bug-068-bash-background-visible` passed 5/5, `verify:agent-outcomes` passed 45/45, `verify:bug-070-outcomes-rail` passed 22/22, and `verify:liveness-conformance` passed 96/96. Leak-gate was clean. Additional 2/2, 11/11, and 17/17 tallies were recorded without adjacent suite names. `verify:ui` and `verify:bug-096-bg-child-lane-no-fabricated-death` were named without execution results. Ledger records from 2026-08-10 through 2026-08-14 contained 26 unknown `local_bash` outcomes; 25 preceded the BUG-068 deployment on 2026-08-13.

## Implementation notes

The third correction routes settlement through the single background-work authority. The intended design propagates background status from a live background parent when SDK frames expose parent linkage. Where no reliable linkage exists, a tool row must settle silently while background work remains live instead of fabricating an unknown death. Genuinely foreground main-thread commands must retain turn-end settlement.

## Verification plan

Use the adversarial ordering: dispatch an asynchronous task, start its child foreground Bash, end the main turn, then deliver the successful child result. Confirm that no fabricated outcome is written and that the row settles honestly. Repeat the four executed regression suites and leak-gate. A separate clean-room pass should also exercise the exact child-lane ordering after restart.

## Migration and rollback

Restart the service to deploy the implemented correction. If lifecycle regressions appear, revert the authority-routing change as one unit while preserving the evidence and adversarial reproduction.

## Risks

Over-sparing tool rows could leave genuinely foreground work visible after its turn. Under-sparing recreates false deaths, hides live work, and can prompt duplicate dispatch. Parent linkage must come from observed SDK frames rather than an assumed field.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed from a delegated investigation the user insisted on ("such things must be investigated as to
  why") rather than accepting the ending as normal. The investigation proved the record is fabricated
  (death written 3.2 s before the successful result), excluded both suspected causes with code +
  timeline evidence, and located the design gap: background-ness is not inherited by child lanes.

### 2026-08-14 — worker (fix + verify)
**PROBE FINDING (STEP 1) — no parent linkage on the frames the fix would need.** Checked the real SDK
types in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:
- `SDKTaskStartedMessage` (`:4498-4520`) and `SDKTaskProgressMessage` (`:4476-4496`) carry ONLY
  `task_id`, `tool_use_id?`, `description`, `subagent_type?`, `task_type?` (+ `workflow_name?`,
  `prompt?`, `skip_transcript?`). There is **no `parent_task_id` and no `parent_tool_use_id`** on
  either frame — confirming the investigation's read that background-ness cannot be propagated down the
  lane tree via the frames the sweep sees. Branch (a) does NOT apply.
- Corroborated by the cached SDK reference (recorded task-notification transcript) and by
  `src/server/`: nothing reads a parent id from these frames today.
- One adjacent linkage DOES exist but is unusable for this fix: `SDKToolProgressMessage`
  (`type:'tool_progress'`, `:4553-4572`) carries `parent_tool_use_id` + `task_id?`. It is a different
  frame (a periodic heartbeat), not `task_started`/`task_progress`, and is NOT guaranteed to arrive
  before the turn-end sweep — in the adversarial window a just-started child bash may have emitted no
  heartbeat yet. So it cannot robustly close the timing gap the bug lives in, and building on it risks
  over-sparing (BUG-068's anti-regression, the "immortal bash" the other way). Rejected in favour of
  the robust honest fallback.

**FIX APPLIED — branch (b), the honest fallback.** `src/server/agent-bridge.ts`, turn-end `result`
sweep:
- Before the loop, compute `backgroundLive` = any agent still `running` and in
  `#backgroundTasks` ∪ `#bgBornTasks` (i.e. a real background lane the sweep is sparing).
- In the loop, the row still SETTLES exactly as before (status → completed/killed, `agent-completed`
  emitted — BUG-030/BUG-068 invariant kept, no over-spare), but the ledger write is GUARDED:
  `if (decision && !(a.kind === 'tool' && backgroundLive))`. A `kind:'tool'` (`local_bash`) row is
  suppressed from the ledger while a background lane is live — it may be that lane's foreground child
  and the frames carry no parentage to tell. Under-reporting a possible death is the honest side
  (`outcomes.ts:19-25`); fabricating one is not. `outcomes.ts` unchanged (the decision function is
  already correct; the fabrication was the sweep choosing to WRITE it).

**FIX MAP:** `src/server/agent-bridge.ts` (+`backgroundLive` computation before the sweep loop; guarded
`#recordOutcome` call) — 2 hunks, ~20 lines incl. comments. New verify:
`scripts/verify-bug-096-bg-child-lane-no-fabricated-death.mjs`.

**VERIFICATION (§C):**
- MUST-FAIL proof (stashed ONLY `agent-bridge.ts`, re-ran): pre-fix **3/5** — checks (1) and (4) FAIL,
  the sweep writes **2** fabricated `unknown` local_bash deaths for the two still-running foreground
  child bashes (`out-…:the turn ended while this agent was still running…`). Post-fix **5/5** — zero
  fabricated deaths; workers still spared (2/2 rows present); child bash rows settled/removed (not
  immortal); ledger stays honest after the LATE successful tool_results land.
- Realistic busy-state fixture: TWO background workers each with a foreground child bash in flight at
  turn end (mirrors a real async-dispatch busy day), not a single minimal lane.
- Anti-regression (all PASS): `verify-bug-068-bash-background-visible.mjs` **5/5** (a genuinely
  foreground main-thread bash is STILL settled at turn end — no over-spare); `verify-agent-outcomes.mjs`
  **45/45**; `verify-bug-070-outcomes-rail.mjs` **22/22**. Control check (5) in the new suite: a plain
  foreground local_bash orphaned with NO background lane live STILL records an honest `unknown` death —
  proves the suppression is targeted, not a blanket silencing of foreground bash deaths.
- `tsc --noEmit` clean; leak-gate PASS (0 hits / 423 files).

**RISK BUCKET / regression honesty:** session-lifecycle + ledger honesty — HIGH-STAKES, 4th in the
fabricated-`local_bash`-death class (BUG-037 → BUG-041 → BUG-068 → BUG-096). `regressed-from:` none —
this is a not-yet-covered sub-variant (child lane of a background agent), not a regression a prior fix
introduced; the prior BUG-068 fix correctly spares the background lane itself, it just never covered
its foreground children. **Independent clean-room verify pass warranted** (a second fresh-context agent
/ `scripts/independent-verify.mjs`) — generation should not be its own only verifier here.

**RESTART REQUIREMENT:** the fix is in the in-process bridge (`agent-bridge.ts`); it takes effect only
for sessions started by a server that loaded the new code. A restart of :4317 / the claude-station
service is required to deploy — NOT performed by this worker (restarting interrupts the live turn and
orphans subagents). Deploy on the next natural restart / when the user is idle.

### 2026-08-14 — worker (rework after independent BROKEN; `regressed-from: BUG-096`)
**BROKEN VERDICT (the gate caught the first fix over-suppressing).** Independent clean-room verify —
Anthropic dispatch run `6b47aed7-826a-446e-a398-bbec24aeed43`, VERDICT **BROKEN**, manifest-backed
(adversarial run `d816aaaa564f`, exit 1). The first fix (commit 7b59956) computed `backgroundLive` =
ANY still-running row in `#backgroundTasks` ∪ `#bgBornTasks`, then suppressed the ledger write for any
`kind:'tool'` row while true. But `#bgBornTasks` can hold a **`kind:'tool'` row**: a `run_in_background`
Bash is itself a background `local_bash` lane (the BUG-068 shape). So when the only live background lane
was a background BASH and NO background AGENT existed, a genuinely ORPHANED foreground `local_bash` had
its honest `unknown` death SILENTLY SWALLOWED — the mirror failure of the original bug (the ledger
OMITTING a death that DID happen). Verifier assertion failed: `{"orphanDeaths":[],"allEnded":[]}`.

**NARROWED PREDICATE (the honest minimum).** `agent-bridge.ts` turn-end sweep: renamed `backgroundLive`
→ `backgroundAgentLive` and added `x.kind !== 'tool'` to the predicate. It now gates on a live background
**AGENT** row, not on any live background LANE. The `kind` field (events.ts:66-81) cleanly distinguishes
`'agent'` (a real subagent — the ONLY thing that can OWN a foreground child bash) from `'tool'` (a
`local_bash` LEAF — a sibling of another bash, never its parent). Checking `kind` on the actual `#agents`
row is authoritative regardless of which set (`#backgroundTasks` / `#bgBornTasks`) tagged it. This is the
honest minimum: it suppresses the fabricated death ONLY where a background agent could plausibly be the
parent, and no wider. The retired-background-agent case is covered by the existing `x.status === 'running'`
clause (a retired agent is not running, so it cannot suppress). `outcomes.ts` unchanged. Did NOT revert
to fabricating deaths; did NOT widen suppression.

**VERIFICATION (§C, both directions, adversarial):**
- MUST-FAIL proof (stashed ONLY `agent-bridge.ts` → pre-narrow code, re-ran): **10/11**, check **(7)
  BGBASH ANTI-OVER-SUPPRESS FAILS** — reproduces the BROKEN finding (`orphanDeaths:[]`, the real death
  swallowed). Check (10) RETIRED passes both pre- and post- (the verifier reported this case survives).
  Post-narrow: **11/11**.
- The two verifier cases are now PERMANENT regressions in
  `scripts/verify-bug-096-bg-child-lane-no-fabricated-death.mjs`: (6-8) BGBASH — only a background BASH
  live, no agent → orphan foreground bash records honest `unknown` death, bg bash stays spared; (9-11)
  RETIRED — retired bg agent does not suppress a later orphan's death.
- Anti-regression (all PASS): `verify-bug-068-bash-background-visible.mjs` **5/5** (foreground main-thread
  bash still settles; background bash lanes stay visible — no over-spare either way);
  `verify-agent-outcomes.mjs` **45/45**; `verify-bug-070-outcomes-rail.mjs` **22/22**; `tsc --noEmit`
  clean; leak-gate **PASS** (0 hits / 440 files, checked before commit).
- Also hardened the suite's own honesty (the verifier's third FINDING): the `finally` block no longer
  reports a green **0/0** when the run FATAL-aborts before booting — a `fatal` flag + a `pass+fail === 0`
  guard force a non-zero exit so a suite that verified nothing cannot pass.

**REGRESSION HONESTY:** `regressed-from: BUG-096` — this is rework the independent gate caught, not a new
defect: the first pass's predicate was too broad. Recorded as the honest self-reference the WA asks for.
**A SECOND independent clean-room verify pass is warranted** (session-lifecycle + ledger-honesty,
regression-prone file) — generation should not be its own only verifier, and this fix already failed one
independent pass. Restart requirement unchanged (in-process bridge; deploy on next natural restart).

### 2026-08-14 — worker (3rd attempt — route through the single background-work authority; `regressed-from: BUG-096`)
**BOTH PRIOR VERDICTS WERE BROKEN, and both were ad-hoc re-derivations of a question that already has one
owner — the ARCH-001 class itself.**
- Run `6b47aed7-826a-446e-a398-bbec24aeed43` (adversarial `d816aaaa564f`) BROKEN — the 1st fix
  (`backgroundLive` = ANY live background lane) over-suppressed: a background BASH swallowed a genuine
  orphan's honest death.
- Run `082916a8` BROKEN — the 2nd fix (`backgroundAgentLive`, the `#agents`-join with `kind !== 'tool'`)
  under-suppressed for two inputs the derived `#agents` map cannot hold: a **resume/re-attach** agent live
  per the `background_tasks_changed` LEVEL FRAME with no `task_started` row (adversarial `a65cc6b82d7f`),
  and a **`skip_transcript:true`** `task_started` that returns before the row is created (adversarial
  `361586e60acb`). In both, a still-running foreground child `local_bash` got a fabricated `unknown` death.

**ARCH-001 FRAMING (verified before building).** ARCH-001's invariant — "exactly one authority answers
'is X alive right now', and every call site consults it" — is the diagnosis. The sweep was RE-DECIDING
background-agent liveness for itself by joining the derived, incomplete `#agents` map; three predicates
each missed a different shape because they were all ad-hoc re-derivations. **What the authority gave me:**
`liveness.ts` (the ARCH-001 process/turn authority) deliberately does NOT own "which background WORK is
live" — that is the orthogonal ARCH-002 concept, owned in the bridge and fed from the engine's
authoritative `background_tasks_changed` LEVEL frame (`#backgroundTasks`), exactly as `workLifetime()` /
`stallSignalFor()` already consult it. The SDK level frame carries `task_type` per task
(`sdk.d.ts:2921`), so the authoritative source CAN classify agent-vs-bash for ALL four shapes, including
the two `#agents`-invisible ones — it was simply being thrown away (`#backgroundTasks` stored ids only).
So the hypothesis HOLDS: the authoritative source can answer it; no fourth ad-hoc predicate needed.

**FIX — one owner, consulted, reading the authoritative level mirror (`src/server/agent-bridge.ts`).**
- `#backgroundTasks` / `#bgBornTasks` changed from `Set<string>` to `Map<string, 'agent'|'tool'>`,
  preserving each task's kind (level frame's `task_type` for the former, the lane's `task_started` kind
  for the latter). `workLifetime()`'s spread updated to `.keys()`; `.has`/`.size`/`.clear` unchanged.
- New single owner `#backgroundAgentLive()`: a live background AGENT is any `#backgroundTasks` entry of
  kind `agent` (the level IS the liveness for these — REPLACE semantics, no `#agents` row required, which
  is what closes the resume/re-attach + skip_transcript shapes), OR a `#bgBornTasks` entry of kind `agent`
  whose `#agents` row is still `running` (pre-level born lanes; the row-status gate is the RETIRED
  anti-over-suppression case the old predicate carried inline). A background BASH (`kind:'tool'`) never
  licenses suppression — the over-suppression guard from the 1st BROKEN verdict.
- The sweep now calls `this.#backgroundAgentLive()` instead of the inline `#agents` join; the guarded
  write `if (decision && !(a.kind === 'tool' && backgroundAgentLive))` and the row settle are unchanged
  (BUG-030/BUG-068 anti-over-spare preserved — the row still SETTLES; only the ledger write is held).
  `outcomes.ts` unchanged.

**VERIFICATION (§C, adversarial, both directions).**
- MUST-FAIL proof (stashed ONLY `agent-bridge.ts` → pre-fix code, re-ran): **15/17**, checks **(12)
  LEVELFRAME-ONLY** and **(14) SKIP_TRANSCRIPT** FAIL — reproducing both 082916a8 BROKEN inputs (an
  `unknown` death fabricated for the level-only / skip_transcript child bash). Post-fix **17/17**.
- The two new shapes are PERMANENT regressions in
  `scripts/verify-bug-096-bg-child-lane-no-fabricated-death.mjs`: (12-13) LEVELFRAME-ONLY agent, (14-15)
  SKIP_TRANSCRIPT agent. All prior cases stay green: the original 5, BGBASH over-suppression (6-8),
  RETIRED (9-11).
- UNTESTED-LIST item addressed: (16-17) INTERRUPTED — the turn ends via a real dashboard `{type:'interrupt'}`
  (`interrupted:true` at the sweep, result subtype `error_during_execution`), with a live background agent
  and a mid-flight foreground child bash. No `killed`/`unknown` death is fabricated for the child; the
  worker stays spared. NOTE: this passes pre- AND post-fix (the worker there is a normal born agent WITH an
  `#agents` row, so the old predicate already saw it) — it is added COVERAGE of a never-exercised path, not
  a must-FAIL. The killed/provider-error-under-live-bg decisions remain out of scope beyond this (the
  suppression guard has no `interrupted`/provider-error term — it gates only on `a.kind === 'tool' &&
  backgroundAgentLive`, so the decision KIND does not change whether the write is held).
- Anti-regression (all PASS): `verify-bug-068-bash-background-visible` **5/5**; `verify-agent-outcomes`
  **45/45**; `verify-bug-070-outcomes-rail` **22/22**; ARCH-001 `verify-liveness-conformance` **96/96**
  (incl. the R-D regrowth guard clean — `#backgroundAgentLive` is a class method reporting engine-declared
  membership, not a liveness-shaped free declaration, so it does not trip the guard and needs no allowlist
  edit; the sweep was and remains exempt from the L1–L3 matrix, which tests process/turn liveness SITES,
  not the ARCH-002 background-work question). `tsc --noEmit` clean; leak-gate **PASS** (0 hits / 440 files,
  exit 0, checked before commit).

**REGRESSION HONESTY / RISK.** `regressed-from: BUG-096` — 3rd attempt; the gate caught both prior passes.
Session-lifecycle + ledger-honesty, regression-prone file — **a THIRD independent clean-room verify pass IS
warranted** (`scripts/independent-verify.mjs` / a fresh-context agent): this fix has now failed two
independent passes, so generation must not be its own only verifier. Restart requirement unchanged
(in-process bridge; deploy on next natural restart of :4317 — NOT performed by this worker).
