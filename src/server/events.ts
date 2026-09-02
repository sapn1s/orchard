/**
 * The typed event union the UI switches on.
 *
 * This is the ONLY contract between the agent bridge and the frontend. Raw SDK
 * message shapes must not leak past `agent-bridge.ts`.
 */

import type { ProjectSettings, Provider } from './registry.ts';
import type { ProviderError, RuntimeCapabilities } from './runtime/runtime.ts';
import type { RunningSnapshot } from './running-set.ts';

export type Isolation = 'direct' | 'container' | 'sandbox';

/** The settings fields a single session may override. Mirrors validate.ts. */
export type SessionOverridable =
  | 'provider'
  | 'model'
  | 'effort'
  | 'permissionMode'
  | 'maxBudgetUsd'
  | 'allowedTools'
  | 'disallowedTools';

/**
 * What a live session is ACTUALLY running with, after per-session overrides.
 * Reported so the UI can show what applied instead of what was requested.
 */
export interface EffectiveConfig {
  projectId: string;
  isolation: Isolation;
  /** FEAT-037 P3 — the RESOLVED engine this session runs on (never absent). */
  provider: Provider;
  /**
   * FEAT-037 P3 — the runtime's honest capability descriptor. The UI grays
   * out features the engine lacks (plan mode, cost budget, subagent panel)
   * from THESE flags, never from a hardcoded provider check.
   */
  capabilities: RuntimeCapabilities;
  /** Resolved value of every overridable field. */
  effective: Pick<ProjectSettings, SessionOverridable>;
  /** The project's stored value, for side-by-side display. */
  projectDefault: Pick<ProjectSettings, SessionOverridable>;
  /** Fields where an override actually changed the value. */
  overridden: SessionOverridable[];
  /**
   * Overrides accepted by validation but not honourable in this isolation mode.
   * Empty in practice today — see the note in agent-bridge.ts.
   */
  ignoredOverrides: { field: string; value: unknown; reason: string }[];
  /**
   * Where `effective.permissionMode` came from:
   *  - 'session-override'  — a per-session override set it
   *  - 'container-default' — isolation is `container` and nothing set it, so it
   *                          defaulted to bypassPermissions (the UI should label
   *                          it e.g. "skip approvals — container default")
   *  - 'project'           — the project's stored setting (or the plain default)
   *  - 'live-change'       — a `set-permission-mode` command changed it AFTER
   *                          the session started, and the CLI accepted it
   */
  permissionModeSource: 'session-override' | 'container-default' | 'project' | 'live-change';
  /**
   * A live permission-mode change the engine ACCEPTED but that is not in force
   * yet: made mid-turn on an engine with no mid-turn switch (Codex), it governs
   * from the NEXT turn. Present only during that window; `effective.permissionMode`
   * still reflects the mode the RUNNING turn actually uses (which keeps prompting).
   * The UI paints the toggle as armed-for-next-turn rather than claiming skip is
   * already in force. Absent (undefined) whenever nothing is pending.
   */
  permissionModePendingNextTurn?: string;
  instructionMode: 'none' | 'append' | 'replace';
  appliedTemplates: string[];
}

/** A subagent currently running inside a turn — powers the live agent strip. */
export interface LiveAgent {
  /** task_id from the SDK (stable for the agent's lifetime). */
  agentId: string;
  /** tool_use_id of the Task call, i.e. the `parent_tool_use_id` its inner messages carry. */
  toolUseId: string | null;
  agentType: string;
  description: string;
  /**
   * BUG-030: what this row IS. 'agent' = a real subagent (Task tool /
   * task_type "local_agent"). 'tool' = a single tool call the CLI surfaces as
   * its own task (e.g. task_type "local_bash" — a subagent's or background
   * Bash call). The client keeps 'tool' rows out of the "N agents ran"
   * transcript stack and settles them silently. Optional so events from an
   * older server (no field) default to 'agent'.
   */
  kind?: 'agent' | 'tool';
  /*
   * ARCH-003 — there is deliberately NO `owner` field here. A lane's owner used to
   * be stamped on at `task_started` and trusted at the turn-end sweep; a derived
   * value written at one moment and read at another is exactly what carried a stale
   * owner onto an unrelated task (and what made a lane announced before its
   * parentage frame decide wrongly). The sweep resolves ownership from the OPEN TOOL
   * CALLS at the instant it needs it — see `open-tool-calls.ts`.
   */
  status: 'running' | 'completed' | 'failed' | 'killed';
  lastTool: string | null;
  totalTokens: number;
  toolUses: number;
  elapsedMs: number;
  startedAt: number;
  /**
   * BUG-046 — SERVER clock of the last frame the engine emitted ABOUT this row
   * (task_started/task_progress/task_updated). The stall detector's evidence
   * clock: flat past the window with no live process signal → the row is marked
   * ⚠ stalled (advisory; never removed, never recorded as a death). Optional so
   * events from an older server (no field) simply carry no stall evidence.
   */
  lastProgressAt?: number;
}

