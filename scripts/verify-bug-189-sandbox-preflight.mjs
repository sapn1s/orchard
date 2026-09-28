#!/usr/bin/env node
/**
 * BUG-189 — verify the zero-token Codex sandbox preflight on the OpenAI dispatch
 * path. Driven entirely through a FAKE codex on the CLAUDE_STATION_CODEX_BIN
 * seam (scripts/fixtures/codex-fake-app-server.mjs, which now also answers
 * `--version` and the `codex sandbox … -- true` probe) — NO real codex, no
 * subscription, no :4317, zero API tokens.
 *
 * The fake's CODEX_FAKE_SANDBOX_BROKEN reproduces the 0.157.x btrfs bwrap
 * failure; CODEX_FAKE_EXEC_MARKER records whether `app-server` (the API path)
 * was ever entered; CODEX_FAKE_SANDBOX_LOG counts sandbox probes.
 *
 * Proves:
 *   (a) a BROKEN sandbox → fast non-zero exit BEFORE any API call — the
 *       app-server exec marker is NEVER written; stderr names [sandbox-preflight],
 *       the codex version, the codex error line, and the BUG-189 / pin pointer.
 *   (a-must-fail) a SYNTHESIZED pre-fix dispatch.mjs (preflight block removed)
 *       DOES reach app-server on the same broken sandbox — the marker IS written.
 *       This is the degradation the fix removes, anchored to a constructed
 *       pre-fix variant (not a moving git baseline; CONVENTIONS §must-FAIL).
 *   (b) a HEALTHY sandbox lets the dispatch proceed — app-server runs, the final
 *       text reaches stdout, exit 0.
 *   (c) `node src/server/dispatch-client.mjs --check` reports the sandbox failure
 *       (unavailable + reason) instead of "available", and reports available +
 *       "sandbox: ok" when healthy.
 *   (d) success is cached per binary+version: a second probe of the same healthy
 *       binary does NOT re-launch the sandbox, and a version change (the
 *       `codex update` recurrence) busts the cache and re-probes.
 *
 * Kill by pid only; scratch dirs removed in finally; nothing global touched.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DISPATCH = path.join(ROOT, 'scripts', 'dispatch.mjs');
const CLIENT = path.join(ROOT, 'src', 'server', 'dispatch-client.mjs');
const FAKE = path.join(ROOT, 'scripts', 'fixtures', 'codex-fake-app-server.mjs');
const SIGTERM_FAKE = path.join(ROOT, 'scripts', 'fixtures', 'codex-fake-sigterm-hang.mjs');
const ORPHAN_FAKE = path.join(ROOT, 'scripts', 'fixtures', 'codex-fake-orphan-launcher.mjs');
const HELPER = path.join(ROOT, 'scripts', 'lib', 'codex-sandbox-preflight.mjs');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

function run(cmd, args, env = {}, cwd = ROOT) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => resolve({ code, out, err }));
    child.on('error', (e) => resolve({ code: -1, out, err: err + String(e) }));
  });
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bug189-'));
const tmpFiles = [];
function tmp(name) { const p = path.join(scratch, name); tmpFiles.push(p); return p; }

let prefixDispatch = null; // synthesized pre-fix dispatch.mjs (written into scripts/)

async function main() {
  const baseEnv = {
    CLAUDE_STATION_CODEX_BIN: FAKE,
    CLAUDE_STATION_DATA: path.join(scratch, 'data'),
    CODEX_FAKE_VERSION: '0.157.1',
  };

  /* ---- (a) broken sandbox → fast fail, no API call ---- */
  {
    const marker = tmp('exec-broken.marker');
    const r = await run(process.execPath,
      [DISPATCH, '--provider', 'openai', '--cwd', scratch, '--sandbox', 'read-only', 'hello'],
      { ...baseEnv, CODEX_FAKE_SANDBOX_BROKEN: '1', CODEX_FAKE_EXEC_MARKER: marker });
    check('(a) broken sandbox exits non-zero', r.code !== 0, `exit=${r.code}`);
    check('(a) no API call — app-server marker never written', !fs.existsSync(marker), `marker exists=${fs.existsSync(marker)}`);
    check('(a) stderr names [sandbox-preflight]', /\[sandbox-preflight\]/.test(r.err), r.err.split('\n').find((l) => l.includes('sandbox-preflight')) || '(none)');
    check('(a) stderr shows codex version', /0\.157\.1/.test(r.err), /codex version:.*/.exec(r.err)?.[0] || '(none)');
    check('(a) stderr shows the codex error line', /cannot establish app-server socket mount isolation/.test(r.err), 'error line present');
    check('(a) stderr points at BUG-189', /BUG-189/.test(r.err), 'pointer present');
    check('(a) stderr warns against codex update / pins a fix', /codex update/.test(r.err) && /0\.158/.test(r.err), 'pin note present');
    check('(a) never mentions a danger-full-access fallback as the remedy', !/fall\s*back to danger-full-access/i.test(r.err) || /do NOT|We do NOT/i.test(r.err), 'no danger-full-access fallback offered');
  }

  /* ---- (a-must-fail) pre-fix dispatch DOES reach app-server on broken sandbox ---- */
  {
    const src = fs.readFileSync(DISPATCH, 'utf8');
    const marker = '  /*\n   * BUG-189 — zero-token sandbox preflight.';
    const anchor = "  const { CodexRuntime } = await import(path.join(ROOT, 'src', 'server', 'runtime', 'codex-runtime.ts'));";
    const mi = src.indexOf(marker), ai = src.indexOf(anchor);
    if (mi < 0 || ai < 0 || ai < mi) {
      check('(a-must-fail) could synthesize pre-fix dispatch', false, `marker@${mi} anchor@${ai}`);
    } else {
      const preSrc = src.slice(0, mi) + src.slice(ai);
      // Sanity: the synthesized variant must have NO preflight left.
      const stripped = !preSrc.includes('preflightCodexSandbox');
      prefixDispatch = path.join(ROOT, 'scripts', `.bug189-prefix-dispatch.${process.pid}.mjs`);
      fs.writeFileSync(prefixDispatch, preSrc);
      const mark = tmp('exec-prefix.marker');
      const r = await run(process.execPath,
        [prefixDispatch, '--provider', 'openai', '--cwd', scratch, '--sandbox', 'read-only', 'hello'],
        { ...baseEnv, CODEX_FAKE_SANDBOX_BROKEN: '1', CODEX_FAKE_EXEC_MARKER: mark });
      check('(a-must-fail) pre-fix variant has no preflight', stripped, `stripped=${stripped}`);
      check('(a-must-fail) pre-fix DOES reach app-server on broken sandbox (marker written)', fs.existsSync(mark),
        `marker exists=${fs.existsSync(mark)} exit=${r.code}`);
    }
  }

  /* ---- (b) healthy sandbox → dispatch proceeds ---- */
  {
    const marker = tmp('exec-healthy.marker');
    const r = await run(process.execPath,
      [DISPATCH, '--provider', 'openai', '--cwd', scratch, '--sandbox', 'read-only', 'hello'],
      { ...baseEnv, CODEX_FAKE_EXEC_MARKER: marker }); // no CODEX_FAKE_SANDBOX_BROKEN
    check('(b) healthy sandbox exits 0', r.code === 0, `exit=${r.code}`);
    check('(b) app-server WAS invoked (marker written)', fs.existsSync(marker), `marker exists=${fs.existsSync(marker)}`);
    check('(b) preflight ok announced on stderr', /codex sandbox preflight ok/.test(r.err), r.err.split('\n').find((l) => l.includes('preflight ok')) || '(none)');
    check('(b) final assistant text reached stdout', r.out.trim().length > 0, JSON.stringify(r.out.trim().slice(0, 60)));
  }
  /* ---- (b2) healthy workspace-write also proceeds ---- */
  {
    const r = await run(process.execPath,
      [DISPATCH, '--provider', 'openai', '--cwd', scratch, '--sandbox', 'workspace-write', 'hello'],
      { ...baseEnv });
    check('(b2) healthy workspace-write exits 0', r.code === 0, `exit=${r.code}`);
    check('(b2) preflight probed workspace-write mode', /--sandbox workspace-write/.test(r.err), 'mode announced');
  }

  /* ---- (c) dispatch-client --check reports sandbox failure / health ---- */
  {
    // Ensure the direct-checkout branch is taken: no socket, no entitlement gates.
    const checkEnv = { ...baseEnv };
    delete checkEnv.ORCHARD_DISPATCH_SOCK;
    const broken = await run(process.execPath, [CLIENT, '--check'],
      { ...checkEnv, ORCHARD_DISPATCH_SOCK: '', CODEX_FAKE_SANDBOX_BROKEN: '1' });
    check('(c) --check exits non-zero on broken sandbox', broken.code !== 0, `exit=${broken.code}`);
    check('(c) --check reports unavailable, not available', /unavailable/.test(broken.out) && !/^openai dispatch: available/m.test(broken.out),
      broken.out.split('\n')[0] || '(none)');
    check('(c) --check reason cites the codex sandbox failure', /sandbox cannot launch|mount isolation/.test(broken.out), 'reason present');

    const healthy = await run(process.execPath, [CLIENT, '--check'], { ...checkEnv, ORCHARD_DISPATCH_SOCK: '' });
    check('(c) --check reports available when healthy', healthy.code === 0 && /^openai dispatch: available/m.test(healthy.out), healthy.out.split('\n')[0] || '(none)');
    check('(c) --check confirms sandbox ok when healthy', /sandbox: ok/.test(healthy.out), healthy.out.split('\n').find((l) => l.startsWith('sandbox:')) || '(none)');
  }

  /* ---- (d) caching avoids repeat probes; version change busts it ---- */
  {
    const { preflightCodexSandbox, _clearPreflightCache } = await import(HELPER);
    _clearPreflightCache();
    const log = tmp('probe.log');
    const env = { ...process.env, CLAUDE_STATION_CODEX_BIN: FAKE, CODEX_FAKE_SANDBOX_LOG: log, CODEX_FAKE_VERSION: '0.158.0-a' };
    const r1 = await preflightCodexSandbox({ sandbox: 'read-only', env });
    const r2 = await preflightCodexSandbox({ sandbox: 'read-only', env });
    const probes1 = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
    check('(d) first probe ok, not cached', r1.ok && r1.cached === false, JSON.stringify({ ok: r1.ok, cached: r1.cached }));
    check('(d) second probe served from cache', r2.ok && r2.cached === true, JSON.stringify({ ok: r2.ok, cached: r2.cached }));
    check('(d) sandbox launched only ONCE across two calls', probes1 === 1, `probes=${probes1}`);

    // The codex-update recurrence: a new version must re-probe (cache miss).
    const env2 = { ...env, CODEX_FAKE_VERSION: '0.999.0-new' };
    const r3 = await preflightCodexSandbox({ sandbox: 'read-only', env: env2 });
    const probes2 = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
    check('(d) version change busts the cache (re-probe)', r3.ok && r3.cached === false && probes2 === 2, `cached=${r3.cached} probes=${probes2}`);
  }

  /* ---- (e) round-3 finding 1: timeout enforced against a SIGTERM-ignoring probe ---- */
  {
    const { preflightCodexSandbox, _clearPreflightCache } = await import(HELPER);
    _clearPreflightCache();
    const env = { ...process.env, CLAUDE_STATION_CODEX_BIN: SIGTERM_FAKE };

    // must-FAIL (pre-fix behaviour, constructed inline): execFile's default
    // SIGTERM timeout cannot reap a SIGTERM-ignoring probe — the callback never
    // fires, so the wait HANGS past the deadline. Anchored to a constructed
    // pre-fix variant, not a moving baseline (CONVENTIONS §must-FAIL).
    const { execFile } = await import('node:child_process');
    const preFix = await new Promise((resolve) => {
      let done = false;
      const child = execFile(process.execPath, [SIGTERM_FAKE, 'sandbox', '-c', 'sandbox_mode=read-only', '--', 'true'],
        { timeout: 400 }, () => { if (!done) { done = true; resolve('resolved'); } });
      setTimeout(() => { if (!done) { done = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } resolve('hung'); } }, 3000);
    });
    check('(e-must-fail) pre-fix execFile(SIGTERM) HANGS past the timeout on a SIGTERM-ignoring probe', preFix === 'hung', preFix);

    // post-fix: the helper SIGKILLs the group and resolves promptly with a
    // timed-out failure (never ok, never hangs).
    const t0 = Date.now();
    const res = await preflightCodexSandbox({ sandbox: 'read-only', env, timeoutMs: 400 });
    const elapsed = Date.now() - t0;
    check('(e) helper resolves (does not hang) on a SIGTERM-ignoring probe', res && typeof res.ok === 'boolean', `elapsed=${elapsed}ms`);
    check('(e) result is a fast timeout failure, not ok', res.ok === false && res.timedOut === true, JSON.stringify({ ok: res.ok, timedOut: res.timedOut }));
    check('(e) resolved well within a bound (SIGKILL enforced)', elapsed < 3000, `elapsed=${elapsed}ms`);
    check('(e) error line names the timeout/wedged sandbox', /did not exit within|SIGKILL/.test(res.errorLine || ''), res.errorLine || '(none)');
  }

  /* ---- (f) round-3 finding 3: --check probes BOTH modes ---- */
  {
    const checkEnv = { ...baseEnv, ORCHARD_DISPATCH_SOCK: '' };
    // workspace-write broken, read-only healthy → --check must report unavailable.
    const wwBroken = await run(process.execPath, [CLIENT, '--check'],
      { ...checkEnv, CODEX_FAKE_SANDBOX_BROKEN_MODE: 'workspace-write' });
    check('(f) --check catches a workspace-write-only sandbox failure', wwBroken.code !== 0 && /unavailable/.test(wwBroken.out) && /workspace-write/.test(wwBroken.out),
      wwBroken.out.split('\n').find((l) => l.startsWith('reason:')) || wwBroken.out.split('\n')[0] || '(none)');
    // healthy → reports both modes ok.
    const healthy = await run(process.execPath, [CLIENT, '--check'], { ...checkEnv });
    check('(f) --check reports both modes ok when healthy', healthy.code === 0 && /read-only \+ workspace-write/.test(healthy.out),
      healthy.out.split('\n').find((l) => l.startsWith('sandbox:')) || '(none)');
  }

  /* ---- (g) round-3 finding 4: probe runs in the dispatch cwd; cache keyed by cwd ---- */
  {
    const { preflightCodexSandbox, _clearPreflightCache } = await import(HELPER);
    _clearPreflightCache();
    const log = tmp('cwd-probe.log');
    const env = { ...process.env, CLAUDE_STATION_CODEX_BIN: FAKE, CODEX_FAKE_SANDBOX_LOG: log, CODEX_FAKE_VERSION: 'cwdtest' };
    const cwdA = fs.mkdtempSync(path.join(scratch, 'cwdA-'));
    const cwdB = fs.mkdtempSync(path.join(scratch, 'cwdB-'));
    const ra = await preflightCodexSandbox({ sandbox: 'read-only', env, cwd: cwdA });
    const rb = await preflightCodexSandbox({ sandbox: 'read-only', env, cwd: cwdB });
    const raAgain = await preflightCodexSandbox({ sandbox: 'read-only', env, cwd: cwdA });
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const realA = fs.realpathSync(cwdA);
    check('(g) probe ran in the requested cwd', lines.some((l) => l.includes(`cwd=${realA}`) || l.includes(`cwd=${cwdA}`)),
      lines.find((l) => l.includes('cwdA')) || lines[0] || '(none)');
    check('(g) result carries the cwd it probed', ra.cwd === cwdA, `ra.cwd=${ra.cwd}`);
    check('(g) different cwd is a cache MISS (probed separately)', rb.cached === false && lines.length === 2, `rb.cached=${rb.cached} probes=${lines.length}`);
    check('(g) same cwd is a cache HIT (not re-probed)', raAgain.cached === true && lines.length === 2, `raAgain.cached=${raAgain.cached} probes=${lines.length}`);
  }

  /* ---- (h) round-4 finding 1: orphan reaped on the SUCCESS path too ---- */
  {
    const { spawn } = await import('node:child_process');
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const settle = async (pid, want) => { for (let i = 0; i < 40; i++) { if (alive(pid) === want) break; await new Promise((r) => setTimeout(r, 50)); } };

    // must-FAIL (pre-fix run(): resolves on launcher exit WITHOUT reaping the
    // group). The forked in-group child is left orphaned but alive.
    const prePid = tmp('orphan-pre.pid');
    await new Promise((resolve) => {
      const c = spawn(process.execPath, [ORPHAN_FAKE, 'sandbox', '-c', 'sandbox_mode=read-only', '--', 'true'],
        { env: { ...process.env, CODEX_FAKE_ORPHAN_PIDFILE: prePid }, stdio: ['ignore', 'ignore', 'ignore'], detached: true });
      c.once('exit', () => resolve()); // NOTE: no killGroup — this is the pre-fix behaviour
    });
    const preChild = Number(fs.readFileSync(prePid, 'utf8').trim());
    await settle(preChild, false); // give it a chance to die if it were going to
    const preAlive = alive(preChild);
    check('(h-must-fail) pre-fix leaves the forked child orphaned but ALIVE on success', preAlive, `childPid=${preChild} alive=${preAlive}`);
    try { process.kill(preChild, 'SIGKILL'); } catch { /* clean up the survivor */ }

    // post-fix: the real helper reaps the group on the success exit path too.
    const { preflightCodexSandbox, _clearPreflightCache } = await import(HELPER);
    _clearPreflightCache();
    const postPid = tmp('orphan-post.pid');
    const env = { ...process.env, CLAUDE_STATION_CODEX_BIN: ORPHAN_FAKE, CODEX_FAKE_ORPHAN_PIDFILE: postPid };
    const res = await preflightCodexSandbox({ sandbox: 'read-only', env });
    const postChild = Number(fs.readFileSync(postPid, 'utf8').trim());
    await settle(postChild, false);
    const postAlive = alive(postChild);
    check('(h) helper still returns ok on a fast success', res.ok === true, JSON.stringify({ ok: res.ok, cached: res.cached }));
    check('(h) NO survivor — the orphan is reaped on the success path', !postAlive, `childPid=${postChild} alive=${postAlive}`);
    if (postAlive) { try { process.kill(postChild, 'SIGKILL'); } catch { /* best effort */ } }
  }

  /* ---- (i) round-4 finding 2: forbidden/unknown modes are REJECTED, not mapped ---- */
  {
    const { preflightCodexSandbox, _clearPreflightCache } = await import(HELPER);
    _clearPreflightCache();
    const log = tmp('forbidden.log');
    const env = { ...process.env, CLAUDE_STATION_CODEX_BIN: FAKE, CODEX_FAKE_SANDBOX_LOG: log };
    for (const bad of ['danger-full-access', 'read-write', 'bogus', '']) {
      const r = await preflightCodexSandbox({ sandbox: bad, env });
      check(`(i) mode ${JSON.stringify(bad)} rejected (not mapped to read-only)`,
        r.ok === false && r.mode === String(bad) && /unsupported sandbox mode/.test(r.errorLine || ''),
        JSON.stringify({ ok: r.ok, mode: r.mode, err: (r.errorLine || '').slice(0, 50) }));
    }
    const probed = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
    check('(i) a forbidden mode never launches a probe', probed === 0, `probes=${probed}`);
  }
}

try {
  await main();
} catch (e) {
  check('suite ran without throwing', false, String(e && e.stack || e));
} finally {
  try { if (prefixDispatch && fs.existsSync(prefixDispatch)) fs.rmSync(prefixDispatch); } catch { /* best effort */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nBUG-189 sandbox preflight: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:', failures.join('; ')); process.exit(1); }
process.exit(0);
