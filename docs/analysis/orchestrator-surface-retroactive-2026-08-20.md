# What the orchestrator actually reached for — computed backwards from the transcripts

**Date:** 2026-08-20 · **Ticket:** FEAT-096 · **Method:** read-only, retroactive
· **Classifier:** `scripts/lib/orchestrator-profile.mjs` (imported, not
reimplemented) · **Dataset:** one session, 2,412 tool calls, 2026-08-03 →
2026-08-20

This answers FEAT-096's question from history instead of from new recordings.
Nothing here was collected by prompting a session to behave a certain way; every
number below is residue of work that was done for its own reasons before the
question was asked.

---

## 0. The headline, stated the way it should be read

**The premise is not refuted, and it is not confirmed either — it is dated.**

| window | calls | allowed by profile | would-block |
|---|---|---|---|
| whole session, 08-03 → 08-20 | 2,412 | 575 | **76.2%** |
| early (08-03 → 08-14) | 1,892 | 252 | **86.7%** |
| late (08-18 → 08-20) | 505 | 312 | **38.2%** |

A single aggregate over this session is misleading and I decline to lead with
one. The session spans a role change: for its first two weeks it was a builder
that also dispatched, and for its last three days it was an orchestrator that
also did board work. A profile is a claim about the *current* role, so the
38.2% is the number that answers the question, and the 76.2% is the number
that answers a question nobody asked.

The daily series is the real finding, because the trend is monotone and large:

```
day        calls  would-block   Agent  SendMsg  Bash  Edit  Write  Read
2026-08-03   600     100%           1        0   286   216     21    36
2026-08-04   489      85%          66        9   273    66     29    38
2026-08-05    95      79%          15        5    51    16      7     1
2026-08-06    46      61%          16        2    21     2      4     1
2026-08-09    56      77%           6        7    42     0      1     0
2026-08-10    45      76%           8        3    34     0      0     0
2026-08-11   103      63%          25       13    52     2      7     3
2026-08-12   135      85%          20        0    88     3     22     1
2026-08-13   141      87%          19        0    81     7     16    16
2026-08-14   182      80%          37        0    93    15     33     3
2026-08-15    15      27%          11        0     3     0      1     0
2026-08-18   202      22%         133       25    28     4      7     2
2026-08-19   165      38%          70       33    53     6      0     3
2026-08-20   138      63%          32       19    80     2      3     1
```

Two things to take from it. First, **on 2026-08-18 — a full day of design work,
202 tool calls — the restricted profile would have blocked 22% of them.** That
is the closest thing in this dataset to a null result, and it should be read as
one: on that day the orchestrator almost never reached for a forbidden tool.
Second, 08-20 bounces back to 63%, and the reason is not a relapse into coding
(2 Edits, 3 Writes all day) — it is a day of hand triage of the board. Which
points at the replacement rather than at the deny; see §3.

---

## 1. The exclusion rule, and why it holds at n=2,412

The recorder lane's warning is real: if lane calls are counted as orchestrator
calls, the premise confirms itself by construction. Its evidence for the
discriminator was n=3. Here is the same question settled over the full history,
and the answer for the *retroactive* dataset is different and stronger than for
the live one.

**Rule used: a session's transcript file contains that session's turns and no
others; the orchestrator's file is therefore the orchestrator's calls.** No
per-record filter is applied, because none is needed. Five independent
properties support it, each checked over all 589 transcripts in this project's
store, not over a sample:

1. **No sidechains anywhere.** `isSidechain === true` appears on **0 of the
   11,531** chained records in the orchestrator's file — and on 0 records across
   all 589 files in the project store. This harness never inlines a subagent's
   turns into its parent's transcript.
2. **No cross-session writes.** `sessionId` equals the filename on **every
   record of every one of the 589 files** (0 mismatches). A lane cannot append
   to another session's file.
3. **Chain closure.** Every `parentUuid` in the orchestrator's file resolves
   inside that file: **0 orphans** over 11,531 records, 7 roots (compaction
   boundaries). An injected foreign turn would dangle.
