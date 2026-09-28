# BUG-188 — an OpenAI session inherited the Claude default model and Codex 400'd

- **Status:** IN-PROGRESS
- **Severity:** high
- **Area:** server / bridge (model resolution)
- **Reported:** 2026-09-26 by user
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
A session whose provider is OpenAI (running as orchestrator) fails with:

```
openai — model unavailable
{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'claude-opus-5-5' model is not supported when using Codex with a ChatGPT account."}}
```

The user: it's trying to use Claude's model even though the provider is openai.

## Repro
1. Machine has a global default model set to a Claude id (real settings.json:
   `"model": "claude-opus-5-5"`).
2. A project has `provider: "openai"` and `model: null` (the reported project).
3. Launch/orchestrate that session → the Claude id reaches the Codex runtime →
   400 "not supported when using Codex".

## Expected
The provider picks the model default. A Claude model id must never reach an
OpenAI runtime (ARCH-010, docs/CONVENTIONS.md). An OpenAI session with no
explicit model resolves to null so Codex picks its own default; an anthropic
session keeps inheriting the Claude global default unchanged.

## Root cause
The machine-wide global default model is a CLAUDE model id (global-settings.ts —
`provider` is deliberately NOT a global default). `pickOverridable`
(agent-bridge.ts) filled a session's model via `applyGlobalDefaults`, which does
`project.model ?? global.model` **regardless of provider**. So an openai project
with `model:null` inherited `claude-opus-5-5`, and it was passed to `CodexRuntime`
(agent-bridge.ts start → `model: s.model`). Second, narrower path: on resume the
transcript can override the provider to openai while `effective.model` was already
resolved for the configured (anthropic) provider — same leak.

## Fix
One owner for the provider↔model coupling: `resolveModelForProvider(projectModel,
provider)` in `src/server/global-settings.ts`. An explicit project/session model
always wins; when unset, the Claude global default fills ONLY an anthropic
session, otherwise null. Called from:
- `pickOverridable` (agent-bridge.ts) — the effective-config authority (covers
  session launch and orchestrator launch);
- the resume provider-override branch (agent-bridge.ts) — re-aligns
  `effective.model` to the engine the transcript picked, unless a session model
  override was given.

Dispatch path is already safe (`dispatch-broker.ts` only passes `--model` when
one is explicitly requested; it never inherits the global default).
Launch-time resolve, no migration: a stored `provider:openai, model:null` row
resolves safely on every start; the registry is never rewritten.

## Context pack
- Files/functions: `src/server/global-settings.ts` (`resolveModelForProvider`,
  `applyGlobalDefaults`), `src/server/agent-bridge.ts` (`pickOverridable`, resume
  provider-override in `start()`, `model: s.model` at runtime.start).
- Real reality: a registry project = `provider:openai, model:null`; global
  settings.json `model:"claude-opus-5-5"`.
- Related: FEAT-118 (global-default merge authority), FEAT-037 (provider picks
  the engine), ARCH-010 (one owner per fact), FEAT-045 (per-engine model catalog).
- Repro test: `node scripts/verify-openai-model-inheritance.mjs`

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-26 — worker (fixing, round 1)
- **Understood:** premise confirmed against the user's real state — a registry
  project is `provider:openai, model:null`, global settings.json is
  `model:"claude-opus-5-5"`. Not a user misconfiguration (the model is null, not
  an explicitly-set Claude id); it is inherited from the global default.
- **Changed:**
  - `src/server/global-settings.ts` — added `resolveModelForProvider()`.
  - `src/server/agent-bridge.ts` — `pickOverridable` uses it for the model field;
    resume provider-override branch re-aligns `effective.model`; import added.
  - `scripts/verify-openai-model-inheritance.mjs` — new (repro + regression).
