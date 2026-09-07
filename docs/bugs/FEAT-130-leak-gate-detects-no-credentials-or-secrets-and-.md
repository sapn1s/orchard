```orchard-ticket
{
  "id": "FEAT-130",
  "type": "feature",
  "title": "Leak gate detects no credentials or secrets and is unenforced",
  "summary": "The commit-time leak gate only matches a fixed list of private project names, home paths, a username, a GitHub handle and one hardcoded email substring. It has no patterns for API keys, tokens, private keys or secret assignments, and no generic email pattern. It never scans the commit message or committer identity, and nothing forces it to run.",
  "impact_if_we_wait": "On a PUBLIC-bound repo, a committed credential or personal email is unprotected. The user's stated headline worry (committing secrets) is not covered at all, giving a false sense of safety. The only recovery from a pushed secret is history rewrite plus key rotation.",
  "current_need": "Add credential/secret and generic-email detection to the shared token list; scan the commit message and committer identity; and enforce the gate as a real pre-commit hook and in the UI commit path so no commit can bypass it.",
  "severity": "high",
  "area": "scripts / server",
  "reported": "2026-09-06",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-09-06",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "findLeaks flags common secret shapes: sk- keys, ghp_ tokens, AKIA ids, xox tokens, PEM private-key headers, PASSWORD/SECRET/TOKEN assignments and password-bearing connection strings",
    "A generic personal email in file content is flagged, with the licensor notice still the only sanctioned waiver",
    "The commit message and committer identity are scanned for the same token set",
    "A git pre-commit hook and the server commit path both run the gate and block a leaking commit"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
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

# FEAT-130 — Leak gate detects no credentials or secrets and is unenforced

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-06 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-06 — worker (fixing, round 1)
Built all three parts; left unstaged for the user to commit through the hardened gate.

- **A. Detection** (`scripts/lib/leak-tokens.mjs`): added credential/secret/email
  classes to the SHARED detector so the gate AND the ticket-write guard inherit
  them. `scanLine`/`scanSecrets` now cover: `sk-` keys (needs a ≥24-char
  continuous alnum run, so repo `sk-notification-woken` slugs never trip),
  `gh*_`, `AKIA`/`ASIA`, `xox…`, PEM private-key headers, `Bearer` tokens;
  SECRET/PASSWORD/API_KEY/etc assignments (dotenv-caps or quoted only; bare
  `TOKEN` excluded so `MAX_TOKEN`/`FUZZ_TOKEN` consts don't flood); password-
  bearing connection strings; and any personal email. Precision held by:
  placeholder/code-ref filters, and an ALLOWED_EMAIL set (RFC-2606 + `.local`/
  `.service`, the noreply identities, and the documented dependency-maintainer
  addresses already in the tree — microsoft.com, oraios-ai.de).
- **B. Commit scan** (`leak-gate.mjs`): new `--commit-msg=<file>` and `--identity`
  flags scan the pending message and `git config user.name/email`. The GitHub
  noreply identity is the one sanctioned committer shape; a personal email as
  committer or in a message is caught. Fail-closed: unresolvable identity → exit 2.
- **C. Enforcement:** `src/server/git.ts commit()` now runs the gate (tree +
  identity + message) before `git commit`, fail-closed (refuses if the gate
  can't run). Installed `.git/hooks/pre-commit` + `commit-msg` (source tracked in
  `.githooks/`) for hand commits. FEAT-108 agent path already gated (confirmed).
  Binary/skipped-file blind spot: such files are now scanned for the high-signal
  KEY/PEM shapes (`scanKeyShapes`) instead of skipped wholesale.
- **Verification** (`scripts/verify-feat-130-leak-detection.mjs`, `npm run
  verify:feat-130`): 58/58. Must-FAIL→PASS per class (caught after; NOT caught by
  the classic literal tokens before); false-positive proof over real-tree
  content; enforcement across pre-commit / commit-msg / identity / git.ts paths,
  all fail-closed. `npm run gate` exit 0 on the clean real tree. One tree edit:
  `verify-feat-108`'s single-letter generic-email test fixture (the only generic-
  email hit on the real tree) → `a@example.invalid`; a reserved fixture domain is
  the right value for a test git identity.
- **Not my regressions:** verify-leak-write-guard (1 stale "guard is new" control),
  verify-feat-049-publish-safety (env git error), verify-board-tool (FEAT-129/
  ARCH-007 board drift) fail IDENTICALLY on pristine HEAD.
- **Flag:** security + rides the commit path → an independent adversarial verify
  (a fresh agent trying to sneak a secret past each path) is warranted.
- **Handoff:** the hardened gate is ready; the day-of work still needs committing
  THROUGH it via the git-write grant. The worker committed nothing.

### 2026-09-06 — verifier (verifying, round 1) — VERDICT: BROKEN

Ran `npm run verify:feat-130` → 58/58, exit 0; real tree `node scripts/leak-gate.mjs --summary` → exit 0. But the suite tests the wrong content: **the gate scans the WORKING TREE, `git commit` records the STAGED INDEX.** A real-shaped `sk-ant` key reaches a commit whenever index ≠ worktree — a routine git state, not just an attack.

**Per-surface:**
- detection-recall: **BROKEN.** `apikey=<value>` lowercase+unquoted slips (`ASSIGN_DOTENV` needs ALL-CAPS key, `ASSIGN_QUOTED` needs quotes) — committed a live `apikey=<synthetic-24ch-secret-body>` through `git.ts commit()`. Also `password: value` unquoted-colon slips; generic base64 key w/o known prefix slips (no entropy detector — arguably acceptable).
- git.ts-enforcement: **BROKEN.** Repro (scratch): write secret → `git add` → overwrite worktree file clean (or `rm` it) → `gitmod.commit()` returns a sha; `git show HEAD:s.txt` = `key=sk-ant-api03-…`. The gate's `git ls-files -co` + `fs.readFileSync` reads the clean/absent worktree copy (`if (!fs.existsSync(abs)) continue;` even skips the deleted case); the index secret is never scanned.
- hooks: **BROKEN, same root cause.** stage-secret-then-clean-worktree → hand `git commit` succeeds via installed `.git/hooks/pre-commit`; committed blob carries the key. `--no-verify` bypass also confirmed (documented residual; app/agent paths are the backstop, but those are broken too per above).
- allowed-email: **partial hole.** an email whose domain is a *subdomain* of an allowed domain (e.g. host `evil.microsoft.com`, or any subdomain under `oraios-ai.de`) is waived by `emailAllowed` (needs controlling a maintainer-domain subdomain — low practical risk). An email using an allowed domain as a non-final label (host `microsoft.com.evil.com`) is correctly rejected.
- detection-precision: CONFIRMED. Real tree, LICENSE `Required Notice:` waiver, noreply identity, ticket prose naming shapes, `MAX_TOKEN`/placeholders all pass.
- commit-msg / identity: CONFIRMED for message/identity *content* (personal email in msg or as committer caught; fail-closed on unresolvable email, exit 2).
- binary: CONFIRMED. NUL-blob and minified one-liner with embedded `sk-` key both → gate exit 1.

**Root fix:** scan staged/index content (`git diff --cached` or `git cat-file` of `:path`), not the working tree — for the file loop in `leak-gate.mjs` REPO mode. Until then a staged secret with a clean/removed worktree copy commits on every path (UI, hook, hand). Repro scripts: `~/scratch/attack.mjs`, `attack2.mjs`, `attack3.mjs`. No source touched.

### 2026-09-06 — worker (fixing, round 2) — index bypass + apikey recall closed

Fixed the round-1 BROKEN verdict. Left unstaged for the user to commit through the hardened gate.

- **A. Enforcement scans the STAGED INDEX, not the working tree.** New `--staged`
  flag in `leak-gate.mjs`: REPO mode enumerates `git ls-files -s -z` (for modes) ∩
  `git diff --cached --name-only --diff-filter=ACMR -z`, scanning only regular-file
  blobs (100644/100755 — symlinks/gitlinks skipped, matching worktree mode's
  `isFile()` skip so `git show :<symlink>` can't false-positive on a link's target
  path), and reads each blob straight from the index via `git show :<path>`. This
  never touches the worktree, so index≠worktree divergence — the exact bypass —
  cannot slip. Fail-closed on an unreadable staged blob (exit 2). Wired into all
  commit-blocking paths: `git.ts commit()` (adds `--staged`), the pre-commit hook
  (`.githooks/pre-commit` AND the ACTIVE `.git/hooks/pre-commit` — note
  `core.hooksPath` is UNSET, so the tracked `.githooks` copy is NOT the active one;
  synced both), and the FEAT-108 agent path (`runLeakGateForRepo` now runs the
  worktree scan AND `--staged`, failing closed if either leaks — the union is a
  pre-execution guard so it must also catch `git add secret && git commit` where
  nothing is staged yet). `npm run gate` stays a working-tree preflight (unchanged).
- **B. `apikey=value` recall gap closed** (`leak-tokens.mjs` `ASSIGN_BARE` +
  `looksSecretish`): lowercase/unquoted secret assignments with either `=`/`:` are
  now caught on the SAME high-signal key list (bare `token=`/`key=` still not keys).
  Precision guard: an unquoted bare value must be `isSecretValue` AND look
  secret-shaped (≥2 char classes or ≥24 chars), so a documented config key
  (value "required"/"optional") does not flood. Value char-class excludes markdown
  punctuation (backtick/brackets) so prose like `...HasSecret:true` isn't a hit.
- **Verify** (`~/scratch/verify-index-bypass.mjs`, 18/18): the exact index bypass
  must-FAIL(before, working-tree scan passes the cleaned worktree) → PASS(after,
  `--staged` refuses) across `git.ts commit()` (2a clean + 2b deleted), the
  pre-commit hook (2c), and the agent union gate; secret shown present in the
  staged index at refusal. apikey recall caught-after / missed-by-old-forms.
  Fail-closed (unresolvable identity → exit 2). FP proof over `--staged`: LICENSE
  waiver + ticket prose + `MAX_TOKEN` + noreply identity all pass. `npm run gate`
  exit 0 on the clean real tree (checked directly, unpiped); round-1 suite 58/58;
  typecheck clean.
- **Redaction:** the round-1 verify entry above pasted a synthetic
  credential-shaped literal (`apikey=<synthetic-24ch-secret-body>`, was a fabricated
  value) — the hardened detector now (correctly) flags it, and this untracked
  ticket would have failed its own gate. Redacted to a placeholder form; the
  entry's meaning is unchanged. This is the project's own "describe the shape,
  never paste the value" convention the gate enforces.
- **Separate pre-existing gap (NOT this ticket, flagged for follow-up):** the
  FEAT-108 classifier resolves `git add -A && git commit` to offender `git add`
  (non-publishing), so `evaluateGitWrite` never invokes the leak gate for a
  compound stage+commit in one Bash call — present in round 1, independent of the
  index issue, and unfixable here without risking FEAT-108 regressions. The
  in-repo pre-commit hook is the backstop for onboarded projects; a bare project
  without hooks is exposed to this compound-command shape.
- **Not my regressions (fail identically on pristine HEAD / working-tree README):**
  `verify-leak-write-guard` test 8 (stale "guard is new" control — the guard
  already shipped at HEAD; board-tool untouched); `verify-feat-049-licence` A14/
  A15b/C9 (README commercial-use prose — README is edited in the working tree).
  feat-108 block/grant/approve all green (164/40/20).
- **Flag:** security + rides the commit path, and this is round 2 of a change
  round 1 got wrong → an independent adversarial re-verify (a fresh agent trying
  each path against the index attack, plus the compound-command gap) is warranted.
- **Handoff:** the index-hardened gate is ready; the day's work still commits
  THROUGH it. The worker committed nothing.

### 2026-09-06 — verifier (verifying, round 2) — VERDICT: round-2 fix CONFIRMED; gate as a whole still BROKEN

Adversarial re-verify in scratch repos (`~/scratch/feat130-*.mjs`); git
driven from a Node harness because the FEAT-108 block (correctly) refuses the
verifier's own Bash git writes. Cross-provider decorrelation: ONE `gpt-5.6-sol`
pass (bounded, one call; ~1.6K-token charter, ~1.5K-token report; exact USD not
surfaced in the transcript). Every OpenAI claim below was RE-RUN against the real
gate before being reported — not taken on faith.

**Round-2's own two claims — CONFIRMED FIXED:**
- **Index bypass (the round-1 BROKEN root cause): CLOSED.** Staged an `sk-ant`-style
  key then (a) overwrote the worktree clean, (b) deleted it, (c) partial-stage
  (secret line staged, worktree line removed), (d) staged rename, (e) `git commit -a`
  on a tracked mod — all REFUSED with the secret provably present in the staged
  index, across `git.ts commit()`, the pre-commit hook, and the agent union gate.
  `--staged` reads `git show :<path>`, immune to index≠worktree divergence.
- **apikey recall gap: CLOSED.** lowercase/unquoted `apikey=<body>` and
  `password: <body>` both caught. Fail-closed on unresolvable identity (exit 2)
  confirmed. `npm run gate` on the real tree PASSES clean (only the LICENSE waiver)
  — no FP regression.

**But new holes let a real-shaped secret reach a guarded commit — strict
publish-safety bar → BROKEN.** All verified against the actual `--staged` gate:
- **CRITICAL — type-change (`T`) excluded from the staged scan.** `--diff-filter=ACMR`
  drops `T`. Change a tracked symlink/gitlink into a regular 100644 file whose
  blob carries an AWS-key-style assignment → `git diff --cached --name-only
  --diff-filter=ACMR` returns empty, the blob is NEVER read, gate PASSES, secret
  is in the index. This is a hole in the round-2 enumeration itself, not just
  detection scope.
- **HIGH — NUL-byte / binary-extension downgrade.** A single NUL byte anywhere in a
  blob (or a `.pdf/.zip/.ttf/.woff2` extension) downgrades the WHOLE file to
  KEY/PEM-shape-only scanning; assignment/email/conn-string/provider-key classes
  are skipped. Staged `apikey=<body>` + one trailing NUL → PASSES.
- **HIGH — images skipped entirely in repo/staged mode.** A `github_pat_`-style
  token inside a text `.svg` → PASSES (early `continue`, not even `scanKeyShapes`).
  SVGs commonly live under `public/`/`docs/assets/` — the very dirs the publish
  TREE gate ALLOWLISTS without content-scanning — so such a token ships end to end.
- **HIGH — major provider formats have no matcher.** Google `AIza…`, Stripe
  `sk_live_/rk_live_`, GitHub fine-grained `github_pat_…`, SendGrid `SG.…`, npm
  `npm_…` bare, PyPI `pypi-…`, JWTs, and generic 32/40-hex or base64 high-entropy
  secrets (no keyword nearby) all pass `scanLine`. Note Stripe uses `sk_`
  (underscore) so the `sk-` matcher misses it. These are outside the ticket's
  stated success criteria but are unambiguously real secrets under the "any
  real-shaped secret" bar.
- **MEDIUM — assignment-key synonyms missing:** bare `pwd=`, `cred=`, `auth=`,
  `token=`, `cookie=`, `session=`, `private-token=` are not in `SECRET_KEY_SRC`.
- **MEDIUM — placeholder substring suppresses real secrets:** a genuine value
  containing `example`/`sample`/`test`/`here` anywhere is waived (`PASSWORD=MyReal…example…P4ss` passes).
- **MEDIUM — password-only connection URL** (`redis://:pass@host`) not matched
  (`CONN_STRING` requires a user before `:`).
