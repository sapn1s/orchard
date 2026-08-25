# BUG-071 — board:check "NO INDEPENDENT VERIFICATION" exemption keys on the LAST activity date, not when the ticket reached VERIFIED

- **Status:** VERIFIED 2026-08-12 (independent — reproduced from scratch): `verify:board-tool` 25/25; pre-fix silent bypass re-proven at a clean HEAD-before-869a88c worktree (24/25, the (f) case FAILs); `board:check` exits 0 on the real board. Two off-convention boundary bypasses found (slash-format status date; leading incidental ISO date) — documented below as extensions of the builder's residual, NOT regressions (advisory is WARN-only/non-gating). Exemption re-keyed onto `verifiedDate` (status-header date, else newest log heading). `verify:board-tool` 25/25 (added block (f): today-verified stale-log ticket WARNs + WARN-only exit 0 + pre-rule control stays exempt); pre-fix silent bypass proven at a clean HEAD worktree (24/25 — BUG-901 absent from the warnings). `board:check` exits 0 on the real board, output UNCHANGED (22 warned ID-clusters before and after; no flood, no spurious removals). Awaiting independent verification.
- **Severity:** low
- **Area:** tooling (board/gatekeeper — the advisory verification-enforcement WARN)
- **Reported:** 2026-08-12 by the FEAT-061 hole-#19 closing clean-room run (dispatch anthropic/sonnet
  run b281aae3-f037-4c40-9ce5-43209138bbc8, adversarial case `stale-activity-log`)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
`scripts/board.mjs`'s advisory `NO INDEPENDENT VERIFICATION` warning exempts a VERIFIED/DONE ticket
that carries NO `Verified-by:` line and NO `Verification-class: trivial|docs-only` whenever the
ticket's most-recent activity-log dated heading predates `VERIFY_RULE_EFFECTIVE` (`2026-08-11`). The
exemption was meant only for tickets *closed before the rule took effect* — but it keys on the log's
last dated heading (`lastEntryDate`), not on when the ticket actually reached VERIFIED/DONE. So a
ticket verified TODAY with no `Verified-by:` line produces ZERO warning if its activity log was never
refreshed at closure — silently bypassing the enforcement nudge.

## Repro
1. Craft a ticket with `**Status:** VERIFIED`, no `Verified-by:` line, no `Verification-class`
   exemption, whose only dated activity-log heading is e.g. `### 2026-08-01 — someone` (predating
   `2026-08-11`).
2. `node scripts/board.mjs check` → no `NO INDEPENDENT VERIFICATION` warning is emitted for it.
   (Reproduced end-to-end in the closing run's adversarial probe `node /tmp/board-adv.mjs`,
   harness-recorded run `0b643f8df046`, exit 0.)

## Expected
The exemption should be anchored to when the ticket ACTUALLY reached VERIFIED/DONE (e.g. the date on
the activity-log entry that records the status transition, or the closing entry's date), not merely
to the newest dated heading anywhere in the log. A ticket verified on/after `2026-08-11` without a
`Verified-by:` (and without a `trivial|docs-only` class) must still WARN even if an older,
stale heading is the most recent one parsed.

## Context pack
- Files/functions in play: `scripts/board.mjs:57` (`lastActivityDate`), `scripts/board.mjs:312-313`
  (the exemption condition `t.done && !t.verifiedBy && !t.exemptFromVerify && t.lastEntryDate &&
  t.lastEntryDate >= VERIFY_RULE_EFFECTIVE`), `VERIFY_RULE_EFFECTIVE` at `scripts/board.mjs:53`.
- Related tickets: FEAT-061 (this WARN is claim #5 "enforcement, not etiquette"; the closing run's
  hole-#19 verdict raised this as an adjacent finding — FEAT-061's own honest-residual-risk #1
  already documents this advisory layer as intentionally soft/self-declared/bypassable). [[FEAT-061]]
- Repro test: `npm run verify:board-tool` (add a check: a today-VERIFIED ticket with a stale-only
  activity log and no Verified-by still WARNs).
- Known dependencies / blockers: none. The WARN is advisory (`board:check` still exits 0), so this
  does not gate anything today; it weakens the nudge, it does not open a hard hole.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-12 — FEAT-061 hole-#19 closer (filed, not fixed)
- **Understood:** surfaced as the ADVERSARIAL case of FEAT-061's hole-#19 closing clean-room run
  (contract VALID, verdict BROKEN). Ruled ADJACENT to FEAT-061's bounded in-scope triad (clean room /
  executed-evidence-artifact-harness-emitted contract / its suite): the defect lives entirely in
  `scripts/board.mjs`, the advisory ticket-linter with its own suite `verify:board-tool`, and does
  not touch FEAT-061's core verification machinery (claims #1–#4/#6 all VALID that run). Filed here so
  it does NOT block FEAT-061 per the standing bounded-scope closing policy.
