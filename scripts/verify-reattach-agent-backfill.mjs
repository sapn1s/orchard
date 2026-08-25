/**
 * BUG-020 — a dashboard RELOAD while a session has a sub-agent (Task tool)
 * in flight must not silently blank the reattached client's "N agents
 * running" strip. The sub-agent is NEVER killed by the reload (established
 * by BUG-020's diagnosis, reusing BUG-018's detach-not-close guarantee) —
 * this is a pure display/reattach gap: `AgentSession.#agents`/`liveAgents()`
 * (src/server/agent-bridge.ts) survive detach()/attach() untouched, but the
 * reattach handshake (src/server/index.ts, the `running.attach(send)`
 * branch) used to call only `replayPending()` (BUG-008, approvals) — nothing
 * replayed sub-agent state, so a reattaching client's `state.agents`
 * (public/app.js) started empty and only ever got refilled by luck (a future
 * live event landing after attach). A sub-agent that fully finished DURING
 * the detach window got no event at all, ever.
 *
 *   node scripts/verify-reattach-agent-backfill.mjs
 *
 * Fix: `AgentSession.replayAgents()` (sibling to `replayPending()`) re-emits
 * one event per still-tracked `#agents` entry — `agent-started` for one
 * still `running`, `agent-completed` for one already settled — called from
 * the same index.ts reattach site, right after `replayPending()`.
 *
 * THE §C RULE this ticket exists to enforce: assert the USER-OBSERVABLE
 * outcome in a REAL BROWSER — after a real page reload, the reattached
 * client's on-screen "agents running" strip actually SHOWS the in-flight
 * sub-agent (DOM query), not merely that the server emitted an event.
 *
 * This drives the REAL server + a REAL headless browser (brave over raw CDP,
 * see docs/bugs' verification-tooling note — no Playwright/puppeteer here)
 * against a REAL haiku session that launches TWO REAL Task-tool sub-agents
 * (bypassPermissions so Task/Bash/Write never block on an approval card —
 * that path is BUG-008's, not this ticket's):
 *   - QUICK: sleeps ~1s, writes a marker, finishes almost immediately.
 *   - SLOW: sleeps ~10s before writing its marker and finishing —
 *     deliberately still running across the reload.
 * The Task tool in this SDK is ASYNCHRONOUS (the orchestrator does not block
 * on a sub-agent finishing), so the orchestrator is separately told to run
 * its OWN ~25s Bash sleep right after launching both agents — that is what
 * keeps the outer TURN genuinely busy (and therefore detach-not-close on the
 * reload) for a known window, independent of how the sub-agents progress.
 * The RELOAD lands inside that window, once QUICK has already completed and
 * SLOW is still mid-flight — exactly BUG-020's two cases (A: still running,
 * B: completed during detach) in one real turn.
 *
 * Sequence: real `Page.reload()` (the literal action this bug is named
 * after) → boot() re-applies the URL route → `applyRoute`/`openSession`
 * reopen the same session, passively following (no socket reattach yet,
 * exactly like a real reload) → the DOM strip is asserted EMPTY at this
 * point (the honest pre-reattach state — nothing has replayed anything yet)
 * → the test then does what a real returning user does: types a message and
 * clicks send, which (state.sdkSessionId is null after reload, so
 * `startTurn` auto-supplies `resumeSessionId: state.current.sessionId`)
 * drives the exact server reattach handshake this ticket fixes → assert the
 * DOM strip shows SLOW running IMMEDIATELY (before any further live event —
 * proof this is a deliberate replay, not luck) and reflects QUICK as settled
 * history, then assert the strip updates to SLOW's real completion.
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
const PORT = Number(process.env.VERIFY_RAB_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rab-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rab-work-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rab-chrome-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : (fail++, failures.push(name));
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
      try { if (await this.eval(expr)) return true; } catch { /* nav */ }
      await sleep(200);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let server = null, browser = null;
const cleanupDirs = [DATA, WORK, PROFILE];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

