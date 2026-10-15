```orchard-ticket
{
  "id": "BUG-257",
  "type": "bug",
  "title": "Answering a decision card did not start the work; sessions asked again",
  "summary": "When you answered a decision card, the next session briefing told the agent to report the decision and ask you before beginning. So a choice you had already made came back to you as another question. The design question behind this, whether an answer should start the work or wait for a go, was never answered.",
  "impact_if_we_wait": "Each answered card costs an extra round trip before any work starts. It also teaches sessions that even a decided item needs another go.",
  "current_need": "An independent check that both briefings carry the pick plus every user note verbatim under a 'note governs' rule, that same-day follow-ups, overflow answers and follow-ups on adoptions reach an open session, and that nothing starts a turn.",
  "severity": "medium",
  "area": "board briefing",
  "reported": "2026-10-14",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-10-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The launch snapshot and the live answer briefing both say a picked option authorises its scoped work, to be reported as started.",
    "Both say that an answer that is a question, a rejection or an explicit wait is not a go.",
    "No turn is started by the server; the briefing still rides the user's next message (FEAT-090's no-auto-dispatch property)."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-090",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a13969-b77e-77d3-9360-b8138667cd2a",
      "verdict": "broken",
      "verdict_on": "2026-10-14",
      "recorded_at": "2026-10-14T08:04:20.374Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Independent OpenAI clean-room; untangled HEAD+BUG-257 own-edits candidate (board.ts wording). Contract VALID, manifest-backed. BROKEN property b, TWO-BREAK to design review: a wait/reject note on a picked option renders as a plain go (dropped or truncated at 60 chars). Detail in Activity log."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "8c15031e-845c-40c2-b57f-03020bb1b380",
      "verdict": "broken",
      "verdict_on": "2026-10-14",
      "recorded_at": "2026-10-14T08:37:46.609Z",
      "author": "verify lane (verifying r2)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "f8e7f81482f930030ad3084cd4aab9621acc273c99c0f820a2b687ba288a6151",
      "verify_mode": "mixed-state",
      "note": "r2 clean-room re-verify, mixed candidate. Contract VALID, manifest-backed. BROKEN: NEW path — agent-bridge adopt-launch seeds seen-set w/5 keys while snapshot=null, so up to 5 answered decisions reach NEITHER briefing [HIGH silent loss]. TWO-BREAK design review. Render HELD. See log."
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

# BUG-257 — Answering a decision card did not start the work; sessions asked again

## Diagnosis

`src/server/board.ts` injected 'These are DECIDED but NOT dispatched. Do not start work on them silently: report each decision to the user and ask before you begin.' The live `[station]` briefing said the same. FEAT-090's own decision ('After answering, should work start immediately, or wait as ready-to-proceed until you say go?') sits in decision_history with no answer. The text a builder wrote as a default became an instruction to ask.

## Evidence

The `awaiting your go` notice appears 35 times across orchestrator transcripts. In the 2026-10-14 ask study (docs/research/unnecessary-asks-2026-10-14.md), the OpenAI refutation run 01a13949 ranked this change first by asks removed per risk, with one change: 'actionable affirmative answers authorize their scoped action; questions/rejections remain unresolved; explicit wait instructions prevail'.

## Implementation notes

The wording in `boardStateSection` and `boardAnswerBriefing` is replaced. No server behaviour changes: nothing starts a turn. The FEAT-090 suites' wording assertions now check the new instruction.

## Verification plan

`npm run verify:feat-090` (the answered-lane suite) and `scripts/verify-feat-090-answer-handoff.mjs` must pass with the new wording.

## Risks

An answer with a note that adds conditions could be read as a plain go. The briefing tells the agent to honour the note.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-14 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-14 — finding lane (round 1)
- **Built; independent verify owed:** Changed src/server/board.ts: the launch board snapshot (boardStateSection) and the live [station] briefing (boardAnswerBriefing) now say a picked option is the user's go — start that option's scoped work and report it as started; a question, a rejection or an explicit wait is not a go. No server behaviour changed (nothing starts a turn; it still rides the user's next message). Refuted cross-provider: OpenAI run 01a13949-5094-7161-bdee-4954fda87510 ranked this first by asks removed per risk, MODIFY (questions/rejections/explicit waits stay unresolved) — applied. Tests: scripts/verify-feat-090-answered-lane.mjs and scripts/verify-feat-090-answer-handoff.mjs wording assertions rewritten first and shown failing on the old text (lane: snapshot-instruction + overfull checks FAIL; handoff: briefing check FAIL), then passing after the change. Results after: answered-lane 25/26, answer-handoff 29/31 — the remaining failures ('answered section placed BEFORE needs-you', 'PRECONDITION: a live session is open', '(WIDE) Decide card in view') fail identically on a pristine HEAD export, so they are pre-existing. Also green: verify-feat-090-followup 28/28, verify-feat-082-digest 52/52, verify-bug-168 10/10, verify-feat-113 11/11, verify-wa-injected 10/10, verify-feat-166-typed-answer 37/37. npm run gate PASS. Analysis: docs/research/unnecessary-asks-2026-10-14.md. Session-briefing path (FEAT-090 history): an independent verify is warranted.

### 2026-10-14 — dispatch openai
- **Verification recorded:** dispatch openai run 01a13969-b77e-77d3-9360-b8138667cd2a — VERDICT: BROKEN — Independent OpenAI clean-room; untangled HEAD+BUG-257 own-edits candidate (board.ts wording). Contract VALID, manifest-backed. BROKEN property b, TWO-BREAK to design review: a wait/reject note on a picked option renders as a plain go (dropped or truncated at 60 chars). Detail in Activity log.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-14 — verify lane (verifying r1, independent clean-room → BROKEN)
- **Independent OpenAI clean-room verify of an untangled HEAD+BUG-257 own-edits-only candidate; VERDICT BROKEN (two-break → design review):** The working tree was a multi-ticket blend; board.ts carried BUG-257's two wording hunks PLUS a FEAT-175 grantRebuild field. A decorrelated BUG-257-only candidate was built: `git archive HEAD` into /tmp/cand-bug257, then ONLY BUG-257's two wording hunks applied to boardStateSection + boardAnswerBriefing (the FEAT-175 grantRebuild hunk deliberately NOT applied), plus the two feat-090 verify-script edits; two-commit scratch repo (baseline=pristine HEAD, HEAD=candidate), range HEAD~1..HEAD. No real-repo git writes (throwaway /tmp fixture, real binary). Candidate smoke-ran before dispatch: verify-feat-090-answered-lane 25/26, verify-feat-090-answer-handoff 29/31 (the 3 residual failures fail identically on pristine HEAD — environmental: live session / wide browser — confirmed pre-existing).
- Dispatch: `scripts/independent-verify.mjs --provider openai`, run 01a13969-b77e-77d3-9360-b8138667cd2a. Contract VALID (manifest-backed; adversarial cases option-with-qualifying-note, truncated-wait, stale-and-replay-controls). NOTE: two earlier dispatches of this same candidate returned contract-INVALID purely because the OpenAI verifier emitted two `FIXER-TEST:` citation lines (I had passed two --test-file suites; the citation contract allows exactly one). Re-dispatched with a single suite → well-formed VALID verdict. The findings were identical across all three runs.
- BREAK — property (b), TWO-BREAK → design review: a PICKED option that carries a non-go qualification is briefed as an unconditional go in BOTH surfaces (launch snapshot + live [station] briefing), via two independent paths: (1) a structured option plus a wait/hold/rejection/question/conditional note — the note is dropped, only the picked option + "start it" instruction remain; (2) a free-text answer whose explicit WAIT falls past the briefing's 60-character answer truncation — the restriction survives in board data but is cut from both briefings, so "CSV" and "CSV; not yet, wait for my approval" produce identical briefings. The requirement's property 2 ("a question, a rejection, or an explicit wait is NOT a go") therefore fails for any non-go instruction attached to a picked option. Per the standing two-break clause, routed to independent DESIGN REVIEW rather than another guard patch.
- HOLDS within the attack: property (c) — stale/seen answers, snapshot-seeded answers, changed decision keys and untyped legacy prose do NOT re-announce (verifier control run PASS). Property (a) — a plain affirmative renders the go/start instruction on both surfaces (control PASS). No server auto-dispatch was introduced (wording-only change).
- UNTESTED (verifier-flagged): baseline must-FAIL could not run in-room (the clean room is a non-git working copy); the fixer suites partially stopped in-room on a stripped docs/bugs dir and a missing `ws` dep, so the live no-auto-dispatch and browser (WIDE) paths and the actual frozen/pinned legacy answers were not exercised — the verifier instead imported boardStateSection/boardAnswerBriefing directly in its own adversarial harness.
- Verdict recorded in verification[] (openai, run 01a13969…, BROKEN). Ticket stays open; two-break → independent design review of whether a per-answer note must be carried verbatim (untruncated) into both briefings with explicit non-go gating, rather than the current render dropping/truncating it.

### 2026-10-14 — design-review lane
- **fixing r2:** **Design review (non-author, WA §N) → REDESIGN of the answer render (structure, not note parsing); built; independent verify owed.** regressed-from: FEAT-090 (its lane text was the entry's first body line, cut at 60 chars; r1 of this ticket changed only the wording and was BROKEN, run 01a13969).
  - DECISION: the picked option is the go, and every word the USER wrote on the decision travels with it, verbatim and untruncated, in BOTH briefings: the anchor's note or free text, then each follow-up. A rule tells the agent the note governs over the pick: a wait, an unmet condition, a rejection or a question means do NOT start. The agent (an LLM) interprets the note; the server parses nothing.
  - Why KEEP-PATCHING (parse notes for wait/no/hold) loses: enumeration over free prose that any phrasing evades. A miss silently starts work the user held.
  - Explicit "not yet" control: DECLINED this round. The card already has structural non-go channels (Ask a question, Counter: ownership flips to the agent, never in the answered lane). A hold kind would add a fourth reply kind across answer-source, tickets.ts, board.ts, decide.js and the route, two of them under concurrent edit, for a case the verbatim note now carries. Follow-up candidate if an audit shows a wait-note started anyway.
  - Plan review (cross-provider): OpenAI run 01a13974-b46f-7342-85b1-29b7afe9fcf7, PLAN-VERDICT MODIFY. Applied: (1) the live-briefing dedup key was id@date, so a SAME-DAY follow-up ("hold off") after a briefed pick was suppressed; it is now the latest typed answer_id; (2) a user follow-up on an ADOPTED decision is now briefed, with the adoption still named; (3) the launch seen-set was seeded with ALL answered keys while the snapshot shows 5, so overflow was never delivered; answeredAwaitingKeys now seeds only the shown items; (4) a legacy frozen answer is rendered whole and labelled possibly partial, never as a pick; (5) a behavioural check was added (below). Declined: the rail's 80-char "you chose" echo in public/app.js, which is the user's own echo; the ticket card already shows notes and follow-ups, and app.js is under BUG-255's lane. Note length is uncapped (budget limitation, documented; the answered section is already exempt from the snapshot's char cap).
  - Also fixed on the way: with an echoed question the "pick" shown was the `**Question:**` line (seen on the real board copy: `chose: **Question:** How does an adversarial…`).
  - Changed: src/server/board.ts only (bounded hunks: BoardItem answerChose/answerNotes/answerLegacy/answerRev; AnswerEntry fields; readBoard copies them; answerEntries builds them; new ANSWERED_GO_RULE, SNAPSHOT_MAX_ITEMS, answeredItemLines; boardStateSection answered section; answerKey, answeredAwaitingKeys(maxItems), boardAnswerBriefing). Tests: new scripts/verify-bug-257-answer-note-travels.mjs; wording assertions in scripts/verify-feat-090-answered-lane.mjs and scripts/verify-feat-090-answer-handoff.mjs. src/server/agent-bridge.ts untouched (its seeding call picks up the new cap by default).
  - Must-FAIL: the new suite on a COPY OF THE REAL BOARD (20+ live decisions plus the real FEAT-023 answer, which is itself a question), answered through the real writer (answerTicket, recordAdoption + sealed receipt), scratch data dir: r1 tree 22 FAIL / 3 PASS → 25/25 PASS. Covers wait / reject / condition / question / multi-line notes, a 170-char free-text answer ending "wait for my approval", a plain-pick control, a same-day follow-up, overflow past the cap, adopt then user follow-up, and the real FEAT-023 answer.
  - Behavioural check (n=1, a fresh Claude Sonnet agent given only the rendered live briefing for 10 tickets): 10/10 correct. HOLD on wait, reject, condition, question, "not before Friday", free-text "not yet", and the FEAT-023 question; START on a plain pick, a "go ahead" note and a free-text "do option C".
  - Anti-regression: verify-feat-090-answered-lane 25/26 and verify-feat-090-answer-handoff 30/31, where the remaining failures ('answered section placed BEFORE needs-you', 'PRECONDITION: a live session is open') are the same pre-existing ones r1 recorded on a pristine HEAD; the MUST-FAIL no-auto-dispatch proof PASSES, so nothing starts a turn. verify-feat-090-followup, verify-feat-082-digest, verify-bug-168, verify-feat-113, verify-wa-injected and verify-feat-166-typed-answer exit 0; verify-feat-184-delegation 56/56. npm run gate PASS.
  - AMENDED success criteria (supersede the record's list for verification): (1) both briefings show the picked option itself and every user note/follow-up on that decision verbatim and untruncated; (2) both state that a pick with no note is the go and that a note governs (wait/condition/rejection/question → do not start); (3) a same-day follow-up, an overflow answer, and a user follow-up on an adoption each reach an open session; (4) nothing starts a turn (FEAT-090).
  - NOT verified: a live session acting on the briefing end to end; the behavioural check is one model sample. Session-briefing path (FEAT-090 history): an independent clean-room verify is warranted.

### 2026-10-14 — verify lane (verifying r2)
- **Verification recorded:** dispatch anthropic run 8c15031e-845c-40c2-b57f-03020bb1b380 — VERDICT: BROKEN — mixed-state candidate f8e7f81482f9 — r2 clean-room re-verify, mixed candidate. Contract VALID, manifest-backed. BROKEN: NEW path — agent-bridge adopt-launch seeds seen-set w/5 keys while snapshot=null, so up to 5 answered decisions reach NEITHER briefing [HIGH silent loss]. TWO-BREAK design review. Render HELD. See log.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-14 — verify lane (verifying r2, independent clean-room → BROKEN)
- **independent clean-room re-verify of the r2 REDESIGN contract; VERDICT BROKEN (two-break → design review):** Candidate: MIXED-STATE freeze (harness candidate f8e7f81482f9), NOT clean-decorrelated — HEAD contains none of BUG-257/FEAT-184/FEAT-175 (whole tree uncommitted) and BUG-257 r2's render is interwoven with FEAT-184 inside answerEntries/answeredItemLines/boardAnswerBriefing and depends on it at runtime (the suite calls recordAdoption; the render reads it.adopted). A clean r1-style hand-split would break the suite or strip the adopted-decision attack surface, so the sanctioned mixed freeze was used (whole tree = room, diff scoped to the 4 BUG-257 files, 47433 diff bytes); the requirement disclosed BUG-257 vs FEAT-184(dependency) vs FEAT-175(ignore) hunk attribution. Smoke-run before dispatch: verify-bug-257-answer-note-travels 25/25, verify-feat-090-answered-lane 25/26, verify-feat-090-answer-handoff 30/31 (the two residual fails are the pre-existing environmental ones r1 recorded: answered-section placement, live-session precondition). Dispatch: scripts/independent-verify.mjs, run 8c15031e-845c-40c2-b57f-03020bb1b380; VERDICT-CONTRACT VALID (adversarial cases render-overflow-sameday-adopted-and-atta / same-run-with-record-ticket-adoption-plu; manifest-backed; harness exit 1). PROVIDER: OpenAI attempted first but hit its quota window mid-run (resets ~15:15); switched to Anthropic (Claude Opus) per charter/standing guidance — same-provider, reduced decorrelation, stated honestly; an OpenAI cross-provider re-run is warranted once quota resets. BREAK [HIGH, silent data loss], property (3) note-delivery, NEW path → TWO-BREAK design review: an attached/adopt session launch loses up to 5 answered decisions whole. agent-bridge.ts:1788 sets boardSnapshot=null for opts.adopt, but :1795 still unconditionally seeds #answerBriefSeen with answeredAwaitingKeys(...) (first SNAPSHOT_MAX_ITEMS=5); boardAnswerBriefing then skips those as already-seen, so with 9 answered tickets FEAT-900..904 (incl. their wait/reject notes) reach NEITHER snapshot nor live briefing. This is exactly the design-review lane's explicitly-unchecked assumption ('agent-bridge.ts untouched… picks up the new cap by default') — false for the adopt path, where nothing is shown yet the seen-set is still seeded. r1's break was note-dropped + 60-char-truncation, both inside the render; the render ITSELF HELD here, so this is a distinct new path → two-break, route to independent DESIGN REVIEW, not another guard. Fix surface: agent-bridge.ts adopt-session seeding, which r2 left untouched. HELD within the attack: the render held under every other input — long notes (>700 chars), overflow past 5 items, multi-line/CRLF notes with a fake **Chose:** line, same-day follow-ups, a free-text 'wait' past char 60, a user follow-up on an adopted decision — all arrived verbatim with ANSWERED_GO_RULE on BOTH surfaces; properties (1) and (2) hold, adoption named correctly. UNTESTED (verifier-flagged): the fixer's own suite could not run in-room (docs/bugs stripped as prose → cpSync of the real board ENOENT; --allow-input docs/bugs declined because that board carries BUG-257's own fix rationale), so the real-board cases (FEAT-023, ARCH-013…) were not executed in-room (same limitation r1 recorded); the live adopt-session launch was shown by reading the two exact agent-bridge.ts lines and replaying the call order with a null snapshot, not an end-to-end session; property (4) (nothing starts a turn) checked by code-reading only (boardAnswerBriefing called only from #withBriefing during send); server/fake-codex half of answer-handoff not run; legacy-frozen 'may be partial' label not exercised; a launch-time race (answer landing between boardStateSection and answeredAwaitingKeys reads) not tested. High-stakes bucket (FEAT-090 session-briefing history, now data-loss): this IS the independent clean-room pass; the agent-bridge adopt-seeding break owes an independent DESIGN REVIEW.

### 2026-10-14 — orchestrator (adjudication, non-author)
- **BUG-257 ADJUDICATION:** a new path, adopt-launch seeding the seen-set while snapshot=null, silently loses answered decisions and notes. Decision: keep the r2 design and fix it at the chokepoint. An answer is marked seen ONLY when it has actually been rendered into a delivered briefing. Nothing pre-seeds seen-state, and a null or absent snapshot seeds nothing. Enumerate every place that writes seen-state (`rg`) and route them all through one mark-delivered function. List them in the log.

### 2026-10-14 — fixing lane (round 3, final)
- **fixing r3: one chokepoint for seen-state, marked only on delivery; independent verify owed.** regressed-from: BUG-257 r2 (it left agent-bridge.ts's launch seeding in place, so an adopt launch with a null snapshot still seeded 5 keys; clean room 8c15031e) and FEAT-090 (which introduced the launch seeding).
  - SEEN-STATE WRITE SITES (`rg "answerBriefSeen|seen\.add|answeredAwaitingKeys"`), BEFORE: (1) agent-bridge.ts:1795, a constructor pre-seed `#answerBriefSeen.add(k)` for `answeredAwaitingKeys(...)`, which ran even for adopt; (2) board.ts `boardAnswerBriefing`, `seen.add(answerKey(it))` at render time, before any send (a later attachment refusal, broker refusal or uncertain delivery still left the answer marked). AFTER, there is ONE writer, `markAnswersDelivered(seen, keys)` in board.ts, called from: (a) agent-bridge `#withBriefing`'s `delivered()` closure, the only bridge write; and (b) board.ts `boardAnswerBriefing`, a render-and-deliver wrapper kept for the test suites and not used by the server. `delivered()` is called at 4 sites, each AFTER the runtime hand-off: first turn after `#runtime.start` (adopt: there is no first turn, so nothing), interject after `#runtime.send`, plain send after `#runtime.send`, and gated adopt delivery only on an ACCEPTED broker frame (refused or uncertain marks nothing). `answeredAwaitingKeys` is deleted.
  - board.ts (bounded hunks): `boardStateSnapshot()` returns `{ text, answeredKeys }` from ONE board read, which closes the read race between the snapshot and its keys; `boardStateSection()` wraps it. `answerBriefingFor(hostPath, seen: ReadonlySet)` is pure and returns `{ text, keys }`. `markAnswersDelivered` is the writer. agent-bridge.ts: the launch seeding is removed. `#withBriefing` returns `{ text, delivered }`, and on the first turn it excludes the snapshot's keys from that turn's live briefing (so nothing repeats) while carrying the overflow. Render (r2 design) unchanged.
  - Must-FAIL: I built a full scratch tree with the r2 board.ts and agent-bridge.ts (/tmp/b257r3/tree). verify-bug-257 there: **26 passed / 11 failed**. That includes the reported break reproduced: with the adopt launch replayed as the r2 constructor code does it, 5 answered tickets were lost (ARCH-013, ARCH-021, ARCH-019, ARCH-023, FEAT-049), along with their wait/reject/condition/question notes. The structural chokepoint and deliver-after-send checks also failed there. After the fix: **39/39 PASS** on a copy of the REAL board answered through the real writer: [8] adopt launch, all 10 answered tickets plus notes reach the first live briefing; [9] one writer, deliver-after-handoff at all 4 sites; [10] an undelivered briefing marks nothing, and a fresh launch's first turn carries the snapshot plus overflow with no repeats and nothing after.
  - Anti-regression: verify-feat-090-answered-lane 25/26 and verify-feat-090-answer-handoff (--no-ui) 23/24. The remaining failures ('answered section placed BEFORE needs-you', 'PRECONDITION: a live session is open') are the same pre-existing ones r1 and r2 recorded, and the MUST-FAIL no-auto-dispatch proof PASSES. verify-feat-090-followup 13/13, verify-feat-082-digest 52/52, verify-bug-168 10/10, verify-feat-113 11/11, verify-wa-injected 10/10, verify-feat-166 14/14, verify-feat-184-delegation 56/56, verify-bug-255-r4-structure 21/21. npm run gate PASS (exit 0).
  - NOT verified: a live adopt launch end to end. Real-server session starts currently fail "no start ack" in this tree, identically on the r2 bridge (verify-bug-077 on a full r2 scratch copy), so this is environmental and not this change. The adopt path is therefore proven by the structural checks plus a replay of the constructor's code, not a running session. High-stakes bucket (data loss, FEAT-090 briefing history): an independent clean-room verify is warranted.

