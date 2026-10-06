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
import { spawn } from 'node:child_process';
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
  // Per-session storage (the FEAT-126 r3 data-loss fix): each session's bindings
  // live in dataDir()/requests/<enc(sid)>.json. Reading that file directly proves
  // the on-disk round-trip.
  const sessFile = path.join(scratch, 'requests', encodeURIComponent(SID) + '.json');
  const raw = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
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
function boardWith({ inflight = [], queued = [], done = [], needsYou = [], answeredAwaiting = [] } = {}) {
  return {
    hasBoard: true,
    inflight: inflight.map((id) => ({ id, title: id, owner: '🤖', status: 'IN-PROGRESS' })),
    queued: queued.map((id) => ({ id, title: id, owner: '—', status: 'OPEN' })),
    doneToday: done.map((id) => ({ id, title: id, owner: '', status: 'done' })),
    needsYou: needsYou.map((id) => ({ id, title: id, owner: '👤', status: 'OPEN' })),
    answeredAwaiting: answeredAwaiting.map((id) => ({ id, title: id, owner: '👤', status: 'OPEN' })),
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
  const sessFile = path.join(scratch, 'requests', encodeURIComponent(SID) + '.json');
  const full = fs.readFileSync(sessFile, 'utf8');
  const good = JSON.parse(full);
  // simulate the session's own file being read mid-write
  for (let cut = 0; cut <= full.length; cut++) {
    fs.writeFileSync(sessFile, full.slice(0, cut));
    let list;
    assert.doesNotThrow(() => { list = requests.listForSession(SID); }, `offset ${cut} threw`);
    // Either the intact set (only the full file parses) or an empty ledger.
    if (cut === full.length) assert.equal(list.length, 2);
    else assert.ok(list.length === 0 || list.length === 2, `offset ${cut} gave a partial/wrong set`);
  }
  // restore for cleanliness
  fs.writeFileSync(sessFile, JSON.stringify(good, null, 2));
});

/* ─── 6. DATA-LOSS: cross-session isolation under concurrency & torn reads ────
 *
 * FEAT-126 round-1 independent verify (run 25cdb5ae) found the store's write
 * path lost OTHER sessions' bindings: the old single shared requests.json was
 * mutated read-all → write-all, so a concurrent write from a stale read, or a
 * write that followed a torn/empty read, rewrote the whole file and wiped every
 * other session. These two tests reproduce that on the pre-fix tree (anchored to
 * the committed baseline — see the ticket's must-FAIL command) and pass on the
 * per-session-file design. Layout-independent: public API only. */

