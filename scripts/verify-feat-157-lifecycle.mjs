#!/usr/bin/env node
/**
 * FEAT-157 — pinned bases, the Claude CLI layer, security releases, recovery,
 * migration and GC, against a REAL docker daemon: the FEAT-158 sandbox only.
 *
 *   npm run sandbox:docker -- up && eval "$(npm run -s sandbox:docker -- env)"
 *   node scripts/verify-feat-157-lifecycle.mjs [--tree <dir>] [--only L1,L2]
 *
 * ISOLATION: `assertIsolatedDocker` (refuses the host daemon, takes the sandbox
 * lock). Inside the sandbox the suite confines itself to per-run image repos
 * through a docker shim (`claude-station-base` and `claude-station-rt` are renamed
 * both ways), so the sandbox's preloaded base is never touched. A base `docker
 * build` is replaced by a one-line `FROM <seed>` build that keeps every `--label`
 * and `-t` of the REAL argv (the labels under test come from the product), and
 * the real argv is logged so the suite can see which recipe (release snapshot) and
 * which flags (--no-cache --pull) the product asked for.
 *
 * THE CLI: a stand-in CLI script per version through the product's test seam
 * (ORCHARD_TEST_CONTAINER_CLI, honoured only with CLAUDE_STATION_DATA set), so a
 * CLI change can be exercised without swapping the SDK. L10 runs the REAL host
 * SDK's bundled CLI through the real path (no seam).
 *
 * `--tree` points at another tree (the pinned pre-lane snapshot) for the must-FAIL.
 * Everything a check needs that the pre-lane tree lacks is a FAIL, never a crash.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { assertIsolatedDocker } from './lib/docker-sandbox.mjs';

assertIsolatedDocker('verify-feat-157-lifecycle');

const REPO = path.resolve(import.meta.dirname, '..');
const ti = process.argv.indexOf('--tree');
const SRC_TREE = ti > 0 ? path.resolve(process.argv[ti + 1]) : REPO;
const oi = process.argv.indexOf('--only');
const ONLY = oi > 0 ? new Set(process.argv[oi + 1].split(',')) : null;
const want = (id) => !ONLY || ONLY.has(id);

let pass = 0, fail = 0;
const check = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${obs}`); ok ? pass++ : fail++; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feat157-life-'));
const TREE = path.join(TMP, 'tree');
const DATA = path.join(TMP, 'data');
const WORK = path.join(TMP, 'work');
for (const d of [TREE, DATA, WORK]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(WORK, 'hello.ts'), 'export const x = 1;\n');
fs.cpSync(path.join(SRC_TREE, 'src'), path.join(TREE, 'src'), { recursive: true });
fs.copyFileSync(path.join(SRC_TREE, 'package.json'), path.join(TREE, 'package.json'));
fs.cpSync(path.join(SRC_TREE, 'scripts', 'lib'), path.join(TREE, 'scripts', 'lib'), { recursive: true });
if (fs.existsSync(path.join(SRC_TREE, 'scripts', 'base-release.mjs'))) fs.copyFileSync(path.join(SRC_TREE, 'scripts', 'base-release.mjs'), path.join(TREE, 'scripts', 'base-release.mjs'));
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(TREE, 'node_modules'));

const RUN_ID = `${process.pid}${Date.now() % 100000}`;
const SCRATCH_BASE = `claude-station-f157b-${RUN_ID}`;
const SCRATCH_RT = `claude-station-f157r-${RUN_ID}`;
const SEED_DIR = path.join(TMP, 'seedctx');
fs.mkdirSync(SEED_DIR);

const dk = (args, opts = {}) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const dkTry = (args) => { const r = spawnSync('docker', args, { encoding: 'utf8' }); return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }; };

function seedId() {
  const out = dk(['images', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}']);
  const line = out.split('\n').find((l) => /^claude-station-base:u\d+-g\d+-[0-9a-f]{12} /.test(l)) ?? out.split('\n').find((l) => l.startsWith('claude-station-base:'));
  if (!line) throw new Error('no claude-station-base image in the sandbox to seed from (npm run sandbox:docker -- up preloads one)');
  return line.trim().split(/\s+/)[1];
}
const SEED = seedId();
const SEED_REF = `f157seed-${RUN_ID}:seed`;
dk(['tag', SEED, SEED_REF]);
const SEED_CLI = dkTry(['image', 'inspect', SEED, '--format', '{{index .Config.Labels "claude-station.claude-version"}}']).out;
fs.writeFileSync(path.join(SEED_DIR, 'Dockerfile'), `FROM ${SEED_REF}\n`);

const SHIM = path.join(TMP, 'docker-shim');
const BUILD_LOG = path.join(TMP, 'builds.jsonl');
fs.writeFileSync(SHIM, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const MAP = [['claude-station-base', ${JSON.stringify(SCRATCH_BASE)}], ['claude-station-rt', ${JSON.stringify(SCRATCH_RT)}]];
const fwd = (a) => MAP.reduce((s, [r, x]) => s.split(r + ':').join(x + ':').replace(new RegExp('^' + r + '$'), x), a);
let argv = process.argv.slice(2).map(fwd);
if (argv[0] === 'build' && argv.some((a) => a.startsWith(${JSON.stringify(SCRATCH_BASE)} + ':'))) {
  fs.appendFileSync(${JSON.stringify(BUILD_LOG)}, JSON.stringify(argv) + '\\n');
  const keep = ['build'];
  for (let i = 1; i < argv.length; i++) if (argv[i] === '--label' || argv[i] === '-t') { keep.push(argv[i], argv[i + 1]); i++; }
  keep.push('--label', 'f157.build-nonce=' + Math.random().toString(36).slice(2));
  keep.push(${JSON.stringify(SEED_DIR)});
  if (process.env.F157_FAIL_BUILD) { process.stderr.write('synthetic build failure (F157_FAIL_BUILD)\\n'); process.exit(1); }
  argv = keep;
}
const child = spawn('docker', argv, { stdio: ['inherit', 'pipe', 'pipe'] });
const back = (s) => MAP.reduce((t, [r, x]) => t.split(x).join(r), s);
child.stdout.on('data', (d) => process.stdout.write(argv[0] === 'cp' ? d : back(String(d)))); // FEAT-157: docker cp to stdout is a binary tar stream
child.stderr.on('data', (d) => process.stderr.write(back(String(d))));
process.stdout.on('error', () => process.exit(1)); // a closed reader (EPIPE) must end the shim, never hang it
child.on('close', (c) => process.stdout.write('', () => process.exit(c ?? 1))); // flush a piped stdout before exiting
child.on('error', (e) => { process.stderr.write(String(e.message)); process.exit(127); });
`);
fs.chmodSync(SHIM, 0o755);
process.env.CLAUDE_STATION_DOCKER = SHIM;
process.env.CLAUDE_STATION_DATA = DATA;
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true }); // pre-made: a raw `docker create` in L8 would otherwise make it root-owned
fs.writeFileSync(path.join(HOME, '.claude', '.credentials.json'), '{}\n');
process.env.HOME = HOME;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.ORCHARD_DISPATCH_SOCK;

/** A stand-in CLI for a version: `--version`, and a stream-json handshake (system/init). */
function fakeCli(version) {
  const f = path.join(TMP, `cli-${version}`);
  fs.writeFileSync(f, `#!/bin/sh\nV=${version}\ncase "$1" in --version) echo "$V (Claude Code)"; exit 0;; esac\necho '{"type":"system","subtype":"init","claude_code_version":"'"$V"'"}'\ncat >/dev/null\n`);
  fs.chmodSync(f, 0o755);
  return f;
}
const useCli = (version) => { process.env.ORCHARD_TEST_CONTAINER_CLI = fakeCli(version); process.env.ORCHARD_TEST_CONTAINER_CLI_VERSION = version; };
const realCli = () => { delete process.env.ORCHARD_TEST_CONTAINER_CLI; delete process.env.ORCHARD_TEST_CONTAINER_CLI_VERSION; };

