#!/usr/bin/env node
/**
 * FEAT-041 — sync the universal Working Agreement from its canonical home into
 * claude-station's committed mirror.
 *
 * Canonical repo (product-agnostic source of truth):
 *   ~/projects/methodology/WORKING_AGREEMENT.md
 *   ~/projects/methodology/WORKING_AGREEMENT.v2.md
 * Mirror (what templates.ts read-through / FEAT-027 injects live):
 *   docs/prompts/WORKING_AGREEMENT.md
 *   docs/prompts/WORKING_AGREEMENT.v2.md
 *
 * Direction is ALWAYS canonical -> mirror. Edit the Working Agreement in the
 * canonical repo, then run this to propagate.
 *
 * Portability contract: the committed mirror always works on its own. If the
 * methodology repo/dir is absent (e.g. a fresh dual-boot checkout that never
 * cloned it), this NO-OPS gracefully — clear message, exit 0, no crash. The
 * mirror simply stays whatever is committed.
 *
 * Modes:
 *   node scripts/sync-methodology.mjs            copy canonical -> mirror (idempotent)
 *   node scripts/sync-methodology.mjs --check    report drift (mirror != canonical);
 *                                                 exit 1 on drift, 0 when in sync.
 *                                                 (--check never writes.)
 *
 * --check with the methodology repo ABSENT is treated as "nothing to compare
 * against" -> exit 0 (the committed mirror is authoritative when there is no
 * canonical to drift from).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

/** Canonical repo location. Overridable via env for tests / non-default layouts. */
const METHODOLOGY_DIR =
  process.env.METHODOLOGY_DIR || path.join(os.homedir(), 'projects', 'methodology');

/** Files to keep in sync: canonical basename -> mirror path (relative to repo root). */
const FILES = [
  { name: 'WORKING_AGREEMENT.md', mirror: path.join('docs', 'prompts', 'WORKING_AGREEMENT.md') },
  { name: 'WORKING_AGREEMENT.v2.md', mirror: path.join('docs', 'prompts', 'WORKING_AGREEMENT.v2.md') },
  { name: 'WORKING_AGREEMENT.v3.md', mirror: path.join('docs', 'prompts', 'WORKING_AGREEMENT.v3.md') },
  { name: 'WORKING_AGREEMENT.v4.md', mirror: path.join('docs', 'prompts', 'WORKING_AGREEMENT.v4.md') },
  // FEAT-043: provider/model routing guidance for the mixed Claude+GPT fleet.
  // The mirror is what templates.ts#routingSection injects into sessions.
  { name: 'ROUTING.md', mirror: path.join('docs', 'prompts', 'ROUTING.md') },
];

const check = process.argv.slice(2).includes('--check');

function readOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** First differing line (1-based) between two strings, for a readable drift report. */
function firstDiff(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  const n = Math.max(al.length, bl.length);
  for (let i = 0; i < n; i++) {
    if (al[i] !== bl[i]) {
      return {
        line: i + 1,
        canonical: bl[i] === undefined ? '(end of file)' : bl[i],
        mirror: al[i] === undefined ? '(end of file)' : al[i],
      };
    }
  }
  return null;
}

// --- portability no-op: canonical repo absent -----------------------------
if (!fs.existsSync(METHODOLOGY_DIR)) {
  console.log(
    `sync-methodology: methodology repo not found at ${METHODOLOGY_DIR} — nothing to sync.`,
  );
  console.log(
    'The committed mirror in docs/prompts/ is authoritative on its own; this is expected on a',
  );
  console.log(
    'checkout that never cloned the methodology repo. Set METHODOLOGY_DIR to point elsewhere.',
  );
  process.exit(0);
}

let drift = 0;
let copied = 0;
let inSync = 0;
let missingCanonical = 0;

for (const f of FILES) {
  const canonicalPath = path.join(METHODOLOGY_DIR, f.name);
  const mirrorPath = path.join(REPO_ROOT, f.mirror);
  const canonical = readOrNull(canonicalPath);

  if (canonical === null) {
    console.warn(`sync-methodology: WARN canonical file missing: ${canonicalPath} — skipping ${f.name}`);
    missingCanonical++;
    continue;
  }

  const mirror = readOrNull(mirrorPath);
  const same = mirror === canonical;

  if (check) {
    if (same) {
      console.log(`  in-sync   ${f.mirror} (${Buffer.byteLength(canonical)} bytes)`);
      inSync++;
    } else {
      drift++;
      const d = firstDiff(mirror ?? '', canonical);
      console.error(`  DRIFT     ${f.mirror}`);
      console.error(
        `            mirror=${mirror === null ? 'MISSING' : Buffer.byteLength(mirror) + 'B'} ` +
          `canonical=${Buffer.byteLength(canonical)}B`,
      );
      if (d) {
        console.error(`            first difference at line ${d.line}:`);
        console.error(`              canonical: ${JSON.stringify(d.canonical)}`);
        console.error(`              mirror   : ${JSON.stringify(d.mirror)}`);
      }
    }
    continue;
  }

  // sync mode
  if (same) {
    console.log(`  unchanged ${f.mirror} (${Buffer.byteLength(canonical)} bytes)`);
    inSync++;
  } else {
    fs.writeFileSync(mirrorPath, canonical);
    console.log(`  synced    ${f.mirror} <- ${canonicalPath} (${Buffer.byteLength(canonical)} bytes)`);
    copied++;
  }
}

if (check) {
  if (drift > 0) {
    console.error(`\nsync-methodology --check: DRIFT in ${drift} file(s). Run \`npm run sync:methodology\`.`);
    process.exit(1);
  }
  console.log(`\nsync-methodology --check: OK — mirror == canonical (${inSync} file(s) in sync).`);
  process.exit(0);
}

console.log(
  `\nsync-methodology: done — ${copied} copied, ${inSync} already current` +
    (missingCanonical ? `, ${missingCanonical} canonical file(s) missing (skipped)` : '') + '.',
);
process.exit(0);
