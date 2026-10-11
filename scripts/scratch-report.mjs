#!/usr/bin/env node
/**
 * scratch-report.mjs — READ-ONLY INVENTORY of the tooling scratch root
 * (scripts/lib/scratch.mjs). BUG-250: there is NO autonomous sweep; recurrence
 * of leaked clean rooms is stopped at the source (independent-verify.mjs cleans
 * its own room crash-safely). This is how an OPERATOR sizes the legacy backlog.
 *
 * It DELETES NOTHING, EMITS NO EXECUTABLE COMMAND, and MAKES NO LIVENESS/SAFETY
 * CLAIM (BUG-250 round-5 RESCOPE). Earlier versions tried to pre-compute which
 * dirs were "safe to delete" by enumerating holders (/proc fd/cwd/root, mounts);
 * that is the SAME unbounded "is anything using this subtree right now?" question
 * that has no sound answer in user-space on a shared filesystem — it broke twice
 * (top-level `fuser` / no mount scan; then bind-mount-alias cwd / exe+maps
 * holders). A claim that cannot be soundly computed must not be made. So this
 * tool only reports FACTS — name, ctime age, and the TRUE btrfs-EXCLUSIVE cost
 * (reflink-aware; the figure that corrects the original 282G-vs-40KiB `du`
 * misdiagnosis) — and tells the operator to establish liveness themselves.
 *
 *   node scripts/scratch-report.mjs                 # inventory; NUL list on stdout
 *   node scripts/scratch-report.mjs --newline       # newline list (interactive eyeballing)
 *   node scripts/scratch-report.mjs --age-days 30   # list only dirs older than 30d
 *   node scripts/scratch-report.mjs --all           # also list non-cleanroom children (context)
 *   node scripts/scratch-report.mjs --root <dir>    # a specific root
 *   node scripts/scratch-report.mjs --no-cost       # skip the (slow) btrfs du
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scratchRoot, scratchRootInfo } from './lib/scratch.mjs';

const argv = process.argv.slice(2);
const opts = { root: null, ageDays: 0, all: false, cost: true, print0: true };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--root') opts.root = argv[++i];
  else if (a === '--age-days') opts.ageDays = Number(argv[++i]);
  else if (a === '--all') opts.all = true;
  else if (a === '--no-cost') opts.cost = false;
  else if (a === '--print0') opts.print0 = true;
  else if (a === '--newline') opts.print0 = false;
  else if (a === '--help' || a === '-h') { console.log('usage: node scripts/scratch-report.mjs [--age-days <n>] [--all] [--newline] [--root <dir>] [--no-cost]'); process.exit(0); }
  else { console.error(`unknown argument ${a}`); process.exit(2); }
}

let root = opts.root;
let info = null;
if (!root) { try { info = scratchRootInfo(); root = info.dir; } catch { root = scratchRoot(); } }

// Everything human goes to STDERR; STDOUT carries ONLY the path list, so
// `scratch-report | xargs -0 ...` is clean and nothing else leaks into it.
const say = (m) => process.stderr.write(m + '\n');

if (!fs.existsSync(root)) { say(`scratch root does not exist: ${root}`); process.exit(0); }

function btrfsExclusive(p) {
  const r = spawnSync('btrfs', ['filesystem', 'du', '-s', '--raw', p], { encoding: 'utf8' });
  if (r.error || (r.status ?? 1) !== 0) return null;
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  const cols = (lines[lines.length - 1] || '').trim().split(/\s+/);
  const excl = Number(cols[1]);
  return Number.isFinite(excl) ? excl : null;
}
const fmt = (n) => n == null ? 'n/a' : n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KiB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)}MiB` : `${(n / 1073741824).toFixed(2)}GiB`;

const now = Date.now();
const ageMs = opts.ageDays * 24 * 60 * 60 * 1000;
let names;
try { names = fs.readdirSync(root); } catch (e) { say(`cannot read scratch root: ${e.message}`); process.exit(1); }

// Pure inventory: name + ctime age, no holder/mount probe anywhere.
const rows = [];
for (const name of names) {
  if (name.startsWith('.trash-') || name === '.claude-station-scratch-root') continue;
  const isCleanroom = name.startsWith('cleanroom-verify-') || name.startsWith('cleanroom-record-');
  if (!isCleanroom && !opts.all) continue;
  const full = path.join(root, name);
  let lst; try { lst = fs.lstatSync(full); } catch { continue; }
  if (lst.isSymbolicLink()) continue; // a symlink is not a clean room; never list it
  const age = now - lst.ctimeMs;
  if (isCleanroom && age < ageMs) continue; // age filter applies to the cleanroom list
  rows.push({ name, full, isCleanroom, ageDays: age / 86400000 });
}

const cleanroom = rows.filter((r) => r.isCleanroom);

say('='.repeat(78));
say('scratch INVENTORY — this is NOT a safety check.');
say('This tool does NOT and CANNOT prove that nothing is using a directory.');
say('Before removing ANY path below, YOU must, per directory:');
say('  1. run `fuser -m <dir>` (and check cwd/exe/maps holders) — confirm no live process uses it;');
say('  2. verify no mount point is at or under it (e.g. `findmnt -R <dir>` or grep /proc/self/mountinfo).');
say('The tool runs nothing and clears nothing. Cleanup is entirely manual.');
say('='.repeat(78));
say(`root: ${root}${info ? ` (${info.source}${info.degraded ? ', DEGRADED' : ''})` : ''}`);
say(`cleanroom-* dirs${opts.ageDays ? ` older than ${opts.ageDays}d` : ''}: ${cleanroom.length}${opts.all ? `  ·  other children listed for context: ${rows.length - cleanroom.length}` : ''}`);
if (opts.cost) {
  const excl = btrfsExclusive(root);
  say(`TRUE cost of the whole root (btrfs EXCLUSIVE, reflink-aware — NOT raw du): ${fmt(excl)}${excl != null && excl < 1048576 ? ' — deleting everything frees ~this; the rest is reflink-shared with the repo' : ''}`);
  if (excl == null) say('(btrfs filesystem du unavailable — exclusive cost unknown; raw du would OVER-count reflinked bytes and is deliberately not shown)');
}
// Per-dir ages to stderr (human view); oldest first.
for (const r of [...rows].sort((a, b) => b.ageDays - a.ageDays)) {
  say(`  ${r.ageDays.toFixed(1).padStart(7)}d  ${r.name}${r.isCleanroom ? '' : '  (non-cleanroom; context only)'}`);
}
say('');
say('Path list on STDOUT (NUL-separated by default). Example once YOU have checked each dir:');
say('  node scripts/scratch-report.mjs --print0 | <your review> | xargs -0 -r -- rm -rf --');
say(`(${cleanroom.length} cleanroom path(s) on stdout)`);

// STDOUT: cleanroom paths only, NUL-separated by default (safe for any name).
const sep = opts.print0 ? '\0' : '\n';
const list = cleanroom.map((r) => r.full);
if (list.length) process.stdout.write(list.join(sep) + sep);
