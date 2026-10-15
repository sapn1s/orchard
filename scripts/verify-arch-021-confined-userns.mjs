#!/usr/bin/env node
/**
 * ARCH-021 D1 — the confined runner's `--allow-userns` opt-in is NARROW.
 *
 *   node scripts/verify-arch-021-confined-userns.mjs        (sandbox daemon; host-run)
 *
 * Proves:
 *   U1 the default flags are byte-identical to the pre-change flags (pinned below) and
 *      carry no seccomp override; the default run still REFUSES a user namespace;
 *   U2 the opt-in adds exactly `--security-opt seccomp=<file>` + one label, and the
 *      profile is the sha256-pinned Docker default plus ONE rule naming exactly the
 *      userns syscalls;
 *   U3 under the opt-in a user namespace works (non-vacuity: the probe CAN succeed),
 *      while capability gain, a container-namespace mount/remount/umount (raw
 *      syscalls), a rootfs write, a setns into the init userns, every host-mount
 *      escape and every network attempt still fail.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confinementFlags, usernsSeccompProfile, runConfined, USERNS_SYSCALLS, SECCOMP_DEFAULT_PATH } from './lib/confined-run.mjs';
import * as fs from 'node:fs';
import * as os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, m, seen) => { if (c) { pass++; console.log(`PASS ${m}${seen !== undefined ? ` (saw ${JSON.stringify(seen)})` : ''}`); } else { fail++; console.log(`FAIL ${m}${seen !== undefined ? ` (saw ${JSON.stringify(seen)})` : ''}`); } };

// Pre-change default flags (scripts/lib/confined-run.mjs before ARCH-021), pinned literally.
const PRE_DEFAULT = ['--rm', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--network', 'none', '--ipc', 'private', '--read-only', '--no-healthcheck',
  '--tmpfs', '/work:rw,exec,nosuid,nodev,size=2048m,uid=1000,gid=1000,mode=0755', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1024m,mode=1777',
  '--pids-limit', '2048', '--cpus', '2', '--memory', '4096m', '--memory-swap', '4096m', '--log-driver', 'none', '--label', 'orchard.confined-run=1'];

// U1/U2 static.
const def = confinementFlags();
ok(JSON.stringify(def) === JSON.stringify(PRE_DEFAULT), 'U1 default flags identical to the pre-change flags');
ok(!def.some((x) => /seccomp/.test(x)), 'U1 default carries no seccomp override');
const opt = confinementFlags({}, { seccompProfile: '/p.json' });
ok(JSON.stringify(opt.slice(0, PRE_DEFAULT.length)) === JSON.stringify(PRE_DEFAULT), 'U2 opt-in keeps every default flag, in order');
ok(JSON.stringify(opt.slice(PRE_DEFAULT.length)) === JSON.stringify(['--security-opt', 'seccomp=/p.json', '--label', 'orchard.confined-run.userns=1']), 'U2 opt-in adds only the seccomp file and a label', opt.slice(PRE_DEFAULT.length));
const base = JSON.parse(fs.readFileSync(SECCOMP_DEFAULT_PATH, 'utf8'));
const prof = usernsSeccompProfile();
ok(JSON.stringify(prof.syscalls.slice(0, base.syscalls.length)) === JSON.stringify(base.syscalls) && prof.defaultAction === base.defaultAction, 'U2 profile = pinned default unchanged');
const extra = prof.syscalls.slice(base.syscalls.length);
ok(extra.length === 1 && extra[0].action === 'SCMP_ACT_ALLOW' && !extra[0].args && !extra[0].includes && JSON.stringify(extra[0].names) === JSON.stringify(USERNS_SYSCALLS), 'U2 exactly one added rule, exactly the userns syscalls', extra.map((e) => e.names));
ok(!extra[0].names.some((n) => ['bpf', 'keyctl', 'ptrace', 'perf_event_open', 'open_tree', 'move_mount', 'fsopen', 'init_module', 'kexec_load'].includes(n)), 'U2 no unrelated dangerous syscall opened');

// Live.
const probe = (allowUserns) => runConfined(['sh', 'scripts/fixtures/arch-021/userns-probe.sh'], { cwd: ROOT, withGit: false, allowUserns, env: [`HOST_USER=${os.userInfo().username}`], capture: true, timeoutSec: 600, log: () => {} });
const parse = (s) => Object.fromEntries(s.split('\n').filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const d = parse((await probe(false)).stdout);
ok(Object.keys(d).length >= 15, 'U1 default probe produced its lines', Object.keys(d).length);
ok(/^refused/.test(d.USERNS ?? ''), 'U1 default runner still refuses a user namespace', d.USERNS);
const o = parse((await probe(true)).stdout);
ok(Object.keys(o).length >= 15, 'U3 opt-in probe produced its lines', Object.keys(o).length);
ok(o.USERNS === 'ok' && o.USERNS_MNT === 'ok', 'U3 opt-in: user + mount namespace work (non-vacuity)', [o.USERNS, o.USERNS_MNT]);
ok(o.CAPEFF === '0000000000000000', 'U3 capability gain: CapEff stays 0', o.CAPEFF);
ok(o.NNP === '1' && o.SECCOMP === '2', 'U3 no-new-privileges and seccomp filter still on', [o.NNP, o.SECCOMP]);
for (const k of ['MOUNT_CONTAINER_NS', 'REMOUNT_ROOT_RW', 'UMOUNT_WORK_CONTAINER_NS']) ok(/^refused:errno:Operation not permitted/.test(o[k] ?? ''), `U3 raw ${k} -> EPERM (kernel, not util-linux)`, o[k]);
for (const k of ['SETNS_INIT_USERNS', 'USERNS_REMOUNT_ROOT', 'USERNS_REMOUNT_ROOT_RAW', 'WRITE_ETC']) ok(/^refused/.test(o[k] ?? ''), `U3 capability/rootfs: ${k} refused`, o[k]);
ok(o.HOST_DOCKER_SOCK === '' && o.BLOCKDEVS === '' && o.HOST_HOME_EXISTS === 'no', 'U3 host-mount escape: no docker socket, no block device, no host home', [o.HOST_DOCKER_SOCK, o.BLOCKDEVS, o.HOST_HOME_EXISTS]);
for (const k of ['USERNS_MOUNT_BLOCK', 'PROC1_ROOT_HOME', 'USERNS_PROC_MOUNT']) ok(/^refused/.test(o[k] ?? ''), `U3 host-mount escape: ${k} refused`, o[k]);
ok(o.IFACES.trim() === 'lo', 'U3 network: only loopback', o.IFACES);
for (const k of ['NET_TCP', 'USERNS_NET_TCP']) ok(/^refused/.test(o[k] ?? ''), `U3 network: ${k} refused`, o[k]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
