# BUG-042 — auto-consolidation deleted a UNIVERSAL rule from the WA because it mentioned a product name

- **Status:** VERIFIED (2026-08-11) — illustrative markers excluded, per-block auto-apply demoted to needs-human; 43/43 (pre-fix 37/43 FAIL); live §K relocation loop reverted + hardened.
- **Area:** FEAT-019 wa-consolidate `--apply` (project-specific relocation detector)
- **Reported:** 2026-08-10 by the FEAT-061 build agent, mid-build

## What happened
While FEAT-061 was being built, the §L auto-consolidation pass fired (it runs at server boot and
after every capture) and RELOCATED the most load-bearing bullet of the new WA §I text — "separate
process, not a subagent" — out of the universal Working Agreement into `docs/CONVENTIONS.md`,
because the sentence contained the word "Orchard". The agent noticed and restored it in a
product-agnostic form.

## Why this is serious, not cosmetic
- The rule is UNIVERSAL (any orchestrator, any project: an in-process subagent inherits its parent's
  framing and cannot verify it). It was removed from the doc that every project's sessions receive
  and buried in ONE project's local conventions — silently, with no human in the loop.
- The heuristic is "mentions a project-specific token ⇒ project-specific", which is wrong whenever a
  universal rule cites a concrete implementation as an EXAMPLE. That is exactly how good rules are
  written, so the detector is biased against the best-written rules.
- It auto-applied. FEAT-019's contract says safe mechanical classes auto-apply and judgment calls
  surface; "is this rule universal?" is a judgment call that was misclassified as mechanical.
- Nobody would have noticed if the agent had not happened to be editing that exact section.

## Fix direction
1. **Relocation must not fire on a rule whose body is universal but whose EXAMPLE names a product.**
   Distinguish "the rule is about project X" from "the rule cites project X as an illustration" —
   e.g. require the project token to appear in the rule's normative clause (the imperative), not
   merely anywhere in the block; or require multiple distinct project markers; or exclude blocks
   whose first sentence has no project token.
2. **Demote relocation from auto-apply to needs-human** unless the confidence is unambiguous
   (a whole section that is nothing but project specifics). A wrong relocation silently weakens
   every future session's instructions — cost of error is high, so §N says raise the bar.
3. **Make relocations reversible and visible**: they are already git-committed in the methodology
   repo (good), but the CHANGELOG entry should name the moved rule explicitly, and a relocation
   should appear as a needs-human finding in the rail even when applied.
4. Consider a protected-marker convention (e.g. a rule tagged `universal:` is never relocated).

## Verification (must FAIL pre-fix)
Fixture WA containing (a) a universal rule that cites a product name as an example, (b) a genuinely
project-specific block: the pass must relocate ONLY (b) and leave (a) untouched; the real-world
specimen (the "separate process, not a subagent" bullet) must survive a pass verbatim. Existing
verify:wa-selfmaintain stays green. Also assert the CHANGELOG names any relocated rule.

## Activity log (APPEND-ONLY)
### 2026-08-10 — orchestrator
- Filed from the FEAT-061 agent's report. Note the meta-point: the self-maintenance loop we built to
  protect the methodology is currently able to quietly degrade it — the loop needs the same "never
  auto-apply a judgment call" discipline it enforces elsewhere.

### 2026-08-11 — fix agent (CLASS: fix)
Hypothesis CONFIRMED: `wa-consolidate.mjs` classified a block as project-specific on
`PROJECT_MARKERS.test(b.text)` — a marker ANYWHERE in the block — and relocations were
auto-applied per block.

**Detector rebuild (`classifyBlock`)** — a block is project-specific only if a
NON-ILLUSTRATIVE marker (not inside parentheses, not after e.g./for example/for
instance/such as/as in/like/say in the same sentence) appears in the block's FIRST
sentence (the normative clause — WA house style leads with the bold imperative), or if
≥2 distinct non-illustrative markers appear anywhere. One non-illustrative marker only in
a later sentence ⇒ 'ambiguous'. Chosen over the ticket's single-criterion options because
it encodes "the rule is ABOUT the project" directly and the illustrative-context exclusion
targets the exact incident class. A block tagged `universal:` is never classified at all.

**Demotion** — per-block relocation is GONE. Needs-human `relocation-candidate` for any
partial/ambiguous case. The only auto-applied class is the unambiguous whole section:
≥2 blocks, EVERY block 'specific' with ≥2 distinct markers each, none frozen by a
contradiction. The whole body moves; a pointer stub keeps the §letter resolvable.

**Visibility** — CHANGELOG names every moved rule (first line, quoted); an applied
relocation also lands on the rail as a `relocation-applied` finding (persisted to
.station/needs-human.json alongside the true needs-human items; only in --apply runs —
a propose run claiming "applied" would be a lie).

**LIVE INCIDENT during the fix (the loop bit back, twice):** while the detector was
half-built, the running station's post-capture passes executed the edited script against
the REAL methodology repo at 11:02 and relocated the REAL §K ("Durable, opt-in board")
three times in 23s: (1) §K's single paragraph carried `docs/bugs` + `INDEX.md` in its
normative clause — but those are the universal board convention's own VOCABULARY, exactly
the old empty-section guard's concern; (2) the pointer stub itself said "claude-station",
so every subsequent pass re-relocated its own stub (self-sustaining loop), and twin stubs
are near-identical so they auto-MERGED. All three commits reverted (methodology
9512c13..), CONVENTIONS.md appends discarded, mirror re-synced. Hardened in response:
`INDEX.md`/`docs/bugs` removed from PROJECT_MARKERS (universal vocabulary, not project
tokens); stubs are project-token-free; stub bodies are excluded from both classification
and merge similarity; whole-section bar raised to the ≥2-blocks/≥2-markers form above.

**Verification** (`verify-wa-selfmaintain.mjs`, T7 rebuilt to the new contract):
- PRE-FIX (committed script restored temporarily): 37/43 — 6 FAILs, including T7d (the
  e.g.-"Orchard" universal bullet WAS relocated) and T7f (partial block WAS auto-moved).
- POST-FIX: **43/43 PASS** (was 39 checks; now 43). Fixture proves: whole-section §W
  relocated; e.g.-example bullet survives verbatim; the REAL "separate agent PROCESS,
  never one of your own subagents" specimen (extracted from the WA itself) survives
  VERBATIM; partial btrfs block stays + surfaces as relocation-candidate; CHANGELOG names
  each moved rule; rail carries relocation-applied + relocation-candidate; contradiction
  untouched; second pass honest no-op; real repo untouched (T6).
- `npm run typecheck` clean. Final read-only propose pass on the REAL WA: 0 relocations,
  0 candidates, specimen present, invariant OK (22706 == 22706 bytes), methodology
  porcelain clean.
- Canonical WA §L now documents the demotion + `universal:` tag (methodology commit
  5817934, mirror synced, `sync-methodology --check` OK).

## Closing assessment
CLOSED — fixed and verified. The detector now distinguishes "about the project" from
"cites the project"; relocation is needs-human except the raised-bar whole-section class;
applied relocations are named in CHANGELOG and surfaced on the rail; `universal:` is a
protected tag documented in §L. The mid-fix live incident is the strongest evidence the
demotion was the right call: even the "unambiguous" class misfired on real content until
the bar included multi-block + multi-marker corroboration and stub immunity. Residual
risk: PROJECT_MARKERS is still a hand-kept list — a future marker that is really shared
vocabulary would recreate the §K shape; the needs-human demotion means the blast radius
of that mistake is now a rail finding, not a silent edit.
