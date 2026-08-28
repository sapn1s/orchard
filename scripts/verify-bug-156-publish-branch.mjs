/**
 * BUG-156 — after committing on a branch with NO upstream, the Git panel must
 * offer to PUBLISH the branch (push -u), not go quiet on "Fetch origin".
 *
 * Drives the REAL git-view UI in headless brave against scratch repos wired to
 * local bare "origin" remotes (no network, nothing real is pushed). Covers:
 *   1. publish (no upstream, remote present)  — the reported case
 *   2. the ref actually lands on the bare remote + indicator clears to fetch
 *   3. ahead indicator after a further local commit (upstream now set)
 *   4. rejected push surfaces an error in the panel, never silent
 *
 *   node scripts/verify-bug-156-publish-branch.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const SCRATCH = process.env.VERIFY_SCRATCH ?? path.join(os.homedir(), 'scratch');
const RUN = path.join(SCRATCH, `bug156-${Date.now()}`);
fs.mkdirSync(RUN, { recursive: true });
const SHOTS = path.join(RUN, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const DATA = path.join(RUN, 'data'); fs.mkdirSync(DATA, { recursive: true });
const PROFILE = path.join(RUN, 'chrome'); fs.mkdirSync(PROFILE, { recursive: true });
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const ROOT = path.resolve(import.meta.dirname, '..');

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_BUG156_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const ENV = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
function git(cwd, args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV } }).trim(); }
function gitRaw(cwd, args) { try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...ENV } }).trim(); } catch { return 'ERR'; } }

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && c.waiting.has(m.id)) { const { res, rej } = c.waiting.get(m.id); c.waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
    return c;
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.waiting.set(id, { res, rej })); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { try { if (await this.eval(expr)) return true; } catch { /* nav */ } await sleep(150); }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  async shot(file) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

// A scratch project on branch `rebrand/kenimai` with a bare "origin" remote and
// (by default) NO upstream configured — exactly the reported repo shape.
function makeProject(tag, { setUpstream = false, remoteAhead = false } = {}) {
  const work = path.join(RUN, `${tag}-work`);
  const bare = path.join(RUN, `${tag}-bare.git`);
  fs.mkdirSync(work, { recursive: true });
  git(work, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
  git(work, ['add', '-A']); git(work, ['commit', '-m', 'first']);
  git(RUN, ['init', '--bare', bare]);
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['switch', '-c', 'rebrand/kenimai']);
  fs.writeFileSync(path.join(work, 'b.txt'), 'rebranded\n');
  git(work, ['add', '-A']); git(work, ['commit', '-m', 'Rebranding to Kenimai']);
  if (remoteAhead) {
    // Remote already carries a DIVERGENT rebrand/kenimai — a plain publish
    // (push -u) must be rejected as non-fast-forward, not silently do nothing.
    const other = path.join(RUN, `${tag}-other`);
    git(RUN, ['clone', bare, other]);
    git(other, ['switch', '-c', 'rebrand/kenimai']);
    fs.writeFileSync(path.join(other, 'c.txt'), 'theirs\n');
    git(other, ['add', '-A']); git(other, ['commit', '-m', 'their kenimai']);
    git(other, ['push', '-u', 'origin', 'rebrand/kenimai']);
  }
  if (setUpstream) git(work, ['push', '-u', 'origin', 'rebrand/kenimai']);
  return { work, bare };
}

let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}
async function register(hostPath, name) {
  const r = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath, name }) })).json();
  if (!r.project?.id) throw new Error(`register failed: ${JSON.stringify(r)}`);
  return r.project.id;
}
// Read the sync control the way the user reads it.
const SYNC = `(() => { const b=document.querySelector('.gt-sync button'); const s=document.querySelector('.gt-sync small'); return b?{text:b.textContent,action:b.dataset.action,disabled:b.disabled,note:s?.textContent??'',err:document.querySelector('.gt-view-error')?.textContent??''}:null; })()`;

