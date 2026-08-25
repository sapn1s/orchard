#!/usr/bin/env node
/**
 * FEAT-075 Phase 4 — verify the annotated guide screenshots.
 *
 *   node scripts/verify-feat-075-screenshots.mjs
 *
 * The capture (scripts/capture-guide-screenshots.mjs) drives the REAL app over
 * the REAL synthetic multi-project dataset (scripts/lib/guide-fixture.mjs) and
 * writes annotated PNGs. This verifier proves, over that realistic fixture:
 *
 *   (a) the fixture is SYNTHETIC by construction — it trips NONE of the
 *       leak-gate's private tokens and carries the three fictional project
 *       names — so a committed PNG (pixel-blind to the text gate) is leak-safe;
 *   (b) the fixture models a REALISTIC busy state (three projects, a pinned +
 *       full session list, a board with a needs-you Focus, a multi-row running
 *       set) — not a one-widget stub;
 *   (c) a fresh capture into a scratch out-dir produces EVERY expected PNG,
 *       each non-empty and a real PNG, and the capture's own manifest records
 *       that the annotation overlay was drawn on the right target element;
 *   (d) the COMMITTED docs/assets/guide/*.png deliverables exist and are real
 *       non-empty PNGs (this is what fails pre-fix — before the capture script
 *       existed the directory was empty);
 *   (e) leak-gate PASSes with the new files present.
 *
 * MUST-FAIL pre-fix: with no capture script and an empty docs/assets/guide,
 * (c) cannot run and (d) has nothing to assert — both fail. Framed so the
 * absence of the feature fails the suite.
 *
 * Scratch only: the capture boots its own server on an OS free port (never
 * :4317) and a headless brave scratch profile; this verifier writes only into
 * an OS temp dir. No real project data is ever captured.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PROJECTS, SESSIONS, RUNNING, BOARD, SHOTS, assertSynthetic } from './lib/guide-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const GUIDE_DIR = path.join(ROOT, 'docs', 'assets', 'guide');
const CAPTURE = path.join(ROOT, 'scripts', 'capture-guide-screenshots.mjs');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}

/** A real PNG starts with the 8-byte signature. */
function isPng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return buf.length > 8 && sig.every((b, i) => buf[i] === b);
}

