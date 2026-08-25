# FEAT-026 — Split the Working Agreement into CORE (always-injected) vs FULL (on-demand)

- **Status:** DONE — closed without build (2026-08-06, user ok): the injected-surface-budget concern is addressed by FEAT-019's automatic consolidation (WA slimmed 14255->12949B, project leaks relocated) + FEAT-043's capped condensed routing section; a core/full split adds machinery without remaining need.
- **Area:** methodology / templates injection
- **Reported:** 2026-08-04 (risk R2 from the FEAT-019 whole-picture pass)

## Problem
The Working Agreement is ~9.6KB and injected into EVERY launched session; FEAT-021
will add a per-session board snapshot on top. Attention budget (§H) applies to the
MODEL too — an ever-growing always-on preamble dilutes signal and costs tokens.

## Design
- Tag sections CORE (load-bearing, always injected — e.g. output contract,
  orchestrate, verification, git/process safety, ambient≠instructions) vs EXTENDED
  (examples, rationale, project-specific — available on demand / linked).
- The injected template = CORE + a one-line pointer to the FULL doc ("read
  docs/prompts/WORKING_AGREEMENT.v2.md for the full version"). Keep a size budget
  for CORE; consolidation (§L / FEAT-019) enforces it.

## Verification
Composed session prompt contains CORE + the pointer and stays under the budget; the
FULL doc still carries everything. typecheck + a size assertion.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed from R2. Pairs with FEAT-021 (both add to the injected surface).

### 2026-08-06 — orchestrator
- Closed per user ('026 ok') — obsoleted by auto-consolidation; reopen if the injected surface grows past budget again.
