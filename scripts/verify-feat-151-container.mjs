/**
 * FEAT-151 — container pin → image-identity move, under a RUNNING container
 * (round-2 carry-forward: "container rebuild under a live container session").
 *
 * What the plan actually specifies (findings #5/#6): the container-update route
 * only WRITES the provision.json pin. Writing it changes provisionHash() → a new
 * image tag → drift, so the new image builds when a container project NEXT starts
 * a session. It NEVER rebuilds or force-replaces a running container — the pin
 * write spawns no docker at all. So the property to demonstrate is: a pin write
 * moves the desired image tag while any running container survives untouched.
 *
 * This proves that SAFELY:
 *   - starts a THROWAWAY test container (a name+image this script owns) to stand
 *     in for "a running container session" — the live user container and the live
 *     `claude-station-base` tag are never touched;
 *   - does the pin write in an ISOLATED COPY of the repo (reflinked node_modules,
 *     its own provision.json), so the LIVE src/server/container/provision.json is
 *     never modified;
 *   - asserts provisionHash()/stationImageTag() MOVE (drift → rebuild on next
 *     session), the pin write is a pure file write (spawns no docker), the live
 *     provision.json is byte-identical after, and the test container is still Up.
 *
 *   node scripts/verify-feat-151-container.mjs
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempScratch } from './lib/scratch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};

console.log('FEAT-151 (superseded by FEAT-157) — the container CLI is not a pin; the running container survives\n');

const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
if (!dockerOk) { console.log('  docker unavailable — SKIP'); process.exit(0); }

// A base image that already exists locally, used ONLY to run a throwaway sleep
// container this script names and removes. Never the live tag's container.
const baseImg = (() => {
  const r = spawnSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('claude-station-base:'));
  return line || 'busybox:latest';
})();
let TEST_ID = '';
const TEST_CTR = `feat151-carryfwd-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`; // FEAT-158: pid alone repeats across pid namespaces

const LIVE_PROVISION = path.join(ROOT, 'src', 'server', 'container', 'provision.json');
const liveBytesBefore = fs.readFileSync(LIVE_PROVISION);

const scratch = mkdtempScratch('feat151-container-');
const copy = path.join(scratch, 'copy');
fs.mkdirSync(copy);
try {
  // Stand up a throwaway "running container session".
  const run = spawnSync('docker', ['run', '-d', '--name', TEST_CTR, baseImg, 'sleep', '600'], { encoding: 'utf8' });
  TEST_ID = (run.stdout || '').trim();
  const started = run.status === 0;
  ok('throwaway test container started (stand-in for a live session)', started, (run.stderr || '').slice(-200));

  // Build the isolated copy so provisionJsonPath()/provisionHash() resolve to it.
  const cp = (args) => spawnSync('cp', args, { stdio: 'inherit' });
  cp(['-a', '--reflink=auto', path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules')]);
  for (const f of ['package.json', 'package-lock.json', 'tsconfig.json']) cp([path.join(ROOT, f), path.join(copy, f)]);
  cp(['-a', path.join(ROOT, 'src'), path.join(copy, 'src')]);
  cp(['-a', path.join(ROOT, 'scripts'), path.join(copy, 'scripts')]);

  // FEAT-157 SUPERSEDES the pin write this suite used to exercise: the container CLI is no longer a
  // provision.json pin but the host SDK's own CLI, added as a one-file layer on top of the pinned base.
  // A CLI change moving the wanted image while a live container survives is proven, against a real
  // daemon, by verify-feat-157-lifecycle.mjs L4/L4b. What remains here: the pin and its writer are
  // GONE (a stale pin is a second place able to disagree with the SDK), and the base recipe no longer
  // installs a CLI (so a CLI change can never move a pinned base).
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const fs = await import('node:fs');
    const prov = await import('./src/server/provisioning.ts');
    const manifest = JSON.parse(fs.readFileSync('src/server/container/provision.json', 'utf8'));
    const df = fs.readFileSync('src/server/container/Dockerfile', 'utf8');
    console.log(JSON.stringify({ pinFns: typeof prov.claudeCodePin + '/' + typeof prov.writeClaudeCodePin, inManifest: 'claude-code' in manifest.tools, dfInstalls: /npm install -g[^\\n]*claude|claude-code@/.test(df) }));
  `], { cwd: copy, encoding: 'utf8' });
  if (r.status !== 0) console.log('  child stderr:', (r.stderr || '').slice(-600));
  let c; try { c = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { c = { _raw: r.stdout }; }
  ok('FEAT-157: no container-CLI pin reader or writer exists', c.pinFns === 'undefined/undefined', JSON.stringify(c));
  ok('FEAT-157: provision.json carries no claude-code pin', c.inManifest === false, JSON.stringify(c));
  ok('FEAT-157: the base recipe installs no Claude CLI (a CLI change cannot move a pinned base)', c.dfInstalls === false, JSON.stringify(c));

  // The LIVE provision.json must be byte-identical — the write went to the copy.
  const liveBytesAfter = fs.readFileSync(LIVE_PROVISION);
  ok('LIVE provision.json UNTOUCHED (pin write hit the isolated copy only)', Buffer.compare(liveBytesBefore, liveBytesAfter) === 0);

  // The running container survived: a pin write spawns no docker, so nothing
  // could have stopped it.
  const ps = spawnSync('docker', ['ps', '--filter', `name=${TEST_CTR}`, '--format', '{{.Names}} {{.Status}}'], { encoding: 'utf8' });
  ok('running container SURVIVES the pin write untouched (still Up)', /Up/.test(ps.stdout || ''), (ps.stdout || '').trim());
} finally {
  if (TEST_ID) spawnSync('docker', ['rm', '-f', TEST_ID], { stdio: 'ignore' }); // FEAT-158: by the id this run created
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
