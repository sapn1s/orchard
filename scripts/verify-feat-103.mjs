/** FEAT-103 real-store browser proof. Writes only beneath SCRATCH. */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOME = os.homedir();
const SCRATCH = process.env.FEAT103_SCRATCH ?? path.join(HOME, 'scratch', 'csearch');
const DATA = path.join(SCRATCH, 'data');
const PROFILE = path.join(SCRATCH, 'brave-profile');
const SHOTS = path.join(SCRATCH, 'screenshots');
const STORE = process.env.CLAUDE_PROJECTS_DIR ?? path.join(HOME, '.claude', 'projects');
const SID = 'f504d398-390d-42b2-8117-e3dce7a631d0';
/*
 * The needle's session lives in a CONTAINER store dir (`-workspace-<id>`), so
 * it is only searchable once a project with that id is registered. Find the dir
 * that actually holds the session rather than naming anyone's private project
 * path here, and register a project whose id lands on the same store dir.
 */
const NEEDLE_DIR = fs.readdirSync(STORE).find((d) => fs.existsSync(path.join(STORE, d, `${SID}.jsonl`)));
const NEEDLE_PROJECT_NAME = (NEEDLE_DIR ?? '').replace(/^-workspace-/, '');
const NEEDLE = 'available only to approved organizations through Project Glasswing';
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, seen) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${JSON.stringify(seen)}`);
  ok ? pass++ : fail++;
};
async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && c.waiting.has(m.id)) { const x = c.waiting.get(m.id); c.waiting.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); } });
    return c;
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.waiting.set(id, { res, rej })); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value; }
  async waitFor(expression, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await this.eval(expression)) return true; } catch {} await sleep(100); } return false; }
  async shot(name) { const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); const out = path.join(SHOTS, name); fs.writeFileSync(out, Buffer.from(r.data, 'base64')); return out; }
}
function stop(child) { if (child?.exitCode === null) { try { child.kill('SIGTERM'); } catch {} } }
/*
 * Count live rg children. EVERY thread's children file has to be read: node
 * spawns from whichever thread happens to run the call, and reading only the
 * main thread's list made this counter answer 0 forever — a check that could
 * never fail is not a check.
 */
function rgChildren(pid) {
  try {
    let n = 0;
    for (const t of fs.readdirSync(`/proc/${pid}/task`)) {
      let ids = [];
      try { ids = fs.readFileSync(`/proc/${pid}/task/${t}/children`, 'utf8').trim().split(/\s+/).filter(Boolean); } catch { continue; }
      for (const id of ids) { try { if (fs.readFileSync(`/proc/${id}/comm`, 'utf8').trim() === 'rg') n++; } catch {} }
    }
    return n;
  } catch { return 0; }
}

let server, browser, cdp;
try {
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], { cwd: ROOT,
    env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: DATA }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await sleep(100); }
  if (!NEEDLE_DIR) throw new Error(`no session ${SID} anywhere under ${STORE} — this proof needs the real store`);
  const regRes = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: process.env.FEAT103_PROJECT ?? HOME, name: NEEDLE_PROJECT_NAME }) });
  if (!regRes.ok) throw new Error(`register the needle's project: ${regRes.status} ${await regRes.text()}`);
  /*
   * One project cannot produce a busy list, and a one-group list never shows
   * whether grouping, the caps or the show-more survive at scale. Register
   * whatever else this machine really has, and let the busy checks below run
   * against a store with many sessions in many projects.
   */
  for (const extra of [[ROOT, 'This repo'], [HOME, 'Home'], [path.join(HOME, 'Desktop'), 'Desktop']]) {
    if (!fs.existsSync(extra[0])) continue;
    await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: extra[0], name: extra[1] }) });
  }

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', '--window-size=1440,1000', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 80 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(100); } }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: base });
  await cdp.waitFor(`window.__station && document.querySelector('#findInput')`);
  const label = await cdp.eval(`({placeholder:findInput.placeholder, aria:findInput.getAttribute('aria-label')})`);
  check('field names titles and messages plus registered scope', /titles and messages/i.test(label.placeholder) && /registered projects/i.test(label.aria), label);

  // Sample continuously, INCLUDING while the search runs: polling only between
  // keystrokes never overlaps an rg at all and would pass on an empty store.
  let maxRg = 0;
  const rgPoll = setInterval(() => { maxRg = Math.max(maxRg, rgChildren(server.pid)); }, 5);
  for (let i = 1; i <= NEEDLE.length; i++) {
    await cdp.eval(`findInput.value=${JSON.stringify(NEEDLE.slice(0, i))};findInput.dispatchEvent(new Event('input'))`);
    await sleep(12);
  }
  const appeared = await cdp.waitFor(`[...document.querySelectorAll('.cs-hit mark')].some(x=>x.textContent.toLowerCase()===${JSON.stringify(NEEDLE.toLowerCase())})`, 30000);
  clearInterval(rgPoll);
  check('typing without Enter finds the real body-only needle', appeared, { maxRg });
  check('typing never leaves more than one rg child alive', maxRg >= 1 && maxRg <= 1, { maxRg, note: 'must see exactly one: zero would mean the counter never observed a scan' });
  const listShot = await cdp.shot('feat-103-results.png');
  const shape = await cdp.eval(`({sections:[...document.querySelectorAll('.search-section')].map(x=>x.textContent),groups:document.querySelectorAll('.cs-group').length,hits:document.querySelectorAll('.cs-hit').length})`);
  check('results have Sessions then grouped Messages sections', shape.sections[0] === 'Sessions' && shape.sections[1] === 'Messages' && shape.groups >= 1, { ...shape, listShot });
  /*
   * Click the fixture session's OWN hit, found by session id — never
   * `.cs-hit` first. The needle is a phrase from a real transcript, and once
   * agents discuss this suite the phrase appears in THEIR transcripts too, so
   * the real corpus outranks the fixture and the first row belongs to some
   * other session. That is corpus contamination, not a product defect: the
   * property under test is that clicking a hit lands on that hit's exact
   * rendered message, which does not depend on which hit ranks first.
   * The flat index is recomputed with renderContentSearch's own grouping and
   * caps, so it addresses the same row the user would click.
   */
  const hitIdx = await cdp.eval(`(()=>{
    const cs = window.__station.state.contentSearch;
    const shown = cs.result.hits.filter((h)=>cs.showTools || h.kind==='prose');
    const groups = []; const by = new Map();
    for (const h of shown) { const k = h.projectId+'\\0'+h.encodedDir+'\\0'+h.sessionId;
      let g = by.get(k); if (!g) { g = {key:k, hits:[]}; by.set(k,g); groups.push(g); } g.hits.push(h); }
    let n = 0;
    for (const g of groups.slice(0, cs.visibleGroups)) {
      const cap = cs.visibleHits.get(g.key) ?? 5;
      const hits = g.hits.slice(0, cap);
      for (let i = 0; i < hits.length; i++) if (hits[i].sessionId === ${JSON.stringify(SID)}) return n + i;
      n += hits.length;
    }
    return -1;
  })()`);
  check('the fixture session is among the rendered hits', hitIdx >= 0, { hitIdx, note: 'a negative index means the needle session is no longer rendered — the suite has lost its subject' });
  await cdp.eval(`document.querySelectorAll('.cs-hit')[${Math.max(hitIdx, 0)}].click()`);
  const landed = await cdp.waitFor(`window.__station.state.current.sessionId===${JSON.stringify(SID)} && document.querySelector('[data-i].search-landing')`, 30000);
  const landing = await cdp.eval(`(()=>{const x=document.querySelector('[data-i].search-landing');return x&&{index:Number(x.dataset.i),hasNeedle:x.textContent.includes('Project Glasswing'),text:x.textContent.slice(0,120)}})()`);
  check('click lands on and highlights the exact rendered message', landed && landing?.index === 4 && landing.hasNeedle, landing);
  const landingShot = await cdp.shot('feat-103-landing.png');

  // A query that really is everywhere: many hits across many sessions, which
  // is the only state in which the caps and the show-more mean anything.
  await cdp.eval(`findInput.value='npm run';findInput.dispatchEvent(new Event('input'))`);
  await cdp.waitFor(`document.querySelectorAll('.cs-group').length>=10`, 30000);
  const busy = await cdp.eval(`({groups:document.querySelectorAll('.cs-group').length,hits:document.querySelectorAll('.cs-hit').length,more:[...document.querySelectorAll('.cs-more')].map(x=>x.textContent),truncated:document.querySelector('.cs-truncated')?.textContent||'',
    perGroup:[...document.querySelectorAll('.cs-group')].map(g=>g.querySelectorAll('.cs-hit').length),
    clipped:[...document.querySelectorAll('.cs-hit')].map(h=>{const s=h.querySelector('.snip'),m=h.querySelector('mark');if(!m)return 'no-mark';const sr=s.getBoundingClientRect(),mr=m.getBoundingClientRect();return (mr.bottom>sr.bottom+1||mr.left>sr.right-8)?m.textContent.slice(0,16):null}).filter(Boolean)})`);
  const busyShot = await cdp.shot('feat-103-busy.png');
  check('busy results cap groups at 10 and hits at 5 per group, with show-more and honest truncation',
    busy.groups === 10 && busy.perGroup.every((n) => n <= 5) && busy.more.some((t) => /more session/i.test(t)) && /more/i.test(busy.truncated),
    { ...busy, busyShot, landingShot });
  // The row is one clamped line: a lead-in long enough to push the match off it
  // makes a hit look like a false positive. Nothing may be clipped.
  check('every rendered hit shows its highlighted match', busy.clipped.length === 0, { clipped: busy.clipped });

  // Slow typing: every keystroke crosses the debounce, so each one supersedes a
  // search that is already running. Nothing may pile up, and what finally shows
  // must belong to the LAST query, not to some overtaken one.
  const slow = 'npm run verify';
  let slowRg = 0;
  const slowPoll = setInterval(() => { slowRg = Math.max(slowRg, rgChildren(server.pid)); }, 5);
  for (let i = 1; i <= slow.length; i++) {
    await cdp.eval(`findInput.value=${JSON.stringify(slow.slice(0, i))};findInput.dispatchEvent(new Event('input'))`);
    await sleep(260);
  }
  const settled = await cdp.waitFor(`document.querySelectorAll('.cs-group').length>0 && !document.body.textContent.includes('searching message contents')`, 40000);
  clearInterval(slowPoll);
  const slowState = await cdp.eval(`({q:findInput.value,marks:[...new Set([...document.querySelectorAll('.cs-hit mark')].map(m=>m.textContent.toLowerCase()))]})`);
  check('slow typing never piles up searches and lands on the last query',
    settled && slowRg === 1 && slowState.marks.length === 1 && slowState.marks[0] === slow.toLowerCase(),
    { settled, slowRg, ...slowState });
} catch (err) {
  console.error(`FATAL ${err.stack ?? err}`); fail++;
} finally {
  try { cdp?.ws.close(); } catch {}
  stop(browser); stop(server);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
