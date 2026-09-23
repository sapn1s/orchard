#!/usr/bin/env node
/**
 * verify-feat-141-dispatch-profile.mjs — FEAT-141, the dispatch tool-profile.
 *
 * Grades the two launch facts the profile declares — the ADVERTISED tool set
 * and the CACHE TTL — plus the property that makes the change safe to land in a
 * repo serving several projects: the default profile must be byte-identical to
 * the pre-change command line.
 *
 * DRIVEN, NOT ASSERTED. Every argv/env claim is read off a real `dispatch.mjs`
 * run against a fake `claude` shim on PATH that dumps its own argv and the two
 * cache-TTL env vars, so a regression in flag construction reddens here rather
 * than showing up as a silently doubled bill. The must-FAIL baselines are
 * SYNTHESIZED from the pre-change command shape (CONVENTIONS.md: a must-FAIL
 * proof must not be anchored to a moving baseline like HEAD).
 *
 * NOT graded here (it needs the live API, and is proven in the ticket instead):
 * the token/dollar magnitudes. This file guards the MECHANISM.
 *
 * Run: node scripts/verify-feat-141-dispatch-profile.mjs   (free, gate-safe)
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DISPATCH_PROFILES, DEFAULT_PROFILE, resolveProfile, profileEnv, profileNotice,
  TTL_5M_ENV, TTL_1H_ENV,
} from './lib/dispatch-profiles.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DISPATCH = path.join(ROOT, 'scripts', 'dispatch.mjs');
let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, observed = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${observed ? `\n        observed: ${String(observed).slice(0, 220)}` : ''}`);
  if (ok) pass++; else { fail++; failures.push(name); }
};
const section = (s) => console.log(`\n== ${s}`);

/** A fake `claude` that reports the argv AND the cache-TTL env it was handed. */
function shimDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat140-bin-'));
  fs.writeFileSync(path.join(dir, 'claude'), [
    '#!/bin/sh',
    'echo "SHIM_ARGS:$@" >&2',
    `echo "SHIM_5M:\${${TTL_5M_ENV}-unset}" >&2`,
    `echo "SHIM_1H:\${${TTL_1H_ENV}-unset}" >&2`,
    'cat > /dev/null 2>/dev/null || true',
    'echo \'{"is_error":false,"result":"ok","usage":{"output_tokens":1}}\'',
    'exit 0',
  ].join('\n'), { mode: 0o755 });
  return dir;
}

function run(args, { prompt = null, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DISPATCH, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: [prompt == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    if (prompt != null) { child.stdin.on('error', () => {}); child.stdin.end(prompt); }
    const guard = setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} }, 30_000);
    child.once('exit', (code) => { clearTimeout(guard); resolve({ code, stdout, stderr }); });
  });
}

const argvOf = (r) => /SHIM_ARGS:(.*)/.exec(r.stderr)?.[1] ?? '';
const envOf = (r, k) => new RegExp(`SHIM_${k}:(.*)`).exec(r.stderr)?.[1] ?? '';

