#!/usr/bin/env node
/**
 * FEAT-126 Step 1 — the DECLARED request binding + the server-owned store.
 *
 *   node scripts/verify-feat-126-requests-store.mjs
 *
 * WHAT IS BEING PROVEN (not "a parser parses"):
 *  1. The request is a DECLARED fact on two surfaces the orchestrator already
 *     writes — a `request=REQ-N` key on the `Dispatch:` line, and a leading
 *     `orchard-request` fenced block — read with the SAME two strictnesses the
 *     dispatch grammar uses (a quote inside a fence declares nothing; two
 *     declarations that disagree yield nothing / a gap, never a guess).
 *  2. The store holds ONLY the binding (id + title + source + tickets). It has
 *     NO status field — the keystone that makes the surface unable to go stale.
 *  3. The live JOIN (public/lib/requests-view.js) computes execution and
 *     completion as TWO INDEPENDENT READS, and MUTATING the board moves the row
 *     with it — the view has no cached copy to disagree from. The invariant:
 *     0 running lanes + an open ticket is NEVER "done".
 *  4. The store is written while it is read (another session's turn writes
 *     concurrently), so a PARTIAL/TRUNCATED read must yield the last intact
 *     ledger or an empty one — never a thrown error, never a wrong value.
 *
 * REAL vs SYNTHETIC: the store + parsers run for real against a scratch data dir
 * (CLAUDE_STATION_DATA). The assistant-frame text and board payloads are
 * SYNTHETIC but shaped like a busy real session — several requests, mixed
 * running/idle/died/verified, a missing ticket, a quoted grammar example.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseDispatchDeclaration,
  formatDispatchDeclaration,
} from '../scripts/lib/cost-model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0;
const fails = [];
function T(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (err) { fails.push(name); console.log(`  FAIL ${name}\n       ${err?.message ?? err}`); }
}

// Scratch data dir so the real store never touches the user's live one.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'feat126-'));
process.env.CLAUDE_STATION_DATA = scratch;

const requests = await import(path.join(ROOT, 'src', 'server', 'requests.ts'));
const view = await import(path.join(ROOT, 'public', 'lib', 'requests-view.js'));

/* ─────────────────────────── 1. the Dispatch `request=` key ─────────────── */

T('request= parses off the Dispatch line', () => {
  const d = parseDispatchDeclaration('Dispatch: ticket=FEAT-126 phase=fixing round=1 class=fix request=REQ-7');
  assert.equal(d.request, 'REQ-7');
  assert.deepEqual(d.tickets, ['FEAT-126']);
});

T('an absent request= is a gap (null), not a guess', () => {
  const d = parseDispatchDeclaration('Dispatch: ticket=FEAT-126 class=fix');
  assert.equal(d.request, null);
  assert.equal(d.present, true);
});

T('a malformed request id is rejected, surfaced, and left null', () => {
  const d = parseDispatchDeclaration('Dispatch: ticket=FEAT-1 request=banana');
  assert.equal(d.request, null);
  assert.ok(d.rejected.some((r) => r.includes('request=banana')));
});

T('two DISAGREEING request declarations yield nothing (conflict), never the first', () => {
  const d = parseDispatchDeclaration('Dispatch: request=REQ-7\nDispatch: request=REQ-9');
  assert.equal(d.request, null);
  assert.equal(d.conflict, true);
});

T('identical repeated request declarations collapse to one value', () => {
  const d = parseDispatchDeclaration('Dispatch: request=REQ-7\nDispatch: request=REQ-7');
  assert.equal(d.request, 'REQ-7');
  assert.equal(d.conflict, false);
});

T('a Dispatch line QUOTED inside a fence declares no request', () => {
  const d = parseDispatchDeclaration('```\nDispatch: request=REQ-7\n```\nprose');
  assert.equal(d.request, null);
  assert.equal(d.present, false);
});

T('formatDispatchDeclaration round-trips request=', () => {
  const line = formatDispatchDeclaration({ ticket: 'FEAT-126', class: 'fix', request: 'REQ-7' });
  const d = parseDispatchDeclaration(line);
  assert.equal(d.request, 'REQ-7');
  assert.deepEqual(d.tickets, ['FEAT-126']);
});

/* ─────────────────────────── 2. the orchard-request block parser ─────────── */

