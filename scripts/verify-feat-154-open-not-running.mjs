#!/usr/bin/env node
/**
 * FEAT-154 rounds 8–9: opening or viewing a finished session must never make it
 * read as running, and a genuine new turn must still read as running at once.
 *
 * The user's report (session 6927511d): "since opening it … it shows as blue
 * running". Orchard writes transcript files for its own reasons whenever a
 * session is opened or viewed:
 *   - the FEAT-144 Claude mirror, on every transcript read;
 *   - the FEAT-078 native-Codex import, on the first read;
 *   - a rename or pin appended through the SDK.
 * The live scan counted any fresh mtime as a running turn. Round 8 excluded the
 * mirror's provider dir by name. The clean-room verify (run f195fc23) then
 * showed that a native-Codex import lands in an ENGINE dir and still flashed
 * running. Round 9 declares every Orchard-side write in ONE place
 * (src/server/own-writes.ts `asOrchardWrite`), and the scan reads
 * `lastEngineWriteMs`, never the raw mtime.
 *
 * Real artifacts:
 *   - the REAL transcript of 6927511d, from this checkout's own Claude store;
 *   - a REAL native Codex rollout, found at runtime in $CODEX_HOME/sessions.
 *     Its only rewrite is `session_meta.cwd`, pointed at the scratch project so
 *     it lists there.
 * Both are copied into scratch stores with OLD mtimes ("finished"). If either is
 * absent, the suite FAILS LOUDLY; it never passes on nothing.
 *
 * Cases (isolated second instance: own CLAUDE_STATION_DATA, CLAUDE_PROJECTS_DIR
 * and CODEX_HOME, free port, process group killed):
 *   A  Claude, first open (no mirror yet). The route DID write the mirror
 *      (non-vacuity), yet there is no live entry, the list row is not live, and
 *      the REAL client (app.js in happy-dom, on the user's deep-link shape)
 *      resolves it NOT running and renders no running marker.
 *   B  Claude, LAGGING mirror. A read appends to it (non-vacuity), and the
 *      session is still not live.
 *   C  Control: a genuine CLI append to the Claude store IS live, and the
 *      client reads it as running.
 *   F  Native Codex, first open. The route DID import the rollout into the
 *      `openai` dir (non-vacuity), yet there is no live entry, the list row is
 *      not live, and the client resolves it NOT running.
 *   G  Genuine Codex turn: an engine append to that same file (what the
 *      TranscriptRecorder does) is live on the very next poll, and the client
 *      reads it as running.
 *   H  The own-writes contract, in-process through the real wrapper and the
 *      real scan. Two declared appends (rename, then pin) to a finished
 *      transcript are not live. The next engine append is. An Orchard write
 *      never hides a recent engine write.
 *   E  MUST-FAIL sentinels, anchored to SYNTHESIZED pre-fix formulas:
 *      - raw-mtime scan over every Orchard root (the pre-round-8 formula): lists
 *        the opened Claude session AND the opened Codex session as live;
 *      - round-8 formula (every root except `anthropic`): still lists the
 *        opened Codex session as live.
 *      Together these prove the scenarios really trigger the defect.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ID = '6927511d-41ad-4e79-8263-33c8a83f7d8e';
const REAL_STORE = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const REAL = path.join(REAL_STORE, ROOT.replace(/[^A-Za-z0-9]/g, '-'), `${ID}.jsonl`); // this checkout's own store dir
const REAL_CODEX = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

if (!fs.existsSync(REAL)) {
  console.log(`FAIL real artifact missing: ${path.basename(REAL)} is not in the transcript store — this suite needs the real session it was built from`);
  process.exit(1);
}
/** A real native Codex rollout with a session_meta and ≥2 response items (discovered, not named). */
function findRealRollout() {
  const walk = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.jsonl') ? [path.join(d, e.name)] : []); } catch { return []; } };
  for (const f of walk(REAL_CODEX).sort().reverse()) {
    const st = fs.statSync(f);
    if (st.size < 2_000 || st.size > 400_000) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    let meta = null;
    try { meta = JSON.parse(lines[0]); } catch { continue; }
    if (meta?.type !== 'session_meta' || !meta.payload?.session_id) continue;
    if (lines.filter((l) => l.includes('"type":"response_item"')).length < 2) continue;
    return { file: f, lines, meta };
  }
  return null;
}
const rollout = findRealRollout();
if (!rollout) {
  console.log(`FAIL real artifact missing: no native Codex rollout with ≥2 response items under the codex sessions store — the Codex cases need one`);
  process.exit(1);
}
const CID = rollout.meta.payload.session_id;

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'f154-open-'));
const DATA = path.join(W, 'data');
const STORE = path.join(W, 'store');
const CODEX = path.join(W, 'codex');
const HOST = path.join(W, 'orchard');
for (const d of [DATA, STORE, HOST, path.join(DATA, 'session-provenance')]) fs.mkdirSync(d, { recursive: true });
const ENC = HOST.replace(/[^A-Za-z0-9]/g, '-');
fs.mkdirSync(path.join(STORE, ENC), { recursive: true });
const SRC = path.join(STORE, ENC, `${ID}.jsonl`);
fs.copyFileSync(REAL, SRC);
const OLD = new Date(Date.now() - 4 * 3600e3); // finished hours ago, like the user's case
fs.utimesSync(SRC, OLD, OLD);
fs.writeFileSync(path.join(DATA, 'session-provenance', `${ID}.json`),
  JSON.stringify({ sessionId: ID, startedBy: 'user', source: 'agent-bridge', at: OLD.toISOString() }));
