```orchard-ticket
{
  "id": "ARCH-010",
  "type": "architecture",
  "title": "Each reader works out facts their owner never states",
  "summary": "Half of every defect filed on this board comes from one design habit. A fact a reader must act on is never written down by whoever owns it, so each reader works it out again from something that does not carry it. Eight of the nine architecture tickets already open are single instances of that habit.",
  "impact_if_we_wait": "A new instance appears in a new subsystem roughly every three days, each arriving as its own architecture ticket needing its own answer. Bounded: this affects display correctness and internal record-keeping in a local single-user tool. No user data is at risk and every surface keeps working.",
  "current_need": "Build work on the three instances the class rule now answers: which project a view shows, who owns canonical text, and who owns the record grammar.",
  "severity": "high",
  "area": "Runtime state ownership and record reading",
  "reported": "2026-08-20",
  "reported_by": "defect-origin audit",
  "owner": "agent",
  "work_state": "in_progress",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-20",
      "question": "Should the eight open instances be settled as one class, or kept as separate decisions?",
      "mode": "single",
      "options_keys": [
        "A",
        "B",
        "C",
        "D"
      ],
      "chosen": "A",
      "chosen_on": "2026-08-25",
      "chosen_by": "user",
      "note": "Settle the class once. One rule for the whole board: whoever owns a fact writes it down, and no reader works it out again. B was rejected because stopping halfway is how each earlier instance was left reachable; C because a checker that counts workings-out pays for the fix in the currency of the larger problem; D because it is the status quo that produced eight tickets in eighteen days. The rule also settles the option sets of the instances that were still open, because it eliminates every option that keeps a second place able to hold a different answer."
    }
  ],
  "success_criteria": [
    "Each of the six named facts is written down in exactly one place and read everywhere else.",
    "No surface reports a state it worked out for itself from something that does not carry that state.",
    "Exclusion lists that name what to leave out are replaced by lists that name what to let in.",
    "The eight listed architecture tickets each close as an instance of this decision or are shown not to be one.",
    "A new instance appearing in a subsystem where the fact was already written down once falsifies this ticket."
  ],
  "code_refs": [
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": null,
      "note": "Turn-end sweep works out whether background work is still alive and who owns it; sixteen defect tickets name this file."
    },
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "Client view model works out which project a surface is showing; twenty-eight defect tickets name this file."
    },
    {
      "path": "scripts/lib/ticket-schema.mjs",
      "symbol": null,
      "note": "Reads the ticket record for the board tools; one of two separate readers of the same grammar."
    },
    {
      "path": "public/lib/ticket-record.js",
      "symbol": null,
      "note": "The second reader of the same grammar, which has already diverged from the first."
    },
    {
      "path": "public/lib/dom.js",
      "symbol": null,
      "note": "Shared text renderer; the densest defect site in the tree per line, and each renderer handles line endings for itself."
    },
    {
      "path": "scripts/independent-verify.mjs",
      "symbol": null,
      "note": "The sandbox names what to leave out rather than what to let in, which is why the same gap reappeared one directory over."
    }
  ],
  "related": [
    {
      "id": "ARCH-001",
      "relation": "see_also"
    },
    {
      "id": "ARCH-002",
      "relation": "see_also"
    },
    {
      "id": "ARCH-003",
      "relation": "see_also"
    },
    {
      "id": "ARCH-004",
      "relation": "see_also"
    },
    {
      "id": "ARCH-005",
      "relation": "see_also"
    },
    {
      "id": "ARCH-006",
      "relation": "see_also"
    },
    {
      "id": "ARCH-008",
      "relation": "see_also"
    },
    {
      "id": "ARCH-009",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "ARCH-001",
    "ARCH-002",
    "ARCH-003",
    "ARCH-004",
    "ARCH-005",
    "ARCH-006",
    "ARCH-008",
    "ARCH-009"
  ],
  "verification": [],
  "verification_class": "arch",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": false,
    "Verification plan": true,
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "confirmation": "Authored directly in the record format from a full classification of every ticket on this board; no earlier prose version exists.",
    "dropped": []
  }
}
```

# ARCH-010 — Each reader works out facts their owner never states

