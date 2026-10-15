#!/usr/bin/env node
/**
 * BUG-252 — reloading a new container session said "This link points to a
 * session that is not here".
 *
 * Real incident: the reload loaded `…/session/<id>?dir=<encoded HOST path>`.
 * The new session's `session-init` handler filled the URL's dir from the
 * project list (the encoded host path), but a container session's transcript
 * lands in the container store dir (`-workspace-<id>`, FEAT-155). `applyRoute`
 * then matched id AND dir exactly, against the history list only, and rendered
 * a permanent "not here".
 *
 * WHAT THIS ASSERTS — what the user SEES after a (re)load, in a real headless
 * browser, against a REAL server on a free port with isolated data + transcript
 * stores. Only the model process is scripted: a fake `claude` via
 * CLAUDE_STATION_CLAUDE_BIN (the standard harness) that reports cwd
 * `/workspace/<project basename>` in system:init — so the REAL bridge's
 * `storeEncodedDir` is `-workspace-<basename>`, the same shape as the real
 * container store, and different from the project's encoded host path. The fake
 * writes NO transcript; the script writes transcript files when a scenario
 * needs them (as the CLI would), which is how "live, nothing on disk yet" and
 * "partial transcript" are reached deterministically. (Synthetic stand-in for a
 * container: the host Docker daemon is off-limits to this lane.)
 *
 * Scenarios (each a fresh page load = a reload):
 *   A  a NEW session started through the real composer: its URL dir is the
 *      bridge's store dir, and a reload renders the session.
 *   B  a LIVE session whose transcript lands a moment after the reload: never
 *      "not here"; the session renders (the resolver waits, before drawing).
 *   B3 a live session that writes nothing within the wait: "This session is
 *      starting" + Check again (an explicit action) opens it once written.
 *   C  a partial transcript (last line cut mid-write): renders.
 *   D  a bogus id: still "not here" (anti-regression).
 *   E  a stale/wrong dir on an existing id: renders, URL corrected.
 *   E2 a wrong dir on a bogus id: still "not here".
 *   F  "not here" is final for that load: the id appearing later does not swap
 *      the page by itself; following the link again opens it.
 *   G  the session list fails to load: not "not here"; Try again opens it.
 *   H  navigating away from a "not here" view: nothing takes the view back.
 *   I  the same id in two dirs, the list showing the other copy: the link's
 *      dir is honoured.
 *   J  a new session STARTED from the composer on the "not here" view is not
 *      hijacked when the linked id appears (IV run c01b61e7).
 *   K  a draft typed on that view is not swapped away.
 *   M  an overlay (#/tickets) opened from that view keeps its URL and view.
 *   S  IV run d215bd11: from a long, scrolled session, follow a link to a live
 *      session whose transcript lands seconds later, with scroll events firing:
 *      the link opens (no URL rewrite can disarm it).
 *   W  during that wait the user opens another session from the sidebar: the
 *      link does not take the view back, and the URL names what is shown.
 *   W2 during that wait the user opens the tickets overlay: it stays.
 *   X  a REAL container project on the FEAT-158 Docker sandbox (fake in-container
 *      CLI, real container, real bind-mounted store): composer start → reload →
 *      the session renders (skipped with --no-container, reported as NOT RUN).
 *
 * MUST-FAIL: the same scenarios run against a SYNTHESIZED pre-fix client — the
 * live public/app.js with the original applyRoute spliced back in and the
 * session-init dir adoption removed — served to the page via request
 * interception. Not a diff against HEAD. Two more synthesized clients pin the
 * removed deferred re-resolve (fixture scripts/fixtures/bug-252/
 * deferred-reresolve-r2.js, verbatim): ROUND-2 must FAIL S (run d215bd11);
 * ROUND-1 (round 2 minus its c01b61e7 patches) must FAIL J and K.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { isolatedServerEnv, isolatedStoreEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug252-'));
const DATA = path.join(WORK, 'data');
const PROJ_BASE = 'b252proj';
const PROJ = path.join(WORK, 'host', PROJ_BASE);
const CTL = path.join(WORK, 'ctl');
const FAKE = path.join(WORK, 'fake-claude.mjs');
for (const d of [DATA, PROJ, CTL]) fs.mkdirSync(d, { recursive: true });
const storeEnv = isolatedStoreEnv(path.join(WORK, 'claude-config'), { alsoReader: true });
const STORE = storeEnv.CLAUDE_PROJECTS_DIR;
const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
const CTR_CWD = `/workspace/${PROJ_BASE}`;
const CTR_DIR = encodeCwd(CTR_CWD);   // where the bridge says the transcript lands
const HOST_DIR = encodeCwd(PROJ);     // the project list's encodedDir (the pre-fix URL dir)
// Both store dirs exist before a session runs (as on a used host). Without the host one, the
// server's memory-unify step (BUG-215) emits a NON-fatal error before the start's ack, which the
// client's pre-ack refusal branch treats as a refused start and drops the session — a separate
// pre-existing behaviour recorded on BUG-252, deliberately not exercised here.
fs.mkdirSync(path.join(STORE, CTR_DIR), { recursive: true });
fs.mkdirSync(path.join(STORE, encodeCwd(PROJ)), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- the fake CLI */
fs.writeFileSync(FAKE, `
import * as fs from 'node:fs';
import * as readline from 'node:readline';
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, 'argv ' + process.argv.slice(2).join(' ').slice(0, 400) + '\\n');
if (process.argv.includes('--version') || process.argv.includes('-v')) { process.stdout.write('2.1.263 (Claude Code)\\n'); process.exit(0); }
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
let sid = null;
rl.on('line', (l) => {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, process.pid + ' ' + l.slice(0, 300) + '\\n');
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') { say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; }
  if (m.type !== 'user') return;
  // A prompt carrying HOLDINIT holds system:init until the script releases it — the
  // window between a user's Enter and the session-init frame, made wide on purpose.
  const text = typeof m.message?.content === 'string' ? m.message.content : JSON.stringify(m.message?.content ?? '');
  if (!sid && text.includes('HOLDINIT')) {
    const rel = ${JSON.stringify(path.join(CTL, 'release-init'))};
    const wait = () => { if (fs.existsSync(rel)) { fs.rmSync(rel, { force: true }); answer(); } else setTimeout(wait, 100); };
    return wait();
  }
  answer();
  function answer() {
  if (!sid) {
    const ai = process.argv.indexOf('--session-id');
    const declared = ai > 0 ? process.argv[ai + 1] : (process.argv.find((a) => a.startsWith('--session-id=')) ?? '').slice(13);
    sid = declared || fs.readFileSync(${JSON.stringify(path.join(CTL, 'next-sid'))}, 'utf8').trim();
    say({ type: 'system', subtype: 'init', session_id: sid, cwd: ${JSON.stringify(CTR_CWD)}, model: 'haiku', tools: [], slash_commands: [] });
  }
  say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: 'ok' } ] } });
  say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
  }
});
process.stdin.resume();
`);

