# ARCH-002 — nothing answers "does this work outlive the turn that started it?"

- **Status:** DONE (2026-08-13) — DECIDED option 1 (declared lifetime at dispatch); implementation landed via BUG-044 (VERIFIED) + FEAT-062 (VERIFIED), both deployed. Decision + implementation complete.
- **Raised by:** BUG-037's closing assessment (2026-08-10), corroborated by BUG-041
- **Area:** turn lifecycle vs work lifetime

## Violated invariant
**Every piece of work must have a declared LIFETIME, and no component may infer it.** ARCH-001 gave
us one authority for "is this process alive". Nothing answers the orthogonal question: "is this work
scoped to the turn that started it, or does it outlive that turn?" So `case 'result'` guessed — in
private — that everything running at turn end had ended, and wrote death records for background
agents that were still working.

## Why it is the same class as ARCH-001, one level up
- ARCH-001: many call sites each decided liveness ⇒ they disagreed.
- ARCH-002: one call site decided LIFETIME by assumption ⇒ it was simply wrong, silently, for a
  whole category of work.
- BUG-037's fix reads the SDK's `background_tasks_changed` signal — correct, but it is one consumer
  learning one engine's signal. Codex/other runtimes have their own notion (or none), so the same
  guess can regrow behind the runtime seam.

## The deeper failure it caused (the part worth designing against)
The false record was not merely cosmetic: it flowed into `takeBriefing()` and the orchestrator
ABANDONED AND RE-DISPATCHED LIVE WORK on the strength of it. **An observability surface became
control flow.** Any design here must state which surfaces are advisory and which may drive action,
and make acting on an advisory surface require corroboration.

## Options
1. **Declared lifetime at dispatch** — every unit of work carries `lifetime: turn | background`
   from creation, normalized at the runtime seam (each runtime maps its own signal, or declares
   `unknown`), consumed by anything that sweeps/settles/reports. `unknown` must never be coerced.
2. **Consumer-side guards only** — keep per-engine signals but forbid any sweep from settling work
   it did not start. Cheaper, but leaves the concept implicit and per-runtime.
3. Do nothing — accept that each new runtime re-learns this. Stated so the cost is explicit.

Recommendation: **1**, with the advisory-vs-actionable rule written down as part of it.

## Proof bar
No component may settle/end work whose lifetime it did not receive; a background unit survives its
dispatching turn's `result` with no record written (the end-to-end test BUG-037 left open); a
runtime with no lifetime signal yields `unknown` and nothing acts on it; briefings are marked
advisory and the orchestrator's own rule requires ground truth before abandoning work.

## Activity log (APPEND-ONLY)
### 2026-08-10 — orchestrator
- Filed from BUG-037's closing assessment. Second ARCH ticket; the FEAT-056 loop again produced it
  from a fixer's own structural suspicion rather than from anyone remembering to look.

### 2026-08-11 — orchestrator (decision taken)
- User standing instruction today: "do not wait for any further confirmation unless it's actually
  blocking". This decision had a clear recommendation with no counter-argument raised, so adopting
  **option 1: declared lifetime at dispatch** — `lifetime: turn | background | unknown` carried
  from creation, normalized at the runtime seam, `unknown` never coerced, plus the written
  advisory-vs-actionable rule (briefings/ledgers are ADVISORY; abandoning or re-dispatching live
  work requires ground-truth corroboration — the WA §C rule already captures the orchestrator half).
- BUG-043's WorkLifetime seam is the partial embodiment; the remaining implementation lands with
  BUG-044 (restart drain must consult lifetime) and FEAT-062 (verify→fix loop dispatches declare
  it). Proof bar unchanged. User can veto/reverse — nothing here is hard to unwind.

### 2026-08-13 — board reconciliation (status closed)
- The decision was taken (option 1) and its implementation has landed: BUG-043's WorkLifetime seam,
  BUG-044 (VERIFIED — restart drain consults lifetime) and FEAT-062 (VERIFIED — verify→fix dispatches
  declare lifetime), all deployed (pid 1162138 runs the latest code). Decision + implementation are
  both complete, so this ARCH ticket has no residual open work. Status header relabeled DECIDED→DONE
  so board:gen moves it out of the Open/queued list (it was inflating the FEAT-067 queued count).
  Reversible as noted; a runtime with no lifetime signal still yields `unknown` and nothing acts on it.
