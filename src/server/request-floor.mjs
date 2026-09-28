/**
 * BUG-187 — the REQUEST FLOOR: "every control_request a live CLI emits is
 * answered, cancelled, or owned by an attached responder that has seen it".
 *
 * WHY THIS EXISTS
 * ---------------
 * A `claude` CLI asks its host before every tool call (a PreToolUse
 * `hook_callback`, or a `can_use_tool` permission request). Under restart
 * survival the CLI's stdio is owned by a broker (session-host.mjs) and the
 * server is only a CLIENT of that broker. When no client is attached the broker
 * used to drop the CLI's output, so a request emitted then was never answered:
 * a hook failed after the CLI's own 600 s timeout, a permission request hung
 * forever. A background agent looped for five hours that way (BUG-187).
 *
 * This module is the ledger that makes the invariant checkable, and it is ONE
 * implementation used in two places (build spec B5): the broker (H4), and the
 * responder-only bridge for an old broker that cannot run it itself.
 *
 * THE LEDGER (keyed by request_id)
 *   unowned        — emitted with nobody attached, or its owner dropped. Its
 *                    grace clock runs; on expiry the floor REFUSES it.
 *   owned(C)       — emitted while client C was attached, so C saw it. Never
 *                    refused while C stays attached: a human deciding a
 *                    permission card may take as long as they like.
 *   handover(C)    — C sent `initialize`; waiting for the CLI's answer to it.
 *                    Ids the CLI redelivers in that answer's
 *                    `pending_permission_requests` become owned(C); every other
 *                    id goes back to unowned with its ORIGINAL clock.
 *   answered | cancelled | refused — TERMINAL. A client response for a
 *                    terminal id is DROPPED, never forwarded: exactly one answer
 *                    reaches the CLI per request id.
 *
 * LANES. A request's lane is `request.input.agent_id` for a hook callback and
 * `request.agent_id` for a permission request; absent = the main thread, which
 * is never lane-stopped. A lane's first refusal starts `blockedSince`. If no
 * client ADOPTS (a successful `initialize`) within `laneBlockMs`, the floor asks
 * for THAT lane to be stopped (`stop_task`), and then waits for its terminal
 * frame (`stopped`) or 30 s (`stopUnconfirmed`). It never ends the CLI, and
 * sibling lanes are untouched.
 *
 * "Blocked" means NOBODY CAN ANSWER the lane (BUG-187 round 4). A lane with a
 * request an attached client OWNS is being served — e.g. a human deciding a
 * permission card that FEAT-065's relay (which attaches without `initialize`,
 * so never adopts) put on the dashboard. Such a lane is not blocked: the
 * client owning its request clears `blockedSince`, and the backstop never
 * stops a lane while it has an owned or handed-over request. Responder LOSS is
 * unchanged: when that owner drops, its requests go unowned, are refused at
 * their grace, and the lane's block clock starts again from that refusal.
 *
 * OWNERSHIP IS ONE STATE MACHINE (BUG-187 round 5). Every change of who owns a
 * live entry goes through `#transition`, and at every instant a live entry
 * has exactly one owner: a client (owned / handover) or the floor's own
 * fallback (unowned — the floor WILL answer it, by refusal, at its grace).
 * There is no state in which nobody is going to answer it.
 *
 *   event                                   from            → to
 *   CLI request, client C attached          (new)           → owned(C)
 *   CLI request, nobody attached            (new)           → unowned (clock starts)
 *   CLI replays a LIVE id to attached C     any             → owned(C)   (C has now seen it)
 *   CLI replays a SETTLED id                terminal        → terminal   (not forwarded: one card, one answer)
 *   C sends initialize I                    unowned|owned(C)|handover(C) → handover(C), claim I
 *   handover timeout (10 s, no answer)      handover        → unowned, ORIGINAL clock; claim I KEPT
 *   CLI answers I: success, id redelivered  handover|unowned(claimed by I) → owned(C)
 *                                           — a LATE success after the timeout re-claims the
 *                                             card cleanly, if the fallback has not answered it
 *   CLI answers I: failure / not listed     handover, no other claim → unowned, ORIGINAL clock
 *                                           unowned (timed out)      → unowned (fallback keeps it)
 *                                           handover, a NEWER claim  → handover (waits for that one)
 *   C detaches                              owned(C)|handover(C) → unowned; C's claims dropped
 *   grace expires                           unowned         → refused (terminal)
 *   a late success for a REFUSED id         terminal        → terminal; the owner of the
 *                                             broker strips it from the forwarded redelivery
 *                                             (`isSettled`) so no card is shown for an answered id
 *
 * Pure: no I/O, no timers. The owner calls `tick()` on a cadence and supplies
 * `write` (a frame to the CLI) and `stopLane` (issue a stop for a lane).
 */

