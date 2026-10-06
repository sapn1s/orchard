#!/usr/bin/env node
/**
 * FEAT-157 hypothesis probe — does a project running the base image DIRECTLY
 * have its container recreated under a LIVE session when the base changes and a
 * second session launches?
 *
 * The live launch path passes `deferImageSwap: true` whenever another session is
 * already live (agent-bridge.ts: `deferImageSwap: liveSessionsForProject(...).length > 0`).
 * The defer guard that honours it for an image change (container-manager.ts
 * ~L2076) is gated on `locked` = `keepsLastGood(project)` = "the project builds
 * its own Dockerfile". A base-direct (station) project is NOT locked, so the
 * guard is skipped and the container is removed + recreated under the live one.
 *
 * This drives the REAL container-manager against REAL docker to confirm/refute.
 *
 * SAFETY (modelled on scripts/verify-bug-107-image-staleness.mjs):
 *   - runs against a COPIED tree, never the working src/;
 *   - a docker SHIM rewrites `claude-station-base` <-> a per-run scratch repo, so
 *     the user's real base images/containers are never touched or built over;
 *   - the base image is PRE-SEEDED by retagging an existing base id into the
 *     scratch repo (no multi-minute build);
 *   - every container/ image it makes is removed in cleanup, by name, only ours.
 *
 * Usage: node scripts/verify-feat-157-base-recreate-under-live.mjs
 */
import { execFileSync } from 'node:child_process';
import { ownerKeyFor, removeOwnedContainer } from './lib/owned-docker.mjs';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
const check = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${obs}`); ok ? pass++ : fail++; };

/* ---- scratch tree (copy src + scripts/lib; symlink node_modules) ---- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feat157-'));
const TREE = path.join(TMP, 'tree');
const DATA = path.join(TMP, 'data');
const WORK = path.join(TMP, 'work');
for (const d of [TREE, DATA, WORK]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(WORK, 'hello.ts'), 'export const x = 1;\n');
fs.cpSync(path.join(REPO, 'src'), path.join(TREE, 'src'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'package.json'), path.join(TREE, 'package.json'));
fs.cpSync(path.join(REPO, 'scripts', 'lib'), path.join(TREE, 'scripts', 'lib'), { recursive: true });
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(TREE, 'node_modules'));

const RUN_ID = `${process.pid}${Date.now() % 100000}${Math.random().toString(36).slice(2, 6)}`; // FEAT-158: not guessable from pid+time
const SHIM_REPO = `claude-station-v157-${RUN_ID}`;
const SHIM = path.join(TMP, 'docker-shim');
fs.writeFileSync(SHIM, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const REAL = 'claude-station-base', SCRATCH = ${JSON.stringify(SHIM_REPO)};
const argv = process.argv.slice(2);
const child = spawn('docker', argv.map((a) => a.split(REAL).join(SCRATCH)), { stdio: ['inherit', 'pipe', 'pipe'] });
const back = (s) => s.split(SCRATCH).join(REAL);
child.stdout.on('data', (d) => process.stdout.write(back(String(d))));
child.stderr.on('data', (d) => process.stderr.write(back(String(d))));
child.on('close', (c) => process.exit(c ?? 1));
child.on('error', (e) => { process.stderr.write(String(e.message)); process.exit(127); });
`);
fs.chmodSync(SHIM, 0o755);
process.env.CLAUDE_STATION_DOCKER = SHIM;
process.env.CLAUDE_STATION_DATA = DATA;

