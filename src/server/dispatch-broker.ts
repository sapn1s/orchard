/** Host-side OpenAI dispatch broker. Credentials and Codex never cross into a project. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import { dataDir, ensureDir, projectRoot } from '../lib/paths.ts';
import * as lanes from './lanes.ts';
import type { Project } from './registry.ts';

export const CONTAINER_DISPATCH_DIR = '/opt/orchard-dispatch';
export const CONTAINER_DISPATCH_CLIENT = `${CONTAINER_DISPATCH_DIR}/dispatch-client.mjs`;
export const CONTAINER_DISPATCH_SOCKET_DIR = '/run/orchard-dispatch';
export const CONTAINER_DISPATCH_SOCKET = `${CONTAINER_DISPATCH_SOCKET_DIR}/dispatch.sock`;
export const DISPATCH_COMMAND = `node ${CONTAINER_DISPATCH_CLIENT}`;
export const PROJECT_CAP = 2;
export const GLOBAL_CAP = 6;
export const MAX_TIMEOUT_MIN = 60;

const PHASES = new Set(['finding', 'fixing', 'verifying']);
const CLASSES = new Set(['trivial', 'fix', 'explore', 'plan+review', 'arch', 'verify']);
const SANDBOXES = new Set(['read-only', 'workspace-write']);
const REQUEST_KEYS = new Set(['op', 'provider', 'model', 'prompt', 'sandbox', 'timeoutMin', 'ticket', 'phase', 'round', 'class', 'ack',
  // ARCH-017 step 2 — group membership is DECLARED by the dispatcher at
  // dispatch time (ARCH-010: the owner states the fact), never derived by the
  // broker from timing or from who happens to be running.
  'groupId', 'groupSize', 'groupOpen', 'parentSessionId']);
const daemons = new Map<string, { server: net.Server; socket: string }>();
const activeByProject = new Map<string, number>();
let activeGlobal = 0;

export class DispatchBrokerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'DispatchBrokerError'; this.code = code; }
}

function projectSegment(project: Project): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project.id) || project.id.includes('..')) {
    throw new DispatchBrokerError('bad-project-id', `project id ${JSON.stringify(project.id)} is not safe`);
  }
  return project.id;
}

export function dispatchSocketPath(project: Project): string {
  return path.join(dispatchProjectDir(project), 'dispatch.sock');
}
export function dispatchStateHome(): string { return path.join(dataDir(), 'dispatch'); }
export function dispatchProjectDir(project: Project): string { return path.join(dispatchStateHome(), projectSegment(project)); }
export function dispatchClientPath(): string { return path.join(import.meta.dirname, 'dispatch-client.mjs'); }
export function dispatchBinds(project: Project) {
  return [
    /* connect(2) requires write permission on the socket INODE, supplied by its
     * 0600 mode and matching uid; it does not require changing the directory.
     * A :ro bind preserves those inode mode bits while preventing the container
     * from adding/unlinking entries. Binding the directory still exposes a
     * replacement socket inode after broker restart. */
    { hostPath: dispatchProjectDir(project), containerPath: CONTAINER_DISPATCH_SOCKET_DIR, readOnly: true, why: 'OpenAI dispatch socket directory' },
    { hostPath: dispatchClientPath(), containerPath: CONTAINER_DISPATCH_CLIENT, readOnly: true, why: 'OpenAI dispatch client' },
  ];
}
export function dispatchContainerEnv() { return { ORCHARD_DISPATCH_SOCK: CONTAINER_DISPATCH_SOCKET, ORCHARD_DISPATCH_CMD: DISPATCH_COMMAND }; }

type Terminal = { op: 'result'; ok: boolean; text: string; exitCode: number; failureKind: string | null; sessionId: string | null; meta: Record<string, unknown> };

/**
 * ARCH-017 round 3 — how long the connection stays open waiting for the peer's
 * receipt after the result has been written. Generous on purpose: round 2 used
 * 2 s and a 3 MB result whose peer took 4 s to write it to its own stdout was
 * never stamped, so every large lane result accumulated as held. Nothing waits
 * on this — the dispatch has already returned and the record is already
 * settled; only the delivery stamp arrives late.
 */
export const DELIVERY_RECEIPT_MS = 120_000;

