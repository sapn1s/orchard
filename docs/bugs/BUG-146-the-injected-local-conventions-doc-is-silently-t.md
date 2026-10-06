```orchard-ticket
{
  "id": "BUG-146",
  "type": "bug",
  "title": "the injected local-conventions doc is silently truncated to a fifth",
  "summary": "localConventionsSection() hard-caps docs/CONVENTIONS.md at 4,000 chars. This repo's file is 18,277 — so ~79% of it never reaches a session, and the cut lands mid-row inside the FEAT-100 charter-grammar table. Nothing warns; the doc looks injected and is mostly not. Any rule written past line ~66 is a no-op on live sessions.",
  "impact_if_we_wait": "Project rules are written, committed, believed to be in force, and never delivered. The testing conventions, the rg-not-grep rule and the separate-process verification rule are all past the cut today, and an author has no way to notice.",
  "current_need": "Decide whether the cap rises, whether the doc gets an inject-marked region like ROUTING.md and RESPONSE_FORMAT.md, or whether truncation becomes loud.",
  "severity": "medium",
  "area": "instruction injection",
  "reported": "2026-08-25",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-02",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A rule written into docs/CONVENTIONS.md either reaches a launched session or its omission is reported somewhere the author sees it.",
    "No injected section ends mid-word or mid-table-row.",
    "The chosen mechanism is consistent with the marked-region pattern ROUTING.md and RESPONSE_FORMAT.md already use.",
    "The composed prompt's total size is stated before and after, since the WA already takes 67% of it."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "run_id": "9da3de75-365d-44cb-a5f0-c665d18f03aa",
      "verdict": "invalid",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T20:22:55.916Z",
      "author": "greyl33t",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r2 clean-room not-run: BUG-120 strips docs/CONVENTIONS.md (the artifact under test) so the fixer test fatals (exit 1) in the room; verdict INVALID, not a code defect"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "b9874b48-681b-4982-a835-039f90977f2d",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T20:30:49.164Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r2 --allow-input docs/CONVENTIONS.md: real doc survived strip, fixer suite 22/22, VALID BROKEN. 3 loud-stop edge findings: CRLF over-cap cut mid-rule (:417); cap is UTF-16 chars not bytes (:387); blank-line-free over-cap block hard-slices mid-word (:418)."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "run_id": "c407d1bc-b23d-4e69-ac70-e783e0f7e5fc",
      "verdict": "holds",
      "verdict_on": "2026-10-02",
      "recorded_at": "2026-10-02T01:04:49.530Z",
      "author": "greyl33t",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r3 --allow-input docs/CONVENTIONS.md; same-provider grey acct (fallback). Harness exit 0, contract VALID. Fixer 28/28 +1 SKIP (git-HEAD leg skips w/o .git); adversarial 843/843 (no stray CR, dropped==total-kept, output<=cap, boundary end, no board.ts->templates cycle). 3 r2 loud-stop findings FIXED."
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

# BUG-146 — the injected local-conventions doc is silently truncated to a fifth

## Measured, on this repo, today

| section | source size | injected | delivered |
|---|---|---|---|
| Working Agreement v2 | 24,598 B | 24,403 | whole — no cap on this path |
| Project Conventions (local) | 18,277 chars | **4,000** | **~3,767 after the 233-char header ≈ 66 of 309 lines** |
| Provider Routing (marked region) | 2,469 | 2,469 | whole (cap 4,000) |
| Response Format (marked region) | 5,245 | 5,245 | whole (cap 6,000) |
| Project state (board snapshot) | — | **1,200** | at the cap, ends mid-word |

Composed append total ≈ 36,138 chars ≈ 9,035 tokens, of which the WA is 67%.

The cut inside CONVENTIONS.md lands mid-table-row in the FEAT-100 `Dispatch:` grammar table, with the last delivered fragment ending `…which attempt this is`. Everything from ~line 67 on is absent from every session, including:

- the whole Testing section (test against the real artifact; test invariant properties; must-FAIL not anchored to a moving baseline; partial and truncated reads)
- the `rg`-not-the-Bash-`grep`-shim rule (BUG-103)
- the scratch-server isolation knob (BUG-117)
- "Separate process, not a subagent" — the verification rule at `:306-309`

## Why this is not merely a number to raise

The cap exists for a real reason (`templates.ts:301-305`): this competes for the same attention budget as the WA and the board snapshot. Raising it to fit 18k would push the composed append past 50k. The marked-region pattern the two neighbouring sections already use is the shape that solves it — the author declares which part is agent-facing — but that puts the choice on the author, so truncation of what is left must still be visible rather than silent.

Note the asymmetry worth a sentence in whatever fixes this: the shared WA is injected whole and uncapped at 24k, while a project's own conventions are cut to 4k. That ordering may be backwards.

## Context pack (grows — the "where to look", so no agent cold-starts)
- `src/server/templates.ts:301-325` (`localConventionsSection`, the 4,000 default), `:349-376` (`routingSection`, marked region), `:419-468` (`responseFormatSection`, marked region), `:501-620` (fold order)
- `src/server/board.ts:756-830` (`boardStateSection`, the 1,200 cap, also biting)
- `src/server/agent-bridge.ts:751-760`, `:1064-1066` (the launch-time folds)
- Related: FEAT-039 (why local conventions exist), FEAT-043, FEAT-084, BUG-145 (a rule's home must actually be injected)

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-25 — orchestrator
- **second half of the same defect: the empty stub is not free:** **Found while verifying what a REAL newly-onboarded project receives** (fresh dir, `node scripts/onboard.mjs <dir>`, then `localConventionsSection()` against it):

  The `CONVENTIONS_STUB` that `scripts/onboard.mjs:313-328` writes into every onboarded project contains **no rules at all** — it is a paragraph explaining what the file is for, plus an HTML comment saying "Add this project local rules below". `localConventionsSection()` treats it as present and injects **977 chars (~244 tokens) into every turn of every session in that project**, forever, to say nothing.

  So the cap defect has two halves and they point opposite ways:
  - A project that has WRITTEN conventions gets ~79% of them silently dropped (the original finding).
  - A project that has written NONE pays ~244 tokens per turn to be told the file exists.

  The emptiness test is already there and already correct in shape — `templates.ts:309-310` returns null on a blank body — it just cannot see that a stub is semantically empty. Whatever fixes the cap should also make "the stub, unmodified" inject nothing: comparing against the known stub text, or requiring content outside the scaffolded comment, are both cheap. That keeps the FEAT-039 opt-in contract honest: a project with nothing to say should cost nothing.

  **Not fixed here** — recorded so the fixer sizes the change once. Verified only that the stub injects (977 chars) and that a genuinely blank file injects nothing.

### 2026-09-29 — agent (fixing, round 1)

**Understood:** both halves — (1) the doc was hard-capped and silently cut mid-table-row so ~79% (incl. the BUG-148 identity and BUG-103 rg rules) never reached a session; (2) an unedited onboard scaffold injected ~244 tokens/turn to say nothing.

**Verified FIRST that the marked-region mechanism already exists** and is reused verbatim: `ROUTING_INJECT_RE` (`routing-inject:start/end`, templates.ts) and `RESPONSE_FORMAT_INJECT_RE` (`response-format-inject:...`). Hypothesis confirmed — no new mechanism invented.

**Changed (all unstaged, no git writes):**
- `scripts/lib/conventions-stub.mjs` + `.d.mts` (NEW) — the onboard scaffold text now has ONE owner (ARCH-010). Exports `CONVENTIONS_STUB` and `isUneditedConventionsStub(body)` (exact match, CRLF/trim-normalised — not a length heuristic).
- `scripts/onboard.mjs` — imports the stub from that owner instead of a local const (byte-identical scaffold; onboard suite 51/0).
- `src/server/templates.ts` — `localConventionsSection()`: (a) returns `null` for an unedited stub; (b) injects the `conventions-inject` marked region when present (author-curated agent-facing core), delivered whole under a wide cap; a doc WITHOUT markers still degrades to the capped full body + LOUD boundary-aware TRUNCATED notice (never silence). Added `CONVENTIONS_INJECT_RE`.
- `docs/CONVENTIONS.md` — restructured at paragraph granularity (moved text verbatim, no rewording/deletion — proven by a word-multiset guard: 0 lost, 0 unexpected added words): title+meta stay above the region; all operative rules sit inside `conventions-inject:start/end`; 14 framing/history/worked-example/CLI-readback/proof blocks (~4.6k) moved to a `## Background, history & evidence (not injected)` section below the end marker.

