/**
 * BUG-193 — headless/scripted sessions must not clutter the nav list.
 *
 * Proof bar (task charter):
 *   1. MUST-FAIL: an external `sdk-cli` session (no Orchard provenance) was
 *      LISTED before the fix — the pre-fix fold only folded startedBy 'agent'.
 *   2. That same external session now FOLDS (foldsFromDefaultList === true).
 *   3. An Orchard-launched `sdk-ts` dashboard session (provenance startedBy
 *      'user') stays SHOWN.
 *   4. A legacy transcript with NO entrypoint field stays SHOWN.
 *   5. An Orchard dispatch lane (startedBy 'agent') folds — the pre-existing
 *      behaviour is preserved.
 *   6. readSessionMeta actually recovers `entrypoint` from the real transcript
 *      head (cheap: sample scan only).
 *
 * Tests run against the user's REAL store + REAL provenance dir (CONVENTIONS:
 * test the real artifact). If a chosen real id has gone from the store, the
 * test SKIPS that case LOUDLY rather than passing vacuously.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  foldsFromDefaultList,
  isProgrammaticEntrypoint,
  readSessionProvenance,
  resolveStartedBy,
} from '../src/lib/session-provenance.mjs';
import { readSessionMeta } from '../src/lib/session-history.ts';

const PROJ = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
};
const skipLoud = (name, why) => { skip++; console.log(`SKIP ${name} — ${why}`); };

/** Find the real transcript path for a session id anywhere under the store. */
function findTranscript(sessionId) {
  let dirs;
  try { dirs = fs.readdirSync(PROJ, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = path.join(PROJ, d.name, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return { filePath: p, encodedDir: d.name };
  }
  return null;
}

/**
 * The PRE-FIX fold predicate, synthesized here so the must-FAIL proof is anchored
 * to a fixed baseline (CONVENTIONS: never anchor a must-fail to a moving ref).
 * Before this fix the client folded a row iff resolveStartedBy === 'agent'.
 */
const preFixFolds = (sessionId, firstUserMessage, record) =>
  resolveStartedBy({ sessionId, firstUserMessage, record }) === 'agent';

// ---- pure-unit invariants (no store dependency) --------------------------
ok('isProgrammaticEntrypoint: sdk-cli is programmatic', isProgrammaticEntrypoint('sdk-cli') === true);
ok('isProgrammaticEntrypoint: sdk-ts is programmatic', isProgrammaticEntrypoint('sdk-ts') === true);
ok('isProgrammaticEntrypoint: cli is NOT programmatic', isProgrammaticEntrypoint('cli') === false);
ok('isProgrammaticEntrypoint: missing/blank is NOT programmatic (legacy stays shown)',
  isProgrammaticEntrypoint(null) === false && isProgrammaticEntrypoint('') === false && isProgrammaticEntrypoint(undefined) === false);

// no record + programmatic entrypoint => fold; no record + interactive/legacy => show
ok('foldsFromDefaultList: external sdk-cli, no record => FOLD',
  foldsFromDefaultList({ entrypoint: 'sdk-cli', record: null }) === true);
ok('foldsFromDefaultList: interactive cli, no record => SHOW',
  foldsFromDefaultList({ entrypoint: 'cli', record: null }) === false);
ok('foldsFromDefaultList: legacy no-entrypoint, no record => SHOW',
  foldsFromDefaultList({ entrypoint: null, record: null }) === false);
ok('foldsFromDefaultList: dashboard record user + sdk-ts => SHOW',
  foldsFromDefaultList({ entrypoint: 'sdk-ts', record: { startedBy: 'user' } }) === false);
ok('foldsFromDefaultList: dispatch record agent => FOLD',
  foldsFromDefaultList({ entrypoint: 'sdk-cli', record: { startedBy: 'agent' } }) === true);
ok('foldsFromDefaultList: no record but Dispatch: line => FOLD (pre-existing lane)',
  foldsFromDefaultList({ entrypoint: 'cli', firstUserMessage: 'Dispatch: ticket=BUG-1 phase=fixing round=1 class=fix' }) === true);

// ---- round 2: counts/badges must exclude folded rows ---------------------
// The client (public/app.js) reads the SERVER's `foldByDefault` — never
// recomputing the fold — via `foldsFromList`. These mirror that exact predicate
// so the header count / unseen badge / empty-state semantics are pinned here.
const clientFolds = (sess) =>
  (typeof sess?.foldByDefault === 'boolean' ? sess.foldByDefault : sess?.startedBy === 'agent');
const listedCount = (list) => list.filter((x) => !clientFolds(x)).length;      // header count / empty-state
const unseenListed = (list) => list.filter((x) => !clientFolds(x) && x.unseen).length; // unseen badge

// A realistic all-hidden project: dispatch lanes + external programmatic rows,
// exactly what the server would emit foldByDefault=true for.
const allHidden = [
  { sessionId: 'a', foldByDefault: true, startedBy: 'agent', unseen: true },
  { sessionId: 'b', foldByDefault: true, startedBy: 'user', unseen: true },  // external sdk-cli
  { sessionId: 'c', foldByDefault: true, startedBy: 'agent', unseen: false },
];
// MUST-FAIL(before): the pre-fix header count was the naive list length (3), so an
// all-hidden project read "3" (finding 3 saw "1"); anchored to the fixed naive count.
ok('MUST-FAIL(before): naive list length counts folded rows (3 != 0)',
  allHidden.length === 3 && allHidden.length !== listedCount(allHidden));
ok('round2: all-hidden project header count === 0', listedCount(allHidden) === 0);
ok('round2: all-hidden project unseen badge === 0', unseenListed(allHidden) === 0);

const mixed = [
  { sessionId: 'd', foldByDefault: false, startedBy: 'user', unseen: true },   // interactive/dashboard
  { sessionId: 'e', foldByDefault: true, startedBy: 'agent', unseen: true },   // dispatch lane
  { sessionId: 'f', foldByDefault: false, startedBy: 'user', unseen: false },  // interactive
  { sessionId: 'g', foldByDefault: true, startedBy: 'user', unseen: true },    // external sdk-cli
];
ok('round2: mixed project header count counts only non-folded (2)', listedCount(mixed) === 2);
ok('round2: mixed project unseen badge counts only non-folded unseen (1)', unseenListed(mixed) === 1);
// Fallback path (older server: no foldByDefault) still folds agent lanes.
ok('round2: fallback folds agent lane when foldByDefault absent',
  listedCount([{ sessionId: 'h', startedBy: 'agent', unseen: true }]) === 0);

// ---- real-artifact cases -------------------------------------------------
const EXTERNAL = 'c3795424-fdc6-4229-90bc-f408b9767447'; // sdk-cli "say ok2", trading-volume, NO provenance
const DASHBOARD = '4fb289a9-e337-4174-a9ba-cc85b0c0b48a'; // sdk-ts, provenance startedBy 'user'
const LEGACY = '6850e3b6-ffe9-42f8-b977-f96b36fbc563'; // no entrypoint field, no provenance

function realCase(label, sessionId, expectFold, expectEntrypoint, expectStartedByOfRecord) {
  const t = findTranscript(sessionId);
  if (!t) return skipLoud(`real:${label}`, `transcript ${sessionId} not in store any more`);
  const meta = readSessionMeta(t.filePath, t.encodedDir);
  if (!meta) return skipLoud(`real:${label}`, `readSessionMeta null for ${sessionId}`);
  const record = readSessionProvenance(sessionId);
  ok(`real:${label} entrypoint recovered from head === ${JSON.stringify(expectEntrypoint)}`,
    meta.entrypoint === expectEntrypoint);
  if (expectStartedByOfRecord !== undefined) {
    ok(`real:${label} provenance record startedBy === ${expectStartedByOfRecord}`,
      (record?.startedBy ?? null) === expectStartedByOfRecord);
  }
  const folds = foldsFromDefaultList({
    sessionId, entrypoint: meta.entrypoint, firstUserMessage: meta.firstUserMessage, record,
  });
  ok(`real:${label} foldsFromDefaultList === ${expectFold}`, folds === expectFold);
  return { meta, record, folds };
}

// Case 1 + 2: external sdk-cli — MUST-FAIL proof then the fix.
{
  const t = findTranscript(EXTERNAL);
  if (!t) skipLoud('real:external must-fail', `transcript ${EXTERNAL} not in store`);
  else {
    const meta = readSessionMeta(t.filePath, t.encodedDir);
    const record = readSessionProvenance(EXTERNAL);
    // MUST-FAIL: pre-fix logic did NOT fold it (it was listed) — the bug.
    ok('MUST-FAIL(before): external sdk-cli was LISTED (pre-fix fold === false)',
      preFixFolds(EXTERNAL, meta?.firstUserMessage, record) === false);
  }
}
realCase('external sdk-cli (hide)', EXTERNAL, true, 'sdk-cli', null);
realCase('orchard dashboard sdk-ts (show)', DASHBOARD, false, 'sdk-ts', 'user');
realCase('legacy no-entrypoint (show)', LEGACY, false, null, null);

// ---- round 4: the OPEN folded session must NOT plant itself in the nav ----
// The server correctly classifies an openai dispatch/verify lane as
// foldByDefault=true (see the real-artifact cases above). The round-4 report was
// that such a lane STILL appeared in a project's nav — because it was the
// currently-OPEN session and `visibleSessions` force-adds the open row via
// `isAlwaysVisible`, resurrecting a folded programmatic row the user only
// deep-linked into. This boots the REAL app.js in happy-dom and drives the REAL
// `visibleSessions` (nothing here re-derives the fold/window rules), asserting:
//   - MUST-FAIL(before): the open FOLDED lane appears in the default rows.
//   - after: it does NOT appear (but a non-folded open session still does —
//     BUG-085's "open session never vanishes" is preserved for real sessions);
//   - a folded LIVE lane still shows (running work is never hidden);
//   - "N more" (windowed:false) reveals the folded open lane (reachable, not deleted).
async function browserScenario() {
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const { Window } = await import('happy-dom');
  const WebSocket = (await import('ws')).default;
  const { findNeighborProject } = await import('./lib/neighbor-project.mjs');
  const ROOT = path.resolve(import.meta.dirname, '..');
  const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug193-data-'));
  const NEIGHBOR = findNeighborProject({ excludePath: ROOT });
  const NB = path.basename(NEIGHBOR);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const freePort = () => new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  let server = null;
  let win = null;
  const prev = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window, location: globalThis.location };
  const openSockets = [];
  try {
    server = spawn(process.execPath, [ENTRY], {
      cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA },
      stdio: ['ignore', 'ignore', 'pipe'], detached: true,
    });
    server.stderr?.on('data', () => {});
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
    if (!up) throw new Error('scratch server never became healthy');
    await fetch(`${BASE}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostPath: NEIGHBOR, name: NB }),
    });

    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    win = new Window({ url: `${BASE}/` });
    const doc = win.document;
    doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
    doc.close();
    const realFetch = globalThis.fetch;
    win.fetch = (input, init) => realFetch(input.startsWith('http') ? input : BASE + input, init);
    class TrackedWebSocket extends WebSocket {
      constructor(...a) { super(...a); this.on('error', () => {}); openSockets.push(this); }
    }
    win.WebSocket = TrackedWebSocket;
    win.location.host = `127.0.0.1:${PORT}`;
    globalThis.document = doc; globalThis.window = win; globalThis.location = win.location;
    globalThis.WebSocket = win.WebSocket; globalThis.fetch = win.fetch;

    await import(`${path.join(ROOT, 'public', 'app.js')}?ui=${Date.now()}`);
    const qa = (s) => [...doc.querySelectorAll(s)];
    for (let i = 0; i < 200 && qa('#tree button.proj').length === 0; i++) await sleep(100);

    const S = win.__station;
    const st = S.state;
    const PID = 'p-193', ENC = 'enc-193';
    // a real-shaped list: an open FOLDED openai lane, a folded LIVE lane, and
    // three genuine (non-folded) sessions the user keeps.
    const OPEN_FOLD = { sessionId: 'openFold', encodedDir: ENC, displayTitle: 'openai verify lane', os: 'linux', lastActivityAt: iso(3 * 60 * 1000), foldByDefault: true, startedBy: 'agent', provider: 'openai' };
    const LIVE_FOLD = { sessionId: 'liveFold', encodedDir: ENC, displayTitle: 'live dispatch lane', os: 'linux', lastActivityAt: iso(2 * 60 * 1000), foldByDefault: true, startedBy: 'agent', live: true };
    const V1 = { sessionId: 'v1', encodedDir: ENC, displayTitle: 'my session 1', os: 'linux', lastActivityAt: iso(5 * 60 * 1000), foldByDefault: false, startedBy: 'user' };
    const V2 = { sessionId: 'v2', encodedDir: ENC, displayTitle: 'my session 2', os: 'linux', lastActivityAt: iso(10 * 60 * 1000), foldByDefault: false, startedBy: 'user' };
    const V3 = { sessionId: 'v3', encodedDir: ENC, displayTitle: 'my session 3', os: 'linux', lastActivityAt: iso(20 * 60 * 1000), foldByDefault: false, startedBy: 'user' };
    const list = [OPEN_FOLD, LIVE_FOLD, V1, V2, V3];
    st.projects = [{ id: PID, name: 'MyProject', lastActivityAt: iso(60 * 1000), hostPath: '/tmp/myproject' }];
    st.projSort = 'recency'; S.resortProjects();
    st.expanded = new Set([PID]);
    st.seen = new Map();
    st.caps = st.caps || {}; // liveInfo trusts sess.live only while caps.live !== true
    st.sessions = new Map([[PID, { loaded: true, loading: false, error: null, list, shown: 6, windowed: true, encodedDir: ENC, dirs: [] }]]);

    const rowsFor = () => S.visibleSessions(st.sessions.get(PID)).rows.map((r) => r.sessionId);

    // The user's real report: the OPEN folded openai lane.
    st.current = { projectId: PID, encodedDir: ENC, sessionId: 'openFold', title: null, os: null };
    const openRows = rowsFor();
    // MUST-FAIL(before the fix): the open folded lane appeared in the default rows.
    ok('MUST-FAIL(before): open FOLDED lane is absent from the default nav rows',
      !openRows.includes('openFold'));
    ok('round4: the three genuine sessions still show', ['v1', 'v2', 'v3'].every((id) => openRows.includes(id)));
    // round 5 (user decision): a folded lane must NOT be surfaced because it is
    // live. This was the actual cause of the sighting (an openai verify lane was
    // mid-turn when the user saw it). MUST-FAIL before this change: the folded
    // LIVE lane appeared via the `hasLiveWork` bypass.
    ok('MUST-FAIL(before): folded LIVE lane is ABSENT from the default nav rows',
      !openRows.includes('liveFold'));

    // Control: a NON-folded open session is still always present (no BUG-085 regression).
    st.current = { projectId: PID, encodedDir: ENC, sessionId: 'v3', title: null, os: null };
    ok('round4: a NON-folded open session is still always present (BUG-085 preserved)',
      rowsFor().includes('v3'));

    // "N more" (windowed:false) reveals the folded open lane — reachable, not deleted.
    st.current = { projectId: PID, encodedDir: ENC, sessionId: 'openFold', title: null, os: null };
    st.sessions.set(PID, { ...st.sessions.get(PID), windowed: false, shown: 50 });
    ok('round4: "N more" reveals the folded open lane (fold, not deletion)',
      rowsFor().includes('openFold'));
  } finally {
    try {
      const st2 = win?.__station?.state;
      if (st2?.snapPollTimer) clearInterval(st2.snapPollTimer);
      if (st2?.liveTimer) clearInterval(st2.liveTimer);
    } catch { /* never booted */ }
    for (const s of openSockets) { try { s.on('error', () => {}); s.close(); } catch { /* closed */ } }
    await sleep(200);
    globalThis.WebSocket = prev.WebSocket; globalThis.fetch = prev.fetch;
    globalThis.document = prev.document; globalThis.window = prev.window; globalThis.location = prev.location;
    try { if (server?.pid) process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
    await sleep(200);
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

await browserScenario().catch((err) => { fail++; console.log(`FAIL round4 browser scenario threw — ${err.stack ?? err}`); });

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
