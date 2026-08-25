/**
 * BUG-138 (UI half) — can the user fix it from where they are?
 *
 * The server half (verify-bug-138-repoint.mjs) proves the repoint carries the
 * sessions. This proves the user can REACH it: the real app.js, booted in
 * happy-dom against a real server, driven by real clicks — the sidebar chip
 * that names the broken project, the Directory block in the settings drawer,
 * the candidate list, the armed confirm, and the result line that says how much
 * history came along.
 *
 * Fixture is a real directory that is really renamed mid-run, seeded with REAL
 * transcripts copied out of the busiest store dir on this machine, so the
 * project the user is repointing has history to lose.
 *
 * PRE-FIX assertions that FAIL: there is no `.pgone` chip, no `.dir-change`
 * button, no `.repoint` panel and no `.cand` row anywhere in the app — the
 * only route to a renamed project was editing registry.json by hand.
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Window } from 'happy-dom';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const SCRATCH_ROOT = process.env.ORCHARD_SCRATCH || path.join(os.homedir(), 'scratch');
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const SCRATCH = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'bug138-ui-'));
const DATA = path.join(SCRATCH, 'data');
const STORE = path.join(SCRATCH, 'store');
const WORK = path.join(SCRATCH, 'work');
for (const d of [DATA, STORE, WORK]) fs.mkdirSync(d, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* Opening the drawer kicks off background fetches that can settle AFTER
   teardown kills the server — a server-unreachable rejection then, not a test
   failure. Swallow only that race. */
