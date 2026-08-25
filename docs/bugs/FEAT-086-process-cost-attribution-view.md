```orchard-ticket
{
  "id": "FEAT-086",
  "type": "feature",
  "title": "No way to see which parts of the workflow cost the most",
  "summary": "There is no breakdown of where the effort in this workflow goes. Nobody can tell whether independent verification, investigation, or redoing broken work consumes the largest share. A read-only chart and table over records already kept would answer that, and nothing has been built yet.",
  "impact_if_we_wait": "If usage is ever limited, a decision about what to cut would be made blind. Bounded: nothing breaks and no data is lost while this stays queued, since it only reads records that are already retained.",
  "current_need": "The capture layer is built and recording; what remains is deciding whether the breakdown also needs a rendered view, or whether the command-line report is enough.",
  "severity": "low",
  "area": "Process cost attribution",
  "reported": "2026-08-14",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "in_progress",
  "human_action": "none",
  "updated": "2026-08-20",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-14",
      "question": "Should we build the read-only cost breakdown now, or leave it queued?",
      "mode": "single",
      "options_keys": ["A", "B"],
      "chosen": "A",
      "chosen_on": "2026-08-20",
      "chosen_by": "user",
      "note": "Answered with a stronger requirement than either option offered: \"need as detailed breakdown as possible, or if not possible, it must start to being logged automatically so we have data to check, where exactly time goes\". That is A plus a durability clause — the user had been watching tickets take hours with no way to see where the time went. The prerequisite (\"confirm the records carry usable per-dispatch values\") was checked first and holds: the agent CLI's own transcripts carry per-request model, all four token classes, the 5m/1h cache split, service tier and timestamps, so capture needed no new plumbing — only correct reading."
    }
  ],
  "success_criteria": [
    "Every breakdown sums to the same total as the underlying records",
    "A record with missing cost or token data shows as unknown, never as zero",
    "A dispatch of the independent-verify class lands in the verify bucket, not build",
    "The rendered view states plainly that figures are estimates, not money paid",
    "The chart renders legibly in a real browser in both light and dark",
    "No private paths or names appear in rendered output"
  ],
  "code_refs": [
    {
      "path": "agent-bridge.ts",
      "symbol": "result branch of the session handler",
      "note": "per-session cost accounting; Orchard history retains it"
    },
    {
      "path": "~/.local/share/claude-station/agent-outcomes.json",
      "symbol": null,
      "note": "outcomes ledger — kind, task type, timing"
    },
    {
      "path": "~/.claude/projects/<enc>/subagents/agent-*.jsonl",
      "symbol": null,
      "note": "per-turn token usage (input, output, cache read and create) and model id; the main session jsonl carries the same"
    },
    {
      "path": "docs/bugs/",
      "symbol": null,
      "note": "ties work to tickets; charters name a dispatch class, which is the join key that makes attribution meaningful"
    }
  ],
  "related": [
    {
      "id": "BUG-091",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
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
    "archived_path": "docs/bugs/archive/FEAT-086-process-cost-attribution-view.md",
    "sha256": "8ec95fe9528b6e9cdbd947badc4dd79f25528b1fb0ecb6ff21100e51156fa0db",
    "bytes": 5584,
    "original_title": "process cost attribution: what our workflow actually spends on, so cuts can be informed",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Read against the original head section by section: the four breakdown axes, the four data sources, the estimates-not-spend constraint, the presentation choice and the proof bar are all present.",
    "dropped": [
      "the \"If you do nothing\" line, whose content is now the impact bound",
      "the reading-order note pointing at the detailed design below"
    ]
  }
}
```

# FEAT-086 — No way to see which parts of the workflow cost the most

## Diagnosis

### What the number today is, and is not

The per-run summary shows an estimated API-equivalent cost. The plan is a flat $20/month, so that figure is not spend. What is wanted is a planning instrument: which parts of the process consume the budget, so that a cap would be met with an informed cut rather than a guess.

### The axes worth breaking down by

- Role or phase: investigate, build, self-verify, independent verify, design and review, the orchestrator's own turns, and retries and rework.
- Dispatch class: trivial, fix, explore, plan+review, arch, verify.
- Model and provider, including cross-provider dispatches.
- Ticket, so expensive pieces of work are visible.
- Rework — work redone after a broken verdict or a regression. This is the most interesting number, because it prices getting it wrong the first time.

The derived ratio matters more than the totals: "independent verification is N% of effort and caught M real defects" is what a cut decision consumes.

## Evidence

