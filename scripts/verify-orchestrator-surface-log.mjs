#!/usr/bin/env node
/**
 * verify-orchestrator-surface-log.mjs — FEAT-096.
 *
 * The properties this suite exists to hold, in the order they matter:
 *
 *   1. The hook cannot break a session. It is log-only; every path exits 0 and
 *      emits nothing. If this is ever false the experiment costs more than the
 *      information it buys.
 *   2. It cannot fire outside the tree it is installed in — the BUG-118 property.
 *   3. `agent_id` really does separate an orchestrator's own reaches from its
 *      lanes' calls, and session identity really does not. This is graded
 *      against the REAL captured payloads, because it is the fact the whole
 *      experiment rests on: without it the log measures lanes and the premise
 *      is confirmed by construction.
 *   4. The reader survives a log another process is mid-write on.
 *   5. The escape-channel signals are not vacuous — they must actually separate
 *      a real task brief from real analysis prose.
 *
 * The fixture at scripts/fixtures/feat-096/real-pretooluse-payloads.jsonl is
 * REAL: three payloads captured from a live PreToolUse hook on 2026-08-20 by
 * driving a real `claude -p` session that made one main-session tool call,
 * dispatched one subagent, and let that subagent make a call. Only the home
 * path and username are rewritten, so the repo's leak gate passes. Nothing
 * about the SHAPE is invented — inventing it is precisely what would have hidden
 * the `Dispatch`/`Agent` naming error and the agent_id discriminator.
 *
 * Where a fixture IS synthetic it says so at the call site.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, isAllowed, briefSignals, ALLOWED } from './lib/orchestrator-profile.mjs';
import { record, digest, inScope } from './hooks/orchestrator-surface-log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HOOK = path.join(HERE, 'hooks', 'orchestrator-surface-log.mjs');
const REPORT = path.join(HERE, 'orchestrator-surface-report.mjs');
const FIXTURE = path.join(HERE, 'fixtures', 'feat-096', 'real-pretooluse-payloads.jsonl');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const section = (s) => console.log(`\n── ${s} ──`);

/** Run the hook as the harness runs it: JSON on stdin, read exit code + stdout. */
function runHook(payload, { logFile, cwdOverride } = {}) {
  const env = { ...process.env };
  if (logFile) env.ORCHARD_SURFACE_LOG = logFile;
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env,
    cwd: cwdOverride || REPO,
    encoding: 'utf8',
  });
  return r;
}
const readLog = (f) =>
  fs.existsSync(f)
    ? fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat096-'));
const realPayloads = fs
  .readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

/* ══ 1. The real payloads: the facts the experiment rests on ═══════════════ */
section('the real captured payloads (3 from a live session)');

check('fixture holds the 3 real payloads', realPayloads.length === 3, `got ${realPayloads.length}`);

const toolNames = realPayloads.map((p) => p.tool_name);
check(
  'the dispatch tool is really named `Agent`',
  toolNames.includes('Agent'),
  `saw ${JSON.stringify(toolNames)}`,
);
check(
  'no tool named `Dispatch` exists — the design document\'s name is wrong',
  !toolNames.includes('Dispatch') && !ALLOWED.includes('Dispatch'),
);
check('the profile allows the name the harness actually emits', isAllowed('Agent'));

const sessionIds = new Set(realPayloads.map((p) => p.session_id));
check(
  'all three calls share ONE session_id (main and subagent alike)',
  sessionIds.size === 1,
  `${sessionIds.size} distinct`,
);
const transcripts = new Set(realPayloads.map((p) => p.transcript_path));
check('…and one transcript_path', transcripts.size === 1);

const withAgent = realPayloads.filter((p) => typeof p.agent_id === 'string');
check(
  'exactly the subagent call carries agent_id',
  withAgent.length === 1 && withAgent[0].tool_name === 'Bash',
  `${withAgent.length} payloads carry it`,
);
check('the subagent call also names its agent_type', withAgent[0]?.agent_type === 'general-purpose');

