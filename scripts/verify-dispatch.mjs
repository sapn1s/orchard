#!/usr/bin/env node
/**
 * FEAT-043 — scripts/dispatch.mjs verified against the FAKE `codex app-server`
 * (scripts/fixtures/codex-fake-app-server.mjs) via the runtime's
 * CLAUDE_STATION_CODEX_BIN seam — no Codex install, no subscription, no :4317.
 *
 *   node scripts/verify-dispatch.mjs
 *
 * NON-VACUITY: this suite (and dispatch.mjs itself) did not exist pre-change —
 * `node scripts/dispatch.mjs …` exited 1 with MODULE_NOT_FOUND (captured in
 * the FEAT-043 ticket), so every check here fails on the pre-change tree.
 * The fake also VALIDATES the client protocol (bad sandbox enums, wrong
 * spellings → child exit 1 → transport failure → nonzero dispatch exit).
 *
 * What it drives, end to end, through the REAL dispatch.mjs → CodexRuntime →
 * TranscriptRecorder stack:
 *   1  success: final text on STDOUT (exactly, machine-consumable), progress
 *      on stderr, exit 0, default sandbox read-only announced
 *   2  Orchard transcript recorded under $CLAUDE_STATION_DATA/transcripts/
 *      openai/<encodedDir>/<threadId>.jsonl — provider-tagged entries the
 *      dashboard's history reader (listOrchardSessions) actually lists
 *   3  induced failure (fake FAIL_QUOTA turn) → exit nonzero + the BUG-031
 *      taxonomy kind named on stderr (quota-window)
 *   4  --sandbox workspace-write accepted (fake validates the enum on the wire)
 *   5  --provider anthropic delegates to `claude -p --output-format json`
 *      (fake claude shim on PATH), unwrapping `result` to stdout, exit code
 *      mirrored
 *   6  usage errors: bad provider / missing task → exit nonzero + usage text
 *   7  FEAT-043 v1-hardening: anthropic --timeout-min actually KILLS the
 *      claude process (group) — a slow shim proves this by never reaching
 *      its post-sleep marker write, not just by the runner giving up
 *   8  FEAT-043 v1-hardening: anthropic --sandbox is translated to a real
 *      claude CLI flag (--permission-mode plan+disallowedTools for
 *      read-only, acceptEdits for workspace-write) instead of being ignored
 *   9  FEAT-043 v1-hardening: anthropic failures are classified into the
 *      BUG-031 taxonomy (status-code AND text-pattern paths), not just a
 *      mirrored exit code
 * Kill by pid/process-group only; scratch temp dirs; nothing global touched.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DISPATCH = path.join(ROOT, 'scripts', 'dispatch.mjs');
const FAKE = path.join(ROOT, 'scripts', 'fixtures', 'codex-fake-app-server.mjs');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

function runDispatch(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DISPATCH, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const guard = setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 30_000);
    child.once('exit', (code) => { clearTimeout(guard); resolve({ code, stdout, stderr }); });
  });
}

async function main() {
  const CWD_FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dispatch-cwd-'));

  /* ---- 1+2: success path + transcript capture + dashboard listing ---- */
  console.log('\n[1] openai success: stdout = final text, stderr = progress, exit 0');
  const DATA1 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dispatch-data1-'));
  const r1 = await runDispatch(
    ['--provider', 'openai', '--cwd', CWD_FIX, 'hello fixture'],
    { CLAUDE_STATION_DATA: DATA1, CLAUDE_STATION_CODEX_BIN: FAKE },
  );
  check('exit 0', r1.code === 0, `code=${r1.code}`);
  check('STDOUT is EXACTLY the final result text (machine-consumable)',
    r1.stdout === 'Hello from fixture Codex.\n', JSON.stringify(r1.stdout));
  check('stderr carries progress (thread id + token usage), not stdout',
    /thread thr_fixture_0001 started/.test(r1.stderr) && /tokens:/.test(r1.stderr), r1.stderr.split('\n')[0]);
  check('default sandbox is read-only (announced; fake validated the enum on the wire)',
    /sandbox read-only/.test(r1.stderr), /sandbox [a-z-]+/.exec(r1.stderr)?.[0]);

  console.log('\n[2] Orchard transcript recorded + listed by the dashboard reader');
  process.env.CLAUDE_STATION_DATA = DATA1; // must be set BEFORE importing the store layer
  const hist = await import(path.join(ROOT, 'src', 'lib', 'session-history.ts'));
  const ot = await import(path.join(ROOT, 'src', 'server', 'orchard-transcripts.ts'));
  const encodedDir = hist.encodeCwd(CWD_FIX);
  const tFile = ot.orchardTranscriptFile('openai', encodedDir, 'thr_fixture_0001');
  check('transcript file exists at transcripts/openai/<encodedDir>/<threadId>.jsonl',
    fs.existsSync(tFile), tFile.replace(DATA1, '$DATA'));
  const lines = fs.existsSync(tFile)
    ? fs.readFileSync(tFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  check('entries carry provider:"openai" + the user prompt + the assistant answer',
    lines.length >= 2 && lines.every((l) => l.provider === 'openai')
    && lines[0]?.type === 'user' && lines[0]?.message?.content?.[0]?.text === 'hello fixture'
    && lines.some((l) => l.type === 'assistant' && l.message?.content?.[0]?.text === 'Hello from fixture Codex.'),
    `lines=${lines.length}`);
  const listed = ot.listOrchardSessions(encodedDir);
  check('listOrchardSessions (the sessions/history list source) returns the dispatch run, provider-tagged',
    listed.length === 1 && listed[0]?.provider === 'openai' && listed[0]?.sessionId === 'thr_fixture_0001',
    listed.map((s) => `${s.provider}:${s.sessionId}`));
  check('dispatch printed the transcript path for auditability', r1.stderr.includes(tFile), 'path echoed');

  /* ---- 3: induced failure → BUG-031 taxonomy on stderr, nonzero exit ---- */
  console.log('\n[3] induced failed turn → named taxonomy kind + nonzero exit');
  const DATA3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dispatch-data3-'));
  const r3 = await runDispatch(
    ['--provider', 'openai', '--cwd', CWD_FIX, 'FAIL_QUOTA now'],
    { CLAUDE_STATION_DATA: DATA3, CLAUDE_STATION_CODEX_BIN: FAKE },
  );
  check('exit nonzero on failed turn', r3.code !== 0 && r3.code != null, `code=${r3.code}`);
  check('stderr names the BUG-031 kind [quota-window] + provider + the verbatim detail',
    /dispatch failed \[quota-window\] \(provider openai\)/.test(r3.stderr) && /usage limit/i.test(r3.stderr),
    /dispatch failed[^\n]*/.exec(r3.stderr)?.[0]);
  check('no result text leaked to stdout on failure', r3.stdout === '', JSON.stringify(r3.stdout));

  /* ---- 4: workspace-write opt-in ---- */
  console.log('\n[4] --sandbox workspace-write accepted on the wire');
  const DATA4 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dispatch-data4-'));
  const r4 = await runDispatch(
    ['--provider', 'openai', '--cwd', CWD_FIX, '--sandbox', 'workspace-write', 'hello fixture'],
    { CLAUDE_STATION_DATA: DATA4, CLAUDE_STATION_CODEX_BIN: FAKE },
  );
  check('workspace-write run succeeds (fake validated sandbox enum, exit 0)',
    r4.code === 0 && /sandbox workspace-write/.test(r4.stderr), `code=${r4.code}`);

  /* ---- 5: anthropic delegation via --output-format json ---- */
  console.log('\n[5] --provider anthropic delegates to `claude -p --output-format json`');
  const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dispatch-bin-'));
  fs.writeFileSync(
    path.join(BIN, 'claude'),
    '#!/bin/sh\necho "SHIM_ARGS:$@" >&2\necho \'{"is_error":false,"result":"claude-final-result","usage":{"output_tokens":5}}\'\nexit 0\n',
    { mode: 0o755 },
  );
  const r5 = await runDispatch(
    ['--provider', 'anthropic', '--model', 'opus', '--cwd', CWD_FIX, 'summarize this'],
    { PATH: `${BIN}${path.delimiter}${process.env.PATH}` },
  );
  check('claude CLI invoked with -p + the task + --model + --output-format json, result.result unwrapped to stdout, exit 0',
    r5.code === 0 && r5.stdout === 'claude-final-result\n'
    && /SHIM_ARGS:-p summarize this --output-format json --model opus/.test(r5.stderr), r5.stderr.trim().split('\n')[0]);

  /* ---- 6: usage errors ---- */
  console.log('\n[6] usage errors are loud and nonzero');
  const r6a = await runDispatch(['--provider', 'gemini', 'x'], {});
  check('unknown provider → nonzero + usage', r6a.code !== 0 && /usage:/.test(r6a.stderr), `code=${r6a.code}`);
  const r6b = await runDispatch(['--provider', 'openai'], {});
  check('missing task prompt → nonzero + usage', r6b.code !== 0 && /no task prompt/.test(r6b.stderr), `code=${r6b.code}`);

  /* ---- 7: anthropic --timeout-min actually KILLS the process ---- */
  console.log('\n[7] anthropic --timeout-min kills the claude process (group), names [timeout]');
  const BIN7 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dispatch-bin7-'));
  const MARKER7 = path.join(BIN7, 'reached-end-of-sleep.marker');
  fs.writeFileSync(
    path.join(BIN7, 'claude'),
    `#!/bin/sh\necho "SHIM_ARGS:$@" >&2\nsleep 5\ntouch "${MARKER7}"\necho '{"is_error":false,"result":"late-should-not-happen"}'\nexit 0\n`,
    { mode: 0o755 },
  );
  const t7start = Date.now();
  const r7 = await runDispatch(
    ['--provider', 'anthropic', '--timeout-min', '0.02', '--cwd', CWD_FIX, 'slow task'], // 1.2s timeout
    { PATH: `${BIN7}${path.delimiter}${process.env.PATH}` },
  );
  const t7elapsed = Date.now() - t7start;
  check('exit nonzero, well before the shim\'s 5s sleep would finish naturally',
    r7.code !== 0 && t7elapsed < 4000, `code=${r7.code} elapsed=${t7elapsed}ms`);
  check('stderr names [timeout]', /dispatch failed \[timeout\]/.test(r7.stderr), /dispatch failed[^\n]*/.exec(r7.stderr)?.[0]);
  check('no stale result leaked to stdout', r7.stdout === '', JSON.stringify(r7.stdout));
  // Wait past the shim's sleep(5) to prove the process was truly killed, not
  // just abandoned (if not killed, the marker would appear ~5s after start).
  await new Promise((r) => setTimeout(r, Math.max(0, 5500 - t7elapsed)));
  check('the shim never reached its post-sleep marker (real process/group kill, not an orphaned survivor)',
    !fs.existsSync(MARKER7), `marker exists=${fs.existsSync(MARKER7)}`);

  /* ---- 8: anthropic --sandbox translated to a real claude flag ---- */
  console.log('\n[8] anthropic --sandbox is honored (translated), not ignored');
  const BIN8 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dispatch-bin8-'));
  fs.writeFileSync(
    path.join(BIN8, 'claude'),
    '#!/bin/sh\necho "SHIM_ARGS:$@" >&2\necho \'{"is_error":false,"result":"ok"}\'\nexit 0\n',
    { mode: 0o755 },
  );
  const r8ro = await runDispatch(
    ['--provider', 'anthropic', '--cwd', CWD_FIX, 'x'],
    { PATH: `${BIN8}${path.delimiter}${process.env.PATH}` },
  );
  check('default (read-only) maps to --permission-mode plan + --disallowedTools Edit,Write,NotebookEdit',
    /--permission-mode plan --disallowedTools Edit,Write,NotebookEdit/.test(r8ro.stderr), r8ro.stderr.split('\n')[0]);
  const r8ww = await runDispatch(
    ['--provider', 'anthropic', '--sandbox', 'workspace-write', '--cwd', CWD_FIX, 'x'],
    { PATH: `${BIN8}${path.delimiter}${process.env.PATH}` },
  );
  check('workspace-write maps to --permission-mode acceptEdits (no disallow-list)',
    /--permission-mode acceptEdits/.test(r8ww.stderr) && !/disallowedTools/.test(r8ww.stderr), r8ww.stderr.split('\n')[0]);

  /* ---- 9: anthropic failures classified into the BUG-031 taxonomy ---- */
  console.log('\n[9] anthropic induced failures get a named taxonomy kind, not a bare exit-code mirror');
  const BIN9 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dispatch-bin9-'));
  fs.writeFileSync(
    path.join(BIN9, 'claude'),
    '#!/bin/sh\necho \'{"is_error":true,"api_error_status":429,"result":"You have hit the rate limit, please slow down."}\'\nexit 1\n',
    { mode: 0o755 },
  );
  const r9a = await runDispatch(
    ['--provider', 'anthropic', '--cwd', CWD_FIX, 'x'],
    { PATH: `${BIN9}${path.delimiter}${process.env.PATH}` },
  );
  check('status-code path: HTTP 429 → [rate-limited], retryable, provider named, verbatim detail',
    r9a.code !== 0 && /dispatch failed \[rate-limited\] \(provider anthropic, retryable\): You have hit the rate limit/.test(r9a.stderr),
    /dispatch failed[^\n]*/.exec(r9a.stderr)?.[0]);
  check('no result text leaked to stdout on classified failure', r9a.stdout === '', JSON.stringify(r9a.stdout));

  const BIN9b = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dispatch-bin9b-'));
  fs.writeFileSync(
    path.join(BIN9b, 'claude'),
    '#!/bin/sh\necho \'{"is_error":true,"result":"usage limit reached for this plan"}\'\nexit 1\n',
    { mode: 0o755 },
  );
  const r9b = await runDispatch(
    ['--provider', 'anthropic', '--cwd', CWD_FIX, 'x'],
    { PATH: `${BIN9b}${path.delimiter}${process.env.PATH}` },
  );
  check('text-pattern path (no status code): "usage limit" → [quota-window]',
    r9b.code !== 0 && /dispatch failed \[quota-window\] \(provider anthropic\): usage limit reached/.test(r9b.stderr),
    /dispatch failed[^\n]*/.exec(r9b.stderr)?.[0]);

  for (const d of [CWD_FIX, DATA1, DATA3, DATA4, BIN, BIN7, BIN8, BIN9, BIN9b]) fs.rmSync(d, { recursive: true, force: true });

  console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log('failing checks:\n  - ' + failures.join('\n  - '));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(`FATAL: ${err.stack ?? err.message}`); process.exit(1); });
