# Reading cost out of agent transcripts — the three corrections

**Read this before computing, quoting, or re-quoting any token or dollar figure
in `docs/analysis/`.**

Every cost analysis in this directory is derived from the agent CLI's own
transcripts (`~/.claude/projects/<encoded>/…`). Three properties of that format
are non-obvious, and getting any of them wrong changes the answer by more than
any price constant does. All three were measured on this machine's real
transcripts, not reasoned about.

The corrected implementation is `scripts/lib/cost-model.mjs`, proved by
`npm run verify:cost-collect` (62 assertions, including a must-FAIL for each
correction below). `npm run cost:collect` applies it. Prefer running that over
writing a fresh script — the whole point of this note is that a fresh script
written from the obvious reading of the format is wrong three times over.

---

## 1. `usage` is repeated per content block — summing it double-counts

The CLI writes **one transcript line per content block**, and every line
belonging to the same API response repeats that response's entire `usage`
object. A response containing `thinking` + `text` + `tool_use` therefore appears
as three assistant lines, each carrying the same token counts.

Summing `usage` across assistant lines counts the same tokens two or three
times. Measured across 40 real subagent lanes in this project: **up to 2.22×
over-report on cache-read**, which is the line item most of the money is in.

**Correct rule:** group by `message.id`, keep **one** row per message.

## 2. Within one message, the LAST row wins — "first wins" under-counts output ~16×

The obvious fix for (1) — take the first row per message id — is also wrong. The
earlier lines for a message are written while the response is still streaming
and carry a **partial `output_tokens`**, often a literal `1`. Only the final
line carries the true count.

Measured on one real lane: first-wins gave `output: 379 → 1` per message,
under-counting output roughly 16×. Cache figures are identical across the rows;
output is not.

**Correct rule:** last row per `message.id`. Both directions were measured — the
naive sum over-counts, first-wins under-counts, last-wins is the only rule that
matches the provider's own accounting.

## 3. Cache writes are 2× base input at a 1-hour TTL, not 1.25×

Prompt-cache writes bill at **1.25× base input for a 5-minute TTL** and **2× for
a 1-hour TTL**; cache reads are 0.1×. The transcripts *do* record the split, in
`usage.cache_creation.ephemeral_5m_input_tokens` /
`ephemeral_1h_input_tokens` — it is simply easy to miss, because the flat
`cache_creation_input_tokens` field sits right next to it and looks sufficient.

Pricing every write flat at 1.25× under-reported a real one-turn dispatch here
by **30.7%**, because that run happened to use 1-hour writes exclusively.

**Correct rule:** read the TTL split and price each class separately. Where a
record genuinely lacks the split, attribute to 5m so the error can only ever
under-state, and say so.

---

## Two further rules the same code enforces

**Price by exact model id AND exact service tier — never by prefix or default.**
An unrecognised model or tier must yield `null`, with the offending name
reported, never a plausible-looking number from a neighbouring model's rates.
The failure this prevents is on record: a hardcoded single-vendor rate table
reported **$9.15 for a run that cost $45.72**. `fast` service tier is 2× on
Opus, so silently treating an unknown tier as `standard` is a 100% error.

**Every transcript-derived figure is a LOWER BOUND.** Verified against a real
dispatch's own `total_cost_usd`: the CLI reported $0.0181414; the transcript
contains enough tokens to account for $0.017185 — **5.3% low**. The gap is one
auxiliary title-generation request per session that the CLI makes and does not
write to the transcript (the `ai-title` entry carries the title and no `usage`
object). The bias is **per session, not per token**: material on a one-turn
probe, negligible on a long lane.

What *is* exact, checked against that same oracle to seven decimal places, is
the price model applied to a given set of tokens.

---

## Status of the earlier documents in this directory

`pipeline-cost-2026-08-19.md` and `pipeline-cost-2026-08-20.md` were computed
before these corrections existed. **Their absolute token and dollar figures are
known to be wrong** — most likely over-stated, since correction (1) dominates
(2), though the direction is not guaranteed for any individual line.

Their numbers have deliberately **not** been edited. They are a record of what
was concluded and when, and rewriting figures inside a dated analysis would
destroy that. What they carry instead is a pointer to this note.

Their *relative* findings — which phase dominates, which lanes rework most, the
shape of the verification yield curve — are far more robust than their absolute
totals, because a roughly uniform over-count cancels in a ratio. Treat the
ratios as usable and the dollar totals as superseded.
