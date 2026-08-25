# Design A — the orchestrator as a router with no read path and no prose channel

**Date:** 2026-08-20 · **Status:** proposal, nothing built, no code changed.
**Question:** what should the orchestrator role be, architecturally, so that it only
orchestrates and relays — and can run on a cheap model?

Written independently of the parallel designer (design B). Read
`docs/analysis/COST-METHOD.md` before quoting any figure here; every number below
is either taken from a named document in this directory or computed from those
documents' own measurements, and the computed ones say so.

---

## The recommendation in one paragraph

**Remove the orchestrator's ability to read, search, run and write — leaving
`Dispatch`, `SendMessage`, `TaskStop`, a schema-bounded `Records` query, and one
`Publish` channel — and make every lane return a claim-free evidence record that
the harness re-executes to derive a verdict.** The orchestrator then has nothing
to reason about that a closed-set routing decision does not cover, its context is
bounded by construction at roughly 1.5k tokens per dispatch, and the model tier
becomes a free variable. Enforcement is `disallowedTools` on the session profile
plus a `PreToolUse` deny hook — two independent layers, both harness-executed,
neither of which the model can talk its way past. **Nothing in this design is an
instruction.**

---

## 0. What the correction changed, and what it did not

The brief originally asked me to preserve the orchestrator's sceptical read of
incoming reports. The user's correction — *"it may seem like a benefit but that
itself is architecture issue"* — is right, and it strengthens rather than breaks
this design.

I had already routed skepticism into a structural validator plus a policy-fired
re-run. The correction says go further: **do not put the sceptical read anywhere.**
A report that must be read carefully to be believed is an unverifiable artifact,
and it is exactly `defect-origin` §5 class 1a/1b — a fact that matters left to be
re-derived by its reader rather than declared and checked by its owner. That class
is 49% of every defect on this board. The orchestrator catching bad reports is not
a capability; it is the 50th instance of the project's most expensive defect,
wearing a job title.

So §3 below answers the correction's question directly — *what would a lane have
to return such that relaying it requires no judgment at all, and a false claim
fails mechanically?* — and §4 states plainly which residue is left and where it
goes. **The residue is not a reading task at any tier.** The 0-of-7 number is not
an argument for an expensive reader; it is proof that reading is the wrong
mechanism, because a real false green is internally consistent and therefore
invisible to every reader by construction.

---

## 1. The measured facts that decide this design

Four, in the order they constrain it.

**(a) The orchestrator's bill is `requests × context`, and both are controllable.**
`inline-vs-dispatch` §1: the context is re-read essentially in full on every
request (mean `cache_read` 415,792 against a mean context of 422,592 on
2026-08-20), cost per request is linear in context (+$0.55 per additional Mtok
carried), and the session ran 2,989 requests for $1,625. Cache read + cache write
are 93.2% of that bill. **The orchestrator does not have a model-tier problem; it
has a context-size problem that a tier swap would merely discount.**

**(b) The biggest single line item is the orchestrator talking.**
`pipeline-cost` "The orchestrator, turn by turn": of $164.35 across 460 turns,
**263 turns were "pure text — replying to the user, reading a report", costing
$96.29 (58.6%) and depositing 311k output tokens into its own context.** Charters
were 78 turns / $29.30 / 208k tokens. Only **3 turns** read a file and **7**
edited one. This is the fact that reframes the whole problem: in the measured
window the orchestrator's inline work was overwhelmingly *reasoning and narrating
in prose*, not tool-heavy investigation. Turn-by-turn narration is not merely a UX
annoyance the user dislikes — **it is the orchestrator's largest cost centre, and
the user's requested interaction shape deletes it.**

**(c) Dispatch is a compression boundary and it is cheap.** `inline-vs-dispatch`
§2: cold start is 11.8k tokens / $0.046 — one fifth of one orchestrator tool call;
a lane can burn 62M tokens and return 1,107. Fixed orchestrator-side cost of a
dispatch: $0.60, of which $0.45 is the two orchestrator requests, i.e. the part
this design attacks.

