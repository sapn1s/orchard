# Pattern — Explore dispatch (options, not a build)

**Shape:** a dispatched agent whose deliverable is 2–3 viable APPROACHES with
trade-offs and one recommendation — and which **builds nothing**. Not a
softer fix charter: the charter explicitly forbids editing product code, so
the agent cannot quietly converge on the first idea it has and start typing.

## When to use
- You cannot name the CAUSE in one sentence, or you can name more than one
  defensible approach. That is the test: if either is true, this is an
  `explore`, not a `fix` (Working Agreement §I dispatch classes).
- The orchestrator's reading of the problem is a guess it has not paid to
  test. A charter encodes the orchestrator's framing; an `explore` is the
  dispatch class that puts that framing on trial instead of executing it.
- The cost of building the wrong thing exceeds the cost of one extra agent.
  An `explore` that concludes "the obvious fix was right" is cheap; a `fix`
  built on a wrong framing is the whole chain wasted.

## When NOT to use
- The cause and blast radius are both known and stateable — that is a `fix`,
  and an explore step there is pure latency.
- The decision is high cost-of-mistake (stateful / concurrent / data-loss, or
  the Nth bug in a class): use `plan+review` instead — explore is only its
  first half, with no independent critique of the result.
- As a stalling device when the real blocker is a user decision. Ask.

## How to run it
1. Write the charter with an explicit **Hypothesis (verify FIRST)** block —
   your current reading, labelled as a guess, with "if it is wrong, STOP and
   report rather than build on it."
2. State the deliverable as a hard contract: **2–3 approaches, each with
   trade-offs and a cost, plus ONE recommendation and what would falsify it.**
   Name the "builds nothing" constraint in the charter, not just in your head.
3. Give the agent the evidence, not your conclusion: the ticket, the failing
   observation, the files. A charter that says "figure out how to do X" has
   already picked X.
4. Require the agent to say which approach it would NOT take and why — a
   report with three equally-blessed options has pushed the decision back to
   the orchestrator, which is the work that was delegated.
5. The orchestrator (or the user, if it is theirs) picks. The build is a
   SEPARATE dispatch, charted from the chosen option.
6. Record the class (`explore`) in the ticket, so a later pass can audit how
   often `fix` dispatches should have been explores.

## Cross-provider note
`explore` MAY be cross-provider (a planner from the other provider gives a
decorrelated framing) — optional, per ROUTING's budget rules. `plan+review`
is where cross-provider is the default, not here.

## Failure modes to avoid
- The agent "explores" and then helpfully implements its favourite option —
  the charter must forbid edits explicitly, and the report is rejected if it
  arrives with a diff.
- Options that are the same option in three costumes. Genuinely different
  approaches differ in what they give up, not in naming.
- A recommendation with no falsifier — "I recommend B" without "B is wrong
  if <observable>" is a preference, not analysis.
- Exploring what is already written down: check the ticket, board and existing
  mechanisms first (§B) before generating options for a solved problem.
