/**
 * ARCH-017 step 1 — THE LANE LEDGER. Orchard's own record of a dispatched
 * lane's life: dispatched → settled → delivered.
 *
 * WHY THIS EXISTS. Today a dispatched lane's completion is a fact owned by the
 * harness (or, on the blocking dispatch path, by a socket frame that vanishes
 * once written). Nobody writes it down, so every surface re-derives it and no
 * surface can offer "hold this result / give me that one now". This store is
 * the one place that fact is recorded. In step 1 NOTHING READS IT: it is
 * written from the EXISTING blocking `op:'dispatch'` path so the record shape,
 * the retention rule and the boot reconciliation are proven against a real
 * running path before any dispatch behaviour changes.
 *
 * SIBLING OF `outcomes.ts`, NOT AN EXTENSION OF IT. That store's header states
 * as policy that it holds DEATHS only and that storing normal completions would
 * grow it by hundreds of rows; this one holds normal completions, whose payload
 * is orders of magnitude larger. One file answering two questions with two
 * retention rules is the ARCH-010 defect in miniature.
 *
 * THE THREE RULES THAT ARE NOT NEGOTIABLE (each is a reviewed defect of an
 * earlier draft of the plan, not a preference):
 *
 *  1. PRUNING NEVER DELETES AN UNDELIVERED RESULT. `outcomes.ts` prunes
 *     unconditionally (`records.slice(records.length - MAX_RECORDS)`); copied
 *     as-was, a busy period silently deletes the oldest settled-but-undelivered
 *     lane — the worst failure available here. Only records that are DELIVERED
 *     or DISMISSED may age out — never deletion, and never backpressure either:
 *     round 2 refused to RECORD anything once held records reached the bound,
 *     which (with no drain in step 1 and `dismiss()` reachable from nowhere)
 *     bricked the ledger permanently at 60 records. `capacity()` now REPORTS
 *     the overflow for step 2's drain to act on; recording never stops.
 *  2. DELIVERY IS A FACT WITH EVIDENCE, NOT A CLAIM ANYONE MAY ASSERT. It has
 *     had three wrong answers, each broken by an independent verifier: reading
 *     `!socket.destroyed` before the send (2 false stamps in 45); confirming
 *     the flush and a clean close (still 1 in 45, because a frame in a dead
 *     peer's receive buffer is indistinguishable from one it read); and taking
 *     the peer's word for it (a client whose stdout write FAILED acked anyway,
 *     and a peer that never read a byte acked too — both deterministic).
 *     The rule that survives: BOTH sides must supply evidence only a real
 *     delivery can produce. The server owns "I sent exactly N bytes and the
 *     write did not fail"; the client owns "I wrote exactly N bytes to fd 1",
 *     which it can only know by having received them. The stamp requires the
 *     ack's byte count to EQUAL what was sent. Anything else stays HELD, and
 *     held is prune-exempt — a duplicate delivery is a nuisance, a lost result
 *     is the failure this ticket exists to prevent.
 *  3. A `running` RECORD IS A CLAIM, NOT A FACT. The settle write happens in
 *     the Orchard server process; if the server restarts mid-lane the record
 *     would sit `running` forever and (from step 2 on) freeze its whole group.
 *     `reconcileBoot()` re-checks every such claim against ground truth — the
 *     child's pid AND a lane-id token in its argv, so a reused pid cannot be
 *     mistaken for our child — and never guesses.
 *
 * A CORRUPT STORE IS NOT AN EMPTY STORE. `outcomes.ts` returns `[]` for an
 * unreadable file, which is safe for deaths and catastrophic here: the next
 * write would overwrite every held result with `[]`. A parse failure throws
 * (after preserving the bytes as `.corrupt-<ts>` — ONCE, not once per read),
 * so the failure is loud and non-destructive.
 *
 * ROUND 2 — WHAT AN INDEPENDENT VERIFIER BROKE, AND WHAT NOW HOLDS IT.
 * Round 1 assumed "synchronous fs = safe". That is true within ONE process and
 * false across two, and `reconcileBoot()` exists precisely because two Orchard
 * servers can share a data dir. Reproduced: 50 records reported written, 25 on
 * disk; 13 settled results on disk with no record pointing at them, and
 * `settle()` returned NULL rather than throwing, so nothing was even logged.
 * Three mechanisms close it, none of them a retry or a warning:
 *  - ONE WRITER BY CONSTRUCTION (round 3 — this replaced round 2's hand-rolled
 *    `withLock()`, which a second verifier broke three more ways; see the long
 *    note above `claimWriter()`). The writer claim is arbitrated by the kernel
 *    via a unix socket named for the data dir; a process that does not hold it
 *    THROWS `not-writer` instead of writing unserialised.
 *  - `settle()` THROWS `record-missing` instead of returning null, and it
 *    checks the record BEFORE writing the result file, so a lost record can
 *    neither pass silently nor leave an orphaned result directory.
 *  - the SERVER pid gets the same identity guard the child pid already had:
 *    a recycled `serverPid` used to pin a `running` claim forever (prune-exempt,
 *    holding an admit slot for good). Ownership is now proven by the pid's own
 *    start time plus the machine's boot id, and a non-positive pid is never
 *    "alive" (`kill(0,0)`/`kill(-1,0)` signal a process GROUP).
 */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import { dataDir, ensureDir, writeAtomic } from '../lib/paths.ts';

/*
 * STEP 2 — `pending` is a declared member that has not spawned yet.
 *
 * Why it must exist as a real row rather than an absence: a group's drain fires
 * when its LAST member settles, so the drain has to be able to tell "member 3
 * of 4 has not started yet" from "there is no member 3". With no row, a
 * declared-but-never-spawned member is indistinguishable from a group of 3 and
 * the drain fires early, delivering 3 results and orphaning the 4th. With a row
 * the group is honestly incomplete, and the member that never spawns is
 * `settle(id, {state:'cut', failureKind:'never-spawned'})` — a terminal state a
 * human can see, not a freeze nobody can explain.
 *
 * `pending` is NOT terminal and NOT deliverable: `list({heldOnly})` excludes it
 * exactly as it excludes `running`.
 */
export type LaneState = 'pending' | 'running' | 'settled' | 'failed' | 'cut';
export type LaneAcknowledgedBy = 'blocking-dispatch' | 'group-settle' | 'user' | 'orchestrator' | 'timeout';
/** How the child ran. Step 1 only ever writes `blocking-dispatch`. */
export type LaneTransport = 'blocking-dispatch';

export interface LaneUsage {
  [k: string]: unknown;
}

export interface LaneRecord {
  /** `lane-<base36 ms>-<rand>` — also stamped into the child's argv (see `argvToken`). */
  id: string;
  projectId: string | null;
  projectName: string | null;
  /**
   * The session that asked for this lane. NULL on the blocking transport: the
   * dispatch socket's request carries no session id today (`REQUEST_KEYS` in
   * `dispatch-broker.ts`), and this store does not guess. Step 2's `op:'start'`
   * declares it.
   */
  parentSessionId: string | null;
  /**
   * Declared by the DISPATCHER, never derived (ARCH-010). A blocking dispatch
   * is a group of exactly one, closed at birth: the caller waits for it inline,
   * so there is no other member it could be waiting on.
   */
  groupId: string;
  groupSize: number;
  groupClosed: boolean;
  /*
   * STEP 2 GROUP STATE. `groupClosed` above is the DECLARATION made at birth
   * ("no further members will be added"); the four below are the LIFECYCLE, and
   * they are separate because a group can be declared open and must still be
   * closable later, by a caller or by a deadline, without rewriting the
   * declaration.
   *
   *  - `groupOpen`          — more members may still be dispatched into this
   *                           group. While true the drain MUST NOT fire even if
   *                           every existing member is terminal: that is the
   *                           "a drain racing a newly dispatched lane" hazard.
   *  - `groupCloseDeadline` — absolute ms. PERSISTED, not a timer, because a
   *                           timer dies with the process and "a group that is
   *                           never closed" is exactly the case that outlives a
   *                           restart. Boot re-arms from this number.
   *  - `groupClosedAt`      — when the close actually happened (null while open).
   *  - `groupExtendedAt`    — last time the deadline was pushed out, so an
   *                           indefinitely-extended group is visible rather than
   *                           looking like a fresh one.
   */
  groupOpen: boolean;
  groupCloseDeadline: number | null;
  groupClosedAt: number | null;
  groupExtendedAt: number | null;
  label: string;
  /** Bounded excerpt of the prompt — enough to recognise the lane, never the whole charter. */
  charter: string;
  provider: string;
  model: string | null;
  transport: LaneTransport;
  /** FEAT-100 declaration fields, carried verbatim when the caller declared them. */
  ticket: string | null;
  phase: string | null;
  round: string | null;
  laneClass: string | null;
  dispatchedAt: number;
  state: LaneState;
  settledAt: number | null;
  /** AUTHORITATIVE result location (a file under this lane's own directory). */
  resultPointer: string | null;
  /** Bounded excerpt for a rail row. Never the authority. */
  resultExcerpt: string | null;
  failureKind: string | null;
  /** Tokens/cost as the child REPORTED them. `null` means absent, never zero-guessed. */
  usage: LaneUsage | null;
  /**
   * ROUND 4 — ORCHARD'S OWN FACT, recorded whatever any peer says or does not
   * say: "I wrote exactly `handoffBytes` bytes of this result to the consumer
   * and the write completed without error." Unforgeable, because no other party
   * contributes to it.
   *
   * It is deliberately NOT `acknowledgedAt`. On a unix socket a completed write is
   * equally true for a peer that is dead, that never reads, or whose own stdout
   * write then fails (ENOSPC/EPIPE) — which is precisely the round-2 data-loss
   * finding. Handoff is what Orchard KNOWS; delivery additionally requires the
   * consumer to prove it holds those exact bytes. Keeping them as two fields is
   * the ARCH-010 shape: one fact, one owner, stated by its owner.
   */
  handoffAt: number | null;
  handoffBytes: number | null;
  handoffEvidence: string | null;
  /**
   * ROUND 5 — READ THIS BEFORE TRUSTING THE NAME. On the step-1 blocking
   * transport, `acknowledgedAt` does NOT mean "this text entered the parent's
   * context". It means: Orchard's own write completed (see `handoffAt`, which is
   * now REQUIRED before this can be set) and the consumer returned an
   * unguessable proof that it holds exactly those bytes and states which channel
   * it wrote them to. Emission is not observable from the Orchard process — a
   * consumer that holds the bytes and writes them nowhere produces a valid
   * receipt (measured; see `deliveryProof`) — so the honest reading of this
   * field on this transport is ACKNOWLEDGED POSSESSION, not arrival. Step 2's
   * `drainLanes()` is the caller that will stamp a real context delivery, and
   * `acknowledgedBy` is what tells the two apart.
   */
  acknowledgedAt: number | null;
  acknowledgedBy: LaneAcknowledgedBy | null;
  /**
   * WHAT was proven, as a token rather than prose, so a reader never has to
   * infer the strength of the claim from the field name:
   * `possession-digest-fd1` / `possession-digest-fd2` — the consumer proved it
   * holds the bytes and named that channel. Nothing stronger exists on this
   * transport.
   */
  deliveryProof: string | null;
  /** WHY this is stamped delivered — auditable after the fact, never prose. */
  acknowledgementEvidence: string | null;
  /**
   * ROUND 6 — WHY THIS RESULT IS STILL HELD, in the receipt rule's own words.
   *
   * Until now the refusal reason was computed, logged to nobody, and dropped:
   * a held record said only `acknowledgedAt: null`, so "nothing acknowledged it"
   * and "a peer tried and was refused because its proof was for the wrong
   * channel" were the same record. Two consequences, one for each audience.
   * For a user: the rail can say why a result is waiting instead of just that it
   * is. For a test: every refusal test could previously pass because NOTHING
   * HAPPENED — a peer double that silently failed to send its receipt produced
   * the same `acknowledgedAt: null` as a receipt the rule correctly rejected.
   * That is the vacuity shape a reviewer found in D15 and asked to be audited
   * for across the suite; this field is what makes each refusal assert its own
   * distinct observed reason rather than an absence.
   */
  heldReason: string | null;
  dismissedAt: number | null;
  /**
   * ROUND 9 (finding 3) — AN IMMUTABLE PER-RECORD GENERATION, so a drain binds to
   * the exact record it read, not merely to its id. The ledger can be swapped
   * underneath a running drain (a record settled, pruned, and a NEW record given
   * the same id): the old bundle then acknowledged a replacement lane's different,
   * unseen result. The drain captures this token when it reads the result for the
   * bundle and the handoff writer refuses to stamp if the record on disk no longer
   * carries it — so a swapped record is skipped, never acknowledged by a stale
   * bundle. Set once at birth and never rewritten.
   */
  generation: string;
  /**
   * ROUND 9 (finding 4) — WHEN starvation-readiness was first reached, PERSISTED
   * so readiness is MONOTONIC. `ready` was `now - settledAt >= HELD_STARVATION_MS`,
   * which REGRESSES if the wall clock rolls back (`clock rollback 1h: ready=true ->
   * false`). Once a held result has been released to the rail on its own, it stays
   * released: this timestamp is stamped the first time the threshold is crossed and
   * `ready` is thereafter true regardless of what the clock does next.
   */
  starvationReleasedAt: number | null;
  /* ---- ground truth for reconciliation (rule 3) ---- */
  /** The child process id, as spawned by the server that wrote this record. */
  pid: number | null;
  /** A string that MUST appear in the child's argv — the pid-reuse guard. */
  argvToken: string | null;
  /** The Orchard server process that owns the settle write for this record. */
  serverPid: number;
  /**
   * The owning server's own IDENTITY, so a recycled pid cannot impersonate it:
   * its process start time (jiffies since boot) and the machine's boot id. A
   * record whose owner cannot be positively identified is treated as UNOWNED —
   * an unresolvable claim is prune-exempt forever and would silently consume an
   * admit slot, which is worse than resolving it honestly.
   */
  serverStart: string | null;
  bootId: string | null;
  /** Set by `reconcileBoot()`; plain words, safe to show a user. */
  reconciledAt: number | null;
  reconcileDetail: string | null;
}

