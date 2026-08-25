#!/usr/bin/env node
/**
 * verify-docs-fresh.mjs — §C proof for the docs-freshness checker (FEAT-075 2b).
 *
 * Everything runs in TEMP trees (scratch root + scratch guide dir + scratch
 * source files) — never the real repo files, never a server, never a fixed port.
 * The checker resolves each declared source against a configurable `rootDir`, so
 * the MUST-FAIL case mutates a SCRATCH copy of a source, not the real file.
 *
 * Cases:
 *   (a) fresh bless → 0 stale.
 *   (b) MUST-FAIL — mutate a referenced source → EXACTLY that doc+source flags
 *       `changed`, and (the must-FAIL half) a presence-only checker that does NOT
 *       recompute the blob hash would stay SILENT — the hash recompute is the
 *       whole mechanism, proven by the flip clean→stale.
 *   (c) `--bless <doc>` re-pins → clears that doc's staleness.
 *   (d) a source removed from disk → reported `missing`.
 *   (e) a doc whose sources are all unchanged NEVER false-flags.
 *   (f) REALISTIC busy-state fixture — mirrors the real guide: 5 docs, many
 *       shared sources, with SEVERAL simultaneous drifts (two changed, one
 *       missing, one newly-added-unblessed) + untouched docs. Asserts the
 *       checker reports the EXACT stale set with zero false positives on the
 *       docs that did not move — the "what does this look like after real use"
 *       state, not just the minimal one-source case.
 *   (g) CLI end-to-end — the real scripts/check-docs-fresh.mjs process: advisory
 *       exit 0 with WARNs, `--strict` exit 1, clean tree exit 0.
 *
 * Run: node scripts/verify-docs-fresh.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { checkDocsFresh, blessDocs, blobHash } from './check-docs-fresh.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const checker = path.join(repoRoot, 'scripts', 'check-docs-fresh.mjs');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`PASS: ${label}`);
    pass++;
  } else {
    console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

/** A presence-only "checker" (the naive design that does NOT hash) — used to
 *  prove the mutation is INVISIBLE without the blob-hash recompute (must-FAIL). */
function presenceOnlyStale(guideDir, lockPath, rootDir) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const stale = [];
  for (const doc of fs.readdirSync(guideDir).filter((f) => f.endsWith('.md'))) {
    const entry = lock.docs[doc];
    if (!entry) continue;
    for (const src of Object.keys(entry.sources)) {
      // presence-only: flags only if the file is entirely GONE, never on content change
      if (!fs.existsSync(path.resolve(rootDir, src))) stale.push({ doc, src });
    }
  }
  return stale;
}

function makeDoc(sources) {
  return `---\nsources:\n${sources.map((s) => `  - ${s}`).join('\n')}\n---\n# Doc\n\nbody\n`;
}

function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `docs-fresh-${name}-`));
}

