/**
 * FEAT-079 — the Needs-You rail holds DECISIONS only; read-only recurrence /
 * consolidation findings move to a distinct, lower-priority OBSERVATIONS lane.
 *
 *   node scripts/verify-feat-079-observations-lane.mjs
 *
 * Everything is real and SCRATCH: a scratch project on disk with an opt-in
 * docs/bugs/ board and a PLANTED docs/bugs/.arch/findings.json; a scratch
 * METHODOLOGY_DIR with a PLANTED .station/needs-human.json; a scratch server on
 * an OS-assigned free port (never 4317); a real brave (headless, raw CDP). The
 * live server and the real methodology repo are never touched.
 *
 * The server boot WA-consolidation pass is DISABLED
 * (CLAUDE_STATION_NO_WA_CONSOLIDATE=1) so it cannot overwrite the planted
 * needs-human.json — this suite controls the fixture exactly.
 *
 * Proves the §C contract:
 *   (a) an open 👤 ticket → needsYou;
 *   (b) a BARE arch-recurrence cluster (no `ask`) → observations, NOT needsYou;
 *   (c) a BARE WA-consolidation FYI (no `ask`, methodology-home) → observations,
 *       NOT needsYou;
 *   (d) PROMOTION: an arch-recurrence finding that CARRIES a concrete `ask` →
 *       needsYou (the documented seam), as an answerable decision;
 *   (e) the FEAT-067 status summary counts split (needs vs observations) and
 *       match the merged lists;
 *   (f) rail UI: #railObservations renders read-only + dismissible; #railNeeds
 *       carries the ask ticket + the promoted finding, NO bare finding; dismiss
 *       of an observation removes only that row.
 *
 * Ports OS-assigned; processes killed by PID, never pkill.
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
const PORT = Number(process.env.VERIFY_F079_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f079-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f079-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f079-chrome-'));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f079-proj-'));
const METH = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f079-meth-'));
const BRAVE = process.env.VERIFY_F079_BROWSER ?? 'brave';
const ASSETS = path.join(ROOT, 'docs', 'bugs', 'assets');

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
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/* ---------------------------------------------------------------- fixture */
const ASK_ID = 'BUG-791';                          // (a) an open 👤 ticket — a real ask
const ARCH_BARE = 'arch-recurrence-bare79';        // (b) bare recurrence count — Observation
const ARCH_PROMOTED = 'arch-recurrence-promoted79'; // (d) carries a concrete ask — needsYou
const WA_BARE = 'contradiction-fyi79';             // (c) bare consolidation FYI — Observation
const NOW = new Date().toISOString();
const ARCH_ASK = 'A design flaw is implied — file ARCH-100 for this class, or keep patching?';

function seedProject() {
  const bugs = path.join(PROJ, 'docs', 'bugs');
  fs.mkdirSync(path.join(bugs, '.arch'), { recursive: true });
  fs.writeFileSync(path.join(bugs, 'INDEX.md'),
    `# Board\n\n## Open\n\n| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n` +
    `| ${ASK_ID} | pick a retry ceiling | 👤 | needs decision | med |\n\n` +
    `## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n`);
  fs.writeFileSync(path.join(bugs, `${ASK_ID}-retry-ceiling.md`),
    `# ${ASK_ID} — pick a retry ceiling\n\n- **Status:** OPEN\n\n## Question\nHow many retries before giving up?\n- three\n- five\n\n## Activity log (APPEND-ONLY)\n`);
  // Planted derived arch findings: one BARE (Observation), one PROMOTED (needsYou).
  fs.writeFileSync(path.join(bugs, '.arch', 'findings.json'), `${JSON.stringify({
    generatedAt: NOW, source: 'arch-watch',
    findings: [
      { id: ARCH_BARE, type: 'arch-recurrence', summary: 'recurring patches in "widget cache" — 4 tickets: BUG-901, BUG-902, BUG-903, BUG-904', date: NOW },
      { id: ARCH_PROMOTED, type: 'arch-recurrence', summary: 'recurring patches in "auth token" — 5 tickets: BUG-910..914', date: NOW, ask: ARCH_ASK },
    ],
  }, null, 2)}\n`);
}

function seedMethodology() {
  fs.mkdirSync(path.join(METH, '.station'), { recursive: true });
  fs.writeFileSync(path.join(METH, '.station', 'needs-human.json'), `${JSON.stringify({
    generatedAt: NOW,
    findings: [
      { id: WA_BARE, type: 'contradiction', summary: 'two rules disagree on squash policy — Rigor §A vs §B', date: NOW },
    ],
  }, null, 2)}\n`);
}

