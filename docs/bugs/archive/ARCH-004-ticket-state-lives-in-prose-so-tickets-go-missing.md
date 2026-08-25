# ARCH-004 — a ticket's state lives in prose, so tickets silently disappear and nothing notices

- **Status:** OPEN — DECISION NEEDED (no build until a human picks an option). Recommended: one canonical state field plus a reachability check.
- **Raised from:** the user filtering the board for open items needing them and getting one result when seven awaited them
- **Reported:** 2026-08-18

## The situation

Where a ticket "is" is currently recorded three different ways that nothing keeps in agreement:

- a **status line written as prose** ("OPEN — recommend building it read-only"),
- an **owner cell curated by hand** (the marker meaning *a human must decide*),
- and its **table placement**, derived by pattern-matching the prose for words like DONE.

Change one and the others do not follow. So a ticket can be described as awaiting a decision, while
being marked unassigned, while sitting in the finished table — all at once, with no contradiction
anyone can see.

## What this costs us

A misfiled ticket does not look wrong. It **disappears** from the place someone would have looked, and
nothing reports it. Three separate instances happened here, each found only by accident:

- Seven tickets carrying a recommendation were never marked as awaiting the user. Filtering for
  "needs me" returned one. The other six were invisible until the user happened to say the number
  looked wrong.
- One ticket sat in the finished table for days because its status text contained the word "done"
  inside an unrelated phrase.
- A ticket vanished from the attention rail because its *description* happened to contain a phrase the
  code searched for anywhere in the file.

The drift check reported "no drift" throughout. That is not a bug in the check — it verifies that the
index and the tickets agree with each other. Nothing verifies that a ticket is *reachable by a human
looking for it*. Two surfaces can agree perfectly and both be wrong.

## Why this keeps happening

State is expressed in a medium built for humans and then parsed by pattern-matching. Prose invites
incidental words; regex cannot tell an incidental word from a deliberate one. Every fix so far has
sharpened one pattern — anchoring a search, rewording a status — which removes that instance and leaves
the mechanism intact.

## The decision

- **A — keep sharpening the patterns.** Fix each mis-parse as it appears. *Cost:* three instances have
  already happened and the next incidental word will do it again. *Benefit:* no migration.
- **B — one canonical state, plus a reachability check. (Recommended.)** Give a ticket a single machine
  state chosen from a fixed set, and derive placement and the needs-a-human marker from that. The prose
  line stays, as a human blurb *beside* the state rather than the source of it. Then add the check that
  is genuinely missing: **every open ticket must appear on at least one surface a person actually looks
  at, and one that appears on none is reported.** *Cost:* a migration across existing tickets and a
  parser change. *Benefit:* incidental words stop moving tickets, and the failure mode that hid all
  three instances becomes visible.
- **C — reachability check only.** Leave the prose model alone; add just the "is this ticket findable"
  check. *Cost:* mis-parses keep happening. *Benefit:* they stop being *silent*, which is the part that
  actually hurt — and it is much the smaller change.

**Recommended: B**, because it removes the cause rather than reporting the symptom. But **C is the
honest cheap option** and captures most of the value — if the migration looks expensive, take C and
stop there.

## What I need from you

Pick A, B or C. Nothing is blocked meanwhile; the immediate mis-flagging is being corrected by hand.

## If you do nothing

The flags get fixed this time and the mechanism stays. The next ticket whose status happens to contain
an unlucky word leaves the board quietly, and we find out when you notice a number looks wrong.

> Technical detail below — reference, skip unless you are implementing this.

### Where each representation lives
- Status prose: the `- **Status:**` line of each ticket file, matched by `board.mjs`'s `isDoneStatus`
  (`/\bDONE\b/`) to decide Open vs Done placement.
- Owner cell: curated in `docs/bugs/INDEX.md`, read by `readBoard` in `src/server/board.ts` to populate
  `needsYou`.
- Derived lanes: `needsYou`, `inflight`, `queued`, `answeredAwaiting`, `observations` — all computed in
  `readBoard`/`boardSummary` from combinations of the above plus the Activity log.

### Instances, with their mechanism
1. **Seven tickets un-flagged** (2026-08-18): recommendations were written into status lines by one
   pass; the Owner cells were never touched. `needsYou` derives from Owner, so the board reported one.
2. **FEAT-082 in the Done table**: its status read "proposal done"; `isDoneStatus` matched the bare word.
   Two further tickets were nearly moved the same way during a rework ("cleanup done", "explore done")
   and were caught only because the author noticed the table change.
3. **Rail disappearance**: `alreadyAnswered` substring-matched the whole ticket file for a marker phrase,
   so any ticket whose prose contained it was treated as answered and dropped. Fixed by anchoring to the
   Activity-log heading — an instance fix, not a mechanism fix.

### On the drift check
`board:check` compares INDEX rows against ticket files and reports disagreement. It reported OK during
all three instances, correctly: the two representations agreed. The missing property is reachability —
that an open ticket is surfaced *somewhere a human would find it*. That check does not exist.

## Activity log (APPEND-ONLY)
### 2026-08-18 — orchestrator
- Raised after the user's board filter returned one ticket where seven awaited them, and the cause turned
  out to be a third instance of the same mechanism rather than a one-off. Per the recurrence rule this is
  a design question, not a fourth patch. Not filed as a bug: the immediate mis-flagging is being corrected
  separately and is not what this ticket is about.

### 2026-08-18 — worker (FEAT-082 precondition lane)
- Implemented **option C's reachability check ONLY** (not option B's canonical-state migration — the wider
  A/B/C decision on this ticket **remains open** and unchosen). Built as a ride-along in
  `scripts/board.mjs` wired into `board:check`: for every ticket **open by its own Status header**
  (`isDoneStatus` false — the same determination the board uses for placement, so the prose model is left
  untouched per option C), it verifies the ticket is findable on at least one lane a human actually reads —
  needs-you / answered-awaiting / in-flight / queued / recently-updated (7d). Lanes are read from the LIVE
  rail (`readBoard` in `src/server/board.ts`), so the check tests the user's real surface including its
  drop rules (an answered-and-already-acted 👤 ticket the rail removes from every lane). A ticket on none,
  and gone quiet (>7d by newest activity date OR file mtime), is reported as a `UNREACHABLE TICKET:` FAIL
  with its id, title, and why (placement + last-updated), so a person can act.
- **Non-redundant with the drift guard**, by construction: the must-FAIL fixture is a 👤/OPEN/Open-section
  ticket that agrees with itself perfectly — no STATUS MISMATCH / STALE OWNER / MISSING fires on it — yet
  the rail drops it and reachability is the only check that names it. That is exactly the "two surfaces
  agree and both are wrong" failure class this ticket describes.
- **Run against the REAL board: 0 unreachable tickets** (the board is currently healthy on this property).
- **Honest residual (the boundary of option C):** because "open" is keyed on the prose Status header, the
  check CANNOT catch a ticket mis-classified as *done* by an incidental word in its header (instance #2's
  mechanism, "proposal done"). Closing that needs option B's canonical machine state. Reported so the A/B/C
  choice is made with the tradeoff visible.
- Guarded like the docs:fresh ride-along: `board.mjs` is copied into onboarded repos (COPIED_TOOLS) where
  `board.ts` and the rail do not exist; there reachability degrades to silence (those repos read INDEX.md
  directly, already covered by MISSING FROM BOARD). Verify: `scripts/verify-reachability.mjs` (17/17),
  must-FAIL both directions + the real-board run.

### 2026-08-18 — you (answer · via ticket view)
- **Question:** a ticket's state lives in prose, so tickets silently disappear and nothing notices
- **Answer:** bro obviously it must be fixed set choicees, idk why is this a qustion
- **State:** answered — awaiting agent action (not dispatched)

### 2026-08-19 — worker (option B built; this ticket is SUPERSEDED)

