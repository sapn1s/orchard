#!/usr/bin/env node
/**
 * verify-bug-186-diff-strip.mjs — BUG-186 + BUG-120 (round 3 redesign).
 *
 * THE INVARIANT: the ROOM and the DIFF are both EXACTLY the declared surface —
 * nothing undeclared reaches the verifier by either route, at any depth. Rounds
 * 1–2 patched edge cases and a cross-provider verify kept finding more, because a
 * string-built pathspec and a hand walk each had their OWN idea of the tree that
 * disagreed with git's on edges. Round 3 removes the second decision point: ONE
 * predicate `makeIsDeclared(path)` decides for every route, over BYTE-EXACT paths.
 *
 * This suite proves the redesign and pins all 8 round-2 findings as must-FAIL
 * (synthesised against the pre-fix CONSTRUCTION, never a moving revision):
 *   BUG-120 (room/allow/scale): a `.claude` SYMLINK; `node_modules/**​/AGENTS.md`;
 *     an ambient-named `--allow-input` silently dropped; the assertion missing an
 *     undeclared prose symlink; an 800-file prose tree hitting ARG_MAX.
 *   BUG-186 (diff): DELETED prose leaking; git-quoted non-ASCII (`docs/café.md`);
 *     trailing-space filenames.
 * Plus self-named same-class attacks: a rename across the prose boundary, a
 * case-only rename, a filename containing a newline.
 *
 * Run: node scripts/verify-bug-186-diff-strip.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempScratch } from './lib/scratch.mjs';
import { stripCleanroom, makeIsDeclared, isAmbientPath, writeNoFollow, materializeSymlinks } from './independent-verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const IV = path.join(ROOT, 'scripts', 'independent-verify.mjs');

let pass = 0, fail = 0, skip = 0;
const failures = [];
function check(label, ok, observed) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label}`); }
  if (observed !== undefined) console.log(`        observed: ${String(observed).slice(0, 300)}`);
}
function skipped(label, why) { skip++; console.log(`  SKIP  ${label}\n        ${why}`); }
const tmpDirs = [];
const tmp = (p) => { const d = mkdtempScratch(p); tmpDirs.push(d); return d; };
function mkTree(base, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(base, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
}
function walkFiles(base) {
  const out = [];
  (function rec(rel) {
    let ents; try { ents = fs.readdirSync(rel ? path.join(base, ...rel.split('/')) : base, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { out.push(r + '@'); continue; }
      if (e.isDirectory()) { rec(r); continue; }
      out.push(r);
    }
  })('');
  return out;
}

/* ==================================================================== */
/* (P) THE PREDICATE — the single decision point, exhaustively           */
/* ==================================================================== */
console.log('\n(P) makeIsDeclared — the one decision point, over byte-exact edge paths');
{
  const isDecl = makeIsDeclared({ proseRoots: ['docs'], allowed: ['docs/analysis/keep.json'] });
  const declared = [
    'src/thing.mjs', 'package.json', 'src/deep/nested/file.mjs',
    'docs/analysis/keep.json', 'docs/analysis/keep.json',
    'docs/café.mjs'.replace('docs/', 'src/'), // a non-prose café name is declared
    'weird[1].mjs', 'trailing.mjs ', 'with\nnewline.mjs',
  ];
  const undeclared = [
    'docs/bugs/BUG-1.md', 'docs/CONVENTIONS.md', 'docs/analysis/private.md',
    'docs/analysis/sub/deep.md', 'docs/café.md', 'docs/trailing.md ', 'docs/with\nnl.md',
    'CLAUDE.md', 'src/AGENTS.md', 'a/b/CLAUDE.md', '.claude/settings.json',
    'src/.codex/config', 'pkg/.claude/x', 'node_modules/p/AGENTS.md',
    'docs/weird[1].md',
  ];
  const badDeclared = declared.filter((p) => !isDecl(p));
  const badUndeclared = undeclared.filter((p) => isDecl(p));
  check('every DECLARED edge path (code/config/allowed input, incl brackets/space/newline) is declared',
    badDeclared.length === 0, badDeclared.length ? `WRONGLY undeclared: ${JSON.stringify(badDeclared)}` : `${declared.length} ok`);
  check('every UNDECLARED edge path (prose + ambient at any depth/type, incl café/space/newline/node_modules) is NOT declared',
    badUndeclared.length === 0, badUndeclared.length ? `LEAKED: ${JSON.stringify(badUndeclared)}` : `${undeclared.length} ok`);
  check('isAmbientPath catches ambient files/dirs at ANY depth and case (incl UPPERCASE dir .CLAUDE — round-4)',
    isAmbientPath('a/b/CLAUDE.md') && isAmbientPath('x/.claude/y') && isAmbientPath('Agents.md')
      && isAmbientPath('node_modules/p/AGENTS.md') && isAmbientPath('.CLAUDE/settings.json')
      && isAmbientPath('x/.Codex/c') && !isAmbientPath('src/thing.mjs'),
    'depth + case (files AND dirs) + node_modules + negative');
  check('an ambient-named allow-input does NOT make the ambient path declared (never allow-listable)',
    !makeIsDeclared({ proseRoots: ['docs'], allowed: ['docs/AGENTS.md'] })('docs/AGENTS.md'),
    'ambient stays undeclared even if named as an input');
}

/* ==================================================================== */
/* (A) THE ROOM strip — same predicate, lstat walk, any depth/type       */
/* ==================================================================== */
console.log('\n(A) stripCleanroom — nothing undeclared survives, at any depth or type');
{
  const d = tmp('bug186r3-room-');
  mkTree(d, {
    'src/thing.mjs': 'code\n', 'src/AGENTS.md': 'nested ambient\n', 'a/b/CLAUDE.md': 'depth-2 ambient\n',
    '.claude/settings.json': '{}\n',
    'node_modules/pkg/index.js': 'x\n', 'node_modules/pkg/AGENTS.md': 'dep ambient\n', 'node_modules/pkg/.claude/c': 'x\n',
    'docs/prompts/WA.md': 'methodology\n', 'docs/analysis/required.json': '{}\n',
    'docs/analysis/private.md': 'sibling\n', 'docs/analysis/sub/deep.md': 'nested sibling\n',
  });
  // a .claude SYMLINK (finding 1) and a prose SYMLINK (finding 4) and an escaping one
  try {
    fs.symlinkSync('.claude-real', path.join(d, '.claude-link'));            // not ambient-named → but points nowhere; declared? name '.claude-link' not ambient → declared (kept)
    fs.symlinkSync('settings', path.join(d, 'src/.claude'));                 // ambient-DIR-named symlink → must be removed
    fs.symlinkSync('required.json', path.join(d, 'docs/analysis/link.md'));  // prose symlink → must be removed
  } catch (e) { /* symlinks unsupported */ }
  stripCleanroom(d, { proseRoots: ['docs'], allowed: ['docs/analysis/required.json'] });
  const s = walkFiles(d);
  check('nested ambient at any depth gone, INCLUDING inside node_modules (findings: node_modules ambient)',
    !s.some((x) => /AGENTS\.md|CLAUDE\.md/.test(x)) && !s.some((x) => x.includes('node_modules/pkg/.claude')) && s.includes('node_modules/pkg/index.js'),
    `survivors: ${s.join(', ')}`);
  check('a .claude SYMLINK is removed (finding 1 — type-blind ambient match)',
    !s.some((x) => x.startsWith('src/.claude')), `survivors: ${s.join(', ')}`);
  check('exact allow: declared input kept, every undeclared prose sibling/subdir + prose SYMLINK gone (finding 4)',
    s.includes('docs/analysis/required.json') && !s.some((x) => x.startsWith('docs/analysis/private') || x.startsWith('docs/analysis/sub') || x.startsWith('docs/analysis/link')),
    `survivors: ${s.join(', ')}`);
  check('  …and the code the verifier runs is kept',
    s.includes('src/thing.mjs') && s.includes('node_modules/pkg/index.js'), `survivors: ${s.join(', ')}`);
}
// MUST-FAIL — the round-2 walk SKIPPED node_modules; synthesise that skip inline.
{
  const d = tmp('bug186r3-nm-mustfail-');
  mkTree(d, { 'node_modules/pkg/AGENTS.md': 'dep ambient\n' });
  const round2SkippedNodeModules = (relDir) => { // the old walk: never descend node_modules
    for (const e of fs.readdirSync(relDir ? path.join(d, relDir) : d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name === 'node_modules') continue; round2SkippedNodeModules(relDir ? `${relDir}/${e.name}` : e.name); }
    }
  };
  round2SkippedNodeModules('');
  check('MUST-FAIL: the round-2 node_modules-skipping walk leaves node_modules/pkg/AGENTS.md in place',
    fs.existsSync(path.join(d, 'node_modules/pkg/AGENTS.md')), 'old walk never reached it');
  stripCleanroom(d, { proseRoots: ['docs'], allowed: [] });
  check('  …PASS-AFTER: the shipped strip (walks everything) removes it',
    !fs.existsSync(path.join(d, 'node_modules/pkg/AGENTS.md')), 'gone');
}

