#!/usr/bin/env node
/**
 * BUG-240 — proof suite for the confined runner (scripts/lib/confined-run.mjs).
 *
 *   npm run verify:bug-240-confined     (needs the FEAT-158 sandbox up)
 *
 * The property: a command run THROUGH THE RUNNER can do scratch git and
 * destructive file work, and changes no host file, reaches no daemon socket and
 * no network, and stays inside its memory / pids / storage caps and its deadline.
 * Host-side checks compare content fingerprints, not exit codes alone.
 *
 * Scope, stated narrowly: this proves the runner's container. It does not, and
 * cannot, stop a lane that talks to a Docker socket directly (the BUG-240
 * chokepoint decision). The CONTROL section shows the same host write SUCCEEDS
 * through a plain `docker run` on the FEAT-158 sandbox, i.e. the venue the
 * runner replaces for these suites; it validates that attack only.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  confinementFlags, runConfined, pinSandbox, extractStrict, resolveShip, sandboxCliEnv, DEFAULT_BASE_IMAGE,
  EXPIRES_LABEL, __test,
} from './lib/confined-run.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${String(detail).split('\n').slice(0, 8).join('\n        ')}` : ''}`);
};
const quiet = () => {};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read-only content fingerprint of a repo: HEAD, refs, index bytes, staged blob ids, worktree diff, untracked list. */
function repoPrint(dir) {
  const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'buffer', maxBuffer: 1 << 30 }).stdout ?? Buffer.alloc(0);
  let index = 'none';
  try { index = sha(fs.readFileSync(path.join(dir, '.git', 'index'))); } catch { /* none */ }
  return sha(Buffer.concat([g('rev-parse', 'HEAD'), g('for-each-ref'), Buffer.from(index), g('ls-files', '-s'),
    g('diff', 'HEAD', '--binary'), g('ls-files', '-o', '--exclude-standard')]));
}
function dirPrint(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { out.push(`d ${path.relative(dir, p)}`); walk(p); }
    else if (e.isSymbolicLink()) out.push(`l ${path.relative(dir, p)} ${fs.readlinkSync(p)}`);
    else { let c = 'unreadable'; try { c = sha(fs.readFileSync(p)); } catch { /* mode 000 */ } out.push(`f ${path.relative(dir, p)} ${c}`); }
  } };
  walk(dir);
  return out.join('\n');
}
const ours = (env, extra = []) => spawnSync('docker', ['ps', '-a', '-q', '--filter', 'label=orchard.confined-run=1', ...extra], { env, encoding: 'utf8' }).stdout.trim();