4. **No model interleaving.** The file uses three models over 17 days, and they
   form **43 strictly contiguous time blocks** with no interleaving at any
   granularity. Dispatched lanes here are pinned to Opus 4.8 by the standing
   model-tier rule; had lane turns been mixed in, Opus 4.8 records would
   interleave with the orchestrator's Fable-5 and Opus-5 turns minute by minute.
   They never do — Opus 4.8 appears only in whole multi-hour blocks that
   coincide with the session's own `/model` switches.
5. **Lanes are visibly elsewhere.** Dispatched lanes exist as their own
   transcript files whose first turn is a dispatch brief with
   `promptSource: "sdk"`. The orchestrator's own human turns carry
   `origin: {kind:"human"}` (22 typed) plus 462 `task-notification` turns.

**A trap I hit and cleared:** 850 records in the orchestrator's file carry
`promptSource: "sdk"`, which looks like lane injection. It is not — those are
the user's own messages relayed in through the claude-station web UI rather than
a terminal. Sampled and confirmed by content.

### Cross-validating the *live* hook's discriminator, at better than n=3

The live hook log (63 records, 2026-08-20 10:01–10:11) overlaps the transcript's
tail, so the two can be checked against each other. The result corrects the
recorder lane's rule:

- Records tagged with an `agentId`/`agentType` (58 `worker`, 1 `general-purpose`)
  appear **nowhere** in the orchestrator's transcript. Excluding them is correct.
- But **`agentId`-absent is not sufficient**. Four untagged records
  (`permissionMode: plan`) belong to a *different session id* entirely — a
  `claude` process the recorder lane spawned through `dispatch.mjs`, which the
  hook sees because the hook is installed tree-wide. Untagged did not mean
  orchestrator.
- Under the conjunction **`sessionId === orchestrator` AND no `agentId`**, the
  hook yields exactly 3 records in the overlap, and the transcript yields exactly
  3 — the same three tools, same commands, matching to ~25 ms (transcript first;
  the hook fires after emission). Zero on either side without a partner.

**Recommendation for FEAT-096:** the live report must filter on session id *and*
agent id. Filtering on agent id alone admits shell-spawned sessions, and this
project's cross-provider boundary spawns them routinely.

---

## 2. What the refused calls were actually doing

Counted over the late window (08-18 → 08-20), which is the orchestrator-role
period. 193 refused calls: 161 Bash, 12 Edit, 10 Write, 6 Read, 3 ToolSearch,
1 AskUserQuestion.

**Bash, multi-labelled** (one command usually serves several purposes — 90% of
this session's Bash commands carry more than one, median 2 lines, max 187, so
single-bucket counting would be a fiction):

| share of the 161 | purpose |
|---|---|
| 80% | read file content (`head`/`sed -n`/`awk`/`jq`/`wc`) |
| 63% | board and ticket content (`docs/bugs/`, `INDEX.md`, ticket ids) |
| 54% | search (`rg`/`grep`) |
| 25% | `board:gen` / `board:check` |
| 23% | `npm run gate` / typecheck |
| 22% | run a script or a verifier |
| 20% | `git status` / `log` / `diff` / `show` |
| 20% | `git add` / `commit` |
| 11% | service and process status (`systemctl`, `curl`, `ss`) |
| 8%  | `ls` / `find` |

**Non-Bash refusals, in full** — all 28 of them, because the list is the
argument. 10 Writes: 7 new ticket files, 2 analysis documents, 1 memory file.
12 Edits: 5 to `docs/bugs/INDEX.md`, 6 to the session's own memory files, 1
other. 6 Reads: 5 memory files and `INDEX.md`, 1 a lane's task output file.
**Not one refused Write or Edit in the orchestrator window touched product
code.** For contrast, the early window's 327 Edits were 160 to `public/` and 43
to `src/` — that is the builder, and that is what the 86.7% is measuring.

