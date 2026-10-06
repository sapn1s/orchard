# BUG-199 — an agent can commit a leak in one command by force-adding an ignored file (pre-run guard skips it)

- **Status:** OPEN — filed 2026-09-29 by the FEAT-156 round-2 clean-room verify lane; NOT yet triaged/fixed
- **Severity:** med (a leak-gate bypass on the AGENT commit path, but only for a file the repo already gitignores, and both commit-time staged scans still catch it — see below)
- **Area:** leak-gate / agent git-write guard (`src/server/runtime/claude-runtime.ts` `runLeakGateForRepo`; `scripts/leak-gate.mjs` working-tree enumeration)
- **Reported:** 2026-09-29 (surfaced by the FEAT-156 round-2 fixer as a handoff; independently reproduced by this lane)
- **Related:** FEAT-156 (see_also — same guard, different hole; this is NOT introduced by FEAT-156), FEAT-104 / FEAT-130 (the token/credential classes a leaked commit would carry)

## Symptom
An Orchard agent session can land a leaking commit in a single Bash command of the shape:

```
git add -f <ignored-file> && git commit -m "…"
```

where `<ignored-file>` is matched by `.gitignore` (or `.git/info/exclude`) and its content carries a
private token (a foreign project name, a home path, a credential). The agent git-write PreToolUse
guard (`runLeakGateForRepo`) that is supposed to refuse a leaking commit returns `ok=true`, so the
combined command runs and the ignored file is force-added and committed.

## Why the guard misses it
`runLeakGateForRepo` runs the gate in two passes before the intercepted command executes:

1. **Working-tree pass (`--summary`).** The gate enumerates files with
   `git ls-files -z -co --exclude-standard` (`scripts/leak-gate.mjs`). `--exclude-standard` honours
   `.gitignore` / `.git/info/exclude`, so an ignored file is **never enumerated** and its content is
   never scanned — even though it exists on disk with a leak in it.
2. **Staged pass (`--staged`).** Scans the git index. But the guard runs BEFORE the intercepted
   `git add -f … && git commit` executes, so at guard time **nothing is staged yet** — the `--staged`
   pass sees an empty/clean index and passes.

Both passes pass ⇒ `ok=true` ⇒ the command runs ⇒ `git add -f` overrides the ignore and the commit
captures the leak. This is the same CLASS of pre-run/commit-time gap as the FEAT-156 round-1 break
(the working-tree pre-run trusting an unreviewed input), but via the *ignored-file enumeration*, not
the allowlist, so the FEAT-156 round-2 fix (read the allowlist only from the git index) does not
close it.

## What DOES catch it (blast radius)
- **Dashboard commit path** (`src/server/git.ts`): the user/agent stages first, then the gate runs
  `--staged` over the real index at commit time → the force-added file's blob is scanned → refused.
- **A real pre-commit hook** running the gate `--staged`: the file is staged at hook time → caught.

So the exposure is specifically the AGENT pre-exec guard on a **single combined** `add -f … && commit`
command. A two-step agent flow (`git add -f f` as its own command, then `git commit`) is also caught,
because the second command's guard runs with the file already staged.

## Reproduction (confirmed by this lane, 2026-09-29)
Direct gate-level repro of the enumeration gap (the root cause), against the current tree's
`scripts/leak-gate.mjs`, in a throwaway git repo with `core.hooksPath=/dev/null`:

- `.gitignore` lists `secret.txt`; `secret.txt` contains a private project-name token (needle derived
  from `scripts/lib/leak-tokens.mjs` at runtime, so no private value is written here).
- Working-tree pass: `node scripts/leak-gate.mjs --summary` → **exit 0** ("PASS — 0 hits across 1
  files"): the ignored file with the leak is not scanned.
- After `git add -f secret.txt`: `node scripts/leak-gate.mjs --staged` → **exit 1**: the commit-time
  staged scan does catch it.

This proves the working-tree pre-run's blind spot and that the staged scan is the backstop.
(A full `runLeakGateForRepo` end-to-end repro with a scratch registry was not run by this lane; the
gate-level repro isolates the exact cause, and the guard's working-tree pass is that same enumeration.)

## Suggested direction (for the fixer, not decided here)
Make the agent pre-exec guard not trust the working-tree enumeration for commit intent:
either scan ignored-but-force-addable files too when the intercepted command force-adds, or model the
intended index (dry-run the `git add` the command will do) before scanning, or gate on the command's
own `add -f` targets. Do NOT weaken the requirement that the dashboard/hook `--staged` scans remain
the authoritative commit-time backstop.

## Symptom of a deeper design flaw?
Possibly — this is the second instance of the agent PRE-EXEC guard scanning a state that is not the
state the intercepted command will produce (FEAT-156 round-1 was the first). If a third appears, an
ARCH ticket on "the git-write pre-run must model the command's resulting index, not the current
working tree" is warranted. Left as a one-line hand-forward for now.

## Activity log (APPEND-ONLY)

### 2026-09-29 — filed by FEAT-156 round-2 clean-room verify lane
- Filed per the FEAT-156 round-2 verify charter, which called out this pre-existing gap (reported by
  the round-2 fixer) and asked for a quick repro before filing. Reproduced the enumeration gap at the
  gate level (working-tree `--summary` exit 0 with a leak in an ignored file; `--staged` exit 1 after
  force-add). Not introduced by FEAT-156; cross-referenced there. Did not attempt a fix (out of scope
  for a verify lane). INDEX row added via `board:gen`.
