# Should verification move to post-ship background work?

**Date:** 2026-10-13 · **Lane:** finding/explore (round 1) · **Dispatch:** `ticket=none phase=finding round=1 class=explore`
**Question owned (user):** *"Orchard tickets often take hours, while a plain Claude CLI prompt would
implement the same request in a few minutes. Should verification/testing move to post-ship background
work, so a feature becomes available as soon as it is built?"*

**Read-only.** No product code changed, no service touched, no git write. This doc and the
measurements behind it are the only artifacts.

> **Read `docs/analysis/COST-METHOD.md` before re-quoting any figure here.** Every number in this doc
> is derived by `scripts/cost-collect.mjs` / `scripts/lib/cost-model.mjs` (FEAT-086) over the agent
> CLI's own transcripts — the three corrections in that note (per-block `usage` de-duplication,
> last-row-wins, exact-model pricing) are applied. Dollar figures are **API-equivalent estimates at
> list rates, a lower bound**, not money paid (flat subscription).

---

## 0. Method and N

- **Primary tool:** `npm run cost:collect -- --report-only` (and `--json`), FEAT-086. It derives
  wall-clock, tokens, phases, rounds and verdicts from transcripts under `~/.claude/projects/`; it
  needs no one to "log" anything and works retroactively. Lifecycle phase / ticket / round / class
  come from FEAT-100 `Dispatch:` declarations where present, and are reported as `undeclared`
  otherwise (never guessed).
- **Independent-verification verdicts:** `docs/bugs/verification-ledger.json` (97 typed clean-room
  entries) plus the per-ticket Activity logs in `docs/bugs/*.md`.
- **N:** the cost ledger covers **2122 lanes**; **318 tickets** (BUG/FEAT/ARCH) carry lane data. The
  board holds **424 tickets (273 done, 151 open, 26 needs-you)**. The defect-severity classification
  (§3) read **23 tickets** in full — every ticket with an independent-verification BROKEN verdict in
  the ledger.
- **Known floor:** transcript-derived cost is ~5% low per session (one untranscribed title request);
  per-session, not per-token. Round/phase attribution is derived, so treat single-lane figures as
  indicative and aggregates as sound.
