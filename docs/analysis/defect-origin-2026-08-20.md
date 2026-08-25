# Why the defect rate is what it is — a classification of every ticket on this board

**Date:** 2026-08-20 · **Lane:** defect-origin (upstream of the three verification lanes)
**Question owned:** *"why does the code have so many issues then… I feel like we are doing
things wrong, but maybe not idk"*
**Method:** read the record, classify by root cause, count. No sub-agents, no pipelines
dispatched. Nothing built. Read-only except this file and `docs/bugs/ARCH-010-*`.

---

## 0. What was read

- All **195** verbatim originals in `docs/bugs/archive/` — title, Symptom, "Why this is
  wrong", and every `**Understood:**` line (the root-cause statement each fix lane wrote).
  Not a sample: the whole corpus, extracted into one digest and read end to end.
- All **199** migrated `orchard-ticket` records in `docs/bugs/` (structured fields:
  `reported_by`, `severity`, `code_refs`, `related`, `recurrence_evidence`).
- `git log` since the fresh-history re-init (`df2362a`, 2026-08-13) — 260 commits.
- Line counts across `src/`, `public/`, `scripts/`, and `package.json`'s script registry.

**Corpus:** 201 ticket files — **119 defects** (109 BUG + 9 ARCH + 1 DEPLOY) and **82
features** — filed 2026-08-03 → 2026-08-20. 18 calendar days, **14 active days** (nothing
on 08-07, 08-08, 08-16, 08-17).

Every ticket named below was read individually; the ID lists in §5 are the classification
itself, not a sample of it.

---

## 1. Is the rate actually high?

**For the product: no. For the whole tree: the question is malformed, because two thirds
of the tree is not the product.**

| | lines | share |
|---|---|---|
| `src/` (server, TS) | 26,767 | 18% |
| `public/` (client JS/CSS/HTML) | 27,654 | 18% |
| **product subtotal** | **54,421** | **36%** |
| `scripts/` (harness + tooling) | 97,952 | 64% |
| **total** | **152,373** | |

Of `scripts/`, **`verify-*` alone is 72,306 lines across 183 files** — larger than the
entire product. **90 of those 183 are named after a single ticket.** `package.json` carries
**202 npm scripts, 179 of them `verify:*`**, and has been touched 57 times in the 8 days of
git history — it is a registry that only grows.

So "the code" is not 54k lines with 119 defects. It is 152k lines, and the majority of it
is machinery built to check the minority.

**Discovery split (119 defects):**

| found by | n | % |
|---|---|---|
| the user | 51 | 43% |
| `bug-hunt` workflow | 24 | 20% |
| a dispatched agent / lane | 28 | 24% |
| orchestrator | 5 | 4% |
| `area-review` workflow | 5 | 4% |
| other (visual reviewer, board-hygiene, architecture dispatch, diagnosis agent) | 6 | 5% |

**57% were caught before the user saw them.** That is not a broken process.

**The trend that matters is not the defect count — it is the ratio to output:**

| period | defects | user-found | features shipped | defects per feature |
|---|---|---|---|---|
| 08-03 → 08-06 | 30 | 14 (47%) | 40 | 0.75 |
| 08-09 → 08-12 | 33 | 16 (48%) | 16 | 2.1 |
| 08-13 → 08-15 | 23 | 11 (48%) | 22 | 1.0 |
| 08-18 → 08-20 | 32 | 10 (31%) | **3** | **10.7** |

Defect discovery is *flat* at ~30 per period. Feature output collapsed. The user-found
share actually **improved** in the last period (48% → 31%), which is the process getting
better, not worse.

**And what the defects are about changed completely.** Splitting each defect into "the
product a person drives" versus "the meta-layer: the ticket board, the verification harness,
the methodology docs":

