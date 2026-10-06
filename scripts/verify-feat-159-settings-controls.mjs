/**
 * FEAT-159 — settings rows are edited by a real control, never by clicking the row.
 *
 *   node scripts/verify-feat-159-settings-controls.mjs
 *
 * The user's report: the Model row "I can click it and it just changes type
 * instead of e.g. being a dropdown or entering a custom model". Every value row
 * used to be a CYCLE — clicking anywhere on it wrote the next entry of a list the
 * user could not see, and the first click also turned an inherited value into a
 * project value, so the provenance chip flipped machine → project.
 *
 * What this proves, against the REAL server (every write is read back from
 * GET /api/projects/:id or the app's own session overrides, never from the DOM):
 *   1. clicking a row's label writes NOTHING (the regression itself);
 *   2. the Model dropdown sets a catalog model, and its "Machine default (…)"
 *      option clears it back to null;
 *   3. a CUSTOM model id round-trips: "Custom model id…" opens a free-text
 *      editor, a malformed id is refused with nothing written, a good id is
 *      stored, and after a full reload the dropdown shows it as the selection;
 *   4. Esc cancels the editor, writes nothing, and leaves the modal open;
 *   5. Effort / Permission mode / Spend cap write the same stored values as
 *      before (semantics unchanged), and the spend cap clears to null;
 *   6. under the session lens a pick is a session override and the registry is
 *      untouched, and the unset option names the PROJECT value it falls back to;
 *   7. the keyboard path: Tab reaches the dropdown, then its ⓘ.
 * Non-vacuity: check 1 is re-run against a synthesized drawer.js that re-adds a
 * click-to-write handler on the row (served through Playwright routing, never on
 * disk) and must go red.
 *
 * The model catalog is the machine's REAL cached CLI list (models.json from the
 * live data dir, copied read-only into the scratch data dir); when absent the
 * suite says so and runs on the alias fallback.
 *
 * Isolation: its own server on an OS-assigned port, CLAUDE_STATION_DATA and
 * CLAUDE_PROJECTS_DIR in a scratch dir, built through isolatedServerEnv; killed
 * by PID. Brave headless via Playwright (no browser download).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from 'playwright';
import { isolatedServerEnv, sharedDataDir } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAVE = process.env.QA_BRAVE_PATH ?? '/usr/bin/brave';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const SCR = fs.mkdtempSync(path.join(os.tmpdir(), 'feat159-'));
const DATA = path.join(SCR, 'data'), WORK = path.join(SCR, 'work'), STORE = path.join(SCR, 'store');
for (const d of [DATA, WORK, STORE]) fs.mkdirSync(d, { recursive: true });
let realCatalog = false;
for (const f of ['models.json', 'models-openai.json']) {
  const src = path.join(sharedDataDir(), f);
  if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(DATA, f)); if (f === 'models.json') realCatalog = true; }
}
console.log(realCatalog ? 'model catalog: the machine\'s real cached CLI list' : 'model catalog: NONE cached — running on the alias fallback (synthetic)');

const env = isolatedServerEnv({ PORT: String(port), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE });
const server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d; });
const BASE = `http://127.0.0.1:${port}`;
const j = async (u, method = 'GET', body) => {
  const r = await fetch(BASE + u, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const t = await r.json();
  if (!r.ok) throw new Error(`${method} ${u}: ${JSON.stringify(t)}`);
  return t;
};
const stored = async (pid) => (await j(`/api/projects/${pid}`)).project.settings ?? {};

let browser;
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error(`scratch server never became healthy\n${serverErr.slice(-1500)}`);

  const pid = (await j('/api/projects', 'POST', { hostPath: WORK, name: 'feat159-controls' })).project.id;
  await j(`/api/projects/${pid}`, 'PATCH', { isolation: 'direct' });
  await j('/api/settings', 'PATCH', { model: 'claude-opus-5-5', effort: 'high' });

  browser = await chromium.launch({ headless: true, executablePath: BRAVE });

  async function boot(page) {
    await page.goto(`${BASE}/#/project/${pid}`);
    await page.waitForFunction((p) => window.__station?.state?.current?.projectId === p, pid);
    await page.evaluate(() => window.__station.drawer.open('settings'));
    await page.click('#sRail-model');
    await page.waitForSelector('#sel-model');
  }
  const modelRow = (page) => page.locator('#vSettings .set[data-field="model"]');

  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await boot(page);

  /* 1 — the regression: clicking the row itself writes nothing. */
  console.log('\n=== 1. a row click writes nothing ===');
  const before1 = await stored(pid);
  for (const f of ['model', 'effort', 'permissionMode']) {
    if (f === 'permissionMode') await page.click('#sRail-permissions');
    else await page.click('#sRail-model');
    await page.locator(`#vSettings .set[data-field="${f}"] .l`).click();
    await sleep(250);
  }
  await page.click('#sRail-model');
  const after1 = await stored(pid);
  check('clicking the Model / Effort / Permission mode labels leaves the registry unchanged',
    JSON.stringify(before1) === JSON.stringify(after1), { before: before1, after: after1 });
  check('no row in the pane is a button or carries data-cycle',
    await page.evaluate(() => document.querySelectorAll('#vSettings .set[data-cycle], #vSettings button.set, #vSettings .set-main').length === 0), 'count 0');

  /* 2 — dropdown sets a catalog model and clears it. */
  console.log('\n=== 2. Model dropdown: catalog pick and clear ===');
  const opts = await page.$$eval('#sel-model option', (os) => os.map((o) => ({ v: o.value, t: o.textContent })));
  check('the unset option names the machine default it falls back to',
    /^Use machine default \(.+\)$/.test(opts[0]?.t ?? '') && opts[0].v === '__inherit__', opts[0]);
  check('the dropdown ends with a Custom model id option', opts.at(-1)?.t === 'Custom model id…', opts.at(-1));
  const catalogOpt = opts.find((o) => /^v\d+$/.test(o.v));
  check('the dropdown offers at least one catalog model', !!catalogOpt, opts.map((o) => o.t));
  await page.selectOption('#sel-model', catalogOpt.v);
  await page.waitForFunction(() => document.querySelector('#vSettings .set[data-field="model"] .prov')?.dataset.level === 'project');
  const picked = (await stored(pid)).model;
  const catalogValues = realCatalog ? JSON.parse(fs.readFileSync(path.join(DATA, 'models.json'), 'utf8')).map((m) => m.value) : ['opus', 'sonnet', 'haiku'];
  check('the pick is stored on the server, as a value from the catalog', picked === catalogValues[Number(catalogOpt.v.slice(1))], { picked, option: catalogOpt.t });
  check('the chip turns filled `project` with a reset beside it',
    await modelRow(page).evaluate((r) => r.querySelector('.prov')?.dataset.fill === 'true' && !!r.querySelector('.rev')), 'filled + ↩');
  await page.selectOption('#sel-model', '__inherit__');
  await page.waitForFunction(() => document.querySelector('#vSettings .set[data-field="model"] .prov')?.dataset.fill === 'false');
  check('"Machine default" clears the project model to null', (await stored(pid)).model == null, (await stored(pid)).model ?? null);

  /* 3 — custom model id round-trip. */
  console.log('\n=== 3. custom model id round-trip ===');
  await page.selectOption('#sel-model', '__custom__');
  await page.waitForSelector('#cust-model');
  check('choosing Custom opens a free-text field and focuses it',
    await page.evaluate(() => document.activeElement?.id === 'cust-model'), await page.evaluate(() => document.activeElement?.id));
  check('opening the editor writes nothing', (await stored(pid)).model == null, (await stored(pid)).model ?? null);
  await page.fill('#cust-model', 'bad id!');
  await page.keyboard.press('Enter');
  await sleep(300);
  const errText = await page.locator('#vSettings .set[data-field="model"] .set-edit-err').textContent();
  check('Save is disabled while the typed id is malformed',
    await page.locator('#vSettings .set[data-field="model"] .set-edit-acts .primary').isDisabled(), 'disabled');
  check('a malformed id is refused in place with a reason, nothing written',
    /Letters, digits/.test(errText ?? '') && (await stored(pid)).model == null, { errText, stored: (await stored(pid)).model ?? null });
  await page.fill('#cust-model', 'claude-opus-4-8');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#cust-model'));
  check('a valid custom id is stored on the server', (await stored(pid)).model === 'claude-opus-4-8', (await stored(pid)).model);
  await page.reload();
  await boot(page);
  const sel3 = await page.$eval('#sel-model', (s) => ({ v: s.value, t: s.selectedOptions[0]?.textContent }));
  check('after a full reload the dropdown shows the custom id as its selection',
    sel3.v === 'stored' && sel3.t === 'claude-opus-4-8 (custom)', sel3);
  await page.selectOption('#sel-model', '__custom__');
  await page.waitForSelector('#cust-model');
  check('re-opening Custom pre-fills the stored id for editing', (await page.inputValue('#cust-model')) === 'claude-opus-4-8', await page.inputValue('#cust-model'));

  /* 4 — Esc cancels. */
  console.log('\n=== 4. Esc cancels the editor ===');
  await page.fill('#cust-model', 'claude-something-else');
  await page.focus('#cust-model');
  await page.keyboard.press('Escape');
  await sleep(300);
  const esc = await page.evaluate(() => ({ editor: !!document.querySelector('#cust-model'), open: !document.querySelector('#smodal').hidden, focus: document.activeElement?.id }));
  check('Esc closes the editor, keeps the modal open, returns focus to the dropdown',
    !esc.editor && esc.open && esc.focus === 'sel-model', esc);
  check('Esc wrote nothing', (await stored(pid)).model === 'claude-opus-4-8', (await stored(pid)).model);
  await page.selectOption('#sel-model', '__inherit__');
  await page.waitForFunction(() => document.querySelector('#vSettings .set[data-field="model"] .prov')?.dataset.fill === 'false');

  /* 5 — the other controls keep their stored values. */
  console.log('\n=== 5. Effort / Permission mode / Spend cap ===');
  const effOpts = await page.$$eval('#sel-effort option', (os) => os.map((o) => o.textContent));
  await page.selectOption('#sel-effort', { label: 'Extra high' });
  await page.waitForFunction(() => document.querySelector('#vSettings .set[data-field="effort"] .prov')?.dataset.fill === 'true');
  check('Effort "Extra high" stores the same value as before: xhigh', (await stored(pid)).effort === 'xhigh', { stored: (await stored(pid)).effort, options: effOpts });
  await page.fill('#num-maxBudgetUsd', '12.5');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#num-maxBudgetUsd')?.value === '12.5' && document.querySelector('#vSettings .set[data-field="maxBudgetUsd"] .prov'));
  check('Spend cap stores a number', (await stored(pid)).maxBudgetUsd === 12.5, (await stored(pid)).maxBudgetUsd);
  await page.fill('#num-maxBudgetUsd', '');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#vSettings .set[data-field="maxBudgetUsd"] .prov'));
  check('clearing the Spend cap stores null (no cap)', (await stored(pid)).maxBudgetUsd == null, (await stored(pid)).maxBudgetUsd ?? null);
  await page.click('#sRail-permissions');
  await page.waitForSelector('#sel-permissionMode');
  await page.selectOption('#sel-permissionMode', { label: 'Plan only' });
  await page.waitForFunction(() => document.querySelector('#sel-permissionMode')?.selectedOptions[0]?.textContent === 'Plan only');
  await sleep(200);
  check('Permission mode "Plan only" stores the same value as before: plan', (await stored(pid)).permissionMode === 'plan', (await stored(pid)).permissionMode);
  await page.locator('#vSettings .set[data-field="permissionMode"] .rev').click();
  await page.waitForFunction(() => document.querySelector('#sel-permissionMode')?.selectedOptions[0]?.textContent === 'Ask before acting');
  check('its reset writes the built-in "default" back', (await stored(pid)).permissionMode === 'default', (await stored(pid)).permissionMode);

  /* 6 — session lens. */
  console.log('\n=== 6. session lens ===');
  await page.click('#sRail-model');
  await page.click('#dScope [data-scope="session"]');
  await page.waitForFunction(() => document.querySelector('#dScope [data-scope="session"]')?.getAttribute('aria-pressed') === 'true');
  const sOpt = await page.$eval('#sel-effort', (s) => s.options[0].textContent);
  check('under the session lens the unset option names the PROJECT value', sOpt === 'Use project value (Extra high)', sOpt);
  const regBefore = await stored(pid);
  await page.selectOption('#sel-effort', { label: 'Low' });
  await sleep(300);
  const ov = await page.evaluate(() => window.__station.state.overrides?.effort ?? null);
  check('a session pick is a session override', ov === 'low', ov);
  check('…and the registry is untouched', JSON.stringify(await stored(pid)) === JSON.stringify(regBefore), (await stored(pid)).effort);
  await page.selectOption('#sel-effort', '__inherit__');
  await sleep(300);
  check('choosing "Project value" drops the override', await page.evaluate(() => !('effort' in (window.__station.state.overrides ?? {}))), 'no override');
  await page.click('#dScope [data-scope="project"]');

  /* 7 — keyboard path. */
  console.log('\n=== 7. keyboard ===');
  await page.focus('#sel-model');
  await page.keyboard.press('Tab');
  const afterTab = await page.evaluate(() => document.activeElement?.id);
  check('Tab from the Model dropdown reaches its ⓘ', afterTab === 'whyb-model', afterTab);

  /* 8 — the container rows that were cycles too (settings only; no Docker needed). */
  console.log('\n=== 8. container rows: memory cap, GPU, repo mount point ===');
  const cWork = path.join(SCR, 'cwork');
  fs.mkdirSync(cWork);
  const cid = (await j('/api/projects', 'POST', { hostPath: cWork, name: 'feat159-container' })).project.id;
  await j(`/api/projects/${cid}`, 'PATCH', { isolation: 'container' });
  const cstored = async () => (await j(`/api/projects/${cid}`)).project.settings?.container ?? {};
  const cp = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  cp.on('pageerror', (e) => consoleErrors.push(String(e)));
  await cp.goto(`${BASE}/#/project/${cid}`);
  await cp.waitForFunction((p) => window.__station?.state?.current?.projectId === p, cid);
  await cp.evaluate(() => window.__station.drawer.open('settings'));
  await cp.click('#sRail-isolation');
  await cp.waitForSelector('#sel-container-memoryMb');
  const memOpts = await cp.$$eval('#sel-container-memoryMb option', (os) => os.map((o) => o.textContent));
  await cp.selectOption('#sel-container-memoryMb', '16384');
  await cp.waitForFunction(() => document.querySelector('#sel-container-memoryMb')?.value === '16384' && !document.querySelector('#sel-container-memoryMb option[value=""]'));
  check('Memory cap dropdown stores 16384 MiB', (await cstored()).memoryMb === 16384, { stored: (await cstored()).memoryMb, options: memOpts });
  await cp.selectOption('#sel-container-gpu', 'off');
  await cp.waitForFunction(() => document.querySelector('#sel-container-gpu')?.value === 'off');
  await sleep(300);
  check('GPU dropdown stores "off"', (await cstored()).gpu === 'off', (await cstored()).gpu);
  await cp.selectOption('#sel-container-workspaceRoot', 'root');
  await cp.waitForFunction(() => document.querySelector('#sel-container-workspaceRoot')?.value === 'root');
  await sleep(300);
  check('Repo-at dropdown stores workspaceRoot: true', (await cstored()).workspaceRoot === true, (await cstored()).workspaceRoot);

  await cp.close();

  check('zero console errors across the run', consoleErrors.length === 0, consoleErrors.slice(0, 3));

  /* Non-vacuity — a synthesized variant that restores a click-to-write row. */
  console.log('\n=== must-FAIL: a row that writes on click is caught ===');
  const src = fs.readFileSync(path.join(ROOT, 'public', 'lib', 'drawer.js'), 'utf8');
  const anchor = "    const n = el('div', { class: 'set', 'data-field': field });\n";
  if (!src.includes(anchor)) throw new Error('must-FAIL anchor not found in drawer.js — update the suite');
  const broken = src.replace(anchor, `${anchor}    if (opts.choices?.length) n.addEventListener('click', (e) => { if (e.target.closest('.l')) void put(field, opts.choices[opts.choices.length - 1].value); });\n`);
  const bad = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await bad.route('**/lib/drawer.js*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: broken }));
  await boot(bad);
  const b0 = await stored(pid);
  await bad.locator('#vSettings .set[data-field="effort"] .l').click();
  await sleep(600);
  const b1 = await stored(pid);
  check('against the synthesized click-to-write variant, check 1 goes RED (the registry changes)',
    JSON.stringify(b0) !== JSON.stringify(b1), { before: b0.effort ?? null, after: b1.effort ?? null });
  await bad.close();
} catch (err) {
  fail++;
  failures.push(`harness: ${err.message}`);
  console.log(`  FAIL  harness error: ${err.stack ?? err}`);
} finally {
  await browser?.close().catch(() => {});
  try { process.kill(server.pid, 'SIGTERM'); } catch { /* gone */ }
  await sleep(400);
  try { process.kill(server.pid, 'SIGKILL'); } catch { /* gone */ }
  fs.rmSync(SCR, { recursive: true, force: true });
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
