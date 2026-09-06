/**
 * ARCH-001 phase 2 / BUG-034 — THE SERVER-AUTHORED RUNNING SET.
 *
 * WHY THIS FILE EXISTS. The client used to answer "what is running right now?"
 * itself, from a union of: `task_*` event fragments it happened to receive, a
 * `replayAgents()` on attach, mtime liveness, a live-bridge override and a
 * couple of per-turn sweeps. Every one of those inputs is lossy, so the answer
 * was wrong in BOTH directions and depended on when you happened to look:
 * phantom rows that outlived the server's own state (BUG-030, and the
 * post-restart tab that kept counting a killed agent's timers up to 0:53), and
 * missing rows for three genuinely-dispatched subagents (BUG-034). Five patches
 * of the same subsystem later, the design — not the arithmetic — was the defect.
 *
 * THE CONTRACT THIS MODULE DEFINES:
 *   1. There is exactly ONE structure that answers "what is running right now",
 *      it is computed on the SERVER, and it is derived from the ARCH-001
 *      authority (`liveness.ts`) — never from a second opinion. No liveness
 *      rung is re-implemented here; this module only ARRANGES the authority's
 *      answer plus the session's own agent map into one payload.
 *   2. It is a SNAPSHOT, not a delta: it names everything that is running, so
 *      receiving one is enough to render the whole strip. An EMPTY `running` is
 *      a real, load-bearing answer — it is what corrects a client that is
 *      showing rows the server does not believe in, WITHOUT a page reload.
 *   3. Start times are the SERVER's honest ones (`startedAt` from the frame the
 *      agent actually started on; `turn.since` from the bridge's own
 *      `turnStartedAt`). `null` means "not knowable" and the client must render
 *      an honest "—", never a stopwatch started when the tab found out
 *      (BUG-033).
 *   4. It carries FEAT-057's `ended` records, because the structure that
 *      answers "what runs" must be the same one that answers "what died" —
 *      building them apart is what created the split-brain in the first place.
 *
 * Deltas (`agent-started`/`agent-progress`/`agent-completed`) still flow, and
 * still drive the transcript's threads and "ran" rows. They just no longer
 * decide what is ALIVE. The snapshot is the correcting authority.
 */
import type { LiveAgent } from './events.ts';
import {
  livenessOfBridge, livenessOfSurvivor, survivorWork,
  type BridgeLike, type DeliveryEvidence, type LivenessKind, type LivenessState,
} from './liveness.ts';
import type { AgentOutcome } from './outcomes.ts';
import type { HostStatus } from './survival.ts';
/*
 * BUG-046 — the stall judgment. A running row whose evidence stops progressing
 * (no frames, no counter movement, no live process signal) is marked ⚠ stalled
 * IN PLACE: the row stays in `running`, its state changes. Advisory only —
 * never removed here, never recorded as a death (BUG-041: a stall is the third
 * outcome besides running/dead, and it is not an outcome record at all).
 */
import { judgeStall, type StallEvidence, type StallSignal } from './stalls.ts';

/** One thing that is running RIGHT NOW. `main` is the orchestrator's own turn. */
export interface RunningEntry {
  /** Agent task id, or the literal `'main'`. Stable for the row's lifetime. */
  id: string;
  /**
   * What kind of row this is:
   *  - `main`  the session's own turn (see the main-row decision in BUG-034)
   *  - `agent` a real subagent (Task tool / `task_type:'local_agent'`)
   *  - `tool`  a single tool call the CLI surfaces as its own task (BUG-030)
   */
  row: 'main' | 'agent' | 'tool';
  label: string;
  description: string;
  /** SERVER clock, epoch ms. `null` = not knowable → the client renders "—". */
  startedAt: number | null;
  lastTool: string | null;
  toolUses: number;
  totalTokens: number;
  /**
   * BUG-046 — the row's evidence state. `running` = evidence is progressing (or
   * a live process signal vouches for it). `stalled` = nothing about this row
   * has progressed for the stall window AND no live signal exists — the work
   * may have silently died, and a human should look. A stalled row is still a
   * member of `running` (it was never proven ended); it is never removed and
   * never recorded as a death. Optional on the wire: an older server simply
   * sends rows without it, and clients must treat absence as `running`.
   */
  state?: 'running' | 'stalled';
  /** Present iff `state === 'stalled'` — the ⚠'s quotable evidence. */
  stall?: StallEvidence;
  /*
   * FEAT-126 — the DECLARED attribution carried from the lane's charter Dispatch
   * line (see LiveAgent.ticket/request). Optional on the wire: an older server, a
   * survivor lane, or an undeclared dispatch simply carries neither, and the
   * "Your requests" join falls back to the board owner-column read. This is what
   * lets a live lane be attributed to a SPECIFIC request rather than lighting up
   * every request in a session that merely has one lane alive.
   */
  ticket?: string[];
  request?: string | null;
}

