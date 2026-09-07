# FEAT-138 — Enforce the prose-volume budget at the Stop hook (not just measure it)

- **Status:** FIXED — the FEAT-125 length budget is now ENFORCED by the Stop hook
  on every real launched session (not behind an env var nobody sets). An
  over-budget turn is blocked ONCE for an immediate tighter re-send; the
  one-correction cap makes stranding impossible. Self-verified against fixtures and
  20 recent REAL transcripts.
- **Severity:** medium
- **Area:** scripts/hooks (response-format-gate.mjs) / scripts/lib (format-metrics.mjs)
- **Reported:** 2026-09-07 by user (via orchestrator dispatch)
- **Verification-class:** behavioural (a real Stop-hook subprocess run over real
  and realistic-state transcripts, before/after) + anti-regression (feat-084/091
  suites, real-transcript no-false-positive sweep)

## Symptom
FEAT-125 injected a length budget (≤120 words of prose; ≤250 for a handoff or
pending decision) and FEAT-127 made it MEASURED — and FEAT-127's own numbers
showed the budget being ignored: over a real 40-turn transcript, prose words/turn
mean **209**, max **542**, and **26/40 turns (65%) over the 120-word budget**
(`FEAT-127…md:104`). The rule existed as advice on every turn and moved nothing,
because advice is what two prior "be concise" attempts already were.

## Why nothing existing covered it
- The budget lived only as INJECTED PROSE (`RESPONSE_FORMAT.md:147-149`).
- `format-metrics.mjs` MEASURED it (`proseVolume()`), but the measurement was
  explicitly advisory — "it records numbers, it does not truncate or block."
- The Stop hook (`response-format-gate.mjs`) had ZERO length logic; its only
  length-adjacent check was readability.
- The hook's blocking mode was gated on `ORCHARD_STOP_HOOK_ENFORCE`, which is set
  in **no launch path**, so nothing was ever enforced.

## Fix
1. **Pure evaluation in `format-metrics.mjs`** — `evaluateLength(parsed)` returns
   `{ proseWords, askBlocks, ceiling, over }`. The ceiling is **250 when the turn
   carries a pending decision (an `orchard-ask`)**, else **120**. This is the only
   "handoff" the Stop hook can see: a lane→orchestrator handoff is a sidechain the
   hook never grades, so on the main thread the ask turn IS the pending-decision
   turn. It reuses the exact word rule of `proseVolume()` (digest JSON and fence
   wrappers excluded).
2. **The hook ENFORCES it, by default, without the env var.** A NEW enforcement
   path (`reviseTurn`) blocks the stop ONCE with a corrective `reason`, feeding it
   back to the model as a just-in-time revision. It does **not** consult
   `ORCHARD_STOP_HOOK_ENFORCE` — the length budget and the ask-ownership rule
   (FEAT-137) are the two the user demanded and watched fail as advice, so they are
   active on every real session. The pre-existing format/emoji/readability/block
   checks are UNCHANGED (still advisory unless the env var is set), so the
   FEAT-085 read-during-write decision is preserved for the checks it was made for.

## Failure mode, designed deliberately (the dispatch's named risk)
A hook that hard-blocks can strand the user mid-conversation — worse than
verbosity. The least-destructive mechanism that still changes behaviour was
chosen: **surface the violation to the model for an immediate re-send**, not
discard the reply. Safety, each property tested:
- **Nothing is discarded.** Blocking hands `reason` back; the model re-sends the
  SAME answer, tighter. A visible advisory marker (the existing advisory mode) was
  already tried for exactly this and did not move output — it tells the USER, not
  the model.
- **Cannot strand.** `stop_hook_active === true` is checked upstream and always
  allows, so at most ONE correction happens per turn. If the re-send is still over
  budget, it goes through. Worst case is one extra generation, never a loop.
- **Race-robust in the dangerous direction.** The FEAT-085 race reads a PARTIAL or
  EARLIER message; a partial read has FEWER words, so the length check under-counts
  and errs toward NOT blocking.
- **Kill switch exists.** `ORCHARD_STOP_HOOK_DISABLED` (checked upstream) turns the
  whole hook inert — a live session that misbehaves is one env var from silence.

## Files
- `scripts/lib/format-metrics.mjs` — `evaluateLength()`; `overLengthBudget` /
  `lengthCeiling` record fields; `overLengthTurns` summary; ENFORCEMENT report
  section.
- `scripts/hooks/response-format-gate.mjs` — `reviseTurn()`; length reason;
  enforced-vs-advisory decision split; `summarise()` extended.
- `scripts/verify-feat-137-138-enforcement.mjs` — the behavioural suite (shared
  with FEAT-137).

## Honest limitations
- The 120-vs-250 split keys on the presence of an `orchard-ask`. A genuine
  handoff-to-user that is not phrased as an ask gets the 120 budget; on the
  orchestrator main thread that is rare (true handoffs are the sidechain the hook
  never grades), so the bias is acceptable and documented in the code.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-07 — dispatched fix lane (fixing, round 1)
- **Understood:** the budget was advice + a measurement; enforcement (behind an
  unset env var) never ran. Needed the hook to actually catch an over-budget turn,
  active by default, without stranding the user.
- **Changed:** the files above. Enforcement blocks ONCE for a revision, capped by
  `stop_hook_active`; advisory checks left exactly as they were.
- **Must-FAIL proof (real commands):**
  - BEFORE (current HEAD hook, run as a subprocess): a compliant-but-144-word
    reply exits 0 with **no block** — the over-budget reply passes today.
  - AFTER (modified hook): the same reply → `{"decision":"block", …144 words; the
    budget is 120…}`.
- **Real-transcript reality + no-false-positive sweep:** ran the modified hook
  against the **20 most recent real** main-thread transcripts. **9 blocked, all
  genuine length overages** (132, 140, 163, 181, 559, 1123, 1255, 1651, **1718**
  words); **10 allowed, all genuinely compliant or under the 250 ask-budget** (6–206
  words); 1 empty final turn (tool/thinking) correctly ignored. The pre-existing
  missing-digest ADVISORY still fires as a `systemMessage` and does NOT block —
  proving the advisory path is intact.
- **Recovery proven:** the same over-budget transcript with
  `stop_hook_active:true` → ALLOWED (the one-correction cap; no loop, no strand).
- **Anti-regression:** `verify-feat-084` 37/0 (RESPONSE_FORMAT.md untouched by this
  ticket), `verify-feat-091` 277/0, `verify-feat-137-138-enforcement` 13/0.
- **Gate:** see the shared note in FEAT-137's log (both tickets landed together).
- **Independent verify:** WARRANTED — this changes the Stop-hook decision on every
  turn of every session (session-lifecycle / regression-prone). A second
  clean-room pass over the enforce-vs-advisory split and the race argument is
  recommended before this is treated as settled.
