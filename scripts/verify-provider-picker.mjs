/**
 * FEAT-037 P3 — provider picker + CodexRuntime wired into the REAL
 * session-start path. Non-vacuous (§C): every layer is the real code.
 *
 *  A. API — /api/providers returns detectCodex() (+ anthropic always-on);
 *     `provider` persists per-project through the REAL registry PATCH; an
 *     unknown provider is rejected loudly.
 *  B. UI — the drawer's Provider group renders the live detection verdict,
 *     selecting OpenAI writes settings.provider, and the choice SURVIVES a
 *     full page reload (FEAT-025-style persistence proof, brave headless CDP).
 *  C. WIRING — with provider='openai' the REAL startSession path constructs
 *     CodexRuntime: the server is pointed at the scripted fake app-server
 *     (scripts/fixtures/codex-fake-app-server.mjs) via the runtime's
 *     CLAUDE_STATION_CODEX_BIN spawn seam, and a full turn is driven through
 *     bridge + websocket + UI — message in, streamed reply rendered, busy
 *     resolves. Only CodexRuntime speaks the app-server JSON-RPC protocol the
 *     fake VALIDATES (protocol violation → fake exits 1 → transport error →
 *     the turn never completes), so a passing turn IS the construction proof.
 *     Capabilities-driven degradation asserted on the same session: no cost
 *     figure on the turn-end line, plan toggle hidden, structuredCost=false
 *     reported, crown chip marked `codex ·`.
 *  D. NOT CONNECTED — a server whose HOME/PATH cannot see any codex install
 *     reports the honest 'not-installed' verdict, and a launch attempt with
 *     provider='openai' fails FAST with the detection hint (no hang).
 *  E. REAL BINARY (this machine has codex + ChatGPT auth as of 2026-08-05) —
 *     detection reports 'connected' through the real route even though
 *     ~/.local/bin is typically off a service PATH; `codex --version` runs.
 *     (One tiny real end-to-end turn is attempted REPORT-ONLY — the adapter's
 *     wire shapes are documentation-derived until P2c re-validates them.)
 *
 * Pre-change (HEAD, P2a only): A fails (route 404, provider field rejected),
 * B fails (no .prov-seg), C cannot even arm (provider unsettable →
 * ClaudeRuntime always constructed). Run against a HEAD worktree via
 * PICKER_SERVER_ROOT to reproduce.
 *
 * Never touches :4317; scratch ports; kills by pid; installs nothing.
 */
import { spawn, execFileSync } from 'node:child_process';
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

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_ROOT = process.env.PICKER_SERVER_ROOT ? path.resolve(process.env.PICKER_SERVER_ROOT) : ROOT;
const FAKE = path.join(SERVER_ROOT, 'scripts', 'fixtures', 'codex-fake-app-server.mjs');
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const SHOT = path.join(ROOT, 'docs', 'bugs', 'assets');
const SKIP_LIVE = process.argv.includes('--no-live');

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
function info(name, observed) {
  console.log(`  INFO  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
const cleanupDirs = [];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pp-data-'));
  cleanupDirs.push(data);
  const child = spawn(process.execPath, [path.join(SERVER_ROOT, 'src', 'server', 'index.ts')], {
    cwd: SERVER_ROOT,
    env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: data, ...extraEnv },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => process.stderr.write(`  [server:${port}!] ${d}`));
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${base}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error(`server on ${port} never became healthy`);
  return { child, base, port };
}

async function registerProject(base, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cs-pp-${name}-`));
  cleanupDirs.push(dir);
  cleanupDirs.push(path.join(os.homedir(), '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-')));
  const r = await (await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: dir, name }),
  })).json();
  if (!r.project?.id) throw new Error(`register failed: ${JSON.stringify(r)}`);
  return r.project;
}