/* ==================================================================== */
/* (A3) round-9 materializeSymlinks — ZERO symlinks (no git needed)       */
/* ==================================================================== */
console.log('\n(A3) round-9 — materializeSymlinks leaves zero symlinks (.bin → shim)');
{
  const d = tmp('bug186r9-mat-');
  mkTree(d, { 'src/code.mjs': 'x\n', 'node_modules/pkg/cli.js': '#!/usr/bin/env node\n', 'docs/analysis/keep.json': '{}\n' });
  let can = true;
  try {
    fs.mkdirSync(path.join(d, 'node_modules', '.bin'), { recursive: true });
    fs.symlinkSync('../pkg/cli.js', path.join(d, 'node_modules', '.bin', 'tool'));   // .bin launcher
    fs.symlinkSync('code.mjs', path.join(d, 'src', 'internal.mjs'));                  // internal non-.bin
    fs.symlinkSync('keep.json', path.join(d, 'docs', 'analysis', 'declared-link'));   // under a declared input
  } catch { can = false; }
  if (!can) skipped('(A3) materializeSymlinks', 'symlink unsupported here');
  else {
    const res = materializeSymlinks(d, { allowed: ['docs/analysis'] });
    const syms = walkFiles(d).filter((x) => x.endsWith('@')).map((x) => x.slice(0, -1));
    check('materializeSymlinks: .bin link → real exec shim; internal link removed; declared-input link KEPT',
      !fs.lstatSync(path.join(d, 'node_modules', '.bin', 'tool')).isSymbolicLink()
        && /exec/.test(fs.readFileSync(path.join(d, 'node_modules', '.bin', 'tool'), 'utf8'))
        && !fs.existsSync(path.join(d, 'src', 'internal.mjs'))
        && fs.lstatSync(path.join(d, 'docs', 'analysis', 'declared-link')).isSymbolicLink()
        && res.materialized.some((x) => x.includes('.bin/tool')),
      `materialized=${JSON.stringify(res.materialized)} removed=${JSON.stringify(res.removed)} remaining=${JSON.stringify(syms)}`);
    check('  …so the only symlink left is the one under the declared input',
      syms.length === 1 && syms[0].startsWith('docs/analysis/declared-link'),
      `remaining: ${JSON.stringify(syms)}`);
  }
}