## What rule is being broken

Every fact a reader has to act on is written down once, by whoever owns it, and is never
worked out a second time by anyone who reads it.

## Diagnosis

Six facts in this system are never written down anywhere. Each one is instead worked out
again, separately, by every part that needs it:

| The fact | Who should state it | Who works it out instead |
|---|---|---|
| Is this thing still alive? | the thing itself | every call site that asks |
| Does this work outlive the turn that started it? | whoever started it | the turn-end sweep, from whether the session looks busy |
| What state is this ticket in? | the ticket | the board tools, from the words a person typed |
| Where does a ticket's record block begin and end? | the writer of the file | two separate readers, which have already disagreed |
| What proof does this ticket carry? | whoever ran the check | a scan over lines scraped out of the whole file |
| Which project is this view showing? | whoever opened the view | each surface, from shared state any of them can read |

The two halves look unrelated — one is process supervision, the other is text — and they are
the same fault. A reader guesses from whatever signal is nearby. The guess is right for the
cases its author imagined and quietly wrong for the rest. And because every reader guesses
on its own, correcting one reader cannot correct the next: the fault simply reappears in the
next part of the system that needs the same fact.

This is not carelessness. Each of the eight prior fixes was correct for the case in front of
it. The habit was invisible until the tickets were counted together.

## Evidence

From a classification of all 119 defect tickets on this board, filed 2026-08-03 to
2026-08-20 (the full working is in `docs/analysis/defect-origin-2026-08-20.md`):

- **58 of 119 defects — 49 percent — are instances of this one sentence.** Thirty-five
  concern whether something is alive or who owns it; twenty-three concern meaning worked out
  of prose or of a home-made format.
- **Eight of the nine architecture tickets already on this board are single instances of
  it:** `ARCH-001`, `ARCH-002`, `ARCH-003`, `ARCH-004`, `ARCH-005`, `ARCH-006`, `ARCH-008`,
  `ARCH-009`. Only `ARCH-007` is a different class. Seven of the eight are still waiting on
  an answer.
- **Six repeat chains, each the same fact worked out in one more place.** The longest:
  `BUG-037` → `BUG-041` → `BUG-068` → `BUG-096` → `ARCH-003` → `BUG-105` → `BUG-113`, seven
  tickets and roughly seventeen rounds on the single question of whether background work is
  still running.
- **Thirty-three rejected independent verdicts sit in four of these tickets alone** —
  `ARCH-003` (10), `ARCH-004` (6), `ARCH-009` (2) and the renderer work in `FEAT-091` (10)
  and `BUG-105` (7). Across the whole board there are 90 rejected verdicts against 19
  accepted, and these tickets hold most of them.
- Two of the tickets state the fault themselves, unprompted. `ARCH-001`: *"no single
  authority answers 'is this thing alive?', so every call site re-decides."* `ARCH-004`:
  *"State is expressed in a medium built for humans and then parsed by pattern-matching."*

## Why local fixes did not hold

| Ticket | What it fixed | What it left reachable |
|---|---|---|
| `ARCH-001` | gave liveness one server authority | said nothing about work that outlives a turn |
| `ARCH-002` | named work lifetime as a separate question | the turn-end sweep still worked ownership out for itself |
| `ARCH-003` | taught the sweep to read ownership from the frames | only ever protected one kind of row |
| `BUG-105` | extended that to a second kind of row | a third kind was still reachable, and `BUG-113` found it |
| `ARCH-004` | sharpened how ticket state is read out of prose | prose still invites the next incidental word |
| `ARCH-006` | normalised line endings inside one renderer | every other renderer still owns its own |
| `ARCH-008` | is the second reader of one grammar, still open | the two have already diverged on a half-written file |
| `BUG-104` → `BUG-120` | named two more folders the sandbox must exclude | the next folder, one directory over |

Every one of those fixes was correct. The class kept being reachable somewhere else. That is
the honest test of a wrong design, and it passes.

## Verification plan

The bar is countable, not argumentative. For each of the six facts in the table above, count
the places in the tree that work it out. The design is right when that count is one for every
row, and every other place reads the written-down value.

