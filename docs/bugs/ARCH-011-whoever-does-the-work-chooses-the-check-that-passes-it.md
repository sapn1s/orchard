```orchard-ticket
{
  "id": "ARCH-011",
  "type": "architecture",
  "title": "Whoever does the work also chooses the check that passes it",
  "summary": "Two designs for separating the coordinating role from the working roles were written, attacked and set aside. Neither is being built. Both replaced careful report-reading with re-running the checks a worker declares, which makes a worker's claim honest while leaving its coverage self-chosen. A restricted coordinator profile and an intake triage step are being built instead.",
  "impact_if_we_wait": "The reasoning is a day old and lives in four documents nobody will re-read. The same two designs then get proposed again, and the same flaw re-found. Bounded: no product behaviour is affected and no work is blocked, because both replacement pieces are moving already.",
  "current_need": "Land the measured-staleness retry rule the user chose: hash a lane's touched set at its end, and route the retry on whether those bytes still match.",
  "severity": "medium",
  "area": "Orchestrator role and verification",
  "reported": "2026-08-20",
  "reported_by": "orchestrator design lanes",
  "owner": "agent",
  "work_state": "in_progress",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-20",
      "question": "On a failed check, should the retry go back to the same worker or to a fresh one?",
      "mode": "single",
      "options_keys": [
        "A",
        "B",
        "C",
        "D"
      ],
      "chosen": "D",
      "chosen_on": "2026-08-25",
      "chosen_by": "user",
      "note": "D is the user's own option, not one of the three offered: measure staleness instead of guessing it. Hash the files the lane touched; unchanged bytes mean its context is still true and it is reused, changed bytes mean it is discarded. Time-based staleness was raised by the user in the same breath and rejected in favour of content-based, because an interval is a proxy for the thing a hash states outright. C is folded in as one narrow clause and no more. A and B are both retained as the two branches the rule routes between, so neither is discarded — they stop being a standing preference."
    }
  ],
  "success_criteria": [
    "The coordinating role's own capability list contains no way to read, search, edit or run anything in the project.",
    "A worker's declared checks are re-run by someone else, and the set of checks is chosen by someone other than that worker.",
    "A failed check names why it failed, so the retry follows a rule instead of a preference.",
    "The log of what a restricted coordinator tried to do is bucketed by someone who did not write the design.",
    "Cross-ticket recurrence still produces architecture tickets after the coordinating role stops holding a long memory.",
    "More than a fifth of the coordinator's blocked calls turning out to be genuine investigation falsifies the whole shape."
  ],
  "code_refs": [
    {
      "path": "docs/analysis/orchestrator-design-A-2026-08-20.md",
      "symbol": null,
      "note": "Design A: five-tool orchestrator (Dispatch/SendMessage/TaskStop/Records/Publish), claim-free lane record re-executed by the harness at head and at a declared base. §1(b), §6 and the six experiments are the parts that do not survive the attack."
    },
    {
      "path": "docs/analysis/orchestrator-design-B-2026-08-20.md",
      "symbol": null,
      "note": "Design B, produced verbatim by gpt-5.6-sol (run 01a01e74-6b8d-7bd2-87fc-e10db45804a8): workflow service, capability gateway, separate orchestrator binary, signed attestations, schema-validating ingester. Part 3 §3 is the objection this ticket is named after."
    },
    {
      "path": "docs/analysis/orchestrator-design-attack-2026-08-20.md",
      "symbol": null,
      "note": "Adversarial review of both. Recomputes the cost ceiling (1.72×, tier 3.5%), bounds the coverage residue by defect class, and grades the fourteen experiments 4 real / 6 blocked / 2 broken-oracle / 2 theatre."
    },
    {
      "path": "docs/analysis/orchestrator-required-workflow-2026-08-20.md",
      "symbol": null,
      "note": "The user's own words for the pipeline they want, recorded verbatim, including the same-worker-or-fresh-worker question this ticket carries as its decision."
    },
    {
      "path": "src/server/registry.ts",
      "symbol": null,
      "note": "Lines 191-193 carry permissionMode / allowedTools[] / disallowedTools[] per project. This is where a tool-restricted orchestrator profile lands; it is a registry entry, not new machinery."
    },
    {
      "path": "scripts/hooks/response-format-gate.mjs",
      "symbol": null,
      "note": "701 lines, advisory/enforce split at lines 288 and 370. Design A proposed flipping it fail-closed for lanes; BUG-118 is its recorded provenance defect and is why that is not a cheap change."
    }
  ],
  "related": [
    {
      "id": "ARCH-010",
      "relation": "see_also"
    },
    {
      "id": "ARCH-009",
      "relation": "see_also"
    },
    {
      "id": "BUG-118",
      "relation": "see_also"
    },
    {
      "id": "FEAT-086",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "ARCH-010",
    "ARCH-009",
    "BUG-118"
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
    "confirmation": "Compared section by section against the four analysis documents; the invariant, the cost ceiling, the coverage flaw, the two rejections and the open question are quoted from them.",
    "dropped": []
  }
}
```

