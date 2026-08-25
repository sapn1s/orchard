/**
 * AgentRuntime — the ONE seam between Claude Station and the model-execution
 * engine (FEAT-037 P1). Everything above `AgentSession` already speaks Orchard's
 * own `StationEvent` vocabulary; this interface is the last place a specific
 * vendor SDK is allowed to live. `ClaudeRuntime` (claude-runtime.ts) is the sole
 * implementation today and wraps `@anthropic-ai/claude-agent-sdk` exactly as the
 * bridge used to inline it — a pure refactor, zero behaviour change. A future
 * provider becomes a second adapter behind this same interface.
 *
 * DELIBERATELY OUT OF SCOPE for P1 — the on-disk session store. Detach/reattach,
 * transcript render, fork, resume and rename are NOT built on the runtime object
 * but on Claude's `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` store
 * (jsonl.ts / transcript.ts / watcher.ts / fork.ts / session-mutations.ts). That
 * is the deeper coupling the plan flags as the real risk; it is left as-is here
 * and gated conceptually by `capabilities.persistedTranscript`. A non-Claude
 * runtime would need Orchard-owned transcript capture, which is P2 work.
 */

/**
 * What a runtime can and cannot do, so the UI can honestly gray out features a
 * runtime lacks instead of faking parity (the plan's crux). ClaudeRuntime — the
 * reference engine — sets every flag `true`. A second adapter fills what it can
 * and flips the rest `false` (e.g. a plain CLI pipe with no bidirectional
 * approval channel is `approvals:false`).
 */
export interface RuntimeCapabilities {
  /** Bidirectional tool-approval / permission control channel (canUseTool). */
  approvals: boolean;
  /** Live permission-mode switching (default/acceptEdits/plan/bypassPermissions). */
  permissionModes: boolean;
  /** Per-turn structured cost, so the budget guardrail can enforce a cap. */
  structuredCost: boolean;
  /** A queryable list of models with display names (supportedModels). */
  modelList: boolean;
  /** Subagent lifecycle events feeding the live-agent panel. */
  subagents: boolean;
  /** A persisted transcript store (Claude's .jsonl) enabling detach/reattach. */
  persistedTranscript: boolean;
  /** Branching an existing session into a new one. */
  fork: boolean;
  /** A reasoning-effort knob. */
  effort: boolean;
  /**
   * FEAT-037 P3 — finer-grained honesty flags the picker/bridge gate on.
   * `planMode`: the engine has a real read-only plan mode (Claude); an engine
   * without one (Codex) REFUSES 'plan' rather than silently running a normal
   * turn, and the UI hides the plan toggle for it.
   * `mcpConfig`: the engine accepts a per-session `mcpServers` config at start
   * (Claude's Options.mcpServers). An engine without it (Codex today — its MCP
   * config lives in ~/.codex/config.toml; per-invocation `-c mcp_servers…`
   * overrides are P2c work) gets NO station-attached MCP servers, and the
   * bridge says so instead of silently dropping them.
   */
  planMode: boolean;
  mcpConfig: boolean;
  /**
   * ARCH-002 / BUG-043 — does this engine DECLARE which of its work outlives the
   * turn that started it?
   *
   * `'reported'`: the engine emits a level signal naming every unit of work that
   * is currently running in the BACKGROUND (Claude: `background_tasks_changed`),
   * so "is there work that outlives this turn" has a real answer — including the
   * negative one (an empty level means nothing is in the background).
   * `'absent'`: the engine says nothing about lifetime. The answer is then
   * `unknown` for any session that ever started agent work, and `no` only where
   * no such unit was ever created (nothing exists, so nothing can outlive).
   *
   * This flag exists so `unknown` is never COERCED: a caller that gets it must
   * choose a bias knowingly (see `AgentSession.workLifetime()`), not by silently
   * reading an empty set as "idle" — which is exactly the substitution BUG-043
   * made when it let turn-scoped `busy` answer a work-lifetime question and
   * closed sessions whose background agents were still working.
   */
  backgroundLifetime: 'reported' | 'absent';
}

