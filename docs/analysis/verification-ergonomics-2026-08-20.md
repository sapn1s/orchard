# Why a verification round is not one call — and what one call should actually be

Read-only analysis. No product code changed, no verification round was re-run to
measure it, no sub-agent was dispatched. Two sibling lanes own verification
**cost** and **yield**; this one owns **ergonomics** and does not restate their
numbers.

Everything below is counted mechanically out of the session store
(`~/.claude/projects/<project>/`, 1,170 transcripts including 582
dispatched-agent lanes), the ticket corpus, and git history. The counting
scripts live in scratch, not in the repo.

---

## The answer in five lines

- **The hypothesis in the charter is wrong on cost and right on failure.** Setup
  is ~20% of what a verification lane spends before it can start; ~73% is
  *orientation* — reading the diff, hunting for the suite that proves it,
  working out what the requirement even says. But **every one of the seven named
  traps is mechanical**, and roughly a third of harness executions ended without
  a verdict.
- So automating the setup buys **reliability, not speed**. Say that plainly
  rather than selling it as a time saving.
- The orientation cost is a **handoff failure, not a research problem**: the
  fixer already knows the suite, the inputs and the range, and does not record
  them, so the verifier re-derives them from the diff. That is the part a ticket
  field fixes.
- **Four of the seven traps are artefacts of one design choice** — the room is a
  de-gitted tarball with a *blacklist* strip, then hand-patched back to working
  order. Invert it (a self-contained clone plus *declared inputs*) and those four
  stop existing rather than being documented.
- Given that thirteen of today's fifteen tickets are in the machinery and one is
  in the product, **the recommendation is "smaller", and "easier to call" only
  where smaller happens to produce it.** The two are not in tension here: the
  proposal below deletes more harness code paths than it adds.

---

## 1. What was measured

| Population | Count |
|---|---|
| Transcripts that executed `scripts/independent-verify.mjs` | 81 |
| …labelled as verification lanes (agent description matches *verify / clean-room / independent*) | 59 |
| Real (non-dry) executions parsed | 125 |
| Dry runs (`--print-prompt` / `--check-only`) | 31 |
| Window | 2026-08-03 → 2026-08-20, concentrated on 08-18 (48 lanes) and 08-19 (36) |

**Caveats, stated up front.** Verdict-occurrence counts are deduplicated
imperfectly (a lane tails the same log repeatedly, so one verdict can be seen
several times); I use them only for coarse ratios. "Tool calls before the first
execution" is meaningless in lanes that also *wrote* the fix, so the phase
analysis is restricted to the 59 verification-labelled lanes. And this is one
project's session store: it says what happened here, not what is universal.

---

## 2. Where a verification lane's effort actually goes

For the 59 verification-only lanes: **median 13 tool calls before the first
harness execution, median 11 after it.** The harness invocation itself is one
call in the middle of about two dozen.

Composition of the pre-execution phase (n = 915 tool calls):

| Category | Share |
|---|---|
| Reading / inspecting repo files (which suite? what does it need?) | 47.7% |
| `git log/show/diff/rev-parse` — working out *what the change was* | 29.2% |
| Writing the requirement (heredocs, Write/Edit of a requirement file) | ~8% |
| **git plumbing to build a base tree** (`read-tree`, `commit-tree`, `update-index`, `git init`, `worktree add`, `GIT_INDEX_FILE=…`) | **10.2%** |
| Scratch/room wrangling (`mkdir`, `cp -a`, `rm -rf`, `tar`, filesystem checks) | ~6% |
| Running the author's suite locally first | 2.8% |

Merged: **orientation ≈ 73%, mechanical setup ≈ 20%.**

That is the finding that kills the simple version of the charter's hypothesis. A
one-call room builder removes a fifth of the pre-work. It does not turn a
25-call lane into a 1-call lane, and a design sold on that promise will
disappoint.

Two things the same data says are worth more than the ratio:

- **49 of 59 lanes made at least one git-plumbing call; across all 81 lanes, 67
  (83%) used `read-tree` / `commit-tree` / `update-index` / `git init` /
  `worktree add`.** Every lane re-derived the same construction. It is small per
  lane and universal across lanes — the exact profile of something that belongs
  in the tool.
- **75 of 75 lanes polled for a log; 47 detached with `nohup`/`setsid`.** A run
  outstrips the 2-minute Bash timeout, so every lane invents its own
  launch-and-poll ritual — and that ritual is precisely the pattern the Working
  Agreement §I warns about (work parked behind a turn end). The harness offers no
  supported way to run a thing that takes twenty minutes.

