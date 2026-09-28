/**
 * Session host — the durable transport broker that lets a driven `direct`
 * session's `claude` CLI OUTLIVE the claude-station server (FEAT-015).
 *
 * WHY THIS EXISTS
 * ---------------
 * For isolation "direct" the Agent SDK spawns the `claude` CLI as a direct child
 * of the server and talks stream-json over the child's stdio PIPES. Two things
 * then kill an in-flight turn on a server restart:
 *   1. cgroup reaping — the systemd unit is KillMode=control-group, so a restart
 *      SIGTERMs the whole service cgroup, CLI included; and
 *   2. transport death — even a surviving CLI is useless once the pipes it reads
 *      from / writes to are held by a dead parent (stdin EOF ends the turn,
 *      stdout EPIPE kills it).
 *
 * This host solves BOTH. It is launched into its OWN transient systemd scope
 * (a separate cgroup — see survival.ts), so the service's control-group kill
 * never reaches it. It OWNS the CLI's stdio: it keeps the CLI's stdin OPEN and
 * always DRAINS its stdout, so when the server dies the CLI neither gets EOF nor
 * blocks on a full pipe — the in-flight turn (and its in-process Task
 * sub-agents) runs to completion and the CLI writes its transcript to disk as
 * usual. A client (the server, live or freshly restarted) connects over a unix
 * socket to relay the SDK's stream-json; a disconnect is survivable, a
 * reconnect resumes the relay.
 *
 * GRACEFUL SHUTDOWN. A SIGTERM/SIGINT to THIS host is the "you may finish and
 * exit now" signal: it ends the CLI's stdin (EOF), which lets the current turn
 * DRAIN to completion (EOF is end-of-input, not an interrupt — same contract as
 * AgentSession.close()'s #input.end()), then the CLI exits and the host exits.
 * That is how an explicit session close and the boot-time re-adopt reap a host
 * without losing the in-flight turn.
 *
 * Run as:
 *   node session-host.mjs <controlJsonPath>
 * where the control JSON is { sock, status, errlog, command, args, meta }.
 * cwd and env are inherited from the spawner (the SDK's SpawnOptions).
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as nodePath from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { augmentedPathEnv } from './path-env.mjs';
import { RequestFloor, floorGraceFromEnv, laneBlockMsFromEnv } from './request-floor.mjs';

/*
 * BUG-187 — BROKER PROTOCOL 2.
 *
 * The broker is the only process whose lifetime equals the CLI's, so it owns
 * three facts nobody else can state truthfully (ARCH-010):
 *   - whether anyone is attached to answer the CLI (`responder`);
 *   - which of the CLI's control requests are still unanswered, and by whom
 *     they are owned (the request floor, request-floor.mjs);
 *   - whether work outlives the turn (`backgroundLifetime`, now including
 *     revived lanes the level does not list).
 * It talks to its client in-band with `orchard_broker_*` lines that are never
 * forwarded to the CLI (H3), and a client strips them before the SDK sees
 * anything (survival.ts).
 */
const BROKER_PROTOCOL = 2;
const BROKER_LINE_PREFIX = 'orchard_broker_';
const BROKER_REQ_PREFIX = 'orchard-broker-';

function fail(msg) {
  process.stderr.write(`[session-host] ${msg}\n`);
  process.exit(1);
}

const controlPath = process.argv[2];
if (!controlPath) fail('usage: session-host.mjs <controlJsonPath>');

let ctl;
try {
  ctl = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
} catch (err) {
  fail(`cannot read control file ${controlPath}: ${err.message}`);
}
const { sock, status, errlog, command, args, meta } = ctl;
if (!sock || !status || !command || !Array.isArray(args)) fail('control file missing sock/status/command/args');

/**
 * Atomic status write — a restarted server reads this to re-adopt the host.
 *
 * FEAT-064 (BUG-048's truth surface): EVERY write — including the decline
 * heartbeats of the abandon net and the held drain — carries WHAT the broker
 * knows about the work holding it: `backgroundLive` (task count from the CLI's
 * own level frames), the sniffed task ids, the current lifetime answer, and
 * `drainHeldSince` (the first moment a reap/commit was declined because of
 * that work). The refusal payload, /api/health and the BUG-045 chip read
 * these instead of presenting a bare "try again in a few seconds".
 */