const BUSY_TURN = [
  'Here is where things stand.',
  '',
  '```orchard-request',
  '{ "id": "REQ-7", "title": "Persistent request-centred status view", "source": "u-abc-123", "tickets": ["FEAT-126", "FEAT-127"] }',
  '```',
  '',
  'And I am also opening a second thread:',
  '',
  '```orchard-request',
  '{ "id": "REQ-8", "title": "Fix the sidebar cap", "source": "u-def-456", "tickets": ["BUG-200"] }',
  '```',
  '',
  'For reference, the grammar looks like this (do NOT treat as a declaration):',
  '',
  '```bash',
  'echo \'```orchard-request',
  '{ "id": "REQ-999", "title": "quoted example", "tickets": [] }',
  '```\'',
  '```',
].join('\n');

T('every top-level orchard-request block is parsed; a quoted one is ignored', () => {
  const decls = requests.parseRequestsFromText(BUSY_TURN);
  const ids = decls.map((d) => d.id).sort();
  assert.deepEqual(ids, ['REQ-7', 'REQ-8']);
  assert.ok(!ids.includes('REQ-999'), 'a quoted example inside a bash fence must not declare');
});

T('a malformed / no-id / no-title block yields nothing (a gap, not a fabrication)', () => {
  assert.equal(requests.parseRequestDeclaration('{ not json'), null);
  assert.equal(requests.parseRequestDeclaration('{ "title": "no id here" }'), null);
  assert.equal(requests.parseRequestDeclaration('{ "id": "REQ-7" }'), null); // no title
  assert.equal(requests.parseRequestDeclaration('{ "id": "nope", "title": "bad id" }'), null);
});

/* ─────────────────────────── 3. the store: binding only, latest-wins ─────── */

const SID = 'station-sess-1';

T('observeAssistantText upserts every declared request for the session', () => {
  requests.observeAssistantText(SID, 'proj-1', BUSY_TURN);
  const list = requests.listForSession(SID);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((r) => r.id), ['REQ-7', 'REQ-8']); // declaration order
});

T('the stored record holds NO status field — the anti-staleness keystone', () => {
  const [rec] = requests.listForSession(SID);
  const keys = Object.keys(rec).sort();
  assert.deepEqual(keys, ['createdAt', 'id', 'projectId', 'source', 'stationSessionId', 'tickets', 'title', 'updatedAt']);
  for (const forbidden of ['status', 'exec', 'execution', 'completion', 'verified', 'done', 'running', 'state']) {
    assert.ok(!(forbidden in rec), `a request record must never cache a "${forbidden}" status`);
  }
});

T('re-declaring the same id is latest-wins (title/tickets update in place, no duplicate row)', () => {
  requests.observeAssistantText(SID, 'proj-1',
    '```orchard-request\n{ "id": "REQ-7", "title": "Renamed", "source": "u-abc-123", "tickets": ["FEAT-126"] }\n```');
  const list = requests.listForSession(SID);
  assert.equal(list.length, 2, 'still two requests, not three');
  const r7 = list.find((r) => r.id === 'REQ-7');
  assert.equal(r7.title, 'Renamed');
  assert.deepEqual(r7.tickets, ['FEAT-126']);
});

T('bindings survive a fresh read of the store (server-owned, persisted)', () => {
  // A brand-new import context reading the same file would see the same rows;
  // here re-reading through the same module already proves the on-disk round-trip.
  const raw = JSON.parse(fs.readFileSync(path.join(scratch, 'requests.json'), 'utf8'));
  assert.equal(raw.filter((r) => r.stationSessionId === SID).length, 2);
});

T('a different session sees only its own requests', () => {
  requests.observeAssistantText('station-sess-2', 'proj-2',
    '```orchard-request\n{ "id": "REQ-1", "title": "Other session", "tickets": [] }\n```');
  assert.equal(requests.listForSession(SID).length, 2);
  assert.equal(requests.listForSession('station-sess-2').length, 1);
});

/* ─────────────────────────── 4. the LIVE JOIN — two independent reads ─────── */