---

## 3. The seven traps: how often, and what they cost

The load-bearing observation is not the counts. It is the ratio between how
often a trap **fires** and how often it is **written down**.

### The one trap the harness fixed proves the whole argument

`server never healthy` (stripping `docs/prompts` breaks `seedTemplates`):

| | Count |
|---|---|
| Observed in a real tool result | **4** (one each on 08-12, 08-18, 08-19, 08-20) |
| Pasted into a charter / prompt as folklore | **48** (34 of them on 08-18 alone) |

The harness internalised it on 2026-08-18 (`1f21c35`, `BOOT_STUBS`). **Eight of
those 48 charter paragraphs were written after that commit**, warning lanes about
a trap that no longer exists. Prompt-knowledge has no garbage collector: once
folklore is in the charter template it outlives the defect it describes, and
every future lane pays to read it.

That is the cost model for all seven. The tax is not mostly the incident; it is
the standing paragraph in every charter, plus the rounds lost when the paragraph
is slightly wrong.

### The rest, with evidence

| Trap | Incidence | Real cost seen |
|---|---|---|
| **Corpus stripped** (`docs/bugs` removed; suites that read the real ticket corpus abort) | 13 of 81 lanes re-invented a re-seeding step; **42 of 180 suites read `docs/bugs`** | Two different re-seeding idioms in the corpus (`cp -a` of an exported tree; `git read-tree --prefix=sample-tickets/` then `cp -r sample-tickets docs/bugs`) — each hand-rolled |
| **`docs/prompts` stripped → opaque boot failure** | see above | Fixed in-harness; folklore persists |
| **Pipe through `vrun`** (`git archive \| tar` never reaches the recorder because the verifier runs `node ./vrun.mjs <cmd>`) | 19 of 81 lanes touch it | Class hazard: `vrun.mjs` joins `process.argv.slice(2)` and the harness runs it under `sh -c`, so *quoting* survives but the verifier's own shell composition does not |
| **`--run` with a trailing `# comment`** | 10 of 182 `--run` values carry a `#` | **One entire round lost**, verbatim: `` `=== FIXER-TEST ===` cites run 65508030690b, whose recorded command (node scripts/verify-ticket-view-redesign.mjs --no-red) is not the harness-supplied fixer test command — "the fixer's own test" means THE fixer's test, not a stand-in``. The verifier ran *exactly* the right suite. The comment was in the harness's copy of the string and not in the recorded one |
| **`--no-red` required — the room is not a git repo** | 3 lanes passed it, 6 discuss it; **29 of 180 suites shell out to git** | Any must-FAIL leg anchored to a worktree cannot run *at all* in the room. The RED half of non-vacuity is silently unavailable for a sixth of the suite population |
| **Corpus copy missing one ticket → spurious suite failure** | 1 documented instance, read as a renderer defect | Diagnostic time, and a near-miss on a false BROKEN |
| **Synthetic base excluding the ticket from the diff** | **67 of 81 lanes (83%)** hand-rolled it | Universal, re-derived every time, and the source of the `empty diff` / `not a git repo` aborts |

Two structural notes fall out of the same data:

**`--run` is a fused concept, and the fusion is a soundness hole.** 8 of 182
`--run` values are *setup* commands (`mkdir`, `cp`, `rm`, `SETUP …`, an env
prefix) smuggled in as "how to run things" — the only channel available.
`opts.runs` is passed to the contract as `knownRuns`, which accepts *any* of
them as the FIXER-TEST command. So a verifier can satisfy "re-run the fixer's own
test" by citing `mkdir -p docs/prompts/patterns`, and is simultaneously forbidden
from using that command as its adversarial case. An ergonomic workaround has
quietly weakened the evidence contract.

**The harness generates its own defects at scale.** Thirteen tickets name
`independent-verify.mjs` / `verdict-contract.mjs` / `dispatch.mjs` / `vrun` in
their `code_refs` (FEAT-061, FEAT-062, BUG-066, BUG-092, BUG-097, BUG-104,
BUG-112, BUG-120, ARCH-010, and four adjacent). `verdict-contract.mjs` is 1,157
lines, of which the great majority is a ratchet of nineteen numbered holes found
by verifiers attacking the contract itself. That is the context in which "add
more automation" has to be argued, and it is why the proposal below is shaped as
a subtraction.

