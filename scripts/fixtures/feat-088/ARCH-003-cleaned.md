# ARCH-003 — when a turn ends we guess whether a background job died, and the guess keeps being wrong

- **Status:** OPEN — DECISION NEEDED (no build until a human picks an option)
- **Raised from:** BUG-096, after three independent checks rejected three different fixes
- **Reported:** 2026-08-14

## The situation

When one of our agents finishes its turn, some small jobs it started may still be running. Right at that
moment the system has to write down what happened to each one: is it still going because a helper is still
working, or did it get abandoned and quietly die? Nobody tells us — the system guesses from partial
information it has to hand.

The guess is wrong often enough to matter, in both directions. Sometimes it writes down that a job died when
the job actually finished fine a second later. Sometimes it writes down nothing when a job really was
abandoned. Each attempt so far passed its author's own tests, then failed an independent check on a case the
author had not modelled.

## What this costs us

The record of what happened stops being trustworthy, and the agent in charge reads that record. When it is
told a finished step died, it either distrusts work that is already complete or dispatches it all over again —
wasted effort and a confused run. That has already happened once (BUG-037) and nearly happened again while
this was being investigated. When the record goes the other way and stays silent about a job that really did
die, a genuine failure disappears with nobody noticing. That direction is worse.

Nothing is broken for you right this minute: none of this takes effect until the service is restarted. But the
version currently saved in the codebase is the one with the silent-failure behaviour, and this ticket stays
blocked until someone picks a direction.

## The decision

Four ways to stop being wrong. Pick one (or the recommended pair).

- **A — Keep tweaking the guess.** Carry on repairing the current approach, case by case.
  *Cost:* it has already been patched and re-patched and still depends on an internal detail of the engine we have
  never actually confirmed. *Benefit:* smallest change.
- **B — Decide later instead of on the spot. (Recommended.)** Stop deciding at the end of the turn. Mark the
  job "not yet known" and wait for reality: if the job's result turns up — it did, about a second later, in
  every case we reproduced — write down what really happened; if nothing turns up within a time limit, write
  down that it died. *Cost:* the most new code (a waiting step and a timeout). *Benefit:* removes the guessing
  altogether and fixes both directions of the error.
- **C — Never record a death for these small jobs without proof.** Stay quiet unless we positively saw a
  failure. *Cost:* we will sometimes miss a job that genuinely was abandoned. *Benefit:* very simple, and it
  never invents a failure that did not happen.
- **D — Leave the record alone; just stop alarming the agent.** Keep writing what we write, but stop telling
  the agent in charge about these uncertain deaths, since that report is what causes the actual damage.
  *Cost:* the stored record can still be inaccurate. *Benefit:* smallest change that removes the real harm.

**Recommendation: B together with D.** B is the only option that stops guessing and uses what actually
happened, so it fixes the problem properly; D is cheap and shields the agent from bad reports in the meantime.

**And while you decide:** the code as it stands has the more dangerous behaviour of the two. We can leave it
alone or roll back to the previous attempt, whose mistake was louder and less dangerous. My suggestion is to
leave it: a rollback adds churn ahead of a decision that replaces both versions anyway.

## How we got here

Each attempt missed a different case.

1. **First fix.** Treated any background work still running as evidence that the job had a live parent. Missed
   that a background shell is a sibling, not a parent — so a job that really had been abandoned had its death
   swallowed.
2. **Second fix.** Narrowed it to background *agents* only, by looking for the agent's own record. Missed that
   a resumed or re-attached session never creates that record, and neither do agents that skip transcript
   creation — so invented deaths came back.
3. **Third fix.** Switched to the engine's own list of background tasks. Failed in *both* directions at once:
   the list is never cleaned up, so once a listed agent retires it keeps vouching for jobs that really did die;
   and a task that is started with transcript creation skipped never gets added to the list in the first place,
   so in the moment before the engine's list arrives, invented deaths return.

That is why this is being raised as a design question rather than filed as another patch. The information the code needs — is the thing
that started this job still alive? — simply is not reliably available at the instant it has to decide.

## Technical detail (reference — skip unless you are fixing this)

Everything below is for whoever implements the chosen option. It is the original engineering write-up,
preserved.

### The invariant being broken (one testable sentence)

**The outcomes ledger must record a death if and only if the step actually died** — it must never fabricate
a death for a step that succeeded, and never swallow a death for a step that genuinely failed.

### The design that produces the class

At turn end, the sweep must decide *right now* whether a still-running `local_bash` row is (a) a child of a
live background agent — settle silently, its result is still coming — or (b) genuinely orphaned — record an
honest death. It answers this by INFERRING parentage from engine frames. Every implementation has been a
different inference, and each one has a different blind spot, because the frames carry ordering and pruning
races that no point-in-time inference can resolve.

### Evidence: three fixes, three BROKEN verdicts, six distinct failure shapes