- **Confirmed against source:** `scripts/board.mjs:312-313` — exemption gated on
  `t.lastEntryDate >= VERIFY_RULE_EFFECTIVE`; `lastEntryDate` = the newest dated heading, unrelated
  to when VERIFIED was reached.
- **Still open / handoff:** anchor the exemption to the status-transition date, then ratchet a
  `verify:board-tool` check for the today-VERIFIED-with-stale-log case above.

### 2026-08-12 — BUG-071 fix agent (in-place, scripts lane)
- **Chosen anchor (documented):** added `verifiedDate(statusRaw, text)` in `scripts/board.mjs` =
  the first `YYYY-MM-DD` in the Status header line if present, ELSE the newest activity-log heading
  (`lastActivityDate`). The established convention on this board is `**Status:** VERIFIED <date> — …`
  / `DONE (<date>)`, so the leading status date IS the close date. The predates-the-rule exemption
  (`scripts/board.mjs`) now keys on `t.verifiedDate >= VERIFY_RULE_EFFECTIVE` instead of
  `t.lastEntryDate`. This anchors the exemption to WHEN the ticket reached VERIFIED/DONE, in both
  directions: a ticket verified on/after the rule with a stale log no longer bypasses the nudge, and
  a ticket verified BEFORE the rule is no longer nagged just because a later note bumped its newest
  log heading past the effective date.
