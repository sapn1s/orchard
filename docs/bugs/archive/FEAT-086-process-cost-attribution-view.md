# FEAT-086 — process cost attribution: what our workflow actually spends on, so cuts can be informed

- **Status:** OPEN — recommend building it read-only; needs your go, and figures labelled estimates not spend.
- **Area:** a new cost-attribution view (dashboard and/or a live Guide page) over existing cost/token records
- **Reported:** 2026-08-14 by user

## In plain terms
You want a breakdown of what our workflow actually "costs" — not a real bill (the plan is a flat $20/month),
but an estimate of which parts of the process (investigation, building, verification, review, redoing broken
work) eat the most, so that IF usage ever gets limited you'd know what to cut first. Today there's no way to
see whether, say, independent verification or redoing broken work dominates the effort — which is exactly the
number a "what do we cut" decision needs.

**Recommendation:** build a small read-only chart and table over cost data we already record — no new
instrumentation. It's queued with no urgency.

**What I need from you:** a go / no-go, plus one thing to confirm — the figures must be clearly labelled as
estimates, not real money (a past "$65" figure briefly alarmed you). OK to proceed on that basis?

**If you do nothing:** nothing breaks; this stays queued until you say go.

> Everything below is the detailed design (data sources, breakdown axes, presentation, verification) — reference.

## Why
The per-run summary shows an **estimated API-equivalent cost** (the user is on a fixed $20 plan, so it is
NOT real spend). The user's actual want: *"a breakdown / chart representing what in our process costs
most, in case we ever get limited usage"* — i.e. a planning instrument for deciding **what to cut first**,
not a billing display. Today there is no way to see whether, say, independent verification, visual-review
rounds, or investigation dominate the budget.

## Data that already exists (confirm before designing)
- Per-session cost accounting in the `result` branch of the session handler (agent-bridge.ts) — Orchard
  history retains it.
- `~/.local/share/claude-station/agent-outcomes.json` — the outcomes ledger (kind, task type, timing).
- Subagent transcripts under `~/.claude/projects/<enc>/subagents/agent-*.jsonl` and the main session jsonl
  carry per-turn token usage (input/output/cache read/create) and model id.
- The board (`docs/bugs/`) ties work to tickets, and charters name a dispatch CLASS (trivial / fix /
  explore / plan+review / arch / verify) — the join key that makes attribution meaningful.

## Wanted — attribution, not a bill
Answer: **which parts of the process consume the budget?** Break down by, at minimum:
- **Role / phase**: investigate · build · self-verify · independent verify · design/review · orchestration
  overhead (the orchestrator's own turns) · retries and rework.
- **Dispatch class** (trivial / fix / explore / plan+review / arch / verify).
- **Model + provider** (Opus 4.8 workers vs Opus 5 vs cross-provider dispatches).
- **Ticket** (which pieces of work were expensive) and **rework** (work redone after a BROKEN verdict or a
  regression — the most interesting number, since it is the cost of getting it wrong the first time).
Surface the derived insight, not just totals: e.g. "independent verification is N% of spend and caught M
real defects" — that is the ratio a cut decision actually needs.

## Presentation
- Use the **dataviz skill** for the chart (read it BEFORE writing chart code). One clear breakdown chart +
  a sortable table; avoid dashboard sprawl.
- Location: the Guide is static markdown rendered by `prose()`, so a LIVE chart does not belong there
  unwarped. Prefer a dashboard view (its own route, like `#/tickets`) and, if useful, a Guide page that
  EXPLAINS the model and links to the live view. Decide and justify.
- Must degrade honestly: if a record lacks cost/token data, show it as unknown rather than zero.

## Constraints
- Read-only over existing records; do not add per-turn instrumentation that itself costs tokens.
- **State plainly in the UI that the figures are API-equivalent ESTIMATES, not plan spend** — the user was
  briefly alarmed by a `$65` figure that is not money they pay. Mislabelling this would be worse than not
  building it.
- No leaking of private paths/names into any rendered output (leak-gate).

## Verification (§C)
- Fixture ledger + transcripts with known token/cost values → assert each breakdown sums to the total and
  that a record with missing data shows as unknown (must-FAIL: a naive sum that treats missing as 0).
- Assert the join actually attributes: a known verify-class dispatch lands in the independent-verify
  bucket, not in build.
- Render check in a real browser (chart present, labels legible, light+dark) — and the visual-review gate
  applies: an unbiased design pass on the rendered chart, not just DOM asserts.
- Anti-regress: verify:ui, typecheck, leak-gate.
- Risk bucket: read-only reporting (low).

## Note
This session is itself a good validation dataset: ~20 dispatches with clearly-labelled roles (investigate,
build, self-verify, independent verify, visual review, design), including at least one BROKEN→refix cycle
(BUG-091) and one duplicated-effort incident — so rework cost is measurable, not hypothetical.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed after the user clarified the run-summary dollar figure is an API-equivalent ESTIMATE, not plan
  spend, and asked for a breakdown of what the process costs most so future cuts can be informed.