/**
 * ARCH-002 / BUG-043 — THE ANSWER to "does live work exist here that outlives
 * the turn that started it?". Deliberately three-valued, for the same reason
 * `LivenessState` is: `unknown` is a first-class answer and must never be
 * flattened into `no` (that flattening is what reaped live background agents).
 *
 * This is NOT a liveness verdict and must not be used as one: it says nothing
 * about whether a process is alive — `src/server/liveness.ts` is the single
 * authority for that, and this answers the orthogonal question ARCH-002 named.
 */
export interface WorkLifetime {
  /** `yes` = work is running that the turn does not contain. */
  outlivesTurn: 'yes' | 'no' | 'unknown';
  /** Plain words, quotable in a log line or a refusal. */
  detail: string;
  /** The engine's own ids for that work, when it named them. */
  ids: string[];
}

/* ------------------------------------------------------------------------- *
 * Provider-agnostic error taxonomy (BUG-031). Every runtime maps its engine's
 * NATIVE failure shapes into this one normalized form so the bridge/UI can
 * relay provider errors honestly without knowing any provider's dialect.
 * Claude: 529 overloaded / 429 rate_limit / auth expiry / model_not_found /
 * api_retry system frames. Codex (P2): turn.failed, rolling 5-hour usage
 * windows (→ 'quota-window'), JSON-RPC errors. PURELY ADDITIVE: nothing above
 * consumes it except through the OPTIONAL `classifyProviderError` member below.
 * ------------------------------------------------------------------------- */

export type ProviderErrorKind =
  | 'overloaded'          // provider-side capacity (Claude: 529 / error 'overloaded')
  | 'rate-limited'        // request-rate throttling (Claude: 429 / error 'rate_limit')
  | 'quota-window'        // subscription usage window/credits exhausted (Claude: 5h/7d window rejected, billing_error; Codex: rolling 5h window)
  | 'auth-expired'        // credentials invalid/expired mid-session
  | 'network'             // no HTTP response at all (timeout, connection drop)
  | 'model-unavailable'   // the requested model does not exist / no access
  | 'tooling-unavailable' // BUG-035: an attached MCP tool server did not start — the session runs WITHOUT those tools
  | 'internal';           // provider 5xx / engine-internal failure / unclassifiable

export interface ProviderError {
  kind: ProviderErrorKind;
  /** True when simply retrying the same turn can plausibly succeed. */
  retryable: boolean;
  /** Which provider failed — attribution for the UI (e.g. 'anthropic'). */
  provider: string;
  /** The provider's OWN message text, verbatim — never paraphrased away. */
  detail: string;
  /** The provider's status page, when one exists for this failure class. */
  statusUrl?: string;
  /** HTTP status if one was observed; null = no response (network). */
  statusCode?: number | null;
  /**
   * Present while the ENGINE is retrying this error itself — the turn is
   * still alive; absent = the failure is terminal for the turn.
   */
  retrying?: { attempt: number; maxRetries: number; delayMs: number };
  /** quota-window only: when the window resets (epoch seconds or ms). */
  resetsAt?: number;
  /**
   * BUG-035, 'tooling-unavailable' only: the tool server has not FAILED, it is
   * still starting — so the capability is missing for THIS turn but may arrive
   * for the next one. Rendered as an honest "attaching…" line rather than a
   * failure card (the same in-progress/terminal split `retrying` expresses for
   * API errors).
   */
  pending?: boolean;
}

/** A tool-approval request handed to the session's approval logic. */
export interface RuntimeApprovalMeta {
  signal: AbortSignal;
  requestId: string;
  toolUseID?: string;
  title?: string;
  description?: string;
  agentID?: string;
}

export interface RuntimeApprovalRequest {
  toolName: string;
  input: Record<string, unknown>;
  meta: RuntimeApprovalMeta;
}

/**
 * The verdict the session hands back for an approval request. Structurally the
 * subset of the SDK's `PermissionResult` this app ever constructs — an allow
 * MUST echo the (possibly amended) tool input; a deny MUST carry a message.
 */
export type ApprovalResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/**
 * The isolation seam FEAT-015 (survival) and container isolation both use. The
 * SDK exposes it as `spawnClaudeCodeProcess`; here it is the generic "give me
 * your child process" hook. The session builds the closure (it owns the
 * container/survival orchestration); the runtime only plugs it into the engine.
 * The returned value is the engine's process handle (a ChildProcess-shaped
 * object), left `unknown` so the adapter owns the concrete type.
 */
