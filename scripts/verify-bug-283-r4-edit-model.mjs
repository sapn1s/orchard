/**
 * BUG-283 r4 / BUG-285 — the settings drawer's ONE edit model + ONE commit path.
 *
 *   node scripts/verify-bug-283-r4-edit-model.mjs            # current public/ (must pass)
 *   node scripts/verify-bug-283-r4-edit-model.mjs --old <drawer.js>
 *                                                            # serve another drawer.js (must-FAIL proof)
 *
 * Re-drives the five breaks independent verify r1 found in the r3 drawer (F1-F5,
 * BUG-283 Activity log "verify r1 — consolidated") with REAL CDP mouse/keyboard
 * input against a REAL scratch server and a container project whose settings
 * mirror a busy real one (synthetic). Background repaints go through the same
 * drawer.repaint()/repaintLive() the app calls on project/live-session events.
 *
 *  F1 a background repaint while the user types in a blur-commit row must not save
 *     a truncated value, nor garble the text (Dockerfile, Base image, Spend cap,
 *     Allowed tools, Excluded directories, Response-format guidance).
 *  F2 closing the drawer (Ctrl+,) right after a refused add-form save must not
 *     resend the refused value.
 *  F3 the refusal banner must not cover the refused input (pane scrolled).
 *  F4 a refused Enter in one add-form must not pull focus out of a different
 *     add-form the user has since moved to.
 *  F5 a pending access-confirm card must not survive close/reopen.
 *  S  structural: no `blur` listener in drawer.js outside the one bindField().
 *  S4 / V-d3 / V-d4 (r6): a late result reaches the banner only in the open it was made in.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const oldIdx = process.argv.indexOf('--old');
const OLD_DRAWER = oldIdx > 0 ? path.resolve(process.argv[oldIdx + 1]) : null;
const REFUSED = '/nonexistent-bug283-r3/backups';

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

const procs = [];
const dirs = [];
function stopByPid(child) { if (!child || child.exitCode !== null) return; try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref(); }

/** A temp tree serving `drawer` as public/lib/drawer.js (everything else is this checkout's). */
function treeWith(drawer) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b283r4-tree-')); dirs.push(tmp);
  for (const d of ['src', 'public']) fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
  for (const f of ['package.json', 'tsconfig.json']) { try { fs.cpSync(path.join(ROOT, f), path.join(tmp, f)); } catch { /* optional */ } }
  for (const d of ['node_modules', 'scripts', 'docs']) fs.symlinkSync(path.join(ROOT, d), path.join(tmp, d));
  fs.copyFileSync(drawer, path.join(tmp, 'public', 'lib', 'drawer.js'));
  return tmp;
}

async function bootServer(repoRoot) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'b283r4-data-')); dirs.push(data);
  const srv = spawn(process.execPath, [path.join(repoRoot, 'src', 'server', 'index.ts')], {
    cwd: repoRoot, env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: data }, stdio: ['ignore', 'ignore', 'ignore'],
  });
  procs.push(srv);
  for (let i = 0; i < 80; i++) { try { await fetch(`${base}/api/health`); return base; } catch { await sleep(250); } }
  throw new Error('scratch server never became healthy');
}

