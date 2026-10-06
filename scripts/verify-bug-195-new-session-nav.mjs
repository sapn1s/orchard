/**
 * BUG-195 — a brand-new session is missing from the sidebar nav list until you
 * reload, because the derived pending-new row vanishes the instant `session-init`
 * sets state.current.sessionId, while the REAL row is not fetched into s.list
 * until turn-end (or a reload).
 *
 * Fix (public/app.js, `case 'session-init'`): fire the same
 * refreshCurrentProjectSessions() that turn-end already fires, so the just-started
 * session's row is fetched and shown the moment its first message creates it.
 *
 * USER-OBSERVABLE verification, real browser (Playwright headless) against a REAL
 * server on a free port, isolated data + transcript stores (never the user's):
 *   - Register a brand-new project (empty store — no sessions yet).
 *   - Boot the page; startNew(P) → the pending-new row is the only row (setup).
 *   - Simulate the user SENDING the first message: the CLI writes the transcript
 *     file + session-provenance record on disk (done here from node), then the
 *     server emits `session-init`.
 *   - MUST-FAIL (synthesized pre-fix): set current.sessionId to the new id and
 *     re-render WITHOUT the refetch (exactly what pre-fix session-init did). The
 *     pending row is gone AND the real row is not in s.list → ZERO rows for the
 *     new session, even though its transcript already exists on disk.
 *   - FIXED path: drive the REAL onEvent({t:'session-init',…}). Its
 *     refreshCurrentProjectSessions() refetches s.list and the real row appears —
 *     no reload — as the open/always-visible row.
 *
 * The must-FAIL baseline is a CONSTRUCTED pre-fix render (set id + renderTree, no
 * refetch), not a moving reference: it is anchored to a fixed broken variant, and
 * it is non-vacuous because the file is already on disk in BOTH renders — the only
 * thing that differs is whether the fixed handler refetches the list.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug195-data-'));      // station data (provenance lives here)
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug195-store-'));    // isolated transcript store (NOT ~/.claude)
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug195-proj-'));      // the new project's host dir
const PROJ_NAME = `bug195proj${Date.now().toString(36)}`;
const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
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

let server = null, browser = null;

async function main() {
  console.log('\n========== BUG-195 — a new session appears in the nav the moment it is created (no reload) ==========');
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;

  server = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) throw new Error('server never became healthy');

  // Register the brand-new project (empty store — no sessions yet).
  const reg = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: PROJ, name: PROJ_NAME, applyMethod: false }),
  });
  if (!reg.ok) throw new Error(`could not register project: ${await reg.text()}`);
  const P_ID = (await reg.json()).project.id;

  const pre = await (await fetch(`${BASE}/api/projects/${P_ID}/sessions`)).json();
  check('precondition: the new project starts with ZERO listed sessions', (pre.sessions ?? []).length === 0,
    `${(pre.sessions ?? []).length} session(s)`);

  // ---- boot the REAL page in a real headless browser
  // Reuse the system Brave (same idiom as playwright.config.ts) — never download a browser.
  browser = await chromium.launch({ headless: true, executablePath: process.env.QA_BRAVE_PATH ?? '/usr/bin/brave' });
  const page = await browser.newPage();
  const NEW_ID = randomUUID();
  page.on('pageerror', (e) => process.stderr.write(`  [pageerror] ${e.message}\n`));
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

  // The app booted and rendered our project row.
  await page.waitForFunction((name) => {
    const s = window.__station;
    if (!s) return false;
    return [...document.querySelectorAll('#tree button.proj')].some(
      (n) => (n.querySelector('.nm')?.textContent || '').trim() === name);
  }, PROJ_NAME, { timeout: 30000 });

  // Selector helpers evaluated in the page: rows inside OUR project's group.
  const rowCounts = async () => page.evaluate((pid) => {
    const s = window.__station;
    const group = document.querySelector(`#tree .pgroup[data-pid="${pid}"]`)
      || [...document.querySelectorAll('#tree button.proj')]
          .map((h) => h.closest('.pgroup') || h.parentElement).find(Boolean);
    const kids = group?.querySelector('.kids') || group;
    const real = [...(kids?.querySelectorAll('button.row:not(.pending)') || [])];
    const pend = [...(kids?.querySelectorAll('button.row.pending') || [])];
    return {
      real: real.length,
      pending: pend.length,
      hasNewId: real.some((r) => (r.getAttribute('data-sid') || r.dataset?.sid || '') !== '') , // placeholder
      currentSessionId: s.state.current.sessionId,
      listLen: (s.state.sessions.get(pid)?.list || []).length,
    };
  }, P_ID);

  // Step 1 — open a fresh New session in the project (the pending-new composer).
  await page.evaluate((pid) => window.__station.startNew(pid), P_ID);
  await sleep(200);
  const c1 = await rowCounts();
  check('setup: startNew shows the pending-new row and no real session rows yet',
    c1.pending === 1 && c1.real === 0 && c1.currentSessionId === null,
    `pending=${c1.pending} real=${c1.real} currentSessionId=${c1.currentSessionId}`);

  // Step 2 — the user SENDS the first message: the CLI creates the transcript file
  // AND the session-provenance record on disk. Done here from node (the server side).
  const dir = path.join(STORE, encodeCwd(PROJ));
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const lines = [
    { type: 'user', message: { role: 'user', content: 'add a /hello endpoint that returns ok' }, sessionId: NEW_ID, cwd: PROJ, timestamp: now, version: '2.1.0', entrypoint: 'sdk-ts' },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4', content: [{ type: 'text', text: 'On it.' }] }, sessionId: NEW_ID, cwd: PROJ, timestamp: now },
  ];
  fs.writeFileSync(path.join(dir, `${NEW_ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  // Dashboard sessions declare provenance at system:init (BUG-193) → startedBy 'user' → NOT folded.
  const provDir = path.join(DATA, 'session-provenance');
  fs.mkdirSync(provDir, { recursive: true });
  fs.writeFileSync(path.join(provDir, `${NEW_ID}.json`),
    JSON.stringify({ sessionId: NEW_ID, startedBy: 'user', source: 'dashboard', at: now }, null, 2) + '\n');

  // Confirm the server itself now lists the row (so this is a client-refresh bug,
  // not a server gap): a fresh GET returns it.
  const afterFile = await (await fetch(`${BASE}/api/projects/${P_ID}/sessions`)).json();
  const serverHasIt = (afterFile.sessions ?? []).some((r) => r.sessionId === NEW_ID);
  check('the SERVER lists the new session on a fresh fetch (so only the client needs to refetch)',
    serverHasIt, `server sessions=${JSON.stringify((afterFile.sessions ?? []).map((r) => r.sessionId))}`);

  // Step 3 — MUST-FAIL (synthesized pre-fix): pre-fix session-init only set the id
  // and re-rendered; it did NOT refetch s.list. Reproduce exactly that.
  await page.evaluate((args) => {
    const s = window.__station;
    s.state.current.sessionId = args.id;                 // what pre-fix session-init did
    s.state.current.encodedDir = s.state.current.encodedDir ?? null;
    s.renderTree();                                       // render WITHOUT a refetch
  }, { id: NEW_ID });
  await sleep(150);
  const cPre = await rowCounts();
  check('MUST-FAIL (pre-fix): the pending row is gone AND no real row exists → the new session is INVISIBLE despite its file being on disk',
    cPre.pending === 0 && cPre.real === 0,
    `pending=${cPre.pending} real=${cPre.real} listLen=${cPre.listLen} (file on disk, server lists it)`);

  // Step 4 — FIXED path: reset to the pending state, then drive the REAL onEvent
  // session-init. The fix's refreshCurrentProjectSessions() must bring the row in.
  await page.evaluate((pid) => {
    const s = window.__station;
    s.state.current.sessionId = null;
    s.state.current.encodedDir = null;
    s.state.pendingNew = pid;                            // back to the pending-new composer
    s.state.live = true; s.state.ws = { readyState: 1 }; // session-init runs on a live socket
    s.renderTree();
  }, P_ID);
  await sleep(100);

  await page.evaluate((args) => {
    window.__station.onEvent({ t: 'session-init', sessionId: args.id, cwd: args.cwd, model: 'claude-opus-4', tools: [] });
  }, { id: NEW_ID, cwd: PROJ });

  // Wait for the refetch to land the real row.
  const appeared = await page.waitForFunction((args) => {
    const s = window.__station;
    const list = s.state.sessions.get(args.pid)?.list || [];
    if (!list.some((r) => r.sessionId === args.id)) return false;
    const group = document.querySelector(`#tree .pgroup[data-pid="${args.pid}"]`);
    const kids = group?.querySelector('.kids');
    const rows = [...(kids?.querySelectorAll('button.row:not(.pending)') || [])];
    return rows.length >= 1;
  }, { pid: P_ID, id: NEW_ID }, { timeout: 15000 }).then(() => true).catch(() => false);

  const cPost = await rowCounts();
  check('FIXED: after the real session-init the new session has a real nav row — no reload',
    appeared && cPost.real >= 1 && cPost.currentSessionId === NEW_ID,
    `appeared=${appeared} real=${cPost.real} listLen=${cPost.listLen} currentSessionId=${cPost.currentSessionId === NEW_ID ? 'NEW_ID' : cPost.currentSessionId}`);

  // The row that appeared is genuinely the new session and is the open/always-visible one.
  const isOpenRow = await page.evaluate((args) => {
    const s = window.__station;
    const list = s.state.sessions.get(args.pid)?.list || [];
    const row = list.find((r) => r.sessionId === args.id);
    return { inList: !!row, alwaysVisible: row ? s.isAlwaysVisible(row) : false, folds: row ? s.visibleSessions(s.state.sessions.get(args.pid)).rows.some((x) => x.sessionId === args.id) : false };
  }, { pid: P_ID, id: NEW_ID });
  check('the new row is the open session and is presented by visibleSessions (not folded)',
    isOpenRow.inList && isOpenRow.alwaysVisible && isOpenRow.folds,
    JSON.stringify(isOpenRow));
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : (process.exitCode ?? 0);
  try { await browser?.close(); } catch { /* closed */ }
  try { if (server?.pid) process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  await sleep(300);
  for (const d of [DATA, STORE, PROJ]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
});
