/**
 * ARCH-001 — THE SINGLE AUTHORITY on "is this thing alive / mid-turn right now".
 *
 * WHY THIS FILE EXISTS. Eight tickets (BUG-004/017/020/027/030/033/034/038) are
 * one defect wearing different clothes: a surface asserted running / not-running
 * from a partial signal it computed next to itself. BUG-033 fixed the bridge
 * site; the IDENTICAL mistake survived at the survivor site and had to be
 * rediscovered by BUG-038 days later; at the time this module was written a
 * THIRD site (`scanSurvivingHosts`, and therefore `/api/health` and `doctor`)
 * was still making it — presenting a corpse as "SURVIVED a restart … turn
 * draining". The sites agreed only by construction, never by enforcement.
 *
 * The rule this module exists to make enforceable:
 *   **Every server-side decision that depends on "is X alive / mid-turn" calls
 *   THIS module. Nothing re-derives it locally.**
 * `scripts/verify-liveness-conformance.mjs` is the enforcement — including a
 * mechanical guard that fails when a new ad-hoc check appears anywhere else.
 *
 * THE THREE ANSWERS, deliberately separate (conflating them IS the class):
 *   `state`   GROUND TRUTH about the process behind the claim:
 *             'alive' | 'dead' | 'unknown'. `unknown` is a FIRST-CLASS answer
 *             and is never coerced — reading it as "dead" reaps live turns
 *             (BUG-033's false-positive risk), reading it as "alive" is the
 *             zombie (BUG-033's actual bug).
 *   `running` THE CLAIM: is a turn in flight right now?
 *   `live`    THE DECISION: may this claim keep standing? This is what callers
 *             act on, and it is NOT `state === 'alive'`: an `unknown` inside
 *             the frameless window stays standing (never reap on silence
 *             alone), an `unknown` past it does not (but is refused, not
 *             resumed — silence is evidence, not proof; BUG-022).
 *
 * ORDERING (unchanged from BUG-033, which is what makes it safe): ground truth
 * first, timer last. dead process → dead now, no window. alive process → LIVE
 * regardless of how silent it is. Only where no ground truth exists at all does
 * the frameless backstop get a vote.
 *
 * NOT IN THIS MODULE: any transport, any process spawning, any reaping. This
 * file only ANSWERS; the callers decide what to do about the answer.
 */
import * as fs from 'node:fs';
import type { HostStatus } from './survival.ts';

/* -------------------------------------------------------------- the answer */

export type LivenessState = 'alive' | 'dead' | 'unknown';

/**
 * The narrow ground-truth rung: what a probe alone proved, with the plain-words
 * evidence for it. This is what a session hands the authority when it is asked
 * to judge itself, and what /api/health publishes as `processAlive`.
 */
export interface LivenessProbe {
  state: LivenessState;
  detail: string;
}

export type LivenessKind =
  /** a turn is running and the evidence backs it */
  | 'ok'
  /** the session is alive but no turn is in flight */
  | 'idle'
  /** the bridge/session was closed */
  | 'closed'
  /** PROVEN dead: a pid is gone, or the broker recorded the exit */
  | 'dead-process'
  /** no ground truth available AND silent past the backstop window */
  | 'frameless'
  /** no ground truth available and nothing else to go on */
  | 'unknown';

/**
 * What was actually CHECKED. Every field is an observation, never an inference;
 * it is safe to show a user and it is what makes a refusal quotable
 * ("broker pid N and CLI pid M are alive") rather than an assertion.
 */
export interface LivenessEvidence {
  source: 'bridge' | 'survivor-host' | 'survival-handle' | 'transcript-mtime';
  /** The ground-truth rung's own answer, before any policy was applied. */
  probe: LivenessState;
  probeDetail: string;
  brokerPid?: number | null;
  cliPid?: number | null;
  brokerState?: HostStatus['state'] | null;
  lastFrameAt?: number | null;
  silentMs?: number | null;
  framelessMs?: number | null;
  lastWriteMs?: number | null;
  ageMs?: number | null;
  windowMs?: number | null;
}

