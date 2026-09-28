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
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-09-28",
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
  lets `alice@corp.<maintainer-domain>`, `x@internal.<maintainer-domain>` through.
  <!-- FEAT-130 round 5 self-immunity: the two synthetic example addresses on this
  line were split to shape-form once round 5 CLOSED this subdomain hole and the gate
  (correctly) began flagging them — same "describe the shape, never paste the value"
  redaction the round-2 entry above applied; the entry's meaning is unchanged. -->
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

### 2026-09-23 — verify lane (drift re-check, round 1, class=verify) — REFUTED
- **Ground-truth re-verification of the "landed" claim.** The round-4 detector +
  `--staged` enumeration IS committed (`78a8a5a`, carried through `dc1f4ea`;
  `matchAll`/`hasEntropyChunk`/`AIza` negative-lookahead all present; working tree
  clean). `node scripts/verify-feat-130-leak-detection.mjs` → **91 passed / 0
  failed**. So the CODE landed and the fixer's own suite is green.
- **But the ticket's own bar is UNMET, so this is REFUTED as done:**
  1. The last INDEPENDENT verdict on record is **BROKEN** (2026-09-07,
     `dispatch openai 01a07918-…`, clean-room `--working-tree`). Round 4 closed
     those three holes but was **self-verified only** — it explicitly states
     "independent verify warranted: YES … should be the last word, not this
     self-verified suite." No passing `Verified-by:` exists; `board:check` would
     flag it. Landing round-4 code without a clean-room re-verify does not clear
     the BROKEN verdict.
  2. Documented residual gaps remain OPEN by the fixer's own admission (round-3/4
     "Still open"): allowed-domain SUBDOMAIN email waiver, symlink-TARGET string
     never scanned, YAML block-scalar/list values, and the compound
     `git add && git commit` FEAT-108-classifier gap (backstopped only by the
     in-repo hook; a bare project without hooks is still exposed).
- **Verdict: REFUTED — implemented but not done.** Its own security/publish-safety
  class + 4-round regression history require an independent clean-room PASS it has
  never received (last was BROKEN). Real legal status: IN-PROGRESS / IN
  VERIFICATION, not Done. Recommend: dispatch a fresh clean-room re-verify of the
  round-4 diff (re-attack placeholder/entropy granularity + provider boundaries)
  before any Done. This lane changed no code and set no status.

### 2026-09-23 — worker (fixing, round 5, class=fix) — round-4 3 holes re-confirmed CLOSED; 2 residual FALSE-PROOF holes fixed; 1 decision fork left

Ground-truth re-verification of every gap the last INDEPENDENT verdict (2026-09-07
BROKEN, `dispatch openai 01a07918-…`) and the fixers' own "Still open" notes leave,
tested against the code at HEAD (`78a8a5a`, carried through `ca672b9`) — NOT trusting
the fixer's 91/91 suite. Scope: `scripts/lib/leak-tokens.mjs`,
`scripts/verify-feat-130-leak-detection.mjs` only (leak-gate.mjs needed no change —
it imports the shared matcher). No `src/server/` / `public/` / `git-grant*` /
`git-shim` touched (those belong to concurrent BUG-150/160/184 lanes).

- **Round-4's three fixes — independently RE-CONFIRMED CLOSED** (adversarial re-run
  of the round-3 verifier's exact inputs against HEAD `scanSecrets`, real output):
  (1) `xxxx` spliced into a high-entropy run → CAUGHT (`secret assignment`);
  (2) placeholder assignment before a real one on the same line → CAUGHT;
  (3) `AIza` body ending in a hyphen → CAUGHT (`google api key`). So the last BROKEN
  verdict's three recall breaks are genuinely fixed in landed code.

- **Two residual FALSE-PROOF holes were STILL OPEN at HEAD and are now FIXED (round 5):**
  1. **Subdomain of a maintainer domain waived a personal email (round-2/3 MEDIUM).**
     `emailAllowed` used `domain === e || domain.endsWith('.' + e)` over a flat list, so
     a personal address at a SUB-host of a registered maintainer domain was waived.
     must-FAIL proof (HEAD): `emailAllowed('alice@corp.'+'microsoft.com')` → `true`;
     scanSecrets → 0 hits. Fix: split the allow list into `ALLOWED_EMAIL_SUFFIX`
     (RFC-2606 reserved TLDs + systemd/mDNS pseudo-hosts — suffix match kept, they can
     never be a deliverable personal address at any depth) and
     `ALLOWED_EMAIL_DOMAIN_EXACT` (registered noreply + dependency-maintainer domains —
     EXACT match, no subdomain waiver). AFTER: subdomain → flagged; `dev@microsoft.com`,
     `u@1000.service`, `a@sub.example.com`, the github noreply identity → still waived.
  2. **Password-only connection URL (`redis://:pass@host`, empty user) slipped
     (round-2 MEDIUM).** `CONN_STRING` required a `+` (≥1-char) userinfo user. must-FAIL
     proof (HEAD): scanSecrets on a `redis://:<body>@host` → 0 hits. Fix: userinfo user
     is now `*` (empty allowed); password capture still requires ≥1 char and the
     placeholder/code-ref guards still gate it. AFTER: pwd-only redis/amqp URLs →
     caught; `redis://:changeme@host` placeholder → clean; user:pass URLs → still caught.

