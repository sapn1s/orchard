```orchard-ticket
{
  "id": "FEAT-110",
  "type": "feature",
  "title": "Refuse private-token leaks at ticket-write time, not just at commit",
  "summary": "Board tool file/update now refuse a ticket write carrying a home path, username or private project name, reusing the leak-gate token list — closing the authoring-time gap that let BUG-155 and BUG-156 leak.",
  "impact_if_we_wait": "Every leaked ticket blocks the gate for all lanes and needs a redaction; on a public repo an un-caught one is an exposure the moment it is pushed, recoverable only by a history rewrite.",
  "current_need": "Review the built guard; decide whether to also add a turn-end/pre-commit hook to cover Write-tool-authored tickets (the residual gap).",
  "severity": "medium",
  "area": "board tooling / publish-safety",
  "reported": "2026-08-27",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-27",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A board-tool ticket write carrying a private token is refused before it lands.",
    "The detector is the leak-gate token list, not a second matcher.",
    "A clean ticket, and a ticket discussing token shapes, are not blocked."
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

# FEAT-110 — Refuse private-token leaks at ticket-write time, not just at commit

'"$BODY"'

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-27 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-30 — clean-room verification (verify lane, round 1)
- **Requirement tested:** a ticket carrying a private token (home path / bare
  username / private project name — the reused leak-gate class list) cannot end a
  turn regardless of which tool authored it. Two layers: the round-1 board-tool
  write-time refusal (`private-token-leak`), and the round-2 authoring-path-
  independent Stop hook `scripts/hooks/ticket-leak-gate.mjs` that scans
  git-status-changed ticket files. Requirement written to a scratch file, with a
  filled-in CITATION_CONTRACT-shaped FIXER-TEST example.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --range HEAD
  --allow-input docs/bugs --requirement @<scratch>/req-FEAT-110.txt
  --run "node scripts/verify-feat-110-authoring-guard.mjs"
  --test-file scripts/verify-feat-110-authoring-guard.mjs --provider anthropic
  --timeout-min 8 --verdict-out <scratch>/verdict-FEAT-110.txt`
- **Strategy — CARRIER-TREE at HEAD.** FEAT-110's fix is COMMITTED (hook, round-2
  suite and board-tool round-1 guard all landed at `d687709` and are present
  unchanged at HEAD). Its own commit could not be exported directly: `d687709`
  predates `src/server/seed-sources.mjs` (added `ca672b9`), so a clean room there
  refuses to boot. HEAD (`a977e76`) carries the identical committed fix and boots.
  `--allow-input docs/bugs` was required because the suite's path D reads the real
  board to build a realistic board-tool fixture; the clean room strips all of
  `docs/`, which would otherwise crash the suite. **Reduced-isolation caveat:**
  the board (`docs/bugs`) was re-included, so the verifier could see board prose;
  ambient instructions (CLAUDE.md/.claude), `docs/prompts`, `docs/CONVENTIONS.md`
  and `docs/analysis` all stayed stripped, and FEAT-110's own ticket carries no
  fixer rationale.
- **FEAT-156 noise:** did NOT appear. A `git archive` of committed HEAD excludes
  another session's uncommitted `scripts/lib/leak-tokens.mjs` changes (FEAT-156),
  so the earlier 10/7 dirty-tree split did not recur — the fixer suite ran 17/17
  clean in the room.
- **Verdict: BROKEN (contract VALID — manifest-backed; 3 recorded runs; two
  genuine adversarial cases the ASCII-only fixture never covered).** The fixer
  suite re-ran green (17/17); the break is in cases it does not exercise.
- **FINDINGs (all in `scripts/hooks/ticket-leak-gate.mjs`):**
  1. It parses `git status --porcelain` lines by stripping only the OUTER quotes
     and never undoes git's C-style quoting (octal escapes for non-ASCII,
     backslash-escaped quotes). The resolved path does not exist, `statSync`
     throws, the catch skips the file, and the hook ALLOWS with empty stdout — a
     leaking home path in an untracked ticket named with an em dash, an accented
     letter, or a double quote ends the turn UNBLOCKED.
  2. Same defect on a tracked ticket with a non-ASCII filename that is then EDITED
     to add a home path (status `M "…na\303\257ve.md"`) — hook ALLOWS, so the Edit
     authoring path is bypassed too.
  3. The rename handling `.replace(/^.* -> /, '')` is applied to every status
     line, so an untracked leaking ticket whose filename contains " -> " is cut to
     a non-existent path and silently skipped — hook ALLOWS.
  4. The read-failure branch treats ANY stat/read error as "deleted, nothing to
     scan" and continues, so a changed-but-unreadable ticket passes silently
     instead of being refused — contrary to the fail-safe requirement.
- **Handoff:** leave OPEN. Next fix lane should make the hook decode git's
  C-quoting (or run `git status -z`/`--porcelain=v2 -z` for NUL-delimited, unquoted
  paths), stop applying the ` -> ` rename strip to non-rename lines, and treat a
  read/stat error on a changed ticket as REFUSE, not skip. Re-run the fixer suite
  plus the two adversarial cases after the fix.
- **Verified-by:** dispatch anthropic (grey account — SAME-provider fallback,
  decorrelation reduced) run `b78925d2-b09e-41fb-bc90-34f45756fbfe` (clean-room,
  `scripts/independent-verify.mjs`, carrier-tree HEAD, docs/bugs allowed) —
  VERDICT: BROKEN. This prose line is a handoff record, not proof; the TYPED entry
  must be recorded by the orchestrator with
  `node scripts/board-tool.mjs verified --id=FEAT-110 --provider=anthropic
  --run=b78925d2-b09e-41fb-bc90-34f45756fbfe --verdict=BROKEN` (that command
  regenerates INDEX, which this verify lane is not permitted to touch).
