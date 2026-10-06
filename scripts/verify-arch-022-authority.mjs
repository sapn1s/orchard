#!/usr/bin/env node
/**
 * ARCH-022 — one container lifecycle authority. The proof suite.
 *
 *   npm run sandbox:docker -- up && eval "$(npm run -s sandbox:docker -- env)"
 *   node scripts/verify-arch-022-authority.mjs [--tree <dir with src/, scripts/lib, package.json>]
 *
 * ISOLATION (FEAT-158): destructive — runs only on the sandbox daemon, under its lock
 * (`assertIsolatedDocker`), in a scratch data dir and a per-run scratch image repo (docker shim).
 *
 * Sections
 *   S  static: no module but docker-exec.ts can reach docker; synthetic bypasses are each caught;
 *      the pinned pre-lane tree is caught (must-FAIL baseline, fixed, not HEAD).
 *   R  runtime gate: outside an operation, wrong project, finished operation, a live lease, a draining
 *      lease with a live tool process, an unknown probe, a newly written door — each refused alone.
 *   O  runtime ORACLE: the docker shim logs every call; every mutation that reached the daemon must
 *      carry a grant id the authority recorded. A mutation spawned any other way arrives without one.
 *   I  interleavings + BUG scenarios, run through an ADAPTER so the same scenario runs on the pre-lane
 *      tree (old API) for the must-FAIL: the property is "no session that is still live has its
 *      container (or its service sidecar) removed, recreated or stopped".
 *      I1 BUG-221 stop + a launch queued behind it      I2 remove + queued launch
 *      I3 BUG-222 rebuild during a launch                I4 delete + queued launch (no resurrection)
 *      I5 a session that closed while its tool still runs (draining)
 *      I6 BUG-220 a second process on the same data dir  I7 a crashed server's leftover tool process
 *      I8 a timed-out stop the daemon still carries out (fence)
 *      I9 BUG-219 the live instance is declared (user marker), not inferred  I10 BUG-220 a second SERVER (container leg)
 *      I13 another directory at the same path (another namespace)  I14 a copied data dir  I15 migration, live-like
 *      I16 decision B: an undeclared server on the account-default data dir adopts nothing (refuse + report, no recreate); I16b after declare
 *      I19 reboot: device-number change with the same filesystem UUID still claims; another filesystem id refuses loudly
 *      I17 a server on a COPY of the data dir (inherited lease files) force-stops: nothing in the original's container is touched
 *      I11 the data-dir claim is checked at every mutation
 * With --tree pointing at a pre-ARCH-022 tree, sections R/O run what they can and I runs on the old API.
 */
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { assertIsolatedDocker } from './lib/docker-sandbox.mjs';
import { scanTree } from './lib/arch-022-static.mjs';

assertIsolatedDocker('verify-arch-022-authority');

const REPO = path.resolve(import.meta.dirname, '..');
const REAL_HOME = os.homedir();
const CHILD_GRANTS = new Set();
/** Server processes this suite booted (I10): their grant log is in them; a grant id carries its pid. */
const SERVER_PIDS = new Set();
const ti = process.argv.indexOf('--tree');
const SRC_TREE = ti > 0 ? path.resolve(process.argv[ti + 1]) : REPO;
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? new Set(process.argv[i + 1].split(',')) : null; })();
const want = (sec) => !ONLY || ONLY.has(sec);

let pass = 0, fail = 0;
const results = [];
const check = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${String(obs).slice(0, 900)}`); ok ? pass++ : fail++; results.push({ n, ok }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arch022-'));
const TREE = path.join(TMP, 'tree');
const DATA = path.join(TMP, 'data');
const WORK = path.join(TMP, 'work');
for (const d of [TREE, DATA, WORK]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(WORK, 'hello.ts'), 'export const x = 1;\n');
fs.cpSync(path.join(SRC_TREE, 'src'), path.join(TREE, 'src'), { recursive: true });
fs.copyFileSync(path.join(SRC_TREE, 'package.json'), path.join(TREE, 'package.json'));
fs.cpSync(path.join(SRC_TREE, 'scripts', 'lib'), path.join(TREE, 'scripts', 'lib'), { recursive: true });
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(TREE, 'node_modules'));
const NEW = fs.existsSync(path.join(TREE, 'src', 'server', 'lifecycle.ts'));

const RUN_ID = `${process.pid}${Date.now() % 100000}`;
const SCRATCH_REPO = `claude-station-a22-${RUN_ID}`;
const SCRATCH_RT = `claude-station-a22rt-${RUN_ID}`; // FEAT-157: the CLI layer's repo, confined per run too
const SEED_DIR = path.join(TMP, 'seedctx');
fs.mkdirSync(SEED_DIR);
const dk = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const dkTry = (args) => { const r = spawnSync('docker', args, { encoding: 'utf8' }); return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }; };
function seedId() {
  const out = dk(['images', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}']);
  const line = out.split('\n').find((l) => /^claude-station-base:u\d+-g\d+-[0-9a-f]{12} /.test(l)) ?? out.split('\n').find((l) => l.startsWith('claude-station-base:'));
  if (!line) throw new Error('no claude-station-base image in the sandbox to seed from (npm run sandbox:docker -- up preloads one)');
  return line.trim().split(/\s+/)[1];
}
const SEED = seedId();
const SEED_REF = `a22seed-${RUN_ID}:seed`;
dk(['tag', SEED, SEED_REF]);
fs.writeFileSync(path.join(SEED_DIR, 'Dockerfile'), `FROM ${SEED_REF}\n`);
const SVC_IMAGE = 'redis:7-alpine';

/*
 * The shim: scratch repo rename both ways; a base build becomes a FROM-seed build with the real argv's
 * labels; per-verb delays; and a LOG of every call with the ORCHARD_DOCKER_GRANT its parent gave it.
 */
const SHIM = path.join(TMP, 'docker-shim');
const CALLS = path.join(TMP, 'calls.jsonl');
fs.writeFileSync(SHIM, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const REAL = 'claude-station-base', SCRATCH = ${JSON.stringify(SCRATCH_REPO)};
const REAL_RT = 'claude-station-rt', SCRATCH_RT = ${JSON.stringify(SCRATCH_RT)};
let argv = process.argv.slice(2).map((a) => a.split(REAL).join(SCRATCH).split(REAL_RT + ':').join(SCRATCH_RT + ':').replace(/^claude-station-rt$/, SCRATCH_RT));
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ argv: process.argv.slice(2), grant: process.env.ORCHARD_DOCKER_GRANT || null, at: Date.now() }) + '\\n');
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (argv[0] === 'build' && argv.some((a) => a.startsWith(SCRATCH + ':'))) {
  const keep = ['build'];
  for (let i = 1; i < argv.length; i++) if (argv[i] === '--label' || argv[i] === '-t') { keep.push(argv[i], argv[i + 1]); i++; }
  const nonce = Math.random().toString(36).slice(2);
  keep.push('--label', 'a22.build-nonce=' + nonce);
  fs.appendFileSync(${JSON.stringify(CALLS)}.replace('calls', 'builds'), JSON.stringify({ nonce, at: Date.now() }) + '\\n');
  keep.push(${JSON.stringify(SEED_DIR)});
  if (process.env.A22_BUILD_DELAY_MS) wait(Number(process.env.A22_BUILD_DELAY_MS));
  argv = keep;
}
const dly = process.env['A22_DELAY_' + (argv[0] || '').toUpperCase() + '_MS'];
if (dly) wait(Number(dly));
// Accept-then-hang: the real request is sent at once, then this client hangs (a daemon that keeps acting
// on a request whose client was killed by its timeout).
if (argv[0] === 'stop' && process.env.A22_STOP_ACCEPT_HANG_MS) {
  const d = spawn('docker', argv, { stdio: 'ignore', detached: true }); d.unref();
  wait(Number(process.env.A22_STOP_ACCEPT_HANG_MS));
  process.exit(0);
}
const child = spawn('docker', argv, { stdio: ['inherit', 'pipe', 'pipe'] });
const back = (s) => s.split(SCRATCH_RT).join(REAL_RT).split(SCRATCH).join(REAL);
child.stdout.on('data', (d) => process.stdout.write(argv[0] === 'cp' ? d : back(String(d)))); // FEAT-157: docker cp to stdout is a binary tar stream
child.stderr.on('data', (d) => process.stderr.write(back(String(d))));
process.stdout.on('error', () => process.exit(1));
child.on('close', (c) => process.stdout.write('', () => process.exit(c ?? 1)));
child.on('error', (e) => { process.stderr.write(String(e.message)); process.exit(127); });
`);
fs.chmodSync(SHIM, 0o755);
process.env.CLAUDE_STATION_DOCKER = SHIM;
process.env.CLAUDE_STATION_DATA = DATA;
process.env.ORCHARD_LIFECYCLE_FENCE_MS = '6000';
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude', '.credentials.json'), '{}\n');
process.env.HOME = HOME;
delete process.env.CLAUDE_CONFIG_DIR;

// FEAT-157: the BASE a project builds on (its pinned base); imageNameFor is what the container runs (base + CLI layer).
const baseOf = (m, proj) => (typeof m.baseRefFor === 'function' ? m.baseRefFor(proj) : m.imageNameFor(proj));
const scratchRef = (ref) => ref.replace('claude-station-base', SCRATCH_REPO).replace(/^claude-station-rt:/, `${SCRATCH_RT}:`);
const cid = (name) => dkTry(['inspect', name, '--format', '{{.Id}}']).out || null;
const running = (name) => dkTry(['inspect', name, '--format', '{{.State.Running}}']).out === 'true';
const imageOf = (name) => dkTry(['inspect', name, '--format', '{{.Image}}']).out || null;
/** When the build that made the image this container runs STARTED (the shim's nonce log); null if not a suite build. */
const buildStartOf = (name) => {
  const img = imageOf(name);
  if (!img) return null;
  const nonce = dkTry(['image', 'inspect', img, '--format', '{{index .Config.Labels "a22.build-nonce"}}']).out;
  const f = CALLS.replace('calls', 'builds');
  if (!nonce || !fs.existsSync(f)) return null;
  const hit = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((b) => b.nonce === nonce);
  return hit ? hit.at : null;
};

