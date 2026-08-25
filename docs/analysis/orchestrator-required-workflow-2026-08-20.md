# The workflow the user wants — a requirement, not a proposal

Recorded verbatim so the design work is measured against it rather than against
an orchestrator's paraphrase. Written 2026-08-20.

## The user's own words

> we need to implement detailed automatic logging which logs each bug/feat/arch
> info about llm models used, what for, how much time it took, whats the
> estimated cost
>
> basically like jira where devs assign hours it took them, but we make it
> automatic data gathering, and more of a breakdown per things like: "finding
> bug", "fixing bug", "verifying fix" etc
>
> The goal is to see if our process seems to take reasonable time, eg, an ui fix
> taking 2 hours for llms might point to something broken in our architecture and
> make us re-think how to change it so such types of bugs in future solve in
> 10min, basically to have enough data to know what to even solve and how.

And the pipeline they picture:

> 1. an orchestrator decides who to give it to, perhaps orchestrator themselves
>    might just file ticket? or whatever in pipeline is first > moving the request
>    into a ticket.
> 2. The ticket then gets sent to some pipeline: perhaps it needs more planning?
>    (planning board) if it touches many components or so, or if not, its directly
>    given for subagent to solve.
> 3. subagent writes the code changes, any relevant info into the ticket and then
>    passes it to whoever is to verify
> 4. verifier like QA tester checks if all good, if not, reopens ticket > hand it
>    back to same subagent that worked on it, since it already has the context
>    (problem is stale context, so maybe not same?)
> 5. ticket state is eventually updated to solved > somehow the original
>    orchestrator is notified and can inform the user with a single message of
>    ticket solved or awaiting decision

They add: *"im likely missing many steps and complexity, but here is my idea
approximate of how i imagine it works"*.

## What this pins down

- **The unit of accounting is the ticket**, not the session or the lane. Time,
  cost and model must be attributable to a bug/feature/architecture item.
- **Phases are lifecycle phases**, not tool categories: finding, fixing,
  verifying. The existing collector derives phases from what agents *did*
  (investigating / building / testing). That is a different axis and does not
  answer "how long did verifying this ticket take".
- **The purpose is diagnostic, not accounting.** A UI fix taking two hours is
  evidence about the architecture. The data exists to decide what to change.
- **One user-visible message per ticket**, at completion or at a decision. Not
  turn-by-turn narration.
- **A ticket is the request's durable form** — the request becomes a ticket
  early, and state lives there rather than in an orchestrator's context.

## The question the user raised and did not answer

On reopening after a failed verification: hand it back to the same worker,
which already holds the context, or to a fresh one, because that context is
stale? They named the trade themselves. It is a real design question and the
answer is not obvious — the same worker is cheap and carries its own blind spot;
a fresh worker is decorrelated and pays a cold start. Measured here: a lane's
cold start is ~11.8k tokens (~$0.046), and generation grading its own work is
the single most common source of false greens on this board.

## What already exists

`npm run cost:collect` (`scripts/cost-collect.mjs`, `scripts/lib/cost-model.mjs`)
already produces, from transcripts and without anyone remembering to log:
per-lane and per-ticket rows with lanes, turns, agent-hours, API-equivalent cost
and the verdict chain; a phase breakdown; and a model/tier/provider table. It is
retroactive over lanes that ran before it existed and costs nothing at runtime.

## What is missing, and why it is a design question rather than a build

The gaps are recorded in `docs/analysis/pipeline-cost-2026-08-20.md` as G1–G8.
The important ones here:

- **Phase is inferred from tool use, not declared.** Nothing records that a lane
  was *verifying BUG-113* as opposed to *fixing* it.
- **Round number and dispatch class are not recorded**, so the yield curve has to
  be reconstructed from prose.
- **Verdicts live in prose.** In an entire measured window, one turn wrote a
  structured verdict anywhere.
- **Blocked time is not distinguished from working time**, so "half the window
  was idle" cannot be broken into waiting-on-a-decision versus waiting-on-a-lane.

Each of those is a fact that should be *declared by whoever owns it* at the
moment it happens. That is the same class already identified as the source of
49% of defects — which is why closing these gaps belongs inside the orchestrator
redesign rather than beside it. Where the phase gets recorded depends on what
the pipeline looks like.
