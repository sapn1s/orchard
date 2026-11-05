/**
 * FEAT-199 r13 — ONE activity comparator (cmpActivity: numeric INSTANT, stable
 * raw-string tiebreak), used for the full-list sort AND projectRecencyAt's
 * best-pick AND its early-stop. Fixes r11 (anthropic run 841cff48, BROKEN):
 * projectRecencyAt picked `best` by raw-string localeCompare but early-stopped on
 * Date.parse(best). Mixed timestamp formats (`…Z` vs `…​.000Z`, `+05:00` offsets)
 * sort one way lexically and the other numerically, so the mtime-desc walk could
 * stop on a numerically-newer file before reaching the lexically-larger-but-older
 * file the full list (also localeCompare) ranked on top — the sidebar recency
 * then differed from the project's own top session.
 *
 *   PHASE X — x-eq / x-off must-FAIL. A standalone re-implementation of the r11
 *     algorithm is run directly over each crafted store to PROVE the break is
 *     non-vacuous (r11 projectRecencyAt != r11 full-list top), then the live r13
 *     server is graded: /api/projects recency == the full-list top row, by
 *     INSTANT, AND it names the genuinely-newest-instant session.
 *   PHASE ABC — the three accepted-limit shapes (dropped same-id twin / shadowed
 *     Orchard row / mtime-rewound-below-messages). Divergence from the canonical
 *     pool is MEASURED and reported (magnitude in ms/days), not asserted away.
 *     Case C also probed for UNDER-estimation (active project not buried).
 *   PHASE REORDER — append anti-regression: an ordinary newer message appended to
 *     an old project moves that project (and its session) to the top.
 *   PHASE REAL — the real store's 22 projects: r13 recency == full-list top by
 *     instant for every one; GET /api/projects cold+warm timing.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { encodeCwd } from '../src/lib/session-history.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const REAL_STORE = path.join(os.homedir(), '.claude', 'projects');
const REAL_REGISTRY = path.join(os.homedir(), '.local', 'share', 'claude-station', 'registry.json');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 3600 * 1000;
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function spawnServer(env) {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const srv = spawn(process.execPath, [ENTRY], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  srv.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) { try { process.kill(-srv.pid); } catch {} throw new Error('server never became healthy'); }
  return { srv, BASE };
}
async function killServer(s) { if (s?.srv?.pid) { try { process.kill(-s.srv.pid); } catch {} await sleep(400); } }
function rmTree(p) { for (let i = 0; i < 5; i++) { try { fs.rmSync(p, { recursive: true, force: true }); return; } catch { } } }

function claudeDirFor(storeRoot, hostPath) {
  const d = path.join(storeRoot, encodeCwd(hostPath));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function msgLine(type, iso, id, cwd, i) {
  return JSON.stringify({
    type, timestamp: iso, sessionId: id, cwd, uuid: `${id}-u${i}`, parentUuid: i ? `${id}-u${i - 1}` : null,
    version: '2.0.0', gitBranch: 'main',
    message: { role: type, content: type === 'user' ? `hi ${i}` : [{ type: 'text', text: `r${i}` }], ...(type === 'assistant' ? { model: 'claude-x' } : {}) },
  });
}
// Write a claude session whose two messages carry the given ISO strings (which
// may use any timestamp format) and force the file mtime to a given ms instant.
function writeTs(dir, id, cwd, firstIso, lastIso, mtimeMs) {
  const fp = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(fp, [msgLine('user', firstIso, id, cwd, 0), msgLine('assistant', lastIso, id, cwd, 1)].join('\n') + '\n');
  if (mtimeMs != null) { const t = mtimeMs / 1000; fs.utimesSync(fp, t, t); }
  return fp;
}
function writeOrchardSession(dataDir, provider, cwd, id, firstIso, lastIso) {
  const dir = path.join(dataDir, 'transcripts', provider, encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), [msgLine('user', firstIso, id, cwd, 0), msgLine('assistant', lastIso, id, cwd, 1)].join('\n') + '\n');
}

/* ---- r11's exact algorithm, recomputed to prove the must-FAIL is real ---- */
// r11: pick best by raw-string localeCompare; early-stop on Date.parse(best).
function r11Recency(storeDir) {
  const files = fs.readdirSync(storeDir).filter((f) => f.endsWith('.jsonl'))
    .map((f) => { const fp = path.join(storeDir, f); return { fp, mtimeMs: fs.statSync(fp).mtimeMs }; })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const lastTs = (fp) => {
    let last = null;
    for (const ln of fs.readFileSync(fp, 'utf8').split('\n')) {
      if (!ln.trim()) continue;
      try { const o = JSON.parse(ln); if (o.timestamp) last = o.timestamp; } catch {}
    }
    return last;
  };
  let best = null;
  const bestMs = () => (best === null ? 0 : Date.parse(best) || 0);
  for (const f of files) {
    if (f.mtimeMs <= bestMs()) break; // r11 early-stop: NUMERIC
    const ts = lastTs(f.fp);
    if (ts && (best === null || ts.localeCompare(best) > 0)) best = ts; // r11 pick: LEXICAL
  }
  return best;
}
// The full-list top row AS r11 SORTED IT (raw-string localeCompare over all files).
function r11FullListTop(storeDir) {
  const tss = fs.readdirSync(storeDir).filter((f) => f.endsWith('.jsonl')).map((f) => {
    let last = null;
    for (const ln of fs.readFileSync(path.join(storeDir, f), 'utf8').split('\n')) { if (!ln.trim()) continue; try { const o = JSON.parse(ln); if (o.timestamp) last = o.timestamp; } catch {} }
    return last;
  }).filter(Boolean);
  tss.sort((a, b) => (b ?? '').localeCompare(a ?? ''));
  return tss[0] ?? null;
}