The check that proves it is not a new tool: it is the existing repeat-chain evidence turned
around. Take the last defect in each of the six chains, restate it against the changed
design, and show it can no longer be expressed — there is no second place left to hold a
different answer.

**What would falsify this ticket:** a new instance appearing in a subsystem where the fact
*was* written down once. That would mean the shared cause was a resemblance and the eight
tickets really are eight designs.

## Migration and rollback

Nothing here is a rewrite. Both migrations that carry the rule are already largely built and
each step lands on its own.

1. **Ticket state.** The record block at the head of each ticket already states what prose
   used to imply, and 199 of 201 files carry one. Finishing means the last two files, and
   `ARCH-008`'s choice of one reader instead of two. Rollback: the prose is still in the
   file, and the verbatim originals are kept.
2. **Whether work is alive.** `ARCH-001`'s single authority exists. Finishing means the two
   remaining kinds of row read it instead of working it out, which is `BUG-113`'s open work.
   Rollback: each row's reader is independent, so one can be reverted alone.
3. **Which project a view is showing.** `ARCH-005`'s open decision, unchanged by this ticket
   except that it is now argued as one instance rather than its own design.
4. **Text rendering.** `ARCH-006` and `ARCH-008` become one question: who owns the grammar.
5. **Exclusion lists become inclusion lists.** Three known sites, hours of work, and
   `BUG-120` has already written the argument for it.

Every surface keeps working throughout: at each step the written-down value is added first
and the old working-out is removed second.

## Risks

- **The class could be a resemblance.** Process supervision and markdown are genuinely
  different domains, and one sentence covering both may be a pattern found after the fact.
  The falsifier above is stated so this can be found out rather than assumed.
- **Deciding eight things at once is harder than deciding one.** The reason to do it anyway
  is that seven of the eight have been waiting for an answer and are getting no cheaper.
- **A written-down fact can itself go stale.** Stating a fact once moves the problem from
  disagreement between readers to freshness at the writer, which is a different failure and
  needs its own attention where the fact can change while it is being read.
- **The tempting fix is the wrong one.** Option C — a tool that counts the workings-out —
  would be paid for in more checking machinery, and this audit found that machinery to be the
  larger of the two problems. It is listed so it is rejected deliberately rather than by
  omission.

## Decision record

- **Chosen option:** **A — settle the class once** (chosen by the user, 2026-08-25).
- **Explicitly rejected:** **B** (narrow it to the two already moving) — stopping halfway is how
  every earlier instance was left reachable somewhere else. **C** (a check that counts the
  workings-out) — it buys the fix with more checking machinery, which this audit found to be the
  larger of the two problems; it is rejected deliberately and is not to be revived. **D** (keep
  answering one at a time) — it is the status quo that produced eight architecture tickets in
  eighteen days, seven of them still unanswered.

**The rule, in one sentence.** Every fact a reader has to act on is written down once, by whoever
owns it, and is never worked out a second time by anyone who reads it.

**What the rule decides, so each instance stops being its own decision.** The rule is not only a
principle; applied to an option list it eliminates options, and on all three remaining instances it
eliminates every option but one:

- an option that keeps a **second place able to hold a different answer** is out (that is the defect);
- an option that replaces N derivations with **one shared helper that still derives** is out — it is
  the same defect with fewer copies, and a new reader can still not use the helper;
- an option that adds **a checker counting derivation sites** is out — option C above, at instance
  scale;
- an option that **patches each surface as it is discovered** is out — six repeat chains are the
  evidence that discovery is not a convergence signal.

What survives in each case is the option where the fact is stated at its source and read everywhere
else. That is why ARCH-005 resolves to per-project view state, ARCH-006 to boundary normalisation,
and ARCH-008 to a single server-side record reader — three answers the class supplies rather than
three sessions a person still owes.

**What this decision does NOT do.** It does not migrate any existing record, it does not change any
ticket's contents, and it does not by itself change product behaviour. Each instance still lands as
its own reviewable build, in its own commit, with its own verification.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — defect-origin audit lane

