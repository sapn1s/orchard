# ARCH-001 — no single authority answers "is this thing alive?", so every call site re-decides

- **Status:** DONE (2026-08-13) — OPTION 1 chosen by the user; **PHASE 1 (server-side authority + conformance
  gate) BUILT & VERIFIED** 2026-08-09; **PHASE 2 (client renders the server-authored snapshot =
  BUG-034, with FEAT-057 filling the `ended` slot) BUILT & VERIFIED** 2026-08-10 — see the
  2026-08-10 entry and the full write-ups in BUG-034 / FEAT-057. Remaining: the proof bar's last
  line — no NEW liveness check can be added on the CLIENT (the R-D guard covers `src/server/**`
  only).
- **Raised by:** BUG-038's closing assessment (2026-08-09), corroborated by FEAT-056's detector
  clusters `[agent+live+bridge]` (BUG-020/030/033/034) and `[path+honesty+message]` (BUG-028/029/038)
- **Area:** session/agent liveness — server truth model

## Violated invariant
**There must be exactly one authority that answers "is X alive / mid-turn right now", and every
decision that depends on that answer must consult it.** Today at least four call sites answer it
independently: `livenessVerdict()` (in-memory bridges, BUG-033), `probeSurvivorHost()` (survivor
records, BUG-038), mtime liveness in `watcher.ts` (30s window), and the client's own union of
event fragments + live-bridge override (`app.js`). They agree only by construction, never by
enforcement.

## The design that produces the class
Each new surface that needed liveness grew its own check next to itself, because there was no
seam to call. Consequences observed, not theorised:
- BUG-033 fixed the bridge site; the IDENTICAL mistake survived at the survivor site and had to be
  rediscovered by BUG-038 days later ("record exists" mistaken for "alive").
- BUG-004/017/020/030/033/034: six tickets where a surface asserted running/not-running from a
  partial signal — phantom rows, missing rows, forever-◐, zombie busy, fake timers.
- BUG-029/038: the send path made refusal decisions from unverified state.
- The client can hold a picture the server denies until a manual reload (BUG-034 evidence).

