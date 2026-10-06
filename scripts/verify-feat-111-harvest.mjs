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

// ---------------------------------------------------------------------------
// Round-2 regressions (clean-room run e26292db found these on the round-1 code).
// These drive the REAL on-disk layout: Claude Code persists ONE record per
// content block, so a turn "narrate then call a tool" is a text record followed
// by a separate tool_use record (same message.id); and a genuinely finished
// answer may carry stop_reason null (measured: 258/3547 real child transcripts).
// ---------------------------------------------------------------------------

let mid = 0;
const mtext = (t, stop = null) => ({
  type: 'assistant',
  message: { id: 'msg_' + ++mid, role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: t }] },
  timestamp: TS,
});
const mtool = (i) => ({
  type: 'assistant',
  message: { id: 'msg_' + mid, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'u' + i, name: 'Bash', input: { command: 'echo ' + 'x'.repeat(200) } }] },
  timestamp: TS,
});
const mres = (i) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u' + i, content: 'ok '.repeat(80) }] }, timestamp: TS });

// A real-shaped turn: think, narrate (text block), tool, result, narrate, tool,
// result, think, FINAL text. Every narration and the final answer carry
// stop_reason null — so stop_reason alone cannot pick the final one out.
const realRecs = [
  userRec('task'),
  { type: 'assistant', message: { id: 'msg_0', role: 'assistant', stop_reason: null, content: [{ type: 'thinking', thinking: 'plan' }] }, timestamp: TS },
  mtext('Let me look at the files first.'), mtool(1), mres(1),
  mtext('Now I will run the tests.'), mtool(2), mres(2),
  mtext('FINAL VERDICT: done'),
];
const realLines = realRecs.map((r) => JSON.stringify(r));
const realFull = realLines.join('\n') + '\n';

function writeRaw(id, body, agedSecs) {
  const file = path.join(subagents, `agent-${id}.jsonl`);
  fs.writeFileSync(file, body);
  if (agedSecs) { const t = (Date.now() - agedSecs * 1000) / 1000; fs.utimesSync(file, t, t); }
  return file;
}

// 9. DEFECT 1 — a transcript whose last line has no terminating newline is
//    MID-WRITE; the record before the fragment must NOT be read as the final
//    answer, even when quiescent. (Round-1 returned FINISHED with a narration.)
{
  const cut = realLines.slice(0, 6).join('\n') + '\n' + realLines[6].slice(0, 40); // half-written tool_use
  writeRaw('b101', cut, 600);
  const r = run('b101', ['--idle-secs', '120']);
  check('DEFECT1: mid-write (no trailing newline), aged -> not FINISHED', r.obj?.status !== 'FINISHED', `${r.obj?.status} result=${JSON.stringify(r.obj?.result)}`);
  check('DEFECT1: mid-write aged -> loud STALLED', r.obj?.status === 'STALLED' && /mid-record/.test(r.obj?.reason || ''), r.obj?.status);
}

// 10. DEFECT 1 generalised — cut the real-shaped transcript at MANY byte offsets
//     while quiescent: never a FINISHED with a non-final result.
{
  let wrong = 0, total = 0;
  const seen = new Set();
  for (let off = 10; off < realFull.length - 1; off += 53) {
    writeRaw('b102', realFull.slice(0, off), 600);
    const r = run('b102', ['--idle-secs', '120']);
    total++;
    if (r.obj?.status === 'FINISHED' && r.obj.result !== 'FINAL VERDICT: done') { wrong++; seen.add(r.obj.result); }
  }
  check('DEFECT1: aged cuts at many offsets never FINISHED with a non-final result', wrong === 0, `wrong=${wrong}/${total} ${JSON.stringify([...seen])}`);
}

// 11. RACE generalised — the same cuts with a FRESH mtime never FINISHED.
{
  let fresh = 0, total = 0;
  for (let off = 10; off < realFull.length; off += 53) {
    writeRaw('b103', realFull.slice(0, off), 0);
    const r = run('b103');
    total++;
    if (r.obj?.status === 'FINISHED') fresh++;
  }
  check('RACE: fresh cuts at many offsets never FINISHED', fresh === 0, `falseFinished=${fresh}/${total}`);
}