function writeStatus(patch) {
  const now = {
    ...(state.status), ...patch,
    backgroundLive: state.backgroundTaskCount,
    backgroundTaskIds: state.backgroundTaskIds,
    backgroundLifetime: backgroundOutlivesTurn(),
    drainHeldSince: state.drainHeldSince,
    // FEAT-065: is a foreground turn in flight RIGHT NOW? The delivery gate
    // (index.ts) injects into a drain-held survivor only when this is false —
    // a mid-foreground-drain survivor keeps today's queue-and-wait. Refreshed
    // on every turn-boundary transition (see onStreamJsonLine), not only on
    // the drain cadence, so the reader's copy is at most one boundary old.
    midTurn: state.midTurn,
    // BUG-072: the visibility half — WHEN the in-flight turn opened, and the
    // background lanes with the engine's own task_type + first-seen stamp, so a
    // surviving-unadopted session can be RENDERED as what it is (a live main
    // turn plus its lanes) instead of reported as "nothing running". Declared
    // facts only: both are null/[] until the CLI's own frames say otherwise.
    midTurnSince: state.midTurnSince,
    backgroundTasks: state.backgroundTasks,
    // BUG-187 H1 — declared freshness: the protocol this broker speaks, a
    // monotonic sequence number, and the last moment a status write FAILED
    // (a reader can tell a stale record from a fresh one).
    protocol: BROKER_PROTOCOL,
    seq: ++state.seq,
    statusWriteFailedAt: state.statusWriteFailedAt,
    // BUG-187 H2 — lanes revived by `task_started` that the level may not list.
    startedTasks: [...state.startedTasks.keys()],
    // BUG-187 H4/H5 — the responder fact and the request floor's ledger.
    responder: state.client ? 'attached' : 'none',
    responderLostAt: state.responderLostAt,
    adoptedAt: state.adoptedAt,
    ...floorStatus(),
    // BUG-187 H7 — false from the moment stdin was ended (EOF committed).
    acceptingInput: !state.stdinEnded,
    updatedAt: new Date().toISOString(),
  };
  state.status = now;
  const tmp = `${status}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(now), { mode: 0o600 });
    fs.renameSync(tmp, status);
  } catch {
    // Best effort — the /proc-visible process is the real source of truth. But
    // a failed write leaves the PREVIOUS record on disk, which can say `no`
    // while the lane is live (BUG-187 review point 4), so remember it: the
    // in-band lifetime answer carries it, and the next successful write does.
    state.statusWriteFailedAt = new Date().toISOString();
  }
}
/** The floor's published half (absent until the floor exists — the very first write precedes it). */
function floorStatus() {
  if (!floor) return { refusals: 0, pendingRequests: 0, lanes: [] };
  const snap = floor.snapshot();
  return {
    refusals: snap.refusals,
    pendingRequests: snap.pending.unowned + snap.pending.owned + snap.pending.handover,
    pendingUnowned: snap.pending.unowned,
    lanes: snap.lanes,
  };
}

const state = {
  status: {
    hostPid: process.pid,
    claudePid: null,
    sock,
    status,
    command,
    args,
    ...(meta && typeof meta === 'object' ? meta : {}),
    startedAt: new Date().toISOString(),
    state: 'starting',
    exitCode: null,
    signal: null,
  },
  client: null,
  child: null,
  exiting: false,
  reaping: false,
  // Turn tracking (BUG-022). A graceful reap must not sever stdin (EOF) while a
  // turn is genuinely in-flight — the CLI treats stdin-EOF as "no more input"
  // and exits at the next opportunity WITHOUT waiting for a pending tool call,
  // truncating the turn (its later steps + final reply are lost). We watch the
  // CLI's stream-json stdout for turn boundaries so reap can wait for the
  // current turn's `result` before EOF, then the CLI exits having completed it.
  midTurn: false,
  reapPending: false,
  stdinEnded: false,
  // BUG-043: is the CLI reporting live BACKGROUND work (work that outlives its
  // turn)? Tracked from the CLI's own `background_tasks_changed` LEVEL frames
  // on the same stdout this broker already sniffs. false until the first frame:
  // a CLI that never emits the signal gets the pre-BUG-043 abandon behaviour.
  backgroundLive: false,
  // FEAT-064 truth surface: the level frame's task count + sniffed ids, and the
  // moment a reap/commit was FIRST declined because of held work (null until a
  // decline happens; stable across heartbeats — an epoch, not a ticker).
  backgroundTaskCount: 0,
  backgroundTaskIds: [],
  drainHeldSince: null,
  // BUG-072 visibility: the same lanes with their engine-declared task_type and
  // the moment THIS broker first saw each one (an epoch per lane, carried
  // across level frames so a lane's clock does not restart on every frame), and
  // when the current foreground turn opened. Both feed the running strip for a
  // surviving-unadopted session; both stay empty/null until the CLI says so.
  backgroundTasks: [],
  midTurnSince: null,
  // FEAT-064 midTurn gate: when the drain commit began declining ONLY because a
  // turn is in flight (background already 'no'). Bounds that hold — see
  // commitDrain(); cleared by the turn's `result`.
  midTurnCommitWaitSince: null,
  // BUG-044 (mirrors agent-bridge's #bgDispatchAt, ARCH-002's unknown posture):
  // the level frame LAGS the dispatching turn's `result` by seconds, so a drain
  // that lands inside that window must not read `backgroundLive:false` as "no
  // background work". Record the moment a background dispatch was SEEN going out
  // (an assistant `tool_use` block with `run_in_background: true`); until a
  // level frame arrives (which supersedes the hint entirely) or a bounded window
  // expires, the lifetime answer is `unknown` — and unknown HOLDS, never reaps.
  bgDispatchAt: null,
  // BUG-074: the last moment a frame CORROBORATED that background work is
  // progressing — a non-empty level frame, a task-lifecycle event, or a
  // background sub-agent's inner frame, all of which a genuinely-live agent
  // emits continuously on this same stdout. backgroundOutlivesTurn() downgrades a
  // 'yes' whose level has gone UNCORROBORATED for BG_STALE_MS to 'unknown':
  // bounded trust in a DECLARED level (ARCH-002), and — critically — it NEVER
  // forces an EOF (unknown still HOLDS), so genuinely-live-but-quiet work is
  // never truncated (BUG-044 stays green). null until the first live level.
  lastBackgroundActivityAt: null,
  // BUG-187 H1: monotonic status sequence + the last failed status write.
  seq: 0,
  statusWriteFailedAt: null,
  // BUG-187 H2: task ids started (task_started) that are not in the current
  // level — a revived lane is live to the broker without needing a level frame.
  // Cleared by the task's own terminal frame.
  startedTasks: new Map(),
  // BUG-187: when the last client dropped (null while one is attached), and
  // when a client last ADOPTED this CLI (initialize with its hooks applied).
  responderLostAt: new Date().toISOString(),
  adoptedAt: null,
  clientId: null,
};
/** Declared once the CLI is spawned; referenced by writeStatus through floorStatus(). */
let floor = null;

// BUG-074: engine background LIFECYCLE subtypes — the level frame plus the
// per-task status events the CLI emits on the SAME stdout as foreground turn
// frames. They are NOT foreground turn activity: treating them (or a background
// sub-agent's inner frames, which carry a top-level `parent_tool_use_id`) as a
// live foreground turn PINS midTurn=true for a background lane's entire
// multi-minute life, which blocks the FEAT-065 delivery gate (midTurn===false) —
// BUG-074's 26-minute stuck message. Confirmed against real CLI 2.1.227.
const BACKGROUND_LIFECYCLE_SUBTYPES = new Set([
  'background_tasks_changed', 'task_started', 'task_updated', 'task_notification', 'task_progress',
]);

// stderr of the CLI is captured to a log so a crash reason is recoverable; it is
// NOT part of the stream-json transport the client relays.
let errStream = null;
if (errlog) { try { errStream = fs.createWriteStream(errlog, { flags: 'a' }); } catch { /* optional */ } }

// BUG-091: this is a HOST-side engine spawn (direct/sandbox survival). Prepend
// the user's local tool dirs (~/.local/bin, ~/.cargo/bin) to PATH so MCP servers
// the engine launches (e.g. serena via uvx) resolve even when the service was
// cold-booted with a minimal systemd PATH. HOST-ONLY on purpose: container
// isolation never reaches here (it goes through container-manager's docker exec,
// which builds the in-container PATH from a fixed passthrough list).
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: process.cwd(), env: augmentedPathEnv(process.env) });
state.child = child;
writeStatus({ claudePid: child.pid, state: 'running' });

// EPIPE on stdin can happen if the CLI exits first — never let it crash the host.
child.stdin.on('error', () => { /* CLI gone; exit handler will clean up */ });

/** One JSON line to the CLI's stdin (the broker's own writes: refusals, stop_task, delivered turns). */
function writeToCli(obj) {
  if (state.stdinEnded) return false;
  try { child.stdin.write(`${JSON.stringify(obj)}\n`); return true; } catch { return false; }
}
function logHost(msg) {
  if (errStream) { try { errStream.write(`[session-host ${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ } }
}

/*
 * BUG-187 H4/H5 — the request floor. Every control_request the CLI emits is
 * recorded; one nobody attached saw (or whose owner dropped) is REFUSED after
 * its grace, so a tool call fails fast with a reason instead of timing out
 * after 600 s (hooks) or hanging forever (permissions). A lane blocked with
 * nobody adopting is stopped with `stop_task` after LANE_BLOCK_MS — that lane
 * only. Nothing here ever ends the CLI.
 */