/**
 * FEAT-057 hook — "what ended and why", carried by the SAME structure that
 * answers "what is running", because building them separately is what created
 * the split-brain in the first place. Populated ONLY from evidence the probe
 * actually has (today: a broker that recorded its CLI's exit); `kind:'unknown'`
 * is the honest default and must never be upgraded to 'completed' by guessing
 * (§C). FEAT-057 will fill the richer kinds + `providerError` from the frames
 * the server already receives; nothing here fabricates them.
 */
export interface LivenessEnd {
  at: number | null;
  kind: 'completed' | 'failed' | 'killed' | 'cut' | 'provider-error' | 'unknown';
  detail: string;
  /**
   * FEAT-057 — BUG-031's provider-agnostic error, carried verbatim when the
   * engine ITSELF reported one for the turn that ended. Never inferred from a
   * bare exit: a process that died after a quota wall and a process that died
   * for any other reason look identical to a pid check, so this field is
   * present only when the runtime classified a real frame.
   */
  providerError?: EndProviderError;
}

/**
 * The shape of BUG-031's `ProviderError` this module needs. Declared
 * structurally rather than imported so the authority keeps its zero runtime
 * dependencies (the same reason `BridgeLike` is declared here).
 */
export interface EndProviderError {
  kind: string;
  provider: string;
  detail: string;
  retryable?: boolean;
  resetsAt?: number | null;
}

export interface Liveness {
  /** GROUND TRUTH — never coerced. See the header. */
  state: LivenessState;
  /** THE CLAIM — is a turn in flight right now? */
  running: boolean;
  /** THE DECISION — may this claim keep standing? (what callers act on) */
  live: boolean;
  kind: LivenessKind;
  /** Plain words, safe to show a user; ends up in refusals and reaper events. */
  reason: string;
  evidence: LivenessEvidence;
  /** When the thing being judged started (turn start / broker start / last write). */
  since: number | null;
  /** Present only when the authority has EVIDENCE that it ended. FEAT-057. */
  ended?: LivenessEnd;
}

/* ------------------------------------------------------- configured windows
 *
 * The windows live here, with the module that uses them, so there is one place
 * to look and one place to change. Env var names are unchanged (they are
 * documented in BUG-033 and used by the verification harness).
 */

/**
 * How long a BUSY session may emit NOTHING before its claim stops standing —
 * but ONLY where the process probe cannot answer at all. A session with a
 * verified-alive CLI is never reaped by this timer, however quiet.
 *
 * WHY 10 MINUTES. A running turn is chatty by construction (token deltas,
 * tool-call / tool_progress / tool_result, subagent frames); the only
 * legitimately silent stretch is the inside of ONE long tool call on an engine
 * that emits no progress — a test suite, a build, a sleep. 10 minutes is
 * comfortably past that class while being nothing like "the rest of the
 * server's life", which is what the window used to be. Erring long is
 * deliberate: reaping a live turn is strictly worse than a few stale minutes.
 * `<= 0` disables the timer half, leaving the ground-truth half armed.
 */
export const FRAMELESS_MS = Number(process.env.CLAUDE_STATION_FRAMELESS_MS ?? 600_000);
/** How often the reaper sweeps. Cheap: a /proc stat + a small JSON read per busy session. */
export const REAP_SWEEP_MS = Number(process.env.CLAUDE_STATION_REAP_SWEEP_MS ?? 10_000);
/**
 * Recency window for "this transcript is being written right now".
 *
 * CHOSEN: mtime recency. REJECTED: scanning /proc/<pid>/fd for open handles —
 * it costs a readlink over every fd of every process per poll, needs the same
 * uid or it silently under-reports, and is exactly the "matches your own
 * process" check that produced false positives repeatedly here (the dashboard
 * itself holds these files open while serving transcripts). mtime moves only
 * when something appends.
 */
export const LIVE_WINDOW_MS = 30_000;

/** One line naming every configured window, for the boot log — so no caller has to name them. */
export function livenessWindowsSummary(): string {
  return `frameless window ${FRAMELESS_MS}ms, reap sweep ${REAP_SWEEP_MS}ms, transcript window ${LIVE_WINDOW_MS}ms`;
}

/* ------------------------------------------------------- the ground-truth rungs */

/**
 * THE ONE pid-liveness check in this codebase. pid <= 1 is never a session's
 * process (0 = the whole process group, 1 = init) and signalling it would be
 * both wrong and dangerous, so it is refused rather than probed.
 */