// (B) TORN-STORE, cross-session, deterministic: a brand-new session opening a
// request while the store is in a torn/partial state must not erase committed
// sessions. On the pre-fix shared-file design the new write reads [] from the
// torn shared file and rewrites it as [newRecord], wiping everyone. Per-session
// files keep each session's bindings in its own file, so a torn shared/legacy
// file cannot touch them, and the write path refuses to clobber an unreadable file.
T('DATA-LOSS (torn store): a new session\'s write over a torn store never erases committed sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat126-torn-'));
  const prev = process.env.CLAUDE_STATION_DATA;
  process.env.CLAUDE_STATION_DATA = dir;
  try {
    requests.observeAssistantText('sess-G', 'proj', [
      '```orchard-request', '{"id":"REQ-1","title":"G one","tickets":["T1"]}', '```',
      '```orchard-request', '{"id":"REQ-2","title":"G two","tickets":["T2"]}', '```',
      '```orchard-request', '{"id":"REQ-3","title":"G three","tickets":["T3"]}', '```',
    ].join('\n'));
    requests.observeAssistantText('sess-H', 'proj',
      '```orchard-request\n{"id":"REQ-4","title":"H four","tickets":["T4"]}\n```');
    assert.equal(requests.listForSession('sess-G').length, 3);
    assert.equal(requests.listForSession('sess-H').length, 1);
    // Torn the legacy shared file (where the pre-fix design keeps EVERY session's
    // bindings and what a new session's write reads). Post-fix this is inert.
    const shared = path.join(dir, 'requests.json');
    if (fs.existsSync(shared)) {
      const full = fs.readFileSync(shared, 'utf8');
      fs.writeFileSync(shared, full.slice(0, Math.max(1, Math.floor(full.length / 2))));
    } else {
      fs.writeFileSync(shared, '[{"id":"REQ-1","stationSes'); // inert torn stray under per-session layout
    }
    // A brand-new session K opens a request while the store is torn.
    requests.observeAssistantText('sess-K', 'proj',
      '```orchard-request\n{"id":"REQ-9","title":"K nine","tickets":["T9"]}\n```');
    assert.equal(requests.listForSession('sess-G').length, 3, 'sess-G bindings were wiped by an unrelated write over a torn store');
    assert.equal(requests.listForSession('sess-H').length, 1, 'sess-H bindings were wiped by an unrelated write over a torn store');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// (A) CONCURRENT, cross-session, real multi-process: N processes each the server
// for its OWN session write to the SAME data dir at once. Deterministically green
// on the per-session design (zero shared write target); reproduces lost updates
// on the pre-fix shared-file design (proven in the ticket's must-FAIL command).
async function concurrentWritersTest() {
  const name = 'DATA-LOSS (concurrent): parallel cross-session writers never drop another session\'s bindings';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat126-conc-'));
  const NPROC = 6, PER = 8;
  try {
    const reqPath = path.join(ROOT, 'src', 'server', 'requests.ts');
    const childSrc =
      `process.env.CLAUDE_STATION_DATA = ${JSON.stringify(dir)};\n` +
      `const r = await import(${JSON.stringify(reqPath)});\n` +
      `const sid = process.argv[2];\n` +
      `for (let i = 1; i <= ${PER}; i++) {\n` +
      `  r.observeAssistantText(sid, 'proj', '\\n\\n\`\`\`orchard-request\\n' + JSON.stringify({ id: 'REQ-' + i, title: sid + ' ' + i, tickets: ['T-' + i] }) + '\\n\`\`\`\\n');\n` +
      `}\n`;
    const childFile = path.join(dir, 'child.mjs');
    fs.writeFileSync(childFile, childSrc);
    const sids = Array.from({ length: NPROC }, (_, i) => `csess-${String.fromCharCode(65 + i)}`);
    await Promise.all(sids.map((sid) => new Promise((res, rej) => {
      const p = spawn(process.execPath, ['--experimental-strip-types', childFile, sid],
        { env: { ...process.env, CLAUDE_STATION_DATA: dir }, stdio: 'ignore' });
      p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`child ${sid} exit ${code}`))));
      p.on('error', rej);
    })));
    // Re-read each session from the store in a FRESH process (avoids any cache).
    const readerSrc =
      `process.env.CLAUDE_STATION_DATA = ${JSON.stringify(dir)};\n` +
      `const r = await import(${JSON.stringify(reqPath)});\n` +
      `const sids = ${JSON.stringify(sids)};\n` +
      `process.stdout.write(JSON.stringify(sids.map((s) => r.listForSession(s).length)));\n`;
    const readerFile = path.join(dir, 'reader.mjs');
    fs.writeFileSync(readerFile, readerSrc);
    const counts = await new Promise((res, rej) => {
      let out = '';
      const p = spawn(process.execPath, ['--experimental-strip-types', readerFile],
        { env: { ...process.env, CLAUDE_STATION_DATA: dir } });
      p.stdout.on('data', (d) => { out += d; });
      p.on('exit', (code) => (code === 0 ? res(JSON.parse(out)) : rej(new Error(`reader exit ${code}`))));
      p.on('error', rej);
    });
    assert.ok(counts.every((n) => n === PER),
      `some session lost bindings under concurrency: counts=${JSON.stringify(counts)} (expected all ${PER})`);
    pass++; console.log(`  ok   ${name}`);
  } catch (err) {
    fails.push(name); console.log(`  FAIL ${name}\n       ${err?.message ?? err}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
await concurrentWritersTest();

/* ─── 6b. WRONG-SHAPE session file (FEAT-126 r5 finding) ──────────────────────
 * A session file that is valid JSON of the WRONG SHAPE used to slip past the
 * parse-only check: `Array.isArray` alone accepted an array of malformed rows, so
 * a read THREW (sorting a row with no createdAt) and a write CLOBBERED the file.
 * Now readSession validates the FULL record shape (+ a size cap), so a wrong-shape
 * file is treated exactly like unreadable: the read returns empty and never
 * throws, and the write QUARANTINES the bytes aside (BUG-202 convention) and
 * self-heals, never clobbering — and never touching another session. */
{
  const VALID = { id: 'REQ-1', stationSessionId: 'x', projectId: 'p', title: 't', source: null, tickets: ['T1'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const noId = { ...VALID }; delete noId.id;
  const shapeCases = {
    'array-instead-of-object': '[[1,2,3]]',
    'top-level object not array': '{"id":"REQ-1"}',
    'missing field (no id)': JSON.stringify([noId]),
    'wrong field types': JSON.stringify([{ ...VALID, id: 5, tickets: 'nope', createdAt: null }]),
    'null': 'null',
    'huge file (>4MB)': '[' + '"x",'.repeat(1_200_000) + '"x"]',
  };
  for (const [label, content] of Object.entries(shapeCases)) {
    T(`WRONG-SHAPE (${label}): read empty+no-throw, write quarantines+self-heals, other session survives`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat126-shape-'));
      const prev = process.env.CLAUDE_STATION_DATA;
      process.env.CLAUDE_STATION_DATA = dir;
      try {
        requests.observeAssistantText('sess-good', 'p', '```orchard-request\n{"id":"REQ-9","title":"good","tickets":["T9"]}\n```');
        const goodBefore = requests.listForSession('sess-good').length;
        assert.equal(goodBefore, 1);
        const badFile = path.join(dir, 'requests', encodeURIComponent('sess-bad') + '.json');
        fs.mkdirSync(path.dirname(badFile), { recursive: true });
        fs.writeFileSync(badFile, content);
        // read: empty, never throws
        let len;
        assert.doesNotThrow(() => { len = requests.listForSession('sess-bad').length; });
        assert.equal(len, 0);
        // write: quarantines the corrupt bytes, self-heals to the fresh record
        assert.doesNotThrow(() => requests.observeAssistantText('sess-bad', 'p', '```orchard-request\n{"id":"REQ-2","title":"fresh","tickets":["T2"]}\n```'));
        const quar = fs.readdirSync(path.join(dir, 'requests')).filter((n) => n.includes('sess-bad') && n.includes('.corrupt-'));
        assert.equal(quar.length, 1, 'exactly one quarantine file');
        assert.equal(fs.readFileSync(path.join(dir, 'requests', quar[0]), 'utf8'), content, 'quarantined bytes preserved verbatim');
        assert.equal(requests.listForSession('sess-bad').length, 1, 'session self-healed to the fresh record');
        // cross-session: the healthy session is untouched throughout
        assert.equal(requests.listForSession('sess-good').length, goodBefore);
      } finally {
        if (prev === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prev;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

/* ─── 6c. Shared quarantine helper reaches this store (FEAT-126 r6) ───────────
 * requests.ts now routes quarantine through src/server/store-io.ts. These prove
 * the store benefits from the collision-safe quarantine (round-6 defects 1 & 2):
 * two corrupt events for the same session must PRESERVE both sets of bytes, never
 * overwrite the earlier one — even in the same millisecond. */
function corruptThenUpsert(dir, sid, badBytes, freshId) {
  const f = path.join(dir, 'requests', encodeURIComponent(sid) + '.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, badBytes);
  requests.observeAssistantText(sid, 'p', `\`\`\`orchard-request\n{"id":"${freshId}","title":"t","tickets":["T"]}\n\`\`\``);
}
const reqCorruptFiles = (dir, sid) =>
  fs.readdirSync(path.join(dir, 'requests')).filter((n) => n.startsWith(encodeURIComponent(sid) + '.json.corrupt-'));

