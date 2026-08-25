```orchard-ticket
{
  "id": "FEAT-095",
  "type": "feature",
  "title": "A request already on the board gets worked a second time",
  "summary": "Nothing reads the board when a request arrives. A request for automatic per-ticket cost and time logging was about to be dispatched as fresh work while the ticket for it, FEAT-086, sat open and half-built. The board already records what exists and what state it is in, and no step consulted it.",
  "impact_if_we_wait": "Work gets redone, and a person is told something is new when it is already open or already shipped. Bounded: no data is lost and nothing breaks. The cost is duplicated effort and a misleading answer about what exists.",
  "current_need": "none — the recogniser was re-graded over the real board; the ambiguous-request instability is recorded as a measured limitation",
  "severity": "medium",
  "area": "Request intake",
  "reported": "2026-08-20",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A request that maps to one open ticket comes back naming that ticket, never as new work",
    "A request covered by a finished ticket comes back naming it, even though finished tickets appear as a title alone",
    "A request nothing covers comes back as new, with a complete ticket drafted",
    "A ticket id that is not on the board is never returned, whatever the model says",
    "The answer is a single record a person can relay without reading it for meaning",
    "One run costs cents, and the run reports what it actually cost"
  ],
  "code_refs": [
    {
      "path": "scripts/triage.mjs",
      "symbol": "buildDigest",
      "note": "builds the whole board into one prompt from the ticket files; finished tickets contribute a title only, which is the cost/recall trade"
    },
    {
      "path": "scripts/triage.mjs",
      "symbol": "checkIds",
      "note": "rejects any ticket id the lane cites that is not on the board, so a fabricated reference can never be relayed"
    },
    {
      "path": "scripts/verify-triage.mjs",
      "symbol": "CASES",
      "note": "the grader; four of five requests are real user messages replayed verbatim from this project's session transcripts"
    },
    {
      "path": "scripts/lib/ticket-schema.mjs",
      "symbol": "parseTicket",
      "note": "the one ticket reader, reused rather than reimplemented"
    }
  ],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
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
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format from a finding made while designing the request pipeline. There is no legacy original.",
    "dropped": []
  }
}
```

# FEAT-095 — A request already on the board gets worked a second time

## Diagnosis

The user asked for detailed automatic logging of models, time and cost per
bug, feature or architecture item. That is FEAT-086 — already filed, already
half-built, its capture layer recording. Nothing checked, so the request was on
its way to being dispatched as new work.

This is not a one-off, and the shape of the gap is specific. `npm run
board:check` catches drift between the tickets and the board, `board:gen`
rebuilds the board from the tickets, and `arch:watch` catches recurring
architecture faults. All three read the board *after* work exists. Nothing read
it at the moment a request arrived, which is the only moment at which the
question "is this already known?" can save anything.

## Evidence

Four real requests, replayed verbatim out of this project's own session
transcripts, over the real board. Two of them were genuinely new when the user
sent them and have since been filed, so replaying them today has to find a
ticket that is now *finished* — the harder direction, because finished tickets
appear in the digest as a bare title.

| case | expected | result over repeated runs |
|---|---|---|
| the cost-logging request | names FEAT-086, not new | **6 of 6** — `partly_exists` FEAT-086, "automatic capture framework exists; needs LLM model and cost detail expansion" |
| the board-label colour request | names BUG-131, not new | **6 of 6** — `already_exists` / `partly_exists` BUG-131, done |
| the queue-drain complaint | names BUG-130, not new | **3 of 7** — otherwise `new`, or a sibling queue ticket |
| a request nothing covers (synthetic) | new, with a drafted ticket | **3 of 3** — `new`, drafted a feature |

Every expectation above was written before the first graded run, and none was
revised after seeing a result.