| period | product defects | meta-layer defects | meta share |
|---|---|---|---|
| 08-03 → 08-06 | 29 | 1 | 3% |
| 08-09 → 08-12 | 23 | 10 | 30% |
| 08-13 → 08-15 | 18 | 5 | 22% |
| 08-18 → 08-20 | 15 | **18** | **55%** |
| **total** | **86** | **33** | **28%** |

Meta-layer in the last three days: `ARCH-004`, `ARCH-008`, `ARCH-009`, `BUG-103`, `BUG-104`,
`BUG-112`, `BUG-114`, `BUG-115`, `BUG-119`, `BUG-120`, `BUG-121`, `BUG-122`, `BUG-123`,
`BUG-124`, `BUG-125`, `BUG-126`, `BUG-127`, `BUG-128`.

**The finding for question 1.** The felt "so many issues" is real, and it is not the product
being sloppy. 86 product defects against 82 shipped features, over 17 days, on a 54k-line
agent-built application, with 57% caught internally, is unremarkable. What changed is that
**the project's mass moved into its own instrumentation**, and an instrumentation defect
looks exactly like a product defect on a board. The last three days shipped 3 features and
found 32 defects, over half of them in tooling that exists to check tooling.

*(The remedy for the harness specifically belongs to the three verification lanes. This is
handed to them as an input, with numbers: 72,306 verify lines, 183 scripts, 90 ticket-named,
179 npm entries, and 55% of the current defect stream.)*

---

## 2. Is it concentrated?

Yes, and sharply — by file, and much more sharply by *ticket*.

**By file** (distinct defect tickets naming the file in `code_refs`):

| file | lines | defects | defects per kloc |
|---|---|---|---|
| `public/app.js` | 11,822 | 28 (+10 as bare `app.js`) | 3.2 |
| `src/server/index.ts` | 3,679 | 18 | 4.9 |
| `src/server/agent-bridge.ts` | 3,914 | 16 | 4.1 |
| `scripts/lib/ticket-schema.mjs` | 1,571 | 7 | 4.5 |
| `scripts/board.mjs` | 1,046 | 6 | 5.7 |
| `scripts/independent-verify.mjs` | 851 | 6 | 7.1 |
| `public/lib/dom.js` | 371 | 4 | 10.8 |

Three product files — 19,415 lines, 36% of the product — carry 62 of roughly 180 defect
file-references. `public/lib/dom.js` is the densest thing in the tree at 10.8 defects per
kloc: 371 lines, and it is the shared markdown renderer.

**By ticket, the concentration is far more extreme.** Activity-log entries per ticket file:

| entries | tickets |
|---|---|
| 1 | 25 |
| 2 (fix + verify) | **108** |
| 3 | 34 |
| 4–6 | 24 |
| 7+ | 8 |

The **median ticket is one-and-done**. The pain is a tail of eight. Clean-room verdicts
across the whole board: **90 BROKEN, 19 HOLDS** — and 61 of the 90 BROKEN sit in eight
tickets: `FEAT-061` (14), `ARCH-003` (10), `FEAT-091` (10), `BUG-105` (7), `ARCH-004` (6),
`FEAT-062` (6), `BUG-116` (4), `BUG-118` (4).

Those eight are: two about the verification harness itself, three about liveness/ownership
of background work, two about reading meaning out of prose, one about browser startup. They
are not scattered. They are §5's classes 1a and 1b, plus the harness.

---

## 3. Are they recurrences?

**34 of 119 defects (29%) carry an explicit recurrence link** — a `recurrence_of` relation
or a populated `recurrence_evidence` list:

`ARCH-001` `ARCH-002` `ARCH-003` `ARCH-004` `ARCH-005` `ARCH-006` `ARCH-007` `ARCH-008`
`ARCH-009` `BUG-014` `BUG-017` `BUG-022` `BUG-037` `BUG-041` `BUG-044` `BUG-068` `BUG-083`
`BUG-085` `BUG-087` `BUG-088` `BUG-089` `BUG-093` `BUG-095` `BUG-096` `BUG-097` `BUG-098`
`BUG-101` `BUG-104` `BUG-105` `BUG-106` `BUG-109` `BUG-120` `BUG-122` `BUG-123`