Hand-labelled by purpose, from the calls with the surrounding reasoning read:

- **Board bookkeeping — write-back of a decision already made.** Placing an
  INDEX row for a ticket the orchestrator just filed; committing that row;
  running `board:gen` afterwards because the board requires it. This is the
  single largest cluster and it is not investigation; it is a database write
  performed with `python3 - <<'PY'` because there is no other way to do it.
- **Board query — reading state to answer or to decide.** "List open board
  items." "Statuses of FEAT-089 / FEAT-038 / BUG-103 / ARCH-003." "Which
  tickets were created since 20:00 yesterday." Small, repetitive, structured.
- **Status check.** Service uptime, whether a restart took, `:4317` health, how
  many host scopes are live, `date`. Twice this was decision-bearing rather than
  cosmetic — one call compared service start time against a commit time and the
  logged reason was *"checking before dispatching a fix for a non-bug"*, which is
  a dispatch the profile would have forced blind.
- **Read-to-decide, on lane output.** Reading a gate log to find which file the
  leak fired on before writing the follow-up charter; reading
  `scripts/migrate-tickets.mjs` to confirm which provider a migration ran under
  before quoting it to the user.
- **Its own artifacts.** `npm run gate` and `git commit --only` for tickets,
  INDEX rows, analysis docs and memory files that the orchestrator authored. The
  project's own commit discipline requires the gate; the profile would forbid
  running it.

---

## 3. The refusals cluster hard, and they name their own replacement

The distribution is not a long tail of ad-hoc shell work. Ranked by volume, the
late-window refusals are: **board read/write (63% of Bash, plus 15 of the 22
non-Bash Writes/Edits) → repo/service status (31% of Bash across git-inspect and
systemctl) → gate-and-commit of the orchestrator's own artifacts (43% of Bash
across gate, `git add/commit`, `board:gen`)**.

Three tools absorb essentially all of it:

1. **A board tool** — query open/by-id/by-status, file a ticket, place or edit a
   row, and *commit its own change* (which is what makes the `git add`/`commit`/
   `board:gen` cluster disappear along with it, rather than merely moving).
   This alone covers the large majority of refused calls, and it removes the
   `python3 - <<'PY'` in-place edits of `INDEX.md`, which is a data-integrity
   liability independent of any profile — BUG-123, BUG-127, BUG-128 and BUG-133
   on this board are all failures of exactly that mechanism.
2. **A status tool** — service state, port health, host scope count, HEAD and
   recent commits, working-tree cleanliness. Small, read-only, no arguments.
3. **A gate tool** — run the project gate over a named path set and return the
   exit status and the failing lines. This one is load-bearing: the working
   agreement requires the gate before any commit, so a profile that denies Bash
   without replacing the gate does not restrict the orchestrator, it makes the
   orchestrator non-compliant.

What is left after those three is a genuinely small residue: ad-hoc `rg` across
the tree, reading a lane's raw output file, and reading its own memory. That
residue is the honest target of a deny. **The recommendation is therefore
replacement, not denial** — and the ordering matters, because a deny shipped
before the board tool would convert the largest cluster into an unmet need
rather than into a dispatch.

**Also found, and it is a defect in the profile module rather than in the
orchestrator:** four tool names this session used are absent from `KNOWN_DENIED`
— `TaskCreate` (13), `TaskUpdate` (27), `Workflow` (3), `AskUserQuestion` (6).
They classify as `denied-unknown`, which the module's own comment says is itself
a finding. `TaskCreate`/`TaskUpdate` are arguably orchestration verbs that a
dispatch-only surface should *allow*; `AskUserQuestion` is the orchestrator
talking to its user, and denying it is almost certainly unintended.
Separately, `isDispatchViaShell()` matches only `dispatch.mjs` and misses
`npm run dispatch --`: 7 hits where the true count is 18. Since that helper
exists specifically to make "a Bash deny also kills cross-provider dispatch"
visible in the data, it currently under-reports the consequence by 61%.