| Attempt | Predicate | Independent verdict | What it missed |
|---|---|---|---|
| 1 (`7b59956`) | any background lane live | BROKEN — run `6b47aed7` | a background **bash** is a sibling, not a parent → swallowed a real orphan's death |
| 2 (`6ac3da2`) | background **agent** row live (`#agents` + `status==='running'`) | BROKEN — run `082916a8` | level-frame-only agents (resume/re-attach) and `skip_transcript` agents have **no `#agents` row** → fabricated deaths returned |
| 3 (`b3762f2`) | authoritative level-frame map (`#backgroundTasks` typed) | BROKEN — run `e9323696` | **both directions at once** (below) |

Attempt 3's two findings are **opposite failures**, which is why this is architectural rather than a bug:

- **Over-suppression** (`agent-bridge.ts:1794`): `#backgroundTasks` membership has no liveness gate and is
  **never pruned** — neither `task_updated` (:2539) nor `task_notification` (:2561) removes a retired task.
  After a level-listed background agent retires, a genuinely orphaned foreground bash has its honest death
  **silently swallowed** (run `fab563410c36`: `allEnded: []`). This is the WORSE direction — a real failure
  signal disappears.
- **Under-suppression** (`agent-bridge.ts:2484`): `task_started` returns on `skip_transcript === true`
  *before* the `#bgBornTasks` tag (:2513), so in the **pre-level window** a `run_in_background` Task is in
  neither map → the original fabricated death returns (run `4ccf4341efae`).

Plus an unverified dependency the verifier flagged: classification hinges on `task_type === 'local_agent'`;
**any other spelling silently degrades to 'tool'** and fabrications return. The real engine's vocabulary was
never observed (every run drove a scripted fake CLI). `local_workflow` lanes are likewise unclassifiable
without engine ground truth.

**Why prior local patches did not hold:** each fixed the case its author could imagine and was refuted by a
case they could not. The information needed (is this lane's parent alive?) is simply not reliably available
*at the instant the sweep runs*.

### Options in engineering terms (same four as above)

**Option A — keep patching the predicate.** Prune `#backgroundTasks` on terminal frames, tag before the
`skip_transcript` early-return, and confirm the engine's `task_type` vocabulary.
*Cost:* smallest diff. *Risk:* the tail is demonstrably long (many failure shapes across the attempts); the pre-level window
is a genuine race that pruning does not close; still depends on an unverified engine string.

**Option B — decide LATER, not at the sweep (recommended).** Defer the decision past the sweep. Mark the row
*unresolved* and let ground truth settle it: if the `tool_result` arrives (it did, ~900ms later, in every
reproduced case), record the real outcome; if nothing arrives within a bounded window, record the death then.
*Cost:* introduces a deferred-resolution path and a timeout. *Benefit:* removes parentage inference entirely
— it uses what actually happened instead of guessing what might. Directly kills both failure directions.

**Option C — never fabricate for tool rows.** Settle `kind:'tool'` rows silently every time; record a
death only on positive evidence of failure. *Cost:* under-reports genuine orphan deaths. *Benefit:* trivially
simple and always honest-by-omission (the side `outcomes.ts:19-25` already declares acceptable).

**Option D — fix the HARM, not the record.** Keep recording, but stop **briefing** `unknown` tool deaths to
the orchestrator. The actual damage (BUG-037, and the near-miss this session) is an orchestrator distrusting
or re-dispatching completed work because it was told a live step died. *Cost:* the ledger still contains
inaccurate rows. *Benefit:* smallest change that removes the real-world consequence.

**B + D combine well** and are my recommendation if you want this closed properly rather than cheaply.

### Migration path (whichever is chosen)

1. Land the chosen mechanism behind the existing BUG-096 suite (17 checks) — all six known shapes stay
   permanent regressions.
2. Re-verify with a clean-room pass; this fix has failed two, so a pass is required, not optional.
3. Only then deploy (needs a `:4317` restart; the in-process bridge means the change is inert until then).

### Proof bar

**Right:** no fabricated death in ANY of the six shapes, AND a genuinely orphaned foreground bash still
records its honest death when no background parent exists — both directions, verified independently.
**Falsified by:** any single input where a successful step is recorded dead, or a failed step is not recorded.

### Interim state — needs a call

The current committed HEAD is attempt 3, which introduced the **silent-swallow** path (worse direction) while
fixing more fabrication cases. No user is affected yet, because a restart is required first.
**Options:** leave HEAD as-is pending the decision, or revert to attempt 2 (fabricated deaths are louder and
less dangerous than swallowed ones). My recommendation: leave it — reverting adds churn
ahead of a decision that supersedes both.

## Activity log (APPEND-ONLY)

### 2026-08-14 — orchestrator
- Raised per §N after the third BROKEN verdict on BUG-096. Not filed as a fourth patch: the attempts each
  passed their author's own tests and were each refuted by a case the author never modelled, and attempt 3
  failed in both directions simultaneously. No build until a human picks an option.