const CAT = path.join(TREE, 'src', 'server', 'container', 'base-releases.json');
const TREE_DEF = path.join(TREE, 'src', 'server', 'container', 'provision.json');
const bumpTree = (why) => {
  const mj = JSON.parse(fs.readFileSync(TREE_DEF, 'utf8'));
  mj.__feat157_probe = `${why} ${crypto.randomUUID()}`;
  fs.writeFileSync(TREE_DEF, JSON.stringify(mj, null, 2) + '\n');
};
/** Cut a release in the TREE copy with the product's own script (append-only). */
function cutRelease(cls, verify = []) {
  const r = spawnSync(process.execPath, [path.join(TREE, 'scripts', 'base-release.mjs'), `--class=${cls}`, `--summary=synthetic ${cls} release for the suite`, `--adjust=synthetic adjust text`, ...verify.map((v) => `--verify=${v}`)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`base:release failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout).entry.version;
}

const createdContainers = [];
function cleanup() {
  for (const n of createdContainers) dkTry(['rm', '-f', '-v', n]);
  dkTry(['rmi', SEED_REF]);
  for (const repo of [SCRATCH_BASE, SCRATCH_RT, `f157cust-${RUN_ID}`]) {
    const out = dkTry(['images', repo, '--format', '{{.Repository}}:{{.Tag}}']).out;
    for (const ref of out.split('\n').filter((r) => r && !r.endsWith(':<none>'))) dkTry(['rmi', ref]);
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

const importFresh = async (rel) => import(path.join(TREE, rel) + `?v=${crypto.randomUUID()}`);
const cid = (name) => dkTry(['inspect', name, '--format', '{{.Id}}']).out || null;
const running = (name) => dkTry(['inspect', name, '--format', '{{.State.Running}}']).out === 'true';
const imgOf = (name) => dkTry(['inspect', name, '--format', '{{.Config.Image}}']).out;
const labelOfContainerImage = (name, label) => {
  const iid = dkTry(['inspect', name, '--format', '{{.Image}}']).out;
  return dkTry(['image', 'inspect', iid, '--format', `{{index .Config.Labels "${label}"}}`]).out.replace('<no value>', '');
};
const inSha = (name) => (dkTry(['exec', name, 'sha256sum', '/home/claude/.local/bin/claude']).out.split(/\s+/)[0] ?? '');
const execCliVersion = (name) => dkTry(['exec', name, '/home/claude/.local/bin/claude', '--version']).out;
const layersOf = (ref) => { try { return JSON.parse(dk(['image', 'inspect', ref, '--format', '{{json .RootFS.Layers}}'])); } catch { return []; } };
const q = (e) => (e ? `${e.code ?? ''} ${String(e.message).split('\n')[0].slice(0, 140)}` : 'none');

const project = (id, base, extra = {}) => ({
  id, name: `FEAT-157 ${id}`, hostPath: WORK, isolation: 'container',
  settings: { tools: { serena: false, playwright: false }, browser: { enabled: false }, mounts: [], container: { gpu: 'off', ...(base === undefined ? {} : { base }), ...extra } },
  createdAt: new Date().toISOString(),
});
const pin = (p, extra = {}) => ({ pinned: p, skipped: [], deferred: null, ...extra });
/*
 * ARCH-022: "another session is live" is a LEASE the lifecycle authority holds (granted by an admit operation),
 * never a flag passed in. `live` = a session admitted BEFORE this launch holds the project (granted here by a real
 * admit operation, without an ensure — the session predates the change under test); `!live` = no session holds it
 * (any such lease is drained and proven released first). On a pre-ARCH-022 tree the old flag stands in.
 */
const { bootAuthority } = await import('./lib/lifecycle-harness.mjs');
const H = await bootAuthority(TREE);
const holders = new Map();
const hold = async (p) => {
  if (!H.lc || holders.has(p.id)) return;
  const t = H.lc.newExecTag('hold');
  await H.lc.runOp(p.id, 'admit', async (op) => { H.lc.grantLease(op, t); });
  H.lc.attachLease(t, 'held-by-the-suite');
  holders.set(p.id, t);
};
const releaseHold = async (p) => {
  const t = H.lc ? holders.get(p.id) : null;
  if (!t) return;
  holders.delete(p.id);
  H.lc.drainLease(t);
  for (let i = 0; i < 60 && H.lc.leasesOf(p.id).length; i++) await new Promise((r) => setTimeout(r, 250));
};
const ensure = async (cm, p, live, extra = {}) => { if (live) await hold(p); else await releaseHold(p); try { await cm.ensureContainer(p, { deferImageSwap: () => live, onLog: (l) => { if (process.env.F157_VERBOSE) process.stdout.write(`      | ${l}`); }, ...extra }); return null; } catch (e) { return e; } };

console.log(`FEAT-157 lifecycle\n  tree under test: ${SRC_TREE}\n  scratch repos: ${SCRATCH_BASE}, ${SCRATCH_RT}\n  seed: ${SEED.slice(7, 19)} (legacy CLI label ${SEED_CLI || 'none'})\n`);

let exitCode = 0;
try {
  useCli('9.0.1');
  let cm = await importFresh('src/server/container-manager.ts');
  const hasPins = typeof cm.baseTargetOf === 'function';
  const br = hasPins ? await importFresh('src/server/base-releases.ts') : null;
  const noticeFor = (p, c) => {
    if (!br) return null;
    return br.noticeFor({ projectId: p.id, imageSource: c.imageSourceOf(p), pinRaw: c.basePinRawOf(p), observed: c.observedBaseFor(p), lastError: c.baseApplyErrorOf(p), now: new Date(), catalog: br.readCatalog() });
  };

  /* ================================================ (a) pinned never moves */
  const pA = project(`f157a-${RUN_ID}`, pin(1));
  const nA = cm.containerName(pA.id);
  createdContainers.push(nA);
  if (want('L1') || want('L2') || want('L3') || want('L4') || want('L5')) {
    console.log('--- (a) a pinned project never changes base silently');
    const e0 = await ensure(cm, pA, false);
    const id0 = cid(nA);
    check('L0 a v1-pinned station project starts: container on the v1 base with the host CLI as a layer',
      !e0 && running(nA) && labelOfContainerImage(nA, 'claude-station.base-ref').startsWith('v1-') && execCliVersion(nA).startsWith('9.0.1'),
      `err=${q(e0)} image=${imgOf(nA)} base-ref=${labelOfContainerImage(nA, 'claude-station.base-ref')} cli=${execCliVersion(nA)}`);

    // (1a) an UNRELEASED working-tree change.
    bumpTree('L1');
    cm = await importFresh('src/server/container-manager.ts');
    const e1 = await ensure(cm, pA, false);
    const n1 = noticeFor(pA, cm);
    check('L1 (1a) an unreleased base-definition change: the pinned container is NOT recreated, and there is NO notice',
      !e1 && cid(nA) === id0 && running(nA) && n1 === null, `err=${q(e1)} id ${id0?.slice(7, 19)} -> ${cid(nA)?.slice(7, 19)} notice=${n1 ? n1.state : 'none'}`);

    // (1b) the change is CUT as release v2.
    let v2 = null;
    try { v2 = cutRelease('feature'); } catch (e) { check('L2 cut release v2 with the product script', false, q(e)); }
    cm = await importFresh('src/server/container-manager.ts');
    const e2 = await ensure(cm, pA, false);
    const n2 = noticeFor(pA, cm);
    check('L2 (1b) a cut release v2: the v1-pinned container is still NOT recreated, and a v2 OFFER notice exists',
      v2 === 2 && !e2 && cid(nA) === id0 && n2?.state === 'offer' && n2.to === 2, `v2=${v2} err=${q(e2)} id ${id0?.slice(7, 19)} -> ${cid(nA)?.slice(7, 19)} notice=${n2?.state} to=${n2?.to}`);

    // Adopt v2 (the desired pin) with a live session: waits; without one: applies.
    const pA2 = project(pA.id, pin(2));
    const e3 = await ensure(cm, pA2, true);
    const n3 = noticeFor(pA2, cm);
    check('L3 adopt v2 with a LIVE session: the container is kept (no recreate); the notice reads adopted, pending',
      !e3 && cid(nA) === id0 && running(nA) && n3?.state === 'adopted-pending' && n3.observed === 'v1', `err=${q(e3)} id ${id0?.slice(7, 19)} -> ${cid(nA)?.slice(7, 19)} notice=${n3?.state} observed=${n3?.observed}`);
    const e3b = await ensure(cm, pA2, false);
    const n3b = noticeFor(pA2, cm);
    const argvs = fs.existsSync(BUILD_LOG) ? fs.readFileSync(BUILD_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    const v2build = argvs.find((a) => a.some((x) => x.includes('/releases/v2/Dockerfile')));
    check('L3b adopt v2, next launch with NO live session: recreated on v2, built from the frozen releases/v2 snapshot; the notice clears',
      !e3b && cid(nA) !== id0 && running(nA) && labelOfContainerImage(nA, 'claude-station.base-ref').startsWith('v2-') && !!v2build && n3b === null,
      `err=${q(e3b)} base-ref=${labelOfContainerImage(nA, 'claude-station.base-ref')} v2 recipe=${v2build ? v2build[v2build.indexOf('-f') + 1] : 'none'} notice=${n3b?.state ?? 'none'}`);
    Object.assign(pA.settings.container, { base: pin(2) });
  }

  /* ============================================== (d) the CLI stays matched */
  if (want('L4')) {
    console.log('--- (d) the CLI stays matched to the host under a pin');
    const idBefore = cid(nA);
    const baseImg = cm.baseRefFor(pA);
    const rtBefore = imgOf(nA);
    useCli('9.0.2');
    cm = await importFresh('src/server/container-manager.ts');
    const e4 = await ensure(cm, pA, true);
    check('L4 a CLI change with a LIVE session: the NEW launch is refused (cli-mismatch-live), nothing is recreated',
      e4?.code === 'cli-mismatch-live' && cid(nA) === idBefore && running(nA) && execCliVersion(nA).startsWith('9.0.1'),
      `err=${q(e4)} id ${idBefore?.slice(7, 19)} -> ${cid(nA)?.slice(7, 19)} cli=${execCliVersion(nA)}`);
    const e4b = await ensure(cm, pA, false);
    const rtAfter = imgOf(nA);
    const baseL = layersOf(baseImg.replace('claude-station-base', SCRATCH_BASE));
    const rtL = layersOf(rtAfter.replace('claude-station-rt', SCRATCH_RT));
    check('L4b with nobody live: recreated with CLI 9.0.2; the base is unchanged (same v2 base) and its layers are a byte-identical prefix of the new image',
      !e4b && cid(nA) !== idBefore && execCliVersion(nA).startsWith('9.0.2') && labelOfContainerImage(nA, 'claude-station.base-ref').startsWith('v2-') &&
      rtAfter !== rtBefore && baseL.length > 0 && rtL.length === baseL.length + 1 && baseL.every((l, i) => rtL[i] === l),
      `err=${q(e4b)} cli=${execCliVersion(nA)} base ${baseL.length} layers, image ${rtL.length} layers, prefix=${baseL.every((l, i) => rtL[i] === l)} rt ${rtBefore} -> ${rtAfter}`);
    {
      const cfg = (ref) => { try { const c = JSON.parse(dk(['image', 'inspect', ref, '--format', '{{json .Config}}'])); return JSON.stringify([c.Entrypoint ?? [], c.Cmd ?? [], c.User ?? '', c.Env ?? [], c.WorkingDir ?? '', c.Shell ?? null, c.StopSignal ?? null]); } catch (e) { return `ERR ${e.message}`; } };
      const a = cfg(baseImg.replace('claude-station-base', SCRATCH_BASE)), b = cfg(rtAfter.replace('claude-station-rt', SCRATCH_RT));
      check('L4e the layer keeps the parent image\'s ENTRYPOINT, CMD, USER, ENV, WORKDIR, SHELL and STOPSIGNAL exactly', a === b && !a.startsWith('ERR'), `base=${a.slice(0, 160)}\n                  layer=${b.slice(0, 160)}`);
    }
    const cliLbl = labelOfContainerImage(nA, 'claude-station.cli-version');
    check('L4c the layer records the CLI version and sha256, and a handshake is what admitted it', cliLbl === '9.0.2' && /^[0-9a-f]{64}$/.test(labelOfContainerImage(nA, 'claude-station.cli-sha256')),
      `cli-version=${cliLbl} sha=${labelOfContainerImage(nA, 'claude-station.cli-sha256').slice(0, 12)}`);
    // A CLI whose handshake reports a different version is refused before it is ever tagged.
    const liar = path.join(TMP, 'cli-liar');
    fs.writeFileSync(liar, `#!/bin/sh\necho '{"type":"system","subtype":"init","claude_code_version":"1.0.0"}'\ncat >/dev/null\n`);
    fs.chmodSync(liar, 0o755);
    process.env.ORCHARD_TEST_CONTAINER_CLI = liar; process.env.ORCHARD_TEST_CONTAINER_CLI_VERSION = '9.0.3';
    cm = await importFresh('src/server/container-manager.ts');
    const idL = cid(nA);
    const e4d = await ensure(cm, pA, false);
    check('L4d a CLI whose handshake reports another version is rejected (runtime-rejected) and the running container is untouched',
      e4d?.code === 'runtime-rejected' && cid(nA) === idL && running(nA), `err=${q(e4d)}`);
    useCli('9.0.2');
    cm = await importFresh('src/server/container-manager.ts');
  }

  /* ========================================= (b) security, never under live */
  if (want('L5')) {
    console.log('--- (b) a security release is applied at the next idle launch, never under a live session');
    const catBeforeSecurity = fs.readFileSync(CAT, 'utf8');
    const idS = cid(nA);
    let v3 = null;
    try { v3 = cutRelease('security', ['bash:5.0']); } catch (e) { check('L5 cut security release', false, q(e)); }
    cm = await importFresh('src/server/container-manager.ts');
    const n5 = noticeFor(pA, cm);
    const e5 = await ensure(cm, pA, true);
    const argvs = fs.readFileSync(BUILD_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const secBuild = argvs.find((a) => a.some((x) => x.includes('/releases/v3/Dockerfile')));
    check('L5 security v3 due, LIVE session: built (with --no-cache --pull, package proof passed) but the container is NOT recreated',
      v3 === 3 && n5?.state === 'security-pending' && !n5.actions.includes('skip') && !e5 && cid(nA) === idS && running(nA) && !!secBuild && secBuild.includes('--no-cache') && secBuild.includes('--pull'),
      `v3=${v3} notice=${n5?.state} actions=${n5?.actions} err=${q(e5)} id ${idS?.slice(7, 19)} -> ${cid(nA)?.slice(7, 19)} flags=${secBuild ? ['--no-cache', '--pull'].filter((f) => secBuild.includes(f)).join(' ') : 'no build'}`);
    const e5b = await ensure(cm, pA, false);
    const n5b = noticeFor(pA, cm);
    check('L5b security v3, next launch with NO live session: applied automatically (observed v3) though the pin says v2; the notice clears',
      !e5b && cid(nA) !== idS && labelOfContainerImage(nA, 'claude-station.base-ref').startsWith('v3-') && pA.settings.container.base.pinned === 2 && n5b === null,
      `err=${q(e5b)} base-ref=${labelOfContainerImage(nA, 'claude-station.base-ref')} pin=${pA.settings.container.base.pinned} notice=${n5b?.state ?? 'none'}`);

    // A security release whose package proof fails: new launches refused, the live container untouched.
    const idF = cid(nA);
    let v4 = null;
    try { v4 = cutRelease('security', ['bash:99.0']); } catch (e) { check('L5c cut failing security release', false, q(e)); }
    cm = await importFresh('src/server/container-manager.ts');
    const e5c = await ensure(cm, pA, true);
    const n5c = noticeFor(pA, cm);
    check('L5c a security build that cannot prove its package moved: the launch is REFUSED (security-update-failed), the live container keeps running, the card says so',
      v4 === 4 && e5c?.code === 'security-update-failed' && cid(nA) === idF && running(nA) && n5c?.state === 'apply-failed' && /refused/.test(n5c.message),
      `v4=${v4} err=${q(e5c)} id ${idF?.slice(7, 19)} -> ${cid(nA)?.slice(7, 19)} notice=${n5c?.state}`);
    const e5d = await ensure(cm, pA, false);
    check('L5d …and with nobody live it is still refused, never "applied" by falling back to the vulnerable base', e5d?.code === 'security-update-failed' && cid(nA) === idF,
      `err=${q(e5d)} id ${idF?.slice(7, 19)} -> ${cid(nA)?.slice(7, 19)}`);
    // Fixture reset (the suite's TREE copy only): the later sections need a catalog with no security
    // release, or every pin below it is (correctly) raised to it. Real catalogs are never edited.
    fs.writeFileSync(CAT, catBeforeSecurity);
    for (const v of [3, 4]) fs.rmSync(path.join(TREE, 'src', 'server', 'container', 'releases', `v${v}`), { recursive: true, force: true });
    cm = await importFresh('src/server/container-manager.ts');
  }

  /* =============================================== image / snapshot missing */
  if (want('L6')) {
    console.log('--- pinned image missing / snapshot missing');
    const p6 = project(`f157m-${RUN_ID}`, pin(1));
    const n6 = cm.containerName(p6.id);
    createdContainers.push(n6);
    // Make sure v1 exists, then remove it (by name, scratch repo only).
    await ensure(cm, p6, false);
    const v1ref = cm.baseRefFor(p6).replace('claude-station-base', SCRATCH_BASE);
    dkTry(['rm', '-f', n6]);
    const firstId = dkTry(['image', 'inspect', v1ref, '--format', '{{.Id}}']).out;
    const rmi = dkTry(['rmi', v1ref]);
    const before = fs.existsSync(BUILD_LOG) ? fs.readFileSync(BUILD_LOG, 'utf8').split('\n').length : 0;
    cm = await importFresh('src/server/container-manager.ts');
    const e6 = await ensure(cm, p6, false);
    const after = fs.readFileSync(BUILD_LOG, 'utf8').trim().split('\n').slice(before - 1).map((l) => JSON.parse(l));
    const rebuilt = after.find((a) => a.some((x) => x.includes('/releases/v1/Dockerfile')));
    const art = JSON.parse(fs.readFileSync(path.join(DATA, 'base-artifacts.json'), 'utf8'))[cm.baseRefFor(p6)];
    const nowId = dkTry(['image', 'inspect', v1ref, '--format', '{{.Id}}']).out;
    check('L6 the pinned v1 image removed: rebuilt from releases/v1, recorded as a rebuild (same recipe, not same bytes), still v1',
      rmi.code === 0 && !e6 && !!rebuilt && labelOfContainerImage(n6, 'claude-station.base-ref').startsWith('v1-') && !!art && art.rebuilds.length >= 1 &&
      art.rebuilds.at(-1).id === nowId && nowId !== firstId && art.firstId !== nowId,
      `rmi=${rmi.code} err=${q(e6)} recipe=${rebuilt ? rebuilt[rebuilt.indexOf('-f') + 1] : 'none'} removed ${firstId.slice(7, 19)} now ${nowId.slice(7, 19)} first-ever ${art?.firstId?.slice(7, 19)} rebuilds=${art?.rebuilds?.length}`);
    // …and with the snapshot ALSO gone: an honest error, never a move to the newest.
    dkTry(['rm', '-f', n6]);
    dkTry(['rmi', v1ref]);
    const snap = path.join(TREE, 'src', 'server', 'container', 'releases', 'v1');
    fs.renameSync(snap, `${snap}.gone`);
    cm = await importFresh('src/server/container-manager.ts');
    const e6b = await ensure(cm, p6, false);
    fs.renameSync(`${snap}.gone`, snap);
    check('L6b pinned image AND snapshot gone: refused with base-snapshot-missing; no container was created on another base',
      e6b?.code === 'base-snapshot-missing' && !cid(n6), `err=${q(e6b)} container=${cid(n6) ? 'CREATED' : 'none'}`);
  }

  /* ================================================================ recovery */
  if (want('L7')) {
    console.log('--- recovery: an unusable pin never adopts');
    const p7 = project(`f157r-${RUN_ID}`, pin(1));
    const n7 = cm.containerName(p7.id);
    createdContainers.push(n7);
    await ensure(cm, p7, false);
    const id7 = cid(n7);
    const img7 = imgOf(n7);
    const bad = project(p7.id, { pinned: 'latest' });
    const e7 = await ensure(cm, bad, false);
    check('L7 an unreadable pin with a container: the launch proceeds into the SAME container (no rebuild, no recreate)',
      !e7 && cid(n7) === id7 && imgOf(n7) === img7 && running(n7), `err=${q(e7)} id ${id7?.slice(7, 19)} -> ${cid(n7)?.slice(7, 19)}`);
    dkTry(['rm', '-f', n7]);
    const e7b = await ensure(cm, bad, false);
    check('L7b an unreadable pin and no container: refused (base-pin-invalid), nothing created', e7b?.code === 'base-pin-invalid' && !cid(n7), `err=${q(e7b)}`);
  }

  /* ======================================================= legacy containers */
  if (want('L8')) {
    console.log('--- legacy: a container on a pre-release base keeps running as is');
    const uid = os.userInfo().uid, gid = os.userInfo().gid;
    const legacyTag = `u${uid}-g${gid}-${crypto.randomBytes(6).toString('hex')}`;
    dk(['tag', SEED, `${SCRATCH_BASE}:${legacyTag}`]);
    // "Matches the host" is decided by BYTES: the real host CLI is the same build as the legacy seed's baked one.
    realCli();
    cm = await importFresh('src/server/container-manager.ts');
    const p8 = project(`f157l-${RUN_ID}`, undefined);
    const n8 = cm.containerName(p8.id);
    createdContainers.push(n8);
    // A pre-FEAT-157 container: created on the legacy tag by the product's own create argv.
    const argv = cm.createArgs(p8, n8, `claude-station-base:${legacyTag}`, {});
    dk(argv.map((a) => a.replace('claude-station-base:', `${SCRATCH_BASE}:`)));
    dk(['start', n8]);
    const id8 = cid(n8);
    const mig = cm.migrationPinFor(p8);
    const p8p = project(p8.id, mig ?? undefined);
    const e8 = await ensure(cm, p8p, false);
    check('L8 a legacy container whose baked CLI matches the host: migration pins legacy:<its tag>; the next launch does NOT recreate it',
      mig?.pinned === `legacy:${legacyTag}` && !e8 && cid(n8) === id8 && running(n8), `pin=${JSON.stringify(mig)} err=${q(e8)} id ${id8?.slice(7, 19)} -> ${cid(n8)?.slice(7, 19)}`);
    const n8n = noticeFor(p8p, cm);
    check('L8b the legacy project is OFFERED the newest release (never moved to it)', n8n?.state === 'offer' && n8n.pinned.startsWith('legacy'), `notice=${n8n?.state} pinned=${n8n?.pinned} to=${n8n?.to}`);
    useCli('9.0.2');
    cm = await importFresh('src/server/container-manager.ts');
    const e8c = await ensure(cm, p8p, true);
    const e8d = await ensure(cm, p8p, false);
    check('L8c a host CLI change: refused under a live session; at an idle launch the SAME legacy base gets the CLI layer (base unchanged)',
      e8c?.code === 'cli-mismatch-live' && !e8d && cid(n8) !== id8 && execCliVersion(n8).startsWith('9.0.2') && labelOfContainerImage(n8, 'claude-station.base-ref') === legacyTag,
      `live=${q(e8c)} idle=${q(e8d)} cli=${execCliVersion(n8)} base-ref=${labelOfContainerImage(n8, 'claude-station.base-ref')}`);
  }

  /* ================================================================== GC */
  if (want('L9')) {
    console.log('--- GC keeps what a pin references');
    const sweep = await H.op('#images', () => cm.pruneSupersededImages(new Set()));
    const v1 = `claude-station-base:v1-u${os.userInfo().uid}-g${os.userInfo().gid}`;
    // With an empty keep set every unused own base goes; now check the keep-set the product computes itself
    // keeps a pinned version when a registered project pins it (register one in the scratch registry).
    const reg = await importFresh('src/server/registry.ts');
    let regOk = true;
    try { reg.createProject({ hostPath: WORK, name: 'gc-pin', isolation: 'container' }); } catch (e) { regOk = false; console.log(`      (registry: ${q(e)})`); }
    const gcP = reg.listProjects().find((x) => x.name === 'gc-pin');
    try { reg.updateProject(gcP.id, { settings: { container: { base: pin(1), gpu: 'off' } } }); } catch { regOk = false; }
    await ensure(cm, { ...gcP, settings: { ...gcP.settings, container: { ...gcP.settings.container, base: pin(1), gpu: 'off' }, tools: { serena: false, playwright: false }, browser: { enabled: false } } }, false);
    createdContainers.push(cm.containerName(gcP.id));
    dkTry(['rm', '-f', cm.containerName(gcP.id)]); // not in use by a container: only the PIN references it now
    const keep = await H.op('#images', () => cm.pruneSupersededImages(cm.__imageKeepSetForTests ? cm.__imageKeepSetForTests() : new Set()));
    const v1ref = cm.baseRefFor({ ...gcP, settings: { ...gcP.settings, container: { base: pin(1) } } });
    const v1there = dkTry(['image', 'inspect', v1ref.replace('claude-station-base', SCRATCH_BASE), '--format', '{{.Id}}']).code === 0;
    check('L9 a prune keeps a base that only a registered project\'s PIN references (no container uses it)', regOk && v1there && !keep.removed.includes(v1ref),
      `registry=${regOk} v1 present=${v1there} removed=${JSON.stringify(keep.removed)} (first sweep removed ${sweep.removed.length})`);
  }

  /* =========================================== attack round 1 regressions (a) */
  if (want('L11')) {
    console.log('--- release identity is version + recipe (attack round 1, property a)');
    // Another checkout froze a DIFFERENT recipe as "v1": simulate its image under our v1 tag name, labelled with its recipe.
    const p11 = project(`f157i-${RUN_ID}`, pin(1));
    const n11 = cm.containerName(p11.id);
    createdContainers.push(n11);
    const ref = cm.baseRefFor(p11);
    const scratchRef = ref.replace('claude-station-base', SCRATCH_BASE);
    const hashInTag = /-([0-9a-f]{12})$/.exec(ref)?.[1];
    const cat = JSON.parse(fs.readFileSync(CAT, 'utf8'));
    dkTry(['rmi', scratchRef]);
    const c = dk(['create', SEED, 'true']);
    try { dk(['commit', '--change', 'LABEL claude-station.base-version=1', '--change', 'LABEL claude-station.provision-hash=0123456789ab', '--change', 'LABEL claude-station.owner=someone-else', c, scratchRef]); } finally { dkTry(['rm', '-f', c]); }
    const e11 = await ensure(cm, p11, false);
    check('L11 the base tag carries the release recipe hash, and an image under it with another recipe is refused (base-image-mismatch), never run',
      hashInTag === cat.releases[0].hash && e11?.code === 'base-image-mismatch' && !cid(n11), `tag=${ref} err=${q(e11)} container=${cid(n11) ? 'CREATED' : 'none'}`);
    dkTry(['rmi', scratchRef]);
    // Unreadable catalog + an edited snapshot + the image missing: never built, never run.
    const catRaw = fs.readFileSync(CAT, 'utf8');
    const snapDf = path.join(TREE, 'src', 'server', 'container', 'releases', 'v1', 'Dockerfile');
    const dfRaw = fs.readFileSync(snapDf, 'utf8');
    fs.writeFileSync(CAT, catRaw.slice(0, 120));
    fs.writeFileSync(snapDf, `${dfRaw}\n# tampered\n`);
    const builds0 = fs.existsSync(BUILD_LOG) ? fs.readFileSync(BUILD_LOG, 'utf8').split('\n').length : 0;
    cm = await importFresh('src/server/container-manager.ts');
    const e11b = await ensure(cm, p11, false);
    const builds1 = fs.existsSync(BUILD_LOG) ? fs.readFileSync(BUILD_LOG, 'utf8').split('\n').length : 0;
    fs.writeFileSync(CAT, catRaw); fs.writeFileSync(snapDf, dfRaw);
    cm = await importFresh('src/server/container-manager.ts');
    check('L11b an unreadable catalog with an edited snapshot: nothing is built or run (recovery, base-pin-invalid)', e11b?.code === 'base-pin-invalid' && builds1 === builds0 && !cid(n11),
      `err=${q(e11b)} builds ${builds0}->${builds1}`);
  }

  if (want('L12')) {
    console.log('--- security outranks recovery, and a security image is proven where it is used (attack round 1, property b)');
    const catRaw = fs.readFileSync(CAT, 'utf8');
    const p12 = project(`f157s-${RUN_ID}`, pin(1));
    const n12 = cm.containerName(p12.id);
    createdContainers.push(n12);
    await ensure(cm, p12, false);
    const id12 = cid(n12);
    let vS = null;
    try { vS = cutRelease('security', ['bash:99.0']); } catch (e) { check('L12 cut', false, q(e)); }
    cm = await importFresh('src/server/container-manager.ts');
    // Plant an image under the security release's exact tag with matching version + recipe labels (another
    // "instance's"), built WITHOUT the package proof: it must still be proven here, and fails.
    const secRef = cm.baseRefFor(p12).replace('claude-station-base', SCRATCH_BASE);
    const relHash = JSON.parse(fs.readFileSync(CAT, 'utf8')).releases.at(-1).hash;
    const c = dk(['create', SEED, 'true']);
    try { dk(['commit', '--change', `LABEL claude-station.base-version=${vS}`, '--change', `LABEL claude-station.provision-hash=${relHash}`, c, secRef]); } finally { dkTry(['rm', '-f', c]); }
    const lost = project(p12.id, undefined);            // the pin is gone (e.g. a registry backup restored)
    const e12 = await ensure(cm, lost, false);
    check('L12 a LOST pin with a security release due is not "recovery" into the old container: it targets the floor, and a planted floor image that cannot prove its packages is refused',
      e12?.code === 'security-update-failed' && cid(n12) === id12 && running(n12), `release=v${vS} target=${JSON.stringify(cm.baseTargetOf(lost))} err=${q(e12)} id ${id12?.slice(7, 19)} -> ${cid(n12)?.slice(7, 19)}`);
    dkTry(['rmi', secRef]);
    fs.writeFileSync(CAT, catRaw);
    fs.rmSync(path.join(TREE, 'src', 'server', 'container', 'releases', `v${vS}`), { recursive: true, force: true });
    cm = await importFresh('src/server/container-manager.ts');
  }

  if (want('L13')) {
    console.log('--- the CLI inside a running container is checked by its bytes at every launch (attack round 1, property d)');
    useCli('9.0.5');
    cm = await importFresh('src/server/container-manager.ts');
    const p13 = project(`f157c-${RUN_ID}`, pin(1));
    const n13 = cm.containerName(p13.id);
    createdContainers.push(n13);
    await ensure(cm, p13, false);
    const id13 = cid(n13);
    // The session user replaces the CLI from inside (it owns ~/.local/bin): rm + write, as `claude update` would.
    const rep = dkTry(['exec', n13, 'sh', '-c', 'rm -f /home/claude/.local/bin/claude && printf "#!/bin/sh\necho 0.0.7 \\(Claude Code\\)\n" > /home/claude/.local/bin/claude && chmod +x /home/claude/.local/bin/claude && echo replaced']);
    const eLive = await ensure(cm, p13, true);
    check('L13 a CLI replaced inside the running container: a new launch under a live session is REFUSED (cli-mismatch-live), nothing recreated',
      rep.out === 'replaced' && eLive?.code === 'cli-mismatch-live' && cid(n13) === id13, `replace=${rep.out || rep.err} err=${q(eLive)}`);
    const eIdle = await ensure(cm, p13, false);
    check('L13b …and the next idle launch recreates it from the image, with the host\'s CLI again', !eIdle && cid(n13) !== id13 && execCliVersion(n13).startsWith('9.0.5'),
      `err=${q(eIdle)} cli=${execCliVersion(n13)}`);
    // (round 2, d) a lying sha256sum/stat planted first on PATH, plus a replaced CLI; then the container is STOPPED.
    const id13b = cid(n13);
    const plant = dkTry(['exec', n13, 'sh', '-c', `printf '#!/bin/sh\\necho %s  "$1"\\n' $(sha256sum /home/claude/.local/bin/claude | cut -d' ' -f1) > /home/claude/.local/bin/sha256sum && chmod +x /home/claude/.local/bin/sha256sum && rm -f /home/claude/.local/bin/claude && printf '#!/bin/sh\\necho 0.0.8\\n' > /home/claude/.local/bin/claude && chmod +x /home/claude/.local/bin/claude && echo planted`]);
    const eLive2 = await ensure(cm, p13, true);
    await releaseHold(p13); await cm.stopContainer(p13, { liveNow: () => false });
    const eStopped = await ensure(cm, p13, false);
    // (round 3, d) the session replaces a PARENT directory of the CLI with a symlink to its own tree.
    const idSw = cid(n13);
    const swap = dkTry(['exec', n13, 'sh', '-c', 'mkdir -p /tmp/y/bin && printf "#!/bin/sh\\necho 0.0.9\\n" > /tmp/y/bin/claude && chmod +x /tmp/y/bin/claude && mv /home/claude/.local /home/claude/.local.o && ln -s /tmp/y /home/claude/.local && echo swapped']);
    const eSw = await ensure(cm, p13, true);
    check('L13d a parent directory of the CLI swapped for a symlink (the file itself untouched) is still caught: live launch refused',
      swap.out === 'swapped' && eSw?.code === 'cli-mismatch-live' && cid(n13) === idSw, `swap=${swap.out || swap.err.slice(0, 80)} live=${q(eSw)}`);
    await ensure(cm, p13, false);
    check('L13c a lying sha256sum planted on the session PATH does not hide a replaced CLI (live launch refused), and a STOPPED container with a replaced CLI is recreated, not restarted',
      plant.out === 'planted' && eLive2?.code === 'cli-mismatch-live' && !eStopped && cid(n13) !== id13b && execCliVersion(n13).startsWith('9.0.5'),
      `plant=${plant.out || plant.err.slice(0, 80)} live=${q(eLive2)} stopped=${q(eStopped)} cli=${execCliVersion(n13)}`);
  }

  if (want('L14')) {
    console.log('--- an image cannot vouch for its own CLI (round 2, property d)');
    useCli('9.0.6');
    cm = await importFresh('src/server/container-manager.ts');
    const uid = os.userInfo().uid, gid = os.userInfo().gid;
    const tag = `u${uid}-g${gid}-${crypto.randomBytes(6).toString('hex')}`;
    const hostSha = crypto.createHash('sha256').update(fs.readFileSync(process.env.ORCHARD_TEST_CONTAINER_CLI)).digest('hex');
    // A parent whose own tools lie: /usr/local/bin/sha256sum prints the host's sha; its claude is not the host's.
    const c = dk(['create', '--user', '0:0', '--entrypoint', 'sh', SEED, '-c', `printf '#!/bin/sh\\necho ${hostSha}  "$1"\\n' > /usr/local/bin/sha256sum && chmod +x /usr/local/bin/sha256sum`]);
    try { dk(['start', '-a', c]); dk(['commit', '--change', 'ENTRYPOINT []', '--change', 'CMD ["sleep","infinity"]', c, `${SCRATCH_BASE}:${tag}`]); } finally { dkTry(['rm', '-f', c]); }
    const p14 = project(`f157y-${RUN_ID}`, pin(`legacy:${tag}`));
    const n14 = cm.containerName(p14.id);
    createdContainers.push(n14);
    const e14 = await ensure(cm, p14, false);
    check('L14 a parent whose own sha256sum lies about its CLI still gets the host CLI layer (bytes are read by the daemon, hashed on the host)',
      !e14 && execCliVersion(n14).startsWith('9.0.6') && inSha(n14) === hostSha, `err=${q(e14)} image=${imgOf(n14)} cli=${execCliVersion(n14)}`);
  }

  if (want('L15')) {
    console.log('--- a legacy base is the bytes the container runs, not whatever its tag points at now (round 3, a)');
    realCli();
    cm = await importFresh('src/server/container-manager.ts');
    const uid = os.userInfo().uid, gid = os.userInfo().gid;
    const tag = `u${uid}-g${gid}-${crypto.randomBytes(6).toString('hex')}`;
    dk(['tag', SEED, `${SCRATCH_BASE}:${tag}`]);
    const p15 = project(`f157t-${RUN_ID}`, pin(`legacy:${tag}`));
    const n15 = cm.containerName(p15.id);
    createdContainers.push(n15);
    dk(cm.createArgs(p15, n15, `claude-station-base:${tag}`, {}).map((a) => a.replace('claude-station-base:', `${SCRATCH_BASE}:`)));
    dk(['start', n15]);
    const id15 = cid(n15);
    // Old code "rebuilt the tag in place": the tag now names other bytes.
    const c = dk(['create', SEED, 'true']);
    try { dk(['commit', '--change', `LABEL f157.moved=${RUN_ID}`, c, `${SCRATCH_BASE}:${tag}`]); } finally { dkTry(['rm', '-f', c]); }
    const e15 = await ensure(cm, p15, false);
    dkTry(['rmi', `${SCRATCH_BASE}:${tag}`]);
    const e15b = await ensure(cm, p15, false);
    check('L15 a legacy tag moved to other bytes (old in-place rebuild) does not move the container; with the tag gone the container still launches as is',
      !e15 && !e15b && cid(n15) === id15 && running(n15), `moved: err=${q(e15)} | tag gone: err=${q(e15b)} | id ${id15?.slice(7, 19)} -> ${cid(n15)?.slice(7, 19)}`);
  }

  if (want('L16')) {
    console.log('--- recovery keeps the base, never a mismatched CLI (round 3, d)');
    useCli('9.0.7');
    cm = await importFresh('src/server/container-manager.ts');
    const p16 = project(`f157v-${RUN_ID}`, pin(1));
    const n16 = cm.containerName(p16.id);
    createdContainers.push(n16);
    await ensure(cm, p16, false);
    const base16 = labelOfContainerImage(n16, 'claude-station.base-ref');
    useCli('9.0.8');
    cm = await importFresh('src/server/container-manager.ts');
    const bad = project(p16.id, { pinned: 99, skipped: [], deferred: null });   // unknown to this catalog -> recovery
    const id16 = cid(n16);
    const eLive = await ensure(cm, bad, true);
    const eIdle = await ensure(cm, bad, false);
    check('L16 in recovery a host CLI change is refused under a live session, and idle the container gets the host CLI on the SAME base',
      eLive?.code === 'cli-mismatch-live' && !eIdle && cid(n16) !== id16 && execCliVersion(n16).startsWith('9.0.8') && labelOfContainerImage(n16, 'claude-station.base-ref') === base16,
      `live=${q(eLive)} idle=${q(eIdle)} cli=${execCliVersion(n16)} base ${base16} -> ${labelOfContainerImage(n16, 'claude-station.base-ref')}`);
  }

  if (want('L17')) {
    console.log('--- an unreadable/huge answer is never a reason to destroy a container; a redirected CLI path is refused (round 3, d/e)');
    useCli('9.0.9');
    cm = await importFresh('src/server/container-manager.ts');
    const p17 = project(`f157w-${RUN_ID}`, pin(1));
    const n17 = cm.containerName(p17.id);
    createdContainers.push(n17);
    await ensure(cm, p17, false);
    const fill = dkTry(['exec', n17, 'sh', '-c', 'mkdir -p /home/claude/go/pkg/mod && cd /home/claude/go/pkg/mod && i=0; while [ $i -lt 60000 ]; do : > f$i; i=$((i+1)); done; echo filled']);
    const id17 = cid(n17);
    const e17 = await ensure(cm, p17, false);
    check('L17 a container with a large writable layer (60k files in $HOME) is kept at the next idle launch (the CLI is read by path, not by a size-capped diff)',
      fill.out === 'filled' && !e17 && cid(n17) === id17, `fill=${fill.out} err=${q(e17)} id ${id17?.slice(7, 19)} -> ${cid(n17)?.slice(7, 19)}`);
    // A base whose ~/.local/bin is a symlink into the workspace (the repo bind): the CLI layer lands in the image,
    // but at run time the path resolves into the repo. Refused before any session.
    const uid = os.userInfo().uid, gid = os.userInfo().gid;
    const tag = `u${uid}-g${gid}-${crypto.randomBytes(6).toString('hex')}`;
    const c = dk(['create', '--user', '0:0', '--entrypoint', 'sh', SEED, '-c', `rm -rf /home/claude/.local/bin && ln -s /workspace/f157r2-${RUN_ID}/.bin /home/claude/.local/bin`]);
    try { dk(['start', '-a', c]); dk(['commit', '--change', 'ENTRYPOINT []', '--change', 'CMD ["sleep","infinity"]', c, `${SCRATCH_BASE}:${tag}`]); } finally { dkTry(['rm', '-f', c]); }
    fs.mkdirSync(path.join(WORK, '.bin'), { recursive: true });
    fs.writeFileSync(path.join(WORK, '.bin', 'claude'), '#!/bin/sh\necho 0.0.1\n'); fs.chmodSync(path.join(WORK, '.bin', 'claude'), 0o755);
    const p17b = project(`f157r2-${RUN_ID}`, pin(`legacy:${tag}`));
    createdContainers.push(cm.containerName(p17b.id));
    const e17b = await ensure(cm, p17b, false);
    fs.rmSync(path.join(WORK, '.bin'), { recursive: true, force: true });
    check('L17b an image whose ~/.local/bin is a symlink into the repo bind is refused (cli-redirected) before any session',
      e17b?.code === 'cli-redirected', `err=${q(e17b)}`);
  }

  /* ======================================================= the real CLI */
  if (want('L10')) {
    console.log('--- the REAL host CLI through the real path (no seam)');
    realCli();
    cm = await importFresh('src/server/container-manager.ts');
    const rt = await import(path.join(TREE, 'src/server/runtime/runtime-update.ts'));
    await rt.whenRuntimeChecked();
    const p10 = project(`f157x-${RUN_ID}`, pin(1));
    const n10 = cm.containerName(p10.id);
    createdContainers.push(n10);
    const e10 = await ensure(cm, p10, false);
    const v = execCliVersion(n10);
    check('L10 the host SDK\'s own bundled CLI, copied and hash-checked, passes the stream-json handshake in the v1 image and runs in the container',
      // By BYTES in the running container (whether the layer was added or the parent already carried these bytes).
      !e10 && running(n10) && !!rt.BOOT_CLI_VERSION && v.startsWith(rt.BOOT_CLI_VERSION) && inSha(n10) === rt.BOOT_IDENTITY?.hash,
      `err=${q(e10)} boot=${rt.BOOT_CLI_VERSION} in-container=${v} sha=${inSha(n10).slice(0, 12)} boot-sha=${rt.BOOT_IDENTITY?.hash?.slice(0, 12)}`);
  }
} catch (e) {
  console.log(`  FAIL  suite crashed: ${e.stack ?? e}`);
  fail++;
} finally {
  cleanup();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : exitCode);
