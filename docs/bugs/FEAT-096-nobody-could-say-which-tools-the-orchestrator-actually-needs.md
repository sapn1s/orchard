# FEAT-096 — nobody could say which tools the orchestrator actually needs

- **Status:** IN-VERIFICATION — phase 2 built. The open decision below is ANSWERED (option A,
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