**Verification (`node scripts/verify-bug-146-conventions-inject.mjs` — 18/18 PASS):**
- MUST-FAIL (anchored to a SYNTHESIZED pre-fix `oldSection`, run on the REAL pre-change doc via `git show HEAD:docs/CONVENTIONS.md` — not a moving baseline): pre-change code drops BUG-148, BUG-103, must-FAIL and separate-process rules (injected 5,980 chars, truncated "23353 of 29003 chars NOT here"), and injects the 976-char unedited stub. Defect reproduced.
- Post-fix, THIS repo: region injected WHOLE, 24,601 chars, contains all 4 previously-dropped rules; `conventions-inject` markers stripped; the "58 of 119" framing and worked-examples list are excluded from the region but STILL EXIST in the file; no TRUNCATED notice; ends on a boundary (`…dispatch.mjs\`).`), not mid-word.
- Fresh stub-onboarded temp repo (`onboard.mjs <tmp> --no-board`): injects NOTHING (null). Edited stub (one real rule added) injects again. Small unmarked doc still injects full body.

**Sizes (success criterion d):** injected conventions section 5,980 → 24,601 chars. Composed launch prompt ≈ WA 24.4k + conv (was 5.98k) + routing 2.4k + RF 6.4k + board 1.2k ≈ **40k before → ≈ 59k after** (≈ 10k → ≈ 14.7k tokens). Background moved out of injection: ~4.6k.

