#!/usr/bin/env node
/**
 * orchestrator-surface-report.mjs — FEAT-096. Reads the blindfold log and
 * reports what an orchestrator profile WOULD have blocked.
 *
 * This is the half that produces the finding. The hook only records; every
 * judgement about what the recording means is made here, from the profile in
 * scripts/lib/orchestrator-profile.mjs — so re-scoring a past log against a
 * changed profile is a re-run of this script, not a lost month of data.
 *
 *   node scripts/orchestrator-surface-report.mjs [--log <file>] [--session <id>]
 *                                                [--briefs <n>] [--json]
 *
 * ── What it will not tell you ────────────────────────────────────────────────
 * It cannot tell you which main session was the orchestrator. A lane launched
 * into this repo by the station, and the session a person is driving, are both
 * main sessions: same payload shape, no marker distinguishing them. So the
 * report SEGMENTS by session and shows each one's mix, and leaves the naming to
 * a reader. `--session` then scores one.
 *
 * It also cannot tell you whether a dispatch brief carried analysis. It ranks
 * briefs by heuristic signals and prints the top of that list for a person to
 * read. The attack (§7) requires the bucketing be done by someone other than
 * the design's author, and a script that returned a verdict here would be
 * exactly the machine-blessed judgement §4 warns about.
 */
import fs from 'node:fs';
import { classify, ALLOWED } from './lib/orchestrator-profile.mjs';
import { logPath } from './hooks/orchestrator-surface-log.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const file = flag('--log', logPath());
const onlySession = flag('--session', null);
const briefCount = Number(flag('--briefs', '5'));

if (!fs.existsSync(file)) {
  console.error(`no log at ${file}`);
  console.error('The hook writes on the first tool call of a session in this repo.');
  process.exit(2);
}

const rows = [];
let malformed = 0;
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    rows.push(JSON.parse(line));
  } catch {
    malformed++;
  }
}

const scoped = onlySession ? rows.filter((r) => r.sessionId === onlySession) : rows;
/** The separator established by the payload capture: subagent calls carry agentId. */
const main = scoped.filter((r) => r.agentId === null);
const sub = scoped.filter((r) => r.agentId !== null);

