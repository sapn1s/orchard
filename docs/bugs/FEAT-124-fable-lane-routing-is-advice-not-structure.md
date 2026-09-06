# FEAT-124 — Fable lane routing is advice in a doc, and it is not being followed

- **Status:** OPEN — option A (structural Fable-gate) BUILT 2026-09-06, unstaged; awaiting
  user review + an independent clean-room verify (rides the dispatch-gating hook). Option B
  (visibility flag) shipped in a prior round. See Activity log 2026-09-06.
- **Severity:** medium
- **Area:** server (runtime PreToolUse hook) / dispatch / cost-model
- **Reported:** 2026-09-05 by dispatched lane (finding, class=explore)
- **Verification-class:** docs-only — this ticket records a finding + a design decision.
  All dollar/lane figures are from `scripts/cost-collect.mjs --json` over the real transcript
  store (commands in the log). No code changed.

## Symptom
`docs/prompts/ROUTING.md` says Opus is the default and **Fable is only for frontier-hard work**,
yet routine UI/build lanes ran on Fable: measured over the store, the dispatched Fable lanes
include "Fix BUG-030 stale agent cards" **$71**, "UI batch: rail sections/chips/deep-links"
**$31**, "Build FEAT-037 provider picker" **$27**, "FEAT-037 transcripts" **$21** — all `fix`/build
work that the routing rule says belongs on Opus (or Sonnet for the mechanical parts). The rule
already existed and was not followed. This is the same failure mode FEAT-096 (forced dispatch) and
FEAT-108 (git-write block) were filed for: **a rule that lives only as prose gets ignored, and the
fix has to be structural.**

## What was measured (real store, `cost-collect --report-only --json --all`)
- **103 lanes touched Fable.** The largest single row is **$2001** with no ticket / no
  description / `agent_type=null` — that is the **orchestrator's own session** running on Fable,
  NOT a dispatched lane. Keep it distinct: dropping the orchestrator a tier is a separate, larger
  user decision (see FEAT-118 / global-settings.ts). This ticket is about **lane** routing.
- The dispatched Fable lanes are the `general-purpose` (n=30, $356) and `claude` (n=19, $236)
  rows — the routine fix/build work named above.
- **The pivotal fact: 101 of 103 Fable lanes declared NO class at all.** Only 2 carried a
  `Dispatch: … class=…` line (FEAT-100). The signal a class-derived rule would route on is
  absent on ~98% of the lanes that need it.

(The $ totals here are whole-lane costs over the full store, a superset of the brief's
Aug6–Sep4 Fable $1,245; the qualitative finding — routine work on Fable, class almost never
declared — holds regardless of window. Any saving figure is an **estimate**.)

## Where the tier is decided today, and what checks it
1. **In-process `Agent`-tool lane (this is where the Fable spend lives).** The model comes from
   either the `model:` param on the `Agent` call, or the `subagent_type`'s frontmatter default
   (`.claude/agents/worker.md` pins `claude-opus-4-8`; `general-purpose`/`claude` have no pin →
   inherit the session/global default). There is **no fable-pinned agent type**, so Fable only ever
   reaches a lane as an explicit `model: fable` on the `Agent` call, or via a Fable session/global
   default being inherited. **Nothing validates that choice against the task class.**
2. **Launched session:** global default → project override → session override
   (`applyGlobalDefaults` / `pickOverridable`, `src/server/global-settings.ts`). No class involved.
3. **Cross-provider `scripts/dispatch.mjs`:** `--model` is free; validated only for charset
   (`MODEL_RE`), never against the declared `--class`. This path is NOT where the Fable lanes ran.

## The enforcement point that exists and already works
`decide()` in `scripts/lib/orchestrator-profile.mjs` is a `PreToolUse` hook wired live in
`src/server/runtime/claude-runtime.ts` (~line 586). It already refuses tool calls for an
orchestrator session (forced-dispatch) and rides alongside the FEAT-108 git-write deny. It
receives `{ toolName, toolInput, agentId }`, and for an `Agent` call `toolInput` carries
`model`, `subagent_type`, `description` and `prompt` (the prompt is where the FEAT-100
`Dispatch: … class=…` line lives). So the mechanism to refuse a Fable dispatch is the SAME proven
`PreToolUse` deny used twice already. Two honest limits: (a) a `PreToolUse` hook can only
allow/deny, it **cannot rewrite** the model — so "class picks the tier" can only be realised as
"a class-inconsistent tier is refused," not as silent auto-selection; (b) the hook payload has no
*resolved* model field, so if Fable is inherited as a session/global **default** (no `model:` on
the `Agent` call) the deny cannot see it — the gate catches an explicit `model: fable`, not an
inherited one.

