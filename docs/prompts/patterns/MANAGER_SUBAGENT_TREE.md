# Pattern — Recursive manager→sub-agent trees

**Shape:** a 2-level fan-out. One manager agent per DOMAIN (not per task) owns
that domain end-to-end and dispatches its own sub-agents for the individual
units of work inside it. The top-level orchestrator only talks to the domain
managers, never reaches past them into their sub-agents.

## When to use
- The work naturally splits into a handful of HETEROGENEOUS domains (e.g.
  "security", "performance", "docs") where each domain needs its own
  judgment calls about how to further subdivide.
- A flat fan-out (orchestrator → N leaf agents directly) would force the
  orchestrator to understand every domain's internal structure, which doesn't
  scale past a few domains.
- You want a domain's internal churn (retries, re-splitting a sub-agent's
  work) to stay contained — the orchestrator shouldn't need to know a domain
  manager retried three times before it lands.

## When NOT to use
- The task is a single flat list of independent units — just fan out directly,
  a manager layer adds coordination overhead for no isolation benefit.
- Only one domain is in play — there's nothing to manage between domains.

## How to run it
1. Orchestrator identifies domains, writes one crisp brief per domain (what
   "done" looks like for that domain, and any cross-domain constraints —
   e.g. "don't touch files domain B also owns").
2. Dispatch one manager agent per domain, in parallel where domains don't
   share files.
3. Each manager decomposes ITS domain into sub-agent tasks, dispatches them
   (sequentially or in parallel per its own file-overlap rules), and is
   responsible for synthesizing its sub-agents' results into one domain-level
   report back to the orchestrator.
4. The orchestrator only reads domain-level reports — never raw sub-agent
   output — keeping its own context budget flat regardless of how many
   sub-agents any one domain used internally.

## Failure modes to avoid
- Orchestrator bypassing a manager to talk to its sub-agents directly —
  breaks the isolation the pattern exists for.
- A manager fanning out sub-agents that touch the same file without
  serializing them — same same-file hazard as any parallel dispatch, just
  scoped one level down.
