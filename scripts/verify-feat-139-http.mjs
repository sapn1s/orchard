/**
 * FEAT-139 — the scope spine over the REAL HTTP surface. Closes the clean-room
 * coverage gap (run 01a07dd4): "HTTP 400 responses ... were not exercised; this
 * attack invoked server modules directly." Boots an isolated scratch server on a
 * free ephemeral port (CLAUDE_STATION_DATA + CLAUDE_PROJECTS_DIR pointed at
 * throwaway dirs via isolatedServerEnv, which REFUSES to build a non-isolated
 * env) and drives the actual routes:
 *
 *   1. PATCH /api/settings with an unknown field → HTTP 400 (requirement 2, over
 *      the route — not just the validator).
 *   2. PATCH machine defaults, then POST /api/projects with NO settings → the
 *      created project's STORED config reflects the machine model/effort
 *      (requirement 3 / clean-room Defect 1, over the real creation route).
 *   3. POST /api/projects with an explicit model → the explicit value wins over
 *      the machine default (requirement 4, non-vacuous now that the default lands).
 *   4. Theme record check (requirement 7): report whether the server keeps ANY
 *      record of theme. Reported, not asserted — see note at the check.
 *
 *   node scripts/verify-feat-139-http.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat139-http-data-'));
const PROJDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat139-http-proj-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat139-http-work-'));

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function waitHealth(port, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(250);
  }
  return false;
}

let child;
async function main() {
  const port = await freePort();
  const env = isolatedServerEnv(
    { PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: PROJDIR },
    { requireStore: true },
  );
  child = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', (d) => { const s = String(d); if (/error/i.test(s)) process.stderr.write(`  [srv] ${s}`); });
  if (!(await waitHealth(port))) throw new Error(`scratch server on ${port} never became healthy`);
  const base = `http://127.0.0.1:${port}`;

  // 1. Unknown-field PATCH → HTTP 400 over the real route.
  const bad = await fetch(`${base}/api/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'haiku', notAField: 1 }),
  });
  check('unknown-field PATCH /api/settings → HTTP 400', bad.status === 400, { status: bad.status });
  // The rejection must be total — a partial write of the valid keys would be
  // worse than a clean 400.
  const afterBad = await (await fetch(`${base}/api/settings`)).json();
  check('rejected PATCH wrote NOTHING (model still null after the 400)',
    afterBad.settings.model === null, afterBad.settings);

  // 2. Set machine defaults, then create a project with NO settings.
  const setOk = await fetch(`${base}/api/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'haiku', effort: 'low', isolation: 'sandbox' }),
  });
  check('valid PATCH /api/settings → HTTP 200', setOk.status === 200, { status: setOk.status });
  const created = await (await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'feat139-http' }),
  })).json();
  const cp = created.project ?? created;
  check('POST /api/projects (no settings) STORES the machine model default (Defect 1, over HTTP)',
    cp.settings?.model === 'haiku', cp.settings?.model);
  check('POST /api/projects (no settings) STORES the machine effort default',
    cp.settings?.effort === 'low', cp.settings?.effort);
  check('POST /api/projects (no settings) STORES the machine isolation default',
    cp.isolation === 'sandbox', cp.isolation);
  // Re-read from the registry route so we prove the PERSISTED row, not the POST echo.
  const list = await (await fetch(`${base}/api/projects`)).json();
  const persisted = (list.projects ?? list ?? []).find((p) => p.id === cp.id);
  check('persisted registry row (re-read) carries the seeded model/effort',
    persisted?.settings?.model === 'haiku' && persisted?.settings?.effort === 'low',
    { model: persisted?.settings?.model, effort: persisted?.settings?.effort });

  // 3. Explicit per-project model wins over the machine default (req 4, non-vacuous).
  const work2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat139-http-work2-'));
  const created2 = await (await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: work2, name: 'feat139-http-explicit', settings: { model: 'opus' } }),
  })).json();
  const cp2 = created2.project ?? created2;
  check('explicit project model=opus overrides machine haiku over HTTP (req 4)',
    cp2.settings?.model === 'opus', cp2.settings?.model);
  try { fs.rmSync(work2, { recursive: true, force: true }); } catch { /* best effort */ }

  // 4. Theme (requirement 7): "a client-side cache is acceptable, but it must not
  //    be the only record." Now a HARD assertion — the server keeps and returns a
  //    real theme record, a valid theme PATCHes through and survives a re-read
  //    (no client involved), and an unknown theme value is rejected 400 like any
  //    other invalid field.
  const settings0 = (await (await fetch(`${base}/api/settings`)).json()).settings;
  check('GET /api/settings carries a server-side theme record (req 7 — not client-only)',
    Object.prototype.hasOwnProperty.call(settings0, 'theme'), { theme: settings0.theme });
  check('theme default is the concrete "system" (never null/missing)',
    settings0.theme === 'system', settings0.theme);
  const themeSet = await fetch(`${base}/api/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ theme: 'dark' }),
  });
  check('valid theme PATCH → HTTP 200', themeSet.status === 200, { status: themeSet.status });
  const afterTheme = (await (await fetch(`${base}/api/settings`)).json()).settings;
  check('theme survives a fresh GET from the SERVER (persisted, no client cache)',
    afterTheme.theme === 'dark', afterTheme.theme);
  const badTheme = await fetch(`${base}/api/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ theme: 'ultraviolet' }),
  });
  check('unknown theme value → HTTP 400 (strict, like any invalid field)',
    badTheme.status === 400, { status: badTheme.status });
  const afterBadTheme = (await (await fetch(`${base}/api/settings`)).json()).settings;
  check('rejected theme PATCH wrote NOTHING (still dark after the 400)',
    afterBadTheme.theme === 'dark', afterBadTheme.theme);
  // First-paint injection (req 7, flash-free): with theme=dark persisted, the
  // served index.html must carry <html ... data-theme="dark"> so the browser
  // paints dark before any script or fetch runs.
  const indexHtml = await (await fetch(`${base}/`)).text();
  check('served index.html injects the persisted theme onto <html> (flash-free first paint)',
    /<html[^>]*\sdata-theme="dark"/i.test(indexHtml), { match: /<html[^>]*data-theme="[^"]*"/i.exec(indexHtml)?.[0] ?? null });
  // And 'system' injects NOTHING (CSS default) — no stray attribute.
  await fetch(`${base}/api/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ theme: 'system' }),
  });
  const indexSystem = await (await fetch(`${base}/`)).text();
  check("theme=system injects NO data-theme (CSS default, matches client applyTheme)",
    !/<html[^>]*\sdata-theme=/i.test(indexSystem), { match: /<html[^>]*data-theme="[^"]*"/i.exec(indexSystem)?.[0] ?? null });

  console.log(`\n  ${pass} passed, ${fail} failed`);
}

try {
  await main();
} finally {
  try { if (child && child.exitCode === null) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
  for (const d of [DATA, PROJDIR, WORK]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}
process.exit(fail ? 1 : 0);