/**
 * Retention bound. Deliberately far smaller than `outcomes.ts`'s 200: a lane
 * record carries a result excerpt and points at a stored result file, so it is
 * heavy where a death record is light. Only DELIVERED/DISMISSED records are
 * eligible to be pruned at all.
 */
export const MAX_RECORDS = 60;

/**
 * STEP 2 — how long an OPEN group may stay open before the deadline closes it.
 *
 * This is the answer to "a group that is never closed". Thirty minutes is long
 * enough that a dispatcher adding members over a working stretch is not cut off
 * mid-fan-out, and short enough that a forgotten close does not hold results
 * past the point the user has moved on. It is a DEADLINE, not a timer: the
 * number is on the record, so a restart re-arms from the file.
 */
export const GROUP_CLOSE_TTL_MS = 30 * 60 * 1000;

/**
 * STEP 2 — STARVATION BOUND. A terminal, un-collected result is auto-delivered
 * to the pending rail after this long even if its group is still waiting on a
 * sibling. The hazard it closes: one lane that runs for hours holds every fast
 * sibling's result hostage, and the user — who asked for this feature to stop
 * waiting — waits longer than before. Crossing it does NOT dismiss anything; it
 * releases the result to where a human can see and process it.
 */
export const HELD_STARVATION_MS = 20 * 60 * 1000;
export const CHARTER_EXCERPT_MAX = 500;
export const RESULT_EXCERPT_MAX = 2000;

/** The furthest a persisted deadline may sit — finite so it round-trips JSON. */
export const MAX_DEADLINE = Number.MAX_SAFE_INTEGER;

/**
 * ROUND 9 (finding 4) — VALIDATE A DEADLINE BEFORE IT IS PERSISTED.
 *
 * `now + ttlMs` with an extreme finite `ttlMs` overflows to `Infinity`, and
 * `JSON.stringify(Infinity)` is `"null"`, which reads back as "no deadline" — a
 * group open FOREVER, the exact opposite of what a close deadline is for
 * (`finite deadline addition overflow: diskDeadline=null … open=true`). A
 * non-finite or absurd result is clamped to a finite far-future value that
 * round-trips and that `sweep()` can still evaluate, so an overflow shortens the
 * window to "very long" rather than removing it. A `null` in (no deadline
 * requested) stays `null`.
 */
export function safeDeadline(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value)) return MAX_DEADLINE;
  return Math.min(value, MAX_DEADLINE);
}

export class LaneStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LaneStoreError';
    this.code = code;
  }
}

export function laneStoreFile(): string {
  return path.join(dataDir(), 'lanes.json');
}
/**
 * ROUND 9 (finding 1) — the DURABLE group-seal store, in a SEPARATE file that
 * retention pruning never touches. The seal (a group has begun delivery) used to
 * live only in the lane rows, which `prune()` is designed to delete; once the
 * delivered row was pruned the group accepted new members again, and once EVERY
 * row was pruned the groupId was reusable and drained a second time. This file is
 * the seal's home so it outlives the rows it was derived from.
 */
export function groupSealFile(): string {
  return path.join(dataDir(), 'group-seals.json');
}
/** Every lane's own directory. The result file lives here; the record points at it. */
export function laneDir(id: string): string {
  return path.join(dataDir(), 'lanes', id);
}

/* ------------------------------------------------ ONE WRITER, ARBITRATED BY THE KERNEL

 * ROUND 3 — the lock is GONE, and its whole failure class with it.
 *
 * Round 2 added a hand-rolled cross-process lock file. A second independent
 * verifier then broke it three more ways, all reproduced here before this was
 * written: a LIVE holder's lock is stolen after 30 s (`holderDead || age > 30s`,
 * with the mtime written once and never refreshed — a laptop suspend or an NTP
 * step does it in 60 ms); the holder's release then unlinks the THIEF's lock so
 * a third process walks straight in; and the stale-break is a TOCTOU where N
 * waiters break the same lock and enter together (measured: 14 of 48 records
 * lost, 14 orphaned result dirs, 1 run in 4). It also froze the event loop for
 * 5009 ms with zero timer ticks — a whole server stalling on a dispatch.
 *
 * Rather than a fourth guard, the question the failures were asking: WHO
 * legitimately writes this store? `grep` answers it — `dispatch-broker.ts`
 * (record/attach/settle) and `index.ts` (boot reconciliation), both inside the
 * Orchard SERVER process, and nothing else in `src/` or `scripts/`. The lock was
 * protecting a scenario with no legitimate participant: it made a nonsense state
 * (two servers mutating one data dir) *quietly survivable* instead of loud.
 *
 * So the store now has ONE WRITER BY CONSTRUCTION, and the claim is arbitrated
 * by the kernel rather than by a file this code interprets: the writer binds a
 * unix socket named for the data dir (Linux abstract namespace, so there is no
 * file to go stale, no mtime to misjudge, no unlink to cascade, and the kernel
 * releases it the instant the process dies). A process that cannot take the
 * claim REFUSES to mutate — loudly, via `not-writer` — instead of writing
 * unserialised. There is no timeout, no spin, and nothing that blocks the event
 * loop, because there is nothing to wait FOR: a second writer is a
 * misconfiguration to report, not a queue to join.
 *
 * Reads stay lock-free and unclaimed: `writeAtomic`'s rename means a reader
 * either sees the whole previous file or the whole new one.
 */

function pidAlive(pid: number): boolean {
  // Non-positive pids are NOT processes: kill(0,·) signals this process group
  // and kill(-1,·) broadcasts, so both would read as "alive". Reject them.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // alive, just not ours
  }
}

let writerClaim: net.Server | null = null;
let claimedFor: string | null = null;

/** The kernel-visible name of the writer claim for a given data dir. */
export function writerClaimName(dir: string = dataDir()): string {
  const key = createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 16);
  // Linux abstract socket: no filesystem entry, freed by the kernel on death.
  if (process.platform === 'linux') return `\0orchard-lanes-${key}`;
  return path.join(dir, `.lanes-writer-${key}.sock`);
}

export interface WriterClaim { ok: boolean; name: string; reason?: string }

/**
 * Take (or confirm) this process's claim to be the ledger's only writer.
 *
 * ROUND 3, SECOND PASS — THIS FUNCTION IS ASYNC, AND THAT IS THE WHOLE POINT.
 * The first round-3 draft called `srv.listen(name)` inside a `try` and treated
 * a missing throw as success. `listen()` does not throw for EADDRINUSE: it
 * EMITS the error on the next tick, and the draft's own "never crash the owner"
 * error handler swallowed it. Measured, two processes, one data dir:
 *   A claim: {"ok":true,…} isWriter: true   A wrote OK
 *   B claim: {"ok":true,…} isWriter: true   B wrote OK
 * i.e. the single-writer guarantee was VACUOUS — every unserialised-write
 * failure it was built to end was still live. Awaiting the listen settles it
 * against the kernel in ~1 ms (measured: B gets EADDRINUSE after 1 ms).
 *
 * So claiming is an explicit, awaited STARTUP act (`dispatch-broker.start()`,
 * the server's boot path, a test's own setup) and mutation time is a cheap
 * synchronous CHECK (`assertWriter()`). A process that never claimed does not
 * write; it throws. Idempotent, and re-taken if the data dir changes under a
 * test. Failure is a FACT to report, never something to retry into: another
 * live process already owns this data dir's ledger.
 */
/**
 * EADDRINUSE means two very different things, and only one of them is a
 * correctly working system. ROUND 4, closing the attack round 3 flagged and
 * could not exercise (it is not reachable on Linux at all):
 *
 * - **Linux (abstract namespace)**: the name exists only while a process holds
 *   it, so EADDRINUSE always means a LIVE writer. Nothing to diagnose.
 * - **Off Linux (filesystem socket)**: the inode OUTLIVES the process. After a
 *   SIGKILL the successor is refused EADDRINUSE **forever** and the ledger
 *   becomes permanently unwritable with every held result still on disk.
 *   Measured on this host with `process.platform` faked before the import
 *   (`scripts/scratch-a17-r4-fssock-wedge.mjs` — real socket, real SIGKILL,
 *   real EADDRINUSE): `claim {ok:false,reason:"EADDRINUSE"}`, `wrote:
 *   "not-writer"`, 1 undelivered result stranded, socket file still on disk;
 *   the Linux leg of the same script recovers.
 *
 * This probes the address — a connect that is REFUSED proves no listener — and
 * reports which case it is. It deliberately does NOT unlink and retry.
 * Auto-recovery was considered and rejected with a reason: two successors
 * probing at once both see "stale", and the second one's unlink deletes the
 * FIRST one's live socket, producing exactly the two-simultaneous-writers
 * failure this whole mechanism exists to make impossible (and the one that was
 * found vacuous in round 3). There is no way to unlink-if-still-this-inode from
 * Node, so the honest move is to name the condition and let a human remove the
 * file, not to guess under a race. Diagnosis cannot create a second writer.
 */
async function diagnoseInUse(name: string): Promise<{ reason: string }> {
  if (name.startsWith('\0')) return { reason: 'EADDRINUSE' }; // abstract: always a live holder
  const live = await new Promise<boolean>((resolve) => {
    const probe = net.createConnection(name);
    const settle = (v: boolean) => { try { probe.destroy(); } catch { /* already gone */ } resolve(v); };
    probe.once('connect', () => settle(true));
    probe.once('error', (e) => settle((e as NodeJS.ErrnoException).code !== 'ECONNREFUSED' && (e as NodeJS.ErrnoException).code !== 'ENOENT'));
    setTimeout(() => settle(true), 2000).unref?.();
  });
  return live
    ? { reason: 'EADDRINUSE' }
    : { reason: `EADDRINUSE-stale-socket: ${name} exists but nothing is listening on it, so a previous writer was killed without unlinking it (this cannot happen on Linux, which uses the abstract namespace). The ledger is UNWRITABLE until that file is removed; held results are untouched on disk. Remove ${name} by hand once no Orchard server is running against this data dir.` };
}

export async function claimWriter(): Promise<WriterClaim> {
  const name = writerClaimName();
  if (writerClaim && claimedFor === name) return { ok: true, name };
  if (writerClaim) { try { writerClaim.close(); } catch { /* replaced below */ } writerClaim = null; claimedFor = null; }
  const srv = net.createServer();
  const outcome = await new Promise<WriterClaim>((resolve) => {
    srv.once('error', (e) => resolve({ ok: false, name, reason: (e as NodeJS.ErrnoException).code ?? e.message }));
    srv.once('listening', () => resolve({ ok: true, name }));
    try {
      srv.listen(name);
    } catch (e) {
      resolve({ ok: false, name, reason: (e as Error).message });
    }
  });
  if (!outcome.ok) {
    try { srv.close(); } catch { /* never listened */ }
    return outcome.reason === 'EADDRINUSE' ? { ...outcome, ...(await diagnoseInUse(name)) } : outcome;
  }
  // Only NOW is a later error someone else's problem to log, not ours to read.
  srv.on('error', () => { /* a peer probing the claim must never crash the owner */ });
  srv.unref();
  writerClaim = srv;
  claimedFor = name;
  return outcome;
}

/** Does this process hold the writer claim right now? */
export function isWriter(): boolean {
  return !!writerClaim && claimedFor === writerClaimName();
}

/** Give the claim up (tests, and a clean shutdown). */
export function releaseWriter(): void {
  if (writerClaim) { try { writerClaim.close(); } catch { /* already gone */ } }
  writerClaim = null;
  claimedFor = null;
}

/**
 * Every mutation passes here. A process that is not the writer does NOT write —
 * it throws, so the caller logs a real misconfiguration instead of silently
 * dropping half of two servers' records (which is what the unserialised
 * round-1 store did: 50 records claimed, 25 on disk).
 */
export function assertWriter(): void {
  if (isWriter()) return;
  throw new LaneStoreError(
    'not-writer',
    `this process is NOT the lane ledger's writer for ${dataDir()} (claim ${JSON.stringify(writerClaimName())}). Refusing to write: the ledger has exactly one writer by construction, and a second one would lose records rather than merge them. Either another live process holds the claim, or this process never took it — the claim is taken once, explicitly, with \`await claimWriter()\` at startup. If no other Orchard server should be running against this data dir, stop it; if this is a test, point CLAUDE_STATION_DATA somewhere else.`,
  );
}

/* ------------------------------------------------ process identity (pid reuse) */

/** This machine's boot id — jiffies-since-boot only compare within one boot. */
export function bootId(): string | null {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** A pid's start time (field 22 of /proc/pid/stat) — the canonical reuse guard. */
export function procStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const after = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // after comm; [0] is field 3
  const v = after[19]; // field 22 = starttime
  return v && /^\d+$/.test(v) ? v : null;
}

