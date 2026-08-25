# BUG-120 — the clean room strips only two doc dirs, so CONVENTIONS, TODO, HANDOVER and docs/analysis survive into every independent verification

- **Status:** OPEN
- **Severity:** medium
- **Area:** verification integrity (`scripts/independent-verify.mjs` clean-room strip)
- **Reported:** 2026-08-19 by the ticket-view content-loss lane (surfaced by an independent cross-provider round on commit `74e03e2`, and reported by the coordinator as out of that lane's scope)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom

The clean room's `CONTAMINATION` strip removes `docs/prompts` and `docs/bugs`
only. Everything else in `docs/` and the repo root travels into the room intact —
including at least `docs/CONVENTIONS.md`, `docs/ARCHITECTURE-REVIEW.md`,
`docs/analysis/`, `TODO.md` and `HANDOVER.md`.

Those files carry the project's own methodology, its architectural conclusions,
its in-flight plans and its handover notes. A clean-room verifier is supposed to
attack the change from outside the fixer's frame; if it can read the plan the
fixer worked from, it can inherit the fixer's assumptions and grade the change
against the same expectations that produced it. That is exactly the failure mode
the room exists to prevent, and it is invisible in the verdict — the room reports
PASS/BROKEN, never what it was allowed to read.

## Repro

1. Run `node scripts/independent-verify.mjs` for any ticket.
2. Inspect the room's working tree.
3. `docs/CONVENTIONS.md`, `docs/ARCHITECTURE-REVIEW.md`, `docs/analysis/`,
   `TODO.md` and `HANDOVER.md` are present.

## Expected

The strip is an ALLOW-list, not a deny-list of two paths. A file enters the room
only because something named it as necessary input; anything unnamed is stripped.
A deny-list is wrong here by construction: it has to be updated every time the
project grows a new doc, and nothing fails when it is not — which is how these
five got in.

The room should also RECORD what it was given, so a verdict can be read against
its own inputs rather than trusted blind.

## Why this is the same class as BUG-104

BUG-104 was "the clean-room strip is incomplete" for methodology and real
tickets, and it is still open. This is that ticket's shape one directory over:
the strip was extended by naming the two directories that had leaked, rather than
by inverting the rule. Same defect, next instance — which is the signature of a
deny-list.

## Notes

Filed from the ticket-view lane on the coordinator's instruction; that lane did
not touch `scripts/independent-verify.mjs`. No fix attempted here.

**This ticket is not in `INDEX.md` yet** — the filing lane was instructed not to
run `board:gen`. Whoever next runs it will pick this up; `npm run board:check`
will report the drift until then.

**Symptom of a deeper design flaw?** yes — a deny-list guarding an isolation
boundary. Whether that warrants an ARCH ticket of its own, or belongs inside
BUG-104's scope, is for whoever picks this up; BUG-104 is the prior instance.

## Activity log (APPEND-ONLY)

### 2026-08-19 — ticket-view content-loss lane

- **Understood:** an independent cross-provider round on `74e03e2` reported that
  the clean room's `CONTAMINATION` strip covers `docs/prompts` and `docs/bugs`
  only, so `docs/CONVENTIONS.md`, `docs/ARCHITECTURE-REVIEW.md`, `TODO.md`,
  `HANDOVER.md` and `docs/analysis/` reach every verifier. The coordinator ruled
  it out of that lane's scope and asked for it to be filed.
- **Changed:** nothing. This ticket only.
- **Verified:** nothing — not investigated in code. The finding is the verifying
  round's, reported second-hand and recorded verbatim rather than re-derived.
- **Still open:** all of it. Confirm the current strip list in
  `scripts/independent-verify.mjs`, decide allow-list vs deny-list, and decide
  whether this folds into BUG-104 or stands alone.
- **Handoff:** next agent should start by reading BUG-104 rather than this
  ticket's Expected section — that ticket already argued the boundary once, and
  the useful question is why the fix there did not generalise, not what to strip
  next.