/**
 * Write the terminal frame and report what is KNOWN about where it went — as
 * TWO facts with two owners (ARCH-010), because the fifth attempt at this
 * question is the one that admits a single party cannot answer it.
 *
 * The four that failed, each broken by an independent verifier:
 * 1. `!socket.destroyed` read before the send: 2 false stamps in 45.
 * 2. Flush callback + clean close: still 1 in 45 — on AF_UNIX a frame sitting
 *    in a dead peer's receive buffer looks exactly like one it read.
 * 3. A bare `{"op":"ack"}`: a client whose stdout write FAILED (`/dev/full`,
 *    EPIPE) acked anyway and was stamped, then PRUNED AWAY with its result.
 * 4. `{"op":"ack","bytes":N}` compared by LENGTH: **a length is a number a peer
 *    can produce without receiving anything.** Reproduced end to end over a real
 *    socket by a cross-provider verifier and again here
 *    (`scripts/scratch-a17-r4-forged-receipt.mjs`): one honest dispatch to learn
 *    the length, then a peer that never attaches a data handler acks that number
 *    and is stamped — `peerBytesReceived=0 claimed=328 delivered=true`.
 *    Same-length replacement bytes and duplicated output passed it too.
 *
 * THE TWO FACTS, AND WHY NEITHER ALONE IS `delivered`:
 *  - **HANDOFF — Orchard's own fact, and unforgeable.** "I wrote exactly N bytes
 *    to this socket and the write completed without error." Taken from the write
 *    callback, never from a reply. It is recorded ALWAYS, ack or no ack. It is
 *    NOT `delivered`: on AF_UNIX it is equally true for a peer that is dead, that
 *    never reads, or whose own stdout write then fails with ENOSPC/EPIPE — which
 *    is round-2 finding 1, the data-loss case. Stamping delivery on it would
 *    re-admit exactly that.
 *  - **POSSESSION — the peer's fact, but EVIDENCE rather than assertion.**
 *    The frame carries a per-lane random `receiptNonce` and the destination fd,
 *    and the receipt must carry `sha256(nonce ‖ "fdN" ‖ the bytes it holds)`. A
 *    peer that received nothing cannot compute it; truncated, replaced or
 *    duplicated bytes produce a different digest; and (round 5) a receipt for
 *    the wrong channel no longer validates. A guess is not available: the answer
 *    exists only for someone holding those exact bytes.
 *
 * `delivered` therefore means, EXACTLY: **Orchard's write of the whole result
 * completed without error, AND the consumer returned proof that it holds those
 * exact bytes and stated it wrote them to the channel this payload is for.**
 * Round 5 pared the claim down to what is actually provable here. NOT claimed,
 * because no process can inspect another's file descriptors: that the consumer
 * emitted the bytes anywhere at all (measured: a peer holding the bytes and
 * writing them nowhere produces a valid receipt), nor that the text entered the
 * parent's context. An EMPTY result is never stamped — over zero bytes the proof
 * is a constant. The limits are named here rather than papered over with a
 * stronger-looking guard, because five rounds have now shown that a
 * cheap-looking delivery proof costs more than it saves.
 */
/*
 * ROUND 5 — WHAT THE DIGEST DOES AND DOES NOT PROVE, after a cross-provider
 * verifier drove these functions with instrumented I/O.
 *
 * Round 4's digest was `sha256(nonce ‖ bytes)`. Three things were wrong with the
 * CLAIM built on it (the mechanism was fine; the sentence was not):
 *
 *  1. It proves KNOWLEDGE, not EMISSION. Measured: a peer that reads the frame
 *     and writes the bytes to no file descriptor at all returns a valid digest
 *     — `{"delivered":true,"handoff":true,"socketBytes":2048,"emittedBytes":0}`.
 *     Nothing in this process can observe another process's file descriptors,
 *     so EMISSION IS NOT PROVABLE FROM HERE, full stop. The digest input now
 *     binds the DESTINATION (`fd1` for a result, `fd2` for a failure text), so
 *     a conforming consumer's receipt states which channel it wrote to and a
 *     receipt for the wrong channel cannot validate — measured before the fix:
 *     a receipt for bytes written ONLY to fd 2 was byte-for-byte identical to
 *     one for an fd-1 write. That makes the receipt SPECIFIC. It does not make
 *     it proof of emission, and the evidence string now says so in plain words
 *     instead of the old "the exact bytes it wrote to its own fd".
 *  2. An EMPTY result makes the proof a constant: `sha256(nonce ‖ 'fd1' ‖ '')`
 *     is computable by a peer that received nothing. Measured before the fix:
 *     `{"delivered":true,"handoff":true,"resultBytes":0,"emittedBytes":0}`.
 *     Zero bytes are therefore never stamped: there is nothing to deliver and
 *     nothing to prove, and saying so is cheaper than a proof that is a lie on
 *     one input.
 *  3. The count and the digest must AGREE. A receipt carrying a valid digest
 *     and a contradictory byte count is a peer lying about something; it is
 *     refused rather than trusted on the half that happens to check out.
 *
 * So the strongest truthful sentence, and the one the evidence string says:
 * **Orchard wrote all N bytes to the consumer's socket and the write completed,
 * and the consumer returned a proof that it holds exactly those N bytes and
 * states it wrote them to fd F.** Possession and destination-as-claimed —
 * NOT "the text entered the parent's context", which is unobservable here.
 */
/*
 * ONE IMPLEMENTATION, USED HERE. This was a local `createHash` and a local
 * `randomBytes` nonce, and round 5's report claimed the rule was shared when it
 * was not — a cross-provider review proved it:
 *   2-shared-rule {"brokerUsesSharedDigest":false,"brokerUsesSharedNonce":false}
 * This is now a thin, typed wrapper that names the CHANNEL for this transport
 * (`fd1`/`fd2`) and delegates the hashing to `lanes.receiptDigest`. The
 * comparison is `lanes.receiptMatches`, so case handling cannot drift between
 * the two paths either.
 */
function receiptDigest(nonce: string, fd: 1 | 2, bytes: Buffer): string {
  return lanes.receiptDigest(nonce, `fd${fd}`, bytes);
}

