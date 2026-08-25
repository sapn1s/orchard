/**
 * Agent bridge: the runtime-agnostic session shell. It owns lifecycle, event
 * fan-out to sockets (the typed `StationEvent` union), budget accounting,
 * live-agent tracking, approvals and isolation/board orchestration — and drives
 * an `AgentRuntime` for the actual model execution. The vendor SDK is no longer
 * touched here; it lives behind `ClaudeRuntime` (runtime/claude-runtime.ts), the
 * one seam (FEAT-037 P1). Nothing above this file may see a raw runtime message.
 *
 * DEEPER, NON-runtime coupling stays as-is (out of P1 scope): detach/reattach,
 * transcript, fork, resume and rename are built on Claude's `.jsonl` store
 * (jsonl.ts / transcript.ts / watcher.ts / fork.ts / session-mutations.ts), not
 * on the runtime object — the plan flags that store format as the real risk.
 *
 * Auth: OAuth only. The runtime reads ~/.claude/.credentials.json. There is
 * deliberately no API-key path anywhere in this project.
 */
import type {
  AgentRuntime,
  ApprovalResult,
  RuntimeApprovalMeta,
  RuntimeMessage,
  RuntimeSpawnFn,
} from './runtime/runtime.ts';
import type { RuntimeCapabilities, WorkLifetime } from './runtime/runtime.ts';
import { ClaudeRuntime } from './runtime/claude-runtime.ts';
import { CodexRuntime, detectCodex } from './runtime/codex-runtime.ts';
import type {
  EffectiveConfig,
  LiveAgent,
  QuestionAnswer,
  QuestionSpec,
  SessionOverridable,
  StationEvent,
} from './events.ts';
import type { Project } from './registry.ts';
import { composeInstructions, appendToSystemPrompt, type ComposedPrompt } from './templates.ts';
import { boardStateSection, boardAnswerBriefing, answeredAwaitingKeys } from './board.ts';
import { OpenToolCalls } from './open-tool-calls.ts';
import type { InstructionRef, ProjectSettings } from './registry.ts';
import { browserSettingsOf, responseDigestOf, toolSettingsOf } from './registry.ts';
import * as browser from './browser.ts';
import { MCP_SERVER_NAME } from './browser.ts';
import * as dispatchBroker from './dispatch-broker.ts';
import { plannedMcpServers } from './tools.ts';
import { SESSION_OVERRIDE_FIELDS, type SessionOverrides } from './validate.ts';
import { discardStaged, explainUnresumable, planFork, type ForkPlan } from './fork.ts';
import * as snapshots from './snapshots.ts';
import {
  CONTAINER_CLAUDE_BIN,
  ContainerError,
  containerName,
  containerWorkdir,
  ensureContainer,
  execInContainer,
  memoryStatus,
  oomExplanation,
  reapExec,
  type MemoryStatus,
} from './container-manager.ts';
import { spawnSurvivable, survivalEnabled, type SurvivalHandle, type SurvivalProbe } from './survival.ts';
/*
 * ARCH-001: the bridge no longer decides its own liveness. It supplies the
 * FACTS (busy, lastFrameAt, its process probe) and the one authority returns
 * the verdict — the same authority the survivor site and the health route use,
 * so they cannot answer differently.
 */
import { livenessOfBridge, REAP_SWEEP_MS, type EndProviderError, type Liveness } from './liveness.ts';
/*
 * ARCH-001 phase 2 (BUG-034) + FEAT-057: the bridge PUBLISHES what is running
 * and RECORDS what died, into one structure. It builds neither answer itself —
 * `running-set.ts` arranges the authority's verdict, `outcomes.ts` persists the
 * deaths — so no new opinion about liveness is created here.
 */
import { snapshotOfSession, type RunningSnapshot } from './running-set.ts';
import * as outcomes from './outcomes.ts';
import { TranscriptRecorder, resolveOrchardSessionFile } from './orchard-transcripts.ts';
import { encodeCwd } from '../lib/session-history.ts';

/* ---------------------------------------------------------- slash commands */
/*
 * The CLI only names its slash commands in a session's init message — but the
 * composer wants to offer them BEFORE the first session of a fresh browser.
 * The last-seen list is close to global truth (builtins + the user's skills),
 * so it is kept server-side and persisted across restarts.
 */

import { dataDir } from '../lib/paths.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

let lastSlashCommands: string[] = [];
const slashFile = () => path.join(dataDir(), 'slash-commands.json');
try {
  const arr = JSON.parse(fs.readFileSync(slashFile(), 'utf8'));
  if (Array.isArray(arr)) lastSlashCommands = arr.map(String);
} catch { /* first run — empty until a session inits */ }

export function knownSlashCommands(): string[] {
  return lastSlashCommands;
}

function rememberSlashCommands(cmds: string[]): void {
  if (!cmds.length) return;
  lastSlashCommands = cmds;
  try { fs.writeFileSync(slashFile(), JSON.stringify(cmds)); } catch { /* volatile is fine */ }
}

/*
 * Same treatment for models: the SDK's supportedModels() carries the CLI's
 * own display names and descriptions ("Opus 5 (1M context)" — versions
 * included), which is truth the UI must not hardcode: a hardcoded "Opus"
 * cannot say WHICH Opus, and goes stale the day the CLI updates.
 */
export interface KnownModel {
  value: string;
  /** Canonical wire model id this row's `value` resolves to (e.g. 'sonnet' -> 'claude-sonnet-5'). */
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
}

/*
 * FEAT-045: the catalog is remembered PER PROVIDER. A single global list let a
 * Codex session's `model/list` overwrite the Claude catalog (and vice versa) —
 * the picker then offered gpt-* rows to a Claude session. `models.json` keeps
 * its pre-045 name/shape so an existing Claude cache carries over untouched;
 * other providers get their own `models-<provider>.json`.
 */
const lastModelsByProvider = new Map<string, KnownModel[]>();
const modelsFile = (provider: string) =>
  path.join(dataDir(), provider === 'anthropic' ? 'models.json' : `models-${provider}.json`);
for (const provider of ['anthropic', 'openai']) {
  try {
    const arr = JSON.parse(fs.readFileSync(modelsFile(provider), 'utf8'));
    if (Array.isArray(arr)) lastModelsByProvider.set(provider, arr);
  } catch { /* first run */ }
}

export function knownModels(provider = 'anthropic'): KnownModel[] {
  return lastModelsByProvider.get(provider) ?? [];
}

function rememberModels(provider: string, models: KnownModel[]): void {
  if (!models.length) return;
  lastModelsByProvider.set(provider, models);
  try { fs.writeFileSync(modelsFile(provider), JSON.stringify(models)); } catch { /* volatile is fine */ }
}

export interface StartOptions {
  project: Project;
  firstPrompt: string;
  /** Resume an existing session id (works for sessions started in the plain CLI). */
  resumeSessionId?: string;
  /** With resumeSessionId: branch into a new session instead of continuing. */
  fork?: boolean;
  /** Store dir `resumeSessionId` came from. See fork.ts — needed for cross-OS forks. */
  resumeEncodedDir?: string;
  /** Overrides the project's instruction stack for this session only. */
  instructions?: InstructionRef[];
  /**
   * Per-session settings overrides. Already validated by validate.ts. Applied to
   * this session only; nothing here is ever written back to the registry.
   */
  overrides?: Partial<SessionOverrides>;
  /** Extra system-prompt text appended after the composed templates (used by tests). */
  extraAppend?: string;
  onEvent: (e: StationEvent) => void;
  /** Filled in by startSession(); callers never set this. */
  forkPlan?: ForkPlan;
  /** Filled in by startSession(); callers never set this. */
  dispatchUnavailableReason?: string;
}

type Overridable = Pick<ProjectSettings, SessionOverridable>;

export function dispatchAvailabilityNote(enabled: boolean, route: string, unavailableReason?: string): string {
  if (!enabled) return '\n\n## OpenAI dispatch availability\nOpenAI dispatch is NOT enabled for this project. Enable Settings › Tools › OpenAI dispatch (`settings.tools.openaiDispatch`) and launch a new session.';
  if (unavailableReason) return `\n\n## OpenAI dispatch availability\nOpenAI dispatch is enabled for this project but currently UNAVAILABLE: ${unavailableReason}. Check it with \`${route} --check\`; it will exit nonzero with the same reason.`;
  return `\n\n## OpenAI dispatch availability\nOpenAI dispatch is enabled for this session. Check it with \`${route} --check\`; dispatch with the same command plus \`--provider openai ...\`.`;
}

function pickOverridable(s: ProjectSettings): Overridable {
  return {
    // FEAT-037 P3: resolved, never absent — registries written before the
    // field existed must read as the default engine.
    provider: s.provider ?? 'anthropic',
    model: s.model,
    effort: s.effort,
    permissionMode: s.permissionMode,
    maxBudgetUsd: s.maxBudgetUsd,
    allowedTools: s.allowedTools,
    disallowedTools: s.disallowedTools,
  };
}

/**
 * What a pending permission request IS, so an answer of the wrong shape cannot
 * settle it. `question` and `plan` ride the same control-protocol request as
 * `approval`, but "allow" means something completely different for each:
 * for a question, a bare allow is the no-answer path.
 */
type PendingKind = 'approval' | 'question' | 'plan';

interface PendingApproval {
  kind: PendingKind;
  resolve: (r: ApprovalResult) => void;
  toolName: string;
  toolUseId: string;
  /** The tool input as offered. An allow MUST echo it back — see answerApproval. */
  input: Record<string, unknown>;
  /**
   * The EXACT request event this pending was announced with. Retained so a
   * socket re-attaching mid-turn (page reload while a card is open) can be
   * shown the still-open request again — see replayPending(). Re-emitting is
   * safe: the card carries the same requestId, and answering deletes the entry
   * and settles the promise once (BUG-008).
   */
  event: StationEvent;
}

/** The tools whose "permission" prompt is really a question to the human. */
const QUESTION_TOOL = 'AskUserQuestion';
const PLAN_TOOL = 'ExitPlanMode';

/** Modes this app will ask a live session to switch to. Mirrors validate.ts. */
const LIVE_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);

/**
 * Normalise `AskUserQuestionInput` into the typed shape the UI renders.
 *
 * Tolerant on purpose: the raw input still travels on the event, so anything
 * this drops is recoverable, but a malformed question must never render as an
 * empty card. Returns [] when there is nothing renderable, which the caller
 * treats as "not a question after all" and falls back to a plain approval.
 */