- **Prior art reused:** `docs/analysis/counterfactual-2026-08-20-minimum-path.md` ("five hours a
  ticket is true of two tickets and false of the median"), `defect-origin-2026-08-20.md`,
  `inline-vs-dispatch-crossover-2026-08-20.md` ("93.2% of orchestrator spend buys nothing — context
  re-read").

---

## 1. Where the wall-clock actually goes

### 1a. Agent-time by tool-phase (accounted 445.9 h of 3299.2 h wall)

| Phase | hours | share | what it is |
|---|---:|---:|---|
| investigating | 149.6 | 33.5% | reading code / understanding the problem |
| blocked_on_lane | 104.5 | 23.4% | a dispatching lane waiting on its dispatched lanes |
| testing | 60.5 | 13.6% | running tests / self-verification |
| conversing | 58.1 | 13.0% | dialogue (user / orchestrator) |
| **building** | **39.2** | **8.8%** | **actually editing code** |
| bookkeeping | 19.7 | 4.4% | board, tickets, commits |
| orienting | 5.0 | 1.1% | — |
| other | 9.4 | 2.1% | — |

### 1b. Wall-clock vs engaged time

| measure | value |
|---|---:|
| wall-clock span | 3299.2 h |
| accounted agent-time | 445.9 h |
| **idle / suspend gap** | **2853.3 h (86% of wall)** |
| dispatch occupancy (≥1 dispatch outstanding ÷ engaged wall) | 80.3% |
| **dispatch parallelism** (summed wait ÷ union) | **1.12× (≈ serial)** |

**86% of the wall-clock a ticket occupies is idle** — overnight, between rounds, waiting on a human
or an orchestrator turn. When work *is* running, it runs almost strictly serially (1.12×).

### 1c. Rounds and re-work

| measure | value |
|---|---:|
| rounds per ticket | **median 2**, mean 3.92 |
| mean skewed by adversarial tickets | ARCH-013 50, ARCH-017 44, ARCH-003 42, FEAT-091 30 rounds |
| tickets needing ≥2 rounds | 212 / 318 (67%) |
| tickets needing ≥4 / ≥7 / ≥11 rounds | 92 / 45 / 26 |
| **cost in round 1 vs rounds 2+** | **44% vs 56%** |
| BROKEN verdicts round 1 vs rounds 2+ | **59 vs 195** (of 254) |
| round-tagged lanes round 1 vs rounds 2+ | 591 vs 888 |

### 1d. Lifecycle phase (FEAT-100 declared lanes only; coverage ~32%)

| lifecycle | lanes | agent-h |
|---|---:|---:|
| finding | 132 | 10.2 |
| fixing | 303 | 103.9 |
| verifying | 251 | 43.2 |
| undeclared | 1436 | 288.5 |

---

## 2. The hypothesis, tested

> *Hypothesis (a guess in the charter): most of the hours are serial verification rounds and waiting,
> not the first build.*

**Confirmed on "not the first build"; refined on "verification".**

- The **first build is cheap**: code-editing is 8.8% of agent-time. (Caveat — see §4(c): 8.8% is
  editing across *all* rounds, and the first delivery also rides the 33.5% investigation that
  precedes editing, so "the first build is cheap" must not be read as "shipping after build is
  cheap".)
- **Waiting dominates wall-clock**: 86% idle + near-serial scheduling. This is the real "hours vs
  minutes" gap, and it is *not compute*.
- **But "serial verification rounds" is only part of the re-work.** The single biggest agent-phase is
  **investigating (33.5%)** — understanding the code/problem — not verifying. Self-**testing** is
  13.6%; dedicated **verifying** lanes are 43.2 h of declared time. Re-work is real (56% of cost in
  rounds 2+, 195/254 BROKEN verdicts there), but the hours are comprehension + waiting at least as
  much as verification.

---

## 3. The key sub-question: what would have shipped?

*Of the defects independent (clean-room / cross-provider OpenAI / second-account) verification caught
**after the build's own suite was green**, how many would have reached the user if the feature had
shipped right after build — by severity?*

Classified across the **23 tickets** with an independent-verification BROKEN verdict (full Activity
logs read). **~81 distinct defects**, every one past a green self-authored suite:

| Severity | Count | Representative catch (green self-suite missed it) |
|---|---:|---|
| **DATA-LOSS** | **16** | BUG-250 scratch-sweep deletes live/external data; FEAT-126 torn-read wipes cross-session bindings; FEAT-129 lock-reaper clobbers uncommitted work; FEAT-145 store-isolation guard disarms on first-run; BUG-215 memory move empties a session's dir |
| **SECURITY** | **9** | BUG-186 "clean-room" leaks the answers to the verifier; BUG-226 enforcement gate actually permits arbitrary file reads; FEAT-096 confinement profile bypassable + unenforced for OpenAI |
| **CRASH** | **8** | FEAT-160 resume fatally refused / session stranded; FEAT-161 countdown floods /api/usage (~3722 req/4s); BUG-182 silent EISDIR |
| **WRONG-STATE-SHOWN** | **45** | FEAT-091/BUG-201 hide authored reader-facing answers in a closed fold; FEAT-160 account switch mis-bills the wrong subscription; BUG-193 fold hides 130 real human sessions; FEAT-126 view disagrees with the board |
| **COSMETIC** | **3** | BUG-250 orphaned `.trash-*` leak; ARCH-016 cost optimisation silently does not apply |

**Would-have-shipped-to-user:** a large majority **YES** — in every one of these tickets the
originating lane's own suite was green and would have released the defect. A minority were **UNCLEAR**
(exotic markdown shapes in FEAT-091/BUG-201 reachable only by unusual input; a few timing-dependent
races) and a few **NO** (edge findings where the core guarantee held, or defects introduced by later
shared-file drift not present at first build).

**The load-bearing finding: 33 data-loss / security / crash defects, plus 45 wrong-state-shown, were
invisible to the build's own green suite and caught only by independent verification.** This is a
direct measurement of the harm that "ship right after build" would release.

**Selection note (honest):** these 23 are exactly the tickets that *drew* adversarial verification —
the risky, many-round ones. The 81-defect rate therefore **cannot** be generalised to the pure-UI /
trivial population, for which we have **no measured miss-rate at all**. This cuts against any
proposal to declare a class "safe to defer" (see §4e).

---

## 4. Recommendation — as drafted, then refuted

The draft recommendation was: **(1)** keep pre-ship independent verification mandatory for
data-loss/security/crash; **(2)** gate by harm class — ship pure-UI / cosmetic-or-wrong-state-only
work after build with post-ship verify; **(3)** the real sink is serial rework + near-serial
scheduling + idle, so parallelise verification and front-load a property corpus rather than deferring
verification.

### Refutation (independent skeptic)

**Provider / run:** OpenAI dispatch was **unavailable** this session (`node
src/server/dispatch-client.mjs --check` → `openai dispatch: unavailable · broker socket cannot be
reached`). Per the standing "OpenAI unavailable → use Claude" rule, the refutation was run as a
**fresh-context Claude Opus agent** (model `opus`, agent id **`a895aa539392e7879`**, 2026-10-13). It
reproduced the headline numbers before attacking.

**Outcome: Point 1 survives. Point 2 fails. Point 3 is self-contradictory and was re-ranked.**

- **Point 2 fails — the harm-class gate is circular.** To route a feature you must know its worst
  credible failure *in advance*; but the whole basis of Point 1 is that green self-suites
  *systematically misjudge their own worst case* (FEAT-126 presented as a UI view and hid a
  store-wipe; BUG-193 presented as cosmetic nav-folding and hid 130 real human sessions). The
  classification the gate needs **is the output of the verification the gate exempts.** And a
  builder self-classifying its own harm class is exactly **ARCH-011** ("whoever does the work chooses
  the check that passes it") — a defect this repo already ticketed.
- **The WRONG-STATE-SHOWN exemption is indefensible.** It is the *largest* catch class (45 of 81),
  and BUG-193 — a user who cannot see 130 of their own sessions — is a wrong-state defect with
  data-loss-grade consequence. You cannot cite 45 wrong-state catches as proof verification is
  valuable and simultaneously call that class safe to defer.
- **Point 3 fights the wrong number.** Idle is 86% of wall; parallelising verification acts only on
  the ~3% of wall that is engaged verification time. It is a **cost** optimisation mislabelled as a
  **latency** one. Running verify *concurrently* with build also verifies a moving target. And 8.8%
  "cheap build" is misread: it is editing across all rounds, and since 195/254 BROKEN verdicts land
  in rounds 2+, **the round-1 artifact is the one that fails ~2-in-3** — ship-after-build ships
  precisely the pre-rework version, and a user-facing regression + rollback costs *more* than a
  pre-ship round, not less.
- **What the skeptic kept:** Point 1 is sound and conservative. And one piece of Point 3 is
  genuinely good — **front-loading an adversarial property/differential corpus** so a defect class is
  not rediscovered across 11 serial rounds (FEAT-091 absorbed ~11 consecutive BROKEN verdicts on the
  *same* hidden-content class via new input shapes).

---

## 5. Recommendation — the version that survived

**Answer to the user's question: No — do not move verification to post-ship background so a feature
ships as soon as it is built.** Two independent reasons, both measured here:

1. **It would ship the broken artifact.** The round-1 build fails roughly two-in-three (195 of 254
   BROKEN verdicts are in rounds 2+), and independent verification caught **33 data-loss/security/
   crash + 45 wrong-state defects that the build's own green suite missed.** Deferring verification
   releases exactly those.
2. **It would not fix the complaint.** Verification is not where the hours go. Self-testing is 13.6%
   of agent-time (~2% of wall-clock); 86% of wall-clock is idle/human-round-trip, and engaged work is
   near-serial (1.12×). Deleting *all* post-build testing cannot turn hours into minutes, because the
   hours are round-count and waiting, not verification compute.

**What to do instead (ranked by leverage on the user's actual latency):**

- **(A) Cut round count.** Front-load an adversarial **property / differential corpus** at build time
  so a defect *class* is proven once rather than rediscovered across many serial rounds (the FEAT-091
  / BUG-201 / ARCH-013 long tail). This is the one deferral-adjacent idea that survived and attacks
  the 56%-of-cost rounds-2+ mass directly.
- **(B) Cut human-wait / idle between rounds.** Standing authorization to re-dispatch without stopping
  to ask, and the existing round-ceiling escalation (FEAT-148 `arch:rounds` / round-ceiling) so a
  ticket does not silently absorb 11+ rounds. This attacks the 86%-idle mass.
- **(C) Parallelise the adversarial attack *within* a round** (fan out angles at once) — a real but
  secondary win; it lowers cost and a lane's per-round wall, not the dominant idle.
- **(D) If harm-class routing is used at all, the triage must itself be a cheap *independent*
  pre-ship pass, never the builder's self-classification** (avoids the ARCH-011 circularity). Because
  that triage is itself pre-ship independent work, the time "saved" by deferring is small — which is
  why (A)/(B) beat it.

### Concrete changes that would implement this

- **Tooling:** extend `scripts/independent-verify.mjs` with a reusable **property/differential corpus
  runner** for renderer/parser/store classes (generalise the FEAT-091 fold corpus and the FEAT-129
  mutation-classifier corpus so new input shapes are enumerated once, up front).
- **Round governance:** wire `scripts/round-ceiling.mjs` (FEAT-148) into the dispatch loop so
  rounds-2+ escalate to the orchestrator with the declared round count, rather than re-dispatching
  silently.
- **Routing (if adopted):** a `class=triage` dispatch class in `scripts/lib/cost-model.mjs` /
  `scripts/dispatch.mjs` for the independent pre-ship harm-class pass — explicitly *not* builder-run.
- **Working Agreement:** record that independent pre-ship verification stays mandatory for
  data-persistence / security-enforcement / billing / session-lifecycle changes (the clusters in §3),
  and that "my own green suite" is never the last word for those classes (already WA §C spirit;
  make it a named gate).
- **Docs:** this file; cross-link `docs/analysis/counterfactual-2026-08-20-minimum-path.md` and
  `COST-METHOD.md`.

---

## 6. Data provenance

- `npm run cost:collect -- --report-only` and `--json` (FEAT-086) — 2026-10-13, 2122 lanes.
- `docs/bugs/verification-ledger.json` — 97 entries, 30 tickets, 68 broken / 24 holds / 5 invalid.
- `node scripts/board-status.mjs` — 424 tickets (273 done).
- Severity classification: three Explore lanes read 23 tickets' full Activity logs (2026-10-13).
- Refutation: fresh-context Claude Opus skeptic, agent id `a895aa539392e7879` (OpenAI dispatch
  unavailable this session).

---

## 7. Cross-provider refutation (OpenAI) — appended 2026-10-13

The §4 refutation was Claude-only; the standing rule is that a recommendation must survive
**cross-provider** refutation before it is acted on. OpenAI dispatch was **available** this session
(`node src/server/dispatch-client.mjs --check` → `openai dispatch: available`), so a fresh-context
OpenAI skeptic was given the §1–§3 data tables and the §5 surviving recommendation (never the Claude
skeptic's verdict) and asked to BREAK both the recommendation and the method.

**Provider / run:** OpenAI (Codex), dispatch run / session id **`01a13647-a591-7932-8da6-1de03743628a`**,
2026-10-13. Prompt via `--prompt-stdin`; meta `/tmp/refute-meta.json` (exit 0).

**Verdicts (OpenAI's own words):**

- **Point 1 (keep pre-ship independent verification mandatory for high-consequence classes):
  WEAKENED-BUT-HOLDS.** "Mandatory pre-ship verification for credibly high-consequence changes is a
  defensible precaution; these data do not establish its optimal scope or justify extending it to
  every ticket." This is exactly the WA's *existing* scoped shape (§I harm-class rounds table gives
  silent-loss/false-proof/irreversible nonzero cross-provider rounds and contained-render /
  test-only / trivial / docs **zero**). OpenAI's one caveat — do not extend to every ticket — is a
  rule the WA already honours. **Survives; already encoded in the WA; no change needed.**
- **Point 2 (reject a harm-class ship-after-build gate as circular): FAILS.** "Builder
  self-classification is suspect, but two counterexamples do not make all prospective risk routing
  circular or ineffective." The blanket rejection over-claims: a routing pass can inspect observable
  change properties (write capabilities, migrations, authorization boundaries, session storage,
  reachable effects) without knowing every eventual defect. **This does not license building a gate**
  — OpenAI's prescription is to *prospectively evaluate* a risk-based gate with randomized audits of
  the exempt population, measuring severe-defect escapes alongside total delivery time. That is a
  project-direction fork → filed as a **decision**, not a build.
- **Point 3 (ranked latency levers A–D): FAILS as a demonstrated package.** "A–D remain hypotheses,
  with meaningful failure modes." Specifically: the **property/differential corpus** is "a reasonable
  experiment, not the established leading lever" (backfire modes: longer round 1, maintenance/flaky
  cost, shared blind spots between impl and oracle, builders optimizing to a known corpus, fewer
  *reported* rounds with no latency drop); a **round ceiling** is "a notification policy masquerading
  as a latency intervention" unless escalation carries a named owner, a response commitment, and an
  actionable decision. The method is also softer than claimed: accounted agent-time is ~13.5% of
  wall, the 86% "idle" is not shown to be removable human-wait, the "~81 defects" lack a dedup rule
  and blinded adjudication, derived phases are a proxy for purpose, and 1.12× supports low concurrency
  but not its cause.

**OpenAI's single kept change:** "replace the blanket rejection of risk routing with a prospectively
evaluated risk-based gate that randomly audits exemptions and measures severe-defect escapes
alongside total delivery time."

### What this changes vs the Claude-only §5

- **Point 1 is confirmed cross-provider and is already in the WA** — so the WA needs **no change**
  (the §4-draft "make it a named gate" would be §L-forbidden stacking; §I already names it).
- **Point 3's tooling is downgraded from "levers" to "experiments."** The user's rule is not to ACT
  on a recommendation that did not survive cross-provider refutation. The corpus runner and the
  round-ceiling wiring therefore ship as **filed plans with a built-in measurement gate**, not as
  faith builds — each plan must prove itself against completion-time + escaped-defect measurement
  before being relied on.
- **Point 2's rejection failed on both providers' probing** → the risk-routing question is **open**
  and filed as a human **decision** (a `class=triage` build follows only a YES), never built now.

### Tickets filed from this (see board)

- **FEAT-182 (decision, 👤):** keep the uniform harm-class verify rule, or pilot a
  prospectively-evaluated risk-based verification-routing gate with randomized exemption audits?
  (OpenAI's surviving attack on Point 2; recommend A — keep uniform, pilot not yet justified.)
- **FEAT-180 (plan):** reusable property/differential corpus runner in `independent-verify.mjs`, with
  a measurement gate (corpus vs current practice: completion time, labor, escaped defects) — not
  relied on until it clears that bar.
- **FEAT-181 (plan):** wire `round-ceiling.mjs` (FEAT-148) into the dispatch/board surface so
  rounds-2+ auto-escalate with the declared round count AND an actionable §N decision (rescope /
  redesign / stop), addressing OpenAI's "notification theatre" failure mode.

### Working Agreement: no change needed (hypothesis confirmed)

The §4-draft "make it a named gate" would be §L-forbidden stacking. The WA **already** mandates
pre-ship independent verification for exactly the §3 harm classes and already sets contained work to
zero rounds:
- **§I "Rounds are spent by HARM CLASS"** table: *silent loss* (relay/parser/migration/renderer) →
  rounds until only wording/cosmetics remain; *false proof* → ≥1 cross-provider, highest priority;
  *irreversible/project-wide* → 1 scoped to byte identity/refusal/recovery; and *contained
  render / test-suite-only / trivial / docs* → **zero**.
- **§I "Generation must not verify itself"** — the full clean-room, executed-evidence,
  fixer≠verifier, cross-provider-by-default contract.
- **§C** ("distrust your own green checkmarks") and **§N** (high-stakes = stateful/concurrent/
  reload/data-loss gets the adversarial refute pass).

OpenAI's one caveat on Point 1 — *do not extend mandatory verification to every ticket* — is a rule
the WA already honours via the zero-round classes. So the gains are in tooling (filed above), not in
the WA text.
