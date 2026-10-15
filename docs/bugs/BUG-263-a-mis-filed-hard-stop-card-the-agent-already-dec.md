```orchard-ticket
{
  "id": "BUG-263",
  "type": "bug",
  "title": "A mis-filed hard-stop card the agent already decided has no take-back",
  "summary": "An agent filed a decide card on FEAT-190, then realised the decision was its own call, already built, with neither option matching what shipped. No board-tool verb could take the card back: own refuses a hard-stop card, decide --replace only swaps the question, update hides it, answer routes refuse agents.",
  "impact_if_we_wait": "Every mis-filed hard-stop card sits on the Needs-You rail with options that do not match what was built, and the only ways to clear it are dishonest: hide it, or write an answer the board records as the user's. WA §A requires the agent's decision recorded as the agent's.",
  "current_need": "A withdraw verb that records the agent's decision as its own (never a user answer), closes the card, and leaves the user a one-click reopen; applied to FEAT-190's P3 card; independent verify that it cannot mimic a user answer.",
  "severity": "medium",
  "area": "board decisions",
  "reported": "2026-10-15",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-15",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "board-tool withdraw closes an unanswered hard-stop card, records a typed agent decision in decision_history, and writes no user answer.",
    "withdraw is refused once the user has answered, adopted, or reopened the decision.",
    "A hand-written by:user answer is still rejected by board:check; the user can reopen a withdrawn decision and the card comes back intact.",
    "FEAT-190's P3 card is withdrawn and board:status reads its real state, not NEEDS A HUMAN DECISION."
  ],
  "code_refs": [
    {
      "path": "scripts/board-tool.mjs"
    },
    {
      "path": "scripts/lib/owned-decision.mjs"
    },
    {
      "path": "scripts/lib/ticket-schema.mjs"
    },
    {
      "path": "public/app.js"
    }
  ],
  "related": [
    {
      "id": "BUG-259",
      "relation": "see_also"
    },
    {
      "id": "FEAT-166",
      "relation": "see_also"
    },
    {
      "id": "FEAT-184",
      "relation": "see_also"
    },
    {
      "id": "BUG-258",
      "relation": "see_also"
    },
    {
      "id": "FEAT-190",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "742a2a6f-c13c-4576-8ce4-75f529e5a6cf",
      "verdict": "broken",
      "verdict_on": "2026-10-15",
      "recorded_at": "2026-10-15T08:52:23.312Z",
      "author": "verify lane (BUG-263 r1, anthropic clean-room)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "50d83da5e6a16a61945063f4d52731fb14dd15a9227240ed6708b4ed98396bb2",
      "verify_mode": "mixed-state",
      "note": "Reopen laundered: user reopens, agent decide --replace drops reopened_from, withdraw guard then no longer fires and closes the user's reopened card. Root = BUG-259 #5 decide-replace drops reopened_from."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "bc5e7944-37d3-4886-8ce0-3254fed84e83",
      "verdict": "broken",
      "verdict_on": "2026-10-15",
      "recorded_at": "2026-10-15T09:00:28.970Z",
      "author": "verify lane (BUG-263 r2, anthropic clean-room)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "090952447890b33481fe64aef71c418f0a6a59dfcdbf751d00faeb6129ad95e5",
      "verify_mode": "mixed-state",
      "note": "Fail-open: ticketAnswerState returns null when the seal store is damaged/key-unreadable, so withdraw closed a card with a genuine sealed by:user answer and erased it. Refuse on presence of any decision.answers by:user/adoption, fail-closed."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "3f89cc40-1d51-4381-8160-16e56186bbb1",
      "verdict": "broken",
      "verdict_on": "2026-10-15",
      "recorded_at": "2026-10-15T09:14:49.780Z",
      "author": "verify lane (BUG-263 r3, anthropic clean-room)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "c7e3f025692cf740124eb43e66a64d7374c64e02a08aef45a76f71ece14dfa1a",
      "verify_mode": "mixed-state",
      "note": "Resurrection: decide then withdraw on a legacy ticket (ARCH-010/011/007/004) sets decision:null, re-binding a pre-r3 frozen answer keyed none. Fix: heading guard now also fires on id-less legacy answer headings."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "ffea1ef9-4f11-419f-ada5-e9d7e3be67af",
      "verdict": "holds",
      "verdict_on": "2026-10-15",
      "recorded_at": "2026-10-15T09:20:09.624Z",
      "author": "verify lane (BUG-263 r4, anthropic clean-room)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "f6df1ae1d6c34372ae21c09acda86466df897d06349cf61eeb134df169d2bb9c",
      "verify_mode": "mixed-state",
      "note": "HOLDS: swept all 16 record tickets with any answer trace (6 withdrawn unanswered, 9 refused answered, 0 broken); schema fuzz of owned/withdrawn entries all correct. Launder+erase+resurrect class closed."
    }
  ],
  "verification_class": "fix",
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

# BUG-263 — A mis-filed hard-stop card the agent already decided has no take-back

## Diagnosis

regressed-from: BUG-259. BUG-259 built `own` as the honest take-back for a card that was never the user's, but `own` refuses a card that declares a hard stop (`decision.stop`) — that card was filed as the user's, so only the user clears it. There was no path for the remaining case: a lane files a HARD-STOP card, then realises the decision was its own call, already made and built, with neither option matching what shipped. `decide --replace` only swaps the question (and may not change the stop); `update --owner`/`--human-action` refuses to move a ticket with an open decision off the rail; the server answer routes refuse an agent caller (BUG-258, 403 agent-not-user). The gap is a missing verb, not a deliberate refusal: BUG-259's design made the user's one-click Reopen the safety valve for an agent-taken decision, and `withdraw` uses that same valve.

## Evidence

FEAT-190's P3 card (decision id c8f63ae8…, stop: git): "Legacy blank-scope git-write records still derive RELEASE mode — keep r1 migration-safety or force-migrate?". The r14 clean-room IV (run 4b6dba7a) came back HOLDS, but `board-tool verified` refused to record it because a live `decision` was still present ("a finished ticket's decisions belong in decision_history"). Neither card option matched what was built: legacy blank-scope grants are READ as granted (scoped), never release, with release only from the new explicit opt-in. The card was the agent's own call, filed as the user's.

## Implementation notes

`board-tool withdraw --id <T> --reason "…" --decided "what shipped" --author "…"`. It is allowed ONLY while the card has no user answer (`ticketAnswerState` is the one reader of answered-state, FEAT-166 r3; an answered/adopted/reopened decision is refused). It reuses the BUG-259 owned-decision machinery so no parallel UI/reopen/status/check code is needed: it writes a `decision_history` entry with `chosen_by: 'agent'` and `owned.basis: 'withdrawn'`, carrying the reason (`owned.why`), what was decided (`owned.decided`), and a full `snapshot` of the withdrawn card (its question + options). The decision is closed (`decision: null`), the Owner cell leaves 👤, `human_action` → none, and `work_state` blocked → open. The existing server reopen route (user-only) restores the card from the snapshot; the ticket-view "Decisions already made" card shows "Withdrawn by an agent, not answered by you" with the reason, what was decided, and a Reopen button. It writes NO user answer — `board:check` still FAILs a hand-written `by:user` entry with no sealed receipt. `board:status` then reads the ticket's real state, not "NEEDS A HUMAN DECISION".

## Verification plan

`scripts/verify-bug-263-withdraw.mjs`, each case a must-FAIL against a pre-change tree (the verb absent → unknown-verb): withdraw an unanswered hard-stop card (FEAT-190's real P3) → card closed, typed agent-decision recorded, no user answer created; reopen restores the card from its snapshot; withdraw refused on the real answered cards (FEAT-164/FEAT-170/BUG-240); a forged `by:user` answer still rejected by `board:check`; field refusals. Anti-regressions: verify-bug-259 48/48, ticket-schema 64/64, feat-166-board-tool-decide 62/62, feat-166-typed-answer 37/37, feat-184-delegation 56/56.

## Risks

It widens who clears a card (decision-lifecycle, regression-prone files), so it is in the high-stakes bucket and gets an independent clean-room verify chartered on "can withdraw ever produce or mimic a user answer, or close a user-answered card". Residual (shared with BUG-259, unfixed there): `own`/`withdraw`'s `setBoardOwner`+`genBoard` run outside the per-ticket lock, so two concurrent take-backs on different cards can race INDEX.md (BUG-259 break #1).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-15 — worker (BUG-263 fixing r1)
- **Built withdraw; applied to FEAT-190:** Hypothesis CHECKED FIRST and CONFIRMED: the gap is a missing verb, not a deliberate refusal. BUG-259/owned-decision.mjs states own refuses a hard-stop card because it was filed as the user's; nothing anywhere forbids an agent taking back a card it mis-filed. BUG-259 made the user's one-click Reopen the safety valve for an agent-taken decision, and withdraw reuses that same valve, so the user's authority is preserved and the stop is not laundered into an easier class. BUILT board-tool withdraw (scripts/board-tool.mjs verbWithdraw; withdrawRefusal/withdrawRecord/WITHDRAW_BASIS in scripts/lib/owned-decision.mjs; OWNED_BASES + owned.decided check in scripts/lib/ticket-schema.mjs; o.decided render in public/app.js). It reuses the BUG-259 owned-decision reopen/UI/board:status/board:check machinery. VERIFIED scripts/verify-bug-263-withdraw.mjs 18/18 on a scratch copy of the real board; must-FAIL on a pre-change tree (verb stripped) 4/18, every withdraw-CLI case unknown-verb. Anti-regressions: verify-bug-259 48/48, verify-ticket-schema 64/64, verify-feat-166-board-tool-decide 62/62, verify-feat-166-typed-answer 37/37, verify-feat-184-delegation 56/56. APPLIED to FEAT-190's real P3 card (stop:git) with the orchestrator's values; then recorded the r14 HOLDS (run 4b6dba7a) so board:status -- FEAT-190 reads VERIFIED. HIGH-STAKES (decision-lifecycle): independent clean-room verify owed. Shared residual with BUG-259 #1: setBoardOwner+genBoard outside the per-ticket lock.

### 2026-10-15 — verify lane (BUG-263 r1, anthropic clean-room)
- **Verification recorded:** dispatch anthropic run 742a2a6f-c13c-4576-8ce4-75f529e5a6cf — VERDICT: BROKEN — mixed-state candidate 50d83da5e6a1 — Reopen laundered: user reopens, agent decide --replace drops reopened_from, withdraw guard then no longer fires and closes the user's reopened card. Root = BUG-259 #5 decide-replace drops reopened_from.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-15 — verify lane (BUG-263 r2, anthropic clean-room)
- **Verification recorded:** dispatch anthropic run bc5e7944-37d3-4886-8ce0-3254fed84e83 — VERDICT: BROKEN — mixed-state candidate 090952447890 — Fail-open: ticketAnswerState returns null when the seal store is damaged/key-unreadable, so withdraw closed a card with a genuine sealed by:user answer and erased it. Refuse on presence of any decision.answers by:user/adoption, fail-closed.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-15 — verify lane (BUG-263 r3, anthropic clean-room)
- **Verification recorded:** dispatch anthropic run 3f89cc40-1d51-4381-8160-16e56186bbb1 — VERDICT: BROKEN — mixed-state candidate c7e3f025692c — Resurrection: decide then withdraw on a legacy ticket (ARCH-010/011/007/004) sets decision:null, re-binding a pre-r3 frozen answer keyed none. Fix: heading guard now also fires on id-less legacy answer headings.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-15 — verify lane (BUG-263 r4, anthropic clean-room)
- **Verification recorded:** dispatch anthropic run ffea1ef9-4f11-419f-ada5-e9d7e3be67af — VERDICT: HOLDS — mixed-state candidate f6df1ae1d6c3 — HOLDS: swept all 16 record tickets with any answer trace (6 withdrawn unanswered, 9 refused answered, 0 broken); schema fuzz of owned/withdrawn entries all correct. Launder+erase+resurrect class closed.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-15 — worker (BUG-263 fixing r1→verified)
- **Verify→fix loop closed; HOLDS:** Independent clean-room verify (anthropic, chartered on 'can withdraw produce/mimic a user answer or close a user-answered card') found THREE real breaks in one class, each fixed and covered by a new must-FAIL test: (r1 run 742a2a6f) reopen-launder — user reopens, agent decide --replace dropped reopened_from, withdraw guard then no longer fired; FIX: verbDecide carries reopened_from across an unanswered --replace (root = BUG-259 #5). (r2 run bc5e7944) fail-OPEN on a damaged/key-unreadable FEAT-184 seal store — ticketAnswerState returns null, withdraw closed a card with a genuine sealed by:user answer and erased it; FIX: withdrawRefusal refuses on presence of any decision.answers by:user/adoption. (r3 run 3f89cc40) resurrection — decide+withdraw on a legacy ticket (ARCH-010/011/007/004) set decision:null, re-binding a pre-r3 frozen answer keyed none; FIX: verbWithdraw refuses on any user-answer Activity-log heading bound to the current decision OR id-less legacy (headings live in the ticket markdown, tamper-proof, and every answer writes one). Final IV run ffea1ef9 HOLDS (VALID): swept all 16 record tickets with any answer trace — 6 withdrawn unanswered, 9 refused answered, 0 broken — plus owned/withdrawn schema fuzz. verify-bug-263-withdraw.mjs now 23/23; must-FAIL 15/23 on a pre-change tree; gate PASS. Symptom of a deeper design flaw? yes → the fail-open-on-unverifiable-source class is shared with any decision-lifecycle writer that sets decision:null (own too); tracked as an extension of BUG-259. Shared residual (unfixed, BUG-259 #1): setBoardOwner+genBoard run outside the per-ticket lock.