async function settledSync(cdp) {
  // The panel auto-fetches on open, which briefly flips the button to "Working…".
  // Read only once it has settled to a real label.
  await cdp.waitFor('sync settled', `(() => { const b=document.querySelector('.gt-sync button'); return b && b.textContent.length>0 && b.textContent!=='Working…' && !b.disabled===!b.disabled; })()`, 30_000);
  for (let i = 0; i < 40; i++) { const s = await cdp.eval(SYNC); if (s && s.text !== 'Working…' && !s.disabled) return s; await sleep(200); }
  return cdp.eval(SYNC);
}
async function openGit(cdp, pid) {
  await cdp.send('Page.navigate', { url: `${BASE}/#/git?project=${pid}` });
  await cdp.waitFor('git panel sync button', `(document.querySelector('.gt-sync button')?.textContent||'').length>0`, 30_000);
  return settledSync(cdp);
}

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const p1 = makeProject('publish');          // no upstream, remote present
  const p2 = makeProject('reject', { remoteAhead: true }); // remote diverged → push -u rejected
  const id1 = await register(p1.work, 'kenimai-publish');
  const id2 = await register(p2.work, 'kenimai-reject');

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', '--window-size=1400,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  // --- Scenario 1: publish offer on a no-upstream branch ---------------------
  console.log('\n=== scenario 1: no upstream → panel offers PUBLISH ===');
  const s1 = await openGit(cdp, id1);
  check('branch has no upstream but a remote exists — button offers to Publish (not Fetch)',
    s1 && s1.action === 'publish' && /Publish/.test(s1.text) && /kenimai/.test(s1.text) && !s1.disabled, s1);
  check('panel tells the user the branch is not on origin yet (does not go quiet)',
    s1 && /isn't on origin|not on origin/i.test(s1.note), s1?.note);
  await cdp.eval(`document.documentElement.dataset.theme='light'`); await sleep(150); await cdp.shot(path.join(SHOTS, 'publish-light.png'));
  await cdp.eval(`document.documentElement.dataset.theme='dark'`); await sleep(150); await cdp.shot(path.join(SHOTS, 'publish-dark.png'));

  // Bare origin has NO kenimai ref before we publish.
  const bareBefore = gitRaw(p1.bare, ['rev-parse', 'refs/heads/rebrand/kenimai']);
  check('sanity: origin does not yet carry rebrand/kenimai', bareBefore.startsWith('ERR'), bareBefore);

  // Click publish and wait for the ref to land + the button to clear to fetch.
  await cdp.eval(`document.querySelector('.gt-sync button').click()`);
  const landed = await (async () => {
    const t0 = Date.now(); const want = git(p1.work, ['rev-parse', 'HEAD']);
    while (Date.now() - t0 < 20_000) { const got = gitRaw(p1.bare, ['rev-parse', 'refs/heads/rebrand/kenimai']); if (got === want) return { ok: true, got, want }; await sleep(200); }
    return { ok: false, got: gitRaw(p1.bare, ['rev-parse', 'refs/heads/rebrand/kenimai']), want };
  })();
  check('pressing Publish actually lands the branch on origin (bare ref === local HEAD)', landed.ok, landed);
  await cdp.waitFor('button clears to fetch', `document.querySelector('.gt-sync button').dataset.action==='fetch'`, 15_000);
  const s1b = await cdp.eval(SYNC);
  check('after publishing, upstream is set and the indicator clears to Fetch origin',
    s1b && s1b.action === 'fetch' && /Fetch origin/.test(s1b.text), s1b);

  // --- Scenario 2: ahead indicator after a further local commit --------------
  console.log('\n=== scenario 2: local commit ahead of upstream → PUSH (↑1) ===');
  fs.writeFileSync(path.join(p1.work, 'd.txt'), 'more\n');
  git(p1.work, ['add', '-A']); git(p1.work, ['commit', '-m', 'one more']);
  const s2 = await openGit(cdp, id1);
  check('a commit ahead of the now-set upstream shows Push origin (↑1)',
    s2 && s2.action === 'push' && /↑1/.test(s2.text), s2);

  // --- Scenario 3: rejected push is reported, never silent -------------------
  console.log('\n=== scenario 3: divergent remote → publish REJECTED, surfaced ===');
  const s3 = await openGit(cdp, id2);
  check('no-upstream branch whose remote already diverged still offers Publish', s3 && s3.action === 'publish', s3);
  await cdp.eval(`document.querySelector('.gt-sync button').click()`);
  const errShown = await cdp.waitFor('push error surfaced', `(document.querySelector('.gt-view-error')?.textContent||'').length>0`, 15_000);
  const s3b = await cdp.eval(SYNC);
  const bareUntouched = gitRaw(p2.bare, ['rev-parse', 'refs/heads/rebrand/kenimai']);
  const theirHead = (() => { try { return git(path.join(RUN, 'reject-other'), ['rev-parse', 'HEAD']); } catch { return '?'; } })();
  check('rejected publish shows an error in the panel (not silent)', errShown && s3b && s3b.err.length > 0, s3b?.err);
  check('rejected publish did NOT overwrite the divergent remote ref', bareUntouched === theirHead, { bareUntouched, theirHead });
  await cdp.eval(`document.documentElement.dataset.theme='light'`); await sleep(150); await cdp.shot(path.join(SHOTS, 'reject-light.png'));
  await cdp.eval(`document.documentElement.dataset.theme='dark'`); await sleep(150); await cdp.shot(path.join(SHOTS, 'reject-dark.png'));

  cdp.close();
  console.log(`\nscreenshots in ${SHOTS}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => { console.error(`\nFATAL: ${err.message}\n${err.stack}`); process.exitCode = 1; })
  .finally(() => { stopByPid(browser); stopByPid(server); setTimeout(() => process.exit(process.exitCode ?? 0), 2000); });