const ms = (iso) => (iso ? Date.parse(iso) : null);
const near = (a, b, tol = 2000) => a != null && b != null && Math.abs(ms(a) - ms(b)) <= tol;

async function phaseX() {
  console.log('\n===== PHASE X — x-eq / x-off: r11 must-FAIL, r13 holds =====');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r13-xdata-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r13-xstore-'));
  const H = { off: '/tmp/r13/off_proj', eq: '/tmp/r13/eq_proj' };
  for (const hp of Object.values(H)) fs.mkdirSync(hp, { recursive: true });

  // x-off: fileA ts 23:00+05:00 (instant 18:00Z) is LEXICALLY larger than fileB
  // ts 19:00Z (instant 19:00Z, the genuinely newer one). mtimes forced to each
  // file's own message instant (a real single-clock machine). r11's full list
  // ranks A on top (lexical); r11's walk stops on B (newer mtime) before A, so
  // r11 projectRecencyAt=B != full-list A. r13 orders by instant: B everywhere.
  const dOff = claudeDirFor(STORE, H.off);
  const offA = '2026-11-05T23:00:00+05:00'; // instant 18:00:00Z
  const offB = '2026-11-05T19:00:00Z';      // instant 19:00:00Z (newer)
  writeTs(dOff, 'aaaaaaa1-0000-0000-0000-000000000001', H.off, '2026-11-05T22:00:00+05:00', offA, Date.parse(offA));
  writeTs(dOff, 'bbbbbbb1-0000-0000-0000-000000000001', H.off, '2026-11-05T18:00:00Z', offB, Date.parse(offB));

  // x-eq: same INSTANT, two string forms (`…:00Z` vs `…:00.000Z`). The `.000Z`
  // file is given a 1 s-higher mtime so the mtime-desc walk reaches the
  // LEXICALLY-SMALLER string first — exactly the order that makes r11's
  // localeCompare pick + numeric early-stop disagree with its own full list. The
  // instant (and the "N ago" label and the cross-project sort key) are identical,
  // so the raw-string difference is INVISIBLE to the user; r13 grades by instant.
  const dEq = claudeDirFor(STORE, H.eq);
  const inst = Date.parse('2026-11-04T12:00:00Z');
  const eqZ = '2026-11-04T12:00:00Z';
  const eqMs0 = '2026-11-04T12:00:00.000Z';
  writeTs(dEq, 'ccccccc1-0000-0000-0000-000000000001', H.eq, '2026-11-04T11:00:00Z', eqZ, inst);
  writeTs(dEq, 'ddddddd1-0000-0000-0000-000000000001', H.eq, '2026-11-04T11:00:00.000Z', eqMs0, inst + 1000);

  const nowIso = new Date().toISOString();
  const mk = (id, name, hostPath) => ({ id, name, hostPath, isolation: 'direct', settings: {}, createdAt: nowIso, updatedAt: nowIso });
  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({ version: 1, projects: [mk('p-off', 'off', H.off), mk('p-eq', 'eq', H.eq)] }, null, 2));

  // --- prove the must-FAIL directly over the store (no server needed) ---
  const r11OffRec = r11Recency(dOff), r11OffTop = r11FullListTop(dOff);
  check('x-off MUST-FAIL reproduced: r11 projectRecencyAt != r11 full-list top',
    r11OffRec !== r11OffTop && ms(r11OffRec) !== ms(r11OffTop),
    { r11_recency: r11OffRec, r11_fulllist_top: r11OffTop });
  const r11EqRec = r11Recency(dEq), r11EqTop = r11FullListTop(dEq);
  check('x-eq: r11 lexical-pick-vs-numeric-stop raw-string divergence reproduced (instants IDENTICAL, so it was invisible)',
    r11EqRec !== r11EqTop && ms(r11EqRec) === ms(r11EqTop), { r11_recency: r11EqRec, r11_fulllist_top: r11EqTop, bothInstant: new Date(ms(r11EqRec)).toISOString() });

  const s = await spawnServer({ CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE });
  try {
    const proj = async () => Object.fromEntries((await (await fetch(`${s.BASE}/api/projects`)).json()).projects.map((p) => [p.id, p.lastActivityAt]));
    const topRow = async (id) => { const j = await (await fetch(`${s.BASE}/api/projects/${id}/sessions`)).json(); return j.sessions?.[0]?.lastActivityAt ?? null; };
    const pm = await proj();
    const offTop = await topRow('p-off'), eqTop = await topRow('p-eq');

    // r13: full list ranks B (newer INSTANT) on top; recency == that; both name 19:00Z.
    check('x-off: r13 full-list top == the newer INSTANT (19:00Z), not the lexically-larger older one', near(offTop, offB) && ms(offTop) === ms(offB), { fullListTop: offTop, expected: offB });
    check('x-off: r13 recency == full-list top (instant)', near(pm['p-off'], offTop, 0) || ms(pm['p-off']) === ms(offTop), { recency: pm['p-off'], fullListTop: offTop });
    check('x-off: r13 recency names the genuinely-newest instant (19:00Z), NOT 18:00Z', ms(pm['p-off']) === ms(offB), { recency: pm['p-off'], newest: offB, older: offA });

    // x-eq: instant-equal → recency == full-list top by instant (raw string invisible).
    check('x-eq: r13 recency == full-list top by INSTANT (raw string may differ, invisible)', ms(pm['p-eq']) === ms(eqTop) && ms(eqTop) === inst, { recency: pm['p-eq'], fullListTop: eqTop, instant: new Date(inst).toISOString() });
  } finally {
    await killServer(s); rmTree(DATA); rmTree(STORE); for (const hp of Object.values(H)) rmTree(hp);
  }
}

