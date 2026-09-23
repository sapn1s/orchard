# BUG-176 — File-lock hook refuses read-only Bash commands purely for a `/dev/null` redirect

- **Status:** FIXED (fixer-verified 15/15 + FEAT-129 75/75 regression) — awaiting independent clean-room verify
- **Severity:** medium
- **Area:** server / runtime — FEAT-129 advisory file-lock classifier (`scripts/lib/file-lock.mjs`)
- **Reported:** 2026-09-08 by two independent investigation lanes (measured twice)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom
FEAT-129's advisory file-lock hook refuses **read-only** Bash commands purely because
they contain a redirect to `/dev/null`. Confirmed refusals included plain `ls` and
`head` invocations whose only sin was `2>/dev/null`; the hook claimed the redirect
would drop another lane's uncommitted work. (Reproduced live again during this fix:
the deployed hook refused a `grep … 2>/dev/null` issued by the fixing lane itself,
because `/dev/null` happened to be "held" by another lane.)

## Repro
```
scanBashMutation('ls 2>/dev/null')
  → { mutates:true, paths:['/dev/null'], kind:'redirect' }   ← WRONG (pre-fix)
```
`/dev/null` is captured as a truncating-redirect target and locked; a concurrent lane
that also redirected to `/dev/null` then gets a BUSY refusal on a read-only command.

## Expected
A redirect whose target is `/dev/null` (or another std stream / character device)
destroys nobody's work and must **never** be locked. Redirects to REGULAR files must
keep being checked exactly as before.

## Why it is worth fixing (not tolerating)
`2>/dev/null` is idiomatic on nearly every exploratory shell command, so the hook
injected refusal ping-pong into read-only work — the model retries a different
phrasing, burning full-context round-trips (~13.5–16.6 s each measured) on the most
common command shape there is, and it trains lanes to avoid a redirect that protects
output cleanliness.

## Root cause
`scanBashMutation` (`scripts/lib/file-lock.mjs`) surfaces every truncating redirect
(`>`, `>|`, `N>`, `&>`) as a `__TRUNC__` marker and pushes its target token onto the
mutated-paths list **without any device / regular-file test** (old line 454:
`for (const t of redirTargets(rawTokens)) if (t) { push(t); … }`). So `/dev/null` — a
bit bucket — was treated identically to a regular file. Confirmed the hypothesis in
the charter exactly: one target-classification gap in one place.

`2>&1` (an fd dup, not a file) was already correctly a non-mutation — the tokenizer
splits at `&` and the `__TRUNC__` from `2>` has no following target token, so nothing
was captured. No change needed there; covered by a regression assertion.

## Fix
Added a PURE (no-fs) predicate `isDiscardRedirTarget(target)` and gated line 454 on it.
It excludes the standard std-stream / character-device nodes by EXACT normalized path
(`/dev/null`, `/dev/zero`, `/dev/full`, `/dev/random`, `/dev/urandom`, `/dev/stdout`,
`/dev/stderr`, `/dev/stdin`, `/dev/tty`, `/dev/console`, plus `/dev/fd/N` and
`/proc/{self,PID}/fd/N` dups). Match is exact-path (via `path.posix.normalize`), never
substring — so a REGULAR file whose path merely contains the text `/dev/null` (e.g.
`./tmp/dev/null-notes.txt`) stays locked. Kept pure to preserve the classifier's
no-fs invariant (documented at the top of the module); a redirect to a bespoke char
device a lane hand-created is not a real contention shape and is out of scope.

## Context pack
- Files/functions in play: `scripts/lib/file-lock.mjs` — `scanBashMutation` (redirect
  target collection at the `redirTargets(rawTokens)` loop), new `isDiscardRedirTarget`
  + `DISCARD_REDIR_TARGETS`.
- Related tickets: FEAT-129 (the lock itself — this narrows its classifier, does NOT
  weaken the protection); FEAT-108 (git-write block, layered before this).
- Repro test: `node scripts/verify-bug-176-devnull-redirect.mjs` (15/15).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-08 — fixing lane (dispatched, class=fix)
- **Understood:** The redirect-target collector in `scanBashMutation` locked EVERY
  truncating-redirect target, including `/dev/null`, so read-only commands carrying
  `2>/dev/null` were classified as mutations and refused BUSY. Root cause matched the
  charter's hypothesis exactly: one missing target-classification test in one place.
  Verified the deployed hook still bites (it refused this lane's own `grep … 2>/dev/null`
  mid-fix — live instance of the bug).
- **Changed:** `scripts/lib/file-lock.mjs` (+28/-1): new `DISCARD_REDIR_TARGETS` set +
  `isDiscardRedirTarget()` pure predicate; gated the redirect-target push on it.
  `scripts/verify-bug-176-devnull-redirect.mjs` (NEW, 15 graded checks). Left UNSTAGED
  (no git writes by lanes).
- **Verified (fixer's own run):**
  - must-FAIL→PASS: pre-fix `scanBashMutation('ls 2>/dev/null')` → `{mutates:true,
    paths:['/dev/null']}`; post-fix → `{mutates:false}`. `ls`/`head`/`grep` + `2>/dev/null`
    all ALLOWED via the real `evaluateFileLock` on a scratch lock dir.
  - NON-REGRESSION (matters most): a truncating redirect to a REAL file a live foreign
    lane holds (`node gen.mjs > src/shared.ts`) is STILL REFUSED (busy, names holder) —
    and stays refused when `2>/dev/null` is appended. Protection intact.
  - Adversarial: `> /dev/null`, `2>/dev/null`, `&>/dev/null`, `2>&1`,
    `1>/dev/stdout 2>/dev/stderr`, `/dev//null` all non-mutations; `./tmp/dev/null-notes.txt`
    and `/dev/null-notes.txt` (regular files, substring only) STILL locked;
    `node gen.mjs > real.txt 2>/dev/null` still captures `real.txt` while dropping
    `/dev/null`. `node scripts/verify-bug-176-devnull-redirect.mjs` → 15/15, exit 0.
  - Anti-regression: `node scripts/verify-feat-129-file-lock.mjs` → **75/75**, exit 0
    (run with the real `git` on PATH; the worker's git-shim otherwise blocks the suite's
    scratch `git init` — unrelated to this change).
  - Gate: `npm run gate` → leak-gate PASS, check-nul PASS, **typecheck FAIL** — but every
    error is in `src/server/dispatch-broker.ts`, a file a CONCURRENT lane is editing
    (already `M` before this dispatch; named in the charter). This change touches only
    `.mjs` files, which `tsc --noEmit` does not compile, so it cannot introduce a `.ts`
    error.
- **Could not test:** a true two-OS-process live interleave through the SHIPPED runtime
  hook (verified module-direct + via `evaluateFileLock` on a scratch dir; the runtime's
  already-loaded hook runs the OLD code until the server restarts — out of a lane's
  scope). Cross-mode container↔host key sharing (FEAT-129's documented residual, unchanged).
- **Still open / handoff:** independent clean-room verify warranted (data-loss-adjacent
  file it lives in, though this change only NARROWS the classifier). Attack the boundary:
  a regular file named exactly like a device node under a subdir; a redirect target built
  by variable expansion; `>| /dev/null`.
- **Symptom of a deeper design flaw?** no — a localized classifier omission (redirect
  targets were never device-tested), fixed in one predicate; the lock's model is sound.