async function main() {
  let pinned;
  try { pinned = pinSandbox(); } catch (e) { console.error(`FATAL: ${e.message}\n  Start the sandbox: npm run sandbox:docker -- up`); process.exit(2); }
  const { env: sbxEnv } = pinned;

  // A host-side fixture under the host /tmp (which the FEAT-158 sandbox binds rw at the same path).
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bug240-confined-'));
  const victim = path.join(fixture, 'victim');
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'original\n');
  const nonce = crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(path.join(victim, 'marker'), nonce);
  const before = { victim: dirPrint(victim), repo: repoPrint(REPO) };
  const base = { cwd: REPO, log: quiet, capture: true, withGit: false };

  try {
    console.log('=== P1: the confinement is fixed argv ===');
    const f = confinementFlags();
    const has = (...seq) => f.some((_, i) => seq.every((s, k) => f[i + k] === s));
    check('P1a --cap-drop ALL', has('--cap-drop', 'ALL'));
    check('P1b no-new-privileges', has('--security-opt', 'no-new-privileges'));
    check('P1c --network none', has('--network', 'none'));
    check('P1d --read-only rootfs, --rm', f.includes('--read-only') && f.includes('--rm'));
    check('P1e non-root --user 1000:1000', has('--user', '1000:1000'));
    check('P1f no host storage: no -v/--volume/--mount, no --privileged/--device, no host namespaces; writable = size-capped tmpfs only',
      !f.some((x) => /^(-v|--volume|--mount|--privileged|--device|--pid|--uts|--userns|--cgroupns)$/.test(x)) && !f.some((x) => /=host$/.test(x))
      && f.filter((x, i) => f[i - 1] === '--tmpfs').every((t) => /size=\d+m/.test(t)));
    let bad = 0; for (const l of [{ memoryMb: 0 }, { pids: -1 }, { workMb: 1.5 }]) { try { confinementFlags(l); } catch { bad++; } }
    check('P1g non-positive or fractional limits are refused', bad === 3);

    console.log('=== P2: runtime confinement, from inside ===');
    const probe = [
      'echo "cap=$(awk \'/^CapEff/{print $2}\' /proc/self/status)"',
      'echo "nnp=$(awk \'/^NoNewPrivs/{print $2}\' /proc/self/status)"',
      'echo "mountsuid=$(stat -c %A /bin/mount)"',
      'mkdir -p /tmp/m; mount -t tmpfs t /tmp/m 2>/dev/null && echo mount=ok || echo mount=refused',
      'unshare -Ur true 2>/dev/null && echo userns=ok || echo userns=refused',
      '(echo x > /etc/escape) 2>/dev/null && echo rootfs=rw || echo rootfs=ro',
      '( [ -e /run/docker.sock ] || [ -e /var/run/docker.sock ] || [ -e /run/orchard-sandbox ] ) && echo sock=present || echo sock=absent',
      'echo "netifs=$(ls /sys/class/net | tr \'\\n\' \',\')"',
      `[ -e ${victim} ] && echo hosttmp=visible || echo hosttmp=hidden`,
      `grep -rqs ${nonce} /tmp /work 2>/dev/null && echo nonce=found || echo nonce=absent`,
      'echo "uid=$(id -u)"',
    ].join('; ');
    const r2 = await runConfined(['bash', '-c', probe], base);
    const o = r2.stdout;
    check('P2a no effective capabilities', /cap=0+$/m.test(o), o);
    check('P2b NoNewPrivs=1', /nnp=1$/m.test(o), o);
    check('P2c the SETUID mount helper (-rwsr-xr-x) still cannot mount: setuid gives no root', /mountsuid=-rws/.test(o) && /mount=refused/.test(o), o);
    check('P2d user-namespace unshare refused', /userns=refused/.test(o));
    check('P2e rootfs read-only', /rootfs=ro/.test(o));
    check('P2f no docker socket inside', /sock=absent/.test(o));
    check('P2g the only network interface is loopback', /^netifs=lo,$/m.test(o), o);
    check('P2h host /tmp fixture not visible, its content nowhere inside', /hosttmp=hidden/.test(o) && /nonce=absent/.test(o));
    check('P2i runs as uid 1000', /^uid=1000$/m.test(o));

    console.log('=== P3: scratch git works inside, and changes nothing real ===');
    const G = 'git';
    const gitScript = [
      'set -e', 'd=$(mktemp -d)', 'cd "$d"',
      `${G} init -q .`, 'echo one > a', `${G} add a`, `${G} commit -qm one`,
      `${G} clone -q "$d" "$d-clone"`, `cd /work && { [ -d .git ] || ${G} init -q .; } && echo dirty >> README.md && ${G} add README.md && ${G} commit -q --no-verify -m "confined write to the shipped copy"`,
      `${G} -C /work log -1 --format=%s`,
    ].join('\n');
    const r3 = await runConfined(['bash', '-c', gitScript], { ...base, withGit: true });
    check('P3a init/add/commit/clone in scratch succeed; committing in the shipped copy succeeds', r3.code === 0 && /confined write to the shipped copy/.test(r3.stdout), r3.stderr);
    check('P3b the real repo is content-unchanged (HEAD, refs, index, blobs, worktree diff, untracked)', repoPrint(REPO) === before.repo);

    console.log('=== P4: --ship is a copy in, nothing comes back; a failed ship runs nothing ===');
    const shipped = await runConfined(['bash', '-c', 'set -e; cd ~/victim; echo pwn > keep.txt; rm marker; ln -s /etc/passwd evil; ls'],
      { ...base, ship: [`${victim}:~/victim`] });
    check('P4a the shipped copy was writable inside', shipped.code === 0 && /evil/.test(shipped.stdout), shipped.stderr);
    check('P4b the host source dir is content-unchanged', dirPrint(victim) === before.victim);
    let threw = 0;
    for (const b of [`${victim}:/etc`, `${victim}:~/../../x`, `${victim}:..`, '/etc', `${victim}:~/a&&/b`]) { try { resolveShip(b); } catch { threw++; } }
    check('P4c --ship destinations outside /work (or with sed metacharacters) and sources outside $HOME without a dest are refused', threw === 5, `${threw}/5`);
    const unreadable = path.join(fixture, 'unreadable');
    fs.mkdirSync(unreadable); fs.writeFileSync(path.join(unreadable, 'secret'), 'x'); fs.chmodSync(path.join(unreadable, 'secret'), 0o000);
    let shipErr = '';
    try { await runConfined(['sh', '-c', 'echo COMMAND-RAN'], { ...base, ship: [`${unreadable}:~/u`] }); } catch (e) { shipErr = e.message; }
    check('P4d a host tar that fails (unreadable file) fails the run BEFORE the command runs', /shipping the input failed/.test(shipErr) && /the command was NOT run/.test(shipErr), shipErr || 'no error');
    fs.chmodSync(path.join(unreadable, 'secret'), 0o600);

    console.log('=== P5: --out returns regular files only, into a fresh dir ===');
    const outRun = await runConfined(['bash', '-c', 'mkdir -p o/sub; echo ok > o/sub/f; ln -s /etc/passwd o/link; ln -s ../../../../.. o/up; mkfifo o/fifo'],
      { ...base, out: 'o' });
    const outDir = outRun.outDir;
    check('P5a regular file copied back', !!outDir && fs.readFileSync(path.join(outDir, 'o', 'sub', 'f'), 'utf8') === 'ok\n', JSON.stringify(outRun));
    check('P5b symlinks and FIFOs are NOT recreated on the host', !!outDir && !fs.existsSync(path.join(outDir, 'o', 'link')) && !fs.existsSync(path.join(outDir, 'o', 'up')) && !fs.existsSync(path.join(outDir, 'o', 'fifo')));
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
    const tarDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug240-tar-'));
    const hdr = (name, type, body = Buffer.alloc(0), link = '') => {
      const h = Buffer.alloc(512);
      h.write(name, 0, 100); h.write('0000644\0', 100); h.write('0001750\0', 108); h.write('0001750\0', 116);
      h.write(body.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
      h.write('        ', 148); h.write(type, 156); h.write(link, 157, 100); h.write('ustar\0', 257); h.write('00', 263);
      let s = 0; for (const b of h) s += b; h.write(s.toString(8).padStart(6, '0') + '\0 ', 148);
      return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
    };
    const evilTarget = path.join(fixture, 'escaped');
    const pax = (p) => { const rec = ` path=${p}\n`; let n = rec.length + 2; n = `${n}${rec}`.length; return hdr('PaxHeader', 'x', Buffer.from(`${n}${rec}`)); };
    const tarBuf = Buffer.concat([
      hdr('../escape1', '0', Buffer.from('x')), hdr(evilTarget, '0', Buffer.from('x')),
      hdr('ln', '2', Buffer.alloc(0), fixture), hdr('ln/escaped', '0', Buffer.from('x')),
      pax('../../escape2'), hdr('innocent', '0', Buffer.from('x')),
      hdr('hl', '1', Buffer.alloc(0), '/etc/passwd'),
      hdr('ok.txt', '0', Buffer.from('fine')), Buffer.alloc(1024),
    ]);
    const dest = fs.mkdtempSync(path.join(tarDir, 'd-'));
    let xr = null, err = '';
    try { xr = extractStrict(tarBuf, dest); } catch (e) { err = e.message; }
    check('P5c hostile tar (../, absolute, write-through-symlink, pax ../, hardlink) lands nothing outside the fresh dir',
      !fs.existsSync(evilTarget) && !fs.existsSync(path.join(tarDir, 'escape1')) && !fs.existsSync(path.join(path.dirname(tarDir), 'escape2'))
      && !fs.existsSync(path.join(dest, 'hl')) && !fs.lstatSync(path.join(dest, 'ln')).isSymbolicLink(), `result ${JSON.stringify(xr)} ${err}`);
    check('P5d hostile tar: the plain file still extracts', fs.existsSync(path.join(dest, 'ok.txt')));
    const truncDest = fs.mkdtempSync(path.join(tarDir, 't-'));
    const full = hdr('big', '0', Buffer.alloc(100, 7));
    let truncErr = '';
    try { extractStrict(full.subarray(0, 512 + 3), truncDest); } catch (e) { truncErr = e.message; }
    check('P5e a truncated archive is rejected and writes nothing', /truncated/.test(truncErr) && fs.readdirSync(truncDest).length === 0, truncErr || 'accepted');
    let partErr = '';
    try { extractStrict(full.subarray(0, 511), truncDest); } catch (e) { partErr = e.message; }
    check('P5f a partial (511-byte) trailing header is rejected', /partial header/.test(partErr), partErr || 'accepted');
    const rej = (b, opts) => { try { extractStrict(b, truncDest, opts); return ''; } catch (e) { return e.message; } };
    const lnOnly = hdr('././@LongLink', 'L', Buffer.from('some/long/name\0'));
    check('P5k empty input, a long-name header with no member, and a short archive under a spent budget are all rejected',
      /no end-of-archive/.test(rej(Buffer.alloc(0))) && /truncated/.test(rej(lnOnly)) && /metadata without its member/.test(rej(Buffer.concat([lnOnly, Buffer.alloc(1024)])))
      && /deadline passed/.test(rej(Buffer.concat([hdr('s', '0', Buffer.from('z')), Buffer.alloc(1024)]), { budget: { until: Date.now() - 1 } }))
      && /metadata without its member/.test(rej(Buffer.concat([hdr('PaxHeader', 'x', Buffer.from('11 mtime=1\n')), Buffer.alloc(1024)]))));
    const many = Buffer.concat([...Array.from({ length: 300 }, (_, k) => hdr(`l${k}`, '2', Buffer.alloc(0), '/x')), Buffer.alloc(1024)]);
    let capErr = '', budErr = '';
    try { extractStrict(many, truncDest, { maxMembers: 100 }); } catch (e) { capErr = e.message; }
    try { extractStrict(many, truncDest, { budget: { until: Date.now() - 1 } }); } catch (e) { budErr = e.message; }
    check('P5g extraction stops at the member cap and at a spent budget (host-side work bounded)', /more than 100/.test(capErr) && /deadline passed/.test(budErr), `${capErr} | ${budErr}`);
    // Round-6 review 1: a digit-only pax body must parse in linear time; oversized metadata is refused.
    const digits = hdr('PaxHeader', 'x', Buffer.alloc(60000, 0x37));
    const tp = Date.now();
    let paxErr = '';
    try { extractStrict(Buffer.concat([digits, hdr('ok2', '0', Buffer.from('y')), Buffer.alloc(1024)]), truncDest); } catch (e) { paxErr = e.message; }
    const paxMs = Date.now() - tp;
    let bigErr = '';
    try { extractStrict(Buffer.concat([hdr('PaxHeader', 'x', Buffer.alloc(70000, 0x37)), Buffer.alloc(1024)]), truncDest); } catch (e) { bigErr = e.message; }
    check('P5h a 60 KB digit-only pax header parses in linear time (< 200 ms); a > 64 KiB one is refused', paxMs < 200 && !paxErr && /over 64 KiB/.test(bigErr), `${paxMs}ms ${paxErr} | ${bigErr}`);
    const { paxPathOf } = await import('./lib/confined-run.mjs');
    const rec = (k, v) => { const body = ` ${k}=${v}\n`; let n = body.length + 1; while (`${n}${body}`.length !== n) n++; return `${n}${body}`; };
    check('P5i pax records parse correctly (path found among other keys; malformed ignored)',
      paxPathOf(Buffer.from(rec('mtime', '1') + rec('path', 'a/b'))) === 'a/b' && paxPathOf(Buffer.from('99 path=x\n')) === null);
    // Round-6 review 2: short writes are completed, not silently truncated.
    const { createRequire, syncBuiltinESMExports } = await import('node:module');
    const cjsFs = createRequire(import.meta.url)('node:fs');
    const realWrite = cjsFs.writeSync;
    let calls = 0;
    cjsFs.writeSync = (fd, b, off = 0, len = b.length - off) => { calls++; return realWrite(fd, b, off, Math.min(len, 7)); };
    syncBuiltinESMExports();
    const swDest = fs.mkdtempSync(path.join(tarDir, 'w-'));
    try { extractStrict(Buffer.concat([hdr('w.bin', '0', Buffer.alloc(100, 9)), Buffer.alloc(1024)]), swDest); } finally { cjsFs.writeSync = realWrite; syncBuiltinESMExports(); }
    const wb = fs.readFileSync(path.join(swDest, 'w.bin'));
    check('P5j a writer that accepts 7 bytes per call still yields the full 100-byte file', wb.length === 100 && calls >= 15, `len ${wb.length} calls ${calls}`);
    fs.rmSync(tarDir, { recursive: true, force: true });

    console.log('=== P6: the caller cannot pick the daemon, add docker flags, or bring storage ===');
    const hostEnv = { ...process.env, DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONTEXT: 'default' };
    check('P6a an inherited DOCKER_HOST at the host socket is ignored (the CLI env is pinned to the sandbox)', sandboxCliEnv(hostEnv).DOCKER_HOST !== hostEnv.DOCKER_HOST && !('DOCKER_CONTEXT' in sandboxCliEnv(hostEnv)));
    const fakeState = fs.mkdtempSync(path.join(os.tmpdir(), 'bug240-state-'));
    fs.mkdirSync(path.join(fakeState, 'claude-station', 'docker-sandbox', 'run'), { recursive: true });
    fs.symlinkSync('/var/run/docker.sock', path.join(fakeState, 'claude-station', 'docker-sandbox', 'run', 'docker.sock'));
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = fakeState;
    let refused = '';
    try { pinSandbox(process.env); } catch (e) { refused = e.message; }
    if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
    fs.rmSync(fakeState, { recursive: true, force: true });
    check('P6b a "sandbox" socket that is really the host daemon is refused', /IS the host daemon|refuses/.test(refused), refused);
    const inj = await runConfined(['--privileged', '-v', '/:/h'], base);
    check('P6c docker-flag-looking argv is the in-container command, not a docker flag', inj.code !== 0 && /not found|No such file/.test(inj.stderr + inj.stdout), inj.stderr.slice(0, 200));
    // An image that declares a VOLUME would add writable storage outside the caps: refused.
    const mk = spawnSync('docker', ['create', '--network', 'none', DEFAULT_BASE_IMAGE, 'true'], { env: sbxEnv, encoding: 'utf8' });
    const volTag = `bug240-volimg:${process.pid}`;
    spawnSync('docker', ['commit', '--change', 'VOLUME /data', mk.stdout.trim(), volTag], { env: sbxEnv, encoding: 'utf8' });
    spawnSync('docker', ['rm', '-f', mk.stdout.trim()], { env: sbxEnv });
    let volErr = '';
    try { await runConfined(['true'], { ...base, cwd: fixture, image: volTag }); } catch (e) { volErr = e.message; }
    spawnSync('docker', ['rmi', '-f', volTag], { env: sbxEnv });
    check('P6d an image declaring VOLUME is refused', /declares VOLUME/.test(volErr), volErr || 'ran');
    // Independent Claude verify: --env must not reset the runner's own variables.
    let envErr = '';
    try { await runConfined(['pwd'], { ...base, env: ['ORCHARD_CONFINED_SUBDIR=../../../..'] }); } catch (e) { envErr = e.message; }
    let envErr2 = '';
    try { await runConfined(['pwd'], { ...base, env: ['ORCHARD_CONFINED=0'] }); } catch (e) { envErr2 = e.message; }
    const envOk = await runConfined(['sh', '-c', 'echo "c=$ORCHARD_CONFINED x=$X"; pwd -P'], { ...base, env: ['X=1', 'CI=0'] });
    check('P6e --env cannot set the runner\'s reserved variables; ordinary --env passes; the command starts inside /work',
      /reserved by the runner/.test(envErr) && /reserved by the runner/.test(envErr2) && /c=1 x=1/.test(envOk.stdout) && /^\/work$/m.test(envOk.stdout),
      `${envErr} | ${envErr2} | ${envOk.stdout}`);

    console.log('=== P7: caps hold (memory, pids, /work size) ===');
    const mem = await runConfined(['node', '-e', 'const a=[];for(;;){a.push(Buffer.alloc(16<<20,1))}'], { ...base, limits: { memoryMb: 256 } });
    check('P7a allocating past --memory 256m is killed (OOM, exit 137)', mem.code === 137, `code ${mem.code} ${mem.stderr.slice(0, 200)}`);
    const forkJs = "const {spawn}=require('child_process');let errs=0;for(let i=0;i<400;i++){try{spawn('sleep',['30']).on('error',()=>errs++)}catch{errs++}}"
      + "setTimeout(()=>{const n=require('fs').readdirSync('/proc').filter((x)=>/^[0-9]+$/.test(x)).length;console.log('procs='+n+' errors='+errs);process.exit(0)},3000)";
    const pids = await runConfined(['node', '-e', forkJs], { ...base, limits: { pids: 64 } });
    const pm = /procs=(\d+) errors=(\d+)/.exec(pids.stdout) ?? [];
    check('P7b --pids-limit 64: 400 spawns leave < 64 live processes and the rest fail', Number(pm[1]) < 64 && Number(pm[2]) > 300, `${pids.stdout.slice(0, 120)} ${pids.stderr.slice(0, 120)}`);
    const disk = await runConfined(['bash', '-c', 'dd if=/dev/zero of=/work/fill bs=1M count=200 2>/tmp/dd.err; echo rc=$?; cat /tmp/dd.err; echo size=$(stat -c %s /work/fill)'], { ...base, limits: { workMb: 64 } });
    const sz = Number((/size=(\d+)/.exec(disk.stdout) ?? [])[1] ?? 1e12);
    check('P7c writing 200 MB into a 64 MB /work fails with ENOSPC below the cap', /No space left/.test(disk.stdout) && !/rc=0/.test(disk.stdout) && sz <= 64 * 1024 * 1024, disk.stdout);

    // Verify a11809aa item 1: CPU cap. Busy-loop 6 workers for 3 s; measure the cgroup's CPU time / wall.
    check('P7d --cpus is in the fixed flags (default 2)', has('--cpus', '2'));
    const cpuProbe = 'const {Worker}=require("worker_threads");const fs=require("fs");const u=()=>Number(/usage_usec (\\d+)/.exec(fs.readFileSync("/sys/fs/cgroup/cpu.stat","utf8"))[1]);'
      + 'const a=u(),t=Date.now();for(let i=0;i<6;i++)new Worker("for(;;){}",{eval:true});setTimeout(()=>{console.log("cores="+((u()-a)/1000/(Date.now()-t)).toFixed(2));process.exit(0)},3000)';
    const cores = (r) => Number((/cores=([\d.]+)/.exec(r.stdout) ?? [])[1] ?? NaN);
    const capped = await runConfined(['node', '-e', cpuProbe], { ...base, limits: { cpus: 1 } });
    // CONTROL (must-FAIL the property): the same flags WITHOUT --cpus, as before this fix.
    const noCpu = confinementFlags().filter((x, i, a) => x !== '--cpus' && a[i - 1] !== '--cpus').filter((x) => x !== '--rm');
    const ctlCpu = spawnSync('docker', ['run', '--rm', ...noCpu, '--entrypoint', 'node', DEFAULT_BASE_IMAGE, '-e', cpuProbe], { env: sbxEnv, encoding: 'utf8', timeout: 60_000 });
    check('P7e --cpus 1 holds 6 busy workers to <= 1.3 cores; CONTROL without --cpus uses >= 3 [must-FAIL without the cap]',
      cores(capped) <= 1.3 && cores({ stdout: ctlCpu.stdout ?? '' }) >= 3, `capped ${capped.stdout.trim()} ${capped.stderr.slice(0, 120)} | control ${String(ctlCpu.stdout).trim()} ${String(ctlCpu.stderr).slice(0, 120)}`);

    // Verify a11809aa item 2: --out is streamed with a hard cap.
    const big = await runConfined(['sh', '-c', 'mkdir -p o; head -c 20000000 /dev/zero > o/big'], { ...base, out: 'o', limits: { outMb: 8 } });
    const small = await runConfined(['sh', '-c', 'mkdir -p o; head -c 5000000 /dev/zero > o/ok'], { ...base, out: 'o', limits: { outMb: 8 } });
    check('P7f --out over --out-mb is REFUSED loudly (non-zero, outError, no partial dir); under the cap it extracts',
      big.code !== 0 && /exceeds the \d+-byte cap/.test(big.outError ?? '') && !big.outDir && small.code === 0 && fs.statSync(path.join(small.outDir, 'o', 'ok')).size === 5000000,
      JSON.stringify({ big: { code: big.code, outError: big.outError, outDir: big.outDir }, small: { code: small.code, outDir: small.outDir } }));
    if (small.outDir) fs.rmSync(small.outDir, { recursive: true, force: true });
    // Peak host RSS of a 400 MiB export, measured in a child process (maxRSS), vs the old buffered shape.
    const libUrl = new URL('./lib/confined-run.mjs', import.meta.url).href;
    const rssChild = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { runConfined } from ${JSON.stringify(libUrl)}; import fs from 'node:fs';
       const r = await runConfined(['sh','-c','mkdir -p o; head -c 419430400 /dev/zero > o/big'], { cwd: ${JSON.stringify(fixture)}, withGit: false, log: () => {}, capture: true, out: 'o' });
       const sz = r.outDir ? fs.statSync(r.outDir + '/o/big').size : -1; if (r.outDir) fs.rmSync(r.outDir, { recursive: true, force: true });
       console.log(JSON.stringify({ code: r.code, sz, maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024) }));`], { encoding: 'utf8', timeout: 600_000 });
    const streamed = JSON.parse((rssChild.stdout || '{}').trim().split('\n').pop() || '{}');
    const ctlChild = spawnSync(process.execPath, ['-e',
      `const r = require('child_process').spawnSync('docker', ['run','--rm','--network','none',${JSON.stringify(DEFAULT_BASE_IMAGE)},'sh','-c','head -c 419430400 /dev/zero'], { maxBuffer: 2 ** 31 });
       console.log(JSON.stringify({ got: r.stdout ? r.stdout.length : -1, maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024) }));`], { env: sbxEnv, encoding: 'utf8', timeout: 600_000 });
    const buffered = JSON.parse((ctlChild.stdout || '{}').trim().split('\n').pop() || '{}');
    check('P7g a 400 MiB --out keeps the runner\'s peak RSS under 200 MiB; CONTROL buffering the same export peaks over 400 MiB [must-FAIL the old shape]',
      streamed.code === 0 && streamed.sz === 419430400 && streamed.maxRssMb < 200 && buffered.maxRssMb > 400,
      `streamed ${JSON.stringify(streamed)} ${String(rssChild.stderr).slice(-200)} | buffered ${JSON.stringify(buffered)}`);

    console.log('=== P8: lifecycle (deadline, a killed runner, cleanup) ===');
    const t0 = Date.now();
    const slow = await runConfined(['sleep', '120'], { ...base, timeoutSec: 20 });
    const took = (Date.now() - t0) / 1000;
    check('P8a --timeout-sec 20 ends a 120 s command within the deadline (non-zero)', slow.code !== 0 && took < 60, `code ${slow.code} took ${took}s`);
    // SIGKILL the runner itself mid-run: the daemon must remove the container at the deadline.
    const cli = spawn(process.execPath, [path.join(REPO, 'scripts', 'confined-run.mjs'), '--no-git', '--timeout-sec', '25', '--', 'sleep', '300'], { cwd: fixture, stdio: ['ignore', 'ignore', 'pipe'] });
    let cliErr = '';
    cli.stderr.on('data', (d) => { cliErr += d; });
    for (let i = 0; i < 120 && !/shipping/.test(cliErr); i++) await sleep(500);
    const cid = (/container ([0-9a-f]{12})/.exec(cliErr) ?? [])[1];
    await sleep(2000);
    const aliveBefore = !!cid && ours(sbxEnv, ['--filter', `id=${cid}`]) !== '';
    cli.kill('SIGKILL');
    let goneAt = null;
    for (let i = 0; i < 90; i++) { await sleep(1000); if (ours(sbxEnv, ['--filter', `id=${cid}`]) === '') { goneAt = i + 1; break; } }
    check('P8b a SIGKILLed runner\'s container is removed at the deadline', aliveBefore && goneAt !== null, `cid ${cid} alive ${aliveBefore} gone after ${goneAt}s; ${cliErr.slice(0, 200)}`);
    check('P8c no container of this suite\'s runs is left', ours(sbxEnv, ['--filter', `name=orchard-confined-${process.pid}-`]) === '');

    // Round-2 review 1: a hostile image whose `sleep` ignores its argument, runner SIGKILLed.
    const hz = spawnSync('docker', ['create', '--network', 'none', DEFAULT_BASE_IMAGE, 'true'], { env: sbxEnv, encoding: 'utf8' }).stdout.trim();
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bug240-hostile-'));
    fs.mkdirSync(path.join(stage, 'bin'));
    fs.writeFileSync(path.join(stage, 'bin', 'sleep'), '#!/bin/sh\nexec /bin/sleep 100000\n', { mode: 0o755 });
    spawnSync('bash', ['-c', 'tar -c --owner=0 --group=0 -C "$1" bin | docker cp - "$2":/usr/local', 'x', stage, hz], { env: sbxEnv });
    const hostileTag = `bug240-hostile-sleep:${process.pid}`;
    spawnSync('docker', ['commit', hz, hostileTag], { env: sbxEnv });
    spawnSync('docker', ['rm', '-f', hz], { env: sbxEnv });
    fs.rmSync(stage, { recursive: true, force: true });
    const cli2 = spawn(process.execPath, [path.join(REPO, 'scripts', 'confined-run.mjs'), '--no-git', '--image', hostileTag, '--timeout-sec', '25', '--', 'sleep', '5'], { cwd: fixture, stdio: ['ignore', 'ignore', 'pipe'] });
    let cli2Err = '';
    cli2.stderr.on('data', (d) => { cli2Err += d; });
    for (let i = 0; i < 120 && !/shipping/.test(cli2Err); i++) await sleep(500);
    const cid2 = (/container ([0-9a-f]{12})/.exec(cli2Err) ?? [])[1];
    cli2.kill('SIGKILL');
    let gone2 = null;
    for (let i = 0; i < 90; i++) { await sleep(1000); if (cid2 && ours(sbxEnv, ['--filter', `id=${cid2}`]) === '') { gone2 = i + 1; break; } }
    spawnSync('docker', ['rmi', '-f', hostileTag], { env: sbxEnv });
    check('P8d hostile image (its sleep ignores the deadline) + SIGKILLed runner: the detached reaper still removes the container', !!cid2 && gone2 !== null, `cid ${cid2} gone after ${gone2}s; ${cli2Err.slice(0, 200)}`);

    // Round-4 review 1: a hostile image whose `tar -c` stalls must not hold the runner past its deadline.
    const hz2 = spawnSync('docker', ['create', '--network', 'none', DEFAULT_BASE_IMAGE, 'true'], { env: sbxEnv, encoding: 'utf8' }).stdout.trim();
    const stage2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bug240-hostile2-'));
    fs.mkdirSync(path.join(stage2, 'bin'));
    fs.writeFileSync(path.join(stage2, 'bin', 'tar'), '#!/bin/sh\ncase " $* " in *" -c "*) exec /bin/sleep 100000;; esac\nexec /bin/tar "$@"\n', { mode: 0o755 });
    spawnSync('bash', ['-c', 'tar -c --owner=0 --group=0 -C "$1" bin | docker cp - "$2":/usr/local', 'x', stage2, hz2], { env: sbxEnv });
    const stallTag = `bug240-stall-tar:${process.pid}`;
    spawnSync('docker', ['commit', hz2, stallTag], { env: sbxEnv });
    spawnSync('docker', ['rm', '-f', hz2], { env: sbxEnv });
    fs.rmSync(stage2, { recursive: true, force: true });
    const t2 = Date.now();
    let stallRes = null, stallErr = '';
    try { stallRes = await runConfined(['sh', '-c', 'mkdir -p o; echo x > o/f'], { ...base, cwd: fixture, image: stallTag, out: 'o', timeoutSec: 30 }); } catch (e) { stallErr = e.message; }
    const stallTook = (Date.now() - t2) / 1000;
    spawnSync('docker', ['rmi', '-f', stallTag], { env: sbxEnv });
    check('P8h a stalled --out export (hostile tar) ends within the deadline, unsuccessfully', stallTook < 45 && (stallErr !== '' || (stallRes && stallRes.code !== 0)), `took ${stallTook}s res ${JSON.stringify(stallRes && { code: stallRes.code, outDir: stallRes.outDir })} err ${stallErr}`);

    // Round-2 review 2: a never-started container past its expiry is reconciled by the next run.
    const stale = spawnSync('docker', ['create', '--label', 'orchard.confined-run=1', '--label', `${EXPIRES_LABEL}=${Math.floor(Date.now() / 1000) - 60}`, DEFAULT_BASE_IMAGE, 'true'], { env: sbxEnv, encoding: 'utf8' }).stdout.trim();
    await runConfined(['true'], { ...base, cwd: fixture });
    check('P8e an expired, never-started labelled container is removed by the next run\'s sweep', !!stale && ours(sbxEnv, ['--filter', `id=${stale}`]) === '', stale);

    // Round-2 review 3: preparation is bounded by the deadline.
    const t1 = Date.now();
    let prepErr = '';
    try { await runConfined(['echo', 'RAN'], { ...base, timeoutSec: 1 }); } catch (e) { prepErr = e.message; }
    check('P8f a 1 s deadline aborts during preparation, quickly, running nothing', /deadline passed/.test(prepErr) && Date.now() - t1 < 15_000, `${prepErr} in ${Date.now() - t1}ms`);

    // Round-2 review 4: pipeChain never launches a producer after the consumer closed, and awaits launched ones.
    const child = () => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, kill() { this.killed = true; return true; } });
    const c = child(), p = child(), q = child();
    let launched = 0, resolved = false;
    const chain = __test.pipeChain([() => p, () => { launched++; return q; }], c).then((r) => { resolved = true; return r; });
    c.emit('close', 0);
    await sleep(10);
    const earlyResolve = resolved;
    p.emit('close', 0);
    const pr = await chain;
    check('P8g pipeChain: no producer launched after the consumer closed; the launched one was awaited, not abandoned',
      launched === 0 && !earlyResolve && pr.statuses[1] === 'not-run' && p.killed === true, JSON.stringify({ launched, earlyResolve, pr }));

    console.log('=== P9: fault injection with a fake docker on PATH (round-3 review) ===');
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'bug240-fakedocker-'));
    const ids64 = `sha256:${'a'.repeat(64)}`;
    fs.writeFileSync(path.join(fake, 'docker'), `#!/bin/bash