**Anti-regression:** verify:local-conventions 18/18, verify:onboard 51/0, verify-routing-inject 18/18, verify-feat-084-response-format-inject 37/0. `npm run gate` PASS (exit 0, typecheck clean). `npm run board:check` exit 0 (no drift). NOT run: verify-conventions-live (spawns real CLI sessions) — the compose-layer path it covers is exercised by verify:local-conventions.

**Open / handoff — a DECISION for the human, not a code gap:** the budget tension the ticket raises is genuinely unresolvable under "do not reword/delete rules": docs/CONVENTIONS.md is ~24k of *operative* rules (only ~4.6k was pure framing/history). So the marked region, to deliver every rule whole, is ~24k — the composed prompt grows to ~59k. The mechanism now lets the author shrink the injected size at any time by MOVING sentences into the background section with zero code change. Choose: (A) accept the larger injected size; or (B) authorize a condensing/rewording pass on the rules (a separate, riskier task this lane was forbidden from doing). The cap default for the marked path is 26000; lower it once the region is trimmed.

**Independent verify warranted:** yes — this touches instruction injection (what every launched session receives). A clean-room pass should confirm the marked-region extraction and stub detection against a realistic doc it did not author. Not marked VERIFIED here.

**Symptom of a deeper design flaw?** Suspected yes — the asymmetry the ticket names (shared WA injected whole at 24k while a project's own rules were cut to a fifth) plus "a rules doc that cannot fit any attention budget" suggests injection needs a per-doc budget policy, not per-call-site caps. Flagging for the orchestrator to weigh an ARCH ticket; not filed from this lane.

### 2026-10-01 — agent (fixing, round 2)

**Understood:** round 1 shipped the marked-region mechanism but left a `26000`-char
cap on the region path. Another session then expanded `docs/CONVENTIONS.md`
(+210/-76), growing the `conventions-inject` region to **26,454 chars** — just
over that cap — so `localConventionsSection()` silently truncated it and dropped
its trailing rule, the "Separate process, not a subagent" verification rule. This
contradicts the user decision recorded 2026-09-29: the marked region is DELIVERED
WHOLE, cap applies only to the no-markers fallback. Suite was 16/18 (the 2 reds:
"contains separate-process rule" MISSING, "region delivered WHOLE" truncated).

**Verified FIRST (hypothesis held):** the cap was exactly where the hypothesis
said — `templates.ts` `localConventionsSection()`, `const maxChars = … usingRegion
? 26000 : 6000`. Not elsewhere; the failure cause was precisely the region cap.

**Changed (unstaged, no git writes):**
- `src/server/templates.ts` — region cap `26000 → 65536` (64 KiB). The marked
  region is now delivered whole for any realistic doc; the bound is a generous
  safety stop against a runaway doc only, and if it ever fires it truncates
  LOUDLY on a markdown boundary with a visible notice (unchanged path), never a
  silent cut. Comment rewritten to cite the decision. Unmarked fallback stays 6000.
- `scripts/verify-bug-146-conventions-inject.mjs` — added 4 checks (18→22): a
  must-FAIL anchored to the FIXED old value `maxChars:26000` run on the REAL
  current doc (proves 26000 truncates the region AND drops the separate-process
  rule — the exact round-2 defect), plus a SAFETY leg (`maxChars:2000`) proving
  the loud-truncation path still fires a visible notice on a boundary, not a
  silent cut.
- Did NOT touch `docs/CONVENTIONS.md` (another session is actively editing it;
  `git diff` confirmed its +210/-76 is unchanged by this lane).

**Injected size (success criterion d):** region body 26,454 chars; injected
section **25,885 (truncated, pre-fix) → 26,798 (whole, post-fix)**. Composed
launch prompt grows ~913 chars vs the truncated state; the previously-dropped
separate-process rule now reaches every session. Region ends on its true tail
(`…\`scripts/dispatch.mjs\`).`), no TRUNCATED notice.

**Verification:** `node scripts/verify-bug-146-conventions-inject.mjs` **22/22
PASS** (was 16/18). `npm run gate` PASS (exit 0, leak-gate + typecheck clean).
`npm run board:check` exit 0 (advisory WARNs only, no drift).

**Independent verify warranted:** yes — touches instruction injection (what every
launched session receives). A clean-room pass should confirm the region is
delivered whole against a realistic doc and that the loud-truncation safety path
is not silenceable. Not marked VERIFIED here.

**Open / handoff:** the budget DECISION from round 1 still stands (injected region
is ~26k of operative rules; option A accept the size, or option B authorize a
condensing pass). This round only honoured the "delivered whole" half in code.

**Symptom of a deeper design flaw?** No new one beyond round 1's ARCH suspicion
(per-doc budget policy vs per-call-site caps). This round was a value the prior
fix left behind — `regressed-from: BUG-146 round 1` (the `26000` region cap it
introduced).

### 2026-10-01 — greyl33t
- **Verification recorded:** dispatch anthropic/claude-opus-4-8 run 9da3de75-365d-44cb-a5f0-c665d18f03aa — VERDICT: INVALID — r2 clean-room not-run: BUG-120 strips docs/CONVENTIONS.md (the artifact under test) so the fixer test fatals (exit 1) in the room; verdict INVALID, not a code defect. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — verify driver (round 2, class=verify)

**Clean-room verification NOT-RUN — structural infra conflict, not a code defect.**
Drove `scripts/independent-verify.mjs --working-tree` (grey Anthropic account; same
provider as the fixer — decorrelation reduced, noted as a fallback). Requirement
`/tmp/req-BUG-146-r2.txt` asked the verifier to confirm (1) the marked region is
delivered WHOLE at the current ~26.9k size (not cut at 6000 or the r1 26000 cap),
(2) the LOUD stop fires over the 65,536-byte cap on a markdown boundary and is not
silenceable, (3) the unmarked/stub fallback is unchanged.

**Outcome:** harness exit 3 — `VERDICT-CONTRACT: INVALID`. The verifier cited its
FIXER-TEST run (exited 1) yet answered HOLDS, which the contract rejects.

**Root cause is the clean room, not the fix.** BUG-120's `cleanroom-surface.mjs`
DELIBERATELY strips `docs/CONVENTIONS.md` (plus `docs/` methodology/board) so a
verifier cannot read our conventions. But that file IS the artifact BUG-146 fixes,
and `scripts/verify-bug-146-conventions-inject.mjs` reads it two ways —
`localConventionsSection(ROOT)` and `git show HEAD:docs/CONVENTIONS.md`. Confirmed
locally: with the doc absent `localConventionsSection` returns `null` (so the
"THIS repo" battery fails and the `fs.readFileSync(convRel)` leg throws FATAL), and
`git show HEAD:docs/CONVENTIONS.md` fatals against a snapshot that stripped `docs/`.
So the fixer test exits 1 inside the room for an environmental reason; the verifier
then returned an inconsistent HOLDS and the harness correctly marked INVALID.

**Status unchanged (open).** INVALID/not-run does not count as HOLDS, so this is
NOT verified. The round-2 fix itself is UNrefuted — on the real tree the suite is
22/22 and the region (26,964 chars) fits 65,536 whole / exceeds 26,000, exactly as
the fix claims; the clean room simply cannot exercise it.

**Handoff — ORCHESTRATOR DECISION.** The standard `--working-tree` clean-room path
cannot verify any ticket whose subject lives in `docs/CONVENTIONS.md`. Options to
land a valid HOLDS: (A) teach the clean-room surface to PRESERVE `docs/CONVENTIONS.md`
when it is the artifact under test (risk: hands the verifier our conventions text —
acceptable here since that text is the subject, not bias about the fix logic);
(B) parameterise the fixer test to point `localConventionsSection` / the `git show`
baseline at a realistic FIXTURE doc shipped under `scripts/fixtures/` (survives the
strip, still real-shaped), then re-dispatch. Recommend (B) — it keeps BUG-120's
strip intact. An independent clean-room verify remains WARRANTED (instruction
injection, every launched session) once the test is strip-survivable.

Verified-by: NOT VERIFIED — independent-verify run 9da3de75-365d-44cb-a5f0-c665d18f03aa returned INVALID (clean-room strips the artifact under test; see above). Recorded typed as verdict=invalid in the record's verification[].

### 2026-10-01 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run b9874b48-681b-4982-a835-039f90977f2d — VERDICT: BROKEN — r2 --allow-input docs/CONVENTIONS.md: real doc survived strip, fixer suite 22/22, VALID BROKEN. 3 loud-stop edge findings: CRLF over-cap cut mid-rule (:417); cap is UTF-16 chars not bytes (:387); blank-line-free over-cap block hard-slices mid-word (:418).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — verify driver (round 2 re-run, class=verify)

**Clean-room verification RAN and is VALID — VERDICT: BROKEN.** The round-1 verify
driver's INVALID was an infra artifact (BUG-120 stripped `docs/CONVENTIONS.md`, the
artifact under test). This run passed `--allow-input docs/CONVENTIONS.md` so the
REAL doc survived the strip (room manifest recorded it under `inputs given`), which
is exactly what the BUG-120 declared-input allow-list exists for. The real doc was
present and whole; the test was NOT repointed at a fixture.