---

## 4. Grading the three hypotheses

**H1 — "most of a round's cost and nearly all its failure modes are setup, and
setup is reconstructible into one call."** *Half right, and the wrong half is
the one that was stated first.* Cost: rejected (setup ≈ 20% of the pre-phase).
Failure modes: supported — every named trap is mechanical, one execution in
about three yields no verdict, and mean executions per lane is 2.07 (max 17).

**H2 — "the setup is genuinely per-ticket; the fix is a sharper contract, not
more automation."** *Supported for exactly four inputs* (§5), and the sharper
contract is independently worth having: splitting `--setup` from `--fixer-test`
closes the soundness hole above *and* trap 4, and it is a smaller change than any
automation.

**H3 — "the clean room is over-engineered for what it buys."** *Supported in a
specific and actionable form; rejected as "remove it".*

- The isolation itself is cheap and is not the problem: reflink `node_modules`
  is ~0.4 s, and the whole room is a throwaway.
- What is over-engineered is the room's **construction**: export a tarball (so it
  stops being a git repo — trap 5), strip by **blacklist** (so the corpus and the
  boot files vanish — traps 1, 2, 6), then hand-patch the damage back
  (`BOOT_STUBS` in-harness; re-seeding by every lane).
- And the property the blacklist is paid for **is not actually held**:
  `CONTAMINATION` lists `docs/prompts`, `docs/bugs`, `docs/DEPLOY-CONTEXT.md`
  and the ambient CLI files — so `docs/CONVENTIONS.md`, `docs/analysis/`, and
  every future doc travel in. That is BUG-120, which is a recurrence of BUG-104,
  which was itself closed by naming folders. Twice patched, twice leaked.
- **A git worktree is not the cheaper isolation.** Its `.git` file resolves into
  the live repository, which is a write path into the live tree — the exact class
  BUG-112 was filed for and the reason `node_modules` is copied rather than
  linked. Rejected on containment, not on cost.

---

## 5. What must stay per-ticket, and why

| Input | Per-ticket? | Why |
|---|---|---|
| **The requirement / claim under attack** | **Yes — and it must not come from the fixer** | The prose is what transmits the blind spot. But it need not be *written* per round: `success_criteria` is populated on **200 of 200** tickets (median 5 criteria), authored *before* the fix, in the user's own terms. That is a legitimate, non-contaminating requirement source |
| **What counts as the change** (range, and what to exclude from the diff) | **Yes, as a judgement; no, as plumbing** | "Which commits are this ticket's" is derivable (`git log --grep`), but "exclude the ticket file so the verifier cannot read its own answer" is a decision. Declare it; let the harness execute it |
| **The suite that proves it, and its inputs** | **Declared, not derived** | Name-derivation (`BUG-107` → `scripts/verify-bug-107-*.mjs`) covers 75 of 200 tickets — a good default, a bad contract. But 121 of 180 suites boot the server, 42 read `docs/bugs`, 29 shell out to git: those needs are properties of the *suite*, and the fixer knows them at fix time |
| **The adversarial target** | **Yes, irreducibly** | Automating "what should be attacked" re-imports the framing the clean room exists to decorrelate from. This one stays human, and it should |

The pattern: the per-ticket content is real, but it is **known to the fixer and
not recorded**, so the verifier re-derives it from the diff at ~73% of the
pre-phase. That is the orientation cost, and it is a handoff defect.

---

## 6. Three options

### Option A — *Declared proof* (recommended)

One field, one flag, one deletion.

1. **Ticket field.** The fix lane fills a `proof` block in the ticket record it
   is already editing: the suite command(s), the inputs the suite needs
   (`corpus`, `server`, `git`, `browser`), and what to exclude from the diff. The
   fixer knows all of this while writing the fix; today it is thrown away.
2. **Harness flag.** `--ticket BUG-129` reads that block plus `success_criteria`,
   derives the range from the ticket's commits, builds the base itself, and
   builds a room that satisfies the declared inputs. The lane's call becomes
   `npm run verify:clean-room -- --ticket BUG-129 --claim @claim.txt`, where
   `--claim` is the one genuinely per-round piece of judgement.
3. **Invert the room** (this is BUG-120's option A, and it is what makes the
   traps impossible rather than documented): the room is a self-contained git
   clone of base+head into scratch, containing the tree **minus everything not
   named as an input**. Corpus is an input, pinned at a revision and with the
   ticket under attack removed — which is what one lane hand-built already.
