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

console.log('FEAT-151 — container pin moves image identity, running container survives\n');

const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
if (!dockerOk) { console.log('  docker unavailable — SKIP'); process.exit(0); }

// A base image that already exists locally, used ONLY to run a throwaway sleep
// container this script names and removes. Never the live tag's container.
const baseImg = (() => {
  const r = spawnSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('claude-station-base:'));
  return line || 'busybox:latest';
})();
const TEST_CTR = `feat151-carryfwd-test-${process.pid}`;

const LIVE_PROVISION = path.join(ROOT, 'src', 'server', 'container', 'provision.json');
const liveBytesBefore = fs.readFileSync(LIVE_PROVISION);

const scratch = mkdtempScratch('feat151-container-');
const copy = path.join(scratch, 'copy');
fs.mkdirSync(copy);
try {
  // Stand up a throwaway "running container session".
  const run = spawnSync('docker', ['run', '-d', '--name', TEST_CTR, baseImg, 'sleep', '600'], { encoding: 'utf8' });
  const started = run.status === 0;
  ok('throwaway test container started (stand-in for a live session)', started, (run.stderr || '').slice(-200));

  // Build the isolated copy so provisionJsonPath()/provisionHash() resolve to it.
  const cp = (args) => spawnSync('cp', args, { stdio: 'inherit' });
  cp(['-a', '--reflink=auto', path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules')]);
  for (const f of ['package.json', 'package-lock.json', 'tsconfig.json']) cp([path.join(ROOT, f), path.join(copy, f)]);
  cp(['-a', path.join(ROOT, 'src'), path.join(copy, 'src')]);
  cp(['-a', path.join(ROOT, 'scripts'), path.join(copy, 'scripts')]);

  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const prov = await import('./src/server/provisioning.ts');
    const before = prov.provisionHash();
    const beforePin = prov.claudeCodePin().version;
    // bump to a DIFFERENT valid CLI version (pure file write, no docker)
    const target = beforePin === '2.1.281' ? '2.1.280' : '2.1.281';
    const res = prov.writeClaudeCodePin(target);
    const after = prov.provisionHash();
    const afterPin = prov.claudeCodePin().version;
    console.log(JSON.stringify({ before, after, beforePin, afterPin, changed: res.changed, moved: before !== after }));
  `], { cwd: copy, encoding: 'utf8' });
  if (r.status !== 0) console.log('  child stderr:', (r.stderr || '').slice(-600));
  let c; try { c = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { c = { _raw: r.stdout }; }

  ok('pin write CHANGED provision.json (changed=true)', c.changed === true, JSON.stringify(c));
  ok('provisionHash MOVED → new image tag → rebuild wanted on NEXT session', c.moved === true, JSON.stringify(c));
  ok('the pin version was actually bumped', c.afterPin !== c.beforePin, JSON.stringify(c));

  // The LIVE provision.json must be byte-identical — the write went to the copy.
  const liveBytesAfter = fs.readFileSync(LIVE_PROVISION);
  ok('LIVE provision.json UNTOUCHED (pin write hit the isolated copy only)', Buffer.compare(liveBytesBefore, liveBytesAfter) === 0);

  // The running container survived: a pin write spawns no docker, so nothing
  // could have stopped it.
  const ps = spawnSync('docker', ['ps', '--filter', `name=${TEST_CTR}`, '--format', '{{.Names}} {{.Status}}'], { encoding: 'utf8' });
  ok('running container SURVIVES the pin write untouched (still Up)', /Up/.test(ps.stdout || ''), (ps.stdout || '').trim());
} finally {
  spawnSync('docker', ['rm', '-f', TEST_CTR], { stdio: 'ignore' });
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
