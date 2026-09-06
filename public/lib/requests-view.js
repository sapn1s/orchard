/**
 * FEAT-126 — "Your requests": the LIVE JOIN that turns a set of declared request
 * bindings into row view-models, reading every status from its existing owner.
 *
 * THE INVARIANT THIS MODULE EXISTS TO GUARANTEE: execution status is STRUCTURALLY
 * distinct from completion status. "0 lanes running" must never render as
 * "everything is done". The two are computed here as TWO INDEPENDENT READS, from
 * TWO DIFFERENT SOURCES, into TWO SEPARATE fields on the row:
 *
 *   · exec       — is work RUNNING for this request, right now? Read from the
 *                  live running snapshot (session liveness / stall) gated onto
 *                  the board's OWNER column (a bound ticket a lane is on — the
 *                  🤖 in-flight set). Driven by lane/owner presence only.
 *   · completion — is this request DONE? Read ONLY from the board's STATUS column
 *                  (a bound ticket's done/verified state). Driven by ticket
 *                  status only. Never sees a lane count.
 *
 * They are different board COLUMNS (owner vs status) plus the live snapshot, so
 * they cannot collapse into one derived field. `completion:'done'` requires every
 * bound ticket done, whatever the lane count; `exec:'idle'` with any open ticket
 * still reads NOT-done. That is the whole point.
 *
 * The binding record carries NO status of its own (see src/server/requests.ts) —
 * this module is the ONLY place status is computed, and it recomputes on every
 * render from the current board / snapshot, so the surface cannot go stale: it
 * has no independent copy to disagree from.
 *
 * PER-LANE ATTRIBUTION (FEAT-126 round 2 — the closed gap). A running lane now
 * carries its DECLARED `request`/`ticket` from its charter Dispatch line onto the
 * snapshot entry (running-set.ts), so a live lane IS attributed to the specific
 * request it works. `executionOf` reads that first: a request with a running lane
 * declared to it (by request id, or by a ticket it binds) reads `running` with a
 * TRUE lane count — never lighting up a sibling request that merely shares a live
 * session. When NO lane in the snapshot carries attribution for a request (an
 * undeclared dispatch, a survivor lane, or an older server), it DEGRADES to the
 * coarse read: the board's OWNER cell (🤖) gated by whether the session has any
 * live lane, so it still never claims motion the snapshot does not confirm.
 *
 * Pure data in, pure data out — no DOM — so it is headless-testable and the rail
 * renderer stays thin.
 */

/**
 * Index the rail board's split lists into one id → {state, item} map.
 * `state` is the ticket's coarse board state, from WHICH LIST it is in:
 *   done  — board.doneToday (completed; done/verified)
 *   needs — board.needsYou (👤, waiting on the user)
 *   prog  — board.inflight (🤖, a lane assigned)
 *   queued— board.queued (open, unowned backlog)
 * A ticket in none of these is absent from the rail board (open tickets and
 * done-today only) — reported honestly as `missing`, never a fabricated status.
 */
export function indexBoardTickets(board) {
  const map = new Map();
  const add = (list, state) => {
    for (const it of list ?? []) {
      if (it && it.id && !map.has(it.id)) map.set(it.id, { state, item: it });
    }
  };
  // done first so a done ticket is never masked by a stale open row of the same id.
  add(board?.doneToday, 'done');
  add(board?.needsYou, 'needs');
  add(board?.inflight, 'prog');
  add(board?.queued, 'queued');
  return map;
}

/** Coarse session liveness from the running snapshot (empty is a real answer). */
function sessionLiveness(snap) {
  const running = snap && Array.isArray(snap.running) ? snap.running : null;
  if (!running) return { known: false, live: 0, stalled: false };
  const live = running.length;
  const stalled = running.some((r) => r && r.state === 'stalled');
  return { known: true, live, stalled };
}

/**
 * The COMPLETION read — board STATUS column only. Returns
 *   { kind: 'done'|'partial'|'open'|'none', done, total, missing }
 * `none` = the request declared no tickets yet (degradation: "no tickets yet").
 * `done` requires EVERY present ticket done AND at least one present. A missing
 * ticket (referenced but not on the board) is counted and surfaced honestly; it
 * never counts as done, so it can never let a request read complete.
 */
export function completionOf(tickets, ticketIndex) {
  const ids = Array.isArray(tickets) ? tickets : [];
  if (!ids.length) return { kind: 'none', done: 0, total: 0, missing: 0 };
  let done = 0;
  let missing = 0;
  for (const id of ids) {
    const hit = ticketIndex.get(id);
    if (!hit) { missing++; continue; }
    if (hit.state === 'done') done++;
  }
  const present = ids.length - missing;
  let kind;
  if (present > 0 && done === present && missing === 0) kind = 'done';
  else if (done > 0) kind = 'partial';
  else kind = 'open';
  return { kind, done, total: ids.length, missing };
}