## Options (trade-offs, decide before building)
1. **One server-side liveness service** — a single module owning probes (pid/cgroup/broker
   status/frames) and exposing `liveness(target) → {live, kind, reason, evidence}`; every
   server-side decision (reattach, refuse, reap, health, strip) calls it. Client renders a
   server-authored snapshot (BUG-034's direction) and never derives liveness itself.
   *Cost:* touches many call sites; needs careful sequencing with in-flight work.
2. **Keep local checks, add a conformance test** — one test asserting all sites agree on a matrix
   of synthetic states. Cheaper, but the sites still drift between test runs; catches, not prevents.
3. **Do nothing** — accept recurrence. Explicitly listed so the cost is stated, not defaulted into:
   the class has produced 8+ tickets and at least one multi-day user-visible failure.

Recommendation (orchestrator): **1**, sequenced WITH BUG-034 and FEAT-057 (same structure answers
"what runs", "what ended and why"), with 2's conformance test written FIRST as the proof bar.

## Migration path (sketch — refine when scheduled)
Introduce the service alongside existing checks → convert sites one at a time, each conversion
keeping its own verify green → conformance test flips from "documents disagreement" to "enforces
agreement" → delete the local checks → client switches to snapshot rendering.

## Proof bar (what would show the new design is right)
- The conformance matrix passes for every site (no site can answer differently).
- The BUG-034 intermittency repro is green across N>=5 runs with injected event drops/delayed attach.
- A stale survivor never blocks a send; a genuinely busy one always does (both directions).
- No new liveness check can be added without going through the service (lint/test guard).

## Activity log (APPEND-ONLY)
### 2026-08-09 — orchestrator
- First ARCH ticket, filed from BUG-038's closing assessment — the FEAT-056 loop working as
  designed (fixer's structural suspicion handed forward instead of dropped) within an hour of the
  rule existing. NOT scheduled yet: it needs the user's call on option 1 vs 2.

### 2026-08-09 — build agent — PHASE 1: server-side authority + conformance gate

**Charter.** Option 1 (the user's call), with option 2's conformance test written FIRST as the
proof bar. Server side only: the client's snapshot rendering (BUG-034) and the outcome record
(FEAT-057) are explicitly NOT built here. No transport was changed. `public/app.js` and
`package.json` were not edited.

---

#### 1. THE CONFORMANCE TEST, WRITTEN AND RUN BEFORE ANY REFACTOR

`scripts/verify-liveness-conformance.mjs`. It declares the CONTRACT itself — 14 worlds × the sites
that answer them — rather than reading expectations off the implementation, so the implementation
is what has to move. Four rules:

| | Rule |
|---|---|
| **R-A** | AGREEMENT — every site answering the same question about the same world gives the same answer |
| **R-B** | NO COERCION — `unknown` is first-class; no site may report `dead` (or `alive`) where the truth is `unknown` |
| **R-C** | EVIDENCE SITES MAY NOT KILL — a site observing ONE signal (transcript mtime) may answer `alive` or `unknown`, never `dead` |
| **R-D** | NO REGROWTH — no new ad-hoc liveness check may appear outside the authority |

Two questions are kept apart on purpose, because conflating them is itself part of the class:
`process` (is a live process behind this record?) and `running` (is a turn in flight?). Each site
is judged only on the question it exists to answer.

Four layers, all real — no station internals are mocked, the inputs are real `HostStatus` files
with real live/dead pids, real file mtimes, and real servers:
- **L1** the matrix, in-process against the real exports (scratch `CLAUDE_STATION_DATA` +
  `CLAUDE_PROJECTS_DIR`).
- **L2a** a scratch server + planted survivor records → what `/api/health` (and therefore `doctor`)
  says. Records are planted AFTER boot on purpose: boot's `adoptSurvivingHosts` SIGTERMs every
  broker it finds, so a pre-boot fixture would test nothing.
- **L2b** a scratch server + a REAL bridge on the CodexRuntime fixture seam — a real turn that goes
  silent (no API cost, no pid to check) → `/api/health`, `/api/sessions`, `/api/sessions/live`.
- **L3** both directions of the send guard; **L4** the regrowth guard.

**RECORDED PRE-REFACTOR DISAGREEMENTS (`--record`, run against HEAD before a line was changed).
16 in total. These are the honest evidence this ticket exists — and the headline one is that
BUG-038's bug was STILL LIVE at a third site.**

| # | Where | What it answered | What ground truth said |
|---|---|---|---|
| 1–2 | `scanSurvivingHosts()` (L1 W03, W04) | `alive` — a record whose CLI pid is gone, and a record whose broker itself wrote `state:'exited'`, both stayed in the list | `dead` (`probeSurvivorHost`) |
| 3–4 | `/api/health` survivor rows (L2a, live server) | `state:'surviving-unadopted'` for BOTH corpses — which `doctor` renders as **"SURVIVED a restart (broker + CLI alive … turn draining)"** | `dead` |
| 5 | `/api/health` session row (L2b, past the window) | `state:'busy'` | its OWN `liveness.live:false` **in the same payload** |
| 6–7 | `/api/sessions` `busy` and `/api/sessions/live` `busy` (L2b) | `true` | `liveness.live:false` — a zombie read as running until the reaper's next sweep (up to `REAP_SWEEP_MS`) |
| 8–14 | `watcher.isSessionLive()` (L1 W02/W04/W05/W08/W09/W11/W14) | `false`, i.e. indistinguishable from `dead`, including for a bridge whose CLI was **verified alive** and merely 20 min into one silent tool call | `alive` or `unknown` — never `dead` |
| 15 | `SurvivalHandle.probe()` (L1 W11/W12) | **UNREACHABLE** — it lived in a closure only a real `systemd-run` spawn creates, so no test could ever call it. A site that cannot be tested is a site that drifts silently. | — |
| 16 | the regrowth guard (L4) | seven ad-hoc checks scattered across `agent-bridge.ts`, `index.ts`, `survival.ts` | — |

**Where they already AGREED, stated plainly rather than dressed up as findings:** `livenessVerdict()`
was correct on every one of its rows (W01–W10) — BUG-033's ordering needed no repair, only a home;
`probeSurvivorHost()` was correct on every survivor row; and **L3 passed 5/5 at HEAD** — BUG-038's
send guard already refused a live survivor and let a stale one through. The defect was never in the
two probes. It was that everything ELSE answered the question on its own.

---

#### 2. THE AUTHORITY — `src/server/liveness.ts` (new)

**Contract.** One entry point, `liveness(target, now?)`, over four targets — `bridge`, `survivor`,
`survival-handle`, `transcript` — plus named aliases each site calls (`livenessOfBridge`,
`livenessOfSurvivor`, `livenessOfSurvivalHandle`, `transcriptLiveness`). It returns:

```
{ state, running, live, kind, reason, evidence, since, ended? }
```

Three answers, deliberately separate, because collapsing them is the class:
- **`state`** — GROUND TRUTH: `'alive' | 'dead' | 'unknown'`. Never coerced. Reading `unknown` as
  dead reaps live turns; reading it as alive is the zombie.
- **`running`** — THE CLAIM: is a turn in flight right now?
- **`live`** — THE DECISION: may this claim keep standing? Deliberately NOT `state === 'alive'`: an
  `unknown` inside the frameless window stays standing (never reap on silence alone), an `unknown`
  past it does not — but stays `unknown`, which is what tells the caller to REFUSE rather than race
  a second CLI onto a transcript it cannot prove is finished (BUG-022).

`evidence` carries what was actually CHECKED (source, the probe's own rung answer, broker/CLI pids,
broker state, silence, windows) — it is what makes a refusal quotable ("broker pid N and CLI pid M
are alive") instead of an assertion. `since` is the turn start / broker start / last write.

It subsumes both existing probes without weakening either. BUG-033's ordering is preserved exactly
— dead → dead now, no window; alive → LIVE however silent (the false-positive guard); unknown →
frameless backstop, last — and BUG-038's cold-disk survivor rungs are the same code the live
transport rung now calls. `FRAMELESS_MS` / `REAP_SWEEP_MS` / `LIVE_WINDOW_MS` moved here with the
rungs that use them; the env var names are unchanged. `FRAMELESS_MS <= 0` disabling only the timer
half is now expressed in the authority, so no caller re-checks it.

**FEAT-057 hook (designed, NOT built).** `ended?: {at, kind, detail}` rides the same structure that
answers "what is running", because building the two separately is what created the split-brain in
the first place. It is populated only where the authority actually has evidence — a broker that
recorded its CLI's exit — and its `kind` stays `'unknown'` there on purpose: an exit code says the
PROCESS ended, not that the TURN completed (§C). FEAT-057 fills the richer kinds + `providerError`
from frames the server already receives; nothing here guesses.

`transcriptLiveness` is the substantive correction to the mtime site: a fresh mtime proves something
appended; a stale one proves NOTHING, so it answers `alive` or `unknown` and never `dead`.

---

#### 3. SITE-BY-SITE CONVERSION

| # | Site | Before | After |
|---|---|---|---|
| 1 | `survival.ts` `SurvivalHandle.probe()` | its own 4 rungs, half duplicated in `probeSurvivorHost` | one-line delegation to `livenessOfSurvivalHandle`; new `livenessNow()` exposes the unreduced verdict, so the site is now TESTABLE (disagreement #15) |
| 2 | `survival.ts` `probeSurvivorHost()` + local `pidAlive()` | a second implementation of the same rungs | **deleted**; callers use `livenessOfSurvivor` / the authority's single `pidAlive` |
| 3 | `survival.ts` `scanSurvivingHosts()` | `pidAlive(hostPid)` and nothing else | asks the authority; a proven-dead record is disposed of, not reported (**fixes #1–4**) — see the self-review note below for the leak this nearly introduced |
| 4 | `agent-bridge.ts` `livenessVerdict()` | the rungs + the window inline | one-line delegation to `livenessOfBridge`; `sweepZombieSessions` no longer re-checks the window |
| 5 | `agent-bridge.ts` `FRAMELESS_MS`/`REAP_SWEEP_MS` | declared here, imported by `index.ts` | moved to the authority; the boot log now calls `livenessWindowsSummary()` so no caller names a window |
| 6 | `watcher.ts` `isSessionLive()` + the `liveSessions()` listing | two hand-rolled mtime windows | both ask `transcriptLiveness`; watcher holds no window of its own (**fixes #8–14**) |
| 7 | `index.ts` `/api/health` session rows | `state` from raw `busy`/`detached` | `sessionStateLabel(s, verdict)` — new honest `'not-running'` label; full verdict via `livenessWire`; the raw flag survives as `busyClaimed`, named as the claim it is (**fixes #5**) |
| 8 | `index.ts` `/api/health` survivor rows | existence of a record = "turn draining" | carries the authority's verdict; corpses no longer reach the list at all (**fixes #3–4**) |
| 9 | `index.ts` `/api/sessions` | `busy: s.busy` raw | `busy: s.busy && v.live` + `liveness` (**fixes #6**) |
| 10 | `index.ts` `/api/sessions/live` | raw `busy`; membership = the mtime window ALONE, so a running-but-quiet session was simply ABSENT | verdict-derived `busy` + `liveness`, and every bridge the authority still vouches for is unioned in with its real file facts (**fixes #7**, and is the server-side half of BUG-034) |
| 11 | `index.ts` resume/send survivor guard | `probeSurvivorHost` | `livenessOfSurvivor`; same disposition, evidence now from the shared verdict |
| 12 | `scripts/station-doctor.mjs` | no label for a disowned bridge | renders `not-running`, the verdict line, and flags a `busyClaimed` that the verdict overrides |

**Deliberately NOT converted (phase 2 / out of charter), so the boundary is explicit:**
`public/app.js` — the client still unions `/api/sessions/live` with `/api/sessions` itself; that
union is now redundant rather than load-bearing, and replacing it with snapshot rendering is
BUG-034. The informational `busy` fields on the project-scoped event payloads
(`index.ts` ~:2001/2024/1883/1455) and the idle-session picker (~:632) still read the raw flag;
each errs safe (it skips a zombie rather than presenting it as running) and none is a user-facing
liveness claim. No transports were touched.

**Adversarial self-review — one leak this refactor NEARLY introduced, found before shipping and
fixed.** Once `scanSurvivingHosts()` started dropping proven-dead records on sight, nothing else in
the system would ever signal them again — and boot's `adoptSurvivingHosts()` used to SIGTERM every
record it found as a matter of course. So a broker whose CLI had been killed but whose OWN process
was still up (BUG-038's exact planted shape) would have had its record swept and then sat in its own
systemd scope forever: precisely the "two `claude-station-host-*` scopes alive, one live session"
leak BUG-038's evidence complained about. `dropDeadSurvivorHost()` now SIGTERMs the broker before
sweeping its files, and the scan routes through it. Re-verified after the fix: conformance
`--runs=2` 191/191, `verify:health-survivor` 14/14, `verify:hosts-cleanup` 17/17,
`verify:restart-survives` 15/15.

---

#### 4. THE REGROWTH GUARD (R-D) — what stops the class from returning

Mechanical, in the conformance verify (`--guard-only` to run alone, `--guard-root=DIR` to point it
anywhere). It scans `src/server/**` and fails on any occurrence, beyond an exact justified
allowlist, of the patterns by which somebody has ALREADY answered this question locally in this
repo:

| id | pattern | why it is a smell |
|---|---|---|
| `pid-liveness` | `process.kill(pid, 0)` | the one pid check belongs to the authority |
| `broker-verdict` | `.state === 'exited'` | the broker's verdict, read locally |
| `mtime-window` | `Date.now() - …mtimeMs` | a hand-rolled recency window |
| `frameless-window` | `FRAMELESS_MS` | the backstop applied outside the authority |
| `liveness-shaped-declaration` | `function …Alive…` / `…Liveness…` | a new function that ANSWERS the question |
| `is-live-predicate` | `function is…Live` | a new "is it live" predicate |
| `running-state-ternary` | `'detached-running'` | the running/idle label derived locally |

Comments are stripped before scanning, so a ticket reference can neither trip nor silence it. The
allowlist is COUNT-EXACT per file with a written justification, so a second occurrence in an
already-allowlisted file still fails. Current allowlist: `liveness.ts` (the authority) and
`session-host.mjs` (a standalone broker process that cannot import server modules and is the SOURCE
of the ground truth) exempt; `watcher.ts` 1 × `is-live-predicate` (`isSessionLive`, a pure
delegation); `survival.ts` 1 × `broker-verdict` (the socket-close handler needs the numeric
exitCode/signal to synthesise the transport's own exit event — an exit-CODE read, not a decision).

**Proven to fire, not assumed.** A scratch copy of `src/server` with one new ad-hoc check appended
to `registry.ts`:
```
registry.ts: pid-liveness (1 > 0) — a raw pid-liveness check … [process.kill(pid, 0)]
registry.ts: is-live-predicate (1 > 0) — a new "is it live" predicate … [function isProjectSessionLive]
```
Both patterns fired, naming file, pattern and the offending text. Against the real tree: clean.

---

#### 5. VERIFICATION

**The conformance gate, flipped from documenting disagreement to ENFORCING agreement:**
- single run — **L1 77/77 · L2a 4/4 · L2b 9/9 · L3 5/5 · L4 1/1**.
- **INTERMITTENCY (BUG-034's implication — a single green run proves nothing): `--runs=5` →
  476/476**, every run varying the observation point (randomised jitter between planting the
  fixtures and querying), so correctness cannot depend on when we happen to look.
- both directions of the send guard, every run: a stale survivor **never** blocks a send (and its
  corpse is swept), a genuinely mid-turn one **always** does — retryably, before any start ack, with
  its pids and broker state named in the refusal.
- BUG-033's false-positive guard, in the matrix (W02: CLI verified alive, 20 min silent, disk quiet
  → LIVE) and end-to-end below.

**Anti-regressions** (all real, on scratch ports/dataDirs; `:4317` never touched; killed by pid):

| verify | result |
|---|---|
| `typecheck` | PASS |
| `verify:restart-survives` | **15/15** |
| `verify:health-survivor` | 14/14 |
| `verify:restart-reconnect-race` | 10/10 |
| `verify:hosts-cleanup` | 17/17 |
| `verify:reload-live-summary` (BUG-004 lineage — the route I changed) | 10/10 |
| `verify:agent-summary` | 3/3 |
| `verify:detach` | 7/7 |
| `verify:stale-agent-cards` (BUG-030) | 12/12 |
| `verify:refusal-visible` (BUG-038's own) | 16/16 |
| `verify:zombie-busy` A–D (the BUG-033 lineage) | **34/34, no regression** |

- `verify:zombie-busy` **scenario E fails 4/4 — PRE-EXISTING and already documented**, byte-identical
  to the result BUG-038's own activity log recorded (35/39, A–D 34/34, E 4/4 red). E asserts a rung
  that has never existed: a turn blocked on an unanswered approval card is silent by construction
  and healthy, and the frameless timer reaps it. **This refactor did not cause it and did not fix
  it** (out of charter — it is a behaviour change, not a conversion). It now has an obvious home:
  one rung in `livenessOfBridge`, before the frameless backstop, fed by a pending-card count on
  `BridgeLike`. Flagged for the orchestrator, not chased here.
- `verify:resume-refusal` 4/5 — the SAME pre-existing "phantom optimistic bubble rolled back"
  failure that BUG-033's and BUG-038's activity logs both already recorded and confirmed
  byte-identical at baseline. The message-kept / composer-released / retryable-recognised halves all
  pass, so BUG-029's contract is intact.
- `verify:stale-agent-cards` first reported 4/12 with its two SETUP preconditions ("the subagent is
  genuinely running", "the outer turn is held busy") failing — i.e. the real haiku turn never got
  far enough to assert anything. Not taken on trust in either direction: run alone it is **12/12**,
  and a scratch copy of this working tree with ONLY my files reverted to HEAD (so the concurrent
  FEAT-058 `app.js` edits are held constant) is also 12/12. It was contention — that run was
  concurrent with the browser+haiku `verify:zombie-busy` suite and the 5× conformance loop.
- `verify:live` 29/1 — the failing check is transcript pagination against a 273MB **live, growing**
  user transcript, nothing to do with liveness. **Confirmed identical at HEAD** in a clean `git
  worktree` baseline. Not a regression.
- `verify:ui --offline` — known RED at HEAD (BUG-036), not chased per the charter.

**package.json entry — reported, NOT edited (per charter):**
`"verify:liveness-conformance": "node scripts/verify-liveness-conformance.mjs"`
(sub-runs: `--record` · `--runs=N` · `--layer=1|2a|2b|3|4` · `--guard-only [--guard-root=DIR]`;
full run ≈ 90s, no API cost — the only engine it drives is the Codex fixture.)

---

#### Closing assessment

**Symptom of a deeper design flaw? — this ticket IS the answer to that question, so the honest
version is: was option 1 the right call, and did phase 1 actually close the class?**

Partly, and measurably. The class was never bad probes — both probes were RIGHT on every row of the
matrix. The class was that *nothing else asked them*. That is exactly what the recorded
disagreements show: BUG-033 and BUG-038 each fixed the site they were pointed at, and the identical
mistake was **still live at a third site at the moment this ticket was picked up** — `/api/health`
and `doctor` presenting a corpse as "SURVIVED a restart … turn draining", which is verbatim the
symptom BUG-038's user reported and which BUG-038 fixed only on the send path. A fourth ticket for
that site was already inevitable. It will not be filed now, and more to the point a FIFTH site
cannot be added quietly: the guard fails the build when one appears.

What phase 1 does NOT close, stated so it is not mistaken for done: the client still derives its own
picture (BUG-034), so a tab can still hold a running row the server denies until a poll corrects it
— the server now publishes a verdict on every route it needs, which is the precondition for that
fix, not the fix. And FEAT-057's `ended` slot is a designed hole, not a filled one.

The one thing I would flag as a residual design risk: `live` and `state` are two fields that a
careless caller can conflate exactly as the old code did (`if (!v.live)` reads naturally as "it is
dead"). The guard cannot catch that — it is a grep, not a type checker. If it recurs, the fix is to
make the wire type unusable without discriminating (`{kind:'dead',…} | {kind:'unknown',…}`), at the
cost of churn at every call site. Recorded rather than pre-emptively built.

**Handoff.** `src/server/index.ts` is SHARED with an in-flight FEAT-058 workstream (ticket dashboard
routes, `src/server/tickets.ts`, `public/app.js`) whose edits are uncommitted in this tree —
serialize commits. Nothing was committed by this agent. `public/app.js` and `package.json` untouched.

### 2026-08-10 — build agent — PHASE 2 landed (pointer entry; the detail lives in the two tickets)

Phase 2 built as BUG-034 + FEAT-057 together, because "what is running" and "what ended and why"
are one structure — splitting them is the split-brain this ticket exists to end.

- **New:** `src/server/running-set.ts` (the snapshot: derived from `livenessOfBridge`, implements
  NO rung of its own) and `src/server/outcomes.ts` (the bounded, persisted death ledger). The
  `ended` slot designed in phase 1 is now filled — from `BridgeLike.lastProviderError`, i.e. a
  frame the RUNTIME classified, never from a bare exit.
- **Transport:** a `running-snapshot` StationEvent pushed on change + `GET
  /api/sessions/:id/running`; a session this server does not drive answers with an EMPTY snapshot,
  never a 404. `public/app.js` renders it and reconciles in place; it no longer derives liveness.
- **Proof bar, against the four lines this ticket set:** conformance matrix 96/96 with the R-D
  regrowth guard clean (no new liveness check appeared anywhere in `src/server/**`); the BUG-034
  intermittency repro **green across 5 runs with injected event drops + delayed attach (47/47,
  twice)**, 7/19 at HEAD; both send-guard directions unchanged (`verify:refusal-visible` 16/16).
- **The one line of the proof bar phase 2 does NOT close, stated plainly:** "no new liveness check
  can be added without going through the service" is enforced for the server only. `public/app.js`
  still holds `state.agents`, which is no longer an authority but is the same kind of accumulated
  structure; nothing mechanical stops a future change from rendering it on the strip again. If this
  class recurs, that is where it will come from, and the fix is extending the guard to `public/`.

### 2026-08-13 — board reconciliation (status closed)
- Both phases are BUILT & VERIFIED (phase 1 2026-08-09; phase 2 = BUG-034 + FEAT-057, both VERIFIED
  2026-08-10) and deployed (pid 1162138 runs the latest code). The class is closed for the server
  and the R-D regrowth guard prevents a fifth site. Status header relabeled OPEN→DONE so board:gen
  moves this ARCH ticket out of the Open/queued list (it was inflating the FEAT-067 queued count).
- The ONE residual is documented above and is a RISK, not open work: the regrowth guard covers
  `src/server/**` only, so a future `public/app.js` change could re-derive liveness client-side. That
  is a watch item — if it recurs, arch-watch will re-raise it as a fresh cluster — not a reason to
  keep this decision ticket parked. Extending the guard to `public/` can be filed as its own ticket
  if/when warranted.
