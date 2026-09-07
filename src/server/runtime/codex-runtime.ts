/**
 * CodexRuntime — the AgentRuntime backed by OpenAI's Codex CLI (`codex
 * app-server`), FEAT-037 P2a. A peer adapter to ClaudeRuntime, not a degraded
 * pipe: app-server is bidirectional JSON-RPC 2.0 over stdio (newline-delimited
 * JSON) with threads, streaming item events, interrupts, resume/fork, model
 * listing and server→client approval requests — structurally the same contract
 * the Claude SDK gives us.
 *
 * PROTOCOL PROVENANCE: SCHEMA-VALIDATED (FEAT-037 P2c, 2026-08-05). Every wire
 * shape here was corrected against the REAL pinned binary's generated schema —
 * `codex app-server generate-json-schema`, codex-cli 0.146.0 — replacing the
 * P2a documentation-derived guesses. The drift that was fixed: thread/start
 * takes `sandbox` (SandboxMode string) and turn/start takes `sandboxPolicy`
 * (object with camelCase `type`), never `sandboxMode`; reasoning effort is
 * `effort` on turn/start; model/list returns `{data, nextCursor}`; there is NO
 * `turn/failed` — failure is turn/completed with turn.status:'failed' +
 * turn.error{message, codexErrorInfo}; the Turn object carries NO usage —
 * tokens arrive via thread/tokenUsage/updated; approval replies are
 * ReviewDecision ('approved' | {denied:{rejection}} | 'abort' | …), not
 * {decision:'allow'|'deny'}; approvalPolicy values are
 * 'untrusted'|'on-request'|'never' (the docs' 'unlessTrusted' does not exist).
 *
 * Auth: subscription OAuth only ("Sign in with ChatGPT" via `codex login`),
 * credentials in ~/.codex/auth.json — mirroring ClaudeRuntime's OAuth-only
 * stance. There is deliberately no API-key path (that would switch billing to
 * pay-per-token). See docs/PROVIDERS.md.
 *
 * EVENT MAPPING: `AgentSession.#handle` consumes RuntimeMessages in the Claude
 * SDK's message shapes (that is the de-facto RuntimeMessage dialect P1 kept).
 * This adapter therefore translates app-server notifications INTO those shapes:
 *   thread started            → {type:'system', subtype:'init', session_id, …}
 *   item/agentMessage/delta   → {type:'stream_event', event:{content_block_delta/text_delta}}
 *   item/completed agentMessage → {type:'assistant', content:[{type:'text'}]}
 *   item/completed reasoning  → {type:'assistant', content:[{type:'thinking'}]} (text empty by design)
 *   item/started tool-ish     → {type:'assistant', content:[{type:'tool_use'}]}
 *   item/completed tool-ish   → {type:'user', content:[{type:'tool_result'}]}
 *   turn/completed            → {type:'result', …} (usage tokens from
 *                               thread/tokenUsage/updated, NO total_cost_usd;
 *                               turn.status 'failed' → error_during_execution)
 *   collabAgentToolCall / subAgentActivity / sub-thread thread/started
 *                             → the TASK-FRAME dialect the bridge already
 *                               speaks (system/task_started → agent-started,
 *                               task_progress → agent-progress, terminal
 *                               task_updated{patch.status} → agent-completed)
 *                               — see the "subagents" section below.
 *   execCommandApproval / applyPatchApproval / item/*\/requestApproval
 *                             → config.onApproval → respond with the wire's own
 *                               decision dialect (ReviewDecision for the legacy
 *                               methods, accept/decline for the item/* family)
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gitWriteBlockEnabled } from '../../../scripts/lib/git-write-policy.mjs';
import { installGitShim } from '../../../scripts/lib/git-shim.mjs';
import type {
  AgentRuntime,
  ApprovalResult,
  ProviderError,
  RuntimeCapabilities,
  RuntimeMessage,
  RuntimeModel,
  RuntimeStartConfig,
} from './runtime.ts';

/* ------------------------------------------------------------------ queue */

/** Pushable async iterable — the outbound RuntimeMessage stream. */
class MessageQueue implements AsyncIterable<RuntimeMessage> {
  #items: RuntimeMessage[] = [];
  #waiters: { resolve: (v: IteratorResult<RuntimeMessage>) => void; reject: (e: Error) => void }[] = [];
  #done = false;
  #error: Error | null = null;