function terminal(
  socket: net.Socket,
  frame: Terminal,
  onOutcome?: (delivered: boolean, why: string, proof?: string) => void,
  wantsAck = false,
  onHandoff?: (bytes: number, why: string) => void,
  sealFirst?: () => void,
) {
  const payload = Buffer.from(frame.text ?? '', 'utf8');
  const payloadBytes = payload.length;
  const nonce = lanes.receiptNonce();
  /* The channel this payload is FOR: a result goes to the consumer's stdout, a
   * failure text to its stderr (both reach the parent's tool_result; they are
   * different channels, and a receipt must say which one it used). */
  const destFd: 1 | 2 = frame.ok ? 1 : 2;
  const line = `${JSON.stringify({ ...frame, receiptNonce: nonce, receiptFd: destFd })}\n`;
  const expected = receiptDigest(nonce, destFd, payload);
  if (socket.destroyed) { onOutcome?.(false, 'the peer was already gone before the result frame was written'); return; }
  /*
   * ROUND 10 (finding 3) — SEAL BEFORE EMISSION. The group's durable seal must be
   * persisted BEFORE any bytes leave, so a seal-write failure refuses the send
   * rather than emitting the result and then silently permitting a late member (a
   * second delivery). Round 9 sealed inside the handoff, which ran AFTER
   * `socket.end`; here the seal is attempted first, and if it throws NOTHING is
   * emitted — the result stays held and the drain re-offers it.
   */
  if (sealFirst) {
    try { sealFirst(); }
    catch (e) {
      onOutcome?.(false, `the group could not be sealed before delivery (${(e as Error).message}); refusing to emit the result, because emitting it unsealed would let a late member deliver the group a second time — it stays held`);
      if (!socket.destroyed) socket.end();
      return;
    }
  }
  if (!onOutcome || !wantsAck) {
    socket.end(line, () => onHandoff?.(payloadBytes, `${payloadBytes} bytes of result were written to the peer's socket and the write completed without error (Orchard's own fact; it does NOT mean the peer read them)`));
    onOutcome?.(false, 'the peer did not request a delivery receipt (no "ack" in its request), so nothing proves it holds the result — the record stays held rather than claiming a delivery');
    return;
  }
  let reported = false;
  let timer: NodeJS.Timeout | null = null;
  /** Orchard's own half: null until the write callback fires. */
  let handoff: { ok: boolean; why: string } | null = null;
  /** A receipt that arrived before Orchard's own write completed (see below). */
  let pendingGrant: (() => void) | null = null;
  const grantWhy = (claimed: number) =>
    `Orchard wrote ${payloadBytes} bytes to the consumer's socket and the write completed without error; the consumer returned sha256(nonce‖"fd${destFd}"‖bytes) matching those exact bytes and reported writing ${claimed} of them to fd ${destFd}. PROVEN: it holds exactly those bytes and names that channel. NOT PROVEN, and not observable from this process: that it actually emitted them, or that the text entered the parent's context — no process can inspect another's file descriptors, so the receipt is possession-and-stated-destination, never emission.`;
  const done = (delivered: boolean, why: string, proof?: string) => {
    if (reported) return;
    reported = true;
    if (timer) clearTimeout(timer);
    if (!socket.destroyed) socket.end();
    onOutcome(delivered, why, proof);
  };
  let inbound = '';
  socket.on('data', (chunk) => {
    inbound += chunk.toString();
    let nl: number;
    while ((nl = inbound.indexOf('\n')) >= 0) {
      const raw = inbound.slice(0, nl);
      inbound = inbound.slice(nl + 1);
      let f: { op?: string; bytes?: unknown; digest?: unknown; fd?: unknown } | null = null;
      try { f = JSON.parse(raw); } catch { continue; }
      if (f?.op !== 'ack') continue;
      const claimed = typeof f.bytes === 'number' && Number.isInteger(f.bytes) ? f.bytes : -1;
      const digest = typeof f.digest === 'string' ? f.digest : null;
      const statedFd = typeof f.fd === 'number' && Number.isInteger(f.fd) ? f.fd : null;
      if (!digest) return done(false, `the peer acknowledged with ${claimed < 0 ? 'no byte count' : `${claimed} bytes`} but NO possession proof — a byte count alone is a number any peer can produce without receiving anything, so the record stays held`);
      /* ROUND 5 defect 1b: zero bytes make the proof a constant, so it proves
       * nothing. Nothing is lost by holding — there is nothing to deliver. */
      if (payloadBytes === 0) return done(false, 'this lane produced an EMPTY result, and a possession proof over zero bytes is a constant any peer can compute without receiving anything — there is nothing to deliver and nothing that could prove it, so the record stays held rather than claiming a delivery on the one input where the receipt is worthless');
      /* ROUND 5 defect 1c: a valid digest with a contradictory count means the
       * peer is lying about one of the two; neither half is then evidence. */
      if (claimed !== payloadBytes) return done(false, `the peer's receipt contradicts itself: it claims to have written ${claimed < 0 ? 'no stated number of' : String(claimed)} bytes but returns a proof over the ${payloadBytes} bytes sent — a receipt that disagrees with itself is not evidence, so the record stays held`);
      if (!lanes.receiptMatches(expected, digest)) return done(false, `the peer's possession proof does not match the ${payloadBytes} bytes sent to fd ${destFd} (it holds different bytes, or fewer, or none, or it wrote them to a different channel than the one this payload is for) — the record stays held`);
      /*
       * ROUND 6 defect 1 — THE STATED CHANNEL IS PART OF THE STATEMENT, so it is
       * compared. Round 5 bound the channel into the DIGEST and then never
       * looked at the `fd` the receipt itself declared: measured, a correct
       * fd-1 digest accompanied by `fd:2`, `fd:99`, `fd:"two"`, `fd:null` and an
       * OMITTED field were all accepted identically. A field nobody checks is a
       * field that means nothing, and the whole point of round 5 was that the
       * receipt names its channel — so it must name it, as an integer, and it
       * must be the channel this payload is for. Same treatment as the byte
       * count: a receipt that disagrees with itself is not evidence.
       */
      if (statedFd === null) return done(false, `the peer's receipt does not state which channel it wrote to (no integer "fd" field) — this payload is for fd ${destFd}, and a receipt that names no channel cannot be checked against it, so the record stays held`);
      if (statedFd !== destFd) return done(false, `the peer's receipt states it wrote these bytes to fd ${statedFd}, but this payload is for fd ${destFd} (${destFd === 1 ? 'a result goes to the consumer\'s stdout' : 'a failure text goes to the consumer\'s stderr'}) — the record stays held`);
      /* ROUND 6 — THE DECISION ON AN EARLY RECEIPT, STATED SO NOBODY HAS TO
       * INFER IT. Two coherent options existed: (a) refuse a receipt that
       * arrives before Orchard's own write has completed, or (b) hold the
       * verdict and settle it when the write completes. **We chose (b), and it
       * is not a loophole in the "handoff is required" rule — it is that rule's
       * only correct implementation on this transport.** `socket.write()`'s
       * completion callback is a FLUSH notification: on a fast local socket the
       * peer can legitimately have read, hashed and replied before it runs, so
       * (a) would refuse honest consumers at random depending on scheduler
       * timing, and the record would be held for a delivery that did happen.
       * Under (b) nothing is ever stamped on the consumer's half alone: the
       * grant is executed from inside the write callback, and only if the write
       * succeeded. The receipt window still bounds the wait, so a deferral
       * cannot hang — it times out held. (Belt and braces: the store refuses an
       * acknowledgement with no handoff, so even a bug here cannot persist the
       * incoherent record.)
       *
       * ROUND 5 defect 2: `delivered` may not outrun Orchard's own fact. A null
       * handoff here is a legitimate ARRIVAL ORDER (the flush callback can run
       * after the peer's reply) but never a legitimate STAMP, so the verdict is
       * DEFERRED to the write callback rather than granted or refused now. The
       * receipt window still bounds the wait. */
      if (!handoff) { pendingGrant = () => done(true, grantWhy(claimed), `possession-digest-fd${destFd}`); return; }
      if (!handoff.ok) return done(false, `the peer returned a valid possession proof but Orchard's own write reported an error (${handoff.why}) — the two facts contradict each other, so nothing is stamped`);
      return done(true, grantWhy(claimed), `possession-digest-fd${destFd}`);
    }
  });
  socket.once('error', (e) => done(false, `the connection failed before the peer proved possession of the result: ${e.message}`));
  socket.once('close', () => done(false, 'the connection closed before the peer proved possession of the result'));
  timer = setTimeout(() => done(false, `the peer did not prove possession of the result within ${DELIVERY_RECEIPT_MS}ms`), DELIVERY_RECEIPT_MS);
  timer.unref?.();
  socket.write(line, (err) => {
    handoff = err
      ? { ok: false, why: err.message }
      : { ok: true, why: `${payloadBytes} bytes written to the peer's socket, write completed without error` };
    if (handoff.ok) onHandoff?.(payloadBytes, `${payloadBytes} bytes of result were written to the peer's socket and the write completed without error (Orchard's own fact; it does NOT mean the peer read them)`);
    /* The receipt got here first. Now that Orchard's own fact exists, the
     * deferred verdict can be settled — granted if the write succeeded,
     * refused if it did not. A delivery never precedes the handoff. */
    if (pendingGrant) {
      const grant = pendingGrant;
      pendingGrant = null;
      if (handoff.ok) grant();
      else done(false, `the peer returned a valid possession proof but Orchard's own write then reported an error (${handoff.why}) — the two facts contradict each other, so nothing is stamped`);
    }
  });
}

