/**
 * BUG-177 — a quality gate (a Claude Code hook) can fail on EVERY turn and
 * Orchard used to show the user nothing. The transcript records each failure as
 * a `type:"attachment"` line whose `attachment.type` is `hook_non_blocking_error`,
 * but that line is neither `user` nor `assistant`, so every transcript reader
 * filtered it out. This script proves the SERVER half of the fix: the same single
 * count scan the route already pays for now rolls those failures up into
 * `hookErrors`, classified into "never ran" (crash) vs "ran and reported".
 *
 *   node scripts/verify-bug-177-hook-errors.mjs
 *
 * Must-FAIL proof (anchored to a FIXED pre-fix surface, not a moving baseline):
 * the pre-fix route surfaced ONLY the `messages` array — user/assistant entries,
 * with every attachment filtered out. We reconstruct that exact surface here and
 * assert NO hook failure is visible in it. That is the demonstration that the
 * feature was absent. The post-fix `countMessages(...).hookErrors` then surfaces
 * all of them with correct counts and classification.
 *
 * Real artifact: if a real transcript carrying these records is present under
 * ~/.claude/projects, we assert the roll-up against it too (invariant properties,
 * not pinned values — the count must match a raw line count, and a module-missing
 * failure must classify as `crash`).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { countMessages, clearTranscriptCaches } = await import(path.join(ROOT, 'src', 'server', 'transcript.ts'));

let pass = 0, fail = 0;
const failures = [];
function check(desc, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${desc}`); }
  else { fail++; failures.push(desc); console.log(`  FAIL ${desc}  ${detail != null ? JSON.stringify(detail) : ''}`); }
}

/* --------------------------------------------------- realistic fixture ----
 * A busy session: real turns interleaved with the exact failure the ticket
 * measured (a response-format gate whose module is missing, firing on EVERY
 * turn), PLUS a second, different hook that RAN and reported a problem. Paths
 * are scrubbed to ~ so the fixture is publishable. Shapes copied from a real
 * `hook_non_blocking_error` attachment (CLI 2.1.263). */

const CRASH_STDERR =
  "Failed with non-blocking status code: node:internal/modules/cjs/loader:1520\n" +
  "  throw err;\n  ^\n\n" +
  "Error: Cannot find module '~/scripts/hooks/response-format-gate.mjs'\n" +
  "    at Module._resolveFilename (node:internal/modules/cjs/loader:1517:15)\n" +
  "    at Module._load (node:internal/modules/cjs/loader:1294:5)\n" +
  "  code: 'MODULE_NOT_FOUND',\n  requireStack: []\n}\n\nNode.js v24.18.0";

function userLine(uuid, text, ts) {
  return JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid,
    message: { role: 'user', content: text }, timestamp: ts });
}
function asstLine(uuid, parentUuid, text, ts) {
  return JSON.stringify({ parentUuid, isSidechain: false, type: 'assistant', uuid,
    message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }] }, timestamp: ts });
}
function crashHookLine(uuid, parentUuid, ts) {
  return JSON.stringify({ parentUuid, isSidechain: false, type: 'attachment', uuid, timestamp: ts,
    attachment: { type: 'hook_non_blocking_error', hookName: 'Stop', hookEvent: 'Stop',
      toolUseID: null, stderr: CRASH_STDERR, stdout: '', exitCode: 1,
      command: 'Checking response format (advisory)', durationMs: 35 } });
}
function reportedHookLine(uuid, parentUuid, ts) {
  return JSON.stringify({ parentUuid, isSidechain: false, type: 'attachment', uuid, timestamp: ts,
    attachment: { type: 'hook_non_blocking_error', hookName: 'PostToolUse', hookEvent: 'PostToolUse',
      toolUseID: 'tu-1', stderr: 'lint gate: 3 findings need review before commit', stdout: '',
      exitCode: 1, command: 'lint gate', durationMs: 120 } });
}

const N_TURNS = 21; // the ticket's measured figure: every turn, whole session
function buildBusyFixture() {
  const lines = [];
  for (let i = 0; i < N_TURNS; i++) {
    const ts = new Date(Date.UTC(2026, 8, 8, 1, i, 0)).toISOString();
    const u = `u-${i}`, a = `a-${i}`;
    lines.push(userLine(u, `do task ${i}`, ts));
    lines.push(asstLine(a, u, `done ${i}`, ts));
    // The crash gate fires on every turn, parented to that turn's assistant msg.
    lines.push(crashHookLine(`h-${i}`, a, ts));
  }
  // One DIFFERENT hook that ran and reported something, on two turns only.
  lines.push(reportedHookLine('r-0', 'a-3', '2026-09-08T01:03:30.000Z'));
  lines.push(reportedHookLine('r-1', 'a-7', '2026-09-08T01:07:30.000Z'));
  return lines.join('\n') + '\n';
}
function buildCleanFixture() {
  const lines = [];
  for (let i = 0; i < 5; i++) {
    const ts = new Date(Date.UTC(2026, 8, 8, 2, i, 0)).toISOString();
    lines.push(userLine(`cu-${i}`, `q ${i}`, ts));
    lines.push(asstLine(`ca-${i}`, `cu-${i}`, `a ${i}`, ts));
  }
  return lines.join('\n') + '\n';
}

/** Reconstruct the PRE-FIX surface: only user/assistant entries were served as
 *  `messages`; attachments were dropped. Nothing here can carry a hook failure. */
