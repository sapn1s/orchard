```orchard-ticket
{
  "id": "BUG-277",
  "type": "bug",
  "title": "index-only staging is classified whole-tree, so any live lock blocks landing",
  "summary": "`git apply --cached` is index-only but file-lock.mjs (FEAT-129) classifies every `git apply` as a whole-tree mutation, so any live lock — even one on an out-of-repo scratch file — refuses the sanctioned index-only apply and blocks landing.",
  "impact_if_we_wait": "Every landing via the sanctioned `git apply --cached` is blocked whenever any concurrent lane holds any live lock; landers must wait on unrelated lanes or race heartbeat gaps. Observed live 2026-10-25: BUG-240 could not be staged/committed at all while an unrelated FEAT-191 IV lane held scratch-file locks.",
  "current_need": "Decide option 1 (index-only exemption) vs option 2 (derive touched paths from the patch) and implement. Low-risk guard change but it touches the shared-tree safety path, so verify a working-tree-writing `git apply` (no --cached) still classifies tree-wide.",
  "severity": "medium",
  "area": "file-lock guard (FEAT-129), scripts/lib/file-lock.mjs",
  "reported": "2026-10-25",
  "reported_by": "dispatch lane (BUG-273/BUG-240 landing, round 6)",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-27",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "the sanctioned index-only staging of repo patches succeeds while an unrelated live lane holds a lock on a non-overlapping path (including an out-of-repo scratch file)",
    "a working-tree-writing apply WITHOUT --cached still classifies whole-tree and is refused against a conflicting live lock",
    "the FEAT-129 file-lock regression suite still passes"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a173bb-8dd0-73e1-aecc-b30036699881",
      "verdict": "broken",
      "verdict_on": "2026-10-25",
      "recorded_at": "2026-10-25T19:33:10.647Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "3abffb706d113189195093457e3fc640feab0d4939e8d2c58f16c1c89bf6202e",
      "verify_mode": "mixed-state",
      "note": "Exempted forms write the working tree: --cached --reject (writes .rej), --cached --build-fake-ancestor=<f> (overwrites <f>), --cached --no-cached (writes tree). All classify mutates:false, so a foreign lock is bypassed. Narrow exemption."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "f02aa74c-d559-4080-9c2f-5e69d4c4e145",
      "verdict": "broken",
      "verdict_on": "2026-10-26",
      "recorded_at": "2026-10-26T18:10:16.214Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "IV range 31d2fca^..31d2fca: exemption under-refuses — shell-expansion forms ($(echo --reject), {--reject,p.diff}) and env-prefix forms (env GIT_DIR=.. git apply --cached, export GIT_WORK_TREE=..;) classified index-only and ALLOWED under a foreign lock; manifest-backed adv-e2e."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "7fe2cf90-da81-4128-8969-3d28d4a50821",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T11:47:56.900Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "IV 31d2fca^..c8fb8a7 (r2+r3), VALID, exit 1. r3 regex refuses all shell/wrapper/metachar forms; but upstream gitMutationTarget reads post-double-dash tokens as written paths when for git-apply they are patch files. So 'apply -- p' & '--cached -- p' write the tree yet are ALLOWED over a lock."
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

# BUG-277 — index-only staging is classified whole-tree, so any live lock blocks landing

## Symptom
`git apply --cached <patch>` writes only the INDEX, never the working tree, so it cannot clobber any concurrent lane's unsaved edits. But `scripts/lib/file-lock.mjs` classifies EVERY `git apply` as a whole-tree mutation: `apply` is in `GIT_TREE_MUTATORS`, and `gitMutationTarget('apply', …)` returns `{ tree: true }` because there is no `--` pathspec. `decideFileLock` then runs `checkTree`, which refuses if ANY fresh foreign lock exists anywhere in the project lock dir — even a lock on an out-of-repo scratch file. Result: landing a verified ticket via the sanctioned `git apply --cached` is blocked whenever any other lane holds any live lock.

## Reproduction (live, 2026-10-25, during the BUG-273/BUG-240 landing)
A live FEAT-191 independent-verify lane held fresh locks on out-of-repo scratch files under `~/.local/state/claude-station/scratch/feat191-iv-r8/` (files.csv, iv.log, requirement.md). `git apply --cached` of BUG-240's three REPO patches (scripts/lib/git-write-policy.mjs, the BUG-240 ticket, scripts/verify-feat-108-git-write-block.mjs) — which touch none of those scratch paths — was refused with the exact text:

> File-busy lock: this git apply operation would overwrite the working tree, but `cs-mvnyiwin-g:a10364afde7a7ccde` holds an uncommitted lock on a file in it (held 31s ago). Do not force it. Coordinate: wait for that lane to finish this file, edit a DIFFERENT file, or (if it is your own stale work) retry after the lock TTL. A crashed lane's lock auto-releases.

BUG-273's four patches landed only because they slipped through a gap between the live lane's heartbeats; note that `git commit` itself is NOT tree-classified, which is why the follow-on commit succeeded while the apply kept failing.

## Why it is wrong
The refusal says the op "would overwrite the working tree" — but `--cached`/`--index`-only applies never touch the working tree, so the guard's premise (clobbering a concurrent lane's unsaved working-tree edits) does not hold. It is a false positive that taxes every landing whenever any lane anywhere holds any live lock.

## Fix spec (do NOT fix in this ticket)
Either is sufficient:
1. INDEX-ONLY exemption: treat `git apply --cached` (or `--index` without a working-tree write) as index-only — it cannot clobber the working tree, so do not check it against working-tree locks (allow). A working-tree-writing `git apply` WITHOUT `--cached` stays tree-classified.
2. DERIVE PATHS: parse the patch's `+++ b/<path>` headers and key the lock check to exactly those paths (scoped), instead of failing to whole-tree.

## Pointers
- scripts/lib/file-lock.mjs: `GIT_TREE_MUTATORS` (includes `apply`); `gitMutationTarget` (returns `{tree:true}` for apply, no `--`); `scanBashMutation` git branch (~line 746); `checkTree` / `decideFileLock`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-25 — dispatch lane (BUG-273/BUG-240 landing, round 6)
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-25 — fixing lane (round 1)
- **Decision:** Option 1 (index-only exemption), NOT option 2 (derive paths from the patch). Reason: `classifyMutation`/`scanBashMutation`/`gitMutationTarget` are a PURE, no-fs classifier by design (module header invariant); option 2 would have to read the patch file off disk to parse its `+++ b/<path>` headers, breaking that invariant. Option 1 is a purely syntactic flag check — no fs, no new failure mode.
- **Chokepoint confirmed:** `gitMutationTarget` is the ONE place git classification happens — `GIT_TREE_MUTATORS` is referenced only by the single `head === 'git'` branch in `scanBashMutation` (line ~769), which calls `gitMutationTarget` and nothing else classifies `apply`. Hypothesis held.
- **Fix:** `gitMutationTarget('apply', args)` now returns `{ indexOnly: true }` when `--cached` is present AND `--index` is absent (only options BEFORE `--` are inspected, so a patch path literally named `--cached` after `--` is not the flag). The git branch treats `indexOnly` as "not a mutation" (`continue`), so the lock never fires. Everything that writes the working tree stays TREE-classified: `--index` (writes tree + index), plain `--3way`/`--reject` without `--cached`, plain `apply`, and `git am` (separate subcommand, no exemption). Rationale per git-apply(1): `--cached` = "apply the patch to just the index, without touching the working tree"; `--3way --cached` leaves conflicts in the cache, not the tree.
- **Verification (must-FAIL synthesized from pre-fix code, run both ways):** pre-fix probe showed EVERY `--cached` form classified `{tree:true}` (the jam). Post-fix, 15-case classifier attack list all correct + end-to-end decision proof. The live repro is reproduced and fixed: with a foreign lane holding a lock on an OUT-OF-REPO scratch file (`feat191-iv-r8/files.csv`), `git apply --cached scripts/git-write-policy.mjs.patch` is now ALLOWED (was REFUSED), while a working-tree-writing `git apply` (no `--cached`) is still REFUSED and names the holder. Added as section 10 of `scripts/verify-feat-129-file-lock.mjs` (18 assertions).
- **Suites:** `verify-feat-129-file-lock.mjs` → PASS 163/163 (run under the confined runner, since it writes scratch git repos — `needsGit`). `npm run gate` → PASS (exit 0): leak-gate + typecheck clean.
- **Files (unstaged):** `scripts/lib/file-lock.mjs`, `scripts/verify-feat-129-file-lock.mjs`, this ticket.
- **Risk bucket:** touches the shared-tree safety path (regression-prone) — an independent clean-room verify pass is warranted before close. The change only ever NARROWS classification for one exact flag shape; every working-tree-writing form, `git am`, and the literal-text-in-a-non-git-command cases were proven unchanged.

### 2026-10-25 — dispatch openai
- **Verification recorded:** dispatch openai run 01a173bb-8dd0-73e1-aecc-b30036699881 — VERDICT: BROKEN — mixed-state candidate 3abffb706d11 — Exempted forms write the working tree: --cached --reject (writes .rej), --cached --build-fake-ancestor=<f> (overwrites <f>), --cached --no-cached (writes tree). All classify mutates:false, so a foreign lock is bypassed. Narrow exemption.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-25 — fixing lane (round 2)
- **regressed-from:** BUG-277 r1 (same ticket). r1's index-only exemption was a DENYLIST over git-apply's options (`--cached` present AND `--index` absent). openai run 01a173bb-8dd0-73e1-aecc-b30036699881 returned BROKEN (two-break): every OTHER apply form that merely carries `--cached` was exempted while it WRITES the working tree — `--cached --reject` (.rej), `--cached --build-fake-ancestor=<f>` (<f>), `--cached --no-cached` (cancels --cached), and `-C`/`--git-dir`/`--work-tree`/`-c`/`GIT_*`-prefix contexts.
- **Decision (orchestrator, two-break disposition):** RESCOPE to an ALLOWLIST of exactly ONE shape — `git apply --cached <path>...` (optionally `-- <path>...`), the only form landing uses to stage repo patches. Every other apply form stays tree-classified, as before r1. Over-refusing a rare form fails safe (the tree check denies only when a lock is actually held); under-refusing is the defect.
- **Landing-shape hypothesis — CONFIRMED FIRST.** The r1 Activity log, this ticket's live repro, and the real patch files under the landing scratch (`bug240-git-write-policy.patch`, `bug240-ticket.patch`, `bug240-verify-feat-108.patch` — all plain paths) show landing stages each repo patch with the bare form `git apply --cached <patch-file>` (quoted live as `git apply --cached scripts/git-write-policy.mjs.patch`). No `-c`/`-C`/`--git-dir`/`--work-tree`/alias and no `GIT_*` env prefix. The allowlist exempts exactly this; no extra flag is needed.
- **Fix (scripts/lib/file-lock.mjs):**
  - `gitMutationTarget('apply', args)` now returns `{ indexOnly: true }` ONLY when `--cached` is present AND the ONLY option before `--` is `--cached` (every other option, incl. `--index`, `--cached=…`, `--cache`, `--reject`, `--build-fake-ancestor=…`, `--no-cached`, `--3way`, short-flag clusters → disqualify); `--` is allowed if followed only by plain paths; `--cached` after `--` is a patch FILENAME, not the flag.
  - `gitSubcommand` now returns `hadGlobal` (any git global option consumed before the subcommand); `headOf` now returns leading `assigns` (the command's env prefix). New helper `hasGitEnvPrefix` flags a `GIT_*=` prefix.
  - At the single git call site in `scanBashMutation`, the exemption is honoured ONLY when `!parsed.hadGlobal && !hasGitEnvPrefix(h.assigns)`; otherwise it falls back to TREE. These two contexts can redirect the apply off the plain repo index, so over-refusing them fails safe.
- **Verification (must-FAIL synthesized from r1 code, run both ways):** a pre-fix probe confirmed r1 EXEMPTED all six break classes; post-fix all classify TREE. Full r2 attack list (every r1 break; `--cache`/`--cached=…` abbreviations; short-flag cluster; `-c alias.x=apply x --cached`; `GIT_WORK_TREE=/x`; a dash-leading patch path; `apply --cached p && rm x` plus `… && git checkout -- other.txt` second-command independence; literal text inside echo/grep; the exact landing shape) — all correct. Rewrote section 10 of `scripts/verify-feat-129-file-lock.mjs` (r1's two now-wrong asserts flipped to TREE, plus the full attack list and the out-of-repo-scratch-lock end-to-end: landing shape ALLOWED, working-tree apply REFUSED).
- **Suites:** `verify-feat-129-file-lock.mjs` → PASS 180/180 (run under `npm run confined --no-git`, since it writes scratch git repos — the session git shim blocks a scratch `git init` otherwise). `npm run gate` → PASS (exit 0): leak-gate + typecheck clean.
- **Files (unstaged):** `scripts/lib/file-lock.mjs`, `scripts/verify-feat-129-file-lock.mjs`, this ticket.
- **Risk bucket:** touches the shared-tree safety path (regression-prone) — an independent clean-room verify pass is warranted before close. The change only ever NARROWS the exemption relative to r1 (an allowlist strictly inside r1's denylist); every working-tree-writing form, `git am`, global-option/`GIT_*` contexts, and literal-text-in-a-non-git-command cases were proven TREE or not-a-mutation.

### 2026-10-26 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run f02aa74c-d559-4080-9c2f-5e69d4c4e145 — VERDICT: BROKEN — IV range 31d2fca^..31d2fca: exemption under-refuses — shell-expansion forms ($(echo --reject), {--reject,p.diff}) and env-prefix forms (env GIT_DIR=.. git apply --cached, export GIT_WORK_TREE=..;) classified index-only and ALLOWED under a foreign lock; manifest-backed adv-e2e.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-26 — fixing lane (round 3)
- **regressed-from:** BUG-277 r1 and r2 (same ticket). Both tried to RECOGNISE the index-only form by PARSING the command (r1 a denylist over git-apply flags; r2 a token allowlist + a GIT_* / global-option guard). Both were refuted because the classifier cannot model what the SHELL does before git runs: r2 (run f02aa74c…) was BROKEN by shell-expansion forms (`$(echo --reject)`, `{--reject,p.diff}`, `$VAR`, globs `* ? [`) and env set earlier on the line (`export GIT_WORK_TREE=…;`, `env GIT_DIR=… git …`) — all tokenised to the exempt shape yet redirect/rewrite the real apply.
- **Decision (orchestrator):** STOP parsing shell. The exemption fires ONLY when the WHOLE Bash command string, trimmed, matches EXACTLY `^git apply --cached( <plain-path-token>)+$` — no leading `-` on any token, NO shell metacharacter anywhere (`$ \` ( ) { } [ ] * ? ; & | < > ' " \\ ~ ! newline tab`, or a doubled/odd space), and no second command on the line. Anything else falls back to today's tree classification. Over-refusal is acceptable; under-refusal is the defect.
- **Landing-shape hypothesis — verified FIRST (within limits).** The live repro (this ticket) and the r2 Activity log record the real landing command as the bare form `git apply --cached <patch-file>` with PLAIN paths — quoted live as `git apply --cached scripts/git-write-policy.mjs.patch`, and the real staged patch files `bug240-git-write-policy.patch` / `bug240-ticket.patch` / `bug240-verify-feat-108.patch`. No `~`, no `$VAR`, no metacharacter → the strict regex exempts exactly this (repo-relative OR tilde-already-expanded absolute paths both match). NOTE: I could NOT list the live scratch dir `~/.local/state/claude-station/scratch/landing/` (sandbox permission timed out), so this rests on the command shapes recorded in the ticket/r2 log, not a fresh directory read. **Directive to the landing lane:** a command that literally contains `~` or `$L` (unexpanded) will NOT match and will be refused — landers must pass an ABSOLUTE LITERAL path (or a repo-relative plain path). The rule was NOT widened to accommodate `~`/vars.
- **Fix (scripts/lib/file-lock.mjs):**
  - New `INDEX_ONLY_APPLY_RE = /^git apply --cached( [A-Za-z0-9._/+][A-Za-z0-9._/+@=-]*)+$/` and exported `isIndexOnlyApplyExempt(command)` = `RE.test(command.trim())`. The char classes exclude every shell metacharacter, so the single regex both pins the shape AND rejects metacharacters by construction; the first token char excludes `-` (no option-leading path). A trailing newline is stripped by trim(); an embedded newline (2nd command) fails the anchored `$`.
  - The exemption is decided ONCE, at the top of `scanBashMutation` gated on `depth === 0` (the RAW user command only — a `sh -c`/`eval`/subshell/command-substitution body gets no exemption). It returns `{ mutates:false }`.
  - REVERTED all r1/r2 shell-parsing scaffolding: the `apply` allowlist block in `gitMutationTarget` (now every `git apply` reaching the classifier is tree-classified as pre-exemption), the `indexOnly` branch in the git head of `scanBashMutation`, `hasGitEnvPrefix`, `gitSubcommand`'s `hadGlobal`, and `headOf`'s `assigns`.
