/**
 * Git integration verification — real repos, real remotes (a local bare repo
 * stands in for GitHub so push/pull are proven without touching the network),
 * and a real-browser check of the crown chip.
 *
 *   node scripts/verify-git.mjs
 *
 * NOT covered here (says so rather than pretending): `gh repo create` — it
 * has no dry-run and a test would create a real repo on the user's account.
 * Its request path is identical to the verified actions; only the gh call
 * itself is unexercised.
 *
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
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
const PORT = Number(process.env.VERIFY_GIT_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const SCRATCH = process.env.VERIFY_GIT_SCRATCH ?? process.env.ORCHARD_SCRATCH ?? path.join(os.homedir(), 'scratch');
fs.mkdirSync(SCRATCH, { recursive: true });
if (!fs.statSync(SCRATCH).isDirectory()) throw new Error(`scratch root is not a directory: ${SCRATCH}`);
const scratch = (prefix) => fs.mkdtempSync(path.join(SCRATCH, prefix));
const DATA = scratch('cs-git-data-');
const PROFILE = scratch('cs-git-chrome-');
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 15_000 }).trim();
function changedPathCount(repo) {
  const fields = git(repo, ['status', '--porcelain=v1', '-uall', '-z']).split('\0');
  let count = 0;
  for (let i = 0; i < fields.length && fields[i]; i++, count++) {
    if (/^[RC]/.test(fields[i]) || /^[RC]/.test(fields[i].slice(1))) i++;
  }
  return count;
}
// Same independently-computed definition as GitStatus.added: an unterminated
// final text line is still a line.
const textLines = (b) => b.length ? b.toString('utf8').split('\n').length - 1 + (b[b.length - 1] === 10 ? 0 : 1) : 0;
function independentlyBudgetedUntracked(repo) {
  const files = git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  if (files.length > 5_000) return { included: false, lines: 0 };
  let bytes = 0, lines = 0;
  for (const file of files) {
    const target = path.join(repo, file), stat = fs.lstatSync(target);
    if (!stat.isFile()) continue;
    if (stat.size > 4 * 1024 * 1024 || bytes + stat.size > 32 * 1024 * 1024) return { included: false, lines: 0 };
    bytes += stat.size;
    const body = fs.readFileSync(target);
    if (!body.subarray(0, 8_000).includes(0)) lines += textLines(body);
  }
  return { included: true, lines };
}

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
const cleanupDirs = [DATA, PROFILE];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_STATION_TERMINAL: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  // Fixture: working repo + local bare "origin" ahead of it by one commit.
  const work = scratch('cs-git-work-');
  const bare = scratch('cs-git-bare-');
  cleanupDirs.push(work, bare);
  execFileSync('git', ['init', '-b', 'main', work]);
  git(work, ['config', 'user.email', 'verify@example.invalid']);
  git(work, ['config', 'user.name', 'verify']);
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'first']);
  execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['push', '-u', 'origin', 'main']);
  // Make origin one commit ahead (simulates a teammate) via a second clone.
  const clone2 = scratch('cs-git-c2-');
  cleanupDirs.push(clone2);
  execFileSync('git', ['clone', bare, path.join(clone2, 'c')]);
  const c2 = path.join(clone2, 'c');
  git(c2, ['config', 'user.email', 'verify@example.invalid']);
  git(c2, ['config', 'user.name', 'verify']);
  fs.writeFileSync(path.join(c2, 'b.txt'), 'teammate\n');
  git(c2, ['add', '-A']);
  git(c2, ['commit', '-m', 'teammate change']);
  git(c2, ['push']);
  // behind/ahead are measured against the last-FETCHED remote ref (statusOf
  // deliberately never touches the network) — fetch so "behind 1" is knowable.
  git(work, ['fetch']);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: work, name: 'git-fixture-with-a-deliberately-long-project-name' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  const g = (p) => fetch(`${BASE}/api/projects/${pid}/git${p}`);
  const post = (p, body) => fetch(`${BASE}/api/projects/${pid}/git${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  // Registration deliberately scaffolds Orchard's method into a project. Keep
  // that real-world dirt and measure later count assertions relative to it.
  const scaffoldDirty = Number(git(work, ['status', '--porcelain=v1', '-uall']).split('\n').filter(Boolean).length);
  // Local dirt under test: one modified + one untracked, added after measuring
  // the real scaffold baseline rather than pretending registration is clean.
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(work, 'new.txt'), 'untracked\n');

  console.log('\n=== git: status ===');
  const st = (await (await g('/status')).json()).status;
  const trackedNumstat = git(work, ['diff', '--numstat', 'HEAD', '--']).split('\n').filter(Boolean);
  const trackedTotals = trackedNumstat.reduce((n, line) => {
    const [a, d] = line.split('\t');
    return { added: n.added + Number(a), removed: n.removed + Number(d) };
  }, { added: 0, removed: 0 });
  const untrackedBudget = independentlyBudgetedUntracked(work);
  const expectedTotals = { added: trackedTotals.added + (untrackedBudget.included ? untrackedBudget.lines : 0), removed: trackedTotals.removed };
  check('status reports branch, dirty count, behind, upstream, remote — all cross-checkable',
    st?.repo && st.branch === 'main' && st.dirty === scaffoldDirty + 2 && st.behind === 1 && st.ahead === 0
      && st.added === expectedTotals.added && st.removed === expectedTotals.removed
      && st.upstream === 'origin/main' && st.remoteUrl === bare && /first/.test(st.lastCommit ?? ''),
    { status: st, expectedAdded: expectedTotals.added, actualAdded: st?.added, expectedRemoved: expectedTotals.removed, actualRemoved: st?.removed });

  console.log('\n=== git: selective staging, diff, commit ===');
  const noMsg = await post('/commit', { message: '  ' });
  check('empty commit message refused', noMsg.status === 400, `HTTP ${noMsg.status}`);
  const beforeChanges = await (await g('/changes')).json();
  check('change list reports modified and untracked with line counts',
    Array.isArray(beforeChanges.changes) && beforeChanges.changes.some((x) => x.path === 'a.txt' && x.type === 'modified' && x.added === 1)
      && beforeChanges.changes.some((x) => x.path === 'new.txt' && x.type === 'untracked' && x.added === 1),
    beforeChanges.changes);
  const diffA = await (await post('/diff', { path: 'a.txt' })).json();
  const diffNew = await (await post('/diff', { path: 'new.txt' })).json();
  check('correct diff is readable for tracked and untracked files',
    /\+two/.test(diffA.diff ?? '') && /\+untracked/.test(diffNew.diff ?? ''),
    { tracked: diffA.diff?.slice(-80), untracked: diffNew.diff?.slice(-80) });
  check('untracked diff never exposes its absolute host path',
    !diffNew.diff?.includes(work) && !diffNew.diff?.includes(SCRATCH), diffNew.diff?.split('\n').slice(0, 5));
  const stagedA = await (await post('/stage', { path: 'a.txt', staged: true })).json();
  const afterStageA = await (await g('/changes')).json();
  check('stage one file and not another', Array.isArray(stagedA.paths) && Array.isArray(afterStageA.changes) && stagedA.paths.find((x) => x.path === 'a.txt')?.staged === true
    && afterStageA.changes.find((x) => x.path === 'a.txt')?.staged === true
    && afterStageA.changes.find((x) => x.path === 'new.txt')?.staged === false,
  { compact: stagedA.paths, changes: afterStageA.changes });
  const hostileMsg = '-via $(printf injected) `printf injected`';
  const c = await (await post('/commit', { message: hostileMsg })).json();
  const realHead = git(work, ['log', '-1', '--format=%h %s']);
  const committedNames = git(work, ['show', '--pretty=', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  check('only staged file landed; hostile message stayed literal; unstaged file remains dirty',
    c.committed && realHead === `${c.committed} ${hostileMsg}` && committedNames.join(',') === 'a.txt'
      && !git(work, ['status', '--porcelain', '--', 'a.txt'])
      && git(work, ['status', '--porcelain', '--', 'new.txt']) === '?? new.txt'
      && fs.readFileSync(path.join(work, 'new.txt'), 'utf8') === 'untracked\n',
    { api: c.committed, disk: realHead, committedNames, a: git(work, ['status', '--porcelain', '--', 'a.txt']), newFile: git(work, ['status', '--porcelain', '--', 'new.txt']), dirty: c.status?.dirty, raw: c });
  const again = await post('/commit', { message: 'nothing here' });
  check('dirty but entirely unstaged tree refuses a commit', again.status === 409, `HTTP ${again.status}`);
  const refused = await Promise.all([
    post('/stage', { path: '../../etc/passwd', staged: true }),
    post('/stage', { path: '/etc/passwd', staged: true }),
    post('/stage', { path: 'not-in-status', staged: true }),
  ]);
  check('paths absent from actual status are refused server-side', refused.every((r) => r.status === 400), refused.map((r) => r.status));
  const weird = ['space name.txt', 'quote"name.txt', 'line\nbreak.txt', 'žluťoučký.txt', '-f'];
  for (const name of weird) fs.writeFileSync(path.join(work, name), `${name}\n`);
  fs.symlinkSync('/etc', path.join(work, 'escape-link'));
  const weirdList = await (await g('/changes')).json();
  check('NUL porcelain preserves spaces, quotes, newlines, non-ASCII and leading-dash paths exactly',
    Array.isArray(weirdList.changes) && weird.every((name) => weirdList.changes.some((x) => x.path === name)), weirdList.changes?.map((x) => x.path) ?? weirdList);
  for (const name of weird) {
    const r = await post('/stage', { path: name, staged: true });
    check(`fixed argv stages adversarial path ${JSON.stringify(name)}`, r.status === 200, `HTTP ${r.status}`);
  }
  const escapeRefused = await post('/stage', { path: 'escape-link/passwd', staged: true });
  check('path through an escaping symlink is refused when absent from status', escapeRefused.status === 400, `HTTP ${escapeRefused.status}`);
  for (const name of weird) await post('/stage', { path: name, staged: false });
  for (const name of [...weird, 'escape-link']) fs.unlinkSync(path.join(work, name));
  fs.unlinkSync(path.join(work, 'new.txt'));

  console.log('\n=== git: pull then push (real bare remote) ===');
  const pullBlocked = await (await post('/pull')).json();
  // ff-only with local ahead + remote ahead = divergence → must refuse, not merge.
  check('pull is --ff-only: divergence refused honestly, no merge invented',
    !!pullBlocked.error && /ff-only|fast-forward|divergent/i.test(pullBlocked.error), JSON.stringify(pullBlocked).slice(0, 200));
  const pushed = await (await post('/push')).json();
  const bareHead = git(bare, ['log', '-1', '--format=%s', 'main']);
  check('push after… wait, divergence — push must ALSO fail until reconciled',
    !!pushed.error, JSON.stringify(pushed).slice(0, 160));
  // Reconcile: pull --rebase manually (the app deliberately does not auto-rebase), then push.
  git(work, ['pull', '--rebase']);
  const pushed2 = await (await post('/push')).json();
  const bareHead2 = git(bare, ['log', '-1', '--format=%s', 'main']);
  check('push lands on the remote once fast-forwardable (bare repo HEAD cross-checked)',
    pushed2.pushed === true && bareHead2 === hostileMsg && pushed2.status?.ahead === 0,
    JSON.stringify({ pushed: pushed2.pushed, bareHeadBefore: bareHead, bareHeadAfter: bareHead2 }));

  console.log('\n=== git: init + terminal ===');
  const plain = scratch('cs-git-plain-');
  cleanupDirs.push(plain);
  const reg2 = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: plain, name: 'git-plain' }),
  })).json();
  const initR = await (await fetch(`${BASE}/api/projects/${reg2.project.id}/git/init`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  check('init turns a non-repo into a repo on branch main (disk cross-checked)',
    initR.status?.repo === true && fs.existsSync(path.join(plain, '.git')) && git(plain, ['symbolic-ref', '--short', 'HEAD']) === 'main',
    JSON.stringify(initR.status));
  fs.writeFileSync(path.join(plain, 'first.txt'), 'first line\n');
  const unbornChanges = await (await fetch(`${BASE}/api/projects/${reg2.project.id}/git/changes`)).json();
  const unbornStage = await (await fetch(`${BASE}/api/projects/${reg2.project.id}/git/stage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'first.txt', staged: true }) })).json();
  const unbornAfter = await (await fetch(`${BASE}/api/projects/${reg2.project.id}/git/changes`)).json();
  check('repo with no HEAD lists and stages its first file', unbornChanges.changes?.[0]?.type === 'untracked'
    && unbornStage.paths?.[0]?.staged === true && unbornAfter.changes?.[0]?.staged === true,
  { before: unbornChanges.changes, compact: unbornStage.paths, after: unbornAfter.changes });
  const nonRepo = scratch('cs-git-nonrepo-'); cleanupDirs.push(nonRepo);
  const reg3 = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: nonRepo, name: 'git-nonrepo' }) })).json();
  const nonRepoChanges = await fetch(`${BASE}/api/projects/${reg3.project.id}/git/changes`);
  check('non-repo directory refuses the change list honestly', nonRepoChanges.status === 409, `HTTP ${nonRepoChanges.status}`);
  const detached = scratch('cs-git-detached-'); cleanupDirs.push(detached);
  execFileSync('git', ['init', '-b', 'main', detached]); git(detached, ['config', 'user.email', 'verify@example.invalid']); git(detached, ['config', 'user.name', 'verify']);
  fs.writeFileSync(path.join(detached, 'base.txt'), 'base\n'); git(detached, ['add', '--', 'base.txt']); git(detached, ['commit', '-m', 'base']);
  fs.writeFileSync(path.join(detached, '.git', 'HEAD'), `${git(detached, ['rev-parse', 'HEAD'])}\n`);
  const reg4 = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: detached, name: 'git-detached' }) })).json();
  const detachedStatus = (await (await fetch(`${BASE}/api/projects/${reg4.project.id}/git/status`)).json()).status;
  check('detached HEAD is reported without inventing a branch', detachedStatus.branch === null && /^[0-9a-f]+$/.test(detachedStatus.detachedAt ?? ''), detachedStatus);
  const term = await (await fetch(`${BASE}/api/projects/${pid}/terminal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  check('terminal launch succeeds (CLAUDE_STATION_TERMINAL override honoured)',
    /true in/.test(term.launched ?? ''), JSON.stringify(term));

  console.log('\n=== git: realistic large-path repository ===');
  const realistic = scratch('cs-git-realistic-');
  const realisticBare = scratch('cs-git-realistic-bare-');
  const realisticPeerRoot = scratch('cs-git-realistic-peer-');
  cleanupDirs.push(realistic, realisticBare, realisticPeerRoot);
  execFileSync('git', ['init', '-b', 'main', realistic]);
  git(realistic, ['config', 'user.email', 'verify@example.invalid']);
  git(realistic, ['config', 'user.name', 'verify']);
  const nested = (group, i) => `${group}/${String(i % 13).padStart(2, '0')}/${String(i).padStart(4, '0')}.txt`;
  const basePaths = [];
  for (let i = 0; i < 350; i++) {
    const file = nested(i < 200 ? 'modified' : i < 300 ? 'deleted' : 'renamed', i);
    fs.mkdirSync(path.dirname(path.join(realistic, file)), { recursive: true });
    fs.writeFileSync(path.join(realistic, file), `base ${i}\n`); basePaths.push(file);
  }
  fs.writeFileSync(path.join(realistic, 'path with space.txt'), 'base space\n'); basePaths.push('path with space.txt');
  fs.writeFileSync(path.join(realistic, 'žluťoučký.txt'), 'base unicode\n'); basePaths.push('žluťoučký.txt');
  fs.writeFileSync(path.join(realistic, 'binary.dat'), Buffer.from([0, 1, 2, 0, 255])); basePaths.push('binary.dat');
  git(realistic, ['add', '-A']); git(realistic, ['commit', '-m', 'realistic base']);
  // More than one 50-entry UI page, without manufacturing empty commits.
  for (let i = 0; i < 60; i++) {
    const file = `history/${String(i).padStart(3, '0')}.txt`;
    fs.mkdirSync(path.dirname(path.join(realistic, file)), { recursive: true });
    fs.writeFileSync(path.join(realistic, file), `history ${i}\n`);
    git(realistic, ['add', '--', file]); git(realistic, ['commit', '-m', `history ${i}`]);
  }
  execFileSync('git', ['init', '--bare', '-b', 'main', realisticBare]);
  git(realistic, ['remote', 'add', 'origin', realisticBare]); git(realistic, ['push', '-u', 'origin', 'main']);
  git(realistic, ['branch', 'feature/local']); git(realistic, ['branch', 'release/test']);
  git(realistic, ['branch', '--set-upstream-to=origin/main', 'feature/local']);
  // Two fixture-owned stashes; application code is never used to create one.
  fs.writeFileSync(path.join(realistic, 'stash-one.txt'), 'stash one\n');
  execFileSync('git', ['-C', realistic, 'stash', 'push', '-u', '-m', 'fixture stash one']);
  fs.writeFileSync(path.join(realistic, 'stash-two.txt'), 'stash two\n');
  execFileSync('git', ['-C', realistic, 'stash', 'push', '-u', '-m', 'fixture stash two']);
  // Register before manufacturing the large-path tree, then absorb Orchard's
  // project scaffold into the clean fixture baseline.
  const realReg = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: realistic, name: 'realistic-large-tree-with-a-deliberately-long-project-name' }) })).json();
  const realPid = realReg.project?.id; if (!realPid) throw new Error(`realistic register failed: ${JSON.stringify(realReg)}`);
  git(realistic, ['add', '-A']); git(realistic, ['commit', '-m', 'Orchard fixture scaffold']); git(realistic, ['push']);
  const rg = (p) => fetch(`${BASE}/api/projects/${realPid}/git${p}`);
  const rpost = (p, body) => fetch(`${BASE}/api/projects/${realPid}/git${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  execFileSync('git', ['clone', realisticBare, path.join(realisticPeerRoot, 'peer')]);
  const realisticPeer = path.join(realisticPeerRoot, 'peer');
  git(realisticPeer, ['config', 'user.email', 'verify@example.invalid']); git(realisticPeer, ['config', 'user.name', 'verify']);
  fs.writeFileSync(path.join(realisticPeer, 'remote-only.txt'), 'remote\n'); git(realisticPeer, ['add', '-A']); git(realisticPeer, ['commit', '-m', 'remote ahead']); git(realisticPeer, ['push']);
  git(realistic, ['fetch']);
  fs.writeFileSync(path.join(realistic, 'local-only.txt'), 'local\n'); git(realistic, ['add', '-A']); git(realistic, ['commit', '-m', 'local ahead']);
  for (let i = 0; i < 200; i++) fs.appendFileSync(path.join(realistic, nested('modified', i)), `changed ${i}\n`);
  for (let i = 200; i < 300; i++) fs.unlinkSync(path.join(realistic, nested('deleted', i)));
  for (let i = 300; i < 350; i++) {
    const from = nested('renamed', i), to = `renamed/new/${String(i).padStart(4, '0')}.txt`;
    fs.mkdirSync(path.dirname(path.join(realistic, to)), { recursive: true }); git(realistic, ['mv', '--', from, to]);
  }
  for (let i = 0; i < 277; i++) {
    const file = nested('staged-added', i); fs.mkdirSync(path.dirname(path.join(realistic, file)), { recursive: true }); fs.writeFileSync(path.join(realistic, file), `added ${i}\n`);
  }
  fs.appendFileSync(path.join(realistic, 'path with space.txt'), 'changed\n');
  fs.appendFileSync(path.join(realistic, 'žluťoučký.txt'), 'changed\n');
  fs.writeFileSync(path.join(realistic, 'binary.dat'), Buffer.from([0, 9, 8, 0, 255]));
  git(realistic, ['add', '--', 'staged-added']);
  for (let i = 0; i < 20; i++) { const file = nested('untracked', i); fs.mkdirSync(path.dirname(path.join(realistic, file)), { recursive: true }); fs.writeFileSync(path.join(realistic, file), `new ${i}\n`); }
  const realisticStatusPaths = changedPathCount(realistic);
  const realChanges = await (await rg('/changes')).json();
  check('realistic fixture API matches the independently counted changed paths across nested directories and every change type',
    Array.isArray(realChanges.changes) && realChanges.changes.length === realisticStatusPaths && realChanges.changes.some((x) => x.binary)
      && ['added','modified','deleted','renamed','untracked'].every((t) => realChanges.changes.some((x) => x.type === t))
      && realChanges.changes.some((x) => x.path.includes(' ')) && realChanges.changes.some((x) => /[^\x00-\x7f]/.test(x.path))
      && realisticStatusPaths === realChanges.changes.length,
    { raw: realChanges, api: realChanges.changes?.length, disk: realisticStatusPaths, types: [...new Set((realChanges.changes ?? []).map((x) => x.type))] });
  const realStatus = realChanges.status;
  check('large-tree status preserves tracked totals and marks omitted untracked lines explicitly',
    Number.isFinite(realStatus?.added) && Number.isFinite(realStatus?.removed) && realStatus.untrackedLinesIncluded === true,
    realStatus);
  const realBranches = await (await rg('/branches')).json();
  check('realistic fixture has real non-zero ahead and behind plus three local branches and an upstream',
    realStatus?.ahead === 1 && realStatus.behind === 1
      && Array.isArray(realBranches.branches) && realBranches.branches.length >= 3
      && realBranches.branches.some((b) => b.upstream), { status: realStatus, branches: realBranches });
  const stashList = await (await rg('/stashes')).json();
  const stashDetail = await (await rg(`/stash-show?ref=${encodeURIComponent(stashList.stashes?.[0]?.ref ?? '')}`)).json();
  const stashDiff = await (await rg(`/stash-show?ref=${encodeURIComponent(stashList.stashes[0]?.ref)}&path=${encodeURIComponent(stashDetail.files?.[0]?.path)}`)).json();
  check('fixture-created two untracked-only stashes list files and return a real file diff', Array.isArray(stashList.stashes) && stashList.stashes.length === 2 && Array.isArray(stashDetail.files) && stashDetail.files.length > 0 && /stash two/.test(stashDiff.diff ?? ''), { rawList: stashList, rawDetail: stashDetail, diff: stashDiff.diff?.slice(-80) });
  const firstLog = await (await rg('/log?limit=50')).json();
  const secondLog = await (await rg(`/log?limit=50&cursor=${encodeURIComponent(firstLog.nextCursor ?? '')}`)).json();
  const commitFileList = await (await rg(`/commit-files?sha=${encodeURIComponent(firstLog.commits?.[0]?.sha ?? '')}`)).json();
  const commitFileDiff = await (await rg(`/commit-diff?sha=${encodeURIComponent(firstLog.commits?.[0]?.sha ?? '')}&path=${encodeURIComponent(commitFileList.files?.[0]?.path ?? '')}`)).json();
  check('history is genuinely paged and commit files plus one diff are readable', Array.isArray(firstLog.commits) && firstLog.commits.length === 50 && firstLog.nextCursor && Array.isArray(secondLog.commits) && secondLog.commits.length > 0 && Array.isArray(commitFileList.files) && commitFileList.files.length > 0 && commitFileDiff.diff, { first: firstLog.commits?.length, second: secondLog.commits?.length, files: commitFileList.files?.length, raw: { firstLog, secondLog, commitFileList, commitFileDiff }, diffBytes: commitFileDiff.diff?.length });
  const allRealPaths = (realChanges.changes ?? []).map((x) => x.path);
  const oneRename = realChanges.changes?.find((x) => x.type === 'renamed');
  const singleRename = oneRename ? await (await rpost('/stage', { path: oneRename.path, staged: true })).json() : null;
  check('single-path staging addresses a rename by its destination without passing the vanished source path',
    !!oneRename && Array.isArray(singleRename?.paths) && singleRename.paths[0]?.staged === true,
    { rename: oneRename, raw: singleRename });
  const renameUnstaged = oneRename ? await (await rpost('/stage', { path: oneRename.path, staged: false })).json() : null;
  // Must-fail proof: make unstaging use the destination-only `git add` pathspec
  // rule and the rename source remains in the index as a staged deletion.
  const renameCached = oneRename ? git(realistic, ['diff', '--cached', '--name-only', '-z', '--', oneRename.path, oneRename.oldPath]).split('\0').filter(Boolean) : [];
  check('staging then unstaging a rename clears both halves from the index',
    !!oneRename && renameUnstaged?.paths?.[0]?.staged === false && renameCached.length === 0,
    { rename: oneRename, response: renameUnstaged, cached: renameCached });
  // Put the index back exactly as the fixture created it so this focused
  // rename round-trip cannot perturb the batch and branch-switch assertions.
  // Both halves: once unstaged, git sees a deleted source and an untracked
  // destination — two rows. Re-staging only the destination would leave the
  // source's deletion unstaged, which is one extra dirty path for every count
  // the later assertions derive.
  if (oneRename) await rpost('/stage', { paths: [oneRename.path, oneRename.oldPath].filter(Boolean), staged: true });
  const cachedBeforeBad = git(realistic, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
  // Must-fail proof: remove validatedChanges()' all-path validation in git.ts
  // and this one-line unknown-path append stops rejecting the whole request.
  const atomicBad = await rpost('/stage', { paths: [...allRealPaths, 'unknown/not-in-status.txt'], staged: true });
  check('batch stage rejects one unknown path atomically and leaves the whole index untouched', atomicBad.status === 400
    && git(realistic, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean).join('\0') === cachedBeforeBad.join('\0'),
  { http: atomicBad.status, cachedBefore: cachedBeforeBad.length, cachedAfter: git(realistic, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean).length });
  const batch = await (await rpost('/stage', { paths: allRealPaths, staged: true })).json();
  const cachedAll = git(realistic, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
  const batchExpectedCount = changedPathCount(realistic);
  check('one-request batch stage handles renames, deletions, untracked, binary, spaced and non-ASCII paths and leaves the exact index', Array.isArray(batch.paths) && batch.paths.length === batchExpectedCount
    && cachedAll.length === batchExpectedCount && allRealPaths.every((p) => cachedAll.includes(p)), { raw: batch, expected: batchExpectedCount, returned: batch.paths?.length, cached: cachedAll.length, missing: allRealPaths.filter((p) => !cachedAll.includes(p)).slice(0, 5) });
  // Must-fail proof: delete the `if (s.dirty) throw` guard in refuseDirty()
  // and this assertion observes HTTP 200 plus HEAD changing to feature/local.
  const dirtySwitch = await (await rpost('/switch-branch', { name: 'feature/local' })).json();
  const dirtySwitchCount = changedPathCount(realistic);
  check('dirty-tree branch switch is refused with the real derived file count and HEAD does not change',
    (dirtySwitch.error ?? '').includes(`${dirtySwitchCount} files have uncommitted changes`) && git(realistic, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'main',
    { error: dirtySwitch.error, head: git(realistic, ['rev-parse', '--abbrev-ref', 'HEAD']) });
  const described = await (await rpost('/commit', { title: 'Realistic fixture title', description: 'Realistic fixture body' })).json();
  check('commit title and description become the real subject and body', described.committed
    && git(realistic, ['log', '-1', '--format=%s']) === 'Realistic fixture title'
    && git(realistic, ['log', '-1', '--format=%b']) === 'Realistic fixture body',
  { subject: git(realistic, ['log', '-1', '--format=%s']), body: git(realistic, ['log', '-1', '--format=%b']) });
  const cleanSwitch = await (await rpost('/switch-branch', { name: 'feature/local' })).json();
  const switchedChanges = await (await rg('/changes')).json();
  check('clean-tree branch switch succeeds and status plus file list reflect the new branch', cleanSwitch.switched === 'feature/local'
    && cleanSwitch.status?.branch === 'feature/local' && switchedChanges.status?.branch === 'feature/local'
    && git(realistic, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'feature/local' && Array.isArray(switchedChanges.changes) && switchedChanges.changes.length === 0,
  { response: cleanSwitch, head: git(realistic, ['rev-parse', '--abbrev-ref', 'HEAD']), files: switchedChanges.changes?.length });
  await rpost('/switch-branch', { name: 'main' });

  // A small clean repo isolates the three sync-label states from the large
  // dirty-tree fixture used by the rest of the browser assertions.
  const labels = scratch('cs-git-labels-'), labelsBare = scratch('cs-git-labels-bare-'), labelsPeerRoot = scratch('cs-git-labels-peer-');
  cleanupDirs.push(labels, labelsBare, labelsPeerRoot);
  execFileSync('git', ['init', '-b', 'main', labels]); git(labels, ['config', 'user.email', 'verify@example.invalid']); git(labels, ['config', 'user.name', 'verify']);
  fs.writeFileSync(path.join(labels, 'base.txt'), 'base\n'); git(labels, ['add', '-A']); git(labels, ['commit', '-m', 'base']);
  execFileSync('git', ['init', '--bare', '-b', 'main', labelsBare]); git(labels, ['remote', 'add', 'origin', labelsBare]); git(labels, ['push', '-u', 'origin', 'main']);
  const labelsReg = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: labels, name: 'sync-labels' }) })).json();
  const labelsPid = labelsReg.project?.id;
  git(labels, ['add', '-A']); git(labels, ['commit', '-m', 'label scaffold']); git(labels, ['push']);
  execFileSync('git', ['clone', labelsBare, path.join(labelsPeerRoot, 'peer')]);
  const labelsPeer = path.join(labelsPeerRoot, 'peer'); git(labelsPeer, ['config', 'user.email', 'verify@example.invalid']); git(labelsPeer, ['config', 'user.name', 'verify']);
  const invalidBranch = await (await rpost('/create-branch', { name: 'bad..name' })).json();
  check("branch creation uses git's ref-name validation and surfaces rejection", /invalid branch name.*bad\.\.name/i.test(invalidBranch.error ?? ''), invalidBranch.error);

  console.log('\n=== git: crown chip (real browser) ===');
  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE}/#/git?project=${encodeURIComponent(labelsPid)}` });
  const fetchLabel = await cdp.waitFor('initial fetch label', `document.querySelector('.gt-sync button')?.textContent==='Fetch origin'`);
  fs.writeFileSync(path.join(labelsPeer, 'remote.txt'), 'remote\n'); git(labelsPeer, ['add', '-A']); git(labelsPeer, ['commit', '-m', 'remote label']); git(labelsPeer, ['push']);
  const beforeFetch = await cdp.eval(`(async()=>({label:document.querySelector('.gt-sync button')?.textContent,behind:(await (await fetch('/api/projects/${labelsPid}/git/status')).json()).status.behind}))()`);
  await cdp.eval(`document.querySelector('.gt-sync button').click()`);
  const pullLabel = await cdp.waitFor('pull label after fetch', `document.querySelector('.gt-sync button')?.textContent==='Pull origin (↓1)'`);
  const afterFetch = await cdp.eval(`(async()=>({label:document.querySelector('.gt-sync button')?.textContent,behind:(await (await fetch('/api/projects/${labelsPid}/git/status')).json()).status.behind}))()`);
  await cdp.eval(`document.querySelector('.gt-sync button').click()`);
  await cdp.waitFor('pull completes', `document.querySelector('.gt-sync button')?.textContent==='Fetch origin'`);
  fs.writeFileSync(path.join(labels, 'local.txt'), 'local\n'); git(labels, ['add', '-A']); git(labels, ['commit', '-m', 'local label']);
  await cdp.send('Page.navigate', { url: `${BASE}/#/git?project=${encodeURIComponent(labelsPid)}` });
  const pushLabel = await cdp.waitFor('push label after local commit', `document.querySelector('.gt-sync button')?.textContent==='Push origin (↑1)'`);
  check('primary sync label transitions Fetch origin → Pull origin (↓1) → Push origin (↑1), and behind changes only after fetch',
    fetchLabel && beforeFetch.label === 'Fetch origin' && beforeFetch.behind === 0 && pullLabel && afterFetch.behind === 1 && pushLabel,
    { fetchLabel, beforeFetch, pullLabel, afterFetch, pushLabel, final: await cdp.eval(`document.querySelector('.gt-sync button')?.textContent`) });
  const fetchesBeforeClose = await cdp.eval(`performance.getEntriesByType('resource').filter(x=>x.name.includes('/git/fetch')).length`);
  await cdp.eval(`document.querySelector('.gt-home').click()`); await sleep(1200);
  const fetchesAfterClose = await cdp.eval(`performance.getEntriesByType('resource').filter(x=>x.name.includes('/git/fetch')).length`);
  check('closing git cancels background fetch scheduling (no further fetch request arrives)', fetchesAfterClose === fetchesBeforeClose,
    { beforeClose: fetchesBeforeClose, afterWindow: fetchesAfterClose, windowMs: 1200 });
  // A realistic tree for visual + browser behavior: enough rows to exercise
  // scrolling, mixed types, a binary, a long path and a very large text diff.
  fs.writeFileSync(path.join(work, 'delete-me.txt'), 'gone one\ngone two\ngone three\n');
  fs.writeFileSync(path.join(work, 'rename-me.txt'), 'rename body\n');
  fs.writeFileSync(path.join(work, 'c.txt'), 'clean before browser edit\n');
  git(work, ['add', '--', 'delete-me.txt', 'rename-me.txt', 'c.txt']); git(work, ['commit', '-m', 'browser fixture base']);
  fs.unlinkSync(path.join(work, 'delete-me.txt'));
  git(work, ['mv', '--', 'rename-me.txt', 'renamed.txt']);
  fs.writeFileSync(path.join(work, 'c.txt'), 'dirty again\n');
  fs.writeFileSync(path.join(work, 'd.txt'), 'leave me dirty\n');
  fs.writeFileSync(path.join(work, 'added.txt'), 'staged addition\n');
  git(work, ['add', '--', 'added.txt']);
  const longDir = path.join(work, 'a-very-long-directory-name-that-keeps-going', 'and-another-long-segment');
  fs.mkdirSync(longDir, { recursive: true });
  fs.writeFileSync(path.join(longDir, 'a-file-with-a-very-long-name-that-must-ellipsis-cleanly.txt'), 'long\n');
  fs.writeFileSync(path.join(work, 'huge.txt'), Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n'));
  for (let i = 0; i < 34; i++) fs.writeFileSync(path.join(work, `extra-${String(i).padStart(2, '0')}.txt`), `extra ${i}\n`);
  const browserDirty = Number(git(work, ['status', '--porcelain=v1', '-uall']).split('\n').filter(Boolean).length);
  await cdp.send('Page.navigate', { url: `${BASE}/#/project/${encodeURIComponent(pid)}` });
  await cdp.waitFor('boot', `document.querySelectorAll('#tree button.proj').length > 0`);
  const chipUp = await cdp.waitFor('git chip for work fixture', `!document.querySelector('#gitBtn').hidden && document.querySelector('#gitN')?.textContent.includes('main') && document.querySelector('#gitN')?.textContent.includes(${JSON.stringify(`${browserDirty} dirty`)})`);
  const chip = await cdp.eval(`document.querySelector('#gitN')?.textContent`);
  check('crown chip shows branch and dirty count for the current project',
    chipUp && /main/.test(chip ?? '') && chip?.includes(`${browserDirty} dirty`), JSON.stringify({ browserDirty, chip }));
  const crownTotals = await cdp.eval(`({added:document.querySelector('#gitN .git-chip-added')?.textContent,removed:document.querySelector('#gitN .git-chip-removed')?.textContent,addedClass:document.querySelector('#gitN .git-chip-added')?.classList.contains('git-chip-added'),removedClass:document.querySelector('#gitN .git-chip-removed')?.classList.contains('git-chip-removed')})`);
  const browserNumstat = git(work, ['diff', '--numstat', 'HEAD', '--']).split('\n').filter(Boolean).reduce((n, line) => { const [a, d] = line.split('\t'); return { added: n.added + Number(a), removed: n.removed + Number(d) }; }, { added: 0, removed: 0 });
  const browserUntracked = independentlyBudgetedUntracked(work);
  if (browserUntracked.included) browserNumstat.added += browserUntracked.lines;
  check('status line totals match independent numstat and crown renders green +N plus red −N elements',
    browserUntracked.included && crownTotals.addedClass && crownTotals.removedClass && crownTotals.added === `+${browserNumstat.added}` && crownTotals.removed === `−${browserNumstat.removed}`,
  { expected: browserNumstat, budget: browserUntracked, rendered: crownTotals });
  const chipTextFixtures = await cdp.eval(`(()=>{
    const fixtures = [
      /* Captured VERBATIM from a live server whose process predated the commit
         that added added/removed — note those keys are absent entirely, which
         is exactly what the old \`!== null\` guard rendered as "+undefined".
         Only the host path is neutralised. */
      ['stale server payload', {repo:true,toplevel:'/repo',branch:'main',detachedAt:null,dirty:2,ahead:334,behind:0,upstream:'origin/main',remoteUrl:'...',lastCommit:'...'}],
      ['clean tree', {repo:true,toplevel:'/repo',branch:'main',detachedAt:null,dirty:0,added:0,removed:0,untrackedLinesIncluded:true,ahead:0,behind:0,upstream:'origin/main',remoteUrl:'...',lastCommit:'clean'}],
      ['no upstream', {repo:true,toplevel:'/repo',branch:'topic',detachedAt:null,dirty:1,added:3,removed:2,untrackedLinesIncluded:true,ahead:null,behind:null,upstream:null,remoteUrl:null,lastCommit:'work'}],
      ['detached HEAD', {repo:true,toplevel:'/repo',branch:null,detachedAt:'abc1234',dirty:1,added:4,removed:1,untrackedLinesIncluded:true,ahead:null,behind:null,upstream:null,remoteUrl:null,lastCommit:'detached'}],
      ['normal populated payload', {repo:true,toplevel:'/repo',branch:'main',detachedAt:null,dirty:2,added:7,removed:3,untrackedLinesIncluded:true,ahead:4,behind:2,upstream:'origin/main',remoteUrl:'...',lastCommit:'normal'}],
    ];
    const {state,paintGitChip} = window.__station;
    const pid = state.current.projectId;
    const saved = state.git.get(pid);
    try {
      return fixtures.map(([label,status])=>{
        state.git.set(pid,{status,at:Date.now(),loading:false});
        paintGitChip();
        return [label,document.querySelector('#gitN')?.textContent];
      });
    } finally {
      // Restore the REAL status so the workbench assertions below still run
      // against the true repository rather than the last fixture.
      if (saved) state.git.set(pid,saved); else state.git.delete(pid);
      paintGitChip();
    }
  })()`);
  const chipTextExpected = [
    ['stale server payload', 'main · 2 dirty · ↑334'],
    ['clean tree', 'main'],
    ['no upstream', 'topic · 1 dirty · +3 · −2'],
    ['detached HEAD', 'detached @ abc1234 · 1 dirty · +4 · −1'],
    ['normal populated payload', 'main · 2 dirty · +7 · −3 · ↑4 · ↓2'],
  ];
  check('crown chip rendered text is exact for stale, clean, no-upstream, detached and populated payloads',
    JSON.stringify(chipTextFixtures) === JSON.stringify(chipTextExpected),
    { expected: chipTextExpected, rendered: chipTextFixtures });
  fs.writeFileSync(path.join(work, 'binary.bin'), Buffer.from([0, 1, 2, 0, 255]));
  await cdp.eval(`document.querySelector('#gitBtn').click()`);
  const midSlide = await cdp.eval(`({settled:document.documentElement.classList.contains('git-open'),win:getComputedStyle(document.querySelector('.window')).visibility})`);
  const viewUp = await cdp.waitFor('git workbench', `document.querySelector('.git-view.open') && document.querySelectorAll('.gt-file').length >= 8`);
  const visibleShape = await cdp.eval(`({rows:document.querySelectorAll('.gt-file').length, scroll:document.querySelector('.gt-files').scrollHeight > document.querySelector('.gt-files').clientHeight, binary:[...document.querySelectorAll('.gt-file')].some(n=>n.querySelector('.gt-file-name')?.title==='binary.bin' && n.querySelector('.gt-stat')?.textContent==='binary'), longPath:[...document.querySelectorAll('.gt-file-name')].some(n=>n.title.includes('a-very-long-directory-name-that-keeps-going/and-another-long-segment/')), types:[...document.querySelectorAll('.gt-kind')].map(n=>n.textContent)})`);
  check('real workbench renders every change type, binary and long path, and scrolls', viewUp && visibleShape.rows >= 8 && visibleShape.scroll && visibleShape.binary && visibleShape.longPath && ['added','modified','deleted','renamed','untracked'].every(t=>visibleShape.types.includes(t)), visibleShape);
  const zeroStashVisibility = await cdp.eval(`(()=>{const el=document.querySelector('[data-view="stashes"]'),rects=el.getClientRects();return {display:getComputedStyle(el).display,offsetParent:el.offsetParent,boxes:rects.length,area:[...rects].reduce((n,r)=>n+r.width*r.height,0)}})()`);
  check('stash switcher entry is absent when the repository has zero stashes', zeroStashVisibility.display === 'none' && zeroStashVisibility.offsetParent === null && zeroStashVisibility.boxes === 0 && zeroStashVisibility.area === 0, zeroStashVisibility);
  /* FEAT-101 adoption: the session underneath is hidden only AFTER the slide
     settles. Hiding it on the first frame blanks the window mid-motion, so the
     assertion is that it is still visible while sliding and hidden once open. */
  const settledOpen = await cdp.waitFor('git-open settles', `document.documentElement.classList.contains('git-open') && getComputedStyle(document.querySelector('.window')).visibility === 'hidden'`);
  check('slide settles before the session underneath is hidden', !midSlide.settled && midSlide.win !== 'hidden' && settledOpen, { midSlide, settledOpen });
  const layout = await cdp.eval(`(()=>{const list=document.querySelector('.gt-files'), side=document.querySelector('.gt-side'), row=document.querySelector('.gt-file'), add=document.querySelector('.gt-added'), del=document.querySelector('.gt-removed'), create=document.querySelector('.gt-create'), dirty=document.querySelector('.gt-create .gt-reason');return {share:list.clientHeight/side.clientHeight,rowHeight:row.getBoundingClientRect().height,visibleRows:Math.floor(list.clientHeight/row.getBoundingClientRect().height),addColor:getComputedStyle(add).color,delColor:getComputedStyle(del).color,distinct:getComputedStyle(add).color!==getComputedStyle(del).color,createDisplay:getComputedStyle(create).display,createVisible:create.offsetParent!==null,dirtyDisplay:getComputedStyle(dirty).display,dirtyVisible:dirty.offsetParent!==null}})()`);
  check('changed-file list owns at least 80% of the column and branch controls are not visible on Changes', layout.share >= .8 && layout.visibleRows >= 20 && layout.createDisplay === 'none' && !layout.createVisible && !layout.dirtyVisible, layout);
  check('23px row density keeps at least 20 changed files visible at 1440x900', layout.rowHeight <= 26 && layout.visibleRows >= 20, layout);
  const selectorShape = await cdp.eval(`({width:document.querySelector('.gt-sel')?.getBoundingClientRect().width,text:document.querySelector('.gt-sel option:checked')?.textContent})`);
  check('project selector has a usable width and shows a long project name', selectorShape.width >= 160 && selectorShape.text?.length >= 30, selectorShape);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false });
  const smallLayout = await cdp.eval(`(()=>{const list=document.querySelector('.gt-files'),side=document.querySelector('.gt-side'),row=document.querySelector('.gt-file');return {share:list.clientHeight/side.clientHeight,visibleRows:Math.floor(list.clientHeight/row.getBoundingClientRect().height)}})()`);
  check('compact file-first layout still shows many rows at 1024x700', smallLayout.share >= .65 && smallLayout.visibleRows >= 15, smallLayout);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  check('per-file additions and removals use distinct semantic colors', layout.distinct, layout);
  const deletedStat = await cdp.eval(`[...document.querySelectorAll('.gt-file-name')].find(n=>n.title==='delete-me.txt')?.closest('.gt-file').querySelector('.gt-stat')?.textContent`);
  check('multi-line deletion count is truthful', /\+0\s*−3/.test(deletedStat ?? ''), deletedStat);
  await cdp.eval(`document.querySelector('.gt-file-name[title="delete-me.txt"]').click()`);
  await cdp.waitFor('deleted file diff', `document.querySelector('.gt-diff-lines')?.textContent.includes('gone three')`);
  const deletedGutter = await cdp.eval(`[...document.querySelectorAll('.gt-diff-lines>div')].map(n=>({old:n.children[0].textContent,new:n.children[1].textContent,code:n.children[2].textContent})).at(-1)`);
  check('deleted diff has no synthetic trailing numbered gutter row', deletedGutter?.code !== ' ' || (!deletedGutter.old && !deletedGutter.new), deletedGutter);
  await cdp.eval(`document.querySelector('.gt-file-name[title="c.txt"]').click()`);
  const diffVisible = await cdp.waitFor('c.txt diff', `document.querySelector('.gt-diff-lines')?.textContent.includes('dirty again')`);
  await cdp.eval(`document.querySelector('.gt-file-name[title="d.txt"]').click()`);
  const otherDiff = await cdp.waitFor('d.txt diff', `document.querySelector('.gt-diff-lines')?.textContent.includes('leave me dirty')`);
  check('browser shows the correct diff for each selected file', diffVisible && otherDiff, { diffVisible, otherDiff });
  await cdp.eval(`document.querySelector('.gt-file-name[title="huge.txt"]').click()`);
  const largeDiff = await cdp.waitFor('large diff', `document.querySelector('.gt-diff-lines')?.textContent.includes('line 3999')`);
  check('browser renders the large diff', largeDiff, { largeDiff });
  const renderedDiff = await cdp.eval(`document.querySelector('.gt-diff-lines')?.textContent`);
  check('rendered diff suppresses Git headers and absolute host paths', !renderedDiff.includes('diff --git ') && !renderedDiff.includes('+++ ') && !renderedDiff.includes(SCRATCH), renderedDiff.slice(0, 120));
  await cdp.eval(`document.querySelector('.gt-file-name[title="added.txt"]').closest('.gt-file').querySelector('input').click()`);
  await cdp.waitFor('added file unstaged', `!document.querySelector('.gt-file-name[title="added.txt"]').closest('.gt-file').querySelector('input').checked`);
  await cdp.eval(`document.querySelector('.gt-kind.renamed').closest('.gt-file').querySelector('input').click()`);
  await cdp.waitFor('rename unstaged separately', `document.querySelector('.gt-summary')?.textContent.includes('· 0 staged')`);
  await cdp.eval(`document.querySelector('.gt-file-name[title="c.txt"]').closest('.gt-file').querySelector('input').click()`);
  await cdp.waitFor('c.txt staged', `document.querySelector('.gt-summary')?.textContent.includes('· 1 staged') && document.querySelector('.gt-file-name[title="c.txt"]').closest('.gt-file').querySelector('input').checked`);
  await cdp.eval(`const t=document.querySelector('.gt-title'); t.value='browser selective'; t.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.gt-commit').requestSubmit()`);
  const uiCommit = await cdp.waitFor('selective UI commit', `document.querySelector('.gt-file-name[title="c.txt"]') === null && document.querySelector('.gt-file-name[title="d.txt"]') !== null`);
  const uiNames = git(work, ['show', '--pretty=', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  check('real UI staged and committed only c.txt; d.txt remains dirty', uiCommit && uiNames.join(',') === 'c.txt' && /\?\? d\.txt/.test(git(work, ['status', '--porcelain'])), { uiNames, status: git(work, ['status', '--porcelain']) });
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const shotPath = path.join(SCRATCH, 'feat-099-git-view.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  check('visual-review screenshot captured from the realistic real view', fs.statSync(shotPath).size > 10_000, shotPath);
  for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(work, `large-tree-${String(i).padStart(3, '0')}.txt`), `large ${i}\n`);
  await cdp.send('Page.navigate', { url: `${BASE}/#/project/${encodeURIComponent(pid)}` });
  await cdp.waitFor('session route before reopening larger tree', `!document.documentElement.classList.contains('git-open') && !document.querySelector('#gitBtn').hidden`);
  await cdp.eval(`document.querySelector('#gitBtn').click()`);
  await cdp.waitFor('larger workbench tree', `document.querySelectorAll('.gt-file').length >= 150`);
  const partialLarge = await (await g('/status')).json();
  const partialHeader = await cdp.eval(`document.querySelector('.gt-branch')?.textContent`);
  check('hundreds of small untracked files keep exact totals without a partial marker',
    Number.isFinite(partialLarge.status?.added) && Number.isFinite(partialLarge.status?.removed) && partialLarge.status.untrackedLinesIncluded === true && !/tracked only/.test(partialHeader ?? ''),
    { status: partialLarge, header: partialHeader });
  const largeLayout = await cdp.eval(`(()=>{const list=document.querySelector('.gt-files'), side=document.querySelector('.gt-side'), row=document.querySelector('.gt-file');return {rows:document.querySelectorAll('.gt-file').length,share:list.clientHeight/side.clientHeight,visibleRows:Math.floor(list.clientHeight/row.getBoundingClientRect().height)}})()`);
  check('larger tree retains the file-first layout', largeLayout.rows >= 150 && largeLayout.share >= .7 && largeLayout.visibleRows >= 7, largeLayout);
  const largeShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const largeShotPath = path.join(SCRATCH, 'feat-099-git-view-large.png');
  fs.writeFileSync(largeShotPath, Buffer.from(largeShot.data, 'base64'));
  check('larger-tree visual-review screenshot captured', fs.statSync(largeShotPath).size > 10_000, largeShotPath);
  git(realistic, ['reset', '--mixed', 'HEAD^']); // scratch fixture only: restore its large working tree
  const browserExpectedCount = changedPathCount(realistic);
  const directStarted = performance.now();
  await cdp.send('Page.navigate', { url: `${BASE}/#/git?project=${encodeURIComponent(realPid)}` });
  const realisticUp = await cdp.waitFor('large-file direct git route', `document.querySelectorAll('.gt-file').length===${browserExpectedCount}`);
  const directReadyMs = Math.round(performance.now() - directStarted);
  const realisticLayout = await cdp.eval(`(()=>{const list=document.querySelector('.gt-files'),row=document.querySelector('.gt-file');return {hash:location.hash,header:document.querySelector('.gt-branch')?.textContent,rows:document.querySelectorAll('.gt-file').length,rowHeight:row?.getBoundingClientRect().height,visibleRows:Math.floor(list.clientHeight/row.getBoundingClientRect().height)}})()`);
  check('large-file direct route paints within 10 seconds', realisticUp && directReadyMs < 10_000, { expected: browserExpectedCount, ms: directReadyMs });
  check('large-file regression: <=26px rows show at least 20 at 1440x900', realisticUp && realisticLayout.rowHeight <= 26 && realisticLayout.visibleRows >= 20, realisticLayout);
  const emptyCommitState = await cdp.eval(`({disabled:document.querySelector('.gt-commit button').disabled,reason:document.querySelector('.gt-commit .gt-reason').textContent})`);
  const emptyCommitLabel = await cdp.eval(`document.querySelector('.gt-commit button').textContent`);
  check('commit button omits zero-file noise and keeps a visible nothing-staged reason', emptyCommitState.disabled && /nothing staged/.test(emptyCommitState.reason) && emptyCommitLabel === 'Commit to main', { ...emptyCommitState, label: emptyCommitLabel });
  const filterPaths = realChanges.changes.filter((x) => x.path.includes('untracked/')).map((x) => x.path).sort();
  const filterPerf = await cdp.eval(`new Promise(resolve=>{const t=performance.now(),deadline=t+5000,f=document.querySelector('.gt-find');f.value='untracked/';f.dispatchEvent(new Event('input',{bubbles:true}));const poll=()=>{const s=document.querySelector('.gt-summary')?.textContent,visible=[...document.querySelectorAll('.gt-file')].filter(x=>!x.hidden).length;if(s?.startsWith('${filterPaths.length} of ${browserExpectedCount}'))resolve({ok:true,ms:performance.now()-t,summary:s,visible});else if(performance.now()>=deadline)resolve({ok:false,timeout:true,ms:performance.now()-t,summary:s,visible});else setTimeout(poll,10)};poll()})`);
  check('filter keystroke settles under 1000ms on the large tree (interactive-search guard)', filterPerf.ok && filterPerf.ms < 1000 && filterPerf.visible === filterPaths.length && filterPerf.summary.startsWith(`${filterPaths.length} of ${browserExpectedCount}`), filterPerf);
  await cdp.eval(`document.querySelector('.gt-all input').click()`);
  const selectedAll = await cdp.waitFor('filtered select-all stages', `document.querySelector('.gt-summary')?.textContent.includes('· ${filterPaths.length} staged')`);
  const filteredIndex = git(realistic, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean).sort();
  const selectAllState = await cdp.eval(`(()=>{const r=document.querySelector('.git-view');return {summary:document.querySelector('.gt-summary')?.textContent,error:document.querySelector('.gt-view-error')?.textContent,lastOperation:r?.dataset.lastOperation,lastResponse:r?.dataset.lastResponse,lastDetail:r?.dataset.lastDetail}})()`);
  check('browser select-all over a filtered subset stages only matching paths', selectedAll && JSON.stringify(filteredIndex) === JSON.stringify(filterPaths), { expected: filterPaths.length, cached: filteredIndex.length, unexpected: filteredIndex.filter((x) => !filterPaths.includes(x)).slice(0, 3), ...selectAllState });
  // Unstage through the UI, not out-of-band over HTTP: the summary is computed
  // from the client's own model, so a server-side unstage the app never saw
  // would leave it reading "20 staged" and poison the toggle guard below.
  await cdp.eval(`document.querySelector('.gt-all input').click()`);
  await cdp.waitFor('filtered select-all unstages', `document.querySelector('.gt-summary')?.textContent.includes('· 0 staged')`);
  await cdp.eval(`const f=document.querySelector('.gt-find');f.value='';f.dispatchEvent(new Event('input',{bubbles:true}))`);
  const clearedFilter = await cdp.waitFor('cleared filter restores all', `document.querySelector('.gt-summary')?.textContent.startsWith('${browserExpectedCount} of ${browserExpectedCount}')`);
  check('clearing the filter restores the complete derived-count file list', clearedFilter, await cdp.eval(`document.querySelector('.gt-summary')?.textContent`));
  const togglePerf = await cdp.eval(`new Promise(resolve=>{const row=document.querySelector('.gt-file'),box=row.querySelector('input'),t=performance.now(),deadline=t+7000,path=row?.querySelector('.gt-file-name')?.title;if(!row||!box){resolve({ok:false,missing:true,ms:0,path});return}box.click();const poll=()=>{if(box.checked&&document.querySelector('.gt-summary')?.textContent.includes('· 1 staged'))resolve({ok:true,ms:performance.now()-t,path});else if(performance.now()>=deadline)resolve({ok:false,timeout:true,ms:performance.now()-t,path,checked:box.checked,summary:document.querySelector('.gt-summary')?.textContent});else setTimeout(poll,10)};poll()})`);
  check('single checkbox round-trip completes under 5000ms on the large tree (staging responsiveness guard)', togglePerf.ok && togglePerf.ms < 5000, togglePerf);
  const titleMissing = await cdp.eval(`({disabled:document.querySelector('.gt-commit button').disabled,reason:document.querySelector('.gt-commit .gt-reason').textContent})`);
  check('commit button is disabled with a visible reason when title is empty', titleMissing.disabled && /title is required/.test(titleMissing.reason), titleMissing);
  await rpost('/stage', { paths: [togglePerf.path], staged: false });
  await cdp.send('Page.navigate', { url: `${BASE}/#/git/stashes?project=${encodeURIComponent(realPid)}` });
  const stashDom = await cdp.waitFor('stash list', `document.querySelectorAll('.gt-parent-row').length===2`);
  await cdp.eval(`document.querySelector('.gt-parent-row').click()`);
  const stashFilesDom = await cdp.waitFor('stash files', `document.querySelectorAll('.gt-file').length>0 && document.querySelector('.gt-diff-lines')`);
  const stashState = await cdp.eval(`(()=>{const r=document.querySelector('.git-view'),commit=document.querySelector('.gt-commit'),create=document.querySelector('.gt-create'),dirty=document.querySelector('.gt-create .gt-reason');return {rows:document.querySelectorAll('.gt-file').length,diffLines:document.querySelectorAll('.gt-diff-lines>div').length,error:document.querySelector('.gt-view-error')?.textContent,lastResponse:r?.dataset.lastResponse,lastDetail:r?.dataset.lastDetail,commitDisplay:getComputedStyle(commit).display,commitVisible:commit.offsetParent!==null,createDisplay:getComputedStyle(create).display,createVisible:create.offsetParent!==null,dirtyDisplay:getComputedStyle(dirty).display,dirtyVisible:dirty.offsetParent!==null}})()`);
  check('two-stash switcher entry and stash detail render without commit or branch controls', stashDom && stashFilesDom && stashState.commitDisplay === 'none' && !stashState.commitVisible && stashState.createDisplay === 'none' && !stashState.createVisible && !stashState.dirtyVisible, { stashDom, stashFilesDom, ...stashState });
  await cdp.send('Page.navigate', { url: `${BASE}/#/git/history?project=${encodeURIComponent(realPid)}` });
  const historyFirst = await cdp.waitFor('history first page', `document.querySelectorAll('.gt-parent-row').length===50 && document.querySelector('.gt-more')`);
  await cdp.eval(`document.querySelector('.gt-more').click()`);
  const historyMore = await cdp.waitFor('history load more', `document.querySelectorAll('.gt-parent-row').length>50`);
  const historyMoreState = await cdp.eval(`(()=>{const r=document.querySelector('.git-view');return {rowsAfterMore:document.querySelectorAll('.gt-parent-row').length,moreVisibleAfterMore:!!document.querySelector('.gt-more'),errorAfterMore:document.querySelector('.gt-view-error')?.textContent,lastResponse:r?.dataset.lastResponse,lastDetail:r?.dataset.lastDetail}})()`);
  await cdp.eval(`document.querySelectorAll('.gt-parent-row')[50].click()`);
  const historyDetail = await cdp.waitFor('history commit detail', `document.querySelectorAll('.gt-file').length>0 && document.querySelector('.gt-diff-lines')`);
  const destructiveHistory = await cdp.eval(`document.querySelectorAll('[data-action="revert"],[data-action="reset"],[data-action="amend"],.gt-revert,.gt-reset,.gt-amend').length`);
  check('history pages, loads more, renders commit files/diff, and stays read-only', historyFirst && historyMore && historyDetail && destructiveHistory === 0, { historyFirst, historyMore, historyDetail, destructiveHistory, ...historyMoreState });
  await cdp.send('Page.navigate', { url: `${BASE}/#/git/branches?project=${encodeURIComponent(realPid)}` });
  const directBranches = await cdp.waitFor('direct branches route', `location.hash.startsWith('#/git/branches') && document.querySelectorAll('.gt-branch-row').length>=3`);
  check('a tab opened directly on #/git/branches lands on the branches view with matching header data', directBranches && (await cdp.eval(`document.querySelector('.gt-branch')?.textContent`))?.includes('main'), { directBranches, hash: await cdp.eval('location.hash'), header: await cdp.eval(`document.querySelector('.gt-branch')?.textContent`) });
  const branchControls = await cdp.eval(`(()=>{const create=document.querySelector('.gt-create'),dirty=document.querySelector('.gt-create .gt-reason'),commit=document.querySelector('.gt-commit');return {createDisplay:getComputedStyle(create).display,createVisible:create.offsetParent!==null,dirtyDisplay:getComputedStyle(dirty).display,dirtyVisible:dirty.offsetParent!==null,dirtyText:dirty.textContent,commitDisplay:getComputedStyle(commit).display,commitVisible:commit.offsetParent!==null}})()`);
  const branchDirtyCount = changedPathCount(realistic);
  check('branch creation and the real dirty-tree explanation live only on Branches', branchControls.createDisplay !== 'none' && branchControls.createVisible && branchControls.dirtyDisplay !== 'none' && branchControls.dirtyVisible && branchControls.commitDisplay === 'none' && !branchControls.commitVisible && (branchControls.dirtyText ?? '').includes(`${branchDirtyCount} files have uncommitted changes`), { ...branchControls, expected: branchDirtyCount });
  await cdp.eval(`document.querySelector('.gt-home').click()`);
  const closedBack = await cdp.waitFor('session restored on close', `!document.documentElement.classList.contains('git-open') && getComputedStyle(document.querySelector('.window')).visibility !== 'hidden' && document.querySelector('.git-view').hidden`);
  check('closing the view restores the session and hides the panel', closedBack, { closedBack });
  await cdp.send('Page.navigate', { url: `${BASE}/#/git?project=${encodeURIComponent(realPid)}` });
  await cdp.waitFor('routing git overlay', `document.documentElement.classList.contains('git-open')`);
  await cdp.send('Page.navigate', { url: `${BASE}/#/tickets` }); await cdp.waitFor('routing tickets overlay', `document.documentElement.classList.contains('tickets-open')&&!document.documentElement.classList.contains('git-open')`);
  await cdp.send('Page.navigate', { url: `${BASE}/#/guide` }); await cdp.waitFor('routing guide overlay', `document.documentElement.classList.contains('guide-open')&&!document.documentElement.classList.contains('tickets-open')&&!document.documentElement.classList.contains('git-open')`);
  await cdp.eval('history.back()'); const backTickets = await cdp.waitFor('back to tickets', `location.hash.startsWith('#/tickets')&&document.documentElement.classList.contains('tickets-open')&&!document.documentElement.classList.contains('guide-open')&&!document.documentElement.classList.contains('git-open')`);
  await cdp.eval('history.back()'); const backGit = await cdp.waitFor('back to git', `location.hash.startsWith('#/git')&&document.documentElement.classList.contains('git-open')&&!document.documentElement.classList.contains('tickets-open')&&!document.documentElement.classList.contains('guide-open')`);
  await cdp.eval('history.forward()'); const forwardTickets = await cdp.waitFor('forward to tickets', `location.hash.startsWith('#/tickets')&&document.documentElement.classList.contains('tickets-open')&&!document.documentElement.classList.contains('git-open')&&!document.documentElement.classList.contains('guide-open')`);
  await cdp.eval('history.forward()'); const forwardGuide = await cdp.waitFor('forward to guide', `location.hash.startsWith('#/guide')&&document.documentElement.classList.contains('guide-open')&&!document.documentElement.classList.contains('tickets-open')&&!document.documentElement.classList.contains('git-open')`);
  check('Back/Forward across git, tickets and guide leaves exactly the routed overlay open', backTickets && backGit && forwardTickets && forwardGuide,
    { backTickets, backGit, forwardTickets, forwardGuide, hash: await cdp.eval('location.hash') });
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
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
