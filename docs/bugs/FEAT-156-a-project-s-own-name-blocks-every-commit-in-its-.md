```orchard-ticket
{
  "id": "FEAT-156",
  "type": "feature",
  "title": "a project's own name blocks every commit in its own repo",
  "summary": "Orchard's leak gate refuses every commit in a private Orchard-managed project because that project's own name is on the global token list, the gate cannot tell which repo it is in, there is no per-repo way to waive a false positive, and the error points users at their repo's stale copy of the gate.",
  "impact_if_we_wait": "That project cannot commit through Orchard at all, so its users either stop using the gate or bypass it by hand, which is the worse outcome for every other repo too.",
  "current_need": "Waive a project's own name only inside its registered repo, add a reasoned per-hit allowlist that can never cover a credential, and make every gate run name the gate and list that ran.",
  "severity": "high",
  "area": "leak-gate / server",
  "reported": "2026-09-29",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-09-29",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "a project own-name token staged in that project registered repo is waived and the waiver is printed",
    "another project token, a home path, or the own name in a different repo still FAILS",
    "a .leakgate-allow entry waives exactly one hit class and can never waive a credential",
    "every gate run names the absolute gate and token-list paths that ran",
    "the new verify script FAILS against the gate pinned at a977e76 and PASSES after"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-104",
      "relation": "see_also"
    },
    {
      "id": "FEAT-130",
      "relation": "see_also"
    },
    {
      "id": "FEAT-049",
      "relation": "see_also"
    },
    {
      "id": "BUG-102",
      "relation": "see_also"
    }
  ],
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

# FEAT-156 — a project's own name blocks every commit in its own repo

## Symptom
Another Orchard-managed project reported that Orchard's host leak gate refuses **every** commit in that project's own repo, from the dashboard and from agent sessions. The reason: that project's own name is on the gate's global private-token list (it must stay there, so the name never lands in Orchard or any *other* repo), and the gate has no idea which repo it is running in. The failure text then tells the user to run `node scripts/leak-gate.mjs` — which, in the target repo, is that repo's own stale onboarded copy, not the gate that refused them. And there is no sanctioned way to waive a genuine false positive except editing the hardcoded `ALLOWED_HITS` in Orchard.

## Expected
1. **Own-project exemption.** A project's own private-name token is waived only when the gate runs for that project's registered repo; every other project's tokens, and all identity tokens (home path, username, handle, email), still FAIL. Waivers are counted and reported on every run.
2. **Per-repo allowlist.** A committed `.leakgate-allow` at the target repo root; every entry carries a reason; matching is per hit (token label and/or matched value, optional path glob), never per line; waivers counted and reported; credential classes (key shapes, PEM, secret assignments, connection strings) cannot be allowlisted — trying is an error.
3. **Named list.** Every run (PASS and FAIL) names the absolute path of the gate script and token list that actually ran.
4. **Actionable error.** The FAIL hint and both host wrappers name the real gate, say how to allowlist, and that own-project names are exempt.

## Plan

**Invariant.** A waiver may only ever be granted by a fact the scanned repo cannot write for itself (own-project), or by a committed, reasoned, per-hit entry that can never cover a live credential (allowlist). Every waiver is printed. Nothing else changes what FAILS.

**Design — own-project (ARCH-010).** Repo to project is resolved by the host from the registry, never inside the gate from a dir name or remote slug: the host wrappers (`src/server/git.ts` dashboard commit; `runLeakGateForRepo` in `src/server/runtime/claude-runtime.ts`, which serves both the SDK PreToolUse guard and the git-shim decide route) take the registered project(s) whose `hostPath` realpath equals the repo's git toplevel realpath, and pass each registered name as `--own-project=<name>`. The gate waives a token only if that token is tagged `kind: 'project'` in the token list AND its regex matches a passed name. So the association is the join of two facts each already declared once by its owner — the name in the user's registry (user state, never tracked) and the token in the list — and no private name is written anywhere in Orchard's tracked files, tickets included. Identity tokens are never project-kind, so a project registered under the username's name (such a row exists in the real registry) cannot waive the username token. Nested repos, unregistered repos and past paths get no waiver (exact toplevel match only).

**Design — allowlist.** One entry per line: `token:<label> [match:<text>] [in:<glob>] because: <reason>` (or `match:` alone). Read from the staged index under `--staged` (the allowlist that governs a commit is the one being committed), from the worktree otherwise, from the tree root in tree mode. Malformed line, missing reason, unknown token label, a credential-class label, or a `match:` value that is itself credential-shaped = exit 2 (fail closed). At match time credential hits are never waivable regardless. A hit on the `.leakgate-allow` line that declares it is waived by that same entry (reported).

**Design — output.** `LEAK GATE: ran <gate> with token list <list>` on every run; the capped-FAIL hint names the absolute gate path; a FAIL footer explains `.leakgate-allow` and the own-project exemption. Host wrappers prefix that the host gate is authoritative (the repo's own copy is a local preflight) and keep the footer when truncating.

**Proof bar.** `scripts/verify-feat-156-leak-gate-own-project.mjs` over a temp fixture repo + scratch registry: (a) own name staged in own repo, waived + reported; (b) same repo staging another project's token or a home path, FAIL; (c) own name in a different project's repo, FAIL; (d) per-word allowlist waiver while a different hit on the same line still FAILS; (e) allowlisting a key-shape secret refused; (f) output names absolute gate + list paths. Must FAIL against the gate pinned at commit a977e76, PASS after. Anti-regressions: verify-feat-130, verify-gatekeeper, verify-feat-049-licence, verify-leak-write-guard, verify-feat-108-*, verify-bug-173, verify-feat-110, `npm run gate`, typecheck.

## Context pack
- Gate: `scripts/leak-gate.mjs`, list `scripts/lib/leak-tokens.mjs` (TOKENS, ALLOWED_HITS).
- Host entry points: `src/server/git.ts` runCommitLeakGate; `src/server/runtime/claude-runtime.ts` runLeakGateForRepo (also called from the git-shim decide route in `src/server/index.ts`).
- Registry authority: `src/server/registry.ts` (Project.name, Project.hostPath).
- Related: FEAT-104 (added the private-project token class that now blocks its own owner), FEAT-130 (credential classes), FEAT-049 (the one sanctioned ALLOWED_HITS exemption), BUG-102 (gate output modes).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-28 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-29 — agent (worker, round 1) — plan review before build

- **Hypothesis check (HEAD a977e76):** confirmed the explore lane's picture. The gate is `scripts/leak-gate.mjs` with the list in `scripts/lib/leak-tokens.mjs`; the only exemption is the hardcoded one-entry `ALLOWED_HITS` (LICENSE line). No per-repo allowlist, no repo-to-project association anywhere. Host entry points: `runCommitLeakGate` (`src/server/git.ts`) and `runLeakGateForRepo` (`src/server/runtime/claude-runtime.ts`, which also serves the git-shim decide route in `src/server/index.ts`). The capped-FAIL hint names the repo-relative `scripts/leak-gate.mjs`. Neither wrapper surfaces gate stdout on PASS.
- **Cross-provider review — NOT obtained this round.** `dispatch --provider openai` refused with `[quota-window]` ("usage limit … try again at 2:50 AM", thread 01a0ea30-9d9a-7b01-8a0e-f93834bebaf3). Substituted a fresh-context `dispatch --provider anthropic` (separate `claude -p` process, run id 2b2cfc00-cb14-4d17-acec-3e12a19b8e87, read-only). Same objective. This is cross-context, not cross-provider; OpenAI is retried after the window.
- **Verdict (anthropic): SOUND-WITH-CHANGES.** 14 points. Disposition:
  1. *Critical — a local process can rename a project over the API (or register a symlink alias) to self-grant the waiver.* **Adopted, partly.** A token is own-waived only if it matches BOTH the registered name AND the basename of the realpath of the repo's git toplevel; if more than one registered project resolves to that realpath, nothing is waived; never in the Orchard checkout itself. Rebutted "full match": real project names carry suffixes on the stem (two real projects share the A stem), so full-match would re-break the reported case. The basename is a necessary condition, never a source of the association, so ARCH-010 still holds: the registry grants, the directory can only veto.
  2. *High — "per hit" is really per label (first match per token per line).* **Rebutted.** For a literal token every occurrence has the same matched text, so position is not a meaningful waiver unit; the unit is (token, value, path glob), and a different hit class on the same line still fails (proof case d).
  3. *High — a `match:` value is published in the allowlist and self-waived.* **Adopted the self-waiver drop:** the allowlist file is scanned like any other file; a `match:` entry's own value is waived there only if the entry's glob covers `.leakgate-allow`. Rebutted the hashing: the value being waived is by definition about to be published in that repo anyway.
  4. *High — identity tokens and personal email allowlistable.* **Adopted, default-deny.** Only `project`/`client`-kind tokens are allowlistable by label; `personal email` only with an exact `match:` address; identity (home paths, username, handle, email) and every credential class are refused with exit 2; unknown labels refused.
  5. *High — waivers silent on the host paths (stdout dropped on PASS).* **Adopted.** Both wrappers log PASS waivers + the ran-line; the dashboard commit response carries them.
  6. *High — labels not unique / hard to parse.* **Rebutted.** Labels are parsed between explicit `token:`/`match:`/`in:`/`because:` keywords; the one duplicated label is two words of the same client, so waiving both by label is the intended meaning.
  7. *Medium — scope of waivers.* **Adopted:** own-project → file content + commit message; allowlist → real file paths only; nothing → committer identity; binary/svg hits are credential classes and never waivable.
  8. *Medium — TREE mode waived by a file inside the tree.* **Adopted:** TREE mode ignores any in-tree allowlist (reported) and refuses `--own-project` (exit 2).
  9. *Medium — the ran-line's absolute path itself contains the home-path token.* **Adopted:** paths under the home dir print `~`-relative (still unambiguous), plus a sha256 prefix of the token list.
  10. *Medium — a new allowlist arrives unreviewed.* **Adopted partly:** when the staged diff adds/changes `.leakgate-allow` the gate prints its entries as part of what is being approved. A required acknowledgement is out of scope (handoff).
  11. *Medium — onboarded copies never get the own-project exemption.* **Adopted as documentation:** the FAIL footer says the repo-local copy is a preflight.
  12. *Low (flag echo, registry error = no waiver, strip `g`, glob semantics, unused entries, no values in waiver lines).* **All adopted.**
  13. *Low — git-shim scans the project hostPath even for `git -C elsewhere`.* Pre-existing, out of scope; noted.
  14. *Proof gaps.* Adopted: rename/symlink alias, own name in commit message, identity/email refused, TREE refusal, host-wrapper PASS output.

### 2026-09-29 — agent (worker, round 1) — build + fixer verification

- **Changed (uncommitted, unstaged):**
  - `scripts/lib/leak-tokens.mjs` — every TOKEN now carries `kind` (`project` / `client` / `identity`); new `CREDENTIAL_CLASSES`, `tokenKindOf`, `ownProjectTokens(names, repoBasename)`, `parseAllowlist`, `allowlistEntryFor`, `globToRegExp`, `ALLOWLIST_FILE`.
  - `scripts/leak-gate.mjs` — `--own-project=<name>` (refused in TREE mode, refused in the gate's own checkout); `.leakgate-allow` loading (index under `--staged`, worktree otherwise, ignored in TREE mode; any invalid entry = exit 2); per-hit waivers in file content (own-project + allowlist) and commit message (own-project only); every run prints `LEAK GATE: ran <gate> with token list <list> (sha256 …)`, the own-project note, each waived hit (label + file:line, never the value), a waiver tally, stale-entry notes, and — when the commit changes the allowlist — its entries; FAIL prints a "how to resolve" footer; the capped-FAIL hint names the real gate path and cwd.
  - `src/server/leak-gate-host.ts` (new) — the one host place that names the gate and resolves repo → registered project (exact realpath of the git toplevel; exactly one owner or nothing; any error → nothing).
  - `src/server/git.ts` — dashboard commit passes `--own-project`, logs PASS waivers, returns them as `leakGate` in the commit response; refusals carry the host-gate banner and keep the footer (head+tail cap instead of a 1500-char head slice).
  - `src/server/runtime/claude-runtime.ts` — `runLeakGateForRepo` (agent PreToolUse guard + git-shim decide route) same treatment.
  - `scripts/gate.mjs` — on PASS also shows the ran-line, own-project note and waiver tally (it already showed `waived` lines).
  - `scripts/verify-feat-156-leak-gate-own-project.mjs` (new).
- **Fixture:** SYNTHETIC — temp git repos + a scratch `CLAUDE_STATION_DATA` registry. Every needle is derived at runtime from the token list (this file and this ticket carry no private value).
- **Must-FAIL (gate pinned at a977e76, `--baseline`):** `FEAT-156 BASELINE: 12 passed, 19 failed` — every own-project case (a1–a6, b3), TREE/self refusals (c5, c6), every allowlist case except the one that is FAIL either way (d1–d3, d5), every refusal case (e1–e4, e.g. e4 observed `exit 0` — the old gate silently ignored a reasonless allowlist), and the named-list cases (f1–f3, observed `no ran-line`). The 12 that pass on both are the anti-regressions (b1, b2, c1–c4, d4, f4, R1–R3).
- **After:** `FEAT-156 verify: 39 passed, 0 failed` (adds host-wrapper cases h1–h5 with h1b/h2b "waiver logged", and R4: a registry truncated at 5 cut points grants no waiver, observed names `0,0,0,0,0`).
- **Real artifact (the reporting project's repo, read-only, no writes):** host resolution from the REAL registry → 1 registered name. Staged index: pinned gate `FAIL — 252 hits`, of which 226 are that project's own-name token; new gate with the host-resolved flag `FAIL — 26 hits`, 0 own-name, `waivers — 226 own-project`. The 26 remaining are 22 `secret assignment` + 4 `personal email` — credential-class hits in that repo, which this feature deliberately cannot waive; that project's owner must review them (real secrets or FPs; a specific address can be allowlisted with `match:`).
- **Anti-regressions (after the change):** verify-feat-130 171/0; verify-gatekeeper 31/0; verify-feat-089-method-auto 35/0; verify-feat-108-git-grant 40/0; verify-feat-108-git-write-block 164/0; verify-feat-135-git-shim 31/0; verify-feat-110-authoring-guard 17/0; verify-feat-097-board-tool 86/0; `npm run gate` exit 0; `npm run typecheck` exit 0.
  Red, and **pre-existing** — identical result on a scratch copy of the current tree with only my files reverted to a977e76 (`~/.local/state/claude-station/scratch/feat156-minusmine`): verify-feat-049-licence (README checks A14/A15b/C9), verify-leak-write-guard 15/1 (must-FAIL anchored to HEAD), verify-bug-173 27/1 and verify-bug-184 27/1 (same moving-baseline shape), verify-bug-080 16/1 (excluded-image count), verify-feat-106 C2b (flat fixture copies leak-gate without its `lib/`), verify-feat-049-publish-safety (historical mirror script errors), verify-feat-108-git-request-approve 13/7 (browser rail UI). None touches a file this change edits, and each shows the same FAIL set with and without it.
- **Still open / handoff:**
  - Cross-provider (OpenAI) plan review is still owed — the retry result is appended below if it ran.
  - A required acknowledgement for a commit that adds allowlist entries (review point 10) is not built; the entries are printed instead.
  - Onboarded repos' local `npm run gate` copies never get the own-project exemption and only learn the allowlist when re-onboarded — by design, now stated in the FAIL footer.
  - `gatekeeper.mjs` (FEAT-050 review gate) runs the gate without `--own-project`, so it still flags a project's own name in its own repo — left as is; worth a follow-up if that path is used on such a project.
  - Pre-existing: the git-shim route scans the project hostPath even for `git -C <elsewhere>`.
  - Needs an independent clean-room verify (security-class change to the commit gate) before VERIFIED.

### 2026-09-29 — agent (verify lane, round 2) — independent clean-room verify: HOLDS (comprehensive executed matrix; same-provider caveat)

- **Verdict: HOLDS.** An independent clean-room verifier ran the FULL required adversarial matrix by
  EXECUTION and found **zero breaks** ("BROKEN cases: none"). The round-2 fix (allowlist read only
  from the stage-0 git INDEX, `git show`/`ls-files -s`, regular-file-only) holds against every attack
  in the round-2 charter, in every mode (working-tree `--summary`, `--staged`, TREE) and on every host
  path (dashboard commit `src/server/git.ts`, agent guard `runLeakGateForRepo`, git-shim decide route).
- **Provider caveat — NOT cross-provider (same as round 1).** OpenAI was in `[quota-window]`
  ("try again at 2:50 AM") the whole round: `dispatch-client --check` reported openai available, but the
  actual codex turn failed `[quota-window]` (run `01a0ea54-b4c3-7262-9a86-6a795a7fcf98`). Per the
  dispatch charter I fell back to `--provider anthropic` (same provider as the fixer `a42a1f7c85aa8e766`
  and this lane). This is cross-CONTEXT, not cross-provider — a weaker decorrelation for a HOLDS
  verdict. It is nonetheless conclusive here because the verifier reproduced every property by
  EXECUTION (not static reading), across a comprehensive edge-case matrix, with no break. An
  independent cross-provider (OpenAI) re-run is still owed when quota returns; it is the one residual.
- **Verified-by:** provider=anthropic, run id `5dbd7d8d-c79a-4fe8-b95c-66e30242f61b` (the conclusive
  run; transcript `~/.claude/projects/-tmp-feat156-room-CKm6/5dbd7d8d-….jsonl`). Verifier ≠ fixer
  (`a42a1f7c85aa8e766`) ≠ this lane. Clean room = rsync of the working tree (tracked + untracked,
  FEAT-156 changes included) with CLAUDE.md/AGENTS.md/.claude/docs/bugs/docs/prompts/docs/CONVENTIONS.md
  removed; the verifier git-init'd the room itself so repo-mode `git rev-parse --show-toplevel` and the
  c6 self-checkout case resolve. Its charter carried only the requirement (round-1 text + the round-2
  "only the reviewed git copy counts" sentence) + the diff + how-to-run + the fixer's test file — NOT
  the fixer's report or this ticket. Also: run `4f8148ed-8b96-43bf-b3bd-fa22e69c38a8` (a redundant
  re-dispatch after the first run's watcher was killed — by then the time-boxed git-write grant had
  expired, so it could only run the non-git attacks, all OK, and correctly returned INCONCLUSIVE for
  the git-index attacks; superseded by the complete matrix in `5dbd7d8d`).
- **Harvest note (why one run, read from ground truth).** The first (and conclusive) verifier's
  in-process watchers were killed by an infra cleanup at 23:27:44Z. That kill truncated the verifier's
  PROSE verdict line, but NOT its executed evidence: the `claude` CLI had already persisted the full
  transcript, which shows the complete attack script output ending in "BROKEN cases: none". This lane
  harvested the verdict from that ground truth (the executed run manifest), per the round-2 charter's
  "read the verifier's state from ground truth" instruction — the verdict is grounded in what executed,
  not in the prose the kill cut off.
- **Attacks executed (all HELD, all by execution):**
  - **Round-1 break re-tried (hidden untracked allowlist via `.git/info/exclude`)** — refused on every
    path: agent guard pre-exec `git add f && git commit` shape → `ok=false` (gate note: "…NOT in the
    index (untracked or ignored) — IGNORED"); raw `--summary` exit 1; raw `--staged` exit 1; agent
    guard with f staged → `ok=false`; dashboard → REFUSED(422); plain untracked → `ok=false`;
    `rm --cached` (HEAD has it, index doesn't) → exit 1 / `ok=false`.
  - **Allowlist staged in the SAME commit as the leak** — the agent guard PRE-exec (nothing staged
    yet) → `ok=false`; at commit time with BOTH staged it IS allowed by design (index copy governs:
    guard `ok=true`, dashboard COMMITTED) AND the newly-added entry is SURFACED for review
    ("NOTE — this commit ADDS/CHANGES .leakgate-allow; its entries are part of what you are
    approving"). Answer to the charter's question: yes-by-design, and it is surfaced.
  - **`.leakgate-allow` as symlink (in/out), directory, gitlink** — index non-regular modes 120000 /
    160000 IGNORED; a directory entry has no stage-0 blob → IGNORED; all still FAIL/refused.
  - **Subdirectory / submodule allowlist** — a non-root `sub/.leakgate-allow` does not waive at root;
    a submodule's committed allowlist waives only when the gate runs inside the submodule (its own
    reviewed copy). Correct.
  - **`assume-unchanged` / `skip-worktree`** — the worktree edit is ignored; "differs from the index —
    the INDEX copy governs" note; still FAIL/refused.
  - **Merge-conflicted index (stages 1/2/3, no stage 0)** — "conflicted/unmerged … IGNORED"; FAIL/refused.
  - **Non-UTF8 / huge allowlist** — a binary/malformed allowlist → parse error exit 2 (fail-closed);
    a 2 MB allowlist → `git show :.leakgate-allow` ENOBUFS surfaced as exit 1 (fails CLOSED — safe but
    ungraceful); a valid 900 KB allowlist parses and waives normally. Also a local textconv/clean-smudge
    filter on `.leakgate-allow` cannot alter what the gate reads (index blob governs).
  - **Round-1 held properties re-checked** — own name waived+counted in own repo (file content AND
    commit message); foreign token / home path / own-name-in-a-different-repo → refused; caller-injected
    `--own-project` in a non-matching dir → no waiver; duplicate/symlink-alias registration → no waiver;
    every credential / identity / `match:`-secret / reasonless / short-reason allowlist entry refused
    exit 2; TREE mode refuses `--own-project` (exit 2) and ignores an in-tree allowlist; ran-line +
    token-list sha256 present on PASS and FAIL; FAIL footer + host banner present. Fixer's own suite
    re-run in the room: **49 passed / 0 failed** (incl. the round-2 x1–x10 index-only cases).
- **Robustness notes (NOT breaks — every one fails closed / refused):** (a) a >~1 MB allowlist trips
  `spawnSync git ENOBUFS` on `git show :.leakgate-allow`, surfaced as a raw exit 1 rather than a clean
  "allowlist too large" message — safe (refused) but ungraceful; worth a `maxBuffer`/size-cap follow-up.
  (b) a directory named `.leakgate-allow` makes `git show :.leakgate-allow` print a `fatal: ambiguous
  argument` to stderr before the IGNORED path — cosmetic. Neither widens a waiver.
- **Could-not-test:** cross-provider (OpenAI) confirmation (quota-window all round — the one residual);
  the git-shim `/api/git-shim/decide` route end-to-end through the LIVE service (the verifier exercised
  `runLeakGateForRepo`, which that route calls, but not the HTTP route itself); registry writes racing a
  live `writeAtomic`. Also note: an agent verifier can only build git fixtures while a time-boxed
  git-write grant is active — the grant lapsed mid-round, which is why the redundant `4f8148ed` re-run
  could not reproduce the git-index attacks; a future re-verify needs the grant to be live for its whole
  window.
- **Routing:** verify complete — HOLDS. Ready for VERIFIED (orchestrator to flip status/INDEX). Residual:
  a cross-provider (OpenAI) re-verify once quota returns, given this is a security/commit-gate change;
  the executed anthropic matrix is comprehensive but same-provider.
- **Pre-existing gap filed:** the agent git-write guard's working-tree pre-run skips ignored files, so a
  single-command `git add -f <ignored-file> && git commit` can pass the pre-run (commit-time `--staged`
  scans still catch it). NOT introduced by FEAT-156. Filed as **BUG-199** (repro confirmed), cross-refs here.

### 2026-09-29 — agent (worker, round 1) — OpenAI review still owed

- Tried the OpenAI dispatch again at about 02:00 local; it was refused again with `[quota-window]` ("try again at 2:50 AM"). I did not wait: a lane parked for about 50 minutes on a timer is exactly the orphan hazard the dispatch rules forbid. **Handoff:** after the window, run the same read-only `dispatch --provider openai` plan and diff review, with the same objective ("find ways this weakens the gate or mis-exempts"). Point it at this ticket, the files listed above and `scripts/verify-feat-156-leak-gate-own-project.mjs`, then adopt or rebut each point here. An independent clean-room verification (`scripts/independent-verify.mjs`) is also still required before VERIFIED.

### 2026-09-29 — agent (verify lane, round 1) — independent clean-room verify: BROKEN

- **Verdict: BROKEN — property (2) on the AGENT git-write path** (`src/server/runtime/claude-runtime.ts` `runLeakGateForRepo`). Independently reproduced by execution, not static reading. The dashboard commit path (`src/server/git.ts`) is NOT affected.
- **Provider caveat — NOT cross-provider.** OpenAI (the only provider whose OS sandbox executes code headlessly) was still in `[quota-window]` at ~02:04 ("try again at 2:50 AM") — a fresh `dispatch --provider openai` failed `[quota-window]` (run `01a0ea42-c926-7733-990e-885d5a964e86`). Per the dispatch charter I fell back to `--provider anthropic` (same provider as the fixer and this lane), which is a WEAKER independent check for a HOLDS verdict but conclusive here because the break was reproduced by execution. A first anthropic run was crippled (no `--allow-tools`, so its headless `claude -p` refused all Bash); the conclusive run added `--allow-tools "Bash Read Write Edit Grep Glob"`.
- **Verified-by:** provider=anthropic, run id `92014f65-cb47-4bf7-af0a-7ab41934781b` (transcript under dataDir/transcripts; also earlier crippled run `dac41e62-3309-4c76-8ef9-f5642ee2f89e` and the openai quota-failed run above). Clean room = rsync of the working tree (tracked+untracked, FEAT-156 changes included) with CLAUDE.md/AGENTS.md/.claude/docs/bugs/docs/prompts/docs/CONVENTIONS.md removed and git-init'd so repo-mode `git rev-parse --show-toplevel` resolves (c6 self-checkout detection needs a real repo — a non-repo clean room false-fails c6). The verifier's charter carried the requirement + diff + how-to-run + the fixer's test path, NOT the fixer's report or this ticket.
- **The break (reproduced).** `runLeakGateForRepo` runs the gate twice: working-tree mode (`--summary`) then `--staged`. Working-tree mode reads `.leakgate-allow` straight off disk (`fs.readFileSync`, leak-gate.mjs ~L127-128) with NO tracked/staged/ignored check, and scans untracked-not-ignored files (`git ls-files -co --exclude-standard`). So for the `git add f.txt && git commit` shape (the exact case the working-tree pre-run exists to catch): an UNCOMMITTED, even `.git/info/exclude`-hidden `.leakgate-allow` waives a foreign private-project token in `f.txt`; the `--staged` run sees 0 files (nothing staged yet) and passes; `runLeakGateForRepo` returns `ok=true`; the commit lands the foreign token. The code's own comment ("the allowlist that governs a COMMIT is the one being committed") is violated on this path. Credentials/identity still cannot be waived — this leaks project/CLIENT NAMES only, which is exactly the class FEAT-104/FEAT-049 exist to stop, and the agent is the in-scope threat actor for this guard.
  - Repro: registered repo dir=OWN; `.git/info/exclude` lists `.leakgate-allow`; allowlist = `token:<foreign project label> because: <10+ chars>`; `f.txt` contains the foreign project's name → `runLeakGateForRepo(repo)` returns `ok=true`; `git add f.txt && git commit` commits the token. Verifier's script: `/tmp/adv156.*/adv.mjs`.
  - **Suggested fix (verifier's):** in `runLeakGateForRepo`, make the working-tree pre-run ignore `.leakgate-allow`, or honour only the staged/HEAD copy.
- **What HELD (executed):** own name waived + counted + reported in own repo (file + commit message); every OTHER project token, home path, and own-name-in-a-different-repo still FAIL; symlink-alias, folder/registry path mismatch, uppercase own name, own+foreign on one line all behave correctly; malformed/non-JSON/object-`projects` registry fail closed to NO waiver; credential/identity/`match:`-secret/reasonless allowlist entries all refused exit 2; own+key+conn-string on one line → only the word waived, secrets stay (exit 1); `--own-project` cannot be injected by a caller (both wrappers read only the registry; TREE mode refuses the flag exit 2); ran-line + list sha256 + host banner + FAIL footer all present. Author test re-run: working tree 39/0, `npx tsc --noEmit` exit 0; `--baseline` rebuilt (a977e76 absent in clean room, reverse-applied the diff) → 13 passed / 19 failed as expected.
- **Minor notes (not breaks):** `in:**/**` and `*/**` are accepted although bare `**`/`**/*` are refused (cosmetic — equals omitting `in:`); a relative `hostPath` in the registry is resolved vs the server cwd and can grant a waiver (edge); ran-line prints `~`-relative not absolute paths under `$HOME` (deliberate, host banner carries the absolute path); a registered name+dir `A-B` waives both A and B (by design, registry+folder controlled, reported). Unicode NFD/homoglyph own names match no token at all (pre-existing ASCII-regex blind spot, not introduced here).
- **Could-not-test:** the git-shim `/api/git-shim/decide` route end-to-end through the live service (calls the same `runLeakGateForRepo`, so same expectation); whether the live service also installs a real pre-commit hook in target repos that might catch case A afterward (fixtures use `core.hooksPath=/dev/null` as the author's do — but `runLeakGateForRepo` itself already returned `ok=true`, so the guard is defeated regardless); cross-provider (OpenAI) confirmation; registry writes racing live `writeAtomic`.
- **Routing:** back to FIXING. This is a security/commit-gate regression-prone path; after the fix, an independent clean-room re-verify is again warranted (ideally cross-provider once OpenAI quota is back).

### 2026-09-29 — agent (worker, round 2) — fix: only the git-index copy of the allowlist ever counts

- **Understood:** the clean-room verify is right. The round-1 working-tree mode read `.leakgate-allow` straight off disk. The agent pre-exec guard (`runLeakGateForRepo`) runs that mode before anything is staged, so an untracked allowlist hidden via `.git/info/exclude` could waive a foreign project's name for `git add f && git commit`, and the `--staged` pass then saw nothing. regressed-from: FEAT-156 round 1 (my own round-1 design).
- **Decision: every repo mode reads the INDEX copy, with `git show :.leakgate-allow` (stage 0, regular file only). The disk file is never read.** Rejected alternative: working-tree mode ignores the allowlist entirely. That would refuse a legitimately committed allowlist in the pre-exec guard for every `git add f && git commit`, and it would make the two modes disagree about the same reviewed file. The index copy is HEAD's copy, or the staged one when the commit changes it. So it is either already committed or about to be, and in the second case the staged-mode pass prints its entries for approval. Untracked, ignored, conflicted, symlinked, or locally edited-but-unstaged allowlists are ignored, with a note (a local edit shows as "differs from the index — the INDEX copy governs"). TREE mode is unchanged (ignored).
- **Changed:** `scripts/leak-gate.mjs` (the allowlist loader and the footer's "and STAGE it" wording); `scripts/verify-feat-156-leak-gate-own-project.mjs` (new section X; d5 now expects the new "NOT in the index" wording). No host-wrapper change was needed: both wrappers inherit the fix from the gate.
- **Must-FAIL on round-1 code:** I ran the new suite from a scratch copy of the current tree with the round-1 files restored (`~/.local/state/claude-station/scratch/feat156-r1`): `44 passed, 5 failed`.
  - The failures that are the break: x1 (hidden untracked allowlist in working-tree mode, observed `exit 0`); x2 (agent guard, observed `ok=true`); x8 (unstaged widening of a committed allowlist, observed `exit 0`); x9 (agent guard for the same case, observed `ok=true`).
  - d5 fails there on message wording only; its exit code is the same.
  - x3, x4 and x10 (staged mode and dashboard) pass on round 1 as well, matching the verifier's finding that the dashboard path was not affected. They stay in as anti-regressions, along with x5–x7 (a staged allowlist still waives in working-tree mode, the agent guard and the dashboard commit).
- **After:** `FEAT-156 verify: 49 passed, 0 failed`. Pinned a977e76 baseline: `13 passed, 19 failed`, unchanged in shape (host and X cases only run against the working tree).
- **Anti-regressions:** verify-feat-130 171/0, verify-gatekeeper 31/0, verify-feat-089 35/0, verify-feat-108-git-grant 40/0, verify-feat-108-git-write-block 164/0, verify-feat-135 31/0, verify-feat-110 17/0, verify-feat-097 86/0; typecheck exit 0; `npm run gate` exit 0. Still red with the same pre-existing failures as round 1 (shown then to be identical without this change): verify-bug-173 27/1, verify-bug-184 27/1, verify-feat-049-licence, verify-feat-106 C2b.
- **Still open / handoff:**
  - An independent clean-room re-verify is required, cross-provider once OpenAI quota is back.
  - A related gap I found, which predates this ticket: working-tree mode enumerates files with `ls-files -co --exclude-standard`, so an IGNORED file force-added in the same command (`git add -f secret.txt && git commit`) is not scanned by the pre-exec pass. The commit-time `--staged` scans (dashboard and pre-commit hook) do catch it; the agent pre-exec guard does not. This is not introduced by FEAT-156 and I left it unfixed. It is worth its own ticket.

### 2026-09-29 — agent (verify lane, round 3) — cross-provider (OpenAI) verify: INCONCLUSIVE (could-not-execute — codex sandbox breaks Node→git; NOT quota, NOT a code defect)

- **Verdict: INCONCLUSIVE — the cross-provider (OpenAI/codex) verification COULD NOT BE EXECUTED.** This is neither HOLDS nor BROKEN for the code: no property was falsified, and none was confirmed by execution. The blocker is an infrastructure incompatibility, reproduced across three OpenAI dispatches plus a minimal probe.
- **Provider: OpenAI (codex), genuinely available** (`dispatch-client --check` → `openai dispatch: available`; codex sandbox preflight ok, codex-cli 0.158.0-alpha.15.2). This is the cross-provider run round 2 owed — NOT a quota fallback. Run ids (transcripts under `~/.local/share/claude-station/transcripts/openai/-tmp-feat156-r3-room/`): `01a0ed63-c055-7de3-887e-2513c3611261` (first attempt), `01a0ed66-a73d-7c50-af4d-ab1040b97b6a` (with the git-write hatch), `01a0ed69-d13d-7741-b6ce-ce0fd372aeee` (the definitive environment probe).
- **The blocker (definitively diagnosed by probe `01a0ed69`).** Under codex's `--sandbox workspace-write` OS sandbox, git RUNS but Node's `child_process` spawn of it reports EPERM anyway. Probe results, verbatim: (1) `bash -lc 'git --version'` → `git version 2.55.0`, exit 0; (2) `node execFileSync('git',...)` → THROWS `EPERM errno=-1 syscall=spawnSync git`; (3) `node spawnSync('git',['init',...])` → `{status:0, error:"spawnSync git EPERM"}` AND `created=true` (the `.git` WAS created); (4) even absolute `/usr/bin/git --version` via spawnSync → `status=0, out='git version 2.55.0', error=EPERM`. So the child executes and produces correct output/side-effects, but libuv surfaces EPERM on the spawn, and `execFileSync` throws on it. FEAT-156's gate (`leak-gate.mjs` `git rev-parse --show-toplevel`, `git show :.leakgate-allow`), the host resolver (`leak-gate-host.ts` `ownProjectNamesFor`, execFileSync in try/catch → catches EPERM → returns NO owner), and the author's whole test suite (`mkrepo` uses execFileSync git) ALL drive git through Node — so under codex every own-project/allowlist/identity-join path degrades to "no owner / test aborts", indistinguishable from a correct deny. The feature cannot be exercised at all. The verifier itself reached this conclusion ("Node reports a subprocess error despite Git's successful output; the host resolver catches such errors and returns no owner — that would invalidate identity-join conclusions") and correctly refused to bypass the git backstop or fabricate a verdict.
- **Environment I provided (so a re-run need not re-derive it).** Manual clean room `/tmp/feat156-r3-room` = rsync of the working tree (tracked+untracked, FEAT-156 changes included) minus the ambient/prose surface (CLAUDE.md, AGENTS.md, .claude, .codex, docs/bugs, docs/prompts, docs/CONVENTIONS.md, docs/analysis, at any depth), node_modules reflink-copied (never symlinked). The verifier's input was requirement (round-2 text + the round-2 "only the reviewed git copy counts" fix) + the FEAT-156 diff + how-to-run + the fixer's test file ONLY — not the fixer's report or this ticket. Dispatch: `npm run dispatch -- --provider openai --sandbox workspace-write --cwd <room>`, TMPDIR set inside the room, and `ORCHARD_ALLOW_GIT_WRITE=1` (the sanctioned FEAT-135 requirement-4 per-dispatch hatch, so codex-runtime skips installing the git-shim — the shim's host consult can't cross codex's network isolation and would fail-closed regardless). Attack list carried round 2's plus the new identity-join attacks (renamed folder, two projects sharing a folder name, hostPath parent/child of the repo, git worktree, case-folding). None could be executed for the reason above.
- **Why not fall back to anthropic:** the charter forbids it (two anthropic rounds already exist), and the point of round 3 was DECORRELATION. A third same-provider run would not be cross-provider.
- **Verified-by (this round): none** — an INCONCLUSIVE round issues no `Verified-by:` line (there is no HOLDS/BROKEN on the code to attest).
- **Verified-by (correcting the round-2 record's FORMAT so `board:status` can parse it — the prior line used `provider=…, run id …`, which `VERIFIED_BY_RE` in `scripts/lib/verdict-contract.mjs` does not match, so the board read `Verified-by: none`; this is an append, not an edit of the prior entry):**
- **Verified-by:** dispatch anthropic run 5dbd7d8d-c79a-4fe8-b95c-66e30242f61b — VERDICT: HOLDS (round-2 clean-room, SAME-provider; comprehensive executed matrix, zero breaks — see the round-2 entry above for the full record and its caveat).
- **Routing — needs orchestrator/user decision.** Cross-provider (OpenAI) confirmation is now shown INFEASIBLE on this feature with the current codex sandbox (Node→git EPERM), for a tooling reason unrelated to the code. The standing residual on this ticket ("cross-provider re-verify once OpenAI quota is back") cannot be satisfied by codex as-is. DECISION for the orchestrator: either (a) accept round-2's same-provider anthropic HOLDS as sufficient to mark FEAT-156 **VERIFIED** (given cross-provider is blocked by infrastructure, not by any doubt about the fix), or (b) hold VERIFIED pending a cross-provider path that does not route git through Node under codex (e.g. a codex danger-full-access dispatch — not exposed by `dispatch.mjs` today — or exercising the gate from bash rather than `execFileSync`). Status left unchanged (OPEN) pending that call. An independent clean-room verify at the SAME-provider level already stands (round 2); the gap is purely the cross-provider decorrelation.

### 2026-09-29 — agent (verify lane, round 4) — cross-provider (OpenAI) clean-room verify: BROKEN (real leak: a match: waiver hides a second spelling of the same foreign token)

- **Verdict: BROKEN.** The round-3 blocker is SOLVED: the cross-provider (OpenAI/codex) verifier ran the FULL matrix by EXECUTION with zero EPERM, because `scripts/independent-verify.mjs` executes every evidence command HARNESS-SIDE (outside the codex sandbox) via its `./vrun.mjs` file-spool recorder — git spawns run in the unsandboxed harness process, so `execFileSync git` never sees the `--sandbox workspace-write` EPERM that defeated round 3. This is the "openai works via vrun harness-side" mechanism. The verifier reproduced TWO defects on the REAL host API (raw gate, `runLeakGateForRepo` agent guard, `git.ts` dashboard `commit`), and I independently re-confirmed the primary one at the source against the live working-tree token list.
- **BREAK (property: per-hit allowlist discipline / "a different hit on the same line still FAILS" — a real foreign-name leak).** A `match:<value>` allowlist entry, meant to waive ONLY that exact spelling, in practice waives a DIFFERENT, unapproved spelling of the SAME project token when both appear on one line. Root cause: `scanLine` (scripts/lib/leak-tokens.mjs:542) does `s.match(t.re)` WITHOUT the `g` flag, so it records only the FIRST match of each token per line. Some project tokens are NON-LITERAL (e.g. a `[_-]` character class matching two distinct spellings — underscore vs hyphen), so the two spellings are DISTINCT values. With the approved spelling prepended, the single recorded hit's `.match` equals the approved value → `allowlistEntryFor` waives it (its `e.match === hit.match` check passes) → the line's only recorded hit is cleared → the unapproved spelling was never recorded as its own hit and rides through uncaught. Executed result: raw gate exit 0, agent guard `ok=true`, dashboard `committed` — a foreign private project name commits. This is exactly the round-1 review point 2 ("per label = first match per token per line") that the round-1 build REBUTTED on the assumption "for a literal token every occurrence has the same matched text"; the assumption is FALSE for the `[_-]` tokens, which the cross-provider pass found and the two same-provider anthropic rounds (both HOLDS) missed. regressed-from: FEAT-156 round 1 (the per-label-first-match design + its rebuttal).
  - Independent re-confirmation (this lane, against the REAL working-tree `scripts/lib/leak-tokens.mjs` at the repo root, no clean room, values derived at runtime from the token regex, never written): `scanLine(approved + ' and ' + unapproved)` records exactly 1 hit whose value is the approved spelling; a `parseAllowlist('match:<approved> because: …')` entry waives it via `allowlistEntryFor`; the unapproved spelling is present in the line yet never recorded as a hit → LEAK CONFIRMED true. Script: /tmp/feat156-r4-confirm.mjs (deleted at cleanup).
  - Suggested fix: `scanLine` must iterate ALL matches of each token per line (matchAll with the `g` flag, dedupe by matched value) so every distinct spelling becomes its own hit and a `match:` waiver covers only the value it names.
- **Second finding (property: own-project exemption — SAFE-side over-restriction, not a leak).** An EXACTLY-registered project (host-resolved, owners=1) whose git-toplevel basename does NOT match its private token is REFUSED the own-project waiver on raw gate + agent guard + dashboard ("waivable: none — a project token is waived only when it matches BOTH the registered name and this repo directory"); renaming the folder to contain the token flips identical staged content to PASS. So the own-project exemption is gated by a directory-basename VETO (round-1 design point 1, deliberate). This re-breaks the reported bug for any registered project whose folder is named something other than its private token. It weakens usefulness, not security (false-negative, never a leak). DECISION for the orchestrator: keep the basename veto (accept that neutral-folder projects still can't commit their own name) or drop it (round-1 rejected full-match because real names carry stem suffixes — the association should be registry realpath join, not basename).
- **Not a defect (clean-room artifact):** the fixer suite scored 48/1 in the room — the one FAIL is c6 ("own-project refused inside the gate's own checkout"), which depends on the room being recognised as the Orchard checkout; the git-init'd clean room is not, so c6 mis-expects. Matches prior rounds' 49/0 in a correctly-recognised tree. Not a real regression.
- **Could-not-test (carried forward):** the full E–O adversarial matrix beyond the two reproduced defects — conflicted/unmerged allowlists, linked git worktrees, case-folding/relative/symlinked hostPath registry variants, submodule allowlists — the verifier stopped after two breaks; identity-join attacks K/M/N/O were not exhausted. The git-shim `/api/git-shim/decide` HTTP route end-to-end through the LIVE service (the guard function `runLeakGateForRepo` WAS exercised). Diff-noise caveat: the working tree carries ~84 unrelated in-flight changed files (other lanes' uncommitted work incl. git-write-policy/git-grant/runtime.ts); the room used `--working-tree` (matching rounds 2–3 whose rsync'd rooms also carried the full dirty tree), so the verifier's diff was noisy, but the runtime attacks exercise only FEAT-156's 7 files' behavior and the ticket/board/methodology were stripped.
- **Verified-by:** dispatch openai run 01a0ed77-316d-7040-8541-ab7abaa52b6e (clean-room, scripts/independent-verify.mjs) — VERDICT: BROKEN
- **Routing — back to FIXING.** Primary: fix `scanLine` first-match-only so `match:` waivers cannot hide a second spelling of the same token (security-class; a real foreign-name leak on the agent + dashboard commit paths). Secondary: orchestrator decision on the basename-veto over-restriction. After the fix, re-verify cross-provider (the vrun harness path now works, so round 3's INCONCLUSIVE tooling blocker no longer applies).

### 2026-09-29 — agent (worker, round 3) — fix: every occurrence on a line is its own hit (no first-match anywhere)

- **Understood — the round-4 entry, confirmed before building.** The defect is first-match PER TOKEN, not first-match per line. `scanLine` ran `s.match(t.re)` without `g`, so each token was ONE hit per line, taken on its first occurrence. Different tokens were already judged independently, so "own name then foreign token" (and the reverse) was never the leak — s2/s3 below pass on round-2 code too. The leak was a token whose regex admits two spellings (a `[_-]` class): a `match:` waiver for the approved spelling cleared the line's single recorded hit, and the second spelling never became a hit. regressed-from: FEAT-156 round 1 (I rebutted review point 2 on the false premise that a literal token always matches the same text).
- **Same pattern elsewhere — found and fixed.** In `scanSecrets`, the KEY_SHAPES loop and the connection-string check also took only the first match. A guard-rejected placeholder key (or a placeholder password) earlier on a line therefore hid a real key (or a real connection-string password) later on the same line. That is a pre-existing FEAT-130 recall hole on every scan path, not only the waiver path (s6/s7). `valueMatchesKnownShape` had the same shape. Already correct: assignments and emails (`matchAll`) and `scanKeyShapes` (iterates, skips placeholders). The waiver functions are per hit: `ALLOWED_HITS` / `allowedHitFor`, the own-project set and `allowlistEntryFor` all take one hit at a time and none of them stops the loop. They were only ever as coarse as the hits the scanner produced.
- **Changed:** `scripts/lib/leak-tokens.mjs` — a new `distinctMatches(re, s)` (every match via a `g`-flag copy, deduped by matched value) now used by `scanLine` (TOKENS), the `scanSecrets` KEY_SHAPES and connection-string checks, and `valueMatchesKnownShape`. No `s.match(` / `.exec(` is left in the leak-gate modules. `scripts/verify-feat-156-leak-gate-own-project.mjs` — new section (s) plus host cases hs1/hs2. Needles are derived at runtime: the two spellings are built from the token's own `[_-]` source, and the suite fails loudly if no such token exists.
- **Must-FAIL on round-2 code** (scratch copy of the current tree with round-2 `leak-gate.mjs` + `leak-tokens.mjs`, `~/.local/state/claude-station/scratch/feat156-r2`): `52 passed, 9 failed`.
  - s0 (the two spellings recorded as `1 hit`)
  - s1/s1b (the verifier's repro, gate `exit 0`)
  - hs1 (agent guard `ok=true`) and hs2 (dashboard `NOT refused (committed)`)
  - s6/s7 (placeholder before real key / connection string, `exit 0`)
  - x5/x6: knock-on only. hs2 had actually committed the leaked line, so the later working-tree scans saw it.
  - s1c, s2–s5 pass on round 2 as well and stay in as anti-regressions: the approved spelling alone is still waived; own-then-foreign, foreign-then-own, allowlisted-next-to-foreign and five-hits-on-one-line each fail exactly the foreign and home-path hits.
- **After:** `FEAT-156 verify: 61 passed, 0 failed`. Pinned a977e76 baseline: `15 passed, 27 failed`.
- **Anti-regressions:** verify-feat-130 171/0, verify-gatekeeper 31/0, verify-feat-089 35/0, verify-feat-108-git-grant 52/0, verify-feat-108-git-write-block 177/0 (counts rose from other lanes' work), verify-feat-135 31/0, verify-feat-110 17/0, verify-feat-097 86/0, verify-feat-106 4/0 (now green, from another lane's fix); typecheck exit 0; `npm run gate` exit 0. Still red with the same pre-existing failures as rounds 1–2: verify-leak-write-guard 15/1, verify-feat-049-licence, verify-bug-173 27/1, verify-bug-184 27/1.
- **Still open / handoff:**
  - **Orchestrator decision (from round 4's second finding):** keep or drop the directory-basename veto on the own-project exemption. Keeping it means a registered project whose folder does not contain its token still cannot commit its own name. Dropping it makes the registry realpath join the only condition, which re-opens round-1 review point 1 (self-grant by renaming a project over the local API). Not changed here.
  - A cross-provider clean-room re-verify is required.
  - The force-added ignored file gap from round 2 is still unfiled.

### 2026-09-29 — agent (verify lane, round 5) — cross-provider (OpenAI) clean-room re-verify of the round-3 fix: BROKEN (real credential leak: an overlapping placeholder connection-string hides a real one)

- **Verdict: BROKEN.** Same mechanism (`scripts/independent-verify.mjs`, `--working-tree`, OpenAI/codex verifier, every evidence command executed HARNESS-SIDE through `./vrun.mjs` — zero EPERM) that round 4 used successfully. Reused round 4's requirement text + attack list A–O and added attack **P** (per-occurrence independence: multiple spellings on one line, placeholder-then-real credentials on one line, OVERLAPPING matches, repeated tokens with one `in:`-glob allowlisted, very long lines). Also re-ran round 4's own break repro (the `[_-]` two-spelling `match:` waiver) — that one is now CLOSED (suite section d/s passes). The verifier found a DISTINCT, still-open occurrence-independence leak the round-3 fix did NOT close.
- **BREAK (property: per-hit / per-occurrence independence for CREDENTIALS — a real live-credential leak, security class).** An OVERLAPPING placeholder connection-string hides a real connection-string password on the SAME line. Line shape (synthetic, no real secret): `postgres://u:password@mysql://u:<realpw>@h2/db`. The round-3 fix routes the connection-string scan through `distinctMatches(CONN_STRING, s)`, which relies on `String.matchAll` — and `matchAll` finds only NON-OVERLAPPING matches, advancing `lastIndex` past each full match. `CONN_STRING`'s greedy tail `@[^\s/'"]+` makes the first (placeholder `password`) match consume up to `…@mysql:`; that match is skipped by `CONN_PLACEHOLDER`, but `lastIndex` is now past the real URL's `://` scheme, so the real credential (`<realpw>`) is never matched and never recorded. Executed on the REAL host API in the clean room: raw gate `--summary` exit 0, `--staged` exit 0, agent guard `runLeakGateForRepo` `ok=true`, dashboard `commit` → committed `0da5394` with the live credential, ZERO waivers printed. regressed-from: FEAT-156 round 3 (the `distinctMatches`/`matchAll` fix explicitly claimed to close placeholder-then-real connection strings s6/s7 — it closes the SPACE-SEPARATED/non-overlapping variant but leaves the OVERLAPPING variant open; `matchAll` cannot find overlapping matches).
  - **Independent source re-confirmation (this lane, against the REAL working-tree `scripts/lib/leak-tokens.mjs`, no clean room, synthetic random connection-string shapes only):** `scanSecrets('mysql://u:<realpw>@h2/db')` records the `connection string password` hit; `scanSecrets('postgres://u:password@mysql://u:<realpw>@h2/db')` records `[]` — the real credential is hidden. Script: /tmp/feat156-r5-confirm.mjs (deleted at cleanup). LEAK CONFIRMED true.
  - **Suggested fix:** the connection-string (and any greedy-tail) scan must not lose an overlapping real credential when an earlier placeholder match is skipped — e.g. after skipping a placeholder match, resume the search from just after that match's password position (not its full end), or scan for the real password independently of the placeholder-consumed span. `matchAll`'s non-overlapping semantics are the root cause wherever a match's tail can swallow the start of the next credential.
- **Not a defect (clean-room artifact, carried from round 4):** fixer suite scored 60 passed / 1 failed in the room — the one FAIL is c6 ("own-project refused inside the gate's own checkout"), which needs the room recognised as the Orchard checkout; the clean room is not, so c6 mis-expects. Matches prior rounds. Not a real regression.
- **Could-not-test (carried forward):** the remaining attack-P variants beyond the reproduced credential bypass — long-line / PEM / binary-SVG occurrence attacks, overlapping TOKEN (project-name) spellings, repeated tokens with one `in:`-glob allowlisted; and the full E–O identity-join / allowlist matrix (verifier stopped after one confirmed credential break). The git-shim `/api/git-shim/decide` HTTP route end-to-end through the LIVE service (the guard function `runLeakGateForRepo` WAS exercised).
- **Verified-by:** dispatch openai run 01a0ed84-4a79-7822-997d-58f98296c34c (clean-room, scripts/independent-verify.mjs) — VERDICT: BROKEN
- **Routing — back to FIXING.** Fix the overlapping-match credential leak in the connection-string scan (and audit every `distinctMatches` greedy-tail regex for the same `matchAll` non-overlapping hole). This is a live-credential leak on the agent + dashboard commit paths — high-stakes; after the fix, re-verify cross-provider. Status left unchanged (BROKEN issues no verified state).

### 2026-09-29 — agent (worker, round 4) — fix: candidates at every start position, one matcher for every scanner

- **Understood (confirmed from the round-5 entry before building).** Round 3's `distinctMatches` relied on `matchAll`, which is non-overlapping: it resumes at the END of each match. A candidate that was then skipped (a placeholder password) had already consumed text that could start another candidate. The greedy tail of the connection-string pattern swallowed the real URL's scheme, so the real credential was never a candidate. regressed-from: FEAT-156 round 3.
- **Design (the family, not the regex).** A new `scanAll(re, s, accept)` in `scripts/lib/leak-tokens.mjs` is now the ONLY way any scanner there finds matches:
  1. **Candidates at every start position.** After any match the search resumes at `match.index + 1`, never at its end, so no candidate — recorded, skipped or later waived — can consume the start of another.
  2. **Each candidate judged alone** by the scanner's own `accept` predicate (guard, placeholder, allowed-email).
  3. **Only two kinds of candidate are dropped:** duplicates by value, and pure sub-spans of an ACCEPTED candidate of the same pattern — text literally inside a hit already reported, so any waiver of that hit covered the text verbatim. A rejected candidate shadows nothing.
  - Per start position the engine yields its preferred (greedy) match. Every guard here is monotone in span length (a longer match from the same start contains every high-entropy chunk of a shorter one), so the preferred match is the strictest one to judge.
  - The sub-span filter is O(k): candidates arrive in increasing start order, so "inside" means "ends no later than the furthest end so far".
- **Audit — every pattern in `leak-tokens.mjs` and `leak-gate.mjs`, and its verdict:**
  - **Moved to `scanAll` (these find hits, so the family applied):**
    - TOKENS: every private-project, client and identity token.
    - The KEY_SHAPES in `scanSecrets`, `scanKeyShapes` and `valueMatchesKnownShape`: sk-, gh*_, AKIA/ASIA, xox, PEM, Bearer, AIza, stripe, github_pat, SG., npm_, pypi, jwt.
    - `ASSIGN_DOTENV`, `ASSIGN_QUOTED`, `ASSIGN_BARE`, `ASSIGN_GENERIC_BARE`, `ASSIGN_GENERIC_QUOTED`, `CONN_STRING`, `EMAIL_RE`.
    - `scanBinary` and `scanIdentity` go through those scanners, so they inherit the fix.
  - **Not affected — these are predicates over one already-isolated value, path or name, so nothing can be hidden:** `STRUCTURAL_PLACEHOLDER`, `PLACEHOLDER_WORD_ANY`, `CODE_REF`, `CONN_PLACEHOLDER`, `NOREPLY_IDENTITY_RE`, `ALLOWED_HITS[].line` (tested against the whole line, and it waives one label only), `ownProjectTokens` (tests the registered name / folder), `globToRegExp` (a path), `IMG_RE` and `BIN_SKIP_RE` (paths), the allowlist key parser `keyRe` (structure of our own file), and the `git ls-files -s` record parsers in `leak-gate.mjs` (git's own fixed format).
  - No `s.match(` / `matchAll` / `.exec(` is left on any scan path. The only matchAll left is the allowlist key parser.
- **Must-FAIL on round-3 code** (scratch copy of the current tree with the round-3 `leak-tokens.mjs`, `~/.local/state/claude-station/scratch/feat156-r3`): `65 passed, 8 failed`.
  - **o1 (a decoy never changes a verdict, tested against a neutral prefix):** 4 hidden, all connection strings after the placeholder URL.
  - **o1b (every class caught with any separator):** 3 missed.
  - **o2/o2b (the verifier's repro):** gate exited 0 in both modes.
  - **o5/o5b (184 KB line, 3999 overlapping decoys):** real credential missed, gate exited 0.
  - **ho1/ho2:** agent guard returned `ok=true`; dashboard reported `NOT refused (committed)`.
  - **Pass on round 3 too, kept as anti-regressions:**
    - o3/o3b: glued token spellings are each recorded, and a `match:` waiver for one does not clear the other.
    - o4: repeated token; occurrences under the `in:` glob are waived, the ones outside FAIL.
    - o6: a PEM block glued to a placeholder connection string still FAILS.
  - The other 15 credential classes cannot be hidden by an earlier skip, because none of their patterns can start inside a skipped match. They are all in o1/o1b regardless.
- **After:** `FEAT-156 verify: 73 passed, 0 failed`. Pinned a977e76 baseline: `17 passed, 35 failed`.
- **The gate caught my own fixture.** A first draft of the credential table wrote a quoted `…password': <var>` key, which `ASSIGN_BARE` flagged on the whole-repo gate. Rewritten as a computed key, and the gate is green.
- **Word-boundary finding (pre-existing, not this family, left alone).** A key glued directly to preceding alphanumeric text (`…comAKIA…`) is not matched, because most KEY_SHAPES start with `\b`. o1 proves the decoy is irrelevant there: the verdict matches a neutral prefix ending in the same character. Loosening those anchors is a FEAT-130 precision decision, not part of this fix.
- **Performance (the gate is not slower on real text):**
  - Realistic 4.38 MB source concatenation: round 3 1191 ms, now 954 ms.
  - A real 1.21 MB bundle (longest line 348,816 chars): 44 ms, now 43 ms.
  - Whole-repo gate (1191 files): 5536 ms, now 4417 ms.
  - 0.42 MB line of 20,000 overlapping connection-string decoys: 9 ms, now 12 ms.
  - Pathological worst case: a 40 KB email local part of 20,000 dotted segments costs 612 ms, now 1552 ms. That pattern was already quadratic in the regex engine; per-start enumeration multiplies it by about 2.5. It would take a single pathological line of hundreds of KB to cost seconds.
- **Anti-regressions:** verify-feat-130 171/0, verify-gatekeeper 31/0, verify-feat-089 35/0, verify-feat-108-git-grant 52/0, verify-feat-108-git-write-block 177/0, verify-feat-135 31/0, verify-feat-110 17/0, verify-feat-097 86/0, verify-feat-106 4/0; typecheck exit 0; `npm run gate` exit 0. The same pre-existing reds as earlier rounds: verify-leak-write-guard 15/1, verify-feat-049-licence, verify-bug-173 27/1, verify-bug-184 27/1.
- **Decision recorded (orchestrator, 2026-09-29): KEEP the directory-basename veto.** The own-project waiver still requires the token to match BOTH the registered name and the repo folder's basename. It fails closed, and dropping it would reopen the rename-to-waive attack (round-1 review point 1). The consequence is accepted: a registered project whose folder does not carry its private name still cannot commit that name.
- **Still open / handoff:** a cross-provider clean-room re-verify is required. The ignored-file force-add gap in the agent pre-exec guard (round 2) is still unfiled.

### 2026-09-29 — agent (verify lane, round 6) — cross-provider (OpenAI) clean-room re-verify of the round-4 fix (scanAll): INCONCLUSIVE (could-not-execute — OpenAI quota-window exhausted mid-matrix; NOT quota-preflight, NOT a code defect)

- **Verdict: INCONCLUSIVE.** Same mechanism as round 5 (`scripts/independent-verify.mjs`, `--working-tree`, OpenAI/codex verifier, evidence executed HARNESS-SIDE through `./vrun.mjs`), fresh clean room `cleanroom-verify-pznJhZ`, fresh working-tree snapshot (tree 006092b5c9e9), fresh diff (97/148 paths). The dispatch ran and the verifier began the matrix, but the OpenAI account hit its usage-limit window MID-RUN ("try again at 9:21 PM"), so `independent-verify.mjs` returned VERDICT-CONTRACT: INVALID (exit 3) — the dispatch itself failed, so nothing is attested. This is an infra/quota stop, not a HOLDS/BROKEN on the code, and not the round-3 codex-sandbox EPERM blocker (the vrun harness path worked; codex sandbox preflight OK; git spawns ran unsandboxed).
- **Requirement aimed at the new mechanism (round-4 fix `scanAll`), fixer prose NOT passed to the verifier.** Reused round 4's requirement + attack list A–O, kept round 5's attack P (per-occurrence independence, incl. overlapping/consuming placeholder), and ADDED: attack Q (de-duplication / SUB-SPAN CONTAINMENT — whether a waived/accepted hit that positionally CONTAINS a distinct real credential/token suppresses it; cross-pattern containment; duplicate-by-value collision) and attack R (TIME BOMB / resource exhaustion — a pathological line that makes the gate hang/crash/OOM/timeout, and the FAIL DIRECTION on both host paths). Instruction: run the WHOLE matrix, do not stop at the first break, report EVERY break. Requirement file was /tmp/feat156-r6-req.txt (deleted at cleanup).
- **Partial, NON-attested observations before the quota stop (informational only — the harness discarded the run as INVALID, so these are NOT a verdict and carry NO `Verified-by`):** the fixer suite re-ran at 72 passed / 1 failed — the 1 FAIL is the known clean-room artifact c6 (own-project refusal needs the room recognised as the Orchard checkout; the git-init'd room has no `.git`, so c6 mis-expects), consistent with rounds 4–5. The verifier had built time-bomb (`adversarial-resources.mjs`) and occurrence/containment (`adversarial-feat156.mjs`) fixtures but never produced a recorded citation-block verdict.
- **Lane source-read of the TIME-BOMB fail direction (evidence iii, source only — NOT a clean-room attestation):** both host wrappers fail CLOSED on a gate timeout. `src/server/git.ts` runs the gate via `execFileSync(..., { timeout: 60_000 })` and its `catch` returns `{ ok: false }`; `runLeakGateForRepo` in `src/server/runtime/claude-runtime.ts` uses `execFileSync(..., { timeout: 30_000 })` and its `catch` returns `{ ok: false }`. A SIGTERM on timeout terminates even a busy synchronous regex loop, so a time-bomb line refuses the commit rather than allowing it. The raw CLI gate has no timeout (a user just waits) — no host bypass. This wants CLEAN-ROOM confirmation once quota returns.
- **Verified-by (this round): none** — an INCONCLUSIVE (could-not-execute) round issues no `Verified-by:` line; there is no HOLDS/BROKEN on the code to attest.
- **Routing — RE-DISPATCH round 6 cross-provider once the OpenAI quota window resets (stated reset ~9:21 PM in the account's timezone).** Do NOT fall back to anthropic (cross-provider decorrelation is the whole point, and two anthropic rounds already exist). Status left unchanged (INCONCLUSIVE sets no verified state).

### 2026-09-29 — agent (verify lane, round 6b) — SAME-provider (Anthropic claude-opus-5-5) clean-room re-verify of the round-4 fix (scanAll): HOLDS (whole matrix, zero breaks) — cross-provider OpenAI round STILL OWED

- **Verdict: HOLDS.** Run now (OpenAI capped until ~21:21) as a fresh ANTHROPIC clean-room verifier, same mechanism as round 2 (`scripts/independent-verify.mjs`, `--working-tree`, strongest model `claude-opus-5-5`, evidence executed HARNESS-SIDE). Fresh clean room `cleanroom-verify-5zZuNH`, fresh snapshot (tree ab91497a1614), fresh diff (98/150 paths). SAME-provider ⇒ decorrelation reduced — this does NOT discharge the owed cross-provider (OpenAI) round; it finds any break hours earlier.
- **Whole matrix run without stopping — zero breaks.** Fixer suite `73 passed, 0 failed` (c6 now PASSES: the verifier `git init`'d the working copy so it is recognised as a repo — the c6 FAIL in rounds 4/5 was purely the git-init'd-room artifact, now confirmed as such). Two adversarial batches, both manifest-backed: `ADV156: 54 hold, 0 break` and `ADV156b: 13 hold, 0 break`.
  - **Round-5 repro (overlapping/consuming placeholder connection-string) — now CAUGHT** (P1: 150-decoy run + glue + real credential lines, 0 missed). **Round-4 repro (two-spelling `[_-]` `match:` waiver) — CAUGHT** (hs2 dashboard refuses).
  - **Attack Q (dedup / SUB-SPAN CONTAINMENT) — HOLDS.** (q1) an email span enveloping two project tokens → all three hits reported; a bearer span enveloping an `sk-` key → key still reported; (q2) a project token INSIDE a connection-string password → BOTH reported; cross-pattern key-after-token has the neutral-prefix verdict for every glue char; (q3) own name glued around a foreign token / home path → foreign/home still FAIL on raw+agent+dashboard; (q4) identical value twice still reported. No real hit is dropped by the containment filter.
  - **Attack R (time bomb / fail direction) — HOLDS, fails CLOSED on both host paths.** Raw gate on an 80 KB bomb → exit 1 (6.2 s). Agent guard `runLeakGateForRepo` on a 300 KB dotted-email bomb (+ foreign token + live key) → `ok=false`, `timedOut=true` at the 30 s cap. Dashboard `commit` → `committed=false`, `timedOut=true` at the 60 s cap, NO commit landed. Confirms this lane's round-6 source-read: `execFileSync` timeout → catch → `ok:false` on both wrappers.
  - **Full E–O identity-join + allowlist matrix — HOLDS.** Symlink/directory/gitlink/conflicted/skip-worktree/assume-unchanged allowlists ignored; hidden info/exclude allowlist refused on all paths; subdir allowlist waives nothing; every credential/identity label + credential-shaped `match:` value refused (exit 2); caller-injected `--own-project` in a non-matching dir grants nothing; TREE+`--own-project` exit 2; trailing-slash/dot-segment duplicate + non-JSON/object/null/array/numeric registries → nothing waived; renamed folder / shared basename / parent-child hostPath / linked worktree / case-folded / relative hostPath → no false waiver; a project registered under the username cannot waive the username identity token.
- **Could-not-test (carried to the owed OpenAI round):** the REAL Orchard checkout + its live registered-project state (the room is git-init'd, not the real checkout); the git-shim `/api/git-shim/decide` HTTP route and the PreToolUse classifier that choose WHEN `runLeakGateForRepo` runs; the guard scans the session's configured `gitRepoPath`, not the repo a `git -C <other>` / `cd other && git commit` targets (cross-repo waiver on that route unverified); real submodules (only a subdirectory allowlist was tested); ignored-file force-add gap (older behaviour). **Note, not a break:** the scanner is quadratic on long dotted-email local-parts (~6 s at 80 KB, past both host caps at 300 KB) — a single crafted line blocks every commit, but FAILS CLOSED (DoS, not a leak).
- **Verified-by:** dispatch anthropic/claude-opus-5-5 run a97be22c-704c-4d8d-8553-d5adc6e79aa1 (clean-room, scripts/independent-verify.mjs) — VERDICT: HOLDS
- **Routing — Status NOT set to verified.** A cross-provider (OpenAI) clean-room round is STILL OWED (SAME-provider decorrelation is reduced); re-dispatch it once the OpenAI quota window resets (~21:21). This round HOLDS with zero breaks across the whole A–R matrix.