**Harness:** `scripts/independent-verify.mjs --working-tree --allow-input
docs/CONVENTIONS.md --requirement @/tmp/req-BUG-146-r2.txt --run "node
scripts/verify-bug-146-conventions-inject.mjs" --test-file
scripts/verify-bug-146-conventions-inject.mjs --provider anthropic`. Grey Anthropic
account (same provider as the fixer — decorrelation reduced, noted as a fallback).
Harness exit 1 (BROKEN valid). Run id `b9874b48-681b-4982-a835-039f90977f2d`;
verifier model `claude-opus-5-5`.

**What HELD (the fix's core claim is unrefuted on the real doc):**
- FIXER-TEST re-run EXIT 0, **22/22** (manifest 681f503b2c7d). The verifier worked
  around the test's one env-coupled leg — `git show HEAD:docs/CONVENTIONS.md` at
  `verify-bug-146-conventions-inject.mjs:104` FATALs because the clean room is an
  archive+tar extract with no `.git`; the verifier ran `git init` + a local commit
  so the must-FAIL baseline became the current doc (noted in its UNTESTED). The
  real pre-fix-HEAD must-FAIL leg was therefore NOT reproduced in-room — a residual
  test-portability gap, not a fix defect.
- Property 1 (WHOLE DELIVERY): real region 26,964 chars / 27,142 bytes delivered
  entire, no TRUNCATED notice, trailing separate-process rule present; synthetic
  sweep 1k–65k all whole (adversarial run 3601d1ee9c7f, 39/39).
- Property 3 (FALLBACK/STUB): unmarked doc → capped 6000 full body + loud notice;
  unedited stub (incl. CRLF + trailing ws) → null; edited stub → injects. Unchanged.

**What BROKE — 3 findings, all on property 2 (the LOUD-STOP path), VALID BROKEN:**
1. **CRLF over-cap region cut mid-rule.** `cut()` (`src/server/templates.ts:417`)
   searches only `\n\n` for the boundary; a `\r\n\r\n` doc finds none and hard-slices
   mid-rule (kept tail `…text.\r\n\r\n- crlf rule 15`). Notice still fires, but the
   "ends on a markdown boundary, not mid-word" property fails. (adv run d6c541f2627b)
2. **Cap is UTF-16 chars, not bytes.** The 65,536 bound (`templates.ts:387`) compares
   string `.length`, so a 70,022-byte / 36,240-char multibyte region is delivered
   WHOLE — never silently cut, but it does not honour the stated "65,536-**byte**
   cap". (adv run 7620cce8135a)
3. **Single blank-line-free over-cap block hard-slices mid-word** before the notice
   (`templates.ts:418` fallback). Same boundary-property failure as (1).

**Assessment.** The real-world path (LF, ASCII, 27k doc) is correct and the fix's
central claim — region delivered whole, over-cap truncates loudly — holds for it.
The three findings are genuine boundary/encoding defects in the loud-stop path that
the fixer's fixture never exercised (CRLF, multibyte >64 KiB, no-blank-line block),
exactly the kind of case the clean room exists to surface. They are real code
defects, so the verdict is BROKEN and the ticket stays OPEN.

**Handoff — FIXER, round 3.** (a) `cut()` should also match `\r\n\r\n` (or normalise
CRLF before the boundary search) so the loud stop ends on a markdown boundary for
CRLF docs; (b) decide whether the cap is bytes or chars and make the comparison
match the name (`Buffer.byteLength` if bytes); (c) the no-blank-line hard-slice
should still end on SOME safe boundary or the notice should precede the cut. All
three are edges of the safety stop, not the primary delivery path. Also fold in
round-1's still-open budget DECISION (accept ~27k injected, or authorize a
condensing pass) and make `verify-bug-146-conventions-inject.mjs:104`
strip-survivable (it already runs under `--allow-input`; the `git show HEAD:` leg
does not, and the verifier had to `git init` around it).