/**
 * The delivery rule, reachable by a test WITHOUT a real socket. ARCH-017 round
 * 5: the cross-provider verifier found "ack accepted while the handoff is still
 * null" by driving this function with instrumented I/O, and that state is not
 * reachable over a real AF_UNIX socket on demand (it depends on when the flush
 * callback happens to run). A private function nothing can drive is a private
 * function nothing can attack, so the seam is deliberate and named rather than
 * the test re-implementing the rule it is supposed to be checking.
 */
export const __terminalForTests = terminal;

function refusal(socket: net.Socket, kind: string, text: string, meta: Record<string, unknown> = {}) {
  terminal(socket, { op: 'result', ok: false, text, exitCode: 2, failureKind: kind, sessionId: null, meta });
}

function validate(raw: unknown): { ok: true; r: Record<string, unknown> } | { ok: false; kind: string; text: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, kind: 'invalid-request', text: 'request must be a JSON object' };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!REQUEST_KEYS.has(k)) return { ok: false, kind: 'unknown-field', text: `request field ${JSON.stringify(k)} is not allowed` };
  if (r.op === 'capabilities') return Object.keys(r).length === 1 ? { ok: true, r } : { ok: false, kind: 'invalid-request', text: 'capabilities accepts no other fields' };
  /*
   * ARCH-017 step 2 — `op:'start'` is NON-BLOCKING DISPATCH: the broker answers
   * with the lane id as soon as the child is spawned and the caller's turn
   * continues. The result is NOT sent on this socket; it settles into the
   * ledger and is collected by the group-settle drain.
   *
   * SHIPPED WITH THE DRAIN, NEVER BEFORE IT — this is the plan's headline risk.
   * Non-blocking dispatch ALONE makes a fan-out strictly worse: today the first
   * lane's result at least comes back inside the turn that asked for it, and
   * with `start` and no drain nothing returns in-turn and every single result
   * costs a wake plus a manual click. The two are one feature.
   */
  if (r.op !== 'dispatch' && r.op !== 'start') return { ok: false, kind: 'invalid-operation', text: 'op must be capabilities, dispatch or start' };
  if (r.groupId != null && (typeof r.groupId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(r.groupId))) return { ok: false, kind: 'invalid-group', text: 'groupId contains forbidden characters' };
  if (r.groupSize != null && (typeof r.groupSize !== 'number' || !Number.isInteger(r.groupSize) || r.groupSize < 1 || r.groupSize > 64)) return { ok: false, kind: 'invalid-group', text: 'groupSize must be an integer between 1 and 64' };
  if (r.groupOpen != null && typeof r.groupOpen !== 'boolean') return { ok: false, kind: 'invalid-group', text: 'groupOpen must be a boolean' };
  if (r.parentSessionId != null && typeof r.parentSessionId !== 'string') return { ok: false, kind: 'invalid-session', text: 'parentSessionId must be a string' };
  if (r.op === 'start' && r.ack != null) return { ok: false, kind: 'invalid-ack', text: 'ack is meaningless on a non-blocking start: nothing is sent on this socket to acknowledge' };
  if (r.provider !== 'openai') return { ok: false, kind: 'invalid-provider', text: 'provider must be openai' };
  if (typeof r.prompt !== 'string' || !r.prompt.trim()) return { ok: false, kind: 'invalid-prompt', text: 'prompt must be a non-empty string' };
  // Square brackets permitted: the CLI's own model ids carry them (`opus[1m]`,
  // the 1M-context variants). Still anchored, length-capped, alphanumeric-led,
  // no shell metacharacters — the value is an argv element, never shell-parsed.
  if (r.model != null && (typeof r.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/.test(r.model))) return { ok: false, kind: 'invalid-model', text: 'model contains forbidden characters' };
  if (r.sandbox != null && !SANDBOXES.has(String(r.sandbox))) return { ok: false, kind: 'invalid-sandbox', text: 'sandbox must be read-only or workspace-write' };
  if (r.timeoutMin != null && (typeof r.timeoutMin !== 'number' || !Number.isFinite(r.timeoutMin) || r.timeoutMin <= 0)) return { ok: false, kind: 'invalid-timeout', text: 'timeoutMin must be a positive number' };
  if (r.phase != null && (typeof r.phase !== 'string' || !PHASES.has(r.phase))) return { ok: false, kind: 'invalid-phase', text: 'phase is not allowed' };
  if (r.class != null && (typeof r.class !== 'string' || !CLASSES.has(r.class))) return { ok: false, kind: 'invalid-class', text: 'class is not allowed' };
  // ARCH-017: an opt-in receipt. A peer that sets it promises to send
  // {"op":"ack"} AFTER it has written the result to its own stdout; that ack is
  // the only evidence the ledger accepts for a delivery stamp.
  if (r.ack != null && typeof r.ack !== 'boolean') return { ok: false, kind: 'invalid-ack', text: 'ack must be a boolean' };
  if (r.ticket != null && (typeof r.ticket !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._,-]{0,199}$/.test(r.ticket))) return { ok: false, kind: 'invalid-ticket', text: 'ticket contains forbidden characters' };
  if (r.round != null && (typeof r.round !== 'string' && typeof r.round !== 'number' || !/^[1-9][0-9]{0,5}$/.test(String(r.round)))) return { ok: false, kind: 'invalid-round', text: 'round must be a positive integer' };
  return { ok: true, r };
}

