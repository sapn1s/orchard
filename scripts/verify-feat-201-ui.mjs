#!/usr/bin/env node
/**
 * verify-feat-201-ui.mjs — FEAT-201: the Git-tab Manage panel offers a duration
 * picker (30m / 1h / 8h / 24h / custom) for a timed agent-git pass, so a long
 * autonomous run no longer needs re-granting every 30 min. "Until I turn it off"
 * still serves "until revoked". Driven in a REAL headless browser against an
 * isolated scratch server over a registered scratch repo, and SAVED through the
 * real POST grant route, then the stored expiry is read back through the real GET
 * route. Screenshots land in both themes. F201_NO_SHOTS=1 skips shots.
 *
 * A browser launched by THIS process on a SCRATCH server classifies as the user
 * (caller-provenance), so the grant POST succeeds — the same empirical basis as
 * verify-feat-190-ui.mjs.
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTDIR = process.env.F201_SHOTS ?? path.join(os.homedir(), '.local/state/claude-station/scratch/feat201/shots');
const SHOTS = process.env.F201_NO_SHOTS !== '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const failures = [];
const check = (name, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${obs === undefined ? '' : `\n        observed: ${typeof obs === 'string' ? obs : JSON.stringify(obs)}`}`); if (ok) pass++; else { fail++; failures.push(name); } };
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
function findChromium() {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  const cands = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : [];
  for (const d of cands) { const p = path.join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'); if (fs.existsSync(p)) return p; }
  return undefined;
}
function realGit() { for (const dir of (process.env.PATH ?? '').split(path.delimiter)) { if (!dir || dir.includes('shim')) continue; const g = path.join(dir, 'git'); try { if (fs.statSync(g).isFile()) return g; } catch { /* next */ } } return '/usr/bin/git'; }

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f201-data-'));
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f201-repo-'));
const GIT = realGit();
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'verify', GIT_AUTHOR_EMAIL: 'verify@example.invalid', GIT_COMMITTER_NAME: 'verify', GIT_COMMITTER_EMAIL: 'verify@example.invalid' };
execFileSync(GIT, ['init', '-b', 'main', REPO], { encoding: 'utf8', env: gitEnv });
fs.writeFileSync(path.join(REPO, 'README.md'), '# fixture (scratch, synthetic)\n');
execFileSync(GIT, ['-C', REPO, 'add', '-A'], { env: gitEnv });
execFileSync(GIT, ['-C', REPO, 'commit', '-m', 'initial'], { env: gitEnv });
if (SHOTS) fs.mkdirSync(OUTDIR, { recursive: true });