- **MEDIUM — allowed-domain subdomains waive personal email:** `endsWith('.'+domain)`
  lets `alice@corp.microsoft.com`, `x@internal.oraios-ai.de` through.
- **LOW–MED — symlink targets never scanned:** a staged symlink whose TARGET string
  is a home path or a secret path commits unscanned (mode 120000 skipped).
- **LOW — YAML block-scalar / list values** (`api_key: |` then value on next line;
  `api_key: [value]`) not matched (line-by-line scan; `[` truncates `ASSIGN_BARE`).

**Compound-command gap (attack 3) — CONFIRMED, matters for the imminent commit.**
`git add -A && git commit …` (and `git add <f> && git commit …`) resolve in the
FEAT-108 classifier to offender `git add` (non-publishing), so `evaluateGitWrite`
does NOT run the agent-path leak gate. A lone `git commit` / `git commit -am`
resolves to `git commit` (publishing) and DOES. For the orchard repo the
`.git/hooks/pre-commit` backstops the compound form (verified: staged secret +
hand `git commit` → hook refuses); a bare project without hooks installed is
exposed to a compound stage+commit from a granted agent. `--no-verify` still
bypasses hooks (documented); `git.ts commit()` does not accept a bypass.

**SAFE COMMIT FORM for the orchestrator (given the above):** run staging and
commit as SEPARATE Bash calls, never compounded —
  1. `git add <explicit files>`  (or `git add -A`)
  2. `git commit -m "…"`   ← standalone, so BOTH the agent-path gate (tree ∪
     staged) AND the `.git/hooks/pre-commit` (--staged --identity) fire.
