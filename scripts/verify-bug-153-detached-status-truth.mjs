/**
 * BUG-153 — the status a user READS and the guard that REFUSES their send must
 * come from one predicate, and a queued message this tab cannot deliver must be
 * recoverable in one action.
 *
 * The live loss, as reported: a session kept working in the background after
 * the service restarted, the interface stopped saying so, and Force send
 * answered "no live session to force-send over" on a session it was still
 * presenting as attached. Then: "if i reload page it still shows the message in
 * queue instead of input field, then id need to remove msg from queue and send
 * again, weird ux to say the least."
 *
 * Nothing here is mocked. A REAL server, REAL `claude` sessions holding a REAL
 * in-flight turn, and a REAL headless browser doing the user's clicks. The two
 * scenarios are the two halves of the report:
 *
 *   A — THE CHIP LIES ABOUT A RUNNING SESSION. Another driver holds session S
 *       mid-turn. The user opens S here; the chip correctly says "Running in
 *       background — send a message to take it over"; the user does exactly
 *       that and the server refuses (S is attached elsewhere). The refusal's
 *       connect() is the second socket the prior lane named: it is what used to
 *       clear `state.sessDetached`. Pre-fix the chip then reads "Idle —
 *       Nothing is running" over a session that is provably mid-turn (checked
 *       against the SERVER, not the client's belief). Post-fix it still says
 *       running-in-background, and agrees with every guard.
 *
 *   B — THE QUEUED MESSAGE IS UNRECLAIMABLE. The user's own session T is
 *       running, they queue a message into it, then reload (the shape the
 *       restart produced: transport gone, work still running, rows restored
 *       from browser storage). The row comes back `restored` — alive, not
 *       dead, so BUG-149's "To composer" did NOT apply to it. Pre-fix its only
 *       action is a Force send that refuses; the way out is Discard and retype.
 *       Post-fix one click puts the exact text back in the composer, and the
 *       next Enter takes the session over and delivers it.
 *
 * Also asserted continuously, at every observation point in both scenarios:
 * the chip and the guards NEVER disagree — "Thinking…"/"Responding…" is only
 * ever shown by a tab that actually holds the socket force-send/interrupt act
 * on. That is the property whose absence was the bug, so it is checked as a
 * property rather than at one lucky moment.
 *
 * The MUST-FAIL baseline is CONSTRUCTED, never `git show HEAD`: committing the
 * fix must not turn this proof into decoration. Every substitution asserts its
 * hit count, so a transform that stops matching throws instead of quietly
 * proving nothing.
 *
 *   node scripts/verify-bug-153-detached-status-truth.mjs
 */