/**
 * Running lanes DECLARED to this request — the precise per-lane read. A lane is
 * attributed when it carries this request's id, or a ticket this request binds.
 * Only real snapshot entries with declared attribution match; an undeclared lane
 * (no request/ticket on it) never matches here and falls to the coarse read.
 */
function attributedLanes(requestId, tickets, runningLanes) {
  const ids = Array.isArray(tickets) ? tickets : [];
  return (Array.isArray(runningLanes) ? runningLanes : []).filter((lane) => {
    if (!lane) return false;
    if (requestId && lane.request === requestId) return true;
    const lt = Array.isArray(lane.ticket) ? lane.ticket : [];
    return lt.some((t) => ids.includes(t));
  });
}

/**
 * The EXECUTION read — NEVER status/verification. Two-tier, most precise first:
 *
 *  1. PER-LANE (the closed gap): if any running snapshot lane is DECLARED to this
 *     request (by request id or a bound ticket), the request is running with a
 *     TRUE count of those lanes — `stalled` if any of them is. This attributes a
 *     live lane to the one request it works and to no sibling.
 *  2. COARSE FALLBACK (undeclared/older/survivor lanes): the board OWNER column
 *     (🤖 in-flight) gated by whether the session has any live lane, so it never
 *     claims motion the snapshot does not confirm (BUG-041 class).
 *
 * Returns { state:'running'|'idle'|'stalled', count, attributed }.
 */
export function executionOf(tickets, ticketIndex, live, opts = {}) {
  const { requestId = null, runningLanes = null } = opts;
  const lanes = attributedLanes(requestId, tickets, runningLanes);
  if (lanes.length) {
    const stalled = lanes.some((l) => l.state === 'stalled');
    return { state: stalled ? 'stalled' : 'running', count: lanes.length, attributed: true };
  }
  // Fallback: the board owner cell, gated by session liveness.
  const ids = Array.isArray(tickets) ? tickets : [];
  let count = 0;
  for (const id of ids) {
    const hit = ticketIndex.get(id);
    if (hit && hit.state === 'prog') count++;
  }
  if (count === 0 || (live.known && live.live === 0)) return { state: 'idle', count, attributed: false };
  if (live.known && live.stalled) return { state: 'stalled', count, attributed: false };
  return { state: 'running', count, attributed: false };
}

/**
 * Join declared bindings against the live board + running snapshot into row
 * view-models. `bindings` is the server-owned request store's records (binding +
 * title + source + tickets, NO status). The two channels are computed
 * independently — see the header.
 *
 * @param {Array} bindings
 * @param {{ board?: object, snap?: object }} live
 * @returns {Array<{ id, title, source, tickets, exec, completion }>}
 */
export function joinRequests(bindings, { board = null, snap = null } = {}) {
  const list = Array.isArray(bindings) ? bindings : [];
  const ticketIndex = indexBoardTickets(board);
  const live = sessionLiveness(snap);
  const runningLanes = snap && Array.isArray(snap.running) ? snap.running : [];
  return list.map((b) => {
    const tickets = Array.isArray(b.tickets) ? b.tickets : [];
    return {
      id: b.id,
      title: b.title,
      source: b.source ?? null,
      tickets,
      exec: executionOf(tickets, ticketIndex, live, { requestId: b.id, runningLanes }),
      completion: completionOf(tickets, ticketIndex),
      // per-ticket detail for the expandable/next-step surface (Step 3/4 reuse)
      ticketStates: tickets.map((id) => {
        const hit = ticketIndex.get(id);
        return { id, state: hit ? hit.state : 'missing', item: hit ? hit.item : null };
      }),
    };
  });
}

/** A short, human completion label for the badge, from a completion read. */
export function completionLabel(c) {
  if (c.kind === 'none') return 'no tickets yet';
  if (c.kind === 'done') return 'done';
  if (c.kind === 'partial') return `${c.done}/${c.total} verified`;
  const missNote = c.missing ? ` · ${c.missing} missing` : '';
  return `open${missNote}`;
}

/** A short, human execution label for the badge, from an execution read. */
export function executionLabel(e) {
  if (e.state === 'stalled') return e.count > 1 ? `stalled · ${e.count}` : 'stalled';
  if (e.state === 'running') return `${e.count} running`;
  return 'idle';
}

/* ─────────────────────────── the row DOM (rendered, shared) ────────────────
 *
 * The row is built HERE, from injected DOM primitives (`el`, and an `onTicket`
 * click handler), so the app and any visual harness render the SAME code — the
 * two channels can never diverge into two implementations. `el(tag, attrs,
 * ...children)` is public/lib/dom.js's helper; a null child is skipped.
 */