export function parseQuestionInput(input: unknown): QuestionSpec[] {
  const raw = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(raw)) return [];
  const out: QuestionSpec[] = [];
  for (const q of raw as Record<string, unknown>[]) {
    if (!q || typeof q !== 'object') continue;
    const options: QuestionSpec['options'] = [];
    for (const o of (Array.isArray(q.options) ? q.options : []) as Record<string, unknown>[]) {
      const label = typeof o?.label === 'string' ? o.label : '';
      if (!label) continue;
      options.push({
        label,
        description: typeof o.description === 'string' ? o.description : '',
        ...(typeof o.preview === 'string' ? { preview: o.preview } : {}),
      });
    }
    const question = typeof q.question === 'string' ? q.question : '';
    if (!question && !options.length) continue;
    out.push({
      question,
      header: typeof q.header === 'string' ? q.header : '',
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return out;
}

/** `ExitPlanMode`'s plan markdown. '' when there is none. */
export function parsePlanInput(input: unknown): string {
  const p = (input as { plan?: unknown })?.plan;
  return typeof p === 'string' ? p : '';
}

/**
 * Collapse the UI's per-question answer into the ONE string the CLI expects.
 *
 * The CLI's AskUserQuestion input schema types `answers` as
 * `Record<questionText, string>`, with a preprocess step that joins a string
 * array with ", ". We join here instead of relying on that, so the value the
 * model sees is the value we chose. Free text is appended after the selected
 * labels (and also preserved as an annotation note), matching what the CLI's own
 * TUI does when the user types instead of picking.
 */
function answerValue(a: QuestionAnswer): string {
  const parts = (a.selected ?? []).filter((s) => typeof s === 'string' && s.trim().length);
  const other = typeof a.other === 'string' ? a.other.trim() : '';
  if (other) parts.push(other);
  return parts.join(', ');
}

/**
 * FEAT-022 — autonomous mode. An EXPLICITLY chosen keep-going-until-a-stop-
 * condition loop (research sweeps, long backlogs), distinct from the interactive
 * NEEDS-YOU default (WA §M). It is NEVER on unless the user turns it on, and it
 * MUST carry a bounded stop condition — there is no unbounded variant.
 *
 * The ONLY stop condition built here is "stop after N auto-continued turns"
 * (plus the always-present manual Stop, and the natural stops: budget, a user
 * interrupt, a detach, or a closed session). "Until the board/backlog is empty"
 * is a deliberate PRODUCT DECISION left unbuilt — see the ticket's flagged
 * decisions — because the server has no in-scope, unambiguous read of "empty".
 */
export interface AutonomousState {
  autonomous: boolean;
  /** The mandatory stop-after-N-turns budget; null only while interactive. */
  maxTurns: number | null;
  /** Auto-continued turns fired since autonomous was last enabled. */
  turnsDone: number;
  /** maxTurns - turnsDone, floored at 0; null while interactive. */
  remaining: number | null;
  /** Why autonomous last ended, for an auditable trail. */
  stopReason: AutonomousStopReason | null;
}
export type AutonomousStopReason =
  | 'turns-reached'   // hit the declared budget — the normal, expected halt
  | 'manual'          // the user pressed Stop / posted {action:'stop'}
  | 'budget'          // maxBudgetUsd stop outranks the loop (BUG-013)
  | 'interrupted'     // the user interrupted a turn — they took manual control
  | 'detached'        // no driver attached; hand back to close-on-detach
  | 'closed'          // the session closed
  | 'error';          // send() refused the continue (surfaced, not swallowed)

/**
 * Hard ceiling on the stop-after-N budget so a fat-fingered value cannot arm a
 * near-unbounded loop. The user picks any 1..this; there is no way past it.
 */
const AUTONOMOUS_MAX_TURNS_CEILING = 50;

/**
 * The continue-nudge sent to advance one autonomous turn. It re-states the §M
 * contract every turn (work only the agreed scope; do not invent new tasks) so
 * the boundary is in the transcript itself — the durable, auditable record of
 * every auto-continued turn (WA §H/§M).
 */
const AUTONOMOUS_NUDGE =
  'Continue autonomously with the next item in the ALREADY-AGREED scope. ' +
  'Do not pause for confirmation. Do NOT invent new tasks beyond that scope. ' +
  'If the agreed scope is complete, say so plainly and stop.';

export class AgentSession {
  readonly id: string;
  readonly project: Project;
  readonly composed: ComposedPrompt;
  /** Resolved settings this session actually runs with (project ∘ overrides). */
  /**
   * NOT readonly for `permissionMode`: `setPermissionMode()` changes it on a
   * running session, and `effectiveConfig()` must keep telling the truth
   * afterwards rather than reporting what the session started with.
   */
  readonly effective: Overridable;
  readonly overriddenFields: SessionOverridable[];
  readonly ignoredOverrides: { field: string; value: unknown; reason: string }[];
  /** Where the effective permissionMode came from — lets the UI label it. */
  permissionModeSource: 'session-override' | 'container-default' | 'project' | 'live-change';
  /** Staged transcript copy for a cross-OS fork; deleted once the fork owns a file. */
  #forkPlan: ForkPlan | null;
  /** The ORIGINAL session id a fork branched from (what the user clicked). */
  #forkFrom: string | null = null;
  #stagedFile: string | null = null;

  /** The model-execution engine. Constructed as a ClaudeRuntime; the only seam. */
  #runtime: AgentRuntime;
  /**
   * FEAT-037 P2b — Orchard-owned transcript capture. Non-null exactly when the
   * engine does NOT persist its own station-readable transcript
   * (`capabilities.persistedTranscript === false`): the bridge then appends
   * every user prompt + renderable runtime frame to
   * dataDir()/transcripts/<provider>/<encodedDir>/<sessionId>.jsonl, in the
   * same entry shape the Claude store uses, so history/paging/session lists
   * work unchanged. Null for ClaudeRuntime — the CLI writes its own store.
   */
  #recorder: TranscriptRecorder | null = null;
  #emit: (e: StationEvent) => void;
  #pump: Promise<void> | null = null;

  /**
   * FEAT-090 — answered-awaiting tickets already ANNOUNCED to this session, keyed
   * `<ticketId>@<answerDate>`. Seeded at launch with whatever the launch snapshot
   * already carried (so it is never re-stated), then grown as the open-session
   * briefing names each NEW answer once, riding the user's next message.
   */
  #answerBriefSeen = new Set<string>();

  /** Real SDK session id — the thing resume/fork need. Null until system:init. */
  sdkSessionId: string | null = null;
  cwd: string;
  /** Set only for isolation "container" — the container this session executes in. */
  containerName: string | null = null;
  /** True when the stealth-browser MCP server was attached to this session. */
  browserAttached = false;
  /**
   * The `session-start` snapshot taken for this session, if any. Null when
   * snapshots are disabled for the project OR when the snapshot failed — the
   * session runs either way, so this doubles as "does this session have a
   * restore point".
   */
  startSnapshotId: string | null = null;
  /**
   * Why there is (or is not) a restore point: 'taken' | 'deduped' | 'disabled' |
   * 'failed'. The UI MUST branch on this rather than on `startSnapshotId ===
   * null`, which cannot tell "turned off" from "broken".
   */
  startSnapshotStatus: snapshots.StartSnapshotStatus = 'disabled';
  /** Set when `startSnapshotStatus === 'failed'`. */
  startSnapshotError: string | null = null;
  busy = false;
  /**
   * BUG-033 — WHEN the in-flight turn actually started (epoch ms), or null when
   * no turn is running. Stamped exactly where `busy` becomes true and cleared
   * exactly where it becomes false, so it can never outlive its turn. Served to
   * the client (reattach ack, /api/sessions, /api/sessions/live) so a tab that
   * reattaches shows the REAL age of the turn instead of stamping "now" and
   * counting from when the TAB found out (the dishonest "1:08" in the report).
   * A client that gets `null` must render an honest unknown, never a timer.
   */
  turnStartedAt: number | null = null;
  /**
   * BUG-033 — when the last inbound runtime frame arrived (epoch ms). `busy` is
   * a claim; this is the evidence behind it. Stamped by #handle() on EVERY
   * frame, so it covers deltas, tool progress, subagent chatter — anything the
   * engine emits. Zero until the first frame of the session's first turn.
   */
  lastFrameAt = 0;
  /**
   * FEAT-057 — the last provider/API failure the RUNTIME classified for the
   * turn currently in flight (BUG-031's taxonomy, verbatim), or null. Cleared
   * at every turn start, so it can never attribute this turn's death to the
   * previous turn's outage. It is EVIDENCE, not a verdict: the authority reads
   * it to fill `ended.providerError`, and the outcome record quotes it — which
   * is how "3 agents stopped — usage limit, resets 13:40" can be shown without
   * the orchestrator ever running a turn.
   */
  lastProviderError: EndProviderError | null = null;
  /**
   * BUG-041 — an ADVISORY classification observed during this turn (BUG-035's
   * pending "MCP tool server still starting" notice). Deliberately NOT
   * `lastProviderError`: it is not terminal for the turn and must never be
   * named as a cause of death — it is quoted, marked as context, on records
   * whose real cause is unknown. Cleared with `lastProviderError` at turn start.
   */
  #advisoryNotice: string | null = null;
  /**
   * BUG-041 — task_ids whose Task tool_result ALREADY CAME BACK this turn: the
   * agent delivered its final report, which IS evidence of completion. The
   * turn-boundary sweep must not write a death for these even when the
   * engine's own terminal frame never arrived. Cleared after each sweep.
   */
  #resultDelivered = new Set<string>();
  /** True when the driving socket went away and the work carried on alone. */
  detached = false;
  closed = false;
  totalCostUsd = 0;
  budgetStopped = false;

  /**
   * FEAT-022 autonomous mode. Default OFF — a session is NEVER silently made
   * autonomous. `#autoMaxTurns` is the mandatory bounded stop condition; the
   * loop advances at most that many auto-continued turns and then halts.
   */
  autonomous = false;
  #autoMaxTurns: number | null = null;
  #autoTurnsDone = 0;
  #autoStopReason: AutonomousStopReason | null = null;

  /** task_id -> live agent. */
  #agents = new Map<string, LiveAgent>();
  /** Task tool_use_id -> task_id. Subagent inner messages carry the tool_use_id. */
  #toolUseToAgent = new Map<string, string>();
  /**
   * ARCH-003 — the SUBAGENT-ISSUED TOOL CALLS THAT ARE CURRENTLY OPEN.
   *
   * The turn-end sweep asks this, at the instant it needs the answer, who issued a
   * still-running `local_bash` lane's tool call: a live background agent (spare it —
   * its result is still coming) or the main thread (record its honest death). See
   * `open-tool-calls.ts` for why this is a mirror of open calls rather than the
   * side map of stored associations that produced three clean-room BROKEN verdicts.
   * Nothing here is stamped forward onto a lane and nothing consumes it, so there
   * is no derived field to go stale and no consumption order to get wrong.
   */
  #openToolCalls = new OpenToolCalls();
  /**
   * BUG-037 — task_ids the engine says are BACKGROUND tasks right now.
   *
   * Maintained from `background_tasks_changed`, the SDK's LEVEL signal ("every
   * live background task after the change", REPLACE semantics), and reset on
   * `init` because the level is per-CLI-process and nothing is emitted at
   * startup. It exists for exactly one decision: a background agent OUTLIVES
   * the turn that dispatched it BY DESIGN, so the `result` sweep must not
   * settle it or record an end for it. An empty set is the safe default — an
   * engine that never emits the signal gets the pre-BUG-037 behaviour.
   *
   * BUG-096 — the VALUE is the task's AGENT/TOOL kind, derived from the level
   * frame's own `task_type` (sdk.d.ts:2921 — every task carries it). The set was
   * ids-only; keeping the kind lets `#ownerIsLiveBackgroundAgent()` answer "is a
   * lane's owner a live background AGENT?" straight from this level mirror, for
   * the two shapes an `#agents` join can never see (a resume/re-attach agent the
   * level lists but no `task_started` row exists for, and a `skip_transcript`
   * task_started that returns before the row is created).
   */
  #backgroundTasks = new Map<string, 'agent' | 'tool'>();
  /**
   * BUG-043 (cross-provider review, finding 1) — the PRE-SIGNAL race guard.
   *
   * The engine's `background_tasks_changed` level frame LAGS the dispatching
   * turn's `result` (measured live: result at +14.9s, first level frame at
   * +19.2s — a ~4s window in which the set is empty while background work is
   * being born). A socket that drops inside that window must not read the empty
   * set as "no background work". So the bridge records the moment it SAW a
   * background dispatch go out — an assistant `tool_use` block whose input
   * carries `run_in_background: true` (Task agents and background Bash alike;
   * both kinds appear in the level) — and `workLifetime()` answers `unknown`
   * from then until either a level frame arrives (the level supersedes this
   * hint entirely) or a bounded window expires (the dispatch may have been
   * refused and produced no level at all — without the cap this would leak).
   */
  #bgDispatchAt: number | null = null;
  /**
   * BUG-068 — the tool_use ids of `run_in_background` dispatches SEEN this
   * session whose `task_started` has not yet been correlated. The engine's
   * `task_started` for the resulting lane carries the SAME `tool_use_id` as the
   * dispatching tool_use (probe-verified: a background Bash's task_started
   * echoes the Bash tool_use id), which is how a lane is known to be background
   * BY CONSTRUCTION — before the `background_tasks_changed` level ever lists it.
   * Consumed (deleted) by the matching `task_started`; cleared wholesale by any
   * level frame, which is authoritative from then on.
   */
  #bgDispatchToolUseIds = new Set<string>();
  /**
   * BUG-068 — task_ids KNOWN to be background lanes (their `task_started`
   * carried the tool_use_id of a `run_in_background` dispatch) but which the
   * engine's `background_tasks_changed` level has NOT YET listed. The turn-end
   * `result` sweep must not settle these: the level LAGS the dispatching turn's
   * `result` (BUG-043, ~4s), and in that window the sweep was fabricating
   * `unknown` deaths for still-running `local_bash` lanes and EVICTING their
   * running rows — the reported invisibility (incident 2026-08-11: 27 local_bash
   * ledger records, several the "still running … engine reported no outcome"
   * shape). Superseded by any level frame: a live background lane appears in the
   * authoritative level (REPLACE semantics), so this hint is cleared there and
   * `#backgroundTasks` carries the lane from then on. Belt-and-braces with
   * `#bgDispatchAt` (which guards the close decision on the same lag).
   *
   * BUG-096 — the VALUE is the lane's AGENT/TOOL kind (from its `task_started`),
   * so `#ownerIsLiveBackgroundAgent()` can tell a background Task subagent (a possible
   * PARENT of a foreground child bash) from a `run_in_background` Bash (a
   * sibling LEAF that must never suppress an orphan's honest death).
   */
  #bgBornTasks = new Map<string, 'agent' | 'tool'>();
  /**
   * BUG-105 (1st independent clean-room verdict) — TASKS THE ENGINE ITSELF SAID
   * ARE OVER: the task ids for which a TERMINAL FRAME was observed
   * (`task_updated` with a terminal status, or a `task_notification` that carried
   * one). POSITIVE evidence, and the strongest that will ever exist for a task —
   * the engine's own word about its own task.
   *
   * It exists because the two background sources above are LEVEL signals, and a
   * level is a SNAPSHOT that goes stale. The verdict's shape: a background owner
   * retires by emitting `task_updated completed`, the engine never withdraws its
   * `background_tasks_changed` entry, and every rule that reads membership as
   * liveness — the sparing rule, the reclamation predicate, the stall signal, the
   * work-lifetime answer — goes on believing the dead owner is working. Its
   * foreground subagent was spared at boundary after boundary: the owed death was
   * never reported and the lane sat running indefinitely.
   *
   * WHY THE INVARIANT AND NOT A GUARD AT EACH READER. Guarding
   * `#ownerIsLiveBackgroundAgent` alone would fix the one reader the verdict
   * happened to run and leave the same staleness in every other. So the fix is an
   * INVARIANT on the containers themselves, enforced at their only two write
   * sites (`#retireTask` on a terminal frame, and the level-frame rebuild, which
   * filters):
   *
   *     no id with observed terminal evidence is ever a member of
   *     `#backgroundTasks` or `#bgBornTasks`.
   *
   * That makes "a rule mistook stale level membership for liveness" UNREPRESENTABLE
   * for every present and future reader, rather than guarded at the ones we
   * remembered. What remains merely GUARDED is the converse direction — an owner
   * that is genuinely working is never removed from the level here, because only
   * its OWN terminal frame puts it in this set; the turn-end sweep's settle
   * (which can mark a genuinely-working lane terminal — the ARCH-003 6th verdict)
   * deliberately does NOT, so property (b) is not traded for property (a).
   *
   * Bounded by the number of tasks that ever ended in this session — the same
   * order as `#agents`, one small string each.
   *
   * BUG-105 (4th clean-room verdict) — THIS MAP IS *EVIDENCE*, NOT AN OUTCOME.
   * Membership means only "a terminal frame for this id was observed", which is
   * all the liveness invariant above needs and all a `.has()` reader gets. WHAT
   * the engine established (if anything) lives in `#establishedOutcomes`, because
   * the two are genuinely different questions: a teardown blanket is evidence the
   * task is over and NOT a verdict on how it ended. Keeping the verdict here as
   * well is what let a blanket be promoted into a death (see `#retireTask`). The
   * value is the FIRST status seen, kept only so a later disagreeing frame can be
   * recognised as a conflict.
   *
   * BUG-105 (5th clean-room verdict) — AND IT IS NO LONGER THE VETO EITHER. This
   * map is now a pure OBSERVATION LOG: append-only, never withdrawn, read only by
   * the conflict arithmetic. What the two liveness write sites consult is
   * `#retiredTasks`, which is the same evidence made WITHDRAWABLE — see there for
   * why an observation and a veto had to stop being the same object.
   */
  #terminallyReportedTasks = new Map<string, 'completed' | 'failed' | 'killed'>();
  /**
   * BUG-105 (5th independent clean-room verdict) — THE LIVENESS VETO: the ids that
   * may not be members of `#backgroundTasks` or `#bgBornTasks`. The 1st verdict's
   * invariant, unchanged in what it forbids and changed in ONE respect — IT CAN BE
   * WITHDRAWN.
   *
   * THE DEFECT AS FOUND. The veto used to be `#terminallyReportedTasks`, which
   * every terminal frame writes and nothing ever cleared. A `task_notification
   * status:"stopped"` — the SIGTERM blanket a dying CLI emits for EVERY still-open
   * task — arriving for a task this bridge had no row for therefore wrote a
   * PERMANENT veto for an id the engine had given no per-task verdict on. When the
   * engine then announced that same id as live background work, the level rebuild
   * filtered it out of every frame forever and the birth tag refused it: the task
   * was starved of the only liveness evidence the sparing rule reads, so the
   * turn-end sweep recorded still-running work as dead (measured: `reann:unknown`,
   * and its foreground subagent with it), and `workLifetime()` — which IS this map
   * — answered "no background task is running" for a detached session, which is the
   * answer `releaseSocketSession` CLOSES on, reaping the broker that holds the work.
   * The 4th-verdict fix removed the fabrication direction and left a session-wide
   * notice able to permanently veto a later real liveness signal.
   *
   * THE RULE, AND THE ASYMMETRY IT RESTS ON. A terminal frame is two different
   * kinds of thing, and the 4th verdict already separates them for establishing
   * outcomes; the same separation decides what may be withdrawn:
   *
   *     an ESTABLISHED PER-TASK OUTCOME is the engine's verdict about THIS task
   *     and is never withdrawn — a finished task stays finished, and no level
   *     frame, however fresh, resurrects it;
   *
   *     a veto with NO established outcome behind it was written by a frame that
   *     could not settle a row — in practice a session-wide blanket that was never
   *     about this task at all — and is withdrawn by the task's own
   *     `task_started`, which is positive engine evidence that the task is live
   *     NOW and is strictly newer than the blanket.
   *
   * WHAT THIS MAKES UNREPRESENTABLE: (1) a task with an engine-established outcome
   * regaining level membership or a birth tag — both sites read this one set, and
   * its only deletion is guarded by `#establishedOutcomes.has()`; (2) the ANSWER
   * DEPENDING ON FRAME ORDER — the level frame is kept RAW in `#levelRaw` and
   * `#backgroundTasks` is derived from (raw − veto) by `#rebuildBackgroundLevel()`,
   * recomputed whenever either input changes, so "the level arrived before the
   * announcement" and "after" cannot disagree.
   *
   * WHAT REMAINS MERELY GUARDED: a stream that re-announces a task that is really
   * dead and that the engine never gave a verdict on. Withdrawing the veto does not
   * grant that row immunity — it restores the ORDINARY rules, under which the row
   * is spared only while the engine's level actually lists it and is honestly
   * settled at the first boundary it does not. The cost is a deferral, never a lost
   * death; the cost of the veto standing was a fabricated one.
   */
  #retiredTasks = new Set<string>();
  /**
   * BUG-105 (5th clean-room verdict) — THE ENGINE'S LAST LEVEL FRAME, UNFILTERED.
   * `#backgroundTasks` is a DERIVED view of this (minus `#retiredTasks`), so a veto
   * withdrawn after the frame landed can re-admit the ids that frame declared. Same
   * REPLACE semantics and same bound as `#backgroundTasks` — one entry per task the
   * engine currently says is running.
   */
  #levelRaw = new Map<string, 'agent' | 'tool'>();
  /**
   * BUG-105 (2nd follow-up, the `b0dfaf6` REGRESSION; 3rd and 4th clean-room
   * verdicts) — THE OUTCOME A TERMINAL FRAME ESTABLISHED, held for the row this
   * bridge does not have yet.
   *
   * A terminal report is TWO facts — "this task is over" AND "this is how it
   * ended". The row-less path used to keep only the first: the handler retired the
   * task and returned on `if (!a) return`, dropping the status on the floor, so a
   * row built afterwards was `running`, nothing re-applied the report, and the
   * turn-end sweep settled a task that had POSITIVELY SAID IT FINISHED as an
   * `unknown` death. Hence: AN ESTABLISHED OUTCOME MARKS THE EVENTUAL ROW
   * TERMINAL, IN EITHER ORDER.
   *
   * WHAT MAY ENTER IT is not a second, parallel rule: an entry is written only when
   * `#terminalFrameSettles()` — the ONE predicate the row-present path itself is
   * expressed in — said this frame settles the row, evaluated against the row's
   * state AT THE INSTANT THE FRAME ARRIVED (`'absent'` when there is no row). A
   * frame that could not settle a row it can see therefore cannot settle one it
   * cannot see: it never reaches this map at all, so there is nothing here to keep
   * in sync with the row-present handler.
   *
   * WHICH ENTRY SURVIVES WHEN TWO SETTLING FRAMES DISAGREE is stated at
   * `#retireTask`: parity with the ledger the row-present path would have written.
   */
  #establishedOutcomes = new Map<string, 'completed' | 'failed' | 'killed'>();
  /**
   * BUG-105 (3rd clean-room verdict) — TASKS THE ENGINE GAVE TWO DIFFERENT
   * TERMINAL OUTCOMES FOR, in arrival order. A disagreement is not just a value
   * to resolve: one task ending twice, differently, is evidence something upstream
   * is wrong (a re-delivered stream stitched onto a live one, an id reused across
   * a resume, a teardown blanket landing on a task that already reported). Picking
   * a winner silently would throw that signal away, so it is kept and surfaced —
   * warned on the server, and quoted in the `detail` of whatever death is written
   * for the task, which is the text the orchestrator is actually briefed from.
   *
   * Only ever written on an anomaly, so bounded well below `#terminallyReportedTasks`.
   */
  #conflictingTerminalReports = new Map<string, ('completed' | 'failed' | 'killed')[]>();
  /** BUG-043 — the close-on-detach fuse timer (a re-checking loop, not one shot). */
  #detachedCloseTimer: ReturnType<typeof setTimeout> | null = null;
  #approvals = new Map<string, PendingApproval>();
  /**
   * True between interrupt() and the resulting `result` message. The SDK reports
   * an interrupted turn as `error_during_execution`, which is byte-identical to
   * a genuine failure — so we track our own call rather than guess.
   */
  #interruptRequested = false;
  /**
   * FEAT-042 — the last wire model id OBSERVED producing a main-thread
   * assistant message (`message.model`). Used only to dedupe `model-observed`
   * emissions; the provider can switch models without any user action, and the
   * per-turn field on the assistant frame is the ground truth that catches it.
   */
  #lastWireModel: string | null = null;
  /** Env tag identifying this session's exec inside the container. */
  #execId: string | null = null;
  /**
   * Restart survival (FEAT-015), for isolation "direct" only. `#survivalConfigured`
   * is set when the CLI is launched under a broker-in-a-scope so it outlives a
   * server restart; `#survivalHandle` is the reap handle, set once the SDK
   * actually invokes the spawn override. A genuine close() reaps the broker; a
   * server-shutdown HANDOFF deliberately does not (that is how the CLI survives).
   */
  #survivalConfigured = false;
  #survivalHandle: SurvivalHandle | null = null;
  /** cgroup oom_kill counter at session start — see container-manager memory. */
  #oomBaseline: number | null = null;
  #memTimer: ReturnType<typeof setInterval> | null = null;
  #memWarned = false;

  constructor(id: string, opts: StartOptions) {
    this.id = id;
    this.project = opts.project;
    this.cwd = opts.project.hostPath;
    this.#emit = opts.onEvent;

    const refs = opts.instructions ?? opts.project.settings.instructions ?? [];
    // FEAT-039 gap #1: fold this project's docs/CONVENTIONS.md (if any) onto the
    // shared Working Agreement at the REAL launch site, not just the /compose
    // preview route — hostPath is the project's checkout, same value used for
    // `this.cwd` below, so a project with no CONVENTIONS.md gets byte-identical
    // output to before this line existed (see verify:local-conventions "WIRED").
    // FEAT-043 `routing: true` — launched sessions also get the condensed
    // provider-routing section (mirror docs/prompts/ROUTING.md; absent file
    // injects nothing).
    // FEAT-084: gate the response-format injection on the SAME
    // `responseDigest.enabled` flag the transcript renderer reads — a project
    // with the digest OFF is neither instructed nor parsed and wastes no tokens
    // (responseFormat:false → byte-identical to before this option existed). When
    // ON, the project's optional `guidance` nudge rides along under a
    // `## Project override` subhead inside the injected section.
    const digest = responseDigestOf(opts.project);
    this.composed = composeInstructions(refs, {
      hostPath: opts.project.hostPath,
      routing: true,
      responseFormat: digest.enabled ? { guidance: digest.guidance ?? null } : false,
    });
    const dispatchOn = toolSettingsOf(opts.project).openaiDispatch;
    const dispatchRoute = opts.project.isolation === 'container'
      ? dispatchBroker.DISPATCH_COMMAND
      : `node ${dispatchBroker.dispatchClientPath()}`;
    const dispatchNote = dispatchAvailabilityNote(dispatchOn, dispatchRoute, opts.dispatchUnavailableReason);
    this.composed = { ...this.composed, systemPrompt: appendToSystemPrompt(this.composed.systemPrompt, dispatchNote) };
    for (const missing of this.composed.missingIds) {
      this.#emit({ t: 'error', message: `instruction template not found: ${missing}`, fatal: false });
    }

    /*
     * PER-SESSION OVERRIDES
     * ---------------------
     * `opts.overrides` has already been through the SAME validator the registry
     * PATCH uses (validate.ts). Here it is merged over the project's stored
     * settings to produce `this.effective`, which is the ONLY thing consulted
     * below. `opts.project.settings` is never mutated and nothing here writes to
     * the registry — the override lives exactly as long as this object.
     *
     * Container isolation: every overridable field survives the container hop.
     * model / effort / permissionMode / allowedTools / disallowedTools become
     * plain CLI flags in the argv the SDK builds, and that argv is forwarded
     * verbatim into `docker exec` (see the isolation-routing note below), so the
     * containerised CLI receives them identically to a host one. maxBudgetUsd is
     * never sent to the CLI at all — it is host-side accounting in #handle's
     * `result` branch. Hence `ignoredOverrides` is empty in practice.
     *
     * The settings a container genuinely could NOT honour per session — mounts,
     * container.{image,memoryMb,pidsLimit}, isolation — are rejected up front by
     * validateSessionOverrides() with an explicit error, because honouring them
     * would require recreating the container and would therefore leak into every
     * other session on that project. `ignoredOverrides` exists as the reporting
     * channel if a future field ever lands in the grey zone between the two.
     */
    const base = pickOverridable(opts.project.settings);
    const effective: Overridable = { ...base };
    const overridden: SessionOverridable[] = [];
    for (const field of SESSION_OVERRIDE_FIELDS) {
      if (!opts.overrides || !(field in opts.overrides)) continue;
      const v = opts.overrides[field];
      if (JSON.stringify(v) === JSON.stringify(base[field])) continue; // same as default: not an override
      (effective as Record<string, unknown>)[field] = v;
      overridden.push(field);
    }
    /*
     * CONTAINER DEFAULT: bypassPermissions.
     *
     * A containerised session is already sandboxed (its own container, no host
     * fs, dropped caps), so approval prompts inside it are friction without
     * safety benefit. So when isolation is `container` and NOTHING explicitly
     * chose a permission mode, the effective mode defaults to bypassPermissions
     * instead of `default`.
     *
     * "Explicitly chose" means either a session override carried permissionMode
     * (even ='default' — that is how you deliberately keep prompts in a
     * container), OR the project settings already differ from `default`. Only the
     * ambiguous `default` is upgraded, and only for containers — `direct` and
     * `sandbox` keep prompting, because there skipping permissions lets the model
     * run anything on the host. It is a DEFAULT, not a lock: any override wins.
     *
     * Note the value is read from `opts.overrides` directly, not from
     * `overridden`: an override equal to the project default ('default') is not
     * counted as an override above, but it still counts as an explicit choice
     * here and must suppress the upgrade.
     */
    // Provenance keys on EXPLICIT PRESENCE in the override, not on value
    // difference: `overridden` above drops an override equal to the project
    // default ('default'), but choosing 'default' is still a deliberate session
    // choice that must (a) label as session-override and (b) suppress the
    // container upgrade. A non-default PROJECT setting is respected too, because
    // then `effective.permissionMode` is already not 'default' and the upgrade
    // condition below is false — source stays 'project'.
    const permissionModeOverridden = opts.overrides != null && 'permissionMode' in opts.overrides;
    let permissionModeSource: 'session-override' | 'container-default' | 'project' =
      permissionModeOverridden ? 'session-override' : 'project';
    if (opts.project.isolation === 'container' && !permissionModeOverridden && effective.permissionMode === 'default') {
      effective.permissionMode = 'bypassPermissions';
      permissionModeSource = 'container-default';
    }
    this.permissionModeSource = permissionModeSource;

    this.effective = effective;
    this.overriddenFields = overridden;
    this.ignoredOverrides = [];

    const s = effective;

    /*
     * FEAT-037 P3 — THE PROVIDER PICKS THE ENGINE. This is the one seam where
     * the resolved provider (project setting ∘ per-launch override) selects
     * which AgentRuntime runs the session. Constructed HERE, before the
     * isolation routing below, because that routing reads the runtime's
     * honest `capabilities` (survival gating) — construction is side-effect
     * free until start().
     *
     * 'openai' fails FAST when Codex is not usable: starting the runtime
     * anyway would surface a bare ENOENT later; refusing here carries the
     * detection verdict + the "what do I do" hint (docs/PROVIDERS.md), and
     * the session never starts, so busy can never hang. The
     * CLAUDE_STATION_CODEX_BIN env override (the verification seam that
     * points the runtime at the scripted fake app-server) skips detection —
     * the operator explicitly named the binary.
     */
    let provider = s.provider ?? 'anthropic';
    /*
     * FEAT-037 P2b — ON RESUME, THE TRANSCRIPT PICKS THE ENGINE. A session id
     * is meaningful only to the engine that minted it: a Codex thread id can
     * only continue via thread/resume, a Claude session file only via the
     * Claude CLI. So when resuming, the store the transcript actually lives in
     * overrides the configured provider — an Orchard-owned transcript names
     * its engine (its provider directory), anything else vetted resumable is
     * the Claude store. Announced, never silent, when it differs.
     */
    if (opts.resumeSessionId) {
      const rid = opts.resumeSessionId; // the ORIGINAL id the user clicked (fork staging never applies to Orchard-owned transcripts — see startSession's refusal)
      const dirCandidates = [
        ...(opts.resumeEncodedDir ? [opts.resumeEncodedDir] : []),
        encodeCwd(opts.project.hostPath),
        ...(opts.project.isolation === 'container' ? [encodeCwd(containerWorkdir(opts.project.id))] : []),
      ];
      let resumeProvider: string | null = null;
      for (const d of new Set(dirCandidates)) {
        const hit = resolveOrchardSessionFile(d, rid);
        if (hit) { resumeProvider = hit.provider; break; }
      }
      // Not Orchard-owned → startSession's explainUnresumable already vetted it
      // against the CLAUDE store, so the engine must be Claude.
      const wanted = resumeProvider ?? 'anthropic';
      if ((wanted === 'openai' || wanted === 'anthropic') && wanted !== provider) {
        this.#emit({
          t: 'status',
          status: `resuming a ${wanted === 'openai' ? 'Codex' : 'Claude'} session — engine follows the transcript, overriding the configured provider (${provider})`,
        });
        provider = wanted;
        (this.effective as Record<string, unknown>).provider = wanted; // effectiveConfig() must keep telling the truth
      }
    }
    if (provider === 'openai') {
      if (!process.env.CLAUDE_STATION_CODEX_BIN) {
        const det = detectCodex();
        if (det.status !== 'connected') {
          const msg = `cannot start an OpenAI Codex session: ${det.label}${det.hint ? ` — ${det.hint}` : ''}`;
          this.#emit({ t: 'error', message: msg, fatal: true });
          throw new Error(msg);
        }
      }
      this.#runtime = new CodexRuntime();
    } else {
      this.#runtime = new ClaudeRuntime();
    }

    /*
     * The isolation branch below fills these when it needs to override how/where
     * the runtime spawns its process (container `docker exec`, or the FEAT-015
     * survival broker's own systemd scope). They travel to the runtime via
     * RuntimeStartConfig; the `allowDangerouslySkipPermissions` arming and the
     * `includePartialMessages` default are Claude idioms and now live inside
     * ClaudeRuntime.
     */
    let pathToExecutable: string | undefined;
    let spawnProcess: RuntimeSpawnFn | undefined;

    /*
     * ISOLATION ROUTING
     * -----------------
     * The Agent SDK does not run the model in-process: `query()` spawns the
     * `claude` CLI and talks stream-json over its stdio. That is exactly the
     * seam we need, and the SDK exposes it as `spawnClaudeCodeProcess` —
     * documented for "VMs, containers, or remote environments". We hand it a
     * `docker exec -i` child instead of a local one; the SDK cannot tell the
     * difference because a ChildProcess already satisfies its SpawnedProcess
     * interface. Nothing is emulated and nothing runs on the host.
     *
     * `pathToClaudeCodeExecutable` is set to the CONTAINER's binary path on
     * purpose. The SDK only prepends a JS runtime when that path ends in
     * .js/.mjs/.ts/etc; giving it an extension-less path makes it emit
     * `command = <that path>` with args that are purely CLI flags, so the argv
     * we forward into the container has no host paths baked into it.
     *
     * The caller (`startSession`) has already awaited `ensureContainer`, so a
     * container that cannot start throws BEFORE we get here. There is
     * deliberately no host fallback.
     */
    /*
     * FAIL-CLOSED. This switch is exhaustive on purpose and its default THROWS.
     * A prior version used `if (isolation === 'container') … else if (=== 'sandbox')`,
     * so any other string — including `"Container"` with a capital C — fell
     * through to plain host execution while the UI was still told the session was
     * isolated. Silently running on the host is the worst possible failure here,
     * so an unrecognised value is a hard error.
     */
    const iso: string = opts.project.isolation;
    if (iso === 'container') {
      const project = opts.project;
      // FEAT-037 P3: the CONTAINER's engine binary. The claude path is the
      // image-managed install; codex is resolved from the container's PATH —
      // honestly ENOENT (with the PROVIDERS.md hint baked into the runtime's
      // spawn-error message) until an image ships it.
      pathToExecutable = provider === 'openai' ? 'codex' : CONTAINER_CLAUDE_BIN;
      this.#execId = `${id}-${Math.random().toString(36).slice(2, 10)}`.replace(/[^A-Za-z0-9_-]/g, '-');
      spawnProcess = (o) =>
        execInContainer(project, { command: o.command, args: o.args, env: o.env, execId: this.#execId! });
      // Reported before system:init arrives, so the UI never briefly shows the
      // host path for a containerised session.
      this.cwd = containerWorkdir(project.id);
      this.containerName = containerName(project.id);
      /*
       * OOM honesty. The container is already running (startSession awaited
       * ensureContainer before constructing this object), so the cgroup kill
       * counter read HERE is this session's baseline — historic kills from
       * earlier sessions in the same container must not be pinned on this one.
       * The quiet poll warns near the limit; the death paths in #run consult
       * oomExplanation() so a 137 is named for what it was.
       */
      try { this.#oomBaseline = memoryStatus(project).oomKills; } catch { this.#oomBaseline = null; }
      this.#memTimer = setInterval(() => this.#checkMemory(), 15_000);
      this.#memTimer.unref?.();
    } else if (iso === 'sandbox') {
      throw new Error('isolation "sandbox" (bubblewrap) is modelled but not implemented yet');
    } else if (iso === 'direct') {
      /*
       * RESTART SURVIVAL (FEAT-015). By default the SDK spawns the `direct` CLI
       * as a plain child in the server's systemd cgroup, so a KillMode=
       * control-group restart reaps it (and every in-process sub-agent) with the
       * server. When survival is enabled we hand the SDK a `spawnClaudeCodeProcess`
       * override — the SAME seam the container path uses — that launches the CLI
       * under a broker in its own transient systemd scope (separate cgroup), and
       * relays the SDK's stream-json over a unix socket the broker owns. The CLI
       * then survives a server restart; the in-flight turn drains to completion.
       * When survival is off (kill-switch, or systemd-run unavailable) this is a
       * no-op and the SDK's default in-cgroup spawn runs exactly as before.
       */
      /*
       * FEAT-037 P3, capabilities-gated: survival's whole value is the
       * re-adopt/resume path, which is built on the persisted `.jsonl`
       * transcript store (`capabilities.persistedTranscript`).
       *
       * P2b REVISITED AND DELIBERATELY LEFT GATED: Orchard-owned capture
       * (this.#recorder) does give such an engine readable history + resume,
       * but the recorder lives in THIS server process. A CLI surviving a
       * server restart would keep producing turns with nobody recording them
       * — the transcript would silently omit exactly the work survival
       * protected, and re-adopt would render a hole where that turn was. The
       * Claude CLI has no such hole because it writes its own store
       * regardless of us. So survival stays armed only for engines whose
       * transcript persists independently of this process.
       */
      if (survivalEnabled() && this.#runtime.capabilities.persistedTranscript) {
        this.#survivalConfigured = true;
        spawnProcess = (o) => {
          const { proc, handle } = spawnSurvivable(
            { command: o.command, args: o.args, cwd: o.cwd, env: o.env },
            { stationSessionId: id, resumeHint: opts.resumeSessionId ?? null },
          );
          this.#survivalHandle = handle;
          return proc as never;
        };
      }
    } else {
      throw new Error(
        `unknown isolation ${JSON.stringify(iso)} on project ${opts.project.id} — refusing to start. ` +
          `Valid values are "direct", "container", "sandbox". Never falling back to host execution.`,
      );
    }
    // A cross-OS fork resumes the STAGED copy id, not the original — see fork.ts.
    this.#forkPlan = opts.forkPlan ?? null;
    this.#forkFrom = opts.fork && opts.resumeSessionId ? opts.resumeSessionId : null;
    this.#stagedFile = this.#forkPlan?.stagedFile ?? null;

    /*
     * ATTACHABLE MCP TOOLS (FEAT-025). `plannedMcpServers` is the single seam
     * that decides the whole `mcpServers` map from this project's per-tool
     * toggles — stealth browser (gated on browser.enabled; startSession has
     * already brought its daemon up on the host and thrown if it could not),
     * Serena (default-on) and Playwright (opt-in). See src/server/tools.ts.
     *
     * `strictMcpConfig` is set whenever the station attaches at least one
     * server: it stops the CLI from ALSO loading whatever MCP servers happen to
     * be in the repo's `.mcp.json` or the user's global ~/.claude settings, so a
     * session's tool surface is exactly what Claude Station handed it.
     */
    const plan = plannedMcpServers(opts.project);
    let mcpServers: Record<string, unknown> | undefined =
      Object.keys(plan.servers).length ? (plan.servers as Record<string, unknown>) : undefined;
    let strictMcpConfig = plan.strict;
    /*
     * FEAT-037 P3, capabilities-gated: an engine that cannot take a
     * per-session MCP config (Codex today — see runtime.ts `mcpConfig`) must
     * not be handed one it would silently ignore. Dropped LOUDLY: the status
     * line names exactly which tools this session does not get.
     */
    if (mcpServers && !this.#runtime.capabilities.mcpConfig) {
      this.#emit({
        t: 'status',
        status: `MCP tools not attached (${Object.keys(plan.servers).join(', ')}) — this engine cannot take a per-session MCP config yet; see docs/PROVIDERS.md`,
      });
      mcpServers = undefined;
      strictMcpConfig = false;
    }
    if (mcpServers && plan.servers[MCP_SERVER_NAME]) this.browserAttached = true;

    /*
     * BOOT AWARE (FEAT-021). For a board-having project, fold a compact, capped
     * live "Project state" snapshot onto the composed Working-Agreement prompt so
     * the session boots already aware of where the project is (needs-you items,
     * in-flight work, a one-line focus) instead of re-syncing by hand. It is
     * ADDED to the WA content, never replacing it; a project with no docs/bugs/
     * yields null and injects nothing (opt-in). Refreshed on every launch.
     */
    let sp = this.composed.systemPrompt;
    sp = appendToSystemPrompt(sp, boardStateSection(opts.project.hostPath));
    sp = appendToSystemPrompt(sp, opts.extraAppend);

    // FEAT-090: the snapshot above ALREADY carries the answered-awaiting lane, so
    // seed the seen-set with what it just stated — the open-session briefing
    // (#withBriefing) then never repeats a decision the launch prompt announced,
    // and only NEW answers recorded WHILE this session is open get briefed.
    try { for (const k of answeredAwaitingKeys(opts.project.hostPath)) this.#answerBriefSeen.add(k); } catch { /* no board */ }

    /*
     * FEAT-057 — "while you were away". A session being RESUMED may have had
     * agents (or its own turn) die since it last ran; the orchestrator cannot
     * be told by a notification it was never awake to consume. The server
     * knows, because it recorded the deaths at the moment they happened, so it
     * states them at the start of the next turn. Bounded, factual, and emitted
     * at most once per death; a healthy session gets NOTHING — see
     * `outcomes.takeBriefing`.
     */
    const firstPrompt = this.#withBriefing(opts.firstPrompt, opts.resumeSessionId ?? null);

    /*
     * FEAT-037 P2b — arm Orchard-owned transcript capture for engines with no
     * station-readable store of their own. AFTER the isolation routing so
     * `this.cwd` is final (the encoded dir must match where the session lists
     * look: hostPath for direct, containerWorkdir for container). On a plain
     * resume the file is known up-front — the SAME thread id means the SAME
     * file, and capture simply appends where it left off; a fresh session's
     * file is named by `system:init`. A fork gets a NEW thread id from init
     * and therefore a new file (startSession refuses Orchard forks today).
     */
    if (!this.#runtime.capabilities.persistedTranscript) {
      this.#recorder = new TranscriptRecorder({
        provider,
        cwd: this.cwd,
        onError: (message) => this.#emit({ t: 'error', message, fatal: false }),
      });
      if (s.model) this.#recorder.setModel(s.model);
      if (opts.resumeSessionId && !opts.fork) this.#recorder.adoptSessionId(opts.resumeSessionId);
      this.#recorder.recordUserPrompt(firstPrompt);
    }

    // Reported BEFORE the runtime spawns, so the UI knows what applied even if
    // the very first turn fails.
    this.#emit({ t: 'effective-config', ...this.effectiveConfig() });

    this.busy = true;
    this.turnStartedAt = Date.now(); // BUG-033: the ONE honest turn clock
    this.lastFrameAt = Date.now();   // BUG-033: the frameless window starts now
    // FEAT-057: a new turn's failures are its own. Clearing here is what stops
    // last turn's quota wall from being blamed for this turn's death.
    this.lastProviderError = null;
    this.#advisoryNotice = null;    // BUG-041: last turn's notices are not this turn's context
    this.#interruptRequested = false; // BUG-077: the first turn opens clean too — same invariant as send()
    // BUG-034: the running set changed the instant the turn began — publish it
    // now, not when some later frame happens to arrive. "The row appears
    // eventually" was the reported symptom.
    this.pushRunningSnapshot(true);
    // The runtime was constructed above (provider-selected); a synchronous
    // start() refusal (e.g. Codex refusing 'plan' mode — capabilities.planMode
    // is false and the adapter throws rather than faking a normal turn) must
    // reach the UI as a fatal error, not vanish into startSession's rethrow.
    try {
      this.#runtime.start({
        cwd: opts.project.hostPath,
        env: dispatchOn && !opts.dispatchUnavailableReason ? {
          ORCHARD_DISPATCH_ENTITLED: '1',
          ORCHARD_DISPATCH_SOCK: opts.project.isolation === 'container' ? dispatchBroker.CONTAINER_DISPATCH_SOCKET : dispatchBroker.dispatchSocketPath(opts.project),
          ORCHARD_DISPATCH_CMD: dispatchRoute,
        } : dispatchOn ? {
          ORCHARD_DISPATCH_ENTITLED: '1',
          ORCHARD_DISPATCH_CMD: dispatchRoute,
          ORCHARD_DISPATCH_UNAVAILABLE_REASON: opts.dispatchUnavailableReason!,
        } : { ORCHARD_DISPATCH_ENTITLED: '0' },
        firstPrompt,
        permissionMode: s.permissionMode,
        onApproval: (req) => this.#onCanUseTool(req.toolName, req.input, req.meta),
        pathToExecutable,
        spawnProcess,
        model: s.model || undefined,
        effort: s.effort || undefined,
        allowedTools: s.allowedTools.length ? s.allowedTools : undefined,
        disallowedTools: s.disallowedTools.length ? s.disallowedTools : undefined,
        resume: opts.resumeSessionId ? (this.#forkPlan?.resumeSessionId ?? opts.resumeSessionId) : undefined,
        forkSession: opts.resumeSessionId && opts.fork ? true : undefined,
        mcpServers,
        strictMcpConfig: strictMcpConfig || undefined,
        systemPrompt: sp || undefined,
      });
    } catch (err) {
      this.busy = false;
      this.turnStartedAt = null;
      this.#emit({ t: 'error', message: `session could not start: ${(err as Error).message}`, fatal: true });
      throw err;
    }
    this.#pump = this.#run();
    // Truth about available models, refreshed opportunistically per session —
    // remembered under THIS session's engine (FEAT-045), so the Claude and
    // Codex catalogs never overwrite each other.
    // Fire-and-forget: a failure here must never touch the session itself.
    const modelProvider = this.effective.provider ?? 'anthropic';
    void this.#runtime.supportedModels()
      .then((ms) => rememberModels(modelProvider, ms))
      .catch(() => { /* old CLI without the control request — keep the last list */ });
  }

  /**
   * FEAT-057 — prepend the "while you were away" briefing to a turn's prompt,
   * or return it untouched.
   *
   * `takeBriefing` returns null unless something actually died since it last
   * ran, and marks every record it names, so: a healthy session is never
   * spammed, and no death is reported twice. `extraId` lets a session being
   * resumed match records written under its SDK id before this bridge existed
   * (the exact case where the orchestrator was not awake to see the death).
   */
  #withBriefing(prompt: string, extraId: string | null = null): string {
    let brief: string | null = null;
    try { brief = outcomes.takeBriefing([this.id, this.sdkSessionId, extraId]); } catch { brief = null; }
    // FEAT-090 — a SIBLING briefing: board tickets answered while this session was
    // open, stated once per (ticketId, answerDate) and riding THIS turn (it never
    // starts one — send() is what invokes it, and only when the user is sending).
    let answer: string | null = null;
    try { answer = boardAnswerBriefing(this.project.hostPath, this.#answerBriefSeen); } catch { answer = null; }
    return [answer, brief, prompt].filter((s): s is string => !!s).join('\n\n');
  }

  /** Queue a follow-up turn into the SAME session. */
  send(prompt: string): void {
    if (this.closed) throw new Error('session is closed');
    if (this.budgetStopped) throw new Error('session stopped: budget exceeded');
    if (this.busy) throw new Error('a turn is already running — interrupt it first');
    const text = this.#withBriefing(prompt);
    this.busy = true;
    this.turnStartedAt = Date.now(); // BUG-033
    this.lastFrameAt = Date.now();   // BUG-033
    this.lastProviderError = null;   // FEAT-057: this turn's failures are its own
    this.#advisoryNotice = null;     // BUG-041: and last turn's notices are not its context
    // BUG-077: a turn's interrupt flag must reflect ONLY interrupts raised
    // DURING this turn. `interrupt()` has no busy-guard and clears only at
    // `result`, so a Stop processed while idle — a stray/duplicate, or the
    // result-then-interrupt race where turn A hits its own `result` a beat
    // before the queued interrupt runs — otherwise latches `true` into the
    // NEXT turn and mislabels it: false `killed` deaths, a spurious
    // turn-end interrupted:true, and an autonomous halt nobody asked for.
    // Clearing at turn open is robust to that race (clear-on-start beats a
    // busy-guard, which the race defeats).
    this.#interruptRequested = false;
    this.pushRunningSnapshot(true);  // BUG-034: the turn started — say so now
    this.#runtime.send(text);
    // Covers user turns AND the autonomous nudge (which routes through here).
    this.#recorder?.recordUserPrompt(text);
  }

  async interrupt(): Promise<void> {
    if (this.closed) return;
    this.#interruptRequested = true;
    await this.#runtime.interrupt();
  }

  /**
   * FEAT-022 — enter autonomous mode with a MANDATORY bounded stop condition.
   * Rejects a non-integer / out-of-range budget rather than arming a loop the
   * user did not clearly ask for. Resets the counters each time it is enabled.
   */
  enableAutonomous(maxTurns: number): AutonomousState {
    if (this.closed) throw new Error('session is closed');
    if (this.budgetStopped) throw new Error('session stopped: budget exceeded');
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > AUTONOMOUS_MAX_TURNS_CEILING) {
      throw new Error(`stop-after-N-turns must be an integer 1..${AUTONOMOUS_MAX_TURNS_CEILING}`);
    }
    this.autonomous = true;
    this.#autoMaxTurns = maxTurns;
    this.#autoTurnsDone = 0;
    this.#autoStopReason = null;
    return this.autonomousState();
  }

  /**
   * FEAT-022 — return to interactive. A running turn is NOT interrupted (Stop
   * just means "no more auto-continues"); the in-flight turn finishes and no
   * further turn is queued. `reason` is recorded for the audit trail.
   */
  stopAutonomous(reason: AutonomousStopReason = 'manual'): AutonomousState {
    if (this.autonomous) this.#autoStopReason = reason;
    this.autonomous = false;
    return this.autonomousState();
  }

  /** FEAT-022 — the mode + its stop condition + progress, for the UI/HTTP. */
  autonomousState(): AutonomousState {
    return {
      autonomous: this.autonomous,
      maxTurns: this.#autoMaxTurns,
      turnsDone: this.#autoTurnsDone,
      remaining: this.#autoMaxTurns == null ? null : Math.max(0, this.#autoMaxTurns - this.#autoTurnsDone),
      stopReason: this.#autoStopReason,
    };
  }

  /**
   * FEAT-022 — the auto-continue seam. Called once at every turn boundary
   * (`result`). While autonomous and every stop condition is unmet, it advances
   * exactly one more turn by sending the continue-nudge into THIS session; when
   * any stop condition is met it flips back to interactive with a recorded
   * reason. Bounded by `#autoMaxTurns`, so it can never spin unbounded.
   */
  #maybeAutoContinue(interrupted: boolean): void {
    if (!this.autonomous) return;
    // A concrete, auditable reason for every halt — checked in priority order.
    let stop: AutonomousStopReason | null = null;
    if (this.closed) stop = 'closed';
    else if (this.budgetStopped) stop = 'budget';
    else if (interrupted) stop = 'interrupted';
    else if (this.detached) stop = 'detached';
    else if (this.#autoMaxTurns != null && this.#autoTurnsDone >= this.#autoMaxTurns) stop = 'turns-reached';
    if (stop) { this.stopAutonomous(stop); return; }

    // Condition unmet → advance one more turn. Count it BEFORE sending so the
    // budget check above sees it next boundary and the UI counter is truthful.
    this.#autoTurnsDone += 1;
    // Defer the send off the current message-handling stack: `busy` was just set
    // false above and the runtime must not be re-entered synchronously.
    setTimeout(() => {
      if (!this.autonomous || this.closed || this.busy || this.budgetStopped) return;
      try {
        this.send(AUTONOMOUS_NUDGE);
      } catch (err) {
        this.stopAutonomous('error');
        this.#emit({ t: 'error', message: `autonomous stopped: ${(err as Error).message}`, fatal: false });
      }
    }, 0);
  }

  /**
   * Change the permission mode of the RUNNING session.
   *
   * Never optimistic: the returned `ok` is the CLI's word. `setPermissionMode`
   * sends a `set_permission_mode` control request with no client-side guard, so
   * acceptance is decided downstream and a rejection arrives as a thrown error
   * carrying the real reason. Observed rejections:
   *   - bypassPermissions on a session not launched with
   *     --dangerously-skip-permissions (this app now always arms it, so this
   *     should not happen here — but it is reported honestly if it ever does)
   *   - 'auto' on a model that has no auto-mode classifier
   * `default` / `acceptEdits` / `plan` switch freely, armed or not.
   */
  async setPermissionMode(mode: string): Promise<{ ok: boolean; mode: string; error?: string }> {
    if (!LIVE_PERMISSION_MODES.has(mode)) {
      return { ok: false, mode, error: `permissionMode must be one of ${[...LIVE_PERMISSION_MODES].join(', ')}` };
    }
    if (this.closed) return { ok: false, mode, error: 'session is closed' };
    try {
      await this.#runtime.setPermissionMode(mode);
    } catch (err) {
      // The CLI's message is specific and user-actionable; do not paraphrase it.
      return { ok: false, mode, error: (err as Error).message || String(err) };
    }
    this.#applyPermissionMode(mode, 'client');
    return { ok: true, mode };
  }

  /**
   * Record a permission-mode change the CLI has CONFIRMED, and re-report the
   * effective config so every surface reading it (drawer, HTTP route, tray)
   * agrees. Called for our own accepted changes and for changes the CLI makes
   * on its own — approving a plan drops `plan` back to `default`, and a UI still
   * showing "plan mode" after that would be lying.
   */
  #applyPermissionMode(mode: string, source: 'client' | 'agent'): void {
    if (this.effective.permissionMode === mode) return;
    (this.effective as { permissionMode: string }).permissionMode = mode;
    this.permissionModeSource = 'live-change';
    this.#emit({ t: 'permission-mode', mode, source });
    this.#emit({ t: 'effective-config', ...this.effectiveConfig() });
  }

  /**
   * Change the model of the RUNNING session. Mirrors setPermissionMode: never
   * optimistic — the returned `ok` is the CLI's word, and a refusal arrives as
   * a thrown error carrying the engine's real reason. `model:null` (or empty)
   * clears back to the default. The CLI is the authority on which ids it
   * accepts, so validation here is deliberately thin.
   */
  async setModel(model: string | null): Promise<{ ok: boolean; model: string | null; error?: string }> {
    if (this.closed) return { ok: false, model, error: 'session is closed' };
    const next = model == null || model === '' ? null : String(model);
    try {
      await this.#runtime.setModel(next);
    } catch (err) {
      // The CLI's message is specific and user-actionable; do not paraphrase it.
      return { ok: false, model: next, error: (err as Error).message || String(err) };
    }
    this.#applyModel(next);
    return { ok: true, model: next };
  }

  /**
   * Record a model change the CLI has CONFIRMED, and re-report the effective
   * config so every surface reading it (drawer, model picker, HTTP route)
   * agrees. Keeps `overriddenFields` truthful: a switch to something other than
   * the project default marks `model` overridden; a switch back clears it.
   */
  #applyModel(model: string | null): void {
    (this.effective as { model: string | null }).model = model;
    const idx = this.overriddenFields.indexOf('model');
    const isDefault = JSON.stringify(model) === JSON.stringify(this.project.settings.model ?? null);
    if (isDefault && idx >= 0) this.overriddenFields.splice(idx, 1);
    else if (!isDefault && idx < 0) this.overriddenFields.push('model');
    this.#emit({ t: 'effective-config', ...this.effectiveConfig() });
  }

  /**
   * Answer a pending `question-request`.
   *
   * Returns `matched:false` for an unknown/stale/already-resolved requestId —
   * matching is by id, never by order, so two questions in flight settle
   * independently and a late answer for a resolved one is refused rather than
   * applied to its neighbour.
   *
   * An empty `answers` (or one that matches no pending question) resolves the
   * tool with NO answers, which is the pre-existing behaviour: the model is told
   * the user did not answer and carries on. `answered` reports which happened so
   * the UI never shows "answered" for a pass.
   */
  answerQuestion(requestId: string, answers: QuestionAnswer[] | undefined): { matched: boolean; answered: boolean } {
    const p = this.#approvals.get(requestId);
    if (!p || p.kind !== 'question') return { matched: false, answered: false };
    this.#approvals.delete(requestId);

    const asked = new Set(parseQuestionInput(p.input).map((q) => q.question));
    const record: Record<string, string> = {};
    const notes: Record<string, { notes: string }> = {};
    for (const a of answers ?? []) {
      // Key must be the exact question text the model asked; the CLI looks the
      // answers up by it. An answer for a question that was not asked is
      // dropped rather than invented into the payload.
      if (!a || typeof a.question !== 'string' || !asked.has(a.question)) continue;
      const v = answerValue(a);
      if (!v) continue;
      record[a.question] = v;
      const other = typeof a.other === 'string' ? a.other.trim() : '';
      if (other) notes[a.question] = { notes: other };
    }

    const answered = Object.keys(record).length > 0;
    const updatedInput = answered
      ? { ...p.input, answers: record, ...(Object.keys(notes).length ? { annotations: notes } : {}) }
      : p.input;
    p.resolve({ behavior: 'allow', updatedInput });
    return { matched: true, answered };
  }

  /** Approve or reject a pending `plan-request`. Matched by id, as above. */
  answerPlan(requestId: string, approved: boolean, message?: string): boolean {
    const p = this.#approvals.get(requestId);
    if (!p || p.kind !== 'plan') return false;
    this.#approvals.delete(requestId);
    p.resolve(
      approved
        ? { behavior: 'allow', updatedInput: p.input }
        : { behavior: 'deny', message: message ?? 'The user rejected this plan — keep planning.' },
    );
    return true;
  }

  answerApproval(requestId: string, allow: boolean, message?: string): boolean {
    const p = this.#approvals.get(requestId);
    // A decision card must not be settleable through the generic approval
    // channel: "Allow" on a question sends no answer at all.
    if (!p || p.kind !== 'approval') return false;
    this.#approvals.delete(requestId);
    // `updatedInput` is REQUIRED on an allow. The CLI validates the control
    // response with zod and rejects a bare {behavior:'allow'} with an
    // "expected record, received undefined" ZodError, which surfaces as a failed
    // tool call ("Tool permission request failed") rather than as a permission
    // problem — observed live before this was fixed. Echo the original input
    // back unchanged.
    p.resolve(
      allow
        ? { behavior: 'allow', updatedInput: p.input }
        : { behavior: 'deny', message: message ?? 'Denied by user' },
    );
    return true;
  }

  /**
   * The driving socket is gone MID-TURN. The work must not die with it — the
   * user merely looked at another session (observed live: switching sessions
   * wrote "[Request interrupted by user]" into a planning session). Events
   * flow to a sink (the CLI writes the transcript file regardless, which any
   * viewer can follow); the turn finishes; then the session closes itself at
   * the boundary — or a returning socket re-attaches first.
   */
  detach(): void {
    this.detached = true;
    this.#emit = () => { /* nobody is listening; the jsonl is the record */ };
    // For the Claude runtime this is a no-op (the CLI persists to .jsonl either
    // way); the seam exists for a future runtime that must react to losing its
    // listener.
    this.#runtime.detach();
  }

  /** A returning socket takes over the event stream of a detached session. */
  attach(onEvent: (e: StationEvent) => void): void {
    this.detached = false;
    this.#emit = onEvent;
  }

  /**
   * Re-emit every still-open control request (approval / question / plan) to the
   * currently attached client. BUG-008: if the page reloaded while a permission
   * card was open, the pending request stayed in `#approvals` unanswered but the
   * card was gone — the turn was blocked forever on a request the user could no
   * longer see. On re-attach we replay the SAME events the original turn emitted
   * so the user can answer the still-open turn.
   *
   * Idempotent and safe to call repeatedly: it only re-renders the card; the
   * pending promise is untouched, still keyed by requestId, and still resolves
   * exactly once when answered (answer* deletes the entry; `once` guards it).
   * Callers should invoke this AFTER `attach` + the ack/session-init handshake
   * so the client has the session context before the card lands.
   */
  replayPending(): void {
    for (const [, p] of this.#approvals) this.#emit(p.event);
    // BUG-013: a reattaching client (reload, or a second tab) has no way to
    // know this session already hit its budget cap — `budgetStopped` lives
    // only on this instance, and the original stop event was emitted once,
    // to whoever was attached at that moment. Without this, a reattach shows
    // an enabled composer that `send()` will unconditionally reject.
    if (this.budgetStopped) {
      this.#emit({
        t: 'error',
        message: `budget stop: $${this.totalCostUsd.toFixed(4)} spent, limit $${(this.effective.maxBudgetUsd ?? 0).toFixed(2)}`,
        fatal: false,
        budgetStopped: true,
      });
    }
  }

  /**
   * BUG-020: `#agents` (populated by task_started/task_progress/task_updated,
   * see liveAgents() below) survives detach()/attach() untouched, but the
   * reattach handshake used to only call replayPending() — a reattaching
   * client's `state.agents` (the "N agents running" strip in app.js) starts
   * empty and was previously refilled only by luck, if a live progress/
   * completion event happened to land AFTER the new socket attached. A
   * sub-agent that fully finished DURING the detach window got no event at
   * all, ever (confirmed in BUG-020's repro).
   *
   * Re-emit one event per still-tracked agent so the reattached client's
   * strip is seeded with ground truth: `agent-started` for one still
   * `running` (app.js's handler treats it exactly like a fresh start — sets
   * t0 from elapsedMs so the clock keeps counting from the right place), or
   * `agent-completed` for one that is `completed`/`failed`/`killed` (already
   * settled — app.js just files it into the main thread's hairline history,
   * a no-op-safe replay since finishStream() no-ops on a thread with no live
   * stream). Same idempotent-replay shape as replayPending(): the event is
   * the CURRENT snapshot of `#agents`, not a re-play of history, so calling
   * this more than once is harmless. Call AFTER attach + the ack/session-init
   * handshake, same as replayPending().
   */
  replayAgents(): void {
    for (const a of this.#agents.values()) {
      this.#emit({ t: a.status === 'running' ? 'agent-started' : 'agent-completed', agent: { ...a } });
    }
  }

  /* ------------------- ARCH-001 phase 2 / BUG-034: the published running set */

  /**
   * THE SERVER'S ANSWER to "what is running right now", for THIS session.
   *
   * A pure arrangement of two things the server already owns: the ARCH-001
   * authority's verdict and this session's own agent map. Nothing is decided
   * here — see `running-set.ts` for the contract and the two gates.
   */
  runningSnapshot(now = Date.now()): RunningSnapshot {
    return snapshotOfSession(
      this,
      outcomes.list({ sessionIds: [this.id, this.sdkSessionId], limit: 20 }),
      now,
    );
  }

  /** Signature of the last snapshot pushed, so an unchanged answer is not re-sent. */
  #snapSig = '';

  /**
   * Push the snapshot to whoever is attached, WHENEVER THE ANSWER CHANGES.
   *
   * `force` re-sends even an unchanged answer — used at the (re)attach
   * handshake, where the client has no answer at all yet, and at turn
   * boundaries. Cheap by construction: identical answers are suppressed, so a
   * chatty turn does not turn into a snapshot flood, and the client's poll is
   * the backstop for anything that never arrives (a dropped frame is exactly
   * the intermittency BUG-034 is made of).
   */
  pushRunningSnapshot(force = false): void {
    let snap: RunningSnapshot;
    try { snap = this.runningSnapshot(); } catch { return; }
    const sig = [
      snap.turn.running, snap.turn.since ?? '', snap.turn.kind,
      // BUG-046: a running↔stalled flip is a real answer change — push it.
      snap.running.map((r) => `${r.id}:${r.startedAt ?? ''}:${r.state ?? 'running'}`).join(','),
      snap.ended.map((o) => o.id).join(','),
    ].join('|');
    if (!force && sig === this.#snapSig) return;
    this.#snapSig = sig;
    this.#emit({ t: 'running-snapshot', snapshot: snap });
  }

  /* ---------------------------------------- FEAT-057: recording what died */

  /** Persist ONE death, tagged with this session + project. Never throws. */
  #recordOutcome(o: {
    agentId: string;
    row: 'main' | 'agent' | 'tool';
    label: string;
    description?: string;
    kind: outcomes.OutcomeKind;
    detail: string;
    providerError?: EndProviderError | null;
    /** BUG-041 — shared by rows written for ONE host-level event. */
    clusterId?: string | null;
    at?: number;
  }): void {
    try {
      outcomes.record({
        projectId: this.project.id,
        projectName: this.project.name,
        stationSessionId: this.id,
        sdkSessionId: this.sdkSessionId,
        ...o,
        clusterId: o.clusterId ?? null,
        at: o.at,
      });
    } catch { /* the outcome ledger must never break a turn */ }
  }

  /**
   * FEAT-057 — record ONE agent's end from the engine's own terminal frame.
   * `completed` is dropped by the store; `failed`/`killed` are the engine's
   * words and are stored verbatim, enriched with a terminal provider error
   * when one was classified for this turn (a subagent that hit the account's
   * usage wall dies as a bare `failed` — the reason lives on the turn).
   */
  /**
   * BUG-105 (1st independent clean-room verdict) — POSITIVE TERMINAL EVIDENCE
   * WINS OVER STALE LEVEL MEMBERSHIP. Called from the ENGINE'S OWN terminal
   * frames only (`task_updated` terminal status, `task_notification` terminal
   * status) — never from the turn-end sweep's settle, which is this bridge's
   * inference and can be wrong about a lane that is genuinely working.
   *
   * A task that said it finished IS finished, whatever a level snapshot still
   * contains, so its membership is withdrawn here and refused at the level
   * rebuild. Everything that reads those maps as liveness — the sparing rule
   * (`#ownerIsLiveBackgroundAgent`), the reclamation predicate
   * (`#ownerPositivelyNotLive`), the sweep's own background `continue`,
   * `stallSignalFor`, `workLifetime` — is corrected at once and cannot be left
   * behind by a later reader.
   */
  #retireTask(
    taskId: string,
    status: 'completed' | 'failed' | 'killed',
    /**
     * WHICH FRAME SAID SO. `patch` is a `task_updated` — the engine's specific,
     * per-task word about that one task. `notification` is a `task_notification`,
     * which this bridge has ALWAYS treated as the weaker of the two: the
     * row-present handler applies it only `if (a.status === 'running')`, because a
     * SIGTERM'd CLI emits `status:"stopped"` for EVERY still-open task on its way
     * out (probe-verified, v2.1.220) — a blanket about the session, not a verdict
     * about this task. BUG-105 (6th verdict) narrows that: the weakness belongs to
     * the teardown STATUS, not to the frame type — a `status:"completed"`/`"failed"`
     * notification is the only terminal frame a tool task ever gets, and is the
     * engine's per-task verdict. BUG-105 (7th verdict) then makes the other half
     * absolute: a teardown STATUS settles nothing at all, running row or not.
     * See `#terminalFrameSettles`.
     */
    authority: 'patch' | 'notification',
    /**
     * BUG-105 (4th clean-room verdict) — THE ROW'S STATE AT THE INSTANT THIS FRAME
     * ARRIVED, `'absent'` when this bridge holds no row for the task. The caller
     * passes it rather than this method looking the row up, because the whole point
     * is that "no row" is a STATE THE SAME PREDICATE IS ASKED ABOUT, not a separate
     * code path with its own rules.
     */
    rowState: 'absent' | LiveAgent['status'],
  ): boolean {
    /*
     * BUG-105 (3rd clean-room verdict, property (c)) — WHEN TWO REPORTS DISAGREE.
     *
     * The prior rule was "the first report stands", justified by pointing at
     * `outcomes.record`'s first-wins. That was a MISREADING of what first-wins
     * does here, and it lost real deaths: on `completed` then `failed` with no row
     * yet, the `failed` was dropped, `task_started` applied the stored `completed`,
     * and `#recordAgentEnd` drops `completed` — so an engine-reported FAILURE left
     * NO ledger row at all. The same two frames with the row already present write
     * a `failed` row, because each patch is recorded as it arrives and a
     * `completed` is not a row to begin with. The two orders disagreed about what
     * the engine said, which is precisely what property (c) forbids.
     *
     * THE RULE, and its justification: THE ROW-LESS PATH MUST PRODUCE THE LEDGER
     * THE ROW-PRESENT PATH WOULD HAVE PRODUCED. That path is the reference — it is
     * where every one of these decisions was already made and probe-checked — and
     * "in either order" is the whole point of keeping the status here. Applied:
     *
     *   - no report yet                        → store it (either path records it)
     *   - a DEATH by `patch`, over a stored
     *     `completed`                          → replace: the row-present path
     *                                            would have written that death
     *                                            (`completed` was never a row)
     *   - anything else (a second death, any
     *     `completed`, any `notification`)      → keep what is stored: the
     *                                            row-present path could not have
     *                                            retracted the death it already
     *                                            wrote, and its notification
     *                                            handler ignores a non-running row
     *
     * Note this is neither "first wins" nor "last wins": it is "no death the
     * engine specifically reported is ever erased, and no blanket teardown is ever
     * promoted into one".
     *
     * BUG-105 (4th clean-room verdict) — AND THE SECOND CLAUSE OF THAT SENTENCE WAS
     * ONLY TRUE WHEN A ROW HAPPENED TO EXIST. The rule above was written as a
     * comparison between two REPORTS, so it could only demote a blanket that landed
     * ON TOP of something; a blanket arriving as the FIRST frame for a task with no
     * row hit `prior === undefined` and was stored as the task's outcome, then
     * applied as a `killed` death when the row appeared. The engine never gave a
     * per-task verdict on that task at all — a session-wide teardown blanket was
     * promoted into one, which is the exact ledger the row-present path refuses to
     * write (its `a.status === 'running'` guard) and therefore the exact parity
     * property (c) demands.
     *
     * THE STRUCTURAL FORM. "May this frame settle this row?" is now asked in ONE
     * place — `#terminalFrameSettles()` — for BOTH paths, with the row's absence
     * passed in as a state (`'absent'`) rather than handled by a parallel branch.
     * Only a frame that answered YES may establish an outcome; the disagreement
     * rule above then arbitrates between OUTCOMES, which is what it was always
     * about. So a frame type that cannot establish an outcome with a row present
     * cannot establish one with the row missing — not because both places remember
     * to check, but because there is one check and one place.
     */
    // LIVENESS. Any terminal frame — blanket or verdict — is the engine saying this
    // task is over, which is all the level mirrors need (BUG-105, 1st verdict).
    // BUG-105 (5th verdict): the veto is a set of its own, and `#backgroundTasks` is
    // rebuilt from (last level frame − veto) rather than mutated here, so there is
    // ONE expression of "what the level says is live" for both directions of change.
    this.#retiredTasks.add(taskId);
    this.#rebuildBackgroundLevel();
    this.#bgBornTasks.delete(taskId);

    // EVIDENCE + CONFLICT. Tracked for every terminal frame, whatever it can
    // establish: two disagreeing frames are an upstream anomaly worth surfacing even
    // when the resolution correctly writes nothing (the `blanketLate` case).
    const firstSeen = this.#terminallyReportedTasks.get(taskId);
    let conflicted = false;
    if (firstSeen === undefined) {
      this.#terminallyReportedTasks.set(taskId, status);
    } else if (firstSeen !== status) {
      conflicted = true;
      const seq = this.#conflictingTerminalReports.get(taskId) ?? [firstSeen];
      seq.push(status);
      this.#conflictingTerminalReports.set(taskId, seq);
    }

    // OUTCOME. Only a frame that settles the row establishes one.
    // BUG-105 (6th clean-room verdict): asked BEFORE the write below, so
    // `#establishedOutcomes` still holds the PRIOR state — which is what the
    // row-less arm of the predicate reads as "this task is already settled".
    const settles = this.#terminalFrameSettles(taskId, rowState, authority, status);
    if (settles) {
      const prior = this.#establishedOutcomes.get(taskId);
      // `prior === 'completed' && a death` is the replacement clause above; a stored
      // death is never retracted or reclassified. (The `authority === 'patch'` test
      // the old rule carried here is subsumed: a `notification` only ever reaches
      // this line as a per-task ending the row-present path would itself have
      // written — either it settled a row this bridge held RUNNING, or it was a
      // per-task verdict for a task NOTHING had settled yet, in which case `prior`
      // is `undefined` and the replacement clause is not what stores it.)
      if (prior === undefined || (prior === 'completed' && status !== 'completed')) {
        this.#establishedOutcomes.set(taskId, status);
      }
    }
    if (conflicted) {
      const recorded = this.#establishedOutcomes.get(taskId);
      console.warn(`[orchard] session ${this.id}: the engine reported CONFLICTING terminal outcomes for task ${taskId} (${(this.#conflictingTerminalReports.get(taskId) ?? []).join(' then ')}, latest via ${authority}); the recorded outcome is ${recorded ?? 'none — no frame that could settle a row established one'}`);
    }
    return settles;
  }

  /**
   * BUG-105 (4th clean-room verdict) — THE ONE DECISION: may THIS terminal frame
   * settle THIS task's row? Asked by both terminal-frame handlers, for a row that
   * exists and for one that does not, so the two orderings cannot drift apart.
   *
   * `rowState` is the row's status AT THE INSTANT THE FRAME ARRIVED, or `'absent'`
   * when this bridge has no row for the task — which is a state, not an exemption.
   *
   *  - `patch` (`task_updated`) is the engine's SPECIFIC, per-task word about that
   *    one task. The row-present handler applies it whatever the row said, so it
   *    settles unconditionally here too — including when the row is `'absent'`,
   *    which is what keeps "a terminal report marks the eventual row terminal, in
   *    either order" true.
   *  - `notification` (`task_notification`) is the weaker frame, and the 6th
   *    clean-room verdict is about WHY it is weaker. The previous round drew the
   *    line at the frame's TYPE — patches establish outcomes, notifications never
   *    do — and that line is wrong, because for a `local_bash`/tool task this
   *    notification is the ONLY terminal frame the CLI ever emits (BUG-030). Making
   *    every notification establish nothing throws away the only verdict those
   *    tasks ever get: a row-less `status:"completed"` left just the WITHDRAWABLE
   *    liveness veto behind, a later `task_started` withdrew it, and a task the
   *    engine had positively reported FINISHED was re-admitted as live background
   *    work (reproduced live: `snap2.running = ['bashDone','bashChild']`).
   *
   *    The line is what the frame SAYS, not what kind of frame it is:
   *
   *      SELF-REACHED ENDINGS — `status:"completed"` / `"failed"` (the SDK's
   *      `SDKTaskNotificationMessage.status` union is exactly
   *      `'completed' | 'failed' | 'stopped'`; this bridge additionally maps a
   *      defensive `'error'` onto `failed`). Only the one task that reached that
   *      end can produce these, so they ARE the engine's per-task verdict and are
   *      treated exactly like a patch.
   *
   *      ENDINGS IMPOSED FROM OUTSIDE — everything this bridge maps to `killed`:
   *      raw `"stopped"` and the defensive `"killed"` alias. `"stopped"` is
   *      genuinely ambiguous at the frame — the SDK documents it BOTH as the
   *      per-task answer to a `stop_task` request AND as what a SIGTERM'd CLI
   *      emits for EVERY still-open task on its way out (probe-verified, v2.1.220)
   *      — and nothing in the frame distinguishes the two. So it is read as the
   *      blanket, and a blanket ESTABLISHES NOTHING AND SETTLES NOTHING.
   *
   * BUG-105 (7th clean-room verdict) — AND "NOTHING" MEANS NOTHING, ROW OR NO ROW.
   * The 6th round wrote that sentence but implemented a WEAKER one: the blanket was
   * demoted only where it had no row to land on, and a row this bridge held RUNNING
   * was read as "evidence the teardown is about live work of ours" and let the frame
   * through as a per-task `killed`. A running row is not evidence of that. At a real
   * teardown EVERY still-open task gets this frame, so the set of tasks with running
   * rows is exactly the set the blanket is least specific about — including a
   * foreground subagent whose ancestor is STILL LIVE on the engine's background
   * level, whose row was then settled, removed from the strip and written dead while
   * it worked (`ended=["killed"], rows=0`, measured live through the real server and
   * bridge). "Demoted" is not the same as "not a verdict": on an existing row the
   * demotion still wrote a death.
   *
   * So there is now ONE rule with no row-state arm: a blanket never establishes or
   * writes a per-task outcome. WHAT THEN HAPPENS AT A GENUINE TEARDOWN falls out of
   * the ordinary inference path, which is where honest recording already lives and
   * is already tested — the row stays `running`, the liveness veto below still
   * retires the task from the level (that part IS what the frame says: this task is
   * no longer live work the engine vouches for), and the row is settled and recorded
   * by whichever inference reaches it: the turn-end sweep (`unknown`, or `killed` on
   * an interrupt) or `#recordSessionEnd` (`cut` — "the process behind this went away
   * mid-flight"), each writing through `outcomes.record`, which is first-wins per
   * `agentId`, so a genuine teardown death is recorded EXACTLY ONCE. The recorded
   * cause changes from the blanket's `killed` to the inference's honest `cut`, which
   * is strictly more truthful: nothing in the frame said this task was killed.
   *
   *      THE TRADE, STATED. A GENUINE per-task `stop_task` result carries this same
   *      status, so this rule silences it too — a `stop_task`ed agent no longer
   *      records the engine's `killed`; it records the inference's `unknown`/`cut`
   *      at the next boundary that contains it, and is spared while a live ancestor
   *      holds it. The trade is right because the two are INDISTINGUISHABLE at the
   *      frame and the errors are not symmetric: reading a blanket as a stop kills
   *      live work and hides it from the strip mid-flight (the reported incident,
   *      twice), while reading a stop as a blanket costs a deferral and a less
   *      specific cause on work that really did end — no death is lost, only named
   *      less precisely. Distinguishing them needs evidence the frame does not carry
   *      (a `tool_use_id` correlation, or the CLI tagging the blanket); if the SDK
   *      ever adds one, this is the first thing to revisit.
   *
   *    Unknown statuses never reach here at all: the handler maps only these five
   *    onto a terminal kind, so a future status is not terminal rather than
   *    silently classified.
   *
   *  - AND A ROW-LESS NOTIFICATION IS STILL REFUSED ONCE THE TASK IS SETTLED. With
   *    a row present the demotion already says so — `rowState === 'running'` is
   *    false for a row some earlier frame ended, so a late notification cannot
   *    re-settle or reclassify it. `'absent'` needs the same question asked of the
   *    only place a row-less settlement is remembered, `#establishedOutcomes`; the
   *    map is therefore consulted here (before `#retireTask` writes to it) so that
   *    "already settled" means the same thing in both orderings. Without it,
   *    `task_updated completed` then `task_notification failed` with the row late
   *    would write a `failed` ledger row the row-present ordering would not — the
   *    exact parity break property (c) forbids.
   *
   * WHAT THIS MAKES UNREPRESENTABLE (no input reaches the state at all):
   *   - a blanket teardown becoming an engine-reported per-task death, in ANY row
   *     state. `status === 'killed' && authority === 'notification'` returns before
   *     `rowState` is consulted, and BOTH the outcome write (`#establishedOutcomes`,
   *     the only thing `task_started` applies to a late row) and the row write (both
   *     terminal-frame handlers are gated on `settles`) are downstream of it. There
   *     is no row state, no ordering and no ancestor arrangement that gets a blanket
   *     to either of the two places a per-task death can be written — which is what
   *     makes this one rule and not two agreeing ones;
   *   - a task the engine positively reported finished being resurrected: the
   *     verdict is now ESTABLISHED whichever frame type carried it, and
   *     `#withdrawLivenessVeto`'s single guard refuses to withdraw a veto an
   *     established outcome is behind;
   *   - a second, disagreeing outcome from a notification: it cannot reach the
   *     replacement clause, because an established outcome makes it non-settling;
   *   - a teardown death going UNRECORDED as the price of the above: nothing here
   *     can suppress a write, only decline to make one from this frame. The row is
   *     left exactly as a row with no report at all, which every inference path
   *     already handles, and `outcomes.record` is first-wins per `agentId`, so the
   *     recording is exactly-once by construction rather than by agreement between
   *     the frame path and the sweep.
   * WHAT REMAINS MERELY GUARDED (real inputs the rule handles by policy, not by
   * being impossible — the honest list, and the place to look first next time):
   *   - a genuine per-task `stop_task` result, row-less OR with a row. Deliberately
   *     indistinguishable-by-policy: see THE TRADE above. Its death is deferred to
   *     an inference and named `unknown`/`cut`, never dropped.
   *   - a task id REUSED by the engine after a per-task completion verdict. The
   *     re-announced lane can never be admitted as live, because "finished stays
   *     finished" is a statement about the id. Task ids are per-session unique in
   *     every frame stream observed here; if that ever changes this trade is the
   *     first thing to revisit.
   */
  #terminalFrameSettles(
    taskId: string,
    rowState: 'absent' | LiveAgent['status'],
    authority: 'patch' | 'notification',
    status: 'completed' | 'failed' | 'killed',
  ): boolean {
    if (authority === 'patch') return true;
    /*
     * THE BLANKET — ONE RULE, NOT TWO. `killed` here is this bridge's mapping of
     * the OUTSIDE-IMPOSED notification statuses (raw `"stopped"`, the defensive
     * `"killed"` alias), i.e. the teardown blanket. It is a statement about the
     * PROCESS going away, not a verdict about this task, so it establishes no
     * per-task outcome and settles no row — WHETHER OR NOT A ROW EXISTS.
     *
     * The 7th clean-room verdict is that "demoted" was not the same as "not a
     * verdict": the previous round returned `true` here whenever the row was
     * `running`, on the reading that a running row is evidence the teardown is
     * about live work of ours. It is not evidence of that at all — every
     * still-open task gets the same frame, including one whose ancestor is still
     * live on the engine's background level. That reading converted a blanket
     * into a per-task `killed`, settled the row, removed it from the strip and
     * cut off live work. The row's existence changes nothing about what the frame
     * SAYS, so it may not change what the frame is allowed to establish.
     */
    if (status === 'killed') return false;
    // Left: a SELF-REACHED ending (`completed`/`failed`) — the engine's per-task
    // verdict, treated exactly like a patch, except that it cannot re-settle or
    // reclassify a row some earlier frame already ended.
    if (rowState === 'running') return true;
    if (rowState !== 'absent') return false;
    // The row-less mirror of that same "already settled" state.
    return !this.#establishedOutcomes.has(taskId);
  }

  /**
   * BUG-105 (5th clean-room verdict) — THE ONE EXPRESSION OF "WHAT THE ENGINE'S
   * LEVEL SAYS IS LIVE": the last level frame MINUS the liveness veto. Both inputs
   * change independently and in either order (a level frame lands; a terminal frame
   * adds a veto; a re-announcement withdraws one), so the visible set is DERIVED on
   * every change rather than mutated in three places — which is what makes the
   * order the frames arrive in unable to change the answer.
   */
  #rebuildBackgroundLevel(): void {
    this.#backgroundTasks = new Map(
      [...this.#levelRaw].filter(([id]) => !this.#retiredTasks.has(id)),
    );
  }

  /**
   * BUG-105 (5th clean-room verdict) — A FRESH PER-TASK ANNOUNCEMENT WITHDRAWS A
   * VETO NO PER-TASK VERDICT IS BEHIND. Called from `task_started`, the engine's
   * positive statement that THIS task is live NOW.
   *
   * The guard is the whole rule: if the engine ESTABLISHED an outcome for this task
   * the veto stands, so a finished task is never resurrected — its row is settled
   * from `#establishedOutcomes` a few statements later in that same handler, and no
   * level frame can put it back among the live. Only a veto written by a frame that
   * could not settle a row — a session-wide teardown blanket for a task this bridge
   * held no running row for — is withdrawn, because such a frame was never a verdict
   * about this task and an announcement is strictly newer evidence than it.
   */
  #withdrawLivenessVeto(taskId: string): void {
    if (!this.#retiredTasks.has(taskId)) return;
    if (this.#establishedOutcomes.has(taskId)) return;
    this.#retiredTasks.delete(taskId);
    // The level frame that declared this task may have landed BEFORE the
    // announcement (the SDK documents the ordering as unspecified) and been
    // filtered by the veto that has just gone; re-derive so it is heard.
    this.#rebuildBackgroundLevel();
  }

  #recordAgentEnd(a: LiveAgent, status: 'completed' | 'failed' | 'killed'): void {
    if (status === 'completed') return;
    // BUG-041: lastProviderError only ever holds TERMINAL causes now; an
    // advisory notice is quoted as context on a real failure, never as cause.
    const pe = this.lastProviderError;
    const ctx = !pe && this.#advisoryNotice ? ` (context, not cause: ${this.#advisoryNotice})` : '';
    /*
     * BUG-105 (3rd clean-room verdict) — SURFACE A DISAGREEMENT INSTEAD OF
     * QUIETLY RESOLVING IT. If the engine gave this task two different terminal
     * outcomes, the reader of this row is told, in the row itself. Honest limit:
     * this can only annotate a row written AFTER the conflict was observed — a
     * death already on the ledger when the second, disagreeing report arrives is
     * not rewritten (the ledger does not retract), and that conflict is visible
     * only in the server's warning.
     */
    const conflict = this.#conflictingTerminalReports.get(a.agentId);
    const conflictNote = conflict
      ? ` (the engine reported CONFLICTING terminal outcomes for this task — ${conflict.join(', then ')} — which usually means something upstream is wrong: a re-delivered stream, a reused task id, or a teardown blanket landing on a task that had already reported)`
      : '';
    this.#recordOutcome({
      agentId: a.agentId,
      row: a.kind === 'tool' ? 'tool' : 'agent',
      label: a.agentType,
      description: a.description,
      kind: pe ? 'provider-error' : status,
      detail: (pe
        ? `the engine reported this agent ${status}; the last failure it reported for the turn was ${pe.kind} (${pe.provider}): ${pe.detail}`
        : `the engine reported this agent ${status}${ctx}`) + conflictNote,
      providerError: pe,
    });
  }

  /**
   * The session itself is ending while work was in flight (a reap, a transport
   * death, a close mid-turn). Record the main turn and every still-running
   * agent, with the cause the AUTHORITY evidenced — a classified provider
   * error where one exists, otherwise `cut`, which is the honest name for
   * "the process behind this went away mid-flight and no result was recorded".
   * Never `completed`: nothing here proves anything finished.
   */
  #recordSessionEnd(reason: string): void {
    if (!this.busy && ![...this.#agents.values()].some((a) => a.status === 'running')) return;
    const pe = this.lastProviderError;
    const kind: outcomes.OutcomeKind = pe ? 'provider-error' : 'cut';
    const ctx = !pe && this.#advisoryNotice ? ` (context, not cause: ${this.#advisoryNotice})` : '';
    const detail = pe
      ? `${reason}; the last failure the engine reported for this turn was ${pe.kind} (${pe.provider}): ${pe.detail}`
      : `${reason}${ctx}`;
    /*
     * BUG-041 — a session ending IS one host-level event. Every row it takes
     * down is written with the same timestamp and cluster id, so the ledger's
     * reporting surfaces present "the session was cut, taking main + N agents
     * with it" as ONE fact instead of N same-millisecond independent deaths.
     */
    const at = Date.now();
    const clusterId = `session-end-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (this.busy) {
      this.#recordOutcome({ agentId: 'main', row: 'main', label: 'main', description: '', kind, detail, providerError: pe, clusterId, at });
    }
    for (const a of this.#agents.values()) {
      if (a.status !== 'running') continue;
      // BUG-041: a delivered final result is evidence of completion — the cut
      // ended the session, not this agent's already-finished work.
      if (this.#resultDelivered.has(a.agentId)) continue;
      this.#recordOutcome({
        agentId: a.agentId,
        row: a.kind === 'tool' ? 'tool' : 'agent',
        label: a.agentType,
        description: a.description,
        kind,
        detail,
        providerError: pe,
        clusterId,
        at,
      });
    }
  }

  /**
   * True when this session's CLI was launched to survive a server restart
   * (isolation "direct" with survival enabled). The server hands such sessions
   * OFF on shutdown instead of closing them — see handoff() and closeAllSessions.
   */
  get survivable(): boolean {
    return this.#survivalConfigured;
  }

  /**
   * BUG-033 — GROUND TRUTH about the process this session's `busy` claim rests
   * on, or an honest `'unknown'`. Available for isolation "direct" with
   * survival armed (the broker records the CLI's pid and deletes its status
   * file on the way out — see survival.ts `probe()`). Everything else answers
   * `'unknown'`: the SDK owns those children and exposes no pid, so there is
   * nothing to check and we must not pretend otherwise. `'unknown'` is why the
   * frameless window exists at all — it is the backstop where ground truth is
   * unavailable, never a substitute for it.
   */
  processProbe(): SurvivalProbe {
    if (this.#survivalHandle) return this.#survivalHandle.probe();
    if (this.#survivalConfigured) {
      return { state: 'unknown', detail: 'the session-host broker has not been spawned yet' };
    }
    return {
      state: 'unknown',
      detail: this.containerName
        ? 'this session runs inside a container — its CLI has no host pid to check'
        : 'this engine child is owned by the SDK and exposes no pid to check',
    };
  }

  /**
   * BUG-033 / ARCH-001 — is this session's claim to be RUNNING still true?
   *
   * A pure delegation to the single authority. The ordering that makes the
   * answer safe (dead process → dead now; alive process → LIVE however silent;
   * unknown → the frameless backstop, and even then `unknown`, not `dead`)
   * lives in `liveness.ts` and is shared with every other site that asks the
   * question. Nothing may be added to this body but the call: a local rung
   * here is exactly how the bridge site and the survivor site drifted apart.
   */
  livenessVerdict(now = Date.now()): Liveness {
    return livenessOfBridge(this, now);
  }

  /**
   * BUG-033 — drop a bridge whose turn cannot be running any more, ANNOUNCING
   * it. The fatal error goes out first and on its own: `close()` awaits `#pump`,
   * and a half-dead stream is precisely a pump that never settles, so its
   * `session-closed` may never arrive. The synchronous half of `close()`
   * (`closed`, `busy=false`, `sessions.delete`) does land immediately, which is
   * what makes the session drop out of /api/sessions and the UI settle.
   */
  reapAsZombie(verdict: { kind: string; reason: string }): void {
    if (this.closed) return;
    // Logged HERE, not at the call site: the sweep is not the only reaper —
    // the reattach gate drops corpses too, and both must leave a trace.
    console.warn(`[orchard] reaping zombie session ${this.id} (${verdict.kind}): ${verdict.reason}`);
    this.#emit({
      t: 'error',
      fatal: true,
      message:
        `this session is no longer running: ${verdict.reason}. ` +
        'Its turn ended without ever reporting a result, so the bridge has been dropped rather than left showing as running. ' +
        'Send your message again to resume the session from its transcript.',
    });
    void this.close(`zombie bridge reaped (${verdict.kind}): ${verdict.reason}`).catch(() => { /* pump may never settle — the error above is the record */ });
  }

  /**
   * Server is shutting down but must NOT kill this survivable session. Release
   * only server-local resources (timers, the event sink) and LEAVE the broker +
   * CLI running in their own scope, so the in-flight turn finishes and a
   * restarted server can re-adopt it. Deliberately does not touch `#q`/the broker.
   */
  handoff(): void {
    this.detached = true;
    this.#emit = () => { /* server is going away; the broker + jsonl are the record */ };
    if (this.#memTimer) { clearInterval(this.#memTimer); this.#memTimer = null; }
  }

  async close(reason = 'closed'): Promise<void> {
    if (this.closed) return;
    /*
     * FEAT-057 — RECORD BEFORE TEARING DOWN. This is the choke point every
     * death routes through (the reaper, the transport-failure path in `#run`,
     * a container kill, an explicit close mid-turn), and it is the last moment
     * at which the server still knows what was in flight. Recording here is
     * what makes a killed agent's outcome survive with NO orchestrator turn in
     * between: the ledger is on disk before the bridge stops existing.
     */
    this.#recordSessionEnd(`the session ended while work was in flight (${reason})`);
    this.closed = true;
    this.busy = false;
    this.turnStartedAt = null; // BUG-033: a cleared busy clears its clock
    // Released here, not only at shutdown: the map used to retain every session
    // ever started for the life of the process.
    sessions.delete(this.id);
    /*
     * BUG-034 — the empty snapshot, pushed SYNCHRONOUSLY. `close()` awaits the
     * pump below and a half-dead stream is precisely a pump that never settles
     * (see `reapAsZombie`), so anything published after the await may never go
     * out. This is the frame that empties a tab which lived through the cut,
     * and it carries the freshly-recorded outcomes that say why.
     */
    this.pushRunningSnapshot(true);
    if (this.#memTimer) { clearInterval(this.#memTimer); this.#memTimer = null; }
    if (this.#detachedCloseTimer) { clearTimeout(this.#detachedCloseTimer); this.#detachedCloseTimer = null; } // BUG-043
    // Fallback for a session that died before system:init ever arrived.
    this.#dropStaged('session closed');
    for (const [, p] of this.#approvals) p.resolve({ behavior: 'deny', message: 'session closed' });
    this.#approvals.clear();
    this.#runtime.close();
    /*
     * A genuine close must actually terminate a survivable CLI. The SDK's
     * transport teardown only DISCONNECTS the broker socket (so a mere
     * server-shutdown handoff leaves the CLI running); reaping the broker here
     * is what sends the CLI a graceful stdin-EOF so its current turn drains and
     * it exits. Idempotent and a no-op once the broker is already gone.
     */
    if (this.#survivalHandle) {
      try { this.#survivalHandle.reap(); } catch { /* broker already gone */ }
    }
    try {
      await this.#pump;
    } catch {
      /* pump errors already surfaced as events */
    }
    // Container sessions: the CLI inside normally exits on stdin EOF, but only
    // once its in-flight tool call returns. Killing the host-side `docker exec`
    // client does NOT reach into the container, so a tool that never returns
    // would strand the process. Sweep for it after a grace window; a no-op when
    // it already exited on its own (the common case).
    if (this.#execId) {
      const execId = this.#execId;
      const project = this.project;
      setTimeout(() => {
        try {
          const n = reapExec(project, execId);
          if (n > 0) console.warn(`[orchard] reaped ${n} stranded exec(s) for session ${this.id} in ${containerName(project.id)}`);
        } catch {
          /* container already gone — nothing to reap */
        }
      }, 15_000).unref();
    }
    this.#emit({ t: 'session-closed', reason });
  }

  /**
   * BUG-043 / ARCH-002 — DOES LIVE WORK EXIST HERE THAT OUTLIVES THIS TURN?
   *
   * The question `busy` was asked and could not answer. `busy` is TURN-scoped:
   * it goes false at `result` while a background subagent keeps working, so a
   * session with live background agents read as IDLE and a socket drop CLOSED
   * it — reaping the broker, whose unconditional SIGTERM landed 150s later and
   * killed the agent (measured 3/3, 150.1/149.2/150.0s; BUG-043's arm C).
   *
   * The answer comes from what the ENGINE declared, never from a local guess:
   *  - `backgroundLifetime: 'reported'` (Claude) — `background_tasks_changed` is
   *    a LEVEL: the ids in it are the background work alive right now, and an
   *    EMPTY level is a real negative, so both `yes` and `no` are evidenced.
   *  - `backgroundLifetime: 'absent'` — the engine says nothing. `no` is still
   *    returnable where NO unit of agent work was ever created in this CLI
   *    process (nothing exists, so nothing can outlive anything — an
   *    observation, not an inference); otherwise the honest answer is `unknown`
   *    and callers must state their bias rather than coerce it (ARCH-002).
   *
   * NOT a liveness verdict: this never claims a process is alive or dead —
   * `liveness.ts` remains the single authority for that (ARCH-001). It answers
   * the orthogonal lifetime question, which is precisely what nothing answered.
   */
  workLifetime(): WorkLifetime {
    const ids = [...this.#backgroundTasks.keys()];
    if (ids.length > 0) {
      return {
        outlivesTurn: 'yes',
        detail: `the engine reports ${ids.length} background task(s) still running (${ids.join(', ')})`,
        ids,
      };
    }
    if (this.#runtime.capabilities.backgroundLifetime === 'reported') {
      /*
       * Pre-signal race (review finding 1): a background dispatch was OBSERVED
       * going out but the engine's level frame has not arrived yet (it lags the
       * `result` by seconds). The empty set is not yet authoritative — answer
       * `unknown` so the close decision detaches. Bounded: if no level frame
       * ever arrives (the dispatch was refused / ran foreground), the window
       * expires and the empty level is trusted again — no unbounded leak.
       */
      if (this.#bgDispatchAt != null && Date.now() - this.#bgDispatchAt < 120_000) {
        return {
          outlivesTurn: 'unknown',
          detail:
            'a background dispatch was observed ' +
            `${Math.round((Date.now() - this.#bgDispatchAt) / 1000)}s ago and the engine's ` +
            'background-task level has not reported since — the empty level is not authoritative yet',
          ids: [],
        };
      }
      return {
        outlivesTurn: 'no',
        detail: 'the engine reports no background task is running',
        ids: [],
      };
    }
    /*
     * `backgroundLifetime: 'absent'` (Codex today). The engine never says which
     * work outlives a turn, so the only honest evidence is the agent rows the
     * bridge itself tracks: a row still `running` is work the engine has not
     * settled and cannot classify — `unknown` (biased to detach; see the
     * releaseSocketSession comment). Once every row has settled there is no
     * evidence of any work at all, let alone work outliving the turn — and an
     * engine with no background-dispatch concept cannot have created any — so
     * the answer is `no`, and an idle session closes exactly as before this fix
     * (review finding 4: the earlier ever-started-work latch made `unknown`
     * PERMANENT for any codex session that ever ran an agent — a forever-leak,
     * removed in favour of this row-based evidence).
     */
    const running = [...this.#agents.values()].filter((a) => a.status === 'running');
    if (running.length > 0) {
      return {
        outlivesTurn: 'unknown',
        detail:
          `this engine does not report which work outlives a turn, and ${running.length} agent ` +
          `row(s) are still running (${running.map((a) => a.agentId).join(', ')})`,
        ids: running.map((a) => a.agentId),
      };
    }
    return {
      outlivesTurn: 'no',
      detail: 'this engine reports no background lifetime, and no agent work is running',
      ids: [],
    };
  }

  /**
   * BUG-043 — the close-on-detach fuse, made lifetime-aware and BOUNDED.
   *
   * A detached session that has finished its turn should close (that is what
   * keeps detach from leaking CLIs), but only once nothing survives the turn.
   * This is a re-checking LOOP, not a one-shot (review finding 3): while the
   * lifetime is `yes`/`unknown` the fuse declines to close and re-arms, so a
   * lost `background_tasks_changed` empty-level frame, a stuck task id, or an
   * `unknown` that never resolves can not hold the session open past its
   * process's actual life — every recheck also consults the GROUND TRUTH probe
   * (the session's survival-handle rung of the liveness authority; nothing is
   * re-derived here), and a dead process closes immediately whatever the
   * lifetime claim says: a dead CLI cannot be running background work. A LIVE
   * process with a `yes`/`unknown` lifetime stays open indefinitely, on
   * purpose — reaping live work on a stale claim is this ticket's defect.
   */
  #armDetachedClose(delayMs = 3_000): void {
    if (this.#detachedCloseTimer || this.closed) return;
    this.#detachedCloseTimer = setTimeout(() => {
      this.#detachedCloseTimer = null;
      if (!this.detached || this.busy || this.closed) return;
      const lifetime = this.workLifetime();
      if (lifetime.outlivesTurn === 'no') {
        void this.close('finished while detached');
        return;
      }
      if (this.processProbe().state === 'dead') {
        void this.close(`finished while detached (work lifetime was ${lifetime.outlivesTurn}, but the process is gone)`);
        return;
      }
      this.#armDetachedClose(30_000);
    }, delayMs);
  }

  liveAgents(): LiveAgent[] {
    return [...this.#agents.values()];
  }

  /**
   * BUG-046 — a LIVE PROCESS SIGNAL for one agent row, or null when none
   * exists. Consumed by the stall judgment (`running-set.ts` → `stalls.ts`):
   * a row the engine's background-task level still lists is vouched for by the
   * engine itself and is never marked stalled, however silent its frames are —
   * the level has REPLACE semantics (every frame supersedes the whole set), so
   * a task that dies is removed by the engine's next level frame. Rows the
   * level does not list have no per-row process signal (the engine exposes no
   * pid for them), and the honest answer is null: the judgment then rests on
   * frame-progress evidence alone. NOT a liveness verdict (ARCH-001): this
   * reports what the engine SAID, and never claims a process is alive or dead.
   */
  stallSignalFor(agentId: string): { live: boolean; detail: string } | null {
    if (this.#backgroundTasks.has(agentId)) {
      return {
        live: true,
        detail: `the engine's background-task level currently lists this task as running`,
      };
    }
    // BUG-068: a lane born from a run_in_background dispatch is a background lane
    // even before the level lists it — vouch for it so the stall detector does
    // not flag the seconds-long pre-level window as a silent death.
    if (this.#bgBornTasks.has(agentId)) {
      return {
        live: true,
        detail: `this task was dispatched with run_in_background; the engine's background-task level has not listed it yet`,
      };
    }
    return null;
  }

  /**
   * ARCH-003 — is THIS lane's OWNER a background AGENT that is live right now?
   *
   * The turn-end `result` sweep spares a live background agent's own lane, but it
   * must ALSO not fabricate a death for that agent's FOREGROUND child bash — a
   * separate task id, a `kind:'tool'` row. Its owner is on the frames the bridge
   * already parses: the assistant frame that issued the child's tool_use carries
   * the agent's `parent_tool_use_id`, which `case 'assistant'` resolves and stores
   * (`#toolUseOwner`) and `task_started` stamps onto `LiveAgent.owner`. So the
   * sweep no longer asks the GLOBAL "is ANY background agent live" (which
   * over-suppressed: a genuine MAIN-THREAD orphan's honest death was swallowed
   * whenever any background agent happened to be live) — it asks this, per row.
   *
   * `owner` null ⇒ the main thread issued the call ⇒ NOT a background child ⇒
   * never spared here (its death is recorded honestly). A non-null owner is
   * checked against the AUTHORITATIVE background sources, not `#agents`:
   *  - `#backgroundTasks` — the engine's `background_tasks_changed` LEVEL frame
   *    (REPLACE semantics, so membership == running right now), carrying each
   *    task's kind. Closes the two `#agents`-invisible shapes: a resume/re-attach
   *    agent the level lists with NO `task_started` row, and a `skip_transcript`
   *    `task_started` that returns before the row exists.
   *  - `#bgBornTasks` — a `run_in_background` dispatch KNOWN to be an agent before
   *    the level lists it (BUG-068). A born lane always has an `#agents` row (its
   *    `task_started` created it), so its liveness IS that row still running: a
   *    retired born agent is not a live parent (the RETIRED anti-over-suppression
   *    case).
   *
   * A background BASH (`kind:'tool'`) is a sibling LEAF, never an owner, so it
   * never licenses suppression (the BUG-096 first-fix BROKEN verdict). NOT an
   * ARCH-001 liveness verdict: like `workLifetime` this reports the
   * background-WORK membership the engine declared (ARCH-002), never a process
   * up/down claim — `liveness.ts` owns that. The re-attach shape (owner resolves
   * to no KNOWN task id at all) is handled by the caller's degrade, not here.
   */
  #ownerIsLiveBackgroundAgent(owner: string | null | undefined): boolean {
    if (!owner) return false;
    if (this.#backgroundTasks.get(owner) === 'agent') return true;
    if (this.#bgBornTasks.get(owner) === 'agent') {
      const row = this.#agents.get(owner);
      if (row && row.status === 'running') return true;
    }
    return false;
  }

  /**
   * ARCH-003 — the re-attach DEGRADE. When the bridge missed a background agent's
   * `task_started` (a resume/re-attach mid-stream), its child bash's owner is the
   * raw `parent_tool_use_id` fallback from `#agentIdFor` — a tool_use id that maps
   * to no KNOWN task id. `#ownerIsLiveBackgroundAgent` cannot confirm it, but the
   * NON-NULL owner still proves this row is a SUBAGENT's child, not a main-thread
   * orphan — and on real CLI frames a `local_bash` task row for a subagent-issued
   * bash only ever comes from a BACKGROUND agent (a foreground subagent's bash
   * gets no task row at all). So an owner that resolves to nothing we track is
   * spared rather than fabricated — the honest-by-omission side (outcomes.ts
   * 19-25). A main-thread owner is null and never reaches here.
   */
  #ownerIsUntrackedSubagent(owner: string | null | undefined): boolean {
    if (!owner) return false;
    return !this.#agents.has(owner)
      && !this.#backgroundTasks.has(owner)
      && !this.#bgBornTasks.has(owner);
  }

  /**
   * ARCH-003 — THE EVIDENCE FOR RECLAIMING AN OPEN TOOL-CALL RECORD, asked at every
   * turn boundary. This is the fix for the 5th clean-room verdict, and it is
   * deliberately not a sixth repair of a signal route.
   *
   * All five leak verdicts on this surface were one shape: an OPEN record's only route
   * to reclamation was a SIGNAL that might never arrive — the call's `tool_result`
   * (discarded when it preceded its own issue frame), the owner's terminal frame
   * (`ownerEnded`, missed on a re-attach or simply never emitted), the id being
   * re-issued (ids are unique, so it never is). The 5th verdict found one more:
   * `ended` > `reap` > `issued` opens a record for a call that is ALREADY OVER, and
   * every end signal for it is already spent.
   *
   * So this predicate is LEVEL-TRIGGERED, not edge-triggered: it does not care WHETHER
   * or WHEN any frame arrived, only whether the call could still be in flight RIGHT
   * NOW. Two positive sources, both already maintained here:
   *  - THE CALL'S OWN LANE IS TERMINAL. `#agents` is keyed by task id, so the caller
   *    passes a set of the tool_use ids of lanes that are no longer running. A
   *    terminal lane's call is over by definition — and the sweep only ever consults
   *    ownership for a lane that is STILL RUNNING, so removing it cannot change a
   *    verdict.
   *  - THE OWNER IS NO LONGER LIVE. An agent that is not running has no open calls.
   *    Liveness is the union of every source that could still vouch for it (the
   *    engine's background level, the pre-level born tags, a `running` `#agents` row),
   *    so a background agent that merely dropped out of one level frame while its row
   *    still runs is NOT reclaimed — evidence must be positive.
   *
   * ABSENCE OF KNOWLEDGE IS NEVER EVIDENCE. An owner the bridge has never observed is
   * the re-attach degrade: `#ownerIsUntrackedSubagent` SPARES its child, so reclaiming
   * its record would convert a spared child into a FABRICATED death — property (b),
   * the thing that must never be traded for a bound. Untracked ⇒ keep.
   *
   * AND IT IS ASKED ABOUT THE WHOLE OWNERSHIP CHAIN, not the immediate owner — the
   * 6th clean-room verdict, the only one of the six that broke a VERDICT rather than
   * the bound. The previous version's claim ("a record spares only while its OWNER is
   * live, so removing the records whose owner is not live is verdict-neutral") is
   * FALSE for NESTED ownership: a background root dispatches an intermediate agent,
   * the intermediate issues the bash whose lane is still running, and the moment the
   * intermediate reads as terminal — which it can while genuinely working, since the
   * sweep below settles any running lane the engine's background level does not list
   * — the leaf's record satisfied the predicate. It was discarded, ownership then
   * resolved `null`, and the sweep FABRICATED the death of a live call under a live
   * root. So: reclaim only when NOTHING in the ancestry can still be running.
   *
   * VERDICT-NEUTRALITY, stated now as what is actually proved: the sweep spares a
   * running lane whose chain holds a live background agent or an unobserved owner
   * (`#ownershipSpares`), and this removes exactly the records for which no member of
   * the chain is either. The two read the SAME chain, so the bound is bought with
   * nothing — and the failure class that made the old wording false (a live ancestor
   * above a terminal owner) is unrepresentable rather than guarded.
   */
  #callCannotStillBeInFlight(toolUseId: string, ownerChain: string[], terminalLaneCallIds: Set<string>): boolean {
    if (terminalLaneCallIds.has(toolUseId)) return true;
    if (!ownerChain.length) return false;
    return ownerChain.every((rawParent) => this.#ownerPositivelyNotLive(rawParent));
  }

  /**
   * ARCH-003 — POSITIVE evidence that ONE owner in a chain is not running. Every
   * `false` here is "no evidence", never "alive": an owner still on the engine's
   * background level, still carrying a pre-level born tag, or never observed at all
   * keeps its records. Only a KNOWN row in a terminal state is evidence.
   */
  #ownerPositivelyNotLive(rawParent: string): boolean {
    const owner = this.#agentIdFor(rawParent);
    if (!owner) return false;
    if (this.#backgroundTasks.has(owner)) return false;   // the engine still lists it
    if (this.#bgBornTasks.has(owner)) return false;       // known background, pre-level
    const row = this.#agents.get(owner);
    if (!row) return false;                               // untracked — no evidence at all
    return row.status !== 'running';
  }

  /**
   * ARCH-003 — DOES ANYTHING IN THIS LANE'S OWNERSHIP CHAIN LICENSE SPARING IT?
   *
   * The per-row guard, generalised from the immediate owner to the ancestry for the
   * 6th clean-room verdict. An EMPTY chain is a MAIN-THREAD call and is never spared,
   * whatever background work is live — that is direction (a), the over-suppression
   * hole that broke attempts 1 and 3, and it is preserved BY CONSTRUCTION here: a
   * main-thread lane has no ancestry at all, so there is no ancestor for any rule to
   * find. A non-empty chain proves the lane is a subagent's, and it is spared if ANY
   * member of it is a live background agent (spared BY NAME) or is an owner the
   * bridge never observed (the re-attach degrade — honest-by-omission).
   */
  #ownershipSpares(ownerChain: string[]): boolean {
    return ownerChain.some((rawParent) => {
      const owner = this.#agentIdFor(rawParent);
      return this.#ownerIsLiveBackgroundAgent(owner) || this.#ownerIsUntrackedSubagent(owner);
    });
  }

  /**
   * BUG-105 — IS ANY MEMBER OF THIS LANE'S OWNERSHIP CHAIN A LIVE BACKGROUND AGENT?
   *
   * The STRICT half of `#ownershipSpares`, for `kind:'agent'` rows: positive evidence
   * only, no un-observed-owner degrade. A foreground subagent of a live background
   * worker is genuinely running when the MAIN thread's turn ends, and the sweep used
   * to record it dead (probed live: `allEnded=["fgSub:unknown", …]`) — but an AGENT
   * row is the unit the orchestrator's briefing is ABOUT, so silence here costs more
   * than silence over a `local_bash` row. The degrade is therefore not extended:
   * absence of knowledge about an owner spares a possible child bash (justified by the
   * real-CLI fact that a subagent-issued bash only gets a task row from a background
   * agent) but must not silence an agent death.
   *
   * An EMPTY chain is a main-thread lane and can never be spared — direction (a) again
   * by construction. NOT an ARCH-001 liveness verdict: this reads the background-WORK
   * membership the engine declared (ARCH-002), never a process up/down claim.
   */
  #chainHasLiveBackgroundAgent(ownerChain: string[]): boolean {
    return ownerChain.some((rawParent) => this.#ownerIsLiveBackgroundAgent(this.#agentIdFor(rawParent)));
  }

  /**
   * ARCH-003 / BUG-105 — THE RESIDENCY SEAM: what is actually LEFT in the open-call
   * registry after a turn boundary, published where a test can read it.
   *
   * WHY IT EXISTS. Record residency has never been observable outside this process.
   * BUG-105's handoff says so in as many words ("record residency is not observable
   * over HTTP, so the growth-bound guard exercises the predicate's logic given a
   * liveness input"), and two clean-room leak verdicts lived in exactly that blind
   * spot — the server suite could not see them because a resident record's only
   * external effect is to spare a lane whose owner is live, which is indistinguishable
   * from a call genuinely in flight. So the reclamation side of every fix on this
   * surface has been argued from deaths that did NOT happen. This makes it a
   * measurement instead of an inference.
   *
   * WHY A FILE AND NOT AN API. Residency is an internal invariant, not a product fact,
   * and it must not become one: no route, no event, no field any client could come to
   * depend on. Off unless `CLAUDE_STATION_ARCH003_RESIDENCY_LOG` names a path, and
   * failure to write is swallowed — a diagnostic must never be able to affect a turn.
   */
  #publishResidency(at: number): void {
    const target = process.env.CLAUDE_STATION_ARCH003_RESIDENCY_LOG;
    if (!target) return;
    try {
      fs.appendFileSync(target, JSON.stringify({ at, session: this.id, ...this.#openToolCalls.residency() }) + '\n');
    } catch { /* a diagnostic must never break a sweep */ }
  }

  /** What this session is really running with. Also served over HTTP. */
  /** FEAT-037 P3 — the engine's honest capability descriptor, for the UI. */
  get capabilities(): RuntimeCapabilities {
    return this.#runtime.capabilities;
  }

  effectiveConfig(): EffectiveConfig {
    return {
      projectId: this.project.id,
      isolation: this.project.isolation,
      provider: this.effective.provider ?? 'anthropic',
      capabilities: this.#runtime.capabilities,
      effective: { ...this.effective },
      projectDefault: pickOverridable(this.project.settings),
      overridden: [...this.overriddenFields],
      ignoredOverrides: [...this.ignoredOverrides],
      permissionModeSource: this.permissionModeSource,
      instructionMode: this.composed.mode,
      appliedTemplates: [...this.composed.appliedIds],
    };
  }

  /**
   * Fork bookkeeping, for the API and the verification harness. `forked`/
   * `from` are what the UI renders as the "forked from <id>" suffix — this
   * used to return neither field, so that suffix was dead code that never
   * showed for any real fork.
   */
  forkInfo(): (Omit<ForkPlan, 'stagedFile'> & { stagedFile: string | null; stagedRemaining: boolean; forked: true; from: string | null }) | null {
    if (!this.#forkPlan) return null;
    return { ...this.#forkPlan, stagedRemaining: this.#stagedFile !== null, forked: true, from: this.#forkFrom };
  }

  /* --------------------------------------------------------------- internals */

  /**
   * Delete the staged transcript copy. Idempotent. Never touches the original —
   * `#stagedFile` is always a path we created inside the target store dir.
   */
  #dropStaged(why: string): void {
    const f = this.#stagedFile;
    if (!f) return;
    this.#stagedFile = null;
    if (discardStaged(f)) {
      this.#emit({ t: 'status', status: `fork: staged transcript copy removed (${why})` });
    } else {
      // Loud, not silent: a leftover copy would show up as a phantom session.
      console.warn(`[orchard] could not remove staged fork copy ${f} (${why})`);
      this.#emit({ t: 'error', message: `fork: staged transcript copy left behind at ${f}`, fatal: false });
    }
  }

  /*
   * HOW A QUESTION IS ANSWERED — established by reading the SDK/CLI and then by
   * running it, not by assumption.
   *
   * 1. `AskUserQuestion` is an ORDINARY TOOL. It surfaces as a normal
   *    `tool_use` block AND as a `can_use_tool` control request, i.e. right
   *    here in `canUseTool`. It does NOT use `onUserDialog` /
   *    `request_user_dialog`: that callback was wired up with
   *    `supportedDialogKinds: ['permission_ask_user_question',
   *    'permission_exit_plan_mode_v2']` and never fired once across every probe
   *    run. (Those dialog kinds are what the CLI's own terminal UI renders; the
   *    SDK transport uses the permission request instead. The CLI bundle shows
   *    the two speaking the same language: its TUI answers a question with
   *    `answer(id, {behavior:'allow', updatedInput:{...input, answers:{…}}})`.)
   *
   * 2. The ANSWER travels back as the permission result's `updatedInput`:
   *      { behavior: 'allow',
   *        updatedInput: { ...input, answers: { "<question text>": "<label>" } } }
   *    keyed by the exact question text. The CLI validates that against
   *    AskUserQuestion's own input schema, and the tool then returns the answers
   *    to the model.
   *
   * 3. WHAT WENT WRONG BEFORE: a bare allow echoing the input unchanged is
   *    accepted — it just carries no `answers`. The tool then returns
   *    "The user did not answer the questions." and the model proceeds on a
   *    guess. That is exactly the observed "No answer, so I'll plan the
   *    conservative path…". It does NOT block and does NOT time out; it
   *    resolves empty. Answering with the second option instead produced
   *    "Your questions have been answered: "…"="Emerald"" and the model's next
   *    message was "FINAL CHOICE = Emerald".
   *
   * 4. `ExitPlanMode` shares this channel exactly: same `canUseTool`, allow ⇒
   *    "User has approved your plan", deny ⇒ the model keeps planning. It needs
   *    no `updatedInput.answers`, only the verdict.
   *
   * 5. `bypassPermissions` does NOT skip either of them. The SDK warns that
   *    canUseTool is shadowed in that mode, but AskUserQuestion still arrived at
   *    the callback and still accepted its answer — verified live. So container
   *    sessions (which default to bypass) can be asked questions too.
   *
   * Both are split out of `approval-request` deliberately. Rendering a question
   * as Allow/Deny is not a smaller version of the right UI, it is the wrong
   * answer: "Allow" would send no answer at all.
   */
  #onCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    o: RuntimeApprovalMeta,
  ): Promise<ApprovalResult> {
    return new Promise<ApprovalResult>((resolve) => {
      const requestId = o.requestId;
      const toolUseId = o.toolUseID ?? '';
      const agentId = o.agentID ?? null;
      let settled = false;
      const once = (r: ApprovalResult) => {
        if (settled) return;
        settled = true;
        this.#approvals.delete(requestId);
        resolve(r);
      };

      const questions = toolName === QUESTION_TOOL ? parseQuestionInput(input) : [];
      const plan = toolName === PLAN_TOOL ? parsePlanInput(input) : '';
      // A question we cannot parse falls back to the generic approval card
      // rather than rendering an empty one — the user still sees the raw input
      // and can let it through, which is strictly better than a blank prompt.
      const kind: PendingKind = questions.length ? 'question' : plan ? 'plan' : 'approval';

      // Build the announce event ONCE and keep it on the pending entry, so a
      // re-attaching socket can be shown the very same card (BUG-008). The
      // request lives only in memory here — it is NOT in the transcript file,
      // so a file-follower could never surface it; replay is the only way back.
      const event: StationEvent =
        kind === 'question'
          ? { t: 'question-request', requestId, toolUseId, questions, input, agentId }
          : kind === 'plan'
            ? { t: 'plan-request', requestId, toolUseId, plan, input, agentId }
            : { t: 'approval-request', requestId, toolName, input, title: o.title, description: o.description, agentId };

      this.#approvals.set(requestId, { kind, resolve: once, toolName, toolUseId, input, event });
      /*
       * Abort = the turn was interrupted or the query died while this was
       * pending. Deny is the only safe resolution: the tool must not run, and
       * for a question there is no answer to give. The UI learns the card never
       * settled from the tool-result that follows.
       */
      o.signal.addEventListener('abort', () => once({ behavior: 'deny', message: 'aborted' }), { once: true });

      this.#emit(event);
    });
  }

  /** Resolve `parent_tool_use_id` to a known agent id where possible. */
  #agentIdFor(parentToolUseId: string | null | undefined): string | null {
    if (!parentToolUseId) return null;
    return this.#toolUseToAgent.get(parentToolUseId) ?? parentToolUseId;
  }

  #agentTypeFor(agentId: string | null): string | undefined {
    if (!agentId) return undefined;
    return this.#agents.get(agentId)?.agentType;
  }

  /** Plain-words OOM verdict for this session's container, or null. */
  #oomWhy(): string | null {
    if (!this.containerName) return null;
    try { return oomExplanation(this.project, this.#oomBaseline); } catch { return null; }
  }

  /** Quiet near-limit warning — once per crossing, resets below 80%. */
  #checkMemory(): void {
    if (this.closed || !this.containerName) return;
    let ms: MemoryStatus;
    try { ms = memoryStatus(this.project); } catch { return; }
    if (this.#oomBaseline === null && ms.oomKills !== null) this.#oomBaseline = ms.oomKills;
    if (ms.currentBytes === null || ms.limitBytes === null) return;
    const frac = ms.currentBytes / ms.limitBytes;
    const mb = (n: number) => Math.round(n / (1024 * 1024));
    if (frac >= 0.9 && !this.#memWarned) {
      this.#memWarned = true;
      this.#emit({
        t: 'status',
        status: `container memory ${mb(ms.currentBytes)} of ${mb(ms.limitBytes)} MB (${Math.round(frac * 100)}%) — near the limit; at 100% the kernel kills the session`,
      });
    } else if (frac < 0.8 && this.#memWarned) {
      this.#memWarned = false; // re-arm so the NEXT climb warns again
    }
  }

  async #run(): Promise<void> {
    try {
      for await (const msg of this.#runtime.messages()) this.#handle(msg);
      // Normal end of stream (the CLI exited). If we did not ask for that, the
      // session is over — fall through to the same teardown as an error.
      // FEAT-057: record BEFORE `busy` is cleared. `close()` is the general
      // choke point, but by the time it runs on this path the turn's own claim
      // is already gone, and a main turn that died with the stream would be
      // recorded as nothing at all.
      this.#recordSessionEnd('the engine stream ended while work was in flight');
      this.busy = false;
      this.turnStartedAt = null; // BUG-033: a cleared busy clears its clock
      if (!this.closed) {
        const oom = this.#oomWhy();
        if (oom) this.#emit({ t: 'error', message: oom, fatal: true });
        void this.close(oom ?? 'agent process ended');
      }
    } catch (err) {
      /*
       * The query is DEAD here: the CLI exited, the container was killed, the
       * transport broke. Previously this only emitted a fatal error and left the
       * object alive — `busy` stuck true, prompts piling into an InputQueue with
       * no reader, and every later `send` acked as if it had worked. Observed
       * live by killing a session's container: turn 2 acked "success" and then
       * silence forever, turn 3 said "a turn is already running".
       *
       * So: report it, then tear the session down for real. Subsequent sends hit
       * `session is closed` and the UI gets `session-closed`.
       */
      // FEAT-057: recorded while `busy` is still true — see the sibling call above.
      this.#recordSessionEnd(`the engine transport failed while work was in flight (${(err as Error).message})`);
      this.busy = false;
      this.turnStartedAt = null; // BUG-033: a cleared busy clears its clock
      if (!this.closed) {
        const raw = (err as Error).message;
        // Name an OOM kill for what it was: "exited with code 137" is the
        // baffling symptom, the memory limit is the cause.
        const oom = this.#oomWhy();
        this.#emit({ t: 'error', message: oom ? `${oom} (underlying error: ${raw})` : raw, fatal: true });
        void this.close(oom ? 'container OOM-killed the session' : `agent transport failed: ${raw}`);
      }
    }
  }

  #handle(msg: RuntimeMessage): void {
    const m = msg as Record<string, any>;
    /*
     * BUG-033 — the evidence behind `busy`. EVERY inbound frame counts (deltas,
     * tool progress, subagent chatter, system notices), stamped before any
     * branch below can `return` early, so the frameless window measures real
     * engine silence and nothing else.
     */
    this.lastFrameAt = Date.now();
    /*
     * BUG-031 — provider/API error relay. The RUNTIME owns the mapping from
     * its engine's native failure dialect to the provider-agnostic
     * `ProviderError` (see runtime.ts); the bridge only relays a non-null
     * classification as a `provider-error` StationEvent. Guard: an interrupt
     * WE requested surfaces as the same `result` error subtype as a genuine
     * failure — never report the user's own Stop as a provider error.
     */
    const pe = this.#runtime.classifyProviderError?.(msg);
    if (pe && !(m.type === 'result' && this.#interruptRequested)) {
      this.#emit({ t: 'provider-error', ...pe });
      /*
       * FEAT-057 — LATCH it as evidence for this turn. `retrying` means the
       * engine is still trying and the turn is alive, so it is not (yet) a
       * cause of death; a terminal one is exactly what the outcome record and
       * the authority's `ended` slot quote when this turn stops. Recorded as
       * received — never re-classified here.
       *
       * BUG-041 — `pending` is ALSO not a cause: BUG-035's "MCP tool server
       * still starting" notice is deliberately non-fatal (the capability
       * attaches after turn one) and CANNOT kill a turn. Latching it here is
       * exactly how a live completed turn got reported as "ended without
       * completing — tooling-unavailable". It is remembered separately, as
       * quotable CONTEXT for records whose real cause is unknown.
       */
      if (pe.pending) {
        this.#advisoryNotice = `${pe.kind} (${pe.provider}) notice was active — "${pe.detail}" — advisory, still attaching; cannot end a turn`;
      } else if (outcomes.isTerminalCause(pe)) {
        const turnStart = this.turnStartedAt ?? Date.now();
        this.lastProviderError = {
          kind: pe.kind,
          provider: pe.provider,
          detail: pe.detail,
          retryable: pe.retryable,
          // Epoch seconds or ms depending on the engine — normalised in ONE
          // place (outcomes.resetsAtMs) so no renderer has to guess.
          resetsAt: outcomes.resetsAtMs(pe.resetsAt),
        };
        /*
         * FEAT-057 gap #2 — the engines settle their agents BEFORE saying why
         * the turn failed (probed, not assumed: the fixture and the real Codex
         * path both emit `task_updated killed` for every open agent and only
         * then the failed `turn/completed`). So the deaths of THIS turn are
         * already on disk as bare `killed`/`failed` rows by the time the cause
         * arrives. Attach it to them — bounded to this turn, and additive: the
         * engine's own word about the agent is kept, the turn's failure is
         * added as the context it happened in.
         */
        try { outcomes.attachProviderError([this.id, this.sdkSessionId], turnStart, this.lastProviderError); }
        catch { /* the ledger must never break a turn */ }
      }
    }
    // FEAT-037 P2b: Orchard-owned capture — persist every renderable frame in
    // the Claude-store entry shape (the recorder filters to main-thread
    // assistant/user content itself). BEFORE the switch so no early `return`
    // below can drop a frame from the durable record.
    this.#recorder?.recordRuntimeMessage(m);
    switch (m.type) {
      case 'system':
        return this.#handleSystem(m);

      case 'assistant': {
        const agentId = this.#agentIdFor(m.parent_tool_use_id);
        const agentType = this.#agentTypeFor(agentId) ?? m.subagent_type;
        /*
         * FEAT-042 — surface the wire model that ACTUALLY produced this
         * message. Main thread only (subagents legitimately run other models),
         * skipping synthetic frames (the CLI stamps e.g. '<synthetic>' on
         * messages no API model produced), deduped so a long turn does not
         * spam an event per message. This is the per-turn ground truth behind
         * the always-visible model chip: a provider-side switch that has no
         * dedicated notification still shows up here the moment the new model
         * speaks.
         */
        if (m.parent_tool_use_id == null && typeof m.message?.model === 'string'
            && m.message.model && !m.message.model.startsWith('<')
            && m.message.model !== this.#lastWireModel) {
          this.#lastWireModel = m.message.model;
          this.#emit({ t: 'model-observed', model: m.message.model });
        }
        /*
         * BUG-031: a terminal API failure arrives as a SYNTHETIC assistant
         * frame whose text block is the provider's error message ("API Error:
         * 529 Overloaded…"). That text just went out verbatim as the
         * `provider-error` detail above — do not ALSO emit it as ordinary
         * assistant text, which renders as if the model said it.
         */
        if (m.is_api_error_message === true) return;
        for (const block of (m.message?.content ?? []) as Record<string, any>[]) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.length) {
            this.#emit({ t: 'text', text: block.text, agentId, agentType });
          } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            // Thinking text is empty by design — only the token estimate is real.
            this.#emit({ t: 'thinking-tokens', tokens: 0, agentId });
          } else if (block.type === 'tool_use') {
            // ARCH-003: this frame OPENS a tool call, and its `parent_tool_use_id`
            // says who issued it — non-null ⇒ a subagent, null ⇒ the main thread.
            // That is the whole write: the call joins (or leaves) the set of open
            // subagent calls. Nothing is stamped onto a lane here, so there is no
            // moment at which a wrong owner can be frozen onto a row, and the lane's
            // `task_started` may arrive before or after this frame — the sweep reads
            // the registry later, not a value captured at either frame.
            //
            // The MAIN-THREAD branch is not a special case bolted on: re-issuing an
            // id is itself evidence that any earlier call under that id is over, so
            // the entry is dropped for the same reason every other entry is dropped.
            // It is also what keeps id reuse safe in the dangerous direction — a main
            // lane can never resolve to a stale subagent owner and have its genuine
            // death suppressed.
            if (m.parent_tool_use_id != null) {
              this.#openToolCalls.issuedBySubagent(String(block.id), String(m.parent_tool_use_id));
            } else {
              this.#openToolCalls.issuedByMainThread(String(block.id));
            }
            // BUG-043 pre-signal race: a dispatch that will become a background
            // task (Task agents and background Bash both) is visible HERE,
            // seconds before the engine's level frame reports it. Record the
            // sighting so workLifetime() refuses to trust the still-empty level
            // in between (cleared by any level frame; bounded by a window).
            if ((block.input as Record<string, unknown> | undefined)?.run_in_background === true) {
              this.#bgDispatchAt = Date.now();
              // BUG-068: remember WHICH dispatch, so its task_started (same
              // tool_use_id) can be tagged a background lane before the level
              // frame arrives — the sweep must not fabricate a death for it.
              this.#bgDispatchToolUseIds.add(String(block.id));
            }
            this.#emit({
              t: 'tool-call',
              toolUseId: String(block.id),
              name: String(block.name),
              input: block.input,
              agentId,
              agentType,
            });
          }
        }
        return;
      }

      case 'user': {
        const agentId = this.#agentIdFor(m.parent_tool_use_id);
        const content = m.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content as Record<string, any>[]) {
          if (block.type !== 'tool_result') continue;
          /*
           * BUG-041 — a tool_result for a Task call IS the agent's delivered
           * final report: evidence of completion, whatever terminal frame does
           * or does not follow. The turn-boundary sweep consults this so an
           * agent that finished and said so is never logged as a death.
           */
          const finished = this.#toolUseToAgent.get(String(block.tool_use_id));
          if (finished && block.is_error !== true) this.#resultDelivered.add(finished);
          /*
           * ARCH-003 — this tool call is OVER. That is the positive evidence the
           * open-call registry reclaims on, and it is why no cap is needed: the
           * entries that used to leak (a FOREGROUND subagent's tool call, which
           * never produces a `task_started`) do produce this frame like any other
           * call, so they are reclaimed by the same rule rather than evicted by a
           * size policy that could not tell them from a live child's.
           */
          this.#openToolCalls.ended(String(block.tool_use_id));
          this.#emit({
            t: 'tool-result',
            toolUseId: String(block.tool_use_id),
            isError: block.is_error === true,
            preview: previewOf(block.content),
            agentId,
          });
        }
        return;
      }

      case 'tool_progress':
        this.#emit({
          t: 'tool-progress',
          toolUseId: String(m.tool_use_id),
          name: String(m.tool_name),
          elapsedSeconds: Number(m.elapsed_time_seconds ?? 0),
          agentId: this.#agentIdFor(m.parent_tool_use_id),
        });
        return;

      case 'stream_event': {
        // parent_tool_use_id is ALWAYS null here — deltas are main-thread only.
        const ev = m.event as Record<string, any> | undefined;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          this.#emit({ t: 'text-delta', text: String(ev.delta.text ?? '') });
        }
        return;
      }

      case 'rate_limit_event': {
        const info = m.rate_limit_info ?? {};
        this.#emit({
          t: 'rate-limit',
          status: String(info.status ?? 'unknown'),
          rateLimitType: info.rateLimitType,
          utilization: info.utilization,
          resetsAt: info.resetsAt,
        });
        return;
      }

      case 'result': {
        const interrupted = this.#interruptRequested;
        this.#interruptRequested = false;
        this.busy = false;
        this.turnStartedAt = null; // BUG-033: a cleared busy clears its clock
        if (typeof m.total_cost_usd === 'number') this.totalCostUsd += m.total_cost_usd;
        /*
         * BUG-037 — "any agent still running at turn end has ended" was FALSE,
         * and it was the whole defect.
         *
         * A BACKGROUND subagent outlives the turn that dispatched it: the
         * orchestrator's `result` fires, the agent keeps working, and its real
         * terminal frame (task_updated / task_notification, both handled below
         * with the ENGINE's own word) arrives during a later turn. This sweep
         * settled it as `completed` and wrote an `unknown`/`provider-error`
         * DEATH for it anyway — a fabricated end for a process that was still
         * running, which is the §C failure this ledger exists to avoid.
         *
         * Measured on 2026-08-10 (three clusters, ticket BUG-037): four agents
         * recorded dead here kept appending to their own transcripts for 229s,
         * 361s, 575s and 629s afterwards; two of them were still running at
         * diagnosis time and all four landed their commits. The false record
         * then reached the orchestrator through `takeBriefing()` as "N agents
         * ended without completing", so it abandoned and re-dispatched work
         * that was live — the defect paid for itself twice.
         *
         * The engine tells us which ids are background; skip exactly those and
         * leave them to their own terminal frame. Foreground agents (BUG-030's
         * `local_bash` rows included) are settled here exactly as before —
         * nothing may keep spinning past a `result` that really did contain it.
         */
        /*
         * BUG-041 — everything this boundary writes is ONE moment: a single
         * `result` sweeping several rows is one host-level event, not N
         * independent deaths. One timestamp + one cluster id, so reporting
         * surfaces can say so instead of narrating a same-millisecond cluster
         * as separate failures.
         */
        const sweepAt = Date.now();
        const sweepCluster = `turn-end-${sweepAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        /*
         * ARCH-003 — IS THIS ROW'S OWNER A LIVE BACKGROUND AGENT? A background
         * agent (spared by the `continue` below) can have spawned a FOREGROUND
         * `local_bash` — a SEPARATE task id, a `kind:'tool'` row that is never
         * tagged background. Recording a death for it fabricated one for a step
         * that then SUCCEEDED (death written 3.2s before the successful
         * tool_result) and briefed the orchestrator to distrust/re-dispatch live
         * work (BUG-037 harm).
         *
         * The parentage the three prior BUG-096 fixes believed unavailable IS on
         * the frames (confirmed on real CLI 2.1.220): the child bash's tool_use
         * rides an assistant frame carrying the owning agent's `parent_tool_use_id`
         * BEFORE its `task_started`, so `LiveAgent.owner` is now stamped per row.
         * The guard is therefore PER ROW, not the old global "is any background
         * agent live" — which over-suppressed, swallowing a genuine main-thread
         * orphan's honest death whenever any background agent happened to be live.
         *   - `owner` null (a MAIN-THREAD call) is NEVER spared — its death records.
         *   - `owner` a live background agent (`#ownerIsLiveBackgroundAgent`) IS
         *     spared — the child of a still-working worker.
         *   - `owner` that resolves to no tracked task (the re-attach DEGRADE,
         *     `#ownerIsUntrackedSubagent`) is spared too: a non-null owner proves a
         *     subagent issued it, and a `local_bash` task row for a subagent bash
         *     only ever comes from a background agent — honest-by-omission, never a
         *     fabrication. The row still SETTLES below (BUG-030: nothing spins past
         *     `result`); only the death write is held.
         */
        for (const a of this.#agents.values()) {
          // BUG-037: a lane the engine's level lists as background outlives this
          // turn — leave it to its own terminal frame. BUG-068: so does one the
          // level has not caught up on yet but that we KNOW is background because
          // it was born from a run_in_background dispatch — otherwise the sweep
          // fabricates a death for it and evicts its still-running row.
          if (a.status === 'running'
              && (this.#backgroundTasks.has(a.agentId) || this.#bgBornTasks.has(a.agentId))) continue;
          /*
           * BUG-105 — A SUBAGENT ROW WHOSE OWNER IS STILL WORKING IS NOT CONTAINED BY
           * THIS TURN EITHER, AND THIS TURN'S END IS NOT ITS BOUNDARY.
           *
           * The shape, probed live on the real bridge (`allEnded=["fgSub:unknown", …]`):
           * a background worker — spared by the `continue` above — dispatches its OWN
           * subagent in the FOREGROUND. That subagent gets a `kind:'agent'` lane the
           * engine's background level never lists, because it is not background work;
           * it is a child of work that is. The main thread's `result` then settled the
           * row and wrote an `unknown` DEATH for an agent that was still working.
           * ARCH-003 already resolves ownership per row and holds the death of a lane
           * whose CHAIN holds a live background agent — but only for `kind:'tool'`
           * rows, because BUG-096's incident was a child BASH. Ownership liveness is a
           * fact about the CHAIN, not about the row's kind; the restriction was the bug.
           *
           * WHY A `continue` RATHER THAN THE `kind:'tool'` TREATMENT (settle, hold only
           * the ledger write). A `local_bash` row is a tool call the engine will close
           * with its own notification, and BUG-030 requires it not to spin past a
           * `result`; that carve-out is preserved verbatim below. An AGENT row is not a
           * tool call — settling it is itself a report that live work ended (the row
           * leaves the live strip), and it has a second-order cost proved by this
           * ticket's guard: a settled lane is terminal EVIDENCE to the reap, so the
           * subagent's ownership record is dropped and the next bash it issues has its
           * own death fabricated on a truncated chain — the ARCH-003 6th verdict,
           * re-entered through this door.
           *
           * POSITIVE EVIDENCE ONLY, AND RE-ASKED EVERY BOUNDARY — this is what stops it
           * being a blanket over the `kind:'agent'` row class:
           *  - a MAIN-THREAD subagent has an EMPTY chain and is NEVER spared, so the
           *    common case (the orchestrator's own foreground subagents) is untouched
           *    and property (a) is preserved by construction;
           *  - the un-observed-owner DEGRADE (`#ownerIsUntrackedSubagent`) is
           *    deliberately NOT extended here. Its justification is kind-specific — the
           *    real-CLI capture that a subagent-issued bash only ever gets a task row
           *    from a BACKGROUND agent — and no equivalent fact licenses silencing a
           *    whole class of AGENT deaths on absence of knowledge;
           *  - the spare is LEVEL-triggered: the moment nothing in the chain is a live
           *    background agent, the next sweep settles the row and records its honest
           *    death. A death here is DEFERRED, never lost;
           *  - a genuine death that has real evidence never comes through this path at
           *    all — the agent's own terminal frame records it (`#recordAgentEnd`)
           *    whatever the owner is doing.
           */
          if (a.status === 'running' && a.kind === 'agent'
              && this.#chainHasLiveBackgroundAgent(this.#openToolCalls.ownerChainOf(a.toolUseId))) continue;
          if (a.status === 'running') {
            a.status = interrupted ? 'killed' : 'completed';
            a.elapsedMs = Date.now() - a.startedAt;
            this.#emit({ t: 'agent-completed', agent: { ...a } });
            /*
             * FEAT-057/BUG-041 — the OUTCOME is not the display status. The row
             * settles (BUG-030's invariant: nothing may keep spinning past a
             * `result`) while what is RECORDED is `outcomes.turnEndOutcome`'s
             * decision on the evidence: a delivered Task tool_result means the
             * agent finished — record NOTHING (a completion is not a death); a
             * user's interrupt is `killed`; a terminal provider error names
             * itself; anything else is the honest `unknown`, with any advisory
             * MCP notice quoted as context, never as cause.
             */
            const decision = outcomes.turnEndOutcome({
              interrupted,
              resultDelivered: this.#resultDelivered.has(a.agentId),
              lastProviderError: this.lastProviderError,
              advisoryNotice: this.#advisoryNotice,
            });
            // ARCH-003: a `kind:'tool'` lane (a `local_bash`) is settled here but
            // its DEATH is held only when THIS row's owner is (or, on re-attach,
            // could only be) a live background agent whose foreground child it is.
            // A main-thread orphan (owner null) always records; a live background
            // BASH owner never arises (a bash is a leaf, not an owner). The row
            // still settled above; only the write is held.
            //
            // ARCH-003: the owner is RESOLVED HERE, at the only moment it is needed,
            // from the calls that are open right now — never read off a field stamped
            // onto the row earlier. `parentOf` returns the issuing subagent's raw
            // `parent_tool_use_id` (null ⇒ the main thread issued it), and
            // `#agentIdFor` maps it to a task id NOW, so an owner whose own
            // `task_started` arrived after its child's frame still resolves.
            //
            // ARCH-003 (6th clean-room verdict): the WHOLE CHAIN, not the immediate
            // owner. A background root's intermediate agent can read as terminal while
            // its own leaf lane is genuinely in flight — asking only the immediate
            // owner recorded a death for live work under a live root.
            const ownerChain = this.#openToolCalls.ownerChainOf(a.toolUseId);
            const ownedByLiveBackground = a.kind === 'tool' && this.#ownershipSpares(ownerChain);
            if (decision && !ownedByLiveBackground) {
              this.#recordOutcome({
                agentId: a.agentId,
                row: a.kind === 'tool' ? 'tool' : 'agent',
                label: a.agentType,
                description: a.description,
                ...decision,
                clusterId: sweepCluster,
                at: sweepAt,
              });
            }
          }
        }
        this.#resultDelivered.clear(); // evidence was per-turn; the sweep consumed it
        /*
         * ARCH-003 — reap, AFTER the sweep has read what it needed. Two reclamations:
         * the calls whose `tool_result` arrived, and (the 5th clean-room verdict's fix)
         * the OPEN calls that positively cannot still be in flight — their own lane has
         * gone terminal, or their owner is no longer live. The second one is the route
         * that needs NO end signal, which is what stops the fifth leak from becoming a
         * sixth: `ended` > `reap` > `issued` leaves a record whose every end signal is
         * already spent, and only liveness can still bound it.
         *
         * A still-OPEN call of a LIVE owner is untouched, so a child whose assistant
         * frame straddles this `result` and whose lane lands in a later turn still
         * resolves to its owner (the shape that would otherwise re-fabricate its
         * death). The terminal-lane ids are collected from `#agents` HERE — after the
         * sweep above settled this turn's rows, so a lane the sweep just completed is
         * reclaimed in the same boundary rather than a turn later.
         */
        const terminalLaneCallIds = new Set<string>();
        for (const a of this.#agents.values()) {
          if (a.status !== 'running' && a.toolUseId) terminalLaneCallIds.add(a.toolUseId);
        }
        this.#openToolCalls.reap(
          (toolUseId, ownerChain) => this.#callCannotStillBeInFlight(toolUseId, ownerChain, terminalLaneCallIds),
        );
        this.#publishResidency(sweepAt);
        /*
         * FEAT-057 — the MAIN turn's own death. Recorded only where there is a
         * real cause to name: a terminal provider error (the reported case —
         * "agents run into usage limit and stop"). A turn that simply finished,
         * or one the user stopped on purpose, is not news and is not stored.
         * BUG-041: `lastProviderError` now only ever holds TERMINAL causes —
         * an advisory pending-MCP notice can no longer put the main turn here.
         */
        if (this.lastProviderError && !interrupted) {
          this.#recordOutcome({
            agentId: 'main',
            row: 'main',
            label: 'main',
            description: '',
            kind: 'provider-error',
            detail: `the turn ended after ${this.lastProviderError.kind} (${this.lastProviderError.provider}): ${this.lastProviderError.detail}`,
            providerError: this.lastProviderError,
            clusterId: sweepCluster,
            at: sweepAt,
          });
        }
        this.#emit({
          t: 'turn-end',
          subtype: String(m.subtype ?? 'unknown'),
          interrupted,
          isError: m.is_error === true || String(m.subtype ?? '').startsWith('error'),
          durationMs: m.duration_ms,
          costUsd: m.total_cost_usd,
          numTurns: m.num_turns,
          resultText: typeof m.result === 'string' ? m.result : undefined,
          // BUG-031: an API-error turn ends subtype:'success' + is_error:true +
          // terminal_reason:'api_error' — pass the reason so the client never
          // labels an error turn with the word "success".
          terminalReason: typeof m.terminal_reason === 'string' ? m.terminal_reason : undefined,
        });
        // BUG-034: the turn is over — publish the (now empty) running set so a
        // client cannot be left holding rows past the boundary. Forced: this is
        // the one moment where "the answer did not change" must not suppress it.
        this.pushRunningSnapshot(true);
        const budget = this.effective.maxBudgetUsd;
        if (budget != null && this.totalCostUsd >= budget && !this.budgetStopped) {
          this.budgetStopped = true;
          // budgetStopped:true is the client's cue to LOCK the composer — see
          // BUG-013. Not `fatal`: the session and its transcript stay alive
          // and readable, only further sends are refused (send() throws
          // 'session stopped: budget exceeded' below).
          this.#emit({
            t: 'error',
            message: `budget stop: $${this.totalCostUsd.toFixed(4)} spent, limit $${budget.toFixed(2)}`,
            fatal: false,
            budgetStopped: true,
          });
        }
        // FEAT-022: the autonomous auto-continue seam. Runs AFTER the budget
        // check (so a budget stop this same boundary wins) and BEFORE the
        // detached-close (a detached session hands back to close-on-detach
        // rather than auto-continuing headless). Bounded by the stop condition.
        this.#maybeAutoContinue(interrupted);
        // A detached session that just finished its turn has done its duty —
        // close at the boundary unless a socket re-attached meanwhile. The
        // grace delay lets the final writes land and a fast reattach win.
        // BUG-043: the fuse now asks the lifetime question too — a detached
        // session whose background agents are still working must NOT close
        // (close reaps the broker, and the broker's SIGTERM is what kills them).
        if (this.detached) this.#armDetachedClose();
        return;
      }

      default:
        return;
    }
  }

  #handleSystem(m: Record<string, any>): void {
    switch (m.subtype) {
      // BUG-037 — the engine's own list of what is running in the BACKGROUND.
      // Level signal, REPLACE semantics; ids only, never correlated with the
      // task_started/task_notification edges (the SDK documents their relative
      // ordering as unspecified).
      case 'background_tasks_changed': {
        const tasks = Array.isArray(m.tasks) ? m.tasks : [];
        // BUG-096: keep each task's AGENT/TOOL kind alongside its id. The level
        // frame carries `task_type` per task (sdk.d.ts:2921); mirror
        // `task_started`'s discriminant — a subagent is `local_agent`, a bash
        // lane is `local_bash` — so `#ownerIsLiveBackgroundAgent()` can classify a
        // live background owner straight from this authoritative mirror, with no
        // `#agents` row required (the resume/re-attach + skip_transcript shapes).
        /*
         * BUG-105 (1st clean-room verdict) — THE INVARIANT'S SECOND WRITE SITE. A
         * task whose own terminal frame we already saw is over, and a later level
         * frame that still lists it is a stale snapshot, not news: membership is
         * read as liveness by four separate rules, so re-admitting a retired task
         * would restore exactly the staleness the withdrawal removed.
         *
         * BUG-105 (5th clean-room verdict) — SO THE FRAME IS KEPT RAW AND THE
         * FILTER IS A DERIVATION, not a decision taken once at arrival. What the
         * engine declared and what this bridge vetoes are two facts that change
         * independently; folding them together here made the answer depend on which
         * frame arrived first, and a veto withdrawn afterwards could never re-admit
         * a task the engine had already declared. `#rebuildBackgroundLevel()` is the
         * one place the two are combined.
         */
        this.#levelRaw = new Map(
          tasks
            .map((t: any): [string, 'agent' | 'tool'] => [
              String(t?.task_id),
              (t?.subagent_type != null || t?.task_type === 'local_agent') ? 'agent' : 'tool',
            ])
            .filter(([id]: [string, 'agent' | 'tool']) => Boolean(id)),
        );
        this.#rebuildBackgroundLevel();
        // BUG-043: any level frame supersedes the dispatch-observed hint — from
        // here on the level itself is the authority (including an empty one).
        this.#bgDispatchAt = null;
        // BUG-068: and supersedes the dispatch-born tags — a live background lane
        // is IN the authoritative level (REPLACE semantics), so #backgroundTasks
        // now carries every lane worth sparing; drop the pre-level hints.
        this.#bgBornTasks.clear();
        this.#bgDispatchToolUseIds.clear();
        // BUG-043: the level going EMPTY is the moment a detached session that
        // was held open for its background work becomes genuinely finished —
        // nudge the close fuse so holding it open never becomes a leak (a no-op
        // when the recheck loop is already armed).
        if (this.detached && !this.busy && !this.closed && this.#backgroundTasks.size === 0) {
          this.#armDetachedClose();
        }
        return;
      }

      case 'init':
        /*
         * BUG-043 (review finding 5 + live SDK probe): `init` must NOT clear
         * `#backgroundTasks`. BUG-037 cleared it here on the assumption that
         * `init` fires once per CLI process; measured live, the CLI emits a
         * FRESH `init` when a task notification wakes it into a new turn — one
         * probe showed `background_tasks_changed [live work]` immediately
         * followed by `init`, so the clear wiped a level the engine had just
         * asserted, and the close decision then read the session as idle (the
         * exact defect this ticket exists to fix). Staleness across a resume is
         * not a concern the clear was actually protecting against: a resume
         * constructs a NEW AgentSession (fresh set); one AgentSession only ever
         * drives one CLI process. Within that process the level's REPLACE
         * semantics are the correction mechanism — every frame supersedes the
         * whole set, so a stale id cannot outlive the next frame.
         */
        this.sdkSessionId = String(m.session_id);
        this.cwd = String(m.cwd ?? this.cwd);
        // FEAT-037 P2b: the engine's session/thread id names the Orchard
        // transcript file (it IS the resume handle). Buffered entries (the
        // first prompt) flush here; a resume already adopted the same id.
        if (this.#recorder) {
          this.#recorder.setModel(typeof m.model === 'string' ? m.model : null);
          this.#recorder.adoptSessionId(this.sdkSessionId);
        }
        // The fork has written its own self-contained transcript by now, so the
        // staged copy has done its job. Dropping it here (rather than only on
        // close) keeps the user's real store clean during long sessions.
        this.#dropStaged('fork established');
        // Back-fill the SDK session id onto the session-start snapshot. The
        // snapshot had to be taken BEFORE the SDK spawned (that is the whole
        // point), so this id did not exist yet; the UI needs it to label the
        // snapshot "start of <session>".
        if (this.startSnapshotId) {
          snapshots.attachSdkSessionId(this.project.id, this.startSnapshotId, this.sdkSessionId);
        }
        this.#emit({
          t: 'session-init',
          sessionId: this.sdkSessionId,
          cwd: this.cwd,
          model: String(m.model ?? 'unknown'),
          tools: Array.isArray(m.tools) ? m.tools : [],
          permissionMode: m.permissionMode,
          // What THIS session's CLI says it answers to — powers the composer's
          // "/" autocomplete. Typed as a prompt, the CLI executes them itself.
          slashCommands: Array.isArray(m.slash_commands) ? m.slash_commands.map(String) : [],
        });
        rememberSlashCommands(Array.isArray(m.slash_commands) ? m.slash_commands.map(String) : []);
        return;

      case 'task_started': {
        if (m.skip_transcript === true) return;
        const agent: LiveAgent = {
          agentId: String(m.task_id),
          toolUseId: m.tool_use_id ? String(m.tool_use_id) : null,
          agentType: String(m.subagent_type ?? m.task_type ?? 'task'),
          // BUG-030: a task announced WITHOUT a subagent_type and with a
          // non-agent task_type (observed: "local_bash", one per Bash call a
          // subagent makes) is a TOOL CALL surfaced as a task, not an agent.
          // The client renders it in the live strip but never as a "ran" row.
          kind: (m.subagent_type != null || m.task_type === 'local_agent') ? 'agent' : 'tool',
          description: String(m.description ?? ''),
          status: 'running',
          lastTool: null,
          totalTokens: 0,
          toolUses: 0,
          elapsedMs: 0,
          startedAt: Date.now(),
          // BUG-046: the stall detector's evidence clock starts at the start.
          lastProgressAt: Date.now(),
        };
        this.#agents.set(agent.agentId, agent);
        if (agent.toolUseId) this.#toolUseToAgent.set(agent.toolUseId, agent.agentId);
        /*
         * BUG-105 (5th clean-room verdict) — THE ANNOUNCEMENT IS THE ENGINE SAYING
         * THIS TASK IS LIVE NOW, so it withdraws a liveness veto that no per-task
         * verdict is behind (a session-wide teardown blanket that landed while this
         * bridge had no row). It does NOT withdraw an established outcome — that
         * task is finished, and the settle a few statements below is what this
         * handler does with it instead. First, so every liveness decision in the
         * rest of this frame sees the withdrawn state.
         */
        this.#withdrawLivenessVeto(agent.agentId);
        // ARCH-003: NOTHING IS STAMPED HERE. Earlier attempts read the owner out of a
        // side map at this point and deleted the entry; that made this frame's arrival
        // time decide the lane's fate (a lane announced before its parentage frame was
        // mislabelled main-thread) and made a second lane echoing the same tool_use id
        // find nothing. The sweep resolves ownership from `#openToolCalls` when it
        // needs it instead, so this frame carries no ownership decision at all.
        // BUG-068: a lane born from a run_in_background dispatch IS background,
        // even before the engine's level frame lists it. Tag it so the turn-end
        // sweep spares it in the pre-level window (the reported invisibility).
        if (agent.toolUseId && this.#bgDispatchToolUseIds.delete(agent.toolUseId)
            // BUG-105 — the invariant's third write site: never (re-)admit a task
            // whose terminal frame has already been observed (a terminal frame that
            // raced ahead of this `task_started`). 5th verdict: the veto asked here
            // is `#retiredTasks`, and the withdrawal above has already run — so a
            // task the engine gave a verdict on is still refused, and one only a
            // blanket ever touched is born background exactly as if the blanket had
            // never mentioned it.
            && !this.#retiredTasks.has(agent.agentId)) {
          // BUG-096: record the lane's kind — a background Task subagent can PARENT
          // a foreground child bash; a run_in_background Bash (kind:'tool') cannot.
          this.#bgBornTasks.set(agent.agentId, agent.kind ?? 'tool');
        }
        /*
         * BUG-105 (the `b0dfaf6` REGRESSION) — A TERMINAL REPORT MARKS THE EVENTUAL
         * ROW TERMINAL, WHENEVER THAT ROW APPEARS.
         *
         * The terminal frame handlers retire from the FRAME, before any row lookup,
         * so a task the level lists but this bridge has no row for still retires
         * (the re-attach and `skip_transcript` shapes the level mirror exists for).
         * That left the other half of the report — HOW it ended — with nowhere to
         * go: the handler returned on `if (!a) return`, the row was later built
         * `running`, and the turn-end sweep settled a task that had positively
         * reported `completed` as an `unknown` DEATH. An unmarked death for work
         * that said it finished is wrong under any ordering, so the report is
         * applied here rather than only where the row happened to exist first.
         *
         * This is the ENGINE'S OWN evidence being applied late, never an inference:
         * `#establishedOutcomes` is written by the two terminal-frame handlers and
         * by nothing else — least of all the turn-end sweep's settle.
         *
         * BUG-105 (4th clean-room verdict) — AND ONLY WHAT THE ENGINE ESTABLISHED.
         * This used to read `#terminallyReportedTasks`, which is mere EVIDENCE that
         * some terminal frame was seen, so a teardown blanket that arrived before
         * this row existed was applied here as a `killed` death for a task the
         * engine never gave a per-task verdict on. A frame that could not have
         * settled the row at the moment it arrived never reaches this map.
         */
        /*
         * BUG-105 (3rd clean-room verdict) — AND THE ANNOUNCEMENT ITSELF MUST NOT
         * LIE. This used to `#emit` `agent-started` (status `running`) FIRST and
         * settle the row a few statements later, so every consumer of the live
         * display was told a task was starting that this bridge already knew had
         * finished. app.js's `agent-started` handler hardcodes `th.status =
         * 'running'`, so the row genuinely enters the strip as live and is only
         * corrected by the event behind it — and a consumer that samples between
         * them, or replays only starts, is left with a permanent ghost.
         *
         * So the report is applied BEFORE anything is announced, and exactly one
         * event goes out: `agent-completed` for a row that is already settled.
         * That is not a new convention — `replayAgents()` above documents and uses
         * the same one (`agent-started` for a `running` row, `agent-completed` for
         * a settled one), and the client's handler is written to be replay-safe for
         * an agent it has never seen.
         */
        const reported = this.#establishedOutcomes.get(agent.agentId);
        if (reported) {
          agent.status = reported;
          agent.elapsedMs = Date.now() - agent.startedAt;
          this.#emit({ t: 'agent-completed', agent: { ...agent } });
          this.#recordAgentEnd(agent, reported); // FEAT-057 — `completed` is dropped by the store
        } else {
          this.#emit({ t: 'agent-started', agent: { ...agent } });
        }
        this.pushRunningSnapshot(); // BUG-034: the running SET changed
        return;
      }

      case 'task_progress': {
        const a = this.#agents.get(String(m.task_id));
        if (!a) return;
        a.totalTokens = Number(m.usage?.total_tokens ?? a.totalTokens);
        a.toolUses = Number(m.usage?.tool_uses ?? a.toolUses);
        a.elapsedMs = Number(m.usage?.duration_ms ?? Date.now() - a.startedAt);
        // BUG-046: a frame ABOUT this row is evidence it is being worked —
        // the stall detector's clock moves on frames, never on guesses.
        a.lastProgressAt = Date.now();
        if (m.last_tool_name) a.lastTool = String(m.last_tool_name);
        if (m.tool_use_id && !a.toolUseId) {
          a.toolUseId = String(m.tool_use_id);
          this.#toolUseToAgent.set(a.toolUseId, a.agentId);
        }
        this.#emit({ t: 'agent-progress', agent: { ...a } });
        this.pushRunningSnapshot();
        return;
      }

      case 'task_updated': {
        const status = m.patch?.status;
        /*
         * BUG-105 (1st clean-room verdict) — the RETIREMENT is recorded from the
         * FRAME, before any row lookup. A background task the level lists but that
         * this bridge has no row for (the resume/re-attach and `skip_transcript`
         * shapes `#ownerIsLiveBackgroundAgent` reads the level for in the first
         * place) is exactly the case where a lingering level entry has nothing else
         * to correct it, so the terminal frame must count whether or not a row
         * exists.
         */
        const a = this.#agents.get(String(m.task_id));
        // BUG-105 (4th clean-room verdict): the row's state at THIS instant is what
        // the one settle-predicate is asked about — `'absent'` when there is no row.
        let settles = false;
        if (status === 'completed' || status === 'failed' || status === 'killed') {
          settles = this.#retireTask(String(m.task_id), status, 'patch', a ? a.status : 'absent');
        }
        // BUG-105 (the `b0dfaf6` regression) — returning here used to DROP the
        // reported status when no row existed yet. It no longer can: `#retireTask`
        // kept it, and `task_started` applies it the moment the row appears.
        if (!a) return;
        a.lastProgressAt = Date.now(); // BUG-046: any patch frame is progress evidence
        if (m.patch?.description) a.description = String(m.patch.description);
        if (settles && (status === 'completed' || status === 'failed' || status === 'killed')) {
          a.status = status;
          a.elapsedMs = Date.now() - a.startedAt;
          this.#emit({ t: 'agent-completed', agent: { ...a } });
          // FEAT-057: a terminal frame is the ENGINE's own word for what
          // happened, which is the best evidence that will ever exist for this
          // agent. `completed` is dropped by the store (deaths only).
          this.#recordAgentEnd(a, status);
          // ARCH-003 (6th clean-room verdict): this used to call
          // `#openToolCalls.ownerEnded(a.toolUseId)` — dropping every record whose
          // IMMEDIATE parent was this agent, on the claim that "a lane whose owner is
          // terminal is not spared, entry or no entry". That claim is false one level
          // down: this agent may itself be the child of a background root that is
          // still running, and its leaf lane's record is the only thing that can name
          // that root. Deleting it here made the sweep fabricate the leaf's death.
          // Reclamation is now the boundary's job alone, where the whole chain is
          // read; it is strictly more conservative and costs at most one turn's
          // residency.
          this.pushRunningSnapshot();
        } else if (status) {
          this.#emit({ t: 'agent-progress', agent: { ...a } });
          this.pushRunningSnapshot();
        }
        return;
      }

      case 'task_notification': {
        /*
         * BUG-030: for a tool-call task (task_type "local_bash") THIS
         * notification is the ONLY terminal frame the CLI ever emits — there
         * is no task_updated for it (probe-verified on v2.1.220: normal
         * completion → status:"completed"; a SIGTERM'd CLI emits
         * status:"stopped" for every still-open task on its way out, plus
         * task_updated status:"killed" for agent tasks). Pre-fix the status
         * was dropped here, so the #agents entry stayed `running` forever and
         * the client's card spun ◐ with a growing timer long after the call
         * finished — the observed 16-row forever-in-flight list.
         */
        const a = this.#agents.get(String(m.task_id));
        const s = String(m.status ?? '');
        const terminal =
          s === 'completed' ? 'completed' as const
            : (s === 'failed' || s === 'error') ? 'failed' as const
              : (s === 'stopped' || s === 'killed') ? 'killed' as const
                : null;
        // BUG-105 — the engine's own word that this task is over, taken from the
        // FRAME (see `task_updated` above: a level-listed task with no row here is
        // precisely where a lingering entry has nothing else to correct it).
        // BUG-105 (4th clean-room verdict) — and whether this frame may SETTLE a row
        // is the one predicate's answer, asked with `'absent'` when there is no row.
        // BUG-105 (7th clean-room verdict): this is now STRICTLY narrower than the
        // original `a.status === 'running'` test, and deliberately so — a teardown
        // blanket does not settle a running row either. See `#terminalFrameSettles`.
        const settles = terminal
          ? this.#retireTask(String(m.task_id), terminal, 'notification', a ? a.status : 'absent')
          : false;
        if (a && terminal && settles) {
          a.status = terminal;
          a.elapsedMs = Date.now() - a.startedAt;
          this.#emit({ t: 'agent-completed', agent: { ...a } });
          this.#recordAgentEnd(a, terminal); // FEAT-057
          // ARCH-003 — no `ownerEnded` here either; see task_updated above.
          this.pushRunningSnapshot();
        }
        this.#emit({ t: 'status', status: String(m.message ?? m.summary ?? m.description ?? 'task notification') });
        return;
      }

      case 'thinking_tokens':
        this.#emit({ t: 'thinking-tokens', tokens: Number(m.estimated_tokens ?? 0), agentId: null });
        return;

      case 'status':
        /*
         * The CLI reports the session's CURRENT permission mode on this
         * message, and that is the only notification of a mode change it did
         * not receive from us — approving an ExitPlanMode plan drops `plan`
         * back to `default` (observed live). Reconcile before anything else so
         * the UI cannot keep showing a mode the session left.
         *
         * #applyPermissionMode no-ops when the value already agrees, which is
         * the overwhelmingly common case, so this does not churn events.
         */
        if (typeof m.permissionMode === 'string') this.#applyPermissionMode(m.permissionMode, 'agent');
        this.#emit({ t: 'status', status: String(m.status?.type ?? m.status ?? 'status') });
        return;

      case 'compact_boundary':
        this.#emit({ t: 'compact-boundary', trigger: m.compact_metadata?.trigger });
        return;

      /*
       * FEAT-042 — the ONE dedicated model-switch push signal the SDK has:
       * the model refused (stop_reason "refusal") and the CLI retried the turn
       * on a fallback model, making the swap PERSISTENT for the session
       * (SDKModelRefusalFallbackMessage). This is precisely the silent
       * safeguard-downgrade the model chip exists to catch, so it is emitted
       * as its own loud event AND folded into the effective config
       * (#applyModel re-emits `effective-config`, keeping the drawer/picker/
       * HTTP route truthful). #lastWireModel adopts the fallback so the next
       * assistant frame does not double-report the same switch.
       */
      case 'model_refusal_fallback': {
        const from = String(m.original_model ?? this.#lastWireModel ?? 'unknown');
        const to = String(m.fallback_model ?? 'unknown');
        this.#lastWireModel = to;
        this.#emit({
          t: 'model-changed',
          from,
          to,
          reason: 'refusal-fallback',
          category: m.api_refusal_category ?? null,
        });
        this.#applyModel(to);
        return;
      }

      /*
       * The model refused and NO fallback ran — the model did not change, but
       * silence here would hide why the turn ended the way it did.
       */
      case 'model_refusal_no_fallback':
        this.#emit({
          t: 'error',
          message: `model refused to answer (${m.api_refusal_category ?? 'no category'}) and no fallback model ran — still on ${m.original_model ?? 'the same model'}`,
          fatal: false,
        });
        return;

      case 'permission_denied':
        this.#emit({
          t: 'permission-denied',
          toolName: String(m.tool_name ?? m.denial?.tool_name ?? 'unknown'),
          reason: m.reason ?? m.message,
        });
        return;

      default:
        return;
    }
  }
}

