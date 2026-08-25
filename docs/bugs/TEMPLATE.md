# <ID> — <short title>

- **Status:** OPEN
- **Severity:** low | medium | high
- **Area:** (composer / sidebar / bridge / drawer / server / …)
- **Reported:** <date> by <who>
- **Verification-class:** fix | plan+review | arch  ⟶ independent verification REQUIRED
  before VERIFIED. Write `trivial` or `docs-only` instead ONLY if it genuinely is —
  that word is the exemption, and it is auditable.

## Symptom
What the user sees. Verbatim quote if there is one.

## Repro
Exact steps → wrong behavior.

## Expected
What should happen instead.

## Decision — <the question> (ONLY if this ticket is blocked on a human choice)

<!--
  Delete this whole section if nobody has to choose anything.

  If the ticket IS blocked on you-the-human — a Status header that says "NEEDS A
  DECISION", "awaiting a decision", "pick an option" — then the options MUST be
  written as the bold-lead bullets below. That is the only shape
  `ticketDecision()` (src/server/board.ts) parses, and it is what renders the
  Decide card on the Needs-You rail. Options argued as numbered prose paragraphs
  parse to NOTHING: no card, no question, and the ticket waits forever on someone
  who was never asked. `npm run board:check` FAILS on that now.

  Rules: at least TWO options · key is a short token (A, B, 1, 2 — max 6 chars) ·
  an em/en-dash or hyphen separates key from label · `KEY — label` sits inside ONE
  bold run · the rest is the description, which may wrap onto indented lines.
  The ticket must also carry the 👤 Owner in docs/bugs/INDEX.md (orchestrator-owned)
  — the rail reads only 👤 rows. Optional: put `Recommended: <key>` in the Status
  header; it is validated against the keys here and dropped if it matches none.
-->

- **A — short label.** What it costs and what it buys.
- **B — short label.** The alternative, and its trade-off.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play: …
- Related tickets: …
- Repro test: `npm run verify:<x>` (add one if none exists)
- Known dependencies / blockers: …

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### <date> — <agent/who>
- **Understood:** …
- **Changed:** files, and the commit sha once committed
- **Verified:** commands + PASS/FAIL lines + screenshot paths (this is the FIXER's own
  run — necessary, and never sufficient on its own)
- **Verified-by:** `dispatch <provider>/<model> run <id> (clean-room,
  scripts/independent-verify.mjs) — VERDICT: HOLDS|BROKEN` — required before VERIFIED for
  `fix`/`plan+review`/`arch`. The fixer wrote the fixture, so the fixer cannot be the
  judge: an independent clean-room verifier must paste real output from a case the
  fixture does NOT cover (`docs/prompts/patterns/VERIFY.md`). **Fixer id ≠ verifier id**,
  and the line must name a DISPATCH RUN — a Task subagent has no run id, which is exactly
  why it does not count. Omit only when `Verification-class:` is `trivial`/`docs-only`.
- **Still open / handoff:** if not fully solved, the precise next step and WHY
  (so the next agent does not repeat this)
- **Symptom of a deeper design flaw?** (no / yes → ARCH-### filed) — required
  when you CLOSE the ticket. "yes" costs one ARCH ticket
  (`docs/bugs/TEMPLATE-ARCH.md`); silence loses the only structural suspicion
  anyone had (WA §N, FEAT-056).
