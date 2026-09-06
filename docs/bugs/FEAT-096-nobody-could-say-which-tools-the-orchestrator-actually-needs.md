# FEAT-096 — nobody could say which tools the orchestrator actually needs

- **Status:** IN-VERIFICATION — enforcement is now ENABLED on all 13 registry projects and verified per project (197/197 config, 12/13 in real sessions, containers included). Takes effect at the service's next restart: the running server predates the code. A live-session escape (`node -e`) was found and closed. Independent clean-room pass still required.
  and then some): enforcement is built, per-project and default-off. Needs an independent
  clean-room pass before VERIFIED — see the 2026-08-25 entry.
- **Severity:** low (it blocks nothing and changes no behaviour; it only records)
- **Area:** hooks / orchestrator profile
- **Reported:** 2026-08-20 by the orchestrator-design attack lane
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED. A hook that
  runs ahead of every tool call in this repo is not a docs-only change, and the neighbouring
  hook in this same directory is BUG-118.

## Symptom

Two full orchestrator redesigns were written on the same premise: that the orchestrator spends
its context reading, grepping and reasoning inline, and that taking those tools away would force
the work into lanes and cut the bill. `docs/analysis/orchestrator-design-attack-2026-08-20.md`
demolished both designs as unbuildable — and then noticed that **the premise underneath them has
never been measured.** Nobody can say how often the orchestrator reaches for a tool a
dispatch-only profile would refuse. The number could be 80%, in which case the restriction is
worth building; it could be 3%, in which case the entire line of work is dead.

## Expected

Answer that question for the price of a log, before anything is restricted.

## What was built

The v0 both designs converge on (attack §9), in **log-only mode**:

- `scripts/lib/orchestrator-profile.mjs` — the surface, declared once: `Agent`, `SendMessage`,
  `TaskStop`, and everything else denied by default. Nothing enforces it. It is the yardstick the
  log is measured against.
- `scripts/hooks/orchestrator-surface-log.mjs` — a `PreToolUse` hook that records each call and
  **blocks nothing**. Wired in `.claude/settings.json` alongside the existing Stop hook.
- `scripts/orchestrator-surface-report.mjs` (`npm run orchestrator:surface`) — reads the log and
  reports what would have been refused, by tool and by session.
- `scripts/verify-orchestrator-surface-log.mjs` (`npm run verify:orchestrator-surface`) — 67 checks.

**The wiring is local to this machine and is not in git.** `.gitignore:23` ignores `.claude/`, so
the `PreToolUse` block that turns the recorder on lives in an untracked file. The scripts are
committed; the switch is not. Nobody who clones this repo starts recording, and the block has to be
re-added by hand on any other machine — `scripts/onboard.mjs` does not know about this hook and was
not taught to, since log-only instrumentation should not travel silently.

Log-only is the deliverable, not a stepping stone. It says what the restriction would break
before it breaks it, and if the answer is "almost nothing" the premise is refuted cheaply. The
report prints that refutation in those words when the data supports it, so the null result cannot
be quietly read as a success.

## Three things the build found that the design could not have

**1. The design's tool names are not this harness's tool names.** The attack specifies the
surface as `Dispatch`, `SendMessage`, `TaskStop`. **There is no tool called `Dispatch`.** Captured
from a live payload: a session asked for "the Task tool" and the harness emitted
`tool_name: "Agent"`. A profile written from the document would have allowed a tool that does not
exist and denied the one that does — scoring 100% blocked, with no bug to point at.

**2. A subagent's tool calls fire this hook too, and carry the same session identity.** All three
captured payloads share one `session_id` and one `transcript_path`, whether the caller was the
main session or a lane it dispatched. The only thing that separates them is a pair of keys present
**only on subagent calls**: `agent_id` and `agent_type`. Without that discriminator the log counts
every lane's `Bash` call as an orchestrator reach — and the premise confirms itself by
construction. In the real session driven below, lane calls were 43% of the log.

**3. The first signal counter would have hung on a long brief.** The obvious way to spot a
`file.ts:123` citation — one regex over the whole brief — backtracks catastrophically: 200,000
characters of non-matching text did not finish in 20 seconds. This runs ahead of every tool call,
so a brief carrying one long unbroken token (a pasted path list, a stack dump, a base64 blob)
would have burned a core and lost the record to the hook timeout. Rewritten as a bounded per-token
test; the suite holds it to a wall clock and keeps the pre-fix pattern as a must-FAIL proof.

