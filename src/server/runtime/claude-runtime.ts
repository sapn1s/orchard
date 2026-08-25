/**
 * ClaudeRuntime — the AgentRuntime backed by `@anthropic-ai/claude-agent-sdk`
 * (FEAT-037 P1). This is the current agent-bridge engine path, verbatim, moved
 * behind the `AgentRuntime` seam: it wraps the SDK's `query()` object, the
 * hand-rolled multi-turn `InputQueue<SDKUserMessage>`, `canUseTool`,
 * `setPermissionMode`, `interrupt`, `supportedModels` and the spawn override.
 * There is intentionally no behaviour change from when this lived inline.
 *
 * Auth: OAuth only. The SDK reads ~/.claude/.credentials.json. There is
 * deliberately no API-key path anywhere in this project.
 *
 * This is the ONLY file above session-mutations.ts that imports the SDK.
 */
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type Options, type SDKMessage, type SDKUserMessage, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentRuntime,
  ProviderError,
  ProviderErrorKind,
  RuntimeCapabilities,
  RuntimeMessage,
  RuntimeModel,
  RuntimeStartConfig,
} from './runtime.ts';

/* ------------------------------------------------------------------------- *
 * BUG-031 — Claude's native failure dialect → the provider-agnostic taxonomy.
 *
 * Ground truth (probed live on claude CLI 2.1.222, invalid-model scratch run,
 * plus sdk.d.ts): a terminal API failure is carried as a SYNTHETIC assistant
 * frame — model:'<synthetic>', `is_api_error_message:true`, `error:` one of
 * SDKAssistantMessageError, content = ONE text block holding the provider's
 * own message ("API Error: 529 …" / "There's an issue with the selected
 * model…") — followed by a `result` whose subtype is LITERALLY 'success' with
 * is_error:true, terminal_reason:'api_error' and api_error_status. While the
 * CLI is still retrying, `system/api_retry` frames carry attempt/max/delay.
 * ------------------------------------------------------------------------- */
const CLAUDE_STATUS_URL = 'https://status.claude.com';

const ASSISTANT_ERROR_MAP: Record<string, { kind: ProviderErrorKind; retryable: boolean; statusUrl?: string }> = {
  overloaded: { kind: 'overloaded', retryable: true, statusUrl: CLAUDE_STATUS_URL },      // 529
  rate_limit: { kind: 'rate-limited', retryable: true },                                   // 429
  server_error: { kind: 'internal', retryable: true, statusUrl: CLAUDE_STATUS_URL },       // 5xx
  authentication_failed: { kind: 'auth-expired', retryable: false },
  oauth_org_not_allowed: { kind: 'auth-expired', retryable: false },
  billing_error: { kind: 'quota-window', retryable: false },
  invalid_request: { kind: 'internal', retryable: false },
  model_not_found: { kind: 'model-unavailable', retryable: false },
  max_output_tokens: { kind: 'internal', retryable: true },
  unknown: { kind: 'internal', retryable: false },
};

/** Minimal pushable async iterable — the SDK's multi-turn input channel. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  #items: SDKUserMessage[] = [];
  #waiters: ((v: IteratorResult<SDKUserMessage>) => void)[] = [];
  #done = false;

  push(msg: SDKUserMessage): void {
    if (this.#done) throw new Error('InputQueue: push after end');
    const w = this.#waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.#items.push(msg);
  }

  end(): void {
    if (this.#done) return;
    this.#done = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const item = this.#items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.#done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  } as SDKUserMessage;
}

/**
 * FEAT-055 — how long the first prompt may be HELD while the session's MCP
 * servers finish starting. Probed ground truth (see the classifier note below
 * and scripts/verify-mcp-ready.mjs): in streaming-input mode the CLI answers
 * the `mcpServerStatus` control request from ~0.6s — BEFORE any turn — and
 * `system:init` is emitted at first-TURN start, not CLI boot. So holding the
 * first prompt until every server has left `pending` gives turn one its tools,
 * and the init frame then honestly reports `connected`. Bounded: on timeout
 * the prompt is released anyway and the init frame's `pending` entry triggers
 * the existing BUG-035 honest notice (augmented with how long we waited).
 *
 * 0 disables the gate (pre-FEAT-055 behaviour). Clamped to 60s — never an
 * unbounded wait. Sessions with NO MCP servers configured never enter the
 * gate at all (zero added latency).
 */