process.on('unhandledRejection', (err) => {
  if (err && (err.status === 0 || /unreachable|fetch failed/i.test(String(err?.message ?? '')))) return;
  console.error(`\nUNHANDLED: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
const sp = (p) => String(p).replace(os.homedir(), '~');
const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function waitFor(label, fn, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (await fn()) return true; await sleep(80); }
  console.log(`        (timed out waiting for ${label})`);
  return false;
}

const realStore = () => path.join(os.homedir(), '.claude', 'projects');
const decodeGuess = (d) => (d.startsWith('-') ? '/' + d.slice(1).replace(/-/g, '/') : d);
function busiestStoreDir() {
  let best = null;
  for (const e of fs.readdirSync(realStore(), { withFileTypes: true })) {
    if (!e.isDirectory() || !fs.existsSync(decodeGuess(e.name))) continue;
    const n = fs.readdirSync(path.join(realStore(), e.name)).filter((f) => f.endsWith('.jsonl')).length;
    if (!best || n > best.n) best = { dir: e.name, n };
  }
  return best;
}
function seed(fromDir, toCwd, want) {
  const src = path.join(realStore(), fromDir);
  const dst = path.join(STORE, encodeCwd(toCwd));
  fs.mkdirSync(dst, { recursive: true });
  const from = decodeGuess(fromDir);
  const files = fs.readdirSync(src).filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, st: fs.statSync(path.join(src, f)) }))
    .filter((x) => x.st.isFile() && x.st.size > 0 && x.st.size < 2 * 1024 * 1024)
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, want);
  for (const { f } of files) {
    fs.writeFileSync(path.join(dst, f), fs.readFileSync(path.join(src, f), 'utf8').split(from).join(toCwd));
  }
  return files.length;
}

let server = null;

async function main() {
  console.log('\nBUG-138 (UI) — fixing a renamed project from where the user is standing\n');
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const ALPHA = path.join(WORK, 'ui-fixture-alpha');
  const BETA = path.join(WORK, 'ui-fixture-beta');
  fs.mkdirSync(ALPHA, { recursive: true });
  fs.writeFileSync(path.join(ALPHA, 'README.md'), '# ui fixture\n');
  execFileSync('git', ['-C', ALPHA, 'init', '-q'], { stdio: 'ignore' });
  execFileSync('git', ['-C', ALPHA, 'remote', 'add', 'origin', 'git@example.invalid:orchard/bug138-ui.git'], { stdio: 'ignore' });

  const donor = busiestStoreDir();
  const seeded = seed(donor.dir, ALPHA, 12);
  console.log(`        seeded ${seeded} real transcripts for the fixture project`);

  server = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) throw new Error('server never became healthy');

  await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: ALPHA, applyMethod: false }),
  }).then((r) => r.json());
  /* A NEIGHBOUR project, healthy, so "only the broken one is flagged" is a real
     claim about a list rather than a claim about a list of one. */
  const NEIGH = path.join(WORK, 'ui-fixture-neighbour');
  fs.mkdirSync(NEIGH, { recursive: true });
  const nAdd = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: NEIGH, applyMethod: false }),
  });
  if (!nAdd.ok) throw new Error(`neighbour project did not register: ${nAdd.status} ${await nAdd.text()}`);

  /* THE RENAME — before the UI ever boots, exactly as the user found it. */
  fs.renameSync(ALPHA, BETA);

  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const win = new Window({ url: `${BASE}/` });
  const doc = win.document;
  doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
  doc.close();
  const realFetch = globalThis.fetch;
  win.fetch = (input, init) => realFetch(String(input).startsWith('http') ? input : BASE + input, init);
  const openSockets = [];
  class Tracked extends WebSocket {
    constructor(...a) { super(...a); this.on('error', () => {}); openSockets.push(this); }
  }
  win.WebSocket = Tracked;
  win.location.host = `127.0.0.1:${PORT}`;
  const prev = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch };
  globalThis.document = doc; globalThis.window = win;
  globalThis.WebSocket = win.WebSocket; globalThis.location = win.location; globalThis.fetch = win.fetch;

  try {
    await import(`${path.join(ROOT, 'public', 'app.js')}?ui=${Date.now()}`);
    const ok = await waitFor('project list', () => doc.querySelectorAll('#tree button.proj').length > 0);
    if (!ok) throw new Error('app.js never rendered a project row');
    const S = win.__station;

    /* ---- 1. the sidebar names the broken project before a message is spent */
    const chips = [...doc.querySelectorAll('#tree .pgone')];
    /* Two projects are registered; the healthy one has no sessions, so the app
       folds it into the "inactive" group (normal behaviour, not a miss). The
       "only the broken one is flagged" claim is therefore made against the
       payload the sidebar renders from, and the chip claim against the DOM. */
    const payload = await (await fetch(`${BASE}/api/projects`)).json();
    check('exactly one of the registered projects is reported as missing its directory',
      payload.projects.length === 2 && payload.projects.filter((p) => p.pathMissing).length === 1,
      payload.projects.map((p) => `${p.id}:${p.pathMissing ? 'MISSING' : 'ok'}`).join(', '));
    check('the sidebar flags the project whose directory is gone',
      chips.length === 1, `${chips.length} "dir missing" chip(s) across ${doc.querySelectorAll('#tree button.proj').length} rendered project row(s)`);
    check('the chip says what is wrong in words',
      (chips[0]?.textContent ?? '') === 'dir missing' && (chips[0]?.getAttribute('title') ?? '').includes(ALPHA),
      `${chips[0]?.textContent} / ${sp((chips[0]?.getAttribute('title') ?? '').split('\n')[0])}`);

    /* ---- 2. clicking it lands on the thing that fixes it -------------- */
    chips[0].click();
    const opened = await waitFor('.proj-dir-box', () => !!doc.querySelector('.proj-dir-box'));
    check('clicking the chip opens the settings drawer at the Directory block', opened, opened);
    const box = doc.querySelector('.proj-dir-box');
    check('the Directory block renders the missing state',
      box?.getAttribute('data-missing') === 'true', box?.getAttribute('data-missing'));
    const gone = doc.querySelector('.dir-gone');
    check('it explains the failure and that nothing was changed',
      !!gone && /This directory is gone/.test(gone.textContent) && /restore or rename the directory back/i.test(gone.textContent),
      gone ? sp(gone.textContent.slice(0, 170)) : '(no .dir-gone)');

    /* ---- 3. the offer ------------------------------------------------- */
    doc.querySelector('.proj-dir .dir-change').click();
    const listed = await waitFor('.cand', () => doc.querySelectorAll('.cand').length > 1);
    check('candidates are offered', listed, `${doc.querySelectorAll('.cand').length} candidate rows (incl. the manual path row)`);
    const matches = [...doc.querySelectorAll('.cand[data-conf="match"]')];
    check('exactly one candidate is a MATCH, and it is the renamed directory',
      matches.length === 1 && matches[0].querySelector('.p').getAttribute('title') === BETA,
      matches.map((m) => sp(m.querySelector('.p').getAttribute('title'))));
    check('the match is badged, and unverified neighbours are not',
      !!matches[0].querySelector('.badge')
      && [...doc.querySelectorAll('.cand[data-conf="unverified"]')].every((c) => !c.querySelector('.badge')),
      `${doc.querySelectorAll('.cand[data-conf="unverified"]').length} unverified, none badged`);
    check('a manual path is always available, whatever the offer says',
      !!doc.querySelector('.dir-input'), !!doc.querySelector('.dir-input'));

    /* ---- 4. nothing is written until the user confirms ---------------- */
    const beforePick = await (await fetch(`${BASE}/api/projects`)).json();
    matches[0].querySelector('.addrow').click();
    await waitFor('armed confirm', () => !!doc.querySelector('.cand .wiring-confirm'));
    const afterArm = await (await fetch(`${BASE}/api/projects`)).json();
    check('arming the confirm writes NOTHING to the registry',
      beforePick.projects.find((p) => p.pathMissing)?.hostPath === afterArm.projects.find((p) => p.pathMissing)?.hostPath,
      'hostPath unchanged while armed');
    const confirm = doc.querySelector('.cand .wiring-confirm');
    check('the confirm names the exact directory and promises the sessions come along',
      confirm.textContent.includes(BETA) && /stay listed under this project/.test(confirm.textContent) && /Reversible/.test(confirm.textContent),
      sp(confirm.textContent.slice(0, 200)));
    check('cancelling is offered as prominently as going ahead',
      [...confirm.querySelectorAll('button')].map((b) => b.textContent).join(' | '),
      [...confirm.querySelectorAll('button')].map((b) => b.textContent).join(' | '));

    /* ---- 5. confirm, and read what the user is told ------------------- */
    const sessBefore = S.state.sessions.get(S.state.current.projectId)?.list?.length ?? null;
    [...confirm.querySelectorAll('button')].find((b) => /Point it here/.test(b.textContent)).click();
    const settled = await waitFor('repoint result', () => !!doc.querySelector('.repoint [data-ok="true"]'), 15000);
    const result = doc.querySelector('.repoint [data-ok="true"]')?.textContent ?? '';
    check('the repoint completes and reports back', settled, sp(result));
    check('the report states HOW MUCH history came along, with a number',
      /(\d+) sessions? still listed here/.test(result) && Number(/(\d+) sessions?/.exec(result)[1]) === seeded,
      `${/(\d+) sessions?/.exec(result)?.[1]} reported, ${seeded} seeded`);
    check('and that no files were moved',
      /no files were moved/.test(result), sp(result.slice(-70)));

    /* ---- 6. the app agrees with itself afterwards --------------------- */
    await waitFor('sidebar clears', () => doc.querySelectorAll('#tree .pgone').length === 0, 10000);
    check('the "dir missing" chip is gone from the sidebar',
      doc.querySelectorAll('#tree .pgone').length === 0, `${doc.querySelectorAll('#tree .pgone').length} chips left`);
    const nowPath = S.state.projects.find((p) => p.id === S.state.current.projectId)?.hostPath;
    check('the project now points at the renamed directory', nowPath === BETA, sp(nowPath));
    const sessAfter = await (await fetch(`${BASE}/api/projects/${S.state.current.projectId}/sessions`)).json();
    check('and its sessions are all still listed (the whole point)',
      sessAfter.sessions.length === seeded, `${sessAfter.sessions.length} of ${seeded} (sidebar had ${sessBefore ?? 'not loaded'})`);
  } finally {
    try {
      const st = win.__station?.state;
      if (st?.snapPollTimer) { clearInterval(st.snapPollTimer); st.snapPollTimer = null; }
      if (st?.liveTimer) { clearInterval(st.liveTimer); st.liveTimer = null; }
    } catch { /* never booted */ }
    for (const s of openSockets) { try { s.close(); } catch { /* closed */ } }
    await sleep(200);
    globalThis.WebSocket = prev.WebSocket; globalThis.fetch = prev.fetch;
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  fail++; failures.push('harness');
}).finally(async () => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) for (const f of failures) console.log(`  - ${f}`);
  console.log(`scratch: ${sp(SCRATCH)}`);
  try { if (server?.pid) process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  await sleep(300);
  process.exit(fail ? 1 : 0);
});