async function registerProject(hostPath, name) {
  const r = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath, name }),
  })).json();
  if (!r.project?.id) throw new Error(`could not register ${name}: ${JSON.stringify(r)}`);
  return r.project.id;
}
const boardOf = async (id) => (await (await fetch(`${BASE}/api/projects/${id}/board`)).json());
const has = (list, id) => (list ?? []).some((x) => x.id === id);

async function main() {
  seedProject();
  seedMethodology();

  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA,
      CLAUDE_PROJECTS_DIR: STORE, METHODOLOGY_DIR: METH,
      CLAUDE_STATION_NO_WA_CONSOLIDATE: '1', // do not overwrite the planted needs-human.json
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); }
  }
  if (!up) throw new Error('server never became healthy');

  // The methodology-home project MUST be the real ROOT (the server hardcodes
  // projectRoot() for consolidation scoping) — register it so (c) is exercised.
  const homeId = await registerProject(ROOT, 'Methodology Home');
  const projId = await registerProject(PROJ, 'Fixture Project');

  console.log('\n=== board route: needsYou holds asks only; findings split to observations ===');
  const bProj = await boardOf(projId);
  // (a) the open 👤 ticket is an ask → needsYou.
  check('(a) the open 👤 ticket lands in needsYou (a real ask)',
    has(bProj.needsYou, ASK_ID) && bProj.needsYou.find((x) => x.id === ASK_ID)?.question,
    JSON.stringify(bProj.needsYou?.map((x) => ({ id: x.id, kind: x.kind }))));
  // (b) the bare arch cluster is an Observation, NOT a needsYou ask.
  check('(b) the BARE arch-recurrence cluster lands in OBSERVATIONS, read-only (no question)',
    has(bProj.observations, ARCH_BARE) &&
      bProj.observations.find((x) => x.id === ARCH_BARE)?.question === undefined,
    JSON.stringify(bProj.observations?.map((x) => ({ id: x.id, q: x.question }))));
  check('(b) MUST-FAIL guard: the bare arch cluster is NOT in needsYou',
    !has(bProj.needsYou, ARCH_BARE),
    JSON.stringify(bProj.needsYou?.map((x) => x.id)));
  // (d) the promoted arch finding carries an ask → needsYou.
  check('(d) PROMOTION: the arch finding carrying a concrete ask lands in needsYou, WITH its question',
    has(bProj.needsYou, ARCH_PROMOTED) &&
      bProj.needsYou.find((x) => x.id === ARCH_PROMOTED)?.question === ARCH_ASK,
    JSON.stringify(bProj.needsYou?.map((x) => ({ id: x.id, q: x.question }))));
  check('(d) …and the promoted finding is NOT duplicated into observations',
    !has(bProj.observations, ARCH_PROMOTED),
    JSON.stringify(bProj.observations?.map((x) => x.id)));

  // (c) the methodology-home consolidation FYI → observations, not needsYou.
  const bHome = await boardOf(homeId);
  check('(c) the BARE WA-consolidation FYI lands in OBSERVATIONS on the methodology-home project',
    has(bHome.observations, WA_BARE) &&
      bHome.observations.find((x) => x.id === WA_BARE)?.question === undefined,
    JSON.stringify(bHome.observations?.filter((x) => x.id === WA_BARE)));
  check('(c) MUST-FAIL guard: the consolidation FYI is NOT in needsYou',
    !has(bHome.needsYou, WA_BARE),
    JSON.stringify(bHome.needsYou?.map((x) => x.id)));

  console.log('\n=== (e) FEAT-067 status summary: counts split asks vs observations ===');
  check('summary.counts.needs === needsYou.length and .observations === observations.length (derived, not guessed)',
    bProj.summary?.counts?.needs === bProj.needsYou.length &&
      bProj.summary?.counts?.observations === (bProj.observations ?? []).length,
    JSON.stringify({ counts: bProj.summary?.counts, needs: bProj.needsYou.length, obs: (bProj.observations ?? []).length }));
  check('the bare finding is counted as an OBSERVATION, never inflating the needs count',
    bProj.summary.counts.observations >= 1 && !has(bProj.needsYou, ARCH_BARE),
    JSON.stringify(bProj.summary.counts));

  console.log('\n=== (f) rail UI: observations read-only, needsYou asks, dismiss works ===');
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

  const clickProj = async (name) => cdp.eval(`(() => {
    const find = () => [...document.querySelectorAll('#tree button.proj')]
      .find((r) => (r.querySelector('.nm')?.textContent ?? '').includes(${JSON.stringify(name)}));
    let row = find();
    if (!row) {
      const inactiveToggle = document.querySelector('#tree .inactive-l');
      if (inactiveToggle) { inactiveToggle.click(); row = find(); }
    }
    if (!row) return false;
    row.click(); return true;
  })()`);

  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `document.querySelectorAll('#tree button.proj').length >= 2 || !!document.querySelector('#tree .inactive-l')`, 30_000);
  if (!await clickProj('Fixture Project')) throw new Error('could not select the fixture project');
  await cdp.waitFor('project selected', `window.__station?.state?.current?.projectId === ${JSON.stringify(projId)}`, 10_000);

  // The bare arch finding renders in the OBSERVATIONS lane; the ask ticket and
  // the promoted finding render on the decision rail.
  const ready = await cdp.waitFor('lanes painted',
    `document.querySelectorAll('#railObservations .needs-card[data-id="${ARCH_BARE}"]').length === 1 &&
     document.querySelectorAll('#railNeeds .needs-card[data-id="${ASK_ID}"]').length === 1 &&
     document.querySelectorAll('#railNeeds .needs-card[data-id="${ARCH_PROMOTED}"]').length === 1`, 20_000);
  check('(f) the bare finding is in #railObservations; the ask + promoted finding are in #railNeeds', ready, `ready=${ready}`);

  const obs = await cdp.eval(`(() => {
    const c = document.querySelector('#railObservations .needs-card[data-id="${ARCH_BARE}"]');
    return c && {
      kind: c.dataset.kind,
      label: c.querySelector('.nc-id')?.textContent ?? '',
      hasTextarea: !!c.querySelector('textarea, .nc-input'),
      dismiss: [...c.querySelectorAll('button')].map((b) => b.textContent).join(','),
    };
  })()`);
  check('(f) the observation row is READ-ONLY (no textarea) and offers exactly a Dismiss',
    obs && !obs.hasTextarea && obs.dismiss === 'Dismiss' && obs.kind === 'observation' && obs.label === 'Architecture review',
    JSON.stringify(obs));

  check('(f) NO bare finding leaked into the decision rail (#railNeeds)',
    (await cdp.eval(`document.querySelectorAll('#railNeeds .needs-card[data-id="${ARCH_BARE}"]').length`)) === 0,
    'railNeeds bare-finding cards');

  const promoted = await cdp.eval(`(() => {
    const c = document.querySelector('#railNeeds .needs-card[data-id="${ARCH_PROMOTED}"]');
    return c && { askShown: (c.querySelector('.nc-question')?.textContent ?? '').includes('file ARCH-100') };
  })()`);
  check('(f) the promoted finding shows its concrete ask on the decision rail',
    promoted && promoted.askShown, JSON.stringify(promoted));

  // The summary counts strip carries a distinct observations chip.
  const chips = await cdp.eval(`(() => {
    const out = {};
    for (const c of document.querySelectorAll('#railSummary .rs-chip')) {
      out[c.dataset.target] = Number(c.dataset.count);
    }
    return out;
  })()`);
  check('(f) the status strip has a distinct observations chip counting the read-only lane',
    chips.observations === (bProj.observations ?? []).length && chips.needs === bProj.needsYou.length,
    JSON.stringify(chips));

  await cdp.shot(path.join(ASSETS, 'FEAT-079-observations-lane.png'));

  // Dismiss the observation → only that row leaves.
  await cdp.eval(`(() => {
    const c = document.querySelector('#railObservations .needs-card[data-id="${ARCH_BARE}"]');
    [...c.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss').click();
  })()`);
  const gone = await cdp.waitFor('observation dismissed',
    `document.querySelectorAll('#railObservations .needs-card[data-id="${ARCH_BARE}"]').length === 0 &&
     document.querySelectorAll('#railNeeds .needs-card[data-id="${ASK_ID}"]').length === 1 &&
     document.querySelectorAll('#railNeeds .needs-card[data-id="${ARCH_PROMOTED}"]').length === 1`, 15_000);
  check('(f) dismissing the observation removes ONLY that row; the asks stay', gone, `gone=${gone}`);
  check('(f) the dismissal persisted server-side (bare finding gone from observations)',
    !has((await boardOf(projId)).observations, ARCH_BARE), 'post-dismiss observations');

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
    for (const d of [DATA, STORE, PROFILE, PROJ, METH]) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
