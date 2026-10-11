```orchard-ticket
{
  "id": "BUG-236",
  "type": "bug",
  "title": "Leak gate flags plain code as a credential, blocking real pushes",
  "summary": "The secret-assignment matcher treats any unquoted assignment value with two character classes as a secret. Ordinary code counts as two classes (a letter plus a dot or underscore, or mixed case), so member access, a camelCase identifier, a function call and a CONST reference all false-positive. Two private target repos carried ~141 and ~54 such hits.",
  "impact_if_we_wait": "Credential classes are non-waivable (FEAT-156), so a repo full of these code false positives can never pass the full-tree push scan. Granted agents cannot push those projects at all; the user does every push by hand, defeating the git-grant feature for real codebases.",
  "current_need": "Stop treating a code expression (identifier, member access, call, env lookup, bare constant) as a secret on the unquoted assignment forms, while every pinned true positive still fires. Add a narrow credential waiver: exact file path, exact match, reason.",
  "severity": "high",
  "area": "leak-gate / credential matcher",
  "reported": "2026-10-07",
  "reported_by": "agent",
  "owner": "you",
  "work_state": "blocked",
  "human_action": "decide",
  "updated": "2026-10-07",
  "decision": {
    "id": "aa891099-3f0b-40d7-810f-ace2c368ea62",
    "mode": "single",
    "question": "In a code file, should a secret-key assignment whose right side is not a pure identifier expression be scanned for literal content?",
    "options": [
      {
        "key": "A",
        "label": "Keep round-3 suppression",
        "what_changes": "Bare forms stay fully suppressed in code; regex-literal and String.raw stay documented recall gaps.",
        "benefit": "Zero new hits; every gate stays green.",
        "cost": "Two independently proven literal routes in code stay unflagged.",
        "why_not_obvious": "The verifier treats an enumerated literal list as a redesign trigger."
      },
      {
        "key": "B",
        "label": "Allow-list plus literal-piece floor",
        "what_changes": "Suppress only a pure expression; otherwise judge each literal piece of the right side with the quoted-literal floor.",
        "benefit": "Closes both routes and the call-argument gap by construction, no enumeration.",
        "cost": "Measured +34 orchard, +29 repo A, +0 repo B hits; orchard gate red until a staged allowlist exists.",
        "why_not_obvious": "Reverses the round-3 precision decision on code files."
      },
      {
        "key": "C",
        "label": "Flag every non-expression right side",
        "what_changes": "The literal charter reading: any character outside the grammar flags the line.",
        "benefit": "Simplest property to state and test.",
        "cost": "Measured 870 / 712 / 101 new hits: a flood.",
        "why_not_obvious": "Looks strictest but is not viable."
      }
    ],
    "recommendation": "B",
    "recommendation_reason": "Only B closes the literal-in-code class without enumerating forms; its cost is a one-time, line-scoped waiver set that was measured and is bounded.",
    "prerequisite": null
  },
  "decision_history": [],
  "success_criteria": [
    "The five code shapes in the summary are NOT flagged on the unquoted assignment forms.",
    "Every FEAT-130 / FEAT-156 / FEAT-169 pinned true positive still fires, including the bare 3-class secret value.",
    "Must-FAIL: a synthesized pre-fix matcher flags all five code shapes; the fixed matcher does not.",
    "A credential allowlist entry is accepted only with an exact single-file path, an exact match and a reason; globs and identity tokens stay refused.",
    "Full-tree scans of read-only clones of both target repos drop credential-class hits toward zero, residual cleared by narrow fixture allowlists."
  ],
  "code_refs": [
    {
      "path": "scripts/lib/leak-tokens.mjs",
      "symbol": "looksLikeCodeValue",
      "note": "new: rejects member-access / low-class bare identifier RHS on the unquoted ASSIGN_DOTENV / ASSIGN_BARE / ASSIGN_GENERIC_BARE forms; quoted forms unchanged (D11 pins their over-flag)"
    },
    {
      "path": "scripts/lib/leak-tokens.mjs",
      "symbol": "parseAllowlist / allowlistable / allowlistEntryFor",
      "note": "narrow credential waiver: exact in:-file + match: + reason; identity never waivable"
    }
  ],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "default",
      "run_id": "754de0b0-724a-4910-a07e-52d1be9d4c52",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T00:41:27.500Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Clean-room --working-tree. OpenAI exhausted; fell back to SAME-provider anthropic (decorrelation reduced); openai runs found same breaks. Two-break STOP both props: P1 MEMBER_ACCESS no char-class check (dotted 3-class secret dropped); P2 waiver matches redacted LABEL not value. Single-authority."
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a1140c-95c9-7383-96a5-076188aada5d",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T01:50:38.548Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a1140c-95c4-7531-b4e0-19168c35b5cc",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T01:50:42.972Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a11576-69bc-79b2-9f82-0cd77949b604",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T08:26:48.390Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "P1 BROKEN, 2 routes: regex-literal RHS /SECRET/.source (vrun 4db5299e2485) + String.raw tagged template (vrun cf068e1f0a27) carry literal content yet suppressed in code while quoted equivalent fires. Enumerated property => single-authority redesign. Clean-room IV, openai."
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a11576-7388-7c52-9871-b5d16353ad75",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T08:27:04.908Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "P2 BROKEN, 2 routes: value extraction truncates YAML scalar at embedded #/;/space (vrun 891a981e699a); pemBlockValue captures only 1st of 2 same-line PEM blocks (vrun abb54f2af9ab) — a prefix/first-block waiver clears a span with an appended distinct secret. Enumerated => redesign. IV openai."
    },
    {
      "provider": "anthropic",
      "model": "fable",
      "run_id": "b87a47bb-6493-4e34-b528-f11892f58116",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T11:05:20.119Z",
      "author": "verify lane (r4, P1)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Clean-room IV --working-tree, scratch=2 files+test. openai quota->Fable (decorrel. reduced). P1 BROKEN 2 routes: residueRuns splits literal content on grammar delims (regex/String.raw/call-arg/cast/concat clean in code; gate exit0 vs control1); multi-line RHS never judged. Enumerated=>redesign."
    },
    {
      "provider": "anthropic",
      "model": "fable",
      "run_id": "7cfbb882-a2bf-4240-9b17-63ba02acdde0",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T11:05:25.802Z",
      "author": "verify lane (r4, P2)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Clean-room IV --working-tree, scratch=2 files+test. openai quota->Fable (decorrel. reduced). P2 BROKEN 2 routes: pemBlockLines first-BEGIN early-return (dangling block-B body unfingerprinted) + 200-line cap (body>cap outside hash, edited stays waived). Enumerated=>redesign."
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a11662-9322-78a3-9931-d8e2efd9ba86",
      "verdict": "holds",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T12:47:45.690Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "P1 superset: diff scoped to the 2 cred files. Independent 30,412-input differential (all 43 R1-R4 attacks, ctrl chars, bad-UTF8, boundaries) -> 0 violations. LIMIT: clean room has no .git, so [S] vs REAL HEAD was SKIPPED; verifier used a diff-reconstructed baseline. Author [S] passes in real repo."
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a11662-9319-7472-9182-a2551a2be177",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T12:48:06.403Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "P2 BROKEN via 2 paths: (1) _TODO bypass - /\\btodo/i misses '_TODO' (underscore=word char), so 'review_pending_TODO' waives the cred; (2) content-hash waiver clears duplicate identical lines + survives relocation. Two paths -> single-authority redesign."
    },
    {
      "provider": "anthropic",
      "model": "claude-fable-5-1",
      "run_id": "6042e00b-f352-49a8-ae01-fb00ae6ad622",
      "verdict": "invalid",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T13:52:54.280Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r6-P1 real-HEAD superset differential (clean-room, fable, decorrelation reduced). Contract-INVALID, NOT a code verdict: verifier ran fixer test bare instead of harness --run 'node ./vrun.mjs ...'; FIXER-TEST citation (run 3c72f5c4213e) failed contract check. Deterministic, same as P2. Fail-closed."
    },
    {
      "provider": "anthropic",
      "model": "claude-fable-5-1",
      "run_id": "16bfcc11-60c9-49e2-8fcf-2683b0f6864f",
      "verdict": "invalid",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T13:52:56.654Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r6-P2 r5b structural-DRAFT waiver re-attack (clean-room, fable, decorrelation reduced). Contract-INVALID, NOT a code verdict: same deterministic failure as P1 — fixer test run bare, not harness --run; FIXER-TEST citation (run 4d3e0f592ee0) failed contract check. Fail-closed."
    },
    {
      "provider": "anthropic",
      "model": "claude-fable-5-1",
      "run_id": "e5fb68d4-71eb-4722-842c-23037fc8ff05",
      "verdict": "holds",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T14:04:24.395Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r6-P1b superset differential (clean-room fable; bare --run after P1a INVALID). Contract VALID, manifest-backed. Verifier IMPORTED shipped HEAD module (closes r5 reconstructed-baseline gap): 3.68M cmp, +175283 hits, 0 violations; new gate prints every HEAD hit. UNTESTED: --staged/--changed enum."
    },
    {
      "provider": "anthropic",
      "model": "claude-fable-5-1",
      "run_id": "74fe2bdd-e1ad-4e0a-9891-1c984a99dd7e",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T14:04:53.567Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r6-P2b DRAFT-waiver re-attack (clean-room fable; bare --run after P2a INVALID). Contract VALID, manifest-backed. BROKEN, 1 path (not two-break): waiver reason of only U+0085 NEL (White_Space, outside JS trim set) survives trim(), accepted; gate WAIVES cred + PASSES blank. leak-tokens.mjs:857."
    }
  ],
  "verification_class": "plan+review",
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

# BUG-236 — Leak gate flags plain code as a credential, blocking real pushes

## Diagnosis

The `secret assignment` class in `scripts/lib/leak-tokens.mjs` gates its unquoted
value forms on `looksSecretish(v)` = (≥2 of {lowercase, UPPER, digit, non-alnum})
OR length ≥16. That counts a `.`/`_`/`-` or mixed case as "diversity" — which is
the shape of ordinary CODE, not of a literal secret. So an unquoted assignment
whose RHS is a code expression false-positives: a member-access chain
(a pass-word key assigned a `data.<prop>` chain), a camelCase identifier (a
pass-word key mapped to a camelCase variable name), a
function call (the value regex stops at `(`, leaving a function name), a CONST
reference (an api-key header name mapped to an UPPER_SNAKE constant). The hypothesis in the charter held: the cause
is the char-class count in `looksSecretish`, not elsewhere.

## Evidence

Full-tree scans of read-only clones (system `rg`-style walk via the gate's own
`scanLine`) of the two private target repos, BEFORE the fix: the bot carried 118
`secret assignment` hits, the plugins repo 54 — almost all the plain-code shape
above (member access / identifier / call / CONST ref). Those are credential-class
hits, which FEAT-156 made non-waivable, so the full-tree push scan could never
pass. After the fix the credential-class residual fell to 1 (bot) and 0 (plugins)
once the narrow fixture waivers were applied (see Verification plan).

## Implementation notes

> **Round 2 (single-authority redesign).** The independent verify (run
> 754de0b0) recorded BROKEN with the two-break STOP on BOTH properties, so each
> round-1 property was replaced by ONE authority — the round-1 `looksLikeCodeValue`
> shape list and the label-keyed/self-span waiver are DELETED, not layered over.

1. **P1 — literal-vs-reference is decided by FILE SYNTAX (`isCodeFile`), not value
   shape.** In a file where a bare unquoted RHS is an expression — programming-language
   SOURCE *and* prose/markup docs that embed code (`.md`/`.rst`/… — a doc's
   `apiKey` key bound to a bare identifier is a snippet, measured to re-flood if
   treated as config) —
   the UNQUOTED bare forms (`ASSIGN_BARE`, `ASSIGN_GENERIC_BARE`) do NOT fire. True
   structured config/data (`.env`/`.yaml`/`.json`/`.jsonl`/`.ini`/`.toml`/…), shell,
   and any UNKNOWN extension are CONFIG: a bare value is a literal and fires on the
   plain `looksSecretish`/`looksHighEntropySecret` floor. The DOTENV (`KEY=value`),
   QUOTED, non-interpolated TEMPLATE-literal (new; interpolation rejected by an
   explicit `${` check — isPlaceholder is fooled by an identifier that looks
   high-entropy, which false-positived `public/app.js`), provider KEY_SHAPE and
   connection-string forms are unambiguous literals and fire in EVERY file. No file
   context ⇒ CONFIG (conservative), so the context-free suites/guard over-report.
   `looksLikeCodeValue` is gone.
2. **P2 — the credential waiver is keyed to a sha256 FINGERPRINT of the extracted
   VALUE, never the printed label.** `scanSecrets` now attaches the real `value`
   (RHS / password / full key match) to each credential hit and dedups assignment
   hits by (label + value), so two different secrets under one key on a line are two
   DISTINCT hits. A credential entry is `token:<label> value:sha256:<64 hex>
   in:<single file> because:<reason>`; it waives a hit iff `sha256(hit.value)` equals
   the fingerprint on that exact path. `match:` is REFUSED for a credential token;
   a glob/missing in:/missing value: is refused (fail-closed). Because the allowlist
   holds only hashes, a value can never self-waive — the self-span block in
   `scripts/leak-gate.mjs` is DELETED, and a secret pasted into a `because:` reason
   still FAILS. The FAIL line prints the copyable `value:sha256:… in:…` form.

## Verification plan

- `scripts/verify-bug-236-code-value-precision.mjs` (35/35). MUST-FAIL baselines:
  P1 reconstructs round-1's `looksLikeCodeValue` (never committed — HEAD e79aada is
  pre-round-1) and proves it DROPS the IV's lost secrets (a dotted 3-class `api_key`
  value, a 2-class `client_secret` value) that the round-2 matcher flags; P2 shows HEAD collapses two
  distinct values to one label hit (IV break A root), fixed by label+value dedup +
  fingerprint. Covers code-vs-config suppression, literal forms firing in code, and
  every waiver refusal.
- Anti-regression (green): FEAT-169 20/0, FEAT-108 git-grant 64/0, FEAT-108
  git-write-block 239/0, leak-store-guard 13/13. FEAT-130 0 assertion failures (its
  git-E2E cases blocked by this session's git-write shim; all use KEY_SHAPES/.txt, so
  code-file suppression cannot affect them). FEAT-156 / gatekeeper / the suite's own
  gate-E2E section need `git init` (blocked in-session) — their logic is preserved
  (credential refusals unchanged) and the gate was driven END-TO-END via TREE mode
  over a mixed code/config/doc dir. `npm run gate` exits 0.
- Real-repo residual via the gate's exported `parseAllowlist` + `allowlistEntryFor`
  over the migrated working-tree allowlists: credential/identity/email/all-class
  residual **0** for BOTH target repos (bot + plugins) (round-1's irreducible bot
  residual-1 is gone — the fingerprint carries no identity, so the connection-string
  fixture is now waivable).

## Risks

- **Recall cost (documented, sanctioned).** A bare, unquoted secret in a CODE/doc
  file (not quoted, not a template literal, not dotenv, not a provider/conn shape) is
  treated as an expression and missed — in code it would be an identifier reference.
  A heredoc / multi-line string value on a line with no key is a pre-existing
  line-scanner limitation (not introduced here).
- **Extension is a policy proxy, not a parser (plan review point 7).** A mislabelled
  file (YAML bytes named `.js`, source named `.conf`) classifies by its extension;
  the classifier errs toward CONFIG (more findings) for any unknown extension.
- **PEM fingerprint (plan review point 1).** A line-scanner sees only a PEM header,
  so a PEM waiver fingerprints the header and covers any PEM header in that exact
  file — same single-file scope, documented.
- **Credential-waiver abuse (high).** A human can still approve a real key by
  committing the matching fixture; irreducible (the gate cannot prove a value is a
  non-live fixture). Mitigation is review surface, not code: the fingerprint is
  published, the hit is printed every run, and the allowlist change is flagged — the
  fingerprint never exposes the secret, and it can never be a glob or waive identity.
  An independent clean-room verify is warranted (security / invariant-weakening);
  the git-E2E suites should also be re-run with a git grant.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-07 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-07 — fix + plan review (agent)
- **Changed:** `scripts/lib/leak-tokens.mjs` (precision `looksLikeCodeValue` on the
  unquoted source forms; DOTENV shape floor; narrow credential waiver in
  `parseAllowlist`/`allowlistable`), `scripts/leak-gate.mjs` (self-span waiver on
  the allowlist's own line, copyable `match:` hint, FAIL-footer text),
  `.orchard/lib/leak-tokens.mjs` (vendored mirror re-synced from `scripts/` — the
  onboard manifest keeps them identical and `npm run gate` runs the `.orchard`
  copy), `scripts/verify-bug-236-code-value-precision.mjs` (new). Fixture
  allowlists written to the two private target repos' working trees (new file in
  one, extended in the other) — unstaged, for the user.
- **Plan review (cross-provider, codex/openai, class plan+review, run
  01a113ac-1348-7573-adc3-25f5e1abf9c3).** Points and how each was handled:
  1. *Two-class identifiers missed in dotenv/YAML (high).* Adopted for DOTENV:
     removed code-suppression there, added the `looksSecretish` floor instead, so
     a bare 16-char lowercase env value and a 3-class value both stay flagged.
     For the bare SOURCE form an unquoted identifier is a reference by language
     rule; the miss is the documented, sanctioned recall cost.
  2. *Member-looking value dropped (high).* In dotenv now FLAGGED (floor); on the
     source form a dotted identifier chain is genuinely code.
  3. *Provider keys / JWT assigned bare.* Confirmed unaffected — KEY_SHAPES are a
     separate scan; proven by a test case.
  4. *Call arguments.* Quoted literal arg still flagged; a bare identifier arg is a
     reference (correctly dropped).
  5. *Templates / concatenation.* Pre-existing (backticks excluded); out of scope.
  6. *Waiver could pass a live key (high).* Accepted as irreducible; mitigated by
     review surface (published + printed + flagged) and recorded under Risks; an
     independent verify is requested.
  7. *Self-span should exempt only the exact value on the entry's own line.*
     Implemented exactly so; a duplicate on any other line still FAILS (test D6).
- **Verified (self):** suites above, all green; `npm run gate` exits 0.
- **Open / handoff:** (a) `.orchard/leak-gate.mjs` was NOT re-synced — it is a
  separate vendored copy still at HEAD (missing FEAT-169's and this change's
  `scripts/leak-gate.mjs` edits); the orchard repo's own `npm run gate` has no
  credential waivers so it passes regardless, but the mirror should be re-vendored
  with FEAT-169 by whoever owns that sync. (b) An independent clean-room verify of
  the narrow credential waiver is warranted (security). (c) The two target repos
  still carry non-credential residual (identity / personal email / a local-settings
  foreign-project leak) that this fix does not and cannot clear.

### 2026-10-07 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/default run 754de0b0-724a-4910-a07e-52d1be9d4c52 — VERDICT: BROKEN — Clean-room --working-tree. OpenAI exhausted; fell back to SAME-provider anthropic (decorrelation reduced); openai runs found same breaks. Two-break STOP both props: P1 MEMBER_ACCESS no char-class check (dotted 3-class secret dropped); P2 waiver matches redacted LABEL not value. Single-authority.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — round 2 single-authority redesign + plan review (agent)
- **Plan review (CROSS-PROVIDER, openai/codex, class plan+review, run
  01a113d5-ebd7-7c51-a61d-d3c018484a97).** OpenAI was available again (quota
  restored), so decorrelation was full. The plan changed in seven places from the
  review; the ones that reshaped the design:
  1. *PEM/KEY fingerprints a fragment (critical).* Resolved: KEY_SHAPE/assignment/conn
     values ARE complete and are fingerprinted; the PEM-header residual (same single
     file) is documented under Risks. Full sha256 (64 hex), no prefix — closes the
     short-prefix collision (point 5).
  2. *Second value lost before waiver (critical).* Adopted: `scanSecrets` dedups
     credential assignment hits by (label + VALUE), not label — two secrets under one
     key on a line are two distinct hits (suite D).
  3. *Literal embedded dotenv in a code string suppressed (high).* Adopted: DOTENV
     fires in code files too (it only appears there inside a string/embedded block);
     only the space/colon BARE forms are suppressed in code (suite C).
  4. *isCodeRef is a second value-shape authority (high).* Acknowledged pre-existing:
     a config value literally starting `process.env.`/`config.` is still dropped by
     `isCodeRef`; removing it would regress FEAT-130's `process.env` pin — left as a
     documented limitation, not expanded scope.
  6. *Non-interpolated template literals missed (medium).* Adopted: new
     ASSIGN_TEMPLATE / ASSIGN_GENERIC_TEMPLATE; interpolation rejected by an explicit
     `${` check (isPlaceholder is fooled by an inner identifier — this exact miss
     false-positived `public/app.js:1033`, caught by the real-tree gate run).
  7. *Extensions lie / mixed content (medium).* Measured: treating `.md` as config
     re-flooded on code-in-docs, so prose/markup extensions join the suppress-bare set;
     unknown ⇒ config stands. Documented as a policy-proxy limitation.
- **Changed:** `scripts/lib/leak-tokens.mjs` (delete `looksLikeCodeValue`; add
  `isCodeFile`/CODE_EXTS incl. doc formats, `credentialFingerprint`/`CRED_FP_RE`,
  template forms, value-carrying + label+value-dedup `scanSecrets(line, {codeFile})`,
  value-fingerprint `parseAllowlist`/`allowlistable`/`allowlistEntryFor`),
  `scripts/leak-gate.mjs` (per-file `codeFile` from `isCodeFile`; delete self-span;
  `value:sha256:` waiveHint + FAIL footer), the two `.orchard/` mirrors re-synced
  (`.orchard/lib/leak-tokens.mjs` AND `.orchard/leak-gate.mjs` — the latter closes the
  round-1 open item, bringing FEAT-169 + this change into the vendored gate),
  `scripts/verify-bug-236-code-value-precision.mjs` (rewritten, 35/35). Migrated the
  two target repos' `.leakgate-allow` files (working tree only) from match-form to
  value-fingerprint credential entries; non-credential entries kept verbatim.
- **Verified (self):** suite 35/35; FEAT-169 20/0, FEAT-108 grant 64/0, git-write-block
  239/0, leak-store 13/13, FEAT-130 0 assertion fails; gate END-TO-END via TREE mode
  over a mixed code/config/doc dir; `npm run gate` exits 0; real-repo residual 0/0 (all
  classes) for both target repos via the exported gate functions.
- **Open / handoff:** (a) FEAT-130 git-E2E cases, FEAT-156, gatekeeper, and the suite's
  own section E need `git init` — BLOCKED by this session's git-write shim; re-run with
  a git grant (or via independent-verify). (b) A fresh independent clean-room verify is
  warranted (security / invariant-weakening). (c) The user must STAGE the migrated
  `.leakgate-allow` in each target repo (the gate reads the git INDEX, not the working
  tree) for the waivers to take effect.

### 2026-10-07 — dispatch openai
- **Verification recorded:** dispatch openai run 01a1140c-95c9-7383-96a5-076188aada5d — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — dispatch openai
- **Verification recorded:** dispatch openai run 01a1140c-95c4-7531-b4e0-19168c35b5cc — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — independent-verify (openai/codex)
- **round-2 clean-room IV — BOTH properties BROKEN (two-break STOP, route to single-authority redesign):** Cross-provider OpenAI, two parallel clean-room runs over a diff scoped to scripts/lib/leak-tokens.mjs + scripts/leak-gate.mjs only (the FEAT-169 --changed hunk was labelled baseline and excluded). Verify script present in room; the author fixture does NOT run in a clean room (section A reads HEAD via git-show for its PRE baseline and section E creates a scratch repo, but the room is a non-git tar export with no .git) so both verifiers pivoted to importing the post-change module directly.

  P1 (file-syntax literal-vs-reference) = BROKEN, run 01a1140c-95c9-7383-96a5-076188aada5d. Suppression side solid (config/.txt/no-ext/Dockerfile/Makefile/.sh/.tf/.ipynb/unknown all fire; code refs suppressed in .js/.ts/.py/.go/.md/.rst/.adoc; sk-/AKIA/PEM/conn-string/dotenv/Go-raw all fire). Two breaks, both a REAL credential LITERAL going UNFLAGGED in a code file: (1) escaped-template-literal — const password = backtick SECRET backslash-dollar-brace suffix; the accept predicate rejects on any dollar-brace substring incl. the escaped one, which JS executes as a constant string, so the literal is missed (password AND generic token forms); (2) python-triple-quotes — triple-double and triple-single quoted secrets are not matched by ASSIGN_QUOTED (single-quote only) and the bare form is code-suppressed, so the literal is missed.

  P2 (value-fingerprint waiver) = BROKEN, run 01a1140c-95c4-7531-b4e0-19168c35b5cc. Refusal authority solid (match: on credential refused; glob/absent in: refused; wrong-length/uppercase/no-sha256/raw fingerprint refused; identity refused; cross-label + renamed-path + different-label not waived; two distinct values dedup). Three breaks: (1) provider-prefix collision — sk-ant-api03-SAME-FIRST and -SECOND both extract the SAME truncated value (KEY_SHAPE stops before the hyphen suffix) so identical fingerprint and one waiver hides BOTH distinct keys; (2) yaml comma truncation — a yaml `password` scalar written `<v>,first` and `<v>,second` both extract `<v>` (bare regex stops at the comma) so shared fingerprint and one waiver hides both; (3) allowlist SELF-WAIVE — an entry token:aws... with value:sha256 of an AWS AKIA example key, in:.leakgate-allow, with that same example key sitting in the reason text, waives the very key in its own reason, refuting the design claim that a secret pasted into because: still FAILS.

  Roots: P1 = incomplete literal-form coverage (escaped-dollar predicate too broad; triple-quote not parsed). P2 = (a) partial value extraction yields shared fingerprints (collision across distinct secrets), (b) the allowlist file is self-waiving when a KEY_SHAPE sits in a reason and a matching fingerprint targets in:.leakgate-allow. Both properties enumerated via two or more paths. Git-gate E2E (fixture section E; verify-feat-130/156/gatekeeper) could NOT run as recorded evidence: vrun commands execute in the shimmed orchestrator process where scratch-repo creation is refused (only temp-index snapshot plumbing is exempt), and the room has no .git for feat-156 git-show PIN baseline. High-stakes (SECURITY/leak-gate) but findings already come from an independent cross-provider clean room; a second clean-room skeptic is optional.

### 2026-10-07 — round 3 fix + cross-provider plan review (agent)
- **Plan review (CROSS-PROVIDER, openai, class plan+review, run 01a11551-8481-71b3-b7ca-052d2e30a819).**
  Charged to break the expression-grammar suppression and the full-span fingerprint. Four
  substantive breaks returned; how each was handled:
  1. *Wrapped/cast literal with surrounding spaces (`("x") as string`, `decrypt("x")`)* and
  2. *static prefix before a real interpolation* — these were breaks in the charter's BROAD
     fail-closed backstop. See the pivot below; now DOCUMENTED recall limitations, not flagged.
  3. *Multi-line literal spanning lines* — likewise a backstop concern; dropped with the backstop.
  4. *PEM waiver collision (two distinct keys share the header)* — ADOPTED: the gate now
     fingerprints the full PEM BLOCK (header→END, inline or across lines), not the shared header.
- **REFUTED the charter's P1 hypothesis (broad fail-closed), with measurement.** Built the
  "suppress a code assignment only when the RHS is a pure expression, scan everything else"
  backstop; it flagged **161** illustrative secret literals in orchard's OWN code comments and
  test strings (e.g. leak-tokens.mjs doc comments) and would raise the target repos' residual —
  re-creating the exact BUG-236 flood the ticket exists to stop. A code file legitimately
  discusses secrets; a gate that flags every discussed literal is cry-wolf. Pivoted to the
  SURGICAL fix: the two authorities (file-syntax suppression, value-fingerprint waiver) were
  called "solid" by the IV; the breaks were where the code ENUMERATES cases. Fixed those spots
  only, keeping round-2's bare-in-code suppression intact.
- **Changed:** `scripts/lib/leak-tokens.mjs` — P1: `isInterpolated` guard (strips escaped `\$`
  before the `${` test, so an escaped-template literal is recognised, not dropped) + new
  `ASSIGN_TRIPLE`/`ASSIGN_GENERIC_TRIPLE` forms (Python/other triple-quoted literals), both
  firing in EVERY file behind the existing floors; P2: extended the `sk-` KEY_SHAPE to consume
  the full token (no prefix truncation), removed the COMMA from the bare value stop set (a
  comma-bearing scalar extracts whole), `parseAllowlist` REFUSES any `in:` resolving to
  `.leakgate-allow`. `scripts/leak-gate.mjs` — full PEM-BLOCK fingerprint for a PEM hit
  (`pemBlockValue`). The round-2 `looksLikeCodeValue` deletion and fingerprint waiver are
  unchanged. Both `.orchard/` mirrors re-synced. `scripts/verify-bug-236-code-value-precision.mjs`
  rewritten (50/50) with SYNTHESISED (non-HEAD) must-FAIL baselines for all five round-2 breaks,
  retained round-1/round-2 attack cases, and explicit DOC-LIMIT assertions for the recall gaps.
  Re-migrated the two target repos' `.leakgate-allow` (WORKING TREE only): only the PEM
  fingerprint in target repo A (bot) changed (header→block, line 88); every other entry verified still
  valid; target repo B (plugins) unchanged.
- **Verified (self):** BUG-236 suite 50/50 (section G gate-E2E SKIPPED — git init blocked
  in-session); FEAT-169 20/0; leak-store-guard 13/13; FEAT-130 0 assertion failures (git-E2E
  cases crash on the git-write shim, pre-existing); FEAT-156 crashes at git setup (env, not a
  regression); leak-write-guard 15 pass / 1 pre-existing-stale must-FAIL (#8 extracts HEAD's
  board-tool which ALREADY carries the guard; the hit is a home-path token my change never
  touches). Gate driven END-TO-END via TREE mode over a mixed code/config/PEM dir: member-access
  clean, triple-quote + escaped-template flagged, comma-values DISTINCT fingerprints, two PEM
  blocks DISTINCT fingerprints. `npm run gate` exits 0. Real-repo residual (exported gate
  functions over the working-tree allowlist, mirroring the gate loop incl. PEM block): **0 across
  ALL classes, 0 stale entries** for BOTH target repo A (bot) and target repo B (plugins).
- **Open / handoff:** (a) git-backed gate E2E (BUG-236 section G, FEAT-130 git-E2E, FEAT-156,
  gatekeeper) BLOCKED by this session's git-write shim — re-run under a git grant / independent
  verify. (b) A fresh independent clean-room verify is warranted (SECURITY / invariant-weakening);
  generation must not be its own only verifier. (c) The user must STAGE the re-migrated
  `.leakgate-allow` in each target repo (the gate reads the git INDEX). (d) DOCUMENTED RECALL
  LIMITATION (accepted over the flood): a secret inlined as a call/cast argument in CODE, or the
  static prefix before a real `${…}` interpolation in CODE, is missed in code files (it fires in
  CONFIG, where it is a literal); novel LITERAL quoting forms beyond triple-quote/escaped-template
  remain a bounded recall risk. This is the deliberate trade the broad fail-closed backstop would
  have violated by flooding.

### 2026-10-07 — dispatch openai
- **Verification recorded:** dispatch openai run 01a11576-69bc-79b2-9f82-0cd77949b604 — VERDICT: BROKEN — P1 BROKEN, 2 routes: regex-literal RHS /SECRET/.source (vrun 4db5299e2485) + String.raw tagged template (vrun cf068e1f0a27) carry literal content yet suppressed in code while quoted equivalent fires. Enumerated property => single-authority redesign. Clean-room IV, openai.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — dispatch openai
- **Verification recorded:** dispatch openai run 01a11576-7388-7c52-9871-b5d16353ad75 — VERDICT: BROKEN — P2 BROKEN, 2 routes: value extraction truncates YAML scalar at embedded #/;/space (vrun 891a981e699a); pemBlockValue captures only 1st of 2 same-line PEM blocks (vrun abb54f2af9ab) — a prefix/first-block waiver clears a span with an appended distinct secret. Enumerated => redesign. IV openai.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — agent
- **round 4 P2 line fingerprint; P1 stopped:** **Round 4 — P2 built (line fingerprint); P1 STOPPED (design fork, decision recorded).**
  - **Charter hypothesis check.** P1 did NOT hold: round 3 has no expression grammar — in a code file it suppresses EVERY bare-form match (`if (!codeFile)`), which is exactly round 3's recorded authority; "suppress only when the whole RHS is a pure expression" is the design round 3 built and refuted, so enforcing it is a design change, not a stricter implementation. Measured with a prototype strict recognizer (`prefix* IDENT(.IDENT|?.IDENT|(args)|[IDENT])*` + `as T`/`!`) over the full working trees (orchard / target repo A / target repo B), code files only, key+separator matches: (C) flag every non-grammar RHS = 870 / 712 / 101 new hits (flood); (O1) non-grammar RHS judged by the config bare-capture floor = 10 / 45 / 17, re-introducing the original BUG-236 FP shapes (type-annotated signature parameters, member chains); (O2) non-grammar RHS judged by the quoted-literal floor on each LITERAL piece (string/template/regex contents + non-identifier tokens) = 34 / 29 / 0 — closes both round-3 P1 routes by construction but turns orchard's own `npm run gate` red (11 hits in append-only tickets, 6 in vendored mermaid.min.js, 12 in leak-tokens doc comments, 5 in verify scripts) until a STAGED orchard allowlist exists. Recorded as a decide card; no P1 code changed.
  - P2 hypothesis HELD: both round-3 P2 breaks are extraction breaks (bare value class stops at `#`/`;`/space; PEM_BLOCK_RE captures the first same-line block only).
  - **Changed (P2):** `scripts/lib/leak-tokens.mjs` — `credentialFingerprint(rel, content)` = sha256(path + NUL + full line; CRLF→LF, trailing whitespace trimmed per line) via new `normalizeWaiverContent`; new exported `pemBlockLines` (PEM material = header line through END line as WHOLE lines; one-line PEM = the full line), moved here from the gate as the single authority; credential hits carry `line`; allowlist key `line:sha256:` (old `value:` REFUSED fail-closed with a re-copy message); `allowlistable` requires `in:` == path and fp == sha256(path+line); `allowlistEntryFor` never waives a credential inside `.leakgate-allow` (second wall beside the parse-time self-scope refusal). `scripts/leak-gate.mjs` — `pemBlockValue` deleted, imports `pemBlockLines`; `waiveHint` prints `line:sha256:… in:<path>` ("covers exactly this line in this file; any edit voids it"); approval note + FAIL footer updated. `.orchard/lib/leak-tokens.mjs` + `.orchard/leak-gate.mjs` re-synced (byte-identical). `scripts/verify-bug-236-code-value-precision.mjs` rewritten. Value extraction (`hit.value`) unchanged — report/dedup metadata only.
  - **Re-migrated (working tree only, unstaged):** target repo A `.leakgate-allow` 54 value entries → 61 line entries (a value on several lines → one entry per line; one duplicate collapsed), target repo B 2 → 2; non-credential entries verbatim; 0 stale.
  - **Verified (self):** BUG-236 suite 71/71 (P2 fuzz: 6000 seeded lines, 5221 flagged edit pairs — round-4 waiver covers a pair IFF normalised content identical; MUST-FAIL: synthesised round-3 value waiver cleared 2446 distinct edited lines; must-FAILs vs round 3 for `#`/`;`/space truncation + two-block PEM line; rounds 1–2 label/sk-/comma/self-waive regressions; section G gate-E2E SKIPPED — git init blocked). FEAT-169 20/0; FEAT-108 grant 64/0; git-write-block 239/0; leak-store-guard 13/13; FEAT-130 69 pass/0 fail before the git-init crash (env); FEAT-156 + gatekeeper crash on blocked git init (env); leak-write-guard 15/1 (pre-existing stale HEAD baseline, as round 3). `npm run gate` exit 0. TREE-mode gate prints the `line:` hint. Real-repo residual via the exported gate functions over the migrated working-tree allowlists: 0 all classes, 0 stale, for both target repos.
  - **Open / handoff:** (a) P1 decision (decide card) — the two round-3 P1 routes (regex literal, String.raw) are still NOT flagged in code (suite section P1-OPEN prints them). (b) The user must STAGE both migrated `.leakgate-allow` files; until then the real gate ignores (repo A: untracked) or uses the stale index copy (repo B). (c) Git-backed E2E (suite G, FEAT-130 git cases, FEAT-156, gatekeeper) needs a git grant / independent verify. (d) An independent clean-room verify of the line-fingerprint waiver is warranted.

### 2026-10-07 — worker (fixing r4)
- **Decision declared:** In a code file, should a secret-key assignment whose right side is not a pure identifier expression be scanned for literal content? Options: A — Keep round-3 suppression; B — Allow-list plus literal-piece floor; C — Flag every non-expression right side. Recommended: B — Only B closes the literal-in-code class without enumerating forms; its cost is a one-time, line-scoped waiver set that was measured and is bounded. Written to the record with board-tool decide; the Decide card reads the record, not this line.

### 2026-10-07 — agent
- **round 4 P1 residue built:** **Round 4 continued — P1 built per the orchestrator decision (decide card option B, fail-closed residue).**
  - **Built:** `scripts/lib/leak-tokens.mjs` — new exported `isPureExpression` (strict grammar: prefix* IDENT chain of .IDENT / ?.IDENT / (args) / [IDENT], optional `as T` or `!`; ASCII only), `normalizeRhs`, `residueRuns`. In a CODE file, for every secret-key + separator on the line: an RHS fully consumed by the grammar is suppressed; otherwise the untrimmed RHS is split on whitespace and the grammar delimiters, bare-IDENT runs are dropped, and every remaining run (outer quotes stripped, one trailing terminator dropped) is judged by exactly the quoted-value floor of that key class. No literal form is listed. Decision recorded in code: `obj[IDENT]` is suppressed (identifier key = reference); `obj["…"]`/`obj[0]` leave residue. Fail-closed detail: the grammar test trims a trailing comment but the residue does not, so a quoted ` //` cannot hide a literal. Config files unchanged. Mirrors re-synced.
  - **Measured new-hit LINES vs the round-3 module (code files):** orchard 78, target repo A 74, target repo B 7. Reviewed every one: env-var NAME lookups, type annotations, comment/doc prose, placeholders, test fixtures, vendored mermaid string tables; none is a live credential.
  - **Waivers (working tree, unstaged, line fingerprint + exact path + category reason):** orchard NEW `.leakgate-allow` 78 entries (22 vendored bundle, 23 ticket/doc prose, 20 leak-gate doc comments, 12 verify fixtures, 1 UI state); repo A +65 (141 total); repo B +7 (13 total). Residual via the exported gate functions over the working-tree allowlists: 0 all classes, 0 stale, all three repos.
  - **Verified:** BUG-236 suite 113/113 — must-FAIL vs a synthesised round-3 code path for /SECRET/.source, String.raw, cast-arg, call-arg, interpolation static prefix (the three round-3 DOC-LIMIT gaps now closed); recognizer fuzz 7095 out-of-alphabet strings never pure; 4000 generated pure references all suppressed; 5979 non-grammar RHS with an embedded secret-shaped run all flagged (round-3 path missed 5243 = must-FAIL); P2 fuzz unchanged. FEAT-169 20/0, grant 64/0, git-write-block 239/0, leak-store 13/13, FEAT-130 0 fails before the env git-init crash, leak-write-guard 15/1 pre-existing.
  - **Gate:** `npm run gate` is RED until the user stages orchard's new `.leakgate-allow` (502 hits, all covered by it; the gate ignores an untracked allowlist). Same staging needed in both target repos.
  - **Open / handoff:** stage the three allowlists; git-backed E2E (suite G, FEAT-130 git cases, FEAT-156, gatekeeper) needs a git grant; an independent clean-room verify of both P1 and P2 is warranted.

### 2026-10-07 — verify lane (BUG-236 r4 bookkeeping)
- **Decision recorded (delegated):** Decide card aa891099 (P1 non-grammar-residue design): the orchestrator, under authority the user delegated, chose option B-as-refined — judge non-grammar residue by the quoted-value floor, fail-closed (suppress only when the strict pure-expression grammar fully consumes the RHS). No board-tool verb records a user answer (decide only declares; the server answer route is the only writer), so this is logged here and the decision object remains open in-record until the server records it.

### 2026-10-07 — verify lane (r4, P1)
- **Verification recorded:** dispatch anthropic/fable run b87a47bb-6493-4e34-b528-f11892f58116 — VERDICT: BROKEN — Clean-room IV --working-tree, scratch=2 files+test. openai quota->Fable (decorrel. reduced). P1 BROKEN 2 routes: residueRuns splits literal content on grammar delims (regex/String.raw/call-arg/cast/concat clean in code; gate exit0 vs control1); multi-line RHS never judged. Enumerated=>redesign.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — verify lane (r4, P2)
- **Verification recorded:** dispatch anthropic/fable run 7cfbb882-a2bf-4240-9b17-63ba02acdde0 — VERDICT: BROKEN — Clean-room IV --working-tree, scratch=2 files+test. openai quota->Fable (decorrel. reduced). P2 BROKEN 2 routes: pemBlockLines first-BEGIN early-return (dangling block-B body unfingerprinted) + 200-line cap (body>cap outside hash, edited stays waived). Enumerated=>redesign.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — worker (fixing r5)
- **round 5 redesign: no suppression + single-line waivers:** Orchestrator decision (delegated): rounds 1-4 suppression deleted. P1: scripts/lib/leak-tokens.mjs detection = HEAD verbatim (S4: all 587 HEAD detection-region lines present) + ADDITIVE template/triple-quote forms appended after every HEAD loop; isCodeFile/grammar/residue/DOTENV floor/sk- and comma extraction changes all removed. P2: credential waiver = sha256(normalised path + NUL + line.trimEnd()), exact in: path, one line; PEM label refused, any hit on a BEGIN..END PRIVATE KEY line (no cap, unterminated to EOF) never waivable; allowlist file zero credential waivers + self-target refused; TODO reason (any case) refused. New: leak-gate --draft-waivers <repo> (TODO drafts, exit 1 while hits remain); long/control-char credential lines print a REVIEW THE FULL LINE note. Hypothesis HELD: suite scripts/verify-bug-236-code-value-precision.mjs 128/0 — new >= HEAD with 0 violations over the FEAT-130 corpus, 60k fuzz (+4537 hits) and ~532k real lines of 3 repos; must-FAIL suppressor caught; 28/43 round 1-4 attack inputs flagged, the other 15 are HEAD recall gaps (call-arg/cast/subscript/concat literals, multi-line RHS, comment tail, 14-char single-class) never flagged by HEAD, not suppression; waiver edits / next line / path and case variants / PEM (round 3+4 attacks) all stay flagged; gate E2E via a read-only fake git. Plan review anthropic/fable run 6a1f32d0-1de2-4205-9388-837337b5c367 (openai quota): P1 HOLDS, P2 HOLDS; review-surface notes 1-2 adopted; lowercase/split PEM markers = pre-existing detection gap. Allowlists (working tree, unstaged): orchard none needed (round-4 untracked file removed); target repo A 131 line + 15 non-credential entries, residual 3 (1 PEM fixture in its secret-detector dataset, never waivable; 2 identity hits in an untracked deploy log); target repo B 48 line + 4, residual 0. npm run gate PASS (allowlist simulated staged). Suites: FEAT-169 20/0, leak-store 13/13, grant 64/0, git-write-block 239/0, FEAT-130 69/0 then env crash (scratch repo blocked), FEAT-156/gatekeeper env-blocked, leak-write-guard 15/1 pre-existing.

### 2026-10-07 — dispatch openai
- **Verification recorded:** dispatch openai run 01a11662-9322-78a3-9931-d8e2efd9ba86 — VERDICT: HOLDS — P1 superset: diff scoped to the 2 cred files. Independent 30,412-input differential (all 43 R1-R4 attacks, ctrl chars, bad-UTF8, boundaries) -> 0 violations. LIMIT: clean room has no .git, so [S] vs REAL HEAD was SKIPPED; verifier used a diff-reconstructed baseline. Author [S] passes in real repo.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — dispatch openai
- **Verification recorded:** dispatch openai run 01a11662-9319-7472-9182-a2551a2be177 — VERDICT: BROKEN — P2 BROKEN via 2 paths: (1) _TODO bypass - /\btodo/i misses '_TODO' (underscore=word char), so 'review_pending_TODO' waives the cred; (2) content-hash waiver clears duplicate identical lines + survives relocation. Two paths -> single-authority redesign.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — worker (fixing r5b)
- **round 5 P2 fix: structural DRAFT marker:** IV openai 01a11662-9319-7472-9182-a2551a2be177 P2 break fixed structurally: the reason regex (/\btodo/i, which accepted review_pending_TODO) is DELETED. --draft-waivers now prints every entry as `DRAFT token:… line:… in:… because:` (marker + empty reason); parseAllowlist refuses any line whose first word is DRAFT (any case, `DRAFT:` too), whatever the reason; empty/whitespace reasons stay refused (MIN_REASON). Any human-written non-empty reason is accepted; judging it is the reviewer's job. Must-FAIL W5c: the pre-fix regex accepted review_pending_TODO; W5b: DRAFT refused with real/empty/TODO reasons. INTENDED BEHAVIOUR (not changed): a waiver keys on exact path + exact line content, so a byte-identical line duplicated or moved within the same path is the same reviewed content and stays waived. Suite 134/0; npm run gate PASS; gate residual 0 in orchard, target repo A (after the other lane's fixture/.gitignore change) and target repo B, 0 stale; .orchard mirrors re-synced (byte-identical).

### 2026-10-07 — verify lane (r6, independent clean-room — BLOCKED on provider quota)
- **Attempted** independent cross-provider (OpenAI) clean-room verify of the current uncommitted state via `scripts/independent-verify.mjs --working-tree`, TWO parallel processes. **Both INVALID (infra, not a code verdict):** OpenAI dispatch hit `quota-window` ("usage limit … try again at 8:40 PM"; now 16:33 EEST). `dispatch-client --check` reports openai available but the codex invocation is rate-limited; anthropic is not a dispatch provider here, so no decorrelated verifier is reachable until the window resets (~20:40). No verdict recorded (fail-closed: unverifiable ≠ verified).
- **Setup is reusable** (rebuilds the tight room the earlier r5 IV lacked — a REAL .git-free baseline shipped as files, diff scoped to BUG-236 only): scoped repo copies with the working tree reverted to HEAD except the two cred files + test + HEAD baseline modules under `scripts/_bug236_baseline/`. Diff = exactly 5 paths (2 under test, 2 baseline, 1 test); docs stripped. Copies: `~/.local/state/claude-station/scratch/bug236-src-d2rB6W` (P1), `~/.local/state/claude-station/scratch/bug236-src-d2rB6W-p2` (P2). Charters: `/tmp/bug236_p1_req.txt` (real-HEAD superset differential), `/tmp/bug236_p2_req.txt` (r5b structural-DRAFT waiver re-attack). Re-dispatch after 20:40: `node scripts/independent-verify.mjs --repo <copy> --working-tree --requirement @<charter> --provider openai --timeout-min 30 --max-diff-bytes 5000000 --test-file <copy>/scripts/verify-bug-236-code-value-precision.mjs --run "node ./vrun.mjs node scripts/verify-bug-236-code-value-precision.mjs"`.
- **Context:** r6 was meant to close the two open gaps — r5 P1 HOLDS carried a "no real HEAD, reconstructed baseline" limitation (run 01a11662-9322…); r5 P2 was last independently BROKEN (run 01a11662-9319…) and the r5b structural-DRAFT fix has had no independent re-attack yet.

### 2026-10-07 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-fable-5-1 run 6042e00b-f352-49a8-ae01-fb00ae6ad622 — VERDICT: INVALID — r6-P1 real-HEAD superset differential (clean-room, fable, decorrelation reduced). Contract-INVALID, NOT a code verdict: verifier ran fixer test bare instead of harness --run 'node ./vrun.mjs ...'; FIXER-TEST citation (run 3c72f5c4213e) failed contract check. Deterministic, same as P2. Fail-closed.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-fable-5-1 run 16bfcc11-60c9-49e2-8fcf-2683b0f6864f — VERDICT: INVALID — r6-P2 r5b structural-DRAFT waiver re-attack (clean-room, fable, decorrelation reduced). Contract-INVALID, NOT a code verdict: same deterministic failure as P1 — fixer test run bare, not harness --run; FIXER-TEST citation (run 4d3e0f592ee0) failed contract check. Fail-closed.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-fable-5-1 run e5fb68d4-71eb-4722-842c-23037fc8ff05 — VERDICT: HOLDS — r6-P1b superset differential (clean-room fable; bare --run after P1a INVALID). Contract VALID, manifest-backed. Verifier IMPORTED shipped HEAD module (closes r5 reconstructed-baseline gap): 3.68M cmp, +175283 hits, 0 violations; new gate prints every HEAD hit. UNTESTED: --staged/--changed enum.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-fable-5-1 run 74fe2bdd-e1ad-4e0a-9891-1c984a99dd7e — VERDICT: BROKEN — r6-P2b DRAFT-waiver re-attack (clean-room fable; bare --run after P2a INVALID). Contract VALID, manifest-backed. BROKEN, 1 path (not two-break): waiver reason of only U+0085 NEL (White_Space, outside JS trim set) survives trim(), accepted; gate WAIVES cred + PASSES blank. leak-tokens.mjs:857.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — verify lane (r6, re-run on anthropic/fable — charter defect found + two VALID verdicts)
- **Ran** the r6 clean-room IV on anthropic/`claude-fable-5-1` (OpenAI still quota-blocked; same-provider as author, decorrelation reduced — accepted by orchestrator). Reused the r6-BLOCKED scoped copies + charters (`/tmp/bug236_p1_req.txt`, `/tmp/bug236_p2_req.txt`).
- **Charter defect (infra, not a code verdict) — first pass BOTH INVALID, deterministic:** the r6-BLOCKED lane's prepared `--run "node ./vrun.mjs node scripts/verify-bug-236-code-value-precision.mjs"` double-wraps vrun. `independent-verify.mjs` ITSELF seeds `vrun.mjs` into the room and instructs the verifier to run every command through `node ./vrun.mjs <cmd>`; vrun RECORDS the inner command. The contract validator (`verdict-contract.mjs` `composeVerdict` → `sameCmd`/`canonCmd`, which does NOT strip a `node ./vrun.mjs` prefix) then compares the recorded bare command against the `--run` string and rejects the FIXER-TEST citation → INVALID. Correct usage is a BARE `--run "node scripts/verify-bug-236-code-value-precision.mjs"` (cf. FEAT-061 closing verdicts). Recorded INVALID: P1a run `6042e00b-…`, P2a run `16bfcc11-…`. **Action item for future r-rounds: drop the `node ./vrun.mjs` prefix from the stored re-dispatch command.**
- **Re-ran with the corrected bare `--run` — both contract VALID, manifest-backed:**
  - **P1 (real-HEAD superset differential) → HOLDS.** run `e5fb68d4-71eb-4722-842c-23037fc8ff05`. The author's `[S]` git-diff section still SKIPs (no `.git` in the room), but the verifier's own adversarial differential **imports the shipped HEAD module directly** (from the `scripts/_bug236_baseline/` files) and the new module in one process — this is what **closes the r5 P1 "reconstructed baseline" limitation** (run 01a11662-9322…). 3.68M comparisons across the 43 attacks, 94k-line hand corpus, 224k fuzz lines (5 seeds), 201k working-copy lines, non-string + multi-line inputs → **0 violations, 0 slow, +175,283 new hits**; gate-CLI differential: new gate prints every HEAD `rel:line:[token]` hit in every mode (REPO/--summary/--commit-msg/--identity/TREE/allowlist variants), matching exit codes. UNTESTED (verifier-declared): `--staged`/`--changed` git-index enumeration (no git in room); the matcher funcs those modes call ARE covered, the index-enumeration path is not.
  - **P2 (r5b structural-DRAFT waiver re-attack) → BROKEN.** run `74fe2bdd-e1ad-4e0a-9891-1c984a99dd7e`. The structural DRAFT fix survived a very wide attack (BOM/NBSP/ZWSP/NEL/CR prefixes, fused/split markers, U+2028/U+2029 line-separators, look-alikes, draft-twin-beside-approved, PEM spellings — all refused). **New break, single path (NOT a two-break STOP):** a credential-waiver `because:` reason composed only of **U+0085 NEL** characters (Unicode `White_Space=Yes` but OUTSIDE ECMAScript `String.prototype.trim`'s set) survives `reason.trim()` with length ≥ `MIN_REASON`, so `parseAllowlist` ACCEPTS it and the gate WAIVES the credential and exits 0, printing a visibly blank reason — violating the contract's "whitespace-only reason must be refused". Location `scripts/lib/leak-tokens.mjs:857-858` (`const reason = …trim(); if (reason.length < MIN_REASON)`). Confirmed independently: `"\u0085".repeat(12).trim()` → length 12. Fix direction: reject reasons that are whitespace-only under **Unicode** White_Space (e.g. strip `\s\p{White_Space}` or test `/^\s*$/u` with the full property), not JS `trim`. Minor secondary (NOT a hole): `in:.leakgate-allow/.` bypasses the parse-time self-target basename check but the `allowlistEntryFor` lookup guard still refuses it.
- **Net:** P1 HOLDS (prior reconstructed-baseline limitation now closed). P2 BROKEN — the r5b structural-DRAFT fix does not refuse Unicode-only (U+0085) reasons. Ticket stays `blocked` on the open human decision; P2 needs a fixer round. Verdicts typed into `verification[]` via board-tool; this narrative is the detail pointer.

### 2026-10-07 — worker (fixing r5c)
- **round 5 P2 fix: reason must contain a letter or digit:** IV anthropic/fable 74fe2bdd-e1ad-4e0a-9891-1c984a99dd7e P2 break fixed structurally: a because: reason is valid only if it contains at least one Unicode letter or digit (/[\p{L}\p{N}]/u) in addition to MIN_REASON; no list of whitespace code points. Must-FAIL W5e (11 cases, each wrapped in NEL so trim() strips nothing and the pre-fix trim+length rule accepted it): NEL, NBSP, U+200B, ZWJ/ZWNJ, U+3000, U+2060, BOM, U+2028/9, punctuation-only, symbol-only, mixed invisibles; all refused now; a non-Latin letter reason stays accepted (W5f). Suite 134 to 146 pass / 0 fail; npm run gate PASS; gate residual 0 and 0 stale for orchard, target repo A and target repo B; .orchard mirrors re-synced (byte-identical). CORRECTION to the r6 re-dispatch note above: the stored --run command double-wrapped vrun; the correct bare form is --run "node scripts/verify-bug-236-code-value-precision.mjs" (independent-verify seeds vrun.mjs and wraps it itself).
