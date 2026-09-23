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
 *    card and answers with `approval-response`), and BOUNDS the wait: with no
 *    client attached the request is denied at once with an honest notice;
 *    with a client attached it is denied after
 *    CLAUDE_STATION_DELIVERY_APPROVAL_MS (default 30s — deliberately inside
 *    FEAT-064's 90s midTurn commit bound, so an ignored approval can never
 *    push the drain into the bounded-truncation window).
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
  timer: NodeJS.Timeout;
}

class DeliveryImpl implements SurvivorDelivery {
  readonly sdkSessionId: string;
  readonly startedAt = Date.now();
  done = false;
  private client: ClientSend;
  private readonly socket: net.Socket;
  private buf = '';
  private readonly pending = new Map<string, PendingApproval>();

  constructor(sdkSessionId: string, socket: net.Socket, client: ClientSend) {
    this.sdkSessionId = sdkSessionId;
    this.socket = socket;
    this.client = client;
  }

  attachClient(send: ClientSend): void {
    this.client = send;
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
    const fallbackMs = this.client ? deliveryApprovalFallbackMs() : 50;
    const timer = setTimeout(() => {
      this.denyPending(
        key,
        `denied by Orchard: this permission was raised by a message delivered into a restart-surviving session and ` +
        `${this.client ? `went unanswered for ${Math.round(deliveryApprovalFallbackMs() / 1000)}s` : 'no dashboard was connected to answer it'} — ` +
        'denied so the drain can complete; ask again once the session resumes normally',
      );
    }, fallbackMs);
    timer.unref?.();
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
    clearTimeout(p.timer);
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
    clearTimeout(p.timer);
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
    for (const p of this.pending.values()) clearTimeout(p.timer);
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
 */
export function deliverIntoSurvivor(opts: {
  survivor: HostStatus;
  sdkSessionId: string;
  prompt: string;
  client: ClientSend;
}): Promise<SurvivorDelivery | null> {
  const { survivor, sdkSessionId, prompt, client } = opts;
  if (active.has(sdkSessionId)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(null);
    };
    const overall = setTimeout(fail, CONNECT_TIMEOUT_MS);
    overall.unref?.();
    const socket = net.connect(survivor.sock);
    socket.on('error', () => { if (!settled) fail(); /* post-settle errors settle via close */ });
    socket.once('connect', () => {
      // Give the broker's single-client rule its beat: if it destroys us, the
      // frame is never written and the caller refuses instead (no silent loss).
      setTimeout(() => {
        if (settled) return;
        if (socket.destroyed) return fail();
        settled = true;
        clearTimeout(overall);
        const d = new DeliveryImpl(sdkSessionId, socket, client);
        active.set(sdkSessionId, d);
        socket.on('data', (b) => d.handleData(b));
        socket.on('close', () => d.finish('the survivor connection closed'));
        // The load-bearing write (BUG-048 probe 3): one user frame = one
        // normal turn in the SAME CLI pid. Single writer preserved.
        try {
          socket.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })}\n`);
        } catch {
          d.finish('the survivor connection failed at write time');
          return resolve(null);
        }
        resolve(d);
      }, ACCEPT_SETTLE_MS);
    });
  });
}
