```orchard-ticket
{
  "id": "BUG-276",
  "type": "bug",
  "title": "canonCmd/normCmd collapses whitespace inside quoted args — citation-identity false-match",
  "summary": "normCmd in scripts/lib/verdict-contract.mjs does .replace(/\\s+/g,' ') over the whole command, collapsing whitespace INSIDE quoted args, not just between tokens. canonCmd/sameCmd/bareCmd build on it, so two commands differing only by quoted-internal whitespace (--grep \"a  b\" vs \"a b\") canonicalize equal and are judged identical. Pre-dates BUG-273 (BUG-066 code); found in r4 review.",
  "impact_if_we_wait": "Low but real: a cited command whose quoted arg differs from the supplied one only by internal whitespace is accepted as identical, so citation-identity can pass on a subtly different arg. Few fixer-test commands carry quoted whitespace, so blast radius is small — a latent hole, not an incident.",
  "current_need": "Resolved won't-fix-as-filed: the inner-quoted-whitespace tolerance in normCmd is an accepted, N=0-harm limitation (documented at normCmd). Do NOT re-attempt a quote/env parser — it broke 4 times across 2 rounds (BUG-273 class).",
  "severity": "low",
  "area": "Verification harness / verdict contract",
  "reported": "2026-10-25",
  "reported_by": "design reviewer (BUG-273 r4, non-author)",
  "owner": "unassigned",
  "work_state": "not_a_bug",
  "human_action": "none",
  "updated": "2026-10-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "normCmd collapses only whitespace OUTSIDE single/double quotes; whitespace inside a quoted token is preserved.",
    "sameCmd('node t.mjs --grep \"a  b\"', 'node t.mjs --grep \"a b\"') is FALSE (distinct quoted args).",
    "Existing BUG-066 env-prefix canonicalization and hole #19 bareCmd distinctness behaviour are unchanged (regression suite green).",
    "Must-FAIL: pre-fix the two-space/one-space pair compares equal; post-fix it does not."
  ],
  "code_refs": [
    {
      "path": "scripts/lib/verdict-contract.mjs",
      "symbol": "normCmd",
      "note": "the blunt /\\s+/->' ' collapse that reaches inside quotes"
    },
    {
      "path": "scripts/lib/verdict-contract.mjs",
      "symbol": "canonCmd",
      "note": "citation-identity; builds on normCmd"
    }
  ],
  "related": [
    {
      "id": "BUG-066",
      "relation": "see_also"
    },
    {
      "id": "BUG-273",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a1708e-bdf2-7b02-aaa5-1e8ed6196a22",
      "verdict": "broken",
      "verdict_on": "2026-10-25",
      "recorded_at": "2026-10-25T00:59:01.817Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "8b79947a58ae4f89fdedd28752ce29025eb7597bce1dd05f350e34fd0941c0f6",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "openai",
      "model": "codex",
      "run_id": "01a170a2-51d2-7702-ab7a-f3c875a69077",
      "verdict": "broken",
      "verdict_on": "2026-10-25",
      "recorded_at": "2026-10-25T01:19:27.302Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "0539d0f6578f6d2af7b63e30548d51ee58a0ff9e312b2d40876cca90c2912b97",
      "verify_mode": "mixed-state"
    }
  ],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": false,
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

# BUG-276 — canonCmd/normCmd collapses whitespace inside quoted args — citation-identity false-match

## Diagnosis

`normCmd` (scripts/lib/verdict-contract.mjs ~line 293):

```
const normCmd = (c) => (c ?? '').trim().replace(/\s+/g, ' ').replace(/^["']|["']$/g, '');
```

The `/\s+/g -> ' '` runs over the entire string, so whitespace INSIDE a quoted argument is collapsed along with inter-token whitespace. `canonCmd`, `sameCmd` and `bareCmd` all tokenize the result of `normCmd` by splitting on single spaces, so they inherit the collapse. Two commands differing only by internal quoted whitespace therefore canonicalize to the same string and match.

This is the single CITATION-IDENTITY authority (BUG-066): it answers "did the verifier run the command the harness supplied?" A false-match means a subtly different quoted arg is accepted as the supplied command.

## Evidence

Surfaced during BUG-273 r4 design review of the fixer-test citation path. Not a BUG-273 cause — BUG-273's r4 fix is in providerAbortKind/dispatch meta, unrelated to this. Filing separately so it is tracked and does not widen BUG-273's scope.

## Implementation notes (engineer-ready fix spec)

1. Replace the blunt whitespace collapse in `normCmd` with a quote-aware normalization: walk the string, and collapse runs of whitespace to a single space ONLY when not inside a single- or double-quoted span; leave whitespace inside quotes verbatim. Keep the existing `.trim()` and outer-quote strip semantics.
2. Keep the downstream `split(' ')` token model in `canonCmd`/`bareCmd` — once inter-token whitespace is single-spaced and intra-quote whitespace preserved, splitting on a single space still over-splits a quoted token containing a space. So either (a) tokenize quote-aware in one helper and return tokens for both `canonCmd` and `bareCmd`, or (b) accept that the env-prefix detection only inspects LEADING tokens (which are `NAME=value`/`env`, never quoted) and only the `rest` join must preserve the original quoted spacing. Prefer (a): one quote-aware tokenizer feeding normCmd, canonCmd, bareCmd.
3. Do NOT change env-prefix identity (BUG-066) or bareCmd distinctness (hole #19): assignments still participate in canonCmd identity and are still stripped in bareCmd. Only the whitespace-inside-quotes handling changes.
4. Add must-FAIL cases to the verdict-contract suite: `sameCmd('x --grep "a  b"','x --grep "a b"')` FALSE; a byte-identical pair still TRUE; env-prefix and hole #19 cases unchanged.

## Risks

Low. The change tightens identity (fewer false matches), so the only regression risk is a legitimately-identical command that previously matched now failing to — avoided by preserving inter-token single-spacing. Run the full verdict-contract / BUG-066 suite as anti-regression.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-25 — design reviewer (BUG-273 r4, non-author)
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-25 — fix lane (BUG-276 fixing r1)
- **Fix:** `scripts/lib/verdict-contract.mjs`. Replaced the blunt `/\s+/g -> ' '`
  collapse inside `normCmd` with a new quote-aware helper `collapseUnquotedWs`
  that collapses whitespace runs ONLY outside single/double-quoted spans and
  preserves intra-quote whitespace verbatim. `.trim()` and the outer-quote strip
  are unchanged. `canonCmd`/`bareCmd`/`sameCmd`/`sameProgram` are untouched: their
  downstream `split(' ')`/`join(' ')` token model still works because that pair is
  lossless w.r.t. normCmd's output and env-prefix detection only inspects LEADING
  tokens (always `NAME=value`/`env`, never quoted). This is the smallest correct
  rule: command IDENTITY needs only quote-state to tell a structural separator
  from a literal argument char — not a shell parser (BUG-273 deleted a brittle
  tokeniser; none is reintroduced).
- **Hypothesis verified:** audited every caller of `normCmd`/`canonCmd`/`bareCmd`/
  `sameCmd`/`sameProgram` (in verdict-contract.mjs and the external referencers
  independent-verify.mjs / verify-bug-273-iv-infra.mjs / verify-independent-
  verification.mjs). ALL are command-identity comparisons (citation matching,
  distinctness) plus display truncation; NONE rely on in-quote whitespace
  collapsing. Same semantics wanted everywhere — no caller needed to STOP.
- **Must-FAIL proof:** a probe driving the real production path (`validateVerdict`
  RAN-vs-manifest `sameCmd`): pre-fix `--grep "a  b"` vs `--grep "a b"` raised NO
  RAN-mismatch (falsely accepted as identical); post-fix it IS a mismatch
  (distinct). Byte-identical, inter-token-whitespace, and BUG-066 env-prefix pairs
  still match both pre- and post-fix (no over-tightening).
- **Anti-regression (confined runner — scratch git needs it):**
  verify-independent-verification 152 PASS / 1 FAIL where the 1 FAIL is the
  pre-existing, unrelated relative-symlink-containment test (identical FAIL set
  and no PASS lost vs pre-fix baseline); BUG-066 and HOLE #19 cases PASS.
  verify-bug-273-iv-infra EXIT 0 (its own must-FAIL anchor intact).
  verify-bug-097 16/16. verify-bug-225 95/0. `npm run gate` PASS (exit 0).
  verify-bug-125 fails on ticket-corpus/provenance checks (0 references to any
  command-identity helper — categorically independent) and board:check's 1 DRIFT
  (FEAT-170) + STALE WARNs are pre-existing and unrelated.
- **Left UNSTAGED** for the user to commit: `scripts/lib/verdict-contract.mjs` and
  this ticket.

### 2026-10-25 — dispatch openai
- **Verification recorded:** dispatch openai run 01a1708e-bdf2-7b02-aaa5-1e8ed6196a22 — VERDICT: BROKEN — mixed-state candidate 8b79947a58ae. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-25 — design reviewer (BUG-276 r2, non-author for this two-break)
- **Decision: RESCOPE to byte-equality (abandon the collapse entirely).** The r1
  BROKEN verdict found two breaks in the quote-aware `collapseUnquotedWs` — an
  escaped `\"` desynced the quote tracker (a real quoted double-space collapsed
  because the tracker thought the quote had closed), and a backslash-escaped
  space (`cp a\ b`) read as a token separator. Both are the SAME class BUG-273
  just deleted a parser for: hand-tracking shell text is enumerated by
  construction and the enumeration is never complete. Patching case-by-case
  would keep that treadmill. The structural fix removes the need for ANY
  whitespace tolerance inside the command.
- **Evidence (N = 0) — the in-command whitespace tolerance is dead weight.**
  Audited every place the identity comparison gets its inputs:
  - The clean-room RECORDER (`scripts/independent-verify.mjs` `handleRequest`,
    ~line 1221) records `String(req.cmd ?? '').trim()` — it `.trim()`s and does
    NO inner-whitespace change. So the manifest's `entry.cmd` preserves the exact
    bytes the verifier submitted.
  - The cited `RAN:` and the harness `knownRuns` originate from the SAME
    harness-supplied command string the verifier was told to run verbatim
    ("the exact command … one of the commands given to you").
  - The ONLY transformation the pipeline introduces between the two sides is the
    recorder's `env`-prefix normalization (`FOO=1 x` → `env FOO=1 x`, BUG-066).
  - `docs/bugs/verification-ledger.json` stores only `line_sha256`, no command
    text — nothing there depends on collapsing.
  - The BUG-066 / HOLE #19 / BUG-097 / BUG-225 suite fixtures use
    single-spaced commands; NONE rely on inner- or inter-token collapsing to
    match (confirmed: all pass post-RESCOPE — see build).
  So zero real citations — and only the now-removed collapse's own synthetic
  cases — ever matched ONLY because of inner-whitespace collapsing. Hypothesis
  from the charter CONFIRMED: no collapsing is needed anywhere.

### 2026-10-25 — fix lane (BUG-276 fixing r2, RESCOPE)
- **Fix:** `scripts/lib/verdict-contract.mjs`. Deleted `collapseUnquotedWs`
  entirely. `normCmd` is now trim-only + the existing outer-quote strip:
  `(c ?? '').trim().replace(/^["']|["']$/g, '')` — NO inner-whitespace
  normalization, so there are no quoting/escaping semantics to get wrong.
  Command identity is byte-equality after trim (+ BUG-066 env prefix). Added one
  helper `splitEnvPrefix(s)` that peels leading `env`/`NAME=value` tokens off the
  front (matching only the leading `\S+ ` run, which is `NAME=value`/`env` and
  never carries inner whitespace) and returns `{assigns, rest}` with `rest`
  BYTE-PRESERVED (captured whole, never re-tokenized/re-joined). `canonCmd` and
  `bareCmd` now call it instead of `s.split(' ')`, so the command BODY keeps its
  exact bytes (quoted spaces, double spaces, escaped chars all intact). BUG-066
  canonicalization (assignments sorted, participate in identity) and HOLE #19
  distinctness (`bareCmd`/`sameProgram` strip all assignments) are unchanged.
- **Must-FAIL proof (real production path, `validateVerdict` FIXER-TEST
  RAN-vs-manifest + knownRuns pin; synthesized, not anchored to HEAD):** pre-fix
  (r1 `collapseUnquotedWs`) a RAN differing from the recorded command only by (A)
  an inner double-space after an escaped `\"`, or (B) a backslash-escaped double
  space, was FALSELY accepted as identical (no violation); post-RESCOPE both
  raise the "is not the command manifest run / not the harness-supplied"
  violation. The original `"a  b"` vs `"a b"` case is also distinct. Byte-
  identical, BUG-066 `FOO=1`↔`env FOO=1`, and leading/trailing-whitespace pairs
  still match both before and after (no over-tightening). Six permanent cases
  added to `scripts/verify-independent-verification.mjs` (BUG-276 RATCHET block)
  — all PASS.
- **Anti-regression:** verify-independent-verification (confined runner, scratch
  git needs it) 158/159 PASS, 1 SKIP (behavioral, needs permissive sandbox), 1
  FAIL = the pre-existing unrelated relative-symlink-containment test (identical
  FAIL set as r1's baseline; categorically independent of command identity; no
  PASS lost). BUG-066, HOLE #19 and the new BUG-276 cases all PASS.
  verify-bug-273-iv-infra 88/0 (its C2-out-of-scope note intact).
  verify-bug-097-lenient-parse 16/16. verify-bug-225 95/0. `npm run gate` PASS
  (exit 0, read directly). `npm run board:check` — the 1 DRIFT (FEAT-170
  unreachable ticket) + STALE/advisory WARNs are pre-existing and unrelated.
- **Independent-verify warranted:** this is a verification-harness identity
  change (citation-forgery surface) and r1 regressed here once — an independent
  clean-room re-verify pass against the files as they stand is warranted before
  close.
- **Left UNSTAGED** for the user to commit: `scripts/lib/verdict-contract.mjs`,
  `scripts/verify-independent-verification.mjs`, and this ticket.

### 2026-10-25 — dispatch openai
- **Verification recorded:** dispatch openai/codex run 01a170a2-51d2-7702-ab7a-f3c875a69077 — VERDICT: BROKEN — mixed-state candidate 0539d0f6578f. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-25 — technical adjudicator (WA §N, second two-break)
- **Disposition: (B) RESCOPE to the pre-BUG-276 (HEAD) behaviour + a documented
  limitation. STOP patching.** Command-identity has now broken by 4 paths across
  2 rounds — r1: escaped `\"` desync + backslash-escaped space; r2: outer-quote
  strip + quoted env-VALUE inner whitespace in `splitEnvPrefix`. Every break is a
  reader re-parsing shell text, the exact class BUG-273 and the `validateRunForms`
  adjudicator (independent-verify.mjs ~L245 "the r2 shell-TEXT advisories … are
  DELETED … a real shell tokeniser would be needed") already ruled must not be
  hand-rolled. WA §N requires adjudication at the second two-break, not round 3.

- **Executed evidence (real production path: `validateVerdict` FIXER-TEST `RAN:`
  vs manifest `entry.cmd` + `knownRuns` pin; probe `/tmp/bug276_probe2.mjs`).**
  Genuinely-different command pairs, asking "is the cited RAN accepted as THE
  recorded/supplied command?":
  - CURRENT r2 tree: `A env-value dbl-space => FALSE-MATCH (valid=true)`;
    `B quoted-arg dbl-space => DISTINCT`; `C identical => match`; `D diff prog =>
    DISTINCT`. So the property is STILL broken on the uncommitted r2 tree —
    `FOO="a  b" node t.mjs` and `FOO="a b" node t.mjs` are accepted as identical,
    because `splitEnvPrefix`'s `^(\S+)\s+` eats the inner double-space of a quoted
    env value. r2's own RATCHET block never tested the env-VALUE case it broke
    (generation is not its own verifier).
  - HEAD (pre-BUG-276): `A => FALSE-MATCH`; `B => FALSE-MATCH` (the blunt `/\s+/`
    collapse). HEAD's holes are a SUPERSET of r2's, but ALL of the same harm
    class: identity depending on inner whitespace of a quoted token.

- **Harm verified against the contract code — N=0, and NOT forgery.** The whole
  FEAT-061 threat model (15 closing clean-room rounds) is FABRICATED evidence:
  runs that did not happen, output that was not produced. To exploit ANY of these
  false-matches a verifier must have ACTUALLY RUN, through `./vrun.mjs`, a command
  differing from the harness-supplied one ONLY by inner quoted whitespace — a real
  execution whose real output is recorded and bound by `bindOutput`. That is a
  near-variant that genuinely executed, categorically outside the forgery model,
  not a forged verdict. The recorder (`handleRequest`, independent-verify.mjs
  ~L1221) records `String(req.cmd).trim()` verbatim and the supplied command is
  verbatim, so real citations are byte-identical save trim + the BUG-066 env form;
  the r1/r2 audits and this one find zero real fixer-test commands carrying quoted
  inner whitespace. The property's realized harm is zero; its cost has been two
  rounds, two BROKEN verdicts, and fresh parser surface each round.

- **Why (A) STRUCTURAL-at-the-owner loses (checked, as charter asked).** The
  recorder cannot know the env-prefix/body split without parsing. It receives only
  `req.cmd` (a raw string) and runs `spawn('sh',['-c',cmd])`; the shell consumes
  env-assignment + quoting internally and returns nothing structured. To "write
  down the split as it executed," the recorder would itself have to parse the shell
  string — relocating the identical parse-shell-text bug into a new file, not
  eliminating it. There is no structured identity available at execution time. (A)
  is not actually structural.
- **Why (C) KEEP-PATCHING loses.** 4 false-match paths / 2 rounds, the r2 tree
  still broken (executed above), each round adding parser surface. Negative
  expected value: trading a zero-incident latent hole for live parser bugs. WA §N
  exists to stop exactly this.

- **Build spec (restore + document; no new parser):**
  1. Revert `scripts/lib/verdict-contract.mjs` to its HEAD version: `normCmd` =
     `(c ?? '').trim().replace(/\s+/g, ' ').replace(/^["']|["']$/g, '')`;
     token-split `canonCmd`/`bareCmd`; DELETE the r2 `splitEnvPrefix` helper. (A
     plain `git checkout HEAD -- scripts/lib/verdict-contract.mjs` is the whole
     change — user runs it; agents do not git-write.)
  2. Add a doc comment at `normCmd` recording the ACCEPTED limitation: inner
     whitespace of a quoted token is collapsed, so two commands differing only
     there compare equal; this is a known, N=0-harm residual (a real near-variant
     run, not forgery). Point to THIS adjudication and BUG-273; state the rule "do
     NOT re-attempt a quote-aware/env-value parser — it is an incomplete
     enumeration that has broken 4 times."
  3. Revert `scripts/verify-independent-verification.mjs` to HEAD: DROP the r2
     "BUG-276 RATCHET" block (lines ~1227–1285) — its assertions encode the
     abandoned tightening (they demand inner-whitespace diffs be DISTINCT) and
     would FAIL under restored HEAD; they must NOT be re-labelled as a
     "demonstrated unfixed defect" containment. The byte-identical / BUG-066 /
     trim no-regression intent is already covered by the existing BUG-066 and
     HOLE #19 RATCHET blocks, which still hold.
  4. (Optional, if a limitation test is wanted) add ONE check that ASSERTS the
     collapse treats `--grep "a  b"` ≡ `--grep "a b"` as equal, labelled
     "accepted limitation per BUG-276 adjudication" — never as a bug to fix.
  5. Set the ticket decision to RESCOPE/won't-fix-as-filed with this limitation;
     the two BROKEN verdicts stand as the record that the tighten-it path was
     abandoned, not satisfied.
- No independent clean-room re-verify needed: the disposition REMOVES the
  identity-tightening surface rather than adding to it, returning to the
  long-lived HEAD code; the decision rests on executed evidence above plus the N=0
  harm finding, not on a new green suite.

### 2026-10-25 — worker (BUG-276 fixing r3, RESCOPE)
- **RESCOPE to HEAD + documented limitation:** Adopted the WA §N adjudication (2026-10-25 'second two-break'): RESCOPE to the pre-BUG-276 (HEAD) behaviour + a documented, accepted limitation. STOP patching; command identity has broken 4 ways across 2 rounds, every break a reader re-parsing shell text — the class BUG-273 deleted a tokeniser for.
  HUNK ATTRIBUTION (hypothesis verified): the ENTIRE uncommitted working-tree diff of both scripts/lib/verdict-contract.mjs and scripts/verify-independent-verification.mjs vs HEAD was BUG-276 r2 only — verdict-contract.mjs carried the normCmd rewrite + splitEnvPrefix + canonCmd/bareCmd token-model change; verify-independent-verification.mjs carried ONLY the one 'BUG-276 RATCHET' block (~L1227-1285). NO BUG-273 or other foreign hunk was present in either file's working-tree diff, so both were restorable to HEAD whole without removing any other lane's work.
  BUILD: backed up both r2 files to ~/.local/state/claude-station/scratch/bug276/, then restored both to HEAD via git show HEAD:<path> (no git checkout/restore). Re-added at normCmd a doc comment recording the ACCEPTED limitation (inner whitespace of a quoted token is folded, so two commands differing only there compare equal; N=0 realized harm — a real near-variant run, not forgery; do NOT re-attempt a quote-aware/env-value parser, it is an incomplete enumeration that broke 4 times; cites this adjudication + BUG-273). Added ONE check in verify-independent-verification.mjs labelled 'BUG-276 ACCEPTED LIMITATION' that ASSERTS --grep "a  b" is treated the SAME as --grep "a b" through the real validateVerdict path — it PINS the documented behaviour so a future silent re-tighten is caught and routed back to adjudication, never as a bug.
  VERIFY (real output): verify-independent-verification (confined) 153/154 PASS, 1 SKIP (restricted sandbox), 1 FAIL = pre-existing unrelated relative-symlink-containment test; the new accepted-limitation check PASS and the r2 RATCHET block is gone. verify-bug-097-lenient-parse 16/16. verify-bug-225 95/0. verify-bug-273-iv-infra 88/0 (must-FAIL anchor intact). npm run gate PASS (exit 0, read directly). npm run board:check — 1 DRIFT = pre-existing FEAT-170 unreachable ticket; STALE/advisory WARNs pre-existing. No independent clean-room re-verify needed: this REMOVES identity-tightening surface, returning to long-lived HEAD code.
  Left UNSTAGED for the user: scripts/lib/verdict-contract.mjs, scripts/verify-independent-verification.mjs, and this ticket. The two BROKEN verdicts stand as the record that the tighten-it path was abandoned, not satisfied.
