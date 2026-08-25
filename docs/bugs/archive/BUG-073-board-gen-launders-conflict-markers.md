# BUG-073 — board:gen silently launders git conflict markers (Open-table trailer preserves arbitrary non-table junk)

- **Status:** VERIFIED 2026-08-12 — fix + must-FAIL check landed in `verify:board-tool`; see log
- **Severity:** low
- **Area:** tooling (scripts/board.mjs — INDEX.md reconcile/generate)
- **Reported:** 2026-08-12 by board-hygiene pass (the real INDEX.md had carried empty
  `<<<<<<< HEAD` / `=======` / `>>>>>>> worktree-agent-ab2a298b96a740b22` markers across many regens)

## Symptom
`readIndex` parses the Open table by sweeping every non-empty, non-table line that follows the
`|---|` separator into a `trailer` array (`scripts/board.mjs` `parseTable`, the
`if (sawSeparator && line.trim() !== '') trailer.push(line)` branch). That trailer is meant to
preserve the one legitimate legend line (`FE = frontend … SV = server.`). But it captures ANYTHING
there — including git merge conflict markers — and `gen` re-emits the whole trailer VERBATIM every
regeneration (`if (idx.openTrailer.length) out.push('', ...idx.openTrailer)`). `check` never inspects
the trailer at all. So an unresolved-merge artifact:
1. is **re-written into INDEX.md on every `board:gen`** (laundered forward, never surfaced), and
2. **passes `board:check` clean** (exit 0) — the drift detector is blind to it.

This is the silent-preservation half of the board-hygiene root cause: the stale Open-row *Status
blurbs* are a PROCESS gap (that column is curated/orchestrator-owned and preserved by design — see
the header comment in board.mjs, lines 16–23 — the fix agents just never updated blurb + header
together, and tickets that reached done kept a non-`VERIFIED`/`DONE` keyword so `gen` left them in
Open). The conflict markers, by contrast, are a genuine TOOL bug: junk preserved with zero warning
and zero check coverage.

## Repro
1. Put `<<<<<<< HEAD` / `=======` / `>>>>>>> branch` lines anywhere between the Open table and
   `## Done` in INDEX.md.
2. `node scripts/board.mjs check` → exit 0, no mention of them (pre-fix).
3. `node scripts/board.mjs gen` → rewrites INDEX.md with the markers still present (pre-fix).

## Fix (small + safe, shipped)
`scripts/board.mjs`:
- `CONFLICT_MARKER_RE` = `^(?:<{7,}|={7,}|>{7,}|\|{7,})(?:\s.*)?$` (covers `<<<<<<<`, `=======`,
  `>>>>>>>`, and the diff3 `|||||||` base marker).
- `check` (`checkBoard`) scans `idx.rawLines` and **FAILs** (exit 1) on any marker, naming the line
  number — so drift is caught, not laundered.
- `gen` (`genBoard`) strips markers from every region it emits verbatim (preamble / Open-table
  trailer / Shipped blob) via `dropConflictMarkers`, warning loudly on stderr for each dropped line;
  the legitimate legend line is preserved untouched.
The curated Status-blurb preservation is intentionally left as-is (documented, not a bug).

## Verification (must FAIL pre-fix)
`scripts/verify-board-tool.mjs` section **(e)** (new): seed the temp board, inject conflict markers
right before `## Done`, assert `check` **FAILS** and names `GIT CONFLICT MARKER`; assert `gen` exits
0, **WARNS** about the dropped marker, **STRIPS** every marker, and PRESERVES the `FE = frontend …`
legend; assert `check` is clean again afterward. Also switched `runBoard` to `spawnSync` so the
suite captures gen's stderr warnings. Anti-regressions: sections (a)–(d) unchanged.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-12 — board-hygiene pass (filed + fixed)
- **Root-cause verdict (the half asked of this pass):** `gen`'s Open-row Status text comes from the
  CURRENT INDEX.md (`statusMap`, preserved by id) and NOT from the ticket header — that column is
  curated by design, so the stale statuses (ARCH-002, BUG-043, FEAT-055, FEAT-058, BUG-067) were a
  process gap (blurb never updated; done-tickets never normalized to a `VERIFIED`/`DONE` keyword so
  `gen` kept them in Open). Title/severity/section ARE re-derived from the header each regen. The
  ONE silent tool bug is the trailer: conflict markers (and any non-legend junk) preserved verbatim,
  invisible to `check`. Fixed here.
- **Verified:** `npm run verify:board-tool` green including the new must-FAIL section (e); pre-fix
  the injected markers passed `check` clean and survived `gen` (the defect this ticket names).
- Filed as BUG-073 because BUG-071 (verify-exemption keys on stale activity date) and BUG-072
  (permanent survivor mode) were already allocated by a concurrent agent while this pass ran.