const cleanups = [];
function tmpTree(name) {
  const root = scratch(name);
  cleanups.push(root);
  const guideDir = path.join(root, 'docs', 'guide');
  fs.mkdirSync(guideDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const lockPath = path.join(guideDir, '.doc-sources.lock.json');
  return { root, guideDir, lockPath };
}

function writeSrc(root, rel, content) {
  const abs = path.resolve(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// (a) fresh bless → 0 stale
// ---------------------------------------------------------------------------
{
  const { root, guideDir, lockPath } = tmpTree('a');
  writeSrc(root, 'src/a.js', 'AAA\n');
  writeSrc(root, 'src/b.js', 'BBB\n');
  fs.writeFileSync(path.join(guideDir, 'one.md'), makeDoc(['src/a.js', 'src/b.js']));
  blessDocs({ guideDir, lockPath, rootDir: root });
  const r = checkDocsFresh({ guideDir, lockPath, rootDir: root });
  check('(a) fresh bless reports 0 stale', r.stale.length === 0 && r.docsChecked === 1, `stale=${r.stale.length} docs=${r.docsChecked}`);
  // pinned hash equals git-blob-hash of the scratch source
  const pin = JSON.parse(fs.readFileSync(lockPath, 'utf8')).docs['one.md'].sources['src/a.js'];
  check('(a) pinned hash equals blob hash of source', pin === blobHash(path.join(root, 'src/a.js')), `pin=${pin}`);
}

// ---------------------------------------------------------------------------
// (b) MUST-FAIL — mutate a source → exactly that doc+source flags `changed`
// ---------------------------------------------------------------------------
{
  const { root, guideDir, lockPath } = tmpTree('b');
  writeSrc(root, 'src/a.js', 'AAA\n');
  writeSrc(root, 'src/b.js', 'BBB\n');
  fs.writeFileSync(path.join(guideDir, 'one.md'), makeDoc(['src/a.js', 'src/b.js']));
  fs.writeFileSync(path.join(guideDir, 'two.md'), makeDoc(['src/b.js']));
  blessDocs({ guideDir, lockPath, rootDir: root });

  // baseline: clean → silent
  const clean = checkDocsFresh({ guideDir, lockPath, rootDir: root });
  check('(b) baseline clean = 0 stale (green)', clean.stale.length === 0, `stale=${clean.stale.length}`);

  // MUST-FAIL proof: WITHOUT recomputing the hash the drift is invisible.
  const before = blobHash(path.join(root, 'src/a.js'));
  writeSrc(root, 'src/a.js', 'AAA-EDITED\n'); // mutate the SCRATCH source only
  const after = blobHash(path.join(root, 'src/a.js'));
  check('(b) precondition: blob hash actually changed', before !== after, `${before?.slice(0,8)}==${after?.slice(0,8)}`);
  const naive = presenceOnlyStale(guideDir, lockPath, root);
  check('(b) MUST-FAIL: a presence-only checker stays SILENT on a content edit', naive.length === 0, `naive flagged ${naive.length}`);

  // the real checker flips clean→stale, flagging EXACTLY one.md + src/a.js
  const r = checkDocsFresh({ guideDir, lockPath, rootDir: root });
  const flagged = r.stale.filter((s) => s.reason === 'changed');
  check('(b) checker flags exactly 1 changed reference', flagged.length === 1 && r.stale.length === 1, `stale=${JSON.stringify(r.stale.map((s)=>[s.doc,s.source,s.reason]))}`);
  check('(b) it is one.md + src/a.js', flagged[0] && flagged[0].doc === 'one.md' && flagged[0].source === 'src/a.js', JSON.stringify(flagged[0]));
  check('(b) two.md (references only unchanged src/b.js) is NOT flagged', !r.stale.some((s) => s.doc === 'two.md'), 'two.md leaked');
}

// ---------------------------------------------------------------------------
// (c) --bless <doc> re-pins → clears
// ---------------------------------------------------------------------------
{
  const { root, guideDir, lockPath } = tmpTree('c');
  writeSrc(root, 'src/a.js', 'AAA\n');
  fs.writeFileSync(path.join(guideDir, 'one.md'), makeDoc(['src/a.js']));
  blessDocs({ guideDir, lockPath, rootDir: root });
  writeSrc(root, 'src/a.js', 'CHANGED\n');
  check('(c) stale before re-bless', checkDocsFresh({ guideDir, lockPath, rootDir: root }).stale.length === 1);
  blessDocs({ guideDir, lockPath, onlyDoc: 'one.md', rootDir: root });
  check('(c) --bless one.md clears the staleness', checkDocsFresh({ guideDir, lockPath, rootDir: root }).stale.length === 0);
}

// ---------------------------------------------------------------------------
// (d) source removed from disk → reported missing
// ---------------------------------------------------------------------------
{
  const { root, guideDir, lockPath } = tmpTree('d');
  writeSrc(root, 'src/a.js', 'AAA\n');
  writeSrc(root, 'src/gone.js', 'GONE\n');
  fs.writeFileSync(path.join(guideDir, 'one.md'), makeDoc(['src/a.js', 'src/gone.js']));
  blessDocs({ guideDir, lockPath, rootDir: root });
  fs.rmSync(path.join(root, 'src/gone.js'));
  const r = checkDocsFresh({ guideDir, lockPath, rootDir: root });
  const miss = r.stale.filter((s) => s.reason === 'missing');
  check('(d) a deleted source is reported missing (loudly)', miss.length === 1 && miss[0].source === 'src/gone.js', JSON.stringify(r.stale));
  check('(d) the unchanged sibling source is NOT flagged', !r.stale.some((s) => s.source === 'src/a.js'));
  // and you cannot bless a page whose source vanished
  const b = blessDocs({ guideDir, lockPath, rootDir: root });
  check('(d) --bless REFUSES a page with a vanished source', b.refused.some((x) => x.source === 'src/gone.js') && !b.blessed.includes('one.md'), JSON.stringify(b));
}

// ---------------------------------------------------------------------------
// (e) unchanged doc never false-flags (isolation)
// ---------------------------------------------------------------------------
{
  const { root, guideDir, lockPath } = tmpTree('e');
  writeSrc(root, 'src/a.js', 'AAA\n');
  writeSrc(root, 'src/b.js', 'BBB\n');
  fs.writeFileSync(path.join(guideDir, 'changing.md'), makeDoc(['src/a.js']));
  fs.writeFileSync(path.join(guideDir, 'stable.md'), makeDoc(['src/b.js']));
  blessDocs({ guideDir, lockPath, rootDir: root });
  // churn src/a.js repeatedly; stable.md must never flag
  let leaked = false;
  for (let i = 0; i < 5; i++) {
    writeSrc(root, 'src/a.js', `AAA-${i}\n`);
    const r = checkDocsFresh({ guideDir, lockPath, rootDir: root });
    if (r.stale.some((s) => s.doc === 'stable.md')) leaked = true;
  }
  check('(e) an unchanged doc never false-flags across churn', !leaked);
}

// ---------------------------------------------------------------------------
// (f) REALISTIC busy-state fixture — 5 docs, shared sources, mixed drift
// ---------------------------------------------------------------------------
{
  const { root, guideDir, lockPath } = tmpTree('f');
  // mirror the real guide's shape: shared sources referenced by multiple docs
  const shared = 'src/shared.ts';      // referenced by 3 docs — WILL change
  const wa = 'docs/WA.md';             // referenced by 2 docs — stays put
  const routing = 'docs/ROUTING.md';   // referenced by 2 docs — stays put
  const soloChange = 'src/solo.ts';    // referenced by 1 doc — WILL change
  const doomed = 'src/doomed.ts';      // referenced by 1 doc — WILL be deleted
  for (const s of [shared, wa, routing, soloChange, doomed]) writeSrc(root, s, `orig ${s}\n`);

  fs.writeFileSync(path.join(guideDir, 'orchestration.md'), makeDoc([wa, routing, shared]));
  fs.writeFileSync(path.join(guideDir, 'verification.md'), makeDoc([wa, shared, soloChange]));
  fs.writeFileSync(path.join(guideDir, 'working-agreement.md'), makeDoc([wa, routing]));
  fs.writeFileSync(path.join(guideDir, 'integrations.md'), makeDoc([shared, doomed]));
  fs.writeFileSync(path.join(guideDir, 'projects.md'), makeDoc([routing]));
  blessDocs({ guideDir, lockPath, rootDir: root });
  check('(f) realistic fixture: clean after bless', checkDocsFresh({ guideDir, lockPath, rootDir: root }).stale.length === 0);

  // a real "busy day" of edits happens
  writeSrc(root, shared, 'shared CHANGED\n');        // touches 3 docs
  writeSrc(root, soloChange, 'solo CHANGED\n');       // touches 1 doc
  fs.rmSync(path.join(root, doomed));                 // integrations loses a source
  // and someone adds a brand-new source reference to working-agreement.md without blessing
  writeSrc(root, 'src/new.ts', 'new\n');
  fs.writeFileSync(path.join(guideDir, 'working-agreement.md'), makeDoc([wa, routing, 'src/new.ts']));

  const r = checkDocsFresh({ guideDir, lockPath, rootDir: root });
  const key = (s) => `${s.doc}|${s.source}|${s.reason}`;
  const got = new Set(r.stale.map(key));
  const want = new Set([
    `orchestration.md|${shared}|changed`,
    `verification.md|${shared}|changed`,
    `verification.md|${soloChange}|changed`,
    `integrations.md|${shared}|changed`,
    `integrations.md|${doomed}|missing`,
    `working-agreement.md|src/new.ts|unblessed`,
  ]);
  const same = got.size === want.size && [...want].every((k) => got.has(k));
  check('(f) EXACT stale set across a busy multi-doc state (no false pos/neg)', same,
    `\n    want=${[...want].sort().join('\n         ')}\n    got =${[...got].sort().join('\n         ')}`);
  // projects.md (only routing, untouched) must be silent
  check('(f) an untouched doc (projects.md) is not swept in', !r.stale.some((s) => s.doc === 'projects.md'));
  // working-agreement.md's unchanged wa/routing must NOT flag — only the new unblessed one
  check('(f) unchanged sources of a doc that gained a new ref do not flag',
    !r.stale.some((s) => s.doc === 'working-agreement.md' && s.reason === 'changed'));
}

// ---------------------------------------------------------------------------
// (g) CLI end-to-end — real process, real exit codes
// ---------------------------------------------------------------------------
{
  const { root, guideDir, lockPath } = tmpTree('g');
  writeSrc(root, 'src/a.js', 'AAA\n');
  fs.writeFileSync(path.join(guideDir, 'one.md'), makeDoc(['src/a.js']));
  const run = (args) => spawnSync('node', [checker, ...args], { encoding: 'utf8', cwd: repoRoot });

  const bless = run([`--guide-dir=${guideDir}`, `--root-dir=${root}`, '--bless']);
  check('(g) CLI --bless exit 0', bless.status === 0, bless.stderr);
  const cleanRun = run([`--guide-dir=${guideDir}`, `--root-dir=${root}`]);
  check('(g) CLI clean tree exit 0 + "OK — no stale docs"', cleanRun.status === 0 && /OK — no stale docs/.test(cleanRun.stdout), cleanRun.stdout);

  writeSrc(root, 'src/a.js', 'EDITED\n');
  const advisory = run([`--guide-dir=${guideDir}`, `--root-dir=${root}`]);
  check('(g) CLI advisory exit 0 despite staleness + prints STALE WARN', advisory.status === 0 && /WARN\s+STALE:/.test(advisory.stdout), advisory.stdout);
  const strict = run([`--guide-dir=${guideDir}`, `--root-dir=${root}`, '--strict']);
  check('(g) CLI --strict exits 1 on staleness', strict.status === 1, `status=${strict.status}`);
}

// ---------------------------------------------------------------------------
for (const dir of cleanups) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\ndocs-fresh verify — ${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
