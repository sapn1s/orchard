#!/usr/bin/env node
/**
 * BUG-240 — run a command confined: no host mount, no capability, no network.
 * Works from any Orchard project's directory (it ships the cwd's tree).
 *
 *   node <orchard>/scripts/confined-run.mjs [options] -- <cmd> [args...]
 *   npm run confined -- [options] -- <cmd> [args...]          (inside Orchard)
 *
 * Options:
 *   --cwd <dir>         project dir to ship (default: the current directory)
 *   --subdir <rel>      working directory inside the shipped tree (default: its root)
 *   --image <ref>       base image (default node:24-bookworm). Contract: /bin/sh and
 *                       tar; git/node used when present; images with VOLUMEs refused.
 *                       The confinement is the runner's fixed docker flags.
 *   --out <path>        after the run, copy this /work-relative path back into a
 *                       fresh dir under the scratch root (regular files only)
 *   --env K=V           extra env inside (repeatable; the host env is NOT passed)
 *   --ship D[:DEST]     copy host dir D in (repeatable; a copy, never a mount).
 *                       DEST ~/x lands under the container HOME; omitted, D must
 *                       be under $HOME and is mirrored there (~/projects/methodology)
 *   --timeout-sec N     deadline for the whole run (default 6 h); the daemon removes
 *                       the container at the deadline even if this process dies
 *   --memory-mb N --work-mb N --pids N --cpus N --out-mb N
 *                       caps (defaults 4096 / 2048 / 2048 / 2 / 512); --out larger
 *                       than --out-mb is refused and fails the run
 *   --no-git            do not ship the project's .git
 *   --allow-userns      per-invocation opt-in (ARCH-021 D1): seccomp = the pinned Docker
 *                       default plus unshare/setns/mount/umount2/pivot_root/clone, so
 *                       bwrap and `unshare -U` work inside. Nothing else changes.
 *
 * See scripts/lib/confined-run.mjs for what "confined" means and why.
 */
import { runConfined } from './lib/confined-run.mjs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const head = sep === -1 ? argv : argv.slice(0, sep);
const cmd = sep === -1 ? [] : argv.slice(sep + 1);
const opts = { env: [] };
for (let i = 0; i < head.length; i++) {
  const a = head[i], next = () => { if (i + 1 >= head.length) die(`${a} needs a value`); return head[++i]; };
  if (a === '--cwd') opts.cwd = next();
  else if (a === '--subdir') opts.subdir = next();
  else if (a === '--image') opts.image = next();
  else if (a === '--out') opts.out = next();
  else if (a === '--env') opts.env.push(next());
  else if (a === '--ship') (opts.ship ??= []).push(next());
  else if (a === '--timeout-sec') opts.timeoutSec = Number(next());
  else if (a === '--no-git') opts.withGit = false;
  else if (a === '--allow-userns') opts.allowUserns = true;
  else if (a === '--memory-mb') (opts.limits ??= {}).memoryMb = Number(next());
  else if (a === '--work-mb') (opts.limits ??= {}).workMb = Number(next());
  else if (a === '--pids') (opts.limits ??= {}).pids = Number(next());
  else if (a === '--cpus') (opts.limits ??= {}).cpus = Number(next());
  else if (a === '--out-mb') (opts.limits ??= {}).outMb = Number(next());
  else if (a === '-h' || a === '--help') { console.log('usage: confined-run.mjs [--cwd D] [--subdir R] [--image I] [--out P] [--env K=V]... [--timeout-sec N] [--no-git] [--allow-userns] -- <cmd> [args...]'); process.exit(0); }
  else die(`unknown option ${a} (put the command after --)`);
}
if (!cmd.length) die('no command: put it after --');

function die(m) { console.error(`confined-run: ${m}`); process.exit(2); }

try {
  const r = await runConfined(cmd, opts);
  if (r.outDir) console.error(`[confined-run] out: ${r.outDir}`);
  process.exit(r.code);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
