```orchard-ticket
{
  "id": "FEAT-108",
  "type": "feature",
  "title": "Deny git writes from agent sessions (orchestrator and lane)",
  "summary": "A dispatched lane committed a ticket carrying home paths, a username and a private project name; the leak gate caught all 7 but runs advisory at commit time, so main went red anyway. This denies every git WRITE from any agent session (orchestrator and lane) on the PreToolUse callback, deny-by-default over git's own command inventory, with a visible escape hatch.",
  "impact_if_we_wait": "Any agent can commit a home path, username or private project name into a public repo's history, which costs a full rewrite of main. The leak gate cannot prevent it because it runs advisory at commit time.",
  "current_need": "Block git writes from agent sessions fleet-wide, keep read-only git working, catch the shell evasions that can be caught and honestly list those that cannot, and leave the user's own terminal untouched.",
  "severity": "high",
  "area": "Runtime enforcement (scripts/lib/git-write-policy.mjs, src/server/runtime/claude-runtime.ts)",
  "reported": "2026-08-26",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-26",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Every git WRITE (commit/add/push/reset/restore/stash/rm/mv/tag/amend/merge/rebase/config-set/remote-add/branch-create) from an agent Bash call is denied",
    "Read-only git (status, log, diff, show, rev-parse, branch --show-current, stash list, config --get) still works",
    "The block applies to lanes too (BUG-155 was a lane), independent of the orchestrator-profile flag",
    "Deny-by-default derived from git's --list-cmds inventory: unknown/future subcommands and git-internal aliases are writes",
    "Named evasions caught (git -C, --git-dir=, -c, chained, sh -c, eval, env, xargs, substitution); honest gap list for interpreters/wrappers",
    "Escape hatch ORCHARD_ALLOW_GIT_WRITE=1 re-enables for one dispatch and is announced on stderr, not silent",
    "The user's own terminal git is untouched: a real shell commit succeeds while the same string denies through the hook"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-155",
      "relation": "recurrence_of"
    },
    {
      "id": "FEAT-096",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
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

# FEAT-108 — Deny git writes from agent sessions (orchestrator and lane)

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-26 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-26 — worker (fixing, round 1)
- **Understood:** No agent — orchestrator or lane, in any project Orchard launches —
  should perform a git write; the user does all git by hand ("unless instructed
  otherwise"). BUG-155 was the trigger: a LANE committed a ticket carrying private
  paths, the leak gate detected all 7 but is advisory AT commit time (an enforcement
  gap, not a detection gap). A charter line had already failed. The existing FEAT-096
  in-process PreToolUse callback in claude-runtime.ts is the only enforcement point
  that carries agent_id and holds under bypassPermissions, so the block rides it.
- **Changed (unstaged — the user commits by hand):**
  - `scripts/lib/git-write-policy.mjs` (NEW): `decideGitWrite`, `gitWriteBlockEnabled`,
    `gitWriteRefusal`; deny-by-default over a closed read-allowlist derived from git's
    own `--list-cmds` inventory; dual-mode read predicates; a quote-aware tokenizer that
    reaches into `sh -c`/`eval`/`env`/`xargs`/command-substitution and past git global
    options (`-C`, `--git-dir=`, `-c`).
  - `src/server/runtime/claude-runtime.ts`: wire the block into the SAME PreToolUse
    callback, running FIRST and FLEET-WIDE (every session, not gated by
    orchestratorProfile); a one-time stderr announce when the escape hatch is open.
  - `scripts/verify-feat-108-git-write-block.mjs` (NEW) + `package.json` script.
- **Verified:** `npm run verify:git-write-block` → PASS 163/0/0. Non-vacuity pinned:
  the pre-change classifier ALLOWED `git commit`/`git add` and `decide()` exempts a
  lane (the BUG-155 shape). Driven, not asserted: a real shell `git commit` in a
  throwaway repo SUCCEEDS while the same string DENIES through the hook replica (pinned
  textually to the runtime wiring). Evasions caught and known gaps (python -c/node -e/
  wrapper scripts/shell aliases) asserted open. `npm run gate` → exit 0.
- **Deny set derived from:** git's own `git --list-cmds=main,others,builtins` (184
  cmds): the READ allowlist is the closed set, everything else (124 writes + unknown +
  future + git-internal aliases) denies. The verify enumerates the real inventory and
  asserts every non-read command denies.
- **Escape hatch:** `ORCHARD_ALLOW_GIT_WRITE=1` (or true/yes/on) re-enables git writes
  for a dispatch; the runtime warns "[orchard] git-write block DISABLED …" on stderr.
- **Scope:** FLEET-WIDE for every session ClaudeRuntime launches (host-side callback,
  works for container projects too); no per-project config or hook-file copy. A bare
  `claude` a user starts by hand in a terminal is out of scope by design — that is the
  user at the keyboard, not an Orchard-launched agent.
- **Concurrency note (race hit live):** another lane owns FEAT-107 (diff-size) and was
  mutating the shared tree; it reverted my first `claude-runtime.ts` edit mid-flight
  (my untracked files and my `package.json` line survived). Re-applied and renumbered
  107→108. The runtime edit could be clobbered again by an in-place race — the exact
  wiring is recorded here and in the verify PINs so it can be re-applied.
- **Still open / handoff:** HIGH-STAKES (session-lifecycle enforcement, regression-prone
  file) — warrants an independent clean-room verify pass before VERIFIED; self-verified
  suite is not the last word. Known evasion gaps (interpreters shelling out, wrapper
  scripts, shell aliases) are documented, not closed — a follow-up could scan `-c`
  payloads of `python`/`node`/`perl` if the cost is judged worth it.

### 2026-08-28 — worker (fixing, round 2)
- **Request:** the user (verbatim) — "regarding doing git commits, pls change that there
  is some way for orchestrator to invoke or through subagent, to allow git commands, as
  it depends per time/project." Round-1's only lift was the LAUNCH-time env var, so a
  mid-session "please commit" needed a relaunch. Round 2 makes git writes grantable at
  RUNTIME, per project, revocable, with no relaunch — and keeps the leak gate mandatory.
- **Design (weighed, not taken as an order):** adopted the ticket's own framing — the real
  protection is the LEAK GATE, not the prohibition. A permitted commit/push is not waved
  through; it still runs `scripts/leak-gate.mjs` over the repo and is REFUSED on any hit
  (or if the gate can't be run — fail-closed). So even a forged grant cannot land the leak
  this ticket exists to prevent; the block relaxes to a convenience, the gate stays load-bearing.
- **Self-grant defence (the two named holes, closed structurally):** the grant lives ONLY
  in the host server process's MEMORY (`scripts/lib/git-grant-store.mjs`). (1) ENV VAR: the
  decision runs in the host process and reads the HOST env + host store; an agent's Bash
  exporting `ORCHARD_ALLOW_GIT_WRITE=1` only touches its child's env and the leading
  assignment is stripped by the tokenizer → still denied. (2) WRITING CONFIG: the store is
  never read back from the registry or any on-disk file, so an agent writing a "grant" into
  config grants nothing. Cross-project/subagent bleed is closed by keying on project id.
  RESIDUAL (stated honestly): the server is localhost + "no auth tier — deliberately out of
  scope", so a DIRECT session's Bash could curl the grant route just as the browser can —
  that vector is NOT closed here, it is neutralised by the mandatory gate + full visibility.
  Container sessions cannot reach the host loopback at all.
- **Changed (unstaged — the user commits by hand):**
  - `scripts/lib/git-grant-store.mjs` (+`.d.mts`, NEW): host-memory grant store (once /
    duration, TTL-bounded, revocable) + a bounded write ledger + an injectable audit sink.
  - `scripts/lib/git-grant.mjs` (+`.d.mts`, NEW): `evaluateGitWrite` — folds grant lookup
    and the mandatory publish-time leak gate onto round-1's `decideGitWrite`.
  - `scripts/lib/git-write-policy.mjs` (+`.d.mts`): new `gitWriteGateFailedRefusal`; the
    plain refusal now points at the runtime grant instead of "relaunch with the env var".
  - `src/server/runtime/{runtime.ts,claude-runtime.ts}`: per-CALL grant-aware decision
    (was captured once at start), the real leak-gate subprocess runner, one stderr line per
    permitted/gate-blocked agent git write.
  - `src/server/agent-bridge.ts`: pass project id + hostPath + session id to the runtime.
  - `src/server/index.ts`: `GET/POST/DELETE /api/projects/:id/git-write-grant`; a
    `gitWriteGrant` field per live session in `/api/health`; a durable audit log under the
    data dir (never the project repo).
  - `scripts/git-grant.mjs` (NEW): the user's CLI surface (`--once` / `--minutes N` /
    `--revoke` / `--status` / `--list`) — the primary surface, since the git dashboard panel
    is owned by another lane this round.
  - `scripts/verify-feat-108-git-grant.mjs` (NEW) + `package.json` script; three round-1
    verify PINs re-aimed at the new wiring, one refusal assertion updated.
- **Verified:** `npm run verify:git-grant` → PASS 40/0/0 (incl. the REAL leak gate over a
  leaking scratch repo → refused, and a clean one → allowed). `npm run verify:git-write-block`
  → PASS 164/0/0 (round-1 regressions). `npm run gate` → exit 0. Non-vacuity: round-1
  `decideGitWrite` denies a commit with no grant path at all; the grant flips the SAME command.
- **Not driven this round (honest gap):** the HTTP grant route was verified by textual PIN,
  not a booted-server round-trip (booting the full server in a verify script is fragile), and
  the dashboard button UI was left to the git-panel lane. HIGH-STAKES → an independent
  clean-room verify pass is still warranted before VERIFIED.

### 2026-08-28 — worker (fixing, round 3)
- **Correction (user, verbatim):** "buddy im not going into cli to run commands, we have
  orchard ui, also i was expecting to be able to ask orchestrator to allow push/commits and
  then u'd be able to achieve enable/disable and orchestrate when whether commit/push." Round 2
  built the grant with an HTTP route + a CLI as the surface — the WRONG surface. Round 3 adds
  the REQUEST → APPROVE flow IN THE UI: an agent asks, the user approves/declines with one
  click, the agent then does the git work. Round 2's grant store, decision path, audit log and
  gate enforcement are UNCHANGED and still load-bearing; this adds the request rail + the UI, it
  does not redesign the mechanism.
- **Request mechanism (reused the existing rail, did NOT invent a second surface):** an agent
  hits `POST /api/sessions/:sid/git-write-request { reason, scope?, minutes? }` (mirrors the
  FEAT-029 needs-you route: same dual session lookup, same `$ORCHARD_SESSION` the agent already
  carries). It raises a DECISION record carrying a `gitWrite` payload — i.e. it rides the SAME
  Needs-You rail the user already answers. It creates an INERT pending request and NOTHING else:
  no grant, ever.
- **Approval surfaces on the Needs-You rail** (justified: the user already lives there for
  decisions; a git-panel-only approval would split attention, and the rail already delivers the
  answer back to the raising session so the agent learns the outcome and proceeds). The card
  renders as a `🔑 git-write request` with the project, the requested scope/window and the
  agent's reason, and offers ONE-CLICK Allow / Decline (no free-text box — a grant is yes/no).
- **Self-approval prevented STRUCTURALLY:** the request route mints no grant; only the USER
  answering "Allow" on the board/answer route mints one (`grantedVia:'request-approval'`). So an
  agent hitting the agent-facing endpoint — the only surface added for agents — can raise pending
  requests all day and NONE becomes a grant. Proven live: 4 requests in a row → grant stays null;
  a grant appears only after the UI Allow. The pre-existing no-auth residual (a direct session's
  Bash can curl any localhost route, incl. the round-2 grant route) is NOT widened: folding the
  mint into the existing user-action answer route adds no new class of exposure, and the mandatory
  leak gate on every permitted commit/push still fails-closed regardless.
- **Direct toggle + visible state (git panel):** a header pill reads the state at a glance —
  green "● Agent git allowed · Nm left" with a Revoke, or grey "● Agent git blocked" with an
  "Allow agent git" (30-min window). Governs AGENT git only; the user's own commits through the
  panel go via the server git CLI and are never blocked. Read the branch-switch lane's uncommitted
  git-view.js first and kept strictly additive (a new `.gt-gitwrite` control, new `.gt-gw-*` CSS,
  three new api.js methods) — no collision with its `liveConfirmed`/`remoteRow`/publish hunks.
- **Changed (unstaged — the user commits by hand):**
  - `src/server/decisions.ts`: `GitWriteRequest` type + optional `gitWrite` on the decision record.
  - `src/server/board.ts`: optional `gitWrite` on `BoardItem` (the rail marker).
  - `src/server/index.ts`: the `git-write-request` route (raises an inert decision); the board feed
    carries the `gitWrite` marker; the answer route mints the grant ONLY on an "Allow" of a
    git-write decision (declines mint nothing; the leak gate stays untouched).
  - `public/lib/api.js`: `gitWriteGrant` / `grantGitWrite` / `revokeGitWrite`.
  - `public/lib/git-view.js` + `public/git-view.css`: the header permission pill + Allow/Revoke.
  - `public/app.js` + `public/styles.css`: the rail renders a git-write request as a one-click
    Allow/Decline permission card.
  - `scripts/verify-feat-108-git-request-approve.mjs` (NEW) + `package.json` script.
- **Verified:** `npm run verify:git-request-approve` → PASS 20/0/0 (stable, run ×3): drove the REAL
  flow in headless brave against a real booted server — agent requests → card on the rail (both
  themes) → user Allow → grant active (via GET route) → git-panel pill shows it → Revoke → gone →
  fresh request → Decline → no grant, card leaves the rail. Plus the in-process seam: an
  approval-minted grant still REFUSES a commit over a leaking scratch repo with the REAL
  leak-gate.mjs (fail-closed), allows over a clean one. MUST-FAIL: with the round-3 server code
  neutralised (request-route guard + board marker) 9 assertions fail — request-acceptance, marker,
  card-render, approval-mint, pill-state — while the controls (round-2 mechanism, inert-request,
  no-grant states) pass both sides. Regressions green: `verify:git-write-block` 164/0/0,
  `verify:git-grant` 40/0/0, `verify-git` 74/0, `verify-git-branch-switch` 20/0. `npm run gate` → exit 0.
  Screenshots read by hand, both themes + both pill states — clean, on-brand.
- **HIGH-STAKES (session-lifecycle / self-grant / regression-prone files):** an independent
  clean-room verify pass is still warranted before VERIFIED — this self-verified suite is not the
  last word. The pre-existing localhost no-auth residual is unchanged and stated, not closed.

### 2026-09-29 — clean-room verification (BROKEN, VALID)
- **Requirement (plain terms):** deny every agent git WRITE by default (closed
  read-allowlist from git's own inventory), catch named shell evasions and
  honestly list the rest, allow a user-approved memory-only runtime grant, and
  keep the leak gate MANDATORY + fail-closed on every granted commit/push; an
  agent cannot self-grant. Requirement written to a temp file, not fixer prose.
- **Strategy: CARRIER-TREE.** Fix commits (`d687709` r1/r2/r3) predate
  `src/server/seed-sources.mjs` (`ca672b9`), so a committed-range clean room
  refuses to boot. Built the room from the later bootable carrier `b11e71f`
  (carries seed-sources AND all three rounds' shipped code) and told the verifier
  the bundled diff is not the change under test — attack the source files and
  re-run the suites directly. A first run came back INVALID (verifier emitted two
  `FIXER-TEST:` lines; the executed-evidence contract allows exactly one). Re-ran
  with corrected citation instructions AND an explicit rule: prove every allow/deny
  by calling the real `decideGitWrite` / `evaluateGitWrite` and pasting the
  `{allow}` result, because the clean room's shell is UNGATED (no PreToolUse
  hook) so a raw command "succeeding" in the room proves nothing.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --range 3481e76..b11e71f --requirement @<req-file> --timeout-min 22 --verdict-out <verdict-file>`