const REG = new Map();
let pseq = 0;
const newProject = (tag, extra = {}) => {
  const id = `a22-${tag}-${RUN_ID}-${++pseq}`.toLowerCase();
  const p = {
    id, name: `ARCH-022 ${id}`, hostPath: WORK, isolation: 'container',
    // FEAT-157: pinned to `dev` (the working-tree base) so the suite drives one base the shim can seed
    settings: { tools: { serena: false, playwright: false }, browser: { enabled: false }, mounts: [], container: { gpu: 'off', base: { pinned: 'dev', skipped: [], deferred: null } }, ...extra },
    createdAt: new Date().toISOString(),
  };
  REG.set(id, p);
  return p;
};
const withServices = () => ({ services: [{ name: 'redis', image: SVC_IMAGE, env: [] }] });

const imp = (rel) => import(path.join(TREE, rel));
const cm = await imp('src/server/container-manager.ts');
const svc = await imp('src/server/service-manager.ts');
const lc = NEW ? await imp('src/server/lifecycle.ts') : null;
const dx = NEW ? await imp('src/server/docker-exec.ts') : null;
const lanes = await imp('src/server/lanes.ts');

console.log(`ARCH-022 lifecycle authority\n  tree under test: ${SRC_TREE} (${NEW ? 'authority present' : 'PRE-AUTHORITY tree: old API through the adapter'})\n  scratch repo: ${SCRATCH_REPO}\n`);

/* --------------------------------------------------------------- adapter */
/*
 * One scenario vocabulary over both trees. OLD = exactly what the pre-lane product did at each door:
 * agent-bridge's launch (ensureServices -> ensureContainer({deferImageSwap: live?}) -> connect -> a
 * session registers some awaits later), and the container routes' calls (cm op, then teardownServices).
 */
const liveOld = new Map(); // projectId -> Set(tag)   (the old product's session map)
const liveCount = (pid) => liveOld.get(pid)?.size ?? 0;
const A = {
  async admit(p, tag) {
    if (NEW) {
      const st = await cm.admitContainer(p, tag, { current: () => REG.get(p.id) });
      lc.attachLease(tag, `sess-${tag}`);
      return st;
    }
    await svc.ensureServices(p, () => {});
    const st = await cm.ensureContainer(p, { deferImageSwap: () => liveCount(p.id) > 0 });
    svc.connectSessionToServices(p.id);
    await sleep(50); // the old launch's awaits between ensure and registration (fork planning, snapshot, constructor)
    if (!liveOld.has(p.id)) liveOld.set(p.id, new Set());
    liveOld.get(p.id).add(tag);
    return st;
  },
  close(p, tag) {
    if (NEW) lc.drainLease(tag);
    else liveOld.get(p.id)?.delete(tag);
  },
  async stop(p) {
    if (NEW) return cm.stopContainer(p, { current: () => REG.get(p.id) });
    const st = await cm.stopContainer(p, { liveNow: () => liveCount(p.id) > 0 });
    svc.teardownServices(p.id, { removeVolumes: false });
    return st;
  },
  async remove(p) {
    if (NEW) return cm.removeProjectContainer(p, { current: () => REG.get(p.id) });
    const st = await cm.removeProjectContainer(p, { liveNow: () => liveCount(p.id) > 0 });
    svc.teardownServices(p.id, { removeVolumes: false });
    return st;
  },
  async rebuild(p) {
    if (NEW) return cm.rebuildContainer(p, { current: () => REG.get(p.id) });
    const live = () => liveCount(p.id) > 0;
    return cm.rebuildContainer(p, { current: () => REG.get(p.id), liveNow: live });
  },
  async del(p) {
    if (NEW) return cm.deleteProjectResources(p, { container: true, current: () => REG.get(p.id), commit: () => REG.delete(p.id) });
    // the old DELETE route, in order
    await cm.removeProjectContainer(p, { liveNow: () => liveCount(p.id) > 0 });
    svc.teardownServices(p.id, { removeVolumes: true });
    await cm.removeProjectBuildState(p).catch(() => undefined);
    if (liveCount(p.id) > 0) { const e = new Error('gained live sessions'); e.code = 'live-sessions'; throw e; }
    REG.delete(p.id);
    return {};
  },
};
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e?.code ?? 'error', msg: String(e?.message ?? e).split('\n')[0] }));

let boot = null;
const createdNames = new Set();
const track = (p) => { createdNames.add(cm.containerName(p.id)); createdNames.add(`${cm.containerName(p.id)}.next`); };
function seedBase(p) { dk(['tag', SEED, scratchRef(baseOf(cm, p))]); }

