# FEAT-149 — The orchestrator can't read the board it cites, so it relays lane claims as fact

- **Status:** IN PROGRESS — a read-only `npm run board:status -- <ID>` was built and proven this round (the ground-truth command the orchestrator can run under its profile); the instruction-layer half (a lane must not destroy its own handoff) is a separate deliverable and independent verify is still warranted.
- **Severity:** high (a wrong status relayed as settled fact is acted on — a review verdict was appended to a ticket the orchestrator believed closed)
- **Area:** orchestrator tooling / board — `scripts/board-status.mjs` (new), reuses `scripts/board.mjs` (`readTickets`/`readIndex`) and `scripts/lib/ticket-schema.mjs` (`classifyLegacyStatus`)
- **Reported:** 2026-09-23 by a fixing lane, from a real orchestrator session that reproduced the defect it was reviewing
- **Verification-class:** fix  ⟶ independent verification warranted before VERIFIED — the orchestrator will trust this command's output as ground truth, so a case the fixer's own run does not cover (a promoted/block-format ticket; a ticket dirty-but-committed; a copied board dir) should be exercised by a clean-room dispatch.
- **Recurrence evidence:** ARCH-010 ("whoever owns a fact writes it down; no reader works it out again" — here the reader who must act on the fact literally cannot read it), ARCH-016 (lane result prose replayed as parent context), FEAT-148 (a ticket absorbed 11 verification rounds because nothing read the declared round count — the same board that no orchestrator surface reads back)

## What happened (measured, 2026-09-23)

An Orchard orchestrator runs under an enforced tool profile that removes `Read`,
`Grep` and `git grep`; it can run `npm`/`node`/`git status` and little else
(see `docs/CONVENTIONS.md`, "Who this rule is addressed to (FEAT-096)"). So the
single most-cited artifact in the project — a ticket's durable record on the
board — is the one thing the orchestrator cannot look at.

In one session the orchestrator asserted **ARCH-017's review history to the user
four times, and was wrong every time.** Three dispatched lanes returned three
contradictory counts of the same ticket's cross-provider review history — "11
rejections", then "7", then "8" — and the orchestrator relayed each as settled
fact, because it had no way to check. The user, looking at their own board,
could see the ticket was marked Done. The orchestrator then appended a review
verdict to that ticket. (The truth, from the ticket's own record: its Round 12
entry records the **8th** consecutive DO-NOT-LAND, and its Status header's
LEADING word is `IN PROGRESS` — the board places it in the Done table only
because an incidental "DONE" token buried in a very long status line trips
`classifyLegacyStatus`'s match-anywhere DONE rule, ARCH-004's one recorded blind
spot, live. So even "the board says Done" was itself a classification artifact,
not a human closing the ticket.)

## The class

**A reader that must act on a fact cannot read the artifact that owns it, so it
substitutes a claim from whatever channel is to hand — a lane report — and
relays that claim as though it had checked.** This is ARCH-010 from the other
side: it is not that no owner wrote the fact down (the ticket did), it is that
the one reader who most needs it has been denied the read, and a denied read
degrades silently into a relayed rumour. Every lane report is a summary written
under its own framing; three of them disagreed by construction, and nothing in
the orchestrator's reach could adjudicate.

## Why the obvious local patches do not hold

- **"Just let the orchestrator Read the ticket"** re-opens the exact hole the
  orchestrator profile closes on purpose (FEAT-096): an orchestrator with `Read`
  and `Grep` does the lanes' content work itself and its context bloats. The
  profile is deliberate; the fix must live inside it.
- **"Trust the freshest lane report"** is what produced the failure — freshness
  does not make a summary correct, and the three reports were all recent.
- **A second ad-hoc ticket parser** in a new command would be ARCH-010's own
  anti-pattern (a second place able to hold a different answer) and is refused;
  the command must read through the ONE shared reader.

## Delivered this round (deliverable 1)

`npm run board:status -- <ID>` (`scripts/board-status.mjs`) — runnable under the
orchestrator profile (node/npm only), reads through the board's own parsers
(`readTickets`/`readIndex` from `scripts/board.mjs`, `classifyLegacyStatus` from
`scripts/lib/ticket-schema.mjs`), and prints, compactly: `work_state`, the
LEADING status word AND a loud AMBIGUOUS/UNMAPPABLE flag when the two disagree,
the ticket's Status header (one line), the INDEX row's placement / owner / commit
/ status cell, whether the file is dirty in the working tree (from `git status
--porcelain`), the last N Activity-log entry HEADERS (dates + one-line summaries,
never bodies), and any `Verified-by:` lines. `--json` for machine use; zero args
prints a whole-board open / needs-you / ambiguous-status summary. Against the
real board it prints ARCH-017's ambiguity in the first two lines — exactly the
signal that would have stopped the wrong relay.

## Still open / handoff

- Deliverable 2 (separate): a dispatched lane whose LAST turn is a
  cleanup/redaction pass destroys its own handoff, so the substantive verdict is
  lost and the orchestrator (no `Read`) cannot recover it from the lane's scratch
  file. The standing rule belongs in the durable lane template, not a one-off
  charter.
- Independent clean-room verify warranted: the orchestrator will treat this
  output as ground truth, and the fixer wrote the fixture.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-23 — fixing lane (round 1, class fix)
