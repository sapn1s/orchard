/**
 * BUG-138 — a project whose directory was renamed: follow the rename, keep the
 * sessions, and say so when it can't.
 *
 *   Reported: a session showed the bare word "Error" and never answered. The
 *   project's directory had been renamed, so `direct` isolation handed the CLI
 *   a cwd that no longer existed. Two defects, not one: the failure named
 *   nothing the reader could act on, and there was no way to follow the rename
 *   short of hand-editing registry.json — and repointing by hand would have
 *   stranded every session, because history is indexed by the WORKING DIRECTORY
 *   and grouped on that path's basename.
 *
 * The success criterion this file exists for: REPOINT A PROJECT THAT HAS REAL
 * SESSION HISTORY AND CONFIRM THE HISTORY IS STILL THERE. Everything else here
 * is supporting evidence.
 *
 * Real-shape, in two parts:
 *   PART A — the USER'S OWN registry and store, read-only, no server, no
 *     writes: how many registered projects point at a directory that is gone,
 *     what identity those rows carry, and whether a repoint offer for the real
 *     broken one is honest about not being able to decide.
 *   PART B — a REAL server on a free port with an isolated data dir, and a
 *     fixture built from REAL transcripts (copied out of the busiest store dir
 *     on this machine, cwd-rewritten so they read as this project's own): add
 *     the project, rename its directory on disk for real, and drive the whole
 *     recovery through the real HTTP + WS surfaces.
 *
 * PRE-FIX assertions that FAIL (proven against a HEAD worktree):
 *   - PATCH /api/projects/:id {hostPath} → 400 "unknown field \"hostPath\"".
 *     There is no repoint at all, so nothing below it can even be attempted.
 *   - GET /api/projects/:id/repoint-candidates → 404.
 *   - `pathMissing` absent from the project list.
 *   - A `start` on a project whose directory is gone reports an ENOENT that
 *     names neither the project nor the path.
 *
 * Hands off: touches no registered project's files, no port but its own, no
 * process it did not spawn, and never writes to the user's real data dir.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');

/* Scratch lives under the user's scratch root, never /tmp — a verify run that
   leaves state should leave it somewhere the operator already looks. */
const SCRATCH_ROOT = process.env.ORCHARD_SCRATCH || path.join(os.homedir(), 'scratch');
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const SCRATCH = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'bug138-'));
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
/** Never print an absolute home path into the log. */
const sp = (p) => String(p).replace(os.homedir(), '~');

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
let childExecFileSync;

/* ============================================================== PART A ==== */

/**
 * The user's real registry, read through the real module with the real data
 * dir. Read-only: listProjects/hostPathMissing/repointCandidates never write.
 */