**(d) Reading a report cannot verify it.** WA §I, measured: 88% recall on
self-contradicting reports, **0 of 7** on reports that claimed green and were
later found BROKEN — passed with confident, specific reasoning. Meanwhile the
mechanism that *does* catch them is cheap: `pipeline-cost` measures clean-room
setup at **$0.36 per round and 16 seconds**, and 71.4% of a verification lane's
cost is the *agent attacking*, not the room. **Re-execution without an agent costs
CPU, not tokens.** That asymmetry is the load-bearing fact of §3.

---

## 2. The capability surface — what it has, and what it must not

Enforcement first, because removing the ability is the only thing shown to work.

### Allowed (five tools)

| Tool | Why it survives the deletion test |
|---|---|
| `Dispatch` (the `Agent` call) | The role. Takes `class` (closed enum), `agentType`, `model`, `paths[]` (declared write claim), and `brief` (see §2.2). |
| `SendMessage` | Course-correct a live lane. Already measured at 34 turns / $11.17 — small and load-bearing. |
| `TaskStop` | Kill a lane. Irreplaceable and cheap. |
| `Records` | **Schema-bounded query** over lane records, verdict records, board rows and ticket status. Returns validated JSON, capped at 2k tokens, never file bytes, never source. |
| `Publish` | The **only** channel whose content the user sees. Takes record ids plus at most one short human sentence (see §5). |

### Denied (everything else)

`Read`, `Write`, `Edit`, `NotebookEdit`, `Glob`, `Grep`, `Bash`, `WebFetch`,
`WebSearch`, `ToolSearch`, `Skill`, every MCP tool including all of `serena`.

**Two independent enforcement layers, neither of them an instruction:**

1. **`disallowedTools` on the session profile.** This already exists in the
   product: `src/server/registry.ts` carries `allowedTools: string[]` /
   `disallowedTools: string[]` and `permissionMode` per project, and sessions are
   launched through the Agent SDK with that profile. An "orchestrator" profile is
   a registry entry, not new machinery.
2. **A `PreToolUse` deny hook.** Proven on this machine — `~/.claude/settings.json`
   already routes every `Bash` call through a guard script. A second hook that
   denies the list above, **and logs the attempted call with its arguments**, is
   both the enforcement and the instrumentation for experiment E2 (§8).

Defence in depth matters here because the failure mode is not malice, it is
drift: an agent that can edit `settings.json` can re-grant itself tools. It
cannot, because `Write` is denied and `Bash` is denied.

### Why `Records` is not a slippery slope back to reading

The obvious attack on a zero-read orchestrator is that day one produces *"what is
the status of X?"* and the design stalls. It would. `Records` answers that class
and nothing else, and three properties keep it bounded: it returns **validated
records, not bytes**; it **cannot address source files**; its results are **size
capped**, so it cannot become a context liability the way one badly-chosen `Read`
does (measured: median orchestrator `Read` result 823 tokens, **mean 9,619** —
one such read costs ~$0.63 in tail alone, forever). The distinction that matters
is not "read vs no read" but **"reads a declared fact vs derives a fact from an
artifact that does not carry it"** — which is ARCH-010's line, applied to the
orchestrator itself.

### What visibly breaks, and where it goes

- **`git commit` / `npm run gate` (74 Bash turns, $26.42).** Lanes already commit
  their own work per the standing worker charter. Residual board bookkeeping goes
  to one batched hygiene lane per session — which `counterfactual` independently
  recommends, having found six single-line bookkeeping commits each paying a full
  dispatch's re-read.