function previewOf(content: unknown, max = 600): string {
  let s: string;
  if (typeof content === 'string') s = content;
  else if (Array.isArray(content)) {
    s = content
      .map((c: any) => (typeof c === 'string' ? c : c?.type === 'text' ? String(c.text ?? '') : `[${c?.type ?? 'block'}]`))
      .join('\n');
  } else s = JSON.stringify(content ?? null);
  s = s.replace(/\x00/g, '');
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars)` : s;
}

/* ------------------------------------------------------------ session store */

const sessions = new Map<string, AgentSession>();
let seq = 0;

/* ---------------------------------------------- BUG-033: the zombie reaper */

/*
 * ARCH-001 — `FRAMELESS_MS` / `REAP_SWEEP_MS` moved to `liveness.ts` with the
 * rung that uses them (env vars unchanged: `CLAUDE_STATION_FRAMELESS_MS`,
 * `CLAUDE_STATION_REAP_SWEEP_MS`). A window that lives apart from the check it
 * bounds is a second place to get the answer wrong.
 */

/**
 * BUG-033 — one pass of the reaper. Drops every bridge that claims to be
 * running but has no live process behind it, announcing each one honestly.
 * Exported (and separate from the interval) so verification can drive a sweep
 * deterministically instead of sleeping on a timer.
 */
export function sweepZombieSessions(): { stationSessionId: string; kind: string; reason: string }[] {
  const reaped: { stationSessionId: string; kind: string; reason: string }[] = [];
  for (const s of [...sessions.values()]) {
    if (s.closed || !s.busy) continue;
    // A frameless-window reap is only ever a backstop; a disabled window still
    // leaves the ground-truth (dead process) half armed — the authority applies
    // that rule itself, so there is nothing to re-check here.
    const v = s.livenessVerdict();
    if (v.live) continue;
    reaped.push({ stationSessionId: s.id, kind: v.kind, reason: v.reason });
    s.reapAsZombie(v);
  }
  return reaped;
}

let reapTimer: ReturnType<typeof setInterval> | null = null;
/** Start the periodic zombie sweep. Idempotent; unref'd so it never holds the process open. */
export function startZombieReaper(): void {
  if (reapTimer || !(REAP_SWEEP_MS > 0)) return;
  reapTimer = setInterval(() => {
    try { sweepZombieSessions(); } catch (err) { console.warn(`[orchard] zombie sweep failed: ${(err as Error).message}`); }
  }, REAP_SWEEP_MS);
  reapTimer.unref?.();
}

/**
 * Start a session, honouring the project's isolation mode.
 *
 * Async because "container" has to have a live container BEFORE the SDK
 * spawns. If the container cannot be made ready this REJECTS — it never falls
 * back to host execution, which would silently defeat the isolation the user
 * asked for.
 */
export async function prepareDispatchForSession(opts: Pick<StartOptions, 'project' | 'onEvent'>): Promise<string | undefined> {
  if (!toolSettingsOf(opts.project).openaiDispatch) return undefined;
  opts.onEvent({ t: 'status', status: 'starting host OpenAI dispatch broker…' });
  try {
    const socket = await dispatchBroker.start(opts.project);
    opts.onEvent({ t: 'status', status: `OpenAI dispatch broker ready (socket ${socket})` });
    return undefined;
  } catch (err) {
    const reason = `host broker could not start: ${(err as Error).message}`;
    opts.onEvent({ t: 'error', message: `OpenAI dispatch broker unavailable: ${reason}`, fatal: false });
    opts.onEvent({ t: 'status', status: 'starting session without OpenAI dispatch capability' });
    return reason;
  }
}

export async function startSession(opts: StartOptions): Promise<AgentSession> {
  // Same fail-closed rule as the constructor, applied before anything else runs.
  const iso: string = opts.project.isolation;
  if (iso !== 'direct' && iso !== 'container' && iso !== 'sandbox') {
    const msg =
      `unknown isolation ${JSON.stringify(iso)} on project ${opts.project.id} — refusing to start a session. ` +
      `Valid values are "direct", "container", "sandbox".`;
    opts.onEvent({ t: 'error', message: msg, fatal: true });
    throw new Error(msg);
  }
  /*
   * BUG-138 — THE WORKING DIRECTORY, BEFORE ANYTHING TRIES TO USE IT.
   *
   * A renamed or deleted project directory is the single most explainable
   * failure a session can have, and it was reaching the user as the bare word
   * "Error": with `direct` isolation the path is handed to the CLI as its cwd
   * and the spawn dies with an ENOENT that names nothing the user recognises;
   * with `container` it is a bind source. Checked HERE, first, so the reader
   * gets the path Orchard expected and the one thing to do about it — the same
   * discipline as the mount detail in the first half of BUG-136, not a second
   * mechanism for it.
   *
   * NOTHING IS WRITTEN. The project keeps pointing where it points; restore or
   * rename the directory back and the next session starts normally.
   */
  {
    const hostPath = opts.project.hostPath;
    let isDir = false;
    try { isDir = fs.statSync(hostPath).isDirectory(); } catch { isDir = false; }
    if (!isDir) {
      const msg =
        `this project's working directory is missing: ${hostPath}\n` +
        `Orchard has "${opts.project.name}" recorded at that path and nothing is there now — ` +
        'a session cannot start without it. Either restore/rename the directory back (nothing was changed, ' +
        'so it will simply work again), or open Settings › Directory and point this project at its new location — ' +
        'repointing carries this project\'s existing sessions with it.';
      opts.onEvent({ t: 'error', message: msg, fatal: true });
      throw new Error(msg);
    }
  }
  /*
   * BROWSER BEFORE CONTAINER, on purpose — but ONLY for a container.
   *
   * ENABLING THE BROWSER IS NOT USING IT. Starting a session used to launch
   * Chrome unconditionally, so every browser-enabled project popped a real,
   * headful, logged-in Chrome window sitting on about:blank the moment a session
   * took its first message — including the overwhelming majority of sessions
   * that never make a single browser tool call. Nothing then closed it until the
   * daemon's idle timeout expired. That is a window the user did not ask for and
   * a Chrome-sized resident set held for nothing.
   *
   * NEITHER SHAPE LAUNCHES CHROME HERE ANY MORE (ARCH-007, option A). Laziness
   * moved into the thing that owns the browser: the adapter's daemon serves
   * before Chrome exists and launches it on the first page-dependent tool call.
   * The station no longer has to interpose anything to arrange that.
   *
   * DIRECT — nothing is started here at all. The adapter's own MCP shim runs on
   * the host with autostart ON (see `mcpServerFor`) and brings the daemon up on
   * the first browser tool call, waiting up to 60s for the socket while the tool
   * call's own budget is 180s.
   *
   * CONTAINER — the DAEMON is started here, and that is structural rather than
   * eagerness. The container bind-mounts the socket FILE, and docker creates a
   * ROOT-OWNED DIRECTORY at a missing mount source: it would fail to be a socket
   * and would leave a root-owned turd in the user's state dir. The container's
   * shim is deliberately run with SBMCP_AUTOSTART=0 (a container must never
   * spawn Chrome — it would be the wrong, detectable Chrome), so nothing inside
   * can create the socket later. `browser.start()` now returns as soon as that
   * socket answers, having launched no browser; the first in-container tool call
   * launches Chrome on the host, through the mounted socket.
   *
   * The AVAILABILITY check stays on both paths — and now also refuses an adapter
   * that cannot declare lazy start, because attaching an eager one would put the
   * unwanted window straight back. If the adapter is missing or eager we refuse
   * the session outright, because handing back a session silently missing the
   * browser the user enabled just moves the failure to mid-task.
   */
  if (browserSettingsOf(opts.project).enabled) {
    try {
      const avail = browser.available();
      if (!avail.ok) throw new browser.BrowserError('adapter-missing', avail.message);
      if (iso === 'container') {
        opts.onEvent({ t: 'status', status: 'arming stealth browser…' });
        const st = browser.start(opts.project, browserSettingsOf(opts.project).idleMs ?? undefined);
        /*
         * Assert the thing the user actually complained about. `start` is meant
         * to have created a socket and nothing else; if a Chrome exists at this
         * point the adapter regressed to eager and a window just opened, so say
         * so in the transcript rather than let it pass as normal.
         */
        const eager = st.chrome_procs_live > 0;
        opts.onEvent({
          t: 'status',
          status: eager
            ? `stealth browser socket ready (${st.socket}) — WARNING: ${st.chrome_procs_live} chrome process(es) already running; ` +
              'this adapter started a browser before anything asked for one'
            : `stealth browser armed — socket ready (${st.socket}); Chrome starts on the first browser tool call, not now`,
        });
      } else {
        opts.onEvent({
          t: 'status',
          status: `stealth browser armed — Chrome starts on the first browser tool call, not now (socket ${browser.socketPath(opts.project)})`,
        });
      }
    } catch (err) {
      const e = err as Error;
      const be = err instanceof browser.BrowserError ? err : null;
      const msg = `stealth browser unavailable${be ? ` (${be.code})` : ''}: ${e.message}${be?.detail ? `\n${be.detail}` : ''}`;
      opts.onEvent({ t: 'error', message: msg, fatal: true });
      throw new Error(msg);
    }
  }

  const dispatchUnavailableReason = await prepareDispatchForSession(opts);

  if (iso === 'container') {
    try {
      const st = await ensureContainer(opts.project, { onLog: (s) => opts.onEvent({ t: 'status', status: s.trim().slice(0, 300) }) });
      if (st.state !== 'running') {
        throw new ContainerError('not-running', `container ${st.containerName} is "${st.state}" — refusing to start a session on the host instead`);
      }
    } catch (err) {
      const e = err as Error;
      /*
       * BUG-136 (second report) — `detail` is where a ContainerError puts the
       * only actionable sentence it has, and this message dropped it. A project
       * whose mount pointed at a deleted directory reported exactly "container
       * isolation unavailable (bad-mounts): project mounts are invalid" — which
       * names no mount and no path, so there is nothing the reader can act on.
       * The offending path was sitting in `detail` the whole time. Same shape as
       * the turn-end label fixed in the first half of this ticket: the one line
       * naming the fault was produced and then discarded.
       */
      const detail = err instanceof ContainerError && err.detail ? `\n${err.detail}` : '';
      const msg =
        err instanceof ContainerError
          ? `container isolation unavailable (${err.code}): ${e.message}${detail}`
          : `container isolation unavailable: ${e.message}`;
      opts.onEvent({ t: 'error', message: msg, fatal: true });
      throw new Error(msg);
    }
  } else if (opts.project.isolation === 'sandbox') {
    const msg = 'isolation "sandbox" (bubblewrap) is modelled but not implemented — set the project to "direct" or "container"';
    opts.onEvent({ t: 'error', message: msg, fatal: true });
    throw new Error(msg);
  }
  /*
   * FORK PLANNING — after ensureContainer on purpose. For isolation "container"
   * the target store dir is a host directory bind-mounted into the container, and
   * ensureContainer is what pre-creates it with the right ownership; staging into
   * it beforehand would race that.
   */
  let forkPlan: ForkPlan | undefined;
  if (opts.fork && opts.resumeSessionId) {
    /*
     * FEAT-037 P2b — forking an Orchard-owned (Codex) session is REFUSED, not
     * faked. planFork's staging copies a CLAUDE store file for the Claude CLI
     * to resume; a Codex fork would instead need thread/fork (which the wire
     * supports, fixture-proven) PLUS seeding the new thread's Orchard
     * transcript with the ancestor history so the fork's file doesn't render
     * as amnesia. That seeding is honest follow-up work; until then the
     * refusal names the alternative.
     */
    const dirs = [opts.resumeEncodedDir, encodeCwd(opts.project.hostPath)].filter((d): d is string => !!d);
    if (dirs.some((d) => resolveOrchardSessionFile(d, opts.resumeSessionId!))) {
      const msg =
        `fork failed: ${opts.resumeSessionId} is an Orchard-owned (Codex) transcript — forking a Codex session ` +
        'is not supported yet (FEAT-037 P2b follow-up). Resume it instead, which continues the same thread.';
      opts.onEvent({ t: 'error', message: msg, fatal: true });
      throw new Error(msg);
    }
    try {
      forkPlan = planFork(opts.project, opts.resumeSessionId, opts.resumeEncodedDir);
      if (forkPlan.stagedFile) {
        opts.onEvent({
          t: 'status',
          status:
            `fork: source session lives in ${forkPlan.sourceEncodedDir} but this project resolves to ` +
            `${forkPlan.targetEncodedDir} — staged a ${forkPlan.bytes}B read-only copy as ${forkPlan.resumeSessionId} ` +
            `(resolved by ${forkPlan.resolvedBy})`,
        });
      }
    } catch (err) {
      // Truthful and specific — never a silent no-op, and never the SDK's opaque
      // error_during_execution.
      const msg = `fork failed: ${(err as Error).message}`;
      opts.onEvent({ t: 'error', message: msg, fatal: true });
      throw new Error(msg);
    }
  } else if (opts.resumeSessionId) {
    // Plain resume: catch an unresolvable id HERE, where we can say why, rather
    // than letting the SDK return `error_during_execution`.
    const why = explainUnresumable(opts.project, opts.resumeSessionId);
    if (why) {
      // BUG-090: when the id only failed because it lives under a pre-isolation
      // store dir, surface a STRUCTURED needs-fork signal the client turns into a
      // one-click fork — the prose `message` stays a readable fallback.
      opts.onEvent({
        t: 'error',
        message: why.message,
        fatal: true,
        ...(why.fork ? { needsFork: { resumeSessionId: opts.resumeSessionId, ...why.fork } } : {}),
      });
      throw new Error(why.message);
    }
  }

  const id = `cs-${Date.now().toString(36)}-${(++seq).toString(36)}`;

  /*
   * SESSION-START SNAPSHOT.
   *
   * Here, and not earlier: the container must already be up (so the snapshot
   * reflects the tree the agent will actually see), and not later, because the
   * SDK starts editing as soon as it spawns.
   *
   * INSURANCE MUST NOT BREAK THE THING IT INSURES. `snapshotOnSessionStart`
   * never throws — a snapshot failure is emitted as a NON-FATAL error event and
   * the session proceeds. Refusing to start a session because a backup failed
   * would trade a real capability for a hypothetical one. The UI can tell the
   * difference: `ack.startSnapshotId` is null when there is no restore point.
   */
  const snap = snapshots.snapshotOnSessionStart(opts.project, id, {
    onStatus: (status) => opts.onEvent({ t: 'status', status }),
    onError: (message) => opts.onEvent({ t: 'error', message, fatal: false }),
  });

  let s: AgentSession;
  try {
    s = new AgentSession(id, { ...opts, forkPlan, dispatchUnavailableReason });
  } catch (err) {
    discardStaged(forkPlan?.stagedFile ?? null);
    throw err;
  }
  s.startSnapshotId = snap.meta?.id ?? null;
  s.startSnapshotStatus = snap.status;
  s.startSnapshotError = snap.status === 'failed' ? snap.reason : null;
  sessions.set(id, s);
  return s;
}