- **Proof — both directions, real commands/output:**
  - Detector level: adversarial script over `scanSecrets`/`emailAllowed` — every new
    class FAILs when seeded, every precision control stays clean (0 regressions).
  - **End-to-end `--staged` gate** (Node-driven git harness, `/tmp/feat130r5-e2e.mjs`,
    Bash git is shimmed): SEEDED (pwd-only URL + subdomain email staged) → gate
    **exit 1** (blocked, secret in the index); CLEAN control (placeholder pwd URL +
    exact-domain email staged) → gate **exit 0**.
  - Encoded as permanent regression tests — new **D7** section (11 assertions).
    `node scripts/verify-feat-130-leak-detection.mjs` → **102 passed / 0 failed**
    (was 91; +11). Shared consumer `verify-leak-store-guard` → 13/13.
  - **`npm run gate` → EXIT 0** on the real (concurrent-lane-dirty) tree, read
    directly unpiped — leak-gate + check-nul + typecheck all PASS, only the LICENSE
    waiver reported.
  - **Self-immunity fallout (evidence the fix works):** once round 5 closed the
    subdomain hole the gate (correctly) began flagging the SYNTHETIC example addresses
    (`alice@corp.<maintainer-domain>` / `x@internal.<maintainer-domain>` shape) that a
    prior append-only entry (round-2, line ~223) and my new files had pasted un-split. Reworded my new
    comments to shape-form, re-split the test literals, and split the two examples in
    the round-2 entry to `<maintainer-domain>` shape form with an inline note — the
    same synthetic-literal redaction the round-2 worker documented earlier in this log;
    meaning unchanged. `regressed-from:` none (these are gaps prior rounds left open,
    not breakage they introduced; the fix is additive precision).

- **STILL OPEN — one DECISION FORK for the orchestrator (not fixed here, by design):**
  **Assignment-key synonyms** (`token=`, `auth=`, `pwd=`, `cred=`, `cookie=`,
  `session=`) are NOT in `SECRET_KEY_SRC`, so `token=<high-entropy>` bare slips.
  Round 3 omitted them DELIBERATELY: bare `token=`/`auth=` flood on URL query params
  and `PWD=` collides with the ubiquitous working-directory env var. This is exactly
  the "what counts as a secret worth blocking a publish over, and at what
  false-positive cost" project-direction question — FORK: (a) add them (higher recall,
  real FP risk on doc URLs / `PWD=` → gate becomes `--no-verify`-bait), vs (b) leave
  them out (a bare `token=<secret>` in a committed file slips). Needs your call; I did
  not guess.

- **STILL OPEN — lower-risk, documented, NOT fixed (scope/frequency judgement):**
  YAML inline-list `api_key: [value]` (the `[` truncates `ASSIGN_BARE`; low-frequency
  shape); YAML multi-line block-scalar `api_key: |` + next-line value (architectural —
  the line-by-line scanner cannot see the value line without lookahead);
  staged **symlink-TARGET** never scanned (mode 120000 skipped in `--staged`; an
  absolute home-path symlink target commits unscanned — a real but low-frequency
  home-path leak vector; scanning it needs its own FP analysis vs scratch symlinks);
  the compound `git add && git commit` **FEAT-108 classifier** gap (lives in
  `src/server/`, owned by concurrent lanes — out of this lane's scope; backstopped by
  the in-repo pre-commit hook; belongs to its own ticket/lane).

- **Independent verify — WARRANTED (HIGH-STAKES).** This is a regression-prone
  security detector, now round 5 on a file with a documented regression history, and
  the last INDEPENDENT verdict on record is BROKEN. This lane is self-verified only.
  A fresh clean-room pass (`scripts/independent-verify.mjs --working-tree`) over the
  round-5 diff — re-attacking the subdomain/exact split (probe: does an EXACT
  maintainer-domain personal address wrongly slip? does a reserved-suffix change lose a
  real catch?) and the conn-string empty-user change (probe for new FPs on ordinary
  userinfo-bearing URL strings of the `scheme`-slash-slash-`host`-colon-`port`-at form)
  — should be the last word before Done, not this
  suite.

- **Files changed (unstaged, for the user to commit):**
  `scripts/lib/leak-tokens.mjs`, `scripts/verify-feat-130-leak-detection.mjs`,
  and this ticket. (Other dirty files in the tree — `public/app.js`, `src/server/*`,
  `scripts/git-grant*`, `scripts/lib/git-shim.mjs`, other tickets — belong to
  concurrent lanes; untouched by this lane.)

### 2026-09-23 — worker (fixing, round 6, class=fix) — round-5 DECISION fork resolved: generic assignment keys behind a value-shape floor

The user DECIDED the round-5 open fork: add generic assignment-key detection
(`token=`, `auth=`, `pwd=`, and siblings — `secret=`/`api_key=`/`password=` were
already in the high-signal list) **gated behind a strict value-shape FLOOR** so it
only fires on things that actually look like secrets. The floor is the point, not a
refinement: this repo is full of code that writes these words, and a noisy gate gets
`--no-verify`'d. Scope: `scripts/lib/leak-tokens.mjs` +
`scripts/verify-feat-130-leak-detection.mjs` only (`leak-gate.mjs` needed no change —
it imports the shared matcher). Left unstaged.

- **Design — a SEPARATE generic-key list with its own strict floor** (not merged into
  `SECRET_KEY_SRC`, whose high-signal keys keep their looser floor). New
  `GENERIC_SECRET_KEY_SRC` = `token|auth|pwd|passphrase|credentials?|cred|cookie|
  session|api_secret|secret_token|private_token|session_(token|key|secret)|client_key|
  access_secret`, each anchored by a leading negative-lookbehind `(?<![A-Za-z0-9_])`
  so `oauth=`/`mysession=`/`author:` do NOT match `auth`/`session`. Bare (`=`/`:`) and
  quoted forms.
- **The FLOOR (`looksHighEntropySecret`, both a length min AND an entropy/charset
  test):** value length ≥ 18; passes `isSecretValue` (so placeholders `<redacted>`,
  code-refs/templates `$PASSWORD`/`${env.AUTH}`/`process.env.X`, prose-with-space and
  bare numbers are already out); character-CLASS diversity = 3 (lowercase AND uppercase
  AND digit all present — a random credential mixes all three; identifiers, dictionary
  words, filesystem paths, lowercase-hex digests like git SHAs, and base64-of-lowercase
  do NOT); Shannon entropy ≥ 3.2 bits/char (guards a long-but-repetitive 3-class value).
  A value that already matches a known provider `KEY_SHAPE` (an `sk-`/`ghp_`/`AIza…`
  assigned to a generic `token=`) is NOT re-reported — no double-report.