## Why class-DERIVATION (brief's option 2) is blocked upstream
Deriving tier from the declared class needs the class to be declared. It is present on ~2% of
Fable lanes. A rule keyed on class would be inert on the other 98% (treat "no class" as
default-allow → does nothing; as default-deny → blocks nearly every dispatch). So derivation is
not viable until class declaration is first made reliable on `Agent` lanes — which is itself a
larger change (the `Agent` prompt is free text; nothing forces the `Dispatch:` line). Naming that
dependency is the finding: **derivation is not the cheap win here.**

## Decision — enforce the tier, or just make misroutes visible?

- **A — Structural Fable-gate (enforce).** Add a branch to `decide()`: when `toolName==='Agent'`
  and `toolInput.model` resolves to Fable, DENY unless the prompt carries an explicit override
  token (e.g. `tier: fable — <reason>`, or `class=arch`). Keys on the MODEL, not the class, so it
  works despite class being undeclared. Fails **safe**: refusing Fable drops the lane to the
  session default (Opus — the sanctioned ceiling, a strong model), never to Sonnet, so the costly
  downward mistake (hard work on too-weak a model) cannot happen; the override is one line. Costs:
  it rides the highest-stakes hook in the system (a wrong deny breaks every dispatch), it is a
  policy choice (deny vs ask; what the token is), and it has the blind spot in (b) above
  (Fable-as-default inheritance is invisible to it). Regression-prone → needs independent
  clean-room verify before it ships.