- **Serialising lanes on a shared file.** Today this is orchestrator judgment.
  Under this design `Dispatch` requires a declared `paths[]` write claim and **the
  harness refuses an overlapping concurrent dispatch**. A judgment becomes a lock.
  This is the same medicine as ARCH-010 — declare, don't derive — and it removes
  the one genuinely hard reasoning task from the routing role, which is what makes
  the cheap tier defensible (§6).

---

## 3. The lane's return: a claim-free record the harness re-executes

This is the centre of the design and the answer to the correction.

### 3.1 The rule

> **A lane may not assert that its work is correct. It may only declare what it
> did and how to check it. The verdict is computed by re-execution, by the
> harness, with no model in the loop.**

Today a lane's final message says "done, 14/14 pass". Reading that requires
judgment, and the measured result of reading it is 0 of 7. Under this design the
lane emits:

```
ticket, class, commits[], paths[]
checks[]:   { command, expectAtHead: exitStatus, expectAtBase: exitStatus, base: <sha|synthesized> }
openItems[]: free text, but REQUIRED and non-nullable — "none" must be said explicitly
hypothesis:  { statement, outcome: confirmed | refuted | untested }
defectClass, regressedFromRound
askUser?:    { question, options[], recommendation }
```

No `status`, no `verdict`, no `state: done`. Those are **derived fields**, and the
harness derives them by running every `checks[]` entry twice — at `head` and at
the declared `base` — and comparing to the declared expectations.

### 3.2 What now fails mechanically instead of being noticed

| Failure | How it used to be caught | How it fails now |
|---|---|---|
| Report claims green, code is broken | A careful reader — **measured 0 / 7** | The check does not reproduce at head. Deterministic FAIL. |
| Vacuous proof (passes before and after) | Non-vacuity discipline, honoured unevenly | `expectAtBase` must be non-zero and **is executed**. A must-FAIL that cannot fail is a FAIL. |
| Baseline anchored to a moving reference (BUG-123, `ec58f17`) | A convention in CONVENTIONS.md | `base` is a sha or a synthesized tree; `HEAD` is rejected at declaration. |
| Number quoted from a stale snapshot | Nobody | The number is not in the record. Only commands and exit statuses are. |
| Evidence cites a command that isn't the fixer's test (`verification-ergonomics` trap 4 — one whole round lost to a trailing `#`) | A verifier noticing | Command and description are separate fields; a description can never enter the string that must match. |
| Setup smuggled in as evidence (`mkdir -p docs/prompts/patterns` accepted as "the fixer's own test") | Nothing — it is a **live** soundness hole | `setup[]` is a separate field and is not in the citable set. |
| Fixer knows an untested attack and ships anyway | Nothing — `counterfactual` calls closing this **the largest single saving with no quality cost**, and a third of independent rounds found only defects already on the fixer's own list | `openItems[]` is required, and a non-empty one **blocks the next round from being commissioned** rather than being a note for it. |

### 3.3 The honest limit

Machine re-execution catches every claim that does not reproduce. **It cannot
catch a suite that is genuinely green and tests the wrong thing** — the blind spot
that shaped the fixture, which is the whole reason WA §I requires an independent
clean-room pass. So:

- **Re-execution** — mechanical, no tokens, fires on every record.
- **Independent adversarial attack** — a lane that *generates a new attack*, not a
  reader that grades an old report. Fires by **policy on the record's `class`**
  (`fix`, `plan+review`, `arch`), never by orchestrator judgment. It already
  exists, it already works (90 BROKEN against 19 HOLDS board-wide), and it is 8.4%
  of spend.
- **Two same-class verdicts → an `arch` dispatch.** This is the plan's
  best-evidenced item; `spend-plan-review` §3(d) showed it *cannot currently be
  mechanical* because verdicts live in prose. `defectClass` on the record makes it
  mechanical, and closes ARCH-004's six-round grind at round two.

**Neither of the two live mechanisms is a reading task.** The sceptical read is
not relocated to a cheaper model, and it is not relocated to the harness. It is
deleted, and the two things it was standing in for are executed instead.

