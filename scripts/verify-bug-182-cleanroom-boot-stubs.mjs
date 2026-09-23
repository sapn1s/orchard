#!/usr/bin/env node
/**
 * verify-bug-182-cleanroom-boot-stubs.mjs — BUG-182.
 *
 * THE DEFECT. `scripts/independent-verify.mjs` exports a clean working copy with
 * the ambient instruction surface stripped (`docs/prompts` among it) and then
 * stubs back the few files the SERVER needs to boot. That stub list was a second,
 * hand-maintained copy of a fact `src/server/templates.ts` owns — which docs
 * `seedTemplates()` reads — and it went stale: `templates.ts` grew
 * `WORKING_AGREEMENT.v3.md` and `.v4.md`, the stub list did not. The room's server
 * then died at boot and the only signal the verification round ever saw was
 * `server never became healthy`, so the round silently degraded to static
 * evidence. That is the FALSE-PROOF class: a record can claim verification
 * happened when it did not.
 *
 * THE FIX (ARCH-010): the doc set is DECLARED once by its owner
 * (`src/server/seed-sources.mjs`, which `templates.ts` itself reads) and the clean
 * room READS that declaration — out of the room's own exported copy, i.e. the
 * revision under test.
 *
 * WHAT THIS SUITE PROVES
 *   §1 MUST-FAIL, against a SYNTHESIZED pre-fix state (the stale six-path list is
 *      written out inline below — never taken from a revision that moves, per
 *      CONVENTIONS' must-FAIL rule): a really-booted server in a really-stripped
 *      room dies, and its own error names the missing `.v3` doc.
 *   §2 The same room, stubbed by the SHIPPED `seedBootStubs()`, boots healthy.
 *   §3 THE CLASS ASSERTION: a NEW doc dependency added to `seedTemplates` in a
 *      scratch copy is picked up with ZERO edits to `independent-verify.mjs`
 *      (the shipped file's hash is printed before and after to show it).
 *   §4 A stub gap fails LOUDLY and NAMES the path — never as a health timeout.
 *   §5 An UNRELATED missing file still fails the way it always did: the stub
 *      machinery does not claim it, and the general error path is unchanged.
 *
 * SAFETY. Every room, data dir and config dir is scratch; `CLAUDE_STATION_DATA`
 * and `CLAUDE_CONFIG_DIR`/`CLAUDE_PROJECTS_DIR` are pointed at scratch so nothing
 * touches the real `~/.claude` or the real data dir. Servers are killed by pid.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTAMINATION, seedBootStubs, declaredBootDocs } from './independent-verify.mjs';
import { seedSourceRelPaths } from '../src/server/seed-sources.mjs';
import { assertIsolatedEnv } from './lib/station-boot.mjs';
// Rooms are a reflinked ~374 MB node_modules copy — expensive scratch, and the
// reflink only works on the repo's own filesystem. That is exactly what
// mkdtempScratch() is for (CONVENTIONS: long-lived/expensive scratch is not /tmp).
import { mkdtempScratch } from './lib/scratch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const IV = path.join(ROOT, 'scripts', 'independent-verify.mjs');

/**
 * THE SYNTHESIZED PRE-FIX STATE — the stub list exactly as it stood before this
 * fix. Written out here, in full, ON PURPOSE: an anchor that names a revision
 * ("HEAD", "current") stops failing the moment the fix lands and the proof turns
 * into decoration. This literal cannot change under us.
 */
const STALE_BOOT_STUBS_2026_09_18 = [
  'docs/prompts/WORKING_AGREEMENT.md',
  'docs/prompts/WORKING_AGREEMENT.v2.md',
  'docs/prompts/patterns/MANAGER_SUBAGENT_TREE.md',
  'docs/prompts/patterns/INDEX_TABLE_ROUTER.md',
  'docs/prompts/patterns/RAW_CURATED_MEMORY_SPLIT.md',
  'docs/prompts/patterns/GO_NO_GO_PREFLIGHT.md',
];
const STUB_BODY = 'Clean-room placeholder — verify-bug-182.\n';

let pass = 0, fail = 0;
const failures = [];
function check(label, ok, observed) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label}`); }
  if (observed !== undefined) console.log(`        observed: ${observed}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDirs = [];
const servers = [];

function tmp(prefix) {
  const d = mkdtempScratch(prefix);
  tmpDirs.push(d);
  return d;
}

