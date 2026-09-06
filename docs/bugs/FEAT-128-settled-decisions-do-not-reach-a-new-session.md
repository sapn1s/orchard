# FEAT-128 — Settled decisions and standing authorisations do not reach a new session

- **Status:** FIXED (universal half) — pre-ask rule added to canonical WA §B (every session reads it); project-conventions truncation made loud, boundary-aware and given real headroom. Project-specific half fixed in the affected project's own docs.
- **Severity:** medium
- **Area:** docs/prompts (canonical Working Agreement §B) / `src/server/templates.ts` (`localConventionsSection`)
- **Reported:** 2026-09-05 by user, from a live-money trading project
- **Verification-class:** docs-only (injected WA text) + a real behaviour change in the compose layer, verified by assembling the actual launch injection and by the existing FEAT-039/FEAT-021 verify suites

## Symptom

The user continuously starts NEW sessions on a long-running project and expects
each to land with enough context to be useful. Instead, fresh sessions re-ask
questions the project already answered and re-dispatch work already done. Three
instances in one session:

1. The orchestrator asked the user to approve a per-tick capital cap for
   auto-opened trading cells — a question settled months earlier, because the
   per-strategy loss caps and the global equity killswitch exist *precisely so
   that approval is never needed*. The user's authorisation is "full balance
   usable for testing; the loss triggers ARE the control."
2. An agent was dispatched to fix a timeout that had been root-caused and fixed
   the day before.
3. A doc asserted a fact that made the project's continuity check FAIL when a
   deliberately-retired component was correctly down — so agents kept reviving it.

## Diagnosis — what a new session actually receives

Reconstructed from `composeInstructions()` + `agent-bridge.ts`, not assumed. For
the affected project the launch system prompt was **49,208 chars**, composed of:

| section | size | carries |
|---|---|---|
| Working Agreement v4 | ~38,000 | universal method |
| Project Conventions (local) | **4,000 (capped)** | project rules |
| Provider Routing | ~2,500 | dispatch guidance |
| Response Format | ~4,700 | reply shape |
| *(first turn, not system)* board snapshot | 1,056 | ticket **titles** only |

**The methodology and the board arrive; standing user decisions do not.** No
part of the injection carries a mandate, an authorisation, or a settled
question. Those live in files (`PROJECT.md`, `HANDOFF.md`) that are *pointed at*
but never injected, so they reach a session only if it goes and reads them.

Two structural faults, both universal:

- **The one project-owned channel that IS auto-injected — `docs/CONVENTIONS.md` —
  truncated SILENTLY.** The affected project's doc is 5,800 chars; exactly 4,000
  were injected, cut **mid-word** and ending in a bare `…`. The session had no
  way to know 1,800 chars were missing, and the project author had no signal at
  all. On a live-money project that means a half-delivered safety rule reads as a
  whole one. Anything appended at the *bottom* of a conventions doc — the natural
  place to append — was never injected at all.
- **The WA gated BUILDS on a prior-art check, but never gated ASKS.** §B says
  check what exists before proposing to build; §A (FEAT-127) says decide whether
  a fork is even the user's. Neither says: check whether the question is
  *already answered* before spending the user's attention on it.

Note the interaction with FEAT-127: that ticket fixed *illegitimate* asks (no
user-held decider). This is a different failure — the ask was legitimate in
shape, the user genuinely owns capital risk. It was simply **already answered**.
Both tests must pass; §A owns one, §B now owns the other.

## Fix

1. **Canonical WA §B extended** (`~/projects/methodology/WORKING_AGREEMENT.v4.md`,
   mirrored by `npm run sync:methodology`) from "before you build" to "before you
   build, install — **or ASK**":

   > **The same check gates QUESTIONS, not just builds.** […] before you put a
   > question to the user, or dispatch an agent to build or fix something, confirm
   > from the project's own durable record that it is not already settled or
   > already done […] If you genuinely cannot find it, ask — but say what you
   > checked, so the answer can be filed where the next session will find it.
   > (§A decides whether a question is *yours or theirs*; this decides whether it
   > is *already answered*. Both must pass.)
   >
   > **A settled decision that lives only in chat is already lost.** […] write it
   > into the project's durable, *auto-loaded* context […] Correct any older note
   > that now contradicts it in the same pass: a stale line asserting the opposite
   > is worse than silence, because it will be believed.

   Deliberately references no product machinery and names no project — it is the
   principle, and `check:scope` reports the edited WA clean.