export function getSession(id: string): AgentSession | undefined {
  return sessions.get(id);
}

/** Every session still live. Sessions remove themselves on close(). */
export function liveSessions(): AgentSession[] {
  return [...sessions.values()].filter((s) => !s.closed);
}

/** Live sessions belonging to one project — used to refuse destructive container ops. */
export function liveSessionsForProject(projectId: string): AgentSession[] {
  return liveSessions().filter((s) => s.project.id === projectId);
}

/**
 * Close every live session. With `{ handoff: true }` (server restart/shutdown),
 * survivable "direct" sessions are HANDED OFF instead of closed — their broker +
 * CLI keep running in their own scope so a restart does not kill the in-flight
 * turn (FEAT-015). Non-survivable sessions (container, or survival disabled)
 * still close normally, so a container's exec is never left stranded.
 */
export async function closeAllSessions(reason = 'shutdown', opts: { handoff?: boolean } = {}): Promise<void> {
  await Promise.all([...sessions.values()].map((s) => {
    // A BUSY survivable session is handed off — that is the in-flight work
    // FEAT-015 protects. BUG-044: `busy` alone is TURN-scoped (ARCH-002), and
    // this decision closed a not-busy session whose BACKGROUND agents were
    // still working — close() reaps the broker, whose stdin-EOF the CLI obeys
    // within seconds even with a live background task (measured: heartbeat cut
    // ~4s after the shutdown SIGTERM, before boot re-adopt ever ran). So the
    // handoff also consults the SAME declared-lifetime answer the socket-close
    // paths consult: work that outlives the turn (or an unknown lifetime —
    // never coerced) is handed off too, bounded downstream by the broker's own
    // lifetime-aware abandon net + drain (session-host.mjs). Only a session
    // with nothing running and nothing outliving the turn closes here.
    if (opts.handoff && s.survivable && (s.busy || s.workLifetime().outlivesTurn !== 'no')) {
      try { s.handoff(); } catch { /* best effort */ }
      return Promise.resolve();
    }
    return s.close(reason).catch(() => {});
  }));
  sessions.clear();
}