T('SHARED QUARANTINE (requests) defects 1&2: two same-millisecond quarantines both survive (no-clobber)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat126-q1-'));
  const prev = process.env.CLAUDE_STATION_DATA; process.env.CLAUDE_STATION_DATA = dir;
  const realNow = Date.now; Date.now = () => 1_790_000_000_000; // frozen clock — a timestamp-only name would collide
  try {
    corruptThenUpsert(dir, 'sess-q', '[[1]]', 'REQ-1');           // first corrupt bytes
    corruptThenUpsert(dir, 'sess-q', '{"not":"array"}', 'REQ-2'); // second corrupt bytes, same ms
    const q = reqCorruptFiles(dir, 'sess-q');
    assert.equal(q.length, 2, 'both quarantines preserved (no overwrite despite same-ms)');
    const bodies = q.map((n) => fs.readFileSync(path.join(dir, 'requests', n), 'utf8')).sort();
    assert.deepEqual(bodies, ['[[1]]', '{"not":"array"}'].sort(), 'both sets of corrupt bytes preserved verbatim');
    assert.equal(requests.listForSession('sess-q').length, 1, 'self-healed to the latest fresh record');
  } finally {
    Date.now = realNow;
    if (prev === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

T('SHARED QUARANTINE (requests) defect 3: an oversized VALID-JSON session file is refused (fd-bounded), quarantined, self-heals', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat126-q3-'));
  const prev = process.env.CLAUDE_STATION_DATA; process.env.CLAUDE_STATION_DATA = dir;
  try {
    // > 4 MB and a valid array of VALID RequestRecords: an unbounded read would
    // parse it AND pass shape validation (admitting it); only the fd-bounded read
    // refuses it as too-big before reading it all.
    const rec = JSON.stringify({ id: 'REQ-9', stationSessionId: 'sess-big', projectId: 'p', title: 't', source: null, tickets: ['T'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    const huge = '[' + (rec + ',').repeat(35_000) + rec + ']'; // ~4.5 MB of valid records
    assert.ok(huge.length > 4 * 1024 * 1024);
    corruptThenUpsert(dir, 'sess-big', huge, 'REQ-1');
    const q = reqCorruptFiles(dir, 'sess-big');
    assert.equal(q.length, 1, 'oversized file quarantined (not read unbounded, not clobbered)');
    assert.equal(fs.statSync(path.join(dir, 'requests', q[0])).size, huge.length, 'oversized bytes preserved');
    assert.equal(requests.listForSession('sess-big').length, 1, 'self-healed to the fresh record');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ─── 7. The round-1 independent-verify findings (FEAT-126 r4) ────────────────
 * Each reproduces on the pre-fix tree (proven in the ticket's must-FAIL command
 * against the committed baseline) and holds on the fix. */

T('FINDING 1 (fence-inert): an orchard-request inside a MULTI-TOKEN info-string fence declares nothing', () => {
  const turn = [
    'For reference (not a declaration):',
    '```markdown title=example',
    '```orchard-request',
    '{ "id": "REQ-999", "title": "quoted example", "tickets": [] }',
    '```',
    '```',
  ].join('\n');
  const ids = requests.parseRequestsFromText(turn).map((d) => d.id);
  assert.ok(!ids.includes('REQ-999'), `a quoted block inside \`\`\`markdown title= must stay inert; got ${JSON.stringify(ids)}`);
});

T('FINDING 2 (conflict→gap): two DISAGREEING blocks for one id in one turn yield nothing', () => {
  const turn = [
    '```orchard-request', '{ "id": "REQ-5", "title": "Title one", "tickets": ["FEAT-1"] }', '```',
    '```orchard-request', '{ "id": "REQ-5", "title": "Title two", "tickets": ["FEAT-2"] }', '```',
  ].join('\n');
  assert.equal(requests.parseRequestsFromText(turn).filter((d) => d.id === 'REQ-5').length, 0);
  // identical repeats collapse to one — not a false conflict, not two rows
  const same = [
    '```orchard-request', '{ "id": "REQ-6", "title": "Same", "tickets": ["FEAT-9"] }', '```',
    '```orchard-request', '{ "id": "REQ-6", "title": "Same", "tickets": ["FEAT-9"] }', '```',
  ].join('\n');
  assert.equal(requests.parseRequestsFromText(same).filter((d) => d.id === 'REQ-6').length, 1);
});

T('FINDING 3a: an answered-awaiting ticket is indexed (not reported missing)', () => {
  const board = boardWith({ answeredAwaiting: ['FEAT-1'] });
  const [r] = view.joinRequests([{ id: 'REQ-1', title: 't', tickets: ['FEAT-1'] }], { board, snap: { v: 1, running: [] } });
  assert.notEqual(r.ticketStates[0].state, 'missing');
  assert.equal(r.completion.missing, 0);
  assert.notEqual(r.completion.kind, 'done'); // answered ≠ done — still NOT complete
});

T('FINDING 4 (sibling attribution): a lane declared to REQ-8 does NOT light REQ-7', () => {
  const bindings = [
    { id: 'REQ-7', title: 'seven', tickets: ['FEAT-126'] },
    { id: 'REQ-8', title: 'eight', tickets: ['BUG-200'] },
  ];
  const board = boardWith({ inflight: ['FEAT-126'], queued: ['BUG-200'] });
  const snap = { v: 1, running: [{ id: 'lane-b', row: 'agent', state: 'running', ticket: ['BUG-200'] }] };
  const [r7, r8] = view.joinRequests(bindings, { board, snap });
  assert.equal(r7.exec.state, 'idle', 'REQ-7 must not be lit by REQ-8\'s attributed lane');
  assert.equal(r8.exec.state, 'running'); // REQ-8 itself is genuinely running
});

T('FINDING 5 (unconfirmed motion): with no snapshot, a 🤖 ticket reads idle, never running', () => {
  const board = boardWith({ inflight: ['FEAT-126'] });
  const [r] = view.joinRequests([{ id: 'REQ-7', title: 'seven', tickets: ['FEAT-126'] }], { board, snap: null });
  assert.equal(r.exec.state, 'idle');
});

/* ─────────────────────────────────── summary ─────────────────────────────── */
fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.error('FAILURES:\n  ' + fails.join('\n  ')); process.exit(1); }