export function pidAlive(pid: number | null | undefined): boolean {
  if (!Number.isInteger(pid as number) || (pid as number) <= 1) return false;
  try { process.kill(pid as number, 0); return true; } catch { return false; }
}

/**
 * Rung set A — a broker's own status record (the FEAT-015 `HostStatus`), read
 * either cold off disk (a survivor no in-memory session is tracking) or live
 * through a `SurvivalHandle`. In rung order:
 *   1. the broker's OWN recorded verdict (`state: 'exited'`) — it watched the
 *      CLI exit and wrote that down; nothing outranks the eyewitness.
 *   2. the broker process itself.
 *   3. the CLI pid the broker recorded.
 * A record that survives all three is alive AND mid-turn: the broker only
 * exists for the lifetime of the CLI turn it is minding.
 *
 * NOTE `'unknown'` is not reachable here, and that is a property of the input,
 * not a coercion: a `HostStatus` always carries a checkable `hostPid`.
 */
function fromHostStatus(st: HostStatus, source: LivenessEvidence['source']): Liveness {
  const since = st.startedAt ? Date.parse(st.startedAt) : null;
  const base = {
    source,
    brokerPid: st.hostPid,
    cliPid: st.claudePid ?? null,
    brokerState: st.state,
  } as const;

  if (st.state === 'exited') {
    const detail = `the broker reports the CLI exited (code ${st.exitCode ?? 'null'}${st.signal ? `, signal ${st.signal}` : ''})`;
    return {
      state: 'dead', running: false, live: false, kind: 'dead-process', reason: detail,
      evidence: { ...base, probe: 'dead', probeDetail: detail },
      since: Number.isFinite(since as number) ? since : null,
      // The only end the authority can evidence today. `kind` stays 'unknown'
      // on purpose: an exit code says the PROCESS ended, not that the TURN
      // completed. FEAT-057 refines this from the frames, never by guessing.
      ended: {
        at: st.updatedAt ? Date.parse(st.updatedAt) : null,
        kind: 'unknown',
        detail,
      },
    };
  }
  if (!pidAlive(st.hostPid)) {
    const detail = `the session-host broker (pid ${st.hostPid}) is gone`;
    return {
      state: 'dead', running: false, live: false, kind: 'dead-process', reason: detail,
      evidence: { ...base, probe: 'dead', probeDetail: detail },
      since: Number.isFinite(since as number) ? since : null,
      ended: { at: null, kind: 'unknown', detail },
    };
  }
  if (st.claudePid != null && !pidAlive(st.claudePid)) {
    const detail = `the agent CLI (pid ${st.claudePid}) is gone`;
    return {
      state: 'dead', running: false, live: false, kind: 'dead-process', reason: detail,
      evidence: { ...base, probe: 'dead', probeDetail: detail },
      since: Number.isFinite(since as number) ? since : null,
      ended: { at: null, kind: 'unknown', detail },
    };
  }
  const detail = `broker pid ${st.hostPid} and CLI pid ${st.claudePid ?? 'unknown'} are alive (broker state ${st.state})`;
  return {
    state: 'alive', running: true, live: true, kind: 'ok', reason: detail,
    evidence: { ...base, probe: 'alive', probeDetail: detail },
    since: Number.isFinite(since as number) ? since : null,
  };
}

/* ------------------------------------------------------------ the targets */

/**
 * The structural shape the authority needs from an `AgentSession`. Declared
 * here (not imported) so this module has NO runtime dependency on
 * agent-bridge.ts — the dependency runs one way, which is what keeps the
 * authority callable from anywhere.
 */
export interface BridgeLike {
  closed: boolean;
  busy: boolean;
  lastFrameAt: number | null;
  turnStartedAt: number | null;
  /** The session's own ground-truth rung (a survival handle, or an honest 'unknown'). */
  processProbe(): { state: LivenessState; detail: string };
  /**
   * FEAT-057 — the LAST provider/API error the runtime classified for the turn
   * currently in flight, or null. EVIDENCE the server actually received (a
   * frame the runtime classified), not an inference. It fills the `ended` slot
   * with a real cause where one exists: "the CLI is gone" is true but useless
   * to a user whose account hit a usage limit; "quota-window, resets 13:40" is
   * the same death with the reason attached. Absent/undefined on any caller
   * that does not track it — the fallback is `kind:'unknown'`, never a guess.
   */
  lastProviderError?: EndProviderError | null;
}

