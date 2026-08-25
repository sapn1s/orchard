# BUG-122 — a promoted ticket lists its opening fence as its title, and the board reports two failures about it

- **Status:** FIXED (2026-08-20) — both halves landed: the readers, and the decision that promotion
  made invisible to the Needs-You rail. Independent clean-room verification outstanding.
- **Severity:** medium. Nothing is destroyed and the ticket file itself is untouched, but the board
  says two false things about a real ticket — its title and its state — and `board:check` exits 1,
  which is the gate every lane runs before committing. It is not high because it is a misstatement on
  a page in a single-user local tool. It is not low because 191 more tickets are queued for the same
  promotion, and each one lands the same two failures.
- **Area:** how a ticket file is read — the board tools, the ticket API and the rail
- **Reported:** 2026-08-20 by the user, from the live server
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom

ARCH-005 was promoted to the record format (commit `64c3389`) and is the only ticket on the board in
that format. Its own detail page reads correctly. Everywhere the SERVER describes it, it does not:

- the All-tickets list shows its title as the literal text ```` ```orchard-ticket ```` with a red
  `MISSING STATUS FIELD` badge where its state should be, and no severity
  (`docs/bugs/assets/BUG-122-before-all-tickets.png`)
- `GET /api/projects/<p>/tickets/ARCH-005` answers `"title": "```orchard-ticket"` and
  `"statusError": "MISSING STATUS FIELD: …"`
- `npm run board:check` FAILs twice on that one file — `MALFORMED H1` and `MISSING STATUS FIELD` —
  where the whole board was previously green

## Repro

1. `npm run board:check` → `DRIFT — 2 problem(s) found`, both naming ARCH-005's file.
2. Open the ticket dashboard's All-tickets table and find ARCH-005 → the title cell reads
   ```` ```orchard-ticket ````.

## Expected