4. **Split `--run`** into `--setup` (executed by the harness before the verifier
   starts, never citable) and `--fixer-test` (command + separate label). Delete
   the smuggling channel and the fused `knownRuns` semantics with it.

**What becomes impossible, not documented:**

| Trap | Under Option A |
|---|---|
| Corpus stripped | **Impossible** — the corpus is a declared input; a suite that needs it and does not declare it fails *at declaration time*, naming the missing input, not as a mid-run abort |
| Corpus missing one ticket | **Impossible** — the harness copies the corpus whole at a pinned revision and removes exactly one named file; there is no hand-copy to get wrong |
| `docs/prompts` / boot failure | **Already impossible** (`BOOT_STUBS`); the input declaration makes it explicit instead of implicit, and lets the folklore paragraph be deleted from the charter template |
| Room is not a git repo | **Impossible** — the room *is* a repo. `--no-red` stops being required, and the RED half of non-vacuity becomes available to the 29 suites that need git |
| Trailing `#` in `--run` | **Impossible** — the description is a separate field from the command, so it can never enter the string that must match |
| Setup smuggled into `--run` | **Impossible** — `--setup` exists, and setup commands are not in `knownRuns` |
| Hand-rolled synthetic base | **Impossible to get wrong per-lane** — one implementation, in the harness, exercised by every round |
| Pipe through `vrun` | **Still documented, not impossible.** Say so. It is a property of the verifier's shell composition inside the room; the honest mitigation is that with `--setup` the verifier no longer *needs* to run setup pipelines at all |

**Net code effect: subtraction.** It deletes `CONTAMINATION` (a list that has
leaked twice and will leak again), deletes the `knownRuns` fusion, deletes the
`BOOT_STUBS` special case (it becomes one ordinary input), and deletes seven
paragraphs from every future charter. It adds one ticket field and one base
builder — the latter being code 67 lanes have already written by hand.

### Option B — *Sharper contract only* (no automation)

Split `--setup`/`--fixer-test`, make the room a clone instead of a tarball, stop
there. Closes traps 3–6 and the soundness hole; leaves the 83% plumbing tax and
the whole orientation cost untouched. **Cheapest, and a strict subset of A** —
so it is the right first landing step, not a rival.

### Option C — *Cheaper isolation instead of the room*

Fresh-context cross-provider dispatch with the ticket reverted, no clean room.
**Rejected as stated**: a worktree's `.git` points into the live repo (BUG-112's
class), and the ambient surface stays readable, which is the property the room
exists for. The salvageable half of C is already inside A: a `git clone` room is
*cheaper to reason about* than a stripped tarball while being strictly more
contained.

---

## 7. What would have to be true for the recommendation to be wrong

- **If the orientation cost is irreducible.** My ~73% figure counts tool calls,
  not model tokens, and I did not measure how much of the reading is genuinely
  re-derivable versus genuinely new judgement. If a fixer's `proof` block turns
  out to be as expensive to author as the verifier's re-derivation, A's main
  saving evaporates and only B's reliability gain remains. **Cheap test before
  building**: fill the `proof` block by hand for three recent tickets and time
  it.
- **If verification frequency should fall.** The sibling cost/yield lanes may
  conclude that rounds are over-prescribed. A tool that makes rounds cheaper to
  launch is worth proportionally less if there should be a third as many — and
  worse, it removes friction from a process that may deserve some.
- **If declared inputs become their own maintenance burden.** BUG-120 names this
  itself: a checker starved of a file it genuinely needed reports a false failure
  that looks like a real one. Mitigation is fail-loud-at-declaration, but the
  risk is real and it is the strongest argument against A.
- **If the machinery should shrink rather than improve.** Thirteen of fifteen
  tickets today are in the machinery. If the right move is to run less of this
  apparatus, then even a subtractive change to it is motion in the wrong place.
  My evidence supports A over "more automation" *because* A is net-subtractive —
  but it cannot tell you whether the harness should exist at this size at all.
  That question belongs to a human, and it is the one I would put in front of
  them first.

---

## 8. Cost of this investigation

One agent, no sub-agents, no verification rounds run. Roughly 25 tool calls: the
two required source files read in full, the Working Agreement and conventions
read in full, and eight throwaway analysis scripts over the session store, the
ticket corpus and git history. No product code touched; this document is the only
repository change.