The data sources were named rather than measured; the ticket asks for them to be confirmed before any design work. FEAT-086 also notes that the session which raised it is itself a usable dataset — roughly twenty dispatches with clearly labelled roles, including a broken-then-refixed cycle on BUG-091 and one duplicated-effort incident. Rework cost is therefore measurable from real records rather than hypothetical.

No suite has been run against this. The verification section below names verify:class and verify:ui as intended checks; neither has been executed.

## Implementation notes

Read-only over existing records. Do not add per-turn instrumentation, which would itself cost tokens.

Read the dataviz skill before writing any chart code. One clear breakdown chart plus a sortable table; avoid dashboard sprawl.

The Guide is static markdown rendered by `prose()`, so a live chart does not sit there unwarped. Prefer a dashboard view on its own route, in the manner of `#/tickets`, with an optional Guide page that explains the model and links to the live view. Whichever is chosen, justify it.

Degrade honestly: a record lacking cost or token data shows as unknown, never as zero.

The UI must state plainly that figures are API-equivalent estimates rather than plan spend. A `$65` figure briefly alarmed the user because it read as money owed. Mislabelling this would be worse than not building it.

## Verification plan

Build a fixture ledger and transcripts with known token and cost values. Assert each breakdown sums to the total, and that a record with missing data surfaces as unknown — the must-FAIL case is a naive sum treating missing as zero.

Assert the join actually attributes: a known verify-class dispatch must land in the independent-verify bucket rather than build.

Render in a real browser and check the chart is present and the labels legible in both light and dark. The visual-review gate applies — an unbiased design pass on the rendered chart, not DOM assertions alone.

Anti-regression: verify:ui, typecheck, leak-gate.

Risk bucket: read-only reporting, low.

## Risks

Private paths and names must not leak into rendered output; the leak gate covers this.

The figures are estimates of equivalent API cost. Presented without that framing they invite a false conclusion about money, which is the failure this work most needs to avoid.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed after the user clarified the run-summary dollar figure is an API-equivalent ESTIMATE, not plan
  spend, and asked for a breakdown of what the process costs most so future cuts can be informed.

### 2026-08-20 — worker (instrumentation lane)

**The user answered A, and raised the bar.** Verbatim: *"need as detailed breakdown as possible, or
if not possible, it must start to being logged automatically so we have data to check, where exactly
time goes"*. Recorded in `decision_history`. The added clause is durability: a breakdown that has to
be reconstructed by hand each time is not an answer, because it is only ever produced when someone
asks.

**Prerequisite checked before building, and it holds.** The ticket required confirming the named
records carry usable per-dispatch values. They do, and more than was assumed: every agent transcript
(`subagents/agent-*.jsonl` + its `.meta.json`, and the session file for a spawned run) carries per
API request the model id, all four token classes, the **5-minute vs 1-hour cache-write split**,
`service_tier`, timestamps, the agent type and description, and the full tool call sequence. So this
was attribution and correct reading, not new plumbing — the orchestrator's hypothesis was right.

**Two corrections to the record, both of which change published figures.**

1. *Duplicate usage rows.* The CLI writes one transcript line per content BLOCK, and every line for
   the same API response repeats that response's `usage` object. Summing `usage` over assistant lines
   therefore counts the same tokens two or three times. Measured across 40 real lanes here: up to
   **2.22x over-report** on cache-read, which is where the money is. Correct rule is group by
   `message.id`, keep the LAST row — earlier rows carry a partial `output_tokens` (a literal `1`
   mid-stream), so "first wins" under-counts output ~16x instead. Both directions were measured, not
   reasoned about. This is a larger error source than any price constant, and it is not mentioned in
   either prior cost analysis.
2. *Cache-write TTL.* Writes are billed at 1.25x base input for a 5-minute TTL and **2x for a
   1-hour** TTL, and the transcripts do record the split. The real probe dispatch used 1-hour writes
   exclusively; pricing them flat at 1.25x under-reports that run by **30.7%**.

**The `PRICE` trap named in the charter is closed by construction, not by documentation.** Prices are
keyed by exact model id AND exact service tier, with no default and no prefix match. An unrecognised
model or tier yields `cost_usd: null` plus the offending name in `unpriced`; every roll-up that
touches it reports the total as unknown and the priced portion separately. `claude-opus-5-turbo`
prices to null, not to Opus rates. Introductory rates carry their own end date and are applied by the
message's own timestamp.

**Independently anchored, not self-graded.** A real `claude -p --output-format json` dispatch was run
and its own `total_cost_usd` used as the oracle. The price model reproduces it to seven decimal
places: **$0.0181414 derived vs $0.0181414 reported**. The prior flat-rate/input-only model gives
$0.0080 on the same tokens (-56%).

