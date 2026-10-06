/**
 * FEAT-155 item 3 — `container.workspaceRoot`: run a container project at bare
 * `/workspace` WITHOUT moving, orphaning or merging its session history.
 *
 *   node scripts/verify-feat-155-workspace-root.mjs            # all three parts
 *   node scripts/verify-feat-155-workspace-root.mjs --no-live  # skip §3 (docker + a real model turn)
 *
 * §1 PURE — container-manager's two declared facts (workdir vs host store dir),
 *    graded against a SYNTHESIZED pre-change formula (not HEAD — a moving
 *    baseline), plus a must-FAIL demonstration: the old "encode the container
 *    cwd" derivation, applied to two bare-root projects, yields ONE shared dir.
 * §2 SERVER, isolated store — a scratch server (CLAUDE_CONFIG_DIR +
 *    CLAUDE_PROJECTS_DIR + CLAUDE_STATION_DATA all scratch) over a busy fixture
 *    built from a REAL container transcript (`-workspace-a7cont/…`, "say hello",
 *    cwd + id rewritten): two bare-root projects, a project whose folder is
 *    literally `workspace`, the legacy `-workspace` dir, an unregistered
 *    `-workspace-ghost` dir. Lists, memories, toggle, resume-plan, and real SDK
 *    rename / pin / delete through the HTTP routes, with byte-hash manifests of
 *    every file that must not change.
 * §3 LIVE — a throwaway container project that ALREADY HAS HISTORY (seeded in
 *    the real store under its own random id), switched to workspaceRoot, driven
 *    through the real server + WS path: pwd, repo untouched, new transcript in
 *    `-workspace-<id>`, old session resumed at bare /workspace, toggle back and
 *    resume the new one. Cleans up only what it made.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ownerKeyFor, removeOwnedContainer } from './lib/owned-docker.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const LIVE = !process.argv.includes('--no-live');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];
const check = (n, ok, obs) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${typeof obs === 'string' ? obs : JSON.stringify(obs)}`);
  if (ok) pass++; else { fail++; failures.push(n); }
};
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function manifest(dir) {
  const out = {};
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = sha(p);
    }
  };
  walk(dir);
  return out;
}
const sameManifest = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/* The REAL transcript every fixture session is cut from. */
const TEMPLATE_DIR = path.join(os.homedir(), '.claude', 'projects', '-workspace-a7cont');
const TEMPLATE_SID = '02a7424c-765e-430b-b17a-4aee76a11855';
const TEMPLATE = path.join(TEMPLATE_DIR, `${TEMPLATE_SID}.jsonl`);
if (!fs.existsSync(TEMPLATE)) {
  console.error(`FAIL — the real template transcript is gone: ${TEMPLATE}. Pick another real container transcript; do not fall back to a synthetic one silently.`);
  process.exit(1);
}
const TEMPLATE_BODY = fs.readFileSync(TEMPLATE, 'utf8');
const TEMPLATE_CWD = '/workspace/a7cont';
function seedSession(storeProjects, encodedDir, cwd, mtimeSec, sid = randomUUID()) {
  const dir = path.join(storeProjects, encodedDir);
  fs.mkdirSync(dir, { recursive: true });
  const body = TEMPLATE_BODY.split(TEMPLATE_SID).join(sid).split(`"cwd":"${TEMPLATE_CWD}"`).join(`"cwd":${JSON.stringify(cwd)}`);
  const f = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(f, body, { mode: 0o600 });
  fs.utimesSync(f, mtimeSec, mtimeSec);
  return { sid, file: f };
}

/* ====================================================================== §1 */
console.log('\n--- §1 pure: two declared facts, and the must-FAIL of the old derivation ---');
const cm = await import(path.join(ROOT, 'src/server/container-manager.ts'));
const HOME = os.homedir();
const P = (id, workspaceRoot) => ({
  id, name: id, hostPath: `/tmp/feat155-pure/${id}`, isolation: 'container',
  settings: { container: { workspaceRoot }, mounts: [] },
});
const histBind = (p) => cm.desiredBinds(p).find((b) => b.why === 'session history');
{
  const id = `f155p${Math.random().toString(16).slice(2, 8)}`;
  // Synthesized pre-change formula (container-manager before FEAT-155 item 3):
  //   workdir = /workspace/<id>; history bind = ~/.claude/projects/E : /home/claude/.claude/projects/E, E = encode(workdir)
  const oldWd = `/workspace/${id}`;
  const oldEnc = oldWd.replace(/[^a-zA-Z0-9]/g, '-');
  const off = P(id, false);
  const hb = histBind(off);
  check('workspaceRoot OFF: workdir byte-identical to the pre-change formula', cm.containerWorkdir(off) === oldWd, cm.containerWorkdir(off));
  check('workspaceRoot OFF: history bind byte-identical to the pre-change formula (no drift for existing containers)',
    hb.hostPath === path.join(HOME, '.claude', 'projects', oldEnc) && hb.containerPath === `/home/claude/.claude/projects/${oldEnc}`,
    `${hb.hostPath} -> ${hb.containerPath}`);
  const on = P(id, true);
  const hbOn = histBind(on);
  check('workspaceRoot ON: workdir is bare /workspace', cm.containerWorkdir(on) === '/workspace', cm.containerWorkdir(on));
  check('workspaceRoot ON: project bind targets bare /workspace', cm.desiredBinds(on)[0].containerPath === '/workspace', cm.desiredBinds(on)[0].containerPath);
  check('ON vs OFF: host store dir name / history dir / host side of the bind are IDENTICAL',
    cm.containerStoreDirName(on) === cm.containerStoreDirName(off) && cm.containerHistoryDir(on) === cm.containerHistoryDir(off) && hbOn.hostPath === hb.hostPath && hb.hostPath === cm.containerHistoryDir(off),
    `${cm.containerStoreDirName(on)} | ${hbOn.hostPath}`);
  check('ON: only the CONTAINER side of the history bind follows the cwd (-> projects/-workspace)',
    hbOn.containerPath === '/home/claude/.claude/projects/-workspace', hbOn.containerPath);
  const A = P('f155a', true), B = P('f155b', true);
  const naiveA = cm.encodeCwdForStore(cm.containerWorkdir(A)), naiveB = cm.encodeCwdForStore(cm.containerWorkdir(B));
  check('MUST-FAIL (constructed broken variant): the OLD derivation encode(containerWorkdir) MERGES two bare-root projects into one host dir',
    naiveA === naiveB && naiveA === '-workspace', `${naiveA} == ${naiveB}`);
  check('the DECLARED store keeps them apart (host binds differ, neither is the shared -workspace)',
    histBind(A).hostPath !== histBind(B).hostPath && !histBind(A).hostPath.endsWith('/-workspace') && !histBind(B).hostPath.endsWith('/-workspace'),
    `${histBind(A).hostPath} vs ${histBind(B).hostPath}`);
}