# ARCH-011 — Whoever does the work also chooses the check that passes it

## What rule is being broken

**Whoever coordinates the work cannot do it, and whoever does the work cannot choose the
check that passes it.**

The candidate invariant this started from was *"the orchestrator must not be able to do
work, and a lane's report must be checkable without being read."* Its first half survives
unchanged. Its second half is the one that had to be sharpened, and the sharpening is the
whole finding of the day: **both designs satisfy "checkable without being read" completely
and still let a false green through**, because the thing being checked is a set of checks
the worker selected for itself. Making a report machine-checkable is a property of the
*reader*; the failure lives at the *author*. So the invariant names the author.

Both halves are testable. The first by enumerating the coordinating role's capability list
and finding no way to read, search, edit or run. The second by asking, of any accepted
piece of work, who wrote the list of checks it was accepted on — and getting an answer that
is not the party that did the work.

## Diagnosis

Two designs were produced independently on the same question — what the orchestrator role
should be, architecturally, so that it only orchestrates and relays.

**Design A** removes the role's ability to read, search, run and write, leaving dispatch,
course-correction, kill, a schema-bounded record query and one publish channel; enforcement
is a session profile plus a deny hook. Lanes stop asserting that their work is correct and
instead return commands with expected exit statuses at head and at a declared base, which
the harness re-runs to derive the verdict.

**Design B**, written by a different provider with no sight of A, goes further: the
long-lived session ceases to exist and is replaced by a protocol endpoint with seven remote
calls, behind a workflow service, a conversation gateway, a separate binary with its own
credential and sandbox, and a trusted execution service that signs attestations bound to an
exact revision.

They agree on the move that matters, and the user's correction is what forces it: a report
that must be read carefully to be believed is an unverifiable artifact, so the sceptical
reader is not relocated to a cheaper model — it is deleted, and re-execution replaces it.
That much is right, and nothing below disputes it.

**The fatal flaw both share.** Re-execution proves the checks the worker chose to be graded
on, and nothing else. A worker that knows its fix is fragile at one boundary and declares no
check for that boundary produces a record that runs green at head, red at base, and derives
a passing verdict — mechanically, with no reader in the loop and nothing left to doubt.
**The status of a claim becomes unforgeable while its coverage stays forgeable.** That is
strictly worse than the situation it replaces, because prose is at least sometimes
disbelieved, whereas a derived verdict wears the authority of execution.

The same hole runs through every field the worker declares and no lower authority can
measure. "Open items: none" is a syntax requirement over an unmeasurable assertion.
A defect class that triggers an architecture escalation is declared by the party that would
rather not trigger one. In design B the same fields are called claim coverage, open items
that block completion, and claims marked not-applicable. **The class of defect the whole
exercise exists to close reappears one level up: a fact that matters is declared by the
party with an interest in it, and nobody can check it.** This is the sentence at the head of
the board's largest architecture class, applied to the machinery built to enforce it.