async function busyContainerProject(base) {
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b283r4-proj-')); dirs.push(projDir);
  fs.writeFileSync(path.join(projDir, 'Dockerfile.orchard'), 'FROM scratch\n');
  const j = async (method, url, body) => {
    const r = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${url} ${r.status}: ${t.slice(0, 200)}`);
    return JSON.parse(t);
  };
  const pid = (await j('POST', '/api/projects', { hostPath: projDir, name: 'b283r4-busy' })).project.id;
  await j('PATCH', `/api/projects/${pid}`, { isolation: 'container' });
  await j('PATCH', `/api/projects/${pid}`, { settings: { container: {
    memoryMb: 20480, gpu: 'auto', env: { PYTHONPATH: '/workspace/pylibs' }, workspaceRoot: true, dockerfile: 'Dockerfile.orchard', ports: [],
  }, laneDocker: 'host' } });
  return pid;
}

class Tab {
  static async open(base) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'b283r4-br-')); dirs.push(profile);
    const br = spawn(BRAVE, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', '--window-size=1000,1300', 'about:blank'], { stdio: 'ignore' });
    procs.push(br);
    let dev = 0;
    for (let i = 0; i < 80 && !dev; i++) { try { dev = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
    if (!dev) throw new Error('brave devtools never came up');
    const target = (await (await fetch(`http://127.0.0.1:${dev}/json/list`)).json()).find((x) => x.type === 'page');
    const WebSocket = (await import('ws')).default;
    const t = new Tab();
    t.ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 1 << 26 });
    await new Promise((r, rej) => { t.ws.once('open', r); t.ws.once('error', rej); });
    t.id = 0; t.waiting = new Map(); t.reqs = []; t.counting = false;
    t.ws.on('message', (m) => {
      const j = JSON.parse(m);
      if (j.id && t.waiting.has(j.id)) { const w = t.waiting.get(j.id); t.waiting.delete(j.id); j.error ? w.rej(new Error(j.error.message)) : w.res(j.result); }
      else if (j.method === 'Network.requestWillBeSent' && t.counting) t.reqs.push(`${j.params.request.method} ${new URL(j.params.request.url).pathname}`);
    });
    await t.send('Page.enable'); await t.send('Network.enable');
    await t.send('Page.navigate', { url: `${base}/` });
    await t.waitFor('window.__station !== undefined');
    return t;
  }
  // Bounded: on the old build the save loop can starve the page, and a hung
  // eval must FAIL the run, not hang it.
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiting.delete(id); rej(new Error(`CDP ${method} timed out (page unresponsive)`)); }, 15_000);
      this.waiting.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(expr, ms = 20_000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await this.eval(expr)) return true; } catch { /* nav */ } await sleep(150); } return false; }
  async click(xy) { for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x: xy.x, y: xy.y, button: 'left', clickCount: 1 }); }
  async type(text) { await this.send('Input.insertText', { text }); }
  async key(key, code = key, vk = 0) { for (const type of ['keyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk }); }
  /** Count network requests (and add-form input rebuilds) over `ms`, running `during` first. */
  async window(ms, aria, during = async () => {}) {
    await this.eval(`(() => { window.__b283 = 0; window.__b283mo?.disconnect();
      window.__b283mo = new MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) {
        if (n.nodeType === 1 && (n.matches?.('input[aria-label=${JSON.stringify(aria)}]') || n.querySelector?.('input[aria-label=${JSON.stringify(aria)}]'))) window.__b283++; } });
      window.__b283mo.observe(document.querySelector('#smodal'), { childList: true, subtree: true }); })()`);
    this.reqs = []; this.counting = true;
    await during();
    await sleep(ms);
    this.counting = false;
    const renders = await this.eval('(() => { window.__b283mo.disconnect(); return window.__b283; })()');
    const by = {}; for (const r of this.reqs) by[r] = (by[r] ?? 0) + 1;
    const writes = this.reqs.filter((r) => !r.startsWith('GET ')).length;
    return { total: this.reqs.length, writes, renders, by };
  }
  focused() { return this.eval(`(() => { const a = document.activeElement; return a?.getAttribute?.('aria-label') ?? a?.tagName ?? null; })()`); }
  input(aria) { return this.eval(`(() => { const i = document.querySelector('#smodal input[aria-label=${JSON.stringify(aria)}]'); if (!i) return null; i.scrollIntoView({ block: 'nearest' }); const r = i.getBoundingClientRect(); return { x: r.x + 24, y: r.y + r.height / 2, value: i.value }; })()`); }
  addButton(label) { return this.eval(`(() => { const b = [...document.querySelectorAll('#smodal button.addrow')].find((x) => x.textContent.includes(${JSON.stringify(label)})); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`); }
  saveErr() { return this.eval(`(() => { const e = document.querySelector('#dSaveErr'); return e && !e.hidden ? e.textContent : ''; })()`); }
}

async function openIso(tab, pid, focus) {
  // Close for real between steps (the X button always closes; Esc/Ctrl+, refuse while an edit is pending),
  // so one step's leftover state never leaks into the next step's measurement.
  await tab.eval(`(() => { const S = window.__station; if (S.drawer.isOpen()) document.querySelector('#dClose').click(); S.selectProject(${JSON.stringify(pid)}); S.drawer.open('settings', { focus: ${JSON.stringify(focus)} }); })()`);
  await tab.waitFor(`!document.querySelector('#smodal').hidden`);
  // let the opening fetches (container status etc.) land and their repaints settle
  await tab.waitFor(`!/Checking the container/.test(document.querySelector('#smodal').textContent)`, 8000);
  await sleep(800);
}

/** (Keeps a failing old build measurable past its first failure.) Make sure the
 *  form is open and its input focused + emptied, re-opening it if a repaint closed it. */
async function ensureFocused(tab, btn, aria) {
  for (let i = 0; i < 3 && !(await tab.input(aria)); i++) { const b = await tab.addButton(btn); if (b) await tab.click(b); await sleep(150); }
  await tab.eval(`(() => { const i = document.querySelector('#smodal input[aria-label=${JSON.stringify(aria)}]'); if (i) { i.focus(); i.select(); } })()`);
}

/** Open an add-form with a REAL click; returns the focus 200 ms later. */
async function openForm(tab, btn, aria) {
  const b = await tab.addButton(btn);
  if (!b) {
    // already open (a drawer that keeps add-forms open across close/reopen): use it, emptied
    const xy = await tab.input(aria);
    if (!xy) return { opened: false };
    await tab.click(xy); await sleep(80);
    await tab.eval(`document.querySelector('#smodal input[aria-label=${JSON.stringify(aria)}]').select()`);
    await tab.key('Delete', 'Delete', 46);
    return { opened: true, reused: true, focus200: await tab.focused() };
  }
  await tab.click(b);
  await sleep(200);
  return { opened: !!(await tab.input(aria)), focus200: await tab.focused() };
}


const settingsOf = async (base, pid) => { const j = await (await fetch(`${base}/api/projects/${pid}`)).json(); return (j.project ?? j).settings ?? {}; };
const CTRL = 2;
async function chord(tab, key, code, vk) {
  for (const type of ['keyDown', 'keyUp']) await tab.send('Input.dispatchKeyEvent', { type, key, code, modifiers: CTRL, windowsVirtualKeyCode: vk });
}
/** Field rect by aria-label (input or textarea), scrolled into view. */
const fieldXY = (tab, aria) => tab.eval(`(() => { const i = document.querySelector('#smodal [aria-label=${JSON.stringify(aria)}]'); if (!i) return null; i.scrollIntoView({ block: 'center' }); const r = i.getBoundingClientRect(); return { x: r.x + 12, y: r.y + Math.min(10, r.height / 2), value: i.value }; })()`);
const fieldVal = (tab, aria) => tab.eval(`document.querySelector('#smodal [aria-label=${JSON.stringify(aria)}]')?.value ?? null`);

/* CDP Fetch: optionally delay PATCHes and/or inject an approved-pending access request. */
const fx = { delayPatchMs: 0, accessReq: false, delayAccessMs: 0, failPatchMs: 0 };
function wireFetch(tab) {
  tab.ws.on('message', (m) => {
    const j = JSON.parse(m);
    if (j.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = j.params;
    const go = () => tab.ws.send(JSON.stringify({ id: 800000 + Math.floor(Math.random() * 99999), method: 'Fetch.continueRequest', params: { requestId } }));
    if (/access-requests/.test(request.url) && fx.delayAccessMs && !fx.accessReq) { setTimeout(go, fx.delayAccessMs); return; }
    if (/access-requests/.test(request.url) && fx.accessReq) {
      const body = JSON.stringify({ requests: [{ id: 'rq-b283r4', cancellable: true, summary: 'set env FOO for tests', sdkSessionId: 's-b283r4', changes: [{ kind: 'env', key: 'FOO' }] }] });
      tab.ws.send(JSON.stringify({ id: 900000 + Math.floor(Math.random() * 99999), method: 'Fetch.fulfillRequest', params: { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(body).toString('base64') } }));
      return;
    }
    // BUG-283 r6: a PATCH that fails with a 500 after `failPatchMs` (a late server refusal)
    if (request.method === 'PATCH' && fx.failPatchMs) {
      const body = JSON.stringify({ error: 'b283r6 injected late failure' });
      setTimeout(() => tab.ws.send(JSON.stringify({ id: 700000 + Math.floor(Math.random() * 99999), method: 'Fetch.fulfillRequest', params: { requestId, responseCode: 500, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(body).toString('base64') } })), fx.failPatchMs);
      return;
    }
    if (request.method === 'PATCH' && fx.delayPatchMs) { setTimeout(go, fx.delayPatchMs); return; }
    go();
  });
  return tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/projects*', requestStage: 'Request' }] });
}

/** F1: click the field, select all, type `a`, background repaint, type `b`, commit. */
async function typingRow(tab, base, pid, row) {
  await openIso(tab, pid, row.focus);
  const xy = await fieldXY(tab, row.aria);
  if (!xy) return { missing: true };
  await tab.click(xy);
  await sleep(120);
  await tab.eval(`document.querySelector('#smodal [aria-label=${JSON.stringify(row.aria)}]').select()`);
  const w = await tab.window(2500, row.aria, async () => {
    await tab.type(row.a);
    await tab.eval('window.__station.drawer.repaint()'); // a project-refresh repaint (the app calls this)
    await tab.eval('window.__station.drawer.repaintLive()'); // a live-session event repaint
    await sleep(500); // let the refetches the repaint started land and repaint again
    await tab.type(row.b);
    await sleep(80);
    if (row.textarea) await chord(tab, 'Enter', 'Enter', 13); else await tab.key('Enter', 'Enter', 13);
  });
  const stored = row.read(await settingsOf(base, pid));
  return { writes: w.writes, by: w.by, stored, shown: await fieldVal(tab, row.aria), err: await tab.saveErr() };
}

async function run() {
  const tree = OLD_DRAWER ? treeWith(OLD_DRAWER) : ROOT;
  console.log(`\n--- drawer under test: ${OLD_DRAWER ?? 'public/lib/drawer.js (current)'} ---`);
  const base = await bootServer(tree);
  const pid = await busyContainerProject(base);
  const tab = await Tab.open(base);
  await wireFetch(tab);

  /* S. structural: the one blur-commit chokepoint */
  const src = fs.readFileSync(OLD_DRAWER ?? path.join(ROOT, 'public', 'lib', 'drawer.js'), 'utf8');
  const blurSites = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /addEventListener\(\s*['"](blur|focusout)['"]/.test(l));
  const inBind = blurSites.filter(([, l]) => /BUG-283 r4: the one save-on-blur/.test(l));
  check('(S) drawer.js attaches a blur/focusout listener ONLY inside bindField (the one commit path)',
    blurSites.length === 1 && inBind.length === 1, blurSites.map(([n, l]) => `${n}: ${l.trim().slice(0, 90)}`));

  /* S2. sweep: EVERY text input / textarea the drawer builds is model-bound (bindField or bindDraft),
         or carries an explicit `// edit-model: exempt — <reason>` on its line. A new field outside
         the model fails here. */
  {
    const lines = src.split('\n');
    const rows = [];
    lines.forEach((l, i) => {
      const m = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*el\(\s*'(input|textarea)'|([A-Za-z_$][\w$]*)\s*:\s*el\(\s*'(input|textarea)'/.exec(l);
      if (!m) return;
      const name = m[1] ?? m[3];
      if (/edit-model: exempt — \S/.test(l)) { rows.push({ line: i + 1, name, bound: 'exempt' }); return; }
      const win = lines.slice(i, i + 90).join('\n');
      const re = new RegExp(`\\b(bindField|bindDraft)\\(\\s*(?:[\\w$]+\\.)?${name}\\b`);
      const hit = re.exec(win);
      rows.push({ line: i + 1, name, bound: hit ? hit[1] : null });
    });
    const unbound = rows.filter((r) => !r.bound);
    check(`(S2) every one of the drawer's ${rows.length} text inputs/textareas is bound to the edit model (or explicitly exempt)`,
      rows.length >= 15 && unbound.length === 0, { total: rows.length, unbound, exempt: rows.filter((r) => r.bound === 'exempt') });
  }

  /* S3. sweep: EVERY confirm card / armed ceremony state (a `d` key named *confirm* / *arm*, plus the
         restore ceremony, the repoint arm, the custom-value editor and the add-forms) is cleared by
         the ONE reset, resetEdit(). */
  {
    const dBlock = /\n  const d = \{([\s\S]*?)\n  \};/.exec(src)?.[1] ?? '';
    const keys = [...dBlock.matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]);
    const armed = keys.filter((k) => /confirm|arm/i.test(k));
    const must = [...new Set([...armed, 'accessConfirm', 'restore', 'customEdit', 'addingMount', 'addingEnv', 'addingPort', 'addingService', 'gModelCustomOpen'])];
    const reset = /function resetEdit\(hard\) \{([\s\S]*?)\n  \}/.exec(src)?.[1] ?? '';
    const missing = must.filter((k) => !new RegExp(`\\bd\\.${k}\\s*=`).test(reset));
    const repointArm = /d\.repoint\.arm\s*=\s*null/.test(reset);
    check(`(S3) every confirm card / armed state (${must.length}) is cleared by resetEdit()`, armed.length >= 6 && missing.length === 0 && repointArm,
      { armedKeys: armed, missing, repointArm });
  }

  /* S4. sweep (BUG-283 r6, verify r5 d1/d2): a drawer message that can land AFTER an await / in a
         catch / in a later event must carry the ticket of the open it was made in (tell(tk, …) or
         saveFailed(tk, …)); a bare notify() there lands its late result in a REOPENED drawer's banner.
         Each bare notify() is traced back to its enclosing function (by indentation). */
  {
    const L = src.split('\n');
    const ind = (l) => l.match(/^\s*/)[0].length;
    const bad = [];
    let bare = 0;
    L.forEach((l, i) => {
      if (!/(^|[^.\w])notify\(/.test(l) || /function notify\(/.test(l) || /^\s*(\*|\/\/|\/\*)/.test(l)) return;
      bare++;
      let cur = ind(l); const span = [];
      for (let k = i - 1; k >= 0; k--) {
        const m = L[k]; if (!m.trim()) continue;
        if (ind(m) < cur) { cur = ind(m); if (/\bfunction\b[^(]*\(|=>\s*\{/.test(m)) break; }
        span.push(m);
      }
      if (/\bawait\b|\bcatch\b|\.then\(/.test(span.join('\n')) || /\bawait\b/.test(l)) bad.push(`${i + 1}: ${l.trim().slice(0, 80)}`);
    });
    check(`(S4) no bare notify() after an await / in a catch (${bare} bare call sites scanned): late results carry their open's ticket`,
      bare >= 5 && bad.length === 0, { bare, unticketed: bad });
  }

  /* F1. background repaint mid-typing on every blur-commit row: one write, the WHOLE value */
  const rows = [
    { name: 'Dockerfile', focus: 'mounts', aria: 'Dockerfile', a: 'sub/Dock', b: 'erfile.b', want: 'sub/Dockerfile.b', read: (s) => s.container?.dockerfile },
    { name: 'Base image', focus: 'mounts', aria: 'Base image', a: 'ubuntu:2', b: '4.04', want: 'ubuntu:24.04', read: (s) => s.container?.image },
    { name: 'Spend cap', focus: 'model', aria: 'Spend cap in US dollars', a: '1', b: '25', want: 125, read: (s) => s.maxBudgetUsd },
    { name: 'Allowed tools', focus: 'caps', aria: 'Allowed tools', a: 'Bash, Re', b: 'ad', want: ['Bash', 'Read'], read: (s) => s.allowedTools },
    { name: 'Excluded directories', focus: 'snapshots', aria: 'Excluded directories', a: 'node_mod', b: 'ules, dist', want: ['node_modules', 'dist'], read: (s) => s.snapshots?.exclude },
    { name: 'Response guidance', focus: 'responseDigest', aria: 'Response-format guidance', a: 'be ter', b: 'se please', want: 'be terse please', read: (s) => s.responseDigest?.guidance, textarea: true },
  ];
  for (const row of rows) {
    const r = await typingRow(tab, base, pid, row);
    const ok = !r.missing && r.writes === 1 && JSON.stringify(r.stored) === JSON.stringify(row.want);
    check(`(F1 ${row.name}) type "${row.a}", background repaint, type "${row.b}", commit -> exactly ONE write of ${JSON.stringify(row.want)}`, ok, r);
  }

  /* F1b. a USER blur (real click elsewhere) after a repaint commits the whole value once */
  {
    await openIso(tab, pid, 'mounts');
    const xy = await fieldXY(tab, 'Base image');
    await tab.click(xy); await sleep(100);
    await tab.eval(`document.querySelector('#smodal [aria-label="Base image"]').select()`);
    const w = await tab.window(2500, 'Base image', async () => {
      await tab.type('debian:1');
      await tab.eval('window.__station.drawer.repaintLive()');
      await sleep(300);
      await tab.type('2');
      const away = await tab.eval(`(() => { const r = document.querySelector('#dTitle').getBoundingClientRect(); return { x: r.x + 4, y: r.y + r.height / 2 }; })()`);
      await tab.click(away);
    });
    const stored = (await settingsOf(base, pid)).container?.image;
    check('(F1b) Base image: type, repaint, type, click away -> ONE write of "debian:12"', w.writes === 1 && stored === 'debian:12', { writes: w.writes, by: w.by, stored });
  }

  /* F2. a refused add-form, then the user closes the drawer: the refusal is NOT resent.
         (a) Ctrl+, — the close guard may keep the drawer open (a typed, unsaved add-form is an
             uncommitted edit, as before BUG-283), but nothing is sent again;
         (b) the X button — always closes; still nothing is sent again. */
  for (const how of ['Ctrl+,', 'X button']) {
    await openIso(tab, pid, 'mounts');
    const o = await openForm(tab, 'Add mount', 'New mount');
    const w = await tab.window(2500, 'New mount', async () => {
      await tab.type(REFUSED); await tab.key('Enter', 'Enter', 13);
      await sleep(900);
      if (how === 'Ctrl+,') await chord(tab, ',', 'Comma', 188);
      else { await tab.key('Tab', 'Tab', 9); await tab.eval(`document.querySelector('#smodal input[aria-label="New mount"]').focus()`);
        const x = await tab.eval(`(() => { const r = document.querySelector('#dClose').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        await tab.click(x); }
    });
    const closed = await tab.eval(`document.querySelector('#smodal').hidden`);
    const kept = closed ? null : await fieldVal(tab, 'New mount');
    check(`(F2 ${how}) refused mount Enter, then close by ${how}: exactly ONE PATCH in total; ${how === 'X button' ? 'drawer closed' : 'drawer closed, or kept open with the text intact'}`,
      o.opened && w.writes === 1 && (closed || (how === 'Ctrl+,' && kept === REFUSED)), { opened: o.opened, closed, kept, writes: w.writes, by: w.by });
  }

  /* F3. a refusal on a SCROLLED pane: the banner covers no part of the refused input
         (input placed OFF px below the pane top before Enter, as a wheel-scrolling user would) */
  // a shorter window (a laptop screen) gives the pane real scroll room above and below the mount form
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
  for (const OFF of [0, 20, 40]) {
    await openIso(tab, pid, 'mounts');
    const o = await openForm(tab, 'Add mount', 'New mount');
    // the user wheel-scrolls (REAL wheel events) until the input sits OFF px below the pane top, then types + Enter
    const paneR = await tab.eval(`(() => { const r = document.querySelector('#dBody').getBoundingClientRect(); return { top: r.top, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
    for (let i = 0; i < 60; i++) {
      const t = await tab.eval(`document.querySelector('#smodal input[aria-label="New mount"]').getBoundingClientRect().top`);
      if (t >= paneR.top + OFF && t <= paneR.top + OFF + 30) break;
      const dy = Math.max(-120, Math.min(120, t - paneR.top - OFF - 10));
      await tab.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: paneR.cx, y: paneR.cy, deltaX: 0, deltaY: dy });
      await sleep(120);
    }
    const pre = await tab.eval(`(() => { const b = document.querySelector('#dBody'); return { paneTop: b.getBoundingClientRect().top, scrollTop: b.scrollTop, scrollMax: b.scrollHeight - b.clientHeight, inputTop: document.querySelector('#smodal input[aria-label="New mount"]').getBoundingClientRect().top }; })()`);
    await tab.window(2000, 'New mount', async () => { await tab.type(REFUSED); await tab.key('Enter', 'Enter', 13); });
    const geo = await tab.eval(`(() => {
      const b = document.querySelector('#dSaveErr').getBoundingClientRect();
      const i = document.querySelector('#smodal input[aria-label="New mount"]');
      if (!i) return { noInput: true };
      const r = i.getBoundingClientRect();
      const hitTop = document.elementFromPoint(r.x + 30, r.top + 1);
      const hitMid = document.elementFromPoint(r.x + 30, r.top + r.height / 2);
      return { banner: { top: b.top, bottom: b.bottom }, input: { top: r.top, bottom: r.bottom }, overlap: Math.max(0, b.bottom - r.top),
        topHit: hitTop === i, midHit: hitMid === i, topHitIs: hitTop?.id || hitTop?.tagName, focus: document.activeElement === i };
    })()`);
    const err = await tab.saveErr();
    check(`(F3 input ${OFF}px below pane top) mount refused: banner shown, its bottom is above the input top, a click on the input top edge hits the input`,
      o.opened && /host path does not exist/.test(err) && !geo.noInput && geo.overlap === 0 && geo.topHit && geo.midHit, { opened: o.opened, pre, err, geo });
  }

  /* F3b. after a refusal the user wheels away, Tabs on and Shift+Tabs back to the refused input:
          the browser scrolls it in under scroll-padding — it must land fully below the banner */
  {
    const paneR = await tab.eval(`(() => { const r = document.querySelector('#dBody').getBoundingClientRect(); return { top: r.top, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
    const wheel = async (dy) => { await tab.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: paneR.cx, y: paneR.cy, deltaX: 0, deltaY: dy }); await sleep(150); };
    const before = { focus: await tab.focused(), err: await tab.saveErr() };
    await tab.key('Tab', 'Tab', 9); await sleep(100);
    for (let i = 0; i < 5; i++) await wheel(120);
    await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9 });
    await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9 });
    await sleep(300);
    const geo = await tab.eval(`(() => {
      const b = document.querySelector('#dSaveErr'); const br = b.getBoundingClientRect();
      const i = document.querySelector('#smodal input[aria-label="New mount"]'); if (!i) return { noInput: true };
      const r = i.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + 30, r.top + 1);
      return { bannerShown: !b.hidden, banner: { top: br.top, bottom: br.bottom }, input: { top: r.top, bottom: r.bottom }, overlap: Math.max(0, br.bottom - r.top), topHit: hit === i, topHitIs: hit?.id || hit?.tagName, focus: document.activeElement === i };
    })()`);
    // The contract every browser-driven scroll relies on (focus(), scrollIntoView, Tab): the reserved
    // scroll-padding must reach past the STUCK banner's bottom. The banner sticks at the pane's content
    // edge (#dBody padding-top below the scrollport top), so reserving only its height + gap leaves the
    // landing line under it (verify r1 measured a 4-5 px overlap and a click swallowed by the banner).
    const contract = await tab.eval(`(() => {
      const body = document.querySelector('#dBody'); const b = document.querySelector('#dSaveErr');
      body.scrollTop = Math.max(body.scrollTop, 200); // stuck, not in its natural spot
      const bodyTop = body.getBoundingClientRect().top + body.clientTop;
      const stuckBottom = b.getBoundingClientRect().bottom - bodyTop;
      const reserved = parseFloat(body.style.scrollPaddingTop || getComputedStyle(body).scrollPaddingTop) || 0;
      return { stuckBottom, reserved, ok: reserved >= stuckBottom + 4 };
    })()`);
    check('(F3c) the scroll-padding reserved for the banner reaches past the STUCK banner bottom (+4 px)', contract.ok, contract);
    await tab.send('Emulation.clearDeviceMetricsOverride');
    check('(F3b) Shift+Tab back to the refused input on a scrolled pane: the banner covers none of it',
      before.focus === 'New mount' && geo.bannerShown && geo.focus && geo.overlap === 0 && geo.topHit, { before, geo });
  }

  /* F4. refused Enter in env (slow server), user moves to the port form and types: focus + text stay in ports */
  {
    await openIso(tab, pid, 'env');
    const op = await openForm(tab, 'Publish a port', 'New published port');
    await tab.type('abc'); await tab.key('Enter', 'Enter', 13); // client refusal; the port form stays open with "abc"
    await sleep(300);
    const oe = await openForm(tab, 'Add variable', 'New environment variable');
    fx.delayPatchMs = 1200;
    await tab.type('HOME=/tmp/x'); await tab.key('Enter', 'Enter', 13); // PATCH held 1.2 s, then refused (reserved)
    await sleep(100);
    const pxy = await fieldXY(tab, 'New published port');
    await tab.click(pxy); await sleep(80);
    await tab.eval(`document.querySelector('#smodal [aria-label="New published port"]').select()`);
    await tab.type('3000:30');
    await sleep(2200); // the env refusal lands and repaints
    await tab.type('00');
    fx.delayPatchMs = 0;
    await sleep(200);
    const r = { focus: await tab.focused(), port: await fieldVal(tab, 'New published port'), env: await fieldVal(tab, 'New environment variable'), err: await tab.saveErr() };
    check('(F4) env refusal lands while the user types in the port form: focus stays in ports, port = "3000:3000", env text untouched',
      op.opened && oe.opened && r.focus === 'New published port' && r.port === '3000:3000' && r.env === 'HOME=/tmp/x', { op, oe, ...r });
  }

  /* F5. a pending access-confirm card does not survive close/reopen, and nothing is saved */
  {
    fx.accessReq = true;
    await openIso(tab, pid, 'env');
    const o = await openForm(tab, 'Add variable', 'New environment variable');
    const w = await tab.window(2000, 'New environment variable', async () => { await tab.type('FOO=bar'); await tab.key('Enter', 'Enter', 13); });
    const card1 = await tab.eval(`!!document.querySelector('#smodal .acc-warn')`);
    await tab.eval(`document.activeElement?.blur?.()`);
    await tab.key('Escape', 'Escape', 27); await sleep(300);
    let closed = await tab.eval(`document.querySelector('#smodal').hidden`);
    if (!closed) { await tab.key('Escape', 'Escape', 27); await sleep(300); closed = await tab.eval(`document.querySelector('#smodal').hidden`); }
    const w2 = await tab.window(1500, '__none__', async () => {
      await tab.eval(`window.__station.drawer.open('settings', { focus: 'env' })`);
    });
    const card2 = await tab.eval(`!!document.querySelector('#smodal .acc-warn')`);
    const env = (await settingsOf(base, pid)).container?.env ?? {};
    fx.accessReq = false;
    check('(F5) access-confirm card shown (0 PATCH), Escape closes, reopen shows NO stale card, FOO not saved',
      o.opened && card1 && closed && !card2 && !('FOO' in env) && !Object.keys({ ...w.by, ...w2.by }).some((k) => k.startsWith('PATCH')),
      { opened: o.opened, card1, closed, card2, env, by: w.by, by2: w2.by });
  }

  /* V-b3 (BUG-283 r6, verify r5 b1). "Save and cancel the request" builds the env map when it RUNS:
     a variable another writer added while the card was armed survives the confirmed save. */
  {
    fx.accessReq = true;
    await openIso(tab, pid, 'env');
    const o = await openForm(tab, 'Add variable', 'New environment variable');
    await tab.type('FOO=bar'); await tab.key('Enter', 'Enter', 13);
    await sleep(1200);
    const card = await tab.eval(`!!document.querySelector('#smodal .acc-warn')`);
    // another writer (a second tab / an approved request) adds OTHER meanwhile
    const cur = (await settingsOf(base, pid)).container?.env ?? {};
    await fetch(`${base}/api/projects/${pid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ container: { env: { ...cur, OTHER_B283R6: '1' } } }) });
    const go = await tab.eval(`(() => { const b = document.querySelector('#smodal .acc-go'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (go) await tab.click(go);
    await sleep(1500);
    fx.accessReq = false;
    const env = (await settingsOf(base, pid)).container?.env ?? {};
    check('(V-b3) "Save and cancel" saves FOO without deleting OTHER_B283R6, which another writer added while the card was armed',
      o.opened && card && !!go && env.FOO === 'bar' && env.OTHER_B283R6 === '1', { opened: o.opened, card, go: !!go, env });
  }

  /* P1 (plan review item 1). Two writers of ONE list: the user types a mount, then clicks × on another.
        The add-form's blur-save and the × save must both land: final = the old list - B + C. */
  {
    const mk = () => { const x = fs.mkdtempSync(path.join(os.tmpdir(), 'b283r4-m-')); dirs.push(x); return x; };
    const A = mk(), B = mk(), C = mk();
    await fetch(`${base}/api/projects/${pid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mounts: [{ hostPath: A, containerPath: '/mnt/a', readOnly: false }, { hostPath: B, containerPath: '/mnt/b', readOnly: false }] }) });
    await tab.send('Page.reload'); await sleep(500); await tab.waitFor('window.__station !== undefined'); // the app reads the new mounts
    await openIso(tab, pid, 'mounts');
    const o = await openForm(tab, 'Add mount', 'New mount');
    let xb = null, rowsSeen = null;
    const w = await tab.window(3000, 'New mount', async () => {
      await tab.type(`${C}:/mnt/c`);
      rowsSeen = await tab.eval(`[...document.querySelectorAll('#smodal .mrow')].map((r) => r.textContent.slice(0, 60))`);
      xb = await tab.eval(`(() => { const rows = [...document.querySelectorAll('#smodal .mrow')].filter((r) => r.textContent.includes('/mnt/b')); const b = rows[0]?.querySelector('button.x'); if (!b) return null; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (xb) await tab.click(xb);
    });
    const mounts = ((await settingsOf(base, pid)).mounts ?? []).map((m) => m.containerPath).sort();
    check('(P1) type a new mount C, then click × on mount B: the stored list is exactly [A, C] (neither save lost)',
      o.opened && JSON.stringify(mounts) === JSON.stringify(['/mnt/a', '/mnt/c']), { opened: o.opened, xb, rowsSeen, mounts, writes: w.writes, by: w.by });
  }

  /* P2 (plan review item 2). The project switches while an env save waits on its access-request check:
        the save must not land in the OTHER project. */
  {
    const projDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'b283r4-proj2-')); dirs.push(projDir2);
    const pid2 = (await (await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: projDir2, name: 'b283r4-other' }) })).json()).project.id;
    await fetch(`${base}/api/projects/${pid2}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ isolation: 'container' }) });
    await openIso(tab, pid, 'env');
    const o = await openForm(tab, 'Add variable', 'New environment variable');
    fx.delayAccessMs = 1200;
    await tab.type('B283R4_SWITCH=1'); await tab.key('Enter', 'Enter', 13);
    await sleep(200);
    await tab.eval(`window.__station.selectProject(${JSON.stringify(pid2)})`);
    await sleep(2500);
    fx.delayAccessMs = 0;
    const env2 = (await settingsOf(base, pid2)).container?.env ?? {};
    check('(P2) project switched mid-save: the env var is NOT written into the other project', o.opened && !('B283R4_SWITCH' in env2), { opened: o.opened, otherEnv: env2 });
    await tab.eval(`window.__station.selectProject(${JSON.stringify(pid)})`);
  }

  /* P3 (plan review item 4). A refusal that lands after close + reopen does not show in the new drawer. */
  {
    await openIso(tab, pid, 'mounts');
    const o = await openForm(tab, 'Add mount', 'New mount');
    fx.delayPatchMs = 1500;
    await tab.type('/nonexistent-b283r4/late'); await tab.key('Enter', 'Enter', 13);
    await sleep(150);
    await openIso(tab, pid, 'mounts'); // X-close + reopen while the PATCH is held
    await sleep(2000); // the refusal lands now
    fx.delayPatchMs = 0;
    const err = await tab.saveErr();
    const form = await tab.input('New mount');
    check('(P3) a refusal landing after close+reopen: no banner and no form/draft resurrected in the new drawer', o.opened && err === '' && !form, { opened: o.opened, err, form });
  }

  /* P5 (plan review item 5). The user leaves a field by clicking a non-focusable spot; a repaint must not pull focus back. */
  {
    await openIso(tab, pid, 'mounts');
    const xy = await fieldXY(tab, 'Base image');
    await tab.click(xy); await sleep(100);
    const away = await tab.eval(`(() => { const r = document.querySelector('#dTitle').getBoundingClientRect(); return { x: r.x + 4, y: r.y + r.height / 2 }; })()`);
    await tab.click(away); await sleep(100);
    for (let i = 0; i < 3; i++) { await tab.eval('window.__station.drawer.repaintLive()'); await sleep(100); }
    const f = await tab.focused();
    check('(P5) after clicking away from a field, background repaints do not put focus back in it', f !== 'Base image', { focus: f });
  }

  /* ── round 5: the verify-r4 breaks ───────────────────────────────────────── */

  /* V-b1. a row Enter (its blur queues a re-run while the PATCH is held), then the user clicks back
           and types more WITHOUT committing: only the committed value is stored. */
  for (const row of [
    { name: 'Spend cap', focus: 'model', aria: 'Spend cap in US dollars', first: '3', more: '00', want: 3, read: (st) => st.maxBudgetUsd },
    { name: 'Allowed tools', focus: 'caps', aria: 'Allowed tools', first: 'Read', more: ', Bash', want: ['Read'], read: (st) => st.allowedTools },
  ]) {
    await openIso(tab, pid, row.focus);
    const xy = await fieldXY(tab, row.aria);
    await tab.click(xy); await sleep(100);
    await tab.eval(`document.querySelector('#smodal [aria-label=${JSON.stringify(row.aria)}]').select()`);
    fx.delayPatchMs = 2000;
    const w = await tab.window(5000, row.aria, async () => {
      await tab.type(row.first); await tab.key('Enter', 'Enter', 13);
      await sleep(200);
      const again = await fieldXY(tab, row.aria);
      await tab.click(again); await sleep(60);
      await tab.key('End', 'End', 35);
      await tab.type(row.more);
    });
    fx.delayPatchMs = 0;
    const stored = row.read(await settingsOf(base, pid));
    const shown = await fieldVal(tab, row.aria);
    check(`(V-b1 ${row.name}) commit "${row.first}" (PATCH held), click back, type "${row.more}" without committing -> stored ${JSON.stringify(row.want)}, ONE write, the uncommitted text still shown`,
      JSON.stringify(stored) === JSON.stringify(row.want) && w.writes === 1 && typeof shown === 'string' && shown.endsWith(row.more.trim()), { stored, writes: w.writes, by: w.by, shown, focus: await tab.focused() });
  }

  /* V-b1b. two commits on Base image while the first is held: the second is NOT dropped. */
  {
    await openIso(tab, pid, 'mounts');
    let xy = await fieldXY(tab, 'Base image');
    await tab.click(xy); await sleep(100);
    await tab.eval(`document.querySelector('#smodal [aria-label="Base image"]').select()`);
    fx.delayPatchMs = 1500;
    let typed2 = null;
    const w = await tab.window(6000, 'Base image', async () => {
      await tab.type('alpine:3'); await tab.key('Enter', 'Enter', 13);
      await sleep(250);
      xy = await fieldXY(tab, 'Base image');
      if (xy) { await tab.click(xy); await sleep(60); await tab.eval(`document.querySelector('#smodal [aria-label="Base image"]').select()`); await tab.type('debian:12'); typed2 = await fieldVal(tab, 'Base image'); await tab.key('Enter', 'Enter', 13); }
    });
    fx.delayPatchMs = 0;
    const stored = (await settingsOf(base, pid)).container?.image;
    check('(V-b1b) Base image: commit "alpine:3" (held), then commit "debian:12" -> "debian:12" stored (second commit not dropped)', stored === 'debian:12', { stored, reachable: !!xy, typed2, writes: w.writes, by: w.by, err: await tab.saveErr() });
  }

  /* V-b2. an env value keeps its trailing space */
  {
    await openIso(tab, pid, 'env');
    const o = await openForm(tab, 'Add variable', 'New environment variable');
    await tab.window(2000, 'New environment variable', async () => { await tab.type('TRAIL=bar '); await tab.key('Enter', 'Enter', 13); });
    const env = (await settingsOf(base, pid)).container?.env ?? {};
    check('(V-b2) env "TRAIL=bar " is stored with its trailing space', o.opened && env.TRAIL === 'bar ', { opened: o.opened, TRAIL: JSON.stringify(env.TRAIL) });
  }

  /* V-c1. machine Defaults: "Custom model id…" chosen with a REAL ArrowDown, id half-typed, a
           repaint(): text, row and focus survive */
  {
    await tab.eval(`(() => { const S = window.__station; if (S.drawer.isOpen()) document.querySelector('#dClose').click(); S.drawer.open('settings', { focus: 'globalModel' }); })()`);
    await tab.waitFor(`!document.querySelector('#smodal').hidden`); await sleep(800);
    const sel = await tab.eval(`(() => { const s = document.querySelector('#smodal select[aria-label="Global default model"]') ?? document.querySelector('#gModelSel'); if (!s) return null; s.scrollIntoView({ block: 'center' }); s.focus(); return { id: s.id, n: s.options.length, idx: s.selectedIndex, customIdx: [...s.options].findIndex((o) => /Custom model id/.test(o.textContent)) }; })()`);
    let r = { sel };
    if (sel && sel.customIdx >= 0) {
      for (let i = sel.idx; i < sel.customIdx; i++) { await tab.key('ArrowDown', 'ArrowDown', 40); await sleep(30); }
      await sleep(200);
      await tab.type('claude-opus-');
      await tab.eval('window.__station.drawer.repaint()');
      await sleep(600);
      await tab.type('4-8');
      await sleep(150);
      r = { ...r, value: await fieldVal(tab, 'Custom global default model id'), focus: await tab.focused(),
        rowShown: await tab.eval(`!document.querySelector('#gModelCustom')?.hidden`) };
    }
    check('(V-c1) custom global model id: "claude-opus-" + repaint() + "4-8" -> field holds "claude-opus-4-8", row shown, focus kept',
      r.value === 'claude-opus-4-8' && r.rowShown === true && r.focus === 'Custom global default model id', r);
  }

  /* V-c2. an add-form save that succeeds late does not close the form over text typed after Enter */
  {
    await openIso(tab, pid, 'env');
    const o = await openForm(tab, 'Add variable', 'New environment variable');
    fx.delayPatchMs = 1500;
    await tab.type('AAA=1'); await tab.key('Enter', 'Enter', 13);
    await sleep(150);
    await tab.eval(`document.querySelector('#smodal [aria-label="New environment variable"]').select()`);
    await tab.type('BBB');
    await sleep(2600);
    await tab.type('=2');
    fx.delayPatchMs = 0;
    await sleep(200);
    const r = { value: await fieldVal(tab, 'New environment variable'), focus: await tab.focused(), env: (await settingsOf(base, pid)).container?.env ?? {} };
    check('(V-c2) AAA=1 saved late while the user typed "BBB=2": AAA stored, the form stays open with "BBB=2" and focus',
      o.opened && r.env.AAA === '1' && r.value === 'BBB=2' && r.focus === 'New environment variable', { opened: o.opened, ...r });
  }

  /* V-d1. an armed confirm (git init on a non-git project) does not survive X-close + reopen */
  {
    await tab.eval(`(() => { const S = window.__station; if (S.drawer.isOpen()) document.querySelector('#dClose').click(); S.selectProject(${JSON.stringify(pid)}); S.drawer.open('settings', { focus: 'git' }); })()`);
    await tab.waitFor(`!document.querySelector('#smodal').hidden`); await sleep(1500);
    const b = await tab.eval(`(() => { const b = [...document.querySelectorAll('#smodal button')].find((x) => x.textContent.trim() === 'git init'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (b) await tab.click(b);
    await sleep(300);
    const armedNow = () => tab.eval(`!![...document.querySelectorAll('#smodal button')].find((x) => x.textContent.trim() === 'Init repository')`);
    const armed1 = await armedNow();
    const xb = await tab.eval(`(() => { const r = document.querySelector('#dClose').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await tab.click(xb); await sleep(300);
    const closed = await tab.eval(`document.querySelector('#smodal').hidden`);
    await tab.eval(`window.__station.drawer.open('settings', { focus: 'git' })`);
    await sleep(1500);
    const armed2 = await armedNow();
    check('(V-d1) the armed "Init repository" card does not survive X-close and reopen', !!b && armed1 && closed && !armed2, { initButton: !!b, armed1, closed, armed2 });
  }

  /* V-d2. a late refusal after a category switch stays visible, LABELLED with the section it came from */
  {
    await openIso(tab, pid, 'mounts');
    const o = await openForm(tab, 'Add mount', 'New mount');
    fx.delayPatchMs = 1500;
    await tab.type('/nonexistent-b283r5/late'); await tab.key('Enter', 'Enter', 13);
    await sleep(150);
    const rail = await tab.eval(`(() => { const b = document.querySelector('#smodal .srail-item[data-cat="model"]'); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await tab.click(rail);
    await sleep(2200);
    fx.delayPatchMs = 0;
    const err = await tab.saveErr();
    const title = await tab.eval(`document.querySelector('#dTitle').textContent`);
    check('(V-d2) refusal landing after a switch to "Model & spend": banner shown and labelled "Isolation & environment — …"',
      o.opened && /^Isolation & environment — could not save mounts/.test(err), { opened: o.opened, title, err });
  }

  /* V-d3 (BUG-283 r6, verify r5 d1). a tool toggle whose PATCH fails AFTER the drawer was closed
     and reopened: the reopened drawer shows no banner for it; the footer (visible once closed) has it. */
  const warns = [];
  tab.ws.on('message', (m) => { const j = JSON.parse(m); if (j.method === 'Runtime.consoleAPICalled' && j.params.type === 'warning') warns.push(j.params.args.map((a) => a.value ?? '').join(' ')); });
  await tab.send('Runtime.enable');
  for (const how of ['X', 'Escape']) {
    warns.length = 0;
    await tab.eval(`(() => { const S = window.__station; if (S.drawer.isOpen()) document.querySelector('#dClose').click(); S.selectProject(${JSON.stringify(pid)}); S.drawer.open('settings', { focus: 'integrations' }); })()`);
    await tab.waitFor(`!document.querySelector('#smodal').hidden`); await sleep(800);
    const sw = await tab.eval(`(() => { const b = document.querySelector('#smodal [aria-label="Toggle Playwright"]'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    fx.failPatchMs = 1500;
    if (sw) await tab.click(sw);
    await sleep(150);
    if (how === 'X') { const xb = await tab.eval(`(() => { const r = document.querySelector('#dClose').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`); await tab.click(xb); }
    else await tab.key('Escape', 'Escape', 27);
    await sleep(250);
    const closed = await tab.eval(`document.querySelector('#smodal').hidden`);
    await tab.eval(`window.__station.drawer.open('settings', { focus: 'integrations' })`);
    await sleep(2300);
    fx.failPatchMs = 0;
    const err = await tab.saveErr();
    // the app's footer path (ctx.notify -> say) logs every error as console.warn('[station]', …)
    const footer = warns.filter((w) => /could not save tool settings: b283r6 injected/.test(w));
    check(`(V-d3/${how}) a tool-toggle save failing after ${how}-close + reopen: no banner in the reopened drawer, the footer path carries it`,
      !!sw && closed && err === '' && footer.length === 1, { toggle: !!sw, closed, banner: err, footerWarns: footer });
  }

  /* V-d4. the same late failure while the drawer stays open in the same section DOES reach the banner */
  {
    await tab.eval(`(() => { const S = window.__station; if (S.drawer.isOpen()) document.querySelector('#dClose').click(); S.selectProject(${JSON.stringify(pid)}); S.drawer.open('settings', { focus: 'integrations' }); })()`);
    await tab.waitFor(`!document.querySelector('#smodal').hidden`); await sleep(800);
    const sw = await tab.eval(`(() => { const b = document.querySelector('#smodal [aria-label="Toggle Playwright"]'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    fx.failPatchMs = 1200;
    if (sw) await tab.click(sw);
    await sleep(1800);
    fx.failPatchMs = 0;
    const err = await tab.saveErr();
    check('(V-d4) the same late failure with the drawer still open reaches the inline banner', !!sw && /could not save tool settings: b283r6 injected/.test(err), { toggle: !!sw, banner: err });
  }
}

try {
  await run();
} catch (e) {
  console.error(e); fail++;
} finally {
  for (const p of procs) stopByPid(p);
  await sleep(500);
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