A ticket that carries a leading ```` ```orchard-ticket ```` record takes its title, state and
severity from that record. A ticket that carries no record keeps today's behaviour, exactly — the
board is mixed for as long as the migration takes, and a reader that understands only one of the two
formats lies about half the board.

## Diagnosis

`scripts/lib/ticket-schema.mjs` already had the block-aware reader (`extractTicketBlock`,
`parseTicket` in `mode: 'auto'`), and the ticket PAGE already used it — which is why the detail view
was right and everything else was wrong. Every server-side reader asked for the prose format
explicitly:

| reader | call |
|---|---|
| `src/server/tickets.ts` `summarize` (the API list + detail) | `parseTicket(text, { mode: 'compat' })` |
| `scripts/board.mjs` `readTickets` (`board:gen` + `board:check`) | `parseTicket(text, { mode: 'compat' })` |
| `scripts/arch-watch.mjs` (the recurrence detector) | `parseTicket(text, { mode: 'compat' })` |
| `src/server/board.ts` `ticketTitle` (the Needs-You rail) | `parseTitleLine(text, { scan: true })` |

In `compat` mode the first line of a promoted file — the opening fence — is read as the H1 (hence
`MALFORMED H1`, and a title that falls back to the raw first line), and there is no
`- **Status:**` line to find at all (hence `MISSING STATUS FIELD`). It is not deploy lag: `compat` is
what the code asks for, at `HEAD`.

Why they all asked for `compat`: `parseTicket().record` is format-SHAPED. Legacy returns the prose
reading; block returns the JSON record verbatim. That is right for a caller that cares which format
it has (the migrator, the validator) and wrong for every caller that only wants to DESCRIBE a ticket.
Those callers wanted one shape, and `compat` was the only way to ask for one.

## The fix

`parseTicket` now returns a third thing beside `record` and `errors`: **`summary`** — the same
`LegacyTicketRecord` shape whatever format the file is in. For a legacy file it IS the record (the
identical object, so "unpromoted tickets behave exactly as before" is true by construction rather
than by a mapping that could drift). For a promoted file the human-layer fields are read off the JSON
record. The four readers above now pass `mode: 'auto'` and read `.summary`.

It adds no grammar and no second parser: the block is located by the existing `extractTicketBlock`,
and every field is copied or mapped, never re-derived from prose. The one mapping introduced is
`WORK_STATE_STATUS_WORD` (`open` → `OPEN`, …), which is a presentation choice, not a classifier —
and the suite round-trips all seven words back through `classifyLegacyStatus` so a mixed board can
never sort or place its two halves by two different rules.

`summary` is never `null`. A block that is present but unreadable — the state an interrupted bulk
promotion leaves behind — still summarises, carrying the id from the FILENAME and the parse failure
in `statusError`, so a half-written ticket stays listable and LOUD instead of disappearing or
throwing.

**Not touched, deliberately (see ARCH-008, open, awaiting a human):** the record grammar itself. This
ticket imports the one extractor and does not add a fourth implementation of it, does not move who
owns it, and builds no option from that ticket.

**Owner is deliberately still the curated INDEX cell**, for both formats. The record has an `owner`
field, but INDEX's Owner is what `setNeedsYou` and `answerTicket` write when the USER flips 👤 —
making the record authoritative would silently revert a user's own flip on the next read. Flagged for
the orchestrator rather than decided here.

## Verification

`npm run verify:bug-122` (`scripts/verify-bug-122-mixed-format-readers.mjs`) — 51/51.

Everything runs against the REAL board: the real promoted ticket, real legacy tickets, the real
server on an OS-assigned free port, the real page in a real headless browser. The promoted ticket is
DISCOVERED at runtime (whichever files open with the fence), never named, so the suite keeps working
as the other 191 are promoted — and it ABORTS LOUDLY if the board holds no ticket of either kind.

The must-FAIL is anchored to a SYNTHESIZED pre-fix state, not to `HEAD`: `mode: 'compat'` is the
exact argument the pre-fix call sites passed and is still there, so block D re-runs the old reader
against the real promoted ticket and asserts it STILL produces a fence-marker title, `MALFORMED H1`
and `MISSING STATUS FIELD`. Committing the fix cannot turn that green.

Block F truncates the REAL promoted file at five plausible points and grades each: a cut before the
closing fence must be REPORTED; a cut after it leaves the record whole, so the row must read
CORRECTLY rather than invent an error.

## Context pack

- Files in play: `scripts/lib/ticket-schema.mjs` (`blockSummary`, `WORK_STATE_STATUS_WORD`,
  `parseTicket`), `scripts/lib/ticket-schema.d.mts`, `scripts/board.mjs` (`readTickets`),
  `scripts/arch-watch.mjs`, `src/server/tickets.ts` (`summarize`), `src/server/board.ts`
  (`ticketTitle`), `scripts/verify-unmappable-status.mjs` (one guard narrowed, see the log)
- Related tickets: **ARCH-008** (the record grammar is implemented twice — cited, not pre-empted;
  block F is fresh evidence for it, and its "0 of 193 files use the format" measurement is now stale),
  **BUG-119** / **ARCH-009** (the migration is gated on ARCH-009 being decided), **BUG-121** (the
  fence regex is anchored and single-shot), **ARCH-005** (the artifact this was found on)
- Repro test: `npm run verify:bug-122`
- Known blockers: a live same-file collision on `scripts/lib/ticket-schema.mjs` — see the log

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — mixed-format reader lane (worker)

- **Class:** `fix`.
- **Hypothesis, tested first:** the charter's reading was that both readers should use the existing
  `extractTicketBlock` and fall back to the legacy path when a file has no block. CONFIRMED before
  building: `src/server/tickets.ts:43` and `src/server/board.ts:17` already import
  `scripts/lib/ticket-schema.mjs`, so there is no import barrier, and the fallback creates no
  ambiguity because the two states are mutually exclusive by the extractor's own rule (a record is
  the FIRST non-blank content or it is not a record).
- **Changed:** `parseTicket` gained `summary` (`blockSummary` + `WORK_STATE_STATUS_WORD`) in
  `scripts/lib/ticket-schema.mjs`, declared in `ticket-schema.d.mts`; four readers switched to
  `mode: 'auto'` + `.summary` (`scripts/board.mjs`, `scripts/arch-watch.mjs`,
  `src/server/tickets.ts`, `src/server/board.ts`); new suite
  `scripts/verify-bug-122-mixed-format-readers.mjs` + `verify:bug-122` in `package.json`.
- **Verified:**
  - `npm run verify:bug-122` → **51/51 PASS**.
  - `npm run board:check` → **exit 0, `OK — no drift`**. Measured delta against the pre-fix
    generator run over the SAME real board: **2 FAILs → 0**; the only other change is one advisory
    line whose text improved (`TITLE DIVERGENCE`: `"(unparseable title)"` → the record's real title).
    No warning class appeared or disappeared.
  - `board:gen` diff against `HEAD`'s own generator over the same corpus: exactly ONE line,
    `| ARCH-005 | (unparseable title) | … |` → `| ARCH-005 | Projects can show another project's
    running activity | … |`. Nothing else on the board moves.
  - `npm run gate` → **PASS (exit 0)**, read unpiped.
  - UI, real board in real headless brave, before/after at the same viewport and the same filter:
    `docs/bugs/assets/BUG-122-before-all-tickets.png` (pre-fix code at `64c3389` in a pinned
    worktree, pointed at the real promoted board — row reads ```` ```orchard-ticket ```` with a red
    `MISSING STATUS FIELD` badge) vs `docs/bugs/assets/BUG-122-after-all-tickets.png` (row reads
    "Projects can show another project's running activity", `OPEN — NEEDS A HUMAN DE…`, `medium`).
    Also `BUG-122-all-tickets-mixed-board.png` and `BUG-122-ARCH-005-detail.png`. The suite asserts
    the row is IN FRAME before capturing and that all three captures in a run differ by sha256.
  - Anti-regressions, each compared against the SAME suite run in a `git worktree` pinned at
    `64c3389` (never against "current"):
    `verify:board-tool` 34/34 PASS · `verify:provenance` 17/17 PASS · `verify:decision-shape` 25/25
    PASS · `verify:reachability` 16/16 PASS · `verify:feat-090` 26/26 PASS · `verify:feat-082` 52/52
    PASS · `verify:unmappable-status` **679/13 baseline → 691/1** (12 of the baseline's failures were
    ARCH-005's two board FAILs leaking into other assertions; the 1 remaining fails identically at
    baseline) · `verify:ticket-schema` 52/1 both · `verify:arch-watch` 48/1 both, same failure ·
    `verify:migrate-tickets` 50/1 both, same failure · `verify:tickets` 28/29 both, same failure ·
    `verify:needs-you-rail` 16/17 both, same failure · `verify:ticket-writing` red at both.
