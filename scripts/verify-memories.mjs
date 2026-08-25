/**
 * Agent-memories verification — routes with a real fixture on disk, deletion
 * proven byte-for-byte (backup identical, file gone, index line removed), and
 * a real-browser click-through of the drawer view.
 *
 *   node scripts/verify-memories.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import WebSocket from 'ws';

/* Never a fixed port: two suites defaulting to the same number collide the
   moment both run (observed: verify-ui + verify-sessions on 4319). The OS
   hands out a free one; the env var still pins it when a run needs to. */
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_MEMORIES_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mem-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mem-chrome-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

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
      try { if (await this.eval(expr)) return true; } catch { /* nav */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let server = null, browser = null;
const cleanupDirs = [];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  // Fixture: project dir + memory files in its encoded store dir.
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mem-proj-'));
  cleanupDirs.push(projDir);
  const encoded = projDir.replace(/[/.]/g, '-');
  const memDir = path.join(os.homedir(), '.claude', 'projects', encoded, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  cleanupDirs.push(path.dirname(memDir));
  fs.writeFileSync(path.join(memDir, 'user-likes-tabs.md'),
    '---\nname: user-likes-tabs\ndescription: The user prefers tabs over spaces\nmetadata:\n  type: user\n---\n\nThe user prefers tabs.\n');
  fs.writeFileSync(path.join(memDir, 'project-uses-bun.md'),
    '---\nname: project-uses-bun\ndescription: This project builds with bun, not npm\nmetadata:\n  type: project\n---\n\nBuilds with bun.\n');
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'),
    '- [User likes tabs](user-likes-tabs.md) — indentation preference\n- [Project uses bun](project-uses-bun.md) — build tool\n');

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'mem-fixture' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`could not register fixture: ${JSON.stringify(reg)}`);
  const memApi = `${BASE}/api/projects/${pid}/memories`;

  console.log('\n=== memories: list / read ===');
  const list = await (await fetch(memApi)).json();
  const files = list.memories ?? [];
  check('lists the real files with frontmatter descriptions and the index flagged',
    files.length === 3
      && files.some((f) => f.name === 'user-likes-tabs.md' && f.description === 'The user prefers tabs over spaces' && f.type === 'user')
      && files.some((f) => f.isIndex && f.name === 'MEMORY.md'),
    files.map((f) => `${f.name}${f.isIndex ? ' [index]' : ''}: ${f.description ?? '-'}`).join(' | '));
  const read = await (await fetch(`${memApi}?dir=${encodeURIComponent(encoded)}&name=user-likes-tabs.md`)).json();
  check('reads a memory back verbatim', read.content?.includes('The user prefers tabs.'), JSON.stringify(read.content?.slice(-40)));

  console.log('\n=== memories: guardrails ===');
  const trav = await fetch(`${memApi}?dir=${encodeURIComponent(encoded)}&name=..%2F..%2Fetc%2Fpasswd`);
  check('path traversal in name is refused', trav.status === 400, `HTTP ${trav.status}`);
  const idxDel = await fetch(`${memApi}?dir=${encodeURIComponent(encoded)}&name=MEMORY.md`, { method: 'DELETE' });
  check('deleting the index is refused with the reason', idxDel.status === 400, `HTTP ${idxDel.status}: ${JSON.stringify((await idxDel.json()).error)}`);
  const wrongDir = await fetch(`${memApi}?dir=some-other-dir&name=user-likes-tabs.md`, { method: 'DELETE' });
  check('a dir not belonging to the project is refused', wrongDir.status === 400, `HTTP ${wrongDir.status}`);

  console.log('\n=== memories: delete (backup-verified, index pruned) ===');
  const victim = path.join(memDir, 'user-likes-tabs.md');
  const preHash = sha(victim);
  const del = await (await fetch(`${memApi}?dir=${encodeURIComponent(encoded)}&name=user-likes-tabs.md`, { method: 'DELETE' })).json();
  const gone = !fs.existsSync(victim);
  const bakOk = del.backup?.path && fs.existsSync(del.backup.path) && sha(del.backup.path) === preHash;
  check('file is GONE from disk and the backup is byte-identical', gone && bakOk,
    JSON.stringify({ gone, backup: del.backup?.path, hashMatch: bakOk }));
  const idxNow = fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8');
  check('its MEMORY.md line was removed (and the index backed up first)',
    !idxNow.includes('user-likes-tabs.md') && idxNow.includes('project-uses-bun.md')
      && del.indexEdited?.removedLines === 1 && fs.existsSync(del.indexEdited?.backup ?? ''),
    JSON.stringify({ idxNow: idxNow.trim(), indexEdited: del.indexEdited }));
  const relist = await (await fetch(memApi)).json();
  check('re-list from disk no longer shows it', !(relist.memories ?? []).some((f) => f.name === 'user-likes-tabs.md'),
    (relist.memories ?? []).map((f) => f.name).join(','));

  console.log('\n=== memories: drawer UI (real browser) ===');
  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1280,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `document.querySelectorAll('#tree button.proj').length > 0`);
  await cdp.eval(`window.__station.drawer.open('memories')`);
  const listed = await cdp.waitFor('memory rows', `document.querySelectorAll('#vMemories .memrow').length >= 2`);
  check('drawer lists the memories with their descriptions',
    listed && (await cdp.eval(`document.querySelector('#vMemories').textContent`)).includes('This project builds with bun'),
    await cdp.eval(`[...document.querySelectorAll('#vMemories .memrow .l')].map((n) => n.textContent.slice(0, 60))`));
  await cdp.eval(`[...document.querySelectorAll('#vMemories .memrow .set')].find((r) => r.textContent.includes('project-uses-bun'))?.click()`);
  const readUi = await cdp.waitFor('memory body', `document.querySelector('#vMemories .memtext')?.textContent.includes('Builds with bun')`);
  check('clicking a memory shows its full content', readUi, await cdp.eval(`document.querySelector('#vMemories .memtext')?.textContent.slice(-30)`));
  // Delete through the armed confirm, then prove disk state.
  await cdp.eval(`[...document.querySelectorAll('#vMemories .mini.x')].at(0)?.click()`);
  await cdp.waitFor('armed confirm', `[...document.querySelectorAll('#vMemories .mini')].some((b) => b.textContent === 'Delete it')`);
  await cdp.eval(`[...document.querySelectorAll('#vMemories .mini')].find((b) => b.textContent === 'Delete it')?.click()`);
  const uiGone = await cdp.waitFor('row gone after re-list', `document.querySelectorAll('#vMemories .memrow').length === 1`);
  check('UI delete: armed confirm → file really gone from disk, list re-read',
    uiGone && !fs.existsSync(path.join(memDir, 'project-uses-bun.md')),
    JSON.stringify({ uiRows: await cdp.eval(`document.querySelectorAll('#vMemories .memrow').length`), onDisk: fs.readdirSync(memDir) }));
  cdp.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(PROFILE, { recursive: true, force: true });
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
