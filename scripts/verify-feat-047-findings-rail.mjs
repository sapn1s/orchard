/**
 * FEAT-047 — WA consolidation needs-human findings surface in the Needs-You rail.
 *
 *   node scripts/verify-feat-047-findings-rail.mjs
 *
 * Everything is real and everything is SCRATCH: a scratch git-init'ed
 * METHODOLOGY_DIR with a PLANTED contradiction + a BACKDATED ROUTING.md, a
 * scratch server on an OS-assigned free port (never 4317), a real brave
 * (headless, raw CDP). The REAL methodology repo and the live server are never
 * touched; the real claude-station repo is only READ (its path is registered as
 * a project so the methodology-home scoping is exercised for real).
 *
 * Proves, end to end:
 *   1. the BOOT consolidation pass writes .station/needs-human.json into the
 *      scratch METHODOLOGY_DIR (persist half, fed by the shared code path);
 *   2. the board route surfaces the findings as kind:'finding' rows ONLY for
 *      the methodology-home project (scoping — another project gets none), in the
 *      read-only OBSERVATIONS lane (FEAT-079: board.observations, NOT needsYou);
 *   3. the rail renders them as READ-ONLY observation rows (no textarea, labeled
 *      "WA consolidation: …") with a Dismiss affordance, under #railObservations;
 *   4. Dismiss removes the row, the ack persists across a full page reload AND
 *      across a re-run pass that re-detects the same finding (carried-forward
 *      date ⇒ the ack still matches);
 *   5. a CLEAN pass empties the JSON and the rows leave the rail;
 *   6. an answerable `## Question` card in another project is unregressed.
 *
 * Ports OS-assigned; processes killed by PID, never pkill.
 */