- **Verification (must-FAIL synthesized from the r2 code, run r2 vs r3 side by side):** a 35-case attack probe (`/tmp/bug277probe/probe.mjs`, synthetic/throwaway) imported r2 (git `31d2fca:…`) and r3. r2 WRONGLY EXEMPTED 21 of the 32 attacks (every shell-expansion, env-prefix, quote, escape, second-command and whitespace form); r3 = 35/35 correct (the one landing form EXEMPT, all 32 attacks REFUSED). Attack list proven refused: every r1/r2/r3 break; `$(…)`, backticks, `${…}`, `{a,b}`, globs `* ? [`, `~`; single+double quotes; `\` escape; newline- and `;`-separated second command; `export X=…;`/`env X=…`/`GIT_DIR=` prefixes; `git  apply` double space; tab; a U+2011 lookalike dash. The exact absolute-path landing form is EXEMPT.
- **Suites:** rewrote section 10 of `scripts/verify-feat-129-file-lock.mjs` for the r3 contract (predicate tests + the full attack list via the REAL `classifyMutation` entry + the out-of-repo-scratch-lock end-to-end: landing shape ALLOWED, working-tree apply REFUSED and names the holder, expansion-form apply REFUSED). Full suite → PASS 196/196 under `node scripts/confined-run.mjs -- sh -c 'mkdir -p "$HOME/scratch" && node scripts/verify-feat-129-file-lock.mjs'` (confined because it writes scratch git repos; the container HOME needs its scratch dir pre-made). `npm run gate` → PASS (exit 0): leak-gate + typecheck clean (one home-path leak in an example string was neutralised to `/var/lib/station/...`).
- **Files (unstaged):** `scripts/lib/file-lock.mjs`, `scripts/lib/file-lock.d.mts` (declared the new export), `scripts/verify-feat-129-file-lock.mjs`, this ticket.
- **Risk bucket:** touches the shared-tree safety path (regression-prone) — an independent clean-room verify pass is warranted before close. r3 strictly NARROWS the exemption to one metachar-free literal shape (a subset of r2's allowlist); every other form, incl. all r2 breaks, now classifies tree/path (refused under a lock).

### 2026-10-27 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 7fe2cf90-da81-4128-8969-3d28d4a50821 — VERDICT: BROKEN — IV 31d2fca^..c8fb8a7 (r2+r3), VALID, exit 1. r3 regex refuses all shell/wrapper/metachar forms; but upstream gitMutationTarget reads post-double-dash tokens as written paths when for git-apply they are patch files. So 'apply -- p' & '--cached -- p' write the tree yet are ALLOWED over a lock.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — fixing lane (round 4)
- **regressed-from:** BUG-277 r1/r2/r3 (same ticket). r3's whole-string exemption was sound, but it left the UPSTREAM classifier untouched — and that is where anthropic run 7fe2cf90-da81-4128-8969-3d28d4a50821 (BROKEN) found two holes.
- **Hypothesis verified FIRST (probe vs the r3 code at HEAD):** the wrapper hole is PER-WRAPPER, not per-verb. A probe imported the HEAD (r3) `file-lock.mjs` and ran 13 attacks: **12/13 SLIP a foreign lock** (classify not-a-mutation OR path-scoped-to-the-patch-file). The 13th (nohup form) was already caught because `nohup` is a NOOP head. The slips span apply AND checkout/restore/reset/stash/clean — confirming the hole is the wrapper, not the verb.
- **Two defects:**
  1. `gitMutationTarget` read git-apply's tokens after the double-dash as WRITTEN pathspecs. For git-apply they are PATCH FILES to READ; the apply still writes the whole tree. So the post-double-dash apply forms keyed the lock to the patch file and were ALLOWED over a lock on any other file. (The verdict's exact break.)
  2. A git tree-mutator reached through a wrapper the tokenizer does not unwrap (exec/xargs/timeout prefixes) never reaches the `head==='git'` branch, so the segment classified as NO mutation and slipped every lock. (nohup/command/sh -c/env were already unwrapped; the rest were not.)
- **Fix (scripts/lib/file-lock.mjs — `gitMutationTarget` and its caller `scanBashMutation` only):**
  - `gitMutationTarget`: `apply` and `am` now return `{tree:true}` UNCONDITIONALLY — neither ever writes a named pathspec (their args are patch/mbox files to read), so the generic double-dash path-scoping branch must not apply to them. Fixes defect 1 via the tokenizer (incl. the `-C` form).
  - New `WRAPPED_GIT_TREE_MUTATOR_RE` + exported `hasWrappedGitTreeMutator(command)`: a plain WHOLE-STRING regex (no tokenizing — the r3 lesson) matching a standalone/path-qualified `git` token followed, after only git's own global options, by any GIT_TREE_MUTATORS verb. Wired into `scanBashMutation` at the SINGLE top-level (`depth===0`) `mutates:false` exit: if the ordinary scan found nothing but the raw string carries a wrapped git mutator, return whole-tree. Fixes defect 2 for every mutator.
  - Gated on `mutates:false` so a CLEAN path-scoped checkout keeps its narrow per-file key (not widened to the tree); and the verb must sit in the subcommand position, so a mutator WORD inside an arg (a commit message) does NOT trip it — the landing commit is never refused. Over-refusal (e.g. an echo of the literal text) is accepted by design.
  - **Known residual (noted in code):** a command that is BOTH a detected non-git mutation AND a wrapped git mutator nets on the first only (the net is gated on mutates:false to protect path-scoping). Not in the attack surface; closing it would need scan-state, not a bigger regex.
- **Verification (must-FAIL from the r3 code, run both ways):** r3 baseline probe = 12/13 attacks slip (above). Post-fix, the full r4 attack list classifies whole-tree: the post-double-dash apply forms, exec/xargs/timeout/command/nohup around apply, the -C apply form, a path-qualified git-apply, and the same wrappers around checkout/restore/reset/stash/clean. The exact exempt form stays exempt; all r1–r3 cases unchanged. Regression guards hold: clean checkout/restore/rm stay path-scoped; commit-message/status/log/diff/add stay not-a-mutation; a `digit` substring does not match. End-to-end over the OUT-OF-REPO foreign scratch lock: the post-double-dash apply, the exec-wrapped apply, and a timeout-wrapped checkout are now all REFUSED (were allowed), while the bare index-only landing is STILL ALLOWED.
- **Suites:** `verify-feat-129-file-lock.mjs` → PASS 224/224 (confined runner, scratch HOME pre-made). `npm run gate` → PASS (exit 0, read unpiped): leak-gate + typecheck clean.
- **Files (unstaged):** `scripts/lib/file-lock.mjs`, `scripts/verify-feat-129-file-lock.mjs`, this ticket. (Did NOT touch `file-lock.d.mts` — typecheck passes without declaring the new export; stayed inside the charter's file list.)
- **Risk bucket:** shared-tree safety path (regression-prone) — an independent clean-room verify pass IS warranted before close. r4 only ever WIDENS refusal (apply/am always tree; wrapped mutators tree); it never newly allows anything, so it cannot reintroduce a clobber. The one preserved allow (bare index-only landing) and all path-scoping are pinned by the suite.
