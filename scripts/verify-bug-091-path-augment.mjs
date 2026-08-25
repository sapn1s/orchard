/**
 * BUG-091 — host-side engine spawns must resolve user-installed MCP tools even
 * when the service was cold-booted with a minimal systemd PATH.
 *
 *   node scripts/verify-bug-091-path-augment.mjs
 *
 * SYNTHETIC (no dependence on uvx being installed): a scratch HOME tree holds a
 * stub executable under `.local/bin`; a base env whose PATH excludes it cannot
 * resolve it, but the SAME base env run through `augmentedPathEnv` (driven with
 * the fake HOME) resolves it — prepended, de-duplicated, dropping no entries.
 *
 * Layers, all against the REAL code:
 *  A. THE HELPER — augmentedPathEnv/userToolDirs (src/server/path-env.mjs).
 *  B. THE WIRING (must-FAIL pre-fix) — session-host.mjs spawns the engine with
 *     `augmentedPathEnv(process.env)`, not bare `process.env`.
 *  C. ISOLATION — a direct host spawn env carries the user bin dir; the
 *     `container` docker-exec argv (execArgv) never injects a host path.
 *
 * Scratch tmp HOME trees only; no real home paths in assertions (leak-gate).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

const cleanup = [];
function scratchHome({ cargo = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bug091-home-'));
  cleanup.push(home);
  const localBin = path.join(home, '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  const stub = path.join(localBin, 'bug091stub');
  fs.writeFileSync(stub, '#!/bin/sh\necho ok\n', { mode: 0o755 });
  if (cargo) fs.mkdirSync(path.join(home, '.cargo', 'bin'), { recursive: true });
  return { home, localBin, stub };
}

/** Resolve a bare command name against an env's PATH the way execvp would. */
function resolveOnPath(env, name) {
  for (const dir of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && (st.mode & 0o111)) return p;
    } catch { /* not here */ }
  }
  return null;
}