import { spawn, spawnSync } from 'node:child_process';
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
const PORT = Number(process.env.VERIFY_F047_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f047-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f047-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f047-chrome-'));
const METH = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f047-meth-'));   // scratch METHODOLOGY_DIR
const OTHER = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f047-other-')); // a non-methodology project
const BRAVE = process.env.VERIFY_F047_BROWSER ?? 'brave';
const ASSETS = path.join(ROOT, 'docs', 'bugs', 'assets');
const JSON_FILE = path.join(METH, '.station', 'needs-human.json');
const ACKS_FILE = path.join(METH, '.station', 'needs-human-acks.json');

/*
 * BUG-039: WA-consolidation findings (FEAT-047, what this suite exists to
 * prove) surface ONLY on the methodology-HOME project, which the server
 * hardcodes as `projectRoot()` — this checkout, not a scratch copy — so this
 * suite must register ROOT as that project no matter what. But server boot
 * ALSO runs `wa-consolidate.mjs --apply` (src/server/index.ts, the
 * CLAUDE_STATION_NO_WA_CONSOLIDATE escape hatch is for a different purpose —
 * skipping WA consolidation outright, which item 1 below needs to run), and
 * that pass rides arch-watch (FEAT-056) over THIS repo's OWN
 * docs/bugs/.arch/findings.json REGARDLESS of METHODOLOGY_DIR. Every run of
 * this suite therefore overwrites that real, git-ignored file as a side
 * effect of merely booting the server — and once it holds findings (as it
 * does at HEAD from FEAT-056/ARCH-001 work), the rail carries them ALONGSIDE
 * the two planted WA findings this suite controls. Two fixes, both here:
 *   (a) every assertion below is scoped to the SPECIFIC finding ids this
 *       suite planted (routingId/contraId), never an exact total count of
 *       kind:'finding' rows — so unrelated real findings can freely coexist;
 *   (b) the real file is snapshotted before the server boots and restored
 *       in the teardown, so running this suite never leaves the repo's own
 *       derived state different from how it found it.
 */
const ARCH_FINDINGS_FILE = path.join(ROOT, 'docs', 'bugs', '.arch', 'findings.json');
const ARCH_ACKS_FILE = path.join(ROOT, 'docs', 'bugs', '.arch', 'acks.json');
function snapshotFile(file) {
  try { return { existed: true, content: fs.readFileSync(file, 'utf8') }; } catch { return { existed: false, content: null }; }
}
function restoreFile(file, snap) {
  if (snap.existed) fs.writeFileSync(file, snap.content);
  else fs.rmSync(file, { force: true });
}
const archSnapshot = { findings: snapshotFile(ARCH_FINDINGS_FILE), acks: snapshotFile(ARCH_ACKS_FILE) };

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

/* ------------------------------------------------- scratch methodology repo */
/*
 * The planted WA carries EXACTLY one contradiction (an "Always …" bullet vs a
 * "Never …" bullet sharing ≥0.3 of their tokens) and nothing else the
 * detectors act on: both bullets state a "because" (so the rule-without-why
 * detector skips them), the two sections' overall token overlap is diluted
 * below the 0.22 near-duplicate bar by disjoint filler bullets, and no
 * project-specific markers appear anywhere (so the boot pass can never
 * relocate anything into a real docs/CONVENTIONS.md). ROUTING.md is backdated
 * far past the 90-day staleness bar. Expected findings: contradiction ×1,
 * routing-stale ×1 — exactly two.
 */
const WA_DIRTY = `# Working Agreement (scratch fixture)

## Rigor

### A. Branch hygiene

- Always squash feature branches before pushing them upstream, because reviewers depend on linear history.
- The garden tomatoes ripen slowly in cold weather, because greenhouse heating stays off overnight.
- Watercolour pigments blend gently on damp paper, because fibres carry moisture sideways.

### B. Repository history

- Never squash feature branches before pushing them upstream, because bisect depends on complete history.
- Migrating songbirds navigate by starlight patterns, because magnetic sensing degrades near cities.
- Sourdough starters bubble fastest in warm kitchens, because wild yeast metabolism accelerates with heat.
`;
const WA_CLEAN = WA_DIRTY.replace(
  '- Never squash feature branches before pushing them upstream, because bisect depends on complete history.\n',
  '',
);
const ROUTING_STALE = `# Routing table (scratch fixture)\n\n- **STALENESS:** researched 2025-01-01 — re-verify after major releases.\n`;
const ROUTING_FRESH = `# Routing table (scratch fixture)\n\n- **STALENESS:** researched ${new Date().toISOString().slice(0, 10)} — re-verify after major releases.\n`;

function gitMeth(args) {
  const r = spawnSync('git', ['-C', METH, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in scratch methodology failed: ${r.stdout}${r.stderr}`);
  return r.stdout;
}
function seedMethodology() {
  fs.writeFileSync(path.join(METH, 'WORKING_AGREEMENT.v2.md'), WA_DIRTY);
  fs.writeFileSync(path.join(METH, 'ROUTING.md'), ROUTING_STALE);
  gitMeth(['init', '-q']);
  gitMeth(['config', 'user.email', 'f047@verify.local']);
  gitMeth(['config', 'user.name', 'FEAT-047 verify']);
  gitMeth(['add', '-A']);
  gitMeth(['commit', '-q', '-m', 'scratch methodology fixture']);
}

/* The other project gets a real answerable `## Question` ticket (unregressed). */
const Q_ID = 'BUG-801';
function seedOtherProject() {
  const bugs = path.join(OTHER, 'docs', 'bugs');
  fs.mkdirSync(bugs, { recursive: true });
  fs.writeFileSync(path.join(bugs, 'INDEX.md'),
    `# Board\n\n## Open\n\n| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n` +
    `| ${Q_ID} | pick a retry ceiling | 👤 | needs decision | med |\n\n` +
    `## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n`);
  fs.writeFileSync(path.join(bugs, `${Q_ID}-retry-ceiling.md`),
    `# ${Q_ID} — pick a retry ceiling\n\n- **Status:** OPEN\n\n## Question\nHow many retries before giving up?\n- three\n- five\n\n## Activity log (APPEND-ONLY)\n`);
}

function runPass(label) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'wa-consolidate.mjs'), '--apply', '--no-sync'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, METHODOLOGY_DIR: METH },
  });
  console.log(`  [pass:${label}] exit ${r.status}\n${(r.stdout + r.stderr).trim().split('\n').map((l) => `        | ${l}`).join('\n')}`);
  return r;
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

async function registerProject(hostPath, name) {
  const r = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath, name }),
  })).json();
  if (!r.project?.id) throw new Error(`could not register ${name}: ${JSON.stringify(r)}`);
  return r.project.id;
}
const boardOf = async (id) => (await fetch(`${BASE}/api/projects/${id}/board`)).json();