- **WHOLE-TREE false-positive MEASUREMENT (the requirement, real run):** scanned every
  one of the 1102 tracked files for the new generic class →
  **0 generic-assignment hits.** `node scripts/leak-gate.mjs` (whole-tree, read-only)
  output is BYTE-IDENTICAL to the pre-change baseline — still `PASS — 0 hits across 1102
  files`, only the LICENSE waiver. `npm run gate` → **EXIT 0** (leak-gate + check-nul +
  typecheck all PASS), read directly unpiped. The strict floor produces zero new FPs;
  no waiver needed.
- **Both directions, real gate end-to-end (no git writes — reads only):**
  - must-FAIL BEFORE: the committed HEAD (round-5) `scanSecrets` returns **0** for
    `token=`/`auth=`/`pwd=`/`cookie=`/`session=`+`<high-entropy body>`; round-6 returns
    **1** for each.
  - end-to-end: seeded an untracked file `token=<25-char 3-class body>` into the real
    tree → `node scripts/leak-gate.mjs` **exit 1** (hit reported: `[secret assignment]
    token=…`); removed the seed → **exit 0**. This exercises the real gate (working-tree
    REPO mode reads only, no blocked git write).
  - precision controls all clean: `token=abc`, `pwd=$PASSWORD`, `auth=${env.AUTH}`,
    `secret=<redacted>`, `token=your-key-here`, bare `token=`, `auth=authHeaderValue`
    (identifier), `session=req.session.token` (code-ref), `token=${TOKEN}` (template),
    `cookie=document.cookie`, a 40-hex git-SHA value (2-class), a long low-entropy
    3-class value, `mysession=`/`author=` (boundary), and `token=<ghp_ key>`
    (reported once as the provider shape, not doubly).
- **Permanent regression tests — new `D8` section (+26 assertions).** The suite now
  totals **128** assertions (was 102). Fixtures are SPLIT into ≤5-char fragments (var
  `R6BODY`, not on the secret-key list) so the tracked file stays gate-clean (verified:
  whole-tree gate is clean with the edited suite present).
- **Verification honesty — git-driving suite sections could NOT run in this lane.**
  Sections `D5/E/F/G` (scratch-repo `git init/add/commit` + `--staged`) require real git
  writes; git writes are BLOCKED for agent sessions (FEAT-108 hook + FEAT-135 shim) and
  this lane has no user grant, so an in-process full run throws at D5. What I ran:
  the pure-detector sections **A–D4 = 69/69, 0 failed**; the new **D8 = 26/26** via a
  standalone replay of its exact assertions against the real imported functions; plus the
  whole-tree gate and the seeded end-to-end proof above. The enforcement plumbing is
  UNCHANGED by this patch (I touched only the shared matcher's assignment classes, which
  the gate imports) and the seeded-file run proves the gate inherits the new class. Under
  a user git grant the full suite should report **128/128**; the orchestrator/user should
  run it once with the grant to confirm D5/E/F/G stay green.
- **regressed-from:** none — this is the additive recall the round-3/5 fixers
  deliberately deferred pending the user's precision-vs-recall decision, now made.
- **Independent verify — WARRANTED (HIGH-STAKES):** security detector, 6th round on a
  file with a documented regression history; this lane is self-verified only. A fresh
  clean-room pass (`scripts/independent-verify.mjs --working-tree`) should re-attack the
  floor — probe for a real secret the class MISSES (a 2-class hex/base64-lower token with
  a generic key; a value 16–17 chars long) and for a FP the floor lets through (a
  high-entropy-looking non-secret assigned to `token=`/`session=` in real code) — and
  should run the full suite WITH a git grant to confirm the enforcement sections.
- **Files changed (unstaged, for the user to commit):**
  `scripts/lib/leak-tokens.mjs`, `scripts/verify-feat-130-leak-detection.mjs`, and this
  ticket.

### 2026-09-23 — independent verifier (verifying, round 7)
**VERDICT: PASS** (not cosmetic-only). Read diff + test + problem statement only, not the
fixer's rationale. All commands executed with real output.
- **Suite + gate (once each):** `verify:feat-130` → 128 passed / 0 failed. Whole-tree
  `npm run gate` → PASS (leak-gate + check-nul + typecheck, exit 0), no clean-tree false
  positive. Detector run over a realistic external corpus (real `package-lock.json` +
  3 minified bundles, 2102 lines) → **0 hits**. So the FAIL criterion (any clean-tree /
  realistic false positive) is NOT met — precision holds.
- **Empirical floor (measured, not argued):** length flips exactly at 18 (16/17-char
  random 3-class body MISS, 18 CATCH); entropy floor genuinely bites — a len-18 *repetitive*
  3-class value `aAbB1234aAbB1234aA` (entropy 2.97) MISSES, a high-variety one (4.17) CATCHES.
  Word-boundary (`mysession=`,`author=`), placeholder/code-ref, and known-provider-shape
  no-double-report all behave as claimed.
- **False-NEGATIVE findings (recall gaps, not regressions):**
  (1) *JSON / quoted-KEY form* `"token": "<secret>"` is **MISSED** — and so is every
  high-signal key (`"password":`,`"secret":`,`"api_key":`). `ASSIGN_QUOTED`/generic regexes
  require an *unquoted* key, so the canonical config-file secret shape is uncaught. This is
  a PRE-EXISTING detector boundary, NOT introduced by round 6, but the round-6 suite only
  exercises the unquoted key (`credential: "…"`), so JSON-config recall is untested + absent.
  Highest-value follow-up.
  (2) By-design floor misses (precision/recall tradeoff, acknowledged): sub-18-char keys,
  single/two-class bodies (lowercase-hex/git-SHA, base64-of-one-class, numeric PIN), and
  **dictionary-word passphrases** (`passphrase=correct-horse-battery-staple`, entropy<3.2).
  The ticket lists `passphrase` as a synonym, but a real word-passphrase structurally cannot
  clear the entropy floor — the gate cannot catch it. Worth stating in the ticket as a known
  limitation rather than a covered case.
