```orchard-ticket
{
  "id": "FEAT-166",
  "type": "feature",
  "title": "A lane's fork for the user never reaches the Decide card",
  "summary": "When a lane hits a choice only the user can make, it writes the options as Activity-log prose. The dashboard's Decide card renders only a decision declared in the ticket record, so the user sees nothing. Seen on FEAT-164: options A/B/C sat in the log and no card appeared.",
  "impact_if_we_wait": "Every fork a lane raises reaches the user as silence; the ticket stalls until someone notices and hand-writes the record.",
  "current_need": "A board-tool verb that declares a decision in the exact record shape the Decide card reads, owned by one writer, and a pointer to it where lanes learn board-tool commands.",
  "severity": "medium",
  "area": "board tool decisions",
  "reported": "2026-10-05",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-10-05",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "board-tool decide writes a decision the dashboard parser reads back with the same keyed options and recommended key.",
    "It refuses fewer than two options, duplicate keys, a recommendation that names no option, and an open decision without --replace.",
    "It sets the ticket to needs-you on the board and appends an Activity-log entry, and never writes a user answer.",
    "The board README and the injected conventions say a fork is declared with board-tool decide, never as log prose."
  ],
  "code_refs": [
    {
      "path": "scripts/board-tool.mjs"
    },
    {
      "path": "src/server/board.ts"
    },
    {
      "path": "docs/bugs/README.md"
    },
    {
      "path": "docs/CONVENTIONS.md"
    }
  ],
  "related": [
    {
      "id": "FEAT-164",
      "relation": "see_also"
    },
    {
      "id": "FEAT-097",
      "relation": "see_also"
    },
    {
      "id": "ARCH-010",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a10c90-b6ee-7503-9f38-8daf02d211fc",
      "verdict": "broken",
      "verdict_on": "2026-10-05",
      "recorded_at": "2026-10-05T14:59:05.169Z",
      "author": "worker (verifying r1)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Independent clean-room verify, cross-provider (anthropic author -> openai verifier). VALID, manifest-backed. BROKEN: board.ts reopen rule broke via two distinct paths; two-break STOP invoked. Detail in the Activity entry below."
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a10cb5-409f-7510-9281-a2cbef06e231",
      "verdict": "broken",
      "verdict_on": "2026-10-05",
      "recorded_at": "2026-10-05T15:41:04.577Z",
      "author": "worker (verifying r2)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Clean-room r2 (anthropic->openai). BROKEN property 1, NEW path: an agent-written Activity-log 'you (answer ... decision <current-id>)' heading flips ticketAnswerState to answered. Two-break STOP. Run 27d57ef68289; reproduced vs real board.ts. Detail in Activity entry."
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a10de8-1d4e-7173-bf68-2aab082e55c0",
      "verdict": "broken",
      "verdict_on": "2026-10-05",
      "recorded_at": "2026-10-05T21:14:40.364Z",
      "author": "worker (verifying r3)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Clean-room r3 (anthropic->openai), VALID manifest-backed. Answer-STATE HOLDS (fixer 37/37 in-room). BROKEN sub-property: board:check does not flag a post-freeze forged user-answer heading wrapped in a code fence; it still counts for nothing (state null). Two-break STOP. See Activity entry."
    }
  ],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": false,
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

# FEAT-166 — A lane's fork for the user never reaches the Decide card

## Symptom

On FEAT-164 a fixing lane hit a fork that needed the user and wrote options A, B and C as Activity-log prose. The ticket page showed no Decide card: the card renders only a decision declared in the ticket record, and the record still said no decision. A later lane hand-wrote the record (see FEAT-164, entry "worker (finding r1)").

## Diagnosis

scripts/board-tool.mjs has verbs to file, update and record verification, but none to declare a decision, so a lane at a fork has no sanctioned writer and improvises prose. The parser is correct to ignore prose (BUG-025). The fix is a writer, not a looser reader.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-05 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-05 — worker (fixing r1)
- **Fixing round 1:** Built `board-tool decide` (dispatch phase=fixing round=1 class=fix).
    - **Command:** `node scripts/board-tool.mjs decide --id <ID> --question "…?" --option "A=label | what changes | gains | costs | why not obviously best" --option "B=…" [--option …] [--recommend A --why "…"] [--replace] [--work-state …] [--author …] [--rev …]`. Five `|` fields per option because the record (and the Decide card) requires all five; an empty one would be a placeholder, which the schema forbids. Writes record.decision (mode single, the FEAT-164 shape), human_action decide, owner you + INDEX 👤 via setBoardOwner, work_state blocked by default, a `Decision declared:` Activity entry via appendNote, then genBoard. Refuses: <2 options, bad/duplicate keys, missing fields, recommend not a key, recommend without --why, an open (unanswered) decision without --replace (old one moves to decision_history, chosen null), an author reading as the user, done/not_a_bug, legacy, and a half-written record (now `unreadable-ticket`, not mislabelled legacy). Never writes a `you (…` entry.
    - **Second gap found and fixed (src/server/board.ts):** a ticket the user answered once could never be asked again. answerEntries/ticketAnswerState treated the old answer as current, so a new decision showed the OLD answer on the card, or was dropped from the rail as "agent acted". Both now return null when a non-user `Decision declared:` entry follows the last user reply (anchored to the entry head). An answered decision is superseded without --replace and recorded in decision_history as chosen by you.
    - **CLI:** every verb now also accepts `--flag value` (boolean: --include-body, --replace); `--flag=value` parses exactly as before. The `verified --id BUG-123 --provider …` line CONVENTIONS documented was refused before (`bad-argument`), checked live.
    - **Docs:** docs/bugs/README.md decision section (one paragraph plus syntax; the INDEX-flip sentence now points at the tool); docs/CONVENTIONS.md injected region, a 4-line subsection after the verified one.
    - **Verified:** must-FAIL: the new suite on the pre-change tool failed at `unknown-verb`. With the board.ts hunk reverted in a scratch copy, it failed 2 (the re-decision legs). `node scripts/verify-feat-166-board-tool-decide.mjs` gives 62/62 on a scratch copy of the real board: round-trip through ticketDecision/readBoard/validateTicket, 12 refusals each byte-identical, 4 truncation points, --replace history, re-decision on a real answered ticket then a real answerTicket reply (FEAT-090 lane intact), and CLI compatibility. `node scripts/verify-feat-166-decide-card-browser.mjs` gives 9/9 in headless Brave on an isolated scratch server (free port) over a full copy of the real board (390 tickets, 157 open rows): no card before; after decide the card is pending with the question, A/B/C and B recommended; the rail API lists it; re-decision on an answered ticket is pending. Screenshot /tmp/iv-orchard/feat-166/B-ARCH-005-after.png (synthetic decision text, real ticket copy).
    - **Anti-regressions:** feat-090-followup, decision-shape, bug-225-verified-by-parse 95/95, ticket-schema 64/64, decide-readability 210/210 and bug-146-conventions-inject 30/30 all pass. Already red with or without this change (FAIL sets diffed equal against a scratch copy with the board.ts hunk reverted): verify-board-tool (c), feat-090-answered-lane (snapshot placement), bug-122 (8, ARCH-019 pre-fix legs), and reachability, which throws on a real decision ticket with no Status line. verify-feat-097 failed only on a leak in another lane's BUG-230 text inside its scratch copy. bug-123 timed out at 300s and was not run to completion. `npm run gate` exits 0.
    - **Open / handoff:** board.ts answer-state rule is regression-prone (FEAT-090 history), so an independent clean-room verify is warranted. Attack: a user follow-up after a re-declared decision; a `Decision declared:` line inside user prose; the hand-written FEAT-164 entry now also counts as a declaration. Not done: multi/staged modes (single only), legacy prose tickets (refused with the README shape), and no npm script alias (package.json is shared and dirty).

### 2026-10-05 — worker (verifying r1)
- **Verification recorded:** dispatch openai/default run 01a10c90-b6ee-7503-9f38-8daf02d211fc — VERDICT: BROKEN — Independent clean-room verify, cross-provider (anthropic author -> openai verifier). VALID, manifest-backed. BROKEN: board.ts reopen rule broke via two distinct paths; two-break STOP invoked. Detail in the Activity entry below.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-05 — worker (verifying r1)
- **Independent verify (round 1) — BROKEN:** Clean-room independent verify via scripts/independent-verify.mjs. Cross-provider: anthropic author -> openai verifier (dispatch thread 01a10c90-b6ee-7503-9f38-8daf02d211fc). Setup: an isolated scratch git repo whose ONLY base->head diff is the two FEAT-166 files (scripts/board-tool.mjs, src/server/board.ts) layered on the current working tree, so the verifier saw exactly that diff; methodology stripped; the real board supplied via --allow-input docs/bugs; FEAT-166's own ticket removed from that copy so the fixer's report never reached the verifier.

  VALID (manifest-backed: fixer suite run + two adversarial cases + an untested list). Fixer unit suite verify-feat-166-board-tool-decide.mjs re-ran 62/62 in the room (manifest e2c6df27fb7d). Properties held as exercised: (1) round-trip of declared options/recommended key, (2) refusals leave ticket+INDEX byte-identical, (5) --flag value does not change --flag=value meaning, repeated flags still refused. NOT independently re-exercised (verifier stopped at the two-break rule): special-char round-trips, concurrent-writer / truncation refusals, and the browser card.

  BROKEN on property (3), the board.ts reopen rule, via TWO distinct paths:
  (a) followup-resurrects-old-answer (manifest 09171e3d28b7): on a ticket the user already answered, after a NEW decision is declared, a context-only user FOLLOW-UP resurrects the OLD answer — ticketAnswerState returns the prior answer and the ticket reappears on readBoard().answeredAwaiting (observed on ARCH-004), with the old answer neither retired nor the new question shown pending.
  (b) fenced-declaration-reopens (manifest 74e1166e46c4): a line shaped like '- **Decision declared:**' inside a FENCED documentation block is parsed by lastDeclarationLine as a real declaration and clears a genuine user answer; renaming the marker restores the answer, proving the fenced example is read as live (DECLARED_LINE_RE is not anchored to real entry heads / ignores code fences).

  Two distinct break routes in ONE property -> verifier invoked the two-break STOP rule: 'enumerated property, route to single-authority redesign'. This matches the fixer's own flagged risk (board.ts answer-state rule, FEAT-090 history). Artifacts: /tmp/iv-feat166-verdict-openai2.txt, /tmp/iv-feat166-run-openai2.log. Note: both openai (quota, reset 17:36) and anthropic (session limit, reset 17:50) first failed as INVALID dispatch errors; this VALID run is the openai retry after reset — same-provider anthropic fallback was unavailable, so the preferred cross-provider pairing was used.

### 2026-10-05 — worker (fixing r2)
- **Fixing round 2 — answer state bound to the decision by identity:** Redesigned so the broken property holds by construction (ARCH-010), no more regex guards. A decision now carries its OWN id: board-tool decide mints record.decision.id (full randomUUID, minted once). A user reply records the id it answers in its server-composed heading — `you (answer · via … · decision <id>)` — written by composeAnswerEntry via tickets.answerTicket (rev-gated) and board.appendAnswer (legacy rail). board.ts pairs answer->decision by that id: ticketAnswerState/answerEntries now read currentDecisionId(record) and keep only replies whose heading id === current id (null===null is the legacy binding), REQUIRE a non-follow-up anchor bound to the current id, and the Activity-log scan is code-fence aware. lastDeclarationLine + DECLARED_LINE_RE deleted entirely. Break (a) orphan-follow-up-resurrects-old-answer and break (b) fenced-declaration-clears-answer are both unreachable (no text-order compare, no declaration scan). Migration by READING only: no archived ticket rewritten; a pre-r2 decision has no id and reads as the legacy/unidentified decision. Schema: decision.id added to DECISION_KEYS as an OPTIONAL non-empty string (additive, backward-compatible — existing records validate unchanged); formatTicket orders it; decision_history records the superseded id. Files: src/server/board.ts, src/server/tickets.ts, scripts/board-tool.mjs, scripts/lib/ticket-schema.mjs, scripts/verify-feat-166-answer-binding.mjs (new). Verification: new suite 11/11 — both breaks reproduce on a PINNED pre-r2 board.ts (fixture bytes under scratch/pre, not HEAD) and are fixed on live; legacy + FEAT-090 follow-up preserved; property sweep over all 390 real tickets shows ticketAnswerState + readBoard().answeredAwaiting identical before/after. Anti-regressions: verify-feat-166-board-tool-decide 62/62, verify-ticket-schema 64/64, verify-feat-090-followup 28/28, verify-bug-104-chose-roundtrip 11/11. verify-feat-090-answer-handoff 29/31 — the 2 fails are Part C real-Brave/live-session preconditions (no live session in this lane), environmental, not answer-binding logic. npm run gate exits 0. Cross-provider plan review (openai, read-only, run 01a10c9b-4f7c-75c1-9f1a-3b3f78603d55) drove the design: require anchors in both readers, a structural (heading) envelope prose cannot impersonate, fence-aware scan, full-uuid id, and binding the legacy rail. Known limitation (pre-existing): the legacy Needs-You rail appendAnswer has no rev, so it cannot reject a submission made stale by a decision that changed between read and submit; the rev-gated ticket-view route is the primary Decide-card surface and does reject it. HIGH-STAKES (answer-state, FEAT-090 regression history): an independent clean-room verify pass is warranted.

### 2026-10-05 — worker (verifying r2)
- **Verification recorded:** dispatch openai/default run 01a10cb5-409f-7510-9281-a2cbef06e231 — VERDICT: BROKEN — Clean-room r2 (anthropic->openai). BROKEN property 1, NEW path: an agent-written Activity-log 'you (answer ... decision <current-id>)' heading flips ticketAnswerState to answered. Two-break STOP. Run 27d57ef68289; reproduced vs real board.ts. Detail in Activity entry.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-05 — worker (verifying r2)
- **Independent verify (round 2) — BROKEN:** Clean-room independent verify via scripts/independent-verify.mjs. Cross-provider: anthropic author -> openai verifier (dispatch 01a10cb5-409f-7510-9281-a2cbef06e231). Setup: an isolated scratch repository whose base..head diff is EXACTLY the four FEAT-166 files (src/server/board.ts, src/server/tickets.ts, scripts/board-tool.mjs, scripts/lib/ticket-schema.mjs) layered on the current working tree; methodology stripped; the real board supplied via --allow-input docs/bugs; FEAT-166's own ticket removed from that copy so the fixer's report never reached the verifier. Both fixer suites re-ran GREEN in the room: verify-feat-166-board-tool-decide 62/62 (run 7f5dfa66a665) and verify-feat-166-answer-binding 11/11 (run 72403762198d), including the r1 must-FAIL reproductions and the 390-ticket legacy sweep. BROKEN on property 1 via a THIRD distinct path (not r1's follow-up-resurrection or fenced-declaration): an AGENT-authored Activity-log entry whose body contains a forged user-answer heading '### DATE -- you (answer via ticket view, decision <CURRENT decision id>)' followed by a Chose bullet makes ticketAnswerState return answered B instead of null. board.ts dedents the note body and parses the forged heading as a genuine user entry, so agent-written text impersonates a user answer. Adversarial manifest run 27d57ef68289 (exit 1). Independently reproduced against the REAL src/server/board.ts for BOTH an indented heading (inside an agent note) and a column-0 agent-written heading -- both flip to answered B. The binding-by-id redesign closes r1's two paths, but the heading envelope is itself forgeable in Activity-log prose by any writer, including an agent. Two distinct break routes across rounds in ONE property -> two-break STOP invoked: enumerated property, route to single-authority redesign. HARNESS EXIT NOTE: the harness returned INVALID, but SOLELY because the verifier emitted two FIXER-TEST citation lines (two fixer-test --run commands were supplied; the verdict-contract allows one). The substantive BROKEN verdict and its evidence are valid and reproduced. Artifacts kept under ~/.local/state/claude-station/scratch: clean room cleanroom-verify-ljICvE, manifest cleanroom-record-VV5ARC/manifest.jsonl, scratch tree feat166-iv-1791214331/orchard. HIGH-STAKES (answer-state, regression-prone): the user-answer should be the ONLY writer of answered-state (not a forgeable Activity-log heading) -- a single-authority fix, not another reader guard.

### 2026-10-05 — worker (fixing r3)
- **Fixing round 3:** Fixing round 3 (dispatch phase=fixing round=3 class=plan+review): the user's answer is a TYPED entry with ONE writer and ONE reader, on the BUG-225 pattern. Hypothesis held: all three breaks (r1 follow-up resurrection, r1 fenced declaration, r2 forged heading) read answered-state out of Activity-log prose; none is expressible once nothing reads prose for it.
      - **Record:** `{answer_id, kind, followup, chose, note, question, by:'user', via, on, recorded_at, recorded_by:'server', decision_key, log_k, heading_sha}`. Lives in the record's `decision.answers[]` (new OPTIONAL decision key; bound by containment, since board-tool decide builds a fresh decision, plus `decision_key` = sha of the decision minus answers, so any decision edit unbinds). A legacy prose ticket, or a record whose decision is null, uses the board's `answer-ledger.json`, bound by `decision_key` (sha of the parsed prose decision, or `none`).
      - **One writer:** `recordAnswer` (src/server/board.ts), called only by tickets.answerTicket (Decide card, rev-gated) and board.appendAnswer (Needs-You rail). The rail now sends the `decisionKey` it was shown (BoardItem.decisionKey); a missing or changed key is a 409, so an answer composed for an earlier decision never binds to a newer one. The display heading is still appended, display only. board-tool has no verb or flag that writes an answer; decide moves old answers into decision_history as history.
      - **One reader:** `boundAnswers` (board.ts); ticketAnswerState(markdown, file) and answerEntries(markdown, file) both derive from it. The only thing headings still feed is "has an agent acted since" (heading count after the answer's `log_k`): prose can only RETIRE an answer to acted, never create one.
      - **Legacy:** `docs/bugs/answers-legacy.frozen.json`, written once by `scripts/freeze-answers.mjs` from the round-2 reader (kept frozen in board.ts as legacyProse*, used only by the freeze), sha-pinned in ANSWER_FROZEN_PINS (scripts/lib/answer-source.mjs). 10 tickets; all 10 headings audited as genuine user replies dated 2026-08-04..08-25. A frozen answer counts only while its decision_key matches. No archived ticket was rewritten.
      - **board:check:** WARN `PROSE ANSWER NOT COUNTED` for a user-reply-shaped heading no typed or frozen entry accounts for (sha, with multiplicity), mirroring BUG-225 r4's WARN; FAIL on an unpinned/unreadable snapshot or ledger, or a missing snapshot on a board with such headings.
      - **Plan review (openai, read-only, run 01a10cbf-3682-7f90-a9cb-efd58301cb1f) found a 4th path and four flaws, all closed:** a stale rail submission binds to a re-declared decision (now 409 via decisionKey); board-tool update/decide/verified checked a FRESH rev against itself, a tautology that could erase an answer written between their read and write (now checked against the rev READ); a content key that ignored option descriptions (key now covers the whole decision); schema rejected decision.answers (now validated: by user, recorded_by server).
      - **Verified:** `scripts/verify-feat-166-typed-answer.mjs` 37/37 on a scratch copy of the real board (390 tickets). Must-FAIL on PINNED bytes over the SAME scenario bytes: (a) and (b) reproduce on the r1 board.ts, (c) on the r2 board.ts; all three fixed live. Freeze property: ticketAnswerState identical to the pinned r2 reader on all 390 tickets (10 answered), answered lane identical incl. text and date, needs-you identical. Also: re-decide shows pending (typed and frozen), stale rail refused with bytes unchanged, legacy ticket via ledger, board-tool update keeps answers, schema, 5 truncation points never yield a different answer, tampered snapshot FAILs board:check and counts for nothing. `scripts/verify-feat-166-typed-answer-browser.mjs` 14/14 (Playwright + headless Brave, isolated scratch server, free port, busy real-board copy): Decide card click writes the typed entry and shows answered B (survives reload); re-decide shows pending; a frozen answer still shows the user's words; the rail tile click writes a typed `via Needs-You rail` answer and moves it to the answered lane; a keyless rail POST is 409. Screens in /tmp/iv-orchard/feat-166-r3.
      - **Anti-regressions vs a reverted copy (round-2 files restored):** feat-166-board-tool-decide 62/62, feat-166-answer-binding 11/11, feat-166-decide-card-browser 9/9, feat-090-followup 28/28, bug-104 11/11, feat-090-answered-lane 25/26 and feat-090-answer-handoff 29/31 (same fails as the reverted copy: snapshot placement; live-session precondition and WIDE layout), rail-refresh, feat-082-digest, bug-122 (fewer fails than reverted), board-rank, reachability, feat-106-readers, feat-126 unchanged, ticket-schema 64/64, bug-225 95/95, decide-readability 210/210, bug-146 30/30, onboard 57/57. Suites that seeded answers as prose headings now seed through the writer; pure composer-grammar legs read the frozen legacy reader. `npm run gate` exits 0; board:check exits 0 on the real board.
      - **Scope:** a same-uid process that deliberately edits decision.answers, the ledger or the frozen file is the same class as the FEAT-164 self-grant fork (user decision pending) and is NOT addressed here; the goal is that no prose an agent writes, by accident or imitation, counts as an answer. Known limits: agent prose can still move awaiting/acted (never answered); other boards have no frozen file, so their pre-change prose answers stop counting (claude-station has 2 such tickets; board:check FAILs there until frozen); a legacy prose decision has no identity, so asking the identical question again re-binds its old answer.
      - **Handoff:** HIGH-STAKES (answer state, FEAT-090 regression history, regressed-from: FEAT-166 r2): an independent clean-room verify is warranted. Attack: any non-server path to a counted answer; the decision_key binding; the log_k acted rule; the freeze equivalence.

### 2026-10-06 — worker (verifying r1)

  - **Hypothesis CONFIRMED (freeze uses the pre-change reader, state not lost):** `freeze-answers.mjs` builds the snapshot from `legacyProseAnswerFreeze` → `legacyProseAnswerCore`/`legacyProseLaneCore` (src/server/board.ts), both explicitly FROZEN legacy readers that parse ONLY the ticket markdown Activity-log prose (`markdown.split('\n')`), never the new typed stores. So running it now reproduces exactly what the round-2 reader saw. Safe to freeze.
  - **Ground truth refutes the r3 "claude-station has 2 such tickets" note.** Authoritative dry-run of the real reader over EVERY registered project with a docs/bugs board (11 of them, via the live registry on 127.0.0.1:4317): ONLY orchard's board has any legacy prose answers (10 tickets), and it is ALREADY frozen + pinned (`answers-legacy.frozen.json`, sha in ANSWER_FROZEN_PINS). Every other registered board yields 0 legacy answers. The registry's "claude-station" project id points at ~/projects/orchard — i.e. it IS the already-frozen board; its FEAT-028 + FEAT-038 both show answered via the live API right now (answer kind=decision, "DONE" / ack note).
  - **The 2-ticket board the r3 note meant is UNREGISTERED and STALE.** ~/projects/claude-station (git HEAD 235f953, 2026-08-13; board untouched since) is a pre-relocation duplicate checkout. Its FEAT-028/FEAT-038 are the 2 the note cited, but the live service never reads this path and board:check is never run there in normal flow. Those same two tickets are already covered by orchard's frozen snapshot.
  - **Action: STOPPED on freezing per the charter's STOP clause + "verify the user's reality".** No registered board needs a freeze (orchard done; the rest would write empty `tickets:{}` snapshots needing pointless new pins in answer-source.mjs). Freezing the stale unregistered checkout writes into a repo nothing reads. No board modified, no backups needed. `npm run board:check` on orchard exits 0 ("OK — no drift").
  - **DECISION for the user/orchestrator:** confirm no action. Only if the stale ~/projects/claude-station checkout is still in use would freezing it be warranted — a separate call; it is not a registered Orchard board today.

### 2026-10-05 — worker (verifying r3)
- **Verification recorded:** dispatch openai/default run 01a10de8-1d4e-7173-bf68-2aab082e55c0 — VERDICT: BROKEN — Clean-room r3 (anthropic->openai), VALID manifest-backed. Answer-STATE HOLDS (fixer 37/37 in-room). BROKEN sub-property: board:check does not flag a post-freeze forged user-answer heading wrapped in a code fence; it still counts for nothing (state null). Two-break STOP. See Activity entry.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-05 — worker (verifying r3)
- **Independent verify (round 3) — BROKEN (VALID, manifest-backed):** Clean-room independent verify via scripts/independent-verify.mjs. Cross-provider: anthropic author -> openai verifier (dispatch run 01a10de8-1d4e-7173-bf68-2aab082e55c0). Setup: an isolated THROWAWAY scratch repo (never the real repo, never pushed; built with the sanctioned temp-index plumbing the shim allows — add/write-tree/commit-tree under GIT_INDEX_FILE in /tmp, no `git init`, no ref op on the real repo) whose base..head diff is EXACTLY the ten FEAT-166 r3 files (src/server/board.ts, tickets.ts, index.ts; scripts/board-tool.mjs, scripts/lib/ticket-schema.mjs, scripts/lib/answer-source.mjs, scripts/freeze-answers.mjs; public/lib/api.js, public/app.js; docs/bugs/answers-legacy.frozen.json). Base = pre-r3 (round-2) bytes: the 4 logic files from the fixer's pins/r2, index.ts from the fixer's reverted/ copy, api.js/app.js r3 hunks hand-reverted, the new files absent. So the verifier reviewed the r3 typed-answer DELTA against the r2 baseline. Methodology stripped; the real board supplied via --allow-input docs/bugs; FEAT-166's own ticket removed from that copy so the fixer's report never reached the verifier. One fixer-test run cited (the r2 INVALID was caused by citing two).

  Fixer suite re-ran GREEN in the room: `node scripts/verify-feat-166-typed-answer.mjs` 37/37, exit 0 (manifest 5127db6b56da). So the CORE property HOLDS as exercised: answered-state comes only from a typed entry bound to the current decision; the three prior-round breaks (follow-up resurrection, fenced `Decision declared:` clearing an answer, forged `you (answer … decision <id>)` heading) all reproduce on the pinned r1/r2 bytes and are fixed live; re-decide shows pending (typed and frozen); the rail 409 refuses a stale-key answer with bytes unchanged; board-tool has no answer verb; schema rejects a non-user answer; 5 truncation points never yield a different answer; an unpinned/edited frozen snapshot FAILs board:check and counts for nothing.

  BROKEN on the stated sub-property "board:check flags a prose answer heading typed after the freeze", via a NEW path (not any of the three prior breaks): a post-freeze forged `### DATE — you (answer · via ticket view · decision forged)` heading WRAPPED IN A CODE FENCE is NOT flagged by board:check, whereas the identical UNfenced heading IS flagged. Cause: `unaccountedAnswerHeadings` iterates `activityHeadings`, which deliberately skips fenced lines (answer-source.mjs — `FENCE_RE` toggles `fenced`, `if (fenced) continue`). Reproduced on a real ticket (ARCH-001) in-room: adversarial run f16d6ae0cb4b, exit 1 — unfenced control emits the `PROSE ANSWER NOT COUNTED` WARN, the fenced twin emits no warning. Confirmed by code reading against the real scripts/lib/answer-source.mjs. IMPORTANT NUANCE the finding itself records: the fenced forged heading ALSO counts for nothing — `boundAnswers` reads no prose, so answer state stays null in both cases. This is an evasion of the ADVISORY board:check WARN, not a route to a counted/answered state; it does NOT reopen any of the r1/r2/r3 answered-state breaks. Severity is therefore lower than the prior three.

  The verifier invoked the two-break STOP rule ("enumerated property, route to single-authority redesign") because the board:check-flagging property broke via a path the fixer suite did not cover. Not tested (STOP invoked): concurrent-writer answer-vs-re-decide, and live-HTTP 409 bypasses (omit/stale/foreign key) beyond the module-level rail-409 leg the fixer suite exercises. Artifacts KEPT: clean room ~/.local/state/claude-station/scratch/cleanroom-verify-vusdFI; manifest ~/.local/state/claude-station/scratch/cleanroom-record-WzdMwE/manifest.jsonl; verdict /tmp/feat166-iv-verdict2.txt; run log /tmp/feat166-iv-run2.log; scratch base/head repo ~/.local/state/claude-station/scratch/feat166-r3-iv.1afO8E (range 738bd00bdcb1..5de841828f36). First openai attempt (run 01a10de5-696c-74b3-b750-e50cb8d7277d) died as an INVALID provider content-safety flag mid-probe, not a verdict; this VALID run is the immediate retry.

  DECISION for the orchestrator: answered-state is single-authority and holds; the open gap is that board:check — an inherently prose-scanning advisory linter — does not warn on a fenced forged heading that is itself inert. Decide whether an r4 is warranted (tighten the board:check heading scan to catch user-reply-shaped headings even inside fences, since a real Activity entry heading is never legitimately fenced) or whether the gap is accepted given the hidden heading has no functional effect.
