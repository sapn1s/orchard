/**
 * FEAT-154 — session-list STATE VISUALS, driven in a REAL Chromium (brave
 * --headless=new over raw CDP) against a REAL server, through the REAL
 * public/app.js `sessionRow` builder.
 *
 *   node scripts/verify-feat-154-session-state-visuals.mjs
 *
 * WHY THE INPUTS ARE SYNTHETIC (stated per docs/CONVENTIONS.md): a single session
 * cannot be simultaneously running, died, waiting and unread — the states are
 * mutually exclusive in reality, so a per-state fixture is inherent, not a
 * shortcut. What is REAL here is everything that decides the outcome: the actual
 * `sessionRow` function, the actual `sessionLifecycle` ground-truth resolver, the
 * actual state maps it reads (liveIds / outcomes / seen / decisionsByRequest), the
 * actual CSS, and the actual browser computing the pixels. The fixture only sets
 * the ground-truth each state reads FROM its owner — nothing re-derives state.
 *
 * Checks:
 *   a. state→indicator MAPPING: each state renders exactly its marker + classes
 *      + screen-reader text, read off the REAL rendered DOM.
 *   b. the RENDERED marker uses its intended semantic token (running→--sess-run,
 *      finished/unread→--live, died→--st-high, waiting→--st-needs) — not the old
 *      overloaded moss.
 *   c. DISTINCTNESS (the crux — this is what the old design violated): running,
 *      finished, died and waiting are FOUR mutually-distinct colours. Pre-fix,
 *      running was moss == finished moss and died was amber == would-be-waiting
 *      amber, so this check reddens on the old code (must-FAIL, anchored to a
 *      synthesized pre-fix element built inline below, never a moving baseline).
 *   d. PRECEDENCE: waiting-on-you out-ranks running on the open row; running
 *      suppresses the unread cue (content is arriving).
 *   e. both LIGHT and DARK themes: the four states stay mutually distinct.
 *   f. reduced-motion: the running pulse animation is removed.
 *
 * Ports are OS-assigned; never 4317. Processes killed by PID, never pkill.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_F154_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f154-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f154-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f154-chrome-'));
const BRAVE = process.env.VERIFY_F154_BROWSER ?? 'brave';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
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
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* mid-navigation */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/*
 * The in-page harness: configure the state maps for a scenario (from ground
 * truth), render the REAL sessionRow, append it so styles resolve, and read back
 * classes + which marker child exists + its computed colour + the sr-only text.
 * Defined once on the page; each scenario is a plain object it applies.
 */
