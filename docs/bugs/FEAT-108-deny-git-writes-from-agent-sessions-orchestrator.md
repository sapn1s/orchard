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