export const FLOOR_REFUSAL_REASON =
  'Orchard is not attached to this session, so this tool call cannot be authorised right now; ' +
  'the tool was NOT run. If you are a background agent, stop and report what you have so far — ' +
  'further tool calls will be refused the same way until Orchard reconnects.';

const TERMINAL = new Set(['answered', 'cancelled', 'refused']);
/** An initialize the CLI has not answered in this long no longer holds its requests back from the fallback. */
export const HANDOVER_TIMEOUT_MS = 10_000;

/** The lane a request belongs to: the subagent id, or null for the main thread. */
export function laneOf(request) {
  if (!request || typeof request !== 'object') return null;
  if (request.subtype === 'hook_callback') {
    const id = request.input && typeof request.input === 'object' ? request.input.agent_id : null;
    return typeof id === 'string' && id ? id : null;
  }
  const id = request.agent_id;
  return typeof id === 'string' && id ? id : null;
}

/**
 * The refusal the floor writes to the CLI. Shapes copied from the SDK's own
 * writers (sdk.mjs `handleControlRequest`: `{type:'control_response',
 * response:{subtype:'success', request_id, response}}` and its error twin
 * `{subtype:'error', request_id, error}`), with the payloads the SDK's
 * callbacks would return: a PreToolUse hook's `hookSpecificOutput` deny, and a
 * permission result `{behavior:'deny', message, toolUseID}`.
 */
export function refusalFrame(requestId, request, reason = FLOOR_REFUSAL_REASON) {
  const subtype = request?.subtype;
  if (subtype === 'hook_callback') {
    const event = request?.input?.hook_event_name || 'PreToolUse';
    if (event === 'PreToolUse') {
      return {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: {
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
          },
        },
      };
    }
    // A non-PreToolUse hook cannot deny a tool; answering it empty (= no
    // decision) is what an absent hook means, and it unblocks the CLI.
    return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } };
  }
  if (subtype === 'can_use_tool') {
    return {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: 'deny',
          message: reason,
          ...(typeof request?.tool_use_id === 'string' ? { toolUseID: request.tool_use_id } : {}),
        },
      },
    };
  }
  return { type: 'control_response', response: { subtype: 'error', request_id: requestId, error: reason } };
}