/**
 * Is THIS pid the very process that wrote the record — not merely some live
 * process wearing its number? `null`/unverifiable start time means NO: an
 * unresolvable claim is held forever, so "unknown" must not read as "alive".
 */
export function sameProcess(pid: number, startedAt: string | null, recordedBootId: string | null): boolean {
  if (!pidAlive(pid)) return false;
  if (!startedAt) return false;
  if (recordedBootId && bootId() && recordedBootId !== bootId()) return false;
  const now = procStartTime(pid);
  return now != null && now === startedAt;
}

function excerpt(text: string, max: number): string {
  const t = String(text ?? '');
  return t.length <= max ? t : `${t.slice(0, max)}\n…[truncated ${t.length - max} chars; the result file is authoritative]`;
}

/**
 * Read the whole ledger.
 *
 * ENOENT is an empty ledger (no store yet). ANY other failure — a truncated
 * file, a half-written byte range, garbage — THROWS, after preserving the bytes
 * once as `.corrupt-<ts>`. Returning `[]` here is what would turn a transient
 * read problem into permanent loss of every held result on the next write.
 */
/**
 * ROUND 5 RENAME — records written before it are read, not broken.
 *
 * `deliveredAt/deliveredBy/deliveryEvidence` became
 * `acknowledgedAt/acknowledgedBy/acknowledgementEvidence` because the old names
 * claimed more than the evidence supports (see the field docs). Ledgers written
 * by the older code exist on disk right now — the live data dir held 10 such
 * records, 1 of them stamped — and a held, undelivered result is the single
 * thing this store exists to not lose. So a legacy record is UPGRADED IN PLACE
 * on read (and persisted under the new names by the next write), rather than
 * read as `acknowledgedAt: undefined`, which `isHeld()` would have treated as
 * held and the rail would have re-offered an already-collected result.
 *
 * Deliberately one-way and lossless: it moves values, never invents them, and a
 * record already carrying the new names is untouched. There is no reverse
 * migration, and none is needed — the old code is not coming back.
 */
function upgradeLegacyNames(r: Record<string, unknown>, index: number, raw: string): void {
  for (const [oldName, newName] of [
    ['deliveredAt', 'acknowledgedAt'],
    ['deliveredBy', 'acknowledgedBy'],
    ['deliveryEvidence', 'acknowledgementEvidence'],
  ] as const) {
    if (!(oldName in r)) continue;
    /*
     * ROUND 6 defect 3a — a record carrying BOTH names with DIFFERENT values is
     * ambiguous, and round 5 resolved it silently in favour of the new one.
     * There is no honest way to pick: they are two answers to one question,
     * which is the ARCH-010 defect in a single record. Refuse loudly, preserve
     * the bytes, let a human decide — the same contract the store already has
     * for corruption, and the right one when the file holds uncollected results.
     */
    /*
     * ROUND 7 finding 2 — THE CONFLICT RULE NOW FIRES ON ANY DISAGREEMENT,
     * INCLUDING null-VERSUS-VALUE. Round 6 required both sides to be non-null,
     * so `{deliveredAt:123, acknowledgedAt:null}` fell through the guard and the
     * legacy value was COPIED OVER the explicit null — measured:
     *   {"refusedWith":null,"acknowledgedAfterRead":123,"handoffAfterRead":null}
     * i.e. an acknowledgement fabricated out of a legacy field, on a record with
     * no handoff behind it, which the store forbids on write. `null` is not
     * "unset" here: code that writes the new names always writes the key, so an
     * explicit null IS an answer — "this was never acknowledged" — and it
     * disagreeing with a legacy timestamp is exactly the two-answers case.
     * Only a record carrying the legacy name ALONE is upgraded.
     */
    if (newName in r && r[newName] !== r[oldName]) {
      throw corruptError(raw, `record ${index} (${String(r.id)}) carries BOTH the legacy ${oldName} (${JSON.stringify(r[oldName])}) and the current ${newName} (${JSON.stringify(r[newName])}), and they disagree — two answers to one question, and nothing here will guess which one is true. An explicit null is an answer, not an absence: the current writer always writes this key.`);
    }
    r[newName] = r[oldName];
    delete r[oldName];
  }
  if (!('deliveryProof' in r)) r.deliveryProof = null; // round-5 addition; absent on older records
  if (!('starvationReleasedAt' in r)) r.starvationReleasedAt = null; // round-9 addition; absent on older records
  // NOTE: `generation` is assigned and PERSISTED in `readAll`, not here — see the
  // round-10 comment there. A per-id fallback would collide on a reused id.
  /*
   * STEP 2 group-state fields, absent on every record written by step 1. These
   * are DEFAULTED, not refused, and the default is the conservative one: a
   * record that predates group lifecycle is CLOSED (`groupOpen:false`) with no
   * deadline, so an old row can never hold a new group open forever and can
   * never be auto-closed by a deadline it never agreed to. Defaulting the other
   * way — open — would make every pre-existing lane in the live ledger block
   * its own drain, which is the failure this ticket exists to end.
   */
  if (!('groupOpen' in r)) r.groupOpen = false;
  if (!('groupCloseDeadline' in r)) r.groupCloseDeadline = null;
  if (!('groupClosedAt' in r)) r.groupClosedAt = null;
  if (!('groupExtendedAt' in r)) r.groupExtendedAt = null;
  /*
   * The same TYPE discipline the acknowledgement timestamps get: a surface asks
   * "is this deadline past?" and a non-numeric value would silently answer "no,
   * forever" — a group that can never auto-close and a result held indefinitely.
   */
  for (const field of ['groupCloseDeadline', 'groupClosedAt', 'groupExtendedAt'] as const) {
    const v = r[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw corruptError(raw, `record ${index} (${String(r.id)}) has ${field}=${JSON.stringify(v)}, which is not a timestamp. Refusing to read it: the drain compares this number against the clock to decide whether a group may close, so a non-numeric value would hold every result in the group forever`);
    }
  }
  /*
   * Two answers to one question, again (ARCH-010). `groupOpen:true` with a
   * `groupClosedAt` is a record saying both "still accepting members" and
   * "closed at T". Nothing here guesses which is true.
   */
  if (r.groupOpen === true && r.groupClosedAt != null) {
    throw corruptError(raw, `record ${index} (${String(r.id)}) says groupOpen=true AND groupClosedAt=${JSON.stringify(r.groupClosedAt)} — a group cannot be both still open and already closed, so the file has been altered or half-written`);
  }
  /*
   * ROUND 6 defect 3b — A MALFORMED TIMESTAMP IS NOT AN ACKNOWLEDGEMENT.
   * Measured before this: `{"id":"bad","acknowledgedAt":"garbage"}` was read
   * back verbatim, and every reader that asks `acknowledgedAt != null` — which
   * is what `isHeld()` asks — then treated a nonsense string as proof the
   * result had been collected, so a held result silently stopped being held and
   * became prunable. These four fields are the ones a lie about costs a result,
   * so their TYPE is checked at the one door, not their presence.
   */
  for (const field of ['acknowledgedAt', 'handoffAt', 'settledAt', 'dismissedAt'] as const) {
    const v = r[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw corruptError(raw, `record ${index} (${String(r.id)}) has ${field}=${JSON.stringify(v)}, which is not a timestamp. Refusing to read it: every surface asks "${field} != null" to decide whether this result has been collected, so a non-numeric value here would silently retire a held result`);
    }
  }
  /*
   * ROUND 7 — THE TWO-PART FACT IS CHECKED ON THE WAY IN, NOT ONLY ON THE WAY
   * OUT. `markAcknowledged()` refuses to create an acknowledgement with no
   * handoff behind it; a file can still ARRIVE in that state (hand-edited, a
   * legacy upgrade, a half-written record), and read-side silence would make
   * the write-side guard decorative. Same contract as the rest of this door:
   * refuse loudly, preserve the bytes, let a human decide.
   */
  if (r.acknowledgedAt != null && r.handoffAt == null) {
    throw corruptError(raw, `record ${index} (${String(r.id)}) is acknowledged (acknowledgedAt=${JSON.stringify(r.acknowledgedAt)}) but carries NO handoff — an acknowledgement is the consumer's half of a two-part fact and this ledger cannot produce that combination, so the file has been altered or half-written`);
  }
}

export function readAll(): LaneRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(laneStoreFile(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new LaneStoreError('unreadable', `lane ledger could not be read: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw corruptError(raw, `it is not valid JSON (${(e as Error).message})`);
  }
  if (!Array.isArray(parsed)) throw corruptError(raw, 'it is not a JSON array');
  /*
   * ROUND 2 — SHAPE, not just syntax. A ledger of `[null, 42, "x"]` parses, and
   * every caller then died on a raw `TypeError` from deep inside a filter,
   * bypassing the "loud and non-destructive" contract this class exists to
   * give. Validated at the one door instead.
   */
  let upgradedGeneration = false;
  for (let i = 0; i < parsed.length; i++) {
    const r = parsed[i] as unknown;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw corruptError(raw, `record ${i} is ${r === null ? 'null' : typeof r}, not an object`);
    if (typeof (r as LaneRecord).id !== 'string' || !(r as LaneRecord).id) throw corruptError(raw, `record ${i} has no id`);
    upgradeLegacyNames(r as Record<string, unknown>, i, raw);
    /*
     * ROUND 10 (finding 4) — LEGACY GENERATIONS ARE UNIQUE AND PERSISTED. Round 9
     * defaulted a missing generation to `legacy-${id}`, but the id is REUSABLE, so
     * a record settled/pruned and re-created with the same id got the SAME
     * generation and the swap-detection passed — and legacy rows are the real ones
     * on disk. A fresh RANDOM token is assigned instead, and PERSISTED here (once,
     * on the writer) so it is stable across reads; a per-read random would refuse
     * every legitimate legacy delivery, and an id-derived one collides on reuse.
     */
    const rec = r as Record<string, unknown>;
    if (typeof rec.generation !== 'string' || !rec.generation) { rec.generation = randomBytes(12).toString('hex'); upgradedGeneration = true; }
  }
  if (upgradedGeneration && isWriter()) {
    try { writeAtomic(laneStoreFile(), JSON.stringify(parsed, null, 2)); }
    catch { /* best effort: the upgrade re-runs on the next read until it persists */ }
  }
  return parsed as LaneRecord[];
}

/**
 * Preserve the corrupt bytes ONCE and describe the recovery.
 *
 * Round 1 wrote a full copy on EVERY read, and a read runs on every dispatch, so
 * a ~200 KB ledger dropped ~200 KB of junk into the data dir per dispatch,
 * forever. It also does NOT self-heal, and that is deliberate: healing means
 * discarding the file, and the file is where undelivered results live. The
 * quarantine copy and the recovery instruction are the honest answer; a human
 * decides what to do with held results, never this code.
 */
function corruptError(raw: string, why: string): LaneStoreError {
  const dir = path.dirname(laneStoreFile());
  const base = `${path.basename(laneStoreFile())}.corrupt-`;
  let keep: string | null = null;
  try {
    keep = fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort()[0] ?? null;
    if (!keep) {
      keep = `${base}${Date.now()}`;
      fs.writeFileSync(path.join(dir, keep), raw);
    }
  } catch {
    /* preservation is best-effort; the throw is the load-bearing half */
  }
  return new LaneStoreError(
    'corrupt',
    `lane ledger is unusable: ${why}. The bytes are preserved once at ${keep ? path.join(dir, keep) : '(could not be preserved)'} and nothing here will overwrite or auto-heal the file, because undelivered lane results live in it. Recover by repairing ${laneStoreFile()} by hand, or move it aside to start a new ledger — accepting that any held result it named is then only reachable under ${path.join(dataDir(), 'lanes')}.`,
  );
}

/**
 * THE RECEIPT RULE — ONE IMPLEMENTATION, USED BY EVERY DELIVERY PATH.
 *
 * `sha256(nonce ‖ channel ‖ bytes)`. Three inputs, each closing a distinct
 * attack, and all three are needed:
 *
 *  - `bytes`   — POSSESSION. Only a holder of the exact payload can produce it.
 *  - `nonce`   — REPLAY. A fresh nonce per send means a receipt for an earlier
 *                send cannot acknowledge a later one, even when the two
 *                payloads are byte-identical.
 *  - `channel` — DESTINATION. The consumer states WHERE it put the bytes, so
 *                "I hold them" cannot pass as "I delivered them to the place
 *                that was asked for".
 *
 * WHY IT LIVES HERE. It was written in `dispatch-broker.ts` for the blocking
 * transport and rounds 4-6 hardened it there. The group-settle drain then grew
 * its OWN acknowledgement path and reimplemented only the possession third —
 * a cross-provider review measured the consequence: `2 replay: oldReceiptAccepted=1
 * channelOmitted=true diskAcknowledged=true`, i.e. an earlier receipt
 * acknowledged a later identical bundle and no destination was required at all.
 * Two implementations of one rule is the ARCH-010 defect in a security check,
 * so the rule is hoisted into the store both paths already depend on rather
 * than copied a third time.
 *
 * `channel` is a free string (`fd1`/`fd2` on the socket transport, `composer`
 * on the rail) because the destinations are genuinely different; what matters
 * is that the sender DECLARES it and the receipt reproduces it.
 */
export function receiptDigest(nonce: string, channel: string, bytes: Buffer | string): string {
  /*
   * LENGTH-DELIMITED, NOT CONCATENATED (round 7).
   *
   * This hashed `nonce ‖ channel ‖ bytes` with no separator. The nonce is
   * fixed-width so it is unambiguous, but `channel ‖ bytes` is not: channel
   * `"a"` over payload `"bc"` and channel `"ab"` over payload `"c"` produce the
   * SAME digest. That was harmless while the only channels were `composer`,
   * `fd1` and `fd2`; round 5 made the channel a free string, and round 7 made
   * the empty string and `}` legal in it, so the ambiguity became reachable —
   * a receipt could prove possession of the right bytes on the WRONG channel,
   * which is precisely the binding this digest exists to provide.
   *
   * A third cross-provider review could only exercise the drain (its sandbox
   * blocks sockets, and the broker's channels are fixed `fd1`/`fd2`), and asked
   * that the broker path be checked here. This is what that check found: the
   * defect is in the rule both paths share, so it was never broker-specific.
   */
  const ch = Buffer.from(channel, 'utf8');
  return createHash('sha256')
    .update(nonce)
    .update(`${ch.length}:`)
    .update(ch)
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex');
}

/**
 * COMPARE a presented receipt digest against the expected one. THE one place
 * case is normalised, so two call sites cannot disagree about it.
 *
 * Measured by a cross-provider review: `uppercaseDrainAccepted:1,
 * uppercaseBrokerAccepted:false` — the drain lowercased the incoming digest and
 * the broker compared it raw, so the same uppercase receipt was valid on one
 * path and invalid on the other. Two implementations of one rule disagreeing in
 * a way neither author intended is precisely the ARCH-010 defect; the fix is
 * not to pick a behaviour but to have a single function.
 *
 * Case-insensitive, and length-checked so a prefix can never match.
 */
export function receiptMatches(expected: string | null | undefined, presented: unknown): boolean {
  if (typeof expected !== 'string' || expected.length !== 64) return false;
  if (typeof presented !== 'string' || presented.length !== 64) return false;
  return expected.toLowerCase() === presented.toLowerCase();
}

/**
 * The receipt facts, encoded into (and recovered from) a handoff evidence
 * string, so the verifier reads STRUCTURE rather than re-parsing prose.
 *
 * A regex used to pull these out, and a review found it truncated a channel at
 * the first character outside its class: `2-free-channel {"channel":
 * "composer/main","acknowledged":0,"expectedParsed":"composer"}` — a valid
 * receipt refused because the stored channel had been silently shortened.
 * Anything that can hold a `/` can hold whatever the next caller picks, so the
 * fields are JSON now and the channel is free-form by construction.
 */
export interface ReceiptFacts { sha256: string; nonce: string; channel: string }
const RECEIPT_MARK = 'receipt=';

/*
 * ROUND 7 — LENGTH-PREFIXED, BECAUSE "PARSE IT, DON'T SCAN IT".
 *
 * Round 5 moved these facts to JSON to stop a regex truncating a channel at the
 * first `/`, and the comment here claimed "JSON.parse stops at the end of the
 * object, so trailing prose is fine". That was never what the code did: it ran
 * `rest.indexOf('}')`, which is a scan, and it cuts at the first `}` ANYWHERE —
 * including one inside a JSON string. A third cross-provider review measured it:
 *
 *   2 channel "a}b" sent=1 ack=0
 *
 * `composer/main`, `a"b`, `a\nb` and `文` all survived; `a}b` did not. The
 * encoding was fixed and the DECODER was still scanning, so the class of defect
 * survived its own fix — the same shape as finding 1.
 *
 * The payload is now length-prefixed — `receipt=<chars>:<json>` — so the
 * decoder never has to guess where the JSON ends. There is no character a
 * caller can put in a channel that changes how many characters are read. A
 * legacy record written by rounds 5-6 has no prefix, so it is decoded by a
 * STRING-AWARE balanced scan rather than the naive one; that path is exactly as
 * correct for the old shape and is kept only so existing ledgers still read.
 */
export function encodeReceiptFacts(f: ReceiptFacts): string {
  const json = JSON.stringify(f);
  return `${RECEIPT_MARK}${json.length}:${json}`;
}

/** Balanced `{…}` from `src[0]`, honouring JSON string quoting. Null if unterminated. */
function balancedJsonObject(src: string): string | null {
  if (src[0] !== '{') return null;
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(0, i + 1); }
  }
  return null;
}