export interface RuntimeSpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}
export type RuntimeSpawnFn = (req: RuntimeSpawnRequest) => unknown;

/** A model row as normalised by the runtime (mirrors agent-bridge's KnownModel). */
export interface RuntimeModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
}

/**
 * Everything the runtime needs to start a session. Provider-neutral in intent,
 * though today's fields map 1:1 to the Claude SDK's `Options`; a second adapter
 * consumes what it can and ignores the rest (honestly reflected in capabilities).
 */
export interface RuntimeStartConfig {
  cwd: string;
  /** Launch-scoped environment additions inherited by tools and subprocesses. */
  env?: Record<string, string>;
  firstPrompt: string;
  permissionMode: string;
  /** Called for every tool the engine wants to run; resolves to allow/deny. */
  onApproval: (req: RuntimeApprovalRequest) => Promise<ApprovalResult>;
  /** Isolation: path to the in-container engine binary, when spawning elsewhere. */
  pathToExecutable?: string;
  /** Isolation/survival: override how the engine's process is spawned. */
  spawnProcess?: RuntimeSpawnFn;
  model?: string;
  effort?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  resume?: string;
  forkSession?: boolean;
  mcpServers?: Record<string, unknown>;
  strictMcpConfig?: boolean;
  /**
   * The composed system prompt. Either a plain string, or the Claude-preset
   * shape templates.ts produces (`{type:'preset', preset:'claude_code',
   * append}`) which the adapter forwards to the SDK's `Options.systemPrompt`.
   */
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append: string };
}

/**
 * The raw, engine-native message the runtime yields. It is deliberately opaque:
 * `AgentSession.#handle` reads it as `Record<string, any>` and maps it to the
 * `StationEvent` union, exactly as it always has. Only the runtime knows the
 * concrete shape (for ClaudeRuntime, an SDK `SDKMessage`).
 */
export type RuntimeMessage = Record<string, unknown>;

/**
 * The engine seam. `AgentSession` depends only on this; it constructs a
 * `ClaudeRuntime` and drives it. Nothing here references a vendor SDK type.
 */
export interface AgentRuntime {
  /** Honest description of what this engine supports. */
  readonly capabilities: RuntimeCapabilities;
  /** Spawn the engine and enqueue the first turn. Synchronous, like `query()`. */
  start(config: RuntimeStartConfig): void;
  /** Queue a follow-up turn into the same session. */
  send(text: string): void;
  /** Interrupt the in-flight turn. */
  interrupt(): Promise<void>;
  /** Switch the live permission mode; throws with the engine's reason if refused. */
  setPermissionMode(mode: string): Promise<void>;
  /**
   * Switch the live model; throws with the engine's reason if refused. `null`
   * clears back to the engine's default. Only available in streaming mode.
   */
  setModel(model: string | null): Promise<void>;
  /** The engine's known models, normalised. Empty when the engine can't report. */
  supportedModels(): Promise<RuntimeModel[]>;
  /**
   * The driving socket went away mid-turn. For engines that persist their own
   * transcript (Claude → .jsonl) this is a no-op: the work carries on headless
   * and any viewer follows the store. A future engine without a store would use
   * this to start Orchard-owned transcript capture.
   */
  detach(): void;
  /** Tear the engine down (end input, close transport). Idempotent. */
  close(): void;
  /** The engine's inbound message stream, consumed by AgentSession.#handle. */
  messages(): AsyncIterable<RuntimeMessage>;
  /**
   * OPTIONAL (BUG-031, additive): classify one raw engine message as a
   * provider/API failure, mapped into the provider-agnostic `ProviderError`
   * shape above. Returns null for every non-error message. Pure — no side
   * effects; the bridge calls it per message and relays a non-null result as
   * a `provider-error` StationEvent. A runtime that does not implement it
   * simply has its provider errors relayed by the legacy paths only.
   */
  classifyProviderError?(msg: RuntimeMessage): ProviderError | null;
}