async function partA() {
  console.log('\nPART A — the real registry on this machine (read-only)\n');
  const reg = await import('../src/server/registry.ts');
  const hist = await import('../src/lib/session-history.ts');

  /* Run against PRE-FIX code (a HEAD worktree) this whole capability is absent.
     Report that as the failure it is rather than crashing on an undefined — a
     must-FAIL run should read as a result, not as a broken harness. */
  if (typeof reg.hostPathMissing !== 'function' || typeof reg.repointCandidates !== 'function') {
    check('the registry can say whether a project\'s directory still exists', false, 'reg.hostPathMissing is not a function');
    check('the registry can offer where a renamed project went', false, 'reg.repointCandidates is not a function');
    return;
  }
  const projects = reg.listProjects();
  const broken = projects.filter((p) => reg.hostPathMissing(p));
  check('every registered project is checked, not just the reported one',
    projects.length > 0, `${projects.length} projects registered, ${broken.length} pointing at a directory that is gone`);
  for (const p of broken) {
    console.log(`        broken: "${p.name}" → ${sp(p.hostPath)} (isolation ${p.isolation})`);
  }

  if (!broken.length) {
    check('no registered project points at a missing directory (nothing to recover here)', true, 'skipping the real-instance assertions');
    return;
  }

  for (const p of broken) {
    /* The history that a naive repoint would strand. */
    let n = 0;
    try { n = hist.listSessions(encodeCwd(p.hostPath)).length; } catch { n = 0; }
    console.log(`        "${p.name}" has ${n} session file(s) recorded under its now-missing path`);

    const offer = reg.repointCandidates(p);
    check(`[${p.name}] the offer knows the directory is missing`, offer.missing === true, offer.missing);
    check(`[${p.name}] no candidate is called a match without a recorded identity`,
      offer.identity.kind === 'git-remote' || offer.candidates.every((c) => c.confidence !== 'match'),
      `identity=${offer.identity.kind}, matches=${offer.candidates.filter((c) => c.confidence === 'match').length}`);
    check(`[${p.name}] a row that cannot be decided says so in words`,
      offer.unambiguous === true || (typeof offer.cannotDecide === 'string' && offer.cannotDecide.length > 20),
      offer.cannotDecide ?? `unambiguous (${offer.candidates[0]?.hostPath ? sp(offer.candidates[0].hostPath) : '—'})`);
    check(`[${p.name}] candidates are offered to pick from`,
      offer.candidates.length > 0, `${offer.candidates.length} candidate director(y|ies)`);
    check(`[${p.name}] no similarly-named directory is promoted to a match`,
      !offer.candidates.some((c) => c.confidence === 'match' && !c.remoteUrl),
      offer.candidates.slice(0, 3).map((c) => `${path.basename(c.hostPath)}:${c.confidence}`).join(', '));
  }

  /* The honest failure, on the REAL broken project, through the REAL code that
     produces it. startSession throws in its preflight before it spawns, binds
     or touches anything. */
  const bridge = await import('../src/server/agent-bridge.ts');
  const target = broken[0];
  const events = [];
  let thrown = null;
  try {
    await bridge.startSession({ project: target, firstPrompt: 'x', onEvent: (e) => events.push(e) });
  } catch (err) {
    thrown = err;
  }
  const errEvent = events.find((e) => e.t === 'error');
  check('a session on the real broken project refuses, and the refusal is fatal',
    !!thrown && !!errEvent && errEvent.fatal === true, thrown ? 'threw, fatal error event emitted' : 'did NOT refuse');
  check('the refusal names the missing directory',
    !!errEvent && errEvent.message.includes(target.hostPath), errEvent ? sp(errEvent.message.split('\n')[0]) : '(no error event)');
  check('the refusal names the project and says nothing was changed',
    !!errEvent && errEvent.message.includes(target.name) && /restore|rename the directory back/i.test(errEvent.message),
    errEvent ? sp(errEvent.message.slice(0, 240)) : '(no error event)');
  check('the refusal tells the user where to fix it',
    !!errEvent && /Settings/.test(errEvent.message) && /carries/.test(errEvent.message),
    errEvent ? sp(errEvent.message.slice(-160)) : '(no error event)');
}

/* ============================================================== PART B ==== */

/**
 * Build a realistic fixture: copy REAL transcripts out of the busiest store dir
 * on this machine into the fixture project's own store dir, rewriting the
 * recorded `cwd` so they read as that project's own history. Not the minimal
 * one-session case — a project the user has actually been working in.
 */
