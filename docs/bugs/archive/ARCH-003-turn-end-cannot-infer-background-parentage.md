# ARCH-003 — when a turn ends we guess whether a background job died, and the guess keeps being wrong

- **Status:** VERIFIED (fix in tree at `28bc233`; **NOT LIVE** — deploy needs a `:4317` restart, and that restart is what the VERIFIED → DONE edge is waiting on). The 11th independent clean-room verification returned **HOLDS** — the first non-BROKEN verdict after TEN consecutive correct BROKENs — from adversarial cases this lane's fixtures do not contain: a 20,000-seed randomised fuzz to depth 4 across 8 names with freely interleaved and repeated signals, and a 6,000-run index-boundedness drain measuring peaks. That HOLDS is FAIL-SENSITIVE rather than a fixture that cannot fail: the same fuzzer re-run against the pre-fix module fires at seed 8. Its TWO NAMED RESIDUALS ARE NOW CLOSED BY EVIDENCE, not by assumption. (1) *It never ran the server-backed suite* — all its evidence was direct drives against a bridge predicate it modelled itself. Run against the COMMITTED tree in a detached worktree: `verify-arch-003-open-tool-calls` **39/39 exit 0** (the 37 of the previous pass plus two new calibration checks), `adversarial-arch-003-reservation-corpus` **12/12 exit 0**, `verify-arch-003-growth-bound` **25/25**, `verify-arch-003-owner-lifetime` **13/13**, `verify-arch-003-per-row-owner-sweep` **5/5**, `adversarial-arch-003-reservation-window` **9/9**, `-id-reuse-chain-truncation` **7/7**, `-nested-terminal-owner` **7/7**, `-boundary-between-signals` **6/6**, `-result-before-open-growth` exit 0; BUG-096 **17/17**, BUG-105 **73/73**, running-snapshot **47/47**, stall-detector **33/33**, drain-truth **18/18**, agent-outcomes **45/45**, liveness-conformance **96/96**, all exit 0. (2) *The immutability claim was never type-checked* — the verifier's loader strips types without checking them, so only runtime behaviour was confirmed. It is now DEMONSTRATED: a scratch copy of the module attempting `rec.parentHandle=`, `rec.parent=`, `rec.state=` and `rec.id=` is rejected by the project's own `tsc --noEmit` with four `TS2540: Cannot assign to '<field>' because it is a read-only property` (**exit 1**), while the ONE deliberate exception `rec.aged` compiles; deleting the scratch file returns the typecheck to **exit 0**. "A post-creation ancestry write is a COMPILE ERROR" is now a demonstration, not a sentence. AND ONE GUARDED ITEM IS CONVERTED FROM AN ARGUMENT INTO A NUMBER. The "description arriving more than one boundary late" residual (16,520 of the corpus's 1,209,888 configurations, an EARLY DEATH — the (b) direction) has been carried across three verdicts on the unmeasured claim that "a description two boundaries late is not a reachable ordering". Measured over the real captured session store — **3,722 sessions, 130,575 owner references** — the frame that MINTS an owner is EARLIER **130,499** times and later **50** times, and every one of those 50 is later WITHIN THE SAME TURN: **`maxBoundariesLate` is 0**, so the one-boundary grace exceeds the worst ordering this machine has ever recorded by a FULL boundary. Pinned as check (15), with (15b) re-taking the id-reuse calibration on this machine rather than transcribing it (**114,799** tool calls / **114,695** results across 3,722 sessions: **0** repeated `tool_use` ids, **0** duplicate `tool_result` ids); both SKIP — explicitly not counted as passes — when no store is present, verified by running the suite under an empty `HOME` (**37/37**, the two checks absent). THE REMAINING GUARDED ITEMS ARE ACCEPTABLE RESIDUALS, AND THEY WERE ATTACKED RATHER THAN ACCEPTED — four times on this ticket a "guarded, only an ambiguity" label hid a real corruption, so the label was not taken at face value. Item 1 (*which call a LANE named `P` is after a re-use*) is the one the corpus does not GRADE, so it is the one a grader premise could be hiding; probed directly in the four directions that could corrupt: a live child keeps its live ancestry through a re-use (`["P","R1"]`, lane `P` correctly empty), a child of the OLD generation is NEVER moved onto the NEW root (the move that would suppress a real death) even when the old root dies and the new one lives, repeats in either order across three boundaries do not disturb it, and 20,000 sustained re-uses of one name under a live root leave every index at ≤ 2. It is a naming ambiguity with a stated one-way direction, not a corruption vector. Item 3 (*a `kind:'agent'` row with an incomplete ancestry is still recorded dead*) is not in this module at all — it is BUG-105's deliberate decision, lives in `agent-bridge.ts`, and belongs to that ticket. WHAT REMAINS TRUE BUT UNVERIFIABLE, STATED HERE RATHER THAN BURIED: **no clean room on this surface has ever had real-CLI access.** All eleven passes rest on SCRIPTED frames through the real server and the real bridge plus direct unit drives; the frame protocol has never been captured from a live CLI inside a verification. Consequently the REACHABILITY of several FIXED defects through the real frame protocol was never established — the 7th verdict's `tool_use` id reuse and the 10th verdict's duplicate `tool_result` are state-machine faults reachable only by a stream the engine is NOT KNOWN TO EMIT (0 of each in 114,799 real tool calls), and the 10th fix's case-(B) property-(a) half is not observable end to end AT ALL, pinned only at the unit level ((8b)). Those fixes are correct on the type's own terms; what is unproven is that the field could ever have triggered them. Also unverifiable from here: the transcript store used for check (15) is a PROXY for the wire, not the wire. `npm run gate` (leak + nul + typecheck) **PASS exit 0**, unpiped, status read directly. NOT MINE, baselined on the parent commit `e8e25da`: `verify-zombie-busy` **35/39 exit 1**, byte-identically the same four approval-card/stall checks on BOTH trees; `verify-reattach-agent-backfill` is genuinely flaky and fails on the pre-fix parent too — 14/15, 14/15, then a FATAL "sub-agents never started" on the fixed tree, against 15/15 then two identical FATALs on the parent. Historical status follows: the 10th clean-room verdict broke the one sentence this design exists to guarantee: an ancestry once established CHANGED. A REDUNDANT end signal for a name whose record was already settled flipped it back to `ended-unmatched`, and the fill branch in `issuedBySubagent` — entitled to write an ancestry only because an unmatched end has none — then REWROTE it, redirecting a LIVE child from one owner to an unrelated one (`{"from":["Z","R1"],"to":["Z","R3"]}`). Reconstructed and reproduced before any change (the verifier's clean rooms were externally deleted), which also found a SECOND corruption in the same class needing only ONE end signal: `issuedByMainThread(P); ended(P); issuedBySubagent(P,R)` gives the MAIN-THREAD lane `mainChain:["R"]` — property (a). FIXED 2026-08-19 as the CLASS rather than the case: a record is now IMMUTABLE (`parent`, `parentHandle`, `state` are `readonly`; a transition replaces the object, so a post-creation ancestry write is a COMPILE ERROR), `settled` is ABSORBING, and the one non-creation write is gated on `#resolved` — *has an issue frame claimed this handle* — a fact set at creation and never unset, which closes the main-thread half with the same gate. REACHABILITY ESTABLISHED END TO END, which the verdict could not do: new `redundantend` scenario, 36/37 exit 1 on `e8e25da` (`leafChild1:unknown` — live work under a LIVE root recorded dead) → 37/37 exit 0. AND CALIBRATED HONESTLY: 0 duplicate `tool_result` ids and 0 repeated `tool_use` ids across 113,963 real tool calls in 3,663 captured sessions, so this is a state-machine fault reachable by a stream the engine is not known to produce — the status id reuse had for six verdicts before one mattered. THE ENUMERATION GAP IS CLOSED IN THE DIRECTION IT WAS BLIND: the corpus now varies REPEATS — end signals in every subset, every event duplicated at every position after its original, 1,548,416 configurations, 35,786 violating on `e8e25da` and 0 with this fix, while the OLD 1,209,888-configuration product reports 0 violating on that same broken module. Two grader premises were corrected when end signals entered the corpus and both are recorded in the log; the corrected grader still finds the defect at scale. Every published growth figure is BYTE-IDENTICAL pre and post. All ARCH-003 guards, BUG-096 17/17, BUG-105 73/73, six further anti-regression suites and `npm run gate` green; `verify-zombie-busy` 35/39 is the pre-existing baseline. Awaiting a FRESH independent clean-room verify and a `:4317` restart before VERIFIED. Historical status follows: the 9th clean-room verdict broke property (b) through the case the 8th lane had labelled "guarded, not eliminated — only an ambiguity" (the fourth time on this ticket that such a label hid a corruption): the SAME name reserved TWICE, by two children, with a main-thread re-use between the reservations — reservations were held ONE PER NAME, so the second child bound to the main thread's generation, read as an ancestry ending at a dead bash, and was reclaimed while its real ancestor was live. FIXED 2026-08-19: the reservation queue IS a queue (the k-th description of a name fills the k-th reservation of it, and a new reservation is started only on the positive evidence that the name still OWES a description); a main-thread generation is never re-described in place nor displaced as what a name means as a LANE (`#mainGen` — that half printed `mainChain:["R2"]`, a main lane whose genuine death is suppressed); a re-issue ends BOTH meanings of the name; and the one-boundary grace belongs to the RECORD rather than to the name, so a child joining an already-waited-out reservation cannot inherit an expired grace. REACHABILITY ESTABLISHED END TO END, which the verdict could not do: new `tworeservations` scenario, 34/35 exit 1 on `a750ec1` → 35/35 exit 0. THE ENUMERATION GAP IS CLOSED: `adversarial-arch-003-reservation-corpus.mjs` enumerates 1,209,888 configurations (children x generations x description kinds x window assignments x boundary placements x depth) and grades PROPERTIES after every frame — 131,288 violating configurations on `a750ec1`, including a property-(a) class of 464,174 occurrences that nine rounds of hand-written fixtures never constructed, and 0 with this fix. Two items remain GUARDED, each named with what it can corrupt and pinned with a counted test (which call a LANE named P is after a re-use — one row, one-way toward an early death; and a description arriving more than one boundary late — 16,520 of the 1,209,888, counted by corpus check (6)). Every published growth figure is UNCHANGED. All ARCH-003 guards, BUG-096 17/17, BUG-105 40/40, five further anti-regression suites and `npm run gate` green, all re-run against the COMMITTED tree in a detached worktree; `verify-zombie-busy` 35/39 and `verify-reattach-agent-backfill` 14/15 are the pre-existing baselines. Awaiting a FRESH independent clean-room verify and a `:4317` restart before VERIFIED. Historical status follows: the 8th clean-room verdict broke BOTH non-negotiables in ONE sequence, through the window the 7th fix had called "an ambiguity, not a corruption": a child RESERVES its parent's name before the parent's own issue frame, the MAIN THREAD re-uses that name, a reclamation falls in between, and the delayed `P -> R` frame then lands on the wrong generation — the live child lost its live-root ancestry and was reclaimed (b), and the main-thread lane INHERITED `["R"]` where it must have an empty chain (a). FIXED 2026-08-18: a RESERVATION IS FIRST-CLASS FROM THE MOMENT IT IS REFERENCED — a re-issue PARKS the unfilled generation instead of orphaning it and the late frame FILLS THE RESERVATION without rebinding the name; an ancestry that walks into an unfilled reservation is reported UNKNOWN (`UNRESOLVED_ANCESTOR`) rather than ENDED, and `reap()` refuses to judge a record on an ancestry that is not yet known; and a name now means one thing as a LANE (property a) and another as an ISSUER (property b), because collapsing those two questions is what forced the trade. Must-FAIL reproduced the verdict line BYTE-IDENTICALLY (0/9 exit 1) and, for the first time, BOTH halves end to end through the real bridge in one run (28/31 exit 1: `(12b) {"leafChildDeaths":["leafChild"]}` and `(12a) {"mainReuse2":0}`) — from a required new fixture combining child-before-parent ordering, id reuse in that window and an intervening reclamation. Three items remain GUARDED and are each named with what they can corrupt and pinned by a test (which call a LANE named P is after a re-use; a `kind:'agent'` row with an unknown ancestry; a row spared inside the window keeping its held write). Every published growth figure is unchanged except two INDEX numbers that moved for a stated reason (a name's meaning survives one boundary of grace). All ARCH-003 guards, BUG-096 17/17, BUG-105 40/40, seven anti-regression suites and `npm run gate` green; `verify-zombie-busy` 35/39 and `verify-reattach-agent-backfill` 14/15 are pre-existing and identical on a baseline tree. Awaiting a FRESH independent clean-room verify and a `:4317` restart before VERIFIED. Historical status follows: the 7th clean-room verdict broke property (b) a second time, through ID REUSE: reusing an intermediate's tool_use id on the main thread deleted the record a still-running leaf's ancestry walked through, the chain truncated `["M","R"]`→`[]`, and the leaf was reclaimed and recorded dead under a live root. FIXED 2026-08-18 by removing the ROOT CAUSE COMMON TO ALL SEVEN rather than guarding a seventh consequence: ownership was keyed by an id the system does not mint and cannot guarantee unique, so `#calls` is now keyed by an INTERNAL HANDLE this type mints, each record's `parentHandle` is captured AT CREATION and never rewritten, and a re-issue mints a new generation instead of touching any record — `reap()` retains ancestors BY HANDLE, so a superseded generation survives exactly as long as a descendant needs it. CHAIN TRUNCATION AND CHAIN REDIRECTION ARE NOW UNREPRESENTABLE (no path rewrites a `parentHandle` after creation; none deletes a record a live descendant walks through), as is a main lane inheriting a subagent ancestry. GUARDED, not eliminated, and named: which generation a child binds to when its own issue frame precedes its parent's — an ambiguity, not a corruption. Must-FAIL reproduced the verdict line byte-identically (3/7 exit 1) AND end to end through the real bridge (24/27 exit 1, `(10b) {"leafChildDeaths":["leafChild"]}` with (10a)/(10c) green in the same run), answering the verdict's direct-unit-drive provenance caveat. RESIDENCY IS NOW OBSERVABLE (`OpenToolCalls.residency()` + an env-gated boundary publish), so BUG-105's reclamation-side instance is MEASURED — `resident:4 open:4` with both owners live → `resident:1 open:1` after the owner's terminal frame, the live worker's record untouched — instead of inferred. Every previously published growth figure is unchanged; new guards: 20,000-round id-reuse corruption check and the name index's own bound. All ARCH-003 guards, BUG-096 17/17, BUG-105 18/18, seven anti-regression suites and `npm run gate` green; `verify-zombie-busy` 35/39 is pre-existing (baselined on the parent commit) and `verify-reattach-agent-backfill` is flaky there too. Awaiting a FRESH independent clean-room verify and a `:4317` restart before VERIFIED. Historical status follows: the 6th clean-room verdict was the FIRST to break a CORRECTNESS property rather than the bound: live work reported dead. FIXED 2026-08-18: OWNERSHIP IS A CHAIN, and both the reclamation predicate and the sweep now read the WHOLE ancestry (`ownerChainOf`), `reap()` decides before it deletes and retains an ancestor while a descendant needs it, and the edge-triggered `ownerEnded()` — the second route the fabrication fired through — is DELETED, leaving exactly one removal rule for an OPEN record. Must-FAIL reproduced the verdict line byte-identically (`ownerAfterBoundary:null, fabricatedDeathAtSweep:true`, 3/7 exit 1) AND end to end through the real bridge and its own predicate (19/20 exit 1, `leafChildDeaths:["leafChild"]`) — so the verdict's provenance caveat is answered: this is a REACHABLE regression, not a modelling artefact. Property (a) is preserved by construction (a main-thread lane has an empty chain). The property-(c) "flat in time" claim was FALSE and is now stated truthfully instead of restated: for an owner that retires, 0@3d/0@9d under every ordering (600@3d/600@9d under the 5th verdict's); for an owner that NEVER retires the residual is one record per end>boundary>issue call (1,000/10,000 — the verifier's own numbers, now asserted), irreducible because such a record is indistinguishable from a call in flight. New guards: 126 nested-chain configurations, plus the carried-forward 92,160. All ARCH-003 guards, BUG-096 17/17, full anti-regression and `npm run gate` green. A SEPARATE, PRE-EXISTING instance of the same class was found and NOT fixed here (a still-running FOREGROUND subagent of a live background root is recorded dead — probed live: `allEnded=["fgSub:unknown",…]`); it needs its own lane. Awaiting a FRESH independent clean-room verify and a `:4317` restart before VERIFIED. Historical status follows: attempt 6's redesign SURVIVED the 4th clean-room pass on both correctness properties; the BROKEN verdict was an UNBOUNDED-GROWTH hole inside it (a `tool_result` arriving before its own assistant frame was discarded, so the entry became immortal). FIXED 2026-08-18: the open and end signals now ANNIHILATE in either order inside one entry of one map — no tombstone collection, `reap()` drops anything not OPEN. Must-FAIL reproduced the verdict line byte-identically (`resident:100000, bounded:false`) → now `resident:0`; the order-independence guard was one property short and now asserts reclamation as well as the ownership answer (630/720 permutations leaked on the old code, 0/720 now); the 3-day bound is 72 resident / peak 91 IDENTICALLY under assistant-first, result-first and mixed orderings. Both non-negotiables re-proved end to end. Awaiting a FRESH independent clean-room verify and a `:4317` restart before VERIFIED. Historical status follows: attempt 6 REDESIGNS the mechanism instead of guarding it again. The side map that produced all three clean-room BROKEN verdicts is DELETED: ownership is now resolved AT THE SWEEP from a mirror of the open tool calls (`src/server/open-tool-calls.ts`), nothing is stamped forward, nothing is consumed, nothing is evicted, and the design assumes NOTHING about frame ordering. Must-FAIL 7/12 on `53a6cff` → 12/12; growth bound proved with numbers (28,944 calls over 3 days → 72 resident entries). Awaiting a FRESH independent clean-room verify and a `:4317` restart before VERIFIED. Historical status follows: PREMISE OVERTURNED, per-row-owner fix BUILT; the clean-room BROKEN (owner-map lifetime) was FIXED + self-verified and then found BROKEN again (`CAP-b`). The parentage the four options worked around IS on the frames (`SDKAssistantMessage.parent_tool_use_id`, confirmed on real CLI 2.1.220 — see the explore + build log entries). **Option A (below, now redefined) is the fix**; the original A/B/C/D are obsolete as written. A cross-provider clean-room verdict of BROKEN on `0dcea36` (the `#toolUseOwner` collision / unbounded map) has been fixed — see the 2026-08-18 owner-lifetime log entry. Still awaiting a fresh independent clean-room verify (this is the door the last one came through) and a `:4317` restart before VERIFIED.
- **Raised from:** BUG-096
- **Reported:** 2026-08-14

## RESOLUTION (2026-08-18) — supersedes Decision 1 and Decision 2 below

The central premise — "the frames carry no parentage, so the sweep can only guess at
the instant it runs" — is **FALSE**, and it was the load-bearing assumption under every
option. An empirical pass (activity log, 2026-08-18 explore) and this build's own raw
frame capture confirm: a background agent's foreground child bash rides an assistant
frame carrying the owning agent's **`parent_tool_use_id`** (non-null), emitted BEFORE
that child's `task_started` (which echoes the same tool_use id). `null` on that field is
the main thread; non-null is a subagent. The bridge already parsed this field
(`#agentIdFor`) and threw it away.

**The fix (was "Option A — keep patching the predicate"; now redefined): stamp each
lane's OWNER from that frame and make the turn-end guard PER ROW.**
- `case 'assistant'` stores `block.id → #agentIdFor(parent_tool_use_id)` for every
  subagent-issued tool call; `task_started` looks up `m.tool_use_id` to stamp
  `LiveAgent.owner`; the sweep asks `#ownerIsLiveBackgroundAgent(a.owner)` instead of the
  global `#backgroundAgentLive()`.
- This kills BOTH directions at once: a main-thread orphan (`owner === null`) always
  records its honest death — closing the over-suppression hole that the global guard had
  (a real death swallowed whenever any background agent was live) — while a background
  worker's child is spared BY NAME, not by a blanket rule.
- Re-attach degrade (a missed `task_started` leaves `parent_tool_use_id` mapping to no
  known task id): the non-null owner still proves it is a subagent's child, so it is
  spared (`#ownerIsUntrackedSubagent`); the null/non-null distinction survives, which is
  what the sweep needs. It degrades, never throws or guesses.

**The old options are demoted:**
- **A (as originally written — "keep patching the predicate")**: obsolete. The frame
  parentage means the predicate no longer has to be guessed; the diff below is what
  "Option A" now means.