- **Documented residual:** a done ticket carrying NEITHER a dated status header NOR any dated log
  heading presents no on-ticket evidence of its close date and is treated as pre-rule (exempt). The
  board is content-deterministic; without a close-date signal there is no way to catch "verified
  today with a fully undated ticket" that does not also flood the 70+ legitimately pre-rule tickets.
  The remedy is the convention this keys on — date the VERIFIED/DONE status line. (The ticket's
  literal repro had an undated `**Status:** VERIFIED`; keying on a dated status header is the
  guidance's primary clause and the only non-flooding fix — see the flood analysis below.)
- **Kept WARN-only:** advisory unchanged — `board:check` still exits 0; this does not gate.
- **must-FAIL / verified:** `verify:board-tool` now 25/25. New block (f): a ticket VERIFIED
  `2026-08-12` (status-dated on/after the rule) with only a `### 2026-08-01` log heading, no
  Verified-by, no Verification-class → WARNs (names the ticket) and check still exits 0; a CONTROL
  ticket VERIFIED `2026-08-05` (pre-rule) with the same stale log stays EXEMPT. Pre-fix silent bypass
  PROVEN: copied the new suite into a clean HEAD worktree (old `board.mjs`, no `verifiedDate`) → 24/25,
  the (f) bypass assertion FAILS because the pre-fix board exempted the today-verified ticket on its
  stale `2026-08-01` heading (the ticket is absent from a warning list that names every other done
  ticket).
- **Real-board impact:** `board:check` exits 0. Diffed the `NO INDEPENDENT VERIFICATION` warned-ID set
  before vs after: IDENTICAL (22 clusters). ZERO new warnings, zero removed — every current done
  ticket's status-header date and newest log date sit on the same side of the rule boundary, so the
  fix is forward-looking (closes the bypass for future dated-status tickets) without disturbing the
  board today. Flood analysis: 75 done tickets currently exempt via pre-rule/stale logs; all keep
  their exemption under `verifiedDate` (none carry a post-rule status date).
- **typecheck clean, leak-gate PASS.**

### 2026-08-12 — independent verification agent (in-place, did NOT build the fix)
- **Suite (regenerated, not trusted):** `npm run verify:board-tool` → **25/25**, incl. block (f)
  (today-verified stale-log ticket WARNs, advisory stays WARN-only exit 0, pre-rule control stays
  EXEMPT).
- **Pre-fix silent bypass re-proven myself:** `git worktree add` at `869a88c^` (old `board.mjs`, no
  `verifiedDate`), copied the CURRENT suite in → **24 passed / 1 failed** — the (f) bypass assertion
  FAILs because the pre-fix board exempts BUG-901 (VERIFIED 2026-08-12, stale `2026-08-01`-only log)
  on its stale heading; it is absent from a warning list that names every other done ticket. The (f)
  WARN-only and CONTROL checks still pass. Matches the builder's 24/25 claim.
- **Real-board impact — HONEST CORRECTION to the "identical 22 clusters" claim:** the board has
  changed since the builder's commit, so the absolute count is now 20 (new) vs 21 (old), NOT 22. I
  diffed the `NO INDEPENDENT VERIFICATION` warned-ID set by running the pre-fix `board.mjs`
  (`869a88c^:scripts/board.mjs`, placed in `scripts/` so its relative imports resolve) against the
  CURRENT board content, vs the current `board.mjs`. Exactly ONE difference: **FEAT-058** is warned
  by the OLD board and EXEMPT under the fix. This is the fix working CORRECTLY, not churn: FEAT-058 is
  `**Status:** VERIFIED 2026-08-09` (genuinely pre-rule), but a `### 2026-08-12` board-hygiene note
  (itself saying "verified + committed long ago") bumped its `lastEntryDate` past the rule, so the
  old board wrongly nagged it. The new `verifiedDate` keys on the 2026-08-09 status date and correctly
  exempts it — the reverse-direction case the builder described is now EXERCISED on the real board.
  `board:check` exits 0 both ways. No spurious NEW warnings; the single delta is a correct REMOVAL.
- **Adversarial — NEW fixtures the builder did not test (run against the REAL current `board.mjs`,
  temp board seeded from real docs, gen+check):**
  - FIXTURE-1 `**Status:** VERIFIED 2026/08/12` (SLASH date, non-ISO) + stale `2026-08-01`-only log,
    verified today → **not warned (BYPASS)**. `verifiedDate`'s `\d{4}-\d{2}-\d{2}` regex misses the
    slash date, falls back to the stale pre-rule log heading, exempts it. Extends the builder's
    documented residual ("no parser-recognized dated status header → treated as pre-rule"), sharpened:
    the header LOOKS dated to a human.
  - FIXTURE-2 `**Status:** DONE — the 2026-01-01 regression is fixed; verified 2026-08-12` (a
    LEADING incidental pre-rule ISO date before the real close date) + a `### 2026-08-12` today log →
    **not warned (BYPASS)**. `verifiedDate` takes the FIRST ISO date (2026-01-01, pre-rule) and
    exempts a ticket actually closed today. This is NOT covered by the builder's residual (which
    speaks of tickets with NO dated status header) — here a date is present but it is the wrong one.
  - CONTROL FIXTURE-3 `**Status:** VERIFIED 2026-08-12` (normal ISO) + stale log → **warned**
    (correct). CONTROL: a status line `VERIFIED 2026-08-12 — reverts the 2026-01-01 approach` (close
    date FIRST, incidental date second) → **warned** (correct — the leading-date convention protects
    it).
- **Verdict on the boundary findings:** both bypasses require an OFF-CONVENTION status line (the fix
  explicitly keys on the board convention `**Status:** VERIFIED <ISO-date> — …` with the close date
  leading). Every real ticket on this board follows the convention, so neither hole fires today; the
  warned-set diff above confirms no real ticket is affected. The advisory is WARN-only / non-gating,
  so these do not open a hard hole. Documented here (not fixed) per the bounded-scope rule; if the
  linter is ever hardened, the fix is to require the close date to be the FIRST token after the status
  word (reject a slash/other-format date, ignore later incidental dates) — but that is a follow-up,
  not a blocker. The fix as landed is CORRECT for the convention it targets.
- typecheck clean, leak-gate PASS. **Independently VERIFIED.**
