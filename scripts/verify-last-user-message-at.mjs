/**
 * server derivation of `lastUserMessageAt` — the sidebar's ordering key.
 *
 * Drives the REAL readSessionMeta over a REALISTIC transcript: a real human
 * prompt, an assistant turn, a tool_result-only user turn (NOT a submit), a
 * system-reminder-wrapped user entry (NOT a submit), a second real human
 * prompt, then a long tail of assistant/agent output written AFTER it. The
 * derived `lastUserMessageAt` must be the SECOND human prompt — never the later
 * agent output (that is `lastActivityAt`/mtime, the thing we deliberately do
 * NOT order by).
 *
 * The transcript is written concurrently by the CLI, so this also grades
 * TRUNCATED reads: the file cut at several byte offsets must never crash and
 * must never invent a user-submit time later than the last COMPLETE human
 * prompt line it actually saw.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readSessionMeta, clearSessionCache } from '../src/lib/session-history.ts';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : (fail++, failures.push(name));
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-luma-'));
const ENC = 'enc-test';
const T = (n) => `2026-08-27T10:${String(n).padStart(2, '0')}:00.000Z`;

// A realistic transcript. Order matters; timestamps ascend.
const lines = [
  { type: 'user', timestamp: T(1), sessionId: 's1', cwd: '/tmp/x', message: { role: 'user', content: 'first real human prompt — please refactor the parser' } },
  { type: 'assistant', timestamp: T(2), message: { role: 'assistant', model: 'claude-opus-4', content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] } },
  // tool_result-only user turn — NOT a human submit
  { type: 'user', timestamp: T(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file bytes...' }] } },
  { type: 'assistant', timestamp: T(4), message: { role: 'assistant', model: 'claude-opus-4', content: [{ type: 'text', text: 'Found it.' }] } },
  // system-reminder wrapper injected as a user entry — NOT a human submit
  { type: 'user', timestamp: T(5), message: { role: 'user', content: '<system-reminder>\nbe concise\n</system-reminder>' } },
  // THE last real human submit
  { type: 'user', timestamp: T(6), message: { role: 'user', content: 'second real human prompt — now add a test' } },
  // long agent tail written AFTER the last human submit (bumps mtime, NOT submit)
  { type: 'assistant', timestamp: T(7), message: { role: 'assistant', model: 'claude-opus-4', content: [{ type: 'text', text: 'Writing the test now.' }, { type: 'tool_use', id: 'tu2', name: 'Write', input: {} }] } },
  { type: 'user', timestamp: T(8), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }] } },
  { type: 'assistant', timestamp: T(9), message: { role: 'assistant', model: 'claude-opus-4', content: [{ type: 'text', text: 'Done.' }] } },
];
const full = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
const FILE = path.join(DIR, 's1.jsonl');
fs.writeFileSync(FILE, full);

clearSessionCache();
const meta = readSessionMeta(FILE, ENC, { scan: 'full', useCache: false });
check('lastUserMessageAt is the LAST real human prompt (T6), not the later agent tail (T9)',
  meta?.lastUserMessageAt === T(6), { lastUserMessageAt: meta?.lastUserMessageAt, lastActivityAt: meta?.lastActivityAt });
check('lastActivityAt DOES ride the agent tail (T9) — proving the two signals differ',
  meta?.lastActivityAt === T(9), meta?.lastActivityAt);
check('a tool_result-only / system-reminder user turn is NOT counted as a submit',
  meta?.lastUserMessageAt !== T(3) && meta?.lastUserMessageAt !== T(5) && meta?.lastUserMessageAt !== T(8),
  meta?.lastUserMessageAt);

// ── TRUNCATED reads: cut the file at several offsets (concurrent CLI writer) ──
// At each cut, the derived submit-time must never EXCEED the last complete
// human-prompt line present in that prefix, and must never crash.
const offsets = [];
for (let frac = 0.2; frac < 1; frac += 0.1) offsets.push(Math.floor(full.length * frac));
let anyCrash = false;
let anyInvented = false;
const t6Idx = full.indexOf('second real human prompt');
for (const off of offsets) {
  const trunc = full.slice(0, off);
  const tf = path.join(DIR, `t-${off}.jsonl`);
  fs.writeFileSync(tf, trunc);
  clearSessionCache();
  let m;
  try { m = readSessionMeta(tf, ENC, { scan: 'full', useCache: false }); }
  catch { anyCrash = true; continue; }
  // The last complete human prompt visible in this prefix: T6 only if its line
  // is fully present (its full JSON line ends before the cut), else T1.
  const hasFullT6 = off > full.indexOf('\n', t6Idx);
  const expectMax = hasFullT6 ? T(6) : T(1);
  if (m?.lastUserMessageAt && m.lastUserMessageAt > expectMax) anyInvented = true;
}
check('truncated reads never crash (partial concurrent-writer file)', !anyCrash, `cuts=${offsets.length}`);
check('truncated reads never invent a submit-time past the last COMPLETE human prompt seen', !anyInvented,
  `checked ${offsets.length} truncations`);

// ── sample mode: the last human submit sits in the TAIL of a BIG file ──
// The realistic case: a long session (>512KB) where the last human prompt is
// near the end, followed by a modest agent tail. head+tail = 512KB, so we pad
// past that with agent output, THEN the last human submit, THEN a short tail —
// the tail sampler must recover it.
const bigPad = (n, ts) => Array.from({ length: n }, (_, i) =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', model: 'claude-opus-4', content: [{ type: 'text', text: `chunk ${i} ${'x'.repeat(120)}` }] } })).join('\n');
const bigLines = [
  JSON.stringify(lines[0]),                 // T1 human (in the head)
  bigPad(6000, T(5)),                        // ~1MB of agent output — pushes past head+tail
  JSON.stringify(lines[5]),                  // T6 human — the last real submit, in the tail
  bigPad(50, T(7)),                          // short agent tail after it (mtime rides this)
];
const bigFile = path.join(DIR, 'big.jsonl');
fs.writeFileSync(bigFile, bigLines.join('\n') + '\n');
const bigSize = fs.statSync(bigFile).size;
clearSessionCache();
const bigMeta = readSessionMeta(bigFile, ENC, { scan: 'sample', useCache: false });
check('sample mode: statsExact false on a >512KB file (head+tail only)',
  bigMeta?.statsExact === false, { statsExact: bigMeta?.statsExact, bytes: bigSize });
check('sample mode recovers a last human submit that sits in the TAIL of a big file',
  bigMeta?.lastUserMessageAt === T(6), bigMeta?.lastUserMessageAt);

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) console.log(`FAILURES: ${failures.join(' | ')}`);
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
process.exit(fail ? 1 : 0);
