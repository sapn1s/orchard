#!/usr/bin/env node
/**
 * BUG-154 — the Docker socket consent text says the right thing, in the real UI.
 *
 *   node scripts/verify-bug-154-socket-consent-wording.mjs
 *
 * The defect: the armed confirmation said "This cannot be undone for work
 * already done inside the session", which a reader takes as a claim that the
 * MOUNT is permanent. It is not — the flag is a bind, so turning it off and
 * letting the container be recreated removes the socket exactly the way turning
 * it on added it. What is irreversible is what the session did while it had it.
 *
 * This drives the REAL app in a REAL headless browser over a realistic project
 * (isolation=container, two mounts, a live-looking container), clicks the REAL
 * toggle to arm the confirmation, and reads the text the user would read — in
 * BOTH themes. It asserts three things the wording must do:
 *
 *   (1) it never claims the ACCESS is irreversible, and says what turning it
 *       off does — including WHEN (the next container rebuild, because a
 *       running container keeps the bind it was created with);
 *   (2) it still says plainly what the grant is worth, and does so in language
 *       that is true of both daemon kinds ("any path the daemon can reach"),
 *       with the rootful case flagged as the usual one rather than asserted
 *       about a daemon the browser cannot inspect;
 *   (3) the neighbour that had the same confusion — the container block, whose
 *       rows read as a description of what is running — says when a changed
 *       setting is still only a request (server-computed `drifted`).
 *
 * Plus: the text is actually legible where it lands (rendered width/height,
 * inside the drawer, no clipping) and it stays short enough for a confirmation
 * row. Screenshots of both themes are written to the out-dir for a human read.
 *
 * MUST-FAIL pre-fix: on the old text (1) fails on the literal old sentence and
 * on the absence of any "turning it off" clause, and (3) fails because the
 * drift line did not exist.
 *
 * Scratch only: a throwaway server on an OS-assigned free port (never :4317),
 * a throwaway data dir + Claude store, a throwaway brave profile, and a
 * synthetic project under ~/scratch. Nothing touches a real project,
 * and the socket flag is only ever set on the synthetic one.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRATCH = process.env.BUG154_SCRATCH ?? path.join(os.homedir(), 'scratch', 'bug-154');
const OUTDIR = path.join(SCRATCH, 'shots');
const BRAVE = process.env.BUG154_BROWSER ?? 'brave';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}

function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/* --------------------------------------------------------------- raw CDP */
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
      await sleep(120);
    }
    console.log(`      (timed out waiting for ${label} after ${timeoutMs}ms)`);
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

/**
 * Stub ONLY the container-status route, so the block can be driven through the
 * states a real machine reaches (running-and-settled vs running-and-drifted)
 * without creating a container. Everything else — the drawer, the toggle, the
 * text — is the real app talking to the real server.
 */
const stubFetch = (statusJson) => `(() => {
  if (!window.__origFetch) window.__origFetch = window.fetch;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (/\\/container\\/status$/.test(url)) {
      return Promise.resolve(new Response(JSON.stringify(${JSON.stringify(statusJson)}),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return window.__origFetch(input, init);
  };
  return true;
})()`;

/** Open the settings drawer on the project and force a container re-read. */
const openSettings = (id) => `(async () => {
  const S = window.__station;
  S.state.current = { projectId: ${JSON.stringify(id)}, encodedDir: null, sessionId: null, title: null, os: null };
  await S.drawer.open('settings', null, { focus: 'mounts' });
  return true;
})()`;

/** Read every user-visible string in the socket block + container block. */
const READ = `(() => {
  const risk = [...document.querySelectorAll('.risk')].find((r) =>
    r.textContent.includes('Docker socket'));
  const grp = risk ? risk.closest('.grp') : null;
  const iso = [...document.querySelectorAll('.grp')].find((g) => g.dataset.focus === 'iso');
  const r = risk ? risk.getBoundingClientRect() : null;
  const drawerEl = document.querySelector('#smodal') || document.querySelector('.smodal-box'); // FEAT-146
  const dr = drawerEl ? drawerEl.getBoundingClientRect() : null;
  const txt = risk ? risk.querySelector('.state-row .txt') : null;
  return {
    found: !!risk,
    socketText: risk ? risk.textContent.replace(/\\s+/g, ' ').trim() : '',
    confirmRow: txt ? txt.textContent.replace(/\\s+/g, ' ').trim() : '',
    buttons: risk ? [...risk.querySelectorAll('button.mini')].map((b) => b.textContent.trim()) : [],
    accessText: grp ? grp.textContent.replace(/\\s+/g, ' ').trim() : '',
    isoText: iso ? iso.textContent.replace(/\\s+/g, ' ').trim() : '',
    rect: r ? { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) } : null,
    drawerRect: dr ? { left: Math.round(dr.left), right: Math.round(dr.right) } : null,
    inViewport: r ? (r.top >= -1 && r.bottom <= window.innerHeight + 1) : false,
    overflowsX: r && dr ? (r.right > dr.right + 1 || r.left < dr.left - 1) : false,
    theme: document.documentElement.dataset.theme || 'system',
  };
})()`;

