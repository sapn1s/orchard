#!/usr/bin/env node
/**
 * BUG-289 independent-verify harness (authored by the verify lane — the fixer
 * committed no resolver script). Drives the REAL sandboxDataRoot()/detectFsType()
 * against REAL host filesystems (btrfs /, ext4 /mnt/backup, vfat /boot) plus the
 * crafted attack inputs. Touches NO docker daemon — only findmnt/statfs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sandboxDataRoot, detectFsType, resolveDataPath, DIND_OK_FS,
  SANDBOX_DATA_ENV, SANDBOX_DATA_BASE_ENV,
} from './lib/docker-sandbox.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`PASS ${name} ${extra}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

// Ground the test on the real host (skip gracefully if a mount is absent in the clean room).
const btrfs = detectFsType('/');
const ext4 = detectFsType('/mnt/backup');
const vfat = detectFsType('/boot');
console.log(`host fs: / = ${btrfs}, /mnt/backup = ${ext4}, /boot = ${vfat}`);
console.log(`DIND_OK_FS = ${[...DIND_OK_FS].join(',')}`);

// 1. default (no env): /backups absent on this host -> fall back to volume + visible warning.
{
  const r = sandboxDataRoot({});
  ok('default-falls-back-to-volume', r.mode === 'volume' && typeof r.warning === 'string' && r.warning.length > 0, JSON.stringify(r));
}

// 2. explicit ext4 path (a dedicated orchard-docker-sandbox dir) -> bind, no daemon reach.
if (ext4 === 'ext4') {
  const r = sandboxDataRoot({ [SANDBOX_DATA_ENV]: '/mnt/backup/orchard-docker-sandbox' });
  ok('explicit-ext4-bind', r.mode === 'bind' && r.dir === '/mnt/backup/orchard-docker-sandbox' && r.fsType === 'ext4', JSON.stringify(r));
} else ok('explicit-ext4-bind', false, 'SKIP: /mnt/backup not ext4 in cleanroom');

// 2b. a bare (non-dedicated) ext4 path -> REFUSE (must be a dedicated orchard-docker-sandbox dir).
if (ext4 === 'ext4') {
  const msg = threw(() => sandboxDataRoot({ [SANDBOX_DATA_ENV]: '/mnt/backup' }));
  ok('bare-dir-refused', msg !== null && /dedicated directory named orchard-docker-sandbox/.test(msg), msg || 'did-not-throw');
} else ok('bare-dir-refused', false, 'SKIP');

// 3. explicit RELATIVE path -> THROW (never a silent cwd-relative dir).
{
  const msg = threw(() => sandboxDataRoot({ [SANDBOX_DATA_ENV]: 'relative/path' }));
  ok('relative-throws', msg !== null && /absolute/i.test(msg), msg || 'did-not-throw');
}

// 4. explicit vfat path -> THROW (dind cannot back overlay2 on vfat).
if (vfat === 'vfat') {
  const msg = threw(() => sandboxDataRoot({ [SANDBOX_DATA_ENV]: '/boot' }));
  ok('vfat-throws', msg !== null && /vfat|overlay|ext4\/xfs\/btrfs/i.test(msg), msg || 'did-not-throw');
} else ok('vfat-throws', false, 'SKIP: /boot not vfat in cleanroom');

// 5. base env -> bind under <base>/orchard-docker-sandbox.
if (ext4 === 'ext4') {
  const r = sandboxDataRoot({ [SANDBOX_DATA_BASE_ENV]: '/mnt/backup' });
  ok('base-ext4-bind', r.mode === 'bind' && r.dir === path.join('/mnt/backup', 'orchard-docker-sandbox'), JSON.stringify(r));
} else ok('base-ext4-bind', false, 'SKIP');

// 6. ATTACK: symlink whose target is a disallowed fs -> findmnt resolves it -> THROW.
if (vfat === 'vfat') {
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bug289-')), 'lnk');
  fs.symlinkSync('/boot', link);
  const msg = threw(() => sandboxDataRoot({ [SANDBOX_DATA_ENV]: link }));
  ok('symlink-to-vfat-throws', msg !== null && /vfat|overlay|ext4\/xfs\/btrfs/i.test(msg), msg || 'did-not-throw (symlink slipped a disallowed fs through)');
} else ok('symlink-to-vfat-throws', false, 'SKIP');

// 7. ATTACK: the HOST daemon data-root and the filesystem root must be REFUSED as the dind
//    store device= (round-2 anthropic: both were accepted on fs grounds alone, which would
//    run the privileged sandbox daemon on the host's own store — contract 4).
for (const p of ['/var/lib/docker', '/', '/etc']) {
  const msg = threw(() => sandboxDataRoot({ [SANDBOX_DATA_ENV]: p }));
  ok(`host/system-path-refused(${p})`, msg !== null && /(dedicated directory named orchard-docker-sandbox|ext4\/xfs\/btrfs|absolute)/.test(msg), msg || 'did-not-throw');
}

// 8. resolver never constructs a DOCKER_HOST / reaches a daemon: its return carries only
//    mode/dir/fsType/warning, never a socket or host endpoint.
{
  const r = sandboxDataRoot({ [SANDBOX_DATA_ENV]: '/mnt/backup/orchard-docker-sandbox' });
  const keys = Object.keys(r).sort().join(',');
  ok('resolver-returns-no-daemon-endpoint', !/docker_host|sock|unix:|tcp:/i.test(JSON.stringify(r)), keys);
}

// ---- ROUND 2 adversarial (the holes anthropic 0a421f57 + openai c232b772 found) ----
const tmpfs = detectFsType('/dev/shm'); // a disallowed fs readable in the clean room (stands in for vfat)
console.log(`round-2 disallowed-fs probe: /dev/shm = ${tmpfs}`);

// 9. dangling symlink to a disallowed fs -> REFUSE (existsSync treated it as missing before).
if (tmpfs && tmpfs !== 'btrfs') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b289r2-'));
  const link = path.join(dir, 'dangling');
  fs.symlinkSync('/dev/shm/orchard-not-yet-created', link); // dangling, target on tmpfs
  const msg = threw(() => sandboxDataRoot({ [SANDBOX_DATA_ENV]: link }));
  ok('dangling-symlink-to-disallowed-fs-refused', msg !== null && new RegExp(`${tmpfs}|ext4\\/xfs\\/btrfs`).test(msg), msg || 'did-not-throw');
} else ok('dangling-symlink-to-disallowed-fs-refused', false, 'SKIP: no readable disallowed fs');

// 10. `..` AFTER a symlink component must NOT be collapsed lexically before the symlink is followed.
if (tmpfs && tmpfs !== 'btrfs') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'b289r2-')); // /tmp fs
  const shm = fs.mkdtempSync(path.join('/dev/shm', 'b289r2-'));
  fs.mkdirSync(path.join(shm, 'sub'), { recursive: true });
  fs.symlinkSync(path.join(shm, 'sub'), path.join(base, 'lnk'));
  const attack = `${base}/lnk/../data`; // lexically base/data; kernel follows lnk -> lands on tmpfs
  const msg = threw(() => sandboxDataRoot({ [SANDBOX_DATA_ENV]: attack }));
  ok('dotdot-after-symlink-not-collapsed', msg !== null && new RegExp(`${tmpfs}|ext4\\/xfs\\/btrfs`).test(msg), msg || `did-not-throw (resolved ${resolveDataPath(attack)})`);
  fs.rmSync(shm, { recursive: true, force: true });
} else ok('dotdot-after-symlink-not-collapsed', false, 'SKIP');

// 11. base mode grades <base>/orchard-docker-sandbox, not just <base>: a dangling store-subdir
//     symlink to a disallowed fs -> volume fallback (not an accepted btrfs bind).
if (tmpfs && tmpfs !== 'btrfs') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'b289r2-'));
  fs.symlinkSync('/dev/shm/orchard-store-not-yet', path.join(base, 'orchard-docker-sandbox'));
  const r = sandboxDataRoot({ [SANDBOX_DATA_BASE_ENV]: base });
  ok('base-store-subdir-symlink-graded', r.mode === 'volume' && new RegExp(`${tmpfs}|undetectable|ext4\\/xfs\\/btrfs`).test(r.warning ?? ''), JSON.stringify(r));
} else ok('base-store-subdir-symlink-graded', false, 'SKIP');

// 12. symlink loop -> REFUSE (never spins / passes).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b289r2-'));
  const a = path.join(dir, 'a'), b = path.join(dir, 'b');
  fs.symlinkSync(b, a); fs.symlinkSync(a, b);
  const msg = threw(() => sandboxDataRoot({ [SANDBOX_DATA_ENV]: a }));
  ok('symlink-loop-refused', msg !== null && /loop|too many/i.test(msg), msg || 'did-not-throw');
}

// 13. symlink-to-symlink to a disallowed fs -> REFUSE (chain followed).
if (tmpfs && tmpfs !== 'btrfs') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b289r2-'));
  const l1 = path.join(dir, 'l1'), l2 = path.join(dir, 'l2');
  fs.symlinkSync('/dev/shm/orchard-not-yet', l1);
  fs.symlinkSync(l1, l2);
  const msg = threw(() => sandboxDataRoot({ [SANDBOX_DATA_ENV]: l2 }));
  ok('symlink-to-symlink-refused', msg !== null && new RegExp(`${tmpfs}|ext4\\/xfs\\/btrfs`).test(msg), msg || 'did-not-throw');
} else ok('symlink-to-symlink-refused', false, 'SKIP');

// 14. EACCES-hidden symlink: a symlink inside an unsearchable (0600) dir must REFUSE,
//     never be treated as absent and finished lexically (round-2 anthropic finding).
if (tmpfs && tmpfs !== 'btrfs' && typeof process.getuid === 'function' && process.getuid() !== 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b289r2-'));
  const locked = path.join(dir, 'locked');
  fs.mkdirSync(locked);
  fs.symlinkSync('/dev/shm/orchard-not-yet', path.join(locked, 'lnk'));
  fs.chmodSync(locked, 0o600); // remove search (x): lstat of its children -> EACCES
  const attack = `${locked}/lnk/store`;
  const msg = threw(() => sandboxDataRoot({ [SANDBOX_DATA_ENV]: attack }));
  fs.chmodSync(locked, 0o700); // restore so cleanup can remove it
  ok('eacces-hidden-symlink-refused', msg !== null && /cannot stat|EACCES|permission/i.test(msg), msg || `did-not-throw (resolved ${resolveDataPath(attack)})`);
} else ok('eacces-hidden-symlink-refused', false, 'SKIP: needs non-root + a disallowed fs');

// 15. `..` AFTER a MISSING component climbs back to an existing dir whose next component
//     is a dangling symlink to a disallowed fs -> must still be followed and REFUSED
//     (round-2 anthropic: the old lexical-finish shortcut skipped it, grading btrfs).
if (tmpfs && tmpfs !== 'btrfs') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'b289r2-'));
  fs.symlinkSync('/dev/shm/orchard-notyet', path.join(base, 'lnk')); // dangling -> tmpfs
  const attack = `${base}/missing/../lnk`; // 'missing' absent; '..' returns to base; 'lnk' is the symlink
  const msg = threw(() => sandboxDataRoot({ [SANDBOX_DATA_ENV]: attack }));
  ok('dotdot-after-missing-then-dangling-symlink-refused', msg !== null && new RegExp(`${tmpfs}|ext4\\/xfs\\/btrfs`).test(msg), msg || `did-not-throw (resolved ${resolveDataPath(attack)})`);
} else ok('dotdot-after-missing-then-dangling-symlink-refused', false, 'SKIP');

// 16. returned dir must NEVER be a symlink (what up() mkdir -p's and feeds to device=).
if (ext4 === 'ext4') {
  const r = sandboxDataRoot({ [SANDBOX_DATA_ENV]: '/mnt/backup/orchard-docker-sandbox' });
  let isLink = false;
  try { isLink = fs.lstatSync(r.dir).isSymbolicLink(); } catch { /* absent tail is fine */ }
  ok('returned-dir-not-a-symlink', r.mode === 'bind' && !isLink, `${r.dir}`);
} else ok('returned-dir-not-a-symlink', false, 'SKIP');

// 17. BASE mode must apply the SAME dedicated-dirname guard: <base>/orchard-docker-sandbox
//     being a symlink (on an allowed fs) to /var/lib/docker, / or /etc must NOT bind there —
//     it falls back to the safe volume default (round-2 anthropic: base skipped the check).
for (const tgt of ['/var/lib/docker', '/', '/etc']) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'b289base-'));
  fs.symlinkSync(tgt, path.join(base, 'orchard-docker-sandbox'));
  const r = sandboxDataRoot({ [SANDBOX_DATA_BASE_ENV]: base });
  ok(`base-store-symlink-to-${tgt}-not-bound`, r.mode === 'volume', JSON.stringify(r));
}

// 18. a RELATIVE base must never become a silent cwd-relative bind -> safe volume fallback.
{
  const r = sandboxDataRoot({ [SANDBOX_DATA_BASE_ENV]: 'relative-base-dir' });
  ok('relative-base-not-bound', r.mode === 'volume' && /absolute/.test(r.warning ?? ''), JSON.stringify(r));
}

console.log(`\nBUG-289 resolver: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