export function decodeReceiptFacts(evidence: string | null | undefined): ReceiptFacts | null {
  const text = String(evidence ?? '');
  const at = text.indexOf(RECEIPT_MARK);
  if (at < 0) return null;
  const rest = text.slice(at + RECEIPT_MARK.length);

  let json: string | null = null;
  const prefixed = /^(\d+):/.exec(rest);
  if (prefixed) {
    /* The authoritative form: read exactly the declared number of characters. */
    const len = Number(prefixed[1]);
    const from = prefixed[0].length;
    if (!Number.isSafeInteger(len) || len < 0 || from + len > rest.length) return null;
    json = rest.slice(from, from + len);
  } else {
    /* Legacy (rounds 5-6): no prefix. Scan, but respect string quoting. */
    json = balancedJsonObject(rest);
  }
  if (json == null) return null;

  try {
    const f = JSON.parse(json) as ReceiptFacts;
    /*
     * `typeof === 'string'`, NOT truthiness. An EMPTY channel is a legitimate
     * value a caller may choose, and the round-6 code rejected it by accident
     * (`2 channel "" sent=1 ack=0`). What matters is that the sender DECLARED
     * the field, not that the value is non-empty.
     */
    if (typeof f?.sha256 !== 'string' || typeof f?.nonce !== 'string' || typeof f?.channel !== 'string') return null;
    return f;
  } catch { return null; }
}

/** A fresh, unguessable nonce for one send. */
export function receiptNonce(): string {
  return randomBytes(16).toString('hex');
}

/** A record nothing may delete: settled work whose result has not reached anyone. */
export function isHeld(r: LaneRecord): boolean {
  return r.acknowledgedAt == null && r.dismissedAt == null;
}

export interface PruneResult {
  kept: LaneRecord[];
  droppedIds: string[];
  /** Records that were over the bound but exempt (held) and therefore kept. */
  heldOverBound: number;
}

/**
 * RULE 1, as one testable function. Oldest-first, but ONLY over records that
 * are delivered or dismissed. If the store is over its bound purely because of
 * held results, nothing is dropped and `heldOverBound` says so — the caller
 * (`capacity()`) reports honestly instead of deleting.
 */
export function prune(records: LaneRecord[], max: number = MAX_RECORDS): PruneResult {
  if (records.length <= max) return { kept: records, droppedIds: [], heldOverBound: 0 };
  const byAge = [...records].sort((a, b) => a.dispatchedAt - b.dispatchedAt);
  const drop = new Set<string>();
  let over = records.length - max;
  for (const r of byAge) {
    if (over <= 0) break;
    if (isHeld(r)) continue; // never — this is the data-loss bug the plan shipped in round 1
    drop.add(r.id);
    over--;
  }
  return {
    kept: records.filter((r) => !drop.has(r.id)),
    droppedIds: [...drop],
    heldOverBound: over > 0 ? over : 0,
  };
}

function writeAll(records: LaneRecord[]): void {
  ensureDir(dataDir());
  const { kept, droppedIds } = prune(records);
  for (const id of droppedIds) {
    try {
      fs.rmSync(laneDir(id), { recursive: true, force: true });
    } catch {
      /* the record is gone either way; a stale result file is not worth failing a write */
    }
  }
  writeAtomic(laneStoreFile(), JSON.stringify(kept, null, 2));
}

/**
 * BACKPRESSURE, not deletion. Asked before a new lane is recorded: if held
 * (settled-undelivered or still-running) records already fill the bound, the
 * honest answer is "refuse the dispatch and say why", because the alternative
 * is dropping a result somebody is still waiting for.
 */
export function capacity(): { held: number; bound: number; over: number; note: string | null } {
  const held = readAll().filter(isHeld).length;
  const over = Math.max(0, held - MAX_RECORDS);
  return {
    held,
    bound: MAX_RECORDS,
    over,
    note: over
      ? `${held} undelivered lane result(s) are being held, ${over} over the retention bound of ${MAX_RECORDS}. Nothing is deleted and recording continues; this is the number step 2's drain exists to bring down.`
      : null,
  };
}

export interface DispatchInput {
  projectId?: string | null;
  projectName?: string | null;
  parentSessionId?: string | null;
  groupId?: string | null;
  groupSize?: number | null;
  groupClosed?: boolean;
  /** STEP 2 — declared by the dispatcher (ARCH-010), defaulted to the step-1 shape. */
  groupOpen?: boolean;
  groupCloseDeadline?: number | null;
  /** `pending` materialises a declared member that has not spawned yet. */
  state?: Extract<LaneState, 'pending' | 'running'>;
  /**
   * STEP 2 — the /proc token, KNOWN BEFORE THE SPAWN.
   *
   * Step 1 wrote this in `attachProcess()` after the child existed, so a crash
   * between `recordDispatch` and `attachProcess` left `pid:null, argvToken:null`
   * — indistinguishable from "never spawned", and with nothing for the /proc
   * scan to search for. The token is the caller's own choice (the meta path it
   * is about to put on the argv), so it is knowable at birth; passing it here
   * makes a `pid:null` row recoverable instead of a dead end.
   */
  argvToken?: string | null;
  label: string;
  charter: string;
  provider: string;
  model?: string | null;
  transport: LaneTransport;
  ticket?: string | null;
  phase?: string | null;
  round?: string | null;
  laneClass?: string | null;
  at?: number;
}

/**
 * Allocate a lane id BEFORE spawning, so it can be stamped into the child's argv.
 *
 * ROUND 11 (finding 4) — REAL ENTROPY, from a CSPRNG. The old suffix was
 * `Math.random().toString(36).slice(2,8)` — at most six base36 chars, ~31 bits,
 * from a non-cryptographic PRNG. The durable seal's retention argument leaned on
 * ids being effectively unguessable and one-shot, and 31 bits of `Math.random`
 * does not carry an invariant meant to hold forever. The suffix is now 9 CSPRNG
 * bytes (72 bits, hex); the `at` prefix stays for human-readable ordering. NOTE:
 * this hardens auto-allocated ids only — a CALLER-CHOSEN id (`recordDispatch`'s
 * `id` argument, and any caller-supplied `groupId`) is the caller's to keep
 * unique; the seal invariant is not defended by unguessability (see the
 * retention note in `sealGroupDurably`).
 */
export function newLaneId(at: number = Date.now()): string {
  return `lane-${at.toString(36)}-${randomBytes(9).toString('hex')}`;
}

/**
 * Record a lane as `running`. Throws `LaneStoreError('store-full')` when the
 * ledger is at its bound with held results — the caller decides what to do with
 * a refusal, and on the step-1 blocking path it logs and lets the (unchanged)
 * dispatch proceed, because step 1 must not alter dispatch behaviour.
 */
export function recordDispatch(input: DispatchInput, id: string = newLaneId()): LaneRecord {
  assertWriter();
  const rec = recordDispatchRow(input, id);
  const all = readAll();
  /*
   * THE LEDGER IS KEYED BY `id`, SO IT MUST REFUSE A SECOND ROW FOR ONE.
   *
   * Cross-provider review, measured: `add('a'); add('a'); done('a')` produced
   * `rows=2 outstanding=1` — `settle()` found the FIRST row by `find()` and the
   * second stayed `running` forever, so the group could never become terminal
   * and its siblings' results were never drained. Every other function here
   * (`get`, `settle`, `markHandoff`, `markAcknowledged`) resolves an id with
   * `find()`, so a duplicate makes the second row permanently unreachable AND
   * permanently blocking.
   */
  if (all.some((r) => r.id === rec.id)) {
    throw new LaneStoreError('duplicate-id', `lane ${rec.id} is already in the ledger. Refusing to add a second row for one id: every lookup here resolves by id, so the duplicate would be unreachable to settle() and would hold its group open forever.`);
  }
  /*
   * A CLOSED GROUP DOES NOT ACCEPT NEW MEMBERS — that is what closing MEANS.
   *
   * Measured: a lane recorded into an already-closed, already-DELIVERED group
   * re-opened it, and the drain delivered the whole group a SECOND time
   * (`1 late-after-close: accepted; same group delivered twice`). The group
   * close is the barrier the whole one-wakeup design rests on; without this
   * check `closeGroup()` was advisory.
   *
   * `groupClosedAt` is the test rather than `groupClosed`, because `groupClosed`
   * is the birth-time DECLARATION (true for every lone lane, which must still
   * be able to record itself) while `groupClosedAt` is the lifecycle FACT.
   */
  const seal = groupSealFor(rec.groupId, all.filter((r) => r.groupId === rec.groupId));
  if (seal) {
    throw new LaneStoreError('group-closed', `lane ${rec.id} cannot join group ${rec.groupId}: ${seal.why}.${seal.kind === 'closed' ? ' Dispatch it into a new group, or re-open the group explicitly with openGroup() before recording.' : ' Dispatch it into a NEW group — a drained group cannot be re-opened, because delivering it again is the double-wakeup this design exists to prevent.'}`);
  }
  all.push(rec);
  writeAll(all);
  return rec;
}

/**
 * The row, BUILT BUT NOT WRITTEN. Split out for `openGroup()`, which
 * materialises N declared members and must land them in ONE write: N separate
 * `recordDispatch()` calls would leave the ledger observable in N-1 states
 * where the group is half-declared, and a drain reading it between two of them
 * would see a complete-looking group and fire early.
 */