/** Grace knobs (env), per subtype. 0 or a bad value falls back to the default. */
export function floorGraceFromEnv(env = process.env) {
  const num = (k, d) => { const n = Number(env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    hook_callback: num('CLAUDE_STATION_FLOOR_HOOK_GRACE_MS', 30_000),
    can_use_tool: num('CLAUDE_STATION_FLOOR_PERMISSION_GRACE_MS', 120_000),
    other: num('CLAUDE_STATION_FLOOR_OTHER_GRACE_MS', 30_000),
  };
}

/** U1: default 90 s; `0` = never stop a blocked lane (blocked forever, but visibly). */
export function laneBlockMsFromEnv(env = process.env) {
  const raw = env.CLAUDE_STATION_LANE_BLOCK_MS;
  if (raw === undefined || raw === '') return 90_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 90_000;
}

export class RequestFloor {
  /**
   * @param {{
   *   grace?: {hook_callback:number, can_use_tool:number, other:number},
   *   laneBlockMs?: number,
   *   stopConfirmMs?: number,
   *   now?: () => number,
   *   write: (frame: object) => void,
   *   stopLane?: (laneId: string) => void,
   *   onChange?: () => void,
   *   log?: (msg: string) => void,
   * }} o
   */
  constructor(o) {
    this.grace = o.grace ?? floorGraceFromEnv();
    this.laneBlockMs = o.laneBlockMs ?? laneBlockMsFromEnv();
    this.stopConfirmMs = o.stopConfirmMs ?? 30_000;
    this.now = o.now ?? Date.now;
    this.write = o.write;
    this.stopLane = o.stopLane ?? (() => {});
    this.onChange = o.onChange ?? (() => {});
    this.log = o.log ?? (() => {});
    /** request_id → entry */
    this.entries = new Map();
    /** request_id → terminal state, kept for the CLI's whole lifetime (late responses must always be recognised) */
    this.terminal = new Map();
    /** laneId → { blockedSince, stopRequestedAt, stoppedAt, stopUnconfirmed, refusals } */
    this.lanes = new Map();
    /** initialize request_id → clientId */
    this.handovers = new Map();
    this.refusals = 0;
    this.dropped = 0;
  }

  #graceFor(subtype) {
    if (subtype === 'hook_callback') return this.grace.hook_callback;
    if (subtype === 'can_use_tool') return this.grace.can_use_tool;
    return this.grace.other;
  }

  /** An attached client owns a request of this lane, so the lane is served, not blocked. */
  #laneServed(lane) {
    if (!lane) return;
    const l = this.lanes.get(lane);
    if (l && l.blockedSince && !l.stopRequestedAt) l.blockedSince = null;
  }

  /** Does this lane have a request a client currently owns (or is taking over)? */
  #laneHasOwner(lane) {
    for (const e of this.entries.values()) if (e.lane === lane && (e.state === 'owned' || e.state === 'handover')) return true;
    return false;
  }

  /**
   * THE ownership transition (see the table in the header). The only place an
   * entry's state/owner/clock change while it is live.
   */
  #transition(e, to, owner = null) {
    if (to === 'owned') {
      e.state = 'owned';
      e.owner = owner;
      e.unownedSince = null;
      e.handoverAt = null;
      e.claims.clear();
      this.#laneServed(e.lane);
    } else if (to === 'handover') {
      e.state = 'handover';
      e.owner = owner;
      e.handoverAt = this.now();
    } else {
      // The floor's fallback owns it: the grace clock runs from its ORIGINAL
      // start (or from now, if a client owned it until this moment).
      e.state = 'unowned';
      e.owner = null;
      e.handoverAt = null;
      if (e.unownedSince == null) e.unownedSince = this.now();
    }
  }

  #settle(id, state) {
    this.entries.delete(id);
    // BUG-187 round 2: NEVER evicted. A floor lives exactly as long as its CLI
    // (one per broker; one per attach facade), so the ledger is bounded by that
    // CLI's lifetime, not by a count. A global cap (it was 4000) forgot a
    // refused id after enough traffic and let a late client response reach the
    // CLI a second time. Cost: one short string per request the CLI ever made.
    this.terminal.set(id, state);
  }

  /**
   * The CLI emitted a control_request. `clientId` = the client it is forwarded
   * to, or null. Returns false when the id is already SETTLED (answered,
   * refused or cancelled): the owner must not forward that replay, or a card
   * would be shown for a request that already has its one answer.
   */
  onCliRequest(frame, clientId) {
    const id = frame?.request_id;
    if (id === undefined || id === null) return true;
    const key = String(id);
    if (this.terminal.has(key)) return false;
    const known = this.entries.get(key);
    if (known) {
      // A replay of a live id (the SDK contract: a pending prompt may arrive
      // again as a live frame). Forwarded to an attached client, that client
      // has now seen it — it owns it, whatever the handover did meanwhile.
      if (clientId != null && !(known.state === 'owned' && known.owner === clientId)) {
        this.#transition(known, 'owned', clientId);
        this.onChange();
      }
      return true;
    }
    const request = frame.request ?? {};
    const e = {
      rawId: id,
      request,
      subtype: request.subtype ?? null,
      lane: laneOf(request),
      state: 'unowned',
      owner: null,
      unownedSince: null,
      handoverAt: null,
      /** initialize request ids in flight that may still transfer this entry to their client */
      claims: new Set(),
      arrivedAt: this.now(),
    };
    this.entries.set(key, e);
    this.#transition(e, clientId != null ? 'owned' : 'unowned', clientId ?? null);
    this.onChange();
    return true;
  }

  /** Is this id settled (answered, refused or cancelled)? */
  isSettled(requestId) { return this.terminal.has(String(requestId)); }

  /** The CLI withdrew a request (`control_cancel_request`). Never refused afterwards. */
  onCliCancel(requestId) {
    const key = String(requestId);
    if (!this.entries.has(key)) return;
    this.#settle(key, 'cancelled');
    this.onChange();
  }

  /**
   * A client wrote a control_response. Returns true when it must be FORWARDED
   * to the CLI, false when it must be DROPPED (the id is already terminal —
   * refused, cancelled or answered — so forwarding would be a second answer).
   * An id the floor never saw (a response to a request emitted before this
   * broker tracked anything) is forwarded: the floor only arbitrates what it
   * knows.
   */
  onClientResponse(requestId, clientId) {
    const key = String(requestId);
    if (this.terminal.has(key)) {
      this.dropped++;
      this.log(`dropped a late response for ${key} (already ${this.terminal.get(key)}) from client ${clientId}`);
      return false;
    }
    const e = this.entries.get(key);
    if (!e) return true;
    this.#settle(key, 'answered');
    // A lane whose request got a real answer is not blocked any more.
    if (e.lane) {
      const l = this.lanes.get(e.lane);
      if (l && !l.stopRequestedAt) l.blockedSince = null;
    }
    this.onChange();
    return true;
  }

  /** A client dropped: everything it owned is unowned from NOW (the grace clock starts). */
  onClientDetached(clientId) {
    let changed = false;
    // Its initializes can no longer transfer anything: whatever the CLI answers
    // them now goes to nobody (or to the next client, who never sent them).
    for (const [rid, c] of this.handovers) {
      if (c !== clientId) continue;
      this.handovers.delete(rid);
      for (const e of this.entries.values()) e.claims.delete(rid);
    }
    for (const e of this.entries.values()) {
      if ((e.state === 'owned' || e.state === 'handover') && e.owner === clientId) {
        this.#transition(e, 'unowned');
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  /** Client `clientId` sent `initialize` (request id `initRequestId`): every pending id waits for the CLI's answer. */
  onClientInitialize(clientId, initRequestId) {
    const rid = String(initRequestId);
    this.handovers.set(rid, clientId);
    for (const e of this.entries.values()) {
      if (e.state !== 'unowned' && e.owner !== clientId) continue; // owned by a live other client: leave it
      e.claims.add(rid);
      this.#transition(e, 'handover', clientId);
    }
    this.onChange();
  }

  /**
   * The CLI answered an `initialize`. Returns the clientId that sent it (or
   * null when it was not a tracked client initialize). Ids the answer
   * redelivers become owned by that client; every other handover id returns to
   * unowned with its original clock. `pendingIds` null = an older CLI that
   * does not report pending prompts: nothing is transferred.
   *
   * Decided per entry by the CLAIM this initialize holds, not by the entry's
   * current state: an answer that lands after the handover timeout (the entry
   * is back with the fallback) still re-claims a redelivered card, as long as
   * the fallback has not answered it. If it has, the id is settled, nothing
   * here touches it, and the owner strips it from what it forwards.
   */
  onInitResponse(initRequestId, pendingIds, success) {
    const rid = String(initRequestId);
    const clientId = this.handovers.get(rid);
    if (clientId === undefined) return null;
    this.handovers.delete(rid);
    const redelivered = new Set((pendingIds ?? []).map(String));
    for (const [id, e] of this.entries) {
      if (!e.claims.delete(rid)) continue;
      if (success && redelivered.has(id)) this.#transition(e, 'owned', clientId);
      else if (e.state === 'handover' && e.claims.size === 0) this.#transition(e, 'unowned');
      // else: timed out and not re-claimed → the fallback keeps it; owned stays
      // owned; a newer initialize still claims it → it waits for that answer.
    }
    this.onChange();
    return clientId;
  }

  /** A client ADOPTED the CLI (initialize succeeded with its hooks applied): lanes are no longer blocked. */
  onAdopted() {
    for (const l of this.lanes.values()) if (!l.stopRequestedAt) l.blockedSince = null;
    this.onChange();
  }

  /** A lane ended (its terminal frame, or the level dropped it). */
  onLaneTerminal(laneId) {
    const l = this.lanes.get(laneId);
    if (!l) return;
    if (l.stopRequestedAt && !l.stoppedAt) { l.stoppedAt = this.now(); l.stopUnconfirmed = false; this.onChange(); }
    else if (!l.stopRequestedAt && l.blockedSince) { l.blockedSince = null; l.endedAt = this.now(); this.onChange(); }
  }

  #refuse(key, e) {
    this.#settle(key, 'refused');
    this.refusals++;
    try { this.write(refusalFrame(e.rawId, e.request)); } catch { /* CLI gone — the exit handler tears down */ }
    this.log(`refused ${e.subtype ?? 'request'} ${key}${e.lane ? ` (lane ${e.lane})` : ' (main thread)'} — unowned for ${this.now() - e.unownedSince} ms`);
    if (e.lane) {
      let l = this.lanes.get(e.lane);
      if (!l) { l = { blockedSince: null, stopRequestedAt: null, stoppedAt: null, stopUnconfirmed: false, refusals: 0 }; this.lanes.set(e.lane, l); }
      l.refusals++;
      if (!l.blockedSince && !l.stopRequestedAt) l.blockedSince = this.now();
    }
  }

  /** Advance the clocks: refuse expired unowned requests, stop lanes blocked past the bound. */
  tick() {
    const now = this.now();
    let changed = false;
    for (const [key, e] of [...this.entries]) {
      if (e.state === 'handover' && now - (e.handoverAt ?? now) > HANDOVER_TIMEOUT_MS) {
        // The initialize has not been answered: a stuck handover must not hold
        // a request forever, so the fallback takes it back (ORIGINAL clock).
        // The claim is KEPT: a late success may still re-claim it cleanly
        // until the fallback has answered it (onInitResponse).
        this.#transition(e, 'unowned');
        changed = true;
      }
      if (e.state !== 'unowned') continue;
      if (now - e.unownedSince >= this.#graceFor(e.subtype)) { this.#refuse(key, e); changed = true; }
    }
    for (const [laneId, l] of this.lanes) {
      if (this.laneBlockMs > 0 && l.blockedSince && !l.stopRequestedAt && now - l.blockedSince >= this.laneBlockMs) {
        // Served meanwhile (an owner holds one of its requests): not blocked after all.
        if (this.#laneHasOwner(laneId)) { l.blockedSince = null; changed = true; continue; }
        l.stopRequestedAt = now;
        this.log(`stopping lane ${laneId}: blocked ${now - l.blockedSince} ms with nobody attached (LANE_BLOCK_MS=${this.laneBlockMs})`);
        try { this.stopLane(laneId); } catch { /* best effort */ }
        changed = true;
      }
      if (l.stopRequestedAt && !l.stoppedAt && !l.stopUnconfirmed && now - l.stopRequestedAt >= this.stopConfirmMs) {
        l.stopUnconfirmed = true;
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  /** Counts + per-lane state, for the status record. */
  snapshot() {
    let unowned = 0, owned = 0, handover = 0;
    for (const e of this.entries.values()) {
      if (e.state === 'unowned') unowned++;
      else if (e.state === 'owned') owned++;
      else handover++;
    }
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    return {
      pending: { unowned, owned, handover },
      refusals: this.refusals,
      droppedLateResponses: this.dropped,
      lanes: [...this.lanes].map(([id, l]) => ({
        id,
        refusals: l.refusals,
        blockedSince: iso(l.blockedSince),
        stopRequestedAt: iso(l.stopRequestedAt),
        stoppedAt: iso(l.stoppedAt),
        stopUnconfirmed: !!l.stopUnconfirmed,
      })),
    };
  }

  /**
   * Does an attached client own (or is it taking over) a live request? Then a
   * person may be deciding it, and nothing bounded by time may end the CLI's
   * input under it (BUG-187 round 6: the broker's drain commit reads this).
   */
  hasOwned() {
    for (const e of this.entries.values()) if (e.state === 'owned' || e.state === 'handover') return true;
    return false;
  }

  /** Is anything unresolved? (S2: a broker with pending requests is adopted, not reaped.) */
  hasPending() { return this.entries.size > 0; }

  /** Terminal state of an id, if known. */
  stateOf(requestId) {
    const key = String(requestId);
    return this.entries.get(key)?.state ?? this.terminal.get(key) ?? null;
  }

  static isTerminal(state) { return TERMINAL.has(state); }
}