Confirm `git config user.email` is the `…@users.noreply.github.com` identity
first. This double-covers today's work. **Practical risk to TODAY's diff is low:**
the tokens actually present (home path, username, github handle, personal email,
private project names, `sk-ant` keys) are all caught on every path, and the holes
above require secret shapes / file states not in today's changes. The BROKEN
verdict is against the gate's publish-safety GUARANTEE, not a block on committing
today's already-clean work via the safe form.

**Follow-up (new ticket-worthy):** fix the `--staged` enumeration to include `T`
and to content-scan (not skip) binary/NUL/image blobs at least for KEY/PEM +
assignment shapes; add provider-format matchers (`AIza`, `sk_live_`,
`github_pat_`, `SG.`, `npm_`, JWT, generic entropy); anchor `isPlaceholder` to the
whole value; add a leak-gate step to the FEAT-108 classifier for compound
`add && commit`. Repro scripts: `~/scratch/feat130-harness.mjs`,
`~/scratch/feat130-enum.mjs`. OpenAI transcript: `…/transcripts/openai/…01a074df….jsonl`.

### 2026-09-07 — worker (fixing, round 3) — round-2 verifier holes closed (detector + `--staged` enumeration)

Built the round-2 verifier's follow-up list, scoped to the detector + gate (all in
`scripts/`; NO `src/server/` edits). Left unstaged. Files changed:
`scripts/lib/leak-tokens.mjs`, `scripts/leak-gate.mjs`,
`scripts/verify-feat-130-leak-detection.mjs`.