export function mcpReadyBudgetMs(): number {
  const raw = Number(process.env.CLAUDE_STATION_MCP_READY_TIMEOUT_MS ?? 20_000);
  if (!Number.isFinite(raw) || raw < 0) return 20_000;
  return Math.min(raw, 60_000);
}

const GATE_POLL_MS = 300;

/* ------------------------------------------------------------------------- *
 * BUG-118 — LAUNCH PROVENANCE (round 2: an identity, not a flag).
 *
 * The response-format Stop hook is installed into every ONBOARDED project's own
 * `.claude/settings.json`, so Claude Code runs it for any session whose cwd is
 * that project — including a bare `claude` the user starts by hand. Nothing in
 * the Stop payload says who launched the session, so the hook has to be TOLD,
 * over the one channel that reaches it: the environment its CLI was spawned
 * with (hook commands are children of the CLI).
 *
 * Round 1 stamped `ORCHARD_SESSION=1` — a PRESENCE flag, which every descendant
 * process inherits. A `claude` typed into a terminal opened inside an Orchard
 * session therefore satisfied it and got advised: the user's original complaint,
 * intact. So the marker now carries the SESSION ID this launch is for, and the
 * hook only speaks when that id equals the one in its own Stop payload.
 * Inheritance copies the value but not the identity — the nested session has its
 * own new id and can never match (observed live against claude 2.1.235).
 *
 * We can state the id because we can CHOOSE it: `Options.sessionId` becomes the
 * CLI's `--session-id <uuid>` for a fresh launch (and for a fork), and a resume
 * keeps the id it resumed — both confirmed against a real CLI, where the Stop
 * payload's `session_id` came back exactly as declared.
 * ------------------------------------------------------------------------- */
export const ORCHARD_SESSION_ENV = 'ORCHARD_SESSION';

/**
 * ROUND 3 — WHY THERE IS NO REPAIR HERE, ONLY A WARNING.
 *
 * If the CLI ever reported a session id different from the one we declared, the
 * hook's equality test would stop firing for a genuine Orchard session. Round 2
 * tried to repair that automatically: the launcher wrote the rename into
 * `dataDir()/launch-claims.json` and the hook honoured the pair. But that file
 * is an ordinary file in the user's data dir — every process running as this
 * user can write it, including the hand-started `claude` sessions this gate
 * exists to exclude. It was therefore an unauthenticated request for "grade
 * session X", and an independent pass used it exactly that way (a claim dated a
 * year ahead, aimed at a foreign session id, and the hook advised a stranger).
 *
 * Bounding the timestamp would have closed that one instance; the class needs
 * the channel gone. It was covering a drift that has never been observed in any
 * live run, and its absence costs SILENCE for that unobserved case — the
 * direction this design already calls the safer one. So the drift is now
 * WATCHED and reported (below), not repaired.
 */


/* ------------------------------------------------------------------------- *
 * BUG-118 ROUND 4 — DELIVERY. A copy of the hook cannot fix, or even notice,
 * itself.
 *
 * The Stop hook is COPIED into every onboarded project. When we change the hook,
 * those copies do not change — and round 3 changed the marker from a presence
 * flag to a session id, which the round-1 copies reject. The result was the
 * worst possible shape: every genuine launched session in an already-onboarded
 * project was silently ungraded, and nothing anywhere said so, because a stale
 * hook's way of failing is to go quiet and quiet is what a compliant turn looks
 * like. Ordinary onboarding left it that way ("exists (diverged — left
 * untouched)"), and the repair was a flag nobody knew to run.
 *
 * The fix has to live on the side that is always current — here — because the
 * stale copy is, by definition, old code that knows nothing about the new
 * contract. So every launch checks the installed hook against this repo's
 * source, and:
 *   - identical            → nothing at all (the common case, one file compare).
 *   - diverged             → REWRITE it with ours, and SAY SO.
 *   - diverged, unwritable → SAY SO, loudly, naming the file. Never silent.
 *   - file absent          → nothing. The project was never onboarded, and a
 *                            launcher must not scaffold a repo behind the
 *                            user's back. Absence is not the silent-failure
 *                            class: the hook was never running there.
 *   - present but not wired into the target's .claude/settings.json → SAY SO.
 *     Claude Code never runs it, so it is disabled just as thoroughly as a
 *     stale one, and just as quietly. Reported only; settings.json is the
 *     user's file and onboard merges it, we do not rewrite it at launch.
 *
 * Why overwriting is safe here and nowhere else in the method closure: nothing
 * but this project ships `scripts/hooks/response-format-gate.mjs`, so the only
 * thing an overwrite can destroy is our OWN earlier copy. The target is a git
 * repo, so the replacement shows up in its diff and is recoverable — and we
 * announce it. Turning the gate off has three supported ways that this does not
 * touch (ORCHARD_STOP_HOOK_DISABLED, the per-project registry opt-out, and
 * removing the Stop entry from settings.json).
 *
 * Rejected alternative: make the marker satisfy the round-1 predicate too (send
 * something both `1|true|yes` AND a session id). It cannot be done in one value,
 * and a second presence-flag env var would re-arm round 1's defect — every
 * stale copy would resume advising hand-started nested sessions. That trades the
 * quiet failure back for the loud one the ticket exists to kill.
 * ------------------------------------------------------------------------- */