const MANIFEST = path.join(TREE, 'src', 'server', 'container', 'provision.json');
const created = [];
const OWNER = await ownerKeyFor(DATA); // FEAT-158 round 7: cleanup removes only containers this run's code created
function cleanup() {
  for (const name of created) { try { removeOwnedContainer(name, OWNER); } catch { /* gone */ } }
  try {
    const out = execFileSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' });
    for (const t of out.split('\n').map((s) => s.trim()).filter((s) => s.startsWith(`${SHIM_REPO}:`))) {
      try { execFileSync('docker', ['rmi', '-f', t], { stdio: 'pipe' }); } catch { /* in use */ }
    }
  } catch { /* no docker */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

const importFresh = async (rel) => import(path.join(TREE, rel) + `?v=${crypto.randomUUID()}`);
const dockerId = (name) => { try { return execFileSync('docker', ['inspect', name, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim(); } catch { return null; } };
const dockerRunning = (name) => { try { return execFileSync('docker', ['inspect', name, '--format', '{{.State.Running}}'], { encoding: 'utf8' }).trim() === 'true'; } catch { return null; } };

/** Pick any existing real base image id to seed the scratch repo from (no build). */
function realBaseId() {
  const out = execFileSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}'], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.startsWith('claude-station-base:'));
  if (!line) throw new Error('no claude-station-base image present to seed from');
  return line.trim().split(/\s+/)[1];
}

console.log(`FEAT-157 base-recreate-under-live probe\n  scratch tree: ${TREE}\n  scratch repo: ${SHIM_REPO}\n`);

let exitCode = 0;
try {
  execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe' });
  const seedId = realBaseId();

  const cm0 = await importFresh('src/server/container-manager.ts');
  const project = {
    id: `feat157-${RUN_ID}`,
    name: 'FEAT-157 base-direct scratch',
    hostPath: WORK,
    isolation: 'container',
    settings: { tools: { serena: false, playwright: false }, browser: { enabled: false }, mounts: [] },
    createdAt: new Date().toISOString(),
  };

  // Sanity: this project runs the base DIRECTLY (station), so it is NOT locked.
  check('P0 project runs the base image directly (imageSource=station, keepsLastGood=false)',
    cm0.imageSourceOf(project) === 'station',
    `imageSource=${cm0.imageSourceOf(project)}`);

  // Pre-seed the CURRENT base tag in the scratch repo (retag; no build).
  const wantV1 = cm0.imageNameFor(project);                 // claude-station-base:...-<hashV1>
  const scratchV1 = wantV1.replace('claude-station-base', SHIM_REPO);
  execFileSync('docker', ['tag', seedId, scratchV1], { stdio: 'pipe' });

  // --- Session 1 launches: create + start the base-direct container.
  const name = cm0.containerName(project.id);
  created.push(name);
  const st1 = await cm0.ensureContainer(project, { deferImageSwap: false, onLog: () => {} });
  const idA = dockerId(name);
  check('P1 session-1 container is created and RUNNING on the base image',
    st1.state === 'running' && !!idA && dockerRunning(name) === true,
    `state=${st1.state} containerId=${idA?.slice(7, 19)} running=${dockerRunning(name)}`);

  /* ============================ PRIMARY: image drift under a live session ==== */
  // Force the base to change: bump provision.json in the scratch tree -> new hash
  // -> new wanted image tag. Pre-seed that tag too (same bytes) so no build runs.
  const mBefore = fs.readFileSync(MANIFEST, 'utf8');
  const mj = JSON.parse(mBefore);
  mj.__feat157_probe = 'base drift: a new base release';   // any content change bumps the hash
  fs.writeFileSync(MANIFEST, JSON.stringify(mj, null, 2) + '\n');

  const cm1 = await importFresh('src/server/container-manager.ts');
  const wantV2 = cm1.imageNameFor(project);
  check('P2 the base changed: wanted image tag moved (v1 -> v2)',
    wantV2 !== wantV1,
    `v1=${wantV1.split(':').pop()} v2=${wantV2.split(':').pop()}`);
  const scratchV2 = wantV2.replace('claude-station-base', SHIM_REPO);
  execFileSync('docker', ['tag', seedId, scratchV2], { stdio: 'pipe' });

  // The drift the manager now sees on the LIVE container.
  const drift = cm1.statusOf(project);
  const imageOnlyDrift = (drift.driftReasons ?? []).length > 0 && (drift.driftReasons ?? []).every((r) => r.startsWith('image '));
  check('P3 the live container reads as drifted, image-change ONLY',
    drift.drifted === true && imageOnlyDrift,
    `drifted=${drift.drifted} reasons=${JSON.stringify(drift.driftReasons ?? [])}`);

  // --- Session 2 launches while session 1 is LIVE: deferImageSwap = true.
  const runningBefore = dockerRunning(name);
  const st2 = await cm1.ensureContainer(project, { deferImageSwap: true, onLog: (s) => process.stdout.write(`    [log] ${String(s).trim()}\n`) });
  const idB = dockerId(name);

  const recreated = idA && idB && idA !== idB;                 // container swapped underneath
  const removedEntirely = idA && !idB;                          // or removed and not yet back
  check('P4 REPRO — a live base-direct container is RECREATED under the live session on a base change',
    (recreated || removedEntirely),
    `session1 running before 2nd launch=${runningBefore} | containerId before=${idA?.slice(7, 19)} after=${idB?.slice(7, 19)} | recreated=${!!recreated} removed=${!!removedEntirely} | 2nd-launch state=${st2.state}`);

  /* ============================ CONTROL: deferImageSwap IS honoured for a ====
     base-direct project on a branch that does NOT require `locked` (the
     lockdown-only defer, container-manager.ts ~L2089). This isolates the cause:
     the plumbing works for station projects; the image branch skips it purely
     because of its extra `locked &&`. */
  const cprojId = `feat157c-${RUN_ID}`;
  const cproj = { ...project, id: cprojId };
  const cname = cm1.containerName(cprojId);
  created.push(cname);
  // Build the exact create argv the manager would use, then flip ONLY the
  // lockdown user pin so the sole drift is `lockdown: user ...`.
  const argv = cm1.createArgs(cproj, cname, scratchV2, { onLog: () => {} });
  const ui = argv.indexOf('--user');
  argv[ui + 1] = '0:0';                                        // was <uid>:<gid>
  execFileSync('docker', argv, { stdio: 'pipe' });
  execFileSync('docker', ['start', cname], { stdio: 'pipe' });
  const cidA = dockerId(cname);
  const cdrift = cm1.statusOf(cproj);
  const lockdownOnly = (cdrift.driftReasons ?? []).length > 0 && (cdrift.driftReasons ?? []).every((r) => r.startsWith('lockdown:'));
  check('C1 CONTROL precondition: same base-direct project, lockdown-ONLY drift',
    cdrift.drifted === true && lockdownOnly && dockerRunning(cname) === true,
    `drifted=${cdrift.drifted} reasons=${JSON.stringify(cdrift.driftReasons ?? [])}`);
  await cm1.ensureContainer(cproj, { deferImageSwap: true, onLog: () => {} });
  const cidB = dockerId(cname);
  check('C2 CONTROL — with deferImageSwap the SAME base-direct container is KEPT (defer honoured, no `locked` needed)',
    !!cidA && cidA === cidB && dockerRunning(cname) === true,
    `containerId before=${cidA?.slice(7, 19)} after=${cidB?.slice(7, 19)} kept=${cidA === cidB}`);

  fs.writeFileSync(MANIFEST, mBefore);
} catch (err) {
  console.error(`\nHARNESS ERROR: ${err?.stack ?? err}`);
  exitCode = 2;
} finally {
  cleanup();
}

console.log(`\n${pass}/${pass + fail} PASS  (${fail} FAIL)`);
console.log(pass >= 5 && fail === 0
  ? '\nCONCLUSION: REPRODUCED — a base-direct project is recreated under a live session on a base change (P4), while the same project defers on a non-`locked` branch (C2). Root cause: the image-swap defer guard is gated on `locked`.'
  : '\nCONCLUSION: see failures above.');
process.exit(exitCode || (fail ? 1 : 0));
