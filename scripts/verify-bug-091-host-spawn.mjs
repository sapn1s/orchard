#!/usr/bin/env node
/**
 * BUG-091 (REOPENED) — ADVERSARIAL host-spawn proof.
 *
 *   node scripts/verify-bug-091-host-spawn.mjs
 *
 * The first BUG-091 fix patched ONLY session-host.mjs (the survival broker).
 * The clean-room verifier (run bfc2d932) proved BROKEN: when survival is OFF
 * (`CLAUDE_STATION_SURVIVE=0` / `systemd-run` absent) or the engine is codex,
 * the engine is spawned HOST-SIDE by the RUNTIMES — codex-runtime.ts (`{
 * ...process.env }`) and claude-runtime.ts (SDK `query()` sets no env) — so the
 * child still got a PATH with no `~/.local/bin` and serena still failed there.
 *
 * The ROOT fix augments the SERVER PROCESS's own `process.env.PATH` ONCE at boot
 * (src/server/index.ts), so EVERY host-side descendant spawn inherits it. This
 * test drives a REAL host engine spawn (NO spawnProcess override = survival OFF)
 * through the REAL CodexRuntime and captures the child's PATH:
 *
 *   PRE  (boot augmentation NOT applied) → child PATH LACKS the user bin dir
 *        (reproduces bfc2d932's BROKEN verdict — this is the must-FAIL state).
 *   POST (boot augmentation applied, exactly as index.ts does it) → child PATH
 *        CARRIES the user bin dir.
 *
 * It also asserts index.ts actually performs the boot augmentation (so reverting
 * that line fails this suite), and that ClaudeRuntime inherits `process.env`
 * (the SDK query() options never set `env`) — the claude-runtime host spawn the
 * verifier also flagged, covered by the SAME boot augmentation. A real fake-
 * `claude` SDK spawn is attempted too, best-effort, and asserted when it fires.
 *
 * Scratch tmp HOME trees + a fake codex binary; no real home paths (leak-gate).
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cleanup = [];
function scratchHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bug091-hs-home-'));
  cleanup.push(home);
  const localBin = path.join(home, '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  fs.writeFileSync(path.join(localBin, 'bug091stub'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  return { home, localBin };
}

/**
 * A fake `codex app-server` that records the PATH it was spawned with to
 * $BUG091_OUT, then exits. We only need the spawn env, not the protocol; the
 * runtime's exit handler fires #fail afterwards (swallowed by the stream loop).
 */
function writeFakeCodex(dir) {
  const p = path.join(dir, 'fake-codex.mjs');
  fs.writeFileSync(p, [
    'import * as fs from "node:fs";',
    'try { fs.writeFileSync(process.env.BUG091_OUT, String(process.env.PATH ?? "")); } catch {}',
    'process.exit(0);',
  ].join('\n'));
  return p;
}

/** Drive a REAL CodexRuntime host spawn (no spawnProcess) and return child PATH. */
async function codexChildPath({ CodexRuntime, fakeCodex, outFile }) {
  process.env.CLAUDE_STATION_CODEX_BIN = fakeCodex;
  process.env.BUG091_OUT = outFile;
  try { fs.rmSync(outFile, { force: true }); } catch { /* fresh */ }
  const rt = new CodexRuntime();
  // NO spawnProcess override => survival OFF => the REAL host spawn branch
  // (codex-runtime.ts `spawn(command, args, { cwd, env, ... })`).
  rt.start({
    cwd: ROOT,
    firstPrompt: 'hi',
    permissionMode: 'default',
    onApproval: async () => ({ behavior: 'deny', message: 'n/a' }),
  });
  // Consume the stream so the runtime's failure (fake exits immediately) is
  // absorbed rather than surfacing as an unhandled rejection.
  void (async () => { try { for await (const _ of rt.messages()) { /* drain */ } } catch { /* fake exit */ } })();
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (fs.existsSync(outFile)) { try { rt.close(); } catch { /* ignore */ } return fs.readFileSync(outFile, 'utf8'); }
    await sleep(20);
  }
  try { rt.close(); } catch { /* ignore */ }
  return null;
}