let stopSeq = 0;
floor = new RequestFloor({
  grace: floorGraceFromEnv(process.env),
  laneBlockMs: laneBlockMsFromEnv(process.env),
  write: (frame) => { writeToCli(frame); },
  stopLane: (laneId) => {
    writeToCli({ type: 'control_request', request_id: `${BROKER_REQ_PREFIX}stop-${++stopSeq}`, request: { subtype: 'stop_task', task_id: laneId } });
  },
  onChange: () => writeStatus({}),
  log: logHost,
});
const floorTicker = setInterval(() => { if (!state.exiting) floor.tick(); }, 250);
floorTicker.unref?.();

// BUG-187 H1 — heartbeat, so a live broker's record never looks stale.
const HOST_HEARTBEAT_MS = Number(process.env.CLAUDE_STATION_HOST_HEARTBEAT_MS ?? 15_000);
const heartbeat = setInterval(() => { if (!state.exiting) writeStatus({}); }, HOST_HEARTBEAT_MS > 0 ? HOST_HEARTBEAT_MS : 15_000);
heartbeat.unref?.();

// Idempotent stdin EOF — the "you may finish and exit now" signal to the CLI.
function endStdin() {
  if (state.stdinEnded) return;
  state.stdinEnded = true;
  try { child.stdin.end(); } catch { /* already gone */ }
  // BUG-187 H7: from here on no input is accepted — publish it at once so a
  // delivery gate reading the record cannot hand a message to a closing CLI.
  writeStatus({});
}

/*
 * Parse the CLI's newline-delimited stream-json stdout to learn two things a
 * restarted server needs:
 *   1. the CLI's ACTUAL session id (its transcript file name), from the first
 *      `init` message — persisted into the status file so the fresh server's
 *      resume guard can match it and never spawn a SECOND `claude --resume` onto
 *      the same transcript while this broker is still draining (BUG-022); and
 *   2. TURN BOUNDARIES — a `result` message ends a turn; anything else
 *      (`user`/`assistant`/`stream_event`/tool activity) means a turn is
 *      in-flight. `gracefulReap` uses this to hold stdin-EOF until the current
 *      turn's `result` lands, so a re-adopt mid-tool-call finishes the turn
 *      instead of truncating it.
 * This only observes the bytes; the raw stream is still forwarded verbatim to
 * the client below.
 */
let sdkIdCaptured = false;
let lineBuf = '';
/** Client initialize requests in flight: request_id → { clientId, carriedHooks }. */
const initRequests = new Map();
/** Terminal task statuses on a `task_updated` patch. */
const TERMINAL_TASK_STATUS = new Set(['completed', 'failed', 'killed', 'stopped']);
/**
 * Observe one CLI stdout line. Returns false when the line is the broker's OWN
 * business and must not be forwarded to the client (the CLI's answer to a
 * broker-originated request such as `stop_task`, or a replay of a request the
 * floor has already settled); true to forward it verbatim; or a STRING to
 * forward instead (an initialize answer with settled ids stripped from its
 * redelivery — BUG-187 round 5).
 */