- **Understood:** the question was why the defect rate is high, upstream of what verification
  costs. Every ticket on the board was classified by root cause. The single largest finding
  is not a discipline problem and not the prose substrate on its own: 49 percent of all
  defects, and eight of the nine open architecture tickets, break the one sentence at the
  head of this ticket. Filed as a class because a ninth instance would otherwise arrive as a
  ninth ticket.
- **Changed:** nothing in any code path. This ticket and
  `docs/analysis/defect-origin-2026-08-20.md` are the whole deliverable. Per the template, no
  build starts until a human picks an option.
- **Verified:** the classification is reproducible from the record. The 58 defect IDs, the
  six repeat chains and the eight architecture instances are listed by name in the analysis
  document, so any one of them can be disputed individually. Counts came from scripts over
  the ticket records rather than from recollection.
- **Still open / handoff:** a human picks A, B, C or D. A second finding from the same audit
  is handed to the verification lanes rather than decided here: the checking machinery is
  now 98,000 lines against the product's 54,000, spread over 183 scripts of which 90 are
  named after one ticket each, and it produced 18 of the last 33 defects. That is their
  decision, and the numbers are in the analysis document.

### 2026-08-25 — you (answer · via ticket view)
- **Question:** Should the eight open instances be settled as one class, or kept as separate decisions?
- **Chose:** A — Settle the class once
- **State:** answered — awaiting agent action (not dispatched)

### 2026-08-25 — adoption lane: the decision is recorded, and the class is half-settled already

- **Understood:** the answer is A, and the first job is not to build anything — it is to find out
  how much of the class is still standing. The instance list in this ticket's own diagnosis table
  was written on 2026-08-20 and is **five days stale**. It was re-established against the code
  today rather than taken from the ticket, and two of its rows no longer describe reality.

**The six facts, re-established. Four of the eight instances are already settled; three are open;
one is built but mis-stated on the board.**

| The fact | Instance | State today | Evidence |
|---|---|---|---|
| Is this thing still alive? | `ARCH-001` | **settled** | `src/server/liveness.ts` is the only answer; `scripts/verify-liveness-conformance.mjs` holds an allowlist, and `src/server/index.ts` and `agent-bridge.ts` are allowed **zero** ad-hoc occurrences. The one pid check lives in `session-host.mjs`, which is the owner of that fact, not a reader of it. |
| Does this work outlive the turn? | `ARCH-002`, `ARCH-003` | **settled where an engine declares it; still derived where none does** | Lifetime is declared at dispatch (`ARCH-002` option 1) and ownership is a chain resolved from open tool calls (`ARCH-003`). But `workLifetime()` falls back to counting running rows when the engine reports nothing (`agent-bridge.ts:2250`), and `busy` is still one of the two ways "is work running" is answered at `agent-bridge.ts:3684`, `:3989` and `index.ts:3000`. |
| What state is this ticket in? | `ARCH-004` | **built, not closed** | The user answered it on 2026-08-18 (option B); the record block is the declared state and every board tool reads `work_state`. Its own record still says `work_state: open`, `human_action: decide` — the board is deriving this ticket's state from a field its owner never updated, which is this class, on this class. |
| Where does a record block begin and end? | `ARCH-008` | **open** | Two grammars, unchanged: `public/lib/ticket-record.js:46` and `:61` against `scripts/lib/ticket-schema.mjs:1015`. The server still ships raw file text (`src/server/tickets.ts:293-304`), which is why the browser parses at all. The duplication is now bidirectional — two Node scripts import the browser copy. |
| What proof does this ticket carry? | `ARCH-009` | **settled** | The derived field was deleted, not centralised. `verification[]` carries attributed entries (provider, run id, verdict) and one rule folds them (`outstandingBroken`). No live reader scrapes evidence lines out of a migrated ticket. |
| Which project is this view showing? | `ARCH-005` | **open, and untouched** | No declared owner exists: `RunningSnapshot` carries no project id (`src/server/running-set.ts:85-118`), `dockIsForeign()` still derives ownership by comparing `state.openProjectId` with `state.current.projectId` (`public/app.js:5571-5598`), and the three surfaces named in `BUG-106`'s last verdict still read raw state (`app.js:584`, `:3507`, `:6996`). |

