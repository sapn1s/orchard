/**
 * FEAT-076 — per-project "Wiring" health panel.
 *
 *   node scripts/verify-feat-076-wiring.mjs
 *
 * One scratch station server (OS-assigned free port, scratch dataDir — NEVER
 * :4317, never the real registry) plus a REALISTIC bare-vs-wired fixture:
 *
 *  Fixtures (real temp dirs on disk, registered as real projects):
 *   - BARE  — a real bare-repo shape: a package.json WITHOUT board:check, its OWN
 *     CLAUDE.md with zero WA pointer, no docs/CONVENTIONS.md, no docs/bugs board,
 *     tools {serena,playwright} enabled. Runtime wired, methodology bare.
 *   - WIRED — a fully onboarded repo (onboard() ran: docs/bugs board, board.mjs +
 *     board:check, docs/CONVENTIONS.md, an onboard-authored CLAUDE.md whose WA
 *     pointer resolves) with NO attached template ref. The realistic "done" state.
 *   - PRISTINE — an empty dir, to prove a status READ has zero side effects.
 *
 *  SERVER (fetch):
 *   - GET wiring on BARE  → WA/conventions/board/drift-guard all ❌; routing +
 *     integrations informational. (Bidirectional must-fail: an always-✅ check
 *     fails these rows.)
 *   - GET wiring on WIRED → every methodology row ✅ (WA via the CLAUDE.md
 *     pointer arm; board/conventions/drift-guard from files). (An always-❌ check
 *     fails these rows.)
 *   - READ HAS NO SIDE EFFECTS: 5× GET wiring on PRISTINE creates NOTHING
 *     (no docs/bugs, no CONVENTIONS.md, no scripts/board.mjs) — a status read
 *     must NEVER shell out to onboard.
 *   - APPLY attach-wa on BARE → WA flips ✅ via a real attached REF (its CLAUDE.md
 *     still has no pointer, so this exercises the ref arm), and the ref is
 *     persisted in settings.instructions via the validated PATCH path.
 *   - APPLY onboard on BARE → board/conventions/drift-guard flip ✅, and the
 *     scaffolded files land in the project's OWN registered hostPath — proving
 *     onboard runs against the registry hostPath, never the station's cwd.
 *   - ONBOARD IS NEVER RUN AGAINST THE STATION'S OWN TREE: the server's cwd
 *     (ROOT) gains no new artifact across the whole run, and every Apply report
 *     path resolves INSIDE the target fixture dir.
 *   - the route rides the BUG-076 Host allowlist (foreign Host → 403).
 *
 *  CLIENT (real brave --headless=new over raw CDP): open the settings drawer for
 *   the BARE project, expand Wiring, and assert the real panel renders the ❌
 *   rows with their Apply buttons — the user's actual reality, not a scripted DOM.
 *
 * MUST-FAIL pre-fix: with src/server/wiring.ts + the route absent, GET wiring
 * 404s → `api.wiring` is null → the panel never renders and every assertion
 * below fails. Re-run after the lane lands.
 */
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

import { onboard } from './onboard.mjs';

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_WIRING_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-wiring-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-wiring-brave-'));
const BRAVE = process.env.VERIFY_WIRING_BROWSER ?? 'brave';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function req(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

/** Raw HTTP GET with an explicit Host header for the DNS-rebinding guard. */
function rawGet(pathname, hostHeader) {
  return new Promise((resolve) => {
    const r = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method: 'GET',
        headers: hostHeader === undefined ? {} : { Host: hostHeader } },
      (res) => { res.resume(); resolve(res.statusCode); });
    r.on('error', () => resolve(0));
    r.end();
  });
}