  push(msg: RuntimeMessage): void {
    if (this.#done) return; // late frames after close are dropped, not a crash
    const w = this.#waiters.shift();
    if (w) w.resolve({ value: msg, done: false });
    else this.#items.push(msg);
  }

  end(): void {
    if (this.#done) return;
    this.#done = true;
    for (const w of this.#waiters.splice(0)) w.resolve({ value: undefined as never, done: true });
  }

  /** Transport failure — surfaces as a throw from the async iterator, exactly
   *  how the SDK's Query fails, so AgentSession's existing catch handles it. */
  fail(err: Error): void {
    if (this.#done) return;
    this.#done = true;
    this.#error = err;
    for (const w of this.#waiters.splice(0)) w.reject(err);
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeMessage> {
    return {
      next: (): Promise<IteratorResult<RuntimeMessage>> => {
        const item = this.#items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.#error) return Promise.reject(this.#error);
        if (this.#done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}

/* -------------------------------------------------------------- detection */

export type CodexDetectionStatus = 'connected' | 'installed-not-signed-in' | 'not-installed';

/** Shaped for the future (P3) runtime picker: status drives enable/gray-out,
 *  label is the row text, hint is the "what do I do about it" line. */
export interface CodexDetection {
  status: CodexDetectionStatus;
  label: string;
  binaryPath: string | null;
  /** The auth file we looked for (present only when it decided the verdict). */
  authPath: string | null;
  hint?: string;
}

/**
 * Is Codex usable on this machine? Binary on PATH + ~/.codex/auth.json ⇒
 * connected; binary without auth ⇒ installed, not signed in; neither ⇒ not
 * installed. `env` is injectable for tests (PATH/HOME/CODEX_HOME).
 *
 * Caveat (P2c): credentials may live in the OS keyring instead of auth.json
 * (`cli_auth_credentials_store = "keyring"`), which this file-only check would
 * misreport as not-signed-in; the honest fix once the binary is present is
 * `codex login status`. Good enough for the picker's first cut.
 */
export function detectCodex(env: Record<string, string | undefined> = process.env): CodexDetection {
  /*
   * PATH alone is NOT enough: a systemd-launched service inherits a minimal
   * PATH, while the user's codex typically lives in ~/.local/bin or an npm
   * global bin (observed live on this machine: ~/.local/bin/codex works in
   * the terminal, invisible to the service PATH). So the scan is PATH plus
   * the well-known install dirs — otherwise the picker says "not installed"
   * while the user's shell disagrees, the exact lie this feature bans.
   */
  const home = env.HOME ?? os.homedir();
  const dirs = [
    ...(env.PATH ?? '').split(path.delimiter),
    path.join(home, '.local', 'bin'),      // pipx/user installs (observed live)
    path.join(home, '.npm-global', 'bin'), // npm prefix convention
    path.join(home, 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  let binaryPath: string | null = null;
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, 'codex');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) { binaryPath = candidate; break; }
    } catch { /* keep looking */ }
  }
  if (!binaryPath) {
    return {
      status: 'not-installed',
      label: 'OpenAI Codex — not installed',
      binaryPath: null,
      authPath: null,
      hint: 'Install the Codex CLI (npm i -g @openai/codex) — see docs/PROVIDERS.md',
    };
  }
  const codexHome = env.CODEX_HOME ?? path.join(home, '.codex');
  const authPath = path.join(codexHome, 'auth.json');
  if (!fs.existsSync(authPath)) {
    return {
      status: 'installed-not-signed-in',
      label: 'OpenAI Codex — installed, not signed in',
      binaryPath,
      authPath,
      hint: 'Run `codex login` and pick "Sign in with ChatGPT" (never an API key) — see docs/PROVIDERS.md',
    };
  }
  return { status: 'connected', label: 'OpenAI Codex — connected', binaryPath, authPath };
}

/* ------------------------------------------------------- permission modes */

interface CodexModeConfig {
  /** AskForApproval enum on the wire: 'untrusted' | 'on-request' | 'never'. */
  approvalPolicy: 'untrusted' | 'on-request' | 'never';
  /** thread/start takes `sandbox` — a SandboxMode STRING. */
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** turn/start takes `sandboxPolicy` — a SandboxPolicy OBJECT (camelCase type). */
  sandboxPolicy: { type: 'readOnly' | 'workspaceWrite' | 'dangerFullAccess' };
  /** acceptEdits semantics: file-change approvals answered allow adapter-side. */
  autoApproveFileEdits: boolean;
}

/**
 * Orchard permission modes → (approvalPolicy × sandbox), spellings per the
 * REAL generated schema (P2c): the docs' 'unlessTrusted' does not exist — the
 * AskForApproval enum is 'untrusted' (prompt unless the command is trusted,
 * the closest match to Claude's 'default' prompting) | 'on-request' | 'never'.
 * `plan` has NO Codex equivalent — refuse honestly rather than silently
 * running a normal turn while the UI claims plan mode.
 * bypassPermissions-in-container composes ours-outside-theirs: Codex's own
 * seccomp/landlock sandbox may not initialise inside Docker, so the container
 * is the wall and Codex runs unconfined inside it.
 */
function modeToCodex(mode: string): CodexModeConfig {
  switch (mode) {
    case 'default':
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' }, autoApproveFileEdits: false };
    case 'acceptEdits':
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' }, autoApproveFileEdits: true };
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' }, autoApproveFileEdits: true };
    case 'dispatch:read-only':
      // FEAT-043 scripts/dispatch.mjs — headless one-shot dispatch. No human
      // is attached to answer approval prompts, so approvals are 'never' and
      // the SANDBOX is the wall: read-only is the safe default (review /
      // analysis / sweep tasks cannot touch the tree; a command needing
      // writes simply fails inside the sandbox instead of hanging on a
      // prompt nobody will answer). Not offered by the UI mode picker.
      return { approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' }, autoApproveFileEdits: false };
    case 'dispatch:workspace-write':
      // FEAT-043 opt-in (--sandbox workspace-write): still no prompts, but
      // the Codex sandbox permits writes INSIDE the workspace cwd only.
      return { approvalPolicy: 'never', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' }, autoApproveFileEdits: true };
    case 'plan':
      throw new Error("Codex has no plan mode — 'plan' cannot be honoured by this runtime");
    default:
      throw new Error(`unknown permission mode '${mode}'`);
  }
}

/* ------------------------------------------------------------ child shape */

/** The minimal ChildProcess surface this adapter uses — kept structural so the
 *  spawnProcess seam (docker exec / survival broker / test fake) can satisfy it. */
interface ChildLike {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
}

/** Approval server→client request methods (older + newer app-server spellings). */
const EXEC_APPROVAL_METHODS = new Set(['execCommandApproval', 'item/commandExecution/requestApproval']);
const PATCH_APPROVAL_METHODS = new Set(['applyPatchApproval', 'item/fileChange/requestApproval']);

/** Item types surfaced as tool calls (tool_use → tool_result pairs) — the
 *  REAL ThreadItem type tags (schema: there is no 'fileEdit'; it's 'fileChange'). */
const TOOL_ITEM_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch']);

/* ---------------------------------------------------------------- runtime */

export class CodexRuntime implements AgentRuntime {
  /**
   * Honest capabilities per the FEAT-037 P2 appendix — exactly what app-server
   * gives us, nothing faked:
   *  - approvals TRUE: server→client execCommandApproval/applyPatchApproval is
   *    a real bidirectional channel (allow/deny only — no updatedInput).
   *  - permissionModes TRUE: mapped to approval_policy × sandbox_mode, but no
   *    plan mode, and changes apply from the NEXT turn, not mid-turn.
   *  - structuredCost FALSE: subscription billing reports tokens, never USD —
   *    the budget guardrail cannot enforce a dollar cap on this runtime.
   *  - modelList TRUE: model/list (with reasoning-effort options).
   *  - subagents TRUE since 2026-08-06 — the P2 appendix's `false` was WRONG
   *    for current codex-cli (see FEAT-037 ticket, "2026-08-06 — subagent
   *    capability re-check"): 0.145+/0.146 has native multi-agent, default-on
   *    (`codex features list` → multi_agent stable true), and it IS on the
   *    app-server wire — `collabAgentToolCall` thread items (tool spawnAgent/
   *    sendInput/resumeAgent/wait/closeAgent), `subAgentActivity` items
   *    (agentThreadId, kind started/interacted/interrupted) and sub-thread
   *    `thread/started` with SubAgentSource.thread_spawn. Mapped below into
   *    the bridge's task-frame dialect (task_started/task_progress/
   *    task_updated) keyed by agentThreadId.
   *  - persistedTranscript FALSE, and it STAYS false after P2b — the flag
   *    means "the ENGINE persists a station-readable transcript on its own".
   *    Codex has its own store (thread/resume works across processes) but not
   *    in our shape; since P2b the BRIDGE compensates with Orchard-owned
   *    capture (agent-bridge's TranscriptRecorder → dataDir()/transcripts/),
   *    which gives this runtime history rendering + reopen/resume. What the
   *    false flag still honestly gates: FEAT-015 survival (the recorder dies
   *    with the server, so a surviving CLI would produce unrecorded turns).
   *  - fork TRUE on the wire (thread/fork, fixture-proven); the STATION path
   *    refuses codex forks for now — the fork's new thread would need its
   *    Orchard transcript seeded with ancestor history (P2b follow-up).
   *  - effort TRUE: model_reasoning_effort / model/list effort options.
   */
  readonly capabilities: RuntimeCapabilities = {
    approvals: true,
    permissionModes: true,
    // app-server has NO mid-turn switch: setPermissionMode stashes #mode for the
    // next turn/start, so a change made DURING a turn does not touch that turn's
    // approvalPolicy (live-proven — see setPermissionMode/#startTurn). false so the
    // bridge/UI never claim skip is in force while the running turn still prompts.
    permissionModeMidTurn: false,
    structuredCost: false,
    modelList: true,
    subagents: true, // flipped 2026-08-06 per the ticket's subagent capability re-check (see doc above)
    persistedTranscript: false,
    fork: true,
    effort: true,
    // P3 honesty flags: no plan mode (modeToCodex refuses it), and no
    // per-session MCP config yet — Codex's MCP servers live in
    // ~/.codex/config.toml; per-invocation `-c mcp_servers…` overrides are
    // P2c work, so the bridge must NOT hand this runtime an mcpServers map.
    planMode: false,
    mcpConfig: false,
    // BUG-043: Codex announces subagent threads but has no signal for "this
    // work outlives the turn". Declared ABSENT rather than guessed: while an
    // agent row is still running the bridge answers `unknown` (biased to
    // detach — never destroy work on a guess); with every row settled it
    // answers `no` and the session closes exactly as before.
    backgroundLifetime: 'absent',
  };

  #out = new MessageQueue();
  #child: ChildLike | null = null;
  #config: RuntimeStartConfig | null = null;
  #closed = false;

  #nextId = 0;
  #pending = new Map<number, { resolve: (result: any) => void; reject: (err: Error) => void }>();

  #threadId: string | null = null;
  #turnId: string | null = null;
  #turnActive = false;
  /** Follow-up turns queued while one is in flight — the adapter serialises
   *  turn/start calls, playing the role InputQueue plays for the Claude CLI. */
  #sendQueue: string[] = [];

  #mode: CodexModeConfig | null = null;
  /** Model override for the NEXT turn; undefined = untouched, null = cleared. */
  #pendingModel: string | null | undefined = undefined;
  /** Item ids we announced as tool_use — their completion becomes tool_result. */
  #toolItems = new Set<string>();
  /** Per-turn token usage — the Turn object carries NO usage on the real wire;
   *  it arrives via thread/tokenUsage/updated (tokenUsage.last = this turn). */
  #lastUsage: Record<string, unknown> | undefined;
  /** Aborts in-flight approval prompts when the turn ends or the runtime closes. */
  #approvalAbort = new AbortController();
  #stderrTail = '';
  /**
   * FEAT-037 subagents — collab agent threads announced to the bridge as
   * task-frame LiveAgents, keyed by the sub-agent's own thread id
   * (`agentThreadId` / `receiverThreadIds[i]` — the direct analogue of the
   * Claude path's task_id). `settled` enforces BUG-030's invariant: an agent
   * row SETTLES exactly once (completed/failed/killed) and never spins
   * forever; late frames after the terminal one are dropped here, not
   * re-announced.
   */
  #collabAgents = new Map<string, { label: string; description: string; settled: boolean }>();

  start(config: RuntimeStartConfig): void {
    this.#config = config;
    this.#mode = modeToCodex(config.permissionMode); // throws honestly on 'plan'

    /*
     * Binary resolution, in trust order: an explicit pathToExecutable (the
     * container/isolation seam), the CLAUDE_STATION_CODEX_BIN env override
     * (the verification seam — this is how the fake app-server in
     * scripts/fixtures/ is driven through the REAL session-start path), then
     * plain `codex` on PATH. A .mjs/.js path is run through the current node
     * (the fixture fake is a node script; the real binary never is).
     */
    let command = config.pathToExecutable ?? process.env.CLAUDE_STATION_CODEX_BIN ?? 'codex';
    // Bare 'codex' resolves through the SAME detection the picker shows
    // (PATH + well-known dirs like ~/.local/bin): a service whose minimal
    // PATH misses the user's install must not ENOENT on a binary the UI just
    // reported as connected.
    if (command === 'codex') command = detectCodex().binaryPath ?? 'codex';
    let args = ['app-server'];
    if (/\.(mjs|cjs|js)$/.test(command)) {
      args = [command, ...args];
      command = process.execPath;
    }
    /*
     * FEAT-135 — extend the subprocess git-write block to the codex runtime.
     *
     * CodexRuntime carries NO FEAT-108 PreToolUse hook (that hook is a Claude-SDK
     * seam), so an openai/codex session is unguarded for git writes at BOTH the
     * shell and the subprocess layer. `installGitShim` prepends a `git` shim onto
     * THIS app-server's PATH; the shim classifies every PATH-resolved git with the
     * SAME read/write logic the FEAT-108 hook uses and refuses a write loudly,
     * regardless of how it was spawned (bash, node, python, a wrapper script).
     * The sanctioned FEAT-134 temp-index snapshot is allowed only under
     * GIT_INDEX_FILE-in-tmpdir.
     *
     * PROVEN it reaches the child (not assumed): a real codex session forwards
     * this env down to the exec subprocess in BOTH danger-full-access (bypass) and
     * workspace-write (default sandbox) modes — the shell tool runs `bash -lc
     * 'git …'` and the shim dir at the front of PATH survives even the login-shell
     * PATH rebuild (FEAT-135 round-3 probe + verify-feat-135-codex-active-e2e).
     *
     * SCOPE: `installGitShim` is PURE — it returns a COPY of the env with the shim
     * dir prepended; it does NOT touch the host process PATH or the user's login
     * shell. Mirrors claude-runtime's options.env wrap. (Inside a CONTAINER the
     * shim dir is a host temp path absent from the container FS, so container-
     * internal git is NOT shimmed — the same pre-existing structural boundary
     * documented for the Claude runtime. Absolute-path git and env-scrubbing
     * subprocesses remain out of scope, as on the Claude side.)
     *
     * Guarded by `gitWriteBlockEnabled()`: with the ORCHARD_ALLOW_GIT_WRITE hatch
     * open the shim is not installed, mirroring the hook's own kill-switch.
     */
    const baseEnv = { ...process.env };
    const env = gitWriteBlockEnabled() ? installGitShim(baseEnv).env : baseEnv;
    let child: ChildLike;
    if (config.spawnProcess) {
      // Isolation/survival seam — same contract as ClaudeRuntime's
      // spawnClaudeCodeProcess override: the session owns the closure
      // (docker exec / survival broker), we own the protocol on its stdio.
      child = config.spawnProcess({ command, args, cwd: config.cwd, env }) as ChildLike;
    } else {
      child = spawn(command, args, { cwd: config.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as ChildLike;
    }
    this.#child = child;

    child.once('error', (err: Error) => {
      // Typically ENOENT — the binary is not there. Say so honestly.
      const why = (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? `codex CLI not found (looked for '${command}') — install it and sign in, see docs/PROVIDERS.md`
        : `codex app-server failed to spawn: ${err.message}`;
      this.#fail(new Error(why));
    });
    child.once('exit', (code) => {
      if (this.#closed) return;
      const tail = this.#stderrTail.trim();
      this.#fail(new Error(`codex app-server exited unexpectedly (code ${code})${tail ? `: ${tail.slice(-400)}` : ''}`));
    });
    // BUG-078: setEncoding('utf8') so Node's StringDecoder buffers a codepoint
    // whose bytes straddle two chunks — a per-chunk d.toString() decodes the
    // partial bytes to U+FFFD in each half, silently corrupting multibyte text.
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      this.#stderrTail = (this.#stderrTail + d).slice(-2000);
    });

    if (!child.stdout || !child.stdin) {
      this.#fail(new Error('codex app-server spawned without piped stdio'));
      return;
    }
    // Newline-delimited JSON frames off stdout. BUG-078: setEncoding('utf8')
    // makes 'data' deliver already-decoded strings with partial codepoints held
    // across chunk boundaries (decode-only — chunk delivery and the '\n'
    // framing below are unchanged).
    child.stdout.setEncoding('utf8');
    let buf = '';
    child.stdout.on('data', (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          this.#onFrame(JSON.parse(line));
        } catch (err) {
          this.#fail(new Error(`codex app-server spoke a non-JSON frame: ${(err as Error).message}`));
          return;
        }
      }
    });

    // Handshake + thread + first turn, async off the sync start() — failures
    // surface through the message stream like any transport error.
    void this.#boot(config).catch((err: Error) => this.#fail(err));
  }

  async #boot(config: RuntimeStartConfig): Promise<void> {
    await this.#request('initialize', {
      clientInfo: { name: 'orchard', version: '0.1.0' },
      capabilities: {},
    });
    this.#notify('initialized', {});

    let threadResult: any;
    if (config.resume) {
      // resume → thread/resume; resume+forkSession → thread/fork (a new thread
      // branched off the old one) — the same pairing options.resume/forkSession
      // express for Claude.
      threadResult = config.forkSession
        ? await this.#request('thread/fork', { threadId: config.resume })
        : await this.#request('thread/resume', { threadId: config.resume });
    } else {
      // Schema-validated (P2c): thread/start takes `sandbox` (SandboxMode
      // string) — NOT `sandboxMode` — and has NO reasoning-effort key at all;
      // effort rides `turn/start.effort` instead. The model is deliberately
      // NOT set here either: every turn/start carries it as an override, so a
      // bad model fails THAT TURN (→ a classifiable provider-error) instead
      // of killing the whole thread at start.
      threadResult = await this.#request('thread/start', {
        cwd: config.cwd,
        approvalPolicy: this.#mode!.approvalPolicy,
        sandbox: this.#mode!.sandbox,
      });
    }
    this.#threadId = String(threadResult?.thread?.id ?? '');
    if (!this.#threadId) throw new Error('codex app-server returned no thread id');

    // The init frame AgentSession expects — session_id is the Codex thread id,
    // which is exactly what resume needs back later.
    this.#out.push({
      type: 'system',
      subtype: 'init',
      session_id: this.#threadId,
      cwd: config.cwd,
      model: config.model ?? 'codex default',
      tools: [],
      permissionMode: config.permissionMode,
      slash_commands: [], // Codex has no Claude-style slash-command list
    });

    this.#startTurn(config.firstPrompt);
  }

  send(text: string): void {
    if (this.#closed) throw new Error('runtime closed');
    if (!this.#threadId || this.#turnActive) {
      // Serialised like InputQueue: queued until the in-flight turn completes.
      // (turn/steer could inject into the live turn; deferred to P2c where the
      // real binary can prove its semantics.)
      this.#sendQueue.push(text);
      return;
    }
    this.#startTurn(text);
  }

  #startTurn(text: string): void {
    this.#turnActive = true;
    this.#lastUsage = undefined; // per-turn: filled by thread/tokenUsage/updated
    const params: Record<string, unknown> = {
      threadId: this.#threadId,
      input: [{ type: 'text', text }],
      // Mode/model overrides apply from THIS (next) turn — app-server has no
      // mid-turn switch, which is the honest permissionModes caveat.
      // Schema-validated (P2c): turn/start takes `sandboxPolicy` (an OBJECT
      // with camelCase type), and reasoning effort lives HERE as `effort`.
      approvalPolicy: this.#mode!.approvalPolicy,
      sandboxPolicy: this.#mode!.sandboxPolicy,
      ...(this.#config?.effort ? { effort: this.#config.effort } : {}),
    };
    const model = this.#pendingModel !== undefined ? this.#pendingModel : this.#config?.model ?? null;
    if (model) params.model = model;
    void this.#request('turn/start', params)
      .then((r: any) => { this.#turnId = String(r?.turn?.id ?? this.#turnId ?? ''); })
      .catch((err: Error) => {
        // A rejected turn/start (e.g. unknown model → JSON-RPC error) is a
        // TURN failure, not transport death: surface it as a failed-turn
        // result so the session stays alive and BUG-031 can attribute it.
        this.#finishTurn({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          num_turns: 1,
          result: err.message,
        });
      });
  }

  async interrupt(): Promise<void> {
    if (!this.#turnActive || !this.#threadId) return;
    await this.#request('turn/interrupt', { threadId: this.#threadId, turnId: this.#turnId });
    // turn/completed{status:"interrupted"} arrives as a notification and is
    // mapped to the result frame there.
  }

  async setPermissionMode(mode: string): Promise<void> {
    // Throws honestly for 'plan' / unknown modes; otherwise applies from the
    // next turn/start (no mid-turn switch in app-server).
    this.#mode = modeToCodex(mode);
  }

  async setModel(model: string | null): Promise<void> {
    if (!this.#child) throw new Error('runtime not started');
    // Applies from the next turn — app-server takes model per thread/turn
    // start; there is no mid-turn switch (same caveat as permission modes).
    this.#pendingModel = model;
  }

  async supportedModels(): Promise<RuntimeModel[]> {
    if (!this.#child || this.#closed) return [];
    // Schema-validated (P2c): ModelListResponse is {data: Model[], nextCursor}
    // (paginated) — NOT {models}. Model.supportedReasoningEfforts is an array
    // of {reasoningEffort, description} option objects.
    const r: any = await this.#request('model/list', {});
    return (Array.isArray(r?.data) ? r.data : []).map((m: Record<string, any>) => ({
      value: String(m.id ?? m.model ?? ''),
      resolvedModel: m.model != null ? String(m.model) : undefined,
      displayName: String(m.displayName ?? m.id ?? ''),
      description: String(m.description ?? ''),
      supportsEffort: Array.isArray(m.supportedReasoningEfforts) && m.supportedReasoningEfforts.length > 0,
    }));
  }

  detach(): void {
    /*
     * Codex persists its own sessions (thread/resume works across processes),
     * so the ENGINE needs nothing here. Since P2b the BRIDGE keeps the
     * Orchard-owned transcript current while detached (the recorder hangs off
     * #handle, which keeps running without a socket), so detach-and-return
     * works: the tab that comes back re-reads history from
     * dataDir()/transcripts/ and re-attaches or thread/resumes. Still a
     * deliberate no-op HERE — the engine has no detach concept to invoke.
     */
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#approvalAbort.abort();
    for (const p of this.#pending.values()) p.reject(new Error('runtime closed'));
    this.#pending.clear();
    this.#out.end();
    const child = this.#child;
    try { child?.stdin?.end(); } catch { /* already gone */ }
    // The binary exits cleanly when stdin ends (exit 0 = no protocol
    // violations, which the verify suite asserts); the kill is only a guard
    // for a wedged one. By pid, never by name.
    if (child) {
      const guard = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 2_000);
      guard.unref?.();
      child.once('exit', () => clearTimeout(guard));
    }
  }

  messages(): AsyncIterable<RuntimeMessage> {
    return this.#out;
  }

  /**
   * BUG-031 — HONEST provider-error mapping for the Codex path, P2c edition.
   *
   * The failure frame this adapter emits is the failed-turn result
   * (`subtype:'error_during_execution'`, `is_error:true`, the server's
   * message in `result`, and — when the wire supplied one — the STRUCTURED
   * `codex_error_info` from `turn.error.codexErrorInfo`). The schema's
   * CodexErrorInfo is the classification ground truth (codex-cli 0.146.0):
   * string codes contextWindowExceeded | sessionBudgetExceeded |
   * usageLimitExceeded | serverOverloaded | cyberPolicy | internalServerError
   * | unauthorized | badRequest | threadRollbackFailed | sandboxError | other,
   * plus object variants carrying an httpStatusCode
   * (httpConnectionFailed / responseStreamConnectionFailed /
   * responseStreamDisconnected). `usageLimitExceeded` IS the rolling-window
   * subscription limit → 'quota-window' per BUG-031's taxonomy. The regex
   * table survives only as the FALLBACK for failures with no structured info
   * (e.g. a rejected turn/start request); anything unrecognised stays an
   * honest 'internal' with the server's own text verbatim.
   */
  classifyProviderError(msg: RuntimeMessage): ProviderError | null {
    const m = msg as Record<string, any>;
    if (m.type !== 'result' || m.is_error !== true) return null;
    const detail = typeof m.result === 'string' ? m.result : '';
    if (!detail) return null; // nothing to attribute — leave it to the generic turn-end
    const base = { provider: 'openai', detail } as const;
    const info = m.codex_error_info as string | Record<string, any> | undefined;

    if (typeof info === 'string') {
      switch (info) {
        case 'usageLimitExceeded':      // the rolling 5h/weekly subscription window
          return { ...base, kind: 'quota-window', retryable: false };
        case 'serverOverloaded':
          return { ...base, kind: 'overloaded', retryable: true };
        case 'unauthorized':
          return { ...base, kind: 'auth-expired', retryable: false };
        case 'internalServerError':
          return { ...base, kind: 'internal', retryable: true };
        case 'badRequest':
        case 'other':
          // 'other' is the wire's OWN unclassified bucket, and 'badRequest'
          // needs the message to decide — both fall through to the text
          // heuristics below. Observed live (0.146.0): a bogus model is
          // codexErrorInfo:'other' with the raw upstream 400 body as the
          // message ("The '<model>' model is not supported when using Codex
          // with a ChatGPT account.").
          break;
        default:
          // contextWindowExceeded, sessionBudgetExceeded, cyberPolicy,
          // threadRollbackFailed, sandboxError — real failures with no finer
          // bucket in BUG-031's taxonomy: honest 'internal'.
          return { ...base, kind: 'internal', retryable: false };
      }
    }
    if (info && typeof info === 'object') {
      // Object variants (httpConnectionFailed / responseStreamConnectionFailed
      // / responseStreamDisconnected) — connection-level failures carrying an
      // optional upstream httpStatusCode.
      const status = (Object.values(info)[0] as Record<string, any> | undefined)?.httpStatusCode ?? null;
      if (status === 429) return { ...base, kind: 'rate-limited', retryable: true, statusCode: 429 };
      if (status === 401 || status === 403) return { ...base, kind: 'auth-expired', retryable: false, statusCode: status };
      if (typeof status === 'number' && status >= 500) return { ...base, kind: 'overloaded', retryable: true, statusCode: status };
      return { ...base, kind: 'network', retryable: true, statusCode: status };
    }

    // No structured info (e.g. a rejected turn/start request) — text fallback.
    if (/usage limit|5[- ]hour|five[- ]hour|quota/i.test(detail)) {
      return { ...base, kind: 'quota-window', retryable: false };
    }
    if (/rate.?limit|429|too many requests/i.test(detail)) {
      return { ...base, kind: 'rate-limited', retryable: true };
    }
    if (/auth|login|token.*(expired|invalid)|401|unauthorized/i.test(detail)) {
      return { ...base, kind: 'auth-expired', retryable: false };
    }
    if (/model.*(not found|not supported|unknown|unavailable|no access)|unknown model/i.test(detail)) {
      return { ...base, kind: 'model-unavailable', retryable: false };
    }
    if (/network|timed? ?out|connection|ECONNRESET|ENOTFOUND/i.test(detail)) {
      return { ...base, kind: 'network', retryable: true };
    }
    return { ...base, kind: 'internal', retryable: false };
  }

  /* ------------------------------------------------------------ transport */

  #write(frame: Record<string, unknown>): void {
    if (!this.#child?.stdin) throw new Error('runtime not started');
    this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
  }

  #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#write({ id, method, params });
      } catch (err) {
        this.#pending.delete(id);
        reject(err as Error);
      }
    });
  }

  #notify(method: string, params: Record<string, unknown>): void {
    this.#write({ method, params });
  }

  #fail(err: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#approvalAbort.abort();
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
    this.#out.fail(err);
    try { this.#child?.kill(); } catch { /* already gone */ }
  }

  #onFrame(frame: Record<string, any>): void {
    // Response to one of OUR requests.
    if (frame.id != null && frame.method == null) {
      const pending = this.#pending.get(Number(frame.id));
      if (!pending) return; // stale response after close/fail
      this.#pending.delete(Number(frame.id));
      if (frame.error) pending.reject(new Error(String(frame.error.message ?? 'codex app-server error')));
      else pending.resolve(frame.result);
      return;
    }
    // Server→client REQUEST (has an id): the approval channel.
    if (frame.id != null && typeof frame.method === 'string') {
      void this.#onServerRequest(frame);
      return;
    }
    // Notification.
    if (typeof frame.method === 'string') this.#onNotification(frame.method, frame.params ?? {});
  }

  /* ------------------------------------------------------------ approvals */

  /**
   * Build the wire decision in the METHOD'S OWN dialect (schema-validated,
   * P2c). The legacy methods (execCommandApproval / applyPatchApproval) take a
   * ReviewDecision: 'approved' | 'approved_for_session' | {denied:{rejection}}
   * | 'abort' | 'timed_out'. The newer item/*\/requestApproval family takes
   * 'accept' | 'acceptForSession' | 'decline' | 'cancel'. The P2a-era
   * {decision:'allow'|'deny'} exists NOWHERE on the real wire.
   */
  #approvalDecision(method: string, allow: boolean, rejection?: string): unknown {
    const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval';
    if (allow) return legacy ? 'approved' : 'accept';
    if (legacy) return { denied: { rejection: rejection || 'Denied from the dashboard.' } };
    return 'decline';
  }

  async #onServerRequest(frame: Record<string, any>): Promise<void> {
    const { id, method } = frame;
    const params = (frame.params ?? {}) as Record<string, unknown>;
    const isExec = EXEC_APPROVAL_METHODS.has(method);
    const isPatch = PATCH_APPROVAL_METHODS.has(method);
    if (!isExec && !isPatch) {
      // Unknown server request: a proper JSON-RPC method-not-found error, so
      // the server's turn cannot hang on us and we don't fake a decision
      // shape we don't know.
      this.#write({ id, error: { code: -32601, message: `orchard does not handle server request '${method}'` } });
      return;
    }
    // acceptEdits semantics: file-change approvals auto-allowed adapter-side
    // (Codex has no native acceptEdits; this is the mapped equivalent).
    if (isPatch && this.#mode?.autoApproveFileEdits) {
      this.#write({ id, result: { decision: this.#approvalDecision(method, true) } });
      return;
    }
    let allow = false;
    let rejection: string | undefined;
    try {
      const result: ApprovalResult = await this.#config!.onApproval({
        toolName: isExec ? 'commandExecution' : 'applyPatch',
        input: params,
        meta: {
          signal: this.#approvalAbort.signal,
          requestId: `codex-${id}`,
          toolUseID: typeof params.callId === 'string' ? params.callId
            : typeof params.itemId === 'string' ? params.itemId : undefined,
          description: typeof params.reason === 'string' ? params.reason : undefined,
        },
      });
      // Honest delta vs canUseTool: Codex takes approve/deny ONLY — an
      // allow's updatedInput cannot be round-tripped, so amended input is
      // dropped. A deny's message DOES round-trip as the rejection text.
      allow = result.behavior === 'allow';
      if (!allow && typeof (result as { message?: string }).message === 'string') {
        rejection = (result as { message?: string }).message;
      }
    } catch {
      allow = false; // an errored/aborted prompt must not hang the turn
    }
    if (!this.#closed) this.#write({ id, result: { decision: this.#approvalDecision(method, allow, rejection) } });
  }

