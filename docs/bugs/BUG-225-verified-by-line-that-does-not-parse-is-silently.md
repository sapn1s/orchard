```orchard-ticket
{
  "id": "BUG-225",
  "type": "bug",
  "title": "Verified-by line that does not parse is silently counted as no verification",
  "summary": "A lane wrote `Verified-by: dispatch anthropic claude-opus-5-5 run <id>` with a space where a slash belongs. The board could not parse it, so it counted the ticket as unverified: verified tickets read OPEN / `Verified-by: none` and the orchestrator relayed a wrong state. Nothing warned.",
  "impact_if_we_wait": "Verified tickets keep reading as unverified, the Needs-You/verification signals stay wrong, and orchestrators relay a false state — the exact silent-parse class ARCH-010 exists to close.",
  "current_need": "Round 4: PROSE is now a WARN; audit 36/41 correct, 3 restored by a reader fix (ARCH-020, BUG-216, FEAT-144). Re-verify: property b HOLDS; property a BROKEN 3x (2 fixed, 1 residual). Decide the residual and BUG-142/203.",
  "severity": "medium",
  "area": "board / verification",
  "reported": "2026-09-30",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "review",
  "updated": "2026-10-01",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A Verified-by line that names a dispatch verification but does not parse FAILS board:check (naming ticket + line), not passes silently.",
    "The board tool's `verified` verb is the only writer of the line and cannot produce an unparseable one.",
    "The reader accepts the equivalent spellings lanes actually write (backtick-wrapped id/model, parenthetical annotation) so genuinely-verified tickets stop reading as none.",
    "The current board stays clean (board:check exit 0) with no new false failures."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "cf5c222f-1ada-49d4-82da-aef4e17be110",
      "verdict": "broken",
      "raw_verdict": "broken",
      "verdict_on": "2026-09-30",
      "harness": "scripts/independent-verify.mjs",
      "line_sha256": "0435fbb053098bbd7c22b38bc8b03d6539c5eed511817bb30313d554a4410e86",
      "origin": "legacy-prose-freeze"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "d5edf332-bc6a-427d-9606-6aa98dac9998",
      "verdict": "broken",
      "raw_verdict": "broken",
      "verdict_on": "2026-09-30",
      "harness": "scripts/independent-verify.mjs",
      "line_sha256": "e589ce259a5faefe771fdf52627eeb83804c9a44f72c51bd1fc3c0c4d1c252f3",
      "origin": "legacy-prose-freeze"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "de06419b-1a3e-4214-bf29-689d7e4b4762",
      "verdict": "broken",
      "raw_verdict": "broken",
      "verdict_on": "2026-09-30",
      "harness": "scripts/independent-verify.mjs",
      "line_sha256": "ab5483237d5c1a74bbc572559551958aea96b4a9f2e91c5e2c969c31c60129b8",
      "origin": "legacy-prose-freeze"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "2fa27658-7199-4bc4-9109-cb0515fab079",
      "verdict": "broken",
      "raw_verdict": "broken",
      "verdict_on": "2026-09-30",
      "harness": "scripts/independent-verify.mjs",
      "line_sha256": "4f9be1dff6201b619bb751f1d74c8b5e108ce10a312b67aa7102a184a638544e",
      "origin": "legacy-prose-freeze"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "9216cb37-aee5-4a7f-a6e2-34056eb0f637",
      "verdict": "broken",
      "raw_verdict": "broken",
      "verdict_on": "2026-09-30",
      "harness": "scripts/independent-verify.mjs",
      "line_sha256": "d6ec08706e04e44d566e88cd19f05fc592a55ce6a759a9d26533901285d2acf0",
      "origin": "legacy-prose-freeze"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "0aea8d9a-c8e6-446c-a02a-d61f492716e7",
      "verdict": "broken",
      "raw_verdict": "broken",
      "verdict_on": "2026-09-30",
      "harness": "scripts/independent-verify.mjs",
      "line_sha256": "544b544ef1e764e30ba80dd543c390075d7f5e90571be15eebc9e74329fbf0fc",
      "origin": "legacy-prose-freeze"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "cb78c6d6-4791-4cad-8ecb-840a2765957d",
      "verdict": "broken",
      "verdict_on": "2026-09-30",
      "recorded_at": "2026-09-30T15:53:19.622Z",
      "author": "BUG-225-r3-lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r3 property a: migration accepted a copied frozen HOLDS line; fixed (frozen-sequence check)"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "9593d403-1cbb-47cb-8303-a8e4524af06d",
      "verdict": "holds",
      "verdict_on": "2026-09-30",
      "recorded_at": "2026-09-30T15:53:20.733Z",
      "author": "BUG-225-r3-lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r3 property c: legacy reads as before, 40/40 flips explained"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "fda8cc8f-85d0-406e-bf69-b6eca7ca607c",
      "verdict": "holds",
      "verdict_on": "2026-09-30",
      "recorded_at": "2026-09-30T15:53:27.194Z",
      "author": "BUG-225-r3-lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r3 property a re-attack after fixes"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "61ffb863-dc94-4654-9d63-93abdd4ff081",
      "verdict": "holds",
      "verdict_on": "2026-09-30",
      "recorded_at": "2026-09-30T15:53:28.297Z",
      "author": "BUG-225-r3-lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r3 property b: all consumers agree"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "66eb2134-02ce-4b6b-b604-fd9fc948e836",
      "verdict": "holds",
      "verdict_on": "2026-09-30",
      "recorded_at": "2026-09-30T15:53:29.448Z",
      "author": "BUG-225-r3-lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r3 late-change attack; low-sev silent copied-line finding fixed after (count-aware check), not re-attacked"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "63ecbf9a-128f-44be-9e63-f02777b26648",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T11:53:25.737Z",
      "author": "BUG-225-r4-lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r4 property a (count-aware copied-line check): 2 advisory-only gaps (copy of a frozen record only the frozen reader parses; moved head under new continuation verdict); both fixed"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "b9406626-6a7c-43c3-9537-2ae164eda7bf",
      "verdict": "holds",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T11:53:27.295Z",
      "author": "BUG-225-r4-lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r4 property b: no ticket with a real HOLDS reads unverified; reader fix + re-derived snapshot add no false HOLDS and no post-freeze line"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "35dd5b0b-dff6-4823-8d89-235ac8e0bae2",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T11:53:28.898Z",
      "author": "BUG-225-r4-lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r4 property a re-attack: record tickets with unmarked frozen-carried entries exempted every copy as an echo; fixed"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "8b9402f9-a029-42a0-8a39-5393bc5a0b5f",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T11:53:30.481Z",
      "author": "BUG-225-r4-lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r4 property a third attack: copies of frozen NON-record dispatch-shaped lines go unnamed (advisory only, never counted); NOT fixed, open decision"
    }
  ],
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

# BUG-225 — Verified-by line that does not parse is silently counted as no verification

## What broke

A `Verified-by:` line is machine-read by `VERIFIED_BY_RE` (`scripts/lib/verdict-contract.mjs`). The regex required `dispatch <provider>/<model> run <id>` with a slash between provider and model. A lane hand-wrote `dispatch anthropic claude-opus-5-5 run <id>` (a space, not a slash). The regex did not match, `parseVerifiedBy` returned `null`, and the board counted the ticket as carrying no verification — silently. No check warned; the ticket read OPEN / `Verified-by: none`.

## The finding is broader than the reported case

Scanning the real board (`docs/bugs/*.md`) refuted the narrow hypothesis. The strict reader also silently dropped:

- run ids rendered as a code span: `` run `3e2d3330-…` `` (backticks are markup, not part of the id);
- models/annotations as code spans or parentheticals: `` dispatch anthropic `claude-opus-5-5` run … ``, `dispatch anthropic (grey account) run …`;
- a record wrapped in a single code span: `` `dispatch anthropic run 8f3a… (clean-room…` ``.

Eleven real tickets whose ONLY `Verified-by:` line used one of these equivalent spellings were reading as unverified: ARCH-020, BUG-112, BUG-161, BUG-190, BUG-216, FEAT-144, FEAT-145, FEAT-146, FEAT-151, FEAT-152, FEAT-154.

## Fix (structural first, WA §N / ARCH-010)

1. **One writer.** New `board-tool verified` verb (`scripts/board-tool.mjs`) is the sole writer of the line: it composes the canonical form from typed fields via `formatVerifiedByBody` and round-trips it through `parseVerifiedBy` before writing, and advances `work_state` (to `verified`, unless the verdict is BROKEN or the caller overrides). Hand-typing is no longer necessary.
2. **Tolerant reader.** `VERIFIED_BY_RE` now accepts the equivalent spellings above (backtick-wrapped id/model, parenthetical annotation, leading code-span backtick) while STILL rejecting the one spelling that changes the grammar rather than decorating it — a space-joined model. Capture groups (1=provider, 2=model, 3=run id) are unchanged, so provenance-check, migrate-tickets and board-status read them as before.
3. **Loud, not silent.** `board.mjs check` now FAILS with `UNPARSEABLE VERIFIED-BY`, naming the ticket and quoting the line, when a `Verified-by:` line names a dispatch verification but does not parse AND the ticket carries no valid line at all (the exact silent-zero-verification harm). A ticket that also has a valid line is already counted correctly, so a superseded malformed line in its append-only history is not a live defect.

Docs: `docs/bugs/README.md` step 5 and `docs/CONVENTIONS.md` now point lanes at the writer verb.

## Deliberately NOT done

The space-joined-model spelling is NOT made to parse: it is the malformation this ticket is about, so it stays a near-miss the board names. The near-miss FAIL is guarded to fire only when the ticket has no valid line, so the current board (which has 4 superseded malformed lines, all in tickets with a valid line) stays clean.

## Verification

- Unit: 11 spelling variants graded (canonical, backtick id, slash model, backtick model, paren annotation, whole-span, space-model must-FAIL, PENDING/prose must-not-match) — all correct.
- Board scan: 11 tickets newly parse; 0 near-miss board FAILs; `board:check` = OK, exit 0.
- `verified` verb, scratch board: 12/12 (canonical slash line, parses, work_state advance, BROKEN does not auto-advance, refuses bad run id / unknown provider / missing run).
- Near-miss must-FAIL proof, scratch board: 6/6 (baseline clean; malformed FAILS naming ticket+line; correct slash passes; guard; PENDING not a near-miss).
- Anti-regression: verify:provenance 17/0; verify:feat-097 86/0; verify:feat-149 9/0; verify:bug-125 and verify:board-tool carry only their PRE-EXISTING failures (confirmed against the untouched tree).

## Symptom of a deeper design flaw?

Yes — it is another instance of ARCH-010 (a machine-read fact hand-authored in a form its reader could not read, failing silently). The structural remedy is the single-writer tool; the tolerant reader + loud check are the belt-and-braces. No new ARCH ticket filed; ARCH-010 already owns the class.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-30 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-30 — fix lane (BUG-219/225)
- **Fixed:** Fixed (round 1). Structural fix per WA §N / ARCH-010.

  Files changed (all unstaged):
  - scripts/lib/verdict-contract.mjs — loosened VERIFIED_BY_RE (backtick-wrapped id/model, parenthetical annotation, leading code-span backtick; space-joined model still rejected); groups 1/2/3 unchanged; split formatVerifiedByBody out of formatVerifiedBy; added verifiedByNearMisses().
  - scripts/board.mjs — readTickets carries verifiedByNearMiss; checkBoard FAILs UNPARSEABLE VERIFIED-BY (naming ticket+line) when a dispatch-shaped line does not parse AND the ticket has no valid line.
  - scripts/board-tool.mjs — new `verified` verb (sole canonical writer; composes + round-trips the line; advances work_state; BROKEN does not auto-advance).
  - docs/bugs/README.md step 5, docs/CONVENTIONS.md — point lanes at the verb.

  Verification (all on real board / scratch copies):
  - Board scan: 11 tickets newly parse (ARCH-020, BUG-112, BUG-161, BUG-190, BUG-216, FEAT-144/145/146/151/152/154); 0 near-miss board FAILs.
  - board:check on the real board: OK — no drift, exit 0.
  - verified verb (scratch board): 12/12.
  - near-miss must-FAIL proof (scratch board): 6/6 — malformed space line FAILS naming ticket+line; correct slash passes; guard (valid line present) not flagged; PENDING prose not a near-miss.
  - Anti-regression: verify:provenance 17/0; verify:feat-097 86/0; verify:feat-149 9/0. verify:bug-125 (3 fails) and verify:board-tool (1 fail) carry ONLY pre-existing failures — confirmed identical on the untouched pre-change tree.

  Handoff: shared-contract change (VERIFIED_BY_RE read by provenance-check, migrate-tickets, board-status) — an independent clean-room verify pass is warranted before this leaves VERIFIED. The near-miss FAIL is guarded to "no valid line in ticket"; a stricter always-fire variant would redden 3 superseded historical lines (BUG-190:78, BUG-214:153, BUG-218:110) that already carry a valid line — a design choice for review.

### 2026-09-30 — fix lane (BUG-225)
- **Note:** Added a permanent regression suite: scripts/verify-bug-225-verified-by-parse.mjs (28/28) — reader tolerance + grammar strictness, the board:check near-miss must-FAIL/guard, and the verified verb. NOT wired into package.json (that file is dirty with concurrent work; avoided clobbering it) — orchestrator should add `verify:bug-225 = node scripts/verify-bug-225-verified-by-parse.mjs`. Run directly: node scripts/verify-bug-225-verified-by-parse.mjs

### 2026-09-30 — BUG-225 verify lane
- **Verified-by:** dispatch anthropic/claude-opus-5-5 run cf5c222f-1ada-49d4-82da-aef4e17be110 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN — round 1, property (a) no false accept

### 2026-09-30 — BUG-225 verify lane
- **Verified-by:** dispatch anthropic/claude-opus-5-5 run d5edf332-bc6a-427d-9606-6aa98dac9998 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN — round 1, property (b) one parse

### 2026-09-30 — BUG-225 verify lane
- **Verified-by:** dispatch anthropic/claude-opus-5-5 run de06419b-1a3e-4214-bf29-689d7e4b4762 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN — round 1, property (c) loud fail

### 2026-09-30 — BUG-225 verify lane
- **Verified-by:** dispatch anthropic/claude-opus-5-5 run 2fa27658-7199-4bc4-9109-cb0515fab079 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN — round 2, property (a) no false accept

### 2026-09-30 — BUG-225 verify lane
- **Verified-by:** dispatch anthropic/claude-opus-5-5 run 9216cb37-aee5-4a7f-a6e2-34056eb0f637 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN — round 2, property (b) one parse (write side)

### 2026-09-30 — BUG-225 verify lane
- **Verified-by:** dispatch anthropic/claude-opus-5-5 run 0aea8d9a-c8e6-446c-a02a-d61f492716e7 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN — round 2, property (c) loud fail

### 2026-09-30 — BUG-225 verify lane
- **Verify:** Independent verify, rounds 1 and 2. Three concurrent attackers, one per property. Each ran through scripts/dispatch.mjs as anthropic claude-opus-5-5 in a hand-built clean room (the current tree with CLAUDE.md, AGENTS.md, .claude/, docs/prompts, CONVENTIONS and this ticket removed). OpenAI was not used: its weekly quota is at 92% (PARK), so this verify is SAME-PROVIDER and decorrelation is reduced. Rooms and outputs are kept under ~/.local/state/claude-station/scratch/bug225-verify-1790775738/ (round 1 in out/, round 2 in r2/out/).

  ROUND 1 — all three properties BROKEN.
  - (a) no false accept, run cf5c222f. The new paren group and the `\s` accepted status words as run ids (`(not run yet) run pending`). A run id could be borrowed from a later paragraph. Backticked placeholders parsed.
  - (b) one parse, run d5edf332. The whole-text readers (board.mjs, board-status) and the per-line readers (provenance-check, migrate-tickets) disagreed on wrapped records: BUG-142, BUG-192 and FEAT-154, 3 of 375 tickets. The writer accepted `--model='opus (1m)'`, which is read back as `opus`.
  - (c) loud fail, run de06419b. The near-miss detector was too narrow: `run:`, `run-id`, `Verified by`, numbered, `+`, `>` and `###` lines all got through. Two real silent drops were on the board: BUG-170 and ARCH-017.

  Round-1 fixes:
  - Reader:
    - VERIFIED_BY_RE now matches within one line only (`[ \t]`).
    - A run id must contain a digit.
    - A model may not contain `(`, `)` or a backtick.
    - New extractVerifiedBy is the ONE all-records reader. It reads a head line plus its indented continuation lines via joinVerdictContinuation. parseVerifiedBy, board-status, provenance-check and migrate-tickets all route through it. Provider is lowercased.
  - Near-miss detector is broader: label variants, provider words `codex` and `claude`, run-id-like tokens that contain a digit, and joined records. Explicit NONE/PENDING records are excluded.
  - board-tool verified:
    - Validates the model (MODEL_RE) and round-trips it.
    - RUN_ID_RE requires a digit.
    - Auto-advance is now an ALLOW-list (HOLDS, PASS, CONFIRMED, VERIFIED). Previously `INVALID` and `DO-NOT-LAND` advanced to verified.
  - provenance-check compares repeated run ids occurrence by occurrence, not last-wins.
  - verify-bug-125 suite adjusted for the recovered wrapped-run-id records.

  The broader detector surfaced 5 real tickets whose ONLY records were unreadable: ARCH-017, BUG-170, BUG-187, BUG-189 and BUG-191. BUG-187 and BUG-191 have a real HOLDS verify (be533992) that the board counted as none. I transcribed 12 records to the canonical form with `board-tool verified` (all legacy tickets, so no state changed; the originals are untouched).

  ROUND 2 — all three BROKEN again, which triggers the two-break STOP.
  - (a) run 2fa27658: new, contrived false accepts.
    - `(NOT DONE) (TODO) run 7f3a9c21-placeholder`
    - `` `dispatch anthropic run 1a2b3c4d` — example template, not run ``
    - F5 (verdict-blindness): a BROKEN/INVALID-only record counts as independent verification. This predates the change, but the loosening now silences the advisory on FEAT-151 (status VERIFIED) and FEAT-152 (FIXED), whose every record is BROKEN.
  - (b) run 9216cb37: every consumer agrees (0 disagreements over 378 files). The write side broke: a newline in `--verdict` or `--author` forged a second record. FIXED: CR/LF is refused in every free-text flag.
  - (c) run 0aea8d9a: the NONE/PENDING exclusion was unanchored, so a trailing "…Verified-by: PENDING bullet" silenced a real malformed record. That regression came from my own round-1 fix. FIXED: the exclusion is anchored to the label. Width gaps remain: NBSP, Unicode dashes, link or path ids, table cells, lazy unindented continuation, and a 5-character id.

  Verification after the fixes:
  - verify-bug-225: 56/56. Must-FAIL: the new cases FAIL on the pre-round-1 code (29 passed, 23 failed).
  - board:check exits 0 with 0 UNPARSEABLE.
  - Consumer agreement: 375 tickets, 64 parsed, 0 disagreements. It was 3 disagreements before.
  - Anti-regressions: provenance 17/0, feat-149 0 fails, feat-097 0, bug-128 0, bug-097 0, cost-collect 0. bug-125 (3), migrate-tickets (2) and board-tool (1) have exactly the same failures as a full-fidelity baseline copy running the pre-round-1 code. feat-062-loop's live-LLM arms went INVALID. That suite calls none of the changed functions (checked by grep), so this is not attributed to the change.

  OPEN DECISIONS (the two-break STOP ended the loop):
  1. Should the board count only HOLDS-like records as "independently verified" (F5)?
  2. Should the reader drop the leading-backtick whole-span tolerance, since a trailing disclaimer can't be told apart from a real record?
  3. How wide should the near-miss detector be (NBSP, Unicode dash, link ids, table cells)?
  4. Fenced and indented-code records are read by design (the FEAT-091 trade-off). BUG-125 still reads as verified from a quoted FEAT-062 fence.
  Status stays in_verification.

### 2026-09-30 — BUG-225-r3-lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run cb78c6d6-4791-4cad-8ecb-840a2765957d — VERDICT: BROKEN — r3 property a: migration accepted a copied frozen HOLDS line; fixed (frozen-sequence check). Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-09-30 — BUG-225-r3-lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 9593d403-1cbb-47cb-8303-a8e4524af06d — VERDICT: HOLDS — r3 property c: legacy reads as before, 40/40 flips explained. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-09-30 — BUG-225-r3-lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run fda8cc8f-85d0-406e-bf69-b6eca7ca607c — VERDICT: HOLDS — r3 property a re-attack after fixes. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-09-30 — BUG-225-r3-lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 61ffb863-dc94-4654-9d63-93abdd4ff081 — VERDICT: HOLDS — r3 property b: all consumers agree. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-09-30 — BUG-225-r3-lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 66eb2134-02ce-4b6b-b604-fd9fc948e836 — VERDICT: HOLDS — r3 late-change attack; low-sev silent copied-line finding fixed after (count-aware check), not re-attacked. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-09-30 — BUG-225 round-3 lane
- **Fixed:** Round 3 (plan+review): REDESIGN. A verification is now a typed entry, not parsed prose.

  Design:
  - ONE reader: ticketVerifications() in scripts/lib/verification-source.mjs. It reads the record's verification[] (record tickets), or verification-ledger.json (legacy prose tickets, so no migration is needed), else the FROZEN snapshot docs/bugs/verification-legacy.frozen.json. The snapshot is the round-2 reader's output, captured once and pinned by sha256 in FROZEN_LEGACY_PINS.
  - ONE rule: isIndependentlyVerified() in public/lib/ticket-record.js, next to outstandingBroken(). It needs a HOLDS with no later BROKEN; BROKEN and INVALID never count (F5).
  - ONE writer: board-tool verified. It takes --verdict=HOLDS|BROKEN|INVALID only, refuses repeated flags, and carries frozen history forward on the first typed write. Its Activity-log echo is labelled "Verification recorded:", which nothing reads as proof.
  - Prose is never parsed at read time. board:check FAILs on: dispatch-shaped Verified-by prose typed after the freeze (including a second copy of a frozen line), FROZEN VERIFICATION DRIFT, an UNPINNED or MISSING snapshot, and invalid ledger entries. A prose line that restates a typed entry (same run id and verdict) is exempt from the FAIL, and it still counts for nothing.
  - migrate-tickets gives a record either its ledger entries or exactly the pinned frozen sequence. It quarantines any ticket whose prose record sequence differs (UNFROZEN PROSE VERIFICATION).
  - The F2–F4 questions (backtick/fence/NBSP tolerance, near-miss width) no longer decide proof.

  Plan review: anthropic claude-opus-5-5, run d7764103-337e-4b72-b5d7-8a59dc790ff9, APPROVE-WITH-CHANGES. Folded in: migration never transcribes unfrozen prose, the echo renamed, the snapshot pinned, provenance exempts typed entries, all tickets whose status flips enumerated. Deviations:
  - The UI Proof card is left reading record verification[] only (declared limit).
  - Run ids are not checked against a run recorder (declared limit: hand-typed schema-valid JSON counts).

  Independent verify: anthropic claude-opus-5-5, clean rooms, SAME-provider because OpenAI was at 92%.
  - a: cb78c6d6 BROKEN. Migration laundered a copied frozen HOLDS. Fixed with a sequence check.
  - b: timed out (INVALID, no run id). Re-run as 61ffb863: HOLDS.
  - c: 9593d403 HOLDS. 40/40 flips explained; frozen equals the old reader on every ticket.
  - a re-attack: fda8cc8f HOLDS.
  - Late-change attack: 66eb2134 HOLDS, with one low-severity silent case (a copied frozen line on a ledger ticket). Fixed afterwards with a count-aware check. That fix was NOT re-attacked.

  Must-FAIL:
  - verify:bug-225 --baseline=<round-2 tree>: 1 passed, 7 failed. Baseline accepts 8 of 15 prose spellings on a clean ticket, and gives no advisory on FEAT-151 or FEAT-152.
  - The new F1 and repeated-flag cases fail on the pre-fix room: 3 failed.
  - After the change: verify:bug-225 64/64.

  Changed on the real board:
  - 41 tickets go from verified to not verified, and none the other way: ARCH-004 ARCH-017 ARCH-020 BUG-105 BUG-106 BUG-107 BUG-108 BUG-109 BUG-118 BUG-120 BUG-142 BUG-159 BUG-160 BUG-161 BUG-169 BUG-185 BUG-186 BUG-189 BUG-192 BUG-193 BUG-198 BUG-201 BUG-203 BUG-216 BUG-217 BUG-225 FEAT-061 FEAT-082 FEAT-087 FEAT-090 FEAT-091 FEAT-094 FEAT-106 FEAT-108 FEAT-126 FEAT-130 FEAT-134 FEAT-144 FEAT-151 FEAT-152 FEAT-154.
  - 12 done tickets gain the NO INDEPENDENT VERIFICATION advisory: BUG-105 BUG-107 BUG-109 BUG-118 BUG-142 BUG-192 BUG-203 FEAT-061 FEAT-094 FEAT-130 FEAT-151 FEAT-152.
  - 10 legacy records name HOLDS/PASS only in prose, with no VERDICT: token, and are frozen as invalid: ARCH-020, BUG-142, BUG-196, BUG-203, BUG-216, BUG-217, FEAT-061, FEAT-106, FEAT-155, FEAT-158. An owner re-records any real HOLDS with board-tool verified.
  - BUG-225 now reads verified (after the typed entries above), with work_state kept at in_verification.

  Anti-regression (failure sets identical to the round-2 baseline, measured on the same board):
  - No change: provenance 17/0, independent-verification 153/153 (one existing SKIP), feat-149 9/0, feat-097 86/0, onboard 57/0, ticket-schema 64/0, bug-128 43/0.
  - Same pre-existing failures as baseline: migrate-tickets, board-tool, bug-125, bug-119, bug-122, bug-123, leak-write-guard, unmappable-status, ticket-dashboard.
  - Suites updated for the new contract: verify-independent-verification (two checks), verify-bug-225 (rewritten).

  Live effect:
  - Lanes writing prose after the freeze were flagged. BUG-201, FEAT-091 and FEAT-126 were remediated by their lanes with board-tool verified.
  - FEAT-106 and FEAT-110 (lines typed around 18:45) FAIL board:check right now. These are true positives; each clears with one board-tool verified naming the same run.

  npm run gate: PASS (exit 0).

  Open for the orchestrator:
  - The PROSE FAIL blocks board-tool commit until a lane records typed entries (WARN is a one-line change).
  - docs/prompts/patterns/VERIFY.md (the methodology mirror) still tells lanes to paste a prose line. Edit the canonical copy.
  - Independent re-verify of the last count-aware fix.

### 2026-09-30 — BUG-225 round-3 lane
- **Note:** Side effect found and repaired. At 17:49 my anti-regression sweep ran a suite (most likely verify-onboard.mjs, which drives the onboard.mjs other lanes are editing). It ONBOARDED THE REAL REPO: it created .orchard/, pointed package.json gate, check:nul, board:check, board:gen and arch:watch at .orchard/, and pointed the .claude/settings.json Stop hook at .orchard/hooks. Repairs: those 5 package.json lines and the hook path now point back at scripts/; .orchard/ was moved (not deleted) to the lane scratch dir as dot-orchard-removed-from-repo; pre-repair copies of package.json and settings.json were saved beside it. This is worth its own ticket: a suite must never onboard the repo it runs from. Final state: npm run gate PASS (exit 0). board:check exits 1 with exactly 2 FAILs, PROSE VERIFIED-BY NOT COUNTED on FEAT-106 and FEAT-110. Both are true positives: live lanes typed prose after the freeze. Each clears with one board-tool verified naming the same run.

### 2026-10-01 — BUG-225-r4-lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 63ecbf9a-128f-44be-9e63-f02777b26648 — VERDICT: BROKEN — r4 property a (count-aware copied-line check): 2 advisory-only gaps (copy of a frozen record only the frozen reader parses; moved head under new continuation verdict); both fixed. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — BUG-225-r4-lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run b9406626-6a7c-43c3-9537-2ae164eda7bf — VERDICT: HOLDS — r4 property b: no ticket with a real HOLDS reads unverified; reader fix + re-derived snapshot add no false HOLDS and no post-freeze line. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — BUG-225-r4-lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 35dd5b0b-dff6-4823-8d89-235ac8e0bae2 — VERDICT: BROKEN — r4 property a re-attack: record tickets with unmarked frozen-carried entries exempted every copy as an echo; fixed. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — BUG-225-r4-lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 8b9402f9-a029-42a0-8a39-5393bc5a0b5f — VERDICT: BROKEN — r4 property a third attack: copies of frozen NON-record dispatch-shaped lines go unnamed (advisory only, never counted); NOT fixed, open decision. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — BUG-225 round-4 lane
- **Verify:** Round 4 (verify + audit). Run 2026-10-01.

  1. DECISION APPLIED: post-freeze prose is now a WARN. In scripts/board.mjs, `fails.push` became `warns.push`, labelled `PROSE VERIFIED-BY NOT COUNTED (advisory)`. It is still named and still never counts.
     - board:check: exit 0, with FEAT-106 and FEAT-110 shown as WARN.
     - Must-FAIL: putting FAIL back turns 7 checks red in verify:bug-225.
     - docs/bugs/README.md step 5 updated to match.

  2. AUDIT OF THE 41 verified→unverified flips. Verdict: 36 correct, 3 wrongly flipped and fixed in the READER, 2 contested (decision).
     Before round 4, every one of the 41 counted only because the round-2 reader was verdict-blind: it counted any parsed record.

     | ticket | old reason it counted | why it does not count now | correct? |
     |---|---|---|---|
     | ARCH-004 BUG-105 BUG-106 BUG-107 BUG-108 BUG-109 BUG-118 FEAT-082 FEAT-087 FEAT-090 (record verification[]) | parsed BROKEN record(s) | every entry is BROKEN | yes |
     | ARCH-017 BUG-120 BUG-159 BUG-160 BUG-185 BUG-186 BUG-189 BUG-192 BUG-193 BUG-198 FEAT-094 FEAT-108 FEAT-134 FEAT-151 FEAT-152 (frozen) | parsed BROKEN record(s) | every frozen record is BROKEN | yes |
     | BUG-161 BUG-169 BUG-217 FEAT-154 FEAT-106 (frozen) | BROKEN or INVALID records | BROKEN/INVALID only. BUG-169 is "REFUTED for the full invariant". FEAT-106 b0e62aed is a suite-strength-only HOLDS followed by BROKEN. | yes |
     | BUG-201 FEAT-126 (ledger) | INVALID/BROKEN | every ledger entry is BROKEN/INVALID | yes |
     | FEAT-091 (ledger) | had HOLDS | HOLDS 01a01734 and 9ee724de, each followed by BROKEN (outstanding). A lane added a typed HOLDS fe2f0871 on 2026-10-01. | yes |
     | FEAT-061 (record) | BROKEN/INVALID | the ticket itself says "No verdict anywhere in this ticket's lineage is HOLDS" | yes |
     | FEAT-130 (frozen) | BROKEN 01a07918 | its round-13 "VERDICT: PASS" came from an in-process agent with no dispatch run id | yes (per contract) |
     | BUG-225 | BROKEN only | now carries typed entries | yes |
     | ARCH-020 | INVALID ae9775f9 | HOLDS written as `run <id> (clean-room round 5, HOLDS, …)`, no VERDICT token | **NO** — fixed |
     | BUG-216 | INVALID 0b0c48bd | `(clean-room round 3, HOLDS)`, no VERDICT token | **NO** — fixed |
     | FEAT-144 | BROKEN 01a0a739 (frozen as invalid) | real HOLDS 97800f97 written as `**Verified-by (round 2, weakened):** dispatch **anthropic** … VERDICT: **HOLDS**`; never parsed | **NO** — fixed |
     | BUG-142 BUG-203 | 625ee528 | verifier token BROKEN ("product HOLDS; scan residual"); the later re-record of the same run (after decision A withdrew the scan claim) has no verdict word | CONTESTED (decision) |

     READER FIX: `legacyProseVerifications` only (the shared VERIFIED_BY_RE is untouched). It now reads:
     - a VERDICT token under emphasis;
     - exactly one upper-case HOLDS|BROKEN|INVALID in the parenthetical right after the run id;
     - emphasis and `Verified-by (annotation):` label normalisation.

     SNAPSHOT RE-DERIVED: the frozen snapshot was rebuilt with the fixed reader, RESTRICTED to lines the round-3 snapshot already knew. 8 tickets' records changed, each reviewed by hand:
     - ARCH-020, BUG-216 and FEAT-144 go to verified;
     - FEAT-145 and FEAT-158 records go invalid→holds (they were already verified);
     - FEAT-154 and FEAT-144 records go invalid→broken;
     - BUG-196 raw verdict is now `invalid`;
     - BUG-169 gains its L162 restatement (INVALID).
     The pin changed from 767b3380… to 3760b722…; the old hash is not kept. Board-wide, only those 3 tickets change status.
     Script: ~/.local/state/claude-station/scratch/bug225-r4-verify-lQh1 room diff and /tmp/bug225-r4/rederive.mjs.

  3. INDEPENDENT RE-VERIFY. anthropic claude-opus-5-5, separate process, clean rooms (CLAUDE.md, AGENTS.md, .claude/, docs/prompts, CONVENTIONS and this ticket stripped). SAME-PROVIDER: OpenAI was at 98% weekly. Runs are recorded with `board-tool verified`.
     - (a) count-aware copied-line check:
       - 63ecbf9a BROKEN, two advisory-only gaps, both fixed:
         - F1 (regressed-from: my own round-4 reader change): a copy of a frozen record that only the frozen reader parses went unnamed. Copies are now counted over both readers.
         - F2: only head lines were hashed, so a frozen head line moved under a new continuation verdict was silent. `frozenDrift` now FAILs "no longer reads that way". This gap dates from round 3.
       - Re-attack 35dd5b0b BROKEN. F3: record tickets whose frozen-carried verification[] entries lack `origin` treated every copy as an "echo". Fixed: the echo set now subtracts the frozen records (as a multiset).
       - Third attack 8b9402f9 BROKEN, low severity: copies of frozen NON-record dispatch-shaped prose lines (42 on the board) go unnamed. They never count. NOT fixed; open decision.
       - In all three runs claims (2) and (3) held: copies never change what counts or what migration writes, and the unmodified board shows no false positive.
     - (b) the audit conclusion: b9406626 HOLDS.
       - Of the 374 tickets, only ARCH-020, BUG-216 and FEAT-144 flip.
       - No false HOLDS, and no post-freeze line in the snapshot.
       - All 3 read verified through board.mjs, board-status and migrate-tickets.
       - It agrees BUG-142/203 should read unverified.
     - Must-FAIL: the R4v checks fail on the pre-fix rooms (3 fail, then 1 fail), and the R4 audit checks fail against the old snapshot.

  4. VERIFICATION:
     - verify:bug-225 88/88 (was 64/64).
     - provenance 17/0, ticket-schema 64/0, bug-128 43/43, feat-149 9/0, feat-097 86/0, independent-verification 153/153 (1 SKIP), wa-selfmaintain 43/43.
     - bug-125: the same 3 failures as a round-3 baseline copy. Its classifier was taught the round-4 tolerance.
     - migrate-tickets: 1 failure, the BUG-169 extraction mismatch already present in the baseline. The baseline had 2.
     - board-tool: 1 failure, the existing BUG-016 one. The baseline had 7: the 6 others were the PROSE FAIL.

  5. SETTINGS/PACKAGE vs HEAD (read-only git diff):
     - .claude/settings.json is identical to HEAD, so the Stop hook matches.
     - `.orchard/` is absent.
     - package.json has only 8 added script lines, nothing pointing at .orchard. They are verify:feat-160, verify:bug-198, verify:bug-225, sandbox:docker (FEAT-158) and 4× verify:feat-154-*.

  6. FILED BUG-227: a test run onboarded the real repo, and onboard.mjs has no self-target guard. In a scratch copy, verify-onboard and verify-feat-106-onboard-orchard-layout both stay confined today, so the culprit is not yet identified.

  7. DOCS:
     - The premise was wrong: docs/prompts/patterns/VERIFY.md has NO canonical copy (sync:methodology mirrors only the WA versions and ROUTING.md). It is edited in place, in orchard.
     - The canonical ~/projects/methodology WORKING_AGREEMENT.v2.md and v4.md "Recorded, not remembered" paragraphs are edited too: record with the verification writer, never a pasted prose line.
     - sync:methodology ran; --check is in sync.

  NOTE: a HOLDS write auto-advanced work_state to `verified`, and the later BROKEN entries did not move it back. I reset it to in_verification with `board-tool update`. The writer never retreats work_state on a BROKEN — a design question.

  OPEN DECISIONS:
  (1) Accept the F-residual (copies of non-record frozen prose go unnamed), or add per-line freeze counts. That needs a re-pin, and the freeze-time counts are no longer recoverable exactly.
  (2) BUG-142/BUG-203 625ee528: keep them unverified (the attacker agrees), or record a HOLDS by decision.
  (3) BUG-225 now reads NOT independently verified: the last entry is BROKEN (8b9402f9). Closing needs a HOLDS on a property scoped to record lines, or decision (1).
  (4) Gating the writer's work_state on outstanding BROKEN.

  Independent clean-room re-verify warranted for the F3 fix and the drift rule: same-provider only, and the third attacker did not re-attack F3 directly beyond the board scan.

### 2026-10-01 — BUG-225-r5-fix-lane
- **Fixed:** Round 5 (fix), decision 4. DEFECT: `board-tool verified` advanced work_state to `verified` on a HOLDS write and never retreated, so a later BROKEN left the record reading `verified` (round 4 had to reset this ticket by hand). FIX (scripts/board-tool.mjs, verbVerified only): work_state is now DERIVED from the one rule isIndependentlyVerified() over the WHOLE verification history, in BOTH directions. A HOLDS with no later BROKEN => verified; a BROKEN after a standing HOLDS => demote to in_verification; a verdict that does not change the rule (INVALID, or a BROKEN with no prior HOLDS) leaves work_state untouched (transition of the rule, not the verdict word, decides). No second rule added; an explicit --work-state still overrides; legacy (ledger) tickets have no record work_state to advance and report it as skipped. The write reuses the existing one reader (current.entries + the new entry); nextList is byte-equivalent to the old record.verification for record tickets. No shared reader, rule, migration, or real-board ticket file was touched, so existing board states are unchanged and this ticket stays in_verification. MUST-FAIL proof: against the immediate pre-fix tree, a BROKEN after a HOLDS leaves work_state=verified (the bug); with the fix it demotes to in_verification (both arms run, scratch board copy). VERIFY: verify:bug-225 95/95 (was 88/88; +7 round-5 assertions: the REC HOLDS-then-BROKEN demotion on a real-board copy, plus a freshly filed record ticket driven INVALID/BROKEN(no change)->HOLDS(promote)->BROKEN(demote)->HOLDS(promote)->explicit-override). Anti-regression, all matching the round-4 baseline: feat-097 board-tool 86/0; independent-verification 153/153 (1 environment SKIP); migrate-tickets 67/1 (the pre-existing BUG-169 extraction mismatch); bug-119 119/121 (pre-existing BUG-120/FEAT-108 round-3 derivation failures; bug-119 does not import board-tool). npm run gate PASS (exit 0); npm run board:check OK — no drift. Files, unstaged: scripts/board-tool.mjs and scripts/verify-bug-225-verified-by-parse.mjs. HANDOFF: the cross-provider closing check is still deferred (OpenAI quota); BUG-225 last verdict is BROKEN so it reads NOT independently verified, and closing still needs a HOLDS on a record-line property or a decision (open decision 3). This is a state-transition/session-lifecycle change verified same-provider only, so an independent clean-room re-verify of the bidirectional derivation is warranted.
