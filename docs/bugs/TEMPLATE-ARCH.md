# ARCH-<NNN> — <the design class, NOT a symptom>

<!--
  ARCH tickets are the OUTPUT CONTAINER for a re-architecture DECISION — they are
  not a bug report and not the thing that finds the problem. The finder is
  `scripts/arch-watch.mjs` (it raises a recurrence question on the Needs-You
  rail); a human/orchestrator decides whether the answer is "redesign"; if it is,
  the design work lives here. See docs/ARCHITECTURE-REVIEW.md.

  SYMPTOM FRAMING IS FORBIDDEN in this template. "The strip goes blank on reload"
  is a BUG. "Liveness is inferred independently in four places with no single
  owner" is an ARCH. If you cannot state the violated invariant, you do not yet
  have an ARCH ticket — keep it a BUG.

  An ARCH ticket is NOT a licence to rewrite working code. No build starts until
  the invariant, the options, the migration path and the proof bar below are
  filled in and a human has picked an option.
-->

- **Status:** OPEN
- **Severity:** low | medium | high (cost of leaving the design as-is)
- **Area:** (the subsystem being re-architected)
- **Reported:** <date> by <who> (arch-watch finding id, if that is what raised it)
- **Recurrence evidence:** the tickets that make this a class — `BUG-0xx, BUG-0yy, …`

## Violated invariant
The property the system is SUPPOSED to hold, stated so a test could check it.
One sentence. If every listed ticket is a different way of breaking the same
sentence, this is a real class.

## The design that produces this class
Why the current shape makes those failures likely — the structural cause, not the
individual bugs. Name the components, the ownership boundary that is missing or
misplaced, and the assumption that keeps turning out false.

## Why local patches did not hold
For each prior ticket: what it patched, and which part of the class it left
reachable. (This is the honest test of "is the design wrong?" — if every patch
was correct and the failure still recurs, the design is wrong.)

## Decision — <the question, in the reader's own words>

<!--
  THE HEADING MUST CONTAIN THE WORD "Decision", AND THE OPTIONS MUST BE BOLD-LEAD
  BULLETS IN EXACTLY THE SHAPE BELOW. This is not style: `ticketDecision()` in
  src/server/board.ts parses only this shape, and it is what renders the Decide
  card on the Needs-You rail. Options argued as numbered prose paragraphs — the
  shape this template used to show — parse to NOTHING: no card renders, and the
  ticket waits forever on a human who was never asked. ARCH-005 sat in exactly
  that state. `npm run board:check` now FAILS on it, so you will find out, but
  write it right the first time.

  Rules: at least TWO options · key is a short token (A, B, 1, 2 — max 6 chars) ·
  an em/en-dash or hyphen separates key from label · `KEY — label` sits inside ONE
  bold run · the rest of the bullet is the description and may wrap onto indented
  continuation lines. Put "Recommended: <key>" in the Status header if you have a
  recommendation; the parser validates it against the keys below and drops it if
  it matches none.
-->

- **A — <option>.** How it works · cost · what it makes impossible · what it gives up.
- **B — <option>.** …
- **C — do nothing / keep patching.** Always list this one, with the price of it.

Argument prose (evidence, pricing, why the rate matters) belongs around the
bullets, not instead of them.

## Migration path
Incremental steps from today's code to the chosen option, each step landable and
verifiable on its own. Name what stays working throughout, and the rollback.

## Proof bar — what would have to be true to call the new design right
The check that must pass, and the failure mode it would catch. A test that could
not have failed before the redesign proves nothing. State also what would falsify
the redesign (what observation would mean this was the wrong call).

## Decision record (filled in once an option above is chosen)
<!-- Keep "record" in this heading. It must not read as a second, empty set of
     options — the parser takes the first Decision heading that yields ≥2 of the
     bullets above, so an options-free record section is harmless where it sits,
     BELOW the real one. -->
- **Chosen option:** … (who decided, when)
- **Explicitly rejected:** … and why

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### <date> — <agent/who>
- **Understood:** …
- **Changed:** files, and the commit sha once committed
- **Verified:** commands + PASS/FAIL lines + screenshot paths
- **Still open / handoff:** the precise next step and WHY