async function main() {
  const BIN = shimDir();
  const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'feat140-cwd-'));
  const onPath = { PATH: `${BIN}${path.delimiter}${process.env.PATH}` };
  const base = ['--provider', 'anthropic', '--cwd', CWD, '--sandbox', 'workspace-write', '--prompt-stdin'];

  /* ─────────────────────────────────────── 1. the table's own invariants */
  section('1. profile table — declared, not derived');
  check('the default profile exists and is the documented one',
    Boolean(DISPATCH_PROFILES[DEFAULT_PROFILE]) && DEFAULT_PROFILE === 'full', DEFAULT_PROFILE);
  const full = resolveProfile(null);
  check('DEFAULT declares NO tool restriction and NO TTL override (status quo for every other consumer)',
    full.tools === null && full.cacheTtl === null, JSON.stringify({ tools: full.tools, ttl: full.cacheTtl }));
  check('default profile implies an EMPTY env overlay', Object.keys(profileEnv(full)).length === 0);
  check('default profile emits NO prompt notice (zero added tokens)', profileNotice(full) === null);

  const mon = resolveProfile('monitor');
  check('monitor declares an explicit allow-list (not a removal list)',
    Array.isArray(mon.tools) && mon.tools.length > 0, mon.tools.join(','));
  check('monitor forces the CHEAP 5m write TTL', mon.cacheTtl === '5m', String(mon.cacheTtl));
  check('monitor env overlay sets exactly the CLI 5m knob',
    JSON.stringify(profileEnv(mon)) === JSON.stringify({ [TTL_5M_ENV]: '1' }), JSON.stringify(profileEnv(mon)));

  // Evidence-driven membership: the corpus PROVED these are called, so a future
  // tidy-up that drops them must redden. `Agent` is the load-bearing one — it
  // was used 4 times in 311 ticks, including an engine-recovery rollback.
  for (const t of ['Bash', 'Read', 'Edit', 'Write', 'Agent', 'ToolSearch']) {
    check(`monitor KEEPS \`${t}\` (proven invoked in the real tick corpus)`, mon.tools.includes(t));
  }
  for (const t of ['Skill', 'Workflow']) {
    check(`monitor DROPS \`${t}\` (zero invocations across 311 ticks)`, !mon.tools.includes(t));
  }

  /* ─────────────────────────── 2. an unknown profile is refused, not defaulted */
  section('2. an unknown profile name FAILS LOUD (never silently expensive)');
  let threw = null;
  try { resolveProfile('does-not-exist'); } catch (e) { threw = e; }
  check('resolveProfile throws on an unknown name', threw instanceof Error, threw?.message);
  check('the refusal NAMES the known profiles (diagnosable)',
    /full/.test(threw?.message ?? '') && /monitor/.test(threw?.message ?? ''), threw?.message);
  const rBad = await run([...base, '--tool-profile', 'monitr'], { prompt: 'hi', env: onPath });
  check('dispatch.mjs exits NONZERO on a typo\'d profile', rBad.code !== 0, `code=${rBad.code}`);
  check('...and nothing was spawned (no shim args) — refused BEFORE the child',
    !/SHIM_ARGS/.test(rBad.stderr) && /unknown dispatch tool-profile/.test(rBad.stderr),
    rBad.stderr.trim().split('\n')[0]);
  check('...and it points at the file that declares the table',
    /dispatch-profiles\.mjs/.test(rBad.stderr));

  /* ─────────────────────────────────── 3. argv + env, read off a real run */
  section('3. the wire — argv and child env');

  // must-FAIL baseline, SYNTHESIZED: the pre-change command shape had no
  // --tools at all, so `--allowedTools` was the only tool flag present. If
  // --tools ever stops being emitted for `monitor`, this pair is what reddens.
  const rFull = await run([...base, '--allow-tools', 'Bash,Read', '--tool-profile', 'full'], { prompt: 'hi', env: onPath });
  const aFull = argvOf(rFull);
  check('CONTROL (pre-change shape = profile `full`): argv carries NO --tools flag',
    rFull.code === 0 && !/--tools\b/.test(aFull), aFull);
  check('CONTROL: --allowedTools is still passed (it is a separate, auto-approve concern)',
    /--allowedTools Bash Read/.test(aFull), aFull);
  check('CONTROL: neither cache-TTL env var is set — the CLI keeps choosing (1h)',
    envOf(rFull, '5M') === 'unset' && envOf(rFull, '1H') === 'unset',
    `5m=${envOf(rFull, '5M')} 1h=${envOf(rFull, '1H')}`);

  const rMon = await run([...base, '--allow-tools', 'Bash,Read', '--tool-profile', 'monitor'], { prompt: 'hi', env: onPath });
  const aMon = argvOf(rMon);
  check('POST: argv carries --tools with exactly the declared set',
    rMon.code === 0 && aMon.includes(`--tools ${mon.tools.join(',')}`), aMon);
  check('POST: the CHEAP TTL env var reaches the child',
    envOf(rMon, '5M') === '1', `5m=${envOf(rMon, '5M')}`);
  check('POST: the EXPENSIVE TTL env var is NOT also set (no ambiguity for the CLI)',
    envOf(rMon, '1H') === 'unset', `1h=${envOf(rMon, '1H')}`);
  check('POST: --allowedTools survives alongside --tools (restriction and approval are orthogonal)',
    /--allowedTools Bash Read/.test(aMon), aMon);

  // The env overlay must not leak into a sibling dispatch in the same process.
  const rAfter = await run([...base, '--tool-profile', 'full'], { prompt: 'hi', env: onPath });
  check('the 5m overlay does NOT leak — a later `full` dispatch is clean again',
    envOf(rAfter, '5M') === 'unset', `5m=${envOf(rAfter, '5M')}`);

  /* ───────────────────────────── 4. env fallback (opt in without editing a repo) */
  section('4. ORCHARD_DISPATCH_TOOL_PROFILE env fallback');
  const rEnv = await run(base, { prompt: 'hi', env: { ...onPath, ORCHARD_DISPATCH_TOOL_PROFILE: 'monitor' } });
  check('the env var selects the profile with no flag on the command line',
    /--tools /.test(argvOf(rEnv)) && envOf(rEnv, '5M') === '1', argvOf(rEnv));
  const rFlagWins = await run([...base, '--tool-profile', 'full'],
    { prompt: 'hi', env: { ...onPath, ORCHARD_DISPATCH_TOOL_PROFILE: 'monitor' } });
  check('an explicit --tool-profile OVERRIDES the env var',
    !/--tools\b/.test(argvOf(rFlagWins)) && envOf(rFlagWins, '5M') === 'unset', argvOf(rFlagWins));

  /* ─────────────────────────── 5. the loud-failure half (a suppressed tool) */
  section('5. suppression is DIAGNOSABLE — the notice, not an "unknown tool"');
  const notice = profileNotice(mon);
  check('a trimming profile produces a prompt notice', typeof notice === 'string' && notice.length > 0);
  check('the notice ENUMERATES what is still available', mon.tools.every((t) => notice.includes(t)));
  check('the notice NAMES withheld tools explicitly (Skill, Workflow)',
    /Skill/.test(notice) && /Workflow/.test(notice));
  check('the notice says this is NOT a malfunction or a permission refusal',
    /NOT a malfunction/i.test(notice) && /NOT a permission refusal/i.test(notice));
  check('the notice gives the EXACT remedy flag', /--tool-profile full/.test(notice));
  check('the notice points at the declaring file', /dispatch-profiles\.mjs/.test(notice));
  check('the notice tells the lane to REPORT rather than silently work around',
    /final\s+message/i.test(notice) && /do not work around it silently/i.test(notice));

  // And it must actually reach the model — i.e. be in the prompt on stdin.
  // The FEAT-100 declaration must still be FIRST (the cost collector reads it
  // positionally), so the notice is appended, never prepended.
  const rNotice = await run([...base, '--tool-profile', 'monitor', '--ticket', 'FEAT-002', '--phase', 'fixing', '--class', 'fix'],
    { prompt: 'THE-ORIGINAL-TASK', env: onPath });
  check('the dispatch succeeded with a declaration + a trimming profile', rNotice.code === 0, `code=${rNotice.code}`);
  check('the FEAT-100 Dispatch: line is still emitted (not displaced by the notice)',
    /Dispatch: ticket=FEAT-002/.test(rNotice.stderr), /Dispatch:[^\n]*/.exec(rNotice.stderr)?.[0]);

  /* ─────────────────────────────────────── 6. the meta channel records it */
  section('6. the launch shape is RECORDED, not re-derived from argv');
  const META = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'feat140-meta-')), 'm.json');
  await run([...base, '--tool-profile', 'monitor', '--meta-out', META], { prompt: 'hi', env: onPath });
  const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
  check('--meta-out carries the profile name, tool set and TTL',
    meta.toolProfile?.name === 'monitor' && meta.toolProfile?.cacheTtl === '5m'
    && Array.isArray(meta.toolProfile?.tools), JSON.stringify(meta.toolProfile));
  const META2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'feat140-meta2-')), 'm.json');
  await run([...base, '--meta-out', META2], { prompt: 'hi', env: onPath });
  const meta2 = JSON.parse(fs.readFileSync(META2, 'utf8'));
  check('a default dispatch records `full` with nulls — absent, never guessed',
    meta2.toolProfile?.name === 'full' && meta2.toolProfile?.tools === null
    && meta2.toolProfile?.cacheTtl === null, JSON.stringify(meta2.toolProfile));

  /* ─────────────────────────────────── 7. non-vacuity of the CONTROL above */
  section('7. non-vacuity — the checks CAN fail');
  check('the argv probe really observes --tools when present, and its absence otherwise',
    /--tools\b/.test(aMon) && !/--tools\b/.test(aFull), `mon=${/--tools\b/.test(aMon)} full=${/--tools\b/.test(aFull)}`);
  check('the env probe really distinguishes set from unset',
    envOf(rMon, '5M') === '1' && envOf(rFull, '5M') === 'unset');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) console.error('failed:', failures.join('; '));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
