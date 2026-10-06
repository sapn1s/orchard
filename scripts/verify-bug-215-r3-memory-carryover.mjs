/**
 * BUG-215 round 3 — a forked container→direct session must inherit the project's
 * accumulated AGENT MEMORY, not start "without my notes".
 *
 *   node scripts/verify-bug-215-r3-memory-carryover.mjs
 *
 * THE BUG. Claude auto-memory lives at <store root>/<encodedDir>/memory/*.md, and
 * the encodedDir follows the CLI's cwd: the host path when a project runs `direct`
 * (`-home-…-proj`) but `/workspace/<id>` when it runs in a container
 * (`-workspace-<id>`). A project whose session ran in a container therefore wrote
 * its memory into `-workspace-<id>/memory`; after the container→direct fork the new
 * session's own encoded dir is `-home-…-proj/memory`, which is EMPTY — so the fork
 * starts amnesiac. Observed live on a real project (name redacted): 47 memory files under
 * `-workspace-<proj>/memory`, 0 under `-home-…-<proj>/memory`.
 *
 * THE FIX (memories.ts). One canonical memory dir per project
 * (`canonicalMemoryDir`, anchored on the container store dir), and the
 * host/direct encoding's `memory` is a SYMLINK to it (`ensureUnifiedMemoryDir`,
 * called from `startSession` before the CLI spawns). Merging never loses a file:
 * exact dups are dropped, true name clashes keep BOTH. `listMemories` dedupes by
 * realpath so the shared dir is not counted twice in the memories panel.
 *
 * PART A — MODULE, real memories.ts over a real-shaped scratch fixture (mirrors
 *   the live shape: a populated container-store memory dir incl a MEMORY.md index, an
 *   EMPTY host-encoded dir, and a separate Windows-origin dir that must stay
 *   separate). MUST-FAIL (pre-fix state, before calling the fix): the host-encoded
 *   memory dir a direct session reads is empty. After `ensureUnifiedMemoryDir`:
 *   the host dir is a symlink resolving to the canonical dir, a direct CLI reading
 *   its own encoded dir now sees every file, and `listMemories` returns them once
 *   (not doubled), with the Windows dir still distinct. Plus: merge-never-loses
 *   (dup dropped, clash keeps both), idempotency, and the coincident-encoding
 *   no-op.
 *
 * PART B — SERVER, the real `GET /api/projects/:id/memories` route (index.ts) over
 *   a real scratch server. Register a direct project, plant a populated
 *   container-store memory dir, run the unify the way session start does, then GET
 *   the route: the memories panel returns the container-recorded memories exactly
 *   once — the user's carried-over notes, visible where they look for them.
 *
 * PART C — WIRING: `startSession` calls `ensureUnifiedMemoryDir` before spawning
 *   (source assertion — a live CLI spawn needs auth and the SDK harness is
 *   bit-rotted, same limit prior rounds hit; the behaviour is proven in A/B).
 *
 * Leak hygiene: every path/name/id here is synthetic (/orchard-scratch/*, scratch
 * tmp dirs). No real project, home, username, or session id.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');

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

// A representative, realistic-state memory set (index + a mix of types), not the
// minimal single-file case — mirrors how a real project accumulates memory.
function plantMemory(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
}
const CONTAINER_FILES = {
  'MEMORY.md': '# Memory index\n- [prefs](feedback_prefs.md)\n- [deploy](deploy-notes.md)\n',
  'feedback_prefs.md': '---\ndescription: no emojis\ntype: feedback\n---\nUser prefers no emojis.\n',
  'deploy-notes.md': '---\ndescription: deploy pipeline\ntype: project\n---\nRun the pipeline via make.\n',
  'router-eval-project.md': 'Long-running router eval notes.\n',
  'user-profile.md': '---\ntype: user\n---\nFounder persona.\n',
};

// ------------------------------------------------------------------ PART A
async function partA() {
  console.log('\n========== PART A — module: host/direct encoding inherits container memory via one canonical dir ==========');
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b215r3-a-store-'));
  const prevStore = process.env.CLAUDE_PROJECTS_DIR;
  process.env.CLAUDE_PROJECTS_DIR = STORE;
  try {
    const mem = await import(`${path.join(ROOT, 'src', 'server', 'memories.ts')}?a=${Date.now()}`);
    const cm = await import(`${path.join(ROOT, 'src', 'server', 'container-manager.ts')}?a=${Date.now()}`);
    const sh = await import(`${path.join(ROOT, 'src', 'lib', 'session-history.ts')}?a=${Date.now()}`);

    // The real scenario: session RAN in a container, project is now `direct`.
    const id = 'acmesvc';
    const hostPath = '/orchard-scratch/projects/acme-svc';
    const project = { id, hostPath };
    const containerDir = cm.containerStoreDirName({ id });   // -workspace-acmesvc
    const hostEnc = sh.encodeCwd(hostPath);                  // -orchard-scratch-projects-acme-svc
    const canonical = mem.canonicalMemoryDir(project);
    const hostMemDir = path.join(STORE, hostEnc, 'memory');

    check('A: sanity — the two encodings differ (container vs host)', containerDir !== hostEnc,
      `container=${containerDir} host=${hostEnc}`);
    check('A: canonicalMemoryDir is anchored on the CONTAINER store dir', canonical === path.join(STORE, containerDir, 'memory'),
      canonical);

    // Container-recorded memory (populated) + the host dir the direct CLI reads
    // (EMPTY — exactly the live incident's shape). Also a Windows-origin dir with
    // its OWN distinct memory that must never be merged away.
    plantMemory(path.join(STORE, containerDir, 'memory'), CONTAINER_FILES);
    fs.mkdirSync(hostMemDir, { recursive: true });  // the CLI pre-creates an empty one
    const winDir = 'C--Users-dev-Documents-acme-svc';
    plantMemory(path.join(STORE, winDir, 'memory'), { 'windows-only.md': 'recorded on Windows.\n' });

    // MUST-FAIL (pre-fix state): a direct session reads its OWN encoded memory dir,
    // which is empty — the amnesia the user reported.
    const preFixHostFiles = fs.readdirSync(hostMemDir).filter((n) => n.endsWith('.md'));
    check('A: MUST-FAIL pre-fix — the host/direct memory dir the fork reads is EMPTY (the bug)',
      preFixHostFiles.length === 0, `host memory files pre-fix = ${preFixHostFiles.length}`);
    const preFixList = mem.listMemories([hostEnc]);
    check('A: MUST-FAIL pre-fix — listMemories over the host encoding is empty',
      preFixList.length === 0, `listMemories([host]) = ${preFixList.length}`);

    // THE FIX — exactly what startSession now calls.
    const report = mem.ensureUnifiedMemoryDir(project);
    check('A: ensureUnifiedMemoryDir linked the host encoding to the canonical dir',
      report.linkedFrom === hostMemDir && report.canonical === canonical && report.conflicts.length === 0,
      JSON.stringify(report));

    // The host encoding is now a symlink resolving to the canonical dir.
    const lst = fs.lstatSync(hostMemDir);
    check('A: the host/direct memory dir is now a SYMLINK', lst.isSymbolicLink(), `isSymlink=${lst.isSymbolicLink()}`);
    check('A: it resolves to the canonical dir', fs.realpathSync(hostMemDir) === fs.realpathSync(canonical),
      `${fs.realpathSync(hostMemDir)} === ${fs.realpathSync(canonical)}`);

    // A direct CLI reading its OWN encoded memory dir now sees every file.
    const postFixHostFiles = fs.readdirSync(hostMemDir).filter((n) => n.endsWith('.md')).sort();
    const expected = Object.keys(CONTAINER_FILES).sort();
    check('A: the direct session now sees ALL container-recorded memory through its own dir',
      JSON.stringify(postFixHostFiles) === JSON.stringify(expected),
      `host reads: ${postFixHostFiles.join(',')}`);
    // Byte-for-byte, not just names.
    const bytesOk = expected.every((n) =>
      fs.readFileSync(path.join(hostMemDir, n), 'utf8') === CONTAINER_FILES[n]);
    check('A: carried-over memory is byte-identical to what the container wrote', bytesOk, `bytesOk=${bytesOk}`);

    // listMemories over BOTH project encodings + the Windows dir dedupes the shared
    // physical dir (5 project files) yet keeps the distinct Windows file → 6, not 11.
    const listed = mem.listMemories([hostEnc, containerDir, winDir]);
    const names = listed.map((m) => `${m.name}`).sort();
    check('A: listMemories dedupes the shared dir (not double-counted) and keeps the Windows one separate',
      listed.length === 6 && names.includes('windows-only.md') && names.filter((n) => n === 'MEMORY.md').length === 1,
      `count=${listed.length} names=${names.join(',')}`);

    // Idempotent — a second call is a no-op.
    const again = mem.ensureUnifiedMemoryDir(project);
    check('A: idempotent — a second call reports alreadyLinked and changes nothing',
      again.alreadyLinked === true && again.linkedFrom === null && again.merged.length === 0, JSON.stringify(again));
  } finally {
    if (prevStore === undefined) delete process.env.CLAUDE_PROJECTS_DIR; else process.env.CLAUDE_PROJECTS_DIR = prevStore;
    try { fs.rmSync(STORE, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ------------------------------------------------ PART A2 — merge never loses
async function partMerge() {
  console.log('\n========== PART A2 — merge across a prior split never loses a file (dup dropped, clash keeps both) ==========');
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b215r3-m-store-'));
  const prevStore = process.env.CLAUDE_PROJECTS_DIR;
  process.env.CLAUDE_PROJECTS_DIR = STORE;
  try {
    const mem = await import(`${path.join(ROOT, 'src', 'server', 'memories.ts')}?a=${Date.now()}`);
    const cm = await import(`${path.join(ROOT, 'src', 'server', 'container-manager.ts')}?a=${Date.now()}`);
    const sh = await import(`${path.join(ROOT, 'src', 'lib', 'session-history.ts')}?a=${Date.now()}`);

    const id = 'splitsvc';
    const hostPath = '/orchard-scratch/projects/split-svc';
    const project = { id, hostPath };
    const containerDir = cm.containerStoreDirName({ id });
    const hostEnc = sh.encodeCwd(hostPath);
    const canonical = mem.canonicalMemoryDir(project);
    const hostMemDir = path.join(STORE, hostEnc, 'memory');

    // BOTH sides populated (a project that ran both ways before the fix).
    plantMemory(canonical, {
      'shared.md': 'IDENTICAL bytes both sides.\n',       // exact dup → drop one copy
      'clash.md': 'CONTAINER version of clash.\n',        // true clash → keep both
      'container-only.md': 'only in container.\n',
    });
    plantMemory(hostMemDir, {
      'shared.md': 'IDENTICAL bytes both sides.\n',       // same bytes as canonical
      'clash.md': 'HOST version of clash — different!\n', // different bytes
      'host-only.md': 'only on host.\n',
    });

    const report = mem.ensureUnifiedMemoryDir(project);
    check('A2: reported exactly one conflict (clash.md), kept both', report.conflicts.length === 1 && report.conflicts[0].name === 'clash.md',
      JSON.stringify(report.conflicts));

    const finalNames = fs.readdirSync(canonical).sort();
    // container-only, host-only, shared (deduped to one), clash (container) + clash kept-copy
    check('A2: no file lost — union present with the clash kept as TWO files',
      finalNames.includes('container-only.md') && finalNames.includes('host-only.md') &&
      finalNames.includes('shared.md') && finalNames.includes('clash.md') &&
      finalNames.some((n) => n.startsWith('clash.from-')),
      finalNames.join(','));
    check('A2: the exact-duplicate was collapsed to a single copy',
      finalNames.filter((n) => n === 'shared.md').length === 1, finalNames.filter((n) => n === 'shared.md').join(','));
    // The container clash content is preserved AND the host clash content is preserved.
    const keptAs = report.conflicts[0].keptAs;
    check('A2: BOTH clash versions survive (container in clash.md, host in the kept copy)',
      fs.readFileSync(path.join(canonical, 'clash.md'), 'utf8').includes('CONTAINER version') &&
      fs.readFileSync(path.join(canonical, keptAs), 'utf8').includes('HOST version'),
      `keptAs=${keptAs}`);
    check('A2: the host dir is now the symlink (post-merge)', fs.lstatSync(hostMemDir).isSymbolicLink(), 'symlink');

    // Coincident encoding no-op: a project whose host path IS the container store addr.
    const cid = 'coinc';
    const coincHost = `/workspace/${cid}`;
    const cReport = mem.ensureUnifiedMemoryDir({ id: cid, hostPath: coincHost });
    check('A2: coincident encoding (hostPath === container store addr) is a safe no-op',
      cReport.linkedFrom === null && cReport.alreadyLinked === false && cReport.conflicts.length === 0, JSON.stringify(cReport));
  } finally {
    if (prevStore === undefined) delete process.env.CLAUDE_PROJECTS_DIR; else process.env.CLAUDE_PROJECTS_DIR = prevStore;
    try { fs.rmSync(STORE, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ------------------------------------------------------------------ PART B
let server = null;
async function partB() {
  console.log('\n========== PART B — server: the memories panel shows the carried-over memory (deduped) ==========');
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b215r3-b-store-'));
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b215r3-b-data-'));
  const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b215r3-b-config-'));
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const prevStore = process.env.CLAUDE_PROJECTS_DIR;
  process.env.CLAUDE_PROJECTS_DIR = STORE;
  try {
    server = spawn(process.execPath, [ENTRY], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
        CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, CLAUDE_CONFIG_DIR: CONFIG },
      stdio: ['ignore', 'ignore', 'pipe'], detached: true,
    });
    server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
    if (!up) throw new Error('server never became healthy');

    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b215r3-proj-'));
    const regRes = await fetch(`${BASE}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostPath: projDir, name: 'acme-svc', isolation: 'direct', applyMethod: false }),
    });
    if (!regRes.ok) throw new Error(`register failed: ${await regRes.text()}`);
    const PID = (await regRes.json()).project.id;

    // Container-recorded memory lands under the container store dir.
    const cm = await import(`${path.join(ROOT, 'src', 'server', 'container-manager.ts')}?b=${Date.now()}`);
    const mem = await import(`${path.join(ROOT, 'src', 'server', 'memories.ts')}?b=${Date.now()}`);
    const containerDir = cm.containerStoreDirName({ id: PID });
    plantMemory(path.join(STORE, containerDir, 'memory'), CONTAINER_FILES);
    // The CLI's empty host dir, then the unify session start performs.
    const hostEnc = projDir.replace(/[^a-zA-Z0-9]/g, '-');
    fs.mkdirSync(path.join(STORE, hostEnc, 'memory'), { recursive: true });
    const report = mem.ensureUnifiedMemoryDir({ id: PID, hostPath: projDir });
    check('B: unify (as session start does) linked the host encoding', !!report.linkedFrom, JSON.stringify(report));

    const res = await fetch(`${BASE}/api/projects/${PID}/memories`);
    const body = await res.json();
    const names = (body.memories || []).map((m) => m.name).sort();
    const expected = Object.keys(CONTAINER_FILES).sort();
    check('B: the memories route returns the carried-over memory exactly once (deduped)',
      names.length === expected.length && JSON.stringify(names) === JSON.stringify(expected),
      `count=${names.length} names=${names.join(',')}`);
  } finally {
    if (server) { try { process.kill(-server.pid); } catch { /* ignore */ } try { server.kill('SIGKILL'); } catch { /* ignore */ } }
    if (prevStore === undefined) delete process.env.CLAUDE_PROJECTS_DIR; else process.env.CLAUDE_PROJECTS_DIR = prevStore;
    try { fs.rmSync(STORE, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(CONFIG, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ------------------------------------------------------------------ PART C
async function partC() {
  console.log('\n========== PART C — wiring: startSession calls ensureUnifiedMemoryDir before spawning ==========');
  const src = fs.readFileSync(path.join(ROOT, 'src', 'server', 'agent-bridge.ts'), 'utf8');
  check('C: agent-bridge imports ensureUnifiedMemoryDir from memories', /import\s*\{[^}]*ensureUnifiedMemoryDir[^}]*\}\s*from\s*'\.\/memories\.ts'/.test(src),
    'import present');
  const callIdx = src.indexOf('ensureUnifiedMemoryDir(opts.project)');
  const idIdx = src.indexOf('const id = `cs-');
  check('C: startSession calls it BEFORE minting the session id / spawning', callIdx > 0 && idIdx > 0 && callIdx < idIdx,
    `call@${callIdx} < idMint@${idIdx}`);
  check('C: a unify failure is NON-FATAL (session must not break)', /agent memory could not be unified[^]*fatal:\s*false/.test(src),
    'non-fatal guard present');
}

(async () => {
  await partA();
  await partMerge();
  await partB();
  await partC();
  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} — ${pass}/${pass + fail} checks passed`);
  if (fail) { console.log('failed:', failures.join('; ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
