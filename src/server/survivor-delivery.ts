/**
 * FEAT-065 — deliver a queued message INTO a drain-held survivor (BUG-048 (c+)).
 *
 * After a restart, a session whose survivor broker is holding its drain for
 * live BACKGROUND work (foreground idle) used to refuse every send until the
 * whole drain finished. But the broker keeps the CLI's stdin OPEN, its unix
 * socket is client-free after a restart, and BUG-048's probe 3 proved (CLI
 * 2.1.227) that ONE SDK stream-json user frame written into that stdin runs a
 * normal turn in the SAME CLI pid — single writer preserved, coexisting with
 * the live background work. This module is that write, plus the two things the
 * probes showed are NOT optional:
 *
 *  - PERMISSIONS (probe 4): the survivor runs with `--permission-prompt-tool
 *    stdio`; an unanswered `control_request` hangs the turn FOREVER and (since
 *    the turn holds `midTurn`) extends the drain unboundedly. So this module
 *    relays `can_use_tool` requests to the dashboard's approval flow over the
 *    same ws that sent the `start` (the client renders its ordinary approval
 *    card and answers with `approval-response`). With NO client attached
 *    the request is denied at once with an honest notice — nobody can answer
 *    it. BUG-187 round 6: with a client attached the card is OWNED and waits
 *    for the person, however long they take; only responder LOSS (the ws
 *    detaches, or the socket closes) denies it. That is safe because a broker
 *    that declares `holdsOwnedCards` in its hello never ends the CLI's input
 *    under an owned card (session-host.mjs commitDrain). The old 30 s bound
 *    (CLAUDE_STATION_DELIVERY_APPROVAL_MS) existed only to keep an ignored
 *    card inside FEAT-064's 90 s midTurn commit bound, past which such a
 *    broker truncates the turn anyway; it is kept ONLY for a broker that does
 *    not declare the hold (a protocol-2 broker spawned before round 6).
 *
 *  - EXACTLY-ONCE (probe 5): the caller (index.ts) invokes this ONLY on the
 *    client's own (retry) `start` and acks that start — never out-of-band —
 *    so BUG-045's `settleDrainWaitDelivery` retires the queued row with zero
 *    changes to the client's exactly-once logic. The `active` map refuses a
 *    second delivery for the same session while one turn is in flight; the
 *    refusal falls back to the ordinary retryable "still draining" answer.
 *
 * The injected turn's OUTPUT is not relayed as station events (that would be
 * the full re-adopt bridge, BUG-048 direction (a)) — the CLI writes it to the
 * transcript, which the station already file-follows; the session view renders
 * it live via `session-appended`. This module only watches the relayed bytes
 * for `control_request` and the turn's `result`.
 */
import * as net from 'node:net';
import type { StationEvent } from './events.ts';
import type { DeliveryEvidence } from './liveness.ts';
import type { HostStatus } from './survival.ts';

type ClientSend = ((e: StationEvent | { t: 'ack'; [k: string]: unknown }) => void) | null;

/** Broker-socket connect + refuse-detection budget. Well inside the client's 15s ghost-release window. */
const CONNECT_TIMEOUT_MS = 2500;
/**
 * BUG-187 H3/I3 — a protocol-2 broker says hello the moment it accepts; an
 * older broker never does. How long to wait for it before taking the old path,
 * and how long to wait for the broker's POSITIVE acceptance of the delivered
 * frame before refusing (retryably) instead of acking the client.
 */
const HELLO_WAIT_MS = 1500;
const DELIVER_ACK_MS = 5000;
/**
 * The broker destroys a second client synchronously on accept (single-client
 * rule). Waiting this beat after connect before writing turns a would-be
 * silently-lost frame into a clean fallback-to-refusal (the message stays
 * queued and retries — never lost, never doubled).
 */
const ACCEPT_SETTLE_MS = 120;