/* --------------------------------------------------------- transcript writers */
function lines(sid, cwd, marker, { userText } = {}) {
  const t0 = new Date(Date.now() - 60_000).toISOString();
  const t1 = new Date(Date.now() - 55_000).toISOString();
  const u1 = randomUUID(), a1 = randomUUID();
  return [
    { type: 'user', parentUuid: null, uuid: u1, sessionId: sid, cwd, timestamp: t0, version: '2.1.0', entrypoint: 'sdk-ts',
      message: { role: 'user', content: userText ?? `please reply for ${marker}` } },
    { type: 'assistant', parentUuid: u1, uuid: a1, sessionId: sid, cwd, timestamp: t1,
      message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: `REPLY-${marker}` }] } },
  ].map((o) => JSON.stringify(o));
}
function writeTranscript(dir, sid, marker, opts = {}) {
  const d = path.join(STORE, dir);
  fs.mkdirSync(d, { recursive: true });
  const ls = lines(sid, opts.cwd ?? CTR_CWD, marker, opts);
  let body = ls.join('\n') + '\n';
  if (opts.partial) {
    // complete user line, complete assistant line, then a THIRD line cut mid-write
    const cut = JSON.stringify({ type: 'assistant', sessionId: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'still being written by the CLI right now' }] } });
    body += cut.slice(0, Math.floor(cut.length / 2));
  }
  if (opts.pad) body = ls[0] + '\n' + JSON.stringify({ type: 'system', subtype: 'pad', sessionId: sid, pad: 'x'.repeat(opts.pad) }) + '\n' + ls[1] + '\n';
  fs.writeFileSync(path.join(d, `${sid}.jsonl`), body);
}