function seedRealTranscripts(fromDir, toCwd, want = 40) {
  const src = path.join(realStoreRoot(), fromDir);
  const dst = path.join(STORE, encodeCwd(toCwd));
  fs.mkdirSync(dst, { recursive: true });
  const files = fs.readdirSync(src)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, st: fs.statSync(path.join(src, f)) }))
    .filter((x) => x.st.isFile() && x.st.size > 0 && x.st.size < 8 * 1024 * 1024)
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
    .slice(0, want);
  const fromCwd = decodeGuess(fromDir);
  let copied = 0, bytes = 0;
  for (const { f } of files) {
    const body = fs.readFileSync(path.join(src, f), 'utf8')
      .split(fromCwd).join(toCwd); // the transcripts record their own cwd; make them this project's
    fs.writeFileSync(path.join(dst, f), body);
    copied++; bytes += body.length;
  }
  return { copied, bytes, dir: encodeCwd(toCwd) };
}
function realStoreRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}
function decodeGuess(encodedDir) {
  return encodedDir.startsWith('-') ? '/' + encodedDir.slice(1).replace(/-/g, '/') : encodedDir;
}
/** The busiest real store dir — the most realistic donor available. */
function busiestStoreDir() {
  const root = realStoreRoot();
  let best = null;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const guess = decodeGuess(e.name);
    // Only a dir whose decoded path really exists — otherwise the cwd rewrite
    // has nothing reliable to key on.
    if (!fs.existsSync(guess)) continue;
    let n = 0;
    try { n = fs.readdirSync(path.join(root, e.name)).filter((f) => f.endsWith('.jsonl')).length; } catch { n = 0; }
    if (!best || n > best.n) best = { dir: e.name, n };
  }
  return best;
}

let server = null;
function stopServer() {
  if (!server || server.exitCode !== null) return;
  try { process.kill(server.pid, 'SIGTERM'); } catch { /* already gone */ }
}