/* ====================================================================== §2 */
console.log('\n--- §2 scratch server over a busy fixture store (real transcript, rewritten) ---');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'f155-'));
const STORE = path.join(TMP, 'store');
const PROJ = path.join(STORE, 'projects');
const DATA = path.join(TMP, 'data');
fs.mkdirSync(PROJ, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
const REAL_WS_BEFORE = manifest(path.join(HOME, '.claude', 'projects', '-workspace'));

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const server = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: STORE, CLAUDE_PROJECTS_DIR: PROJ },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d; });
try {
  for (let i = 0; i < 160; i++) { try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch {} await sleep(250); }
  const mk = (sub) => { const d = path.join(TMP, 'repos', sub); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'README.md'), sub); return d; };
  const create = async (hostPath, name, isolation) => {
    const r = await api('/api/projects', 'POST', { hostPath, name, isolation });
    if (r.status !== 201) throw new Error(`create ${name}: ${JSON.stringify(r.body)}`);
    return r.body.project;
  };
  const pA = await create(mk('alpha'), 'F155 Alpha', 'container');
  const pB = await create(mk('beta'), 'F155 Beta', 'container');
  const pD = await create(mk('workspace'), 'F155 Workspace Direct', 'direct'); // folder literally named "workspace"
  // Clean-room round-1 finding: a CONTAINER, bare-root project whose folder is named "workspace".
  const pW = await create(mk('w/workspace'), 'F155 Workspace Container', 'container');
  const pC = await create(mk('memonly'), 'F155 Memory Only', 'container');
  for (const p of [pA, pB, pW]) {
    const r = await api(`/api/projects/${p.id}`, 'PATCH', { settings: { container: { workspaceRoot: true } } });
    check(`PATCH ${p.id} workspaceRoot=true accepted and persisted`, r.status === 200 && r.body?.project?.settings?.container?.workspaceRoot === true, `status=${r.status}`);
  }
  const bad = await api(`/api/projects/${pA.id}`, 'PATCH', { settings: { container: { workspaceRoot: 'yes' } } });
  check('workspaceRoot must be a boolean (validation)', bad.status === 400, `status=${bad.status} ${JSON.stringify(bad.body?.error ?? '')}`);

  const dirA = cm.containerStoreDirName(pA), dirB = cm.containerStoreDirName(pB);
  const encD = pD.hostPath.replace(/[^a-zA-Z0-9]/g, '-');
  const t = Math.floor(Date.now() / 1000);
  const oldA = seedSession(PROJ, dirA, `/workspace/${pA.id}`, t - 3000);   // before the toggle
  const newA = seedSession(PROJ, dirA, '/workspace', t - 100);              // after: bare cwd, NEWEST
  const newB = seedSession(PROJ, dirB, '/workspace', t - 90);
  const legacy = seedSession(PROJ, '-workspace', '/workspace', t - 80);     // pre-existing legacy shared dir
  const ghost = seedSession(PROJ, '-workspace-ghost', '/workspace', t - 70); // unregistered leftover
  const ownD = seedSession(PROJ, encD, pD.hostPath, t - 60);
  const dirW = cm.containerStoreDirName(pW);
  const newW = seedSession(PROJ, dirW, '/workspace', t - 50);
  const dirC = cm.containerStoreDirName(pC); // memory but NO transcripts
  for (const d of [dirA, dirB, '-workspace', dirW, dirC]) {
    fs.mkdirSync(path.join(PROJ, d, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(PROJ, d, 'memory', `note-${d}.md`), `# memory of ${d}\n`);
  }

  // The hazard is real: the raw basename grouping DOES lump A, B, legacy and ghost together.
  process.env.CLAUDE_PROJECTS_DIR = PROJ;
  const hist = await import(path.join(ROOT, 'src/lib/session-history.ts'));
  const raw = hist.listLogicalProjects().find((g) => g.key === 'workspace');
  const rawDirs = raw ? raw.dirs.map((d) => d.encodedDir).sort() : [];
  check('MUST-FAIL premise: unfiltered basename grouping puts A, B, legacy and D in ONE group',
    [dirA, dirB, '-workspace', encD].every((d) => rawDirs.includes(d)), rawDirs.join(', '));

  const smut = await import(path.join(ROOT, 'src/server/session-mutations.ts'));
  let noLookup = null;
  try { smut.resolveSession(newA.sid, dirA); } catch (e) { noLookup = e; }
  check('MUST-FAIL premise: without the owner-declared store lookup, a bare-root session is refused (409 encoding-mismatch)',
    noLookup?.status === 409 && noLookup?.code === 'encoding-mismatch', `${noLookup?.status} ${noLookup?.code}`);

  const ids = async (p) => ((await api(`/api/projects/${p.id}/sessions`)).body?.sessions ?? []).map((s) => s.sessionId).sort();
  const listA = await ids(pA), listB = await ids(pB), listD = await ids(pD);
  check('A lists exactly its own two sessions (old /workspace/<id> + new bare /workspace)', JSON.stringify(listA) === JSON.stringify([oldA.sid, newA.sid].sort()), listA);
  check('B lists exactly its own one session', JSON.stringify(listB) === JSON.stringify([newB.sid]), listB);
  check('D (folder named "workspace") lists NONE of A/B/ghost sessions', ![oldA.sid, newA.sid, newB.sid, ghost.sid].some((s) => listD.includes(s)) && listD.includes(ownD.sid), listD);
  check('D does not list the legacy shared -workspace session (container-cwd dirs join only by declaration)', !listD.includes(legacy.sid), listD);
  const listW = await ids(pW);
  check('W (container, bare-root, folder named "workspace") lists its own session and NONE of legacy, A, B or ghost',
    listW.includes(newW.sid) && ![legacy.sid, oldA.sid, newA.sid, newB.sid, ghost.sid].some((s) => listW.includes(s)), listW);
  // Pre-existing, documented limitation (session-history groupByLogicalProject):
  // two HOST folders sharing a basename group together, so W also shows D's
  // host-recorded session. Not a container-store merge; reported, not asserted.
  console.log(`        [note] W also lists D's host-folder session (same basename, pre-existing): ${listW.includes(ownD.sid)}`);
  const memW = await api(`/api/projects/${pW.id}/memories`);
  check("W's memories route claims its own store and NOT the legacy -workspace (nor A/B)",
    (memW.body?.dirs ?? []).includes(dirW) && !(memW.body?.dirs ?? []).some((d) => d === '-workspace' || d === dirA || d === dirB), memW.body?.dirs);
  const legacyNote = path.join(PROJ, '-workspace', 'memory', 'note--workspace.md');
  const wReadLegacy = await api(`/api/projects/${pW.id}/memories?dir=-workspace&name=note--workspace.md`);
  const wDelLegacy = await api(`/api/projects/${pW.id}/memories?dir=-workspace&name=note--workspace.md`, 'DELETE');
  check('W can neither READ nor DELETE the legacy -workspace memory (400; file intact)',
    wReadLegacy.status === 400 && wDelLegacy.status === 400 && fs.existsSync(legacyNote), `read=${wReadLegacy.status} delete=${wDelLegacy.status}`);
  const memC = await api(`/api/projects/${pC.id}/memories`);
  check("a container project's memory is listed even when its store has NO transcripts",
    (memC.body?.dirs ?? []).includes(dirC) && JSON.stringify(memC.body?.memories ?? []).includes(`note-${dirC}.md`), JSON.stringify(memC.body).slice(0, 300));

  // Clean-room round-2 finding X2: a project whose HOST path is under /workspace
  // (devcontainer / Gitpod) must keep listing its own host-recorded sessions.
  {
    const regFile = path.join(DATA, 'registry.json');
    const pG = await create(mk('gitpodrepo'), 'F155 Gitpod', 'direct');
    const regJ = JSON.parse(fs.readFileSync(regFile, 'utf8'));
    regJ.projects.find((q) => q.id === pG.id).hostPath = '/workspace/gitpodrepo';
    fs.writeFileSync(regFile, JSON.stringify(regJ, null, 2));
    const g1 = seedSession(PROJ, '-workspace-gitpodrepo', '/workspace/gitpodrepo', t - 40);
    const listG = await ids(pG);
    check('a project whose host path is under /workspace still lists its own sessions', listG.includes(g1.sid), listG);
  }
  // Clean-room round-2 finding X1: a removed container project re-registered
  // under a different id at the same folder keeps its old history visible (the
  // pre-existing basename behaviour for /workspace/<id>-cwd dirs is unchanged).
  {
    const folder = mk('myrepo');
    const pOld = await create(folder, 'myrepo', 'container');
    const o1 = seedSession(PROJ, cm.containerStoreDirName(pOld), `/workspace/${pOld.id}`, t - 30);
    const del = await api(`/api/projects/${pOld.id}`, 'DELETE');
    const pNew = await create(folder, 'My Repo Renamed', 'container');
    const listN = await ids(pNew);
    check('re-registered project (new id, same folder) still sees the old /workspace/<oldid> history', del.status < 300 && listN.includes(o1.sid), `delete=${del.status} ${JSON.stringify(listN)}`);
  }

  /*
   * DELETE / RE-REGISTER / MOVE PARITY (clean-room rounds 3-9). A deleted
   * project's store is kept, and which live project lists it afterwards was
   * always decided by basename grouping on the store's recorded cwd
   * (`/workspace/<id>` -> key <id>). A bare-root session records `/workspace`,
   * which names no project. The invariant: a store whose newest session ran at
   * the bare root is listed by EXACTLY the projects that would list it had that
   * session been recorded at `/workspace/<id>` — no more (no merge), no fewer
   * (no orphan). Each scenario runs twice, identical except for that one cwd.
   */
  {
    const scenarios = {
      'same folder, new name': async (tag, folder) => ({ observers: [await create(folder, `${tag} renamed`, 'container')] }),
      'same name, other folder (id reuse)': async (tag) => ({ observers: [await create(mk(`par/${tag}/other/x`), tag, 'container')] }),
      'other folder, same basename': async (tag) => ({ observers: [await create(mk(`par/${tag}/elsewhere/${tag}`), `${tag} elsewhere`, 'container')] }),
      'moved folder, same name': async (tag, folder) => { const to = path.join(TMP, 'repos', 'par', tag, 'moved', tag); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(folder, to); return { observers: [await create(to, tag, 'container')] }; },
      'moved + renamed folder': async (tag, folder) => { const to = path.join(TMP, 'repos', 'par', tag, 'moved2', `${tag}-x`); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(folder, to); return { observers: [await create(to, `${tag} x`, 'container')] }; },
      'second clone, same basename': async (tag) => ({ observers: [await create(mk(`par/${tag}/clone2/${tag}`), `${tag} clone`, 'container')] }),
    };
    let k = 0;
    for (const [label, then] of Object.entries(scenarios)) {
      const seen = {};
      for (const mode of ['bare', 'addr']) {
        const tag = `par${k}${mode}`;
        const folder = mk(`par/${tag}/orig/${tag}`);
        const pOrig = await create(folder, tag, 'container');
        const sd = cm.containerStoreDirName(pOrig);
        const older = seedSession(PROJ, sd, `/workspace/${pOrig.id}`, t - 9);
        const newest = seedSession(PROJ, sd, mode === 'bare' ? '/workspace' : `/workspace/${pOrig.id}`, t - 8);
        await api(`/api/projects/${pOrig.id}`, 'DELETE');
        const { observers } = await then(tag, folder);
        seen[mode] = [];
        for (const o of observers) { const l = await ids(o); seen[mode].push(l.includes(older.sid) && l.includes(newest.sid) ? 'lists' : (l.includes(older.sid) || l.includes(newest.sid) ? 'PARTIAL' : 'none')); }
      }
      k++;
      check(`parity — ${label}: bare-root store listed exactly as an address-recorded one would be`, JSON.stringify(seen.bare) === JSON.stringify(seen.addr) && !seen.bare.includes('PARTIAL'), JSON.stringify(seen));
    }
  }
  // Clean-room round-13: after an id is reused by a same-name project elsewhere,
  // the ORIGINAL folder re-registered under a new name still lists its history
  // (as before FEAT-155; the id-reusing project also lists it — pre-existing).
  {
    const folder = mk('reuse/foo');
    const pP = await create(folder, 'foo', 'container');
    const sp = seedSession(PROJ, cm.containerStoreDirName(pP), `/workspace/${pP.id}`, t - 7);
    await api(`/api/projects/${pP.id}`, 'DELETE');
    const pQ = await create(mk('reuse/other/q'), 'foo', 'container');
    const pP2 = await create(folder, 'foo again', 'container');
    const lp2 = await ids(pP2);
    check('id reuse: the re-registered true owner (same folder) still lists its own history', lp2.includes(sp.sid), `Q=${pQ.id} P2=${pP2.id} ${JSON.stringify(lp2)}`);
  }
  const bigEnv = await api(`/api/projects/${pA.id}`, 'PATCH', { settings: { container: { env: { BIG: 'x'.repeat(40 * 1024) } } } });
  check('an env value over 32 KiB is refused at write time (docker create would fail E2BIG)', bigEnv.status === 400, `status=${bigEnv.status}`);
  // Clean-room round-7: a COEXISTING second clone with a different folder name never sees it.
  {
    const c1 = mk('clones/one/ml'), c2 = mk('clones/two/ml2');
    const pC1 = await create(c1, 'clone one', 'container');
    const pC2 = await create(c2, 'clone two', 'container');
    const sd = cm.containerStoreDirName(pC1);
    const sc = seedSession(PROJ, sd, '/workspace', t - 13);
    fs.mkdirSync(path.join(PROJ, sd, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(PROJ, sd, 'memory', 'private.md'), '# one\n');
    await api(`/api/projects/${pC1.id}`, 'DELETE');
    const l2 = await ids(pC2);
    const m2 = await api(`/api/projects/${pC2.id}/memories`);
    check('a coexisting other project does NOT get a deleted project\'s bare-root history or memory', !l2.includes(sc.sid) && !(m2.body?.dirs ?? []).includes(sd), `${JSON.stringify(l2)} dirs=${JSON.stringify(m2.body?.dirs)}`);
  }
  const proto = await api(`/api/projects/${pA.id}`, 'PATCH', { settings: { container: { env: JSON.parse('{"__proto__":"x"}') } } });
  check('env key __proto__ is refused, not silently dropped', proto.status === 400, `status=${proto.status}`);

  // container.env keys that would move history/config, swap the account, or spoof Orchard markers are refused.
  for (const k of ['CLAUDE_CONFIG_DIR', 'HOME', 'CLAUDE_CODE_PROJECT_DIR_NAME', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'ORCHARD_SESSION', 'CLAUDE_STATION_EXEC', 'SBMCP_SOCKET']) {
    const r = await api(`/api/projects/${pA.id}`, 'PATCH', { settings: { container: { env: { [k]: '/tmp/x' } } } });
    check(`container.env ${k} is refused (reserved)`, r.status === 400 && /reserved/.test(r.body?.error ?? ''), `status=${r.status} ${r.body?.error ?? ''}`);
  }
  const okEnv = await api(`/api/projects/${pA.id}`, 'PATCH', { settings: { container: { env: { PYTHONPATH: '/workspace/pylibs', HF_HOME: '/workspace/.hf' } } } });
  check('ordinary env (PYTHONPATH, HF_HOME) is accepted', okEnv.status === 200, `status=${okEnv.status}`);
  const pathEnv = await api(`/api/projects/${pA.id}`, 'PATCH', { settings: { container: { env: { PATH: '/opt/conda/bin:/usr/bin' } } } });
  const dollar = await api(`/api/projects/${pA.id}`, 'PATCH', { settings: { container: { env: { DB_PASS: 'pa$sw0rd' } } } });
  check('PATH (replaces the image PATH) is refused; a literal $ in a value is allowed (set as-is)', pathEnv.status === 400 && dollar.status === 200, `PATH=${pathEnv.status} $=${dollar.status}`);
  const bigMem = await api(`/api/projects/${pA.id}`, 'PATCH', { settings: { container: { memoryMb: 999999999 } } });
  check('an absurd memoryMb is refused', bigMem.status === 400, `status=${bigMem.status}`);

  const memD = await api(`/api/projects/${pD.id}/memories`);
  check("D's memories route does not claim A's or B's store dirs", !(memD.body?.dirs ?? []).includes(dirA) && !(memD.body?.dirs ?? []).includes(dirB), memD.body?.dirs);
  const memDel = await api(`/api/projects/${pD.id}/memories?dir=${encodeURIComponent(dirA)}&name=${encodeURIComponent(`note-${dirA}.md`)}`, 'DELETE');
  check("D cannot DELETE A's memory (400, file intact)", memDel.status === 400 && fs.existsSync(path.join(PROJ, dirA, 'memory', `note-${dirA}.md`)), `status=${memDel.status}`);
  const memA = await api(`/api/projects/${pA.id}/memories`);
  check("A's memories route includes its own store dir", (memA.body?.dirs ?? []).includes(dirA), memA.body?.dirs);

  // Toggle OFF then ON: history never moves.
  for (const v of [false, true]) {
    await api(`/api/projects/${pA.id}`, 'PATCH', { settings: { container: { workspaceRoot: v } } });
    const l = await ids(pA);
    check(`toggle workspaceRoot=${v}: A still lists both sessions`, JSON.stringify(l) === JSON.stringify([oldA.sid, newA.sid].sort()), l);
  }

  // Resume planning (the real fork.ts functions, same store) in both states.
  const fork = await import(path.join(ROOT, 'src/server/fork.ts'));
  for (const v of [false, true]) {
    const proj = { ...pA, settings: { ...pA.settings, container: { ...(pA.settings.container ?? {}), workspaceRoot: v } } };
    const e1 = fork.explainUnresumable(proj, oldA.sid), e2 = fork.explainUnresumable(proj, newA.sid);
    check(`workspaceRoot=${v}: both A sessions are resumable where the CLI will look (target ${fork.targetEncodedDirFor(proj)})`,
      e1 === null && e2 === null && fork.targetEncodedDirFor(proj) === dirA, JSON.stringify({ e1: e1?.message ?? null, e2: e2?.message ?? null }));
  }

  // Mutations via the real SDK through the real routes.
  const untouched = () => ({ legacy: sha(legacy.file), newB: sha(newB.file), oldA: sha(oldA.file), ghost: sha(ghost.file), ownD: sha(ownD.file) });
  const before = untouched();
  const ren = await api(`/api/sessions/${newA.sid}`, 'PATCH', { title: 'renamed bare-root', dir: dirA });
  check('rename a bare-/workspace session in A (was a 409 encoding-mismatch without the declared store)',
    ren.status === 200 && fs.readFileSync(newA.file, 'utf8').includes('"customTitle":"renamed bare-root"'), `status=${ren.status} ${JSON.stringify(ren.body?.error ?? ren.body?.code ?? '')}`);
  const pin = await api(`/api/sessions/${newA.sid}`, 'PATCH', { pinned: true, dir: dirA });
  check('pin it', pin.status === 200 && fs.readFileSync(newA.file, 'utf8').includes('"tag":"pinned"'), `status=${pin.status}`);
  check('no other file changed (legacy -workspace, B, old A, ghost, D) and nothing landed in -workspace',
    JSON.stringify(untouched()) === JSON.stringify(before) && fs.readdirSync(path.join(PROJ, '-workspace')).filter((f) => f.endsWith('.jsonl')).length === 1,
    fs.readdirSync(path.join(PROJ, '-workspace')));
  // Clean-room round-11: a kept store whose project is gone (or re-registered
  // under a new id) is still listed, so its bare-root sessions must stay
  // mutable — the store's address is exact, whoever owns it now.
  const gh = await api(`/api/sessions/${ghost.sid}`, 'PATCH', { title: 'ghost renamed', dir: '-workspace-ghost' });
  check('a bare-root session in an UNREGISTERED project store is renamable (address is exact) and only that file changes',
    gh.status === 200 && fs.readFileSync(ghost.file, 'utf8').includes('"customTitle":"ghost renamed"') && sha(legacy.file) === before.legacy && sha(newB.file) === before.newB,
    `status=${gh.status} code=${gh.body?.code}`);
  const legacyRen = await api(`/api/sessions/${legacy.sid}`, 'PATCH', { title: 'x', dir: '-workspace' });
  console.log(`        [note] the legacy shared -workspace session is canonical (cwd /workspace), so it is mutable exactly as before: status=${legacyRen.status}`);
  before.ghost = sha(ghost.file); before.legacy = sha(legacy.file);
  const renOld = await api(`/api/sessions/${oldA.sid}`, 'PATCH', { title: 'old renamed', dir: dirA });
  check('rename the OLD (canonical cwd) session in A still works', renOld.status === 200, `status=${renOld.status}`);
  // The rename/pin above appended to the file, which makes it "live" to the
  // delete route's safety window; age it past that window as a quiet session would be.
  fs.utimesSync(newA.file, t - 3600, t - 3600);
  const del = await api(`/api/sessions/${newA.sid}?dir=${encodeURIComponent(dirA)}&confirm=${newA.sid}`, 'DELETE');
  check('delete the bare-root session: it is gone, backup verified, legacy/B/ghost/D untouched',
    del.status === 200 && !fs.existsSync(newA.file) && sha(legacy.file) === before.legacy && sha(newB.file) === before.newB && sha(ghost.file) === before.ghost && sha(ownD.file) === before.ownD,
    `status=${del.status} ${JSON.stringify(del.body?.error ?? '')}`);
} catch (err) {
  check('no exception in §2', false, String(err?.stack || err));
} finally {
  try { server.kill('SIGKILL'); } catch {}
  if (/Error|throw/i.test(serverErr) && fail) console.log(`  [server stderr tail] ${serverErr.slice(-800)}`);
  fs.rmSync(TMP, { recursive: true, force: true });
}
check('the REAL ~/.claude/projects/-workspace was not touched by §2', sameManifest(REAL_WS_BEFORE, manifest(path.join(HOME, '.claude', 'projects', '-workspace'))), Object.keys(REAL_WS_BEFORE).length + ' files');

/* ====================================================================== §3 */
if (!LIVE) {
  console.log('\n--- §3 SKIPPED (--no-live) — UNPROVEN: live CLI at bare /workspace, resume across toggle ---');
} else {
  console.log('\n--- §3 live: a throwaway project WITH history, switched to bare /workspace ---');
  delete process.env.CLAUDE_PROJECTS_DIR; // §2 set it for its in-process imports; the live server must read the REAL store
  const WebSocket = (await import('ws')).default;
  const LDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'f155-live-data-'));
  const LWORK = fs.mkdtempSync(path.join(os.tmpdir(), 'f155-live-work-'));
  fs.writeFileSync(path.join(LWORK, 'README.md'), 'feat-155 live\n');
  fs.mkdirSync(path.join(LWORK, 'data'));
  fs.writeFileSync(path.join(LWORK, 'data', 'x.txt'), 'hardcoded path target\n');
  const LPORT = await freePort();
  const LB = `http://127.0.0.1:${LPORT}`;
  const lapi = async (p, method = 'GET', body) => {
    const r = await fetch(LB + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  const lsrv = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(LPORT), CLAUDE_STATION_DATA: LDATA }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let cname = null, storeDir = null, extDir = null;
  const REAL_PROJECTS = path.join(HOME, '.claude', 'projects');
  const realWsBefore = manifest(path.join(REAL_PROJECTS, '-workspace'));
  const turn = async (msg) => {
    const ws = new WebSocket(`ws://127.0.0.1:${LPORT}/ws`);
    const ev = [];
    ws.on('message', (m) => ev.push(JSON.parse(String(m))));
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send(JSON.stringify(msg));
    const t0 = Date.now();
    while (Date.now() - t0 < 240_000 && !ev.some((e) => e.t === 'turn-end' || (e.t === 'error' && e.fatal))) await sleep(200);
    const init = ev.find((e) => e.t === 'session-init');
    const end = ev.find((e) => e.t === 'turn-end');
    const err = ev.find((e) => e.t === 'error' && e.fatal);
    ws.send(JSON.stringify({ type: 'close' }));
    // Wait for the session to be REALLY closed: a resume of a still-live session
    // re-attaches to it (no ensure, no drift check), which is not what we test.
    const t1 = Date.now();
    while (Date.now() - t1 < 30_000 && !ev.some((e) => e.t === 'session-closed')) await sleep(200);
    ws.close();
    for (let i = 0; i < 50; i++) {
      const live = (await lapi('/api/sessions')).body?.sessions ?? [];
      if (!live.length) break;
      await sleep(200);
    }
    return { init, end, err, statuses: ev.filter((e) => e.t === 'status').map((e) => e.status) };
  };
  try {
    for (let i = 0; i < 160; i++) { try { const r = await fetch(`${LB}/api/health`); if (r.ok) break; } catch {} await sleep(250); }
    const c = await lapi('/api/projects', 'POST', { hostPath: LWORK, name: `F155Live ${Math.random().toString(16).slice(2, 6)}`, isolation: 'container' });
    if (c.status !== 201) throw new Error(`create: ${JSON.stringify(c.body)}`);
    const proj = c.body.project;
    cname = cm.containerName(proj.id);
    storeDir = path.join(REAL_PROJECTS, cm.containerStoreDirName(proj));
    if (fs.existsSync(storeDir)) throw new Error(`refusing: ${storeDir} already exists (not ours)`);
    // Existing history, recorded the OLD way (cwd /workspace/<id>), in the real store.
    const old = seedSession(REAL_PROJECTS, cm.containerStoreDirName(proj), `/workspace/${proj.id}`, Math.floor(Date.now() / 1000) - 600);

    const pre = (await lapi(`/api/projects/${proj.id}/sessions`)).body?.sessions?.map((s) => s.sessionId) ?? [];
    check('PRECONDITION: the throwaway project already lists its existing session', pre.includes(old.sid), pre);

    const LEXT = fs.mkdtempSync(path.join(os.tmpdir(), 'f155-live-ext-'));
    extDir = LEXT;
    fs.writeFileSync(path.join(LEXT, 'e.txt'), 'external data\n');
    // A repo symlink pointing OUTSIDE the repo, with a mount nested beneath it:
    // Orchard must not create the mountpoint through the link on the host.
    const OUTSIDE = path.join(LEXT, 'outside');
    fs.mkdirSync(OUTSIDE);
    fs.symlinkSync(OUTSIDE, path.join(LWORK, 'lnk'));
    const pm = await lapi(`/api/projects/${proj.id}`, 'PATCH', { settings: { mounts: [
      { hostPath: LEXT, containerPath: '/workspace/extdata', readOnly: true },
      { hostPath: path.join(LEXT, 'e.txt'), containerPath: '/workspace/lnk/sub/e.txt', readOnly: true },
    ] } });
    check('a user mount nested at /workspace/extdata is accepted', pm.status === 200, `status=${pm.status} ${JSON.stringify(pm.body?.error ?? '')}`);
    const pr = await lapi(`/api/projects/${proj.id}`, 'PATCH', { settings: { container: { workspaceRoot: true } } });
    check('switch to workspaceRoot', pr.status === 200, `status=${pr.status}`);
    const st = await lapi(`/api/projects/${proj.id}/container/start`, 'POST', {});
    check('container ensured through the real route', st.body?.state === 'running', JSON.stringify({ state: st.body?.state, problem: st.body?.problem, error: st.body?.error }).slice(0, 300));
    const pwd = spawnSync('docker', ['exec', cname, 'pwd'], { encoding: 'utf8' }).stdout.trim();
    const cat = spawnSync('docker', ['exec', cname, 'cat', '/workspace/data/x.txt'], { encoding: 'utf8' }).stdout.trim();
    const ext = spawnSync('docker', ['exec', cname, 'cat', '/workspace/extdata/e.txt'], { encoding: 'utf8' }).stdout.trim();
    check('the nested user mount is visible at /workspace/extdata inside the container', ext === 'external data', ext);
    check('nothing was created on the HOST through the repo symlink (outside/ still empty)', fs.readdirSync(OUTSIDE).length === 0, fs.readdirSync(OUTSIDE));
    console.log(`        [observed] docker exec pwd = ${pwd}; cat /workspace/data/x.txt = ${cat}`);
    check('inside the container: workdir is /workspace and /workspace/data is the repo\'s data/', pwd === '/workspace' && cat === 'hardcoded path target', `${pwd} | ${cat}`);

    const listed0 = (await lapi(`/api/projects/${proj.id}/sessions`)).body?.sessions?.map((s) => s.sessionId) ?? [];
    check('after the switch, the existing session is STILL listed (no orphan)', listed0.includes(old.sid), listed0);

    const r1 = await turn({ type: 'start', projectId: proj.id, prompt: 'Reply with exactly: ok' });
    check('a new session runs at bare /workspace and completes', r1.init?.cwd === '/workspace' && r1.end?.subtype === 'success', `cwd=${r1.init?.cwd} end=${r1.end?.subtype} err=${r1.err?.message?.slice(0, 200) ?? ''}`);
    const newSid = r1.init?.sessionId;
    const newFile = newSid ? path.join(storeDir, `${newSid}.jsonl`) : null;
    check("its transcript landed in the project's OWN host store dir (not -workspace)", !!newFile && fs.existsSync(newFile) && fs.readFileSync(newFile, 'utf8').includes('"cwd":"/workspace"'), newFile ?? '(no session id)');
    const mirrorRoot = path.join(LDATA, 'transcripts');
    const mirrored = spawnSync('find', [mirrorRoot, '-name', `${newSid}.jsonl`], { encoding: 'utf8' }).stdout.trim();
    check('the FEAT-144 durable mirror copied it under the declared store dir, not -workspace',
      mirrored.includes(`/${cm.containerStoreDirName(proj)}/`) && !mirrored.includes('/-workspace/'), mirrored || '(no mirror file)');
    const listed1 = (await lapi(`/api/projects/${proj.id}/sessions`)).body?.sessions?.map((s) => s.sessionId) ?? [];
    check('the project lists BOTH the old and the new session', listed1.includes(old.sid) && listed1.includes(newSid), listed1);

    // Clean-room round-11: a fork of a container Claude session (which now has a
    // FEAT-144 durable mirror under the project's store) without resumeEncodedDir
    // must not be mistaken for an Orchard-owned Codex transcript.
    const rf = await turn({ type: 'start', projectId: proj.id, prompt: 'Reply with exactly: forked', resumeSessionId: newSid, fork: true });
    check('forking the bare-root session (no resumeEncodedDir) is not refused as "Codex"',
      !/Orchard-owned \(Codex\)/.test(rf.err?.message ?? '') && rf.end?.subtype === 'success' && rf.init?.sessionId && rf.init.sessionId !== newSid,
      `forked=${rf.init?.sessionId} end=${rf.end?.subtype} err=${rf.err?.message?.slice(0, 200) ?? ''}`);
    const r2 = await turn({ type: 'start', projectId: proj.id, prompt: 'Reply with exactly: resumed', resumeSessionId: old.sid, resumeEncodedDir: cm.containerStoreDirName(proj) });
    check('the OLD session (recorded at /workspace/<id>) resumes at bare /workspace', r2.end?.subtype === 'success' && r2.init?.sessionId === old.sid, `sid=${r2.init?.sessionId} end=${r2.end?.subtype} err=${r2.err?.message?.slice(0, 200) ?? ''}`);

    // Clean-room round-12: a DIRECTORY mount over a repo FILE is refused by name, not a runc error.
    const goodMounts = (await lapi(`/api/projects/${proj.id}`)).body?.project?.settings?.mounts ?? (await lapi('/api/projects')).body?.projects?.find((q) => q.id === proj.id)?.settings?.mounts;
    await lapi(`/api/projects/${proj.id}`, 'PATCH', { settings: { mounts: [...(goodMounts ?? []), { hostPath: LEXT, containerPath: '/workspace/README.md', readOnly: true }] } });
    const badStart = await lapi(`/api/projects/${proj.id}/container/start`, 'POST', {});
    check('a directory mount over a repo file is refused with a named reason (container left as it was)',
      badStart.status >= 400 && /cannot be mounted over it/.test(JSON.stringify(badStart.body)), `status=${badStart.status} ${JSON.stringify(badStart.body).slice(0, 300)}`);
    await lapi(`/api/projects/${proj.id}`, 'PATCH', { settings: { mounts: goodMounts ?? [] } });
    const back = await lapi(`/api/projects/${proj.id}`, 'PATCH', { settings: { container: { workspaceRoot: false } } });
    check('toggle back OFF', back.status === 200, `status=${back.status}`);
    const r3 = await turn({ type: 'start', projectId: proj.id, prompt: 'Reply with exactly: back', resumeSessionId: newSid, resumeEncodedDir: cm.containerStoreDirName(proj) });
    check('after toggling back, the bare-root session resumes at /workspace/<id>', r3.end?.subtype === 'success' && r3.init?.cwd === `/workspace/${proj.id}`, `cwd=${r3.init?.cwd} end=${r3.end?.subtype} err=${r3.err?.message?.slice(0, 200) ?? ''}`);
    const pwd2 = spawnSync('docker', ['exec', cname, 'pwd'], { encoding: 'utf8' }).stdout.trim();
    check('the container was recreated at /workspace/<id> (drift honoured)', pwd2 === `/workspace/${proj.id}`, pwd2);

    // Docker-created mountpoints are root-owned; project scaffolding written by
    // Orchard itself (CLAUDE.md, docs/…) is owned by the user and is expected.
    const rootOwned = spawnSync('find', [LWORK, '-uid', '0'], { encoding: 'utf8' }).stdout.trim();
    check('the host repo has no root-owned (docker mountpoint) entries and no dir named after the project id',
      rootOwned === '' && !fs.existsSync(path.join(LWORK, proj.id)), rootOwned || fs.readdirSync(LWORK).join(','));
    check('the REAL ~/.claude/projects/-workspace is untouched', sameManifest(realWsBefore, manifest(path.join(REAL_PROJECTS, '-workspace'))), Object.keys(realWsBefore).length + ' files');
  } catch (err) {
    check('no exception in §3', false, String(err?.stack || err));
  } finally {
    if (cname) removeOwnedContainer(cname, await ownerKeyFor(LDATA)); // FEAT-158: only this run's server's container
    try { lsrv.kill('SIGKILL'); } catch {}
    // Only the random-id store dir this run created.
    if (storeDir && path.basename(storeDir).startsWith('-workspace-f155live-')) fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(LDATA, { recursive: true, force: true });
    fs.rmSync(LWORK, { recursive: true, force: true });
    if (extDir) fs.rmSync(extDir, { recursive: true, force: true });
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed${failures.length ? `\n  failed: ${failures.join('\n          ')}` : ''}`);
process.exit(fail === 0 ? 0 : 1);
