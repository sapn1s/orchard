```orchard-ticket
{
  "id": "BUG-241",
  "type": "bug",
  "title": "Leak-gate misses literal secrets in calls, casts, subscripts and multi-line values",
  "summary": "The Orchard leak-gate credential matcher passes clean on source lines that assign a real literal secret when the value arrives via a call argument, cast, subscript, concatenation, a multi-line value, a comment tail, or as a 14-char single-class password, so a committer gets a false PASS on a pasted credential in those forms.",
  "impact_if_we_wait": "A real secret pasted into any of these common code shapes is committed with the gate reporting a clean PASS, so the gate’s credential-catch promise is unmet for a whole family of assignment forms.",
  "current_need": "Decide and build targeted high-signal detection for these shapes without reopening the broad false-positive surface BUG-236 spent five rounds closing.",
  "severity": "medium",
  "area": "leak-gate credential detection recall",
  "reported": "2026-10-07",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-07",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Each of the 15 BUG-236 round-5 inputs (call-arg, cast, subscript, concat, multi-line, comment-tail, 14-char single-class) is flagged by the credential matcher.",
    "The FEAT-130 corpus and the BUG-236 round-5 fuzz/real-line corpora show no new false positives over the current matcher (no reopening of the BUG-236 over-flag surface).",
    "npm run gate stays green on the Orchard and target repos."
  ],
  "code_refs": [
    {
      "path": "scripts/lib/leak-tokens.mjs"
    },
    {
      "path": "scripts/leak-gate.mjs"
    },
    {
      "path": "scripts/verify-bug-236-code-value-precision.mjs"
    }
  ],
  "related": [
    {
      "id": "BUG-236",
      "relation": "see_also"
    },
    {
      "id": "ARCH-023",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# BUG-241 — Leak-gate misses literal secrets in calls, casts, subscripts and multi-line values

## Symptom

The Orchard leak-gate (`scripts/lib/leak-tokens.mjs` credential matcher, run by `scripts/leak-gate.mjs`) passes clean on source lines that assign a real literal secret, when the secret reaches the right-hand side through a shape the matcher does not read: inside a function-call argument, a TypeScript cast, a bracket subscript, a string concatenation, a value spread across more than one physical line, a trailing `//`/`/* */` comment, or a 14-character single-character-class password. A committer relying on the gate to catch a pasted credential in these forms gets a false PASS.

## Repro

Run the credential matcher (or the full gate) over each of the 15 lines below. Every one returns zero hits on the current tree. HEAD's matcher missed them too (confirmed in the BUG-236 round-5 verify run, `scripts/verify-bug-236-code-value-precision.mjs`, section A: 28/43 round 1–4 attack inputs flagged, these 15 unflagged), so this is a pre-existing recall gap in detection, NOT a suppression introduced by the BUG-236 round-5 redesign.

## Expected

Each line carries a literal secret value and should be flagged (or the accepted miss should be a recorded, deliberate limit), not silently passed.

## Evidence — the 15 unflagged inputs (verbatim, from BUG-236 round-5 Activity log)

Grouped by the shape that defeats the matcher. `\n` below is a real newline inside the value; `\` is a line-continuation backslash.

**14-char single-class password**
- "password: \"hunterpassword\""

**Literal secret inside a call argument**
- "const password = decrypt(\"Ab1!Cd2!Ef3!Gh4!\");"
- "const password = decrypt(\"7Kx2.9Qz4.3Mw8.5Rt1\");"
- "const password = decrypt(\"Ab1,Cd2,Ef3,Gh4,Ij5\");"
- "const token = decode(\"aB3!cD4!eF5!gH6!iJ7!kL8!\");"
- "const password = f(Ax9Kd, 82bQm10ZzPpLw);"

**Cast**
- "const password = (\"Ab1!Cd2!Ef3!Gh4!\") as string;"

**Subscript**
- "const password = store[\"Ab1!Cd2!Ef3!Gh4!\"];"

**Concatenation**
- "const password = prefix + \"Ab1!Cd2!Ef3!Gh4!\";"

**Multi-line value** (each block below is one input, shown with its real newlines)

````text
const password = (
  "Ax9Kd82bQm10ZzPpLw"
);
````

````text
const password =
  "Ax9Kd82bQm10ZzPpLw";
````

````text
password = \
    "Ax9Kd82bQm10ZzPpLw"
````

````text
password = decrypt(
    "Ax9Kd82bQm10ZzPpLw"
)
````

````text
const password = `
Ax9Kd82bQm10ZzPpLw
`;
````

**Comment tail**
- "const password = x + y // Ax9Kd82bQm10ZzPpLw"

## Diagnosis (where to look)

The matcher keys off an assignment/label shape and the token immediately to its right; it does not descend into call arguments, casts, subscripts, or concatenation operands, does not join a value that continues onto the next physical line, does not read a comment tail, and the password-entropy floor rejects a 14-char single-class string. All confirmed as HEAD-equal misses, so any fix is new detection, not a regression repair.

## Trade-off to settle when built

New detection here is bought with more false positives: call-argument / concatenation / comment forms are exactly where ordinary non-secret code also lives, and lowering the single-class length floor flags more dictionary words. BUG-236 spent five rounds proving that broad "residue" and grammar-aware extraction over-flag plain code; this ticket must add recall WITHOUT reopening that false-positive surface (e.g. targeted, high-signal value shapes rather than another broad grammar pass). Per the orchestrator this is filed to be built later, not now.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-07 — agent
- **Filed:** through the board tool; the record was validated before it was written.