async function main() {
  seedMethodology();
  seedOtherProject();

  console.log('\n=== 1. server BOOT pass persists needs-human findings to the scratch METHODOLOGY_DIR ===');
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA,
      CLAUDE_PROJECTS_DIR: STORE, METHODOLOGY_DIR: METH,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); }
  }
  if (!up) throw new Error('server never became healthy');

  let bootWrote = false;
  for (let i = 0; i < 80 && !bootWrote; i++) { bootWrote = fs.existsSync(JSON_FILE); if (!bootWrote) await sleep(250); }
  check('BOOT consolidation pass wrote .station/needs-human.json in the scratch methodology dir',
    bootWrote, JSON_FILE);
  if (!bootWrote) throw new Error('no findings JSON — nothing downstream can pass');
  const j1 = readJson(JSON_FILE);
  const types1 = (j1.findings ?? []).map((f) => f.type).sort();
  check('the JSON holds EXACTLY the two planted findings (contradiction + routing-stale), each with a stable id + date',
    types1.length === 2 && types1.join(',') === 'contradiction,routing-stale' &&
      j1.findings.every((f) => typeof f.id === 'string' && f.id && typeof f.date === 'string' && typeof f.summary === 'string'),
    JSON.stringify(j1.findings?.map((f) => ({ id: f.id, type: f.type, date: f.date }))));
  check('the scratch methodology repo porcelain stays CLEAN (findings live under the locally-excluded .station/)',
    gitMeth(['status', '--porcelain']).trim() === '', JSON.stringify(gitMeth(['status', '--porcelain']).trim()));
  const routingId = j1.findings.find((f) => f.type === 'routing-stale')?.id;
  const contraId = j1.findings.find((f) => f.type === 'contradiction')?.id;

  console.log('\n=== 2. board route: findings surface ONLY on the methodology-home project ===');
  const homeId = await registerProject(ROOT, 'Methodology Home');
  const otherId = await registerProject(OTHER, 'Other Project');
  const bHome = await boardOf(homeId);
  // FEAT-079: bare WA-consolidation findings are READ-ONLY OBSERVATIONS, not
  // asks — they live in `board.observations`, never `board.needsYou`.
  const findingRows = (bHome.observations ?? []).filter((x) => x.kind === 'finding');
  // BUG-039: scoped to the two ids THIS suite planted — an exact total count
  // over ALL kind:'finding' rows breaks the moment an unrelated finding
  // source (e.g. FEAT-056 arch-recurrence, real at HEAD) coexists.
  const waRows = findingRows.filter((x) => x.id === routingId || x.id === contraId);
  check('methodology-home board carries both PLANTED kind:"finding" rows in OBSERVATIONS, read-only (no question), labeled + detailed',
    waRows.length === 2 &&
      waRows.every((x) => x.question === undefined && /^WA consolidation: /.test(x.title) && x.detail) &&
      waRows.some((x) => x.id === routingId && /routing table stale/.test(x.title)) &&
      waRows.some((x) => x.id === contraId && /contradictory rules/.test(x.title)),
    JSON.stringify(findingRows.map((x) => ({ id: x.id, title: x.title, question: x.question }))));
  // FEAT-079: and NONE of the bare findings leaked into the decision rail.
  check('FEAT-079: neither planted bare finding appears in needsYou (asks only)',
    (bHome.needsYou ?? []).filter((x) => x.id === routingId || x.id === contraId).length === 0,
    JSON.stringify((bHome.needsYou ?? []).filter((x) => x.kind === 'finding').map((x) => x.id)));
  const bOther = await boardOf(otherId);
  check('SCOPING: the other project gets NO finding rows in either lane (its own answerable ticket only)',
    (bOther.observations ?? []).filter((x) => x.kind === 'finding').length === 0 &&
      (bOther.needsYou ?? []).filter((x) => x.kind === 'finding').length === 0 &&
      bOther.needsYou?.some((x) => x.id === Q_ID && x.question),
    JSON.stringify(bOther.needsYou?.map((x) => ({ id: x.id, kind: x.kind }))));

  console.log('\n=== 3. real browser: read-only attention rows in the rail ===');
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
  const openHome = async () => {
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    // Freshly-registered projects have no lastActivityAt, so they may fold
    // under the collapsed "N inactive projects" row — wait for EITHER visible
    // project rows or that collapse toggle (clickProj expands it).
    await cdp.waitFor('boot', `document.querySelectorAll('#tree button.proj').length >= 2 || !!document.querySelector('#tree .inactive-l')`, 30_000);
    const ok = await clickProj('Methodology Home');
    if (!ok) throw new Error('could not select the Methodology Home project');
    await cdp.waitFor('project selected', `window.__station?.state?.current?.projectId === ${JSON.stringify(homeId)}`, 10_000);
  };

  await openHome();
  // BUG-039: wait for the two PLANTED ids specifically — not an exact count
  // of every observation card, which unrelated real findings inflate.
  // FEAT-079: findings render in the OBSERVATIONS lane (#railObservations,
  // data-kind="observation"), NOT the decision rail.
  await cdp.waitFor('observation rows', `document.querySelectorAll('#railObservations .needs-card[data-id="${routingId}"]').length === 1 &&
     document.querySelectorAll('#railObservations .needs-card[data-id="${contraId}"]').length === 1`, 20_000);
  const rows = await cdp.eval(`[...document.querySelectorAll('#railObservations .needs-card[data-kind="observation"]')]
    .filter((c) => c.dataset.id === ${JSON.stringify(routingId)} || c.dataset.id === ${JSON.stringify(contraId)})
    .map((c) => ({
    id: c.dataset.id,
    label: c.querySelector('.nc-id')?.textContent ?? '',
    title: c.querySelector('.nc-title')?.textContent ?? '',
    detail: c.querySelector('.nc-question')?.textContent ?? '',
    hasTextarea: !!c.querySelector('textarea, .nc-input'),
    hasOptions: c.querySelectorAll('.nc-opt').length,
    dismissText: [...c.querySelectorAll('button')].map((b) => b.textContent).join(','),
  }))`);
  check('(rail) both findings render as READ-ONLY observation rows: no textarea/options, clearly labeled "WA consolidation"',
    rows.length === 2 && rows.every((r) => !r.hasTextarea && r.hasOptions === 0 && r.label === 'WA consolidation' && /^WA consolidation: /.test(r.title)),
    JSON.stringify(rows));
  // FEAT-079: prove the split in the DOM — no finding leaked into #railNeeds.
  check('(rail) FEAT-079: the decision rail (#railNeeds) carries NO planted finding card',
    (await cdp.eval(`document.querySelectorAll('#railNeeds .needs-card[data-id="${routingId}"], #railNeeds .needs-card[data-id="${contraId}"]').length`)) === 0,
    'railNeeds finding cards');
  check('(rail) the routing row names the finding ("routing table stale") and shows its evidence detail',
    rows.some((r) => r.id === routingId && /routing table stale/.test(r.title) && /ROUTING\.md/.test(r.detail)),
    JSON.stringify(rows.find((r) => r.id === routingId)));
  check('(rail) each finding row offers exactly a Dismiss affordance',
    rows.every((r) => r.dismissText === 'Dismiss'), JSON.stringify(rows.map((r) => r.dismissText)));
  await cdp.shot(path.join(ASSETS, 'FEAT-047-findings-rail.png'));

  console.log('\n=== 4. dismiss: row leaves, ack persists across reload AND a re-detecting pass ===');
  await cdp.eval(`(() => {
    const c = document.querySelector('#railObservations .needs-card[data-id="${routingId}"]');
    [...c.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss').click();
  })()`);
  const goneNow = await cdp.waitFor('dismissed row removed',
    `document.querySelectorAll('#railObservations .needs-card[data-id="${routingId}"]').length === 0 &&
     document.querySelectorAll('#railObservations .needs-card[data-id="${contraId}"]').length === 1`, 15_000);
  check('dismissing the routing observation removes ONLY that row (the contradiction row stays)', goneNow,
    `observation rows now = ${await cdp.eval(`document.querySelectorAll('#railObservations .needs-card[data-kind="observation"]').length`)}`);
  await sleep(300);
  check('the ack was recorded beside the JSON (id → the finding\'s date)',
    fs.existsSync(ACKS_FILE) && readJson(ACKS_FILE)[routingId] === j1.findings.find((f) => f.id === routingId).date,
    fs.existsSync(ACKS_FILE) ? JSON.stringify(readJson(ACKS_FILE)) : 'no acks file');

  await openHome();
  // BUG-039: ID-scoped, not an exact total — unrelated finding sources
  // (arch-recurrence) may legitimately still be on the rail.
  const afterReload = await cdp.waitFor('post-reload rail settles',
    `document.querySelectorAll('#railObservations .needs-card[data-id="${routingId}"]').length === 0 &&
     document.querySelectorAll('#railObservations .needs-card[data-id="${contraId}"]').length === 1`, 20_000);
  check('after a full page RELOAD the dismissed row STAYS gone; the un-dismissed one is still there', afterReload,
    JSON.stringify(await cdp.eval(`[...document.querySelectorAll('#railObservations .needs-card[data-kind="observation"]')].map((c) => c.dataset.id)`)));
  await cdp.shot(path.join(ASSETS, 'FEAT-047-dismissed.png'));

  // A re-run pass re-detects BOTH findings (nothing was fixed) — the same
  // command line the post-capture hook runs. Ids AND dates must carry forward,
  // so the dismissal still holds.
  const r2 = runPass('re-detect');
  const j2 = readJson(JSON_FILE);
  check('a RE-RUN pass (post-capture code path) re-detects both findings with the SAME ids and CARRIED-FORWARD dates',
    r2.status === 0 && j2.findings.length === 2 &&
      JSON.stringify(j2.findings.map((f) => [f.id, f.date]).sort()) === JSON.stringify(j1.findings.map((f) => [f.id, f.date]).sort()),
    JSON.stringify(j2.findings.map((f) => ({ id: f.id, date: f.date }))));
  const bAfterRerun = await boardOf(homeId);
  // BUG-039: scoped to the two planted ids, not the full kind:'finding' list.
  // FEAT-079: read the OBSERVATIONS lane now.
  const waIdsAfterRerun = (bAfterRerun.observations ?? [])
    .filter((x) => x.kind === 'finding' && (x.id === routingId || x.id === contraId))
    .map((x) => x.id);
  check('…so the dismissal SURVIVES the re-run: the board still hides the ack\'d finding, keeps the other',
    waIdsAfterRerun.join(',') === contraId,
    JSON.stringify((bAfterRerun.observations ?? []).filter((x) => x.kind === 'finding').map((x) => x.id)));

  console.log('\n=== 5. clean pass: JSON empties, rows leave the rail ===');
  fs.writeFileSync(path.join(METH, 'WORKING_AGREEMENT.v2.md'), WA_CLEAN);
  fs.writeFileSync(path.join(METH, 'ROUTING.md'), ROUTING_FRESH);
  gitMeth(['add', '-A']);
  gitMeth(['commit', '-q', '-m', 'fix the contradiction + refresh routing (clean state)']);
  const r3 = runPass('clean');
  const j3 = readJson(JSON_FILE);
  check('the CLEAN pass overwrites the JSON to zero findings', r3.status === 0 && j3.findings.length === 0, JSON.stringify(j3));
  const bClean = await boardOf(homeId);
  // BUG-039: scoped to the two planted ids — unrelated finding sources
  // (arch-recurrence) are allowed to still be present; only the WA ones this
  // suite controls must have cleared. FEAT-079: OBSERVATIONS lane.
  check('the board drops the PLANTED finding rows on the clean state (unrelated finding sources may remain)',
    (bClean.observations ?? []).filter((x) => x.kind === 'finding' && (x.id === routingId || x.id === contraId)).length === 0,
    JSON.stringify((bClean.observations ?? []).filter((x) => x.kind === 'finding').map((x) => ({ id: x.id, kind: x.kind }))));
  await openHome();
  const railClean = await cdp.waitFor('planted finding rows gone from the rail',
    `window.__station?.state?.board &&
     document.querySelectorAll('#railObservations .needs-card[data-id="${routingId}"]').length === 0 &&
     document.querySelectorAll('#railObservations .needs-card[data-id="${contraId}"]').length === 0`, 20_000);
  check('(rail) planted findings cleared → their rows gone (unrelated finding sources may remain)', railClean,
    `observation rows = ${await cdp.eval(`document.querySelectorAll('#railObservations .needs-card[data-kind="observation"]').length`)}`);

  console.log('\n=== 6. unregressed: an answerable `## Question` card still renders in another project ===');
  const okOther = await clickProj('Other Project');
  check('the other project is selectable', okOther, `clicked=${okOther}`);
  await cdp.waitFor('other project selected', `window.__station?.state?.current?.projectId === ${JSON.stringify(otherId)}`, 10_000);
  const qCard = await cdp.waitFor('answerable card',
    `(() => { const c = document.querySelector('#railNeeds .needs-card[data-id="${Q_ID}"]');
       return !!c && !!c.querySelector('textarea.nc-input') && c.querySelectorAll('.nc-opt').length === 2 &&
         document.querySelectorAll('#railNeeds .needs-card[data-kind="finding"]').length === 0 &&
         document.querySelectorAll('#railObservations .needs-card[data-kind="observation"]').length === 0; })()`, 20_000);
  check('the `## Question` ticket still renders an answerable card (textarea + 2 options) and NO finding/observation rows leak in', qCard,
    `card ok=${qCard}`);

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
    for (const d of [DATA, STORE, PROFILE, METH, OTHER]) fs.rmSync(d, { recursive: true, force: true });
    // BUG-039: restore this repo's OWN derived arch-findings state to exactly
    // what it was before this run — every server boot + runPass() above ran
    // arch-watch against the real ROOT (see the comment by ARCH_FINDINGS_FILE),
    // and this suite must not be the reason that file drifts between runs.
    restoreFile(ARCH_FINDINGS_FILE, archSnapshot.findings);
    restoreFile(ARCH_ACKS_FILE, archSnapshot.acks);
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
