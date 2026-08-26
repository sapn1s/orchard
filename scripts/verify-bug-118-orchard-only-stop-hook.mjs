#!/usr/bin/env node
/**
 * BUG-118 — the response-format Stop hook must be inert outside Orchard.
 *
 *   node scripts/verify-bug-118-orchard-only-stop-hook.mjs
 *
 * The bug: onboard installs the hook into the TARGET project's own
 * `.claude/settings.json`, so Claude Code runs it for every session rooted
 * there — including a bare `claude` the user starts by hand for unrelated work.
 * The hook had no way to tell the two apart, so it advised both.
 *
 * ROUND 1 stamped `ORCHARD_SESSION=1` — a PRESENCE flag — and an independent
 * cross-provider verification broke it: a plain `claude` started from a terminal
 * INSIDE an Orchard session inherits its parent's environment, satisfies the
 * flag, and gets advised. The user's complaint, intact.
 *
 * ROUND 2: the marker carries the SESSION ID Orchard declared
 * for that CLI (`--session-id <uuid>` on a fresh launch/fork; the resumed id
 * otherwise), and the hook speaks only when it EQUALS the `session_id` in its
 * own Stop payload. A value is inherited; an identity is not — the nested
 * session has its own new id and can never match.
 *
 * ROUND 3 (this contract): the launch-claim side door is GONE. Round 2 also
 * accepted a `{declared, observed, ts}` record from `launch-claims.json` in the
 * data dir. A second independent pass wrote one dated a YEAR AHEAD — the age
 * test had no lower bound — aimed it at a foreign session id, and the hook
 * advised a stranger: the round-1 escape, re-opened by the fallback meant to
 * make the fix safer. That file is writable by every process running as this
 * user, so it was an unauthenticated "vouch for session X" request and no
 * validation inside the hook could fix it. Equality with the env marker is now
 * the ONLY path. Drift is reported by the launcher, never repaired.
 *
 * WHAT THIS SUITE PROVES, in the order that matters:
 *   A  MUST-FAIL, every earlier round, on the SAME inputs the fixed hook is
 *      silent on:
 *        A1 round-0 (no gate at all)  — advises a hand-started session.
 *        A2 round-1 (presence flag)   — advises a NESTED hand-started session
 *           that inherited the marker.
 *        A3 round-2 (claim fallback)  — advises a FOREIGN session on a
 *           future-dated forged claim. This is the defect being fixed.
 *        A4 round-2 again, with an HONEST current timestamp — so the record
 *           shows why the fix is removal and not a two-sided clock bound.
 *      Every specimen states whether it came from git or had to be
 *      RECONSTRUCTED, and a reconstructed control is tagged DEGRADED.
 *   B  The fixed hook fires for the session the marker NAMES, and is silent for
 *      every other shape: a nested id, the legacy `1`, a payload with no
 *      session_id, and every falsey/absent marker (fail closed toward silence).
 *      B8 sweeps the claims file it no longer reads — well-formed, forged,
 *      malformed, empty, wrong-shape, unreadable, a directory, and rewritten
 *      concurrently — all silent, none wedging.
 *   E  IDENTITY DRIFT through the real runtime: a real child CLI that renames
 *      its session is REPORTED once with both ids, nothing is written to repair
 *      it, and the session goes quietly ungraded.
 *   C  SPAWN SIDE, driven through the REAL ClaudeRuntime:
 *        C1 fresh launch — a real fake-`claude` child records a marker that is a
 *           uuid AND receives `--session-id <that uuid>` on its argv (the
 *           declaration really reaches the CLI); PATH intact (BUG-091).
 *        C2 resume — the marker is the RESUMED id, so the hook's equality test
 *           matches the session Claude Code reports.
 *        C3 fork — a fork gets a NEW declared id, named on the CLI's argv.
 *        C4 override paths — a `spawnProcess` override (what SURVIVAL and the
 *           CONTAINER use) is handed an env carrying the marker.
 *        C5 container — the real `execArgv()` forwards it across `docker exec`.
 *        C6 survivor — survival.ts spreads the SDK's env into its scope env.
 *   D  DELIVERY BY ONBOARDING — an ORDINARY re-run re-syncs a stale hook (round
 *      4; it used to need `--force-hook`, a flag nobody knew to run), is a no-op
 *      when the copy is current, and overwrites NOTHING else (a target's own
 *      scripts/gate.mjs survives).
 *   F  DELIVERY AT LAUNCH — the round-4 fix for the defect a cross-provider pass
 *      found: a project still holding the round-1 hook was left untouched by
 *      ordinary onboarding, so every genuine launched session there was silently
 *      ungraded. The launcher now compares the installed copy against this repo
 *      on every start and repairs it, or SAYS SO when it cannot; a never-onboarded
 *      project is left alone; an installed-but-unwired hook is announced too.
 *      F10/F11 drive it through a REAL ClaudeRuntime.start().
 *   G  NO SILENT SILENCE — a turn the hook declines to grade leaves an `ungraded`
 *      record (both ids, the reason) in the advisory log, while staying exactly
 *      as silent toward the running session as before. G7/G8 drive the ROUND-3
 *      REDUCTION CLAIM: the four scenarios it asserted were equivalent are run
 *      as payload shapes and shown to land on the same observable.
 *
 * The LIVE end-to-end observations (real service restart + survivor drain, real
 * resume, real container, real nested `claude`) are recorded in the ticket —
 * they need systemd, docker and API calls, so they are not run from here.
 *
 * Transcripts here are SYNTHETIC but realistic-shaped (split thinking/text lines
 * sharing one message id, a sidechain line, trailing tool events) — the live
 * payload shape was captured from a real hand-started `claude` session first and
 * is reproduced verbatim in `barePayload()`.
 *
 * Scratch under a scratch root, never /tmp-only assumptions about cleanup; no
 * server, no port, no real session, no API call.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'response-format-gate.mjs');
/*
 * Scratch root: a persistent path with no dotted component when the caller
 * supplies one (ORCHARD_SCRATCH), else the OS temp dir like the sibling suites.
 */