async function patchProject(base, id, patch) {
  const res = await fetch(`${base}/api/projects/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/* -------------------------------------------------------- CDP plumbing */
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
  async waitFor(label, expr, timeoutMs = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* nav */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  async shot(file) {
    try {
      const r = await this.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOT, file), Buffer.from(r.data, 'base64'));
      console.log(`        (screenshot ${file})`);
    } catch { /* best effort */ }
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let browser = null;
async function startBrowser() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pp-chrome-'));
  cleanupDirs.push(profile);
  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(browser);
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  return cdp;
}

/* ================================ main ================================ */

async function main() {
  /* ---------------- A. API: route + persistence + validation ---------------- */
  console.log('\n=== A. /api/providers + settings.provider through the real registry ===');
  const srvA = await startServer();
  const provRes = await fetch(`${srvA.base}/api/providers`);
  const prov = provRes.status === 200 ? await provRes.json() : null;
  check('GET /api/providers exists: anthropic always-connected + a detectCodex verdict for openai',
    provRes.status === 200 && prov?.providers?.anthropic?.status === 'connected'
      && ['connected', 'installed-not-signed-in', 'not-installed'].includes(prov?.providers?.openai?.status),
    { status: provRes.status, openai: prov?.providers?.openai });

  const projA = await registerProject(srvA.base, 'picker');
  const p1 = await patchProject(srvA.base, projA.id, { provider: 'openai' });
  const after = await (await fetch(`${srvA.base}/api/projects/${projA.id}`)).json();
  check('PATCH {provider:"openai"} persists on the project',
    p1.status === 200 && after?.project?.settings?.provider === 'openai',
    { patch: p1.status, stored: after?.project?.settings?.provider });

  const bad = await patchProject(srvA.base, projA.id, { provider: 'gemini' });
  check('unknown provider is rejected loudly (400, named error)',
    bad.status === 400 && /provider must be one of/.test(String(bad.body?.error)), bad);

  const defaultProj = await registerProject(srvA.base, 'default-prov');
  const defRead = await (await fetch(`${srvA.base}/api/projects/${defaultProj.id}`)).json();
  check('a fresh project defaults to anthropic (zero behaviour change for existing projects)',
    (defRead?.project?.settings?.provider ?? 'anthropic') === 'anthropic',
    defRead?.project?.settings?.provider ?? '(absent = anthropic)');

  /* ---------------- B. UI: picker renders detection + survives reload ---------------- */
  console.log('\n=== B. drawer picker: live detection state + persistence across reload ===');
  const cdp = await startBrowser();
  await cdp.send('Page.navigate', { url: `${srvA.base}/#/project/${projA.id}` });
  await cdp.waitFor('boot', `window.__station !== undefined`);
  await cdp.eval(`document.querySelector('#cogBtn')?.click()`);
  const segReady = await cdp.waitFor('provider seg', `document.querySelector('.prov-seg') !== null`, 15_000);
  // The detection line lands on the repaint AFTER the async /api/providers
  // fetch — wait for it rather than sampling the "Checking…" frame.
  await cdp.waitFor('detection state', `document.querySelector('.prov-state') !== null`, 15_000);
  const segB = await cdp.eval(`(() => {
    const seg = document.querySelector('.prov-seg');
    if (!seg) return null;
    const pressed = seg.querySelector('button[aria-pressed="true"]')?.dataset.prov;
    const stateLine = document.querySelector('.prov-state');
    return { pressed, status: stateLine?.dataset.status, label: stateLine?.textContent };
  })()`);
  check('the picker renders, shows the STORED provider (openai) pressed, and the LIVE detectCodex verdict',
    segReady && segB?.pressed === 'openai'
      && segB?.status === prov?.providers?.openai?.status
      && /OpenAI Codex/.test(String(segB?.label)), segB);
  await cdp.eval(`document.querySelector('.prov-seg')?.scrollIntoView({ block: 'center' })`);
  await sleep(250);
  await cdp.shot('FEAT-037-picker.png');

  await cdp.eval(`document.querySelector('.prov-seg button[data-prov="anthropic"]')?.click()`);
  await cdp.waitFor('patch applied', `document.querySelector('.prov-seg button[aria-pressed="true"]')?.dataset.prov === 'anthropic'`, 15_000);
  await cdp.eval(`location.reload()`).catch(() => {});
  await cdp.waitFor('reboot', `window.__station !== undefined`, 30_000);
  await cdp.eval(`document.querySelector('#cogBtn')?.click()`);
  await cdp.waitFor('provider seg again', `document.querySelector('.prov-seg') !== null`, 15_000);
  const segB2 = await cdp.eval(`document.querySelector('.prov-seg button[aria-pressed="true"]')?.dataset.prov`);
  const storedB2 = await (await fetch(`${srvA.base}/api/projects/${projA.id}`)).json();
  check('clicking Claude wrote settings.provider AND the choice survives a full page reload',
    segB2 === 'anthropic' && storedB2?.project?.settings?.provider === 'anthropic',
    { ui: segB2, stored: storedB2?.project?.settings?.provider });

  /* ---------------- C. WIRING: real startSession path → CodexRuntime (fake app-server) ---------------- */
  console.log('\n=== C. provider=openai → the REAL startSession constructs CodexRuntime (fake app-server seam) ===');
  const srvB = await startServer({ CLAUDE_STATION_CODEX_BIN: FAKE });
  const projB = await registerProject(srvB.base, 'codex-fake');
  await patchProject(srvB.base, projB.id, { provider: 'openai' });

  await cdp.send('Page.navigate', { url: `${srvB.base}/#/project/${projB.id}` });
  await cdp.waitFor('boot B', `window.__station !== undefined && window.__station.state.current.projectId === ${JSON.stringify(projB.id)}`);
  await cdp.eval(`(() => {
    document.querySelector('#prompt').value = 'hello through the real path';
    document.querySelector('#go').click();
  })()`);
  const gotReply = await cdp.waitFor('fake codex reply streams through bridge+UI',
    `[...document.querySelectorAll('#panes .claude .body')].some((n) => n.textContent.includes('Hello from fixture Codex.'))`, 30_000);
  const idleC = await cdp.waitFor('busy resolves', `window.__station.state.busy === false`, 15_000);
  const obsC = await cdp.eval(`({
    sdkSessionId: window.__station.state.sdkSessionId,
    caps: window.__station.state.effective?.capabilities ?? null,
    provider: window.__station.state.effective?.provider ?? null,
    chipProvider: document.querySelector('#modelChip')?.dataset.provider,
    chipText: document.querySelector('#modelChipName')?.textContent,
    planHidden: document.querySelector('#planBtn')?.hidden,
    turnEndLine: [...document.querySelectorAll('.ran-lbl, .turn-end, #fine')].map((n) => n.textContent).join(' | '),
    sessState: window.__station.computeSessState(),
  })`);
  check('a REAL turn ran end-to-end: message in → CodexRuntime → fake app-server → streamed reply rendered, busy resolved',
    gotReply && idleC && obsC.sdkSessionId === 'thr_fixture_0001', obsC);
  // subagents flipped TRUE 2026-08-06 (FEAT-037 subagent capability re-check:
  // codex multi_agent is stable + default-on and mapped into the task dialect).
  check('effective-config reports provider openai with HONEST capabilities (structuredCost/planMode/mcpConfig false, subagents true)',
    obsC.provider === 'openai' && obsC.caps
      && obsC.caps.structuredCost === false && obsC.caps.subagents === true
      && obsC.caps.planMode === false && obsC.caps.mcpConfig === false, obsC.caps);
  const costFigures = await cdp.eval(`[...document.querySelectorAll('#panes .ran-lbl, #fine')].map((n) => n.textContent).filter((t) => /\\$\\d/.test(t))`);
  check('capabilities-driven degradation: NO dollar cost figure anywhere for the codex session (tokens-only engine)',
    Array.isArray(costFigures) && costFigures.length === 0, costFigures);
  check('plan toggle is HIDDEN for an engine without plan mode (driven by capabilities, not provider name)',
    obsC.planHidden === true, { planHidden: obsC.planHidden });
  check('the crown chip names the engine: codex-marked model chip',
    obsC.chipProvider === 'openai' && /^codex · /.test(String(obsC.chipText)), { chipProvider: obsC.chipProvider, chipText: obsC.chipText });
  await cdp.shot('FEAT-037-codex-session.png');

  /* ---------------- D. not connected: honest hint, fast failure, no hang ---------------- */
  console.log('\n=== D. provider=openai while codex is NOT usable → honest detection hint, no hang ===');
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pp-nohome-'));
  cleanupDirs.push(emptyHome);
  const srvC = await startServer({ HOME: emptyHome, PATH: '/definitely-not-a-bin-dir' });
  const provC = await (await fetch(`${srvC.base}/api/providers`)).json();
  check('a machine with no visible codex reports not-installed with an actionable hint (docs/PROVIDERS.md)',
    provC?.providers?.openai?.status === 'not-installed' && /PROVIDERS\.md/.test(String(provC?.providers?.openai?.hint)),
    provC?.providers?.openai);

  const projC = await registerProject(srvC.base, 'codex-absent');
  await patchProject(srvC.base, projC.id, { provider: 'openai' });
  const wsC = new WebSocket(`${srvC.base.replace('http', 'ws')}/ws`);
  const events = [];
  wsC.on('message', (d) => { try { events.push(JSON.parse(String(d))); } catch { /* noise */ } });
  await new Promise((res, rej) => { wsC.once('open', res); wsC.once('error', rej); });
  wsC.send(JSON.stringify({ type: 'start', projectId: projC.id, prompt: 'this must not hang' }));
  const t0 = Date.now();
  let fatal = null;
  while (Date.now() - t0 < 15_000 && !fatal) {
    fatal = events.find((e) => e.t === 'error' && e.fatal === true) ?? null;
    if (!fatal) await sleep(100);
  }
  const acked = events.find((e) => e.t === 'ack' && e.of === 'start');
  check('the launch fails FAST with the detection verdict + hint (fatal error, no start ack, well under any hang threshold)',
    !!fatal && /Codex session/i.test(String(fatal?.message)) && /not installed/i.test(String(fatal?.message))
      && /PROVIDERS\.md/.test(String(fatal?.message)) && !acked && (Date.now() - t0) < 15_000,
    { fatal: fatal?.message, ms: Date.now() - t0, acked: !!acked });
  wsC.close();

  // Drawer renders the not-connected warning for the selected-but-unusable engine.
  await cdp.send('Page.navigate', { url: `${srvC.base}/#/project/${projC.id}` });
  await cdp.waitFor('boot C', `window.__station !== undefined`);
  await cdp.eval(`document.querySelector('#cogBtn')?.click()`);
  await cdp.waitFor('provider seg C', `document.querySelector('.prov-seg') !== null`, 15_000);
  await cdp.waitFor('detection state C', `document.querySelector('.prov-state') !== null`, 15_000);
  const warnC = await cdp.eval(`(() => {
    const status = document.querySelector('.prov-state')?.dataset.status;
    const warn = [...document.querySelectorAll('.grp-note')].find((n) => n.dataset.warn === 'true')?.textContent ?? null;
    const hint = [...document.querySelectorAll('.grp-note')].map((n) => n.textContent).join(' | ');
    return { status, warn, hasHint: /PROVIDERS\\.md|codex/i.test(hint) };
  })()`);
  check('the drawer marks the selected-but-unusable engine honestly (not-installed state + warning note + hint)',
    warnC?.status === 'not-installed' && !!warnC?.warn && warnC?.hasHint === true, warnC);
  await cdp.eval(`document.querySelector('.prov-seg')?.scrollIntoView({ block: 'center' })`);
  await sleep(250);
  await cdp.shot('FEAT-037-not-connected.png');

  /* ---------------- E. real binary on this machine (2026-08-05: installed + ChatGPT auth) ---------------- */
  console.log('\n=== E. real binary: detection through the real route + version smoke ===');
  const realDet = prov?.providers?.openai;
  check('the REAL machine detection: codex found via well-known dirs even off the service PATH (status connected)',
    realDet?.status === 'connected' && /\/codex$/.test(String(realDet?.binaryPath)), realDet);
  try {
    const v = execFileSync(realDet.binaryPath, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
    check('`codex --version` runs from the detected path', /codex/i.test(v) || /\d+\.\d+/.test(v), v);
  } catch (err) {
    check('`codex --version` runs from the detected path', false, String(err?.message ?? err));
  }

  if (!SKIP_LIVE && realDet?.status === 'connected') {
    // REPORT-ONLY: one tiny real turn through the REAL app-server. The
    // adapter's wire shapes are documentation-derived (P2a provenance); a
    // drift here is P2c's job to fix, so this reports rather than fails.
    console.log('\n--- E2 (report-only): one tiny REAL codex app-server turn through bridge+UI ---');
    try {
      const srvD = await startServer(); // no env override: real detected binary
      const projD = await registerProject(srvD.base, 'codex-real');
      await patchProject(srvD.base, projD.id, { provider: 'openai' });
      await cdp.send('Page.navigate', { url: `${srvD.base}/#/project/${projD.id}` });
      await cdp.waitFor('boot D', `window.__station !== undefined && window.__station.state.current.projectId === ${JSON.stringify(projD.id)}`);
      await cdp.eval(`(() => {
        document.querySelector('#prompt').value = 'Reply with exactly OK and nothing else.';
        document.querySelector('#go').click();
      })()`);
      const liveOk = await cdp.waitFor('real codex reply', `window.__station.state.busy === false && window.__station.state.sdkSessionId !== null`, 120_000);
      const obsD = await cdp.eval(`({
        sid: window.__station.state.sdkSessionId,
        text: [...document.querySelectorAll('#panes .claude .body')].map((n) => n.textContent).join(' ').slice(0, 300),
        sessState: window.__station.computeSessState(),
      })`);
      if (liveOk && obsD.sid && /OK/.test(String(obsD.text))) {
        check('REAL codex turn end-to-end (subscription-billed, one tiny turn) — the doc-derived protocol held', true, obsD);
        await cdp.shot('FEAT-037-codex-real-turn.png');
      } else {
        info('real codex turn did NOT complete — expected until P2c re-validates the doc-derived wire shapes against the real app-server schema', obsD);
        await cdp.shot('FEAT-037-codex-real-attempt.png');
      }
    } catch (err) {
      info('real codex turn attempt errored (report-only; P2c re-validation pending)', String(err?.message ?? err));
    }
  }

  cdp.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  for (const c of children) stopByPid(c);
  setTimeout(() => {
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 1);
  }, 2500);
});