const tally = (list, key) => {
  const m = new Map();
  for (const r of list) m.set(key(r), (m.get(key(r)) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

const pct = (n, d) => (d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1).padStart(5)}%`);

const wouldBlock = main.filter((r) => classify(r.tool) !== 'allowed');
const allowedCalls = main.filter((r) => classify(r.tool) === 'allowed');

if (has('--json')) {
  console.log(
    JSON.stringify(
      {
        log: file,
        rows: rows.length,
        malformed,
        mainSessionCalls: main.length,
        subagentCalls: sub.length,
        wouldBlock: wouldBlock.length,
        byTool: Object.fromEntries(tally(main, (r) => r.tool)),
        byBucket: Object.fromEntries(tally(main, (r) => classify(r.tool))),
        bySession: Object.fromEntries(tally(main, (r) => r.sessionId || '(none)')),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(`\norchestrator surface — log-only (FEAT-096, experiment A-E1)`);
console.log(`log: ${file}`);
console.log(`profile allows: ${ALLOWED.join(', ')} — everything else is denied by default`);
console.log(`NOTHING WAS BLOCKED. This is a recording of what a deny would have refused.\n`);

console.log(`records: ${rows.length}${malformed ? ` (+${malformed} unparseable)` : ''}`);
console.log(`  main-session calls : ${main.length}`);
console.log(`  subagent calls     : ${sub.length}   (excluded — these are lanes, not the orchestrator)`);
if (sub.length && main.length) {
  console.log(
    `  NOTE: subagent calls are ${pct(sub.length, scoped.length)} of the log. Counting them as` +
      `\n        orchestrator reaches would confirm the premise by construction.`,
  );
}

console.log(`\n── main-session calls, by session ──`);
console.log(`(a station-launched lane and the session you drive look identical here; name yours with --session)`);
for (const [sid, n] of tally(main, (r) => r.sessionId || '(none)')) {
  const calls = main.filter((r) => r.sessionId === sid);
  const dispatches = calls.filter((r) => r.tool === 'Agent').length;
  const blocked = calls.filter((r) => classify(r.tool) !== 'allowed').length;
  console.log(
    `  ${String(sid).slice(0, 12).padEnd(14)} ${String(n).padStart(5)} calls · ` +
      `${String(dispatches).padStart(4)} dispatches · ${String(blocked).padStart(5)} would block (${pct(blocked, n)})` +
      `${dispatches > 0 ? '  <- orchestrator-shaped' : ''}`,
  );
}

console.log(`\n── THE FINDING: what the profile would have refused ──`);
console.log(`  main-session calls   : ${String(main.length).padStart(6)}`);
console.log(`  within the profile   : ${String(allowedCalls.length).padStart(6)}  ${pct(allowedCalls.length, main.length)}`);
console.log(`  WOULD HAVE BLOCKED   : ${String(wouldBlock.length).padStart(6)}  ${pct(wouldBlock.length, main.length)}`);
console.log(`\n  by tool:`);
for (const [tool, n] of tally(main, (r) => r.tool)) {
  const mark = classify(tool) === 'allowed' ? 'ok    ' : 'BLOCK ';
  console.log(`    ${mark} ${tool.padEnd(22)} ${String(n).padStart(6)}  ${pct(n, main.length)}`);
}

if (wouldBlock.length === 0 && main.length > 0) {
  console.log(
    `\n  READ THIS AS A REFUTATION: the orchestrator never reached outside the profile.` +
      `\n  The premise of the whole redesign is that it does. If this holds over real` +
      `\n  working sessions, the profile buys nothing and the line of work is dead.`,
  );
}

/* ── The escape channel ─────────────────────────────────────────────────────
 * Counting blocked tool names alone would score the profile a success in
 * precisely the world where it changed nothing: the orchestrator stops calling
 * Read and writes its diagnosis into a brief instead. */
console.log(`\n── the escape channel: reasoning written INTO an allowed tool ──`);
const briefs = main
  .filter((r) => (r.tool === 'Agent' || r.tool === 'SendMessage') && r.digest && r.digest.brief)
  .map((r) => ({ ...r, s: r.digest.brief }));

if (briefs.length === 0) {
  console.log('  no dispatch briefs or lane messages recorded yet.');
} else {
  const toks = briefs.map((b) => b.s.approxTokens).sort((a, b) => a - b);
  const median = toks[Math.floor(toks.length / 2)];
  const withCitations = briefs.filter((b) => b.s.citations > 0).length;
  const withPhrases = briefs.filter((b) => b.s.analysisPhrases > 0).length;
  console.log(`  briefs/messages      : ${briefs.length}`);
  console.log(`  median size          : ~${median} tokens (max ~${toks[toks.length - 1]})`);
  console.log(`  contain a file:line  : ${withCitations}  ${pct(withCitations, briefs.length)}  <- a citation is the residue of a read`);
  console.log(`  conclusion phrasing  : ${withPhrases}  ${pct(withPhrases, briefs.length)}`);
  console.log(`\n  HEURISTIC, not a verdict. Read the top ${briefCount} by hand — and have someone who did`);
  console.log(`  not write the profile do the reading:`);
  const ranked = [...briefs].sort(
    (a, b) => b.s.citations * 3 + b.s.analysisPhrases - (a.s.citations * 3 + a.s.analysisPhrases),
  );
  for (const b of ranked.slice(0, briefCount)) {
    console.log(
      `\n    [${b.tool}] ~${b.s.approxTokens} tok · ${b.s.citations} citations · ${b.s.analysisPhrases} phrases` +
        `${b.digest.subagentType ? ` · ${b.digest.subagentType}` : ''}`,
    );
    console.log(`    ${String(b.digest.briefExcerpt || '').replace(/\s+/g, ' ').slice(0, 220)}…`);
  }
}

/* ── What the deny would break ──────────────────────────────────────────── */
const shellDispatch = main.filter((r) => r.tool === 'Bash' && r.digest && r.digest.dispatchViaShell);
console.log(`\n── what a deny would visibly break ──`);
console.log(`  cross-provider dispatch through the shell (scripts/dispatch.mjs): ${shellDispatch.length} calls`);
if (shellDispatch.length > 0) {
  console.log(`  Denying Bash removes this path. It is the project's only route to a non-Claude`);
  console.log(`  provider (FEAT-043), so the profile must either keep it or replace it first.`);
}
const unknown = tally(
  main.filter((r) => classify(r.tool) === 'denied-unknown'),
  (r) => r.tool,
);
if (unknown.length) {
  console.log(`\n  tools seen that the profile never contemplated (each one is a finding):`);
  for (const [tool, n] of unknown) console.log(`    ${tool.padEnd(24)} ${n}`);
}
console.log('');