function recordDispatchRow(input: DispatchInput, id: string = newLaneId()): LaneRecord {
  const at = input.at ?? Date.now();
  /*
   * NO BACKPRESSURE HERE. Round 2 threw `store-full` once held records reached
   * the bound; with no drain and no reachable `dismiss()` caller, that bricked
   * the ledger at 60 records forever — it stopped RECORDING while cheerfully
   * letting dispatches run, i.e. it produced the exact blindness this ticket
   * exists to end. The overflow is reported (`capacity()`) and acted on by the
   * drain in step 2; held results are still never deleted.
   */
  const rec: LaneRecord = {
    id,
    projectId: input.projectId ?? null,
    projectName: input.projectName ?? null,
    parentSessionId: input.parentSessionId ?? null,
    groupId: input.groupId ?? id, // a lone lane is its own group; declared, not derived
    groupSize: input.groupSize ?? 1,
    groupClosed: input.groupClosed ?? true,
    groupOpen: input.groupOpen ?? false,
    /*
     * AN OPEN GROUP ALWAYS HAS A DEADLINE — it is not optional and a caller
     * cannot forget it. Measured during step-2 verification: the broker
     * declared `groupOpen:true` and passed no deadline, and the record came
     * back `{groupOpen:true, groupCloseDeadline:null}` — a group that NOTHING
     * can ever close, because both the runtime sweep and the boot re-arm key
     * off that number. That is hazard 3 ("a group is never closed") reopened by
     * an omission at one call site. Defaulting here makes the hazard
     * unreachable by construction rather than by every caller remembering.
     */
    groupCloseDeadline: safeDeadline(input.groupCloseDeadline ?? (input.groupOpen ? at + GROUP_CLOSE_TTL_MS : null)),
    /*
     * NULL AT BIRTH, ALWAYS. `groupClosed` above is the birth-time DECLARATION
     * ("no further members are planned"); `groupClosedAt` is the LIFECYCLE fact
     * and belongs only to an explicit `closeGroup()` or a passed deadline.
     *
     * Stamping it at birth made the two indistinguishable, and the late-joiner
     * guard then refused the SECOND member of every ordinary multi-lane group —
     * the first row's own birth-close locked the group. Measured while landing
     * that guard: `lane … cannot join group g-x3: that group was closed at …`
     * for a group nobody had ever closed.
     */
    groupClosedAt: null,
    groupExtendedAt: null,
    label: input.label,
    charter: excerpt(input.charter, CHARTER_EXCERPT_MAX),
    provider: input.provider,
    model: input.model ?? null,
    transport: input.transport,
    ticket: input.ticket ?? null,
    phase: input.phase ?? null,
    round: input.round ?? null,
    laneClass: input.laneClass ?? null,
    dispatchedAt: at,
    state: input.state ?? 'running',
    settledAt: null,
    resultPointer: null,
    resultExcerpt: null,
    failureKind: null,
    usage: null,
    handoffAt: null,
    handoffBytes: null,
    handoffEvidence: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    deliveryProof: null,
    acknowledgementEvidence: null,
    heldReason: null,
    dismissedAt: null,
    generation: randomBytes(12).toString('hex'),
    starvationReleasedAt: null,
    pid: null,
    argvToken: input.argvToken ?? null, // STEP 2 — at birth, so a pid:null row is still scannable
    serverPid: process.pid,
    serverStart: procStartTime(process.pid),
    bootId: bootId(),
    reconciledAt: null,
    reconcileDetail: null,
  };
  return rec;
}

/** Attach the ground truth a later boot will re-check this claim against. */
export function attachProcess(id: string, pid: number | null, argvToken: string | null): void {
  assertWriter();
  const all = readAll();
  const rec = all.find((r) => r.id === id);
  if (!rec) throw new LaneStoreError('record-missing', `lane ${id} is not in the ledger — its dispatch record was lost between recordDispatch() and attachProcess(); this lane cannot be reconciled after a restart`);
  rec.pid = pid;
  /*
   * STEP 2 — NEVER ERASE A BIRTH TOKEN. `recordDispatch` can now stamp
   * `argvToken` before the spawn; a caller that later attaches with `null`
   * (it did not track the token, or the spawn failed) must not overwrite the
   * one piece of evidence that makes this row recoverable. Only a real token
   * replaces a real token.
   */
  if (argvToken != null) rec.argvToken = argvToken;
  writeAll(all);
}

/* ------------------------------------------------ step 2: group lifecycle */

/**
 * THE EXPORTED PATH GROUP CLOSING NEEDS.
 *
 * `writeAll()` is module-private, so before this there was literally no way for
 * any module outside this file to transition a group — the step-2 build lane
 * stopped on exactly that. These three functions are that seam, and they are
 * the ONLY way group state changes: every one of them takes the writer
 * assertion, re-reads the ledger, mutates in place and writes atomically, so a
 * group transition is never a read-modify-write across a process boundary.
 */
export interface GroupState {
  groupId: string;
  members: number;
  open: boolean;
  closeDeadline: number | null;
  closedAt: number | null;
  extendedAt: number | null;
  /** Why this group accepts no further members, or null. ONE rule (`groupSeal`). */
  sealed: string | null;
  /** WHICH seal clause fired — the only thing any consumer may branch on. */
  sealedKind: GroupSealKind | null;
  /** Members in a non-terminal state (`pending` or `running`). */
  outstanding: number;
  /** Terminal members whose result nobody has collected yet. */
  held: number;
}

/**
 * IS THIS GROUP SEALED — i.e. may it still accept members?
 *
 * ONE RULE, GOVERNING BOTH ADMISSION AND DRAIN READINESS. Round 5 had two, and
 * a second cross-provider review walked straight between them:
 *
 *   1-birth-closed {"firstAcknowledged":true,"lateMemberAccepted":true,"secondDrain":["b"]}
 *
 * A group DECLARED closed at birth (`groupClosed:true, groupOpen:false`, which
 * is every ordinary `recordDispatch`) was drainable — `groupTerminal` only asks
 * `groupOpen` — while admission asked for a close TIMESTAMP, which a birth-close
 * does not set. So the group drained, accepted another member, and drained
 * again: two wakeups for one group, which is the exact guarantee this ticket
 * exists to provide. Round 5 created that gap by making `groupClosedAt` null at
 * birth to undo its own over-reach; the over-reach and the gap are the same
 * mistake from opposite sides, and both come from asking two different
 * questions about one fact.
 *
 * The rule: a group is sealed once it has been CLOSED (explicitly or by its
 * deadline) **or once any of its results has been handed over**. The second
 * clause is what makes admission and drain readiness agree — a group that has
 * been drained is by definition no longer accepting members, whatever its
 * declaration says. An ordinary multi-member group that nobody has drained yet
 * is NOT sealed, so the normal build-up path is untouched.
 *
 * ROUND 7 — ONE RULE MEANS ALL THREE CONSUMERS ASK IT, NOT JUST ADMISSION.
 *
 * A third cross-provider review measured this and was right about the shape:
 *
 *   1 seal   {"sent":1,"sealed":true,"open":true,"terminal":false,"lateRefused":true}
 *   1 bypass members=2 sealed=true
 *
 * `groupSeal` existed and admission consulted it — but `open` was still
 * `rows.some(r => r.groupOpen)`, and `openGroup({members})` pushed rows through
 * `recordDispatchRow` directly, skipping the admission check and clearing
 * `groupClosedAt` on the way. So a sealed group reported itself OPEN, and could
 * be given new members by the one API that never asked. Admission, readiness
 * and reopening were three rules wearing one name.
 *
 * The reviewer's framing is the fix: *"that is the third round this defect has
 * moved rather than closed — fix the shape, not the site."* Rounds 5 and 6 each
 * fixed the site they were shown. So the rule now returns a KIND as well as a
 * reason, and every consumer derives its behaviour from that one value:
 *
 *   admission   (`recordDispatch`)  — refuses on ANY seal.
 *   readiness   (`summarise.open`)  — a sealed group is NOT open, by definition.
 *   reopening   (`openGroup`)       — refuses on a DRAINED seal; a CLOSED seal
 *                                     is the advertised deliberate re-open.
 *
 * The kind distinction is the only policy difference and it is stated once,
 * here: re-opening a group that was merely closed is a supported operation (the
 * admission error names `openGroup` as the way to do it), whereas re-opening a
 * group whose results have already been HANDED OVER would deliver it a second
 * time, which is the guarantee this whole ticket exists to provide.
 *
 * Returns `{kind, why}`, or `null` when the group still accepts members.
 */
export type GroupSealKind = 'closed' | 'drained';
export interface GroupSealState { kind: GroupSealKind; why: string }

export function groupSeal(rows: LaneRecord[]): GroupSealState | null {
  /*
   * ROUND 8 — A LATTICE WHERE THE TERMINAL STATE IS ABSORBING.
   *
   * Round 7 checked `closed` FIRST, so once a delivered group was also closed,
   * the seal reported `closed` and the `drained` fact was MASKED — a fourth
   * cross-provider review walked straight through it:
   *
   *   1 closed+drained seal=closed reopen=accepted secondDrain=1
   *
   * `openGroup` refuses only a `drained` seal (a `closed` one is the advertised
   * re-open), so a group that was drained, ACKNOWLEDGED, and then closed reported
   * `closed` and was re-opened — delivering an acknowledged group a SECOND time,
   * the exact wakeup this ticket exists to prevent. Closing must never be able to
   * overwrite delivery. So the DELIVERED state (a member handed over or
   * acknowledged) is checked FIRST and absorbs `closed`: a group that has begun
   * delivery is `drained` whatever else is also true of it.
   */
  const drained = rows.find((r) => r.handoffAt != null || r.acknowledgedAt != null);
  if (drained) {
    const at = drained.handoffAt ?? drained.acknowledgedAt!;
    return { kind: 'drained', why: `that group has already been drained (lane ${drained.id} was handed over at ${new Date(at).toISOString()}), so admitting a member now would deliver the group a SECOND time` };
  }
  const closed = rows.find((r) => r.groupClosedAt != null);
  if (closed) {
    return { kind: 'closed', why: `that group was closed at ${new Date(closed.groupClosedAt!).toISOString()} and a closed group accepts no further members` };
  }
  return null;
}

interface DurableSeal { at: number; kind: GroupSealKind; why: string }

/**
 * ROUND 10 (finding 2) — ABSENT ≠ UNREADABLE, and unreadable FAILS CLOSED.
 *
 * This caught EVERY error and returned `{}`, so an empty, truncated, invalid,
 * unreadable, or wrong-shaped seal file read as "no group is sealed" and permitted
 * re-delivery — a durability mechanism whose failure mode is to allow the exact
 * thing it exists to prevent. Now: a genuinely ABSENT file (`ENOENT`) is a fresh
 * system and returns `{}`; anything else — a read error, non-JSON, or a shape that
 * is not a `{groupId: seal}` object — THROWS, and every caller treats that as
 * "cannot prove this group is unsealed", refusing rather than delivering twice.
 */