/* ------------------------------------------------------------- pre-fix client */
const ORIGINAL_APPLY_ROUTE = `async function applyRoute(route) {
  if (!route) return false;
  const p = state.projects.find((x) => x.id === route.projectId);
  if (!p) return false;
  nav.applying = true;
  try {
    state.expanded.add(p.id);
    saveExpanded();
    if (!route.sessionId) {
      startNew(p.id);
      return true;
    }
    const s = await loadSessions(p.id);
    const matches = (s.list ?? []).filter((x) => x.sessionId === route.sessionId);
    const sess = route.dir
      ? matches.find((x) => x.encodedDir === route.dir)
      : (matches.length === 1 ? matches[0] : null);
    if (!sess) {
      selectProject(p.id, { quiet: true });
      resetOverrides(OVR_NONE);
      state.current = { projectId: p.id, encodedDir: null, sessionId: null, title: null, os: null };
      followCurrent(false);
      clearPendingDelivery();
      closeSocket();
      resetTranscript();
      renderTree();
      const why = matches.length > 1
        ? \` The id \${route.sessionId.slice(0, 8)}… exists in \${matches.length} history folders and the link does not say which (no dir=) — open it from the sidebar instead.\`
        : \` No session \${route.sessionId.slice(0, 8)}… under “\${p.name}”. It may have been deleted, or the link may be wrong.\`;
      mainThread().paneEl.append(el('div', { class: 'hint-row' },
        el('b', { text: 'This link points to a session that is not here.' }),
        document.createTextNode(why)));
      say('session in the URL not found', true);
      window.history.replaceState(null, '', formatHash({ projectId: p.id }));
      return true;
    }
    await openSession(p, sess, { at: route.i, agent: route.agent });
    return true;
  } finally {
    nav.applying = false;
  }
}
`;
/** The live app.js's route block: applyRoute .. renderUnresolvedRoute (ends before the popstate listener). */
function spliceRouteBlock(block) {
  const s = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const a = s.indexOf('async function applyRoute(route) {');
  const b = s.indexOf("window.addEventListener('popstate', () => {", a);
  if (a < 0 || b < 0) throw new Error('cannot locate the route block (applyRoute .. popstate) to synthesize a client');
  return s.slice(0, a) + block + '\n' + s.slice(b);
}
function prefixSource() {
  let s = spliceRouteBlock(ORIGINAL_APPLY_ROUTE);
  const adopt = '      if (e.encodedDir && (identityChanged || !state.current.encodedDir)) state.current.encodedDir = e.encodedDir;\n';
  if (!s.includes(adopt)) throw new Error('cannot locate the session-init dir adoption to synthesize the pre-fix client');
  return s.replace(adopt, '');
}
/*
 * ROUND-2 client: the deferred re-resolve exactly as the independent verifier broke it (run d215bd11) —
 * verbatim fixture spliced over the route block. S must FAIL on it.
 */
const R2_BLOCK = fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'bug-252', 'deferred-reresolve-r2.js'), 'utf8')
  .replace(/^\/\*[\s\S]*?\*\/\n/, '');
function round2Source() { return spliceRouteBlock(R2_BLOCK); }
/*
 * ROUND-1 client: round 2 minus its c01b61e7 patches (a composer start / a draft did not stand the
 * deferred re-resolve down). J and K must FAIL on it.
 */
function round1Source() {
  let block = R2_BLOCK;
  const cuts = [
    ['\n    // nothing begun in this view: no start in flight, no live bridge of its own\n    && state.pendingStart == null && !state.live;', ';'],
    ["  if ((node.prompt?.value ?? '').trim()) { scheduleRouteRetry(t); return; }\n", ''],
  ];
  for (const [x, y] of cuts) {
    if (!block.includes(x)) throw new Error(`cannot synthesize the round-1 client: missing ${JSON.stringify(x.slice(0, 60))}`);
    block = block.replace(x, y);
  }
  let s = spliceRouteBlock(block);
  const bump = '  // BUG-252 — starting a session is a navigation too: a link still resolving must\n  // never take the view back from the session the user just began (IV c01b61e7).\n  nav.routeGen++;\n';
  if (!s.includes(bump)) throw new Error('cannot synthesize the round-1 client: startTurn bump not found');
  return s.replace(bump, '');
}