function sha(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/**
 * A room that mirrors what the clean room hands a verifier: the WORKING TREE
 * (this is a fix being verified before it is committed, so an exported revision
 * would be the wrong subject), minus `.git`, plus a reflinked `node_modules`,
 * with the contamination surface stripped exactly as `buildCleanroom` strips it.
 */
function makeRoom(label) {
  const dir = tmp(`bug182-room-${label}-`);
  const r = spawnSync('sh', ['-c',
    `tar -cf - --exclude=./.git --exclude=./node_modules -C ${JSON.stringify(ROOT)} . | tar -x -C ${JSON.stringify(dir)}`],
    { encoding: 'utf8' });
  if ((r.status ?? 1) !== 0) throw new Error(`could not copy the tree into a room: ${r.stderr}`);
  const cp = spawnSync('cp', ['-a', '--reflink=auto', path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules')], { encoding: 'utf8' });
  if ((cp.status ?? 1) !== 0) throw new Error(`could not provision node_modules: ${cp.stderr}`);
  const stripped = [];
  for (const rel of CONTAMINATION) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); stripped.push(rel); }
  }
  return { dir, stripped };
}

function writeStubs(dir, rels) {
  for (const rel of rels) {
    const p = path.join(dir, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, STUB_BODY);
  }
}

/** Boot the room's own server on a scratch data dir. Returns what happened. */
async function bootServer(roomDir, { timeoutMs = 25_000 } = {}) {
  const port = await freePort();
  const data = tmp('bug182-data-');
  const cfg = tmp('bug182-cfg-');
  fs.mkdirSync(path.join(cfg, 'projects'), { recursive: true });
  const env = assertIsolatedEnv({
    ...process.env,
    PORT: String(port),
    CLAUDE_STATION_DATA: data,
    CLAUDE_CONFIG_DIR: cfg,
    CLAUDE_PROJECTS_DIR: path.join(cfg, 'projects'),
  }, { requireStore: true });
  const child = spawn(process.execPath, [path.join(roomDir, 'src', 'server', 'index.ts')], {
    cwd: roomDir, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(child);
  let stderr = '', stdout = '', exited = null;
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (d) => { stdout += d; });
  child.on('exit', (code) => { exited = code ?? -1; });
  const t0 = Date.now();
  let healthy = false;
  while (Date.now() - t0 < timeoutMs && !healthy && exited === null) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok || res.status < 500) healthy = true;
    } catch { await sleep(200); }
  }
  stop(child);
  return { healthy, exited, stderr, stdout, dataDir: data, port };
}

function stop(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
}