S="$FAKE_STATE"; echo "$*" >> "$S/calls"
case "$1" in
  ps) if [ "$FAKE_MODE" = sweep ]; then echo "cid1 1"; exit 0; fi; [ -e "$S/removed" ] || echo cid; exit 0;;
  container) if [ -e "$S/removed" ]; then echo "Error: No such container: $4" >&2; exit 1; fi; echo cid; exit 0;;
  rm) case "$FAKE_MODE" in sweep|rmfail) echo boom >&2; exit 1;; rmok) exit 0;; esac
      if [ ! -e "$S/tried" ]; then touch "$S/tried"; echo transient >&2; exit 1; fi; touch "$S/removed"; exit 0;;
  image) if [ "$3" = --format ]; then F="$4"; R="$5"; else F=""; R="$3"; fi
      case "$F" in
        '{{.Id}}') echo ${ids64};;
        '{{json .Config.Volumes}}') if [ "$R" = mutable:tag ]; then echo null; else echo '{"/data":{}}'; fi;;
      esac; exit 0;;
esac
exit 0
`, { mode: 0o755 });
    const fenv = (mode) => { const st = fs.mkdtempSync(path.join(fake, 's-')); return { st, env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, FAKE_STATE: st, FAKE_MODE: mode } }; };
    const { removeOrKeepReaper, spawnReaper, sweepExpired, ensureImage, makeBudget } = await import('./lib/confined-run.mjs');
    {
      const { env: e1 } = fenv('rmfail');
      const dummy = spawn('sleep', ['30']);
      const ok1 = removeOrKeepReaper(e1, 'cid', dummy);
      await sleep(200);
      const keptAlive = dummy.exitCode === null && dummy.signalCode === null;
      const { env: e2 } = fenv('rmok');
      const ok2 = removeOrKeepReaper(e2, 'cid', dummy);
      await sleep(200);
      check('P9a a failed removal KEEPS the reaper alive; a successful one kills it', ok1 === false && keptAlive && ok2 === true && dummy.signalCode === 'SIGKILL', JSON.stringify({ ok1, keptAlive, ok2, sig: dummy.signalCode }));
    }
    {
      const { st, env: e3 } = fenv('retry');
      spawnReaper(e3, 'cid', Math.floor(Date.now() / 1000));
      let removedAt = null;
      for (let i = 0; i < 30; i++) { await sleep(1000); if (fs.existsSync(path.join(st, 'removed'))) { removedAt = i + 1; break; } }
      check('P9b the reaper retries a failed removal until the container is gone', removedAt !== null && fs.existsSync(path.join(st, 'tried')), `removed after ${removedAt}s`);
    }
    {
      const { env: e4 } = fenv('volume-race');
      let raceErr = '';
      try { ensureImage(e4, fixture, 'mutable:tag', quiet, makeBudget(60)); } catch (e) { raceErr = e.message; }
      check('P9c VOLUME is validated on the resolved image ID, not the mutable tag (a retag cannot slip a VOLUME image in)', /declares VOLUME/.test(raceErr), raceErr || 'accepted');
    }
    {
      const { st, env: e5 } = fenv('sweep');
      const sw = sweepExpired(e5, makeBudget(60));
      check('P9d a sweep reports a failed removal as failed, not removed', sw.removed.length === 0 && sw.failed.length === 1, JSON.stringify(sw));
      fs.writeFileSync(path.join(st, 'calls'), '');
      const spent = { until: Date.now() - 1 };
      const sw2 = sweepExpired(e5, spent);
      const calls = fs.readFileSync(path.join(st, 'calls'), 'utf8').trim();
      check('P9e a spent budget makes the sweep issue no docker call at all', calls === '' && sw2.removed.length === 0, `calls: ${calls}`);
    }
    {
      // Round-7 review 1: a real run whose container cannot be removed must be reported FAILED.
      const realDocker = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).stdout.trim();
      const wrapDir = fs.mkdtempSync(path.join(fake, 'wrap-'));
      const flag = path.join(wrapDir, 'fail-rm');
      fs.writeFileSync(path.join(wrapDir, 'docker'), `#!/bin/bash\nif [ "$1" = rm ] && [ -e "${flag}" ]; then echo "injected removal failure" >&2; exit 1; fi\nexec "${realDocker}" "$@"\n`, { mode: 0o755 });
      fs.writeFileSync(flag, '');
      const wrapped = { ...process.env, PATH: `${wrapDir}:${process.env.PATH}` };
      const logs = [];
      const rr = await runConfined(['true'], { ...base, cwd: fixture, baseEnv: wrapped, log: (m) => logs.push(m), timeoutSec: 120 });
      fs.rmSync(flag);
      const leftId = (/container ([0-9a-f]{12})/.exec(logs.join('\n')) ?? [])[1];
      const stillThere = !!leftId && ours(sbxEnv, ['--filter', `id=${leftId}`]) !== '';
      if (leftId) spawnSync('docker', ['rm', '-f', leftId], { env: sbxEnv });
      check('P9f a successful command whose container cannot be removed is reported FAILED (cleanupFailed), not 0',
        rr.code !== 0 && rr.cleanupFailed === true && stillThere, JSON.stringify({ code: rr.code, cleanupFailed: rr.cleanupFailed, leftId, stillThere }));
    }
    console.log('=== P10: host-side preparation runs no project-configured program; ambiguous creates are reaped (round-8 review) ===');
    {
      const proj = path.join(fixture, 'fsm-proj');
      fs.mkdirSync(proj);
      const srcGit = fs.existsSync(path.join(os.homedir(), 'projects', 'methodology', '.git')) ? path.join(os.homedir(), 'projects', 'methodology', '.git') : path.join(REPO, '.git');
      fs.cpSync(srcGit, path.join(proj, '.git'), { recursive: true });
      const hookMark = path.join(fixture, 'FSMONITOR-RAN');
      fs.appendFileSync(path.join(proj, '.git', 'config'), `[core]\n\tfsmonitor = "touch ${hookMark}; false"\n`);
      fs.writeFileSync(path.join(proj, 'x.txt'), 'x');
      const fr = await runConfined(['sh', '-c', 'ls /work'], { ...base, cwd: proj });
      check('P10a a project whose git config sets core.fsmonitor to a program: the runner lists and ships the tree without running it on the host',
        fr.code === 0 && !fs.existsSync(hookMark) && /x\.txt/.test(fr.stdout), JSON.stringify({ code: fr.code, ran: fs.existsSync(hookMark), out: fr.stdout.slice(0, 80) }));
    }
    {
      const realDocker = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).stdout.trim();
      const wrapDir = fs.mkdtempSync(path.join(fake, 'lost-'));
      fs.writeFileSync(path.join(wrapDir, 'docker'), `#!/bin/bash\nif [ "$1" = create ]; then "${realDocker}" "$@" >/dev/null 2>&1; echo "injected: reply lost" >&2; exit 1; fi\nexec "${realDocker}" "$@"\n`, { mode: 0o755 });
      let lostErr = '';
      try { await runConfined(['true'], { ...base, cwd: fixture, baseEnv: { ...process.env, PATH: `${wrapDir}:${process.env.PATH}` }, timeoutSec: 120 }); } catch (e) { lostErr = e.message; }
      const left = ours(sbxEnv, ['--filter', `name=orchard-confined-${process.pid}-`]);
      if (left) spawnSync('docker', ['rm', '-f', ...left.split('\n')], { env: sbxEnv });
      check('P10b a create whose reply is lost (container made, failure reported) leaves no container: it is removed by its predetermined name',
        /create failed/.test(lostErr) && left === '', JSON.stringify({ lostErr: lostErr.slice(0, 120), left }));
    }
    {
      // Round-9 review 2: same size/mode/mtime, different bytes -> different cache key.
      const { depsKey, reapAmbiguous } = await import('./lib/confined-run.mjs');
      const dp = path.join(fixture, 'deps-proj');
      fs.mkdirSync(path.join(dp, 'node_modules', 'm'), { recursive: true });
      const fp = path.join(dp, 'node_modules', 'm', 'index.js');
      fs.writeFileSync(fp, 'module.exports=1'); fs.utimesSync(fp, 1000, 1000);
      const k1 = depsKey(dp, 'base');
      fs.writeFileSync(fp, 'module.exports=2'); fs.utimesSync(fp, 1000, 1000);
      const k2 = depsKey(dp, 'base');
      check('P10c a dependency edit that keeps size, mode and mtime still changes the run-image key', k1 !== k2, `${k1} ${k2}`);
      // Round-9 review 1: after a failed create, a reaper is left on the name even when nothing exists yet.
      const { st, env: e6 } = fenv('rmok');
      fs.writeFileSync(path.join(st, 'removed'), ''); // the fake says "No such container" from now on
      reapAmbiguous(e6, 'late-name', Math.floor(Date.now() / 1000));
      let sawReaper = false;
      for (let i = 0; i < 20 && !sawReaper; i++) { await sleep(500); sawReaper = /container inspect --format \{\{\.Id\}\} late-name/.test(fs.readFileSync(path.join(st, 'calls'), 'utf8')); }
      check('P10d after a failed create, a reaper re-checks the name at the expiry even if it did not exist yet (late materialisation)', sawReaper);
      // Round-10 review 1: the name appears only AFTER the expiry check; the grace window still removes it.
      const { st: st7, env: e7 } = fenv('late');
      fs.writeFileSync(path.join(st7, 'removed'), '');
      const { spawnReaper } = await import('./lib/confined-run.mjs');
      spawnReaper(e7, 'late-name-2', Math.floor(Date.now() / 1000), 15);
      await sleep(3000);
      fs.rmSync(path.join(st7, 'removed')); // now it "exists"
      let removedLate = false;
      for (let i = 0; i < 30 && !removedLate; i++) { await sleep(500); removedLate = fs.existsSync(path.join(st7, 'removed')); }
      check('P10e a name that materialises after the expiry check is still removed within the grace window', removedLate);
      // Round-10 review 2: a flat directory of many files is interrupted by a spent budget.
      const flat = path.join(fixture, 'flat-proj', 'node_modules');
      fs.mkdirSync(flat, { recursive: true });
      for (let k = 0; k < 50; k++) fs.writeFileSync(path.join(flat, `f${k}.js`), 'x');
      let flatErr = '';
      try { depsKey(path.dirname(flat), 'base', { until: Date.now() - 1 }); } catch (e) { flatErr = e.message; }
      check('P10f the dependency fingerprint stops on a spent budget inside a single directory', /deadline passed/.test(flatErr), flatErr || 'completed');
    }
    {
      // Round-10 review 3: a stalled staging copy is killed WITH its pipeline (no surviving child).
      const stallDir = fs.mkdtempSync(path.join(fake, 'stall-'));
      const marker = String(3000 + (process.pid % 997));
      fs.writeFileSync(path.join(stallDir, 'docker'), `#!/bin/bash\nif [ "$1" = cp ]; then exec sleep ${marker}; fi\nexit 0\n`, { mode: 0o755 });
      const src = path.join(fixture, 'stall-src');
      fs.mkdirSync(path.join(src, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(src, 'node_modules', 'a'), 'a');
      let stallCopyErr = '';
      const ts = Date.now();
      try { __test.tarInto({ ...process.env, PATH: `${stallDir}:${process.env.PATH}` }, src, 'node_modules', 'cid', '/opt', { until: Date.now() + 3000 }); } catch (e) { stallCopyErr = e.message; }
      await sleep(500);
      const survivors = spawnSync('pgrep', ['-f', `^sleep ${marker}$`], { encoding: 'utf8' }).stdout.trim();
      check('P10g a stalled staging copy times out and leaves no pipeline process alive', /timed out/.test(stallCopyErr) && survivors === '' && Date.now() - ts < 20_000, `${stallCopyErr} survivors=[${survivors}]`);
    }
    fs.rmSync(fake, { recursive: true, force: true });

    console.log('=== CONTROL: the host write SUCCEEDS through a plain docker run on the FEAT-158 sandbox ===');
    const ctl = spawnSync('docker', ['run', '--rm', '-v', `${victim}:${victim}`, 'alpine', 'sh', '-c', `echo pwn > ${victim}/keep.txt`], { env: sbxEnv, encoding: 'utf8' });
    const changed = (() => { try { return fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8') === 'pwn\n'; } catch { return false; } })();
    check('CONTROL a container on the FEAT-158 sandbox writes a host /tmp path [must-FAIL the property]', ctl.status === 0 && changed, ctl.stderr);
  } finally {
    try { fs.chmodSync(path.join(fixture, 'unreadable', 'secret'), 0o600); } catch { /* absent */ }
    fs.rmSync(fixture, { recursive: true, force: true });
  }

  console.log(`\n== ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(`FATAL: ${e.stack || e.message}`); process.exit(2); });