export function deliveryApprovalFallbackMs(): number {
  const n = Number(process.env.CLAUDE_STATION_DELIVERY_APPROVAL_MS ?? 30_000);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

/** Operator kill-switch — `CLAUDE_STATION_SURVIVOR_DELIVERY=0` restores the pure queue-and-wait behaviour. */
export function survivorDeliveryEnabled(): boolean {
  return process.env.CLAUDE_STATION_SURVIVOR_DELIVERY !== '0';
}

export interface SurvivorDelivery {
  readonly sdkSessionId: string;
  readonly done: boolean;
  /** BUG-072 — when the user frame was written into the survivor's stdin (the delivered turn's honest start). */
  readonly startedAt: number;
  /** Re-point (or detach, with null) the ws the approval relay + turn-done notice go to. */
  attachClient(send: ClientSend): void;
  /** The dashboard's answer to a relayed `can_use_tool`. False = no such pending request. */
  answerApproval(requestId: string, allow: boolean, message?: string): boolean;
}

const active = new Map<string, DeliveryImpl>();

/** The in-flight delivery for this sdk session, if any (one injected turn at a time). */
/**
 * FEAT-065 (BUG-048 (c+), BUG-074, BUG-187 H7/R5, BUG-191) — may a message be
 * injected into this drain-held survivor right now? Every condition is the
 * broker's OWN declaration: it holds a drain (`draining`), its foreground is
 * provably idle (`midTurn === false`), the hold is for declared live
 * background work (`yes`, or `unknown` with a non-empty level — BUG-074), it
 * still accepts input, and it can confirm a delivery (protocol 2). One
 * function, read by both callers (the socket's start and the BUG-217 outbox).
 */
export function survivorAdmits(survivor: HostStatus): boolean {
  const bgCount = typeof survivor.backgroundLive === 'number' ? survivor.backgroundLive : 0;
  const lifetimeDeliverable = survivor.backgroundLifetime === 'yes'
    || (survivor.backgroundLifetime === 'unknown' && bgCount > 0);
  return survivorDeliveryEnabled()
    && survivor.acceptingInput !== false
    && (survivor.protocol ?? 0) >= 2
    && survivor.state === 'draining'
    && survivor.midTurn === false
    && lifetimeDeliverable;
}

export function activeDeliveryFor(sdkSessionId: string): SurvivorDelivery | null {
  return active.get(sdkSessionId) ?? null;
}

/**
 * BUG-072 — this server's FIRST-HAND evidence that a turn is in flight inside a
 * survivor it does not own: it wrote the user frame itself and has not seen
 * that turn's `result` come back on the relayed stdout. The authority
 * (`survivorWork`) folds this in beside the broker's heartbeat, so the running
 * strip is right in the SAME tick as the delivery ack instead of waiting for
 * the next boundary write. Null = no delivery in flight; the heartbeat alone
 * then answers.
 */
export function deliveryEvidenceFor(sdkSessionId: string | null | undefined): DeliveryEvidence | null {
  if (!sdkSessionId) return null;
  const d = active.get(sdkSessionId);
  return d && !d.done ? { turnLive: true, since: d.startedAt } : null;
}

interface PendingApproval {
  /** The raw request_id value from the wire, echoed back verbatim. */
  rawId: unknown;
  toolName: string;
  input: unknown;
  /** Null = owned by an attached person: no clock, only responder loss denies it. */
  timer: NodeJS.Timeout | null;
}

class DeliveryImpl implements SurvivorDelivery {
  readonly sdkSessionId: string;
  readonly startedAt = Date.now();
  done = false;
  private client: ClientSend;
  private readonly socket: net.Socket;
  private buf = '';
  private readonly pending = new Map<string, PendingApproval>();
  /** The broker declared (hello) that it never ends the CLI's input under an owned card. */
  private readonly holdsOwnedCards: boolean;

  constructor(sdkSessionId: string, socket: net.Socket, client: ClientSend, holdsOwnedCards = false) {
    this.sdkSessionId = sdkSessionId;
    this.socket = socket;
    this.client = client;
    this.holdsOwnedCards = holdsOwnedCards;
  }

  attachClient(send: ClientSend): void {
    const lost = this.client && !send;
    this.client = send;
    // BUG-187 round 6 — responder LOSS: the only ws that could answer these
    // cards is gone (nothing re-attaches a relay to another ws), so nobody can
    // answer them now. Deny them honestly rather than leave the turn hanging.
    if (lost) {
      for (const key of [...this.pending.keys()]) {
        this.denyPending(key, 'denied by Orchard: this permission was raised by a message delivered into a restart-surviving session, and the dashboard that was asking it disconnected before answering — ask again once the session resumes normally');
      }
    }
  }

  handleData(d: Buffer | string): void {
    this.buf += typeof d === 'string' ? d : d.toString('utf8');
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      this.handleLine(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
    }
    // Same posture as the broker's own sniffer: a single giant unterminated
    // line is never a small control frame or result — cap the buffer.
    if (this.buf.length > 16_000_000) this.buf = '';
  }

  private handleLine(line: string): void {
    const s = line.trim();
    if (!s || this.done) return;
    let m: Record<string, any>;
    try { m = JSON.parse(s); } catch { return; }
    if (!m || typeof m !== 'object') return;
    // BUG-187: the broker's own in-band lines (hello, deliver_ack) are not CLI output.
    if (typeof m.type === 'string' && m.type.startsWith('orchard_broker_')) return;
    if (m.type === 'control_request') {
      const req = m.request ?? {};
      if (req.subtype === 'can_use_tool') this.onCanUseTool(m.request_id, req);
      else {
        // Anything else on the control channel has no relay here — answer with
        // an error rather than let it hang the turn (probe 4's failure mode).
        this.write({
          type: 'control_response',
          response: { subtype: 'error', request_id: m.request_id, error: 'not supported while this turn is running via restart-survivor delivery' },
        });
      }
      return;
    }
    if (m.type === 'result') this.finish();
  }

  private onCanUseTool(rawId: unknown, req: Record<string, any>): void {
    const key = String(rawId);
    const toolName = String(req.tool_name ?? 'tool');
    const input = req.input as unknown;
    // BUG-187 round 6: an attached person OWNS the card and is never timed out
    // (see the header). A clock runs only when nobody is attached, or when the
    // broker would end the CLI's input under the card anyway (no hold declared).
    const attached = !!this.client;
    let timer: NodeJS.Timeout | null = null;
    if (!attached || !this.holdsOwnedCards) {
      const fallbackMs = attached ? deliveryApprovalFallbackMs() : 50;
      timer = setTimeout(() => {
        this.denyPending(
          key,
          `denied by Orchard: this permission was raised by a message delivered into a restart-surviving session and ` +
          `${attached ? `went unanswered for ${Math.round(fallbackMs / 1000)}s` : 'no dashboard was connected to answer it'} — ` +
          'denied so the drain can complete; ask again once the session resumes normally',
        );
      }, fallbackMs);
      timer.unref?.();
    }
    this.pending.set(key, { rawId, toolName, input, timer });
    // The dashboard's ORDINARY approval card — same event, same answer command.
    this.client?.({
      t: 'approval-request',
      requestId: key,
      toolName,
      input,
      title: 'raised by your message delivered into the still-draining session',
      agentId: null,
    });
  }

  private denyPending(key: string, message: string): void {
    const p = this.pending.get(key);
    if (!p || this.done) return;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(key);
    this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: p.rawId, response: { behavior: 'deny', message } },
    });
    this.client?.({ t: 'permission-denied', toolName: p.toolName, reason: message });
  }

  answerApproval(requestId: string, allow: boolean, message?: string): boolean {
    const key = String(requestId);
    const p = this.pending.get(key);
    if (!p || this.done) return false;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(key);
    this.write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: p.rawId,
        response: allow
          ? { behavior: 'allow', updatedInput: p.input }
          : {
              behavior: 'deny',
              // BUG-174 — verbatim to the model. The card was answered in the
              // dashboard, not at a prompt inside this session; say which, so
              // this cannot be read as a plan rejection or an interrupted turn.
              message: message || 'DENIED FROM THE ORCHARD DASHBOARD — the user declined it there, not at a prompt in this session. Do not retry it; ask what they want instead.',
            },
      },
    });
    return true;
  }

  private write(obj: unknown): void {
    try { this.socket.write(`${JSON.stringify(obj)}\n`); } catch { /* socket gone — finish() follows via close */ }
  }

  finish(note?: string): void {
    if (this.done) return;
    this.done = true;
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    this.pending.clear();
    active.delete(this.sdkSessionId);
    this.client?.({ t: 'survivor-delivery', phase: 'turn-done', sessionId: this.sdkSessionId, note });
    try { this.socket.destroy(); } catch { /* already gone */ }
  }
}