/**
 * ARCH-017 — record the settlement, once the connection has told us whether the
 * result reached anyone.
 *
 * A ledger failure never affects the dispatch (this step observes an existing
 * path). But it is not swallowed either: a `record-missing` means the result
 * text exists nowhere the ledger can point at, so the text is quarantined to a
 * file and the path is reported at ERROR level. Round 1 returned null here and
 * logged nothing at all.
 */
function settleLane(laneId: string, exitCode: number, text: string, failureKind: string | null, meta: Record<string, unknown>): boolean {
  try {
    lanes.settle(laneId, {
      state: exitCode === 0 ? 'settled' : 'failed',
      resultText: text,
      failureKind,
      usage: meta.usage && typeof meta.usage === 'object' ? (meta.usage as Record<string, unknown>) : null,
    });
    return true;
  } catch (e) {
    let quarantined = '(not written)';
    try {
      const dir = path.join(dataDir(), 'lanes', '_unrecorded');
      ensureDir(dir);
      quarantined = path.join(dir, `${laneId}.txt`);
      fs.writeFileSync(quarantined, text);
    } catch { /* the console line below is still the loud half */ }
    console.error(`[orchard] LANE LEDGER: lane ${laneId} could not be settled (${(e as Error).message}). The result text is quarantined at ${quarantined} — it is NOT lost, but no ledger record points at it.`);
    return false;
  }
}

