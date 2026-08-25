# Spend reduction — what to change, in what order

Written 2026-08-20 by the orchestrator, directly, without dispatching a lane.
Planning this by fan-out would have been the behaviour the plan exists to stop.

**Constraint.** ~23% of the weekly allowance remains, after ~77% was consumed in
roughly 48 hours. Everything below is ordered by *tokens saved per token spent
changing it*, not by how interesting it is.

**Goal.** Cut token use and wall-clock without losing the quality of the work or
dropping features.

---

## The single number that decides the order

**231 tokens read for every token written**; cache and context reads are 95.7% of
all transcript tokens. Nothing about how fast an agent writes code matters against
that ratio. Every lever below is judged on whether it reduces what gets *read*.

The second number: **407 of 447 lanes** in the measured window went to the
board/ticket-record system, against **30** for product bugs.

---

## Adopt now — free, already in force

These cost nothing to apply and were adopted earlier today.

1. **Freeze board, schema, methodology and verification-harness features.** Only
   defects that produce false state or data loss get fixed there. This is the 407-lane
   line item; freezing it is the largest single saving available and it costs nothing.
2. **Two same-class verification failures → an architecture decision, not a third
   patch.** Removes zero rounds from tickets where each round found a different class;
   stops the six-round parser grinds. One ticket already applied it unprompted.
3. **User-reported defects outrank agent-noticed ones.** An agent noticing something
   logs it; it does not open a lane.

## Adopt next — cheap to change, largest remaining saving

4. **Stop reading whole ticket histories into every lane.** The ticket corpus is
   ~134k lines across 542 files and lanes are told to read the whole ticket. Charters
   should carry: the current requirement, the invariant, the open defect, the relevant
   diff, and the command to run — with prior rounds available on request rather than
   injected. This is the direct attack on the 231:1 ratio and costs one change to how
   charters are written.
5. **Route by cost-of-mistake, downward.** ~95% of assistant messages ran on an
   Opus-tier model. Mechanical migration, board regeneration, documentation, CSS,
   schema edits and bookkeeping do not need it. Opus stays for concurrency,
   data-loss, architecture and adversarial review. The existing routing rule says
   this already and was not followed.
6. **Shrink charters.** They are written by the orchestrator and read by every lane.
   Measured at ~3% of spend directly, but they also set how much a lane reads before
   it starts — the 73% of pre-work that is orientation.

## Adopt, but measure first

7. **A lane length limit.** The outside review proposes ~40 turns after the first
   edit; one lane ran 431. The internal counterfactual found no evidence a cap helps,
   because long lanes may simply be the hard tickets. Both can be true: the cost is
   context growth, not turn count. **Do this as a handoff rule keyed on context size,
   not a turn cap, and measure one before committing to it.**
8. **Generate the corrected cost ledger.** One command now that the collector is
   fixed. Do it before quoting any dollar figure again, and re-run it after items 4
   and 5 land — that is how we find out whether any of this worked.

## Defer

9. **Consolidating the 186 ticket-specific verification files.** Real waste, and
   exactly the machinery work being frozen. Verification measured at 8.4% of spend,
   so this is a large job against a small share. Revisit after a product cycle.
10. **ARCH-010** — 49% of defects come from facts being re-derived by each reader
    rather than declared by an owner. The decision is cheap and worth making now; the
    implementation is not a this-week job. Answering it stops future defects rather
    than saving present tokens.

---

## Sequence

| # | Step | Cost | Saves |
|---|---|---|---|
| 1 | Freeze machinery work | none | the 407-lane line item |
| 2 | Stopping rule at two same-class failures | none | the multi-round grinds |
| 3 | Charters carry requirement + diff, not history | one habit change | the read ratio |
| 4 | Route mechanical work off Opus | one habit change | tier cost on ~half the lanes |
| 5 | Corrected ledger | one command | tells us if 3 and 4 worked |
| 6 | Handoff rule on context size | one lane, measured | long-lane tail |
| 7 | Answer ARCH-010 | a decision | future defect volume |
| 8 | Verify-file consolidation | large | 8.4% share — later |

## How we will know

Re-run the ledger after steps 3 and 4 and compare **tokens per closed ticket** and
**read:write ratio** against this window. If the ratio does not move, the change was
cosmetic and should be replaced rather than defended.

## Note on the planning board

The user asked for one some time ago. It does not exist — no ticket, no document.
This file is not it; it is one plan. Whether a planning surface is worth building is
itself a decision, and under the freeze it waits.