function readDurableSeals(): Record<string, DurableSeal> {
  let raw: string;
  try {
    raw = fs.readFileSync(groupSealFile(), 'utf8');
  } catch (e) {
    if ((e as { code?: string } | null)?.code === 'ENOENT') return {}; // absent — legitimately new
    throw new LaneStoreError('seal-unreadable', `the durable group-seal store at ${groupSealFile()} could not be read (${(e as Error).message}); refusing to treat it as empty, because that would permit re-delivering a sealed group`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new LaneStoreError('seal-unreadable', `the durable group-seal store at ${groupSealFile()} is not valid JSON (${JSON.stringify(raw.slice(0, 40))}); refusing to treat it as empty`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LaneStoreError('seal-unreadable', `the durable group-seal store at ${groupSealFile()} is not a {groupId: seal} object (got ${Array.isArray(parsed) ? 'an array' : typeof parsed}); refusing to treat it as empty`);
  }
  return parsed as Record<string, DurableSeal>;
}

/**
 * ROUND 9 (finding 1) — record that a group has BEGUN DELIVERY, durably, the
 * first time it happens. Idempotent (first write wins), and stored outside the
 * prunable ledger so the seal survives the deletion of every row it names. Called
 * from the handoff writers, because handover is the moment a group's identity
 * becomes un-reusable: delivering it again — to a late joiner, or to a reborn
 * group with the same id — is the double-wakeup this ticket exists to prevent.
 */
export const MAX_DURABLE_SEALS = 50_000;

export function sealGroupDurably(groupId: string, kind: GroupSealKind, why: string, at: number = Date.now()): void {
  assertWriter();
  const seals = readDurableSeals();
  if (seals[groupId]) return; // a group's first seal is the true one; delivery only strengthens
  seals[groupId] = { at, kind, why };
  /*
   * ROUND 10/11 — BOUNDED, with an HONEST durability limit. The seal store grew
   * one entry per group ever; it is capped at `MAX_DURABLE_SEALS`, dropping the
   * OLDEST (by seal time) once the cap is exceeded, and NEVER the entry just
   * written (finding 4). What this costs, stated without leaning on entropy: the
   * invariant "a group that has begun delivery is sealed forever" holds for the
   * `MAX_DURABLE_SEALS` most-recently-sealed groups; a group sealed longer ago
   * than that ages out, and if its exact id were then reused it could deliver
   * again. This is NOT defended by unguessability — round 11 gives auto-allocated
   * ids real CSPRNG entropy, but caller-chosen ids are predictable — it is
   * defended by RECENCY: at 50k retained, an aged-out seal is astronomically past
   * any live group, and reuse of a specific 50k-old id is a caller error, not a
   * race this store can or should prevent. The bound is a deliberate, named limit.
   */
  /*
   * ROUND 11 (finding 4) — NEVER EVICT THE SEAL WE JUST WROTE.
   *
   * The eviction dropped the OLDEST by `at`; with a clock rollback (or a caller
   * passing a small `at`) the seal being written IS the oldest, so it was
   * evicted the instant it was created — `50000 boundary + clock rollback: newly
   * sealed group immediately evicted`, i.e. the store silently un-sealed the
   * group it was told to seal. The just-written `groupId` is excluded from the
   * eviction candidates: a fresh seal is always retained, and only genuinely
   * older records are dropped to hold the bound.
   */
  const ids = Object.keys(seals).filter((id) => id !== groupId);
  if (ids.length + 1 > MAX_DURABLE_SEALS) {
    const oldest = ids.sort((a, b) => (isDurableSeal(seals[a]) ? seals[a].at : 0) - (isDurableSeal(seals[b]) ? seals[b].at : 0)).slice(0, ids.length + 1 - MAX_DURABLE_SEALS);
    for (const id of oldest) delete seals[id];
  }
  ensureDir(dataDir());
  writeAtomic(groupSealFile(), JSON.stringify(seals, null, 2));
}

/** The durable seal for a group, or null. Independent of whether any row survives. */
export function durableGroupSeal(groupId: string): GroupSealState | null {
  let seals: Record<string, DurableSeal>;
  try {
    seals = readDurableSeals();
  } catch (e) {
    /*
     * ROUND 10 (finding 2) — FAIL CLOSED. An unreadable/invalid seal store means
     * we cannot prove this group was NOT already delivered, so it is treated as
     * sealed rather than admitting a member and risking a second delivery. Loud
     * and safe: dispatch is refused until the store is readable again.
     */
    return { kind: 'drained', why: `${(e as Error).message} — failing closed: every group is treated as already delivered until the seal store is readable again` };
  }
  /*
   * ROUND 11 (finding 3) — VALIDATE THE ENTRY, DO NOT TRUST ITS TRUTHINESS.
   *
   * Round 10 validated the FILE's shape (a `{groupId: seal}` object) but not each
   * ENTRY's, so `{"g":false}` — a groupId present but mapped to a non-seal — read
   * as "not sealed" (`false` is falsy) and admitted a late member: the seventh
   * review's `malformed entry false: late admission accepted`. A groupId that is
   * PRESENT in the seal store but whose value is not a well-formed `{at:number,
   * kind, why:string}` is not "unsealed"; it is a corrupt seal record, and the
   * only safe reading of a corrupt seal is FAIL CLOSED — treat the group as
   * already delivered rather than admitting a member on garbage.
   */
  if (!(groupId in seals)) return null;      // no entry — legitimately admissible
  const s = seals[groupId];
  if (!isDurableSeal(s)) {
    return { kind: 'drained', why: `the durable seal for group ${JSON.stringify(groupId)} is malformed (${JSON.stringify(s)}); failing closed and treating the group as already delivered — a corrupt seal record cannot prove a group is unsealed` };
  }
  return { kind: s.kind, why: `${s.why} (this group began delivery at ${new Date(s.at).toISOString()}; the fact is stored durably and outlives its rows)` };
}

/** A stored seal entry is only usable if it carries all three fields with the
 * right types and a recognised kind — anything else is corruption (finding 3). */
function isDurableSeal(s: unknown): s is DurableSeal {
  return !!s && typeof s === 'object' && !Array.isArray(s)
    && typeof (s as DurableSeal).at === 'number' && Number.isFinite((s as DurableSeal).at)
    && ((s as DurableSeal).kind === 'closed' || (s as DurableSeal).kind === 'drained')
    && typeof (s as DurableSeal).why === 'string';
}

/**
 * THE seal every caller must consult — durable first, then live rows. The durable
 * record answers even when pruning has removed the rows the live check reads, so
 * admission, re-open and readiness cannot disagree about a group whose evidence
 * has been retained away.
 */
export function groupSealFor(groupId: string, rows: LaneRecord[]): GroupSealState | null {
  return durableGroupSeal(groupId) ?? groupSeal(rows);
}

function groupRows(all: LaneRecord[], groupId: string): LaneRecord[] {
  return all.filter((r) => r.groupId === groupId);
}

function summarise(groupId: string, rows: LaneRecord[]): GroupState {
  const head = rows[0];
  const seal = groupSealFor(groupId, rows);
  return {
    groupId,
    members: rows.length,
    /*
     * READINESS ASKS THE SEAL. `open` means "more members may still be
     * dispatched into this group" — which is precisely what a seal denies. It
     * used to read only the `groupOpen` flag, so a group that admission would
     * refuse still advertised itself as open and the drain still treated it as
     * filling (`sealed:true, open:true` in the reviewer's output). Two answers
     * to one question is the ARCH-010 defect; there is now one.
     */
    open: rows.some((r) => r.groupOpen) && !seal,
    closeDeadline: head?.groupCloseDeadline ?? null,
    closedAt: head?.groupClosedAt ?? null,
    sealed: seal?.why ?? null,
    sealedKind: seal?.kind ?? null,
    extendedAt: head?.groupExtendedAt ?? null,
    /*
     * A DISMISSED MEMBER IS NOT SOMETHING TO WAIT FOR.
     *
     * Measured: dismissing the last RUNNING member left `outstanding=1
     * terminal=false` FOREVER — nothing will ever settle a row the user has
     * discarded, so the group hung and every sibling's result stayed
     * undeliverable. Dismissing is the user saying "I do not want this
     * result"; the child may still be running, but no one is waiting on it, so
     * it cannot be allowed to hold the barrier shut.
     */
    outstanding: rows.filter((r) => (r.state === 'pending' || r.state === 'running') && r.dismissedAt == null).length,
    held: rows.filter((r) => isHeld(r) && r.state !== 'pending' && r.state !== 'running').length,
  };
}

/** Read-only view of a group. Never throws on an unknown group — it is empty. */
export function groupState(groupId: string): GroupState {
  return summarise(groupId, groupRows(readAll(), groupId));
}

/**
 * Open a group (or re-open the close window on one), with a PERSISTED deadline.
 *
 * The deadline is absolute-ms on the record rather than a `setTimeout`, so a
 * restart re-arms from the file. `members` materialises declared-but-unspawned
 * rows as `pending` in the same write, which is what stops a member that never
 * spawns from being invisible to the drain.
 */
export function openGroup(
  groupId: string,
  opts: { closeDeadline?: number | null; ttlMs?: number | null; members?: DispatchInput[]; now?: number } = {},
): GroupState {
  assertWriter();
  const now = opts.now ?? Date.now();
  const deadline = safeDeadline(opts.closeDeadline ?? (opts.ttlMs != null ? now + opts.ttlMs : now + GROUP_CLOSE_TTL_MS));
  const all = readAll();
  /*
   * REOPENING ASKS THE SEAL TOO — BEFORE any member is materialised.
   *
   * This function used to push `members` straight through
   * `recordDispatchRow`, which is the raw row builder and not the admission
   * path, and then unconditionally clear `groupClosedAt`. So the one API that
   * could resurrect a group was the one API that never asked whether it was
   * allowed to: `1 bypass members=2 sealed=true`.
   *
   * A CLOSED seal may be re-opened — that is this function's advertised job,
   * and the admission error points here to do it. A DRAINED seal may not:
   * results have already been handed over, and re-opening would deliver the
   * group a second time. The kind is the only thing branched on, and it comes
   * from `groupSeal`, so this cannot drift from what admission and readiness
   * believe.
   */
  const priorSeal = groupSealFor(groupId, groupRows(all, groupId));
  if (priorSeal?.kind === 'drained') {
    throw new LaneStoreError('group-closed', `openGroup(${groupId}) refused: ${priorSeal.why}. Re-opening it would deliver the group a SECOND time, which is the exact wakeup this design exists to prevent — dispatch the new work into a NEW group.`);
  }
  for (const m of opts.members ?? []) {
    const rec = recordDispatchRow({ ...m, groupId, groupOpen: true, groupCloseDeadline: deadline, state: m.state ?? 'pending', at: m.at ?? now });
    all.push(rec);
  }
  const rows = groupRows(all, groupId);
  if (!rows.length) {
    throw new LaneStoreError('record-missing', `openGroup(${groupId}) has no members — a group is declared by its members (ARCH-010); pass {members:[…]} or record them first, because an empty open group can never close and would hold a drain forever`);
  }
  for (const r of rows) {
    r.groupOpen = true;
    r.groupClosed = false;
    r.groupClosedAt = null;
    if (r.groupCloseDeadline !== deadline) r.groupExtendedAt = r.groupCloseDeadline == null ? null : now;
    r.groupCloseDeadline = deadline;
    r.groupSize = rows.length;
  }
  writeAll(all);
  return summarise(groupId, rows);
}

/**
 * Close a group: no further members. This is what ARMS the drain — until it
 * happens, a group with every member terminal is still not drainable, because
 * another member may be seconds from being dispatched into it.
 *
 * `reason` is recorded so a group closed by its deadline is distinguishable
 * from one the dispatcher closed deliberately.
 */
export function closeGroup(groupId: string, reason: string = 'closed by the dispatcher', now: number = Date.now()): GroupState {
  assertWriter();
  const all = readAll();
  const rows = groupRows(all, groupId);
  if (!rows.length) throw new LaneStoreError('record-missing', `closeGroup(${groupId}) — no such group in the ledger`);
  for (const r of rows) {
    if (!r.groupOpen && r.groupClosedAt != null) continue; // idempotent: already closed, keep the first close
    r.groupOpen = false;
    r.groupClosed = true;
    r.groupClosedAt = now;
    r.groupSize = rows.length;
    /*
     * A member still `pending` when the group closes NEVER SPAWNED. It is cut
     * with a named reason rather than left to freeze the group: the drain waits
     * on non-terminal members, so a row that can no longer start must become
     * terminal or nothing in this group is ever delivered.
     */
    if (r.state === 'pending') {
      r.state = 'cut';
      r.settledAt = now;
      r.failureKind = 'never-spawned';
      r.heldReason = `the group was closed (${reason}) while this declared member had not spawned — it has no result and never will`;
    }
  }
  writeAll(all);
  return summarise(groupId, rows);
}

/** Push a group's close deadline out, recording that it happened. */
export function extendGroup(groupId: string, ttlMs: number, now: number = Date.now()): GroupState {
  assertWriter();
  const all = readAll();
  const rows = groupRows(all, groupId);
  if (!rows.length) throw new LaneStoreError('record-missing', `extendGroup(${groupId}) — no such group in the ledger`);
  for (const r of rows) {
    if (!r.groupOpen) continue;
    r.groupCloseDeadline = safeDeadline(now + ttlMs);
    r.groupExtendedAt = now;
  }
  writeAll(all);
  return summarise(groupId, rows);
}

/**
 * ROUND 9 (finding 4) — STAMP starvation-readiness the first time it is reached,
 * so it is MONOTONIC. A held, terminal result whose siblings are still in flight
 * is RELEASED to the rail on its own once it has waited past `HELD_STARVATION_MS`;
 * that release used to be recomputed from the clock on every poll, so a clock
 * rollback un-readied it. This records the release once; `pending()` then reads
 * the stamp and readiness never regresses. Idempotent, and safe to call on every
 * poll (already-released and not-yet-starved rows are skipped).
 */
export function releaseStarved(now: number = Date.now()): { released: string[] } {
  assertWriter();
  const all = readAll();
  const released: string[] = [];
  for (const r of all) {
    if (r.starvationReleasedAt != null) continue;
    if (r.acknowledgedAt != null || r.dismissedAt != null) continue; // delivered/discarded — not held
    if (r.state === 'pending' || r.state === 'running') continue;    // not terminal — nothing to release
    const waited = now - (r.settledAt ?? r.dispatchedAt);
    if (waited >= HELD_STARVATION_MS) { r.starvationReleasedAt = now; released.push(r.id); }
  }
  if (released.length) writeAll(all);
  return { released };
}

/**
 * A declared member is really starting: `pending` → `running`, with the pid and
 * the token. Distinct from `attachProcess` because it is also a STATE change,
 * and doing it in one write means no reader ever sees a running row with no pid.
 */
export function promotePending(id: string, pid: number | null, argvToken: string | null, now: number = Date.now()): LaneRecord {
  assertWriter();
  const all = readAll();
  const rec = all.find((r) => r.id === id);
  if (!rec) throw new LaneStoreError('record-missing', `promotePending(${id}) — not in the ledger`);
  if (rec.state !== 'pending') {
    throw new LaneStoreError('conflict', `promotePending(${id}) — this lane is '${rec.state}', not 'pending'. Refusing: re-running a terminal lane's row would erase a settled result, and re-promoting a running one would hide a double spawn`);
  }
  rec.state = 'running';
  rec.pid = pid;
  if (argvToken != null) rec.argvToken = argvToken;
  rec.dispatchedAt = now;
  clearHeldReason(rec); // a lane that is starting is not a lane being held
  writeAll(all);
  return rec;
}

export interface SettleInput {
  state: Exclude<LaneState, 'running'>;
  resultText?: string | null;
  failureKind?: string | null;
  usage?: LaneUsage | null;
  at?: number;
  /*
   * NOTE: settling NEVER stamps delivery. A settled lane is HELD until
   * `markAcknowledged()` receives evidence — see rule 2 in the header.
   */
}

/**
 * Settle a lane: check the record EXISTS, then write the result file (it is the
 * authority), then update the record — all under one lock.
 *
 * ROUND 2, two changes, both from the same reproduced failure. Round 1 wrote
 * the result file FIRST and then RETURNED NULL if the record had vanished, so a
 * concurrent writer's lost update produced result files on disk that no record
 * named (13 of them, measured) and the caller's `try/catch` never fired: a
 * silent loss of exactly the artefact this ledger exists to protect. Now a
 * missing record THROWS `record-missing`, and nothing is written to disk for a
 * record that is not there.
 */
export function settle(id: string, input: SettleInput): LaneRecord {
  assertWriter();
  const at = input.at ?? Date.now();
  const all = readAll();
  const rec = all.find((r) => r.id === id);
  if (!rec) {
    throw new LaneStoreError(
      'record-missing',
      `lane ${id} settled but its ledger record is GONE — the result was NOT written to disk under this id and would have been unreachable. Nothing was recorded; the caller still holds the only copy.`,
    );
  }
  if (rec.state !== 'running') return rec; // first settlement wins; never re-open a settled lane
  let pointer: string | null = null;
  if (input.resultText != null) {
    const dir = laneDir(id);
    ensureDir(dir);
    const file = path.join(dir, 'result.txt');
    writeAtomic(file, input.resultText);
    pointer = file;
  }
  rec.state = input.state;
  rec.settledAt = at;
  rec.resultPointer = pointer;
  rec.resultExcerpt = input.resultText == null ? null : excerpt(input.resultText, RESULT_EXCERPT_MAX);
  rec.failureKind = input.failureKind ?? null;
  rec.usage = input.usage ?? null;
  // A reason recorded while it was RUNNING does not survive into its terminal
  // state; whatever holds it now is decided by the delivery rule, not by then.
  clearHeldReason(rec);
  writeAll(all);
  return rec;
}

/**
 * Record ORCHARD'S OWN half of the story: the result was written out and the
 * write completed. Separate from `markAcknowledged()` on purpose — this one needs
 * no cooperation from anybody, so it is the fact that is always available, and
 * it is the honest weaker claim when no consumer ever proves possession.
 *
 * It grants nothing: a handed-off record with no delivery proof is still HELD,
 * still prune-exempt, still pullable. It exists so a surface can say "we sent
 * this and nobody ever confirmed holding it" instead of guessing.
 */
export function markHandoff(id: string, bytes: number, evidence: string): LaneRecord | null {
  assertWriter();
  const all = readAll();
  const rec = all.find((r) => r.id === id);
  if (!rec) throw new LaneStoreError('record-missing', `lane ${id} cannot record a handoff: it is not in the ledger`);
  if (rec.handoffAt != null) return rec; // first handoff wins; a retry is not a second send
  rec.handoffAt = Date.now();
  rec.handoffBytes = bytes;
  rec.handoffEvidence = evidence;
  // ROUND 9 (finding 1): the group has begun delivery — seal it DURABLY, so the
  // fact outlives this row being pruned and the groupId being reused.
  sealGroupDurably(rec.groupId, 'drained', `that group has already been drained (lane ${rec.id} was handed over)`, rec.handoffAt);
  /* heldReason is DELIBERATELY untouched here — see the lifecycle comment on
   * `clearHeldReason`. A handoff grants nothing, so the record is still held and
   * its stated reason is still current; and in the no-ack path the "earlier"
   * reason is in fact the verdict about this very send, written synchronously
   * before this write callback fires. */
  writeAll(all);
  return rec;
}

/**
 * Stamp a lane as delivered — the ONLY place `acknowledgedAt` is ever set.
 *
 * ROUND 4 — what this now means, exactly, so no reader has to infer it:
 * Orchard's own write of the whole result completed, AND the consumer returned a
 * proof of possession of those exact bytes (a digest over a per-lane nonce it
 * could not compute without holding them). It does NOT mean, and cannot mean,
 * that the text entered the parent's context: only the consumer can observe that
 * step, and a consumer's unverifiable self-report has now been broken four times
 * running. That limit is recorded rather than dressed up.
 *
 * Separated from `settle()` deliberately. Round 2 settled and stamped in one
 * call, which forced the settlement to wait for the delivery verdict: a 3 MB
 * result whose peer took 4 s to write it out missed the 2 s confirm window and
 * the record was still `running` in the meantime — a state the record knew to
 * be false. Now settlement is written the moment the child exits (truthful, and
 * HELD), and delivery lands later if and only if evidence arrives.
 *
 * `evidence` is stored verbatim so the stamp can be audited after the fact: on
 * this transport it is the byte count the sender wrote and the byte count the
 * receiver reported writing to its own stdout.
 */
/**
 * Record WHY the receipt rule refused to acknowledge this lane. Never overwrites
 * an acknowledgement (a refusal after a successful stamp is not a thing), and
 * best-effort at the caller: a ledger that cannot record the reason must never
 * fail a dispatch.
 */
/**
 * RE-SEND. Keeps the FIRST `handoffAt` and replaces what was sent.
 *
 * Why this has to exist, measured: `markHandoff()` is first-handoff-wins and
 * keeps the original bytes/evidence, while the drain computes its expected
 * digest over the CURRENT selection. So a lane first handed over inside a
 * 2-lane bundle and later re-offered on its own could never be acknowledged
 * again — no honest receipt could reproduce the stored digest. Reproduced:
 * three retries, `{"acknowledged":0,"refused":2}` each time, and the rail item
 * was clearable only by DISCARDING the result. That is a permanent loss of
 * reachability for the one artefact this whole ledger exists to protect, and it
 * broke the "re-offered, not lost" contract the drain advertises.
 *
 * `handoffAt` deliberately does NOT move: it is "when did Orchard first hand
 * this over", which is a fact and stays one. The bytes and the evidence DO move,
 * because they describe the send a receipt will be checked against, and the
 * only send that can still be acknowledged is the most recent one. Nothing is
 * lost by overwriting: a previous send that is being re-offered is by definition
 * a send that reached nobody.
 *
 * Refuses on an ALREADY-ACKNOWLEDGED record: re-sending a collected result
 * would invalidate the proof that collected it.
 */
export function restampHandoff(id: string, bytes: number, evidence: string, expectGeneration?: string): LaneRecord {
  assertWriter();
  const all = readAll();
  const rec = all.find((r) => r.id === id);
  if (!rec) throw new LaneStoreError('record-missing', `lane ${id} cannot re-record a handoff: it is not in the ledger`);
  /*
   * ROUND 9 (finding 3): the drain read a specific RECORD to build the bundle and
   * passes that record's immutable generation here. If the row on disk no longer
   * carries it, the ledger was swapped underneath the drain (the id was reused for
   * a different dispatch), and stamping now would acknowledge a result the bundle
   * never contained — refuse, so the drain skips this lane rather than delivering
   * the wrong one.
   */
  if (expectGeneration != null && rec.generation !== expectGeneration) {
    throw new LaneStoreError('conflict', `lane ${id} was re-created underneath this drain (generation ${expectGeneration} → ${rec.generation}); the bundle was built from a record that no longer exists, so this will not stamp a handoff that would acknowledge a different, unseen result`);
  }
  if (rec.acknowledgedAt != null) {
    throw new LaneStoreError('already-acknowledged', `lane ${id} was already acknowledged at ${rec.acknowledgedAt}; re-stamping its handoff would invalidate the receipt that collected it`);
  }
  if (rec.handoffAt == null) rec.handoffAt = Date.now(); // first send after all
  rec.handoffBytes = bytes;
  rec.handoffEvidence = evidence;
  // ROUND 9 (finding 1): delivery has begun — durable seal, outliving the rows.
  sealGroupDurably(rec.groupId, 'drained', `that group has already been drained (lane ${rec.id} was handed over)`, rec.handoffAt);
  // The old reason names an expected digest that is no longer expected.
  clearHeldReason(rec);
  writeAll(all);
  return rec;
}

/**
 * THE `heldReason` LIFECYCLE, IN ONE PLACE.
 *
 * INVARIANT: `heldReason` may be non-null only while the record is genuinely
 * held AND the reason still describes its CURRENT state.
 *
 * WHY, ACCURATELY (this comment used to overstate it, and a verifier was right
 * to check): it is INTENDED as the string a rail renders at a user, but nothing
 * renders it today — `lane-drain.pending()` builds its own `reason` and
 * `public/app.js` never reads this field. So the present cost of a stale value
 * is NOT a lie shown to a user; it is TEST VACUITY. `verify-lane-ledger.mjs`'s
 * `heldBecause()` gate asserts on this field, so a reason that outlives the
 * condition it describes can make a future refusal assertion pass with no
 * refusal having happened. That is reason enough to keep the invariant tight,
 * and the honest justification to record for whoever surfaces it later.
 *
 * Round 7 fixed this for `markAcknowledged` alone ("THE REASON A RESULT IS HELD
 * DIES WHEN IT STOPS BEING HELD"). An independent verifier then found
 * `restampHandoff` had the same gap, and asked whether any OTHER writer did.
 * The audit found FOUR more, so the rule is a function every one of them calls
 * rather than a line each of them has to remember:
 *
 *   - `dismiss()`        — `dismissedAt` makes `isHeld()` false. EXACTLY the
 *                          markAcknowledged case, missed in the same way.
 *   - `restampHandoff()` — the reason names an expected digest that is no longer
 *                          expected (the reported defect).
 *   - `promotePending()` — a lane that is starting is not a lane being held.
 *   - `settle()`         — a reason recorded while it was running does not
 *                          survive into its terminal state.
 *
 * WHY IT MATTERS BEYOND TIDINESS: `verify-lane-ledger.mjs`'s `heldBecause()`
 * gate asserts `rec.heldReason.includes(frag)` and only guards against an
 * ACKNOWLEDGED record. A stale reason surviving one of the writers above could
 * therefore satisfy a future refusal assertion with no refusal having happened —
 * a vacuity hazard planted in the ledger by the writers themselves.
 * `regressed-from:` the round-7 finding-1a fix, which fixed one call site
 * instead of the rule.
 *
 * AND THE WRITER THAT DELIBERATELY IS *NOT* ON THAT LIST — `markHandoff()`.
 * Round 8 put it there on the reasoning "a fresh send makes any earlier refusal
 * reason stale". That reasoning is wrong twice over, and it broke D4 in
 * `verify-lane-ledger.mjs` the moment it landed:
 *
 *  1. A HANDOFF RESOLVES NOTHING. Every other writer above either ends the
 *     record's heldness (`dismiss`, `markAcknowledged`), restarts it
 *     (`promotePending`), moves it to a terminal state decided afresh
 *     (`settle`, `reconcile`), or changes the bytes a receipt is checked
 *     against (`restampHandoff`). `markHandoff` does none of these: its own
 *     doc-comment says "it grants nothing — a handed-off record with no
 *     delivery proof is still HELD". The reason therefore still describes the
 *     record's CURRENT state, which is the exact condition the invariant above
 *     tests. Clearing it leaves a held record with no explanation — the round-7
 *     finding-1b failure, reintroduced from the other end.
 *  2. "EARLIER" IS NOT EVEN TRUE ON THE WIRE. In the no-ack path
 *     (`dispatch-broker.ts terminal()`), `socket.end(line, cb)` is called and
 *     then `onOutcome(false, 'the peer did not request a delivery receipt …')`
 *     runs SYNCHRONOUSLY, while `cb` — which is what calls `markHandoff` —
 *     fires later on the write callback. So the reason markHandoff wiped was
 *     not a stale one from a previous cycle; it was the receipt rule's verdict
 *     about THIS very send, recorded microseconds before. Measured: D4 went
 *     "VACUOUS: this lane is held but the receipt rule recorded NO refusal
 *     reason", 62 PASS / 1 FAIL.
 *
 * The receipt rule owns this string (`markHeldReason` / `markAcknowledged`).
 * `markHandoff` records Orchard's own half of the fact and touches nothing else.
 */
function clearHeldReason(rec: LaneRecord): void {
  rec.heldReason = null;
}

export function markHeldReason(id: string, why: string): LaneRecord | null {
  assertWriter();
  const all = readAll();
  const rec = all.find((r) => r.id === id);
  if (!rec) throw new LaneStoreError('record-missing', `lane ${id} cannot record a held reason: it is not in the ledger`);
  /*
   * THE WRITE SIDE NEEDS THE SAME STATE GUARD THE CLEARERS HAVE.
   *
   * Round 3 fixed every writer that INVALIDATES a reason and left the one that
   * CREATES them guarded only on `acknowledgedAt`, so a "why it is held" string
   * could be stamped onto a record that is not held at all. Reproduced against
   * the real store by a verifier:
   *
   *   after a dismiss then a refused ack : {"held":false,"dismissedAt":true,
   *                                         "heldReason":"the acknowledgement did not prove…"}
   *   an ack for a RUNNING lane          : {"state":"running",
   *                                         "heldReason":"Orchard has no record of sending…"}
   *
   * Both are reachable from `POST /api/lanes/ack`, which takes arbitrary lane
   * ids: dismiss-racing-a-drain, or an ack naming a lane that is still running.
   * A record in either state is refused here rather than being given a sentence
   * that contradicts it.
   *
   * SEVERITY, HONESTLY: `heldReason` has no consumer outside the verify suites
   * today (nothing in `lane-drain.pending()` or `public/app.js` reads it), so
   * this is not currently a user-visible lie. Its real cost is test vacuity —
   * `verify-lane-ledger.mjs`'s `heldBecause()` gate asserts on this field, so a
   * reason planted on a not-held record could satisfy a refusal assertion with
   * no refusal having happened. Returning `rec` unchanged (rather than throwing)
   * keeps every caller's best-effort contract intact.
   */
  if (rec.acknowledgedAt != null) return rec;
  if (rec.dismissedAt != null) return rec;   // discarded: not held, so nothing to explain
  if (rec.state === 'running' || rec.state === 'pending') return rec; // not finished: not held yet
  rec.heldReason = why;
  writeAll(all);
  return rec;
}

export function markAcknowledged(id: string, by: LaneAcknowledgedBy, evidence: string, proof: string | null = null): LaneRecord | null {
  assertWriter();
  const all = readAll();
  const rec = all.find((r) => r.id === id);
  if (!rec) throw new LaneStoreError('record-missing', `lane ${id} cannot be acknowledged: it is not in the ledger`);
  if (rec.acknowledgedAt != null) return rec; // first stamp wins; a repeated ack is a no-op
  /*
   * ROUND 6 defect 2 — THE INVARIANT IS ENFORCED WHERE IT IS WRITTEN, not where
   * it is documented. The design has said since round 5 that an acknowledgement
   * cannot exist without Orchard's own handoff behind it; the broker's handoff
   * stamp, however, is best-effort (`stampHandoff` logs and returns), so a
   * failed handoff write left the acknowledgement to land anyway. Measured ON
   * DISK, which is the only place it showed:
   *   disk after failed handoff {"acknowledged":true,"handoff":null}
   * A guard in the caller would have been one more thing to remember; the store
   * refuses instead, so there is no route to the incoherent record. The caller
   * then logs a failed stamp and the record stays HELD — which is the correct
   * outcome: a duplicate acknowledgement later is a nuisance, a result recorded
   * as collected when Orchard never even wrote it is the data-loss case.
   */
  if (rec.handoffAt == null) {
    throw new LaneStoreError(
      'handoff-missing',
      `lane ${id} cannot be acknowledged: Orchard has no record of handing this result over (handoffAt is null). An acknowledgement is the consumer's half of a two-part fact and the sender's half must exist first — otherwise the ledger would claim a consumer confirmed holding bytes this process has no record of sending. The record stays HELD and the result stays pullable.`,
    );
  }
  rec.acknowledgedAt = Date.now();
  rec.acknowledgedBy = by;
  rec.deliveryProof = proof;
  rec.acknowledgementEvidence = evidence;
  /*
   * ROUND 7 finding 1a — THE REASON A RESULT IS HELD DIES WHEN IT STOPS BEING
   * HELD. Measured before this line, on disk:
   *   {"acknowledged":true,"heldReason":"old refusal: …NO possession proof"}
   * A record that is acknowledged is not held, so a "why it is held" string on
   * it is not merely untidy — it is false, and it is the kind of falsehood a
   * rail renders straight at a user ("waiting because the peer sent no proof")
   * about a result that was collected. One fact, one state: the field exists
   * only while the condition it describes does.
   */
  rec.heldReason = null;
  writeAll(all);
  return rec;
}

export interface LaneQuery {
  projectId?: string | null;
  groupId?: string | null;
  state?: LaneState;
  /** Only settled-undelivered-undismissed records — the "Orchard is holding this" set. */
  heldOnly?: boolean;
  limit?: number;
}

/** Newest first. */
export function list(q: LaneQuery = {}): LaneRecord[] {
  const out = readAll().filter((r) => {
    if (q.projectId && r.projectId !== q.projectId) return false;
    if (q.groupId && r.groupId !== q.groupId) return false;
    if (q.state && r.state !== q.state) return false;
    // STEP 2: `pending` joins `running` as a non-terminal state. A declared
    // member that has not spawned has no result to hold, so it must never
    // appear in the held set the rail renders as "Orchard is holding this".
    if (q.heldOnly && !(isHeld(r) && r.state !== 'running' && r.state !== 'pending')) return false;
    return true;
  });
  out.sort((a, b) => b.dispatchedAt - a.dispatchedAt);
  return out.slice(0, q.limit ?? 100);
}

export function get(id: string): LaneRecord | null {
  return readAll().find((r) => r.id === id) ?? null;
}

/** Read the AUTHORITATIVE result. The excerpt on the record is never this. */
export function readResult(id: string): string | null {
  const rec = get(id);
  if (!rec?.resultPointer) return null;
  try {
    return fs.readFileSync(rec.resultPointer, 'utf8');
  } catch {
    return null;
  }
}

/* --------------------------------------------------- rule 3: boot reconciliation */

/** Is this pid alive AND still the process we spawned? */
export function liveWithToken(pid: number | null, token: string | null): 'alive' | 'dead' | 'pid-reused' | 'unknown' {
  if (pid == null || !Number.isFinite(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') {
      // Alive but not ours to signal — cannot be our child; treat as pid reuse.
      return 'pid-reused';
    }
    return 'dead';
  }
  if (!token) return 'unknown';
  let cmdline = '';
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return 'unknown'; // process exists but we cannot read its argv — never guess
  }
  return cmdline.includes(token) ? 'alive' : 'pid-reused';
}

export interface ReconcileSummary {
  checked: number;
  cut: number;
  leftRunning: number;
  /** STEP 2 — orphans PROVEN alive and taken over by this server, not cut. */
  adopted: number;
  /** STEP 2 — open groups whose persisted close deadline had already passed. */
  groupsClosedByDeadline: number;
  details: string[];
}

/**
 * Re-check every `running` claim at server start.
 *
 * Ownership first: a record whose writing server is STILL ALIVE belongs to that
 * server (two Orchard servers can share a data dir — a scratch verify server
 * does not, but the production one plus a stray one can), and this boot leaves
 * it alone. Otherwise the claim has no writer left, so it is resolved against
 * the child's own ground truth and marked `cut` with an honest reason. On the
 * blocking transport an ALIVE orphan is still `cut`: the socket that would have
 * carried its result died with the server, so the result can no longer be
 * collected — the pid is named in the detail so a human can deal with it.
 * Nothing here is ever guessed and a claim never stands unexamined.
 */
export function reconcileBoot(opts: { now?: number; alive?: (pid: number | null, token: string | null) => ReturnType<typeof liveWithToken>; serverAlive?: (r: LaneRecord) => boolean } = {}): ReconcileSummary {
  assertWriter();
  return reconcileBootLocked(opts);
}

/**
 * ROUND 2 — the OWNER needs the same identity proof the child already had.
 * Round 1 asked only `process.kill(serverPid, 0)`. After a reboot (or simply a
 * long-lived record) any unrelated same-uid process holding that number made
 * the claim IMMORTAL: `running` is `isHeld`, so it was prune-exempt forever and
 * consumed one of the 60 admit slots permanently — enough of them and every
 * future dispatch is refused, citing results that do not exist. Ownership is
 * now proven by the pid's own start time plus the boot id; anything short of
 * proof means the owner is gone and the claim gets resolved.
 */
function reconcileBootLocked(opts: { now?: number; alive?: (pid: number | null, token: string | null) => ReturnType<typeof liveWithToken>; serverAlive?: (r: LaneRecord) => boolean }): ReconcileSummary {
  const now = opts.now ?? Date.now();
  const alive = opts.alive ?? liveWithToken;
  const serverAlive = opts.serverAlive ?? ((r: LaneRecord) => sameProcess(r.serverPid, r.serverStart ?? null, r.bootId ?? null));
  const all = readAll();
  const summary: ReconcileSummary = { checked: 0, cut: 0, leftRunning: 0, adopted: 0, groupsClosedByDeadline: 0, details: [] };
  let changed = false;
  /*
   * STEP 2 — RE-ARM THE CLOSE DEADLINES FROM THE FILE. This is the whole reason
   * `groupCloseDeadline` is a persisted number and not a `setTimeout`: the
   * timer died with the previous process, so without this pass an open group
   * that outlived a restart stays open forever and its members' results are
   * never drained. Done BEFORE the per-record pass so a group closed here also
   * gets its never-spawned `pending` members cut in the same reconcile.
   */
  const deadlineGroups = new Set(
    all.filter((r) => r.groupOpen && r.groupCloseDeadline != null && r.groupCloseDeadline <= now).map((r) => r.groupId),
  );
  for (const gid of deadlineGroups) {
    for (const r of all.filter((x) => x.groupId === gid)) {
      r.groupOpen = false;
      r.groupClosed = true;
      r.groupClosedAt = now;
      if (r.state === 'pending') {
        r.state = 'cut';
        r.settledAt = now;
        r.failureKind = 'never-spawned';
        r.heldReason = 'the group’s close deadline passed while this declared member had not spawned — it has no result and never will';
      }
    }
    summary.groupsClosedByDeadline++;
    summary.details.push(`group ${gid}: closed — its persisted close deadline had passed before this server booted`);
    changed = true;
  }
  for (const r of all) {
    /*
     * STEP 2 — a `pending` row whose dispatching server is gone NEVER SPAWNED.
     * Left alone it is a non-terminal member that holds its group's drain shut
     * forever, because nothing will ever promote it.
     */
    if (r.state === 'pending' && !serverAlive(r)) {
      summary.checked++;
      r.state = 'cut';
      r.settledAt = now;
      r.failureKind = 'never-spawned';
      r.reconciledAt = now;
      r.reconcileDetail = `the Orchard server (pid ${r.serverPid}) that declared this member is gone and it had not spawned — nothing can promote it, so it is cut rather than left holding its group open`;
      r.heldReason = r.reconcileDetail;
      summary.cut++;
      summary.details.push(`${r.id}: cut — ${r.reconcileDetail}`);
      changed = true;
      continue;
    }
    if (r.state !== 'running') continue;
    summary.checked++;
    if (serverAlive(r)) {
      summary.leftRunning++;
      summary.details.push(`${r.id}: left running — the server that dispatched it (pid ${r.serverPid}, started ${r.serverStart}) is PROVABLY the same process and owns its settle write`);
      continue;
    }
    const ownerNote = pidAlive(r.serverPid)
      ? `pid ${r.serverPid} is live but is NOT the server that wrote this record (start time / boot id do not match) — the number was recycled`
      : `the Orchard server (pid ${r.serverPid}) that owned this lane is gone`;
    const status = alive(r.pid, r.argvToken);
    /*
     * STEP 2 — ADOPT A PROVABLY-ALIVE ORPHAN INSTEAD OF CUTTING IT.
     *
     * Step 1 cut every non-owned running row, including a child it had just
     * PROVEN alive (`failureKind:'server-restart-orphan-alive'`). That was
     * honest for a blocking dispatch — the socket carrying the result died with
     * the server, so the result really was unreachable. It stops being true the
     * moment the result lands in a FILE this store owns: the child writes
     * `lanes/<id>/result.txt` and the new server can collect it, so killing the
     * row throws away work that is still running and still recoverable. That is
     * the restart-mid-group case, and cutting there means a restart destroys a
     * live fan-out.
     *
     * Adoption is only ever taken on PROOF: `alive()` must have matched the
     * child's argv token, not merely found the pid. Anything short of that
     * falls through to the unchanged cut paths below — this never guesses.
     */
    if (status === 'alive') {
      r.serverPid = process.pid;
      r.serverStart = procStartTime(process.pid);
      r.bootId = bootId();
      r.reconciledAt = now;
      r.reconcileDetail = `${ownerNote}; its child (pid ${r.pid}) is PROVABLY still ours (argv carries ${r.argvToken}) and its result lands in a file this store owns, so this server ADOPTED the claim instead of cutting a live lane`;
      summary.adopted++;
      summary.details.push(`${r.id}: adopted — ${r.reconcileDetail}`);
      changed = true;
      continue;
    }
    /* `status === 'alive'` is handled by the adopt branch above and cannot
     * reach here — the compiler proves it (TS2367 if the arm is re-added). */
    const detail =
      status === 'dead'
        ? `${ownerNote} and its child (pid ${r.pid}) is proven dead`
        : status === 'pid-reused'
          ? `${ownerNote}; pid ${r.pid} exists but is not this lane's child (argv no longer carries ${r.argvToken})`
          : `${ownerNote} and there is no usable evidence about its child (pid ${r.pid ?? 'unrecorded'})`;
    r.state = 'cut';
    r.settledAt = now;
    r.failureKind = 'server-restart';
    r.reconciledAt = now;
    r.reconcileDetail = detail;
    summary.cut++;
    summary.details.push(`${r.id}: cut — ${detail}`);
    changed = true;
  }
  if (changed) writeAll(all);
  return summary;
}

/** Mark records dismissed (the user discarded them). Makes them prunable. */
export function dismiss(ids: string[] | '*'): number {
  assertWriter();
  const all = readAll();
  const now = Date.now();
  let n = 0;
  for (const r of all) {
    if (r.dismissedAt) continue;
    if (ids !== '*' && !ids.includes(r.id)) continue;
    r.dismissedAt = now;
    // `dismissedAt` makes isHeld() false, so "why it is held" stops being true.
    clearHeldReason(r);
    n++;
  }
  if (n) writeAll(all);
  return n;
}
