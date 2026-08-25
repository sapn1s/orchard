# BUG-096 — turn-end sweep FABRICATES a death for the child lanes of a background agent (BUG-068, one level down)

- **Status:** RE-FIXED (3rd attempt — routed through the single background-work authority after TWO independent BROKEN verdicts; awaiting restart to deploy; a THIRD clean-room verify pass is warranted — high-stakes, session-lifecycle/ledger-honesty). `regressed-from: BUG-096` (rework the gate caught on the 1st and 2nd passes). See the 2026-08-14 (3rd attempt) log entry.
- **Area:** src/server/agent-bridge.ts (turn-end `result` sweep, `#backgroundTasks`/`#bgBornTasks`, `task_started` handling) + src/server/outcomes.ts
- **Reported:** 2026-08-14 (found by a grounded investigation of a "reason unknown" agent ending the user refused to wave through)

## Symptom
The station recorded:
> local_bash (Run UI verify) — ended, reason unknown: the turn ended while this agent was still running
> and the engine reported no outcome for it

…for a step that **completed successfully**.

## Root cause (PROVEN from two transcripts — the record is fabricated)
- The step was a **FOREGROUND** Bash inside a dispatched worker subagent (`agent-<worker>.jsonl:140`,
  `npm run verify:ui`, **no `run_in_background`**) issued at `10:34:27.162Z`.
- Its `tool_result` returned with real PASS output at **`10:34:38.843Z`**.
- The station wrote the death at **`10:34:35.616Z`** — **3.2 s BEFORE the successful result arrived**,
  22 ms after the MAIN turn ended (main jsonl line 13041, `10:34:35.594Z`).

Mechanism:
- `agent-bridge.ts:2201-2239` — the turn-end (`result`) sweep settles every row still `status:'running'`
  and passes it to `outcomes.turnEndOutcome`.
- `agent-bridge.ts:2206-2207` — the sweep spares **only** `#backgroundTasks` ∪ `#bgBornTasks`.
- The async worker's OWN agent row is correctly spared, but the `local_bash` lane it spawned is a
  **separate task id that was never tagged background**. `task_started` handling
  (`agent-bridge.ts:2392-2423`) reads only `task_id`/`tool_use_id`/`subagent_type`/`task_type`/
  `description` — **there is no `parent_task_id` linkage anywhere in src/server/**. So the sweep sees an
  orphan-looking foreground bash row and settles it per the deliberate BUG-030/BUG-068 carve-out.
- `outcomes.ts:279-311` — with no completion evidence, the honest fallback is `kind:'unknown'` with that
  exact detail string (rendered at `:425`). `#resultDelivered` is only set from a `tool_result` whose
  `tool_use_id` is mapped (`agent-bridge.ts:2117`) — which arrived 3 s too late.

**Background-ness is not inherited down the lane tree.** That is the whole bug.

## NOT the causes that were suspected (both definitively excluded)
- **NOT BUG-046's turn-scoped-orphan class.** The worker obeyed its foreground-only charter — the
  transcript proves no `run_in_background`. **Do NOT change the worker charter**; weakening
  foreground-only would reintroduce BUG-046.
- **NOT the user's mid-session model switch.** No mechanism (`/model` → `set-model`
  index.ts:3316-3333 → `AgentSession.setModel` agent-bridge.ts:1117-1128 → `ClaudeRuntime.setModel`
  claude-runtime.ts:276-284 → `#applyModel` :1136-1144 mutates only `effective.model` and re-emits
  `effective-config`; it never touches `#agents`, never sweeps, never signals a process). AND
  temporally excluded: first `claude-opus-5` frame at `10:38:41.969Z` — **4 minutes AFTER** the event;
  the ending turn and the worker were both `claude-opus-4-8`.

## Why it matters (the harm is NOT cosmetic)
1. The running row is evicted while the step is still executing (`agent-bridge.ts:2210-2213` emits
   `agent-completed`) — the BUG-068 invisibility symptom returns, one level down.
2. **The false death is BRIEFED to the orchestrator** (main jsonl line 13073, `briefedAt` stamped): an
   orchestrator told a live, successful step "ended without completing" may distrust or **re-dispatch
   completed work**. That is exactly the BUG-037 harm the ledger exists to prevent, and exactly the
   near-miss that occurred in this session (a worker looked dead; only a liveness check prevented a
   duplicate lane racing it).
3. It violates the ledger's honesty invariant (`outcomes.ts:19-25`, BUG-041): the ledger emitted a
   **false negative claim about a passing verification**.

Verification INTEGRITY of that particular run is intact (the transcript proves the verify ran and
passed, and the worker reported real counts) — but a ledger that fabricates deaths for successful
verifies is a trust hole in the whole verification story.

## Recurrence (§N)
Ledger `agent-outcomes.json` (85 records, 2026-08-10 → 08-14): 33 `unknown`, of which **26 are
`local_bash`** — this exact fabricated shape. 25 predate the BUG-068 fix (deployed 2026-08-13); this is
the **1st occurrence of the not-yet-fixed sub-variant** (child lane of a background agent) and the
**27th of the fabricated-`local_bash`-death class overall** (BUG-037 → BUG-041 → BUG-068 → this).
Since async dispatch is now the standard pattern, expect recurrence on every async dispatch whose main
turn ends mid-child-bash.

## Wanted (fix the design, not another local patch)
1. **Propagate background-ness down the lane tree:** when a `task_started`/`task_progress` frame carries
   a parent linkage to a task in `#backgroundTasks` ∪ `#bgBornTasks`, add the child to `#bgBornTasks`
   (insertion point `agent-bridge.ts:2413-2421`).
   **FIRST STEP — probe:** determine whether the SDK's `task_started` frame actually carries a parent
   task/tool id for a subagent-issued Bash (nothing in src/server/ reads one today). The investigation
   could not determine this from artifacts; probe the real frames before designing on the assumption.
2. **If there is no parent field, use the honest fallback:** do NOT record an outcome for a `kind:'tool'`
   row when any background agent is still live at sweep time — settle the row SILENTLY rather than
   writing an `unknown` death. Under-reporting a possible death is the honest side of this trade
   (`outcomes.ts:19-25`); fabricating one is not.

## Verification (§C)
- MUST-FAIL repro of the exact adversarial ordering: async Task dispatched → child FOREGROUND bash
  starts → main `result` (turn end) → child `tool_result` arrives late. Pre-fix: an `unknown` death is
  written for a step that succeeded. Post-fix: no fabricated record; the row settles honestly.
- Anti-regress: `scripts/verify-bug-068-bash-background-visible.mjs` (a genuinely foreground main-thread
  bash must STILL settle at turn end — do not over-spare), plus the outcomes/ledger suites, typecheck,
  leak-gate.
- **Risk bucket:** session-lifecycle / ledger honesty — HIGH-STAKES per §N (4th in the class). Flag an
  independent clean-room verify pass.

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
