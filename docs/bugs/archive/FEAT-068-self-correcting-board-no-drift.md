# FEAT-068 — board must self-correct: done/deployed tickets leave Open, stale 👤 is caught, no permanent drift

- **Status:** VERIFIED 2026-08-13 — board self-corrects: Open-row Status re-derived from the ticket
  header each gen (single source of truth), FIXED (leading) recognized as done for placement, stale-👤
  guard FAILs check. `verify:board-tool` 34/34 (was 25/25); pre-fix must-FAIL proven (30/4 against
  HEAD's board.mjs — the 4 new g/h/i assertions FAIL); BUG-071/073 cases stay green; `board:check`
  clean on the real board (35 advisory warns, unchanged); typecheck + leak-gate PASS. Scripts lane, no
  deploy. Self-verified — independent verification advisory-outstanding (FEAT-061 WARN), not blocking.
- **Area:** scripts/board.mjs (gen + check) — board integrity, drift prevention
- **Reported:** 2026-08-12 by user:
  > "definitely need fixing so its up to date board instead of permanently drifting"
  > (after the FEAT-067 summary showed needs-you=8/queued=10 while reality was ~1 and ~parked)

## Root cause (from BUG-071/073 hygiene findings + the 2026-08-12 drift)
1. **Curated Open-row status drifts.** `board.mjs` gen takes each Open row's Status TEXT from the
   existing INDEX (`statusMap`, preserved by id), NOT re-derived from the ticket header
   (board.mjs:16-23). Title/severity/section ARE re-derived. So when a ticket's header changes
   (fixed/verified/deployed) but nobody edits the INDEX blurb, the row lies indefinitely.
2. **Narrow done-vocabulary.** A row moves to the Done table only on a VERIFIED/DONE token in the
   header; **"FIXED"** (and "FIXED — deployed") is NOT recognized, so completed-and-deployed
   tickets linger in Open/queued forever (BUG-068/076/077/078 did exactly this).
3. **Stale 👤 undetected.** A ticket can keep its 👤 needs-you owner after it's fixed+deployed
   (BUG-070 did), inflating needs-you, with nothing flagging it.
4. **arch-findings/decisions/stalls merged into needsYou** aren't filtered for empty/dismissed, so
   artifact findings (BUG-040-class boot pollution) count as needs-you.

## Wanted (self-correcting by construction)
1. **Kill the curated-status drift:** re-derive the Open-row Status text FROM the ticket header
   each `board:gen` (single source of truth), OR — if some curation is worth keeping — have
   `board:check` FAIL/warn loudly when a row's header carries a done/deployed token but the row is
   still in Open (so drift can't sit silently). Prefer derive-from-header; justify if not.
2. **Broaden done-detection:** VERIFIED | DONE | FIXED (incl. "FIXED — …/deployed") all move a row
   to Done. A deployed-and-verified ticket must not require a manual keyword nudge.
3. **Stale-👤 guard:** a ticket with a 👤 owner AND a done/verified/deployed header → `board:check`
   flags it (and/or `gen` clears the owner). Only genuinely-open decisions keep 👤.
4. **needsYou merge hygiene:** exclude empty-title / dismissed arch-findings + answered decisions +
   cleared stalls from the merged needs-you count (reconcile with FEAT-067's counts).

## Verification (§C)
Fixtures: a FIXED-deployed ticket → gen moves it to Done (must FAIL pre-fix: stays in Open); a
header-changed ticket → row status matches header, not stale INDEX text (must FAIL pre-fix); a
👤+done ticket → check flags it (must FAIL pre-fix: silent); an empty arch-finding → not counted.
Real board: after the fix + a gen, needs-you and queued match reality (tie to FEAT-067 summary).
Anti-regressions: verify:board-tool (all current checks + new ones), board:check exits per policy,
the BUG-071/073 cases stay green, typecheck, leak-gate.

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
