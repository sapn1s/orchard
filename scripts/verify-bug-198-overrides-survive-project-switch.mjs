/**
 * BUG-198 — picking another project in the sidebar silently wiped the open
 * session's saved per-session overrides.
 *
 * Root cause: `selectProject()` cleared the in-memory override bag
 * (`state.overrides`) on every sidebar project change, while the session open in
 * the dock (session A) stayed A. The one writer, `persistOverrides()`, then
 * re-derived its storage key from `state.current` (still A) and wrote the now
 * empty bag over A's `cs-overrides` entry — erasing A's permissionMode (and every
 * other armed field) the next time anything persisted from the foreign view.
 *
 * The invariant graded here: a session's persisted overrides change ONLY through
 * an explicit user edit to that session. Navigation, project switches and
 * repaints never write them.
 *
 * USER-OBSERVABLE, REAL page: a REAL server on a free port (isolated data +
 * transcript stores — never the user's), a REAL headless Brave, a REAL on-disk
 * Claude transcript for session A, real clicks on the real sidebar header and the
 * real composer buttons, and a REAL page reload through the hash router.
 *
 * Busy-state (SYNTHETIC — shaped like the user's real store, which BUG-196 round 3
 * measured at 64 entries): `cs-overrides` is seeded with 40 other sessions' entries
 * (mixed fields) plus an entry for a session in project B; every one of them must
 * come out byte-identical.
 *
 *   FIXED (served tree): set plan mode on A by a real click → click project B's
 *     header → a bare persist from that view → a real explicit edit from that view
 *     (effort, via the real model popover) → reload A's URL → plan still pressed in
 *     the UI and `permissionMode:"plan"` still in localStorage, next to A's other
 *     fields and the explicit edit.
 *   CONTROL: an explicit edit on A (plan toggled OFF by a real click) DOES persist.
 *   MUST-FAIL (synthesized, anchored to fixed text, not a moving revision): the
 *     served app.js is rewritten in flight to the pre-fix shape — the clear put
 *     back into selectProject and the persist key re-derived from state.current —
 *     and the SAME scenario must report A's permissionMode lost. If the rewrite
 *     anchors are not found, the suite FAILS loudly (no vacuous pass).
 *
 *   ROUND 2 (owner is a TAGGED value — session | pending-token | none): the owner
 *     transitions (N, S1, S2, D, R, W, F — see ownerTransitions) drive the REAL
 *     composer send over the page's own WebSocket and answer the held `start` on
 *     that socket, so the ordering is forced deterministically. S1 is the round-1
 *     verifier's break verbatim. MUST-FAIL round 1: the same transitions on a
 *     synthesized ROUND-1 client (nullable owner, anchored to the round-2 text)
 *     must go red on S1, S2 and W.
 *
 * Flags: `--prefix-only` runs just the synthesized pre-fix scenario (exit 1 = it
 * reproduced the bug, as it must).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const APP_JS = path.join(ROOT, 'public', 'app.js');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug198-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug198-store-'));
const PROJ_A = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug198-a-'));
const PROJ_B = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug198-b-'));
const TAG = Date.now().toString(36);
const NAME_A = `bug198a${TAG}`;
const NAME_B = `bug198b${TAG}`;
const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
const PREFIX_ONLY = process.argv.includes('--prefix-only');

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

/*
 * The synthesized pre-fix client: the SAME served file with the BUG-198 hunks
 * reverted by exact-text rewrites. Every anchor must match exactly once, or the
 * variant is not the pre-fix code and the proof would be vacuous — so it throws.
 */
function synthesizePrefix(src) {
  const rewrites = [
    // 1. selectProject cleared the whole bag on any project change.
    ['    state.current.projectId = id;\n',
      '    state.current.projectId = id;\n    for (const k of Object.keys(state.overrides)) delete state.overrides[k];\n'],
    // 2. persistOverrides keyed its write off the VIEW (state.current), not the bag's owner.
    ['  const k = overridesOwner.kind === \'session\' ? overridesOwner.key : null; // BUG-198 round 2 — only a born session\'s bag is written\n',
      '  const k = state.current.sessionId ? `${state.current.encodedDir ?? \'\'} ${state.current.sessionId}` : null;\n'],
  ];
  let out = src;
  for (const [from, to] of rewrites) {
    const n = out.split(from).length - 1;
    if (n !== 1) throw new Error(`synthesized pre-fix: anchor matched ${n}× (need exactly 1): ${JSON.stringify(from)}`);
    out = out.replace(from, to);
  }
  return out;
}

/*
 * BUG-198 round 2 — the synthesized ROUND-1 client: the same served file with the
 * round-2 owner model collapsed back to round 1's nullable owner. Round 1's
 * `overridesOwner == null` meant "pending OR no session", adopted by ANY
 * session-init; that is exactly `kind !== 'session'` here, with no token/socket
 * binding. The frozen-bar fork did not re-own the bag, and a send did not stamp
 * one. Anchored to the round-2 text (not a moving revision); every anchor must
 * match exactly once or this throws, so the proof cannot pass vacuously.
 */