## The escape channel is measured too, because otherwise this measures the wrong thing

The attack's §3 is not optional: *"Denying tools by name does not hold. The role can still do the
work by writing the reasoning into a dispatch brief and handing a lane a shell."* A log that
counted only blocked tool **names** would score the profile a total success in exactly the world
where it changed nothing — the orchestrator stops calling `Read` and writes its diagnosis into
`Agent.prompt` instead. So every dispatch brief and every `SendMessage` is ranked for
analysis-shaped content: size, `file:line` citations (a citation is the residue of a read that
already happened), and conclusion phrasing.

These are **heuristics and are reported as heuristics.** They rank briefs so a person can read the
top of the list; they cannot decide whether a brief carries analysis. An automated verdict there
would be precisely the unoracled claim wearing a verified label that attack §4 warns about. The
report says so on screen and asks that the reading be done by someone who did not write the
profile.

`Bash` calls that invoke `scripts/dispatch.mjs` are counted separately, because denying `Bash`
would remove this project's only route to a non-Claude provider (FEAT-043) as a side effect.

## Why this cannot become BUG-118

BUG-118 is a hook in this same directory that told a hand-started session in an unrelated project
that its reply broke this project's rules — survivable only because it was advisory. Three
properties keep this one out of that hole: it never emits a decision (there is no enforce mode to
flip); it exits silently unless `payload.cwd` resolves inside its own repo root, so a copy in
another project scopes itself to that project rather than reporting on it; and every failure path
exits 0 — unparseable payload, missing fields, unwritable log.

**The attack is explicit that `response-format-gate.mjs` must NOT be flipped fail-closed, and it
was not touched.** Design A calls that the cheapest structural change available; it is the hook
with the recorded provenance defect, and blocking would make that failure fatal instead of noisy.

## Deliberately not built

No deny and no registry change — the profile is not written into any project's `allowedTools`.
No workflow service, no gateway, no attestation runner, no signing authority. No `Records` or
`Publish` tool. No `paths[]` concurrency lock. The attack found both full designs unbuildable and
this is a profile plus a log.

## Decision — leave the recorder running, or revert it?

> **CLOSED 2026-08-25 — A, leave it recording.** Answered via the ticket view and acted on by
> the phase-3 lane: the `PreToolUse` recorder block in `.claude/settings.json` stays exactly as
> it is, nothing was reverted, and the log keeps accumulating toward the A-E1 finding. The
> question below is kept verbatim as the record of what was asked; it is not open. The same
> session also answered the *second* question this ticket had been carrying implicitly —
> whether to enforce anywhere — with "every project in the registry" (see the phase-3 entry).

The hook now runs ahead of every tool call in this repo, at a measured **21 ms per call**, and
writes to a log outside the repo. It blocks nothing and reverts by deleting one block from
`.claude/settings.json`. But it does instrument every session you run here, and that is your call
rather than a lane's.

- **A — leave it recording.** Real working sessions produce the A-E1 finding within days, and the
  premise under two whole designs gets tested for the price of a log. Costs 21 ms per tool call
  and a growing file in the state directory (rotated at 25 MB).
- **B — revert it now.** Delete the `PreToolUse` block; the scripts stay in the tree, unwired, and
  can be turned on later. The question stays unanswered and the designs stay unfalsifiable.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files in play: `scripts/lib/orchestrator-profile.mjs`, `scripts/hooks/orchestrator-surface-log.mjs`,
  `scripts/orchestrator-surface-report.mjs`, `scripts/verify-orchestrator-surface-log.mjs`,
  `scripts/fixtures/feat-096/real-pretooluse-payloads.jsonl`, `.claude/settings.json`
- Repro test: `npm run verify:orchestrator-surface` · read the data with `npm run orchestrator:surface`
- Related: `docs/analysis/orchestrator-design-attack-2026-08-20.md` (§3 the escape channel, §7 A-E1,
  §9 the buildable v0) · BUG-118 (the hook provenance defect this is designed around) ·
  FEAT-043 (`scripts/dispatch.mjs`, the shell dispatch path a `Bash` deny would remove) ·
  ARCH-008 (why the profile is one module imported twice rather than two copies)