### 3.4 What this costs to build, honestly

Less than it looks, and it is mostly subtraction. The record is a strict form of
the `orchard-digest` fence that `docs/prompts/RESPONSE_FORMAT.md` already defines
and `templates.ts` already injects into every session; the grader is
`scripts/hooks/response-format-gate.mjs`, which exists at 701 lines and is
currently **advisory** — flipping it to fail-closed for lanes is the single
cheapest structural change on the table. The re-runner is the clean room, already
measured at $0.36 and 16 seconds. And the record is simultaneously gaps **G2, G3,
G8 and G9** from `pipeline-cost` Part 2 — the instrumentation that document ranks
highest and that nothing currently captures.

---

## 4. Where the charter comes from if the orchestrator cannot investigate

**Recommendation: it does not come from the orchestrator, and it should not have
been coming from the orchestrator.**

WA §I already says why: *"The orchestrator's context converges on one reading of
the problem, and the charter ENCODES that reading; the agent then executes the
framing instead of testing it."* The orchestrator's framing was never an asset.
The fix for a charter written by someone who cannot look is not to let them look —
it is to have the charter written by someone who is about to.

**The mechanism: a forwarding envelope, and framing established at the point of
work.** `Dispatch` takes the user's own words verbatim, plus the closed-enum
`class`, plus `paths[]`, plus any record ids the `Records` query surfaced. The
lane's first duty is to establish the framing itself and then branch:

- If the class holds → proceed and build.
- If it does not (the cause is not nameable, or there are two defensible
  approaches) → **stop and return a brief**; build nothing. That is `explore`,
  and the return is a record with `hypothesis.outcome: refuted`.

The cost of this is approximately zero, because **the lane orients anyway**:
measured orientation is 26% of a lane's cost at the median, **$0.81 — 3.4
orchestrator tool calls**. We are not adding a phase; we are moving the framing to
the only place that can produce it correctly, and deleting the orchestrator turn
(median 2,371 output tokens) that used to guess it.

A separate read-only `scout` lane exists for exactly one case: **one user message
that must fan out to several lanes**, where the split itself needs facts. It
returns a set of briefs and nothing else. It is not the default, because
`investigate/design` lanes measured at mean $3.87 and most messages do not need
one.

**Two things carried in the envelope that today are re-derived, per
`spend-plan-review` §3(d):** the previous round's finding *and its class*, and the
fixer's `openItems[]`. Both are now record fields, so they are injected by the
harness rather than remembered by anyone. Withheld context predictably becomes
re-derived context at a markup — measured: 83% of verification lanes hand-rolled
the synthetic base, and 29.2% of the verification pre-phase is `git log/show/diff`
working out what the change was.

---

## 5. The relay, and the interaction shape

**The orchestrator does not summarise.** `Publish` takes record ids; the client
renders the user-facing message from the records themselves — which is the surface
`orchard-digest` already provides and `public/app.js` already parses. The
orchestrator's own free text through `Publish` is capped (one or two sentences),
so it can address the user without being able to re-narrate a lane's work in
prose that then needs reading.

**The user's requirement 3 — "the next message I see is when the work is
COMPLETED" — is enforced, not requested.** Two graduated levels (WA §E), and the
first is free:

1. **Render-level (zero risk, ship first).** The client renders only
   `orchard-ask` / `orchard-outcome` from the orchestrator. Everything else
   collapses to nothing — the renderer already collapses `orchard-narration`. The
   turn-by-turn narration becomes invisible immediately, with no model change and
   no enforcement risk.
2. **Cost-level.** A `Stop` hook caps orchestrator prose outside `Publish`. This
   is where the money is: those 263 narration turns were **$96.29 and 311k tokens
   of permanent context**, and each one also *was* a request at full context
   price.