// 12. DEFECT 2 — a split-block mid-turn: a narration text record (clean newline,
//     the tool_use sibling not yet written), quiescent 10s but within the stall
//     horizon. The next block could still land -> RUNNING, never FINISHED with
//     the narration. (Round-1 read FINISHED past the 3s settle.)
{
  writeRaw('b104', realLines.slice(0, 6).join('\n') + '\n', 10); // ends on a narration text record
  const r = run('b104', ['--idle-secs', '240']);
  check('DEFECT2: split-block narration within horizon -> RUNNING, not FINISHED', r.obj?.status === 'RUNNING', `${r.obj?.status} result=${JSON.stringify(r.obj?.result)}`);
}

// 12b. The genuine opus-style final (null stop) IS trusted once past the stall
//      horizon — the discriminator is the horizon, not stop_reason.
{
  writeRaw('b105', realLines.slice(0, 6).join('\n') + '\n', 600); // same bytes, but long-quiescent
  const r = run('b105', ['--idle-secs', '120']);
  check('DEFECT2: a null-stop terminal past the horizon -> FINISHED', r.obj?.status === 'FINISHED', r.obj?.status);
}

// 13. DEFECT 3 — the final record is larger than --tail-bytes. The window starts
//     inside it; round-1 dropped it as partial and reported STALLED. The read
//     must extend to the record boundary and return the real final answer.
{
  const bigFinal = 'Z'.repeat(5000);
  writeRaw('b106', [userRec('q'), mtext('interim'), mtext(bigFinal, 'end_turn')].map((r) => JSON.stringify(r)).join('\n') + '\n', 600);
  const r = run('b106', ['--tail-bytes', '2000']);
  check('DEFECT3: final record > tail window -> FINISHED (not STALLED)', r.obj?.status === 'FINISHED', `${r.obj?.status}`);
  check('DEFECT3: returns the FULL final record, not a fragment or the interim', r.obj?.result === bigFinal, `len=${(r.obj?.result || '').length}`);
}

// 13b. Same, with a null-stop final past the horizon.
{
  const bigFinal = 'Q'.repeat(6000);
  writeRaw('b107', [userRec('q'), mtext('interim'), mtext(bigFinal, null)].map((r) => JSON.stringify(r)).join('\n') + '\n', 600);
  const r = run('b107', ['--tail-bytes', '1500', '--idle-secs', '120']);
  check('DEFECT3: huge null-stop final > tail window -> FINISHED with full text', r.obj?.status === 'FINISHED' && r.obj?.result === bigFinal, `${r.obj?.status} len=${(r.obj?.result || '').length}`);
}

// 14. CONCURRENT APPENDER — a real writer appending during the sampling window.
//     Growth across the two size samples must read RUNNING, never FINISHED, even
//     though the tail momentarily ends on a complete record.
{
  const file = writeRaw('b108', realLines.slice(0, 6).join('\n') + '\n', 0);
  // Append more lines ~120ms into a 400ms sampling window.
  const appender = spawnSync('node', ['-e', `
    const fs = require('node:fs');
    setTimeout(() => {
      fs.appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(JSON.stringify(realRecs[6]) + '\n')});
    }, 120);
    setTimeout(() => process.exit(0), 300);
  `], { encoding: 'utf8', timeout: 5000 });
  // run with a real wait window so the two size samples straddle the append.
  const r = (() => {
    const rr = spawnSync('node', [HARVEST, 'b108', '--wait-ms', '400', '--config-dir', root, '--json'], { encoding: 'utf8' });
    let o = null; try { o = JSON.parse(rr.stdout); } catch {}
    return { code: rr.status, obj: o };
  })();
  check('CONCURRENT: a file growing during the sample window -> RUNNING', r.obj?.status === 'RUNNING', `${r.obj?.status} growing=${r.obj?.growing}`);
}

// 15. The fresh-file race guard still holds for a DEFINITIVE terminal: an
//     end_turn answer written just now reads RUNNING (the harness may still be
//     flushing), not FINISHED.
{
  writeRaw('b109', [userRec('q'), mtext('DONE NOW', 'end_turn')].map((r) => JSON.stringify(r)).join('\n') + '\n', 0);
  const r = run('b109');
  check('RACE: fresh end_turn terminal -> RUNNING, never FINISHED', r.obj?.status === 'RUNNING', r.obj?.status);
}

console.log(`\nFEAT-111 harvest suite: ${pass} passed, ${fail} failed`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