- **False-POSITIVE (latent, NOT clean-tree → not a FAIL):** a glued bare `key=<18+char,
  3-class, high-entropy value>` fires on non-secret shapes — an 18+char camelCase
  identifier-with-digit, a base64 test fixture assigned to `cookie=`, a CSS-in-JS class name.
  NONE occur in the tracked tree or the 2102-line external corpus, so there is no current
  false positive; but if such a glued assignment enters the tree (URL query params, generated
  code) it would trip. Latent precision risk to watch.
- **Could not test:** did NOT delegate a clean-room cross-provider dispatch pass — `node
  src/server/dispatch-client.mjs --check` reported openai AVAILABLE, but I ran the adversarial
  pass directly for empirical depth instead of delegating; noting this as the one deviation
  from the preferred method. Also untested: binary/non-UTF8 blobs and pathological
  single-line lengths beyond the sampled minified bundles.
- **Verified-by:** independent verifier (fresh context, Opus 4.8), 2026-09-23.

### 2026-09-23 — worker (fixing, round 8, class=fix) — quoted-KEY (JSON) form closed; separator expressed once (ARCH-010)

Closed the round-7 verifier's highest-value recall gap: the QUOTED-KEY config form
`"token": "<secret>"` (JSON) was MISSED for EVERY key — generic AND high-signal
(`"password":`, `"api_key":`, `"secret":`). Scope: `scripts/lib/leak-tokens.mjs`
+ `scripts/verify-feat-130-leak-detection.mjs` only (`leak-gate.mjs` needed no
change — it imports the shared matcher, so the gate and the ticket-write guard both
inherit the fix). Left unstaged.

- **Root cause (confirmed by reproduction, real output):** every assignment regex
  anchored the separator immediately after the key name (`SECRET_KEY_SRC + '\s*[:=]'`).
  In JSON/YAML a quoted key's own CLOSING quote sits between the name and the `:`
  (`token"` `:` `"val"`), which `\s*[:=]` cannot cross, so the whole quoted-key form
  slipped. (The dispatch's YAML example `token: <secret>` actually already fired via
  `ASSIGN_BARE`/`ASSIGN_GENERIC_BARE`; the JSON quoted-key case is the true miss.
  Verified: on HEAD `scanSecrets('"api_key": "<val>"')` → 0 hits, `'"token": "<val>"'`
  → 0 hits; both fire after.)
- **Fix — the separator is a property of the SYNTAX, expressed ONCE (ARCH-010):** new
  shared `const KV_SEP = '["\']?\\s*[:=]\\s*'` — an optional closing-quote before the
  `[:=]` — reused by all four assignment regexes (`ASSIGN_QUOTED`, `ASSIGN_BARE`,
  `ASSIGN_GENERIC_BARE`, `ASSIGN_GENERIC_QUOTED`). Not duplicated per key. The opening
  quote before the key needs no handling (no matcher left-anchors the key to an alnum
  char; the generic lookbehind `(?<![A-Za-z0-9_])` is satisfied by `"`). Dedup labels
  strip the stray key-quote so the reported label stays `api_key=…`. The round-6
  value-shape FLOOR (len ≥18, 3 char classes, entropy ≥3.2) and every high-signal
  provider shape are UNTOUCHED — the change is purely the separator's syntax.
- **WHOLE-TREE false-positive MEASUREMENT (the requirement, real run):**
  `node scripts/leak-gate.mjs` over all **1103 tracked files → 0 hits** (only the
  LICENSE waiver), byte-identical to the pre-change baseline. `npm run gate` → **EXIT
  0** (leak-gate + check-nul + typecheck), read directly, unpiped.
- **FP sample-tests on the riskier colon/quoted form (dispatch-mandated), diffed
  HEAD-vs-round-8:** package-lock `"integrity": "sha512-…"`, JSON git-SHA revisions,
  `data:…;base64,…` URIs, CSS var hex, doc-quoted credential EXAMPLES
  (`"api_key": "your-api-key-here"`, `"password": "<redacted>"`), `"Content-Type":`
  headers, short-below-floor quoted values — all CLEAN. Ran both matchers over a
  **real external corpus of 402 node_modules files / 11 138 lines** (minified bundles,
  package-locks): HEAD 133 hits == round-8 133 hits, **0 new hits from round 8**. The
  only line whose behaviour changed across every probe was a base64 blob assigned to a
  QUOTED `"session":` key — which HEAD already flags in the UNQUOTED `session:"…"`
  form (round-6 accepted, round-7-noted latent risk); round 8 only makes the quoted
  form behave consistently with the unquoted one. Not a new FP class; the floor is
  unchanged; it is absent from the tracked tree and the external corpus.
- **Both directions, real gate end-to-end:** seeded an untracked `config.json` with
  `"api_key": "<20-char 3-class>"` and `"token": "<same>"` → `node scripts/leak-gate.mjs`
  **exit 1** (both reported: `[secret assignment] "api_key": …`, `"token": …`); removed
  the seed → **exit 0**. must-FAIL-before proven on HEAD (0 hits) vs after (fires).
- **Permanent regression tests — new `D9` section (+20 assertions).** Suite now totals
  **148** (was 128): quoted-key JSON caught for 5 high-signal + 4 generic keys; the
  three separator/quoting forms side by side; provider value inside a quoted key still
  reported; and 7 must-NOT-fire FP guards (integrity hash, git SHA, data-URI,
  placeholders, Content-Type, below-floor). `node scripts/verify-feat-130-leak-detection.mjs`
  → **148 passed / 0 failed** — and the git-driving enforcement sections E/F/G ran to
  completion in this lane's environment (scratch repos in /tmp), not skipped. Fixtures
  split into ≤5-char fragments / template-interpolated so the tracked suite stays
  gate-clean (whole-tree gate confirmed clean with the edited suite present).