const SCRATCH_ROOT = process.env.ORCHARD_SCRATCH && process.env.ORCHARD_SCRATCH.trim() ? path.resolve(process.env.ORCHARD_SCRATCH) : os.tmpdir();
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const SCRATCH = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'bug118-'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (observed !== undefined) console.log(`        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/**
 * A realistic transcript: sidechain noise, then ONE logical assistant message
 * persisted as two JSONL lines sharing a message id (thinking line + text
 * line), then a trailing tool-result event — the shape the hook's
 * lastAssistantText() was hardened for.
 */
function transcript(name, text) {
  const file = path.join(SCRATCH, `${name}.jsonl`);
  const id = 'msg_realistic_01';
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'why is the sky blue?' }] } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { id: 'msg_side', role: 'assistant', content: [{ type: 'text', text: 'subagent chatter, no digest' }] } }),
    JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'thinking', thinking: 'considering' }] } }),
    JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }] } }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/**
 * The Stop payload shape CAPTURED LIVE from a hand-started `claude` in an
 * onboarded project (2026-08-19). Reproduced field-for-field to show what the
 * hook does and does not get to see: there is nothing here about who launched
 * the session, which is why the signal has to come from the environment.
 */
/** A hand-started session's own id — the one in the captured payload below. */
const BARE_SESSION_ID = 'c8e843c1-fd74-4225-a06a-00ab7a0dbe83';
/**
 * The id an Orchard launch DECLARES (real shape: a uuid it passes as
 * `--session-id`). Deliberately different from BARE_SESSION_ID: that difference
 * is the whole gate.
 */
const ORCHARD_DECLARED_ID = '39aa00c8-1aee-43d0-bcbf-aa8fdd363c2d';

function barePayload(transcriptPath) {
  return {
    session_id: BARE_SESSION_ID,
    transcript_path: transcriptPath,
    cwd: path.join(SCRATCH, 'someone-elses-project'),
    prompt_id: '0b0f1d8a-8716-4ce8-8fe4-d5a1718c9b49',
    permission_mode: 'default',
    effort: { level: 'medium' },
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Sunlight contains all colors, but the atmosphere scatters the short wavelengths hardest.',
    background_tasks: [],
    session_crons: [],
  };
}

/** The kind of ordinary reply a user gets in unrelated work: no digest, prose. */
const UNRELATED_REPLY =
  'Sunlight contains all colors, but as it passes through the atmosphere it collides with air ' +
  'molecules that scatter shorter wavelengths far more strongly than longer ones. Blue light gets ' +
  'scattered across the sky much more than red, so when you look up you see scattered blue light ' +
  'coming from every direction. At sunset the light travels through more atmosphere, scattering ' +
  'the blue away and leaving the reds.';

const COMPLIANT_REPLY =
  '```orchard-digest\n{"items":[{"text":"Gated the hook on launch provenance","kind":"done","importance":"high"}]}\n```\n' +
  'Short prose. Nothing else to say.';

/** Run a hook file with a payload and an env overlay. */
function runHook(hookPath, payload, env = {}) {
  const base = { ...process.env, CLAUDE_STATION_DATA: path.join(SCRATCH, 'data') };
  delete base.ORCHARD_SESSION;
  delete base.ORCHARD_STOP_HOOK_DISABLED;
  delete base.ORCHARD_STOP_HOOK_ENFORCE;
  const r = spawnSync('node', [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...base, ...env },
    timeout: 20000,
  });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}
const isSilent = (res) => res.code === 0 && res.stdout === '' && res.stderr === '';
const advised = (res) => res.code === 0 && res.stdout.includes('systemMessage') && res.stdout.includes('advisory');

/* ── A. MUST-FAIL: the pre-fix hook on the very same input ─────────────────── */

/**
 * HISTORICAL SPECIMENS, and the honesty problem they carry.
 *
 * A must-FAIL control is only evidence if it is the REAL earlier file. This
 * suite prefers `git show <sha>:…`, but a clean room (scripts/independent-verify
 * copies the tree WITHOUT `.git`) has no history, and round 2 silently fell back
 * to a RECONSTRUCTION — a control that quietly becomes a re-creation of what the
 * author believes the old code did. That is much weaker evidence than it looks,
 * and it looked identical in the output.
 *
 * So every specimen is registered here, each reconstruction is announced at the
 * point of use, the affected check names are tagged DEGRADED, and the final
 * summary states how many controls were genuine and how many were rebuilt.
 */
const specimens = [];

function historicalHook(name, sha, { describe, verify, reconstruct }) {
  const out = mirrorFor(`mirror-${name}`);
  let src = null;
  let reconstructed = false;
  let source = `git ${sha} (${describe})`;
  try {
    src = execFileSync('git', ['show', `${sha}:scripts/hooks/response-format-gate.mjs`], { cwd: ROOT, encoding: 'utf8' });
    if (!verify(src)) { src = null; source = `git ${sha} is NOT the expected shape (${describe})`; }
  } catch (e) {
    src = null;
    source = `git unavailable — ${String(e?.message ?? e).split('\n')[0]}`;
  }
  if (!src) {
    reconstructed = true;
    src = reconstruct(fs.readFileSync(HOOK, 'utf8'));
    source += ' — RECONSTRUCTED from the current hook';
  }
  const valid = verify(src);
  fs.writeFileSync(out, src);
  const rec = { name, sha, source, reconstructed, valid, path: out };
  specimens.push(rec);
  console.log(`  (specimen ${name}: ${reconstructed ? '*** RECONSTRUCTED — DEGRADED CONTROL ***' : 'GENUINE, from git history'} — ${source}${valid ? '' : '; SHAPE CHECK FAILED'})`);
  return rec;
}

/** A must-FAIL check whose name carries the specimen's provenance. */
function mustFail(name, ok, spec, observed) {
  const tag = spec.reconstructed ? ' [DEGRADED: reconstructed specimen, not the historical file]' : '';
  check(name + tag, ok && spec.valid, observed);
}

/** A mirror tree at the hook's own depth, so `../lib` / `../../public` resolve. */
function mirrorFor(name) {
  const mirror = path.join(SCRATCH, name, 'scripts', 'hooks');
  fs.mkdirSync(mirror, { recursive: true });
  try { fs.symlinkSync(path.join(ROOT, 'scripts', 'lib'), path.join(SCRATCH, name, 'scripts', 'lib')); } catch { /* exists */ }
  try { fs.symlinkSync(path.join(ROOT, 'public'), path.join(SCRATCH, name, 'public')); } catch { /* exists */ }
  return path.join(mirror, 'response-format-gate.mjs');
}

/**
 * FEAT-106 — a mirror in the CONSOLIDATED `.orchard/` layout: the hook lives at
 * `<name>/hooks/` and EVERY grading dependency is folded into ONE flat
 * `<name>/lib/` (as `.orchard/lib/` will be), with NO `public/` anywhere. So the
 * hook's `../../public/lib` candidate cannot resolve and the `../lib` candidate
 * must. `opts.closure:false` omits the two grading files (digest/response-blocks)
 * while keeping the STATIC deps present, so the hook still LOADS but its dynamic
 * candidate loop genuinely fails — the non-vacuity case.
 */
function flatMirrorFor(name, { closure = true } = {}) {
  const base = path.join(SCRATCH, name);
  const hooks = path.join(base, 'hooks');
  const lib = path.join(base, 'lib');
  fs.mkdirSync(hooks, { recursive: true });
  fs.mkdirSync(lib, { recursive: true });
  // Statically-imported deps (the hook fails to LOAD without these).
  const staticLib = [['scripts', 'lib', 'readability.mjs'], ['scripts', 'lib', 'structure.mjs'], ['scripts', 'lib', 'format-metrics.mjs']];
  // The dynamically-imported grading closure (the candidate loop's target).
  const closureLib = [['public', 'lib', 'digest.js'], ['public', 'lib', 'dom.js'], ['public', 'lib', 'route.js'], ['public', 'lib', 'response-blocks.js']];
  for (const rel of [...staticLib, ...(closure ? closureLib : [])]) {
    const dest = path.join(lib, rel[rel.length - 1]);
    try { fs.symlinkSync(path.join(ROOT, ...rel), dest); } catch { /* exists */ }
  }
  return path.join(hooks, 'response-format-gate.mjs');
}

/**
 * Cut the CURRENT identity guard out of main(), whatever shape it has now.
 * Round 4 turned the one-line `if (!launchedByOrchard(payload)) return allow();`
 * into a block that also records the reason, and the old one-line regexes went
 * on "succeeding" by matching nothing — a reconstruction that silently keeps the
 * gate it is supposed to remove is a must-FAIL control that cannot fail. So the
 * cut is anchored on the statement and its block, and it THROWS when it cannot
 * find it rather than returning the source unchanged.
 */
function stripIdentityGuard(cur) {
  const start = cur.indexOf('  const attributed = attribution(payload);');
  if (start === -1) throw new Error('reconstruction: the identity guard is not where this suite expects it');
  const end = cur.indexOf('\n  }\n', start);
  if (end === -1) throw new Error('reconstruction: the identity guard block does not close as expected');
  return cur.slice(0, start) + cur.slice(end + '\n  }\n'.length);
}

/** ROUND 0 — the hook before BUG-118 existed: no launcher gate at all. */
const preFixHook = () => historicalHook('round0', '608064f', {
  describe: 'the commit before BUG-118 — no gate at all',
  // No launcher gate in main() at all — true of the real 608064f (which never
  // mentions ORCHARD_SESSION) and of a faithful reconstruction alike.
  verify: (src) => !/const attributed = attribution\(payload\);/.test(src)
    && !/if \(!launchedByOrchard\(payload\)\)/.test(src)
    && !/if \(!process\.env\[ORCHARD_SESSION_ENV\]\?\.trim\(\)\)/.test(src),
  reconstruct: (cur) => stripIdentityGuard(cur)
    .replace(/\n\s*if \(!process\.env\[ORCHARD_SESSION_ENV\]\?\.trim\(\)\) return allow\(\);\n/, '\n'),
});

/**
 * ROUND 1 — the presence-flag hook (commit 5a23f86), the one the first
 * independent clean-room pass broke: a flag is inherited by every descendant.
 */
const roundOneHook = () => historicalHook('round1', '5a23f86', {
  describe: 'the presence-flag round',
  verify: (src) => /isTruthyEnv\(process\.env\[ORCHARD_SESSION_ENV\]\)/.test(src)
    && !/const attributed = attribution\(payload\);/.test(src),
  reconstruct: (cur) => stripIdentityGuard(cur)
    .replace(/if \(!process\.env\[ORCHARD_SESSION_ENV\]\?\.trim\(\)\) return allow\(\);/,
      'if (!isTruthyEnv(process.env[ORCHARD_SESSION_ENV])) return allow();'),
});

/**
 * ROUND 2 — identity PLUS the launch-claim side door (commit e7ba00d), which the
 * SECOND independent clean-room pass broke: the claim's age test had no lower
 * bound, so a claim dated in the future stayed valid, and any process able to
 * write the data dir could hand the hook a foreign session id to vouch for.
 */
const roundTwoHook = () => historicalHook('round2', 'e7ba00d', {
  describe: 'identity + the launch-claim fallback',
  verify: (src) => /function launchClaims\(/.test(src) && /CLAIM_MAX_AGE_MS/.test(src)
    && /if \(!launchedByOrchard\(payload\)\) return allow\(\);/.test(src),
  reconstruct: (cur) => {
    const stripped = stripIdentityGuard(cur)
      .replace(/^async function main\(\) \{/m, 'async function main() {')
      .replace(/(\n  \/\/ Loop safety)/, '\n  if (!launchedByOrchard(payload)) return allow();\n$1');
    if (!/if \(!launchedByOrchard\(payload\)\) return allow\(\);/.test(stripped)) {
      throw new Error('reconstruction: could not re-insert the round-2 guard into main()');
    }
    return stripped.replace(/^function attribution/m,
      "const CLAIM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;\n"
      + "function launchClaims() {\n"
      + "  try {\n"
      + "    const j = JSON.parse(fs.readFileSync(path.join(dataDir(), 'launch-claims.json'), 'utf8'));\n"
      + "    return Array.isArray(j?.claims) ? j.claims : [];\n"
      + "  } catch { return []; }\n"
      + "}\n"
      + "function launchedByOrchard(payload) {\n"
      + "  const a = attribution(payload);\n"
      + "  if (a.verdict === 'ours') return true;\n"
      + "  if (!a.declared || !a.observed) return false;\n"
      + "  const now = Date.now();\n"
      + "  return launchClaims().some((c) => (\n"
      + "    c && c.declared === a.declared && c.observed === a.observed\n"
      + "    && typeof c.ts === 'number' && now - c.ts <= CLAIM_MAX_AGE_MS\n"
      + "  ));\n"
      + "}\n"
      + 'function attribution');
  },
});

/* ── C. spawn-side helpers ────────────────────────────────────────────────── */

/**
 * A fake `claude` binary that records its own environment AND ARGV, then exits.
 * The argv is what proves the declaration reaches the CLI: round 2 needs
 * `--session-id <declared>` to actually be passed, not just believed.
 */
function writeFakeClaude(dir, outFile) {
  const p = path.join(dir, 'claude');
  fs.writeFileSync(p, [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'try { fs.writeFileSync(process.env.BUG118_OUT, JSON.stringify({ ORCHARD_SESSION: process.env.ORCHARD_SESSION ?? null, PATH: process.env.PATH ?? null, argv: process.argv.slice(2) })); } catch {}',
    'process.exit(0);',
  ].join('\n'), { mode: 0o755 });
  void outFile;
  return p;
}

/**
 * The session id the CLI was actually given on its argv, or null. The SDK emits
 * the `--session-id=<uuid>` form (checked in sdk.mjs); the separated form is
 * accepted too so a future SDK change cannot silently turn this check green.
 */
function argvSessionId(rec) {
  const a = Array.isArray(rec?.argv) ? rec.argv : [];
  const eq = a.find((s) => typeof s === 'string' && s.startsWith('--session-id='));
  if (eq) return eq.slice('--session-id='.length);
  const i = a.indexOf('--session-id');
  return i >= 0 && typeof a[i + 1] === 'string' ? a[i + 1] : null;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Drive a REAL ClaudeRuntime spawn of the fake CLI; return its recorded env. */
async function realChildEnv(ClaudeRuntime, { resume, forkSession } = {}) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'spawn-'));
  const outFile = path.join(dir, 'env.json');
  const fake = writeFakeClaude(dir, outFile);
  const saved = { bin: process.env.CLAUDE_STATION_CLAUDE_BIN, out: process.env.BUG118_OUT };
  process.env.CLAUDE_STATION_CLAUDE_BIN = fake;
  process.env.BUG118_OUT = outFile;
  try {
    const rt = new ClaudeRuntime();
    try {
      rt.start({
        cwd: dir,
        firstPrompt: 'hi',
        permissionMode: 'default',
        onApproval: async () => ({ behavior: 'deny', message: 'n/a' }),
        ...(resume ? { resume } : {}),
        ...(forkSession ? { forkSession: true } : {}),
      });
      void (async () => { try { for await (const _ of rt.messages()) { /* drain */ } } catch { /* fake exits */ } })();
    } catch { /* SDK may throw synchronously on the immediate fake exit */ }
    const until = Date.now() + 8000;
    while (Date.now() < until && !fs.existsSync(outFile)) await sleep(30);
    try { rt.close(); } catch { /* ignore */ }
    if (!fs.existsSync(outFile)) return null;
    try { return JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { return null; }
  } finally {
    if (saved.bin === undefined) delete process.env.CLAUDE_STATION_CLAUDE_BIN; else process.env.CLAUDE_STATION_CLAUDE_BIN = saved.bin;
    if (saved.out === undefined) delete process.env.BUG118_OUT; else process.env.BUG118_OUT = saved.out;
  }
}

/** Drive a REAL ClaudeRuntime with a spawnProcess override, capturing its env. */
async function overrideSpawnEnv(ClaudeRuntime) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'override-'));
  let captured = null;
  const rt = new ClaudeRuntime();
  try {
    rt.start({
      cwd: dir,
      firstPrompt: 'hi',
      permissionMode: 'default',
      onApproval: async () => ({ behavior: 'deny', message: 'n/a' }),
      spawnProcess: (o) => {
        captured = o.env;
        // Return a real, immediately-exiting child that satisfies the SDK's
        // SpawnedProcess shape, so nothing here pretends to be a process.
        return spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['pipe', 'pipe', 'pipe'] });
      },
    });
    void (async () => { try { for await (const _ of rt.messages()) { /* drain */ } } catch { /* immediate exit */ } })();
  } catch { /* immediate exit */ }
  const until = Date.now() + 8000;
  while (Date.now() < until && captured === null) await sleep(30);
  try { rt.close(); } catch { /* ignore */ }
  return captured;
}

/* ── main ─────────────────────────────────────────────────────────────────── */

const main = async () => {
  const tpBad = transcript('unrelated', UNRELATED_REPLY);
  const tpGood = transcript('compliant', COMPLIANT_REPLY);

  console.log('\n=== A. MUST-FAIL: the same inputs, through each earlier round ===');
  const pre = preFixHook();
  const preRes = runHook(pre.path, barePayload(tpBad));
  mustFail('A1 ROUND-0 hook ADVISES a hand-started session in an onboarded project (the original report)',
    advised(preRes), pre, preRes.stdout.slice(0, 120));
  const postRes = runHook(HOOK, barePayload(tpBad));
  check('A1 FIXED hook is SILENT on the identical payload (no stdout, no stderr, exit 0)',
    isSilent(postRes), { code: postRes.code, stdout: postRes.stdout, stderr: postRes.stderr });

  const r1 = roundOneHook();
  /*
   * THE ROUND-2 DEFECT, exactly as the clean-room verifier found it: the user
   * opens a terminal inside an Orchard session and runs `claude`. The child
   * INHERITS the marker; its session is its own.
   */
  const nestedRes = runHook(r1.path, barePayload(tpBad), { ORCHARD_SESSION: '1' });
  mustFail('A2 ROUND-1 hook ADVISES a NESTED hand-started session that inherited the marker (the round-1 defect)',
    advised(nestedRes), r1, nestedRes.stdout.slice(0, 120));
  const nestedFixed = runHook(HOOK, barePayload(tpBad), { ORCHARD_SESSION: ORCHARD_DECLARED_ID });
  check('A2 FIXED hook is SILENT for that nested session (its id is not the declared one)',
    isSilent(nestedFixed), { code: nestedFixed.code, stdout: nestedFixed.stdout, stderr: nestedFixed.stderr });
  // And the round-1 hook would have advised the same nested payload with the
  // round-2 value too, had it understood it — the marker's PRESENCE was all it
  // ever tested. Shown by handing round-1 a truthy value it accepts.
  const nestedRes2 = runHook(r1.path, barePayload(tpBad), { ORCHARD_SESSION: 'yes' });
  mustFail('A2 ROUND-1 gate was pure presence: any truthy value advises any session',
    advised(nestedRes2), r1, nestedRes2.stdout.slice(0, 90));

  /*
   * A3 — THE ROUND-2 DEFECT (this round's fix), reproduced from the clean room's
   * own probe. Round 2 keyed on identity, but ALSO honoured a "launch claim"
   * from a file in the data dir. The age test had no LOWER bound, so a claim
   * timestamped in the future was valid for a year past its forged time. Write
   * one naming a foreign session, present that session's payload with only an
   * INHERITED marker, and the hook advises a stranger — the round-1 escape,
   * re-opened by the fallback that was supposed to make the fix safer.
   */
  const r2 = roundTwoHook();
  const claimDir = path.join(SCRATCH, 'forged-claim-data');
  fs.mkdirSync(claimDir, { recursive: true });
  const writeClaims = (obj) => fs.writeFileSync(path.join(claimDir, 'launch-claims.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
  const forgedEnv = { ORCHARD_SESSION: ORCHARD_DECLARED_ID, CLAUDE_STATION_DATA: claimDir };

  writeClaims({ claims: [{ declared: ORCHARD_DECLARED_ID, observed: BARE_SESSION_ID, ts: Date.now() + 365 * 24 * 3600 * 1000 }] });
  const forgedR2 = runHook(r2.path, barePayload(tpBad), forgedEnv);
  mustFail('A3 ROUND-2 hook ADVISES a foreign session on a FUTURE-DATED forged claim (the defect being fixed)',
    advised(forgedR2), r2, forgedR2.stdout.slice(0, 120));
  const forgedFixed = runHook(HOOK, barePayload(tpBad), forgedEnv);
  check('A3 FIXED hook is SILENT on the identical forged input',
    isSilent(forgedFixed), { code: forgedFixed.code, stdout: forgedFixed.stdout, stderr: forgedFixed.stderr });

  /*
   * A4 — why the fix is REMOVAL and not a two-sided timestamp bound. A bound
   * rejects the forgery above; it cannot reject an HONEST timestamp. Any process
   * running as this user can write `ts: Date.now()`, and round 2 then advises
   * the same stranger. The class, not the instance.
   */
  writeClaims({ claims: [{ declared: ORCHARD_DECLARED_ID, observed: BARE_SESSION_ID, ts: Date.now() }] });
  const honestR2 = runHook(r2.path, barePayload(tpBad), forgedEnv);
  mustFail('A4 ROUND-2 hook ADVISES on a claim with an HONEST current ts, so bounding the clock would not have closed the class',
    advised(honestR2), r2, honestR2.stdout.slice(0, 120));
  const honestFixed = runHook(HOOK, barePayload(tpBad), forgedEnv);
  check('A4 FIXED hook is SILENT for a perfectly well-formed, in-window claim (the channel is gone, not validated)',
    isSilent(honestFixed), { code: honestFixed.code, stdout: honestFixed.stdout });

  console.log('\n=== B. the fixed hook fires for the session the marker NAMES, and nothing else ===');
  const orchardRes = runHook(HOOK, barePayload(tpBad), { ORCHARD_SESSION: BARE_SESSION_ID });
  check('B1 marker names THIS session, non-compliant reply -> the advisory fires',
    advised(orchardRes), orchardRes.stdout.slice(0, 120));
  const orchardGood = runHook(HOOK, barePayload(tpGood), { ORCHARD_SESSION: BARE_SESSION_ID });
  check('B2 marker names THIS session, compliant reply -> silence (not a blanket advisory)',
    isSilent(orchardGood), { code: orchardGood.code, stdout: orchardGood.stdout });
  const blocked = runHook(HOOK, barePayload(tpBad), { ORCHARD_SESSION: BARE_SESSION_ID, ORCHARD_STOP_HOOK_ENFORCE: '1' });
  check('B3 named session in ENFORCE mode -> still blocks (the opt-in path is unbroken)',
    blocked.code === 0 && /"decision":"block"/.test(blocked.stdout), blocked.stdout.slice(0, 90));
  const nestedEnforced = runHook(HOOK, barePayload(tpBad), { ORCHARD_SESSION: ORCHARD_DECLARED_ID, ORCHARD_STOP_HOOK_ENFORCE: '1' });
  check('B4 a nested session can never be BLOCKED, even with enforce on globally',
    isSilent(nestedEnforced), { code: nestedEnforced.code, stdout: nestedEnforced.stdout });
  for (const [label, v] of [
    ['legacy presence flag "1"', '1'], ['true', 'true'], ['yes', 'yes'],
    ['empty', ''], ['zero', '0'], ['false', 'false'], ['whitespace', '   '], ['garbage', 'maybe'],
    ['another session\'s id', ORCHARD_DECLARED_ID],
  ]) {
    const r = runHook(HOOK, barePayload(tpBad), { ORCHARD_SESSION: v });
    check(`B5 marker that does not name this session (${label}) -> silent`, isSilent(r), { code: r.code, stdout: r.stdout });
  }
  {
    // Un-attributable: a payload with no session_id cannot be proven ours.
    const p = barePayload(tpBad); delete p.session_id;
    const r = runHook(HOOK, p, { ORCHARD_SESSION: ORCHARD_DECLARED_ID });
    check('B6 payload with NO session_id -> silent (nothing to match, so not ours)', isSilent(r), { code: r.code, stdout: r.stdout });
    const p2 = barePayload(tpBad); p2.session_id = 42;
    const r2 = runHook(HOOK, p2, { ORCHARD_SESSION: '42' });
    check('B6 a non-string session_id is not coerced into a match', isSilent(r2), { code: r2.code, stdout: r2.stdout });
  }
  const enforcedUnmarked = runHook(HOOK, barePayload(tpBad), { ORCHARD_STOP_HOOK_ENFORCE: '1' });
  check('B7 UNMARKED session can never be BLOCKED even with enforce turned on globally',
    isSilent(enforcedUnmarked), { code: enforcedUnmarked.code, stdout: enforcedUnmarked.stdout });

  console.log('\n=== B8. the launch-claim SIDE DOOR is gone: no file can make the hook vouch ===');
  {
    /*
     * ROUND 3. The trust boundary, stated plainly: `launch-claims.json` sat in
     * the user's data dir, so every process running as this user could write it
     * — including the hand-started sessions this gate exists to exclude. The
     * hook could not tell a server-written claim from anyone else's, so the file
     * was an unauthenticated "grade session X" request. It is no longer read at
     * ALL. Every shape below — well-formed and malformed alike — must be SILENT,
     * and none of them may wedge the turn.
     */
    const shapes = [
      ['a well-formed, in-window claim', { claims: [{ declared: ORCHARD_DECLARED_ID, observed: BARE_SESSION_ID, ts: Date.now() }] }],
      ['a FUTURE-dated claim (the reported defect)', { claims: [{ declared: ORCHARD_DECLARED_ID, observed: BARE_SESSION_ID, ts: Date.now() + 365 * 24 * 3600 * 1000 }] }],
      ['a claim dated at the epoch', { claims: [{ declared: ORCHARD_DECLARED_ID, observed: BARE_SESSION_ID, ts: 0 }] }],
      ['a claim with NO ts', { claims: [{ declared: ORCHARD_DECLARED_ID, observed: BARE_SESSION_ID }] }],
      ['a claim with a non-numeric ts', { claims: [{ declared: ORCHARD_DECLARED_ID, observed: BARE_SESSION_ID, ts: '99999999999999' }] }],
      ['a claim with ts NaN', { claims: [{ declared: ORCHARD_DECLARED_ID, observed: BARE_SESSION_ID, ts: Number.NaN }] }],
      ['a claim with ts Infinity', { claims: [{ declared: ORCHARD_DECLARED_ID, observed: BARE_SESSION_ID, ts: Number.POSITIVE_INFINITY }] }],
      ['a claim whose fields are objects', { claims: [{ declared: { toString: 1 }, observed: [BARE_SESSION_ID], ts: {} }] }],
      ['a null entry in the list', { claims: [null, { declared: ORCHARD_DECLARED_ID, observed: BARE_SESSION_ID, ts: Date.now() }] }],
      ['valid JSON of the WRONG shape (claims not an array)', { claims: { declared: ORCHARD_DECLARED_ID, observed: BARE_SESSION_ID } }],
      ['valid JSON, no claims key', { somethingElse: true }],
      ['valid JSON, a bare array', [{ declared: ORCHARD_DECLARED_ID, observed: BARE_SESSION_ID, ts: Date.now() }]],
      ['valid JSON, a bare string', '"hello"'],
      ['JSON null', 'null'],
      ['an EMPTY file', ''],
      ['whitespace only', '   \n  '],
      ['truncated JSON (a half-written file)', '{"claims":[{"declared":"' + ORCHARD_DECLARED_ID + '","obser'],
      ['a NUL byte in the middle', '{"claims":[]}' + '\x00' + '{"claims":[{"declared":"x"}]}'],
      ['1MB of junk', 'x'.repeat(1024 * 1024)],
    ];
    for (const [label, body] of shapes) {
      writeClaims(body);
      const r = runHook(HOOK, barePayload(tpBad), forgedEnv);
      check(`B8 ${label} -> silent, exit 0`, isSilent(r), { code: r.code, stdout: r.stdout.slice(0, 80), stderr: r.stderr.slice(0, 80) });
    }

    // UNREADABLE (mode 000). Round 2 swallowed this into "no claims"; round 3
    // must not read it in the first place, and must still not wedge.
    const claimsFile = path.join(claimDir, 'launch-claims.json');
    writeClaims({ claims: [{ declared: ORCHARD_DECLARED_ID, observed: BARE_SESSION_ID, ts: Date.now() }] });
    fs.chmodSync(claimsFile, 0o000);
    const unreadable = runHook(HOOK, barePayload(tpBad), forgedEnv);
    check('B8 an UNREADABLE claims file (mode 000) -> silent, exit 0', isSilent(unreadable), { code: unreadable.code, stdout: unreadable.stdout, stderr: unreadable.stderr.slice(0, 80) });
    fs.chmodSync(claimsFile, 0o644);

    // A DIRECTORY where the file should be — an EISDIR read, a different errno.
    fs.rmSync(claimsFile, { force: true });
    fs.mkdirSync(claimsFile, { recursive: true });
    const asDir = runHook(HOOK, barePayload(tpBad), forgedEnv);
    check('B8 a DIRECTORY at the claims path -> silent, exit 0', isSilent(asDir), { code: asDir.code, stdout: asDir.stdout });
    fs.rmSync(claimsFile, { recursive: true, force: true });

    /*
     * CONCURRENT WRITES. Another process rewrites the file (truncate + write, so
     * partial reads are genuinely observable) while the hook runs, over and over.
     * Round 3 must be silent on every single run — and, being a read that no
     * longer happens, it must also never fail.
     */
    let churn = true;
    let churnErr = null;
    const churnLoop = (async () => {
      let n = 0;
      while (churn) {
        try {
          const fd = fs.openSync(claimsFile, 'w');
          fs.writeSync(fd, '{"claims":[{"declared":"' + ORCHARD_DECLARED_ID + '","observed":"' + BARE_SESSION_ID + '","ts":' + (Date.now() + (n % 2 ? 1e10 : 0)) + '}]}');
          fs.closeSync(fd);
          if (n % 3 === 0) fs.truncateSync(claimsFile, 12); // a genuinely half-written file
        } catch (e) { churnErr = e; }
        n++;
        await sleep(1);
      }
    })();
    const concurrent = [];
    for (let i = 0; i < 12; i++) concurrent.push(runHook(HOOK, barePayload(tpBad), forgedEnv));
    churn = false;
    await churnLoop;
    check('B8 12 runs against a file being rewritten/truncated concurrently -> silent every time',
      concurrent.every(isSilent), { silent: concurrent.filter(isSilent).length, of: concurrent.length, churnErr: churnErr ? String(churnErr.code ?? churnErr) : null });

    // And the marker still works in that same data dir: the claims file is inert,
    // not poisonous. (Guards against "silent because something threw".)
    const stillWorks = runHook(HOOK, barePayload(tpBad), { ORCHARD_SESSION: BARE_SESSION_ID, CLAUDE_STATION_DATA: claimDir });
    check('B8 with all that on disk, the session the marker NAMES is still graded (silence is the gate, not a crash)',
      advised(stillWorks), stillWorks.stdout.slice(0, 90));

    // The claim WRITER is gone from the server too — a file nothing reads is a
    // trap for the next reader ("the hook honours this").
    let runtimeMod = null;
    try { runtimeMod = await import(path.join(ROOT, 'src', 'server', 'runtime', 'claude-runtime.ts')); }
    catch (e) { check('B8 claude-runtime importable', false, String(e?.message ?? e)); }
    if (runtimeMod) {
      check('B8 the server no longer exports claimLaunchedSession / launchClaimsFile',
        typeof runtimeMod.claimLaunchedSession === 'undefined' && typeof runtimeMod.launchClaimsFile === 'undefined',
        Object.keys(runtimeMod).filter((k) => /claim/i.test(k)));
    }
    const hookSrc = fs.readFileSync(HOOK, 'utf8');
    check('B8 the hook contains no reader for launch-claims.json',
      !/launch-claims\.json['"]/.test(hookSrc) && !/CLAIM_MAX_AGE_MS/.test(hookSrc),
      { mentionsFile: /launch-claims\.json['"]/.test(hookSrc) });
  }

  console.log('\n=== C. the marker actually reaches the CLI on every launch path ===');
  let ClaudeRuntime = null;
  try { ({ ClaudeRuntime } = await import(path.join(ROOT, 'src', 'server', 'runtime', 'claude-runtime.ts'))); }
  catch (e) { check('ClaudeRuntime importable', false, String(e?.message ?? e)); }

  if (ClaudeRuntime) {
    const fresh = await realChildEnv(ClaudeRuntime);
    check('C1 FRESH LAUNCH: the real SDK spawn ran the fake CLI and it recorded its env + argv', fresh !== null,
      fresh && { ORCHARD_SESSION: fresh.ORCHARD_SESSION, sessionIdArg: argvSessionId(fresh) });
    check('C1 the marker is a session IDENTITY (a uuid), not a presence flag',
      typeof fresh?.ORCHARD_SESSION === 'string' && UUID_RE.test(fresh.ORCHARD_SESSION), fresh?.ORCHARD_SESSION);
    check('C1 THE DECLARATION REACHES THE CLI: `--session-id <marker>` is on the child\'s argv',
      argvSessionId(fresh) !== null && argvSessionId(fresh) === fresh?.ORCHARD_SESSION,
      { sessionIdArg: argvSessionId(fresh), marker: fresh?.ORCHARD_SESSION });
    check('C1 BUG-091 anti-regression: the child still carries the parent PATH (env REPLACES, so the spread is load-bearing)',
      typeof fresh?.PATH === 'string' && fresh.PATH === process.env.PATH, (fresh?.PATH ?? '').slice(0, 60) + '…');

    const fresh2 = await realChildEnv(ClaudeRuntime);
    check('C1 two launches declare DIFFERENT ids (one session, one identity)',
      !!fresh2?.ORCHARD_SESSION && fresh2.ORCHARD_SESSION !== fresh?.ORCHARD_SESSION,
      { first: fresh?.ORCHARD_SESSION, second: fresh2?.ORCHARD_SESSION });

    const RESUMED_ID = '11111111-2222-3333-4444-555555555555';
    const resumed = await realChildEnv(ClaudeRuntime, { resume: RESUMED_ID });
    check('C2 RESUME/OPEN: the marker is the RESUMED id — what Claude Code will report in the Stop payload',
      resumed?.ORCHARD_SESSION === RESUMED_ID, { marker: resumed?.ORCHARD_SESSION, resumed: RESUMED_ID });
    check('C2 a plain resume does NOT also pass --session-id (the SDK forbids it without a fork)',
      argvSessionId(resumed) === null, { argv: resumed?.argv });

    const forked = await realChildEnv(ClaudeRuntime, { resume: RESUMED_ID, forkSession: true });
    check('C3 FORK: the fork gets its OWN declared id, and the CLI is told it',
      !!forked?.ORCHARD_SESSION && forked.ORCHARD_SESSION !== RESUMED_ID
      && UUID_RE.test(forked.ORCHARD_SESSION) && argvSessionId(forked) === forked.ORCHARD_SESSION,
      { marker: forked?.ORCHARD_SESSION, sessionIdArg: argvSessionId(forked) });

    const overrideEnv = await overrideSpawnEnv(ClaudeRuntime);
    check('C4 OVERRIDE PATHS (survival + container use this seam): spawnProcess receives an env carrying the marker',
      typeof overrideEnv?.ORCHARD_SESSION === 'string' && UUID_RE.test(overrideEnv.ORCHARD_SESSION), overrideEnv?.ORCHARD_SESSION ?? null);
  }

  // C5 — the container's real argv builder, no docker needed.
  try {
    const { execArgv } = await import(path.join(ROOT, 'src', 'server', 'container-manager.ts'));
    const argv = execArgv(
      { id: 'proj', hostPath: SCRATCH, isolation: 'container', settings: {} },
      { command: 'claude', args: ['--x'], env: { ORCHARD_SESSION: ORCHARD_DECLARED_ID }, execId: 'exec-1' },
    );
    const i = argv.indexOf(`ORCHARD_SESSION=${ORCHARD_DECLARED_ID}`);
    check('C5 CONTAINER: execArgv forwards the declared id across `docker exec --env`, unchanged',
      i > 0 && argv[i - 1] === '--env', argv.filter((a) => a.includes('ORCHARD_SESSION') || a === '--env').slice(0, 4));
    const argvNoMarker = execArgv(
      { id: 'proj', hostPath: SCRATCH, isolation: 'container', settings: {} },
      { command: 'claude', args: [], env: {}, execId: 'exec-1' },
    );
    check('C5 CONTAINER: nothing is invented when the marker is absent',
      !argvNoMarker.some((a) => a.startsWith('ORCHARD_SESSION')), argvNoMarker.filter((a) => a.includes('ORCHARD')));
  } catch (e) {
    check('C5 container-manager importable', false, String(e?.message ?? e));
  }

  // C6 — survivor. The surviving CLI is the SAME process across a server
  // restart, so it keeps the env it was spawned with; the broker must not strip
  // it on the way in. Assert the pass-through survival.ts actually performs.
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'server', 'survival.ts'), 'utf8');
    check('C6 SURVIVOR: survival.ts spreads the SDK spawn env into the scope env (marker not stripped)',
      /const runEnv[^=]*=\s*\{\s*\.\.\.o\.env\s*\}/.test(src), true);
  }

  console.log('\n=== E. IDENTITY DRIFT: what happens when a session renames itself ===');
  /*
   * The whole gate rests on ONE assumption: the id Orchard declares is the id
   * Claude Code reports in the Stop payload. Everything on the identity-stability
   * list — history compaction, `/clear`, a branched conversation, a replayed
   * transcript, an SDK upgrade that stops honouring `--session-id` — reaches us
   * as exactly the same observable: a message frame carrying a session id that is
   * not the declared one. So that observable is driven here, through the REAL
   * ClaudeRuntime and a real child process, and the contract asserted is the one
   * round 3 chose: REPORT, do not repair.
   *
   * What this canNOT do is make a real CLI compact or branch — that needs a live
   * session and real API calls (see the ticket's live log). Named, not implied.
   */
  if (ClaudeRuntime) {
    const dir = fs.mkdtempSync(path.join(SCRATCH, 'drift-'));
    const DRIFTED_ID = '77777777-8888-4999-a000-bbbbbbbbbbbb';
    const fake = path.join(dir, 'claude');
    fs.writeFileSync(fake, [
      '#!/usr/bin/env node',
      // A fake CLI that RENAMES the session: whatever id it was handed, every
      // frame it emits carries a different one. This is the drift, made real.
      'const readline = require("node:readline");',
      'const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
      'const rl = readline.createInterface({ input: process.stdin });',
      'let started = false;',
      'rl.on("line", (l) => {',
      '  let m; try { m = JSON.parse(l); } catch { return; }',
      '  if (m.type === "control_request") { say({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } }); return; }',
      '  if (m.type !== "user" || started) return;',
      '  started = true;',
      `  say({ type: "system", subtype: "init", session_id: ${JSON.stringify(DRIFTED_ID)}, cwd: process.cwd(), model: "haiku", tools: [], slash_commands: [] });`,
      `  say({ type: "assistant", session_id: ${JSON.stringify(DRIFTED_ID)}, message: { model: "claude-haiku-4-5", content: [{ type: "text", text: "renamed" }] } });`,
      `  say({ type: "assistant", session_id: ${JSON.stringify(DRIFTED_ID)}, message: { model: "claude-haiku-4-5", content: [{ type: "text", text: "again" }] } });`,
      `  say({ type: "result", subtype: "success", session_id: ${JSON.stringify(DRIFTED_ID)}, total_cost_usd: 0 });`,
      '});',
      'process.stdin.resume();',
    ].join('\n'), { mode: 0o755 });

    const driftData = path.join(dir, 'data');
    fs.mkdirSync(driftData, { recursive: true });
    const savedBin = process.env.CLAUDE_STATION_CLAUDE_BIN;
    const savedData = process.env.CLAUDE_STATION_DATA;
    process.env.CLAUDE_STATION_CLAUDE_BIN = fake;
    process.env.CLAUDE_STATION_DATA = driftData;
    const warns = [];
    const realWarn = console.warn;
    console.warn = (...a) => { warns.push(a.join(' ')); };
    let declaredMarker = null;
    try {
      const rt = new ClaudeRuntime();
      rt.start({ cwd: dir, firstPrompt: 'hi', permissionMode: 'default', onApproval: async () => ({ behavior: 'deny', message: 'n/a' }) });
      const until = Date.now() + 10000;
      const drain = (async () => { try { for await (const _ of rt.messages()) { /* the watch runs here */ } } catch { /* fake exits */ } })();
      while (Date.now() < until && !warns.some((w) => w.includes('drifted'))) await sleep(50);
      try { rt.close(); } catch { /* ignore */ }
      await Promise.race([drain, sleep(500)]);
      const m = /declared ([0-9a-f-]{36})/.exec(warns.find((w) => w.includes('drifted')) ?? '');
      declaredMarker = m ? m[1] : null;
    } finally {
      console.warn = realWarn;
      if (savedBin === undefined) delete process.env.CLAUDE_STATION_CLAUDE_BIN; else process.env.CLAUDE_STATION_CLAUDE_BIN = savedBin;
      if (savedData === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = savedData;
    }
    const driftWarn = warns.find((w) => w.includes('drifted')) ?? '';
    check('E1 a CLI that renames its session is REPORTED, with both ids on the warning',
      driftWarn.includes(DRIFTED_ID) && UUID_RE.test(declaredMarker ?? ''),
      driftWarn.slice(0, 160));
    check('E2 the warning says the hook will stop grading it — the consequence, not just the fact',
      /stop grading|not repaired/i.test(driftWarn), driftWarn.slice(0, 160));
    check('E3 exactly ONE warning per distinct drifted id (three frames carried it)',
      warns.filter((w) => w.includes('drifted')).length === 1, warns.filter((w) => w.includes('drifted')).length);
    check('E4 NOTHING is written to the data dir to repair it — no launch-claims.json',
      !fs.existsSync(path.join(driftData, 'launch-claims.json')),
      fs.existsSync(driftData) ? fs.readdirSync(driftData) : 'no data dir');
    // The honest consequence, end to end: that session's Stop payload is now
    // ungraded, and it is ungraded QUIETLY — which is the direction chosen.
    const driftedPayload = { ...barePayload(tpBad), session_id: DRIFTED_ID };
    const afterDrift = runHook(HOOK, driftedPayload, { ORCHARD_SESSION: declaredMarker ?? ORCHARD_DECLARED_ID, CLAUDE_STATION_DATA: driftData });
    check('E5 the drifted session is SILENTLY ungraded (the accepted cost of removing the claim)',
      isSilent(afterDrift), { code: afterDrift.code, stdout: afterDrift.stdout });
    const asItself = runHook(HOOK, driftedPayload, { ORCHARD_SESSION: DRIFTED_ID, CLAUDE_STATION_DATA: driftData });
    check('E6 …and it is graded again the moment the marker names the id the CLI actually reports',
      advised(asItself), asItself.stdout.slice(0, 90));
  }

  console.log('\n=== D. delivery: the fix can reach projects onboarded BEFORE it ===');
  {
    const { onboard } = await import(path.join(ROOT, 'scripts', 'onboard.mjs'));
    const target = path.join(SCRATCH, 'stale-project');
    fs.mkdirSync(target, { recursive: true });
    onboard(target, { noBoard: true });
    const hookDest = path.join(target, 'scripts', 'hooks', 'response-format-gate.mjs');
    // Make it look like a project onboarded before the fix.
    fs.writeFileSync(hookDest, fs.readFileSync(pre.path, 'utf8'));
    // And give it a file of its OWN at a METHOD_FILES path, to prove --force-hook
    // does not touch anything but the hook. `scripts/gate.mjs` is the realistic
    // collision: plenty of repos have their own gate wrapper, and onboard's
    // never-clobber contract is what protects it.
    const ownGate = path.join(target, 'scripts', 'gate.mjs');
    const OWN_GATE = '// this project ships its own gate wrapper\n';
    fs.writeFileSync(ownGate, OWN_GATE);

    /*
     * ROUND 4 — THIS IS THE DEFECT THE CROSS-PROVIDER PASS FOUND, INVERTED.
     * D1 used to assert the opposite ("a plain re-run leaves the stale hook
     * alone") and called that documentation for why --force-hook exists. It was
     * documentation for a fix that never arrived: ordinary onboarding reported
     * `exists (diverged — left untouched)` and every genuine launched session in
     * that project stayed silently ungraded, because the round-1 copy only
     * accepts `1|true|yes` as the marker while the launcher now sends a uuid.
     */
    const plain = onboard(target, { noBoard: true });
    check('D1 an ORDINARY re-run (no flags) RE-SYNCS a stale hook — delivery does not need a flag nobody runs',
      fs.readFileSync(hookDest, 'utf8') === fs.readFileSync(HOOK, 'utf8'),
      plain.find((r) => r.label.endsWith('response-format-gate.mjs'))?.status);
    check('D1b …and it says so in the report, rather than reporting a no-op',
      /re-synced/.test(plain.find((r) => r.label.endsWith('response-format-gate.mjs'))?.status ?? ''),
      plain.find((r) => r.label.endsWith('response-format-gate.mjs'))?.status);

    const again = onboard(target, { noBoard: true });
    check('D2 a second run is a NO-OP on an already-current hook (idempotent, no needless write)',
      again.find((r) => r.label.endsWith('response-format-gate.mjs'))?.status === 'exists (identical)',
      again.find((r) => r.label.endsWith('response-format-gate.mjs'))?.status);
    const forced = onboard(target, { noBoard: true, forceHook: true });
    check('D2b --force-hook still works as an alias (fleet-sync passes it)',
      fs.readFileSync(hookDest, 'utf8') === fs.readFileSync(HOOK, 'utf8'),
      forced.find((r) => r.label.endsWith('response-format-gate.mjs'))?.status);
    check('D3 the re-sync overwrites NOTHING else (the target\'s own scripts/gate.mjs survives)',
      fs.readFileSync(ownGate, 'utf8') === OWN_GATE, true);

    // The re-synced copy in the TARGET must behave, resolving its own deps.
    const copyBare = runHook(hookDest, barePayload(tpBad));
    const copyMarked = runHook(hookDest, barePayload(tpBad), { ORCHARD_SESSION: BARE_SESSION_ID });
    check('D4 the copy IN THE TARGET is silent for a hand-started session', isSilent(copyBare), { code: copyBare.code, stdout: copyBare.stdout });
    check('D5 the copy IN THE TARGET still advises an Orchard session', advised(copyMarked), copyMarked.stdout.slice(0, 90));
  }

  /* ── F. LAUNCH-TIME DELIVERY, and the announcement when it cannot happen ───
   * onboard re-syncing (section D) only helps a project somebody re-onboards.
   * The launcher is the side that is always current AND always runs, so it is
   * where a stale copy is caught. A stale copy cannot report itself: it is old
   * code. Every branch below is driven against a REAL onboarded project tree. */
  console.log('\n=== F. launch-time delivery: a stale copy is repaired, or announced ===');
  {
    const { onboard } = await import(path.join(ROOT, 'scripts', 'onboard.mjs'));
    const { ensureCurrentStopHook } = await import(path.join(ROOT, 'src', 'server', 'runtime', 'claude-runtime.ts'));
    const warns = [];
    const warn = (m) => warns.push(m);

    const proj = path.join(SCRATCH, 'launch-delivery');
    fs.mkdirSync(proj, { recursive: true });
    onboard(proj, { noBoard: true });
    const dest = path.join(proj, 'scripts', 'hooks', 'response-format-gate.mjs');

    const fresh = ensureCurrentStopHook(proj, { warn });
    check('F1 a project whose hook is already current: nothing done, nothing said',
      fresh.hook === 'current' && fresh.wiring === 'wired' && warns.length === 0, { ...fresh, warns: warns.length });

    // The reported defect, at the launcher: a project still holding round 1.
    fs.writeFileSync(dest, fs.readFileSync(pre.path, 'utf8'));
    const repaired = ensureCurrentStopHook(proj, { warn });
    check('F2 a STALE hook is replaced at launch with this repo\'s version',
      repaired.hook === 're-synced' && fs.readFileSync(dest, 'utf8') === fs.readFileSync(HOOK, 'utf8'), repaired);
    check('F3 …and the repair is ANNOUNCED, naming the project and both hashes',
      warns.some((w) => w.includes('STALE') && w.includes(proj) && /[0-9a-f]{8} → [0-9a-f]{8}/.test(w)),
      warns[warns.length - 1]?.slice(0, 150));
    const beforeRepeat = warns.length;
    ensureCurrentStopHook(proj, { warn });
    check('F4 a repeat launch of a now-current project is silent again (no per-launch noise)',
      warns.length === beforeRepeat, warns.length - beforeRepeat);

    // A stale hook we CANNOT repair must be the loudest case of all — this is
    // the one where sessions really are going ungraded.
    const ro = path.join(SCRATCH, 'launch-readonly');
    fs.mkdirSync(ro, { recursive: true });
    onboard(ro, { noBoard: true });
    const roDest = path.join(ro, 'scripts', 'hooks', 'response-format-gate.mjs');
    fs.writeFileSync(roDest, fs.readFileSync(pre.path, 'utf8'));
    fs.chmodSync(roDest, 0o444);
    fs.chmodSync(path.dirname(roDest), 0o555);
    const stuck = ensureCurrentStopHook(ro, { warn });
    fs.chmodSync(path.dirname(roDest), 0o755);
    // Running as root defeats the permission bits; say so rather than passing a
    // check that never ran.
    if (stuck.hook === 're-synced' && process.getuid?.() === 0) {
      check('F5 UNWRITABLE stale hook announces itself [SKIPPED — running as root, permissions do not bind]', true, stuck);
      check('F6 …loudly, with the exact command to fix it [SKIPPED — see F5]', true, 'skipped');
    } else {
      check('F5 an UNWRITABLE stale hook is reported, never passed over in silence',
        stuck.hook === 'stale-unwritable' && warns.some((w) => w.includes('STALE') && w.includes(ro)), stuck);
      check('F6 …and the announcement says sessions are probably not graded, and how to fix it',
        warns.some((w) => w.includes(ro) && /not being graded/i.test(w) && /onboard\.mjs/.test(w)),
        warns.filter((w) => w.includes(ro))[0]?.slice(0, 200));
    }

    // A project that was never onboarded is NOT the silent-failure class — the
    // hook was never running there. The launcher must not scaffold it.
    const virgin = path.join(SCRATCH, 'never-onboarded');
    fs.mkdirSync(virgin, { recursive: true });
    const beforeVirgin = warns.length;
    const untouched = ensureCurrentStopHook(virgin, { warn });
    check('F7 a project that was never onboarded is left completely alone (no scaffolding at launch)',
      untouched.hook === 'not-onboarded' && !fs.existsSync(path.join(virgin, 'scripts')) && warns.length === beforeVirgin,
      untouched);

    // Installed but UNWIRED: Claude Code never runs it. Disabled just as
    // thoroughly as a stale copy, and just as quietly.
    const unwired = path.join(SCRATCH, 'unwired-project');
    fs.mkdirSync(unwired, { recursive: true });
    onboard(unwired, { noBoard: true });
    fs.writeFileSync(path.join(unwired, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }, null, 2));
    const unwiredRes = ensureCurrentStopHook(unwired, { warn });
    check('F8 an installed-but-UNWIRED hook is announced (settings.json no longer runs it)',
      unwiredRes.wiring === 'unwired' && warns.some((w) => w.includes(unwired) && /NOT wired/.test(w)), unwiredRes);

    check('F9 delivery never throws, whatever it is handed (a launch must not fail over this)',
      [null, undefined, '', '/nonexistent/nowhere', ROOT].every((c) => {
        try { return typeof ensureCurrentStopHook(c, { warn: () => {} }).hook === 'string'; } catch { return false; }
      }), true);

    // And the end-to-end shape: a REAL ClaudeRuntime.start() into a stale
    // project repairs the hook before the CLI it is about to spawn can run it.
    const live = path.join(SCRATCH, 'launch-live');
    fs.mkdirSync(live, { recursive: true });
    onboard(live, { noBoard: true });
    const liveDest = path.join(live, 'scripts', 'hooks', 'response-format-gate.mjs');
    fs.writeFileSync(liveDest, fs.readFileSync(pre.path, 'utf8'));
    if (ClaudeRuntime) {
      const dir = fs.mkdtempSync(path.join(SCRATCH, 'spawn-live-'));
      const outFile = path.join(dir, 'env.json');
      const fake = writeFakeClaude(dir, outFile);
      const saved = { bin: process.env.CLAUDE_STATION_CLAUDE_BIN, out: process.env.BUG118_OUT };
      process.env.CLAUDE_STATION_CLAUDE_BIN = fake;
      process.env.BUG118_OUT = outFile;
      try {
        const rt = new ClaudeRuntime();
        rt.start({ cwd: live, firstPrompt: 'hi', permissionMode: 'default', onApproval: async () => ({ behavior: 'allow' }) });
        await sleep(400);
        try { await rt.close?.(); } catch { /* best effort */ }
      } finally {
        if (saved.bin === undefined) delete process.env.CLAUDE_STATION_CLAUDE_BIN; else process.env.CLAUDE_STATION_CLAUDE_BIN = saved.bin;
        if (saved.out === undefined) delete process.env.BUG118_OUT; else process.env.BUG118_OUT = saved.out;
      }
      check('F10 a REAL runtime start into a stale project makes the hook current before the CLI runs it',
        fs.readFileSync(liveDest, 'utf8') === fs.readFileSync(HOOK, 'utf8'), 'hook bytes match this repo');
      const nowGraded = runHook(liveDest, { ...barePayload(tpBad), session_id: BARE_SESSION_ID }, { ORCHARD_SESSION: BARE_SESSION_ID });
      check('F11 …and that repaired copy grades a session the CURRENT launcher declares (the defect, closed)',
        advised(nowGraded), nowGraded.stdout.slice(0, 90));
    }
  }

  /* ── G. A TURN THIS HOOK DECLINED TO GRADE LEAVES A TRACE ──────────────────
   * Silence is indistinguishable from compliance — that is exactly how three
   * rounds of stale copies survived. The hook stays silent toward whoever is
   * running (advising a stranger is round 1's defect) and records instead. */
  console.log('\n=== G. the ungraded record: silence toward the session, never toward us ===');
  {
    const gData = path.join(SCRATCH, 'ungraded-data');
    const logFile = path.join(gData, 'logs', 'stop-hook-advisory.log');
    const readLog = () => {
      try {
        return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
      } catch { return []; }
    };

    // (a) the nested/renamed case: marker set, payload names a different session.
    const other = runHook(HOOK, barePayload(tpBad), { ORCHARD_SESSION: ORCHARD_DECLARED_ID, CLAUDE_STATION_DATA: gData });
    check('G1 a marker that names another session is still SILENT toward the session',
      isSilent(other), { code: other.code, stdout: other.stdout, stderr: other.stderr });
    const g1 = readLog().filter((r) => r?.mode === 'ungraded');
    check('G2 …but leaves an `ungraded` record naming BOTH ids, so nobody has to guess',
      g1.length === 1 && g1[0].verdict === 'other-id' && g1[0].declared === ORCHARD_DECLARED_ID && g1[0].observed === BARE_SESSION_ID,
      g1[0]);

    // (b) the upgrade case: a payload that carries no session_id at all.
    const noId = { ...barePayload(tpBad) };
    delete noId.session_id;
    const none = runHook(HOOK, noId, { ORCHARD_SESSION: ORCHARD_DECLARED_ID, CLAUDE_STATION_DATA: gData });
    check('G3 a payload with NO session_id is silent AND recorded as `no-id`',
      isSilent(none) && readLog().filter((r) => r?.verdict === 'no-id').length === 1,
      readLog().filter((r) => r?.verdict === 'no-id')[0]);

    // (c) a session with no marker at all — the overwhelmingly common case — must
    // stay completely free: no record, no I/O, nothing.
    const beforeBare = readLog().length;
    const bare = runHook(HOOK, barePayload(tpBad), { CLAUDE_STATION_DATA: gData });
    check('G4 a session that is not ours at all writes NOTHING (no marker, no record, no noise)',
      isSilent(bare) && readLog().length === beforeBare, { records: readLog().length - beforeBare });

    // (d) a graded turn is not filed as ungraded.
    const ownPayload = { ...barePayload(tpBad), session_id: ORCHARD_DECLARED_ID };
    const ours = runHook(HOOK, ownPayload, { ORCHARD_SESSION: ORCHARD_DECLARED_ID, CLAUDE_STATION_DATA: gData });
    check('G5 a turn we DO grade is filed as an advisory, never as `ungraded`',
      advised(ours) && readLog().filter((r) => r?.mode === 'ungraded').length === 2,
      readLog().map((r) => r?.mode));

    // (e) the record must never cost the turn: an unwritable log directory.
    const brokenData = path.join(SCRATCH, 'ungraded-broken');
    fs.mkdirSync(brokenData, { recursive: true });
    fs.writeFileSync(path.join(brokenData, 'logs'), 'not a directory');
    const brokenRun = runHook(HOOK, barePayload(tpBad), { ORCHARD_SESSION: ORCHARD_DECLARED_ID, CLAUDE_STATION_DATA: brokenData });
    check('G6 an unwritable log sink changes nothing about the turn (still silent, still exit 0)',
      isSilent(brokenRun), { code: brokenRun.code, stdout: brokenRun.stdout, stderr: brokenRun.stderr });

    /* THE REDUCTION CLAIM, driven rather than asserted. Round 3 claimed four
     * scenarios it could not run — compaction, a cleared/branched conversation,
     * a replayed transcript, and an upgrade that stops passing --session-id —
     * all reduce to ONE observable. Here is that observable, produced by each
     * scenario's own payload shape, against the real installed hook. What this
     * does NOT prove is that a real CLI produces these shapes in those
     * scenarios; that needs a live CLI and is listed in the closing note. */
    const scenarios = [
      ['compaction re-keys the session', { ...barePayload(tpBad), session_id: '99999999-1111-4222-8333-444444444444' }, 'other-id'],
      ['a cleared / branched conversation', { ...barePayload(tpBad), session_id: 'aaaaaaaa-1111-4222-8333-444444444444' }, 'other-id'],
      ['a replayed transcript under a new id', { ...barePayload(tpBad), session_id: 'bbbbbbbb-1111-4222-8333-444444444444' }, 'other-id'],
      ['an upgrade that stops passing a session id', noId, 'no-id'],
    ];
    const rData = path.join(SCRATCH, 'reduction-data');
    let reduced = 0;
    for (const [name, payload, expect] of scenarios) {
      const dir = path.join(rData, expect + '-' + reduced);
      const res = runHook(HOOK, payload, { ORCHARD_SESSION: ORCHARD_DECLARED_ID, CLAUDE_STATION_DATA: dir });
      let rec = [];
      try { rec = fs.readFileSync(path.join(dir, 'logs', 'stop-hook-advisory.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { /* none */ }
      const ok = isSilent(res) && rec.length === 1 && rec[0].mode === 'ungraded' && rec[0].verdict === expect;
      if (ok) reduced++;
      check(`G7 reduction: ${name} → silent turn + one \`${expect}\` record`, ok, rec[0] ?? { code: res.code, stdout: res.stdout });
    }
    check('G8 all four claimed-equivalent scenarios really do land on the same observable',
      reduced === scenarios.length, `${reduced}/${scenarios.length}`);

    /* THE HOLE THE LAUNCHER'S BYTE CHECK CANNOT SEE. onboard re-syncs the hook,
     * and nothing re-syncs the closure it grades with (those files have names a
     * target can own, so clobbering them is not safe the way the hook is). A
     * CURRENT hook on a STALE closure therefore fails inside the hook — and
     * every one of those paths used to end at a silent allow(). Driven against a
     * REAL onboarded project with a genuinely broken copy of digest.js. */
    const { onboard } = await import(path.join(ROOT, 'scripts', 'onboard.mjs'));
    const stale = path.join(SCRATCH, 'stale-closure');
    fs.mkdirSync(stale, { recursive: true });
    onboard(stale, { noBoard: true });
    const staleHook = path.join(stale, 'scripts', 'hooks', 'response-format-gate.mjs');
    const staleData = path.join(SCRATCH, 'stale-closure-data');
    const staleLog = () => {
      try { return fs.readFileSync(path.join(staleData, 'logs', 'stop-hook-advisory.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; }
    };
    const digestCopy = path.join(stale, 'public', 'lib', 'digest.js');
    // An OLD copy that predates parseDigest: loads fine, exports the wrong thing.
    fs.writeFileSync(digestCopy, 'export function renderDigest() { return null; }\n');
    const ownPayloadStale = { ...barePayload(tpBad), session_id: ORCHARD_DECLARED_ID, cwd: stale };
    const staleRun = runHook(staleHook, ownPayloadStale, { ORCHARD_SESSION: ORCHARD_DECLARED_ID, CLAUDE_STATION_DATA: staleData });
    check('G9 a CURRENT hook on a STALE closure still allows the turn (never wedge)',
      staleRun.code === 0 && !staleRun.stdout.includes('"decision"'), { code: staleRun.code, stdout: staleRun.stdout.slice(0, 80) });
    check('G10 …and records WHY it could not grade, instead of looking like a compliant turn',
      staleLog().some((r) => r?.mode === 'ungraded' && r.verdict === 'deps-digest-incompatible'),
      staleLog().map((r) => r?.verdict));

    // A closure file that is not merely old but broken outright.
    fs.writeFileSync(digestCopy, 'export const parseDigest = 5;\nthis is not javascript(');
    const brokeData = path.join(SCRATCH, 'broken-closure-data');
    const brokeRun = runHook(staleHook, { ...ownPayloadStale }, { ORCHARD_SESSION: ORCHARD_DECLARED_ID, CLAUDE_STATION_DATA: brokeData });
    let brokeRec = [];
    try { brokeRec = fs.readFileSync(path.join(brokeData, 'logs', 'stop-hook-advisory.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { /* none */ }
    check('G11 an UNPARSEABLE closure file is allowed through and recorded, not silently swallowed',
      brokeRun.code === 0 && brokeRec.some((r) => r?.verdict === 'deps-digest-unloadable'),
      { code: brokeRun.code, verdicts: brokeRec.map((r) => r?.verdict) });
  }

  /* ── H. FEAT-106 — THE GRADING CLOSURE RESOLVES IN BOTH LAYOUTS ─────────────
   * Commit 2 made the hook's two dynamic imports (digest.js, response-blocks.js)
   * a candidate loop: `../lib/<x>.js` (the consolidated `.orchard/` layout) is
   * tried FIRST, then `../../public/lib/<x>.js` (Orchard's own tree + legacy
   * onboarded targets). This section drives the REAL current hook from a mirror
   * in EACH layout and proves the closure resolved — because a candidate loop
   * that silently fell through would leave the hook fully inert while looking
   * exactly like a compliant turn (the deps-* signature). It also drives the
   * D-partial contract: compliant vs. missing-fence must produce DIFFERENT
   * outcomes, in advisory AND enforce mode, in both layouts. */
  console.log('\n=== H. FEAT-106: the grading closure resolves in BOTH layouts ===');
  {
    const readLogAt = (dir) => {
      try {
        return fs.readFileSync(path.join(dir, 'logs', 'stop-hook-advisory.log'), 'utf8')
          .trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
      } catch { return []; }
    };
    // The exact signature of a candidate-import loop that failed: because the hook
    // fails OPEN, this is otherwise completely invisible.
    const depsFailed = (recs) => recs.some((r) => r?.mode === 'ungraded' && /^deps-(digest|blocks)-/.test(r?.verdict ?? ''));

    // Copy the CURRENT hook into the mirror so its relative imports resolve
    // against THAT mirror's layout, then grade a session the marker names.
    const drive = (mirrorPath, dataDir, tp, extraEnv = {}) => {
      fs.writeFileSync(mirrorPath, fs.readFileSync(HOOK));
      return runHook(mirrorPath, { ...barePayload(tp), session_id: BARE_SESSION_ID },
        { ORCHARD_SESSION: BARE_SESSION_ID, CLAUDE_STATION_DATA: dataDir, ...extraEnv });
    };

    for (const [layout, mkMirror] of [['LEGACY (../../public/lib)', () => mirrorFor('feat106-legacy')],
      ['FLAT .orchard (../lib)', () => flatMirrorFor('feat106-flat')]]) {
      const hookPath = mkMirror();
      const data = path.join(SCRATCH, `feat106-${layout.startsWith('LEGACY') ? 'legacy' : 'flat'}-data`);
      const bad = drive(hookPath, data, tpBad);
      const good = drive(hookPath, data, tpGood);
      check(`H1 ${layout}: a missing-fence reply is ADVISED (closure resolved)`, advised(bad), bad.stdout.slice(0, 90));
      check(`H2 ${layout}: a compliant reply is SILENT — the two outcomes DIFFER`,
        isSilent(good) && advised(bad), { good: good.stdout.slice(0, 40) || '(silent)', bad: bad.stdout.slice(0, 40) });
      check(`H3 ${layout}: NO deps-digest/deps-blocks ungraded record (the loop did not silently fail)`,
        !depsFailed(readLogAt(data)), readLogAt(data).map((r) => r?.verdict));

      // D-partial in ENFORCE mode: compliant allows, missing-fence BLOCKS — differ.
      const enfData = data + '-enf';
      const badEnf = drive(hookPath, enfData, tpBad, { ORCHARD_STOP_HOOK_ENFORCE: '1' });
      const goodEnf = drive(hookPath, enfData, tpGood, { ORCHARD_STOP_HOOK_ENFORCE: '1' });
      check(`H4 ${layout}: ENFORCE mode blocks the missing-fence reply and allows the compliant one (differ)`,
        /"decision":"block"/.test(badEnf.stdout) && isSilent(goodEnf), { bad: badEnf.stdout.slice(0, 40), good: goodEnf.stdout.slice(0, 40) || '(silent)' });
      check(`H5 ${layout}: still no deps-* record under enforce`, !depsFailed(readLogAt(enfData)), readLogAt(enfData).map((r) => r?.verdict));
    }

    // H6 — NON-VACUITY. With the grading closure absent from BOTH candidate paths
    // (static deps kept so the hook still loads), the loop genuinely fails: the
    // turn stays silent AND a deps-digest-unloadable record IS written. Without
    // this, H3/H5 could pass on a hook that never resolves anything.
    const noClosure = flatMirrorFor('feat106-noclosure', { closure: false });
    fs.writeFileSync(noClosure, fs.readFileSync(HOOK));
    const ncData = path.join(SCRATCH, 'feat106-noclosure-data');
    const ncRun = runHook(noClosure, { ...barePayload(tpBad), session_id: BARE_SESSION_ID },
      { ORCHARD_SESSION: BARE_SESSION_ID, CLAUDE_STATION_DATA: ncData });
    check('H6 NON-VACUITY: neither ../lib nor ../../public/lib present -> silent AND a deps-digest-unloadable record',
      isSilent(ncRun) && readLogAt(ncData).some((r) => r?.verdict === 'deps-digest-unloadable'),
      { silent: isSilent(ncRun), verdicts: readLogAt(ncData).map((r) => r?.verdict) });
  }
};

main()
  .catch((e) => { console.error(e); fail++; failures.push(`threw: ${e?.message ?? e}`); })
  .finally(() => {
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* ignore */ }

    /*
     * EVIDENCE QUALITY, printed where nobody can miss it. A must-FAIL control
     * that quietly became a reconstruction is weaker than it looks, and in a
     * clean room (no `.git`) that is exactly what happens.
     */
    const rebuilt = specimens.filter((s) => s.reconstructed);
    console.log(`\nmust-FAIL specimens: ${specimens.length - rebuilt.length} genuine (from git history), ${rebuilt.length} RECONSTRUCTED`);
    if (rebuilt.length) {
      console.log('  *** DEGRADED CONTROLS — these must-FAILs did NOT run the historical file: ***');
      for (const s of rebuilt) console.log(`    - ${s.name} (${s.sha}): ${s.source}${s.valid ? '' : ' [reconstruction FAILED its own shape check]'}`);
      console.log('  Re-run where `git show <sha>` works to get the real evidence.');
    }
    console.log('WHAT SECTION G DOES AND DOES NOT PROVE (round 4, the reduction claim):');
    console.log('  PROVEN here — the four scenarios round 3 called equivalent (compaction, a cleared or');
    console.log('    branched conversation, a replayed transcript, an upgrade that stops passing a session');
    console.log('    id) do all reduce to ONE observable in the real installed hook: the turn is silent and');
    console.log('    exactly one `ungraded` record is written, `other-id` for the first three, `no-id` for');
    console.log('    the fourth. Section E drives the same observable through the REAL runtime.');
    console.log('  NOT PROVEN here — that a real Claude Code CLI actually produces those payload shapes in');
    console.log('    those situations. That needs a live CLI + API (compaction cannot be forced offline at');
    console.log('    all), so the equivalence is tested where it is code, and ASSUMED where it is the CLI.');

    console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
    if (failures.length) console.log('  failed:', failures.join(' | '));
    process.exit(fail === 0 ? 0 : 1);
  });
