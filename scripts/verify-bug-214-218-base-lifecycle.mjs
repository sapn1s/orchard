#!/usr/bin/env node
/**
 * BUG-214 + BUG-218 — the base image's lifecycle around live sessions and other instances.
 *
 * BUG-214: an image-only drift (a new base definition, a base rebuilt in place, a
 * re-pulled custom image) must never recreate a container that has live sessions,
 * for ANY image source — it applies at the next launch with none live. The defer
 * decision is read when it is taken, not sampled before the (async) build.
 *
 * BUG-218: base images belong to the instance (data dir) that built them. A build
 * labels the base with this instance's owner key (instance-owner.ts), and the
 * post-build prune removes only superseded base images carrying THAT key. Another
 * instance's, another uid's and unlabelled (legacy) base images are never removed;
 * unlabelled ones are reported.
 *
 * ISOLATION (FEAT-158): destructive — runs only on the sandbox daemon, under its lock
 * (`assertIsolatedDocker`). Inside the sandbox it additionally confines itself to a
 * per-run scratch image repo through a docker shim (the shared sandbox's preloaded
 * `claude-station-base` tags are never touched, even by the pre-fix prune), and a
 * base `docker build` is replaced by a one-line `FROM <seed>` build that keeps every
 * `--label` of the REAL argv, so the owner label under test comes from the product.
 *
 *   npm run sandbox:docker -- up && eval "$(npm run -s sandbox:docker -- env)"
 *   node scripts/verify-bug-214-218-base-lifecycle.mjs [--tree <dir with src/, scripts/lib, package.json>]
 *
 * `--tree` points the suite at another tree (the pinned pre-fix snapshot) for the
 * must-FAIL run. Default: this repo's working tree.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { assertIsolatedDocker } from './lib/docker-sandbox.mjs';

assertIsolatedDocker('verify-bug-214-218-base-lifecycle');

const REPO = path.resolve(import.meta.dirname, '..');
const ti = process.argv.indexOf('--tree');
const SRC_TREE = ti > 0 ? path.resolve(process.argv[ti + 1]) : REPO;

let pass = 0, fail = 0;
const check = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${obs}`); ok ? pass++ : fail++; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bug214-218-'));
const TREE = path.join(TMP, 'tree');
const DATA = path.join(TMP, 'data');
const WORK = path.join(TMP, 'work');
for (const d of [TREE, DATA, WORK]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(WORK, 'hello.ts'), 'export const x = 1;\n');
fs.cpSync(path.join(SRC_TREE, 'src'), path.join(TREE, 'src'), { recursive: true });
fs.copyFileSync(path.join(SRC_TREE, 'package.json'), path.join(TREE, 'package.json'));
fs.cpSync(path.join(SRC_TREE, 'scripts', 'lib'), path.join(TREE, 'scripts', 'lib'), { recursive: true });
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(TREE, 'node_modules'));

const RUN_ID = `${process.pid}${Date.now() % 100000}`;
const SCRATCH_REPO = `claude-station-b214-${RUN_ID}`;
const SCRATCH_RT = `claude-station-b214rt-${RUN_ID}`; // FEAT-157: the CLI layer's repo, confined per run too
const CUSTOM_REPO = `b214cust-${RUN_ID}`;
const SEED_DIR = path.join(TMP, 'seedctx');
fs.mkdirSync(SEED_DIR);

const dk = (args, opts = {}) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const dkTry = (args) => { const r = spawnSync('docker', args, { encoding: 'utf8' }); return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }; };

/** Seed: the sandbox's preloaded base (any claude-station-base tag). Read-only use. */
function seedId() {
  const out = dk(['images', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}']);
  // Prefer a hashed LEGACY base: it predates owner labels, so an image committed FROM it inherits
  // no `claude-station.owner` and the suite's "unlabelled" planted bases are genuinely unlabelled.
  // A v1+ base (FEAT-157) carries an owner label that a commit would inherit, which would make every
  // planted base look owned and hide the unlabelled-reporting path (B6). Fall back to any base.
  const line = out.split('\n').find((l) => /^claude-station-base:u\d+-g\d+-[0-9a-f]{12} /.test(l)) ?? out.split('\n').find((l) => l.startsWith('claude-station-base:'));
  if (!line) throw new Error('no claude-station-base image in the sandbox to seed from (npm run sandbox:docker -- up preloads one)');
  return line.trim().split(/\s+/)[1];
}
const SEED = seedId();
const SEED_REF = `b214seed-${RUN_ID}:seed`;
dk(['tag', SEED, SEED_REF]);
fs.writeFileSync(path.join(SEED_DIR, 'Dockerfile'), `FROM ${SEED_REF}\n`);

/*
 * The shim: repo rename both ways, and a base `build` (tag in the scratch repo)
 * becomes `docker build <every --label and -t of the real argv> <seedctx>`.
 */
const SHIM = path.join(TMP, 'docker-shim');
const BUILD_LOG = path.join(TMP, 'builds.jsonl');
fs.writeFileSync(SHIM, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const REAL = 'claude-station-base', SCRATCH = ${JSON.stringify(SCRATCH_REPO)};
const REAL_RT = 'claude-station-rt', SCRATCH_RT = ${JSON.stringify(SCRATCH_RT)};
let argv = process.argv.slice(2).map((a) => a.split(REAL).join(SCRATCH).split(REAL_RT + ':').join(SCRATCH_RT + ':').replace(/^claude-station-rt$/, SCRATCH_RT));
if (argv[0] === 'build' && argv.some((a) => a.startsWith(SCRATCH + ':'))) {
  const keep = ['build'];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--label' || argv[i] === '-t') { keep.push(argv[i], argv[i + 1]); i++; }
  }
  keep.push('--label', 'b214.build-nonce=' + Math.random().toString(36).slice(2)); // each build its own id, as a real rebuild is
  keep.push(${JSON.stringify(SEED_DIR)});
  fs.appendFileSync(${JSON.stringify(BUILD_LOG)}, JSON.stringify(argv) + '\\n');
  const ms = Number(process.env.B214_BUILD_DELAY_MS || 0);
  if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  argv = keep;
}
if ((argv[0] === 'rm' || argv[0] === 'stop') && process.env.B214_RM_DELAY_MS) {
  fs.writeFileSync(${JSON.stringify(path.join(TMP, 'rm-started'))}, '1');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.B214_RM_DELAY_MS));
}
if (argv[0] === 'tag') fs.appendFileSync(${JSON.stringify(path.join(TMP, 'tags.log'))}, JSON.stringify(argv) + '\\n');
const child = spawn('docker', argv, { stdio: ['inherit', 'pipe', 'pipe'] });
const back = (s) => s.split(SCRATCH_RT).join(REAL_RT).split(SCRATCH).join(REAL);
child.stdout.on('data', (d) => process.stdout.write(argv[0] === 'cp' ? d : back(String(d)))); // FEAT-157: docker cp to stdout is a binary tar stream
child.stderr.on('data', (d) => process.stderr.write(back(String(d))));
process.stdout.on('error', () => process.exit(1));
child.on('close', (c) => process.stdout.write('', () => process.exit(c ?? 1))); // flush a piped stdout before exiting
child.on('error', (e) => { process.stderr.write(String(e.message)); process.exit(127); });
`);
fs.chmodSync(SHIM, 0o755);
process.env.CLAUDE_STATION_DOCKER = SHIM;
process.env.CLAUDE_STATION_DATA = DATA;
// A scratch HOME: the sandbox cannot see the host's ~/.claude, so a bind of the real
// credential file shows a different inode inside and reads as `stale file bind` drift
// on every ensure (an environment artifact that would mask the image rule under test).
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude', '.credentials.json'), '{}\n');
process.env.HOME = HOME;
delete process.env.CLAUDE_CONFIG_DIR;

const MANIFEST = path.join(TREE, 'src', 'server', 'container', 'provision.json');
const MANIFEST0 = fs.readFileSync(MANIFEST, 'utf8');
const bumpBase = (why) => {
  const mj = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  mj.__bug214_probe = `${why} ${crypto.randomUUID()}`;
  fs.writeFileSync(MANIFEST, JSON.stringify(mj, null, 2) + '\n');
};
// FEAT-157: the BASE a project builds on (its pinned base); imageNameFor is what the container runs (base + CLI layer).
const baseOf = (m, proj) => (typeof m.baseRefFor === 'function' ? m.baseRefFor(proj) : m.imageNameFor(proj));
const scratchRef = (ref) => ref.replace('claude-station-base', SCRATCH_REPO).replace(/^claude-station-rt:/, `${SCRATCH_RT}:`);

const createdContainers = [];
function cleanup() {
  // Everything this suite made is on the sandbox daemon, in names/repos unique to this run.
  for (const n of createdContainers) dkTry(['rm', '-f', '-v', n]);
  // Untag by NAME, never `rmi -f <id>`: seeded tags share the sandbox's preloaded base id,
  // and removing by id would delete that shared image for every other lane.
  dkTry(['rmi', SEED_REF]);
  for (const repo of [SCRATCH_REPO, SCRATCH_RT, CUSTOM_REPO]) {
    const out = dkTry(['images', repo, '--format', '{{.Repository}}:{{.Tag}}']).out;
    for (const ref of out.split('\n').filter((r) => r && !r.endsWith(':<none>'))) dkTry(['rmi', ref]);
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

const importFresh = async (rel) => import(path.join(TREE, rel) + `?v=${crypto.randomUUID()}`);
const cid = (name) => dkTry(['inspect', name, '--format', '{{.Id}}']).out || null;
const running = (name) => dkTry(['inspect', name, '--format', '{{.State.Running}}']).out === 'true';
/** A distinct image id derived from the seed, with the given labels (docker commit; no build). */
function mintImage(ref, labels = {}) {
  const c = dk(['create', SEED, 'true']);
  try {
    const changes = Object.entries(labels).flatMap(([k, v]) => ['--change', `LABEL ${k}=${v}`]);
    dk(['commit', ...changes, '--change', `LABEL b214.nonce=${crypto.randomUUID()}`, c, ref]);
  } finally { dkTry(['rm', '-f', c]); }
  return dk(['image', 'inspect', ref, '--format', '{{.Id}}']);
}

// FEAT-157: a working-tree base change reaches only projects pinned to `dev`; this suite drives base changes through the tree.
const DEV_PIN = { pinned: 'dev', skipped: [], deferred: null };
const baseProject = (id, extra = {}) => ({
  id, name: `BUG-214 ${id}`, hostPath: WORK, isolation: 'container',
  settings: { tools: { serena: false, playwright: false }, browser: { enabled: false }, mounts: [], container: { gpu: 'off', base: DEV_PIN, ...extra } },
  createdAt: new Date().toISOString(),
});

console.log(`BUG-214 + BUG-218 base lifecycle\n  tree under test: ${SRC_TREE}\n  scratch repo: ${SCRATCH_REPO}\n`);

/*
 * ARCH-022 — the launch/close/start/stop/remove/rebuild vocabulary over both kinds of tree. With the
 * lifecycle authority (lifecycle.ts present) a launch is `admitContainer` + the lease it grants, and a
 * closed session's lease drains until the authority proves its processes gone. On a pinned pre-fix tree
 * it is exactly the old product: `ensureContainer` with a deferImageSwap probe over the sessions
 * registered so far, and the routes' liveNow probes.
 */
const { bootAuthority } = await import('./lib/lifecycle-harness.mjs');
const H = await bootAuthority(TREE);
const NEWAPI = !!H.lc;
const lanesMod = NEWAPI ? await import(path.join(TREE, 'src/server/lanes.ts')) : null;
const liveOld = new Map();
const liveOf = (pid) => () => (liveOld.get(pid)?.size ?? 0) > 0;
const L = {
  async admit(cmX, p, t) {
    if (NEWAPI) { const st = await cmX.admitContainer(p, t, { onLog: () => {} }); H.lc.attachLease(t, `sess-${t}`); return st; }
    const st = await cmX.ensureContainer(p, { deferImageSwap: liveOf(p.id), onLog: () => {} });
    if (!liveOld.has(p.id)) liveOld.set(p.id, new Set());
    liveOld.get(p.id).add(t);
    return st;
  },
  async close(p, t) {
    if (!NEWAPI) { liveOld.get(p.id)?.delete(t); return; }
    H.lc.drainLease(t);
    for (let i = 0; i < 60 && H.lc.leasesOf(p.id).some((l) => l.id === t); i++) await new Promise((r) => setTimeout(r, 250));
  },
  start: (cmX, p) => (NEWAPI ? cmX.ensureContainer(p, { onLog: () => {} }) : cmX.ensureContainer(p, { deferImageSwap: liveOf(p.id), refuseDestroyIfLive: liveOf(p.id), onLog: () => {} })),
  stop: (cmX, p) => (NEWAPI ? cmX.stopContainer(p, {}) : cmX.stopContainer(p, { liveNow: liveOf(p.id) })),
  remove: (cmX, p) => (NEWAPI ? cmX.removeProjectContainer(p, {}) : cmX.removeProjectContainer(p, { liveNow: liveOf(p.id) })),
  rebuild: (cmX, p, o = {}) => (NEWAPI ? cmX.rebuildContainer(p, { current: o.current, onLog: () => {} }) : cmX.rebuildContainer(p, { current: o.current, liveNow: liveOf(p.id), onLog: () => {} })),
  /** Run `code` as a RESTARTED server on this data dir (a fresh process; with the authority: boot recovery). */
  async asRestartedServer(code, vars) {
    if (NEWAPI) lanesMod.releaseWriter();
    const file = path.join(TMP, `restart-${crypto.randomUUID()}.mjs`);
    fs.writeFileSync(file, `const NEWAPI = ${NEWAPI};