function onStreamJsonLine(line) {
  const s = line.trim();
  if (!s) return true;
  let m;
  try { m = JSON.parse(s); } catch { return true; } // partial/non-JSON — ignore, forward verbatim
  if (!m || typeof m !== 'object') return true;
  // BUG-187 H4 — the control channel, CLI → client.
  if (m.type === 'control_request') {
    // BUG-187 round 5: a replay of an id the floor already answered (refused,
    // answered, cancelled) is not shown again — one card, one answer.
    if (!floor.onCliRequest(m, state.client ? state.clientId : null)) return false;
  } else if (m.type === 'control_cancel_request') {
    floor.onCliCancel(m.request_id);
  } else if (m.type === 'control_response') {
    const rid = m.response?.request_id;
    if (typeof rid === 'string' && rid.startsWith(BROKER_REQ_PREFIX)) return false; // our own stop_task's answer
    if (rid != null && initRequests.has(String(rid))) {
      onInitializeAnswered(String(rid), m.response);
      const stripped = stripSettledRedelivery(m);
      if (stripped) return stripped;
    }
  }
  // FEAT-065: publish turn-boundary TRANSITIONS to the status file (one write
  // at turn open, one at close — never per-frame) so the delivery gate reads a
  // fresh midTurn instead of one up to a whole drain-recheck stale.
  const midTurnBefore = state.midTurn;
  let laneLevelChanged = false;
  // BUG-074: is this a BACKGROUND-lane frame rather than the foreground turn? A
  // sub-agent's inner frames carry a top-level `parent_tool_use_id` (null on
  // foreground frames); the engine's background lifecycle events are the level +
  // task-status subtypes. Either KEEPS this frame out of midTurn tracking (below)
  // and corroborates that background work is progressing (refreshing the
  // anti-stale clock consulted by backgroundOutlivesTurn).
  const isSubagentFrame = typeof m.parent_tool_use_id === 'string' && m.parent_tool_use_id.length > 0;
  const isBackgroundLifecycle = m.type === 'system' && BACKGROUND_LIFECYCLE_SUBTYPES.has(m.subtype);
  const isBackgroundLaneFrame = isSubagentFrame || isBackgroundLifecycle;
  if (isSubagentFrame) state.lastBackgroundActivityAt = Date.now();
  if (!sdkIdCaptured && typeof m.session_id === 'string' && m.session_id) {
    sdkIdCaptured = true;
    writeStatus({ sdkSessionId: m.session_id });
  }
  // BUG-043: the CLI's own level signal for work that OUTLIVES the turn. Kept
  // separate from the midTurn chain below (this frame must not perturb turn
  // tracking): the abandon net consults it so a broker whose server never comes
  // back does not SIGTERM a CLI whose background agents are still working.
  if (m.type === 'system' && m.subtype === 'background_tasks_changed') {
    state.backgroundLive = Array.isArray(m.tasks) && m.tasks.length > 0;
    // FEAT-064: keep the count + ids so the decline heartbeats can say WHAT is
    // holding the drain, not merely that something is.
    state.backgroundTaskCount = Array.isArray(m.tasks) ? m.tasks.length : 0;
    state.backgroundTaskIds = Array.isArray(m.tasks)
      ? m.tasks.map((t) => t?.task_id ?? t?.taskId ?? t?.id ?? null).filter((x) => typeof x === 'string' && x)
      : [];
    // BUG-074: a non-empty level is fresh corroboration the work is alive.
    if (state.backgroundTaskCount > 0) state.lastBackgroundActivityAt = Date.now();
    // BUG-072: the same level, kept with each lane's declared type and its
    // FIRST-seen stamp (carried over from the previous level so a lane's clock
    // is its own age, not the age of the last frame that mentioned it).
    const wasLanes = state.backgroundTasks;
    const seenBefore = new Map(wasLanes.map((t) => [t.id, t.since]));
    state.backgroundTasks = Array.isArray(m.tasks)
      ? m.tasks.map((t) => {
        const id = t?.task_id ?? t?.taskId ?? t?.id ?? null;
        if (typeof id !== 'string' || !id) return null;
        return {
          id,
          type: typeof t?.task_type === 'string' ? t.task_type : (typeof t?.type === 'string' ? t.type : null),
          since: seenBefore.get(id) ?? new Date().toISOString(),
        };
      }).filter(Boolean)
      : [];
    // A level frame is a BOUNDARY too (rare — one per lane start/stop), so
    // publish it: without this the lanes reach disk only on the next turn
    // boundary or drain re-check, and the strip lags a live lane by up to a
    // whole re-check interval. Never per-frame: level frames are not stream
    // frames.
    laneLevelChanged = wasLanes.length !== state.backgroundTasks.length
      || wasLanes.some((t, i) => t.id !== state.backgroundTasks[i]?.id);
    // BUG-187 H5: a lane the level dropped has ended — a stop the floor asked
    // for is confirmed by this as much as by the lane's own terminal frame.
    const nowIds = new Set(state.backgroundTasks.map((t) => t.id));
    for (const t of wasLanes) if (!nowIds.has(t.id)) floor.onLaneTerminal(t.id);
    /*
     * H2, bounded: a started lane is live until its terminal frame, OR until a
     * level that had LISTED it (after its task_started) drops it — the engine
     * itself then said it ended, and the SDK warns that a missed bookend must
     * not wedge a running indicator. A started id no level has listed yet (a
     * revival the level does not carry — BUG-157's shape) stays live until its
     * own terminal frame: its absence from the level is not evidence it ended.
     */
    for (const [id, rec] of [...state.startedTasks]) {
      if (nowIds.has(id)) rec.seenInLevel = true;
      else if (rec.seenInLevel) { state.startedTasks.delete(id); floor.onLaneTerminal(id); }
    }
    // BUG-044: any level frame supersedes the dispatch-observed hint — from here
    // on the level itself is the authority (including an empty one).
    state.bgDispatchAt = null;
  }
  // BUG-044 pre-signal race guard: a background dispatch is visible in the
  // assistant frame seconds before the engine's level frame reports it.
  let dispatchSeen = false;
  if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
    for (const block of m.message.content) {
      if (block && block.type === 'tool_use' && block.input?.run_in_background === true) {
        state.bgDispatchAt = Date.now();
        dispatchSeen = true;
      }
    }
  }
  /*
   * BUG-187 H2 — REVIVAL EVIDENCE. A `task_started` for an id the current level
   * does not list (a SendMessage revival of a finished agent, or a lane whose
   * level frame has not landed) is live work to the broker from this frame on,
   * without waiting for a level. Its own terminal frame clears it.
   */
  let startedChanged = false;
  if (m.type === 'system' && typeof m.task_id === 'string' && m.task_id) {
    if (m.subtype === 'task_started') {
      if (!state.backgroundTaskIds.includes(m.task_id) && !state.startedTasks.has(m.task_id)) {
        state.startedTasks.set(m.task_id, { at: Date.now(), seenInLevel: false });
        startedChanged = true;
      }
      state.lastBackgroundActivityAt = Date.now();
    } else if (m.subtype === 'task_notification'
      || (m.subtype === 'task_updated' && TERMINAL_TASK_STATUS.has(m.patch?.status))) {
      if (state.startedTasks.delete(m.task_id)) startedChanged = true;
      floor.onLaneTerminal(m.task_id);
    }
  }
  if (isBackgroundLaneFrame) {
    // BUG-074: background-lane activity NEVER perturbs the FOREGROUND turn's
    // midTurn. A background sub-agent streams inner frames on this same stdout
    // for its whole (multi-minute) life; before this guard each one flipped
    // midTurn=true and there was no foreground `result` to clear it, so the
    // FEAT-065 delivery gate (midTurn===false) stayed shut and the user's queued
    // message waited the entire background agent instead of one boundary tick.
  } else if (m.type === 'result') {
    // Turn finished. If a reap is waiting for exactly this, move to the drain
    // commit (BUG-044: lifetime-gated — EOF only once no background work is
    // live) so the CLI exits having completed the turn AND its background work.
    state.midTurn = false;
    state.midTurnCommitWaitSince = null; // FEAT-064: the turn the commit was waiting on is closed
    if (state.reapPending && !state.stdinEnded) { state.reapPending = false; requestDrainCommit(); }
  } else if (m.type === 'system' && m.subtype === 'init') {
    state.midTurn = false; // idle after init until the first user turn
  } else if (m.type === 'system' || NON_TURN_TYPES.has(m.type)) {
    /*
     * BUG-187 H9 (fallback branch, decided by arm A17): a `system` frame is not
     * turn activity. The real CLI emits them AFTER a turn's `result` (e.g.
     * `stop_hook_summary`), and the old catch-all re-opened `midTurn` on them —
     * the stale "running" the incident's survivor row showed for five hours.
     * `session_state_changed` cannot replace the boundary logic: A17 measured
     * `running` spanning a live background lane (it goes `idle` only after the
     * background loop exits). Control-channel frames are not turn activity
     * either: a background lane's hook request, or the CLI's answer to an
     * adopter's `initialize`, must not mark the foreground busy.
     */
  } else {
    state.midTurn = true;
  }
  // BUG-072: stamp the turn's OWN start at the boundary that opened it (and
  // clear it when the turn closes), so a delivered turn renders an honest clock.
  if (state.midTurn !== midTurnBefore) state.midTurnSince = state.midTurn ? new Date().toISOString() : null;
  // BUG-187 H2: a dispatch or a started task is published at once, not at the
  // next boundary — a reader deciding a close must see it.
  if (state.midTurn !== midTurnBefore || laneLevelChanged || startedChanged || dispatchSeen) writeStatus({});
  return true;
}
const NON_TURN_TYPES = new Set(['control_request', 'control_response', 'control_cancel_request', 'keep_alive']);

/*
 * BUG-187 H6 — the CLI answered a client's `initialize`. Ownership of the
 * redelivered permission prompts moves to that client (H4), and when the
 * client's hooks were applied (or it sent none) the client has ADOPTED this
 * CLI: any drain an earlier server decided is cancelled, so an adopted broker
 * never EOFs its CLI on an old decision.
 */
function onInitializeAnswered(rid, response) {
  const req = initRequests.get(rid);
  initRequests.delete(rid);
  const success = response?.subtype === 'success';
  const pending = Array.isArray(response?.pending_permission_requests)
    ? response.pending_permission_requests.map((r) => r?.request_id).filter((x) => x != null)
    : null;
  floor.onInitResponse(rid, pending, success);
  if (!req) return;
  const hooksApplied = response?.response?.hooks_applied;
  const adopted = success && (hooksApplied === true || !req.carriedHooks);
  // The reply rides AFTER the forwarded initialize answer (see forwardStdoutLine).
  pendingReclaimReplies.push({ clientId: req.clientId, adopted, success, hooksApplied });
}
/**
 * BUG-187 round 5 — an initialize answer that lands AFTER the floor already
 * answered one of its redelivered prompts (the handover timed out and the
 * grace expired first) must not show that prompt to the adopter: its answer
 * would be dropped as a second one, so the person would be deciding nothing.
 * Returns the rewritten line, or null when nothing is settled (forward as is).
 */
