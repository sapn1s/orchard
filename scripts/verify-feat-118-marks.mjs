/**
 * FEAT-118 — session-list state markers + within-session read-mark & bookmark,
 * driven in a REAL headless-brave over a fixture that carries ALL FIVE session
 * states at once (running / died-without-answering / recently-finished / unread
 * / recently-visited) plus a long session for the transcript marks.
 *
 *   node scripts/verify-feat-117-marks.mjs
 *   MUSTFAIL=1 node scripts/verify-feat-117-marks.mjs   # baseline app.js (HEAD)
 *   SHOTS=/path node scripts/verify-feat-117-marks.mjs   # write both-theme shots
 *
 * The must-FAIL pass serves the PRE-FEATURE app.js (git show HEAD:public/app.js)
 * to the same real browser via CDP Fetch interception — no disk swap (app.js is
 * a contended file), no server change. Every marker assertion must redden there,
 * proving the suite is not vacuous. HEAD is a stable anchor because this lane
 * never commits (the fix stays uncommitted), so HEAD remains the pre-feature
 * tree for the life of the proof.
 */
import { spawn, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const MUSTFAIL = process.env.MUSTFAIL === '1';
const SHOTS = process.env.SHOTS || '';

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (n) => `00000000-0000-4000-d000-${String(n).padStart(12, '0')}`;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : (fail++, failures.push(name));
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.handlers = []; }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && c.waiting.has(m.id)) {
        const { res, rej } = c.waiting.get(m.id);
        c.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) {
        for (const h of c.handlers) h(m);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  on(fn) { this.handlers.push(fn); }
  async eval(expr) {
    // A function-shaped expression is invoked; anything else is evaluated as-is.
    const expression = `Promise.resolve((()=>{ const _f = (${expr}); return typeof _f==='function' ? _f() : _f; })())`;
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* nav */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label})`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f117-data-'));
const PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f117-proj-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f117-brave-'));
const cleanupDirs = [DATA, PROJECTS, PROFILE];
let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/** One JSONL transcript with `msgs` user/assistant pairs, mtime `ageMs` old. */
function writeSession(store, sid, firstText, pairs, ageMs) {
  const lines = [];
  let u = 0;
  const now = Date.now();
  for (let i = 0; i < pairs; i++) {
    const ts = new Date(now - ageMs - (pairs - i) * 1000).toISOString();
    lines.push(JSON.stringify({ parentUuid: u ? uid(u) : null, isSidechain: false, type: 'user', uuid: uid(++u), timestamp: ts, sessionId: sid, cwd: PROJECTS,
      message: { role: 'user', content: [{ type: 'text', text: i === 0 ? firstText : `question ${i}` }] } }));
    lines.push(JSON.stringify({ parentUuid: uid(u), isSidechain: false, type: 'assistant', uuid: uid(++u), timestamp: ts, sessionId: sid,
      message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: `answer number ${i} — lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.` }] } }));
  }
  const file = path.join(store, `${sid}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const t = new Date(now - ageMs);
  fs.utimesSync(file, t, t);
  return sid;
}