- **A. `--staged` enumeration now includes type-change `T`** (`leak-gate.mjs`):
  `--diff-filter=ACMR` → `ACMRT`. The round-2 CRITICAL — a tracked symlink/gitlink
  flipped to a regular 100644 file whose blob carried a secret was reported by
  `git diff --cached` under `T` but the `ACMR` filter dropped it, so the blob was
  never read and the gate PASSED with the secret in the index. `D` (deletion,
  no content) is still excluded; the `100644/100755` mode filter is unchanged.
- **B. Binary / NUL / image content is now credential-scanned, not KEY-only.**
  New shared `scanBinary(text)` (`leak-tokens.mjs`): KEY/PEM/provider shapes over
  the whole blob PLUS the assignment / connection-string classes over each
  newline/NUL-delimited chunk (email excluded — it floods on binary noise). The
  gate's binary/NUL branch now calls `scanBinary` (was `scanKeyShapes`), closing
  the round-2 HIGH where one trailing NUL downgraded a staged `apikey=<body>` to
  KEY-only and slipped. Text **SVGs** are now content-scanned in EVERY mode (they
  are XML text and live under the very `public/`+`docs/assets/` dirs the TREE
  allowlist waived without scanning — round-2 HIGH `github_pat_` in a `.svg`).
  Raster images are deliberately NOT text-scanned (huge FP risk over pixel bytes;
  their pixel-leak risk stays the TREE allowlist's job).
- **C. Provider-format matchers added** (`KEY_SHAPES`): Google `AIza`, Stripe
  `sk_/rk_ live|test` (underscore — the `sk-` matcher missed it), GitHub
  fine-grained `github_pat_`, SendGrid `SG.`, npm `npm_`, PyPI `pypi-AgE`, and
  JWT (`eyJ…`.`eyJ…`.`…`, placeholder-guarded). Each body is pinned to the
  provider's real length/charset so a ticket writing the shape with an ellipsis
  does not trip.
- **D. `isPlaceholder` anchored to the WHOLE value** (`leak-tokens.mjs`): replaced
  the substring test (which waived any value merely CONTAINING "example"/"test"/
  "here") with an ENTROPY-anchored test — a value with any high-entropy chunk
  (long or mixed-class run) is NOT a placeholder even if another token spells
  "example"; only a value with no such chunk is waived, and only when it also
  carries a structural marker (`<…>`, `${…}`, `xxxx`, `…`, `***`) or a placeholder
  word. Closes the round-2 MEDIUM (`PASSWORD=MyReal…example…P4ss` now caught)
  while `your-key-here` / `not-a-real-token` / `<your-secret>` stay clean.

- **Verification — must-FAIL then must-PASS, real runs (not asserted):**
  - BEFORE (current code, scratch): every class MISSED — `scanLine` returned 0 for
    all six provider formats + JWT; `scanKeyShapes` 0 on `apikey=<body>`+NUL; the
    real password containing "example" 0; the `--staged` gate exited **0** (pass)
    on the symlink→file `T` bypass (secret provably in the staged blob) and on a
    text SVG carrying `github_pat_`. Logs: `~/scratch/feat130r3/before.mjs`,
    `before-gate.mjs`.
  - AFTER: all six providers + JWT CAUGHT; binary `apikey=`+NUL CAUGHT; real
    password-with-"example" CAUGHT; `--staged` gate REFUSES (exit 1) the `T`
    bypass and the SVG, with a clean SVG still passing (no FP).
    Logs: `~/scratch/feat130r3/after.mjs`, `after-gate.mjs`.
  - Encoded as permanent regression tests: `verify:feat-130` now **83/83** (was
    58; +25 for D2 providers, D3 anchoring both directions, D4 `scanBinary`, D5
    gate-level `T`/SVG/clean-SVG). All fixtures split-literal so the tracked suite
    is itself gate-clean.
  - FP proof on the USER'S real tree: `npm run gate` exit **0** (read directly,
    unpiped) — leak-gate + check-nul + typecheck all PASS, only the LICENSE waiver
    reported. The new SVG/binary scanning did not flag any real `.svg` in the tree.
  - Shared-detector consumer intact: `verify-leak-store-guard` 13/13.