import { spawn, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRATCH_ROOT = process.env.ORCHARD_SCRATCH || path.join(os.homedir(), 'scratch');
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const SCRATCH = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'bug153-'));
const DATA = path.join(SCRATCH, 'data');
const PROFILE = path.join(SCRATCH, 'chrome');
for (const d of [DATA, PROFILE]) fs.mkdirSync(d, { recursive: true });
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const SHOTS = path.join(SCRATCH_ROOT, 'bug153-shots');
fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/* ------------------------------------------------------------------- CDP */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.on = new Map(); }
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
      } else if (m.method && c.on.has(m.method)) c.on.get(m.method)(m.params);
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
  async waitFor(label, expr, timeoutMs = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* navigating */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

/*
 * The MUST-FAIL baseline, CONSTRUCTED rather than checked out: each hunk of the
 * fix is mechanically inverted back to what shipped before it, and every
 * substitution asserts it matched exactly once.
 *
 *   1-4. the status chip reads the EVENT-SET flag again — `state.sessDetached`,
 *        raised on the reopen path, cleared by any socket open (connect) and by
 *        the start ack. Those are the four sites the fix removed; putting all
 *        four back is what makes the pre-fix leg a faithful re-run rather than
 *        a hobbled one.
 *   5.   force-send re-derives liveness itself instead of asking isDriving().
 *   6-7. the queue row offers Force send unconditionally and "To composer" only
 *        on a dead row (BUG-149's original scope) — the `<span>` keeps the
 *        surrounding code identical while producing no button for the probe to
 *        find, which is exactly the pre-fix dead end.
 */
const PRE_FIX = [
  ['chip reads the flag',
    `  if (!isDriving()) return (state.busy || state.followingLive) ? 'detached' : 'idle';`,
    `  if (state.sessDetached && !state.live) return 'detached';`],
  ['the reopen path raises the flag',
    `        state.followingLive = true;\n        if (liveRec.busy !== false) {`,
    `        state.followingLive = true;\n        state.sessDetached = true;\n        if (liveRec.busy !== false) {`],
  ['any socket open clears the flag',
    `      state.sessReconnecting = false;\n      state.budgetLocked = false;`,
    `      state.sessReconnecting = false;\n      state.sessDetached = false;\n      state.budgetLocked = false;`],
  ['the start ack clears the flag',
    `        // (\`followingLive\` is cleared just above, for the same reason.)\n        state.sessReconnecting = false;`,
    `        state.sessDetached = false;\n        state.sessReconnecting = false;`],
  ['force-send re-derives liveness',
    `  if (!isDriving() || state.dropped) {`,
    `  if (!state.live || !state.ws || state.dropped) {`],
  ['force send is offered unconditionally',
    `    if (!item.dead && isDriving() && !state.dropped) {`,
    `    if (!item.dead) {`],
  ['"To composer" only on a dead row',
    `    const back = el('button', { class: 'mini', text: 'To composer' });`,
    `    const back = item.dead ? el('button', { class: 'mini', text: 'To composer' }) : el('span', {});`],
];

function preFixClient() {
  let src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  for (const [name, from, to] of PRE_FIX) {
    const hits = src.split(from).length - 1;
    if (hits !== 1) throw new Error(`pre-fix transform "${name}" matched ${hits}x (expected 1)`);
    src = src.replace(from, to);
  }
  // `sessDetached` no longer exists on the state object; the pre-fix legs write
  // and read it, so give it back its initial value too.
  const anchor = `  // BUG-153: there is no \`sessDetached\` flag.`;
  if (src.split(anchor).length - 1 !== 1) throw new Error('pre-fix transform "state field" did not match once');
  return src.replace(anchor, `  sessDetached: false,\n${anchor}`);
}

/* --------------------------------------------------------------- probes */

const CHIP = `(() => {
  const c = document.querySelector('#sessStatus');
  return {
    state: c?.dataset.state ?? null,
    label: document.querySelector('#sessStatusLbl')?.textContent ?? '',
    title: c?.title ?? '',
  };
})()`;

/*
 * The two halves of the bug, read at the same instant. `driving` is computed
 * from the raw socket rather than from isDriving(), so the probe means the same
 * thing in both legs (the pre-fix leg has the function but does not use it).
 */
const AGREE = `(() => {
  const s = window.__station.state;
  const driving = !!(s.live && s.ws && s.ws.readyState === 1 && !s.deliveryRelay);
  return {
    chip: window.__station.computeSessState(),
    driving,
    busy: s.busy, live: s.live, dropped: s.dropped, following: s.followingLive,
  };
})()`;

const DOCK = `(() => ({
  rows: [...document.querySelectorAll('#queueBox .qrow')].map((r) => ({
    status: r.querySelector('.qs')?.textContent ?? '',
    text: r.querySelector('.qedit')?.value ?? '',
    dead: r.classList.contains('dead'),
    restored: r.classList.contains('restored'),
    acts: [...r.querySelectorAll('.cacts button')].map((b) => b.textContent),
  })),
  label: document.querySelector('#queueBox .q-l')?.textContent ?? '',
}))()`;

/*
 * Sidebar clicks, scoped to ONE project's group. The first attempt at this
 * clicked `.proj` unconditionally and collapsed the project the app had already
 * expanded, so the session row it then waited for could never appear — and the
 * bug would have been "proved" by a harness that never opened the session.
 * Expansion is now checked before it is toggled, and every subsequent query is
 * scoped inside that group, so a row belonging to another project cannot be
 * mistaken for this one's.
 */
const group = (name) => `[...document.querySelectorAll('#tree .pgroup')]`
  + `.find(g => (g.querySelector('.proj .nm')?.textContent ?? '') === ${JSON.stringify(name)})`;

/*
 * A freshly registered project has no activity yet, so the sidebar files it
 * under "N inactive projects" — where the user would have to disclose it. Doing
 * the same click here is what makes the rest of the run possible; without it the
 * project is genuinely absent and every later query throws on undefined.
 */
async function revealProject(cdp, name) {
  if (await cdp.eval(`!!(${group(name)})`)) return;
  await cdp.eval(`document.querySelector('#tree .inactive-l')?.click()`);
  const there = await cdp.waitFor(`the project "${name}" in the sidebar`, `!!(${group(name)})`, 30_000);
  if (!there) throw new Error(`the project ${name} never appeared in the sidebar, active or inactive`);
}

async function expandProject(cdp, name) {
  const there = await cdp.waitFor(`the project "${name}" in the sidebar`, `!!(${group(name)})`, 20_000);
  if (!there) await revealProject(cdp, name);
  await cdp.eval(`(() => {
    const g = ${group(name)};
    const h = g.querySelector('.proj');
    if (h.getAttribute('aria-expanded') !== 'true') h.click();
  })()`);
}

const typeSend = (t) => `(() => {
  const p = document.querySelector('#prompt');
  p.value = ${JSON.stringify(t)};
  p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
})()`;

async function shot(cdp, name) {
  try {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(SHOTS, `${name}.png`);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    console.log(`        screenshot: ${f}`);
  } catch (e) { console.log(`        (screenshot ${name} failed: ${e.message})`); }
}

/**
 * THE property, asserted wherever we look: a tab that is not driving may not
 * claim Claude is working. Collected per leg and graded once, so it covers
 * every observation rather than one chosen moment.
 */
function agreementViolation(where, a) {
  const claimsWorking = a.chip === 'thinking' || a.chip === 'streaming';
  return claimsWorking && !a.driving ? `${where}: chip=${a.chip} while not driving (${JSON.stringify(a)})` : null;
}

/* ------------------------------------------------------ server / fixtures */

let server = null, browser = null;
const rawSockets = [];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/*
 * Session hosts OUTLIVE the server that spawned them — that is the survival
 * machinery working as designed, and it means killing the server is not enough:
 * a run of this script left a haiku CLI sleeping for 150s under a data dir that
 * had already been deleted. Only hosts whose control file is inside THIS run's
 * scratch dir are matched, and each is killed by pid. Nothing is matched by
 * name, so no host belonging to the real station can be touched.
 */
function reapMyHosts() {
  let out = '';
  try {
    out = execSync('ps -eo pid=,args=', { encoding: 'utf8' });
  } catch { return; }
  for (const line of out.split('\n')) {
    if (!line.includes('session-host.mjs') || !line.includes(SCRATCH)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    console.log(`        reaping my own leftover session host, pid ${pid}`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
}
const PORT = Number(await freePort());
const BASE = `http://127.0.0.1:${PORT}`;

/** A turn that stays in flight long enough to assert against: a real Bash sleep.
 * python3, not a bare `sleep`, because some dev machines run a hook that blocks
 * standalone sleeps and the model then ends the turn in seconds. */
const slowPrompt = (secs, sentinel) =>
  `Do exactly these steps in order and nothing else. `
  + `Step 1: use the Bash tool to run the command: python3 -c 'import time; time.sleep(${secs})' . `
  + `Step 2: then reply with exactly: ${sentinel}`;

// Every project dir this script creates has a Claude store dir under ~/.claude
// that outlives SCRATCH — collected here so cleanup removes both.
const storeDirs = [];

async function registerProject(name) {
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  storeDirs.push(path.join(os.homedir(), '.claude', 'projects', dir.replace(/[/.]/g, '-')));
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: dir, name }),
  })).json();
  if (!reg.project?.id) throw new Error(`register ${name} failed: ${JSON.stringify(reg)}`);
  return reg.project.id;
}