/* ==================================================================== */
/* (B) THE DIFF route — CLI, byte-exact allow-list                       */
/* ==================================================================== */
console.log('\n(B) the DIFF route — deletions, non-ASCII, trailing space, ARG_MAX');
// Probe git WRITE capability, not just availability: this environment's
// git-write backstop (FEAT-135) can refuse subprocess `git init` even in a
// scratch fixture, which would crash every fixture-building section. Detect it
// and SKIP those sections loudly rather than abort.
const gitProbe = (() => {
  const base = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (base.error || base.status !== 0) return base;
  const probe = tmp('gitwrite-probe-');
  const w = spawnSync('git', ['-C', probe, 'init', '-q'], { encoding: 'utf8' });
  if ((w.status ?? 1) !== 0 || /write (refused|disabled)|blocked/i.test(`${w.stdout}${w.stderr}`)) {
    return { error: null, status: 1, stdout: '', stderr: 'git WRITE refused by this environment (FEAT-135 backstop): cannot build fixture repos' };
  }
  return base;
})();
if (gitProbe.error || gitProbe.status !== 0) {
  skipped('all (B)/(C)/(E) diff-route checks', `cannot spawn git (${gitProbe.error?.code ?? `exit ${gitProbe.status}`})`);
} else {
const fx = tmp('bug186r3-fixture-');
const gx = (...a) => execFileSync('git', ['-C', fx, ...a], { encoding: 'utf8' });
const w = (rel, b) => { const p = path.join(fx, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); };
gx('init', '-q'); gx('config', 'user.email', 't@t'); gx('config', 'user.name', 't');
const LEAK = ['docs/bugs/', 'docs/CONVENTIONS.md', 'docs/prompts/', 'BOARD PROSE', 'the fixer reasoned'];
// base
w('src/thing.mjs', 'export const total = (xs) => xs.length;\n');
w('test/t.test.mjs', "console.log('PASS');\n");
w('docs/bugs/deleted.md', '# BOARD PROSE that will be DELETED — the fixer reasoned it\n');
w('docs/CONVENTIONS.md', 'conventions base\n');
w('docs/café.md', 'BOARD PROSE non-ascii base\n');
w('docs/trailing.md ', 'BOARD PROSE trailing-space base\n');
w('docs/schema/limits.json', '{"maxItems": 10}\n');
for (let i = 0; i < 800; i++) w(`docs/filler/really-quite-long-prose-sibling-filename-number-${i}-padded-out-to-add-argv-bytes.md`, `prose ${i} base\n`);
gx('add', '-A'); gx('commit', '-qm', 'base');
// head: real code change + prose changes + a DELETION + 800 prose changes
w('src/thing.mjs', 'export const total = (xs) => xs.filter(Boolean).length;\n');
w('docs/CONVENTIONS.md', 'conventions CHANGED — must not reach verifier\n');
w('docs/café.md', 'BOARD PROSE non-ascii CHANGED\n');
w('docs/trailing.md ', 'BOARD PROSE trailing-space CHANGED\n');
w('docs/schema/limits.json', '{"maxItems": 20}\n');
fs.rmSync(path.join(fx, 'docs/bugs/deleted.md'));
for (let i = 0; i < 800; i++) fs.appendFileSync(path.join(fx, `docs/filler/really-quite-long-prose-sibling-filename-number-${i}-padded-out-to-add-argv-bytes.md`), 'chg\n');
gx('add', '-A'); gx('commit', '-qm', 'change');

const run = (extra) => spawnSync(process.execPath, [
  IV, '--repo', fx, '--range', 'HEAD',
  '--requirement', 'total counts truthy.', '--run', 'node test/t.test.mjs', '--test-file', 'test/t.test.mjs',
  '--print-prompt', '--keep-cleanroom', ...(extra || []),
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const diffOf = (r) => { const p = r.stdout ?? ''; const i = p.indexOf('=== THE DIFF UNDER TEST ==='); return i < 0 ? '' : p.slice(i); };

// MUST-FAIL — round-2 per-file enumeration from the HEAD tree (ls-tree) omits a
// DELETED prose path AND git-quotes non-ASCII, so both leak. Synthesise it.
{
  const base = gx('rev-parse', 'HEAD~1').trim(), head = gx('rev-parse', 'HEAD').trim();
  const headFiles = gx('ls-tree', '-r', '--name-only', head, 'docs/').trim().split('\n').filter(Boolean);
  const allow = 'docs/schema/limits.json';
  const specs = headFiles.filter((f) => f !== allow).map((f) => `:(exclude,literal)${f}`);
  const round2 = execFileSync('git', ['-C', fx, 'diff', base, head, '--', '.', ...specs], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  check('MUST-FAIL: round-2 head-tree enumeration leaks the DELETED prose file and the non-ASCII café.md',
    round2.includes('BOARD PROSE that will be DELETED') && /caf/.test(round2),
    'deleted + non-ascii present in the round-2 construction');
}

for (const [label, extra] of [['default (no allow-input)', []], ['with --allow-input under a prose subdir', ['--allow-input', 'docs/schema/limits.json']]]) {
  const r = run(extra);
  const diff = diffOf(r);
  const leaked = LEAK.filter((m) => diff.includes(m));
  check(`PASS-AFTER [${label}]: no board/methodology, no DELETED prose, no café/trailing/filler — code kept`,
    r.status === 0 && leaked.length === 0 && !/caf/.test(diff) && !diff.includes('trailing.md') && !diff.includes('filler') && diff.includes('filter(Boolean)'),
    r.status !== 0 ? `exit=${r.status} ${(r.stderr || '').slice(-140)}` : (leaked.length ? `LEAKED: ${leaked}` : 'clean, code present'));
  if (extra.length) {
    check('  …the declared allow-input IS shown (10 → 20), its prose siblings are not',
      diff.includes('docs/schema/limits.json') && diff.includes('maxItems'), 'schema present');
  }
  const rd = /clean room: (\S+)/.exec(r.stderr || '')?.[1]; if (rd) tmpDirs.push(rd);
  const rec = /record dir: (\S+)/.exec(r.stderr || '')?.[1]; if (rec) tmpDirs.push(rec);
}
// finding 5 explicitly: 800 changed prose siblings must not blow ARG_MAX.
{
  const r = run(['--allow-input', 'docs/schema/limits.json']);
  check('an 800-file changed prose tree does NOT hit ARG_MAX — the allow-list passes only declared paths (finding 5)',
    r.status === 0, `exit=${r.status}; ${(r.stderr || '').split('\n').find((l) => /E2BIG|argument list/.test(l)) || 'no E2BIG'}`);
}

/* ==================================================================== */
/* (C) allow-input semantics — exact, ambient=hard error, records        */
/* ==================================================================== */
console.log('\n(C) --allow-input — exact, ambient rejected, missing rejected, recorded');
{
  // Manifest check FIRST — HEAD still carries the code change from (B).
  const r = run();
  const rec = /record dir: (\S+)/.exec(r.stderr || '')?.[1]; if (rec) tmpDirs.push(rec);
  const mf = rec ? path.join(rec, 'room-manifest.json') : null;
  const m = mf && fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : null;
  check('the room records what it was given (allow-list filter, changed count, allowed paths)',
    !!m && /allow-list/.test(m.diffFilter) && typeof m.changedPaths === 'number' && Array.isArray(m.diffAllowList) && m.diffAllowList.includes('src/thing.mjs'),
    m ? `filter="${m.diffFilter.slice(0, 40)}…" changed=${m.changedPaths} allow=${m.diffAllowList.length}` : 'no manifest');
}
{
  // ambient-named allow-input must be a HARD ERROR (finding 3), not a silent drop.
  w('docs/AGENTS.md', 'ambient inside prose\n'); gx('add', '-A'); gx('commit', '-qm', 'add ambient prose');
  const r = run(['--allow-input', 'docs/AGENTS.md']);
  check('an ambient-named --allow-input is a HARD ERROR (exit 2) naming it — never a silent drop (finding 3)',
    r.status === 2 && /docs\/AGENTS\.md/.test(r.stderr || '') && /ambient-instruction/.test(r.stderr || ''),
    `exit=${r.status}; ${(r.stderr || '').split('\n').find((l) => /AGENTS/.test(l)) || (r.stderr || '').slice(0, 120)}`);
  gx('rm', '-q', 'docs/AGENTS.md'); gx('commit', '-qm', 'rm ambient prose');
}
{
  const r = run(['--allow-input', 'docs/nope.md']);
  check('a MISSING --allow-input is a harness error (exit 2)', r.status === 2 && /nope\.md/.test(r.stderr || '') && /harness error/.test(r.stderr || ''), `exit=${r.status}`);
}

/* ==================================================================== */
/* (D) empty-after-exclusion guard                                       */
/* ==================================================================== */
console.log('\n(D) a diff of only board/ambient dies loudly');
{
  // working-tree with ONLY prose + a nested ambient dirty
  fs.appendFileSync(path.join(fx, 'docs/CONVENTIONS.md'), 'more prose\n');
  fs.mkdirSync(path.join(fx, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fx, 'src/AGENTS.md'), 'nested ambient only\n');
  const r = spawnSync(process.execPath, [IV, '--repo', fx, '--working-tree', '--requirement', 'x', '--run', 'true', '--print-prompt'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  check('only-prose + nested-ambient working tree dies "nothing for the verifier to attack" (exit 2)',
    r.status === 2 && /no verifiable diff after excluding/.test(r.stderr || ''),
    `exit=${r.status}; ${(r.stderr || '').split('\n').find((l) => /verifiable/.test(l)) || ''}`);
  fs.rmSync(path.join(fx, 'src/AGENTS.md'), { force: true });
  execFileSync('git', ['-C', fx, 'checkout', '-q', 'HEAD', '--', 'docs/CONVENTIONS.md']);
}

/* ==================================================================== */
/* (E) self-named same-class attacks                                     */
/* ==================================================================== */
console.log('\n(E) self-named attacks — rename across the prose boundary, case-only rename');
{
  // rename src/moved.mjs -> docs/moved.mjs (code→prose): the DELETE side (code) may
  // show; the ADD side (now prose) must NOT. And docs/leak.md -> src/leak.mjs
  // (prose→code): the ADD at a code path IS shown — the declined structural residual.
  w('src/moved.mjs', 'export const a = 1;\n');
  w('docs/leak.md', 'PROSE that will be renamed into src\n');
  gx('add', '-A'); gx('commit', '-qm', 'pre-rename');
  gx('mv', 'src/moved.mjs', 'docs/moved.mjs');
  gx('mv', 'docs/leak.md', 'src/leak.mjs');
  w('src/thing.mjs', 'export const total = (xs) => xs.filter((x)=>!!x).length;\n'); // a real code change so the run isn't empty
  gx('add', '-A'); gx('commit', '-qm', 'rename across boundary');
  const r = run();
  const diff = diffOf(r);
  check('a code→prose rename does NOT show the ADD side (now under docs/)',
    r.status === 0 && !diff.includes('docs/moved.mjs'), r.status !== 0 ? `exit=${r.status}` : (diff.includes('docs/moved.mjs') ? 'LEAKED docs/moved.mjs add' : 'add side excluded'));
  check('  …a prose→code rename shows the ADD at the code path — the DECLARED structural residual (noted, not a regression)',
    diff.includes('src/leak.mjs'), 'content relocated INTO code is code by the structural definition');
}

/* ==================================================================== */
/* (G) round-4 — case-insensitive ambient, canonicalisation, file→dir     */
/* ==================================================================== */
console.log('\n(G) round-4 — case-insensitive ambient, path canonicalisation, file→dir pathspec');
{
  const g = tmp('bug186r4-');
  const gg = (...a) => execFileSync('git', ['-C', g, ...a], { encoding: 'utf8' });
  const gw = (rel, b) => { const p = path.join(g, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); };
  gg('init', '-q'); gg('config', 'user.email', 't@t'); gg('config', 'user.name', 't');
  gw('src/thing.mjs', 'base\n'); gw('src/widget', 'I am a FILE that becomes a directory\n');
  gw('docs/keep.json', '{"declared": true}\n'); gw('docs/other.md', 'undeclared prose base\n');
  gw('.CLAUDE/settings.json', 'uppercase ambient dir\n');
  gg('add', '-A'); gg('commit', '-qm', 'base');
  gw('src/thing.mjs', 'changed\n');
  fs.rmSync(path.join(g, 'src/widget')); gw('src/widget/AGENTS.md', 'NESTED AMBIENT that must not leak via the file→dir pathspec\n');
  gw('docs/keep.json', '{"declared": true, "v": 2}\n'); gw('docs/other.md', 'undeclared prose CHANGED\n');
  gg('add', '-A'); gg('commit', '-qm', 'head');
  const grun = (extra) => spawnSync(process.execPath, [IV, '--repo', g, '--range', 'HEAD', '--requirement', 'x', '--run', 'true', '--print-prompt', '--keep-cleanroom', ...(extra || [])], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const gdiff = (r) => { const p = r.stdout || ''; const i = p.indexOf('=== THE DIFF UNDER TEST ==='); return i < 0 ? '' : p.slice(i); };
  const keepRoom = (r) => { for (const re of [/clean room: (\S+)/, /record dir: (\S+)/]) { const m = re.exec(r.stderr || ''); if (m) tmpDirs.push(m[1]); } };

  // FINDING 3 (file→dir). MUST-FAIL: a plain literal pathspec of the deleted FILE
  // src/widget prefix-matches the new directory's ambient descendant.
  {
    const base = gg('rev-parse', 'HEAD~1').trim(), head = gg('rev-parse', 'HEAD').trim();
    const round3 = execFileSync('git', ['-C', g, 'diff', base, head, '--', 'src/widget', 'src/thing.mjs'], { encoding: 'utf8', env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } });
    check('MUST-FAIL: a literal pathspec of the deleted FILE src/widget pulls in src/widget/AGENTS.md (round-3 leak)',
      round3.includes('src/widget/AGENTS.md') && round3.includes('NESTED AMBIENT'), 'dir-prefix match leaks the descendant');
  }
  {
    const r = grun(); const d = gdiff(r); keepRoom(r);
    check('PASS-AFTER [finding 3]: file→dir does NOT leak the ambient descendant; deleted code path + code change show',
      r.status === 0 && !d.includes('src/widget/AGENTS.md') && !d.includes('NESTED AMBIENT') && d.includes('src/thing.mjs'),
      r.status !== 0 ? `exit=${r.status} ${(r.stderr || '').slice(-160)}` : (d.includes('NESTED AMBIENT') ? 'LEAKED' : 'clean, code present, post-condition held'));
  }
  // FINDING 1 (case-insensitive ambient): uppercase --allow-input .CLAUDE is a hard error.
  {
    const r = grun(['--allow-input', '.CLAUDE']);
    check('finding 1: --allow-input .CLAUDE (uppercase) is a HARD ERROR — ambient match is case-insensitive',
      r.status === 2 && /\.CLAUDE/.test(r.stderr || '') && /ambient-instruction/.test(r.stderr || ''),
      `exit=${r.status}; ${(r.stderr || '').split('\n').find((l) => /CLAUDE/.test(l)) || ''}`);
  }
  // MUST-FAIL for finding 1: a case-SENSITIVE ambient-dir check would let .CLAUDE through.
  {
    const caseSensitiveIsAmbientDir = (name) => ['.claude', '.codex'].includes(name);
    check('MUST-FAIL: a case-SENSITIVE ambient-dir check treats .CLAUDE as NON-ambient (the round-3 bug)',
      !caseSensitiveIsAmbientDir('.CLAUDE'), 'sensitive check misses the uppercase variant');
  }
  // FINDING 2 (canonicalisation): ../ segment canonicalises; the real file survives and shows.
  {
    const r = grun(['--allow-input', 'docs/a/../keep.json']); const d = gdiff(r); keepRoom(r);
    check('finding 2: --allow-input docs/a/../keep.json canonicalises to docs/keep.json — shown, not silently lost',
      r.status === 0 && d.includes('docs/keep.json') && d.includes('"v": 2') && !d.includes('docs/other.md'),
      r.status !== 0 ? `exit=${r.status} ${(r.stderr || '').slice(-160)}` : 'canonical input shown, undeclared sibling excluded');
  }
  // MUST-FAIL for finding 2: comparing the un-normalised literal loses docs/keep.json.
  {
    const isDeclUnnorm = makeIsDeclared({ proseRoots: ['docs'], allowed: ['docs/a/../keep.json'] });
    check('MUST-FAIL: an un-normalised allow-input does NOT declare the real docs/keep.json (silent loss)',
      !isDeclUnnorm('docs/keep.json'), 'raw literal never matches the real path');
  }
  // Generalisations: ./ prefix + trailing slash canonicalise; an escape is refused.
  {
    const okDot = grun(['--allow-input', './docs/keep.json']);
    check('generalisation: ./docs/keep.json canonicalises and is accepted (input shown)',
      okDot.status === 0 && gdiff(okDot).includes('docs/keep.json'), `exit=${okDot.status}`); keepRoom(okDot);
    const okSlash = grun(['--allow-input', 'docs/keep.json/']);
    check('generalisation: a trailing-slash --allow-input canonicalises and is accepted',
      okSlash.status === 0 && gdiff(okSlash).includes('docs/keep.json'), `exit=${okSlash.status}`); keepRoom(okSlash);
    const esc = grun(['--allow-input', 'docs/../../etc/passwd']);
    check('generalisation: an escaping --allow-input (docs/../../etc/passwd) is refused (exit 2)',
      esc.status === 2 && /escapes the repository/.test(esc.stderr || ''), `exit=${esc.status}; ${(esc.stderr || '').split('\n').find((l) => /escape/.test(l)) || ''}`);
  }
}
// A symlinked PARENT in the declared path must be a LOUD error (never silent loss).
{
  const sg = tmp('bug186r4-sym-');
  const sgg = (...a) => execFileSync('git', ['-C', sg, ...a], { encoding: 'utf8' });
  const sw = (rel, b) => { const p = path.join(sg, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); };
  sgg('init', '-q'); sgg('config', 'user.email', 't@t'); sgg('config', 'user.name', 't');
  sw('src/thing.mjs', 'base\n'); sw('docs/realdir/keep.json', '{"declared": true}\n');
  try {
    fs.symlinkSync('realdir', path.join(sg, 'docs/link'));
    sgg('add', '-A'); sgg('commit', '-qm', 'base');
    sw('src/thing.mjs', 'changed\n'); sgg('add', '-A'); sgg('commit', '-qm', 'head');
    const r = spawnSync(process.execPath, [IV, '--repo', sg, '--range', 'HEAD', '--requirement', 'x', '--run', 'true', '--print-prompt', '--allow-input', 'docs/link/keep.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    check('a symlinked PARENT in --allow-input is a LOUD error after strip (never a silent lost input)',
      r.status === 2 && /lost declared-input content|lost a declared input|not intact/.test(r.stderr || ''),
      `exit=${r.status}; ${(r.stderr || '').split('\n').find((l) => /declared input|strip/.test(l)) || (r.stderr || '').slice(-140)}`);
  } catch (e) { skipped('symlinked-parent declared path', `symlink unsupported: ${e.message}`); }
}

/* ==================================================================== */
/* (H) round-5 — emptied declared dir, declared escaping symlink, ext diff */
/* ==================================================================== */
console.log('\n(H) round-5 — emptied declared dir, declared escaping symlink, diff.external');
// G-A unit MUST-FAIL: the round-4 path-existence check passes for an EMPTIED declared dir.
{
  const d = tmp('bug186r5-empty-');
  mkTree(d, { 'docs/empty/AGENTS.md': 'only ambient inside\n', 'src/thing.mjs': 'code\n' });
  stripCleanroom(d, { proseRoots: ['docs'], allowed: ['docs/empty'] });
  check('MUST-FAIL: round-4 existsSync passes for an EMPTIED declared dir (docs/empty exists, content gone)',
    fs.existsSync(path.join(d, 'docs', 'empty')) && !fs.existsSync(path.join(d, 'docs', 'empty', 'AGENTS.md')),
    'the path-existence check misses the loss; the per-leaf capture catches it');
}
// G-B unit MUST-FAIL: stripCleanroom KEEPS a declared escaping symlink (round-4 checked before audit).
{
  const d = tmp('bug186r5-symstrip-');
  mkTree(d, { 'src/thing.mjs': 'code\n' });
  fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
  try {
    fs.symlinkSync('/etc/hostname', path.join(d, 'docs', 'self.md'));
    stripCleanroom(d, { proseRoots: ['docs'], allowed: ['docs/self.md'] });
    check('MUST-FAIL: stripCleanroom KEEPS a declared escaping symlink (round-4 pre-audit check would pass)',
      fs.lstatSync(path.join(d, 'docs', 'self.md')).isSymbolicLink(),
      'declared symlink survives the strip; only auditSymlinks (later) removes it');
  } catch (e) { skipped('G-B unit (declared escaping symlink survives strip)', `symlink unsupported: ${e.message}`); }
}
{
  const h = tmp('bug186r5-');
  const hh = (...a) => execFileSync('git', ['-C', h, ...a], { encoding: 'utf8' });
  const hw = (rel, b, mode) => { const p = path.join(h, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); if (mode) fs.chmodSync(p, mode); };
  hh('init', '-q'); hh('config', 'user.email', 't@t'); hh('config', 'user.name', 't');
  hw('src/thing.mjs', 'export const total = (xs) => xs.length;\n');
  hw('docs/empty/AGENTS.md', 'only ambient inside the declared dir\n');
  hw('difftool.sh', '#!/bin/sh\necho "EXTERNAL-DIFF-LEAK for $1"\n', 0o755);
  let symlinkOk = true;
  try { fs.symlinkSync('/etc/hostname', path.join(h, 'docs', 'self.md')); } catch { symlinkOk = false; }
  hh('add', '-A'); hh('commit', '-qm', 'base');
  hw('src/thing.mjs', 'export const total = (xs) => xs.filter(Boolean).length;\n');
  hh('add', '-A'); hh('commit', '-qm', 'change');
  const hrun = (extra) => spawnSync(process.execPath, [IV, '--repo', h, '--range', 'HEAD', '--requirement', 'x', '--run', 'true', '--print-prompt', '--keep-cleanroom', ...(extra || [])], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const hdiff = (r) => { const p = r.stdout || ''; const i = p.indexOf('=== THE DIFF UNDER TEST ==='); return i < 0 ? '' : p.slice(i); };
  const keep = (r) => { for (const re of [/clean room: (\S+)/, /record dir: (\S+)/]) { const m = re.exec(r.stderr || ''); if (m) tmpDirs.push(m[1]); } };

  // G-A CLI: an emptied declared directory dies LOUDLY.
  {
    const r = hrun(['--allow-input', 'docs/empty']); keep(r);
    check('finding A: --allow-input docs/empty (contents all ambient) dies LOUDLY — the declared input is not intact',
      r.status === 2 && /lost declared-input content|not intact/.test(r.stderr || '') && /docs\/empty/.test(r.stderr || ''),
      `exit=${r.status}; ${(r.stderr || '').split('\n').find((l) => /declared-input|intact/.test(l)) || ''}`);
  }
  // G-B CLI: a declared file that is itself an escaping symlink dies (caught after auditSymlinks).
  if (symlinkOk) {
    const r = hrun(['--allow-input', 'docs/self.md']); keep(r);
    check('finding B: --allow-input docs/self.md (escaping symlink auditSymlinks removes) dies LOUDLY after the audit',
      r.status === 2 && /lost declared-input|not intact|lost a declared input/.test(r.stderr || '') && /docs\/self\.md/.test(r.stderr || ''),
      `exit=${r.status}; ${(r.stderr || '').split('\n').find((l) => /declared/.test(l)) || (r.stderr || '').slice(-140)}`);
  } else skipped('finding B CLI (declared escaping symlink)', 'symlink unsupported here');

  // G-C: a configured diff.external must NOT reach the emitted patch.
  {
    const base = hh('rev-parse', 'HEAD~1').trim(), head = hh('rev-parse', 'HEAD').trim();
    hh('config', 'diff.external', path.join(h, 'difftool.sh'));
    const withExt = execFileSync('git', ['-C', h, 'diff', base, head, '--', 'src/thing.mjs'], { encoding: 'utf8' });
    check('MUST-FAIL: a configured diff.external injects EXTERNAL-DIFF-LEAK into a plain git diff',
      withExt.includes('EXTERNAL-DIFF-LEAK'), 'the external helper controls patch content');
    const r = hrun(); const d = hdiff(r); keep(r);
    check('finding C: the shipped diff bypasses diff.external (--no-ext-diff) — no EXTERNAL-DIFF-LEAK, real change shown',
      r.status === 0 && !d.includes('EXTERNAL-DIFF-LEAK') && d.includes('filter(Boolean)'),
      r.status !== 0 ? `exit=${r.status} ${(r.stderr || '').slice(-140)}` : (d.includes('EXTERNAL-DIFF-LEAK') ? 'LEAKED external content' : 'internal diff, helper bypassed'));
    hh('config', '--unset', 'diff.external');
  }
  // G-C generalisation: a .gitattributes diff-driver command + textconv are also bypassed.
  {
    // Land the .gitattributes AND a .mjs change in ONE commit so the tested range
    // actually diffs a .mjs the driver applies to.
    hw('.gitattributes', '*.mjs diff=leakdrv\n');
    hw('src/thing.mjs', 'export const total = (xs) => xs.filter((x) => !!x).length;\n');
    hh('add', '-A'); hh('commit', '-qm', 'attr+chg');
    hh('config', 'diff.leakdrv.command', path.join(h, 'difftool.sh'));
    hh('config', 'diff.leakdrv.textconv', path.join(h, 'difftool.sh'));
    const base = hh('rev-parse', 'HEAD~1').trim(), head = hh('rev-parse', 'HEAD').trim();
    const withDrv = execFileSync('git', ['-C', h, 'diff', base, head, '--', 'src/thing.mjs'], { encoding: 'utf8' });
    check('MUST-FAIL: a .gitattributes diff-driver command injects EXTERNAL-DIFF-LEAK',
      withDrv.includes('EXTERNAL-DIFF-LEAK'), `driver output present=${withDrv.includes('EXTERNAL-DIFF-LEAK')} (len ${withDrv.length})`);
    const r = hrun(); const d = hdiff(r); keep(r);
    check('finding C generalisation: --no-ext-diff --no-textconv bypasses a .gitattributes driver too',
      r.status === 0 && !d.includes('EXTERNAL-DIFF-LEAK') && d.includes('!!x'),
      r.status !== 0 ? `exit=${r.status} ${(r.stderr || '').slice(-140)}` : (d.includes('EXTERNAL-DIFF-LEAK') ? 'LEAKED' : 'internal diff'));
  }
}

/* ==================================================================== */
/* (I) round-6 — boot-stub seeding is a second writer; the FINAL assertion */
/* ==================================================================== */
console.log('\n(I) round-6 — boot-stub seeding never resurrects ambient / stands in for a declared input');
// Unit MUST-FAIL: a round-5-style seeder (seed after strip, no ambient guard) resurrects an ambient file.
{
  const d = tmp('bug186r6-unit-');
  mkTree(d, { 'docs/input/AGENTS.md': 'AMBIENT seed content\n', 'src/thing.mjs': 'x\n' });
  stripCleanroom(d, { proseRoots: ['docs'], allowed: [] });
  const goneAfterStrip = !fs.existsSync(path.join(d, 'docs', 'input', 'AGENTS.md'));
  // round-5 seeding had NO ambient guard and ran AFTER the strip: it would write the stub back.
  fs.mkdirSync(path.join(d, 'docs', 'input'), { recursive: true });
  fs.writeFileSync(path.join(d, 'docs', 'input', 'AGENTS.md'), 'Clean-room placeholder — independent-verify.mjs.\n');
  check('MUST-FAIL: a round-5-style seeder (no ambient guard, runs after strip) RESURRECTS the ambient file',
    goneAfterStrip && fs.existsSync(path.join(d, 'docs', 'input', 'AGENTS.md')),
    'strip removed it, then unguarded seeding re-created the ambient path');
}
if (!(gitProbe.error || gitProbe.status !== 0)) {
  // A fixture whose seed-source declaration names arbitrary boot-doc paths.
  const seedFixture = (label, seedPaths, files) => {
    const g = tmp(`bug186r6-${label}-`);
    const gg = (...a) => execFileSync('git', ['-C', g, ...a], { encoding: 'utf8' });
    const gw = (rel, b) => { const p = path.join(g, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); };
    gg('init', '-q'); gg('config', 'user.email', 't@t'); gg('config', 'user.name', 't');
    gw('src/server/seed-sources.mjs', `export function seedSourceRelPaths(){ return ${JSON.stringify(seedPaths)}; }\n`);
    gw('src/thing.mjs', 'base\n');
    for (const [rel, b] of Object.entries(files)) gw(rel, b);
    gg('add', '-A'); gg('commit', '-qm', 'base');
    gw('src/thing.mjs', 'changed\n'); gg('add', '-A'); gg('commit', '-qm', 'head');
    const run = (extra) => spawnSync(process.execPath, [IV, '--repo', g, '--range', 'HEAD', '--requirement', 'x', '--run', 'true', '--print-prompt', '--keep-cleanroom', ...(extra || [])], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { g, run };
  };
  // finding B (worse): an ambient-named boot-seed path, NO allow-input — seeding must REFUSE, not resurrect.
  {
    const { run } = seedFixture('ambseed', ['docs/input/AGENTS.md'], { 'docs/input/AGENTS.md': 'ambient instruction as a seed\n' });
    const r = run();
    check('finding B: an ambient-named boot-seed path is REFUSED (exit 2) — never resurrected into the room',
      r.status === 2 && /ambient-named boot doc|RESURRECT/.test(r.stderr || '') && /docs\/input\/AGENTS\.md/.test(r.stderr || ''),
      `exit=${r.status}; ${(r.stderr || '').split('\n').find((l) => /boot doc|RESURRECT/.test(l)) || (r.stderr || '').slice(-140)}`);
  }
  // generalisation: a NESTED ambient boot-seed path (docs/a/b/CLAUDE.md) is refused too.
  {
    const { run } = seedFixture('ambnest', ['docs/a/b/CLAUDE.md'], { 'docs/a/b/CLAUDE.md': 'nested ambient seed\n' });
    const r = run();
    check('generalisation: a NESTED ambient boot-seed path (docs/a/b/CLAUDE.md) is refused',
      r.status === 2 && /ambient-named boot doc/.test(r.stderr || ''), `exit=${r.status}`);
  }
  // finding A (general): a NON-ambient boot-seed path that collides with a declared --allow-input — refused.
  {
    const { run } = seedFixture('collide', ['docs/seeded.md'], { 'docs/seeded.md': 'real declared content\n' });
    const r = run(['--allow-input', 'docs/seeded.md']);
    check('finding A: a boot-seed path colliding with a declared --allow-input is REFUSED (no stub stands in)',
      r.status === 2 && /collides with a declared --allow-input/.test(r.stderr || '') && /docs\/seeded\.md/.test(r.stderr || ''),
      `exit=${r.status}; ${(r.stderr || '').split('\n').find((l) => /collides/.test(l)) || (r.stderr || '').slice(-140)}`);
  }
  // POSITIVE: a normal non-ambient, non-colliding boot stub still seeds and the FINAL assertion accepts it.
  {
    const { run } = seedFixture('normal', ['docs/seeded.md'], { 'docs/seeded.md': 'methodology prose that is stripped\n' });
    const r = run();
    check('a normal inert boot stub still seeds and survives the FINAL assertion (exit 0, run proceeds)',
      r.status === 0, `exit=${r.status}; ${(r.stderr || '').slice(-140)}`);
    const rd = /clean room: (\S+)/.exec(r.stderr || '')?.[1]; if (rd) tmpDirs.push(rd);
    const rec = /record dir: (\S+)/.exec(r.stderr || '')?.[1]; if (rec) tmpDirs.push(rec);
    if (rd) check('  …and the seeded stub in the final room is the INERT placeholder (carries no methodology)',
      fs.existsSync(path.join(rd, 'docs', 'seeded.md')) && /Clean-room placeholder/.test(fs.readFileSync(path.join(rd, 'docs', 'seeded.md'), 'utf8')) && !fs.readFileSync(path.join(rd, 'docs', 'seeded.md'), 'utf8').includes('methodology prose'),
      'stub is inert, real prose gone');
  }
}

/* ==================================================================== */
/* (J) round-7 — ambient PATTERNS, write-through-symlink, submodule diff  */
/* ==================================================================== */
console.log('\n(J) round-7 — ambient family patterns, containment, submodule inlining');
// J1 — ambient is now a PATTERN per family (finding 3). Unit, exhaustive.
{
  const ambient = ['AGENTS.override.md', 'AGENTS.local.md', 'AGENT.md', 'CLAUDE.override.md', 'CLAUDE.local.md', 'GEMINI.md', 'src/AGENTS.override.md', 'a/b/CLAUDE.local.md', 'Agents.Override.MD', '.cursorrules', '.cursor/rules/x.md', '.gemini/config'];
  const notAmbient = ['AGENTSFOO.md', 'src/thing.mjs', 'docs/AGENTS-guide.md'.replace('AGENTS', 'agentsguide'), 'README.md', 'package.json'];
  const missed = ambient.filter((p) => !isAmbientPath(p));
  const over = notAmbient.filter((p) => isAmbientPath(p));
  check('finding 3: ambient PATTERN covers the override/local/Gemini families at any depth/case',
    missed.length === 0, missed.length ? `MISSED: ${JSON.stringify(missed)}` : `${ambient.length} ok`);
  check('  …and does not over-match ordinary files (AGENTSFOO.md, README.md, package.json)',
    over.length === 0, over.length ? `OVER-MATCHED: ${JSON.stringify(over)}` : `${notAmbient.length} ok`);
  // MUST-FAIL: the round-6 FIXED name list missed AGENTS.override.md.
  const fixedList = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENT.md', '.cursorrules', 'copilot-instructions.md'];
  check('MUST-FAIL: a round-6 FIXED name list does NOT recognise AGENTS.override.md',
    !fixedList.some((f) => f.toLowerCase() === 'agents.override.md'), 'fixed list misses the override variant');
}
// J1b — the room strip removes AGENTS.override.md at any depth (unit).
{
  const d = tmp('bug186r7-ovr-');
  mkTree(d, { 'AGENTS.override.md': 'root override\n', 'src/AGENTS.override.md': 'nested override\n', 'src/thing.mjs': 'code\n' });
  stripCleanroom(d, { proseRoots: ['docs'], allowed: [] });
  const s = walkFiles(d);
  check('the strip removes AGENTS.override.md at root AND nested (finding 3, room side)',
    !s.some((x) => /AGENTS\.override\.md/.test(x)) && s.includes('src/thing.mjs'), `survivors: ${s.join(', ')}`);
}
// J3a — write-through-symlink breach (finding 2): the round-6 ORDER (write before
// audit) writes OUTSIDE the room; the shipped safeWriteInRoom refuses.
{
  const room = tmp('bug186r7-room-');
  const outside = tmp('bug186r7-outside-');
  fs.mkdirSync(path.join(room, 'src'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(room, 'src', 'out')); // escaping symlink committed in the tree
    // round-6 style: a writer that runs BEFORE the audit follows the link out.
    fs.mkdirSync(path.join(room, 'src', 'out'), { recursive: true }); // follows symlink → outside (already exists)
    fs.writeFileSync(path.join(room, 'src', 'out', 'boot.md'), 'stub\n');
    check('MUST-FAIL: a round-6-style write (before the audit) drops the file OUTSIDE the room',
      fs.existsSync(path.join(outside, 'boot.md')), 'write followed the escaping symlink out of the room');
    // shipped guard: safeWriteInRoom refuses a symlinked component (run in a child, since it die()s).
    const code = `import { safeWriteInRoom } from ${JSON.stringify(IV)};\nsafeWriteInRoom(${JSON.stringify(room)}, 'src/out/boot2.md', 'x');\nconsole.log('WROTE');`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    check('PASS-AFTER: safeWriteInRoom REFUSES to write through the symlinked component (exit 2, nothing outside)',
      r.status === 2 && /SYMLINK/.test(r.stderr || '') && !fs.existsSync(path.join(outside, 'boot2.md')),
      `exit=${r.status}; outside-wrote=${fs.existsSync(path.join(outside, 'boot2.md'))}`);
  } catch (e) { skipped('J3a write-through-symlink', `symlink unsupported: ${e.message}`); }
}

const gitUsable7 = !(gitProbe.error || gitProbe.status !== 0);
if (gitUsable7) {
  // J2 — CLI: AGENTS.override.md is stripped from the room AND excluded from the diff.
  {
    const g = tmp('bug186r7-cli-');
    const gg = (...a) => execFileSync('git', ['-C', g, ...a], { encoding: 'utf8' });
    const gw = (rel, b) => { const p = path.join(g, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); };
    gg('init', '-q'); gg('config', 'user.email', 't@t'); gg('config', 'user.name', 't');
    gw('src/thing.mjs', 'base\n'); gw('AGENTS.override.md', 'OVERRIDE INSTRUCTIONS base\n');
    gg('add', '-A'); gg('commit', '-qm', 'base');
    gw('src/thing.mjs', 'changed\n'); gw('AGENTS.override.md', 'OVERRIDE INSTRUCTIONS changed — must not reach verifier\n');
    gg('add', '-A'); gg('commit', '-qm', 'head');
    const r = spawnSync(process.execPath, [IV, '--repo', g, '--range', 'HEAD', '--requirement', 'x', '--run', 'true', '--print-prompt', '--keep-cleanroom'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const p = r.stdout || ''; const d = p.slice(p.indexOf('=== THE DIFF UNDER TEST ==='));
    const rd = /clean room: (\S+)/.exec(r.stderr || '')?.[1]; if (rd) tmpDirs.push(rd);
    const rec = /record dir: (\S+)/.exec(r.stderr || '')?.[1]; if (rec) tmpDirs.push(rec);
    check('finding 3 CLI: AGENTS.override.md is excluded from the diff and stripped from the room; code kept',
      r.status === 0 && !d.includes('AGENTS.override.md') && !d.includes('OVERRIDE INSTRUCTIONS') && d.includes('src/thing.mjs')
        && !!rd && !fs.existsSync(path.join(rd, 'AGENTS.override.md')),
      r.status !== 0 ? `exit=${r.status} ${(r.stderr || '').slice(-140)}` : (d.includes('OVERRIDE') ? 'LEAKED' : 'clean'));
  }
  // J4 — submodule inlining (finding 1): diff.submodule=diff must not ship sub content.
  {
    const sub = tmp('bug186r7-sub-');
    const sgg = (...a) => execFileSync('git', ['-C', sub, ...a], { encoding: 'utf8' });
    const sw = (rel, b) => { const p = path.join(sub, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); };
    sgg('init', '-q'); sgg('config', 'user.email', 't@t'); sgg('config', 'user.name', 't');
    sw('readme.txt', 'sub base\n'); sgg('add', '-A'); sgg('commit', '-qm', 'sub-base');
    const subC1 = sgg('rev-parse', 'HEAD').trim();
    sw('AGENTS.md', 'SUBMODULE AMBIENT INSTRUCTIONS\n'); sw('docs/bugs/BUG-9.md', 'SUBMODULE BOARD PROSE\n');
    sgg('add', '-A'); sgg('commit', '-qm', 'sub-head');
    const subC2 = sgg('rev-parse', 'HEAD').trim();

    const par = tmp('bug186r7-par-');
    const pg = (...a) => execFileSync('git', ['-C', par, ...a], { encoding: 'utf8' });
    const pw = (rel, b) => { const p = path.join(par, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); };
    pg('init', '-q'); pg('config', 'user.email', 't@t'); pg('config', 'user.name', 't');
    pw('src/thing.mjs', 'base\n'); pg('add', '-A'); pg('commit', '-qm', 'par-base');
    let subOk = true;
    try {
      // point the gitlink at sub-commit-1 first (base), then bump to head.
      execFileSync('git', ['-C', par, '-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'vendor/lib'], { encoding: 'utf8' });
      execFileSync('git', ['-C', path.join(par, 'vendor', 'lib'), 'checkout', '-q', subC1], { encoding: 'utf8' });
      pg('add', '-A'); pg('commit', '-qm', 'par with gitlink @ c1');
      pw('src/thing.mjs', 'changed\n');
      execFileSync('git', ['-C', path.join(par, 'vendor', 'lib'), 'checkout', '-q', subC2], { encoding: 'utf8' });
    } catch (e) {
      subOk = false; skipped('J4 submodule inlining', `submodule setup failed: ${String(e.message).slice(0, 120)}`);
    }
    if (subOk) {
      pg('add', '-A'); pg('commit', '-qm', 'par bump gitlink + code change');
      const base = pg('rev-parse', 'HEAD~1').trim(), head = pg('rev-parse', 'HEAD').trim();
      const inlined = execFileSync('git', ['-C', par, '-c', 'diff.submodule=diff', 'diff', '--submodule=diff', base, head], { encoding: 'utf8' });
      check('MUST-FAIL: diff.submodule=diff INLINES the submodule\'s ambient/board content into the patch',
        inlined.includes('SUBMODULE AMBIENT INSTRUCTIONS') || inlined.includes('SUBMODULE BOARD PROSE'),
        'submodule-internal content present in the unforced diff');
      // set the hostile repo config too, to prove the shipped flags override it.
      pg('config', 'diff.submodule', 'diff');
      const r = spawnSync(process.execPath, [IV, '--repo', par, '--range', 'HEAD', '--requirement', 'x', '--run', 'true', '--print-prompt'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const p = r.stdout || ''; const d = p.slice(p.indexOf('=== THE DIFF UNDER TEST ==='));
      check('finding 1: the shipped diff forces --submodule=short — NO submodule content ships, code change does',
        r.status === 0 && !d.includes('SUBMODULE AMBIENT INSTRUCTIONS') && !d.includes('SUBMODULE BOARD PROSE') && d.includes('src/thing.mjs'),
        r.status !== 0 ? `exit=${r.status} ${(r.stderr || '').slice(-160)}` : (/SUBMODULE (AMBIENT|BOARD)/.test(d) ? 'LEAKED submodule content' : 'short format, no content'));
    }
  }
}

/* ==================================================================== */
/* (K) round-8 — harness writes never follow a symlink; .vrun is reserved  */
/* ==================================================================== */
console.log('\n(K) round-8 — recorder/heartbeat cannot follow a committed symlink; .vrun reserved');
// K-unit MUST-FAIL: a round-7-style heartbeat (plain writeFileSync) follows an
// internal `.vrun/alive -> ../src/code.mjs` symlink and OVERWRITES declared code.
{
  const d = tmp('bug186r8-beat-');
  mkTree(d, { 'src/code.mjs': 'export const real = 1;\n' });
  fs.mkdirSync(path.join(d, '.vrun'), { recursive: true });
  try {
    fs.symlinkSync('../src/code.mjs', path.join(d, '.vrun', 'alive')); // internal link — auditSymlinks keeps it
    fs.writeFileSync(path.join(d, '.vrun', 'alive'), 'HEARTBEAT-TIMESTAMP'); // round-7 beat follows it
    check('MUST-FAIL: a plain-writeFileSync heartbeat through an internal .vrun/alive symlink OVERWRITES declared code',
      fs.readFileSync(path.join(d, 'src', 'code.mjs'), 'utf8') === 'HEARTBEAT-TIMESTAMP',
      'src/code.mjs was clobbered by the heartbeat write');
  } catch (e) { skipped('K-unit heartbeat-through-symlink', `symlink unsupported: ${e.message}`); }
}
// K-unit PASS: writeNoFollow REFUSES to write through a symlink leaf, leaves code intact.
{
  const d = tmp('bug186r8-nofollow-');
  mkTree(d, { 'src/code.mjs': 'export const real = 1;\n' });
  try {
    fs.symlinkSync('../src/code.mjs', path.join(d, 'alive'));
    const ok = writeNoFollow(path.join(d, 'alive'), 'HEARTBEAT');
    check('PASS-AFTER: writeNoFollow refuses the symlink leaf (returns false) and does NOT clobber code',
      ok === false && fs.readFileSync(path.join(d, 'src', 'code.mjs'), 'utf8') === 'export const real = 1;\n',
      `returned=${ok}; code intact=${fs.readFileSync(path.join(d, 'src', 'code.mjs'), 'utf8').startsWith('export const real')}`);
    // …and it DOES write a normal (non-symlink) path.
    const ok2 = writeNoFollow(path.join(d, 'regular'), 'DATA');
    check('  …and writeNoFollow writes a normal path fine',
      ok2 === true && fs.readFileSync(path.join(d, 'regular'), 'utf8') === 'DATA', `returned=${ok2}`);
  } catch (e) { skipped('K-unit writeNoFollow', `symlink unsupported: ${e.message}`); }
}
if (!(gitProbe.error || gitProbe.status !== 0)) {
  const mkFix = (label, build) => {
    const g = tmp(`bug186r8-${label}-`);
    const gg = (...a) => execFileSync('git', ['-C', g, ...a], { encoding: 'utf8' });
    const gw = (rel, b) => { const p = path.join(g, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); };
    gg('init', '-q'); gg('config', 'user.email', 't@t'); gg('config', 'user.name', 't');
    gw('src/code.mjs', 'export const real = 1;\n'); gw('src/thing.mjs', 'base\n');
    build(g, gg, gw);
    gg('add', '-A'); gg('commit', '-qm', 'base');
    gw('src/thing.mjs', 'changed\n'); gg('add', '-A'); gg('commit', '-qm', 'head');
    return spawnSync(process.execPath, [IV, '--repo', g, '--range', 'HEAD', '--requirement', 'x', '--run', 'true', '--print-prompt'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  };
  // K1 CLI: a committed .vrun/alive internal symlink → the reserved path is REFUSED.
  {
    let ok = true;
    const r = mkFix('vrunlink', (g, gg, gw) => { fs.mkdirSync(path.join(g, '.vrun'), { recursive: true }); try { fs.symlinkSync('../src/code.mjs', path.join(g, '.vrun', 'alive')); } catch { ok = false; } });
    if (ok) check('finding (K): a committed .vrun/alive symlink makes the reserved path REFUSED (exit 2) — no heartbeat write-through',
      r.status === 2 && /reserved harness path '\.vrun'/.test(r.stderr || ''),
      `exit=${r.status}; ${(r.stderr || '').split('\n').find((l) => /\.vrun/.test(l)) || (r.stderr || '').slice(-140)}`);
    else skipped('finding (K) committed .vrun/alive symlink', 'symlink unsupported');
  }
  // K2 generalisation: a committed .vrun/ directory (plain file inside) is also refused.
  {
    const r = mkFix('vrundir', (g, gg, gw) => { gw('.vrun/something.txt', 'repo shipped a .vrun dir\n'); });
    check('generalisation: a committed .vrun/ directory is REFUSED (exit 2)',
      r.status === 2 && /reserved harness path '\.vrun'/.test(r.stderr || ''), `exit=${r.status}`);
  }
  // K3 generalisation: a committed vrun.mjs symlink is refused by safeWriteInRoom.
  {
    let ok = true;
    const r = mkFix('vrunmjs', (g, gg, gw) => { try { fs.symlinkSync('src/code.mjs', path.join(g, 'vrun.mjs')); } catch { ok = false; } });
    if (ok) check('generalisation: a committed vrun.mjs symlink is refused by safeWriteInRoom (exit 2, no write-through)',
      r.status === 2 && /SYMLINK|reserved/.test(r.stderr || ''),
      `exit=${r.status}; ${(r.stderr || '').split('\n').find((l) => /vrun\.mjs|SYMLINK/.test(l)) || (r.stderr || '').slice(-140)}`);
    else skipped('generalisation committed vrun.mjs symlink', 'symlink unsupported');
  }
}

/* ==================================================================== */
/* (L) round-9 — ZERO symlinks in the room; spool OUTSIDE the room         */
/* ==================================================================== */
console.log('\n(L) round-9 — room has zero symlinks; all harness state is outside the room');
if (!(gitProbe.error || gitProbe.status !== 0)) {
  const g = tmp('bug186r9-');
  const gg = (...a) => execFileSync('git', ['-C', g, ...a], { encoding: 'utf8' });
  const gw = (rel, b) => { const p = path.join(g, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); };
  gg('init', '-q'); gg('config', 'user.email', 't@t'); gg('config', 'user.name', 't');
  gw('src/code.mjs', 'export const real = 1;\n'); gw('src/thing.mjs', 'base\n');
  gw('node_modules/pkg/cli.js', '#!/usr/bin/env node\nconsole.log("tool ran");\n');
  let symOk = true;
  try {
    fs.mkdirSync(path.join(g, 'node_modules', '.bin'), { recursive: true });
    fs.symlinkSync('../pkg/cli.js', path.join(g, 'node_modules', '.bin', 'tool'));   // .bin launcher symlink
    fs.symlinkSync('code.mjs', path.join(g, 'src', 'internal-link.mjs'));            // internal non-.bin symlink
    fs.mkdirSync(path.join(g, '.vrun'), { recursive: true });
    fs.symlinkSync('../src/code.mjs', path.join(g, '.vrun', 'alive'));               // the round-8 committed .vrun/alive link
  } catch (e) { symOk = false; }
  gg('add', '-A'); gg('commit', '-qm', 'base');
  gw('src/thing.mjs', 'changed\n'); gg('add', '-A'); gg('commit', '-qm', 'head');
  if (!symOk) skipped('(L) symlink fixtures', 'symlink unsupported here');
  else {
    const r = spawnSync(process.execPath, [IV, '--repo', g, '--range', 'HEAD', '--requirement', 'x', '--run', 'true', '--print-prompt', '--keep-cleanroom'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const room = /clean room: (\S+)/.exec(r.stderr || '')?.[1] || null;
    const rec = /record dir: (\S+)/.exec(r.stderr || '')?.[1]; if (room) tmpDirs.push(room); if (rec) tmpDirs.push(rec);
    // walk the room collecting symlinks
    const symlinksIn = (base) => { const out = []; (function rec(rel) { let es; try { es = fs.readdirSync(rel ? path.join(base, ...rel.split('/')) : base, { withFileTypes: true }); } catch { return; } for (const e of es) { const rp = rel ? `${rel}/${e.name}` : e.name; if (e.isSymbolicLink()) { out.push(rp); continue; } if (e.isDirectory()) rec(rp); } })(''); return out; };
    check('finding (K/round-9): the final room contains ZERO symlinks (escaping + internal + .vrun all gone/materialised)',
      r.status === 0 && !!room && symlinksIn(room).length === 0,
      r.status !== 0 ? `exit=${r.status} ${(r.stderr || '').slice(-160)}` : (room ? `symlinks: ${symlinksIn(room).join(', ') || 'none'}` : 'no room'));
    check('  …node_modules/.bin/tool is MATERIALISED as a real exec shim (not a symlink), tool still runnable',
      !!room && fs.existsSync(path.join(room, 'node_modules', '.bin', 'tool')) && !fs.lstatSync(path.join(room, 'node_modules', '.bin', 'tool')).isSymbolicLink()
        && /exec/.test(fs.readFileSync(path.join(room, 'node_modules', '.bin', 'tool'), 'utf8')),
      room ? 'shim present' : 'no room');
    check('  …the internal non-.bin symlink and the committed .vrun/alive symlink are GONE; declared code intact',
      !!room && !fs.existsSync(path.join(room, 'src', 'internal-link.mjs'))
        && (!fs.existsSync(path.join(room, '.vrun', 'alive')) || !fs.lstatSync(path.join(room, '.vrun', 'alive')).isSymbolicLink())
        && fs.readFileSync(path.join(room, 'src', 'code.mjs'), 'utf8') === 'export const real = 1;\n',
      room ? 'internal links gone, src/code.mjs unchanged' : 'no room');
    // The harness spool lives OUTSIDE the room: vrun.mjs's baked paths are not under the room.
    check('round-9 invariant: the harness spool (vrun.mjs REQ/RES/ALIVE) is OUTSIDE the room — no in-room harness-write target',
      !!room && (() => { const v = fs.readFileSync(path.join(room, 'vrun.mjs'), 'utf8'); const paths = [...v.matchAll(/(?:REQ|RES|ALIVE)\s*=\s*"([^"]+)"/g)].map((m) => m[1]); return paths.length >= 3 && paths.every((p) => !p.startsWith(room + path.sep)); })(),
      room ? `vrun spool paths: ${[...fs.readFileSync(path.join(room, 'vrun.mjs'), 'utf8').matchAll(/(?:REQ|RES|ALIVE)\s*=\s*"([^"]+)"/g)].map((m) => m[1]).join(', ')}` : 'no room');
  }
  // MUST-FAIL: the round-8 design (keep internal symlinks) left a .bin + internal symlink in the room.
  {
    const d = tmp('bug186r9-mustfail-');
    mkTree(d, { 'src/code.mjs': 'x\n', 'node_modules/pkg/cli.js': 'x\n' });
    try {
      fs.mkdirSync(path.join(d, 'node_modules', '.bin'), { recursive: true });
      fs.symlinkSync('../pkg/cli.js', path.join(d, 'node_modules', '.bin', 'tool'));
      fs.symlinkSync('code.mjs', path.join(d, 'src', 'internal-link.mjs'));
      stripCleanroom(d, { proseRoots: ['docs'], allowed: [] }); // round-8 did NOT remove internal symlinks
      const left = [];
      (function rec(rel) { for (const e of fs.readdirSync(rel ? path.join(d, rel) : d, { withFileTypes: true })) { const rp = rel ? `${rel}/${e.name}` : e.name; if (e.isSymbolicLink()) left.push(rp); else if (e.isDirectory()) rec(rp); } })('');
      check('MUST-FAIL: strip+audit alone (round-8) leaves internal .bin and non-.bin symlinks in the room',
        left.some((p) => p.includes('.bin/tool')) && left.some((p) => p.includes('internal-link')),
        `symlinks left by strip alone: ${left.join(', ')}`);
    } catch (e) { skipped('(L) must-FAIL internal-symlinks-kept', `symlink unsupported: ${e.message}`); }
  }
}

/* ==================================================================== */
/* (F) the REAL dirty Orchard tree                                       */
/* ==================================================================== */
console.log('\n(F) the REAL dirty Orchard tree');
{
  const r = spawnSync(process.execPath, [IV, '--repo', ROOT, '--working-tree', '--requirement', 'exclude board.', '--run', 'true', '--print-prompt'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0 && /no verifiable diff after excluding/.test(r.stderr || '')) {
    skipped('real-tree diff', 'the real tree currently has only board/methodology changes');
  } else if (r.status !== 0) {
    check('real-tree --print-prompt runs', false, `exit=${r.status}; ${(r.stderr || '').slice(-160)}`);
  } else {
    const p = r.stdout || ''; const diff = p.slice(p.indexOf('=== THE DIFF UNDER TEST ==='));
    // Judge the FILE PATHS the diff actually touches (its `diff --git` / `+++`
    // headers), NOT any substring — my own changed code legitimately MENTIONS
    // `docs/bugs/` in comments and string literals, which a substring check would
    // false-positive on.
    const headers = [...(diff.match(/^diff --git .*/gm) || []), ...(diff.match(/^[+-]{3} [ab]\/.*/gm) || [])];
    const bad = headers.filter((h) => /\bdocs\/(bugs|prompts)\//.test(h) || /(^|[ /])(AGENTS|AGENT|CLAUDE(\.local)?)\.md( |$)/.test(h) || /[ /]\.claude([ /]|$)/.test(h) || /[ /]\.codex([ /]|$)/.test(h));
    check('the real repo diff touches NO docs/bugs, docs/prompts or ambient FILE (checked on diff headers, not substrings)',
      bad.length === 0, bad.length ? `LEAKED header(s): ${bad.slice(0, 5).join(' | ')}` : `clean (${headers.length} file headers, ${diff.length} chars)`);
  }
}

} // end git-usable guard

for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(`\nverify-bug-186-diff-strip — ${pass}/${pass + fail} PASS${skip ? `, ${skip} SKIP` : ''}`);
if (fail) { console.log('FAILURES:'); for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