- **One guard NARROWED, named rather than buried:** `verify-unmappable-status.mjs` asserted that
  `board:gen` emits an INDEX byte-identical to `HEAD`'s. On a board with a promoted ticket that can
  never be true again — reading that row off the record is the whole of this ticket. It now asserts
  "identical EXCEPT on a promoted ticket's own row", prints every differing row, and still fails on
  any churn to a legacy row, which is the property it was written for.
- **Still open / handoff:**
  1. **A server restart is OWED.** `src/server/tickets.ts` and `src/server/board.ts` changed; the
     running station on :4317 does not contain them. Not restarted by this lane, by charter.
  2. **NOT COMMITTED — a live same-file collision.** Partway through this lane, another agent began
     editing `scripts/lib/ticket-schema.mjs` in the same working tree (`RETIRED_KEYS`,
     `verification_state` retired per ARCH-009), along with `public/app.js`,
     `public/lib/ticket-record.js`, `public/styles.css`, `scripts/migrate-tickets.mjs`,
     `scripts/verify-ticket-schema.mjs` and `scripts/verify-ticket-view-redesign.mjs`. A
     `git commit --only -- scripts/lib/ticket-schema.mjs` would sweep that lane's uncommitted work
     into this commit (WA §J). The orchestrator should serialise the two lanes and then commit.
  3. **A semantic overlap with that lane:** `blockSummary` maps `record.verification_state`; ARCH-009
     is removing that key. After their change it reads as `null` for a promoted ticket, which
     degrades safely (nothing in this fix keys on it) but should be reconciled deliberately.
  4. **Not done, and the more expensive half:** a promoted ticket's DECISION is now invisible to the
     rail. `ticketDecision` (`src/server/board.ts`) parses `## Decision` prose, and a promoted ticket
     carries its options as JSON instead — ARCH-005's four options reach no Decide card, and
     `board:check`'s decision-shape guard no longer triggers on it (its trigger reads the prose
     Status header, which is gone). That was left alone on purpose: it is ARCH-008's territory.
     **It should be settled before the bulk cutover, or 191 promotions will silently unask every
     question on the board.**
  5. This is a `fix` touching a file with a regression history, so an independent clean-room pass is
     warranted before VERIFIED — `node scripts/independent-verify.mjs`, per docs/bugs/README.md #5.