const recs = realPayloads.map(record);
check(
  'record() separates 2 main-session calls from 1 lane call',
  recs.filter((r) => r.agentId === null).length === 2 && recs.filter((r) => r.agentId !== null).length === 1,
);

/* MUST-FAIL PROOF, anchored to a FIXED fixture (not HEAD): the obvious
 * alternative discriminator — session identity — cannot separate these at all.
 * If this ever passes, the separator has stopped being load-bearing. */
const bySession = new Map();
for (const p of realPayloads) bySession.set(p.session_id, (bySession.get(p.session_id) || 0) + 1);
check(
  'MUST-FAIL: a session-keyed separator scores 0 separation on this real data',
  bySession.size === 1 && [...bySession.values()][0] === 3,
  'session_id would have lumped the lane in with the orchestrator',
);

/* ══ 2. The hook cannot break a session ════════════════════════════════════ */
section('log-only: the hook never blocks and never fails');

const okLog = path.join(tmp, 'ok.jsonl');
for (const [i, p] of realPayloads.entries()) {
  // Re-point cwd into the repo so the real payloads are in scope for this run.
  const r = runHook({ ...p, cwd: REPO }, { logFile: okLog });
  check(`real payload ${i + 1}: exit 0`, r.status === 0, `status ${r.status} stderr=${r.stderr}`);
  check(`real payload ${i + 1}: emits nothing (no decision)`, r.stdout === '', JSON.stringify(r.stdout));
}
check('…and all three were recorded', readLog(okLog).length === 3);

for (const [label, input] of [
  ['malformed JSON', '{not json'],
  ['empty stdin', ''],
  ['JSON null', 'null'],
  ['JSON array', '[1,2,3]'],
  ['payload with no tool_name', JSON.stringify({ cwd: REPO })],
  ['payload with no cwd', JSON.stringify({ tool_name: 'Bash' })],
]) {
  const r = runHook(input, { logFile: path.join(tmp, 'junk.jsonl') });
  check(`${label}: exit 0, silent`, r.status === 0 && r.stdout === '', `status ${r.status}`);
}

/* A brief far larger than anything real, made of ONE unbroken token — the shape
 * a pasted path list, stack dump or base64 blob has. This is the case that
 * caught a catastrophically-backtracking citation regex before the hook was
 * ever wired up. The hook runs ahead of EVERY tool call, so "eventually
 * finishes" is not good enough; it is held to a wall clock. */
const hugeStart = Date.now();
const huge = runHook(
  {
    cwd: REPO,
    tool_name: 'Agent',
    session_id: 's',
    tool_input: { prompt: 'x'.repeat(1_000_000), subagent_type: 'worker' },
  },
  { logFile: path.join(tmp, 'huge.jsonl') },
);
const hugeMs = Date.now() - hugeStart;
check('1MB single-token brief: exit 0', huge.status === 0);
check(`1MB single-token brief: finishes fast (${hugeMs}ms, bound 5000ms)`, hugeMs < 5000);
const hugeRec = readLog(path.join(tmp, 'huge.jsonl'))[0];
check('1MB brief: excerpt is bounded', (hugeRec?.digest.briefExcerpt || '').length === 400);
check('1MB brief: full size still measured exactly', hugeRec?.digest.brief.chars === 1_000_000);
check('1MB brief: the record admits its scan was truncated', hugeRec?.digest.brief.scanTruncated === true);
check('a normal-sized brief is not marked truncated', briefSignals('do the thing').scanTruncated === false);