**A measured floor, stated rather than hidden.** End to end, the collector derives **$0.017185** from
that run's transcript against the CLI's **$0.0181414** — 5.3% low. Cause located line by line: the
CLI makes one auxiliary title-generation request per session that it does *not* write to the
transcript (the `ai-title` entry carries the title and no usage object). The bias is therefore
per-session, not per-token: 5% on a one-turn probe, noise on a multi-million-token lane. Every
transcript-derived figure here is a lower bound and says so in its own output.

**Phases are read from what an agent DID, not what its charter said.** Charter-keyword classification
is what turns every lane into a verify lane, because the standing dispatch boilerplate contains "an
independent clean-room verify pass is warranted". Time is attributed per tool call over each lane's
own timeline instead. Building that honestly required measuring first: the classifier was written,
run against all 9,057 real Bash calls, and corrected twice —

- first-token matching left **45.7%** of real Bash calls unclassified, because the corpus is full of
  `cd <dir> && …` and `for f in …; do …; done`; contains-matching after stripping the shell prologue
  took that to **3.6%**;
- the dispatch tool in this harness is named `Agent`, not `Task`, so **465 real dispatches** were
  being charged to `other` — the entire delegation cost was invisible;
- main-session transcripts interleave harness metadata rows (`ai-title`, `queue-operation`, `mode`)
  that carry timestamps but describe no work; leaving them in the timeline put **25.8 of one lane's
  26.3** unclassified hours there. The timeline now admits only real message turns.

Net: `other` fell from 58.9% to **2.2%** of attributed hours.

**Gaps in the sibling analysis lane's list, closed and not closed.** Closed: durable recording (the
ledger); one-flat-price-row-for-all-models (per-model, per-tier, per-date pricing); charter-keyword
phase heuristics (tool-call attribution); multi-ticket lanes attributed wholly to the first named
(all ticket mentions are now recorded with counts, so a later reader can split or exclude rather than
being handed a false per-ticket number); manual suspend subtraction (gaps over five minutes are
excluded from phases by construction). **Not closed:** cross-provider (OpenAI/codex) verifier spend
still leaves no local usage record, so those lanes are absent entirely rather than priced — this is
the one gap where the data genuinely is not reachable at the dispatch boundary.

**Deliberately not built.** No UI. FEAT-086 asks for a chart and a table, and another lane is live in
`public/app.js`; the user's stated worry is spend, and building a dashboard to measure spending is the
thing not to do first. The data layer is the part that cannot be reconstructed later — a chart over
it can be added any time. This ticket stays `in_progress` for that reason.

**Runtime cost of the instrumentation: zero.** Nothing was added to the dispatch or execution path.
Capture is the CLI's own transcript writer, which already logs all of this as a side effect of the
work happening; this lane only reads. It therefore also works retroactively, over the 500 lanes that
ran before it existed — and no lane can forget to log, because lanes do not log.

**First real output (500 lanes, ~3 days, 2.68 B tokens, 88.2 agent-hours):** investigating 34.1%,
conversing 27.9%, testing 12.7%, building 10.7%, bookkeeping 7.1%, blocked-on-a-lane 4.6%,
orienting 0.7%. Building is a tenth of the clock. The API-equivalent estimate is **$2,738** — again,
an estimate at list rates, not money paid.

- Added `scripts/lib/cost-model.mjs` (pricing, usage folding, phase and attribution rules — pure),
  `scripts/cost-collect.mjs` (read-only collector, append-only ledger, report),
  `scripts/verify-cost-collect.mjs`.
- `npm run cost:collect` / `cost:report` / `verify:cost-collect`.
- Suite: **62/62**, including must-FAIL proofs for the naive-sum, first-row-wins, flat-cache-rate,
  flat-price, first-token-Bash and all-timestamped-rows behaviours — each anchored to a pre-fix rule
  synthesized inline, never to `HEAD`. Real-artifact coverage: the real transcript store, a real
  dispatch's own cost, real board prose, and the real transcript truncated at 8 points (every prefix
  parses; a longer prefix never reports less cost than a shorter one).
- The suite caught two genuine defects during the run: a testing-command regex that dropped
  `verify-$f.mjs` inside a loop, and one wrong expectation of mine about interval attribution.
- **Warrants an independent clean-room pass.** This is a measurement instrument whose output will be
  used to argue about spend, and generation must not be its own only verifier. The sharpest attacks:
  the message-id folding rule against a lane that was interrupted mid-stream; whether `conversing`
  and `investigating` are being used as catch-alls; and whether the ledger's last-record-wins read
  is right when a lane is collected twice while still running.
