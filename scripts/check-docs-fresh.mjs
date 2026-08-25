#!/usr/bin/env node
/**
 * check-docs-fresh.mjs — self-reporting docs staleness (FEAT-075 Phase 2b).
 *
 * The guide pages under docs/guide/*.md are DERIVED from real source files, not
 * invented. But a page silently rots the moment its source changes and nobody
 * re-reads it. This tool makes the guide self-report that drift.
 *
 * The marker is the git BLOB HASH of each source — content-addressed and
 * deterministic (the same 40-hex sha1 `git hash-object <file>` prints, computed
 * here in pure node so the check has zero external dependency and works in a
 * copied-tool context). Each guide page declares its sources in YAML frontmatter
 * (`sources:`); docs/guide/.doc-sources.lock.json pins the "last verified
 * accurate" hash + a blessedAt date per source. When a live hash no longer
 * matches the pin, the page is possibly-stale and gets flagged for review.
 *
 * A hash mismatch is a PROMPT TO REVIEW, not proof the page is wrong — an
 * unrelated edit to a referenced file also flips the hash (the ticket notes a
 * later symbol/region-precision upgrade to reduce that noise). So the default is
 * advisory, exactly like board:check: WARN + exit 0. `--strict` gates.
 *
 * Usage:
 *   node scripts/check-docs-fresh.mjs                # advisory: WARN lines, exit 0
 *   node scripts/check-docs-fresh.mjs --strict       # exit 1 if any doc is stale
 *   node scripts/check-docs-fresh.mjs --bless         # re-pin ALL docs, bump blessedAt
 *   node scripts/check-docs-fresh.mjs --bless <doc>   # re-pin one doc (name or path)
 *   node scripts/check-docs-fresh.mjs --guide-dir=... # override docs/guide location
 *
 * Exposed for wire-in (board.mjs runs this as an advisory ride-along):
 *   checkDocsFresh({ guideDir, lockPath }) -> { stale, warnings, docsChecked, ok }
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Git blob hash of a file's WORKING-TREE content (what `git hash-object <file>`
 * prints): sha1 of the bytes `"blob <len>\0" + content`. Working-tree content,
 * not HEAD:, so an uncommitted edit to a source counts as drift too. Returns
 * null if the file does not exist on disk (a moved/deleted source).
 */
function blobHash(absPath) {
  let content;
  try {
    content = fs.readFileSync(absPath);
  } catch {
    return null;
  }
  const header = Buffer.from(`blob ${content.length}\0`);
  return crypto.createHash('sha1').update(Buffer.concat([header, content])).digest('hex');
}

/**
 * Parse the leading `--- ... ---` YAML frontmatter and pull out the `sources:`
 * list. Deliberately tiny (no YAML dep): supports a block list under `sources:`
 * (`  - path`) or an inline `sources: [a, b]`. Returns [] when absent.
 */
