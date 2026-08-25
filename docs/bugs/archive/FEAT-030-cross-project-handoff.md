# FEAT-030 — Cross-project handoff: pass curated findings from one project to another (async, not live)

- **Status:** OPEN — LOW prio; recommend the simple file-handoff shape, not live messaging; parked until you prioritise.
- **Area:** claude-station cross-project
- **Reported:** 2026-08-04 by user (e.g. brain-research findings → GPU AI research)
- **Related:** FEAT-021 (boot-aware injection — reused for the inbound surface), the raw-vs-curated pattern (FEAT-020)

## In plain terms
A lightweight way to pass matured findings from one project to another — for the occasional case (a few times
a year) where one project's results should feed into another. It's a real but rare need.

**Recommendation:** a simple file "handoff" — drop a curated note into the other project's inbox and have that
project notice it — rather than a heavy real-time system where two projects' agents talk to each other live.
Building complex live plumbing isn't warranted for something used a handful of times a year.

**What I need from you:** triage only — it's low priority and parked; confirm it stays parked, or raise its
priority.

**If you do nothing:** nothing breaks; it stays a low-priority parked design.

> Everything below is the detailed design (inbox files, inbound awareness, verification) — reference.

## The need (reframed)
Occasionally a project matures findings that should feed another project (brain-research
→ external-project-G). The need is **async + curated** (findings mature over weeks, you
hand over the distilled result), NOT real-time agent-to-agent chat. So the right shape
is a durable HANDOFF, not a live messaging bus.

## Why NOT live agent-to-agent
Two sessions up simultaneously + routing + a protocol is heavy plumbing for a
few-times-a-year, inherently async need — and it would stream RAW context when the
value is the CURATED finding. Revisit only if a genuine real-time case appears.

## Design (lightweight, files-first)
- **"Hand off to project…"** action in the station: source = a curated doc/selection in
  project A; target = project B. Writes `B/docs/inbox/<date>-from-<A>.md` with a
  provenance header (source project + date + optional note). Append-only; files are the
  source of truth (same as the board). Opt-in: only projects with a `docs/` participate.
- **Inbound awareness:** extend FEAT-021's boot-aware injection (and the rail) to surface
  "📥 N inbound handoffs from <A>" so B's next session already knows. B's agent/user then
  files it into B's real docs (accept/dismiss).
- **Curated, not raw:** the handoff carries the rollup/finding, not A's whole context.

## Verification (when built)
Hand off a doc A→B → `B/docs/inbox/<date>-from-A.md` exists with provenance; a B session
boots aware of it (injection/rail shows the inbound count); accepting files it, dismiss
removes it. verify:ui offline + typecheck.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed from a user design question. Recommend the async-handoff shape over live
  messaging. Low prio / parked unless the user prioritizes it.

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