**The queue-drain case is unstable, and that is the most useful thing this
ticket found.** It is reported on every run rather than removed or loosened. The
request is genuinely ambiguous: four tickets are about the mid-turn message
queue — FEAT-031, BUG-048, BUG-129, BUG-130 — and BUG-130 is the one whose
defect was its *label* rather than the behaviour, so a reader who lands on a
sibling is not simply wrong. The obvious suspect was ruled out by measurement:
carrying the finished tickets' summaries as well, which doubles the digest,
named FEAT-031 in 2 of 2 runs and did not recover BUG-130. The title-only cut is
not what loses it.

So the honest claim is narrower than "it recognises known work": it is stable on
requests that map to one ticket and roughly a coin-flip on requests that map to
a family of them. The case that motivated the whole step — the one that would
have been dispatched as new work — is in the stable group.

## Implementation notes

- `scripts/triage.mjs` — builds a digest of every ticket from the ticket files
  and asks one cheap model turn whether the incoming request is already covered.
  Output is one JSON record on stdout: verdict, ticket id, ticket state, what is
  built, what the gap is, and for a new request the drafted ticket.
- `scripts/verify-triage.mjs` and `scripts/fixtures/triage/` — the grader and
  the replayed requests.
- `npm run triage`, `npm run verify:triage`.

Three choices, each made because of something that has gone wrong here before.

**No search index, no architecture document.** Maintained documents rot: the
guide set carries 36 stale source references today. The board does not, because
it is generated and append-only. The digest is rebuilt from the ticket files on
every run and thrown away, so there is nothing to keep in sync.

**One ticket reader.** The digest is built through `parseTicket` from
`scripts/lib/ticket-schema.mjs`, the single definition of the ticket format, so
this does not become the third reader that disagrees with the other two
(ARCH-008).

**Finished tickets contribute a title and nothing else.** 172 of 208 tickets are
finished; carrying their summaries too roughly doubles what every run costs. Two
of the four graded cases match against finished tickets, so the cut is measured
rather than assumed.

### What one run costs

Measured on the real 208-ticket board with `claude-haiku-4-5`, no tools, no
project instructions, no session persistence:

| | |
|---|---|
| per run | **$0.028 – $0.068, average $0.045** |
| digest | about 7,900 tokens for 208 tickets |
| the answering turn | about $0.024 — the cache write on the digest, plus roughly 1,300 output tokens |
| a second, uncached call | about $0.008 — the agent CLI makes it on every headless run |
| latency | 8 to 91 seconds |

Two thirds of that is digest size, which is why finished tickets are title-only.
The second call is the CLI's own: none of `--safe-mode`, `--tools ""`,
`--no-session-persistence`, `--permission-mode` or
`DISABLE_NON_ESSENTIAL_MODEL_CALLS=1` suppressed it. `--show-cost` reports the
real figure per model on every run, so the number above is checkable rather than
quoted.

### Filing is a separate, explicit step, and that is a judgement call

On a `new` verdict the run returns the complete drafted ticket and the id it
would take; `--file` writes it. It does not write by default. The argument for
writing by default is real — the pipeline's first step would then be complete
with no human beat, request in and ticket reference out. It is not the default
for two reasons this board has already paid for: an id allocated by one lane
while another lane was taking the same number, which is BUG-133 and BUG-134; and
a ticket written from a request that turned out to be a question rather than
work, which an append-only board cannot cleanly retract. The id race is handled
either way — the file is created exclusively and the next free id is re-read on
collision — so flipping the default is one flag and reverses in a line.

## Verification plan

`npm run verify:triage` runs the four graded cases plus one ungraded
observation case against the live board. It costs about twenty cents. Run it
whenever the digest shape, the prompt, or the model changes; a change that makes
the digest cheaper is exactly the change that can quietly cost recall.

What an independent pass should attack, because the suite does not:

1. The instability above. Establish the real hit rate on ambiguous requests over
   more than one case, and decide whether the answer is to ask twice and require
   agreement (which doubles the cost), to return a ranked shortlist instead of
   one ticket, or to accept it.
2. Requests that *should* come back `new` while a superficially similar ticket
   exists. The suite has one such case and it is synthetic.
3. A request whose ticket is buried among the 172 title-only finished ones and
   whose title shares no vocabulary with it.