Verified-by: BROKEN (not verified) — independent-verify run
b9874b48-681b-4982-a835-039f90977f2d, VERDICT-CONTRACT VALID, verdict=broken,
anthropic/claude-opus-5-5 (same-provider fallback). Recorded typed in the record's
verification[] via board-tool.

### 2026-10-01 — agent (fixing, round 3)

**Understood:** run `b9874b48` confirmed the CORE claim HOLDS on the real doc
(region delivered whole, 22/22) but found 3 VALID BROKEN edge defects, all on the
above-cap LOUD-STOP path that the real 27k LF/ASCII doc never exercises:
(1) a CRLF region found no `\n\n` boundary and hard-sliced mid-rule; (2) the cap
compared UTF-16 chars while its comment said bytes/"64 KiB"; (3) a doc with no
blank line hard-sliced mid-word.

**Changed (unstaged, no git writes):**
- `src/server/templates.ts` `localConventionsSection()`:
  - (1) LF-normalise the body before any measure/cut, reusing ARCH-006's
    `normalizeLineEndings` imported from `board.ts` (confirmed no import cycle:
    board.ts does not import templates.ts, nor do its deps). A CRLF region now
    has `\n\n`/`\n` boundaries for the cut to find. No-op for LF docs → the
    common-case output stays byte-identical.
  - (2) documented the cap UNIT as CHARACTERS (UTF-16 string length) — the same
    unit `full.length`/`body.length`/the notice already use. Deliberately not
    bytes: a multibyte region whose BYTES exceed the bound but whose CHARS do not
    is delivered whole (the safe direction). Removed the misleading "KiB"/byte
    wording. No behaviour change, just consistency + docs.
  - (3) `cut()` now cascades paragraph break → line break → word break (each only
    if it keeps >half the budget), hard-slicing only a single unbroken token.
    A no-blank-line region now ends on a line boundary, never mid-word.