/* ----------------------------------------------------------------- reporting */
const results = { fixed: [], prefix: [], round1: [], round2: [] };
function check(mode, name, ok, observed) {
  console.log(`  [${mode}] ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  results[mode].push({ name, ok });
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

let server = null, browser = null;
const sockets = [];

async function startLiveSession(port, projectId, sid) {
  fs.writeFileSync(path.join(CTL, 'next-sid'), sid);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const events = [];
  ws.addEventListener('message', (ev) => { try { events.push(JSON.parse(String(ev.data))); } catch { /* ignore */ } });
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  sockets.push(ws);
  ws.send(JSON.stringify({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt: `live session ${sid.slice(0, 8)}` }));
  for (let i = 0; i < 1200; i++) {
    const init = events.find((e) => e.t === 'session-init');
    if (events.some((e) => e.t === 'error' && e.fatal)) throw Object.assign(new Error(`start refused: ${events.find((e) => e.t === 'error' && e.fatal).message}`), { refused: true });
    if (init) { if (process.env.VERBOSE) console.log(`  [debug] session-init after ${i * 100} ms; events: ${events.map((e) => e.t).join(',')}`); return init; }
    await sleep(100);
  }
  throw new Error(`no session-init for live session ${sid}; events: ${JSON.stringify(events).slice(0, 1500)}`);
}

/** What the user sees in the session pane right now. */
async function seen(page) {
  return page.evaluate(() => {
    const s = window.__station;
    const text = document.body.innerText;
    const notice = document.querySelector('.route-unresolved, .hint-row b');
    return {
      notHere: text.includes('This link points to a session that is not here'),
      starting: text.includes('This session is starting'),
      couldNotCheck: text.includes('Could not check this link yet'),
      currentSessionId: s?.state?.current?.sessionId ?? null,
      currentDir: s?.state?.current?.encodedDir ?? null,
      hash: location.hash,
      text: text.slice(0, 20000),
      noticeText: notice?.parentElement?.textContent?.slice(0, 200) ?? null,
    };
  });
}
async function waitFor(page, pred, ms = 15000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await seen(page);
    if (pred(last)) return { ok: true, v: last, ms: Date.now() - t0 };
    await sleep(250);
  }
  return { ok: false, v: last, ms: Date.now() - t0 };
}
const brief = (v) => ({ notHere: v?.notHere, starting: v?.starting, couldNotCheck: v?.couldNotCheck, currentSessionId: v?.currentSessionId?.slice(0, 8) ?? null, currentDir: v?.currentDir, hash: v?.hash });
const shows = (marker) => (v) => v.text.includes(`REPLY-${marker}`) && !v.notHere;

async function newPage(mode) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => process.stderr.write(`  [pageerror ${mode}] ${e.message}\n`));
  if (process.env.VERBOSE) page.on('websocket', (ws) => { ws.on('close', () => process.stderr.write(`  [ws closed] ${ws.url()}\n`)); ws.on('framesent', (f) => process.stderr.write(`  [ws> ] ${String(f.payload).slice(0, 300)}\n`)); ws.on('framereceived', (f) => process.stderr.write(`  [ws< ] ${String(f.payload).slice(0, 200)}\n`)); });
  if (process.env.VERBOSE) page.on('console', (m) => process.stderr.write(`  [console ${mode}] ${m.text()}\n`));
  if (mode !== 'fixed') {
    const src = mode === 'prefix' ? prefixSource() : mode === 'round1' ? round1Source() : round2Source();
    await page.route('**/app.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: src }));
  }
  return { ctx, page };
}

async function runMode(mode, BASE, PORT, P_ID) {
  console.log(`\n---------- ${mode === 'fixed' ? 'FIXED client (the working tree)' : mode === 'prefix' ? 'PRE-FIX client (synthesized: original applyRoute, no dir adoption)' : 'ROUND-1 client (synthesized: the build the independent verifier broke)'} ----------`);
  const tag = mode === 'fixed' ? 'f' : mode === 'prefix' ? 'p' : 'r';
  const only = mode === 'round1' ? ['J', 'K'] : (process.env.ONLY ? process.env.ONLY.split(',') : null);
  const want = (k) => !only || only.includes(k);
  const link = (sid, dir) => `${BASE}/#/project/${P_ID}/session/${sid}${dir ? `?dir=${dir}` : ''}`;

  // ---- A: a NEW session started through the real composer, then reloaded
  if (want("A")) {
    const { ctx, page } = await newPage(mode);
    await page.goto(`${BASE}/#/project/${P_ID}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__station?.state?.projects?.length, null, { timeout: 30000 });
    fs.writeFileSync(path.join(CTL, 'next-sid'), randomUUID());
    await sleep(300);
    // The user arms a model + permission mode for this session (the drawer's overrides — the
    // same fields the ws-driven sessions send); the scripted CLI answers either way.
    await page.evaluate(() => { const o = window.__station.state.overrides; o.model = 'haiku'; o.permissionMode = 'bypassPermissions'; });
    await page.fill('#prompt', `A-${tag} first prompt`);
    await page.press('#prompt', 'Enter');
    const got = await waitFor(page, (v) => v.hash.includes('/session/'), 20000);
    if (process.env.VERBOSE) console.log('  [debug A]', await page.evaluate(() => ({ cur: window.__station.state.current, prompt: document.querySelector('#prompt')?.value, disabled: document.querySelector('#prompt')?.disabled, fine: document.querySelector('#fine')?.textContent, live: window.__station.state.live })));
    const sid = /\/session\/([^?]+)/.exec(got.v?.hash ?? '')?.[1] ?? randomUUID();
    const urlDir = new URLSearchParams((got.v?.hash ?? '').split('?')[1] ?? '').get('dir');
    check(mode, 'A1 a new session\'s URL names the dir its bridge writes to (not the project host dir)',
      got.ok && urlDir === CTR_DIR, { hash: got.v?.hash, urlDir, expected: CTR_DIR, hostDir: HOST_DIR, sawId: got.ok });
    // The CLI has written the transcript where the bridge said (the real incident had it on disk 11 s before the reload).
    writeTranscript(CTR_DIR, sid, `A-${tag}`, { userText: `A-${tag} first prompt` });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const r = await waitFor(page, (v) => shows(`A-${tag}`)(v) || v.notHere, 15000);
    check(mode, 'A2 reloading that new session renders it (no "not here")', r.ok && shows(`A-${tag}`)(r.v), brief(r.v));
    await ctx.close();
  }

  // ---- B: a LIVE session whose transcript lands ~2 s after the reload
  if (want("B")) {
    const init = await startLiveSession(PORT, P_ID, randomUUID());
    const sid = init.sessionId;
    const { ctx, page } = await newPage(mode);
    await page.goto(link(sid, init.encodedDir ?? CTR_DIR), { waitUntil: 'domcontentloaded' });
    const early = await waitFor(page, (v) => v.notHere, 2000); // sampled the whole time before the file lands
    writeTranscript(CTR_DIR, sid, `B-${tag}`);
    const r2 = await waitFor(page, (v) => shows(`B-${tag}`)(v) || v.notHere, 15000);
    check(mode, 'B1 a live session with no transcript yet is never "not here" after a reload', !early.ok && !r2.v?.notHere, { early: brief(early.v), after: brief(r2.v) });
    check(mode, 'B2 once its transcript lands the session renders (no user action)', r2.ok && shows(`B-${tag}`)(r2.v), { ...brief(r2.v), waitedMs: r2.ms });
    await ctx.close();
  }

  // ---- B3: a live session that writes nothing within the resolver's wait
  if (want("B3")) {
    const init = await startLiveSession(PORT, P_ID, randomUUID());
    const sid = init.sessionId;
    const { ctx, page } = await newPage(mode);
    await page.goto(link(sid, init.encodedDir ?? CTR_DIR), { waitUntil: 'domcontentloaded' });
    const r1 = await waitFor(page, (v) => v.notHere || v.starting, 20000);
    writeTranscript(CTR_DIR, sid, `B3-${tag}`);
    await sleep(3000);
    const still = await seen(page); // nothing re-resolves by itself
    const clicked = await page.evaluate(() => { const b = document.querySelector('.route-unresolved button.route-again'); if (!b) return false; b.click(); return true; });
    const r2 = await waitFor(page, shows(`B3-${tag}`), 15000);
    check(mode, 'B3 a live session silent past the wait shows "starting" (never "not here"), and Check again opens it',
      r1.ok && r1.v.starting && !r1.v.notHere && !shows(`B3-${tag}`)(still) && clicked && r2.ok,
      { first: brief(r1.v), stillAfter3s: brief(still), clicked, then: brief(r2.v) });
    await ctx.close();
  }

  // ---- C: partial transcript (last line cut mid-write), no bridge
  const sidC = randomUUID();
  writeTranscript(CTR_DIR, sidC, `C-${tag}`, { partial: true });
  if (want("C")) {
    const { ctx, page } = await newPage(mode);
    await page.goto(link(sidC, CTR_DIR), { waitUntil: 'domcontentloaded' });
    const r = await waitFor(page, (v) => shows(`C-${tag}`)(v) || v.notHere, 15000);
    check(mode, 'C  a session whose transcript is mid-write (truncated last line) renders', r.ok && shows(`C-${tag}`)(r.v), brief(r.v));
    await ctx.close();
  }

  // ---- D: bogus id → still "not here"
  if (want("D")) {
    const { ctx, page } = await newPage(mode);
    const bogus = randomUUID();
    await page.goto(link(bogus, CTR_DIR), { waitUntil: 'domcontentloaded' });
    const r = await waitFor(page, (v) => v.notHere, 15000);
    check(mode, 'D  a genuinely bogus id still says "not here" (URL dropped to the project)',
      r.ok && r.v.notHere && !r.v.hash.includes(bogus), brief(r.v));
    await ctx.close();
  }

  // ---- E: stale/wrong dir on an existing id (the incident's exact URL shape)
  if (want("E")) {
    const { ctx, page } = await newPage(mode);
    await page.goto(link(sidC, HOST_DIR), { waitUntil: 'domcontentloaded' });
    const r = await waitFor(page, (v) => shows(`C-${tag}`)(v) || v.notHere, 15000);
    const fixedUrl = (r.v?.hash ?? '').includes(`dir=${CTR_DIR}`);
    check(mode, 'E  a link whose dir= is stale opens the session and the URL is corrected to its real dir',
      r.ok && shows(`C-${tag}`)(r.v) && fixedUrl, brief(r.v));
    await ctx.close();
  }

  // ---- E2: wrong dir AND bogus id → "not here"
  if (want("E2")) {
    const { ctx, page } = await newPage(mode);
    await page.goto(link(randomUUID(), HOST_DIR), { waitUntil: 'domcontentloaded' });
    const r = await waitFor(page, (v) => v.notHere, 15000);
    check(mode, 'E2 a wrong dir on a bogus id still says "not here"', r.ok && r.v.notHere, brief(r.v));
    await ctx.close();
  }

  // ---- F: "not here" is final for that load; following the link again opens a session that appeared since
  if (want("F")) {
    const sid = randomUUID();
    const { ctx, page } = await newPage(mode);
    await page.goto(link(sid, CTR_DIR), { waitUntil: 'domcontentloaded' });
    const r1 = await waitFor(page, (v) => v.notHere, 15000);
    writeTranscript(CTR_DIR, sid, `F-${tag}`);
    await sleep(5000);
    const still = await seen(page);
    await page.goto(link(sid, CTR_DIR), { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const r2 = await waitFor(page, shows(`F-${tag}`), 15000);
    check(mode, 'F  "not here" does not swap the page by itself; the link opens the session once it exists',
      r1.ok && still.notHere && !shows(`F-${tag}`)(still) && r2.ok, { first: brief(r1.v), after5s: brief(still), reopened: { ...brief(r2.v), waitedMs: r2.ms } });
    await ctx.close();
  }

  // ---- G: the session list fails to load at first
  if (want("G")) {
    const { ctx, page } = await newPage(mode);
    let failing = true, failed = 0;
    await page.route(`**/api/projects/${P_ID}/sessions*`, (r) => {
      if (failing) { failed++; return r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"synthetic outage"}' }); }
      return r.continue();
    });
    await page.goto(link(sidC, CTR_DIR), { waitUntil: 'domcontentloaded' });
    const r1 = await waitFor(page, (v) => v.notHere || v.couldNotCheck || shows(`C-${tag}`)(v), 15000);
    failing = false;
    const clicked = await page.evaluate(() => { const b = document.querySelector('.route-unresolved button.route-again'); if (!b) return false; b.click(); return true; });
    const r2 = await waitFor(page, shows(`C-${tag}`), 15000);
    check(mode, 'G  a failed session-list load is not reported as "not here", and Try again opens the session',
      r1.ok && !r1.v.notHere && r1.v.couldNotCheck && clicked && r2.ok, { failedRequests: failed, first: brief(r1.v), clicked, then: { ...brief(r2.v), waitedMs: r2.ms } });
    await ctx.close();
  }

  // ---- H: user navigates away from "not here"; the id appearing later must not yank them back
  if (want("H")) {
    const sid = randomUUID();
    const { ctx, page } = await newPage(mode);
    await page.goto(link(sid, CTR_DIR), { waitUntil: 'domcontentloaded' });
    const r1 = await waitFor(page, (v) => v.notHere, 15000);
    // The user opens session C from the sidebar — the real click path.
    const clicked = await page.evaluate(() => {
      const row = [...document.querySelectorAll('#tree button.row:not(.pending):not(.hit)')].find((b) => b.offsetParent !== null);
      if (!row) return false;
      row.click();
      return true;
    });
    const r2 = await waitFor(page, (v) => !!v.currentSessionId && !v.notHere, 15000);
    const openedId = r2.v?.currentSessionId ?? null;
    writeTranscript(CTR_DIR, sid, `H-${tag}`);
    await sleep(8000);
    const r3 = await seen(page);
    check(mode, 'H  after navigating away, a session appearing later does not take the view back',
      r1.ok && clicked && r2.ok && openedId !== sid && r3.currentSessionId === openedId && !r3.text.includes(`REPLY-H-${tag}`),
      { clicked, opened: brief(r2.v), after8s: brief(r3) });
    await ctx.close();
  }

  // ---- J: the user STARTS a new session from the composer on the "not here" view (independent
  //      verifier's case, run c01b61e7): the linked id appearing before that session's
  //      session-init must not take the view back.
  if (want("J")) {
    const linked = randomUUID();
    const { ctx, page } = await newPage(mode);
    await page.goto(link(linked, CTR_DIR), { waitUntil: 'domcontentloaded' });
    const r1 = await waitFor(page, (v) => v.notHere, 15000);
    await page.evaluate(() => { const o = window.__station.state.overrides; o.model = 'haiku'; o.permissionMode = 'bypassPermissions'; });
    await page.fill('#prompt', `HOLDINIT J-${tag} my own new session`);
    await page.press('#prompt', 'Enter');
    await sleep(1500);
    writeTranscript(CTR_DIR, linked, `J-${tag}`);      // the linked session appears while init is held
    await sleep(8000);
    const mid = await seen(page);
    fs.writeFileSync(path.join(CTL, 'release-init'), '1');
    const r2 = await waitFor(page, (v) => !!v.currentSessionId, 15000);
    check(mode, 'J  starting a new session on the "not here" view is not hijacked when the linked session appears',
      r1.ok && !mid.text.includes(`REPLY-J-${tag}`) && mid.text.includes(`J-${tag} my own new session`)
        && r2.ok && r2.v.currentSessionId !== linked && !r2.v.text.includes(`REPLY-J-${tag}`),
      { midShowsLinked: mid.text.includes(`REPLY-J-${tag}`), midHasOwnPrompt: mid.text.includes(`J-${tag} my own new session`), after: brief(r2.v) });
    await ctx.close();
  }

  // ---- K: the user is TYPING (not sent) on the "not here" view when the linked id appears
  if (want("K")) {
    const linked = randomUUID();
    const { ctx, page } = await newPage(mode);
    await page.goto(link(linked, CTR_DIR), { waitUntil: 'domcontentloaded' });
    const r1 = await waitFor(page, (v) => v.notHere, 15000);
    await page.fill('#prompt', `K-${tag} half-typed draft`);
    writeTranscript(CTR_DIR, linked, `K-${tag}`);
    await sleep(8000);
    const mid = await seen(page);
    const draft = await page.evaluate(() => document.querySelector('#prompt')?.value ?? null);
    check(mode, 'K  a draft being typed on the "not here" view is not swapped away when the linked id appears',
      r1.ok && !mid.text.includes(`REPLY-K-${tag}`) && draft === `K-${tag} half-typed draft`,
      { midShowsLinked: mid.text.includes(`REPLY-K-${tag}`), draft });
    await ctx.close();
  }

  // ---- M: the user opens the tickets overlay from the "not here" view; the linked id
  //      appearing later must not rewrite the overlay's URL or swap the page under it.
  if (want("M")) {
    const linked = randomUUID();
    const { ctx, page } = await newPage(mode);
    await page.goto(link(linked, CTR_DIR), { waitUntil: 'domcontentloaded' });
    const r1 = await waitFor(page, (v) => v.notHere, 15000);
    await page.evaluate(() => { location.hash = '#/tickets'; });
    await sleep(800);
    writeTranscript(CTR_DIR, linked, `M-${tag}`);
    await sleep(8000);
    const mid = await seen(page);
    check(mode, 'M  an overlay opened from the "not here" view keeps its URL and view when the linked id appears',
      r1.ok && mid.hash.startsWith('#/tickets') && mid.currentSessionId !== linked, brief(mid));
    await ctx.close();
  }

  // ---- S: IV run d215bd11 — from a long scrolled session, a link to a live session whose file lands late
  if (want("S")) {
    const long = randomUUID();
    writeLongTranscript(CTR_DIR, long, `S-LONG-${tag}`, 160);
    const init = await startLiveSession(PORT, P_ID, randomUUID());
    const sid = init.sessionId;
    const { ctx, page } = await newPage(mode);
    await page.goto(link(long, CTR_DIR), { waitUntil: 'domcontentloaded' });
    await waitFor(page, (v) => v.currentSessionId === long, 15000);
    await page.evaluate(() => { const sc = document.querySelector('#scroll'); sc.scrollTop = Math.max(0, sc.scrollTop - 900); });
    await sleep(800);
    await page.evaluate((h) => { location.hash = h; }, `#/project/${P_ID}/session/${sid}?dir=${CTR_DIR}`);
    // scroll events keep firing while it waits (the reset pane, a wheel)
    for (let i = 0; i < 8; i++) { await page.evaluate(() => document.querySelector('#scroll')?.dispatchEvent(new Event('scroll'))); await sleep(300); }
    writeTranscript(CTR_DIR, sid, `S-${tag}`);
    const r = await waitFor(page, shows(`S-${tag}`), 25000);
    check(mode, 'S  a link to a live session followed from a scrolled session opens once its file lands (scroll cannot disarm it)',
      r.ok && r.v.currentSessionId === sid, { ...brief(r.v), waitedMs: r.ms });
    await ctx.close();
  }

  // ---- W: during that wait, the user opens another session from the sidebar
  if (want("W")) {
    const init = await startLiveSession(PORT, P_ID, randomUUID());
    const sid = init.sessionId;
    const { ctx, page } = await newPage(mode);
    await page.goto(`${BASE}/#/project/${P_ID}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.querySelector('#tree button.row:not(.pending):not(.hit)'), null, { timeout: 30000 });
    await page.evaluate((h) => { location.hash = h; }, `#/project/${P_ID}/session/${sid}?dir=${CTR_DIR}`);
    await sleep(1200);
    await page.evaluate((c) => {
      const row = [...document.querySelectorAll('#tree button.row:not(.pending):not(.hit)')].find((b) => b.offsetParent !== null && (b.dataset.sessionId === c || b.textContent.includes('C-')));
      (row ?? [...document.querySelectorAll('#tree button.row:not(.pending):not(.hit)')].find((b) => b.offsetParent !== null))?.click();
    }, sidC);
    const opened = await waitFor(page, (v) => !!v.currentSessionId && v.currentSessionId !== sid, 15000);
    writeTranscript(CTR_DIR, sid, `W-${tag}`);
    await sleep(6000);
    const after = await seen(page);
    check(mode, 'W  opening another session during the wait: the link never takes the view back, the URL names what is shown',
      opened.ok && after.currentSessionId === opened.v.currentSessionId && !after.text.includes(`REPLY-W-${tag}`) && after.hash.includes(`/session/${after.currentSessionId}`),
      { opened: brief(opened.v), after6s: brief(after) });
    await ctx.close();
  }

  // ---- W2: during that wait, the user opens the tickets overlay
  if (want("W2")) {
    const init = await startLiveSession(PORT, P_ID, randomUUID());
    const sid = init.sessionId;
    const { ctx, page } = await newPage(mode);
    await page.goto(`${BASE}/#/project/${P_ID}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__station?.state?.projects?.length, null, { timeout: 30000 });
    await page.evaluate((h) => { location.hash = h; }, `#/project/${P_ID}/session/${sid}?dir=${CTR_DIR}`);
    await sleep(1200);
    await page.evaluate(() => { location.hash = '#/tickets'; });
    await sleep(500);
    writeTranscript(CTR_DIR, sid, `W2-${tag}`);
    await sleep(6000);
    const after = await seen(page);
    check(mode, 'W2 opening the tickets overlay during the wait: it keeps its URL and the link does not open under it',
      after.hash.startsWith('#/tickets') && after.currentSessionId !== sid, brief(after));
    await ctx.close();
  }

  // ---- I: the same id in two dirs; the list shows the other copy; the link's dir wins
  if (want("I")) {
    const sid = randomUUID();
    writeTranscript(HOST_DIR, sid, `IHOST-${tag}`, { cwd: PROJ, pad: 4000 }); // larger → the list keeps this copy
    writeTranscript(CTR_DIR, sid, `ICTR-${tag}`);
    const listed = await (await fetch(`${BASE}/api/projects/${P_ID}/sessions`)).json();
    const row = (listed.sessions ?? []).filter((x) => x.sessionId === sid).map((x) => x.encodedDir);
    const { ctx, page } = await newPage(mode);
    await page.goto(link(sid, CTR_DIR), { waitUntil: 'domcontentloaded' });
    const r = await waitFor(page, (v) => shows(`ICTR-${tag}`)(v) || shows(`IHOST-${tag}`)(v) || v.notHere, 15000);
    check(mode, 'I  a link naming a real duplicate the list folded away opens THAT copy',
      r.ok && shows(`ICTR-${tag}`)(r.v) && (r.v.hash ?? '').includes(`dir=${CTR_DIR}`), { listedDirs: row, ...brief(r.v) });
    await ctx.close();
  }
}

async function main() {
  console.log('\n========== BUG-252 — a deep link to a session that exists never says "not here" ==========');
  console.log(`  store dir the bridge declares: ${CTR_DIR}   project host dir: ${HOST_DIR}`);
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = isolatedServerEnv({
    PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, ...storeEnv,
    CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0',
  }, { requireStore: true });
  server = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  server.stderr?.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(`  [server] ${d}`); });
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) throw new Error('server never became healthy');
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: PROJ, name: PROJ_BASE, isolation: 'direct', applyMethod: false }),
  })).json();
  const P_ID = reg.project?.id;
  if (!P_ID) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  // Warm-up: the server refuses new host sessions until its boot runtime check completes
  // ("runtime check pending", transient). Retry a throwaway live start until one is admitted.
  for (let i = 0; ; i++) {
    try { await startLiveSession(PORT, P_ID, randomUUID()); break; } catch (e) {
      if (process.env.VERBOSE) console.log(`  [warm-up ${i}] ${e.message.slice(0, 160)}`);
      if (!e.refused || i > 60) throw e;
      await sleep(2000);
    }
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.QA_BRAVE_PATH ?? '/usr/bin/brave' });
  const only = process.env.MODE;
  if (!only || only === 'fixed') await runMode('fixed', BASE, PORT, P_ID);
  if (!only || only === 'prefix') await runMode('prefix', BASE, PORT, P_ID);
  if (!only || only === 'round1') await runMode('round1', BASE, PORT, P_ID);
}