export interface RunningSnapshot {
  /** Wire version. A client that does not recognise it must render nothing. */
  v: 1;
  /** SERVER clock when this snapshot was computed — the client reconciles against it. */
  at: number;
  stationSessionId: string | null;
  sdkSessionId: string | null;
  /**
   * The session's own turn, straight from the authority's verdict:
   * `running` is the authority's claim, `since` its honest start.
   */
  turn: {
    running: boolean;
    since: number | null;
    state: LivenessState;
    kind: LivenessKind;
    reason: string;
  };
  /** Everything running right now. EMPTY IS AN ANSWER — see the header. */
  running: RunningEntry[];
  /** FEAT-057 — recent deaths for this session, newest first (bounded). */
  ended: AgentOutcome[];
  /**
   * Where the snapshot came from:
   *  - `bridge`     a live session object on this server answered
   *  - `survivor`   no bridge, but a restart-surviving CLI is still running
   *                 this session's work; the broker's own declarations (plus,
   *                 for a FEAT-065-delivered turn, this server's delivery
   *                 relay) say what — BUG-072
   *  - `no-session` this server has no live session for that id — which is a
   *                 REAL answer meaning "nothing is running", not an error
   */
  source: 'bridge' | 'no-session' | 'survivor';
}

/**
 * What the snapshot builder needs from an `AgentSession`. Declared structurally
 * (extending the authority's own `BridgeLike`) so this module has no runtime
 * dependency on agent-bridge.ts — the dependency runs one way, exactly as it
 * does for `liveness.ts`.
 */
export interface SnapshotSource extends BridgeLike {
  id: string;
  sdkSessionId: string | null;
  /** The session's CURRENT agent map (the same one `liveAgents()` exposes). */
  liveAgents(): LiveAgent[];
  /**
   * BUG-046 — a live process signal for one agent row, or null when none
   * exists. Supplied by the bridge (today: the engine's background-task level
   * listing the id). Optional so older/leaner sources judge on progress alone.
   */
  stallSignalFor?(agentId: string): StallSignal | null;
}

function entryFor(a: LiveAgent, source: SnapshotSource, now: number): RunningEntry {
  const startedAt = Number.isFinite(a.startedAt) ? a.startedAt : null;
  /*
   * BUG-046 — judge the row's evidence. Pure recomputation on every snapshot:
   * a row that resumes progressing simply stops judging stalled, with no
   * residue to clear. `main` never reaches here (the authority's frameless
   * backstop owns the main turn's silence).
   */
  const verdict = judgeStall({
    lastProgressAt: Number.isFinite(a.lastProgressAt as number) ? (a.lastProgressAt as number) : null,
    startedAt,
    signal: source.stallSignalFor?.(a.agentId) ?? null,
  }, now);
  return {
    id: a.agentId,
    row: a.kind === 'tool' ? 'tool' : 'agent',
    label: a.agentType,
    description: a.description || a.lastTool || '',
    startedAt,
    lastTool: a.lastTool ?? null,
    toolUses: a.toolUses ?? 0,
    totalTokens: a.totalTokens ?? 0,
    state: verdict.stalled ? 'stalled' : 'running',
    ...(verdict.stalled && verdict.evidence ? { stall: verdict.evidence } : {}),
    // FEAT-126 — carry the lane's declared attribution through onto the snapshot
    // entry, so the request surface can read it per-lane. Only present when the
    // charter declared it (a gap stays a gap, never a fabricated binding).
    ...(a.ticket && a.ticket.length ? { ticket: a.ticket } : {}),
    ...(a.request ? { request: a.request } : {}),
  };
}

/**
 * THE builder. One call, one authority consulted, no local rungs.
 *
 * The two gates, and why they are exactly these:
 *  - `!v.live` → the authority no longer vouches for this session (its process
 *    is proven gone, or it is past the frameless backstop with no ground truth).
 *    NOTHING may be reported as running behind a verdict like that, agents
 *    included: that is the phantom-row half of the class, and it is why the
 *    snapshot can EMPTY a client that is still showing rows.
 *  - the `main` row is present iff the authority says a turn is in flight
 *    (`v.running`). Not `session.busy` — the raw flag is the CLAIM, and a claim
 *    the verdict overrides is precisely BUG-033's zombie.
 *
 * Agents are reported from the session's own map filtered to `status:'running'`
 * — the bridge settles that map at every terminal frame and sweeps it at the
 * turn's `result` (BUG-030), so "still marked running" plus "the authority
 * vouches for the session" is the strongest statement the server can honestly
 * make, and it is strictly better than anything the client could accumulate.
 */