- Where the enforcement fields already live, if this ever goes beyond log-only:
  `src/server/registry.ts:191-193` (`permissionMode` / `allowedTools[]` / `disallowedTools[]`),
  consumed at `src/server/agent-bridge.ts:1112-1127` → `src/server/runtime/claude-runtime.ts:428-429`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — orchestrator-profile-v0 lane

- **Understood:** the attack demolishes both designs and identifies one buildable thing: a
  dispatch-only tool surface, in log-only mode, as experiment A-E1. Verified its two load-bearing
  repo claims rather than taking them on trust — `src/server/registry.ts:191-193` does carry the
  three permission fields, and a `PreToolUse` array does already exist on this machine.
- **Changed:** the four scripts and the fixture listed above; a `PreToolUse` block added to
  `.claude/settings.json`; two npm scripts.
- **Verified:** `npm run verify:orchestrator-surface` → **67/67 PASS**. `npm run gate` → exit 0.
  The suite grades the REAL captured payloads, not a fixture of my own design, and carries two
  must-FAIL proofs, both anchored to fixed reconstructions rather than to HEAD (docs/CONVENTIONS.md):
  a session-keyed separator scores 0 separation on the real data, and the pre-fix citation regex
  still hangs on input the shipped one handles in 1 ms. Because another process writes the log
  while the report reads it, the report is graded against the real bytes truncated at 8 points, a
  half-written final line (which it must REPORT as unparseable rather than hide), and 12 concurrent
  appends. Scope is proven both ways — a foreign project's call records nothing, the same call from
  inside the repo does record — including the prefix-confusion case where a sibling directory's
  path starts with the repo's.
- **Also verified end-to-end against the real path, not just the mechanism:** with the hook live
  in this repo, a real `claude` session was driven through orchestrator-shaped work (read a ticket,
  grep, a shell count, then a dispatch whose brief handed the lane its own diagnosis). The report
  read that real log correctly: 7 records, 4 main-session calls, 3 lane calls correctly excluded,
  75% of main-session calls outside the profile, and the one brief flagged at ~489 tokens with a
  citation and conclusion phrasing — the escape channel showing up in the data exactly as §3
  predicts it would.
- **Still open / handoff:** **the number above is NOT the A-E1 finding and must not be quoted as
  one.** It is one short session whose behaviour I specified in the prompt; I told it to read, grep
  and hand over a diagnosis, so it did. The finding requires real working sessions nobody staged.
  Next agent: after the recorder has seen real use, run `npm run orchestrator:surface`, and have
  the brief bucketing done by someone who did not write the profile (attack §7). Report the counts
  by tool **and be willing to conclude the premise fails** — a low would-block rate is the result,
  not a bug in the recorder.
- **Independent verification warranted, and this is the regression-prone bucket:** the file lives
  beside `response-format-gate.mjs`, which is BUG-118, and it runs ahead of every tool call in the
  repo. I wrote the fixture, so I can only have tested what I already thought of. A clean-room pass
  should attack the scope check, the never-block property under a hostile payload, and whether
  `agent_id` is genuinely absent on every main-session call rather than merely on the three
  captured here — that last one is the single assumption the whole experiment rests on and it is
  supported by n=3.
- **Symptom of a deeper design flaw?** Not closing this ticket, so the closing answer is not due
  yet. Noted for whoever does close it: the design documents specified a tool surface using names
  that do not exist in the harness, and nothing would have caught that until the deny landed and
  broke everything. That is worth a sentence about where design-time names get checked against
  runtime reality.

### 2026-08-25 — orchestrator-profile-enforce lane (phase 2)

**Trigger.** A brand-new session in the user's `kenimai-website` project opened by running a
tree-wide `grep`. Their words: *"suppsoedly we added the instrucitons to not run inline commands?
but the first thing the agent does it immediately runs commands on its own"*.