/**
 * One option of an `AskUserQuestion` question, as the SDK's tool schema defines
 * it (`AskUserQuestionInput`). Carried through structurally — never flattened to
 * a display string — so the UI renders the real choice, not a paraphrase.
 */
export interface QuestionOption {
  label: string;
  description: string;
  /** Optional HTML fragment the model attached to preview this option. */
  preview?: string;
}

export interface QuestionSpec {
  question: string;
  /** Short chip label (<= 12 chars by the tool's own schema). */
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

/**
 * One question's answer, as the UI collects it.
 *
 * `question` is the MATCH KEY: the CLI keys its answers record by the exact
 * question text, so an answer whose `question` does not appear in the pending
 * request is refused rather than guessed at.
 */
export interface QuestionAnswer {
  question: string;
  header?: string;
  /** Chosen option labels. More than one only makes sense when multiSelect. */
  selected: string[];
  /** Free text the user typed instead of / alongside an option ("Other"). */
  other?: string | null;
}

export type StationEvent =
  /** Session is live. Carries the real SDK session_id, which is what resume/fork need. */
  | { t: 'session-init'; sessionId: string; cwd: string; model: string; tools: string[]; permissionMode?: string; slashCommands?: string[] }
  /**
   * Emitted once, before the first SDK message: what this session is really
   * running with. `overridden` is the authoritative answer to "did my session
   * override apply?" — the drawer's `overridden` tags can be reconciled against it.
   */
  | ({ t: 'effective-config' } & EffectiveConfig)
  /** Complete assistant text block. `agentId` null = main thread. */
  | { t: 'text'; text: string; agentId: string | null; agentType?: string }
  /** Streaming delta. ALWAYS main-thread: stream_event.parent_tool_use_id is always null. */
  | { t: 'text-delta'; text: string }
  /** Thinking has no readable text — only an estimated token count. */
  | { t: 'thinking-tokens'; tokens: number; agentId: string | null }
  | { t: 'tool-call'; toolUseId: string; name: string; input: unknown; agentId: string | null; agentType?: string }
  | { t: 'tool-result'; toolUseId: string; isError: boolean; preview: string; agentId: string | null }
  | { t: 'tool-progress'; toolUseId: string; name: string; elapsedSeconds: number; agentId: string | null }
  | { t: 'agent-started'; agent: LiveAgent }
  | { t: 'agent-progress'; agent: LiveAgent }
  | { t: 'agent-completed'; agent: LiveAgent }
  /**
   * ARCH-001 phase 2 / BUG-034 — THE SERVER'S ANSWER to "what is running right
   * now", pushed whenever that answer CHANGES and available on demand from
   * `GET /api/sessions/:id/running`.
   *
   * This is a SNAPSHOT, not a delta: it names everything running, so a client
   * that receives one can render the whole strip from it and must not union it
   * with anything it accumulated. An empty `running` is a real answer — it is
   * what corrects (and empties) a tab holding rows the server does not believe
   * in, with no page reload. The `agent-*` events above still flow and still
   * drive threads / "ran" rows; they no longer decide what is ALIVE.
   */
  | { t: 'running-snapshot'; snapshot: RunningSnapshot }
  | { t: 'status'; status: string }
  | { t: 'compact-boundary'; trigger?: string }
  /** canUseTool surfaced for the UI to answer. Reply with {type:'approval-response'}. */
  | { t: 'approval-request'; requestId: string; toolName: string; input: unknown; title?: string; description?: string; agentId: string | null }
  /**
   * Claude called `AskUserQuestion` and is BLOCKED until an answer arrives.
   *
   * Mechanism (established by reading the SDK/CLI and by running it — see the
   * long note on `#onCanUseTool` in agent-bridge.ts): `AskUserQuestion` is an
   * ordinary tool whose permission request carries the question, and the answer
   * travels back as the permission result's `updatedInput.answers`. So this is
   * the SAME control-protocol request as `approval-request` — the bridge splits
   * it out because allowing it without answers is not "approved", it is
   * "the user did not answer the questions", which is what the model then sees.
   *
   * `requestId` is the answer key (reply `{type:'question-response'}`);
   * `toolUseId` is the same id the `tool-call` event carried, so a card already
   * drawn from the tool call can be upgraded in place rather than duplicated.
   * `input` is the raw tool input, kept alongside the typed `questions` so a
   * future field is not silently dropped by this bridge.
   */
  | {
      t: 'question-request';
      requestId: string;
      toolUseId: string;
      questions: QuestionSpec[];
      input: unknown;
      agentId: string | null;
    }
  /**
   * Claude called `ExitPlanMode` and is BLOCKED until approve/reject.
   * Same channel as `question-request` — see that comment. Approving also flips
   * the session out of plan mode, which arrives separately as `permission-mode`.
   */
  | {
      t: 'plan-request';
      requestId: string;
      toolUseId: string;
      plan: string;
      input: unknown;
      agentId: string | null;
    }
  /**
   * The session's permission mode CHANGED, confirmed by the CLI.
   *
   * `source: 'client'` — a `set-permission-mode` command was accepted.
   * `source: 'agent'`  — the CLI changed it on its own; in practice this is a
   *                      plan approval dropping `plan` back to `default`.
   * Never emitted for a change that was requested and refused.
   */
  | { t: 'permission-mode'; mode: string; source: 'client' | 'agent' }
  | { t: 'permission-denied'; toolName: string; reason?: string }
  /**
   * FEAT-065 — a `start` whose prompt was DELIVERED into a drain-held
   * restart survivor (acked with `deliveredVia:'survivor'`) later reports the
   * injected turn's end here. The client's socket stayed open only as the
   * approval relay for that turn; on `turn-done` it closes the relay
   * deliberately (a routine close, not a drop) and the drain-wait retry loop
   * resumes for anything still queued. The turn's output itself arrives by
   * transcript file-follow (`session-appended`), never on this socket.
   */
  | { t: 'survivor-delivery'; phase: 'turn-done'; sessionId: string; note?: string }
  | {
      t: 'turn-end';
      subtype: string;
      /**
       * True when WE called interrupt(). The SDK reports an interrupt as
       * `error_during_execution`, indistinguishable from a real failure, so the
       * bridge tracks the interrupt itself rather than inferring it.
       */
      interrupted: boolean;
      isError: boolean;
      durationMs?: number;
      costUsd?: number;
      numTurns?: number;
      resultText?: string;
      /**
       * BUG-031: the engine's stated reason the turn terminated, when it gave
       * one (Claude: result.terminal_reason — an API-error turn reports
       * subtype 'success' with terminal_reason 'api_error', so a client that
       * labels error turns by `subtype` alone would literally print "success").
       */
      terminalReason?: string;
    }
  | { t: 'rate-limit'; status: string; rateLimitType?: string; utilization?: number; resetsAt?: number }
  /**
   * BUG-031 — a provider/API failure, normalized by the RUNTIME into the
   * provider-agnostic taxonomy (see runtime.ts `ProviderError`): kind ∈
   * overloaded | rate-limited | quota-window | auth-expired | network |
   * model-unavailable | internal, with the provider's own detail text
   * verbatim. `retrying` present = the engine is retrying it itself and the
   * turn is STILL ALIVE (busy stays true); absent = terminal for the turn —
   * a `turn-end` (or fatal error) follows, so the composer always resolves.
   * The UI must render this attributed (provider + kind + detail), never as
   * generic noise, with a retry affordance when `retryable`.
   */
  | ({ t: 'provider-error' } & ProviderError)
  /**
   * FEAT-042 — the wire model id that ACTUALLY produced a main-thread assistant
   * message (`message.model` on the SDK assistant frame), emitted only when it
   * differs from the last one observed. This is the per-turn ground truth the
   * always-visible model chip tracks: the provider can swap the model without
   * any user action, and the first assistant message the new model produces is
   * the earliest per-turn evidence. Subagent messages are deliberately excluded
   * — subagents legitimately run different models than the main thread.
   * Detection boundary: a switch is only visible here once the new model
   * SPEAKS on the main thread; a turn producing no main-thread assistant
   * message cannot be caught by this signal (see `model-changed` for the one
   * dedicated push signal that exists).
   */
  | { t: 'model-observed'; model: string }
  /**
   * FEAT-042 — the CLI's DEDICATED model-switch notification: the model ended
   * the stream with stop_reason "refusal" and the CLI retried on a fallback
   * model, making the swap persistent for the session
   * (SDK `system/model_refusal_fallback`). This is exactly the "provider
   * auto-switched on a safeguard and I might miss it" case the model chip
   * exists to catch, so the UI must flag it loudly, not merely repaint.
   */
  | { t: 'model-changed'; from: string; to: string; reason: 'refusal-fallback'; category?: string | null }
  /**
   * `budgetStopped: true` marks the ONE error that means "this session can
   * never send again" without being `fatal` (the session itself is still
   * alive — read-only, not closed). `fatal` covers "the turn/session died";
   * this covers "the session refuses all future turns on purpose". A client
   * must latch a composer lock on this flag, not parse `message` text, and
   * must NOT clear that lock on the next unrelated `error` — see BUG-013.
   *
   * `retryable: true` marks an error the client can recover from by simply
   * retrying — it accompanies a PRE-TURN refusal (the turn never began), e.g.
   * the BUG-022 survivor-drain guard. The client keeps the typed message and
   * re-arms the next send rather than losing it — see BUG-029.
   */
  /*
   * `drain` (FEAT-064) rides on the retryable survivor-drain refusal: what the
   * broker's own heartbeats say is HOLDING the drain — background task count +
   * ids, when the hold began and its server-computed elapsed — so the client's
   * drain-wait chip can name the reason instead of a bare "try again".
   */
  | { t: 'error'; message: string; fatal: boolean; budgetStopped?: boolean; retryable?: boolean;
      /**
       * BUG-090 — the resume was refused ONLY because the session lives under a
       * different (pre-isolation) encoded-cwd store dir than this project now
       * resolves to (e.g. a session recorded before the container was enabled).
       * Forking recovers it: this carries the machine-readable inputs the client
       * needs to offer a one-click fork (`fork:true` + `resumeEncodedDir`) —
       * `message` stays a readable fallback for a client that ignores this field.
       * `cause` lets the UI choose plain, context-aware copy (container vs
       * cross-OS) instead of a hard-coded label.
       */
      // BUG-138 adds 'path-changed': the project's directory was renamed, so
      // this session is recorded against the path it had before.
      needsFork?: { resumeSessionId: string; resumeEncodedDir: string; cause: 'isolation-changed' | 'cross-os' | 'path-changed' };
      drain?: { backgroundLive: number; backgroundTaskIds: string[];
        backgroundLifetime: 'yes' | 'unknown' | 'no' | null;
        drainHeldSince: string | null; heldForMs: number | null; brokerState: string };
      /**
       * BUG-149 — a machine-readable name for a refusal whose `fatal` flag does
       * NOT mean "this session is dead". `message` stays the readable fallback.
       *
       * 'live-elsewhere': another socket is already driving this session. The
       * session is perfectly healthy; it is simply not available to THIS client
       * right now (see the guard in index.ts for why one driver at a time is
       * structural). A client that understands this code must keep the user's
       * typed text instead of treating the refusal as a dead end — that loss is
       * the bug this code exists to end.
       *
       * 'nothing-to-reattach' (BUG-160): a PROMPTLESS resume (reattachDriving)
       * found no surviving bridge to re-take. Not a dead end for any typed text
       * — the reattach carried none — so the client rolls the socket back quietly
       * and leaves the restored queue for the "To composer" affordance.
       */
      code?: 'live-elsewhere' | 'nothing-to-reattach' }
  /**
   * A `send` carried `targetAgentId`, and the Agent SDK has no channel for it.
   *
   * Verified exhaustively against @anthropic-ai/claude-agent-sdk: the `Query`
   * interface's 27 members contain no send-to-task method, the 40 control-request
   * subtypes include only `stop_task` (by task_id) and `background_tasks` (by
   * tool_use_id) as inbound task operations — neither carries a message — and
   * `SDKUserMessage` has no agent-targeting field (`subagent_type` /
   * `task_description` are outbound provenance). Messages pushed via streamInput
   * always land on the main thread's input queue.
   *
   * Distinct from `error` so the UI can switch straight to its read-only state
   * instead of parsing a message string.
   */
  | { t: 'subagent-send-unsupported'; targetAgentId: string; agentStatus: string | null; reason: string }
  /**
   * New messages appended to a session file by a process the dashboard did NOT
   * spawn (a session running in another terminal).
   *
   * PERSISTED MESSAGES, not token deltas — deltas exist only inside the process
   * driving the model and cannot be recovered from disk. `messages` is in the
   * same shape the transcript route returns, so the UI appends them with its
   * existing renderer. `sessionId` + `dir` identify the source so a client can
   * ignore appends for a session it is not currently viewing.
   *
   * `resynced:true` means the file shrank (truncated/rotated) and the cursor
   * restarted: refetch rather than append, or the transcript will be spliced.
   */
  | { t: 'session-appended'; sessionId: string; dir: string; messages: unknown[]; bytesRead: number; fileBytes: number; resynced: boolean }
  /** Answer to `follow` / `unfollow`. `live` reflects mtime recency at that instant. */
  | { t: 'follow-status'; sessionId: string; dir: string; following: boolean; live: boolean; reason?: string }
  /** Bridge lifecycle, not an SDK message. */
  | { t: 'session-closed'; reason: string };

/** Messages the UI sends up the socket. */
export type ClientCommand =
  | {
      type: 'start';
      projectId: string;
      prompt: string;
      resumeSessionId?: string;
      fork?: boolean;
      templateIds?: string[];
      /**
       * The store dir `resumeSessionId` was listed from (SessionMeta.encodedDir).
       * Required to fork a session recorded under a DIFFERENT encoded dir than
       * this project's cwd implies — i.e. every Windows-origin session on a
       * dual-boot machine. Omitting it falls back to a scan that refuses to
       * guess between store dirs whose copies differ.
       */
      resumeEncodedDir?: string;
      /**
       * Per-session settings overrides. Applied to THIS session only and never
       * written to the registry. Same validation dialect as the registry PATCH;
       * an invalid or project-scope-only field fails the start loudly.
       */
      overrides?: Partial<Pick<ProjectSettings, SessionOverridable>>;
    }
  | {
      type: 'send';
      prompt: string;
      /**
       * Route this turn to a specific running subagent.
       *
       * NOT SUPPORTED, and deliberately not faked — see the note on
       * `subagent-send-unsupported` below. When present the server answers with
       * that error and sends nothing; the turn does NOT silently land on the
       * main thread, which would be worse than refusing.
       */
      targetAgentId?: string;
    }
  | { type: 'interrupt' }
  | { type: 'approval-response'; requestId: string; allow: boolean; message?: string }
  /**
   * Answer a `question-request`. Matched by `requestId`, never by arrival order
   * — two questions can be in flight at once, and the app already learned this
   * lesson with approvals.
   *
   * `answers` may be empty (or omit questions): that is the explicit "I am not
   * answering, carry on" path, which resolves the tool with no answers so the
   * model proceeds exactly as it does today. It is distinguishable from a real
   * answer at the ack (`answered:false`).
   */
  | { type: 'question-response'; requestId: string; answers?: QuestionAnswer[] }
  /** Approve or reject a `plan-request`. */
  | { type: 'plan-response'; requestId: string; approved: boolean; message?: string }
  /**
   * Change the permission mode of the ALREADY RUNNING session.
   *
   * Distinct from `start.overrides`, which only affects a session not yet
   * started. `requestId` is client-generated and echoed on the ack so a slow
   * confirmation cannot be mistaken for a later one.
   */
  | { type: 'set-permission-mode'; requestId?: string; mode: string }
  /**
   * Switch the model of the ALREADY RUNNING session (the SDK's live
   * `Query.setModel`). `model:null` clears back to the default. Distinct from
   * `start.overrides.model`, which only affects a session not yet started.
   * `requestId` is echoed on the ack so a slow confirmation is unambiguous.
   */
  | { type: 'set-model'; requestId?: string; model: string | null }
  /**
   * Follow a session file the dashboard did not spawn. Sent when the user opens
   * a session; the server watches from the file's CURRENT end, so it never
   * re-sends what the client just fetched.
   *
   * A session the dashboard IS driving is refused (`following:false` with a
   * reason): its WebSocket bridge is already the source of truth and watching
   * the file too would double-emit every message.
   */
  | { type: 'follow'; sessionId: string; dir: string }
  | { type: 'unfollow'; sessionId?: string; dir?: string }
  | { type: 'close' };