export interface SurvivalHandleInput {
  /** The transport already settled an exit — the socket closed / the SDK tore it down. */
  exitLatched: boolean;
  /** Have we EVER connected to this broker? Decides what an absent status file means. */
  everConnected: boolean;
  /** The broker's status record, or null if the file is not there. */
  status: HostStatus | null;
}

export type LivenessTarget =
  | { kind: 'bridge'; session: BridgeLike }
  | { kind: 'survivor'; status: HostStatus }
  | ({ kind: 'survival-handle' } & SurvivalHandleInput)
  | { kind: 'transcript'; lastWriteMs: number | null; windowMs?: number };

/* ------------------------------------------------------------- the entry point */

/** THE authority. Every server-side "is it alive / mid-turn" answer comes from here. */
export function liveness(target: LivenessTarget, now = Date.now()): Liveness {
  switch (target.kind) {
    case 'survivor': return fromHostStatus(target.status, 'survivor-host');
    case 'survival-handle': return livenessOfSurvivalHandle(target);
    case 'bridge': return livenessOfBridge(target.session, now);
    case 'transcript': return transcriptLiveness(target, now);
  }
}

/**
 * A survivor discovered COLD, on disk — no in-memory session is tracking it.
 * Used by the resume/send guard (BUG-022/BUG-038) and by /api/health.
 */
export function livenessOfSurvivor(status: HostStatus): Liveness {
  return fromHostStatus(status, 'survivor-host');
}

/* ------------------------------------------- BUG-072: what a survivor is DOING */

/**
 * One piece of work a still-held survivor's own CLI declared it is running: a
 * background lane from the engine's `background_tasks_changed` LEVEL frames,
 * which the broker sniffs and republishes on every heartbeat (FEAT-064/BUG-072).
 */
export interface SurvivorLane {
  id: string;
  /** The engine's own `task_type` (`local_bash`, `local_agent`, …) or `'background'` when an older broker published ids only. */
  label: string;
  /** Task-agent lanes render as agents, single tool lanes as tools (same taxonomy the bridge uses). */
  row: 'agent' | 'tool';
  /** When THIS broker first saw the lane in a level frame; null = an older broker that published ids only → the client renders "—", never a fake stopwatch (BUG-033). */
  startedAt: number | null;
}

/**
 * BUG-072 — THE WORK A SURVIVING-UNADOPTED SESSION IS DOING RIGHT NOW.
 *
 * Why this lives in the authority and not next to a route: a survivor that is
 * running a FEAT-065-delivered turn is genuinely mid-turn, and every surface
 * (running snapshot, /api/sessions/live, /api/health, the strip) must get that
 * answer from one place or the ARCH-001 class regrows at a fifth site. There is
 * no new rung here: process liveness is still `livenessOfSurvivor`, and the
 * turn/lane facts are the BROKER'S OWN DECLARATIONS (`midTurn`, `midTurnSince`,
 * `backgroundTasks`/`backgroundTaskIds` — stamped by the broker at the CLI's
 * turn boundaries and level frames), plus, when this server injected the turn
 * itself, the delivery relay's first-hand evidence.
 *
 * `turnRunning` is deliberately three-valued via `null`: a broker too old to
 * publish `midTurn` has NOT said the survivor is idle — it has said nothing —
 * and coercing that to `false` is exactly the "no surface may claim nothing is
 * running" failure this ticket exists to close (ARCH-002: unknown is never
 * coerced).
 */
export interface SurvivorWork {
  /** true = a foreground turn is in flight; false = provably idle; null = the broker never declared (older broker). */
  turnRunning: boolean | null;
  /** Honest start of that turn, or null when not knowable. */
  turnSince: number | null;
  /** Declared background lanes still live in the survivor. */
  lanes: SurvivorLane[];
  /** Plain-words evidence for `turnRunning`, quotable in a payload. */
  reason: string;
}