- **Delivery was checked FIRST, and the rule does arrive.** This mattered because a delivery
  defect would have made the whole compliance argument moot. `kenimai-website` is in the registry
  with both WA refs enabled and `methodVersion: 1`, so the BUG-144 backfill did cover it. More to
  the point, the delivered text was reproduced through the real code path rather than inferred:
  `composeInstructions()` for that project's actual settings yields **36,687 characters**
  containing the §I inline-work threshold verbatim — *"Yes → dispatch, at any size"*, *"93.2% of
  orchestrator spend"*, *"Your context is a liability, not an asset"*.
  - A false lead worth recording so nobody re-walks it: the stored template at
    `dataDir()/templates/working-agreement-v2.md` **is stale** (9,581 bytes, 2026-08-04, and its
    §I predates the inline-work threshold entirely). It is never delivered. `templates.ts:135-147`
    does a read-through and overwrites the body from `DEFAULT_SEED_SOURCES` →
    `docs/prompts/WORKING_AGREEMENT.v2.md` (26,427 bytes, current). The stale file matters only as
    a degraded fallback. `seedTemplates()` skips ids whose file exists, so it will stay stale
    forever — harmless today, and a latent trap the day someone removes the read-through.
  - Container mounting was also cleared: `containerWorkdir()` puts the project at
    `/workspace/kenimai-website` and it is there. The session's first command failed because that
    project has no `src/` (it is a Next.js `app/` tree) — the agent guessed a path. Not a mount bug.
- **So the text arrived and was not followed.** That session ran on **Fable-5**, made **17 Bash
  calls, 1 Read, 1 Write and zero dispatches**. Adding a firmer paragraph is the option that has
  now failed twice, so this lane made it structural.
- **The enforcement path in this ticket's own context pack is WRONG, and both halves were proven
  wrong live rather than argued:**
  1. `allowedTools` **does not restrict anything.** The SDK is explicit (`sdk.d.ts:1368-1374`):
     it is an auto-approve list — *"to restrict which tools are available, use the `tools` option
     instead"*. Under `bypassPermissions`, which is what lanes run under, it is a total no-op.
     Writing the profile there would have shipped something that looked enforced and was not.
  2. `disallowedTools` **leaks onto subagents.** A probe ran a session with
     `disallowedTools: ['Bash']` and asked it to dispatch a subagent to run `echo`. The subagent
     reported that *"the Bash tool was not available in my toolset"*. That is the one outcome this
     must not produce.
  3. **And in the same run the subagent routed around the deny unprompted** — it searched for a
     shell, found **`Monitor`**, and executed the command through it. A name-based deny on `Bash`
     is therefore not merely harmful but unsound. That is attack §3's escape channel demonstrated
     in one turn by a model nobody told to evade anything.
- **Changed.** Enforcement rides a `PreToolUse` hook passed in-process via the SDK's
  `options.hooks`, because it is the ONLY point in this harness carrying `agent_id` — *"present
  only when the hook fires from within a subagent … Absent for the main thread"*
  (`sdk.d.ts:174-176`). `canUseTool` carries no agent identity at all, so the runtime's existing
  approval callback cannot do this job. Files: the policy appended to
  `scripts/lib/orchestrator-profile.mjs` (+ new `.d.mts` so the server imports the SAME module —
  ARCH-008), `src/server/runtime/claude-runtime.ts` (the hook, fail-open on every path),
  `src/server/runtime/runtime.ts`, `src/server/registry.ts`
  (`settings.orchestratorProfile.enabled`, **default false**), `src/server/validate.ts`,
  `src/server/agent-bridge.ts`. Nothing is written into any user project — that is the specific
  way BUG-118 went wrong, and the hook travels with the session instead, which is also why it
  works unchanged for a container project.
- **The surface is derived from measured behaviour, not from the design documents.** Sources: the
  retroactive analysis (2,412 calls), the live recorder log (3,902 records), and the project
  transcript store. Sixteen tool names have ever been emitted here. Consequences:
  - `Bash` is **not** denied wholesale — it is decided per command head, default-deny with an
    allow list. 63% of the orchestrator's refused Bash was board bookkeeping and 23% was
    `npm run gate`, which the working agreement REQUIRES before a commit; a blanket deny would not
    restrict the orchestrator, it would make it non-compliant, and it would remove FEAT-043's
    cross-provider dispatch as a side effect.
  - `Edit`/`Write` are **allowed**: not one refused Write or Edit in the measured orchestrator
    window touched product code — all 22 were tickets, INDEX rows, analysis docs and memory.
  - `AskUserQuestion`, `TaskCreate`, `TaskUpdate`, `Workflow` are **allowed**. These are the four
    names the retroactive analysis found missing from the profile's lists entirely; denying
    `AskUserQuestion` would have stopped a session asking its user anything.
  - No tool named `Dispatch` appears anywhere, and the suite asserts it never will.
