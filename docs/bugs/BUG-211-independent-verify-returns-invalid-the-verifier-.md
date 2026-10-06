```orchard-ticket
{
  "id": "BUG-211",
  "type": "bug",
  "title": "Independent-verify returns INVALID: the verifier never writes a verdict",
  "summary": "Two verifiers (Fable, Sonnet) returned contract-INVALID on BUG-196 round 6. Transcripts show neither ever wrote a VERDICT line: each spent its whole turn on the fixer's oversized matrix suite — 240 real-browser cells that time out in the clean room — then ended on a background-shell status line the harness parsed as an empty citation.",
  "impact_if_we_wait": "Independent verification is the workflow's highest-stakes gate, and it now yields no signal on a large fix regardless of the verifier's real work: neither pass nor fail. Every high-stakes ticket stalls, and repeated re-dispatches burn cost. Bounded: no wrong verdict ships — the failure is loud, not silent.",
  "current_need": "Give a verifier a fixer-test it can finish in one turn (not a 240-cell browser matrix that times out in the clean room), and make the harness distinguish never-answered from answered-wrong rather than discarding recorded runs.",
  "severity": "high",
  "area": "independent verification harness",
  "reported": "2026-09-29",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-09-29",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A dispatched verifier produces a contract-valid VERDICT within its turn budget for a large fix; the fixer-test it re-runs completes in the clean room.",
    "When the verifier ends its turn without a verdict but recorded runs exist, the harness reports that distinctly and does not discard the runs.",
    "Must-FAIL: replay the round-6 verifier state (final message a status line, runs recorded) and show the current path returns generic INVALID.",
    "The substance bar does not move: static-only or fixer-only answers, and answers citing unrecorded runs, still return INVALID."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
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

# BUG-211 — Independent-verify returns INVALID: the verifier never writes a verdict

## What the user saw

BUG-196 round 6 dispatched two decorrelated clean-room verifiers — anthropic/fable
(run 778cc092) and anthropic/claude-sonnet-5 (run a06ef03c). Both returned
`VERDICT-CONTRACT: INVALID` (independent-verify exit 3) with the full set of
substance violations (no VERDICT, missing CLAIM, no FIXER-TEST/ADVERSARIAL
citation, empty UNTESTED) and `format-normalized (1): 1 unlabelled line(s)
ignored`. No valid verdict exists, so BUG-196 stays NOT VERIFIED — the top-stakes
gate produced no signal despite both verifiers doing real, recorded work.

## Root cause (transcript-proven — the charter's candidate causes are refuted)

The verifiers did NOT "answer in prose", the diff length did NOT crowd out the
format, and the parser is NOT too strict (BUG-097 already made it lenient). The
real cause, read from the two kept session transcripts:

- **Neither verifier ever wrote a `VERDICT:` or `ADVERSARIAL:` line, in the whole
  session.** They never reached the answer.
- Each burned its entire turn budget on the fixer's own test
  `scripts/verify-bug-196-matrix.mjs` — a 240-cell suite that boots real headless
  Brave per cell and whose client leg FATALs on a page-boot timeout IN THE CLEAN
  ROOM. The transcripts show them running it under `timeout 585/590`, then
  `nohup … &` + `until ! kill -0 <pid>` poll loops, then backgrounding it and
  polling `.vrun/res/*.json`.
- Both sessions were then told `<task-notification> … <status>stopped</status>
  <summary>Background shell command didn't finish before the previous session
  ended</summary>` — the matrix run overran the turn (BUG-210's class, one level
  down). The Fable session was additionally cut by a safety classifier:
  `"Your response above was stopped by a safety classifier … The rest of it was
  withheld…"`.
- Each session's FINAL assistant message was therefore a status line, not a
  verdict: Fable — `"Waiting for the matrix run to complete and be recorded…"`;
  Sonnet — `"Standing by for task bekm290ml to complete."`
- The anthropic dispatch returns `parsed.result` = that final assistant message
  (`scripts/dispatch.mjs:462,470`). independent-verify feeds it to
  `parseCitationReply(active.stdout)` (`scripts/independent-verify.mjs:1027,1060`),
  which sees one unlabelled line and reports every substance violation
  (`scripts/lib/verdict-contract.mjs:922-933`). The corrective re-prompt
  (`scripts/independent-verify.mjs:1045-1057`) resumed the SAME session, which
  resumed waiting on the SAME doomed matrix run and again ended on a status line.

So the verdict was empty because the verifier never finished gathering evidence,
not because of anything the prompt or parser did to a real answer. The manifest
proves real work was done and thrown away: Sonnet recorded provider-lock 60/60
twice, matrix wire 134/134, and clean adversarial restart/race runs.

## Contributing harness facts (levers, with citations)

- The fixer supplies `verify-bug-196-matrix.mjs` as a fixer test; it cannot
  complete in the clean room (real-Brave page-boot timeout) or within the dispatch
  budget. `independent-verify.mjs` default `--timeout-min` is 15
  (`scripts/independent-verify.mjs:128`); the matrix client leg alone is 240
  real-browser cells (`scripts/verify-bug-196-matrix.mjs:14-17`).
- The harness cannot tell "never answered (runs recorded)" from "answered wrong":
  any `cite.violations` bails with the same generic INVALID
  (`scripts/independent-verify.mjs:1117`), discarding the recorded manifest runs.
- The corrective re-prompt lists recorded run ids but never says "stop running /
  waiting on anything — answer NOW using only what is already recorded"
  (`scripts/independent-verify.mjs:1045-1057`).

## Candidate designs (for the engineer to weigh — not decided here)

- **A — hand the verifier a fixer-test it can finish in one turn.** Point it at the
  fast, deterministic suite (`verify-bug-196-provider-lock.mjs`, ~1-2 min) as the
  fixer test; treat the real-browser matrix (or its client leg) as out-of-scope
  for the clean room / cite it as UNTESTED. The verifier wasted its whole turn on
  a leg that cannot boot Brave in the clean room anyway.
- **B — harness distinguishes "no verdict, runs recorded" from "bad answer".** When
  the reply carries no verdict but the manifest has runs, resume with a hard "STOP.
  Do not start or wait on any run. Using only these recorded runs [ids], answer NOW
  with the citation block" prompt; or fail with that specific diagnosis instead of
  the generic INVALID so the runs are not silently lost.
- **C — give long suites a sanctioned pattern.** The verifiers reinvented
  nohup+poll badly; a per-run budget and a documented "background + harvest" helper
  (shared with BUG-210) would stop the turn ending mid-wait.
- **D — do not gate the whole verdict on a single final message** that a safety
  classifier or a turn boundary can truncate.

## Proof bar

- Must-FAIL: replay the round-6 verifier state (final message a status line, runs
  recorded in the manifest) and show the current path returns the generic INVALID
  and discards the runs.
- After the fix: a verifier that recorded the required runs produces a
  contract-valid verdict for a large fix, and its fixer-test completes in the
  clean room; OR the harness reports "no verdict, N runs recorded" distinctly.
- Substance bar unchanged (BUG-097): static-only, fixer-only, and unrecorded-id
  answers still return INVALID.

## Related

BUG-210 (the same turn-end-over-a-live-child root, at the lane level), BUG-097
(lenient citation parse — already done, does not cover a missing verdict), FEAT-062
(the one corrective re-prompt), BUG-092 (recorder socket), BUG-196 (where this
blocked verification).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — agent
- **Filed:** through the board tool; the record was validated before it was written.
