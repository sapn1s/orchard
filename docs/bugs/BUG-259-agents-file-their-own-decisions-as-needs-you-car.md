```orchard-ticket
{
  "id": "BUG-259",
  "type": "bug",
  "title": "Agents file their own decisions as Needs-You cards, with no honest take-back",
  "summary": "Any agent can put a decision card on your Needs-You rail without saying why it is yours, and nothing lets it honestly take a card back. Of the 24 cards on the rail today, 20 are the agent’s own call: engineering options, questions the ticket already answers, bookkeeping, and verification still owed.",
  "impact_if_we_wait": "The rail keeps filling with choices that are not yours, so the 4 real ones sit among 20 that are not. Agents also keep reaching for the one way to clear a card, writing an answer that the board records as yours.",
  "current_need": "An independent clean-room verify of the decide gate, own and the user-only reopen; then a service restart (yours) to make the reopen route live.",
  "severity": "high",
  "area": "board decisions",
  "reported": "2026-10-14",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "in_progress",
  "human_action": "none",
  "updated": "2026-10-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "board-tool decide refuses a card with no hard stop from the shared HARD_STOPS list or no consequence; the Decide card shows the stop.",
    "board-tool own records an open card as the agent’s own decision (who, what, why), never as your answer, and removes it from Needs-You.",
    "You can reopen an agent-owned decision from the dashboard, and only you can (a user-only route).",
    "The 20 agent-owned cards are taken with own and the 4 yours declare their stop; the migration starts no work."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-256",
      "relation": "see_also"
    },
    {
      "id": "FEAT-184",
      "relation": "see_also"
    },
    {
      "id": "FEAT-166",
      "relation": "see_also"
    },
    {
      "id": "BUG-257",
      "relation": "see_also"
    },
    {
      "id": "BUG-258",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "default",
      "run_id": "f7bf735d-8846-4886-b12b-c23374ee4f82",
      "verdict": "broken",
      "verdict_on": "2026-10-14",
      "recorded_at": "2026-10-14T10:42:39.519Z",
      "author": "verify lane (BUG-259 r1; Claude fallback, OpenAI quota)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "e42d200234f452ac34123d51629643704bdb352670e854213bd13e075816eeaf",
      "verify_mode": "mixed-state",
      "note": "Mixed-state; room-guard PASS; OpenAI->Claude fallback. BROKEN: [HIGH] own's INDEX-flip+genBoard unlocked->concurrent own left cards owned AND on rail; [MED] gate bypass (direct record; owner route w/o requireUserCaller); FEAT-086 log-only unreopenable. Two-break->design review; ARCH-021 mis-owned."
    }
  ],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": true,
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

# BUG-259 — Agents file their own decisions as Needs-You cards, with no honest take-back

## Diagnosis

regressed-from: FEAT-166 (it built `board-tool decide` as the one writer of a decision card, with no check on whose decision it is). BUG-256 closed the same gap for chat asks only.

Hypotheses checked against the code on 2026-10-14:

1. **Confirmed.** `verbDecide` in `scripts/board-tool.mjs` checks the shape of the options, the author string (never "you"/"user"), leaks and freshness. It never asks why the decision belongs to the user. Any agent can put any question on the rail.
2. **Confirmed, with one nuance.** There is no honest typed way to take a card back. Three paths exist, and each is wrong. `decide --replace` only swaps in another question. `update --owner=agent` hides the card but leaves `human_action: decide` and the open decision in the record, with nothing saying who decided or why. The server's answer route records `by: user`. That is how FEAT-164 and FEAT-170 got orchestrator-written answers that read as yours (FEAT-184).
3. **Confirmed, and stronger than the hypothesis.** 20 of the 24 rail cards are agent-owned (table below).

## Evidence

### Needs-You triage, 2026-10-14

Triage of the 24 cards on the Needs-You rail, 2026-10-14, read from `readBoard()` (the rail's own reader; `board:status` counts 28 owner cells, and 4 of those are answered and off the rail: BUG-240, FEAT-164, FEAT-170, FEAT-023). Labels are judgement against the BUG-256 closed list (`HARD_STOPS` in scripts/lib/format-metrics.mjs). A card is the user's only if the decision itself needs one of those stops. A clear recommendation, a reversible choice, or the ticket's own success criteria make it the agent's.

| Card | Owner | Kind | Why | Decision the agent should take |
|---|---|---|---|---|
| FEAT-178 distribution shape | user | direction | npm, binary or desktop app decides who can install Orchard and on which OS: product direction | stays with you |
| FEAT-182 risk-routed verification | user | direction | changes the methodology rule every project follows; FEAT-184's delegation path, not this ticket | stays with you (FEAT-184) |
| BUG-116 lazy container browser | user | access | the recommended option edits your other repo (~/random_projects/stealth-browser-mcp) | stays with you; B or C would need no ask |
| BUG-108 browser in container image | user (borderline) | taste | which cost lands on your machine: a much larger image, or a setup step before every container session can browse | stays with you |
| ARCH-013 adversarial rounds outside orchard | agent | impl | engineering options with a recommendation; C is local to dispatch.mjs and reversible | C |
| ARCH-019 auto-background env knob | agent | impl | engineering; recommendation is no change | A, no change |
| ARCH-021 git-write enforcement layer | agent | impl | your BUG-240 answer already set the threat model (accidental, not malicious; the shim covers it) | A, price the residual; hooks in other repos would come back to you |
| ARCH-023 push-gate scan scope | agent | impl | makes the gate stricter, not looser; recommendation A is destination-independent | A, with the allowlist in the same change |
| BUG-048 held-message status | agent | impl | reversible UI honesty fix with a recommendation | A |
| BUG-104 verifier methodology leak | agent | impl | four engineering approaches, no user value at stake | 4 as the standing check, fix what it flags with 1 and 2 |
| BUG-115 suspend-window inconclusive | agent | impl | engineering with a recommendation; touches no product path | A |
| BUG-121 record block out of position | agent | impl | parser strictness; B is the safe default | B |
| BUG-140 waits that outlive their work | agent | impl | four engineering options, no recommendation; nothing user-held | C, bound every wait |
| BUG-236 leak-gate code expressions | agent | impl | raises recall; the cost is a measured one-time allowlist | B, allowlist staged in the same change so the gate never goes red |
| FEAT-082 proof-card evidence source | agent | impl | recommendation C; visual review still applies before done | C |
| FEAT-088 where structure review runs | agent | impl | C is advisory, reversible and gathers the data to choose later | C |
| FEAT-086 cost view: rendered or CLI | agent | answered | its success criteria already require a rendered view | build the view |
| FEAT-087 rename ticket headings | agent | answered | its success criteria already assume the rename ("parse every ticket after the rename") | A |
| FEAT-092 per-turn amendment channel | agent | answered | its success criteria describe the channel (B) | B |
| FEAT-030 cross-project handoff | agent | sequencing | parking adds no new direction; only starting it would | A, keep parked |
| FEAT-033 close the tool-adoption ticket | agent | bookkeeping | open-or-closed is board housekeeping | A, close |
| FEAT-049 publish ticket open or closed | agent | bookkeeping | the question is bookkeeping; the publish itself stays an outward step for you, as a hand-off and not a decision | A, hold open with the publish as your hand-off |
| FEAT-124 Fable gate | agent | cont | the decision is resolved (A built, B shipped); what remains is an independent verify, then a git hand-off | dispatch the verify; batch the git hand-off |
| FEAT-135 git shim in subprocesses | agent | cont | the status says the only remaining gate is an independent verify; the decision is already resolved | dispatch the verify |

**Counts.** User-owned 4 of 24 (17%): direction 2, access 1, taste 1 (borderline). Agent-owned 20 of 24 (83%): impl 12, answered by the ticket's own criteria 3, sequencing or bookkeeping 3, cont (verify owed, card stale) 2. This is a stock count, not a rate. Cards the user answers leave the rail, so cards nobody answers pile up there. That biases the stock toward agent-owned cards, so 83% does not contradict the 45% flow rate in §1.

**Off the rail but still 👤 in INDEX (drift):** BUG-240, FEAT-164 and FEAT-170 are answered and followed, but their Owner cell was never flipped. FEAT-164 and FEAT-170 carry the two `by: user` answers that an orchestrator wrote (FEAT-184).

## Implementation notes (plan)

**Shared definition (ARCH-010).** `HARD_STOPS` stays where BUG-256 put it, in `scripts/lib/format-metrics.mjs`. A small pure export, `hardStopCheck(token, consequence)`, joins it and returns `{ ok, stop, defect: 'not-hard-stop' | 'no-consequence' }`, with the same three-word floor `MIN_CONSEQUENCE_WORDS`. `deciderOf()` and the hook use it for asks. `board-tool decide` imports the same function. There is no second list and no second threshold.

**(a) Gate on `decide`.**
- New required flags: `--stop=<one HARD_STOPS token>` and `--consequence='what happens to you if the agent picks'`. A missing or off-list stop is refused with `not-hard-stop`. The message says: "this is your decision to make; take it with `board-tool own` or just do it". A thin consequence is refused with `no-consequence`.
- The stop and consequence are stored on the decision record (`decision.stop`, `decision.stop_consequence`; `validateTicket` learns both). The Decide card shows them as "Why this is yours: live — restarting kills your three running sessions". The claim is in front of the user who is asked, so a relabel is visible where it matters.
- Existing cards without a stop are grandfathered on read, so nothing breaks. `board:status` lists them as "no stop declared" so the backlog can be worked down.
- Honest limit, stated as in BUG-256: this checks that a stop is present and well-formed, not that it is true.

**(b) `own` verb: the agent records its own decision.**
- `board-tool own --id=X --chose=KEY --why='…' --author='worker (…)' [--rev]`. For a legacy prose card, `--chose` may be free text.
- Effect: the open decision moves to `decision_history` with `chosen`, `chosen_by: 'agent'`, `owned_by: <author>`, `owned_reason: <why>` and `chosen_on`. `decision` becomes null, `human_action` becomes `none`, and the Owner cell goes from 👤 to 🤖 (or unassigned when no lane picks it up). The Activity log gets a typed `**Decided by agent (own):**` entry. `decision.answers` is never written, so `ticketAnswerState` and the BUG-257 briefing never treat it as a user answer.
- Refusals:
  - the decision already has a user answer (`answered`);
  - the card declares a factual stop (irreversible, outward, live, git, access, money) unless `--why` explains why that stop was wrong (`declared-stop`);
  - an author that reads as the user;
  - a stale rev.
  `taste`, `direction`, `info` and `blocked` cards are also refused by default, so an agent cannot take a real fork. The only way through is `--not-yours='…'`, which is logged verbatim.
- One writer: `own` and FEAT-184's `adopt` both close a decision without a user answer. They share one internal `closeDecision(record, {actor, provenance})`. The actors differ: `agent` vs `agent-under-delegation`. That is why this is built after FEAT-184 lands, on top of its writer.

**(c) Your reopen path.**
- The rail gets a collapsed "Decided by agents" strip: the last 14 days of `own` and `adopt` closures, each showing who, what, why, and a **Reopen** button.
- Reopen goes through `POST /api/tickets/:id/reopen-decision`, gated by `requireUserCaller` (caller-provenance.ts) so an agent cannot fake your reopen (BUG-258). It restores the history entry as the current decision with a new decision id, sets `human_action: decide` and owner 👤, and logs "Reopened by you" with your optional note.
- The ticket view shows the closed decision as "Decided by <agent author> — <why>" and never as an answer.

**(d) Instructions.** RESPONSE_FORMAT and WA §B ("settled decision") gain one line: a decision card needs a hard stop; otherwise take the decision with `own`. This is a canonical methodology edit plus `sync:methodology`.

**(e) Migration.** After the build, run `own` on the 20 agent-owned cards above, one by one, with the reason from the table. Run `decide --replace` with a stop on the 4 user-owned cards. Separately, flip the Owner cells of BUG-240, FEAT-164 and FEAT-170, which are already answered. This is a board change and starts no work.

**Files the build touches:** scripts/lib/format-metrics.mjs (export only), scripts/board-tool.mjs, scripts/lib/ticket-schema.mjs, src/server/board.ts, src/server/index.ts (reopen route), public/app.js (rail strip, card "why yours"), scripts/board-status.mjs, docs/prompts/RESPONSE_FORMAT.md, the canonical WA plus its mirror, docs/bugs/README.md, and a new scripts/verify-<this id>-decide-gate-own.mjs.

## Verification plan

- Must-FAIL first. The new suite runs against the pre-change tool on a scratch copy of the real board: `decide` without a stop succeeds (FAIL), `own` is an unknown verb (FAIL).
- After the change:
  - each off-list stop and each thin consequence is refused;
  - a real restart, git, direction or taste card passes;
  - `own` on each real agent-owned card from the table (scratch copy) clears the rail as read by `readBoard`, writes no `answers`, and leaves `ticketAnswerState` null;
  - `own` on an answered card, or on a factual-stop card, is refused;
  - reopen from a non-user caller gets 403; reopen from the user restores the card.
- Truncation: `own` writes the record and then the log. Read the ticket truncated between those two writes, and grade `readBoard` and `board:check` on each cut.
- Anti-regressions: verify:board-tool, verify-feat-166 (all), verify-feat-090 (both), verify-bug-256, verify-feat-137-138, and FEAT-184's suite.
- UI: a real headless click-path over a busy-board fixture (the real 24 cards plus 20 owned ones): Reopen works, and an unbiased screenshot review of the strip.

## Risks

- Security-adjacent: this widens who can clear a card. It needs an independent clean-room round. The main attack is laundering a real fork through `own --not-yours`.
- A rail that shows less can hide a card that really was the user's. The decided-by-agents strip and the reopen path are the mitigation; the audit counts `own` uses per stop.
- FEAT-184 is editing the same three files. Build only after it lands.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-14 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-14 — worker (BUG-259 fixing r1)
- **Plan reviewed (MODIFY), build parked on FEAT-184:** Plan reviewed, verdict MODIFY. Reviewer: OpenAI run 01a13969-1219-7580-bc71-3db571a52dd4 (read-only). It triaged blind first: it got the card data and the closed list, but not the per-card labels. (The diagnosis it read stated no count.) Agreement on owner: 22 of 24 cards. Both disagreements are cards this triage left with the user and the reviewer gave to the agent: BUG-108 (it says A) and FEAT-182 (it says A, keep the rule). Both stay with the user here, because that is the cautious side, and FEAT-184 already ruled that FEAT-182 waits for the user's recorded delegation. Result: 20 to 22 of 24 cards are agent-owned. Option picks differ only on FEAT-082 (reviewer B, triage C) and on detail for BUG-104 and BUG-140. ARCH-021 is better described as already settled by the user's BUG-240 answer than as a new choice of A. One premise refuted: FEAT-184's in-progress writer (recordAdoption in src/server/board.ts) appends a typed answer, by agent-under-delegation with a receipt. So own must not share answer semantics with adopt. PLAN AS REVISED (supersedes the Implementation notes where they differ): (1) the decide gate is a DECLARATION check, named that way; it is not proof of ownership. It shares hardStopCheck from format-metrics.mjs. --consequence must name the specific pending action. access, live and outward also need --target (repo path, service, or destination). Closing the hiding path: update refuses --owner or --human-action changes on a ticket with an open decision, and points to own. decide --replace may not drop or downgrade a declared stop (replacement ancestry is checked). (2) own needs a typed --basis=recommendation|criteria|settled|verify-owed. criteria and settled also need --ref (a success-criterion index, or the answer or ticket that settled it). A card that declares any stop is refused outright: no --not-yours, no prose override. If its stop is wrong, you drop it. own also refuses a decision you reopened, so there are no own/reopen loops. Grandfathered cards (no stop declared) can be owned. (3) own and adopt stay separate operations with discriminated records. They share only the helpers for rev checks, validation, atomic writes and board regeneration. own writes no answer; adopt keeps its receipt and authorisation checks. (4) History keeps a FULL snapshot of the decision: options, recommendation, stop. Reopen goes by closure id and the displayed rev, is idempotent, and refuses to overwrite a newer decision, answer or adoption. (5) Dispositions are kept apart: chose an option, recognised as settled, and verify owed. A hand-off you hold (the FEAT-049 publish, the FEAT-124 git step) stays as a human action and is never cleared along with the question. Work that is still unfinished stays queued. (6) Migration runs from a per-card manifest: decision id, rev, disposition, basis and ref, remaining work, and retained hand-offs. Each card is re-checked against its rev just before the write. The legacy cards FEAT-124 and FEAT-135 get an explicit legacy snapshot. (7) The record and its log entry are written in one atomic replacement, and the index is regenerated after (board:gen repairs it). Tests cover partial states between ticket and index, concurrent answer vs own and own vs reopen, replace-then-own laundering, reopen-then-own loops, multi and staged decisions, a full reopen round-trip, a non-user caller, leaks, and BUG-256 parsing surviving the extraction. Deletion test applied: v1 drops the 14-day 'Decided by agents' strip. A Needs-You count of recent agent decisions links to the ticket view, which shows 'Decided by <agent> — <basis/why>' and a Reopen button. Files the build touches: scripts/lib/format-metrics.mjs, scripts/board-tool.mjs, scripts/lib/ticket-schema.mjs, src/server/board.ts, src/server/index.ts, public/app.js, scripts/board-status.mjs, docs/prompts/RESPONSE_FORMAT.md, the canonical WA and its mirror, docs/bugs/README.md, and a new scripts/verify-bug-259-decide-gate-own.mjs. STOPPED before the build: FEAT-184 is editing board-tool.mjs, board.ts and the decision store. The triage table is also in docs/research/unnecessary-asks-2026-10-14.md, Appendix A. High-stakes bucket: this widens who can clear a card, so an independent clean-room round is owed after the build.

### 2026-10-14 — worker (BUG-259 fixing r1)
- **Built, migrated; independent verify owed:** Built to the reviewed plan (OpenAI 01a13969, MODIFY) and rebased on BUG-256 r3. Independent verify owed. regressed-from: FEAT-166 (decide had no ownership gate).

  GATE. `board-tool decide` now needs `--decider=<code> --consequence='…'`. It is checked by the SAME parser and verdict as the turn-end ask check: format-metrics `deciderOf` plus a new shared export `hardStopDefect`, which `askOwnershipDefects` now also calls. There is no second list or threshold (ARCH-010). Under BUG-256 r3 the value must be exactly one code, and the consequence goes on its own line. The card stores `decision.stop` and `decision.stop_consequence` and shows "Why this is yours". A `--replace` may not change an open card's declared stop. Shape errors are reported before the gate.

  OWN. New verb `board-tool own --basis=recommendation|judgement|criteria(+--ref sc:N)|settled(+--ref)|verify-owed [--chose] --why --author [--next] [--handoff]`. It moves the open decision to decision_history with chosen_by agent, `owned{by,basis,ref,why,next,handoff,prior}` and a FULL snapshot (it mints an id for decisions that had none). Effects: decision null, human_action none, Owner cell unassigned. Record and log land in one locked, rev-checked write (tickets.ts gains the one log composer, composeLogEntry). It writes no answer.
  Refusals: declared stop; a decision the user reopened; answered or adopted; an author that reads as the user; bad key; recommendation≠rec; a bad criteria or settled ref; a staged decision except its first stage; a stale rev.
  Legacy prose cards are handled by a typed log entry plus the Owner cell. `update --owner/--human-action` now refuses to move an open card off the rail. own stays separate from FEAT-184 adopt (adopt writes a typed answer by agent-under-delegation with a receipt).

  REOPEN. `POST /api/projects/:id/tickets/:tid/reopen-decision` is gated by requireUserCaller (src/server/owned-decisions.ts). It is idempotent and rev-bound, and refuses a newer decision or a closed ticket. It restores the snapshot as an open card (`reopened_from`), sets Owner 👤, and logs "Reopened by you".
  UI: the ticket history shows "Decided by an agent, not by you" with why and next, plus a Reopen button (legacy cards too). The digest shows "Agents decided these themselves (last 14 days)", served as board.agentDecided. Shared test helper: rewindOwnedMarkdown.

  Files: scripts/lib/format-metrics.mjs, scripts/lib/ticket-schema.mjs(+.d.mts), scripts/lib/owned-decision.mjs(+.d.mts, new), scripts/board-tool.mjs, src/server/tickets.ts, src/server/owned-decisions.ts (new), src/server/index.ts, public/app.js, public/lib/decide.js, public/lib/ticket-record.js, public/lib/api.js, public/styles.css, docs/bugs/README.md, docs/prompts/RESPONSE_FORMAT.md, the canonical WA §A, its CHANGELOG and the synced mirror. New suites: scripts/verify-bug-259-decide-gate-own.mjs and scripts/verify-bug-259-browser.mjs. Fixture updates: verify-feat-166-{board-tool-decide,typed-answer,typed-answer-browser,decide-card-browser} and verify-feat-184-delegation now pass a decider. verify-board-rank and verify-feat-184 rewind owned cards on their scratch copies, because the real rail is now 4 cards.

  DEMO. Must-FAIL: the suite run against a pre-change snapshot of the tree (/tmp/ny/pre) gives 5 PASS / 37 FAIL. decide wrote a card with no stop; own was an unknown verb; update hid BUG-108 and board:check went red with DECISION NOT ROUTED. After the change: 48/48 on a scratch copy of the real board.
  - The ask check and the card gate agree on 6/6 decider pairs.
  - 9/9 truncation cuts of an owned ticket read neither as a user answer nor as a crash.
  - Browser over a copy of the real migrated board: 14/14. Owned cards are off Needs-You and listed as agent-decided; the history and the Reopen button render; the stop card shows why it is yours; the user's Reopen click restores BUG-121 as a live Decide card; and own is then refused.
  - Screenshots: /tmp/iv-orchard/bug-259/.

  Anti-regression:
  - passing: verify-bug-256 103/103, feat-166-board-tool-decide 62/62, feat-166-typed-answer 37/37, feat-166-decide-card-browser 9/9, feat-184-delegation 56/56, ticket-schema 64/64, feat-137-138 19/19, feat-084 37/37, wa-injected 10/10, feat-149 9/9;
  - identical to the pre-change baseline: board-rank (1 pre-existing fail), board-tool (1), migrate-tickets, feat-166-answer-binding, ticket-view-redesign, feat-090 answered-lane / answer-handoff;
  - feat-097: refused by the git guard in this environment.
  npm run board:check OK; npm run gate PASS.

  MIGRATION (real board). own was applied to 19 cards, each through the CLI, which re-read and rev-checked it:
  - ARCH-013 C, ARCH-019 A, ARCH-021 settled (ref BUG-240, no new choice invented), ARCH-023 A;
  - BUG-048 A (stage 1; stage 2 is re-declared only after its design is shown), BUG-104 2, BUG-115 A, BUG-121 B, BUG-140 C, BUG-236 B;
  - FEAT-082 C, FEAT-088 C, FEAT-087 A (criteria sc:1), FEAT-092 B (criteria sc:0), FEAT-030 A, FEAT-033 A;
  - FEAT-049 A (hand-off kept: you run the publish);
  - FEAT-124 verify-owed (hand-off kept: the git step after the verify), FEAT-135 verify-owed.
  FEAT-086 had no decision record (a bare 👤 row). It was taken off the rail with a typed `Decided by agent (own)` log entry plus the Owner cell; you can put it back with Mark 👤.

  The rail went from 24 to 4: BUG-108, BUG-116, FEAT-178 and FEAT-182 stay with you. board:status counts 8 👤 cells. The other 4 are FEAT-023 (answered, awaiting) and BUG-240, FEAT-164 and FEAT-170: those are answered and acted on, but board:check requires 👤 while their record says human_action decide, so their Owner cell stays.

  IMPLIED WORK (not built):
  - builds: ARCH-013 C, ARCH-023 A, BUG-048 A, BUG-104 2+1 with guard 4, BUG-115 A, BUG-121 B, BUG-140 C, BUG-236 B (allowlist in the same change), FEAT-082 C, FEAT-086 rendered view, FEAT-087 A, FEAT-088 C, FEAT-092 B;
  - close: FEAT-033;
  - independent verify: FEAT-124 (then its git hand-off), FEAT-135;
  - no work: ARCH-019, ARCH-021 (only noting the priced residual), FEAT-030, FEAT-049 (your publish).

  NOT done or NOT verified:
  - The reopen route is code only until the service restarts. A restart is a live step and yours; until then the Reopen button on 4317 returns 404.
  - The agent-caller 403 on reopen is checked statically (gate precedes write). It cannot be shown live from a lane, because a scratch server classifies callers against its own sessions.
  - The 4 user cards were declared before the gate and carry no stop. `own` would accept them mechanically: a residual. The fix is to re-declare each with its stop, or to refuse own on cards with no stop that sat on the rail before 2026-10-14.
  - BUG-256 r3 parser behaviour is that lane's; this gate only consumes it.
  - High-stakes bucket (it widens who clears a card; the session/board path has regression history): an independent clean-room verify is warranted.

### 2026-10-14 — verify lane (BUG-259 r1; Claude fallback, OpenAI quota)
- **Verification recorded:** dispatch anthropic/default run f7bf735d-8846-4886-b12b-c23374ee4f82 — VERDICT: BROKEN — mixed-state candidate e42d200234f4 — Mixed-state; room-guard PASS; OpenAI->Claude fallback. BROKEN: [HIGH] own's INDEX-flip+genBoard unlocked->concurrent own left cards owned AND on rail; [MED] gate bypass (direct record; owner route w/o requireUserCaller); FEAT-086 log-only unreopenable. Two-break->design review; ARCH-021 mis-owned.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-14 — verify lane (BUG-259 r1; Claude fallback, OpenAI quota)
- **Independent clean-room verify (r1) — BROKEN:** Commissioned the independent clean-room verify the ticket owed. VERDICT: BROKEN (manifest-backed, contract VALID). Not closed — back to fixing.

  CANDIDATE METHOD: dependency-inclusive MIXED-STATE freeze (candidate e42d200234f4…, base 1a68e57b, verify_mode mixed-state), NOT a decorrelated lone-ticket candidate. BUG-259's files carry other open tickets' uncommitted hunks and index.ts cross-imports their scaffolding, so a partial 3-ticket overlay would not boot (false BROKEN); mixed-state freezes BUG-259's files as they sit, uses the whole tree as the room (so the server boots and the deps BUG-256 r3 + FEAT-184 are present), discloses the 46 foreign hunks by owning ticket, binds the verdict to the content hash. Room-guard PASS: the exported room's server booted (reopen route returned 200), board.ts/tickets.ts/owned-decisions.ts/delegations.ts all load, no raw line separators. Decorrelation withholding verified in an earlier room: BUG-259's own ticket + docs/research/ were absent, the other tickets present (the final run re-included BUG-259's ticket, fenced "present only so the author floor runs; not truth", so the 48-check floor could execute; migration audit (c) was re-derived independently regardless).

  PROVIDER: OpenAI requested (cross-provider). First OpenAI attempt crashed on the codex import path (dispatch.mjs→codex-runtime→board.ts) while the LIVE board.ts still held a raw U+2028/U+2029 in FEAT-184's composeAdoptionEntry regex (a real FEAT-184 parse break, since fixed by a lane at 12:25:14 → raw→escaped; board.ts now imports fine). The re-run got past that but hit OpenAI 5h quota exhaustion (reset ~15:15) → fell back to a separate Claude dispatch (anthropic/default, run f7bf735d-8846-4886-b12b-c23374ee4f82). Same-provider as the author default → decorrelation REDUCED, structural independence preserved (separate process, fresh context, board/methodology stripped, no fixer report). A true cross-provider OpenAI pass after the reset is WARRANTED (high-stakes: decision-lifecycle/ownership + concurrency).

  AUTHOR FLOOR: scripts/verify-bug-259-decide-gate-own.mjs 47/48 in the room (the 1 FAIL = board:check orphan INDEX rows for FEAT-162/186/187/188/BUG-260, tickets other lanes filed after the allow-list was built; the unmodified board fails identically → not a BUG-259 defect). Live-tree floor is 48/48.

  BREAKS (all over the valid, booting tree):
  1. [d — HIGH] Concurrency lost-update race. In board-tool.mjs verbOwn, only the ticket-file write is inside withTicketLock; setBoardOwner (INDEX Owner-cell flip) and genBoard (full INDEX.md regen) run OUTSIDE the lock. Two concurrent `own` on DIFFERENT cards race the shared INDEX.md read-modify-write; the verifier left FEAT-033, FEAT-049, FEAT-082 BOTH owned in their record AND still on the Needs-You rail — the exact state the requirement forbids. ORCHESTRATOR RE-CONFIRMED against the live tree (lock scope read directly in verbOwn).
  2. [a — MED] Gate bypass by direct record write. A direct ticket-record write lands a decision with an off-list stop (e.g. "priority") or no stop on the rail; validateTicket checks only shape and board:check flags neither. The decider gate lives only in board-tool decide, not in record validation.
  3. [a/b — MED] Unguarded server owner route. POST tickets/:id/owner {needsYou:false} (index.ts ~:1884, tickets.setNeedsYou) has NO requireUserCaller and no open-decision check — hid BUG-108's OPEN USER decision from the rail over HTTP with no owned record. The `update` CLI path was hardened against this exact hiding move (open-decision refusal); the HTTP sibling was missed. ORCHESTRATOR RE-CONFIRMED against the live tree (route at index.ts:1883-1886 has no guard, unlike its reopen-decision/answer siblings).
  4. [b — MED] FEAT-086 migrated log-only. Owned with just a "Decided by agent (own)" log line and an Owner-cell flip, no typed `owned` record/snapshot → absent from the "Agents decided" digest, reopenOwnedDecision 404s, so the user has NO Reopen button. FEAT-124 and FEAT-135 (legacy prose) are likewise missing from "Agents decided".
  5. [b — LOW] Reopen fidelity. After the user reopens, an agent can `decide --replace` with a new question/options; reopened_from is dropped and the stop-change guard does not fire, so the user's original reopened question (BUG-121) leaves the rail.

  TWO-BREAK (standing rule, raised by the verifier): the property "an agent decision cannot leave the rail without a typed owned record" broke via two paths — the unguarded owner route (#3) and the log-only FEAT-086 (#4) → route to INDEPENDENT DESIGN REVIEW, not another point guard.

  MIGRATION AUDIT (attack c, independently re-derived — NOT from the triage table):
  - ARCH-021 — MIS-CLASSIFIED (strongest, new). Owned basis=settled citing BUG-240, no option chosen; but BUG-240 answered a DIFFERENT question (Docker host-root). ARCH-021 recommends D and its sc:0 demands "no agent git-write reaches the repo ungated" — dropping git-write enforcement sets what agents may do under the user's git rule → direction/git, the USER's call.
  - FEAT-087 — plausibly mis-classified. Owned on criteria sc:1 (which presupposes option A); renaming ticket headings the user reads daily is a taste call.
  - The other 18 agent-owned cards hold. The 4 user-owned (FEAT-178, FEAT-182, BUG-116, BUG-108) are acceptable but none declares a HARD_STOPS code (a residual the fixer already flagged).

  HELD: gate requires exactly one HARD_STOPS code (16 malformed/unicode/joined/duplicate --decider variants refused; one NBSP-padded value stored as "live" — low-risk, worth a look); a single shared HARD_STOPS list (no second copy); all `own` refusals (bad-author, non-recommendation, bad-ref, answered, stale-rev, legacy) correct; reopen idempotent and user-only in the route (static); concurrency on the SAME card serializes (one writer wins, others 409).

  COULD-NOT-TEST (follow-up queue): real agent-session caller refusal on the reopen/answer routes (a scratch server classifies the verifier as the user — agent/user cgroup split out of budget; only static requireUserCaller-precedes-write confirmed); `own` racing the server's user-answer route; an independent CDP browser probe (the verifier wrote its own HTTP probe rather than count the fixer's browser suite).

  ARTIFACTS (scratch; /tmp wiped on boot): verdict /tmp/bug259-iv/verdict-rerun3-anthropic.json; log /tmp/bug259-iv/rerun3-anthropic.log; requirement+attacks /tmp/bug259-iv/requirement.txt; kept clean rooms under claude-station scratch (cleanroom-verify-xFl0dG/-EM5pCR, removable).

  NEXT (orchestrator/user decisions): (i) fix round for breaks #1-#5 — #1 is the HIGH one (put setBoardOwner+genBoard inside the ticket lock, or a board-level lock); (ii) the two-break routes the rail-leave-without-typed-record design to independent design review; (iii) user/orchestrator review of ARCH-021 (likely the user's) and FEAT-087; (iv) a true cross-provider OpenAI pass after the quota reset. Service restart still owed to make the reopen route live.