const lc = NEWAPI ? await import(${JSON.stringify(path.join(TREE, 'src/server/lifecycle.ts'))}) : null;
if (lc) await lc.bootForTests();
const cm = await import(${JSON.stringify(path.join(TREE, 'src/server/container-manager.ts'))});
${Object.entries(vars).map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`).join('\n')}
try { ${code} } catch (e) { console.log('ERR ' + (e.code || '') + ' ' + String(e.message).split('\\n')[0]); }
process.exit(0);`);
    const r = spawnSync(process.execPath, ['--no-warnings', file], { encoding: 'utf8', env: { ...process.env }, timeout: 120_000 });
    if (NEWAPI) { const c = await lanesMod.claimDataDir({ port: null, waitMs: 10_000 }); if (!c.ok) throw new Error(`could not re-claim the data dir after the restarted-server step: ${c.reason}`); }
    return `${(r.stdout ?? '').trim()} ${(r.stderr ?? '').trim().slice(-300)}`;
  },
};

let exitCode = 0;
try {
  const { ownerKey } = await importFresh('src/server/instance-owner.ts');
  const MY_KEY = ownerKey();
  const OTHER_KEY = crypto.createHash('sha256').update(`other-${RUN_ID}`).digest('hex').slice(0, 16);

  /* ======================================================= BUG-214 ===== */
  /*
   * ARCH-022: "a session is live" is now a LEASE the lifecycle authority grants at admission (never a
   * liveness sample a caller passes in). The scenarios below therefore launch sessions through the ONE
   * adapter `L`: on a tree with the authority it is `admitContainer` + the lease; on a pinned pre-fix
   * tree (no lifecycle.ts) it is exactly what the old launch did (ensureContainer with a deferImageSwap
   * probe over the sessions registered so far). Same scenario, both trees: the must-FAIL stays anchored.
   */
  console.log('--- BUG-214: image drift under a live session');
  let cm = await importFresh('src/server/container-manager.ts');
  const p = baseProject(`b214s-${RUN_ID}`);
  const name = cm.containerName(p.id);
  createdContainers.push(name, `${name}-next`, `${name}.next`);
  mintImage(scratchRef(baseOf(cm, p)));
  let tseq = 0;
  const tag = (w) => `${w}-${RUN_ID}-${++tseq}`;
  const t0 = tag('s0');
  await L.admit(cm, p, t0);
  const id0 = cid(name);
  check('S0 station project: a launch creates the container and it runs', !!id0 && running(name) && cm.imageSourceOf(p) === 'station', `id=${id0?.slice(7, 19)} src=${cm.imageSourceOf(p)}`);

  // S1 — a new base definition (tag moves), second launch while session 1 is live.
  bumpBase('S1');
  cm = await importFresh('src/server/container-manager.ts');
  mintImage(scratchRef(baseOf(cm, p)));
  const r1 = cm.statusOf(p).driftReasons ?? [];
  const t1 = tag('s1');
  await L.admit(cm, p, t1);
  const id1 = cid(name);
  check('S1 base definition changed + live session: the live container is KEPT (id unchanged, running)',
    id1 === id0 && running(name), `reasons=${JSON.stringify(r1)} id ${id0?.slice(7, 19)} -> ${id1?.slice(7, 19)}`);

  // S3 — two launches during a slow base build, sessions live: neither recreates the container.
  bumpBase('S3');
  cm = await importFresh('src/server/container-manager.ts');
  mintImage(scratchRef(baseOf(cm, p)));
  const t3a = tag('s3a'); const t3b = tag('s3b');
  await Promise.all([L.admit(cm, p, t3a), L.admit(cm, p, t3b)]);
  const id3 = cid(name);
  check('S3 two concurrent launches over a changed base, sessions live: the container is kept for both', id3 === id0 && running(name), `id ${id0?.slice(7, 19)} -> ${id3?.slice(7, 19)}`);

  // S4 — every session closed: the new base DOES apply at the next launch (not over-deferred).
  for (const t of [t0, t1, t3a, t3b]) await L.close(p, t);
  const t4 = tag('s4');
  await L.admit(cm, p, t4);
  const id4 = cid(name);
  const img4 = dkTry(['inspect', name, '--format', '{{.Config.Image}}']).out;
  check('S4 next launch with NO live session: recreated on the new base',
    !!id4 && id4 !== id0 && running(name) && img4 === scratchRef(cm.imageNameFor(p)), `id ${id0?.slice(7, 19)} -> ${id4?.slice(7, 19)} image=${img4}`);

  // S2 — the container runs the current tag; that same tag is rebuilt in place (new bytes, same name), session 4 live.
  mintImage(scratchRef(baseOf(cm, p)));
  const r2 = cm.statusOf(p).driftReasons ?? [];
  const t2 = tag('s2');
  await L.admit(cm, p, t2);
  const id2 = cid(name);
  check('S2 base rebuilt in place (same tag, new id) + live session: KEPT',
    // ARCH-022 (b-ii): before a launch has proven the rebuilt image's CLI by its bytes, status names the CLI layer
    // (not proven to carry it) instead of reporting "was rebuilt"; either way it reports drift, and the container is KEPT.
    r2.some((r) => /was rebuilt|!= claude-station-rt:/.test(r)) && id2 === id4 && running(name), `reasons=${JSON.stringify(r2)} id ${id4?.slice(7, 19)} -> ${id2?.slice(7, 19)}`);
  for (const t of [t4, t2]) await L.close(p, t);

  // S8 — a Rebuild with nobody live; a launch arrives while the base builds. The launched session's
  // container is never removed or recreated after it was handed to the session.
  {
    mintImage(scratchRef(baseOf(cm, p)), { 'claude-station.owner': MY_KEY }); // this instance's own base (a Rebuild of a foreign one refuses)
    process.env.B214_BUILD_DELAY_MS = '3000';
    const pr8 = L.rebuild(cm, p).then(() => null, (e) => e);
    await new Promise((r) => setTimeout(r, 800));
    const t8 = tag('s8');
    const l8 = await L.admit(cm, p, t8).then(() => cid(name), (e) => e);
    const err8 = await pr8;
    delete process.env.B214_BUILD_DELAY_MS;
    await new Promise((r) => setTimeout(r, 800));
    check('S8 a session launched during a Rebuild\'s build keeps the container it was given (nothing removes or recreates it after)',
      !err8 && typeof l8 === 'string' && cid(name) === l8 && running(name), `rebuildErr=${err8?.message?.slice(0, 120) ?? null} session on ${typeof l8 === 'string' ? l8.slice(7, 19) : l8?.message?.slice(0, 80)} now ${cid(name)?.slice(7, 19)}`);
    await L.close(p, t8);
    const before8 = cid(name);
    const pr8b = await L.rebuild(cm, p).then(() => null, (e) => e);
    check('S8b control: a Rebuild with no live session still recreates the container', !pr8b && cid(name) !== before8 && running(name),
      `err=${pr8b?.message?.slice(0, 120) ?? null} id ${before8?.slice(7, 19)} -> ${cid(name)?.slice(7, 19)}`);
  }

  // S9 — Rebuild requested with the project as the route read it; the settings changed and a session started on
  // the new settings: the Rebuild must not touch the container (it re-reads the project and defers to the session).
  {
    const pOld = p;
    const pNew = { ...p, settings: { ...p.settings, container: { ...p.settings.container, memoryMb: 1024 } } };
    const t9 = tag('s9');
    await L.admit(cm, pNew, t9);
    const before9 = cid(name);
    process.env.B214_BUILD_DELAY_MS = '1500';
    let err9 = null; try { await L.rebuild(cm, pOld, { current: () => pNew }); } catch (e) { err9 = e; }
    delete process.env.B214_BUILD_DELAY_MS;
    const mem9 = dkTry(['inspect', name, '--format', '{{.HostConfig.Memory}}']).out;
    check('S9 a Rebuild whose project snapshot is stale leaves a container with a live session untouched',
      !err9 && cid(name) === before9 && running(name) && mem9 === String(1024 * 1024 * 1024), `err=${err9?.message?.slice(0, 100) ?? null} id ${before9?.slice(7, 19)} -> ${cid(name)?.slice(7, 19)} mem=${mem9}`);
    // S10 — an unforced manual Start under a live session: image drift defers, other drift REFUSES (never recreates).
    const before10 = cid(name);
    let err10 = null;
    try { await L.start(cm, pOld); } catch (e) { err10 = e; }
    check('S10 an unforced Start with sessions live refuses a non-image recreate (live-sessions) and keeps the container',
      err10?.code === 'live-sessions' && cid(name) === before10 && running(name), `err=${err10?.code} ${err10?.message?.slice(0, 90)} id ${before10?.slice(7, 19)} -> ${cid(name)?.slice(7, 19)}`);
    await L.close(pNew, t9);
    await L.start(cm, pOld); // back to the suite's settings, nobody live
  }

  // S5 — image drift COMBINED with the one-time lockdown upgrade, under a live session. A container that
  // predates the lockdown with a session in it is a pre-upgrade container whose server restarted: the
  // session's tool process is still running in it. So this runs as the RESTARTED server (a child process:
  // boot recovery declares that work a lease), and its next launch must keep the container.
  const p5 = baseProject(`b214l-${RUN_ID}`);
  const n5 = cm.containerName(p5.id);
  createdContainers.push(n5, `${n5}-next`, `${n5}.next`);
  // FEAT-157: a pre-lockdown container runs a LEGACY base (which bakes the CLI); the seed stands in for it.
  const oldTag = SEED_REF;
  const argv5 = cm.createArgs(p5, n5, oldTag, { onLog: () => {} });
  argv5[argv5.indexOf('--user') + 1] = '0:0';
  dk(argv5); dk(['start', n5]);
  const id5 = cid(n5);
  dk(['exec', '-d', '--env', `CLAUDE_STATION_EXEC=s5-${RUN_ID}`, n5, 'sleep', '600']); // the live session's tool
  bumpBase('S5');
  cm = await importFresh('src/server/container-manager.ts');
  mintImage(scratchRef(baseOf(cm, p5)));
  const r5 = cm.statusOf(p5).driftReasons ?? [];
  const out5 = await L.asRestartedServer(`
    const st = await (NEWAPI ? cm.admitContainer(P5, 's5-next-${RUN_ID}', {}) : cm.ensureContainer(P5, { deferImageSwap: true }));
    console.log('S5 ' + st.state);`, { P5: p5 });
  check('S5 image + lockdown drift together + live session (found by a restarted server): KEPT',
    r5.some((r) => r.startsWith('image ')) && r5.some((r) => r.startsWith('lockdown:')) && cid(n5) === id5 && running(n5),
    `reasons=${JSON.stringify(r5.map((r) => r.slice(0, 40)))} restarted: ${out5.slice(-160)} id ${id5?.slice(7, 19)} -> ${cid(n5)?.slice(7, 19)}`);
  dkTry(['exec', n5, 'sh', '-c', `for p in /proc/[0-9]*; do grep -qz CLAUDE_STATION_EXEC=s5-${RUN_ID} $p/environ 2>/dev/null && kill -9 \${p#/proc/}; done; true`]);

  // S6 — a prebuilt custom image re-pulled under the same name, live session.
  const customRef = `${CUSTOM_REPO}:v1`;
  mintImage(customRef);
  const p6 = baseProject(`b214c-${RUN_ID}`, { image: customRef });
  const n6 = cm.containerName(p6.id);
  createdContainers.push(n6, `${n6}-next`, `${n6}.next`);
  const t6a = tag('s6a');
  await L.admit(cm, p6, t6a);
  const id6 = cid(n6);
  mintImage(customRef);
  const r6 = cm.statusOf(p6).driftReasons ?? [];
  const t6b = tag('s6b');
  await L.admit(cm, p6, t6b);
  check('S6 custom image re-pulled (same name, new id) + live session: KEPT',
    cm.imageSourceOf(p6) === 'custom' && r6.some((r) => /was rebuilt/.test(r)) && cid(n6) === id6 && running(n6),
    `src=${cm.imageSourceOf(p6)} reasons=${JSON.stringify(r6)} id ${id6?.slice(7, 19)} -> ${cid(n6)?.slice(7, 19)}`);
  for (const t of [t6a, t6b]) await L.close(p6, t);

  // S11 — a Rebuild with nobody live; a launch arrives while the Rebuild's container removal runs. The launch
  // must not end up on a container that is then removed (clean-room round 3, s1).
  {
    await L.start(cm, p6);                                    // settle S6's deferred drift
    const drift11 = cm.statusOf(p6).driftReasons ?? [];
    const rmMark = path.join(TMP, 'rm-started');
    try { fs.rmSync(rmMark); } catch { /* none */ }
    process.env.B214_RM_DELAY_MS = '2500';
    const pr11 = L.rebuild(cm, p6).then(() => null, (e) => e);
    for (let i = 0; i < 100 && !fs.existsSync(rmMark); i++) await new Promise((r) => setTimeout(r, 100));
    const t11 = tag('s11');
    const launch = await L.admit(cm, p6, t11).then(() => null, (e) => e);
    const sessionOn = cid(n6);
    const err11 = await pr11;
    delete process.env.B214_RM_DELAY_MS;
    await new Promise((r) => setTimeout(r, 800));
    check('S11 a launch during a Rebuild\'s container removal: its session\'s container is never removed afterwards',
      drift11.length === 0 && fs.existsSync(rmMark) && !launch && !!sessionOn && cid(n6) === sessionOn && running(n6),
      `drift=${JSON.stringify(drift11)} rmSeen=${fs.existsSync(rmMark)} launchErr=${launch?.message?.slice(0, 80) ?? null} rebuildErr=${err11?.message?.slice(0, 80) ?? null} session on ${sessionOn?.slice(7, 19)} now ${cid(n6)?.slice(7, 19)}`);
    await L.close(p6, t11);
  }

  // S12 — a launch while a Remove's `docker rm` runs waits for it and gets a NEW container that nothing then removes.
  {
    const rmMark = path.join(TMP, 'rm-started');
    try { fs.rmSync(rmMark); } catch { /* none */ }
    const old12 = cid(n6);
    process.env.B214_RM_DELAY_MS = '2500';
    const pr12 = L.remove(cm, p6).then(() => null, (e) => e);
    for (let i = 0; i < 100 && !fs.existsSync(rmMark); i++) await new Promise((r) => setTimeout(r, 100));
    const t12 = tag('s12');
    const launch12 = await L.admit(cm, p6, t12).then(() => null, (e) => e);
    const sessionOn = cid(n6);
    const err12 = await pr12;
    delete process.env.B214_RM_DELAY_MS;
    await new Promise((r) => setTimeout(r, 800));
    check('S12 a launch during a Remove waits for it and its new container survives',
      fs.existsSync(rmMark) && !launch12 && !err12 && !!sessionOn && sessionOn !== old12 && cid(n6) === sessionOn && running(n6),
      `launchErr=${launch12?.message?.slice(0, 80) ?? null} removeErr=${err12?.message?.slice(0, 80) ?? null} old ${old12?.slice(7, 19)} session on ${sessionOn?.slice(7, 19)} now ${cid(n6)?.slice(7, 19)}`);
    await L.close(p6, t12);
  }

  // S13 — a Stop requested while a launch's ensure is in flight must not stop the container under that session.
  {
    mintImage(customRef);                                     // drift, so the launch's ensure recreates (slowly)
    process.env.B214_RM_DELAY_MS = '2000';
    const t13 = tag('s13');
    const launch = L.admit(cm, p6, t13).then(() => null, (e) => e);
    await new Promise((r) => setTimeout(r, 300));
    const stop13 = await L.stop(cm, p6).then(() => null, (e) => e);
    const lErr = await launch;
    delete process.env.B214_RM_DELAY_MS;
    check('S13 a Stop that arrived during a launch refuses once that session is live (container keeps running)',
      !lErr && stop13?.code === 'live-sessions' && running(n6), `launchErr=${lErr?.message?.slice(0, 60) ?? null} stop=${stop13?.code ?? 'went through'} running=${running(n6)}`);
    await L.close(p6, t13);
  }

  // S14 — Stop A in flight; a launch L queues behind it; then Remove B (nobody live at its request) queues
  // behind both. B must see L's session and refuse (clean-room round 6, w1 (j)).
  {
    await L.start(cm, p6);
    process.env.B214_RM_DELAY_MS = '1500';
    const a14 = L.stop(cm, p6).then(() => null, (e) => e);
    await new Promise((r) => setTimeout(r, 200));
    const t14 = tag('s14');
    const l14 = L.admit(cm, p6, t14).then(() => null, (e) => e);
    await new Promise((r) => setTimeout(r, 100));
    const b14 = await L.remove(cm, p6).then(() => null, (e) => e);
    const [aErr, lErr] = [await a14, await l14];
    delete process.env.B214_RM_DELAY_MS;
    check('S14 a Remove queued behind a launch (itself behind a Stop) refuses once that session registers',
      !aErr && !lErr && b14?.code === 'live-sessions' && running(n6), `stopA=${aErr?.message?.slice(0, 50) ?? 'ok'} launch=${lErr?.message?.slice(0, 50) ?? 'ok'} removeB=${b14?.code ?? 'went through'} running=${running(n6)}`);
    await L.close(p6, t14);
  }

  // S15 — an image that carries `claude-station.role=service`: the session container must not inherit it, or
  // ensureServices removes it as a stray sidecar (clean-room round 8, y1).
  {
    const roleRef = `${CUSTOM_REPO}:role`;
    const c = dk(['create', SEED, 'true']);
    try { dk(['commit', '--change', 'LABEL claude-station.role=service', c, roleRef]); } finally { dkTry(['rm', '-f', c]); }
    const p15 = baseProject(`b214r-${RUN_ID}`, { image: roleRef });
    const n15 = cm.containerName(p15.id);
    createdContainers.push(n15);
    await L.start(cm, p15);
    const role = dkTry(['inspect', n15, '--format', '{{index .Config.Labels "claude-station.role"}}']).out;
    const svc = await import(path.join(TREE, 'src/server/service-manager.ts') + `?v=${crypto.randomUUID()}`);
    const before15 = cid(n15);
    let e15 = null; try { await H.op(p15.id, () => svc.ensureServices(p15, () => {})); } catch (e) { e15 = e; }
    check('S15 a session container never inherits the image\'s service role; ensureServices leaves it running',
      role === 'session' && cid(n15) === before15 && running(n15), `role=${role} svcErr=${e15?.message?.slice(0, 60) ?? null} id ${before15?.slice(7, 19)} -> ${cid(n15)?.slice(7, 19)}`);
  }

  // S7 — a CONFIG drift is not an image swap: with nobody live it applies (control) …
  const p7 = { ...p6, settings: { ...p6.settings, container: { ...p6.settings.container, memoryMb: 1536 } } };
  const r7 = cm.statusOf(p7).driftReasons ?? [];
  const id7a = cid(n6);
  await L.start(cm, p7);
  check('S7 control: a settings (memory) drift with nobody live is applied (recreated)',
    r7.some((r) => r.startsWith('memory ')) && cid(n6) !== id7a && running(n6), `reasons=${JSON.stringify(r7.map((r) => r.slice(0, 50)))}`);
  // … and S7b — with a session live it is REFUSED, never recreated under it (ARCH-022: no path recreates under a live session).
  {
    const t7 = tag('s7');
    await L.admit(cm, p7, t7);
    const before7b = cid(n6);
    const p7b = { ...p7, settings: { ...p7.settings, container: { ...p7.settings.container, memoryMb: 2048 } } };
    const e7b = await L.admit(cm, p7b, tag('s7b')).then(() => null, (e) => e);
    check('S7b a settings drift with a session live: the next launch is refused, the container is not recreated under the session',
      !!e7b && cid(n6) === before7b && running(n6), `launch=${e7b ? (e7b.code ?? e7b.message?.slice(0, 80)) : 'went through (RECREATED?)'} id ${before7b?.slice(7, 19)} -> ${cid(n6)?.slice(7, 19)}`);
    await L.close(p7, t7);
  }

  /* ======================================================= BUG-218 ===== */
  console.log('--- BUG-218: base-image prune ownership');
  fs.writeFileSync(MANIFEST, MANIFEST0);
  bumpBase('B0');
  cm = await importFresh('src/server/container-manager.ts');
  const cur = baseOf(cm, p);
  const curTag = cur.split(':').pop();
  const uid = os.userInfo().uid, gid = os.userInfo().gid;
  const T = (tag) => `${SCRATCH_REPO}:${tag}`;
  const hx = () => crypto.randomBytes(6).toString('hex');
  const planted = {
    ownOld: T(`u${uid}-g${gid}-${hx()}`),
    foreignSameUid: T(`u${uid}-g${gid}-${hx()}`),
    foreignOtherUid: T(`u${uid + 1}-g${gid + 1}-${hx()}`),
    unlabelledHash: T(`u${uid}-g${gid}-${hx()}`),
    unlabelledOtherUid: T(`u${uid + 1}-g${gid + 1}-${hx()}`),
    unlabelledLegacy: T(`u${uid}-g${gid}`),
  };
  mintImage(planted.ownOld, { 'claude-station.owner': MY_KEY });
  mintImage(planted.foreignSameUid, { 'claude-station.owner': OTHER_KEY });
  mintImage(planted.foreignOtherUid, { 'claude-station.owner': OTHER_KEY });
  mintImage(planted.unlabelledHash);
  mintImage(planted.unlabelledOtherUid);
  mintImage(planted.unlabelledLegacy);
  const ownInUse = T(`u${uid}-g${gid}-${hx()}`);
  mintImage(ownInUse, { 'claude-station.owner': MY_KEY });
  const holder = `b218-holder-${RUN_ID}`;
  createdContainers.push(holder);
  dk(['create', '--name', holder, ownInUse, 'true']);

  // The real trigger: the wanted base is missing -> ensure builds it -> prune after the ensure.
  const logs = [];
  const p8 = baseProject(`b218-${RUN_ID}`);
  createdContainers.push(cm.containerName(p8.id), `${cm.containerName(p8.id)}-next`);
  await cm.ensureContainer(p8, { onLog: (s) => logs.push(String(s)) });
  await H.drainImages(); // ARCH-022: the post-ensure prune runs in the image-cleanup slot, after the ensure
  const has = (ref) => dkTry(['image', 'inspect', ref, '--format', '{{.Id}}']).code === 0;
  const built = has(T(curTag));
  const builtOwner = dkTry(['image', 'inspect', T(curTag), '--format', '{{index .Config.Labels "claude-station.owner"}}']).out;
  check('B0 precondition: the ensure BUILT the wanted base (through the product\'s build argv)', built && fs.existsSync(BUILD_LOG), `built=${built} buildlog=${fs.existsSync(BUILD_LOG)}`);
  check('B1 the built base carries this instance\'s owner label (instance-owner.ts ownerKey)', builtOwner === MY_KEY, `label=${builtOwner} mine=${MY_KEY}`);
  check('B2 this instance\'s own superseded base IS reclaimed (prune not neutered)', !has(planted.ownOld), `ownOld present=${has(planted.ownOld)} log=${JSON.stringify(logs.filter((l) => /reclaim|unlabelled/i.test(l)).map((l) => l.trim().slice(0, 200)))}`);
  check('B3 another instance\'s base (same uid) is NOT removed', has(planted.foreignSameUid), `present=${has(planted.foreignSameUid)}`);
  check('B4 another uid\'s base (another owner) is NOT removed', has(planted.foreignOtherUid), `present=${has(planted.foreignOtherUid)}`);
  check('B5 unlabelled (legacy) base images are NOT removed — hashed, other-uid and hashless tags',
    has(planted.unlabelledHash) && has(planted.unlabelledOtherUid) && has(planted.unlabelledLegacy),
    `hash=${has(planted.unlabelledHash)} otherUid=${has(planted.unlabelledOtherUid)} legacy=${has(planted.unlabelledLegacy)}`);
  check('B6 unlabelled base images are REPORTED in the ensure log', logs.some((l) => /unlabelled/i.test(l) && l.includes(planted.unlabelledLegacy.replace(SCRATCH_REPO, 'claude-station-base'))),
    JSON.stringify(logs.filter((l) => /unlabelled/i.test(l)).map((l) => l.trim().slice(0, 300))));
  check('B7 own base still used by a (stopped) container is kept (docker refuses; no --force)', has(ownInUse), `present=${has(ownInUse)}`);
  check('B8 the kept (current) base is untouched', has(T(curTag)), `present=${has(T(curTag))}`);

  // B9 — the tag moved to ANOTHER instance's image between the ownership read and the removal:
  // removal is by the inspected id, so the foreign image now holding the tag survives.
  const raceTag = T(`u${uid}-g${gid}-${hx()}`);
  const raceOldId = mintImage(raceTag, { 'claude-station.owner': MY_KEY });
  const foreignId = mintImage(`${SCRATCH_REPO}:race-src-${RUN_ID}`, { 'claude-station.owner': OTHER_KEY });
  // Interpose: the `image rm` aimed at raceTag (by name or id) first retags raceTag onto the foreign image.
  const SHIM2 = path.join(TMP, 'docker-shim-race');
  fs.writeFileSync(SHIM2, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const argv = process.argv.slice(2);
const flag = ${JSON.stringify(path.join(TMP, 'raced'))};
const hits = [${JSON.stringify(raceTag.replace(SCRATCH_REPO, 'claude-station-base'))}, ${JSON.stringify(raceOldId)}, ${JSON.stringify(raceOldId.replace('sha256:', ''))}];
if (argv[0] === 'image' && argv[1] === 'rm' && argv.some((a) => hits.includes(a)) && !fs.existsSync(flag)) {
  fs.writeFileSync(flag, '1');
  spawnSync('docker', ['tag', ${JSON.stringify(foreignId)}, ${JSON.stringify(raceTag)}]);
}
const r = spawnSync(${JSON.stringify(SHIM)}, argv, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`);
  fs.chmodSync(SHIM2, 0o755);
  process.env.CLAUDE_STATION_DOCKER = SHIM2;
  const cmR = await importFresh('src/server/container-manager.ts');
  // Only the race tag is a candidate that is our own; everything else is as above.
  const res = await H.op('#images', () => cmR.pruneSupersededImages(cur));
  process.env.CLAUDE_STATION_DOCKER = SHIM;
  const after = dkTry(['image', 'inspect', raceTag, '--format', '{{.Id}}']).out;
  check('B9 a tag moved to another instance\'s image between check and removal: the foreign image keeps it',
    fs.existsSync(path.join(TMP, 'raced')) && after === foreignId, `raced=${fs.existsSync(path.join(TMP, 'raced'))} raceTag now -> ${after.slice(7, 19)} foreign=${foreignId.slice(7, 19)} removed=${JSON.stringify(res.removed)}`);

  /* ---- B10-B12: the SHARED base tag across instances (clean-room round 1 findings) ---- */
  // Each "instance" is its own node process (the owner key is read from its env).
  const CHILD = path.join(TMP, 'instance.mjs');
  fs.writeFileSync(CHILD, `
const [tree, mode] = process.argv.slice(2);
const lc = await import(tree + '/src/server/lifecycle.ts').catch(() => null); // ARCH-022: each instance boots its own authority
if (lc) await lc.bootForTests();
const cm = await import(tree + '/src/server/container-manager.ts?v=' + Math.random());
const project = JSON.parse(process.env.B214_PROJECT);
const OP = (fn) => (lc ? lc.runOp(project.id, 'maintain', async () => fn()) : fn());
try { const img = await OP(() => cm.ensureImage(project, { force: mode === 'force', onLog: () => {} })); console.log('OK ' + img); }
catch (e) { console.log('ERR ' + (e.code || '') + ' ' + String(e.message).split('\\n')[0]); }
`);
  const { spawn } = await import('node:child_process');
  const runInstance = (dataDir, mode, extraEnv = {}) => new Promise((resolve) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const c = spawn(process.execPath, [CHILD, TREE, mode], { env: { ...process.env, CLAUDE_STATION_DATA: dataDir, B214_PROJECT: JSON.stringify(p8), ...extraEnv } });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('close', () => resolve(out.trim().split('\n').pop() ?? ''));
  });
  // ARCH-022: the key a server on `dataDir` stamps is the identity declared in that dir (declared now if new).
  const keyOf = async (dataDir) => (await import('./lib/owned-docker.mjs')).ownerKeyFor(dataDir);
  const tagInfo = (ref) => { const r = dkTry(['image', 'inspect', ref, '--format', '{{.Id}}\t{{json .Config}}']); if (r.code !== 0) return null; const [id = '', cfg = 'null'] = r.out.split('\t'); return { id, owner: (JSON.parse(cfg)?.Labels ?? {})['claude-station.owner'] ?? '' }; };
  const idExists = (id) => !!id && dkTry(['image', 'inspect', id, '--format', '{{.Id}}']).code === 0;
  const DA = path.join(TMP, 'instA'), DB = path.join(TMP, 'instB');
  const KA = await keyOf(DA), KB = await keyOf(DB);
  // A fresh base definition, so the shared tag starts absent and no container holds it.
  bumpBase('B10');
  const shared = T(baseOf(await importFresh('src/server/container-manager.ts'), p8).split(':').pop());

  // B10 — B presses Rebuild while the shared tag holds A's image: A's image must survive.
  dkTry(['rmi', shared]);
  const a10 = await runInstance(DA, 'plain');
  const before10 = tagInfo(shared);
  const b10 = await runInstance(DB, 'force');
  const after10 = tagInfo(shared);
  check('B10 another instance\'s Rebuild never replaces the shared base tag this instance built (A\'s image kept, tag unchanged)',
    before10?.owner === KA && idExists(before10.id) && after10?.id === before10.id,
    `A: ${a10} | tag before owner=${before10?.owner} id=${before10?.id.slice(7, 19)} | B rebuild: ${b10} | tag after owner=${after10?.owner} id=${after10?.id.slice(7, 19)} | A image exists=${idExists(before10?.id)}`);

  // B11 — A and B both find the tag missing and build at once: the first image under the tag is never replaced.
  dkTry(['rmi', shared]);
  const pa = runInstance(DA, 'plain', { B214_BUILD_DELAY_MS: '1500' });
  const pb = runInstance(DB, 'plain', { B214_BUILD_DELAY_MS: '6000' });
  const a11 = await pa;
  const first11 = tagInfo(shared);
  const b11 = await pb;
  const after11 = tagInfo(shared);
  check('B11 two instances building the same missing base at once: the first built stays under the tag, the later one does not replace it',
    first11?.owner === KA && after11?.id === first11.id && idExists(first11.id),
    `A: ${a11} -> tag owner=${first11?.owner} id=${first11?.id.slice(7, 19)} | B: ${b11} -> tag owner=${after11?.owner} id=${after11?.id.slice(7, 19)} (B key ${KB})`);
  const stagingLeft = dkTry(['images', SCRATCH_REPO, '--format', '{{.Tag}}']).out.split('\n').filter((t) => t.startsWith('build-'));
  check('B11b no staging tags are left behind by either build', stagingLeft.length === 0, JSON.stringify(stagingLeft));

  // B12 — an isolated instance's Rebuild over an UNLABELLED base: refused, the legacy image kept.
  dkTry(['rmi', shared]);
  const legacyId = mintImage(shared);
  const c12 = await runInstance(path.join(TMP, 'instC'), 'force');
  const after12 = tagInfo(shared);
  check('B12 an isolated instance\'s Rebuild never replaces an unlabelled base (refused, legacy image kept under the tag)',
    after12?.id === legacyId && idExists(legacyId), `rebuild: ${c12} | tag now id=${after12?.id.slice(7, 19)} legacy=${legacyId.slice(7, 19)}`);

  // B14 — a base with NO labels at all under the tag (docker import/commit from a label-less image): an isolated
  // instance's Rebuild must refuse, and an ordinary build must not re-point over it (clean-room round 2, q2).
  const bare = () => { const c = dk(['create', 'busybox:latest', 'true']); try { dk(['commit', '--change', `ENV B214_NONCE=${crypto.randomUUID()}`, c, shared]); } finally { dkTry(['rm', '-f', c]); } return dk(['image', 'inspect', shared, '--format', '{{.Id}}']); };
  dkTry(['rmi', shared]);
  const bareId = bare();
  const c14 = await runInstance(path.join(TMP, 'instC'), 'force');
  const d14 = await runInstance(path.join(TMP, 'instC'), 'plain');
  check('B14 a label-less base under the tag is never replaced (isolated Rebuild refused; ordinary ensure uses it)',
    tagInfo(shared)?.id === bareId && idExists(bareId), `rebuild: ${c14} | plain: ${d14} | tag id=${tagInfo(shared)?.id.slice(7, 19)} bare=${bareId.slice(7, 19)}`);
  const cm14 = await importFresh('src/server/container-manager.ts');
  const pr14 = await H.op('#images', () => cm14.pruneSupersededImages(T('u0-g0-000000000000').replace(SCRATCH_REPO, 'claude-station-base')));
  check('B14b the prune reports a label-less base as unlabelled (and keeps it)',
    pr14.unlabelled?.includes(shared.replace(SCRATCH_REPO, 'claude-station-base')) && idExists(bareId), JSON.stringify(pr14.unlabelled ?? null).slice(0, 200));

  // B15 — builds that finish TOGETHER (BuildKit merges identical builds): the shared tag is pointed exactly once.
  let races = 0, doubleTag = 0;
  for (let i = 0; i < 3; i++) {
    dkTry(['rmi', shared]);
    try { fs.rmSync(path.join(TMP, 'tags.log')); } catch { /* none */ }
    const [ra, rb] = await Promise.all([runInstance(DA, 'plain', { B214_BUILD_DELAY_MS: '2000' }), runInstance(DB, 'plain', { B214_BUILD_DELAY_MS: '2000' })]);
    const tags = fs.existsSync(path.join(TMP, 'tags.log')) ? fs.readFileSync(path.join(TMP, 'tags.log'), 'utf8').split('\n').filter((l) => l.includes(shared.replace(SCRATCH_REPO, 'claude-station-base')) || l.includes(shared)) : [];
    races++; if (tags.length !== 1 || !/^OK/.test(ra) || !/^OK/.test(rb)) doubleTag++;
  }
  check('B15 simultaneous builds by two instances point the shared tag exactly once (3 races), both succeed', doubleTag === 0, `races=${races} bad=${doubleTag}`);
  const locksLeft = dkTry(['ps', '-a', '--filter', 'label=orchard.basetag-lock=1', '--format', '{{.Names}}']).out;
  check('B15b no base-tag lock container is left behind', locksLeft === '', locksLeft);

  // B16 — a staging tag left by a build that died: this instance's own is reclaimed, another's is kept (round 3, s2).
  {
    const ownStage = T(`build-${MY_KEY}-u${uid}-g${gid}-${hx()}-dead0001`);
    const otherStage = T(`build-${OTHER_KEY}-u${uid}-g${gid}-${hx()}-dead0002`);
    mintImage(ownStage, { 'claude-station.owner': MY_KEY });
    mintImage(otherStage, { 'claude-station.owner': OTHER_KEY });
    const cm16 = await importFresh('src/server/container-manager.ts');
    const r16 = await H.op('#images', () => cm16.pruneSupersededImages('claude-station-base:none'));
    check('B16 a dead build\'s own staging tag is reclaimed; another instance\'s staging tag is kept', !has(ownStage) && has(otherStage),
      `own present=${has(ownStage)} other present=${has(otherStage)} removed=${JSON.stringify(r16.removed.filter((x) => x.includes('build-')))}`);
  }

  // B13 — this instance's own Rebuild still works (not neutered): the tag moves to its new build.
  dkTry(['rmi', shared]);
  await runInstance(DA, 'plain');
  const own13 = tagInfo(shared);
  const a13 = await runInstance(DA, 'force');
  const after13 = tagInfo(shared);
  check('B13 control: an instance\'s Rebuild of ITS OWN base does rebuild (tag moves to a new own image)',
    own13?.owner === KA && after13?.owner === KA && after13.id !== own13.id, `A rebuild: ${a13} | ${own13?.id.slice(7, 19)} -> ${after13?.id.slice(7, 19)}`);
} catch (err) {
  console.error(`\nHARNESS ERROR: ${err?.stack ?? err}`);
  exitCode = 2;
} finally {
  cleanup();
}

console.log(`\n${pass}/${pass + fail} PASS  (${fail} FAIL)`);
process.exit(exitCode || (fail ? 1 : 0));