async function main() {
  console.log('\n========== BUG-154 — docker socket consent wording, in the real UI ==========');

  /* ===== (0) the claim the text makes about THIS machine, checked ===== */
  console.log('\n=== (0) the daemon this text describes ===');
  const info = spawnSyncJson();
  check('the socket the flag binds exists and is the daemon socket', info.socketExists, info.socketDesc);
  check('this machine runs a ROOTFUL daemon, so the "root on this machine" clause is not overstated',
    info.rootful === true, { securityOptions: info.securityOptions, dockerRootDir: info.dockerRootDir });

  /* ===== boot a scratch server over a synthetic container project ===== */
  fs.mkdirSync(OUTDIR, { recursive: true });
  const DATA = fs.mkdtempSync(path.join(SCRATCH, 'data-'));
  const STORE = fs.mkdtempSync(path.join(SCRATCH, 'store-'));
  const PROFILE = fs.mkdtempSync(path.join(SCRATCH, 'brave-'));
  const PROJ = fs.mkdtempSync(path.join(SCRATCH, 'proj-'));
  fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true });
  fs.writeFileSync(path.join(PROJ, 'README.md'), '# lumen-cli (synthetic)\n');
  const cleanup = [DATA, STORE, PROFILE, PROJ];

  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) throw new Error('scratch server never became healthy');

  const created = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: PROJ, name: 'lumen-cli' }),
  })).json();
  const id = created.project?.id;
  if (!id) throw new Error(`could not register the synthetic project: ${JSON.stringify(created)}`);
  // A realistic busy container project: container isolation + two real mounts.
  await fetch(`${BASE}/api/projects/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      isolation: 'container',
      settings: {
        mounts: [
          { hostPath: PROJ, containerPath: '/workspace/lumen-cli', readOnly: false },
          { hostPath: path.join(PROJ, 'src'), containerPath: '/workspace/shared', readOnly: true },
        ],
      },
    }),
  });

  /* ===== drive the REAL UI ===== */
  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--force-color-profile=srgb',
    '--window-size=1440,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 100 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(200); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  if (!await cdp.waitFor('app booted', 'window.__station !== undefined', 60_000)) throw new Error('app.js never booted');
  await sleep(700);

  const settled = { state: 'running', containerName: 'orchard-lumen-cli', image: 'orchard/lumen-cli:latest', startedAt: new Date(Date.now() - 41 * 60_000).toISOString() };
  const drifted = { ...settled, drifted: true, driftReasons: ['missing bind /var/run/docker.sock'] };

  const shot = async (name) => {
    const cap = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUTDIR, `${name}.png`);
    fs.writeFileSync(p, Buffer.from(cap.data, 'base64'));
    return p;
  };
  const setTheme = async (t) => {
    await cdp.eval(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(t)}; return true; })()`);
    await sleep(200);
  };
  const scrollToSocket = () => cdp.eval(`(() => {
    const r = [...document.querySelectorAll('.risk')].find((x) => x.textContent.includes('Docker socket'));
    if (r) r.scrollIntoView({ block: 'center' });
    return !!r;
  })()`);
  const clickToggle = () => cdp.eval(`(() => {
    const r = [...document.querySelectorAll('.risk')].find((x) => x.textContent.includes('Docker socket'));
    const sw = r && r.querySelector('button.sw');
    if (!sw) return false;
    sw.click();
    return true;
  })()`);

  await cdp.eval(stubFetch(settled));
  await cdp.eval(openSettings(id));
  await cdp.waitFor('socket block rendered',
    `[...document.querySelectorAll('.risk')].some((r) => r.textContent.includes('Docker socket'))`, 15_000);
  await scrollToSocket();
  await sleep(250);
  const off = await cdp.eval(READ);
  const offShot = await shot('socket-off-dark');

  // Arm the confirmation the way the user does: click the toggle.
  check('clicking the toggle arms a confirmation instead of turning it on', await clickToggle(), 'clicked .sw');
  await sleep(250);
  await scrollToSocket();
  await sleep(200);
  const armedDark = await cdp.eval(READ);
  const armedDarkShot = await shot('socket-armed-dark');
  await setTheme('light');
  await scrollToSocket();
  await sleep(250);
  const armedLight = await cdp.eval(READ);
  const armedLightShot = await shot('socket-armed-light');
  await setTheme('dark');

  /* ===== (1) the reversibility claim is precise ===== */
  console.log('\n=== (1) the armed confirmation separates the grant from the consequence ===');
  const armed = armedDark.socketText;
  check('the armed confirmation actually rendered (Cancel + commit buttons present)',
    armedDark.buttons.length === 2 && /cancel/i.test(armedDark.buttons[0]) && /turn it on/i.test(armedDark.buttons[1]),
    armedDark.buttons);
  check('the old sentence that read as "the mount is permanent" is GONE',
    !/cannot be undone for work already done/i.test(armed),
    armed.match(/cannot be undone[^.]*\./i)?.[0] ?? 'not present');
  check('nothing in the block claims the ACCESS itself is irreversible or permanent',
    !/(access|this|it) (is|will be) (permanent|irreversible)/i.test(armed) && !/permanently/i.test(armed),
    armed.match(/permanen\w+|irreversibl\w+/gi) ?? 'no permanence claim about the switch');
  check('it says turning it back OFF removes the socket',
    /turning it back off removes the socket/i.test(armed),
    armed.match(/Turning it back off[^.]*\./i)?.[0] ?? 'MISSING');
  check('it says WHEN that takes effect — the next container rebuild, not instantly',
    /(at|on) the next container rebuild/i.test(armed),
    armed.match(/(at|on) the next container rebuild/i)?.[0] ?? 'MISSING');
  check('it says what removing it does NOT undo, naming the two residues',
    /it does not undo what was done with it/i.test(armed) && /files written anywhere on the host/i.test(armed) && /containers left running/i.test(armed),
    armed.match(/it does not undo[^.]*\./i)?.[0] ?? 'MISSING');
  check('the confirmation row states the distinction in one line, next to the buttons',
    /reversible/i.test(armedDark.confirmRow) && /not\.?$/i.test(armedDark.confirmRow.trim()),
    armedDark.confirmRow);

  /* ===== (2) the grant is still stated, and stated truthfully ===== */
  console.log('\n=== (2) what it grants — true of either daemon kind ===');
  check('it says what the session gets: the daemon socket, and containers of its own',
    /hands the session the daemon socket/i.test(armed) && /containers of its own/i.test(armed),
    armed.slice(0, 160));
  check('the reach is scoped to what the daemon can reach (exact on a rootless daemon too)',
    /any path the daemon can reach/i.test(armed),
    armed.match(/any path[^,]*/i)?.[0] ?? 'MISSING');
  check('the rootful case is flagged as the usual one, not asserted about an uninspectable daemon',
    /on a rootful daemon — the usual kind — that is root on this machine/i.test(armed),
    armed.match(/on a rootful daemon[^.]*\./i)?.[0] ?? 'MISSING');
  check('it still says the isolation set above stops applying',
    /every limit set above stops applying/i.test(armed), 'limits clause present');
  check('the exact socket path is shown so the claim is checkable',
    armed.includes('/var/run/docker.sock'), '/var/run/docker.sock');

  /* ===== (3) the neighbour: rows are a request until the rebuild ===== */
  console.log('\n=== (3) the neighbour — a changed setting is a request until the rebuild ===');
  check('a settled running container says nothing about drift (no false alarm)',
    !/Changed since this container started/i.test(off.isoText),
    off.isoText.slice(0, 120));
  await cdp.eval(stubFetch(drifted));
  await cdp.eval(`(() => { window.__station.drawer.repaint(); return true; })()`);
  await cdp.eval(openSettings(id));
  await cdp.waitFor('container block re-read', `document.querySelector('.grp[data-focus="iso"]') !== null`, 10_000);
  await sleep(600);
  await scrollToSocket();
  const drift = await cdp.eval(READ);
  const driftShot = await shot('container-drifted-dark');
  check('a DRIFTED running container says the live container still has the old mounts/socket/limits',
    /Changed since this container started/i.test(drift.isoText)
      && /mounts, socket flag and limits it was created with/i.test(drift.isoText)
      && /until you rebuild/i.test(drift.isoText),
    drift.isoText.match(/Changed since this container started[^.]*\.[^.]*\./i)?.[0] ?? 'MISSING');

  /* ===== (4) the user can actually read it ===== */
  console.log('\n=== (4) legible where it lands, in both themes ===');
  for (const [label, r] of [['dark', armedDark], ['light', armedLight]]) {
    check(`[${label}] the socket block is rendered with real size`,
      !!r.rect && r.rect.w > 200 && r.rect.h > 40, r.rect);
    check(`[${label}] it does not overflow the drawer horizontally`, r.overflowsX === false,
      { block: r.rect, drawer: r.drawerRect });
    check(`[${label}] the armed text is the same in both themes (no theme-only copy)`,
      r.socketText === armedDark.socketText, `${r.socketText.length} chars`);
  }
  const words = armed.split(/\s+/).length;
  check('the whole block stays short enough for a confirmation, not documentation (<= 100 words)',
    words <= 100, `${words} words`);
  check('the confirmation row itself stays one short line (<= 12 words)',
    armedDark.confirmRow.split(/\s+/).length <= 12, `${armedDark.confirmRow.split(/\s+/).length} words`);

  /* ===== (5) the ON state carries the same precision ===== */
  console.log('\n=== (5) the ON state says it too (the state where a user goes to turn it off) ===');
  // Turned on the way the user turns it on — arm, then click the commit button
  // — on the SYNTHETIC project only. That is the real path into the ON state
  // (putContainer -> PATCH -> refreshProject -> repaint), not a state poke.
  await cdp.eval(stubFetch(settled));
  await setTheme('dark');
  await clickToggle();
  await sleep(250);
  check('the commit button is the one that turns it on (second, deliberate click)',
    await cdp.eval(`(() => {
      const r = [...document.querySelectorAll('.risk')].find((x) => x.textContent.includes('Docker socket'));
      const go = r && [...r.querySelectorAll('button.mini')].find((b) => /turn it on/i.test(b.textContent));
      if (!go) return false;
      go.click();
      return true;
    })()`), 'clicked "Turn it on anyway"');
  await cdp.waitFor('the flag is on in the drawer',
    `[...document.querySelectorAll('.risk')].some((r) => /Docker socket\\s*On\\./.test(r.textContent))`, 10_000);
  await scrollToSocket();
  await sleep(250);
  const on = await cdp.eval(READ);
  const onShot = await shot('socket-on-dark');
  await setTheme('light');
  await scrollToSocket();
  await sleep(250);
  const onLight = await cdp.eval(READ);
  const onLightShot = await shot('socket-on-light');
  check('the ON state is what rendered (not the off/armed copy)',
    /^On\./.test(on.socketText.replace(/^Docker socket\s*/, '')), on.socketText.slice(0, 80));
  check('[ON] it says turning it off takes the socket away at the next rebuild',
    /turning it off takes the socket away at the next container rebuild/i.test(on.socketText),
    on.socketText.match(/Turning it off[^.;]*/i)?.[0] ?? 'MISSING');
  check('[ON] it says that undoes nothing already done through it',
    /undoes nothing already done through it/i.test(on.socketText),
    on.socketText.match(/undoes nothing[^.]*/i)?.[0] ?? 'MISSING');
  check('[ON] light theme renders the identical sentence', onLight.socketText === on.socketText,
    `${onLight.socketText.length} chars`);
  check('[ON] the block is legible and unclipped in light theme',
    onLight.rect.w > 200 && onLight.overflowsX === false, onLight.rect);

  console.log(`\nScreenshots for a human read:\n  ${[offShot, armedDarkShot, armedLightShot, driftShot, onShot, onLightShot].join('\n  ')}`);
  console.log('\n--- the text a user reads (armed) ---\n' + armed + '\n');
  console.log('--- the text a user reads (on) ---\n' + on.socketText + '\n');

  cdp.close();
  for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}