/**
 * First-hand evidence from a FEAT-065 delivery relay this server owns: it wrote
 * one user frame into the survivor's stdin and has not yet seen that turn's
 * `result` on the relayed stdout. Stronger and fresher than the heartbeat
 * (which is at most one turn-boundary write behind), and it is the ONLY reason
 * the strip can be right in the same tick as the delivery ack.
 */
export interface DeliveryEvidence {
  /** The relay is attached and the injected turn has not reported `result`. */
  turnLive: boolean;
  /** When the frame was written into the survivor's stdin. */
  since: number | null;
}

export function survivorWork(st: HostStatus, delivery: DeliveryEvidence | null = null): SurvivorWork {
  const v = livenessOfSurvivor(st);
  if (v.state !== 'alive') {
    return { turnRunning: false, turnSince: null, lanes: [], reason: v.reason };
  }
  const lanes: SurvivorLane[] = [];
  if (Array.isArray(st.backgroundTasks) && st.backgroundTasks.length) {
    for (const t of st.backgroundTasks) {
      if (!t || typeof t.id !== 'string' || !t.id) continue;
      const type = typeof t.type === 'string' && t.type ? t.type : 'background';
      const since = t.since ? Date.parse(t.since) : NaN;
      lanes.push({
        id: t.id,
        label: type,
        row: type === 'local_bash' ? 'tool' : 'agent',
        startedAt: Number.isFinite(since) ? since : null,
      });
    }
  } else if (Array.isArray(st.backgroundTaskIds)) {
    // An older broker published ids only: the lane is real, its type and start are simply not knowable.
    for (const id of st.backgroundTaskIds) {
      if (typeof id === 'string' && id) lanes.push({ id, label: 'background', row: 'agent', startedAt: null });
    }
  }
  if (delivery?.turnLive) {
    return {
      turnRunning: true,
      turnSince: delivery.since ?? (st.midTurnSince ? Date.parse(st.midTurnSince) : null),
      lanes,
      reason: `this server delivered a message into the surviving CLI (broker pid ${st.hostPid}, CLI pid ${st.claudePid ?? 'unknown'}) and that turn has not reported its result yet`,
    };
  }
  if (st.midTurn === true) {
    const since = st.midTurnSince ? Date.parse(st.midTurnSince) : NaN;
    return {
      turnRunning: true,
      turnSince: Number.isFinite(since) ? since : null,
      lanes,
      reason: `the surviving CLI (pid ${st.claudePid ?? 'unknown'}) declared a turn in flight in its broker heartbeat`,
    };
  }
  if (st.midTurn === false) {
    return {
      turnRunning: false,
      turnSince: null,
      lanes,
      reason: lanes.length
        ? `the surviving CLI is foreground-idle; ${lanes.length} declared background lane${lanes.length === 1 ? '' : 's'} still running`
        : 'the surviving CLI is foreground-idle',
    };
  }
  return {
    turnRunning: null,
    turnSince: null,
    lanes,
    reason: 'this broker does not publish turn boundaries (older session-host) — whether a turn is in flight is unknown, not idle',
  };
}

/**
 * A survival transport's own view, which has two rungs the cold read cannot:
 *  1. the exit latch — the facade already settled an exit; the CLI is gone.
 *  2. an ABSENT status file. The broker writes one before anything else and
 *     DELETES it as it exits (session-host.mjs shutdown(), BUG-023). Absence
 *     AFTER we ever connected is therefore proof the broker exited; absence
 *     BEFORE is 'unknown' — it simply has not come up yet, and calling that
 *     "dead" would kill sessions during their own startup.
 * Then the shared `HostStatus` rungs.
 */
export function livenessOfSurvivalHandle(input: SurvivalHandleInput): Liveness {
  if (input.exitLatched) {
    const detail = 'the survival transport has ended — the broker socket closed and the CLI exited';
    return {
      state: 'dead', running: false, live: false, kind: 'dead-process', reason: detail,
      evidence: { source: 'survival-handle', probe: 'dead', probeDetail: detail },
      since: null,
      ended: { at: null, kind: 'unknown', detail },
    };
  }
  if (!input.status) {
    if (input.everConnected) {
      const detail = 'the session-host broker removed its status file — it and its CLI have exited';
      return {
        state: 'dead', running: false, live: false, kind: 'dead-process', reason: detail,
        evidence: { source: 'survival-handle', probe: 'dead', probeDetail: detail },
        since: null,
        ended: { at: null, kind: 'unknown', detail },
      };
    }
    const detail = 'the session-host broker has not reported in yet';
    return {
      state: 'unknown', running: false, live: true, kind: 'unknown', reason: detail,
      evidence: { source: 'survival-handle', probe: 'unknown', probeDetail: detail },
      since: null,
    };
  }
  return fromHostStatus(input.status, 'survival-handle');
}

