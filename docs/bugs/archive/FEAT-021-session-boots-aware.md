# FEAT-021 — Session boots aware: inject the live board snapshot + current focus

- **Status:** VERIFIED — HIGH value (directly answers the user's recurring "memory / always aware of where we are")
- **Area:** claude-station templates / session launch
- **Reported:** 2026-08-04 by user
- **Related:** FEAT-017 (durable system), FEAT-018 (board UI)

## Problem
A fresh session (mine, or any launched via the dashboard) does NOT automatically
know "where we are" — the user must say "read the board." The durable state exists
(docs/bugs/ board, WA template, per-project auto-memory) but isn't auto-surfaced
INTO a new session. Goal: every launched session boots already aware of current
project state, so we never re-sync by hand as context drifts/compacts.

## Design
- Station composes, at session launch (alongside the Working-Agreement template via
  composeInstructions), a DYNAMIC "Project state" section for board-having projects:
  open tickets, 👤 needs-you items, in-flight (🤖), recently-done, and a one-line
  "current focus" — generated read-only from docs/bugs/INDEX.md + ticket frontmatter.
- Refreshed each launch (not static template). Small, capped length.
- Same snapshot powers the in-UI strip (FEAT-018) — one source (the files), two
  surfaces (injected prompt + UI).
- Interplay with Claude's own per-project auto-memory (MEMORY.md): the board is the
  SHARED task state; auto-memory is the agent's private recall. Both help; this
  ticket is the shared, human-visible one.

## Verification (REQUIRED)
Launch-compose a session for a project with a known board → assert the system
prompt contains the current open/needs-you counts + focus line; a project without a
board injects nothing. verify:ui offline + typecheck.

## Context pack
- Touches: src/server/templates.ts / index.ts (compose a dynamic section),
  registry/session-launch wiring. Server-side mostly.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed. This is the concrete "always-aware memory" the user asked about — the
  machine-facing half of FEAT-017; FEAT-018 is its human-facing half.

### 2026-08-04 — implementation (boot-aware injection)
**Understood.** A launched session did not auto-know "where we are"; the durable
state (docs/bugs/ board) existed but was not surfaced INTO the session's system
prompt. Goal: fold a compact, capped live "Project state" snapshot onto the
composed Working-Agreement prompt at launch — ADD to it, never clobber it — and
only for board-having projects (opt-in). Reuse FEAT-018's `readBoard`, do not
re-parse INDEX.

**Changed.**
- `src/server/board.ts` — new `boardStateSection(hostPath, {maxItems,maxChars})`:
  builds the snapshot from `readBoard` (👤 needs-you w/ count, 🤖 in-flight,
  ✅ done-recently, and a one-line **Focus** = highest-priority open item —
  needs-you outranks in-flight). Hard-capped (items 5/list, ≤1200 chars, titles
  truncated) for the per-launch attention budget (FEAT-026/§H). Returns `null`
  for a project with no docs/bugs/ → injects nothing.
- `src/server/templates.ts` — new `appendToSystemPrompt(sp, extra)`: folds an
  extra section onto any of the three `ComposedPrompt.systemPrompt` shapes
  without clobbering (empty extra = no-op). One helper, used by BOTH the launcher
  and the verify, so the verified path is the real one.
- `src/server/agent-bridge.ts` (~line 537, the systemPrompt assembly) — now:
  `sp = appendToSystemPrompt(sp, boardStateSection(hostPath))` then the existing
  `extraAppend`, replacing the old inline `{...sp, append}` block. WA content is
  preserved; board section is appended below it; a board-less project is a no-op.
- `scripts/verify-boot-aware.mjs` + `npm run verify:boot-aware` — exercises the
  REAL compose layer (seeds the real WA template, real composeInstructions, the
  same two functions the launcher calls); no server, throwaway temp dirs.
- Did NOT edit INDEX.md, public/app.js, or the live server (port 4317 untouched).

**Verified.**
- FAIL-before (non-vacuous): ran the script with board.ts/templates.ts stashed
  to pre-code → `FATAL: boardStateSection is not a function`. FAIL.
- `npm run verify:boot-aware` → PASS 12/12. Asserts the folded prompt contains
  BOTH the current needs-you count (2) + a Focus line AND the WA content
  (`# Working Agreement v2` + a body slice) — neither clobbers the other; and a
  no-board project injects nothing yet still gets the WA (append === WA base).
- `npm run verify:ui -- --offline` → PASS 3/3 (0 failed).
- `npm run typecheck` → PASS (exit 0).
- Handoff/open: injection is at launch time (dynamic, refreshed per session), not
  reported in `effectiveConfig()` — a future nicety could surface "board snapshot
  injected" in the UI's effective-config readout, but not required here.