All nine ARCH tickets are in that list by construction — an ARCH ticket exists *because*
something recurred. The 25 BUGs are the honest number: **21% of bug tickets are the Nth
instance of a class already fixed elsewhere.**

The recurrence chains are worth naming, because they are the same shape four times:

- **liveness/lifetime:** `BUG-037` → `BUG-041` → `BUG-068` → `BUG-096` → `ARCH-003` →
  `BUG-105` → `BUG-113`. Seven tickets, ~17 rounds, one question: *is this thing still
  alive, and who owns it?*
- **project scoping in the client:** `BUG-083` → `BUG-087` → `BUG-106` → `ARCH-005`.
- **line endings / block grammar in renderers:** `FEAT-091` → `BUG-109` → `ARCH-006` →
  `BUG-110` → `BUG-111`.
- **the clean room's deny-list:** `BUG-104` → `BUG-120`. `BUG-120` names its own class in
  one sentence: *"the strip was extended by naming the two directories that had leaked,
  rather than by inverting the rule. Same defect, next instance — which is the signature
  of a deny-list."*
- **contrast tokens:** `BUG-095` → `BUG-098` → `BUG-101`.
- **ticket record reading:** `BUG-121` → `BUG-122` → `BUG-123` → `ARCH-008`.

**This is the strongest evidence in the corpus, and it points *away* from "we are doing
things wrong."** In every chain the recurrence was *detected*, *named*, and *promoted to an
ARCH ticket* rather than patched a fourth time. `ARCH-009` exists because a fix lane refused
to write a fourth guard. That is the architecture-review loop (`FEAT-056`) working exactly
as designed. The recurrence rate is high because the detector is on — not because the class
is being ignored.

---

## 4. The hypotheses, tested

| hypothesis | verdict | evidence |
|---|---|---|
| **Prose parsing as a core mechanism dominates** | **Partly wrong as stated; right in kind** | 23/119 = 19%. Second, not first. But it is the *fastest-growing* class (16 of the 23 filed in the last three days) and 4 of 9 ARCH tickets are in it. The finding is architectural, as suspected — just not yet the largest. |
| **One model writes the code and its own tests** | **Confirmed — and already mitigated** | 90 BROKEN clean-room verdicts against 19 HOLDS. Every one of those is a fix that passed its author's own suite and was broken by an independent verifier. This is the mitigation *working*; the count is evidence of catching, not of failing. |
| **Duplicated implementations of one grammar** | **Confirmed but small** | ~6 defects (`ARCH-006`, `ARCH-008`, `BUG-111`, `BUG-121`, `BUG-122`, `BUG-123`). It is a *symptom* of the §5 class, not an independent cause: a grammar gets implemented twice because no one owns declaring it once. |
| **Claims rather than mechanisms** | **Real, small, and a subclass** | 8 defects where the code worked and a sentence about it was false: `BUG-027`, `BUG-028`, `BUG-034`, `BUG-041`, `BUG-084`, `BUG-096`, `BUG-105`, `BUG-113`. All eight are class 1a — a false claim about liveness *is* a derived-fact defect. |
| **Hand-written sets short by whatever nobody thought of** | **Confirmed, cross-cutting** | 11 defects: `BUG-042` (consolidation heuristic), `BUG-067` (sentinel list), `BUG-072` (known shapes), `BUG-080` (leak-gate blind to images), `BUG-093` (stopwords), `BUG-104`/`BUG-120` (contamination deny-list), `BUG-111` (fence characters), `BUG-121` (anchored regex), `BUG-125`, `BUG-126`. The recurring fix really is "derive from the format or the platform". |
| **Checks pinned to today's values** | **Confirmed, small, already remedied** | 3 defects (`BUG-039`, `BUG-115`, `BUG-124`), and the rule is now written into `docs/CONVENTIONS.md` (2026-08-18). Not a live problem. |