// A synthetic board shaped like a busy session: one verified, one in-flight
// (a lane on it), one queued-open, and a request referencing a missing ticket.
function boardWith({ inflight = [], queued = [], done = [], needsYou = [] } = {}) {
  return {
    hasBoard: true,
    inflight: inflight.map((id) => ({ id, title: id, owner: '🤖', status: 'IN-PROGRESS' })),
    queued: queued.map((id) => ({ id, title: id, owner: '—', status: 'OPEN' })),
    doneToday: done.map((id) => ({ id, title: id, owner: '', status: 'done' })),
    needsYou: needsYou.map((id) => ({ id, title: id, owner: '👤', status: 'OPEN' })),
  };
}
const bindingsForJoin = [
  { id: 'REQ-7', title: 'Big feature', source: 'u1', tickets: ['FEAT-126', 'FEAT-127'] },
  { id: 'REQ-8', title: 'Small fix', source: 'u2', tickets: ['BUG-200'] },
  { id: 'REQ-9', title: 'Ghost', source: 'u3', tickets: ['BUG-999'] }, // ticket not on the board
];

T('THE INVARIANT: 0 running lanes + an open ticket renders NOT done (idle · open)', () => {
  const board = boardWith({ queued: ['FEAT-126', 'FEAT-127'] });
  const snap = { v: 1, running: [] }; // nothing live
  const [r7] = view.joinRequests(bindingsForJoin, { board, snap });
  assert.equal(r7.exec.state, 'idle');
  assert.notEqual(r7.completion.kind, 'done');
  assert.equal(view.completionLabel(r7.completion), 'open');
  assert.equal(view.executionLabel(r7.exec), 'idle');
});

T('done requires EVERY bound ticket done — regardless of lane count', () => {
  const board = boardWith({ done: ['FEAT-126', 'FEAT-127'] });
  const snap = { v: 1, running: [] };
  const [r7] = view.joinRequests(bindingsForJoin, { board, snap });
  assert.equal(r7.completion.kind, 'done');
  // Only one of two done → partial, never done.
  const board2 = boardWith({ done: ['FEAT-126'], queued: ['FEAT-127'] });
  const [r7b] = view.joinRequests(bindingsForJoin, { board: board2, snap });
  assert.equal(r7b.completion.kind, 'partial');
  assert.equal(view.completionLabel(r7b.completion), '1/2 verified');
});

T('execution reads the OWNER column (🤖) gated by live session liveness', () => {
  const board = boardWith({ inflight: ['FEAT-126'], queued: ['FEAT-127'] });
  const liveSnap = { v: 1, running: [{ id: 'a', row: 'agent', state: 'running' }] };
  const [r7] = view.joinRequests(bindingsForJoin, { board, snap: liveSnap });
  assert.equal(r7.exec.state, 'running');
  assert.equal(r7.exec.count, 1);
  // Board says 🤖 but the live snapshot shows nothing running → idle, not a lie.
  const [r7idle] = view.joinRequests(bindingsForJoin, { board, snap: { v: 1, running: [] } });
  assert.equal(r7idle.exec.state, 'idle');
  // A stalled live lane surfaces as stalled, never as moss motion.
  const stallSnap = { v: 1, running: [{ id: 'a', row: 'agent', state: 'stalled' }] };
  const [r7stall] = view.joinRequests(bindingsForJoin, { board, snap: stallSnap });
  assert.equal(r7stall.exec.state, 'stalled');
});

T('PER-LANE ATTRIBUTION: a lane declared to REQ-7 (by ticket) marks ONLY REQ-7 running', () => {
  // Two requests, distinct tickets, both OPEN on the board (queued — no 🤖 owner).
  // One live lane carries ticket=FEAT-126 (REQ-7's). The session is live.
  const board = boardWith({ queued: ['FEAT-126', 'FEAT-127', 'BUG-200'] });
  const snap = { v: 1, running: [{ id: 'lane-a', row: 'agent', state: 'running', ticket: ['FEAT-126'] }] };
  const [r7, r8] = view.joinRequests(bindingsForJoin, { board, snap });
  // REQ-7: attributed lane → running, true count 1, attributed flag set.
  assert.equal(r7.exec.state, 'running');
  assert.equal(r7.exec.count, 1);
  assert.equal(r7.exec.attributed, true);
  // REQ-8 (BUG-200) has NO attributed lane and NO 🤖 owner cell → idle, even though
  // the session is live. This is the gap the coarse owner-column read could not close.
  assert.equal(r8.exec.state, 'idle');
});

T('PER-LANE ATTRIBUTION: a lane declared to REQ-7 by request id (no ticket match) still attributes', () => {
  const board = boardWith({ queued: ['FEAT-126', 'FEAT-127'] });
  const snap = { v: 1, running: [{ id: 'lane-a', row: 'agent', state: 'running', request: 'REQ-7' }] };
  const [r7] = view.joinRequests(bindingsForJoin, { board, snap });
  assert.equal(r7.exec.state, 'running');
  assert.equal(r7.exec.attributed, true);
});