**Superseded by** `docs/analysis/ticket-board-redesign-plan.md` and its first landed increment,
commit `15759b0` ("ticket board steps 1-3: one parser, one definition of \"done\", and the
provenance check"). The answer above — *"obviously it must be fixed set choices"* — is **option B**,
and option B is now built. This ticket's status header is deliberately left OPEN by this lane: the
plan closes it at its own step 8, together with FEAT-082 and the regenerated spec copies, and moving
it now would require a `board:gen` while other lanes hold uncommitted ticket edits.

**What landed against this ticket's complaint.**

- `scripts/lib/ticket-schema.mjs` is the one canonical definition. The state fields are fixed sets:
  `work_state` (open · in_progress · in_verification · verified · done · blocked · not_a_bug),
  `human_action`, `verification_state`, `type`. Anything else fails validation. That is option B's
  "one canonical machine state", verbatim.
- Option C's reachability check is **retained unchanged** and still passes (`verify:reachability`
  16/16, exit 0). B and C were never alternatives; C is the ride-along that catches what B cannot.
- **This ticket's ONE RECORDED BLIND SPOT is now observable.** Instance #2's mechanism — a ticket
  mis-classified as done by an incidental word in its header — still places the ticket exactly where
  it always did (nothing moves), but it can no longer happen unseen: `classifyLegacyStatus` returns
  `ambiguous: true` with a reason, and `board:check` prints an AMBIGUOUS STATUS warning naming the
  ticket. On the real board that is FEAT-020 ("SYNTHESIS DONE …") and FEAT-043 ("IN PROGRESS —
  Phase R DONE; …"). Once a ticket's `work_state` is a stored enum rather than a classified string,
  the mechanism is gone entirely.

**The measured defect this ticket predicted, found and fixed.** The prose format was parsed in five
places with THREE definitions of "done". `board.mjs` accepted `VERIFIED | (RE-)FIXED | RESOLVED |
DONE`; `src/server/tickets.ts` and `scripts/arch-watch.mjs` accepted only `VERIFIED | DONE`. So
**BUG-090, whose status is the single word `FIXED`, was Done to the board tool and Open to the
ticket API simultaneously** — 12 tickets in that state across the real corpus
(BUG-086/088/089/090/092/096/097/103/105/106, FEAT-073/078). This is precisely "tickets silently
disappear and nothing notices", instantiated a fourth time, and it was invisible because no two
parsers were ever compared.

**Which rule won, and why it is not arbitrary.** `board.mjs`'s, the broader one: it is the
deliberated rule (FEAT-068 broadened it on purpose and paired the broadening with the
no-independent-verification advisory), whereas `tickets.ts`'s was a copy that had missed that
broadening while its own comment still claimed to quote it "verbatim". It is also the rule the
visible board already reflects. The nuance the broad rule used to lose is not lost — it moves into
the orthogonal second field this ticket asked for: `FIXED` is `work_state: done` +
`verification_state: pending`; `VERIFIED` is `verified` + `holds`.

**A status that does not map is REJECTED, not defaulted.** `work_state: null`, a named
`UNMAPPABLE STATUS` error from `board:check`, and the ticket stays in Open where a human sees it.
Replacing one silent guess with another silent guess would have re-committed the original sin.
Measured: 0 of 183 real tickets are unmappable, so this costs nothing today and stops an 18th status
word being invented tomorrow.

**Evidence.** Must-FAIL first, against a clean worktree of the parent commit: the three-rule
comparison scores **1/4 checks, exit 1**, naming BUG-090; after the change, **4/4, exit 0**. No
ticket changed board placement — the done set is identical to the pre-fix rule's over all 183 real
tickets and `board:gen` produces a **byte-identical INDEX.md**. `verify:ticket-schema` **51/0**,
`verify:provenance` **17/0**, `verify:board-tool` **34/0**, `verify:reachability` **16/0**,
`verify:decision-shape` **25/25**, `verify:feat-082` **52/0**, `verify:onboard` **36/0**,
`verify:fleet-sync` **23/0**, all exit 0; `npm run gate` **PASS exit 0**, unpiped. Pre-existing and
byte-identical on the parent commit, NOT MINE: `verify:tickets` 29/30, `verify:arch-watch` 48/1,
`verify:needs-you-rail` 16/17, `verify:decisions` 17/18.

**Still owed on this ticket:** step 8's formal close (status header → superseded, INDEX move via
`board:gen`), and — per the plan's §9 — an independent clean-room verify pass on the parser
collapse, which is high-stakes and regression-prone by this ticket's own history.

- **Verified-by:** dispatch openai run 01a019a4-bda2-7101-935b-80e381544e05 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN — range `eae917a1..508f2de0` (synthetic base/head pinning `docs/` to the reviewed revision, so the diff is exactly the non-docs part of `15759b0`+`f524e1f`). Adversarial case `unmappable-status-through-watcher`: `board.mjs check` exits 1 with `UNMAPPABLE STATUS` on a ticket whose status is `MARINATING`, while `readTicketsForArch` (arch-watch) returns that same ticket as one ordinary **open** ticket with no error channel — the watcher silently guesses instead of reporting loudly, so the "report it loudly rather than guess" property does not hold on the watcher path.

### 2026-08-19 — worker (the clean-room BROKEN verdict, fixed across every consumer)

**The verdict was right, and it was the same defect one layer up.** The decision recorded in the
entry above — an uninterpretable state is REJECTED, never defaulted — was implemented on ONE path.
`parseTicket` returned `{ record, errors }`; `board.mjs` read `errors` and exited 1, and every other
consumer read `.record` and threw `errors` away. So `readTicketsForArch` handed back a ticket with
`done: false`, no classification field and no error channel at all, while `board:check` failed
loudly on the very same file. Two readers of one file, one loud and one silent: the exact class this
work exists to eliminate, reintroduced by the SHAPE of the parser's return value. The consumers
agreed on the real corpus only because the real corpus contains no unmappable ticket, so that
agreement proved nothing about this path.

**The fix is structural, not per-consumer.** A caller can forget a second return value; it cannot
forget a field of the record it is already copying. `record.statusError` (and `statusWarning`) now
carry the report ON the record, non-null for exactly the tickets `errors` names. Every consumer was
then given the channel its own contract allows:

- `board:check` — unchanged: a FAIL line and exit 1. It is the gate; it may die.
- ticket API (`tickets.ts`) — `statusMatched: false` + `statusError` on every summary, over the wire.
  An HTTP list must not 500 because one ticket is malformed (a half-written ticket has to stay
  listable), so the report rides on the record where a client can render it.
- `arch-watch` — the consumer with NO error channel. It may not throw (FEAT-019) and its exit code
  already means "recurrence found", so overloading it would make a malformed status look like a
  finding. It gets a reported entry the caller must handle (`result.unclassified`, also in `--json`)
  plus a stderr line that `--quiet` does not suppress, because a board defect is not report output.
  Its clusters are now THREE-way — an unclassified member is in neither the closed nor the open half,
  since counting it open silently weakens the very threshold the detector applies.
- `board.ts` (the rail) — reads INDEX.md, never a Status header, so it has no classification to make.
  What it must not do is disagree with the ticket file in silence; the index-vs-header case is
  covered and `board:check` names it.

