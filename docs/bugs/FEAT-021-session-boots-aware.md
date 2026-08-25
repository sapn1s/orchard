```orchard-ticket
{
  "id": "FEAT-021",
  "type": "feature",
  "title": "Fresh sessions started without knowing the project's current state",
  "summary": "A newly launched session now begins with a short, freshly generated picture of the project's ticket board: what is open, what needs a person, what is in flight, what recently finished, and a one-line current focus. Previously someone had to tell each session to go read the board. Projects with no board get nothing added.",
  "impact_if_we_wait": "Every new or compacted session would need a manual re-sync before it could work. Bounded: this affects session start-up awareness only. The board files themselves are read-only here, and nothing about stored project data changes.",
  "current_need": "Nothing is outstanding. The board-aware launch behaviour and the existing interface checks both passed, with standing checks clean.",
  "severity": "medium",
  "area": "Session launch awareness",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A launched session's instructions carry the project's open and needs-a-person counts",
    "A launched session's instructions carry a one-line current focus",
    "A project with no board has nothing injected at launch",
    "The snapshot is regenerated at each launch rather than baked into a static template",
    "The injected section stays within a small length cap"
  ],
  "code_refs": [
    {
      "path": "src/server/templates.ts",
      "symbol": "composeInstructions",
      "note": "composes the dynamic project-state section alongside the Working Agreement template"
    },
    {
      "path": "src/server/index.ts",
      "symbol": null,
      "note": "session-launch wiring that supplies the snapshot at launch time"
    },
    {
      "path": "docs/bugs/INDEX.md",
      "symbol": null,
      "note": "read-only source for the snapshot, together with per-ticket frontmatter; FEAT-021 generates from these files rather than storing its own copy"
    }
  ],
  "related": [
    {
      "id": "FEAT-017",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-018",
      "relation": "see_also"
    },
    {
      "id": "FEAT-020",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-023",
      "relation": "blocks"
    },
    {
      "id": "FEAT-025",
      "relation": "see_also"
    },
    {
      "id": "FEAT-026",
      "relation": "see_also"
    },
    {
      "id": "FEAT-029",
      "relation": "see_also"
    },
    {
      "id": "FEAT-030",
      "relation": "blocks"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-021-session-boots-aware.md",
    "sha256": "790ed22810891dddd09b0b2b92b6962bd21b5223d93c5bbb6b90d199deac905c",
    "bytes": 4818,
    "original_title": "Session boots aware: inject the live board snapshot + current focus",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Checked field by field against the original head: the manual re-sync problem, the per-launch read-only generation, the shared-versus-private distinction, and both launch cases survive.",
    "dropped": [
      "the ticket's own restatement of which files it would touch, now carried in code_refs"
    ]
  }
}
```

# FEAT-021 — Fresh sessions started without knowing the project's current state

## Diagnosis

The durable project state already existed in the ticket board, the Working Agreement template and per-project auto-memory, but none of it reached a new session automatically. The person launching the session had to say "read the board" every time, and that cost recurred whenever context drifted or compacted.

## Evidence

The board-awareness suite passed 12 of 12 checks and the interface suite passed 3 of 3. Typecheck stayed clean.

## Implementation notes

The project-state section is generated read-only at each launch from the board index and ticket frontmatter, and capped in length. The same snapshot feeds the in-product board strip, so the files remain the single source behind both the injected instructions and the interface.

The board is the shared, human-visible task state; the agent's own per-project recall is separate and private. This ticket covers only the shared half.

## Verification plan

Compose a launch for a project with a known board and assert the resulting instructions contain the current open and needs-a-person counts plus the focus line. Compose a launch for a project without a board and assert nothing is injected.

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
