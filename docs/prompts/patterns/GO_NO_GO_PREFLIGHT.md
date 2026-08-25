# Pattern — Go/no-go pre-flight gate

**Shape:** a short, NUMBERED eligibility checklist that must be walked and
pass in full before real work starts. Not a style guide, not advice — a
gate: any unchecked item is a hard STOP, not a note-to-self.

## When to use
- Starting work under the wrong precondition is expensive to undo (wrong
  branch, wrong environment, a resource that's actually still in use, a
  ticket that's already been fixed by someone else) — cheaper to check first
  than to discover it mid-work.
- The preconditions are a known, finite, checkable list — not a fuzzy
  judgment call. If you can't write it as numbered yes/no items, it's not a
  good fit for this pattern.
- Multiple agents/people run the same kind of task repeatedly — a gate keeps
  the check consistent instead of relying on each one remembering to look.

## When NOT to use
- Preconditions are open-ended judgment calls (e.g. "does this look like a
  good idea") — a checklist gives false confidence there; use human/agent
  review instead.
- The cost of a wrong start is low and cheaply reversible — a gate adds
  friction with no matching payoff.

## How to build it
1. Enumerate the actual failure modes that have happened (or would be
   costly) from skipping a check — each becomes one numbered item. Don't
   pad the list with hypothetical checks nobody has ever needed.
2. Each item must be a fact the agent can verify directly (run a command,
   read a specific file/field) — not "make sure things seem fine."
3. Any single failing item is a full STOP: report which item failed and why,
   do not proceed "just this once." A gate that can be talked past by the
   agent itself isn't a gate.
4. Keep it short — a pre-flight gate that takes longer to run than the work
   it's protecting stops being used. Prefer 3-7 items over 20.

## Failure modes to avoid
- Vague items ("check the environment looks right") that can't be
  objectively passed/failed — turns the gate into theater.
- Skipping the gate under time pressure "this once" — that's exactly when
  the precondition is most likely to be violated.
- Letting the checklist rot (an item references a thing that moved/renamed)
  — a stale gate either false-blocks everything or silently checks nothing.