/**
 * One request row. The SUMMARY (always visible) carries the state surface: the id,
 * the title, and the two INDEPENDENT channels. The BODY (collapsed by default —
 * Step 4) carries the routine detail: ticket chips, the source deep-link, and the
 * Needs-You route (Step 3). Routine per-lane detail never occupies the main
 * surface; the two channels always do, so "0 running" can never read as "done".
 *
 * Injected DOM primitives: `el` (public/lib/dom.js), `onTicket` (open a ticket),
 * `onNeeds` (route to the reused Needs-You rail for a 👤 blocker — Step 3, no
 * second rail), `onSource` (jump to the declaring user message — Step 4).
 */
export function buildRequestRow(r, { el, onTicket, onNeeds, onSource }) {
  const row = el('details', { class: 'req-row' });

  const head = el('summary', { class: 'req-head' },
    el('div', { class: 'req-head-line' },
      el('span', { class: 'req-id', text: r.id }),
      el('span', { class: 'req-title', text: r.title, title: r.title })));

  // The two channels — DELIBERATELY two elements from two independent reads. They
  // live in the summary so they are visible without expanding the row.
  const badges = el('div', { class: 'req-badges' });
  const execCls = r.exec.state === 'running' ? 'run' : r.exec.state === 'stalled' ? 'stall' : 'idle';
  badges.append(el('span', {
    class: `req-ch req-exec ${execCls}`,
    title: 'Execution — is work running for this request right now (live)',
  },
    r.exec.state === 'running' ? el('span', { class: 'req-gl', text: '▶', 'aria-hidden': 'true' }) : null,
    el('span', { class: 'req-ch-t', text: executionLabel(r.exec) })));

  const comp = r.completion;
  const compCls = comp.kind === 'done' ? 'st-done'
    : comp.kind === 'partial' ? 'st-prog'
    : comp.kind === 'none' ? 'none'
    : 'st-needs';
  badges.append(el('span', {
    class: `req-ch req-comp ${compCls}`,
    title: 'Completion — are this request’s tickets verified/done (from the board status)',
  }, el('span', { class: 'req-ch-t', text: completionLabel(comp) })));
  head.append(badges);
  row.append(head);

  // Body — collapsed by default (the <details> is closed).
  if (r.ticketStates.length) {
    const chips = el('div', { class: 'req-tickets' });
    for (const t of r.ticketStates) {
      const kind = t.state === 'done' ? 'st-done'
        : t.state === 'prog' ? 'st-prog'
        : t.state === 'needs' ? 'st-needs'
        : t.state === 'missing' ? 'missing'
        : 'open';
      const chip = el('button', {
        type: 'button',
        class: `req-tk ${kind}`,
        title: t.state === 'missing' ? `${t.id} — referenced ticket not on the board` : `${t.id} — open the ticket`,
      }, el('span', { class: 'req-tk-id', text: t.id }));
      if (t.state !== 'missing' && onTicket) chip.addEventListener('click', () => onTicket(t.id));
      else chip.disabled = true;
      chips.append(chip);
    }
    row.append(chips);
  }

  // Step 3 + 4 — the next-step / source meta line, in the collapsed body.
  const needsTicket = r.ticketStates.find((t) => t.state === 'needs');
  const meta = el('div', { class: 'req-meta' });
  if (needsTicket) {
    // Reuse the Needs-You rail (no second blocker surface). The row's next-step
    // routes DOWN to the existing Decide card for the 👤 ticket.
    const b = el('button', { type: 'button', class: 'req-needs', title: `${needsTicket.id} needs you — jump to the card below` },
      el('span', { class: 'req-needs-dot', text: '●', 'aria-hidden': 'true' }),
      el('span', { text: 'needs you' }));
    if (onNeeds) b.addEventListener('click', () => onNeeds(needsTicket.id));
    meta.append(b);
  }
  if (r.source) {
    const b = el('button', { type: 'button', class: 'req-source', title: 'Jump to the message that opened this request' },
      el('span', { class: 'req-source-gl', text: '⤴', 'aria-hidden': 'true' }),
      el('span', { text: 'source' }));
    if (onSource) b.addEventListener('click', () => onSource(r.source));
    meta.append(b);
  }
  if (meta.childNodes.length) row.append(meta);
  return row;
}

/**
 * Paint the "Your requests" section into `host` from the declared bindings joined
 * live against the board + snapshot. Returns true if the section is shown. When
 * there are no bindings the section is HIDDEN and emptied — the graceful
 * degradation to today's rail with no empty section. `clear`, `el` and an
 * `onTicket` handler are injected so this is the one renderer both the app and a
 * headless harness drive.
 */
export function renderRequestsInto(host, bindings, live, { el, clear, onTicket, onNeeds, onSource }) {
  clear(host);
  const list = Array.isArray(bindings) ? bindings : [];
  if (!list.length) { host.hidden = true; return false; }
  host.hidden = false;
  host.classList.add('requests');
  const rows = joinRequests(list, live);
  host.append(el('div', { class: 'sub-h', text: 'Your requests' }));
  for (const r of rows) host.append(buildRequestRow(r, { el, onTicket, onNeeds, onSource }));
  return true;
}
