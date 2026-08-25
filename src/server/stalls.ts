/**
 * BUG-046 (half 2) — THE STALL JUDGMENT: "is this work row still progressing?"
 *
 * WHY THIS FILE EXISTS. Four times in one day, a dispatched agent registered as
 * running work, launched its long run, the run died, and the agent idled
 * awaiting a notification that would never fire. The strip was HONEST — nothing
 * it could check had changed — but "N lanes silently waiting on dead runs" is
 * indistinguishable from "idle", and the user read an honestly-quiet strip as
 * "agents broken". ~1h was lost per stall until a human probed processes.
 *
 * WHAT A STALL IS — AND IS NOT (BUG-041's outcome-honesty invariants apply):
 *   - A stall is the THIRD state besides running and dead. It is an OBSERVATION
 *     about evidence ("nothing about this row has progressed for X, and no live
 *     process signal vouches for it"), never a verdict that the work ended.
 *   - A stalled row is NOT removed and NOT recorded as a death. `outcomes.ts`
 *     is never written from here — a completion is never a death, and a stall
 *     is not an outcome at all; it may still recover.
 *   - Recovery clears it WITHOUT residue, by construction: the judgment is a
 *     pure recomputation over current evidence, so the moment progress resumes
 *     the same inputs simply stop saying "stalled". Nothing is latched.
 *   - Everything here is ADVISORY (ARCH-002): a ⚠ row / rail card carries its
 *     evidence and asks a human to look. Nothing here may kill, settle, sweep
 *     or re-dispatch anything.
 *
 * NOT A LIVENESS RUNG (ARCH-001). This module never claims a process is alive
 * or dead — `liveness.ts` stays the single authority for that. The stall
 * question is orthogonal: the authority can honestly vouch for the SESSION
 * while one of its work rows has silently stopped moving. The `main` row is
 * deliberately out of scope here: the authority's own frameless backstop
 * already covers a main turn that goes silent.
 */

/**
 * How long a work row may show NO evidence of progress — no frame about it, no
 * counter movement — before it is marked stalled, PROVIDED no live process
 * signal vouches for it. Default 5 minutes: the incident's stalls sat ~1h; a
 * legitimately quiet foreground agent (one long tool call) is usually covered
 * by the live-signal half, and erring a little eager costs a ⚠ that clears
 * itself, never a kill. `<= 0` disables stall detection entirely.
 */
export const STALL_WINDOW_MS = Number(process.env.CLAUDE_STATION_STALL_WINDOW_MS ?? 300_000);

/**
 * A stalled row surviving THIS long past its last progress may additionally be
 * surfaced as a Needs-You rail card (still advisory, still evidence-carrying).
 * Default: two stall windows.
 */
export const STALL_ESCALATE_MS = Number(
  process.env.CLAUDE_STATION_STALL_ESCALATE_MS ?? (STALL_WINDOW_MS > 0 ? STALL_WINDOW_MS * 2 : 0),
);

/**
 * A LIVE PROCESS SIGNAL for one row — evidence, from whoever holds it, that
 * something real is still behind the row despite the silence. Today: the
 * engine's `background_tasks_changed` level listing the id (agent-bridge). A
 * row with a live signal is NEVER stalled — the same principle as the
 * authority's "an alive probe outranks any silence timer" rung, applied to the
 * orthogonal question.
 */
export interface StallSignal {
  live: boolean;
  /** Plain words: what was consulted and what it said. Shown to the user. */
  detail: string;
}

/** The evidence a ⚠ row carries — observations only, safe to show a user. */
export interface StallEvidence {
  /** When this row last showed any progress (server clock, epoch ms). */
  lastProgressAt: number | null;
  /** How long the evidence has been flat, at judgment time. */
  stalledForMs: number;
  windowMs: number;
  /** What was checked, in plain words — the ⚠'s hover/expand text. */
  checked: string;
}

export interface StallVerdict {
  stalled: boolean;
  /** Present iff `stalled` — the ⚠ row's quotable evidence. */
  evidence?: StallEvidence;
}

/**
 * THE judgment. Pure: same inputs, same answer, nothing latched — which is what
 * makes recovery residue-free.
 *
 * The rungs, in order:
 *  1. window disabled → never stalled.
 *  2. a live process signal → never stalled, however silent. (False ⚠ on live
 *     work is this feature's own failure mode; the signal outranks the timer.)
 *  3. no progress clock at all (neither a progress stamp nor a start time) →
 *     not stalled. Declaring a stall needs a real "flat since" observation;
 *     fabricating one from the judgment's own clock would be the same
 *     fabricated-stopwatch class as BUG-033 (§C).
 *  4. evidence flat past the window → stalled, with the evidence spelled out.
 */
export function judgeStall(
  input: {
    /** Last time ANY evidence about this row moved (frame, counter, output). */
    lastProgressAt: number | null;
    /** The row's honest start time — the floor when no progress was ever seen. */
    startedAt: number | null;
    /** A live process signal for the row, or null when none exists. */
    signal: StallSignal | null;
  },
  now = Date.now(),
): StallVerdict {
  if (STALL_WINDOW_MS <= 0) return { stalled: false };
  if (input.signal?.live) return { stalled: false };
  const since = input.lastProgressAt ?? input.startedAt;
  if (since == null || !Number.isFinite(since)) return { stalled: false };
  const flatMs = now - since;
  if (flatMs <= STALL_WINDOW_MS) return { stalled: false };
  const signalWords = input.signal
    ? input.signal.detail
    : 'no live process signal exists for this row';
  return {
    stalled: true,
    evidence: {
      lastProgressAt: input.lastProgressAt ?? null,
      stalledForMs: flatMs,
      windowMs: STALL_WINDOW_MS,
      checked:
        `no frame or counter progress for this row since ${new Date(since).toISOString()} ` +
        `(${Math.round(flatMs / 1000)}s ago, limit ${Math.round(STALL_WINDOW_MS / 1000)}s); ${signalWords}`,
    },
  };
}

/** Has this stall outlived the second window (the rail-card threshold)? */
export function stallEscalated(e: StallEvidence): boolean {
  return STALL_ESCALATE_MS > 0 && e.stalledForMs > STALL_ESCALATE_MS;
}