**Neighbouring shapes the clean-room pass did not probe, now standing.** A state word that is a
prefix or a suffix of a real one (`OPENED`, `WIPED`, `CLOSEDOWN`, `NOT-A-BUGGY`, `DONELESS`,
`REOPENED`, `UNDONE`, `UNFIXED`, `UNVERIFIED`, and the corpus's real `VERIFIED2026-08-19`) — all
unmappable, all reported by all three. A status QUOTED IN THE BODY: header-field parsing is now
bounded to the header region (above the first `##`), because two real tickets (BUG-011, BUG-013)
already carry a second `- **Status:**` line in their activity log, and with the header line missing
the old whole-file search adopted the quoted one and answered "VERIFIED" about a ticket that
declares nothing. Measured: zero of 184 real tickets carry a header field below the first `##`, so
the bound moves no ticket. Header/INDEX disagreement: `board:gen` puts an unmappable ticket in Open
and a hand-edit into Done is a `board:check` FAIL. The copied module missing → both tools die
naming it; stale → the fleet sweep reports `would-update` (and is `identical` when in sync, so the
check is not always-on).

**Two silent wrong answers found while here, same class, same treatment.** `board.mjs check <dir>`
and `arch-watch.mjs <dir>` ignored a bare path and reported confidently on `docs/bugs` — an
unrecognised argument is now exit 2 with usage. And the `UNMAPPABLE STATUS` message listed regex
sources (`IN[\s-]*VERIFICATION`); it now lists the words a human types, since it reaches a UI.

**Evidence.** Must-FAIL first, on a pristine `git worktree` of HEAD: the new cross-consumer suite
scores **62 failures, exit 1**, including the verifier's own `MARINATING` fixture and every
neighbouring shape. After the fix: `verify:unmappable-status` **106 passed, 0 failed, exit 0** over
the REAL 184-ticket corpus (each case mutates one status line of a real ticket in a scratch copy;
the status strings are necessarily synthetic — the corpus has no unmappable ticket). Over the wire,
which the clean-room pass declined to run for the BUG-117 hazard: a scratch server booted with
`CLAUDE_STATION_DATA` (the real knob) on an ephemeral port, asserted to hold **0 projects and no
adopted session** before anything was sent, returns `HTTP 200`, 184 tickets, ARCH-004 with
`section: "open"`, `workState: null`, `statusMatched: false` and an `UNMAPPABLE STATUS`
`statusError`, and the other **183 clean**. Real corpus unchanged: the three consumers' done sets
identical, `board:gen` **byte-identical** to the output of HEAD's own `board.mjs` over the same
corpus. (The committed `INDEX.md` is already one row stale on HEAD — FEAT-091's curated blurb —
which HEAD's own generator reproduces; not this change.) Anti-regression, all exit 0:
`verify:ticket-schema` **51/0**, `verify:provenance` **17/0**, `verify:board-tool` **34/0**,
`verify:reachability` **16/0**, `verify:decision-shape` **25/25**, `verify:onboard` **36/0**,
`verify:fleet-sync` **23/0**, `verify:feat-082` **52/0**. `npm run gate` **PASS, exit 0**, unpiped.
Pre-existing and byte-identical to the pre-change run, NOT MINE: `verify:tickets` 29/30,
`verify:arch-watch` 48/1, `verify:needs-you-rail` 16/17, `verify:decisions` 17/18.

`regressed-from: 15759b0` — the one-definition-of-done commit implemented the reject-loudly decision
on the board path only. HIGH-STAKES: this touches the same regression-prone parser and answers a
clean-room BROKEN verdict, so a fresh independent clean-room pass is warranted before this ticket
is called VERIFIED — generation must not be its own only verifier, which is what the last round
proved by finding this.

### 2026-08-19 — independent clean-room verification of `b88ad5e`: BROKEN

- **Verified-by:** dispatch openai run 01a019c1-70fd-7100-a0b1-a5c8874c6c2f (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

Cross-provider (openai/codex) clean room over a synthetic base that excludes `docs/*` from the
diff, with an unmodified copy of the 187-file ticket corpus shipped into the room (this ticket and
its INDEX row withheld, so the verifier never saw the builder's own decision record). The builder's
suite RE-RAN in the room: `npm run verify:unmappable-status` → **106 passed, 0 failed, exit 0**
(recorder run `48fc83d77cc4`).

**The uncovered case: two contradictory header `Status:` lines.** Run `e149c574d37f`, exit 1
(`node verify-adversarial-duplicate-status.mjs` over the real corpus, victim ticket ARCH-005 given
header states `OPEN` then `VERIFIED`): every consumer answers confidently — `boardDone: false`,
`archDone: false`, `apiSection: "open"` — while **every** error channel is empty
(`parser: null`, `boardRecord: null`, `boardErrors: []`, `arch: null`, `api: null`) and
`board.mjs check` exits **0** without naming the contradiction. The first status line silently
wins; a state that cannot be interpreted uniquely is reported by nobody. Same class as the defect
this commit answered, one shape further out: not an unmappable WORD, but an ambiguous NUMBER of
state lines.

Verifier's own could-not-test list: it did not boot the live HTTP server or browser UI (it
exercised `listTickets` as a library entry point instead), and it did not independently reconstruct
the parent generator to re-check corpus placement, because the duplicate-state failure already
disproved the claim — so requirement (3) is UNVERIFIED by this round, not confirmed.

### 2026-08-19 — a state can fail to be one value in SIX ways, not one; all six now go through one channel

Answers the clean-room BROKEN verdict on `b88ad5e` directly above. regressed-from: 15759b0, b88ad5e
— each round fixed the shape it was shown and left the neighbouring shape intact, which is why this
round enumerates the class instead of the case.

**THE DEFECT.** `parseTicket` read the header status with a single `RegExp.exec`. Given two
declarations — `- **Status:** OPEN` then `- **Status:** VERIFIED` — the first silently won, and all
four consumers answered `open` with `statusError: null`, `board:check` exit 0. They AGREED, so the
"all consumers agree" property held; the property that matters, "a state that cannot be interpreted
is reported", failed. b88ad5e had made an UNRECOGNISED state loud everywhere. An AMBIGUOUS state is
not an unrecognised one, and only the latter was handled.

**THE FIX IS THE CLASS.** One function, `classifyStatusField(file, text)`, now produces the
classification AND its report together from EVERY header declaration. The ways a state can fail to
be one unambiguous value, enumerated, each on the channel that already carried the unrecognised
case (`statusError` = may not be answered about; `statusWarning`/`statusWarnings` = answerable but
untidy):

| shape | report | channel |
|---|---|---|
| absent | `MISSING STATUS FIELD` | error |
| present but empty | `EMPTY STATUS FIELD` (new — "no recognised state word, the status begins ''" was a riddle) | error |
| unrecognised word | `UNMAPPABLE STATUS` | error |
| duplicated, contradicting | `DUPLICATE STATUS FIELD … DISAGREE: "OPEN" ⇒ open vs "VERIFIED" ⇒ verified` | error |
| duplicated, agreeing | `DUPLICATE STATUS FIELD … They agree, but the file is half-edited` | warning |
| declared below the header | `STATUS OUTSIDE HEADER` (rides with the MISSING error: it says why) | warning |
| near-miss label (`- **Status**: X`) | `MALFORMED STATUS LINE` | warning |
| incidental `DONE` token | `AMBIGUOUS STATUS` (pre-existing) | warning |

**UNREPRESENTABLE vs MERELY REPORTED.** In a prose ticket nothing can be made unrepresentable — the
file is free text and a parser can only report on it. What is now unrepresentable is a state in the
PROGRAM: there is no way to obtain a record with `statusError === null` whose state is not exactly
one interpretable declaration, because the classification and the report come out of one function
over the full list of declarations. A consumer cannot re-derive the state from its own regex and
skip the report — which is exactly how this survived. Remaining hole, named rather than claimed: in
the JSON block format `JSON.parse` silently keeps the LAST of two duplicate keys; no corpus ticket
uses that format and detecting it wants a scanning parser.

**AGREEING DUPLICATES ARE A WARNING, DELIBERATELY.** The error channel means "no consumer may answer
done-or-open about this ticket without saying so". When two declarations agree, every consumer's
answer is right and identical whichever line wins, so the property that forces an error is not
violated, and erroring would exit `board:check` 1 — blocking a lane — over a file whose state is not
in doubt. That is the over-strictness this project has been bitten by from the other side. But it is
a half-edited file, and one update to either line converts it into the contradiction case, so it is
not silent: a `WARN` line on `board:check`, a `statusWarning` on the record and over the wire.

**VERIFICATION.** Must-FAIL first: the clean room's own probe, unmodified except for its scratch
root, exits 1 on the parent with every channel `null`; after, exit 0 with all six surfaces naming
`DUPLICATE STATUS FIELD`. The extended suite, run against a PRISTINE HEAD worktree, scores
**152 passed, 34 failed, exit 1**; on this change **186 passed, 0 failed, exit 0**
(`npm run verify:unmappable-status`), each case mutating a real ticket inside a scratch copy of the
live 184-ticket board.

**REQUIREMENT (3), RE-ESTABLISHED** (the clean room stopped at the defect and left it UNVERIFIED):
over the whole corpus, HEAD's own parser and this one give the same done-ness for all **184**
tickets (0 differ); every ticket lands in the same INDEX table as HEAD placed it (0 moved); and
`board:gen` emits a **byte-identical** INDEX.md to the one HEAD's committed generator emits over the
same corpus. The committed INDEX.md remains one row stale on HEAD (FEAT-091's blurb) — HEAD's own
generator reproduces that, so it is not this change.

Anti-regression, all exit 0: verify:ticket-schema 51/0, verify:provenance 17/0, verify:board-tool
34/0, verify:reachability 16/0, verify:decision-shape 25/25, verify:onboard 36/0, verify:fleet-sync
23/0, verify:feat-082 52/0. `npm run gate` PASS exit 0, unpiped. Pre-existing and unmoved, NOT MINE:
verify:tickets 29/30, verify:arch-watch 48/1, verify:needs-you-rail 16/17, verify:decisions 17/18.

**STILL OPEN — the report reaches the client and NOBODY RENDERS IT.** Deferred twice, now measured:
`statusError` is transported on every `TicketSummary` and is read nowhere in `public/app.js`. The
ticket card (`c-status`) and the detail pane (`d-status`) render `t.boardStatus || t.status` — the
prose blurb — so a ticket with a contradictory, empty or unmappable state renders as an ordinary
open row with its raw text, silent one layer out. `statusWarning` is now transported too and is
equally unrendered. This needs a CLIENT change (a defect badge on the card + the message in the
detail pane); `public/` belongs to other work right now, so it is reported, not done.

HIGH-STAKES: same regression-prone parser, third round on the same rule, answering a BROKEN verdict.
An independent clean-room pass is warranted before this ticket is called VERIFIED.

### 2026-08-19 — independent clean-room verification of `98672cd`: BROKEN

- **Verified-by:** dispatch openai run 01a019d8-d91f-7c13-bbaf-29c4497d9455 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN — range `bc761237b6df..a449484ee44b` (synthetic base/head built with git plumbing: `docs/` pinned to the reviewed revision on BOTH endpoints, plus an identical shipped corpus, so the diff is exactly the four non-docs files of `98672cd`, 29463 bytes). Adversarial case `indented-contradictory-declaration` (run `ce41b949fae3`, exit 1): on real ticket ARCH-005 given a second, INDENTED `- **Status:** VERIFIED` line under its real `OPEN` one, `board.readTickets`, `readTicketsForArch` and `listTickets` all answer `done:false` / `section:"open"` with `statusMatched:true` and `statusError:null`, and `board.mjs check` exits **0**. The contradiction is classified `MALFORMED STATUS LINE` — a WARNING — and only the ticket API carries it; the board and arch-watch records expose no warning at all. A declaration that CHANGES the answer is being treated as mere untidiness, so requirement (2) fails at the requirement (3) classification boundary.

Cross-provider (openai/codex) clean room at `<scratch>/orchard-verify/cleanroom-verify-RzFW1u`
(reflink applied — same btrfs device as the repo). The builder's suite RE-RAN in the room:
`npm run verify:unmappable-status` → **186 passed, 0 failed, exit 0** (recorder run `2e89ba834339`)
over the shipped 183-ticket corpus (this ticket and its INDEX row withheld, so the verifier never
saw the builder's own decision record; the builder's report, table of shapes and self-assessment
were not passed).

Verifier's own could-not-test list: it did not boot the HTTP server or exercise the rendered UI
(it used `listTickets` as a library entry point, and isolating a scratch server was out of scope for
the round); and it did not exhaust the Markdown-nesting / Unicode-whitespace variant space once the
indented shape already broke the classification boundary. So requirement (4) — no ticket moved over
the whole corpus — is again **UNVERIFIED independently** by this round, and requirement (5) was
covered only by the builder's own re-run suite.

### 2026-08-19 — round 4: the boundary is drawn over CONTENT, not punctuation

Answers the independent cross-provider clean-room BROKEN verdict on `98672cd` (entry above).
regressed-from: 98672cd — that round enumerated the ways a state can fail to be one value and
then classified them by the SHAPE of the line. This one classifies them by whether the line
changes the answer.

THE DEFECT, REPRODUCED FIRST. The clean room's own probe, run unmodified but for its scratch
root, exits 1 on the parent: a real OPEN ticket given a second, INDENTED `- **Status:** VERIFIED`
comes back `done:false, statusMatched:true, statusError:null` from `board.readTickets`,
`readTicketsForArch` and `listTickets`, with `board.mjs check` exit 0 — and the only report
anywhere is a discardable `MALFORMED STATUS LINE` warning on the ticket API alone.

THE RULE, RE-DERIVED. The error channel means "no consumer may answer done-or-open without
saying so"; the warning channel means "untidy, but the answer is not in doubt". `98672cd` put
every non-canonical line on the warning side because it is not the canonical line — reasoning
from punctuation. Whether a line is a defect depends on what it SAYS:

  a header line that looks like a state declaration and DISAGREES with the state actually
  used is an ERROR; one that AGREES, or that carries NO STATE at all, is a WARNING.

"Disagrees" is decided by the same machine-state `key()` the duplicate rule already used, so
`VERIFIED` and `VERIFIED/DONE` agree and `OPEN` and `VERIFIED` do not. Every return from
`classifyStatusField` now goes through one `settle()`, so the rule cannot be applied on some
branches and forgotten on others.

WHICH SHAPES CHANGE SEVERITY, AND WHY:

  → ERROR (were warnings, or were invisible): an indented, blockquoted, `*`/`+`/numbered-list,
    unbolded (`- Status: X`), near-miss-punctuation (`- **Status**: X`), marker-less
    (`**Status:** X`, `Status: X`), code-block or Unicode-space-indented declaration that
    contradicts the header's state. Blockquoted and marker-less shapes were not recognised at
    all before, so they were silent, not merely quiet.
  → still WARNING, deliberately: the same shapes when they AGREE with the state used (every
    reading gives one answer, and erroring would exit `board:check` 1 over a file whose state
    is not in doubt), and when they declare NOTHING (`- Status:` with no value — there is no
    state to disagree with). Also unchanged: duplicated-but-agreeing canonical lines, and the
    incidental-`DONE` ambiguity.
  → still WARNING, on a ticket already carrying an error: a look-alike on a MISSING / EMPTY /
    UNMAPPABLE / contradicting-duplicates ticket rides as an advisory. No consumer is answering
    confidently there in the first place, so a second error would only re-say the first. The
    common real typo — the ONLY status line got indented — lands here: MISSING STATUS FIELD
    (loud) plus the look-alike warning that says where the state went.
  → deliberately OUTSIDE the rule: a status line BELOW the first `## `. `headerRegion` exists
    because prose quotes headers — BUG-011 and BUG-013 really carry `- **Status:**` lines in
    their activity logs. Below the header such a line is a quotation and cannot contradict a
    declaration; the one case where it is evidence (header declares nothing, body declares
    something) was already reported as STATUS OUTSIDE HEADER riding with the MISSING error.
  → NOT excepted, on purpose: fenced and indented CODE BLOCKS in the header. An example status
    line above the first `## ` is indistinguishable from the real thing to every reader that is
    not a Markdown renderer; the repair is to move it below the first section.

THE SECOND DEFECT IN THE SAME FINDING. Only the ticket API carried `statusWarning`; the board
tool's and the watcher's records had no warning field at all, so a correctly-classified warning
reached nobody there. `98672cd`'s own principle — a report must reach every consumer through a
channel its callers can see — had been applied to errors and not to warnings. Both records now
carry `statusWarning`/`statusWarnings`, and `archWatch()` grew `result.statusWarnings` (in
`--json`) plus an `arch-watch WARN — …` stderr line that `--quiet` does not suppress and that
does not move its exit code.

NAMED, NOT CLAIMED. A ZERO-WIDTH space before a declaration is not whitespace to `\s` and still
slips past. It is also invisible in every editor, so recognising it would mean objecting to a
line a human cannot see; left as a known hole. The `JSON.parse`-keeps-the-last-duplicate-key
hole in the block format from `98672cd` is unchanged.

REQUIREMENT (3), ESTABLISHED INDEPENDENTLY AT LAST — two verifiers running stopped at their
first defect and left it asserted-by-builders-only. Audited from a script written OUTSIDE the
repository, importing nothing from this change's own suite, over two scratch trees fed the
IDENTICAL real corpus (HEAD's code from `git archive`, the working tree's code copied): 185/185
tickets identical done-ness (0 differ), 185/185 in the same INDEX table (0 moved), and the
regenerated INDEX BYTE-IDENTICAL between HEAD's generator and this one. The committed INDEX is
one row stale on HEAD, which HEAD's own generator reproduces — so the comparison is
generator-to-generator, not against the committed file. Board warnings unchanged at 2 (the two
long-standing AMBIGUOUS STATUS advisories). `board:gen` was never run against the real tree.

VERIFICATION. Clean-room probe: exit 1 before, exit 0 after, all six surfaces naming
CONTRADICTORY STATUS LINE. The extended suite is shapes × {contradicts, agrees, declares
nothing} over sixteen look-alike shapes, each mutating a real ticket inside a scratch copy of
the live 185-ticket board: on the parent's code (HEAD from `git archive`, this suite dropped in)
**205 passed, 101 failed, exit 1**; on this change **306 passed, 0 failed, exit 0**. Independent
placement audit **8 passed, 0 failed, exit 0**.

Anti-regression, all exit 0: verify:ticket-schema 51/0, verify:provenance 17/0, verify:board-tool
34/0, verify:reachability 16/0, verify:decision-shape 25/25, verify:onboard 36/0, verify:fleet-sync
23/0, verify:feat-082 52/0. `npm run gate` PASS exit 0, read unpiped. Pre-existing and unmoved,
NOT MINE: verify:tickets 29/30, verify:arch-watch 48/1, verify:needs-you-rail 16/17,
verify:decisions 17/18 (the last is a 30s session-closed harness timeout).

ALSO IN THIS COMMIT — two private-path leaks cleared, both in evidence pasted from real runs:
line 377 of this ticket (the clean-room path → `<scratch>/…`, the board's placeholder
convention) and `scripts/verify-arch-004-broken-state-visible.mjs`, which hard-coded a home path
as its scratch default and now calls the project's own `scratchRoot()`. The leak gate over the
whole of `docs/bugs/` is clean of text hits.

HIGH-STAKES: fourth round on the same regression-prone parser, answering a BROKEN verdict, and it
CHANGES A CLASSIFICATION BOUNDARY rather than adding a case. An independent clean-room pass is
warranted before this ticket is called VERIFIED — specifically one that attacks the agreeing/empty
side (a shape wrongly promoted to an error would move a real ticket) rather than only the
contradicting side.

- **Verified-by:** dispatch openai run 01a019f8-d059-74c3-9f60-a31a1cfcf9e6 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN — range `dd4c887c851b..0f5aae8a1ae7` (synthetic base/head built with git plumbing: `docs/` pinned to the reviewed revision on BOTH endpoints plus an identical shipped corpus, so the diff is exactly the five non-docs files of `1654cc5`, 34442 bytes). Corpus: a frozen `git archive 1654cc5 docs/bugs` copy (184 tickets) shipped into the room with THIS ticket and its INDEX row withheld; the room was `git init`+committed by the bootstrap so `git show HEAD:` / `git archive HEAD` have a baseline. Fixer test `node run-tests.mjs` re-run (run `1cc4045b1f38`, exit 0, 306 passed / 0 failed). Adversarial case `markdown-task-list-conflict` (run `2ca5598b927d`, exit 1): a Markdown TASK-LIST declaration — `- [x] **Status:** VERIFIED` — placed in the header region under real ticket ARCH-005's genuine `OPEN` line is not recognised as a declaration at all. `S.parseTicket`, `board.readTickets` and `readTicketsForArch` each answer `work_state: "open"` with `statusMatched: true`, `statusError: null` AND `statusWarning: null`, and `board.mjs check` exits **0** without naming the ticket. This is UNDER-classification at the new boundary: the round-4 rule judges a look-alike by whether it disagrees, but `- [ ]`/`- [x]` is not in the set of markers the header scan recognises, so a contradicting declaration a human plainly reads as one is silent on every channel. Not tested: the HTTP transport (the API's shared parser path was exercised in-process instead, to avoid an unisolated server), and the space of Markdown extensions / Unicode control characters was not exhausted.

### 2026-08-19 — round 5: the marker set was the bug, so there is no marker set any more

The clean-room verdict above is a straight hit, and the diagnosis in it is exact: round 4 judges
a look-alike by whether it DISAGREES, but `- [x] **Status:** VERIFIED` never reached that
judgement, because `- [x]` was not in the list of markers the header scan recognised. Under a
real OPEN ticket's genuine status line, every consumer answered `open` with `statusMatched: true`,
`statusError: null`, `statusWarning: null` and `board:check` exit 0.

WHAT WAS ACTUALLY WRONG, AND WHY ADDING `[x]` WOULD HAVE BEEN THE SAME BUG AGAIN. Round 4's
recogniser ENUMERATED the leading noise it accepted — indentation, `>`, then at most ONE marker
from `- * + 1. 2)`. A hand-written set is short by exactly whatever nobody typed, and this one was
short by more than the checkbox: `- > **Status:**` (a quote nested in a list), `- - Status:` (two
markers), `__Status__:` and `` `Status`: `` (non-asterisk emphasis) and `| **Status:** X` (a table
cell) were all invisible to it too, and nobody had typed those either. So the marker list is gone.
The question is now asked structurally: *once every leading character Markdown renders as
decoration rather than as text is removed, does what is left begin `status:`?* Decoration comes
from a UNICODE PROPERTY, not a literal list — a character that is neither a letter (`\p{L}`) nor a
digit (`\p{N}`) cannot be part of the word `status`, so at the start of a line it is structure. A
`+` over that class is a fixpoint, so arbitrary nesting, ordering and repetition of decoration is
handled without enumerating combinations.

NEWLY RECOGNISED, none of which needed a new entry anywhere: GFM task-list checkboxes `[x]`,
`[ ]` and renderer-specific fills `[-]`, `[/]`; blockquote-inside-list and any other marker ORDER;
repeated markers; ATX heading markers `#`; underscore/tilde/backtick emphasis on the label; table
pipes; and the whole invisible-format class `\p{Cf}` — ZERO WIDTH SPACE, the BOM, SOFT HYPHEN, the
bidi controls. That last one CLOSES THE HOLE the previous round named and declined to cover, and
closes it for every codepoint in the category at once rather than one at a time. A future Markdown
extension whose marker is punctuation — which is what a Markdown marker is — is handled on the day
it is invented with no edit here, which is why the verifier's "did not exhaust Markdown extensions
or Unicode control characters" is answered by the derivation instead of by more probing.

THE RESIDUE, NAMED AND CLOSED. Exactly two decoration tokens contain a letter or a digit and so
cannot come from the property: the ordered-list marker `\d{1,9}[.)]` and the task-list checkbox
`\[[^\]\n]?\]`. Both are closed rather than open — CommonMark defines exactly one ordered-marker
form, and the checkbox is one bracket pair around AT MOST ONE character, written that way (rather
than `[x]|[ ]`) so renderer-specific fills are covered without knowing the renderer. A third entry
would need a Markdown flavour to put a letter or digit inside a marker, which none does. One
deliberate SUBTRACTION from the derived class, also named: `[` and `]` are link syntax, which
carries text, so a bracket counts as decoration only inside the checkbox token —
`- [Status: verified](url) is the badge` is a sentence about a badge, not a declaration.

WHAT DID NOT CHANGE, ON PURPOSE. The severity rule is untouched: a recognised look-alike that
CONTRADICTS the state actually used is an ERROR, one that AGREES or declares NOTHING is a WARNING,
and the shape is still never what decides it. The verifier hunted the over-classification side —
the half this change is most at risk on — and found nothing wrongly escalated and no ticket moved;
that half is preserved and now pinned from both sides by seven "NOT a look-alike" cases (labelled
annotations, `- **Build Status:**`, the word in a sentence, a thematic break, a bare task item, a
link) with a non-vacuity probe beside them. The label stays narrow, so FEAT-015's real
`- **Status (history):**` line is still left alone. Measured over all 186 frozen real tickets:
0 look-alike hits, 0 status errors, 2 warnings (the two long-standing AMBIGUOUS STATUS
advisories) — unchanged.

VERIFICATION. Clean-room probe (`adversarial-task-list-status.mjs`, run against a frozen corpus
because a live lane writes `docs/bugs/`): **exit 1 before, exit 0 after**, all three parser
surfaces plus `board:check` (exit 0 → 1, ticket named) carrying CONTRADICTORY STATUS LINE. The
extended matrix is now 28 look-alike shapes × {contradicts, agrees, declares nothing}, each
mutating a real ticket inside a scratch copy of the live board: on the PARENT's code (`git archive
HEAD` into scratch, this suite dropped in) **331 passed, 67 failed, exit 1**; on this change
**398 passed, 0 failed, exit 0**.

REQUIREMENT (4), INDEPENDENTLY AUDITED — the last round's placement audit was written by its own
builder and the verifier declined to re-audit it. This one is written outside the repository,
imports nothing from the suite under test, drives both trees only as subprocesses over one frozen
corpus, and re-reads the INDEX with its OWN table parser so a shared reader bug cannot hide:
**6 passed, 0 failed, exit 0** — regenerated INDEX byte-identical to the parent generator's,
186 tickets with identical done-ness (161 done), 0 moved between tables, plus a non-vacuity probe
confirming the audit DOES see a move when one is forced. `board:gen` was never run against the
real tree; this entry does not change the ticket's state, so no INDEX row moves.

Anti-regression, all exit 0: verify:ticket-schema 51/0, verify:provenance 17/0, verify:board-tool
34/0, verify:reachability 16/0, verify:decision-shape 25/25, verify:onboard 36/0, verify:fleet-sync
23/0, verify:feat-082 52/0, typecheck 0. `npm run gate` PASS exit 0, read unpiped. Pre-existing and
unmoved, NOT MINE: verify:tickets 29/30, verify:arch-watch 48/1, verify:needs-you-rail 16/17,
verify:decisions 17/18 — same four checks failing by name, before and after.

HIGH-STAKES: fifth round on the same regression-prone parser, and it WIDENS a recogniser that
decides which table a ticket lands in. An independent clean-room pass is warranted before this is
called VERIFIED — and the attack to reframe is the one this round makes newly possible: the
widening is on the over-classification side now, so the question is whether any ORDINARY header
line of a real ticket can be read as a declaration by the derived rule.

- **Verified-by:** dispatch openai run 01a01a13-3561-7b80-80a7-e9f5504aca7c (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN — range `a9a72090d790..84f30f68da39` (synthetic base/head built with git plumbing: `docs/` pinned to the reviewed revision on BOTH endpoints, so the diff is exactly the two non-docs files of `5a573b2`, 12742 bytes). Corpus: a frozen `git archive 5a573b2 docs/bugs` copy (185 tickets) shipped into the room at `_corpus/bugs` with THIS ticket and its INDEX row withheld; the room was `git init`+committed by the bootstrap (`room-run.mjs`) so `git show HEAD:` / `git archive HEAD` have a baseline. Fixer test `node ./room-run.mjs` re-run (run `e79df2afbe14`, exit 0, 398 passed / 0 failed). Adversarial case `inline-quoted-status-example` (run `ced8cbc706f8`, exit 1): a real OPEN ticket (BUG-048) given the ordinary header line `- "Status: VERIFIED" is an example of the required syntax.` — a QUOTED EXAMPLE, which no human reads as a declaration — is read as a second state declaration by the derived decoration rule (the leading `"` is stripped as decoration). `board.readTickets`, `readTicketsForArch` and `listTickets` all report `CONTRADICTORY STATUS LINE`, `statusMatched: false`, `workState: null`, and `board.mjs check` exits **1**. This is OVER-recognition at the newly widened boundary: the STRONGER severity is applied to a merely-quoted example, so a real ticket becomes unactionable — the failure direction requirement (3) names as equally defective. Not tested: the HTTP transport and browser UI (the API's shared parser path was exercised in-process); and the verifier flagged that this room's one-commit history makes the suite's `git show HEAD:` before/after board-generation, done-ness and INDEX-placement controls SELF-COMPARISONS rather than baselines. Requirement (5) was NOT independently re-audited by this pass.

### 2026-08-19 — round 6: a quotation mark is not block structure

`regressed-from: ARCH-004 round 5` (commit `5a573b2`).

THE DEFECT, named by the cross-provider clean room. Round 5 derived decoration as "any character
that is neither a letter nor a digit", reasoning that such a character cannot be part of the word
`status`. True, and the wrong axis. Under a real OPEN ticket's genuine status line the clean room
wrote:

```
- "Status: VERIFIED" is an example of the required syntax.
```

The leading `"` is not a letter or a digit, so it was stripped, and a sentence ABOUT the syntax was
read as a second declaration: BUG-048 went `statusMatched:false, workState:null` with
CONTRADICTORY STATUS LINE on all three consumers and `board:check` exit 1. Over-recognition is the
expensive direction — a MISSED declaration puts one ticket on the wrong side of the board; a
PROMOTED sentence makes a correct ticket unactionable and takes the whole consistency gate down
with it.

THE AXIS, RE-DERIVED. The conflation is between two kinds of non-alphanumeric character. A list
marker, a blockquote arrow, a heading hash, a table pipe are BLOCK-LEVEL: they say what KIND OF
THING the line is, and the line's content is what follows them. A quotation mark, a parenthesis, a
backtick are INLINE: they are part of the content, and what they do to it is QUOTE it. Only the
first kind changes what a line *is*, so only the first kind is stripped. The alphabet is no longer
an open-ended Unicode property but CommonMark's closed list of block starters — indentation (any
Unicode blank, plus every invisible format character `\p{Cf}`), `- * +` / `\d{1,9}[.)]` / `[x]` /
`#{1,6}` each FOLLOWED BY A BLANK (CommonMark's own condition, and load-bearing: it is why
`- *Status: X*` has one marker and not two), and `>` / `|`. The `+` over that alternation is still
a fixpoint, so arbitrary nesting, order and repetition is still handled without enumerating
combinations. **What changed is the alphabet, not the shape of the rule** — everything round 5 got
right (task-list checkboxes, marker order, repeated markers, invisible format characters) is
standing, asserted line by line.

Emphasis and code spans moved OUT of decoration and INTO the label pattern, where they can be
required to CLOSE — and that one move is the whole boundary:

| shape | now |
| --- | --- |
| `` - `Status`: VERIFIED `` — delimiter closes at the LABEL | a declaration (typography on a real one) |
| `` - `Status: VERIFIED` is an example `` — closes after the VALUE | prose, invisible |
| `- *Status: X* is an example`, `- __Status: X__`, `- ~~Status: X~~` | prose, invisible |
| `- (Status: VERIFIED) — for example` | prose, invisible |
| `- "…"`, `'…'`, `“…”`, `‘…’`, `«…»`, `„…“` | prose, invisible — quotes are not Markdown block syntax at all |
| `` - `Status**: X `` (opener and closer differ) | prose — a backreference requires the SAME run |
| `> - 1. [x] **Status:** X`, `| **Status:** X`, `​- **Status:** X`, `###### **Status:** X` | still a declaration, still the round-5 severity |

FAILURE CLASSES, BOTH DIRECTIONS. *Unrepresentable now:* a line whose leading run is inline
punctuation can no longer reach the label at all, so no quotation, parenthetical or link text can
be promoted by decoration-stripping — there is no class left to over-subtract from. An inline
delimiter that does not close at the label cannot match, so a quoted example cannot be promoted by
emphasis either, whatever delimiter it uses. *Guarded, not unrepresentable:* a genuinely-decorated
declaration written with a marker CommonMark does not define (`•`, `→`) is missed — the cheap
direction, and it is now a closed spec list, so it moves with the spec; and a status line inside a
fenced code block in the HEADER is still read as a declaration, unchanged and still named above, on
the same reasoning (the repair is one line; the alternative is rendering Markdown to answer "is
this ticket done").

VERIFICATION. MUST-FAIL FIRST: the verifier's own probe, preserved at
the clean room's `adversarial-inline-example.mjs` (kept in the out-of-repo verify scratch, room
`cleanroom-verify-j6pn34`), run
unmodified against `git archive HEAD` in scratch — **exit 1**, BUG-048 `matched:false, state:null`,
CONTRADICTORY STATUS LINE on board / arch / api, `boardCheckExit: 1`. Against this change:
**exit 0**, all three `matched:true, state:"open", error:null, warning:null`, `boardCheckExit: 0`.
The four quoted-example shapes are also graded end-to-end on the real victim inside the suite
(every consumer silent — no error AND no warning — and `board:check` exit 0), the five
closes-at-the-label / closes-after-the-value PAIRS are asserted together so the rule cannot be
keying on the delimiter, 25 block-decorated declarations are asserted still recognised with their
value intact, and 16 new prose shapes join the negative list. `verify:unmappable-status`:
**464 passed, 0 failed, exit 0** (was 434 on the parent's suite).

REAL-CORPUS SWEEP, frozen copy of the live board (186 tickets, taken before the run because a live
lane writes `docs/bugs/`): **zero look-alike hits** on both the parent's recogniser and this one,
zero status errors, and the two known pre-existing `AMBIGUOUS STATUS` warnings (FEAT-020,
FEAT-043) unchanged — same two files, same class, before and after.

REQUIREMENT (5), GENUINELY AUDITED AT LAST — three rounds unattacked, two builder self-audits, and
a verifier that explicitly refused to count a one-commit room's `git show HEAD:` comparisons as
controls. `audit-placement.mjs` (out-of-repo scratch, `arch004-r6`) is written outside the repository,
imports nothing from the suite under test, and is a TWO-COMMIT comparison: room A is the PARENT
commit (`git archive 3198ec2`), room B is that parent plus this change and nothing else. Each room
gets its own private copy of the same frozen corpus; each is asked only through its OWN shipped
`board.mjs`, out-of-process; the regenerated INDEX is re-read with the audit's own table parser.
**AUDIT PASS, exit 0 — 186 tickets, 185 board rows, 0 diffs in done-ness / machine state / error
channel / warning count / TABLE PLACEMENT, and a byte-identical regenerated INDEX.md
(sha256 `9da13415d4882457…`, 29961 bytes both sides).** NON-VACUITY: the same comparator run over a
corpus with one open ticket's status flipped reports exactly the move — `ARCH-004` `workState`
open→verified, `done` false→true, table `Open`→`Done (committed)`, INDEX no longer identical. An
audit that cannot see a forced move proves nothing when it sees none. `board:gen` was never run
against the real tree.

Anti-regression, all exit 0: verify:unmappable-status 464/0, verify:ticket-schema 51/0,
verify:provenance 17/0, verify:board-tool 34/0, verify:reachability 16/0, verify:decision-shape
25/25, verify:onboard 36/0, verify:fleet-sync 23/0, verify:feat-082 52/0. `npm run gate` PASS
exit 0 (leak-gate, check-nul, typecheck), read unpiped. Pre-existing and unmoved, NOT MINE:
verify:tickets 29/30, verify:arch-watch 48/1, verify:needs-you-rail 16/17, verify:decisions 17/18 —
identical counts to the stated parent baseline.

HIGH-STAKES: sixth round on the same regression-prone parser, and this one NARROWS a recogniser
that decides which table a ticket lands in — so the attack to reframe has flipped back. The
question for an independent pass is no longer "can prose be promoted" but **"is there a header line
a human plainly reads as a state declaration that this rule now misses?"** — the cheap direction,
but the one this change newly exposes. Named starting points, chosen because they are where I
stopped rather than where I am confident: a bullet marker not followed by a blank
(`-**Status:** X`); a marker some renderer accepts that CommonMark does not; a label wrapped in
delimiters that close asymmetrically; and the fenced-code-block-in-the-header case, which is
unchanged and deliberate. Not tested: the HTTP transport and the browser UI (the API's shared
parser path was exercised in-process only).

- **Verified-by:** dispatch openai run 01a01a30-e639-7300-9c29-78aa480976ac (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN — range `1ad63b5c943a..1224068fcfee` (synthetic base/head built with git plumbing: `docs/` pinned to the reviewed revision on BOTH endpoints plus an identical shipped corpus, so the diff is exactly the three non-docs files of `132f65e`, 25745 bytes). Corpus: a frozen `git archive 132f65e docs/bugs` copy (189 files) shipped into the room at `_corpus/bugs` with THIS ticket and its INDEX row withheld; the room was `git init`+committed by the bootstrap (`room-run.mjs`) so `git show HEAD:` / `git archive HEAD` have a baseline. Fixer test `node ./room-run.mjs` re-run (run `3a13703802a9`, exit 0, 464 passed / 0 failed). Adversarial case `four-backtick-code-span-label` (run `e5f1d29c0135`, exit 1): on real ticket ARCH-005, under its genuine `OPEN` line, the header line `` - ````Status````: VERIFIED — contradictory `` — a valid CommonMark code span using a FOUR-backtick delimiter run, which any renderer accepts and any human reads as a state declaration — is not recognised as a declaration at all. `S.parseTicket`, `board.readTickets`, `readTicketsForArch` and `listTickets` all answer `matched:true, state:"open", error:null`, `statusLookalikes` returns `[]`, and `board.mjs check` exits **0**. This is a MISSED declaration at exactly the boundary this round narrowed: the label pattern admits a delimiter run of one to three backticks, so a longer-but-legal run silently falls out of the grammar and a contradicting declaration is invisible on every channel — requirement (4) under-recognition, with requirement (2) failing behind it. Not tested: an independent parent-generator corpus placement audit for requirement (5) was NOT completed (the suite's own before/after, done-set, table-placement and byte-identical-INDEX checks use HEAD as both sides in this one-commit room and were correctly refused as controls); and requirement (6)'s scaffold behaviour was exercised only through the author's suite, not an independent probe.

### Round 7 — the delimiter run has no length, and neither does the value's (2026-08-19)

**Status: FIXED (round 7).** `scripts/lib/ticket-schema.mjs`, `scripts/verify-unmappable-status.mjs`.
`regressed-from: ARCH-004 round 6` — round 6 introduced the capped run this fixes.

THE DEFECT, as the third cross-provider clean room found it. Under real ticket ARCH-005's genuine
`OPEN` line, `` - ````Status````: VERIFIED — contradictory `` — a valid CommonMark code span with a
FOUR-backtick delimiter run. All four consumers answered `{matched:true, state:"open", error:null}`,
`statusLookalikes` returned `[]`, `board:check` exit 0. Every renderer shows it as a declaration and
every human reads it as one; the label pattern admitted a run of one to **three**, so it fell out of
the grammar entirely and a contradicting declaration was silent on every channel.

THE PATTERN, NAMED, BECAUSE IT IS NOW THREE DEEP ON THIS TICKET. Round 4 enumerated a list of
Markdown markers; round 5 enumerated signals in an unrelated file; round 6 wrote `{1,3}`. Each time
the bound was short by whatever nobody had typed yet. **The cap is not raised — it is removed.**
CommonMark defines a code-span opener as "a string of ONE OR MORE backtick characters" closed by "a
backtick string of EQUAL LENGTH", and an emphasis delimiter run as one or more, both unbounded. So
the opener is `+` and the closer is a BACKREFERENCE: equal-length closing is enforced at whatever
length the author chose, and the pattern knows no length at all. `` ````Status````: `` is a
declaration; `` ````Status``: `` is not; both hold at 4, at 40 and at 101.

The run is also HOMOGENEOUS — `\*+`, `_+`, `~+`, `` `+ `` as separate alternatives, not one mixed
character class. That is the format's rule too: a delimiter run is a sequence of the SAME character.
`` `*Status`* `` is neither a code span nor emphasis in any renderer, so it is not a declaration to
any reader; the old class admitted it only because a character class cannot say "the same
character". This TIGHTENS recognition, and the corpus audit below shows no ticket moves.

WHAT ELSE IN THIS GRAMMAR CARRIES AN ARBITRARY NUMERIC BOUND — the question asked, answered
exhaustively. Three numbers remain and every one is copied from a spec sentence, not guessed:
`\d{1,9}[.)]` is CommonMark's own "1-9 digits" for an ordered-list start number; `#{1,6}` is
CommonMark's own "1-6 unescaped `#` characters" for an ATX heading; `\[[^\]\n]?\]` is GFM's
task-list marker, a bracket pair around exactly one character — already WIDER than the spec so
renderer-specific fills (`[-]`, `[/]`) are covered, and not a length guess because a bracket pair is
not a repeatable run. The one invented number is gone. Both bounds are cited in the source comment
so the next round can check them against the spec rather than against taste.

A SECOND, INDEPENDENT INSTANCE OF THE SAME PATTERN, found while fixing the first. Round 6 hand-wrote
the VALUE trim as ``[\s*_`]`` and left `~` out of it. `- Status: ~~VERIFIED~~` on a VERIFIED ticket
therefore classified as unrecognised and CONTRADICTED a ticket it plainly agrees with — a false
ERROR that takes `board:check` down over a correct file, the expensive direction. The label alphabet
and the value alphabet are now built from one `DELIM_CHARS` list and cannot drift again.

WHAT IS NOW UNREPRESENTABLE VS MERELY GUARDED, IN BOTH DIRECTIONS.
*Unrepresentable — under-recognition:* a declaration missed because its delimiter run is LONG. There
is no length in the pattern to be short by; length cannot recur as a defect on this axis.
*Unrepresentable — over-recognition:* a quotation promoted because its run is long (the closer must
still land at the LABEL, at every length), a mismatched-length "close" accepted, and a mixed-character
pseudo-run accepted. *Unrepresentable — drift:* the label and value alphabets disagreeing.
*Guarded, not unrepresentable — under-recognition:* a declaration decorated with a block marker
CommonMark does not define (`•`, `→`) is still missed — the cheap direction, and the alphabet is a
closed spec list that moves with the spec. A CommonMark-legal delimiter this grammar does not list
(`=`, `==highlight==` in some renderers) is missed for the same reason and by the same closed list.
*Guarded, not unrepresentable — over-recognition:* a status line inside a fenced code block in the
HEADER is still read as a declaration — unchanged, deliberate, named in every round (the repair is
one line; the alternative is rendering Markdown to answer "is this ticket done"). Preserved
unchanged from rounds 5 and 6: block structure is stripped and inline prose is not, a delimiter must
CLOSE at the label, and the severity rule (contradicting ⇒ ERROR, agreeing or empty ⇒ WARNING).

VERIFICATION. MUST-FAIL FIRST: the verifier's own probe, preserved at
`adversarial-long-codespan.mjs` (kept in the out-of-repo verify scratch, room
`cleanroom-verify-8Vz9XS`), run
unmodified in scratch against the parent's `scripts/lib/ticket-schema.mjs` — **exit 1**, `lookalikes:
[]`, all four consumers `{matched:true, state:"open", error:null}`, `boardCheckExit: 0`. Against this
change: **exit 0**, all four `matched:false`, CONTRADICTORY STATUS LINE naming the file and both
readings, `boardCheckExit: 1`. The whole round-7 suite was then run against the parent module:
**589 passed, 96 failed** — 72 length-sweep cells, 12 end-to-end consumer checks on the two new
LOOK-ALIKE shapes, 5 mixed-run cells, 6 value-trim cells and the non-vacuity counter. Not one new
assertion passes on the parent.

The sweep is over LENGTH ITSELF: 12 lengths (1,2,3,4,5,6,7,8,12,17,40,101) × 4 delimiters × 2
closing positions = **96 declarations recognised**, asserted by count so the block cannot go vacuous;
the same 48 lengths×delimiters closing after the VALUE stay prose; 28 UNEQUAL-length pairs
(4⇄3, 3⇄4, 1⇄2, 2⇄1, 5⇄4, 4⇄6, 8⇄1 × 4 delimiters) are not declarations; 5 mixed-character
pseudo-runs are not declarations; 20 value-trim cells and 3 delimiters-only values (empty ⇒ warning);
9 long-run PROSE shapes join the negative list (quoted, parenthesised, typographic-quoted, link,
unbalanced, mismatched). The two new shapes go through the full contradicts/agrees/empty matrix on
the real victim, all four consumers plus `board:check` and `arch-watch` exit codes. All 25
previously-recognised block-decorated forms and all five closes-at-the-label/closes-after-the-value
PAIRS are re-asserted unchanged. ReDoS: 12 lines of up to 50 000 delimiters parse in single-digit ms.
`verify:unmappable-status`: **692 passed, 0 failed, exit 0** (was 464 on the parent's suite).

REAL-CORPUS SWEEP: **zero look-alike hits**, zero status errors, and exactly the two known
pre-existing `AMBIGUOUS STATUS` warnings (FEAT-020, FEAT-043) — same two files, same class,
byte-identical messages, on the parent's recogniser and on this one.

REQUIREMENT (5), THE PLACEMENT AUDIT, REDONE THE WAY THE LAST ROUND DID IT (this verifier explicitly
did not, and said so). `audit-placement.mjs` (out-of-repo scratch, `arch004-r7`) imports nothing from
the suite under test — no `verify-unmappable-status.mjs`, no `board.mjs`, no `ticket-schema.mjs` in
its own process. Room A carries HEAD's `scripts/` from `git archive`, room B the working tree's;
both get a private copy of the same real 186-ticket corpus; each is asked only through its OWN
shipped `board.mjs`, out-of-process; the regenerated INDEX is re-read with a table parser written
inside the audit. **AUDIT CLEAN, exit 0 — 186 placed tickets (25 open / 161 done), 0 moved, 0 new,
byte-identical regenerated INDEX.md (sha256 `4eeac0d92b0c1991…`, 29885 bytes both sides), and an
identical set of corpus status reports (2 = the two known warnings).** NON-VACUITY: a third room with
one real DONE ticket flipped to OPEN, graded by the SAME comparator, reports `BUG-004` moving
done→open. An audit that cannot see a forced move proves nothing when it sees none. `board:gen` was
never run against the real tree.

REQUIREMENT (6), PROBED AS A CONSEQUENCE rather than as a checksum — never independently covered in
six rounds. The two standing checks prove the fleet sweep NOTICES a drifted copy; they do not show
what drift COSTS, and "the sweep would have said so" only reassures if the failure it prevents is
real. So the stale copy is no longer a synthetic edit: it is the module **as committed at HEAD** —
the genuine round-6 artifact a project scaffolded yesterday is carrying right now — grading a corpus
that contains the clean room's own four-backtick contradiction. Result: the stale board **exits 0 and
prints nothing**. No crash, no warning, no degradation — a module that defines "done" is the one file
whose staleness is invisible at the point of use, which is the same silent-disable class as a hook
that stops firing. The SAME board over the SAME corpus with the FRESH module exits 1 and names the
contradiction, and the fleet sweep reports `would-update` on THAT file — so the detector and the
consequence are demonstrably about one file, not two unrelated facts. Missing copy: both tools still
die loudly and name the module.

Anti-regression, all exit 0: verify:unmappable-status 692/0, verify:ticket-schema 51/0,
verify:provenance 17/0, verify:board-tool 34/0, verify:reachability 16/0, verify:decision-shape
25/25, verify:onboard 36/0, verify:fleet-sync 23/0, verify:feat-082 52/0. `npm run gate` PASS
exit 0 (leak-gate, check-nul, typecheck), read unpiped. Pre-existing and unmoved, NOT MINE:
verify:tickets 29/30, verify:arch-watch 48/1, verify:needs-you-rail 16/17, verify:decisions 17/18 —
identical counts to the stated parent baseline.

HIGH-STAKES — an independent clean-room pass is warranted, and the attack should be REFRAMED again.
Rounds 5 and 7 widened; round 6 narrowed; this round does BOTH (unbounded length widens, homogeneous
runs narrow). The productive question is therefore no longer either of the previous two but
**"which side did the double move get wrong?"** — concretely: (a) is there a header line a human
plainly reads as a declaration that the HOMOGENEOUS-run requirement now misses, e.g. legitimate
NESTED delimiters like `` **`Status`**: VERIFIED `` where the opener is `` **` `` and the closer
`` `** `` (reversed, so the backreference cannot match it — believed correct to miss, untested
against a renderer); (b) does unbounding the opener let some very long run promote prose that the
capped version could not reach; (c) the value-trim alphabet now strips MORE, so is there a real
status value that legitimately begins or ends with `~`. Not tested: the HTTP transport and the
browser UI (the API's shared parser path was exercised in-process only); no renderer was actually
run over any of these lines — every claim about "what a renderer does" is read from the CommonMark
spec, not measured.