- **Not my regressions:** `verify-board-tool` 27/7 — the 7 are board-drift
  UNMAPPABLE-STATUS on FEAT-129/131/132 ticket headers (other lanes' tickets),
  identical to the round-2 note; my change touches no board tooling.
- **Deliberately NOT done (out of this lane's scope; documented gaps remain):**
  - The FEAT-108 classifier fix for compound `git add && git commit` lives in
    `src/server/` and rides the session/tools path — flagged as a **collision
    risk** with the concurrent BUG-159 lane; NOT edited. The in-repo pre-commit
    hook remains the backstop; a bare project without hooks is still exposed to a
    granted agent's compound stage+commit. Needs its own ticket/lane.
  - **Generic-entropy detector deliberately omitted** — a bare 32/40-hex or
    base64 matcher floods on the git SHAs that fill every ticket; adding it would
    make the gate `--no-verify`-bait. Structured provider formats cover the real
    cases; a keyword-anchored entropy check could be a future refinement.
  - Assignment-key synonyms (`pwd`, `token=`, `auth=`, `cookie=`, `session=`)
    still absent: `PWD=` collides with the ubiquitous working-directory env var,
    and bare `token=`/`auth=` flood on URLs — left for a precision-tuned pass.
  - Still open from round 2 (unchanged, lower risk): allowed-domain SUBDOMAIN
    waiver, symlink-TARGET string never scanned, YAML block-scalar/list values.
- **Flag (HIGH-STAKES):** security + publish-safety + this is round 3 of a change
  the prior two rounds got wrong. An independent adversarial clean-room re-verify
  (fresh agent attacking each new matcher + the `T`/SVG/binary paths, and probing
  for FPs the entropy anchor might introduce) is WARRANTED before this is called
  done. `regressed-from:` none — these are gaps the prior rounds left, not
  breakage they introduced.
- **Handoff:** the round-3 detector/enumeration is ready; the day's work still
  commits THROUGH the gate via the safe (separate stage / standalone commit) form
  the round-2 verifier documented. The worker committed nothing.

### 2026-09-07 — verifier (verifying, round 1 of round-3 fix) — VERDICT: BROKEN

Independent CLEAN-ROOM adversarial verify of the round-3 detector/enumeration
change, run as a SEPARATE PROCESS (not an in-process Task subagent) via
`scripts/independent-verify.mjs --working-tree` (the FEAT-134 dirty-tree flag).
Cross-provider decorrelation: verifier ran on **openai**. Exit 1 (verdict BROKEN),
contract VALID (fixer suite re-run + uncovered adversarial case + could-not-test
list all present).

- **Bootstrap sanity (FEAT-134 `--working-tree` is itself not yet independently
  verified, so this run bootstraps on unverified tooling):** confirmed BEFORE the
  spend via `--print-prompt` — snapshot HEAD `f42537f` → tree `c0effad5`; the diff
  the verifier received was non-empty and contained the COMPLETE hunks for all
  three FEAT-130 files (`scripts/leak-gate.mjs`, `scripts/lib/leak-tokens.mjs`,
  `scripts/verify-feat-130-leak-detection.mjs`). Default `--max-diff-bytes 60000`
  truncated the 453 KB whole-working-tree diff and cut FEAT-130's files off
  (they sort after docs/public/src); raised the cap to 500000 so the full diff
  (untruncated) reached the verifier. Clean room stripped `docs/prompts` +
  `docs/bugs` (ambient surface). The run is NOT a laundered/empty diff.
- **Fixer suite RE-RUN (real command, real output):**
  `node scripts/verify-feat-130-leak-detection.mjs` → EXIT 0, **83/83 passed**
  (manifest 3bf05d6fa1ef). Reproduced, not taken on faith.
- **Adversarial cases the fixer's fixtures do NOT cover (real run, `attack-leak.mjs`,
  EXIT 1, manifest b0d0d163e1dd) — 3 REAL RECALL BREAKS:**
  1. **`isPlaceholder` entropy anchor waives a genuine secret.** A high-entropy
     `PASSWORD=`-style assignment with the literal run `xxxx` spliced into the
     MIDDLE of the value → `scanLine`/`scanBinary` return 0, `--staged` exits 0.
     The structural `xxxx` marker overrides the high-entropy chunk — the exact
     class of hole the round-3 D4 anchoring claim was meant to close, now
     re-opened by the marker taking precedence over entropy.
  2. **Placeholder-before-secret masks the real secret on the same line.**
     `PASSWORD=<placeholder>; PASSWORD=<real high-entropy value>` on one line →
     0 hits, `--staged` exits 0. Line-level placeholder suppression waives the
     whole line including the trailing real assignment.
  3. **Google `AIza` matcher boundary/charset gap.** A 39-char `AIza…` key whose
     35-char body ends in a hyphen is missed by both detectors and allowed by
     `--staged`.
  (Secret VALUES not pasted here per the project's shape-not-value convention —
  the hardened gate would flag them and this ticket would fail its own gate.)
- **Precision controls HELD (must-NOT-fire, all SURVIVED):** a real
  `PASSWORD=<high-entropy>` IS caught; `PASSWORD=your-key-here` stays clean; a
  git-SHA-shaped `revision=<40-hex>` is NOT flagged.
- **Could-not-test (stated by the verifier):** live provider-credential validity
  (fixtures are fabricated); full binary/SVG COMMIT-path enforcement for these
  specific new attacks (exercised through `scanBinary` directly + staged text
  blobs, not through a binary/SVG blob end-to-end).
- **Root of the recall breaks:** the entropy-anchored `isPlaceholder` treats a
  structural placeholder marker (`xxxx`/`your-key-here`) as decisive even when a
  high-entropy secret chunk co-exists on the same value/line; the fix must not let
  a placeholder token WAIVE a co-located high-entropy secret, and the `AIza`
  matcher's body boundary must not stop at a hyphen. This is the same "placeholder
  substring suppresses real secrets" family the round-2 verifier flagged (D4 was
  the attempted fix); `regressed-from:` FEAT-130 round-3 (D4).