/**
 * ARCH-017 round 3 — the delivery stamp, and ONLY on evidence.
 *
 * Split out of `settleLane()` for a measured reason: the receipt can arrive
 * seconds after the child exits (a multi-megabyte result takes the peer that
 * long just to write it to its own stdout), and a record that waits for it sits
 * `running` — a state it KNOWS to be false, and one a server restart in the
 * meantime would reconcile to `cut`, destroying a result that had in fact
 * succeeded. So settlement is written the instant the child exits (truthful,
 * and HELD), and this runs later if and only if the byte counts matched.
 * A stamp that cannot be written leaves the record HELD: a duplicate delivery
 * is a nuisance, a lost result is the failure this ticket exists to prevent.
 */
function stampHandoff(laneId: string, bytes: number, why: string) {
  try {
    lanes.markHandoff(laneId, bytes, why);
  } catch (e) {
    console.warn(`[orchard] lane ledger: lane ${laneId} handoff (${bytes} bytes) could not be recorded (${(e as Error).message}) — the dispatch is unaffected, and because the store refuses an acknowledgement with no handoff behind it (ROUND 6) this lane will also stay HELD rather than being stamped on the consumer's half alone`);
  }
}

/** ROUND 6 — the refusal reason is a fact with an owner now, not a dropped string. */
function stampHeldReason(laneId: string, why: string) {
  try {
    lanes.markHeldReason(laneId, why);
  } catch (e) {
    console.warn(`[orchard] lane ledger: lane ${laneId} is held (${why}) but the reason could not be recorded (${(e as Error).message}) — the record is still held, which is the part that matters`);
  }
}

/**
 * ROUND 7 finding 1b — EVERY OUTCOME LEAVES A REASON, INCLUDING THE ONES THAT
 * GO WRONG. The outcome callback used to be an inline arrow that stamped on
 * success, recorded a reason on refusal, and — if the stamp itself threw
 * (`handoff-missing` after a failed handoff write, `record-missing` after a
 * prune) — logged to a console nobody reads and left the record bare:
 * `{"acknowledged":false,"handoff":null,"heldReason":null}` — held with no
 * explanation at exactly the moment an explanation matters most. It is a named
 * function now, so the whole outcome lifecycle is one readable unit and the
 * suite can drive it directly against a real on-disk record.
 */
function recordOutcome(laneId: string, delivered: boolean, why: string, proof?: string) {
  if (delivered) stampAcknowledged(laneId, why, proof);
  else stampHeldReason(laneId, why);
}
export const __recordOutcomeForTests = recordOutcome;

function stampAcknowledged(laneId: string, why: string, proof?: string) {
  try {
    lanes.markAcknowledged(laneId, 'blocking-dispatch', why, proof ?? null);
  } catch (e) {
    /* The acknowledgement could not be written. The record stays HELD, which is
     * the safe outcome — and now it also says WHY it is held, instead of the
     * reason existing only in a log line. */
    stampHeldReason(laneId, `a valid receipt arrived but the acknowledgement could not be recorded (${(e as Error).message}) — the record stays HELD, so this result may be handed over again rather than being lost`);
    console.warn(`[orchard] lane ledger: lane ${laneId} was delivered (${why}) but the stamp could not be written (${(e as Error).message}) — the record stays HELD, so it may be delivered again rather than lost`);
  }
}