function main() {
  console.log('\n========== FEAT-075 Phase 4 — annotated guide screenshots ==========');

  /* ============ (a) the fixture is SYNTHETIC by construction ============ */
  console.log('\n=== (a) the capture dataset is synthetic (leak-safe by construction) ===');
  const syn = assertSynthetic();
  check('the fixture trips NONE of the leak-gate private tokens (home path / username / private project names)',
    syn.hits.length === 0, syn.hits.length ? syn.hits : 'no leak-token hits');
  check('the fixture carries exactly the three FICTIONAL project names (atlas-api / aurora-web / lumen-cli)',
    syn.namesOk, syn.names);
  // No raw home path anywhere; every project directory is a fictional /tmp path.
  const blob = JSON.stringify({ PROJECTS, SESSIONS, RUNNING, BOARD });
  check('no raw home directory appears in any fixture path/title',
    !/\/home\//.test(blob) && !/-home-/.test(blob), /\/home\//.test(blob) ? 'HOME LEAK' : 'clean');

  /* ============ (b) the fixture is a REALISTIC busy state =============== */
  console.log('\n=== (b) REALISTIC-STATE fixture (a real multi-project busy day, not a one-widget stub) ===');
  check('three projects across all isolation tiers (direct / container / sandbox)',
    PROJECTS.length === 3 && new Set(PROJECTS.map((p) => p.isolation)).size === 3,
    PROJECTS.map((p) => `${p.name}:${p.isolation}`));
  const aurora = SESSIONS['aurora-web'] ?? [];
  check('the busy project carries a pinned session AND a full recent list (>=5 sessions spanning days)',
    aurora.length >= 5 && aurora.some((s) => s.pinned), { n: aurora.length, pinned: aurora.filter((s) => s.pinned).length });
  const needsYou = BOARD.rows.filter((r) => r.owner === '\u{1F464}');
  check('the board has multiple rows incl. a needs-you Focus ticket (For-You rail is not empty)',
    BOARD.rows.length >= 4 && needsYou.length >= 1 && BOARD.done.length >= 1,
    { rows: BOARD.rows.length, needsYou: needsYou.length, done: BOARD.done.length });
  check('the running set is the main turn PLUS multiple subagents (the strip has real content)',
    RUNNING.running.length >= 3 && RUNNING.running.some((r) => r.row === 'main') && RUNNING.running.filter((r) => r.row !== 'main').length >= 2,
    RUNNING.running.map((r) => r.row + (r.label ? `:${r.label}` : '')));

  /* ============ (c) a fresh capture produces every annotated PNG ======== */
  console.log('\n=== (c) a fresh capture into a scratch out-dir produces every annotated PNG ===');
  check('PRECONDITION: the capture script exists (must FAIL pre-fix: no capture script)',
    fs.existsSync(CAPTURE), CAPTURE);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f075shot-out-'));
  const manifestPath = path.join(outDir, 'manifest.json');
  let ran = { status: 1 };
  if (fs.existsSync(CAPTURE)) {
    ran = spawnSync(process.execPath, [CAPTURE], {
      cwd: ROOT,
      env: { ...process.env, GUIDE_SHOTS_OUTDIR: outDir, GUIDE_SHOTS_MANIFEST: manifestPath },
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 240_000,
    });
  }
  check('the capture ran to completion (exit 0) over the synthetic dataset',
    ran.status === 0, { status: ran.status, signal: ran.signal ?? null });

  let manifest = [];
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* absent → checks below fail */ }
  const byName = Object.fromEntries(manifest.map((m) => [m.name, m]));
  check('the manifest records exactly the declared shot set',
    manifest.length === SHOTS.length && SHOTS.every((s) => s.name in byName),
    { manifest: manifest.length, shots: SHOTS.length });

  for (const shot of SHOTS) {
    const m = byName[shot.name];
    const outFile = path.join(outDir, shot.outFile);
    const exists = fs.existsSync(outFile);
    const buf = exists ? fs.readFileSync(outFile) : Buffer.alloc(0);
    check(`shot "${shot.name}" — PNG produced, non-empty, a real PNG, annotation drawn on ${shot.target}`,
      !!m && m.targetFound === true && m.annotationInjected === true && exists && buf.length > 2000 && isPng(buf),
      { targetFound: m?.targetFound, annotationInjected: m?.annotationInjected, bytes: buf.length, png: isPng(buf) });
  }
  fs.rmSync(outDir, { recursive: true, force: true });

  /* ============ (d) the COMMITTED deliverables exist (fails pre-fix) ==== */
  console.log('\n=== (d) the committed docs/assets/guide/*.png deliverables exist (empty pre-fix) ===');
  for (const shot of SHOTS) {
    const p = path.join(GUIDE_DIR, shot.outFile);
    const exists = fs.existsSync(p);
    const buf = exists ? fs.readFileSync(p) : Buffer.alloc(0);
    check(`docs/assets/guide/${shot.outFile} is a committed, non-empty PNG (must FAIL pre-fix: dir empty)`,
      exists && buf.length > 2000 && isPng(buf), { exists, bytes: buf.length, png: isPng(buf) });
  }
  // Every image under the guide dir is a PNG (no stray non-image committed there).
  if (fs.existsSync(GUIDE_DIR)) {
    const stray = fs.readdirSync(GUIDE_DIR).filter((f) => !/\.png$/i.test(f) && f !== 'capture-manifest.json');
    check('docs/assets/guide holds only PNGs (no stray committed artifacts)', stray.length === 0, stray);
  }

  /* ============ (e) leak-gate PASSes with the new files present ========= */
  console.log('\n=== (e) leak-gate PASSes with the new files present ===');
  const gate = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'leak-gate.mjs')], {
    cwd: ROOT, encoding: 'utf8',
  });
  check('node scripts/leak-gate.mjs → PASS (0 hits; the new PNGs are on the docs/assets allowlist)',
    gate.status === 0, (gate.stdout ?? '').trim().split('\n').pop() || (gate.stderr ?? '').trim().split('\n').pop());

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main();
