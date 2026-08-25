#!/usr/bin/env node
/**
 * verify-fleet-sync.mjs — FEAT-044 follow-up #2: proves scripts/fleet-sync.mjs
 * actually sweeps a project registry and re-syncs stale board.mjs copies.
 *
 * Never touches the REAL :4317 station — spins up its OWN scratch HTTP
 * server on an OS-assigned free port that mimics `GET /api/projects`, and
 * ALSO exercises the `--registry-file` fixture path. All target "projects"
 * are throwaway temp dirs; the server is closed (not pkilled) in `finally`.
 *
 * Fixture projects:
 *   - "stale"     — onboarded, copied board.mjs deliberately diverged.
 *   - "identical" — onboarded, copied board.mjs already matches source.
 *   - "no-board"  — has a hostPath but was never onboarded (no docs/bugs).
 *   - "hands-off-project" — onboarded + stale, but must be excluded BY
 *     DEFAULT (declared hands-off via STATION_HANDS_OFF in the child env).
 *   - "explicitly-excluded" — onboarded + stale, excluded via --exclude.
 *
 * Run: node scripts/verify-fleet-sync.mjs
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { onboard } from './onboard.mjs';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const fleetSyncScript = path.join(repoRoot, 'scripts', 'fleet-sync.mjs');
const boardSourceText = fs.readFileSync(path.join(repoRoot, 'scripts', 'board.mjs'), 'utf8');

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

// Deliberately ASYNC (execFile, not execFileSync): the scratch HTTP server
// below lives in THIS process's event loop. A synchronous spawn would block
// that event loop while waiting on the child, and the child's fetch back to
// this same process's server would then never get accepted — a deadlock.
async function run(args) {
  try {
    const { stdout } = await execFileAsync('node', [fleetSyncScript, ...args], {
      cwd: repoRoot,
      env: { ...process.env, STATION_HANDS_OFF: 'hands-off-project' }, // hermetic hands-off declaration
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.code ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-sync-verify-'));
let server;

try {
  // ---------------------------------------------------------------------
  // Build fixture projects.
  // ---------------------------------------------------------------------
  const staleDir = path.join(tmpRoot, 'stale-project');
  const identicalDir = path.join(tmpRoot, 'identical-project');
  const noBoardDir = path.join(tmpRoot, 'no-board-project');
  const handsOffDir = path.join(tmpRoot, 'hands-off-lookalike'); // hostPath contents irrelevant; id is what matters
  const explicitExcludeDir = path.join(tmpRoot, 'explicitly-excluded-project');

  for (const d of [staleDir, identicalDir, handsOffDir, explicitExcludeDir]) {
    fs.mkdirSync(d, { recursive: true });
    onboard(d, {}); // scaffolds docs/bugs + scripts/board.mjs (byte-identical to source at this point)
  }
  fs.mkdirSync(noBoardDir, { recursive: true }); // deliberately never onboarded — no docs/bugs

  // Diverge the copies that should be reported stale.
  fs.appendFileSync(path.join(staleDir, 'scripts', 'board.mjs'), '\n// LOCAL DIVERGENCE (stale)\n');
  fs.appendFileSync(path.join(handsOffDir, 'scripts', 'board.mjs'), '\n// LOCAL DIVERGENCE (hands-off)\n');
  fs.appendFileSync(path.join(explicitExcludeDir, 'scripts', 'board.mjs'), '\n// LOCAL DIVERGENCE (explicit exclude)\n');
  const staleTextBefore = fs.readFileSync(path.join(staleDir, 'scripts', 'board.mjs'), 'utf8');
  const handsOffTextBefore = fs.readFileSync(path.join(handsOffDir, 'scripts', 'board.mjs'), 'utf8');
  const explicitTextBefore = fs.readFileSync(path.join(explicitExcludeDir, 'scripts', 'board.mjs'), 'utf8');

  const projects = [
    { id: 'stale-project', hostPath: staleDir },
    { id: 'identical-project', hostPath: identicalDir },
    { id: 'no-board-project', hostPath: noBoardDir },
    { id: 'hands-off-project', hostPath: handsOffDir }, // the id, not the dir name, is what fleet-sync keys on
    { id: 'explicitly-excluded-project', hostPath: explicitExcludeDir },
  ];

  // ---------------------------------------------------------------------
  // Scratch HTTP server on a free port — mimics GET /api/projects.
  // ---------------------------------------------------------------------
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/projects') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ projects }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // ---------------------------------------------------------------------
  // 1. DRY-RUN via the scratch HTTP server (default excludes = hands-off-project).
  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // 0. The COPY/SWEEP gap that let scripts/lib/verdict-contract.mjs rot in
  //    every onboarded repo: onboard.mjs COPIED it out and fleet-sync never
  //    SWEPT it, so the copies were free to drift behind this repo's version
  //    while board.mjs (which imports it) was kept current. Anything onboard
  //    copies must be swept, or onboarding a tool is a one-way write.
  // ---------------------------------------------------------------------
  {
    const onboardSrc = fs.readFileSync(path.join(repoRoot, 'scripts', 'onboard.mjs'), 'utf8');
    const syncSrc = fs.readFileSync(path.join(repoRoot, 'scripts', 'fleet-sync.mjs'), 'utf8');
    const listOf = (src, name) => {
      const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(src);
      return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
    };
    const copied = listOf(onboardSrc, 'COPIED_TOOLS');
    const synced = listOf(syncSrc, 'SYNCED_TOOLS');
    const unswept = copied.filter((t) => !synced.includes(t));
    check('COPIED_TOOLS is non-empty (the lists were actually parsed)', copied.length > 0, JSON.stringify(copied));
    check(
      'every COPIED_TOOL is also a SYNCED_TOOL (no copy-once-never-update tool)',
      unswept.length === 0,
      `unswept: ${JSON.stringify(unswept)} — copied=${JSON.stringify(copied)} synced=${JSON.stringify(synced)}`,
    );
  }

  const dry = await run(['--base', base, '--exclude', 'explicitly-excluded-project']);
  check('dry-run exits 0', dry.code === 0, dry.out);
  check('dry-run reports mode DRY-RUN', /DRY-RUN/.test(dry.out), dry.out);
  check('dry-run: stale-project reported STALE (would-update)', /STALE\s+stale-project\s+would-update/.test(dry.out), dry.out);
  check('dry-run: identical-project reported IDENT (identical)', /IDENT\s+identical-project\s+identical/.test(dry.out), dry.out);
  check('dry-run: no-board-project SKIPPED (not onboarded)', /SKIP\s+no-board-project\s+skipped \(no docs\/bugs/.test(dry.out), dry.out);
  check('dry-run: hands-off-project SKIPPED by DEFAULT exclusion (hands-off)', /SKIP\s+hands-off-project\s+skipped \(excluded \(hands-off\)/.test(dry.out), dry.out);
  check('dry-run: explicitly-excluded-project SKIPPED via --exclude', /SKIP\s+explicitly-excluded-project\s+skipped \(excluded \(hands-off\)/.test(dry.out), dry.out);

  // Non-vacuous: dry-run must NOT have written anything.
  check(
    'dry-run wrote NOTHING to stale-project board.mjs',
    fs.readFileSync(path.join(staleDir, 'scripts', 'board.mjs'), 'utf8') === staleTextBefore
  );
  check(
    'dry-run wrote NOTHING to the excluded hands-off-project board.mjs (hands-off honored even hypothetically)',
    fs.readFileSync(path.join(handsOffDir, 'scripts', 'board.mjs'), 'utf8') === handsOffTextBefore
  );
  check(
    'dry-run wrote NOTHING to the explicitly-excluded project',
    fs.readFileSync(path.join(explicitExcludeDir, 'scripts', 'board.mjs'), 'utf8') === explicitTextBefore
  );

  // ---------------------------------------------------------------------
  // 2. --apply via the scratch HTTP server: stale gets re-synced, excluded
  //    projects stay untouched, identical stays identical.
  // ---------------------------------------------------------------------
  const applied = await run(['--base', base, '--exclude', 'explicitly-excluded-project', '--apply']);
  check('--apply exits 0', applied.code === 0, applied.out);
  check('--apply reports mode APPLY', /APPLY/.test(applied.out), applied.out);

  check(
    '--apply: stale-project board.mjs re-synced back to source',
    fs.readFileSync(path.join(staleDir, 'scripts', 'board.mjs'), 'utf8') === boardSourceText
  );
  check(
    '--apply: identical-project board.mjs stays identical (no spurious write)',
    fs.readFileSync(path.join(identicalDir, 'scripts', 'board.mjs'), 'utf8') === boardSourceText
  );
  check(
    '--apply: hands-off-project (default-excluded) board.mjs is UNTOUCHED — still diverged',
    fs.readFileSync(path.join(handsOffDir, 'scripts', 'board.mjs'), 'utf8') === handsOffTextBefore
  );
  check(
    '--apply: explicitly-excluded-project board.mjs is UNTOUCHED — still diverged',
    fs.readFileSync(path.join(explicitExcludeDir, 'scripts', 'board.mjs'), 'utf8') === explicitTextBefore
  );
  check(
    '--apply: no-board-project was never touched (no scripts/ dir created)',
    !fs.existsSync(path.join(noBoardDir, 'scripts'))
  );

  // ---------------------------------------------------------------------
  // 3. --registry-file fixture path (no HTTP at all) — same semantics.
  // ---------------------------------------------------------------------
  const registryFile = path.join(tmpRoot, 'registry.json');
  fs.writeFileSync(registryFile, JSON.stringify({ projects: [{ id: 'identical-project', hostPath: identicalDir }] }));
  const viaFile = await run(['--registry-file', registryFile]);
  check('--registry-file dry-run exits 0', viaFile.code === 0, viaFile.out);
  check('--registry-file reads from the fixture, not the network', /source: file /.test(viaFile.out), viaFile.out);
  check('--registry-file: identical-project reported IDENT', /IDENT\s+identical-project\s+identical/.test(viaFile.out), viaFile.out);

  // ---------------------------------------------------------------------
  // 4. Unreachable base with no fixture is a hard, non-zero-exit error
  //    (never silently reports an empty/clean sweep).
  // ---------------------------------------------------------------------
  const unreachable = await run(['--base', 'http://127.0.0.1:1']); // port 1 — nothing listens, connection refused
  check('unreachable registry source exits non-zero (hard error, not a silent clean sweep)', unreachable.code !== 0, unreachable.out);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
