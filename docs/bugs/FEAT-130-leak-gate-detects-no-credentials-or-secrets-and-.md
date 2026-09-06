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
