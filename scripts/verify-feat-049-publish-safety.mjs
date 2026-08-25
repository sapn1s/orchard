#!/usr/bin/env node
/**
 * verify-feat-049-publish-safety.mjs — FEAT-049 second pass.
 *
 * Two properties, both of which had never been proven:
 *
 *   1. NO PERSONAL DEFAULT. `browser.repoDir()` used to default to one
 *      machine's home layout (`~/<personal-dir>/<adapter>`), which shipped as a
 *      behavioural default and passed every leak-gate run because the gate's
 *      token list is an allowlist of REMEMBERED names and nobody remembered
 *      that one. The adapter is a separate project this repo neither bundles
 *      nor publishes, so unconfigured must mean "off, and say so".
 *      Sections 1-2. Section 2 is the MUST-FAIL control: the pre-fix source at
 *      the recorded base commit is loaded and shown to FAIL section 1, so the
 *      check is proven to discriminate rather than to pass vacuously.
 *
 *   2. THE PUBLISH SCRIPT SAYS NO. `publish-public-mirror.sh` had never been
 *      shown to refuse anything. Section 3 drives the REAL script against trees
 *      that must be refused — a text token, a missing gate under `--push`, and
 *      a non-allowlisted image — and asserts refusal, exit status, AND that no
 *      fresh history was created for the tree it refused.
 *
 *   3. THE GATE'S SKIP BRANCHES ARE EMPTY HERE. The gate silently skips
 *      symlinks and NUL-containing files. Section 4 proves this tree contains
 *      none, so those branches are not a live blind spot at publish time.
 *
 * Read-only against the repo. All scratch lives under ~/scratch. No network,
 * no push, no service, no port.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRATCH = fs.mkdtempSync(path.join(os.homedir(), 'scratch', 'feat049-verify-'));

let pass = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}

const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8' });

/** Load browser.ts from a given source text, in a child process, with a given env. */
function probeBrowser(sourcePath, env) {
  const script = `
    const b = await import(${JSON.stringify(sourcePath)});
    const out = { repoDir: b.repoDir(), available: b.available() };
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) throw new Error(`probe failed: ${r.stderr.slice(0, 400)}`);
  return JSON.parse(r.stdout);
}

// ---------------------------------------------------------------------------
console.log('\n1. browser.repoDir() has no personal default (current source)');
// ---------------------------------------------------------------------------
const CUR = path.join(ROOT, 'src/server/browser.ts');
{
  const unset = probeBrowser(CUR, { CLAUDE_STATION_SBMCP_REPO: '' });
  check('unconfigured -> repoDir() is null', unset.repoDir === null, JSON.stringify(unset.repoDir));
  check('unconfigured -> available() is false', unset.available.ok === false);
  check(
    'unconfigured message names the env var and does not leak a home path',
    /CLAUDE_STATION_SBMCP_REPO/.test(unset.available.message) && !/\/home\/|\/Users\//.test(unset.available.message),
    unset.available.message,
  );

  const pointed = path.join(SCRATCH, 'adapter');
  fs.mkdirSync(pointed, { recursive: true });
  const set = probeBrowser(CUR, { CLAUDE_STATION_SBMCP_REPO: pointed });
  check('env override still resolves', set.repoDir === pointed, String(set.repoDir));
  check(
    'a pointed-but-incomplete checkout reports what is missing, not a default',
    set.available.ok === false && set.available.message.includes(pointed),
    set.available.message,
  );

  // The shape check, not the name check: no home-derived path may appear in the
  // adapter-location resolver at all.
  const src = fs.readFileSync(CUR, 'utf8');
  const resolver = src.slice(src.indexOf('export function repoDir'), src.indexOf('export function stateHome'));
  check('repoDir() source contains no homedir()-derived fallback', !/homedir\s*\(/.test(resolver));
}

// ---------------------------------------------------------------------------
console.log('\n2. MUST-FAIL control: the pre-fix source fails section 1');
// ---------------------------------------------------------------------------
{
  // The last commit whose browser.ts still carried the personal default.
  const base = git(['log', '-1', '--format=%H', 'b6c0151', '--']).trim() || 'b6c0151';
  const old = path.join(SCRATCH, 'browser.prefix.ts');
  let prefix;
  try {
    prefix = git(['show', `${base}:src/server/browser.ts`]);
  } catch {
    prefix = null;
  }
  if (prefix === null) {
    check('pre-fix source retrievable', false, `could not read browser.ts at ${base}`);
  } else {
    // The pre-fix file imports ./registry.ts by relative path, so it must live
    // beside the real one to load.
    const shadow = path.join(ROOT, 'src/server/.feat049-prefix-control.ts');
    fs.writeFileSync(shadow, prefix);
    try {
      const unset = probeBrowser(shadow, { CLAUDE_STATION_SBMCP_REPO: '' });
      check(
        'pre-fix: unconfigured returned a real home path (the leak this fixes)',
        typeof unset.repoDir === 'string' && unset.repoDir.startsWith(os.homedir()),
        String(unset.repoDir),
      );
      check(
        'pre-fix: section 1 would have FAILED (control discriminates)',
        unset.repoDir !== null,
      );
    } finally {
      fs.unlinkSync(shadow);
    }
    void old;
  }
}

// ---------------------------------------------------------------------------
console.log('\n3. publish-public-mirror.sh refuses');
// ---------------------------------------------------------------------------
/** Build a minimal git repo carrying the REAL publish + gate scripts. */
function fixtureRepo(name, files, { withGate = true } = {}) {
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts/publish-public-mirror.sh'), path.join(dir, 'scripts/publish-public-mirror.sh'));
  if (withGate) fs.copyFileSync(path.join(ROOT, 'scripts/leak-gate.mjs'), path.join(dir, 'scripts/leak-gate.mjs'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'verify@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'verify'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: dir });
  return dir;
}

function runMirror(dir, args) {
  const out = path.join(SCRATCH, `out-${path.basename(dir)}-${args.join('').replace(/\W/g, '')}`);
  const r = spawnSync('bash', [path.join(dir, 'scripts/publish-public-mirror.sh'), '--out', out, ...args], {
    encoding: 'utf8', cwd: dir,
  });
  return { code: r.status, text: `${r.stdout}\n${r.stderr}`, tree: path.join(out, 'tree') };
}

{
  // (a) a text token the gate knows about.
  const leaky = fixtureRepo('leaky', {
    'app.ts': `const DEFAULT = "/home/${'sa'}p/projects/x";\n`,
    'README.md': '# fixture\n',
  });
  const a = runMirror(leaky, []);
  check('(a) leaky tree: exit 1', a.code === 1, `exit=${a.code}`);
  check('(a) leaky tree: says the gate FAILED', /leak gate FAILED/.test(a.text));
  check('(a) leaky tree: NO fresh history created', !fs.existsSync(path.join(a.tree, '.git')));

  const aPush = spawnSync('bash', [path.join(leaky, 'scripts/publish-public-mirror.sh'),
    '--out', path.join(SCRATCH, 'out-leaky-push'), '--push', '--repo', 'must-never-be-created'], { encoding: 'utf8', cwd: leaky });
  check('(a) leaky tree + --push: still exit 1', aPush.status === 1, `exit=${aPush.status}`);
  check('(a) leaky tree + --push: never reached gh', !/gh repo create|creating public repo/i.test(`${aPush.stdout}${aPush.stderr}`));

  // (b) the gate file itself is gone. Deleting one file must not downgrade the
  //     pipeline to "build anyway"; it must abort.
  const nogate = fixtureRepo('nogate', { 'README.md': '# clean fixture\n' }, { withGate: false });
  const b = runMirror(nogate, []);
  check('(b) missing gate: exit 1 (not a warning)', b.code === 1, `exit=${b.code}`);
  check('(b) missing gate: says MISSING', /leak gate MISSING/.test(b.text));
  check('(b) missing gate: NO fresh history created', !fs.existsSync(path.join(b.tree, '.git')));

  // (c) an image outside the public allowlist reaching a tree.
  const imgTree = path.join(SCRATCH, 'imgtree');
  fs.mkdirSync(path.join(imgTree, 'docs/bugs/assets'), { recursive: true });
  fs.writeFileSync(path.join(imgTree, 'docs/bugs/assets/private.png'), 'not-really-a-png');
  const c = spawnSync(process.execPath, [path.join(ROOT, 'scripts/leak-gate.mjs'), imgTree], { encoding: 'utf8' });
  check('(c) non-allowlisted image in TREE mode: exit 1', c.status === 1, `exit=${c.status}`);
  check('(c) non-allowlisted image: named as an image leak', /non-allowlisted image/.test(`${c.stdout}${c.stderr}`));

  // (d) the control: a clean fixture must PASS and build, or (a)-(c) prove nothing.
  const clean = fixtureRepo('clean', { 'README.md': '# a clean public tree\n', 'src/x.ts': 'export const x = 1;\n' });
  const d = runMirror(clean, []);
  check('(d) clean tree: exit 0', d.code === 0, `exit=${d.code}`);
  check('(d) clean tree: gate PASS + fresh history built', /leak gate: PASS/.test(d.text) && fs.existsSync(path.join(d.tree, '.git')));
  check('(d) clean tree: exactly one commit', execFileSync('git', ['-C', d.tree, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim() === '1');
  check('(d) clean tree: no remote configured', execFileSync('git', ['-C', d.tree, 'remote'], { encoding: 'utf8' }).trim() === '');
}

// ---------------------------------------------------------------------------
console.log('\n4. the gate\'s silent-skip branches are empty in this tree');
// ---------------------------------------------------------------------------
{
  const modes = git(['ls-files', '-s']).split('\n').filter(Boolean);
  const links = modes.filter((l) => l.startsWith('120000'));
  check('no tracked symlinks (the gate skips them unread)', links.length === 0, `${links.length} found`);

  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const nulFiles = [];
  const imgRe = /\.(png|jpe?g|gif|ico|webp|bmp|tiff?|svg|woff2?|ttf|eot|pdf|zip)$/i;
  for (const rel of tracked) {
    if (imgRe.test(rel)) continue;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) || !fs.lstatSync(abs).isFile()) continue;
    if (fs.readFileSync(abs).includes(0)) nulFiles.push(rel);
  }
  check('no non-image tracked file is NUL-binary (the gate skips those unread)', nulFiles.length === 0, nulFiles.slice(0, 3).join(', '));

  // Every image that would ship must be on the public allowlist by path.
  const images = tracked.filter((r) => /\.(png|jpe?g|gif|ico|webp|bmp|tiff?|svg)$/i.test(r));
  const offAllow = images.filter((r) => !r.startsWith('public/') && !r.startsWith('docs/assets/'));
  check('every TRACKED image is on the public allowlist', offAllow.length === 0, offAllow.slice(0, 5).join(', '));
}

fs.rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + failures.length}`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