const PORT = await freePort(); const BASE = `http://127.0.0.1:${PORT}`;
let server = null, browser = null; const log = [];
async function boot() {
  const env = isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_STATION_NO_WA_CONSOLIDATE: '1' });
  server = spawn(process.execPath, ['src/server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => log.push(String(d))); server.stderr.on('data', (d) => log.push(String(d)));
  for (let i = 0; i < 200; i++) { try { const r = await fetch(`${BASE}/api/projects`); if (r.ok) return; } catch { /* booting */ } await sleep(150); }
  throw new Error(`server did not boot:\n${log.join('').slice(-1500)}`);
}
const j = async (m, u, body) => { const r = await fetch(BASE + u, { method: m, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }); let d; try { d = await r.json(); } catch { d = null; } return { status: r.status, d }; };

try {
  await boot();
  const r = await j('POST', '/api/projects', { hostPath: REPO, isolation: 'direct', applyMethod: false });
  const pid = r.d?.project?.id ?? r.d?.id;
  if (!pid) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.d)}`);

  browser = await chromium.launch({ executablePath: findChromium() });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 980 } })).newPage();
  const perr = []; page.on('pageerror', (e) => perr.push(String(e)));

  async function openManage() {
    const grantLoaded = page.waitForResponse((rq) => /\/git-write-grant\b/.test(rq.url()), { timeout: 30_000 });
    await page.goto(`${BASE}/#/git?project=${encodeURIComponent(pid)}`);
    await page.waitForFunction(() => document.querySelector('.git-view.open .gt-gitwrite'), null, { timeout: 30_000 });
    await grantLoaded; await sleep(150);
    await page.waitForFunction(() => { const s = document.querySelector('.gt-gw-state'); return s && s.textContent && s.textContent !== 'Agent git…'; }, null, { timeout: 30_000 });
    await page.click('.gt-gw-settings');
    await page.waitForFunction(() => { const p = document.querySelector('.gt-gw-panel'); return p && !p.hidden && p.querySelector('.gt-gw-save'); }, null, { timeout: 15_000 });
  }

  await openManage();

  // Pick the timed ("For a set time") duration mode.
  await page.click('.gt-gw-dur .gt-gw-opt[data-value="timed"]');
  await page.waitForFunction(() => document.querySelector('.gt-gw-dur-chips'), null, { timeout: 10_000 });

  const chips = await page.evaluate(() => [...document.querySelectorAll('.gt-gw-dur-chips .gt-gw-chip')].map((c) => c.textContent));
  check('the duration picker shows 30m / 1h / 8h / 24h / Custom', JSON.stringify(chips) === JSON.stringify(['30 min', '1 hour', '8 hours', '24 hours', 'Custom']), chips);

  // Choose 24 hours; the Save button should name it.
  await page.click('.gt-gw-dur-chips .gt-gw-chip >> text=24 hours');
  await sleep(100);
  const saveText24 = await page.evaluate(() => document.querySelector('.gt-gw-save')?.textContent ?? null);
  check('choosing 24 hours labels Save "Allow for 24 hours"', saveText24 === 'Allow for 24 hours', saveText24);
  const chip24on = await page.evaluate(() => document.querySelector('.gt-gw-dur-chips .gt-gw-chip:nth-child(4)')?.dataset.on);
  check('the 24-hour chip reads selected', chip24on === 'true', chip24on);

  // Custom reveals a minutes field capped at 1440.
  await page.click('.gt-gw-dur-chips .gt-gw-chip-custom');
  await page.waitForFunction(() => document.querySelector('.gt-gw-dur-min'), null, { timeout: 10_000 });
  const maxAttr = await page.evaluate(() => document.querySelector('.gt-gw-dur-min')?.getAttribute('max'));
  check('Custom reveals a minutes input capped at 1440 (24h, no silent clamp)', maxAttr === '1440', maxAttr);

  // Screenshots in BOTH themes — the machine theme is set server-side and the page reloaded, so the
  // real injected/reconciled palette renders (a DOM data-theme poke gets reverted by the app's
  // one-shot server reconcile). The selected chip's hover-contrast fix is what these verify visually.
  // Force a palette by writing <html data-theme> AFTER the panel has loaded (the app's one-shot
  // server-reconcile has already run by then; with the default 'system' theme it does not revert a
  // later poke). Verify the palette actually took (body goes dark) before capturing, so a light
  // shot can never be mislabeled dark.
  async function setTheme(themeName) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, themeName);
    const wantDark = themeName === 'dark';
    await page.waitForFunction((dark) => {
      const b = getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.map(Number) ?? [255, 255, 255];
      const lum = (b[0] + b[1] + b[2]) / 3;
      return dark ? lum < 60 : lum > 180;
    }, wantDark, { timeout: 5_000 });
  }
  async function shoot(themeName) {
    await openManage();
    await page.click('.gt-gw-dur .gt-gw-opt[data-value="timed"]');
    await page.waitForFunction(() => document.querySelector('.gt-gw-dur-chips'), null, { timeout: 10_000 });
    await page.click('.gt-gw-dur-chips .gt-gw-chip >> text=24 hours');
    await sleep(120);
    await setTheme(themeName); // verified-sticky; capture immediately, no gap for a late revert
    await page.screenshot({ path: path.join(OUTDIR, `feat201-picker-24h-${themeName}.png`) });
    await page.click('.gt-gw-dur-chips .gt-gw-chip-custom');
    await page.waitForFunction(() => document.querySelector('.gt-gw-dur-min'), null, { timeout: 10_000 });
    await sleep(80);
    await setTheme(themeName);
    await page.screenshot({ path: path.join(OUTDIR, `feat201-picker-custom-${themeName}.png`) });
  }
  if (SHOTS) { await shoot('light'); await shoot('dark'); await openManage(); await setTheme('light'); await page.click('.gt-gw-dur .gt-gw-opt[data-value="timed"]'); await page.waitForFunction(() => document.querySelector('.gt-gw-dur-chips'), null, { timeout: 10_000 }); await page.click('.gt-gw-dur-chips .gt-gw-chip >> text=24 hours'); await sleep(120); }

  // Back to 24h, SAVE through the real POST route, read the stored expiry back.
  await page.click('.gt-gw-dur-chips .gt-gw-chip >> text=24 hours');
  await sleep(100);
  const saved = [];
  const onResp = (resp) => { if (/\/git-write-grant\b/.test(resp.url()) && resp.request().method() === 'POST') saved.push(resp.status()); };
  page.on('response', onResp);
  await page.click('.gt-gw-save');
  await page.waitForFunction(() => { const b = document.querySelector('.gt-gw-save'); return !b || !/Saving/.test(b.textContent || ''); }, null, { timeout: 15_000 });
  await sleep(500); page.off('response', onResp);
  check('the grant POST succeeded (200) from the browser (user caller on scratch server)', saved.length > 0 && saved.every((s) => s === 200), saved);

  const g = (await j('GET', `/api/projects/${encodeURIComponent(pid)}/git-write-grant`)).d;
  const timed = g?.timedGrant ?? g?.grant ?? null;
  const HOUR = 3600000;
  const near24h = !!timed && timed.scope === 'duration' && Math.abs((timed.expiresInMs ?? 0) - 24 * HOUR) < 60000;
  check('the STORED timed grant expires ~24h out (not clamped to 6h)', near24h, { scope: timed?.scope, expiresInMs: timed?.expiresInMs });

  // Remaining-time + early-revoke still render on the pill.
  const pill = await page.evaluate(() => ({ state: document.querySelector('.gt-gw-state')?.textContent ?? '', revokeHidden: document.querySelector('.gt-gw-revoke')?.hidden }));
  check('the pill shows time left and offers Revoke (early revoke)', /left/.test(pill.state) && pill.revokeHidden === false, pill);

  check('no uncaught page errors during the flow', perr.length === 0, perr.slice(0, 3));

  console.log(`\nFEAT-201 UI: ${pass} passed, ${fail} failed`);
  if (SHOTS) console.log(`shots: ${OUTDIR}`);
} finally {
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  try { if (server && server.pid) process.kill(server.pid); } catch { /* ignore */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(REPO, { recursive: true, force: true }); } catch { /* ignore */ }
}
if (fail) { console.log('FAILURES:\n' + failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
process.exit(0);