function synthesizeRound1(src) {
  const rewrites = [
    [`  const st = ovrStart;
  // A frame that did not arrive over the start's own socket (stray, injected, a
  // different socket) neither adopts nor consumes the binding.
  if (!st || !fromWs || st.ws !== fromWs) return;
  ovrStart = null;
  if (overridesOwner.kind === 'pending' && st.token === overridesOwner.token && sessionId) {
    overridesOwner = ovrSession(ovrKeyOf(encodedDir, sessionId));
  }
`, `  if (overridesOwner.kind !== 'session') overridesOwner = ovrSession(ovrKeyOf(encodedDir, sessionId));
`],
    [`  const keepArmed = { ...state.overrides };
  resetOverrides(ovrPending());
  Object.assign(state.overrides, keepArmed);
  state.forkFrom = sid;
`, `  state.forkFrom = sid;
`],
    [`  stampPendingStart(state.ws, !resumeSessionId || !!fork);
`, ''],
  ];
  let out = src;
  for (const [from, to] of rewrites) {
    const n = out.split(from).length - 1;
    if (n !== 1) throw new Error(`synthesized round-1: anchor matched ${n}× (need exactly 1): ${JSON.stringify(from.slice(0, 80))}`);
    out = out.replace(from, to);
  }
  return out;
}

/*
 * BUG-198 round 3 — non-vacuity for the new-socket cases (X1, X2, X4): a client
 * whose adoption stays bound to the FIRST socket a pending bag was sent over (the
 * binding is never re-stamped by a retry) must refuse those legitimate
 * adoptions. Anchored to the round-2 text; must match exactly once or it throws.
 */
function synthesizeFirstSocketOnly(src) {
  const from = '  ovrStart = { token: overridesOwner.token, ws };\n';
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`synthesized first-socket-only: anchor matched ${n}× (need exactly 1)`);
  return src.replace(from, '  if (!ovrStart) ovrStart = { token: overridesOwner.token, ws };\n');
}

let server = null, browser = null;