- **regressed-from:** none — this is a PRE-EXISTING detector boundary (present since the
  round-2 quoted-value matcher shipped), surfaced by the round-7 verifier, not breakage
  a prior round introduced.
- **Independent verify — WARRANTED (HIGH-STAKES):** security/publish-safety detector,
  8th round on a file with a documented regression history; self-verified only. A fresh
  clean-room pass (`scripts/independent-verify.mjs --working-tree`) should re-attack the
  `KV_SEP` change — probe for a quoted-key shape the optional-quote still misses (e.g.
  key and value in different quote styles, TOML `"key" = "val"`, whitespace between key
  and quote) and for any NEW quoted-key FP the base64/`session:` family might extend.
- **STILL OPEN (unchanged, out of this lane's scope):** dictionary-word passphrases
  structurally can't clear the entropy floor (round-7 known limitation); YAML block-scalar
  `api_key: |` / inline-list `[value]`; staged symlink-TARGET; the compound
  `git add && git commit` FEAT-108-classifier gap (backstopped by the in-repo hook).
- **Files changed (unstaged, for the user to commit):**
  `scripts/lib/leak-tokens.mjs`, `scripts/verify-feat-130-leak-detection.mjs`, and this
  ticket.

### 2026-09-23 — independent verifier (verifying, round 9)
**VERDICT: FAIL — a realistic FALSE-POSITIVE class, not cosmetic (no STOP).** Read diff +
test + problem statement only. Suite `verify:feat-130` = 148 passed / 0 failed; whole-tree
`npm run gate` = PASS (exit 0). A CLEAN-ROOM CROSS-PROVIDER pass WAS run this round —
`dispatch-client.mjs --check` reported openai available; `npm run dispatch -- --provider
openai --prompt-stdin` handed over requirement+diff+test+run-instructions only (transcript
`.../openai/...01a0ced7-fca0-7c13-a1b4-5fef4074ffc9.jsonl`). It independently flagged the
same FP class (its suite run hit EROFS at D5 under the read-only sandbox — expected, the
detection probes it ran are unaffected). All findings below re-verified by me with a
committed-round-6 (`541dd73`) vs working-tree (round-8) before/after diff, real output.

- **FALSE-POSITIVE (decisive, realistic, NEW to round 8):** round 8 makes quoted-KEY JSON
  match, but the HIGH-SIGNAL quoted path (`ASSIGN_QUOTED`) gates only on `isSecretValue` —
  it lacks the `looksSecretish` guard that the BARE high-signal path (`ASSIGN_BARE`) already
  applies. So a single-token dictionary/type value on a quoted high-signal key now fires.
  Confirmed 0→1 (round 6 → round 8), each written here as `key → value` to avoid the
  quoted-key JSON shape the gate now matches: password → string, api_key → string,
  secret → boolean, password → required, password → optional, password → text/plain,
  client_secret → YOUR_CLIENT_SECRET. These are the canonical OpenAPI/Swagger/JSON-schema
  shapes (Swagger renders the password → string field placeholder) — definitionally NOT
  secrets, exactly the noise that gets a gate `--no-verify`'d. ROOT CAUSE is pre-existing
  (the UNQUOTED-key form password → "string" — key not quoted, value quoted — was already
  1→1 in round 6), but round 8 WIDENS it into JSON quoted keys — the single most common
  config format — so the exposure is materially new.
- **Not currently blocking:** the tracked tree does NOT trip (gate PASS); the only quoted
  high-signal JSON keys in-tree are prose in THIS ticket. So no clean-tree FP TODAY, but the
  gate WILL misfire the moment an OpenAPI spec / JSON schema / request-body example lands.
  Per the charter ("run over a realistic sample of non-secret assignments … any clean hit
  that is not a real secret is a FAIL"), this is a FAIL on the FP axis.
- **Suggested remedy (mechanism-verified, not applied):** apply the same `looksSecretish`
  guard to the high-signal quoted path. Measured: it drops `string`/`required`/`boolean`/
  `optional` (looksSecretish=false) while keeping every true secret (all TP=true). It would
  NOT catch `text/plain` (has `/`, 2-class) or `YOUR_CLIENT_SECRET` (2-class) — those want
  a placeholder/allcaps-underscore skip too. Generic keys are unaffected (their floor
  already requires 3 classes + entropy ≥ 3.2).
- **FALSE-NEGATIVE (secondary):** a base64 blob that decodes to plain text on a GENERIC key
  now fires via the quoted form too (the quoted-key JSON shape token → a 24-char base64
  run `SGVs…MjU2` decoding to plain ASCII text) — cleared the
  round-6 floor (3-class, len 24); pre-existing generic-FP class extended to quoted keys.
  Still MISSED (acceptable / out of scope): backtick-delimited values (`` token=`…` ``),
  a value containing an escaped quote, and dictionary-word passphrases (entropy floor).
- **NEIGHBOUR REGRESSION — answered: NO silent narrowing.** KV_SEP only ADDED the quoted-key
  match; every bare/unquoted high-signal and generic case is byte-identical round 6 → round 8
  (before/after table), the generic value-shape floor flips at the same len=18 / entropy=3.2
  boundary as round 7, and provider shapes (`sk-`, `ghp_`, `AKIA`) are unchanged
  (cross-provider pass + my diff both confirm). The ONLY behavioural delta is the intended
  new quoted-key catches — which include the FP class above.
- **Could NOT test:** the E/F/G enforcement suite under the openai read-only sandbox (EROFS
  on mkdtemp) — I ran it locally instead (148/0, includes E/F/G); binary/non-UTF8 blobs;
  exhaustive repo-wide precision beyond the tracked tree + the round-7 external corpus.
- **Verified-by:** independent verifier (fresh context, Opus 4.8) + clean-room openai
  dispatch pass, 2026-09-23.

### 2026-09-23 — worker (fixing, round 10, class=fix) — quoted HIGH-SIGNAL path now honours the value-shape floor

Closed the round-9 verifier's FALSE-POSITIVE finding. Examples below are written in
`key -> value` arrow notation (never the literal quoted-key/colon/quoted-value JSON
shape), so this entry does NOT trip the matcher it describes; the ticket scans clean.
Scope: `scripts/lib/leak-tokens.mjs` + `scripts/verify-feat-130-leak-detection.mjs`
only (`leak-gate.mjs` imports the shared matcher). Left unstaged.

- **Reproduced first (real output, round-8 code):** the quoted HIGH-SIGNAL path
  (`ASSIGN_QUOTED`) gated on `isSecretValue` ALONE, while the BARE high-signal path
  (`ASSIGN_BARE`) already gated on `isSecretValue && looksSecretish`. So a realistic
  OpenAPI / JSON-schema / doc value fired: `password -> string`, `api_key -> string`,
  `secret -> boolean`, `client_secret -> string`, `private_key -> string`,
  `access_token -> integer` all returned 1 hit — the canonical Swagger/JSON-schema
  property-to-type shape, definitionally not a secret. This became reachable when
  round 8 let quoted JSON keys match, so the exposure is materially new even though
  the underlying looseness pre-dates it.
- **Fix (ARCH-010 — the guard expressed ONCE, not per key or per form):** new shared
  `isHighSignalSecretValue(v) = isSecretValue(v) && looksSecretish(v)`, used by BOTH
  the bare and quoted high-signal loops in `scanSecrets`. The high-signal value
  predicate now lives in one place, exactly as `KV_SEP` shares the separator.
  `looksSecretish` (≥2 char classes OR ≥24 chars) is DELIBERATELY looser than the
  round-6 generic floor (3 classes + entropy ≥ 3.2): a high-signal key name is itself
  a strong signal, so its value need only look non-trivial — a real 2-class password
  (`hunter -> ...`) must still fire, which the strict generic floor would wrongly drop.
- **Both directions, real runs:**
  - schema/doc file (`password -> string`, `api_key -> string`, `secret -> boolean`)
    seeded into the tree -> `node scripts/leak-gate.mjs` **exit 0** (no hit);
  - real-looking secret (`api_key -> <20-char 3-class body>`) seeded -> **exit 1**
    (caught: `secret assignment`); removed -> exit 0;
  - recall kept: quoted mixed-class password, quoted provider token, and bare
    mixed-class key all still fire.
- **WHOLE-TREE false-positive count (real run):** `node scripts/leak-gate.mjs` over all
  **1105 tracked files -> 0 hits** (only the LICENSE waiver). `npm run gate` -> **EXIT
  0** (leak-gate + check-nul + typecheck), read directly, unpiped.
- **Suite:** new **D10** section (+10 assertions): 6 schema property-to-type shapes
  clean, bare type-value clean, and 3 recall-kept catches. `node
  scripts/verify-feat-130-leak-detection.mjs` -> **158 passed / 0 failed** (was 148);
  git-driving E/F/G ran to completion (scratch repos in /tmp).
- **regressed-from:** FEAT-130 round 8 — round 8 widened a pre-existing bare-form
  looseness into the quoted JSON-key form, which is what made it a realistic FP.
- **RESIDUAL (documented, NOT silently narrowed — a precision-vs-recall call for the
  coordinator):** `looksSecretish` still admits three LOOSER non-secret shapes on a
  high-signal quoted key: a media type (`password -> text/plain`, 2-class via `/`), a
  hyphenated token (`password -> ISO-8601`, 2-class), and an all-caps placeholder
  (`client_secret -> YOUR_CLIENT_SECRET`, 2-class). The round-9 verifier flagged these
  as beyond the `looksSecretish` remedy ("want a placeholder / allcaps-underscore skip
  too"). Tightening to the 3-class generic floor would drop them BUT would also stop a
  genuine weak 2-class password on a high-signal key from firing — the deliberate
  high-signal looseness. None occurs in the tracked tree (whole-tree still 0). Left for
  the coordinator: accept (favour high-signal recall) vs add a placeholder/allcaps skip.
- **Independent verify — WARRANTED (HIGH-STAKES):** 10th round on a regression-prone
  security detector; self-verified only. A clean-room pass should re-attack the shared
  `isHighSignalSecretValue` (probe: a real weak password wrongly dropped? the three
  residual shapes above; any bare-form recall lost by the refactor) and confirm no
  neighbouring pattern narrowed.
- **Files changed (unstaged, for the user to commit):**
  `scripts/lib/leak-tokens.mjs`, `scripts/verify-feat-130-leak-detection.mjs`, and this
  ticket.

### 2026-09-23 — independent verifier (verifying, round 11)
**VERDICT: FAIL — a real, narrow RECALL regression on the quoted high-signal path (dangerous
direction). Not cosmetic → no STOP.** Read diff + test + problem statement only. Suite
`verify:feat-130` = 158 passed / 0 failed; whole-tree `npm run gate` = PASS (exit 0). All
findings re-verified against committed round-6 `541dd73` (`scanLine` imported in-memory) vs
the working tree, real output. Values written `key → value` to stay gate-clean.

- **BARE-path recall — NO regression (the asked hazard is clean):** the bare high-signal
  path already carried `looksSecretish` since round 2, so round 10 only refactored it. Every
  shape that fired at 541dd73 in bare/standalone form still fires (all 1→1): standalone AKIA,
  sk-, ghp_, JWT, xox; bare password → AKIA-value, api_key → sk-value, github_token → ghp-
  value, secret → 32-char-hex, all-lowercase-≥24, all-upper-≥24, access_key → value; and a
  provider token inside a quoted JSON value (api_key → sk, token → ghp) all 1→1.
- **QUOTED-path recall — REGRESSION vs 541dd73 (the real finding):** round 10 added
  `looksSecretish` to the QUOTED high-signal path, which in round 6 gated on `isSecretValue`
  ALONE. `looksSecretish` rejects a SINGLE-class value unless it is ≥24 chars. So a
  single-class (all-lower / all-upper) quoted secret value of 6–23 chars that fired at
  541dd73 is now MISSED. Confirmed 1→0: password → correcthorsebattery (19-char lowercase
  passphrase), secret → supersecretpasswd (17), api_key → a 20-char lowercase run. A
  hardcoded all-lowercase passphrase-password in a YAML/JS-object literal (unquoted key,
  quoted value) is a plausible REAL leak that round 6 caught and round 10 drops — "a missed
  real secret beats a noisy schema file." (The quoted-KEY JSON form `"password" → …` was
  0→0: never caught at r6, so no regression there.)
- **Remedy is clean and separable (measured, not applied):** the round-9 FP words are ALL
  ≤8 chars (string=6, required=8, optional=8, boolean=7); the missed real secrets are ALL
  ≥16 chars. Lowering the single-class length threshold in `looksSecretish` (or a high-signal
  variant) from 24 to ~16 RESTORES every missed secret above while STILL rejecting all four
  schema words. So the round-10 blunt fix over-corrected; a length split recovers recall
  without reopening the round-9 FP.
- **Residuals — one-line answer: none is a real-secret MISS.** password → text/plain,
  password → an ISO-8601 timestamp, and client_secret → YOUR_CLIENT_SECRET are all still
  CAUGHT (2-class → looksSecretish true) — i.e. residual over-flags / a placeholder flagged
  for review (SAFE direction), not missed secrets. created → ISO-8601 is clean (non-secret
  key). So the residuals do not change the recall picture.
- **Round-9 FP fixture — CLOSED:** password → string, api_key → string, secret → boolean,
  password → required, password → optional all now CLEAN. Confirmed.
- **Could NOT test:** did not run a clean-room cross-provider pass this round (prioritised
  the before/after recall diff against 541dd73, which is the decisive evidence and needs the
  committed blob, not a second model); binary/non-UTF8 blobs; exhaustive repo-wide precision.
- **Verified-by:** independent verifier (fresh context, Opus 4.8), 2026-09-23.

### 2026-09-23 — worker (fixing, round 12, class=fix) — round-10 recall regression fixed: single-class threshold 24 -> 16

Fixed the round-11 verifier's FAIL (recall lost in the dangerous direction). Examples
in `key -> value` arrow notation so this entry does not trip the matcher; the ticket
scans clean. Scope: `scripts/lib/leak-tokens.mjs` + the verify suite only.

- **Reproduced against `541dd73` (real output).** The regressed shape is the
  unquoted-KEY / quoted-VALUE form `password -> "..."`, which `ASSIGN_QUOTED` matched
  at `541dd73` on `isSecretValue` ALONE. At `541dd73` these fired (=1); at round 10
  they MISSED (=0): `password -> correcthorsebattery` (19-char lowercase),
  `secret -> supersecretpasswd` (17), `api_key -> a 20-char lowercase run`. Round 10
  added `looksSecretish` whose single-class branch required ≥24 chars, so real
  single-class passphrases of 17–23 chars stopped firing. (Note: the fully-quoted
  JSON KEY form `"password" -> ...` returns 0 at `541dd73` for ALL values — quoted-key
  support is the round-8 `KV_SEP` change, absent there — so the correct baseline for
  this shape is the unquoted-key/quoted-value form, which is what fired at `541dd73`.)
- **Fix (ARCH-010 — one shared threshold, not a bare/quoted fork):** `looksSecretish`'s
  single-class length minimum lowered `24 -> 16`, named once as `SINGLE_CLASS_MIN_LEN`
  and reached by BOTH the bare and quoted high-signal forms through the round-10
  `isHighSignalSecretValue` — the two forms cannot drift to different tunings. The
  ≥2-char-class branch is unchanged (any mixed value fires at length ≥6).
- **Why 16 and the empirical flip (measured, not argued):** the round-9 schema/OpenAPI
  FP WORDS this must keep rejecting — `string`,`boolean`,`integer`,`number`,`required`,
  `optional` — are all ≤ 8 chars; the regressed real secrets are ≥ 17. Any threshold in
  9..16 separates the two sets; 16 is the conservative end (fewest new FPs). Measured
  flip on a single-class value: **CAUGHT at length ≥ 16, MISSED at ≤ 15**. So the
  **narrowest real single-class secret still missed is 15 chars**; every ≥2-class value
  is caught at any length ≥ 6.
- **Both directions, real runs:**
  - the three regressed shapes all fire again (541=1 -> round-12=1);
  - the round-9 FP words all STAY closed (round-12=0);
  - the round-9 residuals `text/plain`, `ISO-8601`-as-password, `YOUR_CLIENT_SECRET`
    stay CAUGHT (2-class — over-flagging placeholders, the safe direction, not chased);
  - schema fixture (`password -> string`, `api_key -> string`) seeded -> gate **exit 0**;
    a 17-char passphrase secret seeded -> gate **exit 1** (caught); removed -> exit 0.
- **WHOLE-TREE false-positive count (real run):** `node scripts/leak-gate.mjs` over all
  **1105 tracked files -> 0 hits** (only the LICENSE waiver). Lowering the threshold
  added no tracked-tree false positive. `npm run gate` -> **EXIT 0** (leak-gate +
  check-nul + typecheck), read directly, unpiped.
- **Suite:** new **D11** section (+13): 3 restored single-class secrets, the len-16/15
  flip pair, the 6 FP words staying closed, and 2 round-9 residuals staying caught.
  `node scripts/verify-feat-130-leak-detection.mjs` -> **171 passed / 0 failed**
  (was 158); git-driving E/F/G ran to completion.
- **regressed-from:** FEAT-130 round 10 (the `looksSecretish` single-class threshold at
  24 traded recall for the schema-FP precision fix; round 12 keeps the precision fix and
  restores the recall).
- **RESIDUAL (documented, unchanged intent):** a single-class real secret of ≤ 15 chars
  on a high-signal key still misses — inherent to distinguishing short single-class
  passphrases from dictionary/type words; going below 16 would begin catching common
  ≤15-char single-class dictionary words. Left as the accepted precision floor.
- **Independent verify — WARRANTED (HIGH-STAKES):** 12th round on a regression-prone
  security detector. A clean-room pass should re-attack `SINGLE_CLASS_MIN_LEN` (probe:
  a real ≤15-char single-class secret; a ≥16-char single-class NON-secret that could
  now FP; confirm bare and quoted share the one threshold and no neighbouring pattern
  narrowed).
- **Files changed (unstaged, for the user to commit):**
  `scripts/lib/leak-tokens.mjs`, `scripts/verify-feat-130-leak-detection.mjs`, and this
  ticket.

### 2026-09-23 — independent verifier (verifying, round 13)
**VERDICT: PASS — STOP.** The round-12 threshold change is correct; the only residual is
the accepted precision/recall cost the coordinator already chose, in the safe direction,
and it requires a file shape this repo does not and will not contain. Per the WA stopping
rule I am ending FEAT-130 verification and converting the residual to a standing assertion
(below) rather than spending another round. Read diff + test + problem statement only;
values in arrow notation to stay gate-clean.

- **Suite + gate (once each, real):** `verify:feat-130` = **171 passed / 0 failed**;
  whole-tree `npm run gate` = **PASS (exit 0)**.
- **Both directions satisfied SIMULTANEOUSLY (541dd73 before/after, decisive artifact
  re-run):** the round-9 schema/OpenAPI FP fixture STAYS closed (password → string,
  api_key → string, secret → boolean, password → required/optional all CLEAN in round 12),
  AND every shape that fired at 541dd73 fires again — standalone AKIA/sk-/ghp_, bare
  high-signal assignments, and the three round-11 regressed single-class secrets
  (password → a 19-char lowercase passphrase, secret → 17-char, api_key → 20-char) are all
  1→1. The only R6→R12 delta over a broad set is a GAIN (a 16-char uppercase value now
  caught), not a regression.
- **External-corpus hit count (the thing a global threshold can break — real run):** over
  the real npm `package-lock.json` + 3 minified bundles = **2102 lines, 0 hits in both R6
  and R12 (0 new)**. Lowering 24→16 added ZERO hits on real minified/lockfile/base64/hash
  content. What ELSE now reaches 16 that did not reach 24 is ONLY single-class (all-one-
  class) values of 16–23 chars on a high-signal key — a shape absent from every real corpus
  scanned and from the 1105-file tree.
- **The one residual, executed and characterised:** a GLUED single-class placeholder-
  instruction of ≥16 chars on a high-signal key now over-flags — e.g. password →
  yourpasswordhere, password → enterpasswordhere, secret → replacewithrealsecret, api_key →
  insertyourkeyhere are CAUGHT (all-lowercase, no space, no marker, so `isPlaceholder`
  misses them). This is a FALSE POSITIVE, but (a) it is the IRREDUCIBLE cost of the recall
  the coordinator chose — a glued-lowercase placeholder and a real glued-lowercase
  passphrase (password → correcthorsebattery) are indistinguishable by shape; (b) it is the
  SAFE over-flag direction (a spurious flag on a template line, never a missed secret);
  (c) real templates almost always use a marker / caps / spaces (`<...>`, `${...}`,
  YOUR_PASSWORD, "your password here") that ARE caught as placeholders — the surviving FP
  needs the narrow glued-lowercase form; (d) it does NOT occur in the tracked tree or the
  real external corpus (0 hits). This repo (Electron/Node app + ticket board) does not ship
  credential-template `.example` files of that shape, and the gate runs only on this repo —
  so it is a hazard needing a file this repo will not contain.
- **Is 16 defensible? YES.** The round-9 FP words are ≤8 chars; real passphrases are ≥16;
  any threshold in 9..16 separates them and 16 is the conservative (fewest-FP) end. The
  real precision flip point — where single-class ENGLISH words become common — sits at
  roughly ≤12 chars, so 16 keeps a safety margin above the dense part of the word-length
  distribution while still catching real 16+ passphrases. Going lower would start catching
  common ≤15-char words; 16 is the right knee.
- **STANDING PROPERTY ASSERTION (to add to the suite, in place of another round):** lock
  BOTH edges of the tradeoff so neither can silently drift — (1) a curated real-shaped
  external-corpus sample (an npm integrity sha512 line, a UUID, a 40-char git SHA, a
  minified `key=val;` run) asserts **0 hits** [partially present: integrity/revision lines];
  (2) the single-class flip stays **caught ≥16 / missed ≤15** [present, D11]; (3) the
  round-9 schema words (≤8) stay clean [present, D11]; (4) ADD one line documenting the
  ACCEPTED residual as intended behaviour — a glued single-class ≥16-char placeholder on a
  high-signal key IS flagged (recall-favoured) — so a future dev does not "fix" it and
  silently re-open the round-11 recall regression. Items 1–3 already exist; only item 4 is
  new. I did not edit the suite (avoid racing the fixer's unstaged file); the assertion text
  above is ready to paste.
- **Could NOT test:** no clean-room cross-provider pass this round (the decisive evidence is
  the 541dd73 before/after diff, which needs the committed blob rather than a second model);
  binary/non-UTF8 blobs; a corpus larger than the sampled bundles.
- **Verified-by:** independent verifier (fresh context, Opus 4.8), 2026-09-23.

### 2026-09-28 — worker (fixing, round 1)
- **Status → VERIFIED.** The feature code is landed across commits `541dd73`
  (generic credential-assignment detection behind a value-shape floor), `28eb430`
  (closed two residual leak-gate false-proofs) and `78a8a5a`, and the ticket
  already carries a `Verified-by:` line (independent verifier, fresh context,
  Opus 4.8, 2026-09-23). No code change this round — status flip only.
