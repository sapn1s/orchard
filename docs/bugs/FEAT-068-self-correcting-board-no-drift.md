```orchard-ticket
{
  "id": "FEAT-068",
  "type": "feature",
  "title": "Completed tickets stayed in the open list indefinitely",
  "summary": "Finished and deployed tickets kept sitting in the board's open list, and their one-line status could contradict the ticket itself, so the counts a reader trusted were wrong. Each regeneration now takes an open row's status from the ticket header, treats a fixed ticket as done, and flags a ticket still marked as needing a person after it is finished.",
  "impact_if_we_wait": "The board would keep overstating how much needs attention, and the drift never healed on its own. Bounded to how work is displayed and counted: no ticket content is altered, and the tickets themselves stayed accurate throughout.",
  "current_need": "Nothing is outstanding. The four new board behaviours failed against the pre-fix tool and pass now, the earlier hygiene cases stayed green, and standing checks were clean.",
  "severity": "medium",
  "area": "Ticket board generation",
  "reported": "2026-08-12",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-12",
      "question": "Should the open-row status be re-derived from the ticket header, or should the check merely flag drift loudly?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "A",
      "chosen_on": "2026-08-13",
      "chosen_by": "agent",
      "note": "The ticket asked for derive-from-header unless curation was worth keeping; the header became the single source of truth and no curated text was preserved."
    }
  ],
  "success_criteria": [
    "A ticket whose header says fixed and deployed moves out of the open list on the next generation",
    "An open row's status text matches the ticket header rather than older index text",
    "A ticket marked as needing a person while its header says done is flagged by the board check",
    "An empty or dismissed finding is not counted toward the needs-attention total"
  ],
  "code_refs": [
    {
      "path": "scripts/board.mjs",
      "symbol": "gen",
      "note": "open-row status was carried over by id from the existing index instead of being re-derived from the ticket header"
    },
    {
      "path": "scripts/board.mjs",
      "symbol": "check",
      "note": "stale needs-you owner on a done ticket now fails; empty and dismissed findings are excluded from the merged needs-attention count, the class of pollution seen in BUG-040"
    }
  ],
  "related": [
    {
      "id": "BUG-040",
      "relation": "see_also"
    },
    {
      "id": "BUG-071",
      "relation": "depends_on"
    },
    {
      "id": "BUG-073",
      "relation": "depends_on"
    },
    {
      "id": "BUG-123",
      "relation": "blocks"
    },
    {
      "id": "FEAT-067",
      "relation": "see_also"
    },
    {
      "id": "FEAT-075",
      "relation": "see_also"
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
    "archived_path": "docs/bugs/archive/FEAT-068-self-correcting-board-no-drift.md",
    "sha256": "43baff37ad0049a784f1405f8d528a86bd6c17c4edd55a6a09f53d662c4fccfa",
    "bytes": 8492,
    "original_title": "board must self-correct: done/deployed tickets leave Open, stale 👤 is caught, no permanent drift",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared clause by clause against the original head: all four causes, all four wanted behaviours, the fixture list, the anti-regressions and the recorded tallies are present.",
    "dropped": [
      "the verbatim line numbers cited for the status-preservation code, which the code reference now locates by name"
    ]
  }
}
```

# FEAT-068 — Completed tickets stayed in the open list indefinitely

## Diagnosis

### Four causes

1. Board generation preserved each open row's status text from the existing index, keyed by id. Title, severity and section were re-derived from the ticket, but status was not, so a header that changed to fixed or verified left the row's blurb lying indefinitely.
2. Done-detection recognised only VERIFIED and DONE tokens. A leading FIXED, including "FIXED — deployed", did not move a row out of the open table, which is why several completed-and-deployed tickets lingered there.
3. A ticket could keep its needs-you owner after being fixed and deployed, with nothing to catch it, inflating the needs-attention count.
4. Architecture findings, decisions and stalls merged into the needs-attention count without filtering for empty or dismissed entries, so artifact findings counted as real attention items.

## Evidence

### What ran

`verify:board-tool` passes 34/34, up from 25/25. The pre-fix must-FAIL was proven: against the prior `board.mjs` the suite scored 30/4, with the four new assertions for the added behaviours failing. The earlier hygiene cases from BUG-071 and BUG-073 stayed green. `board:check` is clean on the real board with 35 advisory warnings, unchanged from before. Typecheck and the leak gate pass.

The report that prompted the work: a summary showed eight tickets needing attention and ten queued, while the real figures were roughly one and roughly none.

This is scripts-lane work with no deploy. It was self-verified; a clean-room verification was not dispatched, which the board records as an advisory outstanding under FEAT-061 rather than a blocker.

## Implementation notes

### What changed

The open-row status is re-derived from the ticket header on every generation, making the header the single source of truth. Done-detection accepts VERIFIED, DONE and FIXED, including a leading FIXED with a trailing deployed note. A ticket carrying a needs-you owner alongside a done, verified or deployed header now fails the board check.

## Verification plan

### Fixtures and anti-regressions

Fixtures covered a fixed-and-deployed ticket moving to the done table, a header-changed ticket whose row status follows the header rather than stale index text, a needs-you ticket with a done header being flagged, and an empty finding not being counted. Each of the first three was required to fail before the fix. On the real board, the needs-attention and queued counts had to match reality after a generation. Anti-regressions: the full board-tool suite, the board check exiting per policy, the BUG-071 and BUG-073 cases, typecheck and the leak gate.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from the user's directive after FEAT-067 exposed the drift. Systemic sibling of the
  one-time reconciliation sweep running now. scripts lane (board.mjs), no deploy.