Note the interaction with WA §I / BUG-046: lanes here are background subagents
that outlive the orchestrator's turn and wake it by notification, so ending a turn
is safe. The rule is **not** "keep spinning until done" — it is "ending a turn
must not produce a user-visible message unless a record's `askUser` is populated
or every lane is terminal."

---

## 6. Model tier — and the tier as a design smell detector

The cheap-model question is second-order, and saying so is the most useful thing
in this section.

**Recomputed from `inline-vs-dispatch`'s own measurements.** The measured session:
2,989 requests × ~420k mean context. Under this design: ~2 requests per dispatch
plus user turns ≈ 1,100 requests, at a mean context bounded near 120k (per-dispatch
accretion is charter ≤400 + launch stub 271 + record ≤800 ≈ 1.5k). Cost scales
with `requests × context`:

| | requests | mean ctx | relative cost | est. window cost |
|---|---:|---:|---:|---:|
| measured, Opus tier | 2,989 | 420k | 1.00 | **$1,625** |
| this design, Opus tier | ~1,100 | ~120k | 0.105 | **~$170** |
| this design, Sonnet tier | ~1,100 | ~120k | — | **~$100** |
| this design, Haiku tier | ~1,100 | ~120k | — | **~$35** |
| *tier swap only, no restructure* | 2,989 | 420k | — | **~$325, and worse work** |

(Rates, checked not recalled: Opus 5 $5/$25 per Mtok, Sonnet 5 $3/$15, Haiku 4.5
$1/$5; cache read 0.1×, cache write 1.25× at 5-minute TTL and 2× at 1-hour.
Cache-read rate is what dominates here, so Haiku's is 5× cheaper than Opus's.)

> **Structure buys ~10×. The tier buys a further ~5×. Doing the tier first buys 5×
> and degrades the work. Do them in that order, and treat the second as optional.**

| Tier | Verdict | What breaks |
|---|---|---|
| **Haiku 4.5** | Viable *only* under this design | Its 200K context is a hard ceiling — which is a feature: it makes the context bound an enforced property rather than an aspiration. Breaks if any prose interpretation creeps back in, or if routing an ambiguous message over 6 classes proves beyond it (test: E3). |
| **Sonnet 5** | **Recommended** | Nothing measured. It handles ambiguous user messages, class selection, and when to escalate to the user. It is explicitly *not* asked to detect a false green — nobody can. |
| **Opus** | Only if the design has failed | **Use the tier requirement as a smell detector: if the orchestrator needs Opus, judgment has leaked back into the role.** That is the diagnostic, and it is worth more than the saving. |

Cost of a routing mistake is bounded and visible: one wasted lane, median $2.45,
and the lane's own hypothesis check catches a mis-framed dispatch on its first
turn. That bound is what makes downshifting safe here and unsafe elsewhere —
`spend-plan-review` §6 is right that irreversible and class-1b *lane* work must
stay on the top tier. This is a claim about the router, not about the workers.

---

## 7. What I would NOT change

Named explicitly, because a design that changes everything is not a design.

- **The independent cross-provider clean room.** It works (90 BROKEN / 19 HOLDS),
  it is 8.4% of spend, and §3.3 makes it *more* load-bearing, not less. Do not cut
  verification; that hypothesis was tested and refuted.
- **The lane's own orientation.** 26% of lane cost, and §4 puts the framing there
  deliberately. Do not "optimise" it.
- **Charters carrying a falsifiable hypothesis.** It has paid twice on record. It
  survives as a record field (`hypothesis`), which makes its omission detectable
  instead of silent.
- **The board as git-readable prose an agent can append to.** `defect-origin` §6
  intervention 7 priced the substrate change and said no. The record block rides
  on top of the prose; it does not replace it.
- **Dispatch as the unit of work.** The crossover settles it: cheaper in every
  size bucket, 4.8× at the median.