const main = async () => {
  const { augmentedPathEnv, userToolDirs } = await import(`${path.join(ROOT, 'src', 'server', 'path-env.mjs')}?a=${Date.now()}`);

  // ============ A. THE HELPER (synthetic, both directions) ============
  console.log('\n=== A. augmentedPathEnv resolves a user-bin tool a minimal PATH cannot ===');
  const { home, localBin, stub } = scratchHome({ cargo: true });

  // Base env with a minimal PATH that EXCLUDES the scratch .local/bin.
  const baseEnv = { PATH: ['/usr/local/bin', '/usr/bin'].join(path.delimiter), FOO: 'bar' };

  check('PRE (unaugmented): the stub is UNRESOLVABLE on the minimal base PATH',
    resolveOnPath(baseEnv, 'bug091stub') === null, baseEnv.PATH);

  const aug = augmentedPathEnv(baseEnv, home);

  check('POST: the stub RESOLVES to the scratch .local/bin after augmentation',
    resolveOnPath(aug, 'bug091stub') === stub, resolveOnPath(aug, 'bug091stub'));
  check('PREPEND: .local/bin is at the FRONT of the augmented PATH',
    aug.PATH.split(path.delimiter)[0] === localBin, aug.PATH);
  check('NO DROP: every base PATH entry is still present after augmentation',
    baseEnv.PATH.split(path.delimiter).every((d) => aug.PATH.split(path.delimiter).includes(d)),
    aug.PATH);
  check('PASSTHROUGH: non-PATH env vars are untouched (and base env is not mutated)',
    aug.FOO === 'bar' && baseEnv.PATH.indexOf(localBin) === -1, { augFoo: aug.FOO, basePath: baseEnv.PATH });
  check('CARGO: ~/.cargo/bin is included when it exists on the scratch tree',
    aug.PATH.split(path.delimiter).includes(path.join(home, '.cargo', 'bin')), aug.PATH);

  // DE-DUPE (of the PREPEND only): a base PATH that already contains the user bin
  // dir once must NOT gain a second, prepended copy — the existing position is
  // left untouched and nothing is added in front of it.
  const onceBase = { PATH: ['/usr/bin', localBin].join(path.delimiter) };
  const onceAug = augmentedPathEnv(onceBase, home);
  check('DE-DUPE: an already-present user bin dir is not prepended again (stays exactly once)',
    onceAug.PATH.split(path.delimiter).filter((d) => d === localBin).length === 1, onceAug.PATH);

  // NO-DROP of a PRE-EXISTING duplicate: if the inherited PATH already had the
  // dir twice, BOTH copies are preserved (we drop no existing entries — BUG-091
  // reopen; the prior `.filter`+dedupe collapsed them).
  const dupBase = { PATH: [localBin, '/usr/bin', localBin].join(path.delimiter) };
  const dupAug = augmentedPathEnv(dupBase, home);
  check('NO-DROP: a pre-existing duplicate user bin dir is preserved (both copies kept)',
    dupAug.PATH.split(path.delimiter).filter((d) => d === localBin).length === 2, dupAug.PATH);

  // No cargo on this tree -> not added (no phantom entry).
  const { home: home2 } = scratchHome({ cargo: false });
  check('CARGO ABSENT: ~/.cargo/bin is NOT added when the dir does not exist',
    !userToolDirs(home2).includes(path.join(home2, '.cargo', 'bin')), userToolDirs(home2));

  // BUG-091 REOPEN — POSIX empty PATH entries (leading/trailing/doubled `:` =
  // "current directory") must SURVIVE. A prior `.filter(Boolean)` dropped them.
  const trailBase = { PATH: '/usr/local/bin:/usr/bin:' }; // trailing `:` => trailing empty
  const trailAug = augmentedPathEnv(trailBase, home).PATH.split(path.delimiter);
  check('EMPTY-ENTRY (trailing): "/usr/local/bin:/usr/bin:" keeps its trailing empty field',
    trailAug[trailAug.length - 1] === '' && trailAug.includes('/usr/local/bin') && trailAug.includes('/usr/bin'),
    trailAug);
  check('EMPTY-ENTRY (trailing): the user bin dir is prepended AND the empty field survives',
    trailAug[0] === localBin && trailAug.filter((d) => d === '').length === 1, trailAug);

  const leadBase = { PATH: ':/usr/bin' }; // leading `:` => leading empty
  const leadAug = augmentedPathEnv(leadBase, home).PATH.split(path.delimiter);
  check('EMPTY-ENTRY (leading): ":/usr/bin" keeps its (now interior) empty field after prepend',
    leadAug.filter((d) => d === '').length === 1 && leadAug.includes('/usr/bin') && leadAug[0] === localBin,
    leadAug);

  // An empty/absent PATH yields NO phantom cwd entry (just the prepended dirs).
  const emptyAug = augmentedPathEnv({ PATH: '' }, home).PATH.split(path.delimiter);
  check('EMPTY PATH: an empty base PATH yields only the prepended user dirs (no phantom "")',
    !emptyAug.includes('') && emptyAug[0] === localBin, emptyAug);

  // ============ B. THE WIRING (must-FAIL pre-fix) ============
  console.log('\n=== B. session-host.mjs spawns the engine through augmentedPathEnv ===');
  const hostSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'session-host.mjs'), 'utf8');
  const spawnLine = hostSrc.split('\n').find((l) => l.includes('spawn(command, args'));
  check('the engine spawn passes env through augmentedPathEnv (NOT bare process.env)',
    !!spawnLine && /env:\s*augmentedPathEnv\(process\.env\)/.test(spawnLine), spawnLine);
  check('session-host.mjs imports the central helper',
    /import\s*\{\s*augmentedPathEnv\s*\}\s*from\s*'\.\/path-env\.mjs'/.test(hostSrc), true);

  // BUG-091 REOPEN — the ROOT fix: the server augments its OWN process.env.PATH
  // once at boot, so EVERY descendant spawn (both runtimes + SDK) inherits it.
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'index.ts'), 'utf8');
  check('index.ts augments the server process PATH at boot (process.env.PATH = augmentedPathEnv(process.env).PATH)',
    /process\.env\.PATH\s*=\s*augmentedPathEnv\(process\.env\)\.PATH/.test(indexSrc), true);
  check('index.ts imports the central helper',
    /import\s*\{\s*augmentedPathEnv\s*\}\s*from\s*'\.\/path-env\.mjs'/.test(indexSrc), true);

  // ============ C. ISOLATION AWARENESS ============
  console.log('\n=== C. host spawn carries user bin; container command does not ===');
  // Direct host spawn env carries the user bin dir.
  check('DIRECT: a host spawn env (augmentedPathEnv) carries the user bin dir',
    augmentedPathEnv(baseEnv, home).PATH.split(path.delimiter).includes(localBin), true);

  // Container: the docker-exec argv must NEVER inject a host path, even if the
  // host env we would hand a direct spawn carries the scratch .local/bin.
  const cm = await import(`${path.join(ROOT, 'src', 'server', 'container-manager.ts')}?a=${Date.now()}`);
  const project = { id: 'proj-bug091', isolation: 'container', settings: { browser: { enabled: false } } };
  const spec = {
    command: '/home/claude/.local/bin/claude',
    args: ['--flag'],
    // Simulate a host env that HAS been augmented with the scratch user bin dir.
    env: augmentedPathEnv(baseEnv, home),
    execId: 'bug091exec',
  };
  const argv = cm.execArgv(project, spec);
  check('CONTAINER: the docker-exec argv injects NO host PATH (no --env PATH=)',
    !argv.some((a) => typeof a === 'string' && a.startsWith('PATH=')), argv);
  check('CONTAINER: the scratch host .local/bin never appears anywhere in the argv',
    !argv.some((a) => typeof a === 'string' && a.includes(localBin)), argv.filter((a) => a.includes(home)));
  check('CONTAINER: HOME is the in-container home, not the host home',
    argv.includes(`HOME=${'/home/claude'}`), argv.filter((a) => a.startsWith('HOME=')));
};

main()
  .catch((e) => { console.error(e); fail++; failures.push(`threw: ${e?.message ?? e}`); })
  .finally(() => {
    for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
    if (failures.length) console.log('  failed:', failures.join(' | '));
    process.exit(fail === 0 ? 0 : 1);
  });
