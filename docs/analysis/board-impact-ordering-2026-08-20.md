# Can the board be ordered by impact from the data it already has?

**Date:** 2026-08-20 · **Lane:** board-impact-ordering
**Question owned:** *"the bug ticket board currently shows 20 tickets ordered i assume randomly
by name or date or whatever, not by effect/urgency. i need the board to reflect really first
ticket the most impact. if i can answer one ticket and it solves 100 bugs from reoccurring,
clearly i should be pushed and given that as extreme priority."*

**Status: parked.** The analysis is complete and the implementation is written and verified.
See §7 for exactly what is on disk and what is not.

---

## 0. The short answer

**Yes, but only for a quarter of the board, and not from the part of the graph you would
reach for first.**

The ordering is derivable, it puts ARCH-010 first by a factor of two, and every position
in the top eight can be justified in a sentence the user can check. But **only 8 of the 34
open tickets carry any impact signal at all**. The other 26 are ranked on severity and
"is this waiting on you" alone, which is a coarse instrument. The list is right at the top
— which is the part that was asked for — and roughly arbitrary from about position eleven
down. That limitation is structural, not a bug in the ranking, and §6 says what would
change it.

---

## 1. The cause, confirmed

The user guessed "by name or date". It is neither, and the real answer is worse.

`readBoard` (`src/server/board.ts`) walks `docs/bugs/INDEX.md` line by line and `push`es
each row into its lane. There is no `.sort(` anywhere in the file. `board:gen`
(`scripts/board.mjs`, `genBoard`) preserves the existing INDEX row order verbatim and
**appends** newly-filed tickets to the bottom in id order. So:

> **The board is ordered by ticket age, permanently.** A ticket filed in week one sits above
> a ticket filed yesterday, forever, regardless of what either one is worth.

Two consequences, measured on the real board today:

- **ARCH-010 sat at position 35 of 35** — the ticket that collapses eight open architecture
  decisions and names the class behind 49% of all 119 defects
  (`docs/analysis/defect-origin-2026-08-20.md`).
- **`summary.focus` was the oldest 👤 row.** That field is not just a UI label — it is
  injected into *every launched session's system prompt* as "the project's focus"
  (`boardStateSection`). Every agent this project has started has been told the focus was
  FEAT-049, a medium-severity ticket that settles nothing.

---

## 2. The hypothesis, tested — and the part of it that is wrong

The proposed rule was: *how many other open tickets a ticket blocks or would prevent,
transitively; decision-vs-fix; severity as a multiplier.*

**The "blocks" half is wrong on this board, and this is the most useful negative result
here.** Measured over all 200 records: 98 `blocks` edges and 100 `depends_on` edges exist.
Among the 34 currently-open tickets, the blocks-graph is *almost empty*:

| open ticket | open tickets it blocks |
|---|---|
| ARCH-007 | 1 |
| ARCH-008 | 1 |
| BUG-104 | 1 |
| FEAT-087 | 1 |
| **every other open ticket, including ARCH-010** | **0** |

Ranking on `blocks` would have put the board's single highest-impact ticket in a four-way
tie for first with three unrelated ones. Transitivity does not rescue it — the chains are
length one. The edges exist mostly between tickets that are now **closed**, which is
exactly what you would expect: a `blocks` edge gets recorded when someone is stuck, and
then it gets unstuck.

**`see_also` was also tried and rejected.** It is by far the densest relation — 534 of the
777 edges — but `RELATION_INVERSE` maps it to itself, so it is **undirected**. It can say
two tickets are about the same thing; it can never say that answering A settles B. Its
degree would have tied ARCH-010 (4) with BUG-114 (4), which settles nothing.

**What actually carries the signal is `recurrence_evidence[]`** — the explicit, directed
"these are the instances I account for" list that the schema *requires* on every
architecture ticket. ARCH-010 names eight. That single field is why the top of the list
separates cleanly instead of degenerating into a tie-break.

**Severity: usable, weak, and correctly a tie-breaker rather than a lead.** Ranking on
severity alone produces 53 high-severity tickets in no particular order — it separates
almost nothing, because severity is a property of one ticket and the user's question was
about relationships between tickets.