- **Verdict: BROKEN — VALID.** `verify:git-write-block` 164/0 and `verify:git-grant`
  40/0 both re-ran green; the self-grant core all PASSED (agent request route is
  inert, repeated requests mint no grant, approval-minted grant + REAL leak gate
  refuses over a leaking repo / allows over a clean one, ENV-var forgery denied,
  disk-forgery denied). The verifier then broke it on cases the fixtures never
  covered, each confirmed against the real decision function:
  - **FINDING 1 (serious — defeats the ticket's central guarantee).** A granted
    compound `git add <f> && git commit -m x` (and `git add <f> && git push`)
    returns `{allow:true, granted:true, offender:"git add", gatePassed:null}` with
    **gateCalls:0** — the decision keys on the FIRST segment (`git add`, not a
    publish verb), so the MANDATORY leak gate is never run for the trailing
    commit/push. The whole round-2/3 promise ("a granted commit/push still runs
    the leak gate, fail-closed") is bypassable by chaining a non-publish write
    before the publish in one Bash string.
  - **FINDING 2.** `decideGitWrite` returns `{allow:true, offender:null}` (no
    grant needed) for branch creation via `bash -lc '…'`, a parenthesized
    subshell `(git branch …)`, `env -S "git branch …"`, and a git command placed
    after a heredoc body — each actually created the branch. The evasion tokenizer
    misses these forms (the ticket claimed `sh -c`/`env`/subshell/chained caught).
  - **FINDING 3.** `git interpret-trailers --in-place --trailer … <file>` is
    unconditionally allowed and modified a tracked file with no grant — a
    dual-mode/read-listed command that in this form is a write.
  - Two request-approve BROWSER assertions also failed (Decline button not
    clickable; declined request not leaving the feed), but the verifier notes the
    second card never rendered (30s timeout) — likely a clean-room timing/harness
    artifact, NOT confirmed as a product defect; the decline-mints-nothing and
    card-leaves-rail properties still passed.
- **Could-not-test (verifier):** real SDK PreToolUse hook enforcement (ungated
  room — used the decision functions directly instead); browser decline flow
  (second card never appeared).
- **Verified-by:** dispatch openai run 01a0ec10-59da-77d2-8be3-d9f41fb626c0
  (clean-room, carrier-tree, `scripts/independent-verify.mjs`) — VERDICT: BROKEN
- **Independent-verify note:** this is the security ticket's own subject matter;
  the finding was produced by a fresh cross-provider clean room, not the fixer's
  suite — generation did not verify itself. A confirming second clean-room pass on
  the eventual fix is warranted given the harm class.
- **Status:** stays OPEN. Handoff: (1) FINDING 1 is the priority — the
  publish-gate decision must inspect ALL write segments of a compound command, not
  just the first offender, so a chained `add && commit/push` cannot skip the gate.
  (2) Extend the tokenizer to `bash -lc`, parenthesized subshells, `env -S`, and
  post-heredoc commands (or re-classify them as uncatchable and DENY-by-default
  rather than allow). (3) Decide whether dual-mode commands like
  `interpret-trailers --in-place` should deny when a write-flag is present.

### 2026-09-29 — worker (fixing, round 4, class=plan+review) — PLAN (built below)
- **Reproduced all three findings against the REAL decision functions** (not a
  fixture) before touching code — `/tmp/f108-repro.mjs` calling `evaluateGitWrite`
  / `decideGitWrite`:
  - F1: `git add f && git commit -m x` (and `&& git push`) → `{allow:true,
    granted:true}` with **gateCalls:0**; the newline form `git add f\ngit commit`
    also 0; and the alias form `git -c alias.co=commit co` → 0. Root cause
    CONFIRMED: `evaluateGitWrite` keys the gate on the FIRST offender's subcommand
    (`git add`, non-publishing), so a publish chained AFTER a non-publish write
    skips the mandatory gate. (Chains where the FIRST git offender IS the publish —
    `echo;git commit`, `|`, `$()`, backticks, `sh -c`, `xargs git commit` — already
    gate; the hole is specifically a non-publish write in front.)
  - F2: `bash -lc '…'`, `(git branch …)`, `env -S "…"`, `env --split-string=…`, and
    a git command on a line AFTER a heredoc body all return `{allow:true,
    offender:null}` from `decideGitWrite` — the scanner never sees the write.
  - F3: `git interpret-trailers --in-place …` → allow:true (it is in `GIT_READONLY`).
- **The invariant this round enforces (verbatim target):** *any command line that
  can cause a git write, anywhere in it (chained, nested in a shell -c string, via
  env/exec wrappers, subshells, heredoc-trailing, or any write-capable subcommand),
  either runs the leak gate on the repo content OR is refused; anything the parser
  cannot fully decide is refused (fail closed).*
- **Design (not a patch list) — two moves, both fail-closed by the module's own
  deny-by-default philosophy (the READ set is closed, everything else denies):**
  1. **Gate every granted write that is not PROVABLY non-publishing.** Add a CLOSED
     allowlist `GATE_EXEMPT_WRITES` (local index/worktree/ref/config ops that cannot
     put repo content into history or a remote: add, rm, mv, reset, restore,
     checkout, switch, stash, clean, branch, tag, config, remote, notes,
     symbolic-ref, submodule, worktree, update-index, update-ref, sparse-checkout,
     reflog). The gate now runs on the granted path unless EVERY git write in the
     command is in that set. This is the exact analogue of `GIT_READONLY`: forgetting
     an entry only makes us STRICTER (over-gate, safe); a publish/alias/unknown/future
     verb is never exempt, so F1 (compound), the alias hole, and any future publish
     verb are closed by one rule — not enumerated. `PUBLISHING_SUBCOMMANDS` stays
     `{commit,push}` (unchanged; still owns the record's audit detail). Requires a
     new `collectGitWrites(command)` (all offenders, same traversal as
     `scanForGitWrite`, which becomes its first-hit wrapper — ARCH-010, one walker).
     Constraint honoured: granted `git add` with a failing/absent gate stays ALLOWED
     (git-grant:125, bug-173:250) because `add` is exempt.
  2. **Close the detection gaps in the ONE classifier** (`git-write-policy.mjs`):
     `bash -lc`/combined `-c` clusters (`/^-[a-z]*c(.*)$/`, trailing-or-next-arg code
     string); `(`/`)` as segment separators (subshells); `env -S`/`--split-string`
     value recursed as a command string (was skipped); heredoc handling rewritten to
     strip only the BODY (up to the terminator) and KEEP trailing commands, replacing
     the slice-off-everything-after-`<<`; and `interpret-trailers` moved out of
     `GIT_READONLY` into `GIT_DUAL_READ` (read form allowed, `--in-place` denied).
- **No runtime change needed / no collision.** Both `evaluateGitWrite` call sites
  (index.ts:2541 hook-mirror route, claude-runtime.ts:1110 PreToolUse) ALREADY pass
  `runLeakGate` unconditionally, so gating more writes needs no wiring change.
  `scripts/lib/git-write-policy.mjs` and `scripts/lib/git-grant.mjs` are both CLEAN
  in `git status`; the FEAT-156 edits sit only in claude-runtime.ts, which this fix
  does not touch. Files to change: those two `.mjs` (+ `.d.mts` if signatures shift)
  and the verify scripts. Leaving all unstaged.

### 2026-09-29 — worker (fixing, round 4, class=plan+review) — BUILT
- **Changed (all UNSTAGED — the user commits by hand):**
  - `scripts/lib/git-write-policy.mjs`: (a) `interpret-trailers` moved from
    `GIT_READONLY` to `GIT_DUAL_READ` — read form allowed, `--in-place` (write flag)
    denied (F3); (b) `(`/`)` added as segment separators so a subshell head isn't
    fused (F2 subshell); (c) heredoc handling replaced by `stripHeredocBodies`, which
    drops ONLY each body (opener line + everything after the terminator survive), so a
    write on a line AFTER the body is scanned (F2 heredoc-trailing); (d) the scanner
    refactored to ONE shared walker `walkGitWrites(cmd, depth, sink)` — `scanForGitWrite`
    is its first-hit wrapper and NEW `collectGitWrites` its collect-all wrapper (ARCH-010,
    one walker); the walker now descends `bash -lc`/combined `-c` clusters and `-cCMD`
    (F2 bash -lc) and recurses `env -S`/`--split-string`/attached `-S…` values (F2 env -S);
    (e) NEW closed `GATE_EXEMPT_WRITES` set (local index/worktree/ref/config ops).
  - `scripts/lib/git-grant.mjs`: `evaluateGitWrite` now computes `needsGate` over ALL
    writes (`collectGitWrites` on the command path; the lone `sub` on the argv/shim
    path) — the gate runs unless EVERY write is in `GATE_EXEMPT_WRITES`. Fixes F1
    (a publish chained after a non-publish write no longer skips the gate) AND the
    inline-alias hole (`git -c alias.x=commit x` → unknown sub → gates) with one rule.
    `PUBLISHING_SUBCOMMANDS` kept (audit continuity); record `gatePassed` now tracks
    whether the gate actually ran.
  - `scripts/lib/git-write-policy.d.mts`: declared `GATE_EXEMPT_WRITES`, `collectGitWrites`.
  - `scripts/verify-feat-108-git-write-block.mjs`, `scripts/verify-feat-108-git-grant.mjs`:
    added the round-4 must-FAIL/PASS-after cases (see below). No `package.json` change
    (both suites already wired) — avoids colliding with concurrent package.json edits.
- **No `src/server/runtime/claude-runtime.ts` change.** Both `evaluateGitWrite` call
  sites already pass `runLeakGate` unconditionally, so gating more writes needed no
  wiring change; the FEAT-156 hunk in that (dirty) file was not touched — no collision.
- **Reproduced BEFORE (real functions, `/tmp/f108-repro.mjs`):** F1 `git add f &&
  git commit`/`&& git push`/newline-form → gateCalls **0**; alias `git -c alias.co=commit
  co` → 0. F2 `bash -lc`, `(git branch …)`, `env -S`/`--split-string`, post-heredoc →
  `{allow:true,offender:null}`. F3 `--in-place` → allow. AFTER: F1 all gateCalls **1**;
  F2 all deny with the right offender; F3 `--in-place` denies, read form allowed.
- **Verified — PASS-after + must-FAIL, calling the real decision functions:**
  - `verify:git-write-block` → **177 passed, 0 failed** (was 164; +13: the round-4
    evasions in EVASIONS_CAUGHT, interpret-trailers dual-mode both ways, heredoc
    body-is-data control AND post-terminator catch).
  - `verify:git-grant` → **52 passed, 0 failed** (was 40; +12: gate-RUNS/gate-FAILS-refuses
    on `add&&commit`, `add&&push`, newline form, alias — via a call-counting gate; a
    SYNTHESIZED pre-fix "first-offender gate" MUST-FAIL leg (rot-proof, anchored to a
    constructed fn per CONVENTIONS, not HEAD) proving the old logic skipped the gate;
    and non-vacuity that a granted LONE `git add` still skips the gate — gateCalls 0).
  - Broad adversarial probe (`/tmp/f108-adv.mjs`, 21 further evasions I named): ALL
    deny with no grant — `{ git commit; }`, `time`/`command`/`nohup` heads, nested
    `sh -c`, `(((…)))`, `xargs -n1 git push`, `git -c alias.p=push p`, `env -C … git
    commit`, `env A=1 -S "git push"`, tab-separated `git\tcommit`, `<<-EOF` tab heredoc
    + trailing push, `bash --norc -c`, `env -Sgit\ push`; and the granted gate RUNS
    (gc=1) for every publish-hidden-deep case. `<(git commit)` process-substitution now
    denies too (it really runs git — a correct catch, not a false positive).
  - Anti-regression: `verify-feat-135-git-shim` **31/0**. `verify-bug-173` **27/1** and
    `verify-bug-184` **27/1** — the SINGLE failure in each is its `[must-FAIL]` leg that
    reads `git show HEAD:scripts/lib/*.mjs`; BUG-173/184 are already COMMITTED to HEAD, so
    "pre-fix" == fixed and the leg fails. This is the CONVENTIONS "must-FAIL anchored to a
    moving baseline (HEAD)" artifact — independent of this change (my edits are
    working-tree only; `git show HEAD` is unaffected), confirmed by reading the leg
    sources. No dedicated `verify-bug-172` exists (git-archive is covered by the
    write-block inventory leg, still green).
  - `npm run gate` → typecheck PASS, check-nul PASS; leak-gate FAIL on ONE FOREIGN
    untracked file, `scripts/_diag-b203.mjs` (a BUG-203 diagnostic left by another
    session, not in this lane's changed set — 2 home-path hits). None of this lane's 6
    files carry a leak; the gate passes once that foreign file is removed by its owner.
  - `npm run board:check` → OK, no drift (advisory stale-doc warnings only).
- **Honest residual gaps (unchanged from prior rounds, NOT closed — inherent):** a
  non-shell interpreter that shells out (`python -c`/`node -e`/`perl -e`), a wrapper
  SCRIPT that calls git, and a shell alias/function NOT named `git` remain allowed —
  they require interpreting an arbitrary language / reading an external file, which this
  command-string layer cannot; the FEAT-135 PATH shim is the backstop for the subprocess
  cases. One NEW parser residual: a `<<`-like sequence INSIDE a quoted string could be
  mis-read as a heredoc opener and drop following lines — this can only make us MISS a
  later write (never over-block), a rare shape; declined (would need full pre-tokenized
  quote tracking) and recorded here. `env -S` attached with no space AND no quotes on a
  multi-word command relies on the shell's own splitting; the common quoted/spaced forms
  are covered.
- **HIGH-STAKES (SECURITY, git-write enforcement, regression-prone files) — status
  stays OPEN.** This self-verified suite is NOT the last word; an independent
  cross-provider clean-room verify pass is WARRANTED before VERIFIED (the charter says
  one follows). A verifier should re-attack the granted gate path (compound/alias/nested
  publish → gate runs) and the F2 evasions against the REAL `decideGitWrite`/`evaluateGitWrite`
  in an UNGATED clean room, and re-run both extended suites.

### 2026-09-29 — clean-room verification (round 4, BROKEN, VALID)
- **What ran:** cross-provider (OpenAI) clean room over the round-4 WORKING TREE
  (`--working-tree`, fix uncommitted), attacking the REAL exported decision
  functions directly (ungated room, no PreToolUse hook) and re-running the
  fixer's own suites. Requirement written to a temp file (not fixer prose);
  citation contract example supplied filled-in.
- **Command (tilde form):** `node scripts/independent-verify.mjs --repo
  ~/projects/orchard --working-tree --requirement @<req> --run "node
  scripts/verify-feat-108-git-write-block.mjs" --run "node
  scripts/verify-feat-108-git-grant.mjs" --test-file … --timeout-min 22
  --verdict-out <verdict>`.
- **Verdict: BROKEN — VALID (manifest-backed, exit 1).** FIXER-TEST re-ran
  `verify:git-grant` → 52/0. The plain `git add f && git commit` compound now
  gates (`gateCalls:1`) — round-4's F1 fix HOLDS for that shape. But the
  verifier landed REAL commits in a scratch repo through several shapes the
  fix still misses, each paired with the real decision output:
  - **FINDING A (fail-open, defeats the central guarantee).** `exec git commit`,
    `nice git commit`, `git${IFS}commit`, `env -S git commit` (spaced form), and
    `bash -cl '…'` (reversed `-cl` flag cluster) all return
    `{allow:true, offender:null}` — the walker never sees the write, so with NO
    grant a real commit executes. Prepending `git add f;` makes the granted path
    return `{granted:true, gateCalls:0}` and the commit lands — the leak gate is
    skipped exactly as in round 3's F1, because `collectGitWrites` sees only the
    exempt `git add` and misses the wrapper-hidden publish.
  - **FINDING B (the fixer's ADMITTED heredoc residual is a REAL ungated write,
    not merely over-block).** `printf "%s\n" "<<X"⏎git commit --allow-empty`
    (a `<<X` inside a quoted string) is mis-parsed as a heredoc opener; the
    trailing `git commit` line is dropped → `{allow:true, offender:null}`, real
    commit landed with no grant; with a leading `git add f;` → `{granted:true,
    gateCalls:0}`, commit landed. The residual fails OPEN.
  - **Confirmed FIXED this round:** F2 forms the fixer targeted — `bash -lc`,
    `( git branch x )`, `env -S "…"` / `--split-string=…` / `env -Sgit\ commit`,
    `((( … )))`, post-heredoc trailing commit, `xargs -n1 git push`,
    `<(git commit)`, `command`/`time`/`nohup` heads, `/usr/bin/git`, `git -C`,
    `GIT_DIR=`/`GIT_WORK_TREE=` — all DENY correctly. F3 interpret-trailers:
    `--in-place` denies, read form allowed. Self-grant defences hold (inline +
    exported `ORCHARD_ALLOW_GIT_WRITE=1` and a planted on-disk grant all denied).
  - **Could-not-test / UNTESTED:** real SDK PreToolUse hook enforcement (ungated
    room — used the functions directly); browser request/approve flow (untouched
    this round). The BUG-173/184 moved-baseline claim could NOT be confirmed
    here — both `[must-FAIL]` legs `git show HEAD:…` and the clean room's
    snapshot has no `.git`, so they abort (status 128) rather than run; the
    fixer's "pre-existing HEAD artifact" reading is plausible but unverified by
    this pass.
- **Verified-by:** dispatch openai run 01a0ed5f-ef63-7330-8c01-951c26256482
  (clean-room, working-tree, `scripts/independent-verify.mjs`) — VERDICT: BROKEN
- **Status:** stays OPEN — priority (SECURITY, git-write enforcement). Handoff:
  (1) the walker must recognise `exec`/`nice` (and any wrapper) heads,
  `git${IFS}commit` / word-split `git`, `env -S` SPACED form, and the `-cl`
  (any-order combined-flag) cluster — or DENY-by-default anything it cannot fully
  tokenize, since every miss here is FAIL-OPEN. (2) The quoted-`<<` heredoc
  residual must be closed or made to fail CLOSED (deny on ambiguity), because it
  was proven to yield an ungated landed commit, not just over-block.
### 2026-09-29 — worker (fixing, round 5, class=fix) — FAIL-CLOSED head handling
- **Stepped back (5th round of one class).** Rounds 1-4 tried to ENUMERATE every
  shell/wrapper a git write can hide behind and SKIPPED any head they did not
  recognise — so each round the verifier named a new wrapper (`exec`, `nice`,
  `sudo`, `timeout`, `find -exec`, `git${IFS}commit`, `env -S` spaced, `bash -cl`)
  and a MISS was FAIL-OPEN: a real, ungated commit ran. That is a losing design.
  Round 5 flips the DEFAULT, per the coordinator's direction.
- **The invariant now enforced (stated in code on `classifyTokens`):** a Bash
  command is proven git-clean — and so ALLOWED past this policy — ONLY when every
  reachable `git` head classifies as a read/exempt AND no git write is reachable
  behind any wrapper, expansion or quoting the parser could not fully resolve. A
  command is proven clean for a head ONLY if that head does NOT execute its
  arguments as a command (`NON_RUNNER_HEADS` — echo/printf/grep/cat/man/ls/… , pure
  data sinks). EVERY other non-git head is treated as a possible command RUNNER: a
  bare `git` write in its tokens, a shell/env/eval/xargs it wraps, an
  expansion-obscured git head (`git${IFS}commit`), or a git-only subcommand standing
  as the head (`$(which git) commit`, real head expanded away) are all REFUSED.
  Anything git-writeish the parser cannot decide fails CLOSED. This closes the class:
  a wrapper nobody enumerated denies instead of leaking.
- **Why it closes the class (not just more forms):** the fail-open surface was
  "unknown head ⇒ skip ⇒ allow." It is now "unknown head ⇒ treat as runner ⇒ if any
  git write is reachable, deny." New wrappers require no code change to be caught.
- **What legitimate usage this NEWLY refuses (the accepted trade — over-block, not
  fail-open):** `<wrapper> git <write>` for ANY wrapper (`exec`/`nice`/`sudo`/
  `timeout`/`setsid`/`stdbuf`/`ionice`/`flock`/`find -exec`/…) with NO grant — but a
  GRANTED such write still flows through the gate, so the grant-UI flows are
  unaffected; `ssh host git commit` (remote git); an unquoted git write-subcommand
  sitting as a bare arg to a non-allowlisted, non-data command (`sed … git commit`);
  a bare git-only subcommand head. The ORDINARY grant-UI flows — `git add`,
  `git commit -m …`, `git push`, chained with `&& ; |` — are plain `git` heads,
  unaffected (verified: 31-command false-positive sweep + 15-command attack-allow set
  all ALLOW). STILL uncatchable (documented gaps, unchanged; FEAT-135 PATH shim is the
  backstop): a non-shell interpreter that shells out (`python -c`/`node -e`/`perl -e`),
  a wrapper SCRIPT, a shell alias/function not named `git`, and the exotic
  `g${x}it commit` (an expansion that BUILDS the word "git" without the substring
  "git" appearing) — declined, same family as the interpreter gap.
- **Changed (UNSTAGED):**
  - `scripts/lib/git-write-policy.mjs`: extracted `classifyTokens` (fail-closed head
    dispatch) from the walker; NEW `NON_RUNNER_HEADS` (data-sink allowlist) and
    `GIT_ONLY_SUBCMDS`; generic-runner handling (nested shell + bare-git-token scan);
    obfuscated-git-head + expanded-head refusals; `env -S`/`--split-string` fixed to
    re-tokenize its value (spaced AND quoted forms); `EXEC_C` recurses EVERY non-flag
    arg + attached `-cCMD` (handles `-lc`/`-cl`/any cluster order); `stripHeredocBodies`
    rewritten QUOTE-AWARE (a `<<X` inside quotes is no longer a false opener — closes
    finding B, which was a real ungated write, not just over-block); `MAX_DEPTH` 6→8.
  - `scripts/verify-feat-108-git-write-block.mjs`, `scripts/verify-feat-108-git-grant.mjs`:
    round-5 cases added (see below). No `package.json` change.
- **Reproduced BEFORE (real fns, `/tmp/f108-r5.mjs`):** `exec/nice/sudo/timeout git …`,
  `find -exec git commit`, `git${IFS}commit`, `env -S git commit`, `bash -cl`, and the
  quoted-`<<` heredoc all returned `{allow:true,offender:null}` (fail-open). AFTER: all
  DENY with the right offender; the quoted-`<<` case now catches the trailing commit.
- **Verified — PASS-after + suites green:**
  - `verify:git-write-block` → **205 passed, 0 failed** (was 177; +28: the round-5
    wrapper/obfuscation/heredoc evasions, a data-head-allows-git-as-data set, an
    unknown-wrapper-fails-CLOSED set, obfuscated + expanded-head denials).
  - `verify:git-grant` → **60 passed, 0 failed** (was 52; +8: the granted gate RUNS
    and a FAILING gate REFUSES on a publish hidden behind `exec`/`nice`/`sudo`/`env -S`
    after a non-publish `git add` — these were fail-open on the grant path in round 4).
  - Self-attack (`/tmp/f108-attack5.mjs`): 25 further evasions (escaped heads `\exec`/
    `g\it`, quoted heads, `command exec`, `xargs -I{} sh -c`, nested `sh -c "sh -c …"`,
    process-sub `<(git commit)`, `setsid -f`, `flock`, `watch`, `env FOO=1 nice …`,
    substitution/backtick/`a=$(git commit)`, `git${IFS}push`) → ALL deny; 15 legit
    commands (git reads, `python -c`, `grep`, `docker run git-image`, `node`, `make`,
    `find -name .gitignore`) → ALL allow.
  - Anti-regression: `verify-feat-135-git-shim` **31/0**. `verify-bug-173` **27/1** and
    `verify-bug-184` **27/1** — the single failure in each is still its `[must-FAIL]`
    leg reading `git show HEAD:` (BUG-173/184 committed → baseline moved), independent
    of this working-tree-only change.
  - `npm run gate` → **PASS, exit 0** (leak-gate + check-nul + typecheck; the foreign
    `scripts/_diag-b203.mjs` that failed round 4's gate has been removed by its owner).
  - `npm run board:check` → DRIFT on **FEAT-157** (an unparseable decision on another
    session's ticket) — NOT FEAT-108, not caused by this lane.
- **HIGH-STAKES (SECURITY, fail-closed enforcement) — status stays OPEN.** This is a
  DEFAULT-flip on the git-write path; an independent cross-provider clean-room verify
  is WARRANTED before VERIFIED. A verifier should re-attack with novel wrappers and
  obfuscations against the REAL `decideGitWrite`/`evaluateGitWrite` in an ungated room,
  confirm the granted gate runs for wrapper-hidden publishes, and re-run both suites.

### 2026-09-29 — clean-room verification (round 5, BROKEN, VALID)
- **What ran:** cross-provider (OpenAI) clean room over the round-5 WORKING TREE
  (`--working-tree`, fix uncommitted), attacking the REAL exported decision
  functions directly (ungated room, no PreToolUse hook) and re-running the
  fixer's own suites through the run recorder. Requirement written to a temp
  file (not fixer prose); the filled-in citation-block example was supplied.
- **Command (tilde form):** `node scripts/independent-verify.mjs --repo
  ~/projects/orchard --working-tree --requirement @<req> --run "node
  scripts/verify-feat-108-git-write-block.mjs" --run "node
  scripts/verify-feat-108-git-grant.mjs" --test-file <both suites>
  --timeout-min 22 --verdict-out <verdict>`.
- **Verdict: BROKEN — VALID (manifest-backed, harness exit 1).** FIXER-TEST
  re-ran `verify:git-grant` → 60/0. The round-5 fail-closed flip HOLDS for every
  bare-`git`/wrapper form the prior rounds targeted (that surface was not
  re-refuted). But the verifier landed REAL commits in a scratch repo through
  three shapes the fail-closed design still ALLOWS, each paired with the real
  decision output (`{allow:true, offender:null}`, ungranted allow, and on the
  granted path `gateCalls:0`), and history grew 1→2 commits each time:
  - **FINDING P (fail-open — pipe INTO a runner).** `printf 'git commit
    --allow-empty -m pipe\n' | sh` → both decision functions allow with NO
    grant; a real commit landed. `printf` is a NON_RUNNER_HEADS data sink, but
    its output is PIPED into `sh`, which the policy does not treat as a runner
    of the piped data — so the git write on the right side of the pipe is never
    seen. With a grant the failing gate gets **0** calls.
  - **FINDING H (fail-open — heredoc BODY fed to a shell's stdin).** `sh <<'EOF'
    ⏎ git commit --allow-empty -m heredoc ⏎ EOF` → allow:true, real commit
    landed, gateCalls 0. Distinct from round 4's heredoc-TRAILING case: here the
    heredoc body IS the shell's script (`sh` reads it on stdin), and
    `stripHeredocBodies` discards exactly that body, so the write inside it
    vanishes from the scan.
  - **FINDING X (fail-open — git READ head executes a write via its own
    option).** `git -c diff.external='git commit --allow-empty -m external;
    true #' diff --ext-diff` → allow:true (a `diff` read head), but the
    `diff.external` config value is executed by git and runs the nested commit;
    real commit landed, gateCalls 0. A read-classified git head smuggles a write
    through a git config option that runs an external command.
  - **Confirmed still HOLDING (not re-broken):** the wrapper/obfuscation forms
    round 5 targeted — `exec`/`nice`/`sudo`/`timeout` git, `find -exec`,
    `git${IFS}commit`, `env -S` spaced/quoted, `bash -lc`/`-cl`, subshells,
    quoted-`<<` heredoc, `xargs`, `<(git commit)` — were the fixer's own
    fixtures (60/0) and were not the break vector this round.
- **Could-not-test:** real SDK PreToolUse hook enforcement (ungated room — the
  functions were called directly through both real exports).
- **Verified-by:** dispatch openai run 01a0ee8c-6bc6-7722-88df-58cda25facc4
  (clean-room, working-tree, `scripts/independent-verify.mjs`) — VERDICT: BROKEN
- **Independent-verify note:** cross-provider (author anthropic → OpenAI
  verifier), fresh clean room, no board/methodology surface — generation did not
  verify itself. Given the harm class, a confirming clean-room pass on the
  eventual fix is warranted.
- **Status:** stays OPEN — priority (SECURITY, git-write enforcement, fail-open).
  Handoff: the fail-closed default reasons about a command's HEADS but not about
  DATA it feeds to a runner, nor about a git read head's own command-executing
  options. (1) A pipe/redirection whose TARGET is a runner (`| sh`, `| bash`,
  `| xargs`) must treat the piped git write as reachable — or deny on any pipe
  into an unresolvable runner. (2) A heredoc BODY consumed as a shell's stdin
  script must be scanned (not stripped) when the heredoc feeds a runner head.
  (3) git read heads carrying command-executing options (`-c diff.external=`,
  `-c core.pager=`, `-c sequence.editor=`, `-c *.external=`, textconv, hooks)
  must be treated as write-reachable / denied — the read-allowlist cannot assume
  a read subcommand is inert when its `-c` options run arbitrary commands.

### 2026-09-30 — worker (fixing, round 6, class=fix) — data-flow + config execution
- **Three new fail-opens closed BY RULE (round-5 verify, openai run 01a0ee8c),
  each reproduced first against the real functions (`/tmp/f6.mjs`):**
  - **P — pipe/redirect into a runner.** `printf 'git commit' | sh` (a data sink
    piped into a shell) allowed with gateCalls 0. RULE (a): a `|`/`<`/`<<<` whose
    consumer is NOT a proven data sink is a runner edge; the piped DATA is command
    text, so the whole flattened line is scanned and EVERY git write in it is
    emitted (so a publish hidden in the piped data still gates).
  - **H — heredoc body as a shell's stdin script.** `sh <<'EOF' … git commit … EOF`
    allowed. RULE (b): `parseHeredocs` now finds each heredoc's CONSUMER head; if it
    is a runner the body is scanned as command text (not stripped), while a data-sink
    consumer's body stays data (`cat <<EOF` unchanged — no false positive).
  - **X — config-driven execution on a read head.** `git -c diff.external='git
    commit …' diff` allowed (the `diff` read head executed a command via config).
    RULE (c): a `-c`/`--config-env`/attached `-cKEY=` on ANY git head, and a leading
    `GIT_CONFIG_PARAMETERS`/`_COUNT`/`_KEY_*`/`_VALUE_*` env, is a WRITE unless the
    key is on a TINY inert allowlist (`color.*`, `core.quotepath`, `advice.*`) —
    fail-closed, so `core.pager`/`core.sshCommand`/`sequence.editor`/`*.textconv`/
    `filter.*`/`core.hooksPath`/`alias.*` are all denied by default.
- **Changed (UNSTAGED):**
  - `scripts/lib/git-write-policy.mjs`: `offendingConfigKey` + `CONFIG_KEY_ALLOWED`
    wired into `offenderForGit` (rule c); a `GIT_CONFIG_*`-env check in
    `classifyTokens`; `flattenQuotes`/`textHead`/`isRunnerConsumer`/`feedsRunner`
    helpers; `stripHeredocBodies` replaced by `parseHeredocs` (returns runner-consumed
    bodies to scan); the pipe/redirect data-flow scan in `walkGitWrites` emitting
    every reachable write.
  - `scripts/verify-feat-108-git-write-block.mjs` / `-git-grant.mjs`: round-6 cases
    (see counts). No `package.json` change.
- **Verified — real functions, must-FAIL/PASS-after:** `verify:git-write-block`
  → **231/0** (was 205); `verify:git-grant` → **66/0** (was 60; the P/H/config
  publishes gate on the granted path, gateCalls 1). Self-attack (`/tmp/f6sweep.mjs`
  + `/tmp/f6cfg.mjs`): 23 further evasions deny, 25 legit commands allow, incl.
  data-sink pipes (`printf x|sh`, `git log|grep`, `git diff|less`), config allowlist
  (`-c color.ui`, `-c core.quotepath`, `GIT_CONFIG_GLOBAL=/dev/null`), and a clean
  sequential heredoc. Anti-regression: `verify-feat-135-git-shim` **31/0** (PATH shim
  stripped, the documented env caveat); `verify-bug-173`/`-184` **27/1** each (the
  pre-existing `git show HEAD:` must-FAIL legs, independent of this working-tree
  change). `npm run gate` → **PASS, exit 0**.
- **Honest residuals (documented, NOT closed — the ARCH-021 subject):** a script
  FILE piped to a shell (`cat f | sh` — content on disk, no visible git word); a
  non-shell interpreter that shells out (`python -c`/`node -e`); an expansion that
  BUILDS "git" without the substring appearing (`g${x}it commit`); `GIT_CONFIG_GLOBAL`/
  `_SYSTEM` pointing at a malicious file (left alone so the `=/dev/null` isolation
  idiom keeps working); the FEAT-135 same-uid shim bypass.
- **Part 2 — filed ARCH-021** ("Agent git-write enforcement is a shell-text parser,
  so the leak gate is only as strong as the parse"). Six rounds / five clean-room
  breaks are one class: the gate is triggered by a text classification of a full
  shell language, so completeness rests on an unprovable parser and every miss is
  fail-OPEN. Options A (price the residual) / B (git-hooks + FEAT-135 shim) / C
  (RO `.git` mount for containers) / D (combination); recommend D. Needs the user;
  orchestrator to flip its INDEX owner to 👤.
- **HIGH-STAKES (SECURITY, fail-closed enforcement) — status stays OPEN.** An
  independent cross-provider clean-room verify is warranted before VERIFIED.

### 2026-09-30 — verify orchestrator (note) — HELD pending ARCH-021 (no further verify round)
- Round 6 landed, but no independent verify round is queued. Per WA §N stopping rule: the remaining residuals all reduce to ONE invariant — text-level shell parsing cannot be complete, so every miss is fail-OPEN by construction — and another round would only surface another shell form, buying nothing. That invariant is now filed as **ARCH-021** (a user decision on the enforcement LAYER, e.g. git-hooks / RO `.git` mount / PATH shim, not more parser rounds). FEAT-108 is HELD pending ARCH-021; status stays OPEN. Verified history: rounds 1/4/5 all BROKEN/VALID (last openai run 01a0ee8c, 3 bypasses); the fail-closed redesign closed the enumerated classes.
