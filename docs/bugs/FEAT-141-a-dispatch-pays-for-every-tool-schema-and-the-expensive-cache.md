# FEAT-141 — Every dispatch pays for tool descriptions it never uses, and for the expensive cache

- **Status:** IN VERIFICATION — BUILT and self-verified (43/43). Opt-in and OFF by default — no existing caller changes until one asks for a profile. Independent verification REQUIRED before VERIFIED.
- **Severity:** med
- **Area:** dispatch CLI (`scripts/dispatch.mjs`) / cost
- **Reported:** 2026-09-10 by a cost-measurement lane (dispatched)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom

A recurring automated task on another project runs about once an hour, and each
run was costing several dollars. Two of the reasons were not in that project at
all — they were in the way Orchard launches the work, so nobody working on the
task itself could see or change them.

**One:** every launch offered the model the full list of tools it *could* use,
including several it has never once used. Each tool's description is text that
gets sent, and paid for, on every single request inside the run.

**Two:** the results of each request are held in a short-term store so the next
request does not have to pay for the same text twice. That store can be rented
for five minutes or for an hour, and the hour costs **60% more to write**. Every
launch was taking the hour. The task re-reads its store within *seconds*, so the
hour was being bought and never used.

Neither was a bug in the ordinary sense. Both were defaults nobody had ever had
a reason to state, so nothing recorded a choice and nothing reported the cost.

## What was measured

All figures from real runs, not arithmetic. Two sources: the 311 recorded runs
of the task between 2026-08-29 and 2026-09-10 (236 of which produced real work),
and fresh live launches used to price each option.

**The unused tool descriptions.** Sending every tool description costs 21,312
units of text per request. Sending only the ones this task actually uses costs
13,955 — a **7,357-unit (34.5%) reduction on every request**, and a typical run
makes 44 requests.

Which tools it actually uses, counted over all 311 runs:

| tool | times used | kept? |
|---|---:|---|
| Bash | 4,520 | yes |
| Read / Edit / Write | 122 / 61 / 30 | yes |
| Glob / Grep | 0 / 2 | yes — near-zero cost, and the documented fallback |
| **Agent** | **4** | **yes — see below** |
| ToolSearch | 7 | yes — costs nothing, and reaches the rest |
| **Skill** | **0** | no |
| **Workflow** | **0** | no |
| TodoWrite, WebSearch, WebFetch, NotebookEdit, … | 0 | no |

**`Agent` was kept deliberately, against the original suggestion to drop it.**
The suggestion came from an 8-run sample where it appeared unused. Over the full
311 runs it was used four times — and one of those was recovering a stopped
trading engine. Rare is not never, so its 1,731 units are paid on purpose.

**The cache rental.** 100.0000% of cache writes were on the expensive hourly
plan — 62,429,646 units of text, and not one unit on the cheap plan. The hourly
plan's only benefit is surviving a long gap between requests. It never did:

- **Between runs** the gap is about an hour (median 59.8 minutes), and runs were
  measured *starting cold anyway* — a typical run opens by writing 51,780 units
  fresh and reading only 13,380.
- **Within a run**, where nearly all the money is, **87.8% of all cache writing
  happens on follow-up requests issued a median 3.6 seconds apart.** Five
  minutes covers those completely.

**The one risk, quantified.** Switching to the five-minute plan would hurt if
two requests inside one run were ever more than five minutes apart, because the
store would expire and that request would pay full price again. Across 10,402
consecutive request pairs: **three exceed five minutes (0.029%)**, none exceeds
ten, and 99% are under 1.8 minutes. The text exposed by those three totals
181,563 units, against 62.4M repriced — a **224-to-1 benefit-to-risk ratio**,
where the risk side is an over-estimate.

## What changed

A dispatch can now **declare its shape**, and that shape carries both answers.
`scripts/lib/dispatch-profiles.mjs` holds the table; `scripts/dispatch.mjs`
reads it via a new `--tool-profile <name>` (or `ORCHARD_DISPATCH_TOOL_PROFILE`).

- **`full`** — the default, and byte-for-byte the old behaviour: no tool
  restriction, no cache-plan override, no added text. **Every other project
  using this repo is unaffected until it opts in.** This is the property the
  independent pass should attack hardest.
- **`monitor`** — the measured set above, plus the five-minute plan.

**Why this needed a new flag rather than the one that already existed.** The
existing `--allow-tools` looks like it restricts the tool list. It does not — it
only pre-approves tools so the model is not stopped to ask permission, and it
removes nothing from what is sent or paid for. This was confirmed from the
recorded runs, which successfully used four tools that were *not* on that list.
The flag that actually shortens the list is `--tools`, and nothing in this repo
had ever set it.

**The cache plan has no repo setting and no documented flag.** The only lever is
an environment variable in the command-line tool itself,
`FORCE_PROMPT_CACHING_5M`, which is absent from its `--help`. It was found by
reading the shipped program (v2.1.263) and confirmed live. Its logic: the
expensive plan is chosen by default for anything launched the way Orchard
launches work, and this variable overrides that. Because it is undocumented, it
is named and explained in one place only, in the profile table, so a future
reader finds the reasoning next to the switch. **If a tool update removes it, the
profile silently loses the saving** — the residual below.

