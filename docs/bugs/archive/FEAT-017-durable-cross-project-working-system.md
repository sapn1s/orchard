# FEAT-017 — Make our working system survive compaction & reusable across all projects

- **Status:** DONE — tiers 1-3 shipped (WA injection + board + tickets skill + FEAT-018 rail)
- **Severity:** high (meta: everything else is ephemeral without this)
- **Area:** claude-station platform / methodology
- **Reported:** 2026-08-04 by user
- **Supersedes/contains:** FEAT-005 (generalize accumulating-context tickets)

## Problem
Everything we've built this session — the ticket/board system, the orchestrator
model, the NEEDS-YOU output contract, the verification-is-the-deliverable ethos,
the git-safety concurrency rules — is only valuable if it OUTLIVES this session
and works in EVERY project via claude-station. Right now it lives in one repo's
docs/ + in this session's context, which dies at compaction. It must become
survivable, re-loading items.

## Design — three durability tiers
1. **Universal methodology → durable text that auto-re-injects every session.**
   Content: orchestrator role; NEEDS-YOU output contract ("nothing important lives
   only in chat"); verification-is-the-deliverable; git-safety (no `git add -A`
   with agents in flight, commit explicit file lists, serialize same-file tickets);
   append-only ticket discipline (orchestrator owns INDEX, agents append only).
   Home candidates: user-level ~/.claude/CLAUDE.md (cross-project, automatic) vs
   project CLAUDE.md (contained) vs a skill (cross-project, on-invoke).

2. **The ticket/board mechanism → a portable `tickets` skill.**
   Invokable in any project; scaffolds docs/<tracker>/ (README+INDEX+TEMPLATE) and
   encodes the append-only + orchestrator-owns-INDEX rules. No server dependency.

3. **Durable store + human surface → a claude-station feature.**
   KEY INSIGHT: the markdown ticket FILES are the durable store (git-tracked,
   portable, survive compaction/restart), the skill WRITES them, and claude-station
   RENDERS + AGGREGATES them across projects — one source of truth, no DB, no sync.
   Surfaces: the in-UI "Needs you / In flight / Done today" strip (the glanceable
   board), a cross-project rollup, and optionally an API/MCP tool so any session in
   any project can append a ticket.

## Open decisions (blocking build)
- D1 Store architecture: files-as-source + station-renders (rec) vs station DB vs skill-only.
- D2 Methodology home: user-level CLAUDE.md (rec, but global) vs project-only vs skill.
- D3 Build order (orchestrator to decide once D1/D2 set).

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed as the umbrella for making the whole working system survivable. Captures
  the 3-tier plan so the PLAN itself survives compaction (the user's own point).
  Awaiting D1/D2 before building.

### 2026-08-04 — orchestrator (decisions + tiers 1-2 shipped)
- **D1 decided:** files live in each project's own docs/ dir, **OPT-IN** — a
  project has a board iff it already contains docs/bugs/. Real repos (this,
  external-project-A) benefit; scratch dirs like ~ do NOT get one. Station will
  RENDER these files, not own a DB.
- **D2 decided:** methodology → user-level ~/.claude/CLAUDE.md (global, consented).
- **Tier 1 DONE:** wrote ~/.claude/CLAUDE.md — output contract (NEEDS YOU),
  orchestrator model, verification-is-deliverable, git-safety, process-safety,
  opt-in board discipline. Re-loads every session in every project.
- **Tier 2 DONE:** wrote ~/.claude/skills/tickets/SKILL.md — portable scaffolder +
  discipline; explicitly NOT for scratch dirs.
- **Tier 3 REMAINING → FEAT-018:** claude-station renders/aggregates the per-project
  docs/bugs/ files (Needs-you / In-flight / Done strip + cross-project rollup).
  Touches app.js+server → waits for the app.js lane to free.

### 2026-08-04 — orchestrator (course-correction: use the mechanism that already exists)
- User pushed back on the global ~/.claude/CLAUDE.md; on inspection the app ALREADY
  has the right mechanism: src/server/templates.ts `composeInstructions()` appends
  selected instruction templates to each launched session's system prompt, and it
  SEEDS a living "Working Agreement v2" (docs/prompts/WORKING_AGREEMENT.v2.md) the
  user evolves. That is the survivable + reusable + opt-in home — a blunt global
  file both duplicated it and polluted scratch (~) prompts.
- **Reversed:** DELETED ~/.claude/CLAUDE.md.
- **Done instead:** appended sections H–K to WORKING_AGREEMENT.v2.md (output
  contract / NEEDS-YOU, orchestrate-multi-item, git-safety-with-agents, opt-in
  board discipline) — the station injects this into project sessions already.
- **Kept:** ~/.claude/skills/tickets (portable scaffolder; complements, doesn't
  duplicate — it creates the docs/bugs/ files a project opts into).
- **Remaining real work:**
  - FEAT-018 — station renders the per-project board (human-facing glanceable strip).
  - Board-snapshot INJECTION — extend composeInstructions so a launched session in a
    board-having project also gets the current open/needs-you tickets appended, so
    every session boots already in sync with the board (machine-facing sync). Needs
    its own small design (composeInstructions is static templates today). Noted here;
    ticket when we pick it up.
  - Make the v2 edits LIVE: the seeded template copy under <data>/templates/ only
    seeds when absent, so the repo edit doesn't auto-update a running install —
    sync needed (see board note).

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