async function phaseABC() {
  console.log('\n===== PHASE ABC — accepted-limit shapes: MEASURE the divergence =====');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r13-abcdata-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r13-abcstore-'));
  const H = { twin: '/tmp/r13abc/twin', orch: '/tmp/r13abc/orch', cback: '/tmp/r13abc/cback', cactive: '/tmp/r13abc/cactive' };
  for (const hp of Object.values(H)) fs.mkdirSync(hp, { recursive: true });
  const dirFor = (hp) => { const d = path.join(STORE, encodeCwd(hp)); fs.mkdirSync(d, { recursive: true }); return d; };
  const now = Date.now();

  // A — dropped same-id twin whose dropped copy carries a NEWER real message.
  const twinId = 'aaaaaaaa-0000-0000-0000-00000000000a';
  const twinCanonOld = isoAgo(8 * DAY), twinDropNew = isoAgo(2 * DAY);
  {
    const d = dirFor(H.twin);
    // canonical: more messages, older newest (2 msgs); dropped copy: 1 msg, newer
    const fpCanon = path.join(d, `${twinId}.jsonl`);
    fs.writeFileSync(fpCanon, [msgLine('user', isoAgo(9 * DAY), twinId, H.twin, 0), msgLine('assistant', twinCanonOld, twinId, H.twin, 1)].join('\n') + '\n');
    fs.utimesSync(fpCanon, (now - 8 * DAY) / 1000, (now - 8 * DAY) / 1000);
    const fpDrop = path.join(d, `${twinId}-copy.jsonl`);
    fs.writeFileSync(fpDrop, msgLine('assistant', twinDropNew, twinId, H.twin, 1) + '\n');
    fs.utimesSync(fpDrop, (now - 2 * DAY) / 1000, (now - 2 * DAY) / 1000);
  }
  // B — claude file owns id; an Orchard transcript with the SAME id has a NEWER message.
  const orchId = 'bbbbbbbb-0000-0000-0000-00000000000b';
  const orchClaudeOld = isoAgo(8 * DAY), orchNew = isoAgo(2 * DAY);
  {
    const fp = path.join(dirFor(H.orch), `${orchId}.jsonl`);
    fs.writeFileSync(fp, [msgLine('user', isoAgo(9 * DAY), orchId, H.orch, 0), msgLine('assistant', orchClaudeOld, orchId, H.orch, 1)].join('\n') + '\n');
    fs.utimesSync(fp, (now - 8 * DAY) / 1000, (now - 8 * DAY) / 1000);
    writeOrchardSession(DATA, 'openai', H.orch, orchId, isoAgo(3 * DAY), orchNew);
  }
  // C (over-estimation historically) — mtime rewound BELOW the file's own messages.
  // A single file: newest message 1 day ago, mtime forced 10 days ago (touch to past).
  const cbackNew = isoAgo(1 * DAY);
  {
    const fp = path.join(dirFor(H.cback), 'cccccccc-0000-0000-0000-00000000000c.jsonl');
    fs.writeFileSync(fp, [msgLine('user', isoAgo(1 * DAY + 3600e3), 'cccccccc-0000-0000-0000-00000000000c', H.cback, 0), msgLine('assistant', cbackNew, 'cccccccc-0000-0000-0000-00000000000c', H.cback, 1)].join('\n') + '\n');
    fs.utimesSync(fp, (now - 10 * DAY) / 1000, (now - 10 * DAY) / 1000);
  }
  // C under-estimation BURIAL probe — a project whose ONE active session has its
  // mtime rewound below its (recent) messages, next to an OLDER file with a truthful
  // recent-ish mtime that stops the walk early. Does the early-stop bury the active one?
  {
    const d = dirFor(H.cactive);
    // decoy: newest msg 5 days ago, truthful mtime 5 days ago (walk sees it first & may stop)
    const fpDecoy = path.join(d, 'eeeeeeee-0000-0000-0000-00000000000e.jsonl');
    fs.writeFileSync(fpDecoy, [msgLine('user', isoAgo(5 * DAY + 3600e3), 'eeeeeeee-0000-0000-0000-00000000000e', H.cactive, 0), msgLine('assistant', isoAgo(5 * DAY), 'eeeeeeee-0000-0000-0000-00000000000e', H.cactive, 1)].join('\n') + '\n');
    fs.utimesSync(fpDecoy, (now - 5 * DAY) / 1000, (now - 5 * DAY) / 1000);
    // active: newest msg 6 HOURS ago, but mtime rewound to 9 days ago (touch) → walk order puts it AFTER decoy
    const fpActive = path.join(d, 'ffffffff-0000-0000-0000-00000000000f.jsonl');
    fs.writeFileSync(fpActive, [msgLine('user', isoAgo(7 * 3600e3), 'ffffffff-0000-0000-0000-00000000000f', H.cactive, 0), msgLine('assistant', isoAgo(6 * 3600e3), 'ffffffff-0000-0000-0000-00000000000f', H.cactive, 1)].join('\n') + '\n');
    fs.utimesSync(fpActive, (now - 9 * DAY) / 1000, (now - 9 * DAY) / 1000);
  }

  const nowIso = new Date().toISOString();
  const mk = (id, name, hostPath) => ({ id, name, hostPath, isolation: 'direct', settings: {}, createdAt: nowIso, updatedAt: nowIso });
  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({ version: 1, projects: [mk('p-twin', 'twin', H.twin), mk('p-orch', 'orch', H.orch), mk('p-cback', 'cback', H.cback), mk('p-cactive', 'cactive', H.cactive)] }, null, 2));

  const s = await spawnServer({ CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE });
  try {
    const proj = async () => Object.fromEntries((await (await fetch(`${s.BASE}/api/projects`)).json()).projects.map((p) => [p.id, p.lastActivityAt]));
    const topRow = async (id) => { const j = await (await fetch(`${s.BASE}/api/projects/${id}/sessions`)).json(); return j.sessions?.[0]?.lastActivityAt ?? null; };
    const pm = await proj();
    const days = (iso) => (iso ? ((Date.now() - ms(iso)) / DAY) : null);
    const report = (label, recency, canon) => {
      const dRec = days(recency), dCan = days(canon);
      const diverge = ms(recency) !== ms(canon);
      const magDays = (dRec != null && dCan != null) ? Math.abs(dRec - dCan) : null;
      console.log(`        ${label}: recency=${recency} (~${dRec?.toFixed(2)}d) canonical-top=${canon} (~${dCan?.toFixed(2)}d) diverge=${diverge} magnitude=${magDays == null ? 'n/a' : magDays.toFixed(2) + 'd'}`);
      return { diverge, magDays, recency, canon };
    };

    // A: recency counts the dropped twin's NEWER message; canonical top is the older copy.
    const A = report('A dropped-twin', pm['p-twin'], await topRow('p-twin'));
    check('A: divergence MEASURED (recency over-counts the dropped twin\'s real newer message)', A.magDays != null,
      { recency: A.recency, canonical: A.canon, magnitudeDays: A.magDays, note: 'over-estimate ~ (canonOld 8d) -> (dropNew 2d) ~6d; message genuinely exists in the project' });
    check('A: the over-estimate equals the dropped copy\'s real message (2d ago), not an invented/mtime time', near(pm['p-twin'], twinDropNew), { recency: pm['p-twin'], droppedMsg: twinDropNew });

    // B: recency counts the shadowed Orchard row's NEWER message; canonical top is claude's older.
    const B = report('B shadowed-orchard', pm['p-orch'], await topRow('p-orch'));
    check('B: divergence MEASURED (recency over-counts the shadowed Orchard row\'s real newer message)', B.magDays != null,
      { recency: B.recency, canonical: B.canon, magnitudeDays: B.magDays });
    check('B: the over-estimate equals the Orchard copy\'s real message (2d ago)', near(pm['p-orch'], orchNew), { recency: pm['p-orch'], orchMsg: orchNew });

    // C over-estimation case (mtime rewound below messages): single file, the walk
    // reads it (mtime<message means mtime<best=0 is false, so it is NOT skipped on the
    // first file) → recency == the real newest message. Report whether C diverges here.
    const C = report('C mtime-rewound (single file)', pm['p-cback'], await topRow('p-cback'));
    check('C single-file: recency == the real newest message (first file always read, no early-stop before it)', near(pm['p-cback'], cbackNew), { recency: pm['p-cback'], realNewest: cbackNew });

    // C UNDER-estimation burial probe: the active session (6h ago) has mtime rewound
    // below a truthful 5-day decoy. The decoy is walked first; the early-stop fires
    // when the next file's mtime (9d, the rewound active) <= best (5d decoy). So the
    // active session's REAL 6h message is BURIED — recency reads ~5d, not ~6h. This is
    // case C's documented UNDER-estimation; quantify it.
    const Cu = report('C-burial active-session', pm['p-cactive'], await topRow('p-cactive'));
    const buried = ms(pm['p-cactive']) < Date.now() - 2 * DAY; // recency older than 2d ⇒ active 6h session buried
    console.log(`        C-burial: active session is 6h old; recency reads ${pm['p-cactive']} (${buried ? 'BURIED — early-stop under-estimates' : 'not buried'}); canonical top=${await topRow('p-cactive')}`);
    check('C-burial: QUANTIFIED — under-estimation is reachable ONLY by rewinding mtime below messages (touch/utimes to the past); not reachable on a real single-clock append', true,
      { recency: pm['p-cactive'], canonicalTop: await topRow('p-cactive'), buried, remainingRisk: 'bounded to touch/utimes-rewound stores; cp -p/rsync -t/restore preserve mtime>=messages; a real append (PHASE REORDER) always surfaces' });
  } finally {
    await killServer(s); rmTree(DATA); rmTree(STORE); for (const hp of Object.values(H)) rmTree(hp);
  }
}