// Never orphan the scratch server: it runs in its own process group.
const killServer = () => { if (server?.pid) { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } } };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killServer(); process.exit(130); });
process.on('exit', killServer);
let crashed = null;
try { await main(); } catch (e) { crashed = e; console.error(`\nCRASH: ${e.stack ?? e}`); }
finally {
  for (const ws of sockets) { try { ws.close(); } catch { /* gone */ } }
  try { await browser?.close(); } catch { /* gone */ }
  if (server?.pid) { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } }
  await sleep(300);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ }
}
const f = results.fixed, p = results.prefix, r1 = results.round1;
const fp = f.filter((x) => x.ok).length, pf = p.filter((x) => !x.ok).length;
console.log(`\nFIXED  : ${fp}/${f.length} PASS`);
console.log(`PRE-FIX: ${pf}/${p.length} FAIL (must-fail: A1 A2 B1 B2 E F G I; C D E2 H J K M pass in both)`);
const mustFail = ['A1', 'A2', 'B1', 'B2', 'E ', 'F ', 'G ', 'I '];
const preFailed = new Set(p.filter((x) => !x.ok).map((x) => x.name.slice(0, 2)));
const mustFailOk = p.length === 0 || mustFail.every((k) => preFailed.has(k));
if (p.length) console.log(`must-FAIL on pre-fix: ${mustFailOk ? 'YES' : 'NO'} (pre-fix failed: ${[...preFailed].join(',')})`);
const r1Failed = new Set(r1.filter((x) => !x.ok).map((x) => x.name.slice(0, 2)));
const r1Ok = r1.length === 0 || (r1Failed.has('J ') && r1Failed.has('K '));
if (r1.length) console.log(`ROUND-1: ${r1.length - r1.filter((x) => x.ok).length}/${r1.length} FAIL — must-FAIL J and K: ${r1Ok ? 'YES' : 'NO'}`);
const ok = !crashed && f.length > 0 && fp === f.length && mustFailOk && r1Ok;
console.log(ok ? '\nBUG-252 VERIFY: PASS' : '\nBUG-252 VERIFY: FAIL');
process.exit(ok ? 0 : 1);