- **Understood:** the orchestrator profile removes `Read`/`Grep`/`git grep`, so
  the orchestrator cannot check a ticket's state and relays lane claims as fact;
  measured on ARCH-017 (three lanes gave "11"/"7"/"8" rejections; the truth is 8,
  and the board's Done placement is itself an ambiguous-DONE classification of an
  `IN PROGRESS` ticket).
- **Changed:** added `scripts/board-status.mjs` and the `board:status` npm script.
  Reuses `readTickets`/`readIndex` (`scripts/board.mjs`) and `classifyLegacyStatus`
  (`scripts/lib/ticket-schema.mjs`) — no second parser (ARCH-010).
- **Verified:** ran against the REAL board. `board:status ARCH-017` surfaces the
  ambiguous-DONE trap in its first two lines and lists the Round 12 (8th
  DO-NOT-LAND) + 2026-09-23 session-audit entries as the newest two; a real Done
  ticket (`BUG-004`) prints `verified` + commit `f4fc2a3` + clean tree. Control:
  `ARCH-999` (valid shape, no file) exits 3 loudly, a malformed id exits 2 —
  neither reads as an empty success. Non-vacuity: ARCH-017 vs BUG-004 output
  DIFFERS, so the success branch reads the real record. `--json` and the zero-arg
  summary both work; the summary reports `ambiguous-DONE status: 1` (ARCH-017).
  Locked in as `npm run verify:feat-149` (`scripts/verify-feat-149-board-status.mjs`,
  11/0 against the real board — discovers a done + an open ticket at runtime,
  asserts the ambiguous-DONE surfacing, the loud control, and non-vacuity).
- **Verified-by:** pending — independent clean-room dispatch warranted (see above).
- **Still open / handoff:** deliverable 2 (lane final-message handoff rule in the
  durable template); independent verify of `board:status` on a promoted/block
  ticket and a copied board dir.
- **Symptom of a deeper design flaw?** yes → this ticket IS the class capture
  (ARCH-010 from the reader side); not filed as ARCH because the remedy is a
  concrete command, not an open re-architecture decision.

### 2026-09-23 — fixing lane (round 2, class fix) — wire the tooling into the injected instruction surfaces
- **Understood the gap:** round 1 built `npm run board:status` but nothing TOLD
  the orchestrator to run it — a tool nobody is instructed to use changes nothing.
  Confirmed BEFORE editing that none of the three durable auto-injected surfaces
  mentioned it: the tool-profile denial message (`refusalReason` in
  `scripts/lib/orchestrator-profile.mjs`) said only "dispatch it with the Agent
  tool"; the injected board snapshot header (`boardStateSection` in
  `src/server/board.ts`) said only "Re-read INDEX.md"; `docs/CONVENTIONS.md` had
  the ARCH-010 rule but no board:status corollary.
- **Changed (docs/instruction surfaces only, no product logic):**
  (1) `refusalReason` — for READ/SEARCH-shaped refusals only (Read/Grep/Glob and
  read-shaped Bash offenders like `git grep`/`cat`; NOT for e.g. a refused
  WebFetch) it now adds a paragraph: for a ticket's/board's state run `npm run
  board:status -- <ID>`, which is allowed under the profile and needs no lane —
  the highest-value placement because it fires exactly when the orchestrator is
  blocked. (2) `boardStateSection` header — a line stating a ticket's status is
  READ with board:status, never asserted from memory or a lane's claim; placed in
  the header region so it survives the tail-truncation cap. (3) `docs/CONVENTIONS.md`
  — a brief ARCH-010 corollary section.
- **Verified (real rendered text, before/after):** refusal for `Read` 885→1335
  chars, board:status paragraph present; `git grep` offender → present; `WebFetch`
  → absent (gating correct). Board snapshot stays at its 1200 cap (unchanged — cap
  NOT raised; the ~230-char header line trims the tail, which is done-recently
  content, not the status rule); boot-aware `<=1200` assertion still passes. No
  test pinned the refusal text or board header, so nothing regressed on wording.
- **Char-budget honesty:** the refusal message has no cap (grew freely, fine). The
  board snapshot IS at its 1200 cap and truncates the tail; the new header line
  costs ~230 chars of the least-critical tail (done-recently). I did NOT raise the
  cap. If the tail loss is judged too costly, raising `boardStateSection`'s default
  maxChars is the knob — flagged, not silently taken.
- **Process defects observed in the same 2026-09-23 session that this tooling does
  NOT fix (recorded so they are not mistaken for solved — all three are
  instruction-layer, unaddressed, and each needs its own change):**
  (a) the orchestrator asked the user questions that were its own to decide, then,
  when told to decide, dispatched a lane instead of answering — a
  decide-vs-delegate boundary failure, not a board-read failure;
  (b) it reported "Done" ambiguously enough that the user could not tell whether
  work was finished, independently verified, or committed — a completion-reporting
  vocabulary gap (finished ≠ verified ≠ committed);
  (c) it invented an optional chore and handed it over as a question — scope
  invention dressed as a user decision.
  board:status addresses only the fourth failure from that session (asserting a
  ticket's state without checking it); (a)/(b)/(c) are untouched by this ticket.
- **Verified-by:** pending — independent clean-room verify still warranted (round 1
  deliverable is trusted as ground truth; this round is instruction-text only, but
  the refusal-message gating logic — read-shaped vs not — is worth a second read).
- **Still open / handoff:** deliverable 2 (lane final-message handoff rule in the
  durable template) still separate; process defects (a)/(b)/(c) above unfiled.
