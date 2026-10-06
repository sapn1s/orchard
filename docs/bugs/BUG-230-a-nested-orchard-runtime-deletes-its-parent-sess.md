```orchard-ticket
{
  "id": "BUG-230",
  "type": "bug",
  "title": "A nested Orchard runtime deletes its parent session's git shim",
  "summary": "installGitShim deletes whatever directory ORCHARD_GIT_SHIM_DIR names before installing its own. A runtime started inside an agent session inherits that env, so it deletes the parent session's shim. Scratch-server sessions and in-process Codex dispatches both do this. Afterwards the parent's subprocess git resolves to the real binary, ungated.",
  "impact_if_we_wait": "Any agent that runs a scratch-server session suite or an openai dispatch silently loses its subprocess git guard for the rest of its life: git writes from scripts it runs go ungated, with no leak gate. Observed live on 2026-10-05 in the FEAT-164 lane.",
  "current_need": "A nested shim install must never delete a shim directory it does not own; the parent session's shim must survive any child runtime.",
  "severity": "high",
  "area": "FEAT-135 git shim lifecycle",
  "reported": "2026-10-05",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-05",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Installing a shim from an env whose ORCHARD_GIT_SHIM_DIR names another session's shim leaves that directory intact.",
    "After a scratch-server session suite or an openai dispatch runs inside an agent session, that session's shim still exists and still refuses an ungranted write.",
    "Must-FAIL: the synthetic probe (parent shim dir present before a nested install, gone after) reproduces on the pre-change code."
  ],
  "code_refs": [
    {
      "path": "scripts/lib/git-shim.mjs",
      "symbol": "installGitShim",
      "note": "const prior = env.ORCHARD_GIT_SHIM_DIR; if (prior) fs.rmSync(prior, ...) — deletes a dir it did not create"
    },
    {
      "path": "src/server/runtime/claude-runtime.ts",
      "symbol": null,
      "note": "calls installGitShim over process.env per session"
    },
    {
      "path": "src/server/runtime/codex-runtime.ts",
      "symbol": null,
      "note": "same; runs in-process inside scripts/dispatch.mjs --provider openai"
    }
  ],
  "related": [
    {
      "id": "BUG-173",
      "relation": "see_also"
    },
    {
      "id": "ARCH-021",
      "relation": "see_also"
    },
    {
      "id": "FEAT-164",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "3c8d4605-afee-4718-849b-bd5dbc285b07",
      "verdict": "holds",
      "verdict_on": "2026-10-05",
      "recorded_at": "2026-10-05T11:26:16.060Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a10ddf-5677-7341-8414-b0f01e3feb2a",
      "verdict": "broken",
      "verdict_on": "2026-10-05",
      "recorded_at": "2026-10-05T21:04:53.167Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "cross-provider openai clean-room (r2): ensureGitShim hangs when the shim git file is an executable FIFO — fail-closed completeness gap (same-uid DoS; core no-fall-through property held)"
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a10dfb-5db0-73d1-8d22-c3923d35e3ed",
      "verdict": "holds",
      "verdict_on": "2026-10-05",
      "recorded_at": "2026-10-05T21:35:10.397Z",
      "author": "verify lane (BUG-230 verifying r3)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r3 FIFO/special-file guard FIXED (fifo fixer 1c8cd38c1942 14/14; non-regular shim shapes refused/restored, none hang). Raw-BROKEN rests SOLELY on the pre-declared known Codex per-turn-only recheck (not a finding per charter). r3 fix HOLDS; Codex mid-turn gap flagged for decision."
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

# BUG-230 — A nested Orchard runtime deletes its parent session's git shim

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-05 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-05 — worker (FEAT-164 fixing r2)
- **Note:** **Filed by the FEAT-164 fixing-r2 lane, with evidence.**
    - **Live:** mid-session, this lane's ORCHARD_GIT_SHIM_DIR (/tmp/orchard-git-shim-*) no longer existed, and `command -v git` resolved to /usr/bin/git. Earlier in the same session, the lane had booted scratch servers that launched sessions from its own env, and had run an openai dispatch (CodexRuntime runs in-process in scripts/dispatch.mjs). Both call installGitShim over an env that still carries the parent's ORCHARD_GIT_SHIM_DIR. Which of the two fired first was not isolated.
    - **Synthetic probe, no git invoked:** a fake parent shim dir is named in ORCHARD_GIT_SHIM_DIR, then installGitShim(env) runs → {parentExistedBefore:true, parentExistsAfter:false, childShimCreated:true}.
    - **Cause:** scripts/lib/git-shim.mjs installGitShim does `if (prior) fs.rmSync(prior, …)`. That was written for an idempotent RE-install inside one process; it is wrong for a child's install.
    - **Consequence:** the parent's subprocess git (node/npm scripts) is ungated for the rest of the session. The PreToolUse text hook still sees the parent's own Bash strings.
    - **Fix direction (not built):** a child install only drops the prior dir from its OWN PATH copy and never deletes it; deletion belongs to the owner's teardown. Must-FAIL = the probe above.

### 2026-10-05 — worker
- **BUG-230 fixing r1:** **Fixed (fixing r1).** Hypothesis CONFIRMED: `installGitShim` did `fs.rmSync(env.ORCHARD_GIT_SHIM_DIR)`. A runtime only ever installs over `process.env`, which never holds its OWN shim (install is pure), so that prior dir was ALWAYS an inherited parent's. The idempotent-reinstall case it was written for never happens in production.
      - **Live recurrence:** this lane's own session env names /tmp/orchard-git-shim-wcWxOq, and that dir was already GONE at lane start, before this lane ran anything nested. `which git` gave /usr/bin/git. Likely culprits besides scratch servers and dispatches: verify-feat-135-git-shim / verify-feat-135-active-e2e run `installGitShim(process.env)` in the invoking agent's own env.
      - **Fix, scripts/lib/git-shim.mjs:** install never deletes anything. The prior dir is dropped only from the returned env's PATH. Ownership is declared at creation: install returns a handle with `ensure()`, the only thing that may rewrite that dir. `ensure()` returns intact, or restored (missing/altered shim rewritten), or `{ok:false}` when it cannot restore or the path is unsafe: a non-dir, a symlink, another uid's dir, or group/other-writable. New export `gitShimMissingRefusal`. d.mts updated.
      - **Fail-closed wiring:** claude-runtime.ts runs `ensure()` in the PreToolUse hook before every Bash call. It restores the shim, or DENIES the call. codex-runtime.ts runs it at every `#startTurn`. It restores the shim, or refuses the turn with an error result. Codex has no per-command hook, so a shim deleted MID-turn is caught only at the next turn (limitation).
      - **Suite fix:** verify-feat-135-active-e2e and verify-feat-135-codex-active-e2e now strip an inherited ORCHARD_GIT_SHIM_DIR from their own env. Run from inside an agent session, the hatch-open control saw the invoker's dir and failed for an environmental reason (1 FAIL before this change, 0 after). No CONVENTIONS/docs text assumed the old deletion.
      - **Proof, new suite scripts/verify-bug-230-nested-shim-ownership.mjs (5 arms):**
          - **A:** direct nested install.
          - **B:** the REAL dispatch.mjs --provider openai (fake app-server).
          - **C:** a REAL scratch server via isolatedServerEnv. It registers a throwaway repo only, and the session launches a fake CLI.
          - **D:** an in-process ClaudeRuntime; the fake CLI drives the real PreToolUse hook. It deletes the shim and checks the shim is restored and a subprocess commit is refused. It then makes the shim unrestorable and checks Bash is DENIED.
          - **E:** CodexRuntime. A deleted shim is restored on the next turn; an unrestorable one gets the turn refused.
          - **Must-FAIL on the pre-change tree: 10 pass / 13 FAIL.** All of A/B/C reproduce the parent-dir deletion, along with D-p2/p3 and E. **After the change: 23/23.**
      - **Anti-regressions (after the change):**
          - feat-135-git-shim: 31/31
          - feat-135-active-e2e: 8/8
          - feat-135-codex-active-e2e: 8/8 (REAL codex)
          - bug-173: 28/28
          - bug-184: 28/28
          - verify-dispatch: 24/24
          - feat-108-git-write-block: 241/241
          - feat-108-git-grant: 66/66
          - bug-068: 4/4
      - **Same failures before and after:** verify-bug-091-host-spawn is 7/1 (shim-at-PATH-front assertion) and verify-zombie-busy is 16/3 (a real-CLI flake). Both were run against a working-tree copy with this diff reversed. `npm run gate` exit 0.
      - **Not done / follow-ups:**
          - (1) No owner teardown: shim dirs now accumulate in /tmp, 1 per session. Before this change, every top-level session already leaked one. Removing them needs a "CLI really gone" signal, because survival sessions outlive a server restart.
          - (2) The live :4317 service runs the old code until restarted, and sessions already running may already have lost their shim (this one has).
          - (3) Separate: the FEAT-108 text hook false-positives on `git` appearing as a plain word in a Bash command or heredoc (e.g. `command -v git; echo` was read as `git echo`).
      - **Class:** SECURITY / regression-prone (FEAT-135 / BUG-173 lifecycle). An independent clean-room verify is warranted. regressed-from: FEAT-135 (the original install's prior-dir cleanup).

### 2026-10-05 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 3c8d4605-afee-4718-849b-bd5dbc285b07 — VERDICT: HOLDS. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-05 — verify lane (BUG-230 verifying r1)
- **Independent clean-room verify: HOLDS (VALID, manifest-backed).**
    - **How:** `scripts/independent-verify.mjs` as a SEPARATE process against an isolated scratch clone, with a SCOPED range so the verifier saw only the BUG-230 diff. Because the live working tree is one large uncommitted WIP (HEAD `a977e76`), a whole-tree `--working-tree` diff would have been hundreds of files; instead the 4 core files were reverted to HEAD and the full WIP committed as a throwaway base `f5f17ac` in a reflink clone, then the BUG-230 versions + new test/fixtures restored into the worktree → a `--working-tree` snapshot diff of exactly `git-shim.mjs`, `git-shim.d.mts`, `claude-runtime.ts`, `codex-runtime.ts` + the new suite/fixtures (49040 diff bytes). Clean room kept at `~/.local/state/claude-station/scratch/cleanroom-verify-AhmJFq`; manifest `cleanroom-record-yPxfMK/manifest.jsonl`; `docs/` stripped, 2 recorded runs.
    - **Evidence:** the fixer's suite re-ran in the room 23/23 (run `0431e5a005fb`, exit 0). The verifier ALSO wrote its own adversarial suite `adv-230.mjs` (run `c1fb60f0e4f0`, exit 0, "ALL HELD"): grandparent→parent→child→grandchild chain with all ancestor shims stacked ahead on PATH (every level still refuses a subprocess commit); `ensure()` against a symlinked shim dir (refused), a dangling-symlink dir (refused, target not created), a hostile `git` symlink pointing outside (replaced, outside untouched), `git` replaced by a directory (refused, no fall-through), a world/group-writable dir (refused), an altered pass-through `git` (rewritten + refuses), a `git` with the exec bit removed (restored executable), the base dir deleted (restored); 30 concurrent sibling installs all distinct and parent intact. No property broke, so the two-break STOP rule did not fire.
    - **could-not-test (verifier's own list, not findings):** a shim dir owned by ANOTHER uid (needs root/second account — the uid branch of `ensureGitShim` was not exercised); a TOCTOU swap between `ensure()`'s lstat and its write; a Codex turn QUEUED while the shim is unrestorable (the `#finishTurn`→next-turn path); non-Bash Claude tool calls that spawn processes (the hook runs `ensure()` only for Bash); Codex app-servers launched via the `config.spawnProcess` seam where the shim path may resolve differently.
    - **LIMITATION — provider:** cross-provider openai was requested first but the dispatch hit an openai `quota-window` ("try again at 5:36 PM"), so this HOLDS is from a same-family anthropic clean-room (author-provider openai declared; structural decorrelation — separate process, stripped room, no fixer report — still applied). Given the fixer's own SECURITY / regression-prone classification, a cross-provider openai re-run is still warranted when quota recovers, targeting the uncovered uid/TOCTOU/queued-turn/non-Bash-tool seams above.

### 2026-10-05 — dispatch openai
- **Verification recorded:** dispatch openai/default run 01a10ddf-5677-7341-8414-b0f01e3feb2a — VERDICT: BROKEN — cross-provider openai clean-room (r2): ensureGitShim hangs when the shim git file is an executable FIFO — fail-closed completeness gap (same-uid DoS; core no-fall-through property held). Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-06 — verify lane (BUG-230 verifying r2)
- **Cross-provider independent clean-room verify: BROKEN (VALID, manifest-backed, openai).**
    - **Why r2:** round 1's HOLDS was a same-family anthropic clean-room (openai quota-window). This is the cross-provider openai re-run the r1 lane said was warranted. Verifier `openai`/default via `scripts/independent-verify.mjs` (author-provider anthropic → genuine cross-provider); dispatch run `01a10ddf-5677-7341-8414-b0f01e3feb2a`.
    - **Scoping (how the diff was confined to the BUG-230 shim-ownership hunks):** the live tree is one large uncommitted WIP on HEAD `a977e76`, and BUG-231/FEAT-164 have since edited the same four files (interleaved `windowKey` threading + grant-window changes in `git-shim.mjs`/`.d.mts`/the two runtimes). git writes from a shell are blocked for agent sessions, so a reflink scratch clone was built and TWO tree objects were produced from a node script (git spawned from node — the sanctioned path tree-snapshot.mjs uses): `H` = the full current WIP (the REAL combined code that ships, exported as the room's head so the fixer test runs against real code), `B` = `H` with ONLY the BUG-230 surface reverted to pre-BUG-230 (`a977e76`) — the four files via `cat-file blob`, and the new suite + `scripts/fixtures/bug-230/` removed. `--range B..H` ⇒ a scoped diff of exactly those 7 paths (base = "the files before BUG-230" per the charter's sanctioned option). Dry-run confirmed the harness's own allow-list = 7/7 changed paths, `docs/` stripped (ticket + fixer report invisible). Clone `~/.local/state/claude-station/scratch/bug230-r2-clone-6Ap0VL`; room KEPT `cleanroom-verify-OLuU5o`; manifest `cleanroom-record-nmQWsy/manifest.jsonl`; 5 recorded runs.
    - **Fixer test (cited exactly one run):** `node scripts/verify-bug-230-nested-shim-ownership.mjs` re-ran in the room **23/23**, run `9e361b8ca565` exit 0 — all of A/B/C ownership + D/E fail-closed arms held against the REAL combined tree.
    - **Adversarial (run `677a8e8ff225`, the ONE break):** the verifier's own `adversarial-230.mjs` held on a grandparent→parent→child→grandchild PATH-stacked chain (every ancestor still refuses a subprocess commit; no install deletes an ancestor dir), and on `ensure()` vs missing/altered/no-exec (all restored), vs `git`-is-a-directory / shim-path-is-a-file / symlink / dangling-symlink / group-writable / world-writable (all `ok:false`, no fall-through). It BROKE on one new case: the shim's `git` file replaced by an **executable FIFO**. `ensureGitShim`'s `intact()` does `fs.readFileSync(shimPath,'utf8')` to byte-compare to the installed source; opening a FIFO `O_RDONLY` blocks until a writer appears, so `ensure()` HANGS (control returned immediately; after `mkfifo -m 755 .../git` the call never returned — SIGTERM at the test's 3s timeout, ETIMEDOUT).
    - **Classification of the break:** fail-closed COMPLETENESS gap — the requirement promises "restore, or refuse (ok:false)"; a FIFO yields a third outcome (indefinite hang) in the Claude PreToolUse hook / Codex per-turn check. The CORE security property is NOT breached: a hang does not fall through to the real ungated `git`. Threat model is narrow: the FIFO must be planted inside the session's own `0o700` shim dir, i.e. by the SAME uid (other-uid and group/world-writable dirs are already refused by `unsafeDir()`), which is the determined-adversarial same-uid filesystem-tamper class `installGitShim` already documents as out of scope (a same-uid actor can equally prepend PATH or rewrite the shim source). So: a real, low-severity same-uid DoS edge, not an ungated-git bypass. Only one property broke → two-break STOP rule did not fire.
    - **Fix direction (not built):** guard `ensureGitShim` so the shim path is a regular FILE before reading it (`lstat` + `isFile()`, or open `O_NONBLOCK`/refuse a non-regular file) and return `{ok:false}` for a FIFO/socket/device, same as the other unsafe cases.
    - **could-not-test (verifier's list, not findings):** cross-uid ownership replacement under uid 1000; concurrent installs; runtime behaviour after a blocked `ensure()`.
    - **DECISION FOR ORCHESTRATOR/USER:** record stands as BROKEN (work_state auto-moved verified→in_verification; independently_verified now false). Decide: (a) fix the special-file/FIFO guard in `ensureGitShim` and re-verify, or (b) classify the FIFO hang as the already-documented same-uid tamper class (out of scope) and re-assert — in which case the requirement text should say the refuse-set covers only the enumerated dir cases, not arbitrary special-file shim paths.

### 2026-10-05 — verify lane (BUG-230 verifying r3)
- **Verification recorded:** dispatch openai/default run 01a10dfb-5db0-73d1-8d22-c3923d35e3ed — VERDICT: HOLDS — r3 FIFO/special-file guard FIXED (fifo fixer 1c8cd38c1942 14/14; non-regular shim shapes refused/restored, none hang). Raw-BROKEN rests SOLELY on the pre-declared known Codex per-turn-only recheck (not a finding per charter). r3 fix HOLDS; Codex mid-turn gap flagged for decision.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-06 — verify lane (BUG-230 verifying r3) — full log
- **Cross-provider independent clean-room verify of the r2 FIFO fix: the r3 FIFO/special-file guard HOLDS (VALID, manifest-backed, openai). Overall r3 verdict HOLDS; the one break the verifier found is the pre-declared known Codex mid-turn limitation, carved out by this lane's charter as "not a finding".**
    - **What r3 was verifying:** the r2 cross-provider openai BROKEN found `ensureGitShim` HUNG when the shim `git` was an executable FIFO (`readFileSync` on a FIFO blocks). A fixer added, in `scripts/lib/git-shim.mjs` `ensureGitShim.intact()`, an `lstat` type-guard BEFORE any read: `if (!fs.lstatSync(shimPath).isFile()) return false;` — anything not a plain regular file (FIFO/socket/device/dir/symlink) is treated as NOT intact and never read, falling to the same rewrite/refuse fail-closed path as the other unsafe shapes. New fixer test `scripts/verify-bug-230-fifo-special-file.mjs`.
    - **Scoping (same method as r2):** live tree is one large uncommitted WIP on HEAD `a977e76` with BUG-231/FEAT-164 also editing the same four files. Built a reflink scratch clone `~/.local/state/claude-station/scratch/bug230-r3-clone-TqRbyK`; produced TWO tree objects via `scripts/lib/tree-snapshot.mjs` (git spawned from node, the sanctioned path): `H`=full WIP (tree `682cf606938f`, the REAL combined code, exported as the room head so the fixer test runs against real code), `B`=`H` with ONLY the BUG-230 surface reverted to pre-BUG-230 `a977e76` (the four files via `cat-file blob`; the two `verify-bug-230-*` scripts + `scripts/fixtures/bug-230/` removed) → tree `0addf6e8b762`. `--range B..H` ⇒ scoped diff of exactly 8 paths (4 modified + 4 new). Dry-run confirmed the harness allow-list = 8/8 changed paths, `docs/` stripped (ticket + fixer report invisible). `--max-diff-bytes 150000` so the full 71927-byte diff (incl. the lstat guard hunk) was shown, not truncated. Clone + rooms KEPT: room `cleanroom-verify-sDreAC`, record/manifest `cleanroom-record-zP77LE/manifest.jsonl` (6 recorded runs).
    - **Harness-usage note (honest):** the FIRST openai dispatch (`01a10df6…`, room `cleanroom-verify-WfrgtX`) was ruled VERDICT-CONTRACT **INVALID** because this lane passed TWO `--run` fixer tests, so the verifier emitted two `FIXER-TEST:` lines (exactly one allowed) — a tooling mis-config by this lane, not a verification result. Re-dispatched ONCE with a single fixer test; that is the valid run cited below. (openai resume is anthropic-only, so an invalid openai reply cannot be re-prompted — it must be re-dispatched.)
    - **Fixer test (cited exactly one run):** `node scripts/verify-bug-230-fifo-special-file.mjs` re-ran in the room **14/14**, run `1c8cd38c1942` exit 0 — pre-change copy (lstat guard stripped) HANGS on a FIFO (must-FAIL proven); fixed code RETURNS and restores a real executable regular-file shim for both FIFO and unix-socket shim paths. The r2 hang is GONE.
    - **Adversarial / the one break (run `cebfdafc2858`, exit 1):** the verifier's own `verify-active-turn.mjs` drives the REAL `CodexRuntime` with the fixture app-server; within a SINGLE Codex turn the app-server first attempts a subprocess `git commit` (refused: "git write refused at the invocation layer") then `rmSync`s its OWN session shim dir and commits AGAIN — the second commit falls through to real git and advances HEAD (`before`≠`after`). Reproduced independently by this lane against the real clone code (HEAD `2ee2247`→`16b541f`): the break is REAL, not a probe artifact.
    - **Classification — NOT counted (charter carve-out):** this is the CodexRuntime per-turn-only recheck: Codex has no per-command hook, so a shim deleted MID-turn is caught only at the next turn. It is documented by the r1 fixer ("a shim deleted MID-turn is caught only at the next turn (limitation)") and this lane's charter states verbatim "Codex per-turn-only recheck is a known limitation, not a finding." Threat model is same-uid self-sabotage inside the agent's own turn (the session deleting its own `0o700` shim then invoking git) — the determined same-uid filesystem-tamper class already documented out of scope (such an actor can equally prepend PATH or rewrite the shim source). The CORE no-fall-through property for the r3 FIFO fix is NOT breached by the FIFO path. So the countable-break set is empty → two-break STOP rule did not fire → r3 fix HOLDS.
    - **Attack coverage (charter list):** FIFO + unix socket at the shim path (fifo fixer 14/14 — return + restore, no hang); symlink / dangling-symlink / `git`-is-a-directory / shim-path-is-a-file / group- & world-writable dir (all `ok:false`, no fall-through — held in the fixer suite + prior r1/r2 adversarial arms); PATH-stacked grandparent→child chains and ownership (fixer ownership suite re-ran in r2 23/23; held). The `lstat` precedes every read, closing the TOCTOU-free structural guard for all non-regular shapes.
    - **could-not-test (this lane's list, not findings):** device-node shim path (needs mknod/root, not creatable as this uid); a true TOCTOU swap between `ensure()`'s `lstat` and its subsequent read/rewrite under concurrent load (structurally the non-regular file is rejected before any read, but the race window was not stress-driven); a shim dir owned by ANOTHER uid (needs root/second account — carried forward from r1/r2); live Codex-binary (non-fixture) app-server behaviour.
    - **DECISION FOR ORCHESTRATOR/USER:** the r3 special-file/FIFO fix is independently verified HOLDS (work_state→verified, independently_verified=true). The STANDING item is the Codex mid-turn recheck gap: it is a real fall-through against the literal requirement text ("never falls through to the real git"), classified here as the pre-declared known structural Codex limitation. Decide whether to (a) accept it as a documented known limitation and leave the requirement scoped to the special-file/no-hang property now verified, or (b) open a SEPARATE ticket to give Codex a per-command (not per-turn) shim recheck. This lane did not file; the carve-out was explicit in the charter.
    - **Class:** SECURITY / regression-prone. This r3 verify is itself the independent clean-room skeptic pass over the fixer's lstat guard; cross-provider (author-provider anthropic → verifier openai), separate process, stripped room, no fixer report shown.