- **Symptom of a deeper design flaw?** yes → already filed as **ARCH-008**. Its own severity note
  says the format is in use on "0 of 193 ticket files, because the migration has not run"; that is
  now false, and this ticket is what the first file cost.

### 2026-08-20 — mixed-format reader lane (worker), second pass

- **Understood:** the coordinator called the residual I handed back — a promoted ticket's DECISION
  reaching no human — the most important thing found, and assigned it here because it lives in the
  same files. It is the same defect one layer up: promotion removes the prose that two different
  things read, so the ticket's title was misread AND its question stopped being asked. The second is
  worse, because nothing showed a symptom: `board:check`'s decision-shape guard — written precisely
  to end that silence — stopped triggering, so a promoted ticket blocked on a person raised nothing
  anywhere.
- **Changed (the rail half):**
  - `src/server/board.ts` — `ticketDecision` gains a THIRD shape, checked FIRST: when the file
    carries a record, the decision is built from `record.decision` (`decisionFromRecord`); otherwise
    the two prose shapes run exactly as before, so an unpromoted ticket never reaches the new branch.
    It reads no prose and adds no grammar: the block is located by the one shared reader, and the
    options are authored `key`/`label` fields. The prose STRICTNESS is mirrored, not relaxed — fewer
    than two usable options is not a choice, the recommendation is validated against the real keys,
    and the question falls back to the title (flagged `questionFromTitle`) rather than ever being
    empty, which is what keeps the item answerable.
  - `scripts/board.mjs` — `decisionShapeFails` gains a THIRD trigger: a record that carries a
    `decision`, or a `human_action` of `decide` / `staged_decision` / `multi_select_decision`. Both
    old triggers read prose that promotion deletes, which is why the guard went quiet. Design rule 1
    is untouched: the verdict is still `ticketDecision` itself, the same function the rail calls.
- **Deliberately NOT done, named rather than flattened:** `decision.mode: "staged"` splits options
  across `stages`; the rail's flat option list cannot express that, and deciding which stage is live
  needs per-stage answer state that does not exist yet. All options are offered — which is exactly
  what the rail showed for this ticket BEFORE it was promoted. Parity restored, not a redesign. The
  record now carries information the rail cannot express; that is a follow-up, not this fix.
