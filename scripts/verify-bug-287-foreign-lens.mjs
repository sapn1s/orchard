#!/usr/bin/env node
// BUG-287 r3 (foreign-dock lens) probe: real server (scratch data dir, free port) + headless Playwright chromium.
// Real transcripts copied in: the user's reported OpenAI session 019ff078 and the real Claude
// session 954811be. MODE=pre serves drawer.js with the r2 foreign-dock lens fix removed (must-FAIL).
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';
const ROOT = path.resolve(import.meta.dirname, '..');
const { chromium } = createRequire(ROOT + '/package.json')('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PRE = process.env.MODE === 'pre';
const SHOTS = process.env.SHOTS || null;
let pass = 0, fail = 0;
const check = (n, ok, o) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${JSON.stringify(o)}`); ok ? pass++ : fail++; };
const freePort = async () => { const net = await import('node:net'); return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); };
const HOME_ENC = os.homedir().replace(/[^A-Za-z0-9]/g, '-'); // the real sessions were run from $HOME
const OAI = '019ff078-a6eb-72b0-b51d-c0a6cacd82e0', CLA = '954811be-2e5a-4b94-89dd-d96942d6786c';
// The bundled playwright may expect a browser revision that is not downloaded; fall back to
// any installed chrome-headless-shell (PW_EXE overrides).
function pwExe() {
  if (process.env.PW_EXE) return process.env.PW_EXE;
  try { if (fs.existsSync(chromium.executablePath())) return undefined; } catch {}
  const c = path.join(os.homedir(), '.cache/ms-playwright');
  for (const d of (fs.existsSync(c) ? fs.readdirSync(c) : []).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
    for (const sub of fs.readdirSync(path.join(c, d))) { const e = path.join(c, d, sub, 'chrome-headless-shell'); if (fs.existsSync(e)) return e; }
  }
  return undefined;
}
let server, browser, tmp;
try {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bug287r2-'));
  const DATA = path.join(tmp, 'data'), CFG = path.join(tmp, 'cfg'), STORE = path.join(CFG, 'projects'), PROJ = path.join(tmp, 'p287');
  for (const d of [DATA, CFG, STORE, PROJ]) fs.mkdirSync(d, { recursive: true });
  const enc = PROJ.replace(/[^A-Za-z0-9]/g, '-');
  fs.mkdirSync(path.join(DATA, 'transcripts', 'openai', enc), { recursive: true });
  fs.copyFileSync(`${os.homedir()}/.local/share/claude-station/transcripts/openai/${HOME_ENC}/${OAI}.jsonl`, path.join(DATA, 'transcripts', 'openai', enc, `${OAI}.jsonl`));
  fs.mkdirSync(path.join(STORE, enc), { recursive: true });
  fs.copyFileSync(`${os.homedir()}/.claude/projects/${HOME_ENC}/${CLA}.jsonl`, path.join(STORE, enc, `${CLA}.jsonl`));
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: CFG, CLAUDE_PROJECTS_DIR: STORE, CLAUDE_STATION_DOCKER: 'bug287-no-docker' }, stdio: ['ignore', 'ignore', 'ignore'] });
  console.log(`  [scratch] server pid ${server.pid} port ${port}`);
  let up = false; for (let i = 0; i < 200 && !up; i++) { try { await fetch(`${base}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server down');
  const mk = async (hostPath, name) => (await (await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath, name, applyMethod: false }) })).json()).project?.id;
  const id = await mk(PROJ, 'p287');
  const PB = path.join(tmp, 'projB'); fs.mkdirSync(PB);
  const idB = await mk(PB, 'projB');
  browser = await chromium.launch({ headless: true, executablePath: pwExe() });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  if (PRE) await page.route('**/lib/drawer.js*', async (route) => {
    const r = await (await fetch(route.request().url())).text();
    let p = r.replace('const sessionOk = !!project() && !foreignOwner;', 'const sessionOk = !!project();')
      .replace("if (d.scope === 'session' && ctx.getForeignDockOwner?.()) d.scope = 'project';", '/* pre-r2 */')
      .replace("if (d.scope === 'session' && ctx.getForeignDockOwner?.()) { resetEdit(false); d.scope = 'project'; }", '/* pre-r3 */');
    if (p === r) console.log('  [pre] WARNING: fix lines not found');
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: p });
  });
  const ev = (e) => page.evaluate(e);
  const waitFor = async (e, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(e)) return true; } catch {} await sleep(150); } return false; };
  const go = async (hash, pid = id) => { await page.goto('about:blank'); await page.goto(`${base}/${hash}`); await waitFor('!!(window.__station && window.__station.drawer)'); await waitFor(`window.__station.currentProject()?.id === ${JSON.stringify(pid)}`); await sleep(400); };
  const READ = (openArgs = '') => `(async () => { const D = window.__station.drawer; D.close(); D.close(); await D.open('settings'${openArgs});
    await new Promise(r => setTimeout(r, 300));
    if (!document.querySelector('.prov-seg')) { document.querySelector('.srail-item[data-cat="model"]')?.click(); await new Promise(r => setTimeout(r, 300)); }
    const bs = [...document.querySelectorAll('.prov-seg button')];
    const lens = [...document.querySelectorAll('#dScope [data-scope]')].map(b => ({ s: b.dataset.scope, pressed: b.getAttribute('aria-pressed'), disabled: b.disabled, title: b.title }));
    return { scope: D.scope(), pressed: bs.filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent), disabled: bs.map(b => b.disabled), lens,
      cont: [...document.querySelectorAll('[data-continue-engine]')].map(b => b.textContent), eyebrow: document.querySelector('.d-eyebrow, #dEyebrow')?.textContent ?? null }; })()`;
  const sessHash = (s) => `#/project/${encodeURIComponent(id)}/session/${s}?dir=${enc}`;
  console.log(`\n=== baseline (criteria 1-3) ${PRE ? '(PRE-r2 drawer.js)' : ''} ===`);
  await go(sessHash(OAI)); await waitFor(`window.__station.lockedProviderOf(${JSON.stringify(OAI)}) != null`, 20000);
  const o = await ev(READ());
  check('OpenAI session: lens=session, Provider = OpenAI Codex, locked', o.scope === 'session' && o.pressed.join() === 'OpenAI Codex' && o.disabled.every(Boolean), o);
  await go(sessHash(CLA)); await waitFor(`window.__station.lockedProviderOf(${JSON.stringify(CLA)}) != null`, 20000);
  const c = await ev(READ());
  check('Claude session: lens=session, Provider = Claude, locked', c.scope === 'session' && c.pressed.join() === 'Claude' && c.disabled.every(Boolean), c);
  await go(`#/project/${encodeURIComponent(id)}`);
  const n = await ev(READ());
  check('no session (pending-new): lens=project, This session ENABLED (switchable)', n.scope === 'project' && n.lens.find((l) => l.s === 'session')?.disabled === false, n);

  console.log('\n=== foreign dock: OpenAI session of p287 open, projB selected ===');
  await go(sessHash(OAI)); await waitFor(`window.__station.lockedProviderOf(${JSON.stringify(OAI)}) != null`, 20000);
  await ev(`window.__station.selectProject(${JSON.stringify(idB)})`); await sleep(400);
  const meta = await ev(`({ foreign: window.__station.dockIsForeign(), pid: window.__station.currentProject()?.id })`);
  check('PRECONDITION: projB selected, dock foreign', meta.foreign === true && meta.pid === idB, meta);
  const f = await ev(READ());
  check('Settings for projB opens on project lens, Provider = projB default Claude, enabled', f.scope === 'project' && f.pressed.join() === 'Claude' && f.disabled.every((x) => !x), f);
  const sl = f.lens.find((l) => l.s === 'session');
  check('foreign: "This session" lens is DISABLED and names the real owner (p287)', sl?.disabled === true && /p287/.test(sl?.title ?? '') && /projB/.test(sl?.title ?? ''), sl);
  // The reported break: the user CLICKS "This session" (a real click, not a scripted state set).
  await page.locator('#dScope [data-scope="session"]').click({ force: true, timeout: 3000 }).catch(() => {});
  await sleep(400);
  const afterClick = await ev(`(() => { const bs = [...document.querySelectorAll('.prov-seg button')]; return { scope: window.__station.drawer.scope(), pressed: bs.filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent), cont: [...document.querySelectorAll('[data-continue-engine]')].map(b => b.textContent) }; })()`);
  check('foreign: clicking "This session" does NOT show p287\'s OpenAI engine nor a Continue button under projB', afterClick.scope === 'project' && afterClick.pressed.join() !== 'OpenAI Codex' && afterClick.cont.length === 0, afterClick);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `foreign-after-click${PRE ? '-PRE' : ''}.png`) });
  const fx = await ev(READ(", { scope: 'session' }"));
  check('foreign: an explicit {scope:"session"} open also lands on the project lens', fx.scope === 'project' && fx.pressed.join() !== 'OpenAI Codex' && fx.cont.length === 0, fx);
  if (SHOTS) { await page.locator('#dScope [data-scope="session"]').hover({ force: true }).catch(() => {}); await sleep(300); await page.screenshot({ path: path.join(SHOTS, `foreign-lens${PRE ? '-PRE' : ''}.png`) }); }

  console.log('\n=== drawer OPEN on p287 session lens, then projB selected underneath (IV a90d1190) ===');
  await ev(`window.__station.drawer.close()`);
  await ev(`window.__station.selectProject(${JSON.stringify(id)})`); await sleep(400);
  const pre2 = await ev(READ());
  check('pre: drawer open on p287 session lens, OpenAI Codex', pre2.scope === 'session' && pre2.pressed.join() === 'OpenAI Codex', pre2);
  await ev(`window.__station.selectProject(${JSON.stringify(idB)})`); await sleep(400);
  for (const how of ['repaintLive', 'repaint']) {
    await ev(`window.__station.drawer.${how}()`); await sleep(300);
    const u = await ev(`(() => { const bs = [...document.querySelectorAll('.prov-seg button')]; return { foreign: window.__station.dockIsForeign(), scope: window.__station.drawer.scope(), pressed: bs.filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent), cont: [...document.querySelectorAll('[data-continue-engine]')].map(b => b.textContent), eyebrow: document.querySelector('.d-eyebrow, #dEyebrow')?.textContent ?? null, hint: document.querySelector('#dHint, .d-hint')?.textContent ?? null }; })()`);
    check(`open-then-foreign (${how}): projB drawer drops to project lens, no p287 engine / Continue`, u.foreign === true && u.scope === 'project' && u.pressed.join() !== 'OpenAI Codex' && u.cont.length === 0, u);
  }
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `open-then-foreign${PRE ? '-PRE' : ''}.png`) });

  console.log('\n=== switch back to p287 (dock no longer foreign) ===');
  await ev(`window.__station.drawer.close()`);
  await ev(`window.__station.selectProject(${JSON.stringify(id)})`); await sleep(400);
  const back = await ev(READ());
  check('back on p287: Settings opens on session lens, OpenAI Codex locked, lens enabled', back.scope === 'session' && back.pressed.join() === 'OpenAI Codex' && back.disabled.every(Boolean) && back.lens.find((l) => l.s === 'session')?.disabled === false, back);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `back-on-owner${PRE ? '-PRE' : ''}.png`) });
} catch (e) { console.log('ERROR', e.stack ?? e.message); fail++; }
finally {
  try { await browser?.close(); } catch {}
  try { server?.kill('SIGTERM'); } catch {}
  try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