T('PER-LANE ATTRIBUTION: a stalled attributed lane surfaces stalled, not moss motion', () => {
  const board = boardWith({ queued: ['FEAT-126'] });
  const snap = { v: 1, running: [{ id: 'lane-a', row: 'agent', state: 'stalled', ticket: ['FEAT-126'] }] };
  const [r7] = view.joinRequests(bindingsForJoin, { board, snap });
  assert.equal(r7.exec.state, 'stalled');
  assert.equal(r7.exec.attributed, true);
});

T('PER-LANE ATTRIBUTION never fabricates completion: an attributed running lane on an OPEN ticket is still NOT done', () => {
  const board = boardWith({ queued: ['FEAT-126', 'FEAT-127'] });
  const snap = { v: 1, running: [{ id: 'lane-a', row: 'agent', state: 'running', ticket: ['FEAT-126'] }] };
  const [r7] = view.joinRequests(bindingsForJoin, { board, snap });
  // Execution and completion remain TWO INDEPENDENT reads — running does not imply done.
  assert.equal(r7.exec.state, 'running');
  assert.notEqual(r7.completion.kind, 'done');
});

T('DEGRADES: an undeclared lane (no ticket/request) falls back to the owner-column read', () => {
  const board = boardWith({ inflight: ['FEAT-126'], queued: ['FEAT-127'] });
  const snap = { v: 1, running: [{ id: 'lane-a', row: 'agent', state: 'running' }] }; // no attribution
  const [r7] = view.joinRequests(bindingsForJoin, { board, snap });
  assert.equal(r7.exec.state, 'running');
  assert.equal(r7.exec.attributed, false); // coarse read, exactly today's behaviour
});

T('NO CACHED STATUS: mutating the board moves the row with it (join has no copy)', () => {
  const snap = { v: 1, running: [] };
  const open = view.joinRequests(bindingsForJoin, { board: boardWith({ queued: ['FEAT-126', 'FEAT-127'] }), snap });
  assert.notEqual(open[0].completion.kind, 'done');
  // Same bindings, board flipped to verified — the row must now read done.
  const verified = view.joinRequests(bindingsForJoin, { board: boardWith({ done: ['FEAT-126', 'FEAT-127'] }), snap });
  assert.equal(verified[0].completion.kind, 'done');
});

T('a referenced ticket the board no longer has is reported missing, never fabricated done', () => {
  const [, , r9] = view.joinRequests(bindingsForJoin, { board: boardWith({}), snap: { v: 1, running: [] } });
  assert.equal(r9.completion.missing, 1);
  assert.notEqual(r9.completion.kind, 'done');
  assert.equal(r9.ticketStates[0].state, 'missing');
});

T('a request with no tickets degrades to "no tickets yet", not an error', () => {
  const [r] = view.joinRequests([{ id: 'REQ-0', title: 'Nothing filed', tickets: [] }], { board: boardWith({}), snap: null });
  assert.equal(r.completion.kind, 'none');
  assert.equal(view.completionLabel(r.completion), 'no tickets yet');
});

/* ─────────────────────────── 5. PARTIAL / TRUNCATED read tolerance ────────── */

T('a truncated store file at EVERY byte offset yields a clean list or empty — never a throw or wrong value', () => {
  const full = fs.readFileSync(path.join(scratch, 'requests.json'), 'utf8');
  const good = JSON.parse(full);
  // simulate the file being read mid-write by another session's turn
  const tmp = path.join(scratch, 'requests.json');
  for (let cut = 0; cut <= full.length; cut++) {
    fs.writeFileSync(tmp, full.slice(0, cut));
    let list;
    assert.doesNotThrow(() => { list = requests.listForSession(SID); }, `offset ${cut} threw`);
    // Either the intact set (only the full file parses) or an empty ledger.
    if (cut === full.length) assert.equal(list.length, 2);
    else assert.ok(list.length === 0 || list.length === 2, `offset ${cut} gave a partial/wrong set`);
  }
  // restore for cleanliness
  fs.writeFileSync(tmp, JSON.stringify(good, null, 2));
});

/* ─────────────────────────────────── summary ─────────────────────────────── */
fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.error('FAILURES:\n  ' + fails.join('\n  ')); process.exit(1); }
