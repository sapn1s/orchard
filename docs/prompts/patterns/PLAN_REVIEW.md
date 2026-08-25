# Pattern — Plan review before the build (cross-provider)

**Shape:** two dispatches before a line of product code is written. First an
`explore` produces a PLAN; then an INDEPENDENT agent — the other provider by
default — critiques that plan and may reject it. Code review catches bad
execution; this catches a bad plan executed well, which is the expensive one.

## When to use
- The change is HIGH cost-of-mistake per Working Agreement §N: stateful /
  concurrent / reload / data-loss logic, or the Nth bug in a sibling class.
- Undoing the change would cost more than the review round-trip. Migrations,
  protocol/contract changes, and anything a user's data flows through.
- The plan rests on an inherited diagnosis nobody re-derived. Real saves have
  come from exactly here: an agent found that a forwarded diagnosis's "point 2,
  as literally written, would have been a regression"; another proved a filed
  bug was a misdiagnosis and the feature worked.

## When NOT to use
- Contained, reversible work with a known cause — that is a `fix`; a plan
  review there is ceremony, and blanket rigor kills the velocity this way of
  working exists for (§N).
- The plan is one obvious step. Reviewing "add the missing null check" wastes
  the scarce provider's window.

## How to run it
1. **Dispatch the plan** as an `explore` (see the explore pattern): 2–3
   approaches, trade-offs, one recommendation, builds nothing.
2. **Dispatch the review to a DIFFERENT agent — cross-provider by default.**
   The reviewer must not be the planner and should not inherit the planner's
   context beyond the artifacts: the ticket, the plan, the code it touches.
   Same-provider review shares the planner's blind spots, which is the exact
   correlation this pattern is buying its way out of.
3. Charter the reviewer to REFUTE, not to bless: "find where this plan is
   wrong, what it silently assumes, what it breaks that it does not mention,
   and what a cheaper plan would achieve. State a verdict: GO / GO-WITH-CHANGES
   / NO-GO, with the specific reason."
4. Carry the planner's **Hypothesis (verify FIRST)** block into the review —
   the reviewer's first job is to test the premise, not to polish the design
   built on top of it.
5. The orchestrator resolves: adopt, revise, or send back. NO-GO is a real
   outcome — if the reviewer can never block, this is theater.
6. Only then dispatch the BUILD, charted from the reviewed plan, and record
   `plan+review` as the class in the ticket.

## Cross-provider note
Default the reviewer to the OTHER provider than the intended implementer:
decorrelated framing is the whole value, and it is worth the cost precisely
because this class is chosen only when a mistake is expensive. Under the
current budget rules the scarce provider's capacity is reserved for exactly
this kind of work rather than for bulk volume — see ROUTING.md.

## Failure modes to avoid
- A reviewer that is given the plan and asked "does this look right?" — it
  will say yes. Ask for the strongest case AGAINST.
- Reviewing the plan the orchestrator already decided on, after the build has
  quietly started. The review has to be able to change the outcome.
- Letting the reviewer redesign from scratch: its job is a verdict on THIS
  plan plus specific defects, not a competing plan of its own (that is another
  `explore`).
- Skipping straight to code review "because we'll catch it there" — by then
  the framing error is already implemented and defended.