/** `docker info` for the two facts the wording depends on. */
function spawnSyncJson() {
  const sock = '/var/run/docker.sock';
  let socketExists = false, socketDesc = 'absent';
  try {
    const st = fs.statSync(sock);
    socketExists = st.isSocket();
    socketDesc = `${sock} mode=${(st.mode & 0o777).toString(8)} gid=${st.gid}`;
  } catch { /* absent */ }
  const r = spawnSync('docker', ['info', '--format', '{{json .}}'], { encoding: 'utf8', timeout: 20_000 });
  let securityOptions = [], dockerRootDir = '';
  try {
    const j = JSON.parse(r.stdout);
    securityOptions = j.SecurityOptions ?? [];
    dockerRootDir = j.DockerRootDir ?? '';
  } catch { /* daemon down */ }
  const rootless = securityOptions.some((s) => String(s).includes('rootless'));
  return { socketExists, socketDesc, securityOptions, dockerRootDir, rootful: !rootless && dockerRootDir.startsWith('/var/lib/docker') };
}

main().then(() => {
  console.log(`\n========== ${pass} PASS / ${fail} FAIL ==========`);
  if (fail) { console.log('FAILED:\n  - ' + failures.join('\n  - ')); process.exitCode = 1; }
}).catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => process.exit(process.exitCode ?? 0), 2000);
});