2. **`localConventionsSection()` truncation fixed** (`src/server/templates.ts`),
   three changes, all universal and all additive:
   - **Cap 4000 → 6000.** The same call already made for
     `responseFormatSection()`: a mid-sentence ellipsis in a RULES document is
     worse than the tokens it saves. A project's own operating rules earn the
     headroom the response-format core already gets.
   - **Boundary-aware cut** — truncation lands on the last blank line that fits,
     so a rule is delivered whole or not at all, never half. Falls back to a hard
     slice only when one block exceeds the whole budget.
   - **Loud truncation notice** naming the file and the exact dropped/total char
     counts, telling the session to read the file in full. A silent omission
     becomes a known unknown.

   A doc that fits the cap (the common case) is **byte-identical** to before.

## Verification

- Assembled the REAL launch injection for the affected project through
  `composeInstructions(refs, { hostPath, routing: true, responseFormat })` — the
  same call `agent-bridge.ts` makes — before and after. Confirmed in the
  assembled text: the WA pre-ask rule, the project's mandate block, and the
  truncation notice all present; the project's deploy-lock table, previously cut
  in half, now survives whole.
- `npm run verify:local-conventions` 18/18 (includes the byte-identity guards for
  doc-less and whitespace-only projects).
- `npm run verify:wa-injected` PASS 10/0 · `verify:conventions-live` 5/5 ·
  `verify:wa-selfmaintain` 43/43 · `verify:check-scope` 12/12.
- `node scripts/sync-methodology.mjs --check` → mirror == canonical (5 files).
- `node scripts/check-scope.mjs --wa docs/prompts/WORKING_AGREEMENT.v4.md` → clean
  (the new §B text is not project-specific-sounding).

## Files

- `~/projects/methodology/WORKING_AGREEMENT.v4.md` (canonical, hand-edited §B)
- `docs/prompts/WORKING_AGREEMENT.v4.md` (mirror; regenerated by sync, do not
  hand-edit)
- `src/server/templates.ts` (`localConventionsSection` + its doc comment)

## Activity log

### 2026-09-05 — audit + fix

- **WHY:** a fresh session re-asked a settled capital-cap question and an agent
  re-fixed an already-fixed bug. Hypothesis under test was "the launch injection
  carries the board and the methodology well, but carries STANDING USER DECISIONS
  poorly or not at all."
- **EVIDENCE:** hypothesis **confirmed for the injection, with a correction.**
  The affected project's mandates channel was *not* empty — it was well populated
  in its own `PROJECT.md §2` and `HANDOFF.md §7`. The failure was **reachability
  and contradiction, not absence**: nothing in the 49,208-char injection carried
  a mandate, the one project channel that is injected was silently truncated at
  4,000/5,800 chars, and the board snapshot carries titles only (no "already
  built" signal — which is exactly how the duplicate dispatch happened).
- **CHANGED:** canonical WA §B (pre-ask + record-it-durably rules), mirror
  re-synced; `localConventionsSection()` cap 4000→6000, boundary-aware cut, loud
  truncation notice.
- **VERIFIED:** see Verification above — the decisive one is the assembled real
  injection, not an assertion that it works.
- **OPEN / HANDOFF:** two things this did NOT fix, both worth a later ticket.
  (a) **The board snapshot carries no done-ness signal.** It lists in-flight
  ticket titles; it cannot tell a session that a named bug was fixed yesterday, so
  duplicate dispatch stays possible on any project. A one-line "recently closed /
  last Activity date" lane would cost ~200 chars and close instance #2 of this
  class structurally.
  (b) **Nothing checks that a project's mandate block still lands inside the
  injection window.** The cap is now 6000 and the notice is loud, but a project
  that appends 3 KB above its mandates silently pushes them out again. A generic
  `scripts/check-scope.mjs` extension — warn when a conventions doc exceeds the
  cap, and report which headings fall outside it — would make that visible to the
  project author rather than only to the session.