/**
 * An in-memory bridge's claim to be running. THE ORDER IS THE FIX (BUG-033):
 *
 *  1. closed → nothing may still claim to run.
 *  2. not busy → alive, but no turn in flight.
 *  3. probe DEAD → dead immediately, no window. This is the reported incident's
 *     exact shape: SIGKILL the CLI mid-turn, the broker exits, no terminal
 *     frame is ever emitted, and `busy` would otherwise stay true forever.
 *  4. probe ALIVE → LIVE regardless of silence. THE false-positive guard: a
 *     genuinely long, silent tool call with a real process behind it is never
 *     reaped by the timer.
 *  5. probe UNKNOWN → the frameless backstop is the only thing left. Past the
 *     window the claim stops standing (`live:false`) but the STATE remains
 *     `unknown`, which is what tells the caller to REFUSE rather than race a
 *     second CLI onto a transcript it cannot prove is finished (BUG-022).
 */
export function livenessOfBridge(session: BridgeLike, now = Date.now()): Liveness {
  const probe = session.processProbe();
  /*
   * FEAT-057 — fill the `ended` slot from EVIDENCE, or say unknown.
   *
   * `at` stays null on purpose: what we know is that the thing is not there NOW,
   * not the instant it stopped, and the recorder stamps its own observation
   * time. The only cause this module will ever name is one the RUNTIME
   * classified from a real frame (BUG-031's taxonomy) for the turn that was in
   * flight — everything else is `unknown`, which is an honest answer and the
   * one thing that must never be upgraded to "completed" by guessing (§C).
   */
  const endedWith = (detail: string): LivenessEnd => {
    const pe = session.lastProviderError ?? null;
    if (!pe) return { at: null, kind: 'unknown', detail };
    return {
      at: null,
      kind: 'provider-error',
      detail: `${detail}; the last failure the engine reported for this turn was ${pe.kind} (${pe.provider}): ${pe.detail}`,
      providerError: pe,
    };
  };
  const base = {
    source: 'bridge' as const,
    probe: probe.state,
    probeDetail: probe.detail,
    lastFrameAt: session.lastFrameAt || null,
    framelessMs: FRAMELESS_MS,
  };
  if (session.closed) {
    return {
      state: 'dead', running: false, live: false, kind: 'closed', reason: 'the session is closed',
      evidence: { ...base, probe: 'dead', probeDetail: 'the session is closed' }, since: null,
      ended: endedWith('the session was closed'),
    };
  }
  if (!session.busy) {
    return {
      state: probe.state === 'dead' ? 'dead' : probe.state,
      running: false,
      // An idle session is not a running claim, so there is nothing to reap:
      // `live` stays true exactly as it did before this refactor, and the
      // reaper's own `!busy` skip is what keeps that from mattering.
      live: true,
      kind: 'idle',
      reason: 'no turn is running',
      evidence: base,
      since: null,
    };
  }
  const silentMs = now - (session.lastFrameAt || session.turnStartedAt || now);
  if (probe.state === 'dead') {
    return {
      state: 'dead', running: false, live: false, kind: 'dead-process', reason: probe.detail,
      evidence: { ...base, silentMs }, since: session.turnStartedAt,
      ended: endedWith(probe.detail),
    };
  }
  if (probe.state === 'alive') {
    return {
      state: 'alive', running: true, live: true, kind: 'ok', reason: probe.detail,
      evidence: { ...base, silentMs }, since: session.turnStartedAt,
    };
  }
  // `FRAMELESS_MS <= 0` disables the TIMER half only — the ground-truth rungs
  // above stay armed. Expressed here so no caller has to re-check the window.
  if (FRAMELESS_MS > 0 && silentMs > FRAMELESS_MS) {
    return {
      state: 'unknown', running: false, live: false, kind: 'frameless',
      reason:
        `no output of any kind from the agent for ${Math.round(silentMs / 1000)}s ` +
        `(limit ${Math.round(FRAMELESS_MS / 1000)}s) and ${probe.detail}`,
      evidence: { ...base, silentMs }, since: session.turnStartedAt,
    };
  }
  return {
    state: 'unknown', running: true, live: true, kind: 'ok',
    reason: `last frame ${Math.round(silentMs / 1000)}s ago`,
    evidence: { ...base, silentMs }, since: session.turnStartedAt,
  };
}