async function partB() {
  console.log('\nPART B — a real server, a real rename, real transcripts\n');
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;

  const ALPHA = path.join(WORK, 'orchard-fixture-alpha');
  const BETA = path.join(WORK, 'orchard-fixture-beta');
  fs.mkdirSync(ALPHA, { recursive: true });
  fs.writeFileSync(path.join(ALPHA, 'README.md'), '# fixture\n');
  childExecFileSync('git', ['-C', ALPHA, 'init', '-q'], { stdio: ['ignore', 'ignore', 'ignore'] });
  childExecFileSync('git', ['-C', ALPHA, 'remote', 'add', 'origin', 'git@example.invalid:orchard/bug138-fixture.git'], { stdio: ['ignore', 'ignore', 'ignore'] });

  const donor = busiestStoreDir();
  if (!donor || donor.n < 3) throw new Error('no real store dir to build a realistic fixture from');
  const seeded = seedRealTranscripts(donor.dir, ALPHA);
  console.log(`        seeded ${seeded.copied} REAL transcripts (${(seeded.bytes / 1e6).toFixed(1)} MB) into ${seeded.dir}`);

  server = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const j = async (p, init) => {
    const r = await fetch(`${BASE}${p}`, init);
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  /* ---- add the project (identity is declared here, while the dir exists) -- */
  const created = await j('/api/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: ALPHA, applyMethod: false }),
  });
  const id = created.body?.project?.id;
  check('the fixture project registers', created.status === 201 && !!id, `${created.status} ${id}`);
  check('identity is recorded AT ADD, from the directory while it exists',
    created.body?.project?.identity?.kind === 'git-remote'
    && /bug138-fixture/.test(created.body.project.identity.remoteUrl ?? ''),
    created.body?.project?.identity);

  const before = await j(`/api/projects/${id}/sessions`);
  const beforeCount = before.body?.sessions?.length ?? 0;
  const beforeIds = new Set((before.body?.sessions ?? []).map((s) => s.sessionId));
  check('the project lists its real session history before the rename',
    beforeCount === seeded.copied, `${beforeCount} sessions (seeded ${seeded.copied})`);

  /* Read one transcript end-to-end so "the history is there" means readable,
     not merely counted. */
  const sample = (before.body?.sessions ?? []).slice().sort((a, b) => b.fileBytes - a.fileBytes)[0];
  const txBefore = await j(`/api/transcript/${encodeURIComponent(sample.encodedDir)}/${encodeURIComponent(sample.sessionId)}?tail=50`);
  check('a real transcript reads before the rename',
    txBefore.status === 200 && (txBefore.body?.messages?.length ?? 0) > 0,
    `${txBefore.status}, ${txBefore.body?.messages?.length ?? 0} messages in the largest session`);

  /* ---------------------------- the rename, for real, on disk ------------- */
  fs.renameSync(ALPHA, BETA);
  check('the directory really is gone from the recorded path', !fs.existsSync(ALPHA), sp(`${ALPHA} → ${BETA}`));

  const listed = await j('/api/projects');
  const row = (listed.body?.projects ?? []).find((p) => p.id === id);
  check('the project list reports the directory as missing', row?.pathMissing === true, row?.pathMissing);
  check('a healthy project is NOT flagged',
    (listed.body?.projects ?? []).filter((p) => p.pathMissing).length === 1,
    `${(listed.body?.projects ?? []).filter((p) => p.pathMissing).length} of ${listed.body?.projects?.length} flagged`);

  /* ---- the user's actual path: start a session and read what it says ----- */
  const startErr = await startAndCollect(PORT, id);
  check('starting a session refuses instead of dying with a bare Error',
    !!startErr && startErr.fatal === true, startErr ? 'fatal error event' : 'no error event at all');
  check('the refusal names the path Orchard expected',
    !!startErr && startErr.message.includes(ALPHA), startErr ? sp(startErr.message.split('\n')[0]) : '—');
  check('the refusal is actionable (restore it, or repoint it — sessions come along)',
    !!startErr && /restore/i.test(startErr.message) && /Settings/.test(startErr.message) && /carries/.test(startErr.message),
    startErr ? sp(startErr.message.slice(-200)) : '—');

  /* ---------------------------- the offer -------------------------------- */
  const offer = await j(`/api/projects/${id}/repoint-candidates`);
  const match = (offer.body?.candidates ?? []).filter((c) => c.confidence === 'match');
  check('the renamed directory is found by the project\'s RECORDED identity',
    match.length === 1 && match[0].hostPath === BETA, match.map((c) => sp(c.hostPath)));
  check('a recorded-identity match is reported unambiguous',
    offer.body?.unambiguous === true && offer.body?.cannotDecide === null, `unambiguous=${offer.body?.unambiguous}`);
  check('every other nearby directory stays UNVERIFIED, never a match',
    (offer.body?.candidates ?? []).every((c) => c.confidence === 'match' ? c.hostPath === BETA : true),
    `${offer.body?.candidates?.length} candidates, ${match.length} match`);
  check('finding the answer still did not write it',
    (await j(`/api/projects/${id}`)).body?.project?.hostPath === ALPHA, 'hostPath unchanged by the lookup');

  /* --------- THE CRITERION: repoint, and the history is still there ------- */
  const repoint = await j(`/api/projects/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: BETA }),
  });
  check('the repoint is accepted', repoint.status === 200 && repoint.body?.project?.hostPath === BETA,
    `${repoint.status} → ${sp(repoint.body?.project?.hostPath)}`);
  check('the old path is remembered, so nothing is stranded',
    (repoint.body?.project?.pastPaths ?? [])[0] === ALPHA, (repoint.body?.project?.pastPaths ?? []).map(sp));
  check('the reply REPORTS the carry rather than leaving the user to check',
    repoint.body?.pathChange?.carriedSessions === beforeCount,
    `pathChange.carriedSessions=${repoint.body?.pathChange?.carriedSessions} (was ${beforeCount})`);

  const after = await j(`/api/projects/${id}/sessions`);
  const afterIds = new Set((after.body?.sessions ?? []).map((s) => s.sessionId));
  check('EVERY session still lists under the project after the repoint',
    afterIds.size === beforeIds.size && [...beforeIds].every((x) => afterIds.has(x)),
    `${afterIds.size} of ${beforeIds.size} carried`);
  const sampleAfter = (after.body?.sessions ?? []).find((s) => s.sessionId === sample.sessionId);
  const txAfter = await j(`/api/transcript/${encodeURIComponent(sampleAfter?.encodedDir ?? '')}/${encodeURIComponent(sample.sessionId)}?tail=50`);
  check('and still READS — same transcript, same message count',
    txAfter.status === 200 && txAfter.body?.messages?.length === txBefore.body?.messages?.length,
    `${txAfter.status}, ${txAfter.body?.messages?.length} vs ${txBefore.body?.messages?.length} messages`);
  check('no file was moved: the history is still in the ORIGINAL store dir',
    fs.existsSync(path.join(STORE, encodeCwd(ALPHA))) && !fs.existsSync(path.join(STORE, encodeCwd(BETA))),
    `${encodeCwd(ALPHA)} present, ${encodeCwd(BETA)} not created`);
  check('identity was re-declared from the directory it now points at',
    repoint.body?.project?.identity?.capturedFrom === BETA, sp(repoint.body?.project?.identity?.capturedFrom));

  /* ---- a session can now START again (the whole point of repointing) ----- */
  const startErr2 = await startAndCollect(PORT, id, { stopAfterStatus: true });
  check('a session on the repointed project no longer refuses on the directory',
    !(startErr2 && startErr2.message.includes('working directory is missing')),
    startErr2 ? sp(startErr2.message.slice(0, 120)) : 'no directory refusal');

  /* ------------------------------ reversibility --------------------------- */
  fs.renameSync(BETA, ALPHA);
  const back = await j(`/api/projects/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: ALPHA }),
  });
  check('repointing BACK is accepted', back.status === 200 && back.body?.project?.hostPath === ALPHA, sp(back.body?.project?.hostPath));
  check('the path we came back to is dropped from the past list, not accumulated',
    !(back.body?.project?.pastPaths ?? []).includes(ALPHA) && (back.body?.project?.pastPaths ?? []).includes(BETA),
    (back.body?.project?.pastPaths ?? []).map(sp));
  const afterBack = await j(`/api/projects/${id}/sessions`);
  check('and the history is STILL all there after the round trip',
    (afterBack.body?.sessions ?? []).length === beforeCount,
    `${(afterBack.body?.sessions ?? []).length} of ${beforeCount}`);

  /* --------------------------- refusals that protect ---------------------- */
  const typo = await j(`/api/projects/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: path.join(WORK, 'no-such-directory-here') }),
  });
  check('a typo is refused, not recorded as the new truth',
    typo.status === 400 && /is not an existing directory/.test(typo.body?.error ?? ''), `${typo.status} ${typo.body?.error}`);

  const other = await j('/api/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: fs.mkdirSync(path.join(WORK, 'neighbour'), { recursive: true }) ?? path.join(WORK, 'neighbour'), applyMethod: false }),
  });
  const clash = await j(`/api/projects/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: path.join(WORK, 'neighbour') }),
  });
  check('repointing onto ANOTHER project\'s directory is refused (their histories would merge)',
    clash.status === 400 && /already points at/.test(clash.body?.error ?? ''),
    `${clash.status} ${clash.body?.error}  (neighbour add: ${other.status})`);

  const stillOk = await j(`/api/projects/${id}`);
  check('after both refusals the project still points where it did',
    stillOk.body?.project?.hostPath === ALPHA, sp(stillOk.body?.project?.hostPath));
}

/** Open the real session socket, send a real `start`, return the error event. */
function startAndCollect(port, projectId, { stopAfterStatus = false } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { ws.close(); } catch { /* closing */ } resolve(v); };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'start', projectId, prompt: 'ping' })));
    ws.on('message', (raw) => {
      let e; try { e = JSON.parse(String(raw)); } catch { return; }
      if (e.t === 'error') finish(e);
      // The repointed case must NOT refuse on the directory; we only need to see
      // it get past the preflight, so bail at the first sign of real progress
      // rather than letting a real CLI turn run.
      if (stopAfterStatus && (e.t === 'status' || e.t === 'session')) finish(null);
    });
    ws.on('error', () => finish(null));
    setTimeout(() => finish(null), 25_000).unref();
  });
}

/* ------------------------------------------------------------------ main */

async function main() {
  ({ execFileSync: childExecFileSync } = await import('node:child_process'));
  console.log('BUG-138 — follow a renamed project directory, and keep the sessions\n');
  try {
    await partA();
    await partB();
  } finally {
    stopServer();
    await sleep(300);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('FAILURES:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log(`scratch: ${sp(SCRATCH)}`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  stopServer();
  process.exit(1);
});
