/**
 * BUG-239 (B) — THE NO-PARKING GUARD: a subagent lane may not end its turn while
 * background work IT started is still running.
 *
 * WHY. The Claude Code CLI (2.1.281, `killShellTasksForAgent` + the
 * `nonShellMonitors` cleanup step) kills a FOREGROUND subagent's running
 * background shells and Monitors the moment that subagent hands back. The CLI's
 * own wording pushes lanes into the trap: a background Bash result says "it is
 * terminated when you give your final response", and the CLI blocks `sleep` and
 * says "use Monitor" — which is killed the same way. Lanes then end with "I'll
 * wait for the monitor notification", the child dies, and its output is dropped
 * silently (13/13 surviving output files of such lanes end in `[killed]`; on
 * 2026-10-07 a whole OpenAI review was lost this way). Background lanes are not
 * killed but "park on keepalive" with no time limit (BUG-140), and a nested
 * background Agent's result goes to the orchestrator, never to the lane that
 * launched it. BUG-046 answered this with charter wording only.
 *
 * HOW. `SubagentStop` fires BEFORE that cleanup, and a `{decision:'block'}`
 * answer keeps the subagent going. The hook input carries
 * `agent_transcript_path` and `background_tasks[]` (session-wide, NO owner
 * field). Ownership is therefore derived: the IDs this lane's OWN tool results
 * announced as launched, intersected with the tasks the CLI says are still
 * running. Both must hold, so a quoted ID in prose cannot trigger a block and a
 * finished child cannot either.
 *
 * BOUNDS — the guard must never become a hang of its own:
 *   - IGNORED: a lane that hits the guard again without having made a single
 *     tool call since the previous block is not trying to wait. After
 *     `ignoredLimit` such repeats the stop is allowed.
 *   - CEILING: once a lane has been held for `ceilingMs` of AWAKE time
 *     (`performance.now`, CLOCK_MONOTONIC — suspend does not count) the stop is
 *     allowed.
 *   Every allow-with-live-children is returned as `parked` so the caller can
 *   record it where a person sees it. The guard is a liveness aid, not a safety
 *   gate: any error answers "allow" and is reported, never swallowed.
 *
 * Pure apart from the one transcript read in `readTranscript`; the decision is a
 * function of (input, transcript text, prior state, now).
 */
import * as fs from 'node:fs';

/** One `background_tasks[]` entry as the CLI sends it (SDK BackgroundTaskSummary). */
export interface BgTask {
  id: string;
  type?: string;
  status?: string;
  description?: string;
  command?: string;
}

export interface OwnedChild {
  id: string;
  type: string;
  status: string;
  what: string;
}

/**
 * The launch announcements, verbatim from CLI 2.1.281 transcripts. Each must be
 * the LEADING text of a tool_result whose tool_use was the matching tool
 * (provenance: a Bash that merely cats a transcript cannot forge a launch,
 * because its output is not led by the CLI's own announcement — plan review
 * finding 7). Each captures the child's task id.
 */