async function main() {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const encoded = PROJECTS.replace(/[^a-zA-Z0-9]/g, '-'); // mirrors encodeCwd()
  // The server encodes the project cwd; transcripts live at CLAUDE_PROJECTS_DIR/<encodeCwd(PROJECTS)>.
  const storeDir = path.join(PROJECTS, encoded);
  fs.mkdirSync(storeDir, { recursive: true });

  const S = {
    running:  uid(101),
    died:     uid(102),
    finished: uid(103),
    unread:   uid(104),
    visited:  uid(105),
    long:     uid(106),
  };
  writeSession(storeDir, S.running,  'a live run happening now', 2, 1_000);          // fresh mtime ⇒ live
  writeSession(storeDir, S.died,     'a background lane that died', 2, 9 * 60_000);   // old + will get an outcome
  writeSession(storeDir, S.finished, 'a run that just went quiet', 2, 3 * 60_000);   // <8min, no outcome
  writeSession(storeDir, S.unread,   'unseen work', 2, 90 * 60_000);                 // within 24h, no seen entry
  writeSession(storeDir, S.visited,  'you were here recently', 2, 95 * 60_000);      // will get a seen entry
  writeSession(storeDir, S.long,     'a long session to scroll', 40, 40 * 60_000);   // 80 messages to scroll

  // The died session's server-recorded outcome (agent-outcomes ledger).
  fs.writeFileSync(path.join(DATA, 'agent-outcomes.json'), JSON.stringify([{
    id: 'out-fixture-1', at: Date.now() - 8 * 60_000, projectId: null, projectName: 'f117',
    stationSessionId: null, sdkSessionId: S.died, agentId: 'main', row: 'main',
    label: 'the main turn', description: '', kind: 'unknown',
    detail: 'the turn ended while this agent was still running and the engine reported no outcome for it',
    providerError: null, clusterId: null, dismissedAt: null, briefedAt: null,
  }], null, 2));

  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: PROJECTS },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: PROJECTS, name: 'f117-fixture' }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  const pid = reg.project.id;

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--force-color-profile=srgb', '--window-size=1400,1000', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 80 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // MUST-FAIL: serve the pre-feature app.js so every marker assertion reddens.
  if (MUSTFAIL) {
    const baseline = execSync('git show HEAD:public/app.js', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('base64');
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*app.js*' }] });
    cdp.on((m) => {
      if (m.method !== 'Fetch.requestPaused') return;
      const p = m.params;
      if (/\/app\.js(\?|$)/.test(p.request.url)) {
        cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'text/javascript' }], body: baseline });
      } else {
        cdp.send('Fetch.continueRequest', { requestId: p.requestId });
      }
    });
    console.log('\n  [MUSTFAIL] serving HEAD app.js — confirming EVERY marker is ABSENT on the pre-feature tree\n');
  }

  const enc = encodeURIComponent(encoded);

  /* ─────────────────────── PART 1 — session-list state markers ─────────── */
  console.log('\n=== five session-list states, all at once ===');
  // Pre-seed the "visited" session as opened-just-now (client localStorage), and
  // make sure "unread" has NO seen entry. Done before first render.
  await cdp.send('Page.navigate', { url: `${BASE}/#/project/${pid}` });
  await cdp.waitFor('app boot', `!!window.__station`, 30_000);
  await cdp.eval(`() => {
    // The in-memory seen Map is what sessionRow reads (localStorage is only the
    // boot source); set it directly to simulate "opened this row just now".
    // Optional-chained so the baseline (pre-feature) app.js — which has no
    // readMarks/bookmarks state — does not throw here but reddens on the marker
    // assertions themselves.
    window.__station.state.seen.set(${JSON.stringify(`${encoded} ${S.visited}`)}, new Date().toISOString());
    window.__station.state.readMarks?.clear?.(); window.__station.state.bookmarks?.clear?.();
    localStorage.removeItem('cs-readmark'); localStorage.removeItem('cs-bookmark');
  }`);
  // Expand the project + force a live poll + outcomes poll so the tree paints markers.
  await cdp.eval(`async () => {
    const st = window.__station;
    await st.loadSessions(${JSON.stringify(pid)}, { force: true });
    st.state.expanded.add(${JSON.stringify(pid)});
    st.state.current.projectId = ${JSON.stringify(pid)};
    await st.refreshLive();
    await st.refreshOutcomes();
    st.renderTree();
  }`);
  const painted = await cdp.waitFor('rows painted', `document.querySelectorAll('#tree .row').length >= 5`, 15_000);
  if (!painted) {
    const diag = await cdp.eval(`() => ({
      projects: (window.__station.state.projects||[]).map(p=>p.id),
      curProj: window.__station.state.current.projectId,
      sess: [...window.__station.state.sessions.entries()].map(([k,v])=>[k, v.loaded, v.list?.length]),
      rows: document.querySelectorAll('#tree .row').length,
      tree: document.querySelector('#tree')?.textContent?.slice(0,120),
    })`);
    console.log('  DIAG', JSON.stringify(diag));
  }

  // MUST-FAIL: the pre-feature app.js has none of these markers or hooks. Assert
  // their ABSENCE in the REAL rendered DOM + the transcript — a clean, per-claim
  // redden that does not depend on hooks HEAD lacks, then stop.
  if (MUSTFAIL) {
    const listMarkers = await cdp.eval(`() => document.querySelectorAll('#tree .stopped, #tree .settled, #tree .unread, #tree .row.died, #tree .row.visited').length`);
    check('BASELINE: session-list lifecycle/unread/visited markers are ABSENT', listMarkers === 0, listMarkers);
    await cdp.send('Page.navigate', { url: `${BASE}/#/project/${pid}/session/${S.long}?dir=${encodeURIComponent(encoded)}` });
    await cdp.waitFor('baseline long open', `window.__station?.state.current.sessionId === ${JSON.stringify(S.long)}`, 30_000);
    await sleep(500);
    const txMarks = await cdp.eval(`() => document.querySelectorAll('.readline, #leftoff, #bookmark, [data-i].bookmarked').length`);
    check('BASELINE: read-line / Resume pill / bookmark control are ABSENT', txMarks === 0, txMarks);
    cdp.close();
    return;
  }

  // Build each fixture row through the REAL sessionRow() over the REAL server
  // data + live/outcomes/seen state, keyed by sessionId (titles are unstable —
  // the fixture sets no ai-title).
  const rowState = await cdp.eval(`() => {
    const st = window.__station;
    const s = st.state.sessions.get(${JSON.stringify(pid)});
    const proj = { id: ${JSON.stringify(pid)} };
    const out = {};
    for (const sess of (s?.list ?? [])) {
      const r = st.sessionRow(proj, sess);
      const cls = r.className;
      out[sess.sessionId] = {
        alive: !!r.querySelector('.alive'),
        stopped: !!r.querySelector('.stopped'),
        settled: !!r.querySelector('.settled'),
        unread: !!r.querySelector('.unread'),
        died: /\\bdied\\b/.test(cls),
        fresh: /\\bfresh\\b/.test(cls),
        visited: /\\bvisited\\b/.test(cls),
      };
    }
    return out;
  }`);
  const rRun = rowState[S.running] ?? {}, rDied = rowState[S.died] ?? {}, rFin = rowState[S.finished] ?? {},
        rUnr = rowState[S.unread] ?? {}, rVis = rowState[S.visited] ?? {};
  check('RUNNING row shows the live dot (.alive), no other marker', rRun.alive && !rRun.stopped && !rRun.settled, rRun);
  check('DIED row shows the amber stopped marker (.stopped + .died), NOT settled', rDied.stopped && rDied.died && !rDied.settled && !rDied.alive, rDied);
  check('FINISHED row shows the still ring (.settled), not alarm/alive', rFin.settled && !rFin.stopped && !rFin.alive, rFin);
  check('UNREAD row is .fresh with a trailing .unread tick, no lifecycle marker', rUnr.fresh && rUnr.unread && !rUnr.alive && !rUnr.stopped && !rUnr.settled, rUnr);
  check('VISITED row is .visited, NOT fresh/unread, no lifecycle marker', rVis.visited && !rVis.fresh && !rVis.stopped && !rVis.settled, rVis);
  check('the five states are mutually distinguishable (5 distinct signatures)',
    new Set([rRun, rDied, rFin, rUnr, rVis].map((s) => JSON.stringify(s))).size === 5,
    { rRun, rDied, rFin, rUnr, rVis });

  // Screenshots — both themes — for the human read.
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await cdp.eval(`() => { document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); window.__station.renderTree(); }`);
      await sleep(300);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS, `f117-list-${theme}.png`), Buffer.from(shot.data, 'base64'));
    }
    await cdp.eval(`() => document.documentElement.setAttribute('data-theme','light')`);
  }

  /* ─────────────────────── PART 2 — within-session read-mark ───────────── */
  console.log('\n=== auto "you left off here" — persists, jumps, clears only on read ===');
  // Simulate "you left off at message 20 on a prior visit": persist a read-mark
  // for the long session, then open it. The divider must appear above (we land
  // at the bottom) and the Resume pill must offer the one-action return.
  const longKey = `${encoded} ${S.long}`;
  // Simulate "you left off at message 20 on a prior visit": both the in-memory
  // map (read by seedReadMark on this same-document open) AND localStorage (the
  // boot source, exercised by the reload assertion below).
  await cdp.eval(`() => {
    window.__station.state.readMarks.set(${JSON.stringify(longKey)}, 20);
    localStorage.setItem('cs-readmark', ${JSON.stringify(JSON.stringify({ [longKey]: 20 }))});
  }`);
  await cdp.send('Page.navigate', { url: `${BASE}/#/project/${pid}/session/${S.long}?dir=${enc}` });
  await cdp.waitFor('long session open', `window.__station?.state.current.sessionId === ${JSON.stringify(S.long)}`, 30_000);
  await sleep(500);
  const openState = await cdp.eval(`() => ({
    readline: !!document.querySelector('.readline'),
    leftoff: !!document.querySelector('#leftoff') && !document.querySelector('#leftoff').hidden,
    readIndex: window.__station.state.threads.get('main')?.readIndex ?? null,
  })`);
  check('read-line divider drawn at the restored boundary', openState.readline, openState);
  check('the Resume pill is offered (one-action return)', openState.leftoff, openState);
  check('the read boundary was seeded from the persisted mark (20)', openState.readIndex === 20, openState);

  // Repaint alone (what returning-to-tab does) must NOT advance/clear it.
  await cdp.eval(`() => { const st=window.__station; st.paintMarks(); st.paintMarks(); st.paintMarks(); }`);
  const afterRepaint = await cdp.eval(`() => ({ readline: !!document.querySelector('.readline'), mark: JSON.parse(localStorage.getItem('cs-readmark')||'{}')[${JSON.stringify(longKey)}] })`);
  check('repaint/return alone does NOT clear the line (beats Discord eager-clear)', afterRepaint.readline && afterRepaint.mark === 20, afterRepaint);

  // One-action jump lands the divider in view.
  await cdp.eval(`() => window.__station.jumpToReadLine()`);
  await sleep(500);
  const jumped = await cdp.eval(`() => {
    const l = document.querySelector('.readline'); if (!l) return { seen:false };
    const s = document.querySelector('#scroll').getBoundingClientRect(); const r = l.getBoundingClientRect();
    return { seen: r.bottom > s.top && r.top < s.bottom };
  }`);
  check('clicking Resume scrolls the read-line into view', jumped.seen, jumped);
  if (SHOTS) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, 'f117-readline-light.png'), Buffer.from(shot.data, 'base64'));
    const bottomEl = await cdp.eval(`() => {
      const els = [...document.querySelector('.pane.on, [data-thread="main"]')?.children ?? []].slice(-4).map(e => e.className || e.tagName);
      const rl = document.querySelector('.readline'); return { tail: els, readlineHTML: rl ? rl.outerHTML.slice(0,140) : null };
    }`);
    console.log('  READLINE-DIAG', JSON.stringify(bottomEl));
  }

  // Survives a reload.
  await cdp.eval(`() => location.reload()`);
  await cdp.waitFor('reopen after reload', `window.__station?.state.current.sessionId === ${JSON.stringify(S.long)}`, 30_000);
  await sleep(600);
  const afterReload = await cdp.eval(`() => ({ readline: !!document.querySelector('.readline'), readIndex: window.__station.state.threads.get('main')?.readIndex ?? null })`);
  check('read-line SURVIVES a reload (seeded from localStorage)', afterReload.readline && afterReload.readIndex === 20, afterReload);

  // Survives switching away and back (real router path via the hash route).
  await cdp.send('Page.navigate', { url: `${BASE}/#/project/${pid}/session/${S.unread}?dir=${enc}` });
  await cdp.waitFor('switched away', `window.__station.state.current.sessionId === ${JSON.stringify(S.unread)}`, 15_000);
  await sleep(300);
  await cdp.send('Page.navigate', { url: `${BASE}/#/project/${pid}/session/${S.long}?dir=${enc}` });
  await cdp.waitFor('switched back', `window.__station.state.current.sessionId === ${JSON.stringify(S.long)}`, 15_000);
  await sleep(400);
  const afterSwitch = await cdp.eval(`() => ({ readline: !!document.querySelector('.readline'), readIndex: window.__station.state.threads.get('main')?.readIndex ?? null })`);
  check('read-line SURVIVES a switch away and back', afterSwitch.readline && afterSwitch.readIndex === 20, afterSwitch);

  // Clears when the user actually reads DOWN through it (scroll to bottom).
  await cdp.eval(`() => { const s=document.querySelector('#scroll'); s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event('scroll')); }`);
  await sleep(400);
  const afterRead = await cdp.eval(`() => ({ readline: !!document.querySelector('.readline'), mark: JSON.parse(localStorage.getItem('cs-readmark')||'{}')[${JSON.stringify(longKey)}] })`);
  check('reading DOWN to the bottom clears the line and advances the mark', !afterRead.readline && afterRead.mark > 20, afterRead);

  /* ─────────────────────── PART 3 — manual bookmark ────────────────────── */
  console.log('\n=== manual bookmark — set, jump, clear, persist ===');
  await cdp.eval(`() => { const s=document.querySelector('#scroll'); s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); }`);
  await sleep(300);
  await cdp.eval(`() => document.querySelector('#bookmark').click()`); // set at top
  await sleep(200);
  const setB = await cdp.eval(`() => ({
    ribbon: !!document.querySelector('[data-i].bookmarked'),
    set: document.querySelector('#bookmark').classList.contains('set'),
    stored: window.__station.state.bookmarks.get(${JSON.stringify(longKey)}),
  })`);
  check('bookmark SET drops a ribbon + fills the control + persists', setB.ribbon && setB.set && Number.isInteger(setB.stored), setB);

  await cdp.eval(`() => { const s=document.querySelector('#scroll'); s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event('scroll')); }`);
  await sleep(300);
  await cdp.eval(`() => document.querySelector('#bookmark').click()`); // jump (off-screen)
  await sleep(500);
  const jumpB = await cdp.eval(`() => {
    const m = document.querySelector('[data-i].bookmarked'); if (!m) return { seen:false };
    const s = document.querySelector('#scroll').getBoundingClientRect(); const r = m.getBoundingClientRect();
    return { seen: r.bottom > s.top && r.top < s.bottom };
  }`);
  check('bookmark JUMP returns to the bookmarked message in one click', jumpB.seen, jumpB);

  await cdp.eval(`() => location.reload()`);
  await cdp.waitFor('reopen for bookmark', `window.__station?.state.current.sessionId === ${JSON.stringify(S.long)}`, 30_000);
  await sleep(600);
  const persistB = await cdp.eval(`() => ({ ribbon: !!document.querySelector('[data-i].bookmarked'), set: document.querySelector('#bookmark')?.classList.contains('set') })`);
  check('bookmark SURVIVES a reload', persistB.ribbon && persistB.set, persistB);

  // Screenshot the transcript marks (light) for the human read.
  if (SHOTS) {
    await cdp.eval(`() => window.__station.jumpToReadLine?.()`);
    await sleep(400);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, 'f117-transcript-light.png'), Buffer.from(shot.data, 'base64'));
  }

  cdp.close();
}

main()
  .catch((e) => { console.error(e); fail++; failures.push(`harness threw: ${e.message}`); })
  .finally(async () => {
    stopByPid(server); stopByPid(browser);
    await sleep(300);
    for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    const total = pass + fail;
    console.log(`\n${'='.repeat(60)}\n  ${pass}/${total} passed${MUSTFAIL ? ' (MUSTFAIL — confirming markers ABSENT on HEAD; pairs with the present-on-working run for non-vacuity)' : ''}`);
    if (failures.length) console.log(`  failing: ${failures.join(' · ')}`);
    process.exit(fail ? 1 : 0);
  });