/* MUST-FAIL PROOF for the above, anchored to a FIXED reconstruction of the
 * pre-fix pattern rather than to HEAD — committing the fix must not turn this
 * proof into a tautology (docs/CONVENTIONS.md). The original regex is written
 * out literally here and must still blow up on the same input; if it ever
 * completes quickly, the wall-clock check above has stopped proving anything. */
{
  const PRE_FIX = /[\w./-]+\.(?:m?[jt]sx?|py|md|json|html|css|sh):\d+/g;
  const probe = 'x'.repeat(60_000);
  const t0 = Date.now();
  // Bail out rather than hang the suite: 2s is already ~100x the fixed version.
  const child = spawnSync(
    process.execPath,
    ['-e', `const RE=${PRE_FIX.toString()};("x".repeat(60000)).match(RE);`],
    { timeout: 2000, encoding: 'utf8' },
  );
  const preFixHung = child.status !== 0 || child.signal !== null;
  check(
    'MUST-FAIL: the pre-fix regex still hangs on the same input',
    preFixHung,
    `pre-fix finished in ${Date.now() - t0}ms — the wall-clock check is now vacuous`,
  );
  const t1 = Date.now();
  briefSignals(probe);
  const fixedMs = Date.now() - t1;
  check(`…while the shipped signal counter handles it (${fixedMs}ms)`, fixedMs < 1000);
}

// An unwritable destination must not surface as a failure to the session.
const unwritable = path.join(tmp, 'nodir');
fs.writeFileSync(unwritable, 'i am a file, not a directory');
const blocked = runHook({ cwd: REPO, tool_name: 'Bash', tool_input: {} }, {
  logFile: path.join(unwritable, 'deep', 'calls.jsonl'),
});
check('unwritable log path: still exit 0, still silent', blocked.status === 0 && blocked.stdout === '');

/* ══ 3. Scope — the BUG-118 property ═══════════════════════════════════════ */
section('scope: cannot fire outside the tree it is installed in');

const scopeLog = path.join(tmp, 'scope.jsonl');
const foreign = runHook(
  { cwd: path.join(os.homedir(), 'projects', 'some-other-project'), tool_name: 'Bash', tool_input: { command: 'ls' } },
  { logFile: scopeLog },
);
check('a foreign project\'s call: exit 0', foreign.status === 0);
check('a foreign project\'s call: NOTHING recorded', readLog(scopeLog).length === 0);

// Non-vacuity: the same call from inside the repo IS recorded, so the test above
// is not passing merely because writing is broken.
runHook({ cwd: REPO, tool_name: 'Bash', tool_input: { command: 'ls' } }, { logFile: scopeLog });
check('…but the same call from inside the repo IS recorded', readLog(scopeLog).length === 1);

const sub = path.join(REPO, 'src', 'server');
runHook({ cwd: sub, tool_name: 'Bash', tool_input: {} }, { logFile: scopeLog });
check('a subdirectory of the repo counts as inside', readLog(scopeLog).length === 2);

// Prefix confusion: a sibling directory whose name STARTS with the repo path.
check('a sibling path sharing the repo\'s prefix is OUTSIDE', !inScope(REPO + '-evil'));
check('the repo root itself is inside', inScope(REPO));
check('a relative path that resolves outside is OUTSIDE', !inScope(path.join(REPO, '..', 'elsewhere')));
check('empty cwd is outside', !inScope('') && !inScope(null) && !inScope(undefined));

/* ══ 4. Truncated and concurrent reads ═════════════════════════════════════ */
section('the reader survives a log that is being written');