- **Cost-of-mistake tier routing for lanes.** Unchanged. §6 is about the router.
- **Shorter charters as a cost lever.** Explicitly refuted at 3.3%. The envelope
  gets shorter here as a *side effect* of not being authored by the orchestrator,
  and I claim no saving from it.

---

## 8. Experiments that would falsify this before anyone builds it

Ordered by information per dollar. Each produces a number and each has a
**pre-registered prediction**, so it can actually fail.

**E1 — The blindfold log. One config change, no code. Highest value.**
Add the deny hook in *log-only* mode for one working session: every `Read`,
`Grep`, `Bash`, `Edit` the orchestrator attempts is recorded with its arguments
and allowed through. **The log is the finding** — it enumerates exactly which
capabilities this design must replace, measured rather than imagined.
*Prediction:* the calls cluster into three buckets — board/status queries
(covered by `Records`), commit/gate bookkeeping (covered by the hygiene lane), and
file-overlap checks before dispatch (covered by declared `paths[]`). *Falsified
if* a fourth bucket appears, or if >20% of calls are genuine source investigation
that no envelope can replace — which would mean framing cannot move to the lane.

**E2 — The mute test. Zero build, one day.**
Render only `orchard-ask` / `orchard-outcome` from the orchestrator; count turns
emitted vs turns rendered, and count how many times the user had to intervene
because something was hidden. *Prediction:* >70% of orchestrator turns become
invisible with zero interventions lost (the measured window's split is 263
pure-text turns against 78 dispatches + 34 relays). *Falsified if* the user
reports losing track, which would mean the interaction shape needs a passive
progress surface rather than silence.

**E3 — Tier replay. Costs pennies.**
Take 20 real user messages from the transcript and the dispatches that actually
followed. Ask Haiku 4.5 and Sonnet 5, given only the message + board records +
the closed class enum, to produce `class`, `agentType` and `paths[]`. Grade
against what happened. *Prediction:* Sonnet ≥90%, Haiku 75–85%, and Haiku's
errors concentrate in `fix`-vs-`explore`. *Falsified if* Sonnet <85% — at which
point the routing decision is not as closed as this design claims and the whole
tier argument goes.

**E4 — Record fillability. One ticket.**
Hand-fill the §3.1 record for the last 10 closed tickets from their existing lane
reports. Count fields that **cannot** be filled from what the lane actually said.
This is `verification-ergonomics` §7's own proposed cheap test, generalised.
*Prediction:* `commits`, `paths`, `checks.command` fill from ≥8 of 10;
`expectAtBase` and `base` fill from ≤4 — because must-FAIL baselines are the thing
lanes most often leave implicit. *Falsified if* `checks` cannot be reconstructed
at all, which would mean the record is asking for something lanes do not know, and
§3 collapses.

**E5 — Re-execution yield, with a pre-registered failure.**
Take the 7 known reports that self-reported green and were later found BROKEN.
Run two graders over them: (i) a cheap model reading the report; (ii) the §3
re-executor, running each report's cited commands at head and at base.
*Prediction: the reader scores 0/7 — again — and the re-executor catches every
case whose cited evidence does not reproduce, and none of the cases where the
suite was genuinely green and aimed at the wrong thing.* Pre-registering the
partial result is the point: this experiment is designed to show the limit in
§3.3 as much as the win. *Falsified if* the re-executor also scores near zero,
which would mean false greens here are overwhelmingly the wrong-target kind and
policy-fired independent attack is the *only* remedy.

**E6 — Charter provenance A/B. Six tickets, two arms.**
Arm A: an orchestrator-written charter (today). Arm B: a forwarding envelope of
the user's own words plus class and paths. Compare rounds-to-HOLDS, total cost,
and how often the lane's hypothesis check refutes the framing. *Prediction:* arm B
is not worse on rounds and is cheaper by one orchestrator turn per dispatch; arm
B refutes the framing *more often*, because nothing pre-committed it. *Falsified
if* arm B produces more rounds — which would mean orchestrator framing is real
value and §4 is wrong.

