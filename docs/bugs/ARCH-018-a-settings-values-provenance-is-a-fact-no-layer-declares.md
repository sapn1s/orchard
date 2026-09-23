# ARCH-018 — A settings value's provenance is a fact no layer declares, so every reader derives it

<!--
  ARCH tickets are the OUTPUT CONTAINER for a re-architecture DECISION — they are
  not a bug report. See docs/ARCHITECTURE-REVIEW.md.
-->

- **Status:** OPEN
- **Severity:** low (latent — see "How urgent is this, honestly" below; not an emergency)
- **Area:** settings resolution — `public/lib/drawer.js` (`base()`, `val()`, `overriddenNow()`, `fieldProv()`), the server-side effective-config resolver in `src/server/agent-bridge.ts` (`pickOverridable()`), `src/server/global-settings.ts`
- **Reported:** 2026-09-19 by the FEAT-146 phase 2b lane, on its mandatory close-out question
- **Recurrence evidence:** one settled instance (FEAT-146's provenance chip) plus the class this board already named for the general shape — `ARCH-010` ("Whoever owns a fact writes it down; no reader works it out again")

## Violated invariant

**A value's provenance — which layer (built-in / machine / project / session) the
live value actually came from — is a fact no layer declares, so every reader
that needs it derives it again from the raw values.** A test of this: pick any
two present or future readers of a settings value that both need to say where
it came from, and check whether they can independently reach the same base
values and yet disagree about provenance. Today they can, because provenance is
not data anyone hands them — it is arithmetic each of them re-does.

## The design that produces this class

The resolution stack — `base()` (project/global raw value) → `live()` (server's
reported `EffectiveConfig`) → `ctx.overrides` (a pending local edit) → `val()`
(the composed display value) — hands back a **bare value** at every layer.
Nothing in that chain is tagged with "this came from session/project/machine/
built-in." `public/lib/drawer.js:254-378` is the one place that both computes
the resolved value (`val()`) and, separately, re-derives where it came from
(`fieldProv()`), by re-reading the same three inputs (`overriddenNow(field)`,
`isSet(base(field))`, `isSet(machineValue(field))`) a second time. The
resolver's output type carries no provenance field; the renderer manufactures
one from scratch by re-running the same layering logic the resolver already
ran to produce the value in the first place.

The server side is symmetric: `pickOverridable()` in `agent-bridge.ts` builds
the `EffectiveConfig` a session runs with by layering project settings under
session overrides, and returns the same shape — a bare value per field, plus a
flat `overridden: string[]` list (which fields differ from base, not which
*layer* supplied the value that's showing). A reader that needs "session,
project, machine, or built-in" cannot get it from `EffectiveConfig` as-is; it
would have to reconstruct the same three-way comparison `fieldProv()` already
does, in a different file, against a different variable.

## Why local patches did not hold (the four-idiom evidence)

Before FEAT-146, the settings UI had **four competing idioms** for "where did
this value come from," at four call sites, because the fact wasn't written
down anywhere for any of them to read:

| Idiom | Where | What it told the user |
|---|---|---|
| A `Built-in` button | machine-scope selects | this field has no machine default set |
| A `''`-valued "No global default" option | machine-scope selects | same fact, second spelling |
| The bare word `inherit` | project/session cycle rows | this row's value comes from somewhere above it |
| A `.inh` tag, hover-only | session scope | same fact, visible only to a mouse |

Four renderings of one fact, because four call sites each worked it out from
bare values with no shared source. That is `ARCH-010`'s shape verbatim.

**FEAT-146 fixed the symptom, not the design.** It replaced all four idioms
with one provenance chip (`provOf()`/`fieldProv()`/`provChip()`,
`drawer.js:353-371`), and the chip is consistent and correct — verified 59/59,
plus a five-state real-inheritance check (built-in/machine/project/session/
project-only) in the FEAT-146 activity log. But the fix is a **shared helper
that still derives**: `fieldProv()` is one function instead of four call
sites, and it computes provenance by re-reading `base()`/`overriddenNow()`/
`machineValue()` — the same three raw ingredients `val()` reads to compute the
*value*. Per `docs/CONVENTIONS.md`'s ARCH-010 decision procedure, an option
that "replaces N derivations with one shared helper that still derives" is
explicitly rejected — the defect survives with fewer copies, and the next
reader can still fail to call `fieldProv()` and derive its own, fifth idiom.
The FEAT-146 lane said as much in its own close-out: *"the data layer still
returns bare values, so the next surface that needs provenance ... will derive
it again."*

## Decision — should provenance become part of the settings resolver's contract, or stay a rendering concern

This is a genuine project-direction fork, not a bug to just fix: does Orchard
want "which layer this value came from" to be a fact the resolver states, or
does it accept that every surface computes its own display of it? A build lane
cannot answer this on its own — it is a call about how much the settings
contract should promise, not a code-correctness question.

- **A — the resolver returns provenance with the value.** `val()` (client) and
  `pickOverridable()`/`EffectiveConfig` (server) change shape: instead of
  returning a bare value per field, they return `{ value, level }` (or the
  existing bare-value map plus a sibling `provenance: Record<field, level>`),
  computed ONCE, at the point the layering decision is already being made
  (the `base → machine → project → session-override` walk `val()`/
  `pickOverridable()` already do). Every reader — the chip, a future launch
  popover, a future CLI, a future status line — reads `level` off the same
  object it reads `value` from; none of them re-derive it. This is the
  ARCH-010-shaped answer: the fact is declared once, at its source, by the
  code that already knows it because it just decided it. Cost: touches the
  return shape of two resolution paths used by every session launch (see
  Migration/blast-radius below) and every existing caller of `val()`/
  `EffectiveConfig` that destructures a bare value needs a one-line update
  (`.value` instead of the value itself, or an additive field if the shape is
  kept backward compatible).
- **B — a shared helper (`fieldProv()`-shaped), documented as the required
  call.** Keep resolution returning bare values; formalize `fieldProv()` (or a
  server equivalent) as *the* function every reader must call rather than
  re-deriving. **CONVENTIONS names this option and rejects it by name**: it
  replaces N derivations with one shared helper that still derives, and nothing
  stops a fifth call site from writing its own comparison instead of importing
  the helper — which is exactly how the first four idioms arose (nothing
  forced them to call a shared function; nothing here would force the next one
  either). Listed so the rejection is on the record and cannot be
  re-proposed as if it were new.
- **C — keep patching per surface, as FEAT-146 just did for one of them.**
  Price it honestly: this is what produced four idioms on one surface over
  time, with no call site aware the others existed. The next surface (a
  future launch popover, a CLI, an API consumer, a status line) starts from
  zero — it will not know `fieldProv()` exists, or will know and skip it, and
  either produces its own answer that can disagree with the chip's. Cheapest
  today, and the option that already failed once on this exact fact.
- **D — declare provenance is a rendering-only concept Orchard does not want
  as a resolver contract.** Explicitly decide the fact does NOT need a single
  owner — that "where did this come from" is inherently a display question,
  answered per-surface by design, and any future disagreement between two
  renderers is acceptable because they're allowed to have different
  provenance UX. This is a legitimate answer if the project decides
  provenance is cosmetic rather than semantic; it is listed because ARCH-010
  is a decision procedure applied deliberately, not a blanket rule that every
  fact must have one owner regardless of stakes.

## Migration path

Nothing here proposes rewriting FEAT-146's working chip. If A is chosen:

1. **Land the resolver-side field first, additively.** Add `provenance` (or
   `{value, level}`) to `EffectiveConfig` and to whatever `val()` returns,
   without removing the bare-value field — every existing caller keeps
   working unchanged. Verifiable: assert the new field round-trips correctly
   for one field with a known layering (e.g. `model` under
   `MACHINE_DEFAULTED`) against a real project/session pair.
2. **Point `fieldProv()` at the new field instead of re-deriving.** One-line
   change per call site (`drawer.js:363-368`); the chip's rendering and states
   are untouched, so FEAT-146's 59/59 + five-state suite becomes the
   anti-regression, run unmodified.
3. **Leave the bare-value field in place as long as any caller still reads
   it directly** (deprecate, don't delete, until a sweep confirms no reader
   is left computing its own provenance from the bare value).
4. Rollback at any step: the additive field can be dropped without touching
   the bare-value contract nothing else depends on.

**Blast radius, stated plainly.** `pickOverridable()`/`EffectiveConfig` is the
config every session launch resolves and runs with — this is not a cosmetic
UI refactor, it is a change to the shape of the object the runtime hands every
launched session. Any consumer of `EffectiveConfig` outside the settings UI
(session launch, the crown chips mentioned in FEAT-146's handoff, anything
that logs or persists effective config) needs to be enumerated before step 1
lands, not discovered after.

## Proof bar

- **What would make the new design right:** every reader of a settings value's
  provenance — the chip today, and whichever second surface arrives next
  (launch popover / crown chips / a CLI / a status line) — reads a `level`
  field off the same object the value came from, and zero call sites outside
  the resolver itself contain a `base()`/`overriddenNow()`/`machineValue()`-
  shaped three-way comparison. Count them: the count must be one (the
  resolver), not the current one-plus-whatever-the-next-surface-invents.
- **What would falsify it:** a second reader ships that reconstructs
  provenance from bare values instead of reading the declared field — that
  would mean the fix was cosmetic (same defect, new call site) rather than
  structural.
- **What would show this ticket was never load-bearing:** if no second
  surface ever needs provenance, this stays a one-reader fact and the
  question in this ticket never has to be answered — see below.

## How urgent is this, honestly

This is **latent, not biting**. FEAT-146 made the one existing surface (the
settings modal) correct and internally consistent — the chip is right, tested,
and does not disagree with itself. Nothing is broken today. This ticket
becomes load-bearing the exact moment a **second** surface needs to show
provenance — e.g. the launch popover or crown chips FEAT-146's own handoff
names as plausible next call sites. The cost of answering the fork then is
higher than answering it now only by the size of that second surface's own
build — the decision itself (A vs B vs C vs D) does not get any harder or
easier with time. Do not treat this as urgent; do treat "a second provenance
reader is about to be built" as the trigger to come back and decide it.

## Decision record (filled in once an option above is chosen)

- **Chosen option:** …
- **Explicitly rejected:** …

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-19 — filed from FEAT-146 phase 2b's close-out question
- **Understood:** FEAT-146 phase 2b answered its ticket-close question "symptom
  of a deeper design flaw?" with yes, latently, and named the exact defect: the
  provenance chip is a correct, tested display of a fact the resolver still
  makes every reader compute for itself. This ticket exists so that finding is
  not lost, and so the fork (does Orchard want provenance IN the settings
  contract, or does it stay a rendering concern) is asked as a decision rather
  than silently re-derived a second time when the next surface needs it.
- **Changed:** this ticket only. No code, no `src/`, no `public/` — three
  build lanes are live in `public/` concurrently with this filing.
- **Verified:** n/a — finding-only round; no code to verify. The evidence
  above (the four-idiom table, `fieldProv()`'s comment at
  `drawer.js:328-331`, `base()`/`overriddenNow()`/`val()` at
  `drawer.js:254-287`, `pickOverridable()` in `agent-bridge.ts`) was read
  directly in this round, not inherited from FEAT-146's own description of it.
- **Still open / handoff:** needs a human decision among A/B/C/D. Not a build
  ticket until one is chosen. If a build lane picks it up, start at Migration
  step 1 (additive resolver field) and do not touch FEAT-146's chip rendering
  until step 2.