## How a suppressed tool fails loudly

The hard part. A tool that is not offered **cannot fail when called** — it is
simply absent, so there is nothing to intercept and no error to raise. Waiting
for a failure was not an option; the constraint has to be legible *before* the
model reaches for it.

So a profile that shortens the list also **states the shortening in the
instructions**, naming the withheld tools, saying plainly that this is a
deliberate constraint rather than a malfunction or a refusal, and giving the
exact remedy (`--tool-profile full`) and the file that declares the table. A run
that needs a withheld tool reports it in its final message instead of a later
session spending an hour on a mystery.

Three supporting guarantees: a **misspelled profile name is refused before
anything starts** (never quietly falling back to the expensive default, which
would look identical to working); the profile used is **recorded** in the run's
metadata file, so a cost review reads it rather than reconstructing it; and the
`full` path adds **no text at all**.

## Effect

Per run of the task, against its measured median shape (256,091 units written,
3,332,052 read, 44 requests, at current model prices):

| | saving per run |
|---|---|
| shorter tool list | ~$0.38 |
| cheap cache plan | ~$0.96 |
| **together** | **~$1.34** of a ~$5.92 run (≈23%) |

Repricing alone, across the 12 days already recorded, is **46.8M units of text**
— about **$234**, or roughly **$19/day** at this cadence.

Proven end-to-end on real launches through `dispatch.mjs`: prefix **23,667 →
16,168 units (−31.7%)** and cache writes **11,982 hourly → 0 hourly / 16,166
five-minute**. Both levers, one flag.

## Not done, and one honest correction

- **The task itself is not switched on to this yet.** It lives in another
  project and this lane was scoped not to touch it. Turning it on is one flag on
  the launch line in that project's `scripts/monitor_tick.sh`, or
  `ORCHARD_DISPATCH_TOOL_PROFILE=monitor` in its timer unit. **Nothing saves
  anything until someone does that.**
- **The saving is not split the way it was expected to be.** The tool list was
  expected to be the larger of the two and the cache plan worth about $0.29 a
  run; measured, the cache plan is **worth roughly 2.5× the tool list**. The
  original estimate also assumed one request per run — a run makes 44.
- **`Agent` was expected to be droppable and is not** (above).
- **Stripping the plug-in tools was considered and rejected.** It would have
  saved 971 units, but the recorded runs include a real outage escalation sent
  through one of them. Not worth removing an alerting path.
- **The undocumented variable is a real dependency.** No test can detect its
  removal by a tool update, because the effect is only visible in billing. The
  profile table says so.
- **Other profiles are not proposed here.** Two other recurring tasks on that
  project have the same shape and would likely benefit, but they were not
  measured, so they are noted, not built.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-10 — cost-measurement lane (dispatched, class=fix, round=1)

Built the profile table, wired `dispatch.mjs`, and verified.

Measurement chain, so a later reader can re-run it: tool-schema sizes from live
`claude -p` launches on `claude-opus-5` varying only `--tools` and reading
`cache_creation + cache_read + input` off `--output-format json`; usage shape
from the 311 recorded runs in the Claude CLI's own transcript store for the
consuming project (reachable via `npm run cost:collect`, no path needed); the
`FORCE_PROMPT_CACHING_5M` behaviour from `strings` over the bundled CLI under
`node_modules/`, plus a live A/B. Multipliers (write 1.25× at 5m, 2.0× at 1h, read 0.1×) checked against
current published pricing rather than taken from the brief.

Two claims in the brief were **not** confirmed and are corrected above: `Agent`
is used (4×, one a recovery), and the cache plan is the larger lever, not the
smaller. One claim was confirmed far more strongly than stated: the 1h/5m split
is not merely 100%/0% at the corpus level but 100.0000% across all 10,717 usage
blocks, with zero 5m writes in the entire history.

Files: `scripts/lib/dispatch-profiles.mjs` (new — the declaration point, with
the full measurement record in its header), `scripts/dispatch.mjs` (flag, env
fallback, argv/env construction, notice injection, meta recording, help),
`scripts/verify-feat-141-dispatch-profile.mjs` (new), `package.json`
(`verify:feat-141`).

**Proof — `npm run verify:feat-141`, 43/43 PASS.** Driven against a fake
`claude` on PATH that dumps its own argv and both cache-plan variables, so every
wire claim is read off a real run rather than asserted. The must-FAIL baselines
are **synthesized from the pre-change command shape**, not read from `HEAD`
(CONVENTIONS.md forbids a moving baseline): the `full` control proves no
`--tools` flag and neither variable set, and non-vacuity is graded explicitly in
section 7 — the argv and env probes are shown to distinguish present from absent
rather than passing blindly. Also covered: the env overlay does **not** leak
into a later `full` launch in the same process; an explicit flag beats the
environment variable; and the `Dispatch:` declaration line still comes first,
since the cost collector reads it positionally (which is why the notice is
appended, never prepended).

`npm run verify:dispatch` still 24/24 — the pre-existing contract is intact.

Left UNVERIFIED pending an independent lane. The two things most worth
attacking: whether `full` is *genuinely* byte-identical to the old command line
for every flag combination (a regression there would silently affect every other
project this repo serves), and whether the `monitor` tool set is missing anything
the corpus used only once.
