#!/usr/bin/env node
/**
 * verify-feat-111-harvest.mjs — regression suite for scripts/harvest-agent.mjs.
 *
 * Deterministic and self-contained: it builds a throwaway Claude config dir of
 * synthesized subagent transcripts (realistic shapes taken from real on-disk
 * transcripts) and drives the harvester at it with --config-dir, asserting each
 * classification, the fail-loud paths, the bounded read, and the concurrent-write
 * race. It does NOT dispatch a live agent (that is the manual reality check in the
 * ticket log); it locks in the behavior that manual check proved.
 *
 * Usage:  node scripts/verify-feat-111-harvest.mjs
 * Exit:   0 all PASS, 1 any FAIL.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const HARVEST = path.join(HERE, 'harvest-agent.mjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feat111-verify-'));
const subagents = path.join(root, 'projects', 'proj', 'sess', 'subagents');
fs.mkdirSync(subagents, { recursive: true });

let pass = 0;
let fail = 0;
function check(name, cond, observed) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  (observed: ${observed})`);
  }
}

/** Write a transcript from records; optionally backdate its mtime to make it
 *  "quiescent" (a genuinely finished child, not one being written right now). */
function writeTranscript(id, records, { agedSecs } = {}) {
  const file = path.join(subagents, `agent-${id}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (agedSecs) {
    const t = (Date.now() - agedSecs * 1000) / 1000;
    fs.utimesSync(file, t, t);
  }
  return file;
}

const TS = '2026-08-27T20:00:00.000Z';
const userRec = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: TS });
const asstText = (text, stop = 'end_turn') => ({
  type: 'assistant',
  message: { role: 'assistant', stop_reason: stop, content: text ? [{ type: 'text', text }] : [{ type: 'thinking', thinking: 'x' }] },
  timestamp: TS,
});
const asstTool = () => ({
  type: 'assistant',
  message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
  timestamp: TS,
});
const toolResult = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, timestamp: TS });

function run(id, extra = []) {
  const r = spawnSync('node', [HARVEST, id, '--wait-ms', '0', '--config-dir', root, '--json', ...extra], { encoding: 'utf8' });
  let obj = null;
  try {
    obj = JSON.parse(r.stdout);
  } catch {
    /* leave null */
  }
  return { code: r.status, obj, stdout: r.stdout, stderr: r.stderr };
}

console.log('FEAT-111 harvest-agent regression suite');
console.log(`fixture config dir: ${root}\n`);

// 1. GONE — absent id must fail loud, non-zero, with a spoken reason (not empty success).
{
  const r = run('cafef00d0000');
  check('GONE: exit 3', r.code === 3, r.code);
  check('GONE: status GONE', r.obj?.status === 'GONE', r.obj?.status);
  check('GONE: loud reason present (not silent empty)', !!r.obj?.reason && /NOT an empty result/i.test(r.obj.reason), r.obj?.reason);
}

// 2. FINISHED — quiescent, ends in a text-only assistant turn.
{
  writeTranscript('aa11', [userRec('do it'), asstTool(), toolResult(), asstText('THE ANSWER 42')], { agedSecs: 600 });
  const r = run('aa11');
  check('FINISHED: exit 0', r.code === 0, r.code);
  check('FINISHED: status FINISHED', r.obj?.status === 'FINISHED', r.obj?.status);
  check('FINISHED: returns the real final text', r.obj?.result === 'THE ANSWER 42', r.obj?.result);
}

// 3. REGRESSION (the real opus-5 defect): a finished text answer with stop_reason:null
//    must still read FINISHED — terminal is "no tool_use block", not end_turn.
{
  writeTranscript('aa22', [userRec('q'), asstText('NULL STOP DONE', null)], { agedSecs: 600 });
  const r = run('aa22');
  check('NULL-STOP: FINISHED despite stop_reason:null', r.obj?.status === 'FINISHED' && r.obj?.result === 'NULL STOP DONE', `${r.obj?.status}/${r.obj?.result}`);
}

// 4. FINISHED_EMPTY — terminated but no final text: loud anomaly, NOT a silent empty success.
{
  writeTranscript('aa33', [userRec('q'), asstText('', 'end_turn')], { agedSecs: 600 });
  const r = run('aa33');
  check('EMPTY: exit 12 (loud, non-zero)', r.code === 12, r.code);
  check('EMPTY: status FINISHED_EMPTY', r.obj?.status === 'FINISHED_EMPTY', r.obj?.status);
  check('EMPTY: no bogus result field', r.obj?.result === undefined, JSON.stringify(r.obj?.result));
}

// 5. STALLED — quiescent + silent past the horizon, last record mid-tool.
{
  writeTranscript('aa44', [userRec('q'), asstTool()], { agedSecs: 600 });
  const r = run('aa44', ['--idle-secs', '60']);
  check('STALLED: exit 11', r.code === 11, r.code);
  check('STALLED: status STALLED', r.obj?.status === 'STALLED', r.obj?.status);
  check('STALLED: loud reason, not empty success', !!r.obj?.reason && /verify the process by hand/i.test(r.obj.reason), r.obj?.reason);
}

// 6. RUNNING — recently written (fresh mtime), non-terminal -> alive, wait.
{
  writeTranscript('aa55', [userRec('q'), asstTool()]); // fresh mtime (now)
  const r = run('aa55');
  check('RUNNING: exit 10', r.code === 10, r.code);
  check('RUNNING: wait-guidance present', /do not re-run/i.test(r.obj?.guidance || ''), r.obj?.guidance);
}

// 7. BOUNDED read — a large finished transcript must be classified without reading it all.
{
  const filler = [];
  for (let i = 0; i < 4000; i++) filler.push(asstTool(), toolResult()); // ~ a few MB
  writeTranscript('aa66', [userRec('q'), ...filler, asstText('BIG DONE')], { agedSecs: 600 });
  const r = run('aa66');
  check('BOUNDED: FINISHED with real result', r.obj?.status === 'FINISHED' && r.obj?.result === 'BIG DONE', `${r.obj?.status}/${r.obj?.result}`);
  check('BOUNDED: did NOT read whole transcript', r.obj?.bytes?.fullyCovered === false && r.obj?.bytes?.fractionRead < 1, JSON.stringify(r.obj?.bytes));
}

// 8. RACE — a terminal-looking tail on a FRESHLY-written file must NOT read FINISHED.
//    Models the harness still appending: same terminal record, but mtime=now.
{
  writeTranscript('aa77', [userRec('q'), asstText('LOOKS DONE')]); // fresh mtime
  const r = run('aa77');
  check('RACE: fresh terminal-looking file -> RUNNING, never FINISHED', r.obj?.status === 'RUNNING', r.obj?.status);
}

console.log(`\nFEAT-111 harvest suite: ${pass} passed, ${fail} failed`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