- **Verified — and the real corpus falsified three drafts of the classifier that my own fixtures
  had passed.** This is the finding I would most want a future lane to read:
  1. `2>&1` was torn in half by the `&` separator and its orphaned `1` read as a command head —
     which refused `npm run board:gen >/dev/null 2>&1; npm run gate …`, the exact cluster the
     policy exists to KEEP.
  2. `cd <repo>;` heads almost every real command; refusing `cd` refused the corpus wholesale.
  3. **Worst: multi-line `git commit -m "…"` messages were being split into commands**, so the
     prose of a board commit (`Two`, `The`, `Co-Authored-By:`) was refused as shell verbs. Fixing
     it needs a single left-to-right quote scanner, not two regexes — a double-quoted message
     containing an apostrophe (*"the clean room's contamination strip"*) mis-pairs otherwise.
  All three are pinned as must-FAIL proofs. `npm run verify:orchestrator-enforcement` →
  **122/122 PASS**, graded against **673 real tool calls** from the transcript store (not a
  fixture), and skipping loudly when the store is absent.
- **Verified end to end against the user-visible outcome, through the real `ClaudeRuntime`:**
  `npm run verify:orchestrator-enforcement-e2e` → **12/12 PASS**. With the profile OFF the session
  runs the shell search (the drift reproduces — the must-FAIL half). With it ON the orchestrator's
  own `grep` is denied, **the denial text reaches the model**, and the session tells the user:
  *"The shell/grep path is blocked in this session — it's an orchestrator profile, so searching
  has to go through a dispatched lane. Doing that now."* It then dispatched an Explore lane and
  **the work still got done**. A dispatched lane kept its full Bash. A question needing no tools
  was answered normally. `npm run verify:orchestrator-profile-registry` → **7/7**: default off,
  per-project, reversible by a one-key patch, and a registry edit cannot invent a tool surface.
- **Anti-regressions run:** `npm run verify:orchestrator-surface` → 67/67 (the log-only half,
  which shares the module), `npm run board:check` clean, `npm run gate` → **exit 0** (it caught
  four home-path leaks in the new files first).
- **The honest cost, reported rather than asserted away.** Of 64 real gate/board commands, 32 mix
  the gate with a file read in the SAME call and are refused; the orchestrator must split them.
  That is a real ergonomic tax and it is the strongest argument for the retroactive analysis's §3
  recommendation — **replacement, not denial**: a board tool, a status tool and a gate tool would
  dissolve most of this. Enforcement shipped first because instructions had already failed twice;
  it is not a substitute for those tools.
- **Still open / handoff.**
  - **NOT enabled for any project.** No live registry row was touched. Enabling it is one patch
    (`orchestratorProfile: { enabled: true }`) and is the user's call, per project.
  - Whether `kenimai-website` is the right first project is a genuine question: that session was
    doing builder work, and the profile describes the orchestrator role.
  - `isDispatchViaShell()` still under-reports by 61% (misses `npm run dispatch --`) — untouched
    here, still open from the retroactive analysis.
