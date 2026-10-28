#!/usr/bin/env node
/**
 * FEAT-202 round-3 MUST-FAIL repro — the deaf-watcher regression (anthropic
 * run 5b838160, BROKEN).
 *
 * On Linux, removing a watched DIRECTORY emits no 'error' event: the FSWatcher
 * goes silently deaf, stays registered in the module's Map, and a re-arm is a
 * no-op. So after a board dir is removed and recreated, external writes never
 * move the counter and the board goes stale forever.
 *
 * This script loads the ROUND-2 (watcher) module and the ROUND-3 (fingerprint)
 * module side by side and runs the SAME attack against both:
 *   remove the watched dir, recreate it, write a file, wait.
 * Round-2 must STAY STUCK (the bug). Round-3 must MOVE (the fix). The script
 * exits 0 only if the bug reproduces on round-2 AND is absent on round-3.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OLD = path.join(REPO, 'scripts/fixtures/feat-202/old-store-versions.mjs');

async function run() {
  const oldSv = await import(OLD);
  const newSv = await import(path.join(REPO, 'src/server/store-versions.ts'));

  // ── Round-2 (watcher): remove+recreate the watched dir, then an external write.
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-old-'));
  fs.writeFileSync(path.join(d1, 'agent-outcomes.json'), '[]');
  oldSv.armDataDirWatch(d1);
  await sleep(200);
  // Prove the watcher works at all first: one write moves it.
  fs.writeFileSync(path.join(d1, 'agent-outcomes.json'), '[{"id":"warm"}]');
  await sleep(400);
  const armed = oldSv.snapshot([]).outcomes;
  // Now the attack: remove the watched dir, recreate it, write again.
  fs.rmSync(d1, { recursive: true, force: true });
  await sleep(300); // Linux emits NO error event on dir removal
  fs.mkdirSync(d1, { recursive: true });
  oldSv.armDataDirWatch(d1); // no-op: the dead watcher is still in the Map
  await sleep(200);
  const beforeExt = oldSv.snapshot([]).outcomes;
  fs.writeFileSync(path.join(d1, 'agent-outcomes.json'), '[{"id":"after-recreate"}]');
  await sleep(600);
  const afterExt = oldSv.snapshot([]).outcomes;
  const oldStuck = afterExt === beforeExt;
  console.log(`  ROUND-2 (watcher): armed=${armed} beforeExt=${beforeExt} afterExt=${afterExt} → ${oldStuck ? 'STUCK (bug reproduced)' : 'moved (no bug?!)'}`);
  try { oldSv._closeAll(); } catch { /* */ }
  fs.rmSync(d1, { recursive: true, force: true });

  // ── Round-3 (fingerprint): same attack against a board dir.
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-new-'));
  fs.writeFileSync(path.join(d2, 'FOO-1.md'), 'one');
  const boards = [{ id: 'p', dir: d2 }];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-new-data-'));
  newSv._clearCache();
  const base = newSv.snapshot(dataDir, boards).board.p;
  fs.rmSync(d2, { recursive: true, force: true });
  fs.mkdirSync(d2, { recursive: true });
  newSv._clearCache(); // a fresh poll >1s later would clear it on its own
  const afterRecreate = newSv.snapshot(dataDir, boards).board.p;
  fs.writeFileSync(path.join(d2, 'BAR-1.md'), 'external write after recreate');
  newSv._clearCache();
  const afterWrite = newSv.snapshot(dataDir, boards).board.p;
  const newMoves = afterRecreate !== base && afterWrite !== afterRecreate;
  console.log(`  ROUND-3 (fingerprint): base=${base} afterRecreate=${afterRecreate} afterWrite=${afterWrite} → ${newMoves ? 'MOVES (fixed)' : 'STUCK (NOT fixed!)'}`);
  fs.rmSync(d2, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });

  const proved = oldStuck && newMoves;
  console.log(`\n${proved ? 'MUST-FAIL PROVED' : 'INCONCLUSIVE'} — pre-fix stuck=${oldStuck}, post-fix moves=${newMoves}`);
  process.exit(proved ? 0 : 1);
}
run().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