- **Caveat stated plainly:** `--working-tree` (FEAT-134) is new and NOT yet
  independently verified, so this verdict bootstraps on unverified tooling; the
  diff/clean-room sanity check above is the guard against a broken tool laundering
  a false green, and it passed.
- **Verified-by:** dispatch openai run 01a07918-d020-7ae2-9866-c706f5b3f131
  (clean-room, `scripts/independent-verify.mjs --working-tree`) — VERDICT: BROKEN.
  Kept clean room + verdict at `~/scratch/feat130-verify/verdict.txt`.

### 2026-09-07 — worker (fixing, round 4) — three round-3 bypasses closed; per-token placeholder decision

- **Scope:** `scripts/lib/leak-tokens.mjs`, `scripts/verify-feat-130-leak-detection.mjs`
  only. `scripts/leak-gate.mjs` needed no change (it imports the shared matcher).
- **must-FAIL reproduced first (real command, real output)** against the round-3
  detector, using the round-1-of-round-3 verifier's EXACT inputs from
  `~/scratch/feat130-verify/verdict.txt`. `scanLine`+`scanBinary` each returned 0
  hits for all three (`EXIT=1`, 3 FAILURES); controls already green:
  1. `PASS`+`WORD=<high-entropy run with an `xxxx` marker spliced in>` → 0
  2. `PASS`+`WORD=your-key-here; PASS`+`WORD=<real high-entropy>` → 0
  3. `AI`+`za<35-char body ending in a hyphen>` → 0