**"Decision vs fix": already structural, so it costs nothing.** The board's lanes
(Awaiting-you → Answered → In-flight → queued) *already* encode "is this waiting on the
user". Constraint 2 is satisfied by the existing lane split; the `human_action` term only
re-orders within a lane, where it is nearly a no-op.

---

## 3. The rule that was built

Score, computed on every read from fields the record already carries — `related[]`,
`recurrence_evidence[]`, `human_action`, `severity`. **No new field, nothing stored,
nothing for a human to keep up to date.**

```
score = 10 × settlesOpen        # other STILL-OPEN tickets this one settles
      +  3 × priorInstances     # recorded instances of the same class, already closed
      +  6 if waiting on you (decide) | 3 if (review) | 0 otherwise
      +  severity: high 4 / medium 2 / not_recorded 1 / low 0
```

`settlesOpen` is the load-bearing term and it is a **set of ticket ids, not an opinion** —
which is what makes constraint 1 (the top must be defensible) achievable. Each row states
its own claim in words the user can falsify by opening the tickets it names:

> *ARCH-010 — answering this settles 3 other open tickets: ARCH-005, ARCH-006, ARCH-008*

Only **directed** claims contribute: a ticket's own `recurrence_evidence[]`, its own
`blocks` edges, and other tickets' `depends_on` pointing at it (the reconciled inverse of
`blocks`, which is the schema's one asymmetric pair).

### A defect caught during the build, worth recording

`recurrence_of` is **also its own inverse**. Crediting both ends of it made pairs of
tickets each claim to settle the other — measured: BUG-104↔BUG-120 and
ARCH-006↔FEAT-091, the graph asserting of two tickets that answering *either* settles the
other. A symmetric edge cannot express "answering A settles B". It now counts as evidence
that a class recurs, which is all it can honestly mean. Same class of mistake as ARCH-006
and ARCH-008: a fact derived by a reader from a structure that does not carry it.

---

## 4. The computed top ten

The "Awaiting you" lane, as the rule orders it. Score in brackets.

| # | | why it is there (the row's own words) |
|---|---|---|
| 1 | **ARCH-010** [55] | answering this settles 3 other open tickets: ARCH-005, ARCH-006, ARCH-008 |
| 2 | **ARCH-008** [30] | answering this settles 2 other open tickets: BUG-111, BUG-121 |
| 3 | **ARCH-006** [24] | answering this settles 1 other open ticket: FEAT-091 |
| 4 | **BUG-104** [21] | answering this settles 1 other open ticket: FEAT-092 |
| 5 | **BUG-120** [21] | answering this settles 1 other open ticket: BUG-104 |
| 6 | **FEAT-087** [18] | answering this settles 1 other open ticket: FEAT-090 |
| 7 | **ARCH-007** [18] | answering this settles 1 other open ticket: BUG-116 |
| 8 | **ARCH-005** [14] | 2 earlier tickets were the same problem |
| 9 | **FEAT-049** [11] | this has been filed once before |
| 10 | **BUG-121** [11] | this has been filed once before |
| 11–13 | BUG-108, BUG-115, BUG-129 [10] | *(nothing to claim — high severity only)* |

**ARCH-010 leads second place by 25 points.** The correctness check in the charter passes,
and it passes for the right reason rather than by tuning: it would still lead under any
weighting where settling another open ticket is worth more than being high severity.

`summary.focus` — the string injected into every launched session — moves from FEAT-049 to
ARCH-010.

Separately, in the **queued** lane, FEAT-091 scores 25 on back-edges alone (BUG-111 and
FEAT-093 both declare `depends_on` it). It has no ticket record at all, so this is purely
what other tickets say about it. That is a genuine finding: it is the highest-leverage
item nobody has flagged as needing the user.

---

## 5. Where the computed order disagrees with my own reading

This is the part worth keeping. Three gaps, none of which I tuned away, because tuning to
one board is how a ranking stops being auditable.