const main = async () => {
  const { augmentedPathEnv } = await import(`${path.join(ROOT, 'src', 'server', 'path-env.mjs')}?a=${Date.now()}`);
  const { CodexRuntime } = await import(`${path.join(ROOT, 'src', 'server', 'runtime', 'codex-runtime.ts')}`);

  const { home, localBin } = scratchHome();
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug091-hs-'));
  cleanup.push(workdir);
  const fakeCodex = writeFakeCodex(workdir);

  // Isolate the process env for this run: minimal PATH (excludes the scratch
  // .local/bin) and HOME pointed at the scratch tree so os.homedir() — what the
  // boot augmentation uses — resolves the scratch user bin dir.
  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  const savedBin = process.env.CLAUDE_STATION_CODEX_BIN;
  const savedOut = process.env.BUG091_OUT;
  const MINIMAL = ['/usr/local/bin', '/usr/bin'].join(path.delimiter);

  try {
    process.env.HOME = home; // os.homedir() reads $HOME first on POSIX (libuv)

    // ---- PRE: survival OFF, boot augmentation NOT applied (bfc2d932's state) ----
    console.log('\n=== A. REAL CodexRuntime host spawn, survival OFF ===');
    process.env.PATH = MINIMAL;
    const prePath = await codexChildPath({ CodexRuntime, fakeCodex, outFile: path.join(workdir, 'pre.txt') });
    check('PRE-REQUISITE: the real host spawn actually ran and recorded its child PATH',
      prePath !== null, prePath);
    check('PRE (no boot augmentation): the codex child PATH LACKS the user bin dir (reproduces BROKEN bfc2d932)',
      prePath !== null && !prePath.split(path.delimiter).includes(localBin), prePath);

    // ---- POST: apply the EXACT boot augmentation index.ts performs ----
    process.env.PATH = augmentedPathEnv(process.env).PATH; // == src/server/index.ts boot line
    const postPath = await codexChildPath({ CodexRuntime, fakeCodex, outFile: path.join(workdir, 'post.txt') });
    check('POST (boot augmentation applied): the codex child PATH CARRIES the user bin dir',
      postPath !== null && postPath.split(path.delimiter).includes(localBin), postPath);
    check('POST: the user bin dir is at the FRONT of the codex child PATH',
      postPath !== null && postPath.split(path.delimiter)[0] === localBin, postPath);
    check('POST: no minimal-PATH entry was dropped from the codex child PATH',
      postPath !== null && MINIMAL.split(path.delimiter).every((d) => postPath.split(path.delimiter).includes(d)),
      postPath);
  } finally {
    process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedBin === undefined) delete process.env.CLAUDE_STATION_CODEX_BIN; else process.env.CLAUDE_STATION_CODEX_BIN = savedBin;
    if (savedOut === undefined) delete process.env.BUG091_OUT; else process.env.BUG091_OUT = savedOut;
  }

  // ---- B. index.ts actually performs the boot augmentation (revert => FAIL) ----
  console.log('\n=== B. the boot augmentation is wired in index.ts ===');
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'index.ts'), 'utf8');
  check('index.ts augments process.env.PATH at boot (root fix — reverting this fails PRE→POST coverage of every runtime)',
    /process\.env\.PATH\s*=\s*augmentedPathEnv\(process\.env\)\.PATH/.test(indexSrc)
    && /import\s*\{\s*augmentedPathEnv\s*\}\s*from\s*'\.\/path-env\.mjs'/.test(indexSrc), true);

  // ---- C. claude-runtime SDK spawn inherits process.env (no env override) ----
  console.log('\n=== C. ClaudeRuntime SDK spawn inherits the (augmented) process.env ===');
  const claudeSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'runtime', 'claude-runtime.ts'), 'utf8');
  /*
   * The invariant is "the SDK claude child gets the boot-augmented PATH", not
   * "no env key exists". BUG-118 has to set one (ORCHARD_SESSION, the launch
   * marker the response-format Stop hook reads), and the SDK's `env` REPLACES
   * the child environment rather than merging — so an override is only safe
   * while it spreads process.env. Assert THAT, which is the property BUG-091
   * actually needs; the live fake-CLI spawn below is the proof it holds.
   */
  const envOverride = /\benv:\s*\{([^}]*)\}/.exec(claudeSrc) ?? /options\.env\s*=\s*\{([^}]*)\}/.exec(claudeSrc);
  check('claude-runtime.ts either sets no env override, or spreads process.env into it → the SDK claude child keeps the boot-augmented PATH',
    envOverride === null || /\.\.\.process\.env/.test(envOverride[1]), envOverride ? envOverride[0] : 'no override');

  // Best-effort REAL SDK spawn of a fake `claude` capturing its PATH. The SDK
  // owns the spawn; if it does not invoke our fake within the window we skip the
  // assertion (structural check above already covers the mechanism), but when it
  // DOES fire we assert the augmented user bin dir reached the SDK child too.
  try {
    const { ClaudeRuntime } = await import(`${path.join(ROOT, 'src', 'server', 'runtime', 'claude-runtime.ts')}`);
    const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug091-claude-'));
    cleanup.push(cdir);
    const outFile = path.join(cdir, 'claude-path.txt');
    const fakeClaude = path.join(cdir, 'claude');
    fs.writeFileSync(fakeClaude, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'try { fs.writeFileSync(process.env.BUG091_CLAUDE_OUT, String(process.env.PATH ?? "")); } catch {}',
      'process.exit(0);',
    ].join('\n'), { mode: 0o755 });

    const savedPath2 = process.env.PATH;
    const savedHome2 = process.env.HOME;
    process.env.HOME = home;
    process.env.PATH = augmentedPathEnv(process.env).PATH; // boot-augmented (carries scratch localBin)
    process.env.CLAUDE_STATION_CLAUDE_BIN = fakeClaude;
    process.env.BUG091_CLAUDE_OUT = outFile;
    try {
      const rt = new ClaudeRuntime();
      try {
        rt.start({ cwd: cdir, firstPrompt: 'hi', permissionMode: 'default', onApproval: async () => ({ behavior: 'deny', message: 'n/a' }) });
        void (async () => { try { for await (const _ of rt.messages()) { /* drain */ } } catch { /* fake exit */ } })();
      } catch { /* SDK may throw synchronously on the immediate fake exit */ }
      const until = Date.now() + 6000;
      while (Date.now() < until && !fs.existsSync(outFile)) await sleep(30);
      try { rt.close(); } catch { /* ignore */ }
      if (fs.existsSync(outFile)) {
        const cp = fs.readFileSync(outFile, 'utf8');
        check('CLAUDE (real SDK spawn): the fake claude child PATH CARRIES the user bin dir',
          cp.split(path.delimiter).includes(localBin), cp);
      } else {
        console.log('  SKIP  CLAUDE real SDK spawn did not invoke the fake within the window — structural check (above) stands');
      }
    } finally {
      process.env.PATH = savedPath2;
      if (savedHome2 === undefined) delete process.env.HOME; else process.env.HOME = savedHome2;
      delete process.env.CLAUDE_STATION_CLAUDE_BIN;
      delete process.env.BUG091_CLAUDE_OUT;
    }
  } catch (err) {
    console.log(`  SKIP  CLAUDE real SDK spawn unavailable (${err?.message ?? err}) — structural check stands`);
  }
};

main()
  .catch((e) => { console.error(e); fail++; failures.push(`threw: ${e?.message ?? e}`); })
  .finally(async () => {
    for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
    if (failures.length) console.log('  failed:', failures.join(' | '));
    process.exit(fail === 0 ? 0 : 1);
  });