export const LAUNCH_PATTERNS: ReadonlyArray<{ kind: string; tools: ReadonlySet<string>; re: RegExp }> = [
  { kind: 'shell', tools: new Set(['Bash', 'PowerShell']), re: /^Command running in background with ID: ([A-Za-z0-9_-]+)/ },
  { kind: 'shell', tools: new Set(['Bash', 'PowerShell']), re: /^Command did not complete within its \d+s timeout and was moved to the background \(ID: ([A-Za-z0-9_-]+)\)/ },
  { kind: 'monitor', tools: new Set(['Monitor']), re: /^Monitor started \(task ([A-Za-z0-9_-]+)/ },
  { kind: 'subagent', tools: new Set(['Agent', 'Task']), re: /^Async agent launched successfully\.[\s\S]{0,400}?\bagentId: ([A-Za-z0-9_-]+)/ },
];

/** Statuses the CLI uses for work that has not ended. */
const LIVE = new Set(['running', 'pending', 'backgrounded']);

function resultText(c: any): string {
  if (typeof c?.content === 'string') return c.content;
  if (Array.isArray(c?.content)) return c.content.map((y: any) => (typeof y?.text === 'string' ? y.text : '')).join('');
  return '';
}

export interface TranscriptScan {
  /** id -> launch kind, from this lane's own tool results (provenance-checked). */
  launched: Map<string, string>;
  /** ids referenced by the lane AFTER their launch (a tool call naming it, or a task notice). */
  referenced: Set<string>;
  /** Successful (non-error) tool results so far — the progress signal for IGNORED. */
  okResults: number;
  /** Lines that did not parse (a half-flushed tail is normal; counted, not fatal). */
  badLines: number;
}

/** Scan a lane transcript's text. Tolerant: an unparsable line is skipped and counted. */
export function scanTranscript(text: string): TranscriptScan {
  const launched = new Map<string, string>();
  const referenced = new Set<string>();
  const toolOf = new Map<string, string>();
  let okResults = 0;
  let badLines = 0;
  const noteRefs = (s: string) => { for (const id of launched.keys()) if (s.includes(id)) referenced.add(id); };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { badLines++; continue; }
    const content = rec?.message?.content;
    if (rec?.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c?.type !== 'tool_use') continue;
        if (typeof c.id === 'string') toolOf.set(c.id, String(c.name ?? ''));
        if (launched.size) noteRefs(JSON.stringify(c.input ?? ''));
      }
      continue;
    }
    // CLI 2.1.281 delivers a background task's completion notice to a lane as an
    // `attachment` record of type `queued_command` (observed in a real held lane),
    // not as a user message — so that is where "the lane saw it" is recorded too.
    if (rec?.type === 'attachment') {
      const p = rec?.attachment?.prompt;
      if (launched.size && typeof p === 'string') noteRefs(p);
      continue;
    }
    if (rec?.type !== 'user') continue;
    if (typeof content === 'string') { if (launched.size) noteRefs(content); continue; }
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string') { if (launched.size) noteRefs(c.text); continue; }
      if (c?.type !== 'tool_result') continue;
      if (!c.is_error) okResults++;
      const t = resultText(c).trimStart();
      const tool = toolOf.get(String(c.tool_use_id ?? '')) ?? '';
      let isLaunch = false;
      for (const { kind, tools, re } of LAUNCH_PATTERNS) {
        if (!tools.has(tool)) continue;
        const m = re.exec(t);
        if (m) { launched.set(m[1], kind); isLaunch = true; }
      }
      if (!isLaunch && launched.size) noteRefs(t);
    }
  }
  return { launched, referenced, okResults, badLines };
}

/** The lane's launched children that the CLI still reports as live. */
export function ownedLiveChildren(scan: TranscriptScan, tasks: readonly BgTask[] | undefined): OwnedChild[] {
  const out: OwnedChild[] = [];
  for (const t of tasks ?? []) {
    if (!t || typeof t.id !== 'string') continue;
    if (!scan.launched.has(t.id)) continue;
    const status = String(t.status ?? '');
    if (!LIVE.has(status)) continue;
    out.push({
      id: t.id,
      type: String(t.type ?? scan.launched.get(t.id) ?? 'task'),
      status,
      what: String(t.command ?? t.description ?? '').replace(/\s+/g, ' ').slice(0, 160),
    });
  }
  return out;
}

/**
 * Launched SUBAGENT children that are not live any more and that the lane never
 * referenced after launching them (no completion notice, no read): finished,
 * result never seen (review finding 1).
 *
 * Subagents only, measured on real transcripts: a finished SHELL's output stays
 * in its output file, so an unreferenced one is not lost — and lanes launch many
 * throwaway background shells (one real lane: 45 background "wait block" sleep
 * loops, never referenced again). Holding a lane over those would be a false
 * block per loop. A nested agent's report exists only as its notice.
 */
export function unreadFinishedChildren(scan: TranscriptScan, tasks: readonly BgTask[] | undefined): OwnedChild[] {
  const live = new Set((tasks ?? []).filter((t) => t && LIVE.has(String(t.status ?? ''))).map((t) => t.id));
  const out: OwnedChild[] = [];
  for (const [id, kind] of scan.launched) {
    if (kind !== 'subagent') continue;
    if (live.has(id) || scan.referenced.has(id)) continue;
    out.push({ id, type: kind, status: 'finished-unread', what: '' });
  }
  return out;
}

export interface GuardConfig {
  enabled: boolean;
  /** Consecutive stop attempts with no successful tool call in between before the stop is let through. */
  ignoredLimit: number;
  /** Awake ms a lane may be held by repeated vetoes before the stop is let through. Limits vetoes; not a watchdog. */
  ceilingMs: number;
  /** Largest transcript the guard will read (bytes). Larger = cannot judge (allow + report). */
  maxBytes: number;
  /** Time budget for one judgement (ms). Over budget = cannot judge (allow + report). */
  budgetMs: number;
}