- **B — Visibility-only (flag, don't block).** `cost-collect` ALREADY records `models` +
  `dispatch_class` + `cost_usd` per lane — the audit in this ticket IS the mechanism. Add a small
  standing surface: flag any lane that used Fable while its class ∈ {trivial, fix, explore} OR is
  absent. Cannot misfire downward (it changes nothing at dispatch time); after-the-fact, so it
  informs rather than prevents. **What it would have caught in the window: every named misroute**
  ($71 stale-cards, $31 UI batch, $27 picker, $21 transcripts — all Fable + non-arch/absent
  class). ~30 lines, read-only, no hook risk. Recommended as the first move; A can follow if the
  flag shows the waste continuing.

## Context pack
- Tier decision points: `src/server/global-settings.ts` (`applyGlobalDefaults`),
  `src/server/agent-bridge.ts` (`pickOverridable`), `scripts/dispatch.mjs` (`--model`/`--class`),
  `.claude/agents/worker.md` (opus pin).
- Enforcement point: `scripts/lib/orchestrator-profile.mjs` (`decide()`), wired in
  `src/server/runtime/claude-runtime.ts` (~586). Real payload shape:
  `scripts/fixtures/feat-096/real-pretooluse-payloads.jsonl` (an `Agent` call carries
  `prompt`/`subagent_type`, no `model` when inherited).
- Signal grammar: `scripts/lib/cost-model.mjs` (`DISPATCH_CLASSES`, `parseDispatchDeclaration`,
  `dispatchClassIn`); recorded per lane by `scripts/cost-collect.mjs` (`models`, `dispatch_class`).
- Routing rule being violated: `docs/prompts/ROUTING.md`. Prior mapping articulation:
  `docs/bugs/archive/FEAT-020-…` ("default UP not down. fable=deep/adversarial/security/arch;
  opus=orchestration+synthesis; sonnet=contained impl; haiku=mechanical/bulk").
- Related: FEAT-096 (forced-dispatch hook), FEAT-108 (git-write deny), FEAT-100 (declared
  dispatch), FEAT-118 (global default tier — the orchestrator-tier decision, distinct from this).
- Repro / evidence: `node scripts/cost-collect.mjs --report-only --json --all` then filter lanes
  whose `models` includes `fable`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-05 — finding lane (class=explore, round 1)
- **Understood:** traced every place a lane's model is set (Agent-tool param / subagent_type
  frontmatter / global-settings inheritance / dispatch.mjs `--model`); none validate against task
  class. Confirmed the proven structural lever is the `decide()` PreToolUse hook, which sees the
  `Agent` tool_input (model + prompt).
- **Measured (real store):** 103 Fable lanes; the $2001 row is the orchestrator's own session
  (separate decision), the routine misroutes are the general-purpose/claude lanes named above;
  **101/103 declared no class** — so class-derivation has no signal to key on, while an
  Agent-tool model-gate does.
- **Did NOT build.** Enforcement (option A) rides the highest-stakes hook and is a policy choice
  requiring user ratification + independent clean-room verify → larger design, filed not built.
  Visibility (option B) is a contained follow-up but its value is mostly the finding, which is
  here; left for the user to greenlight.
- **Recommendation:** B first (cheap, safe, cannot misfire, catches every named misroute), with A
  as the structural escalation if the flag shows the waste continuing. Derivation-from-class is
  blocked until class declaration is made reliable on Agent lanes.
- **Still open / handoff:** user decides A vs B. If A: implement in `decide()` keyed on
  `toolInput.model`, choose deny-vs-ask + the override token, and get an independent clean-room
  verify (it touches the dispatch-gating hook). If B: add the flag to `cost-collect`'s report/JSON.

### 2026-09-06 — fixing lane (class=fix, round 1) — option A BUILT
- **Built the structural Fable-gate** as a NEW module `scripts/lib/fable-tier-policy.mjs`
  (one definition, ARCH-008), wired into the SAME in-process PreToolUse callback in
  `src/server/runtime/claude-runtime.ts` that carries the FEAT-108 git-write block and the
  FEAT-096 profile. Fleet-wide (every session this runtime launches, orchestrator AND lane),
  keyed on `toolInput.model` for an `Agent` call. NOT keyed on class — 98% of Fable lanes
  declared none (this ticket's own measurement), so a class rule would be inert.
- **Reroute, NOT deny — the fail-safe-UP mechanism.** A bare PreToolUse deny would ABORT the
  dispatch (the lane never runs). The SDK's `PreToolUseHookSpecificOutput.updatedInput`
  (sdk.d.ts) lets the hook return `permissionDecision: 'allow'` WITH a rewritten tool_input, so
  an unjustified `model: fable` is allowed but with `model` **rewritten to the literal `opus`**.
  The lane runs — on the sanctioned ceiling. Opus is hard-coded (not strip-and-inherit) so the
  non-negotiable direction (UP to Opus, NEVER down to Sonnet/Haiku) holds even if the ambient
  session default were ever misconfigured below Opus.
- **Override token: `fable-justified: <reason>` line in the Agent prompt**, reason REQUIRED (a
  bare marker does not qualify). Chosen because it rides the free-text prompt the hook already
  sees (no new plumbing / no Agent-tool schema change), forces a stated reason that is logged
  (auditable), is greppable across the store, and mirrors the existing `Dispatch:` marker
  convention. Both a reroute and an override (and an open hatch) are logged to stderr via
  `announceFableTier` — the visibility the ticket asked to keep alongside the round-1 flag.
- **Escape hatch:** `ORCHARD_ALLOW_FABLE=1` disables the gate for a run; opening it is announced
  once per session (never a silent bypass), mirroring `ORCHARD_ALLOW_GIT_WRITE`.
- **Documented blind spot (unchanged from the finding):** the gate keys on an EXPLICIT `model:`.
  A lane inheriting Fable as a session/global DEFAULT (no `model:` on the call) has nothing to
  catch — the payload carries no resolved-model field. That default-tier choice is the separate
  FEAT-118 / global-settings decision and is deliberately NOT touched. The round-1 visibility
  flag (option B, `cost-collect.mjs`) surfaces any Fable that gets through, including this path.
  Asserted as `action: ignore` in the suite, so the limit is tested, not just claimed.
- **Verification:** `scripts/verify-feat-124-fable-gate.mjs` (registered `npm run verify:fable-gate`),
  51/51 gate-safe checks. Must-FAIL proven against the UNCHANGED pre-change `decide()`
  (allows an Agent+fable both ways, no model rewrite). DRIVEN mirror of the hook + textual PIN
  to the runtime source (same pattern as the FEAT-108 block test). Both directions non-vacuous:
  unjustified fable → `updatedInput.model==='opus'`; justified fable → unchanged (keeps Fable).
  Sonnet/Opus/Haiku → ignored. A `--live` mode (NOT in gate, costs money) drives a real session
  to prove the reroute is not an abort (lane runs and returns). Regressions: FEAT-108 git-write
  164/164 PASS, git-grant 40/40 PASS, FEAT-096 read-escapes PASS; FEAT-096 fleet-enabled and
  codex-bypass have pre-existing failures in files I did not touch (registry rows for 2 projects;
  an agent-bridge.ts HEAD-comparison from a prior lane's dirty edits). `npm run gate` exit 0.
- **HIGH-STAKES — independent clean-room verify warranted** before this is trusted: it rides the
  dispatch-gating hook alongside FEAT-096/108. Generation must not be its own only verifier.
- **Files (all unstaged, user commits):** `scripts/lib/fable-tier-policy.mjs` (new),
  `scripts/lib/fable-tier-policy.d.mts` (new), `scripts/verify-feat-124-fable-gate.mjs` (new),
  `src/server/runtime/claude-runtime.ts` (hook wiring + announce), `package.json` (verify script).
</content>
</invoke>