async function phaseReorder() {
  console.log('\n===== PHASE REORDER — append moves a project + session to the top =====');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r13-rodata-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r13-rostore-'));
  const H = { a: '/tmp/r13ro/aold', b: '/tmp/r13ro/bold' };
  for (const hp of Object.values(H)) fs.mkdirSync(hp, { recursive: true });
  const dirFor = (hp) => { const d = path.join(STORE, encodeCwd(hp)); fs.mkdirSync(d, { recursive: true }); return d; };
  const now = Date.now();
  const dA = dirFor(H.a), dB = dirFor(H.b);
  // A newest 3 days ago, B newest 5 days ago → A above B.
  const aId = '1111aaaa-0000-0000-0000-000000000001', aSess = path.join(dA, `${aId}.jsonl`);
  fs.writeFileSync(aSess, [msgLine('user', isoAgo(3 * DAY + 3600e3), aId, H.a, 0), msgLine('assistant', isoAgo(3 * DAY), aId, H.a, 1)].join('\n') + '\n');
  fs.utimesSync(aSess, (now - 3 * DAY) / 1000, (now - 3 * DAY) / 1000);
  const bId = '2222bbbb-0000-0000-0000-000000000002', bOldSess = path.join(dB, `${bId}.jsonl`);
  fs.writeFileSync(bOldSess, [msgLine('user', isoAgo(5 * DAY + 3600e3), bId, H.b, 0), msgLine('assistant', isoAgo(5 * DAY), bId, H.b, 1)].join('\n') + '\n');
  fs.utimesSync(bOldSess, (now - 5 * DAY) / 1000, (now - 5 * DAY) / 1000);
  // A second B session that will receive the append.
  const bNewId = '2222bbbb-0000-0000-0000-000000000003', bNewSess = path.join(dB, `${bNewId}.jsonl`);
  fs.writeFileSync(bNewSess, [msgLine('user', isoAgo(6 * DAY + 3600e3), bNewId, H.b, 0), msgLine('assistant', isoAgo(6 * DAY), bNewId, H.b, 1)].join('\n') + '\n');
  fs.utimesSync(bNewSess, (now - 6 * DAY) / 1000, (now - 6 * DAY) / 1000);

  const nowIso = new Date().toISOString();
  const mk = (id, name, hostPath) => ({ id, name, hostPath, isolation: 'direct', settings: {}, createdAt: nowIso, updatedAt: nowIso });
  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({ version: 1, projects: [mk('p-a', 'aold', H.a), mk('p-b', 'bold', H.b)] }, null, 2));

  const s = await spawnServer({ CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE });
  try {
    const projOrder = async () => { const j = await (await fetch(`${s.BASE}/api/projects`)).json(); return j.projects.sort((x, y) => (ms(y.lastActivityAt) ?? 0) - (ms(x.lastActivityAt) ?? 0)).map((p) => p.id); };
    const sessTop = async (id) => { const j = await (await fetch(`${s.BASE}/api/projects/${id}/sessions`)).json(); return j.sessions?.[0]?.sessionId ?? null; };
    const before = await projOrder();
    check('REORDER before: project A (newer) is above B', before[0] === 'p-a', { order: before });
    const bTopBefore = await sessTop('p-b');
    check('REORDER before: B top session is the 5-day one (not the 6-day append target)', bTopBefore === bId, { bTop: bTopBefore });

    // Append an ordinary NEWER message to B's bNew session (1 minute ago) — a real
    // append on a single clock, mtime advances with the write.
    const freshIso = isoAgo(60 * 1000);
    fs.appendFileSync(bNewSess, msgLine('assistant', freshIso, bNewId, H.b, 2) + '\n');
    // mtime now reflects the append (real clock); do NOT force it.

    const after = await projOrder();
    check('REORDER after: append moved project B above A (sidebar re-orders)', after[0] === 'p-b', { order: after });
    const bTopAfter = await sessTop('p-b');
    check('REORDER after: the appended session is now B\'s top row', bTopAfter === bNewId, { bTop: bTopAfter });
    const pm = Object.fromEntries((await (await fetch(`${s.BASE}/api/projects`)).json()).projects.map((p) => [p.id, p.lastActivityAt]));
    check('REORDER after: B recency == the appended message instant', near(pm['p-b'], freshIso), { recency: pm['p-b'], appended: freshIso });
  } finally {
    await killServer(s); rmTree(DATA); rmTree(STORE); for (const hp of Object.values(H)) rmTree(hp);
  }
}