function runDispatch(project: Project, socket: net.Socket, r: Record<string, unknown>) {
  const own = activeByProject.get(project.id) ?? 0;
  if (own >= PROJECT_CAP) return refusal(socket, 'project-concurrency-cap', `dispatch refused: project concurrency cap ${PROJECT_CAP} reached`, { cap: PROJECT_CAP });
  if (activeGlobal >= GLOBAL_CAP) return refusal(socket, 'global-concurrency-cap', `dispatch refused: global concurrency cap ${GLOBAL_CAP} reached`, { cap: GLOBAL_CAP });
  activeByProject.set(project.id, own + 1); activeGlobal++;
  const timeoutMin = Math.min(Number(r.timeoutMin ?? 15), MAX_TIMEOUT_MIN);
  const scratch = path.join(dataDir(), 'dispatch', 'scratch'); ensureDir(scratch);
  /*
   * ARCH-017 step 1 — the lane id is allocated BEFORE the spawn and stamped
   * into the child's argv (it is part of the --meta-out path), so the ledger
   * record joins to the real process by a machine-checkable token rather than
   * by judgement — and a later boot can tell our child from a reused pid.
   * EVERY ledger call here is best-effort: this step observes an existing path
   * and must not change what a dispatch does, so a ledger failure is logged and
   * the dispatch proceeds exactly as before.
   */
  const background = r.op === 'start';
  const laneId = lanes.newLaneId();
  const metaPath = path.join(scratch, `${project.id}-${laneId}.json`);
  let ledgerId: string | null = null;
  try {
    lanes.recordDispatch({
      projectId: project.id, projectName: project.name ?? null,
      // Step 2: `op:'start'` DECLARES the parent session; `op:'dispatch'` still
      // carries none, so it is recorded as ABSENT rather than guessed.
      parentSessionId: r.parentSessionId == null ? null : String(r.parentSessionId),
      /*
       * A blocking dispatch is a declared group of one, closed at birth: the
       * caller waits for it inline. A `start` may declare itself part of a
       * larger, possibly still-open group. Nothing is DERIVED here either way.
       */
      groupId: r.groupId == null ? laneId : String(r.groupId),
      groupSize: r.groupSize == null ? 1 : Number(r.groupSize),
      groupClosed: r.groupOpen === true ? false : true,
      groupOpen: r.groupOpen === true,
      // STEP 2 — the token goes in at BIRTH, not post-spawn, so a crash between
      // here and the spawn still leaves a row a /proc scan can resolve.
      argvToken: metaPath,
      label: `${String(r.provider)} dispatch${r.ticket ? ` ${String(r.ticket)}` : ''}`,
      charter: String(r.prompt ?? ''),
      provider: String(r.provider), model: r.model == null ? null : String(r.model),
      transport: 'blocking-dispatch',
      ticket: r.ticket == null ? null : String(r.ticket), phase: r.phase == null ? null : String(r.phase),
      round: r.round == null ? null : String(r.round), laneClass: r.class == null ? null : String(r.class),
    }, laneId);
    ledgerId = laneId;
  } catch (e) {
    console.warn(`[orchard] lane ledger: dispatch not recorded (${(e as Error).message}) — the dispatch itself is unaffected`);
    ledgerId = null;
  }
  const script = process.env.ORCHARD_DISPATCH_SCRIPT || path.join(projectRoot(), 'scripts', 'dispatch.mjs');
  const args = [script, '--provider', 'openai', '--cwd', project.hostPath, '--sandbox', String(r.sandbox ?? 'read-only'), '--timeout-min', String(timeoutMin), '--meta-out', metaPath, '--prompt-stdin'];
  for (const [field, flag] of [['model', '--model'], ['ticket', '--ticket'], ['phase', '--phase'], ['round', '--round'], ['class', '--class']] as const) if (r[field] != null) args.push(flag, String(r[field]));
  let child: ChildProcess;
  let stderr = '';
  let stdout = '';
  let settled = false;
  const finish = (exitCode: number, kind: string | null, internalText = '') => {
    if (settled) return; settled = true; clearTimeout(killTimer);
    activeByProject.set(project.id, Math.max(0, (activeByProject.get(project.id) ?? 1) - 1)); activeGlobal = Math.max(0, activeGlobal - 1);
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* child may fail before metadata */ }
    try { fs.unlinkSync(metaPath); } catch { /* short-lived scratch */ }
    const failureKind = kind ?? (typeof meta.failureKind === 'string' ? meta.failureKind : exitCode === 0 ? null : 'child-exit');
    const text = internalText || stdout;
    /*
     * ARCH-017 rule 2 — "delivered" is decided by whether this result actually
     * reached a reader, and it is stamped only AFTER the send. On this transport
     * the reader is the socket peer whose tool_result carries the text into the
     * parent's context; a peer that died first means the result reached NOBODY,
     * so the record stays held (and is therefore exempt from pruning) instead of
     * being marked delivered for a send that did not happen.
     *
     * ORDER MATTERS AND IS NOT A STYLE CHOICE: settle FIRST (the result file is
     * the authority and must exist before anything can be lost), send SECOND,
     * stamp THIRD and only on matching byte counts.
     */
    const recorded = ledgerId ? settleLane(ledgerId, exitCode, text, failureKind, meta) : false;
    /*
     * STEP 2 — A BACKGROUND LANE SETTLES AND STOPS THERE.
     *
     * No send, no handoff, no acknowledgement: the socket that asked for this
     * lane was answered and closed minutes ago, so there is nobody on it to
     * hand bytes to. The record stays HELD, which is exactly right — the result
     * has reached no reader — and the group-settle drain is what eventually
     * carries it. This is also hazard 1 closed at the source: a lane finishing
     * while the orchestrator is mid-turn writes a file and returns; it has no
     * channel with which to interrupt anything.
     */
    if (background) {
      if (!recorded && ledgerId) console.error(`[orchard] lane ${ledgerId}: a BACKGROUND lane settled but the ledger did not record it — this result is reachable only under ${lanes.laneDir(ledgerId)}`);
      return;
    }
    terminal(
      socket,
      { op: 'result', ok: exitCode === 0, text, exitCode, failureKind, sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : null, meta: { ...meta, timeoutMin, cwdForced: project.hostPath, stderr: exitCode === 0 ? undefined : stderr.slice(-4000) } },
      recorded ? (delivered, why, proof) => recordOutcome(ledgerId!, delivered, why, proof) : undefined,
      r.ack === true,
      recorded ? (bytes, why) => stampHandoff(ledgerId!, bytes, why) : undefined,
      recorded ? () => { const rec = lanes.get(ledgerId!); if (rec) lanes.sealGroupDurably(rec.groupId, 'drained', `that group has already been drained (lane ${rec.id} was handed over)`); } : undefined,
    );
  };
  const timeoutGraceMs = Number(process.env.ORCHARD_DISPATCH_TIMEOUT_GRACE_MS ?? 10_000);
  const killTimer = setTimeout(() => { child?.kill('SIGTERM'); finish(1, 'broker-timeout', `dispatch timed out after ${timeoutMin} minute(s)`); }, timeoutMin * 60_000 + timeoutGraceMs);
  try {
    child = spawn(process.env.ORCHARD_DISPATCH_NODE || process.execPath, args, { cwd: project.hostPath, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
  } catch (e) { return finish(1, 'spawn-failed', `could not spawn dispatch: ${(e as Error).message}`); }
  // ARCH-017 rule 3 — the ground truth a later boot re-checks this claim against.
  if (ledgerId) {
    try { lanes.attachProcess(ledgerId, child.pid ?? null, metaPath); }
    catch (e) { console.warn(`[orchard] lane ledger: ${ledgerId} has no process ground truth (${(e as Error).message}) — a restart could not reconcile it; the dispatch itself is unaffected`); }
  }
  /*
   * STEP 2 — THE NON-BLOCKING ANSWER, sent the moment the child exists.
   *
   * Sent AFTER the spawn, never before: the caller's turn continues on the
   * promise that a lane is really running, and answering ahead of the spawn
   * would let a `spawn-failed` be reported as a started lane the drain then
   * waits on forever.
   */
  if (background) {
    const rec = ledgerId ? lanes.get(ledgerId) : null;
    if (!socket.destroyed) {
      socket.end(`${JSON.stringify({
        op: 'started', ok: true, laneId: ledgerId, pid: child.pid ?? null,
        groupId: rec?.groupId ?? null, groupOpen: rec?.groupOpen ?? false,
        groupCloseDeadline: rec?.groupCloseDeadline ?? null,
        note: 'this lane runs in the background; its result is collected by the group-settle drain and appears on the pending rail. Nothing further arrives on this socket.',
      })}\n`);
    }
  }
  child.stdout!.on('data', (b) => { stdout += b.toString(); });
  child.stderr!.on('data', (b) => { const text = b.toString(); stderr += text; if (!background && !socket.destroyed) socket.write(`${JSON.stringify({ op: 'progress', text })}\n`); });
  child.on('error', (e) => finish(1, 'spawn-failed', `could not spawn dispatch: ${e.message}`));
  child.on('close', (code) => finish(code ?? 1, null));
  child.stdin!.on('error', () => {}); child.stdin!.end(String(r.prompt));
}

function connection(project: Project, socket: net.Socket) {
  let input = ''; let handled = false;
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    if (handled) return;
    input += chunk;
    if (input.length > 8 * 1024 * 1024) { handled = true; return refusal(socket, 'request-too-large', 'request exceeds 8 MiB'); }
    const nl = input.indexOf('\n'); if (nl < 0) return;
    handled = true;
    if (input.slice(nl + 1).trim()) return refusal(socket, 'multiple-requests', 'one request per connection');
    let raw: unknown; try { raw = JSON.parse(input.slice(0, nl)); } catch { return refusal(socket, 'invalid-json', 'request is not valid JSON'); }
    const v = validate(raw); if (!v.ok) return refusal(socket, v.kind, v.text);
    if (v.r.op === 'capabilities') return socket.end(`${JSON.stringify({ ok: true, providers: ['openai'], models: { openai: ['default'] }, project: project.id, entitled: true, dispatchCmd: DISPATCH_COMMAND })}\n`);
    runDispatch(project, socket, v.r);
  });
  socket.on('end', () => { if (!handled) { handled = true; refusal(socket, 'partial-frame', 'connection ended before a complete NDJSON frame'); } });
  socket.on('error', () => {});
}