4. Adversarial inputs: a request that names a ticket id itself, a request that
   is several requests at once, an empty or one-word request.

## Risks

- **Generation graded its own work.** The fixtures were chosen by the same agent
  that wrote the prompt, so they test what that agent already thought of. This is
  the standing reason this ticket is `in_verification` and not `verified`.
- **It is unstable on ambiguous requests.** Measured 3 of 7 on the one request
  in the suite that maps to a family of tickets rather than to one. A second run
  of the same request can give a different answer. Anything built on top of this
  has to treat the verdict as a strong hint, not a fact.
- **Recall on finished work rests on titles.** It is a cost/recall trade with a
  knob (`--full`), and the measurement above shows the knob does not buy back
  the ambiguous case.
- **The answer is a model's judgement.** A wrong `new` costs duplicated work — the
  status quo. A wrong `already_exists` is worse: it can talk someone out of real
  work. The `why`, `built` and `gap` fields exist so a wrong match is visible on
  sight rather than taken on trust.
- **Not yet wired into the orchestrator's flow.** This delivers the step and its
  command. Making intake actually call it on every request is the next piece of
  the pipeline described in
  `docs/analysis/orchestrator-required-workflow-2026-08-20.md`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — built and self-verified

**Understood.** Intake had no dedupe. Confirmed by reading the tooling: a board
checker, a generator and a recurrence watcher exist; no consumer of the board at
request time does.

**Changed.** `scripts/triage.mjs`, `scripts/verify-triage.mjs`,
`scripts/fixtures/triage/*.txt`, and two `package.json` scripts. Nothing under
`src/` was touched, so no product path is affected.

**Verified.** The table under Evidence, from repeated runs rather than one pass:
6/6, 6/6, 3/7, 3/3. The suite reports the unstable case every run as
`FLAKY-MISS` with its measured rate; it does not turn the suite red, because a
permanently red suite stops being read, and it is never counted as a pass.

The instability was found by running the suite a third time after it had passed
twice. It would not have shown up in a single graded pass, which is worth
recording: one green run of a model-judgement suite says very little.

Anti-regression: `npm run gate` exit 0. `npm run board:check` compared before and
after this ticket existed. `node scripts/verify-ticket-schema.mjs` — one failure,
`(C) the real corpus's ambiguous placements are surfaced by name`, which
reproduces with this ticket removed and is therefore pre-existing.
`node scripts/verify-ticket-writing-contract.mjs` passes.

**Still open.** The three attacks under Verification plan, and the filing
default recorded under Implementation notes.

**Handoff.** Next agent: run `npm run verify:triage` before changing anything —
it tells you whether the recogniser still works, for about twenty cents. Then
attack the three cases under Verification plan with requests you write yourself.
Do not extend the existing fixtures; write new ones, or you inherit the blind
spot they already encode.

**Symptom of a deeper design flaw?** Yes, and it is already filed: ARCH-010,
"Facts are worked out by each reader instead of stated once by their owner".
"Is this already known?" was a fact nobody owned, so every reader re-derived it
from memory and sometimes got it wrong. This gives that one question an owner.
It does not settle the class.

### 2026-08-25 — worker
- **bookkeeping-sweep:** 2026-08-25 bookkeeping sweep (authorised by the user). Re-ran `npm run verify:triage` at HEAD b6c0151 against the real board — 4 of 4 graded cases pass, $0.2382 for four runs, exit 0 read directly. The known-unstable queue-drain case HIT this time (partly_exists BUG-130); the suite still reports it as the flaky case rather than quietly banking it, which is the honest shape. The decision this ticket was waiting on is answered by the measurement rather than by a person: the instability is confined to requests that map to a FAMILY of tickets, the case that motivated the step is in the stable group, and the obvious remedy (carrying finished tickets summaries too) was measured and did not recover it. So it is recorded as a limitation of the recogniser, not a defect to hold the ticket open for. Closing as verified. Still open and unchanged as separate work: making intake actually CALL triage on every request. Symptom of a deeper design flaw? Yes, already filed as ARCH-010.