Also in the class by this ticket's own success criteria, and re-checked: the renderer line-ending
fact (`ARCH-006`) is **open** — seven separate normalisations in `public/`, and three on the server
(`tickets.ts:398`, `board.ts:949`, `index.ts:214`) that handle CRLF only, so a lone CR survives the
server path today. The exclusion lists are **one third done**: `scripts/leak-gate.mjs:73` is already
an allow-list, while `scripts/independent-verify.mjs:218` (`CONTAMINATION`) and
`scripts/wa-consolidate.mjs:279` (`PROJECT_MARKERS`) still name what to leave out.

**One belief that was checked and is false.** It was put to this lane that session identity had
recently become a declared per-project field. It has not. Nothing between 2026-08-21 and today
touched project scoping of live state; `ARCH-005` and `BUG-106` have no commits since 2026-08-18.
That row is open exactly as written.

- **Changed:** this ticket's record (`decision` → `decision_history`, `work_state` → `in_progress`,
  `human_action` → `none`, owner → agent) and its Decision record section, which now carries the
  rule and the four rejections. No code, no scripts, no `src/`, no `public/`. Each instance ticket
  is updated in its own commit so it can be reverted alone.
- **Verified:** `validateTicket` ok on this record; `npm run board:check` and `npm run gate` read
  unpiped, exit status in the commit's own log entry. Nothing here is a code change, so there is no
  behavioural must-fail to show; the falsifiable claim is the instance table above, and every row
  of it names the file and line an auditor can check.
- **Still open / handoff:** three instances become build work rather than decisions — `ARCH-005`
  (declare the owning project on live state), `ARCH-006` (normalise at the ingestion boundary),
  `ARCH-008` (one server-side record reader). `ARCH-004` needs an independent clean-room pass on
  its round 7, not a decision. `BUG-140` is adjacent but is **not** settled by this rule and keeps
  its own decision: a background poll loop vouching for its own liveness is a question about what
  counts as progress, not about who owns a fact.

### 2026-08-25 — what landed, and where the rule text actually sits

The adoption above landed as six commits, one per instance so each reverts alone:

| commit | ticket | what it did |
|---|---|---|
| `084324f` | `ARCH-010` | the decision, recorded in the record instead of in prose |
| `c8b03f4` | `ARCH-008` | A — one reader owns the record grammar |
| `fc8047c` | `ARCH-006` | A — the path that ingests text declares it canonical |
| `471f3e0` | `ARCH-005` | 2 — the owning project is stated, not worked out |
| `6fbc3c8` | `ARCH-004` | state corrected to in_verification; the answer was a week old |
| `b293282` | `BUG-120` | A — the clean room gets what a check names |

**One thing to know before reading `084324f`.** Its message says the rule was
written into `docs/CONVENTIONS.md`. The text is there and is correct, but the
hunk is not in that commit — a concurrent `BUG-117` lane committed the file at
09:25 while this section was still uncommitted in the working tree, so the rule
landed inside `afdbc6d` ("BUG-117: write down the escape that travels in the
data") instead. Nothing was lost and nothing was overwritten; recorded here so
`git log -- docs/CONVENTIONS.md` does not read as a missing change. It is also a
small live instance of the hazard the board's own concurrency rules name: a lane
staging more than its own files.

**`docs/bugs/INDEX.md` was regenerated with `board:gen` but deliberately left
uncommitted.** The regeneration is correct and the live board reads it, but its
diff also carries two other lanes' in-flight row moves (`ARCH-011` to in-progress,
`BUG-126` to done), and INDEX is orchestrator-owned. Committing it here would put
another lane's state change in this lane's history.

**Not done, and named rather than left to be discovered:** `BUG-104` keeps its own
decision — its four options are about methodology text quoted inside verify
scripts, which the class rule does not answer. `BUG-140` keeps its own decision —
a background poll loop vouching for its own liveness is a question about what
counts as progress. `BUG-042`'s marker list (`scripts/wa-consolidate.mjs:279`) is
the third exclusion list and belongs to that ticket. And the class is not proven
by this lane: the falsifier stands — a new instance in a subsystem where the fact
*was* written down once would mean the eight tickets really were eight designs.
