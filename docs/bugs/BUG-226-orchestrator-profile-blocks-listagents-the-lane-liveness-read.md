# BUG-226 — the orchestrator profile blocks ListAgents, the lane-liveness read

- **Status:** IN-PROGRESS — fix built + self-verified; independent clean-room pass warranted (see Activity log). Takes effect at the service's next restart, for newly launched sessions only.
- **Severity:** medium (it blocks a check the Working Agreement REQUIRES, so the orchestrator cannot confirm a lane's liveness from ground truth)
- **Area:** hooks / orchestrator profile
- **Reported:** 2026-10-01 by the orchestrator (via the user)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED. It changes a PreToolUse enforcement gate that runs ahead of every tool call in every enabled project (FEAT-096 lineage), so it is not docs-only.

## Symptom

The orchestrator session is refused `ListAgents`:

> Orchestrator tool profile: `ListAgents` is not available to this session.

So the orchestrator cannot list its dispatched lanes and their busy/idle status.
On 2026-10-01 a lane ended its turn while its own child was still working, the
harness reported the lane "completed", and the orchestrator had no way to
confirm from ground truth whether the lane was really idle. The Working
Agreement §C REQUIRES confirming liveness from ground truth before treating a
lane as dead or re-dispatching — and the profile was refusing exactly that
check.

## Repro

1. An orchestrator session runs in a project with `orchestratorProfile.enabled`
   (default on fleet-wide since FEAT-096 round 3).
2. It calls `ListAgents` to check whether a dispatched lane is alive/busy.
3. `decide()` in `scripts/lib/orchestrator-profile.mjs` refuses it — the name is
   not in `ENFORCE_ALLOWED_TOOLS`, so it falls to default-deny.

## Expected

`ListAgents` is allowed to the orchestrator. It is a small status read — the
dispatched lanes' names and their busy/idle state, no tree reading — and it is
the read half of lane control, alongside the already-allowed `Agent` (dispatch),
`SendMessage` (steer) and `TaskStop` (stop). It fits the profile's own stated
purpose (keep the orchestrator's context lean; no inline reading/searching).

## Root cause

An allowlist gap, not a deliberate exclusion. `ENFORCE_ALLOWED_TOOLS` is a
default-deny allowlist whose v0 surface (attack §9) named dispatch, steer and
stop a lane; nobody named the verb that CHECKS a lane. Confirmed there is no
documented reason for the exclusion anywhere: `git log -S ListAgents` on the
profile is empty, `rg ListAgents` across the repo hits only `node_modules` (the
SDK, where `ListPeers` aliases to `ListAgents`), and no ticket, comment or
CONVENTIONS rule mentions it. The design-doc surface simply predates needing it.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play: `scripts/lib/orchestrator-profile.mjs`
  (`ENFORCE_ALLOWED_TOOLS` — the one owner of the allowed-tool set, ARCH-010; and
  `refusalReason()`'s "Still available here" prose). Consumed by the PreToolUse
  hook in `src/server/runtime/claude-runtime.ts` (static `import { decide }`).
- The tool name: the SDK alias map (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`)
  maps `ListPeers → ListAgents`; the harness emits `ListAgents` to the hook.
- Repro test: `npm run verify:orchestrator-enforcement` (new section 3b, with a
  synthesized must-FAIL proof per docs/CONVENTIONS.md).
- Related tickets: FEAT-096 (the profile and its enforcement), ARCH-010 (one
  owner for a fact), ARCH-008 (one module imported twice), FEAT-152 (the audited
  bypass hatch in the same file).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-01 — orchestrator-profile-listagents lane (fixing round 1)

- **Understood:** the profile refused `ListAgents` because the name was never in
  `ENFORCE_ALLOWED_TOOLS`; default-deny did the rest. Verified the exclusion is
  accidental, not deliberate: `git log -S ListAgents` on the profile → empty;
  `rg ListAgents` across the repo → only `node_modules` (the SDK's
  `ListPeers → ListAgents` alias); no ticket / comment / CONVENTIONS rule names
  it. Checked the SDK's orchestration tool set — the only liveness/status read
  the harness offers beyond the already-allowed `SendMessage`/`TaskStop` is
  `ListAgents`; there is no `TaskOutput` or similar tool in this harness — so
  `ListAgents` is the one tool to add.
- **Changed:** `scripts/lib/orchestrator-profile.mjs` — added `'ListAgents'` to
  `ENFORCE_ALLOWED_TOOLS` (the single declaration, ARCH-010) with a comment
  explaining it is lane control's missing read half; updated the "Still available
  here" prose in `refusalReason()` to name it. `scripts/verify-orchestrator-enforcement.mjs`
  — new section 3b. No other file touched. (`orchestrator-profile.d.mts` needs no
  change: `ENFORCE_ALLOWED_TOOLS: string[]`.)
- **Verified:** `npm run verify:orchestrator-enforcement` → **144/144 PASS**
  (graded against 1993 real tool calls from the transcript store).
  `npm run verify:orchestrator-surface` → **67/67** (shares the module).
  Must-FAIL proof, demonstrated honestly: removing `'ListAgents'` from the
  allowlist reddens exactly the two new assertions (142/144); restoring → 144/144.
  The in-suite synthesized must-FAIL (section 3b) reconstructs the pre-fix
  allowlist by filtering `ListAgents` out of the current one and models decide()'s
  final branch, so it keeps biting after commit without anchoring to HEAD.
  `npm run board:check` → clean. `npm run gate` → exit 0, read directly, unpiped.
- **Takes effect when:** NOT for already-running sessions. `decide` is a static
  import in `claude-runtime.ts`, loaded once at server boot, and the profile/hook
  is composed per session at `startSession()`. So this source change is picked up
  only at the service's next restart, and then only by newly launched sessions —
  same deploy semantics FEAT-096 recorded. The service was not restarted by this
  lane (standing rule).
- **Still open / handoff:** independent clean-room verify warranted — this edits
  a PreToolUse enforcement gate ahead of every tool call in every enabled project
  (FEAT-096/BUG-185 regression-prone lineage). A verifier should confirm: (1) the
  harness actually emits the literal name `ListAgents` to the hook (the SDK alias
  evidence says yes; a live payload would close it); (2) `ListAgents` carries no
  read of the tree that would reintroduce the context-bloat the profile removes;
  (3) a dispatched lane still keeps everything (the `agentId` exemption is
  untouched).
- **Symptom of a deeper design flaw?** Not closing the ticket, so the closing
  answer is not due. Noted for whoever closes it: this is a small instance of the
  same shape FEAT-096 flagged (design-time tool names vs runtime reality) — the v0
  surface named the lane verbs it imagined and missed the liveness read; ARCH-013
  already covers that class, so probably no new ARCH ticket is warranted.

### 2026-10-01 — independent clean-room verify (verifying, round 1) — BLOCKED, no verdict

- **Goal:** same-provider (anthropic; openai quota-blocked to 2026-10-05) clean-room verify
  dispatch via `scripts/independent-verify.mjs`, attacking: ListAgents allowed; no file-read/
  search tool allowed alongside it; the "Still available here" prose matches the real allowlist;
  the agentId lane exemption untouched.
- **Prep done + validated:** scoped diff = scripts/lib/orchestrator-profile.mjs +
  scripts/verify-orchestrator-enforcement.mjs over a `base..head` range (room = full coherent
  working tree, diff limited to these 2 files); requirement + attack plan written.
- **BLOCKER (hard, shared with FEAT-160's verify leg):** `independent-verify.mjs` cannot run
  under the agent git-write guard. Its hardened diff runs `git -c diff.submodule=short diff …`
  (independent-verify.mjs GIT_CFG ~line 1098); the guard's `CONFIG_KEY_ALLOWED`
  (scripts/lib/git-write-policy.mjs:186-189) allowlists only `core.quotepath`/`color.*`/`advice.*`,
  so `diff.submodule` is refused as a git WRITE at the invocation layer. Probed: all other git
  reads the tool needs (rev-parse, archive, plain diff, `-c core.quotePath=false`) pass; only the
  `-c diff.submodule=short` call is blocked. Both tools are uncommitted — the conflict blocks ALL
  clean-room verification from guarded agent sessions. No verdict recorded; guard not lifted.
- **Unblock (pick one), then re-dispatch:** (a) `node scripts/git-grant.mjs orchard --minutes 20`
  (not `--once` — several blocked diff calls per run); or (b) add `diff.submodule` to
  `CONFIG_KEY_ALLOWED` (inert display setting, same class as `core.quotepath`); or (c) make the
  `-c diff.submodule=short` flag conditional on submodules existing (none here). Root-cause:
  ARCH-021 (git-write enforcement is a shell-text parser).

### 2026-10-01 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 9a3e17fc-55e9-414d-bf77-192debd589cc — VERDICT: BROKEN. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-01 — independent clean-room verify (verifying, round 1) — VERDICT: BROKEN

- **Unblocked by BUG-228** (git-write guard now allows `-c diff.submodule=short`), so the
  clean-room dispatch ran. Same-provider (anthropic; openai quota-blocked to 2026-10-05 —
  decorrelation reduced). Scoped base..head range: diff = scripts/lib/orchestrator-profile.mjs
  + scripts/verify-orchestrator-enforcement.mjs only; room = full working tree.
- **Verdict:** dispatch anthropic run `9a3e17fc-55e9-414d-bf77-192debd589cc` — **BROKEN**
  (recorded typed in verification-ledger.json via board-tool). Valid verdict: fixer test
  re-run (140/0/1), one manifest-backed adversarial case (`04509dc692c2`), could-not-test
  list present.
- **Property that held:** ListAgents IS allowed for an orchestrator (P1); read/search/raw
  Bash still refused and the agentId lane exemption untouched (P2).
- **Property that BROKE (P3 — denial prose must match the real allowlist):** the "Still
  available here" prose in `refusalReason()` (scripts/lib/orchestrator-profile.mjs ~751-753)
  OMITS 9 tools that `ENFORCE_ALLOWED_TOOLS` allows — TaskCreate, TaskUpdate, TaskGet,
  TaskList, Workflow, Skill, TodoWrite, ExitPlanMode, ToolSearch. Confirmed against source
  by the orchestrator. The fixer test only regex-checks the prose for "ListAgents"; it never
  diffs the prose against the allowlist, so the drift was invisible. Root cause: the prose is
  hand-maintained, not built from `ENFORCE_ALLOWED_TOOLS` — an ARCH-010 second-place-holds-
  a-different-answer smell (one owner for the allowed set, but the help text re-derives it).
- **Could not test (verifier's honest list):** live PreToolUse hook path end-to-end (needs
  the live service on 4317 — off-limits); whether the harness emits the literal "ListAgents"
  vs "ListPeers" to the hook (needs a live CLI; ListPeers confirmed still denied);
  real-corpus grading (transcript store absent in the clean room); the process-wide
  allowedTools/disallowedTools config at claude-runtime.ts ~954-955 that could gate before
  decide() runs.
- **Handoff to the fixer:** build the "Still available here" prose FROM `ENFORCE_ALLOWED_TOOLS`
  (or narrow the P3 claim), and extend verify-orchestrator-enforcement.mjs to diff the prose
  against the allowlist in both directions. First break (two-break STOP not reached).

### 2026-10-01 — fix P3: generate "Still available here" prose from the allowlist (fixing round 2)

- **Understood:** the round-1 clean-room verify (dispatch anthropic run
  `9a3e17fc-55e9-414d-bf77-192debd589cc`, VERDICT BROKEN) found P3 — the hand-written
  "Still available here" prose in `refusalReason()` omitted 9 tools
  `ENFORCE_ALLOWED_TOOLS` allows (TaskCreate/Update/Get/List, Workflow, Skill, TodoWrite,
  ExitPlanMode, ToolSearch). An ARCH-010 second-place-holds-a-different-answer defect: the
  allowlist has one owner, but the help text re-derived it by hand.
- **Changed:** `scripts/lib/orchestrator-profile.mjs` — new exported `stillAvailableHere()`
  that GENERATES the line from `ENFORCE_ALLOWED_TOOLS` (one owner, read everywhere else) and
  derives the Bash-subset wording from `ENFORCE_ALLOWED_BASH` (its own single owner), so both
  halves move with the policy automatically. A tiny `STILL_AVAILABLE_GLOSS` map carries the
  one-phrase gloss (only ListAgents today) as pure decoration — a gloss keyed to a dropped
  name is simply unused, so it can never make the line claim a denied tool. `refusalReason()`
  now splices `...stillAvailableHere()` in place of the three literal prose lines. NOT a check
  comparing two hand lists (ARCH-010 forbids that). `scripts/lib/orchestrator-profile.d.mts` —
  declared `stillAvailableHere(): string[]`. `scripts/verify-orchestrator-enforcement.mjs` —
  new section 3c asserting, against the REAL `decide().reason`, that the prose names EVERY
  allowlist tool (direction 1), claims NO denied tool (direction 2, via KNOWN_DENIED minus the
  allowlist), lists the Bash heads from `ENFORCE_ALLOWED_BASH`, and the 9 previously-dropped
  tools specifically; plus a synthesized pre-fix-hand-list must-FAIL that reddens on the exact
  prose this replaced (not HEAD-anchored).
- **Verified:** `npm run verify:orchestrator-enforcement` → **157/157 PASS** (was 144; +13).
  `npm run verify:orchestrator-surface` → **67/67** (shares the module). Must-FAIL proven
  BOTH in-suite and externally: reverting `stillAvailableHere()` to the round-1 hand-list
  reddened exactly the 11 new section-3c assertions (146/157), naming the 9 omitted tools and
  the omitted Bash heads; restoring → 157/157. `npm run gate` → **exit 0**, read directly
  unpiped (leak-gate + check-nul + typecheck all PASS).
- **BUG-228 (not touched):** its guard change (`git-write-policy.mjs`: `diff.submodule`
  allowed for short|log|diff, fail-closed otherwise) IS independently covered —
  `scripts/verify-feat-108-git-write-block.mjs:268-279` asserts the allow and the
  fail-closed on unknown/missing values. Per charter, left untouched.
- **Takes effect when:** same deploy semantics as round 1 — `decide` is a static import in
  `claude-runtime.ts`, so this source change lands only at the service's next restart and only
  for newly launched sessions. Service not restarted by this lane (standing rule).
- **Still open / handoff:** re-run the independent clean-room verify (the round-1 BROKEN verdict
  stands until a fresh HOLDS supersedes it) — attack P3 again (prose == allowlist, both
  directions) plus P1/P2 which held. This edits a PreToolUse enforcement gate ahead of every
  tool call in every enabled project, so an independent pass is warranted (regression-prone
  lineage).

### 2026-10-01 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 3e4f4a6d-6ee4-46c5-ac7f-add5a9e45ac1 — VERDICT: BROKEN. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-01 — independent clean-room verify (verifying, round 2) — VERDICT: BROKEN

- **Run:** dispatch anthropic run `3e4f4a6d-6ee4-46c5-ac7f-add5a9e45ac1`, model `claude-opus-5`,
  via `scripts/independent-verify.mjs` (recorded typed in verification-ledger.json via board-tool).
  Verdict-contract: VALID (fixer test re-run EXIT 0 → 153/0/1; two manifest-backed adversarial
  cases; could-not-test list present). Same-provider only (anthropic; OpenAI quota-blocked to
  2026-10-05 — **decorrelation reduced**, cross-provider re-verify due after that date).
- **Scope / range:** `base e43cff6..head 73b259f`; `git diff --name-only` = EXACTLY the 3 round-2
  scope files (scripts/lib/orchestrator-profile.mjs, scripts/lib/orchestrator-profile.d.mts,
  scripts/verify-orchestrator-enforcement.mjs), 11335 diff bytes; room = full working tree, docs
  stripped, board/methodology excluded by predicate.
- **Round-1 P3 drift IS fixed:** the generated `stillAvailableHere()` line now names all 16
  allowlisted tools (the 9 previously-omitted ones included) on the ordinary Read/Grep refusal
  path, and the control case confirms the checker is sound. P1 (ListAgents allowed; ListPeers
  behaves as intended) and P2 (no read/search/raw-Bash tool allowed; agentId lane exemption
  untouched) **HELD** — no adversarial case broke them.
- **P3 BROKE AGAIN through TWO DIFFERENT paths (this is the second break — TWO-BREAK STOP reached):**
  - **(a) A whole second refusal path emits no list at all.** A Bash call whose first line is a
    PRESENT-but-INVALID `# ORCH-BYPASS:` marker is refused via `invalidBypassReason()`
    (scripts/lib/orchestrator-profile.mjs:697), whose message contains NO "Still available here"
    section — all 16 tools and all 27 Bash heads omitted. `stillAvailableHere()` is spliced only
    into `refusalReason()`, not into the bypass-rejection path. (adversarial case
    `invalid-orch-bypass-refusal-has-no-still`, run 748f66a9e5bd, 9 property violations.)
  - **(b) The generated Bash half still drifts from the real Bash verdict.** The line advertises
    head `npx` as allowed (derived from `ENFORCE_ALLOWED_BASH`), but `decideBashCommand` refuses
    `npx <anything>` unconditionally via `ENFORCE_HEAD_ARG_RULES.npx` (line 419) — a SECOND owner
    of the Bash verdict that `stillAvailableHere()` (line 734) does not read. So the message names
    something the policy denies. (adversarial case `advertised-bash-head-npx-is-actually-ref`, run
    2eb65f674dd4, 1 property violation.)
- **Classification — enumerated property, route to single-authority redesign.** Round-1 and
  round-2 are the same property (the refusal message must equal the real allow decision) broken
  through three distinct routes (hand-list omission → one path generated but a second refusal path
  ungenerated → Bash half reads one of two Bash owners). Fixing each route as found is the pattern
  the two-break STOP exists to halt. The durable fix is single-authority: EVERY refusal path must
  carry a help line, and that line's tool/Bash sets must be derived from the SAME function that
  `decide()`/`decideBashCommand` actually use to allow (not from `ENFORCE_ALLOWED_BASH` alone,
  which is not the single owner of the Bash verdict). Recommend an ARCH ticket (ARCH-010 class) /
  a redesign charter rather than a round-3 spot fix.
- **Could not test (verifier's honest list):** (1) real-corpus half of the author's suite (584
  live orchestrator calls) — transcript store absent in the clean-room checkout, so it SKIPped;
  (2) the live PreToolUse hook delivery of `decide().reason` — whether the now-longer generated
  message is truncated/wrapped/dropped before the model sees it is outside the runnable surface
  (live service on 4317 off-limits); (3) whether the live SDK emits the liveness tool as
  `ListAgents` vs `ListPeers` at the hook boundary — only `ListAgents` is allowlisted and the real
  payload name cannot be observed from the room.
- **Handoff:** the round-1/round-2 BROKEN verdicts stand until a fresh HOLDS supersedes them. This
  edits a PreToolUse enforcement gate ahead of every tool call in every enabled project
  (regression-prone lineage); a further independent pass IS warranted after the single-authority
  redesign lands, and a cross-provider (OpenAI) re-verify is due after 2026-10-05.

### 2026-10-01 — single-authority redesign PLAN (fixing round 3, class plan+review)

**Every refusal path enumerated (step 1).** Two message-builders in
`scripts/lib/orchestrator-profile.mjs`, reached from `decide()`:
  1. `refusalReason(name, offender)` — Bash refused (no/absent bypass), decide() line 858. HAS help.
  2. `refusalReason(name, null)` — non-Bash tool not in allowlist, decide() line 865. HAS help.
  3. `invalidBypassReason(problem)` — Bash refused + a PRESENT-but-INVALID `# ORCH-BYPASS:` marker,
     decide() line 856. **NO help** (round-2 break a).
Plus two fail-closed error messages in `src/server/runtime/claude-runtime.ts`
`evaluateOrchestratorProfileHook()`: (4) decide() threw (line ~654); (5) the bypass recorder threw
(line ~669). Both are "could not evaluate / record" errors, no help. (The git-write block ~1120 and
file-lock ~1180 are DIFFERENT policies — not orchestrator-profile refusals — out of scope.)
`decideBashCommand` returns an offender but no message; the message is always built in decide().

**Root cause of the two round-2 breaks — two ARCH-010 second-owner defects:**
  - (a) the help is spliced into `refusalReason()` only, not into the other refusal paths.
  - (b) `stillAvailableHere()` derives the Bash half from `ENFORCE_ALLOWED_BASH` alone, but the real
    Bash verdict has a SECOND owner `ENFORCE_HEAD_ARG_RULES`. `npx` sits in BOTH — the allowlist
    (says allowed) and `ENFORCE_HEAD_ARG_RULES.npx = () => 'npx'` (unconditional refuse) — so the two
    owners disagree and the advertiser reads the wrong one.

**Plan (single authority — EVERY refusal built by one function; help derived from the SAME authority
that grants):**

  - **One refusal builder.** New internal `buildRefusal({ lead, readShaped })` in the .mjs: appends
    the board:status redirect (when readShaped) and ALWAYS `...stillAvailableHere()` + `...BYPASS_CRITERIA`.
    `refusalReason()` and `invalidBypassReason()` both become thin — each builds only its own LEAD
    lines (what/why/do-instead vs. the malformed-marker explanation) and calls `buildRefusal`. No
    orchestrator-profile refusal path can then omit the help, structurally. Fixes (a).
  - **Fail-closed TS messages (4,5).** Append `stillAvailableHere()` (already exported) to both, so
    the uniform property "every refusal tells the session what IS available" holds even on the crash
    paths — closing the next door before the verifier finds it. (Judgment call flagged to reviewer:
    these are error messages of a different kind; leaning include for uniformity.)
  - **Bash half derived from the real decider (fixes b).** Remove `npx` from `ENFORCE_ALLOWED_BASH`
    (it has ZERO allowed shapes — it never belonged in an allowlist; functionally inert, npx stays
    refused). KEEP `ENFORCE_HEAD_ARG_RULES.npx` — it still refuses `… | npx foo` in a filter stage
    where the stage-0 allowlist check is skipped. Then advertise via a new `allowedBashHeads()` that
    FILTERS `ENFORCE_ALLOWED_BASH` to heads for which `decideBashCommand` actually allows a
    representative invocation — so the advertiser ASKS the decider rather than re-reading one of its
    two declarations. Any future listed-but-always-refused head is then auto-excluded (fail-safe:
    under-advertises, never over-advertises). `stillAvailableHere()` reads `allowedBashHeads()` and
    states the per-argument restriction generically, naming the restricted heads from
    `Object.keys(ENFORCE_HEAD_ARG_RULES)` so it can't claim an unrestricted head is restricted.

**Tests (new section 3d in verify-orchestrator-enforcement.mjs), each reddening on a synthesized
pre-fix variant (not HEAD-anchored):**
  - P-tools: every tool named in `stillAvailableHere()` is allowed by the REAL `decide()` (not merely
    ∈ ENFORCE_ALLOWED_TOOLS).
  - P-bash: every head in `allowedBashHeads()` has ≥1 shape `decideBashCommand` allows; `npx` is NOT
    advertised AND `decideBashCommand('npx tsx x').allow === false`. MUST-FAIL: advertised = raw
    ENFORCE_ALLOWED_BASH with npx re-added advertises a head the decider refuses (guard bites).
  - P-every-refusal: non-Bash refusal, Bash-read refusal, AND invalid-bypass refusal (`# ORCH-BYPASS: x`
    + grep) each carry "Still available here" + all 16 tools + the Bash heads. MUST-FAIL: the pre-fix
    `invalidBypassReason` (synthesized, no help) OMITS the help (guard bites).
  - Run verify:orchestrator-enforcement, verify:orchestrator-surface, and `npm run gate` (exit 0).

Independent plan review dispatched (anthropic/claude-opus-5) before building — its job: find a
refusal path or an advertised-but-refused command this plan misses.

**Plan review — dispatch anthropic/claude-opus-5 run `db98e6a7-37df-463f-8014-1654da87a37e`
(meta /tmp/bug226-review-meta.json). Verdict: plan has gaps. Six findings, ALL verified against
source and folded into the build:**
  1. MISSED refusal path — `claude-runtime.ts:589-599` `makeOrchBypassRecorder`: when
     `recordOrchBypass()` RETURNS false (unwritable audit dir / ENOSPC / EMOVED) the recorder returns
     a deny with no help. A routine refusal (no crash) — round-2 break (a) repeating. Add help.
  2. MISSED refusal path — `claude-runtime.ts:1204-1216` the registered callback's OUTER catch (a
     profile deny for a throw in the git block / Fable gate / file lock, which run before the profile
     guard). Its message is a char-for-char DUPLICATE of the :654-656 fail-closed string — hoist to
     ONE shared const, don't append help to one copy and not the other.
  3. ADVERTISED-but-refused — the git gloss "(the gate, the board, **your own commits**)": the
     git-write block is default-ON (git-write-policy.mjs:48) and runs at :1104 BEFORE decide(), so
     the orchestrator's commits are denied by default. Drop the commit promise (head `git` keeps
     status/log reads). NOT coupling the profile to git-write-policy — just stop promising commits.
  4. `npx` reappears as a "restricted head" if the restricted list is `Object.keys(ENFORCE_HEAD_ARG_RULES)`
     (npx is still a key after removal). Intersect restricted-heads with `allowedBashHeads()`.
  5. The probe is unsound as "bare head": `decideBashCommand('node')` is REFUSED (`node (stdin)`),
     so a bare-head filter would DROP `node` (the dispatch/board/verifier runner) — a false negative
     that under-advertises a kept tool. Use a generic two-shape probe `{H, 'H ./x.mjs'}`, advertise if
     EITHER allows (includes node via the script shape, still excludes npx). A per-head invocation
     table would be a THIRD owner — rejected.
  6. Test-design: P-tools-vs-decide is near-tautological, and `reason.includes('node')` is MASKED (a
     read-shaped refusal already contains "(node/npm only)"), so section 3d must token-match inside
     the GENERATED `stillAvailableHere()` Bash line, not substring the whole reason.
  Plus: the TS help-append must be guarded (try/catch) — those messages fire BECAUSE the profile
  module threw, so calling back into it unguarded could re-throw inside the hook. The four TS
  profile-refusal messages (:589, :654, :668, :1212) all take the help from ONE exported helper.
  TS paths are already covered by verify-feat-152 cases 4a/5f/6c — extend those to assert the help.

### 2026-10-01 — single-authority redesign BUILT + verified (fixing round 3)

- **Refusal paths unified.** `scripts/lib/orchestrator-profile.mjs`: new `buildRefusal({lead, readShaped})`
  — the ONE builder every refusal message routes through; it appends the board:status redirect (when
  read-shaped) and ALWAYS `stillAvailableHere()` + bypass criteria. `refusalReason()` and
  `invalidBypassReason()` now supply only their lead (fixes round-2 break a — invalid-bypass had no
  help). `boardStatusRedirect()` extracted. `src/server/runtime/claude-runtime.ts`: the FOUR
  TS profile-refusal messages (ledger-not-written :589, decide()-threw :654, bypass-recorder-threw
  :668, outer-catch :1212) now all take the help from ONE guarded helper `withProfileHelp()`; the two
  "could not be evaluated" sites (was a char-for-char duplicate — plan-review finding B) share
  `profileEvalFailedReason()`. Guarded try/catch so a throw from the (just-threw) profile module
  degrades to the bare message, never takes the session down.
- **Advertisement derived from the deciders (fixes round-2 break b).** Removed `npx` from
  `ENFORCE_ALLOWED_BASH` (zero allowed shapes — a contradiction with its own arg rule; inert at
  runtime, the arg rule still refuses `… | npx` at filter stages). New `allowedBashHeads()` asks
  `decideBashCommand` itself (two generic probe shapes `{H, 'H ./x.mjs'}`, advertise if either allows)
  so an allowlisted-but-always-refused head can never be advertised and `node` (bare-refused,
  script-allowed) is NOT dropped (plan-review finding 5). `restrictedBashHeads()` ∩ `allowedBashHeads()`
  so npx can't return as "restricted" (finding 4). `stillAvailableHere()` reads both and drops the
  "your own commits" promise (git-write block denies commits by default — finding 3).
  `scripts/lib/orchestrator-profile.d.mts` updated.
- **Tests.** New section 3d in `scripts/verify-orchestrator-enforcement.mjs` (token-parsed Bash line,
  not substring — finding 6): every refusal path (incl. the invalid-bypass route) carries the help +
  all 16 tools; every advertised head has an allowed shape; npx neither advertised nor allowed; `node`
  advertised; no git-commit promise; every advertised tool allowed by `decide()`. Two synthesized
  must-FAIL proofs (not HEAD-anchored). verify-feat-152 cases 4a/5f/6c extended to assert the TS paths
  carry the help.
- **Verified:** `verify:orchestrator-enforcement` → **250/250 PASS** (was 157; +93; corpus 2028 calls).
  EXTERNAL must-FAIL honestly demonstrated: reverting the three product fixes (re-add npx, raw-allowlist
  Bash half, help-less invalidBypassReason) reddened exactly 5 section-3d assertions reproducing both
  round-2 breaks; restored → 250/250. `verify:orchestrator-surface` → **67/67**. `verify:feat-152` →
  **132/132 PASS** (TS refusal paths 4a/5f/6c now assert the help). `npm run gate` → **exit 0** read
  directly unpiped (leak-gate + check-nul + typecheck — typecheck confirms the TS compiles).
  `board:check` → OK (pre-existing advisory/stale warnings only). `verify:orchestrator-enforcement-e2e`
  → 10–11/12 across two runs: ONLY the two NL free-text-reply assertions (B:100/B:102) vary by run —
  the deterministic policy-delivery assertions (B:94/96/98/104, "Orchestrator tool profile" + grep +
  Agent tool delivered, Agent dispatched) PASS both runs. Model-output nondeterminism in the e2e, not
  a code defect; the delivered reason is correct and complete.
- **Takes effect when:** same deploy semantics — `decide` is a static import in `claude-runtime.ts`,
  so this lands only at the service's next restart and only for newly launched sessions. Service not
  restarted (standing rule).
- **Still open / handoff:** re-run the independent clean-room verify — the round-1/round-2 BROKEN
  verdicts stand until a fresh HOLDS supersedes them. This edits a PreToolUse enforcement gate ahead
  of every tool call in every enabled project (regression-prone lineage) AND is a session-lifecycle /
  enforcement change, so an independent clean-room pass IS warranted. Attack: enumerate EVERY
  refusal/deny message across orchestrator-profile.mjs AND claude-runtime.ts and confirm each carries
  the help; confirm `allowedBashHeads()` never advertises a `decideBashCommand`-refused shape and
  never drops a kept head; confirm the git-commit promise is gone. Cross-provider (OpenAI) re-verify
  due after 2026-10-05.

### 2026-10-01 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 96a5ddad-2b33-4b6d-8c3b-107a95ae221a — VERDICT: BROKEN. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-01 — independent clean-room verify (verifying, round 3) — VERDICT: BROKEN

- **Run:** dispatch anthropic/`claude-opus-5` run `96a5ddad-2b33-4b6d-8c3b-107a95ae221a`, via
  `scripts/independent-verify.mjs`. Recorded typed in verification-ledger.json via board-tool.
  Verdict-contract: **VALID** (fixer suite re-run EXIT 0 → 246 pass / 0 fail / 1 skip; TWO
  manifest-backed adversarial cases; could-not-test list present). Same-provider (anthropic author +
  anthropic verifier; OpenAI quota-blocked to 2026-10-05 — **decorrelation reduced**, cross-provider
  re-verify due after).
- **Scoped base..head:** `ba45da5c2990..6802f321453b` (41502 diff bytes). Diff = the round-3 surface
  (orchestrator-profile.mjs, orchestrator-profile.d.mts, verify-orchestrator-enforcement.mjs,
  claude-runtime.ts, verify-feat-152-orch-bypass.mts). Room = full working tree, docs stripped. Kept at
  `~/.local/state/claude-station/scratch/cleanroom-verify-YI5Z8h`
  (manifest `~/.local/state/claude-station/scratch/cleanroom-record-qYz000/manifest.jsonl`).
- **HELD (adversarial `wide-refusal-path-and-head-matrix-sweep`, run 79b14528e2d2, 0 failed):** the
  round-3 single-authority unification itself holds across ~100 refusal payloads plus the live runtime
  refusal sites — every refusal path (incl. the invalid-`# ORCH-BYPASS:` route and the fail-closed
  paths) carries the help; re-deriving "kept head" from an independent 10-shapes-per-head matrix (vs the
  fix's own two probes) agreed; ListAgents allowed, no read/search TOOL allowed, lane exemption intact.
- **BROKE — the advertised-vs-real-Bash-verdict property, through a NEW route (adversarial
  `help-claims-vs-real-decider-reads`, run 95cf796b6205, EXIT 1, 9 help-contradicting ALLOWED shapes):**
  the generated help asserts "git content subcommands (show/diff/log -p) and any file read or
  tree-search are refused", but `decideBashCommand` ACTUALLY ALLOWS, all via the advertised `git`/`curl`
  heads:
  - `git -c core.pager=cat show HEAD:package.json` (and the `diff` / `log -p` twins) — `subcommandOf`
    takes the first non-dash word, so `core.pager=cat` is read as the subcommand and
    `ENFORCE_DENIED_GIT_SUBCOMMANDS` (orchestrator-profile.mjs:320, checked ~612-625) never sees
    `show`/`diff`/`log`. This is a working **arbitrary-file read** by the orchestrator (`cat` of any
    blob at HEAD) — not merely a false help sentence but a hole in the profile's core "no read tool"
    guarantee (requirement bullet 4).
  - `git stash show -p`, `git whatchanged -p -2` (a `log -p` synonym), `git ls-files src`,
    `git ls-tree -r HEAD` — all allowed via the advertised `git` head; file bodies and tree listings.
  - `curl file:/etc/hostname` and `curl -s file:/etc/hostname` — `ENFORCE_HEAD_ARG_RULES.curl`
    (orchestrator-profile.mjs:436-438) matches only the literal `file://`, so the single-slash form
    reads a local file; the advertised exclusion is one slash wide.
  Controls (`git show HEAD:…`, `git diff HEAD`, `git log -p`, `curl file:///…`, `cat`, `rg`) all
  correctly refused, so the checker is sound.
- **Classification — same property, new route; this is a real READ-TOOL hole, not only a prose drift.**
  Rounds 1-2 broke "the refusal message must equal the real allow decision" via hand-list omission and
  the npx disagreement; round 3 fixed those but the Bash verdict still has shapes the advertiser calls
  refused that the decider allows — and several of them (`git -c … show`, `git ls-tree`, `git ls-files`,
  `curl file:/`) are the exact file-read / tree-search capability the profile exists to deny. The durable
  fix must harden `decideBashCommand` itself (treat `git -c k=v <subcmd>` by resolving the real
  subcommand past `-c` pairs; deny `stash show -p`/`whatchanged`/`ls-files`/`ls-tree`; match `curl
  file:` not just `file://`) AND keep the advertiser reading the hardened decider.
- **Could-not-test (verifier's honest list):** the real-corpus half of the fixer suite SKIPPED (584 live
  orchestrator calls — transcript store absent in the clean room); `verify:orchestrator-surface` could
  not run at all (ENOENT on docs/analysis/orchestrator-design-attack-2026-08-20.md — the docs/analysis
  tree is stripped from the room), so the surface/registry half is ungraded here; the live PreToolUse
  wiring against a real SDK session (and the interaction with the git-write gate / FEAT-129 file lock on
  an actual commit/Write) was driven in-process only — service on 4317 off-limits; whether
  Edit/Write/TaskGet/Skill the help advertises are in practice denied by those OTHER gates in a live
  session (only decide()'s permit was checked).
- **Handoff:** the round-1/2/3 BROKEN verdicts stand until a fresh HOLDS supersedes them. This edits a
  PreToolUse enforcement gate ahead of every tool call in every enabled project AND the new finding is a
  file-read capability hole in the orchestrator profile — HIGH-STAKES / security-adjacent, so an
  independent re-verify is REQUIRED after the next fix, and a cross-provider (OpenAI) pass is due after
  2026-10-05.

### 2026-10-01 — harden decideBashCommand: flip git/curl to allow-known-good (fixing round 4, class plan+review)

**Why a structural fix (WA §N), not another spot patch.** Rounds 1-3 each fixed the *advertiser* (the
help prose) to match the decider; round 3's clean-room (run `96a5ddad…`, BROKEN) proved the decider
ITSELF is wrong — `decideBashCommand` ALLOWS real file reads / tree listings: `git -c core.pager=cat show
HEAD:<file>` (and the diff/log twins), `git stash show -p`, `git whatchanged -p`, `git ls-files`,
`git ls-tree`, and `curl file:/<path>` (single slash). These are the exact capability the profile exists
to deny (requirement bullet 4). Root cause: the Bash policy for `git`/`curl` is a **deny-list of
known-bad shapes** — `ENFORCE_DENIED_GIT_SUBCOMMANDS` + a one-off `curl` `file://` match — and a deny-list
is leaky by construction (third break of "advertised == actually decided"). The fix flips to
**allow-known-good argv shapes**, default-deny, so a shape nobody enumerated fails SAFE (refused, naming
the dispatch alternative) instead of reading.

**Step 1 — inventory of real orchestrator usage (corpus of 574 Bash calls since 2026-08-18 + the
ORCH-BYPASS audit ledger at `~/.local/share/claude-station/orch-bypass-audit/`):**
  - `git`: status (99), log (61, ALL `--oneline`/`--format`/`--name-only`/`--since` — none `-p`), commit
    (55), diff (38 — the real forms are `--stat`/`--numstat`/`--name-only`/`--shortstat`/`--cached
    --name-only`/`--stat -- <paths>`; also some BARE `git diff <path>` which dumps content and SHOULD be
    redirected), add (36), branch (6), rev-parse (2), remote (2), push (5), checkout (2), worktree (9 —
    `list`/`prune`/`remove`), rev-list (2), bundle (7). No legitimate `git -c …` invocation exists in the
    corpus — the only `-c <subcmd>` shapes are the round-3 exploit.
  - `curl`: 14 calls, ALL `http://127.0.0.1:4317/…` (dev-server health checks). Zero `file:`, zero remote.
    The ORCH-BYPASS ledger's one curl is also `localhost:3456`. → curl belongs, **localhost-only**.

**Plan (harden the decider; keep the advertiser reading the hardened decider).**

  1. **git: resolve the REAL subcommand past global options, then ALLOW-LIST subcommands.**
     New `resolveGitSubcommand(words)` skips leading git global options — `-c name=value` and `-C <path>`
     and `--git-dir`/`--work-tree`/`--namespace`/`--super-prefix`/`--config-env` (value-taking; consume the
     next token when not `=`-joined), plus valueless globals (`--no-pager`/`-p`/`--paginate`/`--bare`/
     `--literal-pathspecs`/`--exec-path[=…]`/`--version`/…) — and returns the first bare token as the
     subcommand. So `git -c core.pager=cat show HEAD:x` resolves to `show`, closing the primary hole.
     New `GIT_ALLOWED_SUBCOMMANDS` (default-deny). Partition:
       - status/ref reads (no content): status, rev-parse, rev-list, branch, remote, symbolic-ref,
         show-ref, for-each-ref, merge-base, describe, name-rev, var, ls-remote, check-ignore, shortlog,
         count-objects.
       - read-shaped, flag-gated: `log`, `diff` (see 2).
       - writes/management that emit NO tracked-file content (git-write-policy is their real gate, and it
         runs BEFORE decide() per round-3 plan-review finding 3): commit, add, push, fetch, pull, checkout,
         switch, restore, reset, merge, rebase, cherry-pick, revert, worktree, bundle, tag, clean, mv, rm.
       - **Excluded ⇒ denied by default** (the readers/dumpers, incl. all round-3 holes): show, grep,
         blame, cat-file, ls-files, ls-tree, whatchanged, archive, format-patch, **stash** (so
         `git stash show -p` dies at the subcommand gate), notes, reflog, config, instaweb.
     A subcommand not in the set is refused `git <sub>`. Bare `git`/`git --version` (no subcommand) is
     allowed (harmless).
  2. **git log/diff flag gate (defense in depth + the diff split).**
     `GIT_CONTENT_FLAG` (patch/pickaxe/line emitters: `-p`,`-u`,`--patch`,`--patch-with-*`,`-U<n>`/
     `--unified`,`-W`/`--function-context`,`--word-diff`,`--color-words`,`-G…`,`-S…`,`-L…`) → any present
     on a `log`/`diff` command ⇒ refuse. For `diff` ALSO require a content-free summary flag (`--stat`,
     `--numstat`,`--shortstat`,`--summary`,`--name-only`,`--name-status`,`--compact-summary`,`--dirstat`,
     `--raw`,`--check`,`--quiet`,`--exit-code`,`--cumulative`); bare `git diff`/`git diff <path>` has none
     ⇒ refused (content dump → dispatch instead). The content-flag gate is scoped to log/diff so it cannot
     collide with `git commit -S` (GPG-sign).
  3. **git handled at EVERY pipeline stage** by moving it into `ENFORCE_HEAD_ARG_RULES.git` (today the git
     block is stage-0-only, so `npm run gate | git show HEAD:x` leaks a read in a filter stage). The arg
     rules already run at every stage like EXEC_VERBS.
  4. **curl: localhost-only, quote-robust.** Replace the `file://`-substring rule. A curl command is
     refused if, in the region from `curl` to the next shell separator (scanned on the RAW text so a
     QUOTED `curl "file:/etc/passwd"` — which the quote-strip would otherwise blank and silently allow —
     is still caught): (a) any non-http(s) scheme-with-slash appears (`file:/`,`file://`,`ftp://`,
     `gopher:`,`dict:`,`scp:`,… ⇒ `curl non-http scheme`); (b) any `http(s)://HOST` whose HOST is not
     localhost/127.0.0.1/0.0.0.0/[::1] ⇒ `curl to a non-local host`; (c) any scheme-less `host.tld`/bare-IP
     target that is not local ⇒ same. Scheme-less `localhost[:port]/path` (the real corpus shape) passes.
     Documented limit: an unusual unquoted flag VALUE that looks like a remote host over-denies (safe
     direction).
  5. **Advertiser reads the hardened decider.** `allowedBashHeads()`/`restrictedBashHeads()` already ask
     `decideBashCommand`; git stays advertised (bare `git` allows), curl stays advertised (local forms
     allow). `stillAvailableHere()` prose updated so its "refused" claims (git show/diff-bare/log -p/
     ls-files/ls-tree/whatchanged/grep/blame; curl file:/non-local) are TRUE — and every such claim is
     backed by a decider PROBE in the test (single authority: the help never asserts a refusal the decider
     doesn't make). `ENFORCE_DENIED_GIT_SUBCOMMANDS` is replaced by `GIT_ALLOWED_SUBCOMMANDS` (exported;
     `.d.mts` + the suite's import updated).

**Tests (verify-orchestrator-enforcement.mjs).**
  - Section 5 bashCases: each round-3 escape added as `deny` (`git -c core.pager=cat show HEAD:…`,
    `git stash show -p`, `git whatchanged -p -2`, `git ls-files src`, `git ls-tree -r HEAD`,
    `curl file:/…`, `curl file:///…`, `curl "file:/…"`); plus kept-good as `allow` (`git diff --stat`,
    `git diff --cached --name-only`, `git log -1 --format=%B`, `git worktree list`,
    `curl -s http://127.0.0.1:4317/app.js`) and bare `git diff <path>`/`curl example.com`/`curl http://evil.com`
    as `deny`.
  - New Section 3e — PROPERTY + MUST-FAIL (synthesized pre-fix, NOT HEAD-anchored): a reconstruction of the
    pre-fix git subcommand finder (`words.find((w,j)=>j>0 && !w.startsWith('-'))`) resolves
    `git -c core.pager=cat show HEAD:x` to `core.pager=cat` (not `show`) and therefore would NOT deny it —
    proving the hole and that the new decider closes it; and the help's refusal claims are each asserted
    against the REAL `decideBashCommand`.
  - Section 6b oracle: refine `readsViaGit` so `git diff --stat`/summary forms are NOT a read (aligns the
    independent oracle with the true semantic — content-free), add ls-files/ls-tree/whatchanged to it; add
    6c non-vacuity (`readsAFile('git diff --stat') === false`, `readsAFile('git ls-tree -r HEAD') === true`).
  - Run `verify:orchestrator-enforcement`, `verify:orchestrator-surface`, `verify:feat-152`, `npm run gate`.

Independent plan review dispatched to a SEPARATE top-tier process before building — its job: find a
read/search shape (git or curl, quoted or global-option-shielded) this allow-list still permits, or a real
orchestrator workflow it breaks.
