```orchard-ticket
{
  "id": "FEAT-037",
  "type": "feature",
  "title": "Orchard can now run sessions on a second provider",
  "summary": "Orchard sessions ran only on Anthropic's engine, so a change in that vendor's terms or pricing would have stranded the product. A provider seam now exists, a second engine runs real sessions end to end, and people pick the engine when starting a session. Three gaps were left open on purpose.",
  "impact_if_we_wait": "Nothing degrades by waiting; the shipped path works on both engines. Bounded: the open gaps are forking a second-engine session, session survival across restart for engines that keep no transcript, and search or rename or tag or delete, which cover the original store only.",
  "current_need": "Nothing is outstanding. Round-trip, interrupt, approval, resume, model listing and provider-error attribution all ran against real second-engine sessions, plus a live close, reopen, history and resume-with-memory pass.",
  "severity": "medium",
  "area": "Agent runtime and providers",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "you",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-06",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The bridge depends on a runtime interface rather than one vendor's SDK",
    "The original engine keeps its behaviour unchanged behind the new adapter",
    "A second engine runs a real session: send, interrupt, approve, resume",
    "A person chooses the engine when starting a session",
    "Transcript capture belongs to Orchard, so history survives close and reopen",
    "Provider errors are shown attributed to the engine that produced them"
  ],
  "code_refs": [
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": null,
      "note": "the concentrated coupling surface the plan was asked to map"
    }
  ],
  "related": [
    {
      "id": "BUG-031",
      "relation": "blocks"
    },
    {
      "id": "FEAT-015",
      "relation": "see_also"
    },
    {
      "id": "FEAT-043",
      "relation": "blocks"
    },
    {
      "id": "FEAT-045",
      "relation": "blocks"
    },
    {
      "id": "FEAT-051",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "arch",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-037-multi-provider-abstraction.md",
    "sha256": "19fbb54350cfa6d99898eacf6c57d236fb181f8441a1a997c8ba5595bca1ddef",
    "bytes": 73326,
    "original_title": "Multi-provider support: decouple from the Claude SDK (vendor-independence)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the ticket head: the lock-in motive, the five plan questions, the phase breakdown, the shipped scope and all three named remainders are present.",
    "dropped": [
      "the plan-only-in-this-pass instruction, overtaken by the phases actually shipping"
    ]
  }
}
```

# FEAT-037 — Orchard can now run sessions on a second provider

## Diagnosis

### Coupling

Orchard's execution layer was `@anthropic-ai/claude-agent-sdk`, used through `src/server/agent-bridge.ts`. Everything above it — dashboard, board, orchestration, isolation, methodology — was already provider-agnostic; only model execution was vendor-bound.

### The questions the plan had to answer

How deep the SDK reached and whether it was concentrated or spread; which concepts port cleanly (session lifecycle, streaming events, tool use and approvals, permission modes, model selection, cost tracking) and which are vendor idioms; the shape of an `AgentRuntime` interface plus a same-behaviour adapter for the existing engine; whether driving a vendor's agent CLI as a process and capturing its stream is a lighter route to independence than reimplementing each SDK; and an S/M/L sizing with phases and risks.

## Evidence

Suites recorded with results: `verify:reattach-approval` 11/11, `verify:restart-survives` 15/15, `verify:model-chip` 13/13, `verify:provider-picker` 17/17, `verify:provider-errors` 22/22, `verify:tool-toggle` 13/13, `verify:orchard-transcripts` 15/15. Two further tallies are recorded without an adjacent suite name: 54/54 and 4/4. Typecheck reported clean.

Beyond fixtures, the second engine was exercised against real subscription sessions: round-trip, interrupt, approval-allow, resume, model list, and an attributed provider-error card. The provider picker was checked at real session start (16/0 plus a live turn). Orchard-owned transcript capture was checked live: close, reopen, history, resume-with-memory.

## Implementation notes

Shipped in phases. P1 extracted the `AgentRuntime` seam with no behaviour change. P2a and P2c added the second runtime, schema-validated and then driven against real sessions. P3 wired the provider picker into real session start. P2b moved transcript capture into Orchard so history no longer depends on a vendor store.

## Risks

Three remainders were documented rather than silently gated: the UI refuses to fork a second-engine session pending ancestor seeding; FEAT-015 survival is deliberately off for engines that do not persist a transcript; and search, rename, tag and delete still cover the original engine's store only.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed. Dispatched an opus architecture planner (read-only) to assess complexity + phase it.

