```orchard-ticket
{
  "id": "BUG-122",
  "type": "bug",
  "title": "The board named a ticket after its opening code fence",
  "summary": "One ticket had been converted to the new record format. Everywhere except its own detail page, the board showed its title as the first line of that record and reported its state as missing. The readers that describe a ticket now understand both formats, and the ticket list, the API and the standing board check all read it correctly.",
  "impact_if_we_wait": "The board would state two false things about every converted ticket, and the pre-commit board check would fail. Bounded: display and reporting only. Ticket files themselves are never written or lost.",
  "current_need": "Nothing is outstanding. A reader forced back to the old behaviour still reproduces both failures against the real converted ticket, while the corrected readers describe it properly, and standing checks stayed clean.",
  "severity": "medium",
  "area": "Ticket reading and board display",
  "reported": "2026-08-20",
  "reported_by": "user",
  "owner": "you",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-20",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A ticket in the record format shows its real title, state and severity everywhere",
    "A ticket in the older prose format behaves exactly as it did before",
    "The standing board check passes on a board holding both formats",
    "A ticket whose record is cut short still appears, marked with a loud error",
    "All seven state words map back to the same classification the board already used"
  ],
  "code_refs": [
    {
      "path": "scripts/lib/ticket-schema.mjs",
      "symbol": "blockSummary",
      "note": "parseTicket now returns a third value, `summary`, in one shape for both formats; for a prose file it is the same object as `record`"
    },
    {
      "path": "scripts/lib/ticket-schema.mjs",
      "symbol": "WORK_STATE_STATUS_WORD",
      "note": "presentation-only mapping of work_state to a status word; the suite round-trips all seven through classifyLegacyStatus"
    },
    {
      "path": "scripts/lib/ticket-schema.mjs",
      "symbol": "extractTicketBlock",
      "note": "the existing extractor, imported rather than reimplemented; BUG-121 anchored its fence regex"
    },
    {
      "path": "src/server/tickets.ts",
      "symbol": "summarize",
      "note": "asked for compat mode; now auto, reading .summary"
    },
    {
      "path": "scripts/board.mjs",
      "symbol": "readTickets",
      "note": "backs board:gen and board:check; asked for compat mode"
    },
    {
      "path": "scripts/arch-watch.mjs",
      "symbol": null,
      "note": "the recurrence detector, also on compat mode"
    },
    {
      "path": "src/server/board.ts",
      "symbol": "ticketTitle",
      "note": "the Needs-You rail read the title line by scanning, so a converted ticket's decision was invisible to it"
    },
    {
      "path": "scripts/verify-bug-122-mixed-format-readers.mjs",
      "symbol": null,
      "note": "discovers the converted ticket at runtime and aborts loudly if the board holds neither format"
    },
    {
      "path": "scripts/verify-unmappable-status.mjs",
      "symbol": null,
      "note": "one guard narrowed as part of this change"
    },
    {
      "path": "docs/bugs/assets/BUG-122-before-all-tickets.png",
      "symbol": null,
      "note": "the All-tickets table before the fix, showing the fence as the title"
    }
  ],
  "related": [
    {
      "id": "ARCH-005",
      "relation": "see_also"
    },
    {
      "id": "ARCH-008",
      "relation": "see_also"
    },
    {
      "id": "ARCH-009",
      "relation": "depends_on"
    },
    {
      "id": "BUG-119",
      "relation": "see_also"
    },
    {
      "id": "BUG-121",
      "relation": "depends_on"
    },
    {
      "id": "BUG-123",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-124",
      "relation": "blocks"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-122-promoted-ticket-lists-its-opening-fence-as-its-title.md",
    "sha256": "a2d37c5440c473eb1df1489e2904b0551744b56a015161fb8cf45ade1a4eaaa3",
    "bytes": 20188,
    "original_title": "a promoted ticket lists its opening fence as its title, and the board reports two failures about it",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Checked field by field against the original head: symptom, repro, the four compat call sites, the summary design, both deliberate non-changes, and the suite's anti-anchoring all survive.",
    "dropped": [
      "the severity paragraph's argument for why it is neither high nor low, whose conclusion the severity field and impact bound now carry"
    ]
  }
}
```

# BUG-122 — The board named a ticket after its opening code fence

## Diagnosis

### Where it broke

The block-aware reader already existed in `scripts/lib/ticket-schema.mjs` (`extractTicketBlock`, `parseTicket` in `mode: 'auto'`), and the ticket detail page already used it — which is why that one view was right and everything else was wrong. Every server-side reader asked for the prose format explicitly:

| reader | call |
|---|---|
| `src/server/tickets.ts` `summarize` (API list + detail) | `parseTicket(text, { mode: 'compat' })` |
| `scripts/board.mjs` `readTickets` (`board:gen` + `board:check`) | `parseTicket(text, { mode: 'compat' })` |
| `scripts/arch-watch.mjs` (recurrence detector) | `parseTicket(text, { mode: 'compat' })` |
| `src/server/board.ts` `ticketTitle` (Needs-You rail) | `parseTitleLine(text, { scan: true })` |