- `scripts/verify-bug-146-conventions-inject.mjs`:
  - the `git show HEAD:` must-FAIL leg is now STRIP-SURVIVABLE: it checks for
    `.git` and try/catches `git show`, SKIPPING with a reason (not FATAL) in a
    clean-room export that has no `.git`. (This is the portability gap the
    verifier had to `git init` around.)
  - added must-FAIL-before / PASS-after legs for each of the 3 findings, each
    anchored to a FIXED synthetic baseline (`preFixKept` = the round-2 cut
    algorithm) — needs no git, no moving reference: finding 1 (CRLF),
    finding 3 (no blank line), finding 2 (bytes>cap/chars<cap → whole;
    chars>cap → truncates, proving the char unit). Suite 22 → 30 checks.

**Verification:** `node scripts/verify-bug-146-conventions-inject.mjs` **30/30
PASS** (the 3 pre-fix legs reproduce the exact mid-line/mid-word cuts; the fixed
function ends on a boundary in every case). `npm run gate` exit 0 (leak-gate +
typecheck clean — the board.ts import type-checks). `npm run board:check` exit 0.
Anti-regression: verify-routing-inject 18/0, verify-feat-084-response-format-inject
37/0, verify-onboard 57/0. Injected size on THIS repo unchanged (26,798 chars;
doc is LF so normalisation is a no-op).