async function scenario(BASE, ids, { prefix }) {
  const { P_A, P_B, encA, SID_A, SID_B, encB } = ids;
  const KEY_A = `${encA} ${SID_A}`;
  const label = prefix ? 'PRE-FIX (synthesized)' : 'FIXED';
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => process.stderr.write(`  [pageerror] ${e.message}\n`));
  if (prefix) {
    const patched = synthesizePrefix(fs.readFileSync(APP_JS, 'utf8'));
    await page.route(/\/app\.js(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: patched }));
  }

  // Busy-state seed (SYNTHETIC, realistic shape): 40 other sessions' entries with
  // mixed fields, an entry for a session in B, and A's own entry with model+effort.
  const seed = {};
  const modes = ['bypassPermissions', 'plan', 'acceptEdits'];
  for (let i = 0; i < 40; i++) {
    const e = {};
    if (i % 2 === 0) e.permissionMode = modes[i % 3];
    if (i % 3 === 0) e.model = i % 2 ? 'sonnet' : 'opus';
    if (i % 5 === 0) e.effort = 'high';
    if (!Object.keys(e).length) e.permissionMode = 'bypassPermissions';
    seed[`-home-u-work-p${i % 7} ${randomUUID()}`] = e;
  }
  seed[`${encB} ${SID_B}`] = { permissionMode: 'bypassPermissions', model: 'sonnet' };
  seed[KEY_A] = { model: 'sonnet', effort: 'low' };
  const hashA = `#/project/${encodeURIComponent(P_A)}/session/${encodeURIComponent(SID_A)}?dir=${encodeURIComponent(encA)}`;
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => localStorage.setItem('cs-overrides', JSON.stringify(s)), seed);
  // Open A through the REAL router (a reload of A's own link).
  await page.goto(`${BASE}/${hashA}`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction((id) => window.__station?.state?.current?.sessionId === id, SID_A, { timeout: 30000 });
  await page.waitForFunction(() => !!document.querySelector('#planBtn') && !document.querySelector('#planBtn').closest('[hidden]'), null, { timeout: 15000 });
  await sleep(500);

  const readA = () => page.evaluate((key) => {
    let all = null;
    try { all = JSON.parse(localStorage.getItem('cs-overrides') ?? '{}'); } catch { all = 'UNPARSEABLE'; }
    return {
      saved: all && typeof all === 'object' ? (all[key] ?? null) : all,
      all,
      mem: { ...window.__station.state.overrides },
      planPressed: document.querySelector('#planBtn')?.getAttribute('aria-pressed'),
      cur: window.__station.state.current.sessionId,
      view: window.__station.state.current.projectId,
    };
  }, KEY_A);

  const restored = await readA();
  check(`[${label}] precondition: A reopened with its seeded overrides restored`,
    restored.cur === SID_A && restored.mem.model === 'sonnet' && restored.mem.effort === 'low', restored.mem);

  // 1. Set permissionMode on A by a REAL click on the plan toggle.
  await page.click('#planBtn');
  await sleep(200);
  const armed = await readA();
  check(`[${label}] step 1: a real click on #planBtn arms and persists plan for A (other fields kept)`,
    armed.planPressed === 'true' && armed.saved?.permissionMode === 'plan' && armed.saved?.model === 'sonnet' && armed.saved?.effort === 'low',
    { pressed: armed.planPressed, saved: armed.saved });

  // 2. Click ANOTHER project's header in the real sidebar (a bare "look at" click).
  const clicked = await page.evaluate((nm) => {
    const head = [...document.querySelectorAll('#tree button.proj')]
      .find((n) => (n.querySelector('.nm')?.textContent || '').trim() === nm);
    if (!head) return false;
    head.click();
    return true;
  }, NAME_B);
  await sleep(300);
  const foreign = await readA();
  check(`[${label}] step 2: the sidebar header click moved the view to B while A stays the dock's session`,
    clicked && foreign.view === P_B && foreign.cur === SID_A, { clicked, view: foreign.view, dockSession: foreign.cur });
  check(`[${label}] step 2: A's in-memory overrides are NOT wiped by the project click`,
    foreign.mem.permissionMode === 'plan' && foreign.mem.model === 'sonnet' && foreign.mem.effort === 'low', foreign.mem);

  // 3a. A persist from that view that is NOT an edit (a repaint / hand-off path
  // calling the one writer) must leave A's entry byte-identical.
  const beforeBare = JSON.stringify(foreign.saved);
  await page.evaluate(() => window.__station.persistOverrides());
  const bare = await readA();
  check(`[${label}] step 3a: a bare persist from the foreign view leaves A's saved entry byte-identical`,
    JSON.stringify(bare.saved) === beforeBare, { before: beforeBare, after: bare.saved });

  // 3b. An EXPLICIT edit from that view (the composer acts on the dock's session,
  // A): a real click on the model popover's effort option. The edit must land
  // under A WITH A's other fields, never as an empty-bag overwrite.
  await page.click('#modelBtn');
  await page.waitForSelector('#modelPop.open', { timeout: 5000 });
  const effortClicked = await page.evaluate(() => {
    const opt = [...document.querySelectorAll('#effortOpts .opt')]
      .find((o) => /^high$/i.test((o.querySelector('.n')?.textContent || '').trim()));
    if (!opt) return [...document.querySelectorAll('#effortOpts .opt .n')].map((n) => n.textContent);
    opt.click();
    return true;
  });
  await page.keyboard.press('Escape');
  await sleep(200);
  const edited = await readA();
  check(`[${label}] step 3b: an explicit effort edit from the foreign view persists under A, permissionMode kept`,
    effortClicked === true && edited.saved?.effort === 'high' && edited.saved?.permissionMode === 'plan' && edited.saved?.model === 'sonnet',
    { effortClicked, saved: edited.saved });

  // Nothing else in the busy store moved.
  const others = Object.keys(seed).filter((k) => k !== KEY_A);
  const drift = others.filter((k) => JSON.stringify(edited.all?.[k]) !== JSON.stringify(seed[k]));
  check(`[${label}] busy store: all ${others.length} other sessions' entries are byte-identical`,
    drift.length === 0 && Object.keys(edited.all ?? {}).length === Object.keys(seed).length, { drift: drift.length, entries: Object.keys(edited.all ?? {}).length });

  // 4. Reload A's own link (a REAL page reload through the router).
  await page.goto(`${BASE}/${hashA}`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction((id) => window.__station?.state?.current?.sessionId === id, SID_A, { timeout: 30000 });
  await sleep(500);
  const back = await readA();
  // 5. permissionMode intact in the UI AND in localStorage.
  check(`[${label}] step 5: after reload A's plan mode is still ON in the UI (#planBtn aria-pressed)`,
    back.planPressed === 'true', { planPressed: back.planPressed });
  check(`[${label}] step 5: after reload A's localStorage entry still carries permissionMode:"plan"`,
    back.saved?.permissionMode === 'plan' && back.mem.permissionMode === 'plan', { saved: back.saved, mem: back.mem });

  // CONTROL: an explicit edit ON A still persists (toggle plan OFF by a real click).
  await page.click('#planBtn');
  await sleep(200);
  const ctl = await readA();
  check(`[${label}] control: an explicit edit on A (plan OFF by real click) persists; other fields kept`,
    // plan OFF persists as no permissionMode, or an explicit 'default' on a container
    // project (setPermissionMode forces it there, since a container's default is bypass).
    ctl.planPressed === 'false' && ctl.saved && (ctl.saved.permissionMode ?? 'default') === 'default' && ctl.saved.effort === 'high' && ctl.saved.model === 'sonnet',
    { planPressed: ctl.planPressed, saved: ctl.saved });

  if (!prefix) await ownerTransitions(page, ids);
  await ctx.close();
}

/*
 * The owner mechanism's OTHER transitions. A bag that belongs to a not-yet-born
 * session must never persist under an existing session's key, must land under the
 * new id when ITS OWN session-init names it, and a bag that belongs to no session
 * (a dead link) or to an abandoned pending attempt must never be adopted by a late
 * session-init.
 *
 * BUG-198 round 2 — every session-init that is meant to adopt now arrives the way
 * the real one does: the REAL composer send (#go) emits a real `start` frame over
 * the page's own driving WebSocket, and the test answers it over THAT socket
 * (page.routeWebSocket: every frame passes through to the real server except
 * `start`, which is HELD so no engine spawns and the ordering is the test's to
 * force). A late/stale init is injected through the real dispatcher (onEvent),
 * exactly as the round-1 verifier's attack did.
 *   (N)  "+" → arm plan → real send → nothing written pre-init → init over the same
 *        socket → lands under the new id; A untouched.
 *   (S1) the round-1 BREAK, verbatim ordering: "+" (never sent) → dead link → arm
 *        plan → the abandoned "+" attempt's session-init arrives LATE → NOT
 *        attributed to that stale id (nor anywhere).
 *   (S2) pending→pending: "+" → arm → real send (start held) → "+" AGAIN → arm →
 *        the FIRST attempt's init arrives late → not adopted by the second bag;
 *        then the second attempt's own send+init lands its bag under its own id.
 *   (D)  a dead-link view is not a dead end: arm → real send → init over that
 *        socket → the bag the start carried lands under the new id.
 *   (R)  reattach / resume init naming the OPEN session's own id → A byte-identical;
 *        a stray init naming a foreign id while A is open → no entry for it.
 *   (W)  the frozen-bar fork (#forkBtn, via a real needs-fork refusal of A's
 *        resume): an edit while staged leaves A byte-identical; the fork's init
 *        lands the bag under the fork id; a LATER edit on the running fork writes
 *        under the fork id, never under A.
 *   (F)  fork staging via the REAL row menu (right-click A → Fork → pick project),
 *        same-project and cross-project: an edit while staged must not touch A's
 *        entry; the fork's send+init lands the staged bag under the fork id.
 */
async function ownerTransitions(page, ids, { tag = '' } = {}) {
  const { P_A, SID_A, encA } = ids;
  const KEY_A = `${encA} ${SID_A}`;
  const T = (s) => (tag ? `${s} [${tag}]` : s);
  const hashA = `#/project/${encodeURIComponent(P_A)}/session/${encodeURIComponent(SID_A)}?dir=${encodeURIComponent(encA)}`;
  const baseUrl = () => page.url().split('#')[0];
  const store = () => page.evaluate(() => JSON.parse(localStorage.getItem('cs-overrides') ?? '{}'));
  const savedA = async () => JSON.stringify((await store())[KEY_A] ?? null);
  const entryFor = (id) => page.evaluate((sid) => {
    const all = JSON.parse(localStorage.getItem('cs-overrides') ?? '{}');
    const k = Object.keys(all).find((x) => x.endsWith(` ${sid}`));
    return k ? all[k] : null;
  }, id);
  const initFrame = (sid) => ({ t: 'session-init', sessionId: sid, model: 'claude-sonnet-4-5', tools: [], permissionMode: 'default', slashCommands: [], lockedProvider: 'anthropic' });
  // A late / stray init through the REAL dispatcher (no socket of its own).
  const injectInit = (id) => page.evaluate((f) => window.__station.onEvent(f), initFrame(id));

  // The page's driving sockets, answered by the test.
  const socks = [];
  let needsForkFor = null; // a resume `start` for this id is refused with needs-fork (the real BUG-090 frame)
  await page.routeWebSocket(/\/ws(\?.*)?$/, (ws) => {
    const server = ws.connectToServer();
    const rec = { ws, starts: [], closed: false };
    socks.push(rec);
    ws.onMessage((m) => {
      let f = null;
      try { f = JSON.parse(String(m)); } catch { /* not ours */ }
      if (f?.type === 'start') {
        rec.starts.push(f);
        if (needsForkFor && f.resumeSessionId === needsForkFor && !f.fork) {
          ws.send(JSON.stringify({ t: 'error', fatal: true, message: 'needs fork', needsFork: { resumeSessionId: needsForkFor, resumeEncodedDir: encA, cause: 'path-changed' } }));
        }
        return; // HELD — the test decides when (and whether) this start is answered
      }
      // A live mode change on a session this test is answering: the server's real
      // ack contract ({t:'ack', of:'set-permission-mode', ok}) — finishPermMode persists on it.
      if (f?.type === 'set-permission-mode' && rec.starts.length) {
        ws.send(JSON.stringify({ t: 'ack', of: 'set-permission-mode', requestId: f.requestId, ok: true }));
        return;
      }
      server.send(m);
    });
    server.onMessage((m) => { if (!rec.closed) ws.send(m); });
    ws.onClose(() => { rec.closed = true; try { server.close(); } catch { /* gone */ } });
  });
  const openA = async () => {
    await page.goto(`${baseUrl()}${hashA}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction((id) => window.__station?.state?.current?.sessionId === id, SID_A, { timeout: 30000 });
    await page.waitForFunction(() => !!document.querySelector('#planBtn') && !document.querySelector('#planBtn').closest('[hidden]'), null, { timeout: 15000 });
    await sleep(400);
  };
  const startsSeen = () => socks.reduce((n, s) => n + s.starts.length, 0);
  // A REAL composer send; resolves with the socket that carried the held start.
  const realSend = async (text) => {
    const n0 = startsSeen();
    await page.fill('#prompt', text);
    await page.click('#go');
    const t0 = Date.now();
    while (startsSeen() === n0 && Date.now() - t0 < 10000) await sleep(50);
    const rec = socks.find((s) => s.starts.length && s === socks.filter((x) => x.starts.length).at(-1));
    return startsSeen() > n0 ? { rec, frame: rec.starts.at(-1) } : { rec: null, frame: null };
  };
  const answerInit = async (rec, id) => { if (rec && !rec.closed) rec.ws.send(JSON.stringify(initFrame(id))); await sleep(250); };
  const plan = async () => { await page.click('#planBtn'); await sleep(150); };
  const newPlus = async () => { await page.evaluate((pid) => window.__station.startNew(pid), P_A); await sleep(200); };
  const deadLink = async () => {
    const dead = `#/project/${encodeURIComponent(P_A)}/session/${encodeURIComponent(randomUUID())}?dir=${encodeURIComponent(encA)}`;
    await page.evaluate((h) => { location.hash = h; }, dead);
    await page.waitForFunction(() => window.__station?.state?.current?.sessionId === null, null, { timeout: 10000 });
    await sleep(250);
  };

  await openA();
  const savedA0 = await savedA();

  // (N)
  {
    const storeN0 = await store();
    await newPlus();
    await plan();
    const { rec, frame } = await realSend('owner N — a brand new session');
    const NEW_ID = randomUUID();
    const preInit = await entryFor(NEW_ID);
    const addedPre = Object.keys(await store()).filter((k) => !(k in storeN0));
    await answerInit(rec, NEW_ID);
    const postInit = await entryFor(NEW_ID);
    check(T('owner (N): "+" → plan → real send: nothing persisted before init; its own session-init (same socket) lands it under the new id; A untouched'),
      !!frame && frame.overrides?.permissionMode === 'plan' && preInit === null && postInit?.permissionMode === 'plan'
        && addedPre.length === 0 && (await savedA()) === savedA0,
      { sentOverrides: frame?.overrides ?? null, preInit, keysAddedBeforeInit: addedPre, postInit, aUnchanged: (await savedA()) === savedA0 });
  }

  // (S1) — the round-1 break, exact ordering.
  {
    await openA();
    const storeBefore = await store();
    await newPlus(); // abandoned: never sent
    await deadLink();
    await plan();
    const mem = await page.evaluate(() => ({ ...window.__station.state.overrides }));
    const STALE = randomUUID();
    await injectInit(STALE);
    await sleep(250);
    const stale = await entryFor(STALE);
    const after = await store();
    const added = Object.keys(after).filter((k) => !(k in storeBefore));
    check(T('owner (S1): "+" abandoned → dead link → plan armed → the abandoned attempt\'s LATE session-init does NOT adopt the dead-link bag'),
      mem.permissionMode === 'plan' && stale === null && added.length === 0 && (await savedA()) === savedA0,
      { armedAtDeadLink: mem, staleEntry: stale, newKeys: added });
  }

  // (S2) — pending → pending: the first attempt's init must not claim the second bag.
  {
    await openA();
    await newPlus();
    await plan();
    const first = await realSend('owner S2 — first attempt, abandoned');
    await newPlus(); // a SECOND "+": the first attempt is abandoned (its socket closes)
    await plan();
    const mem2 = await page.evaluate(() => ({ ...window.__station.state.overrides }));
    const STALE = randomUUID();
    await answerInit(first.rec, STALE); // over the dead socket: the browser drops it (closed)
    await injectInit(STALE);            // …and the stray frame through the dispatcher anyway
    await sleep(200);
    const staleEntry = await entryFor(STALE);
    const second = await realSend('owner S2 — second attempt');
    const ID2 = randomUUID();
    await answerInit(second.rec, ID2);
    const e2 = await entryFor(ID2);
    check(T('owner (S2): a late init for the ABANDONED first "+" attempt is not adopted by the second pending bag; the second attempt\'s own init lands it under its own id'),
      !!first.frame && first.rec?.closed === true && staleEntry === null && !!second.frame
        && JSON.stringify(e2) === JSON.stringify(mem2) && (await savedA()) === savedA0,
      { firstSocketClosed: first.rec?.closed, staleEntry, secondBag: mem2, secondEntry: e2 });
  }

  // (D) — a send from a dead-link view births a session and keeps what it carried.
  {
    await openA();
    await deadLink();
    await plan();
    const { rec, frame } = await realSend('owner D — sent from a dead-link view');
    const ID = randomUUID();
    const pre = await entryFor(ID);
    await answerInit(rec, ID);
    const e = await entryFor(ID);
    check(T('owner (D): plan armed on a dead-link view + a real send → its own init lands the bag under the new id'),
      !!frame && frame.overrides?.permissionMode === 'plan' && pre === null && e?.permissionMode === 'plan' && (await savedA()) === savedA0,
      { sentOverrides: frame?.overrides ?? null, entry: e });
  }

  // (R) — reattach/resume init naming the open session, and a stray foreign one.
  {
    await openA();
    const before = await savedA();
    await injectInit(SID_A);
    const same = await savedA();
    const STRAY = randomUUID();
    await openA();
    await injectInit(STRAY);
    const stray = await entryFor(STRAY);
    check(T('owner (R): an init naming the open session\'s own id (reattach/resume) leaves A byte-identical; a stray foreign init writes no entry for that id'),
      same === before && stray === null && (await savedA()) === before, { before, afterSame: same, strayEntry: stray });
  }

  // (W) — the frozen-bar fork (#forkBtn) after a real needs-fork refusal of A's resume.
  {
    await openA();
    const before = await savedA();
    needsForkFor = SID_A;
    await realSend('owner W — resume that the server refuses with needs-fork');
    needsForkFor = null;
    await page.waitForFunction(() => window.__station.state.pendingFork != null, null, { timeout: 10000 }).catch(() => {});
    await sleep(200);
    const barShown = await page.evaluate(() => { const b = document.querySelector('#forkBtn'); return !!b && !b.closest('[hidden]'); });
    if (barShown) await page.click('#forkBtn');
    await sleep(200);
    await plan(); // an explicit edit while the fork is staged — it is the fork's
    const aStaged = await savedA();
    const mem = await page.evaluate(() => ({ ...window.__station.state.overrides }));
    const { rec, frame } = await realSend('owner W — first message of the fork');
    const FORK = randomUUID();
    await answerInit(rec, FORK);
    const forkEntry = await entryFor(FORK);
    await plan(); // a LATER edit on the now-running fork (live: acked by the test's server side)
    await sleep(250);
    const forkAfter = await entryFor(FORK);
    const aFinal = await savedA();
    check(T('owner (W): #forkBtn fork — a staged edit leaves A byte-identical, the fork\'s init lands the bag under the fork id, and a later edit on the fork writes under the fork id, never A'),
      barShown && !!frame && frame.fork === true && aStaged === before && JSON.stringify(forkEntry) === JSON.stringify(mem)
        && JSON.stringify(forkAfter) !== JSON.stringify(forkEntry) && aFinal === before,
      { barShown, fork: frame?.fork, aBefore: before, aStaged, aFinal, staged: mem, forkEntry, forkAfterEdit: forkAfter });
  }

  // (F) — via the real row menu.
  for (const [label, targetName] of [['same-project', ids.NAME_A], ['cross-project', ids.NAME_B]]) {
    await openA();
    const before = await savedA();
    let opened;
    try {
      const row = page.locator('#tree').getByText('tidy the build scripts', { exact: false }).first();
      await row.waitFor({ state: 'visible', timeout: 10000 });
      await row.click({ button: 'right' });
      await sleep(150);
      opened = await page.evaluate(() => document.querySelector('#rowMenu')?.classList.contains('open') ? true : 'menu-not-open');
    } catch (e) {
      const tree = await page.evaluate(() => (document.querySelector('#tree')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400));
      opened = `no-row: ${e.message.split('\n')[0]} · tree=${tree}`;
    }
    const forkBtn = await page.evaluate(() => {
      const b = [...document.querySelectorAll('#rowMenu button')].find((x) => /fork/i.test(x.textContent || ''));
      if (!b) return false;
      b.click();
      return true;
    });
    await sleep(150);
    const picked = await page.evaluate((nm) => {
      const b = [...document.querySelectorAll('#rowMenu .prow')].find((x) => (x.querySelector('.nm')?.textContent || '').trim() === nm);
      if (!b) return false;
      b.click();
      return true;
    }, targetName);
    await page.waitForFunction(() => window.__station.state.forkFrom != null, null, { timeout: 10000 }).catch(() => {});
    await sleep(300);
    const staged = await page.evaluate(() => ({ forkFrom: window.__station.state.forkFrom, mem: { ...window.__station.state.overrides } }));
    await plan(); // an explicit edit while staged belongs to the fork-to-be
    const aAfterEdit = await savedA();
    const memAfterEdit = await page.evaluate(() => ({ ...window.__station.state.overrides }));
    const { rec, frame } = await realSend(`owner F ${label} — first message of the fork`);
    const FORK_ID = randomUUID();
    await answerInit(rec, FORK_ID);
    const forkEntry = await entryFor(FORK_ID);
    const expectMem = JSON.stringify(memAfterEdit);
    check(T(`owner (F ${label}): real row-menu fork staged; an edit while staged leaves A's entry byte-identical; the fork's own send+init lands the staged bag under the fork id`),
      opened === true && forkBtn && picked && staged.forkFrom === SID_A && aAfterEdit === before && !!frame && frame.fork === true
        && JSON.stringify(forkEntry ?? {}) === (Object.keys(memAfterEdit).length ? expectMem : '{}') && (await savedA()) === before,
      { opened, forkBtn, picked, forkFrom: staged.forkFrom, stagedMem: staged.mem, aBefore: before, aAfterEdit, fork: frame?.fork, forkEntry });
  }

  /*
   * BUG-198 round 3 — the four attacks the round-2 verifier could not build. Each
   * drives the REAL client paths (submit → startTurn, the BUG-029 refusal
   * rollback, the BUG-045 drain-wait self-retry, the real row menu) over real
   * sockets; only the server's answers are the test's.
   */
  const errFrame = (retryable) => (retryable
    ? { t: 'error', message: 'still finishing its previous turn after a server restart', retryable: true, drain: { backgroundTasks: 1, heldForMs: 1000 } }
    : { t: 'error', message: 'refused before ack (test)' });
  const refuse = async (rec, retryable) => { if (rec && !rec.closed) rec.ws.send(JSON.stringify(errFrame(retryable))); await sleep(300); };
  const waitStart = async (n0, ms) => { const t0 = Date.now(); while (startsSeen() === n0 && Date.now() - t0 < ms) await sleep(100); const rec = socks.filter((x) => x.starts.length).at(-1); return startsSeen() > n0 ? { rec, frame: rec.starts.at(-1) } : { rec: null, frame: null }; };

  // (X1) a refused start (BUG-029 rollback, non-retryable) retried by the user on a
  // NEW socket before any init: the stale socket's late init adopts nothing; the
  // retry's own init (new socket) lands the SAME armed bag under the new id.
  {
    await openA();
    await newPlus();
    await plan();
    const first = await realSend('owner X1 — refused, then retried');
    await refuse(first.rec, false);
    const firstClosed = first.rec?.closed === true || await page.evaluate(() => !window.__station.state.live);
    const STALE = randomUUID();
    await answerInit(first.rec, STALE); // over the torn-down socket
    const staleEntry = await entryFor(STALE);
    const mem = await page.evaluate(() => ({ ...window.__station.state.overrides }));
    const retry = await realSend('owner X1 — refused, then retried'); // the user's Enter again
    const ID = randomUUID();
    await answerInit(retry.rec, ID);
    const e = await entryFor(ID);
    check(T('owner (X1): a refused "+" start (BUG-029 rollback) retried on a NEW socket — the stale socket\'s init adopts nothing; the retry\'s own init lands the armed bag under the new id; A untouched'),
      !!first.frame && firstClosed && staleEntry === null && !!retry.frame && retry.rec !== first.rec && !retry.frame.resumeSessionId
        && e?.permissionMode === 'plan' && JSON.stringify(e) === JSON.stringify(mem) && (await savedA()) === savedA0,
      { firstClosed, staleEntry, retryResume: retry.frame?.resumeSessionId ?? null, sameSocket: retry.rec === first.rec, bag: mem, entry: e });
  }

  // (X2) the drain-wait self-retry (BUG-045): a RETRYABLE refusal queues the text
  // and the client re-sends it by itself on a new socket; that start's init lands
  // the armed bag under the new id. The first socket's late init adopts nothing.
  {
    await openA();
    await newPlus();
    await plan();
    const first = await realSend('owner X2 — drain-wait self-retry');
    const n0 = startsSeen();
    await refuse(first.rec, true);
    const queued = await page.evaluate(() => window.__station.state.queue.filter((q) => !q.dead && q.drainWait).length);
    const retry = await waitStart(n0, 12000); // DRAIN_RETRY_MS 7s — the client's own timer
    const STALE = randomUUID();
    await answerInit(first.rec, STALE);
    const staleEntry = await entryFor(STALE);
    const mem = await page.evaluate(() => ({ ...window.__station.state.overrides }));
    const ID = randomUUID();
    await answerInit(retry.rec, ID);
    const e = await entryFor(ID);
    check(T('owner (X2): a retryable refusal → the drain-wait SELF-retry sends on a new socket; its init lands the armed bag under the new id; the first socket\'s init adopts nothing; A untouched'),
      !!first.frame && queued === 1 && !!retry.frame && retry.rec !== first.rec && staleEntry === null
        && e?.permissionMode === 'plan' && JSON.stringify(e) === JSON.stringify(mem) && (await savedA()) === savedA0,
      { queued, retried: !!retry.frame, newSocket: retry.rec !== first.rec, staleEntry, bag: mem, entry: e });
  }

  // (X4) a legitimate reconnect: the "+" start's socket DROPS (server side) before
  // its init; the user's next Enter opens a new socket, and the init that arrives
  // there — for this genuinely pending session — must still adopt.
  {
    await openA();
    await newPlus();
    await plan();
    const first = await realSend('owner X4 — socket dropped before init');
    try { await first.rec?.ws.close(); } catch { /* gone */ }
    await sleep(300);
    const dropped = await page.evaluate(() => !window.__station.state.live);
    const mem = await page.evaluate(() => ({ ...window.__station.state.overrides }));
    const again = await realSend('owner X4 — socket dropped before init');
    const ID = randomUUID();
    await answerInit(again.rec, ID);
    const e = await entryFor(ID);
    check(T('owner (X4): a pending "+" whose socket dropped before init — the init arriving on the NEW socket still adopts the armed bag under the new id; A untouched'),
      !!first.frame && dropped && !!again.frame && again.rec !== first.rec && e?.permissionMode === 'plan'
        && JSON.stringify(e) === JSON.stringify(mem) && (await savedA()) === savedA0,
      { dropped, newSocket: again.rec !== first.rec, bag: mem, entry: e });
  }

  // (X3) a fork of a fork: F1 (a real row-menu fork of A, born by its own init,
  // then on disk like any session) is itself forked. An edit while F2 is staged
  // leaves BOTH A and F1 byte-identical; F2's init lands the staged bag under F2.
  {
    await openA();
    const f1 = await forkViaRowMenu('tidy the build scripts', ids.NAME_A);
    const s1 = await realSend('owner X3 — fork one');
    const F1 = randomUUID();
    await answerInit(s1.rec, F1);
    const f1Entry = await entryFor(F1);
    const f1Text = `fork one ${F1.slice(0, 8)} of the build scripts`; // unique per run: each run's F1 is its own row
    ids.writeTranscript(encA, PROJ_A, F1, f1Text);
    await page.evaluate((pid) => window.__station.loadSessions(pid), P_A);
    await sleep(400);
    const f1Before = JSON.stringify(await entryFor(F1));
    const f2 = await forkViaRowMenu(f1Text, ids.NAME_A);
    const staged = await page.evaluate(() => window.__station.state.forkFrom);
    await plan();
    const f1Staged = JSON.stringify(await entryFor(F1));
    const mem = await page.evaluate(() => ({ ...window.__station.state.overrides }));
    const s2 = await realSend('owner X3 — fork of the fork');
    const F2 = randomUUID();
    await answerInit(s2.rec, F2);
    const f2Entry = await entryFor(F2);
    check(T('owner (X3): fork of a fork — F1 (a born fork) forked again via the real row menu; a staged edit leaves A and F1 byte-identical; F2\'s own init lands the staged bag under F2'),
      f1.ok && !!s1.frame && s1.frame.fork === true && f2.ok && staged === F1 && !!s2.frame && s2.frame.fork === true
        && s2.frame.resumeSessionId === F1 && f1Staged === f1Before && JSON.stringify(await entryFor(F1)) === f1Before
        && JSON.stringify(f2Entry ?? {}) === JSON.stringify(mem) && (await savedA()) === savedA0,
      { f1: f1.why, f1Entry, f2: f2.why, stagedFrom: staged === F1 ? 'F1' : staged, f1Before, f1Staged, bag: mem, f2Entry, f2ResumedFrom: s2.frame?.resumeSessionId === F1 ? 'F1' : s2.frame?.resumeSessionId });
  }

  async function forkViaRowMenu(rowText, targetName) {
    try {
      const row = page.locator('#tree').getByText(rowText, { exact: false }).first();
      await row.waitFor({ state: 'visible', timeout: 10000 });
      await row.click({ button: 'right' });
      await sleep(150);
    } catch (e) { return { ok: false, why: `no-row "${rowText}": ${e.message.split('\n')[0]}` }; }
    const fb = await page.evaluate(() => {
      const b = [...document.querySelectorAll('#rowMenu button')].find((x) => /fork/i.test(x.textContent || ''));
      if (!b) return false; b.click(); return true;
    });
    await sleep(150);
    const picked = await page.evaluate((nm) => {
      const b = [...document.querySelectorAll('#rowMenu .prow')].find((x) => (x.querySelector('.nm')?.textContent || '').trim() === nm);
      if (!b) return false; b.click(); return true;
    }, targetName);
    await page.waitForFunction(() => window.__station.state.forkFrom != null, null, { timeout: 10000 }).catch(() => {});
    await sleep(300);
    return { ok: fb && picked, why: { fb, picked } };
  }
}

async function main() {
  console.log('\n========== BUG-198 — a sidebar project click never rewrites the open session\'s saved overrides ==========');
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const encA = encodeCwd(PROJ_A);
  const encB = encodeCwd(PROJ_B);
  const SID_A = randomUUID();
  const SID_B = randomUUID();
  // REAL Claude transcript shape on disk for A and one for B.
  const writeTranscript = (enc, cwd, id, text) => {
    const dir = path.join(STORE, enc);
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const lines = [
      { type: 'user', message: { role: 'user', content: text }, sessionId: id, cwd, timestamp: now, version: '2.1.0', entrypoint: 'cli', uuid: randomUUID() },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'On it.' }] }, sessionId: id, cwd, timestamp: now, uuid: randomUUID() },
    ];
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  writeTranscript(encA, PROJ_A, SID_A, 'tidy the build scripts');
  writeTranscript(encB, PROJ_B, SID_B, 'look at the failing test');

  server = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: isolatedServerEnv({
      PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE,
      CLAUDE_STATION_SURVIVE: '0', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: '',
    }, { requireStore: true }),
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) throw new Error('server never became healthy');
  const register = async (hostPath, name) => {
    const r = await fetch(`${BASE}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostPath, name, applyMethod: false }),
    });
    if (!r.ok) throw new Error(`could not register ${name}: ${await r.text()}`);
    return (await r.json()).project.id;
  };
  const P_A = await register(PROJ_A, NAME_A);
  const P_B = await register(PROJ_B, NAME_B);
  const ids = { P_A, P_B, encA, encB, SID_A, SID_B, NAME_A, NAME_B, writeTranscript }; // BUG-198 round 3 — X3 writes a born fork to disk

  browser = await chromium.launch({ headless: true, executablePath: process.env.QA_BRAVE_PATH ?? '/usr/bin/brave' });

  if (!PREFIX_ONLY) await scenario(BASE, ids, { prefix: false });

  // MUST-FAIL: the same scenario on the synthesized pre-fix client must LOSE A's
  // permissionMode. Its checks are run in a sub-tally and graded as one check.
  const saved = { pass, fail, failures: failures.length };
  let synthErr = null;
  try { await scenario(BASE, ids, { prefix: true }); } catch (e) { synthErr = e; }
  const prefixFails = failures.slice(saved.failures);
  pass = saved.pass; fail = saved.fail; failures.length = saved.failures;
  // BUG-198 round 2 MUST-FAIL: the owner transitions on the synthesized ROUND-1
  // client must reproduce the round-1 verifier's break (S1) and the two sibling
  // paths the nullable owner admitted (S2 pending→pending, W frozen-bar fork).
  if (!PREFIX_ONLY) {
    const saved1 = { pass, fail, failures: failures.length };
    let r1Err = null;
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      page.on('pageerror', (e) => process.stderr.write(`  [pageerror r1] ${e.message}\n`));
      const patched = synthesizeRound1(fs.readFileSync(APP_JS, 'utf8'));
      await page.route(/\/app\.js(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: patched }));
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await ownerTransitions(page, ids, { tag: 'ROUND-1 (synthesized)' });
      await ctx.close();
    } catch (e) { r1Err = e; }
    const r1Fails = failures.slice(saved1.failures);
    pass = saved1.pass; fail = saved1.fail; failures.length = saved1.failures;
    const red = (tag) => r1Fails.some((n) => n.startsWith(`owner (${tag})`));
    check('MUST-FAIL round 1: the synthesized round-1 owner model adopts the dead-link bag under the stale "+" id (S1), lets an abandoned attempt claim the next pending bag (S2), and writes frozen-bar fork edits under the source (W)',
      !r1Err && red('S1') && red('S2') && red('W'), r1Err ? `error: ${r1Err.message}` : { round1Failed: r1Fails });
  }
  // BUG-198 round 3 MUST-FAIL: the new-socket cases must detect a binding that
  // refuses a legitimate adoption (the round-2 verifier's open question).
  if (!PREFIX_ONLY) {
    const saved3 = { pass, fail, failures: failures.length };
    let r3Err = null;
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      page.on('pageerror', (e) => process.stderr.write(`  [pageerror fso] ${e.message}\n`));
      const patched = synthesizeFirstSocketOnly(fs.readFileSync(APP_JS, 'utf8'));
      await page.route(/\/app\.js(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: patched }));
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await ownerTransitions(page, ids, { tag: 'FIRST-SOCKET-ONLY (synthesized)' });
      await ctx.close();
    } catch (e) { r3Err = e; }
    const r3Fails = failures.slice(saved3.failures);
    pass = saved3.pass; fail = saved3.fail; failures.length = saved3.failures;
    const red = (tag) => r3Fails.some((n) => n.startsWith(`owner (${tag})`));
    check('MUST-FAIL round 3: a client that binds adoption to the FIRST socket only refuses the legitimate new-socket adoptions — refused-start retry (X1), drain-wait self-retry (X2) and dropped-socket reconnect (X4) go red',
      !r3Err && red('X1') && red('X2') && red('X4'), r3Err ? `error: ${r3Err.message}` : { failed: r3Fails });
  }
  if (PREFIX_ONLY) {
    // Report the raw pre-fix outcome: exit 1 iff the bug reproduced.
    check('synthesized pre-fix: every check passes (EXPECTED TO FAIL — the bug reproduces)', prefixFails.length === 0 && !synthErr,
      synthErr ? `error: ${synthErr.message}` : { failed: prefixFails });
  } else {
    const lostPerm = prefixFails.some((n) => /step 5/.test(n)) && prefixFails.some((n) => /step 2: A's in-memory/.test(n));
    check('MUST-FAIL: the synthesized pre-fix client LOSES A\'s permissionMode after a project click + persist (step 2 + step 5 red)',
      !synthErr && lostPerm, synthErr ? `error: ${synthErr.message}` : { preFixFailed: prefixFails });
  }
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
  for (const d of [DATA, STORE, PROJ_A, PROJ_B]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
});
