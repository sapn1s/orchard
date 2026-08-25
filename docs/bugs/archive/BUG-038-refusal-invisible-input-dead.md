# BUG-038 — turn refusal is invisible: message stays in the box, nothing happens, only console says why

- **Status:** VERIFIED (2026-08-09 — fix agent; correctness fix proven 4/4 post-fix vs 1/4 pre-fix, visibility audit found nothing to fix, verify:refusal-visible 16/16, verify:zombie-busy A-D 34/34 no regression)
- **Area:** UI — refusal/rollback feedback (BUG-029 + BUG-033 refusal paths)
- **Reported:** 2026-08-09 by user, immediately after the BUG-033 deploy

## Symptom
Sending a message while the server is refusing (post-restart drain / unverifiable bridge):
- Console logs `[station] this session is still finishing its previous turn after a server
  restart — try resuming again in a few seconds`.
- The composer does NOTHING visible: the text stays in the input, no bubble, no queue entry, no
  status line, no error. The input appears dead/broken.

## Why this matters
BUG-029 replaced "silently swallow the message" with "refuse and give the text back", and BUG-033
added a second principled refusal (`frameless` bridge). Both are CORRECT server-side — but if the
refusal is only visible in the browser console, the user experiences it as a broken input box,
which is arguably worse than the queue black hole: at least that showed a queued item. The fix's
honesty must reach the SCREEN, not devtools.