---

## 4. The escape channel — where a deny would push the work

Measured with the module's `briefSignals()`, reported as heuristics because that
is what they are. They rank briefs; they cannot judge one.

**Volume.** Of the orchestrator's total written output in the late window,
**68.6% went into dispatch briefs and steering messages** (1,062k chars of
`Agent.prompt` + 164k of `SendMessage` against 561k of prose to the user). Over
the whole session, 57.2%. Median late brief: 4,666 chars (~1,170 tokens), p90
5,505, max 7,573. Briefs got *longer* as direct tool use fell — 3,746 median
early, 4,666 late. **A deny would land on a channel that already carries two
thirds of the output, and that channel is unmetered.**

**Content — and here the naive reading is wrong.** 77% of late briefs trip at
least one `ANALYSIS_PHRASES` pattern, which sounds damning until the pattern
breakdown is read: 113 of the hits are `\bbecause\b` and 113 are `\bso the\b`.
Those fire on ordinary explanatory writing. The patterns that actually mean
"conclusion delivered" are rare — `the fix is` 10, `the cause is` 5, `I
found/traced/confirmed` 2, `already checked/verified` 1. **The two dominant
phrases are noise and should be dropped or down-weighted in the live report,
or every brief that explains its own reasoning will score as smuggled analysis.**

The citation signal points the same way: **only 4% of late briefs contain a
single `file.ts:123` citation** (9 citations across 235 briefs), against 64%
carrying an explicit scope fence ("your lane is…", "do NOT touch…"), 87% naming
a ticket id, and 80% demanding a must-FAIL proof or anti-regression. A brief
full of the orchestrator's own reads would leave citation residue. These do not.

Reading a sample by hand — three briefs, one per late day — confirms what the
counts suggest, and finds one thing the counts miss. The analysis in these
briefs is largely **relayed, not self-generated**: 84% of late briefs attribute
their evidence to another lane, a verifier, an independent or cross-provider
clean-room pass, or the reviewer; 61% quote the user directly; 23% paste a
fenced evidence block that is verbatim lane output. A typical opener is *"Fix
two defects an independent cross-provider clean-room pass found in commit
df13918"*, followed by the verifier's own failing output and a scope fence.

**So the escape-channel verdict is mixed and should not be rounded either way.**
Relaying one lane's findings into another lane's charter is the orchestrator
role, not a workaround for a missing tool — a profile does not "relocate" work
that was never the orchestrator's to begin with. But the volume is real, it is
growing, and the briefs are where the judgement lives. A profile that counts
only blocked tool names will score this session as a near-total success in the
late window (22% blocked on 08-18) while two thirds of the thinking flows through
an unmeasured channel. **Both halves of FEAT-096's instrument are load-bearing;
shipping the name-counting half alone would produce a confidently wrong number.**

---

## 5. Limits of this analysis

- **One session.** Deep (2,412 calls, 17 days, three models) but n=1 role.
  Nothing here generalises to a different operator or a different project.
- **The role changed mid-dataset**, and the split point (08-15/08-18) is chosen
  by inspection of the daily series, not by an external marker. A different cut
  moves the late number by several points. The daily table is published so the
  cut can be disagreed with.
- **The brief signals are heuristics** and two of the twelve dominate them.
  A brief tripping none is not proven clean, as the module already says.
- **The provenance signals in §4 (relayed-vs-self-generated) are mine, added for
  this pass** and deliberately kept out of any classifier. If they are worth
  keeping they belong in `scripts/lib/orchestrator-profile.mjs` next to
  `briefSignals()`, not in a second implementation — that is the ARCH-008
  failure mode and the whole reason that module exists.
- **The retroactive and live datasets have different discriminators** — file
  identity here, session-id-plus-agent-id there. They agree where they overlap
  (§1), and that overlap is 3 calls over 10 minutes. It is exact, but it is small.
- **Not measured:** cost. Refused calls are counted, not priced. A cheap refused
  call and an expensive one count the same.