function stripSettledRedelivery(m) {
  let removed = 0;
  const strip = (holder) => {
    if (!holder || !Array.isArray(holder.pending_permission_requests)) return;
    const kept = holder.pending_permission_requests.filter((r) => !(r?.request_id != null && floor.isSettled(r.request_id)));
    removed += holder.pending_permission_requests.length - kept.length;
    holder.pending_permission_requests = kept;
  };
  strip(m.response);
  strip(m.response?.response);
  if (!removed) return null;
  logHost(`initialize ${m.response?.request_id} answered after the floor had settled ${removed} of its redelivered prompt(s): not shown again`);
  return JSON.stringify(m);
}
const pendingReclaimReplies = [];
function flushReclaimReplies() {
  while (pendingReclaimReplies.length) {
    const r = pendingReclaimReplies.shift();
    const c = state.client;
    if (!c || state.clientId !== r.clientId) continue; // that client is gone; nothing to tell
    let reply;
    if (!r.success) reply = { ok: false, reason: 'initialize-failed' };
    else if (!r.adopted) reply = { ok: false, reason: 'hooks-not-applied' };
    else if (state.stdinEnded) reply = { ok: false, reason: 'stdin-ended' };
    else { reclaim(); reply = { ok: true }; }
    sendBroker(c, 'reclaim', reply);
  }
}
/*
 * BUG-187 — stdout is now forwarded LINE BY LINE (it was raw chunks), because
 * ownership is decided per line: a control_request is owned by the client it
 * was forwarded to, which is only well-defined when a line reaches exactly one
 * client or none. A StringDecoder keeps a multi-byte character split across
 * chunks intact. A single unterminated line past the cap (a very large
 * assistant/tool message, never a small control frame) is passed through raw,
 * unparsed, exactly as the old sniffer dropped it from parsing.
 */
const stdoutDecoder = new StringDecoder('utf8');
let stdoutPassthrough = false;
const LINE_CAP = 16_000_000;
function forwardStdout(text) {
  const c = state.client;
  if (c && !c.destroyed) { try { c.write(text); } catch { /* client went away */ } }
}
function sniffStdout(d) {
  let chunk = stdoutDecoder.write(d);
  if (stdoutPassthrough) {
    const nl = chunk.indexOf('\n');
    if (nl < 0) { forwardStdout(chunk); return; }
    forwardStdout(chunk.slice(0, nl + 1));
    chunk = chunk.slice(nl + 1);
    stdoutPassthrough = false;
  }
  lineBuf += chunk;
  let nl;
  while ((nl = lineBuf.indexOf('\n')) >= 0) {
    const line = lineBuf.slice(0, nl);
    lineBuf = lineBuf.slice(nl + 1);
    const out = onStreamJsonLine(line);
    if (out === true) forwardStdout(`${line}\n`);
    else if (typeof out === 'string') forwardStdout(`${out}\n`);
    if (pendingReclaimReplies.length) flushReclaimReplies();
  }
  if (lineBuf.length > LINE_CAP) { forwardStdout(lineBuf); lineBuf = ''; stdoutPassthrough = true; }
}

// ALWAYS drain stdout so the CLI never blocks on a full pipe even with no client
// connected. When a client is attached, forward the lines; otherwise drop them
// (the CLI writes its own transcript to disk, which is the durable record — the
// dropped bytes are only the live event stream nobody is watching). A control
// request dropped here is NOT lost any more: the floor tracks it (BUG-187).
child.stdout.on('data', (d) => { sniffStdout(d); });
child.stderr.on('data', (d) => { if (errStream) { try { errStream.write(d); } catch { /* ignore */ } } });

child.on('error', (err) => {
  writeStatus({ state: 'exited', exitCode: null, signal: null, error: String(err?.message ?? err) });
  shutdown(0);
});
child.on('exit', (code, signal) => {
  writeStatus({ state: 'exited', exitCode: code, signal, exitedAt: new Date().toISOString() });
  // Tell any connected client the transport ended, then tear down.
  if (state.client && !state.client.destroyed) { try { state.client.end(); } catch { /* ignore */ } }
  shutdown(0);
});

/*
 * ABANDON SAFETY NET. A handed-off broker whose server never comes back would
 * otherwise idle forever holding a CLI. So whenever no client is connected we
 * arm a grace timer; if it elapses we gracefully reap ourselves (stdin EOF lets
 * any in-flight turn DRAIN first, so nothing is lost). A legitimate restart's
 * re-adopt reaps within seconds — well inside the grace — and re-adopt reaps the
 * same graceful way, so this net changes no outcome, it only bounds leaks. It is
 * disarmed the moment a client connects (a live, server-driven session never
 * self-reaps).
 */
/*
 * BUG-114 — THE ORPHAN BOUND. Ownership, never age, never name.
 *
 * Observed on this machine: 25 brokers from verification runs of the previous
 * day still alive ~34 hours later, their harness long gone and some of their
 * data dirs deleted. The abandon net above did NOT bound them, and the real
 * records say exactly why: `state:"draining"`, `backgroundLifetime:"unknown"`,
 * `drainHeldSince` 34 hours earlier. The lifetime hold (BUG-043/BUG-044) is
 * correct and must stay — while the CLI declares background work, no one may
 * EOF it — but it is UNBOUNDED, so a fake/stuck lane holds a broker forever.
 *
 * The bound is ownership: a host created by an ISOLATED (verification) server
 * whose owner process is provably gone, with no client attached and none
 * arriving within a grace, can never be adopted by anyone again — its owner is
 * dead, its hosts dir may not even exist, and nothing will ever consume its
 * background work. Such a host stops holding and drains itself exactly the way
 * a boot-time re-adopt would have drained it.
 *
 * Deliberately NOT applied to a host owned by the SHARED (production) server:
 * there, an absent owner means "the service is restarting" and a successor
 * re-adopts — the user's real background agents keep their protection
 * unchanged. Owner liveness is pid + kernel start-ticks, so a reused pid cannot
 * impersonate a dead owner; an unrecorded owner (a pre-BUG-114 control file)
 * never forces anything.
 */