### 2026-08-13 — build + self-verify (isolated worktree, scripts lane)
- **Design choice #1 (derive-vs-warn → DERIVE):** `gen` now re-derives the Open-table Status cell
  FROM the ticket `**Status:**` header every run (`boardStatusFromHeader`), replacing the old
  preserve-blurb-by-id (`statusMap`, now removed). The ticket is the single source of truth, so a
  header that changed can no longer leave a stale blurb lying on the board — the exact drift the user
  hit. The header is single-line; the helper collapses whitespace and escapes `|` so a status text
  can't split the row. Real-board effect: 4 drifting cells corrected in ONE gen — e.g. FEAT-049
  "ready for user" → "OPEN — audit phase"; FEAT-033 "adoption incremental" → "OPEN (design) — pick #1
  to dogfood". Owners and Done/Commit columns are still preserved by id (unchanged), so gen stays
  non-destructive to the genuinely orchestrator-owned state. Kept the loud checks (STATUS MISMATCH +
  new STALE OWNER) as defense-in-depth on top of derive, so drift can't sit silently even pre-gen.
- **Design choice #2 (FIXED policy):** `isDoneStatus` now treats a LEADING `FIXED` (incl.
  "FIXED — deployed / pending deploy") as done for PLACEMENT, alongside leading `VERIFIED` and a
  `DONE` token. Policy documented in code: FIXED/VERIFIED/DONE = done for board placement; a
  "FIXED — pending independent verification" ticket MOVES to Done and its outstanding verification is
  surfaced by the advisory NO INDEPENDENT VERIFICATION WARN (FEAT-061), NOT by keeping the row in
  Open — independent-verification-outstanding is advisory, never an Open-keeper (else a deployed fix
  sits in the needs-eyes table forever, which is what BUG-068/076/077/078 did). `FIXED`/`VERIFIED`
  are anchored to the START (a leading state word) so an incidental "…not yet FIXED" in an OPEN
  blurb doesn't sweep it to Done. `DONE`-anywhere is left UNCHANGED on purpose: the board already
  relies on it (FEAT-032's "IN PROGRESS — Phase R DONE; … VERIFIED" is treated as done); tightening
  it would silently relocate existing rows — out of scope, and an anti-regression I explicitly avoided.
- **Design choice #3 (stale-👤 guard):** `check` FAILs with `STALE OWNER` when a resolved ticket
  (isDoneStatus true) still shows the 👤 needs-you owner in its Open row — distinct from STATUS
  MISMATCH (placement), it names the needs-you inflation specifically (BUG-070's symptom). `gen`
  clears it structurally by moving the row to the ownerless Done table. A genuinely-open ticket
  (OPEN/IN-PROGRESS/BLOCKED) keeps its 👤 — FEAT-049 (👤, OPEN) is untouched, verified on the real board.
- **Item #4 (needsYou merge hygiene) — OUT OF LANE, cross-ref:** the empty-title/dismissed
  arch-finding + answered-decision + cleared-stall filtering lives in the SERVER (`src/index.ts`
  needs-you merge), not `board.mjs`. board.mjs owns INDEX.md only and has no visibility into the
  runtime arch-findings/decisions/stalls streams. Flagged for a server-lane follow-up; this ticket's
  board.mjs counts/placement are correct in isolation.
- **Verification (§C):** `verify:board-tool` 34/34 (was 25/25; +9 checks across new blocks g/h/i).
  New fixtures: (g) a FIXED-deployed ticket → gen lands it in the Done table; (h) a hand-drifted
  INDEX Status cell → re-derived from the header, stale blurb gone; (i) a resolved (FIXED) ticket
  hand-placed in Open with 👤 → check FAILs with STALE OWNER (exit 1).
- **must-FAIL PROVEN:** ran the NEW suite against a self-contained copy of HEAD's PRE-FIX `board.mjs`
  (`git show HEAD:scripts/board.mjs`, no FEAT-068 changes) → **30 passed / 4 failed** — exactly the 4
  substantive new assertions: (g) FIXED stayed in Open ("FIXED" not a done token), (h) gen preserved
  "STALE BLURB…" from the INDEX, (i) STALE OWNER silent + check exited 0. All (a)–(f) stayed green
  pre-fix (no false coupling). Post-fix all 34 pass.
- **Anti-regressions:** BUG-073 (conflict-marker FAIL + strip, block e) and BUG-071 (verify-exemption
  keyed on verifiedDate, block f incl. the pre-rule control) both stay green. `board:check` on the
  real board (in-worktree): CLEAN, 35 advisory warns — same count as before, no new/removed warns.
  `typecheck` clean, `leak-gate` PASS (0 hits / 443 files).
- Files: `scripts/board.mjs` (isDoneStatus + boardStatusFromHeader + STALE OWNER guard + gen derive),
  `scripts/verify-board-tool.mjs` (blocks g/h/i), `docs/bugs/INDEX.md` (regenerated — 4 corrected
  Open Status cells). Committed in the isolated worktree; orchestrator merges. No deploy.