function parseSources(text) {
  if (!text.startsWith('---')) return [];
  const end = text.indexOf('\n---', 3);
  if (end === -1) return [];
  const fm = text.slice(text.indexOf('\n') + 1, end);
  const lines = fm.split('\n');
  const sources = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const inline = /^sources:\s*\[(.*)\]\s*$/.exec(line);
    if (inline) {
      for (const part of inline[1].split(',')) {
        const v = part.trim().replace(/^['"]|['"]$/g, '');
        if (v) sources.push(v);
      }
      return sources;
    }
    if (/^sources:\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (inList) {
      const item = /^\s*-\s+(.*)$/.exec(line);
      if (item) {
        sources.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
        continue;
      }
      // a new top-level key ends the list
      if (/^\S/.test(line)) inList = false;
    }
  }
  return sources;
}

function listGuideDocs(guideDir) {
  let entries;
  try {
    entries = fs.readdirSync(guideDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({ name: f, abs: path.join(guideDir, f) }));
}

function loadLock(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.docs) return parsed;
  } catch {
    /* absent/corrupt → treat as empty */
  }
  return { docs: {} };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The core check. For every guide doc that declares sources, compare each
 * source's live blob hash to its pinned hash. Reasons a source flags:
 *   - "missing"    : declared source is gone from disk (moved/deleted).
 *   - "unblessed"  : declared source has no pin yet (added since last bless).
 *   - "changed"    : live hash differs from the pinned hash.
 * A doc with no frontmatter sources is skipped (not an error).
 */
function checkDocsFresh({ guideDir, lockPath, rootDir } = {}) {
  guideDir ??= path.join(REPO_ROOT, 'docs', 'guide');
  lockPath ??= path.join(guideDir, '.doc-sources.lock.json');
  rootDir ??= REPO_ROOT;

  const lock = loadLock(lockPath);
  const docs = listGuideDocs(guideDir);
  const stale = [];
  let docsChecked = 0;

  for (const doc of docs) {
    const text = fs.readFileSync(doc.abs, 'utf8');
    const sources = parseSources(text);
    if (sources.length === 0) continue;
    docsChecked++;

    const locked = lock.docs[doc.name] || {};
    const blessedAt = locked.blessedAt || '(never blessed)';
    const pins = locked.sources || {};

    for (const src of sources) {
      const abs = path.resolve(rootDir, src);
      const live = blobHash(abs);
      const pinned = pins[src];

      if (live === null) {
        stale.push({ doc: doc.name, source: src, reason: 'missing', pinned, live: null, blessedAt });
        continue;
      }
      if (pinned === undefined) {
        stale.push({ doc: doc.name, source: src, reason: 'unblessed', pinned, live, blessedAt });
        continue;
      }
      if (pinned !== live) {
        stale.push({ doc: doc.name, source: src, reason: 'changed', pinned, live, blessedAt });
      }
    }
  }

  const warnings = stale.map((s) => formatStale(s));
  return { stale, warnings, docsChecked, ok: stale.length === 0 };
}

function formatStale(s) {
  const rel = `docs/guide/${s.doc}`;
  if (s.reason === 'missing') {
    return (
      `STALE: ${rel} — ${s.source} MISSING on disk (a declared source was moved/deleted; ` +
      `blessed ${s.blessedAt}). Fix the frontmatter path or re-point the page, then \`docs:fresh --bless ${s.doc}\`.`
    );
  }
  if (s.reason === 'unblessed') {
    return (
      `STALE: ${rel} — ${s.source} is declared but NOT pinned (added since ${s.blessedAt}). ` +
      `Review the page against it, then \`docs:fresh --bless ${s.doc}\`.`
    );
  }
  const short = (h) => (h ? h.slice(0, 12) : '(none)');
  return (
    `STALE: ${rel} — ${s.source} changed since ${s.blessedAt} ` +
    `(review: git diff ${short(s.pinned)}..HEAD -- ${s.source}); re-pin with \`docs:fresh --bless ${s.doc}\`.`
  );
}

/**
 * Re-pin: recompute current hashes for each doc's declared sources and write
 * them into the lockfile with a fresh blessedAt. `onlyDoc` (a doc name or path)
 * limits it to one page; otherwise all pages are re-blessed. A source that is
 * MISSING on disk is refused loudly rather than pinned to null — you cannot
 * bless a page whose source has vanished; fix the reference first.
 */
function blessDocs({ guideDir, lockPath, onlyDoc, rootDir } = {}) {
  guideDir ??= path.join(REPO_ROOT, 'docs', 'guide');
  lockPath ??= path.join(guideDir, '.doc-sources.lock.json');
  rootDir ??= REPO_ROOT;

  const lock = loadLock(lockPath);
  lock.docs ||= {};
  const docs = listGuideDocs(guideDir);
  const wantName = onlyDoc ? path.basename(onlyDoc) : null;

  const blessed = [];
  const refused = [];
  const date = today();

  for (const doc of docs) {
    if (wantName && doc.name !== wantName) continue;
    const text = fs.readFileSync(doc.abs, 'utf8');
    const sources = parseSources(text);
    if (sources.length === 0) continue;

    const pins = {};
    let missing = false;
    for (const src of sources) {
      const live = blobHash(path.resolve(rootDir, src));
      if (live === null) {
        refused.push({ doc: doc.name, source: src });
        missing = true;
        continue;
      }
      pins[src] = live;
    }
    if (missing) continue; // do not half-bless a page with a vanished source
    lock.docs[doc.name] = { blessedAt: date, sources: pins };
    blessed.push(doc.name);
  }

  if (wantName && blessed.length === 0 && refused.length === 0) {
    throw new Error(`--bless: no guide doc named "${wantName}" (with sources:) found in ${guideDir}`);
  }

  // Stable key order for a clean, reviewable diff.
  const ordered = { docs: {} };
  for (const name of Object.keys(lock.docs).sort()) {
    const entry = lock.docs[name];
    const srcs = {};
    for (const k of Object.keys(entry.sources || {}).sort()) srcs[k] = entry.sources[k];
    ordered.docs[name] = { blessedAt: entry.blessedAt, sources: srcs };
  }
  fs.writeFileSync(lockPath, JSON.stringify(ordered, null, 2) + '\n');
  return { blessed, refused, lockPath };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { strict: false, bless: false, onlyDoc: null, guideDir: undefined, rootDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict') opts.strict = true;
    else if (a === '--bless') {
      opts.bless = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        opts.onlyDoc = next;
        i++;
      }
    } else if (a.startsWith('--guide-dir=')) opts.guideDir = path.resolve(a.slice('--guide-dir='.length));
    else if (a.startsWith('--root-dir=')) opts.rootDir = path.resolve(a.slice('--root-dir='.length));
    else if (!a.startsWith('--') && opts.bless && !opts.onlyDoc) opts.onlyDoc = a;
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const guideDir = opts.guideDir ?? path.join(REPO_ROOT, 'docs', 'guide');
  const lockPath = path.join(guideDir, '.doc-sources.lock.json');

  if (opts.bless) {
    const { blessed, refused } = blessDocs({ guideDir, lockPath, onlyDoc: opts.onlyDoc, rootDir: opts.rootDir });
    for (const r of refused) {
      console.log(`  REFUSED  ${r.doc} — source ${r.source} is MISSING on disk; fix the reference before blessing.`);
    }
    if (blessed.length) console.log(`docs:fresh --bless — re-pinned ${blessed.length} doc(s): ${blessed.join(', ')} (blessedAt ${today()})`);
    else console.log('docs:fresh --bless — nothing pinned.');
    process.exit(refused.length && opts.strict ? 1 : 0);
  }

  const { stale, warnings, docsChecked } = checkDocsFresh({ guideDir, lockPath, rootDir: opts.rootDir });
  console.log(`docs:fresh — ${docsChecked} guide doc(s) checked in ${path.relative(REPO_ROOT, guideDir) || guideDir}`);
  for (const w of warnings) console.log(`  WARN  ${w}`);
  if (stale.length === 0) {
    console.log('OK — no stale docs');
    process.exit(0);
  }
  console.log(`${stale.length} possibly-stale source reference(s) across ${new Set(stale.map((s) => s.doc)).size} doc(s)`);
  process.exit(opts.strict ? 1 : 0);
}

const isMain = process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();

export { checkDocsFresh, blessDocs, parseSources, blobHash };