- **Verified (fixer's own run — necessary, not sufficient):**
  - `node scripts/verify-openai-model-inheritance.mjs` → PASS 9/9, incl. a
    synthesized PRE-FIX baseline showing `applyGlobalDefaults({model:null}).model
    === 'claude-opus-5-5'` (the bug) and the fix returning `null` for openai; and
    a read-only assertion that the REAL openai+null row now resolves to `null`.
  - `npx tsc --noEmit` → EXIT 0.
  - `npx tsx scripts/verify-feat-118-global-defaults.mts` → 18/18 (anti-regression
    on the merge authority I touched).
- **Verified-by:** PENDING — independent clean-room verify warranted (model
  resolution / session-lifecycle; regression-prone file agent-bridge.ts). A case
  the fixture does not cover: a resume that flips provider anthropic→openai must
  drop an inherited Claude model to null.
- **Still open / handoff:** an openai project that EXPLICITLY stored a `claude-*`
  model id would still pass it through (explicit-wins). No such row exists in the
  real registry, and reliably classifying a model id's provider needs the
  provider's own catalog (a string check is exactly what ARCH-010 rejects), so it
  was left out of scope rather than guessed. Note if a decision is wanted.
- **Symptom of a deeper design flaw?** (answer on close)

### 2026-09-26 — worker (fixing, round 2)
- **Why round 1 did not fix the user:** hypothesis 1 (stale build) REFUTED —
  service runs `node src/server/index.ts` directly (no dist), restarted 12:44
  after the fix files were saved 12:39, so the running code HAD round 1.
  Hypothesis 2 HELD, via the exact path round 1's own handoff flagged as
  out-of-scope: an openai session carrying an **EXPLICIT** `claude-*` model.
  Ground truth: `session-config/019ff078-…json` for the real failing session
  stores `{provider:'openai', model:'claude-opus-5-5'}`. Chain: the pre-fix leak
  put `claude-opus-5-5` into the session's EFFECTIVE config → the UI mirrored it
  into the per-session `state.overrides.model` and persisted it in localStorage
  (`finishModel`/FEAT-042, keyed by session) → every resume re-sends it as a
  session override on the `start` payload → agent-bridge's override merge wrote it
  straight onto `effective.model`, **bypassing `resolveModelForProvider`** (which
  round 1 only applied to the project/global layer, and which honoured any
  explicit model unconditionally) → `runtime.start({ model: s.model })` handed
  `claude-opus-5-5` to CodexRuntime → 400 at every turn. No data migration can
  reach the browser's localStorage, so the server had to become authoritative.
- **Changed:**
  - `src/server/global-settings.ts` — new owner `modelProviderOf(model)`
    (per-provider catalog `models[-<p>].json` as authority + stable wire-id
    prefix floor `^claude` / `^(gpt|o\d|codex)`; unknown → null so a model we
    cannot place is never over-dropped). `resolveModelForProvider` generalised:
    an explicit model that provably belongs to a DIFFERENT engine than the
    session's provider is dropped to null (engine picks its default) instead of
    passed through. Idempotent for a compatible model. Added `path` + `dataDir`
    imports.
  - `src/server/agent-bridge.ts` — after the session-override merge, re-route
    `effective.model` through `resolveModelForProvider` against the resolved
    provider (the merge previously bypassed the owner). Simplified the
    resume-provider-flip branch to re-resolve the CURRENT effective model against
    the final engine (dropped the `modelOverridden` special-case: a cross-engine
    override is now dropped, a compatible one survives — one owner, no per-branch
    string checks).
  - `public/app.js` — `sessionOverrides()` no longer replays a model override
    that belongs to a different engine than the session's provider (mirror helper
    `modelProviderOfClient`), and prunes it from the persisted per-session memory
    so it stops riding every resume. Defense-in-depth; the server is the authority.
  - `scripts/verify-openai-model-inheritance.mjs` — extended: seeds realistic
    per-provider catalogs; round-2 explicit-cross-engine cases (claude wire id AND
    claude alias on openai → null; gpt on openai kept; gpt on anthropic → null;
    unclassifiable kept); and a READ-ONLY assertion against the REAL failing
    `session-config` (found by shape `{provider:'openai', model:/^claude/}`, never
    by id) confirming it now resolves to null.