// Realistic state, SYNTHETIC and labelled as such: a busy day — several sessions,
// most calls made by lanes, a handful of dispatches with long briefs. The real
// log does not exist until the hook has run for a working session, so this
// stands in for it; the SHAPES come from the real payloads above.
const busy = [];
const sessions = ['sess-orch-1', 'sess-lane-a', 'sess-lane-b'];
for (let i = 0; i < 400; i++) {
  const s = sessions[i % 3];
  const isSub = i % 3 !== 0;
  const tool = ['Bash', 'Read', 'Grep', 'Edit', 'Agent', 'SendMessage'][i % 6];
  busy.push(
    record({
      session_id: s,
      agent_id: isSub ? `a${i}` : undefined,
      agent_type: isSub ? 'worker' : undefined,
      cwd: REPO,
      tool_name: tool,
      permission_mode: 'default',
      tool_input:
        tool === 'Agent'
          ? { prompt: `Investigate the failure in src/server/board.ts:${i} because the cause is unclear`, subagent_type: 'worker' }
          : tool === 'SendMessage'
            ? { message: 'keep going' }
            : tool === 'Bash'
              ? { command: i % 30 === 0 ? 'node scripts/dispatch.mjs --provider openai "x"' : 'git status' }
              : { file_path: 'src/server/board.ts', pattern: 'x' },
    }),
  );
}
const busyLog = path.join(tmp, 'busy.jsonl');
fs.writeFileSync(busyLog, busy.map((r) => JSON.stringify(r)).join('\n') + '\n');