try {
  /* ============================================================ S: static */
  if (want('S')) {
    console.log('--- S: static — only docker-exec.ts reaches docker');
    const cur = scanTree(SRC_TREE);
    check('S1 the tree under test: no module but docker-exec.ts spawns docker, picks its binary, or takes the mutation capability',
      cur.findings.length === 0, cur.findings.length ? cur.findings.slice(0, 6).join(' | ') : `0 findings over ${cur.files} files`);
    const PRE = path.join(REAL_HOME, '.local/state/claude-station/scratch/arch022/pre-tree');
    if (fs.existsSync(path.join(PRE, 'src'))) {
      const pre = scanTree(PRE);
      check('S2 MUST-FAIL baseline: the pinned pre-lane tree (three modules spawning docker) is caught', pre.findings.length > 0, `${pre.findings.length} findings, e.g. ${pre.findings[0] ?? '-'}`);
    } else check('S2 MUST-FAIL baseline: the pinned pre-lane tree exists', false, `missing ${PRE}`);
    const variants = {
      'aliased spawnSync': `import { spawnSync as s } from 'node:child_process';\nexport function f() { s('docker', ['rm', '-f', 'x']); }\n`,
      'namespace exec string': `import * as cp from 'child_process';\nexport function f() { cp.execSync('docker rm -f x'); }\n`,
      'require destructure with computed binary': `const { spawn: sp } = require('child_process');\nconst bin = 'dock' + 'er';\nexport function f() { sp(bin, ['rm']); }\n`,
      'shell wrapper': `import { spawn } from 'node:child_process';\nexport function f() { spawn('sh', ['-c', 'docker rm -f x']); }\n`,
      'spawner as a value': `import { spawn } from 'node:child_process';\nconst f2 = spawn;\nexport function f() { f2('ls'); }\n`,
      'the binary env var': `export const D = process.env.CLAUDE_STATION_DOCKER;\n`,
      'taking the capability': `import { sealAuthority } from './docker-exec.ts';\nexport const m = sealAuthority(() => ({ id: 'x', settled() {} }));\n`,
      'dynamic import of child_process': `export async function f() { const cp = await import('node:child_process'); cp.spawnSync('docker', ['rm']); }\n`,
      'template-literal binary': "import { execFileSync } from 'node:child_process';\nconst v = 'x';\nexport function f() { execFileSync(`${v}`, []); }\n",
    };
    for (const [label, code] of Object.entries(variants)) {
      const root = path.join(TMP, `bypass-${crypto.randomBytes(3).toString('hex')}`);
      fs.mkdirSync(path.join(root, 'src', 'server'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'server', 'rogue.ts'), code);
      const r = scanTree(root);
      check(`S3 a synthetic bypass is caught: ${label}`, r.findings.length > 0, r.findings[0] ?? 'NOT CAUGHT');
    }
    // S4 — ARCH-022 decision (b-i), attacker b round 3: a docker mutation in a module the SERVER imports from outside
    // src/ (scripts/lib) is caught; a literal read there is not; and a module nothing in src imports is not scanned.
    {
      const mk = (libCode, importIt = true) => {
        const root = path.join(TMP, `libpass-${crypto.randomBytes(3).toString('hex')}`);
        fs.mkdirSync(path.join(root, 'src', 'server'), { recursive: true });
        fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
        fs.writeFileSync(path.join(root, 'scripts', 'lib', 'helper.mjs'), libCode);
        fs.writeFileSync(path.join(root, 'src', 'server', 'user.ts'), importIt ? "import { h } from '../../scripts/lib/helper.mjs';\nexport const x = h;\n" : 'export const x = 1;\n');
        return scanTree(root);
      };
      const cases = {
        'node child running the sandbox CLI (the round-3 break)': ["import { spawn } from 'node:child_process';\nexport function h() { spawn(process.execPath, ['scripts/docker-sandbox.mjs', 'up']); }\n", true],
        'docker create in a server-imported lib': ["import { spawnSync } from 'node:child_process';\nexport function h() { spawnSync('docker', ['create', '--privileged', 'x']); }\n", true],
        'a generic runner with a computed binary': ["import { spawn } from 'node:child_process';\nexport function h(cmd) { spawn(cmd, ['up']); }\n", true],
      };
      for (const [label, [code]] of Object.entries(cases)) {
        const r = mk(code);
        check(`S4 a server-imported scripts/lib bypass is caught: ${label}`, r.findings.length > 0, r.findings[0] ?? 'NOT CAUGHT');
      }
      const read = mk("import { spawnSync } from 'node:child_process';\nexport function h() { return spawnSync('docker', ['info', '--format', '{{.ID}}']); }\n");
      const notImported = mk("import { spawnSync } from 'node:child_process';\nexport function h() { spawnSync('docker', ['rm', '-f', 'x']); }\n", false);
      check('S4b a literal docker READ in a server-imported lib passes, and a lib nothing in src imports is out of scope', read.findings.length === 0 && notImported.findings.length === 0,
        `read: ${read.findings[0] ?? 'clean'} | not-imported: ${notImported.findings[0] ?? 'clean'}`);
      // MUST-FAIL anchor: the real tree as it was before (b-i): its lane-docker.mjs ran `sandbox:docker up` from the server.
      const PREB = path.join(REAL_HOME, '.local/state/claude-station/scratch/arch022/pre/scripts_lib_lane-docker.mjs.pre-final');
      if (fs.existsSync(PREB)) {
        const root = path.join(TMP, 'pre-bi');
        fs.cpSync(path.join(SRC_TREE, 'src'), path.join(root, 'src'), { recursive: true });
        fs.cpSync(path.join(SRC_TREE, 'scripts', 'lib'), path.join(root, 'scripts', 'lib'), { recursive: true });
        fs.copyFileSync(PREB, path.join(root, 'scripts', 'lib', 'lane-docker.mjs'));
        const r = scanTree(root);
        check('S4c MUST-FAIL anchor: the tree with the pre-(b-i) lane-docker.mjs (ensureSandboxUp) is caught', r.findings.some((x) => x.startsWith('scripts/lib/lane-docker.mjs')), r.findings.find((x) => x.startsWith('scripts/lib/lane-docker.mjs')) ?? 'NOT CAUGHT');
      }
    }
  }

  /* ============================================================ R: runtime gate */
  if (NEW && want('R')) {
    console.log('\n--- R: runtime gate');
    const p0 = newProject('pre'); track(p0); seedBase(p0);
    const r0 = await settle(cm.ensureContainer(p0, { current: () => REG.get(p0.id) }));
    check('R0 before boot recovery, no operation runs', !r0.ok && r0.code === 'not-ready', JSON.stringify(r0));
    let r0b = null; try { dx.dockerSpawnSync(['rm', '-f', 'claude-station-nothing'], { timeoutMs: 10_000 }); } catch (e) { r0b = e; }
    check('R0b before boot, a raw mutation through docker-exec is refused', !!r0b, String(r0b?.message ?? 'ALLOWED').slice(0, 200));

    boot = await lc.bootForTests();
    const pA = newProject('a'); track(pA); seedBase(pA);
    const pB = newProject('b'); track(pB); seedBase(pB);
    await cm.ensureContainer(pA, { current: () => REG.get(pA.id) });
    await cm.ensureContainer(pB, { current: () => REG.get(pB.id) });
    const idA = cid(cm.containerName(pA.id));
    const idB = cid(cm.containerName(pB.id));
    check('R1a both fixture containers exist and run', !!idA && !!idB && running(cm.containerName(pA.id)) && running(cm.containerName(pB.id)), `${idA?.slice(0, 12)} ${idB?.slice(0, 12)}`);

    let e1 = null; try { dx.dockerSpawnSync(['rm', '-f', cm.containerName(pA.id)], { timeoutMs: 10_000 }); } catch (e) { e1 = e; }
    check('R1 outside an operation: docker rm is refused and the container is untouched', e1?.code === 'outside-authority' && cid(cm.containerName(pA.id)) === idA, `${e1?.code} ${String(e1?.message).slice(0, 120)}`);
    let e2 = null; try { dx.sealAuthority(() => ({ id: 'x', settled() {} })); } catch (e) { e2 = e; }
    check('R2 a second sealAuthority (a permissive decision function) is refused', !!e2, String(e2?.message ?? 'ALLOWED').slice(0, 160));
    const r3 = await settle(lc.runOp(pB.id, 'maintain', async () => dx.dockerSpawnSync(['rm', '-f', cm.containerName(pA.id)], { timeoutMs: 10_000 })));
    check('R3 project B\'s operation cannot remove project A\'s container', !r3.ok && r3.code === 'wrong-project' && cid(cm.containerName(pA.id)) === idA, JSON.stringify(r3));
    let late = null;
    await lc.runOp(pA.id, 'maintain', async () => {
      setTimeout(() => { try { dx.dockerSpawnSync(['stop', cm.containerName(pA.id)], { timeoutMs: 10_000 }); late = 'ALLOWED'; } catch (e) { late = e.code; } }, 300);
    });
    await sleep(800);
    check('R4 a mutation left behind by a FINISHED operation (a timer it scheduled) is refused', late === 'op-finished' && running(cm.containerName(pA.id)), String(late));

    const tag5 = lc.newExecTag('r5');
    await cm.admitContainer(pA, tag5, { current: () => REG.get(pA.id) });
    lc.attachLease(tag5, 'sess-r5');
    const s5 = await settle(cm.stopContainer(pA, { current: () => REG.get(pA.id) }));
    const rm5 = await settle(cm.removeProjectContainer(pA, { current: () => REG.get(pA.id) }));
    // a new base definition, so the forced Rebuild builds an image this instance owns (BUG-218: an isolated
    // instance never rebuilds over the unlabelled seeded base)
    { const M = path.join(TREE, 'src', 'server', 'container', 'provision.json'); const mj = JSON.parse(fs.readFileSync(M, 'utf8')); mj.__a22r5 = crypto.randomUUID(); fs.writeFileSync(M, JSON.stringify(mj, null, 2) + '\n'); }
    const rb5 = await settle(cm.rebuildContainer(pA, { current: () => REG.get(pA.id) }));
    const raw5 = await settle(lc.runOp(pA.id, 'maintain', async () => dx.dockerSpawnSync(['rm', '-f', cm.containerName(pA.id)], { timeoutMs: 10_000 })));
    check('R5 a held lease: Stop, Remove and a raw rm inside an operation are refused; Rebuild builds and DEFERS; the container is untouched',
      !s5.ok && s5.code === 'live-sessions' && !rm5.ok && rm5.code === 'live-sessions' && rb5.ok && rb5.v?.deferred === true && !raw5.ok && raw5.code === 'live-sessions'
        && cid(cm.containerName(pA.id)) === idA && running(cm.containerName(pA.id)),
      `stop=${s5.code ?? 'ok'} remove=${rm5.code ?? 'ok'} rebuild=${rb5.ok ? `deferred:${rb5.v?.deferred}` : rb5.code} raw=${raw5.code ?? 'ok'} id=${cid(cm.containerName(pA.id))?.slice(0, 12)}`);

    // R6 — a NEW door nobody enumerated: a route written today, calling the most destructive thing it can.
    const newRoute = (p) => lc.runOp(p.id, 'remove', async () => {
      const r = cm.removeContainerByName(cm.containerName(p.id));
      if (!r.removed) throw Object.assign(new Error(r.detail), { code: 'not-removed' });
      return r;
    });
    const r6 = await settle(newRoute(pA));
    check('R6 a newly written door (opens an operation, force-removes the container) is refused while a session holds it', !r6.ok && cid(cm.containerName(pA.id)) === idA, JSON.stringify(r6));

    // R7 — the session closes, but its tool is still running: protected until the process is gone.
    const toolExec = lc.withLease(tag5, () => dx.dockerSpawnSync(['exec', '-d', '--env', `CLAUDE_STATION_EXEC=${tag5}`, cm.containerName(pA.id), 'sleep', '300'], { timeoutMs: 20_000 }));
    lc.drainLease(tag5);
    await sleep(5000);
    const r7a = await settle(cm.removeProjectContainer(pA, { current: () => REG.get(pA.id) }));
    check('R7a a closed session whose tool process still runs (draining lease): Remove is refused', toolExec.status === 0 && !r7a.ok && r7a.code === 'live-sessions' && cid(cm.containerName(pA.id)) === idA, `exec=${toolExec.status} ${JSON.stringify(r7a)}`);
    cm.reapExec(pA, tag5, 'KILL');
    let released = false;
    for (let i = 0; i < 30 && !released; i++) { await sleep(1000); released = !lc.leasesOf(pA.id).length; }
    const r7b = await settle(cm.removeProjectContainer(pA, { current: () => REG.get(pA.id) }));
    check('R7b once the tool process is proven gone the lease releases, and Remove proceeds', released && r7b.ok && !cid(cm.containerName(pA.id)), `released=${released} ${JSON.stringify({ ok: r7b.ok, code: r7b.code })}`);

    // R8 — a probe that cannot complete (paused container): no lease, still refused unless forced.
    dk(['pause', cm.containerName(pB.id)]);
    const r8 = await settle(cm.removeProjectContainer(pB, { current: () => REG.get(pB.id) }));
    check('R8 a container whose processes cannot be read (paused): Remove refuses (unknown is not empty)', !r8.ok && r8.code === 'live-sessions' && cid(cm.containerName(pB.id)) === idB, JSON.stringify(r8));
    dk(['unpause', cm.containerName(pB.id)]);

    // R9 — an exec under a lease cannot target another project, or run without its tag
    const tag9 = lc.newExecTag('r9');
    await cm.admitContainer(pB, tag9, { current: () => REG.get(pB.id) });
    let e9a = null; try { lc.withLease(tag9, () => dx.dockerSpawnSync(['exec', '--env', `CLAUDE_STATION_EXEC=${tag9}`, cm.containerName(pA.id), 'true'], { timeoutMs: 10_000 })); } catch (e) { e9a = e.code; }
    let e9b = null; try { lc.withLease(tag9, () => dx.dockerSpawnSync(['stop', cm.containerName(pB.id)], { timeoutMs: 10_000 })); } catch (e) { e9b = e.code; }
    check('R9 a session\'s lease reaches only its own container, and only exec', e9a === 'lease-scope' && e9b === 'lease-scope', `${e9a} ${e9b}`);
    lc.drainLease(tag9);

    // R10 — inherited role labels: a project's own (prebuilt) image carrying another role's label (smoke / rtbuild /
    // builder) must not make its SESSION container removable without a lease.
    for (const [lbl, val] of [['claude-station.smoke', '1'], ['claude-station.rtbuild', '1'], ['orchard.basetag-lock', '1']]) {
      const ref = `a22role-${RUN_ID}:${lbl.replace(/[^a-z]/g, '')}`;
      const c = dk(['create', SEED, 'true']);
      try { dk(['commit', '--change', `LABEL ${lbl}=${val}`, c, ref]); } finally { dkTry(['rm', '-f', c]); }
      const pr = newProject('role', { container: { gpu: 'off', image: ref } }); track(pr);
      const t10 = lc.newExecTag('r10');
      const adm = await settle(cm.admitContainer(pr, t10, { current: () => REG.get(pr.id) }));
      const n10 = cm.containerName(pr.id);
      const id10 = cid(n10);
      const rm10 = await settle(cm.removeProjectContainer(pr, { current: () => REG.get(pr.id) }));
      const raw10 = await settle(lc.runOp(pr.id, 'maintain', async () => dx.dockerSpawnSync(['rm', '-f', n10], { timeoutMs: 10_000 })));
      check(`R10 a session container whose IMAGE carries ${lbl}=${val} is still a session: with its lease held, Remove and a raw rm are refused`,
        adm.ok && !!id10 && !rm10.ok && !raw10.ok && cid(n10) === id10, `admit=${adm.ok ? 'ok' : adm.code} remove=${rm10.code ?? 'REMOVED'} raw=${raw10.code ?? 'REMOVED'} id ${id10?.slice(0, 12)} -> ${cid(n10)?.slice(0, 12)}`);
      lc.drainLease(t10);
      for (let i = 0; i < 40 && lc.leasesOf(pr.id).length; i++) await sleep(250);
      dkTry(['rm', '-f', '-v', n10]);
      dkTry(['rmi', ref]);
    }

    // R11 — attacker (a) round 1: the probe must not fail OPEN on an image that lacks the tools it would parse with.
    for (const [label, rmCmd] of [['without sed', 'rm -f /bin/sed /usr/bin/sed /usr/local/bin/sed'], ['without cat', 'rm -f /bin/cat /usr/bin/cat /usr/local/bin/cat']]) {
      const ref = `a22tools-${RUN_ID}:${label.replace(/[^a-z]/g, '')}`;
      const c = dk(['create', '--user', '0:0', '--entrypoint', 'sh', SEED, '-c', `${rmCmd}; true`]);
      try { dk(['start', '-a', c]); dk(['commit', '--change', 'USER claude', '--change', 'ENTRYPOINT []', c, ref]); } finally { dkTry(['rm', '-f', c]); }
      const pr = newProject('tools', { container: { gpu: 'off', image: ref } }); track(pr);
      const t11 = lc.newExecTag('r11');
      const adm = await settle(cm.admitContainer(pr, t11, { current: () => REG.get(pr.id) }));
      const n11 = cm.containerName(pr.id);
      const tool = adm.ok ? dkTry(['exec', '-d', '--env', `CLAUDE_STATION_EXEC=${t11}`, n11, 'sleep', '300']) : { code: -1 };
      lc.drainLease(t11);
      await sleep(7000);
      const id11 = cid(n11);
      const rm11 = await settle(cm.removeProjectContainer(pr, { current: () => REG.get(pr.id) }));
      check(`R11 a session image ${label}: a closed session's still-running tool keeps protection (the probe does not fail open); Remove is refused`,
        adm.ok && tool.code === 0 && !!id11 && !rm11.ok && cid(n11) === id11, `admit=${adm.ok ? 'ok' : adm.code + ' ' + adm.msg} tool=${tool.code} remove=${rm11.code ?? 'REMOVED'} leases=${lc.leasesOf(pr.id).map((l) => l.id + ':' + l.state).join(',')}`);
      dkTry(['rm', '-f', '-v', n11]);
      dkTry(['rmi', ref]);
      for (let i = 0; i < 40 && lc.leasesOf(pr.id).length; i++) await sleep(500);
    }
  }

  /* ============================================================ I: interleavings / BUG scenarios */
  if (want('I')) {
    if (NEW && !boot) boot = await lc.bootForTests();
    console.log('\n--- I: interleavings and the BUG-219..222 scenarios (property: a live session\'s container and sidecar survive)');

    // I1 — BUG-221: Stop (its docker stop slowed) with a launch submitted while it runs.
    for (const [label, op] of [['I1 BUG-221: Stop', 'stop'], ['I2 Remove', 'remove']]) {
      const p = newProject(op, withServices()); track(p); seedBase(p);
      await A.admit(p, `${op}-warm`); A.close(p, `${op}-warm`);
      if (NEW) { for (let i = 0; i < 20 && lc.leasesOf(p.id).length; i++) await sleep(500); }
      process.env.A22_DELAY_STOP_MS = '2500';
      process.env.A22_DELAY_RM_MS = '2500';
      const destroy = settle(A[op](p));
      await sleep(300);
      const tag = `${op}-live-${RUN_ID}`;
      const launch = settle(A.admit(p, tag));
      const [d, l] = await Promise.all([destroy, launch]);
      delete process.env.A22_DELAY_STOP_MS; delete process.env.A22_DELAY_RM_MS;
      await sleep(1500);
      const name = cm.containerName(p.id);
      const sidecar = svc.serviceContainerName(p.id, 'redis');
      check(`${label} + a launch queued behind it: the launched session's container AND its service sidecar are up afterwards`,
        l.ok && running(name) && running(sidecar),
        `destroy=${d.ok ? 'ok' : d.code} launch=${l.ok ? 'ok' : `${l.code} ${l.msg}`} container=${running(name)} sidecar=${running(sidecar)}`);
      A.close(p, tag);
    }

    // I3 — BUG-222: Rebuild issued while a launch is mid-build.
    {
      const p = newProject('rebuild'); track(p);
      seedBase(p);
      await A.admit(p, 'rb-warm'); A.close(p, 'rb-warm');
      if (NEW) { for (let i = 0; i < 20 && lc.leasesOf(p.id).length; i++) await sleep(500); }
      const img0 = imageOf(cm.containerName(p.id));
      // a new base definition: the launch builds it (slowly), and a Rebuild arrives during that build
      const MANIFEST = path.join(TREE, 'src', 'server', 'container', 'provision.json');
      const mj = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); mj.__a22 = crypto.randomUUID(); fs.writeFileSync(MANIFEST, JSON.stringify(mj, null, 2) + '\n');
      process.env.A22_BUILD_DELAY_MS = '2500';
      const tag = `rb-live-${RUN_ID}`;
      const launch = settle(A.admit(p, tag));
      await sleep(400);
      const rbAt = Date.now();
      const rb = settle(A.rebuild(p));
      const [l, r] = await Promise.all([launch, rb]);
      delete process.env.A22_BUILD_DELAY_MS;
      const img1 = imageOf(cm.containerName(p.id));
      const built1 = buildStartOf(cm.containerName(p.id));
      // A Rebuild means NEW bytes: the image it applies must come from a build started after it was asked for.
      const rebuiltApplied = r.ok && !r.v?.deferred && built1 !== null && built1 >= rbAt;
      const deferredSaid = r.ok && r.v?.deferred === true;
      check('I3 BUG-222: a Rebuild during a launch either applies ITS OWN fresh build or SAYS it was deferred — never silently dropped',
        l.ok && (rebuiltApplied || deferredSaid),
        `launch=${l.ok ? 'ok' : l.code} rebuild=${r.ok ? `ok deferred=${r.v?.deferred}` : r.code} image ${img0?.slice(7, 19)} -> ${img1?.slice(7, 19)} built ${built1 ? built1 - rbAt : 'n/a'}ms after the request`);
      if (deferredSaid && NEW) {
        A.close(p, tag);
        for (let i = 0; i < 20 && lc.leasesOf(p.id).length; i++) await sleep(500);
        await A.admit(p, `rb-next-${RUN_ID}`);
        const img2 = imageOf(cm.containerName(p.id));
        const built2 = buildStartOf(cm.containerName(p.id));
        check('I3b the deferred rebuild applies at the next launch with no live session (the Rebuild\'s own build)', img2 && img2 !== img1 && built2 !== null && built2 >= rbAt, `${img1?.slice(7, 19)} -> ${img2?.slice(7, 19)} built ${built2 ? built2 - rbAt : 'n/a'}ms after the request`);
        A.close(p, `rb-next-${RUN_ID}`);
      } else A.close(p, tag);
    }

    // I4 — Delete with a launch queued behind it: the deleted project is never resurrected.
    {
      const p = newProject('del'); track(p); seedBase(p);
      await A.admit(p, 'del-warm'); A.close(p, 'del-warm');
      if (NEW) { for (let i = 0; i < 20 && lc.leasesOf(p.id).length; i++) await sleep(500); }
      process.env.A22_DELAY_RM_MS = '2000';
      const del = settle(A.del(p));
      await sleep(300);
      const launch = settle(A.admit(p, `del-live-${RUN_ID}`));
      const [d, l] = await Promise.all([del, launch]);
      delete process.env.A22_DELAY_RM_MS;
      await sleep(500);
      const name = cm.containerName(p.id);
      const resurrected = !REG.has(p.id) && !!cid(name);
      const deletedUnder = REG.has(p.id) === false && l.ok;
      check('I4 Delete + a launch queued behind it: no container is re-created for the deleted project, and no session runs on it',
        !resurrected && !deletedUnder,
        `delete=${d.ok ? 'ok' : d.code} launch=${l.ok ? 'ok' : l.code} registered=${REG.has(p.id)} container=${!!cid(name)}`);
    }

    // I5 — a session closed while its tool still runs (draining): Stop must not kill the tool.
    {
      const p = newProject('drain'); track(p); seedBase(p);
      const tag = `drain-${RUN_ID}`;
      await A.admit(p, tag);
      const name = cm.containerName(p.id);
      // the session's tool process, carrying the session's exec tag (as the CLI's children do)
      dk(['exec', '-d', '--env', `CLAUDE_STATION_EXEC=${tag}`, name, 'sleep', '300']);
      A.close(p, tag); // the session object is gone; its tool is still running
      await sleep(300);
      const s = await settle(A.stop(p));
      const toolAlive = dkTry(['exec', name, 'sh', '-c', `grep -lz CLAUDE_STATION_EXEC=${tag} /proc/[0-9]*/environ 2>/dev/null | head -1`]).out !== '';
      check('I5 a closed session\'s still-running tool keeps its container: Stop refuses until the tool is gone',
        running(name) && toolAlive && !s.ok, `stop=${s.ok ? 'ok (STOPPED)' : s.code} running=${running(name)} tool=${toolAlive}`);
      dkTry(['exec', name, 'sh', '-c', `for p in /proc/[0-9]*; do grep -qz CLAUDE_STATION_EXEC=${tag} $p/environ 2>/dev/null && kill -9 \${p#/proc/}; done; true`]);
    }

    // I8 — a docker stop whose client timed out while the daemon still carries it out: no launch is admitted
    // until the outcome is settled, so the late stop cannot land under a new session.
    if (NEW) {
      const p = newProject('fence'); track(p); seedBase(p);
      await A.admit(p, 'fence-warm'); A.close(p, 'fence-warm');
      for (let i = 0; i < 20 && lc.leasesOf(p.id).length; i++) await sleep(500);
      const name = cm.containerName(p.id);
      const id = cid(name);
      process.env.A22_STOP_ACCEPT_HANG_MS = '8000';
      const t = await settle(lc.runOp(p.id, 'maintain', async () => {
        const r = dx.dockerSpawnSync(['stop', '-t', '4', id], { timeoutMs: 1500 });
        return { status: r.status, signal: r.signal, err: r.error?.code };
      }));
      delete process.env.A22_STOP_ACCEPT_HANG_MS;
      const t0 = Date.now();
      const tag = `fence-live-${RUN_ID}`;
      const l = await settle(A.admit(p, tag));
      const waited = Date.now() - t0;
      await sleep(6000);
      check('I8 a timed-out stop the daemon still carries out: the next launch waits for it to settle, and its container is not stopped afterwards',
        t.ok && l.ok && running(name) && waited >= 2000,
        `timed-out stop=${JSON.stringify(t.v ?? t)} launch=${l.ok ? 'ok' : l.code} waited=${waited}ms running-after=${running(name)}`);
      A.close(p, tag);
    } else check('I8 a timed-out stop is fenced (pre-authority tree: no fence exists)', false, 'no lifecycle authority in this tree');


    // I9 — BUG-219 / ARCH-022: the live instance is DECLARED by the user's marker in its data dir (bound to the
    // directory's inode), never inferred from CLAUDE_STATION_DATA being unset, and never from an env var.
    const runIdentity = (dir, extraEnv = {}) => {
      const code = `
        const io = await import(${JSON.stringify(path.join(TREE, 'src/server/instance-owner.ts'))});
        const lc = ${NEW ? `await import(${JSON.stringify(path.join(TREE, 'src/server/lifecycle.ts'))})` : 'null'};
        if (lc) { try { await lc.bootForTests(); } catch (e) { console.log(JSON.stringify({ bootError: String((e.code || '') + ' ' + e.message).slice(0, 900) })); process.exit(0); } }
        const b = io.boundInstance ? io.boundInstance() : null;
        console.log(JSON.stringify({ id: b?.identity?.id ?? io.ownerKey(), legacyKey: b?.identity?.legacyKey ?? null, live: b?.liveDeclared ?? null, transitional: b?.transitional ?? null,
          mayActOnUnlabelled: io.mayActOn('unlabelled'), grants: lc ? lc.grants().map((g) => g.id) : [] }));`;
      const env = { ...process.env, ...extraEnv };
      if (!('CLAUDE_STATION_DATA' in extraEnv)) env.CLAUDE_STATION_DATA = dir;
      for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
      const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { encoding: 'utf8', env, timeout: 90_000 });
      const out = (r.stdout ?? '').trim().split('\n').pop();
      try { const j = JSON.parse(out); for (const g of j.grants ?? []) CHILD_GRANTS.add(g); return j; } catch { return { error: `${out} ${(r.stderr ?? '').slice(-300)}` }; }
    };
    const declare = (dir) => spawnSync(process.execPath, ['--no-warnings', path.join(SRC_TREE, 'scripts/orchard-live-instance.mjs'), 'declare', '--data-dir', dir], { encoding: 'utf8' });
    {
      const moved = path.join(TMP, 'xdg-moved', 'claude-station');
      fs.mkdirSync(moved, { recursive: true });
      const m = runIdentity(null, { XDG_DATA_HOME: path.join(TMP, 'xdg-moved'), ORCHARD_INSTANCE: 'live', CLAUDE_STATION_DATA: undefined });
      check('I9a BUG-219: a server whose data dir moved via XDG_DATA_HOME, undeclared (an ORCHARD_INSTANCE=live env var counts for nothing), is not the live instance: it adopts nothing unlabelled',
        m.mayActOnUnlabelled === false && m.live === false, JSON.stringify(m).slice(0, 300));
      const live = path.join(TMP, 'data-declared');
      fs.mkdirSync(live, { recursive: true });
      const dcl = declare(live);
      const d = runIdentity(live);
      check('I9b the data dir the USER declared live (scripts/orchard-live-instance.mjs declare) adopts pre-label objects, wherever its path',
        dcl.status === 0 && d.live === true && d.mayActOnUnlabelled === true, `${(dcl.stdout || dcl.stderr).split('\n')[0]} ${JSON.stringify(d).slice(0, 240)}`);
      // I14 — a COPY of the declared directory is another inode: another instance, not declared, owning nothing of the original's.
      const copy = path.join(TMP, 'data-declared-copy');
      spawnSync('cp', ['-a', live, copy]);
      const c = runIdentity(copy);
      const reid = spawnSync(process.execPath, ['--no-warnings', path.join(SRC_TREE, 'scripts/orchard-live-instance.mjs'), 'reidentify', '--data-dir', copy], { encoding: 'utf8' });
      const c2 = runIdentity(copy);
      check('I14 a COPY of a declared data dir never binds as the original and is never re-identified silently: boot refuses loudly naming rebind/reidentify; after the user\'s reidentify it is a separate instance (fresh id, not live, no legacy ownership)',
        !!d.id && !c.id && /rebind/.test(c.bootError ?? '') && /reidentify/.test(c.bootError ?? '') && reid.status === 0 && !!c2.id && c2.id !== d.id && c2.live === false && c2.mayActOnUnlabelled === false && c2.legacyKey === null,
        `original ${d.id} copy-boot=${String(c.bootError ?? JSON.stringify(c)).slice(0, 160)} after reidentify=${JSON.stringify(c2).slice(0, 160)}`);
      // I19 — decision "reboot": identity binds to inode + the filesystem's stable id (UUID), NOT the device number. A
      // device-number change (what a reboot can do to btrfs's anonymous st_dev) with the same filesystem UUID still
      // claims, as the same declared instance; a different filesystem id refuses LOUDLY with the repair command and
      // rewrites nothing; the user's rebind then claims as the same instance.
      {
        const Rb = path.join(TMP, 'data-reboot');
        fs.mkdirSync(Rb, { recursive: true });
        fs.writeFileSync(path.join(Rb, 'registry.json'), '{"version":1,"projects":[]}\n');
        const dcl2 = declare(Rb);
        const a0 = runIdentity(Rb);
        const IDF = path.join(Rb, 'orchard-instance.json'), MKF = path.join(Rb, 'orchard-live-instance.json');
        const edit = (file, fn) => { const j = JSON.parse(fs.readFileSync(file, 'utf8')); fn(j); fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n'); };
        edit(IDF, (j) => { j.dev = Number(j.dev) + 4242; }); edit(MKF, (j) => { j.dev = Number(j.dev) + 4242; });
        const a1 = runIdentity(Rb);
        edit(IDF, (j) => { if (typeof j.fs === 'string') j.fs = 'uuid:00000000-0000-0000-0000-000000000000'; else j.ino = Number(j.ino) + 1; });
        const before = fs.readFileSync(IDF);
        const a2 = runIdentity(Rb);
        const untouched = Buffer.compare(before, fs.readFileSync(IDF)) === 0 && fs.readdirSync(Rb).every((n) => !n.includes('set-aside'));
        const rb = spawnSync(process.execPath, ['--no-warnings', path.join(SRC_TREE, 'scripts/orchard-live-instance.mjs'), 'rebind', '--data-dir', Rb], { encoding: 'utf8' });
        const a3 = runIdentity(Rb);
        check('I19 reboot: a device-number change with the same filesystem UUID still claims as the same declared instance; a different filesystem id refuses LOUDLY (names rebind) and rewrites nothing; after rebind it claims as the same instance',
          dcl2.status === 0 && !!a0.id && a0.live === true && a1.id === a0.id && a1.live === true && a1.legacyKey === a0.legacyKey
            && !a2.id && /rebind/.test(a2.bootError ?? '') && untouched && rb.status === 0 && a3.id === a0.id && a3.live === true,
          `first=${a0.id}/live=${a0.live} dev-changed=${a1.id ?? a1.bootError ?? a1.error}/live=${a1.live} fs-changed=${String(a2.bootError ?? a2.id).slice(0, 140)} untouched=${untouched} rebind=${rb.status} after=${a3.id}/live=${a3.live}`);
      }
    }

    // I18 — attacker c3 (round 3): an identity file that EXISTS but cannot be read (permissions) is never replaced by a
    // fresh id (that would silently disown every object this instance made); binding fails loudly instead.
    {
      const U = path.join(TMP, 'data-unreadable-id');
      fs.mkdirSync(U, { recursive: true });
      fs.writeFileSync(path.join(U, 'registry.json'), '{"version":1,"projects":[]}\n');
      const first = runIdentity(U);
      fs.chmodSync(path.join(U, 'orchard-instance.json'), 0o000);
      const second = runIdentity(U);
      fs.chmodSync(path.join(U, 'orchard-instance.json'), 0o600);
      const third = runIdentity(U);
      const setAside = fs.readdirSync(U).filter((n) => n.includes('set-aside'));
      check('I18 attacker c3: an unreadable identity file is never replaced: binding fails loudly, and once readable again the SAME identity (and its legacy key) is back',
        !!first.id && !!(second.error || second.bootError) && !second.id && third.id === first.id && third.legacyKey === first.legacyKey && setAside.length === 0,
        `first=${first.id} unreadable=${String(second.bootError ?? second.error ?? JSON.stringify(second)).slice(0, 160)} after=${third.id} set-aside=${setAside.length}`);
    }

    // I13 — attacker (c) break 1 framing: ANOTHER directory at the SAME path, in another mount namespace (its own lock), on
    // the same daemon. It must own none of this server's objects: identity is declared in the directory, not derived
    // from its path.
    if (NEW) {
      const p = newProject('ns', withServices()); track(p); seedBase(p);
      const tag = `ns-${RUN_ID}`;
      await A.admit(p, tag);
      const name = cm.containerName(p.id);
      const id0 = cid(name);
      const sidecar = svc.serviceContainerName(p.id, 'redis');
      const net = `claude-station-net-${p.id}`;
      const code = `
        const lc = await import(${JSON.stringify(path.join(TREE, 'src/server/lifecycle.ts'))});
        const cm = await import(${JSON.stringify(path.join(TREE, 'src/server/container-manager.ts'))});
        const P = ${JSON.stringify(p)};
        const out = {};
        try { await lc.bootForTests(); out.boot = 'ok'; } catch (e) { out.boot = e.code || e.message; }
        try { await cm.removeProjectContainer(P, {}); out.remove = 'REMOVED'; } catch (e) { out.remove = e.code || e.message; }
        out.grants = lc.grants().map((g) => g.id);
        console.log(JSON.stringify(out)); process.exit(0);`;
      // bwrap: a fresh tmpfs over the data dir's PATH = another directory at the same path; its own lock, its own identity.
      const r = spawnSync('bwrap', ['--dev-bind', '/', '/', '--tmpfs', DATA, '--', process.execPath, '--no-warnings', '--input-type=module', '-e', code],
        { encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: DATA }, timeout: 120_000 });
      const out = (r.stdout ?? '').trim().split('\n').pop();
      let j = {}; try { j = JSON.parse(out); for (const g of j.grants ?? []) CHILD_GRANTS.add(g); } catch { /* */ }
      check('I13 attacker (c) break 1: a server on ANOTHER directory at the SAME path (another mount namespace, its own lock) cannot remove this server\'s session container, sidecar or network',
        j.boot === 'ok' && j.remove !== 'REMOVED' && cid(name) === id0 && running(name) && running(sidecar) && dkTry(['network', 'inspect', net]).code === 0,
        `other server: ${JSON.stringify({ boot: j.boot, remove: j.remove })} ${(r.stderr ?? '').slice(-160)} | container ${cid(name) === id0 ? 'kept' : 'GONE'} sidecar=${running(sidecar)}`);
      A.close(p, tag);
    }

    // I15 — MIGRATION, live-like: the user's REAL registry (a copy), its container projects' containers and a service
    // network/volume planted with the OLD path-derived owner key, plus one unlabelled legacy container. The first boot
    // of the new code on that data dir (declared live by the user) recreates, removes and rewrites nothing.
    if (NEW) {
      const L = path.join(TMP, 'data-legacy');
      fs.mkdirSync(L, { recursive: true });
      const REAL_REG = path.join(REAL_HOME, '.local', 'share', 'claude-station', 'registry.json');
      fs.copyFileSync(REAL_REG, path.join(L, 'registry.json'));
      const regBytes = fs.readFileSync(path.join(L, 'registry.json'));
      const reg = JSON.parse(regBytes.toString());
      const cprojects = (Array.isArray(reg) ? reg : reg.projects).filter((p) => p.isolation === 'container').slice(0, 6);
      const io = await imp('src/server/instance-owner.ts');
      const oldKey = io.pathKey(L);
      const planted = [];
      for (const rp of cprojects) {
        const pid = `${rp.id}-a22mig-${RUN_ID}`.toLowerCase().slice(0, 60);
        const n = `claude-station-${pid}`;
        dk(['run', '-d', '--name', n, '--label', 'claude-station=1', '--label', `claude-station.project=${pid}`, '--label', 'claude-station.role=session',
          '--label', `claude-station.owner=${oldKey}`, 'busybox:latest', 'sleep', '3600']);
        createdNames.add(n);
        planted.push({ pid, n, id: cid(n) });
      }
      const legacyName = `claude-station-a22legacy-${RUN_ID}`;
      dk(['run', '-d', '--name', legacyName, '--label', 'claude-station=1', '--label', `claude-station.project=a22legacy-${RUN_ID}`, 'busybox:latest', 'sleep', '3600']);
      createdNames.add(legacyName);
      const legacyId = cid(legacyName);
      const netName = `claude-station-net-a22mig-${RUN_ID}`;
      dk(['network', 'create', '--label', 'claude-station=1', '--label', `claude-station.project=a22mig-${RUN_ID}`, '--label', 'claude-station.role=network', '--label', `claude-station.owner=${oldKey}`, netName]);
      const declared = declare(L);
      const code = `
        const lc = await import(${JSON.stringify(path.join(TREE, 'src/server/lifecycle.ts'))});
        const io = await import(${JSON.stringify(path.join(TREE, 'src/server/instance-owner.ts'))});
        await lc.bootForTests();
        const b = io.boundInstance();
        console.log(JSON.stringify({ id: b.identity.id, legacyKey: b.identity.legacyKey, live: b.liveDeclared, ownOld: io.ownershipOf(${JSON.stringify(oldKey)}), mayAdoptUnlabelled: io.mayActOn('unlabelled'), grants: lc.grants().map((g) => g.id) }));
        process.exit(0);`;
      const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: L }, timeout: 120_000 });
      let j = {}; try { j = JSON.parse((r.stdout ?? '').trim().split('\n').pop()); for (const g of j.grants ?? []) CHILD_GRANTS.add(g); } catch { j = { error: (r.stderr ?? '').slice(-300) }; }
      const survived = planted.every((x) => cid(x.n) === x.id && running(x.n)) && cid(legacyName) === legacyId && dkTry(['network', 'inspect', netName]).code === 0;
      const regSame = Buffer.compare(fs.readFileSync(path.join(L, 'registry.json')), regBytes) === 0;
      check(`I15 migration (live-like: a copy of the real registry with ${cprojects.length} container project(s), their containers + a network under the OLD key, an unlabelled legacy container): the first boot keeps owning them (legacy key ${oldKey}), adopts the unlabelled one, and touches nothing`,
        declared.status === 0 && cprojects.length > 0 && j.legacyKey === oldKey && j.ownOld === 'own' && j.mayAdoptUnlabelled === true && j.live === true && survived && regSame,
        `${JSON.stringify({ ...j, grants: undefined })} survived=${survived} registry-unchanged=${regSame}`);
      // …and the old key buys nothing for a directory that is not this one (I13's other directory, a copy) — see I13/I14.
      dkTry(['network', 'rm', netName]);
    }

    // I16 — DECISION B (2026-10-02): nothing is inferred from the path. An UNDECLARED server, even on this account's
    // DEFAULT data dir (with state: an existing install), adopts NO pre-identity (old path-keyed) and NO unlabelled
    // object: a launch and a remove on them are REFUSED with a report naming the declare command, and nothing is
    // recreated. Attacker c2 break 1 framing: the undeclared default-path server is another directory at that path
    // (a mount namespace), and the live server's leased unlabelled session container must survive it. Exercised with a
    // scratch directory bind-mounted AT the default path (the real data dir is never touched). I16b: the same
    // directory once the user declares it owns those objects again.
    if (NEW) {
      const DEF = path.join(REAL_HOME, '.local', 'share', 'claude-station');
      const S = path.join(TMP, 'data-default-stand-in');
      fs.mkdirSync(S, { recursive: true });
      fs.writeFileSync(path.join(S, 'registry.json'), '{"version":1,"projects":[]}\n'); // an existing install: it has state
      const io = await imp('src/server/instance-owner.ts');
      const oldKey = io.pathKey(DEF); // what a pre-identity server on the default path stamped
      const pOld = newProject('legacykeyed'); const pUnl = newProject('unlabelled');
      track(pOld); track(pUnl);
      const plant = (p, owner) => {
        const n = cm.containerName(p.id);
        dk(['run', '-d', '--name', n, '--label', 'claude-station=1', '--label', `claude-station.project=${p.id}`, '--label', 'claude-station.role=session',
          ...(owner ? ['--label', `claude-station.owner=${owner}`] : []), 'busybox:latest', 'sleep', '3600']);
        return { n, id: cid(n) };
      };
      const cOld = plant(pOld, oldKey), cUnl = plant(pUnl, null);
      // the LIVE server's lease on the unlabelled session container (c2's variant: attached, no tagged process yet)
      const liveTag = `i16-live-${RUN_ID}`;
      const leased = await settle(lc.runOp(pUnl.id, 'admit', async (op) => { lc.grantLease(op, liveTag); }));
      const runAtDefault = (body) => {
        const code = `
          const lc = await import(${JSON.stringify(path.join(TREE, 'src/server/lifecycle.ts'))});
          const io = await import(${JSON.stringify(path.join(TREE, 'src/server/instance-owner.ts'))});
          const cm = await import(${JSON.stringify(path.join(TREE, 'src/server/container-manager.ts'))});
          await lc.bootForTests();
          const b = io.boundInstance();
          const out = { dir: b.dir, live: b.liveDeclared, legacyKey: b.identity.legacyKey, ownOld: io.ownershipOf(${JSON.stringify(oldKey)}), adopt: io.mayActOn('unlabelled') };
          ${body}
          out.grants = lc.grants().map((g) => g.id);
          console.log(JSON.stringify(out)); process.exit(0);`;
        const env = { ...process.env, HOME: REAL_HOME };
        delete env.CLAUDE_STATION_DATA; delete env.XDG_DATA_HOME;
        const r = spawnSync('bwrap', ['--dev-bind', '/', '/', '--bind', S, DEF, '--', process.execPath, '--no-warnings', '--input-type=module', '-e', code], { encoding: 'utf8', env, timeout: 180_000 });
        try { const j = JSON.parse((r.stdout ?? '').trim().split('\n').pop()); for (const g of j.grants ?? []) CHILD_GRANTS.add(g); return j; } catch { return { error: (r.stderr ?? '').slice(-400) }; }
      };
      const tryAll = `
          const P1 = ${JSON.stringify(pOld)}, P2 = ${JSON.stringify(pUnl)};
          const t = async (f) => { try { await f(); return 'DONE'; } catch (e) { return { code: e.code || 'error', msg: String(e.message || e).slice(0, 400) }; } };
          out.ensureOld = await t(() => cm.ensureContainer(P1, {}));
          out.removeOld = await t(() => cm.removeProjectContainer(P1, {}));
          out.ensureUnl = await t(() => cm.ensureContainer(P2, {}));
          out.removeUnl = await t(() => cm.removeProjectContainer(P2, {}));`;
      const j = runAtDefault(tryAll);
      const kept = cid(cOld.n) === cOld.id && running(cOld.n) && cid(cUnl.n) === cUnl.id && running(cUnl.n);
      const label = (pid) => dk(['ps', '-aq', '--filter', `label=claude-station.project=${pid}`]).split('\n').filter(Boolean).length;
      const noRecreate = label(pOld.id) === 1 && label(pUnl.id) === 1 && cid(`${cOld.n}.next`) === null && cid(`${cUnl.n}.next`) === null;
      const refused = ['ensureOld', 'removeOld', 'ensureUnl', 'removeUnl'].every((k) => j[k] && j[k] !== 'DONE' && j[k].code === 'foreign-owner');
      const reported = ['ensureOld', 'ensureUnl'].every((k) => /orchard-live-instance\.mjs declare/.test(j[k]?.msg ?? ''));
      check('I16 decision B: an UNDECLARED server on this account\'s DEFAULT data dir (an existing install) adopts nothing by path: launch and remove of its pre-identity (old-key) and unlabelled containers are REFUSED (foreign-owner) with a report naming the declare command; nothing is removed or recreated, and the live server\'s leased unlabelled container survives (attacker c2 break 1)',
        leased.ok && j.live === false && !!j.legacyKey && j.ownOld === 'foreign' && j.adopt === false && refused && reported && kept && noRecreate,
        `${JSON.stringify({ ...j, grants: undefined, ensureOld: j.ensureOld?.code ?? j.ensureOld, removeOld: j.removeOld?.code ?? j.removeOld, ensureUnl: j.ensureUnl?.code ?? j.ensureUnl, removeUnl: j.removeUnl?.code ?? j.removeUnl }).slice(0, 400)} kept=${kept} no-recreate=${noRecreate} reported=${reported} msg="${String(j.ensureOld?.msg ?? '').slice(0, 160)}"`);
      // I16b — after the user's declaration (the two-step deploy: declare, then restart), the same directory owns them.
      const dcl = declare(S);
      const k = runAtDefault('');
      check('I16b the same default data dir once the user DECLARES it: owns its pre-identity objects (legacy key) and adopts unlabelled ones; first boot touches nothing',
        dcl.status === 0 && k.live === true && k.legacyKey === j.legacyKey && k.ownOld === 'own' && k.adopt === true && cid(cOld.n) === cOld.id && cid(cUnl.n) === cUnl.id,
        JSON.stringify({ ...k, grants: undefined }).slice(0, 300));
      if (leased.ok) await settle(lc.runOp(pUnl.id, 'close', async () => lc.drainLease?.(liveTag)));
    }

    // I17 — attacker c3 (round 3): a COPY of this server's data dir inherits its lease files. A server on the copy (another
    // identity) that force-stops the project — exactly the route's capture, leasesOf(id) — must not reap, probe or exec
    // anything inside THIS server's container: the live session's tool process survives and the stop is refused.
    if (NEW) {
      const p = newProject('copyreap'); track(p); seedBase(p);
      const tag = lc.newExecTag('i17live');
      const adm = await settle(A.admit(p, tag));
      const name = cm.containerName(p.id);
      dk(['exec', '-d', '--env', `CLAUDE_STATION_EXEC=${tag}`, name, 'sleep', '300']);
      await sleep(800);
      const toolAlive = () => dkTry(['exec', name, 'sh', '-c', `grep -lz CLAUDE_STATION_EXEC=${tag} /proc/[0-9]*/environ 2>/dev/null | head -1`]).out !== '';
      const before = toolAlive();
      const COPY = path.join(TMP, 'data-copy-i17');
      execFileSync('cp', ['-a', DATA, COPY]);
      const inherited = (() => { try { return fs.readdirSync(path.join(COPY, 'lifecycle', 'leases')).length; } catch { return 0; } })();
      // since decision "reboot" a copy refuses to bind until the user says what it is; as a separate instance
      // (reidentify) it still carries the inherited lease files — the case attacker c3 used.
      const reidI17 = spawnSync(process.execPath, ['--no-warnings', path.join(SRC_TREE, 'scripts/orchard-live-instance.mjs'), 'reidentify', '--data-dir', COPY], { encoding: 'utf8' });
      const code = `
        const lc = await import(${JSON.stringify(path.join(TREE, 'src/server/lifecycle.ts'))});
        const cm = await import(${JSON.stringify(path.join(TREE, 'src/server/container-manager.ts'))});
        const P = ${JSON.stringify(p)};
        const o = {};
        try { await lc.bootForTests(); o.boot = 'ok'; } catch (e) { o.boot = e.code || e.message; }
        const forceOver = lc.leasesOf(P.id).map((l) => l.id);
        o.captured = forceOver.length;
        const t0 = Date.now();
        try { await cm.stopContainer(P, { forceOver }); o.stop = 'STOPPED'; } catch (e) { o.stop = e.code || String(e.message).slice(0, 120); }
        o.ms = Date.now() - t0;
        o.grants = lc.grants().map((g) => g.id);
        o.execGrants = lc.grants().filter((g) => g.verb === 'exec' || /^reap|^probe/.test(g.verb)).map((g) => g.verb);
        console.log('__R__' + JSON.stringify(o)); process.exit(0);`;
      const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: COPY }, timeout: 120_000 });
      const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('__R__'));
      let j = {}; try { j = JSON.parse(line.slice(5)); for (const g of j.grants ?? []) CHILD_GRANTS.add(g); } catch { j = { error: (r.stderr ?? '').slice(-300), status: r.status, signal: r.signal }; }
      await sleep(1500);
      const after = toolAlive();
      check('I17 attacker c3: a server on a COPY of this data dir (reidentified as a separate instance; it inherits the lease files) force-stops the project: nothing in THIS server\'s container is reaped or probed (the live tool survives) and the stop is refused',
        adm.ok && before && inherited > 0 && (reidI17.status === 0 || !fs.existsSync(path.join(SRC_TREE, 'scripts/orchard-live-instance.mjs'))) && j.boot === 'ok' && j.stop !== 'STOPPED' && after && running(name) && (j.execGrants ?? []).length === 0,
        `inherited lease files=${inherited} copy-server=${JSON.stringify({ ...j, grants: undefined })} tool before=${before} after=${after} running=${running(name)}`);
      A.close(p, tag);
    }

    // I10 — BUG-220 at the SERVER level, with a container project: a second server on the same data dir refuses to
    // start, and the first server's container keeps its id.
    {
      const { isolatedServerEnv } = await import('./lib/station-boot.mjs');
      const DATA3 = path.join(TMP, 'data-i10');
      fs.mkdirSync(DATA3, { recursive: true });
      const freePort = () => new Promise((res) => { import('node:net').then((net) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); });
      const boot = async (port) => {
        // a whole server needs the whole tree (scripts/, public/), so it boots from the tree under test itself
        const child = spawn(process.execPath, [path.join(SRC_TREE, 'src/server/index.ts')], {
          cwd: SRC_TREE, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...isolatedServerEnv({ PORT: String(port), CLAUDE_STATION_DATA: DATA3 }), CLAUDE_STATION_DATA_LOCK_WAIT_MS: '1500', CLAUDE_STATION_DOCKER: SHIM },
        });
        SERVER_PIDS.add(child.pid);
        let err = ''; child.stderr.on('data', (x) => { err = (err + x).slice(-3000); }); child.stdout.on('data', (x) => { err = (err + x).slice(-3000); });
        return { child, port, err: () => err };
      };
      const p1 = await freePort();
      const s1 = await boot(p1);
      let up = false;
      for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${p1}/api/health`)).ok; } catch { await sleep(250); } }
      let cname = null, id1 = null, exit2 = null, out2 = '';
      if (!up) console.log(`        (first server never healthy: ${s1.err().slice(-1500)})`);
      try {
        const wdir = path.join(TMP, 'work-i10'); fs.mkdirSync(wdir, { recursive: true });
        const cr = await fetch(`http://127.0.0.1:${p1}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: wdir, name: `a22 i10 ${RUN_ID}`, isolation: 'container', settings: { container: { image: 'busybox:latest', gpu: 'off' } } }) });
        const pj = (await cr.json()).project;
        const st = await fetch(`http://127.0.0.1:${p1}/api/projects/${pj.id}/container/start`, { method: 'POST' });
        cname = `claude-station-${pj.id}`;
        createdNames.add(cname);
        id1 = cid(cname);
        const s2 = await boot(await freePort());
        exit2 = await new Promise((r) => { s2.child.on('exit', (c) => r(c)); setTimeout(() => r('still running'), 30_000); });
        out2 = s2.err();
        if (exit2 === 'still running') { try { process.kill(-s2.child.pid, 'SIGKILL'); } catch { /* */ } }
        check('I10 BUG-220: a second SERVER on the same data dir refuses to start (exit 78), and the first server\'s container keeps its id and runs',
          up && st.status === 200 && !!id1 && exit2 === 78 && cid(cname) === id1 && running(cname), `start=${st.status} second exit=${exit2} ${/REFUSING TO START/.test(out2) ? '(REFUSING TO START)' : out2.slice(-200)} container ${id1?.slice(0, 12)} -> ${cid(cname)?.slice(0, 12)}`);
      } finally {
        try { process.kill(-s1.child.pid, 'SIGTERM'); } catch { /* */ }
        await sleep(1500);
        try { process.kill(-s1.child.pid, 'SIGKILL'); } catch { /* */ }
      }
    }

    // I11 — the claim is a lifetime capability: once this server's data dir is moved away under it, no mutation runs.
    {
      const DATA4 = path.join(TMP, 'data-i11');
      fs.mkdirSync(DATA4, { recursive: true });
      const p = newProject('claim'); track(p); seedBase(p);
      const code = `
        const lc = ${NEW ? `await import(${JSON.stringify(path.join(TREE, 'src/server/lifecycle.ts'))})` : 'null'};
        if (lc) await lc.bootForTests();
        const cm = await import(${JSON.stringify(path.join(TREE, 'src/server/container-manager.ts'))});
        const P = ${JSON.stringify(p)};
        const fs = await import('node:fs');
        const out = {};
        await (lc ? cm.ensureContainer(P, {}) : cm.ensureContainer(P, {}));
        fs.renameSync(${JSON.stringify(DATA4)}, ${JSON.stringify(DATA4 + '-moved')});
        try { await cm.removeProjectContainer(P, {}); out.remove = 'REMOVED'; } catch (e) { out.remove = e.code || e.message; }
        if (lc) out.grants = lc.grants().map((g) => g.id);
        console.log(JSON.stringify(out)); process.exit(0);`;
      const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: DATA4 }, timeout: 120_000 });
      const out = (r.stdout ?? '').trim().split('\n').pop();
      let j = {}; try { j = JSON.parse(out); for (const g of j.grants ?? []) CHILD_GRANTS.add(g); } catch { /* */ }
      const name = cm.containerName(p.id);
      check('I11 a server whose data dir was moved out from under it can no longer remove a container (the claim is checked at every mutation)',
        !!cid(name) && j.remove !== 'REMOVED', `remove=${j.remove ?? out} ${(r.stderr ?? '').slice(-200)} container=${!!cid(name)}`);
    }

    // I6 — BUG-220: a second process on the same data dir tries to remove this server's container.
    {
      const p = newProject('two'); track(p); seedBase(p);
      const tag = `two-${RUN_ID}`;
      await A.admit(p, tag);
      const name = cm.containerName(p.id);
      const id = cid(name);
      const code = `
        const P = ${JSON.stringify(p)};
        let out = {};
        let lc = null;
        try {
          ${NEW ? `lc = await import(${JSON.stringify(path.join(TREE, 'src/server/lifecycle.ts'))}); try { await lc.bootForTests(); out.boot = 'ok'; } catch (e) { out.boot = e.code || e.message; }` : ''}
          const cm = await import(${JSON.stringify(path.join(TREE, 'src/server/container-manager.ts'))});
          try { await cm.removeProjectContainer(P, {}); out.remove = 'REMOVED'; } catch (e) { out.remove = e.code || e.message; }
        } catch (e) { out.err = String(e.message); }
        ${NEW ? `try { out.grants = lc.grants().map((g) => g.id); } catch {}` : ''}
        console.log(JSON.stringify(out)); process.exit(0);`;
      if (NEW) process.env.CLAUDE_STATION_DATA_LOCK_WAIT_MS = '1000';
      const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env }, timeout: 60_000 });
      const out = (r.stdout ?? '').trim().split('\n').pop();
      try { for (const g of JSON.parse(out).grants ?? []) CHILD_GRANTS.add(g); } catch { /* reported below */ }
      check('I6 BUG-220: a second process on the same data dir cannot remove this server\'s live container',
        cid(name) === id && running(name), `second process: ${out} ${(r.stderr ?? '').slice(-200)} | container ${cid(name) === id ? 'kept' : 'GONE/REPLACED'}`);
      A.close(p, tag);
    }

    // I12 — attacker (a) round 1: a TORN lease file still protects its project after a restart (its name says which).
    if (NEW) {
      const DATA5 = path.join(TMP, 'data-i12');
      fs.mkdirSync(path.join(DATA5, 'lifecycle', 'leases'), { recursive: true });
      const p = newProject('torn'); track(p); seedBase(p);
      const code = `
        const lc = await import(${JSON.stringify(path.join(TREE, 'src/server/lifecycle.ts'))});
        const cm = await import(${JSON.stringify(path.join(TREE, 'src/server/container-manager.ts'))});
        const fs = await import('node:fs');
        const P = ${JSON.stringify(p)};
        await lc.bootForTests();
        await cm.ensureContainer(P, {});
        // the "crash": a lease file torn mid-write, named by its project, then a restart (a fresh process below)
        fs.writeFileSync(${JSON.stringify(path.join(DATA5, 'lifecycle', 'leases'))} + '/' + P.id + '--torn-tag-1.json', '{"id":"torn-tag-1","proj');
        console.log(JSON.stringify({ grants: lc.grants().map((g) => g.id) })); process.exit(0);`;
      const r1 = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: DATA5 }, timeout: 120_000 });
      try { for (const g of JSON.parse((r1.stdout ?? '').trim().split('\n').pop()).grants ?? []) CHILD_GRANTS.add(g); } catch { /* */ }
      const code2 = `
        const lc = await import(${JSON.stringify(path.join(TREE, 'src/server/lifecycle.ts'))});
        const cm = await import(${JSON.stringify(path.join(TREE, 'src/server/container-manager.ts'))});
        const P = ${JSON.stringify(p)};
        await lc.bootForTests();
        const out = { leases: lc.leasesOf(P.id).map((l) => l.id) };
        try { await cm.removeProjectContainer(P, {}); out.remove = 'REMOVED'; } catch (e) { out.remove = e.code || e.message; }
        out.grants = lc.grants().map((g) => g.id);
        console.log(JSON.stringify(out)); process.exit(0);`;
      const r2 = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code2], { encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: DATA5 }, timeout: 120_000 });
      let j = {}; try { j = JSON.parse((r2.stdout ?? '').trim().split('\n').pop()); for (const g of j.grants ?? []) CHILD_GRANTS.add(g); } catch { /* */ }
      const name = cm.containerName(p.id);
      check('I12 a lease file torn by a crash still protects its project after the restart: the first destroy is refused, the container kept',
        !!cid(name) && j.remove === 'live-sessions' && (j.leases ?? []).some((l) => l.startsWith('quarantine-file-')), `${JSON.stringify(j).slice(0, 300)} ${(r2.stderr ?? '').slice(-200)} container=${!!cid(name)}`);
    }

    // I7 — a crashed server's leftover: a tool process still running, no session object anywhere.
    {
      const p = newProject('crash'); track(p); seedBase(p);
      const tag = `crash-${RUN_ID}`;
      await A.admit(p, tag);
      const name = cm.containerName(p.id);
      const id = cid(name);
      dk(['exec', '-d', '--env', `CLAUDE_STATION_EXEC=${tag}`, name, 'sleep', '300']);
      // the "crash": this process lets the data dir go without closing anything
      if (NEW) { boot?.dispose(); lanes.releaseWriter(); }
      const code = `
        const P = ${JSON.stringify(p)};
        let out = {};
        ${NEW ? `const lc = await import(${JSON.stringify(path.join(TREE, 'src/server/lifecycle.ts'))}); try { await lc.bootForTests(); out.boot = 'ok'; } catch (e) { out.boot = e.code || e.message; }` : ''}
        const cm = await import(${JSON.stringify(path.join(TREE, 'src/server/container-manager.ts'))});
        try { await cm.removeProjectContainer(P, {}); out.remove = 'REMOVED'; } catch (e) { out.remove = e.code || e.message; }
        ${NEW ? `try { out.grants = lc.grants().map((g) => g.id); } catch {}` : ''}
        console.log(JSON.stringify(out)); process.exit(0);`;
      const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env }, timeout: 90_000 });
      const out = (r.stdout ?? '').trim().split('\n').pop();
      try { for (const g of JSON.parse(out).grants ?? []) CHILD_GRANTS.add(g); } catch { /* reported below */ }
      check('I7 a restarted server finds a crashed server\'s still-running tool process and will not remove its container',
        cid(name) === id && running(name), `restarted process: ${out} | container ${cid(name) === id ? 'kept' : 'GONE'}`);
    }
  }

  /* ============================================================ O: runtime oracle */
  if (want('O')) {
    console.log('\n--- O: runtime oracle — every mutation that reached the daemon was granted');
    const calls = fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const isRead = NEW ? dx.isReadArgv : (a) => /^(inspect|ps|images|logs|info|version|diff|events|top|port|history|save)$/.test(a[0]) || (['container', 'image', 'network', 'volume', 'buildx', 'system', 'context'].includes(a[0]) && ['inspect', 'ls', 'list', 'logs', 'diff', 'top', 'port', 'history', 'save', 'version', 'du', 'df', 'show', 'info'].includes(a[1]));
    const muts = calls.filter((c) => !isRead(c.argv));
    const granted = NEW ? new Set([...lc.grants().map((g) => g.id), ...CHILD_GRANTS]) : new Set();
    // a booted server's grants are recorded in that server; its grant ids name its pid (only docker-exec sets them)
    const serverGrant = (g) => { const m = /^g(\d+)-[0-9a-z]+$/.exec(g ?? ''); return !!m && SERVER_PIDS.has(Number(m[1])); };
    const ungranted = muts.filter((c) => !c.grant || !(granted.has(c.grant) || serverGrant(c.grant)));
    check('O1 every docker mutation the product issued carried a grant the authority recorded (none bypassed it)',
      muts.length > 0 && ungranted.length === 0,
      `${muts.length} mutations seen, ${ungranted.length} without a recorded grant${ungranted.length ? `, e.g. ${ungranted.slice(0, 3).map((c) => c.argv.slice(0, 3).join(' ')).join(' | ')}` : ''}`);
  }
} catch (err) {
  check('no exception during the run', false, `${err?.stack ?? err} detail=${err?.detail ?? ''}`.slice(0, 1800));
} finally {
  for (const n of createdNames) dkTry(['rm', '-f', '-v', n]);
  for (const pid of REG.keys()) {
    for (const s of dkTry(['ps', '-a', '--filter', `label=claude-station.project=${pid}`, '--format', '{{.ID}}']).out.split('\n').filter(Boolean)) dkTry(['rm', '-f', '-v', s]);
    for (const n of dkTry(['network', 'ls', '--filter', `label=claude-station.project=${pid}`, '--format', '{{.ID}}']).out.split('\n').filter(Boolean)) dkTry(['network', 'rm', n]);
    for (const v of dkTry(['volume', 'ls', '--filter', `label=claude-station.project=${pid}`, '--format', '{{.Name}}']).out.split('\n').filter(Boolean)) dkTry(['volume', 'rm', v]);
  }
  for (const pid of [...REG.keys()]) void pid;
  dkTry(['rmi', SEED_REF]);
  for (const repo of [SCRATCH_REPO, SCRATCH_RT]) {
    const out = dkTry(['images', repo, '--format', '{{.Repository}}:{{.Tag}}']).out;
    for (const ref of out.split('\n').filter((r) => r && !r.endsWith(':<none>'))) dkTry(['rmi', ref]);
  }
  try { boot?.dispose(); } catch { /* */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${pass}/${pass + fail} PASS  (${fail} FAIL)`);
  process.exit(fail ? 1 : 0);
}