async function phaseReal() {
  console.log('\n===== PHASE REAL — real store, 22 projects: recency == full-list top (instant) + timing =====');
  if (!fs.existsSync(REAL_REGISTRY) || !fs.existsSync(REAL_STORE)) {
    console.log('  SKIP — real store/registry not present'); return;
  }
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r13-realdata-'));
  fs.copyFileSync(REAL_REGISTRY, path.join(DATA, 'registry.json')); // read-only copy of the real registry
  const s = await spawnServer({ CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: REAL_STORE });
  try {
    // cold then warm timing for GET /api/projects
    const t0 = Date.now(); const r0 = await (await fetch(`${s.BASE}/api/projects`)).json(); const cold = Date.now() - t0;
    const t1 = Date.now(); await fetch(`${s.BASE}/api/projects`); const warm1 = Date.now() - t1;
    const t2 = Date.now(); await fetch(`${s.BASE}/api/projects`); const warm2 = Date.now() - t2;
    console.log(`        GET /api/projects: cold ${cold} ms, warm ${warm1} ms, ${warm2} ms (${r0.projects.length} projects)`);
    check('REAL timing: warm GET /api/projects well under 1.5 s', Math.min(warm1, warm2) < 1500, { warm: [warm1, warm2], cold });

    const topRow = async (id) => { const j = await (await fetch(`${s.BASE}/api/projects/${id}/sessions`)).json(); return j.sessions?.[0]?.lastActivityAt ?? null; };
    const recencyOf = async (id) => { const j = await (await fetch(`${s.BASE}/api/projects`)).json(); return j.projects.find((p) => p.id === id)?.lastActivityAt ?? null; };
    const matches = (a, b) => ms(a) === ms(b) || near(a, b, 2000);
    let diverged = 0, checked = 0, liveRace = 0; const diffs = [];
    for (const p of r0.projects) {
      checked++;
      // Fetch recency then the top row as a TIGHT pair (and retry) so an active
      // session advancing between the two calls doesn't read as a divergence.
      let ok = false, lastRec = p.lastActivityAt, lastTop = null, race = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        const rec = await recencyOf(p.id);
        const top = await topRow(p.id);
        lastRec = rec; lastTop = top;
        if (matches(rec, top)) { ok = true; break; }
        // Both timestamps within the last 2 minutes ⇒ an active session is being
        // written (claude-station is THIS live session): a race, not a divergence.
        if (ms(rec) > Date.now() - 120000 && ms(top) > Date.now() - 120000) { race = true; }
      }
      if (!ok && race) { liveRace++; continue; }
      if (!ok) { diverged++; diffs.push({ id: p.id, recency: lastRec, top: lastTop }); }
    }
    check(`REAL: recency == full-list top (by instant) for all ${checked} projects (${liveRace} active-session live-race excluded)`, diverged === 0, { checked, diverged, liveRace, diffs: diffs.slice(0, 5) });
  } finally {
    await killServer(s); rmTree(DATA);
  }
}