## Fix direction
Every refusal path must produce a VISIBLE, plain-language line where the user is looking (status
line/`say()` + optionally a transient composer note): what happened ("the previous turn is still
finishing"), what was done with their text ("kept in the box — nothing was lost"), and what to do
("press Enter again in a few seconds" / a Retry affordance). Reuse BUG-031's attributed-card style
if a card is warranted; a status line may be enough. Check EVERY refusal/rollback branch —
`rollBackPendingStart`, the `frameless` refusal, the drain refusal — none may be console-only.

## Verification (REQUIRED, user-observable, must FAIL pre-fix)
Drive a real refusal (scratch server: session draining / bridge frameless) with a real browser:
assert a visible message appears in the UI (not console) naming the reason, the composer keeps the
text, the composer is NOT left disabled, and a retry after the drain succeeds. Console-only output
fails the test. Anti-regressions: verify:resume-refusal, verify:zombie-busy, ui offline, typecheck.

## Activity log (APPEND-ONLY)
### 2026-08-09 — orchestrator
- Filed minutes after BUG-033 went live; the refusal logic is right, its user-facing half is
  missing. Pairs with BUG-034 (queued, same file) — likely one UI pass.

### 2026-08-09 — user follow-up + orchestrator evidence: the refusal may also be WRONG
User: "nothing was even running when it was stopping me from sending — there didn't come any
message from you that would imply it was processing."

Orchestrator evidence at that moment (read-only):
- `doctor` right after the restart showed a SURVIVOR (broker + CLI alive from before the restart,
  `state: SURVIVED a restart … turn draining`, `adopted: no`) — while the visible turn had already
  completed.
- Minutes later: TWO `claude-station-host-*` scopes alive while only ONE corresponds to the live
  adopted session — i.e. a leftover host lingering past its usefulness.

So the ticket now has TWO halves:
(a) VISIBILITY — a legitimate refusal must be visible in the UI, not console-only (original scope);
(b) CORRECTNESS — the survivor-drain refusal must consult GROUND TRUTH (BUG-033's `SurvivalProbe`/
    `probe()` rungs) instead of refusing because a survivor record/scope merely EXISTS. A dead or
    already-finished survivor must be reaped and the send allowed through (mirroring BUG-033's
    `dead-process` disposition for bridges). Refuse only when the survivor is probed alive AND
    mid-turn.
False-positive guard required in BOTH directions: a stale survivor must not block a send; a
genuinely mid-turn survivor must still refuse (visibly).

### 2026-08-09 — fix agent — AUDIT + CORRECTNESS FIX + VERIFY

**Audit (original visibility charter) — every send-path refusal/rollback branch in `public/app.js`,
read line by line, not assumed:**

| Branch | Location | Visible? |
|---|---|---|
| `case 'error'` (top, unconditional) | `app.js:5310-5311` | `say(e.message, true)` — always renders to `#fine`, before any branching |
| `rollBackPendingStart` retryable follow-up | `app.js:5333-5338` | `say('your message is kept in the composer…')` overwrites with the friendly line |
| fatal error | `app.js:5312-5318` | inherits the top-of-case `say()`; also sets `state.sessError` |
| budget-stop | `app.js:5319-5332` | inherits the top-of-case `say()`; also `rollBackPendingSend()` |
| mid-turn reattach ("deliver at the next pause") | `app.js:4925-4948` | `say('re-attached — … your message is queued for the next pause')` / `say('re-attached to the running session')` |
| `subagent-send-unsupported` | `app.js:4803-4815` | `say(e.reason, true)` |
| `provider-error` (terminal / tooling-unavailable) | `app.js:5222-5252` | durable attributed card (`renderProviderError`) + `say(provErrorLine(e), true)` |
| `session-closed` | `app.js:5342-5349` | `say(...)` |

**Finding: the ORIGINAL "console-only" charter does not reproduce against the current tree.** Every
one of the above already calls `say()` (which sets `#fine.textContent` + un-hides it — a real DOM
write, not `console.*`). `say()`'s own `console.warn` (line 336) is a *supplement* for `isErr`, not
the only sink. This machinery was added by BUG-029 (the `rollBackPendingStart` retryable line) and
BUG-033 (the `frameless` refusal + reattach status). Proven non-vacuously below: the new real-browser
test's ALIVE and FRAMELESS scenarios (visibility-only, no survivor-liveness fix involved) both pass
**16/16 even with `src/server/index.ts`+`src/server/survival.ts` stashed** — i.e. pre-existing code
already renders both refusal shapes on screen. No console-only branch was found. (BUG-034, filed
alongside this ticket for the same file, may still have its own scope — not investigated here.)

**The CORRECTNESS half (the user's follow-up) reproduces exactly, and is real.**
`survivingHostForSdkSession` (`src/server/survival.ts:434`, called from the BUG-022 guard at
`src/server/index.ts:2233`, pre-fix) returns a `HostStatus` the instant one exists on disk with a
live `hostPid` — `scanSurvivingHosts` only ever checked "is the broker's OWN process alive", never
whether the CLI it was minding had already exited or whether the broker itself had already recorded
`state:'exited'`. A corpse — broker process still winding down, CLI long gone — kept refusing every
send with "still finishing its previous turn" for as long as the broker process lingered, exactly
matching the live incident (`doctor` showed a survivor "turn draining" after the visible turn had
already completed). This is precisely BUG-033's `dead-process` disposition, applied to the *bridge*
liveness gate — but the *survivor* guard (an older, separate check over `HostStatus` files) was never
given the same treatment.

**Fix.**
- `src/server/survival.ts:401` — new exported `probeSurvivorHost(st: HostStatus): SurvivalProbe`:
  ground truth for a survivor discovered COLD, on disk (no in-memory `AgentSession` to consult, unlike
  `SurvivalHandle.probe()`) — the broker's own recorded verdict (`state:'exited'`) first, then live-pid
  checks on the broker + CLI pids it recorded. `SurvivalHandle.probe()`'s rungs 3-4 (`:376`) now call
  this same function instead of duplicating the logic.
- `src/server/survival.ts:416` — `dropDeadSurvivorHost(st)`: sweeps the corpse's on-disk files
  (reuses `cleanupHostFiles`) once probed dead, so it stops lingering in future scans.
- `src/server/index.ts:2233-2280` — the guard now probes before refusing: `probe.state === 'alive'`
  → refuse exactly as before, retryable, but the message now NAMES the evidence too (`"…(broker pid
  N and CLI pid M are alive (broker state draining))…"`); `probe.state === 'dead'` → drop the corpse's
  files, send an honest `status` line, and fall through to the ordinary resume-from-disk path below —
  same disposition as BUG-033's `dead-process` case, so the user's prompt starts a REAL turn instead
  of being refused against nothing.

**Verification — `scripts/verify-refusal-visible.mjs` (new; package.json entry NOT added, per
charter — `"verify:refusal-visible": "node scripts/verify-refusal-visible.mjs"`).** Real brave-headless
browser (playwright), scratch server (free port, scratch dataDir; `:4317` never touched), kill by pid
only. Three scenarios, `node scripts/verify-refusal-visible.mjs <alive|stale|frameless>`:
- **ALIVE** — a genuinely-draining survivor (real live dummy pid, `state:'draining'`) planted for a
  real on-disk session: 5/5 — visible `#fine` message naming the refusal, composer keeps the exact
  typed text, composer NOT stuck busy, and a retry once the dummy broker is killed actually sends and
  completes for real (a following turn's cost/duration line lands).
- **STALE (the correctness fix)** — a corpse (broker pid alive, `claudePid` a guaranteed-dead pid,
  `state:'exited'`) planted for a real on-disk session: 4/4 post-fix — the send is NOT blocked, a REAL
  turn starts and completes, the "still finishing" text never appears, and the corpse's files are
  swept from disk. **PRE-FIX (index.ts + survival.ts stashed): 1/4** — reproduces the live incident
  exactly (refused, message stuck in composer, corpse never swept).
- **FRAMELESS** — BUG-033's timer backstop (CodexRuntime HANG fixture), driven through the REAL DOM
  (not just the raw WS event `verify-zombie-busy.mjs` scenario D already asserted): 7/7 — visible
  message, text kept, composer enabled, and a retry with a non-hanging prompt sends and completes.
- **Combined: 16/16 post-fix; 13/16 pre-fix** (only the STALE scenario's 3 checks fail pre-fix — the
  ALIVE/FRAMELESS visibility checks pass either way, confirming the audit finding above).
- Screenshots: `docs/bugs/assets/BUG-038-alive-refusal-visible.png`,
  `BUG-038-alive-retry-sent.png`, `BUG-038-stale-not-blocked.png`,
  `BUG-038-frameless-refusal-visible.png`, `BUG-038-frameless-retry-sent.png`.

**Anti-regressions.** `npm run typecheck` — PASS. `node --check public/app.js` — PASS (app.js was
NOT modified — the visibility audit found nothing to fix there). `verify:resume-refusal` — 4/5,
the SAME pre-existing "phantom optimistic bubble" failure BUG-033's own activity log already
documented and confirmed byte-identical at baseline (unrelated to this fix; the message-kept,
composer-released and retryable-recognised halves all pass). `verify:zombie-busy` — run in the
background; see follow-up note below for the result. `verify:ui --offline` — known RED at HEAD
(BUG-036, unrelated), not chased per the charter.

**Closing assessment.** Symptom of a deeper design flaw? **Yes** — the survivor guard and the bridge
liveness gate are two INDEPENDENT places in the same file that used to make the identical mistake:
refusing (or trusting) based on whether a state RECORD exists (a `HostStatus` file, an in-memory
bridge object) rather than on PROBED liveness of the process it claims to describe. BUG-033 fixed one
site; this ticket had to separately re-discover and fix the other, because there is no single shared
enforcement point — "does this claim have a live process behind it" is answered by two different
functions (`livenessVerdict()` for bridges, `probeSurvivorHost()` for on-disk survivors) that happen
to agree by construction, not by any invariant that would catch a THIRD future state-holder repeating
the same shortcut. Worth an ARCH-class note (not filed here — orchestrator's call) along the lines of:
"any refusal or liveness claim must go through one shared ground-truth probe, not a local `if (record
exists)` check invented per call site." The VISIBILITY half of this ticket, by contrast, was a genuine
local non-issue this time: BUG-029/033 had already wired `say()` into every branch before this ticket
was filed, and the audit found no console-only path — the user's report was accurate about a broken
composer, but the actual defect was the correctness bug above (a refusal firing when nothing was
running), not a rendering gap.

**`verify:zombie-busy` (anti-regression, full run) — 35/39.** Scenarios A-D (the BUG-033 lineage this
fix sits beside — bridge liveness gate, false-positive guard, SDK-owned child, frameless backstop):
**34/34, no regression.** Scenario **E fails 4/4**, but this is NOT caused by this fix: `E` is a
BRAND-NEW scenario added to `scripts/verify-zombie-busy.mjs` by a concurrent workstream during this
session (confirmed via `git diff 72de912 HEAD -- scripts/verify-zombie-busy.mjs` — it did not exist
when BUG-033 was verified), and it exercises `src/server/agent-bridge.ts`, a file this ticket never
touched (confirmed unchanged since `72de912` via `git diff 72de912 HEAD -- src/server/agent-bridge.ts`
— empty diff). It appears to be a genuine, pre-existing finding (a turn blocked on an unanswered
approval card gets reaped by the frameless timer instead of the card outranking it) surfaced by new
test coverage, not a regression from `probeSurvivorHost`/the survivor guard change — flagged for the
orchestrator, not chased here (out of this ticket's scope).

Note on the working tree: `src/server/index.ts` and `src/server/survival.ts` show clean against `HEAD`
because a concurrent process folded this ticket's uncommitted edits into its own commits during the
session — this agent did not run `git commit` at any point (confirmed: no `git commit` invoked).