/** Ground truth from the SERVER: is this session mid-turn right now? */
async function serverSaysBusy(sessionId) {
  try {
    const live = await (await fetch(`${BASE}/api/sessions/live`)).json();
    const rec = (live.sessions ?? live ?? []).find((x) => x.sessionId === sessionId);
    return { found: !!rec, busy: rec?.busy === true, driven: rec?.drivenByDashboard === true };
  } catch (e) { return { found: false, busy: false, driven: false, error: e.message }; }
}

/** A raw socket standing in for the OTHER driver — a second tab, or the tab
 * that started the run before this one opened the session. */
async function openRawDriver(projectId, prompt) {
  const events = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  rawSockets.push(ws);
  ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
  ws.send(JSON.stringify({
    type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt,
  }));
  const t0 = Date.now();
  let init = null;
  while (Date.now() - t0 < 240_000 && !init) { init = events.find((e) => e.t === 'session-init'); await sleep(200); }
  if (!init?.sessionId) throw new Error('the other driver never got a session');
  return { ws, events, sessionId: init.sessionId };
}

/* -------------------------------------------------------------- scenario A */

async function scenarioA(cdp, leg, projectName, sessionId) {
  const violations = [];
  const seen = (where, a) => { const v = agreementViolation(where, a); if (v) violations.push(v); return a; };

  console.log(`\n--- A1. the user opens the still-running session by CLICKING it [${leg}] ---`);
  await expandProject(cdp, projectName);
  const sawRow = await cdp.waitFor('the live session row',
    `!!(${group(projectName)}?.querySelector('.row[data-live]'))`, 90_000);
  if (!sawRow) throw new Error('the tab never saw the running session in the sidebar');
  await cdp.eval(`${group(projectName)}.querySelector('.row[data-live]').click()`);
  const opened = await cdp.waitFor('the session on screen',
    `window.__station.state.current.sessionId === ${JSON.stringify(sessionId)}`, 60_000);
  if (!opened) throw new Error('the session never opened in the tab');
  await cdp.waitFor('the reopen path to settle', `window.__station.state.followingLive === true`, 30_000);
  await sleep(600);

  const openedChip = await cdp.eval(CHIP);
  seen('A/opened', await cdp.eval(AGREE));
  // The PRECONDITION both legs must share: with the flag freshly set by the
  // reopen path, both are honest here. Anything that differs later differs
  // because of the fix, not because the legs started somewhere different.
  check(`[${leg}] PRECONDITION: opening the running session reads as running in the background`,
    openedChip.state === 'detached', JSON.stringify(openedChip));

  console.log(`\n--- A2. the user does what the chip told them to: sends a message to take it over [${leg}] ---`);
  await cdp.eval(typeSend('Reply with exactly: TAKEOVER-ATTEMPT'));
  // The refusal has landed when the text is back in the dock as a dead row —
  // the one signal that is unambiguous in both legs (`live === false` is also
  // true BEFORE the send, so waiting on it would pass vacuously).
  const refused = await cdp.waitFor('the refusal to land',
    `[...document.querySelectorAll('#queueBox .qrow .qedit')].some(t => t.value.includes('TAKEOVER-ATTEMPT'))`, 90_000);
  if (!refused) throw new Error('the takeover was never refused — the other driver did not hold the session');
  await sleep(1500);

  const truth = await serverSaysBusy(sessionId);
  const chip = await cdp.eval(CHIP);
  const agree = seen('A/after-refusal', await cdp.eval(AGREE));
  const dock = await cdp.eval(DOCK);
  await shot(cdp, `A-${leg}-after-refused-takeover`);
  console.log(`        server ground truth: ${JSON.stringify(truth)}`);
  console.log(`        chip: ${JSON.stringify(chip)}`);

  return { chip, agree, dock, truth, violations };
}