---

## 5. Root cause classification — all 119 defects

Categories were let emerge from the `**Understood:**` lines rather than imposed. This is my
judgement over the ticket text; the ID lists are given so it can be disputed line by line.

### 1a — A runtime fact is *derived by the reader* instead of *declared by its owner* — 35 (29%)

Is this process alive? Does this work outlive the turn that started it? Who owns this row?
Did this session survive the restart? In every case the answer exists somewhere, is never
written down, and each call site substitutes whatever proxy signal is to hand.

`ARCH-001` `ARCH-002` `ARCH-003` `BUG-008` `BUG-013` `BUG-018` `BUG-020` `BUG-022` `BUG-023`
`BUG-024` `BUG-027` `BUG-028` `BUG-029` `BUG-030` `BUG-031` `BUG-033` `BUG-034` `BUG-037`
`BUG-038` `BUG-041` `BUG-043` `BUG-044` `BUG-045` `BUG-046` `BUG-048` `BUG-068` `BUG-072`
`BUG-074` `BUG-077` `BUG-096` `BUG-105` `BUG-113` `BUG-114` `BUG-117` `BUG-129`

`ARCH-001` states it verbatim: *"no single authority answers 'is this thing alive?', so
every call site re-decides."* `BUG-043`: *"nothing declares [work lifetime], so it
substituted `busy` — a turn-scoped signal — for a work-lifetime question."*

### 1b — Meaning is *derived from prose or an ad-hoc format* that never carried it — 23 (19%)

`ARCH-004` `ARCH-006` `ARCH-008` `ARCH-009` `BUG-025` `BUG-042` `BUG-067` `BUG-071`
`BUG-073` `BUG-093` `BUG-097` `BUG-109` `BUG-110` `BUG-111` `BUG-119` `BUG-121` `BUG-122`
`BUG-123` `BUG-124` `BUG-125` `BUG-126` `BUG-127` `BUG-128`

`ARCH-004` states it verbatim: *"State is expressed in a medium built for humans and then
parsed by pattern-matching. Prose invites incidental words; regex cannot tell an incidental
word from a deliberate one."*

### 2 — Client or session state is not re-scoped at a boundary — 18 (15%)

A view model, an override stack or a draft survives a project switch, a session open, a
reload or a new-session click that should have re-keyed it.

`ARCH-005` `BUG-001` `BUG-004` `BUG-006` `BUG-010` `BUG-011` `BUG-014` `BUG-016` `BUG-017`
`BUG-026` `BUG-079` `BUG-083` `BUG-084` `BUG-085` `BUG-087` `BUG-088` `BUG-089` `BUG-106`

### 3 — Environment or artifact drift — 12 (10%)

The built image, the service `PATH`, the npm cache, the deployed build or the clean room
does not match its own definition.

`ARCH-007` `BUG-019` `BUG-035` `BUG-090` `BUG-091` `BUG-107` `BUG-108` `BUG-112` `BUG-115`
`BUG-116` `BUG-118` `DEPLOY-003`

### 5 — Presentation quality — 12 (10%)

Contrast, layout, unbounded text, an affordance that misreads. Found overwhelmingly by the
user or by an unbiased visual reviewer, essentially never by a functional test.

`BUG-021` `BUG-032` `BUG-070` `BUG-075` `BUG-081` `BUG-082` `BUG-086` `BUG-094` `BUG-095`
`BUG-098` `BUG-100` `BUG-101`

### 6a — The harness's own local defects — 12 (10%)

A verify suite that crashes, depends on run order, mutates the repo it tests, masks an exit
code, or rejects a correct answer on format.

`BUG-015` `BUG-036` `BUG-039` `BUG-040` `BUG-047` `BUG-066` `BUG-069` `BUG-092` `BUG-102`
`BUG-103` `BUG-104` `BUG-120`