- **Verified (fixer's own run — necessary, not sufficient):**
  - `node scripts/verify-openai-model-inheritance.mjs` → PASS 17/17, incl. the
    real-artifact assertion (`claude-opus-5-5` + openai → null) and a pre-fix
    baseline showing round-1 returned the explicit id verbatim.
  - `npx tsc --noEmit` → EXIT 0. `npm run gate` → PASS (exit 0).
  - `npx tsx scripts/verify-feat-118-global-defaults.mts` → 18/18 (anti-regression
    on the merge authority). Client classifier regexes unit-checked (7/7).
- **Restart needed:** YES — the running service still has round-1 code for the
  override path (the guard is new). Restart to pick it up. NB: even before a
  restart, the CLIENT guard (app.js) will stop re-sending the stale claude
  override on the next resume once the page reloads the new app.js, so a hard
  refresh + resume may already succeed; the server guard is the durable fix.
- **Not verified end-to-end:** the full `startSession → runtime.start` path was
  not driven live (would need a real Codex app-server); the owner function and
  its wiring are proven in isolation + by typecheck. The client `sessionOverrides`
  drop was checked by mirroring its regexes, not via a headless browser.
- **Verified-by:** PENDING — independent clean-room verify still warranted
  (model-resolution / session-lifecycle; regression-prone agent-bridge.ts; this is
  a regression from round 1's explicit-wins gap — `regressed-from: BUG-188 r1`).
- **Symptom of a deeper design flaw?** Partly: the effective-model was owned in
  ONE place for the project/global layer but the SESSION-override merge and the
  runtime.start call each re-read raw fields, so the owner was bypassable. Round 2
  makes the owner the single funnel every layer passes through.

### 2026-09-26 — worker (fixing, round 3)
- **Worked from ground truth, not reasoning.** Service `ActiveEnterTimestamp`
  13:06:17 local; round-2 files saved 12:55 → the running server HAD round 2.
- **H1 (replayed/stale error) — REFUTED.** Real Codex rollout
  `~/.codex/sessions/2026/08/11/rollout-…-019ff078-….jsonl` line 708:
  `task_complete … error "The 'claude-opus-5-5' model is not supported…"` at
  `2026-09-26T10:06:42Z` (13:06:42 local) — a FRESH turn 25 s after the restart
  (the "While you were away" auto-injection triggered it).
- **H2 (model from outside Orchard's resolution) — HELD: the Codex thread's own
  persisted model.** `sqlite3 ~/.codex/state_5.sqlite` → `threads` row for
  019ff078… = `model=claude-opus-5-5, model_provider=openai`; rollout
  `thread_settings_applied` flips gpt-5.6-sol → claude-opus-5-5 at
  `09:24:42.871Z` (the pre-fix leak) and stays claude on every turn after. Codex
  schema (`codex app-server generate-json-schema`, 0.157.0): turn/start `model`
  = "Override the model for this turn **and subsequent turns**" — sticky and
  persisted with the thread. After rounds 1–2 Orchard correctly resolved the
  model to null and therefore sent NO model; on a RESUMED thread omission means
  "keep the thread's stored model", not "Codex default" → claude-opus-5-5 → 400.
  Not `~/.codex/config.toml` (no `model` key), not an argv/env override.
- **H3 (another Orchard path) — REFUTED** for this failure: the scratch repro's
  captured wire shows `thread/resume` and `turn/start` both with no `model`.
- **Reproduced independently (live service untouched):** real `codex` 0.157.0
  under a scratch CODEX_HOME holding a COPY of the real rollout (auth symlinked,
  real ~/.codex state/auth mtimes verified unchanged), driven through the REAL
  CodexRuntime resume path with `model:null` → wire `[initialize, initialized,
  thread/resume, turn/start(no model)]` → the exact 400. With the fix → wire
  `… thread/resume, model/list, turn/start(model:"gpt-6-astra")` → the model
  error is GONE; the next error is genuine: "You've hit your usage limit … try
  again at 2:23 PM" (same with `gpt-5.6-sol`, so account-wide). **Quota is NOT
  the cause of the 400, but the user's ChatGPT Codex quota IS also exhausted
  right now** — the model 400 was masking it.
- **Why rounds 1–2 missed it:** both fixed what ORCHARD sends and assumed
  "send nothing = Codex picks its default". That is only true for a NEW thread;
  neither round inspected the Codex-side thread state or captured the wire, and
  the pre-fix leak had already been written INTO the Codex thread, which outlives
  any Orchard-side fix. `regressed-from: BUG-188 r1/r2` (incomplete, not
  regressive).
- **Changed:**
  - `src/server/runtime/codex-runtime.ts` — one owner for "the model an openai
    runtime runs when Orchard has none": `#healResumedModel(threadResult.model)`
    after thread/resume/fork. When no explicit model is set and the thread's
    stored model is NOT offered by the account's own catalog (`model/list
    {includeHidden:true}` — the provider's authority, no string checks), it sets
    `#fallbackModel` = the catalog default; `#startTurn` sends it when the
    resolved model is null (the turn/start makes it sticky → thread heals
    permanently). A stored model the catalog offers is left alone; unreachable
    catalog = unchanged behaviour. Init frame reports the healed model.
  - `scripts/verify-openai-model-inheritance.mjs` — round-3 section: a
    sticky-model fake app-server (models the real semantics incl. the real 400
    text) driven through the REAL CodexRuntime resume path + a read-only
    real-artifact case replaying the stored model from the real ~/.codex state.
- **Verified (fixer's own run):** verify-openai-model-inheritance → PASS 21/21;
  must-FAIL with the heal call removed → the 2 r3 heal checks FAIL with the exact
  400 (anti-regressions still pass), exit 1. Anti-regressions:
  verify-codex-runtime 54/54, verify-feat-078-native-codex 36/36,
  verify-feat-118-global-defaults 18/18. `npm run gate` → PASS exit 0.
- **User data:** none edited. The stale `session-config/019ff078….json`
  (model claude-opus-5-5) is harmless (server resolves it to null since r2); the
  Codex thread heals itself on its first post-restart turn.
- **Restart needed:** YES (server-side runtime change). After restart the next
  turn will still fail until the usage limit resets (~14:23 local), with the
  usage-limit message instead of the model 400.
- **Not verified:** a SUCCESSFUL post-fix turn on the real account (blocked by
  the exhausted quota); the full bridge → runtime path through the live service.
- **Verified-by:** PENDING — independent clean-room verify warranted
  (session-lifecycle / regression-prone runtime).