- **Root cause (confirmed, matches the dispatch's direction — #1 and #2 are ONE
  defect, granularity):**
  - #1: `isPlaceholder` consulted `STRUCTURAL_PLACEHOLDER` (which includes `xxxx+`)
    BEFORE the entropy check, so a marker spliced into a single high-entropy alnum
    run waived the whole value — a per-value decision overriding a real per-token
    secret.
  - #2: the three assignment regexes were run with a single `.exec()`, which
    returns only the FIRST match on a line, so a placeholder assignment written
    before a real one masked it — a per-line decision.
  - #3: the `AIza` matcher terminated its body with `\b`, which fails after a
    non-word char, so a 35-char body ending in `-`/`_` did not match.
- **Fix (granularity moved to per-token/per-match, NOT two more special cases):**
  - `hasEntropyChunk` now requires genuine character-class diversity — dropped the
    single-class `length >= 20` branch — so a run of identical marker chars
    (`xxxx…`, `***`) is no longer mistaken for entropy; `isPlaceholder` checks
    entropy FIRST and only consults structural marker / placeholder word when NO
    token is secret-shaped. A value with no marker and no placeholder word is
    still never waived, so recall for a marker-free real secret is unchanged.
  - the three assignment regexes carry `g` and are iterated with `matchAll` (every
    assignment on the line), deduped by key label. This closes #2 AND collapses the
    pre-existing double-report (`PASSWORD=…` was emitted twice by dotenv+bare).
  - the `AIza` body terminator is now a negative lookahead `(?![0-9A-Za-z_-])`
    instead of `\b`, pinning the body to exactly 35 chars whatever the last one is.