export function guardConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GuardConfig {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
  };
  return {
    enabled: env.CLAUDE_STATION_PARK_GUARD !== '0',
    ignoredLimit: Math.min(20, Math.max(1, num(env.CLAUDE_STATION_PARK_GUARD_IGNORED, 3))),
    ceilingMs: num(env.CLAUDE_STATION_PARK_GUARD_CEILING_MS, 4 * 60 * 60 * 1000),
    maxBytes: num(env.CLAUDE_STATION_PARK_GUARD_MAX_BYTES, 64 * 1024 * 1024),
    budgetMs: Math.max(100, num(env.CLAUDE_STATION_PARK_GUARD_BUDGET_MS, 5_000)),
  };
}

/** Per-lane memory between SubagentStop attempts (keyed by agent_id). */
export interface LaneGuardState {
  firstBlockAt: number;
  lastOkResults: number;
  ignored: number;
  blocks: number;
}

export type ParkWhy = 'ignored' | 'ceiling' | 'disabled' | 'permission-expired';

export type GuardDecision =
  | { action: 'allow'; children: OwnedChild[]; parked: false }
  | { action: 'block'; children: OwnedChild[]; reason: string; state: LaneGuardState }
  | { action: 'allow'; children: OwnedChild[]; parked: true; why: ParkWhy; state?: LaneGuardState };

/** The text the blocked lane reads. Concrete: what is outstanding, how to wait, how to stop. */
export function blockReason(children: OwnedChild[], remaining: { ignoredLeft: number }): string {
  const live = children.filter((c) => c.status !== 'finished-unread');
  const unread = children.filter((c) => c.status === 'finished-unread');
  const lines = ['Orchard: you cannot end your turn yet.'];
  if (live.length) {
    lines.push('Background work YOU started is still running:');
    for (const c of live) lines.push(`  - ${c.id} (${c.type}, ${c.status})${c.what ? `: ${c.what}` : ''}`);
    lines.push('If you end now it is lost: the CLI kills a lane\'s background shells and Monitors when the lane hands back, and a background agent\'s result goes to the orchestrator instead of you. A Monitor does NOT keep you alive.');
  }
  if (unread.length) {
    lines.push(`Background work you started has finished but you never read its result: ${unread.map((c) => `${c.id} (${c.type})`).join(', ')}. Read it (its task notice or output file) before you report.`);
  }
  lines.push(
    'Do ONE of these, then end your turn:',
    '  1. WAIT in the foreground: make a Bash call with timeout 600000 that blocks, e.g. `timeout 300 tail -f /dev/null` (plain `sleep` is rejected), or `timeout 580 tail --pid=<PID> -f /dev/null` if you know the process id. Repeat until the child\'s completion notice reaches you (notices arrive between your tool calls), then read its result.',
    '  2. STOP it (TaskStop with its id, or kill the process you started) if you no longer need it, and say so in your report.',
    `(Trying to end again without a successful tool call first counts as declining to wait; after ${remaining.ignoredLeft} such attempt(s) the stop goes through and is reported to the user as parked work.)`,
  );
  return lines.join('\n');
}

/**
 * Decide one SubagentStop attempt. `prior` is this lane's state from earlier
 * attempts (undefined on the first). `now` is an awake-time clock in ms.
 * `permissionExpired`: this lane already had a permission refused for no
 * answer — it may be unable to wait or stop (its tool calls need the same
 * absent user), so the guard lets it go and records it rather than cycling
 * against the permission deadline (review finding 4).
 */
export function decideSubagentStop(
  args: { scan: TranscriptScan; tasks: readonly BgTask[] | undefined; prior: LaneGuardState | undefined; now: number; cfg: GuardConfig; permissionExpired?: boolean },
): GuardDecision {
  const { scan, tasks, prior, now, cfg } = args;
  const children = [...ownedLiveChildren(scan, tasks), ...unreadFinishedChildren(scan, tasks)];
  if (!children.length) return { action: 'allow', children, parked: false };
  if (!cfg.enabled) return { action: 'allow', children, parked: true, why: 'disabled' };
  if (args.permissionExpired) return { action: 'allow', children, parked: true, why: 'permission-expired' };
  const firstBlockAt = prior?.firstBlockAt ?? now;
  const ignored = prior && scan.okResults <= prior.lastOkResults ? prior.ignored + 1 : 0;
  const state: LaneGuardState = { firstBlockAt, lastOkResults: scan.okResults, ignored, blocks: (prior?.blocks ?? 0) + 1 };
  if (prior && now - firstBlockAt >= cfg.ceilingMs) return { action: 'allow', children, parked: true, why: 'ceiling', state };
  if (ignored >= cfg.ignoredLimit) return { action: 'allow', children, parked: true, why: 'ignored', state };
  return { action: 'block', children, reason: blockReason(children, { ignoredLeft: cfg.ignoredLimit - ignored }), state };
}