const owner = ctl.owner && typeof ctl.owner === 'object' ? ctl.owner : null;
const ORPHAN_GRACE_MS = Number(process.env.CLAUDE_STATION_HOST_ORPHAN_GRACE_MS ?? 120_000);
let ownerDeadSince = null;
function ownerAlive() {
  if (!owner || !Number.isInteger(owner.pid)) return true; // no owner recorded: never force
  try { process.kill(owner.pid, 0); } catch { return false; }
  if (owner.pidStart) {
    try {
      const stat = fs.readFileSync(`/proc/${owner.pid}/stat`, 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if ((after[19] ?? null) !== owner.pidStart) return false; // pid reused by something else
    } catch { return false; }
  }
  return true;
}
function orphaned() {
  if (!owner || owner.mode !== 'isolated') return false;
  if (state.client) { ownerDeadSince = null; return false; }
  if (ownerAlive()) { ownerDeadSince = null; return false; }
  if (ownerDeadSince == null) { ownerDeadSince = Date.now(); return false; }
  return Date.now() - ownerDeadSince >= ORPHAN_GRACE_MS;
}
/** The lifetime hold, bounded by ownership: an orphan holds for nobody. */
function backgroundHolds() {
  return backgroundOutlivesTurn() !== 'no' && !orphaned();
}

const ABANDON_MS = Number(process.env.CLAUDE_STATION_HOST_ABANDON_MS ?? 120_000);
let abandonTimer = null;
function armAbandon() {
  if (abandonTimer || state.exiting || state.reaping) return;
  abandonTimer = setTimeout(() => {
    abandonTimer = null;
    /*
     * BUG-043 (review finding 2): the net used to fire UNCONDITIONALLY, making
     * it a second independent killer of live background agents (server dies →
     * no client → 120s → gracefulReap → stdin EOF + SIGTERM escalation, while
     * the CLI's agents were still working). While the CLI itself reports live
     * background work, DECLINE and re-arm — the CLI is provably alive (it is
     * emitting frames this broker is sniffing) and its work is declared, so
     * this is not the leak the net exists to bound. The moment the level goes
     * empty the next expiry reaps as before; a CLI that dies instead is torn
     * down by the child-exit handler regardless. Bounded either way.
     */
    // BUG-044: consult the SAME lifetime answer the drain escalation consults
    // (yes OR unknown holds — one decision, two fuses; unknown is bounded).
    if (backgroundHolds() && !state.client) {
      if (!state.drainHeldSince) state.drainHeldSince = new Date().toISOString(); // FEAT-064: first held moment
      writeStatus({}); // heartbeat the status file so an observer sees the broker deciding, not wedged
      armAbandon();
      return;
    }
    gracefulReap();
  }, ABANDON_MS);
  abandonTimer.unref?.();
}
function disarmAbandon() {
  if (abandonTimer) { clearTimeout(abandonTimer); abandonTimer = null; }
}

/** One broker line to a client (never to the CLI): `orchard_broker_<kind>`. */
function sendBroker(conn, kind, payload) {
  if (!conn || conn.destroyed) return;
  try { conn.write(`${JSON.stringify({ type: `${BROKER_LINE_PREFIX}${kind}`, ...payload })}\n`); } catch { /* client gone */ }
}
const HOST_KEY = nodePath.basename(status).replace(/\.json$/, '');
let nextClientId = 0;

/*
 * BUG-187 H7 — a delivery, accepted only while the CLI still takes input. The
 * ack is positive evidence the frame was written; a refusal is retryable.
 */
function deliver(conn, msg) {
  const id = msg.delivery_id ?? null;
  if (state.stdinEnded || state.exiting) {
    sendBroker(conn, 'deliver_ack', { delivery_id: id, accepted: false, reason: 'the CLI is no longer accepting input (its stdin has been ended — the session is finishing)' });
    return;
  }
  const message = msg.message && typeof msg.message === 'object'
    ? msg.message
    : { role: 'user', content: [{ type: 'text', text: String(msg.text ?? '') }] };
  const ok = writeToCli({ type: 'user', message });
  sendBroker(conn, 'deliver_ack', ok ? { delivery_id: id, accepted: true } : { delivery_id: id, accepted: false, reason: 'the write to the CLI failed' });
}

/*
 * One line from the attached client. Line-buffered (H4): only complete lines
 * are forwarded, so a late control_response can be dropped whole even when the
 * client wrote it in fragments.
 */
function onClientLine(conn, clientId, line) {
  const s = line.trim();
  let m = null;
  if (s) { try { m = JSON.parse(s); } catch { m = null; } }
  if (m && typeof m === 'object' && typeof m.type === 'string') {
    if (m.type.startsWith(BROKER_LINE_PREFIX)) {
      const kind = m.type.slice(BROKER_LINE_PREFIX.length);
      if (kind === 'lifetime_q') {
        sendBroker(conn, 'lifetime_a', { id: m.id ?? null, lifetime: backgroundOutlivesTurn(), seq: state.seq, statusWriteFailedAt: state.statusWriteFailedAt, midTurn: state.midTurn });
      } else if (kind === 'deliver') {
        deliver(conn, m);
      }
      return; // H3: never forwarded to the CLI
    }
    if (m.type === 'control_response') {
      const rid = m.response?.request_id;
      if (rid != null && !floor.onClientResponse(rid, clientId)) return; // a second answer: dropped
    } else if (m.type === 'control_request' && m.request?.subtype === 'initialize' && m.request_id != null) {
      if (state.stdinEnded) {
        // H6: the CLI's input is closed, so this initialize can never be
        // answered — say so at once instead of leaving the client waiting.
        sendBroker(conn, 'reclaim', { ok: false, reason: 'stdin-ended' });
        return;
      }
      const hooks = m.request.hooks;
      const carriedHooks = !!hooks && typeof hooks === 'object' && Object.keys(hooks).length > 0;
      initRequests.set(String(m.request_id), { clientId, carriedHooks });
      floor.onClientInitialize(clientId, String(m.request_id));
    } else if (m.type === 'user' && state.stdinEnded) {
      // H7: a raw user frame after EOF would be lost silently — say so instead.
      sendBroker(conn, 'deliver_ack', { delivery_id: null, accepted: false, reason: 'the CLI is no longer accepting input' });
      return;
    }
  }
  if (state.stdinEnded) return;
  try { child.stdin.write(`${line}\n`); } catch { /* CLI gone */ }
}

const server = net.createServer((conn) => {
  // Single client at a time. A second connection (e.g. two tabs) is refused so
  // two servers can never both drive the same CLI. BUG-187 H3: the loser is
  // TOLD (`hello accepted:false`) before it is dropped, so a losing adopter can
  // tell "someone else holds it" from "the broker died" and never reaps.
  if (state.client && !state.client.destroyed) {
    try { conn.end(`${JSON.stringify({ type: `${BROKER_LINE_PREFIX}hello`, accepted: false, hostKey: HOST_KEY, protocol: BROKER_PROTOCOL, reason: 'another client is attached' })}\n`); } catch { /* ignore */ }
    setTimeout(() => { try { conn.destroy(); } catch { /* ignore */ } }, 200).unref?.();
    return;
  }
  disarmAbandon();
  const clientId = ++nextClientId;
  state.client = conn;
  state.clientId = clientId;
  state.responderLostAt = null;
  // BUG-187 round 6: `holdsOwnedCards` — this broker never ends its CLI's input
  // under a card an attached client owns (commitDrain), so a relay can let a
  // person decide as long as they like instead of bounding the card itself.
  sendBroker(conn, 'hello', { accepted: true, hostKey: HOST_KEY, protocol: BROKER_PROTOCOL, clientId, holdsOwnedCards: true });
  writeStatus({});
  const decoder = new StringDecoder('utf8');
  let inBuf = '';
  conn.on('data', (d) => {
    inBuf += decoder.write(d);
    let nl;
    while ((nl = inBuf.indexOf('\n')) >= 0) {
      const line = inBuf.slice(0, nl);
      inBuf = inBuf.slice(nl + 1);
      onClientLine(conn, clientId, line);
    }
  });
  const drop = () => {
    if (state.client !== conn) return;
    state.client = null;
    state.clientId = null;
    state.responderLostAt = new Date().toISOString();
    floor.onClientDetached(clientId); // everything it owned starts its grace clock now
    writeStatus({});
    armAbandon();
  };
  // A client disconnect is SURVIVABLE: keep the CLI alive and its stdin OPEN.
  // Never forward the socket's end/close as stdin EOF — a dead server must not
  // end the turn. Only an explicit SIGTERM, or the abandon net, does that.
  conn.on('close', drop);
  conn.on('error', drop);
});
server.on('error', (err) => fail(`unix socket ${sock} failed: ${err.message}`));

try { fs.rmSync(sock, { force: true }); } catch { /* ignore */ }
server.listen(sock, () => { try { fs.chmodSync(sock, 0o600); } catch { /* ignore */ } });
// Arm the net immediately: if a server never connects (it died before it could),
// the broker must not idle forever.
armAbandon();

/*
 * BUG-187 H8 — the TOMBSTONE. shutdown() deletes the status record, so a reader
 * polling between two writes could miss the whole stopping interval and never
 * learn why the session ended. Written first, consumed by the server's survival
 * scan into the FEAT-057 outcome store, then deleted by that consumer. Carries
 * no top-level `hostPid`/`stationSessionId`, so a reader of `*.json` host
 * records can never mistake it for a live broker.
 */
function writeTombstone() {
  const snap = floor ? floor.snapshot() : { refusals: 0, lanes: [] };
  const st = state.status ?? {};
  const stopped = snap.lanes.filter((l) => l.stopRequestedAt);
  // Only a NON-ROUTINE end leaves a tombstone: a refusal or a stopped lane is
  // something the user must be told. A clean drain/close leaves the hosts dir
  // exactly as empty as before (BUG-023: an open→close cycle leaves nothing).
  if (!snap.refusals && !stopped.length) return;
  let reason;
  if (stopped.length) reason = `${stopped.length} background lane(s) were stopped because Orchard was not attached to answer their tool calls`;
  else if (snap.refusals > 0) reason = `${snap.refusals} tool call(s) were refused because Orchard was not attached`;
  else if (state.stdinEnded) reason = 'the session was drained and closed';
  else reason = 'the CLI exited';
  const tomb = {
    tombstone: 1,
    hostKey: HOST_KEY,
    owner: owner ?? null,
    session: { stationSessionId: st.stationSessionId ?? null, sdkSessionId: st.sdkSessionId ?? null, resumeHint: st.resumeHint ?? null },
    brokerPid: process.pid,
    cliPid: st.claudePid ?? null,
    reason,
    exitCode: st.exitCode ?? null,
    signal: st.signal ?? null,
    refusals: snap.refusals,
    lanes: snap.lanes,
    endedAt: new Date().toISOString(),
  };
  const p = status.replace(/\.json$/, '.ended.json');
  try { fs.writeFileSync(`${p}.tmp-${process.pid}`, JSON.stringify(tomb), { mode: 0o600 }); fs.renameSync(`${p}.tmp-${process.pid}`, p); } catch { /* best effort */ }
}

function shutdown(code) {
  if (state.exiting) return;
  state.exiting = true;
  clearInterval(floorTicker);
  clearInterval(heartbeat);
  writeTombstone();
  try { server.close(); } catch { /* ignore */ }
  try { fs.rmSync(sock, { force: true }); } catch { /* ignore */ }
  if (errStream) { try { errStream.end(); } catch { /* ignore */ } }
  // BUG-023: this host is now genuinely, permanently done — it will never be a
  // re-adopt candidate again (a dead pid is never "surviving"). Remove its own
  // status/err/control files so a normal open->close cycle leaves nothing behind
  // in hostsDir(), instead of relying on a future scanSurvivingHosts() sweep
  // (boot re-adopt or a client's resumeHint match) that may never come. This is
  // always safe here: shutdown() only runs as this process is exiting, so a
  // still-ALIVE surviving host's files are never touched by this path — only our
  // own, and only once we are certain we are on the way out.
  try { fs.rmSync(status, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(errlog, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(controlPath, { force: true }); } catch { /* ignore */ }
  // Give the status write a tick to land, then exit.
  setTimeout(() => process.exit(code), 50).unref?.();
}

/**
 * BUG-044 — the drain path's lifetime answer (ARCH-002 option 1, the broker's
 * local mirror of agent-bridge's `workLifetime()`; unknown is NEVER coerced):
 *   'yes'     — the CLI's own level says background work is alive right now;
 *   'unknown' — a background dispatch was observed and no level frame has
 *               reported since (the empty level is not authoritative yet),
 *               bounded by a window so a refused dispatch cannot hold forever;
 *   'no'      — the level is authoritatively empty (or was never implicated).
 */
const BG_UNKNOWN_MS = Number(process.env.CLAUDE_STATION_HOST_BG_UNKNOWN_MS ?? 120_000);
// BUG-074: how long a non-empty level may go with NO corroborating frame before
// its 'yes' is downgraded to 'unknown' (bounded trust — ARCH-002). Generous by
// default so a genuinely-live-but-quiet agent (one mid-API-call, or a background
// bash that is simply sleeping) never trips it — it keeps emitting SOME frame
// well within the window. The downgrade only relabels; it NEVER forces an EOF
// (unknown still HOLDS the drain), so live work is never truncated (BUG-044).
const BG_STALE_MS = Number(process.env.CLAUDE_STATION_HOST_BG_STALE_MS ?? 300_000);
function backgroundOutlivesTurn() {
  // BUG-187 H2: a started (e.g. revived) lane the level does not list is live.
  if (state.startedTasks.size > 0) return 'yes';
  if (state.backgroundLive) {
    if (state.lastBackgroundActivityAt != null && Date.now() - state.lastBackgroundActivityAt > BG_STALE_MS) return 'unknown';
    return 'yes';
  }
  if (state.bgDispatchAt != null && Date.now() - state.bgDispatchAt < BG_UNKNOWN_MS) return 'unknown';
  return 'no';
}

/**
 * Graceful reap: let the CURRENT turn drain to completion, then end the CLI's
 * stdin (EOF) so it exits, then exit when the CLI does.
 *
 * CRITICAL (BUG-022): stdin-EOF does NOT wait for a pending tool call — the CLI
 * takes it as "no more input" and exits at the next opportunity, so EOF WHILE a
 * turn is in-flight truncates it (later tool steps + final reply silently lost).
 * So if a turn is in-flight we hold EOF until its `result` lands (observed on
 * stdout above); if idle we EOF immediately. A backstop forces EOF after a
 * generous window, then SIGTERM/SIGKILL escalate, so a stuck CLI can never wedge
 * the host forever.
 *
 * BUG-044: the drain COMMIT is LIFETIME-AWARE. The old path EOF'd stdin the
 * moment the turn ended and fired an UNCONDITIONAL SIGTERM at 150s — and the
 * boot-time re-adopt (`adoptSurvivingHosts` → reapHost → SIGTERM → here) killed
 * live background agents through it (BUG-044's pre-fix run measured the CLI
 * exiting ~4s after an idle-EOF WITH a live background task — so the EOF
 * itself, not only the SIGTERM, destroys the work; BUG-043's arm C had only
 * ever observed the mid-hold window, not a completion). So once the foreground
 * turn has drained (its `result` landed, or the CLI was idle, or the 90s
 * backstop gave up waiting), the drain CONSULTS the declared lifetime before
 * committing: while background work is live (or the lifetime is unknown —
 * never coerced) it HOLDS — no EOF, no escalation — and re-checks on a short
 * cadence, exactly the abandon net's posture. Bounded by the dead-process
 * probe (the child 'exit' handler tears everything down the moment the CLI
 * dies) and by the unknown window; the moment the level is authoritatively
 * empty, the drain commits: stdin EOF, then today's SIGTERM/SIGKILL schedule.
 * A CLI that never reported background work commits immediately — the
 * pre-fix behaviour, escalation timing included.
 */
const DRAIN_TERM_MS = Number(process.env.CLAUDE_STATION_HOST_DRAIN_TERM_MS ?? 150_000);
const DRAIN_KILL_LAG_MS = Number(process.env.CLAUDE_STATION_HOST_DRAIN_KILL_LAG_MS ?? 10_000);
const DRAIN_RECHECK_MS = Number(process.env.CLAUDE_STATION_HOST_DRAIN_RECHECK_MS ?? 15_000);
let drainRequested = false;
/*
 * BUG-187 H6 — every drain timer keeps its handle, so an adoption can cancel a
 * drain an earlier server decided (reclaim). Before this they were anonymous
 * `setTimeout`s: once armed, nothing could stop them.
 */
const drainTimers = new Set();
function drainLater(fn, ms) {
  const t = setTimeout(() => { drainTimers.delete(t); fn(); }, ms);
  t.unref?.();
  drainTimers.add(t);
  return t;
}
/**
 * Reclaim: an adopting client's initialize succeeded with its hooks applied
 * and stdin is still open — this CLI is driven again. Cancel the drain.
 */
function reclaim() {
  const wasDraining = state.reaping || state.reapPending || drainRequested;
  for (const t of drainTimers) clearTimeout(t);
  drainTimers.clear();
  state.reaping = false;
  state.reapPending = false;
  drainRequested = false;
  state.midTurnCommitWaitSince = null;
  state.drainHeldSince = null;
  state.adoptedAt = new Date().toISOString();
  floor.onAdopted();
  if (wasDraining) logHost('reclaimed by an adopting client: the pending drain was cancelled');
  writeStatus({ state: 'running' });
}
function requestDrainCommit() {
  if (drainRequested) return;
  drainRequested = true;
  commitDrain();
}
const DRAIN_MIDTURN_MS = Number(process.env.CLAUDE_STATION_HOST_DRAIN_MIDTURN_MS ?? 90_000);
function commitDrain() {
  if (state.exiting) return;
  if (backgroundHolds()) {
    // Live (or unknown-lifetime) background work: declining to commit is the
    // fix. Heartbeat the status file so an observer sees the broker deciding,
    // not wedged, then re-check on the short cadence.
    if (!state.drainHeldSince) state.drainHeldSince = new Date().toISOString(); // FEAT-064
    writeStatus({});
    drainLater(commitDrain, DRAIN_RECHECK_MS);
    return;
  }
  /*
   * FEAT-064 (latent bug found by BUG-048's explore, BUG-022 §3 class): the
   * commit used to re-check ONLY background lifetime — so a turn that went
   * in-flight DURING the hold (e.g. a late/injected turn) was truncated the
   * moment the level emptied: stdin-EOF mid-turn loses the turn's later steps
   * and final reply. Gate the commit on `midTurn` too: while a turn is open,
   * decline and re-check, exactly like the background hold. BOUNDED by its own
   * window (same posture as gracefulReap's 90s result backstop) so a turn
   * whose `result` never lands cannot wedge the drain forever — after the
   * window the EOF + escalation bound a stuck CLI as before. The turn's
   * `result` clears both `midTurn` and the window stamp.
   */
  /*
   * BUG-187 round 6 — an attached client OWNS a pending request: a person may
   * be deciding its card (FEAT-065's relay delivers into exactly this draining
   * broker). Ending stdin now would make their answer undeliverable — the
   * midTurn window below is a bound for a turn whose `result` never lands, not
   * for a person's decision. Hold, and restart that window, so the turn gets
   * its full bound AFTER the answer. Bounded by the responder: if it drops, the
   * floor makes the card unowned and refuses it at grace, and this clears.
   */
  if (floor.hasOwned()) {
    state.midTurnCommitWaitSince = null;
    if (!state.drainHeldSince) state.drainHeldSince = new Date().toISOString(); // FEAT-064
    writeStatus({});
    drainLater(commitDrain, DRAIN_RECHECK_MS);
    return;
  }
  if (state.midTurn) {
    if (state.midTurnCommitWaitSince == null) state.midTurnCommitWaitSince = Date.now();
    if (Date.now() - state.midTurnCommitWaitSince < DRAIN_MIDTURN_MS) {
      if (!state.drainHeldSince) state.drainHeldSince = new Date().toISOString(); // FEAT-064
      writeStatus({});
      drainLater(commitDrain, DRAIN_RECHECK_MS);
      return;
    }
    // Window expired: same bounded-truncation posture the reap backstop
    // already accepts for a result-less turn — commit rather than wedge.
  }
  endStdin();
  armDrainEscalation(DRAIN_TERM_MS);
}
function armDrainEscalation(delayMs) {
  drainLater(() => {
    if (state.exiting) return;
    // Defense in depth: re-consult at fire time (a level frame may have named
    // new work inside the escalation window) — decline and re-arm if so.
    if (backgroundHolds()) {
      if (!state.drainHeldSince) state.drainHeldSince = new Date().toISOString(); // FEAT-064
      writeStatus({});
      armDrainEscalation(DRAIN_RECHECK_MS);
      return;
    }
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, DRAIN_KILL_LAG_MS).unref?.();
  }, delayMs);
}
// The reap's wait for an in-flight turn's `result` (was a literal 90 s; a knob so a test can shrink it).
const REAP_RESULT_WAIT_MS = Number(process.env.CLAUDE_STATION_HOST_REAP_RESULT_WAIT_MS ?? 90_000);
function gracefulReap() {
  if (state.reaping) return;
  state.reaping = true;
  disarmAbandon();
  writeStatus({ state: 'draining' });
  if (state.midTurn) {
    // Wait for the in-flight turn's `result` (onStreamJsonLine commits on it).
    state.reapPending = true;
  } else {
    requestDrainCommit();
  }
  // The child 'exit' handler drives the real teardown. If the turn's `result`
  // never lands, stop waiting after a generous window and move to the (still
  // lifetime-gated) drain commit, whose EOF + escalation bound a stuck CLI.
  drainLater(() => {
    if (state.reapPending) { state.reapPending = false; requestDrainCommit(); }
  }, REAP_RESULT_WAIT_MS);
}
process.on('SIGTERM', gracefulReap);
process.on('SIGINT', gracefulReap);