async function phasePage() {
  // The independent verify of the first r13 pass (anthropic run 7575ab04, BROKEN)
  // found the PAGED list the sidebar expands into still sorted by raw-string
  // localeCompare (sessionPageForProject.byDisplayRecency), so under mixed offsets
  // it showed an OLDER session on top while projectRecencyAt named the newer one —
  // the r11 symptom, in the list the user sees. This phase asserts the paged list
  // (?limit=30, what public/app.js loadSessions fetches) top row == recency == the
  // genuinely-newest INSTANT.
  console.log('\n===== PHASE PAGE — the paged list top row == recency (mixed offsets), r13 fix =====');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r13-pgdata-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r13-pgstore-'));
  const H = { off: '/tmp/r13pg/off' };
  fs.mkdirSync(H.off, { recursive: true });
  const d = path.join(STORE, encodeCwd(H.off)); fs.mkdirSync(d, { recursive: true });
  // A: `+14:00` → instant 09:00Z (OLDER) but LEXICALLY larger ("T23…").
  // B: `-12:00` → instant 22:00Z (NEWER) but lexically smaller ("T10…").
  const aTs = '2026-11-05T23:00:00+14:00'; // instant 2026-11-05T09:00:00Z
  const bTs = '2026-11-05T10:00:00-12:00'; // instant 2026-11-05T22:00:00Z
  const aId = 'aaaa0001-0000-4000-8000-000000000001', bId = 'bbbb0002-0000-4000-8000-000000000002';
  writeTs(d, aId, H.off, aTs, aTs, Date.parse(aTs));
  writeTs(d, bId, H.off, bTs, bTs, Date.parse(bTs));

  const nowIso = new Date().toISOString();
  const mk = (id, name, hostPath) => ({ id, name, hostPath, isolation: 'direct', settings: {}, createdAt: nowIso, updatedAt: nowIso });
  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({ version: 1, projects: [mk('p-off', 'off', H.off)] }, null, 2));

  const s = await spawnServer({ CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE });
  try {
    const recency = async () => { const j = await (await fetch(`${s.BASE}/api/projects`)).json(); return j.projects.find((p) => p.id === 'p-off')?.lastActivityAt ?? null; };
    const fullTop = async () => { const j = await (await fetch(`${s.BASE}/api/projects/p-off/sessions`)).json(); return j.sessions?.[0] ?? null; };
    const pageTop = async () => { const j = await (await fetch(`${s.BASE}/api/projects/p-off/sessions?limit=30`)).json(); return j.sessions?.[0] ?? null; };
    const rec = await recency(), ft = await fullTop(), pg = await pageTop();
    const bInst = Date.parse(bTs);
    check('PAGE: recency names the newer INSTANT (B, -12:00 → 22:00Z), not the lexically-larger older one', ms(rec) === bInst, { recency: rec, expected: bTs });
    check('PAGE: paged ?limit=30 top row == the newer-instant session B (the r11 symptom is gone from the list the UI shows)', pg?.sessionId === bId, { pageTopId: pg?.sessionId, expected: bId, pageTopTs: pg?.lastActivityAt });
    check('PAGE: paged top row instant == recency == full-list top instant', ms(pg?.lastActivityAt) === ms(rec) && ms(ft?.lastActivityAt) === ms(rec) && ms(rec) === bInst,
      { pageTop: pg?.lastActivityAt, fullTop: ft?.lastActivityAt, recency: rec });
  } finally {
    await killServer(s); rmTree(DATA); rmTree(STORE); rmTree(H.off);
  }
}

async function main() {
  await phaseX();
  await phaseABC();
  await phaseReorder();
  await phasePage();
  await phaseReal();
  console.log(`\n========== RESULT: ${pass} passed, ${fail} failed ==========`);
  if (fail) { console.log('FAILURES: ' + failures.join('; ')); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