/* -------------------------------------------------------------- scenario B */

async function scenarioB(cdp, leg, projectName, secs) {
  const fixed = leg === 'fixed';
  const violations = [];
  const seen = (where, a) => { const v = agreementViolation(where, a); if (v) violations.push(v); return a; };
  const QUEUED = 'Reply with exactly: QUEUED-AND-RELOADED';

  console.log(`\n--- B1. the user starts their own session and it goes to work [${leg}] ---`);
  // The real path: the sidebar's per-project "New session" +. It is also the
  // only one that binds the composer to THIS project without depending on
  // whatever the app happened to select at boot.
  await revealProject(cdp, projectName);
  await cdp.eval(`${group(projectName)}.querySelector('.proj .plus').click()`);
  await cdp.waitFor('the composer bound to that project',
    `!!window.__station.state.pendingNew && !!document.querySelector('#prompt')`, 30_000);
  // AFTER the +: startNew deliberately drops every session override, so
  // arming them before it would silently start an opus turn here.
  await cdp.eval(`(() => {
    const s = window.__station.state;
    s.overrides.model = 'haiku';
    s.overrides.permissionMode = 'bypassPermissions';
  })()`);
  await cdp.eval(typeSend(slowPrompt(secs, 'B-RUN-DONE')));
  const running = await cdp.waitFor('the turn running with a real id',
    `window.__station.state.busy === true && !!window.__station.state.current.sessionId`, 120_000);
  if (!running) throw new Error('the tab never got its own turn running');
  const sessionId = await cdp.eval(`window.__station.state.current.sessionId`);
  seen('B/own-turn-running', await cdp.eval(AGREE));

  console.log(`\n--- B2. mid-reply, the user types another message — it queues [${leg}] ---`);
  await cdp.eval(typeSend(QUEUED));
  const queued = await cdp.waitFor('the row in the dock',
    `[...document.querySelectorAll('#queueBox .qrow .qedit')].some(t => t.value.includes('QUEUED-AND-RELOADED'))`, 30_000);
  if (!queued) throw new Error('the message never queued');
  seen('B/queued', await cdp.eval(AGREE));

  console.log(`\n--- B3. the page reloads — transport gone, the work still running [${leg}] ---`);
  await cdp.eval(`window.__reloadMarker153 = 'same-document'`);
  await cdp.send('Page.reload', { ignoreCache: true });
  if (!await cdp.waitFor('reboot', `window.__station !== undefined`, 60_000)) throw new Error('the page never came back');
  if (await cdp.eval(`window.__reloadMarker153 ?? null`) !== null) {
    throw new Error('the "reload" did not reload the document — the check would be vacuous');
  }
  const restored = await cdp.waitFor('the restored row',
    `[...document.querySelectorAll('#queueBox .qrow .qedit')].some(t => t.value.includes('QUEUED-AND-RELOADED'))`, 60_000);
  if (!restored) throw new Error('the queued message did not survive the reload at all (BUG-129 regression)');
  await sleep(1200);

  const truth = await serverSaysBusy(sessionId);
  const chip = await cdp.eval(CHIP);
  const agree = seen('B/after-reload', await cdp.eval(AGREE));
  const dock = await cdp.eval(DOCK);
  await shot(cdp, `B-${leg}-after-reload`);
  console.log(`        server ground truth: ${JSON.stringify(truth)}`);
  console.log(`        dock: ${JSON.stringify(dock).slice(0, 400)}`);

  /* B4 — the way out, or the dead end. */
  const row = () => `[...document.querySelectorAll('#queueBox .qrow')].find(r => (r.querySelector('.qedit')?.value ?? '').includes('QUEUED-AND-RELOADED'))`;
  const backBtn = `[...${row()}.querySelectorAll('.cacts button')].find(b => /composer/i.test(b.textContent))`;
  const forceBtn = `[...${row()}.querySelectorAll('.cacts button')].find(b => /force/i.test(b.textContent))`;

  const hasBack = await cdp.eval(`!!(${row()} && ${backBtn})`);
  const hasForce = await cdp.eval(`!!(${row()} && ${forceBtn})`);
  let inBox = '';
  let forceSaid = '';
  if (hasBack) {
    await cdp.eval(`${backBtn}.click()`);
    await sleep(400);
    inBox = String(await cdp.eval(`document.querySelector('#prompt').value`) ?? '');
    await shot(cdp, `B-${leg}-reclaimed-into-composer`);
  } else if (hasForce) {
    // The pre-fix dead end, exercised rather than assumed: the one action the
    // row offers is pressed, and what it answers is recorded.
    await cdp.eval(`${forceBtn}.click()`);
    await sleep(800);
    // The strip truncates; the untruncated sentence lives on its title (say()).
    forceSaid = String(await cdp.eval(
      `(() => { const f = document.querySelector('#fine'); return (f?.title || f?.textContent) ?? ''; })()`) ?? '');
    inBox = String(await cdp.eval(`document.querySelector('#prompt').value`) ?? '');
    await shot(cdp, `B-${leg}-force-send-refused`);
  }

  /*
   * B5 — the round trip, fixed leg only: the reclaimed text is sent, which
   * takes the still-running session over. The chip must now be allowed to say
   * "Claude is working" — because now the guards would let the user act on it.
   * The property under test is an agreement, not a preference for one label.
   */
  let takeover = null;
  if (fixed && inBox.includes('QUEUED-AND-RELOADED')) {
    console.log(`\n--- B5. the reclaimed message is sent, and takes the run over [${leg}] ---`);
    await cdp.eval(`document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
    const drove = await cdp.waitFor('this tab driving the session',
      `(() => { const s = window.__station.state; return !!(s.live && s.ws && s.ws.readyState === 1); })()`, 90_000);
    await sleep(1200);
    takeover = { drove, agree: await cdp.eval(AGREE), chipDom: await cdp.eval(CHIP) };
    seen('B/after-takeover', await cdp.eval(AGREE));
    await shot(cdp, `B-${leg}-after-takeover`);
  }

  return { chip, agree, dock, truth, hasBack, hasForce, inBox, forceSaid, sessionId, takeover, violations };
}

/* ------------------------------------------------------------------- run */

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1400,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 120 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('the browser never opened a devtools port');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  const results = {};
  for (const leg of ['fixed', 'prefix']) {
    console.log(`\n##########  ${leg === 'fixed' ? 'FIXED (this working tree)' : 'PRE-FIX (each hunk mechanically reverted)'}  ##########`);
    if (leg === 'prefix') {
      const body = preFixClient();
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*app.js*', requestStage: 'Request' }] });
      cdp.on.set('Fetch.requestPaused', (p) => {
        void cdp.send('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'text/javascript' }, { name: 'cache-control', value: 'no-store' }],
          body: Buffer.from(body).toString('base64'),
        }).catch(() => { /* raced a nav */ });
      });
    }

    // A project per leg per scenario: every sidebar this script clicks in has
    // exactly one session in it, so no click can land on the other leg's run.
    const nameA = `bug153-A-${leg}`;
    const projA = await registerProject(nameA);
    console.log(`\n=== A. another driver is mid-turn; this tab opens the session and tries to take over [${leg}] ===`);
    const driver = await openRawDriver(projA, slowPrompt(150, 'A-RUN-DONE'));

    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await cdp.waitFor('boot', `window.__station !== undefined`, 60_000);
    await cdp.eval(`localStorage.clear()`);
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await cdp.waitFor('boot (clean)', `window.__station !== undefined`, 60_000);
    const a = await scenarioA(cdp, leg, nameA, driver.sessionId);
    try { driver.ws.close(); } catch { /* gone */ }

    const nameB = `bug153-B-${leg}`;
    await registerProject(nameB);
    console.log(`\n=== B. the user's own running session, a queued message, and a reload [${leg}] ===`);
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await cdp.waitFor('boot', `window.__station !== undefined`, 60_000);
    await cdp.eval(`localStorage.clear()`);
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await cdp.waitFor('boot (clean)', `window.__station !== undefined`, 60_000);
    const b = await scenarioB(cdp, leg, nameB, 150);

    results[leg] = { a, b };
    if (leg === 'prefix') { cdp.on.delete('Fetch.requestPaused'); await cdp.send('Fetch.disable'); }
  }

  const F = results.fixed, P = results.prefix;

  /* ------------------------------------------------- what the user sees now */
  console.log('\n=== 1. FIXED — a session running in the background never reads as idle or as ours ===');
  check('the session really was still mid-turn when the chip was read (server ground truth, not the client\'s belief)',
    F.a.truth.found && F.a.truth.busy, JSON.stringify(F.a.truth));
  check('after the refused takeover the chip still says the run is going, in the background',
    F.a.chip.state === 'detached' && /background/i.test(F.a.chip.label), JSON.stringify(F.a.chip));
  check('and it names the way out — send a message to take it over',
    /take it over/i.test(F.a.chip.title), F.a.chip.title.split('\n')[0]);
  check('the chip and the guards agree: not driving, and not claiming to be',
    F.a.agree.driving === false && F.a.agree.chip === 'detached', JSON.stringify(F.a.agree));

  console.log('\n=== 2. FIXED — the reloaded queue row is recoverable in ONE action ===');
  check('the session was still mid-turn across the reload (server ground truth)',
    F.b.truth.found && F.b.truth.busy, JSON.stringify(F.b.truth));
  const fRow = F.b.dock.rows.find((r) => r.text.includes('QUEUED-AND-RELOADED'));
  check('the message survived the reload as a live, undelivered row (not dead)',
    !!fRow && !fRow.dead, fRow ? JSON.stringify(fRow) : '(no row)');
  check('that row offers a way back into the composer',
    F.b.hasBack, fRow ? JSON.stringify(fRow.acts) : '(no row)');
  check('it does NOT offer a Force send that could only refuse',
    !F.b.hasForce, fRow ? JSON.stringify(fRow.acts) : '(no row)');
  check('one click puts the exact text back in the composer',
    F.b.inBox.includes('QUEUED-AND-RELOADED'), F.b.inBox.slice(0, 120));
  check('the dock does not promise a delivery this tab cannot make',
    !/delivering…/.test(F.b.dock.label) && /not driving the session/.test(F.b.dock.label), F.b.dock.label);

  console.log('\n=== 3. FIXED — and the agreement holds in the other direction too ===');
  const T = F.b.takeover;
  check('sending the reclaimed message takes the running session over',
    !!T && T.drove === true && T.agree.driving === true, JSON.stringify(T?.agree ?? '(never sent)'));
  check('only THEN does the chip say Claude is working — and force-send would now work',
    !!T && (T.agree.chip === 'thinking' || T.agree.chip === 'streaming'),
    JSON.stringify({ chip: T?.agree?.chip, label: T?.chipDom?.label }));

  console.log('\n=== 4. FIXED — the property, over every observation in both scenarios ===');
  const fv = [...F.a.violations, ...F.b.violations];
  check('at no point did the chip claim Claude is working in a tab holding no driving socket',
    fv.length === 0, fv.length ? fv.join(' | ') : 'no violations across all observation points');

  /* --------------------------------------------------------- the must-FAIL */
  console.log('\n=== 5. MUST-FAIL: the pre-fix client, same actions, same server ===');
  // (Both legs opened the session honestly — each leg asserts its own
  // PRECONDITION above, so what differs below differs because of the fix.)
  check('PRE-FIX: after the refused takeover the chip stops saying the run is going',
    P.a.chip.state !== 'detached',
    `${JSON.stringify(P.a.chip)} while the server said ${JSON.stringify(P.a.truth)}`);
  check('PRE-FIX: …and that is a lie — the server says the session is mid-turn',
    P.a.truth.found && P.a.truth.busy, JSON.stringify(P.a.truth));
  const pRow = P.b.dock.rows.find((r) => r.text.includes('QUEUED-AND-RELOADED'));
  check('PRE-FIX: the reloaded row offers NO way back into the composer',
    !P.b.hasBack, pRow ? JSON.stringify(pRow.acts) : '(no row)');
  check('PRE-FIX: its only action is a Force send, and pressing it refuses',
    P.b.hasForce && /no live session to force-send over/i.test(P.b.forceSaid),
    `${JSON.stringify(pRow?.acts ?? [])} → ${P.b.forceSaid.slice(0, 120)}`);
  check('PRE-FIX: the text is still not in the composer — delete and retype was the only way out',
    !P.b.inBox.includes('QUEUED-AND-RELOADED'), P.b.inBox.slice(0, 120) || '(composer empty)');

  cdp.close();
}

try {
  await main();
} catch (e) {
  fail++; failures.push(`harness: ${e.message}`);
  console.error('\n  HARNESS ERROR:', e.stack ?? e.message);
} finally {
  for (const ws of rawSockets) { try { ws.close(); } catch { /* gone */ } }
  stopByPid(browser);
  stopByPid(server);
  await sleep(1500);
  reapMyHosts(); // the hosts outlive the server on purpose — see the note there
  await sleep(500);
  for (const d of [SCRATCH, ...storeDirs]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* leave it */ }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed: ${failures.join(' | ')}`);
console.log(`screenshots: ${SHOTS}`);
process.exit(fail ? 1 : 0);
