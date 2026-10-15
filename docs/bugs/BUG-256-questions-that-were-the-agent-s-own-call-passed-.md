```orchard-ticket
{
  "id": "BUG-256",
  "type": "bug",
  "title": "Questions that were the agent's own call passed the turn-end check",
  "summary": "Orchestrators kept stopping to ask you things that were theirs to decide. The turn-end check let any question through if it had a `decider:` line, whatever the line said. In 282 real asks across 71 sessions, about 45% were not yours to decide, and naming a decider did not change that share.",
  "impact_if_we_wait": "Every work request keeps stalling on questions like 'should I fix this?' or 'one more round?'. Each one costs you a reply turn. The cost recurs in every session, because the cause is the check itself and not any one session.",
  "current_need": "An independent check of the rescoped contract: a non-list LEADING decider code is blocked, a real stop with a consequence in any script passes, and a relabel is surfaced by ask-audit rather than claimed blocked.",
  "severity": "high",
  "area": "response-format gate",
  "reported": "2026-10-14",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-10-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "An ask whose decider is priority, spend, risk, none or any other word not on the hard-stop list is blocked once and told to decide.",
    "A hard-stop decider with no stated consequence is blocked once and asked for the consequence.",
    "A hard-stop decider with its consequence passes, including the real restart, git and product-fork asks from the measured corpus.",
    "Each turn's metrics record the decider tokens, so a later audit can measure the unnecessary-ask share again."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-137",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a13964-6e26-7cf3-872d-91ce57967682",
      "verdict": "broken",
      "verdict_on": "2026-10-14",
      "recorded_at": "2026-10-14T07:54:07.900Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Independent OpenAI clean-room, untangled HEAD+BUG-256 own-edits candidate. Contract VALID, manifest-backed. BROKEN: (a) joined-token bypass + spend->money relabel = TWO-BREAK -> design review; (b) Cyrillic consequence wrongly blocked. Detail in Activity log."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "009d60d0-f5aa-4d1b-b6a4-b61a5f5c080c",
      "verdict": "broken",
      "verdict_on": "2026-10-14",
      "recorded_at": "2026-10-14T08:36:36.843Z",
      "author": "verify lane (verifying r2)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "e65d82be7ee019d91ff69b698f5c6fc8c2eadfc671e30db6198abab5bcbae644",
      "verify_mode": "mixed-state",
      "note": "r2 clean-room re-verify, mixed BUG-256 candidate. Contract VALID, manifest-backed. BROKEN: NEW compound-token path (live-priority/live_ops -> lead=live, PASS) = 3rd break of (a), TWO-BREAK design review [HIGH]; ask-audit split [MED]. r1's 3 breaks FIXED. OpenAI quota -> Anthropic. See Activity log."
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

# BUG-256 — Questions that were the agent's own call passed the turn-end check

## Diagnosis

regressed-from: FEAT-137. FEAT-137 made every `orchard-ask` declare `confidence:` and `decider:`. The check in `scripts/lib/format-metrics.mjs` (`DECIDER_RE`) accepts any non-empty text after `decider:`. One real ask passed with `decider: none`. The vocabulary it advertised (taste, priority, spend, risk, direction) also fits almost any question. `priority (whether to spend on it now)` turned 'should I fix the bug I found?' into a valid ask.

## Evidence

See `docs/research/unnecessary-asks-2026-10-14.md`. N = 282 asks from 71 orchestrator sessions (2026-08-03 to 2026-10-13). 126 were not the user's to decide. Of the asks that named a decider, 71 of 160 were unnecessary. Of those that did not, 55 of 122 were. Decider words on the unnecessary asks: priority 25, risk 21, spend 10, direction 9, taste 6. OpenAI refutation run 01a13949: P1 MODIFY, i.e. a closed list plus a required consequence, keeping info and blocked as paths.

## Implementation notes

A closed hard-stop list in `format-metrics.mjs`. The first token of the decider must be on the list, and the rest of the line must state the consequence (at least three words). Each ask yields a `decider-not-hard-stop` or `decider-no-consequence` defect, and the gate blocks on it once (the existing one-correction cap). Metrics record `deciderTokens`. The spec text is in RESPONSE_FORMAT.md and WA §A. `scripts/ask-audit.mjs` re-measures the share from transcripts.

## Verification plan

`node scripts/verify-bug-256-hard-stop-decider.mjs` must FAIL on the pre-fix code and PASS after. Re-run `verify:feat-137-138` and `verify-bug-192`. An independent clean-room round should replay the real asks from the corpus through the hook.

## Risks

A model can relabel an ask under a hard-stop word. The required consequence makes that visible in an audit, but it cannot prevent it. A session launched before the spec change is blocked once per old-style ask until it relaunches.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-14 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-14 — finding lane (round 1)
- **Built; independent verify owed:** regressed-from: FEAT-137 (its decider check accepted any text). Measured N=282 asks / 71 sessions; analysis in docs/research/unnecessary-asks-2026-10-14.md. Refuted cross-provider: OpenAI run 01a13949-5094-7161-bdee-4954fda87510 (P1 MODIFY: closed list + required consequence, keep info/blocked paths) — applied. Changed: scripts/lib/format-metrics.mjs (HARD_STOPS, deciderOf, two new defects, deciderTokens/asksNotHardStop/asksNoConsequence telemetry), scripts/hooks/response-format-gate.mjs (block messages), docs/prompts/RESPONSE_FORMAT.md (decider spec; core 6185 B, under the 6200 budget), scripts/verify-feat-137-138-enforcement.mjs (withEvidence fixture risk→outward), new scripts/verify-bug-256-hard-stop-decider.mjs (verbatim corpus asks), new scripts/ask-audit.mjs (re-measurement). Must-FAIL: verify-bug-256 13/26 FAIL pre-fix → 26/26 PASS. Anti-regression: verify-feat-137-138 19/19, verify-bug-192 15/15, verify-feat-085-stop-hook 61/61, verify-feat-150 11/11, verify-bug-177 18/18, verify-feat-091-response-blocks 330/330, verify-feat-091-renderer 211/211, verify-feat-084-response-format-inject 37/37, verify-codex-instructions 14/14, verify-arch-016 38/38. Pre-existing and identical on a pristine HEAD export: verify-feat-085-adversarial G5 (digest position) and verify-bug-118 C1 (child PATH check). Corpus replay: blocks 46/126 unnecessary asks the old check passed; also blocks 55 legit asks once (mostly restarts labelled risk) until sessions relaunch with the new spec. npm run gate PASS. NOT verified: live sessions under the new spec; prose asks outside orchard-ask are not seen. High-stakes bucket (Stop hook, regression history BUG-192): an independent clean-room verify is warranted.

### 2026-10-14 — dispatch openai
- **Verification recorded:** dispatch openai run 01a13964-6e26-7cf3-872d-91ce57967682 — VERDICT: BROKEN — Independent OpenAI clean-room, untangled HEAD+BUG-256 own-edits candidate. Contract VALID, manifest-backed. BROKEN: (a) joined-token bypass + spend->money relabel = TWO-BREAK -> design review; (b) Cyrillic consequence wrongly blocked. Detail in Activity log.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-14 — verify lane (verifying r1, independent clean-room → BROKEN)
- **Independent OpenAI clean-room verify of an untangled HEAD+BUG-256 own-edits-only candidate; VERDICT BROKEN (two-break → design review):** The working tree was an 800KB+ multi-ticket blend, so a decorrelated BUG-256-only candidate was built: `git archive HEAD` into /tmp/cand-bug256, then only BUG-256's own hunks applied (format-metrics.mjs, response-format-gate.mjs, RESPONSE_FORMAT.md, verify-feat-137-138 fixture) plus the two new files (verify-bug-256, ask-audit.mjs); two-commit scratch repo (baseline=pristine HEAD, HEAD=candidate), range HEAD~1..HEAD. No real-repo git writes (throwaway /tmp fixture, real binary). Candidate smoke-ran before dispatch: verify-bug-256 26/26, verify-feat-137-138 19/19, verify-bug-192 15/15.
- Dispatch: `scripts/independent-verify.mjs --provider openai`, run 01a13964-6e26-7cf3-872d-91ce57967682. Contract VALID (manifest-backed; adversarial cases joined-token-bypass, relabelled-agent-effort, unicode-consequence). Diff shown to verifier: 5/6 paths (RESPONSE_FORMAT.md stripped as docs).
- BREAK 1 — joined-token bypass [HIGH], property (a): `deciderOf` picks the hard stop with `tokens.find(t => HARD_STOPS.includes(t))` — ANY token, not the FIRST. So an agent-owned ask `decider: priority/live — …` or `decider: none,git — …` passes the real Stop hook despite a disallowed LEADING token. The spec/comment say "first token must be on the list"; the code does not enforce that. `buildRecord` then records the hard-stop token (live/git), hiding the true lead (priority/none) from the re-measurement audit.
- BREAK 2 — relabel [two-break], property (a): `spend → money` relabels an agent-effort testing ask ("running tests costs effort") into a pass. Property (a) broke via TWO distinct paths (joined-token + relabel) → per the standing two-break clause, routed to independent DESIGN REVIEW rather than another guard patch.
- BREAK 3 — unicode consequence [MED], property (b): the consequence word-count regex `[A-Za-z0-9$…]` matches no Cyrillic, so a 5-word Cyrillic restart consequence counts as 0 words and a LEGITIMATE live-restart stop is wrongly blocked (defect `decider-no-consequence`).
- UNTESTED (verifier-flagged): baseline must-FAIL could not run in-room (the clean room is a non-git working copy, no HEAD~1); the candidate-side breaks stand independently of that. AskUserQuestion and the board decide-tool execution paths were not exercised (attacks went through orchard-ask bodies via the real Stop hook).
- Verdict recorded in verification[] (openai, run 01a13964…, BROKEN). Ticket stays open; two-break → independent design review of the decider model (first-token enforcement, telemetry of the true lead token, and a unicode-aware consequence count).

### 2026-10-14 — design-review lane
- **fixing r2:** **Design review (non-author, WA §N) → RESCOPE + two bounded code fixes; built; independent verify owed.** regressed-from: FEAT-137 (r1 of this ticket was BROKEN by the clean room, run 01a13964).
  - DECISION: the turn-end check validates the DECLARATION, not its truth. It stops casual and accidental agent-owned asks (no decider, a non-list LEADING code, no consequence) and records the true lead code. A relabel under a list code with a stated consequence (B2, spend→money) passes BY DESIGN and is measured, not claimed prevented.
  - Why REDESIGN (typed ask with per-stop anchors: restart names the command, git names files, outward names the target) loses: the anchor is agent-written text too, as cheap to fake as the label, so truth-checking does not move; and every per-stop grammar adds false blocks on real stops (a restart phrased without a command, an outward with no URL, a non-English line), which hurts a user who wants autonomy more than a passed relabel (one extra reply).
  - Why KEEP-PATCHING loses: relabel detection over free prose is enumeration that a model phrases around. Each detector is another false-block surface (B3 was exactly that harm) and another verify round, and it claims a property it cannot hold.
  - Plan review (cross-provider): OpenAI run 01a13974-b4a3-7fa2-83b5-894e05fab099, PLAN-VERDICT MODIFY. Applied: complete-token header parsing (`live2`, `live`+Cyrillic а, `live`+ZWSP+`priority` are not `live`; it reproduced all three on the plain first-token fix); `live/priority` passes on purpose (first code is the declaration); deterministic word count via Intl.Segmenter, not a 2-chars-per-word guess; the audit is a REVIEW SIGNAL, not a relabel rate: affirmative ("yes") split from delegated-back ("do what you recommend"), "yes, but…" excluded, replied denominators, first-block coverage reported. Declined: requiring an explicit separator after the code, because it adds false blocks on real stops written `decider: live restarting ends…`.
  - Changed: scripts/lib/format-metrics.mjs (deciderOf: complete-token header, lead-only hard stop, consequenceWordCount via Intl.Segmenter; buildRecord deciderTokens = true lead), scripts/hooks/response-format-gate.mjs (block text: the first code counts), scripts/ask-audit.mjs (byStop review signal, AFFIRM/DELEGATE/QUALIFIED split, --stop filter, multiAskTurns), docs/prompts/RESPONSE_FORMAT.md (first-code rule + honest limit, non-core section), scripts/verify-bug-256-hard-stop-decider.mjs (+18 r2 checks [5]-[7]).
  - Must-FAIL: the r1 deciderOf/ask-audit restored in a scratch copy (/tmp/bug256-257/r1-256) → verify-bug-256 11 FAIL / 33 PASS (priority/live, none,git, risk + live, live2, liveа, live+ZWSP passed; telemetry hid `priority`; Cyrillic and Chinese restarts blocked; no per-stop audit) → 44/44 PASS after.
  - Real artifact: replayed the real transcript store (283 asks, 232 orchard-asks) through the r1 and r2 checks: 0 verdict changes, so no new false block on real asks. Limitation: the audit clips ask bodies at 600 chars.
  - Anti-regression: verify-feat-137-138 19/19, verify-bug-192 15/15, verify-feat-085-stop-hook, verify-feat-150, verify-bug-177, verify-feat-091-response-blocks 330/330, verify-feat-091-renderer, verify-feat-084 37/37, verify-codex-instructions 14/14, verify-arch-016: all exit 0. npm run gate PASS.
  - AMENDED success criteria (supersede the record's list for verification): (1) an ask whose LEADING decider code is not on the hard-stop list is blocked once and told to decide; (2) a hard stop with no consequence (counted in any script) is blocked once; (3) a hard stop with its consequence passes, including non-Latin consequences and a joined lead such as live/git; (4) metrics record the true lead code; (5) a relabel under a list code is NOT prevented, by design, and ask-audit reports a per-code delegated-back review signal for human adjudication. Enforcement is one correction per turn and does not guarantee eventual compliance; no claim of fewer unnecessary asks until a post-change audit.
  - NOT verified: live sessions under the new spec; prose asks outside orchard-ask. High-stakes bucket (Stop hook, regression history FEAT-137/BUG-192): an independent clean-room verify is warranted.

### 2026-10-14 — verify lane (verifying r2)
- **Verification recorded:** dispatch anthropic run 009d60d0-f5aa-4d1b-b6a4-b61a5f5c080c — VERDICT: BROKEN — mixed-state candidate e65d82be7ee0 — r2 clean-room re-verify, mixed BUG-256 candidate. Contract VALID, manifest-backed. BROKEN: NEW compound-token path (live-priority/live_ops -> lead=live, PASS) = 3rd break of (a), TWO-BREAK design review [HIGH]; ask-audit split [MED]. r1's 3 breaks FIXED. OpenAI quota -> Anthropic. See Activity log.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-14 — verify lane (verifying r2, independent clean-room → BROKEN)
- **independent clean-room re-verify of the r2 RESCOPE contract; VERDICT BROKEN (two-break → design review):** Candidate: a decorrelated mixed-state BUG-256-only freeze (6 own files, 0 foreign hunks) against pristine HEAD; harness candidate e65d82be7ee0. Smoke-run before dispatch: verify-bug-256-hard-stop-decider 44/44, verify-feat-137-138-enforcement 19/19, verify-bug-192-stop-hook-race-and-length 15/15 (all exit 0). Dispatch: scripts/independent-verify.mjs, run 009d60d0-f5aa-4d1b-b6a4-b61a5f5c080c; VERDICT-CONTRACT VALID (adversarial case compound-token-and-audit-split; manifest-backed). PROVIDER: OpenAI attempted first but hit its quota window mid-run (resets ~15:15); switched to Anthropic (Claude Opus) per charter/standing guidance — SAME-PROVIDER as the likely-Claude fixer, NOT cross-provider: an OpenAI cross-provider re-run is warranted once quota resets. BREAK 1 [HIGH], property (a)+(4), NEW complete-token path: decider 'live-priority — restarting ends every running session' parses lead=live, hardStop=live, PASSES, and telemetry records 'live' (not the compound). Same for live.priority / live:priority / live'priority / live_ops / live—priority. Cause: DECIDER_TOKEN treats - . : ; ' _ – — as token terminators, so a live-prefixed compound reads as the bare code 'live' — inconsistent with live2/homoglyph/ZWSP which r2 correctly blocks. Reproduced directly against live code. This is a THIRD distinct break of property (a) after r1's joined-token + relabel → TWO-BREAK: route to independent DESIGN REVIEW, not another guard (making -/— token-chars would false-block legit 'decider: live—restarting…'). BREAK 2 [MED], property (5), ask-audit split: 'yes, do what you recommend' counted as BOTH affirmative AND delegated (overlap, not a split); 'yes — but not on main' (em-dash) counted affirmative instead of excluded (QUALIFIED only matches comma-before-but). Review signal for humans, not an enforcement gate → lower stakes, but violates the stated split/exclusion contract. HELD (r1's breaks all FIXED): joined-token (priority/live→blocked, none,git→blocked), unicode consequence (Cyrillic + Chinese 'live' consequences PASS), true-lead telemetry for joiner cases, homoglyph/ZWSP dodges (live2/liveа/livé/live+ZWSP) all blocked, malformed decider values (null/number/object/array/Symbol) → decider-not-hard-stop with no crash. UNTESTED: cross-provider (OpenAI) verdict (quota); Intl.Segmenter-absent fallback (this Node has full ICU); board-tool decide --decider end-to-end (shares hardStopDefect, only direct-called); hook's documented FAIL-OPEN paths (out of BUG-256 scope). NOTE: the lane's first OpenAI run 01a13983 also returned BROKEN but its findings were dominated by a requirement-composition error (mis-stated hard-stop list, hook fail-open out of scope) and are NOT real defects; the real list is {irreversible,outward,live,git,access,money,taste,direction,info,blocked}; re-run with corrected requirement gave the authoritative verdict above. High-stakes bucket (Stop hook, FEAT-137/BUG-192 regression history): this IS the independent clean-room pass; the compound-token break now owes an independent DESIGN REVIEW.

### 2026-10-14 — orchestrator (adjudication, non-author)
- **BUG-256 ADJUDICATION (orchestrator, non-author, 2026-10-14):** third break of the decider parse via compound tokens (`live-priority`, `live_ops` → lead=live). Decision: REDESIGN the parse from token-matching to an EXACT grammar. The decider value must equal one closed-list code exactly: the whole value after `decider:`, trimmed, case-folded, nothing else on the line. Anything else, including compounds, separators, multiple codes or trailing words, is INVALID: the ask is blocked with a message naming the valid codes. No more lead-token or split heuristics. This converges because it is an allowlist of whole values, not an enumeration of bad shapes. Also fix ask-audit's affirmative/delegated overlap and its em-dash handling. Real stops are unaffected: their declaration is just one exact code. Test that again across scripts and languages.

### 2026-10-14 — fixing lane (round 3, final)
- **fixing r3: EXACT GRAMMAR built per the adjudication above; independent verify owed.** regressed-from: BUG-256 r2 (its complete-token parse let `live-priority` / `live_ops` read as `live`; clean room 009d60d0) and r1 (joined tokens, 01a13964); original regressed-from FEAT-137.
  - PARSER CHANGE (stated precisely for BUG-259, which shares it): `scripts/lib/format-metrics.mjs` `deciderOf(content)` now reads TWO lines. The `decider:` value is the whole rest of that line, `.trim()`-ed and `.toLowerCase()`-d, and `hardStop` is set only if it EQUALS one HARD_STOPS code (new export `hardStopCode(value)`). No tokens, no header, no lead split: `DECIDER_WRAP` / `DECIDER_TOKEN` / `DECIDER_HEAD_RE` are deleted, and the result no longer has `header` / `tokens`. `lead` is now the whole case-folded value, used as telemetry. The consequence comes ONLY from a separate `consequence:` line (`CONSEQUENCE_RE`). `consequenceWords` counts that line with Intl.Segmenter. `hardStopDefect` is unchanged. CONSEQUENCE FOR BUG-259: `board-tool decide --decider="live — <consequence>"` (board-tool.mjs:1040 builds `decider: ${raw}`) is now refused as not-hard-stop. BUG-259 must pass the code and the consequence separately, e.g. `deciderOf(\`decider: ${code}\nconsequence: ${text}\`)` with a `--consequence` flag. verify-bug-259-decide-gate-own currently fails 5/46 (G6, G6 rail, G7, G8, O2) for this reason alone. RESPONSE_FORMAT.md:434-436 (the board-tool line, BUG-259's) still says `--decider="<stop> — <consequence>"`; I left it to that lane.
  - Spec change, not a no-op: the r2 spec had stops write `decider: live — restarting…` on ONE line, so "nothing else on the line" moves the consequence to its own `consequence:` line. That changes the format for real stops: RESPONSE_FORMAT.md core line 121 and the decider section are updated, and a session launched on the old spec is blocked once per old-style ask until it relaunches. Real artifact: I replayed all 358 orchard-ask blocks in the real transcript store through r2 and r3. 14 that r2 passed are now blocked, all from before the BUG-256 spec (`direction (you do all git writes)`, `taste (what you want…)`); every other verdict is unchanged.
  - Hook (`scripts/hooks/response-format-gate.mjs`): the not-hard-stop block now says the line must be EXACTLY one code and names all ten; the no-consequence block asks for a `consequence:` line.
  - ask-audit (`scripts/ask-audit.mjs`): `replyClass()` gives ONE class per reply in the order qualified > delegated > affirmative. So "yes, do what you recommend" counts as delegated only, with no overlap. QUALIFIED now accepts any punctuation (em/en dash, colon, ellipsis, none) between the first word and but/except/only/unless/not, so "yes — but not on main" is excluded. The decider column is clipped at 40 chars.
  - Must-FAIL: I rebuilt the r2 parser, hook and audit in /tmp/b256r3/r2 by reversing exactly my hunks, and confirmed it reproduces `live-priority` → hardStop=live. On r2: verify-bug-256 **37 passed / 66 failed**. The break-specific failures are 20 compound/separator values allowed (live-priority, live_ops, live.priority, live:priority, live'priority, live—priority, live–priority, live/git, live/priority, live,git, live git, live live, live., live!, **live**, `live`, (live), "live", `live — …`, live (restart)) and the audit check (overlap + em-dash). The rest are the format change. After the fix: **103/103 PASS**. That includes 31 non-exact values blocked with all ten codes named (ZWSP, Cyrillic/fullwidth homoglyphs, Turkish İ, Russian/Chinese code words, `hard stop: live`, empty), all 10 exact codes passing, case-fold and trim (LIVE, Live, padded, tab), CRLF, and consequences in Russian, Chinese, Japanese, Korean, Arabic, Hindi, Greek, Thai, German and Hebrew.
  - Anti-regression: verify-feat-137-138 19/19 (two fixtures moved to a `consequence:` line), verify-bug-192 15/15, verify-feat-085-stop-hook 61/61, verify-feat-150 11/11, verify-bug-177 18/18, verify-feat-091-response-blocks 330/330, verify-feat-084 37/37 (core budget held), verify-codex-instructions 14/14, verify-arch-016 38/38. verify-bug-259 41/46 (rebase owed, above). npm run gate PASS (exit 0).
  - NOT verified: live sessions under the new spec; prose asks outside orchard-ask. High-stakes bucket (Stop hook; FEAT-137/BUG-192/r1/r2 history): an independent clean-room verify is warranted, cross-provider when OpenAI quota allows.

### 2026-10-14 — verify lane (r3, PAUSED for quota)
- **verify r3 paused for quota, 2026-10-14.** The r3 clean-room verify ran and a verdict was OBTAINED but is NOT recorded (paused so Claude quota goes to BUG-255; an OpenAI cross-provider re-run is owed once quota resets ~15:15). Resume pointers: candidate `fec0d3f78b9593b941b88291383165572ec8aba46218c7d565d99485a022d9f3` (mixed-state, 5 frozen files, 0 foreign hunks; base 1a68e57b5165 → tree 76633e02ef03); run `5e0f5d29-eb41-4172-a2a2-bffe4fd3a42f` (provider anthropic — OpenAI quota-exhausted fallback, SAME-provider as the likely-Claude fixer, so an OpenAI cross-provider pass is still owed). Artifacts: /tmp/b256r3-verify/requirement.txt, /tmp/b256r3-verify/verdict-anthropic.txt, /tmp/b256r3-verify/dispatch-anthropic.log. Smoke-runs pre-dispatch (live tree): verify-bug-256 103/103, verify-feat-137-138 19/19, verify-bug-192 15/15.