const STOP_HOOK_REL = 'scripts/hooks/response-format-gate.mjs';
const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));
/** This repo's root: src/server/runtime → src/server → src → repo. */
const REPO_ROOT = path.resolve(RUNTIME_DIR, '..', '..', '..');

export type StopHookDelivery = {
  /** What we found (and did) for the copied hook file. */
  hook: 'not-onboarded' | 'current' | 're-synced' | 'stale-unwritable' | 'source-missing';
  /** Whether the target's own .claude/settings.json actually runs it. */
  wiring: 'wired' | 'unwired' | 'unknown';
  detail: string;
};

/** One announcement per (cwd, state) per server process — a repeat launch of an
 *  unrepairable project must not turn the log into a scroll. */
const hookDeliveryAnnounced = new Set<string>();

function shortHash(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

/**
 * Keep the project's copy of the Stop hook current, and never fail silently.
 * Pure of exceptions: any surprise degrades to a report, never to a failed
 * launch. Exported for the BUG-118 suite, which drives every branch.
 */
export function ensureCurrentStopHook(
  cwd: string | undefined | null,
  { warn = (m: string) => console.warn(m) }: { warn?: (m: string) => void } = {},
): StopHookDelivery {
  const announce = (key: string, message: string) => {
    if (hookDeliveryAnnounced.has(key)) return;
    hookDeliveryAnnounced.add(key);
    warn(message);
  };
  try {
    if (!cwd) return { hook: 'not-onboarded', wiring: 'unknown', detail: 'no cwd' };
    const dest = path.join(cwd, STOP_HOOK_REL);
    if (!fs.existsSync(dest)) {
      return { hook: 'not-onboarded', wiring: 'unknown', detail: `${STOP_HOOK_REL} absent — project not onboarded` };
    }

    // Wiring: present-but-unwired is disabled just as silently as stale.
    let wiring: StopHookDelivery['wiring'] = 'unknown';
    try {
      const settings = fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8');
      wiring = settings.includes('response-format-gate.mjs') ? 'wired' : 'unwired';
    } catch {
      wiring = 'unwired'; // no settings file at all → Claude Code runs nothing
    }
    if (wiring === 'unwired') {
      announce(
        `${cwd}::unwired`,
        `[orchard] response-format hook is installed at ${dest} but NOT wired into ${path.join(cwd, '.claude/settings.json')} — ` +
          'Claude Code will never run it, so this project produces no format grading. Re-run onboard on it to restore the Stop entry (BUG-118).',
      );
    }

    let srcBytes: Buffer;
    try {
      srcBytes = fs.readFileSync(path.join(REPO_ROOT, STOP_HOOK_REL));
    } catch {
      announce(
        '::source-missing',
        `[orchard] cannot read this repo's ${STOP_HOOK_REL} (${path.join(REPO_ROOT, STOP_HOOK_REL)}) — ` +
          'installed copies cannot be checked for staleness, so format grading may be running old code (BUG-118).',
      );
      return { hook: 'source-missing', wiring, detail: 'source hook unreadable' };
    }

    let destBytes: Buffer | null = null;
    try { destBytes = fs.readFileSync(dest); } catch { destBytes = null; }
    if (destBytes && destBytes.equals(srcBytes)) {
      return { hook: 'current', wiring, detail: `identical (${shortHash(srcBytes)})` };
    }

    const was = destBytes ? shortHash(destBytes) : 'unreadable';
    try {
      fs.writeFileSync(dest, srcBytes);
      announce(
        `${cwd}::resynced`,
        `[orchard] replaced a STALE response-format Stop hook in ${cwd} (${was} → ${shortHash(srcBytes)}). ` +
          'A hook copy older than the launcher stops grading silently, so it is re-synced on launch (BUG-118).',
      );
      return { hook: 're-synced', wiring, detail: `${was} → ${shortHash(srcBytes)}` };
    } catch (err) {
      announce(
        `${cwd}::unwritable`,
        `[orchard] the response-format Stop hook in ${cwd} is STALE (${was}, expected ${shortHash(srcBytes)}) and could not be ` +
          `replaced: ${(err as Error).message}. Sessions here are probably NOT being graded. ` +
          `Fix with: node scripts/onboard.mjs ${cwd}  (BUG-118).`,
      );
      return { hook: 'stale-unwritable', wiring, detail: `${was} != ${shortHash(srcBytes)}: ${(err as Error).message}` };
    }
  } catch (err) {
    // Delivery must never break a launch. But it must not be silent either.
    announce('::error', `[orchard] response-format hook delivery check failed: ${(err as Error).message} (BUG-118)`);
    return { hook: 'source-missing', wiring: 'unknown', detail: String((err as Error).message) };
  }
}

export class ClaudeRuntime implements AgentRuntime {
  /**
   * The reference engine: full parity, so every capability is `true`. A second
   * adapter would flip to `false` whatever it cannot honour (see runtime.ts).
   */
  readonly capabilities: RuntimeCapabilities = {
    approvals: true,
    permissionModes: true,
    structuredCost: true,
    modelList: true,
    subagents: true,
    persistedTranscript: true,
    fork: true,
    effort: true,
    planMode: true,
    mcpConfig: true,
    // BUG-043: the CLI emits `background_tasks_changed` — a LEVEL signal listing
    // every background task alive right now (proven live in BUG-037's capture),
    // so this engine can answer "does work outlive this turn" both ways.
    backgroundLifetime: 'reported',
  };

  #query: ReturnType<typeof query> | null = null;
  #input = new InputQueue();
  /**
   * BUG-035: the MCP map this session was actually started with. Kept so the
   * `system:init` classifier can name the exact COMMAND behind a server the CLI
   * reports as failed — "serena (uvx …) did not start" is actionable; "serena
   * failed" is not.
   */
  #mcpServers: Record<string, unknown> = {};
  /**
   * FEAT-055 — first-prompt gate state. While `#holding` the first prompt has
   * not been pushed yet (the gate is polling `mcpServerStatus()`); `send()`s
   * arriving in that window are buffered in `#heldSends` so they can never
   * jump the queue ahead of the first prompt. `#mcpGate` records the outcome
   * so the BUG-035 pending classifier can say honestly how long we waited.
   */
  #holding = false;
  #heldSends: string[] = [];
  #closed = false;
  #mcpGate: { outcome: 'ready' | 'timeout' | 'settled'; waitedMs: number } | null = null;
  /**
   * BUG-118 — the session id this launch DECLARED (also the value of the
   * `ORCHARD_SESSION` marker on the CLI's env). `#sessionIdSeen` keeps the drift
   * check to one claim per distinct id seen, so the stream stays hot.
   */
  #declaredSessionId: string | null = null;
  #sessionIdSeen = new Set<string>();

  start(config: RuntimeStartConfig): void {
    /*
     * BUG-118 — the session identity this launch declares (see the note above
     * claimLaunchedSession). A plain resume keeps the id it resumes; every other
     * start — fresh launch, and a fork, which the SDK gives a NEW id — gets a
     * uuid we choose and hand to the CLI as `--session-id`.
     */
    const declaredSessionId = config.resume && !config.forkSession ? config.resume : randomUUID();
    this.#declaredSessionId = declaredSessionId;
    /*
     * BUG-118 round 4 — DELIVERY, at the one moment it matters. The marker below
     * is only worth stamping if the hook that reads it is the hook that
     * understands it; a copy left behind by an earlier onboarding just goes
     * quiet. See ensureCurrentStopHook: it repairs a stale copy or says, out
     * loud, that it could not.
     */
    ensureCurrentStopHook(config.cwd);
    const options: Options = {
      cwd: config.cwd,
      includePartialMessages: true,
      permissionMode: config.permissionMode as never,
      canUseTool: (toolName, input, o) =>
        config.onApproval({ toolName, input, meta: o as never }) as Promise<PermissionResult>,
      /*
       * ARMED, NOT ENGAGED.
       *
       * `allowDangerouslySkipPermissions` is a STARTUP option, and the CLI
       * enforces it as a precondition for ever entering bypassPermissions:
       * without it, a mid-session `setPermissionMode('bypassPermissions')` is
       * refused with
       *   "Cannot set permission mode to bypassPermissions because the session
       *    was not launched with --dangerously-skip-permissions"
       * (observed live). That is exactly why the composer's skip toggle did
       * nothing to a running session.
       *
       * Arming it does NOT skip anything by itself — `permissionMode` above is
       * still whatever was resolved (usually 'default'), and that is what
       * governs. So this grants no privilege the user did not already have —
       * bypass was always reachable by starting a session with the override; it
       * only means they no longer have to throw the session away to reach it.
       */
      allowDangerouslySkipPermissions: true,
      /*
       * BUG-118 — LAUNCH PROVENANCE, carried on the environment. The value is
       * the session id this launch declares, NOT a flag: a flag is inherited by
       * every descendant, so a hand-started `claude` in a terminal opened from
       * an Orchard session satisfied it (round-1 defect). See the note above
       * claimLaunchedSession for the full argument.
       *
       * `env` REPLACES the subprocess environment rather than merging with it,
       * so `...process.env` is load-bearing — dropping it would strip the
       * boot-augmented PATH that BUG-091 exists to deliver (that suite asserts
       * the fake-CLI child still carries it).
       */
      env: { ...process.env, ...(config.env ?? {}), [ORCHARD_SESSION_ENV]: declaredSessionId },
    };
    // Isolation seams — set only when the session hands them over, exactly as the
    // container / survival (FEAT-015) branches did inline. `pathToExecutable` is
    // the container's binary path; `spawnProcess` is the `spawnClaudeCodeProcess`
    // override (docker exec, or the survival broker's scope).
    if (config.pathToExecutable) options.pathToClaudeCodeExecutable = config.pathToExecutable;
    // Verification seam (mirrors CLAUDE_STATION_CODEX_BIN): point a direct
    // session's SDK at a scripted fake `claude` so a test can drive the real
    // bridge with an exact frame ordering. Prod-inert — unset in normal runs,
    // and the container's own pathToExecutable above always wins.
    else if (process.env.CLAUDE_STATION_CLAUDE_BIN) options.pathToClaudeCodeExecutable = process.env.CLAUDE_STATION_CLAUDE_BIN;
    if (config.spawnProcess) options.spawnClaudeCodeProcess = config.spawnProcess as never;
    if (config.model) options.model = config.model;
    if (config.effort) options.effort = config.effort as never;
    if (config.allowedTools?.length) options.allowedTools = config.allowedTools;
    if (config.disallowedTools?.length) options.disallowedTools = config.disallowedTools;
    if (config.resume) {
      options.resume = config.resume;
      /*
       * BUG-118: a fork does NOT keep the resumed id — the SDK mints a new one
       * unless we name it, and an unnamed id is one the hook cannot be told
       * about. `sessionId` is legal alongside `resume` only when forking.
       */
      if (config.forkSession) { options.forkSession = true; options.sessionId = declaredSessionId; }
    } else {
      // Fresh launch: we choose the id (the CLI's `--session-id`) so the marker
      // above can name it.
      options.sessionId = declaredSessionId;
    }
    if (config.mcpServers) {
      options.mcpServers = config.mcpServers as never;
      if (config.strictMcpConfig) options.strictMcpConfig = true;
      this.#mcpServers = config.mcpServers;
    }
    if (config.systemPrompt) options.systemPrompt = config.systemPrompt;

    this.#query = query({ prompt: this.#input, options });
    /*
     * FEAT-055 — a session's first turn must HAVE its configured MCP tools (or
     * honestly wait, bounded). Without this gate the CLI starts the turn at
     * ~0.6s with every MCP server still `pending`, so turn one silently runs
     * tool-less (and a one-shot never gets them). Only sessions that actually
     * configure MCP servers pay anything; everyone else pushes synchronously,
     * exactly as before.
     */
    const budget = mcpReadyBudgetMs();
    if (config.mcpServers && Object.keys(config.mcpServers).length && budget > 0) {
      this.#holding = true;
      void this.#releaseWhenMcpReady(config.firstPrompt, budget);
    } else {
      this.#input.push(userMessage(config.firstPrompt));
    }
  }

  /**
   * Poll `mcpServerStatus()` until no server is `pending` (connected / failed /
   * needs-auth / disabled are all TERMINAL — a failed server releases the gate
   * immediately and keeps its existing BUG-035 failure report), or until the
   * bounded budget runs out. Then release the held first prompt plus any
   * `send()`s buffered behind it, in order. A CLI too old for the control
   * request settles the gate on first error rather than burning the budget.
   */
  async #releaseWhenMcpReady(firstPrompt: string, budgetMs: number): Promise<void> {
    const t0 = Date.now();
    let outcome: 'ready' | 'timeout' | 'settled' = 'timeout';
    while (Date.now() - t0 < budgetMs) {
      if (this.#closed) return; // the session is gone; never push into an ended queue
      try {
        const statuses = await this.#query!.mcpServerStatus();
        if (statuses.every((s) => s.status !== 'pending')) { outcome = 'ready'; break; }
      } catch {
        // Control request unavailable (old CLI) or transport hiccup — waiting
        // longer cannot make the answer arrive; release rather than stall.
        outcome = 'settled';
        break;
      }
      await new Promise((r) => setTimeout(r, GATE_POLL_MS));
    }
    this.#mcpGate = { outcome, waitedMs: Date.now() - t0 };
    this.#holding = false;
    if (this.#closed) return;
    this.#input.push(userMessage(firstPrompt));
    for (const text of this.#heldSends.splice(0)) this.#input.push(userMessage(text));
  }

  send(text: string): void {
    // FEAT-055: never let a follow-up overtake the held first prompt.
    if (this.#holding) { this.#heldSends.push(text); return; }
    this.#input.push(userMessage(text));
  }

  async interrupt(): Promise<void> {
    if (!this.#query) return;
    await this.#query.interrupt();
  }

  async setPermissionMode(mode: string): Promise<void> {
    if (!this.#query) throw new Error('runtime not started');
    await this.#query.setPermissionMode(mode as never);
  }

  async setModel(model: string | null): Promise<void> {
    if (!this.#query) throw new Error('runtime not started');
    // An older CLI without the control request cannot switch mid-session; say
    // so honestly rather than silently no-op (the caller surfaces this reason).
    if (typeof (this.#query as { setModel?: unknown }).setModel !== 'function') {
      throw new Error('this engine cannot switch models mid-session');
    }
    await this.#query.setModel(model ?? undefined);
  }

  async supportedModels(): Promise<RuntimeModel[]> {
    // Fire-and-forget from the caller's side; an old CLI without the control
    // request simply yields none and the last-known list is kept upstream.
    const ms = await this.#query?.supportedModels?.();
    return (ms ?? []).map((m: Record<string, any>) => ({
      value: String(m.value),
      resolvedModel: m.resolvedModel != null ? String(m.resolvedModel) : undefined,
      displayName: String(m.displayName ?? m.value),
      description: String(m.description ?? ''),
      supportsEffort: m.supportsEffort === true,
    }));
  }

  detach(): void {
    /*
     * No-op: the `claude` CLI writes the transcript to its own .jsonl store
     * regardless of whether a socket is listening, so a detached session's work
     * carries on and any viewer follows the file. There is nothing to signal to
     * the engine. (A future engine without a persisted store would start
     * Orchard-owned transcript capture here — capabilities.persistedTranscript.)
     */
  }

  close(): void {
    this.#closed = true; // FEAT-055: stops a pending gate from pushing into an ended queue
    this.#input.end();
    try {
      this.#query?.close();
    } catch {
      /* already gone */
    }
  }

  messages(): AsyncIterable<RuntimeMessage> {
    // The SDK Query is itself the async-iterable of SDKMessage; the session reads
    // each as an opaque RuntimeMessage. Passed through unchanged — the only
    // addition is the BUG-118 drift watch below, which never alters a message.
    const inner = this.#query as unknown as AsyncIterable<RuntimeMessage>;
    const note = (m: RuntimeMessage) => this.#noteSessionId(m);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const msg of inner) { note(msg); yield msg; }
      },
    };
  }

  /**
   * BUG-118 TOO-QUIET WATCH. Every SDK message carries the CLI's own
   * `session_id`. If it ever differs from what we declared (a CLI that ignores
   * `--session-id`, or a mid-session rename), the Stop hook's identity test
   * goes quiet for a genuine Orchard session — so say so, loudly, with both
   * ids. This is a REPORT, not a repair: see the round-3 note above for why the
   * automatic repair was removed rather than bounded. Once per distinct id, so
   * a drifted stream cannot flood the log.
   */
  #noteSessionId(msg: RuntimeMessage): void {
    const declared = this.#declaredSessionId;
    if (!declared) return;
    const sid = (msg as { session_id?: unknown }).session_id;
    if (typeof sid !== 'string' || !sid || sid === declared) return;
    if (this.#sessionIdSeen.has(sid)) return;
    this.#sessionIdSeen.add(sid);
    console.warn(`[orchard] session id drifted: declared ${declared}, engine reports ${sid} — the response-format hook will stop grading this session (BUG-118; not repaired on purpose)`);
  }

  /**
   * BUG-031 — map Claude's native failure shapes into the provider-agnostic
   * `ProviderError`. Pure classifier; null for every non-error message. See
   * the dialect note above ASSISTANT_ERROR_MAP for the probed ground truth.
   */
  classifyProviderError(msg: RuntimeMessage): ProviderError | null {
    const m = msg as Record<string, any>;

    // 1) TERMINAL API failure — the synthetic assistant carrier frame.
    if (m.type === 'assistant' && (m.is_api_error_message === true || typeof m.error === 'string')) {
      const map = ASSISTANT_ERROR_MAP[String(m.error ?? 'unknown')] ?? ASSISTANT_ERROR_MAP.unknown;
      const text = ((m.message?.content ?? []) as Record<string, any>[])
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => String(b.text))
        .join('\n')
        .trim();
      return {
        kind: map.kind,
        retryable: map.retryable,
        provider: 'anthropic',
        detail: text || `API error (${String(m.error ?? 'unknown')})`,
        ...(map.statusUrl ? { statusUrl: map.statusUrl } : {}),
      };
    }

    // 2) RETRY IN PROGRESS — the CLI is retrying by itself; the turn is alive.
    //    error_status null = connection error with no HTTP response (network).
    if (m.type === 'system' && m.subtype === 'api_retry') {
      const noResponse = m.error_status == null;
      const map = noResponse
        ? { kind: 'network' as const, retryable: true, statusUrl: undefined }
        : (ASSISTANT_ERROR_MAP[String(m.error ?? 'unknown')] ?? ASSISTANT_ERROR_MAP.unknown);
      return {
        kind: map.kind,
        retryable: true,
        provider: 'anthropic',
        detail: noResponse
          ? 'API request got no response (connection error) — the engine is retrying'
          : `API request failed (HTTP ${m.error_status}, ${String(m.error ?? 'unknown')}) — the engine is retrying`,
        statusCode: m.error_status ?? null,
        ...(map.statusUrl ? { statusUrl: map.statusUrl } : {}),
        retrying: {
          attempt: Number(m.attempt ?? 0),
          maxRetries: Number(m.max_retries ?? 0),
          delayMs: Number(m.retry_delay_ms ?? 0),
        },
      };
    }

    /*
     * 2b) BUG-035 — AN ATTACHED MCP TOOL SERVER DID NOT START.
     *
     * Probed ground truth (claude CLI 2.1.226, real runs, two shapes):
     *
     *  - A server whose command does not exist: the CLI does NOT fail, does NOT
     *    print to stderr and does NOT emit an error frame — it runs the turn
     *    perfectly normally with the server's tools simply ABSENT. The only
     *    trace anywhere is one entry in `system:init`:
     *    `mcp_servers:[{name:'serena', status:'failed'}]`.
     *
     *  - In the STREAMING-input mode the station uses (not `-p`), the CLI does
     *    not wait for its MCP servers before the first turn: init arrives at
     *    ~0.6s with `status:'pending'` and ZERO mcp tools, the first turn runs
     *    without them, and a SECOND `system:init` follows once they are up
     *    (`status:'connected'`, tools present) — so a healthy Serena is simply
     *    missing for turn one. 'pending' is therefore NOT a failure; conflating
     *    the two would cry wolf on every healthy session.
     *
     * The station read `tools`/`slash_commands` out of that frame and dropped
     * `mcp_servers` entirely, so both cases were invisible: a session silently
     * ran without the tools the user had switched ON — the same class of
     * silent-state lie as BUG-024/027/030/033.
     *
     * Classified here (rather than in the bridge) so the existing BUG-031 relay
     * carries it to the UI with no new plumbing.
     */
    if (m.type === 'system' && m.subtype === 'init' && Array.isArray(m.mcp_servers)) {
      const off = (m.mcp_servers as Record<string, any>[])
        .filter((s) => s && typeof s.name === 'string' && String(s.status ?? '') !== 'connected');
      if (off.length) {
        const describe = (s: Record<string, any>) => {
          const spec = this.#mcpServers[String(s.name)] as { command?: unknown; args?: unknown } | undefined;
          const cmd = spec && typeof spec.command === 'string'
            ? [spec.command, ...(Array.isArray(spec.args) ? spec.args.map(String) : [])].join(' ')
            : null;
          return `${s.name} (status: ${String(s.status ?? 'unknown')}${cmd ? `; command: ${cmd}` : ''})`;
        };
        const lost = (list: Record<string, any>[]) =>
          list.map((s) => `mcp__${String(s.name)}__*`).join(', ');
        // A server the CLI reports as still starting is not broken — but its
        // tools genuinely are missing for the turn now beginning, and that must
        // be said rather than left as a mysteriously toolless agent.
        const failed = off.filter((s) => String(s.status ?? '') !== 'pending');
        if (!failed.length) {
          // FEAT-055: post-gate, a pending server in the init frame means the
          // bounded readiness wait ran out — say how long we held the turn, so
          // the notice is a report of a real wait, not a mystery.
          const waited = this.#mcpGate?.outcome === 'timeout'
            ? ` The turn was held ${Math.round(this.#mcpGate.waitedMs / 1000)}s for MCP readiness before starting anyway (budget CLAUDE_STATION_MCP_READY_TIMEOUT_MS).`
            : '';
          return {
            kind: 'tooling-unavailable',
            retryable: false,
            pending: true,
            provider: 'anthropic',
            detail:
              `MCP tool server${off.length > 1 ? 's' : ''} still starting: ${off.map((s) => String(s.name)).join(', ')} — ` +
              `${lost(off)} ${off.length > 1 ? 'are' : 'is'} NOT available for this turn (they attach for the next one).${waited}`,
          };
        }
        return {
          kind: 'tooling-unavailable',
          retryable: false,
          provider: 'anthropic',
          detail:
            `MCP tool server${failed.length > 1 ? 's' : ''} did not start: ${failed.map(describe).join(' | ')}. ` +
            `This session is running WITHOUT ${lost(failed)} — ` +
            `the command must be runnable where the engine runs (INSIDE the container for ` +
            `isolation "container", on the host for "direct").`,
        };
      }
    }

    // 3) AUTH failure surfaced on the dedicated auth-status channel.
    if (m.type === 'auth_status' && typeof m.error === 'string' && m.error) {
      return { kind: 'auth-expired', retryable: false, provider: 'anthropic', detail: String(m.error) };
    }

    // 4) SUBSCRIPTION USAGE WINDOW exhausted (5-hour / 7-day buckets) — the
    //    Claude shape of the class Codex expresses as its rolling 5h window.
    if (m.type === 'rate_limit_event' && m.rate_limit_info?.status === 'rejected') {
      const info = m.rate_limit_info as Record<string, any>;
      return {
        kind: 'quota-window',
        retryable: false,
        provider: 'anthropic',
        detail: `subscription usage limit reached (${String(info.rateLimitType ?? 'usage window')})`,
        ...(typeof info.resetsAt === 'number' ? { resetsAt: info.resetsAt } : {}),
      };
    }

    // 5) LOOP-INTERNAL terminal errors that carry real detail (errors[]).
    //    terminal_reason:'api_error' results are deliberately NOT classified —
    //    their synthetic assistant frame (1) already was, and an interrupt's
    //    error_during_execution carries no errors[] so it stays silent here.
    if (m.type === 'result' && String(m.subtype ?? '').startsWith('error')
        && Array.isArray(m.errors) && m.errors.length) {
      return {
        kind: 'internal',
        retryable: false,
        provider: 'anthropic',
        detail: m.errors.map(String).join('; '),
      };
    }

    return null;
  }
}

// Re-exported so tooling/tests can reference the SDK message type through the
// adapter without importing the SDK directly.
export type { SDKMessage };