/** Read a lane transcript, bounded in size; null + why when it cannot be judged. */
export async function readTranscript(p: unknown, maxBytes: number): Promise<{ text: string } | { error: string }> {
  if (typeof p !== 'string' || !p) return { error: 'no agent_transcript_path in the hook input' };
  try {
    const st = await fs.promises.stat(p);
    if (st.size > maxBytes) return { error: `transcript is ${st.size} bytes, over the ${maxBytes}-byte cap` };
    return { text: await fs.promises.readFile(p, 'utf8') };
  } catch (err) {
    return { error: `transcript unreadable from the server (${(err as Error).message})` };
  }
}

export interface StopVerdictDeps {
  cfg: GuardConfig;
  states: Map<string, LaneGuardState>;
  /** Lanes already nudged to report an expired permission (once each). */
  expiryNudged: Set<string>;
  permissionExpired: (agentId: string) => boolean;
  onParked: (r: { agentId: string; why: ParkWhy | 'cannot-judge'; children: OwnedChild[]; detail: string }) => void;
  now?: () => number;
}

export interface StopVerdict { decision?: 'block'; reason?: string }

const BLOCKED_MARK = 'BLOCKED-ON-PERMISSION';

/**
 * The SubagentStop callback body. Returns `{}` (allow) or a block. Never throws
 * and never exceeds `cfg.budgetMs`: an over-budget or failed judgement allows
 * the stop and reports it, so the guard cannot become a hang of its own.
 */
export async function subagentStopVerdict(input: unknown, deps: StopVerdictDeps): Promise<StopVerdict> {
  const i = (input ?? {}) as { agent_id?: unknown; agent_transcript_path?: unknown; background_tasks?: unknown; last_assistant_message?: unknown };
  const agentId = typeof i.agent_id === 'string' ? i.agent_id : '';
  if (!agentId) return {};
  const tasks = Array.isArray(i.background_tasks) ? (i.background_tasks as BgTask[]) : [];
  const expired = deps.permissionExpired(agentId);
  // A lane whose permission timed out must SAY so in its final report — the
  // orchestrator reads that text, so this is the delivery to it (finding 9).
  if (expired && !deps.expiryNudged.has(agentId)) {
    const last = typeof i.last_assistant_message === 'string' ? i.last_assistant_message : '';
    if (!last.includes(BLOCKED_MARK)) {
      deps.expiryNudged.add(agentId);
      return {
        decision: 'block',
        reason: `Orchard: a permission you asked for timed out unanswered (it was NOT approved). Before you end, add a line to your final report: "${BLOCKED_MARK}: <tool> — <what it needed to do>", so the user can grant it and re-dispatch. Do not retry the request.`,
      };
    }
  }
  const now = deps.now ?? (() => performance.now());
  const judge = (async (): Promise<StopVerdict> => {
    const read = await readTranscript(i.agent_transcript_path, deps.cfg.maxBytes);
    if ('error' in read) {
      const live = tasks.filter((t) => t && LIVE.has(String(t.status ?? '')));
      if (live.length) deps.onParked({ agentId, why: 'cannot-judge', children: [], detail: `${read.error}; ${live.length} background task(s) were live in the session` });
      return {};
    }
    const d = decideSubagentStop({ scan: scanTranscript(read.text), tasks, prior: deps.states.get(agentId), now: now(), cfg: deps.cfg, permissionExpired: expired });
    if (d.action === 'block') { deps.states.set(agentId, d.state); return { decision: 'block', reason: d.reason }; }
    deps.states.delete(agentId);
    if (d.parked) deps.onParked({ agentId, why: d.why, children: d.children, detail: '' });
    return {};
  })();
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<StopVerdict>((resolve) => {
    timer = setTimeout(() => {
      deps.onParked({ agentId, why: 'cannot-judge', children: [], detail: `the guard's ${deps.cfg.budgetMs} ms budget ran out` });
      resolve({});
    }, deps.cfg.budgetMs);
  });
  try {
    return await Promise.race([judge.catch((err) => {
      deps.onParked({ agentId, why: 'cannot-judge', children: [], detail: `guard error: ${(err as Error)?.message ?? String(err)}` });
      return {} as StopVerdict;
    }), budget]);
  } finally { if (timer) clearTimeout(timer); }
}