### 2026-10-14 — verify lane (r3, PAUSED for quota)
- **verify r3 paused for quota, 2026-10-14.** The r3 clean-room verify ran and a verdict was OBTAINED but is NOT recorded (paused so Claude quota goes to BUG-255; an OpenAI cross-provider re-run is owed once quota resets ~15:15). Resume pointers: candidate `93518135230b2663537eaf204ce7f19dd122b23b49df9e859f72fa833e48aee7` (mixed-state; base 1a68e57 → tree 9742f365af6b); run `007207df-99b2-4d49-8ec4-bab797a14491` (provider anthropic — OpenAI quota-exhausted fallback, SAME-provider as the author, so cross-provider is still owed). Artifacts: /tmp/bug257-r3-verdict-anthropic.json, /tmp/bug257-r3-iv-anthropic.log, /tmp/bug257-r3-requirement.txt.
- Two findings worth carrying forward on resume: (1) BUG-257 r3's own seen-state contract HELD under the attack (one writer markAnswersDelivered; no loss on adopt/null-snapshot/undelivered/failed-send; no storm). (2) The mechanical BROKEN was a FOREIGN hunk, not BUG-257: `src/server/board.ts:1833` (composeAdoptionEntry) has literal U+2028/U+2029 bytes inside a regex literal, so board.ts fails to parse and the server will not boot — owned by BUG-256/FEAT-184 spoof-hardening, needs its own fix (escape to `  `). Session-start "no start ack" is ENVIRONMENT (container isolation unavailable / foreign-owner), upstream of this ticket's surface. Smoke-runs (faithful fixer env): note-travels 39/39; feat-090-answered-lane 25/26; feat-090-answer-handoff --no-ui 23/24 (residuals pre-existing).