  /* --------------------------------------------- notifications → messages */

  #onNotification(method: string, params: Record<string, any>): void {
    /*
     * FEAT-037 subagents — thread-scoped notifications carry `threadId`
     * (schema: ItemStarted/ItemCompleted/TurnStarted/… params). A frame whose
     * threadId is NOT ours is a sub-agent thread's own stream sharing this
     * connection: it must never mutate main-turn state (a child's
     * turn/completed must not finish OUR turn) nor leak into the main
     * transcript. It surfaces as live-agent progress instead — except subagent
     * ITEMS (collabAgentToolCall/subAgentActivity), which are handled in full
     * wherever they appear (that is how a depth-2 spawn announced on the
     * depth-1 child's stream still reaches the flattened panel).
     */
    const wireThreadId = typeof params.threadId === 'string' ? params.threadId : null;
    const foreign = wireThreadId != null && this.#threadId != null && wireThreadId !== this.#threadId;

    switch (method) {
      case 'thread/started': {
        // Schema: params carry the full Thread object ({thread:{id,…}}).
        const thread = (params.thread ?? {}) as Record<string, any>;
        // FEAT-037 subagents: a SPAWNED sub-agent's thread also announces
        // itself here, tagged SubAgentSource.thread_spawn — that is where
        // agent_role/agent_nickname/depth/parent live. It is NOT our thread:
        // adopting its id would corrupt every later turn/start. Announce (or
        // relabel) the LiveAgent row instead; depth>1 is flattened honestly
        // with the parent noted in the description, not a tree UI.
        const spawn = (thread.source as Record<string, any> | undefined)?.subAgent?.thread_spawn as
          Record<string, any> | undefined;
        if (spawn && thread.id) {
          const label = thread.agentRole ?? spawn.agent_role ?? thread.agentNickname ?? spawn.agent_nickname ?? null;
          const depth = Number(spawn.depth ?? 1);
          const parent = String(spawn.parent_thread_id ?? '');
          const desc = depth > 1
            ? `Codex subagent (depth ${depth}, nested under ${parent})`
            : null;
          this.#announceAgent(String(thread.id), label != null ? String(label) : null, desc);
          return;
        }
        // Usually redundant with the thread/start|resume response; keep the id
        // in sync in case the server renames the thread.
        if (thread.id ?? params.threadId) this.#threadId = String(thread.id ?? params.threadId);
        return;
      }

      case 'turn/started':
        if (foreign) { this.#agentProgress(wireThreadId); return; } // a child's turn, not ours
        this.#turnId = String(params.turn?.id ?? params.turnId ?? this.#turnId ?? '');
        this.#turnActive = true;
        return;

      case 'item/started': {
        const item = (params.item ?? {}) as Record<string, any>;
        if (this.#collabItem(item, 'started')) return;
        if (foreign) { this.#agentProgress(wireThreadId, String(item.type ?? '') || undefined); return; }
        if (!TOOL_ITEM_TYPES.has(String(item.type))) return;
        this.#toolItems.add(String(item.id));
        // Surfaced under Codex's own item-type names — honest, not Claude-tool
        // cosplay. Input carries the fields the approval/tool card can show.
        this.#out.push({
          type: 'assistant',
          parent_tool_use_id: null, // main-thread item (sub-agent work rides the task frames, not this)
          message: {
            content: [{
              type: 'tool_use',
              id: String(item.id),
              name: String(item.type === 'mcpToolCall' ? item.tool ?? 'mcpToolCall' : item.type),
              input: this.#toolInput(item),
            }],
          },
        });
        return;
      }

      case 'item/agentMessage/delta': {
        if (foreign) { this.#agentProgress(wireThreadId); return; } // a child's words are not OUR transcript
        const text = String(params.delta ?? params.text ?? '');
        if (!text) return;
        this.#out.push({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
        });
        return;
      }

      case 'item/completed': {
        const item = (params.item ?? {}) as Record<string, any>;
        if (this.#collabItem(item, 'completed')) return;
        if (foreign) { this.#agentProgress(wireThreadId); return; }
        const itemType = String(item.type ?? '');
        if (itemType === 'agentMessage') {
          this.#out.push({
            type: 'assistant',
            parent_tool_use_id: null,
            message: { content: [{ type: 'text', text: String(item.text ?? '') }] },
          });
        } else if (itemType === 'reasoning') {
          // Thinking text stays empty by design — parity with the Claude path,
          // where only the fact of thinking is surfaced.
          this.#out.push({
            type: 'assistant',
            parent_tool_use_id: null,
            message: { content: [{ type: 'thinking', thinking: '' }] },
          });
        } else if (this.#toolItems.has(String(item.id))) {
          this.#toolItems.delete(String(item.id));
          this.#out.push({
            type: 'user',
            parent_tool_use_id: null,
            message: {
              content: [{
                type: 'tool_result',
                tool_use_id: String(item.id),
                // Schema statuses: inProgress|completed|failed|declined —
                // 'declined' is a user-denied approval, also an error result.
                is_error: item.status === 'failed' || item.status === 'declined',
                content: String(item.aggregatedOutput ?? item.output ?? item.status ?? ''),
              }],
            },
          });
        }
        return;
      }

      case 'thread/tokenUsage/updated':
        if (foreign) { this.#agentProgress(wireThreadId); return; } // a child's tokens must not overwrite our turn's
        // Schema-validated (P2c): the Turn object carries NO usage — this
        // notification is where tokens live. `tokenUsage.last` is the
        // in-flight turn's breakdown; stash it for the result frame.
        if (params.tokenUsage?.last && typeof params.tokenUsage.last === 'object') {
          this.#lastUsage = params.tokenUsage.last as Record<string, unknown>;
        }
        return;

      case 'turn/completed': {
        /*
         * Schema-validated (P2c): there is NO `turn/failed` notification on
         * the real wire. Failure IS turn/completed with turn.status:'failed'
         * and turn.error {message, additionalDetails?, codexErrorInfo?} —
         * codexErrorInfo being the structured code classifyProviderError
         * keys on (carried through as `codex_error_info`).
         */
        if (foreign) { this.#agentProgress(wireThreadId); return; } // a child finishing a turn ≠ OUR turn ending
        const turn = (params.turn ?? {}) as Record<string, any>;
        if (turn.status === 'failed') {
          const err = (turn.error ?? {}) as Record<string, any>;
          this.#finishTurn({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            num_turns: 1,
            result: String(err.message ?? 'codex turn failed'),
            ...(err.codexErrorInfo != null ? { codex_error_info: err.codexErrorInfo } : {}),
            usage: this.#lastUsage,
          });
          return;
        }
        this.#finishTurn({
          type: 'result',
          // AgentSession derives `interrupted` from its own flag; the subtype
          // string is display truth.
          subtype: turn.status === 'interrupted' ? 'interrupted' : 'success',
          is_error: false,
          num_turns: 1,
          // Tokens only (from thread/tokenUsage/updated — the Turn object has
          // no usage field) — deliberately NO total_cost_usd
          // (structuredCost:false): subscription billing has no per-turn
          // dollar figure, and inventing one would corrupt the budget
          // guardrail.
          usage: this.#lastUsage,
        });
        return;
      }

      default:
        // thread/status/changed, thread/tokenUsage/updated, item/updated, … —
        // nothing upstream consumes these yet.
        return;
    }
  }

  #finishTurn(resultMsg: RuntimeMessage): void {
    this.#turnActive = false;
    this.#turnId = null;
    // Approval prompts belonging to the finished turn are moot.
    this.#approvalAbort.abort();
    this.#approvalAbort = new AbortController();
    /*
     * FEAT-037 subagents — turn-boundary sweep (BUG-030's ground truth: after
     * OUR turn's result, nothing from the turn can still be running). Needed
     * live, not just defensively: default-on multi_agent v1 (0.146.0,
     * live-probed 2026-08-06) ends the turn with a `wait` collab call whose
     * receiverThreadIds AND agentsStates are EMPTY, and the child thread's own
     * turn/completed is deliberately not treated as the agent's end (a parent
     * may sendInput again) — so an explicit per-agent terminal may never
     * arrive. Settle every still-open agent BEFORE the result frame:
     * completed on a normal end, killed (cut) on an interrupted/failed turn.
     */
    const verdict = (resultMsg as Record<string, unknown>).subtype === 'success' ? 'completed' as const : 'killed' as const;
    for (const [id, a] of this.#collabAgents) { if (!a.settled) this.#settleAgent(id, verdict); }
    this.#out.push(resultMsg);
    const next = this.#sendQueue.shift();
    if (next != null && !this.#closed) this.#startTurn(next);
  }

  /* ------------------------------------------------- subagents (FEAT-037) */

  /**
   * Announce a sub-agent thread to the bridge as a LiveAgent. The frame is the
   * SAME `system/task_started` dialect the Claude CLI speaks (agent-bridge
   * `task_started` handler): `subagent_type` present + `task_type:'local_agent'`
   * ⇒ the bridge stamps `kind:'agent'` (a real subagent row, not a BUG-030
   * tool-call row). Re-announcing an unsettled agent with a BETTER label
   * (thread/started brings agentRole/agentNickname after the spawn item) is
   * allowed — the bridge overwrites its entry by task_id; a SETTLED agent that
   * is explicitly revived (resumeAgent / a fresh spawn) re-opens the same row.
   */
  #announceAgent(agentThreadId: string, label: string | null, description: string | null): void {
    if (!agentThreadId) return;
    const prev = this.#collabAgents.get(agentThreadId);
    const merged = {
      label: label ?? prev?.label ?? 'codex-agent',
      description: description ?? prev?.description ?? 'Codex subagent',
      settled: false,
    };
    // Already live with nothing new to say → don't churn the row.
    if (prev && !prev.settled && prev.label === merged.label && prev.description === merged.description) return;
    this.#collabAgents.set(agentThreadId, merged);
    this.#out.push({
      type: 'system',
      subtype: 'task_started',
      task_id: agentThreadId,
      tool_use_id: null,
      subagent_type: merged.label,
      task_type: 'local_agent',
      description: merged.description,
    });
  }

  /** Progress heartbeat → bridge `task_progress` → `agent-progress` (refreshes
   *  the row's elapsed time and, client-side, BUG-030's `seenAt` liveness). */
  #agentProgress(agentThreadId: string, lastTool?: string): void {
    const a = this.#collabAgents.get(agentThreadId);
    if (!a || a.settled) return; // unknown or already terminal — never revive via progress
    this.#out.push({
      type: 'system',
      subtype: 'task_progress',
      task_id: agentThreadId,
      ...(lastTool ? { last_tool_name: lastTool } : {}),
    });
  }

  /**
   * Terminal frame — BUG-030's agent-task shape: `task_updated` with
   * `patch.status` completed|failed|killed, which the bridge maps to
   * `agent-completed` (the row SETTLES; `killed` is the interrupted/cut
   * semantics). Idempotent: exactly one terminal per agent.
   */
  #settleAgent(agentThreadId: string, status: 'completed' | 'failed' | 'killed'): void {
    const a = this.#collabAgents.get(agentThreadId);
    if (!a || a.settled) return;
    a.settled = true;
    this.#out.push({
      type: 'system',
      subtype: 'task_updated',
      task_id: agentThreadId,
      patch: { status },
    });
  }

  /** CollabAgentStatus → our terminal verdict; null = still alive, don't settle. */
  #terminalFromAgentState(status: string | undefined): 'completed' | 'failed' | 'killed' | null {
    switch (status) {
      case 'completed':
      case 'shutdown':
        return 'completed';
      case 'errored':
      case 'notFound':
        return 'failed';
      case 'interrupted':
        return 'killed'; // BUG-030: an interrupted agent settles as killed/cut, honestly
      default:
        return null; // pendingInit / running — still alive
    }
  }

  /**
   * Handle the two subagent thread-item shapes (v2 schema:
   * CollabAgentToolCallThreadItem, SubAgentActivityThreadItem). Returns true
   * when the item was a subagent item (consumed — it must NOT also render as a
   * main-stream tool_use). Works for items on OUR thread (the parent's collab
   * calls) AND on foreign threads (a depth-1 child spawning depth-2 —
   * flattened honestly into the same panel, parent noted in the description,
   * rather than pretending a tree UI we don't have).
   */
  #collabItem(item: Record<string, any>, phase: 'started' | 'completed'): boolean {
    const type = String(item.type ?? '');
    if (type === 'subAgentActivity') {
      // {agentThreadId, agentPath, kind: started|interacted|interrupted}
      const id = String(item.agentThreadId ?? '');
      const kind = String(item.kind ?? '');
      if (kind === 'started') {
        const label = item.agentPath ? path.basename(String(item.agentPath), '.toml') : null;
        this.#announceAgent(id, label, null);
      } else if (kind === 'interacted') {
        this.#agentProgress(id);
      } else if (kind === 'interrupted') {
        this.#settleAgent(id, 'killed');
      }
      return true;
    }
    if (type !== 'collabAgentToolCall') return false;
    // {tool, status, senderThreadId, receiverThreadIds, agentsStates, prompt?, model?}
    const tool = String(item.tool ?? '');
    const targets: string[] = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(String) : [];
    const states = (item.agentsStates ?? {}) as Record<string, { status?: string; message?: string | null }>;
    if (tool === 'spawnAgent') {
      const prompt = typeof item.prompt === 'string' && item.prompt ? item.prompt : null;
      const desc = prompt ? (prompt.length > 140 ? `${prompt.slice(0, 140)}…` : prompt) : null;
      for (const t of targets) this.#announceAgent(t, null, desc);
      // A spawn that itself FAILED leaves no live agent behind — settle honestly.
      if (phase === 'completed' && item.status === 'failed') {
        for (const t of targets) this.#settleAgent(t, 'failed');
      }
      return true;
    }
    if (tool === 'closeAgent') {
      if (phase === 'completed') {
        for (const t of targets) {
          this.#settleAgent(t, this.#terminalFromAgentState(states[t]?.status) ?? 'completed');
        }
      } else {
        for (const t of targets) this.#agentProgress(t, tool);
      }
      return true;
    }
    // sendInput / resumeAgent / wait — progress while in flight; on completion
    // the call's agentsStates carry each target's last known status, which is
    // where a finished/errored/interrupted agent becomes visible to the parent
    // (a completed `wait` on a completed agent is the natural settle signal).
    if (tool === 'resumeAgent' && phase === 'started') {
      for (const t of targets) this.#announceAgent(t, null, null); // an explicit revival re-opens a settled row
    }
    for (const t of targets) this.#agentProgress(t, tool);
    if (phase === 'completed') {
      for (const t of targets) {
        const term = this.#terminalFromAgentState(states[t]?.status);
        if (term) this.#settleAgent(t, term);
      }
    }
    return true;
  }

  #toolInput(item: Record<string, any>): Record<string, unknown> {
    switch (String(item.type)) {
      case 'commandExecution':
        return { command: item.command, cwd: item.cwd };
      case 'fileChange':
        return { changes: item.changes ?? item.fileChanges };
      case 'mcpToolCall':
        return { server: item.server, tool: item.tool, arguments: item.arguments };
      case 'webSearch':
        return { query: item.query };
      default:
        return { ...item };
    }
  }
}