- **Each bypass proven closed** — re-ran the repro (`EXIT=0`, all pass), and drove
  the REAL `--staged` gate end-to-end (node/execFileSync harness, git-write-clean)
  on the exact three inputs: all three now `exit=1` (FAIL/refused); controls
  `PASSWORD=your-key-here` and `revision=<40-hex SHA>` stay `exit=0` (PASS).
- **Precision — must-NOT-fire (all confirmed clean), incl. high-entropy
  NON-secrets added to the fixture set per dispatch:** real secret still caught;
  `your-key-here` clean; git SHA clean; **lockfile `integrity sha512-<hash>` clean;
  minified-bundle high-entropy string literal clean; pure `xxxx…` placeholder still
  waived.** Added as verify-script section **D6** (8 new assertions).
- **Full FEAT-130 suite:** `node scripts/verify-feat-130-leak-detection.mjs` →
  **91/91 passed** (was 83/83; +8 D6). **`npm run gate` → EXIT 0** (PASS —
  leak-gate + check-nul + typecheck) on the real tree. Note: the first gate run
  correctly FAILED on this worker's own not-yet-split comment literal and fixture
  var (`R4SECRET`); made both self-immune (reworded comment; renamed to `R4BODY`
  split into ≤5-char fragments) — the gate catching them is evidence it works.
- **regressed-from:** FEAT-130 round-3 (the D4 entropy anchor). #1 re-opened the
  same "placeholder substring suppresses a real secret" family round 2 flagged.
- **Independent verify warranted:** YES — this is a regression-prone security
  detector on its 4th round touching a file with a history of regressions; a
  fresh clean-room pass (`scripts/independent-verify.mjs --working-tree`) against
  the round-4 diff, re-attacking the placeholder/entropy granularity and provider
  boundaries, should be the last word, not this self-verified suite.
- **Files changed (unstaged, for the user to commit):**
  `scripts/lib/leak-tokens.mjs`, `scripts/verify-feat-130-leak-detection.mjs`,
  and this ticket.