/* --------------------------------------------------------------- fixtures */
const fixtures = [];
function mkfix(kind) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cs-wiring-${kind}-`));
  fixtures.push(dir);
  return dir;
}
const stateOf = (wiring, key) => wiring?.checks?.find((c) => c.key === key)?.state;
/** Recursively true if `p` gained ANY of the named methodology artifacts. */
function hasArtifacts(p) {
  return fs.existsSync(path.join(p, 'docs', 'bugs', 'INDEX.md'))
    || fs.existsSync(path.join(p, 'docs', 'CONVENTIONS.md'))
    || fs.existsSync(path.join(p, 'scripts', 'board.mjs'));
}

async function main() {
  /* ---- BARE fixture (a real bare-repo shape) ---- */
  const bareDir = mkfix('bare');
  fs.writeFileSync(path.join(bareDir, 'package.json'),
    JSON.stringify({ name: 'bare-fixture', version: '1.0.0', scripts: { build: 'tsc' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(bareDir, 'CLAUDE.md'),
    '# bare-fixture\n\nA project with its own house rules and no pointer to any shared agreement.\n');

  /* ---- WIRED fixture: onboard() it for real, no attached ref ---- */
  const wiredDir = mkfix('wired');
  fs.writeFileSync(path.join(wiredDir, 'package.json'),
    JSON.stringify({ name: 'wired-fixture', version: '1.0.0', scripts: { build: 'tsc' } }, null, 2) + '\n');
  onboard(wiredDir); // scaffolds board + board.mjs + board:check + CONVENTIONS + WA-pointer CLAUDE.md

  /* ---- PRISTINE fixture: empty, to prove reads have no side effects ---- */
  const pristineDir = mkfix('pristine');

  /* ---- boot the scratch server (never :4317) ---- */
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); }
  }
  if (!up) throw new Error('server never became healthy');

  // Snapshot the station's OWN tree so we can prove onboard never touches it.
  const stationBefore = {
    convMtime: fs.statSync(path.join(ROOT, 'docs', 'CONVENTIONS.md')).mtimeMs,
    boardMtime: fs.statSync(path.join(ROOT, 'scripts', 'board.mjs')).mtimeMs,
    indexMtime: fs.statSync(path.join(ROOT, 'docs', 'bugs', 'INDEX.md')).mtimeMs,
  };

  /* ---- register the fixtures as real projects ----
   * applyMethod:false (FEAT-089): this panel is tested precisely in the
   * NOT-YET-APPLIED state — bare/pristine must stay unscaffolded so the wiring
   * ❌ rows + Apply buttons below have something to repair. Auto-apply on add
   * (the default) is verified separately in verify-feat-089-method-auto.mjs.
   */
  const bare = (await req('POST', '/api/projects', { hostPath: bareDir, name: 'bare-fixture', applyMethod: false })).body?.project;
  const wired = (await req('POST', '/api/projects', { hostPath: wiredDir, name: 'wired-fixture', applyMethod: false })).body?.project;
  const pristine = (await req('POST', '/api/projects', { hostPath: pristineDir, name: 'pristine-fixture', applyMethod: false })).body?.project;
  check('fixtures registered as real projects', !!(bare && wired && pristine),
    { bare: bare?.id, wired: wired?.id, pristine: pristine?.id });
  // Give BARE the typical bare-repo tool shape.
  await req('PATCH', `/api/projects/${bare.id}`, { settings: { tools: { serena: true, playwright: true } } });

  /* ================= (1) BARE reports every methodology layer ❌ ============ */
  console.log('\n=== (1) BARE fixture: methodology layers computed as MISSING ===');
  const bw0 = (await req('GET', `/api/projects/${bare.id}/wiring`)).body?.wiring;
  check('(1a) GET wiring → a checks array keyed by layer', Array.isArray(bw0?.checks) && bw0.checks.length >= 6,
    bw0?.checks?.map((c) => c.key));
  check('(1b) Working Agreement ❌ (no ref, CLAUDE.md has no pointer)', stateOf(bw0, 'working-agreement') === 'missing',
    stateOf(bw0, 'working-agreement'));
  check('(1c) Local conventions ❌ (no docs/CONVENTIONS.md)', stateOf(bw0, 'conventions') === 'missing',
    stateOf(bw0, 'conventions'));
  check('(1d) Ticket board ❌ (no docs/bugs)', stateOf(bw0, 'board') === 'missing', stateOf(bw0, 'board'));
  check('(1e) Board drift-guard ❌ (package.json has no board:check, no board.mjs)',
    stateOf(bw0, 'drift-guard') === 'missing', stateOf(bw0, 'drift-guard'));
  check('(1f) Provider routing is informational ℹ️ (universal)', stateOf(bw0, 'routing') === 'info', stateOf(bw0, 'routing'));
  check('(1g) Integrations informational + names the enabled tools',
    stateOf(bw0, 'integrations') === 'info' && /Serena/.test(bw0.checks.find((c) => c.key === 'integrations').detail),
    bw0?.checks?.find((c) => c.key === 'integrations')?.detail);
  check('(1h) hostPath is the registry value, not client-supplied', bw0?.hostPath === bareDir, bw0?.hostPath);

  /* ================= (2) WIRED reports every methodology layer ✅ =========== */
  console.log('\n=== (2) WIRED fixture: every methodology layer applied ===');
  const ww = (await req('GET', `/api/projects/${wired.id}/wiring`)).body?.wiring;
  check('(2a) Working Agreement ✅ via the CLAUDE.md pointer arm (no attached ref)',
    stateOf(ww, 'working-agreement') === 'ok', stateOf(ww, 'working-agreement'));
  check('(2b) Local conventions ✅', stateOf(ww, 'conventions') === 'ok', stateOf(ww, 'conventions'));
  check('(2c) Ticket board ✅', stateOf(ww, 'board') === 'ok', stateOf(ww, 'board'));
  check('(2d) Board drift-guard ✅ (board:check + scripts/board.mjs)', stateOf(ww, 'drift-guard') === 'ok',
    stateOf(ww, 'drift-guard'));
  check('(2e) no methodology row is left ❌ on a fully-wired project',
    ww.checks.filter((c) => c.apply).length === 0, ww.checks.filter((c) => c.apply).map((c) => c.key));

  /* ================= (3) a status READ has ZERO side effects =============== */
  console.log('\n=== (3) reading status never scaffolds (no onboard on a read) ===');
  for (let i = 0; i < 5; i++) await req('GET', `/api/projects/${pristine.id}/wiring`);
  check('(3a) 5× GET wiring on a PRISTINE dir created NOTHING in it', !hasArtifacts(pristineDir),
    fs.readdirSync(pristineDir));
  const pw = (await req('GET', `/api/projects/${pristine.id}/wiring`)).body?.wiring;
  check('(3b) …and it still reports the layers missing (read reflects reality, not a scaffold)',
    stateOf(pw, 'board') === 'missing' && stateOf(pw, 'conventions') === 'missing', {
      board: stateOf(pw, 'board'), conventions: stateOf(pw, 'conventions'),
    });

  /* ================= (4) APPLY attach-wa → WA flips via a REF ============== */
  console.log('\n=== (4) Apply attach-wa: WA flips ✅ via a persisted ref ===');
  const applyWa = await req('POST', `/api/projects/${bare.id}/wiring/apply`, { check: 'working-agreement' });
  check('(4a) apply attach-wa → 200 with the freshly-recomputed wiring', applyWa.status === 200 && !!applyWa.body?.wiring,
    { status: applyWa.status, applied: applyWa.body?.applied });
  check('(4b) the echoed wiring shows Working Agreement ✅', stateOf(applyWa.body?.wiring, 'working-agreement') === 'ok',
    stateOf(applyWa.body?.wiring, 'working-agreement'));
  const bareAfter = (await req('GET', `/api/projects/${bare.id}`)).body?.project;
  const refs = bareAfter?.settings?.instructions ?? [];
  check('(4c) a working-agreement ref is PERSISTED in settings.instructions (validated PATCH path)',
    refs.some((r) => (r.templateId === 'working-agreement-v2' || r.templateId === 'working-agreement') && r.enabled !== false),
    refs);
  const claudeStillBare = !/WORKING_AGREEMENT|orchard:wa-pointer/.test(fs.readFileSync(path.join(bareDir, 'CLAUDE.md'), 'utf8'));
  check('(4d) …proving the REF arm: BARE\'s CLAUDE.md still has no pointer, yet WA is ✅', claudeStillBare, { claudeStillBare });

  /* ================= (5) APPLY onboard → board/conventions/guard flip ====== */
  console.log('\n=== (5) Apply onboard: scaffolding flips ✅ against the registry hostPath ===');
  const applyBoard = await req('POST', `/api/projects/${bare.id}/wiring/apply`, { check: 'board' });
  check('(5a) apply onboard → 200 with reports + fresh wiring', applyBoard.status === 200
    && Array.isArray(applyBoard.body?.reports) && !!applyBoard.body?.wiring,
    { status: applyBoard.status, reports: applyBoard.body?.reports?.length });
  const bw1 = applyBoard.body?.wiring;
  check('(5b) Ticket board ✅ after onboard', stateOf(bw1, 'board') === 'ok', stateOf(bw1, 'board'));
  check('(5c) Local conventions ✅ after onboard', stateOf(bw1, 'conventions') === 'ok', stateOf(bw1, 'conventions'));
  check('(5d) Board drift-guard ✅ after onboard', stateOf(bw1, 'drift-guard') === 'ok', stateOf(bw1, 'drift-guard'));
  check('(5e) the scaffolded files landed in the project\'s OWN hostPath (not cwd)',
    fs.existsSync(path.join(bareDir, 'docs', 'bugs', 'INDEX.md'))
    && fs.existsSync(path.join(bareDir, 'docs', 'CONVENTIONS.md'))
    && fs.existsSync(path.join(bareDir, 'scripts', 'board.mjs')), {
      board: fs.existsSync(path.join(bareDir, 'docs', 'bugs', 'INDEX.md')),
      conv: fs.existsSync(path.join(bareDir, 'docs', 'CONVENTIONS.md')),
      tool: fs.existsSync(path.join(bareDir, 'scripts', 'board.mjs')),
    });

  /* ============= (6) onboard is NEVER run against the station's own tree === */
  console.log('\n=== (6) onboard never touches the station\'s own cwd/tree ===');
  const stationAfter = {
    convMtime: fs.statSync(path.join(ROOT, 'docs', 'CONVENTIONS.md')).mtimeMs,
    boardMtime: fs.statSync(path.join(ROOT, 'scripts', 'board.mjs')).mtimeMs,
    indexMtime: fs.statSync(path.join(ROOT, 'docs', 'bugs', 'INDEX.md')).mtimeMs,
  };
  check('(6a) the station ROOT gained no methodology-file mutation across the whole run',
    stationAfter.convMtime === stationBefore.convMtime
    && stationAfter.boardMtime === stationBefore.boardMtime
    && stationAfter.indexMtime === stationBefore.indexMtime, { stationBefore, stationAfter });
  const reportPaths = (applyBoard.body?.reports ?? []).map((r) => r.path);
  const anyOutsideTarget = reportPaths.some((rp) => {
    const abs = path.resolve(ROOT, rp); // reports are relative to the server cwd
    return !abs.startsWith(bareDir + path.sep) && abs !== bareDir;
  });
  check('(6b) every onboard report path resolves INSIDE the target fixture dir', !anyOutsideTarget,
    reportPaths.slice(0, 4));

  /* ================= (7) unknown-check + Host guard ======================== */
  console.log('\n=== (7) apply refuses an unknown check; route rides the Host guard ===');
  const badApply = await req('POST', `/api/projects/${bare.id}/wiring/apply`, { check: 'nonsense' });
  check('(7a) apply with an unknown check → 400 (no silent no-op, no scaffold)', badApply.status === 400, badApply.status);
  const foreignHost = await rawGet(`/api/projects/${bare.id}/wiring`, 'attacker.rebind.example');
  const goodHost = await rawGet(`/api/projects/${bare.id}/wiring`, `127.0.0.1:${PORT}`);
  check('(7b) a foreign Host is rejected 403 on the wiring route (DNS-rebind guard intact)', foreignHost === 403, foreignHost);
  check('(7c) a localhost Host still serves it (guard did not over-block)', goodHost === 200, goodHost);

  /* ================= (8) CLIENT: the real drawer renders the panel ========= */
  console.log('\n=== (8) client: the real Wiring panel renders ❌ rows + Apply buttons ===');
  // Use a SECOND bare project so the drawer shows a bare-state panel (the first
  // was mutated by the Apply tests above). Realistic state: a freshly added,
  // never-wired project — exactly what a user sees right after adding a repo.
  const bare2Dir = mkfix('bare2');
  fs.writeFileSync(path.join(bare2Dir, 'package.json'),
    JSON.stringify({ name: 'bare2-fixture', version: '1.0.0', scripts: { build: 'tsc' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(bare2Dir, 'CLAUDE.md'), '# bare2\n\nHouse rules, no shared agreement pointer.\n');
  // applyMethod:false (FEAT-089): keep bare2 unscaffolded so the drawer renders
  // the ❌ rows + Apply buttons this section asserts. The auto-apply-on-add
  // default is covered by verify-feat-089-method-auto.mjs.
  const bare2 = (await req('POST', '/api/projects', { hostPath: bare2Dir, name: 'bare2-fixture', applyMethod: false })).body?.project;

  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  // Deep-link to the bare2 project (a freshly-added, never-wired project — the
  // real state a user is in right after adding a repo) so it becomes the current
  // project, then open the settings drawer via the topbar cog — the real
  // click-path, not a synthetic DOM injection.
  await cdp.send('Page.navigate', { url: `${BASE}/#/project/${encodeURIComponent(bare2.id)}` });
  await cdp.waitFor('app booted', 'document.querySelectorAll(".proj").length > 0', 60_000);
  await cdp.waitFor('bare2 selected as current',
    `(() => { const t = document.querySelector('#dTitle')?.textContent || ''; return document.querySelector('#cogBtn') && true; })()`, 30_000);
  const opened = await cdp.eval(`(() => {
    const cog = document.querySelector('#cogBtn');
    if (!cog) return { ok:false, why:'no #cogBtn' };
    cog.click();
    return { ok:true, title: document.querySelector('#dTitle')?.textContent ?? null };
  })()`);
  check('(8a) the topbar settings cog opens the drawer for the current project', opened?.ok === true, opened);

  const wiringSeen = await cdp.waitFor('wiring rows',
    `(() => {
       const sect = [...document.querySelectorAll('.sect')].find((s) => (s.querySelector('summary')?.textContent||'').includes('Wiring'));
       if (sect && !sect.open) sect.open = true;
       return document.querySelectorAll('.wiring-row').length >= 6;
     })()`, 20_000);
  check('(8b) the Wiring panel renders its per-layer rows in the real drawer', wiringSeen, { wiringSeen });

  const panel = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.wiring-row')];
    const byKey = {};
    for (const r of rows) {
      const label = r.querySelector('.l')?.textContent || '';
      byKey[label] = { state: r.getAttribute('data-state'),
                       icon: r.querySelector('.ic')?.textContent || '',
                       apply: !!r.querySelector('.wiring-apply') };
    }
    return byKey;
  })()`);
  check('(8c) Working Agreement row shows ❌ with an Apply button',
    panel['Working Agreement']?.state === 'missing' && panel['Working Agreement']?.icon === '❌' && panel['Working Agreement']?.apply,
    panel['Working Agreement']);
  check('(8d) Ticket board row shows ❌ with an Apply (Scaffold) button',
    panel['Ticket board']?.state === 'missing' && panel['Ticket board']?.apply, panel['Ticket board']);
  check('(8e) Local conventions + Board drift-guard rows both show ❌ + Apply',
    panel['Local conventions']?.state === 'missing' && panel['Local conventions']?.apply
    && panel['Board drift-guard']?.state === 'missing' && panel['Board drift-guard']?.apply,
    { conv: panel['Local conventions'], guard: panel['Board drift-guard'] });
  check('(8f) Provider routing renders as informational ℹ️ (no Apply)',
    panel['Provider routing']?.icon === 'ℹ️' && !panel['Provider routing']?.apply, panel['Provider routing']);

  cdp.close();
}

main()
  .catch((err) => { console.error('\nverify-feat-076-wiring: FATAL', err); fail++; })
  .finally(() => {
    stopByPid(server);
    stopByPid(browser);
    for (const dir of fixtures) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* best effort */ }
    console.log(`\nFEAT-076 wiring — ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILURES:', failures.join(' | ')); process.exit(1); }
    process.exit(0);
  });