- **Independent verification warranted — this is squarely the regression-prone bucket.** It runs
  ahead of every tool call in an enabled project, it lives beside BUG-118, and I wrote both the
  policy and its suite. A clean-room pass should attack: the quote/heredoc/substitution scanner
  with hostile shell (nested substitution, `$'…'`, unbalanced quotes, `\` line continuation);
  whether any allowed head can still read a file into context; and above all whether `agent_id`
  is genuinely absent on EVERY main-thread call rather than merely on the ones observed — that
  single assumption is what keeps dispatched lanes working.
- **Symptom of a deeper design flaw?** Yes, and it is the same one the previous entry flagged,
  now with a second instance: **design-time tool names were never checked against runtime
  reality.** The first instance was `Dispatch`, a tool that does not exist. The second is this
  ticket's own context pack pointing at `allowedTools` as the enforcement path — a field that
  cannot enforce. Both survived review because nothing in the pipeline confronts a named
  capability with the harness that must provide it. Worth an ARCH ticket if it recurs a third time.

### 2026-08-25 — you (answer · via ticket view)
- **Question:** leave the recorder running, or revert it?
- **Chose:** A — leave it recording
- **State:** answered — awaiting agent action (not dispatched)

### 2026-08-25 — orchestrator-profile-fleet lane (phase 3)
- **Enabled on every project — and one hole found live:** Both open questions on this ticket are now ANSWERED and ACTED ON, and the profile is enabled on all 13 registry projects.
  - **Decision 1 — the recorder:** A, leave it recording. Nothing reverted; the `PreToolUse` block
    in `.claude/settings.json` is untouched and still log-only. The Decision section above is marked
    CLOSED and the Owner cell moves off 👤.
  - **Decision 2 — where to enforce:** *"enable on all when possible no other project is running,
    only be wary of orchard itself."* Enabled on **13/13** projects via the real
    `validateProjectPatch` + `updateProject` path. Diffed against a pre-change backup
    (`registry.json.pre-feat096-enable-all`): **only `orchestratorProfile` and `updatedAt` changed
    on every row** — no other setting was rewritten.
  - **Nothing else was running, checked rather than assumed.** One station session (this repo's own,
    with one session host), one HAND-STARTED `claude` in an unrelated project (launched from a
    terminal — it never goes through `ClaudeRuntime`, so a registry flag cannot reach it either way),
    and one scratch server on port 48318 with its own isolated `CLAUDE_STATION_DATA`. Nothing was
    touched, killed or restarted.
  - **THE ONE THING THE USER MUST DO, and the reason it is not done here: the running service is on
    PRE-FEAT-096 CODE.** `PATCH /api/projects/:id {orchestratorProfile:{enabled:true}}` against
    127.0.0.1:4317 returned `unknown field "orchestratorProfile"` for all 13 projects, while
    `validate.ts` on disk accepts it — proof, not inference, that the systemd service (started
    08:54, main PID unchanged) predates commit cb12563 (16:23). So the registry now says enabled and
    **the live server cannot act on it**: `registry.ts` `load()` re-reads the file per call, so the
    running server SEES the flag (a live GET returns `{"enabled":true}`), but the enforcement hook
    it would need lives in code it does not have. Enforcement begins at the service's next restart,
    which this lane did not perform (standing rule; it would also have killed the dispatching
    session). **Second-order risk while it stays stale:** the old `updateProject` enumerates known
    settings keys, so any project settings edit made from the UI BEFORE the restart will silently
    drop that project's `orchestratorProfile`. Re-run the enable for that project if so.
  - **Orchard's own project was the one to think about, and it is safe — TESTED, not argued.** The
    profile is composed once in `startSession()` and handed to `runtime.start()`; the project PATCH
    route writes the registry and touches no live session. `verify:feat-096-live-sessions --immunity`
    turns that argument into an experiment on REAL sessions in an isolated data dir: a session starts
    with the profile OFF and runs its own shell (baseline); the registry is flipped ON mid-session
    through the real writer; the SAME session takes another turn and **still has its shell, with no
    denial delivered**; and a NEWLY launched session in that same project IS enforced. 6/6.
  - **Verified PER PROJECT, not in aggregate.** `npm run verify:feat-096-fleet` → **197/197 across
    13 projects (3 containerised)**, grading each row separately against the REAL live registry:
    the row is enabled, the exact `agent-bridge` composition expression yields the flag, that
    project's own paths are refused to the orchestrator with an actionable reason, a lane keeps
    Bash and Read, and dispatch / AskUserQuestion / `npm run gate` / board bookkeeping / its own
    commit all still run. Must-FAIL proof: flipping ONE project off in a copied registry fails
    exactly that project's two checks (195/197) and exits 1.
  - **And observed in REAL SESSIONS, which is the actual deliverable — 12 of 13 projects.** Each
    got a real turn through the real `startSession()` with its real instruction stack (the WA is
    seeded from the same repo sources the live data dir reads through), given work that used to
    start with a shell command. In every one: the orchestrator's own `ls` was DENIED, the reason
    reached the model, **it dispatched a lane**, the lane kept full Bash, the work got done, and a
    no-tool question was still answered normally. **The drift is gone.** The 13th project
    could not be exercised at all: its `hostPath` does not exist (a pre-existing dangling row,
    BUG-138 territory) — enabled in the registry, unverifiable until repointed.
  - **Containerised projects behave identically, and the mechanism does travel with the session.**
    All three containerised projects each ran a genuine in-container session (the
    refused command names `/workspace/<project>`), under throwaway project ids so no live container
    was adopted; all three containers were removed afterwards. Nothing was written into any project
    tree — asserted per project, because that is the specific way BUG-118 went wrong. DECLARED
    DEVIATION: all three enable the stealth browser, and a browser-enabled project refuses to start
    a session when the adapter is unconfigured (which it is on this machine, and on the live service
    too — worth knowing independently of this ticket), so the mirror disabled the browser for the
    run and says so on screen.
  - **A REAL SESSION WALKED THROUGH A HOLE IN THE POLICY, unprompted, and it is now closed.** With
    the profile on in this repo, a session refused `ls -1 <repo>` came back with
    `node -e "require('fs').readdirSync(...)"` and read the tree anyway. Nobody told it to evade
    anything — this is attack §3's escape channel for the third time, and it answers the phase-2
    handoff's own question ("whether any allowed head can still read a file into context") with
    *yes*. `node` was allowed because the orchestrator runs `node scripts/…` verifiers; `-e` turns
    that head into `cat`. Closed by per-head ARGUMENT rules applied at every pipeline stage:
    `node -e/-p/--eval`/bare-REPL/heredoc-fed, `npx`, `npm exec|x`, `docker` outside a status
    subcommand, `systemctl cat`, `curl file://`, and `cp`/`mv` to a std stream. **The cost was
    measured before tightening, not after:** across 239 real Bash calls since 2026-08-18, `npx` 0,
    `npm exec` 0, `curl file://` 0, `docker run|exec|cp` 0, `systemctl cat` 0, `cp|mv` to a stream 0
    — and the only two real `node -e` calls in the corpus were that same escape. Everything real
    still runs (`npm run gate`, `node scripts/leak-gate.mjs 2>&1 | tail -1`, `docker ps`,
    `systemctl --user show|status|list-units`, `curl http://127.0.0.1:4317/…`).
  - **One draft of that fix leaked and is pinned.** A `subcommandOf()` that skipped a flag's VALUE
    read `systemctl --user cat <unit>` as "`--user` takes the value `cat`" and allowed a unit-file
    dump. Both that and the head-only rule are must-FAIL reconstructions in
    `npm run verify:feat-096-read-escapes` → **41/41**.
  - **The known cost, chased to its source: there is nothing in the repo to fix.** An audit of every
    guidance surface (WA v2, patterns, CONVENTIONS, CLAUDE.md, board README, ticket templates,
    `.claude/agents/worker.md`, `onboard.mjs` templates) found **zero** documented commands that mix
    a gate/board check with a file read — the 32 refused combinations are ad-hoc model behaviour in
    the transcript store, hard-coded nowhere, so "split them" is a behavioural change with no
    callers to edit. The audit did find ONE real doc conflict: `docs/CONVENTIONS.md`'s BUG-103 rule
    says "for any content hunt, use `rg`", which an enabled orchestrator is refused. Fixed there
    with a carve-out naming who the rule is addressed to (a lane) rather than by weakening either
    rule.
  - **The stale stored template is fixed, not just noted.** `seedTemplates()` skipped any id whose
    file existed, so the stored `working-agreement-v2.md` was frozen at 2026-08-04 (9,581 bytes)
    forever — harmless only while the read-through exists, and already a stale DEGRADED FALLBACK.
    It now refreshes the stored body of a seed that still resolves to its own source, preserving
    curated frontmatter, never touching a detached or re-pointed template, and no-op when current.
    The user's real files were refreshed (v2 9,581 → 31,011 bytes, now carrying the inline-work
    threshold; v1 was stale too; the four `pattern-*` seeds were already current), backups kept
    alongside. `npm run verify:feat-096-template-refresh` → 19/19 with a must-FAIL proof.
  - **Anti-regressions, all run, exit status read directly:** `verify:orchestrator-enforcement`
    **122/122** against 688 real tool calls (the gate/board split cost is unchanged at 32 of 64),
    `verify:orchestrator-surface` **67/67**, `verify:template-readthrough` 18/18,
    `verify:pattern-templates` 34/34, `verify:feat-077` 30/30, `verify:boot-aware` 12/12,
    `verify:routing-inject` 18/18, `verify:local-conventions` 18/18, `npm run board:check` clean,
    `npm run gate` exit 0.
  - **Still open / handoff.** (1) The service restart is the user's, and until it happens nothing is
    enforced. (2) One project is enabled but its directory is gone. (3) `isDispatchViaShell()`
    still under-reports by 61% — untouched, still open. (4) `echo *` remains a directory listing an
    orchestrator can run; it reads no file content and was left rather than adding glob heuristics
    that would misfire on ordinary `echo`. (5) The A-E1 finding still needs unstaged sessions.
  - **INDEPENDENT VERIFICATION REQUIRED, and more so than before.** This is squarely the
    regression-prone bucket: a hook ahead of every tool call, now in EVERY project, beside BUG-118,
    with a policy change written and self-verified by the same lane. Attack the new head-argument
    rules with hostile shell (`$'…'`, nested substitution, `\` continuations, quoted `file://`,
    `PATH`-relative spellings), look for another allowed head that can read, and re-examine the one
    assumption everything rests on: that `agent_id` is absent on EVERY main-thread call.
  - **Symptom of a deeper design flaw? Yes — and this is the THIRD instance the previous two entries
    said to watch for, so ARCH-013 is filed.** (1) `Dispatch`, a tool that does not exist.
    (2) `allowedTools`, a field that cannot enforce. (3) `node`/`npx`/`docker` admitted to the
    surface by NAME, with nothing confronting what those names can actually do. Same flaw each time:
    a capability is named at design time and never confronted with the runtime that must provide it.