export async function start(project: Project): Promise<string> {
  const id = projectSegment(project); const existing = daemons.get(id); if (existing) return existing.socket;
  /*
   * ARCH-017 — take the ledger's single-writer claim before this broker can
   * record anything. Awaited on purpose: the claim is settled by the kernel and
   * `listen()` reports EADDRINUSE asynchronously, so a synchronous "did it
   * throw?" reads as success for a SECOND writer (measured, and it is exactly
   * how the first round-3 draft shipped a vacuous guarantee). A refusal is not
   * fatal to dispatching — this step only observes an existing path — but it is
   * said out loud, because it means lane records are not being written.
   */
  const claim = await lanes.claimWriter();
  if (!claim.ok) console.warn(`[orchard] lane ledger: this process does not hold the writer claim (${claim.reason}) — dispatches will run but NO lane records will be written for ${project.id}`);
  const dir = dispatchProjectDir(project); const sock = dispatchSocketPath(project); ensureDir(dir); fs.chmodSync(dir, 0o700);
  const unexpected = fs.readdirSync(dir).filter((entry) => entry !== 'dispatch.sock');
  if (unexpected.length) throw new DispatchBrokerError('unclean-project-dir', `dispatch directory contains unexpected entries: ${unexpected.join(', ')}`);
  try { fs.unlinkSync(sock); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const server = net.createServer((s) => connection(project, s));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(sock, () => { server.off('error', reject); resolve(); }); });
  server.on('error', () => { /* accepted connections still receive their own terminal frames */ });
  fs.chmodSync(sock, 0o600); daemons.set(id, { server, socket: sock }); return sock;
}
export async function stop(project: Project): Promise<void> {
  const d = daemons.get(projectSegment(project)); if (!d) return;
  await new Promise<void>((resolve) => d.server.close(() => resolve())); daemons.delete(project.id);
  try { fs.unlinkSync(d.socket); } catch { /* already gone */ }
}