const MIRROR = path.join(DATA, 'transcripts', 'anthropic', ENC, `${ID}.jsonl`);
// the real rollout, cwd pointed at the scratch project (the only rewrite)
const relRollout = path.relative(REAL_CODEX, rollout.file);
const CROLL = path.join(CODEX, 'sessions', relRollout);
fs.mkdirSync(path.dirname(CROLL), { recursive: true });
const meta = { ...rollout.meta, payload: { ...rollout.meta.payload, cwd: HOST } };
fs.writeFileSync(CROLL, [JSON.stringify(meta), ...rollout.lines.slice(1)].join('\n'));
fs.utimesSync(CROLL, OLD, OLD);
const CIMPORT = path.join(DATA, 'transcripts', 'openai', ENC, `${CID}.jsonl`);

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const env = isolatedServerEnv({ PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, CODEX_HOME: CODEX });
const server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
  cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
});
server.stderr?.on('data', () => {});

const liveRow = async (id = ID) => {
  const j = await (await fetch(`${BASE}/api/sessions/live`)).json();
  return (j.sessions ?? []).find((x) => x.sessionId === id) ?? null;
};
const prev = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window, location: globalThis.location };
let win = null;
const sockets = [];
try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) throw new Error('scratch server never became healthy');
  const pr = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: HOST, name: 'orchard-probe' }),
  })).json();
  const PID = pr.id ?? pr.project?.id;
  const list0 = (await (await fetch(`${BASE}/api/projects/${PID}/sessions`)).json()).sessions ?? [];
  const row0 = list0.find((x) => x.sessionId === ID);
  const crow0 = list0.find((x) => x.sessionId === CID);
  ok('setup: the real Claude session lists as a user session (not folded), not live, no mirror yet',
    !!row0 && row0.foldByDefault === false && row0.live === false && !fs.existsSync(MIRROR),
    JSON.stringify({ fold: row0?.foldByDefault, live: row0?.live, mirror: fs.existsSync(MIRROR) }));
  ok('setup: the real native Codex rollout lists under the project, not live, not imported yet',
    !!crow0 && crow0.live === false && !fs.existsSync(CIMPORT), JSON.stringify({ provider: crow0?.provider, live: crow0?.live }));

  // ── A: open it the way the user did — the real client on the real deep-link shape.
  const { Window } = await import('happy-dom');
  const WebSocket = (await import('ws')).default;
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  win = new Window({ url: `${BASE}/#/project/${PID}/session/${ID}?dir=${ENC}&i=31` });
  const doc = win.document;
  doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
  doc.close();
  const realFetch = globalThis.fetch;
  win.fetch = (input, init) => realFetch(String(input).startsWith('http') ? input : BASE + input, init);
  win.WebSocket = class extends WebSocket { constructor(...a) { super(...a); this.on('error', () => {}); sockets.push(this); } };
  win.location.host = `127.0.0.1:${PORT}`;
  globalThis.document = doc; globalThis.window = win; globalThis.location = win.location;
  globalThis.WebSocket = win.WebSocket; globalThis.fetch = win.fetch;
  await import(`${path.join(ROOT, 'public', 'app.js')}?f154open=${Date.now()}`);
  for (let i = 0; i < 150 && win.__station?.state?.current?.sessionId !== ID; i++) await sleep(100);
  const S = win.__station;
  const st = S.state;
  ok('A: the deep link opened the session', st.current.sessionId === ID);
  for (let i = 0; i < 50 && !fs.existsSync(MIRROR); i++) await sleep(100);
  ok('A: non-vacuity — opening DID write the FEAT-144 mirror (fresh mtime)',
    fs.existsSync(MIRROR) && Date.now() - fs.statSync(MIRROR).mtimeMs < 20e3);

  // ── F (server half): open the native Codex session — the route imports it.
  const cr = await fetch(`${BASE}/api/transcript/${encodeURIComponent(ENC)}/${CID}?limit=5`);
  ok('F: non-vacuity — opening the native Codex session DID import it into the openai dir (fresh mtime)',
    cr.ok && fs.existsSync(CIMPORT) && Date.now() - fs.statSync(CIMPORT).mtimeMs < 20e3, `HTTP ${cr.status}`);

  // E (must-FAIL sentinels): synthesized PRE-FIX formulas, run in THIS process
  // (whose own-writes ledger is empty, so its liveSessions is the raw-mtime scan).
  process.env.CLAUDE_STATION_DATA = DATA;
  const ot = await import(path.join(ROOT, 'src', 'server', 'orchard-transcripts.ts'));
  const watcher = await import(path.join(ROOT, 'src', 'server', 'watcher.ts'));
  const rawAll = ot.providerRoots().flatMap(({ root }) => watcher.liveSessions(undefined, root));
  ok('E: MUST-FAIL sentinel — pre-round-8 formula (raw mtime, every root) calls the opened Claude session live',
    rawAll.some((x) => x.sessionId === ID));
  ok('E: MUST-FAIL sentinel — pre-round-8 formula calls the opened Codex session live',
    rawAll.some((x) => x.sessionId === CID));
  const round8 = ot.providerRoots().filter((r) => r.provider !== 'anthropic').flatMap(({ root }) => watcher.liveSessions(undefined, root));
  ok('E: MUST-FAIL sentinel — round-8 formula (every root but anthropic) STILL calls the opened Codex session live',
    round8.some((x) => x.sessionId === CID));

  await S.refreshLive();
  const la = await liveRow();
  ok('A: /api/sessions/live has NO entry for the opened finished Claude session', la === null,
    la ? JSON.stringify({ lastWriteAt: la.lastWriteAt, liveness: la.liveness }) : '');
  const listA = (await (await fetch(`${BASE}/api/projects/${PID}/sessions`)).json()).sessions ?? [];
  ok('A: the session list row is not live', listA.find((x) => x.sessionId === ID)?.live === false);
  const rowA = st.sessions.get(PID)?.list?.find((x) => x.sessionId === ID);
  const life = rowA ? S.sessionLifecycle(rowA) : 'no-row';
  ok('A: the REAL client resolves it as NOT running', !!rowA && life !== 'running', `life=${life}`);
  S.renderTree();
  const el = [...doc.querySelectorAll('#tree .row')].find((r) => r.getAttribute('aria-current') === 'true');
  ok('A: its nav row is listed (open) and carries no running marker',
    !!el && !el.querySelector('.alive'), el ? el.className : 'open row not found');

  // ── F (client half)
  const lf = await liveRow(CID);
  ok('F: /api/sessions/live has NO entry for the opened finished Codex session', lf === null,
    lf ? JSON.stringify({ provider: lf.provider, lastWriteAt: lf.lastWriteAt, liveness: lf.liveness }) : '');
  ok('F: its list row is not live', listA.find((x) => x.sessionId === CID)?.live === false,
    `live=${listA.find((x) => x.sessionId === CID)?.live}`);
  await S.loadSessions(PID, { force: true });
  const rowF = st.sessions.get(PID)?.list?.find((x) => x.sessionId === CID);
  const lifeF = rowF ? S.sessionLifecycle(rowF) : 'no-row';
  ok('F: the REAL client resolves the Codex session as NOT running', !!rowF && lifeF !== 'running', `life=${lifeF}`);

  // ── G: a GENUINE Codex turn — the engine appends (the TranscriptRecorder's write) — is live promptly.
  fs.appendFileSync(CIMPORT, `${JSON.stringify({ type: 'assistant', uuid: 'g1', parentUuid: null, timestamp: new Date().toISOString(), sessionId: CID, cwd: HOST, provider: 'openai', message: { role: 'assistant', content: [{ type: 'text', text: 'new turn' }] } })}\n`);
  const lg = await liveRow(CID);
  ok('G: a genuine Codex engine append is live on the very next poll', !!lg && lg.provider === 'openai',
    lg ? `provider=${lg.provider} ageMs=${Math.round(lg.ageMs)}` : 'absent');
  await S.refreshLive();
  ok('G: the client reads the Codex session as running', !!rowF && S.sessionLifecycle(rowF) === 'running');

  // ── B: a LAGGING Claude mirror (strict prefix, old mtime) — a read appends; still not live.
  const buf = fs.readFileSync(SRC);
  const half = buf.indexOf(0x0a, Math.floor(buf.length / 2)) + 1;
  fs.writeFileSync(MIRROR, buf.subarray(0, half));
  fs.utimesSync(MIRROR, OLD, OLD);
  const before = fs.statSync(MIRROR).size;
  await fetch(`${BASE}/api/transcript/${encodeURIComponent(ENC)}/${ID}?limit=5`);
  const after = fs.statSync(MIRROR).size;
  ok('B: non-vacuity — the read appended the missing bytes to the mirror', after > before && after === buf.length,
    `${before}→${after} of ${buf.length}`);
  ok('B: still no live entry after the mirror append', (await liveRow()) === null);

  // ── H: the own-writes contract itself, driven in THIS process through the REAL
  // wrapper + the REAL watcher scan (a rename/pin is an SDK append to the Claude
  // store wrapped in asOrchardWriteAsync; the SDK itself is not driven here — it
  // addresses the store by cwd, which would reach outside the scratch store).
  const ow = await import(path.join(ROOT, 'src', 'server', 'own-writes.ts'));
  const HD = path.join(W, 'h-store', ENC);
  fs.mkdirSync(HD, { recursive: true });
  const HF = path.join(HD, `${ID}.jsonl`);
  fs.copyFileSync(SRC, HF);
  fs.utimesSync(HF, OLD, OLD);
  const inScan = () => watcher.liveSessions(undefined, path.join(W, 'h-store')).some((x) => x.sessionId === ID);
  await ow.asOrchardWriteAsync(HF, async () => { fs.appendFileSync(HF, '{"type":"custom-title","customTitle":"r9"}\n'); });
  ow.asOrchardWrite(HF, () => fs.appendFileSync(HF, '{"type":"tag","tag":"pinned"}\n'));
  ok('H: two Orchard-declared appends (rename, then pin) to a finished transcript are NOT live', !inScan());
  fs.appendFileSync(HF, '{"type":"system","subtype":"engine"}\n');
  ok('H: the next ENGINE append after them IS live at once', inScan());
  ow.asOrchardWrite(HF, () => fs.appendFileSync(HF, '{"type":"custom-title","customTitle":"r9b"}\n'));
  ok('H: an Orchard write never HIDES a genuinely recent engine write (engine time carried through)', inScan());

  // ── C: control — a genuine writer (the CLI appending to its own store) IS live.
  fs.appendFileSync(SRC, `${JSON.stringify({ type: 'system', subtype: 'probe', timestamp: new Date().toISOString(), sessionId: ID })}\n`);
  const lc = await liveRow();
  ok('C: control — a CLI append to the Claude store file makes it live (scan not blinded)', !!lc, lc ? `ageMs=${Math.round(lc.ageMs)}` : 'absent');
  await S.refreshLive();
  ok('C: control — the client then reads it as running', S.sessionLifecycle(rowA) === 'running');
} catch (err) {
  fail++;
  console.log(`FAIL threw — ${err.stack ?? err}`);
} finally {
  try {
    const st2 = win?.__station?.state;
    if (st2?.snapPollTimer) clearInterval(st2.snapPollTimer);
    if (st2?.liveTimer) clearInterval(st2.liveTimer);
  } catch { /* never booted */ }
  for (const s of sockets) { try { s.close(); } catch { /* closed */ } }
  globalThis.WebSocket = prev.WebSocket; globalThis.fetch = prev.fetch;
  globalThis.document = prev.document; globalThis.window = prev.window; globalThis.location = prev.location;
  try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  await sleep(300);
  let alive = false;
  try { process.kill(server.pid, 0); alive = true; } catch { /* reaped */ }
  fs.rmSync(W, { recursive: true, force: true });
  console.log(`cleanup: server pid ${server.pid} (process group) ${alive ? 'STILL ALIVE' : 'stopped'}`);
  if (alive) fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