**Why design B is not buildable here.** It specifies a workflow service, a capability
gateway, a separate binary with its own service identity and operating-system sandbox,
signed attestations with environment fingerprints, a schema-validating ingester with
automatic protocol repair, and a regenerated board projection. That is a new subsystem. The
repository it would land in has 98k lines of scripts against 54k lines of product, 183
verification scripts of which 90 are named after a single ticket, and a measured finding
that harness defects are the majority of the current defect stream. Design B's own section 7
says "do not build a universal proof system"; its section 4 then specifies a signing trusted
execution service. That tension is not resolved.

**Why design A's cost case does not survive.** Its headline is "structure buys ~10×, the
tier buys a further ~5×". The 10× is a 10× on 42% of the bill: the window is $3,890, of
which the orchestrator is $1,625, so deleting the orchestrator *entirely* moves the window
by 1.72×. The tier question — the thing the brief actually asked about — moves the window by
$136, or 3.5%, which thirty added lanes would erase. The 120k mean context the ratio is
derived from requires aggressive compaction, which design A's own alternatives table rejects
as treating the symptom. And the activity-class number the design leads with (58.6% of the
orchestrator's spend is "pure text") is not an independent fact: dividing the same table
shows every large activity class costs within 15% of the others per turn, so the figure is
turn count times context rent, not evidence that narrating is intrinsically expensive.

## Evidence

Every number below is from one of the four documents in `docs/analysis/` named in
`code_refs`, and each of those documents states its own provenance.

- **The whole-window ceiling is 1.72×, not 10×.** Orchestrator $1,625 + 476 lanes $2,266 =
  $3,890. At orchestrator cost zero the window is $2,266. The model tier moves it $136
  (3.5%) — inside the noise of the lane-count decision, which neither design prices.
- **Reading a report cannot verify it: 0 of 7.** Reports that claimed green and were later
  found broken passed a careful reader every time, with confident, specific reasoning. That
  is what makes deletion of the sceptical read correct rather than merely cheaper.
- **Roughly half the defect stream is outside what a re-run check reaches.** From the
  classification of 119 defects: presentation 12 (10%, found by the user or a visual
  reviewer, essentially never by a functional test), client and session re-scoping 18 (15%,
  browser state), liveness and process lifetime 35 (29%, where a race is a timing and a
  complete fixture cannot prove it), environment drift 12 (10%, partly what clean rooms are
  for and partly not). Both designs assert the residue is small; the board's own
  classification says otherwise, and nobody has measured it.
- **The landing zone is already instrumentation-heavy.** 97,952 lines of scripts against
  54,421 of product, 183 verification scripts, 90 named after one ticket, 202 package
  scripts. The one intervention the defect audit explicitly declined to recommend was
  building a new checker, on the grounds that it pays for one problem in the currency of the
  larger one. Both designs' central mechanism is that intervention.
- **Four of the fourteen proposed experiments are real, gradeable and cheap.** The blindfold
  log, record fillability (at the stricter of the two kill bars its own document states),
  blind-router replay over 100 messages against a human-labelled conservative route, and the
  cost replay. Six more are real but cannot run until the thing they test exists.
- **Two experiments are graded against an oracle that assumes the answer.** The tier replay
  grades a cheap model against what the existing orchestrator actually chose — the actor the
  design argues was systematically wrong, so disagreement with a defective baseline scores as
  error. The false-green replay re-measures a known result in one arm and sets the other
  arm's kill condition so low that catching one case in seven passes.
- **Two are theatre.** The mute test measures rendering rather than requests, so it cannot
  speak to the cost claim attached to it, and its outcome measure has one unblinded subject
  and no threshold. The charter-provenance trial runs three tickets per arm on a metric whose
  measured distribution is one round for the median ticket, so both arms read the same.
- **A cold start is 11.8k tokens and $0.046** against a median lane of $2.45 — the number the
  open decision below turns on.
- **Design A's enforcement has three unclosed channels**: the dispatch brief is unbounded
  free text whose specification is a dangling cross-reference, course-correction messages are
  unbounded by design, and the publish prose cap has no stated mechanism. A dispatch whose
  brief asks a lane to edit the settings file reaches, in one hop, exactly the escalation the
  two enforcement layers were introduced to prevent.

## Why neither design holds

| Design | What it gets right | What it leaves reachable |
|---|---|---|
| A | Deletes the sceptical reader rather than relocating it; enforcement uses machinery that already exists; names what it will not change, with citations | The worker still authors its own checks; two of five tools are unbuilt; the cost case is computed against the wrong denominator; the serialisation lock is priced at zero on the busiest files |
| B | The attestation's six acceptance conditions are each mechanically checkable; refuses to label an unoracled claim as verified; separates runner integrity from oracle error honestly | Unbuildable at this size; no way to steer a running piece of work; the user is muted along with the assistant; a new blocking-wait primitive lands in the exact subsystem where this project's defects concentrate |
| Both | The user's correction is honoured, not dodged | Coverage stays worker-chosen; the cross-ticket recurrence detector is deleted unpriced; net new harness mass in a project already carrying too much |

## Verification plan

**The proof bar — what must be true to call the new shape right.**

1. The coordinating role's capability list, read directly, contains no way to read, search,
   edit or run anything in the project. This is a list, not a behaviour, so it is checked by
   reading it.
2. Of any accepted piece of work, the set of checks it was accepted on was written by
   someone other than the party that did the work. If the answer is ever "the worker", the
   invariant is not held, whatever the checks then do.
3. The log of what a restricted coordinator tried to do falls into buckets that the
   replacements cover, and the bucketing is done by someone who did not write the design.
4. Cross-ticket recurrence still produces architecture tickets after the coordinating role
   stops holding a long memory of the board.
5. Only the four experiments graded as real are run and reported. Running the other ten and
   quoting their outputs is itself a failure of this bar.

**What would falsify it.**

- More than a fifth of the coordinator's blocked calls turn out to be genuine investigation
  that no forwarding envelope can replace. Then framing cannot move to the worker and the
  shape is wrong.
- Fewer than seven of ten closed tickets can produce an executable, non-moving base for their
  own checks. Then a mechanically derived verdict has no foundation and the prose report
  comes back, at which point the honest answer is that this project cannot yet delete the
  sceptical read.
- The restricted profile ships and defects of the kinds a re-run check cannot reach —
  presentation, client re-scoping, liveness races, environment drift — continue at the same
  rate. That would confirm the coverage residue is the majority of the problem rather than a
  corner of it.
- Total cost per completed request rises. The cost replay is the only experiment in either
  document that can produce that answer.

## Migration and rollback

Nothing from either design is being built. Two smaller pieces are, both in flight under
their own tickets — **add their ids to `related` when they are filed, rather than restating
their content here**.

1. **A tool-restricted coordinator profile, in log-only mode first.** The per-project
   permission fields already exist, so this is a registry entry rather than new machinery.
   Log-only comes first deliberately: the log of what the role attempts is the finding, and
   it enumerates what the restriction would break before it breaks it. Rollback is deleting
   the entry.
2. **A request-intake triage step**, so a request becomes a ticket before anyone reasons
   about it, and phase, round and verdict are recorded where they happen instead of being
   reconstructed from prose afterwards. Rollback is not using it.

Both are independently landable and independently reversible. Neither requires a service, a
gateway, a signing authority, an ingester, or a new checker.

Two items are worth landing on their own and are deliberately **not** bundled into either
design: splitting a check's setup from the check itself so setup can never be cited as
evidence, and making the clean room a clone rather than a stripped copy. Both are
net-subtractive, both close a live hole in what counts as proof, and design A claims four of
its seven mechanical wins from them.

## Risks

- **The restricted profile could stall on day one.** The first "what is the status of this?"
  has no answer without some bounded query. Log-only mode is what tells us how often that
  happens before anything is denied.
- **Deleting the long coordinator memory deletes the recurrence detector's cross-ticket
  half.** That half produced eight of the nine architecture tickets on this board, including
  the one currently ranked first. It is preserved deliberately below, but a periodic sweep
  over the board is a replacement that has not been built or tested.
- **The open decision below is the one place where the wrong answer is expensive.**
  Generation grading its own work is the most common source of results that are called right
  and are not.
- **Recording a decision is not the same as holding it.** Four documents argued this for a
  day; the risk is that the next proposal re-derives design A from scratch because the
  argument was easier to find than the refutation. That is the reason this ticket exists.

## Decision record — what was already settled

- **Chosen:** build neither design. Design B is unbuildable as specified in this repository.
  Design A's cost case does not survive recomputation, and its enforcement has three open
  channels. What is being built instead is the two small pieces named in *Migration and
  rollback*, both already in flight.
- **Explicitly rejected — deleting the recurrence detector.** Both designs remove it, one
  without noticing. It is what produced eight of the nine architecture tickets on this board,
  including the class that ranks first by a factor of two. Nothing in either design's
  replacement can perform similarity recognition across two hundred tickets. It stays, and
  any future shape must keep a path to it.
- **Explicitly rejected — forbidding free text while work is running.** It is the one
  mechanism an instruction genuinely cannot substitute for, and it is still refused, because
  it mutes the *user* and not only the assistant. The requirement was that the next message
  the user *sees* is the completed work; it was never that the user cannot speak. Under the
  design as written, a mid-flight "did you consider this?" is not a status query, not an
  answer to a decision, and not a new request — it is unroutable, and the only remaining
  control is cancelling everything. Today that same correction costs one sentence to a
  running worker. A pass-through channel that forwards the user's words verbatim would keep
  the property and remove the cost; nothing weaker is acceptable.
- **Answered 2026-08-25 — the retry-routing question.** The answer is not one of the three
  options that were offered. It is the user's own fourth, and it is recorded in full in the
  section below.

## Decision record — the retry routing rule (2026-08-25)

**The user's answer, in their words:**

> "Can we make it time-based or probably even files-touched based. If files themselves code
> didnt change since the last time the worker made the changes, then it wont be stale,
> otherwise if hashes changed, use fresh context? isnt this best or? Perhaps incorporating C
> option too, depends if it makes it actually better"

**Why this replaces the menu rather than picking from it.** A, B and C all *guess* at
staleness — A assumes the context is still good, B assumes it is not, C assumes the failure
reason implies which. This answer *measures* it. A worker's context is a resume from its own
transcript, and that transcript embeds the bytes of every file it read. Those bytes are stale
exactly when the file has changed underneath it — not when an interval has elapsed. So the
rule hashes what the lane touched: unchanged means the context is still true and reusing it
is free; changed means throw it away.

**Time-based was considered and rejected**, in the same sentence that proposed it. An
interval is a proxy for content change, and it is wrong in both directions: a lane whose files
nobody has touched in six hours is not stale, and a lane whose file another lane rewrote
ninety seconds later is. A hash states the thing the interval only estimates, at the same
cost. There is no window to tune and nothing to re-tune when lane concurrency changes.

**The rule.** Three lines, evaluated in order, at the moment a check fails:

1. **The touched set is not knowable → fresh.** Absence of evidence is never read as
   "unchanged".
2. **Any file in the touched set hashes differently than it did at the lane's end → fresh.**
3. **Otherwise → reuse the same worker**, with one exception (the C fold-in, below).

**The guard rail this must never cross.** Reuse is about *cost*, and about nothing else. It
never extends to the worker judging its own fix: the checks are authored elsewhere and re-run
elsewhere in both branches, exactly as this ticket's invariant requires. The hash decides
whether a context is worth re-reading; it has no vote on who grades the result. If a future
version of this rule lets a reused worker also supply or run its own check, that version is
wrong, and the argument above does not support it.

**Option C, folded in as one clause and no more.** C as written — mechanical failure back to
the same worker, missed case to a fresh one — is mostly dominated once the hash has spoken. If
the files changed, the reason the check failed does not matter: the context is untrue either
way. If the files did not change, "the check failed mechanically" and "a case was missed" both
describe a context that is accurate, and both are answered by handing the worker a failing
check it did not author. C survives in exactly one place, and it is inverted from how it was
written: **when the check that failed is one the worker itself reported passing, and the files
have not changed, the retry goes to a fresh worker.** Unchanged bytes make that a contradiction
*inside* the worker's context rather than a gap in it, and re-reading cannot correct it because
there is nothing new to read. C's stated cost — "nothing records why a check failed" — does not
apply to this clause: both the worker's declaration and the re-run result already exist outside
the worker, so no party the decision is about has to state anything.

**What the baseline is compared against: the bytes as the worker last saw them, not the commit
it produced.** These differ, and the difference is the common case here. A lane's commit
contains only what it wrote, while its context is stale on what it *read*; roughly two in five
lanes commit nothing at all; and another lane committing in between changes the commit graph
without necessarily changing a byte this lane relied on — a git-range comparison calls that
stale and a hash correctly does not. Content hashes are indifferent to who committed, when,
and in what order.

**Honest answers to the awkward cases.**

- **A lane that touched nothing.** 87 of 599 real worker transcripts (15%) record no
  file-tool call at all; 85 of those 87 ran Bash. So "touched nothing" almost never means
  "changed nothing" — it means the touched set is unmeasurable, and the rule returns *fresh*.
- **A file another lane rewrote wholesale.** The hash differs, so the verdict is *fresh*,
  with no special case: a rewrite is just a large change.
- **Writes made through Bash rather than the file tools.** 357 of the 431 lanes that wrote
  through a file tool also ran a write-shaped Bash command, so the file-tool set understates
  what a lane knows about. The fingerprint therefore takes the union of the file-tool set with
  the lane's own git-visible changes. Writes outside version control (scratch, caches) are
  outside the rule and are stated as such rather than silently included.

**Feasibility, measured before anything was built** — against the real store on this machine,
599 worker transcripts under
`~/.claude/projects/<encoded>/<sessionId>/subagents/agent-<agentId>.jsonl`, not a fixture.

- **The touched set is recoverable.** 512 of 599 lanes (85%) record at least one file-tool
  call carrying a `file_path`; 431 (72%) record a write. Median 4 written files and 5 read
  files per lane, 11 read files at the 90th percentile — so a fingerprint is a handful of
  hashes, not a tree walk.
- **A reused context is genuinely a resume from that transcript**, which is why the bytes in
  it are the thing that goes stale. Reuse is not a new capability being invented here.
- **The rule discriminates; it does not collapse into B.** Over the 323 lanes that fall inside
  this repository's git history and have a touched set, the share whose touched set was
  changed by a commit within a window of the lane ending is **24% at 15 minutes, 60% at one
  hour, 76% at four hours**. At the latency a retry actually runs — the check fails moments
  after the lane returns — the rule says *reuse* three times in four, which is precisely the
  cold start that option B would have paid every time. Left overnight it says *fresh* three
  times in four, which is what option A would have got wrong.
- **The staleness signal is real contention, not board churn.** The files that most often
  drive a stale verdict are `public/app.js` (12), `package.json` (11), `public/styles.css` (9)
  and `scripts/independent-verify.mjs` (9); the generated `docs/bugs/INDEX.md` accounts for 5.
  So no exclusion list is needed, and adding one would be the wrong instinct: the hot files
  are exactly where a second lane's edit really does invalidate the first lane's reasoning.
- **The one thing that is not free.** Hashing at the lane's end requires the fingerprint to be
  taken then, while the bytes are still current. A retroactive fallback exists — the touched
  set plus git and mtime evidence since the lane's last timestamp — but it is a weaker oracle
  that can only over-report staleness, so it errs toward a fresh worker and must say in its
  output that it is the fallback.

**This is a dispatch rule, not a subsystem.** It is one check and one decision. Nothing here
needs a service, a gateway, a signing authority or a new checker — the same restraint the two
rejected designs failed.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — board lane (orchestrator design capture)

- **Understood:** a day of design work on the orchestrator role produced four documents —
  two independent designs, an adversarial review of both, and the user's own requirements
  recorded verbatim — and a decision to build neither, none of which was on the board. The
  most important single finding is not the cost arithmetic and not design B's size: it is
  that both designs replace a reader who can be fooled with a mechanism that is fooled by
  construction, because the party being checked selects the checks. That is the same class as
  this board's largest architecture ticket, one level up.
- **Changed:** this ticket only. No code, no existing ticket, no board index. The four
  analysis documents are untouched and are cited rather than summarised where a number
  matters.
- **Verified:** the record validates and the writing contract passes; the board index check
  reports no drift beyond the row this ticket needs, which the orchestrator owns. Every
  figure quoted above was read out of the named document rather than recalled, and the two
  figures the adversarial review corrects (the whole-window ceiling and the activity-class
  share) are stated in their corrected form with the correction named.
- **Still open / handoff:** a person answers the retry-routing question. Two tickets are
  expected from lanes already in flight — the tool-restricted coordinator profile and the
  request-intake triage step — and their ids should be appended to `related` here when they
  land, so this ticket points at the work instead of describing it. The proposed index row is
  in the lane's return message.

### 2026-08-25 — you (answer · via ticket view)
- **Question:** On a failed check, should the retry go back to the same worker or to a fresh one?
- **Answer:** Can we make it time-based or probably even files-touched based. If files themselves code didnt change since the last time the worker made the changes, then it wont be stale, otherwise if hashes changed, use fresh context? isnt this best or? Perhaps incorporting C option too, depennds if it makes it actually better
- **State:** answered — awaiting agent action (not dispatched)

### 2026-08-25 — lane (ARCH-011 retry routing)
- **Note:** **Understood:** the retry-routing question was answered by the user with a fourth option nobody offered — measure staleness instead of guessing at it. Both halves of the menu (same worker / fresh worker) assume an answer; hashing the files the lane touched states it. Time-based was raised and rejected in the same sentence, because an interval is a proxy for the content change a hash names outright.

  **Changed:** the decision is recorded — `decision` cleared into `decision_history` (chosen D, chosen_by user, with the rejection of time-based and its reason), owner moved off 👤, and a new body section carries the user's words verbatim, the rule, the guard rail, the folded-in clause from option C, and the measured feasibility. Built `scripts/lane-context.mjs` (two verbs: `fingerprint` at a lane's end, `check` before a retry) and `scripts/verify-arch-011-retry-routing.mjs`.

  **Verified:** 26/26 checks. `npm run gate` exits 0, read unpiped. Feasibility was measured before anything was built, against the REAL CLI transcript store (599 worker lanes, read-only): 512 (85%) yield a touched set; 87 (15%) yield none and 85 of those ran Bash, so an empty set is unmeasurable and routes to fresh rather than reuse. The rule does not collapse into either option it replaced — over the 323 lanes inside this repo's git history, the touched set had changed 24% of the time at 15 minutes after the lane ended, 60% at an hour, 76% at four hours; the suite asserts its own case list holds both verdicts, so a constant router fails it, and two cases (a reverted edit, a bare touch) fail any time- or mtime-based router. A real concurrent lane modified `src/server/survival.ts` eight seconds into the first smoke run and the tool caught it unprompted — the case this exists for, live. Truncation was graded on prefixes of a real 7.9MB lane transcript including mid-line cuts, which is why `fingerprint` REFUSES a lane whose parent session carries no tool_result: a mid-flight fingerprint records a short touched set, and a short touched set routes a stale lane to reuse.

  **Still open / handoff:** `package.json` and `docs/bugs/INDEX.md` were deliberately left unstaged — both carry concurrent lanes' uncommitted changes — so the npm alias for the verify script is a one-line follow-up once package.json is quiet. Nothing wires the rule into dispatch yet; it is a check and a decision a coordinator calls, by design. An independent clean-room verify pass is warranted: this is regression-prone territory (it decides whether a context is trusted) and generation must not be its own only verifier.