/**
 * Write ONE SDK stream-json user frame into the drain-held survivor's stdin
 * via its broker socket, and return the relay handle — or null when delivery
 * could not be established (socket missing/refused/already-clientned), in
 * which case the caller falls back to the ordinary retryable refusal and the
 * message stays safely queued.
 *
 * BUG-191 — a third outcome, `'uncertain'`: the protocol-2 envelope WAS written
 * but the broker never answered (no `deliver_ack` in time, or the socket closed
 * after the write). The frame may have reached the CLI, so the caller must not
 * turn this into a retryable refusal (a blind resend could deliver it twice).
 * And an OLDER broker (no hello, so no H7 acceptance) is never written to: it
 * cannot say whether it took the frame, so this returns null (refuse, queued)
 * before any write — the message waits for that broker to finish.
 */
export function deliverIntoSurvivor(opts: {
  survivor: HostStatus;
  sdkSessionId: string;
  prompt: string;
  client: ClientSend;
}): Promise<SurvivorDelivery | null | 'uncertain'> {
  const { survivor, sdkSessionId, prompt, client } = opts;
  if (active.has(sdkSessionId)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    /** BUG-191: once the envelope is written, any failure to hear back is `uncertain`, never a refusal. */
    let written = false;
    const settleAs = (v: null | 'uncertain') => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    const fail = () => settleAs(written ? 'uncertain' : null);
    const overall = setTimeout(fail, CONNECT_TIMEOUT_MS + HELLO_WAIT_MS + DELIVER_ACK_MS);
    overall.unref?.();
    const socket = net.connect(survivor.sock);
    socket.on('error', () => { if (!settled) fail(); /* post-settle errors settle via close */ });
    /*
     * BUG-187 — watch the broker's in-band lines until the delivery settles: a
     * protocol-2 broker says hello, and later ACCEPTS or REJECTS the delivered
     * frame (it rejects once it has ended the CLI's input). The client is acked
     * ONLY on a positive acceptance, so a message can never be acked into a
     * CLI that is about to exit (review round 2, point 9).
     */
    let preBuf = '';
    const early: string[] = [];
    let hello: { accepted: boolean; protocol: number; holdsOwnedCards: boolean } | null = null;
    let onHello: (() => void) | null = null;
    let onAck: ((accepted: boolean) => void) | null = null;
    const preListener = (b: Buffer) => {
      preBuf += b.toString('utf8');
      let nl;
      while ((nl = preBuf.indexOf('\n')) >= 0) {
        const line = preBuf.slice(0, nl);
        preBuf = preBuf.slice(nl + 1);
        // CLI output that raced ahead of the ack is kept for the relay (a
        // permission request of the delivered turn must not be lost).
        if (!line.startsWith('{"type":"orchard_broker_')) { early.push(line); continue; }
        let m: Record<string, any> | null = null;
        try { m = JSON.parse(line); } catch { m = null; }
        if (!m) continue;
        if (m.type === 'orchard_broker_hello') { hello = { accepted: m.accepted === true, protocol: Number(m.protocol) || 0, holdsOwnedCards: m.holdsOwnedCards === true }; onHello?.(); }
        else if (m.type === 'orchard_broker_deliver_ack' && m.delivery_id === deliveryId) onAck?.(m.accepted === true);
      }
    };
    const deliveryId = `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    socket.on('data', preListener);
    socket.once('connect', () => {
      const proceed = () => {
        if (settled) return;
        if (socket.destroyed) return fail();
        if (hello && !hello.accepted) return fail(); // another client holds it: refuse, the message stays queued
        const establish = () => {
          settled = true;
          clearTimeout(overall);
          socket.off('data', preListener);
          const d = new DeliveryImpl(sdkSessionId, socket, client, hello?.holdsOwnedCards === true);
          active.set(sdkSessionId, d);
          if (early.length || preBuf) d.handleData(`${early.map((l) => `${l}\n`).join('')}${preBuf}`);
          socket.on('data', (b) => d.handleData(b));
          socket.on('close', () => d.finish('the survivor connection closed'));
          return d;
        };
        const frame = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } };
        if (hello && hello.protocol >= 2) {
          // Protocol 2: the envelope, then wait for the broker's positive acceptance.
          // Once the envelope is written, silence is NOT a refusal (BUG-191):
          // the broker may have written the frame and lost only its answer —
          // `fail()` then settles `uncertain` (see `written`).
          const t = setTimeout(() => fail(), DELIVER_ACK_MS);
          t.unref?.();
          socket.once('close', () => { if (written) fail(); });
          onAck = (accepted) => {
            clearTimeout(t);
            if (!accepted) return settleAs(null); // the broker's explicit NO: definitely not written
            resolve(establish());
          };
          try {
            socket.write(`${JSON.stringify({ type: 'orchard_broker_deliver', delivery_id: deliveryId, message: frame.message })}\n`);
            written = true;
          } catch { clearTimeout(t); fail(); }
          return;
        }
        /*
         * BUG-191 — an OLDER broker (no hello) has no H7 acceptance: a frame it
         * drops after ending its CLI's input vanishes without a word. It is
         * therefore never written to; the caller refuses retryably and the
         * message waits, visibly, until that broker finishes and the session
         * resumes from disk. (Before BUG-191 the write itself was taken as the
         * delivery. Old brokers are transitional — every broker spawned since
         * BUG-187 speaks protocol 2.)
         */
        fail();
      };
      // Give the broker's single-client rule its beat (older brokers destroy a
      // second client silently); a protocol-2 broker's hello settles it sooner.
      if (hello) { setTimeout(proceed, 0); return; }
      const helloTimer = setTimeout(() => { onHello = null; proceed(); }, Math.max(ACCEPT_SETTLE_MS, HELLO_WAIT_MS));
      helloTimer.unref?.();
      onHello = () => { onHello = null; clearTimeout(helloTimer); proceed(); };
    });
  });
}