**(a) One prior instance outweighs the gap between medium and high severity — and it
should not.** `FEAT-049` (medium, "publishing would expose private details permanently")
and `BUG-121` (medium) rank 9th and 10th on the strength of `this has been filed once
before`, above `BUG-129` (**high** — *"a message typed while the assistant is working is
silently lost"*), `BUG-115` (high) and `BUG-108` (high). "Filed once before" is weak
evidence and it is buying 3 points where the medium→high gap is only worth 2. **My reading
puts BUG-129 around 9th, not 13th.** The honest fix is `W_PRIOR = 1` for a single prior
instance, keeping 3 for two or more — a recurrence is a pattern at two, not at one.

**(b) The ranking models what a ticket is WORTH, never what it COSTS.** FEAT-091 heads the
queued lane at 25 — and it is also the ticket carrying twelve BROKEN clean-room verdicts
across twelve rounds. "Answering this unblocks two others" and "this is cheap to answer"
are different questions, and the board now confidently answers only the first. A user
following the order top-down will hit the most expensive ticket on the board early. There
is real data for this (`countActivityEntries`, the verdict history) and it is deliberately
unused, because a cost term would need to *lower* a ticket's rank and I did not want to
build something that hides hard work.

**(c) Constraint 2 is doing more than it may have been meant to.** Because the lanes
already separate "waiting on you" from "queued", `BUG-114` (high — *verification runs leave
live sessions behind with no owner*) and `BUG-117` (high — *a stray test server can shut
down the live session*) render **below every low-severity decision on the board**, purely
because nobody marked them 👤. That is exactly what "decisions waiting on the user outrank
work nobody is blocked on" asks for, and it is still a result a reasonable person could
object to. Flagging it rather than silently overriding it: the lane split is the policy, and
if the policy is wrong the lanes are where to change it, not the score.

---

## 6. The honest limit, and what would lift it

**26 of 34 open tickets have no impact signal whatsoever.** Only 8 carry a settlement claim.
Below about position eleven the ordering is severity and lane membership, which is to say
it is not really an impact ordering at all — it is a tidier version of what was there.

The top is what the user asked for and the top is now right. But nobody should read
position 20 as meaning anything.

**Nothing a human would have to maintain would fix this.** The one change that would
roughly triple the directed signal is a schema change: **make `recurrence_of` asymmetric**
(instance → class, with `has_recurrence` as its inverse), the way `depends_on`/`blocks`
already is. Today 37 `recurrence_of` edges exist and *not one of them can be used for
ordering*, because the schema cannot tell which end is the class and which is the instance.
Those edges are already written, already reconciled, already validated — they are simply
unreadable in the direction that matters. That is itself an instance of ARCH-010's class,
and it belongs to whoever answers it, not to this lane.

---

## 7. What is on disk — read this before resuming

**The code landed before the park instruction arrived.** Commit `59a2ebd`, green:
`npm run gate` exit 0, `verify:board-rank` 23/23, `verify:feat-067-rail-summary` 23/23,
`verify-feat-090-followup` 28/28, `verify-boot-aware` 12/12, `board:check` OK. Four files:

- `src/server/board-rank.ts` (new) — the rule, with the rejected graphs documented in it
- `src/server/board.ts` — ranking pass at the end of `readBoard`; `rank`/`rankWhy`/
  `rankSettles` on `BoardItem`; one `readdir` per board read instead of 35
- `scripts/verify-board-rank.mjs` (new) — 23 invariant checks against the real board
- `package.json` — one script entry

**`public/app.js` was never opened by this lane** — not edited, not stashed, nothing to
recover. It was released untouched for the emergency delivery/composer work.

**Live effect of leaving it in:** the Awaiting-you list and the rail re-order, and every
newly launched session is told the focus is ARCH-010 rather than FEAT-049. It is read-only
display ordering and it changes no stored data. **If the freeze means it should not be
active, revert with `git revert 59a2ebd`** — it touches no file another lane is working in.

**Not done, and cheap to finish when this resumes:**

1. The `rankWhy` sentence is on the wire but **nothing renders it**. It belongs in
   `digestAwaitRow()` in `public/app.js` — one line under the existing row body. Until
   then the board is correctly ordered and silent about why, which fails constraint 1 as a
   *user-visible* property even though the data behind it is present.
2. No screenshot, no real-browser check of the ordered list. Deferred with the render.
3. No independent clean-room pass. Low risk (read-only ordering) but it moves what every
   session is told to focus on, so one is warranted before this is called VERIFIED.
4. Weight change (a) above, if it survives a second reading.