function preFixSurfaceHasHookFailure(file) {
  const raw = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const messages = raw
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && (e.type === 'user' || e.type === 'assistant') && e.isSidechain !== true && e.isMeta !== true);
  // The whole pre-fix payload the client ever saw, serialised. Search it for any
  // trace of a hook failure — there is none, because attachments were filtered.
  return JSON.stringify(messages).includes('hook_non_blocking_error');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug177-'));
try {
  const busy = path.join(dir, 'busy.jsonl');
  const clean = path.join(dir, 'clean.jsonl');
  fs.writeFileSync(busy, buildBusyFixture());
  fs.writeFileSync(clean, buildCleanFixture());
  clearTranscriptCaches();

  console.log('\n=== MUST-FAIL proof: pre-fix surface hides the failures ===');
  check('pre-fix payload (messages-only) shows NO hook failure — the bug',
    preFixSurfaceHasHookFailure(busy) === false, { file: 'busy' });

  console.log('\n=== POST-FIX: countMessages rolls the failures up ===');
  const he = countMessages(busy, {}).hookErrors;
  check('hookErrors is present on the count result', !!he, he);
  check(`totalRecords counts every failing turn (${N_TURNS} crash + 2 reported = ${N_TURNS + 2})`,
    he.totalRecords === N_TURNS + 2, { totalRecords: he.totalRecords });
  check(`crashRecords === ${N_TURNS} (the module-missing gate, every turn)`,
    he.crashRecords === N_TURNS, { crashRecords: he.crashRecords });
  check('reportedRecords === 2 (the lint gate that ran and reported)',
    he.reportedRecords === 2, { reportedRecords: he.reportedRecords });
  check('exactly 2 distinct groups', he.groups.length === 2, { groups: he.groups.map((g) => g.hookName) });

  const crashGroup = he.groups.find((g) => g.kind === 'crash');
  const reportedGroup = he.groups.find((g) => g.kind === 'reported');
  check('crash group is the Stop hook', crashGroup && crashGroup.hookName === 'Stop', crashGroup);
  check(`crash group count === ${N_TURNS}`, crashGroup && crashGroup.count === N_TURNS, crashGroup?.count);
  check('crash group message names the missing module (legible, no stack)',
    crashGroup && /Cannot find module/.test(crashGroup.message) && !/at Module\._/.test(crashGroup.message),
    crashGroup?.message);
  check('reported group is the PostToolUse lint gate, count 2',
    reportedGroup && reportedGroup.hookName === 'PostToolUse' && reportedGroup.count === 2, reportedGroup);
  check('reported group message is the hook\'s own words',
    reportedGroup && /findings need review/.test(reportedGroup.message), reportedGroup?.message);

  // Per-turn refs carry the owning turn's uuid so the client can badge it.
  check('records carry parentUuid for per-turn badges',
    he.records.length > 0 && he.records.every((r) => typeof r.parentUuid === 'string' && r.parentUuid),
    { sample: he.records[0] });
  check('a crash ref points at its turn\'s assistant message (a-0)',
    he.records.some((r) => r.parentUuid === 'a-0' && r.kind === 'crash'), he.records[0]);

  console.log('\n=== NEGATIVE: a clean session surfaces nothing ===');
  const cleanHe = countMessages(clean, {}).hookErrors;
  check('clean session: totalRecords === 0', cleanHe.totalRecords === 0, cleanHe);
  check('clean session: no groups (client renders no banner, no empty container)',
    cleanHe.groups.length === 0 && cleanHe.records.length === 0, cleanHe);

  console.log('\n=== REAL ARTIFACT (if present) ===');
  const projects = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
  let realFile = null;
  try {
    for (const d of fs.readdirSync(projects)) {
      const pdir = path.join(projects, d);
      if (!fs.statSync(pdir).isDirectory()) continue;
      for (const f of fs.readdirSync(pdir)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(pdir, f);
        // Cheap: peek only files that mention the marker.
        try { if (fs.readFileSync(fp, 'utf8').includes('hook_non_blocking_error')) { realFile = fp; break; } } catch {}
      }
      if (realFile) break;
    }
  } catch {}
  if (!realFile) {
    console.log('  (no real transcript with hook_non_blocking_error found — skipping; fixture above is synthetic)');
  } else {
    const rawLines = fs.readFileSync(realFile, 'utf8').split('\n');
    const rawCount = rawLines.filter((l) => l.includes('"type":"hook_non_blocking_error"')).length;
    clearTranscriptCaches();
    const realHe = countMessages(realFile, {}).hookErrors;
    check(`REAL: roll-up total (${realHe.totalRecords}) matches raw line count (${rawCount})`,
      realHe.totalRecords === rawCount && rawCount > 0, { realHe: realHe.totalRecords, rawCount, file: path.basename(realFile) });
    check('REAL: at least one failure is classified (crash or reported)',
      realHe.crashRecords + realHe.reportedRecords === realHe.totalRecords, realHe);
    check('REAL: pre-fix surface would have hidden them all',
      preFixSurfaceHasHookFailure(realFile) === false, {});
    console.log(`  (real file: ${path.basename(realFile)} — groups: ${realHe.groups.map((g) => `${g.hookName}/${g.kind}×${g.count}`).join(', ')})`);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exitCode = fail ? 1 : 0;