- **B (defer + timeout)**: demoted to a POSSIBLE FOLLOW-UP — belt-and-braces for a
  genuinely-late `tool_result`. It is no longer the only path off the guessing treadmill,
  and its cost was justified by an impossibility that does not hold.
- **C (never fabricate for tool rows)**: demoted to a POSSIBLE FOLLOW-UP — the per-row
  guard already achieves honest-by-omission for the ambiguous rows without blanket
  silence.
- **D (fix the harm, not the record)**: no longer needed as an interim shield; the record
  itself is now correct in both directions.

Everything from "Decision 1" down to "How we got here" is retained as the historical
record of the options as they stood BEFORE the premise was overturned. Read it as
context, not as the live choice.

## The situation

When one of our agents finishes its turn, some small jobs it started may still be running. Right at that
moment the system has to write down what happened to each one: is it still going because a helper is still
working, or did it get abandoned and quietly die? Nobody tells us — the system guesses from partial
information it has to hand.

The guess is wrong often enough to matter, in both directions. Sometimes it writes down that a job died when
the job actually finished fine a second later. Sometimes it writes down nothing when a job really was
abandoned.

## What this costs us

The record of what happened stops being trustworthy, and the agent in charge reads that record. When it is
told a finished step died, it either distrusts work that is already complete or dispatches it all over again —
wasted effort and a confused run. That has already happened once (BUG-037) and nearly happened again while
this was being investigated. The other direction is worse: when the record stays silent, a genuine failure
disappears with nobody noticing.

## Why no patch has held

The information the code needs — is the thing that started this job still alive? — simply is not reliably
available at the instant it has to decide. Every fix so far has tried to infer it from whatever partial
signals were to hand, and any fix that still decides at that instant inherits the same blind spot. That is why
this is being raised as a design question rather than filed as another patch. (The full record of what was
tried and how each was refuted is in "How we got here", below.)

## Decision 1 — fix it properly, or just stop the harm

The real choice is between fixing the cause and cheaply removing the harm:

- **B — decide later instead of on the spot.** Stop deciding at the end of the turn. Mark the job "not yet
  known" and wait for reality: if the job's result turns up — it did, about a second later, in every case we
  reproduced — write down what really happened; if nothing turns up within a time limit, write down that it
  died. This costs the most new code (a waiting step and a timeout). It is the only path that stops guessing:
  it uses what actually happened instead of what might have, and closes both directions of the error at once.
- **C — never record a death for these small jobs without proof.** Stay quiet unless we positively saw a
  failure. Very simple, and it never invents a failure that did not happen. The cost is that a job that
  genuinely was abandoned goes unrecorded — and, unlike D, C also hides the row from the human dashboard.
- **D — leave the record alone; just stop alarming the agent.** Keep writing what we write, but stop
  *briefing* these uncertain deaths to the agent in charge, since that briefing is what causes the actual
  damage. Smallest change that removes the real harm. The cost is that the stored record can still be
  inaccurate.

And the baseline, considered and not recommended:

- **A — keep tweaking the guess.** Carry on repairing the current approach, case by case. It has already
  failed three times, each time refuted by an independent check, and still depends on an internal detail of
  the engine we have never confirmed. It is the smallest change, but it decides at the same instant every
  failed attempt did, so it inherits the same tail.

**Recommendation: B, with D as the cheap shield until B lands.** They are complementary, not alternatives — B
fixes the cause, D removes the harm in the meantime.

Why C and D are not two names for one thing: two separate surfaces read this record — the agent's turn-start
briefing, and the human-facing dashboard (served straight from disk, no model involved). C suppresses the row
for both; D stops only the agent's briefing and leaves the row visible to the human. If you pick one of them
alone rather than the recommended pair, pick by whom you are protecting.

## Decision 2 — the interim posture (independent of the above)

Separately, and whichever fix wins: the version currently saved in the codebase is the one with the
silent-failure behaviour, the more dangerous of the two directions. Nothing is live until the service is
restarted, so no user is affected yet. You can leave it as-is, or roll back to the previous attempt, whose
mistake was louder and less dangerous. My suggestion is to leave it — a rollback adds churn ahead of a
decision that replaces both versions anyway.

## How we got here

Each rejection below came from an independent check, not from self-review.

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

That is six distinct ways to be wrong in three attempts, in opposite directions, with the third attempt
failing both ways at once.

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

### Options in engineering terms (A is the demoted baseline; B/C/D are the live choice)

**Option A — keep patching the predicate.** Prune `#backgroundTasks` on terminal frames, tag before the
`skip_transcript` early-return, and confirm the engine's `task_type` vocabulary.
*Cost:* smallest diff. *Risk:* the tail is demonstrably long (6 shapes in 3 attempts); the pre-level window
is a genuine race that pruning does not close; still depends on an unverified engine string.

**Option B — decide LATER, not at the sweep (recommended).** Stop deciding at turn end. Mark the row
*unresolved* and let ground truth settle it: if the `tool_result` arrives (it did, ~900ms later, in every
reproduced case), record the real outcome; if nothing arrives within a bounded window, record the death then.
*Cost:* introduces a deferred-resolution path and a timeout. *Benefit:* removes parentage inference entirely
— it uses what actually happened instead of guessing what might. Directly kills both failure directions.

**Option C — never fabricate for tool rows.** Settle `kind:'tool'` rows silently at turn end always; record a
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
3. Only then deploy (needs a `:4317` restart; the in-process bridge means nothing is live until then).

### Proof bar

**Right:** no fabricated death in ANY of the six shapes, AND a genuinely orphaned foreground bash still
records its honest death when no background parent exists — both directions, verified independently.
**Falsified by:** any single input where a successful step is recorded dead, or a failed step is not recorded.

## Activity log (APPEND-ONLY)

### 2026-08-14 — orchestrator
- Raised per §N after the third BROKEN verdict on BUG-096. Not filed as a fourth patch: three attempts each
  passed their author's own tests and were each refuted by a case the author never modelled, and attempt 3
  failed in both directions simultaneously. No build until a human picks an option.