### 6b — Ordinary product logic errors — 7 (6%)

Off-by-one, wrong status code, a missing validator branch, a multibyte decode. The category
that a normal codebase is mostly made of. **Here it is 6%.**

`BUG-007` `BUG-009` `BUG-012` `BUG-076` `BUG-078` `BUG-080` `BUG-099`

---

### The headline count

**1a + 1b = 58 of 119 defects = 49%.**

They look like different problems — one is process supervision, the other is markdown — and
they are the same defect. In both, **a fact that a reader has to branch on is not written
down by whoever owns it, so every reader re-derives it from an artifact that does not carry
it.** Liveness re-derived from incidental process signals. Ticket state re-derived from the
words a human happened to type. The derivation is right for the cases its author imagined
and silently wrong for the rest, and because each reader derives independently, fixing one
reader cannot fix the next.

**Eight of the nine ARCH tickets on this board are instances of that one sentence:**
`ARCH-001` (liveness re-decided per call site), `ARCH-002` (nothing declares work lifetime),
`ARCH-003` (turn-end guesses parentage), `ARCH-004` (ticket state lives in prose),
`ARCH-005` (client state globally readable, so any surface derives which project it shows),
`ARCH-006` (line-ending normalisation owned per renderer), `ARCH-008` (record grammar
implemented twice), `ARCH-009` (verification state derived from an unattributed evidence
set). Only `ARCH-007` (browser laziness by interposition) is a different class.

That is filed as **ARCH-010**.

---

## 6. What would have prevented the most, at the cheapest point?

Ranked by defects-prevented per unit of effort, with an honest price.

| # | Intervention | Defects it would have prevented | Cost | Verdict |
|---|---|---|---|---|
| 1 | **Declare-at-source for the six named facts** (is-alive, outlives-the-turn, ticket work-state, record boundaries, verdict attribution, which-project-owns-this-view) | up to 58 (49%) | Both migrations that implement it are **already mostly built** — the `orchard-ticket` record block (199 files migrated) and the single server liveness authority (`ARCH-001`). The remaining cost is one human decision instead of seven. | **Do it. This is ARCH-010.** |
| 2 | **Stop growing the harness.** 183 verify scripts, 90 ticket-named, 72k lines, never consolidated, never deleted. | 12 (class 6a) directly, and it is 55% of the *current* defect stream | Consolidation work, and giving up per-ticket bespoke suites. Belongs to the verification lanes. | **Their call. Numbers handed over.** |
| 3 | **Invert every deny-list to an allow-list** — one rule, applied at 3 known sites (clean-room contamination, leak-gate assets, consolidation heuristic) | ~11 | Hours. `BUG-120` already wrote the argument. | **Cheap. Do it inside ARCH-010's migration.** |
| 4 | **A shared renderer owning line endings + block grammar once** | ~6 | This is `ARCH-006` + `ARCH-008`, both open and both instances of #1. | Folded into #1. |
| 5 | **Unbiased visual review as a gate** | ~12 (class 5) | Already adopted after `BUG-095`. | **Already done.** |
| 6 | **A new checker that counts derivation sites per fact** | ~58 in theory | New harness code, in a project where harness growth is the current defect source. | **Explicitly do not recommend.** It would be intervention #1 paid for in the currency of problem #2. |
| 7 | **A different substrate for ticket state** (SQLite, YAML front-matter, an issue tracker) | ~15 of the 23 in class 1b | High: 201 files, every board tool, the ticket API, the browser view, and it forfeits the "the board is git-readable prose an agent can append to" property the whole system rests on. | **No.** The `orchard-ticket` record block is this change, done cheaply and already 99% shipped. Finishing it is #1. |

---

## 7. The answer to the question

**Two halves, and the user deserves both.**