**BUDGET DECISION recorded (closes round 1's open question).** The user decided
on **2026-09-29: accept the larger injected prompt (~27k chars for the conventions
section) so that every agent-facing rule reaches sessions — NO condensing/rewording
pass.** Round 1 had left this as an open A/B ("accept the larger size" vs
"authorize a condensing pass"); option A is taken. The marked region is delivered
whole; if an author ever wants to shrink what is injected they MOVE sentences
below the `conventions-inject:end` marker (zero code change), never trim rules.

**Independent verify warranted:** yes — still instruction injection. A clean-room
pass should re-confirm the 3 edge paths (CRLF, no-blank-line, multibyte>64 KiB)
and that the `git show` leg SKIPs (not fails) without `.git`. Not marked VERIFIED
here; prior verdict was BROKEN and must be re-run against this round.

**Symptom of a deeper design flaw?** No new one. `regressed-from: BUG-146 round 2`
(the CRLF/char-unit/no-blank-line edges that round's loud-stop path introduced).

### 2026-10-02 — greyl33t
- **Verification recorded:** dispatch anthropic/claude-opus-4-8 run c407d1bc-b23d-4e69-ac70-e783e0f7e5fc — VERDICT: HOLDS — r3 --allow-input docs/CONVENTIONS.md; same-provider grey acct (fallback). Harness exit 0, contract VALID. Fixer 28/28 +1 SKIP (git-HEAD leg skips w/o .git); adversarial 843/843 (no stray CR, dropped==total-kept, output<=cap, boundary end, no board.ts->templates cycle). 3 r2 loud-stop findings FIXED.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-02 — verify driver (round 3, class=verify)

**Clean-room verification RAN and is VALID — VERDICT: HOLDS.** This round re-ran
`scripts/independent-verify.mjs --working-tree` against the UNCOMMITTED round-3 fix,
passing `--allow-input docs/CONVENTIONS.md` so the REAL conventions doc (the artifact
under test) survived BUG-120's strip — recorded in the room manifest under `inputs
given`. Grey Anthropic account; SAME provider as the fixer (decorrelation reduced,
noted as a fallback). Harness exit 0; `VERDICT-CONTRACT: VALID`.

**Harness:** `--working-tree --allow-input docs/CONVENTIONS.md --requirement
@/tmp/req-BUG-146-r3.txt --run "node scripts/verify-bug-146-conventions-inject.mjs"
--test-file scripts/verify-bug-146-conventions-inject.mjs --provider anthropic`.
Run id `c407d1bc-b23d-4e69-ac70-e783e0f7e5fc`.

**What the verifier confirmed (all 4 requirement properties HELD):**
- FIXER-TEST re-run EXIT 0 — **28/28** checks + **1 SKIP** (manifest 7bb8f7571eb0). The
  `git show HEAD:docs/CONVENTIONS.md` must-FAIL leg SKIPped with its printed reason (the
  clean room is an archive+tar extract with no `.git`) rather than fatalling — confirming
  the round-3 strip-survivability change. The 2 checks that leg carries are the only
  difference from the 30/30 the fixer sees on the real tree with `.git`.
- Adversarial suite (`adv-bug146.mjs`, manifest 112f581092f5, EXIT 0) — **843/843**: CRLF
  normalisation leaves no stray `\r` at the cut; byte accounting `dropped == total − kept`;
  output length ≤ cap; kept text ends on a word/line boundary; paragraph→line→word cascade;
  out-of-marker text excluded; cap-boundary sweep; multibyte bytes>cap/chars<cap → WHOLE,
  chars>cap → truncates (unit is CHARACTERS). Load-order: `board.ts` reaches 6 local imports
  and NONE transitively import `templates.ts` — no cycle; board-first then
  session-config/agent-bridge/registry load with no TDZ/"cannot access before init".
- All three round-2 BROKEN findings (CRLF mid-rule :417, char-vs-byte cap :387, no-blank-line
  mid-word :418) are confirmed FIXED.

**UNTESTED (verifier, honest gaps, none blocking):** no full server boot (index.ts binds a
port — used static import-graph reachability + real consumer-module load instead); caps below
~665 chars (header+notice) not asserted (cannot occur at the 65536 default); tab-separated
words and a surrogate-pair emoji at a hard-slice point not probed (word step looks only for
' '). These are below-cap pathological caps and exotic tokens, not the real LF/ASCII path.

**Status → VERIFIED.** Standing HOLDS, no later BROKEN. Recorded as a typed `verdict=holds`
entry in the record's `verification[]` via board-tool (dispatch anthropic/claude-opus-4-8 run
c407d1bc). `--allow-input docs/CONVENTIONS.md` was used so the real artifact survived the strip.

Verified-by: HOLDS (VALID) — independent-verify run c407d1bc-b23d-4e69-ac70-e783e0f7e5fc,
VERDICT-CONTRACT VALID, verdict=holds, anthropic/claude-opus-4-8 (same-provider, grey account,
fallback). Recorded typed in the record's verification[] via board-tool; this prose line is an
echo, not proof.