In `compat` mode the first line of a promoted file — the opening fence — is read as the H1, hence `MALFORMED H1` and a title that falls back to the raw first line. There is no `- **Status:**` line to find at all, hence `MISSING STATUS FIELD`. This was not deploy lag: `compat` is what the code asked for at `HEAD`.

### Why every caller asked for `compat`

`parseTicket().record` is format-shaped. Legacy returns the prose reading; block returns the JSON record verbatim. That is right for a caller that cares which format it has — the migrator, the validator — and wrong for every caller that only wants to describe a ticket. Those callers wanted one shape, and `compat` was the only way to ask for one.

## Evidence

ARCH-005 was promoted to the record format in commit `64c3389` and was the only ticket on the board in that format.

- the All-tickets list showed its title as the literal text ```` ```orchard-ticket ```` with a red `MISSING STATUS FIELD` badge where its state should be, and no severity (`docs/bugs/assets/BUG-122-before-all-tickets.png`)
- `GET /api/projects/<p>/tickets/ARCH-005` answered `"title": "```orchard-ticket"` and `"statusError": "MISSING STATUS FIELD: …"`
- `npm run board:check` reported `DRIFT — 2 problem(s) found`, both `MALFORMED H1` and `MISSING STATUS FIELD` naming that one file, on a board that had been green

Repro: run `npm run board:check`, then open the dashboard's All-tickets table and find ARCH-005.

### What ran on the fix

`verify:bug-122` 71/71 and `verify:bug-122-mixed-format-readers` 51/51. The neighbouring suites stayed green: `verify:board-tool` 34/34, `verify:provenance` 17/17, `verify:decision-shape` 25/25, `verify:reachability` 16/16, `verify:feat-090` 26/26, `verify:feat-082` 52/52, `verify:bug-119` 118/118. `board:check` reported clean.

## Implementation notes

### The shared shape

`parseTicket` now returns a third thing beside `record` and `errors`: `summary`, the same `LegacyTicketRecord` shape whatever format the file is in. For a legacy file it *is* the record — the identical object — so "unpromoted tickets behave exactly as before" holds by construction rather than by a mapping that could drift. For a promoted file the human-layer fields are read off the JSON record. The four readers above pass `mode: 'auto'` and read `.summary`.

No new grammar and no second parser: the block is located by the existing `extractTicketBlock`, and every field is copied or mapped, never re-derived from prose. The one mapping introduced is `WORK_STATE_STATUS_WORD` (`open` → `OPEN`, and so on), a presentation choice rather than a classifier — the suite round-trips all seven words back through `classifyLegacyStatus`, so a mixed board can never sort or place its two halves by two different rules.

`summary` is never `null`. A block that is present but unreadable — the state an interrupted bulk promotion leaves behind — still summarises, carrying the id from the filename and the parse failure in `statusError`, so a half-written ticket stays listable and loud instead of disappearing or throwing.

### Deliberately not touched

The record grammar itself, which is implemented twice and is ARCH-008's subject. This work imports the one extractor, adds no fourth implementation, does not move who owns it, and builds no option from that ticket. Block F is fresh evidence for it, and its "0 of 193 files use the format" measurement is now stale.

Owner remains the curated index cell for both formats. The record carries an `owner` field, but the index Owner is what `setNeedsYou` and `answerTicket` write when the user flips the 👤 marker; making the record authoritative would silently revert a user's own flip on the next read. Flagged for the orchestrator rather than decided here.

## Verification plan

`npm run verify:bug-122` (`scripts/verify-bug-122-mixed-format-readers.mjs`).

Everything runs against the real board: the real promoted ticket, real legacy tickets, the real server on an OS-assigned free port, the real page in a real headless browser. The promoted ticket is discovered at runtime — whichever files open with the fence — and never named, so the suite keeps working as the other 191 are promoted. It aborts loudly if the board holds no ticket of either kind.

The must-FAIL is anchored to a synthesized pre-fix state rather than to `HEAD`. `mode: 'compat'` is the exact argument the pre-fix call sites passed and is still available, so block D re-runs the old reader against the real promoted ticket and asserts it still produces a fence-marker title, `MALFORMED H1` and `MISSING STATUS FIELD`. Committing the fix cannot turn that green.

Block F truncates the real promoted file at five plausible points and grades each. A cut before the closing fence must be reported; a cut after it leaves the record whole, so the row must read correctly rather than invent an error.

A clean-room independent pass was called for by the verification class and is not among the records here.

## Migration and rollback

The board is mixed for as long as the migration takes. A reader that understands only one of the two formats lies about half the board, which is why the readers changed before more files did. The bulk promotion of the remaining tickets is gated on ARCH-009 being decided.

## Risks

A live same-file collision on `scripts/lib/ticket-schema.mjs` was a known blocker while this landed.

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