Total cost of all six: well under one ticket's median lane spend, and E1–E3
require no code at all.

---

## 9. Alternatives, named and rejected

| Alternative | Rejected because |
|---|---|
| **Better instructions / a stricter WA §I** | Empirically failed, and the failure is on file in this directory: the spend-reduction plan's own header records it being written inline *by the orchestrator, about not working inline.* Not a proposal. |
| **A cheap model reading lane reports as a checker** | 0 of 7, and worse than nothing — WA §I: *"a clean verdict from such a checker is an active hazard."* The correction generalises this: reading is the wrong mechanism at every tier. |
| **Two orchestrators — a cheap relay plus an expensive thinker** | WA §I answers it: *"the fix is not more orchestrators in parallel (that multiplies framings with no resolver)."* The expensive one also re-acquires the context problem in full. |
| **Compact the orchestrator harder** | Treats the symptom. The measured session already compacted 7 times and hit the 1M wall in six of seven segments; the sawtooth is the shape of the problem, not the fix. |
| **Keep the tools, add a PreToolUse hook that asks "should you dispatch this?"** | An interrupt is an instruction with extra steps; a model can rationalise past it. Worth keeping as the fallback if E1 shows too many legitimate blocked calls. |
| **Cap charter length, keep the orchestrator writing them** | Refuted at 3.3% of spend, and it preserves the contaminating framing while trimming its packaging. |
| **A fully deterministic router with no model at all** | The limit case of this design, and I would take it if E3 said routing is closed enough. Rejected *for now* only because interpreting an ambiguous natural-language message is the one genuinely model-shaped step left. If E3 returns ≥95% at Haiku, revisit. |

---

## 10. What would have to be true for me to be wrong

- **If E1's deny-log shows the orchestrator's blocked calls are mostly genuine
  source investigation**, framing cannot move to the lane and §4 fails. My design
  then needs a read-only investigator lane on every message, which is a real cost
  increase I have not budgeted.
- **If E4 shows lanes cannot fill `checks[]` with an executable base**, §3's
  mechanical verdict is fiction, prose returns, and the sceptical read comes back —
  at which point the honest answer is that this project cannot yet delete it.
- **If E3 shows routing accuracy below ~85% at Sonnet**, the class enum is not
  closed and the tier claim collapses; the orchestrator stays mid/top tier and the
  saving is the ~10× from structure alone, which is still most of it.
- **If most user messages are conversational rather than work requests** — "what
  did that lane find?", "why is the board like this?" — then a no-read orchestrator
  either answers everything through `Records` or dispatches a lane for each
  question, and the second would feel awful. `Records` is my mitigation and I have
  not measured the mix. This is the risk I rate highest after E1.
- **If bounded context turns out to hurt the routing decisions themselves** —
  i.e. the orchestrator's accumulated cross-lane memory was carrying real value
  that the board and record store do not. I claim it is ARCH-010's medicine
  (declare it, don't hold it in a head), but that claim is untested.

---

## 11. Independent-verify flag

This proposal touches session lifecycle, the verification evidence contract and
the permission surface — three of the highest-stakes areas named in the standing
rules. **If any of it is built, an independent clean-room pass is warranted**,
specifically on the §3 re-executor: a re-executor with a bug that always returns
PASS is a false-proof machine with board-wide reach, and it is exactly the kind of
generation that must not be its own only verifier. The design work here is
low-risk; the implementation is not.

---

## 12. Cost of this analysis

One agent, one context. **No sub-agents dispatched, no lanes launched, no
pipelines re-run, no suites executed, no product code touched.** Twelve tool
calls: seven document reads (the six analysis documents plus the Working
Agreement §I region), four shell invocations (repo settings, agent definitions,
hook inventory, registry shape), one skill invocation for current model pricing
rather than quoting it from memory. This document is the only repository change.