export function snapshotOfSession(
  s: SnapshotSource,
  ended: AgentOutcome[] = [],
  now = Date.now(),
): RunningSnapshot {
  const v = livenessOfBridge(s, now);
  const running: RunningEntry[] = [];
  if (v.live) {
    if (v.running) {
      running.push({
        id: 'main',
        row: 'main',
        label: 'main',
        description: '',
        startedAt: v.since,
        lastTool: null,
        toolUses: 0,
        totalTokens: 0,
        state: 'running',
      });
    }
    for (const a of s.liveAgents()) {
      if (a.status === 'running') running.push(entryFor(a, s, now));
    }
  }
  return {
    v: 1,
    at: now,
    stationSessionId: s.id,
    sdkSessionId: s.sdkSessionId,
    turn: { running: v.live && v.running, since: v.since, state: v.state, kind: v.kind, reason: v.reason },
    running,
    ended,
    source: 'bridge',
  };
}

/**
 * BUG-072 — THE SNAPSHOT FOR A SESSION THIS SERVER DOES NOT OWN BUT WHOSE WORK
 * IS DEMONSTRABLY RUNNING.
 *
 * After a restart, a survivor whose drain is held by continuous background work
 * is never reaped, so `adoptSurvivingHosts` → resume-from-disk never happens
 * and this server holds NO bridge — while FEAT-065 keeps delivering every user
 * message into that same CLI, which answers normally. Every surface therefore
 * said "nothing is running" about a session that was running turns all day
 * (BUG-072's captured `rows:[]` / `busy:false`). That is the ARCH-001 violation
 * the ticket names, and this is its repair: the SAME snapshot structure, built
 * from the SAME authority (`survivorWork`, which reads only the broker's own
 * declarations plus this server's delivery-relay evidence — no new rung, no
 * process guessing here).
 *
 * What it deliberately does NOT do: claim ownership. The rows say what is
 * running; the lifecycle is unchanged (the survivor is still the single writer
 * of its transcript, and no second CLI is ever spawned for it).
 */
export function snapshotOfSurvivor(
  st: HostStatus,
  opts: { ended?: AgentOutcome[]; delivery?: DeliveryEvidence | null; now?: number } = {},
): RunningSnapshot {
  const now = opts.now ?? Date.now();
  const v = livenessOfSurvivor(st);
  const work = survivorWork(st, opts.delivery ?? null);
  const running: RunningEntry[] = [];
  if (v.live) {
    if (work.turnRunning === true) {
      running.push({
        id: 'main',
        row: 'main',
        label: 'main',
        description: '',
        startedAt: work.turnSince,
        lastTool: null,
        toolUses: 0,
        totalTokens: 0,
        state: 'running',
      });
    }
    for (const lane of work.lanes) {
      running.push({
        id: lane.id,
        row: lane.row,
        label: lane.label,
        description: '',
        startedAt: lane.startedAt,
        lastTool: null,
        toolUses: 0,
        totalTokens: 0,
        /*
         * Never `stalled`: the stall judgment is a BRIDGE-side evidence
         * verdict (frame progress this server does not receive for a survivor's
         * lanes). Claiming a stall from an absence we cannot observe would be
         * exactly the fabrication BUG-041 forbids; the lane is reported as what
         * the CLI's own level frame still declares — running.
         */
        state: 'running',
      });
    }
  }
  return {
    v: 1,
    at: now,
    stationSessionId: st.stationSessionId ?? null,
    sdkSessionId: st.sdkSessionId ?? st.resumeHint ?? null,
    turn: {
      running: v.live && work.turnRunning === true,
      since: work.turnSince,
      state: v.state,
      kind: v.kind,
      reason: work.reason,
    },
    running,
    ended: opts.ended ?? [],
    source: 'survivor',
  };
}

/**
 * The answer for a session this server is not driving: nothing is running.
 *
 * This is not an error path and must not be rendered as one. A tab that lived
 * through a server restart, or that is looking at a session whose bridge was
 * reaped, asks for a snapshot and gets THIS — which is what empties its strip
 * without a reload. It still carries the death records, so the reason the
 * session is gone stays visible.
 */
export function emptySnapshot(
  ids: { stationSessionId?: string | null; sdkSessionId?: string | null },
  reason: string,
  ended: AgentOutcome[] = [],
  now = Date.now(),
): RunningSnapshot {
  return {
    v: 1,
    at: now,
    stationSessionId: ids.stationSessionId ?? null,
    sdkSessionId: ids.sdkSessionId ?? null,
    turn: { running: false, since: null, state: 'unknown', kind: 'unknown', reason },
    running: [],
    ended,
    source: 'no-session',
  };
}