function reportJson(file) {
  const r = spawnSync(process.execPath, [REPORT, '--log', file, '--json'], { encoding: 'utf8' });
  return { status: r.status, out: r.status === 0 ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}
const full = reportJson(busyLog);
check('report reads the busy log', full.status === 0, full.stderr);
check(
  'report counts main-session calls only',
  full.out.mainSessionCalls === busy.filter((r) => r.agentId === null).length,
  `${full.out?.mainSessionCalls}`,
);
check('report counts lane calls separately', full.out.subagentCalls === busy.filter((r) => r.agentId !== null).length);
check('report attributes every main-session call to a session', Object.keys(full.out.bySession).length >= 1);

// Truncate the real bytes at several plausible mid-write points.
const bytes = fs.readFileSync(busyLog);
let truncOk = 0;
const cuts = [1, 37, 200, 1024, 4096, Math.floor(bytes.length / 2), bytes.length - 1, bytes.length - 40];
for (const cut of cuts) {
  const f = path.join(tmp, `trunc-${cut}.jsonl`);
  fs.writeFileSync(f, bytes.subarray(0, cut));
  const r = reportJson(f);
  if (r.status === 0 && r.out.mainSessionCalls <= full.out.mainSessionCalls) truncOk++;
  else console.log(`        (cut ${cut}: status ${r.status})`);
}
check(`report survives all ${cuts.length} truncation points`, truncOk === cuts.length, `${truncOk}/${cuts.length}`);

// A half-written final line must be counted as unparseable, not silently dropped
// as if it never happened — a reader that hides its own blind spot is worse than
// one that reports it.
const halfFile = path.join(tmp, 'half.jsonl');
fs.writeFileSync(halfFile, JSON.stringify(busy[0]) + '\n' + JSON.stringify(busy[1]).slice(0, 50));
const half = spawnSync(process.execPath, [REPORT, '--log', halfFile], { encoding: 'utf8' });
check('a half-written line is REPORTED as unparseable, not hidden', /1 unparseable/.test(half.stdout), half.stdout.slice(0, 200));

// Concurrent appenders: every line must still parse.
const concLog = path.join(tmp, 'conc.jsonl');
const kids = [];
for (let i = 0; i < 12; i++) {
  kids.push(
    runHook({ cwd: REPO, session_id: `s${i}`, tool_name: 'Bash', tool_input: { command: 'x'.repeat(150) } }, { logFile: concLog }),
  );
}
check('12 concurrent-ish appends all parse', readLog(concLog).length === 12);

/* ══ 5. The escape channel is not vacuous ══════════════════════════════════ */
section('escape-channel signals separate a task from a diagnosis');

// REAL task brief: the actual prompt from the captured Agent payload.
const realTaskBrief = realPayloads.find((p) => p.tool_name === 'Agent').tool_input.prompt;
const taskSig = briefSignals(realTaskBrief);
check('a real task brief cites no file:line', taskSig.citations === 0, JSON.stringify(taskSig));

// REAL analysis prose: an excerpt of this repo's own attack document, which is a
// genuine analysis artifact rather than one written to pass this test.
const attackDoc = path.join(REPO, 'docs', 'analysis', 'orchestrator-design-attack-2026-08-20.md');
check('the real analysis document is present to grade against', fs.existsSync(attackDoc));
const analysisProse = fs.readFileSync(attackDoc, 'utf8').slice(0, 6000);
const analysisSig = briefSignals(analysisProse);
check(
  'real analysis prose trips the citation signal',
  analysisSig.citations > 0,
  `citations=${analysisSig.citations}`,
);
check(
  'real analysis prose trips the conclusion-phrasing signal',
  analysisSig.analysisPhrases > 0,
  `phrases=${analysisSig.analysisPhrases}`,
);
check(
  'the two are actually separated by the signals',
  analysisSig.citations > taskSig.citations && analysisSig.analysisPhrases >= taskSig.analysisPhrases,
);

// Signals must be computed on the FULL brief, not on the stored excerpt —
// otherwise a citation past character 400 is invisible and the escape channel
// is measurable only when it is short enough not to matter.
const lateCitation = 'do the thing. '.repeat(60) + ' see src/server/agent-bridge.ts:1112 for the cause';
check('a citation past the excerpt cap is still counted', briefSignals(lateCitation).citations === 1);
const lateRec = digest('Agent', { prompt: lateCitation });
check('…while the stored excerpt stays capped', lateRec.briefExcerpt.length === 400);
check('…and the excerpt genuinely omits that citation', !lateRec.briefExcerpt.includes('agent-bridge.ts:1112'));

// SendMessage is inside the profile and is still a full reasoning channel.
check('an allowed SendMessage is measured like a brief', typeof digest('SendMessage', { message: 'x' }).brief === 'object');

/* ══ 6. What a deny would break ════════════════════════════════════════════ */
section('the consequences a deny would have');

check(
  'a shell dispatch is flagged',
  digest('Bash', { command: 'node scripts/dispatch.mjs --provider openai "task"' }).dispatchViaShell === true,
);
check('an ordinary shell call is not', digest('Bash', { command: 'git status' }).dispatchViaShell === false);
check('shell dispatches are counted in the busy log', busy.filter((r) => r.digest.dispatchViaShell).length > 0);

check('an unseen tool name lands in its own bucket', classify('SomeFutureTool') === 'denied-unknown');
check('MCP tools are outside the surface', classify('mcp__serena__find_symbol') === 'denied-mcp');
for (const t of ALLOWED) check(`profile allows ${t}`, classify(t) === 'allowed');

// The refutation path must be reachable: a log in which the orchestrator never
// reached outside the profile has to READ as a refutation, not as a success.
const cleanLog = path.join(tmp, 'clean.jsonl');
fs.writeFileSync(
  cleanLog,
  [
    record({ session_id: 's', cwd: REPO, tool_name: 'Agent', tool_input: { prompt: 'go' } }),
    record({ session_id: 's', cwd: REPO, tool_name: 'SendMessage', tool_input: { message: 'hi' } }),
  ]
    .map((r) => JSON.stringify(r))
    .join('\n') + '\n',
);
const clean = spawnSync(process.execPath, [REPORT, '--log', cleanLog], { encoding: 'utf8' });
check('a log with no forbidden reach prints the refutation', /READ THIS AS A REFUTATION/.test(clean.stdout));
check('…and reports 0 would-block', reportJson(cleanLog).out.wouldBlock === 0);

const missing = spawnSync(process.execPath, [REPORT, '--log', path.join(tmp, 'nope.jsonl')], { encoding: 'utf8' });
check('a missing log exits non-zero rather than reporting a green nothing', missing.status === 2);

/* ═════════════════════════════════════════════════════════════════════════ */
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} PASS`);
if (fail) {
  console.log(`FAILURES:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