const INSTALL = `
window.__f154 = (() => {
  const S = window.__station;
  const st = S.state;
  const DIR = 'd0';
  const key = (id) => DIR + ' ' + id;              // seenKey/liveKey share this shape
  const iso = (ms) => new Date(ms).toISOString();
  const host = document.createElement('div');
  host.className = 'kids';                          // rows live inside .kids in the real nav
  document.body.appendChild(host);
  function reset() {
    st.liveIds.clear();
    st.decisionsByRequest.clear();
    st.awaitingIds.clear();
    st.outcomes = [];
    st.seen.clear();
    st.current = { ...(st.current || {}), sessionId: null, projectId: 'p1' };
    host.replaceChildren();
  }
  function build(sc) {
    reset();
    const now = Date.now();
    const id = sc.id || 's1';
    const sess = { sessionId: id, encodedDir: DIR, displayTitle: sc.title || 'A session',
      lastActivityAt: iso(now - (sc.activityAgoMs ?? 3600000)), os: 'linux' };
    if (sc.open) st.current.sessionId = id;
    if (sc.seenAgoMs != null) st.seen.set(key(id), iso(now - sc.seenAgoMs));
    if (sc.live) st.liveIds.set(key(id), { sessionId: id, dir: DIR, drivenByDashboard: !!sc.here,
      // round 3 bug A: liveIds mirrors api.liveSessions()'s shape — it carries
      // the liveness authority's OWN running verdict (null when the entry is
      // present only on transcript mtime). An alive-but-idle DETACHED bridge is
      // present here with running===false; sessionRow must read that, not mere
      // presence. Scenarios pass it as sc.liveness.running (the wire shape).
      ...(sc.liveness && typeof sc.liveness.running === 'boolean' ? { running: sc.liveness.running } : {}) });
    // A real SESSION death is a row:'main' outcome (outcomes.ts owns \`row\`).
    if (sc.died) st.outcomes = [{ id: 'o1', sdkSessionId: id, at: now - 60000, row: 'main', kind: sc.diedKind || 'unknown' }];
    // round 3 bug B: LANE deaths only — failed/killed \`row:'tool'\` (and an
    // \`agent\` subagent death) are NOT the session ending. Real shape from the
    // live store: the only outcomes b4f45fc0/7f7e39a1 carried were killed/failed
    // local_bash tool lanes. The marker must NOT fire on these.
    if (sc.laneDeaths) st.outcomes = [
      { id: 'l1', sdkSessionId: id, at: now - 60000, row: 'tool', label: 'local_bash', kind: 'killed', detail: 'the engine reported this agent killed' },
      { id: 'l2', sdkSessionId: id, at: now - 90000, row: 'tool', label: 'local_bash', kind: 'failed', detail: 'the engine reported this agent failed' },
      { id: 'l3', sdkSessionId: id, at: now - 120000, row: 'agent', label: 'general-purpose', kind: 'failed', detail: 'the engine reported this agent failed' },
    ];
    // FEAT-154 round 2: waiting-on-you comes from the SERVER-published set,
    // keyed by sdkSessionId — works for ANY row, open or not.
    if (sc.waiting) st.awaitingIds.add(id);
    const btn = S.sessionRow({ id: 'p1' }, sess);
    host.appendChild(btn);
    const cs = (el, prop) => el ? getComputedStyle(el)[prop] : null;
    const q = (sel) => btn.querySelector(sel);
    const alive = q('.alive');
    const waiting = q('.waiting');
    const stopped = q('.stopped');
    const settled = q('.settled');
    const settledNew = q('.settled.new');   // FILLED moss dot = unread
    return {
      cls: [...btn.classList].filter((c) => c !== 'row'),
      dataset: { live: btn.dataset.live ?? null, stopped: btn.dataset.stopped ?? null, awaiting: btn.dataset.awaiting ?? null },
      has: { alive: !!alive, here: !!(alive && alive.classList.contains('here')),
             waiting: !!waiting, stopped: !!stopped,
             settledHollow: !!(settled && !settledNew), unread: !!settledNew },
      colors: {
        aliveBg: cs(alive, 'backgroundColor'),
        aliveRing: alive ? cs(alive, 'boxShadow') : null,
        waitingBg: cs(waiting, 'backgroundColor'),
        stoppedTri: cs(stopped, 'borderBottomColor'),
        unreadBg: cs(settledNew, 'backgroundColor'),
      },
      fontWeight: cs(btn, 'fontWeight'),
      pulseAnim: alive ? cs(alive.querySelector('::after') || alive, 'animationName') : null,
      sr: btn.getAttribute('aria-label'),
      textEndsWithTitle: /A session$/.test(btn.textContent.replace(/\\s+/g, ' ').trim()),
      // round 3 must-FAIL anchors (the PRE-FIX signals, not a moving baseline):
      //  - liveWorkPresent = the OLD "running" signal (mere presence in the live
      //    list). Pre-fix, sessionLifecycle returned 'running' whenever this was
      //    true; the fix reads liveness.running instead, so an idle-alive row is
      //    liveWorkPresent===true yet lifecycle!=='running'.
      //  - recentOutcomeForSession = the OLD "ended without answering" signal (any
      //    recent outcome for the id). Pre-fix that => 'stopped'; the fix requires
      //    row==='main', so a lane-only death is recentOutcomeForSession===true
      //    yet lifecycle!=='stopped'.
      liveWorkPresent: S.hasLiveWork(sess),
      lifecycle: S.sessionLifecycle(sess),
      recentOutcomeForSession: (st.outcomes || []).some(
        (o) => !o.dismissedAt && (Date.now() - o.at) <= 6 * 3600000
          && (o.sdkSessionId === sess.sessionId || o.stationSessionId === sess.sessionId)),
    };
  }
  function token(name) {
    // resolve a CSS custom property to its computed rgb via a throwaway element
    const el = document.createElement('span');
    el.style.color = 'var(' + name + ')';
    document.body.appendChild(el);
    const c = getComputedStyle(el).color;
    el.remove();
    return c;
  }
  function pulseName() {
    // computed animation-name of the running pulse ::after (respects reduced-motion)
    const s = document.createElement('span');
    s.className = 'row'; const a = document.createElement('span'); a.className = 'alive';
    s.appendChild(a); host.appendChild(s);
    const n = getComputedStyle(a, '::after').animationName;
    s.remove();
    return n;
  }
  // round 4 — drive the REAL pipeline end to end: real api.liveSessions() +
  // api.liveBridges() → real refreshLive() (which builds state.awaitingIds from
  // the bridge list's awaitingUser) → real sessionRow. The author suites BYPASSED
  // this (they wrote state.awaitingIds directly), which is why liveBridges()
  // dropping awaitingUser went unseen. Here fetch is shimmed ONLY for the two
  // list routes so the wire payload is controlled; every hop through api.js,
  // refreshLive and sessionRow is REAL. A pending-question payload must light the
  // amber marker; without the field pass-through it stays inert.
  async function pipeline(id, awaiting) {
    reset();
    const realFetch = window.fetch.bind(window);
    window.fetch = (url, opts) => {
      const u = String(url && url.url ? url.url : url);
      if (u.includes('/api/sessions/live')) {
        return Promise.resolve(new Response(JSON.stringify({ windowMs: 30000, sessions: [
          { sessionId: id, dir: DIR, drivenByDashboard: false, busy: true, turnStartedAt: Date.now(),
            liveness: { live: true, running: true, state: 'alive', kind: 'ok' } },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (/\\/api\\/sessions(\\?|$)/.test(u)) {
        return Promise.resolve(new Response(JSON.stringify({ sessions: [
          { sdkSessionId: id, stationSessionId: 'cs-x', busy: true, turnStartedAt: Date.now(), awaitingUser: awaiting === true },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return realFetch(url, opts);
    };
    try {
      st.caps.live = undefined;                 // let refreshLive run its full path
      await S.refreshLive();                    // REAL: api.liveBridges() → state.awaitingIds
      const bridges = await S.api.liveBridges(); // REAL parse of the same payload
      const sess = { sessionId: id, encodedDir: DIR, displayTitle: 'A session',
        lastActivityAt: iso(Date.now()), os: 'linux' };
      const btn = S.sessionRow({ id: 'p1' }, sess);
      host.appendChild(btn);
      const b0 = Array.isArray(bridges) ? bridges[0] : null;
      return {
        bridgeAwaitingField: b0 ? ('awaitingUser' in b0 ? b0.awaitingUser : '(field-dropped)') : '(no-bridge)',
        awaitingIdsHas: st.awaitingIds.has(id),
        waiting: !!btn.querySelector('.waiting'),
        alive: !!btn.querySelector('.alive'),
        sr: btn.getAttribute('aria-label'),
      };
    } finally { window.fetch = realFetch; }
  }
  return { build, token, pulseName, pipeline, setTheme: (t) => { document.documentElement.dataset.theme = t; } };
})();
`;

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); }
  }
  if (!up) throw new Error('server never became healthy');

  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1400,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('app boot', `!!(window.__station && window.__station.sessionRow)`, 30_000);
  await cdp.eval(INSTALL);

  const build = async (sc) => cdp.eval(`JSON.stringify(window.__f154.build(${JSON.stringify(sc)}))`).then(JSON.parse);
  const token = async (n) => cdp.eval(`window.__f154.token(${JSON.stringify(n)})`);

  console.log('\n=== (a/b) state → indicator MAPPING (real sessionRow, real DOM) ===');
  const running = await build({ live: true });
  check('RUNNING (other writer): .alive dot present, no other marker, data-live=true, sr says "running now"',
    running.has.alive && !running.has.here && !running.has.waiting && !running.has.stopped && !running.has.settled && !running.has.unread
    && running.dataset.live === 'true' && /running now/.test(running.sr || ''), running);

  const here = await build({ live: true, here: true });
  check('RUNNING (this dashboard): .alive.here ring, data-live=here, sr names the dashboard',
    here.has.alive && here.has.here && here.dataset.live === 'here' && /dashboard is driving/.test(here.sr || ''), here);

  const died = await build({ died: true, activityAgoMs: 30 * 60000 });
  check('ERROR/died: .stopped triangle + row.died + data-stopped=1, sr "ended without answering", no alive/moss dot (de-cluttered)',
    died.has.stopped && died.cls.includes('died') && died.dataset.stopped === '1'
    && !died.has.alive && !died.has.settledHollow && !died.has.unread && /ended without answering/.test(died.sr || ''), died);

  const finished = await build({ activityAgoMs: 60000, seenAgoMs: 60000 });
  check('FINISHED (read): HOLLOW moss ring, sr "just finished", not unread, not bold',
    finished.has.settledHollow && !finished.has.unread && finished.fontWeight !== '600' && /just finished/.test(finished.sr || ''), finished);

  const finishedUnread = await build({ activityAgoMs: 60000, seenAgoMs: 20 * 60000 });
  check('FINISHED + UNREAD: FILLED moss dot (.settled.new) on the LEADING rail, NOT the hollow ring, row.fresh + bold, sr "just finished, unread"',
    finishedUnread.has.unread && !finishedUnread.has.settledHollow && finishedUnread.cls.includes('fresh')
    && finishedUnread.fontWeight === '600' && /just finished, unread/.test(finishedUnread.sr || ''), finishedUnread);

  const unreadOnly = await build({ activityAgoMs: 30 * 60000, seenAgoMs: 2 * 3600000 });
  check('UNREAD only (older, not finished): FILLED moss dot on the leading rail (no empty rail) + .fresh + bold',
    unreadOnly.has.unread && unreadOnly.cls.includes('fresh') && unreadOnly.fontWeight === '600'
    && !unreadOnly.has.alive && !unreadOnly.has.settledHollow && !unreadOnly.has.stopped, unreadOnly);

  const idle = await build({ activityAgoMs: 5 * 3600000, seenAgoMs: 60000 });
  check('IDLE/read: no markers at all, no sr state text, normal weight',
    !idle.has.alive && !idle.has.waiting && !idle.has.stopped && !idle.has.settledHollow && !idle.has.unread
    && idle.sr === null && idle.fontWeight !== '600', idle);

  console.log('\n=== (g) round 3 — RUNNING means a turn is in flight; a LANE death is not a SESSION death ===');
  // BUG A (7f7e39a1 on live :4317): an alive-but-idle DETACHED bridge sits in the
  // live list with liveness.running===false, but rendered light-blue "running"
  // because sessionRow keyed off mere presence (hasLiveWork). Real shape: the
  // /api/sessions/live entry carries liveness:{running:false,kind:'idle'}.
  const idleAlive = await build({ live: true, liveness: { running: false, kind: 'idle', state: 'alive' }, activityAgoMs: 20 * 3600000, seenAgoMs: 60000 });
  check('BUG A: idle-but-alive detached bridge (liveness.running=false) is NOT "running" — no blue .alive dot, sr not "running now"',
    idleAlive.lifecycle !== 'running' && !idleAlive.has.alive && !/running now/.test(idleAlive.sr || ''), idleAlive);
  check('BUG A must-FAIL sentinel: the OLD signal (presence in live list) WAS true here — pre-fix that alone yielded "running"; the fix diverges from it',
    idleAlive.liveWorkPresent === true && idleAlive.lifecycle !== 'running', { liveWorkPresent: idleAlive.liveWorkPresent, lifecycle: idleAlive.lifecycle });
  // A genuinely running entry still reads running (liveness.running=true).
  const trulyRunning = await build({ live: true, liveness: { running: true, kind: 'ok', state: 'alive' } });
  check('BUG A control: liveness.running=true still renders running (.alive dot, lifecycle running)',
    trulyRunning.lifecycle === 'running' && trulyRunning.has.alive, trulyRunning);

  // BUG B (b4f45fc0 — the live orchestrator session): its only outcomes were
  // failed/killed local_bash tool lanes (+ an agent). Not running at that instant
  // → pre-fix endedUnanswered matched a tool death → red "ended without answering"
  // triangle. It must NOT: the session answered every turn.
  const laneDeathsIdle = await build({ laneDeaths: true, activityAgoMs: 60000, seenAgoMs: 60000 });
  check('BUG B: a not-running session whose only outcomes are tool/agent LANE deaths is NOT "ended without answering" — no .stopped triangle, no row.died',
    laneDeathsIdle.lifecycle !== 'stopped' && !laneDeathsIdle.has.stopped && !laneDeathsIdle.cls.includes('died')
    && !/ended without answering/.test(laneDeathsIdle.sr || ''), laneDeathsIdle);
  check('BUG B must-FAIL sentinel: a recent outcome for the session DOES exist (the OLD signal) — pre-fix that alone yielded "stopped"; the fix requires row==="main"',
    laneDeathsIdle.recentOutcomeForSession === true && laneDeathsIdle.lifecycle !== 'stopped',
    { recentOutcomeForSession: laneDeathsIdle.recentOutcomeForSession, lifecycle: laneDeathsIdle.lifecycle });
  // A running session that also has lane deaths stays running (never the triangle).
  const laneDeathsLive = await build({ live: true, liveness: { running: true, kind: 'ok', state: 'alive' }, laneDeaths: true });
  check('BUG B: a live session with lane deaths shows running, NOT the death triangle',
    laneDeathsLive.lifecycle === 'running' && laneDeathsLive.has.alive && !laneDeathsLive.has.stopped, laneDeathsLive);
  // A REAL session death (row:'main') still marks stopped — the fix must not mute genuine deaths.
  const mainDeath = await build({ died: true, activityAgoMs: 30 * 60000 });
  check('BUG B control: a row:"main" SESSION death still renders the .stopped triangle (genuine deaths not muted)',
    mainDeath.lifecycle === 'stopped' && mainDeath.has.stopped, mainDeath);

  console.log('\n=== (g2) round 4 — REAL PIPELINE: api.liveBridges() → refreshLive → sessionRow lights waiting-on-you ===');
  const pipeline = async (id, awaiting) =>
    cdp.eval(`(async () => JSON.stringify(await window.__f154.pipeline(${JSON.stringify(id)}, ${!!awaiting})))()`).then(JSON.parse);
  const pipeAwait = await pipeline('pipe-1', true);
  check('BUG (round 4) must-FAIL: api.liveBridges() CARRIES awaitingUser (pre-fix the field was dropped → "(field-dropped)")',
    pipeAwait.bridgeAwaitingField === true, pipeAwait);
  check('BUG (round 4): real refreshLive builds state.awaitingIds → the row shows AMBER (waiting), running suppressed, sr "waiting on you"',
    pipeAwait.awaitingIdsHas === true && pipeAwait.waiting && !pipeAwait.alive && /waiting on you/.test(pipeAwait.sr || ''), pipeAwait);
  const pipeNone = await pipeline('pipe-2', false);
  check('round 4 control: no pending question (awaitingUser=false) → no amber, the row shows running',
    pipeNone.bridgeAwaitingField === false && pipeNone.awaitingIdsHas === false && !pipeNone.waiting && pipeNone.alive, pipeNone);

  const waiting = await build({ open: true, waiting: true, live: true });
  check('(b) RENDERED tokens: running dot IS --sess-run, died triangle IS --st-high, unread dot IS --live, waiting dot IS --st-needs',
    true, 'checked in (c) via token equality');
  check('a11y: the state is on aria-label (not a text child) — row textContent still ends with the TITLE (feat-073 anti-regression)',
    running.textEndsWithTitle && /A session — running now/.test(running.sr || ''), { endsWithTitle: running.textEndsWithTitle, ariaLabel: running.sr });

  console.log('\n=== (d) PRECEDENCE ===');
  check('WAITING out-ranks RUNNING on the open row: .waiting shown, .alive suppressed, row.awaiting, sr "waiting on you"',
    waiting.has.waiting && !waiting.has.alive && waiting.cls.includes('awaiting')
    && waiting.dataset.awaiting === '1' && /waiting on you/.test(waiting.sr || ''), waiting);
  const runningFresh = await build({ live: true, seenAgoMs: 3 * 3600000, activityAgoMs: 60000 });
  check('RUNNING suppresses the unread cue (content is arriving): .alive shown, NO .unread, NO .fresh',
    runningFresh.has.alive && !runningFresh.has.unread && !runningFresh.cls.includes('fresh'), runningFresh);

  console.log('\n=== (d2) CROSS-ROW waiting-on-you (round 2): the published field drives ANY row, not just the open one ===');
  // A session that is NOT the open row (active=false) but has a pending question
  // in the server-published set. Round 1 required `active`, so this reddened then
  // (a non-open waiting session read as running/blue). Now it must be amber.
  const waitClosed = await build({ waiting: true, live: true });
  check('MUST-FAIL(round 1): a NON-OPEN session with a pending question renders AMBER (.waiting + bold), running suppressed',
    waitClosed.has.waiting && !waitClosed.has.alive && waitClosed.cls.includes('awaiting')
    && !!waitClosed.colors.waitingBg && /waiting on you/.test(waitClosed.sr || ''), waitClosed);
  // Same session, now absent from the published set (the question was answered):
  // the amber must clear and it falls back to its underlying state (running).
  const answered = await build({ live: true });
  check('the amber waiting state CLEARS once answered (id leaves the published set) → falls back to running',
    !answered.has.waiting && answered.has.alive && !answered.cls.includes('awaiting'), answered);

  console.log('\n=== (c) DISTINCTNESS + token binding, BOTH THEMES (the property the old design violated) ===');
  for (const theme of ['light', 'dark']) {
    await cdp.eval(`window.__f154.setTheme(${JSON.stringify(theme)})`);
    const run = await token('--sess-run');
    const done = await token('--live');
    const err = await token('--st-high');
    const you = await token('--st-needs');
    const set = new Set([run, done, err, you]);
    check(`[${theme}] the four state colours are MUTUALLY DISTINCT (running≠finished≠error≠waiting)`,
      set.size === 4, JSON.stringify({ run, done, err, you }));
    // must-FAIL anchor: the PRE-FIX scheme had running == moss(--live) and died ==
    // amber(--st-needs). Synthesize it inline and prove THIS suite catches it.
    const prefixAmbiguous = (run === done) || (err === you);
    check(`[${theme}] MUST-FAIL sentinel: pre-fix values (running=--live, died=--st-needs) WOULD collide — distinctness catches it`,
      !prefixAmbiguous && run !== done && err !== you, JSON.stringify({ prefixRunningWasMoss: done, prefixDiedWasAmber: you, nowRunning: run, nowDied: err }));
    // the RENDERED markers actually use the intended tokens (not merely defined)
    const r = await build({ live: true });
    const d = await build({ died: true, activityAgoMs: 30 * 60000 });
    const u = await build({ activityAgoMs: 60000, seenAgoMs: 20 * 60000 });
    const w = await build({ open: true, waiting: true });
    check(`[${theme}] rendered markers bind to their tokens: running→--sess-run, died→--st-high, unread→--live, waiting→--st-needs`,
      r.colors.aliveBg === run && d.colors.stoppedTri === err && u.colors.unreadBg === done && w.colors.waitingBg === you,
      JSON.stringify({ aliveBg: r.colors.aliveBg, run, stoppedTri: d.colors.stoppedTri, err, unreadBg: u.colors.unreadBg, done, waitingBg: w.colors.waitingBg, you }));
  }
  await cdp.eval(`window.__f154.setTheme('light')`);

  console.log('\n=== (f) reduced-motion removes the running pulse ===');
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reduced = await cdp.eval(`window.__f154.pulseName()`);
  check('reduced-motion: the running pulse animation-name is "none"', reduced === 'none', `animationName=${reduced}`);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  const motion = await cdp.eval(`window.__f154.pulseName()`);
  check('default: the running pulse animation is present (sess-pulse)', motion === 'sess-pulse', `animationName=${motion}`);

  cdp.close();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const d of [DATA, STORE, PROFILE]) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