### 2026-08-18 — editor
- Reader-facing sections rewritten for structure per FEAT-087/FEAT-088: thesis ("the liveness fact is not
  available at that instant") moved ahead of the decision; the four options split into two genuine decisions
  (the fix, and the interim posture); six flagged repetitions cut. The C-vs-D question was resolved with
  evidence — the outcomes ledger has TWO consumers (the orchestrator briefing via `takeBriefing()`, and the
  human dashboard rail via `GET /api/agent-outcomes`), so C and D are distinct. Technical section preserved
  verbatim as implementer reference. No facts dropped; no code change.

### 2026-08-18 — editor (placement pass, after independent review)

Review verdict: the previous rewrite hit every structural target but the reader still ran out of energy before
the answer. Diagnosed as a PLACEMENT problem, not a length problem — so this pass is additive/moves only, zero
facts cut. Four fixes: (1) the recommendation now appears in the Status line, so a two-minute reader gets the
answer in the first ten seconds; (2) Decision 1 no longer opens on option A — B/C/D lead, A follows as the
priced baseline and the word "dominated" is gone; (3) the two-consumers analysis (`takeBriefing()` vs the
human dashboard rail) is KEPT but moved below the recommendation, with a one-clause pointer inside option C;
(4) two rewrite artefacts cleaned — the appendix's `### Interim state — needs a call` deleted as a
near-verbatim duplicate of Decision 2, and the stale `(same four as above)` cross-reference re-worded to match
the new shape. Plus the independence of the three verdicts restored in "How we got here" (no repeated count).
Verified: token-diff of every backticked identifier, commit hash, run id, `.ts:line` ref and BUG-xxx id before
vs after is byte-identical including counts. Technical section otherwise verbatim. `board:gen`/`board:check`
pass; the INDEX row changed only because the Status line now carries the recommendation. The generalisable
ordering law and the lift-and-delete template rule were appended to FEAT-087.

### 2026-08-18 — you (answer · via ticket view)
- **Question:** fix it properly, or just stop the harm
- **Answer:** none of these seem like real fixes tbh, im not sure i fully believe its not detectable, wym, we run linux host, we have ability to track literary anything? plus claude code source codewas leaked and is not public property i think which can give insuights for anything relevant?
- **State:** answered — awaiting agent action (not dispatched)

### 2026-08-18 — explore dispatch (EMPIRICAL — builds nothing, read-only)

Dispatched to TEST the ticket's central claim ("the frames carry no parentage") rather than work under it.
Verdict: **the claim is half right and the actionable half is FALSE.** Parentage is not recoverable from the
OS — but it IS on a frame the bridge already receives, already parses, and already resolves to an agent id
eight lines above the place that needs it.

**1. OS-level parentage: genuinely impossible. Confirmed on this host, not asserted.**
Every tool bash is a direct child of the ONE engine process, so PPID is constant across all lanes
(`/proc/<bash>/stat` ppid = 3467669 = `…/claude-agent-sdk-linux-x64/claude`, for every lane in the session).
`/proc/PID/cgroup` is the per-SESSION systemd scope (`claude-station-host-h-…​.scope`) — session-granular, not
lane-granular; two bashes from different lanes sat in the identical scope. `/proc/PID/environ` carries
`CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID` but **no task/agent/tool id** — byte-identical between two
different lanes' bashes. sid/pgid are per-bash, not per-lane. A `run_in_background` bash is `setsid`-ed and
REPARENTS to `systemd --user` (observed live: pid 3574015, ppid 2132), destroying even the one-hop link.
The only OS-visible id is the lane's OWN task id, via an open fd to
`/tmp/claude-1000/<proj>/<sdkSession>/tasks/<task_id>.output` — self, never parent — and foreground bashes
have no such fd at all. So: no eBPF, fanotify, namespace or scope trick recovers it. That avenue is closed.

**2. The frames DO carry parentage. `SDKAssistantMessage.parent_tool_use_id`.**
`sdk.d.ts:2857` — every assistant frame carries `parent_tool_use_id: string | null`. `sdk.d.ts:1634`
(`forwardSubagentText` doc) states the DEFAULT behaviour explicitly: *"By default, only tool_use/tool_result
blocks from subagents are emitted"* — with `parent_tool_use_id` set. So the frame that CREATES a subagent's
Bash tool call already names its parent Task, on the default settings this project runs.
Non-null ⇒ issued by a subagent; null ⇒ main thread. That is exactly the distinction the sweep gets wrong.

This is not new capability — the codebase already depends on it: `session-host.mjs:239`
(`isSubagentFrame`, comment: *"Confirmed against real CLI 2.1.227"*), `events.ts:69` (*"tool_use_id of the
Task call, i.e. the `parent_tool_use_id` its inner messages carry"*), and `agent-bridge.ts:1977`
`#agentIdFor(parent_tool_use_id)` — called at **:2129 inside `case 'assistant'`, on the very block that is
the bash's `tool_use`**, and again at :2188/:2218. The bridge computes the owning agent id for that bash and
emits it on the `tool-call` event (:2174-2181) — and then never stores `block.id → agentId`. Sixty lines
later `task_started` (:2514) creates the `local_bash` row keyed by `m.tool_use_id` — the same id. The join
is one `Map.set` and one `Map.get` apart. Ordering is guaranteed by construction: a task cannot start for a
tool_use block the engine has not yet emitted, and both ride the same ordered stdout — unlike
`tool_progress`, which the ticket correctly rejected as a heartbeat with no ordering guarantee.

**3. Why the ticket concluded otherwise.** The BUG-096 probe (2026-08-14 log) checked only
`SDKTaskStartedMessage`/`SDKTaskProgressMessage` and concluded *"no `parent_task_id` linkage anywhere in
`src/server/`"*. Both halves are explainable:
- The task frames genuinely have no parent field. True, and irrelevant — the parent is on the *assistant*
  frame, not the task frame. The probe never looked at the frame that emits the tool call.
- **The `src/server/` grep was silently lying.** `src/server/agent-bridge.ts` contains one raw NUL byte at
  offset 135077 (inside a `/\x00/g` regex literal), so `file` reports it binary and Claude Code's Bash
  `grep` shim (`ugrep -I`) **skips the entire 2958-line file and prints nothing — exit 0, no warning**.
  Reproduce: `grep -c parent_tool_use_id src/server/agent-bridge.ts` → empty; `/usr/bin/grep -c` → `6`.
  Every prior investigation that grepped this file from Bash got a false negative on the largest and most
  load-bearing file in the tree. `rg` is unaffected. **This is a separate, high-value defect worth its own
  ticket** — it silently poisons investigation of exactly the file this bug class lives in.

**4. On-disk corroboration (independent of the frames).** The engine writes
`~/.claude/projects/<proj>/<sdkSession>/subagents/agent-<agentId>.jsonl`, every line stamped with `agentId`
(+ `attributionAgent`, `isSidechain`, `parentUuid`). Coverage test over all 28 background task ids in this
live session: **28/28 resolved to exactly one owning agent, 0 unresolved, 0 ambiguous.** Also 0 dangling
`tasks/a*.output` symlinks — every agent task in this session had a transcript. Two limits, measured: the
transcript line lands ~63 ms AFTER the tool starts (measured live by polling for a marker embedded in a
running tool_use), and foreground bashes get no `tasks/*.output` file. So disk is a good AUDIT/backfill
source and a poor real-time one — the frames are strictly better and strictly earlier.

**5. What this does to the four options.** A/B/C/D were all answers to "we cannot know the parent". We can.
The `#backgroundAgentLive()` predicate at :1823 is a global "is ANY background agent live" — it is only
global because parentage was believed unavailable; with `parent_tool_use_id` the same guard at :2337 becomes
per-row. B (defer + timeout) remains attractive as a belt-and-braces for the genuinely-late `tool_result`,
but it is no longer the ONLY path off the guessing treadmill, and its cost was justified by an impossibility
that does not hold.

**UNTESTED / honest limits.** (a) The assistant-before-`task_started` ordering is argued from construction
and from the SDK's own contract; it was NOT observed on a raw real-CLI frame capture, because this project
keeps none — every prior run drove a scripted fake CLI, which is the same gap the ticket already flags for
`task_type` vocabulary. One raw-stdout capture of a real dispatch would settle both at once and should be
step 1 of any build. (b) `skip_transcript` is never set by this repo, so that shape was reasoned about, not
reproduced. (c) The re-attach shape (bridge restarts mid-stream and misses `task_started`) leaves
`parent_tool_use_id` unmappable to a `task_id` — the level frame carries `task_id`/`task_type`/`description`
only and its own doc says *"the payload carries ids only, so do not correlate it with the edge stream"* —
but the non-null/null distinction survives it, which is the part the sweep needs. (d) No leaked source was
sought or read; nothing above required it.

### 2026-08-18 — build lane (Option A, redefined per the explore — BUILT + self-verified)

**Gating capture FIRST (the one assumption everything rested on).** Before writing any fix I captured raw
stdout from a REAL dispatch (real `claude` 2.1.220, real API), not the scripted fake every prior run used.
Two captures: a foreground subagent running a Bash, and a BACKGROUND subagent running a Bash (the incident
shape). The three-part hypothesis HELD on the real frames:
- **Non-null on the subagent's tool call:** the background agent's child Bash tool_use rode an assistant
  frame with `parent_tool_use_id = <the agent's Task-call tool_use id>` (non-null).
- **That frame PRECEDES `task_started`:** the assistant tool_use frame came before the child's
  `task_started` (`task_type: 'local_bash'`), which echoed the SAME tool_use id.
- **null distinguishes main-thread:** every main-thread frame was `parent_tool_use_id: null`; every
  subagent frame non-null.
- Extra real-frame finding: a FOREGROUND subagent's Bash gets NO separate `local_bash` task_started at all
  (only the agent's own task row) — so a `local_bash` task row for a subagent-issued bash only ever comes
  from a BACKGROUND agent. This anchors the re-attach degrade (spare a non-null-but-untracked owner).

**Changed** (`src/server/agent-bridge.ts`, `src/server/events.ts`):
- `LiveAgent.owner?: string | null` — the owning agent id (`#agentIdFor` of the issuing frame's
  `parent_tool_use_id`); null ⇒ main thread.
- New `#toolUseOwner` map: `case 'assistant'` stores `block.id → agentId` for every tool_use with a
  non-null parent; `task_started` consumes it to stamp `agent.owner`.
- Replaced the global `#backgroundAgentLive()` with per-owner `#ownerIsLiveBackgroundAgent(owner)` plus the
  re-attach degrade `#ownerIsUntrackedSubagent(owner)`; the sweep guard at the `result` boundary is now
  `a.kind === 'tool' && (ownerIsLiveBackgroundAgent(a.owner) || ownerIsUntrackedSubagent(a.owner))`.

**Verified — must-FAIL BOTH directions on the REAL bridge** (`scripts/verify-arch-003-per-row-owner-sweep.mjs`,
real server + real bridge + scripted fake CLI whose frames mirror the raw capture). On PRE-fix code (stashed
the two src files): (1) a genuine MAIN-THREAD orphan bash's honest death is SWALLOWED (`allEnded: []`) while a
background worker is live — the over-suppression bug; (4) a child bash of an UNTRACKED background agent
(re-attach) gets a FABRICATED `unknown` death — the fabrication bug. 3/5 on old code, exactly those two
FAIL. With the fix: 5/5 — the orphan records honestly, the worker's child and the untracked-subagent child
are both spared, the control orphan still records (degrade is not a blanket).
**Anti-regression:** the existing BUG-096 suite (17 checks) — its four background-child scenarios updated to
be real-frame-faithful (the linking assistant frame added, matching the capture) — passes 17/17. `npm run
gate` (leak + typecheck) exit 0, read directly (unpiped).

**Still open / handoff:** (a) arch class — an INDEPENDENT clean-room verify is warranted before VERIFIED
(this is a session-lifecycle / data-loss-adjacent, regression-prone fix that failed two prior clean-room
passes as A/B/C); generation must not be its own only judge. (b) Deploy needs a `:4317` restart (in-process
bridge). (c) A separate tooling hazard uncovered during the capture is filed as **BUG-103** (the Bash `grep`
shim silently skips `agent-bridge.ts` for a NUL byte — the false negative that sent BUG-096 down three failed
fixes); a convention was added to `docs/CONVENTIONS.md`.


---

### 2026-08-18 — INDEPENDENT CLEAN-ROOM VERIFICATION: **BROKEN**

- **Verified-by:** dispatch openai run 01a01515-943f-7253-93a2-72f8fa95076c (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

Cross-provider (openai/codex), clean room at `0dcea36`, evidence harness-side via `vrun.mjs`, manifest-backed
(4 recorded runs), contract VALID.

- **Fixer test re-run** (`node scripts/verify-arch-003-per-row-owner-sweep.mjs`, run `6abe8afbd181`): exit 0, 5/5.
- **Adversarial case `duplicate-tool-use-id-collision`** (run `f01456dbe76e`, exit 1, 4/5 — check (1) FAILS with
  `orphanDeaths: [], allEnded: []`): a main-thread `tool_use` that REUSES a still-pending subagent tool_use id
  inherits the stale owner, because `case 'assistant'` only ever *sets* `#toolUseOwner` for a non-null parent
  (`agent-bridge.ts:2210`) and NEVER clears the entry for a null-owner (main-thread) frame carrying the same
  block id. The sweep then suppresses the main task's genuine death — i.e. direction (a), the over-suppression
  hole that broke an earlier attempt, is reachable again.
- **Provenance:** BOTH cited runs used SCRIPTED model frames through the real server + real bridge. No real-CLI
  frames were exercised (no CLI/API access inside the clean room).
- **Not tested:** real model frames; rapid repeated turn-end sweeps; owner dying between the two paired frames;
  nested grandchildren — the verifier stopped after finding the collision defect.

### 2026-08-18 — owner-map LIFETIME fix (clean-room BROKEN → fixed + self-verified)

Fixing the clean-room BROKEN verdict above. The defect was an ownership record (`#toolUseOwner`,
block.id -> owning agent id) that was WRITTEN and never removed. Fixed the record's LIFETIME, not
the one collision the verifier demonstrated.

**Must-FAIL FIRST, on unmodified `0dcea36`.** New guard `scripts/verify-arch-003-owner-lifetime.mjs`,
scenario `collision`: a main-thread bash reuses a still-pending subagent tool_use id. On old code
check (1) FAILED — `mainbashDeaths: [], allEnded: []` — the main lane's genuine death SILENTLY
SWALLOWED, exactly the clean-room finding (direction a, over-suppression, through the id-reuse door).
Old-code run: 12/13 (only the collision fails; the other 12 scenarios already pass, confirming the
suite models real behaviour rather than a strawman).

**The fix (`src/server/agent-bridge.ts` only; `events.ts` already carried `LiveAgent.owner`).**
- **Balanced write** (`case 'assistant'`, the `:2210` site): a subagent frame SETs block.id -> owner;
  a main-thread (null-parent) frame now DELETEs any entry for that block.id. A reused id can no
  longer leave a stale subagent owner for the main lane's `task_started` to inherit. This closes the
  collision.
- **Consume-delete** (`task_started`): already present in `0dcea36` — the entry it stamps is deleted.
  Left as-is; verified it is the committed behaviour, not a phantom.
- **Hard cap** (`TOOL_USE_OWNER_CAP = 4096`, oldest-first eviction after each set): this is what
  bounds the map. Audit of paths that leave an entry behind:
  - *A tool_use with no `task_started` ever* — a FOREGROUND subagent's tool call (real-CLI finding:
    it gets no separate `local_bash` row). Its entry is never consumed; it is the leak source. The
    cap reaps it: a legit entry (a background child's) is consumed within its own frame burst so it
    sits at the NEWEST end; only never-consumed leak entries age to oldest. So an eviction can never
    drop a live-pending owner, and the map is bounded to ≤ cap for the life of the process.
  - *A turn that ends mid-stream* — deliberately NOT cleared on `result`. A background child's
    assistant frame can straddle a `result` and its `task_started` land in a later turn; clearing on
    `result` would drop the live-pending owner and re-fabricate the child's death. Proved by scenario
    `rapidsweep` (task_started arrives AFTER an intervening result; child still spared).
  - *A reattach* — a resume constructs a NEW AgentSession with a fresh Map, so nothing carries over;
    an in-session missed-`task_started` child is handled by the existing untracked-subagent degrade
    and its orphaned entry is reaped by the cap.

**Both non-negotiables proved, in every newly-covered scenario** (13/13 on the fixed code):
(a) a genuinely-dead MAIN-THREAD task is recorded dead and is NOT suppressed by any live background
agents; (b) a child of a STILL-RUNNING background agent is never recorded dead. Covered as real
assertions (not comments): the collision; rapid repeated sweeps with an entry straddling a result; an
owner dying between the child's two paired frames (sibling worker stays live); nested grandchildren
(owner is itself a subagent); a task that outlives its owner (retired owner's child records an honest
death — anti-over-suppression, NOT a main-lane suppression — while a live sibling worker's child stays
spared); several background agents alive at once with interleaved children (each spared by its OWN
owner, no cross-contamination).

**Runs (numbers as printed, with exit code):**
- `verify-arch-003-owner-lifetime.mjs`: OLD code 12/13 (collision FAILs), exit 1 → FIXED 13/13, exit 0.
- `verify-arch-003-per-row-owner-sweep.mjs`: 5/5, exit 0.
- `verify-bug-096-bg-child-lane-no-fabricated-death.mjs`: 17/17, exit 0.
- Anti-regression: `verify-bug-068` 5/5, `verify-agent-outcomes` 45/45, `verify-feat-064-drain-truth`
  18/18, `verify-bug-070-outcomes-rail` 22/22 — all exit 0.
- `npm run gate` (leak + typecheck): PASS, exit 0 (read directly, unpiped).

**HONEST REACHABILITY LIMIT.** The collision's suppression HARM is only reachable via tool_use id
REUSE, which the real CLI is not known to emit — I tried to reach the stale-owner suppression WITHOUT
reuse and could not: a stale entry is only ever falsely consumed by a `task_started` echoing the same
tool_use id, and without reuse ids are unique, so the entry just leaks (grows the map) without ever
mis-stamping an owner. So: the SUPPRESSION is a narrow, reuse-gated hole; the UNBOUNDED-MAP leak is
broad and reachable on every session that runs foreground subagent tool calls (i.e. all of them). Both
are fixed. `regressed-from: 0dcea36` (this same ticket's per-row-owner build introduced the
never-cleared write). All runs are SCRIPTED model frames through the real server + real bridge — no
real-CLI frames (same provenance limit every prior ARCH-003 run carried).

**Handoff.** This is a session-lifecycle / data-loss-adjacent, regression-prone fix that has now
produced a BROKEN clean-room verdict once at this exact surface — a FRESH independent clean-room verify
(a second fresh-context agent / `scripts/independent-verify.mjs`) is warranted before VERIFIED;
generation must not be its own only judge. Deploy still needs a `:4317` restart (in-process bridge).

---

### 2026-08-18 — INDEPENDENT CLEAN-ROOM VERIFICATION of `53a6cff`: **BROKEN**

- **Verified-by:** dispatch openai run 01a01527-1b92-7923-aebf-0b1ea6b43b2e (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

Cross-provider (openai/codex), clean room at `53a6cff`, evidence harness-side via `vrun.mjs`, manifest-backed, contract VALID.

- **Fixer test re-run** (`node scripts/verify-arch-003-owner-lifetime.mjs`, run `4408b96ee6c8`): exit 0, 13/13 — reproduced.
- **Adversarial case `pending-legitimate-owner-cap-eviction`** (`node scripts/adversarial-arch-003-cap-eviction.mjs`,
  run `19139f51a752`, exit 1, 14/15): with a live worker's LEGITIMATE child association still pending and oldest,
  4096 newer unconsumed associations trigger oldest-first eviction; the later `task_started` loses its owner and the
  turn-end sweep FABRICATES an `unknown` death for the live child — property (b) violated
  (`{"liveChildDeaths":["liveChild"]}`), while (a) still held in the same sweep. The cap's premise ("a legit entry is
  consumed within its own frame burst, so only leaks age to oldest") is not enforced anywhere; a legit entry whose
  consumption is delayed can be evicted while still needed.
- **Provenance:** BOTH cited runs used SCRIPTED model frames through the real server + real bridge. No real-CLI frames
  (no CLI/API access inside the clean room) — stated explicitly by the verifier.
- **Not tested:** real-CLI frames; consumption-before-association and duplicate-consumption orderings (the verifier
  stopped after establishing the cap-boundary defect).

### 2026-08-18 — EXPLORE (attempt 6): the failure class is the SIDE MAP, so remove the side map's job

Read every `Verified-by:` verdict first. The three BROKEN verdicts are not three bugs; they are one bug
seen three times, and the ticket's own §N rule applies: a symptom fixed three times means the design is
wrong. Naming it precisely:

> `#toolUseOwner` stores a DERIVED association (block.id -> owner) in ADVANCE of the moment it is needed,
> and its removal is governed by a POLICY (never / on-consume / oldest-first-eviction) rather than by the
> life of the thing it describes. Every failure is that policy being wrong in one more way.
> - never removed  -> the association OUTLIVED its subject (stale owner stamped on an unrelated task).
> - removed on consume -> the association was DISCARDED WHILE STILL NEEDED (a second consumer finds nothing).
> - evicted by size -> the association was DISCARDED WHILE STILL NEEDED (the `CAP-b` verdict, verbatim above).

Any sixth policy inherits the same shape. So: three candidates, judged on which of those two clauses each
one makes STRUCTURALLY IMPOSSIBLE rather than merely guarded.

**Candidate 1 — keep the map, fix the policy again (reclaim on the call's `tool_result`).**
Reclamation moves from an invented policy to the call's own end-of-life frame, so the leak (a foreground
subagent's tool call, which gets no `task_started` but DOES get a `tool_result`) disappears with no cap.
Eliminates: unbounded growth, eviction-while-needed. Does NOT eliminate: discarded-while-needed on the
consume path (`task_started` still deletes), nor a stale entry mis-stamped onto an unrelated lane, because
the association is still WRITTEN FORWARD onto `LiveAgent.owner` at a moment chosen for convenience rather
than need. Also acquires a NEW frame-ordering assumption (`tool_result` never precedes `task_started`) that
no capture has confirmed. Rejected: still a policy on a forward-written derivation.

**Candidate 2 — no stored association at all; re-derive from the durable recorder at sweep time.**
`#recorder.recordRuntimeMessage()` already persists every frame, so the sweep could scan back for the
assistant frame carrying this `tool_use` id and read its `parent_tool_use_id`. Zero resident state, zero
lifetime. Rejected on two grounds, both hard: the recorder is optional (`#recorder?`) so the sweep would
silently degrade to "no owner" = fabricated deaths for live children exactly when recording is off; and it
reads a file another process is actively writing, which is the truncated-read hazard this repo has already
been burned by. A correctness decision must not depend on a partial read.

**Candidate 3 (CHOSEN) — a mirror of the OPEN tool calls, resolved LAZILY at the sweep.**
Replace "a memo of associations, written forward, reclaimed by policy" with "a mirror of the subagent tool
calls that are currently OPEN". The distinction is not cosmetic — it changes both clauses:

- *Cannot outlive what it describes*: membership IS the tool call's liveness. An entry is opened by the
  frame that issues the call and removed only on POSITIVE EVIDENCE that that call is over — its
  `tool_result` arrived, or its id was re-issued (only possible once the earlier call ended), or its owning
  agent reached a terminal state (a dead owner has no open calls). There is no size rule, no age rule and
  no turn rule, so there is no boundary at which a live entry can be dropped. `CAP-b` is not fixed; it is
  unrepresentable.
- *Cannot be discarded while still needed*: NOTHING CONSUMES. The sweep does not read a value stamped onto
  the row earlier; it asks the registry, at the instant it needs the answer, `ownerOf(row.toolUseId)`.
  `LiveAgent.owner` is DELETED. A derived field that is written at one moment and trusted at another is
  precisely the artefact that carried the stale owner in attempt 2; with no field there is nothing to go
  stale, nothing to consume twice, and no consume-order to get wrong.

Two further properties fall out, and they are the reason this candidate wins rather than merely ties:

1. **It assumes NOTHING about frame ordering.** This is the honest constraint the dispatch asked about.
   Every prior attempt needed `assistant` to precede `task_started` (the one property the earlier real-CLI
   capture confirmed) because the owner had to be stamped AT `task_started`. Lazy resolution needs only
   that the entry be open AT THE SWEEP, which is a later moment than both frames — so the two paired frames
   may arrive in either order, repeatedly, across turn boundaries, and the answer is identical. The
   consumption-before-association case stops being a case. **No new capture is required, and the design does
   not inherit the existing capture's single-sample risk.**
2. **Every reclamation assumption fails SAFE — toward memory, never toward a wrong verdict.** If subagent
   `tool_result` frames were not emitted at all (the one SDK-documented behaviour this leans on), entries
   would simply stay open. An open entry can only ever SPARE a row whose `toolUseId` matches it, and it can
   only match a row the same subagent issued; an owner that is no longer a live background agent is not
   spared anyway. So the worst case of total reclamation failure is resident bytes, not a fabricated death
   and not a suppressed one. No prior attempt could say that: for the cap, reclamation failure WAS the
   `CAP-b` fabrication.

**Growth, without a cap.** Resident entries = subagent tool calls issued and not yet ended. That is the
engine's concurrency, not a function of elapsed time: it returns to the in-flight count every time calls
complete, and to zero every time the owning agents retire. The old design's leak driver — a foreground
subagent's tool call, which never produces the consuming `task_started` — is reclaimed by its `tool_result`
like any other call, so the class the 4096 cap existed to bound no longer accumulates at all. Numbers in the
build log.

**What this does NOT change** (deliberately, to keep the diff honest): the sweep's PREDICATE
(`#ownerIsLiveBackgroundAgent` / `#ownerIsUntrackedSubagent`) and the null/non-null meaning are kept
verbatim — they were never the thing that broke. Only WHERE the owner comes from, and WHEN, changes.

### 2026-08-18 — BUILD (attempt 6): the side map is gone; ownership is resolved at the sweep

Implements the CHOSEN candidate from the explore entry above. `regressed-from: 53a6cff` (and
`0dcea36` before it) — both prior fixes were policies on the structure this replaces.

**Changed.**
- **NEW `src/server/open-tool-calls.ts`** — `OpenToolCalls`, a mirror of the subagent-issued tool
  calls currently OPEN. `issuedBySubagent` / `issuedByMainThread` / `parentOf` (a pure READ) /
  `ended` / `ownerEnded` / `reap` / `size`. Removal requires positive evidence the call is over:
  its `tool_result`, its id being re-issued, or its owning agent going terminal. No size rule, no
  age rule, no turn rule for an OPEN entry. The lifetime is now a property of ONE named type with
  a stated invariant and a direct unit test, instead of an emergent behaviour of three distant
  call sites — which is why attempts 2-5 each fixed one site and left the class intact.
- **`src/server/agent-bridge.ts`** — `#toolUseOwner` and `TOOL_USE_OWNER_CAP` DELETED. The
  assistant frame opens/closes the call; `case 'user'` marks a call ended on its `tool_result`;
  the two terminal-agent frames call `ownerEnded`; the `result` handler `reap()`s AFTER the sweep.
  `task_started` no longer touches ownership at all. The sweep resolves it in place:
  `#agentIdFor(this.#openToolCalls.parentOf(a.toolUseId))`.
- **`src/server/events.ts`** — `LiveAgent.owner` DELETED (with a comment saying why the absence is
  deliberate). The stale-owner failures all needed a field written at one moment and trusted at
  another; there is no longer such a field.
- The sweep PREDICATE (`#ownerIsLiveBackgroundAgent` / `#ownerIsUntrackedSubagent`) is unchanged,
  verbatim. It was never what broke. Only where the owner comes from, and when.

**MUST-FAIL FIRST, on unmodified `53a6cff`, real output before a line was changed.** New guard
`scripts/verify-arch-003-open-tool-calls.mjs` — **7/12, exit 1**. Five genuine failures, including
a byte-equivalent reproduction of the clean-room's own verdict line:
```
FAIL  (1b) LIVE CHILD UNDER LOAD IS NOT KILLED …
      observed: {"liveChildDeaths":["liveChild"],"allEnded":["liveChild:unknown","mainOrphan:unknown"]}
FAIL  (2b) ORDER-INDEPENDENT OWNERSHIP …      observed: {"liveChildDeaths":["liveChild"], …}
FAIL  (3b) DOUBLE CONSUMPTION IS SAFE …       observed: {"liveChild":0,"liveChild2":1, …}
FAIL  (5b) ALL THREE LIVE CHILDREN SPARED …   observed: {"cb1":1,"cb2":1,"cb3":1, …}
FAIL  (6b) STRADDLING CALL SURVIVES A TURN BOUNDARY … observed: {"liveChildDeaths":["liveChild"], …}
```
Note `(1a)/(2a)/(3a)/(5a)/(6a)` PASSED on the old code: the must-FAIL isolates direction (b) with
direction (a) held green in the same sweep, so the fix cannot be a trade of one for the other.
After the change: **12/12, exit 0** — with both non-negotiables asserted in EVERY scenario.

**Runs, as printed, with exit codes.**
- `verify-arch-003-open-tool-calls.mjs` (new, integration): OLD **7/12 exit 1** → NEW **12/12 exit 0**.
- `verify-arch-003-growth-bound.mjs` (new, unit, on the real type): **10/10 exit 0**.
- `verify-arch-003-owner-lifetime.mjs`: **13/13 exit 0** (unchanged file — the prior attempt's whole
  suite still passes against the replacement design).
- `verify-arch-003-per-row-owner-sweep.mjs`: **5/5 exit 0** (includes the re-attach degrade).
- `verify-bug-096-bg-child-lane-no-fabricated-death.mjs`: **17/17 exit 0**.
- Anti-regression: `verify-bug-068-bash-background-visible` **5/5**, `verify-agent-outcomes` **45/45**,
  `verify-feat-064-drain-truth` **18/18**, `verify-bug-070-outcomes-rail` **22/22** — all exit 0.
- `npm run gate` (leak + typecheck): **PASS, exit 0**, read directly, unpiped.

**Coverage of the cases the dispatch named, and where each is asserted** (integration = the new
open-tool-calls suite unless stated): legitimate pending association under heavy load — `capload`
(4200 competing associations) + `multiload`; stale association on an unrelated task incl. id reuse —
`reuse` + growth-bound (6) + `owner-lifetime` collision; straddling a turn boundary / rapid repeated
sweeps while frames arrive — `straddle` (under load) + `owner-lifetime` rapidsweep; consumption
before the association — `startfirst` + growth-bound (5), all six frame orderings; the same task
consumed twice — `twice`; an owner that is itself owned — `owner-lifetime` grandchild; an owner
dying between the paired frames — `owner-lifetime` ownerdies; a task outliving its owner —
`owner-lifetime` outlives; several background agents alive with interleaved children — `multiload`
+ `owner-lifetime` multi; reattach where the start was never observed — `per-row-owner-sweep` (4).

**THE GROWTH BOUND, WITH NUMBERS** (guard 8/9, printed above, on the real type):
- realistic busy 3-day session — **28,944** subagent tool calls opened → **72 resident entries
  (~8 KB)**; peak within any turn **91 = one turn's 20 calls + the 72-entry abandoned tail**.
- absurd 3-day session, 50x that rate — **1,441,440** calls → **720 resident (~84 KB)**.
- The only term that grows with elapsed time is the ABANDONED tail (a call whose owner died without
  either the call reporting a result or the agent's terminal frame being seen), at ~1/hour here. In
  the replaced design **every one of those 28,944 calls** left an entry — the foreground subagent
  tool call gets no `task_started`, so nothing consumed it — which is why a 4096 cap was needed, and
  the cap's eviction boundary is what fabricated the death of a live child. There is no boundary now.

**ON THE HONEST CONSTRAINT (frame provenance) — the answer is: this design needs NO further capture.**
Every prior attempt stamped the owner AT `task_started`, so it depended on the assistant frame
arriving first — the one property the earlier real-CLI capture confirmed, from a single sample.
Resolving at the sweep removes that dependency: guard (5) asserts all SIX orderings of (assistant /
`task_started` / `tool_result`) give the same owner, and the integration `startfirst` scenario drives
the reversed order end to end through the real bridge. There is no frame-ordering property left for a
real capture to falsify. The one behavioural fact still leaned on is that subagent `tool_result`
blocks are emitted (SDK-documented, `forwardSubagentText`) — and guard (10) proves its failure mode is
RESIDENT BYTES, not a wrong verdict: with reclamation totally disabled, 20,000 entries stay resident,
no death is fabricated and none suppressed. Under the evicting design, reclamation failure WAS the
fabrication. That asymmetry is the strongest reason to prefer this design over another policy.

**Known boundary, stated rather than hidden.** If the SAME tool_use id were opened by a subagent and
by the main thread with both calls genuinely in flight at once, the later issuer wins. That is a
protocol violation (ids are per-call unique) and it was equally true of every prior design; the
`reuse` scenario pins the direction that matters — a main-thread re-issue always wins over a stale
subagent entry, so a genuine death can never be suppressed by it.

**Handoff.** Same as before and it still stands: session-lifecycle / data-loss-adjacent, three prior
clean-room BROKEN verdicts at this exact surface — a FRESH independent clean-room verify is warranted
before VERIFIED; generation must not be its own only judge. This one is a DESIGN replacement rather
than a guard, so the useful adversarial question for that pass is no longer "find the ordering that
drops an entry" but "find a removal that is not backed by evidence the call ended". Deploy still needs
a `:4317` restart (in-process bridge). All runs are SCRIPTED model frames through the real server +
real bridge (unchanged provenance limit) — see the paragraph above for why it binds less here.

---

### 2026-08-18 — attempt 6 clean-room independent verification (4th independent pass)

- **Verified-by:** dispatch openai run 01a0153b-00bf-7b21-999a-410883e595ea (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

Contract-VALID, manifest-backed, cross-provider (openai), 2 recorded runs.

**Fixer tests re-run:** `node scripts/verify-arch-003-open-tool-calls.mjs` — run `210dc854bfa1`, exit 0,
12/12 checks passed.

**Adversarial case `result-before-open-growth`** (run `5791a489bd74`, exit 1,
`node scripts/adversarial-arch-003-result-before-open-growth.mjs`, written by the verifier against the
real `OpenToolCalls` type):

```
{"ordering":"result>assistant>boundary","total":100000,"resident":100000,"bounded":false}
DEFECT: already-ended calls accumulate without bound when result precedes assistant
```

FINDING: `OpenToolCalls.ended()` DISCARDS a result whose id is not yet open (`if (this.#open.has(id))`).
A later `issuedBySubagent()` then opens a call that is ALREADY OVER, and no evidence of ending will ever
arrive again for it — `reap()` never removes it. 100,000 result-before-assistant calls leave 100,000
resident entries. This is squarely inside the ordering the design CLAIMS to support (the
order-independence claim above is what makes `tool_result` before `assistant` a supported ordering, not
a protocol violation), and it defeats the requirement's "must not grow without bound over a days-long
session". The direction is fail-safe (bytes, not a wrong verdict) — but "unbounded growth is
impossible" is falsified; it is merely slow under the orderings the author fixtured.

**Provenance:** SCRIPTED model frames for the fixer tests (real server + real bridge); the adversarial
run exercised the real `OpenToolCalls` type directly with a synthetic frame ordering. No REAL CLI frames
were obtainable in the clean room — stated as an expected limit, not papered over.

**Could not test:** real-CLI frame capture; end-to-end memory exhaustion (the deterministic resident
count was taken as sufficient).

### 2026-08-18 — FIX for the 4th verdict: the two signals ANNIHILATE, in either order

`regressed-from: 2427220` (this ticket's own attempt 6 — the redesign is sound and is KEPT; this
closes a hole inside it, not another policy on it).

**What was actually wrong, and why the hit was fair.** `ended()` was guarded by
`if (this.#open.has(toolUseId))`, so a `tool_result` arriving BEFORE its own assistant frame was
SILENTLY DISCARDED. `issuedBySubagent()` then opened an entry for a call that was already over, and
its only end signal had been thrown away — no further evidence could ever arrive, so `reap()` never
touched it. The design's headline claim is that it assumes NOTHING about frame ordering, which makes
`result > assistant` a SUPPORTED ordering rather than a protocol violation, so "unbounded growth is
impossible" was simply false; growth was merely slow under the orderings that had been fixtured.

**The choice, and what it makes UNREPRESENTABLE.** The obvious move — remember ids that ended early
so a later open can be suppressed — relocates the leak into a tombstone set that then needs its own
bound. Rejected. Instead the pair is now COMMUTATIVE: open and end annihilate whichever arrives
second, **in the same entry of the same map**. One collection remains in the whole type, and every
entry is in one of three states:

```
(no entry) --open--> OPEN --end--> SETTLED --open--> OPEN            (id re-issued)
(no entry) --end--> ENDED_UNMATCHED --open--> SETTLED
```

`reap()` drops everything that is not OPEN — and, importantly, it does **not consult a side list of
what ended**; it asks each entry its own state. That is the difference between guarded and
unrepresentable: the defect existed because the end signal lived in a place (`#endedThisTurn`) that
the open signal could erase. There is now no such place. `#endedThisTurn` is deleted.

**BOTH bounds, stated separately.** (i) OPEN entries = the calls actually in flight — unchanged from
attempt 6, reclaimed by `tool_result` / re-issue / owner-terminal, never by size, age or turn.
(ii) NON-OPEN entries (settled + unmatched ends) = the transient term, bounded by the tool_results in
ONE TURN and reclaimed by the `reap()` that already ran at every turn boundary. It is bounded by a
real quantity the engine produces, not by a policy this type invented, and it cannot survive a
boundary under ANY ordering — check (17) proves that over all 720 permutations rather than the six
someone thought of. Honest cost of (ii): a main-thread tool_result whose id is unknown now leaves one
transient entry until the boundary, where before it left none. Measured in check (13).

**MUST-FAIL FIRST, on unmodified `2427220`, before a line changed.**
- `scripts/adversarial-arch-003-result-before-open-growth.mjs` (reconstruction of the clean room's
  own case) — **exit 1**, byte-identical to the verdict:
  `{"ordering":"result>assistant>boundary","total":100000,"resident":100000,"bounded":false}`
- The STRENGTHENED `verify-arch-003-growth-bound.mjs` on the old code: **12/18, exit 1**, six genuine
  failures — `(5b)`, `(11)`, `(14)`, `(15)`, `(16)`, `(17)`. Note every one of them printed
  `wrongOwnerAnswers: 0`: on the defective build the OWNERSHIP ANSWER was right in every ordering and
  only RECLAMATION failed, so the new assertions isolate exactly the missing half.

**The guard that missed it, and the half it was missing.** The order-independence check asserted that
all six orderings give the same owner and stopped there. `(5b)` now asserts, for each of the same six,
that the entry is also RECLAIMED after the boundary — on the old code it printed
`["assistant>lane>result=0","assistant>result>lane=0","lane>assistant>result=0","lane>result>assistant=1","result>assistant>lane=1","result>lane>assistant=1"]`,
i.e. three of six orderings leaked. `(17)` generalises it: all 720 interleavings of three concurrent
calls' six signals, each graded on BOTH properties — **630/720 leaked on the old code, 0/720 now**.

**The cases the verifier stopped short of, all now asserted (numbers as printed, fixed code).**
- `(11)` result before assistant AT VOLUME: `{"total":100000,"resident":0,"wrongOwnerAnswers":0}`.
- `(12)` the same id ending twice, and ending then being re-issued: a doubly-ended call is reclaimed;
  a re-issued id is a NEW OPEN call that survives the boundary with its NEW owner; 50,000 rounds of
  end/end/open/end on ONE id leave 0.
- `(13)` an early result for a call that NEVER gets an assistant frame:
  `{"withinTurn":100000,"afterBoundary":0,"afterSecondRound":1,"liveStillResolves":"ownerW"}`.
- `(14)` five calls mid-flight with results out of order relative to their opens (two before their own
  opens): every call answers with its OWN owner, and the only survivor of the boundary is the one
  genuinely in flight. Old code: `survivorsAfterBoundary:["C","D","E"]`.

**THE GROWTH BOUND UNDER THE ADVERSARIAL ORDERING — the figure holds, identically.**
- assistant-first (the previous build's figure, reproduced): 28,944 calls / 3 days →
  `{"peakWithinATurn":91,"residentAtEnd":72,"bytesApprox":8640}`
- **result-first throughout**: `{"peakWithinATurn":91,"residentAtEnd":72,"bytesApprox":8640}`, 0 wrong
  owner answers. On the defective build this same simulation ended at **28,872 resident (~3.4 MB)**.
- **mixed per call**: `{"peakWithinATurn":91,"residentAtEnd":72}`. The bound is a function of the
  calls in flight, not of the ordering.

**BOTH NON-NEGOTIABLES, re-proved end to end through the real server + bridge.** New integration
scenario `resultfirst` (2 turns) in `verify-arch-003-open-tool-calls.mjs`: a live background worker
floods the stream with 4200 result-before-assistant calls while (a) one child is genuinely in flight
and (b) another child's early result arrives a whole TURN before its assistant frame.
- `(7b)` `{"liveChild":0,"straddleChild":0}` — no live worker's child recorded dead.
- `(7a)` `{"mainOrphan":1,"mainOrphan2":1}` — genuine main-thread deaths recorded in BOTH sweeps and
  suppressed by nothing.
This scenario PASSES on `2427220` too, and that is stated deliberately rather than dressed up as a
must-FAIL: the defect was residency, not verdict, so its value here is as an ANTI-REGRESSION proving
the bound was not bought with the correctness property — the failure mode that killed attempts 1-5.

**Runs, as printed, with exit codes.**
- `adversarial-arch-003-result-before-open-growth.mjs`: OLD **exit 1** (`resident:100000`) → NEW
  **exit 0** (`resident:0`).
- `verify-arch-003-growth-bound.mjs` (strengthened, +8 checks): OLD **12/18 exit 1** → NEW **18/18 exit 0**.
- `verify-arch-003-open-tool-calls.mjs` (+1 scenario, +2 checks): **14/14 exit 0**.
- `verify-arch-003-owner-lifetime.mjs`: **13/13 exit 0**. `verify-arch-003-per-row-owner-sweep.mjs`: **5/5 exit 0**.
- `verify-bug-096-bg-child-lane-no-fabricated-death.mjs`: **17/17 exit 0**.
- Anti-regression: `verify-bug-068-bash-background-visible` **5/5**, `verify-agent-outcomes` **45/45**,
  `verify-feat-064-drain-truth` **18/18**, `verify-bug-070-outcomes-rail` **22/22** — all exit 0.
- `npm run gate` (leak + typecheck): **PASS, exit 0**, read directly, unpiped.

**PROVENANCE, carried forward honestly.** Unchanged and still true: every run is SCRIPTED frames
through the real server and real bridge, plus unit runs against the real `OpenToolCalls` type. No
clean room has had real-CLI access. **This fix depends on no property of real frames** — it makes the
two signals commutative, so it is strictly WEAKER in its assumptions than the code it replaces (which
required the open to precede the end to reclaim at all). There is nothing here a real capture could
falsify; the transient term is bounded by the count of tool_results in a turn whatever their content
or order.

**Known boundary, restated because the change touches it.** If an id is re-issued for a genuinely NEW
call within the same turn as an unmatched end for that id, the two annihilate and the new call is
reaped at the boundary — after which a still-running child of a live worker could resolve to `null`.
This needs id reuse (ids are per-call unique, so a protocol violation) AND an out-of-order result AND
a turn boundary AND the reused call still running. The opposite choice — letting the open always win
— is what produced the unbounded leak, so this is the direction that is bounded; the reuse direction
that MATTERS (a main-thread re-issue must never inherit a subagent owner and suppress a real death)
is unchanged and still asserted by `(6)`, `(12)` and the integration `reuse` scenario.

**Handoff.** Session-lifecycle / data-loss-adjacent, four independent clean-room BROKEN verdicts at
this surface — **an independent clean-room verify pass is warranted before VERIFIED**; generation must
not be its own only judge. The useful adversarial question for that pass: the ownership answer and the
reclamation are now asserted together for every ordering, so look for a signal sequence in which a
NON-OPEN entry survives a `reap()`, or in which an OPEN entry is dropped by one. Deploy still needs a
`:4317` restart (in-process bridge).

### 5th independent clean-room verification (attempt 6, `35825c7`) — 2026-08-18

- **Verified-by:** dispatch openai run 01a0154b-31fd-7e22-be9b-9257c0dc8509 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

Cross-provider (openai), 7 harness-recorded runs, no compliance re-prompt. The diff shown to the
verifier was code+tests only (this ticket was excluded from the range, so no builder prose reached it).

- **FIXER-TEST** (manifest `09428ccecfc8`, exit 0): `node scripts/verify-arch-003-open-tool-calls.mjs`
  — 14/14. The growth-bound and adversarial-repro fixtures also re-ran clean.
- **ADVERSARIAL** `boundary-between-end-and-issue` (manifest `b11046df255e`, exit 1):
  `node adversarial-boundary-between-signals.mjs` →
  `{"owner":"still-running-owner","resident":1,"open":1}` /
  `DEFECT: a completed call became permanently open when reclamation ran between its end and issue signals`.
- **FINDING (verifier's words):** "If `ended(id)`, `reap()`, then `issuedBySubagent(id, liveOwner)`
  occur, the early-end record is discarded before annihilation; the later issue becomes OPEN and
  survives 10,000 reclamations, so ownership storage grows without bound under repeated calls of this
  ordering."
- **WHY-UNCOVERED:** the scripted server test sends a result before an issue across a turn boundary but
  checks only death outcomes, never whether that completed call remains RESIDENT afterwards. The 720-
  permutation guard permutes signals *within* one reclamation window; it never places a `reap()`
  *between* the two signals of the same call.
- **UNTESTED (verifier's words):** server-backed evidence used SCRIPTED fake `claude` frames via
  `CLAUDE_STATION_CLAUDE_BIN`; REAL CLI frames were unavailable in this environment, so no
  real-protocol capture was tested. (Consistent with every prior pass on this surface.)

**Reading of it.** This is the same failure mode as the 4th verdict, one boundary further out: the
annihilation is commutative only when both signals fall inside the same reclamation window. `reap()`
drops the `ended-unmatched` tombstone, so the window closes and the pair can no longer annihilate —
the late open then creates a permanently-OPEN entry for a call that is already over. Properties (a)
and (b) were NOT traded away this time (the fixer suite's non-negotiables all still pass); it is (c)
alone that fails. Not fixed here — this pass is verification only.

### 2026-08-18 — FIX for the 5th verdict: OPEN records get a reclamation path that needs NO end signal

`regressed-from: 35825c7` (this ticket's own 4th-verdict fix — annihilation is right and is KEPT;
this closes the boundary it could not reach). Lane: `src/server/open-tool-calls.ts`,
`src/server/agent-bridge.ts`, `verify-arch-003-*` / `adversarial-arch-003-*` only.

**I did not repair the sixth route, because the pattern is the defect.** All five leak verdicts are
one shape: *an OPEN record's only route to reclamation is a signal that may never arrive.* The
routes are its own `tool_result` (discarded when it preceded the issue — 4th verdict), its owner's
terminal frame (`ownerEnded`, an EDGE that a re-attach or a lost frame simply misses), and its id
being re-issued (ids are unique, so it never is). The 5th verdict spends all three at once:
`ended` > `reap` > `issued` leaves a record whose every end signal is already gone. A sixth repair
leaves a sixth-and-a-half hole.

**The choice, and why.** `reap()` now takes an evidence predicate and drops an OPEN record the
caller can positively state is not in flight any more. The bridge answers from two LEVEL-triggered
sources it already maintains: **the owner is no longer live** (not in the engine's background level,
not a pre-level born tag, and its `#agents` row is not `running`) or **the call's own lane has gone
terminal**. Weighed against the alternatives: a TTL or a size cap are invented policies and the cap
is precisely what produced the `CAP-b` fabrication; a tombstone set that remembers early ends just
relocates the unbounded structure (rejected for the same reason in the 4th-verdict fix); re-deriving
from the recorder is a partial read of a file another process is writing. Owner liveness is the only
candidate that is positively-observed state, is LEVEL-triggered (re-asked at every boundary, so it
does not care whether any frame was missed), and bounds every case where an end signal is absent —
including reasons nobody has thought of yet.

**Why it cannot cost property (b), stated as a property rather than a hope.** A record's ONLY effect
is to SPARE a still-running lane whose tool_use id it matches, and the sweep spares only when the
owner is a live background agent or is untracked. The predicate removes exactly the records whose
owner is neither, so it is VERDICT-NEUTRAL BY CONSTRUCTION — the bound is bought with nothing.
Three deliberate refusals encode that: an owner the bridge has never observed is NOT reclaimed
(absence of knowledge is not evidence of death — that is the re-attach degrade, and reclaiming it
would convert a spared child into a fabricated death); a background agent that merely dropped out of
one level frame while its row still runs is NOT reclaimed; and the reap still runs AFTER the sweep
has read what it needed.

**UNREPRESENTABLE vs GUARDED, plainly.**
- UNREPRESENTABLE: a record outliving its owner's liveness. No arrangement of missing, duplicated,
  reordered or discarded end signals can produce one, because the reclamation does not read any end
  signal. That subsumes all four previously-fixed routes and the unknown ones.
- UNREPRESENTABLE: an OPEN record of a LIVE owner being dropped (no size, age or turn rule exists),
  so `CAP-b` stays impossible.
- GUARDED, not eliminated: the ownership answer under id REUSE, unchanged from the previous build.
- **IS THERE ANY SEQUENCE THAT LEAVES A RECORD RESIDENT INDEFINITELY? YES, AND HERE IT IS.** A call
  issued out of order (`ended` > boundary > `issued`) whose owner NEVER stops being live, or whose
  owner is never observed at all (the re-attach degrade). While the owner is live that record is
  *indistinguishable from a call in flight* — keeping it IS property (b) — so no design that spares
  live children can reclaim it. Its size is one record per such call per owner-lifetime, measured in
  check (19): an immortal owner holds 10,000 records for 10,000 such calls and drops all 10,000 the
  instant it is no longer live. Residency is therefore a function of the LIVE OWNERS, not of elapsed
  time — check (20) proves that by running every ordering over 3 days and again over 9 days and
  requiring identical figures.

**MUST-FAIL FIRST, on unmodified `35825c7`, before a line was changed.**
- NEW `scripts/adversarial-arch-003-boundary-between-signals.mjs` (reconstruction of the clean
  room's case): **1/6, exit 1**, printing the verdict line byte-identically —
  `{"owner":"still-running-owner","resident":1,"open":1}`.
- The STRENGTHENED `verify-arch-003-growth-bound.mjs` on the old type: **18/21, exit 1**. The three
  new checks fail with numbers: `(18)` `leakedAfterOwnersRetired: 92160/92160`; `(20)` the 5th
  verdict's ordering **28,872 resident @3d → 86,616 @9d** (linear in elapsed time) against
  **600 @3d → 600 @9d** after the fix; `(19)` `afterOwnerRetired: 10000`. Checks (8)(9)(15)(16)(17)
  PASS on the old type — the new assertions isolate the missing half rather than restating a
  strawman.

**THE GUARD THAT MISSED IT, AND THE STRUCTURAL GAP CLOSED.** The 720-permutation check (17) permutes
signals WITHIN one reclamation window and only ever reaps AFTER the last signal, so it could not
express a `reap()` between two signals of the same call — which is why two verdicts in a row were
found in a region it could not see. New check **(18)** makes reclamation part of the permutation
space: all 720 orderings x all 128 placements of turn boundaries in the 7 gaps = **92,160
configurations**, each graded on three properties at once (reclamation once owners retire; the
genuinely in-flight call keeps its owner; no cross-contamination). **67,512 of the 92,160
configurations do resurrect a completed call** — the defect's true reachable surface inside the
guard's own space — and all 92,160 now reclaim: `{"configurations":92160,
"configurationsThatResurrectACompletedCall":67512,"leakedAfterOwnersRetired":0,
"liveCallLostItsOwner":0,"wrongOwnerAnswers":0}`.

**THE GROWTH BOUND, WITH NUMBERS, FLAT IN TIME** (check (20), realistic 3-day session, 28,944 calls,
then the same shape over 9 days, 86,832 calls):
- assistant-first `0@3d/0@9d`; result-first `0@3d/0@9d`; mixed `0@3d/0@9d`; absurd 50x (4.3M calls)
  `0@3d/0@9d`. The 72-entry abandoned tail of the previous build — the ONLY term that grew with
  elapsed time — is now zero, reclaimed by liveness with no terminal frame required.
- THE 5th VERDICT'S ORDERING applied to EVERY call: `600@3d/600@9d`, peak 600 in both. 600 is one
  live owner-generation's calls (30 turns x 20), not a function of the 86,832 calls issued.
- 0 wrong owner answers across all 5,974,000+ simulated calls.

**BOTH NON-NEGOTIABLES, RE-PROVED END TO END through the real server + real bridge.** New integration
scenario `boundarybetween` (3 turns) in `verify-arch-003-open-tool-calls.mjs`: 4,200 calls whose end
signal arrives a whole TURN before their issue frame, a live worker's child genuinely in flight
through it, and then the worker retiring by dropping out of the background level with NO terminal
frame ever emitted — the exact condition the new reclamation reads.
- `(8b)` `{"liveChildDeaths":[]}` — the live worker's child is not recorded dead.
- `(8a)` `{"mainOrphan":1,"mainOrphan2":1,"mainOrphan3":1}` — genuine main-thread deaths recorded in
  ALL THREE sweeps, including the sweep in which the owner retires.
- `(8c)` `{"orphanChildDeaths":["orphanChild"]}` — a child that outlives its owner still records its
  honest death; no stale record spares it.
Stated deliberately: residency itself is NOT assertable end to end and never was. A resident record's
only effect is to spare a lane whose owner is live, so a stale record of a live owner is externally
indistinguishable from a live call — which is exactly WHY the server suite could not see this leak
(the verifier's own WHY-UNCOVERED). The bound belongs on the type; the integration scenario's job is
to prove the bound cost neither non-negotiable.

**HONEST REACHABILITY ASSESSMENT (requested explicitly). Verdict: NOT reachable from real frames —
and fixed anyway.** The ordering needs a call's `tool_result` to precede its own `tool_use` frame AND
a turn boundary between them.
1. *Protocol.* A `tool_result` block references a `tool_use_id` minted by an EARLIER assistant
   message; the API rejects a tool_result with no preceding tool_use. The engine cannot mint the
   result first.
2. *Transport, checked rather than assumed.* Frames reach the registry through ONE ordered path:
   the CLI's stdout → the host relay (`session-host.mjs`, byte-order socket writes) → a single
   sequential `for await (const msg of this.#runtime.messages()) this.#handle(msg)`
   (`agent-bridge.ts:2100`) with a SYNCHRONOUS `#handle`. There is no queue-by-type, no dedupe, no
   replay and no re-emission in our code that could reorder the pair. `compact_boundary` summarises
   history for resume relinking; it does not re-emit assistant frames onto the live stream.
3. *The one door that is open, and why it does not lead here.* A bridge attaching MID-STREAM
   (resume/re-attach) can see a `tool_result` whose issuing frame it missed. That is an unmatched
   end — reaped at the boundary, and the issuing frame is in the PAST so it can never arrive. To
   resurrect the record the same tool_use id would have to be issued again, which is id reuse, a
   protocol violation.
4. *What would falsify this.* A real-CLI capture showing a `tool_result` before its own `tool_use`.
   None exists; no clean room on this ticket has ever had real-CLI access.
**This does not excuse skipping the fix, and it did not.** Unreachability arguments have been wrong
twice on this ticket, a state machine that leaks under a sequence its own contract calls SUPPORTED
should be fixed regardless, and — the real point — the fix is not scoped to this ordering at all: it
reclaims records whose end signal is missing FOR ANY REASON (check (3) of the adversarial script
withholds every end signal at once). **What the assessment is worth practically:** further adversarial
mining of synthetic signal orderings against this type has low expected value now, because reclamation
no longer depends on the orderings. The higher-value unexplored ground is the one thing five passes
have never touched — a REAL-CLI frame capture — and the bridge-side predicate's inputs
(`#backgroundTasks` / `#bgBornTasks` / `#agents` status transitions) rather than the registry's.

**Runs, as printed, with exit codes.**
- `adversarial-arch-003-boundary-between-signals.mjs` (NEW): OLD **1/6 exit 1** (verdict line
  reproduced byte-identically) → NEW **6/6 exit 0**.
- `verify-arch-003-growth-bound.mjs` (strengthened, +3 checks): OLD **18/21 exit 1** → NEW
  **21/21 exit 0**.
- `verify-arch-003-open-tool-calls.mjs` (+1 scenario, +3 checks): **17/17 exit 0**.
- `adversarial-arch-003-result-before-open-growth.mjs` (4th verdict's repro): **exit 0**,
  `{"ordering":"result>assistant>boundary","total":100000,"resident":0,"bounded":true}`.
- `verify-arch-003-owner-lifetime.mjs` **13/13 exit 0**; `verify-arch-003-per-row-owner-sweep.mjs`
  **5/5 exit 0**; `verify-bug-096-bg-child-lane-no-fabricated-death.mjs` **17/17 exit 0**.
- Anti-regression: `verify-bug-068-bash-background-visible` **5/5**, `verify-agent-outcomes`
  **45/45**, `verify-feat-064-drain-truth` **18/18**, `verify-bug-070-outcomes-rail` **22/22** — all
  exit 0.
- `npm run gate` (leak + typecheck): **PASS, exit 0**, read directly, unpiped.

**PROVENANCE, carried forward.** Every run is SCRIPTED frames through the real server and real
bridge, plus unit runs against the real `OpenToolCalls`. No real-CLI frames — unchanged limit on this
surface for six passes.

**Handoff.** Session-lifecycle / data-loss-adjacent, five independent clean-room BROKEN verdicts here
— **an independent clean-room verify is warranted before VERIFIED**; generation must not be its own
only judge. The useful adversarial question has MOVED: reclamation no longer depends on signal
ordering, so hunting a sixth ordering is low-yield. Aim instead at (i) the bridge-side predicate
`#callCannotStillBeInFlight` — can `#backgroundTasks` / `#bgBornTasks` / an `#agents` row go from
NOT-running back to running, so that a record is reclaimed and then needed again? — and (ii) whether
any lane can be swept while its owner's row is terminal in the SAME sweep in an order that changes
the verdict. Deploy still needs a `:4317` restart (in-process bridge).

**Addendum — I checked handoff question (i) myself rather than leaving it as an invitation.** Can an
owner go NOT-live and then live again, so that a reclaimed record is needed afterwards? It requires
the owner's `#agents` row to be terminal AND the owner absent from both the background level and the
born tags, and then the level to re-list it (REPLACE semantics say the level is "what is running
right now", so a retired task returning is already outside the engine's contract) or a `task_started`
to recreate the row under the same id. Two things bound the exposure. First, the pre-existing
`ownerEnded()` — in the tree since attempt 6 — ALREADY deletes every record of an owner the moment a
terminal frame arrives, i.e. the design has always treated a terminal owner as final; my predicate is
the LEVEL-triggered form of that same judgement and is strictly MORE conservative, because it also
requires absence from the level and from the born tags. So this is not a class the change introduces.
Second, at the boundary where the owner first reads as terminal the sweep has already, in that same
turn, refused to spare any of its existing lanes — so the only lane that could be affected is one
whose `task_started` lands AFTER the flap, in a later turn. Narrow, pre-existing, and named here
rather than discovered later; it is the sharpest question left for the clean-room pass.

### 6th independent clean-room verification (5th-verdict fix, `0ba4ce1`) — 2026-08-18

- **Verified-by:** dispatch openai run 01a01563-cd26-79a1-b9e4-d589ccafb49a (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

Cross-provider (openai), 3 harness-recorded runs, no compliance re-prompt. The diff shown to the
verifier was code+tests only (this ticket was excluded from the range, so no builder prose reached
it). The requirement stated all three properties (a)/(b)/(c) and pushed at the EVIDENCE PREDICATE
rather than at signal orderings.

- **FIXER-TEST** (manifest `574ec742f1c3`, exit 0): `node scripts/verify-arch-003-open-tool-calls.mjs`
  — 17/17, re-run clean in the clean room.
- **ADVERSARIAL (b)** `nested-terminal-owner-live-leaf` (manifest `e0ae65eb379c`, exit 1):
  `node scratch-nested-owner-terminal.mjs` →
  `{"rootStillRunning":true,"leafStillRunning":true,"intermediateTerminal":"completed","ownerAfterBoundary":null,"fabricatedDeathAtSweep":true}`
- **ADVERSARIAL (c)** `immortal-owner-duration-growth` (manifest `c699e7932cad`, exit 1):
  `node scratch-flat-bound.mjs` → `{"shortDurationResident":1000,"longDurationResident":10000,"flat":false}`
- **FINDING (verifier's words):** "Property (b) breaks in `AgentSession.#callCannotStillBeInFlight`:
  a terminal immediate-owner row causes an in-flight nested leaf's ownership record to be discarded,
  enabling a fabricated death." / "Property (c) breaks for a continuously live owner under
  end>boundary>issue ordering: completed-call records accumulate linearly with elapsed work and are
  not bounded."
- **UNTESTED (verifier's words):** "REAL model-CLI frames were unavailable; the supplied server
  harness used SCRIPTED frames through `CLAUDE_STATION_CLAUDE_BIN`." Both adversarial cases are
  DIRECT UNIT DRIVES of `OpenToolCalls` (the verifier supplied its own predicate callback modelling
  the bridge's), so they exercise the reclamation rule, not the bridge's own predicate code path.

### 2026-08-18 — FIX for the 6th verdict: ownership is a CHAIN, and the flat-growth claim was false

`regressed-from: 0ba4ce1` (this ticket's own 5th-verdict fix — the level-triggered
reclamation is right and is KEPT; it asked its question about the wrong thing). Lane:
`src/server/open-tool-calls.ts`, `src/server/agent-bridge.ts`, `verify-arch-003-*` /
`adversarial-arch-003-*` only.

**THIS ONE WAS DIFFERENT FROM THE FOUR BEFORE IT, and was treated that way.** Verdicts
2-5 were residency: bytes, never a wrong answer. Verdict 6's defect (b) is LIVE WORK
REPORTED DEAD — the failure BUG-037 is named after — introduced by the previous fix.

**DEFECT 1 (b) — the mechanism, and why the code's own claim was false.** OWNERSHIP IS
A CHAIN, NOT A PAIR. A background ROOT agent dispatches an INTERMEDIATE agent; the
intermediate issues a Bash whose lane is still running; the intermediate goes terminal
while the root keeps working. `#callCannotStillBeInFlight` asked only about the
IMMEDIATE owner, so the leaf's record satisfied it, was discarded, ownership then
resolved `null`, and the sweep fabricated the leaf's death. The comment claiming
"VERDICT-NEUTRALITY, as a property" was true of a one-level ownership and silent about
ancestry; it now states what is actually proved, and the surrounding code makes it so.

**THE CHOICE, AND WHAT IT MAKES UNREPRESENTABLE.**
- `OpenToolCalls.ownerChainOf(id)` walks the ancestry — possible with NO new structure,
  because a subagent's Task call is itself a tool call in the same map (the leaf's
  `parent` IS the key of its issuer's record). A `visited` set makes it total under id
  reuse.
- `reap()` hands the predicate the WHOLE CHAIN, and does it in THREE PHASES: decide over
  the map intact, retain the ancestors of everything kept, then delete. Phase 1 matters
  because a deletion taken mid-decision could truncate the next entry's chain and
  reclaim a live leaf on a chain the loop itself shortened; phase 2 matters because a
  chain is only walkable while the records it passes through are here — without it the
  verdict returns one boundary later.
- **`ownerEnded()` IS DELETED** (both call sites, `task_updated` and `task_notification`).
  It removed records by IMMEDIATE parent at a terminal FRAME, which is the second route
  by which this verdict is reachable — and the one the end-to-end must-FAIL actually
  fires through. Everything it bounded is bounded by the boundary predicate, which is
  strictly more conservative and now chain-aware. There is now exactly ONE removal rule
  for an OPEN record.
- The sweep uses the same chain (`#ownershipSpares`): a lane is spared if ANY ancestor is
  a live background agent or an owner never observed.
- **UNREPRESENTABLE:** a record dropped while anything in its ancestry could still be
  running (no rule reads a single level any more), and — carried forward — an OPEN record
  of a live owner dropped by size/age/turn (`CAP-b`). **GUARDED, not eliminated:** the
  ownership answer under id REUSE, unchanged.
- **Property (a) is preserved BY CONSTRUCTION, not by a second rule:** a main-thread lane
  has an EMPTY chain, so widening from "the owner" to "any ancestor" cannot reach it.
  There is no arrangement of live background agents that gives a main-thread orphan an
  ancestor to be spared by.

**DEFECT 2 (c) — the honest answer: the residual is irreducible, so the CLAIM changed
instead of the number.** Under `end > boundary > issue` with a CONTINUOUSLY LIVE owner,
each completed call becomes an OPEN record whose every end signal is already spent, and
while its owner is live that record is INDISTINGUISHABLE FROM A CALL IN FLIGHT — keeping
it IS property (b). No design that spares live children can reclaim it. The previous
build reported this as "flat in time"; that was false and the verifier was right.
Weighed and rejected: a TTL or size cap (an invented policy on OPEN records — exactly
what fabricated `CAP-b`); a tombstone set surviving the boundary (every main-thread
tool_result creates a tombstone, so it relocates the growth into a structure with a
WORSE bound); a two-generation tombstone (shrinks the window, does not close it, adds an
invented number). So the bound is now STATED, in the type's own doc and as an assertion:
*one record per such call while the owner never retires; zero the instant the owner
stops being live; identical at any two durations for an owner that does retire.* An
accurate claim about a small leak is worth more than a false claim about none.

**A COST OF THE (b) FIX, STATED RATHER THAN HIDDEN:** chain-awareness makes reclamation
STRICTLY LESS aggressive (a record whose immediate owner retired is kept while an
ancestor lives — because that is precisely when it is still needed), and deleting
`ownerEnded` moves terminal-owner reclamation from the frame to the next boundary. Both
are bounded and both are measured below; residency was bought back for correctness, in
the one direction that is allowed to cost bytes.

**MUST-FAIL FIRST, on unmodified `0ba4ce1`, before a line was changed.**
- NEW `scripts/adversarial-arch-003-nested-terminal-owner.mjs` — **3/7, exit 1**, printing
  the clean room's line BYTE-IDENTICALLY:
  `{"rootStillRunning":true,"leafStillRunning":true,"intermediateTerminal":"completed","ownerAfterBoundary":null,"fabricatedDeathAtSweep":true}`
  Checks (5)(6)(7) PASSED on the old code — property (a), a wholly-dead chain, and the
  untracked degrade — so the new assertions isolate the missing half rather than
  restating a strawman.
- NEW integration scenario `nested` (real server, real bridge, THE BRIDGE'S OWN
  PREDICATE): **19/20, exit 1**, `(9b) {"leafChildDeaths":["leafChild"]}` with
  `allEnded:["rootW:unknown","leafChild2:unknown","mainOrphan2:unknown","leafChild:unknown","mainOrphan:unknown"]`,
  while `(9a)` and `(9c)` PASSED in the same run.
- The strengthened `verify-arch-003-growth-bound.mjs` cannot be run on `0ba4ce1` at all:
  its new checks require `ownerChainOf` and a chain-shaped `reap` predicate, so the old
  type fails by TypeError rather than by assertion. Said plainly rather than dressed up
  as a 21/23 — the must-FAIL evidence for this verdict is the two runs above.

**THE PROVENANCE CAVEAT THE VERDICT RAISED — ANSWERED WITH EVIDENCE: THE BRIDGE REALLY
DOES FEED THE PREDICATE THAT WAY, AND THE DEFECT IS REACHABLE THROUGH IT.** Both
adversarial cases in the verdict were direct UNIT drives with the verifier's own
modelled predicate, so the question was fair. The `nested` scenario answers it: scripted
frames through the real server and real bridge, no callback of ours, and the real code
fabricates `leafChild:unknown`. It fires through BOTH bridge routes — `ownerEnded` at
the intermediate's `task_updated` terminal frame deletes the leaf's record outright, and
`#callCannotStillBeInFlight` would reclaim it at the boundary anyway. So this is a
reachable regression, not a modelling artefact.

**DOES NESTED OWNERSHIP ARISE IN THIS SYSTEM TODAY? YES — and here is the severity,
honestly split.** `.claude/agents/worker.md` sets no `tools:` restriction, so a
dispatched worker inherits the Agent/Task tool and can dispatch its own subagent; the
orchestrator's normal pattern is background workers, so root-is-a-background-agent is
the common case, not an exotic one. Two sub-cases:
- For the LEAF to be a `local_bash` lane at all, the real-CLI capture (build log above)
  says the intermediate must itself be a BACKGROUND agent — a foreground subagent's bash
  gets no task row. A worker dispatching a *background* sub-worker is possible here but
  is not the house style (workers are told "foreground Bash only"), so the exact leaf
  shape is REACHABLE BUT UNCOMMON.
- **A SEPARATE, MORE REACHABLE INSTANCE OF THE SAME CLASS, FOUND WHILE ANSWERING THIS
  AND NOT FIXED HERE.** A still-RUNNING FOREGROUND subagent of a live background root is
  itself recorded dead at the main thread's turn end: it is not on the engine's
  background level, so the sweep settles it, and the spare rule only ever applies to
  `kind:'tool'` rows. Probed live through the real bridge during this build:
  `allEnded=["fgSub:unknown","mainOrphan:unknown"]` — `fgSub` was still running under a
  live root. This is PRE-EXISTING (it predates the ARCH-003 work; it is not a regression
  from `0ba4ce1`) and fixing it means sparing `kind:'agent'` rows with a live-background
  ancestor, which changes the orchestrator briefing for a whole row class and touches the
  BUG-096 contract. It is named here with its evidence rather than bundled into a
  regression fix that a clean room has to judge; **it should be its own lane, and it is
  the sharpest live-work-reported-dead question left on this ticket.**

**THE GUARDS WERE STRENGTHENED WHERE THEY WERE BLIND.** The existing suite covered
nesting for the ownership ANSWER (`owner-lifetime` grandchild) but never for RECLAMATION
under a terminal intermediate, which is why two builds passed it.
- NEW **(22)** in the growth guard: chains 1-6 deep x every subset of intermediates
  retiring, with a reclamation after each — **126 configurations**, graded on three
  properties at once (the leaf still names its issuer and its chain still reaches the
  live root; nothing answers with another call's owner; once the ROOT retires too every
  record goes): `{"configurations":126,"leafOrphanedWhileRootLive":0,"leakedAfterRootRetired":0,"wrongOwnerAnswers":0}`.
  Asking only the immediate owner fails ALL of them at depth >= 2.
- NEW **(21)** pins the true growth bound (below).
- The 92,160-configuration reclamation-interleaved check (18) and the 720-permutation
  check (17) were carried forward onto the chain-shaped predicate and still print
  `{"configurationsThatResurrectACompletedCall":67512,"leakedAfterOwnersRetired":0,"liveCallLostItsOwner":0,"wrongOwnerAnswers":0}`.

**THE GROWTH BOUND, WITH NUMBERS AT TWO VERY DIFFERENT DURATIONS, STATED TRUTHFULLY.**
- (20), owners that RETIRE (i.e. every real agent), realistic 3-day = 28,944 calls vs
  9-day = 86,832 calls: assistant-first `0@3d/0@9d`; result-first `0@3d/0@9d`; mixed
  `0@3d/0@9d`; the 5th verdict's ordering applied to EVERY call `600@3d/600@9d` (600 =
  one live owner-generation's calls, 30 turns x 20); absurd 50x (4.3M calls)
  `0@3d/0@9d`. 0 wrong owner answers. **THAT is the flatness the design can claim.**
- (21), the 6th verdict's own case — an owner that NEVER retires, `end > boundary >
  issue`: `{"shortDurationResident":1000,"longDurationResident":10000,"flat":false}` —
  the verifier's line, reproduced and now ASSERTED as the truth, together with the two
  properties that bound it: `goesToZeroWhenTheOwnerRetires:[0,0]` and
  `retiringOwnerResidentShortVsLong:[0,0]`. Residency is a function of the LIVE
  OWNER-GENERATIONS; it is linear in the calls issued only for an immortal owner, and
  under the real protocol the ordering cannot arise at all (a `tool_result` names a
  `tool_use_id` minted by an EARLIER assistant frame).
- (8)/(9)/(15)/(16) are the no-liveness-evidence shapes kept for comparability; their
  abandoned tail is now **144 @3d** (was 72) because terminal-frame reclamation was
  deleted with `ownerEnded` — the measured cost of the (b) fix, ~17 KB.

**ALL THREE PROPERTIES, END TO END.**
- (a) `(9a)` `{"mainOrphan":1,"mainOrphan2":1}` with a two-level chain live, plus
  `(1a)(2a)(3a)(4a)(5a)(6a)(7a)(8a)` unchanged — no arrangement of live background
  agents suppresses a genuine main-thread death.
- (b) `(9b)` `{"leafChildDeaths":[]}` through the real bridge, plus 126 chain
  configurations and 92,160 reclamation-interleaved ones on the type.
- (c) numbers above; `(9c)` `{"leafChild2Deaths":["leafChild2"]}` proves the chain rule
  does not simply spare everything forever.

**Runs, as printed, with exit codes.**
- `adversarial-arch-003-nested-terminal-owner.mjs` (NEW): OLD **3/7 exit 1** (verdict line
  byte-identical) -> NEW **7/7 exit 0**.
- `verify-arch-003-open-tool-calls.mjs` (+1 scenario, +3 checks): OLD **19/20 exit 1** ->
  NEW **20/20 exit 0**.
- `verify-arch-003-growth-bound.mjs` (+2 checks, predicate re-shaped): **23/23 exit 0**.
- `adversarial-arch-003-boundary-between-signals.mjs` **6/6 exit 0**;
  `adversarial-arch-003-result-before-open-growth.mjs` **exit 0**
  (`{"resident":0,"bounded":true}`).
- `verify-arch-003-owner-lifetime.mjs` **13/13 exit 0**;
  `verify-arch-003-per-row-owner-sweep.mjs` **5/5 exit 0**.
- `verify-bug-096-bg-child-lane-no-fabricated-death.mjs` **17/17 exit 0**.
- Anti-regression: `verify-bug-068-bash-background-visible` **5/5**, `verify-agent-outcomes`
  **45/45**, `verify-feat-064-drain-truth` **18/18**, `verify-bug-070-outcomes-rail`
  **22/22** — all exit 0.
- `npm run gate` (leak + typecheck): **PASS, exit 0**, read directly, unpiped.

**PROVENANCE, carried forward.** Every run is SCRIPTED frames through the real server and
real bridge, plus unit runs against the real `OpenToolCalls`. No real-CLI frames — the
unchanged limit on this surface for seven passes. This fix depends on no property of
real frames; it removes a rule that read one level and replaces it with one that reads
the ancestry the frames themselves carry.

**Handoff.** Session-lifecycle / data-loss-adjacent, SIX independent clean-room BROKEN
verdicts here, and this one broke a VERDICT — **an independent clean-room verify is
warranted before VERIFIED**; generation must not be its own only judge. The useful
adversarial questions now: (i) the `kind:'agent'` hole named above (a still-running
foreground subagent of a live background root, probed and reproduced here); (ii) whether
any chain can be built whose ancestry is walkable but WRONG (id reuse of a Task call's
tool_use id is the only candidate, and it is the standing guarded case); (iii) the one
thing seven passes have never touched — a REAL-CLI frame capture. Deploy still needs a
`:4317` restart (in-process bridge).

- **Verified-by:** dispatch openai run 01a01599-b39a-7e33-b0a9-574d588b8635 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

### 7th independent clean-room verification (6th-verdict fix, `cb2ceb2`) — 2026-08-18

The verdict above, recorded with its evidence. Property (b) again — live work reported dead:

```
node scratch-id-reuse-truncation.mjs → exit 1
{"source":"DIRECT UNIT DRIVE","rootRunning":true,"leafRunning":true,
 "chainBeforeSweep":["M"],"chainAfterSweep":[],
 "leafRecordSurvived":false,"liveAncestorStillReachable":false}
```

Reusing an intermediate tool-use id `M` on the main thread deleted the `M→R` link; the
still-running leaf's ancestry truncated from `["M","R"]` to `[]`; the next reclamation saw
no live ancestor and removed the leaf's record; a live child under a still-running root
was settled as dead. A DIRECT UNIT DRIVE of `OpenToolCalls`, as the 6th verdict's two
cases were — the provenance question that raises is answered below with an end-to-end
scenario through the real bridge.

### 2026-08-18 — FIX for the 7th verdict: the system mints its own key, so a reused id cannot reach an existing chain

`regressed-from: 2427220` (this ticket's own attempt-6 redesign — records have been keyed
by the engine's tool_use id since that build; the six rounds since each guarded one
consequence of that). Lane: `src/server/open-tool-calls.ts`, `src/server/agent-bridge.ts`,
`verify-arch-003-*` / `adversarial-arch-003-*`, this ticket.

**I DID NOT GUARD A SEVENTH CONSEQUENCE, BECAUSE ALL SEVEN HAVE ONE ROOT CAUSE:
OWNERSHIP WAS KEYED BY AN ID THE SYSTEM DOES NOT MINT AND CANNOT GUARANTEE UNIQUE**, and
a chain was re-derived from that map at every walk. So ANY later write under an id that
some other record's ancestry passed through rewrote that other record's ancestry:
- `issuedByMainThread(M)` DELETED M's record → the leaf's chain TRUNCATED (the verdict);
- `issuedBySubagent(M, X)` REBOUND M's parent → the leaf's chain REDIRECTED onto an
  ancestry it never had. Same corruption, no deletion. Guarding only the delete would
  have been the seventh guard on one cause, and this second door is asserted at (2) of
  the new adversarial script — it fails on the old build too.

**THE CHOICE.** Of the three directions the dispatch offered — an internal key, capturing
ancestry at creation, or refusing deletion while descendants reference an entry — the
first two are the SAME fix once you need order-independence, and the third alone is not
enough (a redirect is not a deletion). So: `#calls` is keyed by an internal HANDLE this
type mints; each record's `parentHandle` is captured AT CREATION and never rewritten;
`#generation` maps an external tool_use id to the handle it CURRENTLY means. A re-issue
touches no record at all — it marks the old generation ended and points the name at a
fresh handle. `reap()` retains ancestors BY HANDLE, so a superseded generation survives
for exactly as long as a descendant walks through it. Ancestry-at-creation alone would
have broken order-independence (a child whose issue frame precedes its parent's has no
parent record to capture); minting the parent's handle on first reference keeps both.

**UNREPRESENTABLE vs GUARDED, plainly.**
- UNREPRESENTABLE: CHAIN TRUNCATION and CHAIN REDIRECTION. No code path writes a
  `parentHandle` after the record's creation, and none deletes a record a live descendant
  walks through. No sequence of re-issues, end signals or reclamations, at any depth, can
  change an established ancestry.
- UNREPRESENTABLE: a main lane inheriting a subagent ancestry (property (a) under id
  reuse). A main-thread issue rebinds the NAME to a record-less generation, so the lane
  resolves to an EMPTY chain — by construction, not by a second rule.
- CARRIED FORWARD, still unrepresentable: an OPEN record dropped by size/age/turn
  (`CAP-b`); a record dropped while anything in its ancestry could still be running.
- **GUARDED, NOT ELIMINATED, AND NAMED HERE RATHER THAN LEFT FOR THE NEXT VERIFIER:**
  WHICH GENERATION A CHILD BINDS TO WHEN ITS OWN ISSUE FRAME ARRIVES BEFORE ITS PARENT'S.
  The child binds to the name's current (still record-less) generation, and whichever
  issue frame fills that generation defines its ancestry. If the id were re-used in
  exactly that window the child would name the wrong call. That is an AMBIGUITY, not a
  corruption — no information exists at that moment that could distinguish the two — and
  no arrangement of it can truncate or redirect a chain that already exists.

**THE SECOND COLLECTION, DECLARED RATHER THAN SLIPPED IN.** The type's doc used to lean on
"there is exactly ONE collection". There are now two, and the new one is an INDEX, not a
store: it holds no ownership fact, only what a name means right now. Its reclamation is
derived, not a policy — a binding is dropped at a boundary exactly when its handle holds
no record and no surviving record points at it. Because a second structure with an
unmeasured lifetime IS this ticket's failure class, its bound is asserted like the
records' (check (24), below).

**MUST-FAIL FIRST, on unmodified `3cedfb9`, before a line was changed.**
- NEW `scripts/adversarial-arch-003-id-reuse-chain-truncation.mjs` — **3/7, exit 1**, with
  check (1) printing the verdict's line BYTE-IDENTICALLY:
  `{"source":"DIRECT UNIT DRIVE","rootRunning":true,"leafRunning":true,"chainBeforeSweep":["M"],"chainAfterSweep":[],"leafRecordSurvived":false,"liveAncestorStillReachable":false}`
  (2) failed with `{"chainAfterReuseBySubagent":["M","DEAD_OTHER"]}` (the redirect door),
  (3) with 9 of 10 depth-and-position configurations orphaning the leaf, (4) with all four
  reuse/boundary placements. Checks **(5)(6)(7) PASSED on the old code** — property (a),
  the wholly-dead-chain reclamation and the residency bound — so the must-FAIL isolates
  direction (b) with (a) and the bound held green in the same run. After: **7/7, exit 0**.
- NEW end-to-end scenario `idreuse` in `verify-arch-003-open-tool-calls.mjs`, run against
  the pre-fix type in an isolated worktree: **24/27, exit 1**, `(10b)`
  `{"leafChildDeaths":["leafChild"]}` with
  `allEnded:["rootW:unknown","leafChild2:unknown","mainOrphan2:unknown","leafChild:unknown","mainReuse:unknown","mainOrphan:unknown"]`,
  while `(10a)` `{"mainReuse":1,"mainOrphan":1,"mainOrphan2":1}` and `(10c)` PASSED in the
  same run. **This answers the verdict's provenance caveat** (it was a direct unit drive,
  as the 6th verdict's two cases were): the defect is reachable through the real server,
  the real bridge and its own predicate, with no callback of ours. After: **27/27, exit 0**.
- NEW check `(23)` in `verify-arch-003-growth-bound.mjs` on the old type: **23/25, exit 1**,
  `{"rounds":20000,"corruptedChains":20000}` — on the pre-fix build EVERY ONE of 20,000
  leaves lost its ancestry to a re-issue of its owner's id.

**RESIDENCY IS NOW MEASURED, NOT INFERRED — the other half of this dispatch.** BUG-105's
handoff said it plainly: "record residency is not observable over HTTP, so the growth-bound
guard exercises the predicate's logic given a liveness input, and it is that INPUT this fix
corrected". Two clean-room leak verdicts lived in exactly that blind spot, because a
resident record's only external effect is to spare a lane whose owner is live — externally
indistinguishable from a call in flight. The seam: `OpenToolCalls.residency()` plus an
env-gated publish at the boundary (`CLAUDE_STATION_ARCH003_RESIDENCY_LOG`). Deliberately a
file and not an API — no route, no event, no field a client could come to depend on, off
unless the variable names a path, and a write failure can never affect a turn. New
scenario `residency`, numbers as printed by the real bridge:
- sweep #1, both background workers live:
  `{"resident":4,"open":4,"bindings":6,"openIds":["wcall_0","wcall_1","wcall_2","vcall_0"]}`
- sweep #2, after W's TERMINAL FRAME (the liveness input BUG-105 corrected), V still live:
  `{"resident":1,"open":1,"bindings":2,"openIds":["vcall_0"]}` — every one of W's records
  gone with no tool_result, no re-issue and no lane ever supplied, and the live worker's
  record untouched at the same boundary.
All three residency checks require BOTH log lines to exist, so they cannot pass vacuously
on a build without the seam — they FAIL on the pre-fix run above, and that is why (11r-b)
is not a green tick on an empty file.

**THE NUMBERS THAT DID NOT MOVE, WHICH IS ITSELF THE CLAIM.** The new key is internal, so
`size` still counts real calls: every previously published figure in the growth guard is
unchanged — 144 resident @3d abandoned tail (peak 162) under assistant-first, result-first
and mixed; `600@3d/600@9d` under the 5th verdict's ordering; `{"shortDurationResident":1000,
"longDurationResident":10000,"flat":false}` for the immortal owner; 92,160
reclamation-interleaved configurations and 126 nested ones at 0 defects. Superseded
generations cost nothing beyond the boundary: check (23) `{"residentWhileRootLive":0,
"bindingsWhileRootLive":0}` after 20,000 re-issues of one id.

**Runs, as printed, with exit codes.**
- `adversarial-arch-003-id-reuse-chain-truncation.mjs` (NEW): OLD **3/7 exit 1** (verdict
  line byte-identical) → NEW **7/7 exit 0**.
- `verify-arch-003-open-tool-calls.mjs` (+2 scenarios, +7 checks): OLD **24/27 exit 1** →
  NEW **27/27 exit 0**.
- `verify-arch-003-growth-bound.mjs` (+2 checks): OLD **23/25 exit 1** → NEW **25/25 exit 0**.
- `adversarial-arch-003-nested-terminal-owner.mjs` **7/7 exit 0**;
  `adversarial-arch-003-boundary-between-signals.mjs` **6/6 exit 0**;
  `adversarial-arch-003-result-before-open-growth.mjs` **exit 0**
  (`{"resident":0,"bounded":true}`).
- `verify-arch-003-owner-lifetime.mjs` **13/13 exit 0**;
  `verify-arch-003-per-row-owner-sweep.mjs` **5/5 exit 0**.
- `verify-bug-096-bg-child-lane-no-fabricated-death.mjs` **17/17 exit 0**;
  `verify-bug-105-foreground-subagent-of-live-owner.mjs` **18/18 exit 0**.
- Anti-regression, all exit 0: `verify-running-snapshot` **47/47**, `verify-stall-detector`
  **33/33**, `verify-feat-064-drain-truth` **18/18**, `verify-agent-outcomes` **45/45**,
  `verify-liveness-conformance` **96/96**, `verify-bug-068-bash-background-visible` **5/5**,
  `verify-bug-070-outcomes-rail` **22/22**.
- NOT GREEN, AND NOT MINE — baselined BEFORE the change on the parent commit `3cedfb9`:
  `verify-zombie-busy` **35/39 exit 1**, the SAME four checks before and after (the
  blocked-on-user false-positive guard). `verify-reattach-agent-backfill` is FLAKY here: it
  passed **15/15** on `3cedfb9` at baseline and then FATALed ("sub-agents never started")
  both on my tree and on a clean worktree of `3cedfb9` itself — so the fatal is not
  attributable to this change, which touches no DOM and no `public/` file.
- `npm run gate` (leak + nul + typecheck): **PASS, exit 0**, run unpiped, exit status read
  directly.

**PROVENANCE, carried forward.** Every run is SCRIPTED frames through the real server and
real bridge, plus unit runs against the real `OpenToolCalls`. No real-CLI frames — the
unchanged limit on this surface for eight passes. This fix depends on no property of real
frames; it removes the assumption that the engine's ids are unique rather than adding one.

**REACHABILITY, STATED HONESTLY AND NOT USED AS AN EXCUSE.** The engine is not known to
emit a reused tool_use id: a result frame names an id minted by an earlier assistant
message, and there is one ordered path with no replay (the transport analysis in the
5th-verdict entry still stands). So this defect is a real state-machine fault reached by a
sequence that should not occur in practice. It was fixed anyway because "should not occur"
has been wrong twice on this ticket, and because a structure that CANNOT be corrupted is
cheaper to reason about than one defended by an argument about what the engine emits.

**Handoff.** Session-lifecycle / data-loss-adjacent, SEVEN independent clean-room BROKEN
verdicts here, and two of them broke a VERDICT rather than the bound — **an independent
clean-room verify is warranted before VERIFIED**; generation must not be its own only
judge. The useful adversarial questions now: (i) the binding ambiguity named above (a
child issued before its parent, with the id re-used in that window) — can it be reached
from anything but a protocol violation, and does any arrangement of it corrupt rather
than merely misname? (ii) the `kind:'agent'` instance BUG-105 fixed — is any row class
still settled without consulting its chain? (iii) the one thing eight passes have never
touched, a REAL-CLI frame capture. Deploy still needs a `:4317` restart (in-process bridge).

- **Verified-by:** dispatch openai run 01a0165e-1d9e-73d2-93e0-fc860342f105 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

### 8th independent clean-room verification (7th-verdict fix, `77e41f1`..`ba9039e`) — 2026-08-18

Clean room over a SYNTHETIC tree: the four fix commits with `docs/*` reverted to base, so no
ticket prose or verdict history reached the verifier. Fixer test re-run: `node
scripts/verify-arch-003-open-tool-calls.mjs` → exit 0, 27/27 (run `ef8fa19787a6`, real server +
real bridge + scripted fake CLI).

The guarded case was driven into a CORRUPTION — it is not merely an ambiguity. Adversarial case
`preparent-reuse-boundary`, a DIRECT UNIT DRIVE of `OpenToolCalls`:

```
node scratch-verifier-reuse-window.mjs → exit 1 (run 77a3dd7d4361)
{"provenance":"DIRECT UNIT DRIVE","before":[],"after":[],
 "survived":false,"mainChain":["R"],"resident":1,"bindings":2}
```

Sequence: child L reserves parent name P BEFORE P's own issue frame; the MAIN THREAD then reuses
P; reclamation runs at a boundary; only then does the delayed `P → R` issue arrive. L loses its
live-root ancestry and is reclaimed (property (b)), and the main-thread P lookup INHERITS R's
ancestry — `mainChain:["R"]` where a main-thread lane must have an empty chain (property (a)).
Both non-negotiables break in one sequence.

Could not test: a REAL agent-CLI frame capture (never available in any clean room on this
surface — eight passes now); and a parent-revision baseline, because the clean room is a `git
archive` export with no usable `.git` (run `8f569c9e55ca`, exit 128).

### 2026-08-18 — FIX for the 8th verdict: a RESERVATION is a record from the moment it is referenced, and an ancestry nobody has named is UNKNOWN, not ENDED

`regressed-from: 77e41f1..ba9039e` (this ticket's own 7th-verdict fix). That entry named
this exact window and called it "an AMBIGUITY, not a corruption ... no arrangement of it
can truncate or redirect a chain that already exists", and left it guarded. **It is a
corruption, it broke BOTH non-negotiables in one sequence, and this is the second time on
this ticket that a lane's own "merely guarded" assessment turned out to be the next
defect.** Lane: `src/server/open-tool-calls.ts`, the `verify-arch-003-*` /
`adversarial-arch-003-*` scripts, this ticket. `agent-bridge.ts` NOT touched (another lane
was live in it) — everything below is achieved inside the type.

**RECONSTRUCTED FIRST, BEFORE ANYTHING WAS CHANGED.** The verifier's scratch was not
preserved, so it was rebuilt from the dispatch's sequence and run against unmodified
`ba9039e`. It printed the verdict's line BYTE-IDENTICALLY, exit 1:
`{"provenance":"DIRECT UNIT DRIVE","before":[],"after":[],"survived":false,"mainChain":["R"],"resident":1,"bindings":2}`
That reconstruction is now check (1) of the new committed guard.

**THE ROOT, AND WHY HANDLES DID NOT COVER IT.** Handles and creation-time capture protect
records THAT ALREADY EXIST. A name can be RESERVED for a record that does not exist yet —
the child captured `#handleFor("P")` before anything had issued P — and A RESERVATION WAS
NOT A RECORD, so nothing protected it: the main thread's re-issue repointed the name and
ORPHANED the reservation, the delayed `P → R` frame filled the NEW generation (which the
main lane's name resolves to, hence `mainChain:["R"]`), and the reservation the live child
was still holding could never be filled by anything. A second, symmetric half showed up
only end to end: **one id names two calls, and "what is this LANE?" and "who ISSUED this
child?" are different questions** — collapsing them into one map forces a choice between
the two properties.

**THE FIX, IN FOUR RULES.**
1. A RESERVATION IS FIRST-CLASS FROM THE MOMENT IT IS REFERENCED. `#resolved` records which
   handles an ISSUE FRAME has claimed; a handle minted by a parent reference is reserved,
   not resolved.
2. A RE-ISSUE CANNOT TAKE A RESERVATION. `#supersede` PARKS the unfilled generation
   (`#pending`) and the name starts meaning a fresh one; the next issue frame for that name
   FILLS THE PARKED RESERVATION instead of the current generation, and filling it never
   rebinds the name. So a child's ancestry no longer depends on WHEN its parent's frame
   arrives, and the main lane's generation stays record-less (property (a) by construction).
3. AN ANCESTRY THAT WALKS INTO AN UNFILLED RESERVATION IS INCOMPLETE, AND SAYS SO.
   `ownerChainOf` appends `UNRESOLVED_ANCESTOR` (which every consumer already handles as
   "an owner we have never observed"), and `reap()` refuses to judge such a record on its
   ancestry — it asks the predicate with NO chain, so only the caller's own-state evidence
   (the lane went terminal) can reclaim it. Reclaiming on a chain that is not yet fully
   known was the verdict's property-(b) half.
4. A NAME MEANS ONE THING AS A LANE AND ANOTHER AS AN ISSUER. `#generation` answers
   "what is the call this LANE is" (property (a): after a main-thread re-use, an EMPTY
   chain); `#issuer` answers "which call issued this child" (property (b): the most
   recently ISSUED generation, which is the one with a real ancestry). They differ only
   inside a re-use window — and that is exactly where collapsing them forced the trade.

**UNREPRESENTABLE vs GUARDED, plainly, with what the guarded ones can corrupt.**
- UNREPRESENTABLE: A LIVE DESCENDANT LOSING ITS ANCESTRY BECAUSE ITS PARENT'S NAME WAS
  RE-USED BEFORE THE PARENT'S ISSUE FRAME ARRIVED. The reservation cannot be taken, and the
  late frame fills it — at any depth, with the re-use before or after any number of
  boundaries (36 configurations, check (5)).
- UNREPRESENTABLE: RECLAMATION ON AN ANCESTRY THAT IS NOT YET KNOWN.
- UNREPRESENTABLE, carried forward: chain truncation/redirection; a main lane inheriting a
  subagent ancestry; `CAP-b`; dropping a record while anything in its chain could be running.
- GUARDED, NOT ELIMINATED — (i) **which call a LANE named `P` is** after a re-use in the
  window. It resolves to the MAIN-THREAD generation. If that lane is really the earlier
  subagent call, ITS death is recorded although its owner is live: ONE ROW, the re-used id
  itself, never a descendant. The trade is one-directional on purpose — a wrong answer
  toward (a) records a death that may be early, a wrong answer toward (b) suppresses a real
  death forever. Pinned: (7) of the new script.
- GUARDED, NOT ELIMINATED — (ii) **a `kind:'agent'` row whose ancestry is unknown is still
  recorded dead.** `UNRESOLVED_ANCESTOR` spares a `kind:'tool'` lane through the bridge's
  re-attach degrade, but BUG-105 deliberately declines that degrade for agent rows, and
  that decision lives in `agent-bridge.ts` — outside this lane. Pinned: (8).
- GUARDED, NOT ELIMINATED — (iii) **a row spared INSIDE the window keeps its held write.**
  The row settles at that boundary (BUG-030), so a spare is permanent FOR THAT ROW — the
  same honest-by-omission the un-observed-owner degrade already accepts. The one-boundary
  ageing (`#aged`) bounds the RECORD and every subsequent row, not that write. Pinned: (6)
  of the new script and (12d) end to end.
- BOUNDED, MEASURED: an "unknown" ancestry lasts ONE boundary. A reservation still unfilled
  at its second boundary is read as ending at that name — deferral, never amnesty, because
  an unbounded spare is the over-suppression that killed attempts 1-3.

**MUST-FAIL FIRST, on unmodified `ba9039e` (a copy of the tree with only this file at HEAD).**
- NEW `scripts/adversarial-arch-003-reservation-window.mjs`: **0/9, exit 1**, check (1)
  printing the verdict line byte-identically (above); (2) printing the property-(a) half,
  `{"leafChain":[],"mainChain":["R"],"leafSpared":false,"mainSpared":true,"leafRecordSurvived":false}`.
  After: **9/9, exit 0**.
- NEW end-to-end scenario `reservation` in `verify-arch-003-open-tool-calls.mjs` — the
  combination no prior fixture had, and the one the dispatch required: CHILD-BEFORE-PARENT
  ordering, IDENTIFIER REUSE in that window, and an INTERVENING RECLAMATION, through the
  real server, the real bridge and its own predicate. OLD **28/31, exit 1** with BOTH halves
  in one run — `(12b) {"leafChildDeaths":["leafChild"]}` (live work under a live root
  recorded dead) and `(12a) {"mainReuse":1,"mainReuse2":0,…}` (the lane whose task_started
  lands after the delayed frame had its genuine death SUPPRESSED by the live root's
  inherited ancestry) — while (12c) passed in the same run. After: **31/31, exit 0**.

**THE FIXTURE CORRECTION, DECLARED RATHER THAN SLIPPED IN.** Rule (3) made three unit
fixtures fail, and they were right to: they named `ownerW`/`R` as a parent WITHOUT EVER
ISSUING IT, which is now (correctly) an ancestry nobody has named. The real stream always
contains the root's own main-thread Task frame before any child names it, so those scripts
now play it (`class OpenToolCalls extends RealOpenToolCalls` at the top of each, documented
there). Nothing else changed, and every published figure below is measured under that
correction — which is why it was done this way rather than by relaxing the rule.

**THE NUMBERS THAT DID NOT MOVE.** `verify-arch-003-growth-bound.mjs` **25/25 exit 0** with
every previously published figure identical: 144 resident @3d abandoned tail (peak 162)
under assistant-first, result-first AND mixed; `600@3d/600@9d` under the 5th verdict's
ordering; `{"shortDurationResident":1000,"longDurationResident":10000,"flat":false}`;
92,160 reclamation-interleaved configurations and 126 nested ones at 0 defects; the name
index 0/0 over 3- and 9-day sessions. **THE TWO THAT DID MOVE, AND WHY:** check (23)
`bindingsWhileRootLive` 0 → **2**, and the `residency` scenario's `bindings` 6 → 8 and
2 → 3 — a name whose call could STILL BE SPEAKING keeps its meaning for one boundary after
nothing points at it (rule 3's ageing), so a call issued by a record reclaimed at this
boundary finds "this name was issued" rather than "unknown". It is a CONSTANT, not a term:
the 20,000 superseded generations and 20,000 ENDED leaves get no grace and go at once, and
both remaining bindings are gone one boundary later (asserted in (23)). `resident`, `open`
and `openIds` at both residency boundaries are UNCHANGED (`resident:4 open:4` → `resident:1
open:1`, W's records gone, V's untouched).

**Runs, as printed, with exit codes.**
- `adversarial-arch-003-reservation-window.mjs` (NEW): OLD **0/9 exit 1** → NEW **9/9 exit 0**.
- `verify-arch-003-open-tool-calls.mjs` (+1 scenario, +4 checks): OLD **28/31 exit 1** →
  NEW **31/31 exit 0**.
- `verify-arch-003-growth-bound.mjs` **25/25 exit 0**;
  `adversarial-arch-003-id-reuse-chain-truncation.mjs` **7/7 exit 0**;
  `adversarial-arch-003-nested-terminal-owner.mjs` **7/7 exit 0**;
  `adversarial-arch-003-boundary-between-signals.mjs` **6/6 exit 0**;
  `adversarial-arch-003-result-before-open-growth.mjs` **exit 0** (`{"resident":0,"bounded":true}`);
  `verify-arch-003-owner-lifetime.mjs` **13/13 exit 0**;
  `verify-arch-003-per-row-owner-sweep.mjs` **5/5 exit 0**.
- `verify-bug-096-bg-child-lane-no-fabricated-death.mjs` **17/17 exit 0**;
  `verify-bug-105-foreground-subagent-of-live-owner.mjs` **40/40 exit 0** (its first run
  FATALed on a resume with no transcript after re-adopting 8 session hosts left by other
  lanes in this shared environment; clean on re-run).
- Anti-regression, all exit 0: `verify-running-snapshot` **47/47**, `verify-stall-detector`
  **33/33**, `verify-feat-064-drain-truth` **18/18**, `verify-agent-outcomes` **45/45**,
  `verify-liveness-conformance` **96/96**, `verify-bug-068-bash-background-visible` **5/5**,
  `verify-bug-070-outcomes-rail` **22/22**.
- NOT GREEN, NOT MINE — baselined by running the SAME suites against a tree identical to
  mine except `open-tool-calls.ts` at `ba9039e`: `verify-zombie-busy` **35/39 exit 1** on
  both, the SAME four checks (`diff` of the FAIL lines is empty);
  `verify-reattach-agent-backfill` **14/15 exit 1** on both, the same DOM check.
- `npm run gate` (leak + nul + typecheck): **PASS, exit 0**, run unpiped, status read directly.
- One self-inflicted incident worth recording: the first cut of `UNRESOLVED_ANCESTOR` used a
  literal NUL byte, which `check:nul` (BUG-103) caught in the shared tree. Rewritten as
  `'~arch003:unresolved-ancestor'`; no allowlist entry.

**PROVENANCE, carried forward.** SCRIPTED frames through the real server and real bridge,
plus unit drives against the real `OpenToolCalls`. No real-CLI frames — the unchanged limit
for nine passes.

**REACHABILITY, HONESTLY.** The full sequence needs a re-used tool_use id, which the engine
is not known to emit. But (4) of the new script shows the property-(b) half needs ONLY the
ordering — a child issued before its parent with a boundary in between, no reuse at all —
and that is the ordering this design has claimed to support since attempt 6. Fixed as a
state-machine fault, because "should not occur" has now been wrong three times here.

**Handoff.** Session-lifecycle / data-loss-adjacent, EIGHT independent clean-room BROKEN
verdicts, three of which broke a VERDICT rather than the bound — **an independent
clean-room verify is warranted before VERIFIED**; generation must not be its own only judge.
Useful attacks next: (i) the three GUARDED items above, all named with what they corrupt —
in particular whether (ii) is worth a bridge-side change to `#chainHasLiveBackgroundAgent`;
(ii) the one-boundary ageing — is one boundary the right window, and can a stream make an
issue frame arrive two boundaries late; (iii) the one thing nine passes have never touched,
a REAL-CLI frame capture. Deploy still needs a `:4317` restart (in-process bridge).

- **Verified-by:** dispatch openai run 01a016a0-54e8-7b20-8f88-6b56a3a9d341 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

### 9th independent clean-room verification (8th-verdict fix, `a750ec1`) — 2026-08-19

**VERDICT: BROKEN — property (b), through the window the 8th lane had labelled "guarded,
not eliminated — only an ambiguity".** Fourth time on this ticket that a case a lane called
an ambiguity turned out to be a corruption of an existing chain.

```
node scratch-two-reservations.mjs → exit 1
{"provenance":"DIRECT UNIT DRIVE","c1":["P","R1"],"c2":["P"],
 "survived1":true,"survived2":false,
 "defect":"property (b): L2 was reclaimed although R2 is live",
 "indexes":{"bindings":5,"issuers":5,"pending":0,"resolved":7,"aged":7},
 "resident":3,"ok":false}
```

Two children reserve the SAME name `P` before either `P` frame arrives, with a main-thread
re-use of `P` between them. The first reservation fills (`["P","R1"]`); the second binds to
the MAIN THREAD's generation, reads as a COMPLETE ancestry ending at a dead bash, and is
reclaimed while its real ancestor `R2` is live. The verifier stated plainly that it never
reproduced this through the real server and bridge, so reachability was unestablished.

### 2026-08-19 — FIX for the 9th verdict: a name that still OWES a description cannot lend one, and a main-thread generation is never displaced

**THE CAUSE, STRUCTURAL.** Reservations were held ONE PER NAME (`#pending`'s own doc said
"a queue for safety, not for depth" — that sentence was the defect). A name reserved twice
kept only the first, so the second child had nowhere to live and bound to whatever
description happened to stand under the name. Two children that reserved one name in two
different generations wanted two different descriptions, and only one could be had.

**WHAT CHANGED (`src/server/open-tool-calls.ts`, the only source file touched).**
1. **The reservation queue is a QUEUE.** The k-th description of a name fills the k-th
   reservation of it. `#issuerHandleFor` starts a new reservation when — and ONLY when —
   both facts hold at that instant: the generation the name means as an issuer is ALREADY
   DESCRIBED, **and** an unfilled reservation of that name is still parked (the name's own
   bookkeeping saying descriptions for it are arriving late and the next one is spoken for).
2. **A main-thread generation is never DISPLACED as what a name means as a LANE**
   (`#mainGen`). The reverse ordering was already refused; `main → subagent` was not, and it
   re-described the main generation in place. That is the property-(a) half, visible in the
   repro above as `mainChain:["R2"]` — a main-thread lane with a non-empty chain is a
   genuine death suppressed for as long as that chain is live.
3. **A re-issue ends BOTH meanings of the name** (`#markEnded` on the lane generation and on
   the issuer generation). Omitting the second — the first cut of this fix did — left every
   superseded generation OPEN under a live root: 20,000 re-issues, 20,000 records. Measured,
   not reasoned: `adversarial-arch-003-id-reuse-chain-truncation (7)` caught it.
4. **The one-boundary grace belongs to the RECORD, not to the name.** A child joining a
   reservation an earlier child had already waited out inherited an EXPIRED grace and was
   judged at its very first boundary on a chain that read complete. Pre-existing on BOTH the
   8th and 9th builds; 4,128 configurations of the corpus below.

**WHY NOT THE BROADER RULE, stated because it was tried and measured.** "A name that has
ever been re-used lends nothing" also caught names that owe nothing, and made `(10c)`/`(12d)`
spare a genuine death at the only boundary where the row was still open — and a spared death
is not deferred, it is LOST (BUG-030 settles the row at that same sweep). That is the
over-suppression that killed attempts 1-3. It failed `(10c)` end to end and was replaced.

**REACHABILITY: ESTABLISHED END TO END, which the verifier could not do.** New scenario
`tworeservations` in `verify-arch-003-open-tool-calls.mjs` — ordinary assistant /
task_started / background_tasks_changed frames, four turns, both roots' liveness coming from
the engine's own background level. On `a750ec1`: **34/35 exit 1**, `(13b)
{"leafChild2":1}` — the live child of a live root recorded dead through the bridge's own
predicate. With the fix: **35/35 exit 0**. Both runs against the COMMITTED bridge in a
detached worktree, because another lane's `agent-bridge.ts` is in flight in the shared tree.

**THE ENUMERATION GAP, CLOSED.** `adversarial-arch-003-reservation-corpus.mjs` (NEW)
enumerates the whole product rather than the round's own shape: 1-3 children reserving one
name x 1-3 generations x every combination of main / live-root / dead-root descriptions x
every assignment of children to generation-windows x every placement of turn boundaries
between the frames x nesting depth 1 and 2 = **1,209,888 configurations**, graded on
PROPERTIES (ancestry is monotone — never shortened, never redirected; live work is never
unspared; a main-thread lane never inherits an ancestry; a wholly dead chain is never spared
forever; no walk cycles), checked after EVERY frame for EVERY record, not at two moments a
hand-written fixture happens to look at.

| | `a750ec1` | this fix |
|---|---|---|
| violating configurations | **131,288** | **0** |
| `main-lane-inherited-ancestry` | 464,174 | 0 |
| `live-work-unspared` (no grace) | 6,816 | 0 |
| the 9th verdict's own sequence, check (2) | FAIL `{"c2":[],"mainChain":["R2"]}` | PASS `{"c1":["P","R1"],"c2":["P","R2"],"mainChain":[]}` |

The property-(a) class it found (464,174 occurrences over 127,160 configurations) is a
failure NO round-by-round fixture had constructed in nine passes.

**WHAT IS NOW UNREPRESENTABLE (not guarded).**
- *A reservation being lost because the name was reserved again.* Reservations are a queue
  keyed by nothing the engine controls; "reserved twice" is not a case.
- *A main-thread lane inheriting a subagent ancestry.* A main-described generation is never
  re-described in place and never displaced as the lane meaning, in EITHER frame order.
- *An established ancestry changing.* Asserted as monotonicity after every frame over the
  whole corpus, not argued in a comment.

**WHAT IS STILL ONLY GUARDED, with what it can corrupt, each pinned.**
1. *Which call a LANE named `P` is after a re-use* — one row, the re-used id itself; no
   descendant is affected (descendants walk handles). The trade is deliberate and one-way:
   toward (a), an early death, never a suppressed one. `ownerChainOf` is asked by NAME by
   the bridge, so satisfying both lanes is impossible without a bridge-side API change —
   named here as the next lane's decision, not waved at. Pinned: reservation-window (6).
2. *A description arriving MORE THAN ONE BOUNDARY after its own reservation.* The reservation
   has aged, the ancestry reads as ending at that name, and the child is judged one boundary
   before its ancestry finished growing — an early death, in the (a) direction. **16,520 of
   the 1,209,888 configurations**, counted and pinned by corpus check (6) as a NUMBER a later
   pass can compare against. Under the real protocol a `parent_tool_use_id` names an id an
   EARLIER assistant frame minted, so a description two boundaries late is not a reachable
   ordering; extending the grace deepens suppression, which this ticket has already paid for.
3. *A `kind:'agent'` row with an incomplete ancestry is still recorded dead* — unchanged,
   BUG-105's deliberate decision, lives in `agent-bridge.ts`. Pinned: reservation-window (7).

**Runs, as printed, with exit codes.** All ARCH-003 / anti-regression suites re-run in a
detached worktree at the COMMITTED tree (`326439c`) with ONLY `open-tool-calls.ts` changed,
so nothing is attributed to the `agent-bridge.ts` lane in flight beside this one.
- `adversarial-arch-003-reservation-corpus.mjs` (NEW): OLD **4/6 exit 1** (131,288 violating
  configurations) → NEW **6/6 exit 0** (0 violating of 1,209,888, ~23 s).
- `verify-arch-003-open-tool-calls.mjs` (+1 scenario, +4 checks): OLD **34/35 exit 1** →
  NEW **35/35 exit 0**.
- `verify-arch-003-growth-bound.mjs` **25/25 exit 0**;
  `adversarial-arch-003-reservation-window.mjs` **9/9 exit 0**;
  `adversarial-arch-003-id-reuse-chain-truncation.mjs` **7/7 exit 0**;
  `adversarial-arch-003-nested-terminal-owner.mjs` **7/7 exit 0**;
  `adversarial-arch-003-boundary-between-signals.mjs` **6/6 exit 0**;
  `adversarial-arch-003-result-before-open-growth.mjs` **exit 0**;
  `verify-arch-003-owner-lifetime.mjs` **13/13 exit 0**;
  `verify-arch-003-per-row-owner-sweep.mjs` **5/5 exit 0**.
- `verify-bug-096` **17/17 exit 0**; `verify-bug-105` **40/40 exit 0**;
  `verify-running-snapshot` **47/47 exit 0**; `verify-stall-detector` **33/33 exit 0**;
  `verify-feat-064-drain-truth` **18/18 exit 0**; `verify-agent-outcomes` **45/45 exit 0**;
  `verify-liveness-conformance` **96/96 exit 0**.
- NOT GREEN, NOT MINE: `verify-zombie-busy` **35/39 exit 1** and
  `verify-reattach-agent-backfill` **14/15 exit 1** — the exact pre-existing baselines.
- `npm run gate` (leak + nul + typecheck): **PASS, exit 0**, unpiped, status read directly.

**EVERY PUBLISHED GROWTH FIGURE HOLDS.** Growth guard 25/25 unchanged: 28,944 calls → 144
resident / peak 162 under assistant-first, result-first and mixed; 0@3d/0@9d with boundary
liveness and 600@3d/600@9d under the 5th verdict's ordering; 1,000/10,000 for the immortal
owner; 20,000 re-issues → 0 resident / 2 bindings; the name index 0/0 at 3 and 9 days. NONE
moved. The two structures this fix adds are measured, not described: `indexSizes()` now
reports `mainGen`, corpus (4) asserts every index goes to ZERO across 55,296 configurations
once nothing is live, and corpus (5) drives 20,000 reserve/re-use/describe rounds on one name
(every index < 200 while live, all 0 after).

**Handoff.** Session-lifecycle, NINE independent clean-room BROKEN verdicts, four of which
broke a VERDICT rather than the bound — **an independent clean-room verify is warranted
before VERIFIED**; generation must not be its own only judge. The corpus is the artefact to
attack first: extend it (k>3, g>3, `ended()` interleaved into the enumeration, depth 3) and
see whether the space it does NOT cover holds a tenth shape. Deploy still needs a `:4317`
restart (in-process bridge). PROVENANCE unchanged for nine passes: scripted frames through
the real server and bridge, plus unit drives — no real-CLI capture yet.

## 2026-08-19 — 10th independent clean-room verification (f398d5c)

- **Verified-by:** dispatch anthropic run dce68243-f0cd-4f7d-878b-a29da031be01 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

## 2026-08-19 — 10th-verdict fix: a settled record is immutable, and repeats are now a dimension of the corpus

**The defect, reproduced before anything was changed.** The clean rooms from that pass were
deleted externally, so the verifier's scratch fuzz was NOT recoverable; it was reconstructed
from the reported sequence and confirmed to reproduce the reported line before a character of
`open-tool-calls.ts` moved:

```
issuedBySubagent(k1,Z); issuedBySubagent(Z,R1); ended(Z); ended(Z); issuedBySubagent(Z,R3)
{"case":"A-hand","before":["Z","R1"],"after":["Z","R3"],"ok":false}     exit 1
{"RUNS":3000,"violations":18,...,"from":["Z","R1"],"to":["Z","R3"]}
```

(18/3000 against the verdict's 12/3000 — a different seed and a slightly wider op mix, same
shape, same first failure.) The reconstruction also turned up a SECOND corruption in the same
class that the verdict did not name, and it needs only ONE end signal:

```
issuedByMainThread(P); ended(P); issuedBySubagent(P,R)
{"case":"B-main-inherit","mainChain":["R"],"ok":false}
```

A MAIN-THREAD LANE with a non-empty chain is property (a): its genuine death is suppressed for
as long as `R` lives. `issuedByMainThread` marks its generation `#resolved` but stores no
record, so `ended(P)` created an un-described record ON the main-thread generation and the next
subagent frame filled it.

**Root cause, stated as the class.** Every rule this type has protects a RECORD from what
happens to a NAME. Nothing protected a record from a REDUNDANT SIGNAL about its own name. The
fill branch in `issuedBySubagent` is entitled to write an ancestry onto a record only because
an unmatched end has none — and it tested that entitlement by reading a MUTABLE state field
that `ended()` could push a fully described record back into.

**The fix — made structural, not guarded.**
1. `CallRecord`'s `parent`, `parentHandle` and `state` are `readonly`; a transition REPLACES
   the record object. "There is no code path that writes a `parentHandle` after creation" was
   a comment sitting next to the code path that did. It is now a COMPILE ERROR.
2. `settled` is ABSORBING (`#settle`). No signal, at any repetition, moves a record backwards
   into a state meaning "nobody has described this".
3. The fill branch is gated on `#resolved` — *has an issue frame claimed this handle* — a fact
   set at creation and never unset while the handle lives. It covers the main-thread
   generation too, so (B) is closed by the same gate as (A).

**Unrepresentable vs guarded, stated plainly.** UNREPRESENTABLE: an established ancestry being
rewritten by any later signal (repeat, re-issue, or end), in any order, at any depth — the
write is impossible in the type, and the one non-creation write is gated on a monotone fact.
Also unrepresentable: a main-thread generation acquiring a subagent ancestry through an end
signal. STILL GUARDED, unchanged and unaffected by this change: the three items already listed
in the previous entry (which call a LANE named `P` is after a re-use; a description more than
one boundary late; a `kind:'agent'` row with an incomplete ancestry).

**Reachability, both limits answered honestly.**
- *End to end: PROVEN.* New `redundantend` scenario in `verify-arch-003-open-tool-calls.mjs`,
  driven through the real server, the real bridge and its own predicate. On the pre-fix tree:
  **36/37 exit 1**, `(14b) {"leafChild1Deaths":["leafChild1"],"allEnded":["mainOrphan2:unknown","leafChild1:unknown","mainOrphan:unknown"]}` — a leaf still running under a
  LIVE background root, recorded dead. With the fix: **37/37 exit 0**. NOTE FOR THE NEXT PASS:
  the first cut of this scenario PASSED on the broken module and was wrong, not the module —
  the turn-end sweep settles every running row (BUG-030) and the reap then reclaims its record,
  so a lane is judged at exactly ONE boundary. A corruption delivered in a later turn than the
  lane reaches no verdict; the corrupting frames must land in the lane's OWN turn.
- *Can the engine emit two `tool_result` frames for one `tool_use` id? No evidence that it can,
  and that is a calibration, not a defence.* Measured over the real session store: **0 files of
  3,663 contain a `tool_use_id` appearing in more than one `tool_result` block; 0 repeated
  tool_use ids across 113,963 real tool calls; 0 duplicated message uuids.** In our code there
  is one consumer (`for await (const msg of this.#runtime.messages()) this.#handle(msg)`, a
  single iterator, synchronous handler), the host relay keeps NO backlog (a reattach LOSES
  frames, never duplicates them), no transcript reader feeds the bridge, and the only synthetic
  `tool_result` frames (the Codex adapter) are single-shot by construction. So this is a
  state-machine fault reachable by a stream the engine is not known to produce — the same
  status id reuse had for six verdicts before one of them turned out to matter. The type must
  hold on its own terms, and now does.
- *One consequence is NOT observable end to end and is recorded as such:* case (B)'s property-(a)
  half. The signal that causes it (the lane's `tool_result`) also settles the row, so no death
  can be suppressed by it TODAY. It corrupts the registry's ANSWER, which two other bridge call
  sites read; it is fixed and pinned at the unit level ((8b)), not waved at.

**The corpus now has the dimension it was missing.**
`adversarial-arch-003-reservation-corpus.mjs` gains (7)/(8)/(9): the same reservation product
now WITH end signals (for the shared name and for the children, every subset) and with EVERY
event duplicated at EVERY position after its original — repeated reservation, repeated
description, repeated end, repeated root frame, before/between/after each other event, across
every boundary placement, at depth 1 and 2. **1,548,416 configurations, 1,496,224 of them
carrying a repeat.** Graded on the same properties, no expected outputs.

*Calibration table, every generation re-stated, all figures measured on this machine:*

| generation | corpus | configurations | violating on the module it was written against |
|---|---|---|---|
| 9th | hand-written fixtures | ~10 | 1 (the one the verdict named) |
| 9th fix | reservation corpus (1) | 1,209,888 | 131,288 on `a750ec1` |
| 10th verdict | scratch fuzz | 3,000 runs | 12 (18 on the reconstruction) |
| 10th fix | repeats product (7) | 1,548,416 | **35,786 on `e8e25da`** |

And the number that justifies the whole section: on `e8e25da` the OLD corpus (1) reports
**1,209,888 configurations, 0 violating** while (7) reports **35,786 violating**
(`{"main-lane-inherited-ancestry":85090,"ancestry-changed":25908}`) — the previous product
could not express a repeat, so no number of configurations of it was ever going to find one.
(1) is unchanged at **1,209,888 / 0 violating** and residual **16,520** on both trees.

*Two grader premises had to be corrected when end signals entered the corpus, and both are
recorded rather than quietly applied:* (i) a child described as issued by a call whose OWN
result has already been delivered cannot be in flight, so it is excluded from the LIVE-WORK
properties (still graded on ancestry monotonicity, property (a) and totality); (ii) a second
frame for the same child id is a RE-ISSUE of that lane name — a different call — so its
ancestry baseline resets, and the corruption is watched instead through the depth-2 grandchild,
whose own frame arrives once and whose ancestry walks through the re-issued record by handle.
Both were validated the only way that counts: **the corrected grader still reports 35,786
violating configurations on the pre-fix module**, so neither premise conceals the defect.

**Runs, as printed, with exit codes** (fixed tree unless stated):
- `adversarial-arch-003-reservation-corpus.mjs` **12/12 exit 0** (was 6/6; (1) 1,209,888/0,
  (7) 1,548,416/0, ~46 s). PRE-FIX: **8/12 exit 1**.
- `verify-arch-003-open-tool-calls.mjs` **37/37 exit 0** (was 35/35). PRE-FIX **36/37 exit 1**.
- `verify-arch-003-growth-bound.mjs` **25/25 exit 0**; `adversarial-arch-003-reservation-window.mjs`
  **9/9 exit 0**; `adversarial-arch-003-id-reuse-chain-truncation.mjs` **7/7 exit 0**;
  `adversarial-arch-003-nested-terminal-owner.mjs` **7/7 exit 0**;
  `adversarial-arch-003-boundary-between-signals.mjs` **6/6 exit 0**;
  `adversarial-arch-003-result-before-open-growth.mjs` **exit 0**;
  `verify-arch-003-owner-lifetime.mjs` **13/13 exit 0**; `verify-arch-003-per-row-owner-sweep.mjs`
  **5/5 exit 0**.
- `verify-bug-096` **17/17 exit 0**; `verify-bug-105` **73/73 exit 0**; `verify-running-snapshot`
  **47/47 exit 0**; `verify-stall-detector` **33/33 exit 0**; `verify-feat-064-drain-truth`
  **18/18 exit 0**; `verify-agent-outcomes` **45/45 exit 0**; `verify-liveness-conformance`
  **96/96 exit 0**.
- NOT MINE: `verify-zombie-busy` **35/39 exit 1** — the stated baseline, same four
  approval-card/stall checks. `verify-reattach-agent-backfill` **15/15 exit 0** here (the
  stated baseline was 14/15; it is flaky, and it is green on this tree).
- `npm run gate` (leak + nul + typecheck): **PASS, exit 0**, run unpiped, status read directly.

**EVERY PUBLISHED GROWTH FIGURE HOLDS, MEASURED PRE AND POST RATHER THAN ASSERTED.** The
observed residency/index numbers of growth-bound, id-reuse-chain-truncation,
reservation-window, result-before-open-growth and boundary-between-signals are BYTE-IDENTICAL
on the pre-fix and fixed trees (peak 1520 / 162, resident 100000 → 0, 20,001 while a root
lives, 20,000 generations → 0 resident, 0/0 at 3 and 9 days). Nothing moved, and the reason it
could not is that the fix changes only which BRANCH a re-issue takes, never what is stored: the
fill branch and the supersede branch both leave exactly one record per generation. New (9)
measures repeats specifically: 20,000 rounds of duplicate reservations, duplicate descriptions
and TRIPLE end signals on one name under a live root leave every index at 0 while live and 0
after retirement.

**Regression honesty.** `regressed-from:` the 4th-verdict fix (commit `35787ea`, "make the open
and end signals annihilate in either order") introduced the `ended-unmatched` state and the
fill branch that writes an ancestry into it; the 7th-verdict handle redesign then made that
branch the ONLY post-creation write and documented it as safe. This defect is the two of them
meeting a repeat. Nothing here re-opens either fix — (8d) pins the 4th verdict's
commutativity, and the handle walk is untouched.

**Handoff.** Session-lifecycle, TEN independent clean-room BROKEN verdicts, five of which broke
a VERDICT rather than the bound — **an independent clean-room verify is warranted before
VERIFIED**; generation must not be its own only judge. Attack list for the 11th pass, in order:
(a) the repeats product stops at depth 2, k<=2, g<=2 and 4 boundary slots — widen it;
(b) `#aged`, `#pending` and `#resolved` are indexes whose entries are keyed by handle and whose
lifetimes are asserted only in aggregate; construct a sequence where one of them retains an
entry no record needs; (c) the two grader premises above are the corpus's own opinions and are
the first thing to attack — if either is wrong, (7)'s zero is worth less than it looks;
(d) case (B)'s unobservability end to end depends on BUG-030 settling the row at the same
boundary; if a lane can carry a `tool_use` id whose result has already arrived, that becomes a
suppressed death. Deploy still needs a `:4317` restart (in-process bridge). PROVENANCE
unchanged for ten passes: scripted frames through the real server and bridge, plus unit drives
— no real-CLI capture yet, though the duplicate-frame question above IS now measured against
3,663 real captured sessions.

## 2026-08-19 — 11th independent clean-room verification (28bc233)

- **Verified-by:** dispatch anthropic run 755fa631-75fc-49f1-b575-c5e965fce367 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: HOLDS

## 2026-08-19 — 11th-pass residuals closed, and the VERIFIED judgement

**Why this pass is allowed to close the ticket at all, stated before the evidence.** Ten
consecutive clean-room verdicts on this surface were BROKEN and every one of them was
CORRECT. A green suite has therefore never been the answer to the question — the suite was
green at all ten. What is different here is not that the tests pass; it is that an
INDEPENDENTLY-AUTHORED grader, written by an agent with no access to this lane's fixtures,
searched a space this lane's corpus does not cover (a 20,000-seed randomised fuzz to depth 4
across 8 names with freely interleaved and REPEATED signals, plus a 6,000-run
index-boundedness drain measuring peaks) and found nothing — and that same grader was shown
to be FAIL-SENSITIVE by re-running it against the pre-fix module, where it fires at **seed
8**. Two independently-written graders, each demonstrated to fire on `e8e25da`, both report
zero on `28bc233`: the exhaustive product (1,548,416 configurations) and the randomised fuzz.
That is a materially different epistemic position from any previous pass, all of which rested
on a corpus this lane wrote.

**Residual 1 — "it never ran the server-backed suite" — CLOSED BY EVIDENCE.** The verifier's
whole case was direct drives of the type against a bridge predicate it modelled ITSELF, so
the end-to-end path was never exercised in the clean room. Every ARCH-003 guard and every
adjacent anti-regression suite was re-run against the COMMITTED tree (`28bc233`) in a
detached worktree, so nothing is attributed to the `agent-bridge.ts` lane in flight beside
this one. Numbers as printed, exit status read directly:

- `verify-arch-003-open-tool-calls.mjs` **39/39 exit 0** (37 as published, plus (15)/(15b)
  added by this pass — see below).
- `adversarial-arch-003-reservation-corpus.mjs` **12/12 exit 0** ((1) 1,209,888/0, (7)
  1,548,416/0, (9) every index 0 while live and 0 after retirement over 20,000 repeat rounds).
- `verify-arch-003-growth-bound.mjs` **25/25 exit 0**; `verify-arch-003-owner-lifetime.mjs`
  **13/13 exit 0**; `verify-arch-003-per-row-owner-sweep.mjs` **5/5 exit 0**;
  `adversarial-arch-003-reservation-window.mjs` **9/9 exit 0**;
  `adversarial-arch-003-id-reuse-chain-truncation.mjs` **7/7 exit 0**;
  `adversarial-arch-003-nested-terminal-owner.mjs` **7/7 exit 0**;
  `adversarial-arch-003-boundary-between-signals.mjs` **6/6 exit 0**;
  `adversarial-arch-003-result-before-open-growth.mjs` **exit 0**
  (`{"ordering":"result>assistant>boundary","total":100000,"resident":0,"bounded":true}`).
- `verify-bug-096-bg-child-lane-no-fabricated-death` **17/17 exit 0**;
  `verify-bug-105-foreground-subagent-of-live-owner` **73/73 exit 0**;
  `verify-running-snapshot` **47/47 exit 0**; `verify-stall-detector` **33/33 exit 0**;
  `verify-feat-064-drain-truth` **18/18 exit 0**; `verify-agent-outcomes` **45/45 exit 0**;
  `verify-liveness-conformance` **96/96 exit 0**.
- `npm run gate` (leak + nul + typecheck): **PASS, exit 0**, unpiped, status read directly.
- NOT MINE, and BASELINED BEFORE BEING ATTRIBUTED — both re-run on the parent commit
  `e8e25da` in its own detached worktree: `verify-zombie-busy` **35/39 exit 1 on BOTH trees**,
  the same four approval-card/stall checks (`FALSE-POSITIVE GUARD … STILL alive`, `the server
  says WHY`, `nothing was reaped while the card was open`, `the answered card resumes the
  turn`). `verify-reattach-agent-backfill` is genuinely flaky and the flake is NOT
  tree-dependent: **14/15, 14/15, FATAL** ("sub-agents never started — cannot test replay")
  on `28bc233` against **15/15, FATAL, FATAL** on `e8e25da`.

**Residual 2 — "the immutability claim was never type-checked" — CLOSED BY DEMONSTRATION.**
The design's headline property is that a post-creation ancestry write is a COMPILE ERROR
rather than a convention, but the verifier ran the module through a loader that strips types
WITHOUT checking them. A scratch file (a verbatim copy of `open-tool-calls.ts` plus one
function attempting the writes) was placed under the project's own `tsconfig` `include` and
typechecked. `npx tsc --noEmit` **exit 1**, with exactly the expected errors and nothing else:

```
src/server/__arch003-immutability-probe.ts(1076,7): error TS2540: Cannot assign to 'parentHandle' because it is a read-only property.
src/server/__arch003-immutability-probe.ts(1077,7): error TS2540: Cannot assign to 'parent' because it is a read-only property.
src/server/__arch003-immutability-probe.ts(1078,7): error TS2540: Cannot assign to 'state' because it is a read-only property.
src/server/__arch003-immutability-probe.ts(1079,7): error TS2540: Cannot assign to 'id' because it is a read-only property.
```

`rec.aged = true` — the ONE deliberate exception, which carries no ancestry and only moves
false → true — compiles, as the type's doc comment says it should. The scratch file was then
deleted and the typecheck returns to **exit 0**. Baseline before the probe was also exit 0,
so the failure is the probe's and not the tree's.

**AND THE `readonly` IS NOT THE WHOLE STORY, WHICH IS WORTH SAYING PLAINLY.** `readonly` is
shallow: it forbids editing a record IN PLACE, but the design's transitions REPLACE the
object, and a replacement could in principle carry a different ancestry. So the compile error
closes only half the property. The other half is a runtime gate, and it was read rather than
trusted: there are exactly five writes to `#calls` — `#settle` (copies `parent`/`parentHandle`
through, changes only `state`), the fill branch (line 651, the ONLY post-creation ancestry
write, gated on `!#resolved.has(target)`), the two creations, and `reap()`'s delete. And
`#resolved` cannot be un-set underneath that gate while the record it protects exists:
`reap()` deletes a `#resolved` entry only when `expired(h)`, which requires `!needed(h)`,
which requires `!this.#calls.has(h)`. A described record therefore keeps its `#resolved`
marker for exactly as long as it exists, so the fill branch can never re-open on it.

**Guarded item 2 converted from an argument into a number: `maxBoundariesLate` is 0 across
130,575 real owner references.** This is the residual that mattered most to the judgement,
because it is the only guarded item whose consequence is an EARLY DEATH — live work recorded
dead, the exact failure this ticket exists to stop — and it was defended by an ASSERTION
about the real frame protocol ("a description two boundaries late is not a reachable
ordering") on a surface where no clean room has ever seen the real protocol. It is now
measured. Every frame in the real captured session store that names an owning call
(`sourceToolAssistantUUID`, `parentToolUseID`, `sourceToolUseID`) was located against the
frame that MINTS that owner, with the turn boundaries between them counted:

```
{"files":3722,"ownerRefs":130575,"earlier":130499,"later":50,"ownerIdNotInFile":26,
 "maxBoundariesLate":0,"lateHistogram":{"0":50}}
```

Late references DO occur — 50 of them, so the reservation machinery is not dead weight — but
every one is late WITHIN THE SAME TURN. Nothing in 3,722 sessions is even ONE boundary late,
and the type grants ONE. The 16,520 corpus configurations are a synthetic ordering, not an
observed one, and the grace exceeds the worst observed ordering by a full boundary. Pinned as
check **(15)** in `verify-arch-003-open-tool-calls.mjs`, so a later pass has a NUMBER to
compare against rather than a paragraph. **(15b)** re-takes the id-reuse calibration on this
machine instead of transcribing the previous pass's figure: **114,799 `tool_use` blocks /
114,695 `tool_result` blocks across 3,722 sessions, 0 repeated `tool_use` ids, 0 duplicated
`tool_result` ids**. Both checks SKIP — printed as `SKIP`, explicitly NOT counted as passes —
when the store is absent or below a minimum sample, and that path was exercised: run under an
empty `HOME` the suite prints the SKIP line and reports **37/37**, so neither check can pass
vacuously in a clean room that has no store.

**Guarded item 1 attacked, not accepted.** Four times on this ticket a case labelled
"guarded, only an ambiguity" turned out to be a real corruption, so the current list was read
with that history rather than at face value. Item 1 — *which call a LANE named `P` is after a
re-use* — is the dangerous one to leave labelled, because it is the item the corpus does NOT
grade: it is an ambiguity about ground truth rather than a violation of a stated property, so
a wrong grader premise would hide it exactly the way the previous four were hidden. It was
probed directly against the committed module in the four directions that could corrupt:

```
{"case":"reuse-with-live-child","cChain":["P","R1"],"pChain":[],"ok":true}
{"case":"reuse-old-root-dies","cChain":["P","Rdead"],"ok":true}
{"case":"repeat-end-first","cChain":["P","R1"],"ok":true}
{"case":"repeat-reissue-first","cChain":["P","R1"],"ok":true}
{"case":"reuse-growth","sizes":{"bindings":2,"issuers":2,"pending":0,"resolved":2,"aged":2,"mainGen":1},"ok":true}
```

A live child keeps its live ancestry through a re-use while the lane `P` correctly becomes the
main thread with an EMPTY chain (property (a)); a child of the OLD generation is NEVER moved
onto the NEW root even when the old root dies and the new one lives — that move is precisely
how a genuine death would be SUPPRESSED, and it does not happen, the ancestry is retained by
handle as `["P","Rdead"]`; repeated ends in either order across three boundaries do not
disturb a live child's chain; and 20,000 sustained re-uses of one name under a live root
leave every index at ≤ 2. Combined with 0 observed id re-uses in 114,799 real tool calls, this
is a naming ambiguity with a stated one-way direction and one row of blast radius — an
acceptable residual, not the next defect wearing a label.

**Guarded item 3 is not this ticket's.** *A `kind:'agent'` row with an incomplete ancestry is
still recorded dead* lives in `agent-bridge.ts` and is BUG-105's deliberate decision. It is
pinned here by reservation-window (7) so it cannot drift silently, but the call belongs to
that ticket and closing ARCH-003 does not close it.

**THE JUDGEMENT: VERIFIED, with the deploy gate and the provenance limit both explicit.**
The two non-negotiables — (a) a genuinely-dead main-thread task is recorded dead and cannot be
suppressed, (b) a child of a still-running background agent is never recorded dead — hold
under an exhaustive product of 1,548,416 configurations, an independently-authored 20,000-seed
fuzz, and the end-to-end server-backed suite, with both graders demonstrated to fire on the
pre-fix module. The failure class that produced ten verdicts (a record's ancestry changing
after it was established) is now half unrepresentable in the TYPE and half gated on a
monotone fact that cannot be un-set while the record exists.

**What is true and NOT verifiable, and this belongs in the status rather than in a footnote:**
*No clean room on this surface has ever had real-CLI access.* Every one of the eleven passes
rests on SCRIPTED frames through the real server and the real bridge plus direct unit drives.
The frame protocol itself has never been captured from a live CLI inside a verification, so
every pass — including this one — is a statement about the type and the bridge under frames
we authored. It follows that the REACHABILITY of several FIXED defects through the real frame
protocol was never established: the 7th verdict's `tool_use` id reuse and the 10th verdict's
duplicate `tool_result` are both faults reachable only by a stream the engine is not known to
emit (0 of each in 114,799 real tool calls), and the 10th fix's case-(B) property-(a) half is
not observable end to end at all — it is pinned only at the unit level ((8b)). Those fixes are
correct on the type's own terms; what is unproven is that the field could ever have triggered
them. Check (15)'s store scan narrows this but does not remove it: the persisted transcript is
a PROXY for the wire, not the wire.

**DEPLOY IS NOT DONE.** The bridge is in-process, so nothing here is live until `:4317` is
restarted — untouched by this lane by instruction. VERIFIED → DONE is waiting on that restart
and on a post-restart observation that no fabricated death appears on a real session.

**Symptom of a deeper design flaw?** This ticket IS the ARCH ticket. The deeper flaw it
records, now closed: ownership was inferred at the instant of the sweep from partial signals,
and was keyed by an id the system neither mints nor can guarantee unique. Both are gone —
ownership is a CHAIN resolved from a mirror of the open calls, keyed by an internal handle.
The one structural lesson worth carrying forward to other surfaces: **eleven passes were
needed because the tests graded outcomes the author could imagine, and the defect was always
in a dimension the corpus could not express** (orderings, then reuse, then repeats). The
corpus only started finding real defects when it enumerated a PRODUCT and graded PROPERTIES
after every frame instead of comparing against expected outputs.

**Handoff, if a 12th pass is ever warranted.** The one thing that would raise this above
its current ceiling is REAL-CLI CAPTURE in a clean room — record a live session's raw frame
stream and replay it through the bridge, which is the only way to retire the provenance
limit above. Short of that: (a) widen the repeats product past depth 2 / k≤2 / g≤2 / 4
boundary slots; (b) attack the two grader premises recorded in the 10th-fix entry, which are
still the corpus's own opinions; (c) check (15) is a calibration on ONE machine's store — a
different machine, or a future CLI, could move `maxBoundariesLate` off 0, and that number
moving is the signal that guarded item 2 has become live.
