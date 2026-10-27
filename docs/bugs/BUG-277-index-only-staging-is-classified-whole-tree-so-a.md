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
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "648f8f34-9b53-4195-854d-9b6911013dbb",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T12:23:05.104Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "IV 31d2fca^..55dd2dd (r4), VALID manifest-backed (openai quota→anthropic). r4 wrapped-mutator net slips: quoted/escaped git word, quoted/ANSI-C verb, backslash-newline before verb, quoted -C value w/space → mutates:false, ALLOWED under foreign lock. Plus r4-noted combined-line residual."
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a17e1f-44de-7020-a002-78215f0bf82d",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T16:12:38.818Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "IV 31d2fca^..80ec84b (r5), openai/codex cross-provider, VALID. r5 count net over-refuses IN-CONTRACT benign text: git commit -m / git log --grep whose arg literally contains 'git <verb>' (e.g. git reset) -> whole-tree, refused under foreign lock. Combined-line close holds."
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a17e2b-fa2b-7531-b1a2-4e4939432915",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T16:30:58.933Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "07265df4722ae57f36f3e34cc5ead256f051b9c5efdf8348d8aaf601fa4999af",
      "verify_mode": "mixed-state",
      "note": "IV r5+doc candidate, openai/codex, VALID. NEW FALSE-ALLOW (break, not the accepted over-refusal): a wrapped reset with a -c config value containing a SPACE is non-mutating and slips a foreign lock (spaced global-value defeats the net; same class as pinned -C space). Orchestrator decision needed."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "317f770a-9c30-45c0-b7d9-64e44706f372",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T16:55:18.025Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "f4f54cf7836e01b31145a5a835cd9e79f55eaf0b8ebf3b18234a311c2bb294c6",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "d3bcfc7e-0e24-4b74-9a31-89770bfba6b6",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T17:07:41.247Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "8ac18b339d725d8286cce4f667bd87866a256c415490f393d49bd3c4f4fab710",
      "verify_mode": "mixed-state",
      "note": "IV r7 doc/pin candidate (anthropic ran, openai req), VALID. Pins land 252/252. NEW false ALLOW in KEPT r6 code: literal wrapped tree-wipe ALLOWED under a foreign lock when a cmd-SUBSTITUTION in a -C/-c value holds a path-scoped git mutator (count deflates, net misses). Orchestrator call needed."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "4791d92b-e5b5-4364-a3c9-1994a73abad4",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T17:25:04.821Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "68718b7db3cdde871c3de7b9f50752389a6d833509d0f9589aa90ad26f4c607e",
      "verify_mode": "mixed-state",
      "note": "IV r8 VALID (anthropic; openai req). Rule (a) closes the 3 substitution forms. NEW break: a quote/escape-SPLIT decoy verb deflates the same count net with NO substitution (regex counts RAW quoted text; head uses unquoted word) so a literal wrapped reset slips. Orchestrator call needed."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "2c55fd7b-f20a-4615-9438-188da5e8d924",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T17:46:25.637Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "11dcf7fb3dc10bb15c89b234cb6af984a0116260586d4e0c982c6331e5dc878a",
      "verify_mode": "mixed-state",
      "note": "IV r9 VALID (anthropic; openai quota-spent). Charter CLOSED: count removed, SIMPLE-line rule, decoy-split class gone, 288/288. NEW pre-existing vector: gitMutationTarget keys WHOLE-REPO pathspecs narrow on a SIMPLE line -> false ALLOW, real-git wipe confirmed (restore :/ ; checkout -- * ; src/..)."
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