### 2026-08-04 — opus architecture planner (READ-ONLY, no code changed)
Method: system `rg` (Serena MCP was available but plain `rg` + `Read` sufficed;
note `src/server/agent-bridge.ts` contains a literal NUL byte around offset 58269,
so `rg` treats it as binary — every grep of that file needs `rg -a`, and an
earlier `rg -l` FALSE-NEGATIVED its SDK import. Don't trust `rg -l` on it.)

## PLAN — decision-grade

### 1. Coupling surface — where the SDK actually lives (CONCENTRATED)
Only **two** files import `@anthropic-ai/claude-agent-sdk` at runtime:
- `src/server/agent-bridge.ts:8` — `query, Options, SDKMessage, SDKUserMessage, PermissionResult`. This is the whole engine.
- `src/server/session-mutations.ts:31` — `renameSession, tagSession, deleteSession` (store-file helpers).
- (`src/server/events.ts:207` matches on grep but is a *comment*, not an import — the `StationEvent` union is already SDK-type-free. That is the key asset: everything above the bridge already speaks Orchard's own vocabulary.)

**SDK surface actually exercised** (all in `agent-bridge.ts`):
- Engine: `query({ prompt, options })` → a `Query` async-iterable (`:555`); multi-turn input via a hand-rolled async-iterable `InputQueue<SDKUserMessage>` (`:101-130`, pushed at `:557/:578`).
- `Options` fields set: `cwd, includePartialMessages, permissionMode, canUseTool, allowDangerouslySkipPermissions` (`:420-449`); `model, effort, allowedTools, disallowedTools` (`:510-513`); `resume, forkSession` (`:518-521`); `systemPrompt` (`:549`); `mcpServers, strictMcpConfig` (`:532-534`); isolation seam `pathToClaudeCodeExecutable, spawnClaudeCodeProcess` (`:483-486`).
- Control methods: `#q.interrupt()` (`:584`), `setPermissionMode()` (`:588-625`), `#q.supportedModels()` (`:561`).
- Approval callback: `canUseTool(toolName, input, {signal,requestId,toolUseID,agentID,title,description})` → `PermissionResult` (`{behavior:'allow'|'deny', updatedInput?, message?}`) (`:918-964`).
- Inbound stream taxonomy consumed in `#handle`/`#handleSystem` (`:1038-1260`): `system` (subtypes `init, task_started, task_progress, task_updated, task_notification, thinking_tokens, status, compact_boundary`), `assistant` (blocks `text|thinking|tool_use`), `user` (`tool_result`), `tool_progress`, `stream_event` (`content_block_delta`/`text_delta`), `rate_limit_event`, `result` (`total_cost_usd, subtype, duration_ms, num_turns`). Subagent routing keys on `parent_tool_use_id` (`:966-969`).

**Second, deeper, NON-import coupling — the on-disk session store.** Detach/reattach, transcript render, fork and rename are all built on Claude's `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` format, NOT on the SDK object:
- `src/lib/paths.ts:~19,78` (store root), `src/server/jsonl.ts` (parses Claude entry shapes: `type==='assistant'|'user'`, blocks `text/thinking/tool_use/tool_result`), `src/server/transcript.ts`, `src/server/watcher.ts:296-299` (`.jsonl` follow of externally-run sessions), `src/server/fork.ts:7,89-167` (scan store by `encodedDir`, copy `.jsonl`), `resume` via `options.resume` (`:519`) relies on the CLI reading its own store, and `session-mutations.ts` mutates that store. This is the coupling the "session lifecycle is generic" framing hides.

### 2. Generic vs Claude-specific
PROVIDER-GENERIC (ports cleanly): the `Session` object's lifecycle flags (`busy/detached/closed`, start/send/interrupt/close), the `StationEvent` fan-out to sockets, `InputQueue` multi-turn plumbing, host-side budget accounting (`:1119,1138-1151` — it merely *sums* a per-turn cost number), the isolation seam *as a concept* (spawn a child = the runtime's process; the SDK's `spawnClaudeCodeProcess` is already a generic "give me your ChildProcess" hook, `:454-460`), and the board/dashboard/orchestration/methodology above the bridge.

CLAUDE-SPECIFIC (idioms that don't generalize): (a) permission modes `default/acceptEdits/plan/bypassPermissions` and the `--dangerously-skip-permissions` arming rule (`:426-448`); (b) the **bidirectional** `canUseTool` control channel + the AskUserQuestion/ExitPlanMode-answered-as-tools protocol via `updatedInput.answers` (`:874-964`); (c) the `SDKMessage` event taxonomy (`system.subtype` set, block shapes, `parent_tool_use_id` subagent routing, the `task_*` live-agent lifecycle that feeds the whole agent panel); (d) model naming + `supportedModels()` (`:561`) + `effort`; (e) cost as `total_cost_usd`; (f) the `.jsonl` store format (transcript/fork/watcher/resume/rename); (g) OAuth via `~/.claude/.credentials.json` (`:5-6`).

### 3. Abstraction shape
An `AgentRuntime` the outer `Session` depends on, emitting the *existing* `StationEvent` union (no new vocabulary needed above the bridge). Minimum interface:
`start(opts) → RuntimeHandle`, `send(text)`, `interrupt()`, `setPermissionMode(mode)`, `close()`, an async event stream typed as `StationEvent`, plus an approval hook (`onApprovalRequest → resolve(allow/deny/answer)`), plus a **`capabilities` descriptor** — `{ approvals, permissionModes, structuredCost, modelList, subagents, persistedTranscript, fork, effort }` as booleans. The capability object is the crux: it lets the UI honestly gray out what a runtime can't do instead of faking parity. `ClaudeRuntime` is the current `agent-bridge.ts` body verbatim with every capability `true`. A second adapter fills what it can and flips the rest `false`.

### 4. LIGHTER PATH verdict — process/CLI adapter vs in-process SDK adapter
**Reframe first:** Orchard is ALREADY a CLI-process wrapper. The SDK's `query()` does not run a model in-process — it spawns the `claude` CLI and speaks stream-json over stdio (`agent-bridge.ts:454-456`), which is exactly why the docker-exec isolation works. So "treat the runtime as a pluggable CLI/process" is not a new architecture; it is the architecture, currently mediated by Anthropic's SDK.

Therefore:
- **In-process per-vendor SDK adapters = wrong effort.** Codex/others ship their own CLIs too; re-implementing vendor SDKs buys nothing over spawning their CLI.
- **Process/CLI adapter = the correct AND lighter path**, and it matches reality. `AgentRuntime` should be defined as a **structured-stream-over-a-child-process** contract, with the Claude adapter delegating to the SDK (which happens to be a great structured client for the `claude` CLI) and other adapters spawning `codex …`/etc. directly.

**But be honest about what a plain pipe loses** — this is the whole point of the capability flags:
- Interactive **approvals/permission modes**: the SDK gives a *bidirectional* control channel (`canUseTool` can block the tool and inject an answer). A one-way `some-cli -p | read` pipe cannot. A second runtime is realistically `approvals:false` (allow-all inside a container) until/unless that CLI exposes a JSON approval protocol.
- **Structured tool-use / subagents**: only as rich as the CLI's own stream. If it emits JSON events you can map them to `tool-call`/`tool-result`/`agent-*`; if it emits prose you get `text` only and the agent panel goes dark.
- **Cost / model list**: best-effort; likely `structuredCost:false`, `modelList:false` → budget guardrail and model picker degrade for that runtime.
- **Persisted transcript / detach-reattach / fork**: the biggest hidden cost. Those are built on Claude's `.jsonl` store, which a second CLI won't produce in that shape. Either the adapter maps that CLI's own transcript, or **Orchard must own transcript capture** for non-Claude runtimes.

Net: the CLI/process abstraction wins on effort AND vendor-independence, *provided* the interface admits partial capability rather than pretending parity.

### 5. Complexity: **M–L** — "M to make it pluggable, L to make a second provider first-class"
- **P1 — extract `AgentRuntime` + `ClaudeRuntime`, ZERO behaviour change. Effort: M (~2-4 focused days).** Coupling is concentrated (one class, two importing files), so this is mostly mechanical: split the `Session` object into a runtime-agnostic shell (lifecycle flags, event fan-out, budget accounting, board/isolation orchestration) and a `ClaudeRuntime` holding `query()`, the `#handle` event mapping, `canUseTool`, `setPermissionMode`, `supportedModels`. Add the `capabilities` object (all `true`). **Decide explicitly** whether the `.jsonl` store functions (transcript/fork/watcher/session-mutations) are part of the runtime contract or declared "Claude-only, guarded by `capabilities.persistedTranscript`" — recommend the latter for P1 to avoid scope-creep. Verify by full existing verify-suite + a live session: behaviour must be byte-identical.
- **P2 — second runtime as proof (Codex CLI). Effort: M–L (~1-2 weeks).** Map its stream to `StationEvent` (partial); pick an approval strategy (start `approvals:false`, container-sandboxed allow-all); provide model/cost best-effort; and — the real work — **Orchard-owned transcript capture** so detach/reattach/fork/transcript-follow don't silently break (or gate them off via capabilities). This phase is where "L" comes from; it is a genuine feature-parity project, not a refactor.
- **P3 — per-project/session runtime picker in the UI. Effort: S–M (~2-4 days) once capabilities exists.** Add a runtime field to project/session settings (`registry.ts`/`validate.ts`/overrides), a picker in the composer, and — mandatory — have the UI read `capabilities` to gray out approvals/cost/model-picker/fork for runtimes that lack them. Small only because the honesty machinery (capabilities) was built in P1.

### Top risks (ranked)
1. **Approvals / permission-mode parity** — the bidirectional control channel is a Claude idiom; other CLIs offer allow-all or blocking at best. Do NOT fake it; expose `capabilities.approvals`.
2. **Store-format / detach-reattach / fork** — the under-appreciated one. "Generic session lifecycle" is actually built on Claude's `.jsonl` store (`jsonl.ts`/`transcript.ts`/`watcher.ts`/`fork.ts`/`session-mutations.ts`). A second provider needs Orchard-owned transcript capture or loses those features.
3. **Cost + budget stop** — the `maxBudgetUsd` guardrail depends on `total_cost_usd` per turn; providers without per-turn cost silently disable the budget guard.
4. **Subagent/board panel** — fed entirely by Claude's `task_*` + `parent_tool_use_id`; a runtime without subagents leaves the live-agent UI empty (acceptable if labelled via capabilities).
5. **Model picker** — `supportedModels()` is Claude-only (see BUG-021's resolved-name work); the picker must fall back per runtime.
6. **Isolation wiring** — portable in principle (the spawn hook is generic), but each runtime needs its own container-spawn adapter mirroring `spawnClaudeCodeProcess` → `execInContainer`.

## Activity log (APPEND-ONLY)
### 2026-08-04 — opus P1 builder (AgentRuntime seam + ClaudeRuntime adapter)
Built P1 exactly as planned: pure refactor, **zero behaviour change**. The vendor
SDK now lives behind ONE seam.

**What moved behind the interface.** `src/server/agent-bridge.ts` no longer imports
`@anthropic-ai/claude-agent-sdk` at all (only `session-mutations.ts` still does, out
of P1 scope — the `.jsonl` store helpers). Everything SDK-shaped moved into
`src/server/runtime/claude-runtime.ts` (`ClaudeRuntime`):
- `query()` construction + the whole `Options` build (incl. the Claude idioms
  `includePartialMessages:true` and the `allowDangerouslySkipPermissions:true`
  "armed, not engaged" arming, with its comment).
- the hand-rolled `InputQueue<SDKUserMessage>` multi-turn channel + `userMessage()`.
- `interrupt()`, `setPermissionMode()`, `supportedModels()` (incl. the model-row
  normalisation that used to live in the bridge's fire-and-forget `.then`), `close()`
  (`#input.end()` + `#q.close()`), and the message async-iterable (`messages()`).
- the `canUseTool` wiring (adapter translates the session's `ApprovalResult` back to
  the SDK's `PermissionResult`).

**What STAYED in `AgentSession` (the runtime-agnostic shell).** All business logic:
lifecycle flags, `StationEvent` fan-out, `#handle`/`#handleSystem` event MAPPING
(it was already keyed off `Record<string,any>`, so it now takes an opaque
`RuntimeMessage`), budget accounting, `#agents` live-agent tracking, the `#approvals`
map + `#onCanUseTool` + `answer*`, snapshots, fork/staged bookkeeping, container
memory polling, and the **isolation/survival orchestration**: the container `docker
exec` closure and the FEAT-015 survival-broker closure are still built here (they own
`#execId`/`#survivalHandle`) and handed to the runtime as `spawnProcess` in
`RuntimeStartConfig` — the generic form of `spawnClaudeCodeProcess`.

**Interface (`src/server/runtime/runtime.ts`).** `AgentRuntime`: `start(config)`,
`send`, `interrupt`, `setPermissionMode`, `supportedModels`, `detach` (no-op for
Claude — the CLI persists to `.jsonl` regardless; the seam exists for a store-less
runtime), `close`, `messages()`. Plus `RuntimeStartConfig` (cwd, firstPrompt,
permissionMode, onApproval, the spawn seams `pathToExecutable`/`spawnProcess`, model,
effort, allowed/disallowedTools, resume/forkSession, mcpServers/strictMcpConfig,
systemPrompt), `ApprovalResult`, `RuntimeApprovalRequest/Meta`, `RuntimeSpawnFn`,
`RuntimeModel`, and the **`capabilities` shape** (all booleans per the plan):
`{ approvals, permissionModes, structuredCost, modelList, subagents,
persistedTranscript, fork, effort }`. `ClaudeRuntime` sets every flag `true` (it is
the reference engine; not faking parity — it HAS parity). A second adapter flips to
`false` whatever it can't honour.

**.jsonl-coupling note (unchanged, P1 out of scope).** Detach/reattach, transcript,
fork, resume and rename remain built on Claude's `~/.claude/projects/<enc>/<id>.jsonl`
store (`jsonl.ts`/`transcript.ts`/`watcher.ts`/`fork.ts`/`session-mutations.ts`), NOT
on the runtime object. This is documented in both new files and the bridge header,
and is conceptually gated by `capabilities.persistedTranscript`. It is the deeper
coupling (risk #2) and is P2 work — a second runtime needs Orchard-owned transcript
capture or those features degrade.

**Scope.** Edited only `src/server/agent-bridge.ts` + 2 new files under
`src/server/runtime/`. `src/server/index.ts` NOT touched (its imports from the bridge
— `startSession`/`getSession`/`closeAllSessions`/`liveSessions`/… — are all
unchanged). No git commit.

**Verification — zero-behaviour-change proof (all green, run individually with live
turns):**
- `typecheck` — PASS
- `verify:detach` — 7/0
- `verify:reattach-approval` — 11/11 (the approval-channel replay path)
- `verify:restart-survives` — 15/15 (the FEAT-015 survival spawn-seam I moved — cgroup
  escape, broker survival, in-flight completion, re-adopt, resume-continuity all pass)
- `verify:reload-live-summary` — 10/0
- `verify:ui -- --offline` — 3/0
- `verify:queue` — 14/0 (incl. force-send interrupt)

No new test added: the seam is proven by the existing suite staying byte-identical in
behaviour (the requirement was zero change, and a passing unchanged suite IS the
proof). Handoff: P2 is the real feature-parity project (second adapter + Orchard-owned
transcript capture); P3 is the UI runtime picker reading `capabilities`.

### 2026-08-05 — P2 research appendix (OpenAI Codex CLI as second provider; READ-ONLY, web-verified, no code changed)
Scope: design research only. Candidate verified against OFFICIAL sources only
(github.com/openai/codex, developers.openai.com — which now 308-redirects to
learn.chatgpt.com/docs — and the repo's own protocol docs). Hard constraint honoured:
**subscription billing (ChatGPT plan), NOT pay-per-token API** — Codex supports exactly
this, mirroring how our `claude` CLI bills to the Anthropic sub.

#### VERDICT UP FRONT
**Integrable — YES, and better than the plan's pessimistic "plain pipe" assumption.**
Codex ships an official machine interface, `codex app-server` — bidirectional JSON-RPC 2.0
over stdio (newline-delimited JSON) — with threads, streaming item events, interrupts,
resume, fork, model listing, AND server→client approval requests. That is structurally the
same contract the Claude SDK gives us (spawn a CLI, speak a JSON protocol over stdio), so
`CodexRuntime` is a peer adapter, not a degraded pipe. The honest gaps are cost (tokens,
not USD), subagent events, plan mode, and — as P1 predicted — the transcript store
(Codex persists its own sessions, but our detach/reattach/fork/watcher pipeline is built
on Claude's `~/.claude` `.jsonl` shape, so Orchard-owned capture is still the P2 core).

#### 1. Current name/state, install, license, maintenance
- **Name:** OpenAI **Codex CLI** (`codex`), repo `openai/codex`, written in Rust
  (`codex-rs/`). NOT the deprecated 2021 Codex *model* — same brand, different product.
- **Install (official channels only):** `npm install -g @openai/codex`;
  `brew install --cask codex`; standalone `curl -fsSL https://chatgpt.com/codex/install.sh | sh`;
  or GitHub Releases binaries (e.g. `codex-x86_64-unknown-linux-musl.tar.gz`).
  [https://github.com/openai/codex]
- **License:** Apache-2.0. [https://github.com/openai/codex]
- **Maintenance:** very active — ~8.9k commits; releases page shows multiple releases *per
  day*, latest `0.147.0-alpha.7` on 2026-08-04 (the day before this research). Caveat:
  the top of the release feed is a fast alpha channel; pin a stable tag for users.
  [https://github.com/openai/codex/releases]

#### 2. Subscription auth (the user's hard constraint) — SATISFIED
- **ChatGPT sign-in works today** and is the recommended path: `codex login` opens a
  browser OAuth flow; for headless boxes there is `codex login --device-auth` (beta,
  one-time code, no localhost callback). An API key is an *alternative* (`codex login
  --with-api-key`, or `CODEX_API_KEY` for exec) and switches billing to per-token API
  pricing — we simply won't use it, matching our "OAuth only, no API-key path" stance in
  `claude-runtime.ts`. [https://developers.openai.com/codex/auth]
- **Qualifying plans:** Plus, Pro, Business, Edu, Enterprise (Free/Go have NO CLI access).
  **Minimum tier: ChatGPT Plus at $20/month** (Business is also $20/user/mo; Pro is
  $100/mo "5x" or $200/mo "20x"). [https://github.com/openai/codex,
  https://learn.chatgpt.com/docs/pricing]
- **Credential storage:** `~/.codex/auth.json` (under `$CODEX_HOME`, default `~/.codex`)
  or the OS keyring, per `cli_auth_credentials_store = "file" | "keyring" | "auto"`.
  Tokens auto-refresh during use. `auth.json` is a bearer secret — same handling as
  `~/.claude/.credentials.json`. [https://developers.openai.com/codex/auth]
- **Usage limits under subscription:** rolling **5-hour windows**, message-count ranges
  varying by model (Plus: roughly 10–2,000 local messages per window depending on model;
  Pro 5x/20x scale that). No per-turn dollar figure exists under subscription — which is
  exactly why `structuredCost:false` below. [https://learn.chatgpt.com/docs/pricing]

#### 3. Programmatic driving — the machine interfaces (three, pick app-server)
Codex offers three official host-app interfaces:
1. **`codex app-server`** — JSON-RPC 2.0 over stdio (JSONL framing; experimental
   websocket/unix-socket transports exist). Handshake: client sends `initialize`
   (clientInfo, capabilities) then `initialized`. Methods: `thread/start` (cwd, model,
   sandbox/approval overrides), `thread/resume`, `thread/fork`, `thread/list`,
   `thread/read`, `turn/start` (user input → generation), `turn/steer` (append input to an
   active turn), `turn/interrupt`, `model/list`. Notifications: `thread/started`,
   `turn/started`, `item/started`, `item/agentMessage/delta` (streaming text),
   `item/completed`, `turn/completed` (with `usage` token counts; `status:"interrupted"`
   after an interrupt), `thread/status/changed`, `thread/tokenUsage/updated`. Item types
   include `userMessage`, `agentMessage`, `reasoning`, `commandExecution`, `fileEdit`,
   MCP tool calls, web searches, plan updates. Full schema is generatable from the binary:
   `codex app-server generate-json-schema` / `generate-ts`.
   [https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md]
2. **`codex exec --json`** — one-shot non-interactive turns; stdout becomes a JSONL event
   stream (`thread.started` with `thread_id`, `turn.started`, `item.*`, `turn.completed`
   with `usage`, `turn.failed`, `error`); continuation via `codex exec resume <SESSION_ID>`
   / `resume --last`; `--output-schema`, `--sandbox`, `--ephemeral`. No live approvals —
   runs under whatever sandbox/approval policy you set at spawn.
   [https://developers.openai.com/codex/noninteractive]
3. **`@openai/codex-sdk`** (official TypeScript SDK, `sdk/typescript` in the repo) — wraps
   the CLI, "spawns the CLI and exchanges JSONL events over stdin/stdout";
   `codex.startThread()` / `thread.run()` / `runStreamed()` / `resumeThread(id)`. It is a
   convenience wrapper over the exec-style interface — no interactive approval channel.
   [https://github.com/openai/codex/tree/main/sdk/typescript]

**Approvals are genuinely bidirectional** (the plan's risk #1 does NOT materialise):
the server issues JSON-RPC *requests to the client* —
`execCommandApproval { conversationId, callId, command, cwd, reason? }` and
`applyPatchApproval { conversationId, callId, fileChanges, reason?, grantRoot? }`
(newer app-server flow: `item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`) — and the client replies `{ decision: "allow" | "deny" }`.
[https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md]
Two honest deltas vs Claude's `canUseTool`: (a) **no `updatedInput` amendment** — allow/deny
only, so our approval-with-edited-input path can't round-trip; (b) **no
AskUserQuestion/ExitPlanMode-as-tools protocol** — those Claude idioms simply don't fire.

**AgentRuntime → Codex mapping (via app-server), method by method:**
| AgentRuntime | Codex equivalent | Notes / gap |
|---|---|---|
| `start(config)` | spawn `codex app-server` → `initialize` → `thread/start{cwd, model, sandbox/approval config}` → `turn/start{firstPrompt}` | `spawnProcess`/`pathToExecutable` seams port directly (we spawn the child ourselves — same docker-exec/survival closures) |
| `send(text)` | `turn/start` on the same thread (adapter serialises turns); `turn/steer` covers our force-send-into-busy-turn case | queueing lives in the adapter, like `InputQueue` |
| `interrupt()` | `turn/interrupt{threadId, turnId}` → `turn/completed{status:"interrupted"}` | clean parity |
| `setPermissionMode(mode)` | map Orchard modes → (`approval_policy` × `sandbox_mode`) overrides on the next `turn/start`; e.g. default→`unlessTrusted`+`workspace-write`, acceptEdits→auto-approve fileEdit approvals adapter-side, bypassPermissions→`never`+`danger-full-access` | **no plan mode**; mode changes apply from next turn, not mid-turn |
| `setModel(model)` | `model` override on `thread/start` / `turn/start` | applies next turn; no mid-turn switch |
| `supportedModels()` | `model/list` (models + reasoning-effort options) | clean parity |
| `detach()` | Codex persists sessions itself (`thread/resume` works across processes), BUT our viewer/transcript/watcher pipeline reads Claude's store — so detach must trigger **Orchard-owned transcript capture** | the P1-predicted core work |
| `close()` | end stdin / kill child | trivial |
| `messages()` | adapter maps app-server notifications → the same opaque `RuntimeMessage` stream; a translation table `item/*`→`tool-call`/`tool-result`/`text`, `agentMessage/delta`→`text_delta`, `turn/completed.usage`→cost-ish event | the main mapping work |
| `onApproval` | `execCommandApproval`/`applyPatchApproval`/`item/*/requestApproval` → `{decision}` | allow/deny only (no `updatedInput`) |

**Honest `capabilities` for `CodexRuntime`:**
`{ approvals: true, permissionModes: true /* mapped, no plan mode — applies next turn */,
structuredCost: false /* tokens only, no USD; budget guard degrades to token budget or off */,
modelList: true, subagents: false /* no parent_tool_use_id-style stream; agent panel dark */,
persistedTranscript: false /* Codex HAS a store, but not ours — until Orchard-owned capture */,
fork: true /* thread/fork exists; UI fork stays off until transcript capture lands */,
effort: true /* model_reasoning_effort / model/list effort options */ }`

**MCP:** supported. Config lives in `~/.codex/config.toml` under `mcp_servers.*` (or
project-scoped `.codex/config.toml` for trusted projects); `codex mcp add`; per-invocation
`-c mcp_servers…` overrides let the adapter inject Orchard's per-session `mcpServers`
config without touching the user's file. [https://developers.openai.com/codex/mcp,
https://developers.openai.com/codex/config-reference]

#### 4. Sandboxing/permissions model + composition with our isolation
Codex ships OS-level sandboxing the Claude CLI doesn't have: macOS Seatbelt; Linux
bubblewrap + seccomp (Landlock fallback). Modes: `read-only` (default) /
`workspace-write` / `danger-full-access`; approval policy is separate (e.g. `never`,
`unlessTrusted`); newer "permission profiles" (`default_permissions` + `[permissions]`)
do NOT compose with the older `sandbox_mode` keys — configure one or the other.
[https://learn.chatgpt.com/docs/sandboxing, https://learn.chatgpt.com/docs/permissions,
https://developers.openai.com/codex/config-reference]
Composition with Orchard: **host (non-isolated) sessions** get Codex's native sandbox as a
free upgrade — `workspace-write` + approvals-on is a good default. **Container-isolated
sessions**: Codex's seccomp/landlock sandbox may not initialise inside Docker's own
seccomp confinement (known class of issue, e.g. openai/codex#1039 for WSL) — the correct
composition is ours-outside-theirs: run `--sandbox danger-full-access` (or
`--dangerously-bypass-approvals-and-sandbox`-equivalent config) INSIDE the container and
let the container be the wall, exactly like our `bypassPermissions`-in-container stance.

#### 5. What's verifiable WITHOUT a subscription
- **Free (no account):** installing the CLI; `codex --version`; `codex app-server
  generate-json-schema` / `generate-ts` — the FULL protocol schema comes from the binary
  offline, so fixtures are ground-truth, not doc-transcribed. Adapter unit tests: a fake
  `codex-app-server` (a small node script speaking the recorded JSON-RPC frames) exercises
  start/send/interrupt/approve/deny/resume/model-list end-to-end against `CodexRuntime`.
  Event-mapping tests: recorded `item/*` fixtures → assert emitted `StationEvent`s.
  Transcript-capture tests are provider-neutral (feed synthetic RuntimeMessages).
- **Needs a real signed-in account:** any actual turn (model access), live approval
  round-trip timing, real usage-limit behaviour, login-flow UX verification.
- **Cheapest qualifying plan for the live test: ChatGPT Plus, $20/month** (cancel-monthly).

#### 6. Setup UX — draft content for `docs/PROVIDERS.md` (to be created in P2, not now)
> # Providers
> Orchard runs agent sessions through pluggable runtimes. Each provider bills to its own
> subscription — Orchard never holds API keys.
>
> ## Claude (Anthropic) — default
> - Install: `npm install -g @anthropic-ai/claude-code` (or the official installer).
> - Connect: run `claude` once and sign in (Claude Pro/Max subscription). Credentials:
>   `~/.claude/.credentials.json`.
> - Detected when: the `claude` binary is on PATH and credentials exist.
>
> ## OpenAI Codex
> - Requires a ChatGPT plan with Codex access: **Plus ($20/mo)**, Pro, Business, Edu or
>   Enterprise. Free/Go do not include CLI access.
> - Install ONE of:
>   - `npm install -g @openai/codex`
>   - `brew install --cask codex`
>   - `curl -fsSL https://chatgpt.com/codex/install.sh | sh`
> - Connect the subscription: `codex login` (opens your browser; pick "Sign in with
>   ChatGPT"). On a headless machine: `codex login --device-auth`. Do NOT use an API key —
>   that switches billing to pay-per-token.
> - Credentials land in `~/.codex/auth.json` (treat like a password; auto-refreshes).
> - Verify: `codex login status`, then `codex` in any repo for a smoke turn.
> - Orchard detects it when: `codex` is on PATH, the version meets Orchard's pinned
>   minimum, and `auth.json`/keyring credentials exist; the session composer then offers
>   the Codex runtime, with unsupported features (cost budget, subagent panel, plan mode)
>   shown as unavailable rather than broken.
> - Limits: usage is metered by your ChatGPT plan in rolling 5-hour windows; Orchard
>   surfaces Codex's token usage per turn but cannot show a dollar cost.

#### 7. Risk / alternatives
Codex CLI is currently OpenAI's flagship developer agent — the same engine powers the IDE
extension, desktop app, cloud, and the official SDK, and the repo ships multiple releases
a day — so discontinuation risk is low; the real risk is protocol churn (app-server is
"experimental and subject to change"; the fast alpha channel proves it), mitigated by
pinning a stable version + regenerating schemas per pin. If Codex CLI ever became
unsuitable, the honest fallback inside the "must bill to a subscription" constraint is
thin: the OpenAI Agents SDK / Responses API are API-key, pay-per-token products, and
ChatGPT desktop has no driveable headless interface. Practically, the alternative
providers worth adapting next are other subscription CLIs (e.g. Google's Gemini CLI-class
tools), not a different OpenAI surface — which is fine: the AgentRuntime seam is
provider-plural by design.

#### Recommended P2 build plan (phased)
- **P2a — protocol fixtures + CodexRuntime skeleton (NO subscription needed, ~2-3 days):**
  install pinned CLI (no login), generate JSON schema/TS types from the binary, build
  `src/server/runtime/codex-runtime.ts` speaking app-server JSON-RPC over a spawned child
  (reusing `spawnProcess`/`pathToExecutable` seams), the event-mapping table → existing
  `StationEvent`s, approval bridging (allow/deny only), capabilities as above; verify
  entirely against a scripted fake app-server + recorded fixtures.
- **P2b — Orchard-owned transcript capture (provider-neutral, NO subscription, ~2-4 days):**
  the P1-flagged core work — persist RuntimeMessages for non-Claude runtimes so
  detach/reattach/watcher/fork stop depending on Claude's `.jsonl`; testable with
  synthetic streams. Wire `thread/resume`/`thread/fork` for continuity.
- **P2c — live verification (NEEDS ChatGPT Plus, $20, ~1-2 days):** `codex login` on the
  station, real turns through the dashboard, approval round-trips, interrupt, resume
  across restart, container-isolation composition (`danger-full-access` inside the wall),
  usage-limit behaviour. Then P3 (UI picker reading `capabilities`) as already planned.

Sources: github.com/openai/codex (+ /releases, codex-rs/app-server/README.md,
codex-rs/docs/codex_mcp_interface.md, sdk/typescript), developers.openai.com/codex/{auth,
noninteractive,mcp,config-reference} (308→learn.chatgpt.com/docs/*),
learn.chatgpt.com/docs/{pricing,sandboxing,permissions,codex/cli}. No code changed, no
installs, no commits.

### 2026-08-05 — P2a builder (CodexRuntime adapter, fixture-verified, no subscription/install)
Built P2a exactly as the appendix planned, with ONE honest deviation: the codex CLI was
NOT installed (supply-chain caution + user decision), so the protocol fixtures could not
come from `codex app-server generate-json-schema`. They are **DOCUMENTATION-DERIVED** —
hand-written from this ticket's P2 appendix (which cites codex-rs/app-server/README.md +
codex_mcp_interface.md) — and labelled as such in the fixtures file's `$provenance`.
**P2c MUST re-validate every wire shape against the real pinned binary's generated
schema before any live session.**

**Files (new):**
- `src/server/runtime/codex-runtime.ts` — `CodexRuntime implements AgentRuntime` +
  `detectCodex()` (picker-shaped: connected / installed-not-signed-in / not-installed,
  with label+hint; PATH scan + `$CODEX_HOME|~/.codex/auth.json`; keyring caveat noted).
- `scripts/fixtures/codex-app-server.fixtures.json` — the documented JSON-RPC frames.
- `scripts/fixtures/codex-fake-app-server.mjs` — scripted fake app-server that REPLAYS
  the fixtures and VALIDATES the client protocol (any violation → stderr + exit 1; the
  suite asserts exit 0 after clean stdin-close).
- `scripts/verify-codex-runtime.mjs` — drives the REAL adapter through the fake via the
  runtime's own `spawnProcess` seam (so the `codex app-server` spawn contract is asserted
  too).
- `docs/PROVIDERS.md` — created from the appendix draft (install channels, `codex login`
  → "Sign in with ChatGPT" never API key, Plus $20 minimum, detection table, what's
  grayed out and why, rolling 5-hour-window caveat).

**Event mapping (the de-facto RuntimeMessage dialect is the Claude SDK shape —
`AgentSession.#handle` consumes that, so the adapter translates INTO it):**
thread id → `system/init.session_id`; `item/agentMessage/delta` →
`stream_event/content_block_delta/text_delta`; completed `agentMessage` → assistant text;
`reasoning` → assistant thinking block (empty text, parity with the Claude path);
tool-ish `item/started` (commandExecution/fileEdit/mcpToolCall/webSearch, Codex-native
names, `parent_tool_use_id:null` — subagents:false) → `tool_use`; their `item/completed`
→ `tool_result` (`status:'failed'` → `is_error`); `turn/completed` → `result` with
`usage` tokens and deliberately NO `total_cost_usd`; `turn/failed` →
`result/error_during_execution`. Approvals: `execCommandApproval`/`applyPatchApproval`
(+ newer `item/*/requestApproval` spellings) → the session's `onApproval` seam →
respond `{decision:'allow'|'deny'}` (allow/deny ONLY — `updatedInput` cannot round-trip;
documented in-code). acceptEdits = adapter-side auto-allow of file-change approvals.
Permission modes map to approval_policy × sandbox_mode and apply from the NEXT turn;
`plan` is REFUSED with an explicit error (Codex has no plan mode). `interrupt()` →
`turn/interrupt` → `result/interrupted`. Resume → `thread/resume`; resume+fork →
`thread/fork`. `supportedModels()` → `model/list` (supportsEffort from effort options).
Follow-up sends are adapter-serialised (InputQueue role); `turn/steer` deferred to P2c.
Capabilities EXACTLY per the appendix: approvals/permissionModes/modelList/fork/effort
true; structuredCost/subagents/persistedTranscript false.

**NOT wired into agent-bridge/session start** — that is P3 (UI picker). No edits to
`src/server/index.ts`, `package.json`, or any `wa-*` file. **package.json entry to add
(reported, not applied):** `"verify:codex-runtime": "node scripts/verify-codex-runtime.mjs"`.

**Verification (§C):**
- `node scripts/verify-codex-runtime.mjs` — **32/0 PASS** (handshake→turn→stream→result;
  follow-up serialisation; approval allow AND deny + patch prompt + acceptEdits
  auto-allow; interrupt; resume; fork; model list; bypass/model overrides asserted ON THE
  WIRE by the fake; plan refusal; detection ×4; ENOENT honesty; fake exit 0 everywhere).
- Non-vacuity PROVEN: `--stub` (adapter swapped for a do-nothing shell) → 27 checks FAIL,
  exit 1.
- `typecheck` — PASS.
- ClaudeRuntime path unregressed: `verify:overrides` (live browser + real server) — 5/0.
- Constraints honoured: :4317 untouched, nothing installed, children killed by pid.

**P2c live-test checklist (when the user buys ChatGPT Plus, ~$20 cancel-monthly):**
1. Install pinned CLI (official channel), `codex login` → "Sign in with ChatGPT";
   `codex login status` green; confirm `~/.codex/auth.json` → `detectCodex()`=connected.
2. `codex app-server generate-json-schema` → diff EVERY fixture shape (init result,
   thread/start|resume|fork params+results, turn/start params — esp. the
   `approvalPolicy`/`sandboxMode`/`reasoningEffort` key spellings, item/* payloads,
   approval request/response, model/list) and correct adapter + fixtures for drift.
3. Real turn end-to-end through CodexRuntime (host, workspace-write + approvals on):
   stream deltas, tool_use/tool_result, result usage.
4. Live approval round-trip (allow AND deny) incl. timing; verify `turn/steer` semantics
   and whether force-send should use it.
5. Interrupt mid-turn; resume across process restart via `thread/resume`; `thread/fork`.
6. Container-isolation composition: `danger-full-access` INSIDE the wall (Codex's
   seccomp/landlock may not init under Docker's seccomp — ours-outside-theirs).
7. Usage-limit behaviour at a rolling 5-hour window edge; how the wire reports throttle.
8. Then P2b (Orchard-owned transcript capture) unlocks detach/transcript/fork UI, and P3
   wires the picker off `capabilities` + `detectCodex()`.

### 2026-08-05 — P3 builder (provider picker + CodexRuntime wired into the REAL session-start path; VERIFIED)

Built P3: `provider: 'anthropic' | 'openai'` is now a real per-project setting AND a
per-session-launch override, and the `AgentSession` constructor picks the engine from it.
Default 'anthropic' everywhere a value is absent — zero behaviour change for existing
projects (verified: fresh-project default check + verify:overrides 5/0 + provider-errors
live haiku sanity all green).

**Mid-task ground change (user/orchestrator):** codex is ALREADY installed and signed in
on this machine — `~/.local/bin/codex`, codex-cli 0.146.0, `~/.codex/auth.json`
`auth_mode:"chatgpt"`. **P2c is UNBLOCKED.** This reshaped detection (see gotcha below).

**Changes (file:line):**
- `src/server/registry.ts:14-27,142-149,180` — `Provider` type, `providerOf()`,
  `settings.provider?` (optional in stored JSON), `defaultSettings()` sets 'anthropic'.
  Scalar → normal shallow merge; no deep-merge case needed.
- `src/server/validate.ts:16,33,64-72,374-378` — provider in the settings allow-list
  (unknown value → "provider must be one of anthropic, openai"), and in
  `SESSION_OVERRIDE_FIELDS` (launch-scoped, touches nothing on disk).
- `src/server/events.ts:15,29-40` — `SessionOverridable` + `EffectiveConfig.provider`
  + `EffectiveConfig.capabilities` (the UI grays out from THESE flags, never provider
  string-matching).
- `src/server/runtime/runtime.ts:44-56` — capabilities grew two honesty flags:
  `planMode` (Claude true / Codex false) and `mcpConfig` (per-session mcpServers
  accepted at start; Codex false until `-c mcp_servers…` lands in P2c).
- `src/server/agent-bridge.ts:494-521` — **the wiring**: resolved provider → `new
  CodexRuntime()` | `new ClaudeRuntime()`, constructed BEFORE isolation routing so the
  routing can read capabilities. 'openai' fail-fast when `detectCodex()` is not
  connected (fatal error carrying the detection label + hint; the session never
  constructs, so busy can never hang) — skipped when `CLAUDE_STATION_CODEX_BIN` names a
  binary explicitly (the verification seam). Also `:567-571` container binary per
  provider; `:606-614` survival spawn-seam now gated on
  `capabilities.persistedTranscript` (a survived Codex CLI would be un-reattachable —
  honest degradation, documented); `:652-666` mcpServers dropped LOUDLY (named status
  line) for `mcpConfig:false` engines instead of silently ignored; `:1116-1118`
  `get capabilities()`; effectiveConfig() now carries provider + capabilities; start()
  wrapped so a sync engine refusal (Codex refusing 'plan') reaches the UI as a fatal.
- `src/server/index.ts:681-697` — **GET /api/providers**: anthropic always-connected +
  live `detectCodex()` verdict; `:2015,:2113` capabilities ride both start acks.
- `src/server/runtime/codex-runtime.ts` — P3 gotcha fix + stubs (in-scope per charter):
  (a) **detection beyond PATH** (`:117-146`): a systemd service's minimal PATH misses
  `~/.local/bin` — the exact live case on this machine — so detectCodex scans PATH plus
  well-known dirs (~/.local/bin, ~/.npm-global/bin, ~/bin, /usr/local/bin,
  /opt/homebrew/bin), and `start()` resolves a bare 'codex' through the same detection
  so spawn can't ENOENT on a binary the picker just called connected; (b)
  `CLAUDE_STATION_CODEX_BIN` env seam (.mjs → run under current node) — how the fake
  app-server drives the REAL start path; (c) `classifyProviderError()` (BUG-031
  minimal): turn-failure results pattern-mapped to quota-window / rate-limited /
  auth-expired / model-unavailable / network with an HONEST 'internal' fallback,
  provider 'openai', detail verbatim — regexes are TODO-level (doc-derived) and P2c
  must swap them for the real `CodexErrorInfo` codes (see schema diff).
- `public/lib/drawer.js:376,411-476` — Provider group in the Instructions & tools
  section beside Integrations (FEAT-034 sections): a `.seg` picker (Claude / OpenAI
  Codex) writing settings.provider (project scope) or ctx.overrides.provider (session
  scope, cleared when re-picking the project default), plus the LIVE `/api/providers`
  verdict as a `.prov-state` line (connected / installed-not-signed-in + `codex login`
  hint / not-installed + install hint). Selecting OpenAI while not connected is allowed
  but carries a warn note ("launching will fail with the hint above").
- `public/app.js:1633-1641` — plan toggle hidden when `capabilities.planMode === false`
  (absent capabilities = full UI; degradation only ever on the engine's own word);
  `:5798-5815` crown chip carries `data-provider` + a quiet `codex · ` prefix (anthropic
  render byte-identical to pre-P3 — verify:model-chip still 1 passed); capabilities +
  provider folded into state.effective from both effective-config and the start ack.
  Cost honesty needed NO new code: turn-end only prints a $ figure when the engine
  reported one, and CodexRuntime never fabricates `total_cost_usd`.
- `public/styles.css:918-936` — `.prov-state` (mono/dot, sess-status voice),
  `.grp-note[data-warn]` (warm accent, no red). Greyscale/hairline held.
- `scripts/verify-provider-picker.mjs` (NEW) + `scripts/verify-codex-runtime.mjs`
  (capabilities `want` grew planMode/mcpConfig; spawn-contract check accepts the
  detection-resolved absolute path; +1 new check: binary at ~/.local/bin with a
  stripped PATH still detected — now **33** checks).

**Verification (§C, all real paths):**
- `verify:provider-picker` — **16/0** (A: route + persistence + 400 + default-anthropic;
  B: picker renders live verdict, choice survives full reload; C: **the END-TO-END
  PROOF** — provider='openai' through the REAL startSession, CodexRuntime speaking
  JSON-RPC to the protocol-VALIDATING fake app-server via the spawn seam, message in →
  streamed "Hello from fixture Codex." rendered → busy resolves, sdkSessionId =
  thr_fixture_0001; capabilities honest on the wire; NO dollar figure anywhere; plan
  toggle hidden; crown chip codex-marked; D: not-connected server (scrubbed HOME/PATH)
  → 'not-installed' + hint on the route AND in the drawer, launch fails in ~100ms with
  the detection hint, no ack, no hang; E: real binary detected at ~/.local/bin off-PATH,
  `codex --version` → codex-cli 0.146.0).
- **MUST-FAIL proven against a HEAD worktree** (P3 absent): **2 passed, 14 failed** —
  route 404, provider field rejected, no picker, ClaudeRuntime always constructed (the
  pre-change C run visibly spawned a real claude session), no fast-fail (start acked).
- Unregressed: `verify:overrides` 5/0 · `verify:provider-errors` 22/22 (incl. live
  haiku sanity) · `verify:model-chip` 1 passed · `verify:tool-toggle` 13/13 (the MCP
  seam I gated) · `verify:codex-runtime` 33/0 · `typecheck` PASS · `verify:ui --offline`
  3/0. Constraints: :4317 untouched, scratch ports, kill by pid, nothing installed.
- Screenshots: `FEAT-037-picker.png` (connected verdict + honest gray-out note),
  `FEAT-037-codex-session.png` (streamed codex turn, chip "codex · codex default",
  turn-end with no $), `FEAT-037-not-connected.png`, `FEAT-037-codex-real-attempt.png`.

**P2c de-risk (report-only, per orchestrator instruction — NOT silently adapted):**
`codex app-server generate-json-schema --out …` (0.146.0, offline) vs our
documentation-derived fixtures. MATCHES: all method names (initialize, thread/start|
resume|fork, turn/start|steer|interrupt, model/list), notifications (thread/started,
turn/started, item/started, item/agentMessage/delta {itemId, delta}, item/completed,
turn/completed, thread/tokenUsage/updated), `approvalPolicy` key, input
`[{type:'text',text}]`, Turn.status enum incl. 'interrupted', all our tool item types
(agentMessage/reasoning/commandExecution/fileChange/mcpToolCall/webSearch — plus
plan/subAgentActivity/collabAgentToolCall we don't map yet). **DRIFT (adapter+fixtures
must change in P2c):**
1. sandbox key: thread/start takes `sandbox`, turn/start takes `sandboxPolicy` — we
   send `sandboxMode` on both.
2. effort: `TurnStartParams.effort` — we send `reasoningEffort` on thread/start.
3. model/list response: `{data, nextCursor}` — we read `{models}`.
4. **No `turn/failed` notification exists.** Failure is `turn/completed` with
   `turn.status:'failed'` + `turn.error.message` (+ structured `codexErrorInfo` — the
   right source for classifyProviderError). Our turn/failed branch is dead code on the
   real wire; a real failed turn would currently map to subtype 'success'.
5. **Approval responses are NOT `{decision:'allow'|'deny'}`**: ReviewDecision is
   `'approved' | 'approved_for_session' | {denied:{rejection}} | 'abort' | 'timed_out'`
   (+ execpolicy/network amendment forms). Newer requests are
   `item/commandExecution/requestApproval` with itemId/threadId/turnId/approvalId.
6. ThreadStartResponse carries thread + model/reasoningEffort/sandbox echo (shape ok
   for our `thread.id` read).
This drift is exactly why the one REAL end-to-end turn attempt (report-only section E2)
did not complete (sessState 'error' after turn/start) — expected and now precisely
diagnosed. The fake-app-server proof remains the deterministic P3 evidence.

**package.json entries to add (reported, NOT applied — per charter):**
- `"verify:provider-picker": "node scripts/verify-provider-picker.mjs"` (append
  `--no-live` to skip the report-only real-binary turn)
- (already reported by P2a, still unapplied: `"verify:codex-runtime": "node scripts/verify-codex-runtime.mjs"`)

**Handoff:**
- P2c (UNBLOCKED): apply the 6 drift fixes above to codex-runtime.ts + fixtures, then
  the live checklist from the P2a entry (real approvals, interrupt, resume, container
  composition, window throttling; wire `turn/steer`; swap classifyProviderError regexes
  for `codexErrorInfo` codes).
- P2b unchanged (Orchard-owned transcript capture) — unlocks detach/transcript/fork UI
  for Codex (`persistedTranscript` flips true), and re-enables survival for it.
- docs/PROVIDERS.md detection table should gain the well-known-dirs note (~/.local/bin
  case) — left unedited here (out of the P3 file scope), one-line follow-up.

### 2026-08-05 — P2c builder (real-binary wire re-validation + LIVE subscription verification)

Executed P2c: fixed all schema drift against the REAL binary's generated schema
(`codex app-server generate-json-schema`, codex-cli 0.146.0 at ~/.local/bin/codex, run
offline; treated as ground truth per charter), then proved the runtime LIVE on the real
ChatGPT subscription through the real dashboard path. **P2a/P2c and P3 are now
VERIFIED-LIVE** (status line updated).

**Drift fixed (adapter `src/server/runtime/codex-runtime.ts` + fixtures + fake — the
fake now VALIDATES the corrected shapes, so reverting any fix is a protocol VIOLATION):**
1. `thread/start` takes `sandbox` (SandboxMode STRING: read-only|workspace-write|
   danger-full-access); `turn/start` takes `sandboxPolicy` (OBJECT, camelCase `type`:
   readOnly|workspaceWrite|dangerFullAccess). `sandboxMode` exists nowhere.
2. Reasoning effort is `TurnStartParams.effort`; thread/start has NO effort key.
3. `model/list` → `{data: Model[], nextCursor}` (paginated), Model.supportedReasoningEfforts
   is an array of {reasoningEffort, description} option objects.
4. NO `turn/failed` notification exists. Failure IS `turn/completed` with
   `turn.status:'failed'` + `turn.error{message, additionalDetails?, codexErrorInfo?}` —
   the dead turn/failed branch was removed; failed status is handled on turn/completed
   and carries `codex_error_info` through to the result frame.
5. Approval replies are the method's own dialect, never `{decision:'allow'|'deny'}`:
   execCommandApproval/applyPatchApproval take a ReviewDecision — `'approved'` |
   `'approved_for_session'` | `{denied:{rejection}}` | `'abort'` | `'timed_out'`; the
   v2 `item/commandExecution|fileChange/requestApproval` family takes `'accept'` |
   `'acceptForSession'` | `'decline'` | `'cancel'`. (Live: 0.146.0 sends the **v2
   spelling**; our `accept` reply worked.) A deny's message round-trips as the rejection
   text. Unknown server requests now get a proper JSON-RPC -32601 instead of a fake deny.
6. Beyond the flagged five, the schema also corrected: approvalPolicy enum is
   `untrusted|on-request|never` (docs' 'unlessTrusted' does not exist — default/
   acceptEdits map to `untrusted`); the Turn object carries **NO usage** — tokens arrive
   via `thread/tokenUsage/updated{tokenUsage:{last,total}}` (adapter stashes `.last` per
   turn for the result frame); `thread/started` params carry `{thread}` not `{threadId}`;
   there is no 'fileEdit' item type (it's 'fileChange', statuses incl. 'declined' → maps
   to is_error tool_result); initialize response = {userAgent, codexHome, platformFamily,
   platformOs}; ThreadStart/Resume/Fork responses echo approvalPolicy/cwd/model/
   modelProvider/sandbox. Also: model now rides ONLY turn/start (a bogus model fails
   THAT TURN classifiably instead of killing thread/start), and a rejected turn/start
   request is mapped to a failed-turn result, not transport death.

**classifyProviderError upgraded** from doc-derived regexes to the schema's
`CodexErrorInfo` codes: usageLimitExceeded → **quota-window** (the rolling-window case,
per BUG-031); serverOverloaded → overloaded (retryable); unauthorized → auth-expired;
internalServerError → internal (retryable); object variants (httpConnectionFailed/
responseStream*) → network/rate-limited/auth by httpStatusCode; `badRequest`/`other`
fall through to text heuristics (live probe showed a bogus model arrives as
codexErrorInfo:'other' with the upstream 400 body verbatim — "The '<model>' model is
not supported when using Codex with a ChatGPT account." → model-unavailable); honest
'internal' fallback kept. Fixture badModel now mirrors the LIVE-observed frame.

**Fixture/fake provenance flipped** documentation-derived → **schema-validated** (full
provenance note in the fixtures' $provenance). Formal re-diff run post-fix: all 6 drift
items asserted clean (schema key presence + adapter/fixture conformance, 15/15).

**LIVE results (real binary + real subscription, scratch server, provider='openai',
modest usage — ~6 small turns total):**
- (a) PASS — session starts through the REAL dashboard; "Reply with exactly
  P2C-LIVE-OK" streamed into the UI, busy resolved, chip `codex · codex default`.
- (b) PASS — interrupt mid-turn (count-to-300 turn stopped via the Stop button):
  busy resolved, session stayed alive, turn-end line "interrupted · 1 turns".
- (c) PASS — model/list populated /api/models with the real catalog
  (gpt-5.6-sol/terra/luna, gpt-5.5, gpt-5.4, gpt-5.4-mini — note: NOT the fixture names).
- (d) PASS — resume: direct CodexRuntime driver with resume:<threadId> continued the
  SAME thread (init echoed the id) and recalled the earlier turn's string
  ("P2C-LIVE-OK") — thread/resume works on the real wire across processes.
  (Dashboard-path resume/detach UI remains gated by persistedTranscript:false → P2b.)
- (e) PASS — approval round-trip: `untrusted` policy + a non-trusted command (curl) →
  the v2 requestApproval fired → dashboard approval card (Deny/Allow) rendered → Allow →
  command executed, output streamed. TWO honest findings: (1) trusted commands (echo)
  run WITHOUT a prompt under `untrusted` — the policy's own trust list, not a bug;
  (2) approval ≠ sandbox escape: the allowed curl still failed DNS inside the
  network-restricted workspace-write sandbox (exit 6, relayed honestly).
- (f) PASS — error path: project model 'gpt-bogus-p2c' → turn failed → BUG-031
  ATTRIBUTED card rendered: provider 'openai', upstream 400 body verbatim; after the
  classifier fix the same failure classifies **model-unavailable** (live re-probed).
- Screenshots: `FEAT-037-P2c-live.png` (the live session: reply + approved command +
  interrupted turn), `FEAT-037-P2c-live-approval.png` (approval card),
  `FEAT-037-P2c-live-error-card.png` (attributed error card).

**Documented, NOT proven live (honest gaps):** deny-path approval on the real wire
(proven against the validating fake only); turn/steer force-send semantics (still
adapter-serialised); container-isolation composition; a REAL usage-window throttle
(fixture-simulated only — classification path proven, the real frame shape at a window
edge unobserved); `thread/fork` live (fixture-proven only); keyring-credential
detection.

**Verification (§C):** `verify:codex-runtime` **39/0** (was 33; +6: failed-turn shapes ×4
incl. quota-window/model-unavailable/overloaded/network classification, success-classifies-
null, live-observed badModel frame) · non-vacuity: `--stub` → 5/34 FAIL; reverting the
approval-shape fix to {decision:'allow'} → fake VIOLATION + suite fails (proven, then
restored) · `verify:provider-picker` 16/0 (--no-live; the full run's report-only E2 REAL
turn now PASSES — first live proof the corrected protocol holds) · `verify:provider-errors`
22/22 · `typecheck` PASS · `verify:ui --offline` 3/0 · re-diff clean (above). Constraints:
:4317 untouched, scratch ports, killed by pid, nothing installed, no commit.

**docs/PROVIDERS.md updated:** well-known-dirs detection note (P3 follow-up), P2c live
verification note incl. the approval≠sandbox-escape finding, schema-validated provenance.

**Handoff:** P2b (Orchard-owned transcript capture) is the sole remaining phase —
unlocks detach/transcript/fork UI + survival for Codex. Protocol-churn watch: app-server
is experimental; on any codex upgrade, re-run `generate-json-schema` and the re-diff
(the validating fake makes drift loud).

### 2026-08-05 — P2b builder (Orchard-owned transcript capture — the final phase; VERIFIED fixture + LIVE)

Built P2b: when a session's engine declares `capabilities.persistedTranscript:false`
(Codex), the BRIDGE now writes an Orchard-owned transcript — one append-only JSONL
file per session under `dataDir()/transcripts/<provider>/<encodedDir>/<sessionId>.jsonl`
— in the SAME entry shape the Claude store uses (`{type:'user'|'assistant',
uuid, parentUuid, timestamp, sessionId, cwd, provider, message:{content:[…]}}`, the
one `jsonl.ts#toMessage` consumes). Mirroring the store LAYOUT is the design's whole
trick: `session-history`'s functions all take `{root}`, so listing/resolving/liveness
reuse the exact readers the Claude store uses — zero forked readers, one canonical
message space. `<sessionId>` IS the engine's resume handle (the Codex thread id from
`system:init`), so a file's name is exactly what `thread/resume` needs later; a
resume appends to the SAME file (Codex keeps the thread id), which is why close→
reopen→continue reads as one continuous transcript.

**Design/wiring (file:line ranges approximate):**
- `src/server/orchard-transcripts.ts` (NEW) — roots/resolvers (`providerRoots`,
  `resolveOrchardSessionFile`, `listOrchardSessions` — thin wrappers over
  `hist.*` with `{root}`), and `TranscriptRecorder`: buffers entries until
  `system:init` names the file (a session that never inits leaves no file), then
  `fs.appendFileSync` per line — append-only by construction; an append failure
  stops capture LOUDLY once (non-fatal error event: "history will be missing"),
  never kills the session.
- `src/server/agent-bridge.ts` — `#recorder` armed in the constructor iff
  `!capabilities.persistedTranscript`; user prompts recorded at the send seams
  (constructor firstPrompt + `send()`, which also covers the autonomous nudge —
  the engine never echoes user input); inbound frames recorded at the TOP of
  `#handle` (recorder filters to main-thread assistant/user content). RESUME:
  **the transcript picks the engine** — on `resumeSessionId`, an Orchard hit
  (provider dir) overrides the configured provider (announced via status, and
  `effective.provider` updated so effectiveConfig stays truthful); a non-Orchard
  vetted resume forces 'anthropic' (a thread id is only meaningful to the engine
  that minted it). Fork of an Orchard session is REFUSED with a named error
  (thread/fork exists on the wire, but the fork's new thread would need its
  transcript seeded with ancestor history — follow-up), pointing at resume.
- `src/server/fork.ts` — `explainUnresumable` recognises Orchard transcripts as
  resumable (the file proves the thread; the engine resumes by id).
- `src/server/watcher.ts` — `resolveAnySessionFile` fallback (Claude store →
  Orchard store) for `watchSession`/`isSessionLive`, + `orchardLiveSessions()`
  (same mtime-window scan pointed at each provider root).
- `src/server/index.ts` — transcript route falls back to the Orchard resolver
  (tail/forward/count/pagination serve both stores identically);
  `sessionsForProject` merges Orchard sessions (rows carry `provider`);
  `/api/sessions/live` unions both stores.
- `public/app.js` + `public/styles.css` — UN-GATED UI: codex sessions now appear
  in the sidebar with a quiet `codex` engine tag (`.prov-tag`, crown-chip voice);
  anthropic rows render byte-identical. Reopen/resume needed NO client change —
  the existing transcript fetch + `startTurn({resumeSessionId})` paths just work.
- `scripts/fixtures/codex-fake-app-server.mjs` — `CODEX_FAKE_EXPECT_RESUME` env
  pins the ONE legal `thread/resume` target (any other id = violation = exit 1),
  the wire assertion the resume checks lean on. Default behaviour unchanged
  (verify:codex-runtime still 39/0).
- `src/server/runtime/codex-runtime.ts` — comments only: `persistedTranscript`
  STAYS false (it means "the ENGINE persists its own store"; the bridge
  compensates), detach() note updated (detach-and-return now works — the
  recorder keeps appending while detached).

**Survival gating revisited (charter item 3) — deliberately LEFT GATED.** The
recorder lives in the server process: a CLI surviving a `systemctl restart`
would keep producing turns with NOBODY recording — the transcript would omit
exactly the work survival protected, and re-adopt would render a hole. The
Claude CLI has no such hole (it writes its own store regardless of us). Gate
unchanged (`survivalEnabled() && capabilities.persistedTranscript`), reasoning
documented at the gate.

**Verification (§C, non-vacuous):**
- `scripts/verify-orchard-transcripts.mjs` (NEW) — **15/0**: (A) capture —
  real server + real bridge + CodexRuntime against the protocol-validating
  fake app-server: file appears at the documented path, every entry a valid
  Claude-store shape, entry 0 = the user prompt, assistant reply captured,
  second turn proves append-only (old bytes a STRICT PREFIX); (B) history —
  the UNCHANGED `/api/transcript` tail route serves it (both roles render),
  project sessions list carries the row provider-tagged + titled from the
  first prompt, `/api/sessions/live` saw it being written (drivenByDashboard);
  (C) resume — with the fake pinned to the first session's thread id, a real
  close→reopen hit `thread/resume` with EXACTLY that id on the wire (any other
  id = fake violation = transport death = the checks fail), appended to the
  same single file; (D) UI — sidebar row visible + `codex`-tagged, clicking it
  renders the recorded history like any Claude session, and sending from the
  reopened view resumes the same thread end-to-end through the composer.
- **MUST-FAIL proven against a HEAD worktree** (P2B_SERVER_ROOT): 2 passed,
  12 failed + FATAL — no file written, transcript route 404, session list
  empty, resume refused, no row to reopen. Exactly the pre-change reality.
- **LIVE (real binary + real ChatGPT subscription, 2 tiny turns total):**
  turn 1 planted a codeword → close (bridge session fully closed, verified) →
  reopen from the sidebar → recorded history RENDERED → turn 2 "reply with the
  codeword only" → **`ORCHARD-P2B`** — same thread id
  (019fd1e6-6cbf-75b2-bf11-3c1fa5a011ae) across the reopen, one file, 4
  entries, the recall captured in the transcript too. Cross-restart
  thread/resume on the real service CONFIRMED (no degradation path needed).
  Screenshots: `FEAT-037-P2b-live-history.png` (reopened history + codex chip),
  `FEAT-037-P2b-live-resume.png` (codeword recalled), plus
  `FEAT-037-P2b-fixture-history.png` (fixture UI render).
- Anti-regression: `verify:reload-live` **3/0** (live Claude reload path) ·
  `verify:overrides` **5/0** · `verify:codex-runtime` **39/0** ·
  `verify:provider-picker` **16/0** (--no-live) · `verify:ui --offline` 3/0 ·
  `typecheck` PASS. Constraints: :4317 untouched, scratch ports + scratch data
  dirs, killed by pid, nothing installed, no commit.

**Honest gaps (named, not hidden):** UI fork of a codex session refused (needs
ancestor-seeded transcript for the forked thread); search (`rg` over the Claude
store) and rename/tag/delete don't cover Orchard transcripts yet; a just-closed
codex session shows the same mtime-window "being written live by another
process — following along" line a just-closed Claude session shows (shared
semantics, fades after 30s). docs/PROVIDERS.md updated (P2b section replaces
the "unlocks when P2b lands" caveat).

**package.json entry to add (reported, NOT applied — per charter):**
`"verify:orchard-transcripts": "node scripts/verify-orchard-transcripts.mjs"`
(run against a HEAD worktree via `P2B_SERVER_ROOT` to reproduce the must-fail).

### 2026-08-06 — subagent capability re-check (READ-ONLY research; refutes `subagents:false`)

**Verdict: the P2 appendix's `capabilities.subagents:false` is WRONG for current codex-cli (0.146.0).**
Codex now has native subagents ("multi-agent" / collaboration), enabled by default, and it IS
on the app-server wire we drive.

1. **Feature exists.** Official docs (developers.openai.com/codex/subagents →
   learn.chatgpt.com/docs/agent-configuration/subagents): custom agents as **TOML files** in
   `~/.codex/agents/` (personal) / `.codex/agents/` (project); global `[agents]` in config.toml
   incl. `agents.max_concurrent_threads_per_session`; invoked by asking ("spawn one agent per
   point"), via AGENTS.md/skill instructions, or `/agent` to inspect/switch threads.
   "Current local Codex releases enable subagents by default."
2. **Local ground truth (binary at ~/.local/bin/codex, 0.146.0):** `codex features list` →
   `multi_agent  stable  true` (v1 default-on; `multi_agent_v2  stable  false` = opt-in v2).
3. **Version history (github.com/openai/codex releases):** multi-agent shipping since the
   ~0.13x era (May 2026; v1 tools namespaced 0.133.0, "canonical sub-agent activity items"
   0.144.0 #31299); **0.145.0 (2026-07-21) "Stabilized the opt-in multi-agent V2 experience"**
   with configurable sub-agent models/concurrency; 0.146.0 tracks multi-agent mode in world
   state (#34845).
4. **On the app-server wire** (`codex app-server generate-json-schema`, v2 schemas):
   thread-item variant **`collabAgentToolCall`** (`CollabAgentToolCallThreadItem`) in
   `item/started|completed` notifications, with `tool ∈ {spawnAgent, sendInput, resumeAgent,
   wait, closeAgent}` (`CollabAgentTool`) and status `inProgress|completed|failed`; a
   sub-agent activity item carrying `agentThreadId`, `agentPath`, `kind ∈
   started|interacted|interrupted` (`SubAgentActivityKind`); `SubAgentSource.thread_spawn`
   with `parent_thread_id` + `depth` + `agent_role/nickname` — i.e. a direct analogue of our
   `parent_tool_use_id` mapping for the LiveAgent panel. `MultiAgentMode`
   (`explicitRequestOnly|proactive|custom`) governs delegation policy per turn.
5. **Auth:** works under ChatGPT-subscription auth — docs describe local releases
   default-enabled (no API/cloud gate), and the flag is live on this machine's
   subscription-authed install. (Token burn scales with spawn count, per docs.)

**Action for FEAT-037:** flip CodexRuntime `capabilities.subagents` to true (or "mappable")
and map `collabAgentToolCall` + sub-agent activity items → `agent-*` StationEvents keyed by
`agentThreadId`/`parent_thread_id`. Verified read-only: no turns run, nothing installed,
:4317 untouched. Sources: developers.openai.com/codex/subagents/;
learn.chatgpt.com/docs/agent-configuration/subagents;
api.github.com/repos/openai/codex/releases (rust-v0.133.0…0.146.0); local
`codex features list`; schema dump at /tmp/codex-schema (v2/ItemCompletedNotification.json,
ClientRequest.json).

### 2026-08-06 — subagent mapping agent — capabilities.subagents flipped TRUE + collab wire mapped — VERIFIED (fixture + LIVE)

Acted on the 2026-08-06 re-check entry above: the wrong `subagents:false` is fixed and the
collab wire is mapped into the task-frame dialect the bridge already speaks — **zero
agent-bridge.ts/app.js changes needed** (that was the point of the dialect).

**Mapping (src/server/runtime/codex-runtime.ts).**
- `capabilities.subagents: true` (comment cites the re-check entry).
- `#announceAgent/#agentProgress/#settleAgent/#terminalFromAgentState/#collabItem` +
  `#collabAgents` map keyed by `agentThreadId`: spawn (`collabAgentToolCall spawnAgent` /
  `subAgentActivity kind:started` / sub-thread `thread/started` with
  `SubAgentSource.thread_spawn`) → `system/task_started` {task_id: agentThreadId,
  subagent_type from agent_role/nickname/agentPath-basename, task_type:'local_agent'} —
  exactly what the bridge's task_started handler stamps `kind:'agent'` from; interacted/
  in-flight collab calls → `task_progress`; terminals (closeAgent, agentsStates
  completed/errored/interrupted/shutdown/notFound, subAgentActivity interrupted) →
  `task_updated {patch.status completed|failed|killed}` (interrupted → killed per BUG-030).
  Depth>1 flattened honestly — own row, parent thread id in the description.
- Foreign-thread guards on turn/started, item/*, tokenUsage, turn/completed: a sub-agent
  thread's own frames share the connection and previously would have corrupted the main
  session (child turn/completed finishing OUR turn; child deltas leaking into the main
  transcript; sub-thread thread/started overwriting `#threadId`). They now surface as
  agent progress only.
- `#finishTurn` turn-boundary sweep (BUG-030 ground truth): any still-open agent settles
  completed (success) / killed (interrupted or failed turn) BEFORE the result frame.

**Live wire truth (default-on multi_agent v1, codex-cli 0.146.0, raw app-server probe
2026-08-06 — documented in the fixtures $provenance).** `multi_agent stable true` (v1,
default-ON), `multi_agent_v2 stable false` (opt-in, NOT enabled and NOT needed): v1
already emits the collab items. v1 specifics: the spawn is announced ONLY by
`subAgentActivity kind:'started'` (agentPath is a virtual path like `/root/multiply`; no
spawnAgent collab item, no sub-thread thread/started on this connection); the child
thread's own turn/item/tokenUsage frames stream on the SAME connection under its
threadId; the terminal `wait` carries EMPTY receiverThreadIds/agentsStates — hence the
turn-boundary sweep, without which v1 agents would never settle adapter-side. The richer
spawnAgent/closeAgent/agentsStates/thread_spawn shapes stay mapped (schema-derived,
labeled — likely the v2 dialect). No config was touched (~/.codex/config.toml unmodified;
no scratch CODEX_HOME needed).

**Verified.**
- `verify:codex-runtime` extended (fixtures `subagentTurn`/`subagentInterruptTurn` +
  fake SUBAGENT/SUBAGENT_INTERRUPT markers, incl. a verbatim live-shaped v1 agent):
  **54/54 PASS**; checks cover spawn→task_started (kind 'agent' fields), relabel-from-role,
  progress, wait-settle, nested depth-2 flatten + killed, live-shaped agent settling via
  the boundary sweep BEFORE result, no main-stream leak, idempotent settle, child thread
  id never adopted (fake protocol validation), interrupted→killed. MUST-FAIL proven twice:
  `--stub` (all behavioural checks fail) and `#collabItem` stubbed to return false →
  **46/54, 6 subagent checks fail**; reverted, re-run green. `typecheck` clean.
- LIVE (real dashboard path, real subscription, scratch port/data, one session):
  composer-driven "spawn exactly ONE subagent to compute 17*23" → agents panel showed
  running row `multiply · Codex subagent ◐` alongside `main`, then settled — "1 agent ran
  in this session · multiply · 0:05", turn `success`, answer 391 in the transcript.
  **4/4 PASS**; screenshots `docs/bugs/assets/FEAT-037-subagents-live-running.png` /
  `FEAT-037-subagents-live-settled.png`. :4317 untouched (200 after), pids-only cleanup.
- Anti-regression: `verify-orchard-transcripts` **15/15**; `verify-provider-picker`
  **17/17** after updating its one stale `subagents === false` expectation (the only
  out-of-scope-file touch, a direct consequence of the flip).
- `docs/PROVIDERS.md` updated: subagents supported + token-multiplication caveat.

**Handoff:** none — orchestrator reviews diff (codex-runtime.ts, fixtures json, fake
app-server, verify-codex-runtime.mjs, verify-provider-picker.mjs, PROVIDERS.md) and
commits. Follow-up candidates: live-capture the v2 opt-in dialect someday; per-agent
token attribution (task_progress usage) is not wired — v1 gives no per-agent usage frames.

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