### 2026-09-06 — orchestrator-profile-default lane (fixing round 3)

  - **Straggler enable (live state, via the settings API — no hand-edit of the registry).** Enumerated
    the registry: 17 projects, 4 with `orchestratorProfile.enabled` not true —
    `trading-volume`, `busy-board`, a private project (neutral id `external-project-K`), and
    `letschess` (all explicit `false`). None looked
    deliberately off (the profile does not isolate from the host, and the user endorsed profile-on
    fleet-wide), so all four were flipped through `PATCH /api/projects/:id` with
    `{"settings":{"orchestratorProfile":{"enabled":true}}}` on the running server (port 4317), the
    same validated path the UI uses. Read back via a fresh `GET /api/projects`: **still-OFF = []**,
    all 17 now enabled. Before: 4 off / 13 on. After: 0 off / 17 on. The flag binds at each session's
    NEXT start — the service was NOT restarted, so already-running sessions keep their prior profile
    until they next launch.
  - **Onboard default is now on (code change).** `onboard.mjs` is docs-scaffolding only — it never
    creates a registry entry — so the real locus for "a newly-onboarded/added project is profiled
    unless explicitly turned off" is `defaultOrchestratorProfileSettings()` in
    `src/server/registry.ts`, which feeds `defaultSettings()` → `createProject`'s
    `{...defaultSettings(), ...input.settings}`. Flipped its return from `{ enabled: false }` to
    `{ enabled: true }`. This also makes any legacy pre-FEAT-096 row with no field READ as enabled
    (all 17 live rows carry an explicit field, so no silent live change); an explicit stored
    `enabled: false` still persists through `updateProject`'s merge — the per-project toggle remains
    the escape hatch.
  - **Verification.** Must-FAIL first: `createProject` in an isolated `CLAUDE_STATION_DATA` temp dir
    on the pre-change tree → `enabled = false`. Post-change → `enabled = true` (node exit 0). Onboard
    regression suite `node scripts/verify-onboard.mjs` **51/51**. `npm run gate` exit 0 (leak-gate,
    check-nul, typecheck all PASS), read directly, unpiped.
  - **Files changed:** `src/server/registry.ts` (one hunk, ~10 lines, not in the prior dirty tree —
    entirely this lane's). The four project enablements are live registry state written by the
    service via its own API, not a git change.
  - **Independent verify:** low-risk single-line default flip on an already-fleet-endorsed setting;
    an independent pass is not required for this hunk. The broader FEAT-096 enforcement work above
    still carries its own standing "INDEPENDENT VERIFICATION REQUIRED" note.