- **`verification_state`, as the coordinator asked:** the MAPPING is deleted — nothing reads that
  field off a record anywhere. I kept the KEY, hard-set to `null`, rather than removing it: it is
  still real on the legacy path (transcribed from the prose Status word by `LEGACY_STATUS_TABLE`),
  `ticket-schema.d.mts` types it `VerificationState | null`, and `src/server/tickets.ts:244` puts it
  on the API as `verificationState`. Removing the key would have handed that contract `undefined`.
  Runtime-proven on the real promoted ticket: `key present: true | value: null`. ARCH-009's
  `classifyLegacyStatus` status word was left completely alone, as instructed.
- **Verified (combined tree, after re-reading the full diff of every shared path):**
  - `npm run verify:bug-122` → **71/71 PASS** (was 51/51; blocks H and I are new).
  - `npm run verify:bug-119` (the other lane's) → **118/118 PASS**.
  - `npm run gate` → **PASS (exit 0)**, read unpiped.
  - New must-FAILs, both anchored to synthesized pre-fix states that cannot go stale:
    the prose-only parser fed the ticket's body still finds NO decision (`null`); and the pre-fix
    `board:check` trigger is provably blind to the file (no prose status, no options H2).
  - New guard proof: reducing the record's decision to ONE option makes `board:check` FAIL with
    `UNPARSEABLE DECISION` naming the ticket — and it still does with the ENTIRE prose body removed,
    proving the trigger reads the record, not leftover prose. The inverse arm (`DECISION NOT ROUTED`
    on a non-👤 row) fires on the record format too.
  - Real browser, real board: the Needs-You rail renders ARCH-005 as a Decide card with the record's
    question and all four option buttons — `docs/bugs/assets/BUG-122-ARCH-005-decide-card.png`
    (the card is asserted IN FRAME before capture; the first attempt's DOM assertions passed while
    the screenshot showed the rail scrolled past it).
  - ANSWERABLE end to end, on a scratch COPY of the real ticket (the real board is never written):
    the same `POST /board/answer` route the card posts to returns 200, the answer is APPENDED with
    every prior byte intact, and the ticket moves to the answered-awaiting lane carrying it.
  - Anti-regressions on the combined tree: `board-tool` 34/34, `provenance` 17/17,
    `decision-shape` **25/25**, `reachability` 16/16, `feat-090` 26/26, `feat-082` 52/52 — all PASS.
    `unmappable-status` **691/1**, `ticket-schema` 57/1, `arch-watch` 48/1, `migrate-tickets` 52/1 —
    every remaining failure identical in name to the pre-fix baseline at `64c3389`.
- **A measurement worth recording, because it looked like a regression and was not:**
  `unmappable-status` first read 684/8 on the combined tree. All 7 extra failures assert
  "board:check exits 0" over a COPY of the real board, and the real board's `INDEX.md` was stale —
  ARCH-009 and BUG-119 had just gone FIXED and BUG-122 was new, none of their rows regenerated
  (INDEX is orchestrator-owned). Proven, not assumed: `board:gen` on a copy of the real board takes
  `board:check` to **`OK — no drift`, exit 0, zero FAILs**, and re-running the suite in a repo copy
  with that regenerated INDEX gives **691/1** — the pre-existing failure alone.
- **Handoff — a red that is pre-existing but will get 191× worse:**
  `scripts/verify-ticket-schema.mjs` check (C) ("every real ticket's status maps to a work_state")
  fails naming ARCH-005, because it builds its corpus with `legacyField(text, 'Status')` — the PROSE
  field, which a promoted ticket does not have. Identical at `64c3389`, so not a regression, and NOT
  touched here: that file is held by the ARCH-009 lane. It needs the same narrowing
  `verify-unmappable-status.mjs` got — assert the property for legacy tickets and read a promoted
  ticket's state from its record — or the bulk cutover turns one red into 191.
- **Still open:** a **server restart is owed** (`src/server/tickets.ts`, `src/server/board.ts`); an
  independent clean-room pass is warranted on both halves (I wrote fix and fixture); and ARCH-008
  still awaits a human on who owns the record grammar — nothing here pre-empts it.