/**
 * TRANSCRIPT ACTIVITY — an EVIDENCE source, not a verdict about a process.
 *
 * A fresh mtime proves something appended just now. A stale one proves NOTHING
 * about whether a process is alive: a turn that thinks for a minute, or sits
 * inside a long tool call, writes nothing at all. So this rung answers 'alive'
 * or 'unknown' and NEVER 'dead' — which is the correction this refactor makes.
 * Before it, `isSessionLive()` returned a bare boolean whose `false` was read
 * by two callers as "not live", and the client's union of that boolean with a
 * live-bridge override is exactly what produced BUG-004 and then BUG-033.
 */
export function transcriptLiveness(
  input: { lastWriteMs: number | null; windowMs?: number },
  now = Date.now(),
): Liveness {
  const windowMs = input.windowMs ?? LIVE_WINDOW_MS;
  if (input.lastWriteMs == null) {
    const detail = 'no transcript file to check';
    return {
      state: 'unknown', running: false, live: true, kind: 'unknown', reason: detail,
      evidence: { source: 'transcript-mtime', probe: 'unknown', probeDetail: detail, lastWriteMs: null, windowMs },
      since: null,
    };
  }
  const ageMs = now - input.lastWriteMs;
  const fresh = ageMs <= windowMs;
  const detail = fresh
    ? `the transcript was appended to ${Math.round(ageMs / 1000)}s ago`
    : `the transcript has not been appended to for ${Math.round(ageMs / 1000)}s — which proves nothing about whether a turn is running`;
  return {
    state: fresh ? 'alive' : 'unknown',
    running: fresh,
    live: true, // never a reason on its own to drop anything
    kind: fresh ? 'ok' : 'unknown',
    reason: detail,
    evidence: { source: 'transcript-mtime', probe: fresh ? 'alive' : 'unknown', probeDetail: detail, lastWriteMs: input.lastWriteMs, ageMs, windowMs },
    since: input.lastWriteMs,
  };
}

/* ------------------------------------------------------- shared derivations
 *
 * Labels and payload shapes that more than one surface needs. They live here
 * for the same reason the probes do: two surfaces computing the same label
 * from the same facts is how they drift apart.
 */

/**
 * The coarse, HONEST state label for a driven session, as reported by
 * /api/health and rendered by `doctor`. Derived from the VERDICT, not from the
 * raw `busy` flag: before this, a zombie bridge reported `state:'busy'` in the
 * same payload whose own `liveness.live` said false.
 */
export function sessionStateLabel(
  session: { detached: boolean; busy: boolean },
  v: Liveness,
): 'detached-running' | 'busy' | 'idle' | 'not-running' {
  if (session.busy && !v.live) return 'not-running';
  if (session.detached && session.busy) return 'detached-running';
  if (session.busy) return 'busy';
  return session.detached ? 'detached-running' : 'idle';
}

/** The wire shape every route uses to publish a verdict. One shape, one meaning. */
export function livenessWire(v: Liveness) {
  return {
    live: v.live,
    running: v.running,
    state: v.state,
    kind: v.kind,
    reason: v.reason,
    evidence: v.evidence,
    since: v.since,
    ...(v.ended ? { ended: v.ended } : {}),
  };
}

/** Reduce a full verdict to its ground-truth rung (the shape probes are consumed as). */
export function asProbe(v: Liveness): LivenessProbe {
  return { state: v.state, detail: v.evidence.probeDetail || v.reason };
}

/** Read a broker status file, or null if it is not there / unreadable. */
export function readHostStatus(statusPath: string): HostStatus | null {
  try { return JSON.parse(fs.readFileSync(statusPath, 'utf8')) as HostStatus; } catch { return null; }
}