async function main() {
  // Deliberately NOT setting CLAUDE_PROJECTS_DIR: the Agent SDK subprocess
  // that actually writes transcripts ignores it and always writes under the
  // REAL `~/.claude/projects/<encoded cwd>` regardless. Session LISTING
  // (src/lib/session-history.ts defaultRoot()) DOES honor CLAUDE_PROJECTS_DIR
  // — setting it here would desync the two (transcripts land in the real
  // home, but the reload's session lookup would scan an empty scratch dir),
  // which is exactly the mismatch that made the reload never find this
  // session on the first attempt at writing this script. The real per-run
  // store directory is computed below and swept up in cleanup.
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'reattach-agent-backfill' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  // bypassPermissions: this ticket is about sub-agent DISPLAY on reattach, not
  // approval replay (that's BUG-008's) — no card should ever gate the turn.
  await (await fetch(`${BASE}/api/projects/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'haiku', permissionMode: 'bypassPermissions' }),
  })).json();

  // The real store dir the SDK subprocess actually writes into (see the
  // env-var note above) — swept up at the end alongside the tmp dirs.
  const realStoreEncoded = WORK.replace(/[^a-zA-Z0-9]/g, '-');
  cleanupDirs.push(path.join(os.homedir(), '.claude', 'projects', realStoreEncoded));

  const quickMarker = path.join(WORK, 'quick.marker');
  const slowMarker = path.join(WORK, 'slow.marker');

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  const wsFrames = [];
  cdp.ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.method === 'Network.webSocketFrameReceived') {
      try { wsFrames.push(JSON.parse(m.params.response.payloadData)); } catch { /* not json */ }
    }
  });

  await cdp.send('Page.navigate', { url: `${BASE}/#/project/${pid}` });
  await cdp.waitFor('boot', `window.__station !== undefined`);
  await cdp.waitFor('project selected', `window.__station.state.current.projectId === '${pid}'`);
  await sleep(300);

  console.log('\n=== 1. real session launches TWO real Task-tool sub-agents: QUICK (finishes fast) + SLOW (still running for a while) ===');
  // IMPORTANT: the Task tool in this SDK is ASYNCHRONOUS ("Async agent
  // launched successfully") — the orchestrator's own turn does NOT block on
  // a sub-agent finishing, so a naive "launch both, then stop" prompt lets
  // the ORCHESTRATOR's turn end (busy:false) almost immediately, regardless
  // of how long the sub-agents actually run. A session that is not busy is
  // just closed outright on socket loss (not detached) — the wrong scenario
  // entirely for this ticket. So the ORCHESTRATOR is given its OWN separate,
  // synchronous Bash sleep to run AFTER launching both agents, forcing the
  // outer turn to stay genuinely busy (and therefore detach-not-close on the
  // reload) for a known window while SLOW is still working in the background.
  const prompt = [
    'STRICT INSTRUCTIONS — follow exactly, do not improvise, do not use the Task tool more than TWICE in this entire conversation:',
    'Step 1: call the Task tool ONCE with subagent_type "general-purpose" and description exactly "quick-task". Its prompt must instruct the sub-agent to do EXACTLY this and nothing else: run one Bash tool call `sleep 1 && echo QUICK > ' + quickMarker + '`, then reply with exactly QUICK-DONE.',
    'Step 2: call the Task tool a SECOND time (your only other Task call) with subagent_type "general-purpose" and description exactly "slow-task". Its prompt must instruct the sub-agent to do EXACTLY this and nothing else: run one Bash tool call `sleep 10 && echo SLOW > ' + slowMarker + '`, then reply with exactly SLOW-DONE.',
    'Step 3: immediately after both Task calls above return (the Task tool returns right away, before its agent finishes — do not wait for it, do not call any other tool to check on it, ignore any task-notification message that arrives), run ONE Bash tool call `sleep 25` yourself, in THIS conversation, then say exactly MAIN-DONE. Then stop completely — send no further tool call of any kind, ever, for the rest of this conversation.',
  ].join('\n');
  const started = await cdp.eval(`(() => {
    const st = window.__station.state;
    document.querySelector('#prompt').value = ${JSON.stringify(prompt)};
    document.querySelector('#go').click();
    return true;
  })()`);
  check('drove the composer to start the real session', started === true, started);

  const gotBoth = await cdp.waitFor('both sub-agents started', `window.__station.state.agents.size >= 2`, 90_000);
  check('both Task-tool sub-agents produced a real agent-started (state.agents has 2 entries)', gotBoth,
    await cdp.eval(`window.__station.state.agents.size`));
  if (!gotBoth) throw new Error('sub-agents never started — cannot test replay');

  const ids = await cdp.eval(`[...window.__station.state.agents.keys()]`);
  const sdkSessionId = await cdp.eval(`window.__station.state.sdkSessionId`);
  const encodedDir = await cdp.eval(`window.__station.state.current.encodedDir`);
  check('a real sdkSessionId and encodedDir are known (needed for the reload route)',
    typeof sdkSessionId === 'string' && sdkSessionId.length > 0 && typeof encodedDir === 'string' && encodedDir.length > 0,
    { sdkSessionId, encodedDir });

  console.log('\n=== 2. wait for QUICK to finish while SLOW is still running — the exact split-state BUG-020 describes ===');
  // Capture the split ATOMICALLY in the SAME eval that checks for it — two
  // separate round-trips (a waitFor, then a follow-up eval) raced against a
  // fast-completing agent and observed the running one already gone by the
  // second call. Not pinned to exactly 2 agents — a real LLM occasionally
  // over-calls the Task tool despite the strict instructions.
  let snap = null;
  const t0split = Date.now();
  while (Date.now() - t0split < 60_000 && !snap) {
    snap = await cdp.eval(`(() => {
      const vals = [...window.__station.state.agents.entries()];
      const running = vals.find(([, a]) => a.agent.status === 'running');
      const done = vals.find(([, a]) => a.agent.status !== 'running');
      if (!running || !done) return null;
      return { runningId: running[0], doneId: done[0] };
    })()`).catch(() => null);
    if (!snap) await sleep(200);
  }
  check('QUICK settled and SLOW is still running, at the same time (both real, both observed live), captured atomically',
    !!snap, snap ?? await cdp.eval(`[...window.__station.state.agents.values()].map((a) => ({ id: a.agent.agentId, status: a.agent.status }))`));
  if (!snap) throw new Error('never reached the split state needed for this test');

  const runningId = snap.runningId, doneId = snap.doneId;
  check('captured a distinct running agentId (SLOW) and a distinct settled agentId (QUICK)',
    !!runningId && !!doneId && runningId !== doneId, snap);

  const preReload = await cdp.eval(`({
    stripHidden: document.querySelector('#strip').hidden,
    runningRow: document.querySelector('#stripRows button[data-thread="${runningId}"].run') !== null,
  })`);
  check('sanity BEFORE reload: the live strip shows the still-running agent (unfixed baseline behaviour, no reattach involved yet)',
    preReload.stripHidden === false && preReload.runningRow === true, preReload);

  console.log('\n=== 3. a REAL page reload (the literal action this bug is named after) ===');
  const hashBefore = await cdp.eval(`location.hash`);
  console.log(`        (debug) location.hash before reload: ${hashBefore}`);
  await cdp.send('Page.reload', { ignoreCache: false });
  await cdp.waitFor('re-boot', `window.__station !== undefined`, 30_000);
  const hashAfter = await cdp.eval(`location.hash`).catch(() => 'ERR');
  const debugRoute = await cdp.eval(`JSON.stringify({ cur: window.__station.state.current, projects: window.__station.state.projects.length })`).catch((e) => e.message);
  console.log(`        (debug) location.hash after reload: ${hashAfter}`);
  console.log(`        (debug) state after reload: ${debugRoute}`);
  const rerouted = await cdp.waitFor('reload lands back on the same session', `window.__station.state.current.sessionId === '${sdkSessionId}'`, 30_000);
  check('the reload re-opened the SAME session via the URL route (applyRoute)', rerouted,
    await cdp.eval(`window.__station.state.current.sessionId`));
  await sleep(500);

  const rightAfterReload = await cdp.eval(`({
    agentsSize: window.__station.state.agents.size,
    stripHidden: document.querySelector('#strip').hidden,
    sdkSessionId: window.__station.state.sdkSessionId,
  })`);
  check('HONEST PRE-CONDITION: immediately after reload, before any reattach, the client genuinely knows nothing yet (state.agents empty, no socket reattached) — this is the display gap BUG-020 describes, not something the fix should paper over before a reattach even happens',
    rightAfterReload.agentsSize === 0 && rightAfterReload.sdkSessionId === null, rightAfterReload);

  console.log('\n=== 4. the real user recovery path: send a message — triggers the exact reattach handshake this ticket fixes ===');
  console.log(`        (debug) /api/sessions/live before send: ${JSON.stringify(await (await fetch(`${BASE}/api/sessions/live`)).json())}`);
  // #go DOUBLE-DUTY as an interrupt/stop button while state.busy is true
  // (painted from the honest "this session was still working" liveRec —
  // see node.go.dataset.mode in app.js) — clicking it here would fire the
  // INTERRUPT handler, not submit(). A real user's Enter key always submits
  // regardless of that button's current mode, so drive it the same way.
  const sent = await cdp.eval(`(() => {
    const p = document.querySelector('#prompt');
    p.value = 'continue';
    p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
  check('drove the composer to send — this is what auto-supplies resumeSessionId and reattaches', sent === true, sent);

  // Race-sensitive: SLOW is a REAL background process that keeps advancing
  // wall-clock time regardless of the test, so a coarse "sleep N, then eval
  // once" check can miss a narrow still-running window. Poll off the RAW ws
  // frames (already streaming into `wsFrames` via CDP Network, no per-poll
  // round trip) for the reattach ack itself, then immediately snapshot the
  // DOM in the very next tick — this is as close as this harness gets to
  // "checked at the instant of reattach", not "checked eventually".
  let sawReattachAck = false;
  let afterReattach = null;
  const t0reatt = Date.now();
  while (Date.now() - t0reatt < 15_000 && !afterReattach) {
    if (!sawReattachAck) sawReattachAck = wsFrames.some((f) => f.t === 'ack' && f.of === 'start' && f.reattached === true);
    if (sawReattachAck) {
      const snap2 = await cdp.eval(`({
        agentIds: [...window.__station.state.agents.keys()],
        runningVisible: document.querySelector('#stripRows button[data-thread="${runningId}"].run') !== null,
        runningKnown: window.__station.state.agents.get('${runningId}')?.agent?.status ?? null,
        stripHidden: document.querySelector('#strip').hidden,
      })`);
      // Only settle once the row has actually shown up (or SLOW has, for
      // real, already finished by now — in which case there is nothing left
      // to catch and the loop should stop retrying).
      if (snap2.runningVisible || snap2.runningKnown !== 'running') { afterReattach = snap2; break; }
    }
    await sleep(80);
  }
  afterReattach = afterReattach ?? { agentIds: [], runningVisible: false, runningKnown: null, stripHidden: true };
  console.log(`        (debug) raw ws frames received: ${JSON.stringify(wsFrames.map((f) => ({ t: f.t, of: f.of, reattached: f.reattached, agentId: f.agent?.agentId, status: f.agent?.status })))}`);
  check('THE FIX (Case A — still running): the reattached client\'s live strip DOM shows the sub-agent that is STILL RUNNING server-side, not empty',
    sawReattachAck && afterReattach.runningVisible === true, afterReattach);

  console.log('\n=== 5. Case B — the sub-agent that already completed DURING the detach window is also reflected (not silently dropped) ===');
  const doneReflected = await cdp.eval(`({
    knowsDoneAgent: window.__station.state.agents.has('${doneId}'),
    doneStatus: window.__station.state.agents.get('${doneId}')?.agent?.status ?? null,
    settled: window.__station.state.agents.get('${doneId}')?.settled ?? null,
    ranRow: document.querySelector('#panes .pane.on .ran-row') !== null,
  })`);
  check('THE FIX (Case B — completed during detach): the reattached client also knows about the sub-agent that fully finished BEFORE the reload, not just the still-running one',
    doneReflected.knowsDoneAgent === true && doneReflected.doneStatus !== 'running', doneReflected);

  console.log('\n=== 6. SLOW genuinely finishes for real (proves it was never killed, and the strip updates live) ===');
  const finished = await cdp.waitFor('SLOW completes for real', `
    window.__station.state.agents.get('${runningId}')?.agent?.status !== 'running'
  `, 45_000);
  check('the previously-running sub-agent actually completes after the reattach (never killed by the reload)', finished,
    await cdp.eval(`window.__station.state.agents.get('${runningId}')?.agent?.status`));
  await sleep(500);
  const afterFinish = await cdp.eval(`({
    stillInRunningRow: document.querySelector('#stripRows button[data-thread="${runningId}"].run') !== null,
  })`);
  check('the strip DOM updates once SLOW completes — it moves out of the running row', afterFinish.stillInRunningRow === false, afterFinish);

  // A short grace poll: the client's agent-completed event and the actual
  // disk write (echo > marker, inside the sub-agent's own process) are not
  // guaranteed to be perfectly simultaneous.
  for (let i = 0; i < 50 && !fs.existsSync(slowMarker); i++) await sleep(200);
  check('LOAD-BEARING: SLOW\'s marker file actually landed on disk — the turn was never interrupted by the reload/reattach',
    fs.existsSync(slowMarker), `exists=${fs.existsSync(slowMarker)}`);
  check('LOAD-BEARING: QUICK\'s marker file also landed on disk',
    fs.existsSync(quickMarker), `exists=${fs.existsSync(quickMarker)}`);

  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const outDir = path.join(ROOT, 'docs', 'bugs', 'assets');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'BUG-020-after.png'), Buffer.from(shot.data, 'base64'));
    console.log(`        screenshot -> docs/bugs/assets/BUG-020-after.png`);
  } catch (e) { console.log(`        (screenshot failed: ${e.message})`); }

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
    if (!process.env.VERIFY_RAB_KEEP) for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
