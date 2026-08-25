# The architecture-review loop (FEAT-056)

A ticket board optimises for CLOSING tickets. Every agent is scoped to one
ticket, so every fix is local by construction, and nothing in the loop ever asks
"should this subsystem exist in this shape at all?". The Working Agreement
already says a symptom fixed 2–3× means the design is wrong — but until now that
rule only fired when a human happened to remember the pattern. Memory does not
survive compaction, session boundaries, or a different project.

This loop is the mechanical half. It works in **every onboarded project**, not
just claude-station.

## What fires, and when

| Piece | What it does | Where it runs |
|---|---|---|
| `scripts/arch-watch.mjs` | Clusters the project's tickets by declared subsystem; flags clusters over the recurrence threshold; writes findings for the rail | Copied into every onboarded project by `onboard.mjs`; run as `npm run arch:watch` |
| The consolidation loop | Runs an arch-watch pass on the local board on every pass (server boot + after every WA capture) | claude-station's `scripts/wa-consolidate.mjs` |
| The Needs-You rail | Renders un-dismissed findings as read-only attention rows with a Dismiss affordance | The project's own dashboard rail |
| `docs/bugs/TEMPLATE-ARCH.md` | The `ARCH-###` ticket: where a redesign DECISION lives once a human makes one | The project's board |
| `TEMPLATE.md`'s closing question | "Symptom of a deeper design flaw? (no / yes → ARCH-### filed)" — answered when a ticket is closed | Every ticket |

There is no fourth schedule and no daemon: the rule travels in the shared
Working Agreement (§N, injected into every launched session), the tool travels
by onboarding, and findings surface per project.

## What you see

A row in that project's Needs-You rail:

> **Architecture review: subsystem patched repeatedly**
> 4 tickets (3 closed, 1 open) in the "agent+live+bridge" subsystem: BUG-020,
> BUG-030, BUG-033, BUG-034 — shared files: src/server/agent-bridge.ts (3
> tickets), … — 3 closed tickets in this cluster (≥ 3)

Every finding names its EVIDENCE: which tickets, which shared files, and which
threshold it crossed. It is a QUESTION ("is the design wrong here?"), not a
verdict. The two valid answers are: file an `ARCH-###` ticket, or state
explicitly why another local patch is right.

## What it will NEVER do

- **Never auto-refactor.** Nothing in this loop edits code. Lossy judgment calls
  surface; only mechanical safety auto-applies, and a refactor is never
  mechanical.
- **Never file a ticket for you.** `ARCH-###` tickets are written by a human (or
  an agent a human dispatched), from `TEMPLATE-ARCH.md`.
- **Never use an LLM to decide.** The detector is pure computation over ticket
  files plus git; it is reproducible and auditable.
- **Never break a pass.** A malformed board, an unreadable ticket, a missing git
  history, or an exception inside the detector degrades to one console warning.
  It can never fail server boot or a consolidation run.
- **Never leak across projects.** Project B's clusters surface on project B's
  rail only.

## How the detector decides (the signal)

Each ticket is fingerprinted from its **declared `- **Area:**` line + H1 title**.
Tokens too rare (< 2 tickets) or too common (> 25% of the board — "server", "ui",
"session") are dropped by document frequency, not by a hand-tuned blocklist.
Ticket ids cited in an Area line ("(BUG-020 sibling)") are a human explicitly
declaring kinship and add a similarity bonus. Tickets are then partitioned by
average-link agglomerative clustering.

Git-touched files are used only as corroborating EVIDENCE, never as the
clustering key: ticket→commit attribution is by commit-message grep and triage
commits name many tickets at once; hub files (one big frontend file) are touched
by a third of all tickets and collapse everything into one meaningless blob; and
open or never-committed tickets have no commits at all.

Because a partition draws a hard line where the data has a gradient, each cluster
also reports its nearest neighbour ("adjacent cluster — may be ONE class").

## Tuning the thresholds

Flags on `arch-watch.mjs` (each also an env var):

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--min-tickets=N` | `ARCH_MIN_TICKETS` | 3 | Flag at N CLOSED tickets in one cluster |
| `--window-days=N` | `ARCH_WINDOW_DAYS` | 30 | Recency window |
| `--min-in-window=N` | `ARCH_MIN_IN_WINDOW` | 2 | …or N closed tickets inside that window |
| `--similarity=F` | `ARCH_SIMILARITY` | 0.16 | Average-link merge threshold (higher = tighter, more clusters) |
| `--max-df=F` | `ARCH_MAX_DF` | 0.25 | Token document-frequency ceiling |
| `--max-findings=N` | `ARCH_MAX_FINDINGS` | 5 | Cap on findings put on the rail (the CLI always prints all of them) |

Other flags: `--dir=<board dir>`, `--json`, `--persist` (write the findings
file), `--all` (list every cluster, flagged or not), `--quiet`.
Exit code 1 means "≥1 cluster over threshold" — a signal, not an error.

On a young board where every ticket was filed within a few weeks, the
`--window-days` rule fires for almost every cluster; that is what
`--max-findings` (rank by closed-ticket count) is for. On an older board, raise
`--min-tickets` instead.

## Dismissing a finding

The rail's Dismiss records `{finding id → the finding's current date}` in
`docs/bugs/.arch/acks.json`. The finding id hashes the cluster's label and its
**member set**, so:

- a dismissal holds while the cluster is unchanged (re-running the detector does
  not resurrect it);
- the moment a **new ticket joins that cluster**, the id changes and the question
  is raised again — which is exactly when it is worth asking again.

`docs/bugs/.arch/` is derived state and never committed (the directory ships with
a self-ignoring `.gitignore`).

## How a new project gets the whole loop

One run:

```
node scripts/onboard.mjs /path/to/project        # from claude-station
```

That scaffolds `docs/bugs/` (INDEX, README, TEMPLATE, TEMPLATE-ARCH), copies
`scripts/board.mjs` **and** `scripts/arch-watch.mjs` into the project, and wires
`board:check` / `board:gen` / `arch:watch` into its `package.json`. The RULE
arrives separately and automatically: the shared Working Agreement (§N) is
injected into every session launched on that project.

Keeping the fleet current: `node scripts/fleet-sync.mjs --apply` re-syncs both
copied tools across every registered, onboarded project (hands-off projects are
excluded by default and there is no flag to override that).

Cross-provider by default when the review is dispatched: the ROUTING rule sends
an architecture review to the provider that did NOT write the code, for
decorrelated blind spots.
