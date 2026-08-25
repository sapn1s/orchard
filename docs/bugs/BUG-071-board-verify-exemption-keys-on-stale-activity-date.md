```orchard-ticket
{
  "id": "BUG-071",
  "type": "bug",
  "title": "Recently closed tickets could bypass the verification warning",
  "summary": "Recently closed tickets now receive the missing-verification warning even when their activity log is stale. The pre-change case silently bypassed the warning, while the corrected case passed and standing checks remained clean. Two uncommon date formats remain outside the new handling.",
  "impact_if_we_wait": "Missing independent-verification records could escape an advisory warning, weakening review discipline. Bounded: the warning never gates work, and the defect affects board reporting, not ticket data or completed work.",
  "current_need": "Treat the ticket as closed: the stale-log case failed before the change, passed afterward, and standing checks stayed clean.",
  "severity": "low",
  "area": "Ticket board verification warnings",
  "reported": "2026-08-12",
  "reported_by": "bug-hunt workflow",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-12",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Recently verified tickets with stale activity logs produce the missing-verification warning",
    "Tickets closed before the rule took effect remain exempt",
    "The advisory warning does not change the board check exit code",
    "Existing board warning output gains no unrelated additions or removals"
  ],
  "code_refs": [
    {
      "path": "scripts/board.mjs",
      "symbol": "lastActivityDate",
      "note": "Previously supplied the newest activity-log date used by the exemption."
    },
    {
      "path": "scripts/board.mjs",
      "symbol": "VERIFY_RULE_EFFECTIVE",
      "note": "The advisory rule became effective on 2026-08-11."
    },
    {
      "path": "scripts/board.mjs",
      "symbol": null,
      "note": "The exemption now uses the status-header verification date, falling back to the newest log heading."
    }
  ],
  "related": [
    {
      "id": "BUG-119",
      "relation": "see_also"
    },
    {
      "id": "FEAT-061",
      "relation": "see_also"
    },
    {
      "id": "FEAT-068",
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
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-071-board-verify-exemption-keys-on-stale-activity-date.md",
    "sha256": "104e43708533c19e6ebbdf55a35d77ba54b015b4739653e6b180a99c265b4269",
    "bytes": 12200,
    "original_title": "board:check \"NO INDEPENDENT VERIFICATION\" exemption keys on the LAST activity date, not when the ticket reached VERIFIED",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied ticket text; the symptom, correction, residual date cases, executed evidence, scope, and FEAT-061 relationship are preserved.",
    "dropped": []
  }
}
```

# BUG-071 — Recently closed tickets could bypass the verification warning

## Diagnosis

The advisory warning used the newest dated activity-log heading to decide whether a completed ticket predated the verification rule. A ticket closed after the rule took effect could therefore remain exempt when its log retained only an older heading. The correction keys the exemption to the status-header date, with the newest log heading as fallback.

## Evidence

The stale-log case produced no warning before the change. A clean worktree at the earlier revision reproduced that failure with 24 of 25 checks passing. After the change, `verify:board-tool` passed 25 of 25 checks, including the new case and the pre-rule exemption control. Type checking, the leak gate, and `board:check` stayed clean. The real board retained the same 22 warned identifier clusters. Dispatch run b281aae3-f037-4c40-9ce5-43209138bbc8 identified the case, and harness record 0b643f8df046 captured the end-to-end probe.

## Implementation notes

The new test covers a ticket verified today whose only activity heading is stale. It requires a warning while preserving the warning-only exit code and the exemption for tickets closed before the rule. Slash-formatted status dates and leading incidental ISO dates remain documented boundary extensions rather than regressions.

## Verification plan

Run the board-tool suite and confirm the stale-log fixture warns, the pre-rule control remains exempt, and the command remains non-gating. Run the real board check and compare warned identifier clusters for unrelated changes.

## Migration and rollback

No data migration is required. Reverting the exemption-date change and its test restores the earlier advisory behavior without altering ticket content.

## Risks

Date extraction remains convention-dependent. Slash-formatted status dates and incidental leading ISO dates can still select the wrong boundary, but the resulting warning remains advisory.

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