/** Run a snippet that calls the SHIPPED seedBootStubs in a child, to observe die(). */
function seedInChild(roomDir) {
  const code =
    `const { seedBootStubs } = await import(${JSON.stringify(IV)});\n` +
    `const seeded = await seedBootStubs(${JSON.stringify(roomDir)});\n` +
    `console.log('SEEDED ' + JSON.stringify(seeded));\n`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function main() {
  console.log('\n(0) the declaration exists and is the ONLY place the paths are written');
  {
    const declared = seedSourceRelPaths();
    check('src/server/seed-sources.mjs declares every working-agreement + pattern doc seedTemplates reads',
      declared.includes('docs/prompts/WORKING_AGREEMENT.md') &&
      declared.includes('docs/prompts/WORKING_AGREEMENT.v2.md') &&
      declared.includes('docs/prompts/WORKING_AGREEMENT.v3.md') &&
      declared.includes('docs/prompts/WORKING_AGREEMENT.v4.md') &&
      declared.filter((p) => p.includes('/patterns/')).length === 4,
      `${declared.length} declared: ${declared.join(', ')}`);
    // Non-vacuity of the whole ticket: the stale list really is missing two of them.
    const missedByStale = declared.filter((p) => !STALE_BOOT_STUBS_2026_09_18.includes(p));
    check('(setup) the SYNTHESIZED pre-fix list is genuinely short of the declaration — so §1 has something to lose',
      missedByStale.length === 2 && missedByStale.every((p) => /WORKING_AGREEMENT\.v[34]\.md$/.test(p)),
      `stale list misses: ${missedByStale.join(', ') || 'nothing'}`);
    check('independent-verify.mjs holds NO doc-path list of its own any more (no docs/prompts literal outside comments)',
      !fs.readFileSync(IV, 'utf8').split('\n').some((l) => /['"`]docs\/prompts\//.test(l) && !/^\s*\*/.test(l) && !/^\s*\/\//.test(l)),
      fs.readFileSync(IV, 'utf8').split('\n').filter((l) => /['"`]docs\/prompts\//.test(l)).join(' | ') || 'none');
  }

  console.log('\n(1) MUST-FAIL — the synthesized pre-fix stub list cannot boot the room');
  const room1 = makeRoom('a');
  {
    check('(setup) the room really is stripped — docs/prompts is gone',
      !fs.existsSync(path.join(room1.dir, 'docs', 'prompts')) && room1.stripped.includes('docs/prompts'),
      `stripped: ${room1.stripped.join(', ')}`);
    writeStubs(room1.dir, STALE_BOOT_STUBS_2026_09_18);
    const boot = await bootServer(room1.dir);
    check('a room stubbed from the STALE list never becomes healthy (the reported BUG-182 symptom, reproduced)',
      !boot.healthy, `healthy=${boot.healthy} exit=${boot.exited}`);
    check('  …and the server\'s own death names the doc the stale list forgot',
      /WORKING_AGREEMENT\.v3\.md/.test(boot.stderr) && /cannot read seed source/.test(boot.stderr),
      (boot.stderr.split('\n').find((l) => /cannot read seed source/.test(l)) ?? boot.stderr.slice(0, 200)).trim());
  }

  console.log('\n(2) FIXED — the shipped seedBootStubs boots the same room');
  {
    const seeded = await seedBootStubs(room1.dir);
    check('seedBootStubs adds exactly the docs the stale list was missing',
      seeded.length === 2 && seeded.every((r) => /WORKING_AGREEMENT\.v[34]\.md$/.test(r)),
      `seeded: ${seeded.join(', ') || 'none'}`);
    check('  …and every stub is INERT (placeholder text, no real methodology)',
      seedSourceRelPaths().every((rel) => {
        const body = fs.readFileSync(path.join(room1.dir, rel.split('/').join(path.sep)), 'utf8');
        return /placeholder/i.test(body) && body.length < 1000;
      }),
      `all ${seedSourceRelPaths().length} declared docs present and short`);
    const boot = await bootServer(room1.dir);
    check('the room now boots and answers /api/health',
      boot.healthy, `healthy=${boot.healthy} exit=${boot.exited} ${boot.stderr.slice(0, 160).replace(/\n/g, ' ')}`);
    check('  …and the server really seeded its templates from the stubs (v3/v4 included)',
      boot.healthy && ['working-agreement-v3.md', 'working-agreement-v4.md']
        .every((f) => fs.existsSync(path.join(boot.dataDir, 'templates', f))),
      fs.existsSync(path.join(boot.dataDir, 'templates'))
        ? fs.readdirSync(path.join(boot.dataDir, 'templates')).join(', ') : 'no templates dir');
  }

  console.log('\n(3) THE CLASS — a NEW seedTemplates doc is picked up with NO edit to independent-verify.mjs');
  const ivHashBefore = sha(IV);
  {
    const room2 = makeRoom('b');
    const NEW_DOC = 'docs/prompts/WORKING_AGREEMENT.v5.md';
    // Grow the OWNER, as a future change would: declare the path, add the seed.
    const declFile = path.join(room2.dir, 'src', 'server', 'seed-sources.mjs');
    const decl = fs.readFileSync(declFile, 'utf8').replace(
      "  'pattern-manager-subagent-tree':",
      `  'working-agreement-v5': '${NEW_DOC}',\n  'pattern-manager-subagent-tree':`);
    fs.writeFileSync(declFile, decl);
    const tplFile = path.join(room2.dir, 'src', 'server', 'templates.ts');
    const tpl = fs.readFileSync(tplFile, 'utf8').replace(
      "    {\n      id: 'pattern-manager-subagent-tree',",
      "    {\n      id: 'working-agreement-v5',\n      name: 'Working Agreement v5',\n      defaultMode: 'append',\n      living: true,\n      description: 'A future seed nobody told the clean room about.',\n      body: '',\n    },\n    {\n      id: 'pattern-manager-subagent-tree',");
    fs.writeFileSync(tplFile, tpl);
    check('(setup) the scratch copy really grew a new seed dependency the clean room has never heard of',
      decl.includes(NEW_DOC) && tpl.includes("id: 'working-agreement-v5'") && !fs.readFileSync(IV, 'utf8').includes('v5'),
      `${NEW_DOC} declared in the room; independent-verify.mjs never mentions it`);

    const docs = await declaredBootDocs(room2.dir);
    check('the clean room reads the ROOM\'s declaration and sees the new doc',
      docs.includes(NEW_DOC.split('/').join(path.sep)), `${docs.length} boot docs: ${docs.join(', ')}`);
    const seeded = await seedBootStubs(room2.dir);
    check('  …and stubs it automatically',
      seeded.includes(NEW_DOC.split('/').join(path.sep)) && fs.existsSync(path.join(room2.dir, NEW_DOC)),
      `seeded: ${seeded.join(', ')}`);
    const boot = await bootServer(room2.dir);
    check('  …so the grown room boots — the new seed lands with zero clean-room edits',
      boot.healthy && fs.existsSync(path.join(boot.dataDir, 'templates', 'working-agreement-v5.md')),
      `healthy=${boot.healthy} exit=${boot.exited} ${boot.stderr.slice(0, 160).replace(/\n/g, ' ')}`);
    check('independent-verify.mjs was NOT touched by any of this (same sha256 prefix before and after)',
      sha(IV) === ivHashBefore, `${ivHashBefore} → ${sha(IV)}`);
  }

  console.log('\n(4) LOUD — a stub gap names the path, never a health timeout');
  {
    // (a) the declaration is gone while the seeder is still there.
    const room3 = makeRoom('c');
    fs.rmSync(path.join(room3.dir, 'src', 'server', 'seed-sources.mjs'), { force: true });
    const r = seedInChild(room3.dir);
    check('a missing declaration (with templates.ts present) REFUSES, naming the declaration file',
      r.status === 2 && /seed-sources\.mjs/.test(r.stderr) && /templates\.ts/.test(r.stderr) && !/never became healthy/.test(r.stderr),
      `exit=${r.status} ${r.stderr.trim().slice(0, 220)}`);
    fs.rmSync(room3.dir, { recursive: true, force: true });

    // (b) a declared path that cannot be written — the gap is named, not timed out.
    const room4 = makeRoom('d');
    const blocked = path.join(room4.dir, 'docs', 'prompts');
    fs.mkdirSync(path.dirname(blocked), { recursive: true });
    fs.writeFileSync(blocked, 'not a directory\n'); // every declared doc lives under here
    const r4 = seedInChild(room4.dir);
    check('a boot stub that cannot be created fails LOUDLY and names the exact path',
      r4.status === 2 && /WORKING_AGREEMENT/.test(r4.stderr) && /seedTemplates/.test(r4.stderr) && !/never became healthy/.test(r4.stderr),
      `exit=${r4.status} ${r4.stderr.trim().slice(0, 220)}`);
    fs.rmSync(room4.dir, { recursive: true, force: true });

    // (c) a foreign repo (no seeder, no declaration) is NOT an error — it simply
    //     declares no boot docs. The clean room verifies other projects too.
    const foreign = tmp('bug182-foreign-');
    fs.mkdirSync(path.join(foreign, 'src'), { recursive: true });
    fs.writeFileSync(path.join(foreign, 'src', 'thing.mjs'), 'export const x = 1;\n');
    const r5 = seedInChild(foreign);
    check('a repo with no seeding server declares nothing and is stubbed with nothing (no false refusal)',
      r5.status === 0 && /SEEDED \[\]/.test(r5.stdout), `exit=${r5.status} ${(r5.stdout || r5.stderr).trim().slice(0, 160)}`);
  }

  console.log('\n(5) NO REGRESSION — an unrelated missing file still fails the way it used to');
  {
    const victim = path.join(room1.dir, 'src', 'server', 'liveness.ts');
    const had = fs.existsSync(victim);
    fs.rmSync(victim, { force: true });
    const seeded = await seedBootStubs(room1.dir); // stubs are complete; this must not complain
    check('(setup) an unrelated server file was removed from an otherwise-healthy room',
      had && !fs.existsSync(victim), `removed src/server/liveness.ts (existed=${had})`);
    check('the stub machinery does not claim it — seeding still succeeds and reports nothing to add',
      Array.isArray(seeded) && seeded.length === 0, `seeded: ${seeded.join(', ') || 'none'}`);
    const boot = await bootServer(room1.dir, { timeoutMs: 15_000 });
    check('the server still fails, through the ORDINARY error path (module resolution), not a stub complaint',
      !boot.healthy && /liveness/.test(boot.stderr) && !/boot stub/.test(boot.stderr),
      (boot.stderr.split('\n').find((l) => /liveness/.test(l)) ?? boot.stderr.slice(0, 200)).trim());
  }
}

try {
  await main();
} finally {
  for (const s of servers) stop(s);
  await sleep(300);
  for (const s of servers) { try { process.kill(s.pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}

console.log(`\nverify-bug-182-cleanroom-boot-stubs — ${pass}/${pass + fail} PASS`);
if (fail) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
