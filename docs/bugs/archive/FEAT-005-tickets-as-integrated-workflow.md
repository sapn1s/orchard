# FEAT-005 — Generalize accumulating-context tickets into the workflow

- **Status:** DONE — SUPERSEDED by FEAT-017 (durable working system)
- **Severity:** low (meta / tooling)
- **Reported:** 2026-08-03 by user

## Motivation
The append-only ticket pattern (docs/bugs) is not app-specific — it's how any
multi-agent development should keep memory so fixes accumulate instead of
cold-starting and regressing. The user wants this integrated into their agentic
workflow over time, not a one-off directory.

## Options (to choose among)
1. **Convention only (now):** the docs/bugs discipline + a reusable dispatch
   preamble every fix-agent gets ("read the whole ticket, don't repeat a logged
   failed approach, append your entry, run the full verify suite, hand off if
   incomplete"). Zero new code. In use as of this ticket.
2. **A skill / slash-command:** `/ticket new`, `/ticket work <id>` that scaffolds
   a ticket and dispatches an agent with the discipline + full ticket context
   baked in. Repo-local, low effort, repeatable.
3. **A claude-station feature (the durable form):** since claude-station IS a
   Claude-session orchestration dashboard, tickets become first-class objects
   attached to a project/session: an append-only context log, linked commits,
   and a "dispatch a fix-session" button that launches a session pre-loaded with
   the ticket and required to append its outcome. The tool would host its own
   bug process. This is the ambitious version and a real product direction.

## Recommendation
Run on (1) immediately (already active). Prototype (2) as the low-cost bridge.
Treat (3) as a genuine feature to design once the manual pattern has proven its
shape on real tickets (BUG-001, BUG-004 are the first proving grounds).

## Activity log (APPEND-ONLY)

### 2026-08-03 — orchestrator
- Established (1): rewrote docs/bugs/README + TEMPLATE for append-only Activity
  logs, read-all-before, full-suite verify, explicit handoff. First tickets
  under it: BUG-004 (with 3 prior attempts retro-logged as the demonstration).
