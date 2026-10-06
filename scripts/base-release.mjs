#!/usr/bin/env node
/**
 * FEAT-157 — cut a numbered Orchard base release.
 *
 *   npm run base:release -- --class=feature|fix|security --summary='…' --adjust='…' \
 *                           [--verify=<package>:<min-version> …] [--dry-run]
 *
 * Snapshots the working-tree base recipe (src/server/container/{Dockerfile,
 * provision.json}) into src/server/container/releases/v{N+1}/ and appends one
 * entry to src/server/container/base-releases.json. Both are committed files;
 * this script does not commit. The catalog is APPEND-ONLY: nothing here edits or
 * removes an existing entry.
 *
 * Refusals (exit 1): the catalog does not parse; the recipe is unchanged since
 * the newest release and the class is not `security` (a security release may
 * re-freeze the same recipe: it is a forced --no-cache --pull rebuild that must
 * prove its `--verify` packages moved); a security release with no --verify; the
 * snapshot directory already exists.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseCatalog, catalogPath, containerDir, releaseDir, RELEASE_CLASSES } from '../src/server/base-releases.ts';
import { recipeHash } from '../src/server/provisioning.ts';

function args(argv) {
  const out = { verify: [] };
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(a);
    if (!m) { out.bad = a; continue; }
    if (m[1] === 'verify') out.verify.push(m[2] ?? '');
    else out[m[1]] = m[2] ?? true;
  }
  return out;
}

function fail(msg) { console.error(`base:release: ${msg}`); process.exit(1); }

const a = args(process.argv.slice(2));
if (a.bad) fail(`unexpected argument ${JSON.stringify(a.bad)}`);
if (!RELEASE_CLASSES.includes(a.class)) fail(`--class must be one of ${RELEASE_CLASSES.join(', ')}`);
if (typeof a.summary !== 'string' || !a.summary.trim()) fail('--summary is required');
if (typeof a.adjust !== 'string') fail('--adjust is required (say what a project Dockerfile may need to change, or "Nothing to change.")');
const verify = a.verify.map((s) => {
  const i = s.indexOf(':');
  if (i <= 0) fail(`--verify=${s} must be <package>:<min-version>`);
  return { package: s.slice(0, i), minVersion: s.slice(i + 1) };
});
if (a.class === 'security' && !verify.length) fail('a security release must name at least one --verify=<package>:<min-version> it moves');

const file = catalogPath();
const raw = fs.readFileSync(file, 'utf8');
const cat = parseCatalog(raw);
if (!cat.ok) fail(cat.error);
const hash = recipeHash(containerDir());
if (hash === cat.newest.hash && a.class !== 'security') {
  fail(`the working-tree recipe (${hash}) is identical to v${cat.newest.version}; nothing to release (a security re-freeze of the same recipe needs --class=security)`);
}
const version = cat.newest.version + 1;
const dir = releaseDir(version);
if (fs.existsSync(dir)) fail(`${dir} already exists`);
const entry = {
  version,
  date: new Date().toISOString().slice(0, 10),
  class: a.class,
  summary: a.summary.trim(),
  adjust: a.adjust.trim(),
  hash,
  ...(verify.length ? { verify } : {}),
};
const j = JSON.parse(raw);
j.releases.push(entry);
const next = `${JSON.stringify(j, null, 2)}\n`;
const check = parseCatalog(next);
if (!check.ok) fail(`the new entry does not validate: ${check.error}`);
if (a['dry-run']) { console.log(JSON.stringify({ dryRun: true, entry, snapshot: dir }, null, 2)); process.exit(0); }
fs.mkdirSync(dir, { recursive: true });
for (const f of ['Dockerfile', 'provision.json']) fs.copyFileSync(path.join(containerDir(), f), path.join(dir, f));
if (recipeHash(dir) !== hash) fail(`the snapshot at ${dir} does not hash to ${hash} (the tree changed while copying); remove it and retry`);
const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, next);
fs.renameSync(tmp, file);
console.log(JSON.stringify({ ok: true, entry, snapshot: dir }, null, 2));