**We are not doing the product wrong.** 86 product defects against 82 shipped features in 17
days, on a 54k-line application built almost entirely by agents, with 57% found before the
user saw them, a *rising* internal-catch rate, a median ticket that is fixed once and
verified once, and a recurrence detector that promoted seven design questions to ARCH tickets
instead of letting them be patched a fourth time — that is a young product with a working
process, not a broken one. The board looks alarming because the process *writes everything
down*. A project with the same defects and no board would look serene and be worse.

**Two things are genuinely wrong, and neither is "we write bad code."**

1. **One design choice is manufacturing half the defects.** Facts are derived at the reader
   instead of declared at the owner — 49% of every defect on this board, 8 of 9 ARCH
   tickets, and every one of the long recurrence chains. It is not a discipline problem;
   no amount of care prevents the *next* reader from deriving the same fact differently.
   Priced and filed as **ARCH-010**. Its remedy is largely built already; what it needs is
   one decision instead of seven.

2. **The instrumentation has outgrown the thing it instruments.** 98k lines of `scripts/`
   against 54k of product; 183 verify scripts; 90 of them named after one ticket each; 179
   npm verify entries; and in the last three days, 18 of 33 defects were *in that
   machinery*. Feature output fell from 40 per period to 3 while defect discovery stayed
   flat — which is what it looks like when a project starts spending its days maintaining
   its own microscope. That is the verification lanes' decision to make; this lane hands
   them the count.

The uncomfortable version, stated plainly: **the felt "so many issues" is not mostly the
product's defect rate. It is that more than half of what the board now reports are defects
in tools the project built to police itself, and nothing on the board distinguishes those
from defects a user could hit.**

---

## 8. Proposed `INDEX.md` row (orchestrator owns INDEX; not edited by this lane)

`npm run board:check` currently reports exactly one FAIL, and it is this row's absence:
*"DECISION NOT ROUTED: ARCH-010 … its Open row Owner is '—', not 👤."* That is the expected
state until the orchestrator inserts the row below. The ticket record itself validates clean
against `scripts/lib/ticket-schema.mjs` (`validateTicket → ok: true`).

Insert into the **Open** table:

```
| ARCH-010 | Each reader works out facts their owner never states | 👤 | OPEN — NEEDS A HUMAN DECISION (4 options). No build starts until an option is chosen. Recommended: A — it settles seven pending decisions as one class, and the two migrations that implement it are already mostly built. If we wait: a new instance appears in a new subsystem roughly every three days, and each one costs a fresh ARCH ticket and its own decision. Bounded: this is display-correctness and internal record-keeping in a single-user local tool. No user data is at risk, and every affected surface keeps working while the decision is open. | high |
```

---

## 9. Not committed — the gate is red on another lane's file

`npm run gate` exits 1:

```
FAIL  leak-gate
      docs/analysis/pipeline-cost-2026-08-20.md:71: [private project H (win)] …
      LEAK GATE: FAIL — 1 hit(s) in 1 file(s) across 773 files
```

The single hit is in the pipeline-cost lane's in-flight file, not in either file this lane
wrote. `check-nul` and `typecheck` both PASS. Per the standing rule the gate must exit 0
before any commit, so **both files are left uncommitted in the working tree** for the
orchestrator to sequence after that lane scrubs its document. The two files to commit are:

```
docs/analysis/defect-origin-2026-08-20.md
docs/bugs/ARCH-010-facts-are-derived-by-each-reader-instead-of-declared-by-their-owner.md
```

## 10. Cost of this analysis

One agent, one context, no sub-agents dispatched, no dispatch runs, no clean rooms, no
verification suites executed. **16 tool calls**: 3 doc reads, 2 digest reads (110 KB of
extracted ticket text), 8 shell/node counting invocations, 3 writes. Two throwaway scripts
under the scratch root (`defect-audit/extract.mjs`, `defect-audit/digest.mjs`). No model
call was spent on anything a script could count — every number above came from a script over
the ticket records, and the only model work was reading 195 root-cause statements and
classifying them.
