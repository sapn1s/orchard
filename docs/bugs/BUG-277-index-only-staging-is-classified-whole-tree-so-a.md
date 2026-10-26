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
  "updated": "2026-10-25",
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