### 2026-10-27 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 648f8f34-9b53-4195-854d-9b6911013dbb — VERDICT: BROKEN — IV 31d2fca^..55dd2dd (r4), VALID manifest-backed (openai quota→anthropic). r4 wrapped-mutator net slips: quoted/escaped git word, quoted/ANSI-C verb, backslash-newline before verb, quoted -C value w/space → mutates:false, ALLOWED under foreign lock. Plus r4-noted combined-line residual.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — fixing lane (round 5)
- **regressed-from:** BUG-277 r4 (same ticket). r4's wrapper-hole net was gated on `mutates:false`, so a COMBINED LINE carrying BOTH a path-scoped mutation AND a wrapped whole-tree mutator never reached the net — it keyed the lock to the scoped file only and the wrapped mutator slipped (the r4-noted residual, now confirmed live by run 648f8f34-9b53-4195-854d-9b6911013dbb).
- **Orchestrator decision (WA §N RESCOPE, recorded as the agent's call):** this guard protects against MISTAKES by NON-malicious agents — the user's stated intent for these guards ("stop autonomous noise and broken main, not malicious agents"). Deliberately OBFUSCATED shell is OUT of contract and NOT closed here: a quoted or escaped command word (`exec 'git' reset`, `exec g\it reset`), an ANSI-C quoted verb (`git $'reset'`), a backslash-newline inside the command word, and a `-C` global value with an embedded space (`exec git -C 'a b' reset`). No agent writes these by accident, and a text classifier cannot close shell obfuscation (r1/r2/r3 proved parsing the shell unsound). Of the newest verdict's 14 slips, ONLY the combined line is in-contract; the rest are the obfuscation forms above. Documented in `file-lock.mjs`'s wrapper-net header AND pinned in the suite as "accepted out-of-contract" so a silent change to their classification is noticed.
- **Hypothesis verified FIRST (probe vs the r4 code):** copied the working-tree `file-lock.mjs` (= r4 + the untouched FEAT-191 hunk) to a scratch file and ran the combined forms. All SLIP: `git checkout -- f; xargs git reset --hard`, the `&&`/`||`/`|`/newline variants, the wrapped-first order, and `sed -i f; exec git reset --hard` ALL returned `paths:["f"]` — keying the lock to `f` only. Clean single/double scoped checkouts stayed correctly scoped. Confirms the net-gating hypothesis exactly.
- **Fix (scripts/lib/file-lock.mjs — the wrapper net + `scanBashMutation` only):**
  - The net now runs on EVERY top-level command, not only the `mutates:false` exit. `scanBashMutation` counts the git tree-mutators it classified as a head `git` (`gitHeadMutators`, incremented in the git branch AND carried up from recursive sub-scans via `merge` so `sh -c "git checkout -- f"` is counted once, not double-widened) and compares that with `countGitTreeMutators(command)` — a new exported global-regex count of git-tree-mutator occurrences in the RAW string. A SURPLUS means a mutator the tokenizer never saw (wrapped, or beside an already-scoped one) → whole-tree, the union/strongest-wins. EQUAL counts keep a clean `git checkout -- f` narrow (count 1 = head 1).
  - Kept `hasWrappedGitTreeMutator` exported (unused by the net now, still a documented predicate); added `countGitTreeMutators`. Threaded an internal `gitMutators` field on the scan result so a parent discounts recursively-resolved git mutators. No shell parsing added; the net stays a whole-string regex (the r3 lesson).
- **Verification (must-FAIL from the r4 code, run both ways):** r4 baseline probe = every combined form slips to `paths:["f"]` (above). Post-fix, the full r5 attack list classifies whole-tree: scoped+wrapped across `;`/`&&`/`||`/newline/pipe, wrapped-first, `sed -i`+wrapped, scoped-checkout+wrapped-`clean`; all r1–r4 cases unchanged (wrapped-only, `apply --cached -- p`, unwrapped reset/stash). The exact exempt bare landing STAYS exempt. Regression guards hold: single + double clean scoped checkouts stay path-scoped; `sh -c "git checkout -- f"` stays scoped (the recursion-count fix); `git status && git checkout -- f` stays scoped; status/log/diff/add/commit-message/`digit` stay not-a-mutation. The five obfuscation forms are PINNED as accepted out-of-contract (each still not-whole-tree; a tightening would be welcome and must update the pin). End-to-end over the OUT-OF-REPO foreign scratch lock: the combined `checkout -- other.txt; xargs git reset --hard` is now REFUSED (r4 ALLOWED it), while the bare index-only landing is STILL ALLOWED.
- **Suites:** `verify-feat-129-file-lock.mjs` → PASS 240/240 (confined runner, scratch HOME pre-made). `npm run gate` → PASS (exit 0, read unpiped): leak-gate + typecheck clean.
- **Files (unstaged):** `scripts/lib/file-lock.mjs`, `scripts/verify-feat-129-file-lock.mjs`, this ticket. (Did NOT touch `file-lock.d.mts`; left the FEAT-191 `checkPathsFree` hunk alone, per charter.)
- **Risk bucket:** shared-tree safety path (regression-prone) — an independent clean-room verify pass IS warranted before close. r5 only ever WIDENS refusal for the combined/wrapped surplus; it never newly ALLOWS anything (the one preserved allow is the bare index-only landing, pinned). The obfuscation residual is explicitly OUT of contract per the orchestrator rescope, documented and pinned, not silently dropped.

### 2026-10-27 — dispatch openai
- **Verification recorded:** dispatch openai run 01a17e1f-44de-7020-a002-78215f0bf82d — VERDICT: BROKEN — IV 31d2fca^..80ec84b (r5), openai/codex cross-provider, VALID. r5 count net over-refuses IN-CONTRACT benign text: git commit -m / git log --grep whose arg literally contains 'git <verb>' (e.g. git reset) -> whole-tree, refused under foreign lock. Combined-line close holds.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — dispatch openai
- **Verification recorded:** dispatch openai run 01a17e2b-fa2b-7531-b1a2-4e4939432915 — VERDICT: BROKEN — mixed-state candidate 07265df4722a — IV r5+doc candidate, openai/codex, VALID. NEW FALSE-ALLOW (break, not the accepted over-refusal): a wrapped reset with a -c config value containing a SPACE is non-mutating and slips a foreign lock (spaced global-value defeats the net; same class as pinned -C space). Orchestrator decision needed.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — worker (dispatch, round 5 residual doc) — accepted OVER-refusal documented; a NEW false-ALLOW surfaced (orchestrator decision)

Charter task (no code change): record the r5 over-refusal (openai run `01a17e1f-44de-7020-a002-78215f0bf82d`) as an ACCEPTED residual per WA §N KEEP.

- **Over-refusal residual — DOCUMENTED (KEEP).** The whole-string count net is a TEXT scan: it cannot tell a git tree-mutator in the SUBCOMMAND position from the same two words inside a QUOTED ARGUMENT. So a benign command whose argument literally contains a git-mutator verb — a commit `-m` message or a `log --grep` pattern that mentions one — counts as a surplus and classifies whole-tree, refused only while a FOREIGN lock is held. It FAILS SAFE (a reworded message or a retry after the lock clears); the alternative (subcommand-position parsing of the raw string) is exactly the shell parsing r1/r2/r3 proved unsound and what let wrappers through in r3/r4. Added a header block in `scripts/lib/file-lock.mjs` (the wrapper-net comment) stating the residual and why, and PINNED it in `scripts/verify-feat-129-file-lock.mjs` section 10: the two over-refusal forms assert `tree === true` (accepted), plus two guards that an ordinary message WITHOUT a literal git-mutator verb stays not-a-mutation (the over-refusal is narrow). No behavioural code change. Suite → **PASS 244/244** (was 240, +4 pins), confined runner. `npm run gate` → PASS (exit 0).
- **NEW break the step-3 IV surfaced — a FALSE ALLOW, escalated (NOT accepted by this lane).** The re-verification (openai/codex run `01a17e2b-fa2b-7531-b1a2-4e4939432915`, VALID) returned BROKEN on something the charter did NOT contemplate: a wrapped reset carrying a `-c` config value whose value contains a SPACE (a display name like `"First Last"`) classifies NON-mutating and slips a foreign lock — the whole-string net's global-value-option branch consumes only `\S+`, so it stops at the space and the verb after it never matches. A combined-line variant (`checkout -- f; <that wrapped reset>`) is also cited. This is the SAME mechanism as the r5-pinned `-C 'a b'` obfuscation residual, but a `-c <spaced value>` is a plausible, non-obfuscated form, and a false ALLOW is the defect this ticket exists to prevent. **This lane made NO code change for it** (charter said no code change) and does NOT fold it into the accepted-residual pins on its own authority. **Orchestrator decision required:** either (a) accept it as the same spaced-global-value residual class already pinned for `-C` (consistent with the r5 rescope), or (b) open a tightening round to make any global value-option carrying a quote/space force whole-tree. The ticket stays in_verification pending that call.
- **Files changed (unstaged, for the user to commit):** `scripts/lib/file-lock.mjs` (header comment only — no behaviour change), `scripts/verify-feat-129-file-lock.mjs` (the accepted-over-refusal pins), `docs/bugs/BUG-277-…md` (this entry + INDEX via board:gen).

### 2026-10-27 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 317f770a-9c30-45c0-b7d9-64e44706f372 — VERDICT: BROKEN — mixed-state candidate f4f54cf7836e. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — worker (dispatch, round 7) — INDIRECTION documented as the limit; NO code change (orchestrator option C, KEEP r6)
Charter task (comments + pins only — r6's CODE stays as is): record the run-317f770a false-ALLOWs as an ACCEPTED out-of-contract residual, per the orchestrator's option-C decision.

- **Orchestrator decision (WA §N, recorded as the agent's call — option C):** KEEP r6's code. The rule: a shell-TEXT scan can only see a mutator verb that is LITERALLY present in the command text. A verb that arrives by INDIRECTION is unknowable to ANY text classifier, so it is OUT of contract. Indirection = a shell variable (OP=reset then `git $OP`), stdin (`echo reset | xargs git`), command substitution, eval, a script file, or `python`/`node -c`. Why: this guard prevents MISTAKES by non-malicious agents, and these forms do not arise by accident; the structural protections for real concurrent work are the lane snapshots (FEAT-176) and per-ticket worktrees (FEAT-191), NOT this heuristic. r1/r2/r3 already proved the inverse (PARSING the shell to recover the verb) is unsound and is what let wrappers through.
- **The 3 run-317f770a cases (openai/anthropic run `317f770a-9c30-45c0-b7d9-64e44706f372`, VALID, verdict BROKEN) — all INDIRECTION, now PINNED as accepted residual.** Confirmed current classification against the working-tree code (scratch probe, not a git command — the hook blocks a literal mutating git): (1) STDIN into a verb-reading wrapper — `echo reset --hard | xargs git` -> `{mutates:false}`; (2) a shell VARIABLE as the subcommand — OP=reset then `git $OP --hard` -> `{mutates:false}` (even UNWRAPPED; the head-git branch never expands vars); (3) a COMBINED line — a path-scoped `git checkout` of held2.txt beside a stdin-fed wrapped reset -> scoped to held2.txt only (count 1 = head 1), so the stdin-fed tree-wipe is not seen. Each is NOT-whole-tree today.
- **Documentation (no behaviour change):** added a "THE DOCUMENTED LIMIT (r7)" block to `scripts/lib/file-lock.mjs`'s OUT-OF-CONTRACT header (the wrapper-net comment), naming indirection as the class and the run id. PINNED the 3 cases in `scripts/verify-feat-129-file-lock.mjs` section 10 under an r7 INDIRECTION header: each asserts NOT-whole-tree today so a SILENT change to their classification is noticed (a future tightening that catches one without reopening a wrapper hole must update the pin).
- **Suites:** `verify-feat-129-file-lock.mjs` -> PASS (confined runner). `npm run gate` -> PASS (exit 0, read unpiped): leak-gate + typecheck clean.
- **Independent verify:** re-ran on the working-tree files (comments+pins candidate) with the full in/out-of-contract brief; verdict recorded in verification[] below. See that line for the provider + run id.
- **Files (unstaged, for the user to commit):** `scripts/lib/file-lock.mjs` (comments only — NO behaviour change), `scripts/verify-feat-129-file-lock.mjs` (the r7 indirection pins), this ticket (+ INDEX via board:gen).
- **Risk bucket:** shared-tree safety path, but this round is a pure DOC/PIN change (no classifier logic touched); the residual is explicitly OUT of contract per the orchestrator's option-C call, documented and pinned, not silently dropped.

### 2026-10-27 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run d3bcfc7e-0e24-4b74-9a31-89770bfba6b6 — VERDICT: BROKEN — mixed-state candidate 8ac18b339d72 — IV r7 doc/pin candidate (anthropic ran, openai req), VALID. Pins land 252/252. NEW false ALLOW in KEPT r6 code: literal wrapped tree-wipe ALLOWED under a foreign lock when a cmd-SUBSTITUTION in a -C/-c value holds a path-scoped git mutator (count deflates, net misses). Orchestrator call needed.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — fixing lane (round 8)
- **regressed-from:** BUG-277 r6 (same ticket). r6's surplus-count net was deflatable by a command substitution in a git global-option VALUE (anthropic run d3bcfc7e-0e24-4b74-9a31-89770bfba6b6, BROKEN).
- **Orchestrator decision implemented:** replace the fragile COUNT comparison with a conservative rule that can't be deflated by a substitution. (a) If the raw line (depth 0) carries ANY command/process substitution (dollar-paren, a backtick, less-than-paren, greater-than-paren) AND the r6 whole-string net (hasWrappedGitTreeMutator) finds any git-tree-mutator match, classify WHOLE-TREE. (b) Otherwise keep r6's surplus-count net. Over-refusal is the accepted direction.
- **Hypothesis VERIFIED FIRST (probe vs the r7/HEAD code, synthetic throwaway):** the 3 cited forms all FALSE-ALLOWED pre-fix (a dollar-paren substitution in a -C value holding a scoped restore, beside a literal tree-wipe → keyed to the scoped path only; the -c config-value form; the backtick -C form) — reproduced from the live IV probe. Post-fix all 3 (+ process-substitution variants) → TREE. The r7 indirection pins (variable-as-subcommand, stdin-fed wrapper, the combined indirection line) and the r5 obfuscation pins (split git word, split verb) are UNCHANGED (no substitution token). The exempt bare index-only apply landing is UNCHANGED (no substitution).
- **Over-refusals ADDED by rule (a) (accepted, listed):** a clean scoped git mutator whose argument comes from a substitution — a checkout/restore of a path produced by a substitution — and a benign command wrapping a scoped mutator in a substitution — an echo of a scoped checkout — now classify whole-tree (previously path-scoped). Refused only while a foreign lock is held; a reworded command or a retry passes. No prior in-contract PASS case changed other than these.
- **Fix (scripts/lib/file-lock.mjs — the depth-0 net + its header only):** the net at the scan exit is now a two-part depth-0 block (rule (a) substitution-co-occurrence, then r6's count net). Header blocks updated: the r7 "DOCUMENTED LIMIT" now notes the r8 narrowing, and a new "r8 NARROWING" block explains the deflation and rule (a). No other classifier logic touched; hasWrappedGitTreeMutator / countGitTreeMutators unchanged. Left the FEAT-191 checkPathsFree hunk alone; did NOT touch file-lock.d.mts (no new export).
- **Suites:** verify-feat-129-file-lock.mjs → PASS 269/269 (was 252; +17 r8 asserts: 5 cited/variant → TREE, 3 over-refusal pins, 4 guards, 2 indirection-unchanged pins, 3 end-to-end foreign-lock refusals, 1 landing-still-allowed) under the confined runner with a pre-made scratch HOME. npm run gate → PASS (exit 0, read unpiped): leak-gate + typecheck clean.
- **Independent verify → BROKEN (VALID), a NEW vector:** anthropic run 4791d92b-e5b5-4364-a3c9-1994a73abad4 (openai requested; anthropic ran), candidate 68718b7db3cd, VALID. Rule (a) closes the 3 substitution forms, but the IV found a DIFFERENT deflation of the SAME count comparison that needs NO substitution: a quote/escape-SPLIT decoy verb. A path-scoped checkout whose verb word is quote-split (a quoted fragment inside the word), on a combined line beside a literal wrapped tree-wipe, classifies to the scoped path only and is ALLOWED under a foreign lock (the un-split control is REFUSED). Same with an empty-quote split and a backslash split, across clean/stash. REPRODUCED directly (scratch probe). Root cause: countGitTreeMutators runs the regex on the RAW quoted text (so a quote-split verb does not match the word-boundary verb pattern → UNDERCOUNTS), while gitHeadMutators is counted AFTER the tokenizer UNQUOTES the word (so it counts the decoy). count==head, so neither rule (a) (no substitution token) nor rule (b) (no surplus) fires — the literal wrapped wipe slips.
- **In/out of contract:** the tree-wiping verb (reset --hard / clean -fdx / stash) is FULLY LITERAL and wrapped on a combined line → IN contract per the brief ("a git word and a tree-mutator verb literally present, wrapped or not, on combined lines"). The obfuscation is only in the harmless DECOY. So this is a real in-contract FALSE ALLOW, not the accepted out-of-contract "obfuscation inside the verb word" (that exemption is for the WIPE being obfuscated, not a decoy masking a literal wipe).
- **Escalation (orchestrator decision needed):** rule (a) was the orchestrator's dictated rule for the substitution vector and it holds for that vector; the decoy-split is a distinct deflation requiring a counting-semantics decision. Proposed direction (conservative, over-refusal-accepted): run countGitTreeMutators on a copy of the command with word-splitting quote/escape characters removed, so a quote-split decoy verb is counted and the surplus net fires — this makes the decoy case match its already-TREE control. This lane made NO code change for the new vector (beyond rule (a)) and does not pick the counting change on its own authority on a data-loss safety path.
- **Files (unstaged, for the user to commit):** scripts/lib/file-lock.mjs, scripts/verify-feat-129-file-lock.mjs, this ticket (+ INDEX via board:gen).
- **Risk bucket:** shared-tree safety path (regression-prone, data-loss). r8's rule (a) only ever WIDENS refusal (never newly allows); it is a strict improvement over r6 that closes the 3 cited substitution false-allows. The ticket stays BROKEN pending the orchestrator's call on the decoy-split deflation. An independent clean-room verify pass IS warranted on whatever closes it.

### 2026-10-27 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 4791d92b-e5b5-4364-a3c9-1994a73abad4 — VERDICT: BROKEN — mixed-state candidate 68718b7db3cd — IV r8 VALID (anthropic; openai req). Rule (a) closes the 3 substitution forms. NEW break: a quote/escape-SPLIT decoy verb deflates the same count net with NO substitution (regex counts RAW quoted text; head uses unquoted word) so a literal wrapped reset slips. Orchestrator call needed.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 2c55fd7b-f20a-4615-9438-188da5e8d924 — VERDICT: BROKEN — mixed-state candidate 11dcf7fb3dc1 — IV r9 VALID (anthropic; openai quota-spent). Charter CLOSED: count removed, SIMPLE-line rule, decoy-split class gone, 288/288. NEW pre-existing vector: gitMutationTarget keys WHOLE-REPO pathspecs narrow on a SIMPLE line -> false ALLOW, real-git wipe confirmed (restore :/ ; checkout -- * ; src/..).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — fixing lane (round 9)
- **regressed-from:** BUG-277 r5-r8 (same ticket). Every one of r5/r6/r7/r8 was a different way to DEFLATE the same surplus-COUNT comparison; the r8 IV (anthropic run 4791d92b) found the last one — a quote/escape-SPLIT decoy verb (`git "che"ckout -- f`) that under-counts the RAW side (regex on still-quoted text) while the head count is taken on the UNQUOTED word, so count==head and a LITERAL wrapped tree-wipe beside it slipped.
- **Orchestrator decision implemented:** REMOVE the count comparison entirely (deflatable by construction). New rule, no counting: (1) a git tree-mutator stays PATH-SCOPED only on a SIMPLE line — one command, no separator (`;`/`&&`/`||`/pipe/newline/`&`), no command/process substitution (`$(`/backtick/`<(`/`>(`), no quote or escape anywhere, a bare `git` head (optionally path-qualified), never a wrapper (exec/xargs/env/timeout/command/nohup/sh -c); (2) EVERY other line on which the lazy net matches — tested on the RAW text AND on a copy with `"`,`'`,`\` removed — is WHOLE-TREE; (3) a line with no net match is unchanged. New exported predicate `isSimpleLine`.
- **Hypothesis VERIFIED FIRST (probe vs the working-tree r8 code, synthetic throwaway):** the 3 decoy-split forms (+ empty-quote and stash variants) all FALSE-ALLOWED pre-fix (returned paths=["f"], keying the scoped decoy only; the un-split control was already TREE). Post-fix all → TREE. Hypothesis CONFIRMED: this closes the count-deflation class from r5-r8 — decoy-split (r8), wrapped verb (r4), spaced option value (r6), substitution-in-value (r8 rule a) — because a compound/wrapped git-mutator line can no longer be path-scoped AT ALL. The r6 backslash-in-git-word obfuscation is now ALSO caught by the dequoted copy (moved from residual to closed).
- **Over-refusals ADDED (accepted, listed):** a clean but COMPOUND/WRAPPED git mutator now classifies whole-tree instead of path-scoped — two scoped checkouts joined by `&&`, a status-then-scoped-checkout line, an sh -c wrapping a scoped checkout, a git mutator with a QUOTED path, a leading env-assignment, or any pipe/separator beside a git mutator. r5-r8 kept these narrow via count==head; r9 widens them (refused only while a FOREIGN lock is held; a retry passes). Non-git compound mutations (cd sub && sed -i f) are UNAFFECTED (the net only matches git). Residuals KEPT as documented pins: pure INDIRECTION (OP=reset then git $OP; echo reset piped to xargs git) and a backslash-NEWLINE inside the verb — no literal git+verb survives even after dequoting.
- **Fix (scripts/lib/file-lock.mjs only):** replaced the depth-0 two-part count block with the SIMPLE-line net; added `isSimpleLine` (exported) beside `hasWrappedGitTreeMutator`; DELETED the now-unused `countGitTreeMutators` + the global regex and the `gitHeadMutators`/`gitMutators` threading (counter, the merge carry-up, the git-branch increment, and the field on both return shapes). Rewrote the r4-r8 net header block to the r9 story. Left the FEAT-191 checkPathsFree hunk alone; did NOT touch file-lock.d.mts (neither deleted name was declared there; the new isSimpleLine is consumed only by the verify suite, not src, so no declaration needed — typecheck clean).
- **Suites:** verify-feat-129-file-lock.mjs → PASS 288/288 (flipped 5 pins to the r9 behaviour — the two r5 clean-compound guards and the sh -c section-1 case to TREE over-refusals, the r6 backslash-in-word pin to CLOSED, the r7 combined-indirection pin to TREE; added an r9 block: 4 decoy-split must-FAILs, 8 isSimpleLine predicate asserts, 3 path-scope guards, 1 decoy end-to-end foreign-lock refusal, landing-still-allowed). Also made the suite self-sufficient for its scratch dir so it runs as a single node command. Confined runner. npm run gate → PASS (exit 0, read unpiped): leak-gate + typecheck clean.
- **Independent verify → BROKEN (VALID), a NEW DISTINCT vector (NOT a count deflation):** anthropic run 2c55fd7b-f20a-4615-9438-188da5e8d924 (openai requested but quota-spent until ~20:31 → anthropic ran; author anthropic too, so cross-provider decorrelation is reduced this round — a fresh openai pass is warranted on whatever closes the new vector), candidate 11dcf7fb3dc1, VALID. The r9 rule CLOSES the charter target (every count-deflation break). The IV found a PRE-EXISTING hole (present identically in r1-r8, orthogonal to the count): `gitMutationTarget` keys a WHOLE-REPO pathspec to a narrow literal path on a SIMPLE line, so it is ALLOWED under a foreign lock — an IN-CONTRACT false ALLOW, real-git wipe CONFIRMED (the verifier ran real git and watched src/held.txt get overwritten). Cases: (1) git's magic `:/` = repo root — restore/checkout/rm/restore-worktree with `:/` keyed to literal `:/`; (2) `git restore src/..` and `git restore $PWD` normalize to `.` but are keyed as a path entry, not tree (the a!=='.' check sees only the raw token, before normalization); (3) `git checkout -- *` (glob over the repo top level) keyed to literal `*` (isSimpleLine does not reject glob chars). Also noted-untested: shell/config aliases (alias g=git, git co) which hide the verb by indirection (likely out of contract), and CR/U+2028 passing isSimpleLine (bash does not treat them as separators).
- **Escalation (orchestrator decision needed) — this lane made NO code change for the new vector.** It is a DISTINCT mechanism from the charter's count removal (it is in gitMutationTarget's pathspec→path mapping, not the net), it is pre-existing (r1-r8 keyed these the same way), and it is a data-loss safety path, so per the r8 precedent this lane does not pick the pathspec/glob fix on its own authority. Proposed direction (conservative, over-refusal-accepted): in gitMutationTarget, classify as TREE any pathspec that is a git MAGIC pathspec (:/..., :(...), a leading :), that NORMALIZES to the repo root or above (., .., src/.., $PWD, an absolute path), or that carries a GLOB metacharacter (* ? [) — and/or reject glob chars in isSimpleLine. Needs the orchestrator's call because it touches pathspec semantics and must interact cleanly with the legitimate narrow-scoping of real single files and with the existing glob-expansion (expandGlob).
- **Files (unstaged, for the user to commit):** scripts/lib/file-lock.mjs, scripts/verify-feat-129-file-lock.mjs, this ticket (+ INDEX via board:gen).
- **Risk bucket:** shared-tree safety path (regression-prone, data-loss). r9 only ever WIDENS refusal relative to the count net (never newly allows); it is a strict improvement that closes the whole count-deflation class and makes the classifier non-deflatable by construction. The ticket stays BROKEN pending the orchestrator's call on the whole-repo-pathspec/glob false-allow. An independent clean-room verify pass (ideally cross-provider openai once quota resets) IS warranted on whatever closes it.
